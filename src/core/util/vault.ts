// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A sealed book: every file of it encrypted where it lies.
 *
 * A book is a folder of plain files, which is what lets anything read it — an
 * editor, a backup, a sync service, whoever sits down at the computer. A
 * sealed book keeps the same folders, but each file in them is encrypted
 * (AES-256-GCM) under a key of the book's own, and so is the file's name: what
 * is on disk says how many files there are and how large, and nothing else.
 *
 *   manuscript/ch001.md        →  manuscript/<encrypted name>.nvs
 *   bible/characters/白页.md    →  bible/characters/<encrypted name>.nvs
 *   assets/audio/ch001/l3.wav  →  assets/audio/ch001/<encrypted name>.nvs
 *
 * The book's key is random and never stored as it is. It is kept wrapped, once
 * per way of opening the book, in the one file that stays readable —
 * `novel.json`, which for a sealed book holds only an id, the name the shelf
 * shows, and those wrapped copies:
 *
 *   password   the key that unwraps it is derived from a password (scrypt)
 *   device     the key that unwraps it sits in this computer's credential
 *              store, handed out after the owner proves presence (Touch ID,
 *              Windows Hello, the computer's own password)
 *   grant      the key that unwraps it is a token another device was given
 *              after it showed the password once
 *
 * Beside them the stub carries a drop: a public key anything may be encrypted
 * to while the book is locked — the conversations about the book, which are
 * not the Studio's files and are put under the seal from outside — and its
 * private half, wrapped with the book's key like everything else.
 *
 * Everything the Studio reads or writes of a book goes through a `FileStore`,
 * so the rest of the code neither knows nor cares whether a book is sealed.
 */
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scrypt } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import * as plain from './fs'

/** Extension of every sealed file. */
export const SEALED_SUFFIX = '.nvs'
/** The one file of a sealed book that stays readable. */
export const STUB_FILE = 'novel.json'

const MAGIC = Buffer.from('NVS1')
const IV = 12
const TAG = 16

export class VaultError extends Error {
  constructor(readonly code: 'wrong-key' | 'damaged' | 'not-sealed' | 'weak', message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

// ───────────────────────────── the stub ─────────────────────────────

export interface SealSlot {
  kind: 'password' | 'device' | 'grant'
  /** Which device or grant this is; absent for the password. */
  id?: string
  /** What the author sees it as: a computer's name, "phone, 7 Oct". */
  label?: string
  /** scrypt salt and cost of a password slot. */
  salt?: string
  n?: number
  /** The book's key, wrapped: iv | tag | ciphertext, base64. */
  wrapped: string
  at?: string
}

export interface SealedStub {
  schema: 1
  id: string
  /** The name the shelf shows while the book is locked. */
  title: string
  sealed: {
    v: 1
    slots: SealSlot[]
    /**
     * Set while files are being sealed or unsealed. If the work was cut off —
     * a crash, a power cut — some files are plain and some sealed; the next
     * time the book is unlocked everything is brought back under the seal.
     */
    pending?: boolean
    /** A way to put something under the seal while the book is locked; absent in books sealed before there was one, until they are next unlocked. */
    drop?: DropKeys
  }
}

/**
 * A book's drop: what is encrypted to `publicKey` only an unlocked book reads,
 * because the private half is kept wrapped with the book's key.
 */
export interface DropKeys {
  /** X25519 public key, SPKI DER, base64. */
  publicKey: string
  /** The private key (PKCS#8 DER), wrapped with the book's key: iv | tag | ciphertext, base64. */
  wrapped: string
}

/** The stub of a sealed book, or undefined when the book at `root` is not sealed (or is not a book). */
export async function readStub(root: string): Promise<SealedStub | undefined> {
  const raw = await plain.readJson<Partial<SealedStub>>(join(root, STUB_FILE)).catch(() => undefined)
  if (raw === undefined || raw.sealed === undefined || raw.sealed === null || typeof raw.id !== 'string') return undefined
  const drop = raw.sealed.drop
  return {
    schema: 1,
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    sealed: {
      v: 1,
      slots: Array.isArray(raw.sealed.slots) ? raw.sealed.slots : [],
      ...(raw.sealed.pending === true ? { pending: true } : {}),
      ...(drop !== undefined && drop !== null && typeof drop.publicKey === 'string' && typeof drop.wrapped === 'string' ? { drop: { publicKey: drop.publicKey, wrapped: drop.wrapped } } : {}),
    },
  }
}

export async function writeStub(root: string, stub: SealedStub): Promise<void> {
  await plain.writeJson(join(root, STUB_FILE), stub)
}

// ───────────────────────────── keys ─────────────────────────────

export function newKey(): Buffer {
  return randomBytes(32)
}

function wrap(kek: Buffer, key: Buffer): string {
  const iv = randomBytes(IV)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const body = Buffer.concat([cipher.update(key), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

function unwrap(kek: Buffer, wrapped: string): Buffer | undefined {
  try {
    const data = Buffer.from(wrapped, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', kek, data.subarray(0, IV))
    decipher.setAuthTag(data.subarray(IV, IV + TAG))
    const key = Buffer.concat([decipher.update(data.subarray(IV + TAG)), decipher.final()])
    return key.length === 32 ? key : undefined
  } catch {
    return undefined
  }
}

// ───────────────────────────── the drop ─────────────────────────────

const DROP_MAGIC = Buffer.from('NVD1')
const DROP_INFO = Buffer.from('novel-studio drop v1')

/** Make a drop for a book: a key pair whose private half only the book's key gives up. */
export function newDrop(bookKey: Buffer): DropKeys {
  const pair = generateKeyPairSync('x25519')
  const secret = pair.privateKey.export({ type: 'pkcs8', format: 'der' })
  const iv = randomBytes(IV)
  const cipher = createCipheriv('aes-256-gcm', bookKey, iv)
  const body = Buffer.concat([cipher.update(secret), cipher.final()])
  secret.fill(0)
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    wrapped: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'),
  }
}

function dropKey(shared: Buffer, sender: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([sender, recipient]), DROP_INFO, 32))
}

/**
 * Put data under a book's seal without its key: encrypted to the book's drop
 * with a key pair made for this one piece and thrown away.
 * @returns magic | length of the sender's public key | that key | iv | tag | ciphertext.
 */
export function dropSeal(publicKey: string, data: Uint8Array): Buffer {
  const recipientDer = Buffer.from(publicKey, 'base64')
  const recipient = createPublicKey({ key: recipientDer, type: 'spki', format: 'der' })
  const sender = generateKeyPairSync('x25519')
  const senderDer = sender.publicKey.export({ type: 'spki', format: 'der' })
  const key = dropKey(diffieHellman({ privateKey: sender.privateKey, publicKey: recipient }), senderDer, recipientDer)
  const iv = randomBytes(IV)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(data), cipher.final()])
  key.fill(0)
  const size = Buffer.alloc(2)
  size.writeUInt16BE(senderDer.length)
  return Buffer.concat([DROP_MAGIC, size, senderDer, iv, cipher.getAuthTag(), body])
}

/**
 * Read what was put under a book's seal through its drop.
 * @throws VaultError `wrong-key` when the book's key does not open the drop, `damaged` when the piece is not what was sealed.
 */
export function dropOpen(drop: DropKeys, bookKey: Buffer, blob: Uint8Array): Buffer {
  const data = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (data.length < DROP_MAGIC.length + 2 + IV + TAG || !data.subarray(0, DROP_MAGIC.length).equals(DROP_MAGIC)) throw new VaultError('damaged', 'this is not something sealed through a book\'s drop')
  let secret: Buffer
  try {
    const wrapped = Buffer.from(drop.wrapped, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', bookKey, wrapped.subarray(0, IV))
    decipher.setAuthTag(wrapped.subarray(IV, IV + TAG))
    secret = Buffer.concat([decipher.update(wrapped.subarray(IV + TAG)), decipher.final()])
  } catch {
    throw new VaultError('wrong-key', 'the book\'s key does not open its drop')
  }
  try {
    const size = data.readUInt16BE(DROP_MAGIC.length)
    let at = DROP_MAGIC.length + 2
    const senderDer = data.subarray(at, at += size)
    const iv = data.subarray(at, at += IV)
    const tag = data.subarray(at, at += TAG)
    const recipientDer = Buffer.from(drop.publicKey, 'base64')
    const shared = diffieHellman({ privateKey: createPrivateKey({ key: secret, type: 'pkcs8', format: 'der' }), publicKey: createPublicKey({ key: senderDer, type: 'spki', format: 'der' }) })
    const key = dropKey(shared, senderDer, recipientDer)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const body = Buffer.concat([decipher.update(data.subarray(at)), decipher.final()])
    key.fill(0)
    return body
  } catch {
    throw new VaultError('damaged', 'what was sealed through the drop does not open — it was changed, or sealed for another book')
  } finally {
    secret.fill(0)
  }
}

const SCRYPT_N = 1 << 15

function stretch(password: string, salt: Buffer, n = SCRYPT_N): Promise<Buffer> {
  return new Promise((done, fail) => {
    // The same password typed on another keyboard is the same password.
    scrypt(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, 32, { N: n, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error !== null) fail(error)
      else done(key)
    })
  })
}

/** @throws VaultError `weak` for a password too short to be one. */
export function checkPassword(password: string): void {
  if (password.normalize('NFKC').length < 4) throw new VaultError('weak', 'a password needs at least four characters')
}

export async function passwordSlot(password: string, key: Buffer): Promise<SealSlot> {
  checkPassword(password)
  const salt = randomBytes(16)
  return { kind: 'password', salt: salt.toString('base64'), n: SCRYPT_N, wrapped: wrap(await stretch(password, salt), key), at: new Date().toISOString() }
}

/** A slot opened by a 32-byte secret held elsewhere: a credential store, another device. */
export function secretSlot(kind: 'device' | 'grant', id: string, secret: Buffer, key: Buffer, label?: string): SealSlot {
  return { kind, id, wrapped: wrap(secret, key), at: new Date().toISOString(), ...(label !== undefined ? { label } : {}) }
}

/** @throws VaultError `wrong-key` when the password opens none of the book's password slots. */
export async function openWithPassword(stub: SealedStub, password: string): Promise<Buffer> {
  for (const slot of stub.sealed.slots) {
    if (slot.kind !== 'password' || slot.salt === undefined) continue
    const key = unwrap(await stretch(password, Buffer.from(slot.salt, 'base64'), slot.n ?? SCRYPT_N), slot.wrapped)
    if (key !== undefined) return key
  }
  throw new VaultError('wrong-key', 'that is not the password of this book')
}

/** @throws VaultError `wrong-key` when the secret opens no such slot. */
export function openWithSecret(stub: SealedStub, kind: 'device' | 'grant', id: string, secret: Buffer): Buffer {
  for (const slot of stub.sealed.slots) {
    if (slot.kind !== kind || slot.id !== id) continue
    const key = unwrap(secret, slot.wrapped)
    if (key !== undefined) return key
  }
  throw new VaultError('wrong-key', 'this book does not open that way (any more)')
}

// ───────────────────────────── names ─────────────────────────────

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Base32 without padding, lower case: safe on file systems that fold case. */
function encode32(data: Buffer): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function decode32(text: string): Buffer | undefined {
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of text) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) return undefined
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// ───────────────────────────── stores ─────────────────────────────

/** Everything the Studio does to a book's files. Paths are absolute, as the book lays them out. */
export interface FileStore {
  readonly sealed: boolean
  readBytes(path: string): Promise<Buffer | undefined>
  readText(path: string): Promise<string | undefined>
  readJson<T>(path: string): Promise<T | undefined>
  /** Write through a temporary file, so a reader never sees half of one. */
  writeAtomic(path: string, data: string | Uint8Array): Promise<void>
  writeJson(path: string, value: unknown): Promise<void>
  /** Names of the files and folders in a directory, sorted; empty when it is absent. */
  listDir(dir: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  /** Modification time in milliseconds, or 0 when the path is absent. */
  mtimeOf(path: string): Promise<number>
  /** Size of the file's content in bytes, or undefined when it is absent. */
  sizeOf(path: string): Promise<number | undefined>
  removePath(path: string): Promise<void>
  /** Where the file really is on disk. */
  physical(path: string): string
  /** The path a file on disk stands for, given relative to the book; undefined when it cannot be told. */
  logical(physicalRelative: string): string | undefined
}

export class PlainFiles implements FileStore {
  readonly sealed = false

  async readBytes(path: string): Promise<Buffer | undefined> {
    try {
      return await readFile(path)
    } catch (error) {
      if (plain.isMissing(error)) return undefined
      throw error
    }
  }

  readText(path: string): Promise<string | undefined> { return plain.readText(path) }
  readJson<T>(path: string): Promise<T | undefined> { return plain.readJson<T>(path) }
  writeAtomic(path: string, data: string | Uint8Array): Promise<void> { return plain.writeAtomic(path, data) }
  writeJson(path: string, value: unknown): Promise<void> { return plain.writeJson(path, value) }
  listDir(dir: string): Promise<string[]> { return plain.listDir(dir) }
  exists(path: string): Promise<boolean> { return plain.exists(path) }
  mtimeOf(path: string): Promise<number> { return plain.mtimeOf(path) }

  async sizeOf(path: string): Promise<number | undefined> {
    try {
      const info = await stat(path)
      return info.isFile() ? info.size : undefined
    } catch {
      return undefined
    }
  }

  removePath(path: string): Promise<void> { return plain.removePath(path) }
  physical(path: string): string { return path }
  logical(physicalRelative: string): string { return physicalRelative.split(sep).join('/') }
}

export class SealedFiles implements FileStore {
  readonly sealed = true
  private readonly contentKey: Buffer
  private readonly nameKey: Buffer
  private readonly ivKey: Buffer
  /** Encrypted names are deterministic, so they can be remembered. */
  private readonly names = new Map<string, string>()

  constructor(private readonly root: string, key: Buffer) {
    if (key.length !== 32) throw new VaultError('wrong-key', 'a book key is 32 bytes')
    const derive = (purpose: string): Buffer => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `novel-studio ${purpose}`, 32))
    this.contentKey = derive('content')
    this.nameKey = derive('names')
    this.ivKey = derive('name-iv')
  }

  /** A path relative to the book, with forward slashes: what a file is known by, wherever the book is moved. */
  private relative(path: string): string {
    return relative(this.root, path).split(sep).join('/')
  }

  private sealName(dir: string, name: string): string {
    const known = this.names.get(`${dir}\0${name}`)
    if (known !== undefined) return known
    // The same name in the same folder always seals to the same file name, so a file can be found without a listing.
    const iv = createHmac('sha256', this.ivKey).update(`${dir}\0${name}`).digest().subarray(0, IV)
    const cipher = createCipheriv('aes-256-gcm', this.nameKey, iv)
    cipher.setAAD(Buffer.from(dir, 'utf8'))
    const body = Buffer.concat([cipher.update(name, 'utf8'), cipher.final()])
    const sealed = `${encode32(Buffer.concat([iv, cipher.getAuthTag(), body]))}${SEALED_SUFFIX}`
    if (this.names.size > 20_000) this.names.clear()
    this.names.set(`${dir}\0${name}`, sealed)
    return sealed
  }

  private openName(dir: string, sealed: string): string | undefined {
    if (!sealed.endsWith(SEALED_SUFFIX)) return undefined
    const data = decode32(sealed.slice(0, -SEALED_SUFFIX.length))
    if (data === undefined || data.length <= IV + TAG) return undefined
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.nameKey, data.subarray(0, IV))
      decipher.setAAD(Buffer.from(dir, 'utf8'))
      decipher.setAuthTag(data.subarray(IV, IV + TAG))
      return Buffer.concat([decipher.update(data.subarray(IV + TAG)), decipher.final()]).toString('utf8')
    } catch {
      // Not a name of this book: a stray file, or another book's.
      return undefined
    }
  }

  physical(path: string): string {
    const dir = dirname(path)
    return join(dir, this.sealName(this.relative(dir), basename(path)))
  }

  logical(physicalRelative: string): string | undefined {
    const parts = physicalRelative.split(sep).join('/').split('/')
    const last = parts.pop()
    if (last === undefined) return undefined
    const dir = parts.join('/')
    if (!last.endsWith(SEALED_SUFFIX)) return [...parts, last].join('/')
    const name = this.openName(dir, last)
    return name !== undefined ? [...parts, name].join('/') : undefined
  }

  /** Encrypt the content of the file known as `path`. */
  seal(path: string, data: Uint8Array): Buffer {
    const iv = randomBytes(IV)
    const cipher = createCipheriv('aes-256-gcm', this.contentKey, iv)
    // Bound to its place in the book: a file put where another belongs does not open.
    cipher.setAAD(Buffer.from(this.relative(path), 'utf8'))
    const body = Buffer.concat([cipher.update(data), cipher.final()])
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
  }

  /** @throws VaultError `damaged` when the file is not what this book's key sealed there. */
  open(path: string, data: Buffer): Buffer {
    if (data.length < MAGIC.length + IV + TAG || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new VaultError('damaged', `${this.relative(path)} is not a sealed file of this book`)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.contentKey, data.subarray(MAGIC.length, MAGIC.length + IV))
      decipher.setAAD(Buffer.from(this.relative(path), 'utf8'))
      decipher.setAuthTag(data.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG))
      return Buffer.concat([decipher.update(data.subarray(MAGIC.length + IV + TAG)), decipher.final()])
    } catch {
      throw new VaultError('damaged', `${this.relative(path)} could not be opened: it was changed, moved, or sealed with another key`)
    }
  }

  async readBytes(path: string): Promise<Buffer | undefined> {
    let data: Buffer
    try {
      data = await readFile(this.physical(path))
    } catch (error) {
      if (plain.isMissing(error)) return undefined
      throw error
    }
    return this.open(path, data)
  }

  async readText(path: string): Promise<string | undefined> {
    return (await this.readBytes(path))?.toString('utf8')
  }

  async readJson<T>(path: string): Promise<T | undefined> {
    const text = await this.readText(path)
    if (text === undefined || text.trim().length === 0) return undefined
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new Error(`${this.relative(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
    await plain.writeAtomic(this.physical(path), this.seal(path, typeof data === 'string' ? Buffer.from(data, 'utf8') : data))
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
  }

  async listDir(dir: string): Promise<string[]> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (plain.isMissing(error)) return []
      throw error
    }
    const where = this.relative(dir)
    const names: string[] = []
    for (const entry of entries) {
      // Folders keep their names (they are the book's layout); files are known only by what their names open to.
      if (entry.isDirectory()) names.push(entry.name)
      else {
        const name = this.openName(where, entry.name)
        if (name !== undefined) names.push(name)
      }
    }
    return names.sort()
  }

  async exists(path: string): Promise<boolean> {
    return await plain.exists(this.physical(path)) || await isDirectory(path)
  }

  async mtimeOf(path: string): Promise<number> {
    const file = await plain.mtimeOf(this.physical(path))
    return file > 0 ? file : await isDirectory(path) ? await plain.mtimeOf(path) : 0
  }

  async sizeOf(path: string): Promise<number | undefined> {
    try {
      const info = await stat(this.physical(path))
      return info.isFile() ? Math.max(0, info.size - MAGIC.length - IV - TAG) : undefined
    } catch {
      return undefined
    }
  }

  async removePath(path: string): Promise<void> {
    await rm(this.physical(path), { force: true })
    if (await isDirectory(path)) await rm(path, { recursive: true, force: true })
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ───────────────────────────── sealing and unsealing a whole book ─────────────────────────────

async function walk(dir: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, visit)
    else if (entry.isFile()) await visit(path)
  }
}

/**
 * Seal every file under the book's own entries, in place. A file is sealed,
 * then its plain copy removed; one that is already sealed is left as it is, so
 * a sealing that was interrupted is finished by running it again.
 * @returns how many files were sealed.
 */
export async function sealTree(root: string, entries: readonly string[], key: Buffer, onProgress?: (done: number) => void): Promise<number> {
  const store = new SealedFiles(root, key)
  let done = 0
  const one = async (file: string): Promise<void> => {
    if (file.endsWith(SEALED_SUFFIX) || file.endsWith('.tmp') || basename(file) === '.DS_Store') return
    await store.writeAtomic(file, await readFile(file))
    await rm(file, { force: true })
    done += 1
    onProgress?.(done)
  }
  for (const entry of entries) {
    const path = join(root, entry)
    if (entry === STUB_FILE) continue
    if (await isDirectory(path)) await walk(path, one)
    else if (await plain.exists(path)) await one(path)
  }
  return done
}

/**
 * The reverse: every sealed file under the book's entries becomes a plain
 * file again. A file that does not open with this key is left sealed and
 * counted, never deleted.
 */
export async function unsealTree(root: string, entries: readonly string[], key: Buffer, onProgress?: (done: number) => void): Promise<{ opened: number; left: number }> {
  const store = new SealedFiles(root, key)
  let opened = 0
  let left = 0
  const one = async (file: string): Promise<void> => {
    if (!file.endsWith(SEALED_SUFFIX)) return
    const logical = store.logical(relative(root, file))
    if (logical === undefined) {
      left += 1
      return
    }
    const target = join(root, ...logical.split('/'))
    try {
      await plain.writeAtomic(target, store.open(target, await readFile(file)))
    } catch {
      left += 1
      return
    }
    await rm(file, { force: true })
    opened += 1
    onProgress?.(opened)
  }
  for (const entry of entries) {
    const path = join(root, entry)
    if (await isDirectory(path)) await walk(path, one)
  }
  // Files that lie directly in the book's folder (the outline). The manifest is the caller's to put back, last:
  // while anything is still sealed, `novel.json` must go on saying that the book is.
  for (const name of await plain.listDir(root)) if (name.endsWith(SEALED_SUFFIX) && store.logical(name) !== STUB_FILE) await one(join(root, name))
  return { opened, left }
}

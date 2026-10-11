// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The copies DSH keeps of a sealed book's pictures, kept under its seal while it is locked.
 *
 * A picture reaches a model through DSH's attachment service, which keeps a
 * copy of every one — plain, for good, and with no way to take one back. So a
 * picture of a sealed book that a model was shown lies readable outside the
 * book's seal. The Studio keeps a note of the copies it caused (and of the ones
 * a conversation of the book holds), and while the book is locked they are
 * taken out of DSH's store: each is encrypted to the book's drop, kept beside
 * the Studio's own data, and its plain object removed. When the book is
 * unlocked they are put back where DSH looks for them.
 *
 * A copy a conversation shows goes only after the book's conversations went:
 * a conversation that is still open must still find its pictures. A plain
 * object is removed only after its sealed copy is on disk, and — while the
 * book's key is at hand — has been opened again and compared.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ProjectError } from '../core/project'
import { resolveDshHome } from '../core/settings'
import { errorMessage, KeyedMutex } from '../core/util/async'
import { exists, readJson, writeAtomic, writeJson } from '../core/util/fs'
import { dropSeal, readStub } from '../core/util/vault'
import type { NovelService } from './service'

/** How the copies of a book's pictures stand. */
export interface PictureSealStatus {
  /** Copies under the seal right now. */
  sealed: number
  /** Copies that lie plain in DSH's store: all of them while the book is open. */
  open: number
}

/**
 * A reference as DSH's attachment service hands it out, down to what names the object: the service is asked where
 * that lies. What else a reference carries — the picture's file name above all, which may spell somebody's name —
 * is not kept: these notes lie outside the book's seal.
 */
interface Ref {
  attachmentId: string
}

/** Only what names the object. */
const bare = (ref: unknown): Ref => ({ attachmentId: String((ref as { attachmentId?: unknown }).attachmentId) })

interface Noted {
  ref: Ref
  /** A conversation holds it (a tool's result, a role's task): it waits for the conversations to go first. */
  shown?: true
}

interface Ledger {
  v: 1
  pictures: Record<string, Noted>
}

interface SealedMeta {
  v: 1
  ref: Ref
  sha256: string
  sealedAt: string
}

/** What is asked of DSH's attachment service here. */
interface Store {
  imageHostPath?(ref: unknown): string | undefined
}

const SUFFIX = '.nvp'
const ID = /[0-9a-f]{64}/

const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** The content hash a reference names its object by. */
export function pictureHash(ref: unknown): string | undefined {
  const id = (ref as { attachmentId?: unknown } | undefined)?.attachmentId
  return typeof id === 'string' ? ID.exec(id)?.[0] : undefined
}

/**
 * The attachment references a conversation's log holds, read off its text — whether written as part of an event or
 * inside a string an event carries. Only the id is taken: it is what names the object. (A file's reference is found
 * too; no picture lies where it points, so nothing is done about it.)
 * @param text - the log's events as JSON.
 */
export function pictureRefsIn(text: string): Ref[] {
  const found = new Map<string, Ref>()
  const pattern = /attachmentId\\*"\s*:\s*\\*"([^"\\]{1,200})/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const hash = ID.exec(match[1]!)?.[0]
    if (hash !== undefined && !found.has(hash)) found.set(hash, { attachmentId: match[1]! })
  }
  return [...found.values()]
}

export class PictureSeal {
  private readonly home = resolveDshHome()
  private readonly storeRoot = join(this.home, 'attachments')
  private readonly variantsRoot = join(this.home, 'cache', 'attachments', 'request-images')
  private readonly ledgerRoot = join(this.home, 'novel-writer', 'pictures')
  private readonly vaultRoot = join(this.home, 'novel-writer', 'sealed-pictures')
  private readonly mutex = new KeyedMutex()

  constructor(private readonly ctx: Context, private readonly service: NovelService) {}

  private safe(bookId: string): string {
    return bookId.replace(/[^\w-]/g, '_')
  }

  private ledgerOf(bookId: string): string {
    return join(this.ledgerRoot, `${this.safe(bookId)}.json`)
  }

  private vaultOf(bookId: string): string {
    return join(this.vaultRoot, this.safe(bookId))
  }

  private async bookId(root: string): Promise<string | undefined> {
    const stub = await readStub(root)
    if (stub !== undefined) return stub.id
    return (await this.service.core.tryRuntime(root).then(runtime => runtime?.project.manifest()).catch(() => undefined))?.id
  }

  private async ledger(bookId: string): Promise<Ledger> {
    const read = await readJson<Ledger>(this.ledgerOf(bookId)).catch(() => undefined)
    return read !== undefined && read.v === 1 && typeof read.pictures === 'object' && read.pictures !== null ? read : { v: 1, pictures: {} }
  }

  /** Where DSH keeps the object of a reference — only ever a path inside its own attachment store. */
  private objectOf(ref: Ref): string | undefined {
    const store = (this.ctx as unknown as { get(name: string): unknown }).get('attachments') as Store | undefined
    let path: string | undefined
    try {
      path = store?.imageHostPath?.(ref)
    } catch {
      return undefined
    }
    if (path === undefined) return undefined
    const at = resolve(path)
    return at.startsWith(this.storeRoot + sep) ? at : undefined
  }

  /** Whether a picture's object lies there now — a plain file, as DSH writes one. */
  private async lies(path: string | undefined): Promise<boolean> {
    return path !== undefined && await stat(path).then(found => found.isFile(), () => false)
  }

  /**
   * Note copies DSH now keeps of a book's pictures.
   * @param root - the book.
   * @param refs - what the attachment service handed back for them.
   * @param shown - a conversation holds them.
   */
  async note(root: string, refs: readonly unknown[], shown: boolean): Promise<void> {
    const id = await this.bookId(resolve(root))
    if (id !== undefined) await this.noteFor(id, refs, shown)
  }

  /** {@link note}, for a book known by its id — which is all there is to know of a locked one. */
  async noteFor(bookId: string, refs: readonly unknown[], shown: boolean): Promise<void> {
    const fresh = refs.flatMap((ref) => {
      const hash = pictureHash(ref)
      return hash !== undefined ? [{ hash, ref: bare(ref) }] : []
    })
    if (fresh.length === 0) return
    await this.mutex.run(`ledger:${bookId}`, async () => {
      const ledger = await this.ledger(bookId)
      let changed = false
      for (const { hash, ref } of fresh) {
        const had = ledger.pictures[hash]
        if (had !== undefined && (had.shown === true || !shown)) continue
        ledger.pictures[hash] = { ref: had !== undefined ? bare(had.ref) : ref, ...(shown ? { shown: true as const } : {}) }
        changed = true
      }
      if (!changed) return
      await mkdir(this.ledgerRoot, { recursive: true, mode: 0o700 })
      await writeJson(this.ledgerOf(bookId), ledger)
      await chmod(this.ledgerOf(bookId), 0o600).catch(() => {})
    })
  }

  async status(root: string): Promise<PictureSealStatus> {
    const id = await this.bookId(resolve(root))
    if (id === undefined) return { sealed: 0, open: 0 }
    const sealed = (await readdir(this.vaultOf(id)).catch(() => [] as string[])).filter(name => name.endsWith(SUFFIX)).length
    let open = 0
    for (const noted of Object.values((await this.ledger(id)).pictures)) {
      if (await this.lies(this.objectOf(noted.ref))) open += 1
    }
    return { sealed, open }
  }

  /**
   * Put the copies of a locked book's pictures under its seal.
   * @param verify - the book's key is at hand: open each sealed copy again and compare before the plain object goes.
   * @param withShown - the book's conversations are under the seal already, so the pictures they show may go too.
   */
  async seal(root: string, verify: boolean, withShown: boolean): Promise<PictureSealStatus> {
    const key = resolve(root)
    return await this.mutex.run(key, async () => {
      const stub = await readStub(key)
      const publicKey = stub?.sealed.drop?.publicKey
      if (stub === undefined || publicKey === undefined) return await this.status(key)
      const vault = this.vaultOf(stub.id)
      let taken = 0
      for (const [hash, noted] of Object.entries((await this.ledger(stub.id)).pictures)) {
        if (noted.shown === true && !withShown) continue
        const path = this.objectOf(noted.ref)
        if (path === undefined || !(await this.lies(path))) continue
        const target = join(vault, `${hash}${SUFFIX}`)
        try {
          const plain = await readFile(path)
          // DSH names an object by what is in it: anything else at that path is not the picture that was noted.
          if (digest(plain) !== hash) throw new Error('the object is not what its name says')
          const meta: SealedMeta = { v: 1, ref: bare(noted.ref), sha256: hash, sealedAt: new Date().toISOString() }
          await mkdir(vault, { recursive: true, mode: 0o700 })
          await writeAtomic(target, dropSeal(publicKey, plain))
          await chmod(target, 0o600).catch(() => {})
          await writeJson(join(vault, `${hash}.json`), meta)
          await chmod(join(vault, `${hash}.json`), 0o600).catch(() => {})
          const written = await readFile(target)
          if (verify) {
            if (digest(await this.service.core.openDropped(key, written)) !== hash) throw new Error('the sealed copy does not open to what was sealed')
          } else if (written.length < plain.length) {
            throw new Error('the sealed copy is shorter than what was sealed')
          }
          await rm(path, { force: true })
          taken += 1
        } catch (error) {
          this.service.log(`could not seal a picture copy of ${key}; it stays as it is`, error)
          await rm(target, { force: true }).catch(() => {})
          await rm(join(vault, `${hash}.json`), { force: true }).catch(() => {})
        }
      }
      // The versions DSH scaled for a request are worked out from the objects again when asked for; which of them were this book's cannot be told, so none is left.
      if (taken > 0) await rm(this.variantsRoot, { recursive: true, force: true }).catch(() => {})
      return await this.status(key)
    })
  }

  /** Put the copies of an unlocked book's pictures back where DSH keeps them. */
  async restore(root: string): Promise<PictureSealStatus> {
    const key = resolve(root)
    return await this.mutex.run(key, async () => {
      const stub = await readStub(key)
      if (stub === undefined) return await this.status(key)
      const vault = this.vaultOf(stub.id)
      let restored = 0
      for (const name of await readdir(vault).catch(() => [] as string[])) {
        if (!name.endsWith(SUFFIX)) continue
        const hash = name.slice(0, -SUFFIX.length)
        try {
          const meta = await readJson<SealedMeta>(join(vault, `${hash}.json`))
          if (meta === undefined || meta.sha256 !== hash || pictureHash(meta.ref) !== hash) throw new Error('the note that says which picture this is is missing or wrong')
          const path = this.objectOf(meta.ref)
          if (path === undefined) throw new Error('DSH does not say where it keeps this picture')
          const plain = await this.service.core.openDropped(key, await readFile(join(vault, name)))
          if (digest(plain) !== hash) throw new Error('the sealed copy does not open to what was sealed')
          // An object that is there already is the same picture: DSH names it by its content.
          if (!(await exists(path))) {
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            await writeAtomic(path, plain)
            // Its owner's to read and nobody's to change, as DSH wrote it.
            await chmod(path, 0o400).catch(() => {})
          }
          await rm(join(vault, name), { force: true })
          await rm(join(vault, `${hash}.json`), { force: true })
          restored += 1
        } catch (error) {
          // Left under the seal: nothing is lost, and it is tried again at the next unlock.
          this.service.log(`could not put a picture copy of ${key} back: ${errorMessage(error)}`, error instanceof ProjectError ? undefined : error)
        }
      }
      if (restored > 0) await rmdir(vault).catch(() => {})
      return await this.status(key)
    })
  }
}

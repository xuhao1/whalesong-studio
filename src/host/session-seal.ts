// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The conversations about a sealed book, kept under its seal while it is locked.
 *
 * DSH keeps every conversation as a log file under its home, readable by
 * whoever can read the disk — and a conversation with the showrunner about a
 * book holds that book: the chapters it read, what it was told to write, what
 * the roles found. DSH has no way to encrypt a log or to delete one, so a
 * sealed book's conversations are taken out of DSH's hands while the book is
 * locked: each log is encrypted to the book's drop (a public key the book's
 * stub carries, so this works without the book's key), kept beside the
 * Studio's own data, and its plain file removed. When the book is unlocked
 * the logs are put back where they were, and the conversations go on.
 *
 * A log is only ever taken while nothing holds it: write ownership is claimed
 * through DSH's own session store first, and a conversation that is open
 * somewhere waits until it is let go — at the latest the next time DSH starts.
 * A plain log is removed only after its sealed copy is on disk, and — while
 * the book's key is still at hand — has been opened again and compared.
 *
 * The pictures a conversation shows are kept by DSH apart from its log, as
 * plain as the log was: they are noted as the log goes under the seal, and
 * follow it there once no conversation of the book is left outside
 * ({@link PictureSeal}); they are back before the logs are.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ProjectError } from '../core/project'
import { resolveDshHome } from '../core/settings'
import { errorMessage, KeyedMutex } from '../core/util/async'
import { exists, readJson, writeAtomic, writeJson } from '../core/util/fs'
import { dropSeal, readStub } from '../core/util/vault'
import { pictureRefsIn } from './picture-seal'
import { CREW_PRESET } from './roles'
import type { NovelService } from './service'

/** How a book's conversations stand. */
export interface SessionSealStatus {
  /** Conversations under the seal right now. */
  sealed: number
  /** Conversations of the book that lie plain in DSH's store: all of them while the book is open. */
  open: number
  /** Of those, the ones that could not be taken because they are in use; they go under the seal when they are let go. */
  waiting: number
}

interface SealedMeta {
  v: 1
  id: string
  /** Where the log lay, relative to DSH's sessions folder. */
  dir: string
  files: { name: string; size: number }[]
  sha256: string
  sealedAt: string
}

const SUFFIX = '.nvd'

function pack(files: { name: string; data: Buffer }[]): Buffer {
  const head = Buffer.from(JSON.stringify({ v: 1, files: files.map(file => ({ name: file.name, size: file.data.length })) }))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(head.length)
  return Buffer.concat([size, head, ...files.map(file => file.data)])
}

function unpack(blob: Buffer): { name: string; data: Buffer }[] {
  const size = blob.readUInt32BE(0)
  const head = JSON.parse(blob.subarray(4, 4 + size).toString('utf8')) as { files: { name: string; size: number }[] }
  let at = 4 + size
  return head.files.map((file) => {
    // A name is a file of the session's own folder and nothing else.
    if (file.name.includes('/') || file.name.includes('\\') || file.name.startsWith('.')) throw new Error(`unexpected file name "${file.name}" in a sealed conversation`)
    const data = blob.subarray(at, at + file.size)
    at += file.size
    return { name: file.name, data }
  })
}

const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

export class SessionSeal {
  private readonly home = resolveDshHome()
  private readonly sessionsRoot = join(this.home, 'sessions')
  private readonly cacheRoot = join(this.home, 'storages', 'session_projcache', 'sessions')
  private readonly vaultRoot = join(this.home, 'novel-writer', 'sealed-sessions')
  private readonly mutex = new KeyedMutex()
  /** Books whose conversations could not all be taken: looked at again when DSH lets go of a session. */
  private readonly unfinished = new Set<string>()
  private readonly watchers = new Set<(root: string) => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(private readonly ctx: Context, private readonly service: NovelService) {}

  /**
   * Follow the books' locks from now on, and bring what is on disk in line with them once.
   * @param known - the sealed books there are; asked once DSH can say which conversations and workspaces it has.
   */
  start(known: () => Promise<readonly string[]>): void {
    const core = this.service.core
    // While the key is still at hand: what is sealed now can be opened again and compared before the plain log goes.
    this.ctx.effect(() => core.onBeforeLock(async (root) => { await this.seal(root, true) }), 'novel: seal conversations before a lock')
    this.ctx.effect(() => core.onLock((root) => { void this.sync(root).catch((error: unknown) => { this.service.log(`could not bring the conversations of ${root} in line with its lock`, error) }) }), 'novel: conversations follow the lock')
    // A conversation that was in use when its book was locked goes under the seal once DSH lets go of it.
    this.ctx.on('session/disposed', () => {
      if (this.unfinished.size === 0 || this.stopped) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        for (const root of [...this.unfinished]) void this.sync(root).catch((error: unknown) => { this.service.log(`could not seal the conversations of ${root}`, error) })
      }, 1500)
      this.timer.unref?.()
    })
    this.ctx.effect(() => () => {
      this.stopped = true
      clearTimeout(this.timer)
    }, 'novel: conversations follow the lock (timer)')
    // DSH's session store and its workspaces come up after the Studio does: asked before that, there would be no book to look at and no conversation to take.
    this.ctx.inject(['sessionPersistence', 'workspaceRegistry'], () => {
      void known()
        .then(async (roots) => {
          for (const root of roots) await this.sync(root).catch((error: unknown) => { this.service.log(`could not bring the conversations of ${root} in line with its lock`, error) })
        })
        .catch((error: unknown) => { this.service.log('could not look after the conversations of sealed books', error) })
    })
  }

  /** Be told when the conversations of a book were sealed or put back. */
  onChange(listener: (root: string) => void): () => void {
    this.watchers.add(listener)
    return () => { this.watchers.delete(listener) }
  }

  private changed(root: string): void {
    for (const listener of [...this.watchers]) {
      try {
        listener(root)
      } catch {
        // an observer must not stop the work
      }
    }
  }

  /** Under the seal while the book is locked, back in DSH's hands while it is open — whichever the book is now. */
  async sync(root: string): Promise<SessionSealStatus> {
    const key = resolve(root)
    const stub = await readStub(key)
    if (stub === undefined) {
      // No longer sealed (or never was): nothing of it stays behind a key that is gone. Opening needs the key, so this only finds what unsealing left.
      return await this.status(key)
    }
    const lock = await this.service.core.lockOf(key)
    return lock.locked ? await this.seal(key, false) : await this.restore(key)
  }

  private vaultOf(bookId: string): string {
    return join(this.vaultRoot, bookId.replace(/[^\w-]/g, '_'))
  }

  /**
   * Where DSH keeps each stored session, by id: a folder named after the
   * session, inside a folder named after the directory it was started in.
   */
  private async stored(): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (const slug of await readdir(this.sessionsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!slug.isDirectory()) continue
      for (const entry of await readdir(join(this.sessionsRoot, slug.name), { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) found.set(entry.name, join(slug.name, entry.name))
      }
    }
    return found
  }

  /**
   * The conversations that hold something of a book: the ones put on it by
   * name; the ones a tool was pointed at it from, and the runs of the roles
   * that worked on it (the Studio notes both as they happen); the Studio's own
   * in a folder whose only book it is; whatever ran in the book's folder as
   * somebody's subagent — and every child of any of these, however deep.
   */
  private async sessionsOf(root: string): Promise<Set<string>> {
    const ids = new Set([...await this.service.sessions.sessionsOn(root), ...await this.service.sessionBooks.sessionsOf(root)])
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return ids
    const only = new Map<string, boolean>()
    const onlyBookOf = async (cwd: string): Promise<boolean> => {
      let known = only.get(cwd)
      if (known === undefined) {
        const books = await this.service.core.discover(cwd).catch(() => [])
        known = books.length === 1 && resolve(books[0]!.root) === root
        only.set(cwd, known)
      }
      return known
    }
    const headers = (await persistence.list().catch(() => [])).map(snapshot => snapshot.header)
    for (const { id, cwd, origin, agentPreset } of headers) {
      if (cwd === undefined || ids.has(id)) continue
      const here = resolve(cwd)
      const inside = here === root || here.startsWith(root + sep)
      if (origin === 'subagent') {
        if (inside) ids.add(id)
        continue
      }
      if (agentPreset !== CREW_PRESET) continue
      // A conversation that was put on another book by name is that book's.
      const bound = await this.service.sessions.boundTo(id)
      if (bound !== undefined && resolve(bound) !== root) continue
      if (inside || await onlyBookOf(here)) ids.add(id)
    }
    // A child's log is its parent's work in detail: where the parent goes, it goes.
    for (let grew = true; grew;) {
      grew = false
      for (const header of headers) {
        if (header.parentSession === undefined || ids.has(header.id) || !ids.has(header.parentSession)) continue
        ids.add(header.id)
        grew = true
      }
    }
    return ids
  }

  async status(root: string): Promise<SessionSealStatus> {
    const key = resolve(root)
    const stub = await readStub(key)
    const id = stub?.id ?? (await this.service.core.tryRuntime(key).then(runtime => runtime?.project.manifest()).catch(() => undefined))?.id
    const sealed = id !== undefined ? (await readdir(this.vaultOf(id)).catch(() => [] as string[])).filter(name => name.endsWith(SUFFIX)).length : 0
    const stored = await this.stored()
    const open = [...await this.sessionsOf(key)].filter(session => stored.has(session)).length
    return { sealed, open, waiting: this.unfinished.has(key) ? open : 0 }
  }

  /**
   * Put the book's conversations under its seal.
   * @param verify - the book's key is at hand: open each sealed copy again and compare before the plain log is removed.
   */
  private async seal(root: string, verify: boolean): Promise<SessionSealStatus> {
    return await this.mutex.run(root, async () => {
      const stub = await readStub(root)
      const publicKey = stub?.sealed.drop?.publicKey
      const persistence = this.ctx.get('sessionPersistence')
      // A book sealed before there was a drop gets one the next time it is unlocked; until then its conversations stay as they are.
      if (stub === undefined || publicKey === undefined) return await this.status(root)
      if (persistence === undefined) {
        // No conversations are kept, so none shows a picture: the copies DSH keeps of the book's pictures go as they are.
        await this.service.pictureSeal.seal(root, verify, true).catch((error: unknown) => { this.service.log(`could not seal the picture copies of ${root}`, error) })
        return await this.status(root)
      }
      const vault = this.vaultOf(stub.id)
      const stored = await this.stored()
      let waiting = 0
      let sealed = 0
      for (const id of await this.sessionsOf(root)) {
        const relative = stored.get(id)
        if (relative === undefined) continue
        const dir = join(this.sessionsRoot, relative)
        // Nobody may be writing: ownership is claimed the way DSH itself claims it, and a conversation in use is left for later.
        let handle: Awaited<ReturnType<typeof persistence.open>>
        try {
          handle = await persistence.open(id as SessionId, 'write')
        } catch (error) {
          if ((error as Error | undefined)?.name?.includes('NotFound') === true) continue
          waiting += 1
          continue
        }
        let done = false
        try {
          await handle.flush()
          // The pictures it shows lie in DSH's attachment store, as plain as this log: noted, to follow it under the seal.
          const shown = await (async () => pictureRefsIn(JSON.stringify((await handle.read()).events)))().catch(() => [])
          if (shown.length > 0) await this.service.pictureSeal.noteFor(stub.id, shown, true).catch((error: unknown) => { this.service.log(`could not note the pictures conversation ${id} shows`, error) })
          const files: { name: string; data: Buffer }[] = []
          for (const name of (await readdir(dir)).sort()) {
            const path = join(dir, name)
            if (!(await stat(path)).isFile()) continue
            files.push({ name, data: await readFile(path) })
          }
          const plain = pack(files)
          const meta: SealedMeta = { v: 1, id, dir: relative.split(sep).join('/'), files: files.map(file => ({ name: file.name, size: file.data.length })), sha256: digest(plain), sealedAt: new Date().toISOString() }
          const target = join(vault, `${id}${SUFFIX}`)
          await mkdir(vault, { recursive: true })
          await writeAtomic(target, dropSeal(publicKey, plain))
          await writeJson(join(vault, `${id}.json`), meta)
          const written = await readFile(target)
          if (verify) {
            // Opened again with the book's key and compared: only then is the copy what the plain log is given up for.
            if (digest(await this.service.core.openDropped(root, written)) !== meta.sha256) throw new Error('the sealed copy does not open to what was sealed')
          } else if (written.length < plain.length) {
            throw new Error('the sealed copy is shorter than what was sealed')
          }
          done = true
        } catch (error) {
          this.service.log(`could not seal conversation ${id} of ${root}; it stays as it is`, error)
          await rm(join(vault, `${id}${SUFFIX}`), { force: true }).catch(() => {})
          await rm(join(vault, `${id}.json`), { force: true }).catch(() => {})
          waiting += 1
        } finally {
          await handle.close().catch(() => {})
        }
        if (!done) continue
        await rm(dir, { recursive: true, force: true })
        // What DSH worked out from the log — its title, the outline of its turns — goes with it; it is worked out again when the log is back.
        await rm(join(this.cacheRoot, `${id}.json`), { force: true }).catch(() => {})
        sealed += 1
      }
      if (waiting > 0) this.unfinished.add(root)
      else this.unfinished.delete(root)
      // A picture a conversation shows stays for as long as one of the book's conversations is still outside.
      await this.service.pictureSeal.seal(root, verify, waiting === 0).catch((error: unknown) => { this.service.log(`could not seal the picture copies of ${root}`, error) })
      if (sealed > 0) this.changed(root)
      return { ...(await this.status(root)), waiting }
    })
  }

  /** Put the conversations of an unlocked book back where DSH keeps them. */
  private async restore(root: string): Promise<SessionSealStatus> {
    return await this.mutex.run(root, async () => {
      this.unfinished.delete(root)
      const stub = await readStub(root)
      if (stub === undefined) return await this.status(root)
      // The pictures first: a conversation that is back must find what it shows.
      await this.service.pictureSeal.restore(root).catch((error: unknown) => { this.service.log(`could not put the picture copies of ${root} back`, error) })
      const vault = this.vaultOf(stub.id)
      let restored = 0
      for (const name of await readdir(vault).catch(() => [] as string[])) {
        if (!name.endsWith(SUFFIX)) continue
        const id = name.slice(0, -SUFFIX.length)
        try {
          const meta = await readJson<SealedMeta>(join(vault, `${id}.json`))
          if (meta === undefined || meta.id !== id || meta.dir.split('/').length !== 2 || meta.dir.split('/').some(part => part === '..' || part === '.' || part.length === 0)) throw new Error('the note that says where the conversation belongs is missing or wrong')
          const plain = await this.service.core.openDropped(root, await readFile(join(vault, name)))
          if (digest(plain) !== meta.sha256) throw new Error('the sealed copy does not open to what was sealed')
          const dir = join(this.sessionsRoot, ...meta.dir.split('/'))
          // A log that is there already is the newer one: DSH's own is never overwritten.
          if (!(await exists(dir))) {
            await mkdir(dir, { recursive: true, mode: 0o700 })
            for (const file of unpack(plain)) {
              await writeAtomic(join(dir, file.name), file.data)
              // A conversation is its owner's to read, as DSH wrote it.
              await chmod(join(dir, file.name), 0o600).catch(() => {})
            }
          }
          await rm(join(vault, name), { force: true })
          await rm(join(vault, `${id}.json`), { force: true })
          restored += 1
        } catch (error) {
          // Left under the seal: nothing is lost, and it is tried again at the next unlock.
          this.service.log(`could not put conversation ${id} of ${root} back: ${errorMessage(error)}`, error instanceof ProjectError ? undefined : error)
        }
      }
      if (restored > 0) {
        // Gone when nothing is left in it; kept, with what could not be put back, otherwise.
        await rmdir(vault).catch(() => {})
        this.changed(root)
      }
      return await this.status(root)
    })
  }
}

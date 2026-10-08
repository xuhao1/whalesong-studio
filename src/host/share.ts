// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A book on another device: a small web server of the Studio's own that serves
 * a reader — the chapters, their pictures, their audio drama and their motion
 * comic — to phones and tablets on the same network.
 *
 * It is off until the author switches it on for a book, and it is deliberately
 * not the Harness: it reaches no key, no setting and no book that was not
 * shared, and its address carries a random token, so "who can open it" is "who
 * was given the link".
 *
 * A shared book is read-only there unless the author made it changeable. Then
 * its text can be edited from the device and its interludes played — which
 * calls the models set up on this computer — and nothing else.
 *
 * A sealed book asks every new device for its password once. The device is
 * then given a grant of its own (a cookie holding a key that opens the book),
 * which the author can withdraw.
 *
 *   GET  /<token>/                                    the reader page
 *   GET  /<token>/app.js                              its script
 *   GET  /<token>/api/books                           the shared books
 *   GET  /<token>/api/books/<id>                      one book and its chapters
 *   GET  /<token>/api/books/<id>/chapters/<chapter>   text, audio script and storyboard of a chapter
 *   GET  /<token>/media/<id>/assets/…                 pictures and audio of a shared book
 *   POST /<token>/api/books/<id>/unlock               a sealed book: the password, once per device
 *   — on a changeable book only —
 *   PUT  /<token>/api/books/<id>/chapters/<chapter>   save the chapter's text
 *   GET  /<token>/api/books/<id>/cast                 who can be in an interlude
 *   GET  /<token>/api/books/<id>/plays[/<play>]       the interludes, or one of them
 *   POST /<token>/api/books/<id>/plays                start one
 *   POST /<token>/api/books/<id>/plays/<play>/turns   say or do something in it
 *   POST /<token>/api/books/<id>/plays/<play>/rewind  take the last turn back
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NovelCore, ProjectRuntime } from '../core/core'
import { ProjectError } from '../core/project'
import type { DeepPartial } from '../core/settings'
import { errorMessage } from '../core/util/async'
import { bookAnswer, describeBook, ReaderRefused, type SharedBook } from '../core/reader'
import { openWithSecret, readStub, VaultError, type SealedStub } from '../core/util/vault'
import type { ShareStatus } from '../shared/rpc'
import { hashText } from '../shared/text'
import type { NovelSettings, ShareSettings } from '../shared/types'

export const DEFAULT_SHARE_PORT = 4319
/** How many ports, counting up from the one asked for, are tried before giving up. */
const PORT_TRIES = 20

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}

/** What the reader page may load: itself, and nothing from anywhere else. */
const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** The largest request body the server reads: a long chapter with room to spare. */
const BODY_LIMIT = 2 * 1024 * 1024
/** How long a device stays let in to a sealed book. */
const GRANT_DAYS = 60
/** A sealed book that only devices opened is locked again when none of them has asked for it this long. */
const DEVICE_IDLE_MS = 30 * 60_000

class Refused extends Error {
  constructor(readonly status: number, message: string, readonly code = 'refused') {
    super(message)
  }
}

export class ShareServer {
  private server: Server | undefined
  private port: number | undefined
  /** The port that was asked for, when it was taken and another one is in use instead. */
  private wanted: number | undefined
  private failure: string | undefined
  private token = ''
  private books: string[] = []
  private edit = new Set<string>()
  /** Wrong passwords per book: after a few, the next try has to wait. */
  private readonly misses = new Map<string, { count: number; until: number }>()
  /** When a device last read each sealed book; one that devices alone opened is locked again once they have gone quiet. */
  private readonly seen = new Map<string, number>()
  private readonly idle: NodeJS.Timeout
  private applying: Promise<void> = Promise.resolve()
  private readonly off: () => void
  private bundle: { at: number; body: Buffer; etag: string } | undefined

  /**
   * @param host - the interface to listen on: every one by default, so other devices can reach it.
   */
  constructor(private readonly core: NovelCore, private readonly log: (message: string, error?: unknown) => void, private readonly host = '0.0.0.0') {
    // Whatever changes the settings — the Studio, the showrunner, another window — the server follows.
    this.off = core.settings.onChange(() => { void this.apply() })
    this.idle = setInterval(() => {
      for (const [root, at] of this.seen) {
        if (Date.now() - at < DEVICE_IDLE_MS) continue
        this.seen.delete(root)
        if (core.openToDevicesOnly(root)) void core.lockBook(root).catch(() => {})
      }
    }, 60_000)
    this.idle.unref()
  }

  /** Bring the server in line with the settings: listening when sharing is on and a book is shared, closed otherwise. */
  apply(): Promise<void> {
    const next = this.applying.then(async () => {
      try {
        await this.reconcile()
      } catch (error) {
        this.failure = errorMessage(error)
        this.log('the reader for other devices could not start', error)
      }
    })
    this.applying = next
    return next
  }

  private async reconcile(): Promise<void> {
    const share: ShareSettings = (await this.core.settings.get()).share ?? { enabled: false }
    const books = (share.books ?? []).filter(root => typeof root === 'string' && root.length > 0)
    const wanted = share.enabled && books.length > 0
    this.edit = new Set((share.edit ?? []).filter(root => books.includes(root)))
    if (!wanted) {
      this.books = books
      this.failure = undefined
      await this.stop()
      return
    }
    // The address is a secret: one is made the first time sharing is switched on, and kept so bookmarks keep working.
    if (share.token === undefined || share.token.length < 16) {
      await this.core.settings.update({ share: { token: randomBytes(18).toString('base64url') } } as DeepPartial<NovelSettings>)
      return
    }
    this.token = share.token
    this.books = books
    const port = share.port !== undefined && Number.isInteger(share.port) && share.port >= 1024 && share.port <= 65535 ? share.port : DEFAULT_SHARE_PORT
    if (this.server !== undefined && (this.port === port || this.wanted === port)) {
      this.failure = undefined
      return
    }
    await this.stop()
    // A port somebody else holds (a second Harness, another program) is no reason to fail: the next free one will do, and the address says which.
    for (let candidate = port; candidate < port + PORT_TRIES && candidate <= 65535; candidate++) {
      const outcome = await this.listen(candidate)
      if (outcome === 'listening') {
        this.wanted = candidate !== port ? port : undefined
        return
      }
      if (outcome !== 'busy') return
    }
    this.failure = `ports ${port}–${Math.min(65535, port + PORT_TRIES - 1)} are all in use on this machine — choose another port`
  }

  private listen(port: number): Promise<'listening' | 'busy' | 'failed'> {
    return new Promise<'listening' | 'busy' | 'failed'>((done) => {
      const server = createServer((request, response) => {
        // Nothing a request does may take the Harness down with it.
        this.handle(request, response).catch((error: unknown) => {
          this.log('a reader request failed', error)
          try {
            if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            response.end()
          } catch {
            // The connection is gone; nothing left to answer.
          }
        })
      })
      server.on('clientError', (_error, socket) => { socket.destroy() })
      const failed = (error: NodeJS.ErrnoException): void => {
        this.failure = error.code === 'EADDRINUSE'
          ? `port ${port} is already in use on this machine — choose another port`
          : error.code === 'EACCES' ? `this machine does not allow listening on port ${port} — choose another port` : errorMessage(error)
        this.server = undefined
        this.port = undefined
        done(error.code === 'EADDRINUSE' ? 'busy' : 'failed')
      }
      server.once('error', failed)
      server.listen(port, this.host, () => {
        server.off('error', failed)
        server.on('error', (error) => { this.log('the reader for other devices reported an error', error) })
        // A reader left open in a browser must not keep the Harness from quitting.
        server.unref()
        this.server = server
        this.port = port
        this.failure = undefined
        done('listening')
      })
    })
  }

  private stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    this.wanted = undefined
    if (server === undefined) return Promise.resolve()
    return new Promise<void>((done) => {
      server.close(() => { done() })
      server.closeAllConnections()
    })
  }

  async close(): Promise<void> {
    this.off()
    clearInterval(this.idle)
    await this.applying.catch(() => {})
    await this.stop()
  }

  async status(): Promise<ShareStatus> {
    await this.applying.catch(() => {})
    const share = (await this.core.settings.get()).share
    const books: ShareStatus['books'] = []
    for (const root of share?.books ?? []) {
      const mode = share?.edit?.includes(root) === true ? 'edit' as const : 'read' as const
      // A sealed book is listed by the name its author gave it for the shelf, locked or not.
      const stub = await readStub(root)
      if (stub !== undefined) {
        books.push({ root, id: stub.id, title: stub.title, mode, sealed: true })
        continue
      }
      const runtime = await this.core.tryRuntime(root, 'device').catch(() => undefined)
      if (runtime === undefined) continue
      const manifest = await runtime.project.manifest()
      books.push({ root, id: manifest.id, title: manifest.title, mode })
    }
    const running = this.server !== undefined && this.port !== undefined
    return {
      enabled: share?.enabled === true,
      running,
      ...(running ? { port: this.port! } : share?.port !== undefined ? { port: share.port } : {}),
      ...(running && this.wanted !== undefined ? { instead: this.wanted } : {}),
      urls: running ? addresses().map(host => `http://${host}:${this.port!}/${this.token}/`) : [],
      books,
      ...(this.failure !== undefined ? { error: this.failure } : {}),
    }
  }

  // ───────────── requests ─────────────

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: string | Buffer, headers: Record<string, string> = {}): void => {
      const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
      response.writeHead(status, {
        'content-length': String(data.length),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        ...headers,
      })
      response.end(request.method === 'HEAD' ? undefined : data)
    }
    const missing = (): void => { send(404, 'not found', { 'content-type': 'text/plain; charset=utf-8' }) }
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}): void => { send(status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', ...headers }) }
    const method = request.method ?? 'GET'
    const reading = method === 'GET' || method === 'HEAD'
    if (!reading && method !== 'POST' && method !== 'PUT') {
      send(405, 'method not allowed', { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD, POST, PUT' })
      return
    }
    const raw = request.url ?? '/'
    if (raw.length > 2048) {
      missing()
      return
    }
    let parts: string[]
    try {
      parts = new URL(raw, 'http://reader.invalid').pathname.split('/').filter(part => part.length > 0).map(part => decodeURIComponent(part))
    } catch {
      missing()
      return
    }
    // Without the token there is nothing here, and nothing says that there could be.
    if (parts.length === 0 || !this.permits(parts[0]!)) {
      missing()
      return
    }
    const rest = parts.slice(1)
    if (reading && rest.length === 0) {
      // The page addresses everything relative to itself, so its own address ends in a slash.
      if (!new URL(raw, 'http://reader.invalid').pathname.endsWith('/')) {
        response.writeHead(308, { location: `/${encodeURIComponent(parts[0]!)}/` })
        response.end()
        return
      }
      send(200, page(), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_POLICY })
      return
    }
    if (reading && rest.length === 1 && rest[0] === 'app.js') {
      const bundle = await this.script()
      if (bundle === undefined) {
        send(503, 'the reader has not been built (lib/reader.js is missing)', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      if (request.headers['if-none-match'] === bundle.etag) {
        response.writeHead(304, { etag: bundle.etag, 'cache-control': 'no-cache' })
        response.end()
        return
      }
      send(200, bundle.body, { 'content-type': 'text/javascript; charset=utf-8', etag: bundle.etag, 'cache-control': 'no-cache' })
      return
    }
    try {
      if (rest[0] === 'api' && rest[1] === 'books') {
        if (rest.length === 2) {
          if (!reading) throw new Refused(405, 'method not allowed')
          json({ books: await this.shelf(request) })
          return
        }
        const id = rest[2]!
        if (!reading) this.checkWrite(request)
        if (method === 'POST' && rest.length === 4 && rest[3] === 'unlock') {
          const body = await readBody(request)
          const grant = await this.letIn(id, typeof body.password === 'string' ? body.password : '', request)
          json({ ok: true }, 200, { 'set-cookie': this.cookie(id, grant) })
          return
        }
        const { runtime, mode } = await this.book(id, request)
        // Everything of a book a reader is given is made in one place, whoever asks (`core/reader.ts`).
        json(await bookAnswer(this.core, runtime, mode, {
          method: reading ? 'GET' : method === 'PUT' ? 'PUT' : 'POST',
          path: rest.slice(3),
          ...(reading ? {} : { body: await readBody(request) }),
          by: deviceName(request),
        }))
        return
      }
      if (reading && rest[0] === 'media' && rest.length >= 4 && rest[2] === 'assets') {
        const { runtime } = await this.book(rest[1]!, request)
        await this.file(runtime, rest.slice(2), request, response, missing)
        return
      }
      missing()
    } catch (error) {
      if (error instanceof Refused || error instanceof ReaderRefused) {
        if (error.status === 404) missing()
        else json({ error: error.code, message: error.message }, error.status)
        return
      }
      // What a pipeline says went wrong is for whoever is holding the device: a missing model, an empty line.
      if (error instanceof ProjectError) {
        json({ error: error.code, message: error.message }, error.code === 'novel/not-found' ? 404 : 422)
        return
      }
      throw error
    }
  }

  /** A request that changes something says so in a way a page on another site cannot. */
  private checkWrite(request: IncomingMessage): void {
    if (request.headers['x-novel-reader'] !== '1' || !String(request.headers['content-type'] ?? '').startsWith('application/json')) throw new Refused(400, 'not a request of the reader')
  }

  private permits(candidate: string): boolean {
    const given = Buffer.from(candidate)
    const real = Buffer.from(this.token)
    return real.length >= 16 && given.length === real.length && timingSafeEqual(given, real)
  }

  /** The shared books as this device may see them. A sealed book it was not let in to is a name and a lock. */
  private async shelf(request: IncomingMessage): Promise<SharedBook[]> {
    const books: SharedBook[] = []
    for (const root of this.books) {
      const mode = this.edit.has(root) ? 'edit' as const : 'read' as const
      const stub = await readStub(root)
      if (stub !== undefined && !(await this.admitted(root, stub, request))) {
        books.push({ id: stub.id, title: stub.title, language: 'zh', words: 0, chapters: 0, mode, locked: true })
        continue
      }
      const runtime = await this.core.tryRuntime(root, 'device').catch(() => undefined)
      if (runtime !== undefined) books.push(await describeBook(runtime, mode))
    }
    return books
  }

  /**
   * A shared book by its id, for this device. A book that is not shared does
   * not exist here; a sealed one exists only for a device that was let in.
   * @throws Refused 404, or 423 `locked` when the device has to show the password first.
   */
  private async book(id: string, request: IncomingMessage): Promise<{ runtime: ProjectRuntime; mode: 'read' | 'edit' }> {
    for (const root of this.books) {
      const stub = await readStub(root)
      if (stub !== undefined) {
        if (stub.id !== id) continue
        if (!(await this.admitted(root, stub, request))) throw new Refused(423, 'this book is sealed: its password is asked for once on every device', 'locked')
      }
      const runtime = await this.core.tryRuntime(root, 'device').catch(() => undefined)
      if (runtime === undefined) continue
      if (stub === undefined && (await runtime.project.manifest()).id !== id) continue
      return { runtime, mode: this.edit.has(root) ? 'edit' : 'read' }
    }
    throw new Refused(404, 'not found')
  }

  private grantOf(request: IncomingMessage, id: string): { id: string; secret: Buffer } | undefined {
    const name = `nvg_${id.replace(/[^\w-]/g, '')}`
    for (const pair of String(request.headers.cookie ?? '').split(';')) {
      const at = pair.indexOf('=')
      if (at < 0 || pair.slice(0, at).trim() !== name) continue
      const [grant, secret] = pair.slice(at + 1).trim().split('.')
      if (grant === undefined || secret === undefined || !/^[\w-]{8,40}$/.test(grant)) return undefined
      const key = Buffer.from(secret, 'base64url')
      return key.length === 32 ? { id: grant, secret: key } : undefined
    }
    return undefined
  }

  /**
   * Whether this device was let in to a sealed book: it holds a grant that
   * still opens it. A grant is a key, so a book that is locked on this
   * computer — the Harness was restarted — is unlocked by it.
   */
  private async admitted(root: string, stub: SealedStub, request: IncomingMessage): Promise<boolean> {
    const grant = this.grantOf(request, stub.id)
    if (grant === undefined) return false
    try {
      openWithSecret(stub, 'grant', grant.id, grant.secret)
    } catch {
      return false
    }
    // Locked on this computer: the grant opens the book for devices, and for them only — here it stays locked.
    if (this.core.keyOf(root) === undefined) await this.core.unlockBook(root, { kind: 'grant', id: grant.id, secret: grant.secret }, 'device').catch((error: unknown) => { this.log('a device\'s grant could not unlock its book', error) })
    this.seen.set(root, Date.now())
    return true
  }

  /**
   * Let a device in to a sealed book: it showed the password, so it gets a
   * grant of its own — a key in a cookie that opens the book until the author
   * withdraws it.
   * @throws Refused 403 for a wrong password, 429 after too many of them.
   */
  private async letIn(id: string, password: string, request: IncomingMessage): Promise<{ id: string; secret: Buffer }> {
    for (const root of this.books) {
      const stub = await readStub(root)
      if (stub === undefined || stub.id !== id) continue
      const missed = this.misses.get(root)
      if (missed !== undefined && missed.until > Date.now()) throw new Refused(429, `too many wrong passwords — wait ${Math.ceil((missed.until - Date.now()) / 1000)} seconds`, 'wait')
      try {
        // The password typed on a device opens the book for devices; the Studio on this computer is not unlocked by it.
        await this.core.unlockBook(root, { password }, 'device')
      } catch (error) {
        if (!(error instanceof VaultError)) throw error
        // Guessing is slowed down: after three misses each further one doubles the wait, up to ten minutes.
        const count = (missed?.count ?? 0) + 1
        this.misses.set(root, { count, until: count >= 3 ? Date.now() + Math.min(600_000, 5000 * 2 ** (count - 3)) : 0 })
        throw new Refused(403, 'that is not the password of this book', 'wrong-password')
      }
      this.misses.delete(root)
      this.seen.set(root, Date.now())
      // Grants whose cookie has run out open nothing any more; they are cleared away as new ones are made.
      for (const slot of stub.sealed.slots) {
        if (slot.kind === 'grant' && slot.id !== undefined && slot.at !== undefined && Date.now() - Date.parse(slot.at) > GRANT_DAYS * 86_400_000) await this.core.rekeyBook(root, { remove: { kind: 'grant', id: slot.id } }).catch(() => {})
      }
      const grant = { id: randomBytes(9).toString('base64url'), secret: randomBytes(32) }
      await this.core.rekeyBook(root, { add: this.core.slotFor('grant', grant.id, grant.secret, `${deviceName(request)} · ${new Date().toLocaleDateString()}`) })
      return grant
    }
    throw new Refused(404, 'not found')
  }

  private cookie(id: string, grant: { id: string; secret: Buffer }): string {
    // Kept from scripts and from other sites, and sent only to this reader's own address.
    return `nvg_${id.replace(/[^\w-]/g, '')}=${grant.id}.${grant.secret.toString('base64url')}; Path=/${encodeURIComponent(this.token)}/; Max-Age=${GRANT_DAYS * 86400}; HttpOnly; SameSite=Strict`
  }

  private async file(runtime: ProjectRuntime, parts: string[], request: IncomingMessage, response: ServerResponse, missing: () => void): Promise<void> {
    if (parts.some(part => part === '.' || part === '..' || part.includes('\0') || part.includes('/') || part.includes('\\'))) {
      missing()
      return
    }
    const type = MIME[extname(parts.at(-1)!).toLowerCase()]
    // Pictures and audio only: nothing else under assets is a reader's business.
    if (type === undefined) {
      missing()
      return
    }
    const base = resolve(runtime.project.root, 'assets')
    const path = resolve(runtime.project.root, ...parts)
    let size: number
    let stamp: number
    // A sealed book's files are opened whole and served from memory.
    let opened: Buffer | undefined
    if (runtime.project.sealed) {
      const info = await runtime.project.fileInfo(parts.join('/'))
      if (info === undefined) {
        missing()
        return
      }
      opened = await runtime.project.readFile(parts.join('/'))
      size = opened.length
      stamp = info.mtime
    } else try {
      // A link that leads out of the book's assets is not followed.
      const [real, realBase] = await Promise.all([realpath(path), realpath(base)])
      if (real !== realBase && !real.startsWith(realBase + sep)) {
        missing()
        return
      }
      const info = await stat(real)
      if (!info.isFile()) {
        missing()
        return
      }
      size = info.size
      stamp = info.mtimeMs
    } catch {
      missing()
      return
    }
    const etag = `"${size.toString(16)}-${Math.floor(stamp).toString(16)}"`
    const headers: Record<string, string> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      // What is sealed on disk is not left in a browser's cache either.
      'cache-control': opened !== undefined ? 'no-store' : 'private, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
      etag,
    }
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers)
      response.end()
      return
    }
    let start = 0
    let end = size - 1
    let status = 200
    const range = /^bytes=(\d*)-(\d*)$/.exec(typeof request.headers.range === 'string' ? request.headers.range : '')
    if (range !== null && size > 0 && (range[1] !== '' || range[2] !== '')) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]))
      else {
        start = Number(range[1])
        if (range[2] !== '') end = Math.min(end, Number(range[2]))
      }
      if (start > end || start >= size) {
        response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
        response.end()
        return
      }
      status = 206
      headers['content-range'] = `bytes ${start}-${end}/${size}`
    }
    headers['content-length'] = String(size === 0 ? 0 : end - start + 1)
    response.writeHead(status, headers)
    if (request.method === 'HEAD' || size === 0) {
      response.end()
      return
    }
    if (opened !== undefined) {
      response.end(opened.subarray(start, end + 1))
      return
    }
    const stream = createReadStream(path, { start, end })
    stream.on('error', () => { response.destroy() })
    response.on('close', () => { stream.destroy() })
    stream.pipe(response)
  }

  /** The reader's script, read from beside the Host's own code and re-read when it is rebuilt. */
  /** The reader's own script, as it is served to other devices: what a published site carries with it. */
  async readerScript(): Promise<Buffer | undefined> {
    return (await this.script())?.body
  }

  private async script(): Promise<{ body: Buffer; etag: string } | undefined> {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const candidate of [join(here, 'reader.js'), join(here, '..', 'reader.js'), join(here, '..', '..', 'lib', 'reader.js')]) {
      try {
        const info = await stat(candidate)
        if (this.bundle === undefined || this.bundle.at !== info.mtimeMs) {
          const body = await readFile(candidate)
          this.bundle = { at: info.mtimeMs, body, etag: `"${hashText(`${info.size}:${info.mtimeMs}`)}"` }
        }
        return this.bundle
      } catch {
        // Not here; try the next place.
      }
    }
    return undefined
  }
}

/** Addresses of this machine that another device on the network can reach, the likeliest first. */
export function addresses(): string[] {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue
      found.push(entry.address)
    }
  }
  // Home and office networks first; whatever else the machine has (a VPN, a tether) after.
  const rank = (address: string): number => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3
  found.sort((left, right) => rank(left) - rank(right))
  const name = hostname()
  // The machine's own name keeps working when the router hands out another address.
  if (name.length > 0 && /^[A-Za-z0-9.-]+$/.test(name)) found.push(name.endsWith('.local') || name.includes('.') ? name : `${name}.local`)
  return [...new Set(found)]
}

function deviceName(request: IncomingMessage): string {
  const agent = String(request.headers['user-agent'] ?? '')
  const kind = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Macintosh/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : 'a device'
  const address = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  return address.length > 0 ? `${kind} (${address})` : kind
}

/** The JSON body of a request, within the size the server accepts. */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const data = chunk as Buffer
    size += data.length
    // Too much is read to its end and thrown away, so the connection stays usable for the refusal — unless it is absurdly much.
    if (size > BODY_LIMIT * 16) {
      request.destroy()
      throw new Refused(413, 'too much text in one request')
    }
    if (size <= BODY_LIMIT) chunks.push(data)
  }
  if (size > BODY_LIMIT) throw new Refused(413, 'too much text in one request')
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    throw new Refused(400, 'not JSON')
  }
}

/** The page itself: a frame for the script to draw the reader into. */
function page(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#f6f1e7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16181d" media="(prefers-color-scheme: dark)">
<title>小说工坊 · Novel Studio</title>
<style>html,body{margin:0;height:100%;background:#f6f1e7}@media(prefers-color-scheme:dark){html,body{background:#16181d}}#app{height:100%}</style>
</head>
<body>
<div id="app"></div>
<script src="app.js" defer></script>
</body>
</html>
`
}

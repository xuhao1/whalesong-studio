// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Reading on another device: a small web server of the Studio's own that
 * serves a reader — the chapters, their pictures and their audio drama — to
 * phones and tablets on the same network.
 *
 * It is off until the author switches it on for a book, and it is deliberately
 * not the Harness: it has no way to write, no way to reach a model, a key or a
 * book that was not shared, and its address carries a random token, so "who can
 * read" is "who was given the link". The Harness itself stays on this machine.
 *
 *   GET /<token>/                                   the reader page
 *   GET /<token>/app.js                             its script
 *   GET /<token>/api/books                          the shared books
 *   GET /<token>/api/books/<id>                     one book and its chapters
 *   GET /<token>/api/books/<id>/chapters/<chapter>  text and audio script of a chapter
 *   GET /<token>/media/<id>/assets/…                pictures and audio of a shared book
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NovelCore, ProjectRuntime } from '../core/core'
import type { DeepPartial } from '../core/settings'
import { errorMessage } from '../core/util/async'
import type { ShareStatus } from '../shared/rpc'
import { hashText, proseOnly } from '../shared/text'
import type { AudioScript, NovelSettings, ShareSettings } from '../shared/types'

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

/** A chapter as the reader lists it. */
export interface SharedChapter {
  id: string
  index: number
  title: string
  words: number
  /** Lines of its audio script, and how many of them have a voice. */
  lines: number
  voiced: number
}

export interface SharedBook {
  id: string
  title: string
  author?: string
  language: string
  logline?: string
  cover?: string
  words: number
  chapters: number
}

export class ShareServer {
  private server: Server | undefined
  private port: number | undefined
  /** The port that was asked for, when it was taken and another one is in use instead. */
  private wanted: number | undefined
  private failure: string | undefined
  private token = ''
  private books: string[] = []
  private applying: Promise<void> = Promise.resolve()
  private readonly off: () => void
  private bundle: { at: number; body: Buffer; etag: string } | undefined

  /**
   * @param host - the interface to listen on: every one by default, so other devices can reach it.
   */
  constructor(private readonly core: NovelCore, private readonly log: (message: string, error?: unknown) => void, private readonly host = '0.0.0.0') {
    // Whatever changes the settings — the Studio, the showrunner, another window — the server follows.
    this.off = core.settings.onChange(() => { void this.apply() })
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
    await this.applying.catch(() => {})
    await this.stop()
  }

  async status(): Promise<ShareStatus> {
    await this.applying.catch(() => {})
    const share = (await this.core.settings.get()).share
    const books: ShareStatus['books'] = []
    for (const root of share?.books ?? []) {
      const runtime = await this.core.tryRuntime(root).catch(() => undefined)
      if (runtime === undefined) continue
      const manifest = await runtime.project.manifest()
      books.push({ root, id: manifest.id, title: manifest.title })
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
    const json = (value: unknown): void => { send(200, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' }) }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405, 'method not allowed', { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
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
    if (rest.length === 0) {
      // The page addresses everything relative to itself, so its own address ends in a slash.
      if (!new URL(raw, 'http://reader.invalid').pathname.endsWith('/')) {
        response.writeHead(308, { location: `/${encodeURIComponent(parts[0]!)}/` })
        response.end()
        return
      }
      send(200, page(), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_POLICY })
      return
    }
    if (rest.length === 1 && rest[0] === 'app.js') {
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
    if (rest[0] === 'api' && rest[1] === 'books') {
      if (rest.length === 2) {
        const books: SharedBook[] = []
        for (const runtime of await this.shared()) books.push(await describeBook(runtime))
        json({ books })
        return
      }
      const runtime = await this.book(rest[2]!)
      if (runtime === undefined) {
        missing()
        return
      }
      if (rest.length === 3) {
        json({ book: await describeBook(runtime), chapters: await listChapters(runtime) })
        return
      }
      if (rest.length === 5 && rest[3] === 'chapters') {
        const chapter = await readChapter(runtime, rest[4]!)
        if (chapter === undefined) missing()
        else json(chapter)
        return
      }
      missing()
      return
    }
    if (rest[0] === 'media' && rest.length >= 4 && rest[2] === 'assets') {
      const runtime = await this.book(rest[1]!)
      if (runtime === undefined) {
        missing()
        return
      }
      await this.file(runtime, rest.slice(2), request, response, missing)
      return
    }
    missing()
  }

  private permits(candidate: string): boolean {
    const given = Buffer.from(candidate)
    const real = Buffer.from(this.token)
    return real.length >= 16 && given.length === real.length && timingSafeEqual(given, real)
  }

  /** The shared books that still exist. */
  private async shared(): Promise<ProjectRuntime[]> {
    const found: ProjectRuntime[] = []
    for (const root of this.books) {
      const runtime = await this.core.tryRuntime(root).catch(() => undefined)
      if (runtime !== undefined) found.push(runtime)
    }
    return found
  }

  /** A shared book by its manifest id; a book that is not shared does not exist here. */
  private async book(id: string): Promise<ProjectRuntime | undefined> {
    for (const runtime of await this.shared()) if ((await runtime.project.manifest()).id === id) return runtime
    return undefined
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
    try {
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
      'cache-control': 'private, max-age=0, must-revalidate',
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
    const stream = createReadStream(path, { start, end })
    stream.on('error', () => { response.destroy() })
    response.on('close', () => { stream.destroy() })
    stream.pipe(response)
  }

  /** The reader's script, read from beside the Host's own code and re-read when it is rebuilt. */
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

async function describeBook(runtime: ProjectRuntime): Promise<SharedBook> {
  const { project } = runtime
  const manifest = await project.manifest()
  const chapters = (await project.chapterInfos()).filter(chapter => chapter.hasText)
  const cover = await project.cover()
  return {
    id: manifest.id,
    title: manifest.title,
    ...(manifest.author !== undefined ? { author: manifest.author } : {}),
    language: manifest.language,
    ...(manifest.logline !== undefined ? { logline: manifest.logline } : {}),
    ...(cover !== undefined ? { cover } : {}),
    words: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    chapters: chapters.length,
  }
}

async function listChapters(runtime: ProjectRuntime): Promise<SharedChapter[]> {
  const { project } = runtime
  const chapters: SharedChapter[] = []
  for (const chapter of await project.chapterInfos()) {
    if (!chapter.hasText) continue
    const script = await project.audioScript(chapter.id)
    chapters.push({
      id: chapter.id,
      index: chapter.index,
      title: chapter.title,
      words: chapter.words,
      lines: script?.lines.length ?? 0,
      voiced: script?.lines.filter(line => line.audio !== undefined).length ?? 0,
    })
  }
  return chapters
}

/** A chapter for the reader: its text, and its audio script without anything only the author needs. */
async function readChapter(runtime: ProjectRuntime, id: string): Promise<{ id: string; index: number; title: string; text: string; script?: Pick<AudioScript, 'lines' | 'cues'>; stale: boolean } | undefined> {
  const { project } = runtime
  if (!/^[\w-]{1,80}$/.test(id)) return undefined
  const located = await project.findChapter(id)
  if (located === undefined || located.plan.id !== id) return undefined
  const text = await project.chapterText(id)
  if (text.trim().length === 0) return undefined
  const script = await project.audioScript(id)
  return {
    id,
    index: located.index,
    title: located.plan.title,
    text,
    ...(script !== undefined ? {
      script: {
        lines: script.lines.map(line => ({
          id: line.id,
          kind: line.kind,
          text: line.text,
          ...(line.speakerName !== undefined ? { speakerName: line.speakerName } : {}),
          ...(line.audio !== undefined ? { audio: line.audio } : {}),
          ...(line.duration !== undefined ? { duration: line.duration } : {}),
          ...(line.renderKey !== undefined ? { renderKey: line.renderKey } : {}),
        })),
        cues: script.cues,
      },
    } : {}),
    stale: script !== undefined && script.textHash !== hashText(proseOnly(text)),
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

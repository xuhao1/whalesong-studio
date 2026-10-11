// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Studio worked from a phone: a door on the local network that hands a
 * device on to the page DSH itself serves on this computer.
 *
 * DSH's web page answers on the loopback and refuses whatever does not name
 * it by that address, so a phone cannot simply open it. Until DSH has a way of
 * its own, this stands in between: it listens on the network, lets in whoever
 * was given its link (a random token, kept in a cookie after the first visit),
 * and passes every request on to DSH as the browser of this computer would
 * have sent it — DSH's own address in `Host` and `Origin`, and the sign-in of
 * the browser the author opened the door from. That sign-in never leaves this
 * computer: the device holds the door's token, not DSH's.
 *
 * What comes through the door is all of DSH — conversations, tools, settings —
 * not the Studio alone: the link is to be given to nobody else. It is opened
 * by the author and stays open until they close it. Its link holds for as long
 * as DSH runs and no longer: the token is made anew each time DSH starts, and
 * is kept nowhere but in this process. What is remembered across a restart is
 * only that the author wants the door open (`keep`): the Studio's page of this
 * computer then opens it again — with a new link — once DSH is back, since
 * only that page has the sign-in a door hands on. The Studio's own Host half
 * being replaced while DSH runs (an update taken in with "Restart") changes
 * nothing: an open door is handed to the Host half that comes next, the same
 * link, so that a phone at work is not shut out by every release.
 *
 * Meant to be taken away again once DSH can be reached from a phone by itself.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as sendOn, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RemoteStatus } from '../shared/rpc'
import { errorMessage } from '../core/util/async'
import { readJson, removePath, writeJson } from '../core/util/fs'
import { addresses } from './share'

export const DEFAULT_REMOTE_PORT = 4329
const PORT_TRIES = 20
/** How long a device keeps the door's cookie: the token it holds ends sooner — when DSH is started anew, or the door closed. */
const COOKIE_DAYS = 30
const COOKIE = 'nv-door'
/**
 * Readable by the page, and saying nothing but that it came through the door — the door's port, so that a page of the
 * same host that did not (cookies are kept by host, not by port) is not taken for one that did: the Studio then opens
 * over all of DSH's own frame.
 */
const MARK = 'nv-phone'

/** Where DSH's page is served on this computer, and what the browser that opened the door is signed in with. */
export interface RemoteTarget {
  port: number
  /** The cookies DSH gave that browser (`dsh-auth-…`), as a `Cookie` header's value. */
  cookie: string
}

/** The cookies of a request that are DSH's own sign-in, as a `Cookie` header's value. */
export function signInOf(header: string | null | undefined): string {
  return String(header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('dsh-')).join('; ')
}

/**
 * Where a request reached DSH's web page on the loopback, if it did: its port.
 * @param host - the request's `Host` (DSH hands a route the headers as they came; the desktop app, which has no web
 * server, sends none that names the loopback).
 */
export function loopbackPort(host: string | null | undefined): number | undefined {
  if (host === null || host === undefined || host.length === 0 || /[/@\s]/u.test(host)) return undefined
  try {
    const parsed = new URL(`http://${host}`)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return undefined
    const port = Number(parsed.port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

const same = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookiesOf(request: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

/** What a door open while its Host half is replaced leaves for the next one, in this process's memory alone. */
interface Parked {
  port: number
  token: string
  target: RemoteTarget
  since: number
  /** When it was left: taken up only by a Host half that comes right after. */
  at: number
}
const SLOT = Symbol.for('novel-studio:door-for-a-phone')
/** How long what was left waits to be taken up: a Host half replaced is back within seconds. */
const TAKE_UP_WITHIN = 120_000
const slot = globalThis as unknown as Record<symbol, Parked | undefined>

export class RemoteDoor {
  private server: Server | undefined
  private port: number | undefined
  private token = ''
  private target: RemoteTarget | undefined
  private since: number | undefined
  private failure: string | undefined
  private readonly sockets = new Set<Duplex>()
  private wanted: boolean | undefined

  /**
   * @param host - the interface to listen on: every one, so that a device on the network reaches it.
   * @param note - the small file that remembers the author wants the door open; left out, nothing is remembered.
   */
  constructor(private readonly log: (message: string, error?: unknown) => void, private readonly host = '0.0.0.0', private readonly note?: string) {}

  /**
   * Whether the author left the door to be open: after a restart of DSH it is then opened again, with a new link, by
   * the Studio's page of this computer. Never the link itself — that is not kept.
   */
  async kept(): Promise<boolean> {
    if (this.wanted === undefined) this.wanted = this.note === undefined ? false : (await readJson<{ keep?: unknown }>(this.note).catch(() => undefined))?.keep === true
    return this.wanted
  }

  /** Remember that the door is to be open across restarts of DSH — or, `false`, that it is not. */
  async keep(on: boolean): Promise<void> {
    this.wanted = on
    if (this.note === undefined) return
    if (on) await writeJson(this.note, { keep: true })
    else await removePath(this.note).catch(() => {})
  }

  async status(possible: boolean): Promise<RemoteStatus> {
    const running = this.server !== undefined && this.port !== undefined
    return {
      possible,
      running,
      kept: await this.kept(),
      ...(running ? { port: this.port!, urls: addresses().map(address => `http://${address}:${this.port}/?k=${this.token}`), since: new Date(this.since!).toISOString() } : { urls: [] }),
      ...(this.failure !== undefined ? { error: this.failure } : {}),
    }
  }

  /** Open the door (or, open already, hand on to this target and keep the link). */
  async open(target: RemoteTarget, port = DEFAULT_REMOTE_PORT): Promise<void> {
    this.target = target
    this.failure = undefined
    if (this.server !== undefined) return
    slot[SLOT] = undefined
    await this.listenAs(randomBytes(24).toString('base64url'), port, Date.now())
  }

  /**
   * Close the door as its Host half goes, leaving what the next Host half needs to open it again as it was: the
   * port, the link's token, where it hands on to, and since when it has been open. Kept in memory only.
   */
  async park(): Promise<void> {
    const open = this.server !== undefined && this.port !== undefined && this.target !== undefined && this.since !== undefined
    slot[SLOT] = open ? { port: this.port!, token: this.token, target: this.target!, since: this.since!, at: Date.now() } : undefined
    await this.close()
  }

  /**
   * Take up a door the Host half before this one left open: the same port and link.
   * @returns whether there was one.
   */
  async resume(): Promise<boolean> {
    const left = slot[SLOT]
    slot[SLOT] = undefined
    if (left === undefined || this.server !== undefined) return false
    const now = Date.now()
    if (now - left.at > TAKE_UP_WITHIN) return false
    this.target = left.target
    this.failure = undefined
    // (The same port, or the link the phone holds leads nowhere. The Host half that left it may still be letting
    // go of the port: tried again for a moment.)
    for (let attempt = 0; ; attempt++) {
      try {
        await this.listenAs(left.token, left.port, left.since, 1)
        return true
      } catch (error) {
        if (attempt >= 14 || this.server !== undefined) {
          this.target = undefined
          this.failure = undefined
          this.log('the door for a phone could not be opened again', error)
          return false
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
      }
    }
  }

  private async listenAs(token: string, port: number, since: number, tries = PORT_TRIES): Promise<void> {
    this.token = token
    const server = createServer((request, response) => { this.answer(request, response) })
    server.on('upgrade', (request, socket, head) => { this.upgrade(request, socket, head) })
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => { this.sockets.delete(socket) })
    })
    try {
      this.port = await listen(server, this.host, port, tries)
    } catch (error) {
      this.token = ''
      this.failure = errorMessage(error)
      throw error
    }
    this.server = server
    this.since = since
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    this.target = undefined
    this.token = ''
    this.since = undefined
    if (server === undefined) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }

  /** Whether a request may pass; on its first visit — the link itself — it is given the cookie and sent to the page. */
  private admit(request: IncomingMessage, response?: ServerResponse): boolean {
    if (this.token.length === 0) return false
    const url = new URL(request.url ?? '/', 'http://door')
    const key = url.searchParams.get('k')
    if (key !== null && response !== undefined) {
      if (!same(key, this.token)) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end('This link is no longer good: it is a new one each time DSH is started. Open the Studio on the computer and use the one it shows now.')
        return false
      }
      const life = `Max-Age=${COOKIE_DAYS * 86_400}; Path=/; SameSite=Lax`
      response.writeHead(303, {
        'set-cookie': [`${COOKIE}=${this.token}; HttpOnly; ${life}`, `${MARK}=${this.port ?? 1}; ${life}`],
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        location: '/',
      })
      response.end()
      return false
    }
    const held = cookiesOf(request).get(COOKIE)
    if (held !== undefined && same(held, this.token)) return true
    if (response !== undefined) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end('Open this from the link (or the QR code) the Studio shows.')
    }
    return false
  }

  /** A request's headers as the browser of this computer would have sent them to DSH. */
  private headersFor(request: IncomingMessage): Record<string, string | string[]> {
    const target = this.target!
    const here = `127.0.0.1:${target.port}`
    const out: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || name === 'host' || name === 'cookie' || name.startsWith('x-forwarded') || name === 'forwarded') continue
      out[name] = value
    }
    out.host = here
    if (typeof request.headers.origin === 'string') out.origin = `http://${here}`
    if (typeof request.headers.referer === 'string') {
      try {
        const from = new URL(request.headers.referer)
        out.referer = `http://${here}${from.pathname}${from.search}`
      } catch {
        delete out.referer
      }
    }
    // The device's own cookies, less the door's and less anything that claims to be DSH's sign-in; then the sign-in itself.
    const mine = [...cookiesOf(request)].filter(([name]) => name !== COOKIE && !name.startsWith('dsh-')).map(([name, value]) => `${name}=${value}`)
    const cookie = [...mine, target.cookie].filter(part => part.length > 0).join('; ')
    if (cookie.length > 0) out.cookie = cookie
    return out
  }

  private answer(request: IncomingMessage, response: ServerResponse): void {
    if (!this.admit(request, response) || this.target === undefined) return
    const target = this.target
    const onward = sendOn({ host: '127.0.0.1', port: target.port, method: request.method, path: request.url, headers: this.headersFor(request) }, (answer) => {
      const headers = { ...answer.headers }
      // DSH's sign-in stays on this computer.
      if (headers['set-cookie'] !== undefined) {
        const kept = headers['set-cookie'].filter(cookie => !cookie.trim().startsWith('dsh-'))
        if (kept.length > 0) headers['set-cookie'] = kept
        else delete headers['set-cookie']
      }
      // A redirect to DSH's own address is a redirect to here.
      if (typeof headers.location === 'string') headers.location = headers.location.replace(/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/u, '')
      response.writeHead(answer.statusCode ?? 502, headers)
      answer.pipe(response)
    })
    onward.on('error', (error) => {
      this.log('the door could not reach DSH\'s page', error)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('DSH is not answering on this computer.')
    })
    response.on('close', () => { onward.destroy() })
    request.pipe(onward)
  }

  /** A connection that asks to become something else (a WebSocket): handed on byte for byte once it is let in. */
  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.admit(request) || this.target === undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const onward = connect(this.target.port, '127.0.0.1', () => {
      const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
      for (const [name, value] of Object.entries(this.headersFor(request))) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
      }
      onward.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) onward.write(head)
      socket.pipe(onward)
      onward.pipe(socket)
    })
    const end = (): void => {
      socket.destroy()
      onward.destroy()
    }
    onward.on('error', end)
    socket.on('error', end)
    onward.on('close', end)
    socket.on('close', end)
  }
}

async function listen(server: Server, host: string, from: number, tries = PORT_TRIES): Promise<number> {
  for (let port = from; port < from + tries; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error) }
        server.once('error', failed)
        server.listen(port, host, () => {
          server.off('error', failed)
          resolve()
        })
      })
      const bound = server.address()
      return typeof bound === 'object' && bound !== null ? bound.port : port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(tries === 1 ? `port ${from} is taken` : `no free port between ${from} and ${from + tries - 1}`)
}

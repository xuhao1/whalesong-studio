// SPDX-License-Identifier: LGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loopbackPort, RemoteDoor, signInOf } from '../src/host/remote'

/** Stands where DSH's own page stands: answers only what names it by the loopback and carries its sign-in. */
function standIn(seen: IncomingMessage[]): Server {
  const server = createServer((request, response) => {
    seen.push(request)
    const port = (server.address() as { port: number }).port
    if (request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403).end('not my name')
      return
    }
    if (request.headers.origin !== undefined && request.headers.origin !== `http://127.0.0.1:${port}`) {
      response.writeHead(403).end('another site')
      return
    }
    if (!String(request.headers.cookie ?? '').includes('dsh-auth-x=signed')) {
      response.writeHead(401).end('who are you')
      return
    }
    if (request.url === '/go') {
      response.writeHead(303, { location: `http://127.0.0.1:${port}/there`, 'set-cookie': ['dsh-auth-x=renewed; HttpOnly', 'theme=dark'] }).end()
      return
    }
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => { response.writeHead(200, { 'content-type': 'text/plain' }).end(`${request.method} ${request.url} ${body}`) })
  })
  server.on('upgrade', (request, socket) => {
    seen.push(request)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk) => { socket.write(`echo:${String(chunk)}`) })
  })
  return server
}

describe('the door through which a phone works the Studio', () => {
  let upstream: Server
  let door: RemoteDoor
  let seen: IncomingMessage[]
  let target: number
  const held = new Set<import('node:stream').Duplex>()
  beforeEach(async () => {
    seen = []
    upstream = standIn(seen)
    upstream.on('upgrade', (_request, socket) => { held.add(socket) })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', () => { resolve() }) })
    target = (upstream.address() as { port: number }).port
    door = new RemoteDoor(() => {}, '127.0.0.1')
  })
  afterEach(async () => {
    await door.close()
    for (const socket of held) socket.destroy()
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => { upstream.close(() => { resolve() }) })
  })

  it('reads off a request where DSH is served and what it was signed in with', () => {
    expect(loopbackPort('127.0.0.1:3199')).toBe(3199)
    expect(loopbackPort('localhost:8080')).toBe(8080)
    // The desktop app has no web page to hand on; nor is another machine's address this computer's.
    expect(loopbackPort('')).toBeUndefined()
    expect(loopbackPort(null)).toBeUndefined()
    expect(loopbackPort('dsh.internal')).toBeUndefined()
    expect(loopbackPort('192.168.1.5:3199')).toBeUndefined()
    expect(loopbackPort('127.0.0.1:3199/@evil.example')).toBeUndefined()
    expect(signInOf('theme=dark; dsh-auth-x=signed; nv-door=abc')).toBe('dsh-auth-x=signed')
    expect(signInOf(null)).toBe('')
  })

  it('lets in who has the link, and hands every request on as this computer\'s browser would send it', async () => {
    expect(await door.status(true)).toMatchObject({ possible: true, running: false, urls: [] })
    await door.open({ port: target, cookie: 'dsh-auth-x=signed' }, 0)
    const status = await door.status(true)
    expect(status.running).toBe(true)
    expect(status.urls.length).toBeGreaterThan(0)
    const link = new URL(status.urls[0]!)
    const token = link.searchParams.get('k')!
    expect(token.length).toBeGreaterThanOrEqual(32)
    const base = `http://127.0.0.1:${status.port}`

    // Without the link: nothing, and DSH is not asked.
    expect((await fetch(`${base}/`)).status).toBe(403)
    expect((await fetch(`${base}/?k=wrong`)).status).toBe(403)
    expect(seen).toHaveLength(0)

    // The link itself: the door's cookie, and on to the page. DSH's sign-in is not given out.
    const first = await fetch(`${base}/?k=${token}`, { redirect: 'manual' })
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/')
    const given = first.headers.getSetCookie()
    expect(given.some(cookie => cookie.startsWith('nv-door=') && cookie.includes('HttpOnly'))).toBe(true)
    // The mark the page reads names the door's port: a page of the same host that did not come through is not taken for one that did.
    expect(given.some(cookie => cookie.startsWith(`nv-phone=${status.port};`))).toBe(true)
    expect(given.join(';')).not.toContain('signed')
    const held = `nv-door=${token}; nv-phone=${status.port}`

    // With the cookie: handed on under DSH's own name, with the sign-in of the browser that opened the door.
    const answer = await fetch(`${base}/api/novel/rpc?x=1`, { method: 'POST', body: '{"a":1}', headers: { cookie: `${held}; dsh-auth-x=forged; theme=dark`, origin: base, referer: `${base}/page?y=2`, 'content-type': 'application/json' } })
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('POST /api/novel/rpc?x=1 {"a":1}')
    const got = seen.at(-1)!
    expect(got.headers.host).toBe(`127.0.0.1:${target}`)
    expect(got.headers.origin).toBe(`http://127.0.0.1:${target}`)
    expect(got.headers.referer).toBe(`http://127.0.0.1:${target}/page?y=2`)
    // The door's token does not travel on; what claimed to be DSH's sign-in is replaced by the real one.
    expect(got.headers.cookie).toBe(`nv-phone=${status.port}; theme=dark; dsh-auth-x=signed`)

    // DSH's own cookie stays on this computer, and a redirect to its address is a redirect to the door.
    const moved = await fetch(`${base}/go`, { redirect: 'manual', headers: { cookie: held } })
    expect(moved.status).toBe(303)
    expect(moved.headers.get('location')).toBe('/there')
    expect(moved.headers.getSetCookie()).toEqual(['theme=dark'])

    // A connection that becomes a WebSocket goes through whole — and not without the cookie.
    const upgraded = await new Promise<string>((resolve, reject) => {
      const socket = connect(status.port!, '127.0.0.1', () => {
        socket.write(`GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:${status.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${held}\r\n\r\n`)
      })
      let text = ''
      socket.on('data', (chunk) => {
        text += String(chunk)
        if (text.includes('101') && !text.includes('echo:')) socket.write('ping')
        if (text.includes('echo:ping')) {
          socket.destroy()
          resolve(text)
        }
      })
      socket.on('error', reject)
    })
    expect(upgraded).toContain('101 Switching Protocols')
    expect(seen.at(-1)!.headers.host).toBe(`127.0.0.1:${target}`)
    const refused = await new Promise<string>((resolve, reject) => {
      const socket = connect(status.port!, '127.0.0.1', () => { socket.write('GET /api/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n') })
      let text = ''
      socket.on('data', (chunk) => { text += String(chunk) })
      socket.on('close', () => { resolve(text) })
      socket.on('error', reject)
    })
    expect(refused).toContain('403')

    // Closed: the link is dead, and the next one is another.
    await door.close()
    expect((await door.status(true)).running).toBe(false)
    await expect(fetch(`${base}/`, { headers: { cookie: held } })).rejects.toThrow()
    await door.open({ port: target, cookie: 'dsh-auth-x=signed' }, 0)
    expect(new URL((await door.status(true)).urls[0]!).searchParams.get('k')).not.toBe(token)
  })

  it('is handed to the Host half that comes next when the Studio is restarted: the same link', async () => {
    await door.open({ port: target, cookie: 'dsh-auth-x=signed' }, 0)
    const before = await door.status(true)
    const token = new URL(before.urls[0]!).searchParams.get('k')!
    const held = `nv-door=${token}`
    const base = `http://127.0.0.1:${before.port}`
    expect((await fetch(`${base}/page`, { headers: { cookie: held } })).status).toBe(200)

    // The Host half goes: the door is shut, and what it was is left for the next one.
    await door.park()
    expect((await door.status(true)).running).toBe(false)
    await expect(fetch(`${base}/page`, { headers: { cookie: held } })).rejects.toThrow()

    // The next Host half takes it up: the port, the link and the time it has been open are as they were.
    const next = new RemoteDoor(() => {}, '127.0.0.1')
    try {
      expect(await next.resume()).toBe(true)
      const after = await next.status(true)
      expect([after.running, after.port, after.since]).toEqual([true, before.port, before.since])
      expect(new URL(after.urls[0]!).searchParams.get('k')).toBe(token)
      const through = await fetch(`${base}/page`, { headers: { cookie: held } })
      expect([through.status, await through.text()]).toEqual([200, 'GET /page '])
      expect(seen.at(-1)!.headers.cookie).toBe('dsh-auth-x=signed')
      // Taken up once: a third Host half finds nothing waiting.
      expect(await new RemoteDoor(() => {}, '127.0.0.1').resume()).toBe(false)
    } finally {
      await next.close()
    }

    // A door that was closed leaves nothing; nor does one the author closed after it was left.
    await door.park()
    expect(await new RemoteDoor(() => {}, '127.0.0.1').resume()).toBe(false)
    await door.open({ port: target, cookie: 'dsh-auth-x=signed' }, 0)
    await door.park()
    await door.open({ port: target, cookie: 'dsh-auth-x=signed' }, 0)
    expect(await new RemoteDoor(() => {}, '127.0.0.1').resume()).toBe(false)
  })

  it('stays open until it is closed, and remembers across a restart of DSH only that it is wanted — never its link', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'nv-door-'))
    const note = join(folder, 'phone-door.json')
    const first = new RemoteDoor(() => {}, '127.0.0.1', note)
    let second: RemoteDoor | undefined
    try {
      // Nothing is wanted where nothing was said; a door without a note remembers nothing.
      expect(await first.kept()).toBe(false)
      expect((await door.status(true)).kept).toBe(false)
      await door.keep(true)
      expect(await new RemoteDoor(() => {}, '127.0.0.1').kept()).toBe(false)

      await first.open({ port: target, cookie: 'dsh-auth-x=signed' }, 0)
      await first.keep(true)
      const open = await first.status(true)
      const token = new URL(open.urls[0]!).searchParams.get('k')!
      // It says since when it is open, and no longer when it would close: it does not, by itself.
      expect([open.running, open.kept, typeof open.since, 'until' in open]).toEqual([true, true, 'string', false])
      // What is on disk is the wish alone.
      const written = await readFile(note, 'utf8')
      expect(JSON.parse(written)).toEqual({ keep: true })
      expect(written).not.toContain(token)
      // The cookie a device is given outlives a day: it is the token that ends, with the run of DSH.
      const let_in = await fetch(`http://127.0.0.1:${open.port}/?k=${token}`, { redirect: 'manual' })
      expect(let_in.status).toBe(303)
      expect(let_in.headers.getSetCookie().join('\n')).toMatch(/nv-door=.*Max-Age=2592000/)

      // DSH is stopped and started: nothing of the door is left in the process. The door that comes after knows it
      // is wanted, stands shut until the page of this computer opens it — and its link is another.
      await first.close()
      second = new RemoteDoor(() => {}, '127.0.0.1', note)
      expect(await second.resume()).toBe(false)
      expect(await second.status(true)).toMatchObject({ running: false, kept: true, urls: [] })
      await second.open({ port: target, cookie: 'dsh-auth-x=signed; dsh-run=second' }, 0)
      const again = await second.status(true)
      const fresh = new URL(again.urls[0]!).searchParams.get('k')!
      expect(fresh).not.toBe(token)
      // The old link is refused, and told why; the new one hands on with the sign-in of the page that opened it.
      const stale = await fetch(`http://127.0.0.1:${again.port}/?k=${token}`, { redirect: 'manual' })
      expect([stale.status, await stale.text()]).toEqual([403, expect.stringContaining('each time DSH is started')])
      expect((await fetch(`http://127.0.0.1:${again.port}/page`, { headers: { cookie: `nv-door=${token}` } })).status).toBe(403)
      expect((await fetch(`http://127.0.0.1:${again.port}/page`, { headers: { cookie: `nv-door=${fresh}` } })).status).toBe(200)
      expect(seen.at(-1)!.headers.cookie).toBe('dsh-auth-x=signed; dsh-run=second')

      // Said to be wanted no longer: the note is gone, and a door after the next restart is not opened again.
      await second.keep(false)
      await expect(readFile(note, 'utf8')).rejects.toThrow()
      expect(await new RemoteDoor(() => {}, '127.0.0.1', note).kept()).toBe(false)
    } finally {
      await first.close()
      await second?.close()
      await rm(folder, { recursive: true, force: true })
    }
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Browser-facing routes, registered as exact Fetch routes on the Harness
 * Connection so they inherit its trust fence and browser authentication:
 *
 *   POST /api/novel/rpc     the Studio's RPC contract, in the Connection envelope
 *   GET  /api/novel/media   generated images, audio and exports of a project
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { LlmCallError } from '../core/llm'
import { ProviderError } from '../core/media/http'
import { ProjectError } from '../core/project'
import { errorMessage, isAbort } from '../core/util/async'
import type { RpcEnvelope, RpcMethod } from '../shared/rpc'
import { calling, createHandlers } from './rpc'
import type { NovelService } from './service'

const RPC_ROUTE = '/api/novel/rpc'
const MEDIA_ROUTE = '/api/novel/media'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.epub': 'application/epub+zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'application/x-subrip; charset=utf-8',
}

interface Failure {
  code: string
  message: string
  details: Record<string, unknown>
}

function failureOf(error: unknown, signal: AbortSignal): Failure {
  if (signal.aborted || isAbort(error)) return { code: 'novel/cancelled', message: 'cancelled', details: {} }
  if (error instanceof ProjectError) return { code: error.code, message: error.message, details: {} }
  if (error instanceof ProviderError) return { code: 'novel/provider', message: error.message, details: { ...(error.code !== undefined ? { providerCode: error.code } : {}), ...(error.status !== undefined ? { status: error.status } : {}) } }
  if (error instanceof LlmCallError) return { code: 'novel/model', message: error.message, details: { modelCode: error.code } }
  return { code: 'novel/internal', message: errorMessage(error), details: {} }
}

export function mountRoutes(ctx: Context, service: NovelService): void {
  const handlers = createHandlers(service)

  ctx.connection.fetch.register({
    path: RPC_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      let body: { rpcId?: unknown; payload?: unknown }
      try {
        body = await request.json() as typeof body
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const reply = (result: { ok: true; value: unknown } | { ok: false; error: Failure }): Response => Response.json({ type: 'server-response', rpcId, result })
      const envelope = body.payload as Partial<RpcEnvelope> | undefined
      const method = envelope?.method
      if (typeof method !== 'string') return reply({ ok: false, error: { code: 'novel/bad-request', message: 'missing method', details: {} } })
      if (!Object.hasOwn(handlers, method)) return reply({ ok: false, error: { code: 'novel/unknown-method', message: `unknown method "${method}"`, details: {} } })
      const handler = handlers[method as RpcMethod] as (params: unknown, signal: AbortSignal) => Promise<unknown>
      try {
        const session = typeof envelope?.session === 'string' && envelope.session.length > 0 ? envelope.session : undefined
        const value = await calling.run({ ...(session !== undefined ? { session } : {}), web: { host: request.headers.get('host') ?? '', cookie: request.headers.get('cookie') ?? '' } }, async () => await handler(envelope?.params ?? {}, request.signal))
        return reply({ ok: true, value: value ?? null })
      } catch (error) {
        const failure = failureOf(error, request.signal)
        if (failure.code === 'novel/internal') service.log(`${method} failed`, error)
        return reply({ ok: false, error: failure })
      }
    },
  })

  ctx.connection.fetch.register({
    path: MEDIA_ROUTE,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      // Projects are named by manifest id, so local paths never travel in URLs.
      const project = url.searchParams.get('project')
      const relative = url.searchParams.get('path')
      if (project === null || relative === null) return new Response('project and path are required', { status: 400 })
      // Only generated media and exports are served; manuscripts and memory go through RPC.
      const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalized.startsWith('assets/') && !normalized.startsWith('export/')) return new Response('not found', { status: 404 })
      let path: string
      // A sealed book's files cannot be streamed off the disk: they are opened whole, and served from memory.
      let opened: Buffer | undefined
      let info: { size: number; mtimeMs: number }
      try {
        // A locked book has no files to show: opening it throws, and the answer is the same as for no book at all.
        const runtime = await service.core.runtimeById(project)
        if (runtime === undefined) return new Response('not found', { status: 404 })
        path = runtime.project.path(normalized)
        if (runtime.project.sealed) {
          const known = await runtime.project.fileInfo(normalized)
          if (known === undefined) return new Response('not found', { status: 404 })
          opened = await runtime.project.readFile(normalized)
          info = { size: opened.length, mtimeMs: known.mtime }
        } else {
          const found = await stat(path)
          if (!found.isFile()) return new Response('not found', { status: 404 })
          info = { size: found.size, mtimeMs: found.mtimeMs }
        }
      } catch {
        return new Response('not found', { status: 404 })
      }
      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
      const headers = new Headers({
        'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=0, must-revalidate',
        etag,
      })
      // What was sealed on disk is not left lying in a browser cache either.
      if (opened !== undefined) headers.set('cache-control', 'no-store')
      if (url.searchParams.get('download') === '1') {
        headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.split(/[\\/]/).at(-1) ?? 'file')}`)
      }
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
      let start = 0
      let end = info.size - 1
      let status = 200
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
      if (range !== null && info.size > 0 && (range[1] !== '' || range[2] !== '')) {
        if (range[1] === '') {
          start = Math.max(0, info.size - Number(range[2]))
        } else {
          start = Number(range[1])
          if (range[2] !== '') end = Math.min(end, Number(range[2]))
        }
        if (start > end || start >= info.size) {
          headers.set('content-range', `bytes */${info.size}`)
          return new Response(null, { status: 416, headers })
        }
        status = 206
        headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
      }
      headers.set('content-length', String(info.size === 0 ? 0 : end - start + 1))
      if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers })
      if (opened !== undefined) return new Response(new Uint8Array(opened.subarray(start, end + 1)), { status, headers })
      const stream = createReadStream(path, { start, end })
      // A client that goes away mid-download must not leave the file handle open.
      request.signal.addEventListener('abort', () => { stream.destroy() }, { once: true })
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers })
    },
  })
}

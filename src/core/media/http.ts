// SPDX-License-Identifier: LGPL-3.0-or-later
/** Minimal HTTP helpers for provider calls: bearer auth, timeouts, readable failures. */
import { conventionalEnv, hostOf } from '../../shared/services'
import { anySignal } from '../util/async'

export class ProviderError extends Error {
  /** How long the service asked to be left alone (`Retry-After`), where whoever made the request asked to be told ({@link HttpOptions.heedRetryAfter}). A gate waits that long. */
  retryAfterMs?: number

  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** A `Retry-After` header in milliseconds: so many seconds, or until a date. Undefined where there is none to wait for. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const value = headers.get('retry-after')?.trim()
  if (value === undefined || value.length === 0) return undefined
  const wait = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(wait) && wait > 0 ? Math.round(wait) : undefined
}

/** Finds the secret that opens an endpoint. */
export interface KeySource {
  /** The secret behind an environment-style name: Harness credentials first, then the process environment. */
  named(ref: string): Promise<string | undefined>
  /** The secret saved for the host of an endpoint, else the service's conventional environment variable. */
  forEndpoint(url: string): Promise<string | undefined>
}

/** @deprecated name kept for readers of older code: the resolver is a {@link KeySource}. */
export type CredentialResolver = KeySource

/** A key source that only knows names — the process environment by default. For tests and headless use. */
export function namedKeySource(lookup: (name: string) => string | undefined | Promise<string | undefined> = name => process.env[name]): KeySource {
  const named = async (ref: string): Promise<string | undefined> => {
    const value = await lookup(ref)
    return value !== undefined && value.length > 0 ? value : undefined
  }
  return {
    named,
    async forEndpoint(url) {
      for (const name of conventionalEnv(url)) {
        const value = await named(name)
        if (value !== undefined) return value
      }
      return undefined
    },
  }
}

export interface HttpOptions {
  apiKey?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** Read a refusal's `Retry-After` onto the error ({@link ProviderError.retryAfterMs}): for a server that says how long it is busy. */
  heedRetryAfter?: boolean
}

function requestSignal(options: HttpOptions): AbortSignal | undefined {
  return anySignal(options.signal, AbortSignal.timeout(options.timeoutMs ?? 180_000))
}

/** Strip a trailing slash so `${base}/path` never doubles it. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

/** POST a body and parse the JSON reply. Non-2xx replies become a ProviderError carrying the provider's own message. */
async function post<T>(url: string, body: string | FormData, headers: Record<string, string>, options: HttpOptions): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
      },
      body,
      signal: requestSignal(options) ?? null,
    })
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw new ProviderError(`request to ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const refusal = new ProviderError(`${new URL(url).host} answered ${response.status}: ${providerMessage(parsed) ?? text.slice(0, 300)}`, response.status, providerCode(parsed))
    const wait = options.heedRetryAfter === true ? retryAfterMs(response.headers) : undefined
    if (wait !== undefined) refusal.retryAfterMs = wait
    throw refusal
  }
  if (parsed === undefined) throw new ProviderError(`${new URL(url).host} answered with a non-JSON body`, response.status)
  return parsed as T
}

/** POST JSON and parse the JSON reply. Non-2xx replies become a ProviderError carrying the provider's own message. */
export async function postJson<T>(url: string, body: unknown, options: HttpOptions = {}): Promise<T> {
  return await post<T>(url, JSON.stringify(body), { 'content-type': 'application/json' }, options)
}

/** POST a form with files in it (`multipart/form-data`) and parse the JSON reply; refusals as {@link postJson} has them. */
export async function postForm<T>(url: string, form: FormData, options: HttpOptions = {}): Promise<T> {
  return await post<T>(url, form, {}, options)
}

/** Download bytes from a URL the provider handed back. */
export async function download(url: string, options: HttpOptions = {}): Promise<{ data: Uint8Array; mime: string }> {
  const response = await fetch(url, { signal: requestSignal(options) ?? null })
  if (!response.ok) throw new ProviderError(`download from ${new URL(url).host} failed with ${response.status}`, response.status)
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream',
  }
}

function providerMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  if (typeof record.message === 'string') return record.message
  // FastAPI's way: a sentence, or — for a request it could not read — a list of what is wrong and where.
  const detail = record.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const lines = detail.map((item: unknown) => {
      if (typeof item === 'string') return item
      if (item === null || typeof item !== 'object') return undefined
      const { loc, msg } = item as { loc?: unknown; msg?: unknown }
      if (typeof msg !== 'string') return undefined
      const where = Array.isArray(loc) ? loc.filter(part => part !== 'body').join('.') : ''
      return where.length > 0 ? `${where}: ${msg}` : msg
    }).filter((line): line is string => line !== undefined)
    if (lines.length > 0) return lines.join('; ')
  }
  return undefined
}

function providerCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (typeof record.code === 'string') return record.code
  const error = record.error
  if (error !== null && typeof error === 'object' && typeof (error as Record<string, unknown>).code === 'string') {
    return (error as Record<string, unknown>).code as string
  }
  return undefined
}

/** What a model slot says about its key: an optional name to read it from, and the endpoint it is for. */
export interface KeyRequest {
  /** Environment-style name that overrides the key saved for the endpoint. */
  ref?: string | undefined
  /** The endpoint the key will be sent to. */
  endpoint: string
}

/**
 * The key for an endpoint, where there is one: the named credential when the
 * slot names one, else the key saved for the endpoint's host. For an endpoint
 * that may well take none — a server of the author's own.
 * @throws ProviderError `NO_CREDENTIAL` when the slot names a credential that is not set.
 */
export async function findKey(source: KeySource, request: KeyRequest, what: string): Promise<string | undefined> {
  const ref = request.ref?.trim()
  if (ref !== undefined && ref.length > 0) {
    const named = await source.named(ref)
    if (named !== undefined && named.length > 0) return named
    throw new ProviderError(`${what}: "${ref}" is not set — export it in the environment that starts Harness, or clear the name and paste the key in Novel Studio → Settings`, undefined, 'NO_CREDENTIAL')
  }
  const saved = await source.forEndpoint(request.endpoint)
  return saved !== undefined && saved.length > 0 ? saved : undefined
}

/**
 * Resolve the key for an endpoint: the named credential when the slot names
 * one, else the key saved for the endpoint's host.
 * @throws ProviderError `NO_CREDENTIAL` with guidance when there is none.
 */
export async function requireKey(source: KeySource, request: KeyRequest, what: string): Promise<string> {
  const key = await findKey(source, request, what)
  if (key !== undefined) return key
  throw new ProviderError(`${what}: no API key is saved for ${hostOf(request.endpoint) ?? request.endpoint} — paste it in Novel Studio → Settings`, undefined, 'NO_CREDENTIAL')
}

/** GET JSON with an optional bearer key. Non-2xx replies become a ProviderError. */
export async function getJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}), ...options.headers },
      signal: requestSignal(options) ?? null,
    })
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw new ProviderError(`request to ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    parsed = undefined
  }
  if (!response.ok) throw new ProviderError(`${new URL(url).host} answered ${response.status}: ${providerMessage(parsed) ?? text.slice(0, 300)}`, response.status, providerCode(parsed))
  if (parsed === undefined) throw new ProviderError(`${new URL(url).host} answered with a non-JSON body`, response.status)
  return parsed as T
}

/** POST JSON and take the reply as bytes (speech endpoints answer with raw audio). */
export async function postForBytes(url: string, body: unknown, options: HttpOptions = {}): Promise<{ data: Uint8Array; mime: string; headers: Headers }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}), ...options.headers },
      body: JSON.stringify(body),
      signal: requestSignal(options) ?? null,
    })
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw new ProviderError(`request to ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    throw new ProviderError(`${new URL(url).host} answered ${response.status}: ${providerMessage(parsed) ?? text.slice(0, 300)}`, response.status, providerCode(parsed))
  }
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream',
    headers: response.headers,
  }
}

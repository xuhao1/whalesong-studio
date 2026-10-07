// SPDX-License-Identifier: LGPL-3.0-or-later
/** Minimal HTTP helpers for provider calls: bearer auth, timeouts, readable failures. */
import { conventionalEnv, hostOf } from '../../shared/services'
import { anySignal } from '../util/async'

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'ProviderError'
  }
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
}

function requestSignal(options: HttpOptions): AbortSignal | undefined {
  return anySignal(options.signal, AbortSignal.timeout(options.timeoutMs ?? 180_000))
}

/** Strip a trailing slash so `${base}/path` never doubles it. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

/** POST JSON and parse the JSON reply. Non-2xx replies become a ProviderError carrying the provider's own message. */
export async function postJson<T>(url: string, body: unknown, options: HttpOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
      },
      body: JSON.stringify(body),
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
    throw new ProviderError(`${new URL(url).host} answered ${response.status}: ${providerMessage(parsed) ?? text.slice(0, 300)}`, response.status, providerCode(parsed))
  }
  if (parsed === undefined) throw new ProviderError(`${new URL(url).host} answered with a non-JSON body`, response.status)
  return parsed as T
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
  return typeof record.message === 'string' ? record.message : undefined
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
 * Resolve the key for an endpoint: the named credential when the slot names
 * one, else the key saved for the endpoint's host.
 * @throws ProviderError `NO_CREDENTIAL` with guidance when there is none.
 */
export async function requireKey(source: KeySource, request: KeyRequest, what: string): Promise<string> {
  const ref = request.ref?.trim()
  if (ref !== undefined && ref.length > 0) {
    const named = await source.named(ref)
    if (named !== undefined && named.length > 0) return named
    throw new ProviderError(`${what}: "${ref}" is not set — export it in the environment that starts Harness, or clear the name and paste the key in Novel Studio → Settings`, undefined, 'NO_CREDENTIAL')
  }
  const saved = await source.forEndpoint(request.endpoint)
  if (saved !== undefined && saved.length > 0) return saved
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

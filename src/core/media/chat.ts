// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Text models reached through an endpoint of the Studio's own: any
 * OpenAI-compatible `/chat/completions` (Aliyun Bailian, OpenRouter, OpenAI,
 * DeepSeek, a local server, a company gateway). This is what lets every role
 * name its own endpoint, model and reasoning level without touching the
 * Harness model settings; routes without a `baseURL` keep going through the
 * Harness.
 */
import { DIRECT_EFFORTS, hostOf, serviceOf } from '../../shared/services'
import type { ModelRoute } from '../../shared/types'
import { currentJob } from '../jobs'
import { LlmCallError, type LlmBackend, type LlmRequest, type LlmResponse, type ReasoningInfo } from '../llm'
import { anySignal, errorMessage } from '../util/async'
import { ProviderError, requireKey, trimBase, type KeySource } from './http'
import { contextWindowOf, defaultOutputCap, knownContextWindow, knownMaxOutput } from './discovery'

/** A route that names its own endpoint. */
export function isDirect(route: ModelRoute): route is ModelRoute & { baseURL: string } {
  return route.baseURL !== undefined && route.baseURL.trim().length > 0
}

/** No bytes for this long means the connection is dead, however slow the model is. */
const IDLE_TIMEOUT_MS = 240_000

/** How a reasoning level is spelled for the service behind an endpoint. */
export function reasoningParams(baseURL: string, effort: string | undefined): Record<string, unknown> {
  const level = effort?.trim().toLowerCase()
  if (level === undefined || level.length === 0) return {}
  const off = level === 'off' || level === 'none'
  const service = serviceOf(baseURL)
  if (service === 'bailian') {
    if (off) return { enable_thinking: false }
    const budget: Record<string, number> = { minimal: 512, low: 2048, medium: 8192 }
    return { enable_thinking: true, ...(budget[level] !== undefined ? { thinking_budget: budget[level] } : {}) }
  }
  if (service === 'openrouter') return { reasoning: { effort: off ? 'none' : level } }
  const host = hostOf(baseURL) ?? ''
  // DeepSeek's own API switches thinking on and off instead of grading it.
  if (host.endsWith('deepseek.com')) return { thinking: { type: off ? 'disabled' : 'enabled' } }
  return { reasoning_effort: off ? 'none' : level }
}

interface ChatChunk {
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string | null }[]
  /** Cache hits are reported the OpenAI way (`prompt_tokens_details.cached_tokens`) or the DeepSeek way (`prompt_cache_hit_tokens`). */
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null
  error?: { message?: string; code?: string | number }
}

/** Parameters an endpoint may refuse; each is dropped (or respelled) once and the call retried. */
const OPTIONAL_PARAMS: { name: string; matches: RegExp; drop: (body: Record<string, unknown>) => boolean }[] = [
  {
    name: 'max_tokens',
    matches: /max_tokens/i,
    drop: (body) => {
      if (body.max_tokens === undefined) return false
      body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
      return true
    },
  },
  {
    name: 'temperature',
    matches: /temperature/i,
    drop: (body) => {
      if (body.temperature === undefined) return false
      delete body.temperature
      return true
    },
  },
  {
    name: 'stream_options',
    matches: /stream_options|include_usage/i,
    drop: (body) => {
      if (body.stream_options === undefined) return false
      delete body.stream_options
      return true
    },
  },
  {
    name: 'reasoning',
    matches: /reasoning|thinking/i,
    drop: (body) => {
      const had = ['reasoning', 'reasoning_effort', 'enable_thinking', 'thinking_budget', 'thinking'].filter(key => body[key] !== undefined)
      for (const key of had) delete body[key]
      return had.length > 0
    },
  },
]

function aborted(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** Call `/chat/completions` on a direct route and stream the reply. */
export async function completeDirect(route: ModelRoute & { baseURL: string }, request: LlmRequest, keys: KeySource): Promise<LlmResponse> {
  const base = trimBase(route.baseURL.trim())
  const label = `${hostOf(base) ?? base}/${route.model}`
  let apiKey: string
  try {
    apiKey = await requireKey(keys, { ref: route.apiKeyRef, endpoint: base }, `${route.model}`)
  } catch (error) {
    throw new LlmCallError(errorMessage(error), error instanceof ProviderError ? error.code ?? 'NO_CREDENTIAL' : 'NO_CREDENTIAL', { cause: error })
  }
  const temperature = request.temperature ?? route.temperature
  // The role's own limit, or — where an endpoint's default is known to be small — the model's documented one.
  const maxTokens = request.maxTokens ?? route.maxTokens ?? defaultOutputCap(base, route.model)
  const body: Record<string, unknown> = {
    model: route.model,
    messages: [
      ...(request.system !== undefined && request.system.length > 0 ? [{ role: 'system', content: request.system }] : []),
      // An endpoint that keeps the head of a request keeps it by what the text starts with: the part that stays the same goes first.
      { role: 'user', content: request.stable !== undefined && request.stable.length > 0 ? `${request.stable}\n\n${request.prompt}` : request.prompt },
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...reasoningParams(base, route.reasoningEffort),
  }

  const tried = new Set<string>()
  for (;;) {
    const idle = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { idle.abort(new Error('idle')) }, IDLE_TIMEOUT_MS)
    }
    touch()
    try {
      let response: Response
      try {
        response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${apiKey}`, 'x-title': 'Novel Studio' },
          body: JSON.stringify(body),
          signal: anySignal(request.signal, idle.signal) ?? null,
        })
      } catch (error) {
        if (request.signal?.aborted === true) throw aborted()
        throw new LlmCallError(`${label}: ${idle.signal.aborted ? 'the endpoint did not answer in time' : `could not connect (${errorMessage(error)})`}`, 'NETWORK', { cause: error })
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const message = errorText(text) ?? `HTTP ${response.status}`
        // An endpoint that refuses a parameter gets the call again without it — once per parameter.
        if (response.status === 400 || response.status === 422) {
          const culprit = OPTIONAL_PARAMS.find(param => !tried.has(param.name) && param.matches.test(message))
          if (culprit !== undefined) {
            tried.add(culprit.name)
            if (culprit.drop(body)) continue
          }
        }
        const code = response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL' : response.status === 429 ? 'RATE_LIMIT' : response.status === 404 ? 'UNKNOWN_MODEL' : response.status >= 500 ? 'SERVER' : 'PROVIDER'
        // A busy endpoint may say how long to leave it alone, in seconds.
        const after = Number(response.headers.get('retry-after'))
        throw new LlmCallError(`${label}: ${message}`, code, Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : undefined)
      }
      if (response.body === null) throw new LlmCallError(`${label}: the endpoint answered without a body`, 'PROVIDER')
      return await readStream(response.body, request, label, touch, idle.signal)
    } finally {
      clearTimeout(timer)
    }
  }
}

function errorText(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
    if (typeof parsed.error?.message === 'string') return parsed.error.message
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    // not JSON: fall through to the raw text
  }
  const text = body.trim()
  return text.length > 0 ? text.slice(0, 400) : undefined
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  // Some gateways answer with content parts instead of a string.
  if (Array.isArray(value)) return value.map(part => (typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : '')).join('')
  return ''
}

async function readStream(stream: ReadableStream<Uint8Array>, request: LlmRequest, label: string, touch: () => void, idle: AbortSignal): Promise<LlmResponse> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let thought = 0
  let finish = 'stop'
  let usage: LlmResponse['usage']
  const handle = (line: string): void => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data.length === 0 || data === '[DONE]') return
    let chunk: ChatChunk
    try {
      chunk = JSON.parse(data) as ChatChunk
    } catch {
      return
    }
    if (chunk.error !== undefined) throw new LlmCallError(`${label}: ${chunk.error.message ?? 'the model reported an error'}`, 'PROVIDER')
    const choice = chunk.choices?.[0]
    const reasoning = textOf(choice?.delta?.reasoning_content) || textOf(choice?.delta?.reasoning)
    if (reasoning.length > 0) {
      thought += reasoning.length
      currentJob()?.think(reasoning)
    }
    const delta = textOf(choice?.delta?.content)
    if (delta.length > 0) {
      text += delta
      request.onText?.(delta, text)
    }
    if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason === 'length' ? 'max-tokens' : choice.finish_reason
    if (chunk.usage !== undefined && chunk.usage !== null) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens
      usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0, ...(typeof cached === 'number' && cached > 0 ? { cachedTokens: cached } : {}) }
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      touch()
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
      }
    }
    if (buffer.trim().length > 0) handle(buffer.trim())
  } catch (error) {
    if (error instanceof LlmCallError) throw error
    if (request.signal?.aborted === true) throw aborted()
    throw new LlmCallError(`${label}: ${idle.aborted ? 'the stream went silent' : `the stream broke (${errorMessage(error)})`}`, 'NETWORK', { cause: error })
  } finally {
    reader.cancel().catch(() => {})
  }
  if (request.signal?.aborted === true) throw aborted()
  return { text, finish, ...(usage !== undefined ? { usage } : {}), ...(thought > 0 ? { thought } : {}) }
}

/**
 * One backend for both kinds of routes: direct endpoints are called here,
 * everything else goes to the Harness backend it wraps.
 */
export function createRoutedLlm(harness: LlmBackend, keys: KeySource): LlmBackend {
  return {
    async complete(request) {
      return isDirect(request.route) ? await completeDirect(request.route, request, keys) : await harness.complete(request)
    },
    listModels: () => harness.listModels(),
    defaultRoute: () => harness.defaultRoute(),
    async contextWindow(route) {
      // What the author wrote on the role wins; then what the endpoint or the Harness reports; then what is known of the model family.
      if (route.contextWindow !== undefined && route.contextWindow > 0) return route.contextWindow
      if (!isDirect(route)) return await harness.contextWindow(route)
      return await contextWindowOf(route.baseURL, route.model, keys, route.apiKeyRef) ?? knownContextWindow(route.model)
    },
    async reasoning(route): Promise<ReasoningInfo> {
      if (!isDirect(route)) return await harness.reasoning?.(route) ?? { efforts: [] }
      return { efforts: DIRECT_EFFORTS.map(effort => ({ id: effort.id, name: effort.name[1] })) }
    },
    // Pictures go to a model through DSH's own way of sending them: an endpoint the Studio calls itself is sent words only.
    sees: async route => (isDirect(route) ? false : await harness.sees?.(route)),
    // An endpoint the Studio calls itself has no policy of its own and gets the default one.
    retryPolicy: route => (isDirect(route) ? undefined : harness.retryPolicy?.(route)),
    async outputCap(route) {
      if (route.maxTokens !== undefined && route.maxTokens > 0) return { cap: route.maxTokens, source: 'role' as const }
      if (!isDirect(route)) return await harness.outputCap?.(route) ?? { source: 'model' as const }
      const cap = defaultOutputCap(route.baseURL, route.model)
      const most = knownMaxOutput(route.model)
      return { ...(cap !== undefined ? { cap } : {}), ...(most !== undefined ? { most } : {}), source: 'model' as const }
    },
  }
}

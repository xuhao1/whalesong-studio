// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Text-model access for the pipelines. The core only knows this small
 * interface; the Host half adapts it onto the Harness LLM seam so every model
 * configured in Settings → Models can play any role, and tests plug in a fake.
 */
import type { ModelRoute, NovelSettings, ProjectManifest, TextRole } from '../shared/types'
import { currentJob } from './jobs'
import { errorMessage, isAbort } from './util/async'

export interface LlmRequest {
  route: ModelRoute
  system?: string
  prompt: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** Called with each text delta and the text so far. */
  onText?: (delta: string, total: string) => void
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

export interface LlmResponse {
  text: string
  /** `stop`, `max-tokens`, … */
  finish: string
  usage?: LlmUsage
  /** Characters of reasoning the model showed before its answer — or instead of one. */
  thought?: number
}

export interface ModelDescriptor {
  provider: string
  providerName: string
  id: string
  name: string
  description?: string
}

/** What the pipelines need from a text-model provider. */
export interface LlmBackend {
  complete(request: LlmRequest): Promise<LlmResponse>
  listModels(): Promise<ModelDescriptor[]>
  /** Context window in tokens, when the route declares one. */
  contextWindow(route: ModelRoute): Promise<number | undefined>
  /** The deployment's default conversation model. */
  defaultRoute(): ModelRoute | undefined
  /** Reasoning levels a model accepts (ids are provider-specific); absent when the backend cannot tell. */
  reasoning?(route: ModelRoute): Promise<ReasoningInfo>
  /** Every provider behind this backend, with its models — or the reason it could not list them. */
  catalog?(): Promise<{ providers: ProviderListing[]; models: ModelDescriptor[] }>
  /** How long a reply on this route may run, and who says so. */
  outputCap?(route: ModelRoute): Promise<OutputCap>
  /** The retry policy of the provider behind a route; absent or undefined means {@link DEFAULT_RETRY}. */
  retryPolicy?(route: ModelRoute): RetryPolicy | undefined
}

export interface OutputCap {
  /** Tokens a reply is held to; absent when the endpoint decides and does not say. */
  cap?: number
  /** The most the model can write at all, when its maker documents it. */
  most?: number
  /** `role`: the author's own figure on the role. `model`: the model's or the endpoint's default. */
  source: 'role' | 'model'
}

export interface ProviderListing {
  id: string
  name: string
  models: number
  error?: string
}

export interface ReasoningInfo {
  efforts: { id: string; name: string; description?: string }[]
  defaultEffort?: string
}

export class LlmCallError extends Error {
  /** How long the provider asked to be left alone, when it said. */
  readonly retryAfterMs?: number
  constructor(message: string, readonly code: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LlmCallError'
    if (options?.retryAfterMs !== undefined && Number.isFinite(options.retryAfterMs) && options.retryAfterMs > 0) this.retryAfterMs = options.retryAfterMs
  }
}

/** When a failed call is made again, and how long to wait first. */
export interface RetryPolicy {
  /** Calls after the first; `Infinity` keeps trying until it works or is cancelled. */
  maxRetries: number
  /** Failure codes worth another try; `all` for every failure of the provider's. */
  codes: readonly string[] | 'all'
  initialDelayMs: number
  maxDelayMs: number
  /** Each wait is scaled by a random factor in 1 ± this. */
  jitterRatio: number
}

/**
 * The Harness's own defaults for a provider, used for endpoints the Studio
 * calls itself. `NETWORK` is what those report for a connection that broke.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 5,
  codes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'NETWORK'],
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
}

/** A reply that came back whole and empty cost a full call; it is asked for again a few times, not for as long as a dropped connection is. */
const SILENT_RETRIES = 3

/** Failures no amount of asking again mends, whatever a provider's policy says. */
const NEVER_RETRY = new Set(['TRUNCATED', 'FILTERED', 'NO_MODEL', 'NO_CREDENTIAL', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'UNKNOWN_MODEL', 'BAD_JSON'])

/** The language to speak to whoever reads a job's label or its failure: the one the request itself is written in. */
const inChinese = (request: LlmRequest): boolean => /[一-鿿]/.test(`${request.system ?? ''}${request.prompt}`.slice(0, 4000))

/** A reply without a word in it, as the failure it is. */
function silence(request: LlmRequest, response: LlmResponse): LlmCallError {
  const zh = inChinese(request)
  const model = request.route.model
  if (response.finish === 'max-tokens') {
    const limit = request.maxTokens ?? request.route.maxTokens
    return new LlmCallError(
      zh
        ? `${model} 把输出上限${limit !== undefined ? `（${limit} tokens）` : ''}全部用在了思考上，一个字的回答都没写出来。请在「小说工坊 → 设置」里调高或清空这个角色的“最大输出 tokens”，或者把它的思考强度调低。`
        : `${model} spent its whole output allowance${limit !== undefined ? ` of ${limit} tokens` : ''} on reasoning and wrote no answer — raise or clear "max output tokens" for this role in Novel Studio → Settings, or lower its reasoning effort`,
      'TRUNCATED',
    )
  }
  if (response.finish === 'content_filter') {
    return new LlmCallError(
      zh
        ? `${model} 的服务方内容审核拦下了这次回复，没有返回任何内容。可以调整要求后重试，或换一个模型。`
        : `the provider's content filter stopped ${model}'s reply before it said anything — adjust what is asked and try again, or pick another model`,
      'FILTERED',
    )
  }
  const thought = response.thought ?? 0
  return new LlmCallError(
    zh
      ? `${model} 这次请求正常结束，却没有返回任何回答${thought > 0 ? `（只有 ${thought} 字的思考）` : ''}`
      : `${model} completed the request without an answer${thought > 0 ? ` (only ${thought} characters of reasoning)` : ''}`,
    'EMPTY_RESPONSE',
  )
}

function waitLabel(zh: boolean, code: string, retry: number, delayMs: number): string {
  const seconds = Math.max(1, Math.round(delayMs / 1000))
  const wait = delayMs >= 1000 ? (zh ? `${seconds} 秒后` : ` in ${seconds}s`) : ''
  const why = code === 'EMPTY_RESPONSE' ? (zh ? '模型没有返回回答' : 'the model returned no answer')
    : code === 'RATE_LIMIT' ? (zh ? '模型服务限流' : 'the provider is rate-limiting')
      : code === 'SERVER' ? (zh ? '模型服务繁忙' : 'the provider is busy')
        : (zh ? '与模型服务的连接中断' : 'the connection to the provider broke')
  return zh ? `${why}，${wait}重试（第 ${retry} 次）` : `${why} — trying again${wait} (${retry})`
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Make a failed call again when the failure is the kind that passes.
 *
 * The Harness gives its agent exactly this — a provider's retry policy, run on
 * the agent loop — and gives it to nobody else: a plugin that calls a model
 * directly gets the first failure as the final one. So a busy server, a rate
 * limit or a dropped stream used to fail a whole chapter. This runs the same
 * policy for every call the Studio makes.
 *
 * One more failure is treated the way the Harness treats a response with no
 * content: a reply that completes with reasoning in it and not a word of
 * answer. Providers do that now and then; the adapters only catch the case of
 * nothing at all. Nothing came of the call, so it is safe to make again —
 * unchanged — and whoever watches the job reads that it is being made again.
 * @throws LlmCallError — the last failure, with how often it was tried.
 */
export function retrying(backend: LlmBackend, random: () => number = Math.random): LlmBackend {
  return {
    ...backend,
    listModels: backend.listModels.bind(backend),
    contextWindow: backend.contextWindow.bind(backend),
    defaultRoute: backend.defaultRoute.bind(backend),
    ...(backend.reasoning !== undefined ? { reasoning: backend.reasoning.bind(backend) } : {}),
    ...(backend.catalog !== undefined ? { catalog: backend.catalog.bind(backend) } : {}),
    ...(backend.outputCap !== undefined ? { outputCap: backend.outputCap.bind(backend) } : {}),
    ...(backend.retryPolicy !== undefined ? { retryPolicy: backend.retryPolicy.bind(backend) } : {}),
    async complete(request) {
      const zh = inChinese(request)
      const policy = backend.retryPolicy?.(request.route) ?? DEFAULT_RETRY
      for (let retry = 0; ; retry++) {
        let failure: LlmCallError
        try {
          const response = await backend.complete(request)
          if (response.text.trim().length > 0) return response
          failure = silence(request, response)
        } catch (error) {
          if (isAbort(error) || request.signal?.aborted === true || !(error instanceof LlmCallError)) throw error
          failure = error
        }
        const silent = failure.code === 'EMPTY_RESPONSE'
        const most = silent ? Math.min(policy.maxRetries, SILENT_RETRIES) : policy.maxRetries
        const worth = !NEVER_RETRY.has(failure.code) && (policy.codes === 'all' || policy.codes.includes(failure.code))
        // A provider that asks for longer than the policy waits is not asked again by a bounded policy.
        const asked = failure.retryAfterMs
        const patient = asked === undefined || asked <= policy.maxDelayMs || !Number.isFinite(policy.maxRetries)
        if (!worth || !patient || retry >= most) {
          if (retry === 0) throw failure
          throw new LlmCallError(
            zh
              ? `${failure.message}——已重试 ${retry} 次，仍然如此。${silent ? '可以再试一次；如果反复出现，请在「小说工坊 → 设置」里把这个角色的思考强度调低，或换一个模型。模型想了什么，可以在这条任务的“思考”里看到。' : '请稍后再试。'}`
              : `${failure.message} — tried ${retry + 1} times.${silent ? ' Try again; if it keeps happening, lower this role\'s reasoning effort in Novel Studio → Settings, or pick another model.' : ' Try again later.'}`,
            failure.code,
            { cause: failure },
          )
        }
        const local = Math.min(Math.min(policy.initialDelayMs * 2 ** Math.min(retry, 30), policy.maxDelayMs) * (1 - policy.jitterRatio + 2 * policy.jitterRatio * random()), policy.maxDelayMs)
        const delay = asked !== undefined && asked <= policy.maxDelayMs ? asked : local
        const restore = currentJob()?.note(waitLabel(zh, failure.code, retry + 1, delay))
        await pause(delay, request.signal)
        // The label stays through the wait; the attempt that follows speaks for itself.
        restore?.()
        if (request.signal?.aborted === true) {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
      }
    },
  }
}

/** Sensible sampling temperature per role when the route sets none. */
const ROLE_TEMPERATURE: Record<TextRole, number> = {
  writer: 0.85,
  analyst: 0.2,
  architect: 0.8,
  director: 0.9,
}

/** Which other role's model stands in when a role has none configured. */
const ROLE_FALLBACK: Record<TextRole, TextRole[]> = {
  writer: [],
  analyst: [],
  architect: ['writer'],
  director: ['writer', 'analyst'],
}

export interface RouteContext {
  manifest?: ProjectManifest
  /** Model of the agent that started the task; used before the deployment default. */
  agentRoute?: ModelRoute
}

/**
 * Pick the model for a role: project override → user setting → the calling
 * agent's own model → the deployment default.
 * @throws LlmCallError `NO_MODEL` when nothing is configured anywhere.
 */
export function resolveRoute(role: TextRole, settings: NovelSettings, backend: LlmBackend, context: RouteContext = {}): ModelRoute {
  const pick = (candidate: TextRole): ModelRoute | undefined => {
    const route = context.manifest?.models?.[candidate] ?? settings.models[candidate]
    return route !== undefined && route.provider.length > 0 && route.model.length > 0 ? route : undefined
  }
  const configured = pick(role) ?? ROLE_FALLBACK[role].map(pick).find(route => route !== undefined)
  const route = configured ?? context.agentRoute ?? backend.defaultRoute()
  if (route === undefined) {
    throw new LlmCallError(`no model is configured for the "${role}" role; choose one in Novel Studio → Settings`, 'NO_MODEL')
  }
  return { ...route, temperature: route.temperature ?? ROLE_TEMPERATURE[role] }
}

/**
 * Pull the first JSON value out of a model reply: tolerates code fences, prose
 * around the value, trailing commas and a reply cut off by the token limit.
 * @throws when no JSON value can be recovered.
 */
export function extractJson<T = unknown>(reply: string): T {
  const text = reply.replace(/^﻿/, '').trim()
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text].filter((value): value is string => value !== undefined)
  for (const candidate of candidates) {
    const start = candidate.search(/[{[]/)
    if (start < 0) continue
    const body = candidate.slice(start)
    for (const attempt of [body, sliceBalanced(body), repairJson(body)]) {
      if (attempt === undefined) continue
      try {
        return JSON.parse(attempt) as T
      } catch {
        // try the next recovery
      }
      try {
        return JSON.parse(attempt.replace(/,\s*([}\]])/g, '$1')) as T
      } catch {
        // try the next recovery
      }
    }
  }
  throw new Error('the model reply contains no parseable JSON')
}

/** The shortest prefix that closes its opening bracket, ignoring brackets inside strings. */
function sliceBalanced(text: string): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      depth--
      if (depth === 0) return text.slice(0, i + 1)
    }
  }
  return undefined
}

/** Close whatever a truncated reply left open so the complete part can still be used. */
function repairJson(text: string): string | undefined {
  const stack: string[] = []
  let inString = false
  let escaped = false
  let lastSafe = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      stack.pop()
      lastSafe = i + 1
      if (stack.length === 0) return text.slice(0, lastSafe)
    } else if (char === ',') lastSafe = i
  }
  if (stack.length === 0) return undefined
  // Drop the dangling member after the last complete one, then close every open container.
  let head = text.slice(0, lastSafe).replace(/,\s*$/, '')
  const reopen: string[] = []
  let string = false
  let esc = false
  for (const char of head) {
    if (string) {
      if (esc) esc = false
      else if (char === '\\') esc = true
      else if (char === '"') string = false
      continue
    }
    if (char === '"') string = true
    else if (char === '{') reopen.push('}')
    else if (char === '[') reopen.push(']')
    else if (char === '}' || char === ']') reopen.pop()
  }
  if (string) head += '"'
  return head + reopen.reverse().join('')
}

export interface JsonRequest<T> extends LlmRequest {
  /** Return the value when it has the expected shape, or throw with what is wrong. */
  validate?: (value: unknown) => T
  /** Extra attempts after an unparseable or invalid reply. */
  retries?: number
}

/**
 * Ask for a JSON reply and parse it. On an unparseable or invalid reply the
 * model gets one more turn with the problem spelled out.
 *
 * A reply cut off at the output limit is refused, not repaired into something
 * that parses: what is missing from the end of it would go unnoticed, and
 * asking again under the same limit only cuts it off again.
 * @throws LlmCallError `TRUNCATED` or `BAD_JSON`.
 */
export async function completeJson<T>(backend: LlmBackend, request: JsonRequest<T>): Promise<{ value: T; response: LlmResponse }> {
  const retries = request.retries ?? 1
  let prompt = request.prompt
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await backend.complete({ ...request, prompt })
    if (response.finish === 'max-tokens') {
      const limit = request.maxTokens ?? request.route.maxTokens
      throw new LlmCallError(
        limit !== undefined
          ? `the reply was cut off at the output limit of ${limit} tokens before it was complete — clear or raise "max output tokens" for this role in Novel Studio → Settings (a model that reasons spends its reasoning out of the same allowance)`
          : 'the reply was cut off at the model\'s own output limit before it was complete',
        'TRUNCATED',
      )
    }
    try {
      const parsed = extractJson(response.text)
      const value = request.validate === undefined ? parsed as T : request.validate(parsed)
      return { value, response }
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = error
      prompt = `${request.prompt}\n\n---\nYour previous reply could not be used: ${errorMessage(error)}\nReply again with ONLY the JSON value, complete and valid, no commentary and no code fence.`
    }
  }
  throw new LlmCallError(`the model did not return usable JSON: ${errorMessage(lastError)}`, 'BAD_JSON', { cause: lastError })
}

/** Coerce an unknown into a trimmed string, or undefined when it carries no text. */
export function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    const joined = value.map(item => asText(item)).filter((item): item is string => item !== undefined).join('；')
    return joined.length > 0 ? joined : undefined
  }
  return undefined
}

/** Coerce an unknown into a list of non-empty strings. */
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => asText(item)).filter((item): item is string => item !== undefined)
  const single = asText(value)
  if (single === undefined) return []
  return single.split(/[\n;；]+/).map(item => item.replace(/^[-*\d.、\s]+/, '').trim()).filter(item => item.length > 0)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

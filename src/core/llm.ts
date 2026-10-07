// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Text-model access for the pipelines. The core only knows this small
 * interface; the Host half adapts it onto the Harness LLM seam so every model
 * configured in Settings → Models can play any role, and tests plug in a fake.
 */
import type { ModelRoute, NovelSettings, ProjectManifest, TextRole } from '../shared/types'
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
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmCallError'
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

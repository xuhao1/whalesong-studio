// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Asking an endpoint what it serves, so a model can be picked instead of typed.
 * Every answer is a suggestion: the settings accept any model id.
 */
import { imageLimitsOf, type ImageLimits } from '../../shared/images'
import { compatibleBase, hostOf, originOf, serviceOf } from '../../shared/services'
import { getJson, trimBase, type KeySource } from './http'
import { knownOutput, knownWindow } from '../../shared/recommended'

export type ModelKind = 'text' | 'embedding' | 'image' | 'speech'

export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  /** Voices a speech model accepts, when the endpoint lists them. */
  voices?: string[]
  /** What an image model's pictures are held to — their size, the length of a prompt — when the endpoint says. */
  image?: ImageLimits
}

interface ModelRow {
  id?: unknown
  name?: unknown
  context_length?: unknown
  supported_voices?: unknown
  architecture?: { output_modalities?: unknown }
}

/** Model ids that are clearly not chat models, by the usual naming. */
const NOT_TEXT = /embed|rerank|image|wan\d|flux|seedream|dall-e|tts|speech|voice|asr|whisper|transcri|realtime|livetranslate|ocr|moderation|sora|video|audio/i
/** Models that hear rather than speak. */
const NOT_SPEECH = /asr|transcri|whisper|livetranslate|s2s/i
const BY_KIND: Record<Exclude<ModelKind, 'text'>, RegExp> = {
  embedding: /embed/i,
  image: /image|wan\d|flux|seedream|dall-e|imagen|recraft/i,
  speech: /tts|speech|audio|voice|omni.*realtime/i,
}

/** The `/models`-bearing root of whatever URL a slot holds (an origin, a `/v1` base, a realtime URL). */
export function modelsBase(url: string): string {
  const service = serviceOf(url)
  if (service === 'custom') return trimBase(url.trim().replace(/^ws/, 'http'))
  return compatibleBase(service, originOf(url))
}

function rowsOf(reply: unknown): ModelRow[] {
  if (reply !== null && typeof reply === 'object') {
    const data = (reply as { data?: unknown; models?: unknown }).data ?? (reply as { models?: unknown }).models
    if (Array.isArray(data)) return data as ModelRow[]
  }
  return Array.isArray(reply) ? reply as ModelRow[] : []
}

function describe(row: ModelRow): DiscoveredModel | undefined {
  if (typeof row.id !== 'string' || row.id.length === 0) return undefined
  const voices = Array.isArray(row.supported_voices) ? row.supported_voices.filter((voice): voice is string => typeof voice === 'string') : []
  return {
    id: row.id,
    ...(typeof row.name === 'string' && row.name.length > 0 && row.name !== row.id ? { name: row.name } : {}),
    ...(typeof row.context_length === 'number' && row.context_length > 0 ? { contextWindow: row.context_length } : {}),
    ...(voices.length > 0 ? { voices } : {}),
  }
}

/**
 * List the models of an endpoint that fit a slot.
 * @throws ProviderError when the endpoint refuses or cannot be reached.
 */
export async function listEndpointModels(url: string, kind: ModelKind, apiKey: string | undefined, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  const base = modelsBase(url)
  const options = { ...(apiKey !== undefined ? { apiKey } : {}), ...(signal !== undefined ? { signal } : {}), timeoutMs: 30_000 }
  let rows: ModelRow[]
  if (serviceOf(url) === 'openrouter') {
    // OpenRouter files models by what they produce; the ones its images endpoint draws with have a listing of their own.
    const path = kind === 'embedding' ? '/embeddings/models' : kind === 'image' ? '/images/models' : kind === 'speech' ? '/models?output_modalities=speech' : '/models'
    rows = rowsOf(await getJson<unknown>(`${base}${path}`, options))
    if (kind === 'text') rows = rows.filter(row => !Array.isArray(row.architecture?.output_modalities) || row.architecture.output_modalities.includes('text'))
  } else {
    rows = rowsOf(await getJson<unknown>(`${base}/models`, options))
    rows = rows.filter(row => typeof row.id === 'string' && (kind === 'text' ? !NOT_TEXT.test(row.id) : BY_KIND[kind].test(row.id) && !(kind === 'speech' && NOT_SPEECH.test(row.id))))
  }
  const models = rows.map((row) => {
    const model = describe(row)
    const limits = kind === 'image' && model !== undefined ? imageLimitsOf(row) : undefined
    return model !== undefined && limits !== undefined ? { ...model, image: limits } : model
  }).filter((model): model is DiscoveredModel => model !== undefined)
  return models.sort((left, right) => left.id.localeCompare(right.id))
}

const windows = new Map<string, { at: number; byId: Promise<Map<string, number>> }>()

/**
 * Context window of a model on a direct endpoint, when the endpoint publishes
 * it (OpenRouter does). Unknown is fine: the packer then plans by its budget.
 */
export async function contextWindowOf(baseURL: string, model: string, keys: KeySource, ref?: string): Promise<number | undefined> {
  if (serviceOf(baseURL) !== 'openrouter') return undefined
  const host = hostOf(baseURL) ?? baseURL
  const cached = windows.get(host)
  if (cached === undefined || Date.now() - cached.at > 30 * 60_000) {
    const byId = (async () => {
      const apiKey = ref !== undefined && ref.length > 0 ? await keys.named(ref) : await keys.forEndpoint(baseURL)
      const models = await listEndpointModels(baseURL, 'text', apiKey)
      return new Map(models.filter(entry => entry.contextWindow !== undefined).map(entry => [entry.id, entry.contextWindow!]))
    })()
    // A failed lookup must not be remembered as "no model has a window".
    byId.catch(() => { windows.delete(host) })
    windows.set(host, { at: Date.now(), byId })
  }
  try {
    return (await windows.get(host)!.byId).get(model)
  } catch {
    return undefined
  }
}

/**
 * The context window of a model family, for an endpoint that does not publish
 * one. A convenience that ages — so it is not written here: it comes from the
 * recommendations that ship with the plugin (`recommended.json`). The author's
 * own figure on a role, and whatever an endpoint reports, both come first.
 */
export function knownContextWindow(model: string): number | undefined {
  return knownWindow(model)
}

/**
 * The most a model writes in one reply, where its maker documents it — from
 * the recommendations too. The Studio sets no ceiling of its own: a model that
 * reasons spends its reasoning out of the same allowance, and a ceiling sized
 * for the answer alone cuts the answer off. The figure only serves endpoints
 * whose default is small when the request names none (DeepSeek's own API: 8K
 * with thinking off, where the models write up to 384K).
 */
export function knownMaxOutput(model: string): number | undefined {
  return knownOutput(model)
}

/**
 * What a direct endpoint is asked for when the role sets no limit: nothing
 * (the endpoint's own default) unless its default is known to be small. Held
 * to a quarter of the window, so a full context and a full reply fit together.
 */
export function defaultOutputCap(baseURL: string, model: string): number | undefined {
  if (!(hostOf(baseURL) ?? '').endsWith('deepseek.com')) return undefined
  const most = knownMaxOutput(model)
  if (most === undefined) return undefined
  return Math.min(most, Math.floor((knownContextWindow(model) ?? 1_000_000) / 4))
}

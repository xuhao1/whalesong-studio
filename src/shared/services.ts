// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The model services the Studio knows by name, and what each one is good for.
 *
 * Everything here is a starting point, never a restriction: every model slot —
 * the four text roles, embeddings, images, speech — can point at any endpoint
 * and any model id. The catalog only supplies the defaults a one-click setup
 * fills in and the suggestions shown next to free-form fields.
 *
 * Shared by the Host (which applies a setup) and the Studio (which previews it).
 */
import type { EmbeddingSettings, ImageSettings, ModelRoute, TextRole, TtsProviderKind, TtsSettings } from './types'
import { recommended, type RecommendedSlot } from './recommended'

export type ServiceId = 'bailian' | 'openrouter' | 'openai' | 'custom'

export interface ServiceInfo {
  id: ServiceId
  name: [zh: string, en: string]
  /** Default origin of the service; a private or regional endpoint may replace it. */
  origin: string
  /** Where a key is created. */
  keyUrl?: string
  /** Environment variables that conventionally hold this service's key. */
  env: string[]
}

export const SERVICES: Record<ServiceId, ServiceInfo> = {
  bailian: {
    id: 'bailian',
    name: ['阿里云百炼', 'Aliyun Bailian'],
    origin: 'https://dashscope.aliyuncs.com',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    env: ['DASHSCOPE_API_KEY'],
  },
  openrouter: {
    id: 'openrouter',
    name: ['OpenRouter', 'OpenRouter'],
    origin: 'https://openrouter.ai',
    keyUrl: 'https://openrouter.ai/settings/keys',
    env: ['OPENROUTER_API_KEY'],
  },
  openai: {
    id: 'openai',
    name: ['OpenAI', 'OpenAI'],
    origin: 'https://api.openai.com',
    keyUrl: 'https://platform.openai.com/api-keys',
    env: ['OPENAI_API_KEY'],
  },
  custom: {
    id: 'custom',
    name: ['自定义接口', 'Custom endpoint'],
    origin: '',
    env: [],
  },
}

/** `https://host[:port]` of any URL the user may paste (http, https, ws, wss, with or without a path). */
export function originOf(url: string | undefined): string | undefined {
  const text = url?.trim()
  if (text === undefined || text.length === 0) return undefined
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    const protocol = parsed.protocol === 'ws:' || parsed.protocol === 'http:' ? 'http:' : 'https:'
    return parsed.host.length > 0 ? `${protocol}//${parsed.host}` : undefined
  } catch {
    return undefined
  }
}

/** Lower-case host (with port) of a URL, or undefined when it is not one. */
export function hostOf(url: string | undefined): string | undefined {
  const origin = originOf(url)
  return origin !== undefined ? origin.replace(/^https?:\/\//, '').toLowerCase() : undefined
}

/**
 * Where the key of an endpoint is kept: one slot per host, so every model slot
 * that talks to the same service shares a key that was entered once, and a key
 * is never sent to a host it was not entered for.
 */
export function keySlot(url: string | undefined): string | undefined {
  const host = hostOf(url)
  if (host === undefined) return undefined
  const slug = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72)
  return slug.length > 0 ? `key-${slug}` : undefined
}

/**
 * Whether an address is on this machine or on a network of the author's own
 * rather than out on the net: loopback, the private ranges, the range a VPN of
 * the Tailscale kind hands out (100.64/10), link-local, and names only a local
 * network resolves.
 */
export function privateAddress(url: string | undefined): boolean {
  const host = hostOf(url)
  if (host === undefined) return false
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  }
  if (name.includes(':')) return name === '::1' || /^f[cd]/.test(name) || /^fe[89ab]/.test(name)
  return name === 'localhost' || !name.includes('.') || /\.(localhost|local|lan|internal|home\.arpa|ts\.net)$/.test(name)
}

/** Which known service an endpoint belongs to, judged by its host. */
export function serviceOf(url: string | undefined): ServiceId {
  const host = hostOf(url)
  if (host === undefined) return 'custom'
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter'
  if (host === 'api.openai.com') return 'openai'
  if (host.endsWith('aliyuncs.com')) return 'bailian'
  return 'custom'
}

/** Environment variables that conventionally hold the key for an endpoint. */
export function conventionalEnv(url: string | undefined): string[] {
  return SERVICES[serviceOf(url)].env
}

// ───────────────────────────── endpoints per service ─────────────────────────────

/** OpenAI-compatible root (`…/v1`) of a service for chat completions, embeddings, images and speech. */
export function compatibleBase(service: ServiceId, origin?: string): string {
  const base = (originOf(origin) ?? SERVICES[service].origin).replace(/\/+$/, '')
  if (service === 'bailian') return `${base}/compatible-mode/v1`
  if (service === 'openrouter') return `${base}/api/v1`
  if (service === 'openai') return `${base}/v1`
  // A custom endpoint is taken as written: its path is part of what the user configured.
  return (origin ?? '').trim().replace(/\/+$/, '')
}

/** WebSocket URL of Bailian's realtime models on a given origin. */
export function bailianRealtime(origin?: string): string {
  const base = originOf(origin) ?? SERVICES.bailian.origin
  return `${base.replace(/^http/, 'ws')}/api-ws/v1/realtime`
}

// ───────────────────────────── reasoning levels of direct endpoints ─────────────────────────────

export interface EffortOption {
  id: string
  name: [zh: string, en: string]
}

/**
 * Reasoning levels offered for a model reached through an endpoint of our own.
 * The wire spelling differs per service; `off` is always "do not think".
 */
export const DIRECT_EFFORTS: EffortOption[] = [
  { id: 'off', name: ['关闭思考', 'Off'] },
  { id: 'minimal', name: ['极少', 'Minimal'] },
  { id: 'low', name: ['低', 'Low'] },
  { id: 'medium', name: ['中', 'Medium'] },
  { id: 'high', name: ['高', 'High'] },
  { id: 'xhigh', name: ['极高', 'Extra high'] },
]

// ───────────────────────────── recommended setups ─────────────────────────────

/**
 * What a one-click setup fills: the models that are the Studio's own to
 * configure. Text models are not among them — every text role runs on a model
 * of DSH's (Settings → Models there), which is also what lets a role work as an
 * agent.
 */
export type SetupPart = 'embedding' | 'image' | 'tts'

export interface ServiceSetup {
  embedding: EmbeddingSettings
  image: ImageSettings
  tts: TtsSettings
  /** Models worth offering next to the free-form model field, best first. */
  suggestions: { embedding: string[]; image: string[]; tts: string[] }
}

/**
 * What a one-click setup configures for a service. `origin` replaces the
 * service's public endpoint (a Bailian workspace domain, a proxy).
 * @returns undefined for services without a recommended setup.
 */
export function recommendedSetup(service: ServiceId, origin?: string): ServiceSetup | undefined {
  // Which models: the recommendations in force (`recommended.json`). Where they are reached: the service's own addresses.
  const slots = recommended().services[service]
  if (service === 'custom' || slots?.embedding === undefined || slots.image === undefined || slots.tts === undefined) return undefined
  // Bailian's own API takes the bare domain; everything that speaks OpenAI's dialect takes the compatible base.
  const root = service === 'bailian' ? originOf(origin) ?? SERVICES.bailian.origin : undefined
  const base = service === 'bailian' ? compatibleBase('bailian', root) : compatibleBase(service, origin)
  const at = (slot: RecommendedSlot): string => (slot.provider === 'dashscope' || slot.provider === 'qwen-audiogen' || slot.provider === 'qwen-tts' || slot.provider === 'cosyvoice' ? root ?? base : base)
  return {
    embedding: { provider: slots.embedding.provider as EmbeddingSettings['provider'], baseURL: at(slots.embedding), model: slots.embedding.model },
    image: { provider: slots.image.provider as ImageSettings['provider'], baseURL: at(slots.image), model: slots.image.model, ...(slots.image.size !== undefined ? { size: slots.image.size } : {}) },
    tts: { provider: slots.tts.provider as TtsSettings['provider'], baseURL: at(slots.tts), model: slots.tts.model, ...(slots.tts.narratorVoice !== undefined ? { narratorVoice: slots.tts.narratorVoice } : {}) },
    suggestions: {
      embedding: slots.embedding.suggestions ?? [slots.embedding.model],
      image: slots.image.suggestions ?? [slots.image.model],
      tts: slots.tts.suggestions ?? [slots.tts.model],
    },
  }
}

/** Pick the parts of a setup that were asked for. */
export function setupPatch(setup: ServiceSetup, parts: readonly SetupPart[]): { embedding?: EmbeddingSettings; image?: ImageSettings; tts?: TtsSettings } {
  return {
    ...(parts.includes('embedding') ? { embedding: setup.embedding } : {}),
    ...(parts.includes('image') ? { image: setup.image } : {}),
    ...(parts.includes('tts') ? { tts: setup.tts } : {}),
  }
}

/** The project's home page and the name it is signed with. */
export const PROJECT_HOMEPAGE = 'https://dsh-novel-studio.xuhao1.me'
export const PROJECT_AUTHOR = 'Dr. Xu'
/** The author's own page. */
export const PROJECT_AUTHOR_HOME = 'https://xuhao1.me'

/**
 * Which of the Studio's speech protocols drives a model of a service, or
 * `undefined` when none does yet. A service lists every model that can speak;
 * they do not all speak the same protocol, and choosing a model has to choose
 * the protocol with it.
 */
export function speechProtocol(service: ServiceId, model: string): TtsProviderKind | undefined {
  if (service === 'openrouter') return 'openrouter'
  if (service !== 'bailian') return 'openai'
  // Omni models read a line aloud over the realtime socket.
  if (/omni.*realtime/i.test(model)) return 'qwen-realtime'
  // The streaming-synthesis sockets (qwen3-tts-…-realtime, qwen-audio-…-realtime) are a different protocol the Studio does not speak yet.
  if (/realtime/i.test(model)) return undefined
  if (/^qwen-audio.*tts/i.test(model)) return 'qwen-audiogen'
  if (/^qwen\d*(\.\d+)?-tts/i.test(model)) return 'dashscope'
  return undefined
}


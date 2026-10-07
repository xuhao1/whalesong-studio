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

export type SetupPart = 'text' | 'embedding' | 'image' | 'tts'

export interface ServiceSetup {
  text: Record<TextRole, ModelRoute>
  embedding: EmbeddingSettings
  image: ImageSettings
  tts: TtsSettings
  /** Models worth offering next to the free-form model field, best first. */
  suggestions: { text: string[]; embedding: string[]; image: string[]; tts: string[] }
}

function direct(service: ServiceId, origin: string | undefined, model: string, reasoningEffort?: string): ModelRoute {
  return { provider: service, model, baseURL: compatibleBase(service, origin), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
}

/**
 * What a one-click setup configures for a service. `origin` replaces the
 * service's public endpoint (a Bailian workspace domain, a proxy).
 * @returns undefined for services without a recommended setup.
 */
export function recommendedSetup(service: ServiceId, origin?: string): ServiceSetup | undefined {
  if (service === 'bailian') {
    const base = originOf(origin) ?? SERVICES.bailian.origin
    return {
      text: {
        writer: direct('bailian', base, 'qwen3.8-max', 'off'),
        analyst: direct('bailian', base, 'qwen3.8-flash', 'off'),
        architect: direct('bailian', base, 'qwen3.8-max', 'low'),
        director: direct('bailian', base, 'qwen3.8-flash', 'off'),
      },
      embedding: { provider: 'openai', baseURL: compatibleBase('bailian', base), model: 'qwen3.7-text-embedding-flash' },
      image: { provider: 'dashscope', baseURL: base, model: 'qwen-image-3.0', size: '1280x720' },
      tts: { provider: 'qwen-audiogen', baseURL: base, model: 'qwen-audio-3.1-tts-next', concurrency: 2 },
      suggestions: {
        text: ['qwen3.8-max', 'qwen3.8-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'kimi-k3', 'glm-5.3'],
        embedding: ['qwen3.7-text-embedding-flash', 'qwen3.7-text-embedding'],
        image: ['qwen-image-3.0', 'qwen-image-3.0-pro', 'wan2.7-image', 'z-image-turbo'],
        tts: ['qwen-audio-3.1-tts-next'],
      },
    }
  }
  if (service === 'openrouter') {
    const base = compatibleBase('openrouter', origin)
    return {
      text: {
        writer: direct('openrouter', origin, 'anthropic/claude-sonnet-5.5'),
        analyst: direct('openrouter', origin, 'deepseek/deepseek-v4.1-flash', 'off'),
        architect: direct('openrouter', origin, 'deepseek/deepseek-v4-pro', 'medium'),
        director: direct('openrouter', origin, 'deepseek/deepseek-v4.1-flash', 'off'),
      },
      embedding: { provider: 'openai', baseURL: base, model: 'qwen/qwen3-embedding-8b' },
      image: { provider: 'openrouter', baseURL: base, model: 'openai/gpt-image-2.5-sunburst', size: '1536x1024' },
      tts: { provider: 'openrouter', baseURL: base, model: 'google/gemini-3.8-flash-tts', narratorVoice: 'Charon', concurrency: 3 },
      suggestions: {
        text: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash', 'qwen/qwen3.8-max-0902', 'moonshotai/kimi-k3'],
        embedding: ['qwen/qwen3-embedding-8b', 'baai/bge-m3', 'openai/text-embedding-3-small', 'google/gemini-embedding-2'],
        image: ['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare', 'openai/gpt-image-2', 'google/gemini-3-pro-image', 'bytedance-seed/seedream-5-0-pro', 'qwen/qwen-image-3-pro'],
        tts: ['google/gemini-3.8-flash-tts', 'openai/gpt-4o-mini-tts-2025-12-15', 'minimax/speech-2.8-hd', 'fish-audio/s2.1-pro'],
      },
    }
  }
  if (service === 'openai') {
    const base = compatibleBase('openai', origin)
    return {
      text: {
        writer: direct('openai', origin, 'gpt-6.1-sol'),
        analyst: direct('openai', origin, 'gpt-6-luna', 'low'),
        architect: direct('openai', origin, 'gpt-6.1-sol', 'medium'),
        director: direct('openai', origin, 'gpt-6-luna', 'low'),
      },
      embedding: { provider: 'openai', baseURL: base, model: 'text-embedding-3-small' },
      image: { provider: 'openai', baseURL: base, model: 'gpt-image-2', size: '1536x1024' },
      tts: { provider: 'openai', baseURL: base, model: 'gpt-4o-mini-tts', narratorVoice: 'alloy', concurrency: 3 },
      suggestions: {
        text: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
        embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
        image: ['gpt-image-2', 'gpt-image-1'],
        tts: ['gpt-4o-mini-tts'],
      },
    }
  }
  return undefined
}

/** Pick the parts of a setup that were asked for. */
export function setupPatch(setup: ServiceSetup, parts: readonly SetupPart[]): { models?: Record<TextRole, ModelRoute>; embedding?: EmbeddingSettings; image?: ImageSettings; tts?: TtsSettings } {
  return {
    ...(parts.includes('text') ? { models: setup.text } : {}),
    ...(parts.includes('embedding') ? { embedding: setup.embedding } : {}),
    ...(parts.includes('image') ? { image: setup.image } : {}),
    ...(parts.includes('tts') ? { tts: setup.tts } : {}),
  }
}

/** The project's home page and the name it is signed with. */
export const PROJECT_HOMEPAGE = 'https://dsh-novel-studio.xuhao1.me'
export const PROJECT_AUTHOR = 'Dr. Xu'

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

/** Speech models a service serves without listing them. */
export const UNLISTED_SPEECH: Partial<Record<ServiceId, string[]>> = {
  bailian: ['qwen-audio-3.1-tts-next'],
}

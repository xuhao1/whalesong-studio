// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Image generation providers.
 *
 *   openrouter  OpenRouter's `/images` endpoint (GPT Image, Gemini image, Seedream, FLUX…).
 *   openai      Any OpenAI-compatible `/images/generations` endpoint (gpt-image-*, gateways).
 *   dashscope   Aliyun Bailian multimodal generation (Qwen-Image, Z-Image, Wan image models).
 *   codex       The image generation of a ChatGPT subscription, through a bridge
 *               the Host provides (the Codex Connect plugin or the Codex CLI);
 *               it has no key of its own.
 */
import { providerDefault } from '../../shared/recommended'
import { compatibleBase, originOf } from '../../shared/services'
import type { CodexBridgeKind, IllustrationSent, ImageProviderKind, ImageSettings } from '../../shared/types'
import { download, postJson, ProviderError, requireKey, trimBase, type KeySource } from './http'

/** A picture sent along with a prompt so the model keeps what it shows: a character's portrait, usually. */
export interface ImageReference {
  data: Uint8Array
  mime: string
  /** Who or what the picture shows; the prompt refers to it by position. */
  label?: string
}

export interface ImageRequest {
  prompt: string
  negativePrompt?: string
  /** `WIDTHxHEIGHT`; falls back to the configured size. */
  size?: string
  /** Reference images, in the order the prompt numbers them. Providers that cannot take any ignore them and say so. */
  references?: ImageReference[]
  signal?: AbortSignal
}

export interface ImageResult {
  data: Uint8Array
  mime: string
  /** How many of the reference images actually went to the model. */
  referencesUsed?: number
  /** What went to the model, word for word: the picture's record keeps it, so that what shaped a picture can be read afterwards. */
  sent?: IllustrationSent
}

/** The most reference images a request is sent with, whatever was asked: no image model the Studio talks to takes more. How many a picture gets is the author's setting (`image.references`). */
export const MAX_REFERENCES = 10

function dataUrl(reference: ImageReference): string {
  return `data:${reference.mime};base64,${Buffer.from(reference.data).toString('base64')}`
}

export interface ImageProvider {
  readonly kind: ImageProviderKind
  readonly model: string
  generate(request: ImageRequest): Promise<ImageResult>
}

/** Generates one image from a prompt (and reference images) with a ChatGPT subscription. Supplied by the Host. */
export type CodexImageBridge = (prompt: string, options: { bridge: CodexBridgeKind; references?: ImageReference[]; signal?: AbortSignal }) => Promise<ImageResult>

export interface ImageBridges {
  codex?: CodexImageBridge
}

/** @returns the provider for the current settings, or undefined when images are switched off. */
export function createImageProvider(settings: ImageSettings, keys: KeySource, bridges: ImageBridges = {}): ImageProvider | undefined {
  if (settings.provider === 'dashscope') return new DashScopeImages(settings, keys)
  if (settings.provider === 'openai') return new OpenAiImages(settings, keys)
  if (settings.provider === 'openrouter') return new OpenRouterImages(settings, keys)
  if (settings.provider === 'codex') return new CodexImages(settings, bridges.codex)
  return undefined
}

// ───────────────────────────── sizes ─────────────────────────────

export function parseSize(size: string | undefined): { width: number; height: number } | undefined {
  const match = /^\s*(\d{2,5})\s*[xX×*]\s*(\d{2,5})\s*$/.exec(size ?? '')
  if (match === null) return undefined
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** The closest of a few aspect ratios, as `W:H`. */
export function nearestAspect(size: string | undefined, choices: readonly string[] = ['1:1', '16:9', '9:16', '4:3', '3:4']): string {
  const parsed = parseSize(size)
  if (parsed === undefined) return choices[0]!
  const wanted = Math.log(parsed.width / parsed.height)
  let best = choices[0]!
  let distance = Number.POSITIVE_INFINITY
  for (const choice of choices) {
    const [w, h] = choice.split(':').map(Number)
    const delta = Math.abs(Math.log(w! / h!) - wanted)
    if (delta < distance) {
      best = choice
      distance = delta
    }
  }
  return best
}

/** The classic GPT Image sizes; every gpt-image model accepts them. */
function gptImageSize(size: string | undefined): string {
  const aspect = nearestAspect(size, ['1:1', '3:2', '2:3'])
  return aspect === '3:2' ? '1536x1024' : aspect === '2:3' ? '1024x1536' : '1024x1024'
}

/** OpenRouter's resolution tier for a pixel size. */
function resolutionTier(size: string | undefined): string {
  const parsed = parseSize(size)
  const longest = parsed !== undefined ? Math.max(parsed.width, parsed.height) : 1024
  if (longest <= 640) return '512'
  if (longest <= 900) return '768'
  if (longest <= 1300) return '1K'
  if (longest <= 1800) return '1.5K'
  if (longest <= 3000) return '2K'
  return '4K'
}

/** A prompt for endpoints without a negative-prompt field. */
function withAvoid(prompt: string, negative: string | undefined, limit: number): string {
  const avoid = negative?.trim()
  return (avoid !== undefined && avoid.length > 0 ? `${prompt}\n\nAvoid: ${avoid}` : prompt).slice(0, limit)
}

function signalOption(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal !== undefined ? { signal } : {}
}

async function fromReply(first: { b64_json?: string; url?: string; media_type?: string } | undefined, signal: AbortSignal | undefined): Promise<ImageResult> {
  if (first?.b64_json !== undefined && first.b64_json.length > 0) {
    return { data: Buffer.from(first.b64_json, 'base64'), mime: first.media_type?.startsWith('image/') === true ? first.media_type : 'image/png' }
  }
  if (first?.url !== undefined) {
    const file = await download(first.url, signalOption(signal))
    return { data: file.data, mime: file.mime.startsWith('image/') ? file.mime : 'image/png' }
  }
  throw new ProviderError('image generation returned no image')
}

// ───────────────────────────── Aliyun Bailian ─────────────────────────────

interface DashScopeImageReply {
  output?: { choices?: { message?: { content?: { image?: string }[] } }[] }
  message?: string
}

class DashScopeImages implements ImageProvider {
  readonly kind = 'dashscope' as const
  readonly model: string

  constructor(private readonly settings: ImageSettings, private readonly keys: KeySource) {
    this.model = settings.model ?? providerDefault('image', 'dashscope').model
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const origin = originOf(this.settings.baseURL) ?? 'https://dashscope.aliyuncs.com'
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: origin }, 'Image generation')
    const negative = (request.negativePrompt ?? this.settings.negativePrompt)?.slice(0, 500)
    const references = (request.references ?? []).slice(0, MAX_REFERENCES)
    const prompt = request.prompt.slice(0, 2000)
    const size = (request.size ?? this.settings.size ?? '1024x1024').replace(/[xX×]/, '*')
    const reply = await postJson<DashScopeImageReply>(`${origin}/api/v1/services/aigc/multimodal-generation/generation`, {
      model: this.model,
      // Reference pictures come first, the way the API reads "these, then what to do with them".
      input: { messages: [{ role: 'user', content: [...references.map(reference => ({ image: dataUrl(reference) })), { text: prompt }] }] },
      parameters: {
        size,
        prompt_extend: false,
        watermark: false,
        ...(negative !== undefined && negative.length > 0 ? { negative_prompt: negative } : {}),
      },
    }, { apiKey, ...signalOption(request.signal), timeoutMs: 300_000 })
    const url = reply.output?.choices?.[0]?.message?.content?.find(part => typeof part.image === 'string')?.image
    if (url === undefined) throw new ProviderError(`image generation returned no image${reply.message !== undefined ? `: ${reply.message}` : ''}`)
    const file = await download(url, signalOption(request.signal))
    return { data: file.data, mime: file.mime.startsWith('image/') ? file.mime : 'image/png', referencesUsed: references.length, sent: { prompt, ...(negative !== undefined && negative.length > 0 ? { negative } : {}), size } }
  }
}

// ───────────────────────────── OpenAI-compatible ─────────────────────────────

interface ImagesReply {
  data?: { b64_json?: string; url?: string; media_type?: string }[]
}

class OpenAiImages implements ImageProvider {
  readonly kind = 'openai' as const
  readonly model: string

  constructor(private readonly settings: ImageSettings, private readonly keys: KeySource) {
    this.model = settings.model ?? providerDefault('image', 'openai').model
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openai'))
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: base }, 'Image generation')
    const wanted = request.size ?? this.settings.size ?? '1024x1024'
    const gpt = /^(gpt-image|dall-e|chatgpt-image)/i.test(this.model)
    const prompt = withAvoid(request.prompt, request.negativePrompt ?? this.settings.negativePrompt, 4000)
    const size = gpt ? gptImageSize(wanted) : wanted
    const quality = this.settings.quality !== undefined && this.settings.quality.length > 0 ? this.settings.quality : undefined
    const references = (request.references ?? []).slice(0, MAX_REFERENCES)
    // Pictures to keep faithful to go through the edits endpoint, which is where GPT Image takes image input.
    if (references.length > 0 && /^(gpt-image|chatgpt-image)/i.test(this.model)) {
      const form = new FormData()
      form.set('model', this.model)
      form.set('prompt', prompt)
      form.set('size', size)
      form.set('n', '1')
      if (quality !== undefined) form.set('quality', quality)
      references.forEach((reference, index) => { form.append('image[]', new Blob([reference.data], { type: reference.mime }), `reference-${index + 1}.${extensionOf(reference.mime)}`) })
      let response: Response
      try {
        response = await fetch(`${base}/images/edits`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: request.signal ?? AbortSignal.timeout(300_000) })
      } catch (error) {
        if (request.signal?.aborted === true) throw error
        throw new ProviderError(`request to ${new URL(base).host} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const text = await response.text()
      if (!response.ok) throw new ProviderError(`${new URL(base).host} answered ${response.status}: ${text.slice(0, 300)}`, response.status)
      const reply = JSON.parse(text) as ImagesReply
      return { ...await fromReply(reply.data?.[0], request.signal), referencesUsed: references.length, sent: { prompt, size } }
    }
    const reply = await postJson<ImagesReply>(`${base}/images/generations`, {
      model: this.model,
      prompt,
      size,
      n: 1,
      ...(quality !== undefined ? { quality } : {}),
    }, { apiKey, ...signalOption(request.signal), timeoutMs: 300_000 })
    return { ...await fromReply(reply.data?.[0], request.signal), referencesUsed: 0, sent: { prompt, size } }
  }
}

// ───────────────────────────── OpenRouter ─────────────────────────────

class OpenRouterImages implements ImageProvider {
  readonly kind = 'openrouter' as const
  readonly model: string

  constructor(private readonly settings: ImageSettings, private readonly keys: KeySource) {
    this.model = settings.model ?? providerDefault('image', 'openrouter').model
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openrouter'))
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: base }, 'Image generation')
    const wanted = request.size ?? this.settings.size ?? '1024x1024'
    // Models differ in the pixel sizes they take; a ratio and a tier are understood by all of them.
    const references = (request.references ?? []).slice(0, MAX_REFERENCES)
    const prompt = withAvoid(request.prompt, request.negativePrompt ?? this.settings.negativePrompt, 8000)
    const aspect = nearestAspect(wanted)
    const resolution = resolutionTier(wanted)
    const reply = await postJson<ImagesReply>(`${base}/images`, {
      model: this.model,
      prompt,
      aspect_ratio: aspect,
      resolution,
      output_format: 'png',
      n: 1,
      ...(this.settings.quality !== undefined && this.settings.quality.length > 0 ? { quality: this.settings.quality } : {}),
      ...(references.length > 0 ? { input_references: references.map(reference => ({ type: 'image_url', image_url: { url: dataUrl(reference) } })) } : {}),
    }, { apiKey, headers: { 'x-title': 'Novel Studio' }, ...signalOption(request.signal), timeoutMs: 300_000 })
    return { ...await fromReply(reply.data?.[0], request.signal), referencesUsed: references.length, sent: { prompt, size: `${aspect} · ${resolution}` } }
  }
}

// ───────────────────────────── ChatGPT subscription ─────────────────────────────

class CodexImages implements ImageProvider {
  readonly kind = 'codex' as const
  readonly model = 'gpt-image'

  constructor(private readonly settings: ImageSettings, private readonly bridge: CodexImageBridge | undefined) {}

  async generate(request: ImageRequest): Promise<ImageResult> {
    if (this.bridge === undefined) {
      throw new ProviderError('images through a ChatGPT subscription need the Codex Connect plugin or the Codex CLI on the machine that runs Harness', undefined, 'UNSUPPORTED')
    }
    // The subscription endpoint takes a prompt and nothing else, so the framing travels in words.
    const aspect = nearestAspect(request.size ?? this.settings.size, ['1:1', '16:9', '9:16', '3:2', '2:3'])
    const framing = aspect === '1:1' ? 'Square 1:1 composition.' : aspect === '16:9' || aspect === '3:2' ? `Landscape ${aspect} composition.` : `Portrait ${aspect} composition.`
    const prompt = `${withAvoid(request.prompt, request.negativePrompt ?? this.settings.negativePrompt, 7000)}\n\n${framing}`
    const references = (request.references ?? []).slice(0, MAX_REFERENCES)
    const drawn = await this.bridge(prompt, { bridge: this.settings.bridge ?? 'auto', ...(references.length > 0 ? { references } : {}), ...signalOption(request.signal) })
    // A bridge that wraps the prompt in words of its own says so; otherwise what it was handed is what went.
    return { ...drawn, sent: drawn.sent ?? { prompt } }
  }
}

export function extensionOf(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

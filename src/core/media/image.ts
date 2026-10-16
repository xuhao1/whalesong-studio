// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Image generation providers.
 *
 *   openrouter  OpenRouter's `/images` endpoint (GPT Image, Gemini image, Seedream, FLUX…).
 *   openai      Any OpenAI-compatible `/images/generations` endpoint (gpt-image-*, gateways, and a
 *               server of the author's own, which is asked the way such a server wants to be);
 *               with reference pictures, its `/images/edits`.
 *   dashscope   Aliyun Bailian multimodal generation (Qwen-Image, Z-Image, Wan image models).
 *   codex       The image generation of a ChatGPT subscription, through a bridge
 *               the Host provides (the Codex Connect plugin or the Codex CLI);
 *               it has no key of its own.
 */
import { fittedSize, imageLimitsOf, imageSizes, LOCAL_SIZES, localImages, nearestSize, parseSize, sizeList, type ImageLimits } from '../../shared/images'
import { providerDefault } from '../../shared/recommended'
import { compatibleBase, originOf } from '../../shared/services'
import type { CodexBridgeKind, IllustrationSent, ImageProviderKind, ImageSettings } from '../../shared/types'
import { download, findKey, getJson, postForm, postJson, ProviderError, requireKey, trimBase, type KeySource } from './http'
import { ComfyImages, DiffusersImages } from './local'

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
  /**
   * The one reference is the picture to change, and the prompt is what to change in it and nothing more — it does not
   * say what the picture shows. For a way to the model that has to tell somebody what an attached picture is there for.
   */
  change?: boolean
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

/** What a prompt has to fit, on the way to one model. */
export interface PromptRoom {
  /** The most tokens the model reads: the author's figure, else the endpoint's own where it gives one. */
  tokens?: number
  /** Things to keep out travel inside the prompt (the service has no field for them), and count against the room. */
  avoidInPrompt: boolean
  /**
   * How many reference pictures go along at most, where that is known before drawing: what the service says of the
   * model, or what sending one found out. `0` — none: the prompt is then written without a word of any, and none is
   * read off the disk for it. Left out: not known — they are sent, and a service that will not have them says so
   * ({@link referencesRefused}).
   */
  references?: number
}

export interface ImageProvider {
  readonly kind: ImageProviderKind
  readonly model: string
  generate(request: ImageRequest): Promise<ImageResult>
  /** How much room a prompt has on the way to this model. Left out: as much as it needs. */
  prompting?(signal?: AbortSignal): Promise<PromptRoom>
}

/** The author's own figure for how many tokens the model reads. */
function tokensSet(settings: ImageSettings): number | undefined {
  return typeof settings.promptTokens === 'number' && Number.isFinite(settings.promptTokens) && settings.promptTokens > 0 ? Math.round(settings.promptTokens) : undefined
}

/** Generates one image from a prompt (and reference images) with a ChatGPT subscription. Supplied by the Host. */
export type CodexImageBridge = (prompt: string, options: { bridge: CodexBridgeKind; references?: ImageReference[]; /** The one reference is the picture to change; the prompt says only what to change. */ change?: boolean; signal?: AbortSignal }) => Promise<ImageResult>

export interface ImageBridges {
  codex?: CodexImageBridge
}

/** @returns the provider for the current settings, or undefined when images are switched off. */
export function createImageProvider(settings: ImageSettings, keys: KeySource, bridges: ImageBridges = {}): ImageProvider | undefined {
  const provider: ImageProvider | undefined = settings.provider === 'dashscope' ? new DashScopeImages(settings, keys)
    : settings.provider === 'openai' ? new OpenAiImages(settings, keys)
      : settings.provider === 'openrouter' ? new OpenRouterImages(settings, keys)
        : settings.provider === 'codex' ? new CodexImages(settings, bridges.codex)
          : settings.provider === 'comfyui' ? new ComfyImages(settings)
            : settings.provider === 'diffusers' ? new DiffusersImages(settings)
              : undefined
  if (provider === undefined || provider.prompting !== undefined) return provider
  // A way of drawing that says nothing of its own: the author's figure, where there is one. These three have no field
  // for what to keep out, and carry it in the prompt.
  const tokens = tokensSet(settings)
  const avoidInPrompt = settings.provider === 'openrouter' || settings.provider === 'codex'
  // ComfyUI takes pictures through a workflow of its own for them: with none named, nothing but the words goes.
  const none = settings.provider === 'comfyui' && (settings.editWorkflow?.trim().length ?? 0) === 0
  return Object.assign(provider, { prompting: async (): Promise<PromptRoom> => ({ ...(tokens !== undefined ? { tokens } : {}), avoidInPrompt, ...(none ? { references: 0 } : {}) }) })
}

// ───────────────────────────── sizes ─────────────────────────────

export { parseSize }

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
    let reply: DashScopeImageReply
    try {
      reply = await postJson<DashScopeImageReply>(`${origin}/api/v1/services/aigc/multimodal-generation/generation`, {
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
    } catch (error) {
      // Asked with pictures and refused as a request it cannot take: a model of Bailian's that draws from words alone
      // (Z-Image) answers so. Whoever asked may ask again with the words alone, and the picture's record says why.
      if (references.length > 0 && error instanceof ProviderError && error.status === 400) throw new ProviderError(error.message, error.status, REFERENCES_REFUSED)
      throw error
    }
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

/** What servers of the author's own said of their models, asked for once in a while. */
const ownListings = new Map<string, { at: number; byId: Promise<Map<string, ImageLimits | undefined>> }>()

/**
 * What a server of the author's own says of a model — how large it draws, how long a prompt it reads, whether it
 * draws from a seed — where its model list says (`GET /models`). Undefined where the list cannot be had or says nothing.
 */
async function ownLimits(base: string, model: string, apiKey: string | undefined, signal: AbortSignal | undefined): Promise<ImageLimits | undefined> {
  const ask = (): void => {
    const byId = getJson<{ data?: unknown[] }>(`${base}/models`, { ...(apiKey !== undefined ? { apiKey } : {}), timeoutMs: 20_000 })
      .then(reply => new Map((Array.isArray(reply.data) ? reply.data : []).filter((row): row is { id: string } => typeof (row as { id?: unknown } | null)?.id === 'string').map(row => [row.id, imageLimitsOf(row)])))
    byId.catch(() => { if (ownListings.get(base)?.byId === byId) ownListings.delete(base) })
    ownListings.set(base, { at: Date.now(), byId })
  }
  const cached = ownListings.get(base)
  if (cached === undefined || Date.now() - cached.at > 30 * 60_000) ask()
  try {
    let byId = await ownListings.get(base)!.byId
    // A model the list did not have when it was read: put on the server since, as likely as not. Read again — at most
    // once in a minute, for a model the server really does not list.
    if (!byId.has(model) && Date.now() - (ownListings.get(base)?.at ?? 0) > 60_000) {
      ask()
      byId = await ownListings.get(base)!.byId
    }
    return byId.get(model)
  } catch (error) {
    if (signal?.aborted === true) throw error
    return undefined
  }
}

/** The code of a refusal that is about the reference pictures: the endpoint, or the model on it, takes none. */
export const REFERENCES_REFUSED = 'REFERENCES_REFUSED'

/** A picture was asked for with reference pictures, and the service would not have them: drawn from the words alone, it may yet be drawn. */
export function referencesRefused(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.code === REFERENCES_REFUSED
}

/**
 * Endpoints that turned out to have no way of taking a picture with a prompt, by base and model: found out by sending
 * one, and held to for a while — not for good: a server of the author's own learns to.
 */
const withoutPictures = new Map<string, number>()
const WITHOUT_PICTURES_MS = 30 * 60_000

function takesNoPictures(base: string, model: string): boolean {
  const since = withoutPictures.get(`${base}\n${model}`)
  return since !== undefined && Date.now() - since < WITHOUT_PICTURES_MS
}

/** GPT Image takes pictures through the edits endpoint, as many as are sent. */
const GPT_PICTURES = /^(gpt-image|chatgpt-image)/i

class OpenAiImages implements ImageProvider {
  readonly kind = 'openai' as const
  readonly model: string

  constructor(private readonly settings: ImageSettings, private readonly keys: KeySource) {
    this.model = settings.model ?? providerDefault('image', 'openai').model
  }

  /**
   * The author's figure for the prompt; else, at a server of their own, what its model list says the model reads.
   * How many reference pictures go along is what that list says of the model too — and where nothing says, it is not
   * known before one is sent: no model is taken to draw from words alone for its name.
   */
  async prompting(signal?: AbortSignal): Promise<PromptRoom> {
    const local = localImages(this.settings)
    const set = tokensSet(this.settings)
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openai'))
    const limits = local ? await ownLimits(base, this.model, await findKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: base }, 'Image generation').catch(() => undefined), signal) : undefined
    const tokens = set ?? limits?.promptTokens
    const references = !local && GPT_PICTURES.test(this.model) ? undefined : limits?.references ?? (takesNoPictures(base, this.model) ? 0 : undefined)
    return { ...(tokens !== undefined ? { tokens } : {}), avoidInPrompt: true, ...(references !== undefined ? { references: Math.min(MAX_REFERENCES, references) } : {}) }
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openai'))
    // A server of the author's own draws one picture at a time (the gate lets one through: `imageParallel`), at the
    // sizes it has, from a model, a prompt, a count and a size: a field it does not know is a request it refuses. It
    // may take no key, and when it is busy it says for how long.
    const local = localImages(this.settings)
    const credential = { ref: this.settings.apiKeyRef, endpoint: base }
    const apiKey = local ? await findKey(this.keys, credential, 'Image generation') : await requireKey(this.keys, credential, 'Image generation')
    const wanted = request.size ?? this.settings.size ?? '1024x1024'
    const gpt = /^(gpt-image|dall-e|chatgpt-image)/i.test(this.model)
    // (A server said to be the author's own is asked as one, whatever name its model goes by.)
    const gptPictures = !local && GPT_PICTURES.test(this.model)
    // Such a server is asked what its model takes: the largest picture, the longest prompt, whether it draws from a
    // seed, how many pictures it takes with a prompt.
    const limits = local ? await ownLimits(base, this.model, apiKey, request.signal) : undefined
    const prompt = withAvoid(request.prompt, request.negativePrompt ?? this.settings.negativePrompt, Math.min(4000, limits?.promptChars ?? 4000))
    const sizes = imageSizes(this.settings)
    const within = local && limits !== undefined && sizeList(this.settings.sizes).length === 0
    let size = local ? fittedSize(this.settings, wanted, limits) : sizes !== undefined ? nearestSize(wanted, sizes) : gpt ? gptImageSize(wanted) : wanted
    const quality = !local && this.settings.quality !== undefined && this.settings.quality.length > 0 ? this.settings.quality : undefined
    // Pictures to keep faithful to go through the edits endpoint (OpenAI's `images.edit()`): GPT Image's way, and the
    // way of any server that speaks it. As many as the server's list says the model takes; none where sending one
    // was refused a while ago.
    const most = gptPictures ? MAX_REFERENCES : takesNoPictures(base, this.model) && limits?.references === undefined ? 0 : Math.min(MAX_REFERENCES, limits?.references ?? MAX_REFERENCES)
    const references = (request.references ?? []).slice(0, most)
    // From its own seed it draws the same picture every time it is asked the same: a picture drawn again is drawn from another.
    const seed = (references.length > 0 ? limits?.editSeeded : limits?.seeded) === true ? Math.floor(Math.random() * 2 ** 31) : undefined
    // A model that has to be loaded first takes its time over the first picture.
    const http = { ...(apiKey !== undefined ? { apiKey } : {}), ...signalOption(request.signal), ...(local ? { timeoutMs: 600_000, heedRetryAfter: true } : { timeoutMs: 300_000 }) }
    const ask = async (): Promise<ImagesReply> => {
      if (references.length === 0) return await postJson<ImagesReply>(`${base}/images/generations`, { model: this.model, prompt, size, n: 1, ...(quality !== undefined ? { quality } : {}), ...(seed !== undefined ? { seed } : {}) }, http)
      const form = new FormData()
      form.set('model', this.model)
      form.set('prompt', prompt)
      form.set('size', size)
      form.set('n', '1')
      if (quality !== undefined) form.set('quality', quality)
      if (seed !== undefined) form.set('seed', String(seed))
      // One picture is `image`, several are `image[]` — as OpenAI's own client sends them. (GPT Image gets `image[]` either way, as it always has here.)
      const field = gptPictures || references.length > 1 ? 'image[]' : 'image'
      references.forEach((reference, index) => { form.append(field, new Blob([reference.data], { type: reference.mime }), `reference-${index + 1}.${extensionOf(reference.mime)}`) })
      return await postForm<ImagesReply>(`${base}/images/edits`, form, http)
    }
    let reply: ImagesReply
    try {
      try {
        reply = await ask()
      } catch (error) {
        // The size was worked out from the limits the server gave, and the server will not have it: one of the usual sizes, once.
        const usual = nearestSize(wanted, LOCAL_SIZES)
        if (!(within && usual !== size && error instanceof ProviderError && (error.status === 400 || error.status === 422) && /\bsize\b|dimension/i.test(error.message))) throw error
        size = usual
        reply = await ask()
      }
    } catch (error) {
      // No key was sent because none is saved; the server turns out to want one.
      if (local && apiKey === undefined && error instanceof ProviderError && (error.status === 401 || error.status === 403)) {
        throw new ProviderError(`${error.message} — this server asks for a key: paste it in Whalesong Studio → Settings`, error.status, 'NO_CREDENTIAL')
      }
      // Asked with pictures, and refused as a request it cannot take — not for the key, not for being busy, not for a
      // fault of its own: it is the pictures. Whoever asked may ask again with the words alone. An endpoint that is
      // not there at all is not asked a second time for a while.
      if (references.length > 0 && !gptPictures && error instanceof ProviderError && error.status !== undefined && [400, 404, 405, 415, 422, 501].includes(error.status)) {
        if ([404, 405, 501].includes(error.status)) withoutPictures.set(`${base}\n${this.model}`, Date.now())
        throw new ProviderError(error.message, error.status, REFERENCES_REFUSED)
      }
      throw error
    }
    // Whatever else the reply says — the model's build, how it was sampled, how long it took — is no part of the picture.
    return { ...await fromReply(reply.data?.[0], request.signal), referencesUsed: references.length, sent: { prompt, size, ...(seed !== undefined ? { seed } : {}) } }
  }
}

// ───────────────────────────── OpenRouter ─────────────────────────────

/**
 * What an image model takes, parameter by parameter, as OpenRouter lists it
 * (`GET /images/models`): the values of a choice, the most of a count. A
 * parameter that is not in the record is one the model does not take; one that
 * is there with nothing said takes whatever is sent.
 */
export type ImageTakes = Record<string, { values?: string[]; max?: number }>

/** What is sent to a model nothing is known of: the parameters most of them take. What it refuses is learnt from the refusal. */
const ASSUMED: ImageTakes = { aspect_ratio: {}, resolution: {}, quality: {}, n: {}, input_references: {} }
/** The shapes nearly every model has. */
const COMMON_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4']

interface ListedImageModel {
  id?: unknown
  supported_parameters?: Record<string, { type?: unknown; values?: unknown; max?: unknown } | undefined>
}

function takesOf(row: ListedImageModel): ImageTakes {
  const takes: ImageTakes = {}
  for (const [name, spec] of Object.entries(row.supported_parameters ?? {})) {
    if (spec === undefined || spec === null) continue
    takes[name] = {
      ...(Array.isArray(spec.values) ? { values: spec.values.filter((value): value is string => typeof value === 'string') } : {}),
      ...(typeof spec.max === 'number' ? { max: spec.max } : {}),
    }
  }
  return takes
}

/** The listing of an endpoint, asked for once in a while: models come and go, and what they take changes with them. */
const listings = new Map<string, { at: number; byId: Promise<Map<string, ImageTakes>> }>()
/**
 * What a model turned out to take when it was asked, where that is less than its listing says (an account's own rules
 * leave some of a model's providers out): per parameter the values taken, or `null` where it is not taken at all.
 */
const learnt = new Map<string, Record<string, string[] | null>>()

/** What a model takes, less what it has since refused. */
function narrowed(takes: ImageTakes, told: Record<string, string[] | null>): ImageTakes {
  const next: ImageTakes = {}
  for (const [name, spec] of Object.entries(takes)) {
    const accepted = told[name]
    if (accepted === undefined) next[name] = spec
    else if (accepted !== null) next[name] = { ...spec, values: accepted }
  }
  return next
}

/** Forget what was listed and learnt. For tests, and for nothing else: both are found again by asking. */
export function forgetImageListings(): void {
  listings.clear()
  learnt.clear()
  ownListings.clear()
  withoutPictures.clear()
}

/** What the endpoint's listing says a model takes; undefined when the listing cannot be had or does not know the model. */
async function listedTakes(base: string, model: string, apiKey: string, signal: AbortSignal | undefined): Promise<ImageTakes | undefined> {
  const cached = listings.get(base)
  if (cached === undefined || Date.now() - cached.at > 30 * 60_000) {
    // What refusals taught goes with the listing it corrected: an account's rules change too.
    for (const key of [...learnt.keys()]) if (key.startsWith(`${base}|`)) learnt.delete(key)
    const byId = getJson<{ data?: ListedImageModel[] }>(`${base}/images/models`, { apiKey, timeoutMs: 20_000 })
      .then(reply => new Map((reply.data ?? []).filter((row): row is ListedImageModel & { id: string } => typeof row.id === 'string').map(row => [row.id, takesOf(row)])))
    // A listing that could not be had is asked for again, not remembered as empty.
    byId.catch(() => { if (listings.get(base)?.byId === byId) listings.delete(base) })
    listings.set(base, { at: Date.now(), byId })
  }
  try {
    const byId = await listings.get(base)!.byId
    // A variant of a model (`…:free`) takes what the model takes.
    return byId.get(model) ?? byId.get(model.replace(/:[^/:]+$/, ''))
  } catch (error) {
    if (signal?.aborted === true) throw error
    return undefined
  }
}

/** How many pixels a side a fineness is named after: `512`, `768`, `1K`, `1.5K`, `2K`, `4K`. */
function tierSide(tier: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(k?)$/i.exec(tier.trim())
  return match === null ? undefined : Number(match[1]) * (match[2] !== '' ? 1024 : 1)
}

/** The fineness a size asks for where the model has it; else the one it has that is nearest in pixels — the lesser of two equally near. */
function fittedTier(wanted: string | undefined, has: readonly string[]): string | undefined {
  const tier = resolutionTier(wanted)
  if (has.includes(tier)) return tier
  const parsed = parseSize(wanted)
  const pixels = parsed !== undefined ? parsed.width * parsed.height : (tierSide(tier) ?? 1024) ** 2
  let best: string | undefined
  let distance = Number.POSITIVE_INFINITY
  for (const candidate of [...has].sort((left, right) => (tierSide(left) ?? 0) - (tierSide(right) ?? 0))) {
    const side = tierSide(candidate)
    if (side === undefined) continue
    const delta = Math.abs(Math.log(side * side / pixels))
    if (delta < distance - 1e-3) {
      best = candidate
      distance = delta
    }
  }
  return best
}

export interface OpenRouterAsk {
  body: Record<string, unknown>
  /** The shape and the fineness asked for, in the service's terms, for the picture's record. */
  size?: string
  /** How many of the reference pictures go along. */
  references: number
}

/**
 * What a model is asked for a picture: only the parameters it takes, each at a
 * value it takes. A model that has no fineness to choose is not sent one; a
 * shape or a fineness it does not have becomes the nearest it has; a quality
 * it does not know and reference pictures beyond what it holds stay behind.
 */
export function openRouterAsk(input: { model: string; prompt: string; wanted: string | undefined; quality?: string | undefined; references: readonly ImageReference[] }, takes: ImageTakes = ASSUMED): OpenRouterAsk {
  const shapes = takes.aspect_ratio?.values?.filter(value => /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(value))
  const aspect = takes.aspect_ratio === undefined ? undefined : nearestAspect(input.wanted, shapes !== undefined && shapes.length > 0 ? shapes : COMMON_ASPECTS)
  const resolution = takes.resolution === undefined ? undefined : takes.resolution.values !== undefined ? fittedTier(input.wanted, takes.resolution.values) : resolutionTier(input.wanted)
  const quality = input.quality !== undefined && input.quality.length > 0 && takes.quality !== undefined && (takes.quality.values === undefined || takes.quality.values.includes(input.quality)) ? input.quality : undefined
  const references = takes.input_references === undefined ? [] : input.references.slice(0, Math.min(MAX_REFERENCES, takes.input_references.max ?? MAX_REFERENCES))
  return {
    body: {
      model: input.model,
      prompt: input.prompt,
      ...(aspect !== undefined ? { aspect_ratio: aspect } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      // Asked for only of a model that has formats to choose from; the others answer in the one they have.
      ...(takes.output_format?.values?.includes('png') === true ? { output_format: 'png' } : {}),
      ...(takes.n !== undefined ? { n: 1 } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(references.length > 0 ? { input_references: references.map(reference => ({ type: 'image_url', image_url: { url: dataUrl(reference) } })) } : {}),
    },
    ...(aspect !== undefined || resolution !== undefined ? { size: [aspect, resolution].filter(part => part !== undefined).join(' · ') } : {}),
    references: references.length,
  }
}

/**
 * What a refusal says of the parameters it refused: for each, the values that
 * would have been taken, or `null` where it is not taken at all. OpenRouter
 * words it "Provider rejections: Google: resolution: not supported. Accepted:
 * 1K, 2K; aspect_ratio: not supported. Accepted: 1:1, 2:3".
 */
export function refusedParameters(message: string): Record<string, string[] | null> {
  const told: Record<string, string[] | null> = {}
  const at = message.indexOf('Provider rejections:')
  if (at < 0) return told
  for (const match of message.slice(at).matchAll(/([a-z_]+): not supported(?:\.\s*Accepted:\s*([^;\n|]+))?/gi)) {
    const name = match[1]!
    const accepted = match[2]?.split(',').map(value => value.trim().replace(/^"|"$/g, '')).filter(value => value.length > 0)
    // Several providers of one model: whatever any of them would take is worth asking for.
    const before = told[name]
    told[name] = accepted !== undefined && accepted.length > 0 ? [...new Set([...(before ?? []), ...accepted])] : before ?? null
  }
  return told
}

class OpenRouterImages implements ImageProvider {
  readonly kind = 'openrouter' as const
  readonly model: string

  constructor(private readonly settings: ImageSettings, private readonly keys: KeySource) {
    this.model = settings.model ?? providerDefault('image', 'openrouter').model
  }

  /** The author's figure for the prompt; and how many reference pictures the model takes, by the endpoint's listing. */
  async prompting(signal?: AbortSignal): Promise<PromptRoom> {
    const tokens = tokensSet(this.settings)
    const room: PromptRoom = { ...(tokens !== undefined ? { tokens } : {}), avoidInPrompt: true }
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openrouter'))
    const apiKey = await findKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: base }, 'Image generation').catch(() => undefined)
    const listed = apiKey !== undefined ? await listedTakes(base, this.model, apiKey, signal) : undefined
    // A model the listing does not know is asked as one that takes them (`ASSUMED`).
    if (listed === undefined) return room
    const told = learnt.get(`${base}|${this.model}`) ?? {}
    const takes = narrowed(listed, told)
    return { ...room, references: takes.input_references === undefined ? 0 : Math.min(MAX_REFERENCES, takes.input_references.max ?? MAX_REFERENCES) }
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openrouter'))
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: base }, 'Image generation')
    const wanted = request.size ?? this.settings.size ?? '1024x1024'
    const prompt = withAvoid(request.prompt, request.negativePrompt ?? this.settings.negativePrompt, 8000)
    const input = { model: this.model, prompt, wanted, quality: this.settings.quality, references: request.references ?? [] }
    // Models differ in what they take — a shape and a fineness, a shape alone, a quality, one reference picture or
    // sixteen — and are refused what they do not: the endpoint is asked what this one takes, and only that is sent.
    const known = `${base}|${this.model}`
    const listed = await listedTakes(base, this.model, apiKey, request.signal) ?? ASSUMED
    let told = learnt.get(known) ?? {}
    for (let round = 0; ; round++) {
      const ask = openRouterAsk(input, narrowed(listed, told))
      try {
        const reply = await postJson<ImagesReply>(`${base}/images`, ask.body, { apiKey, headers: { 'x-title': 'Whalesong Studio' }, ...signalOption(request.signal), timeoutMs: 300_000 })
        return { ...await fromReply(reply.data?.[0], request.signal), referencesUsed: ask.references, sent: { prompt, ...(ask.size !== undefined ? { size: ask.size } : {}) } }
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        // The listing speaks for the model; the providers an account may use can take less. What they say they take is
        // asked for next — a refusal costs nothing — and is kept for the pictures after this one.
        const news = round < 2 && error.status === 400 ? Object.entries(refusedParameters(error.message)).filter(([name]) => name in ask.body) : []
        if (news.length === 0) throw explained(error)
        told = { ...told, ...Object.fromEntries(news) }
        learnt.set(known, told)
      }
    }
  }
}

/** A refusal that is about the account rather than the request, with what to do about it. */
function explained(error: ProviderError): ProviderError {
  if (!/guardrail restrictions and data policy/i.test(error.message)) return error
  const said = error.message.replace(/\s*\n\s*/g, ' ')
  return new ProviderError(`${said} — the privacy settings of this OpenRouter account leave out every provider of this model: allow them at https://openrouter.ai/settings/privacy, or choose another model`, error.status, error.code)
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
    const drawn = await this.bridge(prompt, { bridge: this.settings.bridge ?? 'auto', ...(references.length > 0 ? { references } : {}), ...(request.change === true && references.length > 0 ? { change: true } : {}), ...signalOption(request.signal) })
    // A bridge that wraps the prompt in words of its own says so; otherwise what it was handed is what went.
    return { ...drawn, sent: drawn.sent ?? { prompt } }
  }
}

export function extensionOf(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

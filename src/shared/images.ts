// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What an OpenAI-compatible images endpoint is held to, by whose it is.
 *
 * A service on the net draws many pictures at once, at many sizes. A server of
 * the author's own — a model on their machine or their network, put behind
 * `/v1/images/generations` — has one graphics card: it draws one picture at a
 * time, at the few sizes the model was set up for, and takes a model, a prompt
 * and a size and nothing else. Which of the two an endpoint is can be read off
 * its address, and is said outright (`image.local`) where the address misleads.
 *
 * Shared by the Host (which draws) and the Studio (which shows what will be drawn).
 */
import { providerDefault } from './recommended'
import { hostOf, privateAddress, serviceOf, type ServiceId } from './services'
import { IMAGE_SERVICE_KEYS, TTS_SERVICE_KEYS, parallelOf, type BookImageSettings, type ImageSettings, type NovelSettings, type ProjectManifest, type TtsSettings } from './types'

/** OpenAI's own image models, wherever they are reached: a gateway on the author's network that hands on to them is no model of the author's. */
const GPT_IMAGE = /^(gpt-image|dall-e|chatgpt-image)/i

/**
 * Whether pictures come from a server of the author's own behind an
 * OpenAI-compatible endpoint: what the settings say; else an address on this
 * machine or this network, unless the model asked for is one of OpenAI's.
 */
export function localImages(settings: ImageSettings): boolean {
  if (settings.provider !== 'openai') return false
  if (settings.local !== undefined) return settings.local
  return privateAddress(settings.baseURL) && !GPT_IMAGE.test(settings.model ?? providerDefault('image', 'openai').model)
}

/** What a server of the author's own is asked for while the settings name no sizes: the three a 16 GB card draws Qwen-Image at. */
export const LOCAL_SIZES: readonly string[] = ['768x768', '768x512', '512x768']

export function parseSize(size: string | undefined): { width: number; height: number } | undefined {
  const match = /^\s*(\d{2,5})\s*[xX×*]\s*(\d{2,5})\s*$/.exec(size ?? '')
  if (match === null) return undefined
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** A list of sizes as somebody types it — `768x768, 768×512 512*768` — as `WIDTHxHEIGHT`, each once; what is not a size is left out. */
export function sizeList(text: string | readonly string[] | undefined): string[] {
  const sizes: string[] = []
  for (const item of typeof text === 'string' ? text.split(/[\s,，;；、]+/) : text ?? []) {
    const parsed = parseSize(item)
    const size = parsed !== undefined ? `${parsed.width}x${parsed.height}` : undefined
    if (size !== undefined && !sizes.includes(size)) sizes.push(size)
  }
  return sizes
}

/**
 * The sizes an endpoint draws, where it draws only some: the author's list
 * (`image.sizes`), else those of a server of their own. Undefined: a picture
 * is asked for at whatever size it is wanted.
 */
export function imageSizes(settings: ImageSettings): readonly string[] | undefined {
  if (settings.provider !== 'openai') return undefined
  const named = sizeList(settings.sizes)
  if (named.length > 0) return named
  return localImages(settings) ? LOCAL_SIZES : undefined
}

/** The one of `sizes` nearest to the size wanted: nearest in shape, and of those of one shape the nearest in area. The first, where what is wanted is no size. */
export function nearestSize(wanted: string | undefined, sizes: readonly string[]): string {
  const target = parseSize(wanted)
  let best = sizes[0] ?? wanted ?? ''
  if (target === undefined) return best
  let distance = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  for (const size of sizes) {
    const parsed = parseSize(size)
    if (parsed === undefined) continue
    const shape = Math.abs(Math.log(parsed.width / parsed.height) - Math.log(target.width / target.height))
    const area = Math.abs(Math.log(parsed.width * parsed.height) - Math.log(target.width * target.height))
    // Shapes a hair apart are one shape: 1280x720 and 1920x1080 differ in nothing but pixels.
    if (shape < distance[0]! - 1e-6 || (Math.abs(shape - distance[0]!) <= 1e-6 && area < distance[1]!)) {
      best = size
      distance = [shape, area]
    }
  }
  return best
}

/**
 * What a server of the author's own says of one of its models, where its model list says it (`GET /models`: a row's
 * `limits` and `defaults`): how large a picture may be, how long a prompt, and whether pictures are drawn from a seed.
 */
export interface ImageLimits {
  maxWidth: number
  maxHeight: number
  /** The most pixels in all, where that is less than the two sides allow. */
  maxPixels?: number
  /** The longest prompt it takes, in characters. */
  promptChars?: number
  /** How many tokens of a prompt it reads. */
  promptTokens?: number
  /** It draws from a seed, and from the same one every time unless it is sent another. */
  seeded?: boolean
  /** How many steps it samples in when not told, for the author to read. */
  steps?: number
  /**
   * How many reference pictures it takes with a prompt (`reference_images.max_count`; none where it says it edits no
   * image: `capabilities.image_edit: false`). Left out where the list does not say — it is then found out by sending one.
   */
  references?: number
  /** With a reference picture it draws from a seed of its own unless sent one (`edit_defaults.seed`). */
  editSeeded?: boolean
}

/** A model's row as a server lists it, read for what it says of pictures; undefined where it says nothing of their size. */
export function imageLimitsOf(row: unknown): ImageLimits | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const { limits, defaults, capabilities, reference_images: pictures, edit_defaults: edits } = row as { limits?: Record<string, unknown>; defaults?: Record<string, unknown>; capabilities?: Record<string, unknown>; reference_images?: Record<string, unknown>; edit_defaults?: Record<string, unknown> }
  const figure = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined)
  const count = typeof pictures?.max_count === 'number' && Number.isFinite(pictures.max_count) && pictures.max_count >= 0 ? Math.floor(pictures.max_count) : undefined
  const references = capabilities?.image_edit === false ? 0 : count
  const maxWidth = figure(limits?.max_width)
  const maxHeight = figure(limits?.max_height)
  if (maxWidth === undefined || maxHeight === undefined) return undefined
  const maxPixels = figure(limits?.max_pixels)
  const promptChars = figure(limits?.max_prompt_chars)
  const promptTokens = figure(limits?.max_prompt_tokens)
  const steps = figure(defaults?.steps)
  return {
    maxWidth,
    maxHeight,
    ...(maxPixels !== undefined ? { maxPixels } : {}),
    ...(promptChars !== undefined ? { promptChars } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(typeof defaults?.seed === 'number' ? { seeded: true } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(references !== undefined ? { references } : {}),
    ...(typeof edits?.seed === 'number' ? { editSeeded: true } : {}),
  }
}

/**
 * About how many tokens an image model's text encoder makes of a prompt. The Studio has no model's tokenizer, so this
 * is a count on the safe side: every Chinese character and every Chinese or full-width punctuation mark one token, and
 * of everything else one token to 3.6 characters. It is the count the director is given to write to.
 */
export function promptTokens(text: string): number {
  let wide = 0
  for (const char of text) if (char.codePointAt(0)! >= 0x2e80) wide += 1
  return Math.ceil(wide + (text.length - wide) / 3.6)
}

/**
 * How much of what a model reads a prompt is held to. The count is an estimate; a prompt that is a little over by
 * the model's own count loses its end without anybody being told, so the Studio keeps a tenth in hand.
 */
export const PROMPT_HEADROOM = 0.9

/** Sides are asked for in whole multiples of this — what a diffusion model's latent grid takes — and no smaller than {@link SIDE_LEAST}. */
const SIDE_STEP = 32
const SIDE_LEAST = 256

/**
 * The largest picture of the shape wanted that a model's limits allow: the
 * long side as long as it may be, the other the multiple of {@link SIDE_STEP}
 * that keeps the shape best. So a 16:9 scene on a model that stops at 768
 * a side is 768x448, not the 3:2 of a list of three sizes.
 */
export function sizeWithin(wanted: string | undefined, limits: ImageLimits): string {
  const floor = (value: number): number => Math.max(SIDE_LEAST, Math.floor(value / SIDE_STEP) * SIDE_STEP)
  const most = { width: floor(limits.maxWidth), height: floor(limits.maxHeight) }
  const target = parseSize(wanted)
  const aspect = target !== undefined ? target.width / target.height : 1
  const allowed = (width: number, height: number): boolean => width >= SIDE_LEAST && height >= SIDE_LEAST && width <= most.width && height <= most.height && (limits.maxPixels === undefined || width * height <= limits.maxPixels)
  let best: { width: number; height: number } | undefined
  let distance = [Number.POSITIVE_INFINITY, 0]
  // Every size the limits allow, from the largest down: the shape first, then the pixels.
  for (let width = most.width; width >= SIDE_LEAST; width -= SIDE_STEP) {
    for (const height of new Set([floor(width / aspect), floor(width / aspect) + SIDE_STEP])) {
      if (!allowed(width, height)) continue
      const shape = Math.abs(Math.log(width / height / aspect))
      const pixels = width * height
      if (shape < distance[0]! - 0.02 || (Math.abs(shape - distance[0]!) <= 0.02 && pixels > distance[1]!)) {
        best = { width, height }
        distance = [shape, pixels]
      }
    }
  }
  return best !== undefined ? `${best.width}x${best.height}` : `${most.width}x${most.height}`
}

/**
 * What a picture wanted at a size is drawn at by the endpoint the settings name: the nearest of the sizes the author
 * listed; else, at a server of their own, the largest of that shape the server says the model takes (`limits`, where it
 * was asked) or the nearest of {@link LOCAL_SIZES}; else the size as wanted.
 */
export function fittedSize(settings: ImageSettings, wanted: string, limits?: ImageLimits): string {
  if (settings.provider === 'openai' && sizeList(settings.sizes).length === 0 && limits !== undefined && localImages(settings)) return sizeWithin(wanted, limits)
  const sizes = imageSizes(settings)
  return sizes !== undefined ? nearestSize(wanted, sizes) : wanted
}

/** How many pictures are out at once: one for a server of the author's own, whatever number is set; else the author's number. */
export function imageParallel(settings: ImageSettings): number {
  return localImages(settings) ? 1 : parallelOf(settings.concurrency)
}

/** Where pictures come from, as the author chooses it: a service by name, a server of their own (`custom`), this machine, or nowhere. */
export type ImageSource = 'none' | 'codex' | 'comfyui' | 'diffusers' | ServiceId

export function imageSourceOf(value: Pick<ImageSettings, 'provider' | 'baseURL'>): ImageSource {
  if (value.provider === 'none' || value.provider === 'codex' || value.provider === 'comfyui' || value.provider === 'diffusers') return value.provider
  if (value.provider === 'dashscope') return 'bailian'
  if (value.provider === 'openrouter') return 'openrouter'
  return serviceOf(value.baseURL) === 'openai' || value.baseURL === undefined ? 'openai' : 'custom'
}

const picked = <T extends object>(value: T, keys: readonly (keyof T)[], keep: boolean): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([key, field]) => field !== undefined && key !== 'kept' && keys.includes(key as keyof T) === keep)) as Partial<T>

/** What of the image settings is the service's (see {@link IMAGE_SERVICE_KEYS}), and what is the author's whichever service draws. */
export const imageService = (value: Partial<ImageSettings>): Partial<ImageSettings> => picked(value, IMAGE_SERVICE_KEYS, true)
export const imageWays = (value: Partial<ImageSettings>): Partial<ImageSettings> => picked(value, IMAGE_SERVICE_KEYS, false)

/**
 * The image settings once the author moves to another service: what the one they leave was set up with is remembered
 * under its name, and the one they move to comes back as they left it — or, never set up before, starts from `fresh`.
 * How pictures are drawn whichever service draws them (which picture leads, what a sheet shows, the look) stays.
 */
export function switchImage<T extends Partial<ImageSettings>>(value: T, next: ImageSource, fresh: Partial<ImageSettings>): T {
  const from = value.provider !== undefined ? imageSourceOf(value as ImageSettings) : undefined
  const kept: Record<string, Partial<ImageSettings>> = { ...value.kept }
  // Nothing is worth remembering of "off".
  if (from !== undefined && from !== 'none') kept[from] = imageService(value)
  const back = next !== 'none' ? kept[next] : undefined
  delete kept[next]
  return { ...imageWays(value), ...(back ?? fresh), ...(Object.keys(kept).length > 0 ? { kept } : {}) } as T
}

/** The same for speech; see {@link switchImage}. */
export function switchTts(value: TtsSettings, next: TtsSettings['provider'], fresh: Partial<TtsSettings>): TtsSettings {
  const kept: Record<string, Partial<TtsSettings>> = { ...value.kept }
  if (value.provider !== 'none') kept[value.provider] = picked(value, TTS_SERVICE_KEYS, true)
  const back = next !== 'none' ? kept[next] : undefined
  delete kept[next]
  return { ...picked(value, TTS_SERVICE_KEYS, false), provider: next, ...(back ?? fresh), ...(Object.keys(kept).length > 0 ? { kept } : {}) } as TtsSettings
}

/** The service part of speech settings: who speaks, where, with what model and voices. */
export function ttsService(value: Partial<TtsSettings>): Partial<TtsSettings> {
  return picked(value as TtsSettings, TTS_SERVICE_KEYS, true)
}

/** The rest of them: how the narrator is told to read, how often a line is read again — the author's ways, whoever speaks. */
export function ttsWays(value: TtsSettings): Partial<TtsSettings> {
  return picked(value, TTS_SERVICE_KEYS, false)
}

/** A speech setup, in a few words: for a list of them to choose among. */
export function speechSetupName(value: Pick<TtsSettings, 'provider' | 'baseURL' | 'model'>): string {
  const where = value.provider === 'qwen-audiogen' || value.provider === 'qwen-realtime' || value.provider === 'dashscope' ? 'Bailian'
    : value.provider === 'openrouter' ? 'OpenRouter'
      : serviceOf(value.baseURL) === 'openai' || value.baseURL === undefined ? 'OpenAI' : hostOf(value.baseURL) ?? 'custom'
  const model = (value.model ?? '').trim()
  return model.length > 0 ? `${where} · ${model.split('/').at(-1)}` : where
}

/**
 * The image settings as they hold for a book: the Studio's, with what the book has its own way with. A book that
 * names a service draws with that service as the book set it up — nothing of the Studio's service is mixed in.
 */
export function withBookImage(settings: ImageSettings, book: BookImageSettings | undefined): ImageSettings {
  if (book === undefined || Object.keys(book).length === 0) return settings
  const { kept: _mine, ...mine } = book
  const { kept: _theirs, ...theirs } = settings
  const base = book.provider !== undefined ? imageWays(theirs) : theirs
  const next = { ...base, ...Object.fromEntries(Object.entries(mine).filter(([, value]) => value !== undefined)) } as ImageSettings
  // A book that says which picture leads says so whatever an older switch of the Studio's had it at.
  if (book.lead !== undefined) delete next.sheetFirst
  // …and one that says what a portrait comes to, whatever an older switch had.
  if (book.portraits !== undefined) delete next.portraitScene
  return next
}

/** What of a book's manifest changes the settings that hold for it. */
export type BookSettings = Pick<ProjectManifest, 'image' | 'tts' | 'sound' | 'embedding' | 'context' | 'vision'>

/**
 * The settings as they hold for a book: its own pictures, speech, sound, retrieval and context budgets where it has
 * them, the Studio's for the rest. (How much of its work goes out at once is counted apart: see the core's gates.)
 */
export function withBook(settings: NovelSettings, book: BookSettings | undefined): NovelSettings {
  // Budgets that name nothing are none of the book's own.
  const context = Object.fromEntries(Object.entries(book?.context ?? {}).filter(([, value]) => value !== undefined && value !== null))
  if (book === undefined || (book.image === undefined && book.tts === undefined && book.sound === undefined && book.embedding === undefined && book.vision === undefined && Object.keys(context).length === 0)) return settings
  const { kept: _kept, ...tts } = book.tts ?? { provider: undefined }
  return {
    ...settings,
    image: withBookImage(settings.image, book.image),
    ...(book.tts !== undefined && tts.provider !== undefined ? { tts: tts as TtsSettings } : {}),
    ...(book.sound !== undefined ? { sound: book.sound } : {}),
    ...(book.embedding !== undefined ? { embedding: book.embedding } : {}),
    ...(book.vision !== undefined ? { vision: book.vision } : {}),
    ...(Object.keys(context).length > 0 ? { context: { ...settings.context, ...context } } : {}),
  }
}

/** A service pictures come from, in a few words: for a list of them to choose among. */
export function imageSetupName(value: Pick<ImageSettings, 'provider' | 'baseURL' | 'model'>): string {
  const source = imageSourceOf(value)
  const where = source === 'codex' ? 'ChatGPT' : source === 'bailian' ? 'Bailian' : source === 'openrouter' ? 'OpenRouter' : source === 'openai' ? 'OpenAI' : source === 'comfyui' ? 'ComfyUI' : source === 'diffusers' ? 'Diffusers' : hostOf(value.baseURL) ?? 'custom'
  const model = (value.model ?? '').trim()
  return model.length > 0 ? `${where} · ${model.split('/').at(-1)}` : where
}

/** What a portrait asked for with nothing said of it comes to; see `ImageSettings.portraits`. */
export type PortraitPlan = 'both' | 'scene' | 'plain'

/** What a portrait asked for with nothing said of it comes to: what the settings say — both pictures where they say nothing. */
export function portraitsOf(settings: Pick<ImageSettings, 'portraits' | 'portraitScene'>): PortraitPlan {
  if (settings.portraits === 'both' || settings.portraits === 'scene' || settings.portraits === 'plain') return settings.portraits
  return settings.portraitScene === false ? 'plain' : 'both'
}

/** Who writes the prompt that is sent; see `ImageSettings.promptWrite`. */
export type PromptWrite = 'always' | 'fit' | 'never'

/** Who writes the prompt that is sent: what the settings say — the director where the brief does not fit the model, where they say nothing. */
export function promptWriteOf(settings: Pick<ImageSettings, 'promptWrite' | 'promptCompact'>): PromptWrite {
  if (settings.promptWrite === 'always' || settings.promptWrite === 'fit' || settings.promptWrite === 'never') return settings.promptWrite
  return settings.promptCompact === false ? 'never' : 'fit'
}

/** Which picture of a person leads; see `ImageSettings.lead`. */
export type PictureLead = 'sheet' | 'portrait' | 'none'

/** Which picture of a person the others are held against: what the settings say, the design sheet where they say nothing. */
export function leadOf(settings: Pick<ImageSettings, 'lead' | 'sheetFirst'>): PictureLead {
  if (settings.lead === 'sheet' || settings.lead === 'portrait' || settings.lead === 'none') return settings.lead
  return settings.sheetFirst === false ? 'none' : 'sheet'
}


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
import { privateAddress } from './services'
import { parallelOf, type ImageSettings } from './types'

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

/** What a picture wanted at a size is drawn at by the endpoint the settings name. */
export function fittedSize(settings: ImageSettings, wanted: string): string {
  const sizes = imageSizes(settings)
  return sizes !== undefined ? nearestSize(wanted, sizes) : wanted
}

/** How many pictures are out at once: one for a server of the author's own, whatever number is set; else the author's number. */
export function imageParallel(settings: ImageSettings): number {
  return localImages(settings) ? 1 : parallelOf(settings.concurrency)
}

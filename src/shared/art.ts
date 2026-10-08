// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The look of a book's pictures: one art direction and one list of things that
 * must never be drawn. Shared by the Host (which applies them) and the Studio
 * (which shows exactly what will be applied, and where it comes from) — a
 * picture must never carry words its author cannot see.
 */

/** What a book starts from until its author writes an art direction of their own. */
export const DEFAULT_ART_STYLE = {
  zh: '精致的半写实插画风格，电影感光影，细腻笔触，统一的色调',
  en: 'refined semi-realistic illustration, cinematic lighting, delicate brushwork, cohesive palette',
} as const

/** Where an art direction comes from: the book itself, the Studio-wide setting, or the built-in starting point. */
export type ArtSource = 'book' | 'studio' | 'default'

export function builtinArtStyle(language: string): string {
  return language.toLowerCase().startsWith('zh') ? DEFAULT_ART_STYLE.zh : DEFAULT_ART_STYLE.en
}

/** The art direction in force for a book, and where it comes from. */
export function resolveArtStyle(manifest: { artStyle?: string | undefined; language: string }, studioStyle: string | undefined): { text: string; source: ArtSource } {
  const own = manifest.artStyle?.trim()
  if (own !== undefined && own.length > 0) return { text: own, source: 'book' }
  const studio = studioStyle?.trim()
  if (studio !== undefined && studio.length > 0) return { text: studio, source: 'studio' }
  return { text: builtinArtStyle(manifest.language), source: 'default' }
}

/** Split a free-form "keep these out" line into items: commas, semicolons, enumeration commas and line breaks all separate. */
export function splitAvoid(text: string | readonly string[] | undefined): string[] {
  if (text === undefined) return []
  const parts = typeof text === 'string' ? text.split(/[,，;；、\n]+/) : text.flatMap(item => (typeof item === 'string' ? item.split(/[,，;；、\n]+/) : []))
  return parts.map(item => item.trim()).filter(item => item.length > 0)
}

/** Join several avoid lists into one, first mention wins, compared without case. */
export function mergeAvoid(...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const item of list ?? []) {
      const clean = item.trim()
      const key = clean.toLowerCase()
      if (clean.length === 0 || seen.has(key)) continue
      seen.add(key)
      out.push(clean)
    }
  }
  return out
}

// ───────────────────────────── how large, and what shape ─────────────────────────────

/** The shapes a picture is asked for in: the usual upright, level and square ones. */
export const ASPECTS = ['1:1', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3'] as const
export type Aspect = typeof ASPECTS[number]

/** How fine a picture is asked for: named as a screen of that many pixels is. */
export const PICTURE_TIERS = ['720p', '1080p', '2k', '4k'] as const
export type PictureTier = typeof PICTURE_TIERS[number]

/** The pixels of the level frame each tier is named after; a picture of another shape gets as many. */
const TIER_PIXELS: Record<PictureTier, number> = { '720p': 1280 * 720, '1080p': 1920 * 1080, '2k': 2560 * 1440, '4k': 3840 * 2160 }

/** The pictures the Studio draws, each with a shape of its own. */
export const PICTURE_KINDS = ['cover', 'portrait', 'sheet', 'location', 'item', 'scene', 'panel'] as const
export type PictureKind = typeof PICTURE_KINDS[number]

/** The shape each kind of picture has unless the author chooses another: a cover stands, a stage lies. */
export const KIND_ASPECT: Record<PictureKind, Aspect> = { cover: '2:3', portrait: '1:1', sheet: '3:2', location: '16:9', item: '1:1', scene: '16:9', panel: '16:9' }

/**
 * The pixels each kind is drawn at while the author has chosen neither a
 * fineness nor a shape for it: the sizes the Studio has always used, which
 * every image service it knows takes — a design sheet a little finer than a
 * panel, because it is looked at closely and drawn once.
 */
export const KIND_SIZE: Record<PictureKind, string> = { cover: '768x1152', portrait: '1024x1024', sheet: '1536x1024', location: '1280x720', item: '1024x1024', scene: '1280x720', panel: '1280x720' }

const isAspect = (value: string): value is Aspect => (ASPECTS as readonly string[]).includes(value)
const isTier = (value: unknown): value is PictureTier => typeof value === 'string' && (PICTURE_TIERS as readonly string[]).includes(value)

/**
 * A shape at a fineness, in pixels: as many pixels as the level frame the tier
 * is named after (so 16:9 at 1080p is exactly 1920×1080), in whole multiples
 * of eight, which every image model takes.
 */
export function pixelSize(aspect: Aspect, tier: PictureTier): string {
  const [across, up] = aspect.split(':').map(Number) as [number, number]
  const eight = (value: number): number => Math.max(8, Math.round(value / 8) * 8)
  const width = eight(Math.sqrt(TIER_PIXELS[tier] * across / up))
  return `${width}x${eight(width * up / across)}`
}

/** What the settings hold about size: a fineness for everything, and a shape — or exact pixels — per kind of picture. */
export interface PictureSizes {
  resolution?: string
  /** Per kind: an aspect (`16:9`), or pixels the author typed (`1600x900`). */
  aspects?: Partial<Record<PictureKind, string>>
}

/**
 * The pixels a kind of picture is drawn at: what the author typed for it; else
 * its shape at the fineness chosen; and with nothing chosen at all, the size
 * that kind has always had.
 */
export function pictureSize(sizes: PictureSizes | undefined, kind: PictureKind): string {
  const chosen = sizes?.aspects?.[kind]?.trim().toLowerCase().replace(/[×*]/g, 'x')
  if (chosen !== undefined && /^\d{2,5}x\d{2,5}$/.test(chosen)) return chosen
  const shape = chosen !== undefined && isAspect(chosen) ? chosen : undefined
  const tier = isTier(sizes?.resolution) ? sizes.resolution : undefined
  if (shape === undefined && tier === undefined) return KIND_SIZE[kind]
  return pixelSize(shape ?? KIND_ASPECT[kind], tier ?? '720p')
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The look of a book's pictures: one art direction and one list of things that
 * must never be drawn. Shared by the Host (which applies them) and the Studio
 * (which shows exactly what will be applied, and where it comes from) — a
 * picture must never carry words its author cannot see.
 */
import type { IllustrationInfo, IllustrationParts, SceneShot, SignatureScene } from './types'
import { hashText } from './text'

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

/** One part of a prompt without the punctuation it ended on, which would otherwise sit against the next part. */
export const tidyPart = (text: string): string => text.trim().replace(/[，,；;、。.\s]+$/u, '')

/** What the picture that goes along to be changed is called, beside the one made from it. */
export const PICTURE_TO_CHANGE = { zh: '要改的原图', en: 'the picture to change' } as const

/**
 * What a picture shows in words, and what goes with those words: its subject, the art direction it carries (none, for
 * a prompt sent as written), what it keeps out, the pictures it is held against — those the service left behind too.
 * For a picture that is another one changed (the picture went along with what to change, and nothing else was said)
 * that is what was kept of the one it came from, the changes since said after its subject. What a picture is drawn
 * from when it is drawn again from words; what its anchor and its art direction are compared in.
 */
export function pictureWords(image: Pick<IllustrationInfo, 'prompt' | 'parts'>): NonNullable<IllustrationParts['base']> & { /** It carries an art direction: a prompt sent as written carries none, and gets none when drawn again. */ art: boolean } {
  const parts = image.parts
  if (parts === undefined) return { subject: image.prompt, art: true }
  // The picture one was changed from is no part of what it shows in words: not where it went along with a description
  // (as it did at first), not where the service would not take it.
  const from: readonly string[] = [PICTURE_TO_CHANGE.zh, PICTURE_TO_CHANGE.en]
  const of = parts.base ?? { ...parts, references: [...(parts.references ?? []), ...(parts.left ?? [])].filter(reference => !from.includes(reference.label)) }
  return {
    subject: of.subject,
    ...(of.style !== undefined ? { style: of.style } : {}),
    ...(of.styleSource !== undefined ? { styleSource: of.styleSource } : {}),
    ...(of.avoid !== undefined && of.avoid.length > 0 ? { avoid: of.avoid } : {}),
    ...(of.references !== undefined && of.references.length > 0 ? { references: of.references } : {}),
    art: of.style !== undefined,
  }
}

/**
 * How somebody looks, in the words every picture of them goes by: their appearance, as their card has it. (A card of
 * an earlier version may still keep phrases written for image models beside it — a "visual anchor": while it does,
 * those are what pictures go by, as they did, until they are folded into the appearance or the appearance is changed.)
 */
export function lookWords(card: { visual?: { prompt?: string | undefined } | undefined; appearance?: string | undefined; gender?: string | undefined; age?: string | undefined }): string {
  const legacy = card.visual?.prompt?.trim() ?? ''
  if (legacy.length > 0) return legacy
  // (A paragraph ends in a full stop: what is added after it is added to the sentence, not after the stop.)
  const appearance = (card.appearance ?? '').trim().replace(/[\s。．.；;，,、]+$/u, '')
  if (appearance.length === 0) return ''
  // A sex and an age the paragraph does not already give are said after it: a short appearance often names neither.
  const cjk = /[\u3400-\u9fff]/u.test(appearance)
  const gender = card.gender?.trim() ?? ''
  const years = card.age?.trim() ?? ''
  const age = /^\d+$/u.test(years) ? (cjk ? `${years}岁` : `aged ${years}`) : years
  const more = [gender, age].filter(value => value.length > 0 && !appearance.includes(value))
  return [appearance, ...more].join(cjk ? '，' : ', ')
}

/** The phrases an earlier version kept of somebody for image models, where their card still has them. */
export const legacyLook = (card: { visual?: { prompt?: string | undefined } | undefined }): string | undefined => {
  const kept = card.visual?.prompt?.trim() ?? ''
  return kept.length > 0 ? kept : undefined
}

/**
 * Which of somebody's moments a portrait is a picture of — one at most. By what says so most surely: the moment keeps
 * it as its own; its record names a moment of that title in that chapter; it was drawn from the moment's words; its
 * record names the moment by its number. (The number comes last: what the digests note is numbered by where it
 * stands in its chapter, and a chapter digested again may give that number to another moment.)
 */
export function sceneOfPicture<S extends SignatureScene>(scenes: readonly S[], path: string, record: Pick<IllustrationInfo, 'moment' | 'parts'> | undefined): S | undefined {
  const own = scenes.find(scene => scene.portrait === path)
  if (own !== undefined || record === undefined) return own
  const title = record.moment?.title?.trim() ?? ''
  // (A moment made into one frame for the picture is on record as it was told, beside the frame that was sent.)
  const piece = record.parts?.pieces?.find(part => part.of === 'scene')
  const said = piece?.told ?? piece?.text
  return (title.length > 0 ? scenes.find(scene => scene.title.trim() === title && (record.moment?.chapter === undefined || scene.chapter === undefined || record.moment.chapter === scene.chapter)) : undefined)
    ?? (said !== undefined ? scenes.find(scene => scene.text.trim().length > 0 && said.includes(tidyPart(scene.text))) : undefined)
    ?? (record.moment?.scene !== undefined ? scenes.find(scene => scene.id === record.moment!.scene) : undefined)
}

/** What a frame is made of: the words of its moment. A frame made of other words is of another telling, and is made again. */
export const shotKey = (told: string): string => hashText(tidyPart(told))

/** The frame a moment keeps ({@link SceneShot}), where it is still of the moment as it is told now. */
export const shotOf = (scene: Pick<SignatureScene, 'text' | 'shot'>): SceneShot | undefined => (scene.shot !== undefined && scene.shot.action.trim().length > 0 && scene.shot.of === shotKey(scene.text) ? scene.shot : undefined)

/**
 * The pictures drawn of one of somebody's moments, among their portraits: the one that is the moment's own first —
 * the author's choice, or the one last drawn of it — then the others, in the order the portraits are kept in.
 * @param scenes - all their moments: a picture is of one of them.
 * @param paths - their portraits, in order.
 */
export function scenePictures(scene: SignatureScene, scenes: readonly SignatureScene[], paths: readonly string[], recordOf: (path: string) => Pick<IllustrationInfo, 'moment' | 'parts'> | undefined): string[] {
  const of = paths.filter(path => sceneOfPicture(scenes, path, recordOf(path))?.id === scene.id)
  return scene.portrait !== undefined && of.includes(scene.portrait) ? [scene.portrait, ...of.filter(path => path !== scene.portrait)] : of
}

/**
 * The moments a person is remembered by, as their card has them — the single paragraph of an earlier version read as
 * a list of one ("葬花（第27章）：……" gives the moment its name).
 */
export function scenesOf(card: { visual?: { scenes?: SignatureScene[] | undefined; scene?: string | undefined } | undefined }): SignatureScene[] {
  const scenes = (card.visual?.scenes ?? []).filter(scene => scene.text.trim().length > 0)
  if (scenes.length > 0) return scenes
  const kept = card.visual?.scene?.trim() ?? ''
  if (kept.length === 0) return []
  const head = /^([^：:（(\n]{1,24})(?:[（(][^）)]*[）)])?\s*[：:]\s*([\s\S]+)$/.exec(kept)
  return [{ id: 'kept', title: head !== null ? head[1]!.trim() : [...kept].slice(0, 10).join(''), text: head !== null ? head[2]!.trim() : kept }]
}

/** The moment a portrait shows: the one named, else the one the card marks, else the first. */
export function sceneFor(card: { visual?: { scenes?: SignatureScene[] | undefined; scene?: string | undefined; sceneAt?: string | undefined } | undefined }, id?: string): SignatureScene | undefined {
  const scenes = scenesOf(card)
  return scenes.find(scene => scene.id === id) ?? (id === undefined ? scenes.find(scene => scene.id === card.visual?.sceneAt) ?? scenes[0] : undefined)
}

/** A moment as it is put before an image model: its name, then the picture. */
export function sceneWords(scene: { title: string; text: string }): string {
  return scene.title.length > 0 && !scene.text.startsWith(scene.title) ? `${scene.title}：${scene.text}` : scene.text
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

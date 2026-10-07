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

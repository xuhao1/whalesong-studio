// SPDX-License-Identifier: LGPL-3.0-or-later
/** Pure text helpers shared by Host and browser. */

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g
const CJK_ONE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/
const LATIN_WORD = /[A-Za-z0-9À-ɏЀ-ӿ]+(?:['’-][A-Za-z0-9À-ɏЀ-ӿ]+)*/g

/**
 * Length of prose the way writers count it: every CJK character is one, every
 * run of Latin letters/digits is one.
 */
export function countWords(text: string): number {
  if (text.length === 0) return 0
  const cjk = text.match(CJK)?.length ?? 0
  const latin = text.replace(CJK, ' ').match(LATIN_WORD)?.length ?? 0
  return cjk + latin
}

const IMAGE_LINE = /^[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*$/gm

/** Chapter text without embedded illustration lines (`![alt](path)`). */
export function proseOnly(text: string): string {
  if (!text.includes('![')) return text
  return text.replace(IMAGE_LINE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** Embedded illustrations of a chapter, in order. */
export function embeddedImages(text: string): { alt: string; path: string }[] {
  const out: { alt: string; path: string }[] = []
  const pattern = /^[ \t]*!\[([^\]]*)\]\(([^)]*)\)[ \t]*$/gm
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) out.push({ alt: match[1] ?? '', path: match[2] ?? '' })
  return out
}

/** Rough token estimate good enough for budgeting (CJK ≈ 1 token/char, the rest ≈ 4 chars/token). */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil(cjk * 1.05 + (text.length - cjk) / 3.6)
}

export function isCjk(char: string): boolean {
  return CJK_ONE.test(char)
}

/** Whether text is predominantly CJK. */
export function isMostlyCjk(text: string): boolean {
  const sample = text.slice(0, 4000)
  const cjk = sample.match(CJK)?.length ?? 0
  return cjk > sample.length * 0.2
}

/** Cut text to at most `max` characters on a sentence or paragraph boundary when one is near. */
export function clip(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('！'), cut.lastIndexOf('？'))
  return (boundary > max * 0.6 ? cut.slice(0, boundary + 1) : cut).trimEnd() + ellipsis
}

/** Keep the last `max` characters, starting at a paragraph or sentence boundary when one is near. */
export function clipTail(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const candidates = [cut.indexOf('\n'), cut.indexOf('。'), cut.indexOf('. ')].filter(index => index >= 0 && index < max * 0.4)
  const boundary = candidates.length > 0 ? Math.min(...candidates) : -1
  return ellipsis + (boundary >= 0 ? cut.slice(boundary + 1) : cut).trimStart()
}

/** Stable 53-bit string hash (cyrb53) rendered as hex; not cryptographic. */
export function hashText(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** Short random id with a readable prefix: `ch_k3x9q2`. */
export function newId(prefix: string): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${prefix}_${out}`
}

/** File-system friendly slug that keeps CJK characters. */
export function slugify(text: string, fallback = 'item'): string {
  const slug = text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|.,;!@#$%^&()+=[\]{}`~'，。；：！？、（）《》“”‘’·]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return slug.length > 0 ? slug : fallback
}

/** Split prose into paragraphs, dropping blank lines. */
export function paragraphs(text: string): string[] {
  return text.split(/\n+/).map(line => line.trim()).filter(line => line.length > 0)
}

/** Normalize line endings and trailing whitespace; keeps paragraph breaks as written. */
export function normalizeProse(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Loose equality for names: case-, width- and whitespace-insensitive. */
export function sameName(left: string, right: string): boolean {
  const norm = (value: string): string => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return norm(left) === norm(right)
}

/**
 * Locate `needle` in `haystack` tolerating whitespace and quote-style drift,
 * which is how a model usually misquotes a passage.
 * @returns the matched range in `haystack`, or undefined.
 */
export function fuzzyFind(haystack: string, needle: string): { start: number; end: number } | undefined {
  const exact = haystack.indexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }
  const fold = (char: string): string => {
    if (/\s/.test(char)) return ''
    if ('“”„‟"「」『』'.includes(char)) return '"'
    if ("‘’‚‛'".includes(char)) return "'"
    if (char === '…') return '...'
    if (char === '—' || char === '–') return '-'
    return char.normalize('NFKC').toLowerCase()
  }
  const map: number[] = []
  let folded = ''
  for (let i = 0; i < haystack.length; i++) {
    const piece = fold(haystack[i]!)
    for (let j = 0; j < piece.length; j++) map.push(i)
    folded += piece
  }
  let target = ''
  for (const char of needle) target += fold(char)
  if (target.length === 0) return undefined
  const at = folded.indexOf(target)
  if (at < 0) return undefined
  const start = map[at]!
  const end = map[at + target.length - 1]! + 1
  return { start, end }
}

/** Format a word count compactly: 1234 → "1.2k", 123456 → "12.3万" for CJK locales. */
export function formatCount(count: number, locale: string): string {
  if (locale.startsWith('zh')) {
    if (count >= 10000) return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)}万`
    return String(count)
  }
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`
  return String(count)
}

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
/**
 * Whether what was made of a chapter (its digest) was made of this text. Pictures placed in the text change nothing
 * that was read, so the prose is what counts; a digest made before that, of the text with its pictures, still counts.
 */
export function digestOf(hash: string, text: string): boolean {
  return hash === hashText(proseOnly(text)) || hash === hashText(text)
}

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

/** In how many places `needle` stands in `haystack`, as written — places that overlap are places all the same. */
export function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count += 1
  return count
}

const SENTENCE_ENDS = '。！？!?…'
const SENTENCE_CLOSERS = '”’」』"\'）)]】》'

/**
 * A text cut into sentences, each keeping the marks that close it and the white space that follows it — joined, they
 * are the text again, to the character. A line break ends a sentence too.
 */
export function sentences(text: string): string[] {
  const out: string[] = []
  let from = 0
  let at = 0
  while (at < text.length) {
    const char = text[at]!
    const ends = char === '\n' || SENTENCE_ENDS.includes(char)
      // (A full stop ends a sentence where white space, a closing mark or the end follows — not inside 3.14 or a.m.)
      || (char === '.' && (at + 1 >= text.length || /[\s"'”’)\]]/.test(text[at + 1]!)))
    at += 1
    if (!ends) continue
    while (at < text.length && (SENTENCE_ENDS.includes(text[at]!) || text[at] === '.')) at += 1
    while (at < text.length && SENTENCE_CLOSERS.includes(text[at]!)) at += 1
    while (at < text.length && /\s/.test(text[at]!)) at += 1
    out.push(text.slice(from, at))
    from = at
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}

/**
 * What a rewriting of a passage really changed: the passage and its rewriting with the sentences they share at
 * either end left off — the smallest stretch of whole sentences that is not the same in both. Where only something
 * was added or taken out, the sentence before it (else the one after) stays in, so that there is a place to find; and
 * the stretch is widened again, a sentence at a time, until `unique` says it is found once only.
 * @param unique - whether a stretch of the passage stands once only in the text it is part of.
 * @returns the narrowed pair and where the narrowed `before` starts in the passage; the pair as given where nothing
 *   differs or nothing is shared.
 */
export function changedCore(before: string, after: string, unique?: (stretch: string) => boolean): { before: string; after: string; start: number } {
  const whole = { before, after, start: 0 }
  if (before === after) return whole
  const was = sentences(before)
  const now = sentences(after)
  let head = 0
  while (head < was.length && head < now.length && was[head] === now[head]) head += 1
  let tail = 0
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1
  if (head === 0 && tail === 0) return whole
  const blank = (list: string[]): boolean => list.slice(head, list.length - tail).join('').trim().length === 0
  const widen = (): boolean => {
    if (head > 0) head -= 1
    else if (tail > 0) tail -= 1
    else return false
    return true
  }
  // Something only added, or only taken out: a sentence beside it is the place it is found by.
  while ((blank(was) || blank(now)) && widen()) { /* widened */ }
  const cut = (): { before: string; after: string; start: number } => {
    let left = was.slice(head, was.length - tail).join('')
    let right = now.slice(head, now.length - tail).join('')
    let start = was.slice(0, head).join('').length
    // The white space both end with (the break before what follows) belongs to neither side of the change.
    const closing = /\s*$/.exec(left)![0]
    if (closing.length > 0 && right.endsWith(closing) && right.length > closing.length) {
      left = left.slice(0, left.length - closing.length)
      right = right.slice(0, right.length - closing.length)
    }
    const opening = /^\s*/.exec(left)![0]
    if (opening.length > 0 && right.startsWith(opening)) {
      left = left.slice(opening.length)
      right = right.slice(opening.length)
      start += opening.length
    }
    return { before: left, after: right, start }
  }
  let core = cut()
  while (unique !== undefined && !unique(core.before) && widen()) core = cut()
  return core.before.length > 0 ? core : whole
}

/** One place where a text was changed: the stretch of whole sentences that is no longer what it was, what stands there now, and where the stretch began. */
export interface ChangedPart { before: string; after: string; start: number }

/** Past this many pairs of sentences the places are not told apart: the change is one stretch (see {@link changedCore}). */
const PARTS_MOST = 6_000_000

/**
 * Every place where a text was changed, each by itself: the two texts are held against one another sentence by
 * sentence, and each stretch that is not the same in both is one part — so that a text somebody went through, changing
 * a line here and a line there, comes back as those changes and not as the text written again. A part is of whole
 * sentences; where something was only added or only taken out, the sentence before it (else the one after) is in it,
 * so that there is a place to find; a part is widened, a sentence at a time, until `unique` says its `before` is found
 * once only; and parts that come to share a sentence are one.
 * @param unique - whether a stretch of `before` stands once only in the text it is to be found in.
 * @returns the parts in the order they stand, none where the texts are the same.
 */
export function changedParts(before: string, after: string, unique?: (stretch: string) => boolean): ChangedPart[] {
  if (before === after) return []
  const was = sentences(before)
  const now = sentences(after)
  let head = 0
  while (head < was.length && head < now.length && was[head] === now[head]) head += 1
  let tail = 0
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1
  const rows = was.length - head - tail
  const cols = now.length - head - tail
  if (rows * cols > PARTS_MOST) return [changedCore(before, after, unique)]
  // The longest run of sentences the two middles share, in order.
  const width = cols + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      table[row * width + col] = was[head + row] === now[head + col]
        ? table[(row + 1) * width + col + 1]! + 1
        : Math.max(table[(row + 1) * width + col]!, table[row * width + col + 1]!)
    }
  }
  // The texts as a run of units: a sentence both have, or a stretch that differs (sentences of the one, of the other).
  type Unit = { same: boolean; was: string; now: string }
  const units: Unit[] = []
  const shared = (sentence: string): void => { units.push({ same: true, was: sentence, now: sentence }) }
  const differs = (left: string, right: string): void => {
    const last = units.at(-1)
    if (last !== undefined && !last.same) {
      last.was += left
      last.now += right
    } else {
      units.push({ same: false, was: left, now: right })
    }
  }
  for (let at = 0; at < head; at++) shared(was[at]!)
  let row = 0
  let col = 0
  while (row < rows || col < cols) {
    if (row < rows && col < cols && was[head + row] === now[head + col]) {
      shared(was[head + row]!)
      row += 1
      col += 1
    } else if (col < cols && (row >= rows || table[row * width + col + 1]! >= table[(row + 1) * width + col]!)) {
      differs('', now[head + col]!)
      col += 1
    } else {
      differs(was[head + row]!, '')
      row += 1
    }
  }
  for (let at = was.length - tail; at < was.length; at++) shared(was[at]!)

  // A part is a run of units with something changed in it: [from, to).
  let parts = units.flatMap((unit, at) => unit.same ? [] : [{ from: at, to: at + 1 }])
  const cut = (part: { from: number; to: number }): ChangedPart => {
    let left = units.slice(part.from, part.to).map(unit => unit.was).join('')
    let right = units.slice(part.from, part.to).map(unit => unit.now).join('')
    let start = units.slice(0, part.from).map(unit => unit.was).join('').length
    // The white space both end with (the break before what follows) belongs to neither side of the change.
    const closing = /\s*$/.exec(left)![0]
    if (closing.length > 0 && right.endsWith(closing) && right.length > closing.length) {
      left = left.slice(0, left.length - closing.length)
      right = right.slice(0, right.length - closing.length)
    }
    const opening = /^\s*/.exec(left)![0]
    if (opening.length > 0 && right.startsWith(opening)) {
      left = left.slice(opening.length)
      right = right.slice(opening.length)
      start += opening.length
    }
    return { before: left, after: right, start }
  }
  /** Whether a part has to take in another sentence: nothing to find it by, nothing left of it, or found in more places than one. */
  const short = (part: { from: number; to: number }): boolean => {
    const made = cut(part)
    return made.before.trim().length === 0 || made.after.trim().length === 0 || (unique !== undefined && !unique(made.before))
  }
  for (let round = 0; round <= units.length; round++) {
    let widened = false
    for (const part of parts) {
      if (!short(part)) continue
      if (part.from > 0) part.from -= 1
      else if (part.to < units.length) part.to += 1
      else continue
      widened = true
    }
    // Parts that have come to share a sentence are one change. (Side by side they stay two: neither is in the other's way.)
    const joined: { from: number; to: number }[] = []
    for (const part of parts) {
      const last = joined.at(-1)
      if (last !== undefined && part.from < last.to) last.to = Math.max(last.to, part.to)
      else joined.push(part)
    }
    parts = joined
    if (!widened) break
  }
  return parts.map(cut).filter(part => part.before !== part.after)
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

/** How ffmpeg gets onto a computer, whichever system it runs — [中文, English]. */
export const FFMPEG_INSTALL: readonly [string, string] = [
  'macOS：brew install ffmpeg；Windows：winget install ffmpeg；Linux：用发行版的包管理器（如 sudo apt install ffmpeg）',
  'macOS: brew install ffmpeg; Windows: winget install ffmpeg; Linux: your distribution\'s package manager (e.g. sudo apt install ffmpeg)',
]

/** Markdown emphasis in a run of prose: `**strong**` (1), or `_em_` / `*em*` (delimiter 2, text 3) — not inside a word. */
export const EMPHASIS = /\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\p{L}\p{N}_*])([_*])(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_*])/gu

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The pictures a chapter's text has in it, and moving them about.
 *
 * A picture in the text is a line of its own — `![what it shows](path)` — between
 * the lines of prose. Where it stands is said by how many lines of prose stand
 * before it; putting it somewhere else is taking that line out and putting it
 * back after another. The page the author writes on shows them beside the text
 * and moves them there, in the text it has open; nothing here reads or writes
 * a file. No Node, no DOM.
 */

/** A picture's line, whole: what it shows in words, and where the file is. */
const PICTURE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

/** One picture in a chapter's text. */
export interface EmbeddedPicture {
  path: string
  alt: string
  /** Which of the text's lines it is. */
  line: number
  /** Where that line begins in the text. */
  offset: number
  /** How many lines of prose stand before it: it stands after that many (0: at the top). */
  after: number
  /** The line of prose it stands after, where there is one. */
  follows?: string
}

/** The pictures in a text, in the order they stand in. */
export function embeddedPictures(text: string): EmbeddedPicture[] {
  const found: EmbeddedPicture[] = []
  let offset = 0
  let prose = 0
  let last: string | undefined
  text.split('\n').forEach((line, at) => {
    const trimmed = line.trim()
    const picture = PICTURE_LINE.exec(trimmed)
    if (picture !== null) found.push({ path: picture[2]!, alt: picture[1] ?? '', line: at, offset: offset + (line.length - line.trimStart().length), after: prose, ...(last !== undefined ? { follows: last } : {}) })
    else if (trimmed.length > 0) {
      prose += 1
      last = trimmed
    }
    offset += line.length + 1
  })
  return found
}

/** How many lines of prose a text has: a picture can stand after any of them, or before the first. */
export function proseLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !PICTURE_LINE.test(line))
}

/** A text with no more than one empty line between two lines, and none at either end but the one it ended with. */
const tidyGaps = (lines: string[]): string => {
  const out: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0 && (out.length === 0 || out.at(-1)!.trim().length === 0)) continue
    out.push(line)
  }
  while (out.length > 0 && out.at(-1)!.trim().length === 0) out.pop()
  return out.join('\n')
}

/** The text without the picture on that line. A line that is no picture is left where it is. */
export function withoutPicture(text: string, line: number): string {
  const lines = text.split('\n')
  if (line < 0 || line >= lines.length || !PICTURE_LINE.test(lines[line]!.trim())) return text
  const ended = text.endsWith('\n')
  // An empty line on both sides stays one; with it gone, whatever it stood between is parted as before.
  lines.splice(line, 1, '')
  return tidyGaps(lines) + (ended ? '\n' : '')
}

/**
 * The text with a picture put in after so many lines of prose (0: before the first; more than there are: at the end),
 * a line of its own with an empty line on either side.
 */
export function withPicture(text: string, picture: { path: string; alt?: string }, after: number): string {
  const tag = `![${(picture.alt ?? '').replace(/[\]\n]/g, ' ')}](${picture.path})`
  const lines = text.split('\n')
  const ended = text.endsWith('\n')
  let prose = 0
  let at = 0
  if (after > 0) {
    at = lines.length
    for (let index = 0; index < lines.length; index++) {
      const trimmed = lines[index]!.trim()
      if (trimmed.length === 0 || PICTURE_LINE.test(trimmed)) continue
      prose += 1
      if (prose === after) {
        at = index + 1
        break
      }
    }
    // Pictures that stand after that line already keep their place: the new one goes after them.
    for (let scan = at; scan < lines.length; scan++) {
      const trimmed = lines[scan]!.trim()
      if (trimmed.length === 0) continue
      if (!PICTURE_LINE.test(trimmed)) break
      at = scan + 1
    }
  }
  lines.splice(at, 0, '', tag, '')
  return tidyGaps(lines) + (ended ? '\n' : '')
}

/**
 * The text with the picture on that line standing after so many lines of prose instead: taken out, and put back there.
 * @param line - the picture's line, as {@link embeddedPictures} says it.
 */
export function movedPicture(text: string, line: number, after: number): string {
  const picture = embeddedPictures(text).find(item => item.line === line)
  if (picture === undefined) return text
  const most = proseLines(text).length
  const to = Math.max(0, Math.min(most, after))
  if (to === picture.after) return text
  return withPicture(withoutPicture(text, line), picture, to)
}

// ───────────────────────────── the text laid out to be written in ─────────────────────────────

/**
 * Prose to type in: the lines between two pictures (or before the first, or after the last), from the first of them
 * to the end of the last — the empty lines the author left around a picture are its own, shown and kept.
 */
export interface ProseBlock {
  kind: 'prose'
  /** Where its words begin and end in the text. */
  start: number
  end: number
  /**
   * It has no line of its own yet — a picture stands on the text's first line, or on its last, or two stand on lines
   * one after the other — and what is typed here is given one: before the picture that follows (`lead`), or after
   * the one before (`tail`).
   */
  gap?: 'lead' | 'tail'
}

/** A picture: the line of markup it is in the text, whole. */
export interface PictureBlock {
  kind: 'picture'
  start: number
  end: number
  /** Which of the text's lines it is, as {@link embeddedPictures} says it. */
  line: number
  path: string
  alt: string
}

export type TextBlock = ProseBlock | PictureBlock

/**
 * A chapter's text as the page it is written on lays it out: prose and pictures in turn — prose first and last, also
 * where there is none (a place to type before a picture on the first line, between two that stand on lines one after
 * the other, after one on the last).
 */
export function textBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = []
  let offset = 0
  /** Where the prose being gathered began; `undefined` while no line of it was seen since the last picture. */
  let from: number | undefined
  let to = 0
  text.split('\n').forEach((line, at) => {
    const picture = PICTURE_LINE.exec(line.trim())
    if (picture === null) {
      if (from === undefined) from = offset
      to = offset + line.length
    } else {
      blocks.push(from !== undefined ? { kind: 'prose', start: from, end: to } : { kind: 'prose', start: offset, end: offset, gap: 'lead' })
      blocks.push({ kind: 'picture', start: offset, end: offset + line.length, line: at, path: picture[2]!, alt: picture[1] ?? '' })
      from = undefined
    }
    offset += line.length + 1
  })
  blocks.push(from !== undefined ? { kind: 'prose', start: from, end: to } : { kind: 'prose', start: text.length, end: text.length, gap: 'tail' })
  return blocks
}

/** The text with one of its stretches of prose reading otherwise. Typed where there was no line, the words get one. */
export function withProse(text: string, block: Pick<ProseBlock, 'start' | 'end' | 'gap'>, words: string): string {
  if (block.gap === undefined) return text.slice(0, block.start) + words + text.slice(block.end)
  if (words.length === 0) return text
  return block.gap === 'tail' ? `${text.slice(0, block.start)}\n${words}${text.slice(block.end)}` : `${text.slice(0, block.start)}${words}\n${text.slice(block.end)}`
}

/** The text with the picture on that line being another picture, or called otherwise. A line that is no picture is left as it is. */
export function pictureChanged(text: string, line: number, to: { path?: string; alt?: string }): string {
  const lines = text.split('\n')
  const picture = line >= 0 && line < lines.length ? PICTURE_LINE.exec(lines[line]!.trim()) : null
  if (picture === null) return text
  const path = to.path !== undefined && to.path.length > 0 && !/[)\s]/.test(to.path) ? to.path : picture[2]!
  const alt = (to.alt ?? picture[1] ?? '').replace(/[\]\n]/g, ' ')
  lines[line] = `${lines[line]!.slice(0, lines[line]!.length - lines[line]!.trimStart().length)}![${alt}](${path})`
  return lines.join('\n')
}

// ───────────────────────────── a text rewritten, with its pictures still in it ─────────────────────────────

/** A picture's markup wherever it stands in a line. */
const PICTURE_ANY = /!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g

/** What became of a text's pictures when the text was written anew. */
export interface KeptPictures {
  /** The rewriting, with the pictures the text has. */
  text: string
  /** How many pictures of the text the rewriting had left out, and got back. */
  back: number
  /** How many picture lines of the rewriting's own making — a file the text does not show, or one picture a second time — were taken out. */
  made: number
}

/** Pairs of neighbouring characters of a line, without what is not letters: what two lines are compared by. */
function pairsIn(line: string): Set<string> {
  const letters = [...line.replace(/[\s\p{P}\p{S}]+/gu, '')]
  const pairs = new Set<string>()
  for (let at = 0; at + 1 < letters.length; at++) pairs.add(`${letters[at]}${letters[at + 1]}`)
  return pairs
}

/** How alike two lines are by the pairs they share: 1 for the same letters, 0 for none in common. */
function alike(one: Set<string>, other: Set<string>): number {
  if (one.size === 0 || other.size === 0) return 0
  let shared = 0
  for (const pair of one) if (other.has(pair)) shared++
  return 2 * shared / (one.size + other.size)
}

/** How alike a rewritten line must be to the one a picture stood by to be taken for it. */
const ALIKE_ENOUGH = 0.3

/** The file a path ends in. */
const fileOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase()

/**
 * A rewriting of a text, with the pictures the text has in it. A picture is a line of the text and not of its prose:
 * whoever writes the prose anew — a model revising a passage or a chapter, translating it, drafting it again — is to
 * hand the line back where it stood, and now and then does not. So what comes back is held against the original:
 *
 * - a picture the rewriting **left out** goes back in — after the line of the rewriting most like the one it followed
 *   (or before the one most like the line that followed it; or, where nothing is alike — a chapter drafted afresh, a
 *   translation — as far down the text as it stood), pictures that stood together staying in their order;
 * - a picture line the rewriting **made up** — a path the text does not show, or one picture more often than the text
 *   has it — comes out; where as many were made up as were left out, each made-up one is read as the picture missing
 *   at its place with its path spoilt, and gets that path back;
 * - a picture the rewriting ran **into a line of prose** gets its own line again, after that line;
 * - what is said under a picture stays as the text has it, unless `captions` is `theirs` (a translation's).
 *
 * A rewriting that has every picture as the text has it comes back untouched.
 * @param options.also - files that are pictures all the same though the text does not show them: a line naming one is
 * left as it was written (text put in by a hand that may place a picture, not by a model writing prose).
 */
export function keptPictures(original: string, rewritten: string, options: { captions?: 'theirs'; also?: ReadonlySet<string> } = {}): KeptPictures {
  // ── the pictures of the text, and what each stood by ──
  interface Mine { path: string; alt: string; /** Lines of prose before it. */ after: number; /** The line of prose it followed. */ follows?: string; /** The picture it stood right after, where it stood after one. */ behind?: number; /** The line of prose that followed it. */ leads?: string }
  const mine: Mine[] = []
  let prose = 0
  let last: string | undefined
  let behind: number | undefined
  let waiting: Mine[] = []
  for (const line of original.split('\n')) {
    const found = [...line.matchAll(PICTURE_ANY)]
    const rest = found.length > 0 ? line.replace(PICTURE_ANY, '').trim() : line.trim()
    if (rest.length > 0) {
      prose += 1
      last = rest
      behind = undefined
      for (const picture of waiting) picture.leads = rest
      waiting = []
    }
    for (const match of found) {
      const picture: Mine = { path: match[2]!, alt: match[1] ?? '', after: prose, ...(last !== undefined ? { follows: last } : {}), ...(behind !== undefined ? { behind } : {}) }
      behind = mine.length
      mine.push(picture)
      waiting.push(picture)
    }
  }
  const lines = prose

  // ── the rewriting, line by line, with each picture in it read as one of the text's — or as none of them ──
  type Entry = { kind: 'prose'; line: string } | { kind: 'blank'; line: string } | { kind: 'picture'; of: number; alt: string; own: boolean } | { kind: 'made'; alt: string; own: boolean }
  const entries: Entry[] = []
  const taken = new Set<number>()
  const free = (test: (picture: Mine) => boolean): number => mine.findIndex((picture, at) => !taken.has(at) && test(picture))
  let ragged = false
  /** A picture the text does not show, and that is one all the same: its line is nobody's mistake. */
  const placed = (path: string): boolean => options.also?.has(path) === true && !mine.some(picture => picture.path === path)
  for (const line of rewritten.split('\n')) {
    const found = [...line.matchAll(PICTURE_ANY)].filter(match => !placed(match[2]!))
    if (found.length === 0) {
      entries.push(line.trim().length > 0 ? { kind: 'prose', line } : { kind: 'blank', line })
      continue
    }
    const rest = line.replace(PICTURE_ANY, (whole: string, _alt: string, path: string) => placed(path) ? whole : '')
    const alone = rest.trim().length === 0 && found.length === 1 && line.trim() === found[0]![0]
    if (rest.trim().length > 0) entries.push({ kind: 'prose', line: rest.replace(/[ \t]{2,}/g, ' ').trimEnd() })
    for (const match of found) {
      const path = match[2]!
      let of = free(picture => picture.path === path)
      if (of < 0) of = free(picture => fileOf(picture.path) === fileOf(path))
      if (of >= 0) {
        taken.add(of)
        entries.push({ kind: 'picture', of, alt: match[1] ?? '', own: !alone })
        if (!alone || mine[of]!.path !== path || match[0] !== `![${match[1] ?? ''}](${path})`) ragged = true
      } else entries.push({ kind: 'made', alt: match[1] ?? '', own: !alone })
    }
  }
  // As many made up as left out: each is the picture missing at its place, its path spoilt.
  const missing = (): number[] => mine.map((_picture, at) => at).filter(at => !taken.has(at))
  let made = entries.filter(entry => entry.kind === 'made').length
  if (made > 0 && made === missing().length) {
    const gone = missing()
    let at = 0
    entries.forEach((entry, index) => {
      if (entry.kind !== 'made') return
      const of = gone[at++]!
      taken.add(of)
      entries[index] = { kind: 'picture', of, alt: entry.alt, own: entry.own }
    })
    made = 0
    ragged = true
  }
  const gone = missing()
  const reworded = options.captions !== 'theirs' && entries.some(entry => entry.kind === 'picture' && entry.alt !== mine[entry.of]!.alt)
  if (gone.length === 0 && made === 0 && !ragged && !reworded) return { text: rewritten, back: 0, made: 0 }

  // ── the ones left out, each back where it stood ──
  const kept = entries.filter(entry => entry.kind !== 'made')
  const spoken = (): { at: number; line: string; pairs: Set<string> }[] => kept.flatMap((entry, at) => entry.kind === 'prose' ? [{ at, line: entry.line.trim(), pairs: pairsIn(entry.line) }] : [])
  /** The line of the rewriting that a line of the text became: the same one, else the one most like it — the nearer to where it is looked for, of two as like. */
  const became = (line: string | undefined, from: number, about: number): number | undefined => {
    if (line === undefined) return undefined
    const said = spoken()
    const wanted = pairsIn(line)
    let best: number | undefined
    let most = 0
    said.forEach((candidate, ordinal) => {
      if (ordinal < from) return
      const score = candidate.line === line ? 1 : wanted.size >= 3 ? alike(wanted, candidate.pairs) : 0
      if (score < ALIKE_ENOUGH) return
      if (best === undefined || score > most + 0.02 || (score > most - 0.02 && Math.abs(ordinal - about) < Math.abs(best - about))) {
        most = Math.max(most, score)
        best = ordinal
      }
    })
    return best
  }
  /** Past the pictures that stand right there and stood before this one: it goes after them. */
  const past = (at: number, of: number): number => {
    let to = at
    for (let scan = at; scan < kept.length; scan++) {
      const entry = kept[scan]!
      if (entry.kind === 'blank') continue
      if (entry.kind !== 'picture' || entry.of > of) break
      to = scan + 1
    }
    return to
  }
  /** Lines of prose the pictures put back so far stand after: none goes back above the one before it. */
  let floor = 0
  for (const of of gone) {
    const picture = mine[of]!
    const said = spoken()
    const about = lines > 0 ? Math.round(picture.after * said.length / lines) : said.length
    let at: number | undefined
    const after = picture.behind !== undefined ? kept.findIndex(entry => entry.kind === 'picture' && entry.of === picture.behind) : -1
    if (after >= 0) at = after + 1
    if (at === undefined) {
      const follows = became(picture.follows, floor, about - 1)
      if (follows !== undefined) at = past(said[follows]!.at + 1, of)
    }
    if (at === undefined) {
      const leads = became(picture.leads, floor, about)
      if (leads !== undefined) at = said[leads]!.at
    }
    if (at === undefined) {
      const down = Math.max(floor, Math.min(said.length, about))
      at = past(down === 0 ? 0 : said[down - 1]!.at + 1, of)
    }
    kept.splice(at, 0, { kind: 'picture', of, alt: picture.alt, own: true })
    floor = kept.slice(0, at).filter(entry => entry.kind === 'prose').length
  }

  // ── written out: a picture a line of its own, an empty line on either side ──
  const out: string[] = []
  const empty = (): boolean => out.length === 0 || out.at(-1)!.trim().length === 0
  let owed = false
  let closed = false
  for (const entry of withGaps(entries, kept)) {
    if (entry.kind === 'made') {
      closed = true
      continue
    }
    if (entry.kind === 'blank') {
      // (A line taken out from between two empty ones leaves one.)
      if (!(closed && empty())) out.push(entry.line)
      owed = false
      continue
    }
    if (owed && !empty()) out.push('')
    owed = false
    closed = false
    if (entry.kind === 'prose') {
      out.push(entry.line)
      continue
    }
    const picture = mine[entry.of]!
    if (entry.own && !empty()) out.push('')
    out.push(`![${(options.captions === 'theirs' ? entry.alt : picture.alt).replace(/[\]\n]/g, ' ')}](${picture.path})`)
    owed = entry.own
  }
  const lead = /^\s*/.exec(rewritten)?.[0] ?? ''
  const trail = /\s*$/.exec(rewritten)?.[0] ?? ''
  return { text: `${lead}${out.join('\n').trim()}${trail}`, back: gone.length, made }
}

/** The lines kept, with the ones taken out still marked where they stood: what is written out knows a gap they leave. */
function withGaps<Entry extends { kind: string }>(all: readonly Entry[], kept: readonly Entry[]): Entry[] {
  const out: Entry[] = []
  let at = 0
  for (const entry of kept) {
    // (Entries put back are not among `all`: they go out where they were put.)
    const found = all.indexOf(entry, at)
    if (found < 0) {
      out.push(entry)
      continue
    }
    for (let scan = at; scan < found; scan++) if (all[scan]!.kind === 'made') out.push(all[scan]!)
    out.push(entry)
    at = found + 1
  }
  for (let scan = at; scan < all.length; scan++) if (all[scan]!.kind === 'made') out.push(all[scan]!)
  return out
}

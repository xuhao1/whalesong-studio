// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the reader needs to show a chapter: the text cut into blocks, and — for
 * listening — where each line of the audio script sits in that text, so the
 * line being spoken can be shown in the prose itself. Shared by the Studio's
 * reader and the one served to other devices; no Node, no DOM.
 */

export type Block =
  | { kind: 'paragraph'; text: string; offset: number }
  | { kind: 'image'; alt: string; path: string; offset: number }
  | { kind: 'break'; offset: number }
  | { kind: 'heading'; text: string; offset: number }

/** Split chapter text into blocks, remembering where each starts. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const at = offset + (line.length - line.trimStart().length)
    offset += line.length + 1
    if (trimmed.length === 0) continue
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(trimmed)
    if (image !== null) blocks.push({ kind: 'image', alt: image[1] ?? '', path: image[2]!, offset: at })
    else if (/^(\*\s*\*\s*\*|-{3,}|—{2,}|＊\s*＊\s*＊)$/.test(trimmed)) blocks.push({ kind: 'break', offset: at })
    else if (/^#{1,4}\s+/.test(trimmed)) blocks.push({ kind: 'heading', text: trimmed.replace(/^#{1,4}\s+/, ''), offset: at })
    else blocks.push({ kind: 'paragraph', text: trimmed, offset: at })
  }
  return blocks
}

/** A stretch of the chapter text, as character offsets. */
export interface TextRange {
  start: number
  end: number
}

/** Characters that are compared when a script line is looked for in the text: everything but white space. */
function squeeze(text: string): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (/\s/.test(char)) continue
    out += char
    at.push(index)
  }
  return { text: out, at }
}

/** How far ahead of where the last line ended the next one is looked for, in squeezed characters. */
const LOOKAHEAD = 4000

/** The longest beginning (or end) of `needle`, of one of these lengths, that occurs in `hay` at or after `from`. */
function anchor(hay: string, needle: string, from: number, end: boolean): { at: number; length: number } | undefined {
  for (const length of [10, 8, 6, 4, 3, 2]) {
    if (needle.length < length) continue
    const piece = end ? needle.slice(-length) : needle.slice(0, length)
    const at = hay.indexOf(piece, from)
    if (at >= 0) return { at, length }
  }
  return undefined
}

/**
 * Find each script line in the chapter text. The script is the chapter word
 * for word, in order, but its lines ignore paragraph breaks and dialogue has
 * lost its quotation marks — so lines are matched with white space left out,
 * one after the other. A line that is not there verbatim — the director joined
 * two halves of a quote around its "he said", or changed a mark of punctuation
 * — is placed by how it begins and how it ends; failing that it simply has no
 * place, and the lines after it are still found.
 * @returns the range of each line that was found, by line id.
 */
export function alignScript(text: string, lines: readonly { id: string; text: string }[]): Map<string, TextRange> {
  const body = squeeze(text)
  const found = new Map<string, TextRange>()
  let cursor = 0
  for (const line of lines) {
    // Quotation marks inside a line (a quote within a quote) may differ from the text's; they are not what a line is known by.
    const needle = squeeze(line.text).text
    if (needle.length === 0) continue
    const window = body.text.slice(cursor, cursor + LOOKAHEAD + needle.length)
    let at = window.indexOf(needle)
    let length = needle.length
    if (at < 0) {
      const head = anchor(window, needle, 0, false)
      if (head === undefined) continue
      at = head.at
      // Where it ends: its last words, looked for no further than a line of its length could reach.
      const reach = window.slice(0, at + needle.length * 2 + 40)
      const tail = needle.length > head.length ? anchor(reach, needle, at + Math.max(head.length, Math.floor(needle.length * 0.5)), true) : undefined
      length = tail !== undefined ? tail.at + tail.length - at : Math.min(needle.length, window.length - at)
    }
    const first = cursor + at
    const last = first + length - 1
    if (length <= 0 || last >= body.at.length) continue
    found.set(line.id, { start: body.at[first]!, end: body.at[last]! + 1 })
    cursor = last + 1
  }
  return found
}

/** A piece of a paragraph: plain text, or the part of it one script line covers. */
export interface Segment {
  text: string
  /** Id of the script line this piece belongs to, when it belongs to one. */
  line?: string
}

/**
 * Cut one paragraph into the pieces its script lines cover.
 * @param ranges - line ranges sorted by start, as `alignScript` found them.
 */
export function segmentsOf(block: { text: string; offset: number }, ranges: readonly { id: string; start: number; end: number }[]): Segment[] {
  const from = block.offset
  const to = block.offset + block.text.length
  const segments: Segment[] = []
  let at = from
  for (const range of ranges) {
    if (range.end <= from) continue
    if (range.start >= to) break
    const start = Math.max(range.start, at)
    const end = Math.min(range.end, to)
    if (end <= start) continue
    if (start > at) segments.push({ text: block.text.slice(at - from, start - from) })
    segments.push({ text: block.text.slice(start - from, end - from), line: range.id })
    at = end
  }
  if (at < to) segments.push({ text: block.text.slice(at - from) })
  return segments
}

/** A subtitle holds about this many characters before the next sentence waits its turn. */
const SUBTITLE_CHARS = 38

/**
 * The part of a line that is being spoken now. A take of narration runs for
 * half a minute and several paragraphs; what belongs under a picture is the
 * sentence the voice has reached, found by how far through the line it is.
 * @param fraction - how far through the line playback is, 0 to 1.
 */
export function subtitleOf(text: string, fraction: number): string {
  const sentences = (text.match(/[^。！？!?…\n]+[。！？!?…]*["”’」』）)]*|\n+/g) ?? [text]).map(piece => piece.trim()).filter(piece => piece.length > 0)
  if (sentences.length <= 1) return text.trim()
  // Short sentences share a subtitle, so the words do not flicker past.
  const groups: string[] = []
  for (const sentence of sentences) {
    const last = groups.at(-1)
    if (last !== undefined && last.length + sentence.length <= SUBTITLE_CHARS) groups[groups.length - 1] = `${last}${/[A-Za-z0-9.,;:!?'")\]]$/.test(last) ? ' ' : ''}${sentence}`
    else groups.push(sentence)
  }
  const total = groups.reduce((sum, group) => sum + group.length, 0)
  const at = Math.max(0, Math.min(1, fraction)) * total
  let passed = 0
  for (const group of groups) {
    passed += group.length
    if (at < passed) return group
  }
  return groups.at(-1)!
}

/** A line of the plot as a reader takes it: its name, where it parts and what choosing it means, and what is read along it. */
export interface ReaderLine {
  /** `main` for the main line. */
  id: string
  /** Empty for the main line: a page names that one in its own words. */
  title: string
  premise?: string
  /** The chapter it leaves after, and what is decided there to go this way. */
  from?: string
  choice?: string
  /** Ids of the chapters read along it that have text, in order. */
  path: string[]
  /** How many of them are its own. */
  own: number
}

/** Another way the story goes on after a chapter: the line, and the chapter it goes on with. */
export interface ReaderWay<C> {
  line: ReaderLine
  next: C
  /** The line leaves right here: taking it is a choice, in its own words. */
  leaves: boolean
}

/**
 * What is read along a line of the plot, and where the story parts after a chapter.
 *
 * A book that goes one way has no lines to choose between: its chapters are
 * what is read. Where it goes several ways, a reader reads along the line
 * they chose — and a chapter that line does not go through is read along its
 * own, so that a link into another line does not lose the way on.
 * @param every - every chapter the book has to read, of whichever line (`line` absent for the main one).
 * @param lines - the lines a reader may take; absent or one for a book that goes one way.
 * @param chosen - the line chosen on the device.
 * @param at - the chapter being read, if one is.
 */
export function readAlong<C extends { id: string; line?: string }>(every: readonly C[], lines: readonly ReaderLine[] | undefined, chosen: string, at: string | undefined): { line: ReaderLine | undefined; chapters: C[]; ways: ReaderWay<C>[] } {
  if (lines === undefined || lines.length < 2) return { line: undefined, chapters: every.filter(chapter => chapter.line === undefined), ways: [] }
  const known = new Map(every.map(chapter => [chapter.id, chapter]))
  const pathOf = (line: ReaderLine): C[] => line.path.map(id => known.get(id)).filter((chapter): chapter is C => chapter !== undefined)
  const wanted = lines.find(line => line.id === chosen) ?? lines[0]!
  const home = at !== undefined && known.has(at) && !wanted.path.includes(at) ? lines.find(line => line.id === (known.get(at)?.line ?? 'main')) ?? lines.find(line => line.path.includes(at)) : undefined
  const line = home ?? wanted
  const chapters = pathOf(line)
  const ways: ReaderWay<C>[] = []
  const here = at !== undefined ? chapters.findIndex(chapter => chapter.id === at) : -1
  if (here >= 0) {
    const onward = chapters[here + 1]
    for (const other of lines) {
      if (other.id === line.id) continue
      const path = pathOf(other)
      const there = path.findIndex(chapter => chapter.id === at)
      const next = there >= 0 ? path[there + 1] : undefined
      // The same next chapter is the same way on, whichever line it is counted to.
      if (next === undefined || next.id === onward?.id || ways.some(way => way.next.id === next.id)) continue
      ways.push({ line: other, next, leaves: other.from === at })
    }
  }
  return { line, chapters, ways }
}

/** A picture shown beside the text without being part of it: somebody's moment, drawn, where the chapter tells it. */
export interface ChapterFigure {
  /** The picture, as a path of the book's own files. */
  path: string
  /** What stands under it: the moment, and whose it is. */
  caption: string
  /** Where it stands: after the paragraph that begins at this offset of the text. */
  after: number
}

/** Pairs of neighbouring characters of a text, without what is not letters: what two texts are compared by. */
function pairsOf(text: string): Set<string> {
  const letters = [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  const pairs = new Set<string>()
  for (let at = 0; at + 1 < letters.length; at++) pairs.add(`${letters[at]}${letters[at + 1]}`)
  return pairs
}

/**
 * Where the pictures of people's moments stand in a chapter: each after the paragraph that tells most of what the
 * moment says (by the words they share — the moment is written as a picture, not quoted from the page), a moment
 * nothing of the chapter tells at its end. A picture the text shows already is not shown twice.
 */
export function placeFigures(text: string, moments: readonly { path: string; caption: string; told: string }[]): ChapterFigure[] {
  const paragraphs = blocksOf(text).filter((block): block is Extract<Block, { kind: 'paragraph' }> => block.kind === 'paragraph')
  if (paragraphs.length === 0) return []
  const spoken = paragraphs.map(block => pairsOf(block.text))
  const figures: ChapterFigure[] = []
  for (const moment of moments) {
    if (text.includes(moment.path) || figures.some(figure => figure.path === moment.path)) continue
    const wanted = pairsOf(moment.told)
    let best = paragraphs.length - 1
    let most = 0
    spoken.forEach((pairs, at) => {
      let shared = 0
      for (const pair of wanted) if (pairs.has(pair)) shared++
      if (shared > most) {
        most = shared
        best = at
      }
    })
    figures.push({ path: moment.path, caption: moment.caption, after: paragraphs[best]!.offset })
  }
  return figures
}

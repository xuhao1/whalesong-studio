// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the reader needs to show a chapter: the text cut into blocks, and — for
 * listening — where each line of the audio script sits in that text, so the
 * line being spoken can be shown in the prose itself. Shared by the Studio's
 * reader and the one served to other devices; no Node, no DOM.
 */
import { countWords } from './text'

/**
 * How large the pictures of a chapter stand in its text: their width as a part of the text's own — 1, as wide as the
 * text, is the standard, and what a reader who chose nothing has — or `screen`, as wide as the screen it is read on.
 */
export type PictureSize = number | 'screen'

/** The sizes a reader steps through, smaller to larger: the text's own width in the middle, the screen's at the end. */
export const PICTURE_SIZES: readonly PictureSize[] = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 'screen']

/** What the sizes were called while they had names (two releases, a day): each read as the step nearest what it was. */
const NAMED_SIZES: Readonly<Record<string, PictureSize>> = { small: 0.5, medium: 0.65, large: 0.8, full: 1, screen: 'screen' }

/** A size as it was kept — on a device, in a published page — as one of the steps; nothing where it is no size. */
export function knownPictureSize(raw: unknown): PictureSize | undefined {
  const value = typeof raw === 'string' ? NAMED_SIZES[raw] : raw
  if (value === 'screen') return 'screen'
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const widths = PICTURE_SIZES.filter((step): step is number => typeof step === 'number')
  return widths.reduce((nearest, step) => (Math.abs(step - value) < Math.abs(nearest - value) ? step : nearest), 1)
}

/** The size pictures stand at: what was kept, or the standard — as wide as the text. */
export const pictureSizeOf = (raw: unknown): PictureSize => knownPictureSize(raw) ?? 1

/** The room a picture has on a page: how wide the text runs, and how wide the pane the page scrolls in is. */
export interface PictureRoom {
  text: number
  pane: number
}

/** How wide a picture of that size stands on such a page: so much of the text's width, and never wider than the pane. */
export const pictureWidth = (size: PictureSize, room: PictureRoom): number => (size === 'screen' ? room.pane : Math.min(room.pane, room.text * size))

/**
 * One step smaller or larger; the size itself at either end.
 * @param room - the page being looked at, where there is one: a step that would change nothing on it is passed over
 *   (on a narrow pane every size past the text's width is the pane's width), and the first size that fills the pane
 *   is "as wide as the screen". Without it, the next size in the row.
 */
export function stepPictureSize(size: PictureSize, by: -1 | 1, room?: PictureRoom): PictureSize {
  const now = pictureSizeOf(size)
  const at = PICTURE_SIZES.indexOf(now)
  if (room === undefined) return PICTURE_SIZES[Math.min(PICTURE_SIZES.length - 1, Math.max(0, at + by))]!
  const wide = pictureWidth(now, room)
  if (by > 0) {
    const next = PICTURE_SIZES.slice(at + 1).find(candidate => pictureWidth(candidate, room) > wide + 1)
    return next === undefined ? now : pictureWidth(next, room) >= room.pane - 0.5 ? 'screen' : next
  }
  return PICTURE_SIZES.slice(0, at).reverse().find(candidate => pictureWidth(candidate, room) < wide - 1) ?? now
}

/** Whether a picture of that size fills the pane of such a page from edge to edge. */
export const fillsPane = (size: PictureSize, room: PictureRoom | undefined): boolean => size === 'screen' || (room !== undefined && size > 1 && pictureWidth(size, room) >= room.pane - 0.5)

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
  /** What this place of it is known by ({@link PortraitPlace.key}): what keeping it out of the text is said of. */
  key?: string
  /** What stands under it: the moment, and whose it is. */
  caption: string
  /** Where it stands: after the paragraph that begins at this offset of the text. */
  after: number
}

/** A portrait of somebody and where it stands in the book — or would, were it in the text: what the author is shown to say which of them the text carries. */
export interface PortraitPlace {
  /**
   * What this place is known by where the author's say on it is kept: the picture's path — or, for the place a
   * picture of a moment has as the portrait that stands for the person, the path with `#face` after it.
   */
  key: string
  path: string
  /** Whose it is: their card and their name. */
  character: string
  name: string
  /** The moment it is of, where it is of one. */
  title?: string
  /** The chapter it stands in: its moment's, else the one they first come on in. Absent while no chapter has them yet. */
  chapter?: string
  /** That chapter as it is counted along its line, and what it is called. */
  index?: number
  chapterTitle?: string
  /** What the place is the picture's as: one of their moments, a period of their life, or the person. */
  as: 'moment' | 'period' | 'person'
  /** It is not in the text: kept out by the author, or `spare` and not asked in. */
  hidden: boolean
  /**
   * Why it does not stand in the text by itself: `moment` — another picture of the same moment does; `person` —
   * another portrait is the one that stands for them (the author's choice, on their page); `chapter` — a moment of
   * theirs is shown right there — at the same place of the chapter, or so near that both would be seen together — and
   * that is the picture of them there. The author can ask it in all the same.
   */
  spare?: 'moment' | 'person' | 'chapter'
}

/** Pairs of neighbouring characters of a text, without what is not letters: what two texts are compared by. */
function pairsOf(text: string): Set<string> {
  const letters = [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  const pairs = new Set<string>()
  for (let at = 0; at + 1 < letters.length; at++) pairs.add(`${letters[at]}${letters[at + 1]}`)
  return pairs
}

/** What a picture is placed by in a chapter. */
export interface FigureToPlace {
  /** What the text is searched for: the moment as it is written — or, where `names` are given, nothing that matters. */
  told: string
  /**
   * A picture of the person, not of a moment: it stands where the chapter first names them — by any of these names —
   * and not where most is said of them.
   */
  names?: readonly string[]
}

/** A place in a chapter: the paragraph a picture stands after, by its number among the paragraphs and where it begins in the text. */
export interface FigureSpot { paragraph: number; offset: number }

/**
 * Where pictures stand in a chapter, one answer for each asked: a picture of somebody's moment after the paragraph
 * that tells most of what the moment says (by the words they share — the moment is written as a picture, not quoted
 * from the page), a moment nothing of the chapter tells at its end; a picture of the person after the first paragraph
 * that names them. Nothing for a chapter with no paragraph.
 */
export function figureSpots(text: string, asked: readonly FigureToPlace[]): (FigureSpot | undefined)[] {
  const paragraphs = blocksOf(text).filter((block): block is Extract<Block, { kind: 'paragraph' }> => block.kind === 'paragraph')
  if (paragraphs.length === 0) return asked.map(() => undefined)
  let spoken: Set<string>[] | undefined
  return asked.map((figure) => {
    const names = (figure.names ?? []).map(name => name.trim()).filter(name => [...name].length >= 2)
    if (names.length > 0) {
      const first = paragraphs.findIndex(block => names.some(name => block.text.includes(name)))
      if (first >= 0) return { paragraph: first, offset: paragraphs[first]!.offset }
    }
    spoken ??= paragraphs.map(block => pairsOf(block.text))
    const wanted = pairsOf(figure.told)
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
    return { paragraph: best, offset: paragraphs[best]!.offset }
  })
}

/**
 * How much text may lie between two pictures of the same person for them to count as standing in one place: about
 * what a small screen shows at once. Nearer than this, a reader would have both before them.
 */
export const FIGURES_NEAR = 400

/** Whether two places of a chapter are so near each other that pictures at both would be seen together. */
export function spotsNear(text: string, one: FigureSpot | undefined, other: FigureSpot | undefined): boolean {
  // A chapter that has nowhere to put them has them in one place.
  if (one === undefined || other === undefined) return true
  if (one.paragraph === other.paragraph) return true
  const between = text.slice(Math.min(one.offset, other.offset), Math.max(one.offset, other.offset))
  return countWords(between) <= FIGURES_NEAR
}

/**
 * Where the pictures shown beside a chapter stand in it ({@link figureSpots}). A picture the text shows already is
 * not shown twice.
 */
export function placeFigures(text: string, moments: readonly (FigureToPlace & { path: string; key?: string; caption: string })[]): ChapterFigure[] {
  const spots = figureSpots(text, moments)
  const figures: ChapterFigure[] = []
  moments.forEach((moment, at) => {
    const spot = spots[at]
    if (spot === undefined || text.includes(moment.path) || figures.some(figure => figure.path === moment.path)) return
    figures.push({ path: moment.path, ...(moment.key !== undefined ? { key: moment.key } : {}), caption: moment.caption, after: spot.offset })
  })
  return figures
}

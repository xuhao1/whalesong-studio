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

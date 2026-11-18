// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Which paragraph of a chapter's text each beat of its plan begins at (#483).
 *
 * The text stays prose: nothing is written into it. Where a beat begins is kept beside it, as the opening words of
 * the paragraph it begins at — so a chapter edited by hand keeps the beats it can still be matched to, and loses
 * only those whose opening paragraph was rewritten. The writer marks each beat as it writes a part
 * (`【节拍 n】` on a line of its own); the marks are taken out of the text and kept here.
 */
import type { Beat } from '../shared/types'

/** Where one beat begins: the beat's id, and the opening words of the paragraph it begins at. */
export interface BeatMark {
  beat: string
  head: string
}

/** What a chapter keeps of its beats, beside its text. */
export interface ChapterBeatMarks {
  chapterId: string
  marks: BeatMark[]
}

const HEAD_CHARS = 24

/** A line the writer marks a beat's start with: `【节拍 3】`, `[[beat 3]]`, `[Beat 3]` and the like. */
const MARK_LINE = /^\s*(?:[【\[]{1,2}|<!--)\s*(?:节拍|beat)\s*[#＃:：]?\s*(\d+)\s*(?:[】\]]{1,2}|-->)\s*$/i

/** The opening words a paragraph is known by. */
export function headOf(paragraph: string): string {
  return paragraph.replace(/\s+/g, '').slice(0, HEAD_CHARS)
}

/** The paragraphs of a text: each line with words in it (a Chinese text runs one paragraph to a line). */
function paragraphs(text: string): string[] {
  return text.split('\n').filter(line => line.trim().length > 0)
}

/**
 * Take the beat marks out of a piece the writer wrote for beats `from`…`to` (indices into `beats`).
 * The first beat of the piece begins at its first paragraph whether or not it was marked; a mark of a beat outside
 * the piece, or out of order, is dropped (the line comes out all the same). `opens` false: the piece goes on with
 * beat `from`, begun before it.
 */
export function takeMarks(piece: string, beats: readonly Beat[], from: number, to: number, opens = true): { text: string; marks: BeatMark[] } {
  const kept: string[] = []
  const marks: BeatMark[] = []
  // (A piece that goes on with a beat already begun does not begin it: its first beat is marked only where the writer marks it.)
  let pending: number | undefined = opens ? from : undefined
  let last = from - 1
  for (const line of piece.split('\n')) {
    const mark = MARK_LINE.exec(line)
    if (mark !== null) {
      const index = Number(mark[1]) - 1
      if (index >= from && index <= to && index > last) pending = index
      continue
    }
    if (pending !== undefined && line.trim().length > 0) {
      const beat = beats[pending]
      if (beat !== undefined && pending > last) {
        marks.push({ beat: beat.id, head: headOf(line) })
        last = pending
      }
      pending = undefined
    }
    kept.push(line)
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), marks }
}

/** Every beat that can still be found in the text, with the paragraph it begins at, in the text's order. */
export function locateBeats(text: string, beats: readonly Beat[], marks: readonly BeatMark[]): { index: number; beat: Beat; paragraph: number }[] {
  const heads = paragraphs(text).map(headOf)
  const found: { index: number; beat: Beat; paragraph: number }[] = []
  let after = -1
  for (const mark of marks) {
    const index = beats.findIndex(beat => beat.id === mark.beat)
    if (index < 0 || mark.head.length === 0) continue
    const paragraph = heads.findIndex((head, at) => at > after && head.startsWith(mark.head))
    if (paragraph < 0) continue
    found.push({ index, beat: beats[index]!, paragraph })
    after = paragraph
  }
  return found
}

/** The beat the end of the text is in: the last beat found in it. */
export function lastBeat(text: string, beats: readonly Beat[], marks: readonly BeatMark[]): number | undefined {
  return locateBeats(text, beats, marks).at(-1)?.index
}

/** The beats a stretch of the text (by character offsets) lies in: from the one it starts in to the one it ends in. */
export function beatsAt(text: string, beats: readonly Beat[], marks: readonly BeatMark[], start: number, end: number): number[] {
  const located = locateBeats(text, beats, marks)
  if (located.length === 0) return []
  // The paragraph an offset falls in, counted the way `paragraphs` counts.
  const paragraphAt = (offset: number): number => paragraphs(text.slice(0, Math.max(0, offset))).length - (/\n\s*$/.test(text.slice(0, offset)) || offset === 0 ? 0 : 1)
  const beatOf = (paragraph: number): number | undefined => [...located].reverse().find(entry => entry.paragraph <= paragraph)?.index
  const first = beatOf(paragraphAt(start)) ?? located[0]!.index
  const last = beatOf(paragraphAt(Math.max(start, end - 1))) ?? first
  const out: number[] = []
  for (let index = first; index <= last; index++) out.push(index)
  return out
}

/** The marks kept, with those of beats from `from` on dropped (they are being written again) and `added` after them. */
export function joinMarks(kept: readonly BeatMark[], beats: readonly Beat[], from: number, added: readonly BeatMark[]): BeatMark[] {
  const later = new Set(beats.slice(from).map(beat => beat.id))
  return [...kept.filter(mark => !later.has(mark.beat)), ...added]
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A character at a chapter: which stretch of their life holds there, and the
 * card as it reads in that stretch. Shared by the Host (which writes and draws
 * by it) and the pages that show somebody at a moment of the story.
 */
import type { CharacterCard, CharacterStage } from './types'

/**
 * The stretch that holds at a chapter of a line: the last one that has begun by then. A stretch that begins at a
 * chapter the line does not have is another line's.
 * @param path - the line's chapters, by id, in reading order.
 * @param chapter - the chapter asked about; left out: the end of the line.
 */
export function stageAt(card: Pick<CharacterCard, 'stages'>, chapter: string | undefined, path: readonly string[]): CharacterStage | undefined {
  const stages = card.stages ?? []
  if (stages.length === 0) return undefined
  const at = chapter !== undefined ? path.indexOf(chapter) : path.length - 1
  let found: CharacterStage | undefined
  let reached = -2
  for (const stage of stages) {
    const begins = stage.from === undefined ? -1 : path.indexOf(stage.from)
    if (stage.from !== undefined && begins < 0) continue
    // A chapter that is not on the line is read as its end.
    if (begins <= (at < 0 ? path.length - 1 : at) && begins >= reached) {
      found = stage
      reached = begins
    }
  }
  return found
}

/** Whether a stretch says how they look in words of its own: then the card's look, and its pictures, are of another time. */
export function looksApart(stage: CharacterStage | undefined): boolean {
  return (stage?.visual?.prompt ?? '').trim().length > 0 || (stage?.appearance ?? '').trim().length > 0
}

/**
 * The card as it reads in one stretch of their life: that stretch's age, look and pictures in place of the card's.
 * Where the stretch looks different and has no sheet of its own yet, the card's pictures are left out rather than
 * passed off as this time's — a picture is then drawn from this stretch's words.
 */
export function inStage<T extends CharacterCard>(card: T, stage: CharacterStage | undefined): T {
  if (stage === undefined) return card
  const apart = looksApart(stage)
  const { prompt: _prompt, negative: _negative, sheet: _sheet, sheetFront: _front, portrait: _portrait, ...kept } = card.visual ?? {}
  const prompt = stage.visual?.prompt?.trim() || (apart ? undefined : card.visual?.prompt)
  const negative = stage.visual?.negative?.trim() || card.visual?.negative
  const sheet = stage.visual?.sheet ?? (apart ? undefined : card.visual?.sheet)
  // Whether the sheet is the front view alone goes with the sheet that is used: the stretch's own, or the card's.
  const front = stage.visual?.sheet !== undefined ? stage.visual.sheetFront === true : sheet !== undefined && card.visual?.sheetFront === true
  const portrait = stage.visual?.portrait ?? (apart ? undefined : card.visual?.portrait)
  const visual = { ...kept, ...(prompt !== undefined ? { prompt } : {}), ...(negative !== undefined ? { negative } : {}), ...(sheet !== undefined ? { sheet } : {}), ...(front ? { sheetFront: true } : {}), ...(portrait !== undefined ? { portrait } : {}) }
  return {
    ...card,
    ...(stage.age !== undefined ? { age: stage.age } : {}),
    ...(stage.appearance !== undefined ? { appearance: stage.appearance } : {}),
    ...(Object.keys(visual).length > 0 ? { visual } : { visual: undefined }),
  }
}

/** A stretch in a line of words: 少年（约十三岁）· 从第 23 章起. */
export function stageLine(stage: CharacterStage, index: number | undefined, zh: boolean): string {
  const since = stage.from === undefined ? (zh ? '故事开始时' : 'as the story begins') : index !== undefined ? (zh ? `从第 ${index} 章起` : `from chapter ${index}`) : ''
  return [`${stage.title}${stage.age !== undefined ? (zh ? `（${stage.age}）` : ` (${stage.age})`) : ''}`, since].filter(part => part.length > 0).join(' · ')
}

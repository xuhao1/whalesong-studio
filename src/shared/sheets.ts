// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The design sheets kept of a person, and what each is used as.
 *
 * A person has several: one is the main sheet — what every picture of them
 * is held against; some are the sheets of stretches of their life; the rest
 * are kept without being in use (an earlier one, one drawn to try). A sheet
 * drawn again does not take the one before it away: it joins them, and the
 * author says which is which. Shared by the Host, which keeps the card by
 * these rules, and the page that shows them.
 */
import type { CharacterCard } from './types'

type Sheeted = Pick<CharacterCard, 'visual' | 'stages'>

/** One of the design sheets kept of a person, and what it is used as. */
export interface SheetOf {
  path: string
  /** `main`: what every picture of them is held against; `stage`: the sheet of a stretch of their life; `spare`: kept, not in use. */
  as: 'main' | 'stage' | 'spare'
  /** The stretch it is the sheet of, by id. */
  stage?: string
  /** It shows the front view alone, not the person three times. */
  front: boolean
  /** The main one because the author chose it — not only for being the newest. */
  chosen?: boolean
}

/** The sheets of the stretches of their life, by path, each with its stretch's id. */
export function stageSheets(card: Sheeted): Map<string, string> {
  const out = new Map<string, string>()
  for (const stage of card.stages ?? []) {
    const path = stage.visual?.sheet
    if (path !== undefined && path.length > 0 && !out.has(path)) out.set(path, stage.id)
  }
  return out
}

/**
 * Every sheet kept of them that is not of a look, in order: the list the card keeps — or, on a card that keeps none
 * yet, the one sheet it names — and the sheets of their stretches that the list does not have.
 */
export function sheetPool(card: Sheeted): string[] {
  const listed = card.visual?.sheets ?? (card.visual?.sheet !== undefined ? [card.visual.sheet] : [])
  const pool = [...new Set(listed.filter(path => path.length > 0))]
  for (const path of stageSheets(card).keys()) if (!pool.includes(path)) pool.push(path)
  return pool
}

/** Every picture a card keeps of its person: their sheets — the main one, a stretch's, a look's — and their portraits. */
export function picturesKept(card: Sheeted): string[] {
  const visual = card.visual
  return [...new Set([
    ...sheetPool(card),
    ...(visual?.sheet !== undefined ? [visual.sheet] : []),
    ...(visual?.portrait !== undefined ? [visual.portrait] : []),
    ...(visual?.portraits ?? []),
    ...(visual?.looks ?? []).flatMap(look => (look.sheet !== undefined ? [look.sheet] : [])),
    ...(card.stages ?? []).flatMap(stage => [stage.visual?.sheet, stage.visual?.portrait].filter((path): path is string => path !== undefined)),
  ].filter(path => path.length > 0))]
}

/** Which of their sheets show the front view alone: the list the card keeps, or what its sheets say of themselves one by one. */
export function sheetFronts(card: Sheeted): Set<string> {
  if (card.visual?.fronts !== undefined) return new Set(card.visual.fronts)
  const fronts = new Set<string>()
  if (card.visual?.sheet !== undefined && card.visual.sheetFront === true) fronts.add(card.visual.sheet)
  for (const stage of card.stages ?? []) if (stage.visual?.sheet !== undefined && stage.visual.sheetFront === true) fronts.add(stage.visual.sheet)
  return fronts
}

/**
 * The main sheet among them: the one the author chose, while it is among them and no stretch's; else the one that is
 * the main sheet now, while it still can be — the main sheet does not change because another sheet came or went;
 * else the first that is no stretch's.
 * @param staged - the sheets that are a stretch's: none of them is the main one.
 * @param current - the main sheet as the card has it.
 */
export function mainSheetOf(pool: readonly string[], staged: { has: (path: string) => boolean }, chosen: string | undefined, current?: string | undefined): { path?: string; chosen: boolean } {
  const free = (path: string | undefined): path is string => path !== undefined && pool.includes(path) && !staged.has(path)
  if (free(chosen)) return { path: chosen, chosen: true }
  const main = free(current) ? current : pool.find(path => !staged.has(path))
  return { ...(main !== undefined ? { path: main } : {}), chosen: false }
}

/** Their sheets, each with what it is used as — in the card's order. */
export function sheetsOf(card: Sheeted): SheetOf[] {
  const pool = sheetPool(card)
  const staged = stageSheets(card)
  const fronts = sheetFronts(card)
  const main = mainSheetOf(pool, staged, card.visual?.mainSheet, card.visual?.sheet)
  return pool.map((path) => {
    const stage = staged.get(path)
    return {
      path,
      as: stage !== undefined ? 'stage' as const : path === main.path ? 'main' as const : 'spare' as const,
      ...(stage !== undefined ? { stage } : {}),
      front: fronts.has(path),
      ...(path === main.path && main.chosen ? { chosen: true } : {}),
    }
  })
}

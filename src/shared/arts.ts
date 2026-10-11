// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The design pictures kept of a place, a house or a thing, and which of them
 * is the main one.
 *
 * An entry of the bible has several, as a person has several design sheets:
 * one is the main picture — what scenes set there, or pictures that show the
 * thing, are held against, and what stands for it in the lists and in the
 * viewer; the rest are kept without being in use (an earlier one, one drawn
 * to compare). A picture drawn again does not take the one before it away:
 * it joins them, and the author says which is the main one. Shared by the
 * Host, which keeps the entry by these rules, and the page that shows them.
 * (The picture of one turn of its course is that turn's, and none of these.)
 */
import type { WorldEntry } from './types'

type Arted = Pick<WorldEntry, 'visualImage' | 'visualImages' | 'visualMain'>

/** One of the design pictures kept of an entry. */
export interface ArtOf {
  path: string
  /** What pictures are held against, and what stands for the entry. */
  main: boolean
  /** The main one because the author chose it — not only for being the newest. */
  chosen?: boolean
}

/** Every design picture kept of it, in order: the list the entry keeps — or, on an entry that keeps none yet, the one picture it names. */
export function artPool(entry: Arted): string[] {
  const listed = entry.visualImages ?? []
  const pool = [...new Set(listed.filter(path => path.length > 0))]
  if (entry.visualImage !== undefined && entry.visualImage.length > 0 && !pool.includes(entry.visualImage)) pool.unshift(entry.visualImage)
  return pool
}

/**
 * The main picture among them: the one the author chose, while it is among them; else the one that is the main one
 * now, while it still is among them — it does not change because another came or went; else the first.
 * @param current - the main picture as the entry has it.
 */
export function mainArtOf(pool: readonly string[], chosen: string | undefined, current?: string | undefined): { path?: string; chosen: boolean } {
  if (chosen !== undefined && pool.includes(chosen)) return { path: chosen, chosen: true }
  const main = current !== undefined && pool.includes(current) ? current : pool[0]
  return { ...(main !== undefined ? { path: main } : {}), chosen: false }
}

/** Its design pictures, each with whether it is the main one — in the entry's order. */
export function artsOf(entry: Arted): ArtOf[] {
  const pool = artPool(entry)
  const main = mainArtOf(pool, entry.visualMain, entry.visualImage)
  return pool.map(path => ({ path, main: path === main.path, ...(path === main.path && main.chosen ? { chosen: true } : {}) }))
}

/**
 * Whether a picture file is design art of this entry by its name — `location-<id>-<hash>` or `item-<id>-<hash>` —
 * and not the picture of a turn of its course (`…-<id>-<chapter>-<kind>-<hash>`): how pictures the gallery still has
 * of it, on no list, are told (drawn before pictures were kept side by side, or drawn to compare and not taken).
 */
export function isArtOf(entryId: string, path: string): boolean {
  const stem = (path.split('/').pop() ?? '').replace(/-[0-9a-f]{8}\.[a-z]+$/i, '')
  return stem === `location-${entryId}` || stem === `item-${entryId}`
}

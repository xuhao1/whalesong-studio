// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The bible's entries, told apart by what they are: places, houses and
 * organizations, things, and ideas. They are one kind of record on disk — an
 * entry with a category — and four pages to the author: a place is somewhere
 * the story goes, a thing is held and handed on, an idea is what the world
 * runs by.
 *
 * And how much each weighs in the story. An entry's `importance` says how its
 * text travels with a request to a model (the few core ones always do); that
 * is about context, and there may only be a handful of those. Weight is about
 * the story: the garden half the book happens in, against an inn passed once.
 * It is read off where the chapters name the entry, unless the author says.
 */
import type { WorldCategory, WorldEntry } from './types'

export type WorldGroup = 'places' | 'factions' | 'items' | 'ideas'

export const WORLD_GROUPS: readonly WorldGroup[] = ['places', 'factions', 'items', 'ideas']

/** Which page an entry of a category is on. Whatever is not a place, a house or a thing is an idea. */
export function groupOf(category: WorldCategory): WorldGroup {
  return category === 'location' ? 'places' : category === 'faction' ? 'factions' : category === 'item' ? 'items' : 'ideas'
}

/** The category a new entry of a page starts with. */
export const GROUP_CATEGORY: Record<WorldGroup, WorldCategory> = { places: 'location', factions: 'faction', items: 'item', ideas: 'setting' }

/** How much of the story an entry carries: half the book, a good part of it, a scene or two, a single mention. */
export type WorldWeight = 'core' | 'major' | 'minor' | 'once'

export const WORLD_WEIGHTS: readonly WorldWeight[] = ['core', 'major', 'minor', 'once']

/** Where an entry is named: the chapters, in reading order. */
export interface WorldPresence {
  entry: string
  chapters: string[]
}

/**
 * The weight of an entry: what the author set, else what the chapters say.
 * @param seen - how many chapters name it.
 * @param written - how many chapters there are to name it in.
 */
export function worldWeight(entry: Pick<WorldEntry, 'weight'>, seen: number, written: number): WorldWeight {
  if (entry.weight !== undefined) return entry.weight
  // A fifth of the book, and at least five chapters, is where the story lives; three chapters is somewhere it comes back to.
  if (seen >= Math.max(5, Math.ceil(written * 0.2))) return 'core'
  if (seen >= 3) return 'major'
  if (seen === 2) return 'minor'
  return 'once'
}

/**
 * Entries in the order they matter: the heaviest first, the more often named
 * first among equals, then as they came.
 */
export function worldOrder<E extends Pick<WorldEntry, 'id' | 'weight'>>(entries: readonly E[], presence: readonly WorldPresence[], written: number): E[] {
  const seen = new Map(presence.map(item => [item.entry, item.chapters.length]))
  const rank = (entry: E): number => WORLD_WEIGHTS.indexOf(worldWeight(entry, seen.get(entry.id) ?? 0, written))
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => rank(left.entry) - rank(right.entry) || (seen.get(right.entry.id) ?? 0) - (seen.get(left.entry.id) ?? 0) || left.index - right.index)
    .map(item => item.entry)
}

/**
 * Where each entry is named, from the text of the chapters: by its name or one
 * of its other names. A name of one character is too little to go by — it is
 * in half the sentences of a book — and is left to the digests.
 * @param chapters - the chapters in reading order, with their text.
 * @param noted - per chapter, the places its digest wrote down: a place the text only points at ("the garden") is still there.
 */
export function worldPresence(entries: readonly Pick<WorldEntry, 'id' | 'name' | 'aliases'>[], chapters: readonly { id: string; text: string }[], noted?: ReadonlyMap<string, readonly string[]>): WorldPresence[] {
  return entries.map((entry) => {
    const names = [entry.name, ...(entry.aliases ?? [])].map(name => name.trim()).filter(name => name.length >= 2)
    const exact = new Set([entry.name, ...(entry.aliases ?? [])].map(name => name.trim().toLowerCase()).filter(name => name.length > 0))
    const here: string[] = []
    for (const chapter of chapters) {
      const inText = names.some(name => chapter.text.includes(name))
      if (inText || (noted?.get(chapter.id) ?? []).some(place => exact.has(place.trim().toLowerCase()))) here.push(chapter.id)
    }
    return { entry: entry.id, chapters: here }
  })
}

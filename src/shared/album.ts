// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The people and the world of a book as somebody who reads it is given them:
 * who they are and how they look, the places, the houses, the things and the
 * ideas of the world, how all of it stands to each other, and the story's
 * time to tell it by.
 *
 * It is what a collection of settings prints, not what an author works with.
 * A card's working fields — what somebody wants and lacks, the change planned
 * for them, their secrets, how they are to be written and drawn and voiced,
 * the notes — stay with the author; so does how an entry is to be drawn.
 *
 *   Album          everything of it, as one answer
 *   cutAlbum       the album as it stood at a chapter: nothing of what comes after
 *   albumCounts    how much there is of each kind, for a page that decides what to offer
 *   entryStateAt   how a place, a house or a thing stands at a chapter, by its course
 */
import { statusAt, type Life } from './life'
import type { Tie, TieEnd } from './ties'
import type { CharacterRole, WorldCategory } from './types'
import type { WorldGroup, WorldWeight } from './world'

/** Somebody of the book, as a reader meets them. */
export interface AlbumPerson {
  id: string
  name: string
  aliases?: string[]
  role: CharacterRole
  /** Who they are in the story, in a line. */
  tagline?: string
  gender?: string
  age?: string
  appearance?: string
  personality?: string
  background?: string
  abilities?: string
  /** Their life on the page, in a paragraph. */
  life?: string
  /** Pictures, as paths of the book's own files: the bust, the design sheet, the sheets of further looks. */
  portrait?: string
  sheet?: string
  looks?: { name: string; when?: string; sheet: string }[]
  /** Who they are to others: the other's id when they have a page of their own, and their name either way. */
  relationships?: { id?: string; name: string; kind: string; note?: string }[]
}

/** A place, a house, a thing or an idea of the world, as a reader meets it. */
export interface AlbumEntry {
  id: string
  name: string
  aliases?: string[]
  category: WorldCategory
  group: WorldGroup
  /** How much of the story it carries. */
  weight: WorldWeight
  summary?: string
  /** What is written of it, as Markdown. */
  body?: string
  /** Its design picture, as a path of the book's own files. */
  image?: string
  /** Where on that picture the author pinned the marks of what stands in it, by `world:<id>` or `character:<id>` (`shared/scene.ts`). */
  spots?: Record<string, { x: number; y: number }>
  /** The places, in reading order, of the chapters that name it. */
  chapters: number[]
  /** What happens to it over the story, in reading order: `index` is the chapter's place. */
  events?: AlbumEvent[]
  /** Ids of entries it goes with. */
  related?: string[]
}

/** Something that happens to a place, a house or a thing, at a chapter of the story. */
export interface AlbumEvent {
  index: number
  chapter: string
  kind: 'begin' | 'change' | 'decline' | 'end'
  what: string
  /** A picture of it as it is from this on, as a path of the book's own files. */
  image?: string
}

/**
 * The picture of a place, a house or a thing as the story stands at a chapter.
 *
 * A turn of its course that has a picture shows it from then on: turns that
 * come after without one leave it as it was drawn — a garden in ruins stays in
 * ruins when its gate is locked. Two things put its design art back, the thing
 * as it usually is: it begins again (rebuilt, founded anew), and anything at
 * all happening after a picture of its *beginning* — that one shows it coming
 * to be, which lasts until the next thing happens to it.
 *
 * Looked at whenever, it is its design art — the thing as such, not as it
 * ends; with none drawn, the earliest picture there is of it.
 * @param at - the chapter's place in reading order; `undefined` for "whenever".
 */
export function entryImageAt(entry: Pick<AlbumEntry, 'image' | 'events'>, at: number | undefined): string | undefined {
  const turns = entry.events ?? []
  if (at === undefined) return entry.image ?? turns.find(turn => turn.image !== undefined)?.image
  const so = turns.filter(turn => turn.index <= at)
  let from = -1
  so.forEach((turn, index) => { if (turn.image !== undefined) from = index })
  if (from < 0) return entry.image
  const drawn = so[from]!
  const since = so.slice(from + 1)
  const usual = since.some(turn => turn.kind === 'begin') || (drawn.kind === 'begin' && since.length > 0)
  return usual ? entry.image ?? drawn.image : drawn.image
}

/** How a place, a house or a thing stands at a chapter: not there yet, there, in decline, no more. */
export type EntryState = 'before' | 'there' | 'declined' | 'gone'

/**
 * How an entry stands at a chapter, by what its course says: not there before
 * it came to be, gone after its end, in decline in between — and simply there
 * when its course says nothing of it. A later beginning puts it there again.
 * @param at - the chapter's place in reading order; `undefined` for "as the book leaves it".
 */
export function entryStateAt(entry: Pick<AlbumEntry, 'events'>, at: number | undefined): EntryState {
  const events = entry.events ?? []
  const so = at === undefined ? events : events.filter(event => event.index <= at)
  const last = [...so].reverse().find(event => event.kind !== 'change')
  if (last === undefined) return at !== undefined && events.some(event => event.kind === 'begin' && event.index > at) && !so.some(event => event.kind !== 'begin') ? 'before' : 'there'
  return last.kind === 'end' ? 'gone' : last.kind === 'decline' ? 'declined' : 'there'
}

export interface Album {
  /** Heaviest parts first. */
  people: AlbumPerson[]
  /** Group by group, the heaviest first within each. */
  world: AlbumEntry[]
  ties: Tie[]
  /** The chapters the story's time is told by, in reading order: those there is text of, along the main line. */
  chapters: { id: string; index: number; title: string }[]
  /** Everyone's life along that line, by their id; nobody the digests did not note. */
  lives: Record<string, Life>
}

/** How much an album holds, kind by kind. */
export interface AlbumCounts {
  people: number
  places: number
  factions: number
  items: number
  ideas: number
}

export function albumCounts(album: Pick<Album, 'people' | 'world'>): AlbumCounts {
  const of = (group: WorldGroup): number => album.world.filter(entry => entry.group === group).length
  return { people: album.people.length, places: of('places'), factions: of('factions'), items: of('items'), ideas: of('ideas') }
}

/** Whether an album has anything to show at all. */
export function albumEmpty(counts: AlbumCounts | undefined): boolean {
  return counts === undefined || counts.people + counts.places + counts.factions + counts.items + counts.ideas === 0
}

/** One kind of thing — the places, the houses, the things — as the first page of the world lays it out. */
export interface WorldFront {
  /**
   * What the story lives in and what it keeps coming back to, a row each, wherever on the map they lie:
   * the garden half the book happens in is met on the first page, though it is a part of a house that is
   * a part of a city. A row with nothing in it is left out.
   */
  heavy: { weight: 'core' | 'major'; list: AlbumEntry[] }[]
  /** Everything of less weight: named in a chapter or two, passed once. */
  rest: AlbumEntry[]
  /** Where a walk from the outside starts: what is in nothing and has something in it. */
  outermost: AlbumEntry[]
}

/**
 * The first page of the world for one kind of thing: by weight, not by what is in what.
 * @param entries - the entries of the kind, the heaviest first (as an album has them).
 * @param ties - the ties in force at the chapter looked at.
 */
export function worldFront(entries: readonly AlbumEntry[], ties: readonly Tie[]): WorldFront {
  const within = ties.filter(tie => tie.kind === 'within')
  const inSomething = new Set(within.map(tie => tie.from.id))
  const holdsSomething = new Set(within.map(tie => tie.to.id))
  return {
    heavy: (['core', 'major'] as const).map(weight => ({ weight, list: entries.filter(entry => entry.weight === weight) })).filter(tier => tier.list.length > 0),
    rest: entries.filter(entry => entry.weight !== 'core' && entry.weight !== 'major'),
    outermost: entries.filter(entry => !inSomething.has(entry.id) && holdsSomething.has(entry.id)),
  }
}

/** Where in an album a page is: one of its two halves, or the page of one thing. */
export interface AlbumAt {
  section: 'people' | 'world'
  end?: TieEnd
}

/**
 * The album as it stood when the story had come to a chapter: lives told up
 * to it, ties that held by then, mentions up to it — and nobody, and no place,
 * house or thing, that had not been on the page yet. Ideas stay: nothing says
 * when a rule of the world begins to hold.
 *
 * A book none of whose chapters was digested says nothing of who has come on;
 * then everybody stays.
 * @param upTo - the chapter's place in reading order; what comes after has not happened.
 */
export function cutAlbum(album: Album, upTo: number): Album {
  const chapters = album.chapters.filter(chapter => chapter.index <= upTo)
  const indexOf = new Map(album.chapters.map(chapter => [chapter.id, chapter.index]))
  const lives: Record<string, Life> = {}
  for (const [id, life] of Object.entries(album.lives)) {
    const events = life.events.filter(event => event.index <= upTo)
    if (events.length === 0) continue
    const spans = life.spans.filter(span => span.from <= upTo).map(span => ({ from: span.from, to: Math.min(span.to, upTo) }))
    const last = events.at(-1)!
    lives[id] = {
      events,
      spans,
      first: events[0]!.index,
      last: last.index,
      ...(last.kind === 'death' ? { death: last.index } : {}),
      ...(last.kind === 'exit' ? { exit: last.index } : {}),
    }
  }
  const told = Object.keys(album.lives).length > 0
  const people = album.people.filter(person => !told || lives[person.id] !== undefined)
  const here = new Set(people.map(person => person.id))
  const world = album.world
    .map(({ events, ...entry }) => {
      // Its course as far as the story has come: what happens to it later has not happened.
      const course = (events ?? []).filter(event => event.index <= upTo)
      return { ...entry, chapters: entry.chapters.filter(index => index <= upTo), ...(course.length > 0 ? { events: course } : {}) }
    })
    .filter(entry => entry.group === 'ideas' || entry.chapters.length > 0)
  const known = new Set(world.map(entry => entry.id))
  const stands = (end: TieEnd): boolean => (end.type === 'character' ? here.has(end.id) : known.has(end.id))
  // Ties that had begun by then, each told without an end that comes later: when it stops holding has not happened yet.
  const ties = album.ties
    .filter(tie => (tie.since === undefined || (indexOf.get(tie.since) ?? 0) <= upTo) && stands(tie.from) && stands(tie.to))
    .map(({ until, ...tie }) => (until !== undefined && (indexOf.get(until) ?? Infinity) <= upTo ? { ...tie, until } : tie))
  return {
    people: people.map(person => ({
      ...person,
      // Who somebody is to a person not on the page yet is not said.
      ...(person.relationships !== undefined ? { relationships: person.relationships.filter(other => other.id === undefined || here.has(other.id)) } : {}),
    })),
    world: world.map(({ spots, ...entry }) => {
      // A mark of somebody, or of a place, the story has not come to says they will be there.
      const pins = Object.entries(spots ?? {}).filter(([key]) => (key.startsWith('character:') ? here.has(key.slice(10)) : known.has(key.slice(key.indexOf(':') + 1))))
      return { ...entry, ...(entry.related !== undefined ? { related: entry.related.filter(id => known.has(id)) } : {}), ...(pins.length > 0 ? { spots: Object.fromEntries(pins) } : {}) }
    }),
    ties,
    chapters,
    lives,
  }
}

/** How somebody stands at a chapter, when their life was read; `undefined` when nothing is known of it. */
export function standingAt(album: Pick<Album, 'lives'>, person: string, at: number | undefined): ReturnType<typeof statusAt> | undefined {
  if (at === undefined) return undefined
  // Somebody the digests never noted has not come on, when they noted anybody at all.
  const life = album.lives[person]
  if (life === undefined) return Object.keys(album.lives).length > 0 ? 'planned' : undefined
  return statusAt(life, at)
}

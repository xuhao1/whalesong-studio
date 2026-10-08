// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A character's life on the page, chapter by chapter.
 *
 * One word on a card — active, offstage, dead — would say where a whole book
 * has got to, and a book is not one straight road: it has lines that part,
 * and chapters that are written again long after the ones that follow them.
 * So no card carries such a word. What happened is a record: where somebody
 * comes on, the chapters they are in, where they are gone for a while, where
 * they come back, where they leave for good or die. Every chapter's digest
 * already notes who was in it, what they went through and how they stood at
 * its end; laid out along a line of the plot, those notes are the record.
 * Along another line they are another record: somebody dead on one line is
 * alive on the one that parted before.
 *
 * Nothing here is stored. It is read off the digests, so it is as true as
 * they are, and it follows the text when the text changes.
 */
import type { CharacterMoment } from './types'

/**
 * Where somebody stands at one chapter of one line of the plot: not on yet, on
 * the page, away for a while, gone for good, dead. Always an answer to "on
 * which line, at which chapter" ({@link statusAt}) — never a thing a card keeps.
 */
export type LifeStanding = 'planned' | 'active' | 'offstage' | 'retired' | 'dead'

/** One chapter of somebody's life: that they were in it, and what the digest noted. */
export interface LifeEvent {
  chapter: string
  /** 1-based place of the chapter on the line the life is read along. */
  index: number
  /** What the chapter is to this life: `seen` is an ordinary chapter they are in. */
  kind: 'enter' | 'seen' | 'return' | 'exit' | 'death'
  /** What they did or went through. */
  what?: string
  /** How they stood at the end of the chapter. */
  state?: string
  where?: string
}

/** A stretch of chapters somebody is in without a long break. */
export interface LifeSpan {
  from: number
  to: number
}

export interface Life {
  events: LifeEvent[]
  /** The stretches they are on the page, in reading order. */
  spans: LifeSpan[]
  first?: number
  last?: number
  /** The chapter they die in, or leave the story for good — when a digest says so and they are not seen after it. */
  death?: number
  exit?: number
}

/** How many chapters somebody may be out of sight inside one stretch: a chapter elsewhere is not an absence. */
export const LIFE_GAP = 2
/** After this many chapters without them, somebody who was active is offstage. */
export const LIFE_AWAY = 5

/**
 * Fold the notes of the digests into a life.
 * @param moments - the chapters somebody is in, in reading order along one line, with what each digest noted of them.
 */
export function lifeOf(moments: readonly { chapter: string; index: number; moment: Pick<CharacterMoment, 'role' | 'stateAfter' | 'location' | 'lifecycle'> }[]): Life {
  const sorted = [...moments].sort((left, right) => left.index - right.index)
  const events: LifeEvent[] = []
  const spans: LifeSpan[] = []
  let gone = false
  for (const [at, item] of sorted.entries()) {
    const previous = sorted[at - 1]
    const hint = item.moment.lifecycle
    // The first chapter is where they come on, whatever the digest called it; after having left, any chapter is a return.
    const kind: LifeEvent['kind'] = hint === 'death' ? 'death' : hint === 'exit' ? 'exit'
      : at === 0 ? 'enter'
        : hint === 'return' || gone || (previous !== undefined && item.index - previous.index > LIFE_AWAY) ? 'return' : 'seen'
    gone = kind === 'exit' || kind === 'death'
    events.push({
      chapter: item.chapter,
      index: item.index,
      kind,
      ...(item.moment.role !== undefined && item.moment.role.length > 0 ? { what: item.moment.role } : {}),
      ...(item.moment.stateAfter !== undefined && item.moment.stateAfter.length > 0 ? { state: item.moment.stateAfter } : {}),
      ...(item.moment.location !== undefined && item.moment.location.length > 0 ? { where: item.moment.location } : {}),
    })
    const span = spans.at(-1)
    if (span !== undefined && item.index - span.to <= LIFE_GAP + 1) span.to = item.index
    else spans.push({ from: item.index, to: item.index })
  }
  return { events, spans, ...endsOf(events) }
}

/** Where a run of chapters begins and ends for somebody, and how it ends. */
function endsOf(events: readonly LifeEvent[]): Pick<Life, 'first' | 'last' | 'death' | 'exit'> {
  const last = events.at(-1)
  return {
    ...(events[0] !== undefined ? { first: events[0].index } : {}),
    ...(last !== undefined ? { last: last.index } : {}),
    // Dead, or gone for good, is what the last word on them says: someone seen again after a death was not dead (a ruse, a memory).
    ...(last?.kind === 'death' ? { death: last.index } : {}),
    ...(last?.kind === 'exit' ? { exit: last.index } : {}),
  }
}

/**
 * A life as far as a chapter of its line: what whoever writes or reads that
 * chapter knows of it. What comes after has not happened yet — somebody who
 * dies in chapter 16 is alive to the writer of chapter 5.
 * @param at - the last chapter (1-based place on the line) that counts.
 */
export function lifeUntil(life: Life, at: number): Life {
  const events = life.events.filter(event => event.index <= at)
  const spans = life.spans.filter(span => span.from <= at).map(span => ({ from: span.from, to: Math.min(span.to, at) }))
  return { events, spans, ...endsOf(events) }
}

/**
 * Where somebody stands at a chapter of the line their life was read along:
 * not on yet, on the page, away for a while, gone, dead.
 * @param at - the chapter's place on the line; everything after it has not happened yet.
 */
export function statusAt(life: Life, at: number): LifeStanding {
  const so = life.events.filter(event => event.index <= at)
  const last = so.at(-1)
  if (last === undefined) return 'planned'
  if (last.kind === 'death') return 'dead'
  if (last.kind === 'exit') return 'retired'
  return at - last.index >= LIFE_AWAY ? 'offstage' : 'active'
}

/** The stretches as numbers a reader recognizes: `5–8`, `19`, `51–52`. */
export function spanText(spans: readonly LifeSpan[]): string[] {
  return spans.map(span => (span.from === span.to ? String(span.from) : `${span.from}–${span.to}`))
}

/**
 * A life in one line of words: where they come on, the stretches they are in,
 * and how it ends — a death, a leaving, or the chapter they were last in.
 * @param zh - in Chinese, else in English.
 * @returns nothing for somebody no digest names.
 */
export function lifeLine(life: Life | undefined, zh: boolean): string | undefined {
  if (life === undefined || life.first === undefined || life.last === undefined) return undefined
  const spans = spanText(life.spans)
  // One chapter, or one stretch from the first to the last, says nothing the ends do not.
  const stretches = spans.length > 1 ? (zh ? `在场：第 ${spans.join('、')} 章` : `present: chapters ${spans.join(', ')}`) : undefined
  const end = life.death !== undefined ? (zh ? `第 ${life.death} 章死亡` : `dies in chapter ${life.death}`)
    : life.exit !== undefined ? (zh ? `第 ${life.exit} 章离开` : `leaves in chapter ${life.exit}`)
      : life.last !== life.first ? (zh ? `最近一次在第 ${life.last} 章` : `last seen in chapter ${life.last}`) : undefined
  return [zh ? `第 ${life.first} 章登场` : `comes on in chapter ${life.first}`, stretches, end].filter((part): part is string => part !== undefined).join(' · ')
}

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
import type { CharacterMoment, LifeMark } from './types'

/**
 * Where somebody stands at one chapter of one line of the plot: not on yet, on
 * the page, away for a while, gone for good, dead. Always an answer to "on
 * which line, at which chapter" ({@link statusAt}) — never a thing a card keeps.
 */
export type LifeStanding = 'planned' | 'active' | 'offstage' | 'retired' | 'dead'

/** One chapter of somebody's life: that they were in it, and what the digest noted. */
export interface LifeEvent {
  /** The chapter; empty for what lies before the story begins. */
  chapter: string
  /** 1-based place of the chapter on the line the life is read along; 0 before the story begins. */
  index: number
  /** What the chapter is to this life: `seen` is an ordinary chapter they are in. */
  kind: 'enter' | 'seen' | 'return' | 'exit' | 'death'
  /** What they did or went through. */
  what?: string
  /** How they stood at the end of the chapter. */
  state?: string
  where?: string
  /** The author wrote this down themselves ({@link LifeMark}): it is not the digest's word, and holds over it. */
  marked?: true
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
  /** The first and the last chapter they are in; absent for somebody known only by what lies before the story. */
  first?: number
  last?: number
  /**
   * The chapter they die in, or leave the story for good — when that is the last word on them. 0: before the story
   * begins. A digest's word ends where they are seen again; the author's holds until the author has them return.
   */
  death?: number
  exit?: number
}

/** How many chapters somebody may be out of sight inside one stretch: a chapter elsewhere is not an absence. */
export const LIFE_GAP = 2
/** After this many chapters without them, somebody who was active is offstage. */
export const LIFE_AWAY = 5

/**
 * Fold the notes of the digests into a life — and over them what the author
 * wrote down themselves.
 * @param moments - the chapters somebody is in, in reading order along one line, with what each digest noted of them;
 *   `mark` is the author's own word on that chapter (with an empty `moment` where the digest does not have them at all).
 */
export function lifeOf(moments: readonly { chapter: string; index: number; moment: Pick<CharacterMoment, 'role' | 'stateAfter' | 'location' | 'lifecycle'>; mark?: LifeMark }[]): Life {
  const sorted = [...moments].sort((left, right) => left.index - right.index)
  const events: LifeEvent[] = []
  // Out of the story: by a digest's word, or by the author's.
  let gone: { authored: boolean } | undefined
  let previous: number | undefined
  for (const item of sorted) {
    const said = item.mark?.kind
    const hint = said ?? item.moment.lifecycle
    const kind: LifeEvent['kind'] = hint === 'death' || hint === 'exit' ? hint
      // The author's word that they come on or back here.
      : said !== undefined ? said
        // Out of the story by the author's word: seen again, they are remembered — not back, until the author says so.
        : gone?.authored === true ? 'seen'
          // The first chapter is where they come on, whatever the digest called it; after having left, any chapter is a return.
          : previous === undefined ? 'enter'
            : hint === 'return' || gone !== undefined || item.index - previous > LIFE_AWAY ? 'return' : 'seen'
    if (kind === 'death' || kind === 'exit') gone = { authored: item.mark !== undefined }
    else if (kind === 'enter' || kind === 'return') gone = undefined
    const what = item.mark?.what ?? item.moment.role
    events.push({
      chapter: item.chapter,
      index: item.index,
      kind,
      ...(what !== undefined && what.length > 0 ? { what } : {}),
      ...(item.moment.stateAfter !== undefined && item.moment.stateAfter.length > 0 ? { state: item.moment.stateAfter } : {}),
      ...(item.moment.location !== undefined && item.moment.location.length > 0 ? { where: item.moment.location } : {}),
      ...(item.mark !== undefined ? { marked: true as const } : {}),
    })
    if (item.index >= 1) previous = item.index
  }
  return { events, spans: spansOf(events), ...endsOf(events) }
}

/** The stretches of chapters a run of events lies in; what is before the story is in no chapter. */
function spansOf(events: readonly LifeEvent[]): LifeSpan[] {
  const spans: LifeSpan[] = []
  for (const event of events) {
    if (event.index < 1) continue
    const span = spans.at(-1)
    if (span !== undefined && event.index - span.to <= LIFE_GAP + 1) span.to = event.index
    else spans.push({ from: event.index, to: event.index })
  }
  return spans
}

/** The event that has somebody out of the story at the end of a run of events, if they are: a death or a leaving nothing after it takes back. */
function endOf(events: readonly LifeEvent[]): LifeEvent | undefined {
  let end: LifeEvent | undefined
  for (const event of events) {
    if (event.kind === 'death' || event.kind === 'exit') end = event
    else if (event.kind === 'enter' || event.kind === 'return') end = undefined
    // `seen` after an end is only ever a chapter that remembers somebody the author has out of the story: the end stands.
  }
  return end
}

/** Where a run of chapters begins and ends for somebody, and how it ends. */
function endsOf(events: readonly LifeEvent[]): Pick<Life, 'first' | 'last' | 'death' | 'exit'> {
  const on = events.filter(event => event.index >= 1)
  const end = endOf(events)
  return {
    ...(on[0] !== undefined ? { first: on[0].index } : {}),
    ...(on.length > 0 ? { last: on.at(-1)!.index } : {}),
    // Dead, or gone for good, is what the last word on them says: someone seen again after a death was not dead (a ruse,
    // a memory) — unless the death is the author's word.
    ...(end?.kind === 'death' ? { death: end.index } : {}),
    ...(end?.kind === 'exit' ? { exit: end.index } : {}),
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
  return { events, spans: spansOf(events), ...endsOf(events) }
}

/**
 * Where somebody stands at a chapter of the line their life was read along:
 * not on yet, on the page, away for a while, gone, dead.
 * @param at - the chapter's place on the line; everything after it has not happened yet.
 */
export function statusAt(life: Life, at: number): LifeStanding {
  const so = life.events.filter(event => event.index <= at)
  if (so.length === 0) return 'planned'
  const end = endOf(so)
  if (end !== undefined) return end.kind === 'death' ? 'dead' : 'retired'
  const last = so.at(-1)!
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
  if (life === undefined || life.events.length === 0) return undefined
  const spans = spanText(life.spans)
  // Dead, or gone, before the first page: said first; the chapters that still have them — remembered, told of — after it.
  const before = life.death === 0 ? (zh ? '故事开始之前已故' : 'dead before the story begins') : life.exit === 0 ? (zh ? '故事开始之前已离开' : 'gone before the story begins') : undefined
  if (before !== undefined) return [before, spans.length > 0 ? (zh ? `正文里出现：第 ${spans.join('、')} 章` : `on the page in chapters ${spans.join(', ')}`) : undefined].filter((part): part is string => part !== undefined).join(' · ')
  if (life.first === undefined || life.last === undefined) return undefined
  // One chapter, or one stretch from the first to the last, says nothing the ends do not.
  const stretches = spans.length > 1 ? (zh ? `在场：第 ${spans.join('、')} 章` : `present: chapters ${spans.join(', ')}`) : undefined
  const end = life.death !== undefined ? (zh ? `第 ${life.death} 章死亡` : `dies in chapter ${life.death}`)
    : life.exit !== undefined ? (zh ? `第 ${life.exit} 章离开` : `leaves in chapter ${life.exit}`)
      : life.last !== life.first ? (zh ? `最近一次在第 ${life.last} 章` : `last seen in chapter ${life.last}`) : undefined
  return [zh ? `第 ${life.first} 章登场` : `comes on in chapter ${life.first}`, stretches, end].filter((part): part is string => part !== undefined).join(' · ')
}

/**
 * When somebody is out of the story, in words: the chapter of their death or
 * their leaving — or that it lies before the first page.
 * @returns nothing for somebody who is in the story.
 */
export function lifeEnd(life: Pick<Life, 'death' | 'exit'> | undefined, zh: boolean): { dead: boolean; at: number; text: string } | undefined {
  const dead = life?.death !== undefined
  const at = life?.death ?? life?.exit
  if (at === undefined) return undefined
  const text = at === 0 ? (zh ? (dead ? '故事开始之前已故' : '故事开始之前已离开') : (dead ? 'dead before the story begins' : 'gone before the story begins'))
    : zh ? `第 ${at} 章${dead ? '死亡' : '离开'}` : `${dead ? 'dies' : 'leaves'} in chapter ${at}`
  return { dead, at, text }
}

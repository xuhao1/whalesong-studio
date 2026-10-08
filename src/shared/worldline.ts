// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The world along one line of the plot, and two lines held against each other.
 *
 * A story that parts is two stories from where it parts: somebody dead on one
 * line is alive on the other, a thread paid off here is still open there. What
 * a line makes of the world is read off the digests of the chapters along it —
 * who has come on and how they stand at its end, which threads were planted
 * and which paid off — and nothing of it is stored.
 *
 *   LineWorld      the people and the threads as they stand at the end of a line, and what each has come to know along it
 *   compareLines   where two lines part, and what is different between them after that
 */
import type { LifeStanding } from './life'
import type { CharacterRole } from './types'

/** Somebody as they stand at the end of a line. */
export interface LinePerson {
  id: string
  name: string
  role: CharacterRole
  status: LifeStanding
  /** Places, in reading order along the line, of the chapter they come on in and the last they are in. */
  first: number
  last: number
  /** The id of that last chapter: what tells one line's course from another's. */
  lastChapter: string
  death?: number
  exit?: number
  /** Where the last digest has them, and how they stood at its end. */
  where?: string
  state?: string
  /** How many chapters of the line they are in. */
  chapters: number
  /** What they came to know along the line, as the digests noted it, in reading order: the chapter's place and its id, and what. */
  learned?: { index: number; chapter: string; what: string }[]
}

/** A thread of the plot as a line leaves it. */
export interface LineThread {
  /** The thread's id where the digests knew it, else its title folded. */
  key: string
  title: string
  /** Paid off, when the last word on it along the line is a payoff. */
  state: 'open' | 'paid'
  planted: number
  /** The last chapter that touches it, and that chapter's id. */
  last: number
  lastChapter: string
  touches: number
}

export interface LineWorld {
  /** The line's id; the main line's is `main`. */
  line: string
  title?: string
  /** The chapters read along it, in order: what comes before it, its own, and what it arrives at. */
  path: { id: string; index: number; title: string; hasText: boolean; digested: boolean }[]
  /** Everybody the digests along it name, heaviest part first. */
  people: LinePerson[]
  threads: LineThread[]
}

/** How somebody differs between two lines. */
export interface PersonDifference {
  id: string
  name: string
  role: CharacterRole
  /**
   * `fate`: it ended differently for them — dead on one line and alive on the other, gone for good here and still there.
   * `only`: one line has them and the other never comes to them.
   * `course`: it is the same with them on both, and they went through other chapters to get there.
   * Being on the page lately or not (`active`, `offstage`) is no fate: a longer line has everybody away sooner or later.
   */
  kind: 'fate' | 'only' | 'course'
  left?: LinePerson
  right?: LinePerson
  /**
   * What they came to know after the lines part, on each: what one of them knows that the other self never learns.
   * Absent where neither line tells of anything learned after the parting.
   */
  knows?: { left: string[]; right: string[] }
}

export interface ThreadDifference {
  key: string
  title: string
  kind: 'state' | 'only'
  left?: LineThread
  right?: LineThread
}

export interface LineComparison {
  /** How many chapters the two lines read alike from the first page. */
  shared: number
  /** The last chapter they have in common: where they part. Absent when they part on the first page. */
  parts?: { id: string; index: number; title: string }
  /** Chapters each line has that the other does not, and how many of them are written. */
  own: { left: { chapters: number; written: number }; right: { chapters: number; written: number } }
  /** Fates first, then who is on one line only, then other courses; within each, the heaviest part first. */
  people: PersonDifference[]
  threads: ThreadDifference[]
  /** How many people, and threads, stand alike on both lines. */
  alike: { people: number; threads: number }
}

const KINDS: readonly PersonDifference['kind'][] = ['fate', 'only', 'course']

/** How it ended for somebody, as far as a line tells: dead, gone for good, or still of the story. */
export function fateOf(status: LifeStanding): 'dead' | 'gone' | 'there' {
  return status === 'dead' ? 'dead' : status === 'retired' ? 'gone' : 'there'
}

/**
 * Hold two lines against each other. What happened before they part is the
 * same story and is not a difference: somebody who died in a chapter both
 * lines read is dead on both.
 */
export function compareLines(left: LineWorld, right: LineWorld): LineComparison {
  let shared = 0
  while (shared < left.path.length && shared < right.path.length && left.path[shared]!.id === right.path[shared]!.id) shared += 1
  const last = shared > 0 ? left.path[shared - 1]! : undefined
  const count = (world: LineWorld): { chapters: number; written: number } => {
    const own = world.path.slice(shared)
    return { chapters: own.length, written: own.filter(chapter => chapter.hasText).length }
  }
  const people: PersonDifference[] = []
  let alikePeople = 0
  const rightPeople = new Map(right.people.map(person => [person.id, person]))
  const seen = new Set<string>()
  for (const here of left.people) {
    seen.add(here.id)
    const there = rightPeople.get(here.id)
    // What each came to know in the chapters only their line has: before the parting they learned the same things.
    const since = (person: LinePerson, other: LineWorld): string[] => {
      const theirs = new Set(other.path.map(chapter => chapter.id))
      return (person.learned ?? []).filter(item => !theirs.has(item.chapter)).map(item => item.what)
    }
    const told = there !== undefined ? { left: since(here, right), right: since(there, left) } : undefined
    const base = { id: here.id, name: here.name, role: here.role, ...(told !== undefined && told.left.length + told.right.length > 0 ? { knows: told } : {}) }
    if (there === undefined) people.push({ ...base, kind: 'only', left: here })
    else if (fateOf(here.status) !== fateOf(there.status)) people.push({ ...base, kind: 'fate', left: here, right: there })
    else if (here.lastChapter !== there.lastChapter || here.chapters !== there.chapters) people.push({ ...base, kind: 'course', left: here, right: there })
    else alikePeople += 1
  }
  for (const there of right.people) if (!seen.has(there.id)) people.push({ id: there.id, name: there.name, role: there.role, kind: 'only', right: there })
  // In the order the lines list them: by the weight of the part.
  const order = new Map([...left.people, ...right.people].map((person, index) => [person.id, index] as const).reverse())
  people.sort((one, other) => KINDS.indexOf(one.kind) - KINDS.indexOf(other.kind) || (order.get(one.id) ?? 0) - (order.get(other.id) ?? 0))

  const threads: ThreadDifference[] = []
  let alikeThreads = 0
  const rightThreads = new Map(right.threads.map(thread => [thread.key, thread]))
  const met = new Set<string>()
  for (const here of left.threads) {
    met.add(here.key)
    const there = rightThreads.get(here.key)
    if (there === undefined) threads.push({ key: here.key, title: here.title, kind: 'only', left: here })
    else if (here.state !== there.state) threads.push({ key: here.key, title: here.title, kind: 'state', left: here, right: there })
    else alikeThreads += 1
  }
  for (const there of right.threads) if (!met.has(there.key)) threads.push({ key: there.key, title: there.title, kind: 'only', right: there })
  threads.sort((one, other) => (one.kind === other.kind ? 0 : one.kind === 'state' ? -1 : 1))

  return {
    shared,
    ...(last !== undefined ? { parts: { id: last.id, index: last.index, title: last.title } } : {}),
    own: { left: count(left), right: count(right) },
    people,
    threads,
    alike: { people: alikePeople, threads: alikeThreads },
  }
}

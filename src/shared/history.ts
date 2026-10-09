// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a version of a card, an entry, a plan is *about* — and what it is not.
 * One list for both halves: the Host goes by it when it decides whether a save
 * changed anything, and when it puts a version back; the Studio goes by it when
 * it shows what differs between a version and the thing as it is now.
 */
import type { HistoryKind } from './types'

/**
 * Where a thing names its pictures. They are no part of what a version keeps or puts back: a picture is kept for as
 * long as nobody deletes it, whatever becomes of the card that showed it. `[]` goes through a list, element by element.
 */
export const PICTURE_FIELDS: Partial<Record<HistoryKind, readonly string[]>> = {
  // …and the sample a voice was auditioned with: a file made for the card, like its pictures.
  character: ['visual.portrait', 'visual.portraits', 'visual.sheet', 'visual.looks[].sheet', 'visual.scenes[].portrait', 'stages[].visual.sheet', 'stages[].visual.portrait', 'voiceProfile.sample'],
  // Where the marks stand on a place's picture goes with the picture.
  world: ['visualImage', 'events[].image', 'spots'],
  book: ['cover'],
}

/**
 * What the Studio keeps on a thing by itself, following something else: where a person first and last appears (read
 * off the digests), where a chapter stands (it follows its text). No change of these is a change of the thing.
 */
export const KEPT_FIELDS: Partial<Record<HistoryKind, readonly string[]>> = {
  character: ['firstAppearance', 'lastAppearance'],
  plan: ['status'],
}

/** Everything of a thing a version is not about: it is neither compared nor put back — the thing keeps it as it is now. */
export const unversioned = (kind: HistoryKind): readonly string[] => [...(PICTURE_FIELDS[kind] ?? []), ...(KEPT_FIELDS[kind] ?? [])]

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** What lies at a path of a thing (`visual.prompt`); nothing where the way there breaks off. */
export function getAt(value: unknown, path: string): unknown {
  let at: unknown = value
  for (const key of path.split('.')) {
    if (!isRecord(at)) return undefined
    at = at[key]
  }
  return at
}

/** Every place a path with lists in it comes to in a thing: the records that hold its last key. */
export function holdersAt(value: unknown, path: string): { holder: Record<string, unknown>; key: string }[] {
  const [head, ...rest] = path.split('[].')
  if (rest.length === 0) {
    const keys = head!.split('.')
    const holder = keys.length === 1 ? value : getAt(value, keys.slice(0, -1).join('.'))
    return isRecord(holder) ? [{ holder, key: keys.at(-1)! }] : []
  }
  const list = getAt(value, head!)
  return Array.isArray(list) ? list.flatMap(item => holdersAt(item, rest.join('[].'))) : []
}

/** A thing with nothing in it that says nothing: no empty text, list or record, keys in one order — so that two of them compare by what they say. */
function tidy(item: unknown): unknown {
  if (Array.isArray(item)) {
    const list = item.map(tidy).filter(entry => entry !== undefined)
    return list.length > 0 ? list : undefined
  }
  if (isRecord(item)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(item).sort()) {
      const entry = tidy(item[key])
      if (entry !== undefined) out[key] = entry
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  if (item === null || item === undefined) return undefined
  if (typeof item === 'string') return item.trim().length > 0 ? item.trim() : undefined
  return item
}

/** A thing as a version is about it: without when it was touched, and without what {@link unversioned} names. */
export function versioned(kind: HistoryKind, value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value)
  delete copy.updatedAt
  for (const path of unversioned(kind)) for (const { holder, key } of holdersAt(copy, path)) delete holder[key]
  return (tidy(copy) ?? {}) as Record<string, unknown>
}

/** What a thing says, as one line to compare by. */
export const said = (kind: HistoryKind, value: Record<string, unknown>): string => JSON.stringify(versioned(kind, value))

/** A field in which a version and the thing as it is now differ, by its path (`tagline`, `visual.prompt`). */
export interface HistoryField {
  path: string
  was: unknown
  now: unknown
}

/** What a thing is told by, and never differs in. */
const NAMING = new Set(['id', 'schema', 'createdAt'])

/**
 * The fields a version and the thing as it is now differ in — what a version can be put back by. A record inside
 * the thing is gone into (a card's `visual` differs in its `prompt`, not as a whole); a list is one field.
 * @param now - left out for a thing that is no longer in the book: everything the version says differs.
 */
export function changedFields(kind: HistoryKind, was: Record<string, unknown>, now: Record<string, unknown> | undefined): HistoryField[] {
  const out: HistoryField[] = []
  const walk = (left: Record<string, unknown>, right: Record<string, unknown>, under: string, depth: number): void => {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])]) {
      if (under === '' && NAMING.has(key)) continue
      const [old, cur] = [left[key], right[key]]
      const path = under === '' ? key : `${under}.${key}`
      if (depth < 2 && (isRecord(old) || isRecord(cur)) && (old === undefined || isRecord(old)) && (cur === undefined || isRecord(cur))) {
        walk(old ?? {}, cur ?? {}, path, depth + 1)
        continue
      }
      if (JSON.stringify(old) !== JSON.stringify(cur)) out.push({ path, was: old, now: cur })
    }
  }
  walk(versioned(kind, was), now !== undefined ? versioned(kind, now) : {}, '', 0)
  return out
}

/**
 * A value of a field as text to read and to compare: a text as it is, a list one item a line, a record one
 * `key: value` a line — records of a list apart by a blank line.
 * @param name - what a key of a record is called, where the reader has a word for it.
 */
export function sayValue(value: unknown, name: (key: string) => string = key => key): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(item => sayValue(item, name)).join(value.some(item => isRecord(item)) ? '\n\n' : '\n')
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key, item]) => key !== 'id' && item !== undefined && item !== null && item !== '')
      .map(([key, item]) => `${name(key)}: ${isRecord(item) || Array.isArray(item) ? sayValue(item, name).replace(/\n+/g, ' / ') : sayValue(item, name)}`)
      .join('\n')
  }
  return ''
}

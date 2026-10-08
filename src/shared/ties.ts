// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * How the things of a book's world stand to each other: a courtyard is in a
 * garden, a house has its seat in a city, somebody belongs to a house, lives
 * in a courtyard, holds a token. One table of such ties — each may say from
 * which chapter to which it holds — and with it a world can be walked: from a
 * city to its houses, from a house to its people, from a garden to its
 * courtyards and whoever lives in them at a chapter of the story.
 *
 * The people's own relationships (kin, love, service) are on their cards and
 * stay there; these are the ties between people and the world, and within the
 * world.
 *
 *   Tie            one tie
 *   tiesAt         the ties in force at a chapter
 *   neighbours     what stands around one thing, grouped by how
 *   containment    the places (or houses) as a tree
 */

/** What a tie connects: a character, or an entry of the bible. */
export interface TieEnd {
  type: 'character' | 'world'
  id: string
}

/**
 * `within`   a place inside a place, a branch inside a house        from ⊂ to
 * `seat`     a house or organization has its seat at a place        from @ to
 * `member`   somebody belongs to a house or organization            from ∈ to
 * `resides`  somebody lives at, or keeps to, a place                from @ to
 * `holds`    somebody holds a thing                                 from ⟵ to
 */
export type TieKind = 'within' | 'seat' | 'member' | 'resides' | 'holds'

export const TIE_KINDS: readonly TieKind[] = ['within', 'seat', 'member', 'resides', 'holds']

export interface Tie {
  id: string
  kind: TieKind
  from: TieEnd
  to: TieEnd
  /** The chapter it begins to hold in; from the start when left out. */
  since?: string
  /** The last chapter it holds in; for good when left out. */
  until?: string
  note?: string
}

/** What each kind of tie connects: the kind of thing at its `from`, and at its `to`. */
export const TIE_ENDS: Record<TieKind, { from: TieEnd['type']; to: TieEnd['type'] }> = {
  within: { from: 'world', to: 'world' },
  seat: { from: 'world', to: 'world' },
  member: { from: 'character', to: 'world' },
  resides: { from: 'character', to: 'world' },
  holds: { from: 'character', to: 'world' },
}

const same = (left: TieEnd, right: TieEnd): boolean => left.type === right.type && left.id === right.id

/**
 * The ties in force at a chapter.
 * @param at - the chapter's place in reading order; `undefined` for "whenever": every tie.
 * @param indexOf - the place of a chapter by its id. A tie that names a chapter the line does not have holds as if it named none.
 */
export function tiesAt(ties: readonly Tie[], at: number | undefined, indexOf: (chapter: string) => number | undefined): Tie[] {
  if (at === undefined) return [...ties]
  return ties.filter((tie) => {
    const since = tie.since !== undefined ? indexOf(tie.since) : undefined
    const until = tie.until !== undefined ? indexOf(tie.until) : undefined
    return (since === undefined || since <= at) && (until === undefined || at <= until)
  })
}

/** How a neighbour stands to the thing asked about. */
export type Standing =
  /** The place (or house) it is in. */
  | 'parent'
  /** The places (or branches) in it. */
  | 'children'
  /** Where a house has its seat; the houses that have their seat here. */
  | 'seat' | 'seated'
  /** The houses somebody belongs to; the people who belong here. */
  | 'houses' | 'members'
  /** Where somebody lives; the people who live here. */
  | 'homes' | 'residents'
  /** The things somebody holds; whoever holds this thing. */
  | 'things' | 'holders'

export const STANDINGS: readonly Standing[] = ['parent', 'children', 'seat', 'seated', 'houses', 'members', 'homes', 'residents', 'things', 'holders']

/** What stands around one thing: every neighbour by how it stands to it, each with the tie that says so. */
export function neighbours(ties: readonly Tie[], of: TieEnd): Partial<Record<Standing, { end: TieEnd; tie: Tie }[]>> {
  const out: Partial<Record<Standing, { end: TieEnd; tie: Tie }[]>> = {}
  const put = (standing: Standing, end: TieEnd, tie: Tie): void => { out[standing] = [...(out[standing] ?? []), { end, tie }] }
  for (const tie of ties) {
    const outward = same(tie.from, of)
    const inward = same(tie.to, of)
    if (!outward && !inward) continue
    if (tie.kind === 'within') put(outward ? 'parent' : 'children', outward ? tie.to : tie.from, tie)
    else if (tie.kind === 'seat') put(outward ? 'seat' : 'seated', outward ? tie.to : tie.from, tie)
    else if (tie.kind === 'member') put(outward ? 'houses' : 'members', outward ? tie.to : tie.from, tie)
    else if (tie.kind === 'resides') put(outward ? 'homes' : 'residents', outward ? tie.to : tie.from, tie)
    else put(outward ? 'things' : 'holders', outward ? tie.to : tie.from, tie)
  }
  return out
}

/** One thing of a tree of places, with what is in it. */
export interface Nested {
  id: string
  children: Nested[]
}

/**
 * The entries as a tree by `within`: each under what it is in, those in
 * nothing at the top. A tie that would close a ring is left out — a courtyard
 * is not in itself by way of a garden — and an entry in two places stands
 * under the first.
 * @param ids - the entries to lay out, in the order they are to be listed.
 */
export function containment(ids: readonly string[], ties: readonly Tie[]): Nested[] {
  const known = new Set(ids)
  const parentOf = new Map<string, string>()
  const above = (id: string, of: string): boolean => {
    // Whether `of` is reached going up from `id`: taking `of` for a parent of something above it would close a ring.
    for (let at: string | undefined = id, steps = 0; at !== undefined && steps <= ids.length; at = parentOf.get(at), steps++) if (at === of) return true
    return false
  }
  for (const tie of ties) {
    if (tie.kind !== 'within' || tie.from.type !== 'world' || tie.to.type !== 'world') continue
    const child = tie.from.id
    const parent = tie.to.id
    if (!known.has(child) || !known.has(parent) || child === parent || parentOf.has(child) || above(parent, child)) continue
    parentOf.set(child, parent)
  }
  const nodes = new Map<string, Nested>(ids.map(id => [id, { id, children: [] }]))
  const roots: Nested[] = []
  for (const id of ids) {
    const parent = parentOf.get(id)
    const node = nodes.get(id)!
    if (parent !== undefined) nodes.get(parent)!.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** The way down to a thing from the top of its tree: what it is in, what that is in, and so on — outermost first. */
export function trail(id: string, ties: readonly Tie[]): string[] {
  const up: string[] = []
  const seen = new Set<string>([id])
  let at = id
  for (;;) {
    const parent = ties.find(tie => tie.kind === 'within' && tie.from.type === 'world' && tie.from.id === at && tie.to.type === 'world')?.to.id
    if (parent === undefined || seen.has(parent)) break
    seen.add(parent)
    up.unshift(parent)
    at = parent
  }
  return up
}

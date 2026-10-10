// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Somebody and theirs, as a small picture: the person in the middle, everyone
 * they are bound to on a ring around them — family beside family — with what
 * each bond is written on its line. It stands on a person's own page, where
 * the whole cast's graph would be too much and a list too little; pressing
 * anybody on it goes to them.
 *
 * Like the rest of the viewer it knows nothing of the Studio: the Studio's
 * card of a person and the album a reader is given both hand it the people.
 */
import { useMemo } from 'react'
import { layoutAround, relationKind, type GraphNode, type RelationKind } from '../../shared/relations'
import type { Translate } from './parts'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

export interface AroundPerson {
  id: string
  name: string
  /** What part they have in the story: the colour of their mark where they have no face. */
  role?: string | undefined
  /** Their picture, as a path of the book's own files. */
  face?: string | undefined
  /** The picture is a design sheet: its left third is the front view. */
  sheet?: boolean | undefined
}

/** A bond of the person in the middle: with whom, and the word for it. */
export interface AroundBond {
  with: string
  word: string
  /** Told from the other's card, where the person's own has no word for it. */
  theirs?: boolean
}

/**
 * Both ways a cast says who is what to whom, as the bonds of one of them: what their own card says, and — for those
 * their card says nothing of — what the others' cards say of them.
 */
export function bondsOf(person: string, cards: readonly { id: string; relationships?: readonly { id?: string | undefined; target?: string | undefined; kind: string }[] | undefined }[]): AroundBond[] {
  const known = new Set(cards.map(card => card.id))
  const own = (cards.find(card => card.id === person)?.relationships ?? []).flatMap((bond) => {
    const other = bond.id ?? bond.target
    return other !== undefined && other !== person && known.has(other) ? [{ with: other, word: bond.kind }] : []
  })
  const said = new Set(own.map(bond => bond.with))
  const theirs = cards.flatMap(card => (card.id === person || said.has(card.id) ? [] : (card.relationships ?? []).filter(bond => (bond.id ?? bond.target) === person).slice(0, 1).map(bond => ({ with: card.id, word: bond.kind, theirs: true }))))
  return [...own, ...theirs]
}

const CENTRE = 30
const OTHER = 21

export function AroundGraph({ t, person, others, bonds, media, onOpen }: {
  t: Translate
  person: AroundPerson
  /** Everyone a bond may be with. */
  others: readonly AroundPerson[]
  bonds: readonly AroundBond[]
  media: (path: string) => string
  /** Somebody on the ring was pressed. */
  onOpen?: ((id: string) => void) | undefined
}) {
  const laid = useMemo(() => {
    const byId = new Map(others.map(other => [other.id, other]))
    const held = bonds.filter(bond => byId.has(bond.with) && bond.with !== person.id)
    // One line a pair: the first word said of it.
    const first = new Map<string, AroundBond & { kind: RelationKind }>()
    for (const bond of held) if (!first.has(bond.with)) first.set(bond.with, { ...bond, kind: relationKind(bond.word) })
    const around = [...first.keys()].map(id => byId.get(id)!)
    const nodes: GraphNode[] = [{ id: person.id, radius: CENTRE, label: person.name.length }, ...around.map(other => ({ id: other.id, radius: OTHER, label: other.name.length }))]
    const layout = layoutAround(person.id, nodes, [...first.values()].map(bond => ({ from: person.id, to: bond.with, kind: bond.kind })))
    return { layout, around, first }
  }, [person.id, person.name, others, bonds])
  if (laid.around.length === 0) return null
  const { box } = laid.layout
  // Room for the names under the lowest marks, and for the ring of the middle one.
  const pad = 26
  const view = `${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2 + 8}`
  const mark = (who: AroundPerson, radius: number, focus: boolean) => (
    <>
      <circle r={radius} />
      {who.face !== undefined
        ? who.sheet === true
          // A sheet shows the same person three times: its left third, the front view, is their face here.
          ? <image className="nv-graph-face is-sheet" href={media(who.face)} x={-radius} y={-radius} width={radius * 6} height={radius * 4} preserveAspectRatio="xMinYMin slice" style={{ clipPath: `circle(${radius - 1.5}px at ${radius}px ${radius}px)` }} />
          : <image className="nv-graph-face" href={media(who.face)} x={-radius} y={-radius} width={radius * 2} height={radius * 2} preserveAspectRatio="xMidYMin slice" />
        : <text className="nv-around-initial" textAnchor="middle" dominantBaseline="central">{who.name.slice(0, 1)}</text>}
      <text y={radius + 15} textAnchor="middle" className={cx(focus && 'nv-around-me')}>{who.name}</text>
    </>
  )
  return (
    <svg className="nv-graph nv-around" viewBox={view} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t(`${person.name}和身边的人`, `${person.name} and theirs`)}>
      {laid.around.map((other) => {
        const to = laid.layout.at.get(other.id)
        const bond = laid.first.get(other.id)!
        if (to === undefined) return null
        return (
          <g key={other.id} className={cx('nv-graph-edge', `is-${bond.kind}`)}>
            <line x1={0} y1={0} x2={to.x} y2={to.y} />
            <text x={to.x * 0.58} y={to.y * 0.58} textAnchor="middle" dominantBaseline="central">{bond.word}</text>
          </g>
        )
      })}
      <g className={cx('nv-graph-node is-focus', person.role !== undefined && `is-${person.role}`)}>{mark(person, CENTRE, true)}</g>
      {laid.around.map((other) => {
        const at = laid.layout.at.get(other.id)
        if (at === undefined) return null
        return (
          <g key={other.id} className={cx('nv-graph-node', other.role !== undefined && `is-${other.role}`, onOpen === undefined && 'is-still')} transform={`translate(${at.x} ${at.y})`} onClick={onOpen !== undefined ? () => { onOpen(other.id) } : undefined}>
            <title>{other.name}</title>
            {mark(other, OTHER, false)}
          </g>
        )
      })}
    </svg>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Where the people of a book stand on a picture of who is what to whom.
 *
 * A circle with everyone on it says nothing: every line crosses the middle,
 * and where somebody stands tells nothing about them. So the picture is laid
 * out by the relations themselves — people who are much to one another stand
 * close, a household gathers by itself — and, when one person is looked at,
 * around that person: them in the middle, those they are bound to in a ring,
 * each kind of bond in its own stretch of it.
 *
 *   relationKind   what sort of bond a relation is, from the word the card has for it
 *   layoutGraph    positions for everyone: a ring for a handful, forces for more
 *   layoutAround   positions around one person
 *
 * No DOM, no randomness: the same cast is laid out the same way every time.
 */

export type RelationKind = 'family' | 'love' | 'service' | 'enmity' | 'bond' | 'other'

export const RELATION_KINDS: readonly RelationKind[] = ['family', 'love', 'service', 'bond', 'enmity', 'other']

const KIND_WORDS: [RelationKind, RegExp][] = [
  // Checked in this order: "情敌" is enmity before it is love, "义兄" a bond before it is family.
  ['enmity', /敌|仇|恨|对头|宿怨|死对|rival|enem|foe|nemesis|hostile/i],
  ['love', /恋|爱人|爱慕|倾慕|情人|情愫|暗恋|相好|心上人|未婚|定情|私情|暧昧|暧|暗生|lover|romance|romantic|beloved|crush|fianc/i],
  ['service', /主仆|主人|主子|仆|丫鬟|丫头|小厮|奴|侍|婢|嬷|奶娘|乳母|随从|下属|上司|部下|手下|雇|servant|master|maid|retainer|employ|boss|subordinate|attendant/i],
  ['bond', /友|盟|知己|同伴|伙伴|同窗|同门|师|徒|义兄|义弟|义姐|义妹|结拜|搭档|同僚|friend|ally|mentor|teacher|student|pupil|partner|comrade|colleague/i],
  ['family', /父|母|爹|娘|子|女|儿|兄|弟|姐|姊|妹|夫|妻|妾|祖|孙|叔|伯|姑|姨|舅|侄|甥|婶|嫂|媳|婿|亲|堂|表|族|家人|father|mother|son|daughter|brother|sister|husband|wife|spouse|parent|child|cousin|uncle|aunt|niece|nephew|grand|kin|sibling|in-law/i],
]

/** What sort of bond a relation is, read from the word a card has for it. */
export function relationKind(word: string): RelationKind {
  for (const [kind, pattern] of KIND_WORDS) if (pattern.test(word)) return kind
  return 'other'
}

export interface GraphNode {
  id: string
  /** How much room the person takes: the radius of their mark. */
  radius: number
  /** Their name's length in letters, so that names are given room too. */
  label: number
}

export interface GraphEdge {
  from: string
  to: string
  kind: RelationKind
}

export interface Point {
  x: number
  y: number
}

export interface Layout {
  at: Map<string, Point>
  /** The box everything lies in, names included. */
  box: { x: number; y: number; width: number; height: number }
}

/** Room a name takes beside its mark, in the units of the layout: a letter of a script without spaces is about a square. */
const letter = 12
const span = (node: GraphNode): number => Math.max(node.radius * 2, node.label * letter) / 2 + 6

function boxOf(at: Map<string, Point>, nodes: readonly GraphNode[]): Layout['box'] {
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const node of nodes) {
    const point = at.get(node.id)
    if (point === undefined) continue
    const half = span(node)
    left = Math.min(left, point.x - half)
    right = Math.max(right, point.x + half)
    top = Math.min(top, point.y - node.radius - 6)
    // The name stands under the mark.
    bottom = Math.max(bottom, point.y + node.radius + 22)
  }
  if (!Number.isFinite(left)) return { x: 0, y: 0, width: 100, height: 100 }
  const pad = 16
  return { x: left - pad, y: top - pad, width: right - left + pad * 2, height: bottom - top + pad * 2 }
}

/** A ring: all a handful of people need. */
function ring(nodes: readonly GraphNode[]): Map<string, Point> {
  const at = new Map<string, Point>()
  const around = nodes.reduce((sum, node) => sum + span(node) * 2, 0)
  const radius = Math.max(90, around / (Math.PI * 2))
  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2
    at.set(node.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
  })
  return at
}

/** A number in [0, 1) that a name always gives: where somebody starts, before the forces move them. */
function seeded(id: string, salt: number): number {
  let hash = 2166136261 ^ salt
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return ((hash >>> 0) % 100_000) / 100_000
}

/**
 * Positions for everyone on the picture. A handful stand on a ring; more are
 * placed by forces — every two people push each other apart, a relation pulls
 * its two ends together (kin and lovers harder than acquaintances), and all
 * are drawn gently to the middle — and then kept from standing on one another
 * or on one another's names.
 * @param nodes - in the order of their weight in the story, heaviest first.
 */
export function layoutGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Layout {
  if (nodes.length <= 8) {
    const at = ring(nodes)
    return { at, box: boxOf(at, nodes) }
  }
  const count = nodes.length
  const index = new Map(nodes.map((node, position) => [node.id, position]))
  const x = new Float64Array(count)
  const y = new Float64Array(count)
  // Start on a spiral by weight: the leads near the middle, the rest further out, each at an angle of their own.
  const spread = 34 * Math.sqrt(count)
  nodes.forEach((node, position) => {
    const distance = spread * Math.sqrt((position + 0.5) / count)
    const angle = seeded(node.id, 1) * Math.PI * 2
    x[position] = distance * Math.cos(angle)
    y[position] = distance * Math.sin(angle)
  })
  const links = edges
    .map(edge => ({ a: index.get(edge.from), b: index.get(edge.to), pull: edge.kind === 'family' || edge.kind === 'love' ? 1.25 : edge.kind === 'service' || edge.kind === 'bond' ? 1 : 0.7 }))
    .filter((link): link is { a: number; b: number; pull: number } => link.a !== undefined && link.b !== undefined && link.a !== link.b)
  const degree = new Float64Array(count)
  for (const link of links) {
    degree[link.a]! += 1
    degree[link.b]! += 1
  }
  const rest = 96
  const rounds = 320
  for (let round = 0; round < rounds; round++) {
    // Large moves first, small ones at the end.
    const heat = 1 - round / rounds
    const dx = new Float64Array(count)
    const dy = new Float64Array(count)
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        let ux = x[a]! - x[b]!
        let uy = y[a]! - y[b]!
        let distance = Math.hypot(ux, uy)
        if (distance < 0.01) {
          // Two on one spot part by their names.
          ux = seeded(nodes[a]!.id, round) - 0.5
          uy = seeded(nodes[b]!.id, round) - 0.5
          distance = Math.hypot(ux, uy) || 1
        }
        const push = (rest * rest * 1.1) / (distance * distance)
        dx[a]! += (ux / distance) * push
        dy[a]! += (uy / distance) * push
        dx[b]! -= (ux / distance) * push
        dy[b]! -= (uy / distance) * push
      }
    }
    for (const link of links) {
      const ux = x[link.b]! - x[link.a]!
      const uy = y[link.b]! - y[link.a]!
      const distance = Math.hypot(ux, uy) || 1
      // Somebody with many relations cannot have them all at arm's length.
      const length = rest * (1 + Math.min(degree[link.a]!, degree[link.b]!) * 0.06)
      const force = ((distance - length) / length) * 6 * link.pull
      dx[link.a]! += (ux / distance) * force
      dy[link.a]! += (uy / distance) * force
      dx[link.b]! -= (ux / distance) * force
      dy[link.b]! -= (uy / distance) * force
    }
    for (let a = 0; a < count; a++) {
      // A gentle pull to the middle keeps the unrelated from drifting off the page.
      dx[a]! -= x[a]! * 0.012
      dy[a]! -= y[a]! * 0.012
      const step = Math.hypot(dx[a]!, dy[a]!) || 1
      const limit = 26 * heat + 1
      const scale = Math.min(1, limit / step)
      x[a]! += dx[a]! * scale
      y[a]! += dy[a]! * scale
    }
  }
  // Nobody on anybody, and no name on a name: marks keep clear of marks, names — which lie flat — of names.
  for (let pass = 0; pass < 60; pass++) {
    let moved = false
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        const wide = span(nodes[a]!) + span(nodes[b]!)
        const tall = nodes[a]!.radius + nodes[b]!.radius + 30
        const ux = x[a]! - x[b]!
        const uy = y[a]! - y[b]!
        if (Math.abs(ux) >= wide || Math.abs(uy) >= tall) continue
        // Apart along the way that takes the smaller step.
        const overX = wide - Math.abs(ux)
        const overY = tall - Math.abs(uy)
        if (overY <= overX) {
          const shift = overY / 2 + 0.5
          const sign = uy >= 0 ? 1 : -1
          y[a]! += sign * shift
          y[b]! -= sign * shift
        } else {
          const shift = overX / 2 + 0.5
          const sign = ux >= 0 ? 1 : -1
          x[a]! += sign * shift
          x[b]! -= sign * shift
        }
        moved = true
      }
    }
    if (!moved) break
  }
  const at = new Map<string, Point>()
  nodes.forEach((node, position) => { at.set(node.id, { x: x[position]!, y: y[position]! }) })
  return { at, box: boxOf(at, nodes) }
}

/**
 * Positions around one person: them in the middle, everyone they are bound to
 * on a ring around them — each kind of bond in its own stretch of the ring, so
 * that family stands with family — and, further out, those who are bound to
 * the ring but not to the middle, each beyond the one they are closest to.
 * Whoever has nothing to do with any of these is left out.
 * @returns positions, and who is on which ring (0 the person, 1 theirs, 2 beyond).
 */
export function layoutAround(focus: string, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Layout & { ring: Map<string, 0 | 1 | 2> } {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const at = new Map<string, Point>()
  const ringOf = new Map<string, 0 | 1 | 2>()
  if (!byId.has(focus)) return { at, box: boxOf(at, nodes), ring: ringOf }
  at.set(focus, { x: 0, y: 0 })
  ringOf.set(focus, 0)
  // Theirs, with the bond each is best known by.
  const bondOf = new Map<string, RelationKind>()
  for (const edge of edges) {
    const other = edge.from === focus ? edge.to : edge.to === focus ? edge.from : undefined
    if (other === undefined || other === focus || !byId.has(other)) continue
    const known = bondOf.get(other)
    if (known === undefined || RELATION_KINDS.indexOf(edge.kind) < RELATION_KINDS.indexOf(known)) bondOf.set(other, edge.kind)
  }
  const order = nodes.map(node => node.id)
  const first = [...bondOf.keys()].sort((left, right) => RELATION_KINDS.indexOf(bondOf.get(left)!) - RELATION_KINDS.indexOf(bondOf.get(right)!) || order.indexOf(left) - order.indexOf(right))
  const around = first.reduce((sum, id) => sum + span(byId.get(id)!) * 2 + 8, 0)
  // Two rings of names when one would crowd: every other person a step further out.
  const base = Math.max(130, around / (Math.PI * 2))
  const stagger = first.length > 14 ? 46 : 0
  const angleOf = new Map<string, number>()
  first.forEach((id, position) => {
    const angle = (position / Math.max(first.length, 1)) * Math.PI * 2 - Math.PI / 2
    const radius = base + (position % 2 === 1 ? stagger : 0)
    angleOf.set(id, angle)
    at.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
    ringOf.set(id, 1)
  })
  // Beyond: bound to somebody on the ring, not to the middle.
  const beyond = new Map<string, string>()
  for (const edge of edges) {
    for (const [near, far] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
      if (!bondOf.has(near) || bondOf.has(far) || far === focus || !byId.has(far) || beyond.has(far)) continue
      beyond.set(far, near)
    }
  }
  const outer = base + stagger + 120
  const fans = new Map<string, string[]>()
  for (const [far, near] of beyond) fans.set(near, [...(fans.get(near) ?? []), far])
  for (const [near, far] of fans) {
    const centre = angleOf.get(near)!
    far.sort((left, right) => order.indexOf(left) - order.indexOf(right))
    far.forEach((id, position) => {
      const step = Math.min(0.22, (Math.PI * 2) / Math.max(first.length, 1) / (far.length + 1))
      const angle = centre + (position - (far.length - 1) / 2) * step
      const radius = outer + (position % 2) * 34
      at.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
      ringOf.set(id, 2)
    })
  }
  return { at, box: boxOf(at, nodes.filter(node => at.has(node.id))), ring: ringOf }
}

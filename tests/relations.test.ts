// SPDX-License-Identifier: LGPL-3.0-or-later
/** Where the people of a book stand on the picture of their relations. */
import { describe, expect, it } from 'vitest'
import { ProjectError } from '../src/core/project'
import { layoutAround, layoutGraph, relationKind, type GraphEdge, type GraphNode } from '../src/shared/relations'
import { createTestBed } from './support/harness'

const person = (id: string, radius = 8): GraphNode => ({ id, radius, label: id.length })

/** Three households of eight, each bound within, with one marriage across the first two. */
function households(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const house of ['贾', '王', '薛']) {
    for (let n = 0; n < 8; n++) nodes.push(person(`${house}${n}`, n === 0 ? 12 : 8))
    for (let n = 1; n < 8; n++) edges.push({ from: `${house}0`, to: `${house}${n}`, kind: 'family' })
    for (let n = 1; n < 7; n++) edges.push({ from: `${house}${n}`, to: `${house}${n + 1}`, kind: 'family' })
  }
  edges.push({ from: '贾1', to: '王1', kind: 'love' })
  return { nodes, edges }
}

const distance = (layout: { at: Map<string, { x: number; y: number }> }, a: string, b: string): number => {
  const p = layout.at.get(a)!
  const q = layout.at.get(b)!
  return Math.hypot(p.x - q.x, p.y - q.y)
}

describe('the picture of who is what to whom', () => {
  it('reads the sort of bond from the word a card has for it', () => {
    expect(relationKind('父亲')).toBe('family')
    expect(relationKind('表妹')).toBe('family')
    expect(relationKind('贴身丫鬟')).toBe('service')
    expect(relationKind('恋人')).toBe('love')
    // A rival in love is a rival; a sworn brother is a bond, not kin.
    expect(relationKind('情敌')).toBe('enmity')
    expect(relationKind('义兄')).toBe('bond')
    expect(relationKind('知己')).toBe('bond')
    expect(relationKind('mentor')).toBe('bond')
    expect(relationKind('同乡')).toBe('other')
  })

  it('stands a handful on a ring', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map(id => person(id))
    const layout = layoutGraph(nodes, [{ from: 'a', to: 'b', kind: 'other' }])
    const radii = nodes.map(node => Math.hypot(layout.at.get(node.id)!.x, layout.at.get(node.id)!.y))
    for (const radius of radii) expect(radius).toBeCloseTo(radii[0]!, 5)
  })

  it('lays a larger cast out by its relations: the same way every time, nobody on anybody, households together', () => {
    const { nodes, edges } = households()
    const layout = layoutGraph(nodes, edges)
    expect(layoutGraph(nodes, edges).at).toEqual(layout.at)
    // No two marks, and no two names, on one another.
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const p = layout.at.get(nodes[a]!.id)!
        const q = layout.at.get(nodes[b]!.id)!
        const wide = Math.max(nodes[a]!.radius * 2, nodes[a]!.label * 12) / 2 + Math.max(nodes[b]!.radius * 2, nodes[b]!.label * 12) / 2 + 12
        const tall = nodes[a]!.radius + nodes[b]!.radius + 30
        expect(Math.abs(p.x - q.x) >= wide - 1 || Math.abs(p.y - q.y) >= tall - 1, `${nodes[a]!.id} and ${nodes[b]!.id} overlap`).toBe(true)
      }
    }
    // People of one household stand nearer to one another than to the others.
    const within: number[] = []
    const across: number[] = []
    for (const a of nodes) for (const b of nodes) if (a.id < b.id) (a.id[0] === b.id[0] ? within : across).push(distance(layout, a.id, b.id))
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length
    expect(mean(within)).toBeLessThan(mean(across) * 0.75)
    // Everything, names included, is inside the box.
    for (const node of nodes) {
      const p = layout.at.get(node.id)!
      expect(p.x).toBeGreaterThan(layout.box.x)
      expect(p.x).toBeLessThan(layout.box.x + layout.box.width)
      expect(p.y).toBeGreaterThan(layout.box.y)
      expect(p.y).toBeLessThan(layout.box.y + layout.box.height)
    }
  })

  it('stands whoever the author moved where they were put, and everybody else as if nobody had been moved', () => {
    const { nodes, edges } = households()
    const plain = layoutGraph(nodes, edges)
    const far = { x: plain.box.x + plain.box.width + 300, y: plain.box.y - 200 }
    const moved = layoutGraph(nodes, edges, { 贾3: far, nobody: { x: 1, y: 1 }, 王2: { x: Number.NaN, y: 0 } })
    expect(moved.at.get('贾3')).toEqual(far)
    // The others are where the layout has them — a hand on one person does not shake the picture — and a spot that is no spot is none.
    for (const node of nodes) if (node.id !== '贾3') expect(moved.at.get(node.id)).toEqual(plain.at.get(node.id))
    expect(moved.at.has('nobody')).toBe(false)
    // The box takes in whoever was put outside it, so that the whole picture shows them.
    expect(moved.box.x + moved.box.width).toBeGreaterThan(far.x)
    expect(moved.box.y).toBeLessThan(far.y)
    // A handful on a ring can be moved as well.
    const few = ['a', 'b', 'c'].map(id => person(id))
    expect(layoutGraph(few, [], { b: { x: 500, y: 0 } }).at.get('b')).toEqual({ x: 500, y: 0 })
  })

  it('stands everyone around the person looked at: theirs in a ring by the kind of bond, the rest beyond or left out', () => {
    const nodes = ['宝玉', '贾母', '贾政', '王夫人', '黛玉', '宝钗', '袭人', '晴雯', '林如海', '薛蟠', '路人'].map(id => person(id))
    const edges: GraphEdge[] = [
      { from: '宝玉', to: '贾母', kind: 'family' },
      { from: '贾政', to: '宝玉', kind: 'family' },
      { from: '宝玉', to: '王夫人', kind: 'family' },
      { from: '宝玉', to: '黛玉', kind: 'love' },
      { from: '宝玉', to: '宝钗', kind: 'love' },
      { from: '袭人', to: '宝玉', kind: 'service' },
      { from: '晴雯', to: '宝玉', kind: 'service' },
      { from: '黛玉', to: '林如海', kind: 'family' },
      { from: '宝钗', to: '薛蟠', kind: 'family' },
    ]
    const layout = layoutAround('宝玉', nodes, edges)
    expect(layout.at.get('宝玉')).toEqual({ x: 0, y: 0 })
    expect([...layout.ring.entries()].filter(([, ring]) => ring === 1).map(([id]) => id).sort()).toEqual(['宝钗', '晴雯', '王夫人', '袭人', '贾政', '贾母', '黛玉'].sort())
    expect(layout.ring.get('林如海')).toBe(2)
    expect(layout.ring.get('薛蟠')).toBe(2)
    // Somebody with nothing to do with any of them is not on this picture.
    expect(layout.at.has('路人')).toBe(false)
    // Each kind of bond has its own stretch of the ring: going round, the kinds do not alternate.
    const kindOf = new Map<string, string>([['贾母', 'family'], ['贾政', 'family'], ['王夫人', 'family'], ['黛玉', 'love'], ['宝钗', 'love'], ['袭人', 'service'], ['晴雯', 'service']])
    const round = [...kindOf.keys()].sort((left, right) => Math.atan2(layout.at.get(left)!.y, layout.at.get(left)!.x) - Math.atan2(layout.at.get(right)!.y, layout.at.get(right)!.x)).map(id => kindOf.get(id)!)
    let changes = 0
    for (let i = 0; i < round.length; i++) if (round[i] !== round[(i + 1) % round.length]) changes += 1
    expect(changes).toBe(3)
    // Those beyond stand beyond the one they belong to.
    expect(Math.hypot(layout.at.get('林如海')!.x, layout.at.get('林如海')!.y)).toBeGreaterThan(Math.hypot(layout.at.get('黛玉')!.x, layout.at.get('黛玉')!.y))
    expect(distance(layout, '林如海', '黛玉')).toBeLessThan(distance(layout, '林如海', '袭人'))
  })
})

describe('where the author moved people to on that picture', () => {
  it('is kept with the book, by person, and let go one by one or all at once', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const one = await project.saveCharacter({ name: '沈砚' })
      const other = await project.saveCharacter({ name: '周既白', aliases: ['既白'] })
      expect((await project.state()).graph).toBeUndefined()
      const revision = (await project.state()).revision
      // By id or by a name; to a tenth of a unit.
      expect(await project.placeInGraph(one.id, { x: 120.44, y: -36.06 })).toEqual({ [one.id]: { x: 120.4, y: -36.1 } })
      expect(await project.placeInGraph('既白', { x: 0, y: 5 })).toEqual({ [one.id]: { x: 120.4, y: -36.1 }, [other.id]: { x: 0, y: 5 } })
      const state = await project.state()
      expect(state.graph).toEqual({ [one.id]: { x: 120.4, y: -36.1 }, [other.id]: { x: 0, y: 5 } })
      // Whoever shows the book hears of it.
      expect(state.revision).toBeGreaterThan(revision)
      // Put somewhere else, they are there and nowhere else.
      expect((await project.placeInGraph(one.id, { x: 1, y: 2 }))[one.id]).toEqual({ x: 1, y: 2 })
      // Somebody nobody knows, and a spot that is no spot, are said.
      await expect(project.placeInGraph('没有这个人', { x: 0, y: 0 })).rejects.toThrow(ProjectError)
      await expect(project.placeInGraph(one.id, { x: Number.NaN, y: 0 })).rejects.toThrow(/two numbers/)
      // Whoever has no card any more is not on the picture.
      await project.deleteCharacter(other.id)
      expect(await project.graphPlaces()).toEqual({ [one.id]: { x: 1, y: 2 } })
      // Let go: one, then everybody.
      expect(await project.placeInGraph(one.id)).toEqual({})
      await project.placeInGraph(one.id, { x: 3, y: 4 })
      expect(await project.placeInGraph()).toEqual({})
      expect((await project.state()).graph).toBeUndefined()
    } finally {
      await bed.cleanup()
    }
  })
})


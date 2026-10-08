// SPDX-License-Identifier: LGPL-3.0-or-later
/** The ties between the things of a book's world, and walking by them. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveTies } from '../src/core/pipelines/bible'
import { containment, neighbours, tiesAt, trail, type Tie } from '../src/shared/ties'
import { createTestBed, type TestBed } from './support/harness'

const world = (id: string): Tie['from'] => ({ type: 'world', id })
const person = (id: string): Tie['from'] => ({ type: 'character', id })
const tie = (id: string, kind: Tie['kind'], from: Tie['from'], to: Tie['to'], extra: Partial<Tie> = {}): Tie => ({ id, kind, from, to, ...extra })

const TIES: Tie[] = [
  tie('a', 'within', world('怡红院'), world('大观园')),
  tie('b', 'within', world('大观园'), world('贾府'), { since: 'ch017' }),
  tie('c', 'within', world('贾府'), world('金陵')),
  tie('d', 'seat', world('贾家'), world('贾府')),
  tie('e', 'member', person('贾宝玉'), world('贾家')),
  tie('f', 'resides', person('贾宝玉'), world('怡红院'), { since: 'ch023' }),
  tie('g', 'resides', person('晴雯'), world('怡红院'), { since: 'ch023', until: 'ch077' }),
  tie('h', 'holds', person('贾宝玉'), world('通灵宝玉')),
]
const indexOf = (chapter: string): number | undefined => (/^ch\d+$/.test(chapter) ? Number(chapter.slice(2)) : undefined)

describe('the ties of a world', () => {
  it('hold from a chapter to a chapter, or always', () => {
    expect(tiesAt(TIES, undefined, indexOf)).toHaveLength(8)
    expect(tiesAt(TIES, 10, indexOf).map(item => item.id)).toEqual(['a', 'c', 'd', 'e', 'h'])
    expect(tiesAt(TIES, 23, indexOf).map(item => item.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    expect(tiesAt(TIES, 77, indexOf).map(item => item.id)).toContain('g')
    expect(tiesAt(TIES, 78, indexOf).map(item => item.id)).not.toContain('g')
    // A tie that names a chapter the line does not have holds as if it named none.
    expect(tiesAt([tie('x', 'within', world('a'), world('b'), { since: 'gone' })], 1, indexOf)).toHaveLength(1)
  })

  it('say what stands around a thing, by how it stands to it', () => {
    const garden = neighbours(TIES, world('大观园'))
    expect(garden.parent?.map(item => item.end.id)).toEqual(['贾府'])
    expect(garden.children?.map(item => item.end.id)).toEqual(['怡红院'])
    const courtyard = neighbours(TIES, world('怡红院'))
    expect(courtyard.residents?.map(item => item.end.id)).toEqual(['贾宝玉', '晴雯'])
    expect(courtyard.residents?.[1]?.tie.until).toBe('ch077')
    const baoyu = neighbours(TIES, person('贾宝玉'))
    expect(baoyu.houses?.map(item => item.end.id)).toEqual(['贾家'])
    expect(baoyu.homes?.map(item => item.end.id)).toEqual(['怡红院'])
    expect(baoyu.things?.map(item => item.end.id)).toEqual(['通灵宝玉'])
    expect(neighbours(TIES, world('贾府')).seated?.map(item => item.end.id)).toEqual(['贾家'])
    expect(neighbours(TIES, world('贾家'))).toMatchObject({ seat: [{ end: { id: '贾府' } }], members: [{ end: { id: '贾宝玉' } }] })
    expect(neighbours(TIES, world('通灵宝玉')).holders?.map(item => item.end.id)).toEqual(['贾宝玉'])
    // Somebody of the same name as a place is another thing.
    expect(neighbours(TIES, person('怡红院'))).toEqual({})
  })

  it('lay places out as a tree, and never as a ring', () => {
    const tree = containment(['金陵', '贾府', '大观园', '怡红院', '铁槛寺'], TIES)
    expect(JSON.stringify(tree)).toBe(JSON.stringify([
      { id: '金陵', children: [{ id: '贾府', children: [{ id: '大观园', children: [{ id: '怡红院', children: [] }] }] }] },
      { id: '铁槛寺', children: [] },
    ]))
    expect(trail('怡红院', TIES)).toEqual(['金陵', '贾府', '大观园'])
    expect(trail('金陵', TIES)).toEqual([])
    // A ring somebody wrote down: the tie that would close it is left out, and nothing is lost from the list.
    const ring = [tie('1', 'within', world('a'), world('b')), tie('2', 'within', world('b'), world('c')), tie('3', 'within', world('c'), world('a'))]
    const laid = containment(['a', 'b', 'c'], ring)
    expect(JSON.stringify(laid)).toBe(JSON.stringify([{ id: 'c', children: [{ id: 'b', children: [{ id: 'a', children: [] }] }] }]))
    expect(trail('a', ring)).toEqual(['c', 'b'])
    // An entry in two places stands under the first; one that is in something not listed stands at the top.
    expect(containment(['x', 'y', 'z'], [tie('1', 'within', world('x'), world('y')), tie('2', 'within', world('x'), world('z')), tie('3', 'within', world('y'), world('elsewhere'))]).map(node => node.id)).toEqual(['y', 'z'])
  })
})

describe('a book keeps its ties', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('with its bible, by id — and drops those whose ends are gone', async () => {
    const { project } = bed.runtime
    await project.saveWorld({ name: '大观园', category: 'location' })
    await project.saveWorld({ name: '怡红院', category: 'location' })
    await project.saveCharacter({ name: '贾宝玉' })
    expect(await project.ties()).toEqual([])
    const first = await project.saveTie({ kind: 'within', from: world('怡红院'), to: world('大观园') })
    const second = await project.saveTie({ kind: 'resides', from: person('贾宝玉'), to: world('怡红院'), since: 'ch023', note: '搬进园子' })
    expect(first.id).not.toBe(second.id)
    // The same tie said twice is one tie; saying it with other chapters changes it.
    const again = await project.saveTie({ kind: 'resides', from: person('贾宝玉'), to: world('怡红院'), since: 'ch024' })
    expect(again.id).toBe(second.id)
    expect((await project.ties()).map(item => [item.kind, item.since])).toEqual([['within', undefined], ['resides', 'ch024']])
    expect((await project.state()).ties).toHaveLength(2)
    // A tie that makes no sense is refused: the wrong kind of thing at an end, an end that does not exist, a thing in itself.
    await expect(project.saveTie({ kind: 'within', from: person('贾宝玉'), to: world('大观园') })).rejects.toThrow(/within/)
    await expect(project.saveTie({ kind: 'resides', from: person('不存在的人'), to: world('怡红院') })).rejects.toThrow(/no character/)
    await expect(project.saveTie({ kind: 'within', from: world('大观园'), to: world('大观园') })).rejects.toThrow(/itself/)
    // When an entry or a card is deleted, the ties that named it go with it.
    await project.deleteCharacter('贾宝玉')
    expect((await project.ties()).map(item => item.kind)).toEqual(['within'])
    expect(await project.removeTie(first.id)).toBe(true)
    expect(await project.removeTie(first.id)).toBe(false)
    expect(await project.ties()).toEqual([])
  })

  it('has the planner work the ties out from the bible and the digests, and says what could not be written down', async () => {
    const { project } = bed.runtime
    for (const name of ['金陵', '大观园', '怡红院']) await project.saveWorld({ name, category: 'location' })
    await project.saveWorld({ name: '贾家', category: 'faction' })
    await project.saveWorld({ name: '通灵宝玉', category: 'item' })
    await project.saveWorld({ name: '金玉良缘', category: 'rule' })
    await project.saveCharacter({ name: '贾宝玉', role: 'protagonist', aliases: ['宝玉'] })
    await project.saveCharacter({ name: '路人', role: 'cameo' })
    for (const title of ['一', '二', '三']) await project.addChapter({ title })
    await project.saveMemory({ schema: 1, chapterId: 'ch002', textHash: 'x', updatedAt: new Date().toISOString(), brief: '', summary: '', locations: ['怡红院'], facts: [{ subject: '通灵宝玉', statement: '宝玉落草时衔在口中', kind: 'item' }], newEntities: [], threads: [], characters: [{ character: '贾宝玉', name: '贾宝玉', location: '怡红院' }] })
    // One tie that is wrong stands already; the planner is to say so.
    await project.saveTie({ kind: 'within', from: { type: 'world', id: '大观园' }, to: { type: 'world', id: '怡红院' } })
    bed.llm.responder = (request) => {
      const prompt = request.prompt
      // What the planner is given: the things to tie, by their names — ideas are not among them, nor are walk-ons.
      expect(prompt).toContain('- 怡红院')
      expect(prompt).toContain('- 贾宝玉（宝玉）')
      expect(prompt).not.toContain('金玉良缘')
      expect(prompt).not.toContain('- 路人')
      expect(prompt).toContain('贾宝玉@怡红院')
      expect(prompt).toContain('within: 大观园 → 怡红院')
      return JSON.stringify({
        ties: [
          { kind: 'within', from: '怡红院', to: '大观园' },
          { kind: 'within', from: '大观园', to: '金陵', since: 2 },
          { kind: 'member', from: '宝玉', to: '贾家' },
          { kind: 'resides', from: '贾宝玉', to: '怡红院', since: 2, until: 3, note: '第 2 章搬进园子' },
          { kind: 'holds', from: '贾宝玉', to: '通灵宝玉' },
          { kind: 'resides', from: '林黛玉', to: '潇湘馆' },
          { kind: 'within', from: '潇湘馆', to: '大观园' },
          { kind: 'seat', from: '贾家', to: '荣国府' },
          { kind: 'within', from: '宁国府（东府）', to: '金陵' },
          { kind: 'lives', from: '贾宝玉', to: '怡红院' },
        ],
        wrong: [{ kind: 'within', from: '大观园', to: '怡红院' }],
        missing: [{ name: '潇湘馆（有凤来仪）', category: 'location', summary: '黛玉的住处' }, { name: '林黛玉', category: 'person' }, '只有名字的不建', { name: '大观园', category: 'location' }],
        // What happens to places and things themselves: by chapter number, of entries there are, of the kinds there are.
        events: [
          { name: '大观园', chapter: 2, kind: 'begin', what: '为省亲建成' },
          { name: '大观园', chapter: 2, kind: 'begin', what: '同一件事又说了一遍' },
          { name: '通灵宝玉', chapter: 3, kind: 'end', what: '丢了' },
          { name: '金玉良缘', chapter: 1, kind: 'begin', what: '概念没有轨迹' },
          { name: '没有这个地方', chapter: 1, kind: 'begin', what: '对不上名字' },
          { name: '怡红院', chapter: 99, kind: 'begin', what: '没有这一章' },
          { name: '怡红院', chapter: 1, kind: 'explodes', what: '没有这种事' },
        ],
      })
    }
    const result = await deriveTies(bed.core, bed.runtime, {}, { origin: 'user' })
    expect(result.events).toBe(2)
    expect((await project.findWorld('大观园'))!.events).toEqual([{ chapter: 'ch002', kind: 'begin', what: '为省亲建成' }])
    expect((await project.findWorld('通灵宝玉'))!.events).toEqual([{ chapter: 'ch003', kind: 'end', what: '丢了' }])
    expect((await project.findWorld('怡红院'))!.events).toBeUndefined()
    expect(bed.llm.requests.at(-1)!.prompt).toContain('"events"')
    // A place, a house or a thing a tie names and the bible lacks is made an entry — what it is follows from the tie, what is said of it from the planner. A person is not made here, nor a name with a remark in it.
    expect(result).toMatchObject({ added: 7, changed: 0, removed: 1, total: 7, created: ['潇湘馆', '荣国府'] })
    expect(await project.findWorld('潇湘馆')).toMatchObject({ category: 'location', importance: 3, summary: '黛玉的住处' })
    expect(await project.findWorld('荣国府')).toMatchObject({ category: 'location' })
    expect(await project.findWorld('宁国府')).toBeUndefined()
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.join('\n')).toMatch(/林黛玉 → 潇湘馆/)
    expect(result.skipped.join('\n')).toMatch(/宁国府（东府） → 金陵/)
    const ties = await project.ties()
    expect(ties.map(item => `${item.kind}:${item.from.id}>${item.to.id}`).sort()).toEqual(['holds:贾宝玉>通灵宝玉', 'member:贾宝玉>贾家', 'resides:贾宝玉>怡红院', 'seat:贾家>荣国府', 'within:大观园>金陵', 'within:怡红院>大观园', 'within:潇湘馆>大观园'])
    expect(ties.find(item => item.kind === 'resides')).toMatchObject({ since: 'ch002', until: 'ch003', note: '第 2 章搬进园子' })
    expect(trail('怡红院', ties)).toEqual(['金陵', '大观园'])
    expect((await project.activity(1))[0]).toMatchObject({ by: 'crew', role: 'architect', tool: 'ties' })
    // Asked again with nothing new to say, nothing is added.
    bed.llm.responder = () => JSON.stringify({ ties: [{ kind: 'holds', from: '贾宝玉', to: '通灵宝玉' }] })
    expect(await deriveTies(bed.core, bed.runtime, {}, { origin: 'user' })).toMatchObject({ added: 0, changed: 1, removed: 0, total: 7 })
  })
})

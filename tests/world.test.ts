// SPDX-License-Identifier: LGPL-3.0-or-later
/** The bible's entries told apart, weighed and ordered. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tidyWorld } from '../src/core/pipelines/bible'
import { groupOf, worldOrder, worldPresence, worldWeight } from '../src/shared/world'
import { createTestBed, type TestBed } from './support/harness'

describe('the entries of the bible', () => {
  it('are on four pages: places, houses, things — and ideas, which is everything else', () => {
    expect(groupOf('location')).toBe('places')
    expect(groupOf('faction')).toBe('factions')
    expect(groupOf('item')).toBe('items')
    for (const category of ['setting', 'system', 'history', 'culture', 'rule', 'term', 'other'] as const) expect(groupOf(category)).toBe('ideas')
  })

  it('weigh what the chapters make of them, unless the author says', () => {
    // A fifth of the book and at least five chapters is where the story lives.
    expect(worldWeight({}, 16, 80)).toBe('core')
    expect(worldWeight({}, 15, 80)).toBe('major')
    expect(worldWeight({}, 5, 10)).toBe('core')
    expect(worldWeight({}, 4, 10)).toBe('major')
    expect(worldWeight({}, 3, 80)).toBe('major')
    expect(worldWeight({}, 2, 80)).toBe('minor')
    expect(worldWeight({}, 1, 80)).toBe('once')
    expect(worldWeight({}, 0, 0)).toBe('once')
    // The author's word stands whatever the chapters say.
    expect(worldWeight({ weight: 'core' }, 0, 80)).toBe('core')
    expect(worldWeight({ weight: 'once' }, 40, 80)).toBe('once')
  })

  it('are named in a chapter by any of their names, or where a digest wrote the place down', () => {
    const entries = [
      { id: 'garden', name: '大观园', aliases: ['园子里', '园'] },
      { id: 'room', name: '怡红院' },
      { id: 'jade', name: '通灵宝玉', aliases: ['那块玉'] },
      { id: 'inn', name: '葫芦庙' },
    ]
    const chapters = [
      { id: 'ch001', text: '葫芦庙里住着一个穷儒。' },
      { id: 'ch002', text: '他进了大观园，往怡红院去。' },
      { id: 'ch003', text: '园子里的花都开了，那块玉却不见了。' },
      { id: 'ch004', text: '众人说起花园的事。' },
    ]
    const presence = worldPresence(entries, chapters, new Map([['ch004', ['怡红院']]]))
    // A one-character name ("园") is in half the sentences of a book: it does not count by itself.
    expect(presence).toEqual([
      { entry: 'garden', chapters: ['ch002', 'ch003'] },
      { entry: 'room', chapters: ['ch002', 'ch004'] },
      { entry: 'jade', chapters: ['ch003'] },
      { entry: 'inn', chapters: ['ch001'] },
    ])
  })

  it('are listed heaviest first, the more often named first among equals, then as they came', () => {
    const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c', weight: 'core' as const }, { id: 'd' }, { id: 'e' }]
    const presence = [{ entry: 'a', chapters: ['1'] }, { entry: 'b', chapters: ['1', '2', '3'] }, { entry: 'd', chapters: ['1', '2', '3', '4'] }, { entry: 'e', chapters: ['2'] }]
    expect(worldOrder(entries, presence, 40).map(entry => entry.id)).toEqual(['c', 'd', 'b', 'a', 'e'])
  })
})

describe('a book knows where its entries are', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('says, with its state, which chapters name each entry — and again after the text changes', async () => {
    const { project } = bed.runtime
    await project.saveWorld({ name: '旧书铺', category: 'location' })
    await project.saveWorld({ name: '三封信', category: 'item', aliases: ['那三封信'], weight: 'core' })
    for (const title of ['一', '二', '三']) await project.addChapter({ title })
    await project.saveChapterText('ch001', '旧书铺的门开着。')
    await project.saveChapterText('ch002', '她把那三封信压在砚台下。')
    const state = await project.state()
    const byEntry = (list: { entry: string; chapters: string[] }[] | undefined): Record<string, string[]> => Object.fromEntries((list ?? []).map(item => [item.entry, item.chapters]))
    expect(byEntry(state.worldPresence)).toEqual({ 旧书铺: ['ch001'], 三封信: ['ch002'] })
    expect(state.world.find(entry => entry.id === '三封信')?.weight).toBe('core')
    await project.saveChapterText('ch003', '回到旧书铺，三封信还在。')
    const again = await project.worldPresence()
    expect(again.written).toBe(3)
    expect(byEntry(again.presence)).toEqual({ 旧书铺: ['ch001', 'ch003'], 三封信: ['ch002', 'ch003'] })
    // Clearing the author's word gives the weight back to the chapters.
    expect((await project.saveWorld({ id: '三封信', weight: '' as never })).weight).toBeUndefined()
  })

  it('are made one where they are the same thing: names, text, picture, ties and marks all go to the one that stays', async () => {
    const { project } = bed.runtime
    for (const title of ['一', '二']) await project.addChapter({ title })
    await project.saveChapterText('ch001', '宁府里摆了酒。')
    await project.saveChapterText('ch002', '东府那边来人了；宁国府的门开着。')
    const picture = await project.writeAsset('images/location-east.png', new Uint8Array([1]))
    const ning = await project.saveWorld({ name: '宁府', category: 'location', summary: '贾珍一房的宅子', importance: 2 })
    const east = await project.saveWorld({ name: '东府', category: 'location', aliases: ['东边府里'], summary: '荣府东边的那座', body: '门前两只石狮子。', visualImage: picture, visualPrompt: '朱门石狮', importance: 1, spots: { 'world:会芳园': { x: 0.3, y: 0.4 } } })
    const formal = await project.saveWorld({ name: '宁国府', category: 'faction', summary: '贾珍一房的宅子' })
    const garden = await project.saveWorld({ name: '会芳园', category: 'location' })
    const city = await project.saveWorld({ name: '神京', category: 'location', related: [east.id, garden.id], spots: { [`world:${formal.id}`]: { x: 0.6, y: 0.2 }, [`world:${garden.id}`]: { x: 0.1, y: 0.1 } } })
    const zhen = await project.saveCharacter({ name: '贾珍' })
    await project.saveTie({ kind: 'within', from: { type: 'world', id: garden.id }, to: { type: 'world', id: east.id } })
    await project.saveTie({ kind: 'within', from: { type: 'world', id: garden.id }, to: { type: 'world', id: ning.id } })
    await project.saveTie({ kind: 'within', from: { type: 'world', id: ning.id }, to: { type: 'world', id: city.id } })
    await project.saveTie({ kind: 'within', from: { type: 'world', id: east.id }, to: { type: 'world', id: ning.id } })
    await project.saveTie({ kind: 'resides', from: { type: 'character', id: zhen.id }, to: { type: 'world', id: formal.id }, since: 'ch001' })
    await project.addIllustration({ id: 'img1', path: picture, prompt: 'p', kind: 'location', target: east.id, createdAt: new Date().toISOString() })

    const merged = await project.mergeWorld('宁府', ['东府', '宁国府', '宁府', '没有这一条'])
    expect(merged.folded).toEqual(['东府', '宁国府'])
    expect(merged.entry).toMatchObject({
      id: ning.id,
      name: '宁府',
      aliases: ['东府', '东边府里', '宁国府'],
      // Its own line stays; what the others say beyond it is kept under their names.
      summary: '贾珍一房的宅子',
      body: '### 东府\n\n荣府东边的那座\n\n门前两只石狮子。',
      // A picture it lacked is taken over, with how it was to be drawn and the marks on it.
      visualImage: picture,
      visualPrompt: '朱门石狮',
      spots: { 'world:会芳园': { x: 0.3, y: 0.4 } },
      // As heavy as the heaviest of them.
      importance: 1,
      category: 'location',
    })
    expect((await project.world()).map(entry => entry.name).sort()).toEqual(['会芳园', '宁府', '神京'].sort())
    // Ties: every end names the one that stays; a double is one, and a thing is not in itself.
    const ties = (await project.ties()).map(tie => `${tie.kind}:${tie.from.id}>${tie.to.id}${tie.since !== undefined ? `@${tie.since}` : ''}`)
    expect(ties.sort()).toEqual([`within:${garden.id}>${ning.id}`, `within:${ning.id}>${city.id}`, `resides:${zhen.id}>${ning.id}@ch001`].sort())
    // What other entries go with, and the marks on their scenes.
    const town = (await project.findWorld('神京'))!
    expect(town.related).toEqual([ning.id, garden.id])
    expect(town.spots).toEqual({ [`world:${ning.id}`]: { x: 0.6, y: 0.2 }, [`world:${garden.id}`]: { x: 0.1, y: 0.1 } })
    // The gallery's record of the picture, and where the text names it by any of its names.
    expect((await project.illustrations())[0]!.target).toBe(ning.id)
    expect((await project.worldPresence()).presence.find(item => item.entry === ning.id)?.chapters).toEqual(['ch001', 'ch002'])
    // By any of its names it is found now.
    expect((await project.findWorld('宁国府'))?.id).toBe(ning.id)
    await expect(project.mergeWorld('宁府', ['宁府'])).rejects.toThrow(/at least one other/)
    await expect(project.mergeWorld('没有', ['宁府'])).rejects.toThrow(/no world entry/)
  })

  it('are looked over by the planner for doubles and wrong kinds — a proposal, which changes nothing', async () => {
    const { project } = bed.runtime
    await project.addChapter({ title: '一' })
    await project.saveChapterText('ch001', '宁府里摆了酒，东府的人都来了。')
    await project.saveWorld({ name: '宁府', category: 'location', summary: '贾珍一房的宅子' })
    await project.saveWorld({ name: '东府', category: 'faction', aliases: ['东边'] })
    await project.saveWorld({ name: '宁国府', category: 'location' })
    await project.saveWorld({ name: '会芳园', category: 'faction' })
    await project.saveWorld({ name: '护官符', category: 'item' })
    bed.llm.responder = (request) => {
      // What it is given: every entry, with its other names, its kind and how often the text names it.
      expect(request.prompt).toContain('- 宁府｜location｜1｜贾珍一房的宅子')
      expect(request.prompt).toContain('- 东府（东边）｜faction｜1｜')
      expect(request.prompt).toContain('5 个条目')
      return JSON.stringify({
        same: [
          { keep: '宁府', others: ['东边', '宁国府（正式名）', '宁府', '不存在'], why: '同一处宅子的三种叫法' },
          // An entry belongs to one group only; a group nothing is left of is no group.
          { keep: '会芳园', others: ['东府'] },
          { keep: '不存在', others: ['护官符'] },
        ],
        kinds: [
          { name: '会芳园', category: 'location', why: '是一处园子' },
          { name: '护官符', category: 'item' },
          { name: '护官符', category: 'nonsense' },
          { name: '不存在', category: 'location' },
        ],
      })
    }
    const tidy = await tidyWorld(bed.core, bed.runtime, { origin: 'user' })
    expect(tidy.entries).toBe(5)
    expect(tidy.same).toEqual([{ keep: { id: '宁府', name: '宁府' }, others: [{ id: '东府', name: '东府' }, { id: '宁国府', name: '宁国府' }], why: '同一处宅子的三种叫法' }])
    // Filed as it is already, or under no kind there is: nothing to propose.
    expect(tidy.kinds).toEqual([{ id: '会芳园', name: '会芳园', from: 'faction', to: 'location', why: '是一处园子' }])
    expect(await project.world()).toHaveLength(5)
    expect((await project.findWorld('会芳园'))!.category).toBe('faction')
    // One entry is nothing to compare.
    for (const name of ['东府', '宁国府', '会芳园', '护官符']) await project.deleteWorld(name)
    await expect(tidyWorld(bed.core, bed.runtime, { origin: 'user' })).rejects.toThrow(/fewer than two/)
  })
})

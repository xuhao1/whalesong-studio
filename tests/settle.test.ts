// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { styleSamples } from '../src/core/pipelines/bible'
import { rereadBook } from '../src/core/pipelines/import'
import { overrule, settleSuggestions, settlesItself } from '../src/core/pipelines/settle'
import { styleExtractTask } from '../src/core/prompts'
import { renderStyle } from '../src/core/render'
import { hashText } from '../src/shared/text'
import type { ChapterMemory } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

describe('what the digests propose, settled by the planner', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ settings: { settleSuggestions: true } }) })
  afterEach(async () => { await bed.cleanup() })

  it('enters what is worth entering, folds in another name, leaves the rest out — and the author says otherwise', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '第一回' })
    await project.saveChapterText(chapter.id, '大观园里，沁芳亭畔。')
    await project.saveWorld({ name: '大观园', category: 'location', summary: '省亲别墅' })
    await project.saveCharacter({ name: '王熙凤', role: 'supporting', personality: '辣' })
    await project.saveThread({ title: '通灵宝玉的来历' })
    await project.addSuggestions([
      { kind: 'new-world', title: '新设定：沁芳亭', detail: '园中水上的亭子', chapterId: chapter.id, payload: { name: '沁芳亭', category: 'other', summary: '园中的亭子' } },
      { kind: 'new-world', title: '新设定：省亲别院', detail: '元春省亲用的园子', chapterId: chapter.id, payload: { name: '省亲别院', category: 'location' } },
      { kind: 'new-world', title: '新设定：茶盅', detail: '桌上的茶盅', chapterId: chapter.id, payload: { name: '茶盅', category: 'item' } },
      { kind: 'new-thread', title: '金锁上的字', detail: '和玉上的是一对', chapterId: chapter.id, payload: { title: '金锁上的字', description: '和玉上的是一对' } },
      { kind: 'alias', title: '凤姐 是 王熙凤', detail: '同一个人', sifted: true, payload: { name: '凤姐', target: 'char:王熙凤' } },
      { kind: 'new-character', title: '新人物：平儿', detail: '凤姐的心腹', sifted: true, payload: { name: '平儿', role: 'minor' } },
      { kind: 'new-character', title: '新人物：小厮', detail: '逐章提的，没筛过', payload: { name: '小厮' } },
      { kind: 'bible-edit', title: '改王熙凤的性格', detail: '策划建议', payload: { target: 'character', id: 'char:王熙凤', field: 'personality', value: '泼辣' } },
    ])
    const target = (await project.findCharacter('王熙凤'))!.id
    // The alias suggestion points at the card by its id, as the sift writes it.
    const waiting = await project.suggestions()
    await project.writeState(['suggestions.json'], waiting.map(item => (item.kind === 'alias' ? { ...item, payload: { ...item.payload, target } } : item)))

    const asked: string[] = []
    bed.llm.responder = (request) => {
      asked.push(request.prompt)
      const numbered = [...request.prompt.matchAll(/^(\d+)\. \[[^\]]+\] (\S+)/gm)].map(match => ({ n: Number(match[1]), title: match[2]! }))
      return JSON.stringify({ verdicts: numbered.map(({ n, title }) => {
        if (title.includes('沁芳亭')) return { n, verdict: 'enter', why: '园中的地方，后面还要回来', category: 'location', summary: '大观园里水上的亭子' }
        if (title.includes('省亲别院')) return { n, verdict: 'merge', into: '大观园', why: '就是大观园' }
        if (title.includes('茶盅')) return { n, verdict: 'skip', why: '寻常物件' }
        return { n, verdict: 'enter', why: '真埋下了' }
      }) })
    }
    expect(settlesItself(bed.core)).toBe(true)
    const result = await settleSuggestions(bed.core, bed.runtime, { origin: 'user' })

    // One request; it is told what the bible has and what threads there are.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('大观园')
    expect(asked[0]).toContain('通灵宝玉的来历')
    expect(asked[0]).not.toContain('小厮')
    expect(asked[0]).not.toContain('改王熙凤的性格')

    expect(result.entered.sort()).toEqual(['平儿', '沁芳亭', '金锁上的字'].sort())
    expect(result.merged).toEqual(expect.arrayContaining([{ name: '凤姐', into: '王熙凤' }, { name: '省亲别院', into: '大观园' }]))
    expect(result.skipped).toBe(1)

    // Entered as the planner put it: the kind and the line it gave.
    const pavilion = (await project.findWorld('沁芳亭'))!
    expect(pavilion.category).toBe('location')
    expect(pavilion.summary).toBe('大观园里水上的亭子')
    expect((await project.findWorld('大观园'))!.aliases).toContain('省亲别院')
    expect(await project.findWorld('茶盅')).toBeUndefined()
    expect((await project.findCharacter('王熙凤'))!.aliases).toContain('凤姐')
    expect(await project.findCharacter('平儿')).toBeDefined()
    expect((await project.outline()).threads.map(thread => thread.title)).toContain('金锁上的字')

    // What somebody wrote is the author's to change, and a name nobody looked at waits for the sift: both wait still.
    expect((await project.suggestions()).map(item => item.kind).sort()).toEqual(['bible-edit', 'new-character'])
    // Somebody's personality was not touched.
    expect((await project.findCharacter('王熙凤'))!.personality).toBe('辣')

    // On record, each with its reason.
    const record = await project.settled()
    expect(record).toHaveLength(6)
    const of = (title: string) => record.find(item => item.title.includes(title))!
    expect(of('沁芳亭')).toMatchObject({ verdict: 'entered', why: '园中的地方，后面还要回来', target: { type: 'world', id: pavilion.id } })
    expect(of('省亲别院')).toMatchObject({ verdict: 'merged', into: '大观园' })
    expect(of('茶盅')).toMatchObject({ verdict: 'skipped', why: '寻常物件' })

    // The author says otherwise: what entered is taken back, what was left out is entered.
    expect((await overrule(bed.runtime, of('沁芳亭').id, 'undo')).verdict).toBe('undone')
    expect(await project.findWorld('沁芳亭')).toBeUndefined()
    expect((await project.removedCards()).map(item => item.name)).toContain('沁芳亭')
    expect((await overrule(bed.runtime, of('省亲别院').id, 'undo')).verdict).toBe('undone')
    expect((await project.findWorld('大观园'))!.aliases ?? []).not.toContain('省亲别院')
    expect((await overrule(bed.runtime, of('茶盅').id, 'enter')).verdict).toBe('entered')
    expect(await project.findWorld('茶盅')).toBeDefined()
    expect((await overrule(bed.runtime, of('金锁上的字').id, 'undo')).verdict).toBe('undone')
    expect((await project.outline()).threads.map(thread => thread.title)).not.toContain('金锁上的字')
    // And back again.
    expect((await overrule(bed.runtime, of('沁芳亭').id, 'enter')).verdict).toBe('entered')
    expect(await project.findWorld('沁芳亭')).toBeDefined()
  })

  it('leaves a suggestion waiting where the planner said nothing of it, and asks nobody where nothing waits', async () => {
    const { project } = bed.runtime
    await project.addSuggestions([
      { kind: 'new-world', title: '新设定：甲', detail: '甲', payload: { name: '甲' } },
      { kind: 'new-world', title: '新设定：乙', detail: '乙', payload: { name: '乙' } },
    ])
    let calls = 0
    bed.llm.responder = () => {
      calls += 1
      return JSON.stringify({ verdicts: [{ n: 1, verdict: 'enter', why: '要紧' }, { n: 9, verdict: 'enter' }] })
    }
    const result = await settleSuggestions(bed.core, bed.runtime, { origin: 'user' })
    expect(result.entered).toEqual(['甲'])
    expect((await project.suggestions()).map(item => item.title)).toEqual(['新设定：乙'])
    await project.takeSuggestion((await project.suggestions())[0]!.id)
    calls = 0
    const again = await settleSuggestions(bed.core, bed.runtime, { origin: 'user' })
    expect(calls).toBe(0)
    expect(again.looked).toBe(0)
  })
})

describe('reading a book again from its text alone', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('clears what was read off the text, takes the book in anew, and puts the pictures back by name', async () => {
    const { project } = bed.runtime
    const ids: string[] = []
    for (let n = 1; n <= 2; n++) {
      const plan = await project.addChapter({ title: `第${n}回`, synopsis: '旧梗概', location: '旧地方' })
      ids.push(plan.id)
      const text = `第${n}回：黛玉进了大观园，见着宝玉。${'只见佳木茏葱，奇花闪灼，一带清流，从花木深处曲折泻于石隙之下。'.repeat(3)}`
      await project.saveChapterText(plan.id, text)
      const memory: ChapterMemory = { schema: 1, chapterId: plan.id, textHash: hashText(text), updatedAt: '', brief: '旧', summary: '旧的收录', facts: [], threads: [], characters: [{ character: '林黛玉', name: '林黛玉', role: '进府' }], newEntities: [] }
      await project.saveMemory(memory)
    }
    const lin = await project.saveCharacter({ name: '林黛玉', role: 'protagonist', personality: '作者手写的一段', visual: { prompt: 'slender girl', portrait: 'assets/images/lin.png', sheet: 'assets/images/lin-sheet.png' } })
    await project.saveCharacter({ name: '旧人', role: 'minor', visual: { portrait: 'assets/images/old.png' } })
    const garden = await project.saveWorld({ name: '大观园', category: 'location', summary: '旧的说法', visualImage: 'assets/images/garden.png' })
    await project.saveTie({ kind: 'resides', from: { type: 'character', id: lin.id }, to: { type: 'world', id: garden.id } })
    await project.saveThread({ title: '旧线索' })
    await project.addSuggestions([{ kind: 'new-world', title: '新设定：旧建议', detail: '旧', payload: { name: '旧建议' } }])
    await project.updateChapter(ids[0]!, { characters: [lin.id] })

    const prompts: string[] = []
    bed.llm.responder = (request) => {
      prompts.push(request.prompt)
      const prompt = request.prompt
      if (prompt.includes('"summary"') && prompt.includes('"brief"')) {
        return JSON.stringify({ brief: '黛玉进园', summary: '黛玉进了大观园，见着宝玉。', storyTime: '初春', locations: ['大观园'], characters: [
          { name: '林黛玉', role: '进了园子', seen: '十二三岁，身量未足', manner: '步步留心' },
          { name: '贾宝玉', role: '来见她', seen: '束发嵌宝紫金冠' },
        ], facts: [], threads: [], newEntities: [{ name: '大观园', kind: 'location', description: '省亲的园子', looks: '佳木茏葱，一带清流' }], moments: [] })
      }
      if (prompt.includes('【这一批】')) {
        return JSON.stringify({ characters: [
          { listed: '林黛玉', name: '林黛玉', role: 'protagonist', personality: '敏而多思', appearance: '十二三岁，身量未足' },
          { listed: '贾宝玉', name: '贾宝玉', role: 'protagonist', personality: '痴' },
        ] })
      }
      if (prompt.includes('同一个人的不同称呼')) return JSON.stringify({ same: [] })
      if (prompt.includes('地点、组织、物品与专有名词')) return JSON.stringify({ entries: [{ name: '大观园', category: 'location', importance: 2, summary: '省亲的园子', look: '佳木茏葱，一带清流' }] })
      if (prompt.includes('语体是这份档案里最要紧的一栏')) return JSON.stringify({ name: '原作文风', register: '古白话（明清章回体）：道、便、只见', tone: '含蓄', rules: ['用古白话写'] })
      return JSON.stringify({})
    }
    const result = await rereadBook(bed.core, bed.runtime, {}, { origin: 'user' })

    expect(result.cleared).toMatchObject({ digests: 2, characters: 2, world: 1, ties: 1, threads: 1, suggestions: 1, plans: 2 })
    // The digests were asked for again, and were given what the text shows of each person.
    expect(prompts.filter(prompt => prompt.includes('"brief"'))).toHaveLength(2)
    // The cast is told how people looked and bore themselves in the chapters, so nobody reads the book again for a card.
    const round = prompts.find(prompt => prompt.includes('【这一批】'))!
    expect(round).toContain('身量未足')
    expect(round).toContain('步步留心')
    // The world is told what a thing looks like, and keeps it for its pictures.
    expect(prompts.find(prompt => prompt.includes('地点、组织、物品与专有名词'))).toContain('佳木茏葱')

    const cards = await project.characters()
    expect(cards.map(card => card.name).sort()).toEqual(['林黛玉', '贾宝玉'])
    const again = cards.find(card => card.name === '林黛玉')!
    // The card is the new one — and the pictures drawn of her are on it again.
    expect(again.personality).toBe('敏而多思')
    expect(again.visual).toMatchObject({ prompt: 'slender girl', portrait: 'assets/images/lin.png', sheet: 'assets/images/lin-sheet.png' })
    expect(result.pictures).toEqual({ people: 1, things: 1 })
    expect(result.without).toEqual(['旧人'])
    // What she was is in her history; who has no card now is among the removed.
    expect((await project.history('character', again.id)).some(version => version.why === 'removed')).toBe(true)
    expect((await project.removedCards()).map(item => item.name)).toEqual(['旧人'])

    const world = await project.world()
    expect(world.find(entry => entry.name === '大观园')).toMatchObject({ summary: '省亲的园子', visualImage: 'assets/images/garden.png' })
    expect(await project.ties()).toEqual([])
    expect((await project.outline()).threads).toEqual([])
    expect(await project.suggestions()).toEqual([])
    // The outline was emptied of what it took from the text, and filled again from the new digests.
    const plan = (await project.findChapter(ids[0]!))!.plan
    expect(plan.synopsis).toBe('黛玉进园')
    expect(plan.location).toBe('大观园')
    expect(plan.characters).toEqual(expect.arrayContaining([again.id]))
    // The text is as it was.
    expect(await project.chapterText(ids[0]!)).toContain('黛玉进了大观园')
    // The style was learned anew, the kind of language first.
    const style = (await project.styles()).find(item => item.name === '原作文风')!
    expect(style.register).toContain('古白话')
    expect(renderStyle(style, 'zh')).toContain('语体（全文都用它写）：古白话')
  })
})

describe('the passages a style is learned from', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('takes the opening and the middle of chapters a third and two thirds in, whole paragraphs', async () => {
    const { project } = bed.runtime
    for (let n = 1; n <= 6; n++) {
      const plan = await project.addChapter({ title: `第${n}回` })
      await project.saveChapterText(plan.id, Array.from({ length: 8 }, (_unused, at) => `第${n}回第${at + 1}段。${'话说'.repeat(40)}`).join('\n\n'))
    }
    const sample = await styleSamples(project, 900)
    const parts = sample.split('\n\n……\n\n')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toContain('第1回第1段')
    expect(parts[1]).toContain('第3回第5段')
    expect(parts[2]).toContain('第5回第5段')
    // The prompt asks for the kind of language before anything else, by the words on the page.
    const prompt = styleExtractTask({ lang: 'zh', sample })
    expect(prompt).toContain('"register"')
    expect(prompt.indexOf('"register"')).toBeLessThan(prompt.indexOf('"pov"'))
    expect(prompt).toContain('古白话')
  })
})

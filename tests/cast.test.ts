// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isThinCard, mergeCast } from '../src/core/pipelines/cast'
import { analyzeBook } from '../src/core/pipelines/import'
import { hashText } from '../src/shared/text'
import type { ChapterMemory } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

/** Who acts in which of the book's chapters, by number. */
const PARTS: Record<string, number[]> = {
  贾宝玉: [2, 3, 4, 5, 6, 7, 8, 9, 10, 12],
  林黛玉: [2, 3, 5, 7, 8, 9, 11, 13],
  贾母: [3, 4, 6, 8, 10, 12],
  王熙凤: [3, 6, 7, 11, 13],
  凤姐: [8, 9, 12, 14],
  平儿: [6, 11],
  智能儿: [14],
}

describe('the cast of a book', () => {
  let bed: TestBed
  let ids: string[]
  beforeEach(async () => {
    bed = await createTestBed()
    const { project } = bed.runtime
    ids = []
    for (let n = 1; n <= 14; n++) {
      const plan = await project.addChapter({ title: `第${n}回` })
      ids.push(plan.id)
      const text = `这是第${n}回的正文。`
      await project.saveChapterText(plan.id, text)
      const here = Object.entries(PARTS).filter(([, chapters]) => chapters.includes(n)).map(([name]) => name)
      const memory: ChapterMemory = {
        schema: 1, chapterId: plan.id, textHash: hashText(text), updatedAt: '', brief: `第${n}回`, summary: `第${n}回里发生的事。`, facts: [], threads: [],
        characters: here.map(name => ({ character: name, name, role: `${name}在第${n}回做了事`, quote: `${name}的话` })),
        newEntities: n === 2 ? [{ name: '贾宝玉', kind: 'character', description: '衔玉而生的公子' }] : [],
      }
      await project.saveMemory(memory)
    }
  })
  afterEach(async () => { await bed.cleanup() })

  it('gives everybody a card as full as their part is large, and one person one card', async () => {
    const { project } = bed.runtime
    // A card somebody worked on; a card the Studio made from a suggestion and nobody touched; and suggestions still waiting.
    await project.saveCharacter({ name: '贾母', role: 'supporting', personality: '慈而有威，一言定家事' })
    await project.saveCharacter({ name: '凤姐', role: 'minor', tagline: '管家的少奶奶' })
    await project.addSuggestions([
      { kind: 'new-character', title: '新人物：贾宝玉', detail: '衔玉而生', payload: { name: '贾宝玉' } },
      { kind: 'new-character', title: '新人物：智能儿', detail: '小尼姑', payload: { name: '智能儿' } },
    ])
    expect(isThinCard((await project.findCharacter('凤姐'))!)).toBe(true)
    expect(isThinCard((await project.findCharacter('贾母'))!)).toBe(false)
    expect((await project.state()).uncarded).toEqual({ count: 3, names: ['贾宝玉', '林黛玉', '王熙凤'] })

    // A card the Studio made for a name that is in fact somebody else's — and has no chapter of its own for a round to ask about.
    await project.saveCharacter({ name: '平姑娘', role: 'minor', tagline: '凤姐房里的丫头' })
    const asked: { full: boolean; names: string[]; known: string }[] = []
    const aliasAsked: string[] = []
    bed.llm.responder = (request) => {
      // The last request looks through the finished list for one person under two names.
      if (request.prompt.includes('同一个人的不同称呼')) {
        aliasAsked.push(request.prompt)
        return JSON.stringify({ same: [{ keep: '平儿', others: ['平姑娘'] }, { keep: '贾宝玉', others: ['贾母'] }] })
      }
      const full = request.prompt.includes('一张人物卡')
      const batch = request.prompt.split('【这一批】')[1]!.split('【已经有人物卡的人】')[0]!
      const names = [...batch.matchAll(/^- (\S+) \(/gm)].map(match => match[1]!)
      asked.push({ full, names, known: request.prompt.split('【已经有人物卡的人】')[1]! })
      if (full) {
        return JSON.stringify({ characters: [
          { listed: '贾宝玉', name: '贾宝玉', aliases: ['宝二爷'], role: 'protagonist', personality: '痴', relationships: [{ target: '林黛玉', kind: '表兄妹' }] },
          { listed: '林黛玉', name: '林黛玉', role: 'deuteragonist', personality: '敏' },
          { listed: '王熙凤', name: '王熙凤', role: 'supporting', personality: '辣' },
          // Another name of somebody in the same batch, and a person nobody asked about.
          { listed: '凤姐', same_as: '王熙凤' },
          { listed: '薛宝钗', name: '薛宝钗', role: 'supporting' },
        ] })
      }
      return JSON.stringify({ characters: [{ listed: '平儿', name: '平儿', role: 'minor', tagline: '凤姐的陪房丫头' }] })
    }
    const result = await mergeCast(bed.core, bed.runtime, { origin: 'user' })
    expect(result).toMatchObject({ made: 4, filled: 0, merged: 2, walkOns: 1, rounds: 2, failed: [] })
    // Seen beside every other name, 平姑娘 is 平儿: folded in. Two cards that were both worked on are never folded, whatever the planner says.
    expect(aliasAsked).toHaveLength(1)
    expect(aliasAsked[0]).toContain('- 平姑娘')
    expect(await project.findCharacter('平姑娘')).toMatchObject({ name: '平儿' })
    expect((await project.findCharacter('贾母'))!.name).toBe('贾母')

    // The most present are asked about first and whole; who comes back once gets a line; who passes once is not asked about at all.
    expect(asked.map(round => [round.full, round.names])).toEqual([[true, ['贾宝玉', '林黛玉', '王熙凤', '凤姐']], [false, ['平儿']]])
    // The planner is told who has a card already — the one somebody worked on is there to be recognized, not to be written again.
    expect(asked[0]!.known).toContain('贾母')
    expect(asked[1]!.known).toContain('王熙凤')

    const cards = await project.characters()
    expect(cards.map(card => card.name).sort()).toEqual(['贾宝玉', '贾母', '平儿', '林黛玉', '王熙凤'].sort())
    expect(await project.findCharacter('宝二爷')).toMatchObject({ name: '贾宝玉', role: 'protagonist', firstAppearance: ids[1], lastAppearance: ids[11] })
    // 凤姐 is 王熙凤: the untouched card is gone, the name is an alias, and her chapters under either name are hers.
    const phoenix = (await project.findCharacter('凤姐'))!
    expect(phoenix).toMatchObject({ name: '王熙凤', role: 'supporting', firstAppearance: ids[2], lastAppearance: ids[13] })
    expect((await project.memory(ids[8]!))!.characters.find(moment => moment.name === '凤姐')!.character).toBe(phoenix.id)
    expect(await project.findCharacter('平儿')).toMatchObject({ role: 'minor', tagline: '凤姐的陪房丫头' })
    // What somebody wrote stays as they wrote it.
    expect(await project.findCharacter('贾母')).toMatchObject({ role: 'supporting', personality: '慈而有威，一言定家事' })
    expect(await project.findCharacter('智能儿')).toBeUndefined()
    expect(await project.findCharacter('薛宝钗')).toBeUndefined()
    // Those who have a card now are no longer waiting to be given one; the walk-on still is, for whoever wants her.
    expect((await project.suggestions()).map(item => item.payload.name)).toEqual(['智能儿'])
    expect((await project.state()).uncarded).toBeUndefined()

    // Run again, there is nothing left to do for those who are settled.
    asked.length = 0
    bed.llm.responder = () => JSON.stringify({ characters: [] })
    expect(await mergeCast(bed.core, bed.runtime, { origin: 'user' })).toMatchObject({ made: 0, filled: 0, merged: 0 })
    expect(asked).toEqual([])
  })

  it('fills in a card nobody worked on when the person turns out to matter', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '林黛玉', role: 'minor', tagline: '林如海之女' })
    bed.llm.responder = request => JSON.stringify({ characters: request.prompt.includes('一张人物卡')
      ? [{ listed: '林黛玉', name: '林黛玉', role: 'deuteragonist', personality: '敏而多思', tagline: '寄居贾府的孤女' }]
      : [] })
    const result = await mergeCast(bed.core, bed.runtime, { origin: 'user' })
    expect(result.filled).toBe(1)
    expect(await project.findCharacter('林黛玉')).toMatchObject({ role: 'deuteragonist', personality: '敏而多思', tagline: '寄居贾府的孤女' })
    expect((await project.characters()).filter(card => card.name === '林黛玉')).toHaveLength(1)
  })

  it('keeps everything the digests found until somebody settles it', async () => {
    const { project } = bed.runtime
    // The leads of an imported book are met in its first chapters: the first found must still be there after hundreds more.
    await project.addSuggestions(Array.from({ length: 640 }, (_, n) => ({ kind: 'new-character' as const, title: `新人物：人物${n}`, detail: '', payload: { name: `人物${n}` } })))
    const waiting = await project.suggestions()
    expect(waiting).toHaveLength(640)
    expect(waiting[0]!.payload.name).toBe('人物0')
  })

  it('takes an analysis that was cut short up where it stopped', async () => {
    const { project } = bed.runtime
    let castCalls = 0
    const respond = (failCast: boolean) => (request: { prompt: string; system?: string }) => {
      if (request.prompt.includes('一批人物')) {
        castCalls += 1
        if (failCast) throw new Error('the planner is not answering')
        return JSON.stringify({ characters: [] })
      }
      if (request.prompt.includes('地点、组织、物品')) return JSON.stringify({ entries: [] })
      if (request.prompt.includes('所有画面共用的画风')) return JSON.stringify({ style: '工笔淡彩，绢本的旧色', avoid: ['现代服饰'], why: '清代世家的故事。' })
      if (request.prompt.includes('一句话摘要')) return JSON.stringify({ logline: '大观园里的一场梦。', premise: '……', volumes: [] })
      if (request.prompt.includes('文体学者')) return JSON.stringify({ name: 'x', pov: 'third-omniscient', tone: '绮丽', rules: [], avoid: [] })
      return 'ok'
    }
    bed.llm.responder = respond(true)
    const first = await analyzeBook(bed.core, bed.runtime, { fresh: true, style: false }, { origin: 'user' })
    expect(first.failed.map(failure => failure.step)).toContain('cast 1/2')
    // The book says what was left undone — and only that.
    expect((await project.state()).analysis).toEqual({ pending: ['cast'] })
    expect((await project.manifest()).logline).toBe('大观园里的一场梦。')
    // Reading a book ends with the director settling how its pictures look.
    expect(first.art).toBe('工笔淡彩，绢本的旧色')
    expect(await project.manifest()).toMatchObject({ artStyle: '工笔淡彩，绢本的旧色', artAvoid: ['现代服饰'] })

    bed.llm.responder = respond(false)
    castCalls = 0
    const second = await analyzeBook(bed.core, bed.runtime, {}, { origin: 'user' })
    expect(second.steps).toEqual(['cast'])
    expect(castCalls).toBeGreaterThan(0)
    expect(second.failed).toEqual([])
    expect((await project.state()).analysis).toBeUndefined()
    // A pass can be run again by name, whatever was done before.
    expect((await analyzeBook(bed.core, bed.runtime, { steps: ['world'] }, { origin: 'user' })).steps).toEqual(['world'])
  })

  it('does not call an analysis from before the art pass unfinished, and leaves a look the author gave alone', async () => {
    const { project } = bed.runtime
    // A note as an earlier version left it: every pass it knew of done.
    await project.writeState(['analysis.json'], { schema: 1, startedAt: '2026-10-07T00:00:00.000Z', done: ['digest', 'cast', 'world', 'outline', 'style'] })
    expect((await project.state()).analysis).toBeUndefined()
    // Asked to go on, there is nothing to go on with — and nobody is asked anything.
    let asked = 0
    bed.llm.responder = () => { asked += 1; return '{}' }
    expect((await analyzeBook(bed.core, bed.runtime, {}, { origin: 'user' })).steps).toEqual([])
    expect(asked).toBe(0)
    // The same for one from before the ties were worked out as a pass of the analysis: it had six passes, and did them.
    await project.writeState(['analysis.json'], { schema: 2, startedAt: '2026-10-08T00:00:00.000Z', done: ['digest', 'cast', 'world', 'outline', 'style', 'art'] })
    expect((await project.state()).analysis).toBeUndefined()
    expect((await analyzeBook(bed.core, bed.runtime, {}, { origin: 'user' })).steps).toEqual([])
    // …and one of them cut short is told what it has left of its own six, not a seventh.
    await project.writeState(['analysis.json'], { schema: 2, startedAt: '2026-10-08T00:00:00.000Z', done: ['digest', 'cast', 'world'] })
    expect((await project.state()).analysis).toEqual({ pending: ['outline', 'style', 'art'] })
    await project.writeState(['analysis.json'], { schema: 1, startedAt: '2026-10-07T00:00:00.000Z', done: ['digest', 'cast', 'world', 'outline', 'style'] })
    expect(asked).toBe(0)
    // A new analysis has the pass; a book whose author has given it a look keeps that look.
    await project.updateManifest({ artStyle: '水墨，留白' })
    bed.llm.responder = request => request.prompt.includes('所有画面共用的画风') ? JSON.stringify({ style: '厚涂' }) : JSON.stringify({ characters: [], entries: [], logline: 'x', premise: 'y', volumes: [] })
    const fresh = await analyzeBook(bed.core, bed.runtime, { fresh: true, style: false }, { origin: 'user' })
    expect(fresh.steps).toContain('art')
    // A new analysis works the ties out too, after the world and before the outline; a book with no places, houses or things has nothing to tie, and that is no pass left undone.
    expect(fresh.steps).toEqual(['digest', 'cast', 'growth', 'world', 'ties', 'outline', 'art'])
    expect(fresh.failed.map(failure => failure.step)).not.toContain('ties')
    expect((await project.state()).analysis).toBeUndefined()
    expect(fresh.art).toBeUndefined()
    expect((await project.manifest()).artStyle).toBe('水墨，留白')
    // Asked for by name, the director settles it anew.
    expect((await analyzeBook(bed.core, bed.runtime, { steps: ['art'] }, { origin: 'user' })).art).toBe('厚涂')
    expect((await project.manifest()).artStyle).toBe('厚涂')
  })

  it('does not call a book half analysed because one pass was run on it by name', async () => {
    const { project } = bed.runtime
    bed.llm.responder = () => JSON.stringify({ characters: [] })
    // A book written here, never imported: making its cast is making its cast.
    await analyzeBook(bed.core, bed.runtime, { steps: ['cast'] }, { origin: 'user' })
    expect((await project.state()).analysis).toBeUndefined()
  })
})

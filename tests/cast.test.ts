// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isThinCard, mergeCast, scheduleSift, siftCast, siftDue } from '../src/core/pipelines/cast'
import { acceptSuggestion } from '../src/core/pipelines/bible'
import { listWalkOns, settleWalkOn } from '../src/core/walkons'
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

describe('who is worth a card', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('has the planner say who of the names without a card is worth one, and leaves the rest walk-ons', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '王熙凤', role: 'deuteragonist', personality: '机关算尽' })
    const ids: string[] = []
    for (let n = 1; n <= 3; n++) ids.push((await project.addChapter({ title: `第${n}回` })).id)
    const memory = (chapterId: string, names: [string, string][]) => ({ schema: 1 as const, chapterId, textHash: 'x', updatedAt: '', brief: '', summary: '', facts: [], threads: [], newEntities: [], characters: names.map(([name, role]) => ({ character: name, name, role })) })
    await project.saveMemory(memory(ids[0]!, [['刘姥姥', '进荣国府打抽丰'], ['门子', '通报一声'], ['凤丫头', '被贾母这样叫']]))
    await project.saveMemory(memory(ids[1]!, [['刘姥姥', '带着板儿见了凤姐'], ['周瑞家的', '引路'], ['板儿', '躲在姥姥身后']]))
    // Proposed chapter by chapter by an older version: the backlog.
    await project.addSuggestions([{ kind: 'new-character', title: '新人物：门子', detail: '通报的', payload: { name: '门子', role: 'minor' } }])
    expect((await siftDue(bed.runtime)).map(item => item.name)).toEqual(['刘姥姥', '凤丫头', '周瑞家的', '板儿', '门子'])

    bed.llm.responder = () => JSON.stringify({ people: [
      { name: '刘姥姥', is: 'card', why: '两回都有她自己的戏：进府、见凤姐。', role: 'supporting', tagline: '乡下来打抽丰的老妇' },
      { name: '板儿', is: 'alias', why: '书里没有这个人。', same_as: '查无此人' },
      { name: '凤丫头', is: 'alias', why: '贾母对王熙凤的称呼。', same_as: '王熙凤' },
      { name: '周瑞家的', is: 'walkon', why: '只引了一次路。' },
      { name: '门子', is: 'walkon', why: '通报一声就没有了。' },
      { name: '名单之外的人', is: 'card', why: '不该有' },
    ] })
    const done = await siftCast(bed.core, bed.runtime, {}, { origin: 'user' })
    expect(done).toMatchObject({ looked: 5, cards: ['刘姥姥'], aliases: [{ name: '凤丫头', of: '王熙凤' }], walkOns: 3, failed: [] })
    // What it was handed: every name with where it is seen and what the digests say, and who has a card.
    const asked = bed.llm.requests.at(-1)!.prompt
    for (const part of ['- 刘姥姥（出现在 2 章：第 1、2 章）：', '- 门子（出现在 1 章：第 1 章）', '【已经有人物卡的人】只用来辨认别名\n王熙凤', '龙套。场面上的人']) expect(asked, part).toContain(part)
    // Worth a card: a suggestion with the reason. Another name of somebody: a suggestion to fold it in. A walk-on: no
    // suggestion — the one an older version made for the doorman is gone — and what the planner said is kept with the name.
    const suggestions = await project.suggestions()
    expect(suggestions.map(item => [item.kind, item.title, item.sifted]).sort()).toEqual([['alias', '别名：「凤丫头」就是王熙凤？', true], ['new-character', '新人物：刘姥姥', true]])
    const list = await listWalkOns(project)
    expect(Object.fromEntries(list.map(item => [item.name, [item.verdict?.is, item.verdict?.why, item.verdict?.seen]]))).toEqual({
      刘姥姥: ['card', '两回都有她自己的戏：进府、见凤姐。', 2],
      凤丫头: ['alias', '贾母对王熙凤的称呼。', 1],
      周瑞家的: ['walkon', '只引了一次路。', 1],
      板儿: ['walkon', '书里没有这个人。 （策划认为是「查无此人」的另一个称呼，但书里没有这个人的卡）', 1],
      门子: ['walkon', '通报一声就没有了。', 1],
    })
    // The doorman is on the list still, although the suggestion that was his only trace is gone.
    await project.saveMemory(memory(ids[0]!, [['刘姥姥', '进荣国府打抽丰'], ['凤丫头', '被贾母这样叫']]))
    expect((await listWalkOns(project)).find(item => item.name === '门子')).toMatchObject({ chapters: [], verdict: { is: 'walkon', why: '通报一声就没有了。' } })
    await project.saveMemory(memory(ids[0]!, [['刘姥姥', '进荣国府打抽丰'], ['门子', '通报一声'], ['凤丫头', '被贾母这样叫']]))
    // Nothing was made or folded: the cast is the author's. Accepting the other name folds it in.
    expect((await project.characters()).map(card => card.name)).toEqual(['王熙凤'])
    await acceptSuggestion(bed.runtime, suggestions.find(item => item.kind === 'alias')!.id)
    expect((await project.findCharacter('王熙凤'))!.aliases).toEqual(['凤丫头'])
    // Nobody is asked about twice — until they are seen in more chapters: a walk-on who comes back is looked at again.
    const calls = bed.llm.requests.length
    expect(await siftCast(bed.core, bed.runtime, {}, { origin: 'user' })).toMatchObject({ looked: 0 })
    expect(bed.llm.requests.length).toBe(calls)
    await project.saveMemory(memory(ids[2]!, [['周瑞家的', '替凤姐传话，又去送宫花']]))
    expect((await siftDue(bed.runtime)).map(item => item.name)).toEqual(['周瑞家的'])
    bed.llm.responder = () => JSON.stringify({ people: [{ name: '周瑞家的', is: 'card', why: '两回都在凤姐跟前办事。', role: 'minor' }] })
    expect(await siftCast(bed.core, bed.runtime, {}, { origin: 'user' })).toMatchObject({ looked: 1, cards: ['周瑞家的'] })
    expect(bed.llm.requests.at(-1)!.prompt).toContain('- 周瑞家的（出现在 2 章：第 2、3 章）')
    expect(bed.llm.requests.at(-1)!.prompt).not.toContain('- 门子（')
    // The whole list again, on the author's word — with what they ask of it.
    bed.llm.responder = () => JSON.stringify({ people: [{ name: '门子', is: 'card', why: '作者要他。', role: 'cameo' }] })
    const again = await siftCast(bed.core, bed.runtime, { all: true, direction: '门子后面要用' }, { origin: 'user' })
    expect(bed.llm.requests.at(-1)!.prompt).toContain('【作者的要求】\n门子后面要用')
    expect(again.cards).toEqual(['门子'])
    // What the author took off the list is not asked about.
    await settleWalkOn(project, { name: '板儿', action: 'ignore' })
    expect((await siftDue(bed.runtime, true)).map(item => item.name)).not.toContain('板儿')
    expect((await listWalkOns(project, { ignored: true })).find(item => item.name === '板儿')?.verdict?.is).toBe('walkon')
  })

  it('looks through the new names by itself once digests have settled, where the author lets it', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '第一回' })
    await project.saveMemory({ schema: 1, chapterId: chapter.id, textHash: 'x', updatedAt: '', brief: '', summary: '', facts: [], threads: [], newEntities: [], characters: [{ character: '门子', name: '门子', role: '通报' }] })
    bed.llm.responder = () => JSON.stringify({ people: [{ name: '门子', is: 'walkon', why: '通报一声。' }] })
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    // Switched off (as every other test has it): nothing is asked.
    scheduleSift(bed.core, bed.runtime, { origin: 'user' }, 5)
    await wait(60)
    expect(bed.llm.requests).toHaveLength(0)
    await bed.core.settings.update({ siftCast: true })
    for (let n = 0; n < 40 && bed.core.currentSettings().siftCast !== true; n++) await wait(10)
    // Asked twice in a row, it is one look.
    scheduleSift(bed.core, bed.runtime, { origin: 'user' }, 5)
    scheduleSift(bed.core, bed.runtime, { origin: 'user' }, 5)
    for (let n = 0; n < 40 && (await listWalkOns(project))[0]?.verdict === undefined; n++) await wait(25)
    expect(bed.llm.requests).toHaveLength(1)
    expect((await listWalkOns(project))[0]!.verdict).toMatchObject({ is: 'walkon', why: '通报一声。' })
    expect(bed.core.jobs.list(project.root).filter(job => job.title === 'sift cast')).toHaveLength(1)
    // Nobody new: nothing is asked, and no job is started.
    scheduleSift(bed.core, bed.runtime, { origin: 'user' }, 5)
    await wait(60)
    expect(bed.llm.requests).toHaveLength(1)
    expect(bed.core.jobs.list(project.root).filter(job => job.title === 'sift cast')).toHaveLength(1)
  })
})

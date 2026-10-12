// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a writer is handed, prepared for the piece by the planner: it looks first — reads in the book as far as the
 * piece needs — and what it chooses is what goes; nothing comes along for standing near, or for turning up in a
 * search. What the work stands on goes whoever prepares it: the chapter's plan, where it joins, the text worked on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keptMaterial } from '../src/core/pipelines/material'
import { reviseChapter, reviseSpan } from '../src/core/pipelines/revise'
import { trialWrite } from '../src/core/pipelines/trial'
import { writeChapter } from '../src/core/pipelines/write'
import type { RoleTask } from '../src/core/roles'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import { createTestBed, type TestBed } from './support/harness'

const long = (mark: string, lines = 30): string => `${mark}\n\n${Array.from({ length: lines }, (_unused, at) => `第 ${at} 段：雨落在青石板上，她数着屋檐滴下来的水，谁也没有先开口。`).join('\n\n')}`

describe('the material of a piece of writing, prepared by the planner', () => {
  let bed: TestBed
  let ids: string[]
  beforeEach(async () => {
    // (The planner reads for itself here, as it does in a book of any size: the line is not put before it whole.)
    bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'planner', context: { ...DEFAULT_SETTINGS.context, plannerWholeTokens: 0 } } })
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', tagline: '渡口的摆渡人', personality: '倔强寡言', appearance: '左眉有一道旧疤' })
    await project.saveCharacter({ name: '陆沉', role: 'supporting', tagline: '账房先生', personality: '【陆沉的卡片】精于算计' })
    await project.saveCharacter({ name: '阿棠', role: 'minor', tagline: '送信的孩子', personality: '【阿棠的卡片】' })
    await project.saveWorld({ name: '青冥山', category: 'location', importance: 1, summary: '【核心设定】北境雪山' })
    await project.saveWorld({ name: '寄死笔', category: 'item', importance: 2, summary: '【寄死笔的设定】写下名字的人七日后死。' })
    await project.saveWorld({ name: '断肠斋', category: 'location', importance: 2, summary: '【断肠斋的设定】' })
    await project.saveThread({ title: '没寄出的信', kind: 'foreshadow', status: 'open', description: '【线索：没寄出的信】' })
    await project.saveThread({ title: '缺页的账本', kind: 'mystery', status: 'open', description: '【线索：缺页的账本】' })
    ids = []
    for (const [title, mark] of [['一', '【第一章独有】'], ['二', '【第二章独有】'], ['三', '【第三章独有】']] as const) {
      const made = await project.addChapter({ title, synopsis: `第${title}章的梗概。` })
      await project.saveChapterText(made.id, title === '二' ? `${long(mark)}\n\n她把那支笔推过柜台：“这支笔，我不卖。”\n\n陆沉笑了笑，没有接。\n\n【第二章的结尾】` : long(mark))
      ids.push(made.id)
    }
    const here = await project.addChapter({ title: '四', synopsis: '沈璃在渡口等船，陆沉来讨那支笔。' })
    ids.push(here.id)
  })
  afterEach(async () => { await bed.cleanup() })

  /** A planner that hands in what it is told to, after a look in the book. */
  const planner = (handIn: Record<string, unknown>, before?: (call: (tool: string, args?: Record<string, unknown>) => Promise<string>) => Promise<void>): void => {
    bed.roles.enabled = true
    bed.roles.script = async (_task, call) => {
      await before?.(call)
      const said = await call('writing_material', { result: handIn })
      if (said.startsWith('ERROR')) throw new Error(said)
    }
  }
  const chosen = {
    task: '【策划的任务】写陆沉来渡口讨笔，沈璃不给。',
    situation: '【策划交代的情况】第二章里她已经当面说过不卖。',
    keep: ['【不能写错】陆沉不知道笔会杀人（第二章）'],
    form: '【书写格式】第三人称，贴着沈璃写，过去时。',
    voice: '【文风提醒】对白短，不解释。',
    people: ['沈璃', '陆沉'],
    world: ['寄死笔'],
    threads: ['没寄出的信'],
    chapters: [3],
    summaries: [1],
    excerpts: [{ chapter: 2, from: '她把那支笔推过柜台', to: '没有接。', why: '这一章要接这句话' }],
    note: '带了第三章和第二章柜台那一段。',
  }

  it('a chapter is written from what the planner chose — and from nothing that merely stands near', async () => {
    planner(chosen, async (call) => { expect(await call('book_read', { what: 'chapter', ref: '2' })).toContain('这支笔，我不卖') })
    bed.llm.responder = () => '渡口的风很硬。'
    const done = await writeChapter(bed.core, bed.runtime, { chapter: ids[3]!, brief: '让陆沉先开口。' }, { origin: 'user' })

    // The planner was told the work, shown what the book has by name and size, and told what it need not prepare.
    const asked = (bed.roles.tasks[0] as RoleTask).prompt
    for (const part of ['写第 4 章《四》的正文', '让陆沉先开口。', '3. 《三》', '← 这一章', '陆沉（配角）：账房先生', '物品：寄死笔', '没寄出的信', '核心设定 青冥山 会自动带上', '不用你备的', '上一章《三》结尾的原文']) expect(asked, part).toContain(part)
    // Nothing of the book's text was put before it unasked: it reads with its tools.
    expect(asked).not.toContain('【第二章独有】')

    // The writer read one request: what the planner said, what it chose, and what the work stands on.
    expect(bed.llm.requests).toHaveLength(1)
    const { prompt, stable } = bed.llm.requests[0]!
    const read = `${stable ?? ''}\n${prompt}`
    for (const part of ['【策划的任务】', '【策划交代的情况】', '- 【不能写错】', '【书写格式】', '【文风提醒】', '【陆沉的卡片】', '左眉有一道旧疤', '【寄死笔的设定】', '【线索：没寄出的信】', '【第三章独有】', '第一章的梗概。', '这支笔，我不卖', '这一章要接这句话', '【核心设定】', '沈璃在渡口等船，陆沉来讨那支笔。', '让陆沉先开口。']) expect(read, part).toContain(part)
    // Not chosen: the chapter that only stood near, the card of somebody not wanted, the entry and the thread nobody named.
    for (const part of ['【第二章独有】', '【第一章独有】', '【阿棠的卡片】', '【断肠斋的设定】', '【线索：缺页的账本】']) expect(read, part).not.toContain(part)
    // The stretch chosen is the stretch, not its chapter; the chapter before went whole, so its end is not sent twice.
    expect(read).not.toContain('【第二章的结尾】')
    expect(read).not.toContain('结尾原文')
    // The planner's brief is read first, the chapter's own plan last.
    expect(read.indexOf('【策划的任务】')).toBeLessThan(read.indexOf('【陆沉的卡片】'))
    expect(read.indexOf('【书写格式】')).toBeGreaterThan(read.indexOf('【第三章独有】'))
    expect(read.indexOf('## 本章章纲')).toBeGreaterThan(read.indexOf('【文风提醒】'))

    expect(done.strategy).toBe('chosen')
    expect(done.material).toMatchObject({ by: 'planner', how: 'agent', chapters: [3], summaries: 1, excerpts: 1, people: ['沈璃', '陆沉'], world: ['寄死笔'], threads: ['没寄出的信'], note: '带了第三章和第二章柜台那一段。' })
    // Kept for the author to read: all the writer read, and who put it together.
    const kept = await keptMaterial(bed.runtime, ids[3]!)
    expect(kept).toMatchObject({ work: 'draft', by: 'planner', instruction: '让陆沉先开口。' })
    expect(kept!.text).toContain('【策划的任务】')
    expect(kept!.text).toContain('从本章第一句开始写')
  })

  it('what does not match the book is sent back: a name, a chapter, words not copied from the text, more than the budget holds', async () => {
    const answers: string[] = []
    bed.roles.enabled = true
    bed.roles.script = async (_task, call) => {
      answers.push(await call('writing_material', { result: { ...chosen, people: ['沈璃', '柳先生'], world: ['没有这条'], chapters: [9, 4], excerpts: [{ chapter: 2, from: '她把那支钢笔推过柜台', to: '没有接。' }] } }))
      answers.push(await call('writing_material', { result: { ...chosen, task: '' } }))
      answers.push(await call('writing_material', { result: chosen }))
    }
    bed.llm.responder = () => '渡口的风很硬。'
    await writeChapter(bed.core, bed.runtime, { chapter: ids[3]! }, { origin: 'user' })
    for (const part of ['「柳先生」没有人物卡', '「没有这条」不是设定里的条目', '这条线上没有第 9 章', '第 2 章里找不到开头「她把那支钢笔推过柜台」']) expect(answers[0], part).toContain(part)
    // (The chapter in hand is not one to choose: it is left out, and nothing is said of it.)
    expect(answers[0]).not.toContain('第 4 章')
    expect(answers[1]).toContain('"task" 是空的')
    expect(answers[2]).not.toContain('ERROR')

    // Held to a size: three whole chapters do not fit what a passage is rewritten with.
    await bed.core.settings.update({ context: { ...bed.core.currentSettings().context, passageTokens: 1200 } })
    await bed.runtime.project.saveChapterText(ids[3]!, '渡口的风很硬。\n\n沈璃把斗笠压低，一句话也没有说。')
    bed.roles.script = async (_task, call) => {
      answers.push(await call('writing_material', { result: { ...chosen, chapters: [1, 2, 3], excerpts: [] } }))
      answers.push(await call('writing_material', { result: { ...chosen, chapters: [], summaries: [1, 2, 3], excerpts: [], people: ['沈璃'], world: [] } }))
    }
    bed.llm.responder = () => '沈璃一把掀开斗笠。'
    await reviseSpan(bed.core, bed.runtime, { chapter: ids[3]!, quote: '沈璃把斗笠压低，一句话也没有说。', instruction: '让她先开口。' }, { origin: 'user' })
    expect(answers[3]).toContain('超过了 1200')
    expect(answers[4]).not.toContain('ERROR')
  })

  it('a passage is rewritten with what the planner chose for it; a place a mending settled is not looked at again', async () => {
    const { project } = bed.runtime
    await project.saveChapterText(ids[3]!, '渡口的风很硬。\n\n沈璃把斗笠压低，一句话也没有说。\n\n船夫看了她一眼。')
    planner({ ...chosen, task: '【策划的任务】让她先开口催船夫。', chapters: [], summaries: [], threads: [] })
    bed.llm.responder = () => '沈璃一把掀开斗笠：“渡不渡？”'
    const done = await reviseSpan(bed.core, bed.runtime, { chapter: ids[3]!, quote: '沈璃把斗笠压低，一句话也没有说。', instruction: '让她先开口。' }, { origin: 'user' })
    const asked = (bed.roles.tasks[0] as RoleTask).prompt
    for (const part of ['改写第 4 章《四》里的一段', '<<<\n沈璃把斗笠压低，一句话也没有说。\n>>>', '渡口的风很硬。', '让她先开口。']) expect(asked, part).toContain(part)
    const { prompt } = bed.llm.requests[0]!
    for (const part of ['【策划的任务】让她先开口催船夫。', '【陆沉的卡片】', '这支笔，我不卖', '<<<\n沈璃把斗笠压低，一句话也没有说。\n>>>', '渡口的风很硬。', '船夫看了她一眼。']) expect(prompt, part).toContain(part)
    for (const part of ['【第三章独有】', '【第一章独有】', '【阿棠的卡片】']) expect(prompt, part).not.toContain(part)
    // What is asked is still said before the passage and once more at the end.
    expect(prompt.endsWith('修改要求：让她先开口。')).toBe(true)
    expect(done.material).toMatchObject({ by: 'planner', how: 'agent', excerpts: 1 })
    expect((await keptMaterial(bed.runtime, ids[3]!))?.work).toBe('passage')

    // A place somebody settled already — a mending's — is rewritten by what the rules pack: nobody is asked again.
    const before = bed.roles.tasks.length
    await reviseSpan(bed.core, bed.runtime, { chapter: ids[3]!, quote: '船夫看了她一眼。', instruction: '删掉这句的“了”。', material: 'rules' }, { origin: 'user' })
    expect(bed.roles.tasks).toHaveLength(before)
  })

  it('a chapter is written over with the chapter whole beside what the planner chose', async () => {
    const { project } = bed.runtime
    await project.saveChapterText(ids[3]!, long('【第四章现有的开头】', 6))
    planner({ ...chosen, chapters: [], summaries: [2, 3], excerpts: [] })
    bed.llm.responder = () => long('【第四章重写】', 6)
    const done = await reviseChapter(bed.core, bed.runtime, { chapter: ids[3]!, instruction: '把这一章写得更冷。' }, { origin: 'user' })
    expect((bed.roles.tasks[0] as RoleTask).prompt).toContain('把第 4 章《四》整章重写')
    expect((bed.roles.tasks[0] as RoleTask).prompt).toContain('【第四章现有的开头】')
    const { prompt } = bed.llm.requests[0]!
    for (const part of ['【策划的任务】', '【第四章现有的开头】', '第二章的梗概。', '第三章的梗概。', '把这一章写得更冷。', '《三》结尾原文']) expect(prompt, part).toContain(part)
    expect(prompt).not.toContain('【第一章独有】')
    expect(done.material?.by).toBe('planner')
  })

  it('where the author has it packed by rule, nobody looks first', async () => {
    await bed.core.settings.update({ materialBy: 'rules' })
    bed.roles.enabled = true
    bed.llm.responder = () => '渡口的风很硬。'
    const done = await writeChapter(bed.core, bed.runtime, { chapter: ids[3]! }, { origin: 'user' })
    expect(bed.roles.tasks).toHaveLength(0)
    expect(bed.llm.requests).toHaveLength(1)
    expect(done.material).toMatchObject({ by: 'rules' })
    expect(done.material?.why).toBeUndefined()
    expect(done.strategy).not.toBe('chosen')
    // By rule, the chapters before travel word for word and everybody is listed.
    const read = `${bed.llm.requests[0]!.stable ?? ''}\n${bed.llm.requests[0]!.prompt}`
    for (const part of ['【第一章独有】', '【第二章独有】', '【第三章独有】', '【陆沉的卡片】', '阿棠']) expect(read, part).toContain(part)
  })

  it('a planner that cannot work as an agent chooses from the lists in one request; one that cannot be asked at all leaves it to the rules — and the result says so', async () => {
    // No agent loop: the planner answers in one request, with what it was shown of the book.
    bed.llm.responder = request => (request.prompt.includes('只输出 JSON') ? JSON.stringify({ ...chosen, excerpts: [] }) : '渡口的风很硬。')
    const done = await writeChapter(bed.core, bed.runtime, { chapter: ids[3]! }, { origin: 'user' })
    expect(done.material).toMatchObject({ by: 'planner', how: 'call', chapters: [3] })
    expect(bed.llm.requests.at(-1)!.prompt).toContain('【策划的任务】')

    // What it hands in will not do, however often it is asked: the piece is written all the same, by what the rules pack.
    bed.llm.requests.length = 0
    bed.llm.responder = request => (request.prompt.includes('只输出 JSON') ? '我没法回答。' : '渡口的风很硬。')
    const again = await writeChapter(bed.core, bed.runtime, { chapter: ids[3]!, mode: 'draft' }, { origin: 'user' })
    expect(again.material?.by).toBe('rules')
    expect(again.material?.why).toBeDefined()
    expect(bed.llm.requests.at(-1)!.prompt).not.toContain('【策划的任务】')
  })

  it('several writers at one chapter, to be compared, write from one preparation', async () => {
    planner(chosen)
    bed.llm.responder = () => '渡口的风很硬。'
    const made = await trialWrite(bed.core, bed.runtime, { chapter: ids[3]!, with: [{ provider: 'fake', model: 'one' }, { provider: 'fake', model: 'two' }] }, { origin: 'user' })
    expect(made.drafts.map(draft => draft.error)).toEqual([undefined, undefined])
    expect(bed.roles.tasks).toHaveLength(1)
    expect(bed.llm.requests).toHaveLength(2)
    expect(bed.llm.requests[0]!.prompt).toBe(bed.llm.requests[1]!.prompt)
  })

  it('a chapter written both ways to be compared: a draft a model by each, one preparation, and what each was written from kept beside it', async () => {
    planner(chosen)
    bed.llm.responder = () => '渡口的风很硬。'
    const { project } = bed.runtime
    const made = await trialWrite(bed.core, bed.runtime, { chapter: ids[3]!, brief: '让陆沉先开口。', with: [{ provider: 'fake', model: 'one' }, { provider: 'fake', model: 'two' }], materials: ['planner', 'rules', 'planner'] }, { origin: 'user' })

    // Every model by every way, once: four drafts, each saying which way it was to be written by — and was.
    expect(made.drafts.map(draft => `${draft.model}:${draft.by}:${draft.material?.by}:${draft.error}`)).toEqual(['one:planner:planner:undefined', 'one:rules:rules:undefined', 'two:planner:planner:undefined', 'two:rules:rules:undefined'])
    // The planner looked once for the two that go by it; nobody looked for the two packed by rule.
    expect(bed.roles.tasks).toHaveLength(1)
    expect(bed.llm.requests).toHaveLength(4)
    const read = bed.llm.requests.map(request => `${request.stable ?? ''}\n${request.prompt}`)
    const prepared = read.filter(text => text.includes('【策划的任务】'))
    const packed = read.filter(text => !text.includes('【策划的任务】'))
    expect(prepared).toHaveLength(2)
    expect(packed).toHaveLength(2)
    // Packed by rule, the chapters that stand before go along word for word; prepared, only what was chosen.
    for (const text of packed) for (const part of ['【第一章独有】', '【第二章独有】', '【第三章独有】']) expect(text, part).toContain(part)
    for (const text of prepared) expect(text).not.toContain('【第二章独有】')
    // The chapter keeps its text (it had none); the drafts are versions that say how each was made.
    expect(await project.chapterText(ids[3]!)).toBe('')
    const versions = await project.versions(ids[3]!)
    expect(versions).toHaveLength(4)
    expect(versions.map(version => `${version.made?.model}:${version.made?.material?.by}`).sort()).toEqual(['one:planner', 'one:rules', 'two:planner', 'two:rules'])
    expect(new Set(versions.map(version => version.id)).size).toBe(4)
    // All a draft's writer read is kept with its version — and nothing is kept on the chapter for a draft nobody took.
    expect(await keptMaterial(bed.runtime, ids[3]!)).toBeUndefined()
    const byPlanner = made.drafts.find(draft => draft.model === 'one' && draft.by === 'planner')!
    const byRules = made.drafts.find(draft => draft.model === 'one' && draft.by === 'rules')!
    const keptPlanner = await keptMaterial(bed.runtime, ids[3]!, byPlanner.version)
    const keptRules = await keptMaterial(bed.runtime, ids[3]!, byRules.version)
    expect(keptPlanner?.by).toBe('planner')
    expect(keptPlanner?.work).toBe('draft')
    expect(keptPlanner?.instruction).toBe('让陆沉先开口。')
    expect(keptPlanner?.text).toContain('【策划的任务】')
    expect(keptPlanner?.people).toEqual(['沈璃', '陆沉'])
    expect(keptRules?.by).toBe('rules')
    expect(keptRules?.text).toContain('【第二章独有】')
    expect(keptRules?.text).not.toContain('【策划的任务】')
    // A draft deleted takes what it was written from with it; the others keep theirs.
    expect(await project.dropVersions(ids[3]!, [byRules.version!])).toEqual({ removed: 1, kept: [] })
    expect(await keptMaterial(bed.runtime, ids[3]!, byRules.version)).toBeUndefined()
    expect((await keptMaterial(bed.runtime, ids[3]!, byPlanner.version))?.by).toBe('planner')
  })

  it('a line small enough lies before the planner whole: it prepares in one request, whatever it is set to work as', async () => {
    await bed.core.settings.update({ context: { plannerWholeTokens: 32_000 } })
    await bed.runtime.project.saveChapterText(ids[3]!, '')
    // (An agent is there to be asked — and is not: everything it could look up is in its task.)
    bed.roles.enabled = true
    bed.roles.script = async () => { throw new Error('the planner was run as an agent') }
    bed.llm.responder = request => (request.prompt.includes('只输出 JSON') ? JSON.stringify(chosen) : '渡口的风很硬。')
    const done = await writeChapter(bed.core, bed.runtime, { chapter: ids[3]!, brief: '让陆沉先开口。' }, { origin: 'user' })
    expect(bed.roles.tasks).toHaveLength(0)
    expect(done.material).toMatchObject({ by: 'planner', how: 'call', whole: true, chapters: [3], people: ['沈璃', '陆沉'] })
    // The one request the planner answered had the line before it: every chapter's text, every card, every entry, every thread.
    const asked = bed.llm.requests.find(request => request.prompt.includes('只输出 JSON'))!.prompt
    for (const part of ['这条线不大', '【第 1 章《一》】', '【第一章独有】', '【第二章独有】', '这支笔，我不卖', '【第三章独有】', '【陆沉的卡片】', '【阿棠的卡片】', '左眉有一道旧疤', '【寄死笔的设定】', '【断肠斋的设定】', '【线索：没寄出的信】', '【线索：缺页的账本】', '核心设定 青冥山 会自动带上']) expect(asked, part).toContain(part)
    expect(asked).not.toContain('book_read')
    // What it copied from the text it was shown is found in the book, and the writer gets what was chosen — no more.
    const read = `${bed.llm.requests.at(-1)!.stable ?? ''}\n${bed.llm.requests.at(-1)!.prompt}`
    for (const part of ['【策划的任务】', '【第三章独有】', '这支笔，我不卖', '【陆沉的卡片】']) expect(read, part).toContain(part)
    for (const part of ['【第二章独有】', '【阿棠的卡片】', '【断肠斋的设定】']) expect(read, part).not.toContain(part)

    // A line larger than the author lets lie before it: the planner reads for itself, as an agent.
    await bed.core.settings.update({ context: { plannerWholeTokens: 200 } })
    await bed.runtime.project.saveChapterText(ids[3]!, '')
    planner(chosen)
    const again = await writeChapter(bed.core, bed.runtime, { chapter: ids[3]! }, { origin: 'user' })
    expect(bed.roles.tasks).toHaveLength(1)
    expect(again.material).toMatchObject({ by: 'planner', how: 'agent' })
    expect(again.material?.whole).toBeUndefined()
    expect((bed.roles.tasks[0] as RoleTask).prompt).not.toContain('【第二章独有】')
  })

  it('a comparison of ways counts every draft against the most it takes; a planner that cannot be asked leaves its draft to the rules, and the draft says so', async () => {
    bed.llm.responder = () => '渡口的风很硬。'
    const many = Array.from({ length: 17 }, (_unused, at) => ({ provider: 'fake', model: `m${at}` }))
    // (Seventeen models are within the most; by two ways they are thirty-four drafts.)
    await expect(trialWrite(bed.core, bed.runtime, { chapter: ids[3]!, with: many, materials: ['planner', 'rules'] }, { origin: 'user' })).rejects.toThrow(/32 drafts at once/)
    expect(bed.llm.requests).toHaveLength(0)

    // Nobody to prepare (no agent, and the one request that stands in for it answers nothing fit to use).
    bed.roles.enabled = false
    bed.llm.responder = request => (request.prompt.includes('只输出 JSON') ? '我没法回答。' : '渡口的风很硬。')
    const made = await trialWrite(bed.core, bed.runtime, { chapter: ids[3]!, with: [{ provider: 'fake', model: 'one' }], materials: ['planner', 'rules'] }, { origin: 'user' })
    expect(made.drafts.map(draft => `${draft.by}:${draft.material?.by}:${draft.error}`)).toEqual(['planner:rules:undefined', 'rules:rules:undefined'])
    expect(made.drafts[0]!.material?.why).toBeTruthy()
    expect(made.drafts[1]!.material?.why).toBeUndefined()
  })
})

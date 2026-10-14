// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter written by the writer as an agent: nobody prepares its material —
 * it reads in the book for itself, hands the text in with a tool, goes over
 * what it handed in as often as it sees fit, and what stands when it calls
 * the work done is the chapter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keptMaterial, materialBy, writingBy } from '../src/core/pipelines/material'
import { trialWrite } from '../src/core/pipelines/trial'
import { writeChapter } from '../src/core/pipelines/write'
import type { RoleTask } from '../src/core/roles'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
type Call = (tool: string, args?: Record<string, unknown>) => Promise<string>

describe('a chapter written by the writer as an agent', () => {
  let bed: TestBed
  let ids: string[]
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'agent' } })
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', tagline: '渡口的摆渡人', personality: '【沈璃的卡片】倔强寡言' })
    await project.saveCharacter({ name: '陆沉', role: 'supporting', tagline: '账房先生', personality: '【陆沉的卡片】精于算计' })
    await project.saveWorld({ name: '青冥山', category: 'location', importance: 1, summary: '【核心设定】北境雪山' })
    await project.saveWorld({ name: '寄死笔', category: 'item', importance: 2, summary: '【寄死笔的设定】写下名字的人七日后死。' })
    ids = []
    for (const title of ['一', '二']) {
      const made = await project.addChapter({ title, synopsis: `第${title}章的梗概。` })
      await project.saveChapterText(made.id, `【第${title}章独有】雨落在青石板上。\n\n【第${title}章的结尾】`)
      ids.push(made.id)
    }
    ids.push((await project.addChapter({ title: '三', synopsis: '陆沉来讨那支笔，沈璃不给。', targetWords: 1200 })).id)
    bed.roles.enabled = true
    // (Nothing goes to the writer's model in one request here: a call that does is a test's failure to notice.)
    bed.llm.responder = () => '【不该出现：一次性调用的回复】'
  })
  afterEach(async () => { await bed.cleanup() })

  it('reads for itself, hands the text in, changes it, and the chapter is what stood when it was done', async () => {
    const { core, runtime, roles } = bed
    const { project } = runtime
    const said: Record<string, string> = {}
    roles.script = async (_task, call: Call) => {
      said.before = await call('chapter_edit', { find: '风', replace: '雨' })
      said.card = await call('book_read', { what: 'character', ref: '陆沉' })
      said.earlier = await call('book_read', { what: 'chapter', ref: '2' })
      said.first = await call('chapter_write', { text: '# 第三章\n\n渡口的风很硬。\n\n陆沉站在栈桥上，没有说话。' })
      said.more = await call('chapter_write', { text: '“那支笔，”他终于开口，“我要了。”', append: true })
      said.read = await call('chapter_read', {})
      said.twice = await call('chapter_edit', { find: '。', replace: '！' })
      said.edit = await call('chapter_edit', { find: '陆沉站在栈桥上，没有说话。', replace: '陆沉站在栈桥尽头，袖着手，没有说话。' })
      said.gone = await call('chapter_edit', { find: '渡口的风很硬。\n\n', replace: '' })
      // (Well short of the twelve hundred words the chapter's plan asks for: told once, and done when it says so again.)
      said.early = await call('chapter_done', { note: '写完了。' })
      said.done = await call('chapter_done', { note: '读了陆沉的卡和第二章；开头删了一句，让他先站着。' })
    }
    const done = await writeChapter(core, runtime, { chapter: ids[2]!, brief: '让陆沉先开口。' }, task)

    // The task: the writer's own rules and the style as its persona, how an agent works here, and what the work stands on.
    const asked = roles.tasks[0] as RoleTask
    expect(asked.role).toBe('writer')
    expect(asked.persona).toContain('你是一位功力深厚的小说家')
    for (const part of ['作为 agent', 'chapter_write', 'chapter_edit', 'chapter_done', 'book_read']) expect(asked.rules, part).toContain(part)
    for (const part of ['陆沉来讨那支笔，沈璃不给。', '让陆沉先开口。', '【核心设定】', '【第二章的结尾】', '约 1200 字', '整章正文用 chapter_write 提交']) expect(asked.prompt, part).toContain(part)
    // Nobody chose anything for it: no card, no entry beyond the core, no earlier chapter whole.
    for (const part of ['【陆沉的卡片】', '【寄死笔的设定】', '【第一章独有】', '直接输出正文']) expect(asked.prompt, part).not.toContain(part)
    expect(asked.tools.map(tool => tool.name)).toEqual(['book_read', 'book_search', 'book_find', 'chapter_write', 'chapter_read', 'chapter_edit', 'chapter_done'])

    // What it read, it read with its tools; what it handed in was its own to change.
    expect(said.before).toContain('ERROR')
    expect(said.card).toContain('【陆沉的卡片】')
    expect(said.earlier).toContain('【第二章独有】')
    expect(said.first).toContain('收到')
    expect(said.more).toContain('接在后面了')
    expect(said.read).toBe('渡口的风很硬。\n\n陆沉站在栈桥上，没有说话。\n\n“那支笔，”他终于开口，“我要了。”')
    expect(said.twice).toContain('ERROR')
    expect(said.twice).toContain('3 处')
    expect(said.edit).toContain('改好了')
    expect(said.gone).toContain('删掉了')
    expect(said.early).toContain('要求约 1200 字')
    expect(said.done).toBe('收到。')

    const text = '陆沉站在栈桥尽头，袖着手，没有说话。\n\n“那支笔，”他终于开口，“我要了。”'
    expect(await project.chapterText(ids[2]!)).toBe(text)
    expect(done.material).toMatchObject({ by: 'agent', how: 'agent', drafts: 1, edits: 2, note: '读了陆沉的卡和第二章；开头删了一句，让他先站着。' })
    expect(done.wordsWritten).toBeGreaterThan(0)
    // No request went to the writer's model the other way.
    expect(bed.llm.requests.filter(request => request.route.for?.role === 'writer')).toHaveLength(0)
    // What it was given to start from is kept for the author to read.
    expect((await keptMaterial(runtime, ids[2]!))).toMatchObject({ by: 'agent', work: 'draft', instruction: '让陆沉先开口。' })
  })

  it('goes on with a chapter: what is handed in is added to what is there', async () => {
    const { core, runtime, roles } = bed
    const { project } = runtime
    await project.saveChapterText(ids[2]!, '渡口的风很硬。')
    roles.script = async (_task, call: Call) => {
      expect(await call('book_read', { what: 'chapter', ref: '3' })).toContain('渡口的风很硬。')
      await call('chapter_write', { text: '陆沉站在栈桥上，没有说话。' })
      await call('chapter_done', { note: '接着写了一段。' })
    }
    const done = await writeChapter(core, runtime, { chapter: ids[2]!, mode: 'continue' }, task)
    expect((roles.tasks[0] as RoleTask).prompt).toContain('续写的部分用 chapter_write 提交')
    expect(await project.chapterText(ids[2]!)).toBe('渡口的风很硬。\n\n陆沉站在栈桥上，没有说话。')
    expect(done).toMatchObject({ mode: 'continue', material: { by: 'agent' } })
  })

  it('keeps what was handed in when the work is never called done, and says so', async () => {
    const { core, runtime, roles } = bed
    roles.script = async (_task, call: Call) => { await call('chapter_write', { text: '渡口的风很硬。' }) }
    const done = await writeChapter(core, runtime, { chapter: ids[2]! }, task)
    expect(await runtime.project.chapterText(ids[2]!)).toBe('渡口的风很硬。')
    expect(done.material?.by).toBe('agent')
    expect(done.material?.note).toContain('没有交稿就停了')
  })

  it('is written the other way when the writer cannot work as an agent, or hands nothing in — and the result says why', async () => {
    const { core, runtime, roles } = bed
    // Nothing handed in.
    roles.script = async (task) => (task.role === 'writer' ? '（我写在回复里了）' : undefined)
    bed.llm.responder = () => '一次性写出来的正文。'
    const first = await writeChapter(core, runtime, { chapter: ids[2]!, material: 'agent' }, task)
    expect(await runtime.project.chapterText(ids[2]!)).toBe('一次性写出来的正文。')
    expect(first.material?.by).not.toBe('agent')
    expect(first.material?.instead).toContain('没有交上正文')
    // A model that cannot run as an agent at all.
    roles.enabled = false
    const second = await writeChapter(core, runtime, { chapter: ids[2]!, material: 'agent' }, task)
    expect(second.material).toMatchObject({ by: 'rules' })
    expect(second.material?.instead).toContain('当不了 agent')
  })

  it('is one of the ways a comparison lays side by side', async () => {
    const { core, runtime, roles } = bed
    roles.script = async (task, call: Call) => {
      if (task.role !== 'writer') return
      await call('chapter_write', { text: '【agent 写的那一稿】渡口的风很硬。' })
      await call('chapter_done', { note: '写了。' })
    }
    bed.llm.responder = () => '【按规则拼写的那一稿】雨下了一夜。'
    const { drafts } = await trialWrite(core, runtime, { chapter: ids[2]!, with: [{ provider: 'fake', model: 'fake-model' }], materials: ['rules', 'agent'] }, task)
    expect(drafts.map(draft => [draft.by, draft.material?.by, draft.text])).toEqual([
      ['rules', 'rules', '【按规则拼写的那一稿】雨下了一夜。'],
      ['agent', 'agent', '【agent 写的那一稿】渡口的风很硬。'],
    ])
    // The chapter keeps what it had: nothing.
    expect(await runtime.project.chapterText(ids[2]!)).toBe('')
  })
})

describe('the way a chapter is written', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: undefined as never } }) })
  afterEach(async () => { await bed.cleanup() })

  it('is packed by rule where nobody said; the Studio\'s setting, the book\'s own and what is said for the piece each come before what is behind them', async () => {
    const { core, runtime } = bed
    // Nothing set anywhere: packed by rule.
    expect(writingBy(core)).toBe('rules')
    expect(materialBy(core)).toBe('rules')
    // The Studio's setting.
    await core.settings.update({ materialBy: 'planner' })
    expect(writingBy(core, undefined, await runtime.project.manifest())).toBe('planner')
    // The book's own holds for the book in place of it…
    await runtime.project.updateManifest({ materialBy: 'agent' })
    const book = await runtime.project.manifest()
    expect(book.materialBy).toBe('agent')
    expect(writingBy(core, undefined, book)).toBe('agent')
    // (a chapter is the writer's own work then; what is written in one request all the same has the planner's material)
    expect(materialBy(core, undefined, book)).toBe('planner')
    // …and what is said for the piece comes before both.
    expect(writingBy(core, 'rules', book)).toBe('rules')
    // Named as nothing, the book has none of its own again: the Studio's holds.
    await runtime.project.updateManifest({ materialBy: null as never })
    const plain = await runtime.project.manifest()
    expect('materialBy' in plain).toBe(false)
    expect(writingBy(core, undefined, plain)).toBe('planner')
  })

  it('writes a chapter of a book that has its own way that way, whatever the Studio has', async () => {
    const { core, runtime, llm } = bed
    const chapter = await runtime.project.addChapter({ title: '一', synopsis: '开头。' })
    // The Studio has the planner prepare; this book is packed by rule: nobody is asked to prepare anything.
    await core.settings.update({ materialBy: 'planner' })
    await runtime.project.updateManifest({ materialBy: 'rules' })
    llm.responder = () => '雨落在青石板上。'
    const done = await writeChapter(core, runtime, { chapter: chapter.id, digest: false }, task)
    expect(done.material?.by).toBe('rules')
    expect(llm.requests.filter(request => request.route.for?.role === 'architect')).toHaveLength(0)
    expect(llm.requests.filter(request => request.route.for?.role === 'writer')).toHaveLength(1)
  })
})

describe('a chapter asked to be long', () => {
  let bed: TestBed
  let here: string
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'rules' } })
    const { project } = bed.runtime
    const before = await project.addChapter({ title: '一', synopsis: '开头。' })
    await project.saveChapterText(before.id, '【第一章】雨落在青石板上。')
    here = (await project.addChapter({ title: '二', synopsis: '陆沉来讨那支笔。', beats: ['【节拍一】陆沉到渡口', '【节拍二】沈璃不给', '【节拍三】账本被翻出来', '【节拍四】阿棠送信来', '【节拍五】陆沉让步', '【节拍六】船离岸'].map((summary, at) => ({ id: `b${at + 1}`, summary })) })).id
  })
  afterEach(async () => { await bed.cleanup() })

  it('is written in parts by its beats: the same material each time, the text so far, and where to stop', async () => {
    const { core, runtime, llm } = bed
    // (Parts of as many beats as there are: how many parts there are is then by the length asked for alone.)
    await core.settings.update({ partBeats: 99 })
    llm.responder = request => `【第 ${llm.requests.filter(one => one.route.for?.role === 'writer').length} 次写的】${request.prompt.includes('照常收住') ? '船离了岸。' : '他没有说话。'}`
    const done = await writeChapter(core, runtime, { chapter: here, words: 9000, digest: false }, task)
    const asked = llm.requests.filter(request => request.route.for?.role === 'writer')
    expect(asked).toHaveLength(3)
    expect(done.parts).toBe(3)
    // Each part: which beats are its own, its share of the length, and that it is not to close the chapter — but for the last.
    expect(asked[0]!.prompt).toContain('分 3 次写，这是第 1 次')
    expect(asked[0]!.prompt).toContain('这一次只写章纲里的第 1–2 个节拍：\n1. 【节拍一】陆沉到渡口\n2. 【节拍二】沈璃不给')
    expect(asked[0]!.prompt).toContain('篇幅：约 3000 字')
    expect(asked[0]!.prompt).toContain('不要给这一章收尾')
    expect(asked[0]!.prompt).not.toContain('本章已有正文')
    expect(asked[1]!.prompt).toContain('这是第 2 次')
    expect(asked[1]!.prompt).toContain('第 3–4 个节拍')
    expect(asked[1]!.prompt).toContain('## 本章已有正文\n\n【第 1 次写的】他没有说话。')
    expect(asked[2]!.prompt).toContain('第 5–6 个节拍')
    expect(asked[2]!.prompt).toContain('照常收住')
    expect(asked[2]!.prompt).toContain('【第 1 次写的】他没有说话。\n\n【第 2 次写的】他没有说话。')
    // The head of every request is the same one: what a provider has kept is read again.
    expect(new Set(asked.map(request => `${request.system}\n${request.stable}`)).size).toBe(1)
    expect(await runtime.project.chapterText(here)).toBe('【第 1 次写的】他没有说话。\n\n【第 2 次写的】他没有说话。\n\n【第 3 次写的】船离了岸。')
    // What came out is far short of nine thousand words: said.
    expect(done.short).toMatchObject({ asked: 9000 })
    expect(done.partsOff).toBeUndefined()
  })

  it('is written in one go where the author has parts switched off, whatever length is asked for — and says that is why', async () => {
    const { core, runtime, llm } = bed
    await core.settings.update({ partBeats: 0 })
    llm.responder = () => '船离了岸。'
    const done = await writeChapter(core, runtime, { chapter: here, words: 9000, digest: false }, task)
    const asked = llm.requests.filter(request => request.route.for?.role === 'writer')
    // One request for the whole chapter: all six beats, nothing about parts.
    expect(asked).toHaveLength(1)
    expect(asked[0]!.prompt).not.toContain('次写')
    expect(asked[0]!.prompt).toContain('【节拍六】')
    expect(done.parts).toBeUndefined()
    // It came out short, and the reason parts were not used is on the result: the page says it, in place of "the plan has no beats".
    expect(done).toMatchObject({ short: { asked: 9000 }, partsOff: true })
  })

  it('is written in parts by its beats whatever length is asked for, where nothing is set otherwise', async () => {
    // (The harness has chapters written in one request; with nothing set, a part holds three beats.)
    await bed.cleanup()
    bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'rules', partBeats: undefined as never } })
    const { core, runtime, llm } = bed
    here = (await runtime.project.addChapter({ title: '二', synopsis: '陆沉来讨那支笔。', beats: ['【节拍一】陆沉到渡口', '【节拍二】沈璃不给', '【节拍三】账本被翻出来', '【节拍四】阿棠送信来', '【节拍五】陆沉让步', '【节拍六】船离岸'].map((summary, at) => ({ id: `b${at + 1}`, summary })) })).id
    llm.responder = () => '他没有说话。'
    const writers = (): typeof llm.requests => llm.requests.filter(request => request.route.for?.role === 'writer')
    // No length asked for: two parts of three beats, and the writer left to judge each.
    const free = await writeChapter(core, runtime, { chapter: here, digest: false }, task)
    expect(free.parts).toBe(2)
    expect(free.short).toBeUndefined()
    const [one, two] = writers()
    expect(one!.prompt).toContain('按章纲的节拍分 2 次写，这是第 1 次')
    expect(one!.prompt).toContain('这一次只写章纲里的第 1–3 个节拍')
    expect(one!.prompt).toContain('这一次只是其中 6 个节拍里的 3 个')
    expect(one!.prompt).toContain('篇幅：没有规定字数')
    expect(one!.prompt).not.toContain('篇幅：约')
    expect(two!.prompt).toContain('第 4–6 个节拍')
    expect(two!.prompt).toContain('照常收住')
    // A short one asked for: in parts all the same, each with its share.
    const before = writers().length
    expect((await writeChapter(core, runtime, { chapter: here, words: 1800, digest: false }, task)).parts).toBe(2)
    expect(writers()[before]!.prompt).toContain('篇幅：约 900 字')
    expect(writers()[before]!.prompt).toContain('整章要求约 1800 字')
    // Fewer beats to a part where the author has it so: a part a beat.
    await core.settings.update({ partBeats: 1 })
    expect((await writeChapter(core, runtime, { chapter: here, digest: false }, task)).parts).toBe(6)
  })

  it('is written in one go where the author has it so and it is short enough, or where it has no beats to part it by', async () => {
    const { core, runtime, llm } = bed
    llm.responder = () => '他没有说话。'
    expect((await writeChapter(core, runtime, { chapter: here, words: 3000, digest: false }, task)).parts).toBeUndefined()
    await runtime.project.updateChapter(here, { beats: [] })
    const done = await writeChapter(core, runtime, { chapter: here, words: 9000, digest: false }, task)
    expect(done.parts).toBeUndefined()
    expect(done.short).toMatchObject({ asked: 9000 })
  })

  it('keeps the digest that follows out of the chapter as it is shown, and says when the digest failed', async () => {
    const { core, runtime, llm } = bed
    llm.responder = request => (request.prompt.includes('请做场记') ? JSON.stringify({ brief: '【记忆】', summary: '【记忆的摘要】', characters: [], facts: [], newEntities: [], threads: [] }) : '他没有说话。')
    let shown = ''
    const run = core.jobs.start({ kind: 'write', title: 'write', project: runtime.project.root, target: here, origin: 'user' }, async (job) => {
      const done = await writeChapter(core, runtime, { chapter: here, digest: true }, { origin: 'user', job: { ...job, rewrite: (text) => { shown = text; job.rewrite(text) }, write: (delta) => { shown += delta; job.write(delta) } }, signal: job.signal })
      return done
    })
    const done = await run.done
    expect(done.digested).toBe(true)
    expect(shown).toBe('他没有说话。')
    // A digest that fails leaves the text saved, and is said.
    llm.responder = (request) => { if (request.prompt.includes('请做场记')) throw new Error('the scribe is away'); return '她没有回头。' }
    const again = await writeChapter(core, runtime, { chapter: here, digest: true }, task)
    expect(again.digested).toBe(false)
    expect(again.undigested).toContain('the scribe is away')
    expect(await runtime.project.chapterText(here)).toBe('她没有回头。')
  })

  it('keeps the planner\'s steps out of the chapter as it is shown: they are said where the job\'s progress is', async () => {
    const { core, runtime, llm, roles } = bed
    await core.settings.update({ materialBy: 'planner', context: { plannerWholeTokens: 0 } })
    roles.enabled = true
    roles.script = async (_task, call: Call) => {
      expect(await call('book_read', { what: 'chapter', ref: '1' })).toContain('【第一章】')
      const said = await call('writing_material', { result: { task: '写陆沉来讨笔。', chapters: [1] } })
      if (said.startsWith('ERROR')) throw new Error(said)
    }
    llm.responder = () => '他没有说话。'
    const shown: string[] = []
    const notes: string[] = []
    const done = await core.jobs.start({ kind: 'write', title: 'write', project: runtime.project.root, target: here, origin: 'user' }, async job => await writeChapter(core, runtime, { chapter: here, digest: false }, {
      origin: 'user',
      signal: job.signal,
      job: { ...job, rewrite: (text) => { shown.push(text); job.rewrite(text) }, write: (delta) => { shown.push(delta); job.write(delta) }, note: (label) => { notes.push(label); return job.note(label) } },
    })).done
    expect(done.material).toMatchObject({ by: 'planner', how: 'agent' })
    // Nothing but the chapter was ever written where the chapter is shown…
    expect(shown.length).toBeGreaterThan(0)
    for (const text of shown) expect(text).not.toContain('book_read')
    expect(shown.at(-1)).toBe('他没有说话。')
    // …and what the planner did was said on the progress line.
    expect(notes.some(label => label.includes('book_read chapter 1'))).toBe(true)
    expect(notes.some(label => label.includes('writing_material'))).toBe(true)
  })

  it('the writer as an agent is told where its text stands against the length asked for', async () => {
    const { core, runtime, roles } = bed
    roles.enabled = true
    const said: string[] = []
    roles.script = async (_task, call: Call) => {
      said.push(await call('chapter_write', { text: '他没有说话。' }))
      said.push(await call('chapter_done', { note: '写完了。' }))
      said.push(await call('chapter_write', { text: '船离了岸。', append: true }))
      said.push(await call('chapter_done', { note: '这一章只有两句话的事。' }))
    }
    const done = await writeChapter(core, runtime, { chapter: here, words: 2000, material: 'agent', digest: false }, task)
    expect(said[0]).toContain('要求约 2000 字，还差约')
    expect(said[1]).toContain('ERROR')
    expect(said[1]).toContain('差得多')
    expect(said[3]).toBe('收到。')
    expect(await runtime.project.chapterText(here)).toBe('他没有说话。\n\n船离了岸。')
    expect(done.short).toMatchObject({ asked: 2000 })
  })
})

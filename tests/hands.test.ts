// SPDX-License-Identifier: LGPL-3.0-or-later
/** The showrunner's own hands: exact edits, memory corrections, the book's record, and files changed behind the Studio's back. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobManager } from '../src/core/jobs'
import { correctMemory, editChapter } from '../src/core/pipelines/edit'
import { attachReconciler, managedKind } from '../src/core/reconcile'
import { listWalkOns, settleWalkOn } from '../src/core/walkons'
import { createTestBed, type TestBed } from './support/harness'

const TEXT = '更衣间的门开了一条缝。拍卖师探进半个头，胸口的银槌挂坠轻轻晃了一下。\n“零七。”\n“在。”\n白页没有回答。她低头看自己的手，银槌的影子落在掌心。'

describe('exact edits', () => {
  let bed: TestBed
  let chapter: string
  beforeEach(async () => {
    bed = await createTestBed()
    const { project } = bed.runtime
    await project.saveCharacter({ name: '白页', aliases: ['零七'], role: 'protagonist', status: 'active' })
    chapter = (await project.addChapter({ title: '拍卖厅' })).id
    await project.saveChapterText(chapter, TEXT, { snapshot: false })
    await project.saveChapterText((await project.addChapter({ title: '舷梯' })).id, '续页号的舷梯十七级。', { snapshot: false })
  })
  afterEach(async () => { await bed.cleanup() })

  const agent = { origin: 'agent' as const }

  it('changes exactly what was asked, keeps what was there, and says what to check', async () => {
    const { project } = bed.runtime
    const result = await editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '银槌挂坠', text: '铜槌挂坠', reason: '作者说是铜的' }, agent)
    expect(result).toMatchObject({ applied: true, changes: 1, before: '银槌挂坠', after: '铜槌挂坠', memory: 'stale', characters: [], laterChapters: 1 })
    expect(await project.chapterText(chapter)).toBe(TEXT.replace('银槌挂坠', '铜槌挂坠'))
    // The text as it was is one restore away.
    expect(await project.versionText(chapter, result.version!)).toBe(TEXT)
    expect((await project.versions(chapter))[0]!.reason).toBe('agent-edit')
    // A passage that occurs twice is not guessed at.
    await expect(editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '白页', text: '零七' }, agent)).resolves.toMatchObject({ changes: 1, characters: ['白页'] })
    await expect(editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '零七', text: '白页' }, agent)).rejects.toMatchObject({ code: 'novel/ambiguous' })
    const all = await editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '零七', text: '白页', all: true }, agent)
    expect(all.changes).toBe(2)
    expect(await project.chapterText(chapter)).not.toContain('零七')
    await expect(editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '这句话不在正文里', text: 'x' }, agent)).rejects.toMatchObject({ code: 'novel/not-found' })
    await expect(editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '在。', text: '在。' }, agent)).rejects.toMatchObject({ code: 'novel/invalid' })
  })

  it('inserts, appends, deletes and sets', async () => {
    const { project } = bed.runtime
    await editChapter(bed.core, bed.runtime, { chapter, action: 'insert', find: '“在。”', text: '“上台背第三节。”' }, agent)
    expect(await project.chapterText(chapter)).toContain('“在。”\n“上台背第三节。”\n白页没有回答。')
    await editChapter(bed.core, bed.runtime, { chapter, action: 'insert', find: '探进半个头', where: 'before', text: '慢慢' }, agent)
    expect(await project.chapterText(chapter)).toContain('拍卖师慢慢探进半个头')
    await editChapter(bed.core, bed.runtime, { chapter, action: 'append', text: '门开了。' }, agent)
    expect((await project.chapterText(chapter)).endsWith('掌心。\n门开了。')).toBe(true)
    const removed = await editChapter(bed.core, bed.runtime, { chapter, action: 'delete', find: '“上台背第三节。”\n' }, agent)
    expect(removed.wordsAfter).toBeLessThan(removed.wordsBefore)
    expect(await project.chapterText(chapter)).toContain('“在。”\n白页没有回答。')
    // Quotation marks typed another way are forgiven; nothing else is.
    await editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '"零七。"', text: '“白页。”' }, agent)
    expect(await project.chapterText(chapter)).toContain('“白页。”')
    const set = await editChapter(bed.core, bed.runtime, { chapter, action: 'set', text: '作者自己写的一章。' }, agent)
    expect(set.wordsAfter).toBe(8)
    expect(await project.chapterText(chapter)).toBe('作者自己写的一章。')
    // An empty chapter takes text by `set` only.
    const empty = (await project.addChapter({ title: '空章' })).id
    await expect(editChapter(bed.core, bed.runtime, { chapter: empty, action: 'replace', find: 'x', text: 'y' }, agent)).rejects.toMatchObject({ code: 'novel/empty' })
    await expect(editChapter(bed.core, bed.runtime, { chapter: empty, action: 'set', text: '第一句。' }, agent)).resolves.toMatchObject({ applied: true })
  })

  it('leaves a proposal instead when the author has agent changes wait for review', async () => {
    const { project } = bed.runtime
    await bed.core.settings.update({ reviewAgentRevisions: true })
    const result = await editChapter(bed.core, bed.runtime, { chapter, action: 'replace', find: '银槌挂坠', text: '铜槌挂坠' }, agent)
    expect(result.applied).toBe(false)
    expect(await project.chapterText(chapter)).toBe(TEXT)
    const proposal = (await project.proposals()).find(item => item.id === result.proposalId)!
    expect(proposal).toMatchObject({ kind: 'span', before: '银槌挂坠', after: '铜槌挂坠', createdBy: 'agent', status: 'pending' })
    // The author's own edit is not held back by that setting.
    await expect(editChapter(bed.core, bed.runtime, { chapter, action: 'append', text: '完。' }, { origin: 'user' })).resolves.toMatchObject({ applied: true })
  })

  it('digests the chapter again when auto-digest is on', async () => {
    await bed.core.settings.update({ autoDigest: true })
    bed.llm.responder = () => JSON.stringify({ brief: '白页被点名', summary: '拍卖师来点名。', facts: [], characters: [], newEntities: [], threads: [] })
    const result = await editChapter(bed.core, bed.runtime, { chapter, action: 'append', text: '门开了。' }, agent)
    expect(result.memory).toBe('digesting')
    const job = bed.core.jobs.list(bed.runtime.project.root).find(item => item.kind === 'digest')!
    expect(job.target).toBe(chapter)
  })

  it('corrects what the book remembers without reading the chapter again', async () => {
    const { project } = bed.runtime
    await project.saveMemory({ schema: 1, chapterId: chapter, textHash: 'h', updatedAt: new Date().toISOString(), brief: '点名', summary: '白页拿到了钥匙。', facts: [{ subject: '白页', statement: '拿到了货舱钥匙', kind: 'item' }, { subject: '拍卖师', statement: '胸口挂着银槌', kind: 'state' }], characters: [{ character: 'x', name: '白页', stateAfter: '拿着钥匙' }], newEntities: [], threads: [] })
    const calls = bed.llm.requests.length
    const { memory, changed } = await correctMemory(bed.runtime, chapter, {
      summary: '白页没有拿到钥匙，只是看见了它。',
      removeFacts: ['拿到了货舱钥匙'],
      addFacts: [{ subject: '白页', statement: '看见了货舱钥匙挂在拍卖师腰上', kind: 'knowledge' }],
      characters: [{ name: '白页', stateAfter: '两手空空', learned: ['钥匙在拍卖师身上'] }, { name: '拍卖师', stateAfter: '没有察觉' }],
    })
    expect(bed.llm.requests.length).toBe(calls)
    expect(changed).toEqual(['summary', 'facts −1', 'facts +1', 'state of 白页', 'state of 拍卖师'])
    expect(memory.facts.map(fact => fact.statement)).toEqual(['胸口挂着银槌', '看见了货舱钥匙挂在拍卖师腰上'])
    expect(memory.characters).toEqual([expect.objectContaining({ name: '白页', stateAfter: '两手空空', learned: ['钥匙在拍卖师身上'] }), expect.objectContaining({ name: '拍卖师', stateAfter: '没有察觉' })])
    // The memory still belongs to the text as it stands.
    expect(memory.textHash).toBe('h')
    await expect(correctMemory(bed.runtime, chapter, {})).rejects.toMatchObject({ code: 'novel/invalid' })
  })
})

describe('the book\'s record', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('keeps what changed the book, newest first, and hands it out with the state', async () => {
    const { project } = bed.runtime
    await project.addActivity({ by: 'agent', tool: 'novel_edit', action: 'replace', summary: 'Changed a passage  in chapter 1\nby hand', chapter: 'ch001', version: 'v1' })
    await project.addActivity({ by: 'outside', tool: 'files', summary: 'outline changed' })
    const state = await project.state()
    expect(state.activity!.map(entry => [entry.by, entry.summary])).toEqual([['outside', 'outline changed'], ['agent', 'Changed a passage in chapter 1 by hand']])
    expect(state.activity![1]).toMatchObject({ chapter: 'ch001', version: 'v1' })
  })

  it('notices a chapter changed behind the Studio\'s back, records it, and digests it again', async () => {
    const { project } = bed.runtime
    await bed.core.settings.update({ autoDigest: true })
    bed.llm.responder = () => JSON.stringify({ brief: 'x', summary: 'y', facts: [], characters: [], newEntities: [], threads: [] })
    const chapter = (await project.addChapter({ title: '拍卖厅' })).id
    await project.saveChapterText(chapter, TEXT, { snapshot: false })
    attachReconciler(bed.core)
    // The reconciler hears of books opened from now on: this one is opened afresh.
    await bed.core.lockAll()
    const reopened = await bed.core.create(join(bed.dir, 'second'), { title: '第二本', language: 'zh' })
    const second = (await reopened.project.addChapter({ title: '一' })).id
    await reopened.project.saveChapterText(second, '原来的一章。', { snapshot: false })
    // What the Studio itself wrote — the new book's files, the chapter — is not news, however late the file system reports it.
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(await reopened.project.activity()).toEqual([])
    await writeFile(join(reopened.project.root, 'manuscript', `${second}.md`), '被外面的程序改掉的一章。\n')
    const deadline = Date.now() + 5000
    let record = (await reopened.project.activity())[0]
    while (record === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      record = (await reopened.project.activity())[0]
    }
    expect(record).toMatchObject({ by: 'outside', tool: 'files', chapter: second })
    expect(record!.summary).toContain('工坊之外')
    expect(await reopened.project.activity()).toHaveLength(1)
    expect(bed.core.jobs.list(reopened.project.root).some(job => job.kind === 'digest' && job.target === second)).toBe(true)
  }, 15_000)

  it('knows which files are the book\'s own', () => {
    expect(managedKind('manuscript/ch001.md')).toBe('chapter')
    expect(managedKind('bible/characters/白页.md')).toBe('bible')
    expect(managedKind('outline.json')).toBe('outline')
    expect(managedKind('novel.json')).toBe('manifest')
    expect(managedKind('.novel/memory/ch001.json')).toBe('state')
    for (const free of ['assets/images/a.png', 'export/book.epub', 'notes.md', 'manuscript/notes/x.txt', '../novel.json']) expect(managedKind(free), free).toBeUndefined()
  })
})

describe('people without a card', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('gathers them from memory, suggestions, scripts and the voice sheet, and settles them', async () => {
    const { project } = bed.runtime
    const lead = await project.saveCharacter({ name: '白页·零七', aliases: ['零七'], role: 'protagonist', status: 'active' })
    const one = (await project.addChapter({ title: '一' })).id
    const two = (await project.addChapter({ title: '二' })).id
    await project.saveChapterText(one, '一。', { snapshot: false })
    await project.saveChapterText(two, '二。', { snapshot: false })
    const memory = { schema: 1 as const, textHash: 'h', updatedAt: new Date().toISOString(), brief: '', summary: '', facts: [], threads: [] }
    await project.saveMemory({ ...memory, chapterId: one, characters: [{ character: lead.id, name: '白页·零七' }, { character: '拍卖师', name: '拍卖师', role: '主持拍卖' }], newEntities: [{ name: '记录官多尔', kind: 'character', description: '瘦高个，袖口三颗扣子只扣了两颗' }, { name: '星灯港', kind: 'location', description: '港口' }] })
    await project.saveMemory({ ...memory, chapterId: two, characters: [{ character: '拍卖师', name: '拍卖师' }], newEntities: [] })
    await project.addSuggestions([{ kind: 'new-character', title: '记录官多尔', detail: '清剿舰上的记录官', chapterId: one, payload: { name: '记录官多尔', role: 'minor', tagline: '清剿舰上的记录官' } }])
    await project.saveAudioScript({ schema: 1, chapterId: one, textHash: 'h', updatedAt: new Date().toISOString(), cues: [], lines: [
      { id: 'l0', kind: 'narration', text: '旁白。' },
      { id: 'l1', kind: 'dialogue', text: '零七。', speakerName: '拍卖师' },
      { id: 'l2', kind: 'dialogue', text: '在。', speaker: lead.id, speakerName: '白页·零七' },
      { id: 'l3', kind: 'dialogue', text: '背。', speakerName: '拍卖师' },
      { id: 'l4', kind: 'dialogue', text: '是。', speakerName: '白页' },
    ] })
    await project.updateVoiceCast({ schema: 1, provider: 'openai', characters: {}, extras: {}, prints: {}, updatedAt: '' }, current => ({ ...current, extras: { 拍卖师: 'onyx' } }))
    const found = await listWalkOns(project)
    // Most present first: by chapters, then by lines spoken.
    expect(found.map(item => item.name)).toEqual(['拍卖师', '白页', '记录官多尔'])
    expect(found[0]).toMatchObject({ chapters: [one, two], lines: 2, voice: 'onyx', note: '主持拍卖' })
    expect(found[2]).toMatchObject({ chapters: [one], suggestion: expect.any(String) })
    // A name that sits inside a character's name is offered as that character.
    expect(found[1]).toMatchObject({ near: lead.id, lines: 1 })
    // A card of their own: the voice they had goes with them, and so do their lines.
    const carded = await settleWalkOn(project, { name: '拍卖师', action: 'card', role: 'minor' })
    expect(carded.card).toMatchObject({ name: '拍卖师', role: 'minor', status: 'active', tagline: '主持拍卖', firstAppearance: one, lastAppearance: two })
    expect(carded.lines).toBe(2)
    const sheet = (await project.voiceCast())!
    expect(sheet.extras).toEqual({})
    expect(sheet.characters).toEqual({ [carded.card!.id]: 'onyx' })
    expect((await project.audioScript(one))!.lines.filter(line => line.speaker === carded.card!.id)).toHaveLength(2)
    // Another name for someone known: folded into their aliases.
    const folded = await settleWalkOn(project, { name: '白页', action: 'alias', target: lead.id })
    expect(folded.card!.aliases).toEqual(['零七', '白页'])
    expect((await project.audioScript(one))!.lines[4]!.speaker).toBe(lead.id)
    // Not worth tracking: off the list, and back when asked.
    await settleWalkOn(project, { name: '记录官多尔', action: 'ignore' })
    expect(await listWalkOns(project)).toEqual([])
    expect((await listWalkOns(project, { ignored: true })).map(item => [item.name, item.ignored])).toEqual([['记录官多尔', true]])
    await settleWalkOn(project, { name: '记录官多尔', action: 'restore' })
    const suggested = await settleWalkOn(project, { name: '记录官多尔', action: 'card' })
    expect(suggested.card).toMatchObject({ role: 'minor', tagline: '清剿舰上的记录官' })
    expect(await project.suggestions()).toEqual([])
    expect(await listWalkOns(project)).toEqual([])
  })
})

describe('reading along with a model', () => {
  it('keeps what a job\'s models think, call by call, and hands it out from where a reader left off', async () => {
    const jobs = new JobManager()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = jobs.start({ kind: 'write', title: 'write', project: '/book', origin: 'user' }, async (job) => {
      job.think('先想清楚这一章的落点。')
      job.think('从更衣间写起。')
      job.write('更衣间的门开了一条缝。')
      job.think('结尾收在门开的那一下。')
      await held
    })
    const first = jobs.read(started.id, 0, 0)!
    expect(first.thought).toBe('先想清楚这一章的落点。从更衣间写起。\n\n结尾收在门开的那一下。')
    expect(first.info.thinking).toBe('结尾收在门开的那一下。'.length)
    expect(first.info.thoughtLength).toBe(first.thought!.length)
    // A reader who has the first call's thought gets only what came after.
    expect(jobs.read(started.id, 0, '先想清楚这一章的落点。从更衣间写起。'.length)!.thought).toBe('\n\n结尾收在门开的那一下。')
    expect(jobs.read(started.id, 0, first.thoughtCursor)!.thought).toBe('')
    // Text alone is what a reader gets who did not ask for thought.
    expect(jobs.read(started.id, 0)!.thought).toBeUndefined()
    release()
    await started.done
    // Thought stays readable once the job is done; the "thinking now" count does not.
    const after = jobs.read(started.id, 0, 0)!
    expect(after.info.status).toBe('done')
    expect(after.info.thinking).toBeUndefined()
    expect(after.thought).toBe(first.thought)
  })
})

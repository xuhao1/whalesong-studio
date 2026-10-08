// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packContext } from '../src/core/context'
import { extractJson, LlmCallError } from '../src/core/llm'
import { fallbackLines } from '../src/core/pipelines/audio'
import { acceptSuggestion } from '../src/core/pipelines/bible'
import { digestChapter, digestPending } from '../src/core/pipelines/digest'
import { exportBook, zipStore } from '../src/core/pipelines/export'
import { decodeText, importManuscript, splitChapters } from '../src/core/pipelines/import'
import { deriveChapters } from '../src/core/pipelines/plot'
import { fixIssue, acceptProposal, reviseSpan } from '../src/core/pipelines/revise'
import { cleanProse, writeChapter } from '../src/core/pipelines/write'
import { chunkProse, tokenize } from '../src/core/retrieval'
import { createTestBed, type TestBed } from './support/harness'

const DIGEST = JSON.stringify({
  brief: '沈璃雨夜归家，发现断剑。',
  summary: '沈璃在雨夜回到青冥山下的旧居，在梁上找到师父留下的断剑，决定下山寻找真相。',
  storyTime: '第一夜',
  locations: ['旧居'],
  characters: [
    { name: '沈璃', role: '回到旧居并找到断剑', stateAfter: '决意下山', location: '旧居', emotion: '悲愤', learned: ['师父留下了断剑'], quote: '剑在，人在。', lifecycle: 'enter' },
    { name: '顾七', role: '在门外窥视', stateAfter: '悄然离去', lifecycle: 'enter' },
  ],
  facts: [{ subject: '断剑', statement: '断剑藏在旧居梁上，剑身刻有"青冥"二字', kind: 'item' }],
  newEntities: [{ name: '顾七', kind: 'character', description: '在门外窥视的黑衣人' }, { name: '青冥剑阁', kind: 'location', description: '山巅的废弃剑阁' }],
  threads: [{ title: '断剑的来历', action: 'plant', note: '梁上发现断剑' }],
  openQuestions: ['师父去了哪里？'],
})

describe('pipelines', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('drafts a chapter with the writer model and saves it', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强寡言' })
    await project.saveWorld({ name: '青冥山', category: 'location', importance: 1, summary: '北境雪山' })
    const plan = await project.addChapter({ title: '雨夜', synopsis: '沈璃回到旧居，发现断剑。', characters: ['沈璃'] })
    bed.llm.responder = () => '# 第一章 雨夜\n\n夜雨敲窗。沈璃推开旧居的门。\n\n梁上有一道暗影。'
    const result = await writeChapter(bed.core, bed.runtime, { chapter: 'next', brief: '重点写她的克制' }, { origin: 'user' })
    expect(result.chapterId).toBe(plan.id)
    expect(result.cast).toEqual(['沈璃'])
    expect(await project.chapterText(plan.id)).toBe('夜雨敲窗。沈璃推开旧居的门。\n\n梁上有一道暗影。')
    const request = bed.llm.requests[0]!
    expect(request.system).toContain('只输出小说正文')
    // What stays the same from chapter to chapter travels ahead of the rest, as a block of its own a provider can keep.
    expect(request.stable).toContain('【沈璃】')
    expect(request.stable).toContain('〔青冥山〕')
    expect(request.stable).toContain('世界观核心设定')
    expect(request.prompt).toContain('本章章纲')
    expect(request.prompt).toContain('重点写她的克制')
    // Nobody recommended a length: the writer is left to judge, and the standing instructions name no figure.
    expect(request.prompt).toContain('没有规定字数，由你判断')
    expect(request.system).not.toMatch(/篇幅/)
    expect(result.budget).toBeUndefined()
  })

  it('writes to the length that was recommended, for the chapter or for the book', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '一', synopsis: '开头。', targetWords: 1800 })
    const two = await project.addChapter({ title: '二', synopsis: '接着。' })
    bed.llm.responder = () => '正文。'
    expect((await writeChapter(bed.core, bed.runtime, { chapter: one.id }, { origin: 'user' })).budget).toBe(1800)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('约 1800 字')
    // The book recommends a length for the chapters that name none.
    await project.updateManifest({ chapterBudget: 2400 })
    expect((await writeChapter(bed.core, bed.runtime, { chapter: two.id }, { origin: 'user' })).budget).toBe(2400)
    // The figure every book used to be stamped with is nobody's wish.
    await project.updateManifest({ chapterBudget: 0 })
    expect((await project.manifest()).chapterBudget).toBeUndefined()
    await bed.runtime.project.files.writeJson(project.path('novel.json'), { ...(await project.manifest()), chapterWords: 3000 })
    project.touch()
    const three = await project.addChapter({ title: '三', synopsis: '再接着。' })
    const result = await writeChapter(bed.core, bed.runtime, { chapter: three.id }, { origin: 'user' })
    expect(result.budget).toBeUndefined()
    // Left to judge, the writer is told how long the book's chapters have been running.
    expect(bed.llm.requests.at(-1)!.prompt).toContain('由你判断')
  })

  it('finishes a chapter the model cut off at its output limit', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '长章', synopsis: '很长的一章。', targetWords: 400 })
    let calls = 0
    bed.llm.responder = () => (++calls === 1 ? { text: '上半章。'.repeat(20), finish: 'max-tokens' } : { text: '下半章，到此结束。', finish: 'stop' })
    const result = await writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(result.continued).toBe(true)
    const text = await project.chapterText(plan.id)
    expect(text.startsWith('上半章。')).toBe(true)
    expect(text.endsWith('下半章，到此结束。')).toBe(true)
    expect(bed.llm.requests[1]!.prompt).toContain('本章已有正文')
  })

  it('makes the call again when the model completes without an answer', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '记录官', synopsis: '记录官翻开白页。' })
    let calls = 0
    // What providers do now and then: the reply completes with reasoning in it and no answer.
    bed.llm.responder = () => (++calls === 1 ? { text: '', finish: 'stop', thought: 2400, usage: { inputTokens: 100, outputTokens: 3295 } } : '记录官翻开白页。纸上一个字也没有。')
    const labels: string[] = []
    const stop = bed.core.jobs.onChange(() => {
      const label = bed.core.jobs.list()[0]?.progress?.label
      if (label !== undefined && labels.at(-1) !== label) labels.push(label)
    })
    const { done } = bed.core.jobs.start({ kind: 'write', title: 'write', project: project.root, origin: 'user' }, async job => await writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user', job, signal: job.signal }))
    const result = await done
    stop()
    expect(calls).toBe(2)
    expect(result.wordsWritten).toBeGreaterThan(0)
    expect(await project.chapterText(plan.id)).toBe('记录官翻开白页。纸上一个字也没有。')
    // The same request, unchanged: nothing came of the first one, so it is safe to repeat.
    expect(bed.llm.requests[1]!.prompt).toBe(bed.llm.requests[0]!.prompt)
    expect(bed.llm.requests[1]!.system).toBe(bed.llm.requests[0]!.system)
    // Whoever watches the job reads that the call is being made again, and the label goes back afterwards.
    expect(labels.some(label => label.includes('模型没有返回回答') && label.includes('重试（第 1 次）'))).toBe(true)
    expect(labels.at(-1)).not.toContain('重试')
    // Both calls were made, and both are counted — the empty one cost its reasoning.
    await bed.core.usage.settled()
    const counted = (await bed.core.usage.read()).filter(event => event.kind === 'text')
    expect(counted.map(event => event.output)).toEqual([3295, expect.any(Number)])
  })

  it('says why when the model stays silent or thinks its allowance away', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '沉默', synopsis: '什么也没有发生。' })
    bed.llm.responder = () => ({ text: '', finish: 'stop', thought: 900 })
    await expect(writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).rejects.toThrow(/没有返回任何回答（只有 900 字的思考）——已重试 3 次，仍然如此/)
    expect(bed.llm.requests).toHaveLength(4)
    expect(await project.chapterText(plan.id)).toBe('')

    // The whole allowance spent on reasoning: asking again would spend it again, so it is said at once.
    bed.llm.requests.length = 0
    bed.llm.responder = () => ({ text: '', finish: 'max-tokens', thought: 30_000 })
    await expect(writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).rejects.toThrow(/把输出上限全部用在了思考上/)
    expect(bed.llm.requests).toHaveLength(1)

    // A continuation that comes back empty keeps the rounds before it.
    bed.llm.requests.length = 0
    let calls = 0
    bed.llm.responder = () => (++calls === 1 ? { text: '上半章。'.repeat(20), finish: 'max-tokens' } : { text: '', finish: 'stop' })
    const kept = await writeChapter(bed.core, bed.runtime, { chapter: plan.id, words: 400 }, { origin: 'user' })
    expect(kept.wordsWritten).toBeGreaterThan(0)
    expect((await project.chapterText(plan.id)).startsWith('上半章。')).toBe(true)
  })

  it('rides out a busy provider the way the Harness does for its agent, and no further', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '繁忙', synopsis: '服务器很忙。' })
    let calls = 0
    bed.llm.responder = () => {
      calls += 1
      if (calls === 1) throw new LlmCallError('fake/fake-model: server busy', 'SERVER')
      if (calls === 2) throw new LlmCallError('fake/fake-model: slow down', 'RATE_LIMIT')
      return '服务器很忙，但这一章还是写出来了。'
    }
    await writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(calls).toBe(3)
    expect(await project.chapterText(plan.id)).toBe('服务器很忙，但这一章还是写出来了。')

    // Five retries, as the provider's policy has it; then the failure is the job's, with how often it was tried.
    calls = 0
    bed.llm.responder = () => {
      calls += 1
      throw new LlmCallError('fake/fake-model: server busy', 'SERVER')
    }
    await expect(writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).rejects.toThrow(/server busy——已重试 5 次，仍然如此。请稍后再试。/)
    expect(calls).toBe(6)

    // What asking again cannot mend is not asked again.
    calls = 0
    bed.llm.responder = () => {
      calls += 1
      throw new LlmCallError('fake/fake-model: bad key', 'INVALID_CREDENTIAL')
    }
    await expect(writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).rejects.toThrow('fake/fake-model: bad key')
    expect(calls).toBe(1)

    // A provider that asks for more patience than the policy has is not waited for.
    calls = 0
    bed.llm.responder = () => {
      calls += 1
      throw new LlmCallError('fake/fake-model: come back in an hour', 'RATE_LIMIT', { retryAfterMs: 3_600_000 })
    }
    await expect(writeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).rejects.toThrow('come back in an hour')
    expect(calls).toBe(1)
  })

  it('digests a chapter into memory, lifecycle and suggestions', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist' })
    const plan = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(plan.id, '夜雨敲窗。沈璃推开旧居的门，在梁上找到了断剑。')
    bed.llm.responder = () => `好的，以下是场记：\n\`\`\`json\n${DIGEST}\n\`\`\``
    const memory = await digestChapter(bed.core, bed.runtime, plan.id, { origin: 'user' })
    expect(memory?.characters[0]).toMatchObject({ character: '沈璃', quote: '剑在，人在。' })
    const card = await project.findCharacter('沈璃')
    expect(card).toMatchObject({ status: 'active', firstAppearance: plan.id, lastAppearance: plan.id })
    const outline = await project.outline()
    expect(outline.threads[0]).toMatchObject({ title: '断剑的来历', auto: true, planted: [plan.id] })
    const suggestions = await project.suggestions()
    expect(suggestions.map(item => item.kind).sort()).toEqual(['new-character', 'new-world'])
    await acceptSuggestion(bed.runtime, suggestions.find(item => item.kind === 'new-character')!.id)
    expect((await project.findCharacter('顾七'))?.status).toBe('active')
    expect((await project.chapterInfos())[0]!.digested).toBe(true)
    // Unchanged text is not digested twice.
    const calls = bed.llm.requests.length
    await digestPending(bed.core, bed.runtime, { origin: 'user' })
    expect(bed.llm.requests.length).toBe(calls)
    const presence = await project.presence()
    expect(presence.find(entry => entry.character === '沈璃')).toMatchObject({ chapters: [plan.id], absentFor: 0 })
  })

  it('revises a quoted span as a proposal and applies it on accept', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(plan.id, '她推开门。屋里很黑。\n\n“有人吗？”她问。')
    bed.llm.responder = () => '屋里黑得像一口井。'
    const result = await reviseSpan(bed.core, bed.runtime, { chapter: plan.id, quote: '屋里很黑。', instruction: '更有画面感' }, { origin: 'user' })
    expect(result.applied).toBe(false)
    expect(await project.chapterText(plan.id)).toContain('屋里很黑。')
    expect((await project.state()).stats.pendingProposals).toBe(1)
    await acceptProposal(bed.core, bed.runtime, result.proposalId!, { origin: 'user' })
    expect(await project.chapterText(plan.id)).toBe('她推开门。屋里黑得像一口井。\n\n“有人吗？”她问。')
    expect(await project.versions(plan.id)).toHaveLength(1)
    // The agent applies directly unless review is switched on.
    bed.llm.responder = () => '“谁在那里？”她低声问。'
    const direct = await reviseSpan(bed.core, bed.runtime, { chapter: plan.id, quote: '"有人吗？"她问。', instruction: '更警觉' }, { origin: 'agent' })
    expect(direct.applied).toBe(true)
    expect(await project.chapterText(plan.id)).toContain('“谁在那里？”她低声问。')
  })

  it('mends what a review found where it was found, with the author\'s say', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(plan.id, '她推开门。屋里很黑。\n\n“有人吗？”她问。右手握着剑。')
    await project.saveReview({
      chapterId: plan.id, textHash: 'x', createdAt: '', verdict: '有两处要改',
      issues: [
        { id: 'i1', severity: 'high', type: 'continuity', quote: '右手握着剑。', explanation: '第一章写她是左撇子。', suggestion: '改成左手。' },
        { id: 'i2', severity: 'low', type: 'pacing', explanation: '这一章收得太快。' },
      ],
    })
    bed.llm.responder = () => '左手握着剑。'
    const here = await fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'i1', note: '顺便让她握得更紧', scope: 'passage' }, { origin: 'user' })
    expect(here.scope).toBe('passage')
    // The writer was told what is wrong, what the review suggests — and what the author wants, which decides.
    const asked = bed.llm.requests.at(-1)!.prompt
    for (const part of ['第一章写她是左撇子', '改成左手', '顺便让她握得更紧', '右手握着剑。']) expect(asked, part).toContain(part)
    await acceptProposal(bed.core, bed.runtime, here.passage!.proposalId!, { origin: 'user' })
    expect(await project.chapterText(plan.id)).toContain('左手握着剑。')
    // A problem that quotes no sentence is the chapter's to mend.
    bed.llm.responder = () => '她推开门。屋里很黑。\n\n“有人吗？”她问。左手握着剑，站了很久。'
    const whole = await fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'i2', scope: 'passage' }, { origin: 'user' })
    expect(whole.scope).toBe('chapter')
    expect(whole.passage!.proposalId).toBeDefined()
    await expect(fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'nope', scope: 'passage' }, { origin: 'user' })).rejects.toThrow('no review issue')
  })

  it('mends a problem wherever it reaches: the chapters it touches, and the bible', async () => {
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强', appearance: '惯用右手' })
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山' })
    const three = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(one.id, '她是左撇子，从小如此。')
    await project.saveChapterText(two.id, '她右手握着剑下了山。')
    await project.saveChapterText(three.id, '渡口没有人。')
    await project.saveReview({ chapterId: two.id, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章写她是左撇子。' }] })
    bed.llm.responder = (request) => {
      if (request.prompt.includes('责任编辑')) {
        return JSON.stringify({
          chapters: [{ index: 2, reason: '把右手改成左手' }],
          bible: [{ kind: 'character', name: '沈璃', field: 'appearance', value: '左撇子，惯用左手', reason: '人物卡和第一章对不上' }, { kind: 'character', name: '不存在的人', field: 'appearance', value: 'x' }, { kind: 'character', name: '沈璃', field: 'role', value: 'minor' }],
          note: '问题在人物卡：正文第一章是对的。',
        })
      }
      return '她左手握着剑下了山。'
    }
    const result = await fixIssue(bed.core, bed.runtime, { chapter: two.id, issue: 'i1', scope: 'book' }, { origin: 'user' })
    expect(result.scope).toBe('book')
    // The planner was asked how far the problem reaches, and for the bible as well.
    const scope = bed.llm.requests.find(request => request.prompt.includes('责任编辑'))!.prompt
    expect(scope).toContain('第一章写她是左撇子')
    expect(scope).toContain('"bible"')
    // One chapter changes — as a proposal; the others were judged untouched.
    expect(result.book).toMatchObject({ untouched: 2, note: '问题在人物卡：正文第一章是对的。', bible: [{ name: '沈璃', field: 'appearance' }] })
    expect(result.book!.results.map(item => item.index)).toEqual([2])
    expect(await project.chapterText(two.id)).toContain('右手')
    // The card is the author's: its change waits as a suggestion — only for a field a card has, on a card there is.
    const waiting = (await project.suggestions()).filter(item => item.kind === 'bible-edit')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ title: '修改人物卡：沈璃 · appearance', payload: { target: 'character', id: card.id, field: 'appearance', value: '左撇子，惯用左手' } })
    await acceptSuggestion(bed.runtime, waiting[0]!.id)
    expect(await project.findCharacter('沈璃')).toMatchObject({ appearance: '左撇子，惯用左手', personality: '倔强' })
  })

  it('derives chapters into the outline and links cast and threads', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist' })
    bed.llm.responder = () => JSON.stringify({
      chapters: [
        { title: '下山', synopsis: '沈璃带着断剑下山。', pov: '沈璃', characters: ['沈璃', '陌生人'], beats: [{ summary: '告别旧居' }, '在山门遇阻'], threads: [{ title: '断剑的来历', action: 'plant' }] },
        { title: '渡口', synopsis: '渡口遇见顾七。', characters: ['沈璃'] },
      ],
      rationale: '先离开，再相遇。',
    })
    const result = await deriveChapters(bed.core, bed.runtime, { count: 2 }, { origin: 'agent' })
    expect(result.added.map(item => item.title)).toEqual(['下山', '渡口'])
    const outline = await project.outline()
    const first = outline.volumes[0]!.chapters[0]!
    expect(first).toMatchObject({ pov: '沈璃', status: 'outlined', characters: ['沈璃', '陌生人'] })
    expect(first.beats).toHaveLength(2)
    expect(first.threads).toEqual([outline.threads[0]!.id])
  })

  it('packs layered memory in retrieval mode and whole chapters in full mode', async () => {
    const { project, index } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强' })
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山', synopsis: '沈璃带着断剑下山。', characters: ['沈璃'] })
    await project.saveChapterText(one.id, '夜雨敲窗。沈璃在梁上找到了断剑，剑身刻着青冥二字。\n\n她把断剑裹进旧布。')
    await project.saveMemory({ schema: 1, chapterId: one.id, textHash: 'x', updatedAt: '', brief: '发现断剑', summary: '沈璃在旧居梁上发现断剑。', facts: [], characters: [{ character: '沈璃', name: '沈璃', stateAfter: '决意下山' }], newEntities: [], threads: [] })
    const chapter = (await project.findChapter(two.id))!
    // No budget for the text itself: an outline of what came before, and the end of the chapter before.
    const retrieval = await packContext(project, index, { purpose: 'draft', chapter, textBudget: 0, sideBudget: 6000, tailChars: 200, brief: '断剑' })
    expect(retrieval.strategy).toBe('retrieval')
    expect(retrieval.text).toContain('前情提要')
    expect(retrieval.text).toContain('沈璃在旧居梁上发现断剑。')
    expect(retrieval.text).toContain('决意下山')
    expect(retrieval.text).toContain('上一章《雨夜》结尾原文')
    expect(retrieval.cast.map(card => card.name)).toEqual(['沈璃'])
    const full = await packContext(project, index, { purpose: 'draft', chapter, textBudget: 6000, sideBudget: 6000, tailChars: 200 })
    expect(full.strategy).toBe('full')
    expect(full.included.fullChapters).toBe(1)
    expect(full.window).toEqual({ from: 1, to: 1 })
    expect(full.text).toContain('前文正文（从第一章起，按顺序）')
    expect(full.text).not.toContain('前情提要')
    // The text is part of what a provider can keep; this chapter's own outline is not.
    expect(full.stable).toContain('夜雨敲窗')
    expect(full.stable).not.toContain('本章章纲')
    expect(full.rest).toContain('本章章纲')
    // A chapter is never cut to fit: a budget it does not fit in sends the outline instead.
    const tight = await packContext(project, index, { purpose: 'draft', chapter, textBudget: 20, sideBudget: 6000, tailChars: 100 })
    expect(tight.strategy).toBe('retrieval')
    expect(tight.included.fullChapters).toBe(0)
  })

  it('imports a manuscript: chapters, volumes, digests and a cast', async () => {
    const { project } = bed.runtime
    const text = '第一卷 风起\n\n第一章 雨夜\n\n夜雨敲窗。沈璃回到旧居。\n\n第二章 断剑\n\n梁上有一把断剑。她踩着供桌攀上去，指尖先碰到的是灰，然后才是铁。剑只有半截，断口参差，像被什么东西生生咬断。她把它抱下来，就着窗外的一点天光看——剑身靠近护手的地方，刻着两个已经磨得发亮的小字：青冥。\n\n第二卷 云涌\n\n第三章 下山\n\n她下山去了。'
    bed.llm.responder = (request) => {
      if (request.prompt.includes('请做场记')) return DIGEST
      if (request.prompt.includes('一批人物')) return JSON.stringify({ characters: [{ listed: '沈璃', name: '沈璃', aliases: ['阿璃'], role: 'protagonist', personality: '倔强', status: 'active' }] })
      if (request.prompt.includes('地点、组织、物品')) return JSON.stringify({ entries: [{ name: '青冥剑阁', category: 'location', importance: 2, summary: '废弃剑阁' }] })
      if (request.prompt.includes('一句话摘要')) return JSON.stringify({ logline: '少女携断剑下山。', premise: '……', genre: '武侠', volumes: [{ title: '全书', from: 1, to: 3 }] })
      if (request.prompt.includes('文体学者')) return JSON.stringify({ name: 'x', pov: 'third-limited', tone: '冷峻', rules: ['短句'], avoid: ['抒情'] })
      if (request.prompt.includes('所有画面共用的画风')) return JSON.stringify({ style: '冷色水墨，枯笔，雨雾', avoid: ['现代建筑'], why: '武侠，夜雨。' })
      return 'ok'
    }
    const result = await importManuscript(bed.core, bed.runtime, { text }, { origin: 'user' })
    expect(result).toMatchObject({ chapters: 3, volumes: 2, characters: 1, worldEntries: 1, digested: 3 })
    expect(result.failed).toEqual([])
    // A book that arrives written has a look of its own once it has been read.
    expect(await project.manifest()).toMatchObject({ artStyle: '冷色水墨，枯笔，雨雾', artAvoid: ['现代建筑'] })
    const outline = await project.outline()
    expect(outline.volumes.map(volume => volume.title)).toEqual(['第一卷 风起', '第二卷 云涌'])
    expect(outline.volumes[0]!.chapters.map(chapter => chapter.title)).toEqual(['第一章 雨夜', '第二章 断剑'])
    expect(outline.volumes[0]!.chapters[0]!.synopsis).toContain('断剑')
    const card = await project.findCharacter('阿璃')
    expect(card).toMatchObject({ name: '沈璃', firstAppearance: 'ch001', lastAppearance: 'ch003' })
    expect((await project.manifest()).logline).toBe('少女携断剑下山。')
    expect((await project.activeStyle())?.name).toBe('原作文风')
  })

  it('exports Markdown and a structurally valid EPUB', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(plan.id, '夜雨敲窗。\n\n她在灯下磨剑。')
    const markdown = await exportBook(bed.runtime, { format: 'markdown' })
    expect(await readFile(project.path(markdown.path), 'utf8')).toContain('### 第1章 雨夜')
    const epub = await exportBook(bed.runtime, { format: 'epub' })
    const bytes = await readFile(project.path(epub.path))
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004')
    // The first entry is the uncompressed mimetype, as the EPUB container format requires.
    expect(bytes.subarray(30, 38).toString('latin1')).toBe('mimetype')
    expect(bytes.subarray(38, 58).toString('latin1')).toBe('application/epub+zip')
  })
})

describe('pure helpers', () => {
  it('recovers JSON from fenced, wrapped and truncated replies', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Sure! {"a": [1, 2,], "b": "x"} hope it helps')).toEqual({ a: [1, 2], b: 'x' })
    // A truncated reply keeps every complete member, including those of the object that was cut.
    expect(extractJson('{"items": [{"n": 1}, {"n": 2}, {"n": 3, "t": "cut of')).toEqual({ items: [{ n: 1 }, { n: 2 }, { n: 3 }] })
    expect(() => extractJson('no json here')).toThrow()
  })

  it('strips headings and fences models add around prose', () => {
    expect(cleanProse('第三章 夜雨\n\n正文第一段。', '夜雨')).toBe('正文第一段。')
    expect(cleanProse('```\n正文。\n```')).toBe('正文。')
    expect(cleanProse('她说：“第三章才是开始。”')).toBe('她说：“第三章才是开始。”')
  })

  it('splits by chapter headings, markdown headings, or size', () => {
    const cn = splitChapters('楔子\n\n很久以前。\n\n第一章 开端\n\n故事开始了。\n\n第二章\n\n故事继续。')
    expect(cn.map(chapter => chapter.title)).toEqual(['楔子', '第一章 开端', '第二章'])
    const en = splitChapters('Chapter 1: Dawn\n\nIt began.\n\nChapter 2\n\nIt went on.')
    expect(en.map(chapter => chapter.title)).toEqual(['Chapter 1: Dawn', 'Chapter 2'])
    const md = splitChapters('# Dawn\n\nIt began.\n\n# Dusk\n\nIt ended.')
    expect(md.map(chapter => chapter.title)).toEqual(['Dawn', 'Dusk'])
    const plain = splitChapters(Array.from({ length: 40 }, (_, i) => `这是第${i}段，没有任何章节标题，只是一段很普通的文字而已。`.repeat(8)).join('\n\n'))
    expect(plain.length).toBeGreaterThan(1)
    expect(plain[0]!.title).toBe('第1节')
  })

  it('decodes GB18030 and UTF-16 text files', () => {
    expect(decodeText(Buffer.from('夜雨', 'utf8'))).toBe('夜雨')
    expect(decodeText(Uint8Array.from([0xd2, 0xb9, 0xd3, 0xea]))).toBe('夜雨')
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('夜雨', 'utf16le')]))).toBe('夜雨')
  })

  it('tokenizes CJK as bigrams and chunks on paragraphs', () => {
    expect(tokenize('断剑 Sword')).toEqual(['断', '断剑', 'sword'])
    const chunks = chunkProse(Array.from({ length: 30 }, (_, i) => `第${i}段。`.repeat(20)).join('\n'))
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0]!.offset).toBe(0)
  })

  it('cuts dialogue from narration when the director pass is unusable', () => {
    const lines = fallbackLines('她抬起头。“你来晚了。”他没有回答，只是把剑放在桌上。\n“坐。”')
    expect(lines).toEqual([
      { kind: 'narration', text: '她抬起头。' },
      { kind: 'dialogue', text: '你来晚了。' },
      { kind: 'narration', text: '他没有回答，只是把剑放在桌上。' },
      { kind: 'dialogue', text: '坐。' },
    ])
  })

  it('writes stored zip entries with correct sizes', () => {
    const zip = zipStore([{ name: 'a.txt', data: Buffer.from('hello') }])
    expect(zip.length).toBe(30 + 5 + 5 + 46 + 5 + 22)
  })
})

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
import { siftCast, siftDue } from '../src/core/pipelines/cast'
import { listWalkOns } from '../src/core/walkons'
import { deriveChapters } from '../src/core/pipelines/plot'
import { fixIssue, fixIssues, acceptProposal, rejectProposal, mendInTurn, reviseSpan } from '../src/core/pipelines/revise'
import { listReviews, noteIssue, recheckIssues } from '../src/core/pipelines/review'
import { importLine } from '../src/core/pipelines/import'
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
    expect(card).toMatchObject({ firstAppearance: plan.id, lastAppearance: plan.id })
    const outline = await project.outline()
    expect(outline.threads[0]).toMatchObject({ title: '断剑的来历', auto: true, planted: [plan.id] })
    // A new place is proposed; a new name is not — a digest names everybody a chapter meets. He is on the list of
    // walk-ons, where the planner has yet to look at him.
    expect((await project.suggestions()).map(item => item.kind)).toEqual(['new-world'])
    expect((await listWalkOns(project)).map(item => [item.name, item.chapters.length, item.verdict])).toEqual([['顾七', 1, undefined]])
    expect((await siftDue(bed.runtime)).map(item => item.name)).toEqual(['顾七'])
    // The planner looks through the names and finds him worth a card: that waits as a suggestion, with its reason.
    bed.llm.responder = () => JSON.stringify({ people: [{ name: '顾七', is: 'card', why: '在门外窥视断剑的人，后面必有戏。', role: 'supporting', tagline: '窥视旧居的黑衣人' }] })
    const sifted = await siftCast(bed.core, bed.runtime, {}, { origin: 'user' })
    expect(sifted).toMatchObject({ looked: 1, cards: ['顾七'], aliases: [], walkOns: 0 })
    const asked = bed.llm.requests.at(-1)!.prompt
    for (const part of ['还没有人物卡的一批名字', '- 顾七（出现在 1 章：第 1 章）：在门外窥视的黑衣人', '【已经有人物卡的人】', '沈璃', '只露过一面']) expect(asked, part).toContain(part)
    const suggestions = await project.suggestions()
    expect(suggestions.map(item => item.kind).sort()).toEqual(['new-character', 'new-world'])
    expect(suggestions.find(item => item.kind === 'new-character')).toMatchObject({ title: '新人物：顾七', detail: '在门外窥视断剑的人，后面必有戏。', sifted: true, payload: { name: '顾七', role: 'supporting', tagline: '窥视旧居的黑衣人', firstAppearance: plan.id } })
    // Looked at, he is not asked about again until he is seen in more chapters.
    expect(await siftDue(bed.runtime)).toEqual([])
    await acceptSuggestion(bed.runtime, suggestions.find(item => item.kind === 'new-character')!.id)
    expect((await project.findCharacter('顾七'))?.role).toBe('supporting')
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
    // A problem that quotes no sentence is not the chapter's to be written over for: the planner settles which place
    // mends it — quoting the text as it stands, and sent back when what it quotes is not there — and the writer
    // rewrites that place and nothing else. It comes back as a small change of its own, beneath the issue.
    const before = await project.chapterText(plan.id)
    let scoped = 0
    bed.llm.responder = (request) => {
      if (request.prompt.includes('责任编辑')) {
        scoped += 1
        return JSON.stringify({ edits: [{ chapter: 1, find: scoped === 1 ? '她问了一声，握着剑。' : '“有人吗？”她问。', how: '让她站一会儿再开口，慢下来' }], chapters: [], note: '只要这一处慢下来。' })
      }
      return '她站了很久，才问：“有人吗？”'
    }
    const placed = await fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'i2', scope: 'passage' }, { origin: 'user' })
    expect(placed.scope).toBe('places')
    const planner = bed.llm.requests.filter(request => request.prompt.includes('责任编辑'))
    // Told: as little as will do, one place where one will do, quoted word for word; the chapter goes along whole to quote from.
    for (const part of ['这一章收得太快', '一处能解决的，不改两处', '逐字照抄', '只修这个问题本身', '相关章节的正文', '“有人吗？”她问。']) expect(planner[0]!.prompt, part).toContain(part)
    expect(planner).toHaveLength(2)
    expect(planner[1]!.prompt).toContain('第 1 章里找不到这段原文')
    expect(placed.book!.results).toMatchObject([{ index: 1, kind: 'span', reason: '让她站一会儿再开口，慢下来' }])
    expect(placed.book!.note).toBe('只要这一处慢下来。')
    const writer = bed.llm.requests.at(-1)!.prompt
    for (const part of ['这一章收得太快', '这一次只改下面这一处。策划定的改法：让她站一会儿再开口，慢下来', '<<<\n“有人吗？”她问。\n>>>']) expect(writer, part).toContain(part)
    const small = (await project.proposals()).find(item => item.id === placed.book!.results[0]!.proposalId)!
    expect(small).toMatchObject({ kind: 'span', status: 'pending', before: '“有人吗？”她问。', after: '她站了很久，才问：“有人吗？”', issues: ['i2'], batchId: placed.book!.batchId })
    expect((await project.review(plan.id))!.issues[1]!.mending).toBe(placed.book!.batchId)
    expect(await project.chapterText(plan.id)).toBe(before)
    // Written over whole only when that is asked for in so many words.
    bed.llm.responder = () => '她推开门。屋里很黑。\n\n“有人吗？”她问。左手握着剑，站了很久。'
    const whole = await fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'i2', scope: 'chapter' }, { origin: 'user' })
    expect(whole.scope).toBe('chapter')
    expect((await project.proposals()).find(item => item.id === whole.passage!.proposalId)).toMatchObject({ kind: 'chapter', issues: ['i2'] })
    await expect(fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'nope', scope: 'passage' }, { origin: 'user' })).rejects.toThrow('no review issue')
  })

  it('a mending that follows another goes on from the change still waiting, and stands for it', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '雨夜' })
    const original = '她推开门。屋里很黑。\n\n“有人吗？”她问。右手握着剑。'
    await project.saveChapterText(plan.id, original)
    await project.saveReview({
      chapterId: plan.id, textHash: 'x', createdAt: '', verdict: '',
      issues: [
        { id: 'i1', severity: 'high', type: 'continuity', quote: '右手握着剑。', explanation: '第一章写她是左撇子。' },
        { id: 'i2', severity: 'medium', type: 'style', quote: '屋里很黑。', explanation: '太平。' },
        { id: 'i3', severity: 'low', type: 'pacing', explanation: '这一章收得太快。' },
      ],
    })
    const pending = async (): Promise<string[]> => (await project.proposals()).filter(item => item.status === 'pending').map(item => item.id)
    bed.llm.responder = () => '左手握着剑。'
    const first = (await fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'i1', scope: 'passage' }, { origin: 'user' })).passage!.proposalId!

    // Another passage, in its turn: written knowing the change that waits, and still a change of its own.
    bed.llm.responder = () => '屋里黑得像一口井。'
    const second = (await fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'i2', scope: 'passage', onto: true }, { origin: 'user' })).passage!.proposalId!
    expect(bed.llm.requests.at(-1)!.prompt).toContain('左手握着剑。')
    expect((await project.proposals()).find(item => item.id === second)).toMatchObject({ kind: 'span', before: '屋里很黑。', after: '屋里黑得像一口井。', issues: ['i2'] })
    expect(await pending()).toEqual([first, second])

    // A passage that a waiting change made: one proposal for the chapter with all of it in, standing for the two.
    bed.llm.responder = () => '左手死死握着剑。'
    const third = (await reviseSpan(bed.core, bed.runtime, { chapter: plan.id, quote: '左手握着剑。', instruction: '握得更紧', onto: true }, { origin: 'user' })).proposalId!
    const stacked = (await project.proposals()).find(item => item.id === third)!
    expect(stacked).toMatchObject({ kind: 'chapter', status: 'pending', before: original, after: '她推开门。屋里黑得像一口井。\n\n“有人吗？”她问。左手死死握着剑。', supersedes: [first, second] })
    expect(stacked.issues?.sort()).toEqual(['i1', 'i2'])
    expect(stacked.rationale).toContain('2 处')
    expect((await project.proposals()).find(item => item.id === first)).toMatchObject({ status: 'rejected', supersededBy: third })
    expect(await pending()).toEqual([third])
    // The text itself has not moved.
    expect(await project.chapterText(plan.id)).toBe(original)
    // (Not in its turn, the same passage is not there to be found: the book still has the right hand.)
    await expect(reviseSpan(bed.core, bed.runtime, { chapter: plan.id, quote: '左手握着剑。', instruction: '握得更紧' }, { origin: 'user' })).rejects.toThrow('not found')

    // A whole-chapter mending in its turn: the writer reads the chapter with every waiting change in.
    bed.llm.responder = () => '她推开门。屋里黑得像一口井。\n\n“有人吗？”她问。左手死死握着剑，站了很久。'
    const fourth = (await fixIssue(bed.core, bed.runtime, { chapter: plan.id, issue: 'i3', scope: 'chapter', onto: true }, { origin: 'user' })).passage!.proposalId!
    const asked = bed.llm.requests.at(-1)!.prompt
    expect(asked).toContain('屋里黑得像一口井。')
    expect(asked).toContain('左手死死握着剑。')
    expect(asked).not.toContain('右手握着剑')
    const last = (await project.proposals()).find(item => item.id === fourth)!
    expect(last).toMatchObject({ kind: 'chapter', before: original, supersedes: [first, second, third] })
    expect(last.issues?.sort()).toEqual(['i1', 'i2', 'i3'])
    expect(await pending()).toEqual([fourth])

    // Turned down, the one before it comes back to wait: what was said no to is the last mending only.
    await rejectProposal(bed.runtime, fourth)
    expect(await pending()).toEqual([third])
    // Applied outright, a change is made to the text as it stands and accepts nothing on the author's behalf.
    bed.llm.responder = () => '她一把推开门。'
    const direct = await reviseSpan(bed.core, bed.runtime, { chapter: plan.id, quote: '她推开门。', instruction: '更急', onto: true, apply: true }, { origin: 'user' })
    expect(direct.applied).toBe(true)
    expect(await project.chapterText(plan.id)).toBe(original.replace('她推开门。', '她一把推开门。'))
    expect(await pending()).toEqual([third])
    // Accepted, everything it stands for is in the text.
    await acceptProposal(bed.core, bed.runtime, third, { origin: 'user' })
    expect(await project.chapterText(plan.id)).toBe(stacked.after)
    expect(await pending()).toEqual([])
  })

  it('mendings take their turn when asked to, and run side by side when not', async () => {
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = mendInTurn(bed.runtime, 'queue', { origin: 'user' }, async (onto) => {
      // (The first of a line goes on from whatever waits already: there is nothing before it to wait for.)
      order.push(`first starts${onto ? ' onto' : ''}`)
      await held
      order.push('first ends')
    })
    const apart = mendInTurn(bed.runtime, 'apart', { origin: 'user' }, async (onto) => { order.push(`apart runs${onto ? ' onto' : ''}`) })
    const queued = mendInTurn(bed.runtime, 'queue', { origin: 'user' }, async (onto) => { order.push(`queued runs${onto ? ' onto' : ''}`) })
    const stopped = new AbortController()
    const given = mendInTurn(bed.runtime, 'queue', { origin: 'user', signal: stopped.signal }, async () => { order.push('never') })
    await apart
    expect(order).toEqual(['first starts onto', 'apart runs'])
    // One that is stopped while it waits leaves the line without holding up the rest.
    stopped.abort(new Error('stopped'))
    await expect(given).rejects.toThrow('stopped')
    release()
    await Promise.all([first, queued])
    expect(order).toEqual(['first starts onto', 'apart runs', 'first ends', 'queued runs onto'])
    // Nothing is left of the line: the next one starts at once.
    await mendInTurn(bed.runtime, 'queue', { origin: 'user' }, async () => { order.push('next') })
    expect(order.at(-1)).toBe('next')
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

  it('writes in rounds: what the reviews found is mended across the chapters and applied, what changed is reviewed again — until nothing is left, or the rounds are used up', async () => {
    const { iterateChapters } = await import('../src/core/pipelines/iterate')
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山' })
    await project.saveChapterText(one.id, '她是左撇子，从小如此。')
    await project.saveChapterText(two.id, '她右手握着剑下了山。')
    const asked: string[] = []
    // A reviewer that is content once the hand is right — or (stubborn) never.
    let stubborn = false
    bed.llm.responder = (request) => {
      if (request.prompt.includes('审读')) {
        const wrong = request.prompt.includes('右手握着剑') || (stubborn && request.prompt.includes('握着剑下了山'))
        asked.push(request.prompt.includes('握着剑下了山') ? 'review 2' : 'review 1')
        return JSON.stringify({ verdict: '', issues: wrong ? [{ severity: 'high', type: 'continuity', quote: '握着剑', explanation: '第一章写她是左撇子。' }] : [] })
      }
      if (request.prompt.includes('审校在这一章发现了下面的问题')) {
        asked.push('rewrite 2')
        return '她左手握着剑下了山。'
      }
      if (request.prompt.includes('发现了下面')) {
        asked.push('plan')
        return JSON.stringify({ chapters: [{ index: 2, reason: '右手改左手' }], note: '惯用手要一致。' })
      }
      asked.push('digest')
      return JSON.stringify({ brief: '摘要', summary: '下山。', characters: [], facts: [], newEntities: [], threads: [] })
    }
    const result = await iterateChapters(bed.core, bed.runtime, { chapters: [one.id, two.id], rounds: 3 }, { origin: 'user' })
    // Both are reviewed first; one round mends chapter two, which is digested and reviewed again — and found clean.
    expect(asked.slice(0, 2).sort()).toEqual(['review 1', 'review 2'])
    expect(asked.slice(2)).toEqual(['plan', 'rewrite 2', 'digest', 'review 2'])
    expect(result).toMatchObject({ left: 0, ended: 'clean', rounds: [{ round: 1, issues: 1, chapters: 1, rewritten: [two.id], note: '惯用手要一致。' }] })
    // What the round changed is the text; the draft it replaced is a version, and nothing waits to be accepted.
    expect(await project.chapterText(two.id)).toBe('她左手握着剑下了山。')
    expect((await project.versions(two.id)).map(version => version.reason)).toContain('before-revise')
    expect((await project.proposals()).filter(proposal => proposal.status === 'pending')).toEqual([])
    expect(await project.chapterText(one.id)).toBe('她是左撇子，从小如此。')

    // A reviewer never content: the rounds are used up, and what is still open is said.
    stubborn = true
    await project.saveChapterText(two.id, '她右手握着剑下了山。')
    await project.removeReview(two.id)
    asked.length = 0
    const worn = await iterateChapters(bed.core, bed.runtime, { chapters: [two.id], rounds: 2, atLeast: 'high' }, { origin: 'user' })
    expect(worn.rounds.map(round => round.round)).toEqual([1, 2])
    expect(worn).toMatchObject({ left: 1, ended: 'rounds' })
    expect(asked.filter(what => what === 'plan')).toHaveLength(2)
  })

  it('mends several things a review found together, across chapters, each chapter once', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山' })
    const three = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(one.id, '她是左撇子，从小如此。山门前的雪还没化。')
    await project.saveChapterText(two.id, '她右手握着剑下了山。那是盛夏。')
    await project.saveChapterText(three.id, '渡口没有人，她用右手解开缆绳。')
    await project.saveReview({ chapterId: one.id, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'a1', severity: 'low', type: 'language', quote: '从小如此', explanation: '这句是废话。' }] })
    await project.saveReview({ chapterId: two.id, textHash: 'x', createdAt: '', verdict: '', issues: [
      { id: 'b1', severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章写她是左撇子。', suggestion: '改成左手' },
      { id: 'b2', severity: 'medium', type: 'timeline', quote: '那是盛夏', explanation: '上一章还是雪天。' },
      { id: 'b3', severity: 'high', type: 'logic', explanation: '早就处理过的。', resolved: true },
    ] })
    // What the author says of one issue is kept with it — and taken off again by an empty note.
    await noteIssue(bed.runtime, two.id, 'b2', '改成初春，不要盛夏')
    expect((await project.review(two.id))!.issues[1]!.note).toBe('改成初春，不要盛夏')
    await noteIssue(bed.runtime, one.id, 'a1', '  ')
    expect((await project.review(one.id))!.issues[0]!.note).toBeUndefined()
    expect(await noteIssue(bed.runtime, two.id, 'nope', 'x')).toBeUndefined()
    // The page that lists them reads every review in reading order.
    expect((await listReviews(bed.runtime)).map(review => [review.index, review.title, review.issues.length])).toEqual([[1, '雨夜', 1], [2, '下山', 3]])

    bed.llm.responder = (request) => {
      if (request.prompt.includes('责任编辑')) return JSON.stringify({ chapters: [{ index: 2, reason: '右手改左手；季节改成初春' }, { index: 3, reason: '解缆绳也改成左手' }], note: '惯用手要三章一致。' })
      return request.prompt.includes('渡口') || request.prompt.includes('解缆绳') ? '渡口没有人，她用左手解开缆绳。' : '她左手握着剑下了山。那是初春。'
    }
    // Named one by one, with a word on the batch and a word on one of them given at the moment.
    const result = await fixIssues(bed.core, bed.runtime, { issues: [{ chapter: two.id, issue: 'b2' }, { chapter: two.id, issue: 'b1', note: '一律左手' }], note: '动得越少越好' }, { origin: 'user' })
    expect(result).toMatchObject({ issues: 2, chapters: 1 })
    // One planner read them side by side: both issues, what the author said of each — the note kept with one, the
    // one given now — and of the batch; and it was asked how far they reach.
    const scope = bed.llm.requests.find(request => request.prompt.includes('责任编辑'))!.prompt
    for (const part of ['发现了下面 2 个问题', '### 第 2 章《下山》', '第一章写她是左撇子', '审校的建议：改成左手', '作者对怎么改的要求（以此为准）：一律左手', '上一章还是雪天', '作者对怎么改的要求（以此为准）：改成初春，不要盛夏', '作者对这一批的总要求（以此为准）：动得越少越好', '前后改成一致', '还有哪些章节']) expect(scope, part).toContain(part)
    // Each chapter is rewritten once: chapter 2 for both of its issues, chapter 3 — which nobody named — because it
    // tells of the same hand. Both wait as proposals; the text is as it was.
    expect(result.book!.results.map(item => item.index)).toEqual([2, 3])
    const writers = bed.llm.requests.filter(request => !request.prompt.includes('责任编辑')).map(request => request.prompt)
    expect(writers).toHaveLength(2)
    const second = writers.find(prompt => prompt.includes('审校在这一章发现了下面的问题'))!
    for (const part of ['第一章写她是左撇子', '上一章还是雪天', '一律左手', '改成初春，不要盛夏', '动得越少越好', '策划对这一章的安排：右手改左手；季节改成初春', '只改为解决这些问题必须改的地方']) expect(second, part).toContain(part)
    const third = writers.find(prompt => prompt.includes('这一章本身没有被点名的问题'))!
    for (const part of ['策划对这一章的安排：解缆绳也改成左手', '这一批同时在修的问题', '第 2 章：第一章写她是左撇子']) expect(third, part).toContain(part)
    expect(await project.chapterText(two.id)).toContain('右手')
    expect((await project.proposals()).filter(item => item.status === 'pending')).toHaveLength(2)
    // Each proposal says which issues it was made to mend — the page shows it beneath them; the one for a chapter nobody named mends none of its own.
    expect((await project.proposals()).filter(item => item.status === 'pending').map(item => [item.chapterId, [...(item.issues ?? [])].sort(), item.batchId === result.book!.batchId]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))).toEqual([[two.id, ['b1', 'b2'], true], [three.id, [], true]])
    // The issues handed over say so, and stay open; the one not in the batch does not.
    const after = (await project.review(two.id))!.issues
    expect(after.map(issue => [issue.id, issue.mending !== undefined, issue.resolved === true])).toEqual([['b1', true, false], ['b2', true, false], ['b3', false, true]])
    expect(after[0]!.mending).toBe(result.book!.batchId)

    // From a severity up: every open issue that grave or graver, the settled one left out; `low` takes them all.
    const requests = bed.llm.requests.length
    const grave = await fixIssues(bed.core, bed.runtime, { atLeast: 'high' }, { origin: 'user' })
    expect(grave).toMatchObject({ issues: 1, chapters: 1 })
    expect(bed.llm.requests[requests]!.prompt).toContain('发现了下面 1 个问题')
    expect(bed.llm.requests[requests]!.prompt).not.toContain('早就处理过的')
    expect(await fixIssues(bed.core, bed.runtime, { atLeast: 'low' }, { origin: 'user' })).toMatchObject({ issues: 3, chapters: 2 })
    expect(await fixIssues(bed.core, bed.runtime, { atLeast: 'medium', chapters: [one.id] }, { origin: 'user' })).toEqual({ issues: 0, chapters: 0 })
    await expect(fixIssues(bed.core, bed.runtime, { issues: [{ chapter: two.id, issue: 'nope' }] }, { origin: 'user' })).rejects.toThrow('no review issue')
  })

  it('looks again at what is still open once the text has changed', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山' })
    const three = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(one.id, '她是左撇子。')
    await project.saveChapterText(two.id, '她左手握着剑下了山。那是初春，山道上还有残雪。')
    await project.saveChapterText(three.id, '渡口没有人，她用右手解开缆绳。')
    await project.saveReview({ chapterId: two.id, textHash: 'x', createdAt: '', verdict: '', issues: [
      { id: 'b1', severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章写她是左撇子。' },
      { id: 'b2', severity: 'medium', type: 'timeline', quote: '那是盛夏', explanation: '上一章还是雪天。' },
      { id: 'b3', severity: 'low', type: 'pacing', explanation: '下山写得太快。' },
      { id: 'b4', severity: 'low', type: 'language', quote: '残雪', explanation: '早就处理过的。', resolved: true },
    ] })
    await project.saveReview({ chapterId: three.id, textHash: 'x', createdAt: '', verdict: '', issues: [
      { id: 'c1', severity: 'high', type: 'continuity', quote: '右手解开缆绳', explanation: '惯用手和前文不一致。', mending: 'batch-1' },
      { id: 'c2', severity: 'low', type: 'style', quote: '渡口没有人', explanation: '开头平。' },
    ] })
    bed.llm.responder = request => request.prompt.includes('第 2 章《下山》')
      ? JSON.stringify({ issues: [
          { id: 'b1', verdict: 'fixed', why: '现在写的是左手' },
          { id: 'b2', verdict: 'changed', quote: '那是初春，山道上还有残雪', explanation: '改成初春后与上一章接上了，但“残雪”和后文的桃花仍有出入。', why: '季节改了' },
          { id: 'b3', verdict: 'stands', quote: '这一句正文里没有', why: '没有动' },
          { id: 'b4', verdict: 'fixed' },
          { id: 'zz', verdict: 'fixed' },
        ] })
      : JSON.stringify({ issues: [{ id: 'c1', verdict: 'stands', why: '这一章没有改' }] })
    const result = await recheckIssues(bed.core, bed.runtime, { chapters: [two.id], batches: ['batch-1'], changes: '第 2 章整章重写过\n为的是：右手改左手' }, { origin: 'user' })
    // Of the chapter that changed: everything open. Of another: only what was handed over with the batch.
    expect(result).toMatchObject({ looked: 4, chapters: 2, fixed: [{ chapterId: two.id, index: 2, issue: 'b1', why: '现在写的是左手' }], changed: [{ chapterId: two.id, issue: 'b2' }] })
    const asked = bed.llm.requests.map(request => request.prompt)
    expect(asked).toHaveLength(2)
    for (const part of ['## 这次改了什么\n第 2 章整章重写过', 'id: b1', '当时引的原文："右手握着剑"（现在的正文里已经没有这一句）', 'id: b3', '她左手握着剑下了山', '只判断上面列出的这几条，不要提新的问题']) expect(asked[0], part).toContain(part)
    expect(asked[0]).not.toContain('id: b4')
    expect(asked[1]).toContain('id: c1')
    expect(asked[1]).not.toContain('id: c2')
    const after = (await project.review(two.id))!.issues
    // Settled by the change: marked, with why. Reading differently now: brought up to the text. Standing: as it was
    // — a quote the text does not have is not taken. What was settled before, and what nobody was asked about, are untouched.
    expect(after[0]).toMatchObject({ id: 'b1', resolved: true, checked: { verdict: 'fixed', why: '现在写的是左手' } })
    expect(after[1]).toMatchObject({ id: 'b2', quote: '那是初春，山道上还有残雪', explanation: expect.stringContaining('桃花'), checked: { verdict: 'changed' } })
    expect(after[1]!.resolved).toBeUndefined()
    expect(after[2]).toMatchObject({ id: 'b3', explanation: '下山写得太快。', checked: { verdict: 'stands' } })
    expect(after[2]!.quote).toBeUndefined()
    expect(after[3]).toEqual({ id: 'b4', severity: 'low', type: 'language', quote: '残雪', explanation: '早就处理过的。', resolved: true })
    const other = (await project.review(three.id))!.issues
    expect(other[0]).toMatchObject({ id: 'c1', quote: '右手解开缆绳', checked: { verdict: 'stands', why: '这一章没有改' } })
    expect(other[1]!.checked).toBeUndefined()
    // Nothing open where the text changed: nobody is asked.
    const before = bed.llm.requests.length
    expect(await recheckIssues(bed.core, bed.runtime, { chapters: [one.id], changes: 'x' }, { origin: 'user' })).toMatchObject({ looked: 0, chapters: 0 })
    expect(bed.llm.requests.length).toBe(before)
  })

  it('imports a manuscript as another line of the plot, in the same world', async () => {
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强' })
    const main = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(main.id, '沈璃在雨里下了山。')
    bed.llm.responder = request => request.prompt.includes('请做场记') ? JSON.stringify({ brief: '另一条路', summary: '沈璃留在了山上。', facts: [], newEntities: [], threads: [], characters: [{ name: '沈璃', role: '留守剑阁' }] }) : '{}'
    const result = await importLine(bed.core, bed.runtime, { text: '第一章 留山\n\n沈璃没有下山。她守着剑阁。\n\n第二章 来客\n\n有人敲门。', title: '她没有下山', premise: '如果她留下' }, { origin: 'user' })
    expect(result).toMatchObject({ line: { title: '她没有下山' }, chapters: 2, digested: 2, failed: [] })
    // A line of its own, from where the story begins: it joins nothing, and the main line is as it was.
    const line = (await project.outline()).lines!.find(item => item.id === result.line.id)!
    expect([line.title, line.premise, line.from, line.into]).toEqual(['她没有下山', '如果她留下', undefined, undefined])
    expect((await project.chapters()).map(chapter => chapter.plan.title)).toEqual(['雨夜'])
    const own = await project.chapters(line.id)
    expect(own.map(chapter => [chapter.index, chapter.plan.title])).toEqual([[1, '第一章 留山'], [2, '第二章 来客']])
    expect(await project.chapterText(own[0]!.plan.id)).toContain('沈璃没有下山')
    // The same world: its chapters are digested, and somebody the book knows is known on this line too — her life read along it.
    const lives = await project.lives(line.id)
    expect(lives.lives[card.id]?.events.map(event => event.index)).toEqual([1, 2])
    expect((await project.lives()).lives[card.id]?.events ?? []).toEqual([])
    // Without the digest: the chapters are in, nothing is read yet.
    const bare = await importLine(bed.core, bed.runtime, { text: '只有一段话的短稿。', title: '短稿', digest: false }, { origin: 'user' })
    expect(bare).toMatchObject({ chapters: 1, digested: 0 })
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
      // How the people of the book change along it: their ages, the points where they turn.
      if (request.prompt.includes('在书里的各个时期')) return JSON.stringify({ age: '十六岁（少年）', stages: [{ title: '下山时', chapter: 1, age: '十六岁（少年）', what: '携断剑下山' }] })
      if (request.prompt.includes('地点、组织、物品')) return JSON.stringify({ entries: [{ name: '青冥剑阁', category: 'location', importance: 2, summary: '废弃剑阁' }] })
      if (request.prompt.includes('一句话摘要')) return JSON.stringify({ logline: '少女携断剑下山。', premise: '……', genre: '武侠', volumes: [{ title: '全书', from: 1, to: 3 }] })
      if (request.prompt.includes('文体学者')) return JSON.stringify({ name: 'x', pov: 'third-limited', tone: '冷峻', rules: ['短句'], avoid: ['抒情'] })
      if (request.prompt.includes('所有画面共用的画风')) return JSON.stringify({ style: '冷色水墨，枯笔，雨雾', avoid: ['现代建筑'], why: '武侠，夜雨。' })
      // How the things of the world stand to each other: who lives where, from which chapter.
      if (request.prompt.includes('"ties"')) return JSON.stringify({ ties: [{ kind: 'resides', from: '沈璃', to: '青冥剑阁', since: 1 }], events: [{ name: '青冥剑阁', chapter: 1, kind: 'decline', what: '已是废阁' }] })
      return 'ok'
    }
    const result = await importManuscript(bed.core, bed.runtime, { text }, { origin: 'user' })
    expect(result).toMatchObject({ chapters: 3, volumes: 2, characters: 1, worldEntries: 1, digested: 3, ties: { added: 1, total: 1, events: 1 } })
    expect(result.failed).toEqual([])
    // Whoever carries the story and is seen in more than one chapter is read for how they grow.
    expect(result.growth).toEqual({ people: 1, stages: 1 })
    expect((await bed.runtime.project.findCharacter('沈璃'))!.stages).toMatchObject([{ title: '下山时', age: '十六岁（少年）' }])
    // A book that arrives written can be walked: its people stand in its places from the first look.
    expect((await project.ties()).map(tie => `${tie.kind}:${tie.from.id}>${tie.to.id}:${tie.since ?? ''}`)).toEqual([`resides:${(await project.findCharacter('沈璃'))!.id}>${(await project.findWorld('青冥剑阁'))!.id}:ch001`])
    expect((await project.findWorld('青冥剑阁'))!.events).toEqual([{ chapter: 'ch001', kind: 'decline', what: '已是废阁' }])
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

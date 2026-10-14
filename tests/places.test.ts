// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Mending by places: what a review found is mended where it costs the text least — the planner names the places, the
 * writer rewrites those and nothing else, and each comes back as a change of its own. No chapter is written again for
 * a problem unless that is asked for, or the planner says places will not do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acceptProposal, fixIssue, fixIssues, reviseBook } from '../src/core/pipelines/revise'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const ONE = '她是左撇子，从小如此。\n\n师父教她用左手握剑。'
const TWO = '她右手握着剑下了山。\n\n山下是盛夏，蝉叫得人心烦。\n\n她在茶棚歇了一夜。'
const THREE = '渡口没有人。\n\n她用右手解开缆绳。'

describe('mending by places', () => {
  let bed: TestBed
  // (The careful reach — the least change — is what these hold to; the bolder one, which is the default, is in reach.test.ts.)
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥' })
    await bed.core.settings.update({ mendReach: 'careful' })
  })
  afterEach(async () => { await bed.cleanup() })

  const book = async (): Promise<{ one: string; two: string; three: string }> => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山' })
    const three = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(one.id, ONE)
    await project.saveChapterText(two.id, TWO)
    await project.saveChapterText(three.id, THREE)
    return { one: one.id, two: two.id, three: three.id }
  }
  const planner = (request: LlmRequest): boolean => request.prompt.includes('责任编辑')
  /** The passage a writer was handed to rewrite. */
  const passage = (request: LlmRequest): string => /<<<\n([\s\S]*?)\n>>>/.exec(request.prompt)?.[1] ?? ''

  it('a problem traced through the book changes a place in each chapter it reaches — small proposals, not chapters written again', async () => {
    const { project } = bed.runtime
    const ids = await book()
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'high', type: 'continuity', explanation: '第一章写她是左撇子，这一章却用右手。' }] })
    bed.llm.responder = (request) => {
      if (planner(request)) return JSON.stringify({ edits: [{ chapter: 2, find: '她右手握着剑下了山。', how: '右手改成左手' }, { chapter: 3, find: '她用右手解开缆绳。', how: '也改成左手' }], chapters: [], note: '惯用手三章一致。' })
      return passage(request).replace('右手', '左手')
    }
    const result = await fixIssue(bed.core, bed.runtime, { chapter: ids.two, issue: 'i1', scope: 'book' }, task)
    expect(result.scope).toBe('book')
    const scope = bed.llm.requests.find(planner)!.prompt
    // Asked to trace it, and for the bible as well; the chapter it was found in goes along whole.
    for (const part of ['把牵连查清', '"bible"', '"edits"', '### 第 2 章《下山》', '山下是盛夏，蝉叫得人心烦。']) expect(scope, part).toContain(part)
    expect(result.book!.results.map(item => [item.index, item.kind, item.reason])).toEqual([[2, 'span', '右手改成左手'], [3, 'span', '也改成左手']])
    expect(result.book!.untouched).toBe(1)
    // Two writers, each handed one place: nobody wrote a chapter.
    const writers = bed.llm.requests.filter(request => !planner(request))
    expect(writers.map(passage).sort()).toEqual(['她右手握着剑下了山。', '她用右手解开缆绳。'].sort())
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => [item.chapterId, item.kind, item.before, item.after, item.batchId === result.book!.batchId]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))).toEqual([
      [ids.two, 'span', '她右手握着剑下了山。', '她左手握着剑下了山。', true],
      [ids.three, 'span', '她用右手解开缆绳。', '她用左手解开缆绳。', true],
    ])
    // The one in the issue's own chapter says which issue it mends; both show beneath it by the batch.
    expect(waiting.find(item => item.chapterId === ids.two)!.issues).toEqual(['i1'])
    expect((await project.review(ids.two))!.issues[0]!.mending).toBe(result.book!.batchId)
    expect(await project.chapterText(ids.two)).toBe(TWO)
  })

  it('a problem mended at its cheapest place may be mended in another chapter than it was found in', async () => {
    const { project } = bed.runtime
    const ids = await book()
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'high', type: 'continuity', explanation: '第一章写她是左撇子，这一章和下一章都用右手。' }] })
    // Two chapters say the right hand, one says the left: the one is the place to change.
    bed.llm.responder = (request) => {
      if (planner(request)) return JSON.stringify({ edits: [{ chapter: 1, find: '她是左撇子，从小如此。\n\n师父教她用左手握剑。', how: '改成右撇子、右手握剑：后两章都是右手' }], note: '改第一章一处，比改后两章省。' })
      return '她惯用右手，从小如此。\n\n师父教她用右手握剑。'
    }
    const result = await fixIssue(bed.core, bed.runtime, { chapter: ids.two, issue: 'i1', scope: 'passage' }, task)
    expect(result.scope).toBe('places')
    expect(bed.llm.requests.find(planner)!.prompt).toContain('它可以不在发现问题的那一章')
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    // One change, in chapter 1 — and it says which issue it is for, though that issue is chapter 2's.
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ chapterId: ids.one, kind: 'span', issues: ['i1'], batchId: result.book!.batchId })

    // What a review quotes is where the problem shows: asked to settle the place, the planner is not held to it —
    // while the quoted place itself is rewritten, by the writer alone, when that is what is asked.
    await project.saveReview({ chapterId: ids.three, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'q1', severity: 'high', type: 'timeline', quote: '渡口没有人。', explanation: '上一章她歇了一夜，这里却像当天。' }] })
    const before = bed.llm.requests.length
    bed.llm.responder = (request) => {
      if (planner(request)) return JSON.stringify({ edits: [{ chapter: 2, find: '她在茶棚歇了一夜。', how: '改成只歇了一盏茶的工夫' }], note: '改上一章这一句最省。' })
      return '她在茶棚歇了一盏茶的工夫。'
    }
    const settled = await fixIssue(bed.core, bed.runtime, { chapter: ids.three, issue: 'q1', scope: 'place' }, task)
    expect(settled.scope).toBe('places')
    expect(bed.llm.requests.slice(before).find(planner)!.prompt).toContain('原文："渡口没有人。"')
    expect((await project.proposals()).find(item => item.id === settled.book!.results[0]!.proposalId)).toMatchObject({ chapterId: ids.two, before: '她在茶棚歇了一夜。', issues: ['q1'] })
    bed.llm.responder = () => '渡口空着，天刚亮。'
    const quoted = await fixIssue(bed.core, bed.runtime, { chapter: ids.three, issue: 'q1', scope: 'passage' }, task)
    expect(quoted.scope).toBe('passage')
    expect(quoted.passage).toMatchObject({ before: '渡口没有人。', after: '渡口空着，天刚亮。' })
  })

  it('a batch is read together: several places of one chapter one after the other, a chapter written over only where the planner says so, and what cannot be used is sent back', async () => {
    const { project } = bed.runtime
    const ids = await book()
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [
      { id: 'b1', severity: 'high', type: 'continuity', explanation: '第一章写她是左撇子。' },
      { id: 'b2', severity: 'medium', type: 'timeline', explanation: '上一章还是雪天，这里成了盛夏。' },
    ] })
    await project.saveReview({ chapterId: ids.three, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'c1', severity: 'high', type: 'pacing', explanation: '整章太赶。' }] })
    let asked = 0
    bed.llm.responder = (request) => {
      if (planner(request)) {
        asked += 1
        // First: two places that overlap, one that takes in the whole chapter's worth, one in a chapter there is not.
        if (asked === 1) return JSON.stringify({ edits: [{ chapter: 2, find: '她右手握着剑下了山。', how: '改左手' }, { chapter: 2, find: '握着剑下了山。', how: '同一句' }, { chapter: 9, find: '没有这一章', how: 'x' }], chapters: [] })
        return JSON.stringify({ edits: [{ chapter: 2, find: '山下是盛夏，蝉叫得人心烦。', how: '改成初春' }, { chapter: 2, find: '她右手握着剑下了山。', how: '改左手' }], chapters: [{ index: 3, reason: '整章放慢' }], note: '第三章要整章放慢。' })
      }
      if (request.prompt.includes('本章现有正文') && passage(request) === '') return '渡口没有人。\n\n她站了很久，才用左手解开缆绳。'
      return passage(request).includes('盛夏') ? '山下是初春，风还凉。' : '她左手握着剑下了山。'
    }
    const result = await fixIssues(bed.core, bed.runtime, { atLeast: 'medium', note: '动得越少越好' }, task)
    expect(result).toMatchObject({ issues: 3, chapters: 2 })
    const planners = bed.llm.requests.filter(planner)
    expect(planners).toHaveLength(2)
    for (const part of ['edits 第 2 条：和前面的一条在第 2 章里重叠', 'edits 第 3 条：第 9 章不在这次能改的章节里', '把整个结果重新交一次']) expect(planners[1]!.prompt, part).toContain(part)
    for (const part of ['发现了下面 3 个问题', '一处改动能同时解决几个问题的，就只改那一处', '作者对这一批的总要求（以此为准）：动得越少越好', '### 第 3 章《渡口》\n\n渡口没有人。']) expect(planners[0]!.prompt, part).toContain(part)
    // Two places of chapter 2, top to bottom, and chapter 3 written over.
    expect(result.book!.results.map(item => [item.index, item.kind])).toEqual([[2, 'span'], [2, 'span'], [3, 'chapter']])
    const spans = bed.llm.requests.filter(request => !planner(request) && passage(request) !== '')
    expect(spans.map(passage)).toEqual(['她右手握着剑下了山。', '山下是盛夏，蝉叫得人心烦。'])
    // The writer of a place knows what is being mended in its chapter, and is handed the one place.
    for (const part of ['这一章正在修下面的问题（你只改交给你的那一处；别的地方另有安排）', '第一章写她是左撇子', '上一章还是雪天', '动得越少越好', '这一次只改下面这一处：能动的只有这一处里的字，它前后的正文不会变。策划定的改法：改左手', '改法没有提到的字句照原样交回']) expect(spans[0]!.prompt, part).toContain(part)
    expect(spans[0]!.prompt).not.toContain('这一次一起改掉')
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => [item.chapterId === ids.two ? 2 : 3, item.kind, [...(item.issues ?? [])].sort()]).sort()).toEqual([[2, 'span', ['b1', 'b2']], [2, 'span', ['b1', 'b2']], [3, 'chapter', ['c1']]])
  })

  it('a place is all that may change and is found once only; what comes back is the sentences that changed, where they stood', async () => {
    const { project } = bed.runtime
    const ids = await book()
    const FOUR = '她推门进来。柳先生头也不抬。灯芯跳了一下。\n\n她点头。\n\n过了很久，她点头。'
    const four = await project.addChapter({ title: '夜访' })
    await project.saveChapterText(four.id, FOUR)
    await project.saveReview({ chapterId: four.id, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'n1', severity: 'medium', type: 'character', explanation: '柳先生对夜里上门的人太不设防。' }] })
    let asked = 0
    bed.llm.responder = (request) => {
      if (planner(request)) {
        asked += 1
        // A sentence that stands twice in the chapter names no place.
        if (asked === 1) return JSON.stringify({ edits: [{ chapter: 4, find: '她点头。', how: '改成摇头' }] })
        return JSON.stringify({ edits: [{ chapter: 4, find: '她推门进来。柳先生头也不抬。灯芯跳了一下。', how: '让他先搁下镊子再抬头' }], note: '只动他抬头那一句。' })
      }
      // The writer hands the place back whole, one sentence of the three changed.
      return '她推门进来。柳先生把镊子搁下，才抬头。灯芯跳了一下。'
    }
    const result = await fixIssue(bed.core, bed.runtime, { chapter: four.id, issue: 'n1', scope: 'place' }, task)
    const planners = bed.llm.requests.filter(planner)
    expect(planners).toHaveLength(2)
    for (const part of ['写手只能改它里面的字，出不了这个圈', '它在这一章里要只对得上一处']) expect(planners[0]!.prompt, part).toContain(part)
    for (const part of ['edits 第 1 条：这段原文在第 4 章里出现了 2 次，定不了是哪一处', '把整个结果重新交一次']) expect(planners[1]!.prompt, part).toContain(part)
    const writer = bed.llm.requests.find(request => !planner(request))!
    expect(passage(writer)).toBe('她推门进来。柳先生头也不抬。灯芯跳了一下。')
    for (const part of ['能动的只有这一处里的字，它前后的正文不会变', '改法没有提到的字句照原样交回']) expect(writer.prompt, part).toContain(part)
    // Of the three sentences handed over, the proposal is the one that changed — and it knows where it stood.
    expect(result.book!.results).toHaveLength(1)
    const proposal = (await project.proposals()).find(item => item.id === result.book!.results[0]!.proposalId)!
    expect(proposal).toMatchObject({ kind: 'span', before: '柳先生头也不抬。', after: '柳先生把镊子搁下，才抬头。', at: FOUR.indexOf('柳先生头也不抬。'), issues: ['n1'] })
    await acceptProposal(bed.core, bed.runtime, proposal.id, task)
    expect(await project.chapterText(four.id)).toBe(FOUR.replace('柳先生头也不抬。', '柳先生把镊子搁下，才抬头。'))
    expect(await project.chapterText(ids.one)).toBe(ONE)
  })

  it('a change of words that stand in two places is made where it was meant', async () => {
    const { project } = bed.runtime
    const text = '她点头。\n\n灯芯跳了一下。\n\n过了很久，她点头。'
    const chapter = await project.addChapter({ title: '夜访' })
    await project.saveChapterText(chapter.id, text)
    const second = await project.addProposal({ chapterId: chapter.id, kind: 'span', instruction: '后一处改成摇头', before: '她点头。', after: '她摇头。', at: text.lastIndexOf('她点头。'), createdBy: 'user' })
    await acceptProposal(bed.core, bed.runtime, second.id, task)
    expect(await project.chapterText(chapter.id)).toBe('她点头。\n\n灯芯跳了一下。\n\n过了很久，她摇头。')
    // Without a place, the first is taken — as before.
    const first = await project.addProposal({ chapterId: chapter.id, kind: 'span', instruction: '改成不动', before: '她', after: '柳先生', createdBy: 'user' })
    await acceptProposal(bed.core, bed.runtime, first.id, task)
    expect(await project.chapterText(chapter.id)).toBe('柳先生点头。\n\n灯芯跳了一下。\n\n过了很久，她摇头。')
  })

  it('what the author asks of the whole book is done by places too, and only in the chapters they named', async () => {
    const { project } = bed.runtime
    const ids = await book()
    bed.llm.responder = (request) => {
      if (planner(request)) return JSON.stringify({ edits: [{ chapter: 1, find: '师父教她用左手握剑。', how: '剑改成刀' }, { chapter: 2, find: '她右手握着剑下了山。', how: '剑改成刀' }], chapters: [], note: '写到兵器的两句。' })
      return passage(request).replace('剑', '刀')
    }
    const result = await reviseBook(bed.core, bed.runtime, { instruction: '她用的兵器从剑改成刀', asked: true }, task)
    const plan = bed.llm.requests.find(planner)!.prompt
    // Asked as a request, not as a problem found; every chapter's text goes along (the book is small), and nothing is traced as a fault.
    for (const part of ['作者提出了一条针对全书的修改要求', '## 修改要求\n\n她用的兵器从剑改成刀', '这条要求碰到哪几句就改哪几句', '### 第 3 章《渡口》\n\n渡口没有人。', '要求本身就是通篇的（文风、语气、视角、节奏）']) expect(plan, part).toContain(part)
    for (const part of ['下面的问题要修', '作者只让动这几章']) expect(plan, part).not.toContain(part)
    expect(result.results.map(item => [item.index, item.kind])).toEqual([[1, 'span'], [2, 'span']])
    expect(result.untouched).toBe(1)
    expect(result.note).toBe('写到兵器的两句。')
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => [item.kind, item.before, item.after]).sort()).toEqual([['span', '她右手握着剑下了山。', '她右手握着刀下了山。'], ['span', '师父教她用左手握剑。', '师父教她用左手握刀。']])
    expect(await project.chapterText(ids.two)).toBe(TWO)

    // Named chapters: the planner sees those and may change no other — a place elsewhere is sent back.
    const before = bed.llm.requests.length
    let asked = 0
    bed.llm.responder = (request) => {
      if (planner(request)) {
        asked += 1
        if (asked === 1) return JSON.stringify({ edits: [{ chapter: 2, find: '她用右手解开缆绳。', how: '左手' }] })
        return JSON.stringify({ edits: [{ chapter: 3, find: '她用右手解开缆绳。', how: '左手' }] })
      }
      return passage(request).replace('右手', '左手')
    }
    const named = await reviseBook(bed.core, bed.runtime, { instruction: '她是左撇子', asked: true, chapters: [ids.three] }, task)
    const plans = bed.llm.requests.slice(before).filter(planner)
    expect(plans).toHaveLength(2)
    for (const part of ['（作者只让动这几章：第 3 章；别的章节不在范围里。）', '### 第 3 章《渡口》']) expect(plans[0]!.prompt, part).toContain(part)
    for (const part of ['### 第 2 章《下山》', '### 第 1 章《雨夜》']) expect(plans[0]!.prompt, part).not.toContain(part)
    expect(plans[1]!.prompt).toContain('edits 第 1 条：第 2 章不在这次能改的章节里')
    expect(named.results.map(item => [item.index, item.kind])).toEqual([[3, 'span']])
    expect(named.untouched).toBe(0)
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Mending by places: what a review found is mended where it costs the text least — the planner names the places, the
 * writer rewrites those and nothing else, and each comes back as a change of its own. No chapter is written again for
 * a problem unless that is asked for, or the planner says places will not do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixIssue, fixIssues } from '../src/core/pipelines/revise'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const ONE = '她是左撇子，从小如此。\n\n师父教她用左手握剑。'
const TWO = '她右手握着剑下了山。\n\n山下是盛夏，蝉叫得人心烦。\n\n她在茶棚歇了一夜。'
const THREE = '渡口没有人。\n\n她用右手解开缆绳。'

describe('mending by places', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '青冥' }) })
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
    for (const part of ['edits 第 2 条：和前面的一条在第 2 章里重叠', 'edits 第 3 条：没有第 9 章', '把整个结果重新交一次']) expect(planners[1]!.prompt, part).toContain(part)
    for (const part of ['发现了下面 3 个问题', '一处改动能同时解决几个问题的，就只改那一处', '作者对这一批的总要求（以此为准）：动得越少越好', '### 第 3 章《渡口》\n\n渡口没有人。']) expect(planners[0]!.prompt, part).toContain(part)
    // Two places of chapter 2, top to bottom, and chapter 3 written over.
    expect(result.book!.results.map(item => [item.index, item.kind])).toEqual([[2, 'span'], [2, 'span'], [3, 'chapter']])
    const spans = bed.llm.requests.filter(request => !planner(request) && passage(request) !== '')
    expect(spans.map(passage)).toEqual(['她右手握着剑下了山。', '山下是盛夏，蝉叫得人心烦。'])
    // The writer of a place knows what is being mended in its chapter, and is handed the one place.
    for (const part of ['这一章正在修下面的问题（你只改交给你的那一处；别的地方另有安排）', '第一章写她是左撇子', '上一章还是雪天', '动得越少越好', '这一次只改下面这一处。策划定的改法：改左手']) expect(spans[0]!.prompt, part).toContain(part)
    expect(spans[0]!.prompt).not.toContain('这一次一起改掉')
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => [item.chapterId === ids.two ? 2 : 3, item.kind, [...(item.issues ?? [])].sort()]).sort()).toEqual([[2, 'span', ['b1', 'b2']], [2, 'span', ['b1', 'b2']], [3, 'chapter', ['c1']]])
  })
})

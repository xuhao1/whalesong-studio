// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A review hands what it found on to be mended (`reviewMends`): the open issues nobody was handed yet go to the
 * planner together, in a job of its own, and every change waits as a proposal for the issues it mends — after one
 * chapter's review, and once for all of a batch's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBatch, textPlan } from '../src/core/pipelines/batch'
import { reviewChapter } from '../src/core/pipelines/review'
import { MEND_REVIEW_JOB, mendReviewed, reviewMends, unmended } from '../src/core/pipelines/revise'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const ONE = '她生来是左撇子，从小如此。'
const TWO = '她右手握着剑下了山。那是盛夏。'

describe('what a review finds goes on to be mended', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  // (Both are told they read as an editor: the reviewer is the one asked for a verdict.)
  const reviewer = (request: LlmRequest): boolean => request.prompt.includes('"verdict"')
  const planner = (request: LlmRequest): boolean => request.prompt.includes('责任编辑') && !reviewer(request)
  const book = async (): Promise<{ one: string; two: string }> => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山' })
    await project.saveChapterText(one.id, ONE)
    await project.saveChapterText(two.id, TWO)
    return { one: one.id, two: two.id }
  }
  /** A reviewer that finds the wrong hand in chapter 2 and nothing in chapter 1; a planner that has chapter 2 rewritten. */
  const crew = (): void => {
    bed.llm.responder = (request) => {
      if (reviewer(request)) {
        return request.prompt.includes(TWO)
          ? JSON.stringify({ verdict: '惯用手写反了。', issues: [{ severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章写她是左撇子。', suggestion: '改成左手' }, { severity: 'low', type: 'language', quote: '那是盛夏', explanation: '这句突兀。' }] })
          : JSON.stringify({ verdict: '没有问题。', issues: [] })
      }
      if (planner(request)) return JSON.stringify({ chapters: [{ index: 2, reason: '右手改左手' }], note: '惯用手前后一致。' })
      return '她左手握着剑下了山。时值盛夏。'
    }
  }
  const mendJobs = () => bed.core.jobs.list(bed.runtime.project.root).filter(job => job.kind === 'revise' && job.title === MEND_REVIEW_JOB)
  const settled = async (): Promise<void> => {
    for (let turn = 0; turn < 400 && mendJobs().some(job => job.status === 'running'); turn++) await new Promise(resolve => setTimeout(resolve, 5))
  }

  it('is so unless the author switched it off, and whoever asks for one review may say otherwise', async () => {
    await bed.core.settings.update({ reviewMends: undefined as never })
    expect(reviewMends(bed.core)).toBe(true)
    expect(reviewMends(bed.core, false)).toBe(false)
    await bed.core.settings.update({ reviewMends: false })
    expect(reviewMends(bed.core)).toBe(false)
    expect(reviewMends(bed.core, true)).toBe(true)
  })

  it('hands the open issues of the chapter reviewed to one mending — a job of its own — and each change waits for the issues it mends', async () => {
    const { project } = bed.runtime
    const ids = await book()
    crew()
    const review = await reviewChapter(bed.core, bed.runtime, { chapter: ids.two }, task)
    expect(review.issues).toHaveLength(2)
    // Nothing was handed over by the review itself: the text and the issues are as the review left them.
    expect(bed.llm.requests.filter(planner)).toHaveLength(0)
    expect(await unmended(bed.runtime, [ids.two])).toEqual(review.issues.map(issue => ({ chapter: ids.two, issue: issue.id })))

    const started = await mendReviewed(bed.core, bed.runtime, [ids.two], task)
    expect(started).toMatchObject({ issues: 2 })
    expect(mendJobs().map(job => [job.id, job.target, job.origin])).toEqual([[started!.jobId, ids.two, 'user']])
    await settled()
    expect(mendJobs()[0]).toMatchObject({ status: 'done', result: { output: { issues: 2, chapters: 1, places: 1, failed: 0, note: '惯用手前后一致。' } } })

    // One run of the planner, told of both issues side by side.
    const asked = bed.llm.requests.filter(planner)
    expect(asked).toHaveLength(1)
    for (const part of ['发现了下面 2 个问题', '第一章写她是左撇子', '审校的建议：改成左手', '这句突兀']) expect(asked[0]!.prompt, part).toContain(part)
    // The change waits as a proposal for both issues; the text is as it was, and the issues say they were handed over.
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting).toHaveLength(1)
    expect([...(waiting[0]!.issues ?? [])].sort()).toEqual(review.issues.map(issue => issue.id).sort())
    expect(await project.chapterText(ids.two)).toBe(TWO)
    const after = (await project.review(ids.two))!
    expect(after.issues.every(issue => issue.mending === waiting[0]!.batchId && issue.resolved !== true)).toBe(true)

    // Handed over once: a second asking finds nothing that waits, and starts nothing.
    expect(await unmended(bed.runtime, [ids.two])).toEqual([])
    expect(await mendReviewed(bed.core, bed.runtime, [ids.two], task)).toBeUndefined()
    expect(mendJobs()).toHaveLength(1)
  })

  it('starts nothing where the review found nothing, or what it found is settled', async () => {
    const { project } = bed.runtime
    const ids = await book()
    crew()
    await reviewChapter(bed.core, bed.runtime, { chapter: ids.one }, task)
    expect(await mendReviewed(bed.core, bed.runtime, [ids.one], task)).toBeUndefined()
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'b1', severity: 'high', type: 'logic', explanation: '早就处理过的。', resolved: true }] })
    expect(await mendReviewed(bed.core, bed.runtime, [ids.one, ids.two], task)).toBeUndefined()
    expect(mendJobs()).toHaveLength(0)
  })

  it('mends what a batch of reviews found once, when the batch is over — where the batch was asked to', async () => {
    const { project } = bed.runtime
    const ids = await book()
    crew()
    // Not asked to: the chapters are reviewed, and nothing follows.
    const plain = await runBatch(await textPlan(bed.core, bed.runtime, { steps: ['review'], chapters: [ids.one, ids.two] }), task, 'zh')
    expect(plain.done).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mendJobs()).toHaveLength(0)
    expect(bed.llm.requests.filter(planner)).toHaveLength(0)

    // Asked to: reviewed again, and then one mending for everything the two reviews found.
    const mended = await runBatch(await textPlan(bed.core, bed.runtime, { steps: ['review'], chapters: [ids.one, ids.two], redo: true, mend: true }), task, 'zh')
    expect(mended.done).toBe(2)
    expect(mendJobs()).toHaveLength(1)
    await settled()
    expect(mendJobs()[0]).toMatchObject({ status: 'done', result: { output: { issues: 2, chapters: 1, places: 1 } } })
    expect(bed.llm.requests.filter(planner)).toHaveLength(1)
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => item.chapterId)).toEqual([ids.two])
    expect(await project.chapterText(ids.two)).toBe(TWO)
  })
})

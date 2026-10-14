// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A review hands what it found on to be mended (`reviewMends`). The reviewer closes what it can of its own chapter —
 * a small change it writes out is the proposal as it stands, a passage it describes goes to the writer; what takes a
 * change in another chapter goes to the planner; what is the author's to decide waits for the author. A job of its
 * own, after one chapter's review and once for all of a batch's — and every change waits beneath the issue it mends.
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
  // (Both are told they read as an editor: the reviewer is the one asked for a verdict.)
  const writerAsked = (request: LlmRequest): boolean => request.route.for?.role === 'writer'
  /**
   * A reviewer that finds four things in chapter 2 and nothing in chapter 1: the wrong hand (a word to put right — it
   * writes the change itself), a bare sentence (a passage — it says how, for the writer), a season that does not
   * agree with chapter 1 (another chapter's to change — the planner's), and an ending that is the author's to decide.
   * A planner that changes the other end; a writer that writes the passage.
   */
  const crew = (): void => {
    bed.llm.responder = (request) => {
      if (reviewer(request)) {
        return request.prompt.includes(`### 本章正文\n${TWO}`)
          ? JSON.stringify({ verdict: '惯用手写反了。', issues: [
            { severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章写她是左撇子。', suggestion: '改成左手', against: { kind: 'chapter', ref: '1', quote: '她生来是左撇子' }, find: '她右手握着剑下了山。', replace: '她左手握着剑下了山。' },
            { severity: 'low', type: 'style', quote: '那是盛夏。', explanation: '这句突兀', find: '那是盛夏。', how: '写成一小段山下的暑气，蝉声、热浪' },
            { severity: 'medium', type: 'timeline', explanation: '第一章没交代季节，这里忽然是盛夏。', against: { kind: 'chapter', ref: '1', quote: '从小如此' }, wider: true },
            { severity: 'low', type: 'pacing', explanation: '结尾要不要留一个钩子，看作者的打算。' },
          ] })
          : JSON.stringify({ verdict: '没有问题。', issues: [] })
      }
      if (planner(request)) return JSON.stringify({ edits: [{ chapter: 1, find: '从小如此。', replace: '从小如此。那年夏天来得早。', why: '先把季节交代了' }], chapters: [], note: '季节在第一章补一句。' })
      return '山下是盛夏，蝉叫得人心烦，热浪贴着石阶往上涌。'
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

  it('has the reviewer close what it can: its own small change is the proposal as it stands, a passage goes to the writer, what reaches another chapter to the planner — and what is the author\'s waits', async () => {
    const { project } = bed.runtime
    const ids = await book()
    crew()
    await bed.core.settings.update({ mendBy: 'auto', models: { writer: { provider: 'p', model: 'writer-model' }, analyst: { provider: 'p', model: 'crew-model' }, architect: { provider: 'p', model: 'crew-model' } } as never })
    const review = await reviewChapter(bed.core, bed.runtime, { chapter: ids.two, mends: 'auto' }, task)
    expect(review.issues).toHaveLength(4)
    const [hand, season, bare, ending] = [review.issues.find(issue => issue.quote === '右手握着剑')!, review.issues.find(issue => issue.type === 'timeline')!, review.issues.find(issue => issue.quote === '那是盛夏。')!, review.issues.find(issue => issue.type === 'pacing')!]
    // What each says of how it is closed is kept on it; what it rests on, too — looked for in chapter 1 when it was filed.
    expect(hand).toMatchObject({ fix: { find: '她右手握着剑下了山。', replace: '她左手握着剑下了山。' }, against: { kind: 'chapter', ref: '1', quote: '她生来是左撇子' } })
    expect(bare.fix).toEqual({ find: '那是盛夏。', how: '写成一小段山下的暑气，蝉声、热浪' })
    expect(season).toMatchObject({ wider: true })
    expect(season.fix).toBeUndefined()
    expect([ending.fix, ending.wider]).toEqual([undefined, undefined])
    // The review itself changed nothing and proposed nothing: one request, the reviewer's.
    expect(bed.llm.requests).toHaveLength(1)
    expect(await project.proposals()).toEqual([])
    expect((await unmended(bed.runtime, [ids.two], 'closing')).map(item => item.issue).sort()).toEqual([hand.id, bare.id].sort())
    expect((await unmended(bed.runtime, [ids.two], 'wider')).map(item => item.issue)).toEqual([season.id])
    // What the reviewer was asked: how an issue is closed, three ways, and to say what it is at odds with.
    for (const part of ['了结：每条问题三种里给一种', '你直接写：find 是这一章里要被换掉的原文', '交给写手，不写 replace', '加 "wider": true：策划会接着去查该改哪一头', '该由作者拿主意的', '取证：拿这一章和别处对照得出的问题']) expect(bed.llm.requests[0]!.prompt, part).toContain(part)

    const started = await mendReviewed(bed.core, bed.runtime, [ids.two], task)
    // Three issues are handed on: the two the reviewer closes, and the one the planner traces. The fourth is the author's.
    expect(started).toMatchObject({ issues: 3 })
    expect(mendJobs().map(job => [job.id, job.target, job.origin])).toEqual([[started!.jobId, ids.two, 'user']])
    await settled()
    expect(mendJobs()[0]).toMatchObject({ status: 'done', result: { output: { issues: 3, places: 3, failed: 0, wrote: { analyst: 1, planner: 1, writer: 1 }, note: '季节在第一章补一句。' } } })

    // Who was asked: the writer once, for the passage — handed the place, what stands around it and what the reviewer
    // said of it, nothing of the book gathered again — and the planner once, for the one issue that reaches chapter 1.
    const after = bed.llm.requests.slice(1)
    expect(after.filter(writerAsked)).toHaveLength(1)
    expect(after.filter(planner)).toHaveLength(1)
    const written = after.find(writerAsked)!
    for (const part of ['交办的人已经查过设定和前文', '审校定的改法：写成一小段山下的暑气，蝉声、热浪', '那是盛夏。']) expect(written.prompt, part).toContain(part)
    expect(written.prompt).not.toContain('## 设定')
    const traced = after.find(planner)!
    // The planner is told the one issue, what it rests on, and has both chapters before it: the one it was found in and the one it is at odds with.
    // It goes on from what the reviewer closed: chapter 2 is before it as it would read with those changes in, they
    // are named as waiting, and it is told so — nothing is proposed for those sentences a second time.
    for (const part of [
      '发现了下面 1 个问题', '第一章没交代季节', '它对不上的是（已核对过原处）：第 1 章：“从小如此”',
      '### 第 2 章《下山》\n\n她左手握着剑下了山。山下是盛夏，蝉叫得人心烦，热浪贴着石阶往上涌。', `### 第 1 章《雨夜》\n\n${ONE}`,
      '## 已经在案的', '等着作者确认的改动（它圈住的句子不再圈；要改得不一样才圈进来——那会取代它）', '上面给出的正文已经带着那些等着的改动',
    ]) expect(traced.prompt, part).toContain(part)
    // What is steady stands first, what is asked last: the book's base, the story so far, the text — then this piece of work.
    const order = ['# 《七日未寄》', '## 前情', '## 章节正文', '## 已经在案的', '## 要修的问题', '只输出 JSON'].map(part => traced.prompt.indexOf(part))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)

    // Three changes wait, each beneath the issue it is for, each saying whose words it is; the text is as it was.
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => [item.chapterId, item.before, item.after, item.wroteBy, item.issues]).sort((left, right) => String(left[1]).localeCompare(String(right[1])))).toEqual([
      // (Made in another chapter than the issue was found in: it is the issue's by its batch, and shown beneath it so.)
      [ids.one, '从小如此。', '从小如此。那年夏天来得早。', 'planner', undefined],
      [ids.two, '她右手握着剑下了山。', '她左手握着剑下了山。', 'analyst', [hand.id]],
      [ids.two, '那是盛夏。', '山下是盛夏，蝉叫得人心烦，热浪贴着石阶往上涌。', 'writer', [bare.id]],
    ].sort((left, right) => String(left[1]).localeCompare(String(right[1]))))
    expect(await project.chapterText(ids.two)).toBe(TWO)
    const now = (await project.review(ids.two))!
    expect(now.issues.filter(issue => issue.mending !== undefined).map(issue => issue.id).sort()).toEqual([hand.id, season.id, bare.id].sort())
    expect(now.issues.find(issue => issue.id === ending.id)!.mending).toBeUndefined()

    // Handed over once: a second asking finds nothing that waits to be handed on, and starts nothing.
    expect(await mendReviewed(bed.core, bed.runtime, [ids.two], task)).toBeUndefined()
    expect(mendJobs()).toHaveLength(1)
  })

  it('lists what it found and nothing more where the author has reviews only review', async () => {
    const ids = await book()
    crew()
    const review = await reviewChapter(bed.core, bed.runtime, { chapter: ids.two }, task)
    // Not asked how to close anything: the task says nothing of it.
    expect(bed.llm.requests[0]!.prompt).not.toContain('了结：')
    expect(bed.llm.requests[0]!.prompt).toContain('取证：')
    expect(review.issues).toHaveLength(4)
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
    await bed.core.settings.update({ mendBy: 'auto' })
    const mended = await runBatch(await textPlan(bed.core, bed.runtime, { steps: ['review'], chapters: [ids.one, ids.two], redo: true, mend: true }), task, 'zh')
    expect(mended.done).toBe(2)
    expect(mendJobs()).toHaveLength(1)
    await settled()
    expect(mendJobs()[0]).toMatchObject({ status: 'done', result: { output: { issues: 3, places: 3, wrote: { analyst: 1, planner: 1, writer: 1 } } } })
    expect(bed.llm.requests.filter(planner)).toHaveLength(1)
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => item.chapterId).sort()).toEqual([ids.one, ids.two, ids.two].sort())
    expect(await project.chapterText(ids.two)).toBe(TWO)
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { digestChapter } from '../src/core/pipelines/digest'
import { FOLLOW_JOB, followTiming, plansOfText, schedulePlanFollow } from '../src/core/pipelines/follow'
import { planReadFrom } from '../src/core/pipelines/plot'
import { acceptProposal } from '../src/core/pipelines/revise'
import { hashText } from '../src/shared/text'
import { createTestBed, type TestBed } from './support/harness'

const DIGEST = JSON.stringify({
  brief: '沈璃下山。',
  summary: '沈璃带着断剑下山。',
  characters: [{ name: '沈璃', role: '下山', stateAfter: '在路上' }],
  facts: [],
  newEntities: [],
  threads: [],
})

/** What the continuity editor hands in for a chapter's plan, by what its text says. */
// (The request carries the plan there was, and a line of the chapters beside this one, after the text: only the text is looked at.)
const textOf = (prompt: string): string => prompt.split('## 原来的章纲')[0]!
const planFor = (prompt: string, asked = textOf(prompt)): string => asked.includes('渡口')
  ? JSON.stringify({ synopsis: '沈璃在渡口等船，船夫不肯渡她。', location: '渡口', beats: [{ summary: '在渡口等船' }, { summary: '船夫不肯渡她' }] })
  : asked.includes('卖伞的')
    ? JSON.stringify({ synopsis: '沈璃告别旧居；山门没有人拦她，她向卖伞的买了一把伞。', location: '旧居、山门', beats: [{ summary: '告别旧居' }, { summary: '山门无人，她向卖伞的买了一把伞' }] })
    : JSON.stringify({ synopsis: '沈璃告别旧居，在山门被师兄拦下。', beats: [{ summary: '告别旧居' }, { summary: '在山门被师兄拦下' }] })

describe('a plan that follows its text', () => {
  let bed: TestBed
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const was = followTiming.delay
  /** The requests that asked for a plan to be read off a text. */
  const plans = (): number => bed.llm.requests.filter(request => request.prompt.includes('章纲从正文重新读出来')).length
  const followed = (): number => bed.core.jobs.list(bed.runtime.project.root).filter(job => job.title === FOLLOW_JOB).length
  /** Until the jobs that follow have ended. */
  const settled = async (jobs: number): Promise<void> => {
    for (let n = 0; n < 200; n++) {
      const mine = bed.core.jobs.list(bed.runtime.project.root).filter(job => job.title === FOLLOW_JOB)
      if (mine.length >= jobs && mine.every(job => job.status !== 'running')) return
      await wait(10)
    }
    throw new Error('the plans were not read')
  }

  beforeEach(async () => {
    followTiming.delay = 5
    bed = await createTestBed({ settings: { planFollowsText: true } })
    bed.llm.responder = request => request.prompt.includes('章纲从正文重新读出来') ? planFor(request.prompt) : DIGEST
  })
  afterEach(async () => {
    followTiming.delay = was
    await bed.cleanup()
  })

  it('is read against the text once a chapter digested before is changed, and not twice from the same text', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist' })
    const chapter = await project.addChapter({ title: '下山', synopsis: '沈璃告别旧居，在山门被师兄拦下。', purpose: '把她送出山', beats: [{ id: 'b_keep', summary: '告别旧居' }, { id: 'b_gone', summary: '在山门被师兄拦下' }] })
    await project.saveChapterText(chapter.id, '她在旧居门口站了一会儿。\n\n师兄在山门拦住了她。')

    // A first digest leaves the plan be: it is what the chapter was written by.
    await digestChapter(bed.core, bed.runtime, chapter.id, { origin: 'user' })
    await wait(60)
    expect(plans()).toBe(0)
    expect(followed()).toBe(0)
    expect(await planReadFrom(project, chapter.id)).toBeUndefined()

    // The text is changed and the chapter digested again: its plan is read against what is there now.
    const changed = '她在旧居门口站了一会儿。\n\n山门没有人拦她。雨里只有一个卖伞的。'
    await project.saveChapterText(chapter.id, changed)
    await digestChapter(bed.core, bed.runtime, chapter.id, { origin: 'user' })
    await settled(1)
    expect(plans()).toBe(1)
    let plan = (await project.findChapter(chapter.id))!.plan
    expect(plan).toMatchObject({ synopsis: '沈璃告别旧居；山门没有人拦她，她向卖伞的买了一把伞。', location: '旧居、山门', purpose: '把她送出山' })
    // The beats too: the one that holds is the same beat, the one that was not written is gone.
    expect(plan.beats!.map(beat => [beat.id === 'b_keep', beat.summary])).toEqual([[true, '告别旧居'], [false, '山门无人，她向卖伞的买了一把伞']])
    expect(await planReadFrom(project, chapter.id)).toBe(hashText(changed))
    // Said where the author reads what changed the book, and on the job for the page to say; the plan as it was can be had again.
    const job = bed.core.jobs.list(project.root).find(found => found.title === FOLLOW_JOB)!
    expect(job).toMatchObject({ kind: 'derive', origin: 'user', status: 'done', target: chapter.id })
    expect(job.result).toMatchObject({ followed: 1, same: 0, failed: 0, chapters: [{ index: 1, changed: ['synopsis', 'location'], beats: 2, was: 2, kept: 1 }] })
    expect((await project.activity(5))[0]).toMatchObject({ by: 'crew', role: 'analyst', summary: expect.stringContaining('第 1 章（梗概、地点、节拍 2 个（原来 2 个））') })
    const versions = await project.history('plan', chapter.id)
    expect(((await project.historyOf('plan', chapter.id, versions[0]!.id)) as { synopsis: string }).synopsis).toBe('沈璃告别旧居，在山门被师兄拦下。')

    // Digested again with the text as it is — and the author's own hand in the plan since: nothing is read, nothing is started.
    await project.updateChapter(chapter.id, { synopsis: '作者自己改的梗概。' })
    await digestChapter(bed.core, bed.runtime, chapter.id, { origin: 'user' }, { force: true })
    await wait(80)
    expect(plans()).toBe(1)
    expect(followed()).toBe(1)
    expect((await project.findChapter(chapter.id))!.plan.synopsis).toBe('作者自己改的梗概。')

    // A change accepted: the plan follows it, also where chapters are not digested by themselves (as in this bed).
    const proposal = await project.addProposal({ chapterId: chapter.id, kind: 'chapter', instruction: '改到渡口', before: changed, after: '她在渡口等船。\n\n船夫不肯渡她。', createdBy: 'user' })
    await acceptProposal(bed.core, bed.runtime, proposal.id, { origin: 'user' })
    await settled(2)
    expect(plans()).toBe(2)
    plan = (await project.findChapter(chapter.id))!.plan
    expect(plan).toMatchObject({ synopsis: '沈璃在渡口等船，船夫不肯渡她。', location: '渡口' })
    expect(plan.beats!.map(beat => beat.summary)).toEqual(['在渡口等船', '船夫不肯渡她'])

    // Changes one after another are one job; and switched off, nothing follows.
    await project.saveChapterText(chapter.id, '她在渡口等船。\n\n船夫不肯渡她。雨里来了一个卖伞的。')
    schedulePlanFollow(bed.core, bed.runtime, chapter.id, { origin: 'user' })
    schedulePlanFollow(bed.core, bed.runtime, chapter.id, { origin: 'user' })
    await settled(3)
    expect(plans()).toBe(3)
    expect(followed()).toBe(3)
    await bed.core.settings.update({ planFollowsText: false })
    for (let n = 0; n < 40 && bed.core.currentSettings().planFollowsText !== false; n++) await wait(10)
    await project.saveChapterText(chapter.id, '她在渡口等船。')
    await digestChapter(bed.core, bed.runtime, chapter.id, { origin: 'user' })
    await wait(80)
    expect(plans()).toBe(3)
    expect(followed()).toBe(3)
  })

  it('sets the plans of several chapters by their texts in one go, leaving alone the ones already read from the text they have', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '下山', synopsis: '旧的梗概一。' })
    const two = await project.addChapter({ title: '渡口', synopsis: '旧的梗概二。' })
    const empty = await project.addChapter({ title: '还没写' })
    await project.saveChapterText(one.id, '山门没有人拦她。雨里只有一个卖伞的。')
    await project.saveChapterText(two.id, '她在渡口等船。船夫不肯渡她。')

    const first = await plansOfText(bed.core, bed.runtime, { chapters: [one.id] }, { origin: 'user' })
    expect(first).toMatchObject({ same: 0, failed: [], read: [{ chapterId: one.id, index: 1, changed: ['synopsis', 'location'], beats: 2, was: 0, kept: 0 }] })

    // Both asked for, with one that has no text: the one read just now is left alone, the unwritten one is nobody's to read.
    const both = await plansOfText(bed.core, bed.runtime, { chapters: [one.id, two.id, empty.id, one.id] }, { origin: 'user' })
    expect(both.same).toBe(1)
    expect(both.read.map(read => read.chapterId)).toEqual([two.id])
    expect(plans()).toBe(2)
    expect((await project.findChapter(two.id))!.plan.synopsis).toBe('沈璃在渡口等船，船夫不肯渡她。')
    expect((await project.findChapter(empty.id))!.plan.synopsis).toBeUndefined()

    // Asked to read them again whatever they were read from: both are.
    const again = await plansOfText(bed.core, bed.runtime, { chapters: [one.id, two.id], force: true }, { origin: 'user' })
    expect(again.read.map(read => read.index)).toEqual([1, 2])
    expect(again.same).toBe(0)
    expect(plans()).toBe(4)

    // One that cannot be read does not stop the others.
    bed.llm.responder = request => textOf(request.prompt).includes('渡口') ? '不是 JSON' : planFor(request.prompt)
    const partly = await plansOfText(bed.core, bed.runtime, { chapters: [one.id, two.id], force: true }, { origin: 'user' })
    expect(partly.read.map(read => read.index)).toEqual([1])
    expect(partly.failed).toHaveLength(1)
    expect(partly.failed[0]!.chapter).toBe(two.id)
  })
})

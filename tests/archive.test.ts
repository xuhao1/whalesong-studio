// SPDX-License-Identifier: LGPL-3.0-or-later
// What the author turned down is kept, can be read again, and can be put back: a no that was a slip is not the end of it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acceptProposal, rejectProposal, restoreProposal, settledProposals } from '../src/core/pipelines/revise'
import type { TaskContext } from '../src/core/core'
import { createTestBed, type TestBed } from './support/harness'

const TEXT = '雨下了一夜。\n\n门响了。阿棠站在门口。\n\n天亮的时候，雨停了。'

describe('the proposals that were settled', () => {
  let bed: TestBed
  let chapterId: string
  const task: TaskContext = { origin: 'user' }

  beforeEach(async () => {
    bed = await createTestBed({ title: '七日未寄' })
    chapterId = (await bed.runtime.project.addChapter({ title: '雨夜' })).id
    await bed.runtime.project.saveChapterText(chapterId, TEXT)
  })
  afterEach(async () => { await bed.cleanup() })

  const span = async (before: string, after: string, more: Record<string, unknown> = {}) => await bed.runtime.project.addProposal({ chapterId, kind: 'span', instruction: '改一处', before, after, createdBy: 'user', ...more })
  const statusOf = async (id: string) => (await bed.runtime.project.proposals()).find(proposal => proposal.id === id)?.status

  it('keeps one that was turned down, and puts it back to be taken after all', async () => {
    const proposal = await span('雨下了一夜。', '雨下了两夜。')
    expect((await bed.runtime.project.state()).turnedDown).toBeUndefined()
    await rejectProposal(bed.runtime, proposal.id)

    // Turned down: out of the ones that wait, and in the archive — with when, and whether it could still be taken.
    const state = await bed.runtime.project.state()
    expect(state.proposals).toHaveLength(0)
    expect(state.turnedDown).toBe(1)
    const archive = await settledProposals(bed.runtime)
    expect(archive.total).toBe(1)
    expect(archive.items[0]).toMatchObject({ id: proposal.id, status: 'rejected', stands: true, before: '雨下了一夜。', after: '雨下了两夜。' })
    expect(archive.items[0]!.settledAt).toBeDefined()
    expect((await settledProposals(bed.runtime, { what: 'accepted' })).total).toBe(0)
    // By chapter, named loosely as the showrunner names one.
    expect((await settledProposals(bed.runtime, { chapter: '1' })).total).toBe(1)

    // Put back: it waits again as if the no had not been said, and is taken like any other.
    const back = await restoreProposal(bed.runtime, proposal.id)
    expect(back.status).toBe('pending')
    expect(back.settledAt).toBeUndefined()
    expect((await bed.runtime.project.state()).turnedDown).toBeUndefined()
    expect((await settledProposals(bed.runtime)).total).toBe(0)
    await acceptProposal(bed.core, bed.runtime, proposal.id, task)
    expect(await bed.runtime.project.chapterText(chapterId)).toBe(TEXT.replace('雨下了一夜。', '雨下了两夜。'))
    // Accepted, it is in the other half of the archive — and there is nothing to put back.
    expect((await settledProposals(bed.runtime, { what: 'accepted' })).items.map(item => item.id)).toEqual([proposal.id])
    await expect(restoreProposal(bed.runtime, proposal.id)).rejects.toThrow(/accepted, not turned down/)
    await expect(restoreProposal(bed.runtime, 'pp_nobody')).rejects.toThrow(/no proposal/)
  })

  it('says of one whose sentences are gone that it cannot be taken any more, and lists the latest first', async () => {
    const first = await span('门响了。', '门被拍响了。')
    const second = await span('天亮的时候，雨停了。', '天亮的时候，雨小了。')
    await rejectProposal(bed.runtime, first.id)
    await new Promise(resolve => setTimeout(resolve, 5))
    await rejectProposal(bed.runtime, second.id)
    // The chapter moves on: the sentence the first one changes is no longer there.
    await bed.runtime.project.saveChapterText(chapterId, TEXT.replace('门响了。', '有人敲门。'))
    const archive = await settledProposals(bed.runtime)
    expect(archive.items.map(item => [item.id, item.stands])).toEqual([[second.id, true], [first.id, false]])
    expect((await settledProposals(bed.runtime, { limit: 1 })).items.map(item => item.id)).toEqual([second.id])
    expect((await settledProposals(bed.runtime, { limit: 1 })).total).toBe(2)

    // A whole chapter proposed before the change: taken now, it would write over what came since — and says so.
    const whole = await bed.runtime.project.addProposal({ chapterId, kind: 'chapter', instruction: '整章', before: TEXT, after: '全新的一章。', createdBy: 'user' })
    await rejectProposal(bed.runtime, whole.id)
    expect((await settledProposals(bed.runtime)).items.find(item => item.id === whole.id)?.stands).toBe(false)
  })

  it('leaves out what a later proposal took in, and gives that proposal its place back when it is put back', async () => {
    const earlier = await span('雨下了一夜。', '雨下了两夜。')
    const onTop = await bed.runtime.project.addProposal({ chapterId, kind: 'chapter', instruction: '接着改', before: TEXT, after: TEXT.replace('雨下了一夜。', '雨下了两夜，没有停。'), createdBy: 'user', supersedes: [earlier.id] })
    await bed.runtime.project.supersedeProposal(earlier.id, onTop.id)
    // Taken in, the earlier one is settled by the later — nobody turned it down, and the archive does not say so.
    expect((await settledProposals(bed.runtime)).total).toBe(0)
    await expect(restoreProposal(bed.runtime, earlier.id)).rejects.toThrow(/taken into a later one/)

    // The later one turned down: the earlier waits by itself again, and the later is what the archive keeps.
    await rejectProposal(bed.runtime, onTop.id)
    expect(await statusOf(earlier.id)).toBe('pending')
    expect((await settledProposals(bed.runtime)).items.map(item => item.id)).toEqual([onTop.id])

    // Put back, it stands for the earlier one once more: one to accept, as before the slip.
    await restoreProposal(bed.runtime, onTop.id)
    expect(await statusOf(onTop.id)).toBe('pending')
    expect(await statusOf(earlier.id)).toBe('rejected')
    expect((await bed.runtime.project.state()).proposals.map(proposal => proposal.id)).toEqual([onTop.id])
    expect((await settledProposals(bed.runtime)).total).toBe(0)
  })
})

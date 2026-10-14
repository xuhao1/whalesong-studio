// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the Studio does by itself once text is written, changed or reviewed — a chapter digested, the new names looked
 * through, suggestions settled, a plan set by its text, what a review found mended, open issues read again — is a
 * switch of the Studio's each, and any of them a book's own: kept in the book, holding for it in place of the
 * Studio's, and taken off it again by naming it as nothing. A book the author keeps undigested is not digested
 * because others are.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeChapter } from '../src/core/pipelines/write'
import { editChapter } from '../src/core/pipelines/edit'
import { scheduleSift } from '../src/core/pipelines/cast'
import { plansFollow } from '../src/core/pipelines/follow'
import { settlesItself } from '../src/core/pipelines/settle'
import { reviewMends } from '../src/core/pipelines/revise'
import { withBook } from '../src/shared/images'
import { AUTO_KEYS, autoOf, autoSaid } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const DIGEST = JSON.stringify({ brief: '【记忆】', summary: '【记忆的摘要】', characters: [], facts: [], newEntities: [], threads: [] })

describe('what follows by itself for a book', () => {
  it('is the book\'s own switch where it has one, else the Studio\'s, else what holds where nobody set anything', () => {
    expect(AUTO_KEYS).toEqual(['autoDigest', 'siftCast', 'settleSuggestions', 'plansFollow', 'reviewMends', 'recheckIssues'])
    // Nobody set anything: every one on, but a plan set by its text.
    expect(autoOf(undefined)).toEqual({ autoDigest: true, siftCast: true, settleSuggestions: true, plansFollow: false, reviewMends: true, recheckIssues: true })
    const studio = { autoDigest: true, siftCast: false, plansFollow: true }
    expect(autoOf(studio)).toMatchObject({ autoDigest: true, siftCast: false, plansFollow: true, reviewMends: true })
    // A book's own holds in place of the Studio's — off where the Studio has it on, and on where it has it off.
    expect(autoOf(studio, { autoDigest: false, siftCast: true })).toMatchObject({ autoDigest: false, siftCast: true, plansFollow: true })
    // What is no switch is as good as not said.
    expect(autoSaid({ autoDigest: 'no' as never, siftCast: null, plansFollow: 0 as never, reviewMends: false })).toEqual({ reviewMends: false })
    expect(autoOf(studio, { autoDigest: 'no' as never })).toMatchObject({ autoDigest: true })
  })
})

describe('a book\'s own switches of what follows by itself', () => {
  let bed: TestBed
  let one: string
  beforeEach(async () => {
    // (The bed has digests, sifting and settling off, as the tests of everything else want it; each test says what it sets.)
    bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'rules', partBeats: 0 } })
    one = (await bed.runtime.project.addChapter({ title: '一', synopsis: '开头。' })).id
    await bed.runtime.project.saveChapterText(one, '雨落在青石板上。')
  })
  afterEach(async () => { await bed.cleanup() })

  const digests = () => bed.core.jobs.list(bed.runtime.project.root).filter(job => job.kind === 'digest')
  const scribe = () => bed.llm.requests.filter(request => request.route.for?.role === 'analyst')

  it('are kept in the book, each by its name, and taken off it by naming them as nothing', async () => {
    const { project } = bed.runtime
    await project.updateManifest({ autoDigest: false, siftCast: false, plansFollow: true })
    const book = await project.manifest()
    expect(autoSaid(book)).toEqual({ autoDigest: false, siftCast: false, plansFollow: true })
    // The settings as they hold for the book carry them; the Studio's own are untouched.
    await bed.core.settings.update({ autoDigest: true, siftCast: true })
    expect(await bed.core.autoFor(bed.runtime)).toMatchObject({ autoDigest: false, siftCast: false, plansFollow: true, reviewMends: true })
    expect(withBook(bed.core.currentSettings(), book)).toMatchObject({ autoDigest: false, siftCast: false, plansFollow: true })
    expect(await bed.core.settingsOf(bed.runtime)).toMatchObject({ autoDigest: false, siftCast: false })
    expect(bed.core.currentSettings()).toMatchObject({ autoDigest: true, siftCast: true })
    // (With no book in hand: the Studio's.)
    expect(await bed.core.autoFor(undefined)).toMatchObject({ autoDigest: true, siftCast: true })
    // One named as nothing is none of the book's any more; the others stay. What is no switch is not kept.
    await project.updateManifest({ autoDigest: null as never, siftCast: 'off' as never })
    const fewer = await project.manifest()
    expect('autoDigest' in fewer).toBe(false)
    expect('siftCast' in fewer).toBe(false)
    expect(autoSaid(fewer)).toEqual({ plansFollow: true })
    // Another change to the book leaves them where they were.
    await project.updateManifest({ recheckIssues: false })
    await project.updateManifest({ logline: '一支笔的事。' })
    expect(autoSaid(await project.manifest())).toEqual({ plansFollow: true, recheckIssues: false })
  })

  it('keep a book undigested where the Studio digests every chapter — after an edit and after a chapter is written', async () => {
    const { core, runtime, llm } = bed
    await core.settings.update({ autoDigest: true })
    await runtime.project.updateManifest({ autoDigest: false })
    llm.responder = request => (request.prompt.includes('请做场记') ? DIGEST : '他没有说话。')
    // An edit: the memory is said to be stale, and no digest starts.
    const edited = await editChapter(core, runtime, { chapter: one, action: 'append', text: '门开了。' }, task)
    expect(edited.memory).toBe('stale')
    await wait(30)
    expect(digests()).toEqual([])
    // A chapter written: its text is saved, and nobody is asked to digest it.
    const two = (await runtime.project.addChapter({ title: '二', synopsis: '接着。' })).id
    const written = await writeChapter(core, runtime, { chapter: two }, task)
    expect(written.digested).toBe(false)
    expect(scribe()).toEqual([])
    // Said for one piece of work, it is digested all the same: the book's switch is what holds where nothing is said.
    expect((await writeChapter(core, runtime, { chapter: two, digest: true }, task)).digested).toBe(true)
    expect(scribe()).toHaveLength(1)

    // Taken off the book, the Studio's holds again: the next edit starts a digest.
    await runtime.project.updateManifest({ autoDigest: null as never })
    const again = await editChapter(core, runtime, { chapter: one, action: 'append', text: '灯灭了。' }, task)
    expect(again.memory).toBe('digesting')
    expect(digests().map(job => job.target)).toEqual([one])
  })

  it('digest a book by itself where the Studio has digests off', async () => {
    const { core, runtime, llm } = bed
    // (The bed has digests off, as an author who switched them off for every book.)
    expect(core.currentSettings().autoDigest).toBe(false)
    await runtime.project.updateManifest({ autoDigest: true })
    llm.responder = request => (request.prompt.includes('请做场记') ? DIGEST : '他没有说话。')
    const edited = await editChapter(core, runtime, { chapter: one, action: 'append', text: '门开了。' }, task)
    expect(edited.memory).toBe('digesting')
    expect(digests().map(job => job.target)).toEqual([one])
    const two = (await runtime.project.addChapter({ title: '二', synopsis: '接着。' })).id
    expect((await writeChapter(core, runtime, { chapter: two }, task)).digested).toBe(true)
  })

  it('say for the book whether new names are looked through, suggestions settled, plans set by their texts, and reviews mended', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    // Each as the Studio has it where the book says nothing…
    await core.settings.update({ siftCast: true, settleSuggestions: true, plansFollow: false, reviewMends: true })
    const plain = await project.manifest()
    expect([settlesItself(core, plain), plansFollow(core, plain), reviewMends(core, undefined, plain)]).toEqual([true, false, true])
    // …and as the book has it where it does.
    await project.updateManifest({ siftCast: false, settleSuggestions: false, plansFollow: true, reviewMends: false })
    const book = await project.manifest()
    expect([settlesItself(core, book), plansFollow(core, book), reviewMends(core, undefined, book)]).toEqual([false, true, false])
    // (What is said for one review comes before both.)
    expect(reviewMends(core, true, book)).toBe(true)

    // At work: names without a card wait, the Studio would have them looked through, and this book does not.
    const chapter = await project.addChapter({ title: '第一回' })
    await project.saveMemory({ schema: 1, chapterId: chapter.id, textHash: 'x', updatedAt: '', brief: '', summary: '', facts: [], threads: [], newEntities: [], characters: [{ character: '门子', name: '门子', role: '通报', state: '' }] } as never)
    llm.responder = () => JSON.stringify({ people: [{ name: '门子', is: 'walkon', why: '通报一声。' }] })
    scheduleSift(core, runtime, task, 5)
    await wait(80)
    expect(llm.requests).toHaveLength(0)
    expect(core.jobs.list(project.root).filter(job => job.title === 'sift cast')).toEqual([])
    // Taken off the book, the Studio's holds: they are looked through.
    await project.updateManifest({ siftCast: null as never })
    scheduleSift(core, runtime, task, 5)
    for (let n = 0; n < 40 && core.jobs.list(project.root).filter(job => job.title === 'sift cast').length === 0; n++) await wait(25)
    expect(core.jobs.list(project.root).filter(job => job.title === 'sift cast')).toHaveLength(1)
  })
})

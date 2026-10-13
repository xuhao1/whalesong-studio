// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * How a book is written and revised — who prepares what its writer is handed, beats to a part, whose model writes a
 * revision and whose a rewrite, how far a revision goes — is the Studio's for every book, and any of it a book's own:
 * kept in the book, holding for it in place of the Studio's, and taken off it again by naming it as nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeChapter } from '../src/core/pipelines/write'
import { mendsBold, mendsBy, reviseBook, reviseChapter, reviseSpan, rewritesBy } from '../src/core/pipelines/revise'
import { withBook } from '../src/shared/images'
import { PART_BEATS_DEFAULT, WRITING_KEYS, writingOf, writingSaid } from '../src/shared/types'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const BEATS = ['【节拍一】陆沉到渡口', '【节拍二】沈璃不给', '【节拍三】账本被翻出来', '【节拍四】阿棠送信来', '【节拍五】雨停', '【节拍六】船离岸'].map((summary, at) => ({ id: `b${at + 1}`, summary }))

describe('what holds for a book of how it is written and revised', () => {
  it('is the book\'s own where it has one, else the Studio\'s, else what holds where nobody set anything', () => {
    expect(writingOf(undefined)).toEqual({ materialBy: 'rules', partBeats: PART_BEATS_DEFAULT, mendBy: 'auto', rewriteBy: 'writer', mendReach: 'bold' })
    const studio = { materialBy: 'planner' as const, partBeats: 2, mendBy: 'writer' as const, rewriteBy: 'planner' as const, mendReach: 'careful' as const }
    expect(writingOf(studio)).toEqual(studio)
    // Each of the book's own holds in place of the Studio's; the rest is the Studio's still. (0 beats to a part is a value: never in parts.)
    expect(writingOf(studio, { partBeats: 0, mendReach: 'bold' })).toEqual({ ...studio, partBeats: 0, mendReach: 'bold' })
    expect(writingOf(studio, {})).toEqual(studio)
  })

  it('takes only what is a value of its kind as said', () => {
    expect(writingSaid({ materialBy: 'nobody' as never, partBeats: -1, mendBy: 'me' as never, rewriteBy: '' as never, mendReach: 'wild' as never })).toEqual({})
    expect(writingSaid({ partBeats: Number.NaN })).toEqual({})
    expect(writingSaid({ partBeats: 2.6, mendBy: 'writer' })).toEqual({ partBeats: 3, mendBy: 'writer' })
    expect(writingSaid(undefined)).toEqual({})
    // What is not said of a book leaves the Studio's as it is.
    expect(writingOf({ partBeats: 5 }, { partBeats: 'many' as never })).toMatchObject({ partBeats: 5 })
  })
})

describe('a book\'s own ways of writing and revising', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'rules', partBeats: undefined as never, mendBy: undefined, rewriteBy: undefined as never, mendReach: undefined as never } }) })
  afterEach(async () => { await bed.cleanup() })

  it('are kept in the book, each by its name, and taken off it by naming them as nothing', async () => {
    const { project } = bed.runtime
    await project.updateManifest({ materialBy: 'planner', partBeats: 0, mendBy: 'writer', rewriteBy: 'planner', mendReach: 'careful' })
    const book = await project.manifest()
    expect(writingSaid(book)).toEqual({ materialBy: 'planner', partBeats: 0, mendBy: 'writer', rewriteBy: 'planner', mendReach: 'careful' })
    // The settings as they hold for the book carry them; the Studio's own are untouched.
    expect(await bed.core.settingsOf(bed.runtime)).toMatchObject({ materialBy: 'planner', partBeats: 0, mendBy: 'writer', rewriteBy: 'planner', mendReach: 'careful' })
    expect(withBook(bed.core.currentSettings(), book)).toMatchObject({ partBeats: 0, mendReach: 'careful' })
    expect(bed.core.currentSettings().partBeats).toBeUndefined()
    expect(bed.core.currentSettings().mendReach).toBeUndefined()
    // One named as nothing is none of the book's any more; the others stay.
    await project.updateManifest({ partBeats: null as never, mendBy: null as never })
    const fewer = await project.manifest()
    expect('partBeats' in fewer).toBe(false)
    expect('mendBy' in fewer).toBe(false)
    expect(writingSaid(fewer)).toEqual({ materialBy: 'planner', rewriteBy: 'planner', mendReach: 'careful' })
    // What is no value of its kind is not kept as the book's own.
    await project.updateManifest({ partBeats: -3, mendReach: 'wild' as never, rewriteBy: 'someone' as never })
    const kept = await project.manifest()
    for (const key of ['partBeats', 'mendReach', 'rewriteBy'] as const) expect(key in kept).toBe(false)
    expect(writingSaid(kept)).toEqual({ materialBy: 'planner' })
    // Another change to the book leaves them where they were.
    await project.updateManifest({ partBeats: 4 })
    await project.updateManifest({ logline: '一支笔的事。' })
    expect((await project.manifest()).partBeats).toBe(4)
    expect(WRITING_KEYS).toEqual(['materialBy', 'partBeats', 'mendBy', 'rewriteBy', 'mendReach'])
  })

  it('part a chapter by the book\'s own number of beats, whatever the Studio has — and 0 of the book\'s own is never in parts', async () => {
    const { core, runtime, llm } = bed
    const here = (await runtime.project.addChapter({ title: '二', synopsis: '陆沉来讨那支笔。', beats: BEATS })).id
    llm.responder = () => '他没有说话。'
    const writers = (): LlmRequest[] => llm.requests.filter(request => request.route.for?.role === 'writer')
    // The Studio parts by a beat; this book never parts: one request, and the result says parts are off.
    await core.settings.update({ partBeats: 1 })
    await runtime.project.updateManifest({ partBeats: 0 })
    const whole = await writeChapter(core, runtime, { chapter: here, words: 9000, digest: false }, task)
    expect(whole.parts).toBeUndefined()
    expect(whole.partsOff).toBe(true)
    expect(writers()).toHaveLength(1)
    // The Studio never parts; this book parts by two beats: three parts.
    await core.settings.update({ partBeats: 0 })
    await runtime.project.updateManifest({ partBeats: 2 })
    expect((await writeChapter(core, runtime, { chapter: here, digest: false }, task)).parts).toBe(3)
    // Taken off the book, the Studio's holds again.
    await runtime.project.updateManifest({ partBeats: null as never })
    expect((await writeChapter(core, runtime, { chapter: here, digest: false }, task)).parts).toBeUndefined()
  })

  it('say whose model revises and rewrites this book, and how far a revision of it goes, in place of the Studio\'s', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    const one = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(one.id, '渡口没有人。\n\n她等了一夜。')
    const writer = { provider: 'p', model: 'writer-model' }
    const crew = { provider: 'p', model: 'crew-model' }
    await core.settings.update({ models: { writer, architect: crew } as never })
    const planner = (request: LlmRequest): boolean => request.route.for?.role === 'architect' && request.prompt.includes('"edits"')

    // Nothing set anywhere.
    expect(mendsBy(core, undefined, await project.manifest())).toBe('auto')
    expect(rewritesBy(core, undefined, await project.manifest())).toBe('writer')
    expect(mendsBold(core, undefined, await project.manifest())).toBe(true)
    // The book's own, against the Studio's: the book's hold.
    await core.settings.update({ mendBy: 'planner', rewriteBy: 'writer', mendReach: 'bold' })
    await project.updateManifest({ mendBy: 'writer', rewriteBy: 'planner', mendReach: 'careful' })
    const book = await project.manifest()
    expect(mendsBy(core, undefined, book)).toBe('writer')
    expect(rewritesBy(core, undefined, book)).toBe('planner')
    expect(mendsBold(core, undefined, book)).toBe(false)
    // …and what is said for one piece of work comes before both.
    expect(mendsBy(core, true, book)).toBe('planner')
    expect(mendsBy(core, 'auto', book)).toBe('auto')
    expect(rewritesBy(core, 'writer', book)).toBe('writer')
    expect(mendsBold(core, 'bold', book)).toBe(true)

    // At work. A change by places: the planner settles where, the writer's model writes (the book's `mendBy`), and the
    // planner is told to keep to the least change (the book's `mendReach`).
    llm.responder = request => planner(request) ? JSON.stringify({ edits: [{ chapter: 1, find: '她等了一夜。', how: '改成两夜' }], chapters: [], note: '一处。' }) : '她等了两夜。'
    const mended = await reviseBook(core, runtime, { instruction: '等的是两夜', asked: true }, task)
    expect(mended.direct).toBeUndefined()
    expect(llm.requests.map(request => request.route?.model)).toEqual(['crew-model', 'writer-model'])
    expect(llm.requests[0]!.prompt).toContain('改动越少越好：这条要求碰到哪几句就改哪几句')
    expect(llm.requests[0]!.prompt).not.toContain('把这条要求落实到位')
    // A passage rewritten and a chapter written over: the crew's model (the book's `rewriteBy`).
    llm.requests.length = 0
    llm.responder = () => '渡口空无一人。'
    expect(await reviseSpan(core, runtime, { chapter: one.id, quote: '渡口没有人。', instruction: '换个说法' }, task)).toMatchObject({ who: 'planner' })
    llm.responder = () => '渡口空无一人。\n\n她等了一夜又一夜。'
    expect(await reviseChapter(core, runtime, { chapter: one.id, instruction: '重写' }, task)).toMatchObject({ who: 'planner' })
    expect(llm.requests.map(request => request.route?.model)).toEqual(['crew-model', 'crew-model'])

    // Taken off the book: the Studio's again — the planner writes the place itself, mended through.
    await project.updateManifest({ mendBy: null as never, rewriteBy: null as never, mendReach: null as never })
    llm.requests.length = 0
    llm.responder = request => planner(request) ? JSON.stringify({ edits: [{ chapter: 1, find: '她等了一夜。', replace: '她等了三夜。', why: '照要求' }], chapters: [], note: '一处。' }) : '不该问到写手'
    const direct = await reviseBook(core, runtime, { instruction: '等的是三夜', asked: true }, task)
    expect(direct.direct).toBe(true)
    expect(llm.requests.map(request => request.route?.model)).toEqual(['crew-model'])
    expect(llm.requests[0]!.prompt).toContain('把这条要求落实到位')
    expect(llm.requests[0]!.prompt).not.toContain('改动越少越好：这条要求碰到哪几句就改哪几句')
    llm.requests.length = 0
    llm.responder = () => '渡口空无一人。'
    expect(await reviseSpan(core, runtime, { chapter: one.id, quote: '渡口没有人。', instruction: '换个说法' }, task)).toMatchObject({ who: 'writer' })
  })
})

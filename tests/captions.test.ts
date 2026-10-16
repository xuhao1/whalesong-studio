// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a reader is told under a picture placed in the text. Found illustrating
 * *Alice* and 《红楼梦》: the caption was the first sixty characters of the
 * director's frame — "Medium shot, eye-level view. Alice sits in a large
 * arm-chair", "中景，略俯视角。薛宝钗站在……" — how it was shot, not what it shows.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { captionFrom, illustrate } from '../src/core/pipelines/illustrate'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import { createTestBed, FakeImages, type TestBed } from './support/harness'

let bed: TestBed | undefined
afterEach(async () => {
  await bed?.cleanup()
  bed = undefined
})

describe('the caption under a picture in the text', () => {
  it('leaves out a first sentence that only says how the frame is taken', () => {
    expect(captionFrom('Medium shot, eye-level view. Alice sits in a large arm-chair at one end of the table.')).toBe('Alice sits in a large arm-chair at one end of the table.')
    expect(captionFrom('中景，略俯视角。薛宝钗站在池中滴翠亭外的曲桥上，举扇扑蝶。')).toBe('薛宝钗站在池中滴翠亭外的曲桥上，举扇扑蝶。')
    // A first sentence that goes on to what the picture shows is what it shows.
    expect(captionFrom('Vertical view inside a deep well shaft as Alice descends slowly past cupboards and book-shelves.')).toBe('Vertical view inside a deep well shaft as Alice descends slowly past cupboards and book-shelves.')
    expect(captionFrom('Alice follows the White Rabbit.')).toBe('Alice follows the White Rabbit.')
    expect(captionFrom('Close-up.')).toBe('Close-up.')
  })

  it('is the line the director gave for it, or the frame less its shot', async () => {
    const images = new FakeImages()
    bed = await createTestBed({ settings: { image: { ...DEFAULT_SETTINGS.image, provider: 'codex' } }, bridges: images.bridges })
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: 'A Mad Tea-Party' })
    await project.saveChapterText(chapter.id, 'There was a table set out under a tree in front of the house, and the March Hare and the Hatter were having tea at it.')
    bed.llm.responder = () => JSON.stringify({ picture: 'Medium shot, eye-level view. Alice sits in a large arm-chair at one end of the long table, the March Hare and the Hatter at the other.', people: [], why: 'the tea-party', caption: 'Alice at the Mad Tea-Party' })
    await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, insert: true, sheetFirst: false }, { origin: 'user' })
    expect((await project.chapterText(chapter.id)).split('\n')[0]).toMatch(/^!\[Alice at the Mad Tea-Party\]\(assets\/images\/scene-/)
    // The director's line asked for, in the book's language.
    expect(bed.llm.requests.at(-1)!.prompt).toMatch(/caption/)

    bed.llm.responder = () => JSON.stringify({ picture: 'Medium shot, eye-level view. The Hatter pours tea into his own saucer.', people: [], why: 'the tea-party' })
    await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, insert: true, sheetFirst: false }, { origin: 'user' })
    expect(await project.chapterText(chapter.id)).toMatch(/!\[The Hatter pours tea into his own saucer\.\]\(assets\/images\/scene-/)
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture placed in a chapter changes nothing that was read: the chapter
 * stays digested, and digesting it again does not call the model. Found
 * importing a whole book and illustrating three of its chapters — the
 * overview then said three chapters were not digested.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { digestChapter } from '../src/core/pipelines/digest'
import { hashText, digestOf } from '../src/shared/text'
import { createTestBed, type TestBed } from './support/harness'

const PROSE = 'Alice was beginning to get very tired of sitting by her sister on the bank.\n\nSo she was considering in her own mind what to do.'
const PICTURED = `![Alice on the bank, a book in her sister's lap](assets/images/scene-ch001-0000abcd.png)\n\n${PROSE}`

describe('a digest and the pictures in the text', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('is made of the prose, whatever pictures the text holds', () => {
    expect(digestOf(hashText(PROSE), PICTURED)).toBe(true)
    // One made before, of the text with its picture, still counts.
    expect(digestOf(hashText(PICTURED), PICTURED)).toBe(true)
    expect(digestOf(hashText(PROSE), `${PROSE}\n\nShe ran after it.`)).toBe(false)
  })

  it('keeps a chapter digested when a picture is placed in it', async () => {
    const { project } = bed.runtime
    const { id } = await project.addChapter({ title: 'Down the Rabbit-Hole' })
    await project.saveChapterText(id, PROSE)
    bed.llm.responder = () => JSON.stringify({ brief: 'Alice on the bank.', summary: 'Alice sits by her sister, bored.', characters: [], facts: [], newEntities: [], threads: [] })
    await digestChapter(bed.core, bed.runtime, id, { origin: 'user' })
    expect(bed.llm.requests).toHaveLength(1)
    expect((await project.chapterInfos())[0]).toMatchObject({ digested: true, memory: 'current' })

    await project.saveChapterText(id, PICTURED)
    expect((await project.chapterInfos())[0]).toMatchObject({ digested: true, memory: 'current' })
    await digestChapter(bed.core, bed.runtime, id, { origin: 'user' })
    expect(bed.llm.requests).toHaveLength(1)

    // The prose itself changed: that is read again.
    await project.saveChapterText(id, `${PICTURED}\n\nShe ran across the field after it.`)
    expect((await project.chapterInfos())[0]).toMatchObject({ digested: false, memory: 'stale' })
  })
})

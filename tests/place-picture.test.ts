// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestBed, PIXEL, type TestBed } from './support/harness'

describe('a picture the book has, placed in a chapter\'s text', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('goes in after the paragraph pointed at — by its number, by a passage, at the top, at the end — and leaves the rest of the text as it was', async () => {
    const { project } = bed.runtime
    const picture = await project.writeAsset('images/boat.png', PIXEL)
    const chapter = await project.addChapter({ title: '渡口' })
    // Three paragraphs, the second with a line broken inside it: a paragraph is what stands between blank lines.
    const text = '雨停的时候，她到了渡口。\n\n船还没有来，\n木桩上系着半截旧绳。\n\n她把信折好，放回袖子里。\n'
    await project.saveChapterText(chapter.id, text)
    const tag = (alt = ''): string => `![${alt}](${picture})`
    // After the second paragraph.
    expect(await project.placePicture(chapter.id, picture, { after: 2, alt: '半截旧绳' })).toEqual({ chapter: chapter.id, after: 2 })
    expect(await project.chapterText(chapter.id)).toBe(`雨停的时候，她到了渡口。\n\n船还没有来，\n木桩上系着半截旧绳。\n\n${tag('半截旧绳')}\n\n她把信折好，放回袖子里。`)
    // The text as it was is a version to go back to.
    expect((await project.versions(chapter.id)).length).toBeGreaterThan(0)
    // After the paragraph a passage ends in: found though the quote is only part of it.
    await project.saveChapterText(chapter.id, text)
    expect((await project.placePicture(chapter.id, picture, { quote: '船还没有来' })).after).toBe(2)
    expect(await project.chapterText(chapter.id)).toContain(`木桩上系着半截旧绳。\n\n${tag()}\n\n她把信折好`)
    // At the top; and, nothing said, at the end.
    await project.saveChapterText(chapter.id, text)
    await project.placePicture(chapter.id, picture, { after: 0 })
    expect((await project.chapterText(chapter.id)).startsWith(`${tag()}\n\n雨停的时候`)).toBe(true)
    await project.saveChapterText(chapter.id, text)
    expect((await project.placePicture(chapter.id, picture)).after).toBe(3)
    expect((await project.chapterText(chapter.id)).trimEnd().endsWith(`她把信折好，放回袖子里。\n\n${tag()}`)).toBe(true)
    // A number past the end is the end; a passage the text does not have is the end too.
    await project.saveChapterText(chapter.id, text)
    expect((await project.placePicture(chapter.id, picture, { after: 99 })).after).toBe(3)
    await project.saveChapterText(chapter.id, text)
    expect((await project.placePicture(chapter.id, picture, { quote: '书里没有的一句话，一个字也对不上' })).after).toBe(3)
    // A chapter with nothing written takes it as its first line.
    const empty = await project.addChapter({ title: '空章' })
    expect(await project.placePicture(empty.id, picture)).toEqual({ chapter: empty.id, after: 0 })
    expect((await project.chapterText(empty.id)).trim()).toBe(tag())
  })

  it('places only what is a picture of the book, in a chapter that is there', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(chapter.id, '一段。')
    await expect(project.placePicture(chapter.id, 'assets/images/none.png')).rejects.toThrow(/not one of the book's pictures/)
    await expect(project.placePicture(chapter.id, 'novel.json')).rejects.toThrow(/not one of the book's pictures/)
    await expect(project.placePicture(chapter.id, 'assets/../outline.json')).rejects.toThrow(/not one of the book's pictures/)
    const picture = await project.writeAsset('images/boat.png', PIXEL)
    await expect(project.placePicture('ch999', picture)).rejects.toThrow(/no chapter matches/)
    expect(await project.chapterText(chapter.id)).toBe('一段。')
  })
})

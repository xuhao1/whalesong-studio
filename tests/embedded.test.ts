// SPDX-License-Identifier: LGPL-3.0-or-later
/** The pictures a chapter's text has in it: found, moved, taken out, put in — in the text itself. */
import { describe, expect, it } from 'vitest'
import { embeddedPictures, movedPicture, pictureChanged, proseLines, textBlocks, withoutPicture, withPicture, withProse, type ProseBlock } from '../src/shared/embedded'

const TEXT = '第一段。\n\n![灯](assets/images/a.png)\n\n第二段。\n\n第三段。\n\n![雨](assets/images/b.png)\n'

describe('pictures in a chapter\'s text', () => {
  it('finds them, each with the line of prose it stands after', () => {
    expect(embeddedPictures(TEXT).map(({ path, alt, after, follows }) => ({ path, alt, after, follows }))).toEqual([
      { path: 'assets/images/a.png', alt: '灯', after: 1, follows: '第一段。' },
      { path: 'assets/images/b.png', alt: '雨', after: 3, follows: '第三段。' },
    ])
    expect(TEXT.slice(embeddedPictures(TEXT)[1]!.offset)).toBe('![雨](assets/images/b.png)\n')
    expect(proseLines(TEXT)).toEqual(['第一段。', '第二段。', '第三段。'])
    expect(embeddedPictures('![首](x.png)\n\n正文。')[0]).toMatchObject({ after: 0 })
    expect(embeddedPictures('没有图。')).toEqual([])
  })

  it('moves one to stand after another line, and leaves the prose as it was', () => {
    const first = embeddedPictures(TEXT)[0]!
    const moved = movedPicture(TEXT, first.line, 2)
    expect(moved).toBe('第一段。\n\n第二段。\n\n![灯](assets/images/a.png)\n\n第三段。\n\n![雨](assets/images/b.png)\n')
    // To the top, and past the end (which is the end).
    expect(movedPicture(TEXT, first.line, 0).startsWith('![灯](assets/images/a.png)\n\n第一段。\n\n第二段。')).toBe(true)
    expect(movedPicture(TEXT, first.line, 99)).toBe('第一段。\n\n第二段。\n\n第三段。\n\n![雨](assets/images/b.png)\n\n![灯](assets/images/a.png)\n')
    // Where it stands already: nothing changes; a line that is no picture: nothing changes.
    expect(movedPicture(TEXT, first.line, 1)).toBe(TEXT)
    expect(movedPicture(TEXT, 0, 2)).toBe(TEXT)
    expect(proseLines(moved)).toEqual(proseLines(TEXT))
  })

  it('takes one out and puts one in, a line of its own between empty lines', () => {
    expect(withoutPicture(TEXT, embeddedPictures(TEXT)[0]!.line)).toBe('第一段。\n\n第二段。\n\n第三段。\n\n![雨](assets/images/b.png)\n')
    expect(withoutPicture(TEXT, 0)).toBe(TEXT)
    expect(withPicture('第一段。\n\n第二段。', { path: 'p.png', alt: '一[张]图' }, 1)).toBe('第一段。\n\n![一[张 图](p.png)\n\n第二段。')
    // After a line that has a picture after it already: after that picture.
    expect(withPicture(TEXT, { path: 'c.png' }, 1)).toBe('第一段。\n\n![灯](assets/images/a.png)\n\n![](c.png)\n\n第二段。\n\n第三段。\n\n![雨](assets/images/b.png)\n')
    // Lines parted by single breaks stay so around what is not touched.
    expect(withPicture('甲。\n乙。\n丙。', { path: 'p.png' }, 2)).toBe('甲。\n乙。\n\n![](p.png)\n\n丙。')
    expect(withPicture('', { path: 'p.png' }, 0)).toBe('![](p.png)')
  })

  it('lays the text out as prose and pictures in turn, every stretch of prose where it stands in the text', () => {
    const blocks = textBlocks(TEXT)
    expect(blocks.map(block => block.kind)).toEqual(['prose', 'picture', 'prose', 'picture', 'prose'])
    // What is between two pictures is the author's as it stands — the empty lines around a picture too.
    expect(blocks.map(block => TEXT.slice(block.start, block.end))).toEqual(['第一段。\n', '![灯](assets/images/a.png)', '\n第二段。\n\n第三段。\n', '![雨](assets/images/b.png)', ''])
    expect(blocks[1]).toMatchObject({ line: 2, path: 'assets/images/a.png', alt: '灯' })
    // (The last line is empty — the text ends on a line break — and is a line to type on.)
    expect(blocks[4]).toEqual({ kind: 'prose', start: TEXT.length, end: TEXT.length })
    // No picture: all of it is one stretch of prose; so is no text at all.
    expect(textBlocks('只有字。\n第二行。')).toEqual([{ kind: 'prose', start: 0, end: 9 }])
    expect(textBlocks('')).toEqual([{ kind: 'prose', start: 0, end: 0 }])
    // Put back together, whatever is typed in one stretch leaves the rest as it was.
    const second = blocks[2] as ProseBlock
    expect(withProse(TEXT, second, '\n第二段，改过。\n')).toBe('第一段。\n\n![灯](assets/images/a.png)\n\n第二段，改过。\n\n![雨](assets/images/b.png)\n')
    expect(withProse(TEXT, second, TEXT.slice(second.start, second.end))).toBe(TEXT)
    // A line added at the end of a stretch stays in it: the box it is typed in does not lose it.
    const longer = withProse(TEXT, blocks[0] as ProseBlock, '第一段。\n\n新的一段')
    expect(TEXT.slice(0, 0) + longer.slice(textBlocks(longer)[0]!.start, textBlocks(longer)[0]!.end)).toBe('第一段。\n\n新的一段')
  })

  it('has a place to type where no line of prose is: before a picture on the first line, between two, after one on the last', () => {
    const tight = '![首](a.png)\n![次](b.png)'
    const blocks = textBlocks(tight)
    expect(blocks.map(block => (block.kind === 'prose' ? { at: block.start, gap: block.gap } : block.path))).toEqual([{ at: 0, gap: 'lead' }, 'a.png', { at: 12, gap: 'lead' }, 'b.png', { at: tight.length, gap: 'tail' }])
    // Typed there, the words get a line of their own, and both pictures are still pictures.
    const before = withProse(tight, blocks[0] as ProseBlock, '开头')
    expect(before).toBe('开头\n![首](a.png)\n![次](b.png)')
    expect(textBlocks(before)[0]).toEqual({ kind: 'prose', start: 0, end: 2 })
    const between = withProse(tight, blocks[2] as ProseBlock, '中间\n两行')
    expect(between).toBe('![首](a.png)\n中间\n两行\n![次](b.png)')
    expect(embeddedPictures(between).map(picture => picture.path)).toEqual(['a.png', 'b.png'])
    const after = withProse(tight, blocks[4] as ProseBlock, '结尾')
    expect(after).toBe('![首](a.png)\n![次](b.png)\n结尾')
    expect(textBlocks(after).at(-1)).toEqual({ kind: 'prose', start: after.length - 2, end: after.length })
    // Nothing typed: nothing changes. Emptied again, the line stays — an empty one.
    expect(withProse(tight, blocks[2] as ProseBlock, '')).toBe(tight)
    const emptied = withProse(between, textBlocks(between)[2] as ProseBlock, '')
    expect(emptied).toBe('![首](a.png)\n\n![次](b.png)')
    expect(textBlocks(emptied)[2]).toEqual({ kind: 'prose', start: 12, end: 12 })
  })

  it('makes a picture in the text another one, or calls it otherwise, where it stands', () => {
    const line = embeddedPictures(TEXT)[0]!.line
    expect(pictureChanged(TEXT, line, { path: 'assets/images/c.png' })).toBe(TEXT.replace('![灯](assets/images/a.png)', '![灯](assets/images/c.png)'))
    expect(pictureChanged(TEXT, line, { alt: '一盏 [旧] 灯' })).toBe(TEXT.replace('![灯](assets/images/a.png)', '![一盏 [旧  灯](assets/images/a.png)'))
    // A path that could not stand in the markup, and a line that is no picture: left as they are.
    expect(pictureChanged(TEXT, line, { path: 'has space.png' })).toBe(TEXT)
    expect(pictureChanged(TEXT, 0, { path: 'assets/images/c.png' })).toBe(TEXT)
    expect(pictureChanged('  ![灯](a.png)', 0, { path: 'b.png' })).toBe('  ![灯](b.png)')
  })
})

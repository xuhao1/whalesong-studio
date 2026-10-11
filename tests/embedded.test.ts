// SPDX-License-Identifier: LGPL-3.0-or-later
/** The pictures a chapter's text has in it: found, moved, taken out, put in — in the text itself. */
import { describe, expect, it } from 'vitest'
import { embeddedPictures, movedPicture, proseLines, withoutPicture, withPicture } from '../src/shared/embedded'

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
})

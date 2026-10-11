// SPDX-License-Identifier: LGPL-3.0-or-later
/** The pictures a chapter's text has in it: found, moved, taken out, put in — in the text itself. */
import { describe, expect, it } from 'vitest'
import { embeddedPictures, keptPictures, movedPicture, pictureChanged, proseLines, textBlocks, withoutPicture, withPicture, withProse, type ProseBlock } from '../src/shared/embedded'

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

describe('a text written anew, held against the pictures it had', () => {
  const A = '![灯](assets/images/a.png)'
  const B = '![雨](assets/images/b.png)'
  const ONE = '沈蘅没有应。门缝里塞进一张湿剪报，纸角碰到柜台，发出轻响。'
  const TWO = '阿棠盯着她，半天才说出一句话来：断肠斋的灯今晚没有点。'
  const THREE = '她把那支旧笔放回抽屉，抽屉合上的时候，外头的雨正好停了。'
  const WAS = `${ONE}\n\n${A}\n\n${TWO}\n\n${THREE}\n\n${B}\n`
  const one = '沈蘅没有应声。门缝里塞进来一张湿透的剪报，纸角碰到柜台，轻轻一响。'
  const two = '阿棠盯着她看了半天，才说：断肠斋的灯，今晚没有点。'
  const three = '她把旧笔放回抽屉。抽屉合上时，外头的雨正好停了。'

  it('leaves alone a rewriting that has them as they stood', () => {
    const now = `${one}\n\n${A}\n\n${two}\n\n\n${three}\n\n${B}`
    expect(keptPictures(WAS, now)).toEqual({ text: now, back: 0, made: 0 })
    expect(keptPictures('没有图。', '还是没有图。')).toEqual({ text: '还是没有图。', back: 0, made: 0 })
    expect(keptPictures(WAS, WAS).text).toBe(WAS)
  })

  it('puts back one that was left out, after the line the one it followed became', () => {
    expect(keptPictures(WAS, `${one}\n\n${two}\n\n${three}`)).toEqual({ text: `${one}\n\n${A}\n\n${two}\n\n${three}\n\n${B}`, back: 2, made: 0 })
    // Lines parted by single breaks, as an imported book has them: the picture still gets a line of its own.
    expect(keptPictures(WAS, `${one}\n${two}\n${three}\n`).text).toBe(`${one}\n\n${A}\n\n${two}\n${three}\n\n${B}\n`)
    // The paragraphs changed places: it goes with the one it followed, not with the place.
    expect(keptPictures(WAS, `${two}\n\n${one}\n\n${three}\n\n${B}`).text).toBe(`${two}\n\n${one}\n\n${A}\n\n${three}\n\n${B}`)
    // The line it followed is gone: before the one that followed it.
    expect(keptPictures(WAS, `${two}\n\n${three}\n\n${B}`).text).toBe(`${A}\n\n${two}\n\n${three}\n\n${B}`)
    // At the top, it stays at the top.
    expect(keptPictures(`${A}\n\n${ONE}`, one).text).toBe(`${A}\n\n${one}`)
  })

  it('keeps pictures that stood together in their order, whichever of them was left out', () => {
    const pair = `${ONE}\n\n${A}\n\n${B}\n\n${TWO}`
    expect(keptPictures(pair, `${one}\n\n${two}`).text).toBe(`${one}\n\n${A}\n\n${B}\n\n${two}`)
    expect(keptPictures(pair, `${one}\n\n${B}\n\n${two}`).text).toBe(`${one}\n\n${A}\n\n${B}\n\n${two}`)
    expect(keptPictures(pair, `${one}\n\n${A}\n\n${two}`).text).toBe(`${one}\n\n${A}\n\n${B}\n\n${two}`)
  })

  it('where nothing reads like what was there, puts each as far down the text as it stood', () => {
    const fresh = ['第一段全新。', '第二段全新。', '第三段全新。', '第四段全新。', '第五段全新。', '第六段全新。']
    // After one of three lines, and at the end: after two of six, and at the end.
    expect(keptPictures(WAS, fresh.join('\n\n'))).toEqual({ text: `${fresh.slice(0, 2).join('\n\n')}\n\n${A}\n\n${fresh.slice(2).join('\n\n')}\n\n${B}`, back: 2, made: 0 })
    // A translation, line for line: each is where it was.
    expect(keptPictures(WAS, 'She did not answer.\n\nA-Tang stared.\n\nShe put the pen back.').text).toBe(`She did not answer.\n\n${A}\n\nA-Tang stared.\n\nShe put the pen back.\n\n${B}`)
    // Nothing came back but the pictures have somewhere to be.
    expect(keptPictures(WAS, '').text).toBe(`${A}\n\n${B}`)
  })

  it('takes out a picture line of the rewriting\'s own making, and gives a spoilt path back', () => {
    // A file the text does not show; the same picture a second time.
    expect(keptPictures(WAS, `${one}\n\n${A}\n\n${two}\n\n![窗](assets/images/w.png)\n\n${three}\n\n${B}\n\n${B}`)).toEqual({ text: `${one}\n\n${A}\n\n${two}\n\n${three}\n\n${B}`, back: 0, made: 2 })
    expect(keptPictures('一句话。', '改过的一句话。\n\n![插图](x.png)')).toEqual({ text: '改过的一句话。', back: 0, made: 1 })
    // As many made up as left out: each made-up one is the picture missing at its place.
    expect(keptPictures(WAS, `${one}\n\n![lamp](pictures/lamp.png)\n\n${two}\n\n${three}\n\n![rain](pictures/rain.png)`)).toEqual({ text: `${one}\n\n${A}\n\n${two}\n\n${three}\n\n${B}`, back: 0, made: 0 })
    // The folder changed, the file not: the same picture.
    expect(keptPictures(WAS, `${one}\n\n![灯](images/a.png)\n\n${two}\n\n${three}`).text).toBe(`${one}\n\n${A}\n\n${two}\n\n${three}\n\n${B}`)
    // A picture the book has, named by a hand that may place one, is left where it was written.
    const placed = `${one}\n\n${A}\n\n${two}\n\n![门](assets/images/door.png)\n\n${three}\n\n${B}`
    expect(keptPictures(WAS, placed, { also: new Set(['assets/images/door.png']) })).toEqual({ text: placed, back: 0, made: 0 })
  })

  it('gives a picture run into a line its own line again, and keeps what the text says under it', () => {
    expect(keptPictures(WAS, `${one}${A}\n\n${two}\n\n${three}\n\n${B}`).text).toBe(`${one}\n\n${A}\n\n${two}\n\n${three}\n\n${B}`)
    expect(keptPictures(WAS, `${one}\n\n![一盏灯](assets/images/a.png)\n\n${two}\n\n${three}\n\n${B}`).text).toBe(`${one}\n\n${A}\n\n${two}\n\n${three}\n\n${B}`)
    // A translation's caption is the translation's.
    expect(keptPictures(WAS, `One.\n\n![a lamp](assets/images/a.png)\n\nTwo.\n\nThree.\n\n![rain](assets/images/b.png)`, { captions: 'theirs' }).text).toBe(`One.\n\n![a lamp](assets/images/a.png)\n\nTwo.\n\nThree.\n\n![rain](assets/images/b.png)`)
    // The white space the rewriting came with at either end is its own.
    expect(keptPictures(`${ONE}\n\n${A}`, `\n${one}\n`).text).toBe(`\n${one}\n\n${A}\n`)
  })
})

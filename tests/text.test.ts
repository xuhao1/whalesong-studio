// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { plainChapterTitle } from '../src/core/pipelines/plot'
import { changedCore, changedParts, clip, clipTail, countWords, embeddedImages, estimateTokens, fuzzyFind, occurrences, proseOnly, sentences, slugify } from '../src/shared/text'

describe('text helpers', () => {
  it('counts CJK characters and Latin words', () => {
    expect(countWords('夜雨敲窗，她在灯下磨剑。')).toBe(10)
    expect(countWords('The quick brown fox.')).toBe(4)
    expect(countWords('她说 hello world 两次')).toBe(6)
    expect(countWords('')).toBe(0)
  })

  it('estimates tokens in the right ballpark', () => {
    expect(estimateTokens('天'.repeat(1000))).toBeGreaterThan(900)
    expect(estimateTokens('word '.repeat(1000))).toBeLessThan(1600)
  })

  it('clips on sentence boundaries', () => {
    const text = '第一句话。第二句话更长一些。第三句话。'
    expect(clip(text, 16)).toBe('第一句话。第二句话更长一些。…')
    expect(clipTail(text, 8).endsWith('第三句话。')).toBe(true)
    expect(clip('short', 100)).toBe('short')
  })

  it('finds quotes despite whitespace and quote-style drift', () => {
    const text = '她抬起头，冷冷地说：“你来晚了。”\n\n他没有回答。'
    const range = fuzzyFind(text, '冷冷地说:"你来晚了。"')
    expect(range).toBeDefined()
    expect(text.slice(range!.start, range!.end)).toBe('冷冷地说：“你来晚了。”')
    expect(fuzzyFind(text, '不存在的句子')).toBeUndefined()
  })

  it('keeps CJK in slugs', () => {
    expect(slugify('沈 璃')).toBe('沈-璃')
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('***', 'x')).toBe('x')
  })

  it('separates prose from embedded illustrations', () => {
    const text = '第一段。\n\n![雨夜](assets/images/a.png)\n\n第二段。'
    expect(proseOnly(text)).toBe('第一段。\n\n第二段。')
    expect(embeddedImages(text)).toEqual([{ alt: '雨夜', path: 'assets/images/a.png' }])
  })
})


describe('what a rewriting of a passage changed', () => {
  it('cuts a text into sentences that join back into it, to the character', () => {
    const text = '她推门进来。“老朽夜里不接客。”他头也不抬……\n\n灯芯跳了一下！She stopped. "Not tonight," he said. 末尾没有句号'
    const cut = sentences(text)
    expect(cut.join('')).toBe(text)
    expect(cut.slice(0, 3)).toEqual(['她推门进来。', '“老朽夜里不接客。”', '他头也不抬……\n\n'])
    // A full stop inside a number or a name is not an end; a closing quote stays with its sentence.
    expect(sentences('第3.5章写到 Mr.Liu 的账。下一句。')).toEqual(['第3.5章写到 Mr.Liu 的账。', '下一句。'])
    expect(sentences('')).toEqual([])
  })

  it('counts how often a stretch stands in a text', () => {
    expect(occurrences('她点头。他也点头。她点头。', '她点头。')).toBe(2)
    expect(occurrences('aaa', 'aa')).toBe(2)
    expect(occurrences('她点头。', '')).toBe(0)
  })

  it('keeps of a passage and its rewriting only the sentences that differ, and says where they start', () => {
    // One sentence of three was changed: the proposal is of that sentence.
    expect(changedCore('她推门进来。他头也不抬。灯芯跳了一下。', '她推门进来。他把镊子搁下，才抬头。灯芯跳了一下。')).toEqual({ before: '他头也不抬。', after: '他把镊子搁下，才抬头。', start: 6 })
    // Paragraph breaks around it are nobody's change.
    expect(changedCore('甲。\n\n乙。\n\n丙。', '甲。\n\n乙改了。\n\n丙。')).toEqual({ before: '乙。', after: '乙改了。', start: 4 })
    // Something only added: the sentence it follows stays in, so there is a place to find.
    expect(changedCore('甲。乙。丙。', '甲。乙。新加的一句。丙。')).toEqual({ before: '乙。', after: '乙。新加的一句。', start: 2 })
    // …or, at the very top, the one it comes before.
    expect(changedCore('甲。乙。', '开头加一句。甲。乙。')).toEqual({ before: '甲。', after: '开头加一句。甲。', start: 0 })
    // Something only taken out.
    expect(changedCore('甲。乙。丙。', '甲。丙。')).toEqual({ before: '甲。乙。', after: '甲。', start: 0 })
    // Nothing changed, or nothing shared: the pair as given.
    expect(changedCore('甲。乙。', '甲。乙。')).toEqual({ before: '甲。乙。', after: '甲。乙。', start: 0 })
    expect(changedCore('甲。', '全换了。')).toEqual({ before: '甲。', after: '全换了。', start: 0 })
  })

  it('tells every place a text was changed apart from the others', () => {
    const was = '甲。乙。丙。\n\n丁。戊。己。\n\n庚。辛。'
    // Two sentences changed, far apart: two places, each of its own sentence.
    expect(changedParts(was, '甲。乙改了。丙。\n\n丁。戊。己。\n\n庚改了。辛。')).toEqual([
      { before: '乙。', after: '乙改了。', start: 2 },
      { before: '庚。', after: '庚改了。', start: 16 },
    ])
    // Something added, something taken out: each with the sentence beside it, so that there is a place to find.
    expect(changedParts(was, '甲。乙。丙。新的一句。\n\n丁。己。\n\n庚。辛。')).toEqual([
      { before: '丙。', after: '丙。新的一句。', start: 4 },
      { before: '丁。戊。', after: '丁。', start: 8 },
    ])
    // Changes in sentences that touch are one place.
    expect(changedParts(was, '甲。乙改。丙改。\n\n丁。戊。己。\n\n庚。辛。')).toEqual([{ before: '乙。丙。', after: '乙改。丙改。', start: 2 }])
    // A paragraph taken out whole goes with the one before it.
    expect(changedParts('甲。\n\n乙。\n\n丙。', '甲。\n\n丙。')).toEqual([{ before: '甲。\n\n乙。', after: '甲。', start: 0 }])
    // Nothing changed: no places. Everything changed: one.
    expect(changedParts(was, was)).toEqual([])
    expect(changedParts('甲。', '全换了。')).toEqual([{ before: '甲。', after: '全换了。', start: 0 }])
    // Put together again, place by place from the end, the places make the changed text of the original.
    const now = '开头加的。甲。乙改了。丙。\n\n丁。己。\n\n庚。辛。末尾加的。'
    let made = was
    for (const part of [...changedParts(was, now)].reverse()) {
      expect(made.slice(part.start, part.start + part.before.length)).toBe(part.before)
      made = made.slice(0, part.start) + part.after + made.slice(part.start + part.before.length)
    }
    expect(made).toBe(now)
  })

  it('widens a place until it is found once only, and joins the places that come to touch', () => {
    // "好。" stands three times: changed alone, the place takes in the sentence before it.
    const was = '他说：好。她想了想。乙。好。丙。丁。好。'
    const parts = changedParts(was, '他说：好。她想了想。乙。好的。丙。丁。好。', stretch => occurrences(was, stretch) === 1)
    expect(parts).toEqual([{ before: '乙。好。', after: '乙。好的。', start: 10 }])
    // Two of them changed with one sentence between: each widens to that sentence's side, and they do not swallow each other.
    const both = changedParts('甲。好。乙。丙。好。丁。', '甲。好的。乙。丙。好吧。丁。', stretch => occurrences('甲。好。乙。丙。好。丁。', stretch) === 1)
    expect(both).toEqual([{ before: '甲。好。', after: '甲。好的。', start: 0 }, { before: '丙。好。', after: '丙。好吧。', start: 6 }])
  })

  it('widens what it keeps until it is found once only', () => {
    // "好。" stands twice in the chapter: alone it could not say which one is meant.
    const chapter = '他说：好。她想了想。乙。好。丙。'
    const narrowed = changedCore('乙。好。丙。', '乙。好的。丙。', stretch => occurrences(chapter, stretch) === 1)
    expect(narrowed).toEqual({ before: '乙。好。', after: '乙。好的。', start: 0 })
    expect(occurrences(chapter, narrowed.before)).toBe(1)
    // Where no widening helps, the whole pair stands.
    expect(changedCore('好。好。', '好。好的。', () => false)).toEqual({ before: '好。好。', after: '好。好的。', start: 0 })
  })
})

describe('plainChapterTitle', () => {
  it('drops the numbering models put into chapter titles', () => {
    expect(plainChapterTitle('第1章：灰尘的味道')).toBe('灰尘的味道')
    expect(plainChapterTitle('第十二章 失落的频率')).toBe('失落的频率')
    expect(plainChapterTitle('Chapter 3 - The Ledger')).toBe('The Ledger')
    expect(plainChapterTitle('《回信》')).toBe('回信')
    expect(plainChapterTitle('第七日')).toBe('第七日')
    expect(plainChapterTitle('第3章')).toBe('第3章')
  })
})

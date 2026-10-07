// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { plainChapterTitle } from '../src/core/pipelines/plot'
import { clip, clipTail, countWords, embeddedImages, estimateTokens, fuzzyFind, proseOnly, slugify } from '../src/shared/text'

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

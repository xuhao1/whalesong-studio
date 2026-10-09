// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { learnNames, readTranslation, samePictures, settleTerms, stretches, translateChapters, untranslateChapter } from '../src/core/pipelines/translate'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }

describe('translating a book', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  /** A translator and a settler of names, by what they are asked. */
  const model = (translate: (request: LlmRequest) => string, terms: (request: LlmRequest) => unknown = () => ({ terms: [] })) => (request: LlmRequest): string => (request.system?.includes('定译名') === true || request.system?.includes('settling the names') === true ? JSON.stringify(terms(request)) : translate(request))

  it('cuts a text into stretches of whole paragraphs, and reads a reply for its title, its text and the names it settled', () => {
    const text = Array.from({ length: 10 }, (_, index) => `第${index + 1}段。${'字'.repeat(98)}`).join('\n\n')
    const cut = stretches(text, 320)
    expect(cut.length).toBeGreaterThan(2)
    expect(cut.join('\n\n')).toBe(text)
    expect(cut.every(part => part.split('\n\n').every(paragraph => /^第\d+段。字+$/.test(paragraph)))).toBe(true)
    // A paragraph longer than a stretch is a stretch of its own, not cut in two.
    expect(stretches(`${'长'.repeat(500)}\n\n短`, 100)).toEqual(['长'.repeat(500), '短'])

    const read = readTranslation('# The Ghostwriter\'s Rules\n\nRain. She wrote.\n\n![a pen](assets/images/pen.png)\n\n=====TERMS=====\n[{"source":"断肠斋","target":"Heartbreak Studio","kind":"place","note":"an old bookshop"},{"source":"","target":"x"},{"source":"寄死笔","target":"the Dead-Letter Pen","kind":"weapon"},{"source":"斋","target":"zhai","kind":"term"}]', true)
    expect(read).toEqual({ title: 'The Ghostwriter\'s Rules', text: 'Rain. She wrote.\n\n![a pen](assets/images/pen.png)', terms: [{ source: '断肠斋', target: 'Heartbreak Studio', kind: 'place', note: 'an old bookshop' }, { source: '寄死笔', target: 'the Dead-Letter Pen' }] })
    // A picture keeps its path whatever a translator made of it; what is said under it is the translation's.
    expect(samePictures('前文\n\n![柜台上的信](assets/images/a.png)\n\n![笔](assets/images/b.png "笔")', 'Before\n\n![Letters on the counter](assets/pictures/a.png)\n\n![The pen](资产/b.png)')).toBe('Before\n\n![Letters on the counter](assets/images/a.png)\n\n![The pen](assets/images/b.png "笔")')
    expect(samePictures('![a](x.png)', 'No picture here.')).toBe('No picture here.')
    // A later stretch has no title to read; a list that is broken leaves the translation standing.
    expect(readTranslation('# Not a title here\n\nText.', false)).toEqual({ text: '# Not a title here\n\nText.', terms: [] })
    expect(readTranslation('Text.\n=====TERMS=====\n[{"source": broken', false)).toEqual({ text: 'Text.', terms: [] })
  })

  it('settles the names off the cards — who somebody is goes with the name — and writes over nothing that is settled', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈蘅', aliases: ['阿蘅'], role: 'protagonist', gender: '女', tagline: '替人写信的女校书' })
    await project.saveCharacter({ name: '程砚秋', role: 'deuteragonist', gender: '男' })
    await project.saveWorld({ name: '断肠斋', category: 'location', importance: 2, summary: '四马路的旧书铺' })
    // The author settled one by hand already.
    await project.updateGlossary('en', () => [{ source: '程砚秋', target: 'Inspector Cheng', by: 'author' }])
    bed.llm.responder = model(() => '', () => ({ terms: [
      { source: '沈蘅', target: 'Shen Heng', kind: 'person', note: 'a woman; writes letters for others' },
      { source: '阿蘅', target: 'A-Heng', kind: 'person' },
      { source: '程砚秋', target: 'Cheng Yanqiu', kind: 'person' },
      { source: '断肠斋', target: 'Heartbreak Studio', kind: 'place' },
    ] }))
    const settled = await settleTerms(bed.core, bed.runtime, { to: 'en' }, task)
    const asked = bed.llm.requests.at(-1)!
    expect(asked.system).toContain('settling the names for the English translation')
    expect(asked.system).toContain('original: 简体中文')
    // What is to be settled: the two without a rendering, each with who or what they are and every other name; what is settled is said, and not asked again.
    expect(asked.prompt).toContain('- 沈蘅 | person | 女; 替人写信的女校书 | also: 阿蘅')
    expect(asked.prompt).toContain('- 断肠斋 | place | 四马路的旧书铺')
    expect(asked.prompt).toContain('## Settled already')
    expect(asked.prompt).toContain('程砚秋 → Inspector Cheng')
    expect(asked.prompt).not.toContain('- 程砚秋 |')
    expect(settled.added.map(term => `${term.source}=${term.target}|${term.of}`)).toEqual(['沈蘅=Shen Heng|character:沈蘅', '阿蘅=A-Heng|character:沈蘅', '断肠斋=Heartbreak Studio|world:断肠斋'])
    expect((await project.glossary('en')).find(term => term.source === '程砚秋')).toMatchObject({ target: 'Inspector Cheng', by: 'author' })
    expect(settled.total).toBe(4)
    // Everything has a rendering now: nobody is asked.
    const before = bed.llm.requests.length
    expect((await settleTerms(bed.core, bed.runtime, { to: 'en' }, task)).added).toEqual([])
    expect(bed.llm.requests.length).toBe(before)
    // Another language is another glossary.
    expect(await project.glossary('ja')).toEqual([])
  })

  it('translates chapters by the glossary, keeps the original as a version, and the cards learn their names', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈蘅', role: 'protagonist', gender: '女', tagline: '替人写信的女校书' })
    await project.saveCharacter({ name: '周衡', role: 'antagonist', gender: '男' })
    await project.saveWorld({ name: '断肠斋', category: 'location', importance: 2, summary: '四马路的旧书铺' })
    const one = await project.addChapter({ title: '代笔人的规矩' })
    const two = await project.addChapter({ title: '七日讣文' })
    const three = await project.addChapter({ title: '还没写的一章' })
    await project.saveChapterText(one.id, '雨夜，沈蘅在断肠斋后间写信。\n\n阿棠把信送了出去。')
    await project.saveChapterText(two.id, '沈蘅读到了讣文。')
    bed.llm.responder = model((request) => {
      if (request.prompt.includes('代笔人的规矩')) return '# The Ghostwriter\'s Rules\n\nOn a night of rain Shen Heng wrote a letter in the back room of Heartbreak Studio.\n\nA-Tang took the letter out.\n\n=====TERMS=====\n[{"source":"阿棠","target":"A-Tang","kind":"person","note":"a girl who carries letters"}]'
      return '# The Obituary of the Seventh Day\n\nShen Heng read the obituary.'
    }, () => ({ terms: [{ source: '沈蘅', target: 'Shen Heng', kind: 'person' }, { source: '周衡', target: 'Zhou Heng', kind: 'person' }, { source: '断肠斋', target: 'Heartbreak Studio', kind: 'place' }] }))

    const result = await translateChapters(bed.core, bed.runtime, { to: 'en', direction: 'British spelling' }, task)
    expect(result.translated.map(item => item.title)).toEqual(['The Ghostwriter\'s Rules', 'The Obituary of the Seventh Day'])
    expect(result.skipped).toEqual([{ chapter: three.id, why: 'empty' }])
    expect(result.failed).toEqual([])
    // The names were settled first (nothing was), and the one the translation met was added.
    expect(result.terms).toEqual({ added: 4, total: 4 })
    const first = bed.llm.requests.find(request => request.prompt.includes('代笔人的规矩') && request.system?.includes('literary translator') === true)!
    expect(first.system).toContain('from 简体中文 into English')
    expect(first.system).toContain('WHAT THE AUTHOR ASKS OF THE TRANSLATION\nBritish spelling')
    // The terms this chapter uses, with who and what they are — and not the one it does not use.
    expect(first.prompt).toContain('- 沈蘅 → Shen Heng（女; 替人写信的女校书）')
    expect(first.prompt).toContain('- 断肠斋 → Heartbreak Studio（四马路的旧书铺）')
    expect(first.prompt).not.toContain('周衡')
    expect(first.prompt).toContain('Title: 代笔人的规矩')
    // The translation is the chapter's text; what it was translated from is a version, and noted as its original.
    expect(await project.chapterText(one.id)).toBe('On a night of rain Shen Heng wrote a letter in the back room of Heartbreak Studio.\n\nA-Tang took the letter out.')
    expect((await project.findChapter(one.id))!.plan.title).toBe('The Ghostwriter\'s Rules')
    const noted = (await project.translations())[one.id]!
    expect(noted).toMatchObject({ from: 'zh', to: 'en' })
    expect(await project.versionText(one.id, noted.version!)).toBe('雨夜，沈蘅在断肠斋后间写信。\n\n阿棠把信送了出去。')
    // The cards go by their names in the translation too — whatever tells people by name still tells them.
    expect(result.named).toBe(3)
    expect((await project.findCharacter('沈蘅'))!.aliases).toEqual(['Shen Heng'])
    expect((await project.findCharacter('Shen Heng'))!.id).toBe('沈蘅')
    expect((await project.findWorld('断肠斋'))!.aliases).toEqual(['Heartbreak Studio'])
    // Every chapter with text is in English now: it is the book's language, and what it was is on record.
    expect(result.language).toBe('en')
    expect(await project.manifest()).toMatchObject({ language: 'en', translatedFrom: 'zh' })

    // Asked again, there is nothing to do: they are in the language already.
    const again = await translateChapters(bed.core, bed.runtime, { to: 'en' }, task)
    expect(again.translated).toEqual([])
    expect(again.skipped.map(item => item.why)).toEqual(['same', 'same', 'empty'])

    // The original of a chapter is put back; the translation is then a version in its turn.
    await untranslateChapter(bed.runtime, one.id)
    expect(await project.chapterText(one.id)).toBe('雨夜，沈蘅在断肠斋后间写信。\n\n阿棠把信送了出去。')
    expect((await project.findChapter(one.id))!.plan.title).toBe('代笔人的规矩')
    expect((await project.translations())[one.id]).toBeUndefined()
    await expect(untranslateChapter(bed.runtime, three.id)).rejects.toThrow(/no original on record/)
    expect(await learnNames(bed.runtime, 'en')).toBe(0)
  })

  it('finds the names in the text where the book has no cards, goes on from the chapter before, and one chapter that fails does not stop the rest', async () => {
    const { project } = bed.runtime
    await project.updateManifest({ language: 'en' })
    const one = await project.addChapter({ title: 'The Letter' })
    const two = await project.addChapter({ title: 'The Fire' })
    const three = await project.addChapter({ title: 'The Pen' })
    await project.saveChapterText(one.id, 'Eleanor wrote the letter at Marlow House.')
    await project.saveChapterText(two.id, 'Eleanor read of the fire.')
    await project.saveChapterText(three.id, 'The pen wrote by itself.')
    const scanned: string[] = []
    bed.llm.responder = model((request) => {
      if (request.prompt.includes('The Fire')) throw new Error('the model fell over')
      if (request.prompt.includes('The Letter')) return '# 那封信\n\n埃莉诺在马洛庄园写了那封信。'
      return '# 那支笔\n\n那支笔自己写了起来。'
    }, (request) => {
      scanned.push(request.prompt)
      return { terms: [{ source: 'Eleanor', target: '埃莉诺', kind: 'person', note: '女' }, { source: 'Marlow House', target: '马洛庄园', kind: 'place' }] }
    })
    const result = await translateChapters(bed.core, bed.runtime, { to: 'zh' }, task)
    // No cards: the text itself was read for its names.
    expect(scanned).toHaveLength(1)
    expect(scanned[0]).toContain('一段正文：找出里面还没定译名的专名')
    expect(scanned[0]).toContain('Eleanor wrote the letter at Marlow House.')
    expect((await project.glossary('zh')).map(term => `${term.source}→${term.target}`)).toEqual(['Eleanor→埃莉诺', 'Marlow House→马洛庄园'])
    expect(result.translated.map(item => item.title)).toEqual(['那封信', '那支笔'])
    expect(result.failed).toEqual([{ chapter: two.id, error: expect.stringContaining('the model fell over') }])
    // A name in letters is found whatever its case, and as a whole word only.
    const asked = bed.llm.requests.find(request => request.prompt.includes('The Letter') && request.system?.includes('文学译者') === true)!
    expect(asked.system).toContain('从English译成简体中文')
    expect(asked.prompt).toContain('- Eleanor → 埃莉诺（女）')
    expect(asked.prompt).toContain('- Marlow House → 马洛庄园')
    // One chapter is still in English: the book is not Chinese yet.
    expect(result.language).toBeUndefined()
    expect((await project.manifest()).language).toBe('en')
    expect(await project.chapterText(two.id)).toBe('Eleanor read of the fire.')

    // The one that failed, on its own: it goes on in the voice the chapter before it ends in.
    bed.llm.responder = model(() => '# 那场火\n\n埃莉诺读到了那场火。')
    const second = await translateChapters(bed.core, bed.runtime, { to: 'zh', chapters: [two.id] }, task)
    expect(second.translated.map(item => item.title)).toEqual(['那场火'])
    const last = bed.llm.requests.at(-1)!
    expect(last.prompt).toContain('## 译文到这里为止的结尾')
    expect(last.prompt).toContain('埃莉诺在马洛庄园写了那封信。')
    expect(second.language).toBe('zh')
    expect(await project.manifest()).toMatchObject({ language: 'zh', translatedFrom: 'en' })
  })

  it('translates a long chapter stretch by stretch, the title once', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '长章' })
    const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}段${'字'.repeat(900)}`)
    await project.saveChapterText(chapter.id, paragraphs.join('\n\n'))
    await project.updateGlossary('en', () => [{ source: '长章', target: 'The Long One' }])
    let calls = 0
    bed.llm.responder = model((request) => {
      calls += 1
      const numbers = [...request.prompt.matchAll(/第(\d+)段/g)].map(match => match[1])
      return `${request.prompt.includes('Title: 长章') ? '# The Long One\n\n' : ''}${numbers.map(number => `Paragraph ${number}.`).join('\n\n')}`
    })
    const result = await translateChapters(bed.core, bed.runtime, { to: 'en', chapters: [chapter.id], settle: false }, task)
    expect(calls).toBe(3)
    expect(result.translated).toEqual([{ chapter: chapter.id, title: 'The Long One', words: 24 }])
    expect(await project.chapterText(chapter.id)).toBe(Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n'))
    const asked = bed.llm.requests.filter(request => request.system?.includes('literary translator') === true)
    expect(asked[0]!.prompt).toContain('stretch 1/3 of this chapter')
    expect(asked[1]!.prompt).toContain('stretch 2/3 of this chapter; the title is translated already')
    // Each stretch after the first goes on from the end of the one before.
    expect(asked[1]!.prompt).toContain('## How the translation ends so far')
    expect(asked[1]!.prompt).toContain('Paragraph 4.')
  })
})

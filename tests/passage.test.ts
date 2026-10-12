// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A passage rewritten to an instruction: handed what bears on it — not the book — with what is asked said where it
 * is read. (Handed every chapter word for word, as a chapter's writing is, the instruction was one line at the end of
 * hundreds of thousands of tokens, and the passage came back hardly touched.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reviseSpan } from '../src/core/pipelines/revise'
import { estimateTokens } from '../src/shared/text'
import { PASSAGE_CONTEXT_DEFAULT } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

const filler = (mark: string): string => `${mark}\n\n${Array.from({ length: 240 }, (_unused, at) => `第 ${at} 段：雨落在青石板上，她数着屋檐滴下来的水，一滴，两滴，谁也没有先开口说话，灯芯爆了一下又暗下去。`).join('\n\n')}`

describe('a passage rewritten to an instruction', () => {
  let bed: TestBed
  let chapterId: string
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥' })
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强寡言' })
    for (const [title, mark] of [['一', '【第一章独有的一句】'], ['二', '【第二章独有的一句】'], ['三', '【第三章独有的一句】']] as const) {
      const made = await project.addChapter({ title, synopsis: `第${title}章的梗概。` })
      await project.saveChapterText(made.id, filler(mark))
    }
    const here = await project.addChapter({ title: '四', synopsis: '沈璃在渡口等船。' })
    chapterId = here.id
    await project.saveChapterText(chapterId, '渡口的风很硬。\n\n沈璃把斗笠压低，一句话也没有说。\n\n船夫看了她一眼。')
    for (const [title, mark] of [['五', '【第五章独有的一句】'], ['六', '【第六章独有的一句】']] as const) {
      const made = await project.addChapter({ title, synopsis: `第${title}章的梗概。` })
      await project.saveChapterText(made.id, filler(mark))
    }
  })
  afterEach(async () => { await bed.cleanup() })

  it('is handed the story around its chapter within a budget of its own — not every chapter of the book', async () => {
    bed.llm.responder = () => '沈璃一把掀开斗笠：“渡不渡？给句话。”'
    const done = await reviseSpan(bed.core, bed.runtime, { chapter: chapterId, quote: '沈璃把斗笠压低，一句话也没有说。', instruction: '让她先开口，不耐烦地催船夫。' }, { origin: 'user' })
    expect(done.after).toBe('沈璃一把掀开斗笠：“渡不渡？给句话。”')
    const request = bed.llm.requests[0]!
    // The whole of it stays near the budget — the chapters of this bed alone run to several times that.
    expect(estimateTokens(request.prompt)).toBeLessThan(PASSAGE_CONTEXT_DEFAULT * 1.5)
    // Of the five other chapters, what fits travels word for word — the nearest — and the rest is told by its outline
    // (a passage looked up in one of them may still be there: that is a few lines, not the chapter).
    const whole = request.prompt.split('第 239 段：').length - 1
    expect(whole).toBeGreaterThanOrEqual(1)
    expect(whole).toBeLessThan(5)
    expect(request.prompt).toContain('【第三章独有的一句】')
    expect(request.prompt).toContain('第一章的梗概。')
    // Its own chapter around the passage is there whole.
    for (const part of ['渡口的风很硬。', '船夫看了她一眼。']) expect(request.prompt, part).toContain(part)
  })

  it('says what is asked before the passage and once more at the end, and that it holds over outline and text', async () => {
    bed.llm.responder = () => '沈璃一把掀开斗笠：“渡不渡？给句话。”'
    await reviseSpan(bed.core, bed.runtime, { chapter: chapterId, quote: '沈璃把斗笠压低，一句话也没有说。', instruction: '让她先开口，不耐烦地催船夫。' }, { origin: 'user' })
    const { prompt, system } = bed.llm.requests[0]!
    const asked = prompt.indexOf('## 修改要求（这次改稿要做到的）\n\n让她先开口，不耐烦地催船夫。')
    const passage = prompt.indexOf('<<<\n沈璃把斗笠压低，一句话也没有说。\n>>>')
    expect(asked).toBeGreaterThan(0)
    expect(passage).toBeGreaterThan(asked)
    expect(prompt.endsWith('照修改要求把 <<< >>> 里的那一段改好，只输出改好的这一段。\n修改要求：让她先开口，不耐烦地催船夫。')).toBe(true)
    for (const part of ['照它改到位', '不是在原句上添几个词', '以修改要求为准——那是作者要改的']) expect(system, part).toContain(part)
  })

  it('carries as much as the author sets for it', async () => {
    await bed.core.settings.update({ context: { ...bed.core.currentSettings().context, passageTokens: 400_000 } })
    bed.llm.responder = () => '沈璃一把掀开斗笠。'
    await reviseSpan(bed.core, bed.runtime, { chapter: chapterId, quote: '沈璃把斗笠压低，一句话也没有说。', instruction: '让她先开口。' }, { origin: 'user' })
    const { prompt } = bed.llm.requests[0]!
    for (const part of ['【第一章独有的一句】', '【第三章独有的一句】', '【第六章独有的一句】']) expect(prompt, part).toContain(part)
  })
})

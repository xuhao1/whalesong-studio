// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter revised — written over whole to an instruction, or gone through and changed where it stands — is handed
 * the chapters next to it and what of the bible it touches: not what the book is written on with. (Handed half the
 * model's window, either carried nearly the whole of a long book; the one that works as an agent sent that again
 * with every step it took.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { amendChapter } from '../src/core/pipelines/amend'
import { reviewChapter } from '../src/core/pipelines/review'
import { reviseChapter } from '../src/core/pipelines/revise'
import { estimateTokens } from '../src/shared/text'
import { CHAPTER_CONTEXT_DEFAULT } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

const filler = (mark: string): string => `${mark}\n\n${Array.from({ length: 120 }, (_unused, at) => `第 ${at} 段：雨落在青石板上，她数着屋檐滴下来的水，一滴，两滴，谁也没有先开口说话，灯芯爆了一下又暗下去。`).join('\n\n')}`
const OWN = '渡口的风很硬。\n\n沈璃把斗笠压低，一句话也没有说。\n\n船夫看了她一眼。'
const task = { origin: 'user' as const }

describe('a chapter revised', () => {
  let bed: TestBed
  let chapterId: string
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥' })
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强寡言' })
    for (const title of ['一', '二', '三', '四', '五']) {
      const made = await project.addChapter({ title, synopsis: `第${title}章的梗概。` })
      await project.saveChapterText(made.id, filler(`【第${title}章独有的一句】`))
    }
    const here = await project.addChapter({ title: '六', synopsis: '沈璃在渡口等船。' })
    chapterId = here.id
    await project.saveChapterText(chapterId, OWN)
    for (const title of ['七', '八']) {
      const made = await project.addChapter({ title, synopsis: `第${title}章的梗概。` })
      await project.saveChapterText(made.id, filler(`【第${title}章独有的一句】`))
    }
  })
  afterEach(async () => { await bed.cleanup() })

  /** How many of the other chapters a request carries to their last paragraph. */
  const whole = (prompt: string): number => prompt.split('第 119 段：').length - 1

  /** What a revision of the chapter is to carry: itself whole, its neighbours word for word, the far chapters told. */
  const sized = (prompt: string): void => {
    expect(estimateTokens(prompt)).toBeLessThan(CHAPTER_CONTEXT_DEFAULT * 1.2)
    for (const part of ['渡口的风很硬。', '沈璃把斗笠压低，一句话也没有说。', '船夫看了她一眼。']) expect(prompt, part).toContain(part)
    for (const part of ['【第五章独有的一句】', '【第七章独有的一句】']) expect(prompt, part).toContain(part)
    // Of the seven other chapters the nearest travel word for word; the far ones are told by their outline (a passage
    // looked up in one of them may still be there: that is a few lines of it, not the chapter).
    expect(whole(prompt)).toBeGreaterThanOrEqual(2)
    expect(whole(prompt)).toBeLessThan(7)
    expect(prompt).toContain('第1章《一》  第一章的梗概。')
  }

  it('written over whole, goes with its neighbours — not with every chapter the window would hold', async () => {
    bed.llm.responder = () => '渡口的风很硬。\n\n沈璃一把掀开斗笠：“渡不渡？”\n\n船夫看了她一眼。'
    const done = await reviseChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '让她先开口，不耐烦地催船夫。' }, task)
    expect(done.after).toContain('渡不渡？')
    const { prompt } = bed.llm.requests[0]!
    sized(prompt)
    // What is asked still closes the request.
    expect(prompt).toContain('## 修改要求\n\n让她先开口，不耐烦地催船夫。')
  })

  it('gone through by an agent, the task it is sent with every step is of that size too', async () => {
    bed.roles.enabled = true
    bed.roles.script = async (_run, call) => {
      await call('chapter_edit', { find: '沈璃把斗笠压低，一句话也没有说。', replace: '沈璃一把掀开斗笠：“渡不渡？”' })
      await call('submit_revision', { note: '改了一处。' })
    }
    const done = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '让她先开口，不耐烦地催船夫。' }, task)
    expect(done.places).toBe(1)
    expect(bed.roles.tasks).toHaveLength(1)
    sized(bed.roles.tasks[0]!.prompt)
  })

  it('asked once for a list of changes, the same', async () => {
    bed.llm.responder = () => JSON.stringify({ edits: [{ find: '沈璃把斗笠压低，一句话也没有说。', replace: '沈璃一把掀开斗笠：“渡不渡？”' }], note: '改了一处。' })
    await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '让她先开口，不耐烦地催船夫。' }, task)
    sized(bed.llm.requests[0]!.prompt)
  })

  it('whole, however little room there is: the chapter worked on is never cut to its end', async () => {
    // A long chapter, and next to nothing left beside the story's text (a small window; a context cut to size).
    const { project } = bed.runtime
    const long = `【这一章的第一句】\n\n${filler('').trim()}\n\n【这一章的最后一句】`
    await project.saveChapterText(chapterId, long)
    await bed.core.settings.update({ context: { ...bed.core.currentSettings().context, sideTokens: 3000, chapterTokens: 8000 } })
    bed.llm.responder = () => long.replace('【这一章的第一句】', '【改过的第一句】')
    await reviseChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '改第一句。' }, task)
    for (const part of ['【这一章的第一句】', '第 0 段：', '第 119 段：', '【这一章的最后一句】']) expect(bed.llm.requests[0]!.prompt, part).toContain(part)
    // Gone through in place; and reviewed.
    bed.llm.requests.length = 0
    bed.llm.responder = () => JSON.stringify({ edits: [{ find: '【这一章的第一句】', replace: '【改过的第一句】' }], note: '改了。' })
    await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '改第一句。' }, task)
    for (const part of ['【这一章的第一句】', '【这一章的最后一句】']) expect(bed.llm.requests[0]!.prompt, part).toContain(part)
    bed.llm.requests.length = 0
    bed.llm.responder = () => JSON.stringify({ verdict: '可以。', issues: [] })
    await reviewChapter(bed.core, bed.runtime, { chapter: chapterId }, task)
    for (const part of ['【这一章的第一句】', '【这一章的最后一句】']) expect(bed.llm.requests[0]!.prompt, part).toContain(part)
  })

  it('carries as much as the author sets for it', async () => {
    await bed.core.settings.update({ context: { ...bed.core.currentSettings().context, chapterTokens: 400_000 } })
    bed.llm.responder = () => OWN.replace('一句话也没有说', '先开了口')
    await reviseChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '让她先开口。' }, task)
    const { prompt } = bed.llm.requests[0]!
    expect(whole(prompt)).toBe(7)
  })
})

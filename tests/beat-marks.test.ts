// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Where each beat begins in a chapter's text (#483), and what is written before a failure kept (#482).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { beatsAt, lastBeat, takeMarks } from '../src/core/beatmarks'
import { LlmCallError } from '../src/core/llm'
import { reviseSpan } from '../src/core/pipelines/revise'
import { writeChapter } from '../src/core/pipelines/write'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const beats = ['陆沉到渡口', '沈璃不给', '账本被翻出来', '阿棠送信来', '陆沉让步', '船离岸'].map((summary, at) => ({ id: `b${at + 1}`, summary }))

describe('beat marks', () => {
  it('takes the marks out of a piece and keeps where each beat begins', () => {
    const { text, marks } = takeMarks('【节拍 1】\n渡口的风很硬。\n陆沉站着。\n\n【节拍 2】\n“不给。”沈璃说。', beats, 0, 2)
    expect(text).toBe('渡口的风很硬。\n陆沉站着。\n\n“不给。”沈璃说。')
    expect(marks).toEqual([{ beat: 'b1', head: '渡口的风很硬。' }, { beat: 'b2', head: '“不给。”沈璃说。' }])
    // Unmarked, the first beat of the piece begins at its first paragraph; gone on with, it is not begun again.
    expect(takeMarks('渡口的风很硬。', beats, 3, 4).marks).toEqual([{ beat: 'b4', head: '渡口的风很硬。' }])
    expect(takeMarks('渡口的风很硬。\n[[beat 5]]\n他让了。', beats, 3, 4, false).marks).toEqual([{ beat: 'b5', head: '他让了。' }])
  })

  it('finds the beats in the text, the one it ends in, and the ones a stretch lies in', () => {
    const text = '渡口的风很硬。\n陆沉站着。\n\n“不给。”沈璃说。\n她转身。'
    const marks = [{ beat: 'b1', head: '渡口的风很硬。' }, { beat: 'b2', head: '“不给。”沈璃说。' }]
    expect(lastBeat(text, beats, marks)).toBe(1)
    expect(beatsAt(text, beats, marks, text.indexOf('陆沉站着'), text.indexOf('陆沉站着') + 3)).toEqual([0])
    expect(beatsAt(text, beats, marks, text.indexOf('她转身'), text.length)).toEqual([1])
    expect(beatsAt(text, beats, marks, 0, text.length)).toEqual([0, 1])
    // A beat whose opening paragraph was rewritten is lost; the others hold.
    expect(lastBeat(text.replace('“不给。”沈璃说。', '沈璃摇头。'), beats, marks)).toBe(0)
  })
})

describe('a chapter written by its beats', () => {
  let bed: TestBed
  let here: string
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'rules', partBeats: 2 } })
    here = (await bed.runtime.project.addChapter({ title: '二', synopsis: '陆沉来讨那支笔。', beats })).id
  })
  afterEach(async () => { await bed.cleanup() })

  it('keeps what was written when a part fails, and goes on from the beat it broke off in', async () => {
    const { core, runtime, llm } = bed
    const writers = (): typeof llm.requests => llm.requests.filter(request => request.route.for?.role === 'writer')
    llm.responder = (request) => {
      const n = writers().length
      if (n === 1) return '【节拍 1】\n渡口的风很硬。\n【节拍 2】\n“不给。”沈璃说。'
      // The second part breaks off in beat 3, after a sentence of it.
      request.onText?.('【节拍 3】\n账本摊在桌上。', '【节拍 3】\n账本摊在桌上。')
      throw new LlmCallError('Provider finish_reason: content_filter', 'FILTERED')
    }
    const failed = await writeChapter(core, runtime, { chapter: here, digest: false }, task).then(() => new Error('written'), (error: unknown) => error as Error)
    expect(failed).toBeInstanceOf(Error)
    expect(failed.message).toContain('保存在这一章里了')
    // The first part, and the part of the second that came: kept, with no mark left in the text.
    expect(await runtime.project.chapterText(here)).toBe('渡口的风很硬。\n“不给。”沈璃说。\n\n账本摊在桌上。')
    expect((await runtime.project.beatMarks(here)).map(mark => mark.beat)).toEqual(['b1', 'b2', 'b3'])

    // Gone on with: from beat 3, which may not be finished, by the beats after it.
    llm.responder = request => request.prompt.includes('照常收住') ? '【节拍 5】\n陆沉让了。\n【节拍 6】\n船离了岸。' : '他翻到最后一页。\n【节拍 4】\n阿棠跑进来。'
    const before = writers().length
    await writeChapter(core, runtime, { chapter: here, mode: 'continue', digest: false }, task)
    const asked = writers().slice(before)
    expect(asked).toHaveLength(2)
    expect(asked[0]!.prompt).toContain('本章已有正文写到了第 3 个节拍')
    expect(asked[0]!.prompt).toContain('第 3–4 个节拍')
    expect(asked[1]!.prompt).toContain('第 5–6 个节拍')
    expect(await runtime.project.chapterText(here)).toContain('账本摊在桌上。\n\n他翻到最后一页。\n阿棠跑进来。')
    expect((await runtime.project.beatMarks(here)).map(mark => mark.beat)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
  })

  it('tells whoever rewrites a passage which beat it belongs to', async () => {
    const { core, runtime, llm } = bed
    llm.responder = request => request.prompt.includes('照常收住') ? '【节拍 5】\n陆沉让了。\n【节拍 6】\n船离了岸。' : request.prompt.includes('第 3–4') ? '【节拍 3】\n账本摊在桌上。\n【节拍 4】\n阿棠跑进来。' : '【节拍 1】\n渡口的风很硬。\n【节拍 2】\n“不给。”沈璃说。'
    await writeChapter(core, runtime, { chapter: here, digest: false }, task)
    llm.responder = () => '阿棠喘着气跑进来。'
    const before = llm.requests.length
    await reviseSpan(core, runtime, { chapter: here, quote: '阿棠跑进来。', instruction: '写得急一点' } as never, task)
    const asked = llm.requests.slice(before).find(request => request.prompt.includes('写得急一点'))
    expect(asked?.prompt).toContain('这段文字属于章纲里的节拍\n4. 阿棠送信来')
  })
})

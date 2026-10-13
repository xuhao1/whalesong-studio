// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A style's extra system prompt (`StyleProfile.system`): words of the author's own, kept with the style, and sent as
 * they are — under a heading of their own, after the style — to whoever writes the words of the book in that style.
 * A style that has none adds nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeChapter } from '../src/core/pipelines/write'
import { reviseBook, reviseChapter, reviseSpan } from '../src/core/pipelines/revise'
import { amendChapter } from '../src/core/pipelines/amend'
import { styleSample } from '../src/core/pipelines/bible'
import { readBook } from '../src/core/reading'
import { styleExtra, withStyleExtra } from '../src/core/render'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
// What an author may well paste: several lines, a colon, quotes, a rule of dashes, a hash, and space around it.
const EXTRA = '你写的是民国旧事，用词不出一九三零年代。\n\n- 对白：短，"话到嘴边留半句"\n---\n# 不要现代网络用语：例如“破防”'
const HEAD = '【作者的额外要求】'
const HEAD_IN = '【作者给写手的额外要求】（你写进书里的文字同样照办；怎么交稿仍照上面说的）'

describe('a style\'s extra system prompt', () => {
  let bed: TestBed
  let one: string
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '七日未寄', settings: { materialBy: 'rules', mendBy: undefined, partBeats: 0 } })
    const { project } = bed.runtime
    one = (await project.addChapter({ title: '渡口', synopsis: '她在渡口等。' })).id
    await project.saveChapterText(one, '渡口没有人。\n\n她等了一夜。')
  })
  afterEach(async () => { await bed.cleanup() })

  const active = async () => (await bed.runtime.project.activeStyle())!
  const writers = (): LlmRequest[] => bed.llm.requests.filter(request => request.route.for?.role === 'writer')

  it('is kept with the style as the author wrote it, and taken off it by saving it empty', async () => {
    const { project } = bed.runtime
    const style = await active()
    expect(style.system).toBeUndefined()
    await project.saveStyle({ id: style.id, system: `\n${EXTRA}\n  ` })
    // Read again from the book: every line, colon, quote and dash as it was (the space around it is not the author's).
    expect((await project.findStyle(style.id))!.system?.trim()).toBe(EXTRA)
    // Another field saved leaves it where it is — a style changed by a role or set by a sample does not lose it.
    await project.saveStyle({ id: style.id, tone: '冷' })
    expect((await project.findStyle(style.id))!.system?.trim()).toBe(EXTRA)
    expect((await project.findStyle(style.id))!.tone).toBe('冷')
    // Saved empty, the style has none.
    await project.saveStyle({ id: style.id, system: '' })
    expect('system' in (await project.findStyle(style.id))!).toBe(false)
  })

  it('is said under a heading of its own, and not at all where there is none', async () => {
    const style = await active()
    expect(styleExtra(style, 'zh')).toBeUndefined()
    expect(styleExtra({ ...style, system: '   \n ' }, 'zh')).toBeUndefined()
    expect(withStyleExtra('系统提示', style, 'zh')).toBe('系统提示')
    expect(withStyleExtra('系统提示', { ...style, system: EXTRA }, 'zh')).toBe(`系统提示\n\n${HEAD}\n${EXTRA}`)
    expect(styleExtra({ ...style, system: EXTRA }, 'zh', true)).toBe(`${HEAD_IN}\n${EXTRA}`)
    expect(styleExtra({ ...style, system: 'No slang.' }, 'en')).toBe('FROM THE AUTHOR\nNo slang.')
  })

  it('ends the system prompt of a chapter written, a passage rewritten and a chapter written over — and is heard in a sample', async () => {
    const { core, runtime, llm } = bed
    const style = await active()
    llm.responder = () => '渡口空无一人。'
    // Without it: nothing of the kind is sent.
    await writeChapter(core, runtime, { chapter: one, digest: false }, task)
    expect(writers()[0]!.system).not.toContain(HEAD)
    const plain = writers()[0]!.system!

    await runtime.project.saveStyle({ id: style.id, system: EXTRA })
    llm.requests.length = 0
    await writeChapter(core, runtime, { chapter: one, digest: false }, task)
    // The system prompt as it was, and the author's words after it, as they wrote them.
    expect(writers()[0]!.system).toBe(`${plain}\n\n${HEAD}\n${EXTRA}`)
    // (The same head for the next chapter of the book: what a provider has kept of it is read again.)
    const two = (await runtime.project.addChapter({ title: '旧账', synopsis: '翻旧账。' })).id
    await writeChapter(core, runtime, { chapter: two, digest: false }, task)
    expect(writers()[1]!.system).toBe(writers()[0]!.system)

    llm.requests.length = 0
    await runtime.project.saveChapterText(one, '渡口没有人。\n\n她等了一夜。')
    await reviseSpan(core, runtime, { chapter: one, quote: '渡口没有人。', instruction: '换个说法' }, task)
    llm.responder = () => '渡口空无一人。\n\n她等了一夜又一夜。'
    await reviseChapter(core, runtime, { chapter: one, instruction: '重写' }, task)
    expect(llm.requests).toHaveLength(2)
    for (const request of llm.requests) expect(request.system!.endsWith(`\n\n${HEAD}\n${EXTRA}`)).toBe(true)

    // A sample of the style: the author's words are its system prompt — what they add is heard before a chapter is written.
    llm.requests.length = 0
    llm.responder = () => '雨落在青石板上。'
    await styleSample(core, runtime, {}, task)
    expect(llm.requests[0]!.system).toBe(`${HEAD}\n${EXTRA}`)
    // …and of a draft of the style not saved yet.
    await styleSample(core, runtime, { draft: { ...style, system: '只写白描。' } }, task)
    expect(llm.requests[1]!.system).toBe(`${HEAD}\n只写白描。`)
    await styleSample(core, runtime, { draft: { ...style } }, task)
    expect(llm.requests[2]!.system).toBeUndefined()
  })

  it('is told to whoever writes the words of a revision, with how the work is handed in left as it was', async () => {
    const { core, runtime, llm } = bed
    const style = await active()
    await runtime.project.saveStyle({ id: style.id, system: EXTRA })
    const planner = (request: LlmRequest): boolean => request.route.for?.role === 'architect' && request.prompt.includes('"edits"')
    // The planner writes the changed words itself: told with the style, in what it is asked — its own system prompt is its own.
    await core.settings.update({ mendBy: 'planner' })
    llm.responder = request => planner(request) ? JSON.stringify({ edits: [{ chapter: 1, find: '她等了一夜。', replace: '她等了两夜。', why: '照要求' }], chapters: [], note: '一处。' }) : '不该问到写手'
    const direct = await reviseBook(core, runtime, { instruction: '等的是两夜', asked: true }, task)
    expect(direct.direct).toBe(true)
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]!.prompt).toContain(`${HEAD_IN}\n${EXTRA}`)
    expect(llm.requests[0]!.system).not.toContain(EXTRA)
    // The planner only settles where, the writer rewrites the place: the writer's system prompt ends with it.
    await core.settings.update({ mendBy: 'writer' })
    llm.requests.length = 0
    llm.responder = request => planner(request) ? JSON.stringify({ edits: [{ chapter: 1, find: '渡口没有人。', how: '换个说法' }], chapters: [], note: '一处。' }) : '渡口空无一人。'
    await reviseBook(core, runtime, { instruction: '渡口那句换个说法', asked: true }, task)
    const [settles, rewrites] = llm.requests
    expect(settles!.prompt).not.toContain(EXTRA)
    expect(settles!.system).not.toContain(EXTRA)
    expect(rewrites!.system!.endsWith(`\n\n${HEAD}\n${EXTRA}`)).toBe(true)

    // A chapter gone through place by place: the one who goes through it hands in changes, and is told the same.
    bed.roles.enabled = true
    let rules = ''
    bed.roles.script = async (agent, call) => {
      rules = agent.rules ?? ''
      await call('chapter_edit', { find: '她等了一夜。', replace: '她等了一夜，天亮才走。' })
      await call('submit_revision', { note: '一处。' })
    }
    await amendChapter(core, runtime, { chapter: one, instruction: '结尾收一下' }, task)
    expect(rules.endsWith(`\n\n${HEAD_IN}\n${EXTRA}`)).toBe(true)
  })

  it('is shown to a role that reads the style', async () => {
    const { runtime } = bed
    const style = await active()
    expect((await readBook(runtime, { what: 'style' })).text).not.toContain(HEAD)
    await runtime.project.saveStyle({ id: style.id, system: EXTRA })
    expect((await readBook(runtime, { what: 'style' })).text).toContain(`${HEAD}\n${EXTRA}`)
  })
})

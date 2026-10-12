// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter's memory: what its digest leaves in the book, how a chapter is
 * drafted anew without it, and how it is cleared.
 *
 * A digest fills the blanks of the chapter's plan, marks the threads the
 * chapter touched and suggests what it met. All of that describes one draft.
 * Drafted again, a chapter is written by what was meant for it — the same
 * material as the first time — and none of what its last draft happened to be.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { digestChapter, forgetChapter } from '../src/core/pipelines/digest'
import { writeChapter } from '../src/core/pipelines/write'
import { readBook, searchBook } from '../src/core/reading'
import type { RoleTask } from '../src/core/roles'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }

/** What the scribe makes of the chapter's first draft: where and when it was, a thread it moved on, one it planted. */
const FIRST = JSON.stringify({
  brief: '【旧稿的梗概】沈璃在码头截住了陆沉。',
  summary: '沈璃追到十六铺码头，在货栈廊下截住陆沉，要回了那支笔。',
  storyTime: '【旧稿的时间】腊月初七清晨',
  locations: ['【旧稿的地点】十六铺码头'],
  characters: [{ name: '沈璃', role: '追到码头', stateAfter: '拿回了笔', lifecycle: 'present' }],
  facts: [{ subject: '寄死笔', statement: '【旧稿的事实】笔回到了沈璃手里', kind: 'item' }],
  newEntities: [{ name: '货栈廊下', kind: 'location', description: '【旧稿新出的地点】' }],
  threads: [{ title: '没寄出的信', action: 'advance', note: '【旧稿推进了这条线】' }, { title: '【旧稿新埋的线】码头的红伞', action: 'plant' }],
})

/** And of its second draft, which went another way. */
const SECOND = JSON.stringify({
  brief: '沈璃没有去码头，在铺子里等到了陆沉。',
  summary: '沈璃守在铺子里，陆沉自己找上门来。',
  storyTime: '腊月初七夜里',
  locations: ['回文巷的铺子'],
  characters: [{ name: '沈璃', role: '守在铺子里', stateAfter: '等到了人', lifecycle: 'present' }],
  facts: [],
  newEntities: [],
  threads: [{ title: '缺页的账本', action: 'advance' }],
})

describe('a chapter\'s memory', () => {
  let bed: TestBed
  let ids: string[]
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥', settings: { materialBy: 'rules' } })
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', tagline: '渡口的摆渡人' })
    await project.saveCharacter({ name: '陆沉', role: 'supporting', tagline: '账房先生' })
    await project.saveThread({ title: '没寄出的信', kind: 'foreshadow', status: 'open', description: '三年前那封信。' })
    await project.saveThread({ title: '缺页的账本', kind: 'mystery', status: 'open', description: '账本少了一页。' })
    ids = []
    for (const title of ['一', '二']) {
      const made = await project.addChapter({ title, synopsis: `第${title}章的梗概。` })
      await project.saveChapterText(made.id, `第${title}章的正文。雨落在青石板上。`)
      ids.push(made.id)
    }
    // The chapter in hand: planned with a line of what happens and who is in it — no place, no time, no threads.
    const here = await project.addChapter({ title: '三', synopsis: '陆沉来讨那支笔，沈璃不给。', characters: [(await project.findCharacter('沈璃'))!.id] })
    ids.push(here.id)
  })
  afterEach(async () => { await bed.cleanup() })

  /** The writer writes; the scribe says of the chapter what `digest` holds. */
  const answer = (prose: string, digest: string): void => {
    bed.llm.responder = request => (request.prompt.includes('请做场记') ? digest : prose)
  }
  const sentToWriter = (): { stable: string; prompt: string }[] => bed.llm.requests.filter(request => request.route.for?.role === 'writer').map(request => ({ stable: request.stable ?? '', prompt: request.prompt }))

  it('is left out when the chapter is drafted anew: the second draft is written from what the first was', async () => {
    const { core, runtime } = bed
    const { project } = runtime
    const here = ids[2]!
    answer('旧稿：沈璃追到了码头。', FIRST)
    await writeChapter(core, runtime, { chapter: here, digest: true }, task)

    // The digest left its marks: the blanks of the plan filled, and said to be read off the text; the threads marked.
    const plan = (await project.findChapter(here))!.plan
    expect(plan).toMatchObject({ location: '【旧稿的地点】十六铺码头', time: '【旧稿的时间】腊月初七清晨', synopsis: '陆沉来讨那支笔，沈璃不给。' })
    expect([...(plan.fromText ?? [])].sort()).toEqual(['location', 'threads', 'time'])
    const threads = (await project.outline()).threads
    expect(threads.find(thread => thread.title === '没寄出的信')?.advanced).toEqual([here])
    expect(threads.find(thread => thread.title.includes('码头的红伞'))).toMatchObject({ auto: true, planted: [here] })
    expect((await project.chapterInfos()).find(info => info.id === here)).toMatchObject({ digested: true, memory: 'current' })

    answer('新稿：沈璃守在铺子里。', SECOND)
    await writeChapter(core, runtime, { chapter: here, digest: false }, task)
    const [first, second] = sentToWriter()
    // Nothing of the first draft, nor of what was read off it, reached the second.
    for (const part of ['【旧稿的地点】', '【旧稿的时间】', '【旧稿的梗概】', '【旧稿的事实】', '【旧稿推进了这条线】', '码头的红伞', '旧稿：沈璃追到了码头', '★本章涉及']) {
      expect(`${second!.stable}\n${second!.prompt}`, part).not.toContain(part)
    }
    // It is the same request, to the letter.
    expect(second!.stable).toBe(first!.stable)
    expect(second!.prompt).toBe(first!.prompt)
    // The chapter has a new text and the memory of the old one: said, not hidden.
    expect((await project.chapterInfos()).find(info => info.id === here)).toMatchObject({ digested: false, memory: 'stale' })
  })

  it('is taken back when the chapter is digested again: nothing of a text that is gone stays behind', async () => {
    const { core, runtime } = bed
    const { project } = runtime
    const here = ids[2]!
    answer('旧稿：沈璃追到了码头。', FIRST)
    await writeChapter(core, runtime, { chapter: here, digest: true }, task)
    expect((await project.suggestions()).map(item => item.title)).toEqual(['新设定：货栈廊下'])

    answer('新稿：沈璃守在铺子里。', SECOND)
    await writeChapter(core, runtime, { chapter: here, digest: true }, task)
    const threads = (await project.outline()).threads
    // The thread the old draft moved on is as it was; the one only the old draft planted is no thread; the new draft's mark is there.
    expect(threads.find(thread => thread.title === '没寄出的信')?.advanced).toBeUndefined()
    expect(threads.some(thread => thread.title.includes('码头的红伞'))).toBe(false)
    expect(threads.find(thread => thread.title === '缺页的账本')?.advanced).toEqual([here])
    // The blanks are filled from the chapter as it now is; what the old draft suggested no longer waits.
    const plan = (await project.findChapter(here))!.plan
    expect(plan).toMatchObject({ location: '回文巷的铺子', time: '腊月初七夜里', threads: [threads.find(thread => thread.title === '缺页的账本')!.id] })
    expect([...(plan.fromText ?? [])].sort()).toEqual(['location', 'threads', 'time'])
    expect(await project.suggestions()).toEqual([])
  })

  it('is cleared on the author\'s word: the digest, and what it left in the book', async () => {
    const { core, runtime } = bed
    const { project } = runtime
    const here = ids[2]!
    answer('旧稿：沈璃追到了码头。', FIRST)
    await writeChapter(core, runtime, { chapter: here, digest: true }, task)
    expect((await project.findCharacter('沈璃'))!.lastAppearance).toBe(here)

    const done = await forgetChapter(core, runtime, here)
    expect(done).toMatchObject({ chapterId: here, forgot: true, threads: 2, gone: 1, suggestions: 1 })
    expect([...done.fields].sort()).toEqual(['location', 'threads', 'time'])
    expect(await project.memory(here)).toBeUndefined()
    const plan = (await project.findChapter(here))!.plan
    // What was meant for the chapter stands; what was read off it is gone.
    expect(plan).toMatchObject({ synopsis: '陆沉来讨那支笔，沈璃不给。', characters: [(await project.findCharacter('沈璃'))!.id] })
    for (const field of ['location', 'time', 'threads', 'fromText'] as const) expect(plan[field], field).toBeUndefined()
    const threads = (await project.outline()).threads
    expect(threads.map(thread => thread.title).sort()).toEqual(['没寄出的信', '缺页的账本'].sort())
    expect(threads.every(thread => thread.advanced === undefined && thread.planted === undefined)).toBe(true)
    expect(await project.suggestions()).toEqual([])
    expect((await project.findCharacter('沈璃'))!.lastAppearance).toBeUndefined()
    const info = (await project.chapterInfos()).find(candidate => candidate.id === here)!
    expect(info).toMatchObject({ hasText: true, digested: false })
    expect(info.memory).toBeUndefined()
    // The text is as it was, and a digest brings a memory back.
    expect(await project.chapterText(here)).toBe('旧稿：沈璃追到了码头。')
    expect(await forgetChapter(core, runtime, here)).toMatchObject({ forgot: false })
    await digestChapter(core, runtime, here, task)
    expect((await project.chapterInfos()).find(candidate => candidate.id === here)).toMatchObject({ digested: true, memory: 'current' })
  })

  it('leaves a field of the plan alone once somebody has set it', async () => {
    const { core, runtime } = bed
    const { project } = runtime
    const here = ids[2]!
    answer('旧稿：沈璃追到了码头。', FIRST)
    await writeChapter(core, runtime, { chapter: here, digest: true }, task)
    await project.updateChapter(here, { location: '回文巷' })
    const plan = (await project.findChapter(here))!.plan
    expect([...(plan.fromText ?? [])].sort()).toEqual(['threads', 'time'])
    // The author's place goes to whoever drafts the chapter anew, and is not cleared with the memory.
    answer('新稿。', SECOND)
    await writeChapter(core, runtime, { chapter: here, digest: false }, task)
    expect(sentToWriter().at(-1)!.prompt).toContain('回文巷')
    await forgetChapter(core, runtime, here)
    expect((await project.findChapter(here))!.plan.location).toBe('回文巷')
  })

  it('is not there for the planner either, where the planner prepares the draft\'s material', async () => {
    const { core, runtime } = bed
    const { project } = runtime
    const here = ids[2]!
    answer('旧稿：沈璃追到了码头。', FIRST)
    await writeChapter(core, runtime, { chapter: here, digest: true }, task)

    await core.settings.update({ materialBy: 'planner', context: { ...DEFAULT_SETTINGS.context, plannerWholeTokens: 0 } })
    bed.roles.enabled = true
    const read: Record<string, string> = {}
    bed.roles.script = async (_task, call) => {
      read.text = await call('book_read', { what: 'chapter', ref: '3' })
      read.memory = await call('book_read', { what: 'memory', ref: '3' })
      read.plan = await call('book_read', { what: 'outline', ref: '3' })
      read.threads = await call('book_read', { what: 'threads' })
      read.search = await call('book_search', { query: '码头 截住 陆沉 笔' })
      const said = await call('writing_material', { result: { task: '写陆沉来讨笔。', people: ['沈璃'], chapters: [2] } })
      if (said.startsWith('ERROR')) throw new Error(said)
    }
    answer('新稿。', SECOND)
    const done = await writeChapter(core, runtime, { chapter: here, digest: false }, task)
    expect(done.material?.by).toBe('planner')
    const asked = (bed.roles.tasks.at(-1) as RoleTask).prompt
    const seen = [asked, read.text, read.memory, read.plan, read.threads, read.search, sentToWriter().at(-1)!.prompt].join('\n')
    for (const part of ['【旧稿的地点】', '【旧稿的时间】', '【旧稿的梗概】', '【旧稿的事实】', '码头的红伞', '旧稿：沈璃追到了码头']) expect(seen, part).not.toContain(part)
    expect(asked).toContain('3. 《三》 未写 ← 这一章')
    expect(read.text).toContain('has no text yet')
    expect(read.memory).toContain('has no memory')
    // Read for its own sake — not as the chapter being written — the same chapter is there with all it has.
    expect((await readBook(runtime, { what: 'memory', ref: '3' })).text).toContain('【旧稿的事实】')
    expect((await searchBook(runtime, { query: '码头 截住 陆沉 笔' })).text).toContain('码头')
  })
})

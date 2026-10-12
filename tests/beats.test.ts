// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * One beat by a sentence: a beat added to a chapter, or the beats the author named changed — and no other beat
 * touched. (Laying every beat out anew is another thing, and is not what the author asks for by a sentence.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { touchBeats } from '../src/core/pipelines/plot'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }

describe('one beat by a sentence', () => {
  let bed: TestBed
  let chapterId: string
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '七日未寄' })
    const { project } = bed.runtime
    await project.saveCharacter({ id: '沈蘅', name: '沈蘅', role: 'protagonist' } as never)
    await project.saveCharacter({ id: '阿棠', name: '阿棠', role: 'supporting' } as never)
    const chapter = await project.addChapter({ title: '七日讣文', synopsis: '阿棠冒雨送来报馆急刊：那位太太死了。' })
    chapterId = chapter.id
    await project.updateChapter(chapterId, {
      beats: [
        { id: 'b1', summary: '沈蘅在柜台后核对三张讣文底稿。', location: '铺子' },
        { id: 'b2', summary: '阿棠冒雨送来急刊，说那位太太死了。', characters: ['阿棠', '沈蘅'], outcome: '沈蘅知道信出了事' },
        { id: 'b3', summary: '沈蘅取出旧笔，决定烧掉底稿。', emotion: '惊惧' },
      ],
    })
  })
  afterEach(async () => { await bed.cleanup() })

  const beats = async () => (await bed.runtime.project.findChapter(chapterId))!.plan.beats ?? []

  it('adds one beat where the planner puts it — in one request, the others as they stood', async () => {
    // (Asked in one request whatever the role is set to: everything it goes by is in the task.)
    bed.roles.enabled = true
    bed.llm.responder = () => JSON.stringify({ beat: { summary: '阿棠走后，沈蘅发现急刊背面有人用铅笔写了她的名字。', characters: ['沈蘅'], location: '铺子', conflict: '字迹她认得', outcome: '她把报纸翻了回去', emotion: '发冷' }, after: 2, why: '接在阿棠报信之后，取笔之前。' })
    const done = await touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '加一场：她发现急刊背面有人写了她的名字' }, task)
    expect(bed.roles.tasks).toHaveLength(0)
    expect(bed.llm.requests).toHaveLength(1)
    const prompt = bed.llm.requests[0]!.prompt
    for (const part of ['## 这一章现有的节拍', '1. 沈蘅在柜台后核对三张讣文底稿。（地点：铺子）', '2. 阿棠冒雨送来急刊，说那位太太死了。（在场：阿棠、沈蘅；结果：沈蘅知道信出了事）', '## 作者的一句话', '加一场：她发现急刊背面有人写了她的名字', '只写这一个——现有的节拍一个都不动', '它放在哪由你定']) expect(prompt, part).toContain(part)
    expect(done).toMatchObject({ at: 3, beats: 4, why: '接在阿棠报信之后，取笔之前。' })
    const now = await beats()
    expect(now.map(beat => beat.id)).toEqual(['b1', 'b2', done.added!.id, 'b3'])
    expect(now[2]).toMatchObject({ summary: '阿棠走后，沈蘅发现急刊背面有人用铅笔写了她的名字。', characters: ['沈蘅'], conflict: '字迹她认得', emotion: '发冷' })
    // The others are word for word what they were.
    expect(now[0]).toEqual({ id: 'b1', summary: '沈蘅在柜台后核对三张讣文底稿。', location: '铺子' })
    expect(now[3]).toEqual({ id: 'b3', summary: '沈蘅取出旧笔，决定烧掉底稿。', emotion: '惊惧' })
    // What the plan was is in its history.
    expect((await bed.runtime.project.history('plan', chapterId)).length).toBeGreaterThan(0)
  })

  it('puts the new beat where the author says, whatever the planner answers', async () => {
    bed.llm.responder = () => JSON.stringify({ beat: { summary: '天还没亮，门房的灯先灭了。' }, after: 3 })
    let done = await touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '开头加一个空镜', after: 'start' }, task)
    expect(done.at).toBe(1)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('作者要它放在最前（after 填 0）')
    expect((await beats()).map(beat => beat.id)).toEqual([done.added!.id, 'b1', 'b2', 'b3'])
    // After a beat named by its id; by its number; at the end.
    bed.llm.responder = () => JSON.stringify({ beat: { summary: '她把灯芯捻小。' }, after: 0 })
    done = await touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '她把灯捻小', after: 'b2' }, task)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('作者要它接在第 3 个节拍之后')
    expect((await beats()).map(beat => beat.id).indexOf(done.added!.id)).toBe(3)
    done = await touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '结尾加一声敲门', after: 'end' }, task)
    expect((await beats()).at(-1)!.id).toBe(done.added!.id)
    await expect(touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: 'x', after: '第 99 个' }, task)).rejects.toThrow(/no beat/)
  })

  it('changes the beats the author named, and those only', async () => {
    bed.llm.responder = () => JSON.stringify({
      beats: [
        // One nobody chose: what is handed in for it is not taken.
        { no: 1, summary: '（不该被改）' },
        { no: 2, summary: '阿棠没有进门，把急刊从门缝里塞进来就跑了。', characters: ['阿棠'], outcome: '沈蘅自己读到那条死讯' },
        { no: 3, remove: true },
      ],
      why: '第 2 个改成隔着门；第 3 个并进了下一章。',
    })
    const done = await touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '阿棠不进门；取笔那一场挪到下一章', beats: ['2', 'b3'] }, task)
    const prompt = bed.llm.requests[0]!.prompt
    for (const part of ['作者要改这一章的第 2、3 个节拍，别的节拍不动', '2. 【要改】阿棠冒雨送来急刊', '3. 【要改】沈蘅取出旧笔', '没被点到的节拍只是给你对照的']) expect(prompt, part).toContain(part)
    expect(prompt).not.toContain('1. 【要改】')
    expect(done.changed!.map(beat => beat.id)).toEqual(['b2'])
    expect(done.removed).toEqual(['b3'])
    expect(done).toMatchObject({ beats: 2, why: '第 2 个改成隔着门；第 3 个并进了下一章。' })
    const now = await beats()
    expect(now).toEqual([
      { id: 'b1', summary: '沈蘅在柜台后核对三张讣文底稿。', location: '铺子' },
      { id: 'b2', summary: '阿棠没有进门，把急刊从门缝里塞进来就跑了。', characters: ['阿棠'], outcome: '沈蘅自己读到那条死讯' },
    ])
  })

  it('says what is wrong where nothing can be done', async () => {
    await expect(touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '  ' }, task)).rejects.toThrow(/say what the beat is to be/)
    await expect(touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '改一下', beats: ['9'] }, task)).rejects.toThrow(/has no beat "9"/)
    await expect(touchBeats(bed.core, bed.runtime, { chapter: 'nope', ask: '改一下' }, task)).rejects.toThrow(/no chapter/)
    // A hand-in with none of the named beats in it changes nothing.
    bed.llm.responder = () => JSON.stringify({ beats: [{ no: 1, summary: '别的' }] })
    await expect(touchBeats(bed.core, bed.runtime, { chapter: chapterId, ask: '改一下', beats: ['2'] }, task)).rejects.toThrow()
    expect((await beats()).map(beat => beat.summary)).toEqual(['沈蘅在柜台后核对三张讣文底稿。', '阿棠冒雨送来急刊，说那位太太死了。', '沈蘅取出旧笔，决定烧掉底稿。'])
  })

  it('a chapter with no beats yet gets its first from a sentence', async () => {
    const { project } = bed.runtime
    const bare = await project.addChapter({ title: '旧账里的名字' })
    bed.llm.responder = () => JSON.stringify({ beat: { summary: '沈蘅在旧账里翻到妹妹的名字。' }, after: 0 })
    const done = await touchBeats(bed.core, bed.runtime, { chapter: bare.id, ask: '她在旧账里翻到妹妹的名字' }, task)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('（还没有节拍）')
    expect(done).toMatchObject({ at: 1, beats: 1 })
    expect((await project.findChapter(bare.id))!.plan.beats!.map(beat => beat.summary)).toEqual(['沈蘅在旧账里翻到妹妹的名字。'])
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/** A character's life read off the chapter digests, along one line of the plot. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lifeEnd, lifeLine, lifeOf, lifeUntil, spanText, statusAt } from '../src/shared/life'
import type { ChapterMemory, CharacterMoment } from '../src/shared/types'
import { packContext } from '../src/core/context'
import { createTestBed, type TestBed } from './support/harness'

const moment = (index: number, extra: Partial<CharacterMoment> = {}): { chapter: string; index: number; moment: CharacterMoment } => ({ chapter: `ch${String(index).padStart(3, '0')}`, index, moment: { character: 'x', name: 'x', ...extra } })

describe('a life on the page', () => {
  it('is the chapters somebody is in: where they come on, the stretches they stay, where they come back', () => {
    const life = lifeOf([5, 6, 8, 19, 20, 51, 52].map(index => moment(index)))
    expect(spanText(life.spans)).toEqual(['5–8', '19–20', '51–52'])
    expect(life.events.map(event => event.kind)).toEqual(['enter', 'seen', 'seen', 'return', 'seen', 'return', 'seen'])
    expect(life).toMatchObject({ first: 5, last: 52 })
    expect(life.death).toBeUndefined()
    // Before they come on they are not in the story; five chapters without them and they are offstage.
    expect([4, 5, 9, 12, 13, 19, 30, 52, 56, 57].map(at => statusAt(life, at))).toEqual(['planned', 'active', 'active', 'active', 'offstage', 'active', 'offstage', 'active', 'active', 'offstage'])
  })

  it('takes a digest\'s word for a leaving and a death — unless they are seen again', () => {
    const dead = lifeOf([moment(5, { role: '伏侍宝玉卧下' }), moment(74, { stateAfter: '病重' }), moment(77, { lifecycle: 'exit', role: '被撵出园去', location: '多浑虫家' }), moment(78, { lifecycle: 'death' })])
    expect(dead.events.map(event => event.kind)).toEqual(['enter', 'return', 'exit', 'death'])
    expect(dead.events[2]).toMatchObject({ what: '被撵出园去', where: '多浑虫家' })
    expect(dead.death).toBe(78)
    expect([76, 77, 78, 120].map(at => statusAt(dead, at))).toEqual(['active', 'retired', 'dead', 'dead'])
    // A death the story takes back: seen again, they are back, and the life does not end there.
    const back = lifeOf([moment(1), moment(2, { lifecycle: 'death' }), moment(9)])
    expect(back.events.map(event => event.kind)).toEqual(['enter', 'death', 'return'])
    expect(back.death).toBeUndefined()
    expect(statusAt(back, 3)).toBe('dead')
    expect(statusAt(back, 9)).toBe('active')
    expect(lifeOf([])).toEqual({ events: [], spans: [] })
  })

  it('is told as far as a chapter: what comes after has not happened to whoever writes that chapter', () => {
    const life = lifeOf([moment(5), moment(6), moment(8), moment(20), moment(77, { lifecycle: 'exit' }), moment(78, { lifecycle: 'death' })])
    // Whoever writes chapter 7 again knows of chapters 5 and 6, and of no death.
    const early = lifeUntil(life, 6)
    expect(early).toMatchObject({ first: 5, last: 6 })
    expect(early.death).toBeUndefined()
    expect(spanText(early.spans)).toEqual(['5–6'])
    // A stretch ends at the last chapter that had them by then — that they are in chapter 8 is not known at chapter 7; a
    // leaving is the last word until the death is.
    expect(spanText(lifeUntil(life, 7).spans)).toEqual(['5–6'])
    expect(spanText(lifeUntil(life, 8).spans)).toEqual(['5–8'])
    expect(lifeUntil(life, 77)).toMatchObject({ exit: 77 })
    expect(lifeUntil(life, 77).death).toBeUndefined()
    expect(lifeUntil(life, 78)).toMatchObject({ death: 78 })
    expect(lifeUntil(life, 78).exit).toBeUndefined()
    expect(lifeUntil(life, 4)).toEqual({ events: [], spans: [] })
  })

  it('takes the author\'s word over the digest\'s: a mark on a chapter, with or without a digest of it', () => {
    // The digest has her in chapter 3 and says nothing of a death; the author does.
    const marked = lifeOf([moment(1), { ...moment(3, { role: '倒在渡口' }), mark: { chapter: 'ch003', kind: 'death' as const, what: '死在渡口' } }])
    expect(marked.events.map(event => [event.index, event.kind, event.marked ?? false, event.what])).toEqual([[1, 'enter', false, undefined], [3, 'death', true, '死在渡口']])
    expect(marked.death).toBe(3)
    // A chapter no digest has them in: the mark is a chapter of their life all the same.
    const added = lifeOf([moment(1), { chapter: 'ch007', index: 7, moment: {}, mark: { chapter: 'ch007', kind: 'exit' as const } }])
    expect(added.events.map(event => [event.index, event.kind])).toEqual([[1, 'enter'], [7, 'exit']])
    expect(added).toMatchObject({ exit: 7, last: 7 })
    // A digest's death ends where they are seen again; the author's holds — a later chapter that has them remembers them.
    const held = lifeOf([moment(1), { ...moment(2), mark: { chapter: 'ch002', kind: 'death' as const } }, moment(9), moment(10)])
    expect(held.events.map(event => event.kind)).toEqual(['enter', 'death', 'seen', 'seen'])
    expect(held.death).toBe(2)
    expect([2, 9, 30].map(at => statusAt(held, at))).toEqual(['dead', 'dead', 'dead'])
    // Until the author has them come back.
    const back = lifeOf([moment(1), { ...moment(2), mark: { chapter: 'ch002', kind: 'death' as const } }, moment(9), { ...moment(10), mark: { chapter: 'ch010', kind: 'return' as const, what: '原来没有死' } }])
    expect(back.events.map(event => event.kind)).toEqual(['enter', 'death', 'seen', 'return'])
    expect(back.death).toBeUndefined()
    expect([9, 10].map(at => statusAt(back, at))).toEqual(['dead', 'active'])
    expect(lifeUntil(back, 9).death).toBe(2)
    // The author can also say that the digest's death was none: they come back in that very chapter.
    const undone = lifeOf([moment(1), { ...moment(2, { lifecycle: 'death' }), mark: { chapter: 'ch002', kind: 'return' as const } }])
    expect(undone.death).toBeUndefined()
  })

  it('knows of somebody dead, or gone, before the story begins', () => {
    const before = { chapter: '', index: 0, moment: {}, mark: { kind: 'death' as const, what: '宝玉出生前就去世了' } }
    const never = lifeOf([before])
    expect(never.events).toEqual([{ chapter: '', index: 0, kind: 'death', what: '宝玉出生前就去世了', marked: true }])
    expect(never).toMatchObject({ death: 0, spans: [] })
    expect(never.first).toBeUndefined()
    expect([0, 1, 40].map(at => statusAt(never, at))).toEqual(['dead', 'dead', 'dead'])
    expect(lifeLine(never, true)).toBe('故事开始之前已故')
    expect(lifeEnd(never, true)).toEqual({ dead: true, at: 0, text: '故事开始之前已故' })
    // Chapters that have them all the same — a memory, a story told — do not bring them back.
    const remembered = lifeOf([before, moment(3), moment(4)])
    expect(remembered.events.map(event => event.kind)).toEqual(['death', 'seen', 'seen'])
    expect(remembered).toMatchObject({ death: 0, first: 3, last: 4 })
    expect(lifeLine(remembered, true)).toBe('故事开始之前已故 · 正文里出现：第 3–4 章')
    expect(lifeLine(lifeOf([{ chapter: '', index: 0, moment: {}, mark: { kind: 'exit' as const } }]), false)).toBe('gone before the story begins')
    expect(lifeEnd(lifeOf([moment(1), moment(5, { lifecycle: 'exit' })]), true)).toEqual({ dead: false, at: 5, text: '第 5 章离开' })
    expect(lifeEnd(lifeOf([moment(1)]), true)).toBeUndefined()
  })

  it('is said in one line of words: where they come on, the stretches they are in, how it ends', () => {
    const dies = lifeOf([moment(9), moment(10), moment(11), moment(12, { lifecycle: 'death' })])
    expect(lifeLine(dies, true)).toBe('第 9 章登场 · 第 12 章死亡')
    expect(lifeLine(dies, false)).toBe('comes on in chapter 9 · dies in chapter 12')
    // More than one stretch is worth naming; one is what the ends already say.
    const comesBack = lifeOf([5, 6, 8, 19, 20].map(index => moment(index)))
    expect(lifeLine(comesBack, true)).toBe('第 5 章登场 · 在场：第 5–8、19–20 章 · 最近一次在第 20 章')
    expect(lifeLine(lifeOf([moment(3), moment(30, { lifecycle: 'exit' })]), true)).toBe('第 3 章登场 · 在场：第 3、30 章 · 第 30 章离开')
    expect(lifeLine(lifeOf([moment(3)]), true)).toBe('第 3 章登场')
    // Nobody the digests name: nothing to say — and never a word for "where the book has got to".
    expect(lifeLine(lifeOf([]), true)).toBeUndefined()
    expect(lifeLine(undefined, true)).toBeUndefined()
  })
})

describe('everyone\'s life in a book', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('is read off the digests of one line\'s chapters — and is another life on another line', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈蘅', role: 'protagonist', aliases: ['沈小姐'] })
    await project.saveCharacter({ name: '阿棠', role: 'supporting' })
    for (const title of ['一', '二', '三']) await project.addChapter({ title })
    const memory = (chapterId: string, characters: Partial<CharacterMoment>[]): ChapterMemory => ({ schema: 1, chapterId, textHash: 'x', updatedAt: new Date().toISOString(), brief: '', summary: '', facts: [], newEntities: [], threads: [], characters: characters.map(item => ({ character: item.name ?? '', name: item.name ?? '', ...item })) as CharacterMoment[] })
    // A digest that names somebody twice — by name and by what others call her — says one thing of the chapter.
    await project.saveMemory(memory('ch001', [{ name: '沈蘅', role: '代人写信' }, { name: '沈小姐', role: '（同一个人）' }, { name: '路人甲' }]))
    await project.saveMemory(memory('ch002', [{ name: '阿棠', role: '送来急刊' }]))
    await project.saveMemory(memory('ch003', [{ name: '沈蘅', stateAfter: '发着烧' }, { name: '阿棠', lifecycle: 'death' }]))
    const main = await project.lives()
    expect(main.chapters.map(chapter => [chapter.id, chapter.index, chapter.digested])).toEqual([['ch001', 1, true], ['ch002', 2, true], ['ch003', 3, true]])
    expect(Object.keys(main.lives).sort()).toEqual(['沈蘅', '阿棠'].sort())
    expect(main.lives['沈蘅']!.events).toEqual([{ chapter: 'ch001', index: 1, kind: 'enter', what: '代人写信' }, { chapter: 'ch003', index: 3, kind: 'seen', state: '发着烧' }])
    expect(main.lives['阿棠']).toMatchObject({ first: 2, last: 3, death: 3 })
    // A line that parts after the second chapter: there, 阿棠 did not die in the third.
    const line = await project.addLine({ title: '她把信寄了出去', from: 'ch002' })
    const side = await project.addChapter({ title: '另一个早晨' }, { line: line.id })
    await project.saveMemory(memory(side.id, [{ name: '阿棠', role: '在码头等船' }]))
    const other = await project.lives(line.id)
    expect(other.chapters.map(chapter => chapter.id)).toEqual(['ch001', 'ch002', side.id])
    expect(other.lives['阿棠']!.death).toBeUndefined()
    expect(other.lives['阿棠']!.events.map(event => [event.index, event.kind])).toEqual([[2, 'enter'], [3, 'seen']])
    expect(other.lives['沈蘅']!.last).toBe(1)
  })

  it('lets the author write a mark of their own into a life: over the digest, on every line that reads the chapter, and before the story', async () => {
    const { project, index } = bed.runtime
    const lead = await project.saveCharacter({ name: '沈蘅', role: 'protagonist' })
    const friend = await project.saveCharacter({ name: '阿棠', role: 'supporting' })
    const mother = await project.saveCharacter({ name: '沈母', role: 'minor' })
    for (const title of ['一', '二', '三', '四']) await project.addChapter({ title })
    const memory = (chapterId: string, names: string[]): ChapterMemory => ({ schema: 1, chapterId, textHash: 'x', updatedAt: new Date().toISOString(), brief: '', summary: '', facts: [], newEntities: [], threads: [], characters: names.map(name => ({ character: name, name })) })
    await project.saveMemory(memory('ch001', ['沈蘅', '阿棠']))
    await project.saveMemory(memory('ch002', ['沈蘅', '阿棠']))
    await project.saveMemory(memory('ch003', ['沈蘅']))
    // The digest of the second chapter missed that she died there: the author writes it down, by the chapter's number.
    const marked = await project.markLife('阿棠', { chapter: 2, kind: 'death', what: '  死在渡口  ' })
    expect(marked.lifeMarks).toEqual([{ chapter: 'ch002', kind: 'death', what: '死在渡口' }])
    expect((await project.lives()).lives[friend.id]).toMatchObject({ death: 2 })
    expect((await project.lives()).lives[friend.id]!.events.at(-1)).toMatchObject({ kind: 'death', marked: true, what: '死在渡口' })
    expect((await project.presence()).find(entry => entry.character === friend.id)?.death).toBe(2)
    // One mark a chapter: another for the same chapter replaces it; a mark for another chapter stands beside it.
    await project.markLife(friend.id, { chapter: 'ch002', kind: 'exit' })
    await project.markLife(friend.id, { chapter: 'ch004', kind: 'return', what: '回来了' })
    expect((await project.findCharacter(friend.id))!.lifeMarks).toEqual([{ chapter: 'ch002', kind: 'exit' }, { chapter: 'ch004', kind: 'return', what: '回来了' }])
    expect((await project.lives()).lives[friend.id]!.events.map(event => [event.index, event.kind])).toEqual([[1, 'enter'], [2, 'exit'], [4, 'return']])
    expect((await project.lives()).lives[friend.id]!.exit).toBeUndefined()
    // It holds where its chapter is read: a line that parts after the first chapter never comes to the second.
    const line = await project.addLine({ title: '她没有上船', from: 'ch001' })
    const side = await project.addChapter({ title: '另一个早晨' }, { line: line.id })
    await project.saveMemory(memory(side.id, ['阿棠']))
    expect((await project.lives(line.id)).lives[friend.id]!.events.map(event => [event.index, event.kind, event.marked ?? false])).toEqual([[1, 'enter', false], [2, 'seen', false]])
    // Before the story begins: only somebody dead or gone — and on every line.
    await expect(project.markLife(mother.id, { kind: 'enter' })).rejects.toThrow(/before the story/)
    await project.markLife(mother.id, { kind: 'death', what: '沈蘅七岁那年病故' })
    for (const told of [await project.lives(), await project.lives(line.id)]) expect(told.lives[mother.id]).toMatchObject({ death: 0 })
    expect((await project.presence()).find(entry => entry.character === mother.id)).toMatchObject({ death: 0, chapters: [] })
    // The writer of any chapter is told so — and of the leaving, from the chapter after it on.
    const pack = async (id: string) => (await packContext(project, index, { purpose: 'draft', chapter: (await project.findChapter(id))!, textBudget: 50_000, sideBudget: 20_000, tailChars: 200 })).rest
    expect(await pack('ch001')).toContain('已死亡（可以被提起，不能再以活人身份出场）：沈母（故事开始之前）')
    expect(await pack('ch002')).not.toContain('阿棠（第2章）')
    expect(await pack('ch003')).toContain('已离开故事（章纲没有安排，就不要让他们回来）：阿棠（第2章）')
    // Taken back, the chapter goes by its digest again; a chapter nobody answers to is said.
    await project.markLife(friend.id, { chapter: 'ch002' })
    await project.markLife(friend.id, { chapter: 4 })
    expect((await project.findCharacter(friend.id))!.lifeMarks).toBeUndefined()
    expect((await project.lives()).lives[friend.id]!.events.map(event => event.kind)).toEqual(['enter', 'seen'])
    await expect(project.markLife(friend.id, { chapter: '没有这一章', kind: 'death' })).rejects.toThrow(/no chapter matches/)
    await expect(project.markLife('没有这个人', { chapter: 1, kind: 'death' })).rejects.toThrow(/no character matches/)
    expect(lead.lifeMarks).toBeUndefined()
  })
})

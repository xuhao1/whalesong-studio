// SPDX-License-Identifier: LGPL-3.0-or-later
/** A character's life read off the chapter digests, along one line of the plot. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lifeLine, lifeOf, lifeUntil, spanText, statusAt } from '../src/shared/life'
import type { ChapterMemory, CharacterMoment } from '../src/shared/types'
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
    // A stretch is cut where the chapter cuts it; a leaving is the last word until the death is.
    expect(spanText(lifeUntil(life, 7).spans)).toEqual(['5–7'])
    expect(lifeUntil(life, 77)).toMatchObject({ exit: 77 })
    expect(lifeUntil(life, 77).death).toBeUndefined()
    expect(lifeUntil(life, 78)).toMatchObject({ death: 78 })
    expect(lifeUntil(life, 78).exit).toBeUndefined()
    expect(lifeUntil(life, 4)).toEqual({ events: [], spans: [] })
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
})

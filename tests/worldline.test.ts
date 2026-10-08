// SPDX-License-Identifier: LGPL-3.0-or-later
/** The world as a line of the plot leaves it, and two lines held against each other. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareLines, type LinePerson, type LineThread, type LineWorld } from '../src/shared/worldline'
import type { ChapterMemory, CharacterMoment, ThreadTouch } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

const person = (id: string, extra: Partial<LinePerson> = {}): LinePerson => ({ id, name: id, role: 'supporting', status: 'active', first: 1, last: 3, lastChapter: 'c3', chapters: 3, ...extra })
const thread = (key: string, extra: Partial<LineThread> = {}): LineThread => ({ key, title: key, state: 'open', planted: 1, last: 1, lastChapter: 'c1', touches: 1, ...extra })
const world = (line: string, chapters: string[], people: LinePerson[], threads: LineThread[] = [], written = chapters.length): LineWorld => ({
  line,
  path: chapters.map((id, at) => ({ id, index: at + 1, title: id, hasText: at < written, digested: at < written })),
  people,
  threads,
})

describe('two lines of the plot, held against each other', () => {
  it('part where their chapters stop being the same, and differ only in what comes after', () => {
    const main = world('main', ['c1', 'c2', 'c3', 'c4'], [
      person('lead', { role: 'protagonist', last: 4, lastChapter: 'c4', chapters: 4 }),
      person('dies-here', { status: 'dead', death: 3 }),
      person('same', { last: 2, lastChapter: 'c2', chapters: 2 }),
      // Away on the longer line, on the page on the shorter: no fate, only another course.
      person('away', { status: 'offstage', last: 3, lastChapter: 'c3' }),
      person('leaves', { status: 'retired', exit: 4, last: 4, lastChapter: 'c4', chapters: 4 }),
      person('main-only', { first: 4, last: 4, lastChapter: 'c4', chapters: 1 }),
    ], [thread('letter', { state: 'paid', last: 4, lastChapter: 'c4' }), thread('debt'), thread('main-thread')])
    const side = world('side', ['c1', 'c2', 's1', 's2'], [
      person('lead', { role: 'protagonist', last: 4, lastChapter: 's2', chapters: 4 }),
      person('dies-here', { last: 4, lastChapter: 's2', chapters: 3 }),
      person('same', { last: 2, lastChapter: 'c2', chapters: 2 }),
      person('away', { last: 4, lastChapter: 's2', chapters: 4 }),
      person('leaves', { last: 4, lastChapter: 's2', chapters: 4 }),
      person('side-only', { first: 3, last: 3, lastChapter: 's1', chapters: 1 }),
    ], [thread('letter'), thread('debt'), thread('side-thread', { planted: 3 })], 3)
    const compared = compareLines(main, side)
    expect(compared.shared).toBe(2)
    expect(compared.parts).toEqual({ id: 'c2', index: 2, title: 'c2' })
    expect(compared.own).toEqual({ left: { chapters: 2, written: 2 }, right: { chapters: 2, written: 1 } })
    // Fates first, then who only one line has, then other courses to the same standing.
    expect(compared.people.map(item => `${item.kind}:${item.id}`)).toEqual(['fate:dies-here', 'fate:leaves', 'only:main-only', 'only:side-only', 'course:lead', 'course:away'])
    expect(compared.people[0]).toMatchObject({ left: { status: 'dead', death: 3 }, right: { status: 'active' } })
    expect(compared.people[1]).toMatchObject({ left: { status: 'retired', exit: 4 }, right: { status: 'active' } })
    expect(compared.people[2]!.right).toBeUndefined()
    expect(compared.people[3]!.left).toBeUndefined()
    // Somebody both lines leave as they found them is no difference.
    expect(compared.alike).toEqual({ people: 1, threads: 1 })
    expect(compared.threads.map(item => `${item.kind}:${item.key}`)).toEqual(['state:letter', 'only:main-thread', 'only:side-thread'])
    // What somebody came to know after the parting is told for each line; what they learned before it is the same on both.
    const told = compareLines(
      world('main', ['c1', 'c2', 'c3'], [person('lead', { learned: [{ index: 1, chapter: 'c1', what: '父亲还活着' }, { index: 3, chapter: 'c3', what: '信是假的' }] })]),
      world('side', ['c1', 'c2', 's1'], [person('lead', { lastChapter: 's1', learned: [{ index: 1, chapter: 'c1', what: '父亲还活着' }, { index: 3, chapter: 's1', what: '寄信人是谁' }] })]),
    )
    expect(told.people).toEqual([expect.objectContaining({ id: 'lead', kind: 'course', knows: { left: ['信是假的'], right: ['寄信人是谁'] } })])
    // Nothing learned after the parting on either: nothing is said of it.
    expect(compared.people.every(item => item.knows === undefined)).toBe(true)
    // A line held against itself differs in nothing; two that share no first page part before it.
    expect(compareLines(main, main)).toMatchObject({ shared: 4, people: [], threads: [], own: { left: { chapters: 0 }, right: { chapters: 0 } } })
    expect(compareLines(main, world('other', ['x1'], [])).parts).toBeUndefined()
  })
})

describe('the world as a line leaves it', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('is read off the digests along the line: who stands how at its end, which threads are open', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈蘅', role: 'protagonist' })
    await project.saveCharacter({ name: '阿棠', role: 'supporting' })
    await project.saveCharacter({ name: '还没写到的人', role: 'minor' })
    for (const title of ['一', '二', '三']) await project.addChapter({ title })
    for (const id of ['ch001', 'ch002', 'ch003']) await project.saveChapterText(id, `${id} 的正文。`)
    const memory = (chapterId: string, characters: Partial<CharacterMoment>[], threads: ThreadTouch[] = []): ChapterMemory => ({ schema: 1, chapterId, textHash: 'x', updatedAt: new Date().toISOString(), brief: '', summary: '', facts: [], newEntities: [], threads, characters: characters.map(item => ({ character: item.name!, name: item.name!, ...item })) })
    await project.saveMemory(memory('ch001', [{ name: '沈蘅' }, { name: '阿棠', location: '码头' }], [{ title: '三封信', action: 'plant' }, { title: '欠下的船钱', action: 'plant' }]))
    await project.saveMemory(memory('ch002', [{ name: '沈蘅', stateAfter: '发着烧', learned: ['信是阿棠代收的', '  '] }], [{ title: '三封信', action: 'advance' }]))
    await project.saveMemory(memory('ch003', [{ name: '沈蘅', location: '旧书铺', learned: ['信是阿棠代收的', '第三封信没有寄出'] }, { name: '阿棠', lifecycle: 'death' }], [{ title: '三封信', action: 'payoff' }]))
    const main = await project.lineWorld()
    expect(main.line).toBe('main')
    expect(main.path.map(chapter => [chapter.index, chapter.hasText])).toEqual([[1, true], [2, true], [3, true]])
    // Heaviest part first; somebody the digests never name is not of this line's world.
    expect(main.people.map(item => [item.name, item.status, item.first, item.last, item.chapters])).toEqual([['沈蘅', 'active', 1, 3, 3], ['阿棠', 'dead', 1, 3, 2]])
    expect(main.people[0]).toMatchObject({ where: '旧书铺', lastChapter: 'ch003' })
    expect(main.people[1]!.death).toBe(3)
    // What she came to know, once each, where the digests first noted it; somebody who learned nothing has no such list.
    expect(main.people[0]!.learned).toEqual([{ index: 2, chapter: 'ch002', what: '信是阿棠代收的' }, { index: 3, chapter: 'ch003', what: '第三封信没有寄出' }])
    expect(main.people[1]!.learned).toBeUndefined()
    expect(main.threads.map(item => [item.title, item.state, item.planted, item.last, item.touches])).toEqual([['三封信', 'paid', 1, 3, 3], ['欠下的船钱', 'open', 1, 1, 1]])

    // Another line, leaving after the second chapter: she is alive on it, and the letters are still unanswered.
    const line = await project.addLine({ title: '她把信寄了出去', from: 'ch002' })
    const side = await project.addChapter({ title: '另一个早晨' }, { line: line.id })
    await project.saveChapterText(side.id, '另一个早晨的正文。')
    await project.saveMemory(memory(side.id, [{ name: '阿棠', role: '在码头等船', location: '码头', learned: ['信已经寄出去了'] }], [{ title: '欠下的船钱', action: 'payoff' }, { title: '新的来信', action: 'plant' }]))
    const other = await project.lineWorld(line.id)
    expect(other).toMatchObject({ line: line.id, title: '她把信寄了出去' })
    expect(other.path.map(chapter => chapter.id)).toEqual(['ch001', 'ch002', side.id])
    expect(other.people.map(item => [item.name, item.status])).toEqual([['沈蘅', 'active'], ['阿棠', 'active']])
    expect(other.threads.map(item => [item.title, item.state])).toEqual([['三封信', 'open'], ['欠下的船钱', 'paid'], ['新的来信', 'open']])

    const compared = compareLines(main, other)
    expect(compared.parts).toMatchObject({ id: 'ch002', index: 2 })
    expect(compared.own).toEqual({ left: { chapters: 1, written: 1 }, right: { chapters: 1, written: 1 } })
    expect(compared.people.map(item => `${item.kind}:${item.name}`)).toEqual(['fate:阿棠', 'course:沈蘅'])
    // After the parting: on the main line she learns of the third letter; on the other, the girl who lives learns the letter went out.
    expect(compared.people.map(item => item.knows)).toEqual([{ left: [], right: ['信已经寄出去了'] }, { left: ['第三封信没有寄出'], right: [] }])
    expect(compared.threads.map(item => `${item.kind}:${item.title}`)).toEqual(['state:三封信', 'state:欠下的船钱', 'only:新的来信'])
    // A line nobody knows is said to be none, not read as the main one.
    await expect(project.lineWorld('没有这条线')).rejects.toThrow(/no plot line/)
  })
})

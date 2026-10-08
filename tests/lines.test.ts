// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { digestChapter, digestPending } from '../src/core/pipelines/digest'
import { applyOutlineOps } from '../src/core/pipelines/outline'
import { novelizePlay, startPlay } from '../src/core/pipelines/play'
import { deriveChapters } from '../src/core/pipelines/plot'
import { writeChapter } from '../src/core/pipelines/write'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishSite } from '../src/core/pipelines/site'
import { bookAnswer, listLines } from '../src/core/reader'
import { chapterOnLine, knownLine, lineHolding, pathOfLine, waysOn } from '../src/shared/lines'
import { readAlong, type ReaderLine } from '../src/shared/reader'
import { MAIN_LINE } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

/** A book of `count` chapters on its main line, the first `written` of them with text. */
async function book(bed: TestBed, count: number, written = count): Promise<string[]> {
  const { project } = bed.runtime
  const ids: string[] = []
  for (let n = 1; n <= count; n++) {
    const plan = await project.addChapter({ title: `主线${n}`, synopsis: `主线第 ${n} 章发生的事。` })
    ids.push(plan.id)
    if (n <= written) await project.saveChapterText(plan.id, `这是主线第${n}章的正文。`.repeat(3))
  }
  return ids
}

const titles = async (bed: TestBed, line?: string): Promise<string[]> => (await bed.runtime.project.chapters(line)).map(chapter => chapter.plan.title)

describe('lines of the plot', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('reads a line as what comes before it, its own chapters, and what it arrives at', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 5)
    const line = await project.addLine({ title: '她没有烧掉那封信', from: main[1]!, choice: '把信藏进袖子' })
    const a = await project.addChapter({ title: '支线甲' }, { line: line.id })
    const b = await project.addChapter({ title: '支线乙' }, { after: a.id })
    // The main line is untouched: the book as it is read.
    expect(await titles(bed)).toEqual(['主线1', '主线2', '主线3', '主线4', '主线5'])
    expect(await titles(bed, line.id)).toEqual(['主线1', '主线2', '支线甲', '支线乙'])
    // A chapter of the line is found by its id, and counted along its own line.
    const found = (await project.findChapter(b.id))!
    expect(found).toMatchObject({ index: 4, line: line.id })
    expect((await project.findChapter('支线甲'))!.plan.id).toBe(a.id)
    // Numbers count along the main line unless a line is named.
    expect((await project.findChapter('第3章'))!.plan.title).toBe('主线3')
    expect((await project.findChapter('第3章', line.id))!.plan.title).toBe('支线甲')
    // Arriving at a chapter of the main line, the two are one story from there.
    await project.updateLine(line.id, { into: main[4]! })
    expect(await titles(bed, line.id)).toEqual(['主线1', '主线2', '支线甲', '支线乙', '主线5'])
    // A line cannot arrive at one of its own chapters.
    await expect(project.updateLine(line.id, { into: a.id })).rejects.toThrow('own chapters')
    const state = await project.state()
    expect(state.lines).toHaveLength(1)
    expect(state.lines![0]!.chapters.map(chapter => [chapter.title, chapter.index, chapter.line])).toEqual([['支线甲', 3, line.id], ['支线乙', 4, line.id]])
    expect(state.lines![0]!.path).toEqual([main[0], main[1], a.id, b.id, main[4]])
    // New chapter ids never collide with a line's.
    const next = await project.addChapter({ title: '主线6' })
    expect(new Set([...main, a.id, b.id, next.id]).size).toBe(8)
  })

  it('makes a line the main one, and keeps what it replaces as a line', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 5)
    const line = await project.addLine({ title: '另一条路', from: main[1]! })
    const a = await project.addChapter({ title: '支线甲' }, { line: line.id })
    const b = await project.addChapter({ title: '支线乙' }, { line: line.id })
    await project.updateLine(line.id, { into: main[4]! })
    const results = await applyOutlineOps(bed.runtime, [{ op: 'promote-line', line: '另一条路' }])
    expect(results[0]).toMatchObject({ ok: true })
    // The chapters the line passes through are the book now…
    expect(await titles(bed)).toEqual(['主线1', '主线2', '支线甲', '支线乙', '主线5'])
    // …and the stretch of the old main line it took the place of is a line, leaving and arriving where they part and meet.
    const lines = await project.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ title: '原主线', origin: 'main', from: main[1], into: main[4] })
    expect(lines[0]!.chapters.map(chapter => chapter.title)).toEqual(['主线3', '主线4'])
    expect(await titles(bed, lines[0]!.id)).toEqual(['主线1', '主线2', '主线3', '主线4', '主线5'])
    // Nothing was written anew or lost on the way.
    expect(await project.chapterText(main[2]!)).toContain('主线第3章')
    expect((await project.findChapter(a.id))!.line).toBeUndefined()
    expect((await project.findChapter(b.id))!.index).toBe(4)
    // And back again.
    await project.promoteLine(lines[0]!.id, '原主线')
    expect(await titles(bed)).toEqual(['主线1', '主线2', '主线3', '主线4', '主线5'])
    expect((await project.lines())[0]!.chapters.map(chapter => chapter.title)).toEqual(['支线甲', '支线乙'])
  })

  it('removes chapters and lines without leaving a line hanging', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 4)
    const line = await project.addLine({ title: '岔路', from: main[1]! })
    const a = await project.addChapter({ title: '支线甲' }, { line: line.id })
    await project.saveChapterText(a.id, '支线的正文。')
    const sub = await project.addLine({ title: '岔路的岔路', from: a.id })
    await project.addChapter({ title: '更远' }, { line: sub.id })
    // The chapter a line left after goes: the line leaves after the one before it.
    await project.removeChapter(main[1]!)
    expect((await project.findLine(line.id))!.from).toBe(main[0])
    // A line goes with its chapters; their text is kept as a version first, and what left from it leaves where it did.
    const removed = await project.removeLine(line.id)
    expect(removed).toMatchObject({ chapters: 1, written: 1 })
    expect(await project.chapterText(a.id)).toBe('')
    expect((await project.versions(a.id)).length).toBe(1)
    expect((await project.findLine(sub.id))!.from).toBe(main[0])
    expect(await titles(bed, sub.id)).toEqual(['主线1', '更远'])
  })

  it('opens a line of its own for chapters derived another way', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 4, 2)
    bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '逃向北方', synopsis: '她连夜出城。' }, { title: '雪线', synopsis: '在山口被追上。' }], rationale: '另一种走向。' })
    const result = await deriveChapters(bed.core, bed.runtime, { count: 2, mode: 'branch', title: '出逃', choice: '不去赴约', direction: '她决定逃走' }, { origin: 'user' })
    // It leaves after the last chapter that is written, and the main line stays as it was.
    expect(result.line).toMatchObject({ title: '出逃', created: true })
    const line = (await project.findLine('出逃'))!
    expect(line).toMatchObject({ from: main[1], choice: '不去赴约', origin: 'planner' })
    expect(await titles(bed)).toEqual(['主线1', '主线2', '主线3', '主线4'])
    expect(await titles(bed, line.id)).toEqual(['主线1', '主线2', '逃向北方', '雪线'])
    // The planner was told what it parts from, so the new line is another way and not the same again.
    const prompt = bed.llm.requests.at(-1)!.prompt
    expect(prompt).toContain('这是一条新的剧情线「出逃」')
    expect(prompt).toContain('分开的地方，做出的抉择是：不去赴约')
    expect(prompt).toContain('主线3')
    // The next chapter of that line is written knowing its own line, not the main line's chapters after the fork.
    await project.saveChapterText(main[2]!, '主线第三章：她去赴了约。')
    bed.llm.responder = () => '她在城门落锁前出了城。'
    const written = await writeChapter(bed.core, bed.runtime, { line: '出逃' }, { origin: 'user' })
    expect(written).toMatchObject({ title: '逃向北方', line: line.id, index: 3 })
    const request = bed.llm.requests.at(-1)!
    expect(request.stable).toContain('主线第2章的正文')
    expect(`${request.stable}${request.prompt}`).not.toContain('她去赴了约')
  })

  it('replaces the outline after a chapter, and never throws written chapters away', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 5, 3)
    bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '新的第三章', synopsis: '改写后的走向。' }, { title: '新的第四章', synopsis: '接着改写。' }] })
    // After chapter two: chapter three is written, four and five are not.
    const result = await deriveChapters(bed.core, bed.runtime, { count: 2, mode: 'replace', after: main[1]! }, { origin: 'user' })
    expect(await titles(bed)).toEqual(['主线1', '主线2', '新的第三章', '新的第四章'])
    expect(result.replaced).toMatchObject({ chapters: 3 })
    // What was there had text: all of it is kept, as a line put aside that leaves where the rewrite began.
    const kept = (await project.lines())[0]!
    expect(kept).toMatchObject({ origin: 'replaced', shelved: true, from: main[1] })
    expect(kept.chapters.map(chapter => chapter.title)).toEqual(['主线3', '主线4', '主线5'])
    expect(await project.chapterText(main[2]!)).toContain('主线第3章')
    expect(bed.llm.requests.at(-1)!.prompt).toContain('它已经被放弃')
    // With nothing written after the chapter, the old outline simply goes.
    bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '再改一次', synopsis: '又一种走向。' }] })
    const again = await deriveChapters(bed.core, bed.runtime, { count: 1, mode: 'replace', after: main[1]! }, { origin: 'user' })
    expect(again.replaced).toEqual({ chapters: 2 })
    expect(await titles(bed)).toEqual(['主线1', '主线2', '再改一次'])
    expect(await project.lines()).toHaveLength(1)
  })

  it('derives a long run in rounds, each from where the last left off', async () => {
    const { project } = bed.runtime
    await book(bed, 1)
    let round = 0
    bed.llm.responder = () => {
      round += 1
      return JSON.stringify({ chapters: Array.from({ length: round === 3 ? 5 : 10 }, (_unused, index) => ({ title: `第${round}轮之${index + 1}`, synopsis: '……' })) })
    }
    const result = await deriveChapters(bed.core, bed.runtime, { count: 25 }, { origin: 'user' })
    expect(result.added).toHaveLength(25)
    expect(round).toBe(3)
    const all = await titles(bed)
    expect(all).toHaveLength(26)
    expect(all.slice(0, 3)).toEqual(['主线1', '第1轮之1', '第1轮之2'])
    expect(all.at(-1)).toBe('第3轮之5')
    // The second round was asked knowing what the first had added.
    expect(bed.llm.requests[1]!.prompt).toContain('第1轮之10')
    expect((await project.chapters()).map(chapter => chapter.index)).toEqual(Array.from({ length: 26 }, (_unused, index) => index + 1))
  })

  it('keeps what happens on another line out of the book\'s own record', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 2)
    const card = await project.saveCharacter({ name: '沈璃', role: 'protagonist' })
    const line = await project.addLine({ title: '她死在渡口', from: main[0]! })
    const chapter = await project.addChapter({ title: '渡口' }, { line: line.id })
    await project.saveChapterText(chapter.id, '沈璃倒在渡口的石阶上，再也没有起来。')
    bed.llm.responder = () => JSON.stringify({ brief: '沈璃死于渡口', summary: '沈璃在渡口被杀。', characters: [{ name: '沈璃', role: '被杀', stateAfter: '已死', lifecycle: 'death' }], facts: [], newEntities: [{ name: '摆渡人', kind: 'character', description: '渡口的老人' }], threads: [{ title: '渡口的血', action: 'plant' }] })
    const memory = await digestChapter(bed.core, bed.runtime, chapter.id, { origin: 'user' })
    expect(memory?.summary).toContain('渡口')
    // Dead on that line, not in the book: her life on the main line knows nothing of it, and no thread is planted there.
    // (Whoever the chapter names without a card is a walk-on until the planner says otherwise: a digest proposes nobody.)
    expect(await project.suggestions()).toEqual([])
    expect((await project.outline()).threads).toHaveLength(0)
    expect((await project.findCharacter(card.id))!.lastAppearance).toBeUndefined()
    expect((await project.lives()).lives[card.id]).toBeUndefined()
    expect((await project.lives(line.id)).lives[card.id]).toMatchObject({ death: 2 })
    expect((await project.presence()).find(entry => entry.character === card.id)?.death).toBeUndefined()
    // Made the main line, what happened there is what happened: its memory is folded in then — and her death is read
    // off its digest like any other; nobody is asked to confirm a label, and none is written on her card.
    await applyOutlineOps(bed.runtime, [{ op: 'promote-line', line: line.id }])
    expect(await project.suggestions()).toEqual([])
    expect((await project.lives()).lives[card.id]).toMatchObject({ death: 2 })
    expect((await project.presence()).find(entry => entry.character === card.id)?.death).toBe(2)
    expect((await project.findCharacter(card.id)) as unknown as Record<string, unknown>).not.toHaveProperty('status')
    expect((await project.outline()).threads.map(thread => thread.title)).toEqual(['渡口的血'])
  })

  it('digests the chapters of every line: whatever is pending, and a chapter of another line when it is named', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 2)
    const line = await project.addLine({ title: '她没有上船', from: main[0]! })
    const first = await project.addChapter({ title: '码头' }, { line: line.id })
    const second = await project.addChapter({ title: '回城' }, { line: line.id })
    await project.saveChapterText(first.id, '她在码头站了一夜。')
    await project.saveChapterText(second.id, '天亮时她往回走。')
    bed.llm.responder = () => JSON.stringify({ brief: '一句', summary: '一段。', characters: [], facts: [], newEntities: [], threads: [] })
    // Named, a chapter of another line is digested — it used to be passed over without a word.
    expect(await digestPending(bed.core, bed.runtime, { origin: 'user' }, { chapters: [second.id] })).toEqual({ digested: [second.id], failed: [] })
    // Asked for what is pending, the other lines' chapters are among it.
    const rest = await digestPending(bed.core, bed.runtime, { origin: 'user' })
    expect(rest.failed).toEqual([])
    expect(rest.digested).toContain(first.id)
    expect(rest.digested).not.toContain(second.id)
    expect((await project.chapterInfos(line.id)).filter(info => info.hasText).every(info => info.digested)).toBe(true)
    expect(await digestPending(bed.core, bed.runtime, { origin: 'user' })).toEqual({ digested: [], failed: [] })
  })

  it('turns an interlude into a line of the plot of its own', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 3)
    await project.saveCharacter({ name: '沈璃', role: 'protagonist' })
    bed.llm.responder = () => JSON.stringify({ narration: '渡口起了雾。', lines: [], choices: ['上船', '回头'] })
    const session = await startPlay(bed.core, bed.runtime, { situation: '沈璃在渡口等船。', cast: ['沈璃'], player: '沈璃', anchor: main[1]! }, { origin: 'user' })
    await project.savePlaySession({ ...session, turns: [...session.turns, { id: 't1', input: { kind: 'choice', text: '回头，不上这条船' }, lines: [], choices: [], createdAt: new Date().toISOString() }] })
    bed.llm.responder = () => '她在雾里站了很久，终于转身往回走。'
    const result = await novelizePlay(bed.core, bed.runtime, { session: session.id, as: 'line' }, { origin: 'user' })
    const line = (await project.findLine(result.line!.id))!
    // It leaves where the scene branched off; what the player first did is the choice that leads onto it.
    expect(line).toMatchObject({ from: main[1], origin: 'interlude', play: session.id, choice: '回头，不上这条船' })
    expect(await titles(bed)).toEqual(['主线1', '主线2', '主线3'])
    expect((await project.chapters(line.id)).map(chapter => chapter.plan.id)).toEqual([main[0], main[1], result.chapterId])
    expect((await project.playSession(session.id))!.novelizedLine).toBe(line.id)
  })

  it('names every way on where the story parts, whichever line is being read', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 4)
    const sent = await project.addLine({ title: '她把信寄了出去', from: main[1]!, choice: '当晚就寄' })
    const s1 = await project.addChapter({ title: '寄出之后' }, { line: sent.id })
    const s2 = await project.addChapter({ title: '回信' }, { after: s1.id })
    // A line that leaves from a chapter of another line: two forks deep.
    const burnt = await project.addLine({ title: '她烧了回信', from: s1.id, choice: '烧掉' })
    const b1 = await project.addChapter({ title: '灰' }, { line: burnt.id })
    const shelved = await project.addLine({ title: '搁置的走向', from: main[1]! })
    await project.updateLine(shelved.id, { shelved: true })
    const state = await project.state()
    const chapter = (id: string) => [...state.chapters, ...state.lines!.flatMap(line => line.chapters)].find(item => item.id === id)!
    const brief = (result: ReturnType<typeof waysOn>) => ({ along: result.along?.id, ways: result.ways.map(way => [way.line, way.left === true, way.chapters.map(item => item.title)]) })

    // On the main line, the fork offers the line that leaves — not the one put aside — and nobody's choice is "going on".
    expect(brief(waysOn(state, chapter(main[1]!), MAIN_LINE))).toEqual({ along: undefined, ways: [[sent.id, false, ['寄出之后', '回信']]] })
    // On that line, the same chapter offers the main line going on as it did; going on along the path is the line's choice.
    expect(brief(waysOn(state, chapter(main[1]!), sent.id))).toEqual({ along: sent.id, ways: [[MAIN_LINE, true, ['主线3', '主线4']]] })
    // Two forks deep: at the first fork the line being read rides the other line, which is not "another way";
    expect(brief(waysOn(state, chapter(main[1]!), burnt.id))).toEqual({ along: sent.id, ways: [[MAIN_LINE, true, ['主线3', '主线4']]] })
    // at its own fork, the line it left goes on.
    expect(brief(waysOn(state, chapter(s1.id), burnt.id))).toEqual({ along: burnt.id, ways: [[sent.id, true, ['回信']]] })
    expect(brief(waysOn(state, chapter(s1.id), sent.id))).toEqual({ along: undefined, ways: [[burnt.id, false, ['灰']]] })
    // Chapters of a way are counted along its own line.
    expect(waysOn(state, chapter(s1.id), sent.id).ways[0]!.chapters[0]).toMatchObject({ id: b1.id, index: 4 })
    // Where nothing parts, nothing is offered.
    expect(waysOn(state, chapter(main[2]!), MAIN_LINE).ways).toEqual([])
    expect(waysOn(state, chapter(s2.id), sent.id).ways).toEqual([])
  })
})

describe('the order the cast is listed in', () => {
  it('goes by the weight of the part, then by how much of the book they are in, then by who came first', async () => {
    const { castOrder } = await import('../src/shared/types')
    const cards = [
      { id: 'walk', role: 'cameo' as const },
      { id: 'maid', role: 'supporting' as const },
      { id: 'aunt', role: 'supporting' as const },
      { id: 'lead', role: 'protagonist' as const },
      { id: 'late', role: 'supporting' as const },
      { id: 'foe', role: 'antagonist' as const },
    ]
    const presence = [
      { character: 'maid', chapters: ['c2', 'c3'], absentFor: 0 },
      { character: 'aunt', chapters: ['c1', 'c2', 'c3'], absentFor: 0 },
      { character: 'late', chapters: ['c3', 'c4'], absentFor: 0 },
      { character: 'lead', chapters: ['c1'], absentFor: 2 },
    ]
    // The lead first whatever their count; of the supporting parts the one in most chapters, then — equal — the one who came on first.
    expect(castOrder(cards, presence, ['c1', 'c2', 'c3', 'c4']).map(card => card.id)).toEqual(['lead', 'foe', 'aunt', 'maid', 'late', 'walk'])
    // With nothing known of who is where, parts of one weight keep the order they came in.
    expect(castOrder(cards).map(card => card.id)).toEqual(['lead', 'foe', 'maid', 'aunt', 'late', 'walk'])
  })
})

describe('a story that goes more than one way, to whoever reads it', () => {
  const chapter = (id: string, line?: string): { id: string; line?: string } => ({ id, ...(line !== undefined ? { line } : {}) })
  const main: ReaderLine = { id: 'main', title: '', path: ['c1', 'c2', 'c3', 'c4'], own: 4 }
  const letter: ReaderLine = { id: 'ln_a', title: '她把信寄了出去', from: 'c2', choice: '把信投进邮筒', path: ['c1', 'c2', 'a1', 'a2'], own: 2 }
  // A line that parts from the other line, one chapter into it.
  const reply: ReaderLine = { id: 'ln_b', title: '回信来了', from: 'a1', path: ['c1', 'c2', 'a1', 'b1'], own: 1 }
  const every = [chapter('c1'), chapter('c2'), chapter('c3'), chapter('c4'), chapter('a1', 'ln_a'), chapter('a2', 'ln_a'), chapter('b1', 'ln_b')]
  const ids = (list: readonly { id: string }[]): string[] => list.map(item => item.id)

  it('is read along the line chosen, and says at each chapter how else it goes on', () => {
    // One way only: the chapters are what is read, and nothing parts anywhere.
    expect(readAlong(every.slice(0, 4), undefined, 'main', 'c2')).toMatchObject({ line: undefined, ways: [] })
    expect(ids(readAlong(every.slice(0, 4), [main], 'ln_a', undefined).chapters)).toEqual(['c1', 'c2', 'c3', 'c4'])

    const lines = [main, letter, reply]
    // Along the main line: its own chapters; where another line leaves, that line is a way on, in the words of its choice.
    const onMain = readAlong(every, lines, 'main', 'c2')
    expect(onMain.line?.id).toBe('main')
    expect(ids(onMain.chapters)).toEqual(['c1', 'c2', 'c3', 'c4'])
    // The third line goes on with the same chapter as the second: one way on, not two.
    expect(onMain.ways.map(way => [way.line.id, way.next.id, way.leaves])).toEqual([['ln_a', 'a1', true]])
    expect(readAlong(every, lines, 'main', 'c1').ways).toEqual([])
    expect(readAlong(every, lines, 'main', 'c3').ways).toEqual([])

    // Along the other line: what came before it parts, then its own. Where it left, the main line goes on without it — a way on too, and no choice of this line's.
    const onLetter = readAlong(every, lines, 'ln_a', 'c2')
    expect(ids(onLetter.chapters)).toEqual(['c1', 'c2', 'a1', 'a2'])
    expect(onLetter.ways.map(way => [way.line.id, way.next.id, way.leaves])).toEqual([['main', 'c3', false]])
    expect(readAlong(every, lines, 'ln_a', 'a1').ways.map(way => [way.line.id, way.next.id, way.leaves])).toEqual([['ln_b', 'b1', true]])

    // A chapter the chosen line does not go through is read along its own line: a link into another line keeps its way on.
    const linked = readAlong(every, lines, 'main', 'a2')
    expect(linked.line?.id).toBe('ln_a')
    expect(ids(linked.chapters)).toEqual(['c1', 'c2', 'a1', 'a2'])
    expect(readAlong(every, lines, 'ln_a', 'c4').line?.id).toBe('main')
    // A line chosen once and no longer offered: the main line. A chapter nobody has: the line stays as chosen.
    expect(readAlong(every, lines, 'ln_gone', undefined).line?.id).toBe('main')
    expect(readAlong(every, lines, 'ln_a', 'nowhere')).toMatchObject({ line: { id: 'ln_a' }, ways: [] })
  })

  describe('as the book gives it', () => {
    let bed: TestBed
    beforeEach(async () => { bed = await createTestBed() })
    afterEach(async () => { await bed.cleanup() })

    it('offers the lines that are not put aside and have something written, with the chapters only they have', async () => {
      const { project } = bed.runtime
      const [c1, c2, c3] = await book(bed, 4, 3)
      // One way only: nothing to choose between.
      expect(await listLines(bed.runtime)).toBeUndefined()
      const letter = await project.addLine({ title: '她把信寄了出去', from: c2!, choice: '把信投进邮筒', premise: '信寄出去了，一切都不一样。' })
      const a1 = await project.addChapter({ title: '另一个早晨' }, { line: letter.id })
      const a2 = await project.addChapter({ title: '还没写的' }, { line: letter.id })
      // Planned and not written: no way to offer yet.
      expect(await listLines(bed.runtime)).toBeUndefined()
      await project.saveChapterText(a1.id, '另一个早晨的正文。')
      const shelved = await project.addLine({ title: '搁置的线', from: c1!, shelved: true })
      const s1 = await project.addChapter({ title: '搁置的章' }, { line: shelved.id })
      await project.saveChapterText(s1.id, '搁置的正文。')
      const empty = await project.addLine({ title: '只有章纲的线', from: c3! })
      await project.addChapter({ title: '空章' }, { line: empty.id })

      const ways = (await listLines(bed.runtime))!
      expect(ways.lines).toEqual([
        { id: MAIN_LINE, title: '', path: [c1, c2, c3], own: 3 },
        { id: letter.id, title: '她把信寄了出去', premise: '信寄出去了，一切都不一样。', from: c2, choice: '把信投进邮筒', path: [c1, c2, a1.id], own: 1 },
      ])
      expect(ways.chapters).toEqual([expect.objectContaining({ id: a1.id, title: '另一个早晨', line: letter.id, index: 3 })])
      // What a device is answered with: every chapter there is to read, and the lines to read them along.
      const answer = await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: [], by: 'test' }) as { book: { chapters: number }; chapters: { id: string; line?: string }[]; lines?: ReaderLine[] }
      expect(answer.chapters.map(item => [item.id, item.line])).toEqual([[c1, undefined], [c2, undefined], [c3, undefined], [a1.id, letter.id]])
      expect(answer.lines).toEqual(ways.lines)
      // The book is as long as its main line.
      expect(answer.book.chapters).toBe(3)
      const read = await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['chapters', a1.id], by: 'test' }) as { id: string; index: number; text: string }
      expect(read).toMatchObject({ id: a1.id, index: 3, text: '另一个早晨的正文。' })
      expect(a2.id).not.toBe(a1.id)

      // A site of the book has them too — unless it keeps to the main line, or is a part of the book.
      const out = await mkdtemp(join(tmpdir(), 'novel-lines-'))
      try {
        const id = (await project.manifest()).id
        const done = await publishSite(bed.core, bed.runtime, { out, reader: new TextEncoder().encode('/* reader */') })
        expect(done).toMatchObject({ chapters: 3, lines: { lines: 1, chapters: 1 } })
        const site = JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8'))
        expect(site).toEqual(answer)
        expect(JSON.parse(await readFile(join(out, 'data', id, 'chapters', `${a1.id}.json`), 'utf8'))).toEqual(read)
        const plain = await publishSite(bed.core, bed.runtime, { out, reader: new TextEncoder().encode('/* reader */'), lines: false })
        expect(plain.lines).toBeUndefined()
        expect(plain.removed).toBe(1)
        const mainOnly = JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8'))
        expect(mainOnly.lines).toBeUndefined()
        expect(mainOnly.chapters.map((item: { id: string }) => item.id)).toEqual([c1, c2, c3])
        expect((await publishSite(bed.core, bed.runtime, { out, reader: new TextEncoder().encode('/* reader */'), chapters: [c1!, c2!] })).lines).toBeUndefined()
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    })
  })
})

describe('the line in hand', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('goes with the chapter in focus, and a line taken in hand puts the Studio on a chapter of it', async () => {
    const { project } = bed.runtime
    const main = await book(bed, 3, 2)
    // A line that parts after the first chapter, with one chapter written and one to write; and a story of its own.
    const stay = await project.addLine({ title: '她没有上船', from: main[0]! })
    const s1 = await project.addChapter({ title: '回头' }, { line: stay.id })
    const s2 = await project.addChapter({ title: '再往后' }, { line: stay.id })
    await project.saveChapterText(s1.id, '她折了回去。')
    const south = await project.addLine({ title: '城南的铺子' })
    const c1 = await project.addChapter({ title: '开张' }, { line: south.id })
    const empty = await project.addLine({ title: '还没写的线' })
    const state = await project.state()
    expect(pathOfLine(state, MAIN_LINE)).toEqual(main)
    expect(pathOfLine(state, stay.id)).toEqual([main[0], s1.id, s2.id])
    expect([knownLine(state, undefined), knownLine(state, 'gone'), knownLine(state, south.id)]).toEqual([MAIN_LINE, MAIN_LINE, south.id])
    // A chapter the line in hand reads — its own, or one it shares with the line it parts from — leaves the line as it is.
    expect(lineHolding(state, stay.id, s2.id)).toBe(stay.id)
    expect(lineHolding(state, stay.id, main[0]!)).toBe(stay.id)
    // A chapter it does not read takes the Studio to that chapter's own line.
    expect(lineHolding(state, stay.id, main[2]!)).toBe(MAIN_LINE)
    expect(lineHolding(state, MAIN_LINE, c1.id)).toBe(south.id)
    expect(lineHolding(state, 'gone', s1.id)).toBe(stay.id)
    // Taking a line in hand: the chapter in focus stays where the line reads it; else its first chapter still to
    // write, else its last — and a line with nothing on it leaves the Studio where its path ends, or nowhere.
    expect(chapterOnLine(state, stay.id, main[0]!)).toBe(main[0])
    expect(chapterOnLine(state, stay.id, main[2]!)).toBe(s2.id)
    expect(chapterOnLine(state, MAIN_LINE, c1.id)).toBe(main[2])
    expect(chapterOnLine(state, south.id, main[1]!)).toBe(c1.id)
    expect(chapterOnLine(state, empty.id, main[1]!)).toBeUndefined()
  })
})

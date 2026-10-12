// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The records of a book's derivations: what the author gave each to go by, what the planner handed in and said — kept
 * with the book, read long after the outline they made was edited, and handed to whoever lays out the beats of the
 * chapters they made or writes them, with which chapters that thinking covers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { derivationRecords, derivationsView, logDerivation, noteDerivation, removeDerivation, restoreDerivation, updateDerivation } from '../src/core/derivations'
import { buildFoundation, derivedPlan, deriveBeats, deriveChapters, deriveToLook, enterDerivedPlan, settleDerivedPlan, takeDerivedPlan, touchBeats, whatIf } from '../src/core/pipelines/plot'
import { writeChapter } from '../src/core/pipelines/write'
import { readBook } from '../src/core/reading'
import { createTestBed, type TestBed } from './support/harness'

const author = { origin: 'user' as const }
const showrunner = { origin: 'agent' as const }

const three = {
  chapters: [
    { title: '下山', synopsis: '沈璃带着断剑下山。', characters: ['沈璃'], beats: [{ summary: '告别旧居' }, { summary: '在山门遇阻' }] },
    { title: '渡口', synopsis: '渡口遇见顾七，两人互相试探。', characters: ['沈璃'], beats: [{ summary: '渡口等船' }] },
    { title: '夜渡', synopsis: '夜里过河，船上出了事。', characters: ['沈璃'], beats: [{ summary: '上船' }] },
  ],
  rationale: '前两章压着写，第三章才放开：先离开，再相遇，最后翻脸。也可以让顾七在第二章就亮明身份——没有采用。',
}

describe('the records of a book\'s derivations', () => {
  let bed: TestBed
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '青冥' })
    await bed.runtime.project.saveCharacter({ name: '沈璃', role: 'protagonist' })
  })
  afterEach(async () => { await bed.cleanup() })

  const pack = async (chapterId: string, purpose: 'draft' | 'derive' | 'review' | 'revise' = 'draft') => {
    const located = (await bed.runtime.project.findChapter(chapterId))!
    return await bed.core.pack(bed.runtime, await bed.core.route('writer', bed.runtime, {}), { purpose, chapter: located })
  }

  it('chapters derived into the outline leave a record: what was asked, what came back, which chapters it made', async () => {
    const { project } = bed.runtime
    expect(await derivationRecords(project)).toEqual([])
    expect((await project.state()).derivations).toBeUndefined()
    bed.llm.responder = () => JSON.stringify(three)
    const result = await deriveChapters(bed.core, bed.runtime, { count: 3, direction: ' 这三章要阴暗：压着写，不给她喘气的机会。 ' }, showrunner)
    const [record] = await derivationRecords(project)
    expect(result.record).toBe(record!.id)
    expect(record).toMatchObject({ kind: 'chapters', by: 'showrunner', state: 'entered', mode: 'append', direction: '这三章要阴暗：压着写，不给她喘气的机会。', chapters: result.added.map(item => item.id) })
    expect(record!.turns).toHaveLength(1)
    expect(record!.turns[0]).toMatchObject({ rationale: three.rationale })
    expect(record!.turns[0]!.chapters!.map(chapter => chapter.title)).toEqual(['下山', '渡口', '夜渡'])
    // It is a file of the book, and what the book's state counts.
    const stored = JSON.parse((await project.readFile('derivations/index.json')).toString('utf8')) as { items: { id: string }[] }
    expect(stored.items.map(item => item.id)).toEqual([record!.id])
    expect((await project.state()).derivations).toMatchObject({ count: 1 })
    // As a page shows it: where its chapters stand now.
    const view = await derivationsView(project)
    expect(view.items[0]!.covers.map(cover => [cover.index, cover.title, cover.written])).toEqual([[1, '下山', false], [2, '渡口', false], [3, '夜渡', false]])
    expect(view.items[0]!.lost).toBe(0)
  })

  it('a derivation made in rounds is one record, added to by each round', async () => {
    const { project } = bed.runtime
    let round = 0
    bed.llm.responder = () => {
      round += 1
      return JSON.stringify(round === 1
        ? { chapters: [{ title: '下山', synopsis: '下山。', characters: [] }, { title: '渡口', synopsis: '渡口。', characters: [] }], rationale: '第一轮：先离开。' }
        : { chapters: [{ title: '夜渡', synopsis: '夜渡。', characters: [] }], rationale: '第二轮：再过河。' })
    }
    const result = await deriveChapters(bed.core, bed.runtime, { count: 11, direction: '一路往南' }, author)
    expect(round).toBe(2)
    const records = await derivationRecords(project)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: result.record, state: 'entered', direction: '一路往南', chapters: result.added.map(item => item.id) })
    expect(records[0]!.turns).toHaveLength(1)
    expect(records[0]!.turns[0]!.chapters!.map(chapter => chapter.title)).toEqual(['下山', '渡口', '夜渡'])
    expect(records[0]!.turns[0]!.rationale).toBe('第一轮：先离开。\n\n第二轮：再过河。')
    // The second round was planned knowing what the first was meant to be.
    expect(bed.llm.requests[1]!.prompt).toContain('这条线此前几次推演时定下的思路')
    expect(bed.llm.requests[1]!.prompt).toContain('第一轮：先离开。')
  })

  it('whoever writes a chapter is handed the thinking it was derived with, and told which chapters it covers', async () => {
    const { project } = bed.runtime
    bed.llm.responder = () => JSON.stringify(three)
    const { added } = await deriveChapters(bed.core, bed.runtime, { count: 3, direction: '这三章要阴暗：压着写，不给她喘气的机会。' }, author)
    await project.saveChapterText(added[0]!.id, '山门外雪落无声。沈璃没有回头。')
    const second = await pack(added[1]!.id)
    for (const part of [
      '## 这几章当初定下的思路（推演时作者给的方向和策划的说明：这一段要讲什么、是什么基调）',
      // What holds where: the outline for the events, this for the key.
      '本章发生什么，照它自己的章纲。这一段的基调——轻还是重、亮还是暗、要读者笑还是要读者怕——照下面定的来；它和全书文风里写的气氛、和节拍上标的情绪不一样时，这几章照这里的。章纲后来改过、事情和下面说的对不上时，事情以章纲为准。',
      '这一段思路管第 1–3 章，共 3 章。现在这一章是第 2 章——这一段里的第 2 章：',
      '1. 第 1 章《下山》（已写）',
      '2. 第 2 章《渡口》 ← 现在这一章',
      '3. 第 3 章《夜渡》（还没写）',
      '作者给的方向：\n这三章要阴暗：压着写，不给她喘气的机会。',
      '策划当时的说明（写给作者看的；里面提到而没有采用的别的走法不算数）：\n前两章压着写，第三章才放开',
    ]) expect(second.text, part).toContain(part)
    expect(second.included.intent).toBe(1)
    // It belongs to this piece of work, and is read just before the chapter's own outline.
    expect(second.stable).not.toContain('这三章要阴暗')
    expect(second.rest.indexOf('这几章当初定下的思路')).toBeLessThan(second.rest.indexOf('## 本章章纲'))
    expect(second.rest.indexOf('这几章当初定下的思路')).toBeGreaterThan(0)
    // The writer's request carries it, and the result says so.
    bed.llm.requests.length = 0
    bed.llm.responder = () => '渡口的风很硬。顾七把斗笠压低了。'
    const written = await writeChapter(bed.core, bed.runtime, { chapter: added[1]!.id }, author)
    expect(bed.llm.requests[0]!.prompt).toContain('这三章要阴暗：压着写，不给她喘气的机会。')
    expect(bed.llm.requests[0]!.prompt).toContain('现在这一章是第 2 章——这一段里的第 2 章')
    // …and names the key again with what is asked last: said only among what was read, it loses to the book's usual voice.
    expect(bed.llm.requests[0]!.prompt.split('\n---\n').at(-1)).toContain('基调：照上面“这几章当初定下的思路”里定的写')
    expect((written as { intent?: number }).intent).toBe(1)
    // A review reads the text against its outline: it is not handed the thinking.
    expect((await pack(added[1]!.id, 'review')).text).not.toContain('这几章当初定下的思路')
    // A revision of the chapter is.
    expect((await pack(added[1]!.id, 'revise')).text).toContain('这三章要阴暗')
    // A chapter no derivation made has nothing of the kind.
    const loose = await project.addChapter({ title: '番外', synopsis: '一件旧事。' })
    const without = await pack(loose.id)
    expect(without.text).not.toContain('这几章当初定下的思路')
    expect(without.included.intent).toBeUndefined()
  })

  it('a plan looked at first: each word of the author\'s is a turn of its record, and what it became is told', async () => {
    const { project } = bed.runtime
    const first = { chapters: three.chapters.slice(0, 2), rationale: '先离开，再相遇。' }
    const second = { chapters: three.chapters, rationale: '照意见加了一章夜渡。' }
    bed.roles.enabled = true
    bed.roles.script = async (_task, call) => { await call('submit_chapters', { result: bed.roles.tasks.length === 1 ? first : second }) }
    const shown = await deriveToLook(bed.core, bed.runtime, { count: 2, direction: '轻快一点，像出门远行' }, author)
    let [record] = await derivationRecords(project)
    expect(shown.record).toBe(record!.id)
    expect((await derivedPlan(bed.runtime))!.record).toBe(record!.id)
    expect(record).toMatchObject({ kind: 'chapters', by: 'author', state: 'waiting', direction: '轻快一点，像出门远行', chapters: [] })
    // Still looked at: nobody is handed it yet.
    expect((await derivationsView(project)).items[0]!.covers).toEqual([])

    await deriveToLook(bed.core, bed.runtime, { feedback: '渡口之后加一章夜里过河' }, author)
    ;[record] = await derivationRecords(project)
    expect(await derivationRecords(project)).toHaveLength(1)
    expect(record!.turns).toHaveLength(2)
    expect(record!.turns[0]!.chapters).toHaveLength(2)
    expect(record!.turns[1]).toMatchObject({ feedback: '渡口之后加一章夜里过河', rationale: '照意见加了一章夜渡。' })
    expect(record!.turns[1]!.chapters).toHaveLength(3)

    const entered = (await enterDerivedPlan(bed.core, bed.runtime))!
    ;[record] = await derivationRecords(project)
    expect(record).toMatchObject({ state: 'entered', chapters: entered.added.map(item => item.id) })
    // Whoever writes its third chapter reads the direction, the word that followed, and what the planner said last.
    const third = await pack(entered.added[2]!.id)
    for (const part of ['作者给的方向：\n轻快一点，像出门远行', '作者看过之后要改的：\n1. 渡口之后加一章夜里过河', '照意见加了一章夜渡。', '这一段里的第 3 章']) expect(third.text, part).toContain(part)
    expect(third.text).not.toContain('先离开，再相遇。')

    // Derived again and let go; then added by the page, which names the chapters it made of it.
    bed.roles.script = async (_task, call) => { await call('submit_chapters', { result: first }) }
    const again = await deriveToLook(bed.core, bed.runtime, { count: 2, direction: '第二次' }, author)
    await settleDerivedPlan(bed.core, bed.runtime)
    expect((await derivationRecords(project)).find(item => item.id === again.record)).toMatchObject({ state: 'discarded', chapters: [] })
    const once = await deriveToLook(bed.core, bed.runtime, { count: 2, direction: '第三次' }, author)
    const made = await project.addChapter({ title: '下山（二）' })
    await settleDerivedPlan(bed.core, bed.runtime, [made.id])
    expect((await derivationRecords(project)).find(item => item.id === once.record)).toMatchObject({ state: 'entered', chapters: [made.id] })
    // One that waited, derived anew over: the one before was let go.
    const older = await deriveToLook(bed.core, bed.runtime, { count: 2, direction: '第四次' }, author)
    const newer = await deriveToLook(bed.core, bed.runtime, { count: 2, direction: '第五次' }, author)
    const all = await derivationRecords(project)
    expect(all.find(item => item.id === older.record)!.state).toBe('discarded')
    expect(all.find(item => item.id === newer.record)!.state).toBe('waiting')
    // A plan taken from several derived side by side is recorded as what it is.
    const taken = await takeDerivedPlan(bed.core, bed.runtime, { chapters: (await derivedPlan(bed.runtime))!.chapters, rationale: '模型甲：这样排。', direction: '第六次' })
    const kept = (await derivationRecords(project)).find(item => item.id === taken.record)!
    expect(kept).toMatchObject({ state: 'waiting', by: 'author', direction: '第六次' })
    expect((await derivationRecords(project)).find(item => item.id === newer.record)!.state).toBe('discarded')
  })

  it('a chapter\'s beats: laid out with the stretch\'s thinking and the outlines around it, and what was said then goes to the writer', async () => {
    const { project } = bed.runtime
    bed.llm.responder = () => JSON.stringify(three)
    const { added } = await deriveChapters(bed.core, bed.runtime, { count: 3, direction: '这三章要阴暗。' }, author)
    bed.llm.requests.length = 0
    bed.llm.responder = () => JSON.stringify({ synopsis: '渡口遇见顾七。', beats: [{ summary: '渡口等船，雾里有人咳嗽' }, { summary: '顾七递来一只空酒壶' }], rationale: '先让她等，再让他出现。' })
    const laid = await deriveBeats(bed.core, bed.runtime, { chapter: added[1]!.id, direction: '这一章顾七不要说真话' }, author)
    // The planner is not left to break a synopsis down blind: the stretch's thinking, the chapter before that is not
    // written yet, the outline of the one after.
    const asked = bed.llm.requests[0]!.prompt
    for (const part of ['这几章当初定下的思路', '这三章要阴暗。', '排在本章之前、还没有写出来的章节（按章纲）', '第1章 下山  沈璃带着断剑下山。', '下一章的章纲（这一章的节拍要引到那里；它的事不要提前排掉）', '夜渡：夜里过河，船上出了事。', '## 作者给的方向\n\n这一章顾七不要说真话']) expect(asked, part).toContain(part)
    expect(laid.rationale).toBe('先让她等，再让他出现。')
    const records = await derivationRecords(project)
    const beats = records.find(item => item.id === laid.record)!
    expect(beats).toMatchObject({ kind: 'beats', by: 'author', direction: '这一章顾七不要说真话', chapters: [added[1]!.id] })
    expect(beats.turns[0]!.beats!.map(beat => beat.summary)).toEqual(['渡口等船，雾里有人咳嗽', '顾七递来一只空酒壶'])
    expect(beats.turns[0]!.rationale).toBe('先让她等，再让他出现。')

    // One beat by a sentence is recorded too, with the sentence.
    bed.llm.responder = () => JSON.stringify({ beat: { summary: '她闻到酒壶里是药味' }, after: 2, why: '接在酒壶之后。' })
    await touchBeats(bed.core, bed.runtime, { chapter: added[1]!.id, ask: '加一场：酒壶里其实是药' }, author)
    expect((await derivationRecords(project)).at(-1)).toMatchObject({ kind: 'beat', mode: 'add', direction: '加一场：酒壶里其实是药', chapters: [added[1]!.id] })

    // The writer reads the stretch, what was said when the beats were laid out, and what was said of single beats since.
    const draft = await pack(added[1]!.id)
    for (const part of ['这三章要阴暗。', '〔排这一章的节拍时', '作者给的方向：\n这一章顾七不要说真话', '〔作者加、改这一章的节拍时说的话〕\n1. 加一场：酒壶里其实是药']) expect(draft.text, part).toContain(part)
    expect(draft.included.intent).toBe(3)
    // Whoever lays the beats out anew is given the author's word of the moment, not the one of the time before.
    const anew = await pack(added[1]!.id, 'derive')
    expect(anew.text).toContain('这三章要阴暗。')
    expect(anew.text).not.toContain('〔排这一章的节拍时')
    // Beats laid out again with nothing said: what was said the time before no longer holds.
    bed.llm.responder = () => JSON.stringify({ beats: [{ summary: '渡口等船' }] })
    await deriveBeats(bed.core, bed.runtime, { chapter: added[1]!.id }, author)
    const later = await pack(added[1]!.id)
    expect(later.text).not.toContain('这一章顾七不要说真话')
    expect(later.text).not.toContain('酒壶里其实是药')
    expect(later.text).toContain('这三章要阴暗。')
  })

  it('what comes next on a line is planned knowing what the stretches before it were meant to be', async () => {
    const { project } = bed.runtime
    bed.llm.responder = () => JSON.stringify(three)
    await deriveChapters(bed.core, bed.runtime, { count: 3, direction: '这三章要阴暗。' }, author)
    bed.llm.requests.length = 0
    bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '上岸', synopsis: '天亮了。', characters: ['沈璃'] }], rationale: '松一口气。' })
    await deriveChapters(bed.core, bed.runtime, { count: 1, direction: '这一章亮一点' }, author)
    const asked = bed.llm.requests[0]!.prompt
    for (const part of ['## 这条线此前几次推演时定下的思路（最近的在后：前面的基调和打算。这一次以作者这次给的方向为准）', '〔推演章节 · ', '〕第 1–3 章', '作者给的方向：\n这三章要阴暗。', '## 作者给的方向\n\n这一章亮一点']) expect(asked, part).toContain(part)
    // It is told which chapter the new one follows: the last the outline has, planned and not written — which is not its to plan again.
    expect(asked).toContain('这些章节接在大纲现有的最后一章「3. 夜渡」之后——那一章还没写，但已经排好了。大纲里已经有的章节都不重排，它们的事也不再讲一遍：从它之后讲起。')
    // A what-if is kept too — nothing of the outline changes by it, so it would be nowhere otherwise.
    bed.llm.responder = () => JSON.stringify({ branches: [{ title: '她没有上船', development: '留在渡口。', consequences: ['顾七独自过河'] }], recommendation: '不建议。' })
    const asked2 = await whatIf(bed.core, bed.runtime, { question: '如果她没有上船？' }, showrunner)
    const kept = (await derivationRecords(project)).find(item => item.id === asked2.record)!
    expect(kept).toMatchObject({ kind: 'whatif', by: 'showrunner', direction: '如果她没有上船？', chapters: [] })
    expect(kept.turns[0]).toMatchObject({ recommendation: '不建议。', branches: [{ title: '她没有上船' }] })
  })

  it('the author writes one down themself, adds to one, keeps one back, takes one away and puts it back', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '下山', synopsis: '沈璃下山。' })
    const two = await project.addChapter({ title: '渡口', synopsis: '渡口遇见顾七。' })
    await expect(noteDerivation(project, { chapters: [one.id], text: '  ' })).rejects.toThrow(/meant to be/)
    await expect(noteDerivation(project, { chapters: [], text: '阴暗' })).rejects.toThrow(/name the chapters/)
    const note = await noteDerivation(project, { chapters: [one.id, two.id], text: '这两章当初想写得很欢乐：一路斗嘴。' })
    expect(note).toMatchObject({ kind: 'note', by: 'author', direction: '这两章当初想写得很欢乐：一路斗嘴。' })
    let draft = await pack(two.id)
    for (const part of ['〔作者自己记的 · ', '这一段思路管第 1–2 章，共 2 章。', '作者写的：\n这两章当初想写得很欢乐：一路斗嘴。']) expect(draft.text, part).toContain(part)
    // Added to.
    await updateDerivation(project, note.id, { note: '顾七的玩笑要带刺。' })
    draft = await pack(two.id)
    expect(draft.text).toContain('作者后来补的：\n顾七的玩笑要带刺。')
    // Its own text is the author's to change; a record a derivation left keeps what was said then.
    expect((await updateDerivation(project, note.id, { text: '改成：先欢乐，后冷下来。' })).direction).toBe('改成：先欢乐，后冷下来。')
    bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '夜渡', synopsis: '夜里过河。', characters: [] }] })
    const derived = await deriveChapters(bed.core, bed.runtime, { count: 1, direction: '原话' }, author)
    expect((await updateDerivation(project, derived.record!, { text: '不许改' })).direction).toBe('原话')
    // Kept back: it stays on its page and goes to nobody.
    expect((await updateDerivation(project, note.id, { carry: false })).carry).toBe(false)
    draft = await pack(two.id)
    expect(draft.text).not.toContain('这几章当初定下的思路')
    expect((await derivationsView(project)).items.find(item => item.id === note.id)).toMatchObject({ carry: false })
    expect((await updateDerivation(project, note.id, { carry: true })).carry).toBeUndefined()
    // Taken away and put back.
    await removeDerivation(project, note.id)
    expect((await pack(two.id)).text).not.toContain('这几章当初定下的思路')
    let view = await derivationsView(project)
    expect(view.items.map(item => item.id)).toEqual([derived.record])
    expect(view.removed.map(item => item.id)).toEqual([note.id])
    await restoreDerivation(project, note.id)
    view = await derivationsView(project)
    expect(view.items.map(item => item.id).sort()).toEqual([note.id, derived.record!].sort())
    expect(view.removed).toEqual([])
    expect((await pack(two.id)).text).toContain('先欢乐，后冷下来')
    await expect(updateDerivation(project, 'nope', { note: 'x' })).rejects.toMatchObject({ code: 'novel/not-found' })
    await expect(removeDerivation(project, 'nope')).rejects.toMatchObject({ code: 'novel/not-found' })
    // A chapter of it that leaves the outline is counted as lost, and the rest still stand.
    await project.removeChapter(one.id)
    const after = (await derivationsView(project)).items.find(item => item.id === note.id)!
    expect(after.covers.map(cover => cover.title)).toEqual(['渡口'])
    expect(after.lost).toBe(1)
    expect((await pack(two.id)).text).toContain('这一段思路只管这一章（第 1 章）。')
  })

  it('is read by the showrunner and the crew: listed, one whole, or the ones a chapter came of', async () => {
    const { project } = bed.runtime
    expect((await readBook(bed.runtime, { what: 'derivations' })).text).toContain('keeps no records of derivations')
    bed.llm.responder = () => JSON.stringify(three)
    const { added, record } = await deriveChapters(bed.core, bed.runtime, { count: 3, direction: '这三章要阴暗。' }, showrunner)
    const listed = await readBook(bed.runtime, { what: 'derivations' })
    for (const part of [`[${record}; chapters; `, 'showrunner', '第 1–3 章 — 这三章要阴暗。']) expect(listed.text, part).toContain(part)
    const whole = await readBook(bed.runtime, { what: 'derivations', ref: record! })
    for (const part of ['推演章节', '总编经手', '第 1 章《下山》', '## 作者给的\n这三章要阴暗。', '策划的说明：前两章压着写', '2. 渡口：渡口遇见顾七，两人互相试探。', '   1) 渡口等船']) expect(whole.text, part).toContain(part)
    // By a chapter: the records it came of.
    expect((await readBook(bed.runtime, { what: 'derivations', ref: '2' })).text).toContain('这三章要阴暗。')
    const loose = await project.addChapter({ title: '番外' })
    await expect(readBook(bed.runtime, { what: 'derivations', ref: loose.id })).rejects.toMatchObject({ code: 'novel/not-found' })
    expect(added).toHaveLength(3)
  })

  it('records made at the same moment are all kept, and a new book\'s idea is the first of them', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '下山' })
    await Promise.all(Array.from({ length: 12 }, (_unused, at) => logDerivation(project, { kind: 'beats', by: 'author', direction: `第 ${at} 条`, chapters: [chapter.id] })))
    expect(await derivationRecords(project)).toHaveLength(12)

    const fresh = await createTestBed({ language: 'zh', title: '新书' })
    try {
      fresh.llm.responder = () => JSON.stringify({ title: '新书', logline: '一句话', characters: [{ name: '阿棠', role: 'protagonist' }], opening: [{ title: '雨夜', synopsis: '她来了。', characters: ['阿棠'] }, { title: '账本', synopsis: '账对不上。' }] })
      const built = await buildFoundation(fresh.core, fresh.runtime, { idea: '一个欢乐的、吵吵闹闹的弄堂故事，谁也别死。', keepTitle: true }, author)
      expect(built.chapters).toBe(2)
      const [record] = await derivationRecords(fresh.runtime.project)
      expect(record).toMatchObject({ kind: 'foundation', direction: '一个欢乐的、吵吵闹闹的弄堂故事，谁也别死。' })
      expect(record!.chapters).toHaveLength(2)
      const located = (await fresh.runtime.project.findChapter(record!.chapters[1]!))!
      const draft = await fresh.core.pack(fresh.runtime, await fresh.core.route('writer', fresh.runtime, {}), { purpose: 'draft', chapter: located })
      for (const part of ['〔新书起头 · ', '作者起头时写下的想法：\n一个欢乐的、吵吵闹闹的弄堂故事，谁也别死。', '这一段里的第 2 章']) expect(draft.text, part).toContain(part)
    } finally {
      await fresh.cleanup()
    }
  })
})

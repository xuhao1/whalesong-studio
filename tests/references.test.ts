// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The books a book goes by: a book of the shelf, consulted as it is organised
 * there and as far as the author opened it; a manuscript taken in for this
 * book alone, consulted as plain text. Nothing of either is put into a task:
 * whoever works on the book as an agent reads in them with tools, and the
 * writer is handed the notes the planner took for the chapter it writes.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consultReferences, NO_AGENT } from '../src/core/pipelines/consult'
import { writeChapter } from '../src/core/pipelines/write'
import { deriveChapters } from '../src/core/pipelines/plot'
import { addBookReference, addTextReference, referenceBrief, referenceShelf, referenceTools, removeReference, setConsultBeforeWriting, updateReference } from '../src/core/references'
import { createTestBed, type TestBed } from './support/harness'

let bed: TestBed | undefined

afterEach(async () => {
  await bed?.cleanup()
  bed = undefined
})

const task = { origin: 'user' as const }

const MANUSCRIPT = `第一回 甄士隐梦幻识通灵

此开卷第一回也。作者自云：因曾历过一番梦幻之后，故将真事隐去，而借通灵之说，撰此石头记一书也。

列位看官：你道此书从何而来？说起根由虽近荒唐，细按则深有趣味。

第二回 贾夫人仙逝扬州城

却说封肃因听见公差传唤，忙出来陪笑启问。那些人只嚷：快请出甄爷来！

雨村忙笑道：老先生倚门伫望，敢是街市上有甚新闻否？`

/** Another book on the shelf of the same Studio: organised, with a character, a place, a style and a chapter. */
async function otherBook(made: TestBed) {
  const other = await made.core.create(join(made.dir, 'canon'), { title: '石头记', language: 'zh' })
  const { project } = other
  await project.saveCharacter({ name: '贾雨村', role: 'supporting', tagline: '落魄的读书人', appearance: '腰圆背厚，面阔口方' })
  await project.saveWorld({ name: '葫芦庙', category: 'location', summary: '阊门外十里街仁清巷里的一座小庙' })
  const chapter = await project.addChapter({ title: '甄士隐梦幻识通灵', synopsis: '士隐梦中见一僧一道携石下凡。' })
  await project.saveChapterText(chapter.id, '却说姑苏阊门外有个十里街，街内有个仁清巷，巷内有个古庙，人皆呼作葫芦庙。')
  return other
}

describe('the references of a book', () => {
  it('takes a manuscript in as plain text: listed, read part by part, searched by its words — and gone with its reference', async () => {
    bed = await createTestBed()
    const { core, runtime } = bed
    expect((await referenceShelf(core, runtime)).references).toEqual([])
    expect(await referenceTools(core, runtime)).toEqual([])
    expect(await referenceBrief(core, runtime, 'zh')).toBeUndefined()
    const taken = await addTextReference(runtime, { text: MANUSCRIPT, title: '石头记（前两回）', note: '只学它的章回体和对白的口吻' })
    expect(taken).toMatchObject({ kind: 'text', title: '石头记（前两回）', parts: 2, note: '只学它的章回体和对白的口吻', file: `references/${taken.id}.txt` })
    expect(await runtime.project.has(taken.file!)).toBe(true)
    const shelf = await referenceShelf(core, runtime)
    expect(shelf).toMatchObject({ beforeWriting: true, references: [{ id: taken.id, name: '石头记（前两回）', state: 'ready' }] })
    expect((await runtime.project.state()).references).toBe(1)
    // What an agent is told: that it is there, what the author wants of it, and that it is read with tools.
    const brief = (await referenceBrief(core, runtime, 'zh'))!
    for (const part of ['## 这本书的参考文献', '《石头记（前两回）》', '导入的书稿，纯文字', '作者要怎么参考：只学它的章回体和对白的口吻', 'reference_read / reference_search', '不在任务里']) expect(brief, part).toContain(part)
    expect(brief).not.toContain('此开卷第一回也')
    const [read, search] = await referenceTools(core, runtime)
    expect([read!.name, search!.name]).toEqual(['reference_read', 'reference_search'])
    // Without a word: the list. Its contents: the parts, by number. A part: its text, paged.
    expect(await read!.run({})).toContain('作者要怎么参考：只学它的章回体和对白的口吻')
    const contents = await read!.run({ what: 'contents' })
    expect(contents).toContain('1. 第一回 甄士隐梦幻识通灵')
    expect(contents).toContain('2. 第二回 贾夫人仙逝扬州城')
    const second = await read!.run({ book: '石头记', what: 'part', ref: '2' })
    expect(second).toContain('part 2 "第二回 贾夫人仙逝扬州城"')
    expect(second).toContain('雨村忙笑道')
    expect(second).not.toContain('此开卷第一回也')
    expect(await read!.run({ what: 'part', ref: '1', offset: 10 })).toContain('characters 10–')
    // It has no cards and no outline: asked for one, it says what it has.
    await expect(read!.run({ what: 'character' })).rejects.toThrow(/plain text/)
    // Found by its words, with where — which part, at what offset.
    const hits = await search!.run({ query: '雨村' })
    expect(hits).toContain('part 2 "第二回 贾夫人仙逝扬州城"')
    expect(hits).toContain('雨村忙笑道')
    expect(await search!.run({ query: '飞船' })).toContain('nothing matches')
    // Set aside: on the list, and no longer consulted. Taken off: its file goes with it.
    await updateReference(runtime, taken.id, { off: true })
    expect(await referenceTools(core, runtime)).toEqual([])
    expect((await runtime.project.state()).references).toBeUndefined()
    await updateReference(runtime, taken.id, { off: false, note: '' })
    expect((await referenceShelf(core, runtime)).references[0]!.note).toBeUndefined()
    await removeReference(runtime, taken.id)
    expect((await referenceShelf(core, runtime)).references).toEqual([])
    expect(await runtime.project.has(taken.file!)).toBe(false)
  })

  it('takes a book of the shelf as it is organised there — as far as the author opened it', async () => {
    bed = await createTestBed()
    const { core, runtime } = bed
    const other = await otherBook(bed)
    await expect(addBookReference(core, runtime, { root: runtime.project.root })).rejects.toThrow(/its own reference/)
    const taken = await addBookReference(core, runtime, { root: other.project.root, note: '同一个世界：地名照它的；人物不要搬', scope: ['world', 'text'] })
    expect(taken).toMatchObject({ kind: 'book', title: '石头记', scope: ['world', 'text'] })
    await expect(addBookReference(core, runtime, { root: other.project.root })).rejects.toThrow(/already/)
    const shelf = await referenceShelf(core, runtime)
    expect(shelf.references[0]).toMatchObject({ name: '石头记', state: 'ready', has: { chapters: 1, characters: 1, world: 1 } })
    const brief = (await referenceBrief(core, runtime, 'zh'))!
    expect(brief).toContain('书架上的书，1 章')
    expect(brief).toContain('可以查：世界观与设定、正文')
    const [read, search] = await referenceTools(core, runtime)
    // What is open is read as the book's own tools read it; what is not is refused, with what is.
    expect(await read!.run({ what: 'world' })).toContain('葫芦庙')
    expect(await read!.run({ what: 'world', ref: '葫芦庙' })).toContain('仁清巷')
    expect(await read!.run({ what: 'chapter', ref: '1' })).toContain('姑苏阊门外')
    await expect(read!.run({ what: 'character' })).rejects.toThrow(/did not open its people/)
    await expect(read!.run({ what: 'outline' })).rejects.toThrow(/did not open its plot/)
    // Searched within what is open: the place is found, the person is not offered.
    const found = await search!.run({ query: '葫芦庙' })
    expect(found).toContain('[石头记]')
    expect(found).toContain('葫芦庙')
    expect(found).not.toContain('贾雨村')
    // Opened wholly: everything of it.
    await updateReference(runtime, taken.id, { scope: null })
    expect((await referenceShelf(core, runtime)).references[0]!.scope).toBeUndefined()
    const [all] = await referenceTools(core, runtime)
    expect(await all!.run({ what: 'character' })).toContain('贾雨村')
    expect(await all!.run({ what: 'outline' })).toContain('甄士隐梦幻识通灵')
    // The book on the shelf is not touched by any of it — nor by the reference being taken off.
    await removeReference(runtime, taken.id)
    expect((await other.project.characters()).map(card => card.name)).toEqual(['贾雨村'])
  })

  it('hands every role that works as an agent the tools and what the author said — and puts nothing of a reference into the task', async () => {
    bed = await createTestBed()
    const { core, runtime, roles, llm } = bed
    await addTextReference(runtime, { text: MANUSCRIPT, title: '石头记（前两回）', note: '回目照它的对仗写' })
    await runtime.project.addChapter({ title: '开篇' })
    roles.enabled = true
    let seen = ''
    roles.script = async (work, call) => {
      seen = await call('reference_read', { what: 'part', ref: '1' })
      await call('submit_chapters', { result: { chapters: [{ title: '第二回 冷子兴演说', synopsis: '照参考的回目写法。' }], rationale: '回目照《石头记》的对仗' } })
    }
    await deriveChapters(core, runtime, { count: 1, apply: false }, task)
    const work = roles.tasks.at(-1)!
    expect(work.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['book_read', 'book_search', 'reference_read', 'reference_search']))
    expect(work.rules).toContain('## 这本书的参考文献')
    expect(work.rules).toContain('作者要怎么参考：回目照它的对仗写')
    expect(`${work.rules}${work.prompt}`).not.toContain('此开卷第一回也')
    expect(seen).toContain('此开卷第一回也')
    expect(llm.requests).toHaveLength(0)
  })

  it('has the planner take notes for a chapter before it is written, keeps them on its plan, and hands them to the writer', async () => {
    bed = await createTestBed()
    const { core, runtime, roles, llm } = bed
    const { project } = runtime
    await addTextReference(runtime, { text: MANUSCRIPT, title: '石头记（前两回）', note: '对白的口吻学它' })
    const chapter = await project.addChapter({ title: '入府', synopsis: '她第一次进那座府邸。' })
    llm.responder = () => '她进了府。'
    // The planner set to plain calls cannot read in a reference: nothing is made up — the chapter is written without notes, and that is said.
    const without = await writeChapter(core, runtime, { chapter: chapter.id, digest: false }, task)
    expect(without.referenced).toMatchObject({ chars: 0 })
    expect(without.referenced!.none).toContain('agent')
    expect(llm.requests.at(-1)!.prompt).not.toContain('参考摘记')
    expect((await project.findChapter(chapter.id))!.plan.referenceNotes).toBeUndefined()
    await expect(consultReferences(core, runtime, { chapter: chapter.id }, task)).rejects.toMatchObject({ code: NO_AGENT })

    // As an agent it reads, and hands in what the writer can use.
    roles.enabled = true
    const read: string[] = []
    roles.script = async (work, call) => {
      read.push(await call('reference_search', { query: '笑道' }))
      await call('reference_notes', { result: { notes: '可以借的：对白用“某某忙笑道：……”引出（《石头记（前两回）》第二回）。', used: ['《石头记（前两回）》：第二回'], why: '只查了对白的写法' } })
    }
    const written = await writeChapter(core, runtime, { chapter: chapter.id, digest: false }, task)
    expect(read[0]).toContain('雨村忙笑道')
    // The planner was handed the chapter and the references with what the author said of each — nothing of their text.
    const asked = roles.tasks.at(-1)!
    expect(asked.prompt).toContain('## 要写的这一章')
    expect(asked.prompt).toContain('她第一次进那座府邸')
    expect(asked.prompt).toContain('作者要怎么参考：对白的口吻学它')
    expect(asked.prompt).not.toContain('此开卷第一回也')
    // Kept on the plan, and in the writer's task.
    expect((await project.findChapter(chapter.id))!.plan.referenceNotes).toBe('可以借的：对白用“某某忙笑道：……”引出（《石头记（前两回）》第二回）。')
    const NOTES = '可以借的：对白用“某某忙笑道：……”引出（《石头记（前两回）》第二回）。'
    expect(written.referenced).toEqual({ chars: NOTES.length, fresh: true })
    expect(llm.requests.at(-1)!.prompt).toContain('## 参考摘记（策划从这本书的参考文献里为这一章查来的）\n\n可以借的：对白用“某某忙笑道：……”引出')
    // Written again: the notes are there, and nobody looks a second time.
    const runs = roles.tasks.length
    const again = await writeChapter(core, runtime, { chapter: chapter.id, digest: false }, task)
    expect(roles.tasks).toHaveLength(runs)
    expect(again.referenced).toEqual({ chars: NOTES.length })
    // The author's own notes go to the writer as they stand; emptied, the chapter goes by none — and nobody looks.
    await project.updateChapter(chapter.id, { referenceNotes: '称呼一律用“太太”“姑娘”。', referencesRead: true })
    await writeChapter(core, runtime, { chapter: chapter.id, digest: false }, task)
    expect(llm.requests.at(-1)!.prompt).toContain('称呼一律用“太太”“姑娘”。')
    await project.updateChapter(chapter.id, { referenceNotes: '', referencesRead: true })
    expect((await project.findChapter(chapter.id))!.plan).toMatchObject({ referencesRead: true })
    expect((await project.findChapter(chapter.id))!.plan.referenceNotes).toBeUndefined()
    const bare = await writeChapter(core, runtime, { chapter: chapter.id, digest: false }, task)
    expect(roles.tasks).toHaveLength(runs)
    expect(llm.requests.at(-1)!.prompt).not.toContain('参考摘记')
    expect(bare.referenced?.none).toContain('空')
    // The author turned looking off: a chapter nobody looked for is written as it is.
    await setConsultBeforeWriting(runtime, false)
    const next = await project.addChapter({ title: '次日' })
    const quiet = await writeChapter(core, runtime, { chapter: next.id, digest: false }, task)
    expect(roles.tasks).toHaveLength(runs)
    expect(quiet.referenced).toBeUndefined()
    // …and looked for on request all the same.
    const asked2 = await consultReferences(core, runtime, { chapter: next.id, direction: '只看称谓' }, task)
    expect(asked2.notes).toContain('可以借的')
    expect(roles.tasks.at(-1)!.prompt).toContain('## 作者这次的要求\n只看称谓')
  })
})

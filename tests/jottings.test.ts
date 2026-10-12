// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The author's jottings: loose notes kept with the book. Whoever works on the book finds them — in the search, in what
 * the read tool lists, among what a chapter is planned and written with — as ideas and not as canon; one the author
 * keeps back, or all of them, is in none of these.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foundJottings, jottingsBrief, jottingsView, removeJotting, restoreJotting, saveJotting, setJottingsSearch } from '../src/core/jottings'
import { deriveBeats } from '../src/core/pipelines/plot'
import { readBook, searchBook } from '../src/core/reading'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }

describe('the author\'s jottings', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  it('are written down, changed, taken away and put back — kept in one file of the book', async () => {
    const { project } = bed.runtime
    expect(await jottingsView(project)).toEqual({ items: [], search: true, removed: [] })
    await expect(saveJotting(project, { text: '   ' })).rejects.toThrow(/needs some text/)
    const well = await saveJotting(project, { text: '断肠斋的后院也许该有一口井，井里沉着没寄出去的信。', kind: 'setting' })
    const late = await saveJotting(project, { text: '让程砚秋晚一章出场？', title: '程砚秋的出场', kind: 'plot' })
    expect(well).toMatchObject({ kind: 'setting', text: '断肠斋的后院也许该有一口井，井里沉着没寄出去的信。' })
    expect(well.title).toBeUndefined()
    expect(late).toMatchObject({ kind: 'plot', title: '程砚秋的出场' })
    // The file is the book's own, and what the book's state counts.
    const stored = JSON.parse((await project.readFile('jottings/index.json')).toString('utf8')) as { items: { id: string }[] }
    expect(stored.items.map(item => item.id)).toEqual([well.id, late.id])
    expect((await project.state()).jottings).toBe(2)
    // Changed: only what is given; kept back and let be found again without the note growing younger.
    const changed = await saveJotting(project, { id: well.id, title: '后院的井' })
    expect(changed).toMatchObject({ title: '后院的井', text: well.text, kind: 'setting' })
    const kept = await saveJotting(project, { id: late.id, hidden: true })
    expect(kept).toMatchObject({ hidden: true, updatedAt: late.updatedAt })
    expect((await saveJotting(project, { id: late.id, hidden: false })).hidden).toBeUndefined()
    await expect(saveJotting(project, { id: late.id, text: ' ' })).rejects.toThrow(/take it away/)
    await expect(saveJotting(project, { id: 'nope', text: 'x' })).rejects.toThrow(/no jotting/)
    // Taken away, it can be put back.
    await removeJotting(project, late.id)
    let view = await jottingsView(project)
    expect(view.items.map(item => item.id)).toEqual([well.id])
    expect(view.removed.map(item => item.id)).toEqual([late.id])
    expect((await project.state()).jottings).toBe(1)
    await restoreJotting(project, late.id)
    view = await jottingsView(project)
    expect(view.items.map(item => item.id).sort()).toEqual([well.id, late.id].sort())
    expect(view.removed).toEqual([])
    await expect(restoreJotting(project, late.id)).rejects.toThrow(/taken away/)
  })

  it('are found by whoever searches and reads the book — unless one, or all, is kept back', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(chapter.id, '沈蘅坐在柜台后，把三张底稿又数了一遍。门外的雨下了一夜。')
    const well = await saveJotting(project, { text: '断肠斋的后院也许该有一口井，井里沉着没寄出去的信。', kind: 'setting', title: '后院的井' })
    const late = await saveJotting(project, { text: '让程砚秋晚一章出场，先只让读者听见他的咳嗽。', kind: 'plot' })

    // Searched: a source of its own, said to be one.
    let found = await searchBook(bed.runtime, { query: '后院 井 没寄出去的信' })
    expect(found.text).toContain(`〔jotting · 后院的井 · ${well.id}`)
    expect((await searchBook(bed.runtime, { query: '咳嗽', sources: ['jotting'] })).text).toContain(late.id)
    // …also by a role kept to one line of the plot: a jotting is of the whole book.
    expect((await searchBook(bed.runtime, { query: '后院 井' }, undefined, { line: 'main' })).text).toContain(well.id)
    // Listed and read, named for what they are.
    const listed = await readBook(bed.runtime, { what: 'jottings' })
    for (const part of ['never canon', well.id, late.id, '后院的井']) expect(listed.text, part).toContain(part)
    const one = await readBook(bed.runtime, { what: 'jottings', ref: '后院的井' })
    for (const part of ['an idea and not canon', '井里沉着没寄出去的信']) expect(one.text, part).toContain(part)
    // What a role is told of them.
    const brief = await jottingsBrief(project, 'zh')
    for (const part of ['有 2 条作者的随笔', 'book_read what=jottings', '它们不是定论']) expect(brief, part).toContain(part)

    // One kept back: in no search, in no list, not to be read by name.
    await saveJotting(project, { id: well.id, hidden: true })
    expect((await foundJottings(project)).map(item => item.id)).toEqual([late.id])
    found = await searchBook(bed.runtime, { query: '后院 井 没寄出去的信', sources: ['jotting'] })
    expect(found.text).not.toContain(well.id)
    expect((await readBook(bed.runtime, { what: 'jottings' })).text).not.toContain(well.id)
    await expect(readBook(bed.runtime, { what: 'jottings', ref: well.id })).rejects.toThrow(/no jotting matches/)
    expect(await jottingsBrief(project, 'zh')).toContain('有 1 条作者的随笔')
    // The author still sees every one.
    expect((await jottingsView(project)).items).toHaveLength(2)

    // All kept back: nothing is found, nothing is said of them.
    await setJottingsSearch(project, false)
    expect((await jottingsView(project)).search).toBe(false)
    expect(await foundJottings(project)).toEqual([])
    expect((await searchBook(bed.runtime, { query: '咳嗽', sources: ['jotting'] })).text).toContain('Nothing')
    expect((await readBook(bed.runtime, { what: 'jottings' })).text).toContain('no jottings an agent may read')
    expect(await jottingsBrief(project, 'zh')).toBe('')
    // …and found again, each as it was set.
    await setJottingsSearch(project, true)
    expect((await foundJottings(project)).map(item => item.id)).toEqual([late.id])
  })

  it('the ones that bear on a chapter go along when it is planned or written — as ideas, and only those', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '后院', synopsis: '沈蘅第一次走进断肠斋的后院，柳先生拦着不让她靠近那口井。' })
    const well = await saveJotting(project, { text: '断肠斋的后院也许该有一口井，井里沉着没寄出去的信，柳先生每年清明往里添一封。', kind: 'setting', title: '后院的井' })
    await saveJotting(project, { text: '结尾想用一场大雪，但还没想好是谁的葬礼。', kind: 'plot' })
    const located = (await project.findChapter(chapter.id))!
    const route = await bed.core.route('writer', bed.runtime, {})
    const draft = await bed.core.pack(bed.runtime, route, { purpose: 'draft', chapter: located })
    // The one about the well goes along, said to be an idea; the one about the snow has nothing to do with this chapter.
    for (const part of ['作者的随笔里和这一章沾边的', '不是设定', '〔设定 · 后院的井〕', '每年清明往里添一封']) expect(draft.text, part).toContain(part)
    expect(draft.text).not.toContain('一场大雪')
    expect(draft.included.jottings).toBe(1)
    // Planning takes them too; a review reads the text against canon, and jottings are none.
    expect((await bed.core.pack(bed.runtime, route, { purpose: 'derive', chapter: located })).text).toContain('后院的井')
    const review = await bed.core.pack(bed.runtime, route, { purpose: 'review', chapter: located })
    expect(review.text).not.toContain('作者的随笔')
    expect(review.included.jottings).toBeUndefined()
    // Kept back, it goes nowhere.
    await saveJotting(project, { id: well.id, hidden: true })
    const without = await bed.core.pack(bed.runtime, route, { purpose: 'draft', chapter: located })
    expect(without.text).not.toContain('后院的井')
    expect(without.included.jottings).toBeUndefined()
  })

  it('a role at work as an agent is told the book has them, and how they are read', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '后院', synopsis: '沈蘅第一次走进断肠斋的后院。' })
    await saveJotting(project, { text: '后院也许该有一口井。', kind: 'setting' })
    bed.roles.enabled = true
    const rules: string[] = []
    const tools: string[][] = []
    bed.roles.script = async (agent, call) => {
      rules.push(agent.rules ?? '')
      tools.push(agent.tools.map(tool => tool.name))
      // It reads them with the book's own tool.
      const listed = await call('book_read', { what: 'jottings' })
      expect(listed).toContain('后院也许该有一口井')
      await call('submit_beats', { result: { beats: [{ summary: '她走进后院' }] } })
    }
    await deriveBeats(bed.core, bed.runtime, { chapter: chapter.id }, task)
    for (const part of ['## 作者的随笔', '有 1 条作者的随笔', 'book_read what=jottings', '以设定和正文为准']) expect(rules[0], part).toContain(part)
    expect(tools[0]).toContain('book_read')
    // None to find: nothing is said.
    await setJottingsSearch(project, false)
    bed.roles.script = async (agent, call) => {
      rules.push(agent.rules ?? '')
      await call('submit_beats', { result: { beats: [{ summary: '她走进后院' }] } })
    }
    await deriveBeats(bed.core, bed.runtime, { chapter: chapter.id }, task)
    expect(rules[1]).not.toContain('作者的随笔')
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packContext, windowStart } from '../src/core/context'
import { estimateTokens } from '../src/shared/text'
import { createTestBed, type TestBed } from './support/harness'

describe('the story so far', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('holds the window of text where it is until the chapters no longer fit, then lets go of a stretch at once', () => {
    const each = 100
    const starts: number[] = []
    for (let written = 0; written <= 40; written++) starts.push(windowStart(Array.from({ length: written }, () => each), 1000))
    // Ten chapters fit: all of them travel.
    expect(starts.slice(0, 11).every(start => start === 0)).toBe(true)
    // It never moves back, and it does not move with every chapter: a provider's cache holds between the moves.
    for (let written = 1; written <= 40; written++) expect(starts[written]!).toBeGreaterThanOrEqual(starts[written - 1]!)
    const moves = starts.filter((start, written) => written > 0 && start !== starts[written - 1]).length
    expect(moves).toBeGreaterThan(0)
    expect(moves).toBeLessThanOrEqual(12)
    // What travels is always within the budget, and — once the book outgrew it — most of the budget.
    for (let written = 11; written <= 40; written++) {
      const held = (written - starts[written]!) * each
      expect(held).toBeLessThanOrEqual(1000)
      expect(held).toBeGreaterThanOrEqual(700)
    }
    // A chapter that fits is never dropped for being the newest; one that does not fit at all is not cut to size.
    expect(windowStart([900, 900], 1000)).toBe(1)
    expect(windowStart([400, 5000], 1000)).toBe(2)
    expect(windowStart([], 1000)).toBe(0)
  })

  it('lays the story out so that the next chapter\'s request begins with this one\'s', async () => {
    const { project, index } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强寡言' })
    await project.saveWorld({ name: '青冥山', category: 'location', importance: 1, summary: '北境雪山' })
    const ids: string[] = []
    for (let n = 1; n <= 6; n++) ids.push((await project.addChapter({ title: `第${n}回`, synopsis: `第 ${n} 回的梗概。`, characters: ['沈璃'] })).id)
    const stables: string[] = []
    for (let n = 1; n <= 5; n++) {
      // What is being written now is packed before it is written; then it joins the text.
      const chapter = (await project.findChapter(ids[n - 1]!))!
      const pack = await packContext(project, index, { purpose: 'draft', chapter, textBudget: 100_000, sideBudget: 20_000, tailChars: 200, brief: `第 ${n} 回要写出她的犹豫` })
      stables.push(pack.stable)
      expect(pack.strategy).toBe('full')
      expect(pack.included.fullChapters).toBe(n - 1)
      // The chapter's own outline and the brief are not part of what repeats.
      expect(pack.stable).not.toContain('本章章纲')
      expect(pack.stable).not.toContain('她的犹豫')
      expect(pack.rest).toContain(`第 ${n} 回的梗概`)
      await project.saveChapterText(ids[n - 1]!, `这是第${n}回的正文，沈璃在青冥山下走了很远的路。`.repeat(4))
    }
    // Chapter after chapter the head of the request only grows at its end.
    for (let n = 1; n < stables.length; n++) {
      expect(stables[n]!.startsWith(stables[n - 1]!)).toBe(true)
      expect(stables[n]!.length).toBeGreaterThan(stables[n - 1]!.length)
    }
  })

  it('sends the nearest chapters whole and the ones before them as an outline', async () => {
    const { project, index } = bed.runtime
    const ids: string[] = []
    for (let n = 1; n <= 8; n++) {
      const plan = await project.addChapter({ title: `第${n}回`, synopsis: `第 ${n} 回里发生的事。` })
      ids.push(plan.id)
      if (n <= 7) await project.saveChapterText(plan.id, `第${n}回正文。`.repeat(40))
    }
    // Memory for some of the early chapters; the others are told by what their outline says.
    await project.saveMemory({ schema: 1, chapterId: ids[0]!, textHash: 'x', updatedAt: '', brief: '开端', summary: '第一回：她离开了家。', facts: [], characters: [], newEntities: [], threads: [] })
    const chapter = (await project.findChapter(ids[7]!))!
    const one = estimateTokens(`第7回 第7回\n\n${'第7回正文。'.repeat(40)}`) + 12
    const pack = await packContext(project, index, { purpose: 'draft', chapter, textBudget: Math.floor(one * 3.5), sideBudget: 20_000, tailChars: 200 })
    expect(pack.strategy).toBe('window')
    expect(pack.included.fullChapters).toBeGreaterThanOrEqual(2)
    expect(pack.included.fullChapters).toBeLessThanOrEqual(3)
    expect(pack.window!.to).toBe(7)
    // Whole chapters only: none is cut.
    expect(pack.stable).toContain('第7回正文。'.repeat(40))
    expect(pack.stable).toContain(`前文正文（从第 ${pack.window!.from} 章起，按顺序）`)
    // Before the text: every earlier chapter in a line, digested or not.
    expect(pack.stable).toContain(`前情梗概（第 ${pack.window!.from} 章之前）`)
    expect(pack.stable).toContain('第一回：她离开了家。')
    expect(pack.stable).toContain('第 2 回里发生的事。')
    expect(pack.stable).not.toContain('第1回正文。')
    expect(pack.included.summaries).toBe(pack.window!.from - 1)
  })

  it('gives a chapter that is written again the chapters after it too', async () => {
    const { project, index } = bed.runtime
    const ids: string[] = []
    for (let n = 1; n <= 5; n++) {
      const plan = await project.addChapter({ title: `第${n}回`, synopsis: `第 ${n} 回的梗概。` })
      ids.push(plan.id)
      await project.saveChapterText(plan.id, `第${n}回的原文在这里。`.repeat(6))
    }
    const chapter = (await project.findChapter(ids[1]!))!
    const pack = await packContext(project, index, { purpose: 'draft', chapter, textBudget: 100_000, sideBudget: 20_000, tailChars: 200 })
    expect(pack.included).toMatchObject({ fullChapters: 1, following: 3 })
    // What precedes is part of what repeats; what follows belongs to this rewrite alone.
    expect(pack.stable).toContain('第1回的原文在这里。')
    expect(pack.stable).not.toContain('第3回的原文在这里。')
    expect(pack.rest).toContain('下文正文（本章之后，按顺序）')
    expect(pack.rest).toContain('本章必须接得上它们')
    expect(pack.rest.indexOf('第3回的原文在这里。')).toBeLessThan(pack.rest.indexOf('第5回的原文在这里。'))
    // Its own text is not handed back as something to lead into.
    expect(pack.text).not.toContain('第2回的原文在这里。')
    // With little room, what follows travels nearest first and whole, the rest in outline — and what precedes is not crowded out.
    const one = estimateTokens(`第3回 第3回\n\n${'第3回的原文在这里。'.repeat(6)}`) + 12
    const tight = await packContext(project, index, { purpose: 'revise', chapter, textBudget: Math.floor(one * 2.4), sideBudget: 20_000, tailChars: 200, includeChapterText: true })
    expect(tight.included.fullChapters).toBe(1)
    expect(tight.included.following).toBe(1)
    expect(tight.rest).toContain('第3回的原文在这里。')
    expect(tight.rest).toContain('再往后的章节（梗概）')
    expect(tight.rest).toContain('第 5 回的梗概。')
    expect(tight.rest).not.toContain('第5回的原文在这里。')
    // A review reads what follows in outline only: it has nothing to lead into.
    const review = await packContext(project, index, { purpose: 'review', chapter, textBudget: 100_000, sideBudget: 20_000, tailChars: 200, includeChapterText: true })
    expect(review.included.following).toBe(0)
    expect(review.rest).toContain('下文梗概')
  })

  it('keeps who and what belongs to another line of the plot out of a chapter, and tells where each is seen', async () => {
    const { project, index } = bed.runtime
    const shared = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', personality: '寡言' })
    const one = await project.addChapter({ title: '主线一', synopsis: '沈蘅在码头。' })
    await project.saveChapterText(one.id, '沈蘅在码头。')
    const line = await project.addLine({ title: '城南的铺子' })
    const other = await project.addChapter({ title: '城南一', synopsis: '陆掌柜翻账本。' }, { line: line.id })
    await project.saveChapterText(other.id, '陆掌柜翻开账本。')
    // Somebody and something of that line alone; and somebody the author kept to the main line.
    const theirs = await project.saveCharacter({ name: '陆掌柜', role: 'supporting', personality: '精明', lines: [line.id] })
    await project.saveCharacter({ name: '周衡', role: 'supporting', personality: '体面', lines: ['main'] })
    await project.saveWorld({ name: '城南账房', category: 'location', importance: 1, summary: '陆家的账房。', lines: [line.id] })
    await project.saveWorld({ name: '寄死笔', category: 'item', importance: 1, summary: '写下名字的人七日后死。' })
    const pack = async (id: string) => { const made = await packContext(project, index, { purpose: 'draft', chapter: (await project.findChapter(id))!, textBudget: 50_000, sideBudget: 20_000, tailChars: 200 }); return `${made.stable}\n${made.rest}` }
    const main = await pack(one.id)
    for (const part of ['沈蘅', '周衡', '寄死笔']) expect(main, part).toContain(part)
    for (const part of ['陆掌柜', '城南账房']) expect(main, part).not.toContain(part)
    const south = await pack(other.id)
    for (const part of ['沈蘅', '陆掌柜', '城南账房', '寄死笔']) expect(south, part).toContain(part)
    expect(south).not.toContain('周衡')
    // Where each is seen is read off the digests along each line.
    const memory = (chapterId: string, who: { id: string; name: string }) => ({ schema: 1 as const, chapterId, textHash: 'x', updatedAt: '', brief: '', summary: '', facts: [], newEntities: [], threads: [], characters: [{ character: who.id, name: who.name, role: '在场' }] })
    await project.saveMemory(memory(one.id, shared))
    await project.saveMemory(memory(other.id, theirs))
    const seen = await project.seenOn()
    expect(seen.lines.map(item => item.id)).toEqual(['main', line.id])
    expect([seen.people[shared.id], seen.people[theirs.id]]).toEqual([['main'], [line.id]])
  })

  it('says who is out of the story as of the chapter in hand, on that chapter\'s own line — and nothing of it in what repeats', async () => {
    const { project, index } = bed.runtime
    const lead = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', personality: '寡言' })
    const friend = await project.saveCharacter({ name: '阿棠', role: 'supporting', personality: '爱笑' })
    await project.saveCharacter({ name: '老周', role: 'minor' })
    const ids: string[] = []
    for (let n = 1; n <= 4; n++) ids.push((await project.addChapter({ title: `第${n}回`, synopsis: `第 ${n} 回的梗概。` })).id)
    for (const id of ids.slice(0, 3)) await project.saveChapterText(id, `${id} 的正文，沈蘅在码头。`)
    const memory = (chapterId: string, characters: { name: string; lifecycle?: 'exit' | 'death' }[]) => ({ schema: 1 as const, chapterId, textHash: 'x', updatedAt: new Date().toISOString(), brief: '', summary: `${chapterId} 的摘要`, facts: [], newEntities: [], threads: [], characters: characters.map(item => ({ character: item.name, ...item })) })
    await project.saveMemory(memory(ids[0]!, [{ name: '沈蘅' }, { name: '阿棠' }, { name: '老周' }]))
    await project.saveMemory(memory(ids[1]!, [{ name: '沈蘅' }, { name: '老周', lifecycle: 'exit' }]))
    await project.saveMemory(memory(ids[2]!, [{ name: '沈蘅' }, { name: '阿棠', lifecycle: 'death' }]))
    const pack = async (id: string) => await packContext(project, index, { purpose: 'draft', chapter: (await project.findChapter(id))!, textBudget: 100_000, sideBudget: 20_000, tailChars: 200 })

    // Writing the fourth chapter: she died in the third, he left in the second.
    const fourth = await pack(ids[3]!)
    expect(fourth.rest).toContain('已死亡（可以被提起，不能再以活人身份出场）：阿棠（第3章）')
    expect(fourth.rest).toContain('已离开故事（章纲没有安排，就不要让他们回来）：老周（第2章）')
    // Writing the third again: her death is in the chapter itself — not something that has happened before it.
    const third = await pack(ids[2]!)
    expect(third.rest).toContain('老周（第2章）')
    expect(third.rest).not.toContain('已死亡')
    // Writing the second again: nobody is gone yet.
    expect((await pack(ids[1]!)).rest).not.toContain('已经不在故事里的人')
    // Her card travels whole whatever the chapter, with no word on it for where the book has got to: what repeats, repeats.
    for (const made of [fourth, third]) {
      expect(made.stable).toContain('【阿棠】（配角）')
      expect(made.stable).toContain('爱笑')
      expect(made.stable).not.toContain('已死亡')
    }
    // A line that parts after the first chapter: on it she is alive, and he never left.
    const line = await project.addLine({ title: '她没有上船', from: ids[0]! })
    const side = await project.addChapter({ title: '另一个早晨' }, { line: line.id })
    await project.saveChapterText(side.id, '另一个早晨的正文。')
    await project.saveMemory(memory(side.id, [{ name: '阿棠' }]))
    const next = await project.addChapter({ title: '再往后' }, { line: line.id })
    expect((await pack(next.id)).rest).not.toContain('已经不在故事里的人')
    expect(lead.id).not.toBe(friend.id)
  })
})

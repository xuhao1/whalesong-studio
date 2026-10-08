// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packContext } from '../src/core/context'
import { bookTools } from '../src/core/crew'
import { deriveChapters } from '../src/core/pipelines/plot'
import { listReviews } from '../src/core/pipelines/review'
import { fixIssues } from '../src/core/pipelines/revise'
import { readBook, searchBook } from '../src/core/reading'
import { MAIN_LINE, ofLine, type ThreadTouch } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

/**
 * One world, three stories: the main line (two chapters), a line that parts after its first chapter, and a line of its
 * own from the first page. Each has people and threads of its own.
 */
async function world(bed: TestBed) {
  const { project } = bed.runtime
  const memory = (chapterId: string, who: { id: string; name: string }[], threads: ThreadTouch[] = []) => ({ schema: 1 as const, chapterId, textHash: 'x', updatedAt: '', brief: '', summary: `${who.map(card => card.name).join('、')}在场。`, facts: [], newEntities: [], threads, characters: who.map(card => ({ character: card.id, name: card.name, role: '在场' })) })
  const heng = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', personality: '寡言' })
  const zhou = await project.saveCharacter({ name: '周衡', role: 'supporting', personality: '体面' })
  const lu = await project.saveCharacter({ name: '陆掌柜', role: 'protagonist', personality: '精明' })
  // On nobody's page yet: a card the author made ahead.
  const tang = await project.saveCharacter({ name: '阿棠', role: 'supporting', personality: '跳脱' })
  await project.saveWorld({ name: '寄死笔', category: 'item', importance: 1, summary: '写下名字的人七日后死。' })
  await project.updateManifest({ logline: '沈蘅要在七日内查清那支笔。', premise: '代笔人沈蘅写出的信会让收信人死去。' })
  const letter = await project.saveThread({ title: '没寄出的信', kind: 'foreshadow', status: 'open' })
  const ledger = await project.saveThread({ title: '缺页的账本', kind: 'mystery', status: 'open' })
  const ahead = await project.saveThread({ title: '还没动的伏笔', kind: 'foreshadow', status: 'open' })

  const m1 = await project.addChapter({ title: '码头', synopsis: '沈蘅在码头等船。' })
  const m2 = await project.addChapter({ title: '报馆', synopsis: '周衡把信登了报。' })
  await project.saveChapterText(m1.id, '沈蘅在码头等船，信还在袖子里。')
  await project.saveChapterText(m2.id, '周衡在报馆把那封信登了出来。')
  await project.saveMemory(memory(m1.id, [heng], [{ title: '没寄出的信', action: 'plant', threadId: letter.id }]))
  await project.saveMemory(memory(m2.id, [zhou], [{ title: '没寄出的信', action: 'payoff', threadId: letter.id }]))
  await project.saveThread({ id: letter.id, status: 'paid' })

  // She does not board: the story parts after the first chapter.
  const stay = await project.addLine({ title: '她没有上船', from: m1.id })
  const s1 = await project.addChapter({ title: '回头', synopsis: '她从码头折回去。' }, { line: stay.id })
  await project.saveChapterText(s1.id, '沈蘅从码头折了回去。')
  await project.saveMemory(memory(s1.id, [heng]))

  // Another story in the same world, from its own first page.
  const south = await project.addLine({ title: '城南的铺子', premise: '城南另一间代笔铺的账。' })
  const c1 = await project.addChapter({ title: '开张', synopsis: '陆掌柜翻开账本。' }, { line: south.id })
  const c2 = await project.addChapter({ title: '盘账', synopsis: '账本少了一页。' }, { line: south.id })
  await project.saveChapterText(c1.id, '陆掌柜翻开账本，铺子开张了。')
  await project.saveMemory(memory(c1.id, [lu], [{ title: '缺页的账本', action: 'plant', threadId: ledger.id }]))
  return { heng, zhou, lu, tang, letter, ledger, ahead, m1, m2, stay, s1, south, c1, c2 }
}

describe('a line of the plot reads itself', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('has its own chapters, people and threads — and the world, which the lines share', async () => {
    const { project } = bed.runtime
    const book = await world(bed)
    const names = async (line?: string): Promise<string[]> => {
      const scope = await project.lineScope(line)
      return (await project.characters()).filter(card => scope.has(card)).map(card => card.name).sort()
    }
    // Unsaid, somebody belongs where the chapters have them; a card no chapter has yet is every line's.
    expect(await names()).toEqual(['周衡', '沈蘅', '阿棠'].sort())
    expect(await names(book.south.id)).toEqual(['阿棠', '陆掌柜'].sort())
    // A line that parts shares what came before: she is on it, he — who comes on after — is not.
    expect(await names(book.stay.id)).toEqual(['沈蘅', '阿棠'].sort())
    // What the author says holds over where they are seen.
    await project.saveCharacter({ id: book.zhou.id, lines: [MAIN_LINE, book.south.id] })
    expect(await names(book.south.id)).toContain('周衡')
    await project.saveCharacter({ id: book.zhou.id, lines: [] })
    expect(await names(book.south.id)).not.toContain('周衡')
    // Cast by the plan of a chapter not yet written, somebody is that line's already.
    const planned = await project.addChapter({ title: '第三天', characters: [book.tang.id] })
    await project.saveMemory({ schema: 1, chapterId: book.c1.id, textHash: 'x', updatedAt: '', brief: '', summary: '', facts: [], newEntities: [], threads: [], characters: [{ character: book.lu.id, name: '陆掌柜' }, { character: book.tang.id, name: '阿棠' }] })
    expect(await names()).toContain('阿棠')
    expect(await names(book.south.id)).toContain('阿棠')
    await project.removeChapter(planned.id)
    expect(await names()).not.toContain('阿棠')
    await project.saveMemory({ schema: 1, chapterId: book.c1.id, textHash: 'x', updatedAt: '', brief: '', summary: '陆掌柜在场。', facts: [], newEntities: [], threads: [{ title: '缺页的账本', action: 'plant', threadId: book.ledger.id }], characters: [{ character: book.lu.id, name: '陆掌柜' }] })
    expect(ofLine({}, 'x', undefined) && ofLine({}, 'x', []) && ofLine({}, 'x', ['x']) && !ofLine({}, 'x', ['y']) && ofLine({ lines: ['x'] }, 'x', ['y']) && !ofLine({ lines: ['y'] }, 'x', ['x'])).toBe(true)

    // Threads: a line's own, as they stand at its end. Paid off on the main line after the story parted, the letter
    // still waits on the line that parted; the other story never had it. What nothing has touched is anybody's.
    const threads = async (line?: string): Promise<[string, boolean][]> => (await project.lineScope(line)).threads.map(entry => [entry.thread.title, entry.open])
    expect(await threads()).toEqual([['没寄出的信', false], ['还没动的伏笔', true]])
    expect(await threads(book.stay.id)).toEqual([['没寄出的信', true], ['还没动的伏笔', true]])
    expect(await threads(book.south.id)).toEqual([['缺页的账本', true], ['还没动的伏笔', true]])
    // A thread that only says itself where it was planted — no digest names it any more — is still that chapter's line's.
    const old = await project.saveThread({ title: '阿妹的旧名', kind: 'mystery', status: 'open', planted: [book.m2.id] })
    expect((await threads()).map(entry => entry[0])).toContain('阿妹的旧名')
    expect((await threads(book.south.id)).map(entry => entry[0])).not.toContain('阿妹的旧名')
    expect((await threads(book.stay.id)).map(entry => entry[0])).not.toContain('阿妹的旧名')
    await project.deleteThread(old.id)

    // Each line counts its own chapters.
    const numbered = async (line?: string): Promise<string[]> => (await project.lineScope(line)).path.map(chapter => `${chapter.index}.${chapter.plan.title}`)
    expect(await numbered()).toEqual(['1.码头', '2.报馆'])
    expect(await numbered(book.stay.id)).toEqual(['1.码头', '2.回头'])
    expect(await numbered(book.south.id)).toEqual(['1.开张', '2.盘账'])
  })

  it('gives whoever writes on a line that line, and nobody of another unless they are named', async () => {
    const { project, index } = bed.runtime
    const book = await world(bed)
    const pack = async (chapter: string, brief?: string) => {
      const made = await packContext(project, index, { purpose: 'draft', chapter: (await project.findChapter(chapter))!, textBudget: 50_000, sideBudget: 20_000, tailChars: 200, ...(brief !== undefined ? { brief } : {}) })
      return `${made.stable}\n${made.rest}`
    }
    const south = await pack(book.c2.id)
    for (const part of ['陆掌柜', '阿棠', '寄死笔', '缺页的账本', '还没动的伏笔', '铺子开张了']) expect(south, part).toContain(part)
    for (const part of ['沈蘅', '周衡', '没寄出的信', '码头', '报馆']) expect(south, part).not.toContain(part)
    // What the book says its story is, is the main line's: a story of its own is told by what the author said of it.
    expect(south).toContain('这条故事线：城南的铺子')
    expect(south).toContain('这条线讲的是：城南另一间代笔铺的账。')
    expect(south).not.toContain('查清那支笔')
    // Named by whoever gives the task, somebody of another line comes in — and only they.
    const asked = await pack(book.c2.id, '这一章让周衡来铺子里对账。')
    expect(asked).toContain('体面')
    expect(asked).not.toContain('沈蘅')
    // The main line knows nothing of the shop; the line that parted knows the dock and not the newspaper.
    const main = await pack(book.m2.id)
    for (const part of ['陆掌柜', '缺页的账本', '开张']) expect(main, part).not.toContain(part)
    const stay = await pack(book.s1.id)
    // A line that parts from the main one is the same story up to there: the book's premise is its own.
    expect(stay).toContain('代笔人沈蘅写出的信会让收信人死去')
    expect(stay).toContain('信还在袖子里')
    for (const part of ['周衡', '陆掌柜', '报馆']) expect(stay, part).not.toContain(part)
  })

  it('reads and searches for a role along the line its work is on, numbered along it', async () => {
    const { project } = bed.runtime
    const book = await world(bed)
    const kept = { line: book.south.id }
    const read = async (what: Parameters<typeof readBook>[1]['what'], ref?: string) => (await readBook(bed.runtime, { what, ref }, { read: 'book_read' }, kept)).text
    // The outline is this line's, counted along it; the other lines are said to be there, and no more.
    const outline = await read('outline')
    for (const part of ['剧情线「城南的铺子」', '1. 开张', '2. 盘账', '这本书还有 2 条别的剧情线']) expect(outline, part).toContain(part)
    for (const part of ['码头', '报馆', '回头', '她没有上船']) expect(outline, part).not.toContain(part)
    // "Chapter 1" is this line's first chapter, not the main line's.
    expect(await read('chapter', '1')).toContain('铺子开张了')
    expect(await read('memory', '第1章')).toContain('陆掌柜')
    // A chapter of another line is not this work's to read, by number, by title or by id.
    await expect(read('chapter', book.m1.id)).rejects.toThrow(/another line of the plot/)
    await expect(read('chapter', '码头')).rejects.toThrow(/no chapter matches/)
    // Who there is, and what waits: this line's.
    const cast = await read('character')
    expect(cast).toContain('陆掌柜')
    expect(cast).toContain('阿棠')
    expect(cast).not.toContain('沈蘅')
    const threads = await read('threads')
    expect(threads).toContain('缺页的账本')
    expect(threads).not.toContain('没寄出的信')
    // A card asked for by name is given — with a life read along this line only.
    expect(await read('character', '沈蘅')).not.toContain('第 1 章登场')
    // Searching finds nothing of the other lines; the world is found from anywhere.
    const search = async (query: string, scope?: { line: string }) => (await searchBook(bed.runtime, { query }, undefined, scope)).text
    expect(await search('码头 等船', kept)).not.toContain('信还在袖子里')
    expect(await search('账本 开张', kept)).toContain('铺子开张了')
    expect(await search('写下名字的人', kept)).toContain('寄死笔')
    expect(await search('码头 等船')).toContain('信还在袖子里')

    // The tools a role is given for work on that line are these very ones.
    const tools = bookTools(bed.runtime, undefined, book.south.id)
    expect(tools[0]!.description).toContain('one line of the plot')
    expect(Object.keys(tools[0]!.parameters)).not.toContain('line')
    expect(await tools[0]!.run({ what: 'chapter', ref: '1' })).toContain('铺子开张了')
    await expect(tools[0]!.run({ what: 'chapter', ref: book.m2.id })).rejects.toThrow(/another line/)
    expect(await tools[1]!.run({ query: '报馆 登了出来' })).not.toContain('周衡在报馆')

    // Kept to no line — the showrunner, or work on the whole book — every line is listed, each counted along itself,
    // and a line may be named to count along.
    const whole = (await readBook(bed.runtime, { what: 'outline' })).text
    for (const part of ['1. 码头', '2. 报馆', '剧情线「她没有上船」', '在第 1 章《码头》之后分出', '2. 回头', '剧情线「城南的铺子」', '从故事开头就是独立的一条线', '1. 开张']) expect(whole, part).toContain(part)
    expect((await readBook(bed.runtime, { what: 'chapter', ref: '1' })).text).toContain('信还在袖子里')
    expect((await readBook(bed.runtime, { what: 'chapter', ref: '1', line: '城南的铺子' })).text).toContain('铺子开张了')
    expect((await readBook(bed.runtime, { what: 'chapter', ref: '2', line: book.stay.id })).text).toContain('折了回去')
    await expect(readBook(bed.runtime, { what: 'outline', line: '没有这条线' })).rejects.toThrow(/no line of the plot/)
    const open = bookTools(bed.runtime)
    expect(Object.keys(open[0]!.parameters)).toContain('line')
    expect(await project.lineOf(book.c1.id)).toBe(book.south.id)
  })

  it('plans a line from that line alone, and adds what is derived to it', async () => {
    const { project } = bed.runtime
    const book = await world(bed)
    bed.roles.enabled = true
    let seen = ''
    bed.roles.script = async (task, call) => {
      // What the planner finds when it looks for itself: the line it plans for.
      seen = `${await call('book_read', { what: 'outline' })}\n${await call('book_read', { what: 'character' })}\n${await call('book_search', { query: '码头 报馆 信' })}`
      await call('submit_chapters', { result: { chapters: [{ title: '查账', synopsis: '陆掌柜去找缺的那一页。', characters: ['陆掌柜'] }], rationale: '顺着账本往下。' } })
      return ''
    }
    const result = await deriveChapters(bed.core, bed.runtime, { count: 1, line: book.south.id }, { origin: 'user' })
    expect(result.line).toMatchObject({ id: book.south.id, created: false })
    // The new chapter is the line's third — not the main line's.
    expect(result.added).toMatchObject([{ title: '查账', index: 3 }])
    expect((await project.chapters()).map(chapter => chapter.plan.title)).toEqual(['码头', '报馆'])
    expect((await project.chapters(book.south.id)).map(chapter => chapter.plan.title)).toEqual(['开张', '盘账', '查账'])
    // What it was handed, and what it could read: this line's — nothing of the main line or of the line that parted from it.
    const task = bed.roles.tasks.at(-1)!.prompt
    for (const part of ['剧情线「城南的铺子」', '〔本线〕开张', '陆掌柜', '缺页的账本']) expect(task, part).toContain(part)
    for (const part of ['码头', '报馆', '沈蘅', '周衡', '没寄出的信', '她没有上船', '故事的其它走法']) expect(task, part).not.toContain(part)
    for (const part of ['1. 开张', '陆掌柜']) expect(seen, part).toContain(part)
    // (The search says back what was asked for; nothing it found is of another line.)
    expect(seen).toContain('Nothing on the line "城南的铺子" matches')
    for (const part of ['1. 码头', '2. 报馆', '沈蘅', '周衡', '信还在袖子里', '登了出来']) expect(seen, part).not.toContain(part)
  })

  it('mends what a review found line by line, each chapter under its own number', async () => {
    const { project } = bed.runtime
    const book = await world(bed)
    await project.saveReview({ chapterId: book.m1.id, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'a', severity: 'high', type: 'logic', quote: '信还在袖子里', explanation: '前面没交代信从哪来。' }] })
    await project.saveReview({ chapterId: book.c1.id, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'b', severity: 'high', type: 'logic', quote: '铺子开张了', explanation: '开张得太突然。' }] })
    // Listed in reading order, each with the number it has on its own line.
    expect((await listReviews(bed.runtime)).map(review => [review.index, review.title])).toEqual([[1, '码头'], [1, '开张']])
    bed.llm.responder = (request) => {
      if (request.prompt.includes('责任编辑')) return JSON.stringify({ chapters: [{ index: 1, reason: '补一句交代' }] })
      return request.prompt.includes('开张得太突然') ? '陆掌柜筹备了三个月，翻开账本，铺子开张了。' : '沈蘅在码头等船，昨夜写好的信还在袖子里。'
    }
    const result = await fixIssues(bed.core, bed.runtime, { atLeast: 'high' }, { origin: 'user' })
    // Both were handed over — the one on the other line was not dropped — as two pieces of work, one a line.
    expect(result).toMatchObject({ issues: 2, chapters: 2 })
    const scopes = bed.llm.requests.filter(request => request.prompt.includes('责任编辑')).map(request => request.prompt)
    expect(scopes).toHaveLength(2)
    const mainScope = scopes.find(prompt => prompt.includes('前面没交代信从哪来'))!
    const southScope = scopes.find(prompt => prompt.includes('开张得太突然'))!
    // Each planner reads the chapters of its own line, and nothing of the other's.
    expect(mainScope).toContain('1. 码头')
    expect(mainScope).not.toContain('开张')
    expect(southScope).toContain('1. 开张')
    expect(southScope).not.toContain('码头')
    const proposals = (await project.proposals()).filter(item => item.status === 'pending')
    expect(proposals.map(item => item.chapterId).sort()).toEqual([book.m1.id, book.c1.id].sort())
    expect((await project.review(book.c1.id))!.issues[0]!.mending).toBeDefined()
  })
})

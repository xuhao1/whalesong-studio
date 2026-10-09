// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packContext } from '../src/core/context'
import { bookTools } from '../src/core/crew'
import { acceptSuggestion } from '../src/core/pipelines/bible'
import { digestChapter } from '../src/core/pipelines/digest'
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

  it('keeps the world shared until it is filed: by a line\'s own digest, by the author in a batch, or by the text', async () => {
    const { project, index } = bed.runtime
    const book = await world(bed)
    const pier = await project.saveWorld({ name: '码头', category: 'location', importance: 1, summary: '等船的地方' })
    const press = await project.saveWorld({ name: '报馆', category: 'location', importance: 2, summary: '登报的地方' })
    const shop = await project.saveWorld({ name: '铺子', category: 'location', importance: 1, summary: '城南的代笔铺' })
    const ledger = await project.saveWorld({ name: '账本', category: 'item', importance: 2, summary: '少了一页' })
    const rule = await project.saveWorld({ name: '七日之期', category: 'rule', importance: 2, summary: '写下名字七日后' })
    const knows = async (line?: string): Promise<string[]> => {
      const scope = await project.lineScope(line)
      return (await project.world()).filter(entry => scope.knows(entry)).map(entry => entry.name).sort()
    }
    const all = ['七日之期', '寄死笔', '报馆', '码头', '账本', '铺子'].sort()
    // Nobody filed anything: the world is every line's, whatever each line's text happens to spell out — an entry the
    // whole book stands on may be named on one line only.
    for (const line of [undefined, book.stay.id, book.south.id]) expect(await knows(line)).toEqual(all)
    // Where the text names each is known all the same: said beside an entry, and what "by the text" goes by.
    const named = async (): Promise<Record<string, string[]>> => (await project.seenOn()).world
    expect((await named())[pier.id]).toEqual([MAIN_LINE, book.stay.id])
    expect((await named())[press.id]).toEqual([MAIN_LINE])
    expect((await named())[shop.id]).toEqual([book.south.id])
    expect((await named())[rule.id]).toBeUndefined()

    // A digest of the other story finds a place: the suggestion says whose it is, and taken up it is filed there.
    await project.saveChapterText(book.c2.id, '陆掌柜盘了一夜的账，后堂暗格里少了一页。')
    bed.llm.responder = () => JSON.stringify({ brief: '盘账', summary: '陆掌柜盘账。', characters: [{ name: '陆掌柜', role: '盘账' }], facts: [], threads: [], newEntities: [{ name: '后堂暗格', kind: 'location', description: '柜台后面的暗格' }] })
    await digestChapter(bed.core, bed.runtime, book.c2.id, { origin: 'user' })
    const found = (await project.suggestions()).find(item => item.kind === 'new-world')!
    expect(found.payload).toMatchObject({ name: '后堂暗格', lines: [book.south.id] })
    expect(found.detail).toBe('柜台后面的暗格（发现于“城南的铺子”，采纳后归到这条线）')
    await acceptSuggestion(bed.runtime, found.id)
    expect((await project.findWorld('后堂暗格'))!.lines).toEqual([book.south.id])
    expect(await knows()).not.toContain('后堂暗格')
    expect(await knows(book.stay.id)).not.toContain('后堂暗格')
    expect(await knows(book.south.id)).toContain('后堂暗格')
    // Found on the main line, a place stays the world's: the lines share it.
    bed.llm.responder = () => JSON.stringify({ brief: '登报', summary: '周衡登报。', characters: [{ name: '周衡', role: '登报' }], facts: [], threads: [], newEntities: [{ name: '排字房', kind: 'location', description: '报馆后面的排字房' }] })
    await digestChapter(bed.core, bed.runtime, book.m2.id, { origin: 'user' }, { force: true })
    const shared = (await project.suggestions()).find(item => item.kind === 'new-world')!
    expect(shared.payload).toMatchObject({ name: '排字房' })
    expect(shared.payload.lines).toBeUndefined()
    expect(shared.detail).toBe('报馆后面的排字房')

    // The digest says whose each new thing is as it reads the chapter: it is told which story the chapter is of, and
    // answers `scope` — this story's alone, or the world's.
    const asked = (): string => bed.llm.requests.at(-1)!.prompt
    const suggested = async (name: string) => (await project.suggestions()).find(item => item.kind === 'new-world' && item.payload.name === name)!
    const notes = (entities: { name: string; kind: string; description: string; scope?: string }[]) => () => JSON.stringify({ brief: '一章', summary: '一章。', characters: [], facts: [], threads: [], newEntities: entities })
    bed.llm.responder = notes([{ name: '描金算盘', kind: 'item', description: '陆掌柜的算盘', scope: 'line' }, { name: '城南', kind: 'location', description: '城的南半边', scope: 'world' }])
    await digestChapter(bed.core, bed.runtime, book.c2.id, { origin: 'user' }, { force: true })
    expect(asked()).toContain('## 故事线')
    expect(asked()).toContain('这一章在「城南的铺子」这条线上')
    expect(asked()).toContain('"scope": "line|world')
    expect((await suggested('描金算盘')).payload.lines).toEqual([book.south.id])
    expect((await suggested('描金算盘')).detail).toBe('陆掌柜的算盘（场记：只属于“城南的铺子”，采纳后归到这条线）')
    // The world's, though a story beside the main one is where it was met: filed under none.
    expect((await suggested('城南')).payload.lines).toBeUndefined()
    expect((await suggested('城南')).detail).toBe('城的南半边（场记：几条线共用的）')
    expect((await project.memory(book.c2.id))!.newEntities.map(entity => entity.scope)).toEqual(['line', 'world'])
    // On the main line the same: a thing of the main story alone is filed under it — and under a line that parts later,
    // which reads the chapter too.
    bed.llm.responder = notes([{ name: '铅字盘', kind: 'item', description: '排字房的铅字盘', scope: 'line' }, { name: '租界', kind: 'location', description: '报馆所在的租界', scope: 'world' }])
    await digestChapter(bed.core, bed.runtime, book.m2.id, { origin: 'user' }, { force: true })
    expect(asked()).toContain('这一章在「主线」这条线上')
    expect((await suggested('铅字盘')).payload.lines).toEqual([MAIN_LINE])
    expect((await suggested('租界')).payload.lines).toBeUndefined()
    bed.llm.responder = notes([{ name: '旧船票', kind: 'item', description: '她袖子里的船票', scope: 'line' }])
    await digestChapter(bed.core, bed.runtime, book.m1.id, { origin: 'user' }, { force: true })
    expect((await suggested('旧船票')).payload.lines).toEqual([MAIN_LINE, book.stay.id])
    expect((await suggested('旧船票')).detail).toBe('她袖子里的船票（场记：只属于“主线”、“她没有上船”，采纳后归到这几条线）')
    expect(await project.linesReading(book.m1.id)).toEqual({ lines: [MAIN_LINE, book.stay.id], every: false })
    expect(await project.linesReading(book.c1.id)).toEqual({ lines: [book.south.id], every: false })

    // A batch, filed at once under the lines the author names: those and no other.
    const filed = await project.assignLines({ lines: [MAIN_LINE, book.south.id], world: [press.id, '账本'], characters: [book.zhou.id, '阿棠'] })
    expect(filed).toEqual({ characters: ['周衡', '阿棠'], world: ['报馆', '账本'], lines: [MAIN_LINE, book.south.id] })
    expect(await knows(book.stay.id)).not.toContain('账本')
    expect(await knows(book.south.id)).toContain('报馆')
    const stay = await project.lineScope(book.stay.id)
    expect((await project.characters()).filter(card => stay.has(card)).map(card => card.name)).not.toContain('阿棠')
    // Filed under none again: the world's again.
    await project.assignLines({ lines: [], world: [press.id, ledger.id], characters: [book.zhou.id, book.tang.id] })
    expect(await knows(book.stay.id)).toContain('账本')

    // By the text: each under the lines it is found on — what every line has, or none yet, is left as it was.
    const byText = await project.assignLines({ byText: true, world: [press.id, shop.id, pier.id, rule.id, '寄死笔'], characters: [book.lu.id, book.heng.id, book.tang.id] })
    expect(byText.world).toEqual(['报馆', '铺子', '码头'])
    expect(byText.characters).toEqual(['陆掌柜', '沈蘅'])
    expect(byText.left).toEqual(['陆掌柜', '沈蘅', '阿棠', '报馆', '铺子', '码头', '七日之期', '寄死笔'].filter(name => !['陆掌柜', '沈蘅', '报馆', '铺子', '码头'].includes(name)))
    expect((await project.findWorld(press.id))!.lines).toEqual([MAIN_LINE])
    expect((await project.findWorld(shop.id))!.lines).toEqual([book.south.id])
    expect((await project.findWorld(pier.id))!.lines).toEqual([MAIN_LINE, book.stay.id])
    expect((await project.findWorld(rule.id))!.lines ?? []).toEqual([])
    expect((await project.findCharacter(book.lu.id))!.lines).toEqual([book.south.id])
    // Now whoever writes the main line is not handed the other story's shop — core canon though it is — and has the dock.
    const pack = async (chapter: string): Promise<string> => {
      const made = await packContext(project, index, { purpose: 'draft', chapter: (await project.findChapter(chapter))!, textBudget: 50_000, sideBudget: 20_000, tailChars: 200 })
      return `${made.stable}\n${made.rest}`
    }
    const main = await pack(book.m2.id)
    expect(main).toContain('等船的地方')
    expect(main).not.toContain('城南的代笔铺')
    const south = await pack(book.c2.id)
    expect(south).toContain('城南的代笔铺')
    expect(south).not.toContain('等船的地方')

    // A line the book does not have is refused; a name nobody answers to is passed over.
    await expect(project.assignLines({ lines: ['no-such-line'], world: [press.id] })).rejects.toMatchObject({ code: 'novel/not-found' })
    expect(await project.assignLines({ lines: [MAIN_LINE], world: ['没有这一条'] })).toMatchObject({ world: [], characters: [] })
    // Along a line of its own, the chapters that name an entry are that line's.
    const along = await project.worldPresence(book.south.id)
    expect(along.presence.find(item => item.entry === shop.id)?.chapters).toEqual([book.c1.id])
    expect(along.written).toBe(2)
  })

  it('asks nothing about lines of a book that has one, and files a thing every line reads under none', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '码头', synopsis: '等船。' })
    await project.saveChapterText(one.id, '沈蘅在码头等船。')
    bed.llm.responder = () => JSON.stringify({ brief: '等船', summary: '等船。', characters: [], facts: [], threads: [], newEntities: [{ name: '渡口茶摊', kind: 'location', description: '码头边的茶摊', scope: 'line' }] })
    await digestChapter(bed.core, bed.runtime, one.id, { origin: 'user' })
    const single = bed.llm.requests.at(-1)!.prompt
    expect(single).not.toContain('故事线')
    expect(single).not.toContain('scope')
    const alone = (await project.suggestions()).find(item => item.kind === 'new-world')!
    expect(alone.payload.lines).toBeUndefined()
    expect(alone.detail).toBe('码头边的茶摊')

    // A second story parts after that chapter: both lines read it, so what is found in it is everybody's whatever the digest calls it.
    const other = await project.addLine({ title: '她没有上船', from: one.id })
    const next = await project.addChapter({ title: '回头', synopsis: '折回去。' }, { line: other.id })
    await project.saveChapterText(next.id, '她折了回去。')
    bed.llm.responder = () => JSON.stringify({ brief: '等船', summary: '等船。', characters: [], facts: [], threads: [], newEntities: [{ name: '缆桩', kind: 'item', description: '系船的缆桩', scope: 'line' }] })
    await digestChapter(bed.core, bed.runtime, one.id, { origin: 'user' }, { force: true })
    expect(bed.llm.requests.at(-1)!.prompt).toContain('这一章在「主线」这条线上')
    const shared = (await project.suggestions()).find(item => item.payload.name === '缆桩')!
    expect(shared.payload.lines).toBeUndefined()
    expect(shared.detail).toBe('系船的缆桩')
    expect(await project.linesReading(one.id)).toEqual({ lines: [MAIN_LINE, other.id], every: true })
  })

  it('keeps the namesakes of different stories apart: a narrator\'s 我, and a name the digest is asked about', async () => {
    const { project } = bed.runtime
    const book = await world(bed)
    const { listWalkOns, settleWalkOn } = await import('../src/core/walkons')
    const task = { origin: 'user' as const }
    const notes = (characters: { name: string; role: string }[], extra: Record<string, unknown> = {}) => () => JSON.stringify({ brief: '一章', summary: '一章。', characters, facts: [], threads: [], newEntities: [], ...extra })
    const first = async (chapter: string) => (await project.memory(chapter))!.characters[0]!
    const onFile = (): string[] => /## 已建档人物[^\n]*\n([\s\S]*?)\n\n## /.exec(bed.llm.requests.at(-1)!.prompt)![1]!.split('\n')
    // The main story is told by 我, who has a card.
    const me = await project.saveCharacter({ name: '我', role: 'protagonist', personality: '寡言', firstAppearance: book.m1.id })
    bed.llm.responder = notes([{ name: '我', role: '登报' }])
    await digestChapter(bed.core, bed.runtime, book.m2.id, task, { force: true })
    expect(await first(book.m2.id)).toMatchObject({ character: me.id, name: '我' })
    // A line that parts from the main one tells its story on: the same 我.
    await project.saveChapterText(book.s1.id, '我从码头折了回去。')
    bed.llm.responder = notes([{ name: '我', role: '折回' }])
    await digestChapter(bed.core, bed.runtime, book.s1.id, task, { force: true })
    expect((await first(book.s1.id)).character).toBe(me.id)
    expect(onFile()).toContain('我')
    // A story of its own from the first page: its 我 is somebody else. The main story's is not on file for it, and the
    // narrator is kept under a name that says whose story it is.
    await project.saveChapterText(book.c2.id, '我盘了一夜的账。沈蘅来过铺子。')
    bed.llm.responder = notes([{ name: '我', role: '盘账' }])
    await digestChapter(bed.core, bed.runtime, book.c2.id, task, { force: true })
    expect(onFile()).toContain('陆掌柜')
    expect(onFile()).toContain('阿棠')
    expect(onFile()).not.toContain('我')
    expect(onFile()).not.toContain('沈蘅')
    expect(await first(book.c2.id)).toMatchObject({ character: '我（城南的铺子）', name: '我（城南的铺子）' })
    expect((await project.seenOn()).people[me.id]).toEqual([MAIN_LINE, book.stay.id])
    // They are a walk-on of that story, and given a card it is a card of their own.
    const walk = (await listWalkOns(project)).find(entry => entry.name === '我（城南的铺子）')!
    expect(walk).toMatchObject({ story: book.south.id, chapters: [book.c2.id] })
    const made = (await settleWalkOn(project, { name: walk.name, story: walk.story!, action: 'card' })).card!
    expect(made.id).not.toBe(me.id)
    expect((await project.characters()).filter(card => card.name.startsWith('我')).map(card => card.name).sort()).toEqual(['我', '我（城南的铺子）'])
    // The next digest of that story finds its own narrator on file, and the main story still finds its own.
    bed.llm.responder = notes([{ name: '我', role: '又盘了一夜' }])
    await digestChapter(bed.core, bed.runtime, book.c2.id, task, { force: true })
    expect((await first(book.c2.id)).character).toBe(made.id)
    expect(onFile()).toContain('我（城南的铺子）')
    await digestChapter(bed.core, bed.runtime, book.m2.id, task, { force: true })
    expect((await first(book.m2.id)).character).toBe(me.id)
    expect((await project.seenOn()).people[made.id]).toEqual([book.south.id])

    // A card asked for under a name somebody of another story bears — a suggestion made for whoever first appears in
    // this story's chapter — is a card of their own, under the name with the story after it.
    const other = await project.saveCharacter({ name: '陆掌柜', role: 'minor', tagline: '码头上另一位姓陆的掌柜', firstAppearance: book.m1.id })
    expect(other.id).not.toBe(book.lu.id)
    expect(other.name).toBe('陆掌柜（主线）')
    expect((await project.findCharacter(book.lu.id))!.tagline).toBeUndefined()

    // A proper name: 沈蘅 is on file in the main story, and this story's text spells her name. The digest is asked
    // whether it is she, come over, or somebody else of the name.
    bed.llm.responder = notes([{ name: '沈蘅', role: '来过铺子' }], { namesakes: [{ name: '沈蘅', same: false, why: '是铺子里的学徒' }] })
    await digestChapter(bed.core, bed.runtime, book.c2.id, task, { force: true })
    const asked = bed.llm.requests.at(-1)!.prompt
    expect(asked).toContain('## 别的故事线上同名的人')
    expect(asked).toMatch(/- 沈蘅｜主线/)
    expect(asked).toContain('"namesakes"')
    expect(await first(book.c2.id)).toMatchObject({ character: '沈蘅（城南的铺子）', name: '沈蘅（城南的铺子）' })
    expect((await project.seenOn()).people[book.heng.id]).not.toContain(book.south.id)
    // The same person: she is noted under her card, and is of this story too from here on — and nobody is asked again.
    bed.llm.responder = notes([{ name: '沈蘅', role: '来过铺子' }], { namesakes: [{ name: '沈蘅', same: true, why: '就是那位代笔人' }] })
    await digestChapter(bed.core, bed.runtime, book.c2.id, task, { force: true })
    expect((await first(book.c2.id)).character).toBe(book.heng.id)
    expect((await project.seenOn()).people[book.heng.id]).toContain(book.south.id)
    bed.llm.responder = notes([{ name: '沈蘅', role: '又来' }])
    await digestChapter(bed.core, bed.runtime, book.c2.id, task, { force: true })
    expect(bed.llm.requests.at(-1)!.prompt).not.toContain('别的故事线上同名的人')
    expect(onFile()).toContain('沈蘅')
    // Asked each time this story's text spelt her name while she was not of it — four digests of that chapter — and never since.
    expect(bed.llm.requests.filter(request => request.prompt.includes('别的故事线上同名的人'))).toHaveLength(4)
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

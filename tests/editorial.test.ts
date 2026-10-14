// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What an editorial pass is handed, and what keeps its work from piling up.
 *
 * Four layers, the steadiest first — the book's base, the story so far in outline, the chapter in hand, this piece of
 * work — so that the head of one request is the head of the next. What a review says the chapter is at odds with is
 * quoted, and looked for where it is said to stand. And what is on file — the issues open, the changes that wait,
 * the changes turned down — is said to whoever works on a chapter, with one rule under it: one place, one change
 * that waits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bookTools, assign } from '../src/core/crew'
import { bookBase, chapterInHand, checkEvidence, storyLedger } from '../src/core/pipelines/editorial'
import { onFile, proposeSpan } from '../src/core/pipelines/onfile'
import { reviewChapter } from '../src/core/pipelines/review'
import { acceptProposal, closeIssues, rejectProposal, reviewByLead } from '../src/core/pipelines/revise'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const ONE = '她生来是左撇子，从小如此。\n\n那年她十二岁。'
const TWO = '她右手握着剑下了山。\n\n那是盛夏。'
const THREE = '渡口没有人。\n\n她等了一夜。'
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('what an editorial pass is handed', () => {
  let bed: TestBed
  let ids: { one: string; two: string; three: string }
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '七日未寄', settings: { mendBy: 'auto' } })
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜', synopsis: '她的来历。' })
    const two = await project.addChapter({ title: '下山', synopsis: '她带剑下山。' })
    const three = await project.addChapter({ title: '渡口', synopsis: '她在渡口等。' })
    await project.saveChapterText(one.id, ONE)
    await project.saveChapterText(two.id, TWO)
    await project.saveChapterText(three.id, THREE)
    ids = { one: one.id, two: two.id, three: three.id }
    await project.saveCharacter({ name: '沈璃', role: 'protagonist', tagline: '带剑的姑娘', appearance: '左撇子，惯用左手' })
    await project.saveMemory({ schema: 1, chapterId: one.id, textHash: 'x', updatedAt: '', brief: '来历', summary: '沈璃生来是左撇子，十二岁。', facts: [], threads: [], newEntities: [], characters: [{ character: '沈璃', name: '沈璃', stateAfter: '在山上，十二岁', location: '山上' }] } as never)
    await project.saveMemory({ schema: 1, chapterId: two.id, textHash: 'x', updatedAt: '', brief: '下山', summary: '盛夏，沈璃带剑下山。', facts: [], threads: [], newEntities: [], characters: [{ character: '沈璃', name: '沈璃', stateAfter: '下了山，带着剑', location: '山下' }] } as never)
  })
  afterEach(async () => { await bed.cleanup() })

  const reviewer = (request: LlmRequest): boolean => request.prompt.includes('"verdict"')
  const planner = (request: LlmRequest): boolean => request.prompt.includes('责任编辑') && !reviewer(request)
  const waiting = async () => (await bed.runtime.project.proposals()).filter(item => item.status === 'pending')

  it('starts every pass of a book the same way: the base is one, and the story so far only grows at its end', async () => {
    const { runtime } = bed
    const { project } = runtime
    const [two, three] = [(await project.findChapter(ids.two))!, (await project.findChapter(ids.three))!]
    // Layer 1: what the book is, how it is written, everybody by name, the outline — whichever chapter is in hand.
    const base = await bookBase(runtime, 'zh')
    for (const part of ['# 《七日未寄》', '## 设定的文风：', '## 人物（1 人，各一行；要看整张卡用 book_read what=character）', '- 沈璃 · 带剑的姑娘', '## 全书章纲', '1. 《雨夜》 她的来历。', '3. 《渡口》 她在渡口等。']) expect(base, part).toContain(part)
    expect(await bookBase(runtime, 'zh')).toBe(base)
    // (No chapter's text is in it, and nothing of one chapter more than of another.)
    for (const text of ['从小如此', '握着剑', '渡口没有人']) expect(base).not.toContain(text)

    // Layer 2: a summary a chapter, in order. What stands before chapter 2 is the head of what stands before chapter 3.
    const beforeTwo = await storyLedger(runtime, 'zh', two)
    const beforeThree = await storyLedger(runtime, 'zh', three)
    expect(beforeTwo.text).toContain('第1章《雨夜》  沈璃生来是左撇子，十二岁。')
    expect(beforeTwo.text).not.toContain('下山')
    expect(beforeThree.text.startsWith(beforeTwo.text)).toBe(true)
    expect(beforeThree.text).toContain('第2章《下山》  盛夏，沈璃带剑下山。')
    expect([beforeTwo.chapters, beforeThree.chapters]).toEqual([1, 2])
    // A chapter written and not digested is told by its plan, and said to be so.
    const four = await project.addChapter({ title: '入城', synopsis: '她进了城。' })
    await project.saveChapterText(four.id, '城门开着。')
    const ledger = await storyLedger(runtime, 'zh', (await project.findChapter(four.id))!)
    expect(ledger.unread).toBe(1)
    expect(ledger.text).toContain('第3章《渡口》  （写了，还没收录：这里只有章纲）她在渡口等。')
    // (It says of itself what it is for: a map, not the text.)
    expect(ledger.text).toContain('这是梗概，用来知道事情写在哪——要说它和哪里对不上，回到那一章的原文去核对')

    // Layer 3: the chapter's plan, where its people stood before it, how the chapter before ends, its own text.
    const hand = await chapterInHand(runtime, three, 'zh')
    for (const part of ['## 手上这一章：第 3 章《渡口》', '### 章纲（作者对这一章的安排）', '### 上一章（第 2 章）结尾\n她右手握着剑下了山。\n\n那是盛夏。', `### 本章正文\n${THREE}`]) expect(hand, part).toContain(part)
    await project.saveChapterText(ids.three, '沈璃到了渡口。\n\n她等了一夜。')
    expect(await chapterInHand(runtime, three, 'zh')).toContain('### 出场人物在这一章之前的状态（各取最近一次；出处是那一章的记忆）\n- 沈璃（第 2 章末）下了山，带着剑；在 山下')
  })

  it('reviews a chapter from those layers — not from the earlier text word for word — with what the review is about said last', async () => {
    const { core, runtime, llm } = bed
    llm.responder = () => JSON.stringify({ verdict: '可以。', issues: [] })
    await reviewChapter(core, runtime, { chapter: ids.three, focus: '看看她等得合不合理' }, task)
    const asked = llm.requests[0]!.prompt
    const order = ['# 《七日未寄》', '## 前情', '## 手上这一章：第 3 章《渡口》', '### 本章正文', '请以资深责任编辑的眼光审读', '作者要你重点看（以此为准）：看看她等得合不合理', '取证：', '只输出 JSON'].map(part => asked.indexOf(part))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((left, right) => left - right)).toEqual(order)
    // Chapter 1 is there as a line of the story so far, not as its text.
    expect(asked).toContain('第1章《雨夜》  沈璃生来是左撇子，十二岁。')
    expect(asked).not.toContain('那年她十二岁')
    // The head of the request for the next chapter's review is this one's, as far as the story so far reached.
    const four = await runtime.project.addChapter({ title: '入城', synopsis: '她进了城。' })
    await runtime.project.saveChapterText(four.id, '城门开着。')
    await reviewChapter(core, runtime, { chapter: four.id }, task)
    const next = llm.requests[1]!.prompt
    // (The outline grew by a chapter — the base changes when the outline does; what is compared is what stands under it.)
    const story = asked.slice(asked.indexOf('## 前情'), asked.indexOf('## 手上这一章'))
    expect(next).toContain(story.trimEnd())
  })

  it('looks for what a review quotes where it is said to stand: words that are not there are sent back, then let go of; an issue that quotes nothing is filed and said to be unchecked', async () => {
    const { core, runtime, llm } = bed
    const found = (await runtime.project.findChapter(ids.two))!
    // The check itself, kind by kind.
    expect(await checkEvidence(runtime, found, TWO, { kind: 'chapter', ref: '1', quote: '她生来是左撇子' }, 'zh')).toBeUndefined()
    expect(await checkEvidence(runtime, found, TWO, { kind: 'chapter', ref: '第 1 章', quote: '从小如此' }, 'zh')).toBeUndefined()
    expect(await checkEvidence(runtime, found, TWO, { kind: 'chapter', ref: '1', quote: '她是右撇子' }, 'zh')).toContain('第 1 章的正文里没有这句话')
    expect(await checkEvidence(runtime, found, TWO, { kind: 'chapter', ref: '9', quote: '随便' }, 'zh')).toContain('against.ref 要写第几章')
    expect(await checkEvidence(runtime, found, TWO, { kind: 'character', ref: '沈璃', quote: '惯用左手' }, 'zh')).toBeUndefined()
    expect(await checkEvidence(runtime, found, TWO, { kind: 'character', ref: '沈璃', quote: '惯用右手' }, 'zh')).toContain('人物卡“沈璃”上没有这句话')
    expect(await checkEvidence(runtime, found, TWO, { kind: 'here', quote: '那是盛夏' }, 'zh')).toBeUndefined()
    expect(await checkEvidence(runtime, found, TWO, { kind: 'here', quote: '那是隆冬' }, 'zh')).toContain('本章正文里没有这句话')
    expect(await checkEvidence(runtime, found, TWO, { kind: 'reference', ref: '旧例', quote: '查不了的' }, 'zh')).toBeUndefined()

    // A reviewer that quotes chapter 1 as saying what it does not, names no evidence for a second issue, and has a third right.
    let asked = 0
    llm.responder = () => {
      asked += 1
      return JSON.stringify({ verdict: '有问题。', issues: [
        { severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章说她只有一只手。', against: { kind: 'chapter', ref: '1', quote: '她只有一只手' } },
        { severity: 'medium', type: 'world', quote: '那是盛夏。', explanation: '这个世界没有夏天。' },
        { severity: 'high', type: 'character', quote: '她右手握着剑下了山。', explanation: '人物卡写她惯用左手。', against: { kind: 'character', ref: '沈璃', quote: '惯用左手' } },
        { severity: 'low', type: 'style', quote: '那是盛夏。', explanation: '这句突兀。' },
      ] })
    }
    const review = await reviewChapter(core, runtime, { chapter: ids.two }, task)
    // Sent back once (a plain call is asked once more), told what did not hold — the words that are not in chapter 1, and the issue with no evidence.
    expect(asked).toBe(2)
    for (const part of ['上一次交回的有地方不能用', 'issues 第 1 条：第 1 章的正文里没有这句话：“她只有一只手”', 'issues 第 2 条：这是一条“对不上”的问题（world），要写 against']) expect(llm.requests[1]!.prompt, part).toContain(part)
    // What quoted words that are not there is not filed; what quoted nothing is, and says it was not checked; what was found stands with its evidence.
    expect(review.unfounded).toBe(1)
    expect(review.issues.map(issue => [issue.type, issue.unverified, issue.against?.quote])).toEqual([['character', undefined, '惯用左手'], ['world', true, undefined], ['style', undefined, undefined]])
  })

  it('tells whoever works on a chapter what is on file, keeps an issue said again as the one it was, and proposes nothing twice', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    const hand = { severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章写她是左撇子。', against: { kind: 'chapter', ref: '1', quote: '她生来是左撇子' }, find: '她右手握着剑下了山。', replace: '她左手握着剑下了山。' }
    llm.responder = request => reviewer(request) ? JSON.stringify({ verdict: '惯用手写反了。', issues: [hand] }) : '不该问到别人'
    const first = await reviewChapter(core, runtime, { chapter: ids.two, mends: 'auto' }, task)
    expect(llm.requests[0]!.prompt).not.toContain('## 已经在案的')
    const closed = await closeIssues(core, runtime, [{ chapter: ids.two, issue: first.issues[0]!.id }], task)
    expect(closed).toMatchObject({ issues: 1, own: 1, writer: 0, same: 0, failed: [] })
    expect(llm.requests).toHaveLength(1)
    const [proposal] = await waiting()
    expect(proposal).toMatchObject({ chapterId: ids.two, before: '她右手握着剑下了山。', after: '她左手握着剑下了山。', wroteBy: 'analyst', issues: [first.issues[0]!.id] })

    // Reviewed again while the change waits: the reviewer is told the issue on file and the change that waits for it…
    const second = await reviewChapter(core, runtime, { chapter: ids.two, mends: 'auto' }, task)
    const told = llm.requests[1]!.prompt
    for (const part of ['## 已经在案的', '### 第 2 章《下山》', '已经记下、还开着的问题（不再重报', `- [${first.issues[0]!.id}]（已有提案在等） 「右手握着剑」 第一章写她是左撇子。`, '等着作者确认的改动', `- [${proposal!.id}]（为 ${first.issues[0]!.id}） 「她右手握着剑下了山。」→「她左手握着剑下了山。」`]) expect(told, part).toContain(part)
    // …and where it says the same thing again, of the same words, it is the issue on file — its id, and what waits for it, kept.
    expect(second.issues.map(issue => [issue.id, issue.mending])).toEqual([[first.issues[0]!.id, closed.batchId]])
    expect(second.kept).toBe(1)
    expect(await waiting()).toHaveLength(1)
    // A review that does not file it again — it was told not to — leaves it on file.
    llm.responder = () => JSON.stringify({ verdict: '没有问题。', issues: [] })
    const third = await reviewChapter(core, runtime, { chapter: ids.two, mends: 'auto' }, task)
    expect(third.issues.map(issue => issue.id)).toEqual([first.issues[0]!.id])
    // An issue on file with no change waiting stays too, where the review says nothing of it; one it names as gone is
    // settled, and says why. (Of what the author noticed themselves, a reviewer's word that it is gone settles nothing.)
    await project.saveReview({ ...(await project.review(ids.two))!, issues: [...(await project.review(ids.two))!.issues,
      { id: 'old1', severity: 'low', type: 'style', quote: '那是盛夏。', explanation: '这句突兀。' },
      { id: 'old2', severity: 'low', type: 'pacing', explanation: '结尾太快。' },
      { id: 'old3', severity: 'low', type: 'logic', explanation: '作者自己看出来的。', lead: '这里不对' },
    ] })
    llm.responder = () => JSON.stringify({ verdict: '好多了。', gone: ['old2', 'old3', 'no-such-id'], issues: [] })
    const fourth = await reviewChapter(core, runtime, { chapter: ids.two, mends: 'auto' }, task)
    expect(fourth.issues.map(issue => [issue.id, issue.resolved === true])).toEqual([[first.issues[0]!.id, false], ['old1', false], ['old3', false], ['old2', true]])
    expect(fourth.issues.find(issue => issue.id === 'old2')!.checked).toMatchObject({ verdict: 'fixed', why: '重新审校时，现在的正文已经没有这个问题' })
    expect(llm.requests.at(-1)!.prompt).toContain('其中现在的正文已经不再有的（改掉了），把它的编号放进 gone')
    await project.saveReview({ ...(await project.review(ids.two))!, issues: (await project.review(ids.two))!.issues.filter(issue => issue.id === first.issues[0]!.id) })

    // One place, one change that waits. The same words proposed again are no new proposal — it answers for the other issue too…
    const again = await proposeSpan(runtime, TWO, { chapterId: ids.two, kind: 'span', instruction: '另一趟', before: '她右手握着剑下了山。', after: '她左手握着剑下了山。', at: 0, createdBy: 'user', issues: ['is_other'] }, 'zh')
    expect(again).toMatchObject({ same: true, replaced: 0, proposal: { id: proposal!.id, issues: [first.issues[0]!.id, 'is_other'] } })
    expect(await waiting()).toHaveLength(1)
    // …other words for the same passage (also where it only overlaps it) take its place, carrying what it was for…
    const other = await proposeSpan(runtime, TWO, { chapterId: ids.two, kind: 'span', instruction: '改得不一样', before: '右手握着剑', after: '左手提着剑', at: 1, createdBy: 'user', batchId: 'batch_new' }, 'zh')
    expect(other).toMatchObject({ replaced: 1 })
    expect(other.proposal).toMatchObject({ supersedes: [proposal!.id], issues: [first.issues[0]!.id, 'is_other'] })
    expect(other.proposal.rationale).toContain('取代了同一处先前的 1 条提案；放弃这一条，先前的回来等你确认。')
    expect((await waiting()).map(item => item.id)).toEqual([other.proposal.id])
    expect((await project.proposals()).find(item => item.id === proposal!.id)).toMatchObject({ status: 'rejected', supersededBy: other.proposal.id })
    // …and a change to another passage of the chapter is a change of its own.
    const apart = await proposeSpan(runtime, TWO, { chapterId: ids.two, kind: 'span', instruction: '别处', before: '那是盛夏。', after: '那是隆冬。', at: TWO.indexOf('那是盛夏。'), createdBy: 'user' }, 'zh')
    expect(apart).toMatchObject({ replaced: 0 })
    expect(apart.same).toBeUndefined()
    expect(await waiting()).toHaveLength(2)

    // Turned down by the author, the later one gives way to the earlier — and what the author refused is said to whoever works on the chapter next.
    await rejectProposal(runtime, apart.proposal.id)
    const file = await onFile(runtime, [{ id: ids.two, index: 2, title: '下山' }], 'zh')
    expect(file).toMatchObject({ issues: 1, waiting: 1, refused: 1 })
    expect(file.text).toContain('作者放弃过的改法（同样的改法不再提）：\n- 「那是盛夏。」→「那是隆冬。」')
    // (A proposal another took the place of was refused by nobody: it is not said to have been.)
    expect(file.text).not.toContain('「她右手握着剑下了山。」→「她左手握着剑下了山。」\n- 「那是盛夏')

    // A sentence of the author's carried out is told the same: it does not propose again what waits.
    llm.requests.length = 0
    llm.responder = request => planner(request) ? JSON.stringify({ findings: [], edits: [], chapters: [], note: '已经有提案在等了。' }) : '不该问到别人'
    await reviewByLead(core, runtime, { lead: '她是左撇子，下山那句手写反了', chapters: [ids.two] }, task)
    for (const part of ['## 已经在案的', '等着作者确认的改动', `[${other.proposal.id}]`, '作者放弃过的改法']) expect(llm.requests[0]!.prompt, part).toContain(part)
  })

  it('settles the issues a change was made for when it is accepted, and has only what it moved read again', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    await core.settings.update({ recheckIssues: true })
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [
      { id: 'i1', severity: 'high', type: 'continuity', quote: '右手握着剑', explanation: '第一章写她是左撇子。', fix: { find: '她右手握着剑下了山。', replace: '她左手握着剑下了山。' } },
      { id: 'i2', severity: 'low', type: 'style', quote: '那是盛夏。', explanation: '这句突兀。' },
      // (Its words are among the ones the change takes away: it is the one that has to be read again.)
      { id: 'i3', severity: 'low', type: 'language', quote: '她右手握着', explanation: '“握着”可以更具体。' },
    ] })
    llm.responder = () => JSON.stringify({ issues: [{ id: 'i3', verdict: 'stands', quote: '她左手握着', why: '还在。' }] })
    const closed = await closeIssues(core, runtime, [{ chapter: ids.two, issue: 'i1' }], task)
    expect(llm.requests).toHaveLength(0)
    const [proposal] = await waiting()
    expect(proposal!.batchId).toBe(closed.batchId)
    await acceptProposal(core, runtime, proposal!.id, task)
    // The issue it was for is settled at once, and says how — nobody was asked.
    expect((await project.review(ids.two))!.issues.find(issue => issue.id === 'i1')).toMatchObject({ resolved: true, checked: { verdict: 'fixed', why: '按采纳的修订提案改了' } })
    expect(llm.requests).toHaveLength(0)
    // Of the others, only the one whose words the change moved is read again: one request, naming that one alone.
    for (let turn = 0; turn < 200 && llm.requests.length === 0; turn++) await wait(20)
    await wait(40)
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]!.prompt).toContain('- id: i3')
    expect(llm.requests[0]!.prompt).not.toContain('- id: i2')
    expect(llm.requests[0]!.prompt).not.toContain('- id: i1')

    // A change that moves nobody else's words has nothing read again.
    await project.saveReview({ chapterId: ids.three, textHash: 'x', createdAt: '', verdict: '', issues: [
      { id: 'j1', severity: 'low', type: 'style', quote: '她等了一夜。', explanation: '太平。', fix: { find: '她等了一夜。', replace: '她等到天亮。' } },
      { id: 'j2', severity: 'low', type: 'style', quote: '渡口没有人。', explanation: '可以再具体。' },
    ] })
    await closeIssues(core, runtime, [{ chapter: ids.three, issue: 'j1' }], task)
    const mine = (await waiting()).find(item => item.chapterId === ids.three)!
    llm.requests.length = 0
    await acceptProposal(core, runtime, mine.id, task)
    await wait(1700)
    expect(llm.requests).toHaveLength(0)
    expect((await project.review(ids.three))!.issues.map(issue => [issue.id, issue.resolved])).toEqual([['j1', true], ['j2', undefined]])
  })

  it('finds every place some exact words stand with one call, and stops handing out reading past the cap', async () => {
    const { core, runtime } = bed
    const find = bookTools(runtime, undefined, 'main').find(tool => tool.name === 'book_find')!
    const all = await find.run({ text: '握着剑' })
    expect(all).toContain('"握着剑" stands 1 time(s), in 1 chapter(s) (#2)')
    expect(all).toContain('#2 下山: 她右手握着剑下了山。')
    await expect(find.run({ text: '她' })).rejects.toThrow('`text` is the exact words to find, two characters or more')
    expect(await find.run({ text: '飞剑' })).toContain('stands nowhere in the manuscript')
    expect(await find.run({ text: '她等了', chapters: '1-2' })).toContain('stands nowhere in chapters 1–2')

    // A piece of work with a cap on what it reads: past it, a reading tool says so in place of what was asked for.
    bed.roles.enabled = true
    const got: string[] = []
    bed.roles.script = async (_agent, call) => {
      got.push(await call('book_read', { what: 'chapter', ref: '1' }))
      got.push(await call('book_read', { what: 'chapter', ref: '2' }))
      got.push(await call('book_find', { text: '握着剑' }))
      await call('hand_in', { result: { done: true } })
    }
    const done = await assign(core, runtime, task, { role: 'analyst', label: '试', tool: 'hand_in', what: '结果', prompt: '读一读。', readCap: 5, validate: raw => raw as { done: boolean } })
    expect(got[0]).toContain('她生来是左撇子')
    for (const said of got.slice(1)) expect(said).toContain('这一趟能读的已经读满了（约 5 token）。照已经查到的把活交回')
    expect(done.read).toMatchObject({ calls: 1, capped: true })
    expect(done.value).toEqual({ done: true })
  })
})

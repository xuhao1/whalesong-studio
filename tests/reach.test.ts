// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * How far a mending reaches (`mendReach`). Unless the author set the least change, a problem is mended through: every
 * place it shows, what has to change with each, a place taking in as much as has to move. What is said for one run
 * holds over the setting; the guards that keep a change a change — quoted as it stands, found once, never the chapter
 * in one place — hold either way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { amendChapter } from '../src/core/pipelines/amend'
import { fixIssue, fixIssues, rejectProposal, reviewByLead, reviseBook, widenedPlace } from '../src/core/pipelines/revise'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const ONE = '她是左撇子，从小如此。\n\n师父教她用左手握剑。'
const TALK = [
  '山下是盛夏，蝉叫得人心烦，茶棚的布帘晒得发白，掌柜的坐在门槛上打盹，脚边一条黄狗伸着舌头喘气，半天也不肯挪一下地方，连苍蝇落在鼻尖上都懒得赶。路上一个行人也没有，只有远处的田埂上晃着两顶草帽，看不清是人还是插在那里吓鸟的。',
  '“住店？”掌柜的问。',
  '她右手握着剑，点了点头。',
  '“后院还有一间。”',
  '![茶棚](assets/images/shed.png)',
  '她在茶棚歇了一夜。夜里下了一场雨，檐下的水一直滴到天亮，她听着那声音，想起山上的师父，想起临走时他只说了一句话，那句话她到现在也没有想明白，于是翻来覆去，直到鸡叫了才合了一会儿眼。',
].join('\n\n')

describe('how far a mending reaches', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '青冥' }) })
  afterEach(async () => { await bed.cleanup() })

  const book = async (): Promise<{ one: string; two: string }> => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜' })
    const two = await project.addChapter({ title: '下山' })
    await project.saveChapterText(one.id, ONE)
    await project.saveChapterText(two.id, TALK)
    return { one: one.id, two: two.id }
  }
  const planner = (request: LlmRequest): boolean => request.prompt.includes('责任编辑')
  const passage = (request: LlmRequest): string => /<<<\n([\s\S]*?)\n>>>/.exec(request.prompt)?.[1] ?? ''
  const BOLD = ['把问题改到位，不只在一处打个补丁', '圈够——为了改得通顺、站得住而要一起动的句子都圈进来', '一段话要重写就圈一整段']
  const CAREFUL = ['改动越少越好', '一处能解决的，不改两处', '圈非改不可的那一两句']

  it('the place around a quote: a line of talk takes its neighbours, a paragraph stands by itself, a picture is never crossed', () => {
    const at = (quote: string): { start: number; end: number } => { const start = TALK.indexOf(quote); return { start, end: start + quote.length } }
    const of = (range: { start: number; end: number }): string => TALK.slice(range.start, range.end)
    // A short line: the line before and the line after go with it.
    expect(of(widenedPlace(TALK, at('右手握着剑')))).toBe('“住店？”掌柜的问。\n\n她右手握着剑，点了点头。\n\n“后院还有一间。”')
    // Beside a picture: the picture's line and what is beyond it stay out.
    expect(of(widenedPlace(TALK, at('后院还有一间')))).toBe('她右手握着剑，点了点头。\n\n“后院还有一间。”')
    // A paragraph of some length is the place: its neighbours stay out.
    expect(of(widenedPlace(TALK, at('夜里下了一场雨')))).toBe(TALK.slice(TALK.indexOf('她在茶棚歇了一夜')))
    // What would take in the greater part of a chapter is no place: the quote stays as it was.
    const short = '她推开门。屋里很黑。\n\n“有人吗？”她问。右手握着剑。'
    const quote = { start: short.indexOf('右手握着剑'), end: short.indexOf('右手握着剑') + 5 }
    expect(widenedPlace(short, quote)).toEqual(quote)
  })

  it('unless the author says otherwise a problem is mended through — the planner is told so, and the writer of each place too', async () => {
    const { project } = bed.runtime
    const ids = await book()
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'high', type: 'continuity', explanation: '第一章写她是左撇子，这一章却用右手。' }] })
    bed.llm.responder = (request) => {
      if (planner(request)) return JSON.stringify({ edits: [{ chapter: 2, find: '她右手握着剑，点了点头。', how: '右手改成左手，并让掌柜的多看一眼' }], chapters: [], note: '改这一处。' })
      return passage(request).replace('右手', '左手')
    }
    const result = await fixIssue(bed.core, bed.runtime, { chapter: ids.two, issue: 'i1', scope: 'place' }, task)
    expect(result.scope).toBe('places')
    const plan = bed.llm.requests.find(planner)!.prompt
    for (const part of [...BOLD, '顺着这个问题改到底', '把这个问题改到位：它牵动的呼应、反应和衔接一并改', '"find": "这一处能动的原文，逐字照抄"']) expect(plan, part).toContain(part)
    for (const part of [...CAREFUL, '只修这个问题本身', '修正这个问题，别的不要动']) expect(plan, part).not.toContain(part)
    const writer = bed.llm.requests.find(request => !planner(request))!.prompt
    expect(writer).toContain('照这个改法把这一处改到位')
    expect(writer).not.toContain('改法没有提到的字句照原样交回')
    // The guards hold: one place, quoted as it stands, proposed by itself.
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting.map(item => [item.kind, item.before, item.after])).toEqual([['span', '她右手握着剑，点了点头。', '她左手握着剑，点了点头。']])
  })

  it('the setting, or a word for one run, holds a mending to the least change', async () => {
    const { project } = bed.runtime
    const ids = await book()
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'high', type: 'continuity', explanation: '第一章写她是左撇子，这一章却用右手。' }] })
    bed.llm.responder = (request) => {
      if (planner(request)) return JSON.stringify({ edits: [{ chapter: 2, find: '她右手握着剑，点了点头。', how: '右手改成左手' }], chapters: [], note: '改这一处。' })
      return passage(request).replace('右手', '左手')
    }
    // Said for this run.
    await fixIssue(bed.core, bed.runtime, { chapter: ids.two, issue: 'i1', scope: 'place', reach: 'careful' }, task)
    let plan = bed.llm.requests.find(planner)!.prompt
    for (const part of [...CAREFUL, '只修这个问题本身', '"find": "这一处能动的那一两句原文，逐字照抄"']) expect(plan, part).toContain(part)
    for (const part of BOLD) expect(plan, part).not.toContain(part)
    expect(bed.llm.requests.find(request => !planner(request))!.prompt).toContain('改法没有提到的字句照原样交回')
    // Set by the author: every mending — a request through the book, a batch, a lead.
    await bed.core.settings.update({ mendReach: 'careful' })
    bed.llm.requests.length = 0
    await reviseBook(bed.core, bed.runtime, { instruction: '她用的兵器从剑改成刀', asked: true }, task)
    plan = bed.llm.requests.find(planner)!.prompt
    expect(plan).toContain('改动越少越好：这条要求碰到哪几句就改哪几句')
    expect(plan).not.toContain('把这条要求落实到位')
    // …and a word for one run the other way.
    bed.llm.requests.length = 0
    await reviseBook(bed.core, bed.runtime, { instruction: '她用的兵器从剑改成刀', asked: true, reach: 'bold' }, task)
    plan = bed.llm.requests.find(planner)!.prompt
    for (const part of ['把这条要求落实到位：它碰到的每一处都改', '宁可多查一章，不漏一处']) expect(plan, part).toContain(part)
    bed.llm.requests.length = 0
    await fixIssues(bed.core, bed.runtime, { issues: [{ chapter: ids.two, issue: 'i1' }], reach: 'bold' }, task)
    expect(bed.llm.requests.find(planner)!.prompt).toContain('把问题改到位，不只在一处打个补丁')
    bed.llm.requests.length = 0
    bed.llm.responder = request => planner(request) ? JSON.stringify({ findings: [], edits: [], chapters: [], note: '没有找到。' }) : ''
    await reviewByLead(bed.core, bed.runtime, { lead: '她到底是左撇子还是右撇子', reach: 'bold' }, task)
    plan = bed.llm.requests.find(planner)!.prompt
    for (const part of ['作者说的是一类毛病时，它露出来的地方都记', '把问题改到位']) expect(plan, part).toContain(part)
    bed.llm.requests.length = 0
    await reviewByLead(bed.core, bed.runtime, { lead: '她到底是左撇子还是右撇子' }, task)
    expect(bed.llm.requests.find(planner)!.prompt).toContain('记最明显的那几处')
  })

  it('an issue mended where it is quoted: the paragraph around the quote may change, and what did not change is left out of the proposal', async () => {
    const { project } = bed.runtime
    const ids = await book()
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i2', severity: 'medium', type: 'style', quote: '她右手握着剑，点了点头。', explanation: '这一句太平，接不住掌柜的问话。' }] })
    bed.llm.responder = request => passage(request).replace('她右手握着剑，点了点头。', '她没有答，右手按在剑上，只把下巴往里一点。').replace('“后院还有一间。”', '掌柜的看了那只手一眼。“后院还有一间。”')
    const result = await fixIssue(bed.core, bed.runtime, { chapter: ids.two, issue: 'i2', scope: 'passage' }, task)
    expect(result.scope).toBe('passage')
    const request = bed.llm.requests.at(-1)!
    // Handed the lines around it, and told where it shows and what may move.
    expect(passage(request)).toBe('“住店？”掌柜的问。\n\n她右手握着剑，点了点头。\n\n“后院还有一间。”')
    for (const part of ['问题露在“她右手握着剑，点了点头。”这里', '交给你的是它所在的这一段', '把这个问题改到位']) expect(request.prompt, part).toContain(part)
    // The line that came back as it stood is not part of what is proposed.
    const [proposal] = (await project.proposals()).filter(item => item.status === 'pending')
    // (The line before it, and the words of the line after it that stand as they stood.)
    expect(proposal!.before.trim()).toBe('她右手握着剑，点了点头。')
    expect(proposal!.after.trim()).toBe('她没有答，右手按在剑上，只把下巴往里一点。\n\n掌柜的看了那只手一眼。')
    expect(proposal!.before).not.toContain('住店')
    expect(proposal!.issues).toEqual(['i2'])
    // Held to the least change, the quote is all that is handed over.
    await bed.core.settings.update({ mendReach: 'careful' })
    for (const waiting of (await project.proposals()).filter(item => item.status === 'pending')) await rejectProposal(bed.runtime, waiting.id)
    bed.llm.responder = request => passage(request).replace('点了点头', '只点了点头')
    await fixIssue(bed.core, bed.runtime, { chapter: ids.two, issue: 'i2', scope: 'passage' }, task)
    expect(passage(bed.llm.requests.at(-1)!)).toBe('她右手握着剑，点了点头。')
    expect(bed.llm.requests.at(-1)!.prompt).not.toContain('交给你的是它所在的这一段')
  })

  it('a chapter gone through to an instruction: carried through by default, the least that answers it when the author says so', async () => {
    const ids = await book()
    bed.roles.enabled = true
    const rules: string[] = []
    bed.roles.script = async (agent, call) => {
      rules.push(agent.rules ?? '')
      await call('submit_revision', { note: '看过了，不用改。' })
    }
    await amendChapter(bed.core, bed.runtime, { chapter: ids.two, instruction: '把掌柜的写得更冷淡' }, task)
    for (const part of ['把修改要求落实到这一章每一处用得上的地方', '一处圈够', '拿不准的地方照修改要求的方向做足']) expect(rules[0], part).toContain(part)
    for (const part of ['每一处只圈非改不可的那一两句', '修改要求说到哪里改到哪里', '按最稳妥的理解做']) expect(rules[0], part).not.toContain(part)
    await amendChapter(bed.core, bed.runtime, { chapter: ids.two, instruction: '把掌柜的写得更冷淡', reach: 'careful' }, task)
    for (const part of ['每一处只圈非改不可的那一两句', '修改要求说到哪里改到哪里', '按最稳妥的理解做']) expect(rules[1], part).toContain(part)
    // Asked in one request, of a model that runs no tools: the same two ways.
    bed.roles.enabled = false
    bed.llm.responder = () => JSON.stringify({ edits: [], note: '不用改。' })
    await amendChapter(bed.core, bed.runtime, { chapter: ids.two, instruction: '把掌柜的写得更冷淡' }, task)
    expect(bed.llm.requests.at(-1)!.system).toContain('每条圈够')
    await bed.core.settings.update({ mendReach: 'careful' })
    await amendChapter(bed.core, bed.runtime, { chapter: ids.two, instruction: '把掌柜的写得更冷淡' }, task)
    expect(bed.llm.requests.at(-1)!.system).toContain('每条只圈非改不可的那一两句')
  })
})

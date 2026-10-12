// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A review led by the author: what they noticed in their book is said in a sentence, found in the text by the planner
 * — each place filed as an issue of its chapter, marked as the author's own — and mended by places. And who writes
 * the words of such a change: the writer after the planner, or the planner itself, whose hand-in is then the proposal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acceptProposal, fixIssue, reviewByLead, reviseBook } from '../src/core/pipelines/revise'
import { amendChapter } from '../src/core/pipelines/amend'
import { reviewChapter } from '../src/core/pipelines/review'
import { readBook } from '../src/core/reading'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const ONE = '柳先生摘下眼镜，放在柜台上。\n\n他说话很慢。'
const TWO = '柳先生没戴眼镜，眯着眼看账。\n\n过了一会儿，柳先生推了推眼镜。\n\n窗外有雨。'
const THREE = '渡口没有人。\n\n她等了一夜。'

describe('a review led by what the author noticed', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  const book = async (): Promise<{ one: string; two: string; three: string }> => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '铺子' })
    const two = await project.addChapter({ title: '旧账' })
    const three = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(one.id, ONE)
    await project.saveChapterText(two.id, TWO)
    await project.saveChapterText(three.id, THREE)
    return { one: one.id, two: two.id, three: three.id }
  }
  const planner = (request: LlmRequest): boolean => request.prompt.includes('责任编辑')
  const passage = (request: LlmRequest): string => /<<<\n([\s\S]*?)\n>>>/.exec(request.prompt)?.[1] ?? ''
  const LEAD = '柳先生的眼镜一会儿有一会儿没有'
  const FOUND = [
    { chapter: 2, quote: '柳先生没戴眼镜，眯着眼看账。', type: 'continuity', severity: 'medium', explanation: '这里说没戴眼镜。', suggestion: '和下一句统一。' },
    { chapter: 2, quote: '过了一会儿，柳先生推了推眼镜。', type: 'continuity', severity: 'high', explanation: '两句之后却推了推眼镜：前面刚说没戴。' },
  ]

  it('finds where it shows, files each place as an issue of its chapter, and mends it by places — each change beneath the issue it is for', async () => {
    const { project } = bed.runtime
    const ids = await book()
    bed.llm.responder = (request) => {
      if (planner(request)) return JSON.stringify({ findings: FOUND, edits: [{ chapter: 2, find: '过了一会儿，柳先生推了推眼镜。', how: '改成揉了揉眼睛' }], chapters: [], note: '第 2 章两句打架：改后一句。第 1 章摘下眼镜是交代过的，不动。' })
      return passage(request).replace('推了推眼镜', '揉了揉眼睛')
    }
    const result = await reviewByLead(bed.core, bed.runtime, { lead: `  ${LEAD}  ` }, task)

    // One run of the planner: told that the author noticed it, to find it first, and how a finding is written.
    const asked = bed.llm.requests.filter(planner)
    expect(asked).toHaveLength(1)
    for (const part of ['作者读自己的书时发现了一个问题', '## 作者发现的问题', LEAD, '先把它找出来', '"findings"', '"quote"', '逐字照抄', '"edits"', '"how"', '书里其实没有这个问题', '把牵连查清', '"bible"', '### 第 2 章《旧账》']) expect(asked[0]!.prompt, part).toContain(part)
    expect(asked[0]!.prompt).not.toContain('"replace"')

    // Found twice in chapter 2: two issues of that chapter — the author's own, handed over with this batch.
    expect(result).toMatchObject({ chapters: 1, fix: true, note: expect.stringContaining('两句打架') })
    expect(result.found.map(item => [item.index, item.quote, item.severity, item.known])).toEqual([[2, '柳先生没戴眼镜，眯着眼看账。', 'medium', undefined], [2, '过了一会儿，柳先生推了推眼镜。', 'high', undefined]])
    const review = (await project.review(ids.two))!
    expect(review.unread).toBe(true)
    expect(review.issues.map(issue => [issue.quote, issue.type, issue.lead, issue.mending === result.book.batchId, issue.suggestion])).toEqual([
      ['柳先生没戴眼镜，眯着眼看账。', 'continuity', LEAD, true, '和下一句统一。'],
      ['过了一会儿，柳先生推了推眼镜。', 'continuity', LEAD, true, undefined],
    ])
    // The chapter counts its open issues, and still says nobody reviewed it; chapters nothing was found in have no review.
    const infos = await project.chapterInfos()
    expect(infos.map(info => [info.index, info.openIssues, info.unreviewed])).toEqual([[1, undefined, undefined], [2, 2, true], [3, undefined, undefined]])

    // One place changed, by the writer; its proposal is for the finding it takes in, and for that one alone.
    expect(result.book.results.map(item => [item.index, item.kind, item.reason])).toEqual([[2, 'span', '改成揉了揉眼睛']])
    expect(result.book.direct).toBeUndefined()
    const writers = bed.llm.requests.filter(request => !planner(request))
    expect(writers.map(passage)).toEqual(['过了一会儿，柳先生推了推眼镜。'])
    const waiting = (await project.proposals()).filter(item => item.status === 'pending')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ chapterId: ids.two, kind: 'span', before: '过了一会儿，柳先生推了推眼镜。', after: '过了一会儿，柳先生揉了揉眼睛。', batchId: result.book.batchId, issues: [review.issues[1]!.id] })
    expect(await project.chapterText(ids.two)).toBe(TWO)

    // A review of the chapter afterwards does not take away what the author had found: it is theirs, and still open.
    bed.llm.responder = () => JSON.stringify({ verdict: '大体通顺。', issues: [{ severity: 'low', type: 'pacing', quote: '窗外有雨。', explanation: '收得太快。' }] })
    const read = await reviewChapter(bed.core, bed.runtime, { chapter: ids.two }, task)
    expect(read.unread).toBeUndefined()
    expect(read.issues.map(issue => [issue.explanation, issue.lead])).toEqual([['收得太快。', undefined], ['这里说没戴眼镜。', LEAD], ['两句之后却推了推眼镜：前面刚说没戴。', LEAD]])
    expect((await project.chapterInfos())[1]).toMatchObject({ openIssues: 3 })
    expect((await project.chapterInfos())[1]!.unreviewed).toBeUndefined()
  })

  it('only finds where that is asked, sends back a quote the chapter does not have, and does not file twice what is on file', async () => {
    const { project } = bed.runtime
    const ids = await book()
    // A review of the chapter is there already, with one of the places in it.
    await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '有一处对不上。', issues: [{ id: 'i_old', severity: 'low', type: 'continuity', quote: '过了一会儿，柳先生推了推眼镜。', explanation: '眼镜前后不一。' }] })
    let tries = 0
    bed.llm.responder = (request) => {
      if (!planner(request)) throw new Error('nobody is asked to write')
      tries += 1
      return tries === 1
        ? JSON.stringify({ findings: [{ chapter: 2, quote: '柳先生戴上了眼镜。', explanation: '编的引文' }, { chapter: 9, quote: '窗外有雨。', explanation: '没有这一章' }, { chapter: 2, quote: '窗外有雨。' }], edits: [], chapters: [], note: '' })
        : JSON.stringify({ findings: FOUND, edits: [{ chapter: 2, find: '窗外有雨。', how: '不该有的改动' }], chapters: [{ index: 2, reason: '不该有' }], note: '只找。' })
    }
    const result = await reviewByLead(bed.core, bed.runtime, { lead: LEAD, fix: false, chapters: [ids.two] }, task)
    // Told it is to find and not to change, and that these chapters are all it looks at.
    const first = bed.llm.requests[0]!.prompt
    for (const part of ['这一次只找，不改', '这一次只找不改：edits 和 chapters 都给空数组', '作者只让查这几章']) expect(first, part).toContain(part)
    for (const part of ['改动越少越好', '"how"', '"bible"', '### 第 1 章']) expect(first, part).not.toContain(part)
    // What could not be used was said back, entry by entry, and the whole handed in again.
    expect(tries).toBe(2)
    const back = bed.llm.requests[1]!.prompt
    for (const part of ['findings 第 1 条：第 2 章里找不到这段原文', 'findings 第 2 条：第 9 章不在这次能查的章节里', 'findings 第 3 条：quote（露出问题的原文）和 explanation（这一处是什么问题）都要写']) expect(back, part).toContain(part)

    // Filed, nothing changed — whatever the planner handed in beside the findings.
    expect(result.fix).toBe(false)
    expect(result.book.results).toEqual([])
    expect((await project.proposals())).toHaveLength(0)
    const review = (await project.review(ids.two))!
    // The review that was there stays what it was — a review — and the place it had is the same issue, now the author's too.
    expect(review.unread).toBeUndefined()
    expect(review.verdict).toBe('有一处对不上。')
    expect(review.issues.map(issue => [issue.id === 'i_old', issue.quote, issue.lead, issue.mending])).toEqual([
      [true, '过了一会儿，柳先生推了推眼镜。', LEAD, undefined],
      [false, '柳先生没戴眼镜，眯着眼看账。', LEAD, undefined],
    ])
    expect(result.found.map(item => [item.issue === 'i_old', item.known])).toEqual([[false, undefined], [true, true]])

    // Nothing found: nothing filed, and the planner's word on where it looked comes back.
    bed.llm.responder = () => JSON.stringify({ findings: [], edits: [], chapters: [], note: '三章都查了：渡口那一章没有柳先生。' })
    const none = await reviewByLead(bed.core, bed.runtime, { lead: '渡口那一章柳先生也在场', chapters: [ids.three] }, task)
    expect(none).toMatchObject({ found: [], chapters: 0, note: '三章都查了：渡口那一章没有柳先生。' })
    expect(await project.review(ids.three)).toBeUndefined()
    await expect(reviewByLead(bed.core, bed.runtime, { lead: '   ' }, task)).rejects.toMatchObject({ code: 'novel/invalid' })
  })

  it('has the planner write the changed words itself where the author set that: its hand-in is the proposal, and no writer is asked', async () => {
    const { project } = bed.runtime
    const ids = await book()
    await bed.core.settings.update({ mendBy: 'planner' })
    let tries = 0
    bed.llm.responder = (request) => {
      if (!planner(request)) throw new Error('the writer is not to be asked')
      tries += 1
      return tries === 1
        // Sent back: a place that reads as it did, and one without what it is to read.
        ? JSON.stringify({ findings: FOUND, edits: [{ chapter: 2, find: '窗外有雨。', replace: '窗外有雨。', why: '没改' }, { chapter: 2, find: '柳先生没戴眼镜，眯着眼看账。', how: '只说了怎么改' }], chapters: [], note: '' })
        : JSON.stringify({ findings: FOUND, edits: [
            { chapter: 2, find: '过了一会儿，柳先生推了推眼镜。', replace: '过了一会儿，柳先生揉了揉眼睛。', why: '前面刚说没戴眼镜' },
            { chapter: 1, find: '他说话很慢。', replace: '', why: '和这件事无关的一句，测试删除' },
          ], chapters: [], note: '后一句改掉。' })
    }
    const result = await reviewByLead(bed.core, bed.runtime, { lead: LEAD }, task)
    expect(tries).toBe(2)
    // Asked for the words themselves, and told how the book is written.
    const first = bed.llm.requests[0]!.prompt
    for (const part of ['把每一处改好的文字直接写出来', '"replace"', '"why"', '整句删掉就给空字符串', '没有人再替你改写']) expect(first, part).toContain(part)
    expect(first).not.toContain('"how"')
    const back = bed.llm.requests[1]!.prompt
    for (const part of ['edits 第 1 条：replace 和 find 一样，没有改动', 'edits 第 2 条：find（要换掉的原文）和 replace']) expect(back, part).toContain(part)
    // Nobody but the planner was asked.
    expect(bed.llm.requests.every(planner)).toBe(true)
    expect(result.book.direct).toBe(true)
    const waiting = (await project.proposals()).filter(item => item.status === 'pending').sort((left, right) => left.chapterId.localeCompare(right.chapterId))
    expect(waiting.map(item => [item.chapterId, item.kind, item.before, item.after, item.rationale, item.instruction])).toEqual([
      // (A sentence taken out with its line: the break before it goes with it.)
      [ids.one, 'span', '\n\n他说话很慢。', '', '和这件事无关的一句，测试删除', LEAD],
      [ids.two, 'span', '过了一会儿，柳先生推了推眼镜。', '过了一会儿，柳先生揉了揉眼睛。', '前面刚说没戴眼镜', LEAD],
    ])
    // Chapter 1 had no finding: its change is of the batch; chapter 2's is for the finding it takes in.
    expect(waiting[0]!.issues).toBeUndefined()
    expect(waiting[1]!.issues).toEqual([(await project.review(ids.two))!.issues[1]!.id])
    for (const proposal of waiting) await acceptProposal(bed.core, bed.runtime, proposal.id, task)
    expect(await project.chapterText(ids.one)).toBe('柳先生摘下眼镜，放在柜台上。')
    expect(await project.chapterText(ids.two)).toBe(TWO.replace('推了推眼镜', '揉了揉眼睛'))

    // Asked for outright too, whatever the settings say; and a mending without a lead goes the same way.
    await bed.core.settings.update({ mendBy: 'writer' })
    bed.llm.requests.length = 0
    bed.llm.responder = request => planner(request) ? JSON.stringify({ edits: [{ chapter: 3, find: '她等了一夜。', replace: '她等了两夜。\n船没有来。', why: '照要求' }], chapters: [], note: '一处。' }) : 'writer text'
    const direct = await reviseBook(bed.core, bed.runtime, { instruction: '等的是两夜', asked: true, direct: true }, task)
    expect(direct.direct).toBe(true)
    expect(bed.llm.requests).toHaveLength(1)
    // (A line break written the model's way is a paragraph break: it gets the empty line the chapter parts paragraphs with.)
    expect((await project.proposals()).filter(item => item.status === 'pending').map(item => [item.before, item.after])).toEqual([['她等了一夜。', '她等了两夜。\n\n船没有来。']])
  })

  it('routes the quoted place of an issue, and a chapter gone through to an instruction, to the planner\'s model where the author set that', async () => {
    const { project } = bed.runtime
    const ids = await book()
    const writer = { provider: 'p', model: 'writer-model' }
    const crew = { provider: 'p', model: 'crew-model' }
    await bed.core.settings.update({ models: { writer, architect: crew } as never })
    await project.saveReview({ chapterId: ids.three, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'low', type: 'style', quote: '她等了一夜。', explanation: '太平。' }] })
    bed.llm.responder = request => request.prompt.includes('改动清单') ? JSON.stringify({ edits: [{ find: '渡口没有人。', replace: '渡口空着。' }], note: '一处。' }) : '她等到天亮。'
    // As the settings are: the writer's model.
    await fixIssue(bed.core, bed.runtime, { chapter: ids.three, issue: 'i1', scope: 'passage' }, task)
    expect(bed.llm.requests.at(-1)!.route).toMatchObject(writer)
    const mine = await amendChapter(bed.core, bed.runtime, { chapter: ids.three, instruction: '开头换个说法' }, task)
    expect(mine).toMatchObject({ who: 'writer', places: 1 })
    expect(bed.llm.requests.at(-1)!.route).toMatchObject(writer)
    // The author has the crew's model make such changes: both go to it.
    await bed.core.settings.update({ mendBy: 'planner' })
    await fixIssue(bed.core, bed.runtime, { chapter: ids.three, issue: 'i1', scope: 'passage' }, task)
    expect(bed.llm.requests.at(-1)!.route).toMatchObject(crew)
    const theirs = await amendChapter(bed.core, bed.runtime, { chapter: ids.three, instruction: '开头换个说法' }, task)
    expect(theirs).toMatchObject({ who: 'planner', places: 1 })
    expect(bed.llm.requests.at(-1)!.route).toMatchObject(crew)
    // (And said outright for one chapter, whatever the settings.)
    expect(await amendChapter(bed.core, bed.runtime, { chapter: ids.three, instruction: '开头换个说法', by: 'writer' }, task)).toMatchObject({ who: 'writer' })
  })

  it('shows a role the chapter as its work goes by it: what it copies from its reading tool is what it is checked against', async () => {
    const ids = await book()
    // A mending that goes on from changes still waiting reads the chapter with them laid in — through the tool too.
    const laidIn = new Map([[ids.three, '渡口空着。\n\n她等了一夜。']])
    const read = await readBook(bed.runtime, { what: 'chapter', ref: ids.three }, undefined, undefined, laidIn)
    expect(read.text).toContain('with the changes that still wait for it laid in')
    expect(read.text).toContain('渡口空着。')
    expect(read.text).not.toContain('渡口没有人。')
    // Every other chapter, and every other reader, has the book's own text.
    expect((await readBook(bed.runtime, { what: 'chapter', ref: ids.two }, undefined, undefined, laidIn)).text).toContain('柳先生没戴眼镜')
    expect((await readBook(bed.runtime, { what: 'chapter', ref: ids.three })).text).toContain('渡口没有人。')
  })
})

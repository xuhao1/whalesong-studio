// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Who writes the words of a revision made by places, where nothing is set (`mendBy` `auto`): the planner tells place
 * by place. A small change — a word, a name, a number — it writes itself, and what it wrote is the proposal; a place
 * where a passage is to be written it hands to the writer's model, saying how. So the writer's model, as a rule the
 * dearer one, is called only where prose is to be written — and what a revision came to says whose words were whose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixIssue, mendsBy, reviseBook } from '../src/core/pipelines/revise'
import { amendChapter } from '../src/core/pipelines/amend'
import type { LlmRequest } from '../src/core/llm'
import { createTestBed, type TestBed } from './support/harness'

const task = { origin: 'user' as const }
const ONE = '柳先生摘下眼镜，放在柜台上。\n\n他说话很慢。'
const TWO = '柳先生没戴眼镜，眯着眼看账。\n\n窗外有雨。'
const THREE = '渡口没有人。\n\n她等了一夜。'
const writer = { provider: 'p', model: 'writer-model' }
const crew = { provider: 'p', model: 'crew-model' }

describe('a revision the planner judges place by place', () => {
  let bed: TestBed
  let ids: { one: string; two: string; three: string }
  beforeEach(async () => {
    // (The bed has the writer rewrite every place; here nothing is set, as in a Studio just installed.)
    bed = await createTestBed({ language: 'zh', title: '七日未寄', settings: { mendBy: undefined } })
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '铺子' })
    const two = await project.addChapter({ title: '旧账' })
    const three = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(one.id, ONE)
    await project.saveChapterText(two.id, TWO)
    await project.saveChapterText(three.id, THREE)
    ids = { one: one.id, two: two.id, three: three.id }
    await bed.core.settings.update({ models: { writer, architect: crew } as never })
  })
  afterEach(async () => { await bed.cleanup() })

  const planner = (request: LlmRequest): boolean => request.prompt.includes('责任编辑')
  const models = (): (string | undefined)[] => bed.llm.requests.map(request => request.route?.model)
  const waiting = async () => (await bed.runtime.project.proposals()).filter(item => item.status === 'pending').sort((left, right) => left.chapterId.localeCompare(right.chapterId))

  it('is what holds where nothing is set', async () => {
    expect(mendsBy(bed.core)).toBe('auto')
    expect(mendsBy(bed.core, undefined, await bed.runtime.project.manifest())).toBe('auto')
  })

  it('has the planner write a small change itself and hand a passage to the writer\'s model: one call of the writer, for the one place', async () => {
    const { core, runtime, llm } = bed
    llm.responder = request => planner(request)
      ? JSON.stringify({ edits: [
        { chapter: 1, find: '柳先生摘下眼镜，放在柜台上。', replace: '柳先生摘下老花镜，放在柜台上。', why: '统一叫老花镜' },
        { chapter: 3, find: '她等了一夜。', how: '写成一小段：她等到天亮，船还是没有来' },
      ], chapters: [], note: '两处。' })
      : '她等到天亮。\n\n船还是没有来。'
    const result = await reviseBook(core, runtime, { instruction: '眼镜统一叫老花镜；渡口那一夜写足', asked: true }, task)

    // The planner once, the writer once — for the place where a passage was to be written, and no other.
    expect(models()).toEqual(['crew-model', 'writer-model'])
    expect(result.results.map(item => [item.index, item.kind, item.who])).toEqual([[1, 'span', 'planner'], [3, 'span', 'writer']])
    // Whose words they are is said with the result; "all the planner's own" is not.
    expect(result.wrote).toEqual({ planner: 1, writer: 1 })
    expect(result.direct).toBeUndefined()
    // What the planner was told: the two ways to hand a place in, which is for what, and how the book is written.
    const asked = llm.requests[0]!.prompt
    for (const part of [
      '小改动你直接把改好的文字写出来（你写的就是提案），要成段新写的说清怎么改、交给写手',
      '小改动——换一个词、改一个名字或数字、删半句、调一下语序、补一两句交代——你直接写',
      '要成段新写或重写的——一段叙述、一场对白、一个场面——交给写手的模型，你不写 replace',
      '分界在要新落多少笔：改完之后新写的不过一两句、几十个字，你直接写；要新写一整段、一场对白，上百字的，交给写手',
      '改几个字就能了结的不交给它',
      '一处只给 replace 和 how 当中的一个',
      '"replace": "小改动：这一处改好之后的全文"',
      '"how": "要成段新写的：这一处改成什么样（具体到位），交给写手"',
      // (How the book is written is in its base, at the head of the task: what the planner writes itself is written so.)
      '## 设定的文风：',
      '照这本书的文风写（见上）',
    ]) expect(asked, part).toContain(part)
    // The writer was told what the planner settled for its place.
    expect(llm.requests[1]!.prompt).toContain('写成一小段：她等到天亮，船还是没有来')
    // Two proposals: the planner's own words as it wrote them, and the writer's.
    const [first, second] = await waiting()
    expect([first!.chapterId, first!.before, first!.after]).toEqual([ids.one, '柳先生摘下眼镜，放在柜台上。', '柳先生摘下老花镜，放在柜台上。'])
    expect([second!.chapterId, second!.before, second!.after]).toEqual([ids.three, '她等了一夜。', '她等到天亮。\n\n船还是没有来。'])
    // Each says whose words it is: shown on its card.
    expect([first!.wroteBy, second!.wroteBy]).toEqual(['planner', 'writer'])
  })

  it('calls the writer not at all where every place is a small change, and for every place where the author has it so', async () => {
    const { core, runtime, llm } = bed
    const small = JSON.stringify({ edits: [{ chapter: 1, find: '他说话很慢。', replace: '他说话很快。', why: '照要求' }, { chapter: 3, find: '她等了一夜。', replace: '她等了两夜。', why: '照要求' }], chapters: [], note: '两处。' })
    llm.responder = request => planner(request) ? small : '不该问到写手'
    const own = await reviseBook(core, runtime, { instruction: '他说话快；等的是两夜', asked: true }, task)
    expect(models()).toEqual(['crew-model'])
    expect(own.wrote).toEqual({ planner: 2, writer: 0 })

    // The writer always (`writer`): what the planner hands in as its own words is not taken — every place is the writer's.
    await core.settings.update({ mendBy: 'writer' })
    llm.requests.length = 0
    llm.responder = request => planner(request)
      ? JSON.stringify({ edits: [{ chapter: 1, find: '他说话很慢。', how: '改成很快' }, { chapter: 3, find: '她等了一夜。', how: '改成两夜' }], chapters: [], note: '两处。' })
      : request.prompt.includes('改成很快') ? '他说话很快。' : '她等了两夜。'
    const theirs = await reviseBook(core, runtime, { instruction: '他说话快；等的是两夜', asked: true }, task)
    expect(models()).toEqual(['crew-model', 'writer-model', 'writer-model'])
    expect(theirs.wrote).toEqual({ planner: 0, writer: 2 })
    expect(llm.requests[0]!.prompt).not.toContain('小改动——换一个词')
    // The planner always (`planner`): every place its own, said as before.
    await core.settings.update({ mendBy: 'planner' })
    llm.requests.length = 0
    llm.responder = request => planner(request) ? small : '不该问到写手'
    const direct = await reviseBook(core, runtime, { instruction: '他说话快；等的是两夜', asked: true }, task)
    expect(models()).toEqual(['crew-model'])
    expect(direct).toMatchObject({ direct: true, wrote: { planner: 2, writer: 0 } })
    // …and said for one piece of work, whatever is set.
    llm.requests.length = 0
    expect((await reviseBook(core, runtime, { instruction: '他说话快；等的是两夜', asked: true, by: 'auto' }, task)).direct).toBeUndefined()
    expect(llm.requests[0]!.prompt).toContain('小改动——换一个词')
  })

  it('sends back a place that says neither what it is to read nor how it changes', async () => {
    const { core, runtime, llm } = bed
    let asked = 0
    llm.responder = (request) => {
      if (!planner(request)) return '不该问到写手'
      asked += 1
      return asked === 1
        ? JSON.stringify({ edits: [{ chapter: 1, find: '他说话很慢。' }], chapters: [], note: '一处。' })
        : JSON.stringify({ edits: [{ chapter: 1, find: '他说话很慢。', replace: '他说话很快。', why: '照要求' }], chapters: [], note: '一处。' })
    }
    const result = await reviseBook(core, runtime, { instruction: '他说话快', asked: true }, task)
    const planners = llm.requests.filter(planner)
    expect(planners).toHaveLength(2)
    expect(planners[1]!.prompt).toContain('edits 第 1 条：find（这一处的原文）要写，再给 replace（小改动：你直接写出这一处改好之后的全文）或 how（要成段新写的：说清改成什么样，交给写手）当中的一个')
    expect(result.wrote).toEqual({ planner: 1, writer: 0 })
  })

  it('mends an issue at its quote through the planner too: a word put right costs no call of the writer', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    await project.saveReview({ chapterId: ids.three, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'low', type: 'timeline', quote: '她等了一夜。', explanation: '前一章说等了两夜。' }] })
    llm.responder = request => planner(request) ? JSON.stringify({ edits: [{ chapter: 3, find: '她等了一夜。', replace: '她等了两夜。', why: '和前一章对上' }], chapters: [], note: '一处。' }) : '不该问到写手'
    const mended = await fixIssue(core, runtime, { chapter: ids.three, issue: 'i1', scope: 'passage' }, task)
    // One call, the planner's: with this chapter before it, and nothing else to change.
    expect(models()).toEqual(['crew-model'])
    // (In one request, with no tools: nothing of the task speaks of reading further.)
    expect(llm.requests[0]!.prompt).not.toContain('用你的工具')
    expect(mended.scope).toBe('places')
    expect(mended.book?.wrote).toEqual({ planner: 1, writer: 0 })
    const asked = llm.requests[0]!.prompt
    for (const part of ['原文："她等了一夜。"', '### 第 3 章《渡口》\n\n渡口没有人。', '作者只让动这几章', '这几章的正文都在上面', '小改动——换一个词']) expect(asked, part).toContain(part)
    expect(asked).not.toContain('柳先生')
    // The change waits beneath the issue it is for.
    const [proposal] = await waiting()
    expect([proposal!.before, proposal!.after, proposal!.issues]).toEqual(['她等了一夜。', '她等了两夜。', ['i1']])
    expect((await project.review(ids.three))!.issues[0]!.mending).toBe(mended.book!.batchId)

    // Where mending it takes a passage, the planner says how and the writer's model writes it.
    await project.saveReview({ chapterId: ids.one, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i2', severity: 'medium', type: 'pacing', quote: '他说话很慢。', explanation: '柳先生出场太干，少一段他怎么看人。' }] })
    llm.requests.length = 0
    llm.responder = request => planner(request) ? JSON.stringify({ edits: [{ chapter: 1, find: '他说话很慢。', how: '写成一小段：他说话慢，看人更慢，先看手再看脸' }], chapters: [], note: '一处。' }) : '他说话很慢，看人更慢。\n\n先看手，再看脸。'
    const longer = await fixIssue(core, runtime, { chapter: ids.one, issue: 'i2', scope: 'passage' }, task)
    expect(models()).toEqual(['crew-model', 'writer-model'])
    expect(longer.book?.wrote).toEqual({ planner: 0, writer: 1 })

    // The author has one model or the other write every place: mended at the quote outright, by that model.
    for (const [by, model] of [['planner', 'crew-model'], ['writer', 'writer-model']] as const) {
      await core.settings.update({ mendBy: by })
      await project.saveReview({ chapterId: ids.two, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: `i-${by}`, severity: 'low', type: 'style', quote: '窗外有雨。', explanation: '太平。' }] })
      llm.requests.length = 0
      llm.responder = () => '窗外落着雨。'
      const quoted = await fixIssue(core, runtime, { chapter: ids.two, issue: `i-${by}`, scope: 'passage' }, task)
      expect(quoted.scope).toBe('passage')
      expect(models()).toEqual([model])
    }
  })

  it('goes by the book\'s own way where it has one, and goes through a chapter as the planner', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    // The Studio has the planner judge; this book has the writer write every place.
    await project.updateManifest({ mendBy: 'writer' })
    expect(mendsBy(core, undefined, await project.manifest())).toBe('writer')
    await project.saveReview({ chapterId: ids.three, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'i1', severity: 'low', type: 'style', quote: '她等了一夜。', explanation: '太平。' }] })
    llm.responder = () => '她等到天亮。'
    expect((await fixIssue(core, runtime, { chapter: ids.three, issue: 'i1', scope: 'passage' }, task)).scope).toBe('passage')
    expect(models()).toEqual(['writer-model'])
    // Taken off the book, the planner judges again — and a chapter gone through to an instruction is its own work.
    await project.updateManifest({ mendBy: null as never })
    llm.requests.length = 0
    llm.responder = request => request.prompt.includes('改动清单') ? JSON.stringify({ edits: [{ find: '渡口没有人。', replace: '渡口空着。' }], note: '一处。' }) : '不该问到写手'
    expect(await amendChapter(core, runtime, { chapter: ids.three, instruction: '开头换个说法' }, task)).toMatchObject({ who: 'planner', places: 1 })
    expect(models()).toEqual(['crew-model'])
  })
})

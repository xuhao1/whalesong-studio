// SPDX-License-Identifier: LGPL-3.0-or-later
// A chapter gone through to one instruction: changed where it stands, a place at a time — never written again.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { amendChapter } from '../src/core/pipelines/amend'
import { acceptProposal } from '../src/core/pipelines/revise'
import type { TaskContext } from '../src/core/core'
import { createTestBed, type TestBed } from './support/harness'

const TEXT = [
  '雨下了一夜。沈蘅坐在柜台后，把三张底稿又数了一遍。',
  '![柜台上的底稿](assets/images/desk.png)',
  '门响了。阿棠站在门口，头发滴着水。她说：好。',
  '沈蘅没有抬头。灯芯跳了一下。她说：好。',
  '天亮的时候，雨停了。',
].join('\n\n')

describe('a chapter revised in place', () => {
  let bed: TestBed
  let chapterId: string
  const task: TaskContext = { origin: 'user' }

  beforeEach(async () => {
    bed = await createTestBed({ title: '七日未寄' })
    const chapter = await bed.runtime.project.addChapter({ title: '雨夜', synopsis: '阿棠冒雨送来消息。' })
    chapterId = chapter.id
    await bed.runtime.project.saveChapterText(chapterId, TEXT)
  })
  afterEach(async () => { await bed.cleanup() })

  const waiting = async () => (await bed.runtime.project.proposals()).filter(proposal => proposal.status === 'pending')
  const text = async () => await bed.runtime.project.chapterText(chapterId)

  it('has the writer change it place by place as an agent, and proposes each place by itself', async () => {
    bed.roles.enabled = true
    const answers: string[] = []
    bed.roles.script = async (agent, call) => {
      // The writer, on the writer's own tools and the book's: nothing of the conversation's.
      expect(agent.role).toBe('writer')
      expect(agent.inherit).toEqual({ mode: 'none' })
      expect(agent.tools.map(tool => tool.name)).toEqual(['book_read', 'book_search', 'chapter_read', 'chapter_edit', 'submit_revision'])
      expect(agent.prompt).toContain('把阿棠写得更慌')
      expect(agent.prompt).toContain('本章已有正文')
      expect(agent.prompt).toContain('雨下了一夜。')
      expect(agent.rules).toContain('chapter_edit')
      // A passage that is not in the text is not changed: the writer is told, and copies it rightly.
      answers.push(await call('chapter_edit', { find: '阿棠站在门外，头发滴着水。', replace: '阿棠扶着门框，喘得说不出话。' }))
      answers.push(await call('chapter_edit', { find: '阿棠站在门口，头发滴着水。', replace: '阿棠扶着门框，喘得说不出话。', why: '让她一进门就慌' }))
      // A sentence that stands twice has to be told apart by what is beside it.
      answers.push(await call('chapter_edit', { find: '她说：好。', replace: '她说：出事了。' }))
      answers.push(await call('chapter_edit', { find: '喘得说不出话。她说：好。', replace: '喘得说不出话。她说：出事了。', why: '她带来的是坏消息' }))
      // What is changed is what the chapter now reads.
      answers.push(await call('chapter_read', { around: '她说：出事了。' }))
      // A sentence added after one, a sentence taken out.
      answers.push(await call('chapter_edit', { find: '天亮的时候，雨停了。', replace: '天亮的时候，雨停了。阿棠还攥着那团报纸。', why: '收在她身上' }))
      answers.push(await call('chapter_edit', { find: '灯芯跳了一下。', replace: '' }))
      await call('submit_revision', { note: '改了四处：进门、她的话、灯芯一句删掉、结尾。' })
    }
    const result = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '把阿棠写得更慌' }, task)

    expect(answers[0]).toMatch(/^ERROR: .*找不到这一段/)
    expect(answers[1]).toContain('改好了')
    expect(answers[1]).toContain('阿棠扶着门框，喘得说不出话。')
    expect(answers[2]).toMatch(/^ERROR: .*出现了 2 次/)
    expect(answers[3]).toContain('她说：出事了。')
    expect(answers[4]).toContain('阿棠扶着门框，喘得说不出话。她说：出事了。')
    expect(answers[6]).toContain('删掉了')
    // No model was asked for a chapter: the agent's calls are all there was.
    expect(bed.llm.requests).toHaveLength(0)

    expect(result).toMatchObject({ by: 'agent', applied: false, places: 3, note: '改了四处：进门、她的话、灯芯一句删掉、结尾。' })
    // The chapter itself is as it was; what changed waits, a proposal a place, as one round.
    expect(await text()).toBe(TEXT)
    const proposals = await waiting()
    expect(proposals.map(proposal => proposal.kind)).toEqual(['span', 'span', 'span'])
    expect(new Set(proposals.map(proposal => proposal.batchId))).toEqual(new Set([result.batchId]))
    expect(proposals.map(proposal => [proposal.before, proposal.after])).toEqual([
      ['阿棠站在门口，头发滴着水。她说：好。', '阿棠扶着门框，喘得说不出话。她说：出事了。'],
      ['沈蘅没有抬头。灯芯跳了一下。', '沈蘅没有抬头。'],
      ['天亮的时候，雨停了。', '天亮的时候，雨停了。阿棠还攥着那团报纸。'],
    ])
    // Each stands where the text has it, and says why.
    for (const proposal of proposals) expect(TEXT.slice(proposal.at!, proposal.at! + proposal.before.length)).toBe(proposal.before)
    expect(proposals[0]!.rationale).toBe('让她一进门就慌；她带来的是坏消息')
    expect(proposals[2]!.rationale).toBe('收在她身上')
    expect(proposals.every(proposal => proposal.instruction === '把阿棠写得更慌')).toBe(true)

    // Taken one by one, in any order, they make the chapter the writer left.
    for (const proposal of [...proposals].reverse()) await acceptProposal(bed.core, bed.runtime, proposal.id, task)
    expect(await text()).toBe([
      '雨下了一夜。沈蘅坐在柜台后，把三张底稿又数了一遍。',
      '![柜台上的底稿](assets/images/desk.png)',
      '门响了。阿棠扶着门框，喘得说不出话。她说：出事了。',
      '沈蘅没有抬头。她说：好。',
      '天亮的时候，雨停了。阿棠还攥着那团报纸。',
    ].join('\n\n'))
  })

  it('keeps the pictures of the text, changes a word throughout, and will not take most of the chapter as one place', async () => {
    bed.roles.enabled = true
    const answers: string[] = []
    await bed.runtime.project.saveChapterText(chapterId, `${TEXT}\n\n${'沈蘅想起很多年前的事。'.repeat(60)}`)
    const long = await text()
    bed.roles.script = async (_agent, call) => {
      // A name changed throughout — not in a picture's own line, though the path could hold it.
      answers.push(await call('chapter_edit', { find: '底稿', replace: '讣文', all: true }))
      answers.push(await call('chapter_edit', { find: '没有这个词', replace: '别的', all: true }))
      // The sentences around a picture rewritten, the picture left out by the writer: it stays where it stood.
      answers.push(await call('chapter_edit', { find: '把三张讣文又数了一遍。\n\n![柜台上的底稿](assets/images/desk.png)\n\n门响了。', replace: '把三张讣文压在镇纸下。\n\n有人敲门。' }))
      // Most of the chapter in one `find` is the other kind of revision.
      answers.push(await call('chapter_edit', { find: long.slice(long.indexOf('阿棠站在门口')), replace: '全都重写。' }))
      answers.push(await call('chapter_edit', { find: '有人敲门。', replace: '有人敲门。\n\n![新画的](assets/images/made-up.png)' }))
      await call('submit_revision', { note: '底稿改叫讣文。' })
    }
    const result = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '底稿都改叫讣文', apply: true }, task)
    // (The word stands once in the prose; where it stands under the picture, it is the picture's own and stays.)
    expect(answers[0]).toContain('换了 1 处')
    expect(answers[1]).toMatch(/^ERROR: .*没有/)
    expect(answers[2]).toContain('1 张图留在原处')
    expect(answers[3]).toMatch(/^ERROR: .*圈了大半章/)
    // A picture of the writer's own making is not put into the text.
    expect(answers[4]).toMatch(/^ERROR: .*不要添图/)
    // Applied: written into the text at once, with the picture where it stood and its line untouched.
    expect(result).toMatchObject({ applied: true, by: 'agent', proposalIds: [] })
    expect(result.figures).toEqual({ back: 1, made: 0 })
    const now = await text()
    expect(now).toContain('把三张讣文压在镇纸下。\n\n![柜台上的底稿](assets/images/desk.png)\n\n有人敲门。')
    expect(now).not.toContain('made-up')
    expect(await waiting()).toHaveLength(0)
    expect((await bed.runtime.project.versions(chapterId)).some(version => version.reason === 'before-revise')).toBe(true)
  })

  it('takes several places in one call, makes the ones it can and says which it could not', async () => {
    bed.roles.enabled = true
    const answers: string[] = []
    bed.roles.script = async (_agent, call) => {
      answers.push(await call('chapter_edit', { edits: [
        { find: '雨下了一夜。', replace: '雨下了两夜。', why: '时间拉长' },
        { find: '她说：好。', replace: '她说：不好。' },
        { find: '灯芯跳了一下。', replace: '' },
      ] }))
      // The one that was refused, mended — as a list written out, the way some models send one.
      answers.push(await call('chapter_edit', { edits: JSON.stringify([{ find: '头发滴着水。她说：好。', replace: '头发滴着水。她说：不好。' }]) }))
      answers.push(await call('chapter_edit', { edits: [{ find: '没有的一句。', replace: '还是没有。' }] }))
      await call('submit_revision', { note: '三处。' })
    }
    const result = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '雨下两夜，阿棠说不好' }, task)
    expect(answers[0]).toContain('1. 改好了')
    expect(answers[0]).toMatch(/2\. ✗ .*出现了 2 次/)
    expect(answers[0]).toContain('3. 删掉了')
    expect(answers[0]).toContain('2 处改好了，1 处没改成')
    expect(answers[1]).toContain('1 处都改好了')
    expect(answers[2]).toMatch(/^ERROR: 这几条都没改成/)
    expect(result).toMatchObject({ by: 'agent', places: 3, steps: 4 })
    expect((await waiting()).map(proposal => [proposal.before, proposal.after])).toEqual([
      ['雨下了一夜。', '雨下了两夜。'],
      ['阿棠站在门口，头发滴着水。她说：好。', '阿棠站在门口，头发滴着水。她说：不好。'],
      ['沈蘅没有抬头。灯芯跳了一下。', '沈蘅没有抬头。'],
    ])
  })

  it('proposes nothing where the writer changed nothing, and says what the writer said', async () => {
    bed.roles.enabled = true
    bed.roles.script = async (_agent, call) => { await call('submit_revision', { note: '这一章已经是这样写的，不用改。' }) }
    const result = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '让雨一直下到天亮' }, task)
    expect(result).toMatchObject({ places: 0, proposalIds: [], note: '这一章已经是这样写的，不用改。', by: 'agent' })
    expect(await waiting()).toHaveLength(0)
    expect(await text()).toBe(TEXT)
  })

  it('keeps what an agent changed before it broke off, and asks in one request where it changed nothing', async () => {
    bed.roles.enabled = true
    bed.roles.script = async (_agent, call) => {
      await call('chapter_edit', { find: '天亮的时候，雨停了。', replace: '天亮的时候，雨还在下。' })
      throw new Error('the provider dropped the connection')
    }
    const kept = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '让雨一直下到天亮' }, task)
    expect(kept).toMatchObject({ by: 'agent', places: 1 })
    expect(kept.note).toContain('中途断了')
    expect((await waiting()).map(proposal => proposal.after)).toEqual(['天亮的时候，雨还在下。'])
    expect(bed.llm.requests).toHaveLength(0)

    // Nothing changed, nothing handed in: the same work asked the plain way.
    bed.roles.script = async () => { throw new Error('the provider refused the tools') }
    bed.llm.responder = () => JSON.stringify({ edits: [{ find: '雨下了一夜。', replace: '雨下了两夜。', why: '时间拉长' }], note: '只改了开头。' })
    const asked = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '雨下了两夜' }, task)
    expect(asked).toMatchObject({ by: 'call', places: 1, note: '只改了开头。' })
    expect(asked.fellBack).toContain('the provider refused the tools')
    expect(bed.llm.requests).toHaveLength(1)
  })

  it('asks a writer that cannot run as an agent for a list of places, and says back what cannot be made', async () => {
    const replies = [
      JSON.stringify({ edits: [
        { find: '门响了。', replace: '门被拍响了。', why: '更急' },
        { find: '阿棠站在门外。', replace: '阿棠站在雨里。' },
        { find: '她说：好。', replace: '她说：坏了。' },
      ], note: '三处。' }),
      JSON.stringify({ edits: [
        { find: '门响了。', replace: '门被拍响了。', why: '更急' },
        { find: '头发滴着水。她说：好。', replace: '头发滴着水。她说：坏了。', why: '坏消息' },
        { find: '压根没有的一句。', replace: '还是没有。' },
      ], note: '两处，第三处作罢。' }),
    ]
    bed.llm.responder = () => replies.shift() ?? '{"edits": [], "note": ""}'
    const result = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '把阿棠写得更慌' }, task)

    expect(bed.roles.tasks).toHaveLength(0)
    expect(bed.llm.requests).toHaveLength(2)
    const [first, second] = bed.llm.requests
    // One request: the chapter, the instruction — and a list asked for, not the chapter.
    expect(first!.system).toContain('改动清单')
    expect(first!.prompt).toContain('把阿棠写得更慌')
    expect(first!.prompt).toContain('雨下了一夜。')
    // What could not be made is said back, entry by entry, with why.
    expect(second!.prompt).toContain('有 2 条照做不了')
    expect(second!.prompt).toContain('第 2 条（“阿棠站在门外。”）')
    expect(second!.prompt).toContain('出现了 2 次')

    expect(result).toMatchObject({ by: 'call', places: 2, note: '两处，第三处作罢。' })
    expect(result.fellBack).toContain('当不了 agent')
    expect(result.refused).toHaveLength(1)
    expect(result.refused![0]).toContain('压根没有的一句。')
    // Two places with an untouched sentence between them: a proposal each, with its own reason — and the second takes
    // in the sentence before it, since "她说：好。" alone stands twice in the chapter.
    const proposals = await waiting()
    expect(proposals.map(proposal => [proposal.before, proposal.after, proposal.rationale])).toEqual([
      ['门响了。', '门被拍响了。', '更急'],
      ['阿棠站在门口，头发滴着水。她说：好。', '阿棠站在门口，头发滴着水。她说：坏了。', '坏消息'],
    ])
    expect(await text()).toBe(TEXT)
  })

  it('goes on from changes that wait: places of its own where they stand in the book, one proposal where they do not', async () => {
    const project = bed.runtime.project
    const earlier = await project.addProposal({ chapterId, kind: 'span', instruction: '早先的', before: '天亮的时候，雨停了。', after: '天亮的时候，雨小了。', createdBy: 'user' })
    bed.roles.enabled = true
    // A place the waiting change did not write: a proposal of its own, and the earlier one still waits by itself.
    bed.roles.script = async (agent, call) => {
      expect(agent.prompt).toContain('天亮的时候，雨小了。')
      await call('chapter_edit', { find: '雨下了一夜。', replace: '雨下了两夜。' })
      await call('submit_revision', { note: '开头。' })
    }
    const apart = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '雨下两夜', onto: true }, task)
    expect(apart.whole).toBeUndefined()
    expect((await waiting()).map(proposal => proposal.id)).toEqual([earlier.id, apart.proposalIds[0]])

    // A place the waiting change wrote: one proposal for the chapter, with that change and this one in it.
    bed.roles.script = async (_agent, call) => {
      await call('chapter_edit', { find: '天亮的时候，雨小了。', replace: '天亮的时候，雨小了，巷子里有人走动。' })
      await call('submit_revision', { note: '接着雨小了往下写。' })
    }
    const onTop = await amendChapter(bed.core, bed.runtime, { chapter: chapterId, instruction: '结尾加人声', onto: true }, task)
    expect(onTop.whole).toBe(true)
    const left = await waiting()
    const whole = left.find(proposal => proposal.id === onTop.proposalIds[0])!
    expect(whole.kind).toBe('chapter')
    expect(whole.before).toBe(TEXT)
    expect(whole.after).toContain('雨下了两夜。')
    expect(whole.after).toContain('天亮的时候，雨小了，巷子里有人走动。')
    expect(whole.supersedes).toEqual(expect.arrayContaining([earlier.id, apart.proposalIds[0]]))
    expect(left.map(proposal => proposal.id)).toEqual([whole.id])
  })
})

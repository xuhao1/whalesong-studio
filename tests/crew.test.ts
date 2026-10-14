// SPDX-License-Identifier: LGPL-3.0-or-later
/** The crew: work handed to a role as an agent, what it sees, and what happens when it cannot be one. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assign, bookTools, CREW, crewPlan, crewRules, crewSkills, delegate, openToRoles, stepLine } from '../src/core/crew'
import { LlmCallError } from '../src/core/llm'
import { digestChapter } from '../src/core/pipelines/digest'
import { reviewChapter } from '../src/core/pipelines/review'
import { CREW_ROLES } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

const TEXT = '雨下了一夜。沈蘅把最后一封信折好，压在砚台下面。\n\n“这封不寄。”她说，“等他自己来取。”\n\n阿棠没有应声，只把门闩又推紧了一格。'

async function withChapter(bed: TestBed): Promise<string> {
  const { project } = bed.runtime
  const plan = await project.addChapter({ title: '不寄的信' })
  await project.saveChapterText(plan.id, TEXT)
  await project.saveCharacter({ name: '沈蘅', role: 'protagonist', tagline: '代笔人' })
  return plan.id
}

describe('the crew', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  it('names four roles, each with a persona and rules of its own', () => {
    expect([...CREW_ROLES]).toEqual(['analyst', 'architect', 'director', 'producer'])
    for (const role of CREW_ROLES) {
      expect(CREW[role].persona[0].length).toBeGreaterThan(40)
      expect(CREW[role].persona[1].length).toBeGreaterThan(40)
      const rules = crewRules(role, 'zh', { title: '《七日未寄》' })
      // The title is put in the prompt's own marks, never doubled.
      expect(rules).toContain('为《七日未寄》这本书工作')
      expect(rules).toContain('book_read')
    }
    // What a role's work calls for beyond the Studio's tools is part of the role.
    expect(CREW.architect.tools).toContain('web_search')
    expect(CREW.producer.tools).toEqual(expect.arrayContaining(['bash', 'write', 'skill', 'subagent_claude_code']))
    expect(CREW.analyst.tools).toEqual([])
    expect(crewRules('architect', 'en', { title: 'Seven Days' })).toContain('novel-trend-research')
  })

  it('gives a role its own tools by default, and everything but the showrunner\'s when the author opens them', async () => {
    const own = crewPlan(bed.core, 'architect')
    expect(own).toMatchObject({ mode: 'agent', steps: 40, open: false })
    expect(own.inherit).toEqual({ mode: 'named', names: CREW.architect.tools })

    await bed.core.settings.update({ crew: { architect: { tools: 'all', steps: 12 }, director: { mode: 'call' } } })
    await bed.core.ready()
    const open = crewPlan(bed.core, 'architect')
    expect(open).toMatchObject({ mode: 'agent', steps: 12, open: true })
    expect(open.inherit.mode).toBe('all')
    const except = open.inherit.mode === 'all' ? open.inherit.except! : () => false
    // The showrunner's own tools, and the ones that need a person in the room, are never a role's.
    for (const name of ['novel_write', 'novel_crew', 'ask_user_question', 'subagent', 'update_goal']) expect(except(name)).toBe(true)
    for (const name of ['bash', 'web_search', 'read', 'skill', 'subagent_claude_code']) expect(except(name)).toBe(false)
    expect(openToRoles('novel_edit')).toBe(false)
    expect(crewPlan(bed.core, 'director').mode).toBe('call')
  })

  it('hands work to a role as an agent: it reads the book, hands in, and is told what is wrong with what it hands in', async () => {
    await withChapter(bed)
    bed.roles.enabled = true
    const seen: string[] = []
    bed.roles.script = async (task, call) => {
      expect(task.role).toBe('analyst')
      expect(task.label).toBe('场记 · 核对一处')
      expect(task.persona).toContain('场记')
      expect(task.rules).toContain('这是一次委派')
      // The task says how to hand in, after whatever it said about the answer's shape.
      expect(task.prompt).toMatch(/只输出 JSON。\n\n---\n交回方式：.*调用 submit_note/s)
      expect(task.tools.map(tool => tool.name)).toEqual(['book_read', 'book_search', 'book_find', 'submit_note'])
      expect(task.inherit).toEqual({ mode: 'named', names: [] })
      seen.push(await call('book_read', { what: 'character' }))
      seen.push(await call('book_read', { what: 'chapter', ref: '1', limit: 400 }))
      seen.push(await call('book_read', { what: 'nonsense' }))
      // A result that fails the check comes back as the tool's failure; the next one passes.
      seen.push(await call('submit_note', { result: { note: '' } }))
      seen.push(await call('submit_note', { result: '{"note": "信压在砚台下面，没有寄出。"}' }))
      return ''
    }
    const { done } = bed.core.jobs.start({ kind: 'review', title: 'review', project: bed.runtime.project.root, origin: 'user' }, async job => await assign<{ note: string }>(bed.core, bed.runtime, { origin: 'user', job, signal: job.signal }, {
      role: 'analyst',
      label: '核对一处',
      tool: 'submit_note',
      what: '一句话的结论',
      prompt: '这封信最后在哪里？只输出 JSON。',
      validate: (raw) => {
        const note = (raw as { note?: string }).note
        if (typeof note !== 'string' || note.length === 0) throw new Error('"note" is empty')
        return { note }
      },
    }))
    const result = await done
    expect(result.value).toEqual({ note: '信压在砚台下面，没有寄出。' })
    expect(result.run).toMatchObject({ role: 'analyst', label: '核对一处', by: 'agent', steps: 5 })
    expect(seen[0]).toContain('沈蘅')
    expect(seen[1]).toContain('压在砚台下面')
    expect(seen[2]).toMatch(/^ERROR: .*`what` is one of/)
    expect(seen[3]).toBe('ERROR: "note" is empty')
    expect(seen[4]).toBe('收到，已通过检查。')
    // The job carries who worked in it, and every step for whoever watches.
    const info = bed.core.jobs.list()[0]!
    expect(info.crew).toEqual([result.run])
    const log = bed.core.jobs.read(info.id)!.text
    expect(log).toContain('› book_read chapter 1 — Chapter 1 "不寄的信"')
    expect(log).toContain('› submit_note — ✗ "note" is empty')
    // No request was made on the role's behalf outside the agent.
    expect(bed.llm.requests).toHaveLength(0)
  })

  it('asks in one plain call when a role cannot be an agent, or is set not to be, and says which', async () => {
    await withChapter(bed)
    bed.llm.responder = () => '{"note": "没有寄出。"}'
    const work = { role: 'analyst' as const, label: '核对一处', tool: 'submit_note', what: '结论', system: '你是场记。', prompt: '这封信最后在哪里？只输出 JSON。' }
    // No agent loop here (the fake runner is off, the way a directly called endpoint is).
    const plain = await assign(bed.core, bed.runtime, { origin: 'user' }, work)
    expect(plain.value).toEqual({ note: '没有寄出。' })
    expect(plain.run.by).toBe('call')
    expect(plain.run.note).toContain('直连的接口')
    // The single call is the task as it was written: no word about tools.
    expect(bed.llm.requests[0]!.prompt).toBe(work.prompt)
    expect(bed.llm.requests[0]!.system).toBe('你是场记。')

    // Set to plain calls by the author: no agent even where one could run, and nothing to explain.
    bed.roles.enabled = true
    await bed.core.settings.update({ crew: { analyst: { mode: 'call' } } })
    await bed.core.ready()
    const chosen = await assign(bed.core, bed.runtime, { origin: 'user' }, work)
    expect(chosen.run).toEqual({ role: 'analyst', label: '核对一处', by: 'call' })
    expect(bed.roles.tasks).toHaveLength(0)
  })

  it('falls back on a plain call when the agent hands nothing in, and takes a result that came in the reply', async () => {
    await withChapter(bed)
    bed.roles.enabled = true
    bed.llm.responder = () => '{"note": "来自普通调用。"}'
    const work = { role: 'analyst' as const, label: '核对一处', tool: 'submit_note', what: '结论', prompt: '这封信最后在哪里？只输出 JSON。' }

    // It was nudged (the runner asks `unfinished`), said something that is no result, and stopped.
    let nudge: string | undefined
    bed.roles.script = async (task, call) => {
      await call('book_search', { query: '信' })
      nudge = task.unfinished?.()
      return '我看过了。'
    }
    const fell = await assign(bed.core, bed.runtime, { origin: 'user' }, work)
    expect(nudge).toContain('调用 submit_note 提交结果')
    expect(fell.value).toEqual({ note: '来自普通调用。' })
    expect(fell.run.by).toBe('call')
    expect(fell.run.note).toMatch(/场记的 agent 没有交回结果（completed，1 步）.*我看过了/)

    // A model that wrote its result in the reply did the work all the same.
    bed.roles.script = async () => '```json\n{"note": "写在回答里。"}\n```'
    const inReply = await assign(bed.core, bed.runtime, { origin: 'user' }, work)
    expect(inReply.value).toEqual({ note: '写在回答里。' })
    expect(inReply.run).toMatchObject({ by: 'agent', note: '结果是写在回答里的，没有通过交回工具。' })

    // An agent that cannot run at all leaves the work to the plain call, with the reason.
    bed.roles.script = async () => { throw new LlmCallError('the provider refused the tools', 'SERVER') }
    const broke = await assign(bed.core, bed.runtime, { origin: 'user' }, work)
    expect(broke.run.by).toBe('call')
    expect(broke.run.note).toContain('the provider refused the tools')
  })

  it('gives a role a task in words and returns its report — or says why it cannot', async () => {
    await withChapter(bed)
    await expect(delegate(bed.core, bed.runtime, { origin: 'agent' }, { role: 'architect', task: '查一查民国上海的邮政。' })).rejects.toMatchObject({ code: 'NO_AGENT_LOOP' })

    bed.roles.enabled = true
    bed.roles.script = async (task, call) => {
      expect(task.role).toBe('architect')
      expect(task.label).toBe('策划 · 查一查民国上海的邮政。')
      expect(task.inherit).toEqual({ mode: 'named', names: ['web_search', 'web_fetch', 'skill'] })
      // A task in words has no tool to hand in with: the report is the last reply.
      expect(task.rules).toContain('把结果写成你的最后一段回答')
      expect(task.tools.map(tool => tool.name)).toEqual(['book_read', 'book_search', 'book_find'])
      // The role's skill travels with it, and is its alone.
      expect(task.skills?.map(skill => skill.name)).toEqual(['novel-trend-research'])
      await call('book_read', { what: 'outline' })
      return '两个桥段：……'
    }
    const done = await delegate(bed.core, bed.runtime, { origin: 'agent' }, { role: 'architect', task: '查一查民国上海的邮政。' })
    expect(done).toMatchObject({ report: '两个桥段：……', stop: 'completed', run: { role: 'architect', by: 'agent', steps: 1 } })
  })

  it('ships each role\'s skills with the package', async () => {
    const producer = await crewSkills('producer')
    expect(producer.map(skill => skill.name)).toEqual(['novel-video-editing'])
    expect(producer[0]!.description).toMatch(/^Use before cutting/)
    expect(producer[0]!.content).toContain('cut-base.sh')
    expect(producer[0]!.content).not.toMatch(/^---/)
    expect(producer[0]!.base).toMatch(/crew\/producer\/skills\/novel-video-editing$/)
    expect(await crewSkills('analyst')).toEqual([])
  })

  it('reads the book for a role the way the showrunner reads it', async () => {
    const id = await withChapter(bed)
    const [read, search] = bookTools(bed.runtime)
    expect(await read!.run({ what: 'outline' })).toContain(`1. 不寄的信 [${id}; `)
    expect(await read!.run({ what: 'character', ref: '沈蘅' })).toContain('代笔人')
    // What is missing is said in the role's own tool names.
    expect(await read!.run({ what: 'memory', ref: '1' })).toBe('Chapter 1 has no memory yet.')
    await expect(Promise.resolve().then(() => read!.run({ what: 'chapter', ref: '9' }))).rejects.toThrow(/book_read what=outline lists the chapters/)
    await bed.runtime.index.refresh()
    expect(await search!.run({ query: '砚台', sources: 'manuscript' })).toContain('压在砚台下面')
    expect(stepLine({ tool: 'book_read', args: { what: 'chapter', ref: '3' }, ok: true, result: 'Chapter 3 …\n\nmore' })).toBe('› book_read chapter 3 — Chapter 3 …\n')
    expect(stepLine({ tool: 'bash', args: { command: 'ffmpeg -version' }, ok: false, result: 'not found' })).toBe('› bash ffmpeg -version — ✗ not found\n')
  })

  it('asks in one request what has everything in its task — a digest — and runs through the crew what reads the book — a review', async () => {
    const id = await withChapter(bed)
    bed.roles.enabled = true
    // A chapter's digest goes by the chapter in its task and nothing else: one request, whatever the role is set to —
    // no tools, no steps, nowhere to wander.
    bed.llm.responder = () => JSON.stringify({ brief: '沈蘅留下一封不寄的信。', summary: '雨夜，沈蘅把最后一封信压在砚台下，决定不寄，等他自己来取；阿棠把门闩推紧。', characters: [{ name: '沈蘅', role: '留下信', stateAfter: '决意等待' }], facts: [{ subject: '最后一封信', statement: '压在砚台下面，没有寄出', kind: 'item' }], newEntities: [], threads: [], openQuestions: ['他会来取吗？'] })
    bed.roles.script = async (task, call) => {
      expect(task.label).toBe('场记 · 第1章 · 审校')
      await call('book_read', { what: 'memory', ref: '1' })
      await call('file_review', { result: { verdict: '完成度高。', issues: [{ severity: 'low', type: 'style', quote: '雨下了一夜', explanation: '开头平。', suggestion: '换一个动作起笔。' }] } })
      return ''
    }
    const memory = await digestChapter(bed.core, bed.runtime, id, { origin: 'user' })
    expect(memory?.summary).toContain('压在砚台下')
    expect(memory?.facts).toEqual([{ subject: '最后一封信', statement: '压在砚台下面，没有寄出', kind: 'item' }])
    expect(bed.roles.tasks).toHaveLength(0)
    expect(bed.llm.requests).toHaveLength(1)
    expect(bed.llm.requests[0]!.prompt).toContain('雨下了一夜')
    const review = await reviewChapter(bed.core, bed.runtime, { chapter: id }, { origin: 'user' })
    expect(review.issues).toHaveLength(1)
    expect(review.issues[0]).toMatchObject({ severity: 'low', type: 'style', quote: '雨下了一夜' })
    expect(bed.roles.tasks).toHaveLength(1)
    expect(bed.llm.requests).toHaveLength(1)
  })
})

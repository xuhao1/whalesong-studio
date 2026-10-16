// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The record of calls: every call to a text model for a book is kept with
 * what was sent and what was said, in the book.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callsFor } from '../src/core/calls'
import { LlmCallError } from '../src/core/llm'
import { textPlan, runBatch } from '../src/core/pipelines/batch'
import { digestChapter } from '../src/core/pipelines/digest'
import { writeChapter } from '../src/core/pipelines/write'
import { createTestBed, type TestBed } from './support/harness'

let bed: TestBed

beforeEach(async () => {
  bed = await createTestBed()
})

afterEach(async () => {
  await bed.cleanup()
})

/** Write a chapter the way the Studio does: as a job that names it. */
async function writeAsJob(chapter: string, brief?: string) {
  const { core, runtime } = bed
  return await core.jobs.start({ kind: 'write', title: 'write', project: runtime.project.root, target: chapter, origin: 'user' }, async job => await writeChapter(core, runtime, { chapter, ...(brief !== undefined ? { brief } : {}) }, { origin: 'user', job, signal: job.signal })).done
}

describe('the record of calls', () => {
  it('keeps what a chapter\'s writer was sent and what it said, under the chapter', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    const plan = await project.addChapter({ title: '雨夜', synopsis: '沈璃回到旧居，发现断剑。' })
    llm.responder = () => ({ text: '雨下了一夜。沈璃推开门。', finish: 'stop', usage: { inputTokens: 1200, outputTokens: 30, cachedTokens: 800 } })
    await writeAsJob(plan.id, '重点写她的克制')

    const listed = await core.calls.list(project)
    expect(listed.total).toBe(1)
    const row = listed.calls[0]!
    expect(row).toMatchObject({ kind: 'write', title: 'write', chapter: plan.id, role: 'writer', provider: 'fake', model: 'fake-model', finish: 'stop', input: 1200, output: 30, cached: 800 })
    // The writer's own temperature where the author set none: on record, as it was sent.
    expect(row.temperature).toBe(0.85)
    expect(row.got).toBe('雨下了一夜。沈璃推开门。'.length)
    expect(row.bytes).toBeGreaterThan(0)
    expect(listed.bytes).toBeGreaterThanOrEqual(row.bytes)

    const sent = llm.requests.at(-1)!
    const call = (await core.calls.read(project, row.id))!
    expect(call.prompt).toBe(sent.prompt)
    expect(call.system).toBe(sent.system)
    expect(call.stable ?? '').toBe(sent.stable ?? '')
    expect(call.prompt).toContain('重点写她的克制')
    expect(call.reply).toBe('雨下了一夜。沈璃推开门。')
    expect(row.sent).toBe((sent.system?.length ?? 0) + (sent.stable?.length ?? 0) + sent.prompt.length)

    // Only this chapter's, when asked for by chapter.
    expect((await core.calls.list(project, { chapter: plan.id })).calls).toHaveLength(1)
    expect((await core.calls.list(project, { chapter: 'ch_other' })).calls).toHaveLength(0)

    // A model that refused the temperature was sent none: the record does not say it was.
    llm.responder = () => ({ text: '雨停了。', finish: 'stop', unsent: ['temperature'] })
    await writeAsJob(plan.id)
    const refused = (await core.calls.list(project)).calls.find(call => call.id !== row.id)!
    expect(refused.temperature).toBeUndefined()
  })

  it('keeps a stretch many calls send once, and lets it go with the last call that names it', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    const route = await core.route('writer', runtime)
    const rules = '守则。'.repeat(1000)
    const story = '前文。'.repeat(2000)
    for (const ask of ['一', '二', '三']) await core.llm.complete({ route, system: rules, stable: story, prompt: `写第${ask}段` })
    expect(llm.requests).toHaveLength(3)

    const dir = join(project.root, '.novel', 'calls')
    expect(await readdir(join(dir, 'parts'))).toHaveLength(2)
    const { calls, bytes } = await core.calls.list(project)
    expect(calls.map(call => call.parts?.length)).toEqual([2, 2, 2])
    // The whole record is far smaller than three copies of what was sent.
    expect(bytes).toBeLessThan(Buffer.byteLength(rules + story) * 2)
    const read = (await core.calls.read(project, calls[0]!.id))!
    expect(read.system).toBe(rules)
    expect(read.stable).toBe(story)
    expect(read.prompt).toBe('写第三段')

    expect(await core.calls.remove(project, [calls[0]!.id, calls[1]!.id])).toBe(2)
    expect(await readdir(join(dir, 'parts'))).toHaveLength(2)
    expect(await core.calls.remove(project)).toBe(1)
    expect(await readdir(join(dir, 'parts'))).toHaveLength(0)
    expect((await readdir(dir)).filter(name => name !== 'parts' && name !== 'index.json')).toHaveLength(0)
    expect((await core.calls.list(project)).total).toBe(0)
  })

  it('holds to the size the author set: the oldest calls go first', async () => {
    const { core, runtime } = bed
    const { project } = runtime
    await core.settings.update({ callsMb: 0.02 })
    const route = await core.route('analyst', runtime)
    for (let at = 0; at < 8; at++) await core.llm.complete({ route, prompt: `第 ${at} 问：${'字'.repeat(1800)}` })
    const { calls, bytes, total } = await core.calls.list(project)
    expect(bytes).toBeLessThanOrEqual(0.02 * 1024 * 1024)
    expect(total).toBeLessThan(8)
    expect(total).toBeGreaterThan(0)
    // The latest is there; the first is not.
    expect((await core.calls.read(project, calls[0]!.id))!.prompt.startsWith('第 7 问')).toBe(true)
    const files = (await readdir(join(project.root, '.novel', 'calls'))).filter(name => name !== 'index.json' && name !== 'parts')
    expect(files).toHaveLength(total)
  })

  it('keeps nothing where the author has it so', async () => {
    const { core, runtime } = bed
    await core.settings.update({ callsMb: 0 })
    await core.llm.complete({ route: await core.route('writer', runtime), prompt: '写' })
    expect((await core.calls.list(runtime.project)).total).toBe(0)
  })

  it('keeps a call that failed with why, and one that was stopped with what it had said', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    const route = await core.route('writer', runtime)
    llm.responder = () => { throw new LlmCallError('the key was refused', 'AUTH') }
    await expect(core.llm.complete({ route, prompt: '写' })).rejects.toThrow('the key was refused')
    const stop = new AbortController()
    llm.responder = (request) => {
      request.onText?.('写到一半', '写到一半')
      stop.abort()
      throw stop.signal.reason
    }
    await expect(core.llm.complete({ route, prompt: '再写', signal: stop.signal, onText: () => {} })).rejects.toBeDefined()
    const { calls } = await core.calls.list(project)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ error: 'the key was refused' })
    expect(calls[1]!.finish).toBeUndefined()
    expect(calls[0]).toMatchObject({ error: 'stopped', stopped: true })
    expect((await core.calls.read(project, calls[0]!.id))!.reply).toBe('写到一半')
  })

  it('files the calls of a batch under the chapter and the step each was made for', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    const one = await project.addChapter({ title: '一', synopsis: '开头。' })
    const two = await project.addChapter({ title: '二', synopsis: '接着。' })
    llm.responder = () => '正文。'
    const plan = await textPlan(core, runtime, { steps: ['write'], chapters: [one.id, two.id] })
    await core.jobs.start({ kind: 'batch', title: 'text batch', project: project.root, origin: 'user' }, async job => await runBatch(plan, { origin: 'user', job, signal: job.signal }, 'zh')).done
    const { calls } = await core.calls.list(project)
    expect(calls.map(call => [call.kind, call.step, call.chapter])).toEqual([['batch', 'write', two.id], ['batch', 'write', one.id]])
    // Whoever runs a stretch of work says what it is for.
    await callsFor({ target: one.id, step: 'review' }, async () => await core.llm.complete({ route: await core.route('analyst', runtime), prompt: '审' }))
    expect((await core.calls.list(project)).calls[0]).toMatchObject({ chapter: one.id, step: 'review', role: 'analyst' })
  })

  it('says which call of a chapter\'s writing was the digest that followed', async () => {
    const { core, runtime, llm } = bed
    const { project } = runtime
    const plan = await project.addChapter({ title: '雨夜', synopsis: '沈璃回到旧居。' })
    await project.saveChapterText(plan.id, '雨下了一夜。沈璃推开门。')
    llm.responder = () => JSON.stringify({ summary: '沈璃回到旧居。', facts: [], characters: [] })
    await core.jobs.start({ kind: 'write', title: 'write', project: project.root, target: plan.id, origin: 'user' }, async job => await digestChapter(core, runtime, plan.id, { origin: 'user', job, signal: job.signal })).done
    const { calls } = await core.calls.list(project)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.kind === 'write' && call.step === 'digest' && call.chapter === plan.id)).toBe(true)
  })

  it('keeps the requests of a role working as an agent, a step a call: each holds what is new with it, and what the earlier ones had sent is read off them', async () => {
    const { core, runtime } = bed
    const { project } = runtime
    const chapter = await project.addChapter({ title: '雨夜' })
    const route = { provider: 'fake', model: 'fake-model', for: { role: 'architect' as const, book: project.root } }
    const rules = `你是这本书的策划。${'守则。'.repeat(700)}`
    const tools = `## book_read\n读书里的一处。\n{"type":"object"}${' '.repeat(1600)}`
    const said = ['[user]\n照这句话去查：柳先生的眼镜一会儿有一会儿没有', '[assistant]\n→ book_read {"what":"chapter","chapter":2}\n\n[tool result: book_read]\n柳先生没戴眼镜，眯着眼看账。', '[assistant]\n→ book_search {"query":"眼镜"}\n\n[tool result: book_search]\n第 2 章 2 处']
    // A job of the kind the page starts, with the chapter named for the run: the steps are filed under both.
    const started = core.jobs.start({ kind: 'revise', title: 'review by lead', project: project.root, origin: 'user' }, async (job) => {
      for (let step = 1; step <= 3; step++) {
        await core.calls.keepStep({
          book: project.root, job: { id: job.id, kind: job.kind }, scope: { target: chapter.id }, role: 'architect', route, session: 'run-1', label: '审校和修订 · 照作者说的', step,
          startedAt: Date.now(), system: rules, tools, toolCount: 1, fresh: said[step - 1]!, sent: rules.length + tools.length + said.slice(0, step).join('\n\n').length,
          reply: step < 3 ? `→ book_read {"step":${step}}` : '{"findings":[]}', usage: { inputTokens: 1000 * step, outputTokens: 20, cachedTokens: 900 * (step - 1) }, thought: 40, finish: step < 3 ? 'tool-calls' : 'stop',
        })
      }
      return job.id
    })
    const jobId = await started.done
    // Another run beside it, of another job: not this job's.
    await core.calls.keepStep({ book: project.root, role: 'analyst', route: { ...route, for: { role: 'analyst' as const, book: project.root } }, session: 'run-2', step: 1, startedAt: Date.now(), system: rules, fresh: '[user]\n审校这一章', sent: 10, reply: 'ok' })

    const listed = await core.calls.list(project)
    expect(listed.total).toBe(4)
    const mine = await core.calls.list(project, { job: jobId })
    expect(mine.calls.map(row => [row.agent?.step, row.agent?.session, row.agent?.tools, row.kind, row.title, row.chapter, row.role, row.finish, row.input]).reverse()).toEqual([
      [1, 'run-1', 1, 'revise', 'review by lead', chapter.id, 'architect', 'tool-calls', 1000],
      [2, 'run-1', 1, 'revise', 'review by lead', chapter.id, 'architect', 'tool-calls', 2000],
      [3, 'run-1', 1, 'revise', 'review by lead', chapter.id, 'architect', 'stop', 3000],
    ])
    expect(mine.calls[0]!.agent?.label).toBe('审校和修订 · 照作者说的')
    const [third, second, first] = mine.calls as [typeof mine.calls[0], typeof mine.calls[0], typeof mine.calls[0]]

    // The first request: the rules, the tools, the task — and nothing sent before it.
    const one = (await core.calls.read(project, first.id))!
    expect(one).toMatchObject({ system: rules, tools, prompt: said[0], reply: '→ book_read {"step":1}' })
    expect(one.stable).toBeUndefined()
    // The third: what is new with it, and — in the order they went — what the two before it had sent.
    const three = (await core.calls.read(project, third.id))!
    expect(three.prompt).toBe(said[2])
    expect(three.stable).toBe(`${said[0]}\n\n${said[1]}`)
    expect(three.system).toBe(rules)
    expect(three.tools).toBe(tools)
    // The rules and the tools are kept once for the run, and a step keeps no more than its own.
    const parts = await readdir(join(project.root, '.novel', 'calls', 'parts'))
    expect(parts).toHaveLength(2)
    expect(third.bytes).toBeLessThan(1500)
    expect(await readFile(join(project.root, '.novel', 'calls', `${third.id}.json`), 'utf8')).not.toContain('柳先生没戴眼镜')

    // An earlier step taken off the record: the later one says so, and still has what the steps left hold.
    await core.calls.remove(project, [first.id])
    const after = (await core.calls.read(project, third.id))!
    expect(after.stable).toContain('no longer on record')
    expect(after.stable).toContain(said[1])
    expect(after.stable).not.toContain(said[0])
    expect((await core.calls.read(project, second.id))!.stable).toContain('no longer on record')
  })

  it('is sealed with a sealed book', async () => {
    const { core, runtime } = bed
    const root = runtime.project.root
    await core.sealBook(root, { password: 'open sesame' })
    const sealed = await core.runtime(root)
    await core.llm.complete({ route: await core.route('writer', sealed), system: '守则。'.repeat(1000), prompt: '写沈璃推开门的那一段' })
    const { calls } = await core.calls.list(sealed.project)
    expect(calls).toHaveLength(1)
    expect((await core.calls.read(sealed.project, calls[0]!.id))!.prompt).toBe('写沈璃推开门的那一段')
    // Nothing of it lies in the open: not the request, not the rules, not the list.
    const seen: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name))
        else seen.push((await readFile(join(dir, entry.name))).toString('utf8'))
      }
    }
    await walk(root)
    expect(seen.some(text => text.includes('沈璃推开门') || text.includes('守则。守则。'))).toBe(false)
  })
})

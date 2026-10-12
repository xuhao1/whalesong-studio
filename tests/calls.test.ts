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

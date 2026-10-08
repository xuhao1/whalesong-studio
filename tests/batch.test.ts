// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobManager } from '../src/core/jobs'
import { artPlan, batchFailures, batchSummary, runBatch, stageOverview, stageReadiness, textPlan, type BatchPlan, type BatchStep } from '../src/core/pipelines/batch'
import type { BatchView } from '../src/shared/types'
import { createTestBed, FakeImages, type TestBed } from './support/harness'

const tick = (ms = 2): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function plan(steps: BatchStep[], lanes: Record<string, number> = {}): BatchPlan {
  const rows = [...new Set(steps.map(step => step.target))]
  const columns = [...new Set(steps.map(step => step.op))]
  return { what: 'stage', columns, rows: rows.map(id => ({ id, label: id, kind: 'chapter' as const })), steps, lanes }
}

describe('batches', () => {
  it('runs what can run side by side, in the order things depend on each other', async () => {
    const log: string[] = []
    let inside = 0
    let most = 0
    const step = (target: string, op: string, after: string[] = []): BatchStep => ({
      target,
      op,
      after,
      async run() {
        log.push(`${target}:${op} start`)
        inside += 1
        most = Math.max(most, inside)
        await tick(4)
        inside -= 1
        log.push(`${target}:${op} end`)
        return `${op} of ${target}`
      },
    })
    const steps: BatchStep[] = []
    for (const chapter of ['a', 'b', 'c']) {
      steps.push(step(chapter, 'script'))
      steps.push(step(chapter, 'voice', [`${chapter}:script`]))
      steps.push(step(chapter, 'sound', [`${chapter}:script`]))
      steps.push(step(chapter, 'video', [`${chapter}:voice`, `${chapter}:sound`]))
    }
    const result = await runBatch(plan(steps, { script: 3, voice: 3, sound: 3, video: 1 }), { origin: 'user' }, 'en')
    expect(result.done).toBe(12)
    expect(result.failed).toEqual([])
    // Three scripts at once; a chapter's voices and sounds side by side once its script stands.
    expect(most).toBeGreaterThanOrEqual(3)
    for (const chapter of ['a', 'b', 'c']) {
      expect(log.indexOf(`${chapter}:script end`)).toBeLessThan(log.indexOf(`${chapter}:voice start`))
      expect(log.indexOf(`${chapter}:script end`)).toBeLessThan(log.indexOf(`${chapter}:sound start`))
      expect(Math.max(log.indexOf(`${chapter}:voice end`), log.indexOf(`${chapter}:sound end`))).toBeLessThan(log.indexOf(`${chapter}:video start`))
    }
    // One video at a time.
    const videos = log.filter(entry => entry.includes(':video'))
    expect(videos).toEqual(['a:video start', 'a:video end', 'b:video start', 'b:video end', 'c:video start', 'c:video end'])
    expect(result.batch.rows[0]!.steps.voice).toEqual({ state: 'done', note: 'voice of a' })
    expect(result.batch).toMatchObject({ total: 12, settled: 12, failed: 0 })
  })

  it('lets a failure be the only thing that fails, and says what did not come about', async () => {
    const ran: string[] = []
    const ok = (target: string, op: string, after: string[] = []): BatchStep => ({ target, op, after, async run() { ran.push(`${target}:${op}`); return undefined } })
    const steps: BatchStep[] = [
      ok('a', 'script'),
      { target: 'b', op: 'script', async run() { throw new Error('the director returned nothing usable') } },
      ok('c', 'script'),
      ok('a', 'voice', ['a:script']),
      ok('b', 'voice', ['b:script']),
      ok('b', 'video', ['b:voice']),
      { target: 'c', op: 'voice', after: ['c:script'], skip: () => 'no speech model is set up', async run() { ran.push('c:voice'); return undefined } },
      // A step that needed nothing counts as settled for what waits on it.
      ok('c', 'video', ['c:voice']),
    ]
    const result = await runBatch(plan(steps, { script: 2, voice: 2 }), { origin: 'user' }, 'en')
    expect(ran.sort()).toEqual(['a:script', 'a:voice', 'c:script', 'c:video'])
    expect(result.done).toBe(4)
    expect(result.skipped).toBe(1)
    expect(result.failed).toEqual([{ target: 'b', label: 'b', op: 'script', error: 'the director returned nothing usable' }])
    const row = result.batch.rows.find(candidate => candidate.id === 'b')!
    expect(row.steps.script!.state).toBe('failed')
    expect(row.steps.voice!.state).toBe('blocked')
    expect(row.steps.video!.state).toBe('blocked')
    expect(result.batch.rows.find(candidate => candidate.id === 'c')!.steps.voice).toEqual({ state: 'skipped', note: 'no speech model is set up' })
    expect(batchSummary(result, 'en')).toBe('4 done, 1 needed nothing, 1 did not come about')
    expect(batchFailures(result, 'en')).toBe('- b · script: the director returned nothing usable')
  })

  it('shows every step\'s own progress in its place, and stops as a whole', async () => {
    const jobs = new JobManager()
    const views: BatchView[] = []
    let stopped = false
    const started = jobs.start({ kind: 'batch', title: 'stage batch', project: '/book', origin: 'user' }, async (job) => {
      const steps: BatchStep[] = ['a', 'b'].map(target => ({
        target,
        op: 'voice',
        async run(task) {
          task.job?.progress(3, 10, 'speaking')
          task.job?.result({ chapterId: target, active: ['l1'] })
          views.push(jobs.get(job.id)!.result!.batch as BatchView)
          await new Promise<void>((_resolve, reject) => { task.signal?.addEventListener('abort', () => { stopped = true; reject(new Error('aborted')) }) })
          return undefined
        },
      }))
      return await runBatch(plan(steps, { voice: 2 }), { origin: 'user', signal: job.signal, job }, 'en')
    })
    await tick(10)
    const view = jobs.get(started.id)!.result!.batch as BatchView
    expect(view.rows.map(row => row.steps.voice!.state)).toEqual(['running', 'running'])
    expect(view.rows[0]!.steps.voice).toMatchObject({ progress: { done: 3, total: 10, label: 'speaking' }, detail: { chapterId: 'a', active: ['l1'] } })
    // The job itself counts settled steps, and names what is under way.
    expect(jobs.get(started.id)!.progress).toMatchObject({ done: 0, total: 2 })
    expect(jobs.get(started.id)!.progress!.label).toContain('a · voices 3/10')
    jobs.cancel(started.id)
    await expect(started.done).rejects.toThrow('aborted')
    expect(stopped).toBe(true)
    expect(jobs.get(started.id)!.status).toBe('cancelled')
  })

  it('names on every step the agent that works on it, so that each can be opened by itself', async () => {
    const jobs = new JobManager()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const started = jobs.start({ kind: 'batch', title: 'text batch', project: '/book', origin: 'user' }, async (job) => {
      const steps: BatchStep[] = ['a', 'b', 'c'].map(target => ({
        target,
        op: 'digest',
        async run(task) {
          // The third is a plain call: no agent, nothing to open.
          if (target !== 'c') task.job?.crew({ role: 'analyst', label: `digest ${target}`, by: 'agent', running: true, session: `session-${target}`, parent: 'conversation' })
          await held
          if (target !== 'c') task.job?.crew({ role: 'analyst', label: `digest ${target}`, by: 'agent', steps: 4, session: `session-${target}`, parent: 'conversation' })
          return 'done'
        },
      }))
      return await runBatch(plan(steps, { digest: 3 }), { origin: 'user', signal: job.signal, job }, 'en')
    })
    await tick(10)
    const running = jobs.get(started.id)!.result!.batch as BatchView
    // Three steps at once, two agents: each cell leads to its own — not to whichever started last.
    expect(running.rows.map(row => row.steps.digest!.run)).toEqual([
      { role: 'analyst', session: 'session-a', parent: 'conversation', running: true },
      { role: 'analyst', session: 'session-b', parent: 'conversation', running: true },
      undefined,
    ])
    // The job still lists them all, as before.
    expect(jobs.get(started.id)!.crew!.map(run => run.session)).toEqual(['session-a', 'session-b'])
    release()
    await started.done
    // Over, a step still says who did it: the record of the run can be read afterwards.
    const settled = jobs.get(started.id)!.result!.batch as BatchView
    expect(settled.rows.map(row => [row.steps.digest!.state, row.steps.digest!.run])).toEqual([
      ['done', { role: 'analyst', session: 'session-a', parent: 'conversation', running: false }],
      ['done', { role: 'analyst', session: 'session-b', parent: 'conversation', running: false }],
      ['done', undefined],
    ])
  })
})

describe('batches of real work', () => {
  let bed: TestBed
  afterEach(async () => { await bed.cleanup() })

  describe('text', () => {
    beforeEach(async () => { bed = await createTestBed() })

    it('writes a run of chapters one after the other, each knowing the one before', async () => {
      const { project } = bed.runtime
      const ids: string[] = []
      for (let n = 1; n <= 4; n++) ids.push((await project.addChapter({ title: `第${n}回`, synopsis: `第 ${n} 回的梗概。`, ...(n === 1 ? { beats: [{ id: 'b1', summary: '开场' }] } : {}) })).id)
      const order: string[] = []
      bed.llm.responder = (request) => {
        const all = `${request.system ?? ''}${request.stable ?? ''}${request.prompt}`
        if (all.includes('只输出小说正文')) {
          const n = /本章章纲[\s\S]*?第(\d)回/.exec(request.prompt)?.[1] ?? '?'
          order.push(`write ${n}`)
          return `第${n}回的正文写在这里。`.repeat(5)
        }
        if (request.prompt.includes('"beats"') && request.prompt.includes('节拍')) {
          order.push('beats')
          return JSON.stringify({ synopsis: '细化后的梗概', beats: [{ summary: '一个节拍' }, { summary: '又一个节拍' }] })
        }
        order.push('digest')
        return JSON.stringify({ brief: '摘要', summary: '这一回发生的事。', characters: [], facts: [], newEntities: [], threads: [] })
      }
      const laid = await textPlan(bed.core, bed.runtime, { steps: ['beats', 'write', 'digest'], count: 3 })
      expect(laid.rows.map(row => row.id)).toEqual(ids.slice(0, 3))
      const result = await runBatch(laid, { origin: 'user' }, 'zh')
      expect(result.failed).toEqual([])
      // Chapter one had beats already; each chapter is written, taken into memory, and only then the next begun.
      expect(order).toEqual(['write 1', 'digest', 'beats', 'write 2', 'digest', 'beats', 'write 3', 'digest'])
      expect(result.batch.rows[0]!.steps.beats).toMatchObject({ state: 'skipped' })
      const infos = await project.chapterInfos()
      expect(infos.map(info => [info.hasText, info.digested])).toEqual([[true, true], [true, true], [true, true], [false, false]])
      // The third chapter's writer read the first two, word for word — and its request begins with the second chapter's.
      const writes = bed.llm.requests.filter(request => (request.system ?? '').includes('只输出小说正文'))
      expect(writes[2]!.stable).toContain('第1回的正文写在这里。')
      expect(writes[2]!.stable).toContain('第2回的正文写在这里。')
      expect(writes[2]!.stable!.startsWith(writes[1]!.stable!)).toBe(true)
      expect(writes[1]!.system).toBe(writes[2]!.system)
      // Run again, the batch goes on with what is left.
      order.length = 0
      const rest = await textPlan(bed.core, bed.runtime, { steps: ['beats', 'write', 'digest'] })
      expect(rest.rows.map(row => row.id)).toEqual([ids[3]])
      await runBatch(rest, { origin: 'user' }, 'zh')
      expect(order).toEqual(['beats', 'write 4', 'digest'])
    })

    it('writes a run of chapters side by side when asked to: faster, each from its outline and the outlines before it', async () => {
      const { project } = bed.runtime
      const ids: string[] = []
      for (let n = 1; n <= 4; n++) ids.push((await project.addChapter({ title: `第${n}回`, synopsis: `第 ${n} 回的梗概。`, beats: [{ id: `b${n}`, summary: '开场' }] })).id)
      await project.saveChapterText(ids[0]!, '第1回是早就写好的。')
      // Every writer is held until all three have begun: in order, the second would never begin.
      let begun = 0
      let release!: () => void
      const all = new Promise<void>((resolve) => { release = resolve })
      const order: string[] = []
      bed.llm.responder = async (request) => {
        if ((request.system ?? '').includes('只输出小说正文')) {
          const n = /本章章纲[\s\S]*?第(\d)回/.exec(request.prompt)?.[1] ?? '?'
          order.push(`begin ${n}`)
          begun += 1
          if (begun === 3) release()
          await all
          order.push(`write ${n}`)
          return `第${n}回的正文写在这里。`.repeat(5)
        }
        order.push('digest')
        return JSON.stringify({ brief: '摘要', summary: '这一回发生的事。', characters: [], facts: [], newEntities: [], threads: [] })
      }
      // In order is how it goes unless the author says otherwise: one writer at a time, each waiting for the one before.
      const inOrder = await textPlan(bed.core, bed.runtime, { steps: ['write', 'digest'], count: 3 })
      expect(inOrder.lanes.write).toBe(1)
      expect(inOrder.steps.filter(step => step.op === 'write').map(step => (step.after ?? []).length)).toEqual([0, 1, 1])
      expect(inOrder.finish).toBeUndefined()
      // Side by side: as many at once as the settings allow, none waiting for another.
      const laid = await textPlan(bed.core, bed.runtime, { steps: ['write', 'digest'], count: 3, order: 'together' })
      expect(laid.rows.map(row => row.id)).toEqual(ids.slice(1))
      expect(laid.lanes.write).toBe(bed.core.parallel('text'))
      expect(laid.steps.filter(step => step.op === 'write').map(step => step.after ?? [])).toEqual([[], [], []])
      expect(laid.finish).toBeDefined()
      const result = await runBatch(laid, { origin: 'user' }, 'zh')
      expect(result.failed).toEqual([])
      expect(order.slice(0, 3).sort()).toEqual(['begin 2', 'begin 3', 'begin 4'])
      expect((await project.chapterInfos()).map(info => [info.hasText, info.digested])).toEqual([[true, false], [true, true], [true, true], [true, true]])
      // The fourth chapter's writer had the text there was before the batch, and of the two chapters written beside it
      // what their outlines say — told that their text is not there, and not to tell their part.
      const fourth = bed.llm.requests.find(request => (request.system ?? '').includes('只输出小说正文') && /本章章纲[\s\S]*?第4回/.test(request.prompt))!
      expect(fourth.stable).toContain('第1回是早就写好的。')
      expect(`${fourth.stable ?? ''}${fourth.prompt}`).not.toContain('第2回的正文写在这里')
      for (const part of ['排在本章之前、还没有写出来的章节（按章纲）', '可能正在同时写', '第2章 第2回  第 2 回的梗概。', '第3章 第3回  第 3 回的梗概。']) expect(fourth.prompt, part).toContain(part)
      // The second, which follows a chapter that is written, is told of no such gap.
      const second = bed.llm.requests.find(request => (request.system ?? '').includes('只输出小说正文') && /本章章纲[\s\S]*?第2回/.test(request.prompt))!
      expect(second.prompt).not.toContain('还没有写出来的章节')
    })

    it('gives beats and reviews to many chapters side by side', async () => {
      const { project } = bed.runtime
      for (let n = 1; n <= 5; n++) {
        const plan = await project.addChapter({ title: `第${n}回`, synopsis: '梗概' })
        if (n <= 3) await project.saveChapterText(plan.id, '正文。'.repeat(10))
      }
      let inside = 0
      let most = 0
      bed.llm.responder = async (request) => {
        inside += 1
        most = Math.max(most, inside)
        await tick(5)
        inside -= 1
        return request.prompt.includes('节拍') && request.prompt.includes('"beats"')
          ? JSON.stringify({ beats: [{ summary: '节拍' }] })
          : JSON.stringify({ verdict: '可以', issues: [{ type: 'pacing', severity: 'low', description: '节奏略慢' }] })
      }
      // Beats: for the chapters that are not written yet and have none.
      const beats = await textPlan(bed.core, bed.runtime, { steps: ['beats'] })
      expect(beats.rows).toHaveLength(2)
      expect((await runBatch(beats, { origin: 'user' }, 'zh')).done).toBe(2)
      // Reviews: for every chapter that has text, as many at once as the settings allow.
      most = 0
      const reviews = await textPlan(bed.core, bed.runtime, { steps: ['review'] })
      expect(reviews.rows).toHaveLength(3)
      const result = await runBatch(reviews, { origin: 'user' }, 'zh')
      expect(result.done).toBe(3)
      expect(most).toBe(3)
      // Every chapter that has text now has a review on record.
      expect((await project.chapterInfos()).filter(info => info.openIssues !== undefined)).toHaveLength(3)
      await expect(textPlan(bed.core, bed.runtime, { steps: ['review'] })).rejects.toThrow('没有要做的事')
    })
  })

  describe('pictures', () => {
    const images = new FakeImages()
    beforeEach(async () => {
      images.calls.length = 0
      bed = await createTestBed({ settings: { image: { provider: 'codex' } }, bridges: images.bridges })
    })

    it('draws the sheets first, and what is drawn against them after', async () => {
      const { project } = bed.runtime
      const one = await project.saveCharacter({ name: '沈璃', role: 'protagonist', appearance: '黑发，青衣', visual: { prompt: '黑发青衣的年轻女子' } })
      const two = await project.saveCharacter({ name: '顾七', role: 'supporting', appearance: '黑衣，斗笠', visual: { prompt: '戴斗笠的黑衣人' } })
      const place = await project.saveWorld({ name: '青冥山', category: 'location', summary: '北境雪山' })
      const laid = await artPlan(bed.core, bed.runtime, { sheets: [one.id, two.id], portraits: [one.id], places: [place.id], cover: true })
      expect(laid.columns).toEqual(['sheet', 'portrait', 'place', 'cover'])
      const result = await runBatch(laid, { origin: 'user' }, 'zh')
      expect(result.failed).toEqual([])
      expect(result.done).toBe(5)
      // The portrait and the cover were drawn after the sheets, with them as reference.
      const subjects = images.calls.map(call => call.prompt)
      const portraitAt = subjects.findIndex(prompt => prompt.includes('人物立绘'))
      const coverAt = subjects.findIndex(prompt => prompt.includes('小说封面'))
      const sheetAt = subjects.map((prompt, at) => prompt.includes('人物设定图') ? at : -1).filter(at => at >= 0)
      expect(sheetAt).toHaveLength(2)
      expect(portraitAt).toBeGreaterThan(Math.min(...sheetAt))
      expect(coverAt).toBeGreaterThan(Math.max(...sheetAt))
      expect(images.calls[portraitAt]!.references).toHaveLength(1)
      // Run again, there is nothing left to draw.
      const again = await runBatch(await artPlan(bed.core, bed.runtime, { sheets: [one.id, two.id], portraits: [one.id], places: [place.id], cover: true }), { origin: 'user' }, 'zh')
      expect(again).toMatchObject({ done: 0, skipped: 5 })
      expect(images.calls).toHaveLength(5)
    })

    it('puts the sheet on the table when a portrait is asked for somebody who has none', async () => {
      const { project } = bed.runtime
      const kept = await project.writeAsset('images/sheet-kept.png', new Uint8Array([1]))
      const bare = await project.saveCharacter({ name: '沈璃', role: 'protagonist', appearance: '黑发，青衣', visual: { prompt: '黑发青衣的年轻女子' } })
      const drawn = await project.saveCharacter({ name: '顾七', role: 'supporting', appearance: '黑衣，斗笠', visual: { prompt: '戴斗笠的黑衣人', sheet: kept } })
      // Only portraits were asked for: the one without a sheet gets a sheet step of its own, seen in the table.
      const laid = await artPlan(bed.core, bed.runtime, { portraits: [bare.id, drawn.id] })
      expect(laid.columns).toEqual(['sheet', 'portrait'])
      expect(laid.steps.filter(step => step.op === 'sheet').map(step => step.target)).toEqual([bare.id])
      const result = await runBatch(laid, { origin: 'user' }, 'zh')
      expect(result.failed).toEqual([])
      expect(result.done).toBe(3)
      // Her sheet before her portrait, and the portrait against it; no sheet drawn twice.
      const subjects = images.calls.map(call => call.prompt)
      expect(subjects.filter(prompt => prompt.includes('人物设定图'))).toHaveLength(1)
      const sheetAt = subjects.findIndex(prompt => prompt.includes('人物设定图'))
      const hers = subjects.findIndex(prompt => prompt.includes('人物立绘') && prompt.includes('黑发青衣'))
      expect(hers).toBeGreaterThan(sheetAt)
      expect(images.calls[hers]!.references).toHaveLength(1)
      expect((await project.findCharacter(bare.id))!.visual?.sheet).toBeDefined()
      // Turned off by the author: portraits only, as asked.
      await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, sheetFirst: false } })
      const other = await project.saveCharacter({ name: '摆渡人', role: 'minor', appearance: '蓑衣', visual: { prompt: '披蓑衣的老人' } })
      expect((await artPlan(bed.core, bed.runtime, { portraits: [other.id] })).columns).toEqual(['portrait'])
    })

    it('draws the things that matter beside the places, each the object alone', async () => {
      const { project } = bed.runtime
      const place = await project.saveWorld({ name: '青冥山', category: 'location', summary: '北境雪山' })
      const sword = await project.saveWorld({ name: '断水剑', category: 'item', summary: '一柄旧剑', visualPrompt: '窄刃，乌木鞘，剑格上刻着水纹' })
      const laid = await artPlan(bed.core, bed.runtime, { places: [place.id], items: [sword.id] })
      expect(laid.columns).toEqual(['place', 'item'])
      const result = await runBatch(laid, { origin: 'user' }, 'zh')
      expect(result.failed).toEqual([])
      expect(result.done).toBe(2)
      expect((await project.findWorld(sword.id))!.visualImage).toMatch(/^assets\/images\//)
      // The thing was asked for as a thing: what it looks like is in the request.
      expect(images.calls.some(call => call.prompt.includes('乌木鞘'))).toBe(true)
      // Run again, there is nothing left to draw.
      expect(await runBatch(await artPlan(bed.core, bed.runtime, { places: [place.id], items: [sword.id] }), { origin: 'user' }, 'zh')).toMatchObject({ done: 0, skipped: 2 })
      await expect(artPlan(bed.core, bed.runtime, { items: ['没有这件东西'] })).rejects.toThrow('no world entry matches')
    })

    it('says what the stage lacks before anything is started', async () => {
      const missing = await stageReadiness(bed.core, bed.runtime)
      expect(missing.voice).toBe('还没有配置语音模型')
      expect(missing.sound).toBe('还没有能生成声音的模型')
      expect(missing.panels).toBeUndefined()
      const { project } = bed.runtime
      const plan = await project.addChapter({ title: '雨夜' })
      await project.saveChapterText(plan.id, '夜雨敲窗。')
      expect(await stageOverview(bed.core, bed.runtime)).toEqual([{ id: plan.id, index: 1, title: '雨夜', words: 4 }])
    })
  })
})

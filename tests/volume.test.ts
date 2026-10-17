// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A volume's synopsis written off its chapters (#461): the written ones by
 * their digests, the others by their outlines, a long volume ten chapters at
 * a time or a line a chapter; its goal filled only where it is empty; and the
 * volume's synopsis and goal going along to whoever writes one of its chapters.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packContext } from '../src/core/context'
import { applyOutlineOps } from '../src/core/pipelines/outline'
import { volumeSynopses, volumeSynopsis } from '../src/core/pipelines/volume'
import type { ArcSummary } from '../src/core/context'
import { hashText } from '../src/shared/text'
import { bibleTools } from '../src/agent/tools/bible'
import type { NovelService } from '../src/host/service'
import { createTestBed, type TestBed } from './support/harness'

describe('volume synopses', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  /** A digest of the chapter's text as it stands — or, `stale`, of some other text. */
  const remember = async (id: string, summary: string, brief: string, stale = false): Promise<void> => {
    const { project } = bed.runtime
    const text = await project.chapterText(id)
    await project.saveMemory({ schema: 1, chapterId: id, textHash: stale ? 'old' : hashText(text), updatedAt: '', brief, summary, facts: [], characters: [], newEntities: [], threads: [] })
  }

  it('writes a volume\'s synopsis off its chapters: digests for the written ones, outlines for the rest, the plan there was kept at its end', async () => {
    const { project } = bed.runtime
    await applyOutlineOps(bed.runtime, [{ op: 'update-volume', volume: 'v1', synopsis: '原计划：沈璃下山，查出师父的下落，最后在剑阁与顾七对决。', goal: '她知道了师父还活着' }])
    const one = await project.addChapter({ title: '雨夜', synopsis: '动笔前的梗概，不该被用上' })
    const two = await project.addChapter({ title: '下山', synopsis: '沈璃带着断剑下山。' })
    const three = await project.addChapter({ title: '渡口', synopsis: '她在渡口等船，遇见顾七。' })
    const four = await project.addChapter({ title: '空白' })
    await project.saveChapterText(one.id, '夜雨敲窗。沈璃在梁上找到了断剑。')
    await project.saveChapterText(two.id, '她下山了。')
    await remember(one.id, '沈璃雨夜回到旧居，在梁上找到师父留下的断剑。', '雨夜得剑')
    // Nothing in the volume next door: it is not asked about.
    await applyOutlineOps(bed.runtime, [{ op: 'add-volume', title: '第二卷 剑阁', synopsis: '剑阁对决。' }])

    bed.llm.responder = request => request.prompt.includes('原来的卷梗概')
      ? JSON.stringify({ plan: [{ point: '沈璃下山', reached: true }, { point: '查出师父的下落，', reached: false }, { point: '最后在剑阁与顾七对决。', reached: 'false' }] })
      : JSON.stringify({ synopsis: '沈璃雨夜得剑，下山；接下来她将在渡口遇见顾七。', goal: '她走到渡口' })
    // (Run as a job is: a change of its own, not one more save of the author's sitting.)
    const read = await project.because('job-volume synopsis', async () => await volumeSynopsis(bed.core, bed.runtime, { volume: 'v1' }, { origin: 'user' }))
    expect(read).toMatchObject({ volumeId: 'v1', chapters: 4, written: 2, digested: 1, stale: 0, planned: 2, blank: 1, told: 'summaries', goalSet: false, applied: true, was: '原计划：沈璃下山，查出师父的下落，最后在剑阁与顾七对决。', ahead: '查出师父的下落；最后在剑阁与顾七对决。' })
    // The plan there was comes back point by point: what no chapter has reached stays at the end, as it stood, said to be the plan.
    const written = '沈璃雨夜得剑，下山；接下来她将在渡口遇见顾七。\n\n往后（原来的计划）：查出师父的下落；最后在剑阁与顾七对决。'
    expect(read.synopsis).toBe(written)

    // Two plain requests to the continuity editor: the synopsis, with every chapter by what there is of it …
    expect(bed.llm.requests).toHaveLength(2)
    const asked = bed.llm.requests[0]!
    expect(asked.system).toContain('场记')
    for (const part of [
      '「第一卷」（全书第 1–4 章，共 4 章，写了 2 章）',
      '第 1 章 雨夜\n沈璃雨夜回到旧居，在梁上找到师父留下的断剑。',
      '第 2 章 下山（写了，还没收录：下面是它的章纲）\n沈璃带着断剑下山。',
      '第 3 章 渡口（还没写：下面是它的章纲）\n她在渡口等船，遇见顾七。',
      '第 4 章 空白（还没写：下面是它的章纲）（章纲里也没有梗概）',
      '说成这一卷接下来要发生的',
      '不要逐章复述',
      '200-400 字，不要超出',
      '这一卷还没写完',
      '"synopsis"',
    ]) expect(asked.prompt, part).toContain(part)
    // … and nothing of a plan beside them — the synopsis it had, its goal, what the next volume is to be — that would be written into the story as though it had happened.
    // (The digest is what a written chapter is told by, not the outline laid down before it was written.)
    for (const part of ['原计划', '她知道了师父还活着', '剑阁对决', '动笔前的梗概', '## 上一卷']) expect(asked.prompt, part).not.toContain(part)
    // Then the synopsis it had, held against the new one, point by point.
    const checked = bed.llm.requests[1]!.prompt
    for (const part of ['「第一卷」原来的卷梗概\n\n原计划：沈璃下山，查出师父的下落', '这一卷现在照各章写的梗概\n\n沈璃雨夜得剑', '逐件列出，照原来的话', '"reached"']) expect(checked, part).toContain(part)

    // Saved; the goal the author set is left as it was; what was there is in the volume's history; and it is said.
    const outline = await project.outline()
    expect(outline.volumes[0]).toMatchObject({ synopsis: written, goal: '她知道了师父还活着' })
    expect(outline.volumes[0]!.chapters.map(plan => plan.id)).toEqual([one.id, two.id, three.id, four.id])
    const versions = await project.history('volume', 'v1')
    expect(versions[0]!.why).toBe('job-volume-synopsis')
    expect(await project.historyOf('volume', 'v1', versions[0]!.id)).toMatchObject({ synopsis: '原计划：沈璃下山，查出师父的下落，最后在剑阁与顾七对决。', goal: '她知道了师父还活着' })
    expect((await project.activity()).some(entry => entry.summary.includes('「第一卷」的卷梗概照各章重写了'))).toBe(true)
  })

  it('fills an empty goal, hands a draft back without changing the volume, and asks nobody where there is nothing to go by', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(one.id, '夜雨敲窗。')
    // Nothing digested and no outline with a synopsis: nothing to write it from.
    await expect(volumeSynopsis(bed.core, bed.runtime, { volume: 'v1' }, { origin: 'user' })).rejects.toMatchObject({ code: 'novel/empty' })
    // No chapters, no such volume.
    await applyOutlineOps(bed.runtime, [{ op: 'add-volume', title: '第二卷' }])
    await expect(volumeSynopsis(bed.core, bed.runtime, { volume: '第二卷' }, { origin: 'user' })).rejects.toMatchObject({ code: 'novel/empty' })
    await expect(volumeSynopsis(bed.core, bed.runtime, { volume: 'v9' }, { origin: 'user' })).rejects.toMatchObject({ code: 'novel/not-found' })
    expect(bed.llm.requests).toHaveLength(0)

    await remember(one.id, '沈璃雨夜得剑。', '雨夜得剑', true)
    bed.llm.responder = () => JSON.stringify({ synopsis: '只看不改。', goal: '她得了剑' })
    const looked = await volumeSynopsis(bed.core, bed.runtime, { volume: '第一卷', apply: false }, { origin: 'user' })
    expect(looked).toMatchObject({ synopsis: '只看不改。', goal: '她得了剑', goalSet: true, stale: 1, applied: false })
    expect(looked).not.toHaveProperty('ahead')
    // (Nothing there before: nothing to hold the new one against, and nobody asked.)
    expect(bed.llm.requests).toHaveLength(1)
    // (A digest of a text changed since is said to be one.)
    expect(bed.llm.requests[0]!.prompt).toContain('第 1 章 雨夜（这份摘要是正文改动之前收录的）')
    expect((await project.outline()).volumes[0]).not.toHaveProperty('synopsis')

    // A synopsis without a synopsis is sent back.
    let tries = 0
    bed.llm.responder = () => { tries += 1; return tries === 1 ? JSON.stringify({ goal: '她得了剑' }) : JSON.stringify({ synopsis: '沈璃得剑。', goal: '她得了剑' }) }
    const read = await volumeSynopsis(bed.core, bed.runtime, { volume: 'v1' }, { origin: 'user' })
    expect(tries).toBe(2)
    expect(read.goalSet).toBe(true)
    expect((await project.outline()).volumes[0]).toMatchObject({ synopsis: '沈璃得剑。', goal: '她得了剑' })
  })

  it('tells a long volume ten chapters at a time where the book has those stretches, else a line a chapter', async () => {
    const { project } = bed.runtime
    bed.llm.contextWindow = async () => 30_000
    const ids: string[] = []
    for (let index = 1; index <= 12; index++) {
      const plan = await project.addChapter({ title: `第${index}回` })
      await project.saveChapterText(plan.id, `第${index}回的正文。`)
      await remember(plan.id, `第${index}回的长摘要：${'事'.repeat(2000)}`, `第${index}回一句话`)
      ids.push(plan.id)
    }
    bed.llm.responder = () => JSON.stringify({ synopsis: '十二回。' })
    // Too long whole (half of a 30,000 window is under the floor of 20,000 tokens, and twelve summaries are more): a line a chapter.
    const briefs = await volumeSynopsis(bed.core, bed.runtime, { volume: 'v1', apply: false }, { origin: 'user' })
    expect(briefs.told).toBe('briefs')
    let prompt = bed.llm.requests.at(-1)!.prompt
    expect(prompt).toContain('第 1 章 第1回：第1回一句话')
    expect(prompt).not.toContain('长摘要')
    // With the first ten summed up: those ten as one stretch, the two after it as they are.
    const arc: ArcSummary = { from: ids[0]!, to: ids[9]!, fromIndex: 1, toIndex: 10, summary: '前十回的阶段梗概。', hash: 'h' }
    await project.writeState(['memory', 'arcs.json'], [arc])
    const arcs = await volumeSynopsis(bed.core, bed.runtime, { volume: 'v1', apply: false }, { origin: 'user' })
    expect(arcs.told).toBe('arcs')
    prompt = bed.llm.requests.at(-1)!.prompt
    expect(prompt).toContain('第 1–10 章（这十章的阶段梗概）\n前十回的阶段梗概。')
    expect(prompt).toContain('第 11 章 第11回\n第11回的长摘要')
    expect(prompt).not.toContain('第 3 章 第3回')
  })

  it('writes every volume\'s synopsis in one job, passing over the ones with nothing to go by', async () => {
    const { project } = bed.runtime
    const one = await project.addChapter({ title: '雨夜', synopsis: '沈璃得剑。' })
    await applyOutlineOps(bed.runtime, [{ op: 'add-volume', title: '第二卷' }, { op: 'add-volume', title: '第三卷' }])
    await project.addChapter({ title: '剑阁', synopsis: '对决。' }, { volume: 'v2' })
    await project.addChapter({ title: '空' }, { volume: 'v3' })
    expect((await project.outline()).volumes.map(volume => volume.chapters.length)).toEqual([1, 1, 1])
    bed.llm.responder = request => JSON.stringify({ synopsis: request.prompt.includes('剑阁') ? '第二卷的梗概。' : '第一卷的梗概。' })
    const all = await volumeSynopses(bed.core, bed.runtime, {}, { origin: 'user' })
    expect(all.read.map(read => [read.volumeId, read.synopsis])).toEqual([['v1', '第一卷的梗概。'], ['v2', '第二卷的梗概。']])
    expect(all.skipped.map(item => item.volumeId)).toEqual(['v3'])
    expect(all.failed).toEqual([])
    expect((await project.outline()).volumes.map(volume => volume.synopsis)).toEqual(['第一卷的梗概。', '第二卷的梗概。', undefined])
    // The book's activity says it once.
    expect((await project.activity()).filter(entry => entry.summary.includes('卷梗概照各章重写了'))).toHaveLength(1)
    expect(one.id).toBeDefined()
  })

  it('gives whoever drafts a chapter its volume\'s synopsis and goal, and not the reviewer', async () => {
    const { project, index } = bed.runtime
    await applyOutlineOps(bed.runtime, [{ op: 'update-volume', volume: 'v1', synopsis: '沈璃下山寻师。', goal: '她找到师父的线索' }])
    const plan = await project.addChapter({ title: '下山', synopsis: '沈璃带着断剑下山。' })
    const chapter = (await project.findChapter(plan.id))!
    const draft = await packContext(project, index, { purpose: 'draft', chapter, textBudget: 10_000, sideBudget: 6000, tailChars: 200 })
    expect(draft.rest).toContain('## 本卷「第一卷」（这一章所在的卷：用来把握方向；本章之后的事不要提前写）\n\n梗概：沈璃下山寻师。\n要把故事带到哪里：她找到师父的线索')
    // Read before the chapter's own outline, which comes last; and not in what stays the same from chapter to chapter.
    expect(draft.rest.indexOf('本卷「第一卷」')).toBeLessThan(draft.rest.indexOf('本章章纲'))
    expect(draft.stable).not.toContain('沈璃下山寻师')
    const review = await packContext(project, index, { purpose: 'review', chapter, textBudget: 10_000, sideBudget: 6000, tailChars: 200 })
    expect(review.text).not.toContain('沈璃下山寻师')
  })
})

describe('the showrunner\'s volume synopses', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('novel_derive kind=volume writes one volume\'s synopsis, or every one, and refuses to look at all of them without saving', async () => {
    const { project } = bed.runtime
    await project.addChapter({ title: '雨夜', synopsis: '沈璃得剑。' })
    await applyOutlineOps(bed.runtime, [{ op: 'add-volume', title: '第二卷' }])
    await project.addChapter({ title: '剑阁', synopsis: '对决。' }, { volume: 'v2' })
    // Just what the tool's wrapper reaches for: the book in play is this one.
    const service = {
      core: bed.core,
      workspaceOfAgent: () => bed.dir,
      agentTask: () => ({ origin: 'agent' }),
      requireProject: async () => bed.runtime,
      sessionBooks: { touch: async () => {} },
      sessions: { peek: () => undefined },
      log: () => {},
    } as unknown as NovelService
    const derive = bibleTools(service).find(tool => tool.name === 'novel_derive')! as unknown as { execute(args: Record<string, unknown>, exec: { agent: { id: string } }): Promise<{ text: string }> }
    const exec = { agent: { id: 'agent-1' } }
    bed.llm.responder = request => request.prompt.includes('原来的卷梗概')
      ? JSON.stringify({ plan: [{ point: '第二卷的梗概', reached: true }] })
      : JSON.stringify({ synopsis: request.prompt.includes('剑阁') ? '第二卷的梗概。' : '第一卷的梗概。', goal: '到了这里' })

    const one = await derive.execute({ kind: 'volume', volume: '第二卷' }, exec)
    expect(one.text).toContain('The synopsis of "第二卷" (v2) — 1 chapter(s), 0 written; 0 by their digests, 1 by their outlines; goal filled: 到了这里:\n第二卷的梗概。')
    expect(one.text).toContain('Saved to the volume')
    expect((await project.outline()).volumes.map(volume => volume.synopsis)).toEqual([undefined, '第二卷的梗概。'])

    const all = await derive.execute({ kind: 'volume' }, exec)
    expect(all.text).toContain('2 volume synopsis(es) written off their chapters and saved')
    expect((await project.outline()).volumes.map(volume => volume.synopsis)).toEqual(['第一卷的梗概。', '第二卷的梗概。'])
    // (Looked at without saving: one volume at a time.)
    await expect(derive.execute({ kind: 'volume', apply: false }, exec)).rejects.toThrow('name it in `volume`')
  })
})

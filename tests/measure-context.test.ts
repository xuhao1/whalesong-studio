// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A measuring stick, not a test: what each way of reviewing and mending sends to a model, on a long book — and, of
 * one of them, what every section of the request took. Skipped unless asked for:
 *
 *   MEASURE=1 npx vitest run tests/measure-context.test.ts
 *   MEASURE=1 MEASURE_SECTIONS='整章重写' npx vitest run tests/measure-context.test.ts
 *
 * The text parts of a book in the dev workspace (`MEASURE_BOOK`, by folder name) are copied to a temp folder; a model
 * that answers nothing, with a window of `MEASURE_WINDOW` tokens, takes the requests; no model is called and the book
 * is not touched. Sizes are the Studio's own estimate, which runs a fifth or so above what a model counts.
 *
 * Whoever changes a budget of the context pack: print what every section got, not the total (a chapter to be written
 * over once arrived as its last three thousand characters, under a total that looked right).
 */
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { NovelCore } from '../src/core/core'
import { namedKeySource } from '../src/core/media/http'
import { amendChapter } from '../src/core/pipelines/amend'
import { recheckIssues, reviewChapter } from '../src/core/pipelines/review'
import { fixIssue, fixIssues, reviewByLead, reviseBook } from '../src/core/pipelines/revise'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/settings'
import { UsageStore } from '../src/core/usage'
import { estimateTokens } from '../src/shared/text'
import { FakeLlm, FakeRoles } from './support/harness'

const SOURCE = join(__dirname, '..', '.dev', 'workspace', process.env.MEASURE_BOOK ?? '红楼梦复现')
const WINDOW = Number(process.env.MEASURE_WINDOW ?? 1_000_000)

class WideLlm extends FakeLlm {
  override async contextWindow(): Promise<number | undefined> { return WINDOW }
}

describe.skipIf(process.env.MEASURE !== '1')('what mending sends', () => {
  it('prints the size of every request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-measure-'))
    const book = join(dir, 'book')
    await mkdir(book)
    for (const part of ['novel.json', 'outline.json', 'bible', 'manuscript', '.novel']) await cp(join(SOURCE, part), join(book, part), { recursive: true }).catch(() => {})
    const llm = new WideLlm(() => { throw new Error('measured') })
    const roles = new FakeRoles()
    roles.script = async () => { throw new Error('measured') }
    const settingsOf = (more: Record<string, unknown>) => new SettingsStore({ ...DEFAULT_SETTINGS, autoDigest: false, siftCast: false, settleSuggestions: false, recheckIssues: false, ...more }, join(dir, `settings-${Math.random()}.json`))
    const usage = new UsageStore(join(dir, 'usage'))
    await mkdir(join(dir, 'trash'))
    const open = async (more: Record<string, unknown> = {}) => {
      const core = new NovelCore({ llm, roles, credentials: namedKeySource(() => undefined), settings: settingsOf(more), usage, trash: { files: join(dir, 'trash') }, holding: join(dir, 'holding') })
      await core.ready()
      return { core, runtime: await core.runtime(book) }
    }
    const rows: string[] = []
    const task = { origin: 'user' as const }
    const size = (text: string | undefined): number => estimateTokens(text ?? '')
    const measure = async (name: string, agents: boolean, run: () => Promise<unknown>): Promise<void> => {
      roles.enabled = agents
      roles.tasks.length = 0
      llm.requests.length = 0
      let failed = ''
      try { await run() } catch (error) { failed = error instanceof Error ? error.message.slice(0, 80) : String(error) }
      const agent = roles.tasks[0]
      const call = llm.requests[0]
      if (agent !== undefined) rows.push(`${name}\tagent(${agent.role})\ttask ${size(agent.prompt)}\trules ${size(agent.rules)}\ttools ${agent.tools.length}\tchars ${agent.prompt.length}`)
      else if (call !== undefined) rows.push(`${name}\tcall\tprompt ${size(call.prompt)}\tsystem ${size(call.system)}\tchars ${call.prompt.length}`)
      else rows.push(`${name}\t(nothing sent)\t${failed}`)
      if (process.env.MEASURE_SECTIONS === name) {
        const whole = agent?.prompt ?? call?.prompt ?? ''
        const parts = whole.split(/\n(?=## )/)
        console.log(`\n===== ${name} =====\n${parts.map(part => `${size(part)}\t${part.split('\n')[0]!.slice(0, 60)}`).join('\n')}`)
      }
      if (process.env.MEASURE_DUMP === name) console.log(`\n===== ${name} =====\n${(agent?.prompt ?? call?.prompt ?? '').slice(0, 6000)}\n…\n${(agent?.prompt ?? call?.prompt ?? '').slice(-3000)}`)
    }

    const { core, runtime } = await open()
    const { project } = runtime
    const written = (await project.chapterInfos()).filter(info => info.hasText)
    const total = written.length
    const mid = written[Math.floor(total / 2)]!
    const next = written[Math.floor(total / 2) + 1]!
    const text = await project.chapterText(mid.id)
    const sentence = (text.split(/\n+/).find(paragraph => paragraph.length > 60 && !paragraph.startsWith('!')) ?? text).slice(0, 48)
    const other = await project.chapterText(next.id)
    rows.push(`book\t${total} chapters with text\twindow ${WINDOW}\tchapter ${mid.index} (${text.length} chars), next ${next.index} (${other.length} chars)`)
    let whole = 0
    for (const info of written) whole += size(await project.chapterText(info.id))
    rows.push(`book\tall text ≈ ${whole} tokens`)
    await project.saveReview({ chapterId: mid.id, textHash: 'x', createdAt: new Date().toISOString(), verdict: '', issues: [
      { id: 'q', severity: 'medium', type: 'style', quote: sentence, explanation: '这一句的比喻太满。', suggestion: '收一收。' },
      { id: 'n', severity: 'high', type: 'continuity', explanation: '这一章说她昨夜没睡，上一章却写她一觉睡到天亮。' },
    ] } as never)
    await project.saveReview({ chapterId: next.id, textHash: 'x', createdAt: new Date().toISOString(), verdict: '', issues: [
      { id: 'm', severity: 'high', type: 'logic', explanation: '她怎么知道信里写了什么，没有交代。' },
    ] } as never)

    await measure('审校这一章', true, async () => await reviewChapter(core, runtime, { chapter: mid.id }, task))
    await measure('审校这一章（非 agent）', false, async () => await reviewChapter(core, runtime, { chapter: mid.id }, task))
    await measure('修这个问题（策划定哪几处）', true, async () => await fixIssue(core, runtime, { chapter: mid.id, issue: 'n', scope: 'place' }, task))
    await measure('全局修复', true, async () => await fixIssue(core, runtime, { chapter: mid.id, issue: 'n', scope: 'book' }, task))
    await measure('只改引文这一处（编排模型写）', true, async () => await fixIssue(core, runtime, { chapter: mid.id, issue: 'q', scope: 'passage' }, task))
    await measure('整章重写', true, async () => await fixIssue(core, runtime, { chapter: mid.id, issue: 'n', scope: 'chapter' }, task))
    await measure('一起修 3 个（两章）', true, async () => await fixIssues(core, runtime, { issues: [{ chapter: mid.id, issue: 'q' }, { chapter: mid.id, issue: 'n' }, { chapter: next.id, issue: 'm' }] }, task))
    await measure('照引导审校 · 一章', true, async () => await reviewByLead(core, runtime, { lead: '她昨夜到底睡没睡，前后说得不一样', chapters: [mid.id] }, task))
    await measure('照引导审校 · 全线', true, async () => await reviewByLead(core, runtime, { lead: '她昨夜到底睡没睡，前后说得不一样' }, task))
    await measure('全书修订 · 全线', true, async () => await reviseBook(core, runtime, { instruction: '把她的称呼统一成"林姑娘"', asked: true }, task))
    await measure('改这一章', true, async () => await amendChapter(core, runtime, { chapter: mid.id, instruction: '对白口语一些' }, task))
    await measure('改这一章（非 agent）', false, async () => await amendChapter(core, runtime, { chapter: mid.id, instruction: '对白口语一些' }, task))
    await measure('采纳后核对', true, async () => await recheckIssues(core, runtime, { chapters: [mid.id], changes: '改了一句。' }, task))
    core.dispose()

    const writer = await open({ mendBy: 'writer' })
    await measure('只改引文这一处（写手写）', true, async () => await fixIssue(writer.core, writer.runtime, { chapter: mid.id, issue: 'q', scope: 'passage' }, task))
    writer.core.dispose()

    console.log(`\n${rows.join('\n')}\n`)
    await usage.settled().catch(() => {})
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }, 600_000)
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Live tests against a real OpenAI-compatible endpoint. Skipped unless
 * NOVEL_LIVE=1 with NOVEL_LIVE_BASE_URL, NOVEL_LIVE_API_KEY and
 * NOVEL_LIVE_MODEL set. They cost a few cents and print the model output so
 * prompts can be judged by eye. A model that reasons before answering makes
 * them take many minutes; prefer one that does not:
 *
 *   NOVEL_LIVE=1 NOVEL_LIVE_BASE_URL=https://…/v1 NOVEL_LIVE_API_KEY=… NOVEL_LIVE_MODEL=… npx vitest run tests/live.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NovelCore, type ProjectRuntime } from '../src/core/core'
import { buildAudioScript } from '../src/core/pipelines/audio'
import { expandCharacter } from '../src/core/pipelines/bible'
import { deriveBeats, buildFoundation } from '../src/core/pipelines/plot'
import { playTurn, startPlay } from '../src/core/pipelines/play'
import { reviewChapter } from '../src/core/pipelines/review'
import { reviseSpan } from '../src/core/pipelines/revise'
import { writeChapter } from '../src/core/pipelines/write'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/settings'
import { UsageStore } from '../src/core/usage'
import { createOpenAiBackend } from './support/openai-backend'
import { namedKeySource } from '../src/core/media/http'

const live = process.env.NOVEL_LIVE === '1' && process.env.NOVEL_LIVE_API_KEY !== undefined
const show = (title: string, value: unknown): void => { console.log(`\n━━━ ${title} ━━━\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`) }

describe.skipIf(!live)('live pipelines', () => {
  let dir: string
  let core: NovelCore
  let runtime: ProjectRuntime

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'novel-live-'))
    const llm = createOpenAiBackend({ baseURL: process.env.NOVEL_LIVE_BASE_URL!, apiKey: process.env.NOVEL_LIVE_API_KEY!, model: process.env.NOVEL_LIVE_MODEL! })
    core = new NovelCore({ llm, credentials: namedKeySource(), settings: new SettingsStore({ ...DEFAULT_SETTINGS }, join(dir, 'settings.json')), usage: new UsageStore(join(dir, 'usage')), log: (message, error) => { console.warn(message, error) } })
    await core.ready()
    runtime = await core.create(join(dir, 'book'), { title: '未命名', language: 'zh' })
  })
  afterAll(async () => {
    core.dispose()
    if (process.env.NOVEL_LIVE_KEEP !== '1') await rm(dir, { recursive: true, force: true })
    else console.log(`kept ${dir}`)
  })

  it('builds a foundation from an idea', async () => {
    const result = await buildFoundation(core, runtime, { idea: '民国上海，一个靠替人代写情书为生的落魄女校书，发现自己写出的信会让收信人在七天内死去。她必须查清这支笔的来历，同时躲避一个也在找这支笔的巡捕房探长。基调：悬疑、克制的浪漫、带一点志怪。' }, { origin: 'user' })
    show('foundation', result)
    const state = await runtime.project.state()
    show('manifest', state.manifest)
    show('characters', state.characters.map(card => `${card.name}（${card.role}）${card.tagline ?? ''}`))
    show('outline', state.outline.volumes.map(volume => ({ title: volume.title, chapters: volume.chapters.map(chapter => `${chapter.title}：${chapter.synopsis ?? ''}`) })))
    expect(result.characters).toBeGreaterThan(2)
    expect(result.chapters).toBeGreaterThan(2)
  }, 900_000)

  it('expands a character and derives beats', async () => {
    const lead = (await runtime.project.characters()).find(card => card.role === 'protagonist')!
    const expanded = await expandCharacter(core, runtime, { character: lead.id }, { origin: 'user' })
    show('expanded character', expanded.card)
    const beats = await deriveBeats(core, runtime, { chapter: '1' }, { origin: 'user' })
    show('beats', beats.beats)
    expect(beats.beats.length).toBeGreaterThan(2)
  }, 900_000)

  it('drafts the first chapter and digests it', async () => {
    const result = await writeChapter(core, runtime, { chapter: '1', words: 1500, brief: '开场不要解释设定，从一封正在写的信切入。' }, { origin: 'user' })
    show('write result', result)
    show('chapter text', await runtime.project.chapterText(result.chapterId))
    show('memory', await runtime.project.memory(result.chapterId))
    show('suggestions', (await runtime.project.suggestions()).map(item => item.title))
    expect(result.wordsWritten).toBeGreaterThan(600)
    expect(result.digested).toBe(true)
  }, 900_000)

  it('revises a passage, reviews the chapter and scripts its audio', async () => {
    const text = await runtime.project.chapterText('ch001')
    const firstParagraph = text.split('\n').find(line => line.trim().length > 30)!
    const revision = await reviseSpan(core, runtime, { chapter: 'ch001', quote: firstParagraph, instruction: '更短、更冷，去掉所有比喻', apply: true }, { origin: 'user' })
    show('revision', { before: revision.before, after: revision.after })
    const review = await reviewChapter(core, runtime, { chapter: 'ch001' }, { origin: 'user' })
    show('review', review)
    const script = await buildAudioScript(core, runtime, { chapter: 'ch001' }, { origin: 'user' })
    show('audio script (first 14 lines)', script.lines.slice(0, 14))
    show('cues', script.cues)
    expect(script.lines.length).toBeGreaterThan(5)
  }, 900_000)

  it('plays two turns of an interlude', async () => {
    const characters = await runtime.project.characters()
    const lead = characters.find(card => card.role === 'protagonist')!
    const other = characters.find(card => card.id !== lead.id)!
    const session = await startPlay(core, runtime, { situation: `深夜，${other.name}突然敲开了${lead.name}的房门，手里拿着一封${lead.name}三天前代写的信。`, cast: [other.id], player: lead.id, tone: '压抑、试探' }, { origin: 'user' })
    show('opening turn', session.turns[0])
    const { turn } = await playTurn(core, runtime, { session: session.id, text: '我把门只开了一条缝，问他这么晚来做什么。' }, { origin: 'user' })
    show('second turn', turn)
    expect(turn.lines.every(line => line.character !== lead.id)).toBe(true)
  }, 900_000)
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/** The usage ledger, the prompt for what is not set up, and which protocol drives a speech model. */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { missingCapability } from '../src/client/store'
import { illustrate } from '../src/core/pipelines/illustrate'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import { costOf, describeRow, rangeStart, summarize, UsageStore } from '../src/core/usage'
import { speechProtocol } from '../src/shared/services'
import type { UsageEvent } from '../src/shared/types'
import { createTestBed, FakeImages, type TestBed } from './support/harness'

let dir: string | undefined
let bed: TestBed | undefined
afterEach(async () => {
  await bed?.cleanup()
  bed = undefined
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const at = (day: string, time = '10:00:00'): string => new Date(`${day}T${time}`).toISOString()

describe('the usage ledger', () => {
  it('keeps one line per call, a file per month, and reads back what a period holds', async () => {
    dir = await mkdtemp(join(tmpdir(), 'novel-usage-'))
    const store = new UsageStore(dir)
    store.record({ at: at('2026-09-30'), kind: 'text', model: 'a', via: 'x', input: 10, output: 5 })
    store.record({ at: at('2026-10-02'), kind: 'image', model: 'b', via: 'y', images: 1 })
    store.record({ at: at('2026-10-03'), kind: 'speech', model: 'c', via: 'z', chars: 40, seconds: 6 })
    await store.settled()
    expect((await readdir(dir)).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl'])
    expect((await store.read()).map(event => event.model)).toEqual(['a', 'b', 'c'])
    // What came before the first line was never counted — the ledger says when it began.
    expect(await store.begun()).toBe(at('2026-09-30'))
    expect((await store.read(Date.parse(at('2026-10-01')))).map(event => event.model)).toEqual(['b', 'c'])
    // A line cut short by a crash costs that one call, not the ledger.
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(dir, '2026-10.jsonl'), '{"at":"2026-10-0')
    expect(await store.read()).toHaveLength(3)
    expect(await new UsageStore(join(dir, 'nowhere')).read()).toEqual([])
    expect(await new UsageStore(join(dir, 'nowhere')).begun()).toBeUndefined()
  })

  it('costs a call only by the prices that apply to it', () => {
    const text: UsageEvent = { at: at('2026-10-01'), kind: 'text', model: 'm', via: 'x', input: 2_000_000, output: 500_000 }
    expect(costOf(text, { input: 2, output: 8 })).toBe(8)
    expect(costOf(text, { input: 2 })).toBe(4)
    expect(costOf(text, undefined)).toBeUndefined()
    // A price that says nothing about what was used is no price for this call.
    expect(costOf(text, { image: 0.2 })).toBeUndefined()
    expect(costOf({ at: at('2026-10-01'), kind: 'image', model: 'i', via: 'x', images: 3 }, { image: 0.25 })).toBe(0.75)
    const speech: UsageEvent = { at: at('2026-10-01'), kind: 'speech', model: 's', via: 'x', chars: 20_000, seconds: 120 }
    expect(costOf(speech, { minute: 0.5 })).toBe(1)
    expect(costOf(speech, { chars10k: 2 })).toBe(4)
  })

  it('adds up by model, role, book and day, and says what has no price', () => {
    const events: UsageEvent[] = [
      { at: at('2026-10-01'), kind: 'text', model: 'writer-model', via: 'h', role: 'writer', book: '/b/one', bookTitle: '甲', input: 1_000_000, output: 200_000 },
      { at: at('2026-10-01', '11:00:00'), kind: 'text', model: 'writer-model', via: 'h', role: 'writer', book: '/b/one', bookTitle: '甲（改名）', input: 1_000_000, output: 0, estimated: true },
      { at: at('2026-10-02'), kind: 'text', model: 'flash', via: 'h', role: 'analyst', book: '/b/two', bookTitle: '乙', input: 500_000, output: 100_000 },
      { at: at('2026-10-02'), kind: 'image', model: 'painter', via: 'h', book: '/b/one', bookTitle: '甲（改名）', images: 2 },
      { at: at('2026-10-02'), kind: 'speech', model: 'voice', via: 'h', chars: 100, seconds: 90 },
    ]
    const summary = summarize(events, { 'writer-model': { input: 3, output: 10, currency: '$' }, painter: { image: 0.2 } })
    expect(summary.total).toMatchObject({ calls: 5, input: 2_500_000, output: 300_000, images: 2, seconds: 90, estimated: true, unpriced: true })
    expect(summary.total.cost).toEqual([{ currency: '$', amount: 8 }, { currency: '¥', amount: 0.4 }])
    expect(summary.unpriced).toEqual(['flash', 'voice'])
    expect(summary.byModel.map(row => row.label)).toEqual(['writer-model', 'flash', 'painter', 'voice'])
    expect(summary.byRole.map(row => row.key)).toEqual(['writer', 'analyst', 'image', 'speech'])
    // A book goes by its latest title; calls for no book are kept apart.
    expect(summary.byBook.map(row => [row.label, row.calls])).toEqual([['甲（改名）', 3], ['乙', 1], ['', 1]])
    expect(summary.byDay.map(row => [row.key, row.calls])).toEqual([['2026-10-01', 2], ['2026-10-02', 3]])
    expect(describeRow(summary.byModel[0]!)).toBe('writer-model: 2 calls, ≈2.00M in / 200k out tokens — $8.00')
    expect(describeRow(summary.byModel[1]!)).toContain('no price set')
  })

  it('starts a period at the beginning of a local day', () => {
    const now = new Date('2026-10-07T15:30:00').getTime()
    expect(new Date(rangeStart('today', now)).getHours()).toBe(0)
    expect(rangeStart('7d', now)).toBe(rangeStart('today', now) - 6 * 86_400_000)
    expect(rangeStart('all', now)).toBe(0)
  })

  it('counts the calls a book makes: text by role, pictures by model', async () => {
    const images = new FakeImages()
    bed = await createTestBed({ settings: { image: { ...DEFAULT_SETTINGS.image, provider: 'codex' } }, bridges: images.bridges })
    bed.llm.responder = () => ({ text: '{"appearance": "高瘦的女子，黑发低挽", "negative": ""}', finish: 'stop', usage: { inputTokens: 1200, outputTokens: 40 } })
    // (Nothing says how she looks yet: the director writes her appearance before she is drawn — a text call, then the picture.)
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚' })
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, { origin: 'user' })
    const events = await bed.core.usage.read()
    expect(events.map(event => event.kind)).toEqual(['text', 'image'])
    expect(events[0]).toMatchObject({ role: 'director', model: 'fake-model', via: 'fake', input: 1200, output: 40, book: bed.runtime.project.root, bookTitle: '测试之书' })
    expect(events[0]!.estimated).toBeUndefined()
    expect(events[1]).toMatchObject({ kind: 'image', model: 'gpt-image', via: 'codex', images: 1, book: bed.runtime.project.root })
    // An endpoint that reports nothing is counted by the length of the text.
    bed.llm.responder = () => '{"appearance": "高瘦的女子，比先前写的更高些", "negative": ""}'
    const { deriveVisual } = await import('../src/core/pipelines/illustrate')
    await deriveVisual(bed.core, bed.runtime, { character: card.id }, { origin: 'user' })
    const last = (await bed.core.usage.read()).at(-1)!
    expect(last.estimated).toBe(true)
    expect(last.input).toBeGreaterThan(100)
    // Nothing of a test reaches the real Harness home.
    expect(await readFile(join(bed.dir, 'usage', `${new Date().toISOString().slice(0, 7)}.jsonl`), 'utf8')).toContain('"kind":"image"')
  })
})

describe('what is not set up', () => {
  it('tells a missing capability from an ordinary failure', () => {
    expect(missingCapability('speech synthesis is not configured — set a speech endpoint in Novel Studio → Settings')).toBe('tts')
    expect(missingCapability('Speech: no API key is saved for dashscope.aliyuncs.com — paste it in Novel Studio → Settings')).toBe('tts')
    expect(missingCapability('image generation is not configured — set an image endpoint in Novel Studio → Settings')).toBe('image')
    expect(missingCapability('ChatGPT is not signed in — authorize under Harness Settings → Models → Openai-Codex, then try again')).toBe('image')
    expect(missingCapability('Embeddings: no API key is saved for openrouter.ai — paste it in Novel Studio → Settings')).toBe('embedding')
    expect(missingCapability('qwen3.8-max: no API key is saved for dashscope.aliyuncs.com — paste it in Novel Studio → Settings')).toBe('text')
    expect(missingCapability('qwen-image-3.0: HTTP 429 rate limited')).toBeUndefined()
    expect(missingCapability('no chapter matches "9"')).toBeUndefined()
  })
})

describe('speech protocols', () => {
  it('knows which of a service\'s speech models the Studio can drive, and how', () => {
    expect(speechProtocol('bailian', 'qwen-audio-3.1-tts-next')).toBe('qwen-audiogen')
    expect(speechProtocol('bailian', 'qwen3-tts-instruct-flash')).toBe('dashscope')
    expect(speechProtocol('bailian', 'qwen-tts-2025-05-22')).toBe('dashscope')
    expect(speechProtocol('bailian', 'qwen3-tts-vd-2026-01-26')).toBe('dashscope')
    expect(speechProtocol('bailian', 'qwen3.8-omni-flash-realtime')).toBe('qwen-realtime')
    // Streaming-synthesis sockets and third-party models are served, but over protocols the Studio does not speak yet.
    expect(speechProtocol('bailian', 'qwen3-tts-flash-realtime')).toBeUndefined()
    expect(speechProtocol('bailian', 'qwen-audio-3.1-realtime-plus')).toBeUndefined()
    expect(speechProtocol('bailian', 'MiniMax/speech-2.8-hd')).toBeUndefined()
    expect(speechProtocol('openrouter', 'google/gemini-3.8-flash-tts')).toBe('openrouter')
    expect(speechProtocol('custom', 'gpt-4o-mini-tts')).toBe('openai')
  })
})

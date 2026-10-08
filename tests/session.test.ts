// SPDX-License-Identifier: LGPL-3.0-or-later
/** The book a conversation is on, and how much of a book a call may carry. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { focusLines, movedContext, noProjectContext } from '../src/agent/prompt'
import { listOf, listParameter } from '../src/agent/tools/shared'
import { ASSUMED_CONTEXT_WINDOW, contextBudgets } from '../src/core/context'
import { knownContextWindow } from '../src/core/media/discovery'
import { SessionStateStore } from '../src/core/session-state'
import { DEFAULT_SETTINGS, SETTINGS_REVISION, SettingsStore } from '../src/core/settings'
import { displayPath } from '../src/core/util/fs'
import { createTestBed, type TestBed } from './support/harness'

let dir: string | undefined
let bed: TestBed | undefined
afterEach(async () => {
  await bed?.cleanup()
  bed = undefined
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'novel-session-'))
  return dir
}

describe('the book in play', () => {
  it('remembers which books a session has been on and who moved it last', async () => {
    const store = new SessionStateStore(join(await scratch(), 'sessions.json'))
    const seen: string[] = []
    store.onChange(id => seen.push(id))

    // The session started on its workspace's only book without ever being bound to it.
    const first = await store.update('s1', { project: '/w/b' }, { by: 'author', from: '/w/a' })
    expect(first.books).toEqual(['/w/a', '/w/b'])
    expect(first.switched).toMatchObject({ from: '/w/a', by: 'author' })

    const second = await store.update('s1', { project: '/w/a' }, { by: 'agent' })
    expect(second.books).toEqual(['/w/b', '/w/a'])
    expect(second.switched).toMatchObject({ from: '/w/b', by: 'agent' })

    // Opening the book the session is already on is not a move.
    const again = await store.update('s1', { project: '/w/a' }, { by: 'author', from: '/w/a' })
    expect(again.switched).toMatchObject({ from: '/w/b', by: 'agent' })
    expect(again.books).toEqual(['/w/b', '/w/a'])

    // A change of mode leaves the book alone.
    const mode = await store.update('s1', { mode: 'review' })
    expect(mode).toMatchObject({ mode: 'review', project: '/w/a', books: ['/w/b', '/w/a'] })
    expect(store.peek('s1')?.project).toBe('/w/a')
    expect(seen).toEqual(['s1', 's1', 's1', 's1'])
  })

  it('survives a restart', async () => {
    const file = join(await scratch(), 'sessions.json')
    await new SessionStateStore(file).update('s1', { project: '/w/b' }, { by: 'author', from: '/w/a' })
    const reloaded = await new SessionStateStore(file).get('s1')
    expect(reloaded).toMatchObject({ project: '/w/b', books: ['/w/a', '/w/b'], switched: { from: '/w/a', by: 'author' } })
  })

  it('tells the model which book it is on, how the session got there and what else is near', () => {
    const plain = focusLines({ title: '白页遗骸', path: '白页遗骸', zh: true, others: [] })
    expect(plain).toBe('【当前作品】《白页遗骸》（白页遗骸）——这场对话和旁边的小说工坊此刻都在这本书上，工具调用默认作用于它。')

    const moved = focusLines({
      title: '白页遗骸',
      path: '白页遗骸',
      zh: true,
      switched: { from: '七日未寄', by: 'author', at: '2026-10-07T09:41:12.000Z' },
      others: [{ title: '七日未寄', relative: '七日未寄' }],
    })
    expect(moved).toContain('作者在工坊里把会话从《七日未寄》切到了这本书（2026-10-07 09:41 UTC）')
    expect(moved).toContain('在那之前的对话谈的是《七日未寄》')
    expect(moved).toContain('附近的其他作品：《七日未寄》（七日未寄）')

    const byAgent = focusLines({ title: 'Ash', path: 'ash', zh: false, switched: { from: 'Ember', by: 'agent', at: '2026-10-07T09:41:12.000Z' }, others: [] })
    expect(byAgent).toContain('you moved the session here with a tool from "Ember"')
    expect(byAgent).toContain('[Book in play] "Ash" (ash)')
  })

  it('says so when no book is in play, or when the digest lags a change of book', () => {
    expect(noProjectContext('/w', 'draft')).toContain('no novel project in /w yet')
    expect(noProjectContext('/w', 'draft', [{ title: '甲', relative: 'a' }])).toContain('Books in reach: "甲" (a)')
    expect(movedContext('b')).toContain('moved this session onto the book at b')
  })

  it('names a book by a path a person can find', () => {
    expect(displayPath('/w', '/w')).toBe('.')
    expect(displayPath('/w', '/w/book')).toBe('book')
    expect(displayPath('/w', '/elsewhere/book')).toBe('/elsewhere/book')
  })
})

describe('list parameters', () => {
  it('reads a list however a model wrote it', () => {
    expect(listOf(['电灯', ' 现代物品 ', '', 3])).toEqual(['电灯', '现代物品'])
    expect(listOf('电灯、现代物品, neon signs')).toEqual(['电灯', '现代物品', 'neon signs'])
    expect(listOf('["电灯", "现代物品"]')).toEqual(['电灯', '现代物品'])
    expect(listOf('[not json')).toEqual(['[not json'])
    expect(listOf(undefined)).toBeUndefined()
    expect(listOf('')).toEqual([])
  })

  it('declares both forms to the model', () => {
    expect(listParameter('Chapters.', { enum: ['a', 'b'] as const })).toEqual({
      description: 'Chapters. A list of strings; one comma-separated string works too.',
      oneOf: [{ type: 'array', items: { type: 'string', enum: ['a', 'b'] } }, { type: 'string' }],
    })
  })
})

describe('context budget', () => {
  it('has no figure of its own by default, and lets go of the old defaults once', async () => {
    expect(DEFAULT_SETTINGS.context.budgetTokens).toBeUndefined()
    const file = join(await scratch(), 'settings.json')
    // Figures that were only ever a default — the context budget, the speech requests at once — follow the new defaults.
    await writeFile(file, JSON.stringify({ context: { budgetTokens: 500_000, tailChars: 1234 }, tts: { provider: 'qwen-audiogen', concurrency: 2 } }))
    const migrated = await new SettingsStore(DEFAULT_SETTINGS, file).get()
    expect(migrated.context).toEqual({ strategy: 'auto', tailChars: 1234 })
    expect(migrated.tts.concurrency).toBeUndefined()
    expect(migrated.revision).toBe(SETTINGS_REVISION)
    // What the author chose stays.
    await writeFile(file, JSON.stringify({ context: { budgetTokens: 120_000 }, tts: { provider: 'qwen-audiogen', concurrency: 8 } }))
    const kept = await new SettingsStore(DEFAULT_SETTINGS, file).get()
    expect(kept.context.budgetTokens).toBe(120_000)
    expect(kept.tts.concurrency).toBe(8)
    // Once a file is saved it carries the revision, and a figure set afterwards is never taken for an old default again.
    const store = new SettingsStore(DEFAULT_SETTINGS, file)
    await store.update({ tts: { concurrency: 3 } })
    expect((await new SettingsStore(DEFAULT_SETTINGS, file).get()).tts.concurrency).toBe(3)
  })

  it('gives the text half of the model\'s window, and never more than the window holds', () => {
    // A million-token model: half of it for the manuscript's own text.
    expect(contextBudgets('auto', undefined, 1_000_000).textBudget).toBe(500_000)
    // An unknown window is taken for a safe 200k.
    expect(contextBudgets('auto', undefined, undefined)).toMatchObject({ textBudget: ASSUMED_CONTEXT_WINDOW / 2, window: ASSUMED_CONTEXT_WINDOW })
    // The author's figure is used as given…
    expect(contextBudgets('auto', 300_000, 1_000_000).textBudget).toBe(300_000)
    // …but never past what the window leaves room for beside the bible and the reply.
    const small = contextBudgets('auto', 300_000, 32_000)
    expect(small.textBudget).toBeLessThan(32_000 - small.sideBudget)
    expect(contextBudgets('retrieval', undefined, 1_000_000).textBudget).toBe(0)
    expect(contextBudgets('full', undefined, 1_000_000).textBudget).toBeGreaterThan(800_000)
  })

  it('knows the windows of the current long-context models', () => {
    for (const model of ['qwen3.8-max', 'deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash', 'gpt-6.1-sol', 'anthropic/claude-sonnet-5.5']) expect(knownContextWindow(model)).toBe(1_000_000)
    expect(knownContextWindow('some-local-model')).toBeUndefined()
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/** The recommendations as data: the file that ships, how an issue is read, and how an author's settings follow one. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/settings'
import { adoptedNow, followRecommended, noteAdopted, recommendedChanges, recommendedView, settleRecommended } from '../src/host/recommended'
import { BUILTIN_RECOMMENDED, knownOutput, knownWindow, parseRecommended, providerDefault, recommended, setRecommended, unlistedModels, type Recommended } from '../src/shared/recommended'
import { recommendedSetup, setupPatch } from '../src/shared/services'

/** A later issue: the built-in one with something recommended otherwise. */
function issue(version: number, change: (table: Recommended) => void): Recommended {
  const table = structuredClone(BUILTIN_RECOMMENDED)
  table.version = version
  table.date = '2027-01-01'
  change(table)
  return table
}

let dir: string
let store: SettingsStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'novel-recommended-'))
  store = new SettingsStore(DEFAULT_SETTINGS, join(dir, 'settings.json'))
  setRecommended(BUILTIN_RECOMMENDED)
})

afterEach(async () => {
  setRecommended(BUILTIN_RECOMMENDED)
  await rm(dir, { recursive: true, force: true })
})

/** Settings as a one-click setup of a service leaves them. */
async function setUp(service: 'bailian' | 'openrouter' | 'openai'): Promise<void> {
  const patch = setupPatch(recommendedSetup(service)!, ['embedding', 'image', 'tts'])
  await store.update(patch as never)
}

describe('the file that ships', () => {
  it('is an issue, and the one the build was made with', async () => {
    const file = JSON.parse(await readFile(new URL('../recommended.json', import.meta.url), 'utf8')) as unknown
    expect(parseRecommended(file)).toEqual(BUILTIN_RECOMMENDED)
    expect(BUILTIN_RECOMMENDED.version).toBeGreaterThanOrEqual(1)
    expect(BUILTIN_RECOMMENDED.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('names a model for every kind of endpoint the code can ask about', () => {
    for (const kind of ['dashscope', 'openai', 'openrouter']) expect(BUILTIN_RECOMMENDED.providers?.image?.[kind]?.model, `image.${kind}`).toBeTruthy()
    for (const kind of ['qwen-audiogen', 'qwen-realtime', 'dashscope', 'openrouter', 'openai']) expect(BUILTIN_RECOMMENDED.providers?.tts?.[kind]?.model, `tts.${kind}`).toBeTruthy()
    expect(BUILTIN_RECOMMENDED.providers?.sound?.['qwen-audiogen']?.model).toBeTruthy()
    expect(BUILTIN_RECOMMENDED.providers?.tts?.dashscope?.designedVoiceModel).toBeTruthy()
  })

  it('gives every service with a one-click setup its three slots, each at an address', () => {
    for (const service of ['bailian', 'openrouter', 'openai'] as const) {
      const setup = recommendedSetup(service)!
      for (const part of ['embedding', 'image', 'tts'] as const) {
        expect(setup[part].model, `${service}.${part}`).toBeTruthy()
        expect(setup[part].baseURL, `${service}.${part}`).toMatch(/^https:\/\//)
        expect(setup.suggestions[part]).toContain(setup[part].model)
      }
    }
    // Bailian's own API takes the bare domain; what speaks OpenAI's dialect takes the compatible base.
    expect(recommendedSetup('bailian')!.image.baseURL).toBe('https://dashscope.aliyuncs.com')
    expect(recommendedSetup('bailian')!.embedding.baseURL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(recommendedSetup('bailian', 'https://ws-abc.cn-beijing.maas.aliyuncs.com')!.tts.baseURL).toBe('https://ws-abc.cn-beijing.maas.aliyuncs.com')
    expect(recommendedSetup('custom')).toBeUndefined()
  })

  it('knows the windows of the usual model families by their names', () => {
    expect(knownWindow('deepseek-v4.1-flash')).toBe(1_000_000)
    expect(knownWindow('qwen/qwen3.7-plus')).toBe(1_000_000)
    expect(knownWindow('some-small-model')).toBeUndefined()
    expect(knownOutput('deepseek-v4.1-flash')).toBe(384_000)
    expect(unlistedModels('bailian', 'tts')).toEqual([providerDefault('tts', 'qwen-audiogen').model])
  })
})

describe('reading an issue', () => {
  it('leaves out what it does not understand and keeps the rest', () => {
    const read = parseRecommended({
      version: 3.7,
      date: '2027-02-03',
      services: { bailian: { image: { provider: 'dashscope', model: 'img-next' }, tts: { model: 'no provider' }, embedding: 'nonsense' }, broken: 7 },
      providers: { image: { dashscope: { model: 'img-next' }, bad: { size: 1 } }, video: { x: { model: 'y' } } },
      windows: [{ match: '^big-', tokens: 2_000_000 }, { match: '(', tokens: 5 }, { match: 'x', tokens: -1 }, 'nonsense'],
    })!
    expect(read.version).toBe(3)
    expect(read.services.bailian).toEqual({ image: { provider: 'dashscope', model: 'img-next' } })
    expect(read.services.broken).toBeUndefined()
    expect(read.providers).toEqual({ image: { dashscope: { model: 'img-next' } } })
    expect(read.windows).toEqual([{ match: '^big-', tokens: 2_000_000 }])
  })

  it('refuses what is no issue at all', () => {
    for (const raw of [undefined, null, 'text', 7, {}, { version: 0, services: {} }, { version: 2 }, { services: {} }]) expect(parseRecommended(raw)).toBeUndefined()
  })

  it('takes a newer issue, not an older one than the build knows', () => {
    const next = issue(BUILTIN_RECOMMENDED.version + 1, (table) => { table.windows = [{ match: '^big-', tokens: 2_000_000 }] })
    expect(setRecommended(next)).toBe(next)
    expect(knownWindow('big-one')).toBe(2_000_000)
    expect(knownWindow('deepseek-v4.1-flash')).toBeUndefined()
    expect(setRecommended({ ...next, version: BUILTIN_RECOMMENDED.version - 1 })).toBe(next)
    expect(setRecommended(undefined)).toBe(next)
    expect(recommended()).toBe(next)
  })

  it('falls back on the build\'s own model for a kind an issue leaves out', () => {
    setRecommended(issue(BUILTIN_RECOMMENDED.version + 1, (table) => { table.providers = { image: { dashscope: { model: 'img-next' } } } }))
    expect(providerDefault('image', 'dashscope').model).toBe('img-next')
    expect(providerDefault('tts', 'openai').model).toBe(BUILTIN_RECOMMENDED.providers!.tts!.openai!.model)
    expect(providerDefault('image', 'nobody').model).toBe('')
  })
})

describe('following the recommendations', () => {
  const newer = (): Recommended => issue(BUILTIN_RECOMMENDED.version + 1, (table) => {
    table.services.bailian!.image!.model = 'qwen-image-next'
    table.services.openrouter!.tts!.model = 'vendor/tts-next'
    table.services.openrouter!.tts!.narratorVoice = 'Vega'
  })

  it('notes, the first time, which settings are a recommendation — and changes none', async () => {
    await setUp('bailian')
    await store.update({ embedding: { model: 'my-own-embedding' } } as never)
    const before = await store.get()
    await followRecommended(store)
    const after = await store.get()
    expect(after.recommended).toEqual({ version: BUILTIN_RECOMMENDED.version, adopted: { 'image.model': before.image.model, 'tts.model': before.tts.model } })
    expect({ ...after, recommended: undefined }).toEqual({ ...before, recommended: undefined })
    // Nothing is a recommendation where no service is set up.
    expect(adoptedNow(DEFAULT_SETTINGS)).toEqual({})
  })

  it('moves what was a recommendation to the new one, says what moved, and leaves the author\'s own choices', async () => {
    await setUp('bailian')
    await store.update({ embedding: { model: 'my-own-embedding' } } as never)
    await followRecommended(store)
    const old = (await store.get()).image.model!
    setRecommended(newer())
    await followRecommended(store)
    const after = await store.get()
    expect(after.image.model).toBe('qwen-image-next')
    expect(after.embedding.model).toBe('my-own-embedding')
    expect(after.tts.model).toBe(BUILTIN_RECOMMENDED.services.bailian!.tts!.model)
    expect(after.recommended?.notice).toEqual({ version: BUILTIN_RECOMMENDED.version + 1, date: '2027-01-01', changes: [{ key: 'image.model', from: old, to: 'qwen-image-next' }] })
    expect(after.recommended?.adopted?.['image.model']).toBe('qwen-image-next')
    expect(recommendedView(after)).toMatchObject({ version: BUILTIN_RECOMMENDED.version + 1, follow: true, notice: { changes: [{ key: 'image.model' }] } })
    // The same issue again changes nothing more, and "got it" puts the notice away.
    await followRecommended(store)
    expect((await store.get()).recommended?.notice?.changes).toHaveLength(1)
    expect((await settleRecommended(store, 'dismiss')).recommended?.notice).toBeUndefined()
    expect((await store.get()).image.model).toBe('qwen-image-next')
  })

  it('takes the narrator\'s voice along with its model, and never moves a voice on its own', async () => {
    await setUp('openrouter')
    await followRecommended(store)
    const before = await store.get()
    setRecommended(newer())
    expect(recommendedChanges(before, before.recommended!.adopted!)).toEqual([
      { key: 'tts.model', from: before.tts.model, to: 'vendor/tts-next' },
      { key: 'tts.narratorVoice', from: 'Charon', to: 'Vega' },
    ])
    setRecommended(issue(BUILTIN_RECOMMENDED.version + 2, (table) => { table.services.openrouter!.tts!.narratorVoice = 'Vega' }))
    expect(recommendedChanges(before, before.recommended!.adopted!)).toEqual([])
  })

  it('can take back what an issue changed: those settings are the author\'s own from then on', async () => {
    await setUp('bailian')
    await followRecommended(store)
    const old = (await store.get()).image.model!
    setRecommended(newer())
    await followRecommended(store)
    const reverted = await settleRecommended(store, 'revert')
    expect(reverted.image.model).toBe(old)
    expect(reverted.recommended?.notice).toBeUndefined()
    expect(reverted.recommended?.adopted?.['image.model']).toBeUndefined()
    // A later issue leaves it alone, and has nothing to say about it.
    setRecommended(issue(BUILTIN_RECOMMENDED.version + 2, (table) => { table.services.bailian!.image!.model = 'qwen-image-after-next' }))
    await followRecommended(store)
    const later = await store.get()
    expect(later.image.model).toBe(old)
    expect(later.recommended?.notice).toBeUndefined()
    expect(later.recommended?.version).toBe(BUILTIN_RECOMMENDED.version + 2)
  })

  it('only tells an author who does not follow, and does what they then say', async () => {
    await setUp('bailian')
    await followRecommended(store)
    await store.update({ recommended: { follow: false } } as never)
    const old = (await store.get()).image.model!
    setRecommended(newer())
    await followRecommended(store)
    const told = await store.get()
    expect(told.image.model).toBe(old)
    expect(told.recommended?.notice).toMatchObject({ pending: true, changes: [{ key: 'image.model', from: old, to: 'qwen-image-next' }] })
    expect(recommendedView(told).follow).toBe(false)
    // Taking it up moves exactly what the notice named.
    const adopted = await settleRecommended(store, 'adopt')
    expect(adopted.image.model).toBe('qwen-image-next')
    expect(adopted.recommended?.notice).toBeUndefined()
    expect(adopted.recommended?.follow).toBe(false)
  })

  it('does not ask again about settings the author said to keep', async () => {
    await setUp('bailian')
    await followRecommended(store)
    await store.update({ recommended: { follow: false } } as never)
    const old = (await store.get()).image.model!
    setRecommended(newer())
    await followRecommended(store)
    const kept = await settleRecommended(store, 'keep')
    expect(kept.image.model).toBe(old)
    expect(kept.recommended?.notice).toBeUndefined()
    setRecommended(issue(BUILTIN_RECOMMENDED.version + 2, (table) => { table.services.bailian!.image!.model = 'qwen-image-after-next' }))
    await followRecommended(store)
    expect((await store.get()).recommended?.notice).toBeUndefined()
    expect((await store.get()).image.model).toBe(old)
  })

  it('does not overwrite a setting changed since the notice was written', async () => {
    await setUp('bailian')
    await followRecommended(store)
    await store.update({ recommended: { follow: false } } as never)
    setRecommended(newer())
    await followRecommended(store)
    await store.update({ image: { model: 'chosen-in-between' } } as never)
    expect((await settleRecommended(store, 'adopt')).image.model).toBe('chosen-in-between')
  })

  it('counts a setting as a recommendation once the author sets it to what is recommended', async () => {
    await followRecommended(store)
    expect((await store.get()).recommended?.adopted).toEqual({})
    // Listening to the settings it writes to: the second call finds nothing new and writes nothing.
    let writes = 0
    store.onChange(() => { writes += 1 })
    await setUp('openai')
    await noteAdopted(store)
    await noteAdopted(store)
    expect(writes).toBe(2)
    const settings = await store.get()
    expect(settings.recommended?.adopted).toEqual({ 'image.model': settings.image.model, 'tts.model': settings.tts.model, 'tts.narratorVoice': 'alloy', 'embedding.model': settings.embedding.model })
  })
})

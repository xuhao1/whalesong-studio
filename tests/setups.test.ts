// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Services the author moves between, and services a book has of its own.
 *
 * A service left for another is remembered as it was set up and comes back as
 * it was left; a book that names a service draws and speaks with it, whatever
 * the Studio's settings say — and nothing of the Studio's service is mixed in.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageService, imageSetupName, imageSourceOf, switchImage, switchTts, withBook, withBookImage } from '../src/shared/images'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings'
import type { ImageSettings, NovelSettings, TtsSettings } from '../src/shared/types'
import { createTestBed, PIXEL } from './support/harness'

const B64 = Buffer.from(PIXEL).toString('base64')

describe('moving between services', () => {
  const own: ImageSettings = { provider: 'openai', baseURL: 'http://100.86.130.94:8188/v1', model: 'qwen-image-2.1-turbo-nf4', sizes: ['768x768'], promptTokens: 256, lead: 'portrait', sheet: 'front', stylePrompt: '水墨' }

  it('remembers the service that is left and puts it back when the author returns', () => {
    expect(imageSourceOf(own)).toBe('custom')
    const away = switchImage(own, 'openrouter', { provider: 'openrouter', model: 'openai/gpt-image-2.5-sunburst' })
    // The service changed; how pictures are drawn whichever service draws them did not.
    expect(away).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-image-2.5-sunburst', lead: 'portrait', sheet: 'front', stylePrompt: '水墨' })
    expect(away.baseURL).toBeUndefined()
    expect(away.sizes).toBeUndefined()
    expect(away.promptTokens).toBeUndefined()
    expect(away.kept?.custom).toEqual({ provider: 'openai', baseURL: 'http://100.86.130.94:8188/v1', model: 'qwen-image-2.1-turbo-nf4', sizes: ['768x768'], promptTokens: 256 })

    // A third service, then back: the first comes back whole, and the others are remembered in their turn.
    const off = switchImage(switchImage(away, 'comfyui', { provider: 'comfyui', size: '1024x1024' }), 'none', { provider: 'none' })
    expect(off.provider).toBe('none')
    expect(Object.keys(off.kept ?? {}).sort()).toEqual(['comfyui', 'custom', 'openrouter'])
    const back = switchImage(off, 'custom', { provider: 'openai', baseURL: '', model: '' })
    expect(imageService(back)).toEqual(imageService(own))
    expect(back).toMatchObject({ lead: 'portrait', sheet: 'front', stylePrompt: '水墨' })
    expect(back.kept?.custom).toBeUndefined()
    expect(back.kept?.openrouter).toMatchObject({ model: 'openai/gpt-image-2.5-sunburst' })
  })

  it('survives being saved: what is remembered is part of the settings', () => {
    const away = switchImage(own, 'bailian', { provider: 'dashscope', model: 'qwen-image-3.0' })
    // The page sends the whole section, naming as nothing what the draft no longer has.
    const patch = Object.fromEntries([...new Set([...Object.keys(own), ...Object.keys(away)])].map(key => [key, (away as unknown as Record<string, unknown>)[key] ?? null]))
    const saved = mergeSettings({ ...DEFAULT_SETTINGS, image: own }, { image: patch } as never)
    expect(saved.image.provider).toBe('dashscope')
    expect(saved.image.baseURL).toBeUndefined()
    expect(saved.image.kept?.custom?.baseURL).toBe('http://100.86.130.94:8188/v1')
  })

  it('does the same for speech, and keeps how the narrator is told to read', () => {
    const bailian: TtsSettings = { provider: 'qwen-audiogen', baseURL: 'https://dashscope.aliyuncs.com', model: 'qwen-audio-gen', narratorVoice: '沉稳的中年男声', narratorInstructions: '像深夜电台', retakes: 1 }
    const away = switchTts(bailian, 'openrouter', { model: 'google/gemini-tts' })
    expect(away).toMatchObject({ provider: 'openrouter', model: 'google/gemini-tts', narratorInstructions: '像深夜电台', retakes: 1 })
    expect(away.narratorVoice).toBeUndefined()
    const back = switchTts(away, 'qwen-audiogen', { model: 'something-new' })
    expect(back).toMatchObject({ provider: 'qwen-audiogen', model: 'qwen-audio-gen', narratorVoice: '沉稳的中年男声', narratorInstructions: '像深夜电台' })
    expect(back.kept?.openrouter).toMatchObject({ model: 'google/gemini-tts' })
  })

  it('names a setup in a few words', () => {
    expect(imageSetupName(own)).toBe('100.86.130.94:8188 · qwen-image-2.1-turbo-nf4')
    expect(imageSetupName({ provider: 'openrouter', model: 'openai/gpt-image-2.5-sunburst' })).toBe('OpenRouter · gpt-image-2.5-sunburst')
    expect(imageSetupName({ provider: 'codex' })).toBe('ChatGPT')
  })
})

describe('a book with services of its own', () => {
  const studio: ImageSettings = { provider: 'openrouter', model: 'openai/gpt-image-2.5-sunburst', quality: 'high', resolution: '1080p', lead: 'sheet', aspects: { cover: '2:3' }, kept: { custom: { provider: 'openai', baseURL: 'http://127.0.0.1:1/v1' } } }

  it('takes only the ways of drawing where the book names no service', () => {
    const held = withBookImage(studio, { sheet: 'front', lead: 'portrait' })
    expect(held).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-image-2.5-sunburst', quality: 'high', sheet: 'front', lead: 'portrait' })
  })

  it('takes the book\'s service whole where it names one, with none of the Studio\'s mixed in', () => {
    const held = withBookImage(studio, { provider: 'openai', baseURL: 'http://100.86.130.94:8188/v1', model: 'noct-q-v4-nf4', sheet: 'front' })
    expect(held).toMatchObject({ provider: 'openai', baseURL: 'http://100.86.130.94:8188/v1', model: 'noct-q-v4-nf4', sheet: 'front', lead: 'sheet', aspects: { cover: '2:3' } })
    // The Studio's quality and fineness were for its own service.
    expect(held.quality).toBeUndefined()
    expect(held.resolution).toBeUndefined()
    expect(held.kept).toBeUndefined()
  })

  it('speaks with the book\'s setup where it has one', () => {
    const settings: NovelSettings = { ...DEFAULT_SETTINGS, image: studio, tts: { provider: 'qwen-audiogen', model: 'a', narratorVoice: '男声' } }
    expect(withBook(settings, {})).toBe(settings)
    const held = withBook(settings, { tts: { provider: 'openrouter', model: 'b' }, sound: { provider: 'none' } })
    expect(held.tts).toEqual({ provider: 'openrouter', model: 'b' })
    expect(held.sound).toEqual({ provider: 'none' })
    expect(held.image).toBe(studio)
  })
})

describe('a book draws with its own service', () => {
  let server: Server
  let base = ''
  const seen: { model: unknown; path: string }[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const path = request.url ?? ''
        if (path === '/v1/models') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [] }))
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
        seen.push({ model: body.model, path })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: B64 }] }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  it('whatever the Studio draws with — and goes back to the Studio\'s when it lets go of its own', async () => {
    // For every book: no pictures at all.
    const bed = await createTestBed({ settings: { image: { provider: 'none' } } })
    try {
      const { illustrate } = await import('../src/core/pipelines/illustrate')
      expect(await bed.core.imageProvider(bed.runtime)).toBeUndefined()
      await bed.runtime.project.updateManifest({ image: { provider: 'openai', baseURL: base, model: 'book-model', local: true, sheet: 'front' } })
      expect((await bed.core.imageOf(bed.runtime)).model).toBe('book-model')
      // The Studio's own, asked for no book, is still what it was.
      expect((await bed.core.imageOf(undefined)).provider).toBe('none')
      const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨夜的码头' }, { origin: 'user' })
      expect(seen.at(-1)).toMatchObject({ model: 'book-model', path: '/v1/images/generations' })
      expect(info.model).toBe('book-model')

      // A trial of another model of the same server draws with that, and leaves nothing behind.
      await bed.core.trial({ image: { provider: 'openai', baseURL: base, model: 'tried-model', local: true } }, async () => {
        await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨夜的码头' }, { origin: 'user' })
      })
      expect(seen.at(-1)).toMatchObject({ model: 'tried-model' })
      expect((await bed.core.imageOf(bed.runtime)).model).toBe('book-model')
      // The book's ways of drawing hold in a trial too: it is the service that is tried.
      await bed.core.trial({ image: { provider: 'openai', baseURL: base, model: 'tried-model' } }, async () => {
        expect((await bed.core.imageOf(bed.runtime)).sheet).toBe('front')
      })

      // Named as nothing, the book's own service is gone, and its ways of drawing with it.
      await bed.runtime.project.updateManifest({ image: null } as never)
      expect((await bed.runtime.project.manifest()).image).toBeUndefined()
      expect(await bed.core.imageProvider(bed.runtime)).toBeUndefined()
    } finally {
      await bed.cleanup()
    }
  })

  it('and speaks with its own setup', async () => {
    const bed = await createTestBed({ settings: { tts: { provider: 'none' } } })
    try {
      expect((await bed.core.settingsOf(bed.runtime)).tts.provider).toBe('none')
      await bed.runtime.project.updateManifest({ tts: { provider: 'openai', baseURL: base, model: 'book-voice', speechTags: 'read' } })
      const held = await bed.core.settingsOf(bed.runtime)
      expect(held.tts).toMatchObject({ provider: 'openai', model: 'book-voice', speechTags: 'read' })
      expect((await bed.core.settingsOf(undefined)).tts.provider).toBe('none')
      await bed.runtime.project.updateManifest({ tts: null } as never)
      expect((await bed.core.settingsOf(bed.runtime)).tts.provider).toBe('none')
    } finally {
      await bed.cleanup()
    }
  })
})

describe('a book with retrieval, budgets and numbers of its own', () => {
  it('keeps the Studio\'s for whatever it does not name', () => {
    const settings: NovelSettings = { ...DEFAULT_SETTINGS, context: { strategy: 'auto', tailChars: 3000, sideTokens: 40_000 }, embedding: { provider: 'openai', baseURL: 'https://a.example/v1', model: 'studio-embed' } }
    const held = withBook(settings, { context: { budgetTokens: 60_000, strategy: 'retrieval' }, embedding: { provider: 'none' } })
    expect(held.context).toEqual({ strategy: 'retrieval', tailChars: 3000, sideTokens: 40_000, budgetTokens: 60_000 })
    expect(held.embedding).toEqual({ provider: 'none' })
    // Budgets that name nothing are none of the book's own.
    expect(withBook(settings, { context: {} })).toBe(settings)
  })

  it('packs a chapter\'s context with the book\'s budgets, embeds with the book\'s model, and counts its work apart', async () => {
    const asked: { path: string; model: unknown }[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model?: string; input?: string[] }
        asked.push({ path: request.url ?? '', model: body.model })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: [1, 0, 0] })) }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    const bed = await createTestBed({ settings: { textConcurrency: 6, context: { strategy: 'auto', tailChars: 3000, playTokens: 9000 } } })
    try {
      const { project } = bed.runtime
      const chapter = await project.addChapter({ title: '一' })
      await project.saveChapterText(chapter.id, '雨下了一夜。\n\n她把信折好，放回抽屉。')

      // Nothing of its own: the Studio's numbers, the Studio's gates, no embedder.
      expect(await bed.core.parallelFor('text', bed.runtime)).toBe(6)
      expect(await bed.core.gateOf('text', bed.runtime)).toBe(bed.core.gate('text'))
      expect(await bed.core.embedder(project)).toBeUndefined()
      expect((await bed.core.settingsOf(bed.runtime)).context.playTokens).toBe(9000)

      await project.updateManifest({ parallel: { text: 2, image: 3 }, context: { playTokens: 4000, tailChars: 800 }, embedding: { provider: 'openai', baseURL: base, model: 'book-embed' } })
      // Its own numbers, on gates that count this book alone; the kinds it does not name stay with the Studio's.
      expect(await bed.core.parallelFor('text', bed.runtime)).toBe(2)
      expect(await bed.core.parallelFor('image', bed.runtime)).toBe(3)
      expect(await bed.core.gateOf('text', bed.runtime)).not.toBe(bed.core.gate('text'))
      expect(await bed.core.gateOf('speech', bed.runtime)).toBe(bed.core.gate('speech'))
      expect(bed.core.parallel('text')).toBe(6)
      // Two pieces of its work at once, however many are asked for.
      let out = 0
      let most = 0
      await Promise.all(Array.from({ length: 5 }, () => bed.core.through('text', async () => {
        out += 1
        most = Math.max(most, out)
        await new Promise(resolve => setTimeout(resolve, 15))
        out -= 1
      }, {}, bed.runtime)))
      expect(most).toBe(2)

      // Its own budgets where it names them, the Studio's for the rest.
      const held = (await bed.core.settingsOf(bed.runtime)).context
      expect(held).toMatchObject({ strategy: 'auto', playTokens: 4000, tailChars: 800 })
      expect((await bed.core.settingsOf(undefined)).context).toMatchObject({ playTokens: 9000, tailChars: 3000 })

      // Its passages are embedded with its own model, at its own address (the key is the one this machine has for that address).
      Object.assign(bed.core.credentials, { forEndpoint: async () => 'a-key-of-this-machine' })
      expect(await bed.runtime.index.embedPending()).toBeGreaterThan(0)
      expect(asked.at(-1)).toMatchObject({ path: '/v1/embeddings', model: 'book-embed' })
      expect(await bed.core.embedder()).toBeUndefined()

      // Named as nothing, each is the Studio's again.
      await project.updateManifest({ parallel: null, context: null, embedding: null } as never)
      const bare = await project.manifest()
      expect([bare.parallel, bare.context, bare.embedding]).toEqual([undefined, undefined, undefined])
      expect(await bed.core.parallelFor('text', bed.runtime)).toBe(6)
      expect(await bed.core.embedder(project)).toBeUndefined()
    } finally {
      await bed.cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})

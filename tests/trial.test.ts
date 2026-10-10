// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The same piece of work done by several services or models at once, to be
 * compared: a portrait, a picture there already is, a chapter, a stretch of
 * outline. What a trial makes takes the place of nothing.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageSetups, trialDerive, trialWrite, withModel } from '../src/core/pipelines/trial'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import type { ImageTrial } from '../src/shared/types'
import { createTestBed, PIXEL } from './support/harness'

const B64 = Buffer.from(PIXEL).toString('base64')

describe('what there is to try pictures with', () => {
  it('lists the service that draws now and every one set up before, each once', () => {
    const settings = { ...DEFAULT_SETTINGS, image: { provider: 'openrouter' as const, model: 'openai/gpt-image-2.5-sunburst', kept: { custom: { provider: 'openai' as const, baseURL: 'http://100.86.130.94:8188/v1', model: 'noct-q-v4-nf4' }, comfyui: { provider: 'comfyui' as const, baseURL: 'http://127.0.0.1:8188' } } } }
    expect(imageSetups(settings).map(setup => [setup.id, setup.label, setup.current])).toEqual([
      ['current', 'OpenRouter · gpt-image-2.5-sunburst', true],
      ['studio:custom', '100.86.130.94:8188 · noct-q-v4-nf4', false],
      ['studio:comfyui', 'ComfyUI', false],
    ])
    // A book that draws with a service of its own: that is the one in force, and the Studio's is one to try beside it.
    const own = imageSetups(settings, { image: { provider: 'dashscope', model: 'qwen-image-3.0', kept: { custom: { provider: 'openai', baseURL: 'http://100.86.130.94:8188/v1', model: 'noct-q-v4-nf4' } } } })
    expect(own.map(setup => [setup.id, setup.current])).toEqual([['current', true], ['studio', false], ['book:custom', false], ['studio:comfyui', false]])
    expect(own[0]!.label).toBe('Bailian · qwen-image-3.0')
    // With pictures off there is nothing in force, and what was set up before can still be tried.
    expect(imageSetups({ ...settings, image: { provider: 'none', kept: settings.image.kept } }).map(setup => setup.id)).toEqual(['studio:custom', 'studio:comfyui'])
    // Another model of the same service is a setup of its own.
    expect(withModel(own[0]!, 'z-image-turbo')).toEqual({ label: 'Bailian · z-image-turbo', image: { provider: 'dashscope', model: 'z-image-turbo' } })
  })
})

describe('pictures tried with several services', () => {
  let server: Server
  let base = ''
  const seen: { model: string; prompt: string; path: string }[] = []

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
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = (request.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(raw || '{}') as Record<string, unknown> : { model: /name="model"\r\n\r\n([^\r]+)/.exec(raw)?.[1], prompt: /name="prompt"\r\n\r\n([^\r]+)/.exec(raw)?.[1] }
        seen.push({ model: String(body.model), prompt: String(body.prompt), path })
        if (body.model === 'broken') {
          response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'the model fell over' }))
          return
        }
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

  const setup = (model: string): ImageTrial => ({ label: `mine · ${model}`, image: { provider: 'openai', baseURL: base, model, local: true } })

  it('draws a portrait once with each, from the same words, and leaves the card as it was', async () => {
    // For every book: no pictures at all — a trial draws with what it is of, not with what is in force.
    const bed = await createTestBed({ settings: { image: { provider: 'openai', baseURL: base, model: 'in-force', local: true, lead: 'none' } } })
    try {
      const { project } = bed.runtime
      const { illustrate } = await import('../src/core/pipelines/illustrate')
      const kept = await project.writeAsset('images/portrait-old.png', PIXEL)
      const card = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', appearance: '清瘦，低髻', visual: { prompt: 'slender woman, low bun, grey qipao', portrait: kept } })
      const said: Record<string, unknown>[] = []
      const from = seen.length
      const result = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true, trials: [setup('a'), setup('broken'), setup('b')] }, { origin: 'user', job: { id: 'j', kind: 'illustrate', project: 'p', origin: 'user', signal: new AbortController().signal, progress() {}, write() {}, rewrite() {}, result: (value) => { said.push(value) }, think() {}, crew() {}, note: () => () => {} } })
      const asked = seen.slice(from)
      // One request a service, none to the one in force, and the same words to each.
      expect(asked.map(item => item.model).sort()).toEqual(['a', 'b', 'broken'])
      expect(new Set(asked.map(item => item.prompt)).size).toBe(1)
      expect(asked[0]!.prompt).toContain('slender woman, low bun, grey qipao')
      // What each made of it: a picture, or why there is none — a service that fails does not keep the others.
      expect(result.tried!.map(picture => [picture.label, picture.path !== undefined, picture.error !== undefined])).toEqual([['mine · a', true, false], ['mine · broken', false, true], ['mine · b', true, false]])
      expect(result.tried![1]!.error).toContain('the model fell over')
      // Told while it goes, so the page can show each as it comes.
      expect((said.at(-1) as { trial: unknown[] }).trial).toHaveLength(3)

      // The card keeps the portrait it had; the pictures are on record as hers, marked as of one comparison, and out of the text.
      expect((await project.findCharacter(card.id))!.visual?.portrait).toBe(kept)
      const drawn = (await project.illustrations()).filter(item => item.trial !== undefined)
      expect(drawn.map(item => [item.kind, item.target, item.trial!.label, item.model]).sort()).toEqual([['portrait', card.id, 'mine · a', 'a'], ['portrait', card.id, 'mine · b', 'b']])
      expect(new Set(drawn.map(item => item.trial!.id)).size).toBe(1)
      expect((await project.hiddenFigures()).sort()).toEqual(drawn.map(item => item.path).sort())

      // A picture there already is, tried with other services: its own words again, nothing in its place.
      await project.addIllustration({ id: 'img-kept', path: kept, prompt: '旧的立绘', parts: { subject: '画一张「沈蘅」的人物立绘：半身像，面向镜头' }, kind: 'portrait', target: card.id, createdAt: new Date().toISOString() })
      const { redrawPicture } = await import('../src/core/pipelines/illustrate')
      const before = seen.length
      const again = await redrawPicture(bed.core, bed.runtime, { picture: kept, trials: [setup('c'), setup('d')] }, { origin: 'user' })
      expect(seen.slice(before).map(item => item.model).sort()).toEqual(['c', 'd'])
      expect(seen.at(-1)!.prompt).toContain('画一张「沈蘅」的人物立绘：半身像，面向镜头')
      expect(again.replaced).toEqual([])
      expect(again.tried!.every(picture => picture.path !== undefined)).toBe(true)
      expect((await project.findCharacter(card.id))!.visual?.portrait).toBe(kept)
      // Without services to try and without anything to change, a redraw still has to be told what to draw.
      await expect(redrawPicture(bed.core, bed.runtime, { picture: kept }, { origin: 'user' })).rejects.toThrow(/say what to draw/)
    } finally {
      await bed.cleanup()
    }
  })
})

describe('a chapter written by several models', () => {
  it('keeps the chapter as it was and every draft among its versions', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const chapter = await project.addChapter({ title: '雨夜', synopsis: '她在雨夜里等一封信。' })
      await project.saveChapterText(chapter.id, '原来的正文。')
      bed.llm.responder = (request) => {
        if (request.route.model === 'falls') throw new Error('this model is not answering')
        return `${request.route.model} 写的：雨下了一夜。她没有等到信。`
      }
      const said: Record<string, unknown>[] = []
      const result = await trialWrite(bed.core, bed.runtime, { chapter: chapter.id, brief: '写得冷一点', with: [{ provider: 'fake', model: 'one' }, { provider: 'fake', model: 'falls' }, { provider: 'other', model: 'two' }] }, { origin: 'user', job: { id: 'j', kind: 'write', project: 'p', origin: 'user', signal: new AbortController().signal, progress() {}, write() {}, rewrite() { throw new Error('a draft written to be compared is not streamed') }, result: (value) => { said.push(value) }, think() {}, crew() {}, note: () => () => {} } })
      expect(result.chapterId).toBe(chapter.id)
      expect(result.drafts.map(draft => [draft.label, draft.text, draft.error !== undefined])).toEqual([
        ['one', 'one 写的：雨下了一夜。她没有等到信。', false],
        ['falls', undefined, true],
        ['two', 'two 写的：雨下了一夜。她没有等到信。', false],
      ])
      // Each was asked as the writer, with the same brief, on its own model.
      const asked = bed.llm.requests.filter(request => request.prompt.includes('写得冷一点'))
      expect(asked.map(request => `${request.route.provider}/${request.route.model}`).sort()).toEqual(['fake/falls', 'fake/one', 'other/two'])
      // The chapter is what it was, and was not digested; the drafts are versions of it, to be taken by restoring one.
      expect(await project.chapterText(chapter.id)).toBe('原来的正文。')
      const versions = await project.versions(chapter.id)
      expect(versions.map(version => version.reason).sort()).toEqual(['trial-one', 'trial-two'])
      const two = result.drafts[2]!
      expect(await project.versionText(chapter.id, two.version!)).toBe(two.text)
      // What is told while it goes carries no text: the drafts are read from their versions.
      expect(JSON.stringify(said.at(-1))).not.toContain('雨下了一夜')
      expect((said.at(-1) as { drafts: { version?: string }[] }).drafts.filter(draft => draft.version !== undefined)).toHaveLength(2)
      // Nothing to compare without models.
      await expect(trialWrite(bed.core, bed.runtime, { chapter: chapter.id, with: [] }, { origin: 'user' })).rejects.toThrow(/name the models/)
    } finally {
      await bed.cleanup()
    }
  })
})

describe('chapters to come planned by several models', () => {
  it('shows what each would add, and adds nothing', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const first = await project.addChapter({ title: '开头', synopsis: '故事开始。' })
      await project.saveChapterText(first.id, '故事开始了。')
      bed.llm.responder = request => JSON.stringify({ chapters: [{ title: `${request.route.model}的下一章`, synopsis: '接着往下。' }], rationale: `${request.route.model} 这样想` })
      const result = await trialDerive(bed.core, bed.runtime, { count: 1, direction: '往北走', with: [{ provider: 'fake', model: 'north' }, { provider: 'fake', model: 'south' }] }, { origin: 'user' })
      expect(result.plans.map(plan => [plan.label, plan.chapters?.map(chapter => chapter.title), plan.rationale])).toEqual([
        ['north', ['north的下一章'], 'north 这样想'],
        ['south', ['south的下一章'], 'south 这样想'],
      ])
      // The outline is as it was: a comparison is looked at, not applied.
      expect((await project.chapterInfos()).map(info => info.title)).toEqual(['开头'])
    } finally {
      await bed.cleanup()
    }
  })
})

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
import { TRIAL_MOST, type ImageTrial } from '../src/shared/types'
import { hashText, proseOnly } from '../src/shared/text'
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

      // Each of them waits to take that picture's place — the book says how many wait, wherever the author is — and
      // is taken whenever they come back to it, by nothing but itself.
      const on = async (path: string) => (await project.illustrations()).find(item => item.path === path)!
      const [first, second] = again.tried!.map(picture => picture.path!) as [string, string]
      expect((await on(first)).trial!.hang).toEqual({ as: 'instead', of: kept })
      expect((await on(second)).trial!.hang).toEqual({ as: 'instead', of: kept })
      expect((await project.state()).waiting).toBe(4)
      const { hangPicture } = await import('../src/core/pipelines/illustrate')
      expect(await hangPicture(bed.runtime, await on(first))).toEqual(['沈蘅'])
      const after = (await project.findCharacter(card.id))!
      expect(after.visual?.portrait).toBe(first)
      expect((await on(first)).trial!.hang).toBeUndefined()
      expect(await project.hiddenFigures()).not.toContain(first)
      // The other of the comparison stays, and waits to take the place from the one that has it now.
      expect((await on(second)).trial!.hang).toEqual({ as: 'instead', of: first })
      expect((await project.state()).waiting).toBe(3)
      expect(await hangPicture(bed.runtime, await on(second))).toEqual(['沈蘅'])
      expect((await project.findCharacter(card.id))!.visual?.portrait).toBe(second)
      expect((await project.state()).waiting).toBe(2)
      // Without services to try and without anything to change, a redraw still has to be told what to draw.
      await expect(redrawPicture(bed.core, bed.runtime, { picture: kept }, { origin: 'user' })).rejects.toThrow(/say what to draw/)
    } finally {
      await bed.cleanup()
    }
  })

  it('tries any kind of picture — a sheet, design art, the picture of a turn, a cover, a passage, a panel, one of the author\'s own — hangs none of them, and puts the one taken where one drawn the usual way would be', async () => {
    const bed = await createTestBed({ settings: { image: { provider: 'openai', baseURL: base, model: 'in-force', local: true, lead: 'none' } } })
    try {
      const { project } = bed.runtime
      const { illustrate, hangPicture } = await import('../src/core/pipelines/illustrate')
      const { renderPanels } = await import('../src/core/pipelines/comic')
      const task = { origin: 'user' as const }
      const two = [setup('a'), setup('b')]
      const waiting = async (): Promise<string[]> => (await project.illustrations()).filter(item => item.trial?.hang !== undefined).map(item => item.path)
      const record = async (path: string) => (await project.illustrations()).find(item => item.path === path)!
      bed.llm.responder = () => JSON.stringify({ prompt: 'slender woman, low bun', negative: '' })
      const card = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', appearance: '清瘦，低髻', visual: { prompt: 'slender woman, low bun, grey qipao' } })

      // A design sheet: the card has none after, whatever was drawn; taken, it is her sheet.
      const sheets = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, trials: two }, task)
      expect(sheets.tried!.map(picture => picture.label)).toEqual(['mine · a', 'mine · b'])
      expect((await project.findCharacter(card.id))!.visual?.sheet).toBeUndefined()
      expect((await record(sheets.tried![1]!.path!)).trial).toMatchObject({ label: 'mine · b', hang: { as: 'sheet', character: card.id } })
      expect(await hangPicture(bed.runtime, await record(sheets.tried![1]!.path!))).toEqual(['沈蘅'])
      expect((await project.findCharacter(card.id))!.visual?.sheet).toBe(sheets.tried![1]!.path)
      // Taken, its record no longer says it waits, and it is out of the text no longer.
      expect((await record(sheets.tried![1]!.path!)).trial).toEqual({ id: (await record(sheets.tried![0]!.path!)).trial!.id, label: 'mine · b' })
      expect(await project.hiddenFigures()).toEqual([sheets.tried![0]!.path])
      expect(await waiting()).toEqual([sheets.tried![0]!.path])
      // A sheet of a look that the drawing itself names: taken, the look is on the card with it.
      const dressed = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服', prompt: 'plain white mourning robe', trials: [setup('a')] }, task)
      expect((await project.findCharacter(card.id))!.visual?.looks ?? []).toEqual([])
      await hangPicture(bed.runtime, await record(dressed.tried![0]!.path!))
      expect((await project.findCharacter(card.id))!.visual?.looks).toMatchObject([{ name: '丧服', prompt: 'plain white mourning robe', sheet: dressed.tried![0]!.path }])

      // The art of a place, and the picture of one turn of its course.
      const chapter = await project.addChapter({ title: '旧铺' })
      await project.saveChapterText(chapter.id, '铺子里只点一盏灯。\n\n沈蘅在柜台后写信。\n\n门外有人敲门。')
      const shop = await project.saveWorld({ name: '旧书铺', category: 'location', visualPrompt: '窄门面，木柜台，一盏煤油灯', events: [{ chapter: chapter.id, kind: 'decline', what: '铺子关张，门板上了锁' }] })
      const art = await illustrate(bed.core, bed.runtime, { kind: 'location', target: shop.id, trials: two }, task)
      expect((await project.findWorld(shop.id))!.visualImage).toBeUndefined()
      await hangPicture(bed.runtime, await record(art.tried![0]!.path!))
      expect((await project.findWorld(shop.id))!.visualImage).toBe(art.tried![0]!.path)
      bed.llm.responder = () => JSON.stringify({ look: '门板上了锁，招牌蒙尘' })
      const turned = await illustrate(bed.core, bed.runtime, { kind: 'location', target: shop.id, event: `${chapter.id}:decline`, trials: [setup('b')] }, task)
      expect((await project.findWorld(shop.id))!.events![0]!.image).toBeUndefined()
      expect((await record(turned.tried![0]!.path!)).trial!.hang).toEqual({ as: 'art', entry: shop.id, event: `${chapter.id}:decline` })
      await hangPicture(bed.runtime, await record(turned.tried![0]!.path!))
      expect((await project.findWorld(shop.id))!.events![0]!.image).toBe(turned.tried![0]!.path)
      expect((await project.findWorld(shop.id))!.visualImage).toBe(art.tried![0]!.path)

      // A cover: one drawn to be compared is not the book's cover — the latest drawn is, among those that are not waiting.
      bed.llm.responder = () => JSON.stringify({ prompt: '雨夜的旧书铺，窗里一盏灯' })
      const covers = await illustrate(bed.core, bed.runtime, { kind: 'cover', sheetFirst: false, trials: two }, task)
      expect(await project.cover()).toBeUndefined()
      await hangPicture(bed.runtime, await record(covers.tried![1]!.path!))
      expect(await project.cover()).toBe(covers.tried![1]!.path)

      // The picture of a passage, asked into the text: it stands there once taken, after the passage — and once only.
      bed.llm.responder = () => JSON.stringify({ picture: '沈蘅在柜台后低头写信，灯在手边', people: ['沈蘅'], place: '旧书铺', things: [], why: '上一段写她在柜台后' })
      const passage = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, quote: '沈蘅在柜台后写信。', insert: true, sheetFirst: false, trials: two }, task)
      expect(passage.inserted).toBe(false)
      expect(await project.chapterText(chapter.id)).not.toContain('![')
      await hangPicture(bed.runtime, await record(passage.tried![0]!.path!))
      await hangPicture(bed.runtime, await record(passage.tried![0]!.path!))
      const text = await project.chapterText(chapter.id)
      expect(text.split('\n\n').map(block => (block.startsWith('![') ? 'picture' : block))).toEqual(['铺子里只点一盏灯。', '沈蘅在柜台后写信。', 'picture', '门外有人敲门。'])
      expect(text).toContain(`](${passage.tried![0]!.path})`)

      // One of the author's own prompt: it hangs nowhere, taken or not.
      const own = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨夜的码头', trials: [setup('a')] }, task)
      expect((await record(own.tried![0]!.path!)).trial!.hang).toEqual({ as: 'gallery' })
      expect(await hangPicture(bed.runtime, await record(own.tried![0]!.path!))).toEqual([])

      // The panels of a storyboard, every one by every service: no panel has a picture until one is taken — one by
      // one, or all a service drew, at once.
      // (A script and a storyboard of the text as it is: nothing is asked of a model for them.)
      const textHash = hashText(proseOnly(await project.chapterText(chapter.id)))
      await project.saveAudioScript({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), lines: [{ id: 'l1', kind: 'narration', text: '铺子里只点一盏灯。' }], cues: [] } as never)
      await project.saveComicBoard({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), style: '', panels: [{ id: 'p1', lines: ['l1'], prompt: '柜台上的一盏灯', description: '灯', camera: 'still' }, { id: 'p2', lines: ['l1'], prompt: '门外的雨', description: '雨', camera: 'still' }] } as never)
      const panels = await renderPanels(bed.core, bed.runtime, { chapter: chapter.id, sheetFirst: false, trials: two }, task)
      expect(panels).toMatchObject({ rendered: 2, failed: 0, tried: 4 })
      expect(panels.missed).toBeUndefined()
      expect((await project.comicBoard(chapter.id))!.panels.map(panel => panel.image)).toEqual([undefined, undefined])
      const round = (await project.illustrations()).filter(item => item.trial?.batch === panels.round)
      expect(round.map(item => [(item.trial!.hang as { panel: string }).panel, item.trial!.label]).sort()).toEqual([['p1', 'mine · a'], ['p1', 'mine · b'], ['p2', 'mine · a'], ['p2', 'mine · b']])
      for (const item of round.filter(entry => entry.trial!.label === 'mine · b')) await hangPicture(bed.runtime, item)
      const board = (await project.comicBoard(chapter.id))!
      expect(board.panels.map(panel => round.find(item => item.path === panel.image)?.trial!.label)).toEqual(['mine · b', 'mine · b'])
      // A service that draws none of them is not passed over: the round says how many pictures are missing, and why.
      const lame = await renderPanels(bed.core, bed.runtime, { chapter: chapter.id, sheetFirst: false, force: true, trials: [setup('a'), setup('broken')] }, task)
      expect(lame).toMatchObject({ rendered: 2, failed: 0, tried: 2 })
      expect(lame.missed?.count).toBe(2)
      expect(lame.missed?.why).toContain('mine · broken')
      expect(lame.missed?.why).toContain('the model fell over')
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

describe('how hard each model of a comparison is to think', () => {
  it('runs a model at the level named for it, the same model at two levels as two drafts, and the one in use as it is in use', async () => {
    const bed = await createTestBed({ settings: { models: { writer: { provider: 'fake', model: 'mine', reasoningEffort: 'high', temperature: 0.4 } } } })
    try {
      const { project } = bed.runtime
      const chapter = await project.addChapter({ title: '雨夜', synopsis: '她在雨夜里等一封信。' })
      bed.llm.responder = request => `${request.route.model}/${request.route.reasoningEffort ?? '-'} 写的：雨下了一夜。`
      const result = await trialWrite(bed.core, bed.runtime, { chapter: chapter.id, brief: '写得冷一点', with: [
        // The writer's own model with nothing said of it: as the writer has it.
        { provider: 'fake', model: 'mine' },
        // The same, said to think as the model does by default: not filled in from the writer.
        { provider: 'fake', model: 'mine', reasoningEffort: '' },
        // Another model, at two levels: compared with itself.
        { provider: 'fake', model: 'other', reasoningEffort: 'low' },
        { provider: 'fake', model: 'other', reasoningEffort: 'max' },
        // Another model with nothing said: nothing of the writer's goes to it.
        { provider: 'fake', model: 'plain' },
      ] }, { origin: 'user' })
      const asked = bed.llm.requests.filter(request => request.prompt.includes('写得冷一点')).map(request => [request.route.model, request.route.reasoningEffort ?? '', request.route.temperature])
      expect(asked.sort()).toEqual([
        ['mine', '', 0.4],
        ['mine', 'high', 0.4],
        ['other', 'low', undefined],
        ['other', 'max', undefined],
        ['plain', '', undefined],
      ])
      // Told apart beside what they made, and among the chapter's versions.
      expect(result.drafts.map(draft => [draft.label, draft.effort])).toEqual([
        ['mine · high', 'high'],
        ['mine', undefined],
        ['other · low', 'low'],
        ['other · max', 'max'],
        ['plain', undefined],
      ])
      expect(result.drafts.map(draft => draft.text)).toEqual(['mine/high 写的：雨下了一夜。', 'mine/ 写的：雨下了一夜。', 'other/low 写的：雨下了一夜。', 'other/max 写的：雨下了一夜。', 'plain/- 写的：雨下了一夜。'])
      expect((await project.versions(chapter.id)).map(version => version.reason).sort()).toEqual(['trial-mine', 'trial-mine-high', 'trial-other-low', 'trial-other-max', 'trial-plain'])
      for (const draft of result.drafts) expect(await project.versionText(chapter.id, draft.version!)).toBe(draft.text)
    } finally {
      await bed.cleanup()
    }
  })

  it('has a planner think at the level named, too', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const first = await project.addChapter({ title: '开头', synopsis: '故事开始。' })
      await project.saveChapterText(first.id, '故事开始了。')
      bed.llm.responder = request => JSON.stringify({ chapters: [{ title: `${request.route.model}/${request.route.reasoningEffort ?? '-'}`, synopsis: '接着往下。' }] })
      const result = await trialDerive(bed.core, bed.runtime, { count: 1, with: [{ provider: 'fake', model: 'north', reasoningEffort: 'low' }, { provider: 'fake', model: 'north', reasoningEffort: 'high' }] }, { origin: 'user' })
      expect(result.plans.map(plan => [plan.label, plan.effort, plan.chapters?.map(chapter => chapter.title)])).toEqual([
        ['north · low', 'low', ['north/low']],
        ['north · high', 'high', ['north/high']],
      ])
    } finally {
      await bed.cleanup()
    }
  })
})

describe('what is kept of a draft written to be compared', () => {
  it('says beside the version who wrote it, and takes more than eight models at once', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const chapter = await project.addChapter({ title: '雨夜', synopsis: '她在雨夜里等一封信。' })
      await project.saveChapterText(chapter.id, '原来的正文。')
      await project.saveChapterText(chapter.id, '改过的正文。')
      bed.llm.responder = request => `${request.route.model} 写的：雨下了一夜。`
      // Ten models, one of them at two levels: eleven drafts — more than a comparison used to take.
      const routes = [...Array.from({ length: 10 }, (_item, at) => ({ provider: 'fake', model: `deepseek-v4.${at}-flash` })), { provider: 'fake', model: 'deepseek-v4.0-flash', reasoningEffort: 'max' }]
      const result = await trialWrite(bed.core, bed.runtime, { chapter: chapter.id, brief: '写得冷一点', with: routes }, { origin: 'user' })
      expect(result.drafts.filter(draft => draft.version !== undefined)).toHaveLength(11)
      const versions = await project.versions(chapter.id)
      const drafts = versions.filter(version => version.made !== undefined)
      // The model by its own name — the file's name has it with its dots gone — the level, the brief, and the round they are all of.
      expect(drafts.map(version => version.made!.label).sort()).toEqual([...routes.map(route => `${route.model}${'reasoningEffort' in route ? ' · max' : ''}`)].sort())
      const top = drafts.find(version => version.made!.effort === 'max')!
      expect(top.made).toEqual({ how: 'trial', label: 'deepseek-v4.0-flash · max', provider: 'fake', model: 'deepseek-v4.0-flash', effort: 'max', round: top.made!.round, brief: '写得冷一点' })
      expect(top.reason).toBe('trial-deepseek-v4-0-flash-max')
      expect(new Set(drafts.map(version => version.made!.round)).size).toBe(1)
      // A version kept for another reason says nothing of the kind.
      expect(versions.find(version => version.reason === 'edit')?.made).toBeUndefined()
      // Another comparison is another round.
      const again = await trialWrite(bed.core, bed.runtime, { chapter: chapter.id, with: [{ provider: 'fake', model: 'other' }] }, { origin: 'user' })
      const later = (await project.versions(chapter.id)).find(version => version.id === again.drafts[0]!.version)!
      expect(later.made?.round).not.toBe(top.made!.round)
      expect(later.made?.brief).toBeUndefined()
      // There is a most all the same: a slip is refused whole, before anything is written.
      const before = (await project.versions(chapter.id)).length
      await expect(trialWrite(bed.core, bed.runtime, { chapter: chapter.id, with: Array.from({ length: TRIAL_MOST + 1 }, (_item, at) => ({ provider: 'fake', model: `m${at}` })) }, { origin: 'user' })).rejects.toThrow(`${TRIAL_MOST} runs at once`)
      expect((await project.versions(chapter.id)).length).toBe(before)

      // Drafts nobody took are deleted for good, what is kept beside them with them; the chapter is not touched.
      const gone = drafts.slice(0, 3).map(version => version.id)
      expect(await project.dropVersions(chapter.id, [...gone, 'no-such-version', '../../novel'])).toEqual({ removed: 3, kept: [] })
      const left = await project.versions(chapter.id)
      expect(left.some(version => gone.includes(version.id))).toBe(false)
      for (const id of gone) expect(await project.versionText(chapter.id, id)).toBeUndefined()
      expect(await bed.runtime.project.chapterText(chapter.id)).toContain('改过的正文。')
      expect(left.filter(version => version.made !== undefined)).toHaveLength(9)
    } finally {
      await bed.cleanup()
    }
  })

  it('never deletes a chapter as it was before it was translated', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const chapter = await project.addChapter({ title: '雨夜' })
      const original = (await project.snapshot(chapter.id, 'before-translate', '原文。'))!
      const draft = (await project.snapshot(chapter.id, 'trial-x', '一稿。', { how: 'trial', label: 'x', provider: 'fake', model: 'x' }))!
      expect(await project.dropVersions(chapter.id, [original, draft])).toEqual({ removed: 1, kept: [original] })
      expect((await project.versions(chapter.id)).map(version => version.id)).toEqual([original])
      expect(await project.versionText(chapter.id, original)).toBe('原文。')
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

describe('a line spoken by several speech setups', () => {
  let server: Server
  let base = ''
  const heard: { model: string; voice: string; input: string; instructions?: string }[] = []

  beforeAll(async () => {
    const { encodeWav } = await import('../src/core/media/wav')
    // Half a second of a tone: enough of a voice to be measured.
    const pcm = new Int16Array(12_000)
    for (let at = 0; at < pcm.length; at++) pcm[at] = Math.round(Math.sin(at / 8) * 9000)
    const wav = encodeWav({ pcm, sampleRate: 24_000, channels: 1 } as never)
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model: string; voice: string; input: string; instructions?: string }
        heard.push(body)
        if (body.model === 'mute') {
          response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'this model does not speak' } }))
          return
        }
        response.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from(wav))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  it('lists the setup that speaks now and every one set up before', async () => {
    const { speechSetups } = await import('../src/core/pipelines/trial')
    const settings = { ...DEFAULT_SETTINGS, tts: { provider: 'qwen-audiogen' as const, model: 'qwen-audio-gen', narratorVoice: '沉稳的男声', kept: { openrouter: { provider: 'openrouter' as const, model: 'google/gemini-tts' } } } }
    expect(speechSetups(settings).map(setup => [setup.id, setup.label, setup.current])).toEqual([['current', 'Bailian · qwen-audio-gen', true], ['studio:openrouter', 'OpenRouter · gemini-tts', false]])
    // A book that speaks with its own: that one is in force, and the Studio's is one to try beside it.
    expect(speechSetups(settings, { tts: { provider: 'openai', baseURL: 'http://10.0.0.2:9000/v1', model: 'kokoro' } }).map(setup => [setup.id, setup.label])).toEqual([['current', '10.0.0.2:9000 · kokoro'], ['studio', 'Bailian · qwen-audio-gen'], ['studio:openrouter', 'OpenRouter · gemini-tts']])
    expect(speechSetups({ ...settings, tts: { provider: 'none' } })).toEqual([])
  })

  it('has each speak the same words as the same person, casts nobody, and changes no setup', async () => {
    const { trialSpeak } = await import('../src/core/pipelines/trial')
    const bed = await createTestBed({ settings: { tts: { provider: 'openai', baseURL: base, model: 'voice-a', narratorVoice: 'onyx', narratorInstructions: '像深夜电台' } } })
    try {
      Object.assign(bed.core.credentials, { forEndpoint: async () => 'a-key-of-this-machine' })
      const { project } = bed.runtime
      const card = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', gender: '女', voice: '清冷' })
      heard.length = 0
      const said: unknown[] = []
      const made = await trialSpeak(bed.core, bed.runtime, {
        text: '有些话，我只说一遍。',
        character: card.id,
        with: [
          { label: 'A', tts: { provider: 'openai', baseURL: base, model: 'voice-a' } },
          { label: 'B', tts: { provider: 'openai', baseURL: base, model: 'voice-b' }, voice: 'nova' },
          { label: 'C', tts: { provider: 'openai', baseURL: base, model: 'mute' } },
        ],
      }, { origin: 'user', job: { result: (value: unknown) => { said.push(value) }, progress: () => {}, write: () => {}, crew: () => {} } as never })
      // The same words to each, each with its own model; the voice named for one is the voice it speaks with.
      expect(heard.map(body => [body.model, body.input]).sort()).toEqual([['mute', '有些话，我只说一遍。'], ['voice-a', '有些话，我只说一遍。'], ['voice-b', '有些话，我只说一遍。']])
      expect(heard.find(body => body.model === 'voice-b')?.voice).toBe('nova')
      // She is spoken as a line of hers would be: who she is goes along as the direction.
      expect(heard.find(body => body.model === 'voice-a')?.instructions).toContain('沈蘅')
      expect(made.takes.map(take => [take.label, take.model, take.path !== undefined, take.error !== undefined])).toEqual([['A', 'voice-a', true, false], ['B', 'voice-b', true, false], ['C', 'mute', false, true]])
      expect(made.takes[2]!.error).toContain('does not speak')
      expect(made.takes[0]!.path).not.toBe(made.takes[1]!.path)
      expect((await project.readFile(made.takes[0]!.path!)).byteLength).toBeGreaterThan(1000)
      expect(said.length).toBeGreaterThan(1)
      // Listening casts nobody and learns nothing: the book's voice sheet is as it was, and so are the settings.
      expect(await project.voiceCast()).toBeUndefined()
      expect((await bed.core.settingsOf(bed.runtime)).tts.model).toBe('voice-a')
      expect((await project.manifest()).tts).toBeUndefined()

      // Nobody named: the narrator's voice of each setup, read the way the author has the narrator read.
      heard.length = 0
      await trialSpeak(bed.core, bed.runtime, { text: '雨下了一夜。', with: [{ label: 'A', tts: { provider: 'openai', baseURL: base, model: 'voice-a', narratorVoice: 'onyx' } }] }, { origin: 'user' })
      expect(heard[0]).toMatchObject({ model: 'voice-a', voice: 'onyx', instructions: '像深夜电台' })

      await expect(trialSpeak(bed.core, bed.runtime, { text: ' ', with: [{ label: 'A', tts: { provider: 'openai', baseURL: base } }] }, { origin: 'user' })).rejects.toThrow(/words/)
      await expect(trialSpeak(bed.core, bed.runtime, { text: '一', with: [] }, { origin: 'user' })).rejects.toThrow(/setups/)
    } finally {
      await bed.cleanup()
    }
  })
})

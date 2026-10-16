// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures through an OpenAI-compatible images endpoint: GPT Image as it has
 * always been asked for, and a server of the author's own — a model on their
 * machine or their network behind `/v1/images/generations` — asked the way
 * such a server wants to be. Neither is reached from where these tests run, so
 * each is stood in for by something that answers as it does.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { namedKeySource, retryAfterMs } from '../src/core/media/http'
import { listEndpointModels } from '../src/core/media/discovery'
import { createImageProvider, forgetImageListings, referencesRefused } from '../src/core/media/image'
import { fittedSize, imageLimitsOf, imageParallel, imageSizes, LOCAL_SIZES, localImages, nearestSize, sizeList, sizeWithin } from '../src/shared/images'
import { privateAddress } from '../src/shared/services'
import type { JobContext } from '../src/core/jobs'
import type { ImageSettings } from '../src/shared/types'
import { createTestBed, PIXEL } from './support/harness'

const B64 = Buffer.from(PIXEL).toString('base64')

/** A job nobody watches: what the work says of itself goes nowhere, unless a test listens for part of it. */
function quietJob(): JobContext {
  return { id: 'job-test', kind: 'illustrate', project: 'test', origin: 'user', signal: new AbortController().signal, progress() {}, write() {}, rewrite() {}, result() {}, think() {}, crew() {}, note: () => () => {} }
}
const keys = namedKeySource(name => (name === 'GOOD' ? 'good' : undefined))

interface Seen {
  path: string
  auth: string | undefined
  type: string
  /** A JSON body as sent; a form's plain fields, with how many files came under each name. */
  body: Record<string, unknown>
}

async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** The plain fields of a multipart form, and under `files` how many files each name carried. */
function formFields(raw: Buffer, type: string): Record<string, unknown> {
  const boundary = /boundary=([^;]+)/.exec(type)?.[1] ?? ''
  const fields: Record<string, unknown> = {}
  const files: Record<string, number> = {}
  for (const part of raw.toString('latin1').split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1]
    if (name === undefined) continue
    if (/filename="/.test(part)) files[name] = (files[name] ?? 0) + 1
    else fields[name] = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8')
  }
  return { ...fields, files }
}

describe('GPT Image through an OpenAI-compatible endpoint', () => {
  let server: Server
  let origin = ''
  let base = ''
  const seen: Seen[] = []

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const raw = await read(request)
      const type = request.headers['content-type'] ?? ''
      const path = request.url ?? ''
      if (path === '/file.png') {
        response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(PIXEL))
        return
      }
      const body = type.startsWith('application/json') ? JSON.parse(raw.toString('utf8')) as Record<string, unknown> : formFields(raw, type)
      seen.push({ path, auth: request.headers.authorization, type: type.split(';')[0]!, body })
      if (body.model === 'busy-model') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }).end(JSON.stringify({ error: { message: 'slow down', code: 'rate_limit_exceeded' } }))
        return
      }
      // The edits endpoint is GPT Image's: asked of it for another model, OpenAI refuses the request.
      if (path === '/v1/images/edits' && !/^(gpt-image|chatgpt-image)/.test(String(body.model))) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `Invalid value: '${String(body.model)}'. Value must be 'gpt-image-2'.`, code: 'invalid_value' } }))
        return
      }
      // DALL·E answers with an address to fetch; GPT Image with the picture itself.
      const data = body.model === 'dall-e-3' ? [{ url: `${origin}/file.png`, revised_prompt: 'a small paper boat' }] : [{ b64_json: B64 }]
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ created: 1, data, usage: { total_tokens: 9 } }))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    base = `${origin}/v1`
  })
  afterAll(async () => { await new Promise((resolve) => { server.close(resolve) }) })
  beforeEach(() => { seen.length = 0 })

  it('asks for one of the three sizes GPT Image has, with the quality chosen and what to keep out in the prompt', async () => {
    const provider = createImageProvider({ provider: 'openai', baseURL: base, model: 'gpt-image-2', apiKeyRef: 'GOOD', quality: 'high', negativePrompt: 'text' }, keys)!
    const image = await provider.generate({ prompt: 'a paper boat', size: '1280x720' })
    expect(Buffer.from(image.data).equals(Buffer.from(PIXEL))).toBe(true)
    expect(image.mime).toBe('image/png')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: '/v1/images/generations', auth: 'Bearer good', type: 'application/json' })
    expect(seen[0]!.body).toEqual({ model: 'gpt-image-2', prompt: 'a paper boat\n\nAvoid: text', size: '1536x1024', n: 1, quality: 'high' })
    expect(image.sent).toEqual({ prompt: 'a paper boat\n\nAvoid: text', size: '1536x1024' })
    expect(image.referencesUsed).toBe(0)
  })

  it('sends no quality where none is chosen, and fits a standing and a square picture', async () => {
    const provider = createImageProvider({ provider: 'openai', baseURL: base, model: 'gpt-image-2', apiKeyRef: 'GOOD' }, keys)!
    await provider.generate({ prompt: 'a cover', size: '768x1152' })
    await provider.generate({ prompt: 'a face', size: '1024x1024' })
    expect(seen.map(call => call.body)).toEqual([
      { model: 'gpt-image-2', prompt: 'a cover', size: '1024x1536', n: 1 },
      { model: 'gpt-image-2', prompt: 'a face', size: '1024x1024', n: 1 },
    ])
  })

  it('sends reference pictures through the edits endpoint', async () => {
    const provider = createImageProvider({ provider: 'openai', baseURL: base, model: 'gpt-image-2', apiKeyRef: 'GOOD', quality: 'medium' }, keys)!
    const image = await provider.generate({ prompt: 'her, in the rain', size: '768x1152', references: [{ data: PIXEL, mime: 'image/png' }, { data: PIXEL, mime: 'image/jpeg' }] })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: '/v1/images/edits', auth: 'Bearer good', type: 'multipart/form-data' })
    expect(seen[0]!.body).toEqual({ model: 'gpt-image-2', prompt: 'her, in the rain', size: '1024x1536', n: '1', quality: 'medium', files: { 'image[]': 2 } })
    expect(image.referencesUsed).toBe(2)
    expect(image.sent).toEqual({ prompt: 'her, in the rain', size: '1024x1536' })
  })

  it('fetches a picture that is answered as an address', async () => {
    const provider = createImageProvider({ provider: 'openai', baseURL: base, model: 'dall-e-3', apiKeyRef: 'GOOD' }, keys)!
    const image = await provider.generate({ prompt: 'a paper boat', size: '1280x720' })
    expect(Buffer.from(image.data).equals(Buffer.from(PIXEL))).toBe(true)
    expect(seen[0]).toMatchObject({ path: '/v1/images/generations' })
    expect(seen[0]!.body).toEqual({ model: 'dall-e-3', prompt: 'a paper boat', size: '1536x1024', n: 1 })
    expect(image.referencesUsed).toBe(0)
  })

  it('does not tell by a model\'s name that it takes no picture: it is sent one, and the refusal is said to be about the picture', async () => {
    const provider = createImageProvider({ provider: 'openai', baseURL: base, model: 'dall-e-3', apiKeyRef: 'GOOD' }, keys)!
    // Nothing is known before one is sent.
    expect(await provider.prompting!()).toEqual({ avoidInPrompt: true })
    const refusal = await provider.generate({ prompt: 'her, in the rain', size: '1280x720', references: [{ data: PIXEL, mime: 'image/png' }] }).catch((error: unknown) => error)
    expect(referencesRefused(refusal)).toBe(true)
    expect(refusal).toMatchObject({ status: 400 })
    expect((refusal as Error).message).toContain('Invalid value')
    expect(seen).toHaveLength(1)
    // One picture goes as `image`, the way OpenAI's own client sends one.
    expect(seen[0]).toMatchObject({ path: '/v1/images/edits', type: 'multipart/form-data' })
    expect(seen[0]!.body).toEqual({ model: 'dall-e-3', prompt: 'her, in the rain', size: '1536x1024', n: '1', files: { image: 1 } })
    // A refusal that may have been about that one picture is not held against the next: it is tried again.
    expect(await provider.prompting!()).toEqual({ avoidInPrompt: true })
    // A refusal that is not about the picture — the service is busy — stays what it was.
    const busy = createImageProvider({ provider: 'openai', baseURL: base, model: 'busy-model', apiKeyRef: 'GOOD', local: false }, keys)!
    const slow = await busy.generate({ prompt: 'a boat', references: [{ data: PIXEL, mime: 'image/png' }] }).catch((error: unknown) => error)
    expect(slow).toMatchObject({ status: 429, code: 'rate_limit_exceeded' })
    expect(referencesRefused(slow)).toBe(false)
  })

  it('draws nothing without a key, and hands a refusal on as the service made it', async () => {
    const keyless = createImageProvider({ provider: 'openai', baseURL: base, model: 'gpt-image-2' }, keys)!
    await expect(keyless.generate({ prompt: 'a boat' })).rejects.toMatchObject({ code: 'NO_CREDENTIAL' })
    expect(seen).toHaveLength(0)
    const busy = createImageProvider({ provider: 'openai', baseURL: base, model: 'busy-model', apiKeyRef: 'GOOD', local: false }, keys)!
    const refusal = await busy.generate({ prompt: 'a boat', size: '1280x720' }).catch((error: unknown) => error) as { status?: number; code?: string; message: string; retryAfterMs?: number }
    expect(refusal).toMatchObject({ status: 429, code: 'rate_limit_exceeded' })
    expect(refusal.message).toContain('slow down')
    // How long a service on the net asks to be left alone is not read here: its gate finds the pace by itself, as it always has.
    expect(refusal.retryAfterMs).toBeUndefined()
    // A model that is not GPT's, at an endpoint that is not the author's own server, is asked for the size as it is.
    expect(seen[0]!.body).toEqual({ model: 'busy-model', prompt: 'a boat', size: '1280x720', n: 1 })
  })
})

/**
 * The author's own server, as theirs was seen to answer (a FastAPI app in front of one graphics card): it wants a
 * bearer key and says so in `detail`; it refuses a field it does not know, a size it does not draw and more than one
 * picture; while it draws it is busy, and says for how long; and its reply says more than the picture.
 */
describe('an image server of the author\'s own', () => {
  let server: Server
  let base = ''
  const seen: Seen[] = []
  /**
   * What the server holds its callers to; a test loosens what it is not about. `listing`: it says what its models take
   * (`GET /v1/models`, as the author's server does) and then takes any side from 256 to 768 in steps of 32, and a seed;
   * without it, the three sizes and no seed. `grid: false` with a listing: it lists limits and still takes only the three.
   * `edits`: it takes one reference picture with a prompt (`POST /v1/images/edits`, a form), as the author's server came
   * to on 2026-10-10 — and its list says so; without it there is no such endpoint, as there was none before.
   */
  const rules = { key: 'good' as string | undefined, drawMs: 20, busyFirst: 0, retryAfter: '1', listing: false, grid: true, edits: false, third: false }
  let listings = 0
  let drawing = 0
  let most = 0
  let refused = 0

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const raw = await read(request)
      const answer = (status: number, body: unknown, headers: Record<string, string> = {}): void => { response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body)) }
      if (rules.key !== undefined && request.headers.authorization !== `Bearer ${rules.key}`) {
        answer(401, { detail: 'Bearer token required' })
        return
      }
      if (rules.listing && request.method === 'GET' && request.url === '/v1/models') {
        listings += 1
        // The rows of the author's server, as it gave them on 2026-10-10.
        const pictures = rules.edits ? { capabilities: { text_to_image: true, image_edit: true, mask: false, stream: false }, reference_images: { max_count: 1, formats: ['PNG', 'JPEG', 'WEBP'], max_bytes: 10485760, mask_supported: false }, edit_defaults: { width: 768, height: 768, seed: null, true_cfg_scale: 1 } } : {}
        const row = (id: string, steps: number, most: number) => ({ id, object: 'model', owned_by: 'local', repo_id: 'Qwen/Qwen-Image-2.1', pipeline_class: 'QwenImage21Pipeline', defaults: { width: 768, height: 768, steps, seed: 42, true_cfg_scale: 1 }, limits: { max_width: 768, max_height: 768, max_pixels: 589824, max_steps: most, max_prompt_chars: 2000, max_prompt_tokens: 256 }, ...pictures, supported_n: [1], response_formats: ['b64_json'] })
        // (A third model came on 2026-10-10 — one whose name says nothing of pictures.)
        answer(200, { object: 'list', data: [row('qwen-image-2.1-nf4', 25, 40), row('qwen-image-2.1-turbo-nf4', 8, 8), ...(rules.third ? [row('noct-q-v4-nf4', 25, 40)] : []), { id: 'text-model', object: 'model' }, { id: 'bge-embed', object: 'model' }, { id: 'captioner', object: 'model', capabilities: { text_to_image: false, vision: true } }] })
        return
      }
      const editing = rules.edits && request.url === '/v1/images/edits'
      if (request.method !== 'POST' || (request.url !== '/v1/images/generations' && !editing)) {
        answer(request.url === '/v1/images/generations' || editing ? 405 : 404, { detail: request.method === 'POST' ? 'Not Found' : 'Method Not Allowed' })
        return
      }
      const type = request.headers['content-type'] ?? ''
      if (editing && !type.startsWith('multipart/form-data')) {
        answer(415, { detail: 'Use multipart/form-data with image and prompt; OpenAI images.edit() handles this.' })
        return
      }
      const body = editing ? formFields(raw, type) : JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      seen.push({ path: request.url!, auth: request.headers.authorization, type: editing ? 'multipart/form-data' : 'application/json', body })
      if (editing) {
        // As the author's server answered when it was asked with nothing to draw (2026-10-10).
        const strange = Object.keys(body).filter(key => !['model', 'prompt', 'n', 'size', 'seed', 'steps', 'response_format', 'files'].includes(key))
        if (strange.length > 0) {
          answer(422, { detail: `Unsupported edit field: ${strange[0]!}` })
          return
        }
        const files = Object.entries(body.files as Record<string, number>)
        if (files.some(([name]) => name !== 'image' && name !== 'image[]') || files.reduce((sum, [, count]) => sum + count, 0) !== 1) {
          answer(422, { detail: 'Exactly one reference image is supported.' })
          return
        }
      }
      const unknown = editing ? [] : Object.keys(body).filter(key => !['model', 'prompt', 'n', 'size', ...(rules.listing ? ['seed'] : [])].includes(key))
      if (unknown.length > 0) {
        answer(422, { detail: unknown.map(key => ({ type: 'extra_forbidden', loc: ['body', key], msg: 'Extra inputs are not permitted' })) })
        return
      }
      if ((editing ? Number(body.n) : body.n) !== 1) {
        answer(422, { detail: [{ type: 'value_error', loc: ['body', 'n'], msg: 'Value error, Only integer n=1 is supported.', input: body.n }] })
        return
      }
      if (String(body.prompt).length > 2000) {
        answer(422, { detail: [{ type: 'string_too_long', loc: ['body', 'prompt'], msg: 'String should have at most 2000 characters', input: body.prompt }] })
        return
      }
      const [width, height] = String(body.size).split('x').map(Number) as [number, number]
      const onGrid = [width, height].every(side => Number.isInteger(side) && side >= 256 && side <= 768 && side % 32 === 0)
      if (rules.listing && rules.grid ? !onGrid : !['768x768', '768x512', '512x768'].includes(String(body.size))) {
        answer(rules.listing ? 422 : 400, rules.listing
          ? { detail: [{ type: 'value_error', loc: ['body', 'size'], msg: 'Value error, Dimensions must be 256..768, in multiples of 32.', input: body.size }] }
          : { detail: `size ${String(body.size)} is not one of 768x768, 768x512, 512x768` })
        return
      }
      if (drawing > 0 || rules.busyFirst > 0) {
        if (drawing === 0) rules.busyFirst -= 1
        refused += 1
        answer(429, { detail: 'the model is drawing another picture' }, { 'retry-after': rules.retryAfter })
        return
      }
      drawing += 1
      most = Math.max(most, drawing)
      await new Promise((resolve) => { setTimeout(resolve, rules.drawMs) })
      drawing -= 1
      answer(200, {
        created: 1791500000,
        model: body.model,
        id: '6b00ffee92ea4d5da26ceb55dcdad496',
        revision: 'd65dbc9a7e8f6b5479e33dee6030eaab2a906509',
        parameters: { prompt: body.prompt, width, height, steps: 8, seed: body.seed ?? 42, n: 1, true_cfg_scale: 1, sampling: { mode: 'fixed_sigmas', sigmas: [1, 0.978453] } },
        metrics: { inference_seconds: 4.4, model_load_seconds: 0, cuda_peak_allocated_bytes: 11215419392 },
        data: [{ b64_json: B64 }],
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(async () => { await new Promise((resolve) => { server.close(resolve) }) })
  beforeEach(() => {
    seen.length = 0
    Object.assign(rules, { key: 'good', drawMs: 20, busyFirst: 0, retryAfter: '1', listing: false, grid: true, edits: false, third: false })
    most = 0
    refused = 0
    listings = 0
    forgetImageListings()
  })

  const own = (extra: Partial<ImageSettings> = {}): ImageSettings => ({ provider: 'openai', baseURL: base, model: 'qwen-image-2.1-nf4', apiKeyRef: 'GOOD', ...extra })

  it('is told by its address, unless the settings say otherwise or the model is one of OpenAI\'s', () => {
    for (const address of ['http://100.86.130.94:8188/v1', 'http://127.0.0.1:8000/v1', 'http://localhost:8000/v1', 'http://192.168.1.20/v1', 'http://10.0.0.5:9000/v1', 'http://172.20.3.4/v1', 'http://gpubox:8188/v1', 'http://studio.local/v1', 'https://box.tail1234.ts.net/v1', 'http://[::1]:8188/v1', 'http://[fd7a:115c:a1e0::1]:8188/v1']) {
      expect(privateAddress(address), address).toBe(true)
    }
    for (const address of ['https://api.openai.com/v1', 'https://gateway.example.com/v1', 'http://100.128.0.1/v1', 'http://172.32.0.1/v1', 'http://8.8.8.8/v1', 'https://[2606:4700::1111]/v1', undefined, '']) {
      expect(privateAddress(address), String(address)).toBe(false)
    }
    expect(localImages(own())).toBe(true)
    expect(localImages(own({ local: false }))).toBe(false)
    expect(localImages({ provider: 'openai', baseURL: 'https://gateway.example.com/v1', model: 'qwen-image-2.1-nf4' })).toBe(false)
    expect(localImages({ provider: 'openai', baseURL: 'https://gateway.example.com/v1', model: 'qwen-image-2.1-nf4', local: true })).toBe(true)
    // A gateway on the author's network that hands on to OpenAI is not a model of the author's: GPT Image stays GPT Image.
    expect(localImages(own({ model: 'gpt-image-2' }))).toBe(false)
    expect(localImages({ provider: 'openai', baseURL: base })).toBe(false)
    expect(localImages({ provider: 'openai' })).toBe(false)
    // Other ways of drawing have rules of their own.
    expect(localImages({ provider: 'comfyui', baseURL: base })).toBe(false)
    expect(localImages({ provider: 'openrouter', baseURL: base, local: true })).toBe(false)
  })

  it('fits what is wanted to the sizes the server draws', () => {
    // Every size the Studio asks for by itself: a cover, a portrait, a design sheet, a scene.
    expect(['768x1152', '1024x1024', '1536x1024', '1280x720', '1920x1080', '720x1280'].map(size => fittedSize(own(), size))).toEqual(['512x768', '768x768', '768x512', '768x512', '768x512', '512x768'])
    expect(imageSizes(own())).toEqual(LOCAL_SIZES)
    // The author's own list, typed any which way; of two of one shape, the nearer in area.
    expect(sizeList('1024x1024， 1024×576 576*1024;  512x512 nonsense 1024x1024')).toEqual(['1024x1024', '1024x576', '576x1024', '512x512'])
    const listed = own({ sizes: ['1024x1024', '1024x576', '512x512'] })
    expect(['1280x720', '600x600', '2048x2048', '768x1152'].map(size => fittedSize(listed, size))).toEqual(['1024x576', '512x512', '1024x1024', '1024x1024'])
    expect(nearestSize(undefined, ['768x512', '768x768'])).toBe('768x512')
    // A service on the net is asked for what is wanted — unless the author lists what it draws.
    const net: ImageSettings = { provider: 'openai', baseURL: 'https://gateway.example.com/v1', model: 'some-image-model' }
    expect(imageSizes(net)).toBeUndefined()
    expect(fittedSize(net, '1280x720')).toBe('1280x720')
    expect(fittedSize({ ...net, sizes: ['1024x1024'] }, '1280x720')).toBe('1024x1024')
    expect(imageSizes({ provider: 'dashscope', sizes: ['1024x1024'] })).toBeUndefined()
    // One at a time, whatever number is set; anything else as many as the author says.
    expect(imageParallel(own({ concurrency: 32 }))).toBe(1)
    expect(imageParallel({ ...net, concurrency: 32 })).toBe(32)
    expect(imageParallel(net)).toBe(8)
  })

  it('is sent a model, a prompt, a count of one and a size it draws — and nothing else', async () => {
    const provider = createImageProvider(own({ quality: 'high', negativePrompt: 'text' }), keys)!
    const image = await provider.generate({ prompt: '雨夜的码头，提灯的少女', size: '1280x720' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: '/v1/images/generations', auth: 'Bearer good' })
    expect(seen[0]!.body).toEqual({ model: 'qwen-image-2.1-nf4', prompt: '雨夜的码头，提灯的少女\n\nAvoid: text', n: 1, size: '768x512' })
    // The picture is the reply's `data[0].b64_json`; what else the reply says is let be.
    expect(Buffer.from(image.data).equals(Buffer.from(PIXEL))).toBe(true)
    expect(image.mime).toBe('image/png')
    // What went, for the picture's record: the size as it was asked of the server, and no reference picture.
    expect(image.sent).toEqual({ prompt: '雨夜的码头，提灯的少女\n\nAvoid: text', size: '768x512' })
    expect(image.referencesUsed).toBe(0)
    // A model with GPT's name on a server said to be the author's own is asked the same plain way.
    await createImageProvider(own({ model: 'gpt-image-2', local: true, quality: 'high' }), keys)!.generate({ prompt: 'a face', size: '1024x1024' })
    expect(seen[1]).toMatchObject({ path: '/v1/images/generations' })
    expect(seen[1]!.body).toEqual({ model: 'gpt-image-2', prompt: 'a face', n: 1, size: '768x768' })
  })

  it('says what the server said when it refuses', async () => {
    // Told it is no server of the author's, the Studio asks as it asks a service on the net — and the server's own words come back.
    const asNet = createImageProvider(own({ local: false, quality: 'high' }), keys)!
    const extra = await asNet.generate({ prompt: 'a boat', size: '768x768' }).catch((error: unknown) => error) as Error & { status?: number }
    expect(extra.status).toBe(422)
    expect(extra.message).toContain('quality: Extra inputs are not permitted')
    const size = await createImageProvider(own({ local: false }), keys)!.generate({ prompt: 'a boat', size: '1280x720' }).catch((error: unknown) => error) as Error & { status?: number }
    expect(size.status).toBe(400)
    expect(size.message).toContain('size 1280x720 is not one of 768x768, 768x512, 512x768')
  })

  it('asks the server what its model draws, and fits the picture, the prompt and the seed to that', async () => {
    rules.listing = true
    const provider = createImageProvider(own({ model: 'qwen-image-2.1-turbo-nf4', negativePrompt: '文字' }), keys)!
    const drawn = []
    // A scene, a design sheet, a cover, a portrait: each the largest of its shape within 768 a side, sides in steps of 32.
    for (const size of ['1280x720', '1536x1024', '768x1152', '1024x1024']) drawn.push(await provider.generate({ prompt: '雨夜的码头', size }))
    expect(seen.map(call => call.body.size)).toEqual(['736x416', '768x512', '512x768', '768x768'])
    expect(drawn.map(image => image.sent?.size)).toEqual(['736x416', '768x512', '512x768', '768x768'])
    // Four pictures, one question.
    expect(listings).toBe(1)
    // The server draws from seed 42 until told another: every picture is sent one of its own, and its record keeps it.
    const seeds = seen.map(call => call.body.seed as number)
    expect(seeds.every(seed => Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31)).toBe(true)
    expect(new Set(seeds).size).toBe(4)
    expect(drawn.map(image => image.sent?.seed)).toEqual(seeds)
    expect(Object.keys(seen[0]!.body).sort()).toEqual(['model', 'n', 'prompt', 'seed', 'size'])
    // A prompt longer than the server reads is cut to what it reads, not refused.
    const long = await provider.generate({ prompt: '雨夜的码头，一盏纸灯笼。'.repeat(200), size: '1280x720' })
    expect(String(seen.at(-1)!.body.prompt)).toHaveLength(2000)
    expect(long.sent?.prompt).toHaveLength(2000)
    // The author's own list of sizes still has the last word.
    await createImageProvider(own({ model: 'qwen-image-2.1-turbo-nf4', sizes: ['512x512', '768x512'] }), keys)!.generate({ prompt: 'a boat', size: '1024x1024' })
    expect(seen.at(-1)!.body).toMatchObject({ size: '512x512' })
    expect(seen.at(-1)!.body.seed).toBeTypeOf('number')
    // A model the list does not know is asked for as before: the three sizes, no seed.
    await createImageProvider(own({ model: 'somebody-elses-model' }), keys)!.generate({ prompt: 'a boat', size: '1280x720' }).catch(() => undefined)
    expect(seen.at(-1)!.body).toEqual({ model: 'somebody-elses-model', prompt: 'a boat', size: '768x512', n: 1 })
  })

  it('says how much of a prompt its model reads, and has the director fit a longer one', async () => {
    rules.listing = true
    // The server's own figure; the author's, where they set one; nothing for a service on the net that names none.
    // (Of reference pictures this list says nothing, and nothing is taken for known before one is sent.)
    expect(await createImageProvider(own({ model: 'qwen-image-2.1-turbo-nf4' }), keys)!.prompting!()).toEqual({ tokens: 256, avoidInPrompt: true })
    expect(await createImageProvider(own({ model: 'qwen-image-2.1-turbo-nf4', promptTokens: 180 }), keys)!.prompting!()).toEqual({ tokens: 180, avoidInPrompt: true })
    expect(await createImageProvider(own({ model: 'somebody-elses-model' }), keys)!.prompting!()).toEqual({ avoidInPrompt: true })
    expect(await createImageProvider(own({ local: false }), keys)!.prompting!()).toEqual({ avoidInPrompt: true })
    expect(await createImageProvider(own({ local: false, model: 'gpt-image-2' }), keys)!.prompting!()).toEqual({ avoidInPrompt: true })
    // ComfyUI takes pictures through a workflow of its own for them, and none without.
    expect(await createImageProvider({ provider: 'comfyui' }, keys)!.prompting!()).toEqual({ avoidInPrompt: false, references: 0 })
    expect(await createImageProvider({ provider: 'comfyui', editWorkflow: '{"1":{}}' }, keys)!.prompting!()).toEqual({ avoidInPrompt: false })
    expect(await createImageProvider({ provider: 'dashscope', promptTokens: 300 }, keys)!.prompting!()).toEqual({ tokens: 300, avoidInPrompt: false })
    expect(await createImageProvider({ provider: 'openrouter', model: 'm' }, keys)!.prompting!()).toEqual({ avoidInPrompt: true })

    // Through the Studio: a prompt of some three hundred tokens, a model that reads 256.
    rules.key = undefined
    const bed = await createTestBed({ settings: { image: { provider: 'openai', baseURL: base, model: 'qwen-image-2.1-turbo-nf4' } } })
    try {
      await bed.runtime.project.updateManifest({ artStyle: '精致的半写实插画风格，半中国水墨画风格，电影感光影，细腻笔触，统一的色调，适当的细节，建筑服饰是典型的明制', artAvoid: ['文字', '水印', '现代服饰与物件'] })
      const long = '清晨的码头，薄雾未散，一艘乌篷船缓缓靠岸，船篷上还挂着隔夜的露水；她提着一只竹篮走下青石阶，回头望了一眼身后的巷口。'.repeat(6)
      const fits = '清晨薄雾的码头，乌篷船靠岸，少女提竹篮走下青石阶回望巷口。半写实插画、水墨意味，电影感光影，明制服饰与建筑。'
      const asked: string[] = []
      bed.llm.responder = (request) => { asked.push(request.prompt); return JSON.stringify({ prompt: fits }) }
      const { illustrate, forgetFittedPrompts } = await import('../src/core/pipelines/illustrate')
      forgetFittedPrompts()
      const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: long, size: '1280x720' }, { origin: 'user' })
      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain('大约 230 个 token')
      expect(asked[0]).toContain('qwen-image-2.1-turbo-nf4')
      // The server got the director's prompt and nothing after it; the record says what was done.
      expect(seen.at(-1)!.body).toMatchObject({ prompt: fits, size: '736x416', n: 1 })
      expect(info.sent?.compact).toMatchObject({ limit: 256 })
      expect(info.sent!.compact!.from).toBeGreaterThan(256)
      // A short prompt is sent as it is, with what to keep out after it, and nobody is asked.
      await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '一只纸船', size: '1024x1024' }, { origin: 'user' })
      expect(asked).toHaveLength(1)
      expect(String(seen.at(-1)!.body.prompt)).toContain('不要出现：文字、水印、现代服饰与物件')
    } finally {
      await bed.cleanup()
    }
  })

  it('finds out by sending one that a server takes no reference picture, draws from the words alone, and says so once the picture is there', async () => {
    rules.listing = true
    rules.key = undefined
    const bed = await createTestBed({ settings: { image: { provider: 'openai', baseURL: base, model: 'qwen-image-2.1-turbo-nf4' } } })
    try {
      const { project } = bed.runtime
      const { illustrate } = await import('../src/core/pipelines/illustrate')
      const { sheetsAhead } = await import('../src/core/pipelines/comic')
      await project.writeAsset('images/sheet-heng.png', PIXEL)
      const heng = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', appearance: '清瘦，低髻', visual: { prompt: 'slender woman, low bun, grey qipao', sheet: 'assets/images/sheet-heng.png' } })
      // Asked before drawing, nothing is said of what the service takes: it is not known, and it is the service's to show.
      const tang = await project.saveCharacter({ name: '阿棠', role: 'supporting', appearance: '圆脸，两条短辫' })
      expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'portrait', target: tang.id }])).toEqual({ people: [{ id: tang.id, name: '阿棠' }], unknown: 0 })
      expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'portrait', target: heng.id }])).toEqual({ people: [], unknown: 0 })
      // A portrait is drawn against the sheet. The sheet is sent — this server has nowhere to take it — and the portrait
      // is drawn again from the words alone: written anew, with the words for her and nothing about a picture.
      const said: Record<string, unknown>[] = []
      const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: heng.id, plain: true }, { origin: 'user', job: { ...quietJob(), result: (value) => { said.push(value) } } })
      const sent = String(seen.at(-1)!.body.prompt)
      expect(seen.at(-1)).toMatchObject({ path: '/v1/images/generations' })
      expect(sent).toContain('slender woman, low bun, grey qipao')
      expect(sent).not.toContain('参考图')
      expect(Object.keys(seen.at(-1)!.body).sort()).toEqual(['model', 'n', 'prompt', 'seed', 'size'])
      expect(portrait.prompt).not.toContain('参考图')
      expect(portrait.parts?.referenceNote).toBeUndefined()
      expect(portrait.parts?.references).toBeUndefined()
      expect(portrait.parts?.left).toEqual([{ path: 'assets/images/sheet-heng.png', label: '沈蘅', sheet: true }])
      // What the server answered is kept with the picture, and said with the job now that the picture is there.
      expect(portrait.parts?.leftWhy).toContain('404')
      expect(said).toContainEqual({ left: { names: ['沈蘅'], taken: 0, why: portrait.parts!.leftWhy } })
      // It is not asked the same a second time for a while: the next portrait is written without the picture from the start.
      const calls = seen.length
      const again = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: heng.id, plain: true }, { origin: 'user' })
      expect(seen).toHaveLength(calls + 1)
      expect(again.parts?.left).toEqual([{ path: 'assets/images/sheet-heng.png', label: '沈蘅', sheet: true }])
      expect(again.parts?.leftWhy).toBeUndefined()
      // A picture nothing would have gone along with says nothing of the kind.
      const alone = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '一只纸船' }, { origin: 'user' })
      expect(alone.parts?.left).toBeUndefined()
    } finally {
      await bed.cleanup()
    }
  })

  it('sends a reference picture to a server whose list says its model takes one — one, as the list says', async () => {
    rules.listing = true
    rules.edits = true
    const provider = createImageProvider(own({ model: 'qwen-image-2.1-turbo-nf4' }), keys)!
    expect(await provider.prompting!()).toEqual({ tokens: 256, avoidInPrompt: true, references: 1 })
    expect(imageLimitsOf({ id: 'm', limits: { max_width: 768, max_height: 768 }, capabilities: { image_edit: true }, reference_images: { max_count: 1 }, edit_defaults: { seed: null } })).toMatchObject({ references: 1 })
    expect(imageLimitsOf({ id: 'm', limits: { max_width: 768, max_height: 768 }, capabilities: { image_edit: false }, reference_images: { max_count: 4 } })).toMatchObject({ references: 0 })
    expect(imageLimitsOf({ id: 'm', limits: { max_width: 768, max_height: 768 }, edit_defaults: { seed: 7 } })).toMatchObject({ editSeeded: true })
    expect(imageLimitsOf({ id: 'm', limits: { max_width: 768, max_height: 768 } })?.references).toBeUndefined()
    // Two are offered; the one the model takes goes, through the edits endpoint, as a file in a form — with a model, a
    // prompt, a size and a count, and nothing this server does not know (no seed: with a picture it draws from a new one each time).
    const image = await provider.generate({ prompt: 'her, in the rain', size: '1024x1024', references: [{ data: PIXEL, mime: 'image/png' }, { data: PIXEL, mime: 'image/jpeg' }] })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: '/v1/images/edits', auth: 'Bearer good', type: 'multipart/form-data' })
    expect(seen[0]!.body).toEqual({ model: 'qwen-image-2.1-turbo-nf4', prompt: 'her, in the rain', size: '768x768', n: '1', files: { image: 1 } })
    expect(image.referencesUsed).toBe(1)
    expect(image.sent).toEqual({ prompt: 'her, in the rain', size: '768x768' })
    // Busy, it says for how long here as well: the gate waits that long.
    rules.busyFirst = 1
    const busy = await provider.generate({ prompt: 'her', size: '768x768', references: [{ data: PIXEL, mime: 'image/png' }] }).catch((error: unknown) => error)
    expect(busy).toMatchObject({ status: 429, retryAfterMs: 1000 })
    expect(referencesRefused(busy)).toBe(false)

    // Through the Studio: a portrait against her sheet says which picture is whose; two people in one picture, and the
    // one the server has no room for stays behind — said with the picture.
    rules.key = undefined
    const bed = await createTestBed({ settings: { image: { provider: 'openai', baseURL: base, model: 'qwen-image-2.1-turbo-nf4' } } })
    try {
      const { project } = bed.runtime
      const { illustrate } = await import('../src/core/pipelines/illustrate')
      await project.writeAsset('images/sheet-heng.png', PIXEL)
      await project.writeAsset('images/sheet-tang.png', PIXEL)
      const heng = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', appearance: '清瘦，低髻', visual: { prompt: 'slender woman, low bun, grey qipao', sheet: 'assets/images/sheet-heng.png' } })
      await project.saveCharacter({ name: '阿棠', role: 'supporting', appearance: '圆脸，两条短辫', visual: { sheet: 'assets/images/sheet-tang.png' } })
      const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: heng.id, plain: true }, { origin: 'user' })
      expect(seen.at(-1)).toMatchObject({ path: '/v1/images/edits' })
      expect(String(seen.at(-1)!.body.prompt)).toContain('参考图：图1 是沈蘅')
      // Her sheet went along: her line points to it.
      expect(String(seen.at(-1)!.body.prompt)).toContain('人物「沈蘅」：见图1')
      expect(portrait.parts?.references).toEqual([{ path: 'assets/images/sheet-heng.png', label: '沈蘅', sheet: true }])
      expect(portrait.parts?.left).toBeUndefined()
      const said: Record<string, unknown>[] = []
      const both = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '两人在柜台前对账', characters: ['沈蘅', '阿棠'] }, { origin: 'user', job: { ...quietJob(), result: (value) => { said.push(value) } } })
      expect(seen.at(-1)).toMatchObject({ path: '/v1/images/edits' })
      expect((seen.at(-1)!.body.files as Record<string, number>).image).toBe(1)
      expect(String(seen.at(-1)!.body.prompt)).toContain('图1 是沈蘅')
      expect(String(seen.at(-1)!.body.prompt)).not.toContain('图2')
      expect(both.parts?.references).toEqual([{ path: 'assets/images/sheet-heng.png', label: '沈蘅', sheet: true }])
      expect(both.parts?.left).toEqual([{ path: 'assets/images/sheet-tang.png', label: '阿棠', sheet: true }])
      expect(both.parts?.leftWhy).toBeUndefined()
      expect(said).toContainEqual({ left: { names: ['阿棠'], taken: 1 } })
    } finally {
      await bed.cleanup()
    }
  })

  it('changes a picture with the picture and the change alone — and with the picture\'s words where the server takes no picture', async () => {
    rules.listing = true
    rules.edits = true
    rules.key = undefined
    const bed = await createTestBed({ settings: { image: { provider: 'openai', baseURL: base, model: 'qwen-image-2.1-turbo-nf4' } } })
    try {
      const { project } = bed.runtime
      const { illustrate, redrawPicture, forgetFittedPrompts } = await import('../src/core/pipelines/illustrate')
      forgetFittedPrompts()
      // A book whose art direction and avoid list alone come near what this model reads: any prompt that carries them is the director's to fit.
      await project.updateManifest({ artStyle: '精致的半写实插画风格，半中国水墨画风格，电影感光影，细腻笔触，统一的色调，适当的细节，建筑服饰是典型的明制'.repeat(5), artAvoid: ['文字', '水印', '现代服饰与物件'] })
      const asked: string[] = []
      bed.llm.responder = (request) => { asked.push(request.prompt); return JSON.stringify({ prompt: '雨夜的码头，一盏风灯，半写实水墨插画，明制。' }) }
      const first = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨夜的码头，一盏风灯', size: '1024x1024' }, { origin: 'user' })
      expect(asked).toHaveLength(1)
      // Changed: the picture goes to the edits endpoint with the author's words — the whole prompt. No description, no
      // art direction, nothing to keep out; so nothing that needs fitting, and the director is not asked.
      const changed = await redrawPicture(bed.core, bed.runtime, { picture: first.id, change: '风灯换成红色的' }, { origin: 'user' })
      expect(seen.at(-1)).toMatchObject({ path: '/v1/images/edits', type: 'multipart/form-data' })
      expect(seen.at(-1)!.body).toEqual({ model: 'qwen-image-2.1-turbo-nf4', prompt: '风灯换成红色的', size: '768x768', n: '1', files: { image: 1 } })
      expect(asked).toHaveLength(1)
      expect(changed.sent).toEqual({ prompt: '风灯换成红色的', size: '768x768' })
      expect(changed.parts).toMatchObject({ subject: '风灯换成红色的', references: [{ path: first.path, label: '要改的原图' }], base: { subject: '画面：雨夜的码头，一盏风灯\n这一张的要求：风灯换成红色的', avoid: ['文字', '水印', '现代服饰与物件'] } })
      expect(changed.parts?.left).toBeUndefined()

      // The same server before it took pictures: the picture is sent, it has nowhere to take it, and the new one is
      // drawn from the words that stand in for the picture — its own, the change after them — as any picture is.
      rules.edits = false
      forgetImageListings()
      const said: Record<string, unknown>[] = []
      const worded = await redrawPicture(bed.core, bed.runtime, { picture: first.id, change: '风灯换成红色的' }, { origin: 'user', job: { ...quietJob(), result: (value) => { said.push(value) } } })
      expect(seen.at(-1)).toMatchObject({ path: '/v1/images/generations' })
      expect(worded.prompt.startsWith('画面：雨夜的码头，一盏风灯\n这一张的要求：风灯换成红色的')).toBe(true)
      expect(worded.prompt).toContain('画风：')
      expect(worded.prompt).not.toContain('参考图')
      expect(worded.parts?.base).toBeUndefined()
      expect(worded.parts?.pieces).toEqual([{ of: 'composed', text: '画面：雨夜的码头，一盏风灯', label: '' }, { of: 'ask', text: '风灯换成红色的', label: '这一张的要求：' }])
      expect(worded.parts?.left).toEqual([{ path: first.path, label: '要改的原图' }])
      expect(worded.parts?.leftWhy).toContain('404')
      expect(said).toContainEqual({ left: { names: ['要改的原图'], taken: 0, why: worded.parts!.leftWhy } })
    } finally {
      await bed.cleanup()
    }
  })

  it('falls back on a usual size once when the server lists limits and takes only some sizes within them', async () => {
    rules.listing = true
    rules.grid = false
    const image = await createImageProvider(own({ model: 'qwen-image-2.1-turbo-nf4' }), keys)!.generate({ prompt: 'a boat', size: '1280x720' })
    expect(seen.map(call => call.body.size)).toEqual(['736x416', '768x512'])
    expect(image.sent?.size).toBe('768x512')
    // A refusal that is not about the size is not asked again.
    await expect(createImageProvider(own({ model: 'qwen-image-2.1-turbo-nf4', local: true, quality: 'high' }), keys)!.generate({ prompt: 'a boat', size: '768x512' })).resolves.toBeDefined()
    expect(seen).toHaveLength(3)
  })

  it('reads a model\'s limits off its row, and offers them with the model', async () => {
    const row = { id: 'm', defaults: { width: 768, height: 768, steps: 8, seed: 42 }, limits: { max_width: 768, max_height: 768, max_pixels: 589824, max_steps: 8, max_prompt_chars: 2000, max_prompt_tokens: 256 } }
    expect(imageLimitsOf(row)).toEqual({ maxWidth: 768, maxHeight: 768, maxPixels: 589824, promptChars: 2000, promptTokens: 256, seeded: true, steps: 8 })
    expect(imageLimitsOf({ id: 'm' })).toBeUndefined()
    expect(imageLimitsOf({ id: 'm', limits: { max_width: 1024 } })).toBeUndefined()
    expect(imageLimitsOf({ id: 'm', limits: { max_width: 1024, max_height: 1024 } })).toEqual({ maxWidth: 1024, maxHeight: 1024 })
    const limits = { maxWidth: 768, maxHeight: 768, maxPixels: 589824 }
    expect(['1280x720', '1536x1024', '768x1152', '1024x1024', '1600x1200', '900x1200', '720x1280', '2520x1080', undefined].map(size => sizeWithin(size, limits)))
      .toEqual(['736x416', '768x512', '512x768', '768x768', '768x576', '576x768', '416x736', '672x288', '768x768'])
    // Pixels in all can be the tighter limit; sides that are no multiple of 32 are brought down to one.
    expect(sizeWithin('1280x720', { maxWidth: 2048, maxHeight: 2048, maxPixels: 1048576 })).toBe('1344x768')
    expect(sizeWithin('1280x720', { maxWidth: 1000, maxHeight: 700 })).toBe('960x544')
    // What the settings show is what the provider asks.
    expect(fittedSize(own(), '1280x720', limits)).toBe('736x416')
    expect(fittedSize(own({ sizes: ['768x512'] }), '1280x720', limits)).toBe('768x512')
    expect(fittedSize(own({ local: false }), '1280x720', limits)).toBe('1280x720')
    rules.listing = true
    const models = await listEndpointModels(base, 'image', 'good')
    // What the server says is an image model is one, whatever it is called; a model it says nothing of is offered
    // after those, marked; one whose name, or the server, says it is something else is not offered.
    expect(models.map(model => `${model.id}${model.unsure === true ? '?' : ''}`)).toEqual(['qwen-image-2.1-nf4', 'qwen-image-2.1-turbo-nf4', 'text-model?'])
    expect(models[1]!.image).toEqual({ maxWidth: 768, maxHeight: 768, maxPixels: 589824, promptChars: 2000, promptTokens: 256, seeded: true, steps: 8 })
    // A model put on the server since — "noct-q-v4-nf4", nothing in its name of pictures — is in the list: the server says what it draws.
    rules.third = true
    const grown = await listEndpointModels(base, 'image', 'good')
    expect(grown.map(model => model.id)).toEqual(['noct-q-v4-nf4', 'qwen-image-2.1-nf4', 'qwen-image-2.1-turbo-nf4', 'text-model'])
    expect(grown[0]).toMatchObject({ id: 'noct-q-v4-nf4', image: { maxWidth: 768, promptTokens: 256 } })
    expect(grown[0]!.unsure).toBeUndefined()
  })

  it('reads the list again for a model it did not have: one put on the server since', async () => {
    rules.listing = true
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Not on the server yet: nothing is known of it, and it is asked the way a server of one's own is asked.
      expect(await createImageProvider(own({ model: 'noct-q-v4-nf4' }), keys)!.prompting!()).toEqual({ avoidInPrompt: true })
      expect(listings).toBe(1)
      // Put there a moment later. Asked again at once, the list is not read a second time…
      rules.third = true
      expect(await createImageProvider(own({ model: 'noct-q-v4-nf4' }), keys)!.prompting!()).toEqual({ avoidInPrompt: true })
      expect(listings).toBe(1)
      // …but a minute on it is — long before the half hour a list is otherwise kept for — and the model is known.
      vi.setSystemTime(Date.now() + 61_000)
      expect(await createImageProvider(own({ model: 'noct-q-v4-nf4' }), keys)!.prompting!()).toEqual({ tokens: 256, avoidInPrompt: true })
      expect(listings).toBe(2)
      // A model the list has is not a reason to read it again.
      vi.setSystemTime(Date.now() + 61_000)
      expect(await createImageProvider(own({ model: 'qwen-image-2.1-nf4' }), keys)!.prompting!()).toMatchObject({ tokens: 256 })
      expect(listings).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes without a key where none is saved, and says so when the server wants one', async () => {
    const keyless = createImageProvider(own({ apiKeyRef: undefined } as never), keys)!
    const refusal = await keyless.generate({ prompt: 'a boat' }).catch((error: unknown) => error) as Error & { status?: number; code?: string }
    expect(refusal).toMatchObject({ status: 401, code: 'NO_CREDENTIAL' })
    expect(refusal.message).toContain('Bearer token required')
    expect(refusal.message).toContain('paste it in Whalesong Studio → Settings')
    // A server that asks for none is drawn with as it is.
    rules.key = undefined
    const image = await keyless.generate({ prompt: 'a boat', size: '768x1152' })
    expect(Buffer.from(image.data).equals(Buffer.from(PIXEL))).toBe(true)
    expect(seen.at(-1)).toMatchObject({ auth: undefined, body: { size: '512x768' } })
    // A key that is named and not set is still a mistake to be told about.
    await expect(createImageProvider(own({ apiKeyRef: 'MISSING' }), keys)!.generate({ prompt: 'a boat' })).rejects.toMatchObject({ code: 'NO_CREDENTIAL' })
  })

  it('reads how long a busy server asks to be left alone', async () => {
    rules.busyFirst = 1
    rules.retryAfter = '3'
    const provider = createImageProvider(own(), keys)!
    const busy = await provider.generate({ prompt: 'a boat' }).catch((error: unknown) => error) as { status?: number; retryAfterMs?: number; message: string }
    expect(busy).toMatchObject({ status: 429, retryAfterMs: 3000 })
    expect(busy.message).toContain('the model is drawing another picture')
    // Seconds, a fraction of one, or a date; nothing where there is nothing to wait for.
    const header = (value?: string): Headers => new Headers(value !== undefined ? { 'retry-after': value } : {})
    expect(retryAfterMs(header('2'))).toBe(2000)
    expect(retryAfterMs(header('0.5'))).toBe(500)
    expect(retryAfterMs(header('Fri, 09 Oct 2026 12:00:10 GMT'), Date.parse('2026-10-09T12:00:00Z'))).toBe(10_000)
    expect(retryAfterMs(header('Fri, 09 Oct 2026 12:00:00 GMT'), Date.parse('2026-10-09T12:00:10Z'))).toBeUndefined()
    expect(retryAfterMs(header('0'))).toBeUndefined()
    expect(retryAfterMs(header('soon'))).toBeUndefined()
    expect(retryAfterMs(header())).toBeUndefined()
  })

  it('draws one picture at a time through the Studio, and waits out a busy server as long as it says', async () => {
    // No key in this Studio, and a server that wants none; the author's number of pictures at once is eight and more.
    rules.key = undefined
    const bed = await createTestBed({ settings: { image: { provider: 'openai', baseURL: base, model: 'qwen-image-2.1-nf4', concurrency: 16 } } })
    try {
      expect(bed.core.parallel('image')).toBe(1)
      const images = (await bed.core.imageProvider(bed.runtime))!
      const drawn = await Promise.all(['768x1152', '1024x1024', '1536x1024', '1280x720', '1280x720'].map(size => images.generate({ prompt: `a picture at ${size}`, size })))
      expect(drawn).toHaveLength(5)
      expect(seen.map(call => call.body.size)).toEqual(['512x768', '768x768', '768x512', '768x512', '768x512'])
      // Never two at the server at once — so it never had to turn one away.
      expect(most).toBe(1)
      expect(refused).toBe(0)

      // Somebody else is drawing on it: it says to come back in a second, and that is how long the gate stays shut.
      rules.busyFirst = 1
      const before = Date.now()
      const late = await images.generate({ prompt: 'after the wait', size: '1280x720' })
      expect(Buffer.from(late.data).equals(Buffer.from(PIXEL))).toBe(true)
      expect(refused).toBe(1)
      expect(Date.now() - before).toBeGreaterThanOrEqual(950)
      expect(Date.now() - before).toBeLessThan(1500)

      // Another way of drawing is chosen: the author's number holds again.
      await bed.core.settings.update({ image: { baseURL: 'https://gateway.example.com/v1' } })
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      expect(bed.core.parallel('image')).toBe(16)
    } finally {
      await bed.cleanup()
    }
  })
})

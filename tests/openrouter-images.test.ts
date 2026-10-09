// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures through OpenRouter's images endpoint. Its models differ in what
 * they take — a shape and a fineness, a shape alone, a quality, one reference
 * picture or sixteen — and refuse what they do not, so the Studio asks the
 * endpoint what a model takes and sends only that.
 *
 * The stand-in answers as the service was seen to on 2026-10-09: the listing
 * (`GET /images/models`) with the entries of five of its models as they stood,
 * and refusals in its own words ("No provider for … supports the requested
 * parameter(s): …. Provider rejections: Google: resolution: not supported.
 * Accepted: 512, 1K, 2K, 4K").
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { namedKeySource } from '../src/core/media/http'
import { createImageProvider, forgetImageListings, openRouterAsk, refusedParameters } from '../src/core/media/image'
import type { ImageSettings } from '../src/shared/types'
import { PIXEL } from './support/harness'

const B64 = Buffer.from(PIXEL).toString('base64')
const keys = namedKeySource(name => (name === 'GOOD' ? 'good' : undefined))
const choice = (...values: string[]) => ({ type: 'enum', values })
const count = (min: number, max: number) => ({ type: 'range', min, max })

const GEMINI_SHAPES = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']
const PRO_SHAPES = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

/** The listing, as OpenRouter gave it. */
const LISTED: Record<string, Record<string, unknown>> = {
  'openai/gpt-image-2.5-sunburst': { aspect_ratio: choice('1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto'), quality: choice('auto', 'low', 'medium', 'high', 'xhigh', 'max'), background: choice('auto', 'transparent', 'opaque'), n: count(1, 10), input_references: count(0, 16), output_compression: count(0, 100) },
  'google/gemini-3.1-flash-image': { resolution: choice('512', '1K', '2K', '4K'), aspect_ratio: choice(...GEMINI_SHAPES), n: count(1, 1), input_references: count(0, 14) },
  'google/gemini-3-pro-image': { resolution: choice('1K', '2K', '4K'), aspect_ratio: choice(...PRO_SHAPES), n: count(1, 1), input_references: count(0, 14) },
  'recraft/recraft-v4.1-pro': { aspect_ratio: choice('1:1', '4:3', '3:4', '16:9', '9:16', 'auto'), n: count(1, 6), input_references: count(0, 1) },
  'bytedance-seed/seedream-5-0-pro': { resolution: choice('1K', '2K'), aspect_ratio: choice('1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', 'auto'), n: count(1, 1), input_references: count(0, 14), seed: { type: 'boolean' } },
  'blocked/by-the-account': { aspect_ratio: choice('1:1', '16:9'), n: count(1, 1) },
}

/**
 * What the providers behind a model take once it comes to drawing — the listing, except where an account's rules
 * leave the provider with more out (Gemini 3 Pro's 4K) — and what a model nobody listed takes.
 */
const DRAWS: Record<string, { provider: string; takes: Record<string, string[] | true> }> = {
  'openai/gpt-image-2.5-sunburst': { provider: 'OpenAI', takes: { aspect_ratio: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', 'auto'], quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], n: true, input_references: true } },
  'google/gemini-3.1-flash-image': { provider: 'Google', takes: { resolution: ['512', '1K', '2K', '4K'], aspect_ratio: GEMINI_SHAPES, n: true, input_references: true } },
  'google/gemini-3-pro-image': { provider: 'Google', takes: { resolution: ['1K', '2K'], aspect_ratio: PRO_SHAPES, n: true, input_references: true } },
  'recraft/recraft-v4.1-pro': { provider: 'Recraft', takes: { aspect_ratio: ['1:1', '4:3', '3:4', '16:9', '9:16', 'auto'], n: true, input_references: true } },
  'bytedance-seed/seedream-5-0-pro': { provider: 'Seed', takes: { resolution: ['1K', '2K'], aspect_ratio: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', 'auto'], n: true, input_references: true } },
  'newcomer/unlisted-image': { provider: 'Newcomer', takes: { resolution: ['1K', '2K'], aspect_ratio: ['1:1', '16:9', '9:16'], n: true } },
}

describe('pictures through OpenRouter', () => {
  let server: Server
  let base = ''
  const posts: Record<string, unknown>[] = []
  let listings = 0
  /** A test may take the listing away. */
  let listingThere = true

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const answer = (status: number, body: unknown): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
      if (request.method === 'GET' && request.url === '/api/v1/images/models') {
        listings += 1
        if (!listingThere) answer(503, { error: { message: 'try later' } })
        else answer(200, { data: Object.entries(LISTED).map(([id, supported_parameters]) => ({ id, name: id, supported_parameters, supports_streaming: false })) })
        return
      }
      if (request.method !== 'POST' || request.url !== '/api/v1/images') {
        answer(404, { error: { message: 'Not Found', code: 404 } })
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      posts.push(body)
      const model = String(body.model)
      if (model === 'blocked/by-the-account') {
        answer(404, { error: { message: '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\nZDR violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy', code: 404 } })
        return
      }
      const draws = DRAWS[model]
      if (draws === undefined) {
        answer(400, { error: { message: `${model} is not a valid model ID`, code: 400 } })
        return
      }
      const asked = Object.entries(body).filter(([name]) => name !== 'model' && name !== 'prompt')
      const rejections = asked.flatMap(([name, value]) => {
        const takes = draws.takes[name]
        if (takes === undefined) return [`${name}: not supported`]
        return takes === true || takes.includes(String(value)) ? [] : [`${name}: not supported. Accepted: ${takes.join(', ')}`]
      })
      if (rejections.length > 0) {
        answer(400, { error: { message: `No provider for ${model} supports the requested parameter(s): ${asked.map(([name, value]) => `${name} "${typeof value === 'object' ? '…' : String(value)}"`).join(', ')}. Provider rejections: ${draws.provider}: ${rejections.join('; ')}`, code: 400 } })
        return
      }
      // Seedream answers in JPEG whatever it is asked for.
      answer(200, { created: 0, data: [{ b64_json: B64, media_type: model.startsWith('bytedance') ? 'image/jpeg' : 'image/png' }], usage: { cost: 0.07 } })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })
  afterAll(async () => { await new Promise((resolve) => { server.close(resolve) }) })
  beforeEach(() => {
    posts.length = 0
    listings = 0
    listingThere = true
    forgetImageListings()
  })

  const through = (model: string, extra: Partial<ImageSettings> = {}) => createImageProvider({ provider: 'openrouter', baseURL: base, model, apiKeyRef: 'GOOD', ...extra }, keys)!
  const reference = { data: PIXEL, mime: 'image/png' }
  const sentOf = (body: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([name]) => name !== 'prompt' && name !== 'model'))

  it('sends GPT Image a shape and no fineness: it has none to choose', async () => {
    const images = through('openai/gpt-image-2.5-sunburst', { negativePrompt: 'text' })
    // A scene, a design sheet, a cover, a portrait: every size the Studio asks for by itself.
    const drawn = []
    for (const size of ['1280x720', '1536x1024', '768x1152', '1024x1024']) drawn.push(await images.generate({ prompt: 'a paper boat', size }))
    expect(posts.map(sentOf)).toEqual([{ aspect_ratio: '16:9', n: 1 }, { aspect_ratio: '3:2', n: 1 }, { aspect_ratio: '2:3', n: 1 }, { aspect_ratio: '1:1', n: 1 }])
    expect(posts[0]).toMatchObject({ model: 'openai/gpt-image-2.5-sunburst', prompt: 'a paper boat\n\nAvoid: text' })
    expect(Buffer.from(drawn[0]!.data).equals(Buffer.from(PIXEL))).toBe(true)
    // The record says what was asked, in the service's terms.
    expect(drawn.map(image => image.sent?.size)).toEqual(['16:9', '3:2', '2:3', '1:1'])
    // Four pictures, one question about what the model takes.
    expect(listings).toBe(1)
    // A quality it knows goes along, and as many reference pictures as were handed over.
    posts.length = 0
    const fine = await through('openai/gpt-image-2.5-sunburst', { quality: 'high' }).generate({ prompt: 'her', size: '768x1152', references: [reference, reference, reference] })
    expect(sentOf(posts[0]!)).toMatchObject({ aspect_ratio: '2:3', n: 1, quality: 'high' })
    expect(posts[0]!.input_references).toHaveLength(3)
    expect(fine.referencesUsed).toBe(3)
    expect(posts[0]).not.toHaveProperty('resolution')
    expect(posts[0]).not.toHaveProperty('output_format')
  })

  it('asks Gemini for a fineness it has: a design sheet at 1K, not at 1.5K', async () => {
    const images = through('google/gemini-3.1-flash-image', { quality: 'high' })
    for (const size of ['1536x1024', '1280x720', '1920x1080', '3840x2160', '640x360', '900x600']) await images.generate({ prompt: 'a paper boat', size })
    expect(posts.map(sentOf)).toEqual([
      // 1.5K is not among 512, 1K, 2K, 4K: the nearer in pixels of its neighbours, and a quality the model does not know stays behind.
      { aspect_ratio: '3:2', resolution: '1K', n: 1 },
      { aspect_ratio: '16:9', resolution: '1K', n: 1 },
      { aspect_ratio: '16:9', resolution: '2K', n: 1 },
      { aspect_ratio: '16:9', resolution: '4K', n: 1 },
      { aspect_ratio: '16:9', resolution: '512', n: 1 },
      // 768 is not there either.
      { aspect_ratio: '3:2', resolution: '1K', n: 1 },
    ])
    // Nothing had to be refused first.
    expect(posts).toHaveLength(6)
  })

  it('learns from a refusal what the account\'s providers take, and remembers it', async () => {
    // The listing says 4K; the one provider this account may use stops at 2K.
    const images = through('google/gemini-3-pro-image')
    const first = await images.generate({ prompt: 'a wide hall', size: '3840x2160' })
    expect(posts.map(sentOf)).toEqual([{ aspect_ratio: '16:9', resolution: '4K', n: 1 }, { aspect_ratio: '16:9', resolution: '2K', n: 1 }])
    expect(first.sent?.size).toBe('16:9 · 2K')
    // The next picture is not refused first.
    await images.generate({ prompt: 'the hall again', size: '3840x2160' })
    expect(posts).toHaveLength(3)
    expect(sentOf(posts[2]!)).toEqual({ aspect_ratio: '16:9', resolution: '2K', n: 1 })
  })

  it('finds out by asking what a model nobody listed takes', async () => {
    const images = through('newcomer/unlisted-image', { quality: 'high' })
    const image = await images.generate({ prompt: 'a design sheet', size: '1536x1024', references: [reference] })
    // What most models take is tried; the refusal names a fineness and a shape it has, and says it knows no quality and takes no reference.
    expect(posts.map(sentOf).map(({ input_references: _pictures, ...rest }) => rest)).toEqual([
      { aspect_ratio: '4:3', resolution: '1.5K', n: 1, quality: 'high' },
      { aspect_ratio: '16:9', resolution: '1K', n: 1 },
    ])
    expect(posts[0]).toHaveProperty('input_references')
    expect(posts[1]).not.toHaveProperty('input_references')
    expect(image.referencesUsed).toBe(0)
    expect(image.sent?.size).toBe('16:9 · 1K')
  })

  it('draws without the listing when the listing cannot be had, and asks for it again next time', async () => {
    listingThere = false
    const images = through('google/gemini-3.1-flash-image')
    await images.generate({ prompt: 'a design sheet', size: '1536x1024' })
    expect(posts.map(sentOf)).toEqual([{ aspect_ratio: '4:3', resolution: '1.5K', n: 1 }, { aspect_ratio: '4:3', resolution: '1K', n: 1 }])
    listingThere = true
    forgetImageListings()
    posts.length = 0
    await images.generate({ prompt: 'a design sheet', size: '1536x1024' })
    expect(posts.map(sentOf)).toEqual([{ aspect_ratio: '3:2', resolution: '1K', n: 1 }])
    expect(listings).toBe(2)
  })

  it('holds back the reference pictures a model has no room for, and takes whatever format comes', async () => {
    const one = await through('recraft/recraft-v4.1-pro').generate({ prompt: 'her', size: '768x1152', references: [reference, reference, reference] })
    expect(posts[0]!.input_references).toHaveLength(1)
    expect(one.referencesUsed).toBe(1)
    expect(sentOf({ ...posts[0]!, input_references: undefined })).toEqual({ aspect_ratio: '3:4', n: 1, input_references: undefined })
    const jpeg = await through('bytedance-seed/seedream-5-0-pro').generate({ prompt: 'a paper boat', size: '1920x1080' })
    expect(jpeg.mime).toBe('image/jpeg')
    expect(sentOf(posts[1]!)).toEqual({ aspect_ratio: '16:9', resolution: '2K', n: 1 })
  })

  it('says before drawing how many reference pictures a model takes, by the listing', async () => {
    // As many as the listing gives room for, up to what the Studio ever sends; none where the listing has no such parameter.
    expect((await through('recraft/recraft-v4.1-pro').prompting!()).references).toBe(1)
    expect((await through('google/gemini-3-pro-image').prompting!()).references).toBeGreaterThan(1)
    expect(await through('blocked/by-the-account').prompting!()).toEqual({ avoidInPrompt: true, references: 0 })
    // A model nobody listed is asked as one that takes them; so is any model while the listing cannot be had.
    expect(await through('newcomer/unlisted-image', { promptTokens: 200 }).prompting!()).toEqual({ tokens: 200, avoidInPrompt: true })
    forgetImageListings()
    listingThere = false
    expect(await through('blocked/by-the-account').prompting!()).toEqual({ avoidInPrompt: true })
  })

  it('says what to do when the account\'s privacy settings leave a model no provider', async () => {
    const refusal = await through('blocked/by-the-account').generate({ prompt: 'a paper boat', size: '1280x720' }).catch((error: unknown) => error) as Error & { status?: number }
    expect(refusal.status).toBe(404)
    expect(refusal.message).toContain('0 endpoints out of 1 requested are available')
    expect(refusal.message).toContain('https://openrouter.ai/settings/privacy, or choose another model')
    // Asked once: there is nothing in that refusal to ask differently.
    expect(posts).toHaveLength(1)
    await expect(through('nobody/knows-this').generate({ prompt: 'a paper boat' })).rejects.toMatchObject({ status: 400 })
    expect(posts).toHaveLength(2)
  })

  it('reads a refusal as the service words it', () => {
    expect(refusedParameters('No provider for google/gemini-3-pro-image supports the requested parameter(s): resolution "768", aspect_ratio "1:8", output_format "png", n "1". Provider rejections: Google: resolution: not supported. Accepted: 1K, 2K; aspect_ratio: not supported. Accepted: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9'))
      .toEqual({ resolution: ['1K', '2K'], aspect_ratio: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] })
    expect(refusedParameters('No provider for x supports the requested parameter(s): quality "high". Provider rejections: X: quality: not supported')).toEqual({ quality: null })
    expect(refusedParameters('0 endpoints out of 1 requested are available matching your guardrail restrictions')).toEqual({})
    expect(refusedParameters('resolution: not supported')).toEqual({})
  })

  it('asks a model nothing is known of for what most models take', () => {
    const ask = openRouterAsk({ model: 'm', prompt: 'p', wanted: '768x1152', quality: 'low', references: [reference] })
    expect({ ...ask.body, input_references: undefined }).toEqual({ model: 'm', prompt: 'p', aspect_ratio: '3:4', resolution: '1K', n: 1, quality: 'low', input_references: undefined })
    expect(ask).toMatchObject({ size: '3:4 · 1K', references: 1 })
    // A model that takes nothing but the words is sent nothing but the words.
    expect(openRouterAsk({ model: 'm', prompt: 'p', wanted: '1280x720', quality: 'high', references: [reference] }, {})).toEqual({ body: { model: 'm', prompt: 'p' }, references: 0 })
    // Formats to choose from: PNG where it is one of them.
    expect(openRouterAsk({ model: 'm', prompt: 'p', wanted: '1280x720', references: [] }, { output_format: { values: ['png', 'jpeg'] } }).body).toEqual({ model: 'm', prompt: 'p', output_format: 'png' })
    expect(openRouterAsk({ model: 'm', prompt: 'p', wanted: '1280x720', references: [] }, { output_format: { values: ['svg'] } }).body).toEqual({ model: 'm', prompt: 'p' })
  })
})

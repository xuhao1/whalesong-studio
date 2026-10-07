// SPDX-License-Identifier: LGPL-3.0-or-later
/** Services, keys, direct endpoints and book files: everything the one-click setup and the per-slot settings stand on. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LlmBackend } from '../src/core/llm'
import { LlmCallError } from '../src/core/llm'
import { completeDirect, createRoutedLlm, isDirect, reasoningParams } from '../src/core/media/chat'
import { listEndpointModels, modelsBase } from '../src/core/media/discovery'
import { namedKeySource, ProviderError, requireKey } from '../src/core/media/http'
import { createImageProvider, nearestAspect, parseSize } from '../src/core/media/image'
import { audioGenPrompt, createTtsProvider, splitForSpeech } from '../src/core/media/tts'
import { castVoice, describesVoices, stockVoices } from '../src/core/media/voices'
import { zipStore } from '../src/core/pipelines/export'
import { splitChapters } from '../src/core/pipelines/import'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings'
import { docxToBook, epubToBook, htmlToText, readBookFile, readZip } from '../src/core/util/bookfile'
import { KeyStore } from '../src/host/keys'
import {
  bailianRealtime, compatibleBase, hostOf, keySlot, originOf, recommendedSetup, serviceOf, setupPatch,
} from '../src/shared/services'
import type { CharacterCard } from '../src/shared/types'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('services', () => {
  it('reads the origin and host out of whatever address is pasted', () => {
    expect(originOf('wss://ws-abc.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=x')).toBe('https://ws-abc.cn-beijing.maas.aliyuncs.com')
    expect(originOf('https://dashscope.aliyuncs.com/compatible-mode/v1/')).toBe('https://dashscope.aliyuncs.com')
    expect(originOf('openrouter.ai/api/v1')).toBe('https://openrouter.ai')
    expect(originOf('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000')
    expect(originOf('   ')).toBeUndefined()
    expect(hostOf('HTTPS://OpenRouter.ai/api/v1')).toBe('openrouter.ai')
  })

  it('keeps one key slot per host, in the credential record grammar', () => {
    expect(keySlot('https://openrouter.ai/api/v1')).toBe('key-openrouter-ai')
    expect(keySlot('wss://dashscope.aliyuncs.com/api-ws/v1/realtime')).toBe(keySlot('https://dashscope.aliyuncs.com/compatible-mode/v1'))
    expect(keySlot('http://127.0.0.1:3311/v1')).toBe('key-127-0-0-1-3311')
    expect(keySlot('https://ws-abc.cn-beijing.maas.aliyuncs.com')).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(keySlot('not a url at all ::')).toBeUndefined()
  })

  it('recognizes the known services by host', () => {
    expect(serviceOf('https://dashscope.aliyuncs.com')).toBe('bailian')
    expect(serviceOf('wss://ws-abc.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime')).toBe('bailian')
    expect(serviceOf('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(serviceOf('https://api.openai.com/v1')).toBe('openai')
    expect(serviceOf('https://gateway.example.com/v1')).toBe('custom')
  })

  it('builds the endpoints of a service on any origin', () => {
    expect(compatibleBase('bailian')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(compatibleBase('bailian', 'wss://ws-abc.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime')).toBe('https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
    expect(compatibleBase('openrouter')).toBe('https://openrouter.ai/api/v1')
    expect(compatibleBase('custom', 'http://localhost:8000/v1/')).toBe('http://localhost:8000/v1')
    expect(bailianRealtime('https://ws-abc.cn-beijing.maas.aliyuncs.com')).toBe('wss://ws-abc.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime')
  })

  it('recommends a complete setup per service and lets parts be picked', () => {
    for (const service of ['bailian', 'openrouter', 'openai'] as const) {
      const setup = recommendedSetup(service)!
      for (const role of ['writer', 'analyst', 'architect', 'director'] as const) {
        expect(isDirect(setup.text[role])).toBe(true)
        expect(serviceOf(setup.text[role].baseURL)).toBe(service)
      }
      expect(setup.embedding.provider).toBe('openai')
      expect(setup.image.provider).not.toBe('none')
      expect(setup.tts.provider).not.toBe('none')
    }
    expect(recommendedSetup('openrouter')!.image.model).toMatch(/^openai\/gpt-image/)
    expect(recommendedSetup('bailian')!.tts.model).toBe('qwen-audio-3.1-tts-next')
    expect(recommendedSetup('custom')).toBeUndefined()
    const patch = setupPatch(recommendedSetup('bailian')!, ['image', 'tts'])
    expect(Object.keys(patch).sort()).toEqual(['image', 'tts'])
  })

  it('merges a setup into saved settings without losing the rest', () => {
    const setup = recommendedSetup('openrouter')!
    const merged = mergeSettings(structuredClone(DEFAULT_SETTINGS), { ...setupPatch(setup, ['text', 'image']), setup: { done: true } })
    expect(merged.models.writer?.model).toBe(setup.text.writer.model)
    expect(merged.image.provider).toBe('openrouter')
    expect(merged.tts.provider).toBe('none')
    expect(merged.setup?.done).toBe(true)
    // A role set to null goes back to following the chat model.
    expect(mergeSettings(merged, { models: { writer: null } }).models.writer).toBeUndefined()
  })
})

describe('keys', () => {
  /** A credential seam with the two key spaces the Harness has. */
  function fakeContext(refs: Record<string, string> = {}) {
    const records = new Map<string, { kind: 'api-key'; key?: string }>()
    const ctx = {
      credentials: {
        resolve: async (ref: string) => (refs[ref] !== undefined ? { value: refs[ref], source: 'file' } : undefined),
        readRecord: async (key: string) => records.get(key),
        modifyRecord: async (key: string, mutate: (current: unknown) => Promise<{ kind: 'api-key'; key?: string } | undefined>) => {
          const next = await mutate(records.get(key))
          if (next !== undefined) records.set(key, next)
          return next
        },
        deleteRecord: async (key: string) => { records.delete(key) },
      },
    }
    return { ctx: ctx as unknown as Context, records }
  }

  it('stores a key per host under the plugin scope and never elsewhere', async () => {
    const { ctx, records } = fakeContext()
    const keys = new KeyStore(ctx, () => {})
    expect(await keys.describe('https://openrouter.ai/api/v1')).toEqual({ host: 'openrouter.ai', configured: false })
    await keys.save('https://openrouter.ai/api/v1', '  sk-test-123  ')
    expect([...records.keys()]).toEqual(['novel-writer/key-openrouter-ai'])
    expect(await keys.forEndpoint('https://openrouter.ai/api/v1/images')).toBe('sk-test-123')
    expect(await keys.forEndpoint('https://api.openai.com/v1')).toBeUndefined()
    expect(await keys.describe('https://openrouter.ai')).toEqual({ host: 'openrouter.ai', configured: true, source: 'saved' })
    await keys.clear('https://openrouter.ai/api/v1')
    expect(await keys.forEndpoint('https://openrouter.ai/api/v1')).toBeUndefined()
  })

  it('refuses blanks and anything that is not one token', async () => {
    const keys = new KeyStore(fakeContext().ctx, () => {})
    await expect(keys.save('https://openrouter.ai/api/v1', '   ')).rejects.toThrow(/empty/)
    await expect(keys.save('https://openrouter.ai/api/v1', 'two words')).rejects.toThrow(/spaces/)
    await expect(keys.save('::', 'sk-x')).rejects.toThrow(/endpoint/)
  })

  it('falls back to the conventional variable of a service, and honours a named one', async () => {
    const { ctx } = fakeContext({ DASHSCOPE_API_KEY: 'sk-ambient', MY_KEY: 'sk-named' })
    const keys = new KeyStore(ctx, () => {})
    expect(await keys.forEndpoint('wss://dashscope.aliyuncs.com/api-ws/v1/realtime')).toBe('sk-ambient')
    expect(await keys.describe('https://dashscope.aliyuncs.com')).toEqual({ host: 'dashscope.aliyuncs.com', configured: true, source: 'env', name: 'DASHSCOPE_API_KEY' })
    expect(await keys.describe('https://gateway.example.com/v1', 'MY_KEY')).toEqual({ host: 'gateway.example.com', configured: true, source: 'named', name: 'MY_KEY' })
    expect(await requireKey(keys, { ref: 'MY_KEY', endpoint: 'https://gateway.example.com/v1' }, 'Test')).toBe('sk-named')
    await expect(requireKey(keys, { ref: 'NOT_SET', endpoint: 'https://gateway.example.com/v1' }, 'Test')).rejects.toBeInstanceOf(ProviderError)
    await expect(requireKey(keys, { endpoint: 'https://gateway.example.com/v1' }, 'Test')).rejects.toThrow(/gateway\.example\.com/)
    // A saved key wins over the ambient one.
    await keys.save('https://dashscope.aliyuncs.com', 'sk-saved')
    expect(await keys.forEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('sk-saved')
  })
})

describe('direct endpoints', () => {
  let server: Server
  let base = ''
  const seen: { path: string; body: Record<string, unknown>; auth: string | undefined }[] = []

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {}
      seen.push({ path: request.url ?? '', body, auth: request.headers.authorization })
      if (request.headers.authorization !== 'Bearer good') {
        response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }))
        return
      }
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'story-1' }, { id: 'text-embed-1' }, { id: 'image-gen-1' }, { id: 'tts-voice-1' }, { id: 'asr-1' }] }))
        return
      }
      if (request.url === '/v1/images') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64'), media_type: 'image/webp' }] }))
        return
      }
      if (request.url === '/v1/audio/speech') {
        response.writeHead(200, { 'content-type': 'audio/pcm;rate=16000' }).end(Buffer.alloc(3200, 1))
        return
      }
      if (body.model === 'picky' && (body.temperature !== undefined || body.max_tokens !== undefined)) {
        const culprit = body.temperature !== undefined ? 'temperature' : 'max_tokens'
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `Unsupported parameter: '${culprit}'` } }))
        return
      }
      if (body.model === 'missing') {
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no such model' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (value: unknown): void => { response.write(`data: ${JSON.stringify(value)}\n\n`) }
      send({ choices: [{ delta: { reasoning_content: '先想一想' } }] })
      send({ choices: [{ delta: { content: '雨停了，' } }] })
      // A chunk split mid-line must still be read.
      response.write('data: {"choices":[{"delta":{"con')
      response.write('tent":"信还没寄。"}}]}\n\n')
      send({ choices: [{ delta: {}, finish_reason: body.model === 'short' ? 'length' : 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 5 } })
      response.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(async () => { await new Promise((resolve) => { server.close(resolve) }) })

  const keys = namedKeySource(name => (name === 'GOOD' ? 'good' : name === 'BAD' ? 'bad' : undefined))
  const route = (model: string, extra: Record<string, unknown> = {}) => ({ provider: 'custom', model, baseURL: base, apiKeyRef: 'GOOD', ...extra })

  it('streams text, skips reasoning, and reports usage', async () => {
    const deltas: string[] = []
    const reply = await completeDirect(route('story-1'), { route: route('story-1'), system: 'sys', prompt: 'hi', onText: (delta) => { deltas.push(delta) } }, keys)
    // The reasoning stays out of the text; how much of it there was is reported beside it.
    expect(reply).toEqual({ text: '雨停了，信还没寄。', finish: 'stop', usage: { inputTokens: 7, outputTokens: 5 }, thought: 4 })
    expect(deltas).toEqual(['雨停了，', '信还没寄。'])
    const sent = seen.at(-1)!
    expect(sent.path).toBe('/v1/chat/completions')
    expect(sent.body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }])
    expect((await completeDirect(route('short'), { route: route('short'), prompt: 'hi' }, keys)).finish).toBe('max-tokens')
  })

  it('drops a parameter the endpoint refuses and tries again', async () => {
    const before = seen.length
    const picky = route('picky', { temperature: 0.7, maxTokens: 100, reasoningEffort: 'high' })
    const reply = await completeDirect(picky, { route: picky, prompt: 'hi' }, keys)
    expect(reply.text).toBe('雨停了，信还没寄。')
    const calls = seen.slice(before).map(call => call.body)
    expect(calls).toHaveLength(3)
    expect(calls[2]!.temperature).toBeUndefined()
    expect(calls[2]!.max_tokens).toBeUndefined()
    expect(calls[2]!.max_completion_tokens).toBe(100)
    expect(calls[2]!.reasoning_effort).toBe('high')
  })

  it('says what went wrong in terms a setting can fix', async () => {
    const bad = { ...route('story-1'), apiKeyRef: 'BAD' }
    await expect(completeDirect(bad, { route: bad, prompt: 'hi' }, keys)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    await expect(completeDirect(route('missing'), { route: route('missing'), prompt: 'hi' }, keys)).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    const keyless = { provider: 'custom', model: 'story-1', baseURL: base }
    await expect(completeDirect(keyless, { route: keyless, prompt: 'hi' }, keys)).rejects.toBeInstanceOf(LlmCallError)
    const controller = new AbortController()
    controller.abort()
    await expect(completeDirect(route('story-1'), { route: route('story-1'), prompt: 'hi', signal: controller.signal }, keys)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('sends direct routes itself and everything else to the Harness', async () => {
    const harnessCalls: string[] = []
    const harness: LlmBackend = {
      complete: async (request) => { harnessCalls.push(request.route.model); return { text: 'from harness', finish: 'stop' } },
      listModels: async () => [],
      contextWindow: async () => 1000,
      defaultRoute: () => undefined,
      reasoning: async () => ({ efforts: [{ id: 'on', name: 'On' }] }),
    }
    const llm = createRoutedLlm(harness, keys)
    expect((await llm.complete({ route: { provider: 'deepseek', model: 'deepseek-flash' }, prompt: 'hi' })).text).toBe('from harness')
    expect((await llm.complete({ route: route('story-1'), prompt: 'hi' })).text).toBe('雨停了，信还没寄。')
    expect(harnessCalls).toEqual(['deepseek-flash'])
    expect((await llm.reasoning!({ provider: 'deepseek', model: 'deepseek-flash' })).efforts).toEqual([{ id: 'on', name: 'On' }])
    expect((await llm.reasoning!(route('story-1'))).efforts.map(effort => effort.id)).toContain('off')
    expect(await llm.contextWindow(route('story-1'))).toBeUndefined()
  })

  it('spells a reasoning level the way each service takes it', () => {
    expect(reasoningParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'off')).toEqual({ enable_thinking: false })
    expect(reasoningParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'low')).toEqual({ enable_thinking: true, thinking_budget: 2048 })
    expect(reasoningParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'high')).toEqual({ enable_thinking: true })
    expect(reasoningParams('https://openrouter.ai/api/v1', 'off')).toEqual({ reasoning: { effort: 'none' } })
    expect(reasoningParams('https://openrouter.ai/api/v1', 'medium')).toEqual({ reasoning: { effort: 'medium' } })
    expect(reasoningParams('https://api.deepseek.com/v1', 'off')).toEqual({ thinking: { type: 'disabled' } })
    expect(reasoningParams('https://gateway.example.com/v1', 'high')).toEqual({ reasoning_effort: 'high' })
    expect(reasoningParams('https://gateway.example.com/v1', undefined)).toEqual({})
  })

  it('lists the models of an endpoint by what a slot needs', async () => {
    expect(modelsBase('wss://dashscope.aliyuncs.com/api-ws/v1/realtime')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect((await listEndpointModels(base, 'text', 'good')).map(model => model.id)).toEqual(['story-1'])
    expect((await listEndpointModels(base, 'embedding', 'good')).map(model => model.id)).toEqual(['text-embed-1'])
    expect((await listEndpointModels(base, 'image', 'good')).map(model => model.id)).toEqual(['image-gen-1'])
    expect((await listEndpointModels(base, 'speech', 'good')).map(model => model.id)).toEqual(['tts-voice-1'])
    await expect(listEndpointModels(base, 'text', 'bad')).rejects.toMatchObject({ status: 401 })
  })

  it('draws through an OpenRouter-style images endpoint with a ratio instead of pixels', async () => {
    const provider = createImageProvider({ provider: 'openrouter', baseURL: base, model: 'openai/gpt-image-2.5-sunburst', apiKeyRef: 'GOOD', negativePrompt: 'text' }, keys)!
    const image = await provider.generate({ prompt: 'a paper boat', size: '1280x720' })
    expect(Buffer.from(image.data).toString()).toBe('png-bytes')
    expect(image.mime).toBe('image/webp')
    const sent = seen.at(-1)!
    expect(sent.path).toBe('/v1/images')
    expect(sent.body).toMatchObject({ model: 'openai/gpt-image-2.5-sunburst', aspect_ratio: '16:9', resolution: '1K', n: 1 })
    expect(String(sent.body.prompt)).toContain('Avoid: text')
  })

  it('speaks through an OpenRouter-style speech endpoint that answers raw PCM', async () => {
    const provider = createTtsProvider({ provider: 'openrouter', baseURL: base, model: 'google/gemini-3.8-flash-tts', apiKeyRef: 'GOOD', narratorVoice: 'Charon' }, keys)!
    const audio = await provider.synthesize({ text: '你好', direction: '压低声音' })
    expect(audio.sampleRate).toBe(16000)
    expect(audio.pcm.length).toBe(1600)
    const sent = seen.at(-1)!
    expect(sent.body).toMatchObject({ voice: 'Charon', response_format: 'pcm' })
    // Gemini takes delivery direction in the prompt itself.
    expect(sent.body.input).toBe('压低声音:\n你好')
  })

  it('asks a ChatGPT subscription for images through whatever bridge the Host provides', async () => {
    const asked: string[] = []
    const provider = createImageProvider({ provider: 'codex', size: '768x1152' }, keys, { codex: async (prompt) => { asked.push(prompt); return { data: utf8('img'), mime: 'image/png' } } })!
    await provider.generate({ prompt: 'a lighthouse', negativePrompt: 'watermark' })
    expect(asked[0]).toContain('a lighthouse')
    expect(asked[0]).toContain('Avoid: watermark')
    expect(asked[0]).toContain('Portrait 2:3')
    await expect(createImageProvider({ provider: 'codex' }, keys)!.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('images', () => {
  it('maps a pixel size to the nearest ratio a model takes', () => {
    expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 })
    expect(parseSize('1280*720')).toEqual({ width: 1280, height: 720 })
    expect(parseSize('big')).toBeUndefined()
    expect(nearestAspect('1280x720')).toBe('16:9')
    expect(nearestAspect('768x1152')).toBe('3:4')
    expect(nearestAspect('1024x1024')).toBe('1:1')
    expect(nearestAspect('1536x1024', ['1:1', '3:2', '2:3'])).toBe('3:2')
  })
})

describe('speech', () => {
  it('cuts long text at sentence ends so each piece stays inside the model\'s limit', () => {
    expect(splitForSpeech('短句。')).toEqual(['短句。'])
    const long = `${'雨落在法租界旧书铺的青瓦上。'.repeat(30)}沈蘅把未卖出的讣文纸收进抽屉。`
    const pieces = splitForSpeech(long, 120)
    expect(pieces.length).toBeGreaterThan(3)
    expect(pieces.every(piece => piece.length <= 120)).toBe(true)
    expect(pieces.join('')).toBe(long)
    // A sentence longer than the limit is still cut, never dropped.
    const endless = '啊'.repeat(500)
    expect(splitForSpeech(endless, 120).join('')).toBe(endless)
  })

  it('tells the audio model who speaks, how, and nothing else', () => {
    const described = audioGenPrompt({ text: '你来晚了。', voice: '清冷克制的年轻女声', direction: '压着火气', referenced: false, language: 'zh' })
    expect(described).toContain('一位清冷克制的年轻女声（这一句：压着火气）一字不差地说：')
    expect(described).toContain('“你来晚了。”')
    expect(described).toContain('没有背景音乐')
    // With a clip to imitate, the words still say whose voice it is: a clip alone does not hold on a short line.
    const referenced = audioGenPrompt({ text: '你来晚了。', voice: '清冷克制的年轻女声', referenced: true, language: 'zh' })
    expect(referenced).toContain('@voice1（同一个人：清冷克制的年轻女声）一字不差地说：')
    expect(audioGenPrompt({ text: 'You are late.', referenced: true, language: 'en' })).toContain('@voice1 says, word for word:')
    expect(audioGenPrompt({ text: 'You are late.', voice: 'a dry, low voice', direction: 'tired', referenced: true, language: 'en' })).toContain('@voice1 (the same person: a dry, low voice) (for this line: tired) says, word for word:')
  })

  it('casts by description where voices are words, and by catalog elsewhere', () => {
    const card = { id: 'c_shen', name: '沈蘅', gender: '女', age: '24', voice: '声音偏低，语速慢，句尾轻' } as CharacterCard
    expect(describesVoices('qwen-audiogen')).toBe(true)
    expect(castVoice(card, 'qwen-audiogen', new Set())).toBe('年轻女性，声音偏低，语速慢，句尾轻')
    const plain = { id: 'c_zhou', name: '周衡', gender: '男', age: '40' } as CharacterCard
    const stock = castVoice(plain, 'qwen-audiogen', new Set())!
    expect(stockVoices('qwen-audiogen').find(voice => voice.id === stock)?.gender).toBe('male')
    expect(castVoice(plain, 'qwen-audiogen', new Set())).toBe(stock)
    expect(stockVoices('openrouter', 'google/gemini-3.8-flash-tts').some(voice => voice.id === 'Charon')).toBe(true)
    expect(stockVoices('openrouter', 'openai/gpt-4o-mini-tts-2025-12-15').some(voice => voice.id === 'alloy')).toBe(true)
    expect(stockVoices('openrouter', 'fish-audio/s2.1-pro')).toEqual([])
  })
})

describe('book files', () => {
  const chapter = (title: string, body: string): string => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>p{}</style></head><body><h1>${title}</h1><p>${body}</p><p>第二段&nbsp;&amp;&#x4E2D;&#25991;。<br/>换行。</p></body></html>`
  const epub = (): Uint8Array => zipStore([
    { name: 'mimetype', data: utf8('application/epub+zip') },
    { name: 'META-INF/container.xml', data: utf8('<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { name: 'OEBPS/content.opf', data: utf8(`<package><metadata><dc:title>七日未寄</dc:title><dc:creator opf:role="aut">某作者</dc:creator></metadata><manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/><item id="css" href="s.css" media-type="text/css"/></manifest><spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`) },
    { name: 'OEBPS/cover.xhtml', data: utf8('<html><body><img src="cover.jpg"/></body></html>') },
    { name: 'OEBPS/text/c1.xhtml', data: utf8(chapter('第一章 代笔人的规矩', '雨落在法租界旧书铺的青瓦上，沈蘅把未卖出的讣文纸收进抽屉。')) },
    { name: 'OEBPS/text/c2.xhtml', data: utf8(chapter('第二章 七日讣文', '四更天雨停，沈蘅在铺子里核对讣文底稿。')) },
  ])

  it('reads an EPUB into text the importer can split, with its title and author', () => {
    const book = epubToBook(epub())
    expect(book.title).toBe('七日未寄')
    expect(book.author).toBe('某作者')
    expect(book.text).toContain('# 第一章 代笔人的规矩')
    expect(book.text).toContain('第二段 &中文。\n换行。')
    expect(book.text).not.toContain('<')
    const chapters = splitChapters(book.text)
    expect(chapters.map(item => item.title)).toEqual(['第一章 代笔人的规矩', '第二章 七日讣文'])
    expect(chapters[0]!.text).toContain('沈蘅把未卖出的讣文纸收进抽屉')
  })

  it('reads a Word document, keeping its headings', () => {
    const paragraph = (text: string, style?: string): string => `<w:p>${style !== undefined ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
    const docx = zipStore([{ name: 'word/document.xml', data: utf8(`<w:document><w:body>${paragraph('第一章 起', 'Heading1')}${paragraph('雨停了。')}${paragraph('')}${paragraph('信还没寄。')}</w:body></w:document>`) }])
    expect(docxToBook(docx).text).toBe('# 第一章 起\n\n雨停了。\n\n信还没寄。')
    expect(readBookFile('稿子.docx', docx).text).toContain('# 第一章 起')
  })

  it('tells book files apart by content as well as by name', () => {
    expect(readBookFile('book.epub', epub()).title).toBe('七日未寄')
    expect(readBookFile('book.bin', epub()).title).toBe('七日未寄')
    expect(readBookFile('book.txt', utf8('第一章\n正文')).text).toBe('第一章\n正文')
    expect(readBookFile('page.html', utf8('<h2>序</h2><p>正文</p>')).text).toBe('# 序\n\n正文')
    expect(() => readBookFile('x.zip', zipStore([{ name: 'a.txt', data: utf8('a') }]))).toThrow(/neither/)
    expect(() => epubToBook(utf8('not a zip'))).toThrow()
  })

  it('reads stored and deflated zip entries', async () => {
    const { deflateRawSync } = await import('node:zlib')
    const stored = zipStore([{ name: 'a.txt', data: utf8('hello') }])
    expect(new TextDecoder().decode(readZip(stored).get('a.txt'))).toBe('hello')
    // Rewrite the single entry as deflated: method 8 with new sizes, in both headers.
    const raw = deflateRawSync(Buffer.from('hello hello hello'))
    const name = utf8('b.txt')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(17, 22); local.writeUInt16LE(name.length, 26)
    Buffer.from(name).copy(local, 30)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(17, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42)
    Buffer.from(name).copy(central, 46)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + raw.length, 16)
    const archive = Buffer.concat([local, raw, central, end])
    expect(new TextDecoder().decode(readZip(archive).get('b.txt'))).toBe('hello hello hello')
  })

  it('turns markup into paragraphs and headings', () => {
    expect(htmlToText('<body><h2>序  章</h2><div>一</div><p>二<script>x()</script></p><!-- c --></body>')).toBe('# 序 章\n\n一\n\n二')
  })
})

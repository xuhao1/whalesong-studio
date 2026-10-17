// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Speech synthesis providers behind one interface.
 *
 *   qwen-audiogen  Bailian audio generation (qwen-audio-3.1-tts-next). A voice is
 *                  a description in words or a short reference clip; a clip made
 *                  once per character keeps them sounding the same for the book.
 *   qwen-realtime  Qwen omni realtime models over WebSocket (OpenAI-Realtime
 *                  style events). An omni model performs the line: delivery is
 *                  steered with natural-language direction, and the spoken
 *                  transcript is checked against the text it was given.
 *   dashscope      DashScope Qwen-TTS over HTTP, including instruction-following
 *                  models and voices created with voice design.
 *   openrouter     OpenRouter's `/audio/speech` (raw PCM), many vendors behind it.
 *   openai         Any OpenAI-compatible `/audio/speech` endpoint.
 */
import WebSocket from 'ws'
import { providerDefault } from '../../shared/recommended'
import { bailianRealtime, compatibleBase, originOf } from '../../shared/services'
import { hashText } from '../../shared/text'
import type { TtsProviderKind, TtsSettings } from '../../shared/types'
import { errorMessage } from '../util/async'
import { download, postForBytes, postJson, ProviderError, requireKey, trimBase, type KeySource } from './http'
import { concatAudio, encodeWav, parseWav, pcmFromBytes, type PcmAudio } from './wav'

export interface TtsRequest {
  text: string
  /** A voice id of the provider — or, for providers that take voices in words, a description of the voice. */
  voice?: string
  /** A short clip of the voice to speak with, for providers that can imitate one. */
  reference?: PcmAudio
  /** Delivery direction in natural language: emotion, pace, volume, who is speaking. */
  direction?: string
  /** Language hint for providers that take one (`Chinese`, `English`, …). */
  language?: string
  /**
   * Which take of the line this is (0 = the first). A later take asks for the
   * same line again because the earlier one did not pass the listening check;
   * providers that draw from a seed draw a different one.
   */
  take?: number
  signal?: AbortSignal
  /** Called when the request is actually sent — it may have waited its turn first, and is called again when it is sent again. */
  onStart?: () => void
}

export interface TtsResult extends PcmAudio {
  /** What was actually spoken, when the provider reports it. */
  transcript?: string
}

export interface VoiceDesignRequest {
  /** Description of the voice: age, timbre, pace, temperament. */
  prompt: string
  /** Text the audition sample speaks. */
  previewText: string
  /** Letters/digits only; becomes part of the voice id. */
  name?: string
  language?: string
  signal?: AbortSignal
}

export interface TtsProvider {
  readonly kind: TtsProviderKind
  synthesize(request: TtsRequest): Promise<TtsResult>
  /** Create a persistent custom voice from a description, when the provider can. */
  designVoice?(request: VoiceDesignRequest): Promise<{ voice: string; preview?: PcmAudio }>
  /**
   * Set when voices are descriptions rather than ids: speak a sample of the
   * described voice. The caller keeps the clip and hands it back as
   * `reference`, which is what makes one description sound like one person.
   * The model speaks every line in the register of the clip it imitates — a
   * calm clip keeps a roar calm, however the line is directed — so the sample
   * is a voice actor's reel: the same voice talking, shouting, hushed, laughing
   * and near tears, and each line is free to be any of them. `reference` is a
   * clip the voice already has (a designed voice's preview), to make the reel
   * in that very voice; `take` asks again for one that did not pass.
   */
  anchor?(voice: string, options: { language?: string; signal?: AbortSignal; reference?: PcmAudio; take?: number }): Promise<PcmAudio>
}

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com'
const DESIGNED_VOICE = /^qwen-tts-vd-/

/** The model that speaks in a designed voice: the one named in the settings, else the one recommended for Qwen TTS. */
const designedModel = (settings: TtsSettings): string => {
  const recommended = providerDefault('tts', 'dashscope')
  return settings.designedVoiceModel ?? recommended.designedVoiceModel ?? recommended.model
}

/** @returns the provider for the current settings, or undefined when speech is switched off. */
export function createTtsProvider(settings: TtsSettings, keys: KeySource): TtsProvider | undefined {
  if (settings.provider === 'qwen-audiogen') return new QwenAudioGenTts(settings, keys)
  if (settings.provider === 'qwen-realtime') return new QwenRealtimeTts(settings, keys)
  if (settings.provider === 'dashscope') return new DashScopeTts(settings, keys)
  if (settings.provider === 'openrouter') return new OpenRouterTts(settings, keys)
  if (settings.provider === 'openai') return new OpenAiTts(settings, keys)
  return undefined
}

/** Language name the Qwen endpoints expect, from a BCP-47-ish tag. */
function qwenLanguage(language: string | undefined): string {
  const tag = (language ?? 'zh').toLowerCase()
  if (tag.startsWith('zh')) return 'Chinese'
  if (tag.startsWith('en')) return 'English'
  if (tag.startsWith('ja')) return 'Japanese'
  if (tag.startsWith('ko')) return 'Korean'
  if (tag.startsWith('fr')) return 'French'
  if (tag.startsWith('de')) return 'German'
  if (tag.startsWith('es')) return 'Spanish'
  if (tag.startsWith('ru')) return 'Russian'
  if (tag.startsWith('it')) return 'Italian'
  if (tag.startsWith('pt')) return 'Portuguese'
  return 'Auto'
}

// ───────────────────────────── DashScope HTTP ─────────────────────────────

interface DashScopeSpeech {
  output?: { audio?: { url?: string; data?: string } }
  message?: string
  code?: string
}

class DashScopeTts implements TtsProvider {
  readonly kind = 'dashscope' as const

  constructor(private readonly settings: TtsSettings, private readonly keys: KeySource) {}

  private base(): string {
    // Accept a realtime URL or a compatible-mode URL pasted by mistake: only the origin matters here.
    return originOf(this.settings.baseURL) ?? DASHSCOPE_BASE
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: this.base() }, 'Speech')
    const designed = request.voice !== undefined && DESIGNED_VOICE.test(request.voice)
    const model = designed ? (designedModel(this.settings)) : (this.settings.model ?? providerDefault('tts', 'dashscope').model)
    const followsInstructions = /instruct/.test(model)
    const reply = await postJson<DashScopeSpeech>(`${this.base()}/api/v1/services/aigc/multimodal-generation/generation`, {
      model,
      input: {
        text: request.text,
        voice: request.voice ?? this.settings.narratorVoice ?? 'Cherry',
        language_type: qwenLanguage(request.language),
        ...(followsInstructions && request.direction !== undefined && request.direction.length > 0 ? { instructions: request.direction } : {}),
      },
      ...(followsInstructions && request.direction !== undefined && request.direction.length > 0 ? { parameters: { optimize_instructions: true } } : {}),
    }, { apiKey, ...(request.signal !== undefined ? { signal: request.signal } : {}), timeoutMs: 120_000 })
    const audio = reply.output?.audio
    if (audio?.data !== undefined && audio.data.length > 0) return parseWav(Buffer.from(audio.data, 'base64'))
    if (audio?.url === undefined) throw new ProviderError(`speech synthesis returned no audio${reply.message !== undefined ? `: ${reply.message}` : ''}`)
    const file = await download(audio.url, request.signal !== undefined ? { signal: request.signal } : {})
    return parseWav(file.data)
  }

  async designVoice(request: VoiceDesignRequest): Promise<{ voice: string; preview?: PcmAudio }> {
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: this.base() }, 'Voice design')
    const name = (request.name ?? 'voice').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'voice'
    const reply = await postJson<{ output?: { voice?: string; preview_audio?: { data?: string } }; message?: string }>(
      `${this.base()}/api/v1/services/audio/tts/customization`,
      {
        model: 'qwen-voice-design',
        input: {
          action: 'create',
          target_model: designedModel(this.settings),
          voice_prompt: request.prompt.slice(0, 2000),
          preview_text: request.previewText.slice(0, 1000),
          preferred_name: name,
          language: (request.language ?? 'zh').slice(0, 2),
        },
        parameters: { sample_rate: 24000, response_format: 'wav' },
      },
      { apiKey, ...(request.signal !== undefined ? { signal: request.signal } : {}), timeoutMs: 120_000 },
    )
    const voice = reply.output?.voice
    if (voice === undefined) throw new ProviderError(`voice design returned no voice${reply.message !== undefined ? `: ${reply.message}` : ''}`)
    const data = reply.output?.preview_audio?.data
    return { voice, ...(data !== undefined && data.length > 0 ? { preview: parseWav(Buffer.from(data, 'base64')) } : {}) }
  }
}

// ───────────────────────────── OpenAI-compatible ─────────────────────────────

class OpenAiTts implements TtsProvider {
  readonly kind = 'openai' as const

  constructor(private readonly settings: TtsSettings, private readonly keys: KeySource) {}

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openai'))
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: base }, 'Speech')
    const response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.settings.model ?? providerDefault('tts', 'openai').model,
        input: request.text,
        voice: request.voice ?? this.settings.narratorVoice ?? 'alloy',
        response_format: 'wav',
        ...(request.direction !== undefined && request.direction.length > 0 ? { instructions: request.direction } : {}),
      }),
      signal: request.signal ?? null,
    })
    if (!response.ok) {
      throw new ProviderError(`speech endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`, response.status)
    }
    return parseWav(new Uint8Array(await response.arrayBuffer()))
  }
}

// ───────────────────────────── OpenRouter ─────────────────────────────

class OpenRouterTts implements TtsProvider {
  readonly kind = 'openrouter' as const

  constructor(private readonly settings: TtsSettings, private readonly keys: KeySource) {}

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const base = trimBase(this.settings.baseURL?.trim() || compatibleBase('openrouter'))
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: base }, 'Speech')
    const model = this.settings.model ?? providerDefault('tts', 'openrouter').model
    const direction = request.direction?.trim()
    const steerable = direction !== undefined && direction.length > 0
    // Vendors take delivery direction differently: OpenAI in a field, Gemini in the prompt itself, most others not at all.
    const openai = /(^|\/)gpt-[^/]*tts|(^|\/)tts-1/i.test(model)
    const gemini = /gemini[^/]*tts/i.test(model)
    const voice = request.voice ?? this.settings.narratorVoice
    const reply = await postForBytes(`${base}/audio/speech`, {
      model,
      input: steerable && gemini ? `${direction}:\n${request.text}` : request.text,
      ...(voice !== undefined && voice.length > 0 ? { voice } : {}),
      response_format: 'pcm',
      ...(steerable && openai ? { instructions: direction } : {}),
    }, { apiKey, headers: { 'x-title': 'Whalesong Studio' }, ...(request.signal !== undefined ? { signal: request.signal } : {}), timeoutMs: 180_000 })
    // A gateway that answers with a WAV container anyway is taken at its word.
    if (reply.data.length > 12 && String.fromCharCode(...reply.data.subarray(0, 4)) === 'RIFF') return parseWav(reply.data)
    if (reply.mime === 'audio/mpeg' || reply.mime === 'audio/mp3') throw new ProviderError(`${model} answered with MP3; this endpoint cannot be used until it serves PCM or WAV`, undefined, 'UNSUPPORTED')
    const declared = /rate=(\d{4,6})/.exec(reply.headers.get('content-type') ?? '')?.[1] ?? reply.headers.get('x-sample-rate')
    const audio = pcmFromBytes(reply.data, declared !== null && declared !== undefined ? Number(declared) : this.settings.sampleRate ?? 24000)
    if (audio.pcm.length === 0) throw new ProviderError('speech synthesis returned no audio')
    return audio
  }
}

// ───────────────────────────── Bailian audio generation ─────────────────────────────

interface AudioGenReply {
  output?: { audio?: { url?: string; data?: string; duration?: number } }
  message?: string
  code?: string
}

/** Text is spoken in pieces short enough to stay well inside the model's two-minute output limit. */
const AUDIOGEN_CHUNK = 320

/** Split at sentence ends so each piece reads naturally on its own. */
export function splitForSpeech(text: string, limit = AUDIOGEN_CHUNK): string[] {
  const clean = text.trim()
  if (clean.length <= limit) return clean.length > 0 ? [clean] : []
  const sentences = clean.match(/[^。！？!?…\n]+[。！？!?…]*["”’」』）)]*\s*|\n+/g) ?? [clean]
  const pieces: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length > limit) {
      pieces.push(current.trim())
      current = ''
    }
    // A single sentence longer than the limit is cut at commas, then hard.
    let rest = sentence
    while (rest.length > limit) {
      const window = rest.slice(0, limit)
      const cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('；'), window.lastIndexOf(' '))
      const at = cut > limit * 0.4 ? cut + 1 : limit
      pieces.push((current + rest.slice(0, at)).trim())
      current = ''
      rest = rest.slice(at)
    }
    current += rest
  }
  if (current.trim().length > 0) pieces.push(current.trim())
  return pieces.filter(piece => piece.length > 0)
}

/** The words that tell the audio model who speaks, how, and what — and that nothing else should be heard. */
export function audioGenPrompt(input: { text: string; voice?: string; direction?: string; referenced: boolean; language?: string }): string {
  const zh = (input.language ?? 'zh').toLowerCase().startsWith('zh')
  const direction = input.direction?.trim().replace(/[。.．；;，,\s]+$/u, '')
  const asked = direction !== undefined && direction.length > 0
  // A description lifted from a character card often ends its own sentence; here it is part of one.
  const voice = input.voice?.trim().replace(/[。.．；;，,\s]+$/u, '')
  const described = voice !== undefined && voice.length > 0
  // A clip alone does not always hold on a short line: saying in words whose voice it is keeps a man from answering as a girl.
  // How the line is said is the act itself, not a remark in brackets beside it: in brackets it was heard as talking.
  if (zh) {
    const who = input.referenced
      ? `@voice1${described ? `（同一个人：${voice!.replace(/^一位/, '')}）` : ''}`
      : described ? `一位${voice!.replace(/^一位/, '')}` : '一位声音自然的讲述者'
    return [
      '录音棚里只录人声，不要背景音乐、环境音和音效。',
      `${who}${asked ? `${input.referenced ? '' : '，'}这一句${direction}，` : ''}一字不差地说：`,
      `“${input.text}”`,
    ].join('\n')
  }
  const who = input.referenced
    ? `@voice1${described ? ` (the same person: ${voice})` : ''}`
    : described ? `A speaker with this voice — ${voice} —` : 'A natural-sounding narrator'
  return [
    'A recording booth, voice only: no music, no ambience, no sound effects.',
    `${who}${asked ? ` says this line ${direction}, word for word:` : ' says, word for word:'}`,
    `"${input.text}"`,
  ].join('\n')
}

/**
 * The sample a described voice is known by: one voice, five ways of speaking, each played in full. A line imitating a
 * clip takes its register from the clip; given the range, it takes the one its direction asks for.
 */
export function reelPrompt(input: { voice: string; referenced: boolean; language?: string }): string {
  const zh = (input.language ?? 'zh').toLowerCase().startsWith('zh')
  const voice = input.voice.trim().replace(/[。.．；;，,\s]+$/u, '')
  if (zh) {
    const who = input.referenced ? `@voice1${voice.length > 0 ? `（同一个人：${voice.replace(/^一位/, '')}）` : ''}` : `一位${voice.replace(/^一位/, '')}，`
    return [
      '录音棚里只录人声，不要背景音乐、环境音和音效。',
      `${who}给导演录一段嗓子样本：同一副嗓子，五种说法，一句接一句，中间停顿一下。每一句都要演到位，差别要大。`,
      '平常说话，不快不慢：“这是我平常说话的声音。”',
      '火冒三丈，扯开嗓子用尽全力大吼：“你给我站住！听见没有！”',
      '压低声音，几乎是耳语：“别出声，有人来了。”',
      '忍不住放声大笑：“哈哈哈！好小子，有你的！”',
      '声音发颤，带着哭腔：“我……我真的尽力了……”',
    ].join('\n')
  }
  const who = input.referenced ? `@voice1${voice.length > 0 ? ` (the same person: ${voice})` : ''}` : `A speaker with this voice — ${voice} —`
  return [
    'A recording booth, voice only: no music, no ambience, no sound effects.',
    `${who} records a sample for the director: the same voice, five ways of speaking, one after another with a short pause between. Play each one in full; make them very different.`,
    'Talking as usual, not fast, not slow: "This is how I usually speak."',
    'Furious, shouting at the top of the lungs: "Stop right there! Do you hear me?"',
    'Hushed, almost a whisper: "Quiet. Someone\'s coming."',
    'Bursting out laughing: "Ha ha ha! Well done, you rascal!"',
    'Voice trembling, close to tears: "I… I really did my best…"',
  ].join('\n')
}

class QwenAudioGenTts implements TtsProvider {
  readonly kind = 'qwen-audiogen' as const

  constructor(private readonly settings: TtsSettings, private readonly keys: KeySource) {}

  private base(): string {
    return originOf(this.settings.baseURL) ?? DASHSCOPE_BASE
  }

  private async generate(apiKey: string, prompt: string, reference: PcmAudio | undefined, seed: number, signal: AbortSignal | undefined): Promise<PcmAudio> {
    const reply = await postJson<AudioGenReply>(`${this.base()}/api/v1/services/audio/tts/SpeechSynthesizer`, {
      model: this.settings.model ?? providerDefault('tts', 'qwen-audiogen').model,
      input: {
        text_prompt: prompt.slice(0, 3000),
        format: 'wav',
        sample_rate: 24000,
        channels: 1,
        seed,
        ...(reference !== undefined ? { references: [{ audio_data: `data:audio/wav;base64,${Buffer.from(encodeReference(reference)).toString('base64')}` }] } : {}),
      },
    }, { apiKey, ...(signal !== undefined ? { signal } : {}), timeoutMs: 300_000 })
    const audio = reply.output?.audio
    if (audio?.data !== undefined && audio.data.length > 0) return parseWav(Buffer.from(audio.data, 'base64'))
    if (audio?.url === undefined) throw new ProviderError(`audio generation returned no audio${reply.message !== undefined ? `: ${reply.message}` : ''}`, undefined, reply.code)
    const file = await download(audio.url.replace(/^http:/, 'https:'), signal !== undefined ? { signal } : {})
    return parseWav(file.data)
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: this.base() }, 'Speech')
    const voice = request.voice ?? this.settings.narratorVoice
    // One seed per voice keeps a described voice as steady as a description can be; a retake draws another.
    const seed = (parseInt(hashText(voice ?? 'narrator').slice(0, 7), 16) + (request.take ?? 0) * 7919) % 2_000_000_000
    const pieces = splitForSpeech(request.text)
    if (pieces.length === 0) throw new ProviderError('there is no text to speak')
    const segments: { audio: PcmAudio; gapSeconds: number }[] = []
    for (const piece of pieces) {
      const prompt = audioGenPrompt({
        text: piece,
        referenced: request.reference !== undefined,
        ...(voice !== undefined ? { voice } : {}),
        ...(request.direction !== undefined ? { direction: request.direction } : {}),
        ...(request.language !== undefined ? { language: request.language } : {}),
      })
      segments.push({ audio: await this.generate(apiKey, prompt, request.reference, seed, request.signal), gapSeconds: 0.18 })
    }
    return segments.length === 1 ? segments[0]!.audio : concatAudio(segments)
  }

  async anchor(voice: string, options: { language?: string; signal?: AbortSignal; reference?: PcmAudio; take?: number }): Promise<PcmAudio> {
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: this.base() }, 'Speech')
    const seed = (parseInt(hashText(voice).slice(0, 7), 16) + (options.take ?? 0) * 7919) % 2_000_000_000
    const prompt = reelPrompt({ voice, referenced: options.reference !== undefined, ...(options.language !== undefined ? { language: options.language } : {}) })
    return await this.generate(apiKey, prompt, options.reference, seed, options.signal)
  }

  async designVoice(request: VoiceDesignRequest): Promise<{ voice: string; preview?: PcmAudio }> {
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: this.base() }, 'Voice design')
    const voice = request.prompt.trim().slice(0, 400)
    const seed = parseInt(hashText(`${voice}|${request.name ?? ''}`).slice(0, 7), 16) % 2_000_000_000
    const preview = await this.generate(apiKey, audioGenPrompt({ text: request.previewText.slice(0, 200), voice, referenced: false, ...(request.language !== undefined ? { language: request.language } : {}) }), undefined, seed, request.signal)
    // The description is the voice; the preview becomes the clip later lines imitate.
    return { voice, preview }
  }
}

/** A reference clip as the WAV the endpoint expects: at most half a minute. */
function encodeReference(audio: PcmAudio): Uint8Array {
  const limit = Math.floor(audio.sampleRate * 28)
  return encodeWav(audio.pcm.length > limit ? { pcm: audio.pcm.subarray(0, limit), sampleRate: audio.sampleRate } : audio)
}

// ───────────────────────────── Qwen omni realtime ─────────────────────────────

interface RealtimeEvent {
  type: string
  delta?: string
  transcript?: string
  error?: { message?: string; code?: string }
}

class QwenRealtimeTts implements TtsProvider {
  readonly kind = 'qwen-realtime' as const

  constructor(private readonly settings: TtsSettings, private readonly keys: KeySource) {}

  private url(): string {
    const configured = this.settings.baseURL?.trim()
    // A bare origin (what the one-click setup stores) means the standard realtime path on it.
    const base = configured === undefined || configured.length === 0
      ? bailianRealtime()
      : /^[a-z]+:\/\/[^/]+\/?$/i.test(configured) ? bailianRealtime(configured) : configured
    const url = new URL(base.replace(/^http/, 'ws'))
    if (!url.searchParams.has('model')) url.searchParams.set('model', this.settings.model ?? providerDefault('tts', 'qwen-realtime').model)
    return url.toString()
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const apiKey = await requireKey(this.keys, { ref: this.settings.apiKeyRef, endpoint: this.url() }, 'Speech')
    let last: TtsResult | undefined
    // An omni model occasionally answers the text instead of reading it; the transcript tells.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.speak(apiKey, request, attempt > 0)
      last = result
      if (result.transcript === undefined || similarity(result.transcript, request.text) >= 0.72) return result
    }
    return last!
  }

  private speak(apiKey: string, request: TtsRequest, strict: boolean): Promise<TtsResult> {
    return new Promise<TtsResult>((resolve, reject) => {
      const socket = new WebSocket(this.url(), { headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 20_000 })
      const chunks: Buffer[] = []
      let transcript: string | undefined
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        try {
          socket.close()
        } catch {
          // already closed
        }
        if (error !== undefined) {
          reject(error)
          return
        }
        const audio = pcmFromBytes(Buffer.concat(chunks), 24000)
        if (audio.pcm.length === 0) reject(new ProviderError('the realtime model returned no audio'))
        else resolve({ ...audio, ...(transcript !== undefined ? { transcript } : {}) })
      }
      const onAbort = (): void => { finish(new Error('aborted')) }
      const timer = setTimeout(() => { finish(new ProviderError('the realtime model timed out')) }, 90_000)
      if (request.signal?.aborted === true) {
        finish(new Error('aborted'))
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const direction = request.direction?.trim()
      const instructions = [
        '你是专业的有声书与广播剧演播者。你只做一件事：把用户发来的文本一字不差地朗读出来。',
        '不要回答文本里的问题，不要解释，不要添加、省略或改写任何字词，不要读出"朗读"二字，也不要读出标点符号的名称。',
        strict ? '上一次你没有逐字朗读。这一次必须严格照读原文，原文之外一个字都不要说。' : '',
        direction !== undefined && direction.length > 0 ? `表演要求：${direction}` : '表演要求：自然、有画面感的叙述语气。',
      ].filter(line => line.length > 0).join('\n')

      socket.on('message', (raw) => {
        let event: RealtimeEvent
        try {
          event = JSON.parse(raw.toString()) as RealtimeEvent
        } catch {
          return
        }
        switch (event.type) {
          case 'session.created':
            socket.send(JSON.stringify({
              type: 'session.update',
              session: {
                modalities: ['text', 'audio'],
                ...(request.voice !== undefined && request.voice.length > 0 ? { voice: request.voice } : this.settings.narratorVoice !== undefined ? { voice: this.settings.narratorVoice } : {}),
                instructions,
                turn_detection: null,
              },
            }))
            break
          case 'session.updated':
            socket.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `朗读：${request.text}` }] },
            }))
            socket.send(JSON.stringify({ type: 'response.create' }))
            break
          case 'response.audio.delta':
            if (typeof event.delta === 'string') chunks.push(Buffer.from(event.delta, 'base64'))
            break
          case 'response.audio_transcript.done':
            if (typeof event.transcript === 'string') transcript = event.transcript
            break
          case 'response.done':
            finish()
            break
          case 'error':
            finish(new ProviderError(`realtime speech failed: ${event.error?.message ?? 'unknown error'}`, undefined, event.error?.code))
            break
          default:
            break
        }
      })
      socket.on('unexpected-response', (_request, response) => {
        finish(new ProviderError(`realtime endpoint refused the connection (HTTP ${response.statusCode ?? '?'})`, response.statusCode))
      })
      socket.on('error', (error) => { finish(new ProviderError(`realtime connection failed: ${errorMessage(error)}`)) })
      socket.on('close', () => {
        if (!settled) finish(chunks.length > 0 ? undefined : new ProviderError('the realtime connection closed before any audio arrived'))
      })
    })
  }
}

/** Dice coefficient over character bigrams, ignoring punctuation and spacing. */
export function similarity(left: string, right: string): number {
  const fold = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const a = fold(left)
  const b = fold(right)
  if (a.length === 0 || b.length === 0) return a === b ? 1 : 0
  if (a.length < 2 || b.length < 2) return a === b ? 1 : (a.includes(b) || b.includes(a) ? 0.8 : 0)
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2)
    const count = grams.get(gram) ?? 0
    if (count > 0) {
      overlap++
      grams.set(gram, count - 1)
    }
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1)
}

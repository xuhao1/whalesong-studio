// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Listening with ears. An omni model on Bailian hears each take beside the
 * voice's sample and says three things the arithmetic in `voiceprint.ts`
 * cannot: whether the words are the line's, whether it is still that voice,
 * and how far the delivery went toward what the director asked.
 *
 * Asked on its own whether a line is shouted, the model hears the words and
 * says yes: a curse read flat is still a curse. It is asked instead how far the
 * take moved from the person's ordinary voice — which opens their sample — and
 * told that the words do not count.
 */
import { providerDefault } from '../../shared/recommended'
import { compatibleBase, originOf, serviceOf } from '../../shared/services'
import type { TtsSettings } from '../../shared/types'
import { findKey, postJson, ProviderError, type KeySource } from './http'
import { encodeWav, type PcmAudio } from './wav'

export interface Hearing {
  /** What the listener found misread, left out or added; absent when the words are the line's. */
  misread?: string
  /** The take is not the voice of the sample it was heard beside. */
  stranger?: boolean
  /** How far the delivery went toward the direction, 1 (no further than talking) to 5 (all the way); absent when nothing was asked. */
  delivery?: number
  /** One sentence of what was heard. */
  note?: string
  /** Tokens the hearing took, for the ledger. */
  usage?: { input: number; output: number }
}

export interface HearingRequest {
  take: PcmAudio
  /** The voice's sample: how the person talks, then how they sound when moved. */
  sample?: PcmAudio
  text: string
  /** What the director asked of the line. */
  direction?: string
  language?: string
  signal?: AbortSignal
}

export interface Listener {
  readonly model: string
  /** Host of the endpoint it is reached at, for the ledger. */
  readonly via: string
  hear(request: HearingRequest): Promise<Hearing>
  /** Hear a voice's reel once, before every line of the voice imitates it. */
  hearReel?(request: ReelRequest): Promise<ReelHearing>
}

export interface ReelRequest {
  reel: PcmAudio
  /** The voice in words, when it has words. */
  voice?: string
  language?: string
  signal?: AbortSignal
}

/** What the listener said of a reel: it passes when it is one natural voice, the one described, with range. */
export interface ReelHearing {
  /** One voice throughout — a shout that pulled it thin or shrill is not it. */
  same: boolean
  /** The voice the words describe: sex, age, timbre. */
  fits: boolean
  /** How far apart its ways of speaking are, 1 to 5. */
  range?: number
  note?: string
  usage?: { input: number; output: number }
}

/** A reel the lines may imitate: one voice, the one described, with its ways of speaking well apart. */
export function reelPasses(heard: ReelHearing): boolean {
  return heard.same && heard.fits && (heard.range ?? 3) >= 3
}

/** Speech setups that are Bailian's own: their endpoint and key serve the listener too. */
const BAILIAN_SPEECH = new Set(['qwen-audiogen', 'dashscope', 'qwen-realtime'])

/**
 * The model that listens to takes: the one the settings name, else the one recommended beside the speech setup.
 * `none` switches listening off.
 */
export function listenModelOf(settings: TtsSettings): string | undefined {
  const named = settings.listenModel?.trim()
  if (named === 'none') return undefined
  if (named !== undefined && named.length > 0) return named
  const recommended = providerDefault('tts', settings.provider).listenModel
  return recommended !== undefined && recommended.length > 0 ? recommended : undefined
}

/** @returns the listener for the current speech settings, or undefined when listening is off. */
export function createListener(settings: TtsSettings, keys: KeySource): Listener | undefined {
  const model = listenModelOf(settings)
  if (model === undefined || settings.provider === 'none') return undefined
  const own = BAILIAN_SPEECH.has(settings.provider) && serviceOf(originOf(settings.baseURL) ?? 'https://dashscope.aliyuncs.com') === 'bailian'
  const base = compatibleBase('bailian', own ? originOf(settings.baseURL) : undefined)
  return new OmniListener(model, base, keys, own ? settings.apiKeyRef : undefined)
}

interface ChatReply {
  choices?: { message?: { content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** A clip as the endpoint takes it: a WAV in a data URL, at most a minute. */
function audioPart(audio: PcmAudio): { type: 'input_audio'; input_audio: { data: string; format: 'wav' } } {
  const limit = audio.sampleRate * 60
  const clip = audio.pcm.length > limit ? { pcm: audio.pcm.subarray(0, limit), sampleRate: audio.sampleRate } : audio
  return { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${Buffer.from(encodeWav(clip)).toString('base64')}`, format: 'wav' } }
}

/** The words that put the question; the clips go between them. */
export function hearingPrompt(request: Pick<HearingRequest, 'text' | 'direction' | 'language'> & { sampled: boolean }): { before?: string; between: string; after: string } {
  const zh = (request.language ?? 'zh').toLowerCase().startsWith('zh')
  const direction = request.direction?.trim()
  const asked = direction !== undefined && direction.length > 0
  if (zh) {
    const fields = [
      '"misread":"念错、漏掉、多念的字词，逐处写出；数字和符号的读法、同音字不算错；没有就写空字符串"',
      ...(request.sampled ? ['"voice":"same"或"different"（是不是录音一那副嗓子：性别、年龄感、音色；情绪和音量不同不算换人，但嗓子被拉尖、变细、像卡通或像换了个人算 different）'] : []),
      ...(asked ? ['"delivery":1到5（1 和平常说话几乎一样或方向不对，3 有变化但不够，5 完全到位）'] : []),
      '"note":"一句话：听到了什么"',
    ]
    return {
      ...(request.sampled ? { before: '录音一是这个配音演员的嗓子样本：先是平常说话，后面是几种不同的语气。' } : {}),
      between: `${request.sampled ? '录音二' : '这段录音'}是他念的一句台词。台词：“${request.text}”。${asked ? `导演要求：“${direction}”。` : ''}`,
      after: [
        `只凭声音判断${request.sampled ? '录音二' : '这段录音'}。`,
        ...(asked ? [`不要因为台词的字面意思就认为语气到位：平平地念一句骂人的话，仍然是平的。${request.sampled ? '和录音一开头"平常说话"相比，' : ''}音量、力度、音高、气息、语速变了多少，变的方向对不对？`] : []),
        `只回答一个 JSON：{${fields.join(',')}}`,
      ].join('\n'),
    }
  }
  const fields = [
    '"misread":"each word misread, left out or added; how numbers and symbols are read does not count; an empty string if none"',
    ...(request.sampled ? ['"voice":"same" or "different" (is it the voice of recording 1: sex, age, timbre — another mood or volume is not another person, but a voice pulled up thin, shrill or cartoonish, or like someone else\'s, is different)'] : []),
    ...(asked ? ['"delivery":1 to 5 (1 hardly different from talking or the wrong way, 3 changed but not enough, 5 all the way)'] : []),
    '"note":"one sentence: what you heard"',
  ]
  return {
    ...(request.sampled ? { before: 'Recording 1 is a sample of this voice actor: first talking as usual, then a few other ways of speaking.' } : {}),
    between: `${request.sampled ? 'Recording 2' : 'This recording'} is a line they read. The line: "${request.text}".${asked ? ` The director asked for: "${direction}".` : ''}`,
    after: [
      `Judge ${request.sampled ? 'recording 2' : 'the recording'} by its sound alone.`,
      ...(asked ? [`Do not take the delivery as given because of what the words say: a curse read flat is still flat. ${request.sampled ? 'Against the ordinary talking at the start of recording 1, ' : ''}how much did loudness, force, pitch, breath and pace change, and in the right direction?`] : []),
      `Answer with one JSON object only: {${fields.join(',')}}`,
    ].join('\n'),
  }
}

/** The question put of a reel. */
export function reelHearingPrompt(request: Pick<ReelRequest, 'voice' | 'language'>): string {
  const zh = (request.language ?? 'zh').toLowerCase().startsWith('zh')
  const voice = request.voice?.trim()
  if (zh) {
    return [
      `这是一个配音演员给导演录的嗓子样带：同一副嗓子五种说法——平常说话、大吼、耳语、大笑、带哭腔。${voice !== undefined && voice.length > 0 ? `声音描述：“${voice}”。` : ''}`,
      '只凭声音判断，只回答一个 JSON：{"same":true或false（五句是不是同一个人的嗓子；吼的那句嗓子被拉尖、变细、像卡通或像换了个人，就是 false）,'
        + `"fits":true或false（${voice !== undefined && voice.length > 0 ? '嗓子和声音描述对不对得上：性别、年龄感、音色' : '嗓子是不是一个真人自然的声音'}）,"range":1到5（五种说法差别有多大）,"note":"一句话：听到了什么"}`,
    ].join('\n')
  }
  return [
    `This is a voice actor's reel for the director: the same voice five ways — talking as usual, shouting, whispering, laughing, near tears.${voice !== undefined && voice.length > 0 ? ` The voice as described: "${voice}".` : ''}`,
    'Judge by the sound alone and answer with one JSON object only: {"same":true or false (is it one person\'s voice throughout; a shout that pulled the voice thin, shrill or cartoonish, or like someone else\'s, is false),'
      + `"fits":true or false (${voice !== undefined && voice.length > 0 ? 'does the voice match the description: sex, age, timbre' : 'is it a natural human voice'}),"range":1 to 5 (how far apart the five ways are),"note":"one sentence: what you heard"}`,
  ].join('\n')
}

/** What the model answered of a reel. */
export function readReelHearing(text: string): ReelHearing {
  const found = /\{[\s\S]*\}/.exec(text)
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = found !== null ? JSON.parse(found[0]) as Record<string, unknown> : undefined
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) throw new ProviderError(`the listener did not answer in JSON: ${text.slice(0, 200)}`)
  const range = typeof parsed.range === 'number' ? parsed.range : Number(parsed.range)
  const note = typeof parsed.note === 'string' ? parsed.note.trim() : ''
  return {
    same: parsed.same !== false && parsed.same !== 'false',
    fits: parsed.fits !== false && parsed.fits !== 'false',
    ...(Number.isFinite(range) ? { range: Math.max(1, Math.min(5, Math.round(range))) } : {}),
    ...(note.length > 0 ? { note } : {}),
  }
}

/** What the model answered, as a hearing; anything it did not say is left out. */
export function readHearing(text: string, asked: boolean): Hearing {
  const found = /\{[\s\S]*\}/.exec(text)
  if (found === null) throw new ProviderError(`the listener did not answer in JSON: ${text.slice(0, 200)}`)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(found[0]) as Record<string, unknown>
  } catch {
    throw new ProviderError(`the listener did not answer in JSON: ${text.slice(0, 200)}`)
  }
  const misread = typeof parsed.misread === 'string' ? parsed.misread.trim() : ''
  const delivery = typeof parsed.delivery === 'number' ? parsed.delivery : typeof parsed.delivery === 'string' ? Number(parsed.delivery) : NaN
  const note = typeof parsed.note === 'string' ? parsed.note.trim() : ''
  // "None", "无", "没有" are the model's way of leaving the field empty.
  const none = /^(无|没有|none|n\/a|-|—)?[。.]?$/i.test(misread)
  return {
    ...(!none ? { misread } : {}),
    ...(parsed.voice === 'different' ? { stranger: true } : {}),
    ...(asked && Number.isFinite(delivery) ? { delivery: Math.max(1, Math.min(5, Math.round(delivery))) } : {}),
    ...(note.length > 0 ? { note } : {}),
  }
}

/** Listens through an OpenAI-compatible chat endpoint that takes audio (Bailian's `compatible-mode`). */
export class OmniListener implements Listener {
  readonly via: string

  constructor(readonly model: string, private readonly base: string, private readonly keys: KeySource, private readonly ref: string | undefined) {
    this.via = new URL(base).host
  }

  private async key(): Promise<string> {
    const key = await findKey(this.keys, { ...(this.ref !== undefined ? { ref: this.ref } : {}), endpoint: this.base }, 'Listening')
    if (key === undefined) throw new ProviderError(`Listening: no Bailian key is saved for ${new URL(this.base).host}`, undefined, 'NO_CREDENTIAL')
    return key
  }

  /** Put the question, and read the answer; now and then the model answers with something that is not the object asked for, and is asked once more. */
  private async ask<T>(content: unknown[], read: (text: string) => T, signal: AbortSignal | undefined): Promise<T & { usage: { input: number; output: number } }> {
    const key = await this.key()
    const spent = { input: 0, output: 0 }
    for (let attempt = 0; ; attempt++) {
      const reply = await postJson<ChatReply>(`${this.base}/chat/completions`, {
        model: this.model,
        messages: [{ role: 'user', content }],
        modalities: ['text'],
      }, { apiKey: key, ...(signal !== undefined ? { signal } : {}), timeoutMs: 120_000 })
      spent.input += reply.usage?.prompt_tokens ?? 0
      spent.output += reply.usage?.completion_tokens ?? 0
      try {
        return { ...read(reply.choices?.[0]?.message?.content ?? ''), usage: spent }
      } catch (error) {
        if (attempt > 0 || signal?.aborted === true) throw error
      }
    }
  }

  async hearReel(request: ReelRequest): Promise<ReelHearing> {
    return await this.ask([audioPart(request.reel), { type: 'text', text: reelHearingPrompt(request) }], readReelHearing, request.signal)
  }

  async hear(request: HearingRequest): Promise<Hearing> {
    const sampled = request.sample !== undefined
    const asked = request.direction !== undefined && request.direction.trim().length > 0
    const words = hearingPrompt({ text: request.text, ...(request.direction !== undefined ? { direction: request.direction } : {}), ...(request.language !== undefined ? { language: request.language } : {}), sampled })
    const content = [
      ...(sampled ? [{ type: 'text', text: words.before! }, audioPart(request.sample!)] : []),
      { type: 'text', text: words.between },
      audioPart(request.take),
      { type: 'text', text: words.after },
    ]
    return await this.ask(content, text => readHearing(text, asked), request.signal)
  }
}

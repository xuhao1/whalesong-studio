// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Sound that is not speech: a spot effect, a piece of music, a generated bed.
 *
 * One kind of service is known to make all three from a description in words:
 * Bailian audio generation — the same model the Studio speaks with when speech
 * is set up there. So by default sound simply follows the speech setup and
 * needs no key or model of its own; it can also be given its own endpoint, or
 * switched off, in which case cues stay what they always are as well: captions
 * the reader can see, and beds the browser synthesizes.
 */
import { providerDefault } from '../../shared/recommended'
import { originOf } from '../../shared/services'
import type { NovelSettings, SoundKind } from '../../shared/types'
import { download, postJson, ProviderError, requireKey, type KeySource } from './http'
import { parseWav, type PcmAudio } from './wav'

export interface SoundRequest {
  kind: SoundKind
  /** The sound in words. */
  prompt: string
  seconds: number
  /** Language of the prompt (`zh`, `en`, …), which the wrapping words follow. */
  language?: string
  /** Which try this is; a later one asks for a different draw. */
  take?: number
  signal?: AbortSignal
}

export interface SoundProvider {
  readonly kind: 'qwen-audiogen'
  readonly model: string
  generate(request: SoundRequest): Promise<PcmAudio>
}

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com'

export interface SoundSetup {
  model: string
  baseURL?: string
  apiKeyRef?: string
  /** The speech setup is being used, rather than an endpoint named for sound. */
  shared: boolean
}

/** Where sound comes from under these settings, or undefined when nothing can make it. */
export function soundSetup(settings: NovelSettings): SoundSetup | undefined {
  const sound = settings.sound
  const provider = sound?.provider ?? 'auto'
  if (provider === 'none') return undefined
  if (provider === 'qwen-audiogen') {
    return {
      model: sound?.model ?? providerDefault('sound', 'qwen-audiogen').model,
      shared: false,
      ...(sound?.baseURL !== undefined ? { baseURL: sound.baseURL } : {}),
      ...(sound?.apiKeyRef !== undefined ? { apiKeyRef: sound.apiKeyRef } : {}),
    }
  }
  // auto: a speech model that generates audio from a description makes sound the same way.
  if (settings.tts.provider !== 'qwen-audiogen') return undefined
  return {
    model: sound?.model ?? settings.tts.model ?? providerDefault('sound', 'qwen-audiogen').model,
    shared: true,
    ...(settings.tts.baseURL !== undefined ? { baseURL: settings.tts.baseURL } : {}),
    ...(settings.tts.apiKeyRef !== undefined ? { apiKeyRef: settings.tts.apiKeyRef } : {}),
  }
}

/** The words that ask for a sound and for nothing else — above all, for nobody speaking. */
export function soundPrompt(input: Pick<SoundRequest, 'kind' | 'prompt' | 'seconds' | 'language'>): string {
  const zh = (input.language ?? 'zh').toLowerCase().startsWith('zh')
  const what = input.prompt.trim().replace(/[。.．\s]+$/u, '')
  const seconds = Math.round(input.seconds)
  if (zh) {
    if (input.kind === 'effect') return `一个音效，没有任何人声、旁白和音乐：${what}。只有这个声音，前后安静。约${seconds}秒。`
    if (input.kind === 'music') return `一段纯器乐背景音乐，没有人声、没有歌词、没有旁白：${what}。约${seconds}秒，音量平稳，首尾衔接自然，可以循环播放。`
    return `环境底噪，平稳、持续、音量均匀：${what}。没有任何人说话，没有音乐，没有突然的响声。时长${seconds}秒，可以循环播放。`
  }
  if (input.kind === 'effect') return `A single sound effect, with no voice, no narration and no music: ${what}. Only this sound, silence around it. About ${seconds} seconds.`
  if (input.kind === 'music') return `Instrumental background music, no singing, no lyrics, no narration: ${what}. About ${seconds} seconds, even in level, ending the way it began so it can loop.`
  return `A steady, even ambience bed: ${what}. Nobody speaks, no music, no sudden sounds. ${seconds} seconds, loopable.`
}

interface AudioGenReply {
  output?: { audio?: { url?: string; data?: string } }
  message?: string
  code?: string
}

class QwenAudioGenSound implements SoundProvider {
  readonly kind = 'qwen-audiogen' as const
  readonly model: string

  constructor(private readonly setup: SoundSetup, private readonly keys: KeySource) {
    this.model = setup.model
  }

  private base(): string {
    return originOf(this.setup.baseURL) ?? DASHSCOPE_BASE
  }

  async generate(request: SoundRequest): Promise<PcmAudio> {
    const apiKey = await requireKey(this.keys, { ref: this.setup.apiKeyRef, endpoint: this.base() }, 'Sound')
    if (request.prompt.trim().length === 0) throw new ProviderError('there is no description of the sound to make')
    const reply = await postJson<AudioGenReply>(`${this.base()}/api/v1/services/audio/tts/SpeechSynthesizer`, {
      model: this.model,
      input: {
        text_prompt: soundPrompt(request).slice(0, 3000),
        format: 'wav',
        sample_rate: 24000,
        channels: 1,
        seed: (1009 + (request.take ?? 0) * 7919) % 2_000_000_000,
      },
    }, { apiKey, ...(request.signal !== undefined ? { signal: request.signal } : {}), timeoutMs: 300_000 })
    const audio = reply.output?.audio
    if (audio?.data !== undefined && audio.data.length > 0) return parseWav(Buffer.from(audio.data, 'base64'))
    if (audio?.url === undefined) throw new ProviderError(`sound generation returned no audio${reply.message !== undefined ? `: ${reply.message}` : ''}`, undefined, reply.code)
    const file = await download(audio.url.replace(/^http:/, 'https:'), request.signal !== undefined ? { signal: request.signal } : {})
    return parseWav(file.data)
  }
}

export function createSoundProvider(settings: NovelSettings, keys: KeySource): SoundProvider | undefined {
  const setup = soundSetup(settings)
  return setup !== undefined ? new QwenAudioGenSound(setup, keys) : undefined
}

/** Root-mean-square level of a clip in dBFS. */
export function levelOf(audio: PcmAudio): number {
  if (audio.pcm.length === 0) return -120
  let sum = 0
  for (const sample of audio.pcm) sum += sample * sample
  return 20 * Math.log10(Math.max(1e-6, Math.sqrt(sum / audio.pcm.length) / 32768))
}

/**
 * Bring a clip to a level and ease its ends in and out, so a bed neither jumps
 * out from under the voice nor clicks where it loops.
 */
export function finished(audio: PcmAudio, options: { level: number; fadeSeconds: number }): PcmAudio {
  const level = levelOf(audio)
  // Near-silence stays what it is; raising it only raises the noise floor.
  const gain = level < -70 ? 1 : Math.min(8, 10 ** ((options.level - level) / 20))
  const fade = Math.min(Math.floor(options.fadeSeconds * audio.sampleRate), Math.floor(audio.pcm.length / 2))
  const pcm = new Int16Array(audio.pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const edge = fade > 0 ? Math.min(1, i / fade, (pcm.length - 1 - i) / fade) : 1
    const value = (audio.pcm[i]! / 32768) * gain * edge
    // Peaks are rounded off rather than clipped.
    pcm[i] = Math.round(Math.tanh(value / 0.9) * 0.9 * 32767)
  }
  return { pcm, sampleRate: audio.sampleRate }
}

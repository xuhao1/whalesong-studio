// SPDX-License-Identifier: LGPL-3.0-or-later
/** Sound that is not speech: where it comes from, what the model is asked for, and what a chapter's cues become. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { finished, levelOf, soundPrompt, soundSetup, type SoundProvider, type SoundRequest } from '../src/core/media/sound'
import { parseWav, type PcmAudio } from '../src/core/media/wav'
import { addCue, renderSound, SOUND_SECONDS, updateCue } from '../src/core/pipelines/sound'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import type { NovelSettings } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

const RATE = 24000

/** Noise at a level: a sound that is not a voice. */
function noise(seconds: number, amplitude: number): PcmAudio {
  const pcm = new Int16Array(Math.floor(RATE * seconds))
  let seed = 7
  for (let i = 0; i < pcm.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pcm[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amplitude * 32767)
  }
  return { pcm, sampleRate: RATE }
}

class FakeSound implements SoundProvider {
  readonly kind = 'qwen-audiogen' as const
  readonly model = 'sound-test'
  readonly requests: SoundRequest[] = []
  constructor(private readonly fail?: (request: SoundRequest) => boolean) {}
  async generate(request: SoundRequest): Promise<PcmAudio> {
    this.requests.push(request)
    if (this.fail?.(request) === true) throw new Error('the model was busy')
    return noise(request.seconds, request.kind === 'effect' ? 0.02 : 0.5)
  }
}

describe('where sound comes from', () => {
  const settings = (patch: Partial<NovelSettings>): NovelSettings => ({ ...DEFAULT_SETTINGS, ...patch })

  it('follows the speech setup when that can make sound, and is nothing otherwise', () => {
    expect(soundSetup(settings({}))).toBeUndefined()
    expect(soundSetup(settings({ tts: { provider: 'openai', model: 'gpt-4o-mini-tts' } }))).toBeUndefined()
    expect(soundSetup(settings({ tts: { provider: 'qwen-audiogen', model: 'qwen-audio-3.1-tts-next', baseURL: 'https://example.cn-beijing.maas.aliyuncs.com' } }))).toEqual({ model: 'qwen-audio-3.1-tts-next', shared: true, baseURL: 'https://example.cn-beijing.maas.aliyuncs.com' })
    // An endpoint of its own, whatever speech uses; and off means off.
    expect(soundSetup(settings({ tts: { provider: 'openai' }, sound: { provider: 'qwen-audiogen', model: 'next-sound' } }))).toEqual({ model: 'next-sound', shared: false })
    expect(soundSetup(settings({ tts: { provider: 'qwen-audiogen' }, sound: { provider: 'none' } }))).toBeUndefined()
  })

  it('asks for the sound and for nobody speaking', () => {
    const effect = soundPrompt({ kind: 'effect', prompt: '小银槌轻碰骨木，一声极短极干的"嗒"。', seconds: 3, language: 'zh' })
    expect(effect).toContain('没有任何人声')
    expect(effect).toContain('小银槌轻碰骨木，一声极短极干的"嗒"')
    expect(effect).toContain('约3秒')
    expect(soundPrompt({ kind: 'music', prompt: '低沉的弦乐长音', seconds: 24, language: 'zh' })).toContain('纯器乐')
    expect(soundPrompt({ kind: 'bed', prompt: '夜晚的海港', seconds: 18, language: 'zh' })).toContain('可以循环播放')
    expect(soundPrompt({ kind: 'bed', prompt: 'a harbour at night', seconds: 18, language: 'en' })).toContain('Nobody speaks')
  })

  it('brings a clip to its level and eases its ends', () => {
    const loud = noise(2, 0.6)
    const bed = finished(loud, { level: -34, fadeSeconds: 0.5 })
    expect(Math.abs(levelOf({ pcm: bed.pcm.subarray(RATE * 0.7, RATE * 1.3), sampleRate: RATE }) - -34)).toBeLessThan(1.5)
    expect(Math.abs(bed.pcm[0]!)).toBeLessThan(40)
    expect(Math.abs(bed.pcm.at(-1)!)).toBeLessThan(40)
    expect(bed.pcm.length).toBe(loud.pcm.length)
  })
})

describe('the sound of a chapter', () => {
  let bed: TestBed
  let chapter: string
  beforeEach(async () => {
    bed = await createTestBed({ settings: { tts: { provider: 'qwen-audiogen', model: 'qwen-audio-3.1-tts-next' } } })
    const { project } = bed.runtime
    chapter = (await project.addChapter({ title: '拍卖厅' })).id
    await project.saveChapterText(chapter, '正文。', { snapshot: false })
    await project.saveAudioScript({
      schema: 1,
      shape: 2,
      chapterId: chapter,
      textHash: 'h',
      updatedAt: new Date().toISOString(),
      lines: [{ id: 'l0', kind: 'narration', text: '拍卖厅里很静。' }, { id: 'l1', kind: 'dialogue', text: '零七。', speakerName: '拍卖师' }],
      cues: [
        { id: 'c0', at: 'l0', kind: 'bed', ambience: 'crowd', caption: '骨壁大厅里干净的回声', prompt: '空旷骨质大厅的底噪，偶尔纸页翻动' },
        { id: 'c1', at: 'l1', kind: 'effect', ambience: 'none', caption: '嗒——银槌轻碰骨木' },
        { id: 'c2', at: 'l0', kind: 'music', ambience: 'none', caption: '低沉的弦乐长音', prompt: '低沉的弦乐长音，克制，纯器乐' },
        // An older cue: a preset and nothing said of it.
        { at: 'l1', ambience: 'tension' },
      ],
    })
  })
  afterEach(async () => { await bed.cleanup() })

  it('makes a clip for every cue the book generates, and only once', async () => {
    const { project } = bed.runtime
    const sound = new FakeSound()
    bed.core.soundProvider = async () => sound
    const first = await renderSound(bed.core, bed.runtime, { chapter }, { origin: 'user' })
    expect(first).toMatchObject({ rendered: 4, kept: 0, skipped: 0, failed: [], model: 'sound-test' })
    // Each was asked for by what it is: the cue's own words, its caption, or the name of its bed.
    expect(sound.requests.map(request => [request.kind, request.prompt, request.seconds]).sort()).toEqual([
      ['bed', '悬疑紧张的低频氛围', SOUND_SECONDS.bed],
      ['bed', '空旷骨质大厅的底噪，偶尔纸页翻动', SOUND_SECONDS.bed],
      ['effect', '嗒——银槌轻碰骨木', SOUND_SECONDS.effect],
      ['music', '低沉的弦乐长音，克制，纯器乐', SOUND_SECONDS.music],
    ].sort())
    const script = (await project.audioScript(chapter))!
    // The cue without an id got one on the way.
    expect(script.cues.map(cue => cue.id)).toEqual(['c0', 'c1', 'c2', 'c3'])
    for (const cue of script.cues) {
      expect(cue.audio, cue.id).toMatch(/^assets\/audio\/.*cue-c\d-[0-9a-f]{8}\.wav$/)
      expect(cue.duration).toBeGreaterThan(0)
      const clip = parseWav(await project.readFile(cue.audio!))
      // Every kind sits under a voice at -20 dBFS: a bed far under it, an effect closer.
      const level = levelOf(clip)
      if ((cue.kind ?? 'bed') === 'effect') expect(level).toBeGreaterThan(-40)
      else expect(level).toBeLessThan(-28)
    }
    // Nothing changed: nothing is made again.
    sound.requests.length = 0
    expect(await renderSound(bed.core, bed.runtime, { chapter }, { origin: 'user' })).toMatchObject({ rendered: 0, kept: 4 })
    expect(sound.requests).toHaveLength(0)
    // A reworded cue is the one clip made anew; the others are kept.
    await updateCue(bed.runtime, { chapter, cue: 'c1', patch: { prompt: '小木槌敲在骨质台面上，干而短' } })
    expect(await renderSound(bed.core, bed.runtime, { chapter }, { origin: 'user' })).toMatchObject({ rendered: 1, kept: 3 })
    expect(sound.requests.map(request => request.prompt)).toEqual(['小木槌敲在骨质台面上，干而短'])
  })

  it('keeps to the browser\'s beds when the author says so, and reports a cue it could not make', async () => {
    await bed.core.settings.update({ sound: { beds: 'browser' } })
    const sound = new FakeSound(request => request.kind === 'music')
    bed.core.soundProvider = async () => sound
    const result = await renderSound(bed.core, bed.runtime, { chapter }, { origin: 'user' })
    expect(result.rendered).toBe(1)
    expect(result.failed).toEqual([{ cue: 'c2', error: 'the model was busy' }])
    expect(sound.requests.map(request => request.kind).sort()).toEqual(['effect', 'music'])
    const script = (await bed.runtime.project.audioScript(chapter))!
    expect(script.cues.find(cue => cue.id === 'c2')).toMatchObject({ error: 'the model was busy' })
    expect(script.cues.find(cue => cue.id === 'c0')!.audio).toBeUndefined()
    // Asked for by name, a bed is made all the same.
    sound.requests.length = 0
    await renderSound(bed.core, bed.runtime, { chapter, cues: ['c0'] }, { origin: 'user' })
    expect(sound.requests.map(request => request.kind)).toEqual(['bed'])
  })

  it('says so when nothing can make sound, and lets cues be placed by hand', async () => {
    await bed.core.settings.update({ sound: { provider: 'none' } })
    await expect(renderSound(bed.core, bed.runtime, { chapter }, { origin: 'user' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    const added = await addCue(bed.runtime, { chapter, at: 'l0', kind: 'effect', caption: '门开了一条缝' })
    expect(added.cue).toMatchObject({ id: 'c4', kind: 'effect', at: 'l0', ambience: 'none' })
    // Kept in the order they are heard.
    expect(added.script.cues.map(cue => cue.at)).toEqual(['l0', 'l0', 'l0', 'l1', 'l1'])
    await expect(addCue(bed.runtime, { chapter, at: 'l0', kind: 'music' })).rejects.toMatchObject({ code: 'novel/invalid' })
    await expect(addCue(bed.runtime, { chapter, at: 'l9', kind: 'effect', caption: 'x' })).rejects.toMatchObject({ code: 'novel/not-found' })
    const removed = await updateCue(bed.runtime, { chapter, cue: 'c4', remove: true })
    expect(removed.cues).toHaveLength(4)
  })
})

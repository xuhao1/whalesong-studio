// SPDX-License-Identifier: LGPL-3.0-or-later
/** Audio drama: the script that is directed, the voices that are cast, and the takes that are listened to. */
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { completeJson, LlmCallError } from '../src/core/llm'
import type { TtsProvider, TtsRequest, TtsResult } from '../src/core/media/tts'
import { judge, leveled, measure, soundSpans, speechUnits, TARGET_LEVEL } from '../src/core/media/voiceprint'
import { encodeWav, parseWav, type PcmAudio } from '../src/core/media/wav'
import { audition, buildAudioScript, fallbackLines, openCast, previewVoices, speakChecked, synthesizeChapter, tidyLines, voiceFor } from '../src/core/pipelines/audio'
import type { CharacterCard, TtsSettings } from '../src/shared/types'
import { createTestBed, FakeLlm, type TestBed } from './support/harness'

const RATE = 24000

/** A buzzing tone with overtones, the nearest thing to a voice that arithmetic makes. */
function voice(pitch: number, seconds: number, amplitude = 0.2): PcmAudio {
  const pcm = new Int16Array(Math.floor(RATE * seconds))
  for (let i = 0; i < pcm.length; i++) {
    const time = i / RATE
    let value = 0
    for (let harmonic = 1; harmonic <= 6; harmonic++) value += Math.sin(2 * Math.PI * pitch * harmonic * time) / harmonic
    pcm[i] = Math.round(value * amplitude * 32767 / 1.6)
  }
  return { pcm, sampleRate: RATE }
}

function silence(seconds: number): PcmAudio {
  return { pcm: new Int16Array(Math.floor(RATE * seconds)), sampleRate: RATE }
}

function join(...parts: PcmAudio[]): PcmAudio {
  const pcm = new Int16Array(parts.reduce((sum, part) => sum + part.pcm.length, 0))
  let offset = 0
  for (const part of parts) {
    pcm.set(part.pcm, offset)
    offset += part.pcm.length
  }
  return { pcm, sampleRate: RATE }
}

/** A speech provider that says each line as a tone: as long as the line, at the pitch the test picks. */
class FakeSpeech implements TtsProvider {
  readonly kind = 'openai' as const
  readonly requests: TtsRequest[] = []
  constructor(private readonly render: (request: TtsRequest) => PcmAudio) {}
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    this.requests.push(request)
    return this.render(request)
  }
}

const natural = (text: string): number => Math.max(0.4, speechUnits(text) * 0.21)

describe('listening without ears', () => {
  it('reads the pitch and level of a clip', () => {
    for (const pitch of [95, 120, 210, 300]) {
      const measured = measure(voice(pitch, 1.5))
      expect(measured.pitch).toBeDefined()
      expect(Math.abs(measured.pitch! / pitch - 1)).toBeLessThan(0.04)
      expect(measured.speech).toBeGreaterThan(1.3)
    }
    // A syllable says more about its tone than about the speaker: too short to read a pitch from.
    expect(measure(voice(120, 0.15)).pitch).toBeUndefined()
    expect(measure(silence(1)).level).toBeLessThan(-80)
  })

  it('brings loud and quiet lines to one level without clipping', () => {
    for (const amplitude of [0.03, 0.1, 0.6]) {
      const even = leveled(voice(140, 1, amplitude))
      const after = measure(even)
      expect(Math.abs(after.level - TARGET_LEVEL)).toBeLessThan(1)
      expect(after.peak).toBeLessThan(-0.5)
    }
    // Silence is not speech to be raised.
    const quiet = silence(1)
    expect(leveled(quiet)).toBe(quiet)
  })

  it('tells a cut, a silent and a stray take from a good one', () => {
    const line = '台下翻动纸页。很轻的沙沙声，像潮水退下去之后留在滩上的尾音。'
    expect(judge(measure(voice(120, natural(line))), line, 120).issues).toEqual([])
    expect(judge(measure(voice(120, 1.2)), line, 120).issues).toEqual(['short'])
    expect(judge(measure(silence(2)), line, 120).issues).toEqual(['silent'])
    expect(judge(measure(voice(215, natural(line))), line, 120).issues).toEqual(['drift'])
    expect(judge(measure(voice(80, natural(line))), line, 120).issues).toEqual(['drift'])
    // An actor may raise the voice; that is not another voice.
    expect(judge(measure(voice(150, natural(line))), line, 120).issues).toEqual([])
    // Without a known pitch there is nothing to drift from, and a word or two is never "cut short".
    expect(judge(measure(voice(215, natural(line))), line).issues).toEqual([])
    expect(judge(measure(voice(120, 0.4)), '在。', 120).issues).toEqual([])
  })

  it('finds the stretches of sound between pauses', () => {
    const spans = soundSpans(join(silence(0.2), voice(120, 0.8), silence(1), voice(120, 0.4), silence(0.3)))
    expect(spans).toHaveLength(2)
    expect(spans[0]!.start).toBeCloseTo(0.2, 1)
    expect(spans[1]!.end - spans[1]!.start).toBeCloseTo(0.4, 1)
  })

  it('speaks a line again when the take is not the voice, and keeps the best', async () => {
    const line = '他把那封信折了三折，放回抽屉最里面。'
    const pitches = [230, 124]
    const speech = new FakeSpeech(request => voice(pitches[request.take ?? 0] ?? 124, natural(request.text), 0.05))
    const retakes: number[] = []
    const take = await speakChecked(speech, { text: line }, { print: 120, retakes: 2, onRetake: (number) => { retakes.push(number) } })
    expect(take.takes).toBe(2)
    expect(retakes).toEqual([1])
    expect(take.verdict.issues).toEqual([])
    expect(Math.abs(measure(take.audio).level - TARGET_LEVEL)).toBeLessThan(1)
    // Every take strays: the closest is kept and says what is wrong with it.
    const stray = new FakeSpeech(request => voice([260, 190, 300][request.take ?? 0]!, natural(request.text)))
    const kept = await speakChecked(stray, { text: line }, { print: 120, retakes: 2 })
    expect(kept.takes).toBe(3)
    expect(kept.verdict.issues).toEqual(['drift'])
    expect(Math.round(kept.measured.pitch!)).toBeGreaterThan(180)
    expect(Math.round(kept.measured.pitch!)).toBeLessThan(200)
    // A retake that fails outright does not cost the line the take it has.
    let calls = 0
    const flaky = new FakeSpeech((request) => {
      calls += 1
      if (calls > 1) throw new Error('rate limited')
      return voice(240, natural(request.text))
    })
    expect((await speakChecked(flaky, { text: line }, { print: 120, retakes: 2 })).takes).toBe(1)
  })
})

describe('the script', () => {
  it('keeps a quoted word inside the narration it belongs to', () => {
    expect(fallbackLines('她用“我”。白页注意到这一点——手册上写她应该用“我们”。')).toEqual([
      { kind: 'narration', text: '她用“我”。白页注意到这一点——手册上写她应该用“我们”。' },
    ])
    expect(fallbackLines('槌头敲在骨木上，“嗒”的一声。')).toEqual([{ kind: 'narration', text: '槌头敲在骨木上，“嗒”的一声。' }])
    // Introduced as speech, or alone in its paragraph, a short quote is still someone talking.
    expect(fallbackLines('拍卖师说：“好”\n“在。”')).toEqual([
      { kind: 'narration', text: '拍卖师说：' },
      { kind: 'dialogue', text: '好' },
      { kind: 'dialogue', text: '在。' },
    ])
  })

  it('folds narration too short to stand alone into the narration beside it', () => {
    const { lines, map } = tidyLines([
      { kind: 'narration', text: '白页没有回答。她低头看自己的手，翻过来，掌心朝上，又翻回去。' },
      { kind: 'narration', text: '门开了。她走出去。' },
      { kind: 'dialogue', text: '零七。', speakerName: '拍卖师' },
      { kind: 'narration', text: '他顿了一下，' },
      { kind: 'dialogue', text: '上个月那个背多了两行。', speakerName: '拍卖师' },
      { kind: 'narration', text: '她开口。' },
      { kind: 'narration', text: '那段记忆不是她的。这一点写在拍卖手册第二页，她背过。' },
    ])
    expect(lines.map(line => line.text)).toEqual([
      '白页没有回答。她低头看自己的手，翻过来，掌心朝上，又翻回去。门开了。她走出去。',
      '零七。',
      '他顿了一下，',
      '上个月那个背多了两行。',
      '她开口。那段记忆不是她的。这一点写在拍卖手册第二页，她背过。',
    ])
    expect(map).toEqual([0, 0, 1, 2, 3, 4, 4])
    // English fragments are joined with a space.
    expect(tidyLines([{ kind: 'narration', text: 'She stopped.' }, { kind: 'narration', text: 'The hall was narrower than she had pictured, but taller.' }]).lines[0]!.text).toBe('She stopped. The hall was narrower than she had pictured, but taller.')
  })

  it('refuses a reply cut off at the output limit instead of repairing it', async () => {
    const llm = new FakeLlm(() => ({ text: '{"panels": [{"from": 0, "to": 3, "prompt": "a"}, {"from": 4', finish: 'max-tokens' }))
    const failure = await completeJson(llm, { route: { provider: 'fake', model: 'm', maxTokens: 8000 }, prompt: 'x' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmCallError)
    expect((failure as LlmCallError).code).toBe('TRUNCATED')
    expect((failure as LlmCallError).message).toContain('8000')
    // Asking again under the same limit would only be cut off again.
    expect(llm.requests).toHaveLength(1)
  })
})

describe('audio drama', () => {
  let bed: TestBed
  const TEXT = '更衣间的门开了一条缝。拍卖师探进半个头，胸口的银槌挂坠轻轻晃了一下。\n“零七。”\n“在。”\n“上台背第三节。从头开始，背到你自己停。”他顿了一下，“上个月那个背多了两行，压了底价。”\n白页没有回答。她低头看自己的手，翻过来，掌心朝上，又翻回去。'
  const SCRIPT = {
    lines: [
      { kind: 'narration', text: '更衣间的门开了一条缝。拍卖师探进半个头，胸口的银槌挂坠轻轻晃了一下。' },
      { kind: 'dialogue', speaker: '拍卖师', text: '零七。', direction: '平直，像在点货' },
      { kind: 'dialogue', speaker: '白页', text: '在。', direction: '轻，没有起伏' },
      { kind: 'dialogue', speaker: '拍卖师', text: '上台背第三节。从头开始，背到你自己停。', direction: '平直，像在点货' },
      { kind: 'narration', text: '他顿了一下，' },
      { kind: 'dialogue', speaker: '拍卖师', text: '上个月那个背多了两行，压了底价。', direction: '压低一点' },
      { kind: 'narration', text: '白页没有回答。她低头看自己的手，翻过来，掌心朝上，又翻回去。' },
    ],
    cues: [{ at: 0, ambience: 'none', intensity: 0.3 }],
  }
  const tts: Partial<TtsSettings> = { provider: 'openai', model: 'tts-test', concurrency: 2 }

  beforeEach(async () => {
    bed = await createTestBed({ settings: { tts: tts as TtsSettings } })
    await bed.runtime.project.saveCharacter({ name: '白页', aliases: ['零七'], gender: '女', age: '19', role: 'protagonist', status: 'active' })
  })
  afterEach(async () => { await bed.cleanup() })

  const useSpeech = (speech: TtsProvider): void => {
    bed.core.ttsProvider = async () => speech
  }

  it('says so when a passage could not be directed, and why', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => ({ text: '{"lines": [{"kind": "narration", "text": "更衣间的门', finish: 'max-tokens' })
    const cut = await buildAudioScript(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(cut.degraded).toMatchObject({ blocks: 1, of: 1 })
    expect(cut.degraded!.reason).toContain('cut off')
    expect(cut.lines.some(line => line.speakerName !== undefined)).toBe(false)
    // Directed properly, the same chapter has its speakers and no warning.
    bed.llm.responder = () => JSON.stringify(SCRIPT)
    const directed = await buildAudioScript(bed.core, bed.runtime, { chapter: plan.id, force: true }, { origin: 'user' })
    expect(directed.degraded).toBeUndefined()
    expect(directed.lines.map(line => line.speakerName ?? '-')).toEqual(['-', '拍卖师', '白页', '拍卖师', '-', '拍卖师', '-'])
    expect(directed.lines[2]!.speaker).toBeDefined()
  })

  it('asks the director again when the lines do not cover the passage', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(plan.id, TEXT)
    let asked = 0
    bed.llm.responder = (request) => {
      asked += 1
      if (asked === 1) return JSON.stringify({ lines: SCRIPT.lines.slice(0, 2), cues: [] })
      expect(request.prompt).toContain('covers only')
      return JSON.stringify(SCRIPT)
    }
    const script = await buildAudioScript(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(asked).toBe(2)
    expect(script.degraded).toBeUndefined()
    expect(script.lines).toHaveLength(7)
  })

  it('keeps one voice per speaker across chapters, cards or not', async () => {
    const { project } = bed.runtime
    const first = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(first.id, TEXT)
    bed.llm.responder = () => JSON.stringify(SCRIPT)
    const speech = new FakeSpeech(request => voice(130, natural(request.text)))
    useSpeech(speech)
    await synthesizeChapter(bed.core, bed.runtime, { chapter: first.id }, { origin: 'user' })
    const sheet = (await project.voiceCast())!
    expect(sheet.provider).toBe('openai')
    const heroine = (await project.characters())[0]!
    expect(sheet.characters[heroine.id]).toBeDefined()
    expect(sheet.extras['拍卖师']).toBeDefined()
    expect(sheet.extras['拍卖师']).not.toBe(sheet.characters[heroine.id])
    expect([sheet.extras['拍卖师'], sheet.characters[heroine.id]]).not.toContain('alloy')
    // A later chapter where a stranger speaks first: the two who spoke before keep their voices.
    const second = await project.addChapter({ title: '成交' })
    await project.saveChapterText(second.id, '“五副。”后排的买主举了牌。\n“成交。”拍卖师敲了槌。\n“我没有名字。”白页说。')
    bed.llm.responder = () => JSON.stringify({
      lines: [
        { kind: 'dialogue', speaker: '买主', text: '五副。' },
        { kind: 'narration', text: '后排的买主举了牌。' },
        { kind: 'dialogue', speaker: '拍卖师', text: '成交。' },
        { kind: 'narration', text: '拍卖师敲了槌。' },
        { kind: 'dialogue', speaker: '零七', text: '我没有名字。' },
        { kind: 'narration', text: '白页说。' },
      ],
      cues: [],
    })
    speech.requests.length = 0
    await synthesizeChapter(bed.core, bed.runtime, { chapter: second.id }, { origin: 'user' })
    const voiceOf = (text: string): string | undefined => speech.requests.find(request => request.text === text)?.voice
    expect(voiceOf('成交。')).toBe(sheet.extras['拍卖师'])
    expect(voiceOf('我没有名字。')).toBe(sheet.characters[heroine.id])
    expect(voiceOf('五副。')).toBeDefined()
    expect([sheet.extras['拍卖师'], sheet.characters[heroine.id], 'alloy']).not.toContain(voiceOf('五副。'))
    expect((await project.voiceCast())!.extras['买主']).toBe(voiceOf('五副。'))
  })

  it('auditions a character in the voice their lines have', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => JSON.stringify(SCRIPT)
    const speech = new FakeSpeech(request => voice(130, natural(request.text)))
    useSpeech(speech)
    await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    const heroine = (await project.characters())[0]!
    const inChapter = speech.requests.find(request => request.text === '在。')!.voice
    expect(inChapter).toBe((await project.voiceCast())!.characters[heroine.id])
    speech.requests.length = 0
    const sample = await audition(bed.core, bed.runtime, { character: heroine.name, text: '我是白页。' }, { origin: 'user' })
    expect(sample.path).toMatch(/^assets\/audio\/auditions\/.+\.wav$/)
    expect(speech.requests.at(-1)!.voice).toBe(inChapter)
    // No voice and no character: the narrator's, here the provider's own.
    await audition(bed.core, bed.runtime, { text: '旁白试音。' }, { origin: 'user' })
    expect(speech.requests.at(-1)!.voice).toBeUndefined()
    // A voice named outright is used as named.
    await audition(bed.core, bed.runtime, { voice: 'onyx', text: '试音。' }, { origin: 'user' })
    expect(speech.requests.at(-1)!.voice).toBe('onyx')
  })

  it('shows who will sound like whom without casting anyone', async () => {
    const { project } = bed.runtime
    const settings = (await bed.core.settings.get()).tts
    const heroine = (await project.characters())[0]!
    const before = await previewVoices(project, settings, [{ kind: 'dialogue', speaker: heroine.id, speakerName: heroine.name }, { kind: 'dialogue', speakerName: '拍卖师' }, { kind: 'narration' }])
    expect(before.characters[heroine.id]).toBeDefined()
    expect(before.extras['拍卖师']).toBeDefined()
    // Looking decided nothing: there is still no sheet.
    expect(await project.voiceCast()).toBeUndefined()
    // Once a chapter is voiced, the preview is what was cast.
    const plan = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => JSON.stringify(SCRIPT)
    useSpeech(new FakeSpeech(request => voice(130, natural(request.text))))
    await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    const sheet = (await project.voiceCast())!
    expect((await previewVoices(project, settings)).characters[heroine.id]).toBe(sheet.characters[heroine.id])
    expect(before.characters[heroine.id]).toBe(sheet.characters[heroine.id])
    expect(await previewVoices(project, { ...settings, provider: 'none' })).toEqual({ characters: {}, extras: {} })
  })

  it('gives every stranger a voice of their own', () => {
    const settings = { provider: 'dashscope' } as TtsSettings
    const taken = new Map<string, string>()
    const extras = new Map<string, string>()
    const cards: CharacterCard[] = []
    const voices = ['店小二', '金发女人', '老船夫', '后排的买主'].map(name => voiceFor({ kind: 'dialogue', speakerName: name }, cards, settings, taken, extras).voice)
    expect(new Set(voices).size).toBe(4)
    // The narrator reads in the provider's default voice; no stranger is given that one.
    expect(voiceFor({ kind: 'narration' }, cards, settings, taken, extras).voice).toBeUndefined()
    expect(voices).not.toContain('Cherry')
    // Asked again, each answers in the voice they were given.
    expect(voiceFor({ kind: 'dialogue', speakerName: '金发女人' }, cards, settings, taken, extras).voice).toBe(voices[1])
  })

  it('listens to every take: retakes strays, evens levels, and re-checks what was rendered before', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => JSON.stringify(SCRIPT)
    // The first render predates the check: one line is cut short, one is far too quiet.
    const careless = new FakeSpeech((request) => {
      if (request.text.startsWith('白页没有回答')) return voice(130, 0.8)
      if (request.text.startsWith('上台背第三节')) return voice(130, natural(request.text), 0.03)
      return voice(130, natural(request.text))
    })
    useSpeech(careless)
    await bed.core.settings.update({ tts: { retakes: 0 } })
    const before = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(before).toMatchObject({ rendered: 7, failed: 0, retaken: 0, flagged: 1 })
    const flaggedLine = (await project.audioScript(plan.id))!.lines.find(line => line.check !== undefined)!
    expect(flaggedLine.check).toEqual(['short'])
    // Every kept take sits at the common level, the quiet one included.
    for (const line of (await project.audioScript(plan.id))!.lines) {
      const measured = measure(parseWav(await readFile(project.path(line.audio!))))
      if (measured.speech > 0.3) expect(Math.abs(measured.level - TARGET_LEVEL)).toBeLessThan(1.2)
    }
    // With retakes allowed, the next run speaks the cut line again and leaves the good ones alone.
    await bed.core.settings.update({ tts: { retakes: 2 } })
    const careful = new FakeSpeech(request => voice(130, natural(request.text)))
    useSpeech(careful)
    const after = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(after).toMatchObject({ rendered: 1, rechecked: 1, flagged: 0, failed: 0 })
    expect(careful.requests.map(request => request.text)).toEqual([SCRIPT.lines[6]!.text])
    const script = (await project.audioScript(plan.id))!
    expect(script.lines.every(line => line.check === undefined && line.audio !== undefined)).toBe(true)
    // Nothing left to do: a third run renders nothing.
    careful.requests.length = 0
    expect(await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).toMatchObject({ rendered: 0, rechecked: 0 })
    expect(careful.requests).toHaveLength(0)
  })

  it('learns how a voice sounds from its lines and catches the take that is someone else', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '长夜' })
    const paragraphs = Array.from({ length: 5 }, (_, index) => `第${index + 1}段旁白很长，讲的是海港的夜晚如何一点一点暗下去，灯又如何一盏一盏亮起来。`)
    await project.saveChapterText(plan.id, paragraphs.join('\n'))
    bed.llm.responder = () => JSON.stringify({ lines: paragraphs.map(text => ({ kind: 'narration', text })), cues: [] })
    // The fifth paragraph comes back in another voice the first time it is spoken.
    const speech = new FakeSpeech(request => voice(request.text.startsWith('第5段') && (request.take ?? 0) === 0 ? 250 : 118, natural(request.text)))
    useSpeech(speech)
    await bed.core.settings.update({ tts: { concurrency: 1 } })
    const result = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(result).toMatchObject({ rendered: 5, retaken: 1, flagged: 0 })
    const cast = await openCast(project, (await bed.core.settings.get()).tts)
    // The narrator reads in the provider's own voice here; it is known by its lines all the same.
    expect(Math.abs((cast.print({}) ?? 0) / 118 - 1)).toBeLessThan(0.05)
    const fifth = (await project.audioScript(plan.id))!.lines[4]!
    expect(fifth.takes).toBe(2)
    expect(Math.abs(measure(parseWav(await readFile(project.path(fifth.audio!)))).pitch! / 118 - 1)).toBeLessThan(0.05)
    expect(encodeWav(voice(118, 0.1)).length).toBeGreaterThan(44)
  })
})

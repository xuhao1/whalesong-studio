// SPDX-License-Identifier: LGPL-3.0-or-later
/** Audio drama: the script that is directed, the voices that are cast, and the takes that are listened to. */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { completeJson, LlmCallError } from '../src/core/llm'
import { namedKeySource, ProviderError } from '../src/core/media/http'
import { createListener, hearingPrompt, listenModelOf, OmniListener, readHearing, readReelHearing, reelHearingPrompt, reelPasses, type Hearing, type HearingRequest, type Listener, type ReelHearing, type ReelRequest } from '../src/core/media/listen'
import { audioGenPrompt, reelPrompt, type TtsProvider, type TtsRequest, type TtsResult } from '../src/core/media/tts'
import { judge, leveled, measure, soundSpans, speechUnits, TARGET_LEVEL } from '../src/core/media/voiceprint'
import { encodeWav, parseWav, type PcmAudio } from '../src/core/media/wav'
import { audition, buildAudioScript, fallbackLines, isSkipped, isSpeechTag, playable, previewVoices, reelPath, reshapeAudioScript, speakChecked, speakerCard, synthesizeChapter, TAKE_UNITS, tidyLines, voiceFor, type Ears } from '../src/core/pipelines/audio'
import type { AudioLine, CharacterCard, TtsSettings } from '../src/shared/types'
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

/** A listener that hears what the test says it hears, and remembers what it was asked. */
class FakeListener implements Listener {
  readonly model = 'omni-test'
  readonly via = 'listen.test'
  readonly requests: HearingRequest[] = []
  constructor(private readonly verdict: (request: HearingRequest, index: number) => Hearing) {}
  async hear(request: HearingRequest): Promise<Hearing> {
    this.requests.push(request)
    return this.verdict(request, this.requests.length - 1)
  }
}

const earsOf = (listener: Listener): Ears => ({ listener, heard: 0, missed: 0 })

describe('listening without ears', () => {
  it('reads the level of a clip and how much of it is speech', () => {
    for (const pitch of [95, 120, 210, 300]) {
      const measured = measure(voice(pitch, 1.5))
      expect(measured.speech).toBeGreaterThan(1.3)
      expect(measured.seconds).toBeCloseTo(1.5, 2)
    }
    expect(measure(join(silence(1), voice(120, 0.5))).speech).toBeLessThan(0.6)
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

  it('tells a cut and a silent take from a good one, and takes the rest from what was heard', () => {
    const line = '台下翻动纸页。很轻的沙沙声，像潮水退下去之后留在滩上的尾音。'
    expect(judge(measure(voice(120, natural(line))), line).issues).toEqual([])
    expect(judge(measure(voice(120, 1.2)), line).issues).toEqual(['short'])
    expect(judge(measure(silence(2)), line).issues).toEqual(['silent'])
    // A voice is not judged by how high it sits: a shout is far higher than talking, and the same person.
    expect(judge(measure(voice(330, natural(line))), line).issues).toEqual([])
    // A word or two is never "cut short".
    expect(judge(measure(voice(120, 0.4)), '在。').issues).toEqual([])
    // What only ears can tell.
    const good = measure(voice(120, natural(line)))
    expect(judge(good, line, { stranger: true }).issues).toEqual(['drift'])
    expect(judge(good, line, { misread: '沙沙→刷刷' }).issues).toEqual(['misread'])
    expect(judge(good, line, { delivery: 2 }).issues).toEqual(['flat'])
    expect(judge(good, line, { delivery: 3 }).issues).toEqual([])
    expect(judge(good, line, { delivery: 4, note: '轻而慢' }).heard).toEqual({ delivery: 4, note: '轻而慢' })
  })

  it('asks the listener how far the take moved from the voice talking, not whether the words sound angry', () => {
    const asked = hearingPrompt({ text: '去他娘的！', direction: '破锣嗓骤然爆开', sampled: true })
    expect(asked.before).toContain('先是平常说话')
    expect(asked.between).toContain('导演要求：“破锣嗓骤然爆开”')
    expect(asked.after).toContain('不要因为台词的字面意思就认为语气到位')
    expect(asked.after).toContain('"delivery"')
    expect(asked.after).toContain('"voice"')
    // Nothing asked, no sample: only the words are heard.
    const plain = hearingPrompt({ text: 'The tide went out.', sampled: false, language: 'en' })
    expect(plain.before).toBeUndefined()
    expect(plain.after).not.toContain('delivery')
    expect(plain.after).not.toContain('"voice"')
    // What the model says, as a hearing.
    expect(readHearing('```json\n{"misread":"","voice":"same","delivery":"4","note":"更响更急"}\n```', true)).toEqual({ delivery: 4, note: '更响更急' })
    expect(readHearing('{"misread":"无","voice":"different","delivery":9}', true)).toEqual({ stranger: true, delivery: 5 })
    expect(readHearing('{"misread":"签→切","delivery":2}', false)).toEqual({ misread: '签→切' })
    expect(() => readHearing('听起来很平。', true)).toThrow(/JSON/)
  })

  it('finds the stretches of sound between pauses', () => {
    const spans = soundSpans(join(silence(0.2), voice(120, 0.8), silence(1), voice(120, 0.4), silence(0.3)))
    expect(spans).toHaveLength(2)
    expect(spans[0]!.start).toBeCloseTo(0.2, 1)
    expect(spans[1]!.end - spans[1]!.start).toBeCloseTo(0.4, 1)
  })

  it('speaks a line again when it is heard in another voice or played flat, and keeps the best', async () => {
    const line = '他把那封信折了三折，放回抽屉最里面。'
    const sample = voice(120, 2)
    const speech = new FakeSpeech(request => voice(124, natural(request.text), 0.05))
    // Another voice the first time; the second take is the voice, played as asked.
    const ears = earsOf(new FakeListener((_request, index) => (index === 0 ? { stranger: true, delivery: 4 } : { delivery: 4 })))
    const retakes: number[] = []
    const take = await speakChecked(speech, { text: line, reference: sample, direction: '压低声音' }, { ears, retakes: 2, onRetake: (number) => { retakes.push(number) } })
    expect(take.takes).toBe(2)
    expect(retakes).toEqual([1])
    expect(take.verdict.issues).toEqual([])
    expect(take.verdict.heard).toEqual({ delivery: 4 })
    expect(ears.heard).toBe(2)
    // The listener was given the voice's sample, the words and what was asked.
    const asked = (ears.listener as FakeListener).requests[0]!
    expect(asked.sample).toBe(sample)
    expect(asked).toMatchObject({ text: line, direction: '压低声音' })
    expect(Math.abs(measure(take.audio).level - TARGET_LEVEL)).toBeLessThan(1)
    // Every take is flat: the one played furthest is kept and says what is wrong with it.
    const flat = earsOf(new FakeListener((_request, index) => ({ delivery: [1, 2, 1][index]! })))
    const kept = await speakChecked(speech, { text: line, direction: '怒吼' }, { ears: flat, retakes: 2 })
    expect(kept.takes).toBe(3)
    expect(kept.verdict.issues).toEqual(['flat'])
    expect(kept.verdict.heard?.delivery).toBe(2)
    // A take cut short is spoken again without being heard.
    const once = earsOf(new FakeListener(() => ({})))
    const cut = new FakeSpeech(request => voice(124, (request.take ?? 0) === 0 ? 0.8 : natural(request.text)))
    expect((await speakChecked(cut, { text: line }, { ears: once, retakes: 2 })).takes).toBe(2)
    expect(once.heard).toBe(1)
    // A retake that fails outright does not cost the line the take it has.
    let calls = 0
    const flaky = new FakeSpeech((request) => {
      calls += 1
      if (calls > 1) throw new Error('rate limited')
      return voice(240, natural(request.text))
    })
    expect((await speakChecked(flaky, { text: line }, { ears: earsOf(new FakeListener(() => ({ stranger: true }))), retakes: 2 })).takes).toBe(1)
  })

  it('sends the sample, then the take, to the listening model, and asks again when it does not answer in JSON', async () => {
    const bodies: { model: string; messages: { content: { type: string; text?: string; input_audio?: { data: string; format: string } }[] }[] }[] = []
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      request.on('end', () => {
        bodies.push(JSON.parse(raw) as typeof bodies[number])
        const content = bodies.length === 1 ? '<tool_call>"? No.' : '{"misread":"","voice":"same","delivery":4,"note":"更响更急"}'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 300, completion_tokens: 40 } }))
      })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/compatible-mode/v1`
      const listener = new OmniListener('omni-test', base, namedKeySource(name => (name === 'TEST_KEY' ? 'k' : undefined)), 'TEST_KEY')
      const hearing = await listener.hear({ take: voice(120, 1), sample: voice(110, 3), text: '去他娘的！', direction: '破锣嗓骤然爆开' })
      expect(hearing).toEqual({ delivery: 4, note: '更响更急', usage: { input: 600, output: 80 } })
      expect(bodies).toHaveLength(2)
      const parts = bodies[0]!.messages[0]!.content
      expect(parts.map(part => part.type)).toEqual(['text', 'input_audio', 'text', 'input_audio', 'text'])
      expect(parts[1]!.input_audio!.data.length).toBeGreaterThan(parts[3]!.input_audio!.data.length)
      expect(parts[2]!.text).toContain('导演要求：“破锣嗓骤然爆开”')
      expect(bodies[0]!.model).toBe('omni-test')
    } finally {
      server.close()
    }
    // Which model listens: the one named, else the one recommended beside Bailian's own speech; none switches it off.
    expect(listenModelOf({ provider: 'qwen-audiogen' })).toBe('qwen3.8-omni-flash')
    expect(listenModelOf({ provider: 'openai' })).toBeUndefined()
    expect(listenModelOf({ provider: 'openai', listenModel: 'qwen3.5-omni-plus' })).toBe('qwen3.5-omni-plus')
    expect(listenModelOf({ provider: 'qwen-audiogen', listenModel: 'none' })).toBeUndefined()
    expect(createListener({ provider: 'qwen-audiogen', listenModel: 'none' }, namedKeySource(() => undefined))).toBeUndefined()
    expect(createListener({ provider: 'qwen-audiogen', baseURL: 'https://dashscope.aliyuncs.com' }, namedKeySource(() => undefined))?.via).toBe('dashscope.aliyuncs.com')
  })

  it('stops listening when there is no key to listen with, and keeps speaking', async () => {
    const line = '他把那封信折了三折，放回抽屉最里面。'
    const speech = new FakeSpeech(request => voice(124, natural(request.text)))
    const deaf: Listener = { model: 'omni-test', via: 'listen.test', hear: async () => { throw new ProviderError('Listening: no Bailian key is saved', undefined, 'NO_CREDENTIAL') } }
    const ears = earsOf(deaf)
    const first = await speakChecked(speech, { text: line, direction: '怒吼' }, { ears, retakes: 2 })
    expect(first).toMatchObject({ takes: 1, verdict: { issues: [] } })
    expect(ears.lost).toMatch(/no Bailian key/)
    expect(ears.missed).toBe(1)
    // Not asked again for the rest of the work.
    await speakChecked(speech, { text: line }, { ears, retakes: 2 })
    expect(ears.missed).toBe(1)
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

  it('speaks neighbouring narration in one take and leaves a stranded "he said" unspoken', () => {
    const { lines, map } = tidyLines([
      { kind: 'narration', text: '白页没有回答。她低头看自己的手，翻过来，掌心朝上，又翻回去。' },
      { kind: 'narration', text: '门开了。她走出去。' },
      { kind: 'dialogue', text: '零七。', speakerName: '拍卖师' },
      { kind: 'narration', text: '他顿了一下，' },
      { kind: 'dialogue', text: '上个月那个背多了两行。', speakerName: '拍卖师' },
      { kind: 'narration', text: '白页说，' },
      { kind: 'dialogue', text: '是第一次上机。', speakerName: '白页' },
      { kind: 'narration', text: '她开口。' },
      { kind: 'narration', text: '那段记忆不是她的。这一点写在拍卖手册第二页，她背过。' },
    ])
    expect(lines.map(line => line.text)).toEqual([
      // Paragraphs keep a break between them inside the take.
      '白页没有回答。她低头看自己的手，翻过来，掌心朝上，又翻回去。\n门开了。她走出去。',
      '零七。',
      '他顿了一下，',
      '上个月那个背多了两行。',
      '白页说，',
      '是第一次上机。',
      '她开口。\n那段记忆不是她的。这一点写在拍卖手册第二页，她背过。',
    ])
    expect(map).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 6])
    // A beat that is acted is narration; only the words that say who spoke are a tag.
    expect(lines.map(line => line.tag === true)).toEqual([false, false, false, false, true, false, false])
    // Pieces of one sentence run on; English fragments are joined with a space.
    expect(tidyLines([{ kind: 'narration', text: '她停下来，' }, { kind: 'narration', text: '看了一眼台下。' }]).lines[0]!.text).toBe('她停下来，看了一眼台下。')
    expect(tidyLines([{ kind: 'narration', text: 'She stopped,' }, { kind: 'narration', text: 'and looked at the hall.' }]).lines[0]!.text).toBe('She stopped, and looked at the hall.')
  })

  it('knows the words that only say who spoke', () => {
    for (const tag of ['他说，', '白页说：', '她问道。', '拍卖师低声说，', 'he said.', 'she asked quietly,', 'said the auctioneer.']) expect(isSpeechTag(tag), tag).toBe(true)
    for (const told of ['他顿了一下，', '她笑了。', '白页没有回答。', '他说完，转身走了。', '门开了。', 'He paused.', 'she said, and left the room at once.']) expect(isSpeechTag(told), told).toBe(false)
  })

  it('keeps a take to a length a narrator holds, and cuts a long paragraph evenly', () => {
    const paragraph = (n: number): string => `第${n}段：海港的夜晚一点一点暗下去，灯一盏一盏亮起来，缆索在风里吱呀作响，远处有人在卸灯油。`
    const run = tidyLines(Array.from({ length: 8 }, (_, index) => ({ kind: 'narration' as const, text: paragraph(index + 1) })))
    // Eight paragraphs of narration are not eight clips, and no take runs far past its length.
    expect(run.lines.length).toBeGreaterThan(1)
    expect(run.lines.length).toBeLessThan(5)
    for (const line of run.lines) expect(speechUnits(line.text)).toBeLessThanOrEqual(TAKE_UNITS * 1.3)
    expect(run.lines.map(line => line.text).join('\n')).toBe(Array.from({ length: 8 }, (_, index) => paragraph(index + 1)).join('\n'))
    // One paragraph too long for a take is cut at sentence ends into pieces of about the same size.
    const long = Array.from({ length: 12 }, (_, index) => `这是很长的一段里的第${index + 1}句话，讲的还是同一件事，只是换了一个角度。`).join('')
    const cut = tidyLines([{ kind: 'narration', text: long }])
    const sizes = cut.lines.map(line => speechUnits(line.text))
    expect(cut.lines.length).toBeGreaterThan(1)
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.6)
    expect(cut.lines.map(line => line.text).join('')).toBe(long)
    expect(cut.map).toEqual([cut.lines.length - 1])
  })

  it('leaves a line unspoken by the book\'s rule or by the author\'s word', () => {
    const tag = { kind: 'narration' as const, tag: true }
    expect(isSkipped(tag, {})).toBe(true)
    expect(isSkipped(tag, { speechTags: 'read' })).toBe(false)
    expect(isSkipped({ ...tag, voiced: true }, {})).toBe(false)
    expect(isSkipped({ kind: 'narration', voiced: false }, { speechTags: 'read' })).toBe(true)
    const said: AudioLine[] = [{ id: 'l0', kind: 'narration', text: '他说，', tag: true }, { id: 'l1', kind: 'dialogue', text: '好。' }]
    const script = playable({ lines: said }, {})
    expect(script.lines.map(line => line.skip === true)).toEqual([true, false])
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
    await bed.runtime.project.saveCharacter({ name: '白页', aliases: ['零七'], gender: '女', age: '19', role: 'protagonist' })
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

  it('knows a speaker by the name with its aliases the director copied from the cast', () => {
    const cards = [
      { id: 'alice', name: 'Alice', aliases: ['Mary Ann'] },
      { id: 'zhen', name: '甄士隐', aliases: ['士隐'] },
      { id: 'monk', name: '茫茫大士', aliases: ['癞头和尚'] },
    ] as CharacterCard[]
    expect(speakerCard(cards, 'Alice(Mary Ann)')?.id).toBe('alice')
    expect(speakerCard(cards, 'Alice (Mary Ann)')?.id).toBe('alice')
    expect(speakerCard(cards, 'mary ann')?.id).toBe('alice')
    expect(speakerCard(cards, '士隐')?.id).toBe('zhen')
    expect(speakerCard(cards, '那僧（癞头和尚）')?.id).toBe('monk')
    expect(speakerCard(cards, '众人')).toBeUndefined()
    expect(speakerCard(cards, '丫鬟（小红）')).toBeUndefined()
  })

  it('voices a speaker the director wrote with aliases, or whose card came after the script, as the card', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(plan.id, TEXT)
    // The heroine as the cast list shows her; the auctioneer has no card yet.
    bed.llm.responder = () => JSON.stringify({ ...SCRIPT, lines: SCRIPT.lines.map(line => line.speaker === '白页' ? { ...line, speaker: '白页(零七)' } : line) })
    const speech = new FakeSpeech(request => voice(130, natural(request.text)))
    useSpeech(speech)
    await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    const heroine = (await project.characters())[0]!
    const voiceOf = (text: string): string | undefined => speech.requests.findLast(request => request.text === text)?.voice
    expect(voiceOf('在。')).toBe((await project.voiceCast())!.characters[heroine.id])
    expect((await project.audioScript(plan.id))!.lines.find(line => line.text === '在。')).toMatchObject({ speaker: heroine.id, speakerName: '白页' })
    const stranger = voiceOf('零七。')
    // The auctioneer is given a card afterwards: his lines are spoken again, in the card's voice, and the script names him.
    const auctioneer = await project.saveCharacter({ name: '拍卖师', gender: '男', age: '50', role: 'supporting' })
    speech.requests.length = 0
    await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(voiceOf('零七。')).toBe((await project.voiceCast())!.characters[auctioneer.id])
    expect(voiceOf('零七。')).not.toBe(stranger)
    expect(voiceOf('在。')).toBeUndefined()
    expect((await project.audioScript(plan.id))!.lines.filter(line => line.speakerName === '拍卖师').every(line => line.speaker === auctioneer.id)).toBe(true)
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

  it('has every new take heard, speaks again what was heard wrong, and keeps what was heard on the line', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '长夜' })
    const paragraphs = Array.from({ length: 3 }, (_, index) => `第${index + 1}段旁白很长，讲的是海港的夜晚如何一点一点暗下去，灯又如何一盏一盏亮起来。`)
    const reply = '我去看看缆索，一会儿就回来。'
    await project.saveChapterText(plan.id, paragraphs.map((text, index) => (index < 2 ? `${text}\n“${reply}”` : text)).join('\n'))
    bed.llm.responder = () => JSON.stringify({ lines: paragraphs.flatMap((text, index) => [{ kind: 'narration', text }, ...(index < 2 ? [{ kind: 'dialogue', speaker: '老周', text: reply, direction: '扯着嗓子喊' }] : [])]), cues: [] })
    useSpeech(new FakeSpeech(request => voice(118, natural(request.text))))
    // The third paragraph is heard in another voice the first time; 老周 never gets past talking.
    let third = 0
    const listener = new FakeListener((request) => {
      if (request.text.startsWith('第3段') && third++ === 0) return { stranger: true }
      if (request.text === reply) return { delivery: 1, note: '和平常说话一样' }
      return {}
    })
    bed.core.speechListener = async () => listener
    await bed.core.settings.update({ tts: { concurrency: 1, retakes: 1 } })
    const result = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(result).toMatchObject({ rendered: 5, retaken: 3, flagged: 2, heard: 8 })
    const lines = (await project.audioScript(plan.id))!.lines
    expect(lines[4]).toMatchObject({ takes: 2, heard: { by: 'omni-test' } })
    expect(lines[4]!.check).toBeUndefined()
    expect(lines[1]).toMatchObject({ takes: 2, check: ['flat'], heard: { by: 'omni-test', delivery: 1, note: '和平常说话一样' } })
    // Rendered lines are not heard again on the next run: that would be a call for every line, every time.
    listener.requests.length = 0
    expect(await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).toMatchObject({ rendered: 0, heard: 0 })
    expect(listener.requests).toHaveLength(0)
  })

  it('joins the narration of a whole chapter, drops the stranded tag, and voices it only when asked to', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '舷梯' })
    const text = '续页号的舷梯十七级，她数过。\n第九级上，靴底从骨木换到钢面。\n“第一次上机？”\n“不是第一次。”白页说，“是第一次上机。”\n伊瑟的眉皱起来。记录官把这句话抄进了本子。'
    await project.saveChapterText(plan.id, text)
    bed.llm.responder = () => JSON.stringify({
      lines: [
        { kind: 'narration', text: '续页号的舷梯十七级，她数过。' },
        { kind: 'narration', text: '第九级上，靴底从骨木换到钢面。' },
        { kind: 'dialogue', speaker: '伊瑟', text: '第一次上机？' },
        { kind: 'dialogue', speaker: '白页', text: '不是第一次。' },
        { kind: 'narration', text: '白页说，' },
        { kind: 'dialogue', speaker: '白页', text: '是第一次上机。' },
        { kind: 'narration', text: '伊瑟的眉皱起来。记录官把这句话抄进了本子。' },
      ],
      cues: [
        { at: 0, kind: 'bed', ambience: 'sea', caption: '缆索吱呀，潮水拍着船壳', prompt: '港口停泊的铁壳船，缆索吱呀，水拍船壳' },
        { at: 1, kind: 'effect', caption: '靴底踩上钢面，一声黏响', prompt: '靴子踩在刷过胶的钢板上，一声发黏的脚步，约两秒' },
        { at: 6, kind: 'music', caption: '低沉的弦乐长音', prompt: '低沉的弦乐长音，克制，不安，纯器乐' },
      ],
    })
    const script = await buildAudioScript(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(script.shape).toBe(2)
    expect(script.lines.map(line => line.kind)).toEqual(['narration', 'dialogue', 'dialogue', 'narration', 'dialogue', 'narration'])
    expect(script.lines[0]!.text).toBe('续页号的舷梯十七级，她数过。\n第九级上，靴底从骨木换到钢面。')
    expect(script.lines[3]).toMatchObject({ text: '白页说，', tag: true })
    // Cues follow the lines they were placed on through the joining.
    expect(script.cues.map(cue => [cue.kind, cue.at])).toEqual([['bed', 'l0'], ['effect', 'l0'], ['music', 'l5']])
    expect(script.cues[1]).toMatchObject({ caption: '靴底踩上钢面，一声黏响', ambience: 'none' })
    const speech = new FakeSpeech(request => voice(130, natural(request.text)))
    useSpeech(speech)
    const first = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(first.rendered).toBe(5)
    expect(speech.requests.some(request => request.text === '白页说，')).toBe(false)
    // An audiobook reads every word: with that chosen, the tag is the one line still to speak.
    await bed.core.settings.update({ tts: { speechTags: 'read' } })
    speech.requests.length = 0
    const second = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(second.rendered).toBe(1)
    expect(speech.requests.map(request => request.text)).toEqual(['白页说，'])
  })

  it('reshapes a script cut the old way without asking a model, keeping what was recorded', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '旧脚本' })
    await project.saveChapterText(plan.id, '甲。\n乙。\n“好。”\n他说，\n“走。”\n丙。')
    await project.saveAudioScript({
      schema: 1,
      chapterId: plan.id,
      textHash: 'x',
      updatedAt: new Date().toISOString(),
      lines: [
        { id: 'l0', kind: 'narration', text: '更衣间的门开了一条缝。', audio: 'assets/audio/a.wav', renderKey: 'k0' },
        { id: 'l1', kind: 'narration', text: '拍卖师探进半个头。', audio: 'assets/audio/b.wav', renderKey: 'k1' },
        { id: 'l2', kind: 'dialogue', speakerName: '拍卖师', text: '零七。', audio: 'assets/audio/c.wav', renderKey: 'k2' },
        { id: 'l3', kind: 'narration', text: '他说，', audio: 'assets/audio/d.wav', renderKey: 'k3' },
        { id: 'l4', kind: 'dialogue', speakerName: '拍卖师', text: '上台。', audio: 'assets/audio/e.wav', renderKey: 'k4' },
        { id: 'l5', kind: 'narration', text: '白页没有回答。' },
      ],
      cues: [{ at: 'l0', ambience: 'none' }, { at: 'l4', ambience: 'crowd', note: '台下的人声' }],
    })
    const llmCalls = bed.llm.requests.length
    const result = await reshapeAudioScript(bed.runtime, plan.id)
    expect(bed.llm.requests.length).toBe(llmCalls)
    expect(result).toMatchObject({ before: 6, after: 5, kept: 3 })
    expect(result.script.lines.map(line => [line.id, line.text, line.audio !== undefined])).toEqual([
      ['l0', '更衣间的门开了一条缝。\n拍卖师探进半个头。', false],
      ['l1', '零七。', true],
      ['l2', '他说，', true],
      ['l3', '上台。', true],
      ['l4', '白页没有回答。', false],
    ])
    expect(result.script.lines[2]!.tag).toBe(true)
    expect(result.script.cues.map(cue => [cue.id, cue.at])).toEqual([['c0', 'l0'], ['c1', 'l3']])
    expect(result.script.shape).toBe(2)
  })
})

describe('one voice, many ways of speaking', () => {
  let bed: TestBed
  const TEXT = '舱里警报乱响。\n“闭嘴，抓稳扶手！”\n“好了，都回去吧。”'
  const SCRIPT = {
    lines: [
      { kind: 'narration', text: '舱里警报乱响。' },
      { kind: 'dialogue', speaker: '赵铁锚', text: '闭嘴，抓稳扶手！', direction: '顶着噪声粗哑怒喝，命令短促有力' },
      { kind: 'dialogue', speaker: '赵铁锚', text: '好了，都回去吧。', direction: '缓下来，声音沙哑' },
    ],
    cues: [{ at: 0, ambience: 'none', intensity: 0.3 }],
  }

  /** Like Bailian's audio model: a described voice, a sample it imitates; it records a reel when asked for a voice. */
  class ImitatingSpeech implements TtsProvider {
    readonly kind = 'qwen-audiogen' as const
    readonly requests: TtsRequest[] = []
    readonly reels: { voice: string; reference?: PcmAudio; take?: number }[] = []
    async anchor(voiceText: string, options: { reference?: PcmAudio; take?: number }): Promise<PcmAudio> {
      this.reels.push({ voice: voiceText, ...(options.reference !== undefined ? { reference: options.reference } : {}), ...(options.take !== undefined ? { take: options.take } : {}) })
      return join(voice(110, 1.5), silence(0.4), voice(260, 1.5, 0.4), silence(0.4), voice(140, 1.5, 0.05))
    }
    async synthesize(request: TtsRequest): Promise<TtsResult> {
      this.requests.push(request)
      return voice(120, natural(request.text))
    }
  }

  beforeEach(async () => {
    bed = await createTestBed({ settings: { tts: { provider: 'qwen-audiogen', model: 'audio-test', concurrency: 1 } as TtsSettings } })
    await bed.runtime.project.saveCharacter({ name: '赵铁锚', gender: '男', age: '四十五', role: 'supporting', voice: '破锣嗓门、粗话直爽' })
  })
  afterEach(async () => { await bed.cleanup() })

  it('says how the line is played as the act itself, not as a remark beside it', () => {
    const angry = audioGenPrompt({ text: '闭嘴！', voice: '成年男性，破锣嗓门', direction: '顶着噪声粗哑怒喝。', referenced: true })
    expect(angry).toContain('@voice1（同一个人：成年男性，破锣嗓门）这一句顶着噪声粗哑怒喝，一字不差地说：')
    expect(angry).not.toContain('安静')
    expect(angry).not.toContain('（这一句')
    expect(audioGenPrompt({ text: '好了。', voice: '成年男性，破锣嗓门', referenced: true })).toContain('@voice1（同一个人：成年男性，破锣嗓门）一字不差地说：')
    expect(audioGenPrompt({ text: 'Shut up!', voice: 'a hoarse man', direction: 'roaring over the engines', referenced: true, language: 'en' })).toContain('@voice1 (the same person: a hoarse man) says this line roaring over the engines, word for word:')
    // The sample: one voice talking, shouting, hushed, laughing and near tears.
    const reel = reelPrompt({ voice: '成年男性，破锣嗓门。', referenced: false })
    for (const way of ['平常说话', '大吼', '耳语', '大笑', '哭腔']) expect(reel).toContain(way)
    expect(reel).toContain('一位成年男性，破锣嗓门，给导演录一段嗓子样本')
    expect(reelPrompt({ voice: 'a hoarse man', referenced: true, language: 'en' })).toContain('@voice1 (the same person: a hoarse man) records a sample')
  })

  it('records one reel for a voice and speaks every line of it from that reel, however it is directed', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '接管' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => JSON.stringify(SCRIPT)
    const speech = new ImitatingSpeech()
    bed.core.ttsProvider = async () => speech
    // A calm sample made by an earlier version is not read: every line imitating it came out calm.
    const card = (await project.characters())[0]!
    const settings = (await bed.core.settings.get()).tts
    const choice = voiceFor({ kind: 'dialogue', speaker: card.id }, await project.characters(), settings, new Map())
    await project.writeAsset(`audio/voices/anchor-${'0'.repeat(12)}.wav`, encodeWav(voice(110, 2)))
    const result = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(result).toMatchObject({ rendered: 3, retaken: 0, flagged: 0, failed: 0 })
    // One reel each for the narrator and 赵铁锚, made from words alone.
    expect(speech.reels).toHaveLength(2)
    expect(speech.reels.every(reel => reel.reference === undefined)).toBe(true)
    const shout = speech.requests.find(request => request.text === '闭嘴，抓稳扶手！')!
    const calm = speech.requests.find(request => request.text === '好了，都回去吧。')!
    // The roar and the quiet line imitate the same reel; only the direction differs.
    expect(shout.reference).toBeDefined()
    expect(shout.reference).toBe(calm.reference)
    expect(shout.direction).toContain('怒喝')
    expect(calm.direction).toContain('缓下来')
    expect(await project.has(`assets/${reelPath(settings, choice)}`)).toBe(true)
    // Voiced again later, the reels are reused, and nothing is spoken again.
    speech.requests.length = 0
    expect(await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })).toMatchObject({ rendered: 0, rechecked: 0 })
    expect(speech.reels).toHaveLength(2)
    expect(speech.requests).toHaveLength(0)
  })

  it('hears every reel before a line imitates it, and records again one whose shout pulled the voice thin', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '接管' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => JSON.stringify(SCRIPT)
    const speech = new ImitatingSpeech()
    bed.core.ttsProvider = async () => speech
    const reels: ReelRequest[] = []
    const listener: Listener = {
      model: 'omni-test',
      via: 'listen.test',
      hear: async () => ({ delivery: 4 }),
      hearReel: async (request): Promise<ReelHearing> => {
        reels.push(request)
        // 赵铁锚's first reel shouts in a voice pulled thin; the narrator's is fine.
        const his = reels.filter(reel => reel.voice?.includes('破锣嗓门') === true)
        return request.voice?.includes('破锣嗓门') === true && his.length === 1 ? { same: false, fits: true, range: 4, note: '吼的那句被拉尖了' } : { same: true, fits: true, range: 4 }
      },
    }
    bed.core.speechListener = async () => listener
    const result = await synthesizeChapter(bed.core, bed.runtime, { chapter: plan.id }, { origin: 'user' })
    expect(result).toMatchObject({ rendered: 3, flagged: 0 })
    // His recorded twice — the second time from another draw — and heard each time, with the voice in words; the narrator's once.
    const his = speech.reels.filter(reel => reel.voice.includes('破锣嗓门'))
    expect(his.map(reel => reel.take)).toEqual([undefined, 1])
    expect(speech.reels).toHaveLength(3)
    expect(reels).toHaveLength(3)
    expect(speech.requests.every(request => request.reference !== undefined)).toBe(true)
    // The question, and reading the answer.
    expect(reelHearingPrompt({ voice: '破锣嗓门的老船长' })).toContain('嗓子被拉尖、变细、像卡通或像换了个人，就是 false')
    expect(reelHearingPrompt({ language: 'en' })).toContain('is it a natural human voice')
    expect(readReelHearing('{"same":true,"fits":"false","range":"4","note":"像个年轻人"}')).toEqual({ same: true, fits: false, range: 4, note: '像个年轻人' })
    expect(reelPasses({ same: true, fits: true, range: 2 })).toBe(false)
    expect(reelPasses({ same: true, fits: true })).toBe(true)
    expect(hearingPrompt({ text: '闭嘴！', direction: '怒喝', sampled: true }).after).toContain('嗓子被拉尖、变细、像卡通或像换了个人算 different')
  })

  it('makes the reel of a designed voice from its preview, so it stays the voice that was chosen', async () => {
    const { project } = bed.runtime
    const card = (await project.characters())[0]!
    const preview = voice(105, 2)
    const sample = await project.writeAsset(`audio/voices/${card.id}-design.wav`, encodeWav(preview))
    await project.saveCharacter({ id: card.id, voiceProfile: { provider: 'qwen-audiogen', voice: '低沉沙哑的中年男声', sample } })
    const speech = new ImitatingSpeech()
    bed.core.ttsProvider = async () => speech
    await audition(bed.core, bed.runtime, { character: card.name, text: '都给我站住！', direction: '怒吼' }, { origin: 'user' })
    expect(speech.reels).toHaveLength(1)
    expect(speech.reels[0]!.voice).toBe('低沉沙哑的中年男声')
    expect(speech.reels[0]!.reference?.pcm.length).toBe(preview.pcm.length)
    expect(speech.requests[0]!.reference).toBeDefined()
    expect(speech.requests[0]!.reference!.pcm.length).toBeGreaterThan(preview.pcm.length)
  })
})

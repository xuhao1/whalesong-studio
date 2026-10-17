// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What arithmetic can tell about a take: how loud it is and how long it spoke.
 * A generative speech model does not always do what it was asked — a line can
 * come back cut short, padded, silent, or much louder than its neighbours —
 * and these few measurements let the pipeline notice, take the line again, and
 * level what it keeps. Whether it is still the voice, whether the words are
 * right, and how the line was played are heard by a model with ears
 * (`listen.ts`): the pitch of a voice says nothing about either, and judging by
 * it kept the calmest take of every angry line.
 *
 * Everything here is plain arithmetic on PCM samples; nothing is sent anywhere.
 */
import type { TakeIssue } from '../../shared/types'
import type { Hearing } from './listen'
import type { PcmAudio } from './wav'

export interface VoiceMeasure {
  /** Length of the clip in seconds. */
  seconds: number
  /** Seconds of the clip that carry speech. */
  speech: number
  /** RMS level of the speech itself, in dBFS. */
  level: number
  /** Loudest sample, in dBFS. */
  peak: number
}

/** Frames quieter than this are pauses, not speech (linear, full scale = 1). */
const SPEECH_FLOOR = 0.01

/** Measure a clip: level, and how much of it is speech. */
export function measure(audio: PcmAudio): VoiceMeasure {
  const { pcm, sampleRate } = audio
  const frame = Math.floor(sampleRate * 0.04)
  const hop = Math.floor(sampleRate * 0.01)
  let speechFrames = 0
  let energy = 0
  for (let at = 0; at + frame <= pcm.length; at += hop) {
    let sum = 0
    for (let i = 0; i < frame; i++) {
      const value = pcm[at + i]! / 32768
      sum += value * value
    }
    if (Math.sqrt(sum / frame) < SPEECH_FLOOR) continue
    speechFrames += 1
    energy += sum / frame
  }
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const value = Math.abs(pcm[i]!)
    if (value > peak) peak = value
  }
  return {
    seconds: pcm.length / sampleRate,
    speech: speechFrames * 0.01,
    level: speechFrames > 0 ? 20 * Math.log10(Math.sqrt(energy / speechFrames) + 1e-9) : -120,
    peak: 20 * Math.log10(peak / 32768 + 1e-9),
  }
}

/** The level every line is brought to, and the ceiling its peaks are held under (dBFS). */
export const TARGET_LEVEL = -20
const CEILING = 0.89

/**
 * Bring a clip to the common level, so no line is a whisper beside a shout.
 * Peaks that would pass the ceiling are rounded off rather than clipped.
 */
export function leveled(audio: PcmAudio, measured: VoiceMeasure = measure(audio), target = TARGET_LEVEL): PcmAudio {
  // Near-silence is not speech to be raised.
  if (measured.level < -50 || measured.speech < 0.05) return audio
  // Raised by twenty decibels at most: beyond that it is the room that gets louder, not the voice.
  const gain = Math.min(10, 10 ** ((target - measured.level) / 20))
  if (Math.abs(gain - 1) < 0.06) return audio
  const pcm = new Int16Array(audio.pcm.length)
  const knee = 0.75
  for (let i = 0; i < pcm.length; i++) {
    const value = (audio.pcm[i]! / 32768) * gain
    const size = Math.abs(value)
    const shaped = size <= knee ? size : knee + (CEILING - knee) * Math.tanh((size - knee) / (CEILING - knee))
    pcm[i] = Math.round(Math.sign(value) * shaped * 32767)
  }
  return { pcm, sampleRate: audio.sampleRate }
}

/** How much there is to say: a CJK character is a syllable; a Latin word is taken as one and a half. */
export function speechUnits(text: string): number {
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length
  const words = (text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length
  return cjk + words * 1.5
}

export interface TakeVerdict {
  issues: TakeIssue[]
  /** Syllables per second. */
  pace: number
  /** What the listener heard, when the take was heard. */
  heard?: Hearing
}

/** A delivery heard at this or below went hardly further than talking: the line is played again. */
export const FLAT_DELIVERY = 2

/**
 * Judge a take against what it should be: the whole line (not a fragment, not
 * a ramble), audible — and, where it was heard, the words of the line, in its
 * voice, played as asked.
 */
export function judge(measured: VoiceMeasure, text: string, heard?: Hearing): TakeVerdict {
  const units = speechUnits(text)
  const pace = measured.seconds > 0 ? units / measured.seconds : 0
  const issues: TakeIssue[] = []
  if (measured.speech < 0.08 || measured.level < -45) issues.push('silent')
  // Nobody speaks nine or ten syllables a second: most of the line is missing. The shorter the line the less its pace says, and a word or two cannot be told this way at all.
  else if (units >= 6 && pace > (units >= 10 ? 8.5 : 9.5)) issues.push('short')
  // A line that takes several times as long as its words was padded with something that was not asked for.
  else if (units >= 4 && measured.seconds > 4 && pace < 0.9) issues.push('long')
  if (heard?.misread !== undefined) issues.push('misread')
  if (heard?.stranger === true) issues.push('drift')
  if (heard?.delivery !== undefined && heard.delivery <= FLAT_DELIVERY) issues.push('flat')
  return { issues, pace, ...(heard !== undefined ? { heard } : {}) }
}

/** How bad a verdict is; lower is better. A missing or cut line outweighs another voice, which outweighs a wrong word or a flat delivery. */
export function badness(verdict: TakeVerdict): number {
  let score = 0
  if (verdict.issues.includes('silent')) score += 100
  if (verdict.issues.includes('short')) score += 50
  if (verdict.issues.includes('drift')) score += 40
  if (verdict.issues.includes('misread')) score += 25
  if (verdict.issues.includes('long')) score += 20
  // Of takes that pass, the one played further toward what was asked; a take nobody heard ranks as a middling one.
  score += (5 - (verdict.heard?.delivery ?? 3)) * 4
  return score
}

/**
 * Stretches of sound in a clip, separated by pauses of at least `minGap`
 * seconds. Used to cut a take that was spoken as "a lead-in, a pause, the line".
 */
export function soundSpans(audio: PcmAudio, minGap = 0.5): { start: number; end: number }[] {
  const { pcm, sampleRate } = audio
  const frame = Math.floor(sampleRate * 0.03)
  const hop = Math.floor(sampleRate * 0.01)
  const threshold = SPEECH_FLOOR * 1.2 * 32768
  const spans: { start: number; end: number }[] = []
  let start = -1
  let lastLoud = -1
  for (let at = 0, index = 0; at + frame <= pcm.length; at += hop, index++) {
    let sum = 0
    for (let i = 0; i < frame; i++) sum += pcm[at + i]! * pcm[at + i]!
    const loud = Math.sqrt(sum / frame) > threshold
    if (loud) {
      if (start < 0) start = index
      lastLoud = index
    } else if (start >= 0 && (index - lastLoud) * 0.01 >= minGap) {
      spans.push({ start: start * 0.01, end: (lastLoud + 1) * 0.01 + 0.03 })
      start = -1
    }
  }
  if (start >= 0) spans.push({ start: start * 0.01, end: Math.min(pcm.length / sampleRate, (lastLoud + 1) * 0.01 + 0.03) })
  return spans
}

/** The part of a clip between two moments, in seconds. */
export function slice(audio: PcmAudio, start: number, end: number): PcmAudio {
  const from = Math.max(0, Math.floor(start * audio.sampleRate))
  const to = Math.min(audio.pcm.length, Math.ceil(end * audio.sampleRate))
  return { pcm: audio.pcm.slice(from, Math.max(from, to)), sampleRate: audio.sampleRate }
}

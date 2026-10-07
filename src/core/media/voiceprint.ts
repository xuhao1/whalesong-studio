// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Listening to what was synthesized, without ears: how loud a clip is, how
 * high the voice sits, how long it spoke. A generative speech model does not
 * always do what it was asked — a line can come back in another voice, cut
 * short, or much louder than its neighbours — and these few measurements are
 * what lets the pipeline notice, take the line again, and level what it keeps.
 *
 * Everything here is plain arithmetic on PCM samples; nothing is sent anywhere.
 */
import type { TakeIssue } from '../../shared/types'
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
  /** Median pitch in Hz, when enough of the clip is voiced to tell. */
  pitch?: number
  /** How much of the clip the pitch was read from, in seconds. */
  voiced: number
}

/** Pitch is searched between these, which covers children to deep basses. */
const PITCH_LOW = 60
const PITCH_HIGH = 420
/** Frames quieter than this are pauses, not speech (linear, full scale = 1). */
const SPEECH_FLOOR = 0.01
const ANALYSIS_RATE = 8000

/** Box-filtered decimation to about 8 kHz, as floats in -1…1: pitch needs no more, and the search gets nine times cheaper. */
function decimate(audio: PcmAudio): { samples: Float32Array; rate: number } {
  const factor = Math.max(1, Math.round(audio.sampleRate / ANALYSIS_RATE))
  const length = Math.floor(audio.pcm.length / factor)
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (let k = 0; k < factor; k++) sum += audio.pcm[i * factor + k]!
    samples[i] = sum / factor / 32768
  }
  return { samples, rate: audio.sampleRate / factor }
}

/** Measure a clip: level, pitch and how much of it is speech. */
export function measure(audio: PcmAudio): VoiceMeasure {
  const { samples, rate } = decimate(audio)
  const frame = Math.floor(rate * 0.04)
  const hop = Math.floor(rate * 0.01)
  const minLag = Math.max(2, Math.floor(rate / PITCH_HIGH))
  const maxLag = Math.min(frame - 2, Math.ceil(rate / PITCH_LOW))
  const pitches: number[] = []
  const correlation = new Float32Array(maxLag + 1)
  let speechFrames = 0
  let energy = 0
  for (let at = 0; at + frame <= samples.length; at += hop) {
    let sum = 0
    for (let i = 0; i < frame; i++) sum += samples[at + i]! * samples[at + i]!
    if (Math.sqrt(sum / frame) < SPEECH_FLOOR) continue
    speechFrames += 1
    energy += sum / frame
    let best = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0
      let left = 0
      let right = 0
      for (let i = 0; i + lag < frame; i++) {
        const a = samples[at + i]!
        const b = samples[at + i + lag]!
        cross += a * b
        left += a * a
        right += b * b
      }
      const value = cross / Math.sqrt(left * right + 1e-12)
      correlation[lag] = value
      if (value > best) best = value
    }
    if (best < 0.6) continue
    // A periodic signal correlates at every multiple of its period: the first strong peak is the period itself.
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      const value = correlation[lag]!
      if (value >= best * 0.88 && value >= correlation[lag - 1]! && value >= correlation[lag + 1]!) {
        // The peak lies between samples: fit a parabola through it and its neighbours.
        const before = correlation[lag - 1]!
        const after = correlation[lag + 1]!
        const shift = before - 2 * value + after !== 0 ? 0.5 * (before - after) / (before - 2 * value + after) : 0
        pitches.push(rate / (lag + shift))
        break
      }
    }
  }
  let peak = 0
  for (let i = 0; i < audio.pcm.length; i++) {
    const value = Math.abs(audio.pcm[i]!)
    if (value > peak) peak = value
  }
  pitches.sort((left, right) => left - right)
  const voiced = pitches.length * 0.01
  return {
    seconds: audio.pcm.length / audio.sampleRate,
    speech: speechFrames * 0.01,
    level: speechFrames > 0 ? 20 * Math.log10(Math.sqrt(energy / speechFrames) + 1e-9) : -120,
    peak: 20 * Math.log10(peak / 32768 + 1e-9),
    // A syllable or two says more about its tone than about the speaker.
    ...(voiced >= MIN_VOICED ? { pitch: pitches[Math.floor(pitches.length / 2)]! } : {}),
    voiced,
  }
}

/** Seconds of voiced sound a clip needs before its pitch says anything about who is speaking. */
export const MIN_VOICED = 0.25

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
  /** Pitch of this take over the pitch the voice is known by, when both could be read. */
  ratio?: number
  /** Syllables per second. */
  pace: number
}

/** A voice may sit this far from where it is known to sit before the take counts as someone else. */
const DRIFT_LOW = 0.74
const DRIFT_HIGH = 1.42

/**
 * Judge a take against what it should be: the whole line (not a fragment, not
 * a ramble), audible, and — where the voice's usual pitch is known and the
 * take is long enough to tell — in that voice.
 */
export function judge(measured: VoiceMeasure, text: string, print?: number): TakeVerdict {
  const units = speechUnits(text)
  const pace = measured.seconds > 0 ? units / measured.seconds : 0
  const issues: TakeIssue[] = []
  if (measured.speech < 0.08 || measured.level < -45) issues.push('silent')
  // Nobody speaks nine or ten syllables a second: most of the line is missing. The shorter the line the less its pace says, and a word or two cannot be told this way at all.
  else if (units >= 6 && pace > (units >= 10 ? 8.5 : 9.5)) issues.push('short')
  // A line that takes several times as long as its words was padded with something that was not asked for.
  else if (units >= 4 && measured.seconds > 4 && pace < 0.9) issues.push('long')
  const ratio = print !== undefined && print > 0 && measured.pitch !== undefined ? measured.pitch / print : undefined
  if (ratio !== undefined && (ratio < DRIFT_LOW || ratio > DRIFT_HIGH)) issues.push('drift')
  return { issues, ...(ratio !== undefined ? { ratio } : {}), pace }
}

/** How bad a verdict is; lower is better. A missing or cut line outweighs any drift in pitch. */
export function badness(verdict: TakeVerdict): number {
  let score = 0
  if (verdict.issues.includes('silent')) score += 100
  if (verdict.issues.includes('short')) score += 50
  if (verdict.issues.includes('long')) score += 20
  if (verdict.ratio !== undefined) score += Math.abs(Math.log2(verdict.ratio)) * 10
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

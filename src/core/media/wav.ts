// SPDX-License-Identifier: LGPL-3.0-or-later
/** PCM16 mono audio helpers: WAV parsing/encoding and simple assembly. */

export interface PcmAudio {
  /** Signed 16-bit little-endian mono samples. */
  pcm: Int16Array
  sampleRate: number
}

/**
 * Decode a PCM WAV file. Streaming encoders write placeholder sizes, so the
 * data chunk is taken to run to the end of the file when its size is bogus.
 * Stereo is mixed down; only 16-bit PCM is supported.
 */
export function parseWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let offset = 12
  let channels = 1
  let sampleRate = 24000
  let bits = 16
  let format = 1
  while (offset + 8 <= bytes.length) {
    const id = tag(offset)
    const declared = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(start, true)
      channels = view.getUint16(start + 2, true)
      sampleRate = view.getUint32(start + 4, true)
      bits = view.getUint16(start + 14, true)
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16) throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`)
      const available = bytes.length - start
      const size = declared === 0 || declared > available ? available : declared
      const frames = Math.floor(size / 2 / channels)
      const pcm = new Int16Array(frames)
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += view.getInt16(start + (i * channels + c) * 2, true)
        pcm[i] = Math.round(sum / channels)
      }
      return { pcm, sampleRate }
    }
    // Chunks are word-aligned.
    offset = start + declared + (declared % 2)
  }
  throw new Error('WAV file has no data chunk')
}

/** Encode PCM16 mono as a WAV file. */
export function encodeWav(audio: PcmAudio): Uint8Array {
  const dataSize = audio.pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, audio.sampleRate, true)
  view.setUint32(28, audio.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < audio.pcm.length; i++) view.setInt16(44 + i * 2, audio.pcm[i]!, true)
  return new Uint8Array(buffer)
}

/** Interpret raw little-endian PCM16 bytes. */
export function pcmFromBytes(bytes: Uint8Array, sampleRate: number): PcmAudio {
  const frames = Math.floor(bytes.length / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2)
  const pcm = new Int16Array(frames)
  for (let i = 0; i < frames; i++) pcm[i] = view.getInt16(i * 2, true)
  return { pcm, sampleRate }
}

export function durationOf(audio: PcmAudio): number {
  return audio.pcm.length / audio.sampleRate
}

/** Linear resample; good enough for speech when segments disagree on rate. */
export function resample(audio: PcmAudio, sampleRate: number): PcmAudio {
  if (audio.sampleRate === sampleRate) return audio
  const ratio = audio.sampleRate / sampleRate
  const length = Math.floor(audio.pcm.length / ratio)
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(audio.pcm.length - 1, left + 1)
    const mix = position - left
    pcm[i] = Math.round(audio.pcm[left]! * (1 - mix) + audio.pcm[right]! * mix)
  }
  return { pcm, sampleRate }
}

/** Trim leading/trailing near-silence, keeping a short pad so words are not clipped. */
export function trimSilence(audio: PcmAudio, threshold = 220, padSeconds = 0.06): PcmAudio {
  const { pcm, sampleRate } = audio
  let start = 0
  let end = pcm.length
  while (start < end && Math.abs(pcm[start]!) < threshold) start++
  while (end > start && Math.abs(pcm[end - 1]!) < threshold) end--
  const pad = Math.floor(padSeconds * sampleRate)
  start = Math.max(0, start - pad)
  end = Math.min(pcm.length, end + pad)
  return { pcm: pcm.slice(start, end), sampleRate }
}

/** Join segments with a gap of silence after each, at the first segment's rate. */
export function concatAudio(segments: { audio: PcmAudio; gapSeconds: number }[]): PcmAudio {
  const sampleRate = segments[0]?.audio.sampleRate ?? 24000
  const parts = segments.map(segment => ({ pcm: resample(segment.audio, sampleRate).pcm, gap: Math.floor(segment.gapSeconds * sampleRate) }))
  const total = parts.reduce((sum, part) => sum + part.pcm.length + part.gap, 0)
  const pcm = new Int16Array(total)
  let offset = 0
  for (const part of parts) {
    pcm.set(part.pcm, offset)
    offset += part.pcm.length + part.gap
  }
  return { pcm, sampleRate }
}

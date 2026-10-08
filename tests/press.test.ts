// SPDX-License-Identifier: LGPL-3.0-or-later
/** Sound made smaller for the way out of the book: at what rate, and — where ffmpeg is installed — what comes of it. */
import { describe, expect, it } from 'vitest'
import { findSoundPress, pressRate } from '../src/core/media/press'
import { encodeWav, wavFormat } from '../src/core/media/wav'
import { findProgram } from '../src/core/util/program'

/** A second of a voice-like tone at the rate the voices of a book are made at. */
function tone(seconds: number, sampleRate = 24000): Uint8Array {
  const pcm = new Int16Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate) + 4000 * Math.sin((2 * Math.PI * 1760 * i) / sampleRate))
  return encodeWav({ pcm, sampleRate })
}

describe('sound on the way out', () => {
  it('is given four bits for each sample of each channel, within what AAC is good at', () => {
    // A voice as the speech models make it: 24 kHz, one channel.
    expect(pressRate({ sampleRate: 24000, channels: 1 })).toBe(96_000)
    expect(pressRate({ sampleRate: 16000, channels: 1 })).toBe(64_000)
    expect(pressRate({ sampleRate: 8000, channels: 1 })).toBe(48_000)
    expect(pressRate({ sampleRate: 44100, channels: 1 })).toBe(128_000)
    expect(pressRate({ sampleRate: 48000, channels: 2 })).toBe(256_000)
    expect(pressRate({ sampleRate: 22050, channels: 2 })).toBe(176_000)
  })

  it('reads what a WAV file says of itself, and says of anything else that it is none', () => {
    expect(wavFormat(tone(0.1))).toEqual({ sampleRate: 24000, channels: 1 })
    expect(wavFormat(tone(0.1, 16000))).toEqual({ sampleRate: 16000, channels: 1 })
    expect(wavFormat(new Uint8Array([1, 2, 3]))).toBeUndefined()
    expect(wavFormat(new TextEncoder().encode('RIFF....WAVE — and then nothing a sound would have'))).toBeUndefined()
  })

  it('is AAC in an MP4 file from this computer\'s ffmpeg: a quarter the size, the same bytes each time, and no file from what is no sound', async (context) => {
    const press = await findSoundPress()
    // No ffmpeg on this computer: there is no press, and whoever asks is told so (`site.plan`, the publish dialog).
    if (press === undefined) {
      expect(await findProgram('ffmpeg')).toBeUndefined()
      context.skip()
      return
    }
    expect(press.ext).toBe('m4a')
    const wav = tone(3)
    const pressed = await press.press(wav)
    expect(Buffer.from(pressed.subarray(4, 12)).toString('latin1')).toBe('ftypM4A ')
    // 3 s at 24 kHz, 16 bits: 144 kB as it lies in the book; about 36 kB at 96 kbit/s.
    expect(wav.byteLength).toBe(144_044)
    expect(pressed.byteLength).toBeLessThan(wav.byteLength / 3)
    expect(pressed.byteLength).toBeGreaterThan(wav.byteLength / 12)
    expect(Buffer.from(await press.press(wav))).toEqual(Buffer.from(pressed))
    await expect(press.press(new TextEncoder().encode('not a sound at all'))).rejects.toThrow(/not a WAV file/)
    // A sound with nothing in it presses to a file that is no smaller — which a publication then leaves as it lies.
    expect((await press.press(wav.subarray(0, 44))).byteLength).toBeGreaterThan(44)
    // Told to stop, it stops.
    const stop = new AbortController()
    stop.abort()
    await expect(press.press(wav, stop.signal)).rejects.toThrow()
  })
})

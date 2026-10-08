// SPDX-License-Identifier: LGPL-3.0-or-later
/** Sound and pictures made smaller for the way out of the book: at what rate, which pictures, and — where ffmpeg is installed — what comes of it. */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { pngAlpha } from '../src/core/media/png'
import { findPicturePress, findSoundPress, pressRate } from '../src/core/media/press'
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

// ───────────────────────────── pictures ─────────────────────────────

const crcTable = Array.from({ length: 256 }, (_unused, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  let crc = 0xffffffff
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.byteLength)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([head, body, tail])
}

/**
 * A PNG file written by hand, so that what is read back is known.
 * @param kind - 0 grey, 2 colour, 3 palette, 4 grey with a see-through channel, 6 colour with one.
 * @param pixel - the bytes of the pixel at a place.
 * @param filter - how each row is written: 0 as it is, 1–4 as its difference from its neighbours.
 */
function png(options: { width: number; height: number; kind: 0 | 2 | 3 | 4 | 6; pixel: (x: number, y: number) => number[]; filter?: (row: number) => number; depth?: number; interlaced?: boolean; extra?: Buffer[] }): Uint8Array {
  const { width, height, kind, pixel } = options
  const each = kind === 0 || kind === 3 ? 1 : kind === 2 ? 3 : kind === 4 ? 2 : 4
  const stride = width * each
  const plain = Array.from({ length: height }, (_row, y) => Uint8Array.from(Array.from({ length: width }, (_pixel, x) => pixel(x, y)).flat()))
  const rows = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const filter = options.filter?.(y) ?? 0
    rows[y * (stride + 1)] = filter
    for (let at = 0; at < stride; at++) {
      const left = at >= each ? plain[y]![at - each]! : 0
      const up = y > 0 ? plain[y - 1]![at]! : 0
      const corner = y > 0 && at >= each ? plain[y - 1]![at - each]! : 0
      const guess = left + up - corner
      const paeth = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner) ? left : Math.abs(guess - up) <= Math.abs(guess - corner) ? up : corner
      const from = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth : 0
      rows[y * (stride + 1) + 1 + at] = (plain[y]![at]! - from) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = options.depth ?? 8
  header[9] = kind
  header[12] = options.interlaced === true ? 1 : 0
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), ...(options.extra ?? []), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0))]))
}

/** A picture with something in it: a slope of colour under grain, as a painted scene has. */
const painted = (x: number, y: number): number[] => [(x * 3 + ((x * 31 + y * 17) % 23)) & 0xff, (y * 3 + ((x * 13 + y * 29) % 19)) & 0xff, ((x + y) * 2 + ((x * 7 + y * 11) % 29)) & 0xff]

describe('a picture on the way out', () => {
  it('says whether it is see-through anywhere, whichever way its rows are written', async () => {
    // Plain colour and grey have no way to be.
    expect(await pngAlpha(png({ width: 9, height: 7, kind: 2, pixel: painted }))).toBe('none')
    expect(await pngAlpha(png({ width: 9, height: 7, kind: 0, pixel: x => [x * 20] }))).toBe('none')
    // A channel for it that says "solid" everywhere: opaque — under every way of writing a row, and all of them mixed.
    for (const filter of [0, 1, 2, 3, 4]) {
      expect(await pngAlpha(png({ width: 17, height: 11, kind: 6, pixel: (x, y) => [...painted(x, y), 255], filter: () => filter })), `filter ${filter}`).toBe('opaque')
      // One pixel of it a little see-through, in the last row: found.
      expect(await pngAlpha(png({ width: 17, height: 11, kind: 6, pixel: (x, y) => [...painted(x, y), x === 13 && y === 10 ? 254 : 255], filter: () => filter })), `filter ${filter}`).toBe('used')
    }
    expect(await pngAlpha(png({ width: 17, height: 11, kind: 6, pixel: (x, y) => [...painted(x, y), 255], filter: row => row % 5 }))).toBe('opaque')
    expect(await pngAlpha(png({ width: 17, height: 11, kind: 6, pixel: (x, y) => [...painted(x, y), x === 0 && y === 0 ? 0 : 255], filter: row => (row + 3) % 5 }))).toBe('used')
    // Grey with a channel, the same.
    expect(await pngAlpha(png({ width: 8, height: 8, kind: 4, pixel: (x, y) => [x * y, 255], filter: () => 4 }))).toBe('opaque')
    expect(await pngAlpha(png({ width: 8, height: 8, kind: 4, pixel: (x, y) => [x * y, y === 5 ? 128 : 255], filter: () => 3 }))).toBe('used')
    // A palette says how solid each entry is; plain colour can name one colour as see-through.
    expect(await pngAlpha(png({ width: 4, height: 4, kind: 3, pixel: x => [x], extra: [chunk('PLTE', new Uint8Array(12)), chunk('tRNS', Uint8Array.from([255, 255, 255, 255]))] }))).toBe('none')
    expect(await pngAlpha(png({ width: 4, height: 4, kind: 3, pixel: x => [x], extra: [chunk('PLTE', new Uint8Array(12)), chunk('tRNS', Uint8Array.from([255, 0]))] }))).toBe('used')
    expect(await pngAlpha(png({ width: 4, height: 4, kind: 2, pixel: painted, extra: [chunk('tRNS', new Uint8Array(6))] }))).toBe('used')
    // A channel in a form not gone through is not guessed at.
    expect(await pngAlpha(png({ width: 4, height: 4, kind: 6, depth: 16, pixel: (x, y) => [...painted(x, y), 255] }))).toBe('unknown')
    expect(await pngAlpha(png({ width: 4, height: 4, kind: 6, interlaced: true, pixel: (x, y) => [...painted(x, y), 255] }))).toBe('unknown')
    // What is no PNG file is said to be none: other bytes, a file cut short, rows that are not there.
    expect(await pngAlpha(new TextEncoder().encode('not a picture at all, however long it goes on'))).toBeUndefined()
    const whole = png({ width: 17, height: 11, kind: 6, pixel: (x, y) => [...painted(x, y), 255] })
    expect(await pngAlpha(whole.subarray(0, whole.byteLength - 40))).toBeUndefined()
    expect(await pngAlpha(new Uint8Array(Buffer.concat([Buffer.from(whole.subarray(0, 33)), chunk('IDAT', deflateSync(new Uint8Array(20))), chunk('IEND', new Uint8Array(0))])))).toBeUndefined()
  })

  it('is a JPEG from this computer\'s ffmpeg: much smaller, the same bytes each time, and none of a picture that is see-through', async (context) => {
    const press = await findPicturePress()
    // No ffmpeg on this computer: there is no press, and whoever asks is told so (`site.plan`, the publish dialog).
    if (press === undefined) {
      expect(await findProgram('ffmpeg')).toBeUndefined()
      context.skip()
      return
    }
    expect(press.ext).toBe('jpg')
    const scene = png({ width: 320, height: 200, kind: 2, pixel: painted, filter: () => 0 })
    const pressed = await press.press(scene)
    expect(pressed).toBeDefined()
    // A JPEG file from its first bytes to its last, and a fraction of what the picture weighs without loss.
    expect([pressed![0], pressed![1], pressed!.at(-2), pressed!.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9])
    expect(pressed!.byteLength).toBeLessThan(scene.byteLength / 2)
    expect(Buffer.from((await press.press(scene))!)).toEqual(Buffer.from(pressed!))
    // A channel that says "solid" everywhere is no reason to keep megabytes: pressed like any other.
    const solid = await press.press(png({ width: 320, height: 200, kind: 6, pixel: (x, y) => [...painted(x, y), 255], filter: () => 4 }))
    expect([solid?.[0], solid?.[1]]).toEqual([0xff, 0xd8])
    // See-through somewhere: a JPEG has no way to say so, and the picture is left to go as it is.
    expect(await press.press(png({ width: 64, height: 64, kind: 6, pixel: (x, y) => [...painted(x, y), x < 8 ? 0 : 255] }))).toBeUndefined()
    await expect(press.press(new TextEncoder().encode('not a picture at all, however long it goes on'))).rejects.toThrow(/not a PNG file/)
    // Told to stop, it stops.
    const stop = new AbortController()
    stop.abort()
    await expect(press.press(scene, stop.signal)).rejects.toThrow()
  })
})


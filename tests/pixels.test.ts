// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { pixelsOf } from '../src/core/media/pixels'
import { PIXEL } from './support/harness'

const ascii = (text: string): number[] => [...text].map(char => char.charCodeAt(0))
const be32 = (value: number): number[] => [value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255]
const be16 = (value: number): number[] => [value >>> 8 & 255, value & 255]
const le16 = (value: number): number[] => [value & 255, value >>> 8 & 255]
const le24 = (value: number): number[] => [value & 255, value >>> 8 & 255, value >>> 16 & 255]
const le32 = (value: number): number[] => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255]

describe('how large a picture is, read off its file', () => {
  it('reads a PNG', () => {
    expect(pixelsOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(1280), ...be32(720), 8, 2, 0, 0, 0]))).toEqual({ width: 1280, height: 720 })
    expect(pixelsOf(PIXEL)).toEqual({ width: 1, height: 1 })
  })

  it('reads a JPEG past the segments before its frame header, whichever kind of frame it is', () => {
    const head = [0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xdb, ...be16(5), 0, 1, 2]
    const frame = (marker: number): number[] => [0xff, marker, ...be16(17), 8, ...be16(832), ...be16(1248), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
    expect(pixelsOf(new Uint8Array([...head, ...frame(0xc0), 0xff, 0xda]))).toEqual({ width: 1248, height: 832 })
    // Progressive, and with a table of the kind whose marker sits among the frame headers before it.
    expect(pixelsOf(new Uint8Array([...head, 0xff, 0xc4, ...be16(4), 0, 0, ...frame(0xc2), 0xff, 0xda]))).toEqual({ width: 1248, height: 832 })
    // No frame header before the picture's data: nothing to say.
    expect(pixelsOf(new Uint8Array([...head, 0xff, 0xda, ...be16(8), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined()
  })

  it('reads each of the three kinds of WebP', () => {
    const riff = (kind: string, body: number[]): Uint8Array => new Uint8Array([...ascii('RIFF'), ...le32(4 + 8 + body.length), ...ascii('WEBP'), ...ascii(kind), ...le32(body.length), ...body])
    expect(pixelsOf(riff('VP8X', [0, 0, 0, 0, ...le24(501 - 1), ...le24(282 - 1)]))).toEqual({ width: 501, height: 282 })
    expect(pixelsOf(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(360), 0, 0]))).toEqual({ width: 640, height: 360 })
    expect(pixelsOf(riff('VP8L', [0x2f, ...le32((333 - 1) | (187 - 1) << 14), 0, 0, 0, 0, 0]))).toEqual({ width: 333, height: 187 })
  })

  it('says nothing of what is no picture it knows', () => {
    expect(pixelsOf(new Uint8Array([1, 2, 3]))).toBeUndefined()
    expect(pixelsOf(new Uint8Array(64))).toBeUndefined()
    expect(pixelsOf(new TextEncoder().encode('GIF89a' + 'x'.repeat(40)))).toBeUndefined()
  })
})

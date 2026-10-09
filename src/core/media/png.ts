// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a PNG file says of itself, read without drawing it: above all whether
 * anything of it is see-through — which decides whether it can go out as a
 * JPEG, a format in which every picture is opaque.
 */
import { promisify } from 'node:util'
import { deflate, inflate } from 'node:zlib'

const inflated = promisify(inflate)
const deflated = promisify(deflate)

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Pixels above which a picture's see-through channel is not gone through: it is then taken to be in use. */
const LARGEST = 64_000_000

/**
 * Whether a PNG picture is see-through anywhere.
 *
 *   - `none`    it has no way to be: plain colour, or grey, or a palette whose every entry is opaque
 *   - `opaque`  it carries a channel for it, and every pixel of that channel says "solid"
 *   - `used`    some of it is see-through
 *   - `unknown` it carries the channel in a form not gone through here (sixteen bits, interlaced, very large)
 *
 * @returns nothing for bytes that are no PNG file.
 */
export async function pngAlpha(bytes: Uint8Array): Promise<'none' | 'opaque' | 'used' | 'unknown' | undefined> {
  if (bytes.byteLength < 33 || SIGNATURE.some((value, at) => bytes[at] !== value)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let depth = 0
  let kind = -1
  let interlaced = false
  let keyed = false
  const data: Uint8Array[] = []
  for (let at = 8; at + 12 <= bytes.byteLength;) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const from = at + 8
    if (from + length > bytes.byteLength) return undefined
    if (type === 'IHDR' && length >= 13) {
      width = view.getUint32(from)
      height = view.getUint32(from + 4)
      depth = bytes[from + 8]!
      kind = bytes[from + 9]!
      interlaced = bytes[from + 12] !== 0
    } else if (type === 'tRNS') {
      // A palette says how solid each of its entries is; plain colour and grey name one colour that is see-through.
      keyed = kind === 3 ? bytes.subarray(from, from + length).some(value => value !== 255) : true
    } else if (type === 'IDAT') {
      data.push(bytes.subarray(from, from + length))
    } else if (type === 'IEND') {
      break
    }
    at = from + length + 4
  }
  if (kind < 0 || width === 0 || height === 0) return undefined
  if (kind === 0 || kind === 2 || kind === 3) return keyed ? 'used' : 'none'
  if (kind !== 4 && kind !== 6) return undefined
  if (depth !== 8 || interlaced || width * height > LARGEST) return 'unknown'
  // Grey with a channel is two bytes a pixel, colour with one four; the channel is the last of them.
  const each = kind === 4 ? 2 : 4
  const stride = width * each
  let rows: Uint8Array
  try {
    rows = await inflated(Buffer.concat(data))
  } catch {
    return undefined
  }
  if (rows.byteLength < (stride + 1) * height) return undefined
  // Each row is written as its difference from what is left of and above it: undone row by row, in place.
  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1)
    const filter = rows[start]!
    const here = start + 1
    const above = here - (stride + 1)
    for (let at = 0; at < stride; at++) {
      const left = at >= each ? rows[here + at - each]! : 0
      const up = row > 0 ? rows[above + at]! : 0
      let add = 0
      if (filter === 1) add = left
      else if (filter === 2) add = up
      else if (filter === 3) add = (left + up) >> 1
      else if (filter === 4) {
        const corner = row > 0 && at >= each ? rows[above + at - each]! : 0
        const guess = left + up - corner
        const byLeft = Math.abs(guess - left)
        const byUp = Math.abs(guess - up)
        const byCorner = Math.abs(guess - corner)
        add = byLeft <= byUp && byLeft <= byCorner ? left : byUp <= byCorner ? up : corner
      } else if (filter !== 0) return undefined
      if (add !== 0) rows[here + at] = (rows[here + at]! + add) & 0xff
    }
    for (let at = each - 1; at < stride; at += each) if (rows[here + at] !== 255) return 'used'
  }
  return 'opaque'
}

// ───────────────────────────── a picture's pixels, and a part of it cut out ─────────────────────────────

/** A PNG picture taken apart: its rows as they are (one byte to say how each is written, then its pixels), and what its pixels are made of. */
export interface PngPixels {
  width: number
  height: number
  /** How a pixel is made up, as the file says: 0 grey, 2 colour, 3 a palette entry, 4 grey with a channel, 6 colour with one. */
  kind: 0 | 2 | 3 | 4 | 6
  /** Bytes to a pixel. */
  each: number
  /** The pixels, row by row, each row's differences undone: `height` rows of `width × each` bytes. */
  pixels: Uint8Array
  /** The palette (three bytes an entry) and how solid its entries are, for a picture that has one: written back as they were. */
  palette?: Uint8Array
  solid?: Uint8Array
}

/**
 * The pixels of a PNG picture — eight bits a sample, written row after row (what image models hand back).
 * @returns nothing for bytes that are no such picture: no PNG, sixteen bits, interlaced, too large to go through.
 */
export async function readPng(bytes: Uint8Array): Promise<PngPixels | undefined> {
  if (bytes.byteLength < 33 || SIGNATURE.some((value, at) => bytes[at] !== value)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let depth = 0
  let kind = -1
  let interlaced = false
  let palette: Uint8Array | undefined
  let solid: Uint8Array | undefined
  const data: Uint8Array[] = []
  for (let at = 8; at + 12 <= bytes.byteLength;) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    const from = at + 8
    if (from + length > bytes.byteLength) return undefined
    if (type === 'IHDR' && length >= 13) {
      width = view.getUint32(from)
      height = view.getUint32(from + 4)
      depth = bytes[from + 8]!
      kind = bytes[from + 9]!
      interlaced = bytes[from + 12] !== 0
    } else if (type === 'PLTE') palette = bytes.slice(from, from + length)
    else if (type === 'tRNS') solid = bytes.slice(from, from + length)
    else if (type === 'IDAT') data.push(bytes.subarray(from, from + length))
    else if (type === 'IEND') break
    at = from + length + 4
  }
  if (![0, 2, 3, 4, 6].includes(kind) || width === 0 || height === 0 || depth !== 8 || interlaced || width * height > LARGEST) return undefined
  if (kind === 3 && palette === undefined) return undefined
  const each = kind === 0 || kind === 3 ? 1 : kind === 4 ? 2 : kind === 2 ? 3 : 4
  const stride = width * each
  let rows: Uint8Array
  try {
    rows = await inflated(Buffer.concat(data))
  } catch {
    return undefined
  }
  if (rows.byteLength < (stride + 1) * height) return undefined
  const pixels = new Uint8Array(stride * height)
  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1)
    const filter = rows[start]!
    if (filter > 4) return undefined
    const here = start + 1
    const out = row * stride
    for (let at = 0; at < stride; at++) {
      const left = at >= each ? pixels[out + at - each]! : 0
      const up = row > 0 ? pixels[out - stride + at]! : 0
      let add = 0
      if (filter === 1) add = left
      else if (filter === 2) add = up
      else if (filter === 3) add = (left + up) >> 1
      else if (filter === 4) {
        const corner = row > 0 && at >= each ? pixels[out - stride + at - each]! : 0
        const guess = left + up - corner
        const byLeft = Math.abs(guess - left)
        const byUp = Math.abs(guess - up)
        const byCorner = Math.abs(guess - corner)
        add = byLeft <= byUp && byLeft <= byCorner ? left : byUp <= byCorner ? up : corner
      }
      pixels[out + at] = (rows[here + at]! + add) & 0xff
    }
  }
  return { width, height, kind: kind as PngPixels['kind'], each, pixels, ...(palette !== undefined ? { palette } : {}), ...(solid !== undefined ? { solid } : {}) }
}

const CRC = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.byteLength)
  for (let at = 0; at < 4; at++) out[4 + at] = type.charCodeAt(at)
  out.set(body, 8)
  let crc = 0xffffffff
  for (let at = 4; at < 8 + body.byteLength; at++) crc = CRC[(crc ^ out[at]!) & 0xff]! ^ (crc >>> 8)
  view.setUint32(8 + body.byteLength, (crc ^ 0xffffffff) >>> 0)
  return out
}

/**
 * A part of a picture, as a PNG file of its own: so many columns from `left`, so many rows from `top`.
 * (What lies outside the picture is left off the part.)
 */
export async function cutPng(image: PngPixels, part: { left: number; top: number; width: number; height: number }): Promise<Uint8Array> {
  const left = Math.max(0, Math.min(image.width - 1, Math.floor(part.left)))
  const top = Math.max(0, Math.min(image.height - 1, Math.floor(part.top)))
  const width = Math.max(1, Math.min(image.width - left, Math.floor(part.width)))
  const height = Math.max(1, Math.min(image.height - top, Math.floor(part.height)))
  const stride = width * image.each
  const rows = new Uint8Array((stride + 1) * height)
  for (let row = 0; row < height; row++) {
    const from = ((top + row) * image.width + left) * image.each
    // Each row written as it is: the packing after it does the rest.
    rows.set(image.pixels.subarray(from, from + stride), row * (stride + 1) + 1)
  }
  const head = new Uint8Array(13)
  const view = new DataView(head.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  head[8] = 8
  head[9] = image.kind
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', head),
    ...(image.kind === 3 && image.palette !== undefined ? [chunk('PLTE', image.palette)] : []),
    ...(image.solid !== undefined ? [chunk('tRNS', image.solid)] : []),
    chunk('IDAT', await deflated(rows)),
    chunk('IEND', new Uint8Array(0)),
  ]
  return new Uint8Array(Buffer.concat(parts))
}

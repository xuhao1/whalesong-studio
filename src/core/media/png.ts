// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a PNG file says of itself, read without drawing it: above all whether
 * anything of it is see-through — which decides whether it can go out as a
 * JPEG, a format in which every picture is opaque.
 */
import { promisify } from 'node:util'
import { inflate } from 'node:zlib'

const inflated = promisify(inflate)

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

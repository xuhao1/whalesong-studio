// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * How large a picture is, read off the head of its file without drawing it:
 * a picture changed in one thing is asked for in the frame of the picture it
 * comes from, and what was *asked* of that one is not always what came back
 * (a service draws the nearest size it has) — nor always on record.
 */

/**
 * The width and height of a PNG, JPEG or WebP picture, in pixels.
 * @returns nothing for bytes that are none of these, or whose head says nothing usable.
 */
export function pixelsOf(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sized = (width: number, height: number): { width: number; height: number } | undefined => (width > 0 && height > 0 ? { width, height } : undefined)
  // PNG: the signature, then IHDR — width and height first in it.
  if (bytes.byteLength >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) return sized(view.getUint32(16), view.getUint32(20))
  // JPEG: segments, each with its length; the frame header (SOF0…SOF15, but for the three that are no frame) says it.
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.byteLength) {
      if (bytes[at] !== 0xff) { at += 1; continue }
      const marker = bytes[at + 1]!
      // Padding, and markers that stand alone.
      if (marker === 0xff) { at += 1; continue }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized(view.getUint16(at + 7), view.getUint16(at + 5))
      // The picture's data begins: no frame header came before it.
      if (marker === 0xda || marker === 0xd9) return undefined
      at += 2 + view.getUint16(at + 2)
    }
    return undefined
  }
  // WebP: RIFF….WEBP, then one of three kinds of first chunk.
  if (bytes.byteLength >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const kind = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
    if (kind === 'VP8X') return sized(1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16), 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16))
    if (kind === 'VP8 ') return sized(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      return sized(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff))
    }
  }
  return undefined
}

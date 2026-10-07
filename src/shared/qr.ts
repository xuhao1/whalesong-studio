// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A QR code for a short piece of text — the address of the reader, so a phone
 * can open it by pointing its camera at the screen. Byte mode, error
 * correction level M, versions 1 to 10 (up to 213 bytes), which is plenty for
 * an address and keeps this to one small file instead of a dependency.
 *
 * Follows ISO/IEC 18004: encode, add Reed-Solomon error correction, interleave,
 * lay out around the function patterns, and pick the mask with the lowest
 * penalty.
 */

/** Per version at level M: total codewords, error-correction codewords per block, and the blocks as [count, data codewords]. */
const VERSIONS: { total: number; ec: number; blocks: [number, number][] }[] = [
  { total: 26, ec: 10, blocks: [[1, 16]] },
  { total: 44, ec: 16, blocks: [[1, 28]] },
  { total: 70, ec: 26, blocks: [[1, 44]] },
  { total: 100, ec: 18, blocks: [[2, 32]] },
  { total: 134, ec: 24, blocks: [[2, 43]] },
  { total: 172, ec: 16, blocks: [[4, 27]] },
  { total: 196, ec: 18, blocks: [[4, 31]] },
  { total: 242, ec: 22, blocks: [[2, 38], [2, 39]] },
  { total: 292, ec: 22, blocks: [[3, 36], [2, 37]] },
  { total: 346, ec: 26, blocks: [[4, 43], [1, 44]] },
]

/** Centres of the alignment patterns, per version. */
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

// Arithmetic in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let value = 1
  for (let power = 0; power < 255; power++) {
    EXP[power] = value
    LOG[value] = power
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let power = 255; power < 512; power++) EXP[power] = EXP[power - 255]!
}

const multiply = (left: number, right: number): number => (left === 0 || right === 0 ? 0 : EXP[LOG[left]! + LOG[right]!]!)

/** The Reed-Solomon error-correction codewords of one block. */
function errorCorrection(data: readonly number[], count: number): number[] {
  // The generator polynomial (x - 2^0)(x - 2^1)…(x - 2^(count-1)), highest power first, without its leading 1.
  const generator = new Array<number>(count).fill(0)
  generator[count - 1] = 1
  let root = 1
  for (let round = 0; round < count; round++) {
    for (let index = 0; index < count; index++) {
      generator[index] = multiply(generator[index]!, root)
      if (index + 1 < count) generator[index] = generator[index]! ^ generator[index + 1]!
    }
    root = multiply(root, 2)
  }
  const remainder = new Array<number>(count).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!
    remainder.push(0)
    for (let index = 0; index < count; index++) remainder[index] = remainder[index]! ^ multiply(generator[index]!, factor)
  }
  return remainder
}

/** The 15-bit format word for level M and a mask: 5 data bits, 10 bits of BCH, masked. */
function formatBits(mask: number): number {
  // Level M is written as 00.
  const data = mask
  let remainder = data
  for (let round = 0; round < 10; round++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  return ((data << 10) | remainder) ^ 0x5412
}

/** The 18-bit version word carried by versions 7 and up. */
function versionBits(version: number): number {
  let remainder = version
  for (let round = 0; round < 12; round++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  return (version << 12) | remainder
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
]

/** How hard a symbol is to read, by the standard's four rules; the mask with the least wins. */
function penalty(modules: boolean[][]): number {
  const size = modules.length
  let score = 0
  // Runs of five or more of one colour, along rows and along columns.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1
      for (let b = 1; b <= size; b++) {
        const same = b < size && (pass === 0 ? modules[a]![b] === modules[a]![b - 1] : modules[b]![a] === modules[b - 1]![a])
        if (same) run += 1
        else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
    }
  }
  // Two-by-two blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = modules[y]![x]
      if (colour === modules[y]![x + 1] && colour === modules[y + 1]![x] && colour === modules[y + 1]![x + 1]) score += 3
    }
  }
  // Anything that looks like a finder pattern with quiet beside it.
  const lookalikes = [[true, false, true, true, true, false, true, false, false, false, false], [false, false, false, false, true, false, true, true, true, false, true]]
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      for (const pattern of lookalikes) {
        let row = true
        let column = true
        for (let k = 0; k < 11; k++) {
          if (modules[a]![b + k] !== pattern[k]) row = false
          if (modules[b + k]![a] !== pattern[k]) column = false
        }
        if (row) score += 40
        if (column) score += 40
      }
    }
  }
  // How far the share of dark modules is from one half.
  let dark = 0
  for (const row of modules) for (const cell of row) if (cell) dark += 1
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  return score
}

/**
 * Encode text as a QR symbol.
 * @returns the modules, `true` for dark, row by row — without the quiet zone the symbol needs around it.
 * @throws when the text is longer than 213 bytes of UTF-8.
 */
export function qrCode(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  const version = VERSIONS.findIndex((spec, index) => {
    const capacity = spec.blocks.reduce((sum, [count, data]) => sum + count * data, 0)
    // Mode (4 bits), length (8 bits, 16 from version 10), then the bytes.
    return bytes.length * 8 + 4 + (index + 1 >= 10 ? 16 : 8) <= capacity * 8
  }) + 1
  if (version === 0) throw new Error('the text is too long for a QR code of this kind')
  const spec = VERSIONS[version - 1]!
  const capacity = spec.blocks.reduce((sum, [count, data]) => sum + count * data, 0)

  // ── the bit stream ──
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let bit = length - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version >= 10 ? 16 : 8)
  for (const byte of bytes) push(byte, 8)
  push(0, Math.min(4, capacity * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const data: number[] = []
  for (let at = 0; at < bits.length; at += 8) data.push(bits.slice(at, at + 8).reduce((sum, bit) => (sum << 1) | bit, 0))
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad)

  // ── error correction, block by block, then interleaved ──
  const blocks: { data: number[]; ec: number[] }[] = []
  let offset = 0
  for (const [count, length] of spec.blocks) {
    for (let block = 0; block < count; block++) {
      const part = data.slice(offset, offset + length)
      offset += length
      blocks.push({ data: part, ec: errorCorrection(part, spec.ec) })
    }
  }
  const codewords: number[] = []
  const longest = Math.max(...blocks.map(block => block.data.length))
  for (let index = 0; index < longest; index++) for (const block of blocks) if (index < block.data.length) codewords.push(block.data[index]!)
  for (let index = 0; index < spec.ec; index++) for (const block of blocks) codewords.push(block.ec[index]!)

  // ── the function patterns ──
  const size = 17 + 4 * version
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    modules[y]![x] = dark
    reserved[y]![x] = true
  }
  // Finder patterns with their separators, in three corners.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy))
        set(cx + dx, cy + dy, ring !== 2 && ring !== 4)
      }
    }
  }
  // Alignment patterns, wherever one does not run into a finder pattern.
  const centres = ALIGNMENT[version - 1]!
  for (const cy of centres) {
    for (const cx of centres) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
  // Timing patterns.
  for (let at = 8; at < size - 8; at++) {
    if (!reserved[6]![at]) set(at, 6, at % 2 === 0)
    if (!reserved[at]![6]) set(6, at, at % 2 === 0)
  }
  // Room for the format word (written once the mask is chosen), and the module that is always dark.
  const format = (word: number): void => {
    const bit = (index: number): boolean => ((word >>> index) & 1) === 1
    for (let index = 0; index <= 5; index++) set(8, index, bit(index))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let index = 9; index < 15; index++) set(14 - index, 8, bit(index))
    for (let index = 0; index < 8; index++) set(size - 1 - index, 8, bit(index))
    for (let index = 8; index < 15; index++) set(8, size - 15 + index, bit(index))
    set(8, size - 8, true)
  }
  format(0)
  if (version >= 7) {
    const word = versionBits(version)
    for (let index = 0; index < 18; index++) {
      const dark = ((word >>> index) & 1) === 1
      const a = size - 11 + (index % 3)
      const b = Math.floor(index / 3)
      set(a, b, dark)
      set(b, a, dark)
    }
  }

  // ── the data, in a zigzag from the bottom right ──
  let placed = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      for (let side = 0; side < 2; side++) {
        const x = right - side
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - step : step
        if (reserved[y]![x]) continue
        // Whatever is left over after the last codeword stays light.
        modules[y]![x] = placed < codewords.length * 8 && ((codewords[placed >>> 3]! >>> (7 - (placed & 7))) & 1) === 1
        placed += 1
      }
    }
  }

  // ── the mask that reads best ──
  let best: boolean[][] | undefined
  let least = Infinity
  for (let mask = 0; mask < MASKS.length; mask++) {
    const candidate = modules.map((row, y) => row.map((cell, x) => (reserved[y]![x] ? cell : cell !== MASKS[mask]!(x, y))))
    const word = formatBits(mask)
    const bit = (index: number): boolean => ((word >>> index) & 1) === 1
    for (let index = 0; index <= 5; index++) candidate[index]![8] = bit(index)
    candidate[7]![8] = bit(6)
    candidate[8]![8] = bit(7)
    candidate[8]![7] = bit(8)
    for (let index = 9; index < 15; index++) candidate[8]![14 - index] = bit(index)
    for (let index = 0; index < 8; index++) candidate[8]![size - 1 - index] = bit(index)
    for (let index = 8; index < 15; index++) candidate[size - 15 + index]![8] = bit(index)
    const score = penalty(candidate)
    if (score < least) {
      least = score
      best = candidate
    }
  }
  return best!
}

/** The symbol as the path data of an SVG whose view box is `0 0 n n`, with `n` its size plus a quiet zone of four on every side. */
export function qrPath(text: string): { path: string; size: number } {
  const modules = qrCode(text)
  const quiet = 4
  let path = ''
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`
    })
  })
  return { path, size: modules.length + quiet * 2 }
}

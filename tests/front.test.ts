// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { firstFigure, frontView } from '../src/core/media/front'
import { pixelsOf } from '../src/core/media/pixels'
import { cutPng, readPng, type PngPixels } from '../src/core/media/png'
import { asPng } from '../src/core/media/press'
import { findProgram } from '../src/core/util/program'

/** A sheet as an image model draws one: a plain ground, and figures — here blocks of a darker colour — side by side on it. */
export function sheetOf(width: number, height: number, figures: readonly { from: number; to: number; colour?: [number, number, number] }[], extra?: (set: (x: number, y: number, colour: [number, number, number]) => void) => void): PngPixels {
  const pixels = new Uint8Array(width * height * 3)
  const set = (x: number, y: number, colour: [number, number, number]): void => { pixels.set(colour, (y * width + x) * 3) }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, [238 + (x + y) % 5, 232 + (x * 3 + y) % 4, 220])
  for (const figure of figures) {
    for (let y = Math.round(height * 0.08); y < Math.round(height * 0.95); y++) for (let x = figure.from; x < figure.to; x++) set(x, y, figure.colour ?? [70, 90, 96])
  }
  extra?.(set)
  return { width, height, kind: 2, each: 3, pixels }
}

const whole = (image: PngPixels): { left: number; top: number; width: number; height: number } => ({ left: 0, top: 0, width: image.width, height: image.height })

describe('a picture\'s pixels, and a part of it', () => {
  it('writes a part of a picture as a picture of its own, and reads it back as it was', async () => {
    const image = sheetOf(120, 100, [{ from: 10, to: 40 }, { from: 50, to: 80 }])
    const again = await readPng(await cutPng(image, whole(image)))
    expect(again).toMatchObject({ width: 120, height: 100, kind: 2, each: 3 })
    expect(Buffer.from(again!.pixels).equals(Buffer.from(image.pixels))).toBe(true)
    const part = await cutPng(image, { left: 8, top: 5, width: 36, height: 90 })
    expect(pixelsOf(part)).toEqual({ width: 36, height: 90 })
    const cut = (await readPng(part))!
    // Its first pixel is the picture's at (8, 5); its last the picture's at (43, 94).
    expect([...cut.pixels.subarray(0, 3)]).toEqual([...image.pixels.subarray((5 * 120 + 8) * 3, (5 * 120 + 8) * 3 + 3)])
    expect([...cut.pixels.subarray(cut.pixels.length - 3)]).toEqual([...image.pixels.subarray((94 * 120 + 43) * 3, (94 * 120 + 43) * 3 + 3)])
    // What lies outside the picture is left off the part.
    expect(pixelsOf(await cutPng(image, { left: 100, top: 90, width: 50, height: 50 }))).toEqual({ width: 20, height: 10 })
  })

  it('keeps a palette, grey and a see-through channel as the file has them', async () => {
    const palette: PngPixels = { width: 4, height: 2, kind: 3, each: 1, pixels: new Uint8Array([0, 1, 2, 1, 2, 2, 0, 1]), palette: new Uint8Array([255, 255, 255, 10, 20, 30, 200, 0, 0]), solid: new Uint8Array([255, 128]) }
    expect(await readPng(await cutPng(palette, { left: 1, top: 0, width: 3, height: 2 }))).toEqual({ width: 3, height: 2, kind: 3, each: 1, pixels: new Uint8Array([1, 2, 1, 2, 0, 1]), palette: palette.palette, solid: palette.solid })
    const grey: PngPixels = { width: 2, height: 2, kind: 4, each: 2, pixels: new Uint8Array([10, 255, 20, 128, 30, 0, 40, 255]) }
    expect((await readPng(await cutPng(grey, whole(grey))))!.pixels).toEqual(grey.pixels)
    expect(await readPng(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it('reads what a real encoder writes — rows written as differences, each its own way', async () => {
    if (await findProgram('ffmpeg') === undefined) return
    const image = sheetOf(160, 120, [{ from: 20, to: 60 }, { from: 90, to: 130, colour: [150, 40, 40] }])
    // Through ffmpeg and back: its PNG encoder picks a way of writing each row.
    const through = await asPng(await cutPng(image, whole(image)))
    expect(through).toBeDefined()
    const again = (await readPng(through!))!
    expect(again).toMatchObject({ width: 160, height: 120, kind: 2 })
    expect(Buffer.from(again.pixels).equals(Buffer.from(image.pixels))).toBe(true)
  })
})

describe('the front view of a design sheet', () => {
  it('finds the first of the figures that stand side by side on a plain ground', () => {
    // Three, as asked for: front, side, back.
    const three = firstFigure(sheetOf(900, 600, [{ from: 80, to: 260 }, { from: 380, to: 520 }, { from: 640, to: 820 }]))!
    expect(three.left).toBeGreaterThan(20)
    expect(three.left).toBeLessThanOrEqual(80)
    expect(three.left + three.width).toBeGreaterThanOrEqual(260)
    expect(three.left + three.width).toBeLessThan(380)
    // Four, as some models draw them; unevenly set.
    const four = firstFigure(sheetOf(1200, 600, [{ from: 30, to: 200 }, { from: 300, to: 420 }, { from: 560, to: 700 }, { from: 900, to: 1100 }]))!
    expect(four.left).toBe(0)
    expect(four.left + four.width).toBeGreaterThanOrEqual(200)
    expect(four.left + four.width).toBeLessThan(300)
  })

  it('is not put off by a line of floor, a shadow, or something small on the ground between two figures', () => {
    const sheet = sheetOf(900, 600, [{ from: 80, to: 260 }, { from: 380, to: 520 }, { from: 640, to: 820 }], (set) => {
      // A floor line right across, a shadow under the first figure reaching toward the second, and a speck.
      for (let x = 0; x < 900; x++) for (let y = 570; y < 576; y++) set(x, y, [120, 120, 120])
      for (let x = 260; x < 330; x++) for (let y = 560; y < 570; y++) set(x, y, [150, 150, 150])
      for (let x = 300; x < 306; x++) for (let y = 300; y < 306; y++) set(x, y, [20, 20, 20])
    })
    const found = firstFigure(sheet)!
    expect(found.left + found.width).toBeGreaterThanOrEqual(260)
    expect(found.left + found.width).toBeLessThan(380)
    // A gap inside a figure — between an arm and a side — does not part it.
    const armed = firstFigure(sheetOf(900, 600, [{ from: 80, to: 120 }, { from: 126, to: 260 }, { from: 380, to: 520 }, { from: 640, to: 820 }]))!
    expect(armed.left).toBeLessThanOrEqual(80)
    expect(armed.left + armed.width).toBeGreaterThanOrEqual(260)
  })

  it('cuts nothing where a picture does not part into figures', () => {
    // One figure: there is nothing to tell it from.
    expect(firstFigure(sheetOf(900, 600, [{ from: 300, to: 600 }]))).toBeUndefined()
    // Figures that touch.
    expect(firstFigure(sheetOf(900, 600, [{ from: 80, to: 300 }, { from: 300, to: 520 }, { from: 520, to: 820 }]))).toBeUndefined()
    // A picture busy all over: no ground.
    const busy = sheetOf(300, 200, [])
    for (let at = 0; at < busy.pixels.length; at++) busy.pixels[at] = (at * 7919) % 251
    expect(firstFigure(busy)).toBeUndefined()
    // A first "figure" that takes most of the sheet is no figure of three.
    expect(firstFigure(sheetOf(900, 600, [{ from: 20, to: 620 }, { from: 700, to: 860 }]))).toBeUndefined()
    // Too small to be a sheet.
    expect(firstFigure(sheetOf(60, 60, [{ from: 5, to: 20 }, { from: 30, to: 50 }]))).toBeUndefined()
  })

  it('hands back the front view as a picture of the sheet\'s full height, and nothing for what is no sheet', async () => {
    const sheet = sheetOf(900, 600, [{ from: 80, to: 260 }, { from: 380, to: 520 }, { from: 640, to: 820 }])
    const front = (await frontView(await cutPng(sheet, whole(sheet))))!
    const size = pixelsOf(front)!
    expect(size.height).toBe(600)
    expect(size.width).toBeGreaterThanOrEqual(180)
    expect(size.width).toBeLessThan(320)
    // The figure is in it whole, and the next one is not: its last column is ground.
    const cut = (await readPng(front))!
    expect(cut.pixels[(300 * cut.width + cut.width - 1) * 3]).toBeGreaterThan(200)
    expect(await frontView(new Uint8Array([0x89, 0x50, 1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined()
    const lone = sheetOf(900, 600, [{ from: 300, to: 600 }])
    expect(await frontView(await cutPng(lone, whole(lone)))).toBeUndefined()
  })
})

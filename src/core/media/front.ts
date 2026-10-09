// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The front view of a design sheet, cut out of it.
 *
 * A sheet shows one person three times over — front, side, back — and it is
 * what every later picture of them is held against. Handed the whole sheet,
 * an image model does what it does with any picture that goes along: it draws
 * what the picture shows, three figures side by side, whatever the words say
 * of it (told three ways that a sheet is one person, the model the Studio is
 * tried on drew three every time). So what goes along with a portrait, a
 * scene, a panel is the sheet's first figure alone: the same face, hair, build
 * and clothes, and one of them.
 *
 * Found by looking, not by measure: the ground of a sheet is plain, and
 * between two figures there are columns of it. Where a picture does not part
 * that way — one figure, figures that touch, a busy ground — nothing is cut,
 * and the sheet goes as it is.
 */
import { asPng } from './press'
import { cutPng, readPng, type PngPixels } from './png'

/** One pixel's colour, whatever the file makes its pixels of. */
function colourAt(image: PngPixels, at: number): [number, number, number] {
  const { pixels, each, kind } = image
  const from = at * each
  if (kind === 2 || kind === 6) return [pixels[from]!, pixels[from + 1]!, pixels[from + 2]!]
  if (kind === 3) {
    const entry = pixels[from]! * 3
    return [image.palette![entry] ?? 0, image.palette![entry + 1] ?? 0, image.palette![entry + 2] ?? 0]
  }
  return [pixels[from]!, pixels[from]!, pixels[from]!]
}

/** How far a colour may lie from the ground's and still be ground: a sheet's paper has grain, and its light falls off toward the edges. */
const NEAR = 30

/**
 * Where the first figure of a picture stands, if the picture is figures side by side on a plain ground: the columns
 * it takes, with some of the ground on either side.
 * @returns nothing where the picture does not part into figures — fewer than two are found, or the first is too wide or too narrow to be one.
 */
export function firstFigure(image: PngPixels): { left: number; width: number } | undefined {
  const { width, height } = image
  if (width < 96 || height < 96) return undefined
  // The ground: the colour the edge of the picture mostly is — figures stand inside it — or, where the edge is
  // something of its own (a border, a darkened rim), the colour most of the picture is. (Counted coarsely.)
  const commonest = (inEdge: boolean): readonly [number, number, number] | undefined => {
    const seen = new Map<number, { n: number; r: number; g: number; b: number }>()
    const band = { x: Math.max(2, Math.round(width * 0.03)), y: Math.max(2, Math.round(height * 0.04)) }
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        if (inEdge && y >= band.y && x >= band.x && x < width - band.x) continue
        const [r, g, b] = colourAt(image, y * width + x)
        const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4)
        const bin = seen.get(key)
        if (bin === undefined) seen.set(key, { n: 1, r, g, b })
        else { bin.n += 1; bin.r += r; bin.g += g; bin.b += b }
      }
    }
    let most: { n: number; r: number; g: number; b: number } | undefined
    for (const bin of seen.values()) if (most === undefined || bin.n > most.n) most = bin
    return most === undefined ? undefined : [most.r / most.n, most.g / most.n, most.b / most.n]
  }
  // How much of each column is not ground. A figure fills a good part of its columns from head to foot; the ground
  // between two figures has at most a shadow, a line of floor, the tip of something held out.
  const rows = Math.ceil(height / 2)
  const filled = new Uint32Array(width)
  const measure = (ground: readonly [number, number, number]): number => {
    filled.fill(0)
    let plain = 0
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = colourAt(image, y * width + x)
        if (Math.abs(r - ground[0]) > NEAR || Math.abs(g - ground[1]) > NEAR || Math.abs(b - ground[2]) > NEAR) filled[x]! += 1
        else plain += 1
      }
    }
    return plain / (rows * width)
  }
  // A ground is a good part of the picture: one that is busy all over is no sheet to part.
  const grounds = [commonest(true), commonest(false)].filter((ground): ground is readonly [number, number, number] => ground !== undefined)
  if (!grounds.some(ground => measure(ground) >= 0.2)) return undefined
  const taken = (x: number): boolean => filled[x]! >= rows * 0.08
  // Runs of columns that hold a figure; a sliver of ground inside one (between an arm and a side) does not part it,
  // and a sliver of something on the ground is not one.
  const runs: { from: number; to: number }[] = []
  for (let x = 0; x < width; x++) {
    if (!taken(x)) continue
    const last = runs.at(-1)
    if (last !== undefined && x - last.to <= Math.max(2, Math.round(width * 0.012))) last.to = x
    else runs.push({ from: x, to: x })
  }
  const figures = runs.filter(run => run.to - run.from + 1 >= width * 0.04)
  if (figures.length < 2) return undefined
  const first = figures[0]!
  const wide = first.to - first.from + 1
  if (wide > width * 0.55) return undefined
  // With ground on either side: half of what lies before the next figure, and no more than a twentieth of the sheet.
  const pad = Math.max(2, Math.min(Math.round(width * 0.05), Math.floor((figures[1]!.from - first.to - 1) / 2)))
  const left = Math.max(0, first.from - pad)
  const right = Math.min(width, first.to + 1 + pad)
  return { left, width: right - left }
}

/**
 * The front view of a design sheet, as a picture of its own (a PNG): the first of the figures it shows side by side.
 * @returns nothing where no figure can be told apart — the sheet then goes along whole — or where the picture is of a
 *   kind that cannot be read here (not a PNG, and no ffmpeg on this computer to make it one).
 */
export async function frontView(sheet: Uint8Array, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  const png = sheet.byteLength > 8 && sheet[0] === 0x89 && sheet[1] === 0x50 ? sheet : await asPng(sheet, signal)
  if (png === undefined) return undefined
  const image = await readPng(png)
  if (image === undefined) return undefined
  const figure = firstFigure(image)
  if (figure === undefined) return undefined
  return await cutPng(image, { left: figure.left, top: 0, width: figure.width, height: image.height })
}

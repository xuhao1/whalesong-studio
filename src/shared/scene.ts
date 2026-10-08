// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A place's picture as a scene to step into: what stands in the place — the
 * courtyards of a garden, the houses of a city, whoever lives there — is
 * marked on the picture, each mark a way in.
 *
 * Where a mark stands is the author's to say, by dragging it there: a pin,
 * kept with the place as a fraction of the picture's width and height, so it
 * is the same spot at any size. What nobody pinned is laid out here: spread
 * over the upper part of the picture in staggered rows, the same every time —
 * no model is asked where a courtyard is in a painting, and nothing depends
 * on one having been right.
 */

/** A point on a picture: fractions of its width and its height, from its top left. */
export interface ScenePoint {
  x: number
  y: number
}

export interface SceneSpot extends ScenePoint {
  /** What the mark leads to: `world:<id>` or `character:<id>`. */
  key: string
  /** The author put it there. */
  pinned: boolean
}

/** The part of a picture marks are laid out in by themselves: clear of its edges, and of the foot where the place's name stands. */
export const SCENE_BAND = { left: 0.1, right: 0.9, top: 0.14, bottom: 0.58 }

/** How many marks a picture carries before it is a crowd: the rest are in the lists under it. */
export const SCENE_SPOTS = 12

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** A number in [0, 1) from a key, the same every time: what keeps a row of marks from looking ruled. */
function sway(key: string, salt: number): number {
  let hash = 2166136261 ^ salt
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
  return ((hash >>> 0) % 1000) / 1000
}

/** The key of a mark for one end of a tie. */
export function spotKey(end: { type: 'character' | 'world'; id: string }): string {
  return `${end.type}:${end.id}`
}

/**
 * Where the marks stand: each where it was pinned, the others spread over the
 * band in staggered rows, in the order given.
 * @param keys - what is to be marked, the most important first; at most `SCENE_SPOTS` are.
 * @param pins - where the author put some of them.
 */
export function layoutSpots(keys: readonly string[], pins: Readonly<Record<string, ScenePoint | undefined>> = {}): SceneSpot[] {
  const shown = keys.slice(0, SCENE_SPOTS)
  const free = shown.filter(key => pins[key] === undefined)
  // Wide rather than tall, as pictures are: about twice as many to a row as there are rows.
  const perRow = free.length <= 3 ? Math.max(1, free.length) : Math.ceil(Math.sqrt(free.length * 2))
  const rows = Math.ceil(free.length / perRow)
  const width = SCENE_BAND.right - SCENE_BAND.left
  const height = SCENE_BAND.bottom - SCENE_BAND.top
  const placed = new Map<string, ScenePoint>()
  for (const [index, key] of free.entries()) {
    const row = Math.floor(index / perRow)
    const inRow = row === rows - 1 ? free.length - row * perRow : perRow
    const column = index - row * perRow
    // Every other row stands between the marks of the one above, where there is room to.
    const shift = row % 2 === 1 && inRow < perRow ? 0 : row % 2 === 1 ? 0.25 : -0.25
    const step = width / inRow
    const x = SCENE_BAND.left + step * (column + 0.5) + (inRow > 1 ? step * shift * 0.5 : 0) + (sway(key, 1) - 0.5) * Math.min(0.04, step * 0.2)
    const y = SCENE_BAND.top + (rows === 1 ? height * 0.45 : (height / rows) * (row + 0.5)) + (sway(key, 2) - 0.5) * Math.min(0.06, (height / rows) * 0.3)
    placed.set(key, { x: clamp(x, 0.04, 0.96), y: clamp(y, 0.06, 0.94) })
  }
  return shown.map((key) => {
    const pin = pins[key]
    return pin !== undefined ? { key, x: clamp(pin.x, 0, 1), y: clamp(pin.y, 0, 1), pinned: true } : { key, ...placed.get(key)!, pinned: false }
  })
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture turned, mirrored and cut by hand.
 *
 * The page that shows a picture lets its author set it straight — a quarter
 * turn, a mirroring, a part of it kept — and what comes of that is a picture
 * of its own, the one it was made of staying in the book. What was done is
 * kept with the new picture as three things, in the order they are done:
 * mirrored left to right, turned by quarters clockwise, cut. Working on it
 * again starts from the picture it was made of and from these, so a cut can be
 * widened and nothing is lost by cutting twice.
 *
 * Here is the arithmetic of it, shared by the page (which draws) and the Host
 * (which keeps the record): how a turn or a mirroring changes what is kept,
 * how a cut is dragged and held to a shape, and which pixels it comes to.
 */
import type { PictureEdit } from './types'

export type Crop = NonNullable<PictureEdit['crop']>
export interface Frame { width: number; height: number }

/** A picture as it stands on the page that edits it: mirrored or not, turned by so many quarters, and the part kept. */
export interface EditState {
  flip: boolean
  turn: 0 | 1 | 2 | 3
  crop: Crop
}

const WHOLE: Crop = { x: 0, y: 0, width: 1, height: 1 }
/** Closer than this to an edge is at the edge: a part that is all of the picture but for a hair is all of it. */
const HAIR = 0.0005

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** A part within the picture: its corners held inside, never thinner than a sliver. */
export function tidyCrop(crop: Crop): Crop {
  const width = clamp(Number.isFinite(crop.width) ? crop.width : 1, 0.001, 1)
  const height = clamp(Number.isFinite(crop.height) ? crop.height : 1, 0.001, 1)
  return { x: clamp(Number.isFinite(crop.x) ? crop.x : 0, 0, 1 - width), y: clamp(Number.isFinite(crop.y) ? crop.y : 0, 0, 1 - height), width, height }
}

export const wholeCrop = (crop: Crop): boolean => crop.x <= HAIR && crop.y <= HAIR && crop.width >= 1 - 2 * HAIR && crop.height >= 1 - 2 * HAIR

/** What an edit on record comes to on the page; nothing done where there is none. */
export function editState(edit?: PictureEdit): EditState {
  const turn = edit?.turn === 1 || edit?.turn === 2 || edit?.turn === 3 ? edit.turn : 0
  return { flip: edit?.flip === true, turn, crop: edit?.crop !== undefined ? tidyCrop(edit.crop) : { ...WHOLE } }
}

/** Nothing was done: the picture as it is. */
export const untouched = (state: EditState): boolean => !state.flip && state.turn === 0 && wholeCrop(state.crop)

/** The edit as it is put on record: only what was done. */
export function editOf(state: EditState): PictureEdit {
  const crop = tidyCrop(state.crop)
  const round = (value: number): number => Math.round(value * 1e5) / 1e5
  return {
    ...(state.flip ? { flip: true } : {}),
    ...(state.turn !== 0 ? { turn: state.turn } : {}),
    ...(wholeCrop(crop) ? {} : { crop: { x: round(crop.x), y: round(crop.y), width: round(crop.width), height: round(crop.height) } }),
  }
}

export const sameEdit = (left: EditState, right: EditState): boolean => JSON.stringify(editOf(left)) === JSON.stringify(editOf(right))

/** Turned a quarter more — clockwise (`1`) or back (`-1`): what is kept is the same part of the picture, turned with it. */
export function quarter(state: EditState, by: 1 | -1): EditState {
  const { x, y, width, height } = state.crop
  const crop = by === 1 ? { x: 1 - (y + height), y: x, width: height, height: width } : { x: y, y: 1 - (x + width), width: height, height: width }
  return { flip: state.flip, turn: ((state.turn + (by === 1 ? 1 : 3)) % 4) as EditState['turn'], crop: tidyCrop(crop) }
}

/**
 * Mirrored as it stands — left to right (`h`) or top to bottom (`v`). (A mirroring after a turn is the turn the other
 * way after a mirroring: kept as that, so that what is on record is always "mirrored, then turned".)
 */
export function mirror(state: EditState, across: 'h' | 'v'): EditState {
  const { x, y, width, height } = state.crop
  const back = (4 - state.turn) % 4
  return across === 'h'
    ? { flip: !state.flip, turn: back as EditState['turn'], crop: tidyCrop({ x: 1 - (x + width), y, width, height }) }
    : { flip: !state.flip, turn: ((back + 2) % 4) as EditState['turn'], crop: tidyCrop({ x, y: 1 - (y + height), width, height }) }
}

/** The size of a picture as it stands turned: on its side, its width is its height. */
export const turnedFrame = (size: Frame, turn: number): Frame => (turn % 2 === 1 ? { width: size.height, height: size.width } : { width: size.width, height: size.height })

/** The pixels kept, of the picture as it stands mirrored and turned: whole pixels, never none. */
export function keptPixels(size: Frame, state: EditState): { x: number; y: number; width: number; height: number; frame: Frame } {
  const frame = turnedFrame(size, state.turn)
  const crop = wholeCrop(state.crop) ? WHOLE : tidyCrop(state.crop)
  const x = clamp(Math.round(crop.x * frame.width), 0, Math.max(0, frame.width - 1))
  const y = clamp(Math.round(crop.y * frame.height), 0, Math.max(0, frame.height - 1))
  return { x, y, width: clamp(Math.round(crop.width * frame.width), 1, frame.width - x), height: clamp(Math.round(crop.height * frame.height), 1, frame.height - y), frame }
}

/**
 * The largest part of a shape (`ratio`: width over height, in pixels) that lies within the part kept now, about its
 * middle — what a cut becomes when a shape is asked of it.
 */
export function shaped(crop: Crop, ratio: number, frame: Frame): Crop {
  if (!(ratio > 0) || frame.width <= 0 || frame.height <= 0) return crop
  // In fractions, a shape is as much wider as the frame is taller.
  const shape = ratio * frame.height / frame.width
  let width = crop.width
  let height = width / shape
  if (height > crop.height) {
    height = crop.height
    width = height * shape
  }
  return tidyCrop({ x: crop.x + (crop.width - width) / 2, y: crop.y + (crop.height - height) / 2, width, height })
}

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * A cut as a drag leaves it.
 * @param from - the part kept when the drag began.
 * @param by - how far the pointer went since, in fractions of the frame.
 * @param least - the least it may be wide and tall, in fractions.
 * @param ratio - where it is held to a shape: width over height in pixels; with `frame`. Held to a shape it is dragged
 *   by its corners (and moved) — an edge alone would have to move its neighbours.
 */
export function dragCrop(from: Crop, handle: CropHandle, by: { x: number; y: number }, least: { x: number; y: number }, ratio?: number, frame?: Frame): Crop {
  if (handle === 'move') return { ...from, x: clamp(from.x + by.x, 0, 1 - from.width), y: clamp(from.y + by.y, 0, 1 - from.height) }
  let left = from.x
  let right = from.x + from.width
  let top = from.y
  let bottom = from.y + from.height
  if (handle.includes('w')) left = clamp(left + by.x, 0, right - least.x)
  if (handle.includes('e')) right = clamp(right + by.x, left + least.x, 1)
  if (handle.includes('n')) top = clamp(top + by.y, 0, bottom - least.y)
  if (handle.includes('s')) bottom = clamp(bottom + by.y, top + least.y, 1)
  if (ratio !== undefined && ratio > 0 && frame !== undefined && handle.length === 2) {
    const shape = ratio * frame.height / frame.width
    // The corner across stays where it is; the dragged one goes as far as the pointer took it the further way, and
    // no further than the picture reaches.
    const west = handle.includes('w')
    const north = handle.includes('n')
    const room = { x: west ? from.x + from.width : 1 - from.x, y: north ? from.y + from.height : 1 - from.y }
    let width = Math.max(right - left, (bottom - top) * shape)
    width = Math.min(width, room.x, room.y * shape)
    width = Math.max(width, least.x, least.y * shape)
    const height = width / shape
    if (west) left = from.x + from.width - width
    else right = from.x + width
    if (north) top = from.y + from.height - height
    else bottom = from.y + height
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

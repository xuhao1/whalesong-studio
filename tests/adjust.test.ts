// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture set straight by hand — turned, mirrored, a part of it kept: the
 * arithmetic the page and the Host share, and what the Host keeps of it — the
 * picture made standing where the one it was made of stood, that one staying.
 */
import { describe, expect, it } from 'vitest'
import { dragCrop, editOf, editState, keptPixels, mirror, quarter, sameEdit, shaped, tidyCrop, turnedFrame, untouched, wholeCrop, type EditState } from '../src/shared/edit'
import { adjustPicture } from '../src/core/pipelines/illustrate'
import { cutPng } from '../src/core/media/png'
import { sheetsOf } from '../src/shared/sheets'
import { artsOf } from '../src/shared/arts'
import type { IllustrationInfo } from '../src/shared/types'
import { createTestBed } from './support/harness'

/** A grey picture of a size: another file for each shade. */
const picture = async (width: number, height: number, shade: number): Promise<Uint8Array> => await cutPng({ width, height, kind: 0, each: 1, pixels: new Uint8Array(width * height).fill(shade) }, { left: 0, top: 0, width, height })
const near = (left: number, right: number): boolean => Math.abs(left - right) < 1e-9
const close = (crop: { x: number; y: number; width: number; height: number }, to: [number, number, number, number]): boolean => near(crop.x, to[0]) && near(crop.y, to[1]) && near(crop.width, to[2]) && near(crop.height, to[3])

describe('a picture turned, mirrored and cut: the arithmetic', () => {
  it('keeps the same part of the picture through a turn and a mirroring', () => {
    const start: EditState = { flip: false, turn: 0, crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }
    // A quarter clockwise: what was at the left is at the top, what was at the top is at the right.
    const right = quarter(start, 1)
    expect(right.turn).toBe(1)
    expect(close(right.crop, [0.4, 0.1, 0.4, 0.3])).toBe(true)
    // And back: as it was. Four quarters: as it was.
    expect(sameEdit(quarter(right, -1), start)).toBe(true)
    expect(sameEdit([1, 1, 1, 1].reduce(state => quarter(state, 1), start), start)).toBe(true)
    expect(close(quarter(start, -1).crop, [0.2, 0.6, 0.4, 0.3])).toBe(true)
    // Mirrored left to right, the part is as far from the other side; twice is as it was.
    const across = mirror(start, 'h')
    expect([across.flip, across.turn]).toEqual([true, 0])
    expect(close(across.crop, [0.6, 0.2, 0.3, 0.4])).toBe(true)
    expect(sameEdit(mirror(across, 'h'), start)).toBe(true)
    // Top to bottom is the same mirroring and a half turn.
    const down = mirror(start, 'v')
    expect([down.flip, down.turn]).toEqual([true, 2])
    expect(close(down.crop, [0.1, 0.4, 0.3, 0.4])).toBe(true)
    // Mirrored while it lies on its side: on record it is still "mirrored, then turned" — the turn the other way.
    expect([mirror(right, 'h').flip, mirror(right, 'h').turn]).toEqual([true, 3])
    expect(sameEdit(mirror(mirror(right, 'h'), 'h'), right)).toBe(true)
    expect(sameEdit(mirror(mirror(right, 'v'), 'v'), right)).toBe(true)
    // Both mirrorings are a half turn.
    expect(sameEdit(mirror(mirror(start, 'h'), 'v'), quarter(quarter(start, 1), 1))).toBe(true)
  })

  it('puts on record only what was done, and reads it back', () => {
    expect(untouched(editState())).toBe(true)
    expect(editOf(editState())).toEqual({})
    expect(untouched(editState({ turn: 1 }))).toBe(false)
    expect(editOf({ flip: true, turn: 3, crop: { x: 0, y: 0, width: 1, height: 1 } })).toEqual({ flip: true, turn: 3 })
    // A part that is all of it but for a hair is all of it.
    expect(wholeCrop({ x: 0.0001, y: 0, width: 0.9999, height: 1 })).toBe(true)
    expect(editOf({ flip: false, turn: 0, crop: { x: 0.123456789, y: 0.2, width: 0.5, height: 0.25 } })).toEqual({ crop: { x: 0.12346, y: 0.2, width: 0.5, height: 0.25 } })
    // What is not a turn is none; a part that reaches outside is held inside.
    expect(editState({ turn: 7 as never, crop: { x: 0.8, y: -1, width: 0.5, height: 2 } })).toEqual({ flip: false, turn: 0, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } })
    expect(tidyCrop({ x: Number.NaN, y: 0.5, width: 0, height: 0.2 })).toEqual({ x: 0, y: 0.5, width: 0.001, height: 0.2 })
  })

  it('comes to whole pixels of the picture as it stands turned', () => {
    const size = { width: 1200, height: 800 }
    expect(turnedFrame(size, 1)).toEqual({ width: 800, height: 1200 })
    expect(keptPixels(size, editState())).toEqual({ x: 0, y: 0, width: 1200, height: 800, frame: size })
    expect(keptPixels(size, editState({ turn: 3 }))).toMatchObject({ width: 800, height: 1200 })
    expect(keptPixels(size, editState({ crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 } }))).toMatchObject({ x: 300, y: 400, width: 600, height: 400 })
    // Never past the edge, never nothing.
    expect(keptPixels({ width: 3, height: 3 }, editState({ crop: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 } }))).toMatchObject({ x: 2, y: 2, width: 1, height: 1 })
  })

  it('holds a cut to a shape, and drags it by its edges and corners', () => {
    const frame = { width: 1600, height: 900 }
    // A square out of the whole of a wide picture: as tall as the picture, about its middle.
    const square = shaped({ x: 0, y: 0, width: 1, height: 1 }, 1, frame)
    expect(close(square, [(1 - 900 / 1600) / 2, 0, 900 / 1600, 1])).toBe(true)
    expect(keptPixels(frame, { flip: false, turn: 0, crop: square })).toMatchObject({ width: 900, height: 900 })
    // 9:16 out of that square: within it.
    const tall = shaped(square, 9 / 16, frame)
    expect(keptPixels(frame, { flip: false, turn: 0, crop: tall })).toMatchObject({ width: 506, height: 900 })
    expect(tall.x).toBeGreaterThan(square.x)

    const least = { x: 0.05, y: 0.05 }
    const from = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }
    // Moved: never out of the picture.
    expect(close(dragCrop(from, 'move', { x: 0.1, y: -0.1 }, least), [0.3, 0.1, 0.4, 0.4])).toBe(true)
    expect(close(dragCrop(from, 'move', { x: 5, y: -5 }, least), [0.6, 0, 0.4, 0.4])).toBe(true)
    // An edge: that edge alone, not past the one across, not out of the picture.
    expect(close(dragCrop(from, 'e', { x: 0.1, y: 0.3 }, least), [0.2, 0.2, 0.5, 0.4])).toBe(true)
    expect(close(dragCrop(from, 'w', { x: 0.9, y: 0 }, least), [0.55, 0.2, 0.05, 0.4])).toBe(true)
    expect(close(dragCrop(from, 'n', { x: 0, y: -0.9 }, least), [0.2, 0, 0.4, 0.6])).toBe(true)
    // A corner: both of its edges.
    expect(close(dragCrop(from, 'se', { x: 0.1, y: 0.2 }, least), [0.2, 0.2, 0.5, 0.6])).toBe(true)
    // Held to a shape: the corner across stays, and it keeps the shape — a square, in pixels — as far as the picture reaches.
    const held = dragCrop(square, 'nw', { x: 0.1, y: 0.4 }, least, 1, frame)
    expect(near(held.x + held.width, square.x + square.width) && near(held.y + held.height, 1)).toBe(true)
    expect(near(held.width * frame.width, held.height * frame.height)).toBe(true)
    const grown = dragCrop({ x: 0.5, y: 0.5, width: 0.1, height: 0.1 * 16 / 9 }, 'se', { x: 2, y: 2 }, least, 1, frame)
    expect(near(grown.y + grown.height, 1)).toBe(true)
    expect(near(grown.width * frame.width, grown.height * frame.height)).toBe(true)
  })
})

describe('a picture of the book set straight by hand', () => {
  it('is kept as a picture of its own where the one it was made of stood — which stays', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const original = await project.writeAsset('images/portrait-shen-0a1b2c3d.png', await picture(40, 30, 10))
      const other = await project.writeAsset('images/portrait-shen-1a1b2c3d.png', await picture(40, 30, 11))
      const chapter = await project.addChapter({ title: '雨夜' })
      const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', visual: { portraits: [original, other], face: original, scenes: [{ id: 's1', title: '回头', chapter: chapter.id, text: '她在巷口回头。', portrait: original }] } })
      const record: IllustrationInfo = { id: 'img-1', path: original, prompt: '人物「沈砚」：高瘦', kind: 'portrait', target: card.id, createdAt: '2026-10-01T00:00:00.000Z', model: 'm', size: '40x30', moment: { title: '回头', scene: 's1', chapter: chapter.id } }
      await project.addIllustration(record)
      // One that waits to take the original's place, of several drawn to compare.
      const waiting = await project.writeAsset('images/portrait-shen-2a1b2c3d.png', await picture(40, 30, 12))
      await project.addIllustration({ id: 'img-w', path: waiting, prompt: '', kind: 'portrait', target: card.id, createdAt: '2026-10-01T00:00:01.000Z', trial: { id: 't', label: 'B', hang: { as: 'instead', of: original } } })

      // Nothing done to it: nothing is made. What is no picture of the book, or bytes that are no picture, is refused.
      await expect(adjustPicture(bed.runtime, { picture: original, edit: {} })).rejects.toThrow(/nothing was done/)
      await expect(adjustPicture(bed.runtime, { picture: 'assets/images/none.png', edit: { turn: 1 } })).rejects.toThrow(/no picture of the book/)
      await expect(adjustPicture(bed.runtime, { picture: '../outside.png', edit: { turn: 1 } })).rejects.toThrow(/no picture of the book/)
      await expect(adjustPicture(bed.runtime, { picture: original, edit: { turn: 1 }, data: new Uint8Array(200) })).rejects.toThrow(/not a picture/)
      await expect(adjustPicture(bed.runtime, { picture: original, edit: { turn: 1 } })).rejects.toThrow(/not a picture/)
      // Named as made of a picture it was not made of.
      await expect(adjustPicture(bed.runtime, { picture: original, from: other, edit: { turn: 1 }, data: await picture(30, 40, 1) })).rejects.toThrow(/was not made of/)

      // Cut and turned: a picture of its own — by its record made of the other, and otherwise what that one's says.
      const cut = await adjustPicture(bed.runtime, { picture: 'img-1', edit: { turn: 1, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, flip: false }, data: await picture(15, 20, 20) })
      expect(cut.held).toEqual(['沈砚'])
      expect(cut.restored).toBeUndefined()
      expect(cut.dropped).toBeUndefined()
      expect(cut.info.path).toMatch(/^assets\/images\/portrait-shen-[0-9a-f]{8}\.png$/)
      expect(cut.info.path).not.toBe(original)
      expect(cut.info).toMatchObject({ kind: 'portrait', target: card.id, prompt: record.prompt, model: 'm', size: '40x30', moment: record.moment, edited: { of: original, turn: 1, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } })
      // (What was asked of the image service — its size among it — is of the picture it was made of, and is kept as that.)
      expect(cut.info.id).not.toBe('img-1')
      expect(cut.info.edited).not.toHaveProperty('flip')
      // It stands where the original stood — before it among her portraits, the picture that stands for her, her
      // moment's — and the original stays, beside it.
      let now = (await project.findCharacter(card.id))!
      expect(now.visual).toMatchObject({ portraits: [cut.info.path, original, other], face: cut.info.path, portrait: cut.info.path })
      expect(now.visual!.scenes![0]!.portrait).toBe(cut.info.path)
      expect(await project.has(original)).toBe(true)
      expect((await project.illustrations()).map(item => item.path)).toEqual([original, waiting, cut.info.path])
      // What waited to take the original's place waits to take it from this one.
      expect((await project.illustrations()).find(item => item.path === waiting)!.trial!.hang).toEqual({ as: 'instead', of: cut.info.path })
      // The same hand-work again: the same file, one record.
      const twice = await adjustPicture(bed.runtime, { picture: original, edit: { turn: 1, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }, data: await picture(15, 20, 20) })
      expect(twice.info.path).toBe(cut.info.path)
      expect((await project.illustrations()).filter(item => item.path === cut.info.path)).toHaveLength(1)

      // Worked on again, it is made anew from the original: what is made stands in for the earlier one, which goes
      // out of the book — file, record and all — the original still there.
      const wider = await adjustPicture(bed.runtime, { picture: cut.info.path, from: original, edit: { turn: 1, crop: { x: 0, y: 0, width: 0.8, height: 0.9 } }, data: await picture(24, 36, 21) })
      expect(wider.dropped).toBe(cut.info.path)
      expect(wider.info.edited).toEqual({ of: original, turn: 1, crop: { x: 0, y: 0, width: 0.8, height: 0.9 } })
      expect(await project.has(cut.info.path)).toBe(false)
      now = (await project.findCharacter(card.id))!
      expect(now.visual).toMatchObject({ portraits: [wider.info.path, original, other], face: wider.info.path })
      expect(now.visual!.scenes![0]!.portrait).toBe(wider.info.path)
      expect((await project.illustrations()).map(item => item.path)).toEqual([original, waiting, wider.info.path])

      // A chapter's text shows it: worked on once more, the earlier one is kept for that text — off her card.
      await project.saveChapterText(chapter.id, `雨下了一夜。\n\n![回头](${wider.info.path})\n\n她没有回头。`)
      const third = await adjustPicture(bed.runtime, { picture: wider.info.path, from: original, edit: { flip: true }, data: await picture(40, 30, 22) })
      expect(third.dropped).toBeUndefined()
      expect(third.shown).toEqual(['雨夜'])
      expect(await project.has(wider.info.path)).toBe(true)
      now = (await project.findCharacter(card.id))!
      expect(now.visual).toMatchObject({ portraits: [third.info.path, original, other], face: third.info.path })
      // (The text is the author's: it shows what it showed.)
      expect(await project.chapterText(chapter.id)).toContain(`](${wider.info.path})`)

      // The hand-work undone: the original stands there again, listed once; what was made of it is gone.
      const back = await adjustPicture(bed.runtime, { picture: third.info.path, from: original, edit: {} })
      expect(back).toMatchObject({ restored: true, dropped: third.info.path, held: ['沈砚'] })
      expect(back.info).toMatchObject({ id: 'img-1', path: original })
      now = (await project.findCharacter(card.id))!
      expect(now.visual).toMatchObject({ portraits: [original, other], face: original, portrait: original })
      expect(now.visual!.scenes![0]!.portrait).toBe(original)
      expect((await project.illustrations()).find(item => item.path === waiting)!.trial!.hang).toEqual({ as: 'instead', of: original })
      // The original is no picture made by hand: there is nothing of it to undo.
      await expect(adjustPicture(bed.runtime, { picture: original, edit: {} })).rejects.toThrow(/nothing was done/)
    } finally {
      await bed.cleanup()
    }
  })

  it('goes with whatever the picture was: a sheet, the art of an entry, a panel, the cover', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      // Her sheet — the three views side by side, the one the author chose — cut down to the figure that faces.
      const three = await project.writeAsset('images/sheet-lin-0a1b2c3d.png', await picture(90, 40, 30))
      const earlier = await project.writeAsset('images/sheet-lin-1a1b2c3d.png', await picture(90, 40, 31))
      const card = await project.saveCharacter({ name: '林疏', role: 'supporting', visual: { sheets: [three, earlier], mainSheet: three, fronts: [] } })
      expect(sheetsOf((await project.findCharacter(card.id))!).map(sheet => [sheet.path, sheet.as, sheet.front])).toEqual([[three, 'main', false], [earlier, 'spare', false]])
      const front = await adjustPicture(bed.runtime, { picture: three, edit: { crop: { x: 0, y: 0, width: 0.33, height: 1 } }, data: await picture(30, 40, 32) })
      let now = (await project.findCharacter(card.id))!
      // The main sheet, chosen, as the one it was made of was — and a sheet of the front view now: one figure stands alone.
      expect(sheetsOf(now).map(sheet => [sheet.path, sheet.as, sheet.front, sheet.chosen === true])).toEqual([[front.info.path, 'main', true, true], [three, 'spare', false, false], [earlier, 'spare', false, false]])
      expect(now.visual).toMatchObject({ sheet: front.info.path, sheetFront: true })
      // Cut again and still lying wide: what it was said to be is kept.
      const trimmed = await adjustPicture(bed.runtime, { picture: earlier, edit: { crop: { x: 0.05, y: 0, width: 0.9, height: 1 } }, data: await picture(81, 40, 33) })
      now = (await project.findCharacter(card.id))!
      expect(sheetsOf(now).find(sheet => sheet.path === trimmed.info.path)).toMatchObject({ as: 'spare', front: false })

      // The art of a place, the main picture by the author's choice; a panel of a storyboard; the cover.
      const art = await project.writeAsset('images/location-yard-0a1b2c3d.png', await picture(64, 36, 40))
      const spare = await project.writeAsset('images/location-yard-1a1b2c3d.png', await picture(64, 36, 41))
      const entry = await project.saveWorld({ name: '后院', category: 'location', visualImages: [spare, art], visualMain: art })
      const chapter = await project.addChapter({ title: '后院' })
      await project.saveComicBoard({ schema: 1, chapterId: chapter.id, textHash: 'x', updatedAt: new Date().toISOString(), style: '', panels: [{ id: 'p1', description: '', prompt: '后院', lines: [], image: art }] } as never)
      await project.updateManifest({ cover: art })
      const turned = await adjustPicture(bed.runtime, { picture: art, edit: { turn: 2 }, data: await picture(64, 36, 42) })
      expect(turned.held).toEqual(['后院', '后院', (await project.manifest()).title])
      const place = (await project.findWorld(entry.id))!
      expect(artsOf(place).map(item => [item.path, item.main, item.chosen === true])).toEqual([[spare, false, false], [turned.info.path, true, true], [art, false, false]])
      expect((await project.comicBoard(chapter.id))!.panels[0]!.image).toBe(turned.info.path)
      expect((await project.manifest()).cover).toBe(turned.info.path)
      // A picture without a record — a panel drawn before records were kept — has one made as it is worked on. (No
      // size is put on record: a size there is what was asked of an image service, and nothing was asked for this.)
      expect(turned.info).toMatchObject({ edited: { of: art, turn: 2 } })
      expect(turned.info.size).toBeUndefined()
      // Undone: the art, the panel and the cover are the original's again.
      await adjustPicture(bed.runtime, { picture: turned.info.path, from: art, edit: {} })
      expect(artsOf((await project.findWorld(entry.id))!).map(item => [item.path, item.main])).toEqual([[spare, false], [art, true]])
      expect((await project.comicBoard(chapter.id))!.panels[0]!.image).toBe(art)
      expect((await project.manifest()).cover).toBe(art)
    } finally {
      await bed.cleanup()
    }
  })
})

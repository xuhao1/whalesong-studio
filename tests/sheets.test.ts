// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The design sheets kept of a person: several side by side, one of them the
 * main sheet — the author's choice, else the newest — some the sheets of
 * stretches of their life, the rest kept without being in use.
 */
import { describe, expect, it } from 'vitest'
import { cutPng, type PngPixels } from '../src/core/media/png'
import { sheetsOf } from '../src/shared/sheets'
import { inStage } from '../src/shared/stages'
import type { CharacterCard } from '../src/shared/types'
import { createTestBed, PIXEL } from './support/harness'

/** A picture of a shape: all one colour. */
async function png(width: number, height: number): Promise<Uint8Array> {
  const image: PngPixels = { width, height, kind: 2, each: 3, pixels: new Uint8Array(width * height * 3).fill(200) }
  return await cutPng(image, { left: 0, top: 0, width, height })
}

const roles = (card: CharacterCard): string[] => sheetsOf(card).map(sheet => `${sheet.path.split('/').pop()!.replace('.png', '')}:${sheet.as}${sheet.stage !== undefined ? `(${sheet.stage})` : ''}${sheet.chosen === true ? '!' : ''}${sheet.front ? '^' : ''}`)

describe('the design sheets of a person', () => {
  it('are kept side by side: a new one joins them, the main one is the newest until the author chooses', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const a = await project.writeAsset('images/sheet-a.png', PIXEL)
      const b = await project.writeAsset('images/sheet-b.png', PIXEL)
      const c = await project.writeAsset('images/sheet-c.png', PIXEL)
      const card = await project.saveCharacter({ name: '黛玉', visual: { sheet: a } })
      // One sheet: the card says no more than it did.
      expect(card.visual).toEqual({ sheet: a })
      expect(roles(card)).toEqual(['sheet-a:main'])

      // Drawn again — the front view alone, this time: the one before stays, not in use.
      let now = await project.saveCharacter({ id: card.id, visual: { sheet: b, sheetFront: true } as CharacterCard['visual'] })
      expect(now.visual).toEqual({ sheet: b, sheetFront: true, sheets: [b, a], fronts: [b] })
      expect(roles(now)).toEqual(['sheet-b:main^', 'sheet-a:spare'])

      // The author chooses the earlier one: it is the main sheet, and whether it is the front view alone goes with it.
      now = await project.saveCharacter({ id: card.id, visual: { mainSheet: a } })
      expect(now.visual).toEqual({ sheet: a, mainSheet: a, sheets: [b, a], fronts: [b] })
      expect(roles(now)).toEqual(['sheet-b:spare^', 'sheet-a:main!'])

      // A sheet drawn after the choice does not take its place.
      now = await project.saveCharacter({ id: card.id, visual: { sheet: c, sheetFront: null } as unknown as CharacterCard['visual'] })
      expect(now.visual).toMatchObject({ sheet: a, mainSheet: a, sheets: [c, b, a] })
      // Something else of the card saved — its own sheet named again, as a page that holds the whole card sends it — changes nothing of that.
      now = await project.saveCharacter({ id: card.id, tagline: '还泪的人', visual: { ...now.visual! } })
      expect(now.visual).toMatchObject({ sheet: a, mainSheet: a, sheets: [c, b, a], fronts: [b] })
      // The choice let go: it is the main sheet still — the main sheet changes for no other reason than a choice or a
      // new sheet — but the next one drawn takes its place.
      now = await project.saveCharacter({ id: card.id, visual: { mainSheet: '' } })
      expect(now.visual).toEqual({ sheet: a, sheets: [c, b, a], fronts: [b] })
      expect(roles(now)).toEqual(['sheet-c:spare', 'sheet-b:spare^', 'sheet-a:main'])
      const d = await project.writeAsset('images/sheet-d.png', PIXEL)
      now = await project.saveCharacter({ id: card.id, visual: { sheet: d } })
      expect(roles(now)).toEqual(['sheet-d:main', 'sheet-c:spare', 'sheet-b:spare^', 'sheet-a:spare'])
    } finally {
      await bed.cleanup()
    }
  })

  it('can be the sheet of a stretch of their life — then it is not the main one — and one a stretch had before stays', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const [a, b, c] = [await project.writeAsset('images/sheet-a.png', PIXEL), await project.writeAsset('images/sheet-b.png', PIXEL), await project.writeAsset('images/sheet-c.png', PIXEL)]
      const card = await project.saveCharacter({ name: '宝玉', visual: { sheet: a }, stages: [{ id: 'child', title: '幼年' }, { id: 'youth', title: '少年', appearance: '身量拔高了' }] })
      await project.saveCharacter({ id: card.id, visual: { sheet: b, sheetFront: true } as CharacterCard['visual'] })
      await project.saveCharacter({ id: card.id, visual: { mainSheet: b } })

      // The chosen main sheet marked as a stretch's: it is that stretch's, and the main one is the one kept right behind it.
      let now = await project.saveCharacter({ id: card.id, stages: [{ id: 'child', title: '幼年' }, { id: 'youth', title: '少年', appearance: '身量拔高了', visual: { sheet: b } }] })
      expect(roles(now)).toEqual(['sheet-b:stage(youth)^', 'sheet-a:main'])
      expect(now.visual).toEqual({ sheet: a, sheets: [b, a], fronts: [b] })
      // The stretch's sheet is the front view alone because the sheet is — and so reads whoever draws them in that stretch.
      expect(now.stages![1]!.visual).toEqual({ sheet: b, sheetFront: true })
      expect(inStage(now, now.stages![1])!.visual).toMatchObject({ sheet: b, sheetFront: true })
      expect(inStage(now, now.stages![0])!.visual).toEqual({ sheet: a, sheets: [b, a], fronts: [b] })

      // A sheet drawn for the stretch (as the draw keeps it): the one the stretch had stays among theirs, not in use.
      now = await project.saveCharacter({ id: card.id, stages: now.stages!.map(stage => (stage.id === 'youth' ? { ...stage, visual: { sheet: c } } : stage)) })
      expect(roles(now)).toEqual(['sheet-c:stage(youth)', 'sheet-b:spare^', 'sheet-a:main'])
      expect(now.stages![1]!.visual).toEqual({ sheet: c })
      // The stretch itself taken away: its sheet stays, not in use — and the main sheet is what it was.
      now = await project.saveCharacter({ id: card.id, stages: [{ id: 'child', title: '幼年' }] })
      expect(roles(now)).toEqual(['sheet-c:spare', 'sheet-b:spare^', 'sheet-a:main'])
    } finally {
      await bed.cleanup()
    }
  })

  it('give way to a picture drawn from one of them — which takes its place, the old one staying behind it — and let go of one deleted', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const [a, b, a2, b2] = [await project.writeAsset('images/sheet-a.png', PIXEL), await project.writeAsset('images/sheet-b.png', PIXEL), await project.writeAsset('images/sheet-a2.png', PIXEL), await project.writeAsset('images/sheet-b2.png', PIXEL)]
      const card = await project.saveCharacter({ name: '宝玉', visual: { sheet: a, sheetFront: true } as CharacterCard['visual'], stages: [{ id: 'youth', title: '少年', visual: { sheet: b } }] })
      await project.saveCharacter({ id: card.id, visual: { mainSheet: a } })
      // The chosen main sheet drawn again: the new one is the chosen one, of the same shape.
      expect(await project.replacePicture(a, a2)).toEqual(['宝玉'])
      let now = (await project.findCharacter(card.id))!
      expect(roles(now)).toEqual(['sheet-b:stage(youth)', 'sheet-a2:main!^', 'sheet-a:spare^'])
      // A stretch's sheet drawn again: the new one is the stretch's.
      await project.replacePicture(b, b2)
      now = (await project.findCharacter(card.id))!
      expect(roles(now)).toEqual(['sheet-b2:stage(youth)', 'sheet-b:spare', 'sheet-a2:main!^', 'sheet-a:spare^'])
      // One that was not in use, drawn again, is not in use either: the new one stands before it.
      const a3 = await project.writeAsset('images/sheet-a3.png', PIXEL)
      await project.replacePicture(a, a3)
      expect(roles((await project.findCharacter(card.id))!)).toEqual(['sheet-b2:stage(youth)', 'sheet-b:spare', 'sheet-a2:main!^', 'sheet-a3:spare^', 'sheet-a:spare^'])

      // Deleted: out of the sheets kept. The main one gone, the one kept right behind it is the main one — not the
      // first of the list, which was a stretch's once; a stretch's gone, the stretch is without.
      expect(await project.removePicture({ path: a2 })).toEqual(['宝玉'])
      expect(roles((await project.findCharacter(card.id))!)).toEqual(['sheet-b2:stage(youth)', 'sheet-b:spare', 'sheet-a3:main^', 'sheet-a:spare^'])
      await project.removePicture({ path: b2 })
      now = (await project.findCharacter(card.id))!
      expect(roles(now)).toEqual(['sheet-b:spare', 'sheet-a3:main^', 'sheet-a:spare^'])
      expect(now.stages).toEqual([{ id: 'youth', title: '少年' }])
      // The main sheet that was only the main one for standing there (not chosen), drawn again: the new one is the main one.
      const a4 = await project.writeAsset('images/sheet-a4.png', PIXEL)
      await project.replacePicture(a3, a4)
      expect(roles((await project.findCharacter(card.id))!)).toEqual(['sheet-b:spare', 'sheet-a4:main^', 'sheet-a3:spare^', 'sheet-a:spare^'])
      for (const path of [a4, a3, a, b]) await project.removePicture({ path })
      expect((await project.findCharacter(card.id))!.visual).toBeUndefined()
    } finally {
      await bed.cleanup()
    }
  })

  it('reads a card of before — one sheet, a stretch with its own — as it is, and takes one in from the gallery by its shape', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const [a, s] = [await project.writeAsset('images/sheet-a.png', PIXEL), await project.writeAsset('images/sheet-s.png', PIXEL)]
      const upright = await project.writeAsset('images/sheet-up.png', await png(20, 30))
      const wide = await project.writeAsset('images/sheet-wide.png', await png(30, 20))
      // As a release before this one left it: the card's sheet and a stretch's, each saying of itself whether it is the front view alone.
      const before: CharacterCard = { id: '宝玉', name: '宝玉', role: 'protagonist', visual: { sheet: a }, stages: [{ id: 'youth', title: '少年', visual: { sheet: s, sheetFront: true } }] }
      expect(roles(before)).toEqual(['sheet-a:main', 'sheet-s:stage(youth)^'])
      const card = await project.saveCharacter(before)
      expect(card.visual).toEqual({ sheet: a, sheets: [s, a], fronts: [s] })

      // Two out of the gallery join the list: nothing says what they show, so their shape does — one figure stands upright.
      const now = await project.saveCharacter({ id: card.id, visual: { sheets: [s, a, upright, wide] } })
      expect(roles(now)).toEqual(['sheet-s:stage(youth)^', 'sheet-a:main', 'sheet-up:spare^', 'sheet-wide:spare'])
      // The author's order is kept; a stretch's sheet left out of a list handed in is one of theirs all the same.
      const ordered = await project.saveCharacter({ id: card.id, visual: { sheets: [wide, upright, a] } })
      expect(roles(ordered)).toEqual(['sheet-s:stage(youth)^', 'sheet-wide:spare', 'sheet-up:spare^', 'sheet-a:main'])
    } finally {
      await bed.cleanup()
    }
  })
})

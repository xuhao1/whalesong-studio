// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The design pictures kept of a place, a house or a thing: several side by
 * side, one of them the main picture — the author's choice, else the newest —
 * the rest kept without being in use.
 */
import { describe, expect, it } from 'vitest'
import { artPool, artsOf, isArtOf, mainArtOf } from '../src/shared/arts'
import { changedFields } from '../src/shared/history'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import type { WorldEntry } from '../src/shared/types'
import { createTestBed, FakeImages, PIXEL } from './support/harness'

const roles = (entry: WorldEntry): string[] => artsOf(entry).map(art => `${art.path.split('/').pop()!.replace('.png', '')}:${art.main ? 'main' : 'spare'}${art.chosen === true ? '!' : ''}`)

describe('the design pictures of an entry', () => {
  it('reads which are kept and which is the main one', () => {
    expect(artPool({})).toEqual([])
    expect(artPool({ visualImage: 'a' })).toEqual(['a'])
    // (An entry whose list does not have its main picture — written by hand — still has it.)
    expect(artPool({ visualImage: 'a', visualImages: ['b', 'c'] })).toEqual(['a', 'b', 'c'])
    expect(mainArtOf(['b', 'a'], undefined, 'a')).toEqual({ path: 'a', chosen: false })
    expect(mainArtOf(['b', 'a'], 'b', 'a')).toEqual({ path: 'b', chosen: true })
    // A choice that is no longer among them is no choice.
    expect(mainArtOf(['b', 'a'], 'gone', 'a')).toEqual({ path: 'a', chosen: false })
    expect(mainArtOf(['b', 'a'], undefined, 'gone')).toEqual({ path: 'b', chosen: false })
    expect(mainArtOf([], undefined)).toEqual({ chosen: false })
    // By its name a picture file is design art of an entry — not the picture of a turn of its course.
    expect(isArtOf('风月宝鉴', 'assets/images/item-风月宝鉴-0a1b2c3d.png')).toBe(true)
    expect(isArtOf('大观园', 'assets/images/location-大观园-0a1b2c3d.jpg')).toBe(true)
    expect(isArtOf('大观园', 'assets/images/location-大观园-ch003-decline-0a1b2c3d.png')).toBe(false)
    expect(isArtOf('大观', 'assets/images/location-大观园-0a1b2c3d.png')).toBe(false)
  })

  it('are kept side by side: a new one joins them, the main one is the newest until the author chooses', async () => {
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const drawn = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(name => project.writeAsset(`images/item-mirror-${name}.png`, PIXEL)))
      const [a, b, c, d, e, f] = drawn as [string, string, string, string, string, string]
      const entry = await project.saveWorld({ name: '风月宝鉴', category: 'item', visualImage: a })
      // One picture: the entry says no more than it did.
      expect(entry).toMatchObject({ visualImage: a })
      expect(entry.visualImages).toBeUndefined()
      expect(roles(entry)).toEqual(['item-mirror-a:main'])

      // Drawn again: the one before stays, not in use.
      let now = await project.saveWorld({ id: entry.id, visualImage: b })
      expect(now).toMatchObject({ visualImage: b, visualImages: [b, a] })
      expect(now.visualMain).toBeUndefined()
      expect(roles(now)).toEqual(['item-mirror-b:main', 'item-mirror-a:spare'])

      // The author chooses the earlier one: it is the main picture, and one drawn after does not take its place.
      now = await project.saveWorld({ id: entry.id, visualMain: a })
      expect(now).toMatchObject({ visualImage: a, visualMain: a, visualImages: [b, a] })
      now = await project.saveWorld({ id: entry.id, visualImage: c })
      expect(now).toMatchObject({ visualImage: a, visualMain: a, visualImages: [c, b, a] })
      expect(roles(now)).toEqual(['item-mirror-c:spare', 'item-mirror-b:spare', 'item-mirror-a:main!'])

      // The choice let go of: the main picture stays what it is — until another is drawn.
      now = await project.saveWorld({ id: entry.id, visualMain: '' })
      expect(now).toMatchObject({ visualImage: a, visualImages: [c, b, a] })
      expect(now.visualMain).toBeUndefined()
      now = await project.saveWorld({ id: entry.id, visualImage: d })
      expect(roles(now)).toEqual(['item-mirror-d:main', 'item-mirror-c:spare', 'item-mirror-b:spare', 'item-mirror-a:spare'])

      // Saving the entry's words says nothing of its pictures, and changes none of them; a picture is no version of it.
      const worded = await project.saveWorld({ id: entry.id, summary: '一面两面皆可照人的镜子' })
      expect(worded).toMatchObject({ visualImage: d, visualImages: [d, c, b, a] })
      expect(changedFields('world', now as unknown as Record<string, unknown>, { ...now, visualImage: a, visualImages: [a], visualMain: a })).toEqual([])

      // The main one taken out of the book: the one kept right behind it is next. Another taken out: nothing else moves.
      await project.removePicture({ path: d })
      now = (await project.findWorld(entry.id))!
      expect(roles(now)).toEqual(['item-mirror-c:main', 'item-mirror-b:spare', 'item-mirror-a:spare'])
      await project.removePicture({ path: a })
      expect(roles((await project.findWorld(entry.id))!)).toEqual(['item-mirror-c:main', 'item-mirror-b:spare'])

      // One drawn again from another takes that one's place — the main picture, where it was that — and the old one stays behind it.
      await project.replacePicture(c, e)
      now = (await project.findWorld(entry.id))!
      expect(roles(now)).toEqual(['item-mirror-e:main', 'item-mirror-c:spare', 'item-mirror-b:spare'])
      await project.saveWorld({ id: entry.id, visualMain: b })
      await project.replacePicture(b, f)
      now = (await project.findWorld(entry.id))!
      expect(now).toMatchObject({ visualImage: f, visualMain: f })
      expect(roles(now)).toEqual(['item-mirror-e:spare', 'item-mirror-c:spare', 'item-mirror-f:main!', 'item-mirror-b:spare'])

      // One chosen out of the gallery — on no list: it joins them, as the main picture.
      const g = await project.writeAsset('images/item-mirror-g.png', PIXEL)
      now = await project.saveWorld({ id: entry.id, visualMain: g })
      expect(now).toMatchObject({ visualImage: g, visualMain: g })
      expect(artPool(now)[0]).toBe(g)

      // All of them taken out: the entry has no picture.
      for (const path of artPool(now)) await project.removePicture({ path })
      now = (await project.findWorld(entry.id))!
      expect(now.visualImage).toBeUndefined()
      expect(now.visualImages).toBeUndefined()
      expect(now.visualMain).toBeUndefined()

      // Entries made one: the pictures of all of them are the one thing's, its own first.
      const [p, q, r] = await Promise.all(['p', 'q', 'r'].map(name => project.writeAsset(`images/location-${name}.png`, PIXEL))) as [string, string, string]
      const east = await project.saveWorld({ name: '东府', category: 'location', visualImage: p })
      const ning = await project.saveWorld({ name: '宁府', category: 'location', visualImage: q })
      await project.saveWorld({ id: ning.id, visualImage: r })
      const one = (await project.mergeWorld(east.id, [ning.id])).entry
      expect(one).toMatchObject({ visualImage: p, visualImages: [p, r, q] })
    } finally {
      await bed.cleanup()
    }
  })

  it('keeps every design picture drawn of a thing; one drawn while another is chosen waits; one taken of several compared is the main one', async () => {
    const images = new FakeImages()
    const bed = await createTestBed({ settings: { image: { ...DEFAULT_SETTINGS.image, provider: 'codex' } }, bridges: images.bridges })
    try {
      const { project } = bed.runtime
      const { illustrate, hangPicture } = await import('../src/core/pipelines/illustrate')
      const task = { origin: 'user' as const }
      const mirror = await project.saveWorld({ name: '风月宝鉴', category: 'item', visualPrompt: '一面带柄的铜镜，镜背錾着四个字' })
      const first = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id }, task)
      const second = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id }, task)
      expect(first.path).not.toBe(second.path)
      expect(second.spare).toBeUndefined()
      let now = (await project.findWorld(mirror.id))!
      expect(now).toMatchObject({ visualImage: second.path, visualImages: [second.path, first.path] })
      // Both are design art of it by their names — how the page finds one the entry does not list.
      expect(isArtOf(mirror.id, first.path)).toBe(true)

      // The author chose the first: a third is drawn, kept, and waits.
      await project.saveWorld({ id: mirror.id, visualMain: first.path })
      const third = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id }, task)
      expect(third.spare).toBe(true)
      now = (await project.findWorld(mirror.id))!
      expect(now).toMatchObject({ visualImage: first.path, visualMain: first.path, visualImages: [third.path, second.path, first.path] })

      // Several drawn to compare hang nowhere; the one the author takes is the main picture — over the one chosen before.
      const tried = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id, trials: [{ label: 'Codex again', image: { ...DEFAULT_SETTINGS.image, provider: 'codex' } }] }, task)
      const candidate = tried.tried![0]!.path!
      expect(artPool((await project.findWorld(mirror.id))!)).not.toContain(candidate)
      await hangPicture(bed.runtime, (await project.illustrations()).find(item => item.path === candidate)!)
      now = (await project.findWorld(mirror.id))!
      expect(now).toMatchObject({ visualImage: candidate, visualMain: candidate })
      expect(artPool(now)).toEqual([candidate, third.path, second.path, first.path])
    } finally {
      await bed.cleanup()
    }
  })
})

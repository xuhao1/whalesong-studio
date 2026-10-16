// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The showrunner opens one person's or one place's page in the viewer
 * (`novel_show of=…`). Found asking "open her page": the tool could only open
 * the cast list, and the showrunner said it had opened her page.
 */
import { describe, expect, it } from 'vitest'
import type { NovelApi } from '../src/client/api'
import { StudioController } from '../src/client/store'

function controllerWith(characters: { id: string; name: string; aliases?: string[] }[], world: { id: string; name: string; aliases?: string[] }[]): StudioController {
  const controller = new StudioController({ media: () => '', call: async () => undefined } as unknown as NovelApi)
  const held = controller as unknown as { snapshot: Record<string, unknown> }
  held.snapshot = { ...held.snapshot, status: 'ready', root: '/book', project: { root: '/book', manifest: { id: 'book', title: 'Book' }, outline: { volumes: [], threads: [] }, chapters: [], characters, world } }
  return controller
}

describe('a page of the viewer, asked for by name', () => {
  const cast = [{ id: 'cheshire-cat', name: 'Cheshire Cat' }, { id: '凤姐', name: '王熙凤', aliases: ['凤姐', '琏二奶奶'] }]
  const world = [{ id: 'croquet-ground', name: 'Croquet-ground' }, { id: '大观园', name: '大观园', aliases: ['省亲别墅'] }]

  it('opens a person by id, name or another name', () => {
    const controller = controllerWith(cast, world)
    controller.navigate({ view: 'read', of: 'cheshire cat' })
    expect(controller.getSnapshot()).toMatchObject({ view: 'read', album: { section: 'people', end: { type: 'character', id: 'cheshire-cat' } } })
    controller.navigate({ view: 'read', of: '琏二奶奶' })
    expect(controller.getSnapshot().album).toEqual({ section: 'people', end: { type: 'character', id: '凤姐' } })
  })

  it('opens a place of the world the same way', () => {
    const controller = controllerWith(cast, world)
    controller.navigate({ view: 'read', of: '省亲别墅' })
    expect(controller.getSnapshot()).toMatchObject({ view: 'read', album: { section: 'world', end: { type: 'world', id: '大观园' } } })
  })

  it('opens the text when nobody of that name is in the book', () => {
    const controller = controllerWith(cast, world)
    controller.navigate({ view: 'read', of: 'Mad Hatter' })
    expect(controller.getSnapshot()).toMatchObject({ view: 'read', album: { section: 'text' } })
  })
})

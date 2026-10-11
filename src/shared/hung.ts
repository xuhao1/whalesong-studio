// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Where a picture of the book hangs: whose it is held up as, read off the
 * cards and the entries that hold it — not off what its record says it was
 * made as. A picture is somebody's portrait because their card lists it; the
 * design art of a place because the entry does. What the page says a picture
 * is for, and what the author changes when they say it is for something
 * else, is this.
 */
import { sceneOfPicture, scenesOf } from './art'
import { artPool, mainArtOf } from './arts'
import { sheetsOf } from './sheets'
import type { CharacterCard, IllustrationInfo, WorldEntry } from './types'

export type Hung =
  /** One of somebody's portraits: the picture of one of their moments (`scene`), or of a stretch of their life (`stage`), where it is one. */
  | { as: 'portrait'; id: string; name: string; scene?: { id: string; title: string }; stage?: { id: string; title: string } }
  /** One of their design sheets: the main one, one kept without being in use, a stretch's (`stage`) or a look's (`look`). */
  | { as: 'sheet'; id: string; name: string; use: 'main' | 'spare' | 'stage' | 'look'; front: boolean; stage?: { id: string; title: string }; look?: { id: string; name: string } }
  /** One of the design pictures of a place, a house or a thing — or the picture of a turn of its course (`turn`). */
  | { as: 'art'; id: string; name: string; main: boolean; turn?: boolean }

/**
 * Everybody and everything that holds this picture up as theirs.
 * @param record - the picture's record, where it has one: a portrait of a moment is told by it where the moment itself names another picture.
 */
export function hungAt(characters: readonly CharacterCard[], world: readonly WorldEntry[], path: string, record?: Pick<IllustrationInfo, 'moment' | 'parts' | 'ofNoMoment'>): Hung[] {
  const found: Hung[] = []
  for (const card of characters) {
    const visual = card.visual
    const portraits = visual?.portraits ?? (visual?.portrait !== undefined ? [visual.portrait] : [])
    const stretch = (card.stages ?? []).find(stage => stage.visual?.portrait === path)
    const listed = portraits.includes(path)
    const moment = scenesOf(card).find(scene => scene.portrait === path) ?? (listed ? sceneOfPicture(scenesOf(card), path, record) : undefined)
    if (listed || moment !== undefined || stretch !== undefined) {
      found.push({ as: 'portrait', id: card.id, name: card.name, ...(moment !== undefined ? { scene: { id: moment.id, title: moment.title } } : {}), ...(stretch !== undefined ? { stage: { id: stretch.id, title: stretch.title } } : {}) })
    }
    const look = (visual?.looks ?? []).find(item => item.sheet === path)
    if (look !== undefined) found.push({ as: 'sheet', id: card.id, name: card.name, use: 'look', front: look.sheetFront === true, look: { id: look.id, name: look.name } })
    const sheet = sheetsOf(card).find(item => item.path === path)
    if (sheet !== undefined) {
      const of = sheet.stage !== undefined ? (card.stages ?? []).find(stage => stage.id === sheet.stage) : undefined
      found.push({ as: 'sheet', id: card.id, name: card.name, use: sheet.as, front: sheet.front, ...(of !== undefined ? { stage: { id: of.id, title: of.title } } : {}) })
    }
  }
  for (const entry of world) {
    const pool = artPool(entry)
    if (pool.includes(path)) found.push({ as: 'art', id: entry.id, name: entry.name, main: mainArtOf(pool, entry.visualMain, entry.visualImage).path === path })
    else if ((entry.events ?? []).some(turn => turn.image === path)) found.push({ as: 'art', id: entry.id, name: entry.name, main: false, turn: true })
  }
  return found
}

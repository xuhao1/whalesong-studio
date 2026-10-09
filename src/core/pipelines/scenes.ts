// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A person's signature scenes, put together from what the digests noted.
 *
 * The moments somebody is remembered by used to be found by the director, who
 * read the book for one person at a time — a run each, over the same chapters.
 * A chapter is read once already, when it is digested: the digest notes in
 * passing which of its moments a reader would remember somebody by
 * (`ChapterMemory.scenes`), and a card's list is put together from those notes
 * without anybody reading anything again.
 *
 * Such a list is nobody's choice yet. It is brought up to date as chapters are
 * digested, for as long as every moment on it is of this kind; once the
 * director has looked it over, or the author has changed, chosen or removed a
 * moment, the list is theirs and is let be.
 */
import { scenesOf } from '../../shared/art'
import type { CharacterCard, SignatureScene } from '../../shared/types'
import type { ProjectRuntime } from '../core'
import type { Project } from '../project'
import { serializer } from '../util/async'

/** How many a card keeps of what the digests noted: a list to choose a portrait from, not a record of the book. */
const KEPT = 6

/**
 * The moments the digests noted of somebody, most theirs first; among equals, in reading order. One of a name:
 * the same moment told by two chapters is the one that weighs more.
 */
export async function notedScenes(project: Project, card: Pick<CharacterCard, 'id'>): Promise<SignatureScene[]> {
  const { whose } = await project.castResolver()
  const outline = await project.outline()
  const chapters = [...await project.chapters(), ...(await Promise.all((outline.lines ?? []).map(async line => (await project.chapters(line.id)).filter(chapter => chapter.line === line.id)))).flat()]
  const found: { scene: SignatureScene; weight: number; at: number }[] = []
  let at = 0
  for (const { chapter, memory } of await project.memories(chapters)) {
    let here = 0
    for (const note of memory.scenes ?? []) {
      at += 1
      if (whose(note, chapter.plan.id) !== card.id) continue
      here += 1
      found.push({ scene: { id: `noted-${chapter.plan.id}${here > 1 ? `-${here}` : ''}`, title: note.title, chapter: chapter.plan.id, text: note.text, from: 'digest' }, weight: note.weight, at })
    }
  }
  found.sort((left, right) => right.weight - left.weight || left.at - right.at)
  const titles = new Set<string>()
  const out: SignatureScene[] = []
  for (const { scene } of found) {
    const title = scene.title.trim()
    if (title.length > 0 && titles.has(title)) continue
    titles.add(title)
    out.push(scene)
    if (out.length >= KEPT) break
  }
  return out
}

/** One book's lists are brought up to date one at a time: chapters digested side by side would each write the card from what it saw. */
const lanes = new Map<string, ReturnType<typeof serializer>>()

/**
 * Put what the digests noted among these people's signature scenes, where nobody has taken their list in hand.
 * A moment that stays keeps the portrait drawn of it.
 * @returns whose list changed.
 */
export async function keepNotedScenes(runtime: ProjectRuntime, ids: readonly string[]): Promise<string[]> {
  const { project } = runtime
  const wanted = [...new Set(ids)]
  if (wanted.length === 0) return []
  const lane = lanes.get(project.root) ?? serializer()
  lanes.set(project.root, lane)
  return await lane(async () => {
    const changed: string[] = []
    for (const id of wanted) {
      const card = await project.findCharacter(id)
      if (card === undefined) continue
      const kept = scenesOf(card)
      if (kept.some(scene => scene.from !== 'digest')) continue
      const noted = await notedScenes(project, card)
      if (noted.length === 0) continue
      const next = noted.map((scene) => {
        const portrait = kept.find(before => before.id === scene.id)?.portrait
        return portrait !== undefined ? { ...scene, portrait } : scene
      })
      if (JSON.stringify(next) === JSON.stringify(kept)) continue
      await project.saveCharacter({ id: card.id, visual: { scenes: next, scene: '' } })
      changed.push(card.id)
    }
    return changed
  })
}

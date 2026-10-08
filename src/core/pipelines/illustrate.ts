// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Illustration: design sheets, portraits, scenes, places and covers.
 *
 * Three things keep a book's pictures looking like one book, and none of them
 * is hidden from the author:
 *
 *   art direction   one text per book, added to every prompt. A book that has
 *                   none starts from the Studio-wide direction or the built-in
 *                   one, and the first picture writes that text into the book,
 *                   where it can be read and changed.
 *   visual anchors  each character has a short, drawable description written
 *                   for an image model (not the prose of the card), a design
 *                   sheet — front, side and back — and further looks (outfits)
 *                   derived from that sheet. A scene restates the anchor and
 *                   sends the sheet along as a reference image; a place's
 *                   reference art travels the same way. The sheet comes
 *                   first: whoever has none gets one before their portrait,
 *                   and whoever comes back in the book gets one before the
 *                   first scene, panel or cover that shows them — and the
 *                   picture says which sheets were drawn for it.
 *   an avoid list   per Studio, per book, per character and per call, joined
 *                   and sent with every picture.
 *
 * Every picture records what its prompt was assembled from.
 */
import { mergeAvoid, pictureSize, resolveArtStyle, splitAvoid, type ArtSource } from '../../shared/art'
import type { CharacterCard, CharacterLook, IllustrationInfo, IllustrationParts, PromptLanguage, WorldEntry, WorldEvent } from '../../shared/types'
import { referencesOf } from '../../shared/types'
import { clip, fuzzyFind, hashText, newId, sameName, slugify } from '../../shared/text'
import { groupOf } from '../../shared/world'
import { detectCharacters } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asList, asRecord, asText, extractJson } from '../llm'
import { assign } from '../crew'
import { extensionOf, type ImageProvider, type ImageReference } from '../media/image'
import { ProviderError } from '../media/http'
import { ProjectError } from '../project'
import { artDirectionTask, coverPromptTask, illustrationPromptTask, lookTask, turnLookTask, visualAnchorTask } from '../prompts'
import { L, promptLanguage, renderCharacter, renderWorld } from '../render'
import { isAbort } from '../util/async'

export { DEFAULT_ART_STYLE } from '../../shared/art'

export interface IllustrateParams {
  kind: 'portrait' | 'sheet' | 'scene' | 'location' | 'item' | 'cover' | 'custom'
  /** Character (portrait, sheet), chapter (scene) or world entry (location, item). */
  target?: string
  /** For scenes: the passage to illustrate, quoted from the chapter. */
  quote?: string
  /** Extra direction, or the whole prompt for `custom`. For a sheet of a new look: what the look is. */
  prompt?: string
  size?: string
  /** For scenes: embed the image in the chapter text after the quoted passage. */
  insert?: boolean
  /** Sheet: which look (outfit) to draw; a name that does not exist yet creates the look. */
  look?: string
  /** Scene, cover, custom: what each character wears — character name or id → look name. */
  looks?: Record<string, string>
  /** Custom: characters shown, so their sheets go along as references. */
  characters?: string[]
  /** Kept out of this picture, on top of the book's own list. */
  avoid?: string[]
  /** Custom: send the prompt exactly as written — no art direction, no avoid list. */
  raw?: boolean
  /**
   * Location, item: draw it as it is from one turn of its course on — built, changed, in ruins — and keep the picture
   * with that turn, not as its design art. Named by the turn's chapter (id or number), or `<chapter>:<kind>` where a
   * chapter has several.
   */
  event?: string
}

export async function requireImages(core: NovelCore, runtime?: ProjectRuntime): Promise<ImageProvider> {
  const provider = await core.imageProvider(runtime)
  if (provider === undefined) throw new ProviderError('image generation is not configured — set an image endpoint in Novel Studio → Settings', undefined, 'NOT_CONFIGURED')
  return provider
}

// ───────────────────────────── art direction ─────────────────────────────

export interface ArtDirection {
  style: string
  source: ArtSource
  /** Things no picture of this book may show: the Studio's list and the book's. */
  avoid: string[]
  /** The style was just written into the book because it had none. */
  pinned?: boolean
}

/**
 * The art direction and avoid list in force for a book. With `pin`, a book
 * that has no art direction of its own gets the one in force written into
 * `novel.json`, so what shapes its pictures is on record and stays the same.
 */
export async function artDirectionOf(core: NovelCore, runtime: ProjectRuntime, options: { pin?: boolean } = {}): Promise<ArtDirection> {
  const manifest = await runtime.project.manifest()
  const settings = core.currentSettings().image
  const resolved = resolveArtStyle(manifest, settings.stylePrompt)
  const avoid = mergeAvoid(splitAvoid(settings.negativePrompt), splitAvoid(manifest.artAvoid))
  if (options.pin === true && resolved.source !== 'book') {
    await runtime.project.updateManifest({ artStyle: resolved.text })
    return { style: resolved.text, source: resolved.source, avoid, pinned: true }
  }
  return { style: resolved.text, source: resolved.source, avoid }
}

/** What a book is, said briefly for whoever is to picture it: its story, the temper of its prose, its leads and its places. */
async function bookSketch(runtime: ProjectRuntime, lang: PromptLanguage): Promise<{ story: string; tone: string; leads: CharacterCard[]; places: WorldEntry[] }> {
  const { project } = runtime
  const manifest = await project.manifest()
  const characters = await project.characters()
  // Who the book is about: its leads by the weight of their part — and, in a book whose cast has no roles yet, whoever is on the page most.
  const weight: CharacterCard['role'][] = ['protagonist', 'deuteragonist', 'antagonist']
  const presence = new Map((await project.presence()).map(entry => [entry.character, entry.chapters.length]))
  const byRole = characters.filter(card => weight.includes(card.role)).sort((left, right) => weight.indexOf(left.role) - weight.indexOf(right.role) || (presence.get(right.id) ?? 0) - (presence.get(left.id) ?? 0))
  const leads = (byRole.length > 0 ? byRole : [...characters].sort((left, right) => (presence.get(right.id) ?? 0) - (presence.get(left.id) ?? 0)).filter(card => (presence.get(card.id) ?? 0) > 0)).slice(0, 4)
  // What the story is: its premise — and where nobody has written one down, what its chapters tell.
  const told: string[] = []
  if (manifest.premise === undefined) {
    const arcs = (await project.readState<{ fromIndex: number; toIndex: number; summary: string }[]>('memory', 'arcs.json')) ?? []
    if (arcs.length > 0) told.push(...arcs.map(arc => `${L(lang, `第${arc.fromIndex}–${arc.toIndex}章`, `Chapters ${arc.fromIndex}–${arc.toIndex}`)}  ${arc.summary}`))
    else for (const { chapter, memory } of await project.memories()) told.push(`${chapter.index}. ${memory.brief}`)
  }
  const story = [manifest.premise, told.length > 0 ? clip(told.join('\n'), 4000) : undefined].filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
  const style = await project.activeStyle()
  const tone = [style?.tone, style?.imagery].filter((part): part is string => part !== undefined && part.length > 0).join(lang === 'zh' ? '；' : '; ')
  const places = (await project.world()).filter(entry => entry.importance === 1 || entry.visualPrompt !== undefined).slice(0, 8)
  return { story, tone, leads, places }
}

export interface ArtProposal {
  style: string
  avoid: string[]
  /** Why the director settled on it, for the author. */
  why?: string
  /** It was written into the book. */
  applied: boolean
}

/**
 * Have the director settle the look of a book's pictures from the book
 * itself: what it is about, when and where it is set, how its prose sounds,
 * what its people and places look like. Every book has a look of its own; a
 * book that arrives written gets one as it is read, a new one as its bible is
 * drafted, and the author can ask for another at any time.
 * @param params.direction - what the author wants of the look; it decides.
 * @param params.apply - false: only propose. Otherwise the look is written into the book — unless `keep` holds and the book has one already.
 * @param params.keep - leave a book that already has a look of its own as it is (an import run again must not repaint a book the author has styled).
 * @returns the look, or undefined when `keep` held.
 */
export async function deriveArtDirection(core: NovelCore, runtime: ProjectRuntime, params: { direction?: string; apply?: boolean; keep?: boolean }, task: TaskContext): Promise<ArtProposal | undefined> {
  const { project } = runtime
  const manifest = await project.manifest()
  const own = manifest.artStyle?.trim()
  if (params.keep === true && own !== undefined && own.length > 0) return undefined
  const lang = promptLanguage(manifest.language)
  const sketch = await bookSketch(runtime, lang)
  const { value } = await assign(core, runtime, task, {
    role: 'director',
    label: L(lang, '定画风', 'Art direction'),
    tool: 'set_art_direction',
    // The material is in the task; a few looks at the book at most, then the result.
    maxSteps: 12,
    what: L(lang, '这本书所有画面共用的画风，以及任何一张图里都不该出现的东西', 'the look every picture of this book shares, and what none of them may show'),
    prompt: artDirectionTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      ...(manifest.genre !== undefined ? { genre: manifest.genre } : {}),
      ...(manifest.themes !== undefined && manifest.themes.length > 0 ? { themes: manifest.themes.join(lang === 'zh' ? '、' : ', ') } : {}),
      ...(manifest.logline !== undefined ? { logline: manifest.logline } : {}),
      story: sketch.story,
      ...(sketch.tone.length > 0 ? { tone: sketch.tone } : {}),
      leads: sketch.leads.map(card => `${card.name}${card.tagline !== undefined ? `（${clip(card.tagline, 60)}）` : ''}: ${looksOf(card) || L(lang, '（未设定外貌）', '(no look defined)')}`).join('\n'),
      places: sketch.places.map(entry => `${entry.name}: ${entry.visualPrompt ?? entry.summary ?? clip(entry.body ?? '', 160, '')}`).join('\n'),
      ...(own !== undefined && own.length > 0 ? { current: own } : {}),
      ...(params.direction !== undefined && params.direction.trim().length > 0 ? { ask: params.direction.trim() } : {}),
    }),
    temperature: 0.6,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.style) === undefined) throw new Error('"style" is empty')
      return record
    },
  })
  const style = asText(value.style)!
  const avoid = mergeAvoid(asList(value.avoid))
  const why = asText(value.why)
  const applied = params.apply !== false
  if (applied) {
    await project.updateManifest({ artStyle: style, ...(avoid.length > 0 ? { artAvoid: mergeAvoid(manifest.artAvoid, avoid) } : {}) })
    await project.addActivity({ by: 'crew', role: 'director', tool: 'art', summary: L(lang, `定下了这本书的画风：${clip(style, 80)}`, `Settled the look of this book: ${clip(style, 100)}`) })
  }
  return { style, avoid, ...(why !== undefined ? { why } : {}), applied }
}

/** The art direction text alone, for prompts that only need to know the look. */
export async function artStyleOf(core: NovelCore, runtime: ProjectRuntime): Promise<string> {
  return (await artDirectionOf(core, runtime)).style
}

// ───────────────────────────── characters ─────────────────────────────

/** A look of a character by id or name. */
export function lookOf(card: CharacterCard, ref: string | undefined): CharacterLook | undefined {
  const wanted = ref?.trim()
  if (wanted === undefined || wanted.length === 0) return undefined
  return card.visual?.looks?.find(look => look.id === wanted || sameName(look.name, wanted))
}

/** How a character looks, as restated in image prompts: the anchor (or, lacking one, the prose of the card) plus the look worn. */
export function looksOf(card: CharacterCard, look?: CharacterLook): string {
  const anchor = card.visual?.prompt
  const base = anchor !== undefined && anchor.length > 0 ? [anchor] : [card.appearance, card.gender, card.age]
  return [...base, look?.prompt].filter((value): value is string => value !== undefined && value.length > 0).join('，')
}

/** What a character's wardrobe offers a scene, one line per look. */
function wardrobeOf(card: CharacterCard): string | undefined {
  const looks = card.visual?.looks ?? []
  if (looks.length === 0) return undefined
  return `${card.name}: ${looks.map(look => `「${look.name}」${look.when !== undefined ? `（${look.when}）` : ''}${look.prompt !== undefined ? ` ${clip(look.prompt, 80, '…')}` : ''}`).join('；')}`
}

/** The picture that shows how a character looks: the sheet of the look worn, else the main sheet, else the portrait. */
function referenceOf(card: CharacterCard, look?: CharacterLook): { path: string; label: string } | undefined {
  const path = look?.sheet ?? card.visual?.sheet ?? card.visual?.portrait
  if (path === undefined) return undefined
  return { path, label: look?.sheet !== undefined ? `${card.name}（${look.name}）` : card.name }
}

/**
 * Distill a character's prose appearance into a visual anchor an image model
 * draws the same way every time, and store it on the card.
 * @throws ProjectError `novel/invalid` when the card says nothing about how the character looks.
 */
export async function deriveVisual(core: NovelCore, runtime: ProjectRuntime, params: { character: string; direction?: string }, task: TaskContext): Promise<{ card: CharacterCard; prompt: string; negative?: string }> {
  const { project } = runtime
  const card = await project.findCharacter(params.character)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  if (card.appearance === undefined && card.visual?.prompt === undefined && params.direction === undefined) {
    throw new ProjectError('novel/invalid', `${card.name} has no appearance yet — describe how they look first (or let the architect expand the card)`)
  }
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const art = await artDirectionOf(core, runtime)
  const { value } = await assign(core, runtime, task, {
    role: 'director',
    label: L(lang, `定妆 · ${card.name}`, `Look · ${card.name}`),
    tool: 'set_visual_anchor',
    // The material is all in the task: a few looks at the book at most, then the result.
    maxSteps: 10,
    what: L(lang, '这个人物的视觉锚点：画面描述和要避免的东西', 'the visual anchor of this character: what a picture shows, and what it must not'),
    prompt: visualAnchorTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      card: renderCharacter({ ...card, secrets: undefined, relationships: undefined, notes: undefined } as CharacterCard, lang),
      avoid: art.avoid,
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    temperature: 0.3,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.prompt) === undefined) throw new Error('"prompt" is empty')
      return record
    },
  })
  const prompt = asText(value.prompt)!
  const negative = asText(value.negative)
  const saved = await project.saveCharacter({ id: card.id, visual: { prompt, negative: negative ?? '' } })
  return { card: saved, prompt, ...(negative !== undefined ? { negative } : {}) }
}

/** Make sure a character has a visual anchor before it is drawn; without a model to write one, the prose of the card stands in. */
async function withAnchor(core: NovelCore, runtime: ProjectRuntime, card: CharacterCard, task: TaskContext): Promise<CharacterCard> {
  if (card.visual?.prompt !== undefined && card.visual.prompt.length > 0) return card
  if (card.appearance === undefined || card.appearance.length === 0) return card
  try {
    return (await deriveVisual(core, runtime, { character: card.id }, task)).card
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    core.log(`could not distill a visual anchor for ${card.name}; drawing from the card's own words`, error)
    return card
  }
}

/** How much of the text that names a place or a thing the director is handed with the task; more is theirs to look up. */
const LOOK_PASSAGES = 3200

/**
 * Write down what a place or a thing looks like, from what the book says of
 * it, and keep it on the entry (`visualPrompt`): what its design art is drawn
 * from, and what every picture that shows it carries along.
 * @throws ProjectError `novel/not-found` when no entry answers to the name; `novel/invalid` for an idea of the world, which has no look.
 */
export async function deriveLook(core: NovelCore, runtime: ProjectRuntime, params: { entry: string; direction?: string }, task: TaskContext): Promise<{ entry: WorldEntry; look: string }> {
  const { project } = runtime
  const entry = await project.findWorld(params.entry)
  if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${params.entry}"`)
  const group = groupOf(entry.category)
  if (group === 'ideas') throw new ProjectError('novel/invalid', `"${entry.name}" is an idea of the world, not something a picture shows`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const art = await artDirectionOf(core, runtime)
  // Where the text names it: the sentences around each mention, earliest chapters first, as far as the room goes.
  const names = [entry.name, ...(entry.aliases ?? [])].map(name => name.trim()).filter(name => name.length >= 2)
  const passages: string[] = []
  let room = LOOK_PASSAGES
  for (const chapter of await project.chapterInfos()) {
    if (!chapter.hasText || room <= 0 || names.length === 0) continue
    const text = await project.chapterText(chapter.id)
    let from = 0
    for (let found = 0; found < 3 && room > 0; found++) {
      const hits = names.map(name => text.indexOf(name, from)).filter(at => at >= 0)
      if (hits.length === 0) break
      const at = Math.min(...hits)
      const excerpt = text.slice(Math.max(0, at - 120), Math.min(text.length, at + 240)).replace(/\s+/g, ' ').trim()
      passages.push(L(lang, `第 ${chapter.index} 章：……${excerpt}……`, `Chapter ${chapter.index}: …${excerpt}…`))
      room -= excerpt.length
      from = at + 240
    }
  }
  const { value } = await assign(core, runtime, task, {
    role: 'director',
    label: L(lang, `定样子 · ${entry.name}`, `Look · ${entry.name}`),
    tool: 'set_look',
    // The passages come with the task; a few looks at the book beyond them, then the result.
    maxSteps: 10,
    what: L(lang, '这个地方（或这件东西）长什么样：一段给画面用的描述', 'what this place (or thing) looks like: a paragraph for its pictures'),
    prompt: lookTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      kind: group === 'items' ? 'thing' : 'place',
      entry: renderWorld({ ...entry, visualPrompt: undefined } as WorldEntry, lang),
      passages: passages.join('\n'),
      avoid: art.avoid,
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    temperature: 0.3,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.look) === undefined) throw new Error('"look" is empty')
      return record
    },
  })
  const look = asText(value.look)!
  const saved = await project.saveWorld({ id: entry.id, visualPrompt: look })
  return { entry: saved, look }
}

/**
 * Make sure a place or a thing has a look written down before it is drawn: a picture made from a name and a line of
 * summary is the image model's guess. Where no model can write one, the entry's own words stand in.
 */
async function withLook(core: NovelCore, runtime: ProjectRuntime, entry: WorldEntry, task: TaskContext): Promise<WorldEntry> {
  if (entry.visualPrompt !== undefined && entry.visualPrompt.trim().length > 0) return entry
  try {
    return (await deriveLook(core, runtime, { entry: entry.id }, task)).entry
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    core.log(`could not write down how ${entry.name} looks; drawing from the entry's own words`, error)
    return entry
  }
}

/** How a turn of a place's or a thing's course is put to an image model: what it is like from then on. */
const TURN_WORDS: Record<WorldEvent['kind'], [string, string]> = {
  begin: ['这是它刚成形时的样子', 'as it is when it has just come to be'],
  change: ['这是它变动之后的样子', 'as it is after it changed'],
  decline: ['这是它衰败之后的样子，不再是全盛时的光景', 'as it is in decline, no longer what it was at its height'],
  end: ['这是它终结之后的样子', 'as it is after its end'],
}

const turnSubject = (turn: WorldEvent, lang: PromptLanguage): string => `${L(lang, ...TURN_WORDS[turn.kind])}${L(lang, '：', ': ')}${turn.what}`

/**
 * What a picture of a turn is drawn against. A change or a decline is the same
 * sight altered, and the design art goes along — as to where and what, not as
 * to the state it is in: sent with the usual "must match its reference", an
 * image model hands the design art back as it is. What is only coming to be,
 * and what is left after the end, is another sight altogether: with the design
 * art before it, an image model draws the finished place with a little rubble
 * on the ground. Those are drawn from the director's words alone.
 */
function turnAgainst(entry: WorldEntry, turn: WorldEvent | undefined, lang: PromptLanguage): Pick<RenderInput, 'references' | 'referenceNote'> {
  if (turn === undefined || entry.visualImage === undefined || turn.kind === 'begin' || turn.kind === 'end') return {}
  return {
    references: [{ path: entry.visualImage, label: L(lang, `「${entry.name}」平常的样子`, `"${entry.name}" as it usually is`) }],
    referenceNote: L(lang,
      '这是同一处在另一个时候：它在哪里、朝向和主要部分的布局照参考图；它此刻的状态以本描述为准——描述与参考图不一样的地方，一律照描述画（改了的照改过的画，荒废、失修的不要画成完好的）。',
      'This is the same place at another time: where it lies, how it faces and how its main parts are laid out follow the reference; the state it is in follows this description — wherever the description and the reference differ, draw the description (what has changed, as it is after the change; what is run down or unkept is not drawn whole).'),
  }
}

/**
 * The turn of an entry's course a picture is asked for.
 * @param ref - `<chapter>:<kind>`, or the chapter alone (its id, its number): the first turn in that chapter.
 * @throws ProjectError `novel/not-found` when the entry's course has no such turn.
 */
async function turnOf(project: ProjectRuntime['project'], entry: WorldEntry, ref: string): Promise<WorldEvent> {
  const [named, kind] = ref.includes(':') ? [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)] : [ref, undefined]
  const chapter = (await project.findChapter(named.trim()))?.plan.id ?? named.trim()
  const turn = (entry.events ?? []).find(event => event.chapter === chapter && (kind === undefined || event.kind === kind))
  if (turn === undefined) throw new ProjectError('novel/not-found', `the course of "${entry.name}" has nothing at "${ref}" — write the turn down first (what happens to it, and in which chapter)`)
  return turn
}

/** Keep a picture with the turn of the course it shows; the entry's design art stays what it was. */
async function keepTurnPicture(project: ProjectRuntime['project'], entry: WorldEntry, turn: WorldEvent, path: string): Promise<void> {
  const current = (await project.findWorld(entry.id))?.events ?? entry.events ?? []
  await project.saveWorld({ id: entry.id, events: current.map(event => (event.chapter === turn.chapter && event.kind === turn.kind ? { ...event, image: path } : event)) })
}

/**
 * What a place or a thing looks like from one turn of its course on, for the
 * picture of that turn. What happened is told as a story — who did what —
 * and an image model draws that as written: people, and the place as it ever
 * was. So the director writes what is there to be seen once it has happened,
 * from how the place usually looks and what that chapter says of it. Where no
 * model can write it, the usual look and the turn's own words stand in.
 */
async function turnLook(core: NovelCore, runtime: ProjectRuntime, entry: WorldEntry, turn: WorldEvent, task: TaskContext): Promise<string> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const comma = L(lang, '，', ', ')
  const usual = entry.visualPrompt !== undefined && entry.visualPrompt.trim().length > 0 ? entry.visualPrompt.trim() : `${entry.name}${comma}${entry.summary ?? clip(entry.body ?? '', 200, '')}`
  const plain = joinParts([usual, turnSubject(turn, lang)], comma)
  try {
    const art = await artDirectionOf(core, runtime)
    const chapter = await project.findChapter(turn.chapter)
    // Where the chapter it happens in names it: the sentences around each mention, as far as the room goes.
    const names = [entry.name, ...(entry.aliases ?? [])].map(name => name.trim()).filter(name => name.length >= 2)
    const passages: string[] = []
    const text = chapter !== undefined && names.length > 0 ? await project.chapterText(chapter.plan.id).catch(() => '') : ''
    if (text.length > 0) {
      let room = LOOK_PASSAGES
      let from = 0
      while (room > 0) {
        const hits = names.map(name => text.indexOf(name, from)).filter(at => at >= 0)
        if (hits.length === 0) break
        const at = Math.min(...hits)
        const excerpt = text.slice(Math.max(0, at - 160), Math.min(text.length, at + 320)).replace(/\s+/g, ' ').trim()
        passages.push(`……${excerpt}……`)
        room -= excerpt.length
        from = at + 320
      }
    }
    const { value } = await assign(core, runtime, task, {
      role: 'director',
      label: L(lang, `定这时的样子 · ${entry.name}`, `Look then · ${entry.name}`),
      tool: 'set_look',
      maxSteps: 10,
      what: L(lang, '这个地方（或这件东西）在这件事之后长什么样：一段给画面用的描述', 'what this place (or thing) looks like once this has happened: a paragraph for its picture'),
      prompt: turnLookTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        kind: groupOf(entry.category) === 'items' ? 'thing' : 'place',
        name: entry.name,
        usual,
        turn: { ...(chapter !== undefined ? { index: chapter.index } : {}), kind: turn.kind, what: turn.what },
        passages: passages.join('\n'),
        avoid: art.avoid,
      }),
      temperature: 0.3,
      validate: (raw) => {
        const record = asRecord(raw)
        if (asText(record.look) === undefined) throw new Error('"look" is empty')
        return record
      },
    })
    return asText(value.look)!
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    core.log(`could not write down how ${entry.name} looks at ${turn.chapter}; drawing from the turn's own words`, error)
    return plain
  }
}

// ───────────────────────────── one picture ─────────────────────────────

export interface RenderInput {
  /** The picture itself, as asked for or composed. */
  subject: string
  kind: IllustrationInfo['kind']
  target?: string
  size?: string
  name: string
  /** `false` keeps the picture out of the book's illustration list (panels, backdrops). */
  record?: boolean
  /** The book's art direction; `false` sends the subject exactly as written. */
  art: ArtDirection | false
  /** Kept out of this picture, on top of the book's list. */
  avoid?: string[]
  /** Reference pictures, in the order the prompt numbers them. */
  references?: { path: string; label: string }[]
  /** What the references are for, where it is not "whoever and whatever they show must match": said after their list, in its place. */
  referenceNote?: string
}

/** Trailing punctuation of one part would otherwise sit against the next part's label. */
const tidy = (text: string): string => text.trim().replace(/[，,；;、。.\s]+$/u, '')

/** Join the parts of a subject into one line, each part without the punctuation it ended on. */
const joinParts = (parts: readonly (string | undefined)[], comma: string): string => parts.filter((part): part is string => part !== undefined && part.trim().length > 0).map(tidy).join(comma)

/** Generate one image, store it under `assets/images/`, and record what its prompt was made of. */
export async function renderImage(core: NovelCore, runtime: ProjectRuntime, input: RenderInput, task: TaskContext): Promise<IllustrationInfo> {
  const { project } = runtime
  const provider = await requireImages(core, runtime)
  const zh = promptLanguage((await project.manifest()).language) === 'zh'
  const references: { path: string; label: string; image: ImageReference }[] = []
  const most = referencesOf((await core.settings.get()).image.references)
  for (const reference of input.references ?? []) {
    if (references.length >= most || references.some(known => known.path === reference.path)) continue
    try {
      const data = await project.readFile(reference.path)
      references.push({ ...reference, image: { data, mime: /\.jpe?g$/i.test(reference.path) ? 'image/jpeg' : /\.webp$/i.test(reference.path) ? 'image/webp' : 'image/png', label: reference.label } })
    } catch {
      // A reference whose file is gone is simply not sent.
    }
  }
  const referenceLine = references.length === 0 ? undefined : zh
    ? `参考图：${references.map((reference, index) => `第${index + 1}张是${reference.label}`).join('；')}。${input.referenceNote ?? '画面里出现的这些人物和场所必须与各自的参考图一致（脸、发型、体型、服装、结构与材质）；构图、动作与光线以本描述为准。'}`
    : `Reference images: ${references.map((reference, index) => `#${index + 1} shows ${reference.label}`).join('; ')}. ${input.referenceNote ?? 'Whoever and whatever they show must match their reference (face, hair, build, clothing, structure and materials); composition, action and light follow this description.'}`
  const art = input.art === false ? undefined : input.art
  const styleLine = art !== undefined ? `${zh ? '画风：' : 'Style: '}${tidy(art.style)}` : undefined
  const avoid = art !== undefined || (input.avoid?.length ?? 0) > 0 ? mergeAvoid(art?.avoid, input.avoid) : []
  // The subject gives way before the lines that keep the book consistent do.
  const tail = [referenceLine, styleLine].filter((line): line is string => line !== undefined).join('\n')
  const subject = clip(tidy(input.subject), Math.max(200, 1900 - tail.length), '…')
  const prompt = tail.length > 0 ? `${subject}\n${tail}` : subject
  const result = await provider.generate({
    prompt,
    ...(avoid.length > 0 ? { negativePrompt: avoid.join(zh ? '、' : ', ') } : {}),
    ...(input.size !== undefined ? { size: input.size } : {}),
    ...(references.length > 0 ? { references: references.map(reference => reference.image) } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const file = `images/${input.name}-${hashText(prompt + Date.now()).slice(0, 8)}.${extensionOf(result.mime)}`
  const path = await project.writeAsset(file, result.data)
  const used = references.slice(0, result.referencesUsed ?? references.length)
  const parts: IllustrationParts = {
    subject,
    ...(art !== undefined ? { style: art.style, styleSource: art.source } : {}),
    ...(avoid.length > 0 ? { avoid } : {}),
    ...(used.length > 0 ? { references: used.map(reference => ({ path: reference.path, label: reference.label })) } : {}),
  }
  const info: IllustrationInfo = {
    id: newId('img'),
    path,
    prompt,
    parts,
    kind: input.kind,
    ...(input.target !== undefined ? { target: input.target } : {}),
    createdAt: new Date().toISOString(),
    model: provider.model,
  }
  if (input.record !== false) await project.addIllustration(info)
  return info
}

// ───────────────────────────── the sheet first ─────────────────────────────

/** Parts that carry the story: whoever has one comes back, whatever the chapters so far say. */
const CARRYING: readonly CharacterCard['role'][] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting']

/**
 * Who of these comes back in the book: a part that carries it, or anybody the
 * chapters have — written and digested, or planned in the outline — more than
 * once. Somebody seen once and gone needs no sheet to stay the same.
 */
export async function comingBack(project: ProjectRuntime['project'], cards: readonly CharacterCard[]): Promise<Set<string>> {
  if (cards.length === 0) return new Set()
  const seen = new Map((await project.presence()).map(entry => [entry.character, entry.chapters.length]))
  const outline = await project.outline()
  const planned = new Map<string, number>()
  for (const plan of [...outline.volumes.flatMap(volume => volume.chapters), ...(outline.lines ?? []).flatMap(line => line.chapters)]) {
    for (const id of new Set(plan.characters ?? [])) planned.set(id, (planned.get(id) ?? 0) + 1)
  }
  return new Set(cards.filter(card => CARRYING.includes(card.role) || Math.max(seen.get(card.id) ?? 0, planned.get(card.id) ?? 0) >= 2).map(card => card.id))
}

/** Sheets being drawn right now, by book and character: two pictures that need the same sheet wait for the one drawing of it. */
const sheetsUnderway = new Map<string, Promise<void>>()

export interface SheetsFirst {
  /** The same people, as they are now: with the sheets just drawn. */
  cards: CharacterCard[]
  /** Whose sheet was drawn for this, by name — said with the picture, never done behind the author's back. */
  drawn: string[]
  /** Whose could not be drawn, and why: the picture is then made from what there is of them. */
  failed: { name: string; error: string }[]
}

/**
 * Before somebody is drawn, see that they have a design sheet: the one
 * picture every later picture of them is held against. Without it a portrait,
 * a scene and a panel each invent the face anew.
 * @param who - `everyone`: each of them (a portrait is asked for). `returning`: those who come back in the book ({@link comingBack}).
 * @returns the people with their sheets, and which sheets this call drew; nothing is drawn where the author turned this off (`image.sheetFirst`).
 */
export async function sheetsFirst(core: NovelCore, runtime: ProjectRuntime, people: readonly CharacterCard[], who: 'everyone' | 'returning', task: TaskContext): Promise<SheetsFirst> {
  const { project } = runtime
  const out: SheetsFirst = { cards: [...people], drawn: [], failed: [] }
  if (core.currentSettings().image.sheetFirst === false) return out
  const lacking = people.filter(card => card.visual?.sheet === undefined)
  if (lacking.length === 0) return out
  const back = who === 'everyone' ? undefined : await comingBack(project, lacking)
  const lang = promptLanguage((await project.manifest()).language)
  for (const card of lacking) {
    if (back !== undefined && !back.has(card.id)) continue
    // Nothing says how they look: there is nothing to draw a sheet from, and the picture is made of what the passage gives.
    if (looksOf(card).length === 0) continue
    task.signal?.throwIfAborted()
    const key = `${project.root}\n${card.id}`
    let underway = sheetsUnderway.get(key)
    const mine = underway === undefined
    if (underway === undefined) {
      const restore = task.job?.note(L(lang, `先画「${card.name}」的人设图…`, `First the design sheet of ${card.name}…`))
      underway = illustrate(core, runtime, { kind: 'sheet', target: card.id }, task).then(() => undefined).finally(() => {
        sheetsUnderway.delete(key)
        restore?.()
      })
      sheetsUnderway.set(key, underway)
    }
    try {
      await underway
      if (mine) out.drawn.push(card.name)
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      core.log(`could not draw the design sheet of ${card.name} first; drawing from what there is`, error)
      if (mine) out.failed.push({ name: card.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // As they are now: with the sheets just drawn, by this call or by one that ran beside it.
  if (out.drawn.length > 0 || lacking.length > 0) {
    const fresh = await project.characters()
    out.cards = people.map(card => fresh.find(candidate => candidate.id === card.id) ?? card)
  }
  return out
}

// ───────────────────────────── the kinds of picture ─────────────────────────────

/** Things a character's own card says must not be drawn on them. */
const negativesOf = (cards: readonly CharacterCard[]): string[] => cards.flatMap(card => splitAvoid(card.visual?.negative))

export interface IllustrateResult extends IllustrationInfo {
  inserted: boolean
  /** The art direction was written into the book by this call. */
  pinnedStyle?: string
  /** Whose design sheet was drawn first, for this picture to be held against: they had none. */
  sheets?: string[]
  /** Whose sheet could not be drawn first, and why. */
  sheetsFailed?: { name: string; error: string }[]
}

export async function illustrate(core: NovelCore, runtime: ProjectRuntime, params: IllustrateParams, task: TaskContext): Promise<IllustrateResult> {
  const { project } = runtime
  await requireImages(core)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const comma = lang === 'zh' ? '，' : ', '
  const raw = params.kind === 'custom' && params.raw === true
  const art = raw ? false as const : await artDirectionOf(core, runtime, { pin: true })
  // The sheets drawn for this picture before it: said with it, and on the job while it runs.
  const first: Pick<SheetsFirst, 'drawn' | 'failed'> = { drawn: [], failed: [] }
  const done = (info: IllustrationInfo, inserted = false): IllustrateResult => ({
    ...info,
    inserted,
    ...(art !== false && art.pinned === true ? { pinnedStyle: art.style } : {}),
    ...(first.drawn.length > 0 ? { sheets: first.drawn } : {}),
    ...(first.failed.length > 0 ? { sheetsFailed: first.failed } : {}),
  })
  /** These people with a sheet each, where they are to have one: drawn now if need be. */
  const sheeted = async (people: readonly CharacterCard[], who: 'everyone' | 'returning'): Promise<CharacterCard[]> => {
    const made = await sheetsFirst(core, runtime, people, who, task)
    first.drawn.push(...made.drawn)
    first.failed.push(...made.failed)
    if (made.drawn.length > 0) task.job?.result({ sheets: first.drawn })
    return made.cards
  }
  const characters = await project.characters()
  const find = (ref: string): CharacterCard | undefined => characters.find(card => card.id === ref || sameName(card.name, ref) || (card.aliases ?? []).some(alias => sameName(alias, ref)))
  const worn = (card: CharacterCard): CharacterLook | undefined => {
    for (const [who, look] of Object.entries(params.looks ?? {})) if (find(who)?.id === card.id) return lookOf(card, look)
    return undefined
  }

  if (params.kind === 'custom') {
    if (params.prompt === undefined || params.prompt.trim().length === 0) throw new ProjectError('novel/invalid', 'a custom illustration needs a prompt')
    const shown = await sheeted((params.characters ?? []).map(find).filter((card): card is CharacterCard => card !== undefined), 'returning')
    const info = await renderImage(core, runtime, {
      subject: params.prompt,
      kind: 'scene',
      name: 'custom',
      art,
      avoid: raw ? [] : [...(params.avoid ?? []), ...negativesOf(shown)],
      references: shown.map(card => referenceOf(card, worn(card))).filter((reference): reference is { path: string; label: string } => reference !== undefined),
      ...(params.size !== undefined ? { size: params.size } : {}),
    }, task)
    return done(info)
  }

  if (params.kind === 'portrait' || params.kind === 'sheet') {
    const found = params.target !== undefined ? await project.findCharacter(params.target) : undefined
    if (found === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.target ?? ''}"`)
    const anchored = await withAnchor(core, runtime, found, task)
    if (looksOf(anchored).length === 0) throw new ProjectError('novel/invalid', `${anchored.name} has no appearance yet — describe how they look first (or let novel_bible expand the card)`)
    // A portrait is drawn after the sheet, and against it: whoever has no sheet yet gets one first.
    const card = params.kind === 'portrait' ? (await sheeted([anchored], 'everyone'))[0]! : anchored

    if (params.kind === 'portrait') {
      const subject = joinParts([
        L(lang, '人物立绘，半身像，面向镜头，纯净的浅色背景', 'character portrait, waist-up, facing the viewer, plain light background'),
        looksOf(card),
        card.personality !== undefined ? L(lang, `神态体现：${clip(card.personality, 60, '')}`, `expression showing: ${clip(card.personality, 80, '')}`) : undefined,
        params.prompt,
      ], comma)
      // A portrait drawn after the sheet shows the same person as the sheet.
      const sheet = card.visual?.sheet !== undefined ? [{ path: card.visual.sheet, label: card.name }] : []
      if (first.drawn.length > 0) task.job?.note(L(lang, '人设图画好了，照着它画立绘…', 'The sheet is drawn; now the portrait, against it…'))
      const info = await renderImage(core, runtime, { subject, kind: 'portrait', target: card.id, name: `portrait-${card.id}`, size: params.size ?? pictureSize(core.currentSettings().image, 'portrait'), art, avoid: [...(params.avoid ?? []), ...negativesOf([card])], references: sheet }, task)
      await project.saveCharacter({ id: card.id, visual: { portrait: info.path } })
      return done(info)
    }

    // A design sheet: the same person from three sides. A named look is derived from the main sheet, so it stays the same person.
    const wanted = params.look?.trim()
    const existing = lookOf(card, wanted)
    const named = wanted !== undefined && wanted.length > 0
    if (named && existing === undefined && (params.prompt === undefined || params.prompt.trim().length === 0)) {
      throw new ProjectError('novel/invalid', `${card.name} has no look called "${wanted}" yet — pass \`prompt\` describing it (clothing, gear, hair) to create it`)
    }
    const look: CharacterLook | undefined = named
      ? { ...existing, id: existing?.id ?? (slugify(wanted, '') || newId('look')), name: existing?.name ?? wanted, ...(params.prompt !== undefined && params.prompt.trim().length > 0 ? { prompt: params.prompt.trim() } : {}) }
      : undefined
    const base = card.visual?.sheet ?? card.visual?.portrait
    const subject = joinParts([
      L(lang, '人物设定图（三视图）：同一个人的全身站姿画三次——正面、侧面、背面，从左到右等距并排，比例与衣着完全一致，表情平静，纯净的浅色背景，不要任何文字与标注', 'character design sheet (turnaround): the same person drawn three times, full body, standing — front view, side view, back view — evenly spaced left to right, identical proportions and clothing, neutral expression, plain light background, no text or labels'),
      looksOf(card, look),
      look !== undefined && base !== undefined ? L(lang, '与参考图是同一个人：脸、发色、体型不变，只换成上面写的这身装束', 'the same person as in the reference: face, hair colour and build unchanged, only the outfit above differs') : undefined,
      look === undefined ? params.prompt : undefined,
    ], comma)
    const info = await renderImage(core, runtime, {
      subject,
      kind: 'sheet',
      target: card.id,
      name: `sheet-${card.id}${look !== undefined ? `-${look.id}` : ''}`,
      size: params.size ?? pictureSize(core.currentSettings().image, 'sheet'),
      art,
      avoid: [...(params.avoid ?? []), ...negativesOf([card])],
      references: base !== undefined ? [{ path: base, label: card.name }] : [],
    }, task)
    if (look === undefined) await project.saveCharacter({ id: card.id, visual: { sheet: info.path } })
    else {
      const looks = [...(card.visual?.looks ?? []).filter(other => other.id !== look.id), { ...look, sheet: info.path }]
      await project.saveCharacter({ id: card.id, visual: { looks } })
    }
    return done(info)
  }

  if (params.kind === 'location') {
    const found = params.target !== undefined ? await project.findWorld(params.target) : undefined
    if (found === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${params.target ?? ''}"`)
    // What it looks like is written down first, from the book: then it is drawn, and drawn the same again.
    const entry = await withLook(core, runtime, found, task)
    const turn = params.event !== undefined ? await turnOf(project, entry, params.event) : undefined
    const subject = joinParts([
      L(lang, '场景设定图，无人物，远景，交代空间结构、材质与光线', 'environment design art, no people, wide shot showing layout, materials and light'),
      // At a turn of its course: as the director writes it is then — the same place, changed by what happened.
      turn !== undefined ? await turnLook(core, runtime, entry, turn, task) : entry.visualPrompt ?? `${entry.name}${comma}${entry.summary ?? clip(entry.body ?? '', 200, '')}`,
      params.prompt,
    ], comma)
    const info = await renderImage(core, runtime, {
      subject,
      kind: 'location',
      target: entry.id,
      name: `location-${entry.id}${turn !== undefined ? `-${turn.chapter}-${turn.kind}` : ''}`,
      size: params.size ?? pictureSize(core.currentSettings().image, 'location'),
      art,
      // What happened is told with the people it happened through; the picture is of the place.
      ...(turn !== undefined ? { avoid: [...(params.avoid ?? []), L(lang, '人物', 'people')] } : params.avoid !== undefined ? { avoid: params.avoid } : {}),
      ...turnAgainst(entry, turn, lang),
    }, task)
    // The place's reference art: scenes set here send it along. A picture of one turn of its course is that turn's.
    if (turn !== undefined) await keepTurnPicture(project, entry, turn, info.path)
    else await project.saveWorld({ id: entry.id, visualImage: info.path })
    return done(info)
  }

  if (params.kind === 'item') {
    const found = params.target !== undefined ? await project.findWorld(params.target) : undefined
    if (found === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${params.target ?? ''}"`)
    const entry = await withLook(core, runtime, found, task)
    const turn = params.event !== undefined ? await turnOf(project, entry, params.event) : undefined
    // A thing is drawn as a thing: alone, whole, close enough to read what it is made of and what is written or carved on it.
    const subject = joinParts([
      L(lang, '关键物品设定图：只画这一件物品，完整入画，居中，干净的浅色素底；看得清形状、材质、纹饰与大小的感觉；没有人物，没有手，画面里不出现任何文字说明', 'design art of one key object: the object alone, whole and centred on a clean pale ground; its shape, material, ornament and sense of size readable; no people, no hands, no lettering'),
      turn !== undefined ? await turnLook(core, runtime, entry, turn, task) : entry.visualPrompt ?? `${entry.name}${comma}${entry.summary ?? clip(entry.body ?? '', 200, '')}`,
      params.prompt,
    ], comma)
    const info = await renderImage(core, runtime, {
      subject,
      kind: 'item',
      target: entry.id,
      name: `item-${entry.id}${turn !== undefined ? `-${turn.chapter}-${turn.kind}` : ''}`,
      size: params.size ?? pictureSize(core.currentSettings().image, 'item'),
      art,
      ...(params.avoid !== undefined ? { avoid: params.avoid } : {}),
      ...turnAgainst(entry, turn, lang),
    }, task)
    // The thing's reference art: pictures that show it send this along, so that it is the same thing every time.
    if (turn !== undefined) await keepTurnPicture(project, entry, turn, info.path)
    else await project.saveWorld({ id: entry.id, visualImage: info.path })
    return done(info)
  }

  if (params.kind === 'cover') {
    const sketch = await bookSketch(runtime, lang)
    const { story, tone, places } = sketch
    const leads = await sheeted(sketch.leads, 'returning')
    const extraAvoid = [...(params.avoid ?? []), ...negativesOf(leads)]
    const route = await core.route('director', runtime, task)
    const response = await core.llm.complete({
      route,
      prompt: coverPromptTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        ...(manifest.genre !== undefined ? { genre: manifest.genre } : {}),
        ...(manifest.themes !== undefined && manifest.themes.length > 0 ? { themes: manifest.themes.join(lang === 'zh' ? '、' : ', ') } : {}),
        ...(manifest.logline !== undefined ? { logline: manifest.logline } : {}),
        story,
        ...(tone.length > 0 ? { tone } : {}),
        leads: leads.map(card => `${card.name}${card.tagline !== undefined ? `（${clip(card.tagline, 60)}）` : ''}: ${looksOf(card, worn(card)) || L(lang, '（未设定外貌）', '(no look defined)')}`).join('\n'),
        places: places.map(entry => `${entry.name}: ${entry.visualPrompt ?? entry.summary ?? clip(entry.body ?? '', 160, '')}`).join('\n'),
        artStyle: art === false ? '' : art.style,
        avoid: mergeAvoid(art === false ? [] : art.avoid, extraAvoid),
        ...(params.prompt !== undefined && params.prompt.trim().length > 0 ? { ask: params.prompt.trim() } : {}),
      }),
      temperature: 0.7,
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    })
    const description = response.text.trim().replace(/^["“]|["”]$/g, '')
    if (description.length === 0) throw new ProjectError('novel/empty', 'the director returned no description for the cover')
    const subject = joinParts([
      L(lang, '小说封面插画，竖幅构图，画面上方留出标题空间，不要出现任何文字', 'novel cover illustration, portrait orientation, space left at the top for a title, no text at all'),
      description,
    ], comma)
    const info = await renderImage(core, runtime, {
      subject,
      kind: 'cover',
      name: 'cover',
      size: params.size ?? pictureSize(core.currentSettings().image, 'cover'),
      art,
      avoid: extraAvoid,
      references: leads.map(card => referenceOf(card, worn(card))).filter((reference): reference is { path: string; label: string } => reference !== undefined),
    }, task)
    return done(info)
  }

  // scene
  const chapter = params.target !== undefined ? await project.findChapter(params.target) : undefined
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.target ?? ''}"`)
  const text = await project.chapterText(chapter.plan.id)
  const range = params.quote !== undefined && params.quote.trim().length > 0 ? fuzzyFind(text, params.quote.trim()) : undefined
  const memory = await project.memory(chapter.plan.id)
  const passage = range !== undefined
    ? text.slice(Math.max(0, range.start - 200), Math.min(text.length, range.end + 200))
    : params.quote ?? memory?.summary ?? chapter.plan.synopsis ?? clip(text, 800)
  if (passage.trim().length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has nothing to illustrate yet`)
  const present = detectCharacters(passage, characters)
  // Whoever of them comes back in the book has a sheet before the scene is drawn: the scene is held against it.
  const cast = await sheeted((present.length > 0 ? present : characters.filter(card => chapter.plan.characters?.includes(card.id) === true)).slice(0, 5), 'returning')
  // Places and things the passage names, as the bible says they look.
  const places = (await project.world()).filter(entry => [entry.name, ...(entry.aliases ?? [])].some(name => name.length >= 2 && passage.includes(name))).slice(0, 6)
  const wardrobe = cast.map(wardrobeOf).filter((line): line is string => line !== undefined)
  const extraAvoid = [...(params.avoid ?? []), ...negativesOf(cast)]
  const route = await core.route('director', runtime, task)
  const response = await core.llm.complete({
    route,
    prompt: illustrationPromptTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      subject: `${passage}${params.prompt !== undefined ? `\n\n${L(lang, '作者的要求', 'The author asks')}: ${params.prompt}` : ''}`,
      cast: cast.map(card => `${card.name}: ${looksOf(card, worn(card)) || L(lang, '（未设定外貌）', '(no look defined)')}`).join('\n'),
      places: places.map(entry => `${entry.name}: ${entry.visualPrompt ?? entry.summary ?? clip(entry.body ?? '', 160, '')}`).join('\n'),
      artStyle: art === false ? '' : art.style,
      avoid: mergeAvoid(art === false ? [] : art.avoid, extraAvoid),
      ...(wardrobe.length > 0 ? { wardrobe: wardrobe.join('\n') } : {}),
    }),
    temperature: 0.6,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  // With a wardrobe to choose from the composer answers in JSON; a plain answer is still a description.
  let description = response.text.trim()
  const picked = new Map<string, CharacterLook>()
  if (wardrobe.length > 0) {
    try {
      const parsed = asRecord(extractJson(response.text))
      description = asText(parsed.description) ?? description
      for (const [who, look] of Object.entries(asRecord(parsed.wearing))) {
        const card = find(who)
        const chosen = card !== undefined ? lookOf(card, asText(look)) : undefined
        if (card !== undefined && chosen !== undefined) picked.set(card.id, chosen)
      }
    } catch {
      // not JSON: the text is the description
    }
  }
  description = description.replace(/^["“]|["”]$/g, '')
  const wearing = (card: CharacterCard): CharacterLook | undefined => worn(card) ?? picked.get(card.id)
  // Where the scene is — and, with no place drawn, a thing it shows: either keeps the picture true to what was settled.
  const place = places.find(entry => entry.visualImage !== undefined && entry.category !== 'item') ?? places.find(entry => entry.visualImage !== undefined)
  // Faces first, and the place they stand in keeps its seat: with room for three references, that is two people and the place.
  const people = cast.map(card => referenceOf(card, wearing(card))).filter((reference): reference is { path: string; label: string } => reference !== undefined)
  const most = referencesOf((await core.settings.get()).image.references)
  const references = place?.visualImage !== undefined
    ? [...people.slice(0, Math.max(0, most - 1)), { path: place.visualImage, label: place.category === 'item' ? L(lang, `物品「${place.name}」`, `the object "${place.name}"`) : L(lang, `场所「${place.name}」`, `the place "${place.name}"`) }]
    : people
  const info = await renderImage(core, runtime, { subject: description, kind: 'scene', target: chapter.plan.id, name: `scene-${chapter.plan.id}`, size: params.size ?? pictureSize(core.currentSettings().image, 'scene'), art, avoid: extraAvoid, references }, task)
  let inserted = false
  if (params.insert === true) {
    const current = await project.chapterText(chapter.plan.id)
    const at = range !== undefined ? fuzzyFind(current, params.quote!.trim()) : undefined
    const alt = clip(description.replace(/[\]\n]/g, ' '), 60, '')
    const tag = `![${alt}](${info.path})`
    let next: string
    if (at !== undefined) {
      // Place the picture after the paragraph the quote ends in.
      const breakAt = current.indexOf('\n', at.end)
      const position = breakAt < 0 ? current.length : breakAt
      next = `${current.slice(0, position)}\n\n${tag}\n\n${current.slice(position).replace(/^\n+/, '')}`
    } else {
      next = `${tag}\n\n${current}`
    }
    await project.saveChapterText(chapter.plan.id, next, { reason: 'before-illustration' })
    inserted = true
  }
  task.job?.result({ path: info.path, ...(first.drawn.length > 0 ? { sheets: first.drawn } : {}) })
  return done(info, inserted)
}

/** References and avoid terms for a picture that shows these characters (comic panels, covers composed elsewhere). */
export function consistencyFor(cards: readonly CharacterCard[]): { references: { path: string; label: string }[]; avoid: string[] } {
  return {
    references: cards.map(card => referenceOf(card)).filter((reference): reference is { path: string; label: string } => reference !== undefined),
    avoid: negativesOf(cards),
  }
}

/** A place entry that matches a name the storyboard or a scene gave. */
export function placeNamed(world: readonly WorldEntry[], name: string | undefined): WorldEntry | undefined {
  if (name === undefined || name.trim().length === 0) return undefined
  return world.find(entry => sameName(entry.name, name) || name.includes(entry.name) || (entry.aliases ?? []).some(alias => sameName(alias, name)))
}

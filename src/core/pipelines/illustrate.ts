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
 *                   for an image model (not the prose of the card) — and
 *                   written with the art direction in hand: the period and
 *                   the forms it fixes are in the anchor itself, over what
 *                   the source text says —, a design
 *                   sheet — front, side and back — and further looks (outfits)
 *                   derived from that sheet. A scene restates the anchor and
 *                   sends the sheet along as a reference image; a place's
 *                   reference art travels the same way. The sheet comes
 *                   first: whoever has none gets one before their portrait,
 *                   and whoever comes back in the book gets one before the
 *                   first scene, panel or cover that shows them — and the
 *                   picture says which sheets were drawn for it. The sheet
 *                   itself is drawn from the words alone, every time: drawn
 *                   again against the one before, it would come back as the
 *                   one before, whatever the anchor says by then.
 *   an avoid list   per Studio, per book, per character and per call, joined
 *                   and sent with every picture.
 *
 * A portrait shows the person in the moment a reader remembers them by: the
 * director picks that moment from the book, it is kept on the card
 * (`visual.scene`) where the author reads and rewrites it, and every later
 * portrait asked for nothing is drawn from it. What the author asks of one
 * portrait — brighter, the night of the fire, looking back — does not take
 * the moment's place: it guides the director's pick for that picture.
 *
 * Every picture records what its prompt was assembled from, part by part,
 * which pictures went along with it, and what reached the image service word
 * for word — so that a look nobody asked for can be traced to where it came from.
 */
import { lookWords, mergeAvoid, PICTURE_TO_CHANGE, pictureSize, pictureWords, resolveArtStyle, sceneFor, scenesOf, sceneWords, splitAvoid, tidyPart as tidy, type ArtSource } from '../../shared/art'
import type { CharacterCard, CharacterLook, CharacterStage, ComicPanel, ImageTrial, TrialPicture, IllustrationInfo, IllustrationParts, IllustrationPiece, IllustrationSent, PromptLanguage, SignatureScene, SortedNotes, WorldEntry, WorldEvent } from '../../shared/types'
import { MAIN_LINE, referencesOf } from '../../shared/types'
import { clip, fuzzyFind, hashText, newId, sameName, slugify } from '../../shared/text'
import { leadOf, PROMPT_HEADROOM, promptTokens, type PictureLead } from '../../shared/images'
import { inStage, looksApart, stageAt } from '../../shared/stages'
import { groupOf } from '../../shared/world'
import { detectCharacters } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText, extractJson } from '../llm'
import { assign } from '../crew'
import { extensionOf, referencesRefused, type ImageProvider, type ImageReference } from '../media/image'
import { frontView } from '../media/front'
import { pixelsOf } from '../media/pixels'
import { castAt } from './growth'
import { keepNotedScenes } from './scenes'
import { ProviderError } from '../media/http'
import { ProjectError } from '../project'
import { artDirectionTask, compactPromptTask, coverPromptTask, illustrationPromptTask, lookNotesTask, lookTask, portraitSceneTask, portraitScenesTask, turnLookTask, visualAnchorTask } from '../prompts'
import { L, promptLanguage, renderCharacter, renderWorld } from '../render'
import { isAbort } from '../util/async'

export { DEFAULT_ART_STYLE } from '../../shared/art'
export type { SortedNotes } from '../../shared/types'

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
  /**
   * Portrait, sheet: ideas the author jotted down, mixed as they came — what is of the person is worked into how they
   * look from now on (the visual anchor, the appearance), what is of this one picture ("a snowy night") directs this
   * picture and goes nowhere else ({@link sortNotes}).
   */
  notes?: string
  /** Sheet: which look (outfit) to draw; a name that does not exist yet creates the look. */
  look?: string
  /** Scene, cover, custom: what each character wears — character name or id → look name. */
  looks?: Record<string, string>
  /** Custom: characters shown — how each looks is written into the prompt, and their sheets go along as references. */
  characters?: string[]
  /** Kept out of this picture, on top of the book's own list. */
  avoid?: string[]
  /** Custom: send the prompt exactly as written — no art direction, no avoid list. */
  raw?: boolean
  /** `false`: this once, draw from what there is — no design sheet is drawn first for whoever lacks one, and none after a portrait that leads (the author was asked, and said so). */
  sheetFirst?: boolean
  /**
   * What this picture of a person is drawn against, this once — whichever of the two leads by the author's setting
   * (`image.lead`). Left out: by that setting.
   * - a sheet (the main one, or a stretch's): `portrait` — their portrait: the same person, turned three ways on a
   *   plain ground; `words` — the words alone.
   * - a portrait: `sheet` — their design sheet (drawn first where they have none); `words` — the words alone: no
   *   sheet is drawn first, and theirs does not go along.
   */
  from?: 'portrait' | 'sheet' | 'words'
  /**
   * Portrait: plain — facing the viewer on a plain ground — and not in their signature scene. What a portrait is where
   * the author turned scenes off (`image.portraitScene`), and what the interlude stage asks for: a figure to stand
   * before a backdrop of its own.
   */
  plain?: boolean
  /** Portrait: which of the person's signature scenes it shows (by id). Left out: the one their card marks, else the first. */
  scene?: string
  /** Portrait, sheet: which stretch of the person's life it shows (a stage's id or title). Left out: the card as it is — or, for a portrait of one of their moments, the stretch that moment falls in. */
  stage?: string
  /**
   * Location, item: draw it as it is from one turn of its course on — built, changed, in ruins — and keep the picture
   * with that turn, not as its design art. Named by the turn's chapter (id or number), or `<chapter>:<kind>` where a
   * chapter has several.
   */
  event?: string
  /**
   * Portrait: draw it once with each of these services, to compare them — the same moment, the same words, the same
   * reference pictures. None of the pictures becomes their portrait: they are among their pictures, kept out of the
   * text, for the author to take one.
   */
  trials?: ImageTrial[]
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
  return [lookWords(card), look?.prompt].filter((value): value is string => value !== undefined && value.length > 0).join('，')
}

/** What a character's wardrobe offers a scene, one line per look. */
export function wardrobeOf(card: CharacterCard): string | undefined {
  const looks = card.visual?.looks ?? []
  if (looks.length === 0) return undefined
  return `${card.name}: ${looks.map(look => `「${look.name}」${look.when !== undefined ? `（${look.when}）` : ''}${look.prompt !== undefined ? ` ${clip(look.prompt, 80, '…')}` : ''}`).join('；')}`
}

/** A picture that goes along with a prompt: where it lies, who or what it shows — and whether it is a design sheet, which shows one person several times over. */
export interface Held { path: string; label: string; sheet?: boolean }

/** The front views cut out of design sheets, by book, sheet and the sheet's size: a sheet is looked into once, however many pictures are held against it. */
const fronts = new Map<string, Promise<Uint8Array | undefined>>()

/** The front view of a sheet of this book; nothing where none can be told apart in it. */
async function frontOf(root: string, path: string, sheet: Uint8Array, signal: AbortSignal | undefined): Promise<Uint8Array | undefined> {
  const key = `${root}\n${path}\n${sheet.byteLength}`
  let found = fronts.get(key)
  if (found === undefined) {
    found = frontView(sheet, signal).catch(() => undefined)
    if (fronts.size >= 64) fronts.delete(fronts.keys().next().value!)
    fronts.set(key, found)
    // Stopped half-way, it is not known to have none.
    void found.then(() => { if (signal?.aborted === true) fronts.delete(key) })
  }
  return await found
}

/** The picture that shows how a character looks: the sheet of the look worn, else the main sheet, else the portrait. */
function referenceOf(card: CharacterCard, look?: CharacterLook): Held | undefined {
  const sheet = look?.sheet ?? card.visual?.sheet
  const path = sheet ?? card.visual?.portrait
  if (path === undefined) return undefined
  // A sheet of three views goes along as its front view (`sheet`); one that is the front view already goes as it is.
  const front = look?.sheet !== undefined ? look.sheetFront === true : card.visual?.sheetFront === true
  return { path, label: look?.sheet !== undefined ? `${card.name}（${look.name}）` : card.name, ...(sheet !== undefined ? { sheet: !front } : {}) }
}

/**
 * Whether a picture that goes along is a design sheet: said where the reference was made — or, for a picture on a
 * record older than that, read off the name the Studio gives every sheet it draws.
 */
const isSheet = (reference: Held): boolean => reference.sheet ?? /(^|\/)sheet-[^/]*$/.test(reference.path)

/**
 * Distill a character's prose appearance into a visual anchor an image model
 * draws the same way every time, and store it on the card.
 * @throws ProjectError `novel/invalid` when the card says nothing about how the character looks.
 */
export async function deriveVisual(core: NovelCore, runtime: ProjectRuntime, params: { character: string; direction?: string; stage?: string }, task: TaskContext): Promise<{ card: CharacterCard; prompt: string; negative?: string }> {
  const { project } = runtime
  const whole = await project.findCharacter(params.character)
  if (whole === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  // Of one stretch of their life: the anchor is written for them as that stretch has them — age, look — starting from
  // the anchor the card keeps, so that it stays the same person, and it is kept with the stretch.
  const stage = params.stage !== undefined ? stageOf(whole, params.stage) : undefined
  const card = stage !== undefined ? { ...inStage(whole, stage), visual: { ...whole.visual, ...(stage.visual?.prompt !== undefined ? { prompt: stage.visual.prompt } : {}) } } : whole
  if (stage !== undefined) {
    const zh = promptLanguage((await project.manifest()).language) === 'zh'
    params = { ...params, direction: [zh
      ? `写的是这个人在「${stage.title}」这个时期的样子${stage.age !== undefined ? `（${stage.age}）` : ''}${stage.what !== undefined ? `——${stage.what}` : ''}。从现有的锚点出发：认得出是同一个人的特征（脸的轮廓、五官、标志性的东西）留着；年龄感、体型、发式、衣着改成这个时期的${stage.appearance !== undefined ? `：${stage.appearance}` : ''}。`
      : `This is the person in the stretch of their life called "${stage.title}"${stage.age !== undefined ? ` (${stage.age})` : ''}${stage.what !== undefined ? ` — ${stage.what}` : ''}. Start from the anchor as it stands: what makes them the same person (the shape of the face, the features, what marks them out) stays; apparent age, build, hair and dress become this stretch's${stage.appearance !== undefined ? `: ${stage.appearance}` : ''}.`, params.direction].filter(Boolean).join('\n') }
  }
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
      // The period and the forms the art direction fixes are written into the look itself: appended after a subject
      // that says otherwise, the art direction changes nothing.
      artStyle: art.style,
      // Written again, an anchor keeps what nothing speaks against: pictures already drawn were drawn from it.
      ...(card.visual?.prompt !== undefined && card.visual.prompt.trim().length > 0 ? { current: card.visual.prompt, ...(card.visual.negative !== undefined ? { currentNegative: card.visual.negative } : {}) } : {}),
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
  if (stage !== undefined) {
    const kept = await keepStage(project, whole.id, stage.id, { prompt, ...(negative !== undefined ? { negative } : {}) })
    return { card: kept, prompt, ...(negative !== undefined ? { negative } : {}) }
  }
  const saved = await project.saveCharacter({ id: card.id, visual: { prompt, negative: negative ?? '' } })
  return { card: saved, prompt, ...(negative !== undefined ? { negative } : {}) }
}

/**
 * Sort the ideas an author jotted down before a picture of somebody: the
 * director says which are of the person — and works those into the visual
 * anchor, and into the appearance where the card does not have them — and
 * which are of this one picture, which direct it and are kept nowhere. What
 * became of each idea is handed back, to be shown.
 *
 * Where no model can be reached nothing is guessed: the notes direct this
 * picture, and the look stays as it is.
 */
export async function sortNotes(core: NovelCore, runtime: ProjectRuntime, card: CharacterCard, notes: string, picture: 'portrait' | 'sheet', task: TaskContext): Promise<{ card: CharacterCard; sorted: SortedNotes }> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const art = await artDirectionOf(core, runtime)
  const restore = task.job?.note(L(lang, '导演正在整理你写的想法…', 'The director is sorting your notes…'))
  try {
    const { value } = await assign(core, runtime, task, {
      role: 'director',
      label: L(lang, `整理想法 · ${card.name}`, `Notes · ${card.name}`),
      tool: 'sort_notes',
      // Everything is in the task: a look or two at the book at most, then the result.
      // All of it is in the task: asked in one request, whatever the role is set to.
      plain: true,
      maxSteps: 8,
      what: L(lang, '作者的想法分成两类：进这个人形象的，和只用在这一张图上的', 'the author\'s ideas, sorted: those that go into how the person looks, and those for this one picture'),
      prompt: lookNotesTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        card: renderCharacter({ ...card, secrets: undefined, relationships: undefined, notes: undefined, life: undefined } as CharacterCard, lang),
        ...(card.visual?.prompt !== undefined ? { anchor: card.visual.prompt } : {}),
        ...(card.visual?.negative !== undefined ? { negative: card.visual.negative } : {}),
        notes,
        picture,
        avoid: art.avoid,
        artStyle: art.style,
      }),
      temperature: 0.2,
      validate: (raw) => {
        const record = asRecord(raw)
        if (asText(record.anchor) === undefined && asText(record.picture) === undefined) throw new Error('both "anchor" and "picture" are empty: every idea is of the person, of this picture, or has no place in it')
        return record
      },
    })
    const kept = asList(value.kept)
    const anchor = asText(value.anchor)
    const negative = asText(value.negative)
    const more = asText(value.appearance)
    const pictureLine = asText(value.picture)
    // The look changes only by what the author's ideas put there: an anchor handed back unchanged is left alone.
    const visual: Record<string, string> = {}
    if (anchor !== undefined && anchor !== card.visual?.prompt) visual.prompt = anchor
    if (negative !== undefined && negative !== card.visual?.negative) visual.negative = negative
    const appearance = more !== undefined && kept.length > 0 && !(card.appearance ?? '').includes(more) ? [card.appearance, more].filter((part): part is string => part !== undefined && part.length > 0).join(lang === 'zh' ? '' : ' ') : undefined
    const saved = Object.keys(visual).length > 0 || appearance !== undefined
      ? await project.saveCharacter({ id: card.id, ...(Object.keys(visual).length > 0 ? { visual } : {}), ...(appearance !== undefined ? { appearance } : {}) })
      : card
    return { card: saved, sorted: { kept, once: asList(value.once), unused: asList(value.unused), ...(pictureLine !== undefined ? { picture: pictureLine } : {}) } }
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    core.log(`could not sort the author's notes on ${card.name}; they direct this picture only`, error)
    return { card, sorted: { kept: [], once: [notes], unused: [], picture: notes, unsorted: true } }
  } finally {
    restore?.()
  }
}

/** A stretch of somebody's life, by id or by what it is called. */
function stageOf(card: CharacterCard, ref: string): CharacterStage {
  const stage = (card.stages ?? []).find(item => item.id === ref || item.title === ref.trim())
  if (stage === undefined) throw new ProjectError('novel/not-found', `${card.name} has no stage "${ref}" — their stages: ${(card.stages ?? []).map(item => `${item.title} (${item.id})`).join(', ') || 'none yet (novel_bible action=derive_growth finds them)'}`)
  return stage
}

/** Keep something written or drawn of one stretch of a life with that stretch. */
async function keepStage(project: ProjectRuntime['project'], character: string, stageId: string, visual: NonNullable<CharacterStage['visual']>, without: readonly (keyof NonNullable<CharacterStage['visual']>)[] = []): Promise<CharacterCard> {
  const card = (await project.findCharacter(character))!
  const merged = (stage: CharacterStage): CharacterStage['visual'] => {
    const next = { ...stage.visual, ...visual }
    for (const key of without) delete next[key]
    return next
  }
  return await project.saveCharacter({ id: card.id, stages: (card.stages ?? []).map(stage => stage.id === stageId ? { ...stage, visual: merged(stage) } : stage) })
}

/** What the director is handed to look for a person's moments with: their card, their look, and where the digests saw them. */
async function sceneBrief(core: NovelCore, runtime: ProjectRuntime, card: CharacterCard) {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const art = await artDirectionOf(core, runtime)
  // What the digests noted of them, chapter by chapter, along the line they are of — in a world of several stories,
  // their own: where to look, not what to draw.
  const home = await project.lineOfCharacter(card)
  const { chapters, lives } = await project.lives(home !== MAIN_LINE ? home : undefined)
  const titles = new Map(chapters.map(chapter => [chapter.id, chapter.title]))
  const record = (lives[card.id]?.events ?? []).filter(event => event.index >= 1).map(event => [
    L(lang, `第 ${event.index} 章《${titles.get(event.chapter) ?? ''}》`, `Chapter ${event.index}, "${titles.get(event.chapter) ?? ''}"`),
    event.what !== undefined ? L(lang, `：${event.what}`, `: ${event.what}`) : '',
    event.where !== undefined ? L(lang, `（${event.where}）`, ` (${event.where})`) : '',
  ].join('')).join('\n')
  const undigested = chapters.filter(chapter => !chapter.digested).length
  const indexOf = new Map(chapters.map(chapter => [chapter.id, chapter.index]))
  return {
    lang,
    chapters,
    /** The line the moments are looked for on: the director reads that one. */
    line: home,
    base: {
      lang,
      language: manifest.language,
      title: manifest.title,
      name: card.name,
      card: renderCharacter({ ...card, secrets: undefined, notes: undefined } as CharacterCard, lang),
      ...(card.visual?.prompt !== undefined && card.visual.prompt.length > 0 ? { anchor: card.visual.prompt } : {}),
      record: [record, undigested > 0 ? L(lang, `（这条线上还有 ${undigested} 章有正文但没有收录，上面没有它们的记载。）`, `(${undigested} more chapters of this line are not digested: nothing above is of them.)`) : ''].filter(part => part.length > 0).join('\n'),
      avoid: art.avoid,
      artStyle: art.style,
    },
    /** A kept moment as the director reads it: by chapter number, not id. */
    told: (scene: SignatureScene) => ({ title: scene.title, text: scene.text, ...(scene.chapter !== undefined && indexOf.has(scene.chapter) ? { chapter: indexOf.get(scene.chapter)! } : {}) }),
  }
}

/** One moment out of a director's answer; nothing where it wrote no picture. */
function readScene(value: Record<string, unknown>, chapters: readonly { id: string; index: number }[]): Omit<SignatureScene, 'id'> | undefined {
  const text = asText(value.scene) ?? asText(value.text) ?? ''
  if (text.length === 0) return undefined
  const index = Number(value.chapter)
  const chapter = Number.isFinite(index) && index >= 1 ? chapters.find(item => item.index === index)?.id : undefined
  const why = asText(value.why)
  return { title: asText(value.title) ?? '', text, ...(chapter !== undefined ? { chapter } : {}), ...(why !== undefined ? { why } : {}) }
}

/**
 * Have the director find the moments of the book a character is remembered by,
 * most their own first, and keep them on the card (`visual.scenes`). The
 * director is an agent with the book to look in: it is handed what the
 * digests noted of this person and reads the text itself. Looked over again,
 * a moment that still holds keeps its id and the portrait drawn of it.
 * @param params.direction - what the author asks of the list: it guides the director.
 * @returns the moments, none where the book has none yet — then the card is left as it was, and `why` says so.
 */
export async function deriveScenes(core: NovelCore, runtime: ProjectRuntime, params: { character: string; direction?: string }, task: TaskContext): Promise<{ card: CharacterCard; scenes: SignatureScene[]; why?: string }> {
  const { project } = runtime
  const card = await project.findCharacter(params.character)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  const brief = await sceneBrief(core, runtime, card)
  const { lang } = brief
  const kept = scenesOf(card)
  const restore = task.job?.note(L(lang, `导演在书里找「${card.name}」的名场面…`, `The director is finding the signature scenes of ${card.name} in the book…`))
  try {
    const { value } = await assign(core, runtime, task, {
      role: 'director',
      label: L(lang, `名场面 · ${card.name}`, `Signature scenes · ${card.name}`),
      line: brief.line,
      tool: 'set_signature_scenes',
      // The digests' notes come with the task; each moment is read in the text — a search, a passage or two — then the result.
      maxSteps: 24,
      what: L(lang, '这个人物的名场面：立绘从里面挑一幕来画', 'this character\'s signature scenes: a portrait is drawn from one of them'),
      prompt: portraitScenesTask({
        ...brief.base,
        ...(kept.length > 0 ? { scenes: kept.map(brief.told) } : {}),
        ...(params.direction !== undefined && params.direction.trim().length > 0 ? { direction: params.direction.trim() } : {}),
      }),
      temperature: 0.4,
      validate: raw => asRecord(raw),
    })
    const why = asText(value.why)
    const taken = new Set<string>()
    const scenes: SignatureScene[] = []
    for (const item of asArray(value.scenes)) {
      const read = readScene(asRecord(item), brief.chapters)
      if (read === undefined) continue
      // The one it says this was — or one of the same name — is the same moment still: its id and its portrait stay.
      const was = Number(asRecord(item).was)
      const before = (Number.isInteger(was) && was >= 1 ? kept[was - 1] : undefined) ?? kept.find(scene => scene.title === read.title)
      const same = before !== undefined && !taken.has(before.id) ? before : undefined
      if (same !== undefined) taken.add(same.id)
      scenes.push({ ...read, id: same !== undefined && same.id !== 'kept' ? same.id : newId('scene'), title: read.title.length > 0 ? read.title : same?.title ?? clip(read.text, 10, ''), ...(same?.portrait !== undefined ? { portrait: same.portrait } : {}) })
    }
    if (scenes.length === 0) return { card, scenes: [], ...(why !== undefined ? { why } : {}) }
    // The single paragraph of an earlier version is read into the list; what the list is, is the list from now on.
    const chosen = scenes.some(scene => scene.id === card.visual?.sceneAt) ? {} : { sceneAt: '' }
    const saved = await project.saveCharacter({ id: card.id, visual: { scenes, scene: '', ...chosen } })
    await project.addActivity({ by: 'crew', role: 'director', tool: 'art', summary: L(lang, `给「${card.name}」找了 ${scenes.length} 个名场面：${scenes.map(scene => scene.title).join('、')}`, `Found ${scenes.length} signature scene(s) of ${card.name}: ${scenes.map(scene => scene.title).join(', ')}`) })
    return { card: saved, scenes, ...(why !== undefined ? { why } : {}) }
  } finally {
    restore?.()
  }
}

/**
 * Have the director settle and write the moment one portrait shows, by what
 * the author asked of that portrait: among the moments the card keeps, or
 * another of the book's. Nothing is kept — it serves the one picture.
 * @param params.scene - the moment the author chose for this portrait (by id); the card's own choice otherwise.
 */
async function guidedScene(core: NovelCore, runtime: ProjectRuntime, card: CharacterCard, params: { direction: string; scene?: string }, task: TaskContext): Promise<{ scene?: Omit<SignatureScene, 'id'>; why?: string }> {
  const brief = await sceneBrief(core, runtime, card)
  const { lang } = brief
  const first = sceneFor(card, params.scene)
  const kept = first !== undefined ? [first, ...scenesOf(card).filter(scene => scene.id !== first.id)] : scenesOf(card)
  const restore = task.job?.note(L(lang, `导演在按你写的要求，定「${card.name}」这张立绘画哪一幕…`, `The director is settling which moment this portrait of ${card.name} shows, by what you asked…`))
  try {
    const { value } = await assign(core, runtime, task, {
      role: 'director',
      label: L(lang, `这张立绘的场面 · ${card.name}`, `This portrait's scene · ${card.name}`),
      line: brief.line,
      tool: 'set_portrait_scene',
      maxSteps: 14,
      what: L(lang, '这一张立绘画的那一幕', 'the moment this one portrait shows'),
      prompt: portraitSceneTask({ ...brief.base, ...(kept.length > 0 ? { scenes: kept.map(brief.told) } : {}), direction: params.direction }),
      temperature: 0.4,
      validate: raw => asRecord(raw),
    })
    const read = readScene(value, brief.chapters)
    const why = asText(value.why)
    return { ...(read !== undefined ? { scene: read } : {}), ...(why !== undefined ? { why } : {}) }
  } finally {
    restore?.()
  }
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
      kind: group === 'items' ? 'thing' : group === 'factions' ? 'house' : 'place',
      entry: renderWorld({ ...entry, visualPrompt: undefined } as WorldEntry, lang),
      passages: passages.join('\n'),
      avoid: art.avoid,
      artStyle: art.style,
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
        artStyle: art.style,
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
  /** The subject part by part, where it was put together from parts ({@link compose}): kept with the picture. */
  pieces?: IllustrationPiece[]
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
  references?: Held[]
  /** What the references are for, where it is not "whoever and whatever they show must match": said after their list, in its place. */
  referenceNote?: string
  /**
   * The picture is another one changed in one thing — the first of `references` — and this is what to change. With
   * that picture along it is the whole prompt: the picture says the rest, and a line of description, of art
   * direction or of what the picture is for would only be said twice. Where the picture cannot go (an image service
   * that takes none), the subject stands in for it, and everything else is as for any picture.
   */
  change?: string
  /** With `change`: what the picture to change was held against when it was drawn from words — kept with the new one, for when that is drawn from words again. */
  heldAgainst?: Held[]
  /** A portrait of one of somebody's moments: kept with the picture, which stands in the text where that moment is told. */
  moment?: NonNullable<IllustrationInfo['moment']>
  /** One of several pictures of the same thing drawn to compare services: said on its record. */
  trial?: NonNullable<IllustrationInfo['trial']>
}

/**
 * Draw the same picture once with each of several services, at the same time: the same words, the same reference
 * pictures, each service's own size for it. None of them hangs anywhere — they are in the gallery, kept out of the
 * text, for the author to take one (or none). A service that fails says why and does not keep the others.
 * @param draw - draws the picture with whatever service is in force when it is called.
 */
export async function drawTrials(core: NovelCore, runtime: ProjectRuntime, trials: readonly ImageTrial[], draw: (trial: NonNullable<IllustrationInfo['trial']>) => Promise<IllustrationInfo>, task: TaskContext): Promise<{ pictures: TrialPicture[]; first?: IllustrationInfo }> {
  const id = newId('trial')
  const pictures: TrialPicture[] = trials.map(trial => ({ label: trial.label, seconds: 0 }))
  let first: IllustrationInfo | undefined
  const say = (): void => { task.job?.result({ trial: pictures.map(picture => ({ ...picture })) }) }
  say()
  await Promise.all(trials.map(async (trial, at) => {
    const began = Date.now()
    try {
      const info = await core.trial({ image: trial.image }, () => draw({ id, label: trial.label }))
      // A picture drawn to be compared is not one the text carries until the author takes it.
      await runtime.project.showFigure(info.path, false)
      pictures[at] = { label: trial.label, path: info.path, ...(info.model !== undefined ? { model: info.model } : {}), seconds: Math.round((Date.now() - began) / 100) / 10 }
      first ??= info
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      pictures[at] = { label: trial.label, seconds: Math.round((Date.now() - began) / 100) / 10, error: error instanceof Error ? error.message : String(error) }
    }
    say()
  }))
  return { pictures, ...(first !== undefined ? { first } : {}) }
}

/** Join the parts of a subject into one line, each part without the punctuation it ended on. */
const joinParts = (parts: readonly (string | undefined)[], comma: string): string => parts.filter((part): part is string => part !== undefined && part.trim().length > 0).map(tidy).join(comma)

/** One part of a subject, where there are words for it. */
const piece = (of: IllustrationPiece['of'], text: string | undefined, from?: IllustrationPiece['from']): IllustrationPiece | undefined => (text !== undefined && text.trim().length > 0 ? { of, text, ...(from !== undefined ? { from } : {}) } : undefined)

/**
 * Put a subject together from its parts and keep the parts, for the record of the picture. A part a line: what the
 * picture is of first, then who is in it and how each looks, then the place and the things — each said once, under
 * its own name. Run together into one sentence, a model that reads loosely could not tell whose hair was whose.
 */
function compose(parts: readonly (IllustrationPiece | undefined)[]): Pick<RenderInput, 'subject' | 'pieces'> {
  const pieces = parts.filter((part): part is IllustrationPiece => part !== undefined).map(part => ({ ...part, text: tidy(part.text) })).filter(part => part.text.length > 0)
  return { subject: pieces.map(part => `${part.label ?? ''}${part.text}`).join('\n'), pieces }
}

/** A part of a subject under the words that introduce it on its line. */
const labelled = (part: IllustrationPiece | undefined, label: string): IllustrationPiece | undefined => (part !== undefined ? { ...part, label } : undefined)

/** Where the words for how somebody looks are taken from: their visual anchor, or — lacking one — the prose of the card. */
const lookFrom = (card: CharacterCard): NonNullable<IllustrationPiece['from']> => (card.visual?.prompt !== undefined && card.visual.prompt.length > 0 ? 'anchor' : 'card')

/** Generate one image, store it under `assets/images/`, and record what its prompt was made of. */
/** Prompts the director fitted, by what was asked: the same prompt for the same model comes to the same words again. */
const fittedPrompts = new Map<string, string>()

/** Forget the prompts that were fitted. For tests. */
export function forgetFittedPrompts(): void {
  fittedPrompts.clear()
}

/** A text with as much of its end left off as brings it within so many tokens: whole phrases, where it has any. */
function clipTokens(text: string, limit: number): string {
  const phrases = text.split(/(?<=[，。；、,.;\n])/u)
  while (phrases.length > 1 && promptTokens(phrases.join('')) > limit) phrases.pop()
  let kept = phrases.join('').trim().replace(/[，；、,;]$/u, '')
  while (promptTokens(kept) > limit && kept.length > 1) kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.95)))
  return kept
}

/** What a prompt would come to with what is kept out written after it, the way a service with no field for that gets it. */
const withAvoided = (prompt: string, avoid: readonly string[], zh: boolean): string => (avoid.length > 0 ? `${prompt}\n\nAvoid: ${avoid.join(zh ? '、' : ', ')}` : prompt)

/**
 * A prompt that comes to more than the model reads, written again by the director to fit: the same picture in fewer
 * words, where cutting it off would lose whatever stood last — the art direction, what to keep out. Nothing is asked
 * where the model has room, where no limit is known, or where the author turned this off; a director that cannot be
 * had leaves the prompt as it was, and the picture's record says so.
 * @returns the prompt to send, whether what is kept out is now part of it, and what was done for the record.
 */
async function fitPrompt(core: NovelCore, runtime: ProjectRuntime, provider: ImageProvider, input: { prompt: string; avoid: string[]; references: number }, task: TaskContext): Promise<{ prompt: string; folded: boolean; compact?: NonNullable<IllustrationSent['compact']> }> {
  const asIs = { prompt: input.prompt, folded: false }
  if ((await core.imageOf(runtime)).promptCompact === false) return asIs
  const room = await provider.prompting?.(task.signal).catch(() => undefined)
  if (room?.tokens === undefined) return asIs
  const manifest = await runtime.project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  // What is kept out counts where it travels in the prompt, and not where the service takes it apart from it.
  const from = promptTokens(room.avoidInPrompt ? withAvoided(input.prompt, input.avoid, zh) : input.prompt)
  // Counted by estimate, so held to a little under what the model reads.
  const limit = Math.max(1, Math.floor(room.tokens * PROMPT_HEADROOM))
  if (from <= limit) return asIs
  // The same picture asked for again — drawn again, a panel redone — is not written again.
  const key = hashText(`${provider.model}\n${limit}\n${room.avoidInPrompt}\n${input.references > 0 && room.references !== 0}\n${input.prompt}\n${input.avoid.join('|')}`)
  const before = fittedPrompts.get(key)
  if (before !== undefined) return { prompt: before, folded: room.avoidInPrompt, compact: { limit: room.tokens, from, tokens: promptTokens(before) } }
  // The nearest the director came, where every try was over: written with what matters first, it loses least at its end.
  let nearest: string | undefined
  const restore = task.job?.note(L(lang, `导演在把提示词压到 ${limit} 个 token 以内（现在约 ${from} 个）…`, `The director is bringing the prompt within ${limit} tokens (about ${from} now)…`))
  try {
    const { value } = await assign(core, runtime, task, {
      role: 'director',
      label: L(lang, '压缩提示词', 'Fitting a prompt'),
      tool: 'fit_prompt',
      // Everything is in the task; a try or two at the length.
      // All of it is in the task: asked in one request, whatever the role is set to.
      plain: true,
      maxSteps: 6,
      what: L(lang, `同一张图的提示词，不超过 ${limit} 个 token`, `the same picture's prompt, in no more than ${limit} tokens`),
      prompt: compactPromptTask({ lang, language: manifest.language, title: manifest.title, prompt: input.prompt, avoid: input.avoid, tokens: limit, estimate: from, model: provider.model, references: input.references > 0 && room.references !== 0, avoidInPrompt: room.avoidInPrompt }),
      temperature: 0.2,
      validate: (raw) => {
        const text = asText(asRecord(raw).prompt)
        if (text === undefined) throw new Error('"prompt" is empty')
        const tokens = promptTokens(text)
        if (tokens > limit && (nearest === undefined || tokens < promptTokens(nearest))) nearest = text
        if (tokens > limit) throw new Error(`the prompt comes to about ${tokens} tokens; it has to be at most ${limit} — about ${Math.ceil((tokens - limit) * 100 / tokens)}% shorter still`)
        return text
      },
    })
    if (fittedPrompts.size >= 500) fittedPrompts.delete(fittedPrompts.keys().next().value!)
    fittedPrompts.set(key, value)
    return { prompt: value, folded: room.avoidInPrompt, compact: { limit: room.tokens, from, tokens: promptTokens(value) } }
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    if (nearest !== undefined && promptTokens(nearest) < from) {
      const cut = clipTokens(nearest, limit)
      core.log(`the director's prompt was still over ${limit} tokens; its end was left off`, error)
      return { prompt: cut, folded: room.avoidInPrompt, compact: { limit: room.tokens, from, tokens: promptTokens(cut), cut: true } }
    }
    core.log(`could not bring a prompt within ${limit} tokens; it goes as it is`, error)
    return { ...asIs, compact: { limit: room.tokens, from, failed: true } }
  } finally {
    restore?.()
  }
}

export async function renderImage(core: NovelCore, runtime: ProjectRuntime, input: RenderInput, task: TaskContext): Promise<IllustrationInfo> {
  const { project } = runtime
  const provider = await requireImages(core, runtime)
  const zh = promptLanguage((await project.manifest()).language) === 'zh'
  const references: (Held & { front?: boolean; image: ImageReference })[] = []
  // How many pictures the way to the model takes, where it is known before one is sent — what the service says of the
  // model, or what an earlier picture found out. None: the prompt is written without a word of any (it would speak of
  // pictures that never arrive, and spend on them what little room some models have). Not known: they are sent.
  const taken = (await provider.prompting?.(task.signal).catch(() => undefined))?.references
  const own = referencesOf((await core.imageOf(runtime)).references)
  const most = Math.min(own, taken ?? Number.POSITIVE_INFINITY)
  const wanted = (input.references ?? []).filter((reference, at, all) => all.findIndex(other => other.path === reference.path) === at)
  // What the service's own measure keeps back, of those the author's setting would have sent: kept with the picture.
  /** As a record keeps it: where, who — and that it is a sheet, for the picture drawn again from that record. */
  const stayed = (reference: Held): Held => ({ path: reference.path, label: reference.label, ...(reference.sheet === false ? { sheet: false } : isSheet(reference) ? { sheet: true } : {}) })
  /** …and, of one that went, that it went as its front view. */
  const kept = (reference: Held & { front?: boolean }): Held & { front?: boolean } => ({ ...stayed(reference), ...(reference.front === true ? { front: true } : {}) })
  let left: Held[] = taken === undefined ? [] : wanted.slice(taken, own).map(stayed)
  for (const reference of wanted) {
    if (references.length >= most) break
    try {
      const data = await project.readFile(reference.path)
      // A design sheet goes as its front view alone, wherever the picture asked for is not itself a sheet: handed all
      // three figures a model draws three people, and no words about what a sheet is kept one from it (TODO #191).
      const front = input.kind !== 'sheet' && isSheet(reference) ? await frontOf(project.root, reference.path, data, task.signal) : undefined
      references.push(front !== undefined
        ? { ...stayed(reference), front: true, image: { data: front, mime: 'image/png', label: reference.label } }
        : { ...stayed(reference), image: { data, mime: /\.jpe?g$/i.test(reference.path) ? 'image/jpeg' : /\.webp$/i.test(reference.path) ? 'image/webp' : 'image/png', label: reference.label } })
    } catch {
      // A reference whose file is gone is simply not sent.
    }
  }
  const art = input.art === false ? undefined : input.art
  const styleLine = art !== undefined ? `${zh ? '画风：' : 'Style: '}${tidy(art.style)}` : undefined
  const avoid = art !== undefined || (input.avoid?.length ?? 0) > 0 ? mergeAvoid(art?.avoid, input.avoid) : []
  const whole = tidy(input.subject)
  const change = input.change !== undefined ? tidy(input.change) : ''
  /** The picture, held against these. */
  const draw = async (held: typeof references) => {
    // One picture changed, and it is there: what to change in it is all there is to say.
    if (change.length > 0 && held.length > 0) {
      const prompt = clip(change, 1900, '…')
      const fitted = await fitPrompt(core, runtime, provider, { prompt, avoid: [], references: 1 }, task)
      const result = await provider.generate({
        prompt: fitted.prompt,
        // Nothing is to be written after it: not the list of this picture, not the one a setting holds.
        negativePrompt: '',
        ...(input.size !== undefined ? { size: input.size } : {}),
        references: [held[0]!.image],
        change: true,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
      })
      return { held: held.slice(0, 1), referenceLine: undefined, subject: prompt, prompt, fitted, result, changed: true }
    }
    const referenceLine = held.length === 0 ? undefined : zh
      ? `参考图：${held.map((reference, index) => `第${index + 1}张是${reference.label}`).join('；')}。${input.referenceNote ?? '画面里出现的这些人物和场所必须与各自的参考图一致（脸、发型、体型、服装、结构与材质）；构图、动作与光线以本描述为准。'}`
      : `Reference images: ${held.map((reference, index) => `#${index + 1} shows ${reference.label}`).join('; ')}. ${input.referenceNote ?? 'Whoever and whatever they show must match their reference (face, hair, build, clothing, structure and materials); composition, action and light follow this description.'}`
    // The subject gives way before the lines that keep the book consistent do.
    const tail = [referenceLine, styleLine].filter((line): line is string => line !== undefined).join('\n')
    const subject = clip(whole, Math.max(200, 1900 - tail.length), '…')
    const prompt = tail.length > 0 ? `${subject}\n${tail}` : subject
    // A model that reads less than this comes to gets the same picture in fewer words, written by the director.
    const fitted = await fitPrompt(core, runtime, provider, { prompt, avoid, references: held.length }, task)
    const result = await provider.generate({
      prompt: fitted.prompt,
      // What is kept out was worked into the prompt that fits: nothing is to be written after it again.
      ...(fitted.folded ? { negativePrompt: '' } : avoid.length > 0 ? { negativePrompt: avoid.join(zh ? '、' : ', ') } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(held.length > 0 ? { references: held.map(reference => reference.image) } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    })
    return { held, referenceLine, subject, prompt, fitted, result, changed: false }
  }
  // Sent with its pictures, the service would not have them: nobody knew before. It is drawn from the words alone —
  // written anew, without a word of the pictures — and what the service answered is kept with it, to be said once
  // the picture is there.
  let leftWhy: string | undefined
  let drawn: Awaited<ReturnType<typeof draw>>
  try {
    drawn = await draw(references)
  } catch (error) {
    if (references.length === 0 || !referencesRefused(error)) throw error
    core.log(`the image service would not take the reference pictures; drawing from the words alone`, error)
    leftWhy = clip(error.message, 240, '…')
    left = [...references.map(stayed), ...left]
    const restore = task.job?.note(zh ? '绘图服务没有收参考图，改成只照文字画…' : 'The image service would not take the reference pictures; drawing from the words alone…')
    try {
      drawn = await draw([])
    } finally {
      restore?.()
    }
  }
  // To be changed, and the way to the model took the words without the picture — which only the drawing showed: what
  // came back is the change and nothing of the picture. Drawn again, from the words that stand in for it.
  if (drawn.changed && drawn.result.referencesUsed === 0) {
    left = [...references.map(stayed), ...left]
    const restore = task.job?.note(zh ? '绘图服务没有收原图，改成照文字画…' : 'The image service did not take the picture; drawing from the words…')
    try {
      drawn = await draw([])
    } finally {
      restore?.()
    }
  }
  const { result, referenceLine, subject, prompt, fitted } = drawn
  // Said with the picture, now that it is there: what the service did not take along. (Never before: what a service
  // takes is the service's to show.)
  if (left.length > 0) task.job?.result({ left: { names: left.map(reference => reference.label), taken: Math.min(drawn.held.length, result.referencesUsed ?? drawn.held.length), ...(leftWhy !== undefined ? { why: leftWhy } : {}) } })
  // Named apart from every other picture: two drawn from the same words in the same instant (the same picture tried with
  // several services at once) are two files, not one written twice.
  const file = `images/${input.name}-${hashText(`${prompt}${Date.now()}${Math.random()}`).slice(0, 8)}.${extensionOf(result.mime)}`
  const path = await project.writeAsset(file, result.data)
  const used = drawn.held.slice(0, result.referencesUsed ?? drawn.held.length)
  // The picture went along to be changed: the record says what was sent — the picture, and the change — and keeps
  // beside it what the picture shows in words, of which nothing was sent.
  const parts: IllustrationParts = drawn.changed ? {
    subject,
    pieces: [{ of: 'change', text: subject }],
    ...(subject !== change ? { clipped: true } : {}),
    ...(used.length > 0 ? { references: used.map(kept) } : {}),
    base: {
      subject: whole,
      ...(art !== undefined ? { style: art.style, styleSource: art.source } : {}),
      ...(avoid.length > 0 ? { avoid } : {}),
      ...(input.heldAgainst !== undefined && input.heldAgainst.length > 0 ? { references: input.heldAgainst } : {}),
    },
  } : {
    subject,
    ...(input.pieces !== undefined && input.pieces.length > 0 ? { pieces: input.pieces } : {}),
    ...(subject !== whole ? { clipped: true } : {}),
    ...(art !== undefined ? { style: art.style, styleSource: art.source } : {}),
    ...(avoid.length > 0 ? { avoid } : {}),
    ...(used.length > 0 ? { references: used.map(kept) } : {}),
    // Kept also where the pictures did not go though the prompt spoke of them — a way to the model that takes none and
    // says so only by drawing without them.
    ...(referenceLine !== undefined ? { referenceNote: referenceLine } : {}),
    ...(left.length > 0 ? { left } : {}),
    ...(leftWhy !== undefined ? { leftWhy } : {}),
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
    provider: provider.kind,
    ...(input.size !== undefined ? { size: input.size } : {}),
    ...(result.sent !== undefined ? { sent: { ...result.sent, ...(fitted.compact !== undefined ? { compact: fitted.compact } : {}) } } : {}),
    ...(input.moment !== undefined && Object.keys(input.moment).length > 0 ? { moment: input.moment } : {}),
    ...(input.trial !== undefined ? { trial: input.trial } : {}),
  }
  if (input.record !== false) await project.addIllustration(info)
  return info
}

// ───────────────────────────── a picture, drawn again ─────────────────────────────

/** What a picture drawn again says of itself, beside what any picture does. */
export interface RedrawResult extends IllustrationInfo {
  /** Whose picture the new one is now, by name: it took the old one's place there. Empty: it is in the gallery, and hangs nowhere. */
  replaced: string[]
  /** Drawn with several services to compare them: what each made of it. Nothing was replaced. */
  tried?: TrialPicture[]
}

/**
 * Draw a picture again from its record — whatever kind it is: a portrait, a design sheet, the art of a place or a
 * thing, a scene, a cover, a picture of the author's own prompt.
 *
 * Two ways, and both start from the one picture. Its *words rewritten*: what the author made of its subject takes
 * the subject's place, and the rest goes along as it did — the art direction as the book has it now (none, for a
 * picture that had none), what it kept out, the pictures it was held against. Or *one thing changed*: the picture
 * itself goes to the model with what to change in it, and with nothing else — the picture says everything the words
 * of its making said, and says it better. That needs an image service that takes a picture: where it takes none, the
 * picture's words stand in for it, the change said after them, and the record of the new picture says so.
 *
 * The new picture takes the old one's place wherever it hangs (`Project.replacePicture`); the old one stays in the
 * gallery, and among somebody's portraits.
 * @param params.picture - the picture: the id of its record, or its path.
 * @throws ProjectError `novel/not-found` for a picture with no record — nothing says what it was drawn from.
 */
export async function redrawPicture(core: NovelCore, runtime: ProjectRuntime, params: { picture: string; subject?: string; change?: string; /** Draw it as it is, once with each of these services, to compare them: nothing is replaced. */ trials?: ImageTrial[] }, task: TaskContext): Promise<RedrawResult> {
  const { project } = runtime
  await requireImages(core, runtime)
  // Any picture of the book: one on record, or a panel drawn before panels were kept on record.
  const record = (await project.pictures()).find(item => item.id === params.picture || item.path === params.picture)
  if (record === undefined) throw new ProjectError('novel/not-found', `no picture on record matches "${params.picture}"`)
  const lang = promptLanguage((await project.manifest()).language)
  const comma = lang === 'zh' ? '，' : ', '
  const subject = params.subject?.trim() ?? ''
  const change = params.change?.trim() ?? ''
  const trying = params.trials !== undefined && params.trials.length > 0
  if (subject.length === 0 && change.length === 0 && !trying) throw new ProjectError('novel/invalid', 'say what to draw: the picture\'s words rewritten (`subject`), or what to change in it (`change`)')
  // What the picture shows in words — its own, or, where it is itself a picture changed, those kept of the one it came from.
  let was = pictureWords(record)
  // A panel of which nothing was kept but the director's words is held against what its storyboard says is in it —
  // the sheets of the people, the art of the place and of a thing — as a panel drawn today is.
  if (record.kind === 'panel' && record.parts === undefined) {
    const at = await project.panelOf(record.path)
    if (at !== undefined) {
      const makings = panelMakings(at.panel, { thingArt: (await core.imageOf(runtime)).panelThings !== false, characters: await castAt(runtime, at.board.chapterId, await project.characters()), world: await project.world(), most: referencesOf((await core.imageOf(runtime)).references), lang })
      was = { ...was, subject: makings.subject, ...(makings.references.length > 0 ? { references: makings.references } : {}), ...(makings.avoid.length > 0 ? { avoid: makings.avoid } : {}) }
    }
  }
  // A picture drawn with no art direction — a prompt sent as written — gets none now.
  const art = was.art ? await artDirectionOf(core, runtime, { pin: true }) : false as const
  const words = change.length > 0
    ? compose([piece('composed', subject.length > 0 ? subject : was.subject), piece('ask', change)])
    // Tried with other services as it is: the words it was drawn from, unchanged.
    : compose([piece(subject.length > 0 ? 'ask' : 'composed', subject.length > 0 ? subject : was.subject)])
  // Changed, it keeps the frame of the picture it comes from — as that picture is, which is not always as it was asked for.
  const frame = change.length > 0 ? await project.readFile(record.path).then(pixelsOf).catch(() => undefined) : undefined
  const size = frame !== undefined ? `${frame.width}x${frame.height}` : record.size
  const render = async (trial?: NonNullable<IllustrationInfo['trial']>): Promise<IllustrationInfo> => await renderImage(core, runtime, {
    ...words,
    ...(trial !== undefined ? { trial } : {}),
    kind: record.kind,
    ...(record.target !== undefined ? { target: record.target } : {}),
    // The file is named as the one it comes after.
    name: record.path.split('/').pop()!.replace(/-[0-9a-f]{8}\.[a-z]+$/i, '').replace(/\.[a-z]+$/i, ''),
    ...(size !== undefined ? { size } : {}),
    art,
    ...(record.moment !== undefined ? { moment: record.moment } : {}),
    avoid: was.avoid ?? [],
    ...(change.length > 0
      ? { change, references: [{ path: record.path, label: L(lang, PICTURE_TO_CHANGE.zh, PICTURE_TO_CHANGE.en) }], heldAgainst: was.references ?? [] }
      : { references: was.references ?? [] }),
  }, task)
  if (trying) {
    // The same picture by other services, beside the one there is: nothing takes its place until the author says so.
    const tried = await drawTrials(core, runtime, params.trials!, render, task)
    if (tried.first === undefined) throw new ProviderError(tried.pictures.map(picture => `${picture.label}: ${picture.error ?? 'no picture'}`).join('; '), undefined, 'TRIAL_FAILED')
    return { ...tried.first, replaced: [], tried: tried.pictures }
  }
  const info = await render()
  const replaced = await project.replacePicture(record.path, info.path)
  // A portrait that hung nowhere — an earlier one, out of the gallery — is a portrait of theirs all the same: it joins the others, first.
  if (replaced.length === 0 && record.kind === 'portrait' && record.target !== undefined) {
    const card = await project.findCharacter(record.target)
    if (card !== undefined) {
      await project.saveCharacter({ id: card.id, visual: { portrait: info.path } })
      replaced.push(card.name)
    }
  }
  task.job?.result({ replaced })
  return { ...info, replaced }
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
 * Whose design sheet would be drawn before a picture of these people: those
 * who have none, have a look to draw one from, and — unless a portrait of
 * them is what is asked for — come back in the book. Nobody, where the author
 * turned this off (`image.sheetFirst`).
 * @param who - `everyone`: each of them (a portrait is asked for). `returning`: those who come back in the book ({@link comingBack}).
 */
export async function lackingSheets(core: NovelCore, runtime: ProjectRuntime, people: readonly CharacterCard[], who: 'everyone' | 'returning', given?: PictureLead): Promise<CharacterCard[]> {
  const lead = given ?? leadOf(await core.imageOf(runtime))
  // Nothing is drawn for another picture's sake; and where the portrait leads, nothing comes before a portrait.
  if (lead === 'none' || (lead === 'portrait' && who === 'everyone')) return []
  // Nothing says how they look: there is nothing to draw a sheet from, and a picture is made of what the passage gives.
  const lacking = people.filter(card => card.visual?.sheet === undefined && looksOf(card).length > 0)
  if (lacking.length === 0 || who === 'everyone') return lacking
  const back = await comingBack(runtime.project, lacking)
  return lacking.filter(card => back.has(card.id))
}

/**
 * Before somebody is drawn, see that they have a design sheet: the one
 * picture every later picture of them is held against. Without it a portrait,
 * a scene and a panel each invent the face anew.
 * @returns the people with their sheets, and which sheets this call drew; nothing is drawn where the author turned this off (`image.sheetFirst`).
 */
export async function sheetsFirst(core: NovelCore, runtime: ProjectRuntime, people: readonly CharacterCard[], who: 'everyone' | 'returning', task: TaskContext, lead?: PictureLead): Promise<SheetsFirst> {
  const { project } = runtime
  const out: SheetsFirst = { cards: [...people], drawn: [], failed: [] }
  const todo = await lackingSheets(core, runtime, people, who, lead)
  if (todo.length === 0) return out
  const lang = promptLanguage((await project.manifest()).language)
  task.signal?.throwIfAborted()
  // None of these sheets waits for another: they are drawn side by side, as many at once as the image service is
  // given (its gate), and the picture that needs them goes on when the last is there.
  const restore = todo.length > 1 ? task.job?.note(L(lang, `先画 ${todo.length} 张人设图（同时画）：${todo.map(card => card.name).join('、')}…`, `First ${todo.length} design sheets, side by side: ${todo.map(card => card.name).join(', ')}…`)) : undefined
  try {
    await Promise.all(todo.map(async (card) => {
      const key = `${project.root}\n${card.id}`
      let underway = sheetsUnderway.get(key)
      const mine = underway === undefined
      if (underway === undefined) {
        const said = todo.length === 1 ? task.job?.note(L(lang, `先画「${card.name}」的人设图…`, `First the design sheet of ${card.name}…`)) : undefined
        // Drawn for a portrait that is to be held against it, it is drawn from the words: against the portrait there is,
        // the new one would only come back as the old.
        underway = illustrate(core, runtime, { kind: 'sheet', target: card.id, ...(lead === 'sheet' ? { from: 'words' as const } : {}) }, task).then(() => undefined).finally(() => {
          sheetsUnderway.delete(key)
          said?.()
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
    }))
  } finally {
    restore?.()
  }
  // As they are now: with the sheets just drawn, by this call or by one that ran beside it.
  const fresh = await project.characters()
  out.cards = people.map(card => fresh.find(candidate => candidate.id === card.id) ?? card)
  return out
}

/** The passage a scene is drawn of, and who is in it. */
async function sceneOf(project: ProjectRuntime['project'], params: Pick<IllustrateParams, 'target' | 'quote'>, characters: readonly CharacterCard[]) {
  const chapter = params.target !== undefined ? await project.findChapter(params.target) : undefined
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.target ?? ''}"`)
  const text = await project.chapterText(chapter.plan.id)
  const range = params.quote !== undefined && params.quote.trim().length > 0 ? fuzzyFind(text, params.quote.trim()) : undefined
  const memory = await project.memory(chapter.plan.id)
  const passage = range !== undefined
    ? text.slice(Math.max(0, range.start - 200), Math.min(text.length, range.end + 200))
    : params.quote ?? memory?.summary ?? chapter.plan.synopsis ?? clip(text, 800)
  const present = detectCharacters(passage, [...characters])
  const cast = (present.length > 0 ? present : characters.filter(card => chapter.plan.characters?.includes(card.id) === true)).slice(0, 5)
  return { chapter, range, passage, cast }
}

/**
 * Whose design sheet a picture would draw first — worked out without drawing
 * anything, for the question put to the author before the picture is started.
 * @returns nobody for a kind of picture that shows no people, and where the author turned sheets-first off.
 */
export async function sheetsBefore(core: NovelCore, runtime: ProjectRuntime, params: Pick<IllustrateParams, 'kind' | 'target' | 'quote' | 'characters' | 'from' | 'scene' | 'plain' | 'prompt'>): Promise<CharacterCard[]> {
  const { project } = runtime
  const characters = await project.characters()
  const find = (ref: string): CharacterCard | undefined => characters.find(card => card.id === ref || sameName(card.name, ref) || (card.aliases ?? []).some(alias => sameName(alias, ref)))
  if (params.kind === 'portrait') {
    const card = params.target !== undefined ? await project.findCharacter(params.target) : undefined
    // A card that says nothing of looks yet gets its anchor written when the picture is drawn; whether a sheet can follow is not known before.
    // Asked for from the words alone, no sheet comes before it; asked for against the sheet, one does whatever the setting has.
    if (card === undefined) return []
    // The others the moment it shows names — those who come back in the book — get a sheet first as well: read off the
    // moment kept on the card (one the director is yet to find, or to pick for what was asked, is not known before).
    const image = await core.imageOf(runtime)
    const moment = params.plain === true || image.portraitScene === false || (params.prompt ?? '').trim().length > 0 ? undefined : sceneFor(card, params.scene)
    const others = moment !== undefined ? await lackingSheets(core, runtime, sceneMakings(sceneWords(moment), card, { characters, world: [] }).others, 'returning') : []
    const own = params.from === 'words' ? [] : await lackingSheets(core, runtime, [card], 'everyone', params.from === 'sheet' ? 'sheet' : undefined)
    return [...own, ...others.filter(other => !own.some(mine => mine.id === other.id))]
  }
  if (params.kind === 'custom') return await lackingSheets(core, runtime, (params.characters ?? []).map(find).filter((card): card is CharacterCard => card !== undefined), 'returning')
  if (params.kind === 'cover') return await lackingSheets(core, runtime, (await bookSketch(runtime, promptLanguage((await project.manifest()).language))).leads, 'returning')
  if (params.kind === 'scene') return await lackingSheets(core, runtime, (await sceneOf(project, params, characters)).cast, 'returning')
  return []
}

// ───────────────────────────── the kinds of picture ─────────────────────────────

/** How a place or a thing looks, for its design art: what is written down for an image model, or — lacking that — its name and what the entry says of it. */
const entryLook = (entry: WorldEntry, comma: string): IllustrationPiece | undefined => (entry.visualPrompt !== undefined && entry.visualPrompt.length > 0
  ? piece('look', entry.visualPrompt, 'anchor')
  : piece('look', `${entry.name}${comma}${entry.summary ?? clip(entry.body ?? '', 200, '')}`, 'card'))

/** Things a character's own card says must not be drawn on them. */
const negativesOf = (cards: readonly CharacterCard[]): string[] => cards.flatMap(card => splitAvoid(card.visual?.negative))

export interface IllustrateResult extends IllustrationInfo {
  inserted: boolean
  /** The art direction was written into the book by this call. */
  pinnedStyle?: string
  /** Whose design sheet was drawn first, for this picture to be held against: they had none. */
  sheets?: string[]
  /** Whose design sheet was drawn after this portrait, against it: the portrait leads, and they had none. */
  sheetsAfter?: string[]
  /** Whose sheet could not be drawn (first, or after), and why. */
  sheetsFailed?: { name: string; error: string }[]
  /** How the author's loose notes were sorted: into the person's look, into this picture, or nowhere. */
  sorted?: SortedNotes
  /**
   * A portrait: the moment of the book it shows. `picked`: the director picked it just now and it is on the card;
   * `asked`: the director picked it for this picture alone, guided by what the author asked of it (given back here),
   * and the card keeps what it had; neither: it was on the card. `none`: the director was asked and gave no moment —
   * the portrait is drawn without one, and this is why.
   */
  scene?: { text: string; title?: string; chapter?: string; id?: string; found?: number; asked?: string; why?: string } | { none: string }
  /** Drawn with several services to compare them: what each made of it. */
  tried?: TrialPicture[]
}

export async function illustrate(core: NovelCore, runtime: ProjectRuntime, params: IllustrateParams, task: TaskContext): Promise<IllustrateResult> {
  const { project } = runtime
  await requireImages(core, runtime)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const comma = lang === 'zh' ? '，' : ', '
  const raw = params.kind === 'custom' && params.raw === true
  const art = raw ? false as const : await artDirectionOf(core, runtime, { pin: true })
  // The sheets drawn for this picture before it: said with it, and on the job while it runs.
  const first: Pick<SheetsFirst, 'drawn' | 'failed'> = { drawn: [], failed: [] }
  // …and the sheet drawn after a portrait that leads, against it.
  const after: Pick<SheetsFirst, 'drawn' | 'failed'> = { drawn: [], failed: [] }
  const done = (info: IllustrationInfo, inserted = false): IllustrateResult => ({
    ...info,
    inserted,
    ...(art !== false && art.pinned === true ? { pinnedStyle: art.style } : {}),
    ...(first.drawn.length > 0 ? { sheets: first.drawn } : {}),
    ...(after.drawn.length > 0 ? { sheetsAfter: after.drawn } : {}),
    ...(first.failed.length > 0 || after.failed.length > 0 ? { sheetsFailed: [...first.failed, ...after.failed] } : {}),
    ...(sorted !== undefined ? { sorted } : {}),
    ...(shown !== undefined ? { scene: shown } : {}),
  })
  // What became of the ideas the author jotted down for this picture.
  let sorted: SortedNotes | undefined
  // The moment of the book a portrait asked for nothing shows.
  let shown: IllustrateResult['scene']
  /** These people with a sheet each, where they are to have one: drawn now if need be. */
  const sheeted = async (people: readonly CharacterCard[], who: 'everyone' | 'returning', lead?: PictureLead): Promise<CharacterCard[]> => {
    if (params.sheetFirst === false) return [...people]
    const made = await sheetsFirst(core, runtime, people, who, task, lead)
    first.drawn.push(...made.drawn)
    first.failed.push(...made.failed)
    if (made.drawn.length > 0) task.job?.result({ sheets: first.drawn })
    return made.cards
  }
  const characters = await project.characters()
  // The image settings as this book has them: the Studio's, with what the book has its own way with.
  const image = await core.imageOf(runtime)
  const find = (ref: string): CharacterCard | undefined => characters.find(card => card.id === ref || sameName(card.name, ref) || (card.aliases ?? []).some(alias => sameName(alias, ref)))
  const worn = (card: CharacterCard): CharacterLook | undefined => {
    for (const [who, look] of Object.entries(params.looks ?? {})) if (find(who)?.id === card.id) return lookOf(card, look)
    return undefined
  }

  if (params.kind === 'custom') {
    if (params.prompt === undefined || params.prompt.trim().length === 0) throw new ProjectError('novel/invalid', 'a custom illustration needs a prompt')
    const shown = await sheeted((params.characters ?? []).map(find).filter((card): card is CharacterCard => card !== undefined), 'returning')
    // Whoever is named is in the words as well as in the sheets sent along: a way to the model that takes no reference
    // picture — a server of the author's own — has only the words to know them by, and "she" is anybody. As written,
    // a prompt is sent as written.
    const people = raw ? [] : shown.map((card) => {
      const look = looksOf(card, worn(card))
      return look.length > 0 ? piece('look', `${card.name}${lang === 'zh' ? '：' : ': '}${look}`, lookFrom(card)) : undefined
    })
    const info = await renderImage(core, runtime, {
      ...(people.some(part => part !== undefined) ? compose([piece('ask', params.prompt), ...people]) : { subject: params.prompt }),
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
    // Ideas jotted down beside the button: what is of the person goes into their look first — the picture is then drawn
    // from that look —, what is of this picture directs it. A look (outfit) has its own words: `prompt`.
    const notes = params.look === undefined ? params.notes?.trim() : undefined
    let noted = found
    let direction = params.prompt
    if (notes !== undefined && notes.length > 0) {
      const made = await sortNotes(core, runtime, found, notes, params.kind, task)
      noted = made.card
      sorted = made.sorted
      task.job?.result({ sorted })
      direction = [params.prompt, made.sorted.picture].filter((part): part is string => part !== undefined && part.trim().length > 0).join(comma) || undefined
    }
    let anchored = await withAnchor(core, runtime, noted, task)
    if (looksOf(anchored).length === 0) throw new ProjectError('novel/invalid', `${anchored.name} has no appearance yet — describe how they look first (or let novel_bible expand the card)`)
    // A portrait shows the person in the moment a reader remembers them by. Which moment that is, is on their card;
    // where it is not, the director picks it from the book — an agent's choice, not a rule's — and it is kept there.
    // What the author asks of this one portrait does not take the moment's place: it guides the director, who picks
    // and writes the moment for this picture by it, and the card keeps what it had. `plain`, and the author's setting,
    // are what turn the moment off.
    let scene: string | undefined
    let guided: string | undefined
    // The moment of the card's that is drawn as it stands: the portrait is kept beside it.
    let drawnOf: SignatureScene | undefined
    // The chapter the moment is from: the portrait shows them as that chapter has them.
    let momentAt: string | undefined
    if (params.kind === 'portrait' && params.plain !== true && image.portraitScene !== false) {
      // A book with nothing written yet has no moment to find: nobody is asked.
      const written = (await project.chapterInfos()).some(chapter => chapter.hasText)
      let found: number | undefined
      let none: string | undefined
      // What the digests noted of them as the chapters were read comes first: nobody reads the book again for it.
      if (scenesOf(anchored).length === 0 && written && (await keepNotedScenes(runtime, [anchored.id]).catch(() => [])).length > 0) {
        anchored = (await project.findCharacter(anchored.id))!
        found = scenesOf(anchored).length
      }
      if (scenesOf(anchored).length === 0 && written) {
        try {
          const looked = await deriveScenes(core, runtime, { character: anchored.id }, task)
          anchored = looked.card
          found = looked.scenes.length
          if (found === 0) none = looked.why ?? L(lang, '书里还没有找到算得上名场面的一幕', 'the book has no moment yet that stands for them')
        } catch (error) {
          if (isAbort(error) || task.signal?.aborted === true) throw error
          core.log(`could not find the signature scenes of ${anchored.name}; drawing without one`, error)
          none = L(lang, `导演没能找出来（${error instanceof Error ? clip(error.message, 80) : '没有回答'}）`, `the director could not find any (${error instanceof Error ? clip(error.message, 100) : 'no answer'})`)
        }
      }
      const chosen = sceneFor(anchored, params.scene)
      if (direction !== undefined && written) {
        try {
          const settled = await guidedScene(core, runtime, anchored, { direction, ...(chosen !== undefined ? { scene: chosen.id } : {}) }, task)
          if (settled.scene !== undefined) {
            scene = sceneWords(settled.scene)
            guided = direction
            momentAt = settled.scene.chapter
            shown = { text: settled.scene.text, title: settled.scene.title, ...(settled.scene.chapter !== undefined ? { chapter: settled.scene.chapter } : {}), asked: direction, ...(settled.why !== undefined ? { why: settled.why } : {}) }
          } else shown = { none: settled.why ?? L(lang, '导演没有给出场面', 'the director gave no scene') }
        } catch (error) {
          if (isAbort(error) || task.signal?.aborted === true) throw error
          core.log(`could not settle the scene of this portrait of ${anchored.name}; drawing as asked`, error)
          shown = { none: L(lang, `导演没能定下来（${error instanceof Error ? clip(error.message, 80) : '没有回答'}）`, `the director could not settle one (${error instanceof Error ? clip(error.message, 100) : 'no answer'})`) }
        }
      } else if (direction === undefined && chosen !== undefined) {
        scene = sceneWords(chosen)
        drawnOf = chosen
        momentAt = chosen.chapter
        shown = { text: chosen.text, title: chosen.title, id: chosen.id, ...(chosen.chapter !== undefined ? { chapter: chosen.chapter } : {}), ...(found !== undefined ? { found } : {}), ...(found !== undefined && chosen.why !== undefined ? { why: chosen.why } : {}) }
      } else if (none !== undefined) shown = { none }
      // (Something asked of a book with nothing written yet is drawn as asked, below: there is no moment to pick.)
      // Said with the job while the picture is still being drawn: which moment it is to show.
      if (shown !== undefined) task.job?.result({ scene: shown })
    }
    // The stretch of their life the picture is of: the one named — or, for a portrait of one of their moments, the one
    // that moment falls in. In a stretch that looks different, they are drawn from that stretch's own words (which the
    // director writes where they are not written yet) and against that stretch's own sheet.
    let stage = params.stage !== undefined ? stageOf(anchored, params.stage) : undefined
    if (stage === undefined && params.kind === 'portrait' && momentAt !== undefined && (anchored.stages?.length ?? 0) > 0) {
      stage = stageAt(anchored, momentAt, (await project.pathOf(momentAt)).map(chapter => chapter.plan.id))
    }
    if (stage !== undefined && looksApart(stage) && (stage.visual?.prompt ?? '').trim().length === 0) {
      const restore = task.job?.note(L(lang, `导演在写「${anchored.name}」${stage.title}时的样子…`, `The director is writing how ${anchored.name} looks in "${stage.title}"…`))
      try {
        anchored = (await deriveVisual(core, runtime, { character: anchored.id, stage: stage.id }, task)).card
      } finally {
        restore?.()
      }
      stage = stageOf(anchored, stage.id)
    }
    const lead = leadOf(image)
    // What this portrait is held against, where the author said so for this one: the sheet, or nothing but the words.
    // Otherwise the setting has it — the sheet, unless the portrait leads.
    const against = params.kind === 'portrait' && (params.from === 'sheet' || params.from === 'words') ? params.from : undefined
    const sheetComesFirst = against === 'sheet' || (against === undefined && lead === 'sheet')
    const sheetGoesAlong = against === 'sheet' || (against === undefined && lead !== 'portrait')
    if (stage !== undefined && params.kind === 'portrait' && looksApart(stage) && stage.visual?.sheet === undefined && params.sheetFirst !== false && sheetComesFirst) {
      const restore = task.job?.note(L(lang, `先画「${anchored.name}」${stage.title}时的人设图…`, `First the design sheet of ${anchored.name} in "${stage.title}"…`))
      try {
        await illustrate(core, runtime, { kind: 'sheet', target: anchored.id, stage: stage.id }, { origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) })
      } finally {
        restore?.()
      }
      anchored = (await project.findCharacter(anchored.id))!
      stage = stageOf(anchored, stage.id)
    }
    // Who and what their moment shows besides them: the people its words name — as the chapter of the moment has them —
    // the place, the things. Each is said in the prompt by how it looks, and goes along as the picture it is known by.
    const beside = params.kind === 'portrait' && scene !== undefined && scene.length > 0
      ? sceneMakings(scene, anchored, { characters: momentAt !== undefined ? await castAt(runtime, momentAt, characters) : characters, world: await project.world() })
      : { others: [] as CharacterCard[], things: [] as WorldEntry[] }
    // Where the sheet leads, a portrait is drawn after it and against it: whoever has no sheet yet gets one first.
    // Where the portrait leads it is drawn from the words alone, and the sheet after it ({@link sheetAfter}).
    // The others of the moment who come back in the book get theirs too — every sheet this picture waits for is
    // drawn side by side with the rest, none after another.
    const [mine, others] = await Promise.all([
      params.kind === 'portrait' && against !== 'words' ? sheeted([anchored], 'everyone', against === 'sheet' ? 'sheet' : undefined) : Promise.resolve([anchored]),
      beside.others.length > 0 ? sheeted(beside.others, 'returning') : Promise.resolve([] as CharacterCard[]),
    ])
    const whole = mine[0]!
    const card = stage !== undefined ? inStage(whole, stageOf(whole, stage.id)) : whole

    if (params.kind === 'portrait') {
      const colon = L(lang, '：', ': ')
      /** How somebody looks, under their name: said once, on a line of its own. */
      const lookLine = (who: CharacterCard, how?: string): IllustrationPiece | undefined => labelled(piece('look', looksOf(who), lookFrom(who)), `${L(lang, `「${who.name}」的样子`, `How ${who.name} looks`)}${how !== undefined ? how : ''}${colon}`)
      const seen = (entry: WorldEntry): string | undefined => {
        const words = entry.visualPrompt !== undefined && entry.visualPrompt.trim().length > 0 ? entry.visualPrompt : entry.summary
        return words !== undefined && words.trim().length > 0 ? clip(words.trim(), 220, '…') : undefined
      }
      const composed = scene !== undefined && scene.length > 0
        ? compose([
            // What the picture is of comes first, in plain words: the moment. Then how it is framed, then who is in it
            // and how each looks, then the place and the things — a line each.
            // Picked for this picture by what the author asked — which is in the scene as the director wrote it, not
            // sent a second time — or the one the card keeps.
            guided !== undefined ? { of: 'scene' as const, text: scene, label: `${L(lang, '画面', 'The picture')}${colon}`, from: 'asked' as const, asked: guided } : labelled(piece('scene', scene, 'card'), `${L(lang, '画面', 'The picture')}${colon}`),
            // In their scene the person is still what the picture is of — it is also their face in every list.
            piece('frame', L(lang, `构图：一幅以「${card.name}」为主体的场景插画，半身到七分身，脸在画面上半部、看得清${others.length > 0 ? '；别的人只作陪衬' : ''}`, `Framing: a scene illustration with ${card.name} as its subject, waist-up to three-quarter length, the face in the upper half and clearly seen${others.length > 0 ? '; anybody else is secondary' : ''}`)),
            lookLine(card),
            ...others.map(other => lookLine(other, L(lang, '（陪衬）', ' (secondary)'))),
            beside.place !== undefined ? labelled(piece('place', seen(beside.place)), `${L(lang, `地点「${beside.place.name}」`, `The place "${beside.place.name}"`)}${colon}`) : undefined,
            ...beside.things.map(entry => labelled(piece('thing', seen(entry)), `${L(lang, `「${entry.name}」`, `"${entry.name}"`)}${colon}`)),
          ])
        : compose([
            // Asked for nothing in particular, a portrait faces the viewer on a plain ground; a direction of its own — a snowy
            // night, a look over the shoulder — takes the place of both, and is said before who they are.
            piece('frame', direction !== undefined ? L(lang, `画一张「${card.name}」的人物立绘，半身像`, `A portrait of ${card.name}, waist-up`) : L(lang, `画一张「${card.name}」的人物立绘：半身像，面向镜头，素净的浅色背景`, `A portrait of ${card.name}: waist-up, facing the viewer, on a plain light ground`)),
            labelled(piece('ask', direction), `${L(lang, '这一张的要求', 'Asked of this one')}${colon}`),
            lookLine(card),
            labelled(piece('expression', card.personality !== undefined ? clip(card.personality, lang === 'zh' ? 60 : 80, '') : undefined), L(lang, '神态：', 'Expression: ')),
          ])
      // A portrait drawn after the sheet shows the same person as the sheet; in their scene, whoever else it shows is
      // as their own sheet has them, the place as its design art has it, a thing as its own.
      // …unless the portrait leads: held against the sheet it would only come back as the sheet has them, and the
      // sheet is the one to follow.
      const sheet: Held[] = card.visual?.sheet !== undefined && sheetGoesAlong ? [{ path: card.visual.sheet, label: card.name, sheet: card.visual.sheetFront !== true }] : []
      for (const other of others) {
        const held = referenceOf(other)
        if (held !== undefined) sheet.push(held)
      }
      if (beside.place?.visualImage !== undefined) sheet.push({ path: beside.place.visualImage, label: L(lang, `场所「${beside.place.name}」`, `the place "${beside.place.name}"`) })
      for (const entry of beside.things) if (entry.visualImage !== undefined) sheet.push({ path: entry.visualImage, label: L(lang, `物品「${entry.name}」`, `the object "${entry.name}"`) })
      if (first.drawn.length > 0) task.job?.note(L(lang, '人设图画好了，照着它画立绘…', 'The sheet is drawn; now the portrait, against it…'))
      const momentTitle = shown !== undefined && 'text' in shown ? shown.title : undefined
      const moment = scene !== undefined && scene.length > 0 ? { ...(momentTitle !== undefined ? { title: momentTitle } : {}), ...(drawnOf !== undefined && drawnOf.id !== 'kept' ? { scene: drawnOf.id } : {}), ...(momentAt !== undefined ? { chapter: momentAt } : {}) } : undefined
      const render = async (trial?: NonNullable<IllustrationInfo['trial']>): Promise<IllustrationInfo> => await renderImage(core, runtime, { ...composed, kind: 'portrait', target: card.id, name: `portrait-${card.id}`, size: params.size ?? pictureSize((await core.imageOf(runtime)), 'portrait'), art, avoid: [...(params.avoid ?? []), ...negativesOf([card, ...others])], references: sheet, ...(moment !== undefined ? { moment } : {}), ...(trial !== undefined ? { trial } : {}) }, task)
      if (params.trials !== undefined && params.trials.length > 0) {
        // Tried with several services: the pictures stand beside their portraits for the author to choose from; the card keeps what it has.
        const tried = await drawTrials(core, runtime, params.trials, render, task)
        if (tried.first === undefined) throw new ProviderError(tried.pictures.map(picture => `${picture.label}: ${picture.error ?? 'no picture'}`).join('; '), undefined, 'TRIAL_FAILED')
        return { ...done(tried.first), tried: tried.pictures }
      }
      const info = await render()
      // The portrait of one of their moments stays with that moment as well: the panel shows which have been drawn.
      const scenes = drawnOf !== undefined && drawnOf.id !== 'kept' ? scenesOf(card).map(item => item.id === drawnOf!.id ? { ...item, portrait: info.path } : item) : undefined
      // …and a portrait of one stretch of their life with that stretch: the card's own portrait — their face in every
      // list — is the first one drawn, or one drawn of no stretch in particular.
      if (stage !== undefined) {
        await keepStage(project, card.id, stage.id, { portrait: info.path })
        await project.saveCharacter({ id: card.id, visual: { ...(whole.visual?.portrait === undefined ? { portrait: info.path } : {}), ...(scenes !== undefined ? { scenes } : {}) } })
      } else await project.saveCharacter({ id: card.id, visual: { portrait: info.path, ...(scenes !== undefined ? { scenes } : {}) } })
      // The portrait leads, and they have no sheet: it is drawn now, against the portrait — unless the author said not this time.
      if (lead === 'portrait' && against !== 'sheet' && params.sheetFirst !== false && stage === undefined && whole.visual?.sheet === undefined) {
        const restore = task.job?.note(L(lang, `立绘画好了，照着它补「${card.name}」的人设图…`, `The portrait is drawn; now the design sheet of ${card.name}, against it…`))
        try {
          await illustrate(core, runtime, { kind: 'sheet', target: card.id, from: 'portrait' }, { origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}), ...(task.job !== undefined ? { job: task.job } : {}) })
          after.drawn.push(card.name)
          // Said with the picture, as a sheet drawn first is: the page reads it off the job.
          task.job?.result({ sheetsAfter: after.drawn })
        } catch (error) {
          if (isAbort(error) || task.signal?.aborted === true) throw error
          core.log(`could not draw the design sheet of ${card.name} after their portrait`, error)
          after.failed.push({ name: card.name, error: error instanceof Error ? error.message : String(error) })
        } finally {
          restore?.()
        }
      }
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
    // A look is drawn against the main sheet (lacking one, the portrait): the same person in other clothes. The main
    // sheet is drawn from the words alone — the anchor, the art direction, what was asked of this picture — and never
    // against an older picture of the person. It is what every other picture of them is held against; drawn again
    // against the one before, it comes back as the one before, whatever the anchor and the art direction say by then.
    const base = look !== undefined ? card.visual?.sheet ?? card.visual?.portrait : undefined
    // …except where the author has the portrait lead (or asks for it this once): the portrait is then what says how they
    // look, and the sheet is that person turned three ways. It runs one way there too — such a portrait is never
    // drawn against the sheet.
    const portrait = look === undefined && (params.from === 'portrait' || (params.from === undefined && lead === 'portrait')) ? card.visual?.portrait : undefined
    // The sheet of another stretch of their life is a design sheet like the card's own: drawn from the words alone —
    // that stretch's anchor, which the director wrote starting from the card's, so that it is the same person in words.
    // Held against the card's sheet it comes back as the card's sheet, whatever age the words give (tried: it did).
    // What a sheet shows: the person three times, or — where the author says so, for an image model that cannot keep
    // three alike — the front view alone.
    const frontOnly = image.sheet === 'front'
    const info = await renderImage(core, runtime, {
      ...compose([
        frontOnly
          // One figure: what a small image model draws where three in a row, alike to the button, are beyond it.
          ? piece('frame', L(lang, `画一张「${card.name}」的人物设定图：只画这一个人，一次——正面，全身站姿，站直，两手自然垂在身侧，表情平静；素净的浅色背景，不要任何文字与标注`, `A character design sheet of ${card.name}: this one person, once — front view, full body, standing straight, hands at the sides, neutral expression; a plain light ground, no text or labels`))
          : piece('frame', L(lang, `画一张「${card.name}」的人物设定图（三视图）：同一个人的全身站姿画三次——正面、侧面、背面，从左到右等距并排，比例与衣着完全一致，表情平静；素净的浅色背景，不要任何文字与标注`, `A character design sheet (turnaround) of ${card.name}: the same person drawn three times, full body, standing — front view, side view, back view — evenly spaced left to right, identical proportions and clothing, neutral expression; a plain light ground, no text or labels`)),
        labelled(piece('look', looksOf(card), lookFrom(card)), L(lang, `「${card.name}」的样子：`, `How ${card.name} looks: `)),
        labelled(piece('outfit', look?.prompt), L(lang, '这身装束：', 'This outfit: ')),
        labelled(piece('ask', look === undefined ? direction : undefined), L(lang, '这一张的要求：', 'Asked of this one: ')),
      ]),
      kind: 'sheet',
      target: card.id,
      name: `sheet-${card.id}${look !== undefined ? `-${look.id}` : stage !== undefined ? `-${stage.id}` : ''}`,
      // One figure stands: the sheet's own shape turned on its side.
      size: params.size ?? (frontOnly ? upright(pictureSize((await core.imageOf(runtime)), 'sheet')) : pictureSize((await core.imageOf(runtime)), 'sheet')),
      art,
      avoid: [...(params.avoid ?? []), ...negativesOf([card])],
      ...(portrait !== undefined ? {
        references: [{ path: portrait, label: L(lang, `${card.name}的立绘`, `the portrait of ${card.name}`) }],
        // What the reference is for: who they are — not where they stand, how, or in what light.
        referenceNote: L(lang,
          // (Said as what is there, too — hands empty, standing straight: told only what to leave out, a model that takes
          // a picture along brought the umbrella she held in it into all three views.)
          `是同一个人：脸、发型、体型和衣着照参考图画。这里要的是素净背景上的${frontOnly ? '正面全身像' : '三视图'}：站直，两手空着、自然垂在身侧。参考图里的背景、姿势、手里拿的东西、光线和构图都不要带过来。`,
          `It is the same person: face, hair, build and clothing follow the reference. What is wanted here is ${frontOnly ? 'the front view, full body,' : 'a turnaround'} on a plain ground: standing straight, both hands empty and at the sides. Leave the reference's background, pose, whatever is held, light and composition behind.`),
      } : {}),
      ...(base !== undefined ? {
        references: [{ path: base, label: L(lang, `${card.name}的主造型`, `${card.name} in their main look`) }],
        // What the reference is for, said in the place of "whatever it shows must match": here the clothes must not.
        referenceNote: L(lang,
          '是同一个人：脸、发色、体型照参考图画；衣着、装备和头发的梳法以上面写的这身装束为准——和参考图不一样的地方，一律照文字画。',
          'It is the same person: face, hair colour and build follow the reference; clothing, gear and how the hair is worn follow the outfit described above — wherever that differs from the reference, draw the description.'),
      } : {}),
    }, task)
    // Kept with the sheet: whether it is the front view alone — whoever shows it, or holds a picture against it, goes by that.
    const views = frontOnly ? { sheetFront: true } : {}
    if (look === undefined && stage !== undefined) await keepStage(project, card.id, stage.id, { sheet: info.path, ...views }, frontOnly ? [] : ['sheetFront'])
    else if (look === undefined) await project.saveCharacter({ id: card.id, visual: { sheet: info.path, sheetFront: frontOnly ? true : null } as unknown as CharacterCard['visual'] })
    else {
      const { sheetFront: _was, ...rest } = look
      const looks = [...(card.visual?.looks ?? []).filter(other => other.id !== look.id), { ...rest, sheet: info.path, ...views }]
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
    const info = await renderImage(core, runtime, {
      ...compose([
        // A place as somewhere to stand; a house or an organisation as the one picture that stands for it.
        groupOf(entry.category) === 'factions'
          ? piece('frame', L(lang, '家族或组织的设定图：一幅代表它的画面——它的门庭、徽记旗号，或它的人聚在一处的场面，照下面的描述；不要任何文字', 'design art of a house or an organisation: the one picture that stands for it — its seat, its emblem and banner, or its people gathered — as described below; no text at all'))
          : piece('frame', L(lang, '场景设定图，无人物，远景，交代空间结构、材质与光线', 'environment design art, no people, wide shot showing layout, materials and light')),
        // At a turn of its course: as the director writes it is then — the same place, changed by what happened.
        turn !== undefined ? piece('composed', await turnLook(core, runtime, entry, turn, task)) : entryLook(entry, comma),
        piece('ask', params.prompt),
      ]),
      kind: 'location',
      target: entry.id,
      name: `location-${entry.id}${turn !== undefined ? `-${turn.chapter}-${turn.kind}` : ''}`,
      size: params.size ?? pictureSize((await core.imageOf(runtime)), 'location'),
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
    const info = await renderImage(core, runtime, {
      ...compose([
        piece('frame', L(lang, '关键物品设定图：只画这一件物品，完整入画，居中，干净的浅色素底；看得清形状、材质、纹饰与大小的感觉；没有人物，没有手，画面里不出现任何文字说明', 'design art of one key object: the object alone, whole and centred on a clean pale ground; its shape, material, ornament and sense of size readable; no people, no hands, no lettering')),
        turn !== undefined ? piece('composed', await turnLook(core, runtime, entry, turn, task)) : entryLook(entry, comma),
        piece('ask', params.prompt),
      ]),
      kind: 'item',
      target: entry.id,
      name: `item-${entry.id}${turn !== undefined ? `-${turn.chapter}-${turn.kind}` : ''}`,
      size: params.size ?? pictureSize((await core.imageOf(runtime)), 'item'),
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
    const info = await renderImage(core, runtime, {
      ...compose([
        piece('frame', L(lang, '小说封面插画，竖幅构图，画面上方留出标题空间，不要出现任何文字', 'novel cover illustration, portrait orientation, space left at the top for a title, no text at all')),
        piece('composed', description),
      ]),
      kind: 'cover',
      name: 'cover',
      size: params.size ?? pictureSize((await core.imageOf(runtime)), 'cover'),
      art,
      avoid: extraAvoid,
      references: leads.map(card => referenceOf(card, worn(card))).filter((reference): reference is { path: string; label: string } => reference !== undefined),
    }, task)
    return done(info)
  }

  // scene
  const scene = await sceneOf(project, params, characters)
  const { chapter, range, passage } = scene
  if (passage.trim().length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has nothing to illustrate yet`)
  // Whoever of them comes back in the book has a sheet before the scene is drawn: the scene is held against it.
  // …and is shown as this chapter has them: the look, and the sheet, of the stretch of their life that holds here.
  const cast = await castAt(runtime, chapter.plan.id, await sheeted(scene.cast, 'returning'))
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
  const most = referencesOf((await core.imageOf(runtime)).references)
  const references = place?.visualImage !== undefined
    ? [...people.slice(0, Math.max(0, most - 1)), { path: place.visualImage, label: place.category === 'item' ? L(lang, `物品「${place.name}」`, `the object "${place.name}"`) : L(lang, `场所「${place.name}」`, `the place "${place.name}"`) }]
    : people
  const info = await renderImage(core, runtime, { ...compose([piece('composed', description)]), kind: 'scene', target: chapter.plan.id, name: `scene-${chapter.plan.id}`, size: params.size ?? pictureSize((await core.imageOf(runtime)), 'scene'), art, avoid: extraAvoid, references }, task)
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
export function consistencyFor(cards: readonly CharacterCard[]): { references: Held[]; avoid: string[] } {
  return {
    references: cards.map(card => referenceOf(card)).filter((reference): reference is { path: string; label: string } => reference !== undefined),
    avoid: negativesOf(cards),
  }
}

/**
 * What one panel of a storyboard is drawn from. The director's words for it say what happens in the frame; after
 * them go — as the bible has them *now*, in full, never as a storyboard once abridged them — how everyone in the
 * panel looks, in what they wear there; how its place looks; how the things it shows look. And the pictures that go
 * along: faces first, the place keeps its seat, a thing takes one where the people leave room.
 * @param has.most - how many pictures a prompt goes with at most (the author's setting).
 */
export function panelMakings(panel: Pick<ComicPanel, 'prompt' | 'description' | 'characters' | 'location' | 'looks' | 'things'>, has: { characters: readonly CharacterCard[]; world: readonly WorldEntry[]; most: number; lang: PromptLanguage; /** `false`: the art of the things it shows does not go along (`image.panelThings`). */ thingArt?: boolean }): Pick<RenderInput, 'subject' | 'pieces'> & { references: Held[]; avoid: string[] } {
  const { lang, world } = has
  const comma = lang === 'zh' ? '，' : ', '
  const shown = (panel.characters ?? []).map(id => has.characters.find(card => card.id === id)).filter((card): card is CharacterCard => card !== undefined)
  // What somebody wears in this panel, where the storyboard says it is not their usual.
  const worn = (card: CharacterCard): CharacterLook | undefined => {
    const name = panel.looks?.[card.id]
    return name === undefined ? undefined : (card.visual?.looks ?? []).find(look => sameName(look.name, name))
  }
  const place = placeNamed(world, panel.location)
  // The things it shows: those the storyboard names, and any thing of the bible its words name that has art of its own.
  const told = `${panel.description}\n${panel.prompt}`
  const called = (entry: WorldEntry, among: readonly string[]): boolean => [entry.name, ...(entry.aliases ?? [])].some(name => name.trim().length > 1 && among.some(text => text.includes(name) || sameName(text, name)))
  const things = world.filter(entry => entry.id !== place?.id && groupOf(entry.category) !== 'places'
    && (called(entry, panel.things ?? []) || (groupOf(entry.category) === 'items' && entry.visualImage !== undefined && called(entry, [told])))).slice(0, 4)
  const seen = (entry: WorldEntry): string | undefined => {
    const words = entry.visualPrompt !== undefined && entry.visualPrompt.trim().length > 0 ? entry.visualPrompt : entry.summary
    return words !== undefined && words.trim().length > 0 ? clip(words.trim(), 220, '…') : undefined
  }
  const composed = compose([
    piece('composed', panel.prompt),
    ...shown.map(card => (looksOf(card, worn(card)).length > 0 ? piece('look', `${card.name}${worn(card) !== undefined ? L(lang, `（${worn(card)!.name}）`, ` (${worn(card)!.name})`) : ''}${L(lang, '：', ': ')}${looksOf(card, worn(card))}`, lookFrom(card)) : undefined)),
    place !== undefined && place.visualPrompt !== undefined && place.visualPrompt.trim().length > 0 ? piece('place', `${L(lang, `地点「${place.name}」：`, `The place "${place.name}": `)}${clip(place.visualPrompt.trim(), 260, '…')}`) : undefined,
    ...things.map(entry => (seen(entry) !== undefined ? piece('thing', `${L(lang, `「${entry.name}」：`, `"${entry.name}": `)}${seen(entry)}`) : undefined)),
  ])
  const people = shown.map(card => referenceOf(card, worn(card))).filter((reference): reference is Held => reference !== undefined)
  // The art of a thing it shows goes along — unless the author would rather it did not: what a thing looks like is then in the words alone.
  const art = has.thingArt === false ? undefined : things.find(entry => entry.visualImage !== undefined)
  const references: Held[] = [
    ...people.slice(0, Math.max(0, has.most - (place?.visualImage !== undefined || art !== undefined ? 1 : 0))),
    ...(place?.visualImage !== undefined ? [{ path: place.visualImage, label: L(lang, `场所「${place.name}」`, `the place "${place.name}"`) }] : []),
  ]
  if (art !== undefined && references.length < has.most) references.push({ path: art.visualImage!, label: L(lang, `物品「${art.name}」`, `the object "${art.name}"`) })
  return { ...composed, references, avoid: negativesOf(shown) }
}

/**
 * Who and what a moment of somebody's shows besides them, read off its words: the people it names (not more than
 * three: a portrait is of one person), the place, the things. Nothing is asked of a model for it.
 */
export function sceneMakings(told: string, subject: CharacterCard, has: { characters: readonly CharacterCard[]; world: readonly WorldEntry[] }): { others: CharacterCard[]; place?: WorldEntry; things: WorldEntry[] } {
  const named = (entry: { name: string; aliases?: string[] | undefined }): boolean => [entry.name, ...(entry.aliases ?? [])].some(name => [...name.trim()].length >= 2 && told.includes(name.trim()))
  const others = has.characters.filter(card => card.id !== subject.id && named(card)).slice(0, 3)
  const place = has.world.find(entry => groupOf(entry.category) === 'places' && named(entry))
  const things = has.world.filter(entry => groupOf(entry.category) === 'items' && named(entry)).slice(0, 3)
  return { others, ...(place !== undefined ? { place } : {}), things }
}

/** A size standing where it lay: `1536x1024` → `1024x1536`. One that stands already is left. */
const upright = (size: string): string => {
  const [width, height] = size.split('x').map(Number)
  return width !== undefined && height !== undefined && width > height ? `${height}x${width}` : size
}

/** A place entry that matches a name the storyboard or a scene gave. */
export function placeNamed(world: readonly WorldEntry[], name: string | undefined): WorldEntry | undefined {
  if (name === undefined || name.trim().length === 0) return undefined
  return world.find(entry => sameName(entry.name, name) || name.includes(entry.name) || (entry.aliases ?? []).some(alias => sameName(alias, name)))
}

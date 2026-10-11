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
import { lookWords, mergeAvoid, PICTURE_TO_CHANGE, pictureSize, pictureWords, resolveArtStyle, sceneFor, sceneOfPicture, scenesOf, sceneWords, shotKey, shotOf, splitAvoid, tidyPart as tidy, type ArtSource } from '../../shared/art'
import type { CharacterCard, CharacterLook, CharacterStage, ComicPanel, ImageTrial, TrialPicture, IllustrationInfo, IllustrationParts, IllustrationPiece, IllustrationSent, PictureHang, PictureWhole, PromptLanguage, SceneShot, SignatureScene, SortedNotes, WorldEntry, WorldEvent } from '../../shared/types'
import { MAIN_LINE, referencesOf } from '../../shared/types'
import { clip, clipTail, fuzzyFind, hashText, newId, sameName, slugify } from '../../shared/text'
import { leadOf, portraitsOf, PROMPT_HEADROOM, promptTokens, promptWriteOf, type PictureLead } from '../../shared/images'
import { inStage, looksWhole, stageAt } from '../../shared/stages'
import { blocksOf, figureSpots } from '../../shared/reader'
import { sheetPool } from '../../shared/sheets'
import { groupOf } from '../../shared/world'
import { detectCharacters } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import { extensionOf, referencesRefused, type ImageProvider, type ImageReference } from '../media/image'
import { frontView } from '../media/front'
import { pixelsOf } from '../media/pixels'
import { castAt } from './growth'
import { keepNotedScenes } from './scenes'
import { ProviderError } from '../media/http'
import { portraitIsOf, ProjectError } from '../project'
import { appearanceTask, artDirectionTask, coverPromptTask, imagePromptTask, momentShotTask, passagePictureTask, lookNotesTask, lookTask, portraitSceneTask, portraitScenesTask, turnLookTask } from '../prompts'
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
   * Portrait: which of the two pictures a portrait can be. `true`: the plain likeness — facing the viewer on a plain
   * ground — and not their signature scene (what the interlude stage asks for: a figure to stand before a backdrop of
   * its own). `false`: the scene alone — and no picture at all where the book has no moment of theirs to show. Left
   * out: what the author's setting says (`image.portraits`) — by default both, a likeness and the scene, one of each.
   */
  plain?: boolean
  /**
   * Portrait, with `plain` left out and the setting at both: draw only what they do not have yet — a likeness where
   * none of their portraits is one, the scene where the moment it would show has no picture. What a batch asks for:
   * it fills in, and draws nothing a second time.
   */
  fill?: boolean
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
   * Draw it once with each of these services, to compare them — the same words, the same reference pictures. Whatever
   * kind of picture it is, none of them hangs anywhere: they are in the gallery, kept out of the text, each saying
   * where it would go ({@link PictureHang}), for the author to take one ({@link hangPicture}).
   */
  trials?: ImageTrial[]
  /** With `trials`: the press of a button these pictures are of, where it drew many things at once — they can be taken together, by service. */
  trialBatch?: string
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
 * Have the director write down how a character looks — their appearance, in the book's own language — and keep it on
 * the card: what the writer writes them by and what every picture of them is drawn by. There is one such text of a
 * person. (An earlier version kept a second one beside it, phrases for image models — a "visual anchor": where a
 * card still has one, it is folded into the appearance here, and gone from the card.)
 * @param params.stage - of one stretch of their life: how they look in it, written out whole, starting from the card's appearance; kept with the stretch.
 * @throws ProjectError `novel/not-found` for nobody by that name.
 */
export async function deriveVisual(core: NovelCore, runtime: ProjectRuntime, params: { character: string; direction?: string; stage?: string }, task: TaskContext): Promise<{ card: CharacterCard; appearance: string; negative?: string }> {
  const { project } = runtime
  const whole = await project.findCharacter(params.character)
  if (whole === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  const stage = params.stage !== undefined ? stageOf(whole, params.stage) : undefined
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  if (stage !== undefined) {
    params = { ...params, direction: [lang === 'zh'
      ? `写的是这个人在「${stage.title}」这个时期的样子${stage.age !== undefined ? `（${stage.age}）` : ''}${stage.what !== undefined ? `——${stage.what}` : ''}${(stage.appearance ?? '').trim().length > 0 ? `。这个时期已经记下的：${stage.appearance!.trim()}` : ''}。从人物卡的外貌出发：认得出是同一个人的特征（脸的轮廓、五官、标志性的东西）留着；年龄感、体型、发式、衣着改成这个时期的。写成这个时期完整的外貌，不是只写变了的地方。`
      : `This is the person in the stretch of their life called "${stage.title}"${stage.age !== undefined ? ` (${stage.age})` : ''}${stage.what !== undefined ? ` — ${stage.what}` : ''}${(stage.appearance ?? '').trim().length > 0 ? `. Noted of this stretch already: ${stage.appearance!.trim()}` : ''}. Start from the appearance on the card: what makes them the same person (the shape of the face, the features, what marks them out) stays; apparent age, build, hair and clothing become this stretch's. Write how they look in it whole, not only what changed.`, params.direction].filter((part): part is string => part !== undefined && part.trim().length > 0).join(lang === 'zh' ? '\n' : '\n') }
  }
  // The phrases an earlier version kept for image models, of the card or of this stretch: folded in, then gone.
  const legacy = (stage !== undefined ? stage.visual?.prompt : whole.visual?.prompt)?.trim() ?? ''
  const art = await artDirectionOf(core, runtime)
  const { value } = await assign(core, runtime, task, {
    role: 'director',
    label: L(lang, `外貌 · ${whole.name}${stage !== undefined ? `（${stage.title}）` : ''}`, `Appearance · ${whole.name}${stage !== undefined ? ` (${stage.title})` : ''}`),
    tool: 'set_appearance',
    // The card comes with the task; where it says little of how they look, the book is read for it — then the result.
    maxSteps: 12,
    what: L(lang, '这个人物的外貌：一段话，和不要画出的东西', 'how this character looks: a paragraph, and what must not be drawn on them'),
    prompt: appearanceTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      card: renderCharacter({ ...whole, secrets: undefined, relationships: undefined, notes: undefined } as CharacterCard, lang),
      avoid: art.avoid,
      // The period and the forms the art direction fixes are written into the look itself: appended after a subject
      // that says otherwise, the art direction changes nothing.
      artStyle: art.style,
      ...(legacy.length > 0 ? { legacy } : {}),
      ...((whole.visual?.negative ?? '').trim().length > 0 ? { currentNegative: whole.visual!.negative!.trim() } : {}),
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    temperature: 0.3,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.appearance) === undefined) throw new Error('"appearance" is empty')
      return record
    },
  })
  const appearance = asText(value.appearance)!
  const negative = asText(value.negative)
  if (stage !== undefined) {
    const now = (await project.findCharacter(whole.id)) ?? whole
    const kept = await project.saveCharacter({ id: whole.id, stages: (now.stages ?? []).map((item) => {
      if (item.id !== stage.id) return item
      const { prompt: _folded, ...visual } = item.visual ?? {}
      return { ...item, appearance, ...(Object.keys(visual).length > 0 ? { visual } : { visual: undefined }) }
    }) as CharacterStage[] })
    return { card: kept, appearance, ...(negative !== undefined ? { negative } : {}) }
  }
  const saved = await project.saveCharacter({ id: whole.id, appearance, visual: { prompt: '', negative: negative ?? whole.visual?.negative ?? '' } })
  return { card: saved, appearance, ...(negative !== undefined ? { negative } : {}) }
}

/**
 * Sort the ideas an author jotted down before a picture of somebody: the
 * director says which are of the person — and works those into their
 * appearance — and which are of this one picture, which direct it and are
 * kept nowhere. What became of each idea is handed back, to be shown.
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
        ...((card.appearance ?? '').trim().length > 0 ? { appearance: card.appearance!.trim() } : {}),
        // (Phrases an earlier version kept for image models: folded into the appearance with whatever the ideas change.)
        ...((card.visual?.prompt ?? '').trim().length > 0 ? { legacy: card.visual!.prompt!.trim() } : {}),
        ...(card.visual?.negative !== undefined ? { negative: card.visual.negative } : {}),
        notes,
        picture,
        avoid: art.avoid,
        artStyle: art.style,
      }),
      temperature: 0.2,
      validate: (raw) => {
        const record = asRecord(raw)
        if (asText(record.appearance) === undefined && asText(record.picture) === undefined) throw new Error('both "appearance" and "picture" are empty: every idea is of the person, of this picture, or has no place in it')
        return record
      },
    })
    const kept = asList(value.kept)
    const written = asText(value.appearance)
    const negative = asText(value.negative)
    const pictureLine = asText(value.picture)
    // The look changes only by what the author's ideas put there: an appearance handed back unchanged is left alone
    // — unless phrases of an earlier version were folded into it, which are then gone from the card.
    const folded = (card.visual?.prompt ?? '').trim().length > 0
    const appearance = written !== undefined && (kept.length > 0 || folded) && written.trim() !== (card.appearance ?? '').trim() ? written.trim() : undefined
    const visual: Record<string, string> = {}
    if (appearance !== undefined && folded) visual.prompt = ''
    if (negative !== undefined && negative !== card.visual?.negative) visual.negative = negative
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
      ...(looksOf(card).length > 0 ? { anchor: looksOf(card) } : {}),
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

/** The frame of a moment out of a director's answer ({@link SceneShot}); nothing where it says no instant. */
function readShot(value: Record<string, unknown>, told: string): SceneShot | undefined {
  const said = (text: string | undefined): string | undefined => {
    const clean = text?.trim().replace(/^["“「]|["”」]$/g, '').trim() ?? ''
    // "As usual", "not said", "none" in the place of an answer is no answer.
    return clean.length > 0 && !/^[（(]?(无|没有|同上|不详|未交代|平常|如常|none|n\/a|as usual|not said)[）)。.]?$/i.test(clean) ? clean : undefined
  }
  const action = said(asText(value.action))
  if (action === undefined) return undefined
  const outfit = said(asText(value.outfit))
  const look = said(asText(value.look))
  const setting = said(asText(value.setting))
  const people = asList(value.people)
  const place = said(asText(value.place))
  const things = asList(value.things)
  const why = said(asText(value.why))
  return {
    action,
    ...(outfit !== undefined ? { outfit } : {}),
    ...(look !== undefined ? { look } : {}),
    ...(setting !== undefined ? { setting } : {}),
    ...(people.length > 0 ? { people } : {}),
    ...(place !== undefined ? { place } : {}),
    ...(things.length > 0 ? { things } : {}),
    ...(why !== undefined ? { why } : {}),
    of: shotKey(told),
  }
}

/** How much of the chapter before a moment the director is handed with it: where what they wear and where they are is mostly said. */
const SHOT_BEFORE = 2400

/**
 * Have the director make one frame of a moment of somebody's, for the portrait of it ({@link SceneShot}): the instant
 * in a few words, what they wear in it, what is around them. A moment is kept as the book tells it — a paragraph
 * with what leads up to it — and says nothing of what they have on that day; the director reads the text around
 * it (handed with the task) and the rest of the book (it works as an agent) and says.
 * @param moment - the moment, as told: on the card, or by the director's own pick.
 * @param has.cast - everybody of the book, as the chapter of the moment has them.
 * @returns nothing where the director gave no instant.
 */
async function frameMoment(core: NovelCore, runtime: ProjectRuntime, card: CharacterCard, moment: Pick<SignatureScene, 'title' | 'text' | 'chapter'>, has: { cast: readonly CharacterCard[]; world: readonly WorldEntry[]; words: PromptLanguage }, task: TaskContext): Promise<SceneShot | undefined> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const art = await artDirectionOf(core, runtime)
  const colon = L(lang, '：', ': ')
  const chapter = moment.chapter !== undefined ? await project.findChapter(moment.chapter) : undefined
  const text = chapter !== undefined ? await project.chapterText(chapter.plan.id) : ''
  const memory = chapter !== undefined ? await project.memory(chapter.plan.id) : undefined
  // Where the chapter tells it: the paragraph that says most of what the moment says, with the one after it.
  const paragraphs = blocksOf(text).filter((block): block is Extract<ReturnType<typeof blocksOf>[number], { kind: 'paragraph' }> => block.kind === 'paragraph')
  const spot = paragraphs.length > 0 ? figureSpots(text, [{ told: moment.text }])[0] : undefined
  const told = spot !== undefined ? paragraphs[spot.paragraph] : undefined
  const before = told !== undefined ? clipTail(text.slice(0, told.offset).trim(), SHOT_BEFORE) : ''
  const after = told !== undefined ? clip(text.slice(told.offset + told.text.length).trim(), 500, '…') : ''
  const around = `${before}\n${told?.text ?? ''}\n${after}\n${moment.text}`
  // Who else the chapter has, and what of the bible is named around the moment: the names an answer may use.
  const known = new Set<string>([...(chapter?.plan.characters ?? []), ...(memory?.characters ?? []).map(seen => seen.character ?? ''), ...detectCharacters(around, [...has.cast]).map(other => other.id)])
  const others = has.cast.filter(other => other.id !== card.id && known.has(other.id)).slice(0, 10)
  const named = (entry: WorldEntry): boolean => [entry.name, ...(entry.aliases ?? [])].some(name => [...name.trim()].length >= 2 && (around.includes(name.trim()) || (chapter?.plan.location ?? '').includes(name.trim())))
  const entries = has.world.filter(entry => groupOf(entry.category) !== 'ideas' && named(entry)).slice(0, 12)
  const wardrobe = (card.visual?.looks ?? []).map(look => `「${look.name}」${look.when !== undefined ? `（${look.when}）` : ''}${look.prompt !== undefined && look.prompt.trim().length > 0 ? `${colon}${clip(look.prompt.trim(), 80, '…')}` : ''}`)
  const restore = task.job?.note(L(lang, `导演在读「${moment.title.length > 0 ? moment.title : card.name}」前后的正文，整理这一刻的穿着和环境…`, `The director is reading the text around "${moment.title.length > 0 ? moment.title : card.name}" for what they wear and what is around them…`))
  try {
    const { value } = await assign<Record<string, unknown>>(core, runtime, task, {
      role: 'director',
      label: L(lang, `整理画面 · ${card.name}${moment.title.length > 0 ? `「${moment.title}」` : ''}`, `Framing · ${card.name}${moment.title.length > 0 ? `, "${moment.title}"` : ''}`),
      tool: 'frame_moment',
      what: L(lang, '这一幕整理成的一格画面：这一刻在做什么、穿着什么、周围什么样', 'the one frame made of the moment: what is done in it, what is worn, what is around'),
      // The line the moment is on: what the director reads with its own tools is that line's.
      line: chapter?.line ?? await project.lineOfCharacter(card),
      // The text around the moment comes with the task; a look further back for what they put on that day, then the answer.
      maxSteps: 12,
      prompt: momentShotTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        name: card.name,
        moment: `${moment.title.length > 0 ? `${moment.title}${colon}` : ''}${moment.text}`,
        ...(chapter !== undefined ? {
          chapter: [
            L(lang, `第 ${chapter.index} 章《${chapter.plan.title}》`, `Chapter ${chapter.index}, "${chapter.plan.title}"`),
            chapter.plan.location !== undefined ? `${L(lang, '地点', 'Place')}${colon}${chapter.plan.location}` : undefined,
            chapter.plan.time !== undefined ? `${L(lang, '时间', 'Time')}${colon}${chapter.plan.time}` : undefined,
            (memory?.summary ?? chapter.plan.synopsis) !== undefined ? `${L(lang, '梗概', 'In short')}${colon}${clip(memory?.summary ?? chapter.plan.synopsis ?? '', 300, '…')}` : undefined,
          ].filter((line): line is string => line !== undefined).join('\n'),
        } : {}),
        ...(before.length > 0 ? { before } : {}),
        ...(told !== undefined ? { passage: told.text } : {}),
        ...(after.length > 0 ? { after } : {}),
        person: [
          `${card.name}${(card.aliases ?? []).length > 0 ? `（${(card.aliases ?? []).slice(0, 4).join(L(lang, '、', ', '))}）` : ''}${card.tagline !== undefined ? `${colon}${clip(card.tagline, 60, '…')}` : ''}`,
          `${L(lang, '平常的样子（有人设图的话图上就是这样，不必复述）', 'How they usually look (what their design sheet shows; not to be said again)')}${colon}${looksOf(card).length > 0 ? clip(looksOf(card), 400, '…') : L(lang, '（还没有写下来）', '(not written down yet)')}`,
          ...(wardrobe.length > 0 ? [`${L(lang, '造型', 'Looks')}${colon}${wardrobe.join(L(lang, '；', '; '))}`] : []),
        ].join('\n'),
        cast: others.map(other => [other.name, other.tagline !== undefined ? clip(other.tagline, 40, '…') : other.role, looksOf(other).length > 0 ? clip(looksOf(other), 120, '…') : L(lang, '（还没有写下样子）', '(no look written yet)')].join(L(lang, '｜', ' | '))).join('\n'),
        places: entries.map(entry => `${entry.name}（${entry.category}）${colon}${clip(entry.summary ?? entry.body ?? '', 100, '…')}${entry.visualPrompt !== undefined && entry.visualPrompt.trim().length > 0 ? `${L(lang, '；看上去', '; it looks')}${colon}${clip(entry.visualPrompt.trim(), 140, '…')}` : ''}`).join('\n'),
        artStyle: art.style,
        avoid: art.avoid,
        words: has.words,
      }),
      temperature: 0.3,
      validate: (raw) => {
        const record = asRecord(raw)
        if (asText(record.action) === undefined) throw new Error('"action" is empty: say what the instant shows')
        return record
      },
    })
    return ofLooks(readShot(value, moment.text), card)
  } finally {
    restore?.()
  }
}

/** A frame as it is kept: a look it names that is none of the person's is no look — what they wear is in its words. */
function ofLooks(shot: SceneShot | undefined, card: CharacterCard): SceneShot | undefined {
  if (shot?.look === undefined || lookOf(card, shot.look) !== undefined) return shot
  const { look: _none, ...rest } = shot
  return rest
}

/**
 * Keep something beside one of somebody's moments — the frame made of it, the portrait drawn of it — on the card as
 * it is now. A frame and a picture take their time, and the list may have been looked over meanwhile (a digest, the
 * director, the author): written back as it was read before, it would undo that.
 * @returns what to save under `visual`: the list, and — where the moment was the single paragraph of an earlier card — that paragraph emptied.
 */
async function besideMoment(project: ProjectRuntime['project'], cardId: string, of: SignatureScene, patch: Partial<Pick<SignatureScene, 'portrait' | 'shot'>>): Promise<{ scenes: SignatureScene[]; scene?: string } | undefined> {
  const card = await project.findCharacter(cardId)
  if (card === undefined) return undefined
  const now = scenesOf(card)
  // By its name in its chapter first (what a digest notes is numbered by its place in the chapter, and the
  // number may be another moment's by now); by its number where the author gave it another name meanwhile.
  const named = now.findIndex(item => item.chapter === of.chapter && item.title.trim() === of.title.trim())
  const at = named >= 0 ? named : now.findIndex(item => item.id === of.id)
  // Off the list since: it was drawn, so it is one of their moments still. (A frame alone does not bring it back.)
  if (at < 0) return patch.portrait !== undefined ? { scenes: [...now, { ...of, ...(of.id === 'kept' ? { id: newId('scene') } : {}), ...patch }] } : undefined
  // A frame is of the words it was made of: told otherwise since, it is not this moment's.
  const fits = (item: SignatureScene): Partial<Pick<SignatureScene, 'portrait' | 'shot'>> => (patch.shot !== undefined && patch.shot.of !== shotKey(item.text) ? { ...(patch.portrait !== undefined ? { portrait: patch.portrait } : {}) } : patch)
  // (The single paragraph of an earlier card becomes a list of one, with what is kept beside it.)
  return { scenes: now.map((item, index) => index === at ? { ...item, ...(item.id === 'kept' ? { id: newId('scene') } : {}), ...fits(item) } : item), ...(now[at]!.id === 'kept' ? { scene: '' } : {}) }
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
      scenes.push({ ...read, id: same !== undefined && same.id !== 'kept' ? same.id : newId('scene'), title: read.title.length > 0 ? read.title : same?.title ?? clip(read.text, 10, ''), ...(same?.portrait !== undefined ? { portrait: same.portrait } : {}), ...(same?.shot !== undefined ? { shot: same.shot } : {}) })
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
async function guidedScene(core: NovelCore, runtime: ProjectRuntime, card: CharacterCard, params: { direction: string; scene?: string; /** The language the frame of the moment is written in: the one the image prompts are in. */ words: PromptLanguage }, task: TaskContext): Promise<{ scene?: Omit<SignatureScene, 'id'>; why?: string }> {
  const brief = await sceneBrief(core, runtime, card)
  const { lang } = brief
  const wardrobe = (card.visual?.looks ?? []).map(look => `「${look.name}」${look.when !== undefined ? `（${look.when}）` : ''}${look.prompt !== undefined && look.prompt.trim().length > 0 ? L(lang, `：${clip(look.prompt.trim(), 80, '…')}`, `: ${clip(look.prompt.trim(), 80, '…')}`) : ''}`).join(L(lang, '；', '; '))
  const first = sceneFor(card, params.scene)
  const kept = first !== undefined ? [first, ...scenesOf(card).filter(scene => scene.id !== first.id)] : scenesOf(card)
  const restore = task.job?.note(L(lang, `导演在按你写的要求，定「${card.name}」这张立绘画哪一幕…`, `The director is settling which moment this portrait of ${card.name} shows, by what you asked…`))
  try {
    const { value } = await assign(core, runtime, task, {
      role: 'director',
      label: L(lang, `这张立绘的场面 · ${card.name}`, `This portrait's scene · ${card.name}`),
      line: brief.line,
      tool: 'set_portrait_scene',
      maxSteps: 16,
      what: L(lang, '这一张立绘画的那一幕', 'the moment this one portrait shows'),
      prompt: portraitSceneTask({ ...brief.base, ...(kept.length > 0 ? { scenes: kept.map(brief.told) } : {}), direction: params.direction, ...(wardrobe.length > 0 ? { looks: wardrobe } : {}), words: params.words }),
      temperature: 0.4,
      validate: raw => asRecord(raw),
    })
    const read = readScene(value, brief.chapters)
    const why = asText(value.why)
    // The one frame of it, written in the same answer: the pick and its frame are one reading of the book.
    const shot = read !== undefined ? ofLooks(readShot(value, read.text), card) : undefined
    return { ...(read !== undefined ? { scene: { ...read, ...(shot !== undefined ? { shot: { ...shot, ...(why !== undefined ? { why } : {}) } } : {}) } } : {}), ...(why !== undefined ? { why } : {}) }
  } finally {
    restore?.()
  }
}

/**
 * Make sure something says how a character looks before they are drawn: where their card says nothing of it, the
 * director writes their appearance, from the book. One who has an appearance is drawn from it as it stands.
 */
async function withAppearance(core: NovelCore, runtime: ProjectRuntime, card: CharacterCard, task: TaskContext): Promise<CharacterCard> {
  if (looksOf(card).length > 0) return card
  const lang = promptLanguage((await runtime.project.manifest()).language)
  const restore = task.job?.note(L(lang, `导演在照正文写「${card.name}」的外貌…`, `The director is writing how ${card.name} looks, from the book…`))
  try {
    return (await deriveVisual(core, runtime, { character: card.id }, task)).card
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    core.log(`could not write the appearance of ${card.name}`, error)
    return card
  } finally {
    restore?.()
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
  const plain = [usual, turnSubject(turn, lang)].map(tidy).join(comma)
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
  /** The picture of a passage: the passage, and what the director made of it — kept with the picture. */
  passage?: NonNullable<IllustrationInfo['passage']>
  /**
   * `subject` is the whole prompt, as its author has it (a picture drawn again from its prompt rewritten): it goes as
   * it stands. No art direction is added (`art` is `false`), nothing is laid out, and what is kept out is `avoid`
   * and nothing besides. The pictures in `references` go along; only where the prompt has no word of them is the
   * line that says what each shows put after it — a picture nothing explains is drawn into the scene as it is.
   */
  verbatim?: boolean
  /**
   * What the author asked of this one picture, in their words (a portrait, a design sheet): the brief carries it as
   * a line, and whoever writes the prompt works it into the parts it speaks of — where prompts are written at all
   * (`image.promptWrite` not `never`), the director writes this one whether or not the brief would fit.
   */
  asked?: string
  /**
   * With `verbatim`: whom the prompt points to by a picture's number ("见图1") and how they look in words. Where no
   * picture goes along after all, the pointer gives way to the words — a pointer to nothing describes nobody.
   */
  pointers?: { n: number; words: string }[]
}

/** The pictures that go along, each by its number and what it shows — the way both makers of image models ask for them to be spoken of — and what they are for. */
function referenceLineOf(held: readonly { label: string }[], lang: PromptLanguage, note?: string): string {
  return lang === 'zh'
    // (What somebody wears in this picture is the picture's own words to say: a moment in other clothes is drawn in
    // those, whatever the sheet shows them in.)
    ? `参考图：${held.map((reference, index) => `图${index + 1} 是${reference.label}`).join('；')}。${note ?? '人物的脸、发型和体型照各自的图；衣着和随身的东西，上面另写了的照文字，没写的照图。场所和物件的结构与材质照图。不要重新设计；构图、动作、神情和光线照上面的文字。'}`
    : `Reference pictures: ${held.map((reference, index) => `Image ${index + 1} shows ${reference.label}`).join('; ')}. ${note ?? 'Each person\'s face, hair and build follow their picture; what they wear and carry follows the words above where those say otherwise, and their picture where they do not. A place or a thing follows its picture in structure and materials. Nothing is redesigned; composition, action, expression and light follow the words above.'}`
}

/** A prompt speaks of the pictures that go along with it: by number, or as reference pictures at all. */
const speaksOfPictures = (prompt: string): boolean => /(图|Image|image)\s*1(?!\d)|参考图|[Rr]eference (picture|image)/.test(prompt)
/** A prompt without its lines on reference pictures: for when none goes along after all. */
const withoutPictureLines = (prompt: string): string => prompt.split('\n').filter(line => !/^\s*(参考图|Reference (pictures|images))\s*[:：]/.test(line)).join('\n')

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
      await runtime.project.holdFigure(info.path, true)
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

/** One part of a picture's makings, where there are words for it. */
const piece = (of: IllustrationPiece['of'], text: string | undefined, from?: IllustrationPiece['from']): IllustrationPiece | undefined => (text !== undefined && text.trim().length > 0 ? { of, text, ...(from !== undefined ? { from } : {}) } : undefined)

/** Where the words for how somebody looks are taken from: their visual anchor, or — lacking one — the prose of the card. */
const lookFrom = (card: CharacterCard): NonNullable<IllustrationPiece['from']> => (card.visual?.prompt !== undefined && card.visual.prompt.length > 0 ? 'anchor' : 'card')

/** How somebody looks — in what they wear there, where it is not their usual — as a part of a picture they are in. */
function personPiece(card: CharacterCard, options: { look?: CharacterLook | undefined; secondary?: boolean; /** Written out whatever picture goes along: the words have just been changed, and no picture shows that yet. */ written?: boolean } = {}): IllustrationPiece | undefined {
  const words = looksOf(card, options.look)
  const shown = options.written === true ? undefined : referenceOf(card, options.look)?.path
  // Nothing says how they look, and no picture shows it: there is nothing to say of them.
  if (words.length === 0 && shown === undefined) return undefined
  const standing = looksOf(card)
  // An outfit with no sheet of its own: the picture that shows them shows them in their usual, and the outfit is in the words alone.
  const unseen = options.look !== undefined && options.look.sheet === undefined ? options.look.prompt?.trim() : undefined
  return {
    of: 'look', text: words, from: lookFrom(card), name: options.look !== undefined ? `${card.name}（${options.look.name}）` : card.name,
    ...(options.secondary === true ? { secondary: true } : {}),
    ...(shown !== undefined ? { path: shown } : {}),
    ...(standing !== words ? { standing } : {}),
    ...(unseen !== undefined && unseen.length > 0 ? { wearing: unseen } : {}),
  }
}

/** How a place or a thing of the bible looks, as a part of a picture that shows it: what is written of it for an image model, else what its entry says in a line. */
function entryPiece(of: 'place' | 'thing', entry: WorldEntry, most = 220): IllustrationPiece | undefined {
  const words = entry.visualPrompt !== undefined && entry.visualPrompt.trim().length > 0 ? entry.visualPrompt : entry.summary
  return words !== undefined && words.trim().length > 0 ? { of, text: clip(words.trim(), most, '…'), name: entry.name } : undefined
}

/** The language a book's image prompts are written in: its own, unless the author has them in English for a model that reads nothing else. */
export const promptLangOf = (image: { promptLang?: 'en' | undefined }, lang: PromptLanguage): PromptLanguage => (image.promptLang === 'en' ? 'en' : lang)

/**
 * Where each part stands among the others, whatever kind of picture it is: what the picture is for; the picture
 * itself; how it is framed; who is in it — its subject first, with what they wear and show, then the others —; the
 * place; the things; what was asked of this one. (The art direction, the reference pictures and what to keep out
 * follow, said by {@link renderImage}.) One order for every picture: what both OpenAI's and Alibaba's guides to their
 * image models ask for — the use, the scene, the subject, the details, the constraints, a line each under its name.
 */
const partRank = (part: IllustrationPiece): number => ({ use: 0, picture: 1, scene: 1, composed: 1, setting: 1.5, frame: 2, look: part.secondary === true ? 6 : 3, outfit: 4, expression: 5, place: 7, thing: 8, ask: 9, change: 10 })[part.of]

/** The words a part is introduced by, on its line. */
function partLabel(part: IllustrationPiece, lang: PromptLanguage): string {
  const named = (zh: string, en: string): string => (part.name !== undefined && part.name.length > 0 ? L(lang, `${zh}「${part.name}」`, `${en} "${part.name}"`) : L(lang, zh, en))
  switch (part.of) {
    case 'use': return L(lang, '用途：', 'Purpose: ')
    case 'picture': case 'scene': case 'composed': return L(lang, '画面：', 'The picture: ')
    case 'frame': return L(lang, '构图：', 'Framing: ')
    case 'look': return `${named('人物', 'Person')}${part.secondary === true ? L(lang, '（陪衬）', ' (secondary)') : ''}${L(lang, '：', ': ')}`
    case 'setting': return L(lang, '环境：', 'Surroundings: ')
    // What they wear in the moment the picture is of, read off the text around it, stands under their name: it is said of one person.
    case 'outfit': return part.from === 'shot' ? `${part.name !== undefined && part.name.length > 0 ? L(lang, `「${part.name}」`, `${part.name}, `) : ''}${L(lang, '此刻穿着：', 'wearing in this moment: ')}` : L(lang, '这身装束：', 'This outfit: ')
    case 'expression': return L(lang, '神态：', 'Expression: ')
    case 'place': return `${named('地点', 'The place')}${L(lang, '：', ': ')}`
    case 'thing': return `${named('物件', 'The object')}${L(lang, '：', ': ')}`
    case 'ask': return L(lang, '这一张的要求：', 'Asked of this one: ')
    case 'change': return ''
  }
}

/**
 * Lay a picture's makings out and keep the parts, for the record of the picture: a line a part, each under its name,
 * in the one order every picture is said in ({@link partRank}) — whatever order they were handed in. Run together
 * into one sentence, a model that reads loosely could not tell whose hair was whose; said in another order for every
 * kind of picture, nobody could tell what a prompt would look like.
 * @param lang - the language the prompt is written in ({@link promptLangOf}).
 * @param pictured - the pictures that go along, in the order the prompt numbers them, where a person one of them
 *   shows is to be pointed to instead of written out (`image.looks`); left out, everybody is written out.
 */
export function compose(parts: readonly (IllustrationPiece | undefined)[], lang: PromptLanguage, pictured?: { paths: readonly string[] }): Pick<RenderInput, 'subject' | 'pieces'> {
  /** The number a picture that goes along is spoken of by. */
  const numberOf = (path: string | undefined): number => (path !== undefined && pictured !== undefined ? pictured.paths.indexOf(path) + 1 : 0)
  const pieces = parts
    .filter((part): part is IllustrationPiece => part !== undefined)
    // Somebody whose picture goes along is pointed to there, where the author has looks left to pictures: their
    // standing look is not written out beside a picture that shows it.
    .map((part): IllustrationPiece => {
      const { byPicture: _was, words: _kept, ...rest } = part
      const at = part.of === 'look' ? numberOf(part.path) : 0
      if (at === 0) return { ...rest, text: tidy(part.text) }
      const wearing = part.wearing !== undefined ? tidy(part.wearing) : ''
      // (What the line would have said is kept beside the pointer, unsent: a picture drawn again where no picture can go is drawn from it.)
      return { ...rest, text: `${L(lang, `见图${at}`, `see Image ${at}`)}${wearing.length > 0 ? L(lang, `；这一身：${wearing}`, `; wearing: ${wearing}`) : ''}`, byPicture: true, ...(tidy(part.text).length > 0 ? { words: tidy(part.text) } : {}) }
    })
    .filter(part => part.text.length > 0)
    .map((part, at) => ({ part, at }))
    .sort((left, right) => partRank(left.part) - partRank(right.part) || left.at - right.at)
    .map(({ part }) => ({ ...part, label: part.label ?? partLabel(part, lang) }))
  return { subject: pieces.map(part => `${part.label}${part.text}`).join('\n'), pieces }
}

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

/** What is kept out of a picture, as the last line of a prompt: where the image service has no field of its own for it, it is said in the prompt or nowhere. */
const avoidLine = (avoid: readonly string[], lang: PromptLanguage): string => `${L(lang, '不要出现：', 'Must not appear: ')}${avoid.join(L(lang, '、', ', '))}`

/**
 * The prompt that is sent, written by the director from the brief the Studio laid out — where the author has it so
 * (`image.promptWrite`), or where the brief comes to more than the model reads: the same picture, under the same
 * headings in the same order, in one language, each thing said once, within what the model reads. It is one plain
 * call: everything it goes by is in the brief. Nothing is asked where the author turned this off, or — unless they
 * have every prompt written — where the brief fits; a director that cannot be had leaves the brief as the prompt, and
 * the picture's record says so.
 * @param input.prompt - the brief, whole: with its art direction, its line on the reference pictures and — where the
 *   service takes what is kept out in the prompt alone — its last line.
 * @param input.avoid - what is kept out, where that travels apart from the prompt: for the director to steer around.
 * @returns the prompt to send, and what was done for the record.
 */
async function writePrompt(core: NovelCore, runtime: ProjectRuntime, provider: ImageProvider, input: { prompt: string; avoid: string[]; references: number; lang: PromptLanguage; /** What the author asked of this one picture: worked into the prompt, whether or not the brief fits. */ asked?: string; /** The author's own sentence, said of a picture that goes along: theirs to word, and rewritten only where the model could not read it all. */ own?: boolean }, task: TaskContext): Promise<{ prompt: string; compact?: NonNullable<IllustrationSent['compact']> }> {
  const asIs = { prompt: input.prompt }
  const mode = promptWriteOf(await core.imageOf(runtime))
  if (mode === 'never') return asIs
  // What the author asked of this one picture is worked into the prompt by whoever writes it — not left as a line
  // beside lines that say otherwise: asked, the director writes the prompt whether or not the brief would fit.
  const asked = input.asked?.trim() ?? ''
  const room = await provider.prompting?.(task.signal).catch(() => undefined)
  const from = promptTokens(input.prompt)
  // Counted by estimate, so held to a little under what the model reads.
  const limit = room?.tokens !== undefined ? Math.max(1, Math.floor(room.tokens * PROMPT_HEADROOM)) : undefined
  const over = limit !== undefined && from > limit
  if (!over && asked.length === 0 && (mode === 'fit' || input.own === true)) return asIs
  const manifest = await runtime.project.manifest()
  const lang = promptLanguage(manifest.language)
  const withPictures = input.references > 0 && room?.references !== 0
  // The same picture asked for again — drawn again, a panel redone — is not written again.
  const key = hashText(`${provider.model}\n${limit ?? ''}\n${input.lang}\n${withPictures}\n${input.prompt}\n${input.avoid.join('|')}\n${asked}`)
  const record = (text: string, more: { cut?: boolean } = {}): NonNullable<IllustrationSent['compact']> => ({ ...(room?.tokens !== undefined ? { limit: room.tokens } : {}), from, tokens: promptTokens(text), ...(asked.length > 0 ? { asked: true } : {}), ...more })
  const before = fittedPrompts.get(key)
  if (before !== undefined) return { prompt: before, compact: record(before) }
  // The nearest the director came, where every try was over: written with what matters first, it loses least at its end.
  let nearest: string | undefined
  const restore = task.job?.note(asked.length > 0
    ? L(lang, '导演在照你对这一张的要求改提示词…', 'The director is working what you asked of this one into the prompt…')
    : over
      ? L(lang, `导演在把提示词压到 ${limit} 个 token 以内（现在约 ${from} 个）…`, `The director is bringing the prompt within ${limit} tokens (about ${from} now)…`)
      : L(lang, '导演在把画图说明写成提示词…', 'The director is writing the prompt from the brief…'))
  try {
    const { value } = await assign(core, runtime, task, {
      role: 'director',
      label: asked.length > 0 ? L(lang, '照要求改提示词', 'A prompt, by what was asked') : over ? L(lang, '压缩提示词', 'Fitting a prompt') : L(lang, '写提示词', 'Writing a prompt'),
      tool: 'fit_prompt',
      // All of it is in the task: asked in one request, whatever the role is set to.
      plain: true,
      maxSteps: 6,
      what: limit !== undefined ? L(lang, `同一张图的提示词，不超过 ${limit} 个 token`, `the same picture's prompt, in no more than ${limit} tokens`) : L(lang, '同一张图的提示词', 'the same picture\'s prompt'),
      prompt: imagePromptTask({ lang, language: manifest.language, title: manifest.title, brief: input.prompt, avoid: input.avoid, to: input.lang, ...(limit !== undefined ? { tokens: limit } : {}), estimate: from, model: provider.model, references: withPictures ? input.references : 0, ...(asked.length > 0 ? { asked } : {}) }),
      temperature: 0.2,
      validate: (raw) => {
        // What is kept out travels apart from this prompt: a line of it written in all the same is taken out again —
        // named in the prompt, those are the things an image model draws.
        const handed = asText(asRecord(raw).prompt)
        const text = handed !== undefined && input.avoid.length > 0 ? withoutAvoidLine(handed) : handed
        if (text === undefined || text.length === 0) throw new Error('"prompt" is empty')
        // Worked in, what the author asked is no line of its own any more.
        if (asked.length > 0 && /^\s*(这一张的要求|Asked of this one)\s*[:：]/m.test(text)) throw new Error('the prompt still has a part "这一张的要求 / Asked of this one": work what the author asked into the parts it speaks of, and leave that part out')
        // Every reference picture is still spoken of by its number: a prompt that lost one sends a picture nothing explains.
        if (withPictures) {
          for (let at = 1; at <= input.references; at++) {
            if (!new RegExp(`(图|Image|image|#)\\s*${at}(?!\\d)`).test(text)) throw new Error(`the prompt no longer speaks of reference picture ${at} (${input.lang === 'zh' ? `图${at}` : `Image ${at}`}): keep what the brief says of each picture that goes along`)
          }
        }
        if (limit !== undefined) {
          const tokens = promptTokens(text)
          if (tokens > limit && (nearest === undefined || tokens < promptTokens(nearest))) nearest = text
          if (tokens > limit) throw new Error(`the prompt comes to about ${tokens} tokens; it has to be at most ${limit} — about ${Math.ceil((tokens - limit) * 100 / tokens)}% shorter still`)
        }
        return text
      },
    })
    if (fittedPrompts.size >= 500) fittedPrompts.delete(fittedPrompts.keys().next().value!)
    fittedPrompts.set(key, value)
    return { prompt: value, compact: record(value) }
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    if (limit !== undefined && nearest !== undefined && promptTokens(nearest) < from) {
      const cut = clipTokens(nearest, limit)
      core.log(`the director's prompt was still over ${limit} tokens; its end was left off`, error)
      return { prompt: cut, compact: record(cut, { cut: true }) }
    }
    core.log(over ? `could not bring a prompt within ${limit} tokens; it goes as it is` : 'the director could not write the prompt out; the brief goes as it is', error)
    return { ...asIs, compact: { ...(room?.tokens !== undefined ? { limit: room.tokens } : {}), from, failed: true, ...(asked.length > 0 ? { asked: true } : {}) } }
  } finally {
    restore?.()
  }
}

export async function renderImage(core: NovelCore, runtime: ProjectRuntime, input: RenderInput, task: TaskContext): Promise<IllustrationInfo> {
  const { project } = runtime
  const provider = await requireImages(core, runtime)
  // What the author is told while it is drawn is in the book's language; the prompt in the one prompts are written in.
  const zh = promptLanguage((await project.manifest()).language) === 'zh'
  const plang = promptLangOf(await core.imageOf(runtime), zh ? 'zh' : 'en')
  const references: (Held & { front?: boolean; image: ImageReference })[] = []
  // How the way to the model takes what is kept out: in a field of its own — or in the prompt alone, where it is then
  // said as the prompt's last line, in the prompt's own language.
  const avoidInPrompt = (await provider.prompting?.(task.signal).catch(() => undefined))?.avoidInPrompt === true
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
  const styleLine = art !== undefined ? `${L(plang, '画风：', 'Style: ')}${tidy(art.style)}` : undefined
  const avoid = art !== undefined || (input.avoid?.length ?? 0) > 0 ? mergeAvoid(art?.avoid, input.avoid) : []
  // (The author's whole prompt goes to the letter: not even the mark it ends on is taken off.)
  const whole = input.verbatim === true ? input.subject.trim() : tidy(input.subject)
  const change = input.change !== undefined ? tidy(input.change) : ''
  // Whoever a picture that goes along shows is pointed to there, not written out again — unless the author has looks
  // written out every time (`image.looks`).
  const pointing = (await core.imageOf(runtime)).looks !== 'always'
  // …and unless the words have moved on since that picture was drawn: a look rewritten after its sheet (a scar the
  // author just added, a braid taken out) is in the words alone, and a line that only pointed to the picture would
  // lose it. Such a person is written out, picture or no picture — until their sheet is drawn again.
  const behind = new Set<string>()
  if (pointing && input.pieces !== undefined) {
    const shown = input.pieces.filter(part => part.of === 'look' && part.path !== undefined)
    if (shown.length > 0) {
      const records = new Map((await project.illustrations()).map(record => [record.path, record]))
      for (const part of shown) {
        // What that picture was drawn from, where its record says: how they looked in words then.
        const whose = (part.name ?? '').replace(/（[^）]*）$/u, '')
        const then = records.get(part.path!)?.parts?.pieces?.find(piece => piece.of === 'look' && piece.byPicture !== true && (piece.name === undefined || piece.name.replace(/（[^）]*）$/u, '') === whose))?.text
        if (then !== undefined && tidy(then) !== tidy(part.standing ?? part.text)) behind.add(part.path!)
      }
    }
  }
  /** The picture, held against these. */
  const draw = async (held: typeof references) => {
    // One picture changed, and it is there: what to change in it is all there is to say.
    if (change.length > 0 && held.length > 0) {
      const prompt = clip(change, 1900, '…')
      const fitted = await writePrompt(core, runtime, provider, { prompt, avoid: [], references: 1, lang: plang, own: true }, task)
      const result = await provider.generate({
        prompt: fitted.prompt,
        // Nothing is to be written after it: not the list of this picture, not the one a setting holds.
        negativePrompt: '',
        ...(input.size !== undefined ? { size: input.size } : {}),
        references: [held[0]!.image],
        change: true,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
      })
      return { held: held.slice(0, 1), referenceLine: undefined, subject: prompt, full: prompt, pieces: undefined, prompt, fitted, result, changed: true }
    }
    // The brief as it is with these pictures along: a person one of them shows has a line that points to it.
    const paths = held.map(reference => (behind.has(reference.path) ? '' : reference.path))
    const laid = input.verbatim !== true && pointing && input.pieces !== undefined && input.pieces.some(part => part.of === 'look' && part.path !== undefined && paths.includes(part.path)) ? compose(input.pieces, plang, { paths }) : undefined
    // The author's whole prompt goes as it stands — less its lines on pictures, where none goes along after all.
    const unpointed = (text: string): string => (input.pointers ?? []).reduce((now, pointer) => now.replace(new RegExp(`(见图|see Image )\\s*${pointer.n}(?!\\d)`, 'g'), pointer.words), text)
    const full = input.verbatim === true ? (held.length === 0 ? unpointed(withoutPictureLines(whole)) : whole) : laid?.subject ?? whole
    // The pictures that go along, each by its number and what it shows, and what they are for: who and what must come
    // back as they are there, and what is the words' to say. A prompt of the author's own says that itself — the
    // line is put after it only where it has no word of them.
    const referenceLine = held.length === 0 || (input.verbatim === true && speaksOfPictures(full)) ? undefined : referenceLineOf(held, plang, input.referenceNote)
    // What is kept out is the prompt's last line where the service has no other place for it.
    const lastLine = avoidInPrompt && avoid.length > 0 ? avoidLine(avoid, plang) : undefined
    // The subject gives way before the lines that keep the book consistent do. (A prompt that is the author's whole is not cut to make room for lines it has in it.)
    const tail = [styleLine, referenceLine, lastLine].filter((line): line is string => line !== undefined).join('\n')
    const subject = clip(full, input.verbatim === true ? 3800 : Math.max(200, 1900 - tail.length), '…')
    const brief = tail.length > 0 ? `${subject}\n${tail}` : subject
    // Written out by the director where the author has prompts written, or where the model reads less than the brief
    // comes to. The author's own prompt is theirs to word: rewritten only where the model could not read it all.
    const fitted = await writePrompt(core, runtime, provider, { prompt: brief, avoid: lastLine !== undefined ? [] : avoid, references: held.length, lang: plang, ...(input.verbatim === true ? { own: true } : input.asked !== undefined ? { asked: input.asked } : {}) }, task)
    const result = await provider.generate({
      prompt: fitted.prompt,
      // Said in the prompt already, it is not to be written after it again; else it goes in the field the service has for it.
      ...(lastLine !== undefined ? { negativePrompt: '' } : avoid.length > 0 ? { negativePrompt: avoid.join(L(plang, '、', ', ')) } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(held.length > 0 ? { references: held.map(reference => reference.image) } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    })
    return { held, referenceLine, subject, full, pieces: laid?.pieces ?? input.pieces, prompt: brief, fitted, result, changed: false }
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
  // Pointed to a picture the service then left behind without a word — only the drawing showed it: whoever that
  // picture shows was neither seen nor described. Drawn again, held against what the service did take, so that they
  // are written out.
  const took = drawn.result.referencesUsed
  if (!drawn.changed && took !== undefined && took < drawn.held.length && (drawn.pieces ?? []).some(part => part.byPicture === true)) {
    left = [...drawn.held.slice(took).map(stayed), ...left]
    const restore = task.job?.note(zh ? '绘图服务没有收参考图，改成把人物的样子写出来再画…' : 'The image service left the reference pictures behind; drawing again with the people written out…')
    try {
      drawn = await draw(drawn.held.slice(0, took))
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
    ...(drawn.pieces !== undefined && drawn.pieces.length > 0 ? { pieces: drawn.pieces } : {}),
    ...(subject !== drawn.full ? { clipped: true } : {}),
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
    // What was handed to the service, where the director made it of the brief: what the author rewrites to draw it again.
    ...(fitted.prompt !== prompt ? { written: fitted.prompt } : {}),
    ...(input.verbatim === true && !drawn.changed ? { verbatim: true } : {}),
    ...(input.moment !== undefined && Object.keys(input.moment).length > 0 ? { moment: input.moment } : {}),
    ...(input.trial !== undefined ? { trial: input.trial } : {}),
    ...(input.passage !== undefined && Object.keys(input.passage).length > 0 ? { passage: input.passage } : {}),
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
/** A prompt without a last line that lists what is kept out: that travels apart from it. */
const withoutAvoidLine = (prompt: string): string => prompt.split('\n').filter(line => !/^\s*(不要出现|Must not appear|Avoid)\s*[:：]/.test(line)).join('\n').trim()

/**
 * What a picture shows in words — its own, or, where it is itself a picture changed, those kept of the one it came
 * from. A panel of which nothing was kept but the director's words is held against what its storyboard says is in
 * it — the sheets of the people, the art of the place and of a thing — as a panel drawn today is.
 */
async function wordsOf(core: NovelCore, runtime: ProjectRuntime, record: IllustrationInfo, lang: PromptLanguage): Promise<ReturnType<typeof pictureWords>> {
  const { project } = runtime
  const was = pictureWords(record)
  if (record.kind !== 'panel' || record.parts !== undefined) return was
  const at = await project.panelOf(record.path)
  if (at === undefined) return was
  const image = await core.imageOf(runtime)
  const makings = panelMakings(at.panel, { thingArt: image.panelThings !== false, characters: await castAt(runtime, at.board.chapterId, await project.characters()), world: await project.world(), most: referencesOf(image.references), lang: promptLangOf(image, lang) })
  return { ...was, subject: makings.subject, ...(makings.references.length > 0 ? { references: makings.references } : {}), ...(makings.avoid.length > 0 ? { avoid: makings.avoid } : {}) }
}

/**
 * Everything a picture was drawn from, for its author to rewrite and draw it again by ({@link redrawPicture} with
 * `prompt`): the prompt whole, as the image model got it — the picture, the art direction, what it says of the
 * pictures that went along — and, apart from it, what was kept out and those pictures.
 *
 * Of a picture drawn from a brief that is the prompt on its record — as the director wrote it out, where it did.
 * Of one that is another picture changed (it was sent that picture and a sentence), and of a panel of which only the
 * director's words were kept: the brief it would be drawn from in words today, laid out as any picture's is.
 */
export async function pictureWhole(core: NovelCore, runtime: ProjectRuntime, picture: string): Promise<PictureWhole & { /** As a record keeps them: the pictures, with what each is (a sheet goes as its front view). */ held: Held[] }> {
  const { project } = runtime
  const record = (await project.pictures()).find(item => item.id === picture || item.path === picture)
  if (record === undefined) throw new ProjectError('novel/not-found', `no picture on record matches "${picture}"`)
  const lang = promptLanguage((await project.manifest()).language)
  const plang = promptLangOf(await core.imageOf(runtime), lang)
  const was = await wordsOf(core, runtime, record, lang)
  if (record.parts !== undefined && record.parts.base === undefined) {
    // The pictures the prompt speaks of: those that went.
    const held: Held[] = record.parts.references ?? []
    const brief = withoutAvoidLine(record.prompt)
    // (A record from before the written prompt was kept has it only as the service was sent it.)
    const fitted = record.written ?? (record.sent?.compact?.tokens !== undefined && record.sent.compact.failed !== true ? record.sent.prompt : undefined)
    const prompt = fitted !== undefined ? withoutAvoidLine(fitted) : brief
    return { prompt, ...(prompt !== brief ? { brief } : {}), avoid: was.avoid ?? [], references: held.map(reference => ({ path: reference.path, label: reference.label })), held }
  }
  const held: Held[] = was.references ?? []
  // A picture drawn with no art direction — a prompt sent as written — gets none now.
  const art = was.art ? await artDirectionOf(core, runtime, { pin: true }) : undefined
  const lines = [tidy(was.subject), art !== undefined ? `${L(plang, '画风：', 'Style: ')}${tidy(art.style)}` : undefined, held.length > 0 ? referenceLineOf(held, plang) : undefined]
  return { prompt: lines.filter((line): line is string => line !== undefined).join('\n'), avoid: mergeAvoid(art?.avoid, was.avoid), references: held.map(reference => ({ path: reference.path, label: reference.label })), held }
}

/** The lines of a picture's brief that only pointed to a picture that went along, by the number they named: what each would have said in words. */
function pointersOf(record: IllustrationInfo): { n: number; words: string }[] {
  if (record.parts?.base !== undefined) return []
  return (record.parts?.pieces ?? []).flatMap((part) => {
    if (part.byPicture !== true || part.words === undefined) return []
    const n = /(?:见图|Image )\s*(\d+)/.exec(part.text)?.[1]
    return n !== undefined ? [{ n: Number(n), words: part.words }] : []
  })
}

/**
 * A whole prompt with other pictures to go along than the ones it was written for: its pointers ("见图2") renumbered
 * to where each picture stands now — one whose picture is gone written out, from the words kept beside it —, and its
 * line on which picture is which taken out, to be said anew of the pictures there are.
 * @param wanted - the pictures, in the order they are to be numbered; one that is no picture of the book is left out.
 */
async function withReferences(runtime: ProjectRuntime, record: IllustrationInfo, was: { held: Held[] }, whole: string, wanted: readonly { path: string; label?: string }[], plang: PromptLanguage): Promise<{ prompt: string; held: Held[]; pointers: { n: number; words: string }[] }> {
  const { project } = runtime
  const held: Held[] = []
  for (const reference of wanted) {
    const path = String(reference.path ?? '')
    // Pictures of the book only, each once.
    if (!/^assets\/[^.][^\0]*\.(png|jpe?g|webp|gif)$/i.test(path) || path.includes('..') || held.some(item => item.path === path) || !(await project.has(path))) continue
    const before = was.held.find(item => item.path === path)
    const label = reference.label?.trim() ?? ''
    held.push(before !== undefined ? { ...before, ...(label.length > 0 ? { label } : {}) } : { path, label: label.length > 0 ? label : L(plang, '参考图', 'a reference picture') })
  }
  const words = new Map(pointersOf(record).map(pointer => [pointer.n, pointer.words]))
  // First to marks no prompt has, then to the new numbers: 图2 → 图1 while 图1 → 图2 must not run into one another.
  let prompt = withoutPictureLines(whole)
  const pointers: { n: number; words: string }[] = []
  was.held.forEach((before, index) => {
    const n = index + 1
    const now = held.findIndex(item => item.path === before.path) + 1
    const said = words.get(n)
    prompt = prompt.replace(new RegExp(`(见图|see Image )\\s*${n}(?!\\d)`, 'g'), (_whole, lead: string) => (now > 0 ? `${lead}\u0001${now}\u0001` : said ?? L(plang, '照文字画', 'as the words have it')))
    if (now > 0 && said !== undefined) pointers.push({ n: now, words: said })
  })
  prompt = prompt.replace(/\u0001(\d+)\u0001/g, '$1').replace(/\n{2,}/g, '\n').trim()
  if (held.length > 0) prompt = `${prompt}\n${referenceLineOf(held, plang)}`
  return { prompt, held, pointers }
}

export async function redrawPicture(core: NovelCore, runtime: ProjectRuntime, params: { picture: string; subject?: string; change?: string; /** The whole prompt, rewritten: sent as it stands, with the pictures the one before went with. */ prompt?: string; /** With `prompt`: the pictures that go along instead of those the one before went with — some left out, others of the book added — in the order the prompt is to number them. */ references?: { path: string; label?: string }[]; /** With `prompt`: what is kept out — all of it. Left out: what the picture kept out before. */ avoid?: string[]; /** Draw it as it is, once with each of these services, to compare them: nothing is replaced. */ trials?: ImageTrial[] }, task: TaskContext): Promise<RedrawResult> {
  const { project } = runtime
  await requireImages(core, runtime)
  // Any picture of the book: one on record, or a panel drawn before panels were kept on record.
  const record = (await project.pictures()).find(item => item.id === params.picture || item.path === params.picture)
  if (record === undefined) throw new ProjectError('novel/not-found', `no picture on record matches "${params.picture}"`)
  const lang = promptLanguage((await project.manifest()).language)
  const comma = lang === 'zh' ? '，' : ', '
  const subject = params.subject?.trim() ?? ''
  const change = params.change?.trim() ?? ''
  const whole = params.prompt?.trim() ?? ''
  const trying = params.trials !== undefined && params.trials.length > 0
  if (whole.length > 0 && (subject.length > 0 || change.length > 0)) throw new ProjectError('novel/invalid', '`prompt` is the whole prompt rewritten: it goes without `subject` or `change`')
  if (subject.length === 0 && change.length === 0 && whole.length === 0 && !trying) throw new ProjectError('novel/invalid', 'say what to draw: the whole prompt rewritten (`prompt`), the picture\'s words rewritten (`subject`), or what to change in it (`change`)')
  const was = await wordsOf(core, runtime, record, lang)
  // The whole prompt, as the author has it now: what was kept out is what they say — or what it was.
  const taken = whole.length > 0 ? await pictureWhole(core, runtime, record.id) : undefined
  // …and the pictures that go along: those it went with — or the ones the author has go with it now. With other
  // pictures the prompt's own word of them no longer holds: the lines that pointed to a picture by number point to
  // its new number (one that is gone is written out again, from the words kept beside the pointer), and the line
  // that says which picture is which is said anew.
  const repictured = taken !== undefined && params.references !== undefined ? await withReferences(runtime, record, taken, whole, params.references, promptLangOf(await core.imageOf(runtime), lang)) : undefined
  const own = taken !== undefined && repictured !== undefined ? { ...taken, held: repictured.held } : taken
  const wholeNow = repictured?.prompt ?? whole
  // Its own parts with whoever a line only pointed to ("见图1") written out again, from the words kept beside the
  // pointer: what it is drawn from where its pictures cannot go — another service, one that takes none.
  const pointed = record.parts?.base === undefined ? (record.parts?.pieces ?? []).filter(part => part.byPicture === true && part.words !== undefined) : []
  const restored = pointed.length > 0
    ? record.parts!.pieces!.map((part): IllustrationPiece => {
        if (part.byPicture !== true || part.words === undefined) return part
        const { byPicture: _pointer, words, ...rest } = part
        return { ...rest, text: words }
      })
    : undefined
  const told = restored !== undefined ? restored.map(part => `${part.label ?? ''}${tidy(part.text)}`).join('\n') : was.subject
  // A picture drawn with no art direction — a prompt sent as written — gets none now. Nor does a whole prompt: its
  // art direction is in it, as the author left it.
  const art = was.art && own === undefined ? await artDirectionOf(core, runtime, { pin: true }) : false as const
  // The words a picture was drawn from are laid out already, a line a part under its name: they go as they stand —
  // rewritten by the author, or as they were — and are not laid out a second time.
  const plang = promptLangOf(await core.imageOf(runtime), lang)
  const asWritten = (parts: IllustrationPiece[]): Pick<RenderInput, 'subject' | 'pieces'> => ({ subject: parts.map(part => `${part.label ?? ''}${tidy(part.text)}`).join('\n'), pieces: parts })
  const words = own !== undefined
    ? { subject: wholeNow, pieces: [{ of: 'composed' as const, text: wholeNow, label: '' }] }
    : change.length > 0
    ? asWritten([{ of: 'composed', text: subject.length > 0 ? subject : told, label: '' }, { of: 'ask', text: change, label: L(plang, '这一张的要求：', 'Asked of this one: ') }])
    : subject.length > 0
      ? asWritten([{ of: 'ask', text: subject, label: '' }])
      // Tried with other services as it is: the parts it was drawn from, unchanged — whoever a picture shows pointed
      // to again where that picture goes, written out where the service takes none.
      : restored !== undefined
        ? { subject: told, pieces: restored }
        : asWritten([{ of: 'composed', text: was.subject, label: '' }])
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
    ...(record.passage !== undefined ? { passage: record.passage } : {}),
    ...(own !== undefined
      ? { verbatim: true, avoid: params.avoid !== undefined ? mergeAvoid(splitAvoid(params.avoid)) : own.avoid, references: own.held, pointers: repictured?.pointers ?? pointersOf(record) }
      : {
          avoid: was.avoid ?? [],
          ...(change.length > 0
            ? { change, references: [{ path: record.path, label: L(lang, PICTURE_TO_CHANGE.zh, PICTURE_TO_CHANGE.en) }], heldAgainst: was.references ?? [] }
            : { references: was.references ?? [] }),
        }),
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
  // So is a design sheet of theirs that was on no list (not a look's — those are named after the look): it joins the
  // sheets kept of them, after the others — drawn from one that was not in use, it is not in use either.
  if (replaced.length === 0 && record.kind === 'sheet' && record.target !== undefined) {
    const card = await project.findCharacter(record.target)
    const named = record.path.split('/').pop()!.replace(/-[0-9a-f]{8}\.[a-z]+$/i, '')
    if (card !== undefined && !(card.visual?.looks ?? []).some(look => named === `sheet-${card.id}-${look.id}`)) {
      await project.saveCharacter({ id: card.id, visual: { sheets: [...sheetPool(card), info.path] } })
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
  // Whether somebody has a sheet is read off their card as the book has it — not off the card as one chapter reads
  // it: there a stretch of their life with a look of its own shows no sheet, and the main sheet they have would be
  // drawn again for every picture that only has them in it.
  const kept = new Map((await runtime.project.characters()).map(card => [card.id, card]))
  // Nothing says how they look: there is nothing to draw a sheet from, and a picture is made of what the passage gives.
  const lacking = people.filter(card => (kept.get(card.id) ?? card).visual?.sheet === undefined && looksOf(card).length > 0)
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
  // The passage itself, as the text has it; who is around it is read off a little more than that.
  const passage = range !== undefined
    ? text.slice(range.start, range.end)
    : params.quote ?? memory?.summary ?? chapter.plan.synopsis ?? clip(text, 800)
  const present = detectCharacters(range !== undefined ? text.slice(Math.max(0, range.start - 200), Math.min(text.length, range.end + 200)) : passage, [...characters])
  const cast = (present.length > 0 ? present : characters.filter(card => chapter.plan.characters?.includes(card.id) === true)).slice(0, 5)
  return { chapter, range, passage, cast, text, memory }
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
    const moment = !wantsScene(params, image) || (params.prompt ?? '').trim().length > 0 ? undefined : sceneFor(card, params.scene)
    const others = moment !== undefined ? await lackingSheets(core, runtime, momentMakings(shotOf(moment), sceneWords(moment), card, { characters, world: [] }).others, 'returning') : []
    const own = params.from === 'words' ? [] : await lackingSheets(core, runtime, [card], 'everyone', params.from === 'sheet' ? 'sheet' : undefined)
    return [...own, ...others.filter(other => !own.some(mine => mine.id === other.id))]
  }
  if (params.kind === 'custom') return await lackingSheets(core, runtime, (params.characters ?? []).map(find).filter((card): card is CharacterCard => card !== undefined), 'returning')
  if (params.kind === 'cover') return await lackingSheets(core, runtime, (await bookSketch(runtime, promptLanguage((await project.manifest()).language))).leads, 'returning')
  if (params.kind === 'scene') return await lackingSheets(core, runtime, (await sceneOf(project, params, characters)).cast, 'returning')
  return []
}

// ───────────────────────────── the kinds of picture ─────────────────────────────

/** Whether a portrait asked for like this shows one of their moments (where the book has one): not the plain likeness, and not turned off by the author's setting. */
function wantsScene(params: Pick<IllustrateParams, 'plain' | 'scene'>, image: Parameters<typeof portraitsOf>[0]): boolean {
  if (params.plain === true) return false
  return params.plain === false || params.scene !== undefined || portraitsOf(image) !== 'plain'
}

const blank = (text: string | undefined): boolean => text === undefined || text.trim().length === 0

/**
 * Whether a portrait asked for like this is the pair — a plain likeness and their signature scene, one of each: nothing
 * said of it (no moment named, no direction, no stretch of their life, not a comparison of services), and the
 * author's setting at both.
 */
function wantsPair(params: IllustrateParams, image: Parameters<typeof portraitsOf>[0]): boolean {
  return params.kind === 'portrait' && params.plain === undefined && params.scene === undefined && params.stage === undefined
    && blank(params.prompt) && blank(params.notes) && (params.trials?.length ?? 0) === 0 && portraitsOf(image) === 'both'
}

/** Which of the pair somebody does not have yet: a likeness among their portraits, a picture of the moment a portrait of them would show. */
export async function lackingPortraits(runtime: ProjectRuntime, card: CharacterCard): Promise<{ plain: boolean; scene: boolean }> {
  const records = new Map((await runtime.project.illustrations()).map(record => [record.path, record]))
  const portraits = card.visual?.portraits ?? (card.visual?.portrait !== undefined ? [card.visual.portrait] : [])
  const moment = sceneFor(card, undefined)
  return {
    plain: !portraits.some(path => portraitIsOf(card, path, records.get(path)) === 'person'),
    // No moment on the card yet: there may be one to find, so it is still to draw.
    scene: moment === undefined || !(moment.portrait !== undefined || portraits.some(path => records.get(path)?.moment?.scene === moment.id)),
  }
}

/** A portrait was asked for as their scene alone (`plain: false`), and the book has no moment of theirs to show. */
const NO_MOMENT = 'novel/no-moment'

/** How a place or a thing looks, for its design art: what is written down for an image model, or — lacking that — its name and what the entry says of it. */
const entryLook = (entry: WorldEntry, comma: string, label: string): IllustrationPiece | undefined => {
  const part = entry.visualPrompt !== undefined && entry.visualPrompt.length > 0
    ? piece('look', entry.visualPrompt, 'anchor')
    : piece('look', `${entry.name}${comma}${entry.summary ?? clip(entry.body ?? '', 200, '')}`, 'card')
  // It is the entry the picture is of, not a person in one: named as the place or the thing it is.
  return part !== undefined ? { ...part, name: entry.name, label } : undefined
}

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
  scene?: {
    text: string; title?: string; chapter?: string; id?: string; found?: number; asked?: string; why?: string
    /** The one frame the director made of it for the picture: the instant, what they wear in it, what is around them. */
    shot?: SceneShot
    /** No frame could be made of it, and why: it was drawn as it is told. */
    unframed?: string
  } | { none: string }
  /** Drawn with several services to compare them: what each made of it. */
  tried?: TrialPicture[]
  /** A design sheet: kept beside the others, not in use — the main sheet is the one the author chose, and stays. */
  spare?: boolean
  /** The picture of a passage: who the director settled is in it, where it is set, which things it shows — and, in a sentence, what told it so. */
  framed?: { people: string[]; place?: string; things?: string[]; why?: string }
  /**
   * A portrait asked for with nothing said of it came to two pictures: this one is their signature scene, and here is
   * the plain likeness drawn beside it. (Where the book had no moment to show, the likeness is the picture itself and
   * `scene.none` says why there is no other.)
   */
  likeness?: IllustrationInfo
}

/** A picture's own record, without what the call that drew it said beside it. */
function infoOf(result: IllustrateResult): IllustrationInfo {
  const { inserted: _i, pinnedStyle: _p, sheets: _s, sheetsAfter: _a, sheetsFailed: _f, sorted: _n, scene: _c, tried: _t, spare: _r, likeness: _l, framed: _m, ...info } = result
  return info
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
    ...(framedOf !== undefined ? { framed: framedOf } : {}),
  })
  // What became of the ideas the author jotted down for this picture.
  let sorted: SortedNotes | undefined
  // The moment of the book a portrait asked for nothing shows.
  let shown: IllustrateResult['scene']
  // What the director settled of a passage's picture.
  let framedOf: IllustrateResult['framed']
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
  // The language the prompts are written in: the book's, unless the author has them in English.
  const plang = promptLangOf(image, lang)
  const use = (zh: string, en: string): IllustrationPiece => ({ of: 'use', text: L(plang, zh, en) })
  const find = (ref: string): CharacterCard | undefined => characters.find(card => card.id === ref || sameName(card.name, ref) || (card.aliases ?? []).some(alias => sameName(alias, ref)))
  const worn = (card: CharacterCard): CharacterLook | undefined => {
    for (const [who, look] of Object.entries(params.looks ?? {})) if (find(who)?.id === card.id) return lookOf(card, look)
    return undefined
  }
  /**
   * The picture of this call tried with several services, where the author asked for that — whatever kind it is: one
   * from each, none of them hung anywhere; each says where it would go (`hang`) and waits to be taken. Nothing where
   * no comparison was asked for: the picture is then drawn the usual way.
   */
  const tryWith = async (input: RenderInput, hang: PictureHang): Promise<IllustrateResult | undefined> => {
    if (params.trials === undefined || params.trials.length === 0) return undefined
    const tried = await drawTrials(core, runtime, params.trials, async trial => await renderImage(core, runtime, { ...input, trial: { ...trial, hang, ...(params.trialBatch !== undefined ? { batch: params.trialBatch } : {}) } }, task), task)
    if (tried.first === undefined) throw new ProviderError(tried.pictures.map(picture => `${picture.label}: ${picture.error ?? 'no picture'}`).join('; '), undefined, 'TRIAL_FAILED')
    return { ...done(tried.first), tried: tried.pictures }
  }

  if (params.kind === 'custom') {
    if (params.prompt === undefined || params.prompt.trim().length === 0) throw new ProjectError('novel/invalid', 'a custom illustration needs a prompt')
    const shown = await sheeted((params.characters ?? []).map(find).filter((card): card is CharacterCard => card !== undefined), 'returning')
    // Whoever is named is in the words as well as in the sheets sent along: a way to the model that takes no reference
    // picture — a server of the author's own — has only the words to know them by, and "she" is anybody. As written,
    // a prompt is sent as written.
    const people = raw ? [] : shown.map(card => personPiece(card, { look: worn(card) }))
    const input: RenderInput = {
      // As written, a prompt is sent as written; otherwise it is the picture, said in the author's words, in a brief like any other.
      ...(raw ? { subject: params.prompt } : compose([use('小说插图', 'an illustration for a novel'), piece('picture', params.prompt), ...people], plang)),
      kind: 'scene',
      name: 'custom',
      art,
      avoid: raw ? [] : [...(params.avoid ?? []), ...negativesOf(shown)],
      references: shown.map(card => referenceOf(card, worn(card))).filter((reference): reference is { path: string; label: string } => reference !== undefined),
      ...(params.size !== undefined ? { size: params.size } : {}),
    }
    return await tryWith(input, { as: 'gallery' }) ?? done(await renderImage(core, runtime, input, task))
  }

  // A portrait asked for with nothing said of it is two pictures: a plain likeness — who they are, what stands for
  // them and stands where they first come on — and their signature scene, what they are remembered by. The likeness
  // first: it settles how they look in words and has their sheet drawn where they have none, and the scene is then
  // held against the same sheet.
  if (wantsPair(params, image)) {
    const who = params.target !== undefined ? await project.findCharacter(params.target) : undefined
    if (who === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.target ?? ''}"`)
    const { fill: _fill, ...asked } = params
    const lacking = params.fill === true ? await lackingPortraits(runtime, who) : { plain: true, scene: true }
    const plain = lacking.plain ? await illustrate(core, runtime, { ...asked, plain: true }, task) : undefined
    let moment: IllustrateResult | undefined
    let none: string | undefined
    if (lacking.scene) {
      const restore = plain !== undefined ? task.job?.note(L(lang, '素底定妆画好了，接着画名场面…', 'The likeness is drawn; now their signature scene…')) : undefined
      try {
        moment = await illustrate(core, runtime, { ...asked, plain: false }, task)
      } catch (error) {
        if (!(error instanceof ProjectError && error.code === NO_MOMENT)) {
          // The likeness is drawn and kept: what went wrong with the scene is said with it, not instead of it.
          if (plain === undefined || isAbort(error) || task.signal?.aborted === true) throw error
          core.log(`the likeness of ${who.name} is drawn; their signature scene could not be`, error)
        }
        const why = error instanceof Error ? error.message : String(error)
        if (why.length > 0) none = why
      } finally {
        restore?.()
      }
    }
    const main = moment ?? plain
    if (main === undefined) throw new ProjectError('novel/invalid', none ?? L(lang, `「${who.name}」的素底定妆和名场面都已经有了`, `${who.name} has a likeness and a picture of their signature scene already`))
    const sheets = [...new Set([...(plain?.sheets ?? []), ...(moment?.sheets ?? [])])]
    const sheetsAfter = [...new Set([...(plain?.sheetsAfter ?? []), ...(moment?.sheetsAfter ?? [])])]
    const sheetsFailed = [...(plain?.sheetsFailed ?? []), ...(moment?.sheetsFailed ?? [])]
    const { sheets: _s, sheetsAfter: _a, sheetsFailed: _f, likeness: _l, ...rest } = main
    return {
      ...rest,
      ...(sheets.length > 0 ? { sheets } : {}),
      ...(sheetsAfter.length > 0 ? { sheetsAfter } : {}),
      ...(sheetsFailed.length > 0 ? { sheetsFailed } : {}),
      ...(moment !== undefined && plain !== undefined ? { likeness: infoOf(plain) } : {}),
      ...(moment === undefined && none !== undefined ? { scene: { none } } : {}),
    }
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
    let anchored = await withAppearance(core, runtime, noted, task)
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
    // The moment as it is told — the card's, or the director's pick — and the one frame made of it for the picture.
    let told: Pick<SignatureScene, 'title' | 'text' | 'chapter'> | undefined
    let shot: SceneShot | undefined
    let unframed: string | undefined
    // The chapter the moment is from: the portrait shows them as that chapter has them.
    let momentAt: string | undefined
    if (params.kind === 'portrait' && wantsScene(params, image)) {
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
          const settled = await guidedScene(core, runtime, anchored, { direction, ...(chosen !== undefined ? { scene: chosen.id } : {}), words: plang }, task)
          if (settled.scene !== undefined) {
            scene = sceneWords(settled.scene)
            guided = direction
            told = settled.scene
            shot = settled.scene.shot
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
        told = chosen
        // The frame made of it before holds while the moment is told as it was then.
        shot = shotOf(chosen)
        momentAt = chosen.chapter
        shown = { text: chosen.text, title: chosen.title, id: chosen.id, ...(chosen.chapter !== undefined ? { chapter: chosen.chapter } : {}), ...(found !== undefined ? { found } : {}), ...(found !== undefined && chosen.why !== undefined ? { why: chosen.why } : {}) }
      } else if (none !== undefined) shown = { none }
      // (Something asked of a book with nothing written yet is drawn as asked, below: there is no moment to pick.)
      // Asked for as the scene alone — the likeness is drawn beside it — and there is none: no second likeness is drawn in its place.
      if (params.plain === false && (scene === undefined || scene.length === 0)) {
        // (Nothing to say where the book simply has no text yet: nobody was asked, and nobody expects a scene of it.)
        throw new ProjectError(NO_MOMENT, shown !== undefined && 'none' in shown ? shown.none : '')
      }
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
    const lead = leadOf(image)
    // What this portrait is held against, where the author said so for this one: the sheet, or nothing but the words.
    // Otherwise the setting has it — the sheet, unless the portrait leads.
    const against = params.kind === 'portrait' && (params.from === 'sheet' || params.from === 'words') ? params.from : undefined
    const sheetComesFirst = against === 'sheet' || (against === undefined && lead === 'sheet')
    const sheetGoesAlong = against === 'sheet' || (against === undefined && lead !== 'portrait')
    // (A stretch with a look of its own, whole, and no sheet yet gets its sheet first. One that only says what is
    // different then is held against the card's sheet.)
    if (stage !== undefined && params.kind === 'portrait' && looksWhole(stage) && stage.visual?.sheet === undefined && params.sheetFirst !== false && sheetComesFirst) {
      const restore = task.job?.note(L(lang, `先画「${anchored.name}」${stage.title}时的人设图…`, `First the design sheet of ${anchored.name} in "${stage.title}"…`))
      try {
        await illustrate(core, runtime, { kind: 'sheet', target: anchored.id, stage: stage.id }, { origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) })
      } finally {
        restore?.()
      }
      anchored = (await project.findCharacter(anchored.id))!
      stage = stageOf(anchored, stage.id)
    }
    const inMoment = params.kind === 'portrait' && scene !== undefined && scene.length > 0
    const world = inMoment ? await project.world() : []
    // Everybody, as the chapter of the moment has them.
    const there = inMoment && momentAt !== undefined ? await castAt(runtime, momentAt, characters) : characters
    // A moment is kept as the book tells it; a picture needs one frame of it — the instant, what they have on in it,
    // what is around them. The director reads the text around the moment for that (an agent's reading: what somebody
    // wears that day is said pages before, if at all), and the frame stays beside the moment until it is told otherwise.
    if (inMoment && told !== undefined && shot === undefined) {
      try {
        shot = await frameMoment(core, runtime, stage !== undefined ? inStage(anchored, stage) : anchored, told, { cast: there, world, words: plang }, task)
        if (shot !== undefined && drawnOf !== undefined) {
          const kept = await besideMoment(project, anchored.id, drawnOf, { shot })
          if (kept !== undefined) anchored = await project.saveCharacter({ id: anchored.id, visual: kept })
        }
      } catch (error) {
        if (isAbort(error) || task.signal?.aborted === true) throw error
        // Not framed: the picture is drawn of the moment as it is told, and that is said with it.
        core.log(`could not make a frame of ${anchored.name}'s moment "${told.title}"; drawing it as it is told`, error)
        unframed = L(lang, `导演没能整理出这一刻的穿着和环境（${error instanceof Error ? clip(error.message, 80) : '没有回答'}），照名场面原来的写法画`, `the director could not read what they wear and what is around them (${error instanceof Error ? clip(error.message, 100) : 'no answer'}); drawn of the moment as it is told`)
      }
      if (shown !== undefined && 'text' in shown) {
        shown = { ...shown, ...(shot !== undefined ? { shot } : {}), ...(unframed !== undefined ? { unframed } : {}) }
        task.job?.result({ scene: shown })
      }
    } else if (inMoment && shot !== undefined && shown !== undefined && 'text' in shown) {
      shown = { ...shown, shot }
      task.job?.result({ scene: shown })
    }
    // Who and what their moment shows besides them: those its frame names — where it has none, those its words name —
    // as the chapter of the moment has them; the place; the things. Each is said in the prompt by how it looks, and
    // goes along as the picture it is known by.
    const beside = inMoment
      ? momentMakings(shot, scene!, anchored, { characters: there, world })
      : { others: [] as CharacterCard[], things: [] as WorldEntry[] }
    // Where the sheet leads, a portrait is drawn after it and against it: whoever has no sheet yet gets one first.
    // Where the portrait leads it is drawn from the words alone, and the sheet after it ({@link sheetAfter}).
    // The others of the moment who come back in the book get theirs too — every sheet this picture waits for is
    // drawn side by side with the rest, none after another.
    const [mine, others] = await Promise.all([
      params.kind === 'portrait' && against !== 'words' ? sheeted([anchored], 'everyone', against === 'sheet' ? 'sheet' : undefined) : Promise.resolve([anchored]),
      // (Asked of their cards as the book has them, and read as the moment's chapter has them after — the way a
      // chapter's picture does it. A card read at a chapter may show no sheet where the person has one.)
      beside.others.length > 0
        ? sheeted(beside.others.map(other => characters.find(card => card.id === other.id) ?? other), 'returning').then(async cards => (momentAt !== undefined ? await castAt(runtime, momentAt, cards) : cards))
        : Promise.resolve([] as CharacterCard[]),
    ])
    const whole = mine[0]!
    const card = stage !== undefined ? inStage(whole, stageOf(whole, stage.id)) : whole

    if (params.kind === 'portrait') {
      // What the author just said of the person went into their look a moment ago: no picture of them shows it yet,
      // so this once they are written out, sheet or no sheet.
      const justNoted = sorted !== undefined && sorted.unsorted !== true && sorted.kept.length > 0
      // What they wear in the moment, where it is one of the looks they have a sheet of: said, and shown, as that look.
      const wearsLook = shot?.look !== undefined ? lookOf(card, shot.look) : undefined
      const composed = scene !== undefined && scene.length > 0
        ? compose([
            use(`小说人物立绘：「${card.name}」的名场面`, `a character portrait for a novel: ${card.name} in their signature scene`),
            // The moment: picked for this picture by what the author asked — which is in the scene as the director
            // wrote it, not sent a second time — or the one the card keeps. What is sent of it is its one frame — the
            // instant, who does what — where the director made one; the moment as told stays on the record beside it.
            { of: 'scene' as const, text: shot?.action ?? scene, from: guided !== undefined ? 'asked' as const : 'card' as const, ...(guided !== undefined ? { asked: guided } : {}), ...(shot !== undefined ? { told: scene } : {}) },
            piece('setting', shot?.setting, 'shot'),
            // In their scene the person is still what the picture is of — it is also a face of theirs.
            piece('frame', L(plang, `以「${card.name}」为主体，半身到七分身，脸看得清${others.length > 0 ? '；别的人只作陪衬' : ''}`, `${card.name} is its subject: waist-up to three-quarter length, the face clearly seen${others.length > 0 ? '; anybody else is secondary' : ''}`)),
            personPiece(card, { written: justNoted, look: wearsLook }),
            // What they have on in this moment, as the text around it says: under their name, after their own line.
            shot?.outfit !== undefined ? { of: 'outfit' as const, text: shot.outfit, from: 'shot' as const, name: card.name } : undefined,
            ...others.map(other => personPiece(other, { secondary: true })),
            // The place and the things: how each looks, as the bible has it. A frame has said where they are and what
            // is there in what the eye sees; beside it, an entry with no look written — whose line would be what the
            // book says of it, a story — has nothing to add. (Its design art goes along all the same.)
            ...[beside.place !== undefined ? entryPiece('place', beside.place) : undefined, ...beside.things.map(entry => entryPiece('thing', entry))]
              .filter(part => part !== undefined && (shot === undefined || [beside.place, ...beside.things].some(entry => entry !== undefined && entry.name === part.name && (entry.visualPrompt ?? '').trim().length > 0))),
          ], plang)
        : compose([
            use(`小说人物立绘（定妆照）：只画「${card.name}」一个人`, `a character portrait for a novel (a plain likeness): ${card.name} alone`),
            // Asked for nothing in particular, a likeness faces the viewer on a plain ground; a direction of its own — a
            // snowy night, a look over the shoulder — takes the place of both.
            piece('frame', direction !== undefined ? L(plang, '半身像', 'waist-up') : L(plang, '半身像，面向镜头，素净的浅色背景', 'waist-up, facing the viewer, on a plain light ground')),
            // …and is the picture, in the author's words: said before who they are.
            piece('picture', direction),
            personPiece(card, { written: justNoted }),
            piece('expression', card.personality !== undefined ? clip(card.personality, lang === 'zh' ? 60 : 80, '') : undefined),
          ], plang)
      // A portrait drawn after the sheet shows the same person as the sheet; in their scene, whoever else it shows is
      // as their own sheet has them, the place as its design art has it, a thing as its own.
      // …unless the portrait leads: held against the sheet it would only come back as the sheet has them, and the
      // sheet is the one to follow.
      // (In one of their looks that has a sheet of its own, that sheet is the one that shows them.)
      const wornSheet = wearsLook?.sheet !== undefined ? referenceOf(card, wearsLook) : undefined
      const sheet: Held[] = sheetGoesAlong && wornSheet !== undefined ? [wornSheet] : card.visual?.sheet !== undefined && sheetGoesAlong ? [{ path: card.visual.sheet, label: card.name, sheet: card.visual.sheetFront !== true }] : []
      for (const other of others) {
        const held = referenceOf(other)
        if (held !== undefined) sheet.push(held)
      }
      if (beside.place?.visualImage !== undefined) sheet.push({ path: beside.place.visualImage, label: L(plang, `场所「${beside.place.name}」`, `the place "${beside.place.name}"`) })
      for (const entry of beside.things) if (entry.visualImage !== undefined) sheet.push({ path: entry.visualImage, label: L(plang, `物品「${entry.name}」`, `the object "${entry.name}"`) })
      if (first.drawn.length > 0) task.job?.note(L(lang, '人设图画好了，照着它画立绘…', 'The sheet is drawn; now the portrait, against it…'))
      // A likeness the author asked something of (a snowy night, a look over the shoulder): theirs is the picture's
      // line as they said it — for whoever writes the prompt to work into the parts it speaks of. (In a moment, what
      // they asked went into the choosing and the framing of it already.)
      const likenessAsked = !(scene !== undefined && scene.length > 0) && direction !== undefined && direction.trim().length > 0 ? direction.trim() : undefined
      const momentTitle = shown !== undefined && 'text' in shown ? shown.title : undefined
      const moment = scene !== undefined && scene.length > 0 ? { ...(momentTitle !== undefined ? { title: momentTitle } : {}), ...(drawnOf !== undefined && drawnOf.id !== 'kept' ? { scene: drawnOf.id } : {}), ...(momentAt !== undefined ? { chapter: momentAt } : {}) } : undefined
      const render = async (trial?: NonNullable<IllustrationInfo['trial']>): Promise<IllustrationInfo> => await renderImage(core, runtime, { ...composed, kind: 'portrait', target: card.id, name: `portrait-${card.id}`, size: params.size ?? pictureSize((await core.imageOf(runtime)), 'portrait'), art, avoid: [...(params.avoid ?? []), ...negativesOf([card, ...others])], references: sheet, ...(moment !== undefined ? { moment } : {}), ...(trial !== undefined ? { trial } : {}), ...(likenessAsked !== undefined ? { asked: likenessAsked } : {}) }, task)
      if (params.trials !== undefined && params.trials.length > 0) {
        // Tried with several services: the pictures stand beside their portraits for the author to choose from; the card keeps what it has.
        const hang: PictureHang = { as: 'portrait', character: card.id, ...(stage !== undefined ? { stage: stage.id } : {}) }
        const tried = await drawTrials(core, runtime, params.trials, async trial => await render({ ...trial, hang, ...(params.trialBatch !== undefined ? { batch: params.trialBatch } : {}) }), task)
        if (tried.first === undefined) throw new ProviderError(tried.pictures.map(picture => `${picture.label}: ${picture.error ?? 'no picture'}`).join('; '), undefined, 'TRIAL_FAILED')
        return { ...done(tried.first), tried: tried.pictures }
      }
      const info = await render()
      // The portrait of one of their moments stays with that moment as well: the panel shows which have been drawn.
      // On the card as it is now — a picture takes its time, and the list may have been looked over meanwhile (a
      // digest, the director, the author): written back as it was read before the drawing, it would undo that, and
      // a list that no longer has the moment under that number would lose the picture.
      const kept = drawnOf !== undefined ? await besideMoment(project, card.id, drawnOf, { portrait: info.path }) : undefined
      // …and a portrait of one stretch of their life with that stretch: the card's own portrait — their face in every
      // list — is the first one drawn, or one drawn of no stretch in particular.
      if (stage !== undefined) {
        await keepStage(project, card.id, stage.id, { portrait: info.path })
        await project.saveCharacter({ id: card.id, visual: { ...(whole.visual?.portrait === undefined ? { portrait: info.path } : {}), ...kept } })
      } else await project.saveCharacter({ id: card.id, visual: { portrait: info.path, ...kept } })
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
    const sheetInput: RenderInput = {
      ...compose([
        use(frontOnly ? `人物设定图（正面全身）：「${card.name}」` : `人物设定图（三视图）：「${card.name}」`, frontOnly ? `a character design sheet (front view, full body) of ${card.name}` : `a character design sheet (turnaround) of ${card.name}`),
        frontOnly
          // One figure: what a small image model draws where three in a row, alike to the button, are beyond it.
          ? piece('frame', L(plang, '只画这一个人，一次——正面，全身站姿，站直，两手自然垂在身侧，表情平静；素净的浅色背景，不要任何文字与标注', 'this one person, once — front view, full body, standing straight, hands at the sides, neutral expression; a plain light ground, no text or labels'))
          : piece('frame', L(plang, '同一个人的全身站姿画三次——正面、侧面、背面，从左到右等距并排，比例与衣着完全一致，表情平静；素净的浅色背景，不要任何文字与标注', 'the same person drawn three times, full body, standing — front view, side view, back view — evenly spaced left to right, identical proportions and clothing, neutral expression; a plain light ground, no text or labels')),
        personPiece(card),
        piece('outfit', look?.prompt),
        piece('ask', look === undefined ? direction : undefined),
      ], plang),
      // What was asked of this sheet is for whoever writes its prompt to work in: beside "arms at the sides, calm" a
      // line saying "one hand on the hilt" is two things said of one figure.
      ...(look === undefined && direction !== undefined && direction.trim().length > 0 ? { asked: direction.trim() } : {}),
      kind: 'sheet',
      target: card.id,
      name: `sheet-${card.id}${look !== undefined ? `-${look.id}` : stage !== undefined ? `-${stage.id}` : ''}`,
      // One figure stands: the sheet's own shape turned on its side.
      size: params.size ?? (frontOnly ? upright(pictureSize((await core.imageOf(runtime)), 'sheet')) : pictureSize((await core.imageOf(runtime)), 'sheet')),
      art,
      avoid: [...(params.avoid ?? []), ...negativesOf([card])],
      ...(portrait !== undefined ? {
        references: [{ path: portrait, label: L(plang, `${card.name}的立绘`, `the portrait of ${card.name}`) }],
        // What the reference is for: who they are — not where they stand, how, or in what light.
        referenceNote: L(plang,
          // (Said as what is there, too — hands empty, standing straight: told only what to leave out, a model that takes
          // a picture along brought the umbrella she held in it into all three views.)
          `是同一个人：脸、发型、体型和衣着照参考图画。这里要的是素净背景上的${frontOnly ? '正面全身像' : '三视图'}：站直，两手空着、自然垂在身侧。参考图里的背景、姿势、手里拿的东西、光线和构图都不要带过来。`,
          `It is the same person: face, hair, build and clothing follow the reference. What is wanted here is ${frontOnly ? 'the front view, full body,' : 'a turnaround'} on a plain ground: standing straight, both hands empty and at the sides. Leave the reference's background, pose, whatever is held, light and composition behind.`),
      } : {}),
      ...(base !== undefined ? {
        references: [{ path: base, label: L(plang, `${card.name}的主造型`, `${card.name} in their main look`) }],
        // What the reference is for, said in the place of "whatever it shows must match": here the clothes must not.
        referenceNote: L(plang,
          '是同一个人：脸、发色、体型照参考图画；衣着、装备和头发的梳法以上面写的这身装束为准——和参考图不一样的地方，一律照文字画。',
          'It is the same person: face, hair colour and build follow the reference; clothing, gear and how the hair is worn follow the outfit described above — wherever that differs from the reference, draw the description.'),
      } : {}),
    }
    const sheetHang: Extract<PictureHang, { as: 'sheet' }> = { as: 'sheet', character: card.id, ...(look !== undefined ? { look } : {}), ...(look === undefined && stage !== undefined ? { stage: stage.id } : {}), ...(frontOnly ? { front: true } : {}) }
    const sheetsTried = await tryWith(sheetInput, sheetHang)
    if (sheetsTried !== undefined) return sheetsTried
    const info = await renderImage(core, runtime, sheetInput, task)
    const hung = await hangSheet(project, info.path, sheetHang)
    return hung.spare ? { ...done(info), spare: true } : done(info)
  }

  if (params.kind === 'location') {
    const found = params.target !== undefined ? await project.findWorld(params.target) : undefined
    if (found === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${params.target ?? ''}"`)
    // What it looks like is written down first, from the book: then it is drawn, and drawn the same again.
    const entry = await withLook(core, runtime, found, task)
    const turn = params.event !== undefined ? await turnOf(project, entry, params.event) : undefined
    const placeInput: RenderInput = {
      ...compose([
        // A place as somewhere to stand; a house or an organisation as the one picture that stands for it.
        ...(groupOf(entry.category) === 'factions'
          ? [use('家族或组织的设定图', 'design art of a house or an organisation'), piece('frame', L(plang, '一幅代表它的画面——它的门庭、徽记旗号，或它的人聚在一处的场面；不要任何文字', 'the one picture that stands for it — its seat, its emblem and banner, or its people gathered; no text at all'))]
          : [use('场景设定图', 'environment design art'), piece('frame', L(plang, '无人物，远景，交代空间结构、材质与光线', 'no people, a wide shot showing layout, materials and light'))]),
        // At a turn of its course: as the director writes it is then — the same place, changed by what happened.
        turn !== undefined ? piece('composed', await turnLook(core, runtime, entry, turn, task)) : entryLook(entry, comma, groupOf(entry.category) === 'factions' ? L(plang, `「${entry.name}」：`, `"${entry.name}": `) : L(plang, `地点「${entry.name}」：`, `The place "${entry.name}": `)),
        piece('ask', params.prompt),
      ], plang),
      kind: 'location',
      target: entry.id,
      name: `location-${entry.id}${turn !== undefined ? `-${turn.chapter}-${turn.kind}` : ''}`,
      size: params.size ?? pictureSize((await core.imageOf(runtime)), 'location'),
      art,
      // What happened is told with the people it happened through; the picture is of the place.
      ...(turn !== undefined ? { avoid: [...(params.avoid ?? []), L(plang, '人物', 'people')] } : params.avoid !== undefined ? { avoid: params.avoid } : {}),
      ...turnAgainst(entry, turn, plang),
    }
    // The place's reference art: scenes set here send it along. A picture of one turn of its course is that turn's.
    const placeHang: Extract<PictureHang, { as: 'art' }> = { as: 'art', entry: entry.id, ...(turn !== undefined ? { event: `${turn.chapter}:${turn.kind}` } : {}) }
    const placesTried = await tryWith(placeInput, placeHang)
    if (placesTried !== undefined) return placesTried
    const info = await renderImage(core, runtime, placeInput, task)
    const hung = await hangArt(project, info.path, placeHang)
    return hung.spare ? { ...done(info), spare: true } : done(info)
  }

  if (params.kind === 'item') {
    const found = params.target !== undefined ? await project.findWorld(params.target) : undefined
    if (found === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${params.target ?? ''}"`)
    const entry = await withLook(core, runtime, found, task)
    const turn = params.event !== undefined ? await turnOf(project, entry, params.event) : undefined
    // A thing is drawn as a thing: alone, whole, close enough to read what it is made of and what is written or carved on it.
    const thingInput: RenderInput = {
      ...compose([
        use('关键物品设定图', 'design art of one key object'),
        piece('frame', L(plang, '只画这一件物品，完整入画，居中，干净的浅色素底；看得清形状、材质、纹饰与大小的感觉；没有人物，没有手，画面里不出现任何文字说明', 'the object alone, whole and centred on a clean pale ground; its shape, material, ornament and sense of size readable; no people, no hands, no lettering')),
        turn !== undefined ? piece('composed', await turnLook(core, runtime, entry, turn, task)) : entryLook(entry, comma, L(plang, `物件「${entry.name}」：`, `The object "${entry.name}": `)),
        piece('ask', params.prompt),
      ], plang),
      kind: 'item',
      target: entry.id,
      name: `item-${entry.id}${turn !== undefined ? `-${turn.chapter}-${turn.kind}` : ''}`,
      size: params.size ?? pictureSize((await core.imageOf(runtime)), 'item'),
      art,
      ...(params.avoid !== undefined ? { avoid: params.avoid } : {}),
      ...turnAgainst(entry, turn, plang),
    }
    // The thing's reference art: pictures that show it send this along, so that it is the same thing every time.
    const thingHang: Extract<PictureHang, { as: 'art' }> = { as: 'art', entry: entry.id, ...(turn !== undefined ? { event: `${turn.chapter}:${turn.kind}` } : {}) }
    const thingsTried = await tryWith(thingInput, thingHang)
    if (thingsTried !== undefined) return thingsTried
    const info = await renderImage(core, runtime, thingInput, task)
    const hung = await hangArt(project, info.path, thingHang)
    return hung.spare ? { ...done(info), spare: true } : done(info)
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
    // Who is on it: those of the leads its description names — all of them, where it names none (a cover of faces nobody is called by).
    const namedOn = leads.filter(card => namesPerson(description, card))
    const onCover = namedOn.length > 0 ? namedOn : leads
    const coverInput: RenderInput = {
      ...compose([
        use('小说封面插画', 'the cover illustration of a novel'),
        piece('frame', L(plang, '竖幅构图，画面上方留出标题空间，不要出现任何文字', 'portrait orientation, space left at the top for a title, no text at all')),
        piece('composed', description),
        // Whoever the director's picture names, as the bible has them: said once each, under their name.
        ...onCover.map(card => personPiece(card, { look: worn(card) })),
      ], plang),
      kind: 'cover',
      name: 'cover',
      size: params.size ?? pictureSize((await core.imageOf(runtime)), 'cover'),
      art,
      avoid: extraAvoid,
      references: onCover.map(card => referenceOf(card, worn(card))).filter((reference): reference is { path: string; label: string } => reference !== undefined),
    }
    // (The cover is the latest one drawn, unless the author chose a picture for it: one drawn the usual way hangs by being there.)
    return await tryWith(coverInput, { as: 'cover' }) ?? done(await renderImage(core, runtime, coverInput, task))
  }

  // scene: the picture of a passage of a chapter — one the author chose, or the chapter's most visual moment.
  const scene = await sceneOf(project, params, characters)
  const { chapter, range, passage } = scene
  if (passage.trim().length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has nothing to illustrate yet`)
  const world = await project.world()
  // What the director is handed with the task, to tell who and where by: the text before the passage and right after
  // it, the chapter as planned and as digested, its people — as this chapter has them — and whatever of the bible the
  // text around the passage names. More is the director's to look up: it works as an agent, with the book to read.
  const textBefore = range !== undefined ? clipTail(scene.text.slice(0, range.start), 1500) : ''
  const textAfter = range !== undefined ? clip(scene.text.slice(range.end).trim(), 400, '…') : ''
  const around = `${textBefore}\n${passage}\n${textAfter}`
  const known = new Set<string>([...(chapter.plan.characters ?? []), ...(scene.memory?.characters ?? []).map(moment => moment.character ?? ''), ...detectCharacters(around, [...characters]).map(card => card.id)])
  const here = await castAt(runtime, chapter.plan.id, known.size > 0 ? characters.filter(card => known.has(card.id)) : characters.slice(0, 12))
  const named = (entry: WorldEntry): boolean => [entry.name, ...(entry.aliases ?? [])].some(name => [...name.trim()].length >= 2 && (around.includes(name.trim()) || (chapter.plan.location ?? '').includes(name.trim())))
  const entries = world.filter(named).slice(0, 12)
  const art0 = art === false ? undefined : art
  const baseAvoid = mergeAvoid(art0?.avoid, params.avoid)
  const colon = L(lang, '：', ': ')
  const { value: framed } = await assign<Record<string, unknown>>(core, runtime, task, {
    role: 'director',
    label: L(lang, `给第 ${chapter.index} 章的一段定画面`, `Framing a passage of chapter ${chapter.index}`),
    tool: 'frame_picture',
    what: L(lang, '这张插图的画面，画里有谁、在哪、有什么', 'the picture of this illustration: what it shows, who is in it, where, with what'),
    // The line the chapter is on: what the director reads with its own tools is that line's.
    line: chapter.line ?? MAIN_LINE,
    prompt: passagePictureTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      chapter: [
        L(lang, `第 ${chapter.index} 章《${chapter.plan.title}》`, `Chapter ${chapter.index}, "${chapter.plan.title}"`),
        chapter.plan.location !== undefined ? `${L(lang, '地点', 'Place')}${colon}${chapter.plan.location}` : undefined,
        chapter.plan.time !== undefined ? `${L(lang, '时间', 'Time')}${colon}${chapter.plan.time}` : undefined,
        (scene.memory?.summary ?? chapter.plan.synopsis) !== undefined ? `${L(lang, '梗概', 'In short')}${colon}${clip(scene.memory?.summary ?? chapter.plan.synopsis ?? '', 400, '…')}` : undefined,
      ].filter((line): line is string => line !== undefined).join('\n'),
      passage,
      ...(textBefore.length > 0 ? { before: textBefore } : {}),
      ...(textAfter.length > 0 ? { after: textAfter } : {}),
      ...(range === undefined && (params.quote ?? '').trim().length === 0 ? { whole: true } : {}),
      ...(params.prompt !== undefined && params.prompt.trim().length > 0 ? { ask: params.prompt.trim() } : {}),
      cast: here.map((card) => {
        const wardrobe = (card.visual?.looks ?? []).map(look => `「${look.name}」${look.when !== undefined ? `（${look.when}）` : ''}`).join(L(lang, '、', ', '))
        return [
          `${card.name}${(card.aliases ?? []).length > 0 ? `（${(card.aliases ?? []).slice(0, 4).join(L(lang, '、', ', '))}）` : ''}`,
          card.tagline !== undefined ? clip(card.tagline, 60, '…') : card.role,
          looksOf(card).length > 0 ? clip(looksOf(card), 200, '…') : L(lang, '（还没有写下样子）', '(no look written yet)'),
          ...(wardrobe.length > 0 ? [`${L(lang, '造型', 'looks')}${colon}${wardrobe}`] : []),
        ].join(L(lang, '｜', ' | '))
      }).join('\n'),
      places: entries.map(entry => `${entry.name}（${entry.category}）${colon}${clip(entry.summary ?? entry.body ?? '', 100, '…')}${entry.visualPrompt !== undefined && entry.visualPrompt.trim().length > 0 ? `${L(lang, '；看上去', '; it looks')}${colon}${clip(entry.visualPrompt.trim(), 140, '…')}` : ''}`).join('\n'),
      artStyle: art0?.style ?? '',
      avoid: baseAvoid,
    }),
    temperature: 0.6,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.picture) === undefined) throw new Error('"picture" is empty: write what the frame shows')
      return record
    },
  })
  const description = asText(framed.picture)!.trim().replace(/^["“]|["”]$/g, '')
  // Who is in it: those the director names — or, where it names nobody, those of the chapter its picture calls by name.
  const listed = asList(framed.people).map(name => find(name)).filter((card): card is CharacterCard => card !== undefined)
  const inFrame = [...new Map((listed.length > 0 ? listed : here.filter(card => namesPerson(description, card))).map(card => [card.id, card])).values()].slice(0, 4)
  // Whoever of them comes back in the book has a sheet before the picture is drawn: it is held against it.
  // …and is shown as this chapter has them: the look, and the sheet, of the stretch of their life that holds here.
  const cast = await castAt(runtime, chapter.plan.id, await sheeted(inFrame, 'returning'))
  // What each wears there: what the author said for this picture, else what the director picked of their looks.
  const wearing: Record<string, string> = {}
  for (const [who, look] of Object.entries(asRecord(framed.wearing))) {
    const card = find(who)
    const chosen = card !== undefined ? lookOf(card, asText(look)) : undefined
    if (card !== undefined && chosen !== undefined) wearing[card.id] = chosen.name
  }
  for (const card of cast) {
    const asked = worn(card)
    if (asked !== undefined) wearing[card.id] = asked.name
  }
  const place = placeNamed(world, asText(framed.place))
  const things = asList(framed.things)
  const most = referencesOf(image.references)
  // Laid out as a panel of a storyboard is: the director's words for the frame, then — as the bible has them — how
  // everyone in it looks in what they wear there, its place, its things; and their pictures along.
  const makings = panelMakings({ prompt: description, description: passage, characters: cast.map(card => card.id), ...(place !== undefined ? { location: place.name } : {}), ...(Object.keys(wearing).length > 0 ? { looks: wearing } : {}), ...(things.length > 0 ? { things } : {}) }, { characters: cast, world, most, lang: plang, use: L(plang, '小说章节插图', 'an illustration for a chapter of a novel') })
  const why = asText(framed.why)
  const framing = {
    people: cast.map(card => card.name),
    ...(place !== undefined ? { place: place.name } : {}),
    ...(makings.pieces?.some(part => part.of === 'thing') === true ? { things: makings.pieces.filter(part => part.of === 'thing').map(part => part.name ?? '') } : {}),
    ...(why !== undefined ? { why } : {}),
  }
  task.job?.result({ framed: framing })
  framedOf = framing
  const alt = clip(description.replace(/[\]\n]/g, ' '), 60, '')
  const passageInput: RenderInput = {
    subject: makings.subject,
    ...(makings.pieces !== undefined ? { pieces: makings.pieces } : {}),
    kind: 'scene',
    target: chapter.plan.id,
    name: `scene-${chapter.plan.id}`,
    size: params.size ?? pictureSize(image, 'scene'),
    art,
    avoid: [...(params.avoid ?? []), ...makings.avoid],
    references: makings.references,
    passage: { ...(range !== undefined || (params.quote ?? '').trim().length > 0 ? { quote: clip(passage.trim(), 240, '…') } : {}), ...(why !== undefined ? { why } : {}) },
  }
  const passageHang: Extract<PictureHang, { as: 'passage' }> = { as: 'passage', chapter: chapter.plan.id, ...(range !== undefined ? { quote: params.quote!.trim() } : {}), alt, ...(params.insert === true ? { insert: true } : {}) }
  const passagesTried = await tryWith(passageInput, passageHang)
  if (passagesTried !== undefined) return passagesTried
  const info = await renderImage(core, runtime, passageInput, task)
  const inserted = params.insert === true && await hangInText(project, info.path, passageHang)
  task.job?.result({ path: info.path, ...(first.drawn.length > 0 ? { sheets: first.drawn } : {}) })
  return done(info, inserted)
}

/** Where a design sheet goes once it is drawn — or taken, of several drawn to be compared: a stretch's, a look's, or among the card's own. */
async function hangSheet(project: ProjectRuntime['project'], path: string, hang: Extract<PictureHang, { as: 'sheet' }>): Promise<{ spare: boolean }> {
  const card = await project.findCharacter(hang.character)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${hang.character}"`)
  const frontOnly = hang.front === true
  // Kept with the sheet: whether it is the front view alone — whoever shows it, or holds a picture against it, goes by that.
  const views = frontOnly ? { sheetFront: true } : {}
  if (hang.look === undefined && hang.stage !== undefined) await keepStage(project, card.id, hang.stage, { sheet: path, ...views }, frontOnly ? [] : ['sheetFront'])
  else if (hang.look === undefined) {
    // It joins the sheets kept of them, first. The main one it is unless the author chose another: then it waits, not in use.
    const kept = await project.saveCharacter({ id: card.id, visual: { sheet: path, sheetFront: frontOnly ? true : null } as unknown as CharacterCard['visual'] })
    if (kept.visual?.sheet !== path) return { spare: true }
  } else {
    // The look as it is on the card now, where it is there (its words may have been changed since); as it was drawn, where the drawing made it.
    const { sheetFront: _was, ...rest } = { ...hang.look, ...(card.visual?.looks ?? []).find(other => other.id === hang.look!.id) }
    const looks = [...(card.visual?.looks ?? []).filter(other => other.id !== hang.look!.id), { ...rest, sheet: path, ...views }]
    await project.saveCharacter({ id: card.id, visual: { looks } })
  }
  return { spare: false }
}

/**
 * Where the art of a place, a house or a thing goes: among the entry's own design pictures, first — the main one
 * unless the author chose another, which then stays (`spare`) — or, of one turn of its course, that turn's.
 * @param take - the author took this very picture (of several drawn to compare): it is the main one, over one chosen before.
 */
async function hangArt(project: ProjectRuntime['project'], path: string, hang: Extract<PictureHang, { as: 'art' }>, take = false): Promise<{ entry: WorldEntry; spare: boolean }> {
  const entry = await project.findWorld(hang.entry)
  if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${hang.entry}"`)
  if (hang.event !== undefined) {
    await keepTurnPicture(project, entry, await turnOf(project, entry, hang.event), path)
    return { entry, spare: false }
  }
  const kept = await project.saveWorld({ id: entry.id, visualImage: path, ...(take && entry.visualMain !== undefined ? { visualMain: path } : {}) })
  return { entry, spare: kept.visualImage !== path }
}

/** Put the picture of a passage into the chapter's text, after the paragraph the passage ends in — at the top where the passage is no longer found. */
async function hangInText(project: ProjectRuntime['project'], path: string, hang: Extract<PictureHang, { as: 'passage' }>): Promise<boolean> {
  const current = await project.chapterText(hang.chapter)
  // (Already there: taken a second time, it is not put in a second time.)
  if (current.includes(`](${path})`)) return true
  const at = hang.quote !== undefined ? fuzzyFind(current, hang.quote) : undefined
  const tag = `![${hang.alt ?? ''}](${path})`
  let next: string
  if (at !== undefined) {
    const breakAt = current.indexOf('\n', at.end)
    const position = breakAt < 0 ? current.length : breakAt
    next = `${current.slice(0, position)}\n\n${tag}\n\n${current.slice(position).replace(/^\n+/, '')}`
  } else {
    next = `${tag}\n\n${current}`
  }
  await project.saveChapterText(hang.chapter, next, { reason: 'before-illustration' })
  return true
}

/**
 * Take a picture that was drawn to be compared: it goes where one drawn the usual way would have gone — what its
 * record says (`trial.hang`) — and is a picture like any other from then on (the record no longer says it waits).
 * @returns whose it is now, by name, for the author to be told.
 */
export async function hangPicture(runtime: ProjectRuntime, record: IllustrationInfo): Promise<string[]> {
  const hang = record.trial?.hang
  if (hang === undefined) return []
  const held = await hangAs(runtime, record, hang)
  await runtime.project.tookTrial(record.path)
  return held
}

/** Put a picture where it is to be: what {@link PictureHang} says — the one place that knows how each kind of picture is kept. */
async function hangAs(runtime: ProjectRuntime, record: IllustrationInfo, hang: PictureHang): Promise<string[]> {
  const { project } = runtime
  const held: string[] = []
  if (hang.as === 'portrait') {
    const card = await project.findCharacter(hang.character)
    if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${hang.character}"`)
    // Of a moment of theirs, it is that moment's picture from here on — the moment its record says it is of, by name
    // before number (a chapter digested again numbers its moments anew).
    const of = sceneOfPicture(scenesOf(card), record.path, record)
    const kept = of !== undefined ? await besideMoment(project, card.id, of, { portrait: record.path }) : undefined
    if (hang.stage !== undefined && stageOf(card, hang.stage) !== undefined) {
      await keepStage(project, card.id, hang.stage, { portrait: record.path })
      await project.saveCharacter({ id: card.id, visual: { ...(card.visual?.portrait === undefined ? { portrait: record.path } : {}), ...kept } })
    } else await project.saveCharacter({ id: card.id, visual: { portrait: record.path, ...kept } })
    held.push(card.name)
  } else if (hang.as === 'sheet') {
    await hangSheet(project, record.path, hang)
    held.push((await project.findCharacter(hang.character))?.name ?? hang.character)
  } else if (hang.as === 'art') held.push((await hangArt(project, record.path, hang, true)).entry.name)
  else if (hang.as === 'cover') {
    await project.updateManifest({ cover: record.path })
    held.push((await project.manifest()).title)
  } else if (hang.as === 'passage') {
    if (hang.insert === true) await hangInText(project, record.path, hang)
    const chapter = await project.findChapter(hang.chapter)
    if (hang.insert === true && chapter !== undefined) held.push(chapter.plan.title)
  } else if (hang.as === 'panel') {
    await project.patchComicPanels(hang.chapter, new Map([[hang.panel, { image: record.path }]]))
    held.push((await project.findChapter(hang.chapter))?.plan.title ?? hang.chapter)
  }
  return held
}

/** What a picture file is, told by its first bytes — whatever it was called: a PNG, a JPEG or a WebP; nothing for anything else. */
function pictureEnding(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | undefined {
  const head = Buffer.from(bytes.subarray(0, 12))
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return undefined
}

/**
 * Take in a picture of somebody that was made elsewhere — a file of the author's — as their portrait or their design
 * sheet: it is kept among the book's pictures and hangs where one drawn here would (their portraits, their sheets; a
 * look's sheet; a stretch's; the portrait of one of their moments). It has no prompt: its record says it was brought in.
 * @param params.front - a sheet: whether it shows the front view alone. Left out: told by its shape — a picture wider
 *   than it is tall is taken for the three views side by side, one that stands for the single figure.
 * @throws ProjectError `novel/invalid` for a file that is no picture the Studio reads, or too large; `novel/not-found` for nobody by that name.
 */
export async function importPicture(runtime: ProjectRuntime, params: { kind: 'portrait' | 'sheet'; target: string; data: Uint8Array; look?: string; stage?: string; scene?: string; front?: boolean }): Promise<{ info: IllustrationInfo; held: string[]; spare?: boolean }> {
  const { project } = runtime
  const card = await project.findCharacter(params.target)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.target}"`)
  const ending = pictureEnding(params.data)
  if (ending === undefined || params.data.length < 64) throw new ProjectError('novel/invalid', 'that is not a picture the Studio can read (PNG, JPEG, WebP)')
  if (params.data.length > 32 * 1024 * 1024) throw new ProjectError('novel/invalid', 'that picture is larger than 32 MB: bring in a smaller copy')
  const stage = params.stage !== undefined ? stageOf(card, params.stage) : undefined
  if (params.stage !== undefined && stage === undefined) throw new ProjectError('novel/not-found', `${card.name} has no stretch "${params.stage}"`)
  const look = params.kind === 'sheet' && params.look !== undefined ? lookOf(card, params.look) : undefined
  if (params.kind === 'sheet' && params.look !== undefined && look === undefined) throw new ProjectError('novel/not-found', `${card.name} has no look called "${params.look}"`)
  const moment = params.kind === 'portrait' && params.scene !== undefined ? scenesOf(card).find(scene => scene.id === params.scene) : undefined
  if (params.scene !== undefined && params.kind === 'portrait' && moment === undefined) throw new ProjectError('novel/not-found', `${card.name} has no signature scene "${params.scene}"`)
  // Named as a picture of its kind drawn here is, and by what it is: the same file brought in twice is one file.
  const path = await project.writeAsset(`images/${params.kind}-${card.id}-${hashText(Buffer.from(params.data).toString('base64')).slice(0, 8)}.${ending}`, params.data)
  const size = pixelsOf(params.data)
  const info: IllustrationInfo = {
    id: newId('img'),
    path,
    prompt: '',
    kind: params.kind,
    target: card.id,
    createdAt: new Date().toISOString(),
    imported: true,
    ...(size !== undefined ? { size: `${size.width}x${size.height}` } : {}),
    ...(moment !== undefined ? { moment: { title: moment.title, ...(moment.id !== 'kept' ? { scene: moment.id } : {}), ...(moment.chapter !== undefined ? { chapter: moment.chapter } : {}) } } : {}),
  }
  // (Brought in again: its record is there already, and it is hung again where it is asked to be.)
  if (!(await project.illustrations()).some(item => item.path === path)) await project.addIllustration(info)
  const front = params.front ?? (size !== undefined ? size.width <= size.height * 1.15 : false)
  const hang: PictureHang = params.kind === 'sheet'
    ? { as: 'sheet', character: card.id, ...(look !== undefined ? { look } : {}), ...(look === undefined && stage !== undefined ? { stage: stage.id } : {}), ...(front ? { front: true } : {}) }
    : { as: 'portrait', character: card.id, ...(stage !== undefined ? { stage: stage.id } : {}) }
  const before = params.kind === 'sheet' && look === undefined && stage === undefined ? (await project.findCharacter(card.id))?.visual?.mainSheet : undefined
  const held = await hangAs(runtime, info, hang)
  // A sheet beside one the author chose as the main sheet waits, not in use — as one drawn here would.
  const spare = before !== undefined && (await project.findCharacter(card.id))?.visual?.sheet !== path
  return { info, held, ...(spare ? { spare: true } : {}) }
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
 * @param has.lang - the language the prompt is written in ({@link promptLangOf}).
 */
export function panelMakings(panel: Pick<ComicPanel, 'prompt' | 'description' | 'characters' | 'location' | 'looks' | 'things'>, has: { characters: readonly CharacterCard[]; world: readonly WorldEntry[]; most: number; lang: PromptLanguage; /** `false`: the art of the things it shows does not go along (`image.panelThings`). */ thingArt?: boolean; /** What the picture is for, where it is not a panel of a motion comic. */ use?: string }): Pick<RenderInput, 'subject' | 'pieces'> & { references: Held[]; avoid: string[] } {
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
  const composed = compose([
    { of: 'use', text: has.use ?? L(lang, '有声漫的一格画面（分镜）', 'one panel of a motion comic') },
    piece('composed', panel.prompt),
    ...shown.map(card => personPiece(card, { look: worn(card) })),
    place !== undefined && place.visualPrompt !== undefined && place.visualPrompt.trim().length > 0 ? entryPiece('place', place, 260) : undefined,
    ...things.map(entry => entryPiece('thing', entry)),
  ], lang)
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

/**
 * Who and what a moment shows besides the person, for its picture: those the frame the director made of it names —
 * it read the text for that — and, where there is no frame or it names none of a kind, those the moment's own words
 * name ({@link sceneMakings}).
 */
function momentMakings(shot: SceneShot | undefined, told: string, subject: CharacterCard, has: { characters: readonly CharacterCard[]; world: readonly WorldEntry[] }): ReturnType<typeof sceneMakings> {
  const read = sceneMakings(told, subject, has)
  if (shot === undefined) return read
  const person = (name: string): CharacterCard | undefined => has.characters.find(card => card.id !== subject.id && (sameName(card.name, name) || (card.aliases ?? []).some(alias => sameName(alias, name))))
  const entry = (name: string, group: 'places' | 'items'): WorldEntry | undefined => has.world.find(item => groupOf(item.category) === group && (sameName(item.name, name) || (item.aliases ?? []).some(alias => sameName(alias, name))))
  const unique = <T extends { id: string }>(items: (T | undefined)[]): T[] => [...new Map(items.filter((item): item is T => item !== undefined).map(item => [item.id, item])).values()]
  const others = shot.people !== undefined ? unique(shot.people.map(person)).slice(0, 3) : read.others
  const place = (shot.place !== undefined ? entry(shot.place, 'places') ?? placeNamed(has.world.filter(item => groupOf(item.category) === 'places'), shot.place) : undefined) ?? read.place
  const things = shot.things !== undefined ? unique(shot.things.map(name => entry(name, 'items'))).slice(0, 3) : read.things
  return { others, ...(place !== undefined ? { place } : {}), things }
}

/** Whether a text names somebody: by their name, or by one they also go by. */
const namesPerson = (text: string, card: CharacterCard): boolean => [card.name, ...(card.aliases ?? [])].some(name => [...name.trim()].length >= 2 && text.includes(name.trim()))

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

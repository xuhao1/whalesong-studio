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
 *                   reference art travels the same way.
 *   an avoid list   per Studio, per book, per character and per call, joined
 *                   and sent with every picture.
 *
 * Every picture records what its prompt was assembled from.
 */
import { readFile } from 'node:fs/promises'
import { mergeAvoid, resolveArtStyle, splitAvoid, type ArtSource } from '../../shared/art'
import type { CharacterCard, CharacterLook, IllustrationInfo, IllustrationParts, WorldEntry } from '../../shared/types'
import { clip, fuzzyFind, hashText, newId, sameName, slugify } from '../../shared/text'
import { detectCharacters } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asRecord, asText, completeJson, extractJson } from '../llm'
import { extensionOf, MAX_REFERENCES, type ImageProvider, type ImageReference } from '../media/image'
import { ProviderError } from '../media/http'
import { ProjectError } from '../project'
import { illustrationPromptTask, visualAnchorTask } from '../prompts'
import { L, promptLanguage, renderCharacter } from '../render'
import { isAbort } from '../util/async'

export { DEFAULT_ART_STYLE } from '../../shared/art'

export interface IllustrateParams {
  kind: 'portrait' | 'sheet' | 'scene' | 'location' | 'cover' | 'custom'
  /** Character (portrait, sheet), chapter (scene) or world entry (location). */
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
  const route = await core.route('analyst', runtime, task)
  const { value } = await completeJson(core.llm, {
    route,
    prompt: visualAnchorTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      card: renderCharacter({ ...card, secrets: undefined, relationships: undefined, notes: undefined } as CharacterCard, lang),
      avoid: art.avoid,
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    temperature: 0.3,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
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
  for (const reference of input.references ?? []) {
    if (references.length >= MAX_REFERENCES || references.some(known => known.path === reference.path)) continue
    try {
      const data = await readFile(project.path(reference.path))
      references.push({ ...reference, image: { data, mime: /\.jpe?g$/i.test(reference.path) ? 'image/jpeg' : /\.webp$/i.test(reference.path) ? 'image/webp' : 'image/png', label: reference.label } })
    } catch {
      // A reference whose file is gone is simply not sent.
    }
  }
  const referenceLine = references.length === 0 ? undefined : zh
    ? `参考图：${references.map((reference, index) => `第${index + 1}张是${reference.label}`).join('；')}。画面里出现的这些人物和场所必须与各自的参考图一致（脸、发型、体型、服装、结构与材质）；构图、动作与光线以本描述为准。`
    : `Reference images: ${references.map((reference, index) => `#${index + 1} shows ${reference.label}`).join('; ')}. Whoever and whatever they show must match their reference (face, hair, build, clothing, structure and materials); composition, action and light follow this description.`
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

// ───────────────────────────── the kinds of picture ─────────────────────────────

/** Things a character's own card says must not be drawn on them. */
const negativesOf = (cards: readonly CharacterCard[]): string[] => cards.flatMap(card => splitAvoid(card.visual?.negative))

export interface IllustrateResult extends IllustrationInfo {
  inserted: boolean
  /** The art direction was written into the book by this call. */
  pinnedStyle?: string
}

export async function illustrate(core: NovelCore, runtime: ProjectRuntime, params: IllustrateParams, task: TaskContext): Promise<IllustrateResult> {
  const { project } = runtime
  await requireImages(core)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const comma = lang === 'zh' ? '，' : ', '
  const raw = params.kind === 'custom' && params.raw === true
  const art = raw ? false as const : await artDirectionOf(core, runtime, { pin: true })
  const done = (info: IllustrationInfo, inserted = false): IllustrateResult => ({ ...info, inserted, ...(art !== false && art.pinned === true ? { pinnedStyle: art.style } : {}) })
  const characters = await project.characters()
  const find = (ref: string): CharacterCard | undefined => characters.find(card => card.id === ref || sameName(card.name, ref) || (card.aliases ?? []).some(alias => sameName(alias, ref)))
  const worn = (card: CharacterCard): CharacterLook | undefined => {
    for (const [who, look] of Object.entries(params.looks ?? {})) if (find(who)?.id === card.id) return lookOf(card, look)
    return undefined
  }

  if (params.kind === 'custom') {
    if (params.prompt === undefined || params.prompt.trim().length === 0) throw new ProjectError('novel/invalid', 'a custom illustration needs a prompt')
    const shown = (params.characters ?? []).map(find).filter((card): card is CharacterCard => card !== undefined)
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
    const card = await withAnchor(core, runtime, found, task)
    if (looksOf(card).length === 0) throw new ProjectError('novel/invalid', `${card.name} has no appearance yet — describe how they look first (or let novel_bible expand the card)`)

    if (params.kind === 'portrait') {
      const subject = joinParts([
        L(lang, '人物立绘，半身像，面向镜头，纯净的浅色背景', 'character portrait, waist-up, facing the viewer, plain light background'),
        looksOf(card),
        card.personality !== undefined ? L(lang, `神态体现：${clip(card.personality, 60, '')}`, `expression showing: ${clip(card.personality, 80, '')}`) : undefined,
        params.prompt,
      ], comma)
      // A portrait drawn after the sheet shows the same person as the sheet.
      const sheet = card.visual?.sheet !== undefined ? [{ path: card.visual.sheet, label: card.name }] : []
      const info = await renderImage(core, runtime, { subject, kind: 'portrait', target: card.id, name: `portrait-${card.id}`, size: params.size ?? '1024x1024', art, avoid: [...(params.avoid ?? []), ...negativesOf([card])], references: sheet }, task)
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
      size: params.size ?? '1536x1024',
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
    const entry = params.target !== undefined ? await project.findWorld(params.target) : undefined
    if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${params.target ?? ''}"`)
    const subject = joinParts([
      L(lang, '场景设定图，无人物，远景，交代空间结构、材质与光线', 'environment design art, no people, wide shot showing layout, materials and light'),
      entry.visualPrompt ?? `${entry.name}${comma}${entry.summary ?? clip(entry.body ?? '', 200, '')}`,
      params.prompt,
    ], comma)
    const info = await renderImage(core, runtime, { subject, kind: 'location', target: entry.id, name: `location-${entry.id}`, size: params.size ?? '1280x720', art, ...(params.avoid !== undefined ? { avoid: params.avoid } : {}) }, task)
    // The place's reference art: scenes set here send it along.
    await project.saveWorld({ id: entry.id, visualImage: info.path })
    return done(info)
  }

  if (params.kind === 'cover') {
    const leads = characters.filter(card => card.role === 'protagonist').slice(0, 2)
    const subject = joinParts([
      L(lang, '小说封面插画，竖幅构图，画面上方留出标题空间，不要出现任何文字', 'novel cover illustration, portrait orientation, space left at the top for a title, no text at all'),
      manifest.logline ?? manifest.premise ?? manifest.title,
      ...leads.map(card => looksOf(card, worn(card))).filter(text => text.length > 0),
      params.prompt,
    ], comma)
    const info = await renderImage(core, runtime, {
      subject,
      kind: 'cover',
      name: 'cover',
      size: params.size ?? '768x1152',
      art,
      avoid: [...(params.avoid ?? []), ...negativesOf(leads)],
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
  const cast = (present.length > 0 ? present : characters.filter(card => chapter.plan.characters?.includes(card.id) === true)).slice(0, 5)
  // Places and things the passage names, as the bible says they look.
  const places = (await project.world()).filter(entry => [entry.name, ...(entry.aliases ?? [])].some(name => name.length >= 2 && passage.includes(name))).slice(0, 6)
  const wardrobe = cast.map(wardrobeOf).filter((line): line is string => line !== undefined)
  const extraAvoid = [...(params.avoid ?? []), ...negativesOf(cast)]
  const route = await core.route('analyst', runtime, task)
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
  const place = places.find(entry => entry.visualImage !== undefined)
  // Faces first: with room for three references, two people and the place they stand in.
  const people = cast.map(card => referenceOf(card, wearing(card))).filter((reference): reference is { path: string; label: string } => reference !== undefined)
  const references = place?.visualImage !== undefined
    ? [...people.slice(0, MAX_REFERENCES - 1), { path: place.visualImage, label: L(lang, `场所「${place.name}」`, `the place "${place.name}"`) }]
    : people
  const info = await renderImage(core, runtime, { subject: description, kind: 'scene', target: chapter.plan.id, name: `scene-${chapter.plan.id}`, size: params.size ?? '1280x720', art, avoid: extraAvoid, references }, task)
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
  task.job?.result({ path: info.path })
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

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Interludes: a playable scene branched off the canon.
 *
 * The author steps into one character (or directs from outside) at a chosen
 * point of the book; a director model plays everyone else, turn by turn, from
 * the same bible and memory the writer uses. With portraits, backgrounds,
 * voices and ambience it runs as a small visual novel. Nothing in the
 * manuscript changes until the author decides what the scene was: thrown away,
 * kept as a side story, or novelized into a chapter.
 */
import type { AmbiencePreset, CharacterCard, PlayLine, PlaySession, PlayTurn } from '../../shared/types'
import { PLAY_CONTEXT_DEFAULT } from '../../shared/types'
import { clip, hashText, newId, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText, completeJson } from '../llm'
import { encodeWav } from '../media/wav'
import type { Project } from '../project'
import { ProjectError } from '../project'
import { directorSystem, directorTask, novelizeSystem } from '../prompts'
import { L, promptLanguage, renderStyle, withStyleExtra } from '../render'
import { AMBIENCE, earsFor, openCast, requireSpeech, retakesOf, speakChecked, speechRequest, voiceBank, voiceFor } from './audio'
import { scheduleDigest } from './digest'
import { artDirectionOf, illustrate, renderImage } from './illustrate'
import { cleanProse } from './write'
import { pictureSize } from '../../shared/art'

const AMBIENCE_KEYS = Object.keys(AMBIENCE) as AmbiencePreset[]

export interface StartPlayParams {
  title?: string
  /** Chapter the scene branches from; canon through it is known. Defaults to the latest written chapter. */
  anchor?: string
  /** Character the human plays; omit to direct from outside. */
  player?: string
  cast: string[]
  location?: string
  situation: string
  tone?: string
}

async function requireSession(project: Project, id: string): Promise<PlaySession> {
  const session = await project.playSession(id)
  if (session === undefined) throw new ProjectError('novel/not-found', `no interlude "${id}"`)
  return session
}

function transcriptOf(session: PlaySession, characters: CharacterCard[], zh: boolean, maxChars = 9000): string {
  const playerName = characters.find(card => card.id === session.player)?.name
  const blocks = session.turns.map((turn) => {
    const parts: string[] = []
    if (turn.input !== undefined) {
      const who = playerName ?? (zh ? '导演' : 'Director')
      const verb = turn.input.kind === 'do' ? (zh ? '（行动）' : ' (action)') : turn.input.kind === 'direct' ? (zh ? '（指示）' : ' (direction)') : ''
      parts.push(`▶ ${who}${verb}${zh ? '：' : ': '}${turn.input.text}`)
    }
    if (turn.narration !== undefined && turn.narration.length > 0) parts.push(turn.narration)
    for (const line of turn.lines) parts.push(`${line.speaker}${line.action !== undefined ? `（${line.action}）` : ''}${zh ? '：' : ': '}${line.text}`)
    return parts.join('\n')
  })
  // The opening and the recent turns matter most; the middle of a long scene is elided.
  let text = blocks.join('\n\n')
  if (text.length > maxChars && blocks.length > 8) {
    const head = blocks.slice(0, 2).join('\n\n')
    const tail: string[] = []
    let length = head.length
    for (let i = blocks.length - 1; i >= 2 && length + blocks[i]!.length < maxChars; i--) {
      tail.unshift(blocks[i]!)
      length += blocks[i]!.length
    }
    text = `${head}\n\n${zh ? '……（中间若干回合略）……' : '… (turns omitted) …'}\n\n${tail.join('\n\n')}`
  }
  return text
}

async function runTurn(core: NovelCore, runtime: ProjectRuntime, session: PlaySession, input: PlayTurn['input'] | undefined, task: TaskContext): Promise<PlayTurn> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const characters = await project.characters()
  const route = await core.route('director', runtime, task)
  const anchor = session.anchorChapter !== undefined ? await project.findChapter(session.anchorChapter) : undefined
  const pack = await core.pack(runtime, route, {
    purpose: 'play',
    ...(anchor !== undefined ? { canonThrough: anchor.index } : {}),
    brief: `${session.situation}\n${session.location ?? ''}\n${input?.text ?? ''}`,
    characters: [...session.cast, ...(session.player !== undefined ? [session.player] : [])],
    // A turn has to come back while the player waits: it carries what the author set for a turn, not what the model could read.
    limit: (await core.settingsOf(runtime)).context.playTokens ?? PLAY_CONTEXT_DEFAULT,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const player = characters.find(card => card.id === session.player)
  const base = { lang, language: manifest.language, title: manifest.title }
  const state = session.state !== undefined ? Object.entries(session.state).map(([key, value]) => `${key}: ${value}`).join('\n') : undefined
  const { value } = await completeJson(core.llm, {
    route,
    system: await (async () => { const style = await project.activeStyle(); return withStyleExtra(directorSystem({ ...base, style: renderStyle(style, lang), ...(player !== undefined ? { player: player.name } : {}) }), style, lang, true) })(),
    prompt: directorTask({
      ...base,
      context: pack.text,
      situation: [session.situation, session.location !== undefined ? `${L(lang, '地点', 'Location')}: ${session.location}` : undefined, session.tone !== undefined ? `${L(lang, '基调', 'Tone')}: ${session.tone}` : undefined].filter(Boolean).join('\n'),
      transcript: transcriptOf(session, characters, lang === 'zh'),
      ambience: AMBIENCE_KEYS.join(', '),
      ...(state !== undefined ? { state } : {}),
      ...(input !== undefined ? { input: input.text } : {}),
    }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.narration) === undefined && asArray(record.lines).length === 0) throw new Error('the turn has neither narration nor lines')
      return record
    },
  })
  const lines: PlayLine[] = []
  for (const raw of asArray(value.lines)) {
    const item = asRecord(raw)
    const speaker = asText(item.speaker)
    const text = asText(item.text)
    if (speaker === undefined || text === undefined) continue
    const card = characters.find(candidate => sameName(candidate.name, speaker) || candidate.aliases?.some(alias => sameName(alias, speaker)) === true)
    // The player's character is never voiced by the director, whatever the model tried.
    if (card !== undefined && card.id === session.player) continue
    const emotion = asText(item.emotion)
    const action = asText(item.action)
    lines.push({
      speaker: card?.name ?? speaker,
      ...(card !== undefined ? { character: card.id } : {}),
      text: text.replace(/^["“「『]+|["”」』]+$/g, ''),
      ...(emotion !== undefined ? { emotion } : {}),
      ...(action !== undefined ? { action } : {}),
    })
  }
  const sceneRaw = asRecord(value.scene)
  const ambience = asText(sceneRaw.ambience) as AmbiencePreset | undefined
  const scene: NonNullable<PlayTurn['scene']> = {
    ...(asText(sceneRaw.location) !== undefined ? { location: asText(sceneRaw.location)! } : {}),
    ...(asText(sceneRaw.time) !== undefined ? { time: asText(sceneRaw.time)! } : {}),
    ...(asText(sceneRaw.mood) !== undefined ? { mood: asText(sceneRaw.mood)! } : {}),
    ...(ambience !== undefined && AMBIENCE_KEYS.includes(ambience) ? { ambience } : {}),
  }
  const narration = asText(value.narration)
  const stateRaw = asRecord(value.state)
  const nextState: Record<string, string | number> = { ...session.state }
  for (const [key, entry] of Object.entries(stateRaw)) {
    if (typeof entry === 'string' || typeof entry === 'number') nextState[key.slice(0, 40)] = typeof entry === 'string' ? entry.slice(0, 120) : entry
  }
  const turn: PlayTurn = {
    id: newId('t'),
    ...(input !== undefined ? { input } : {}),
    ...(narration !== undefined ? { narration } : {}),
    lines,
    choices: asList(value.choices).slice(0, 4),
    ...(Object.keys(scene).length > 0 ? { scene } : {}),
    ...(value.ended === true ? { ended: true } : {}),
    createdAt: new Date().toISOString(),
  }
  const updated: PlaySession = { ...session, turns: [...session.turns, turn], ...(Object.keys(nextState).length > 0 ? { state: nextState } : {}) }
  await project.savePlaySession(updated)
  return turn
}

/** Set up an interlude and play its opening turn. */
export async function startPlay(core: NovelCore, runtime: ProjectRuntime, params: StartPlayParams, task: TaskContext): Promise<PlaySession> {
  const { project } = runtime
  const manifest = await project.manifest()
  const zh = promptLanguage(manifest.language) === 'zh'
  if (params.situation.trim().length === 0) throw new ProjectError('novel/invalid', 'an interlude needs a starting situation')
  const cast: string[] = []
  for (const ref of params.cast) {
    const card = await project.findCharacter(ref)
    if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${ref}"`)
    if (!cast.includes(card.id)) cast.push(card.id)
  }
  const player = params.player !== undefined && params.player.trim().length > 0 ? await project.findCharacter(params.player) : undefined
  if (params.player !== undefined && params.player.trim().length > 0 && player === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.player}"`)
  let anchor = params.anchor !== undefined ? await project.findChapter(params.anchor) : undefined
  if (params.anchor !== undefined && anchor === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.anchor}"`)
  if (anchor === undefined) {
    const written = (await project.chapterInfos()).filter(info => info.hasText).at(-1)
    anchor = written !== undefined ? await project.findChapter(written.id) : undefined
  }
  const now = new Date().toISOString()
  const session: PlaySession = {
    schema: 1,
    id: newId('play'),
    title: params.title?.trim() || clip(params.situation, 24, '…') || (zh ? '幕间' : 'Interlude'),
    createdAt: now,
    updatedAt: now,
    ...(anchor !== undefined ? { anchorChapter: anchor.plan.id } : {}),
    ...(player !== undefined ? { player: player.id } : {}),
    cast: cast.filter(id => id !== player?.id),
    ...(params.location !== undefined && params.location.trim().length > 0 ? { location: params.location.trim() } : {}),
    situation: params.situation.trim(),
    ...(params.tone !== undefined && params.tone.trim().length > 0 ? { tone: params.tone.trim() } : {}),
    turns: [],
    outcome: 'open',
  }
  await project.savePlaySession(session)
  await runTurn(core, runtime, session, undefined, task)
  return await requireSession(project, session.id)
}

/** Play one turn from the human's input. */
export async function playTurn(core: NovelCore, runtime: ProjectRuntime, params: { session: string; kind?: NonNullable<PlayTurn['input']>['kind']; text: string }, task: TaskContext): Promise<{ session: PlaySession; turn: PlayTurn }> {
  const session = await requireSession(runtime.project, params.session)
  if (params.text.trim().length === 0) throw new ProjectError('novel/invalid', 'say or do something')
  const turn = await runTurn(core, runtime, session, { kind: params.kind ?? (session.player !== undefined ? 'say' : 'direct'), text: params.text.trim() }, task)
  return { session: await requireSession(runtime.project, session.id), turn }
}

/** Drop the last turn so the human can try something else. */
export async function rewindPlay(runtime: ProjectRuntime, id: string): Promise<PlaySession> {
  const session = await requireSession(runtime.project, id)
  if (session.turns.length <= 1) return session
  const next: PlaySession = { ...session, turns: session.turns.slice(0, -1) }
  await runtime.project.savePlaySession(next)
  return next
}

export async function setPlayOutcome(runtime: ProjectRuntime, id: string, outcome: NonNullable<PlaySession['outcome']>): Promise<PlaySession> {
  const session = await requireSession(runtime.project, id)
  const next: PlaySession = { ...session, outcome }
  await runtime.project.savePlaySession(next)
  return next
}

/** Voice one line of a turn on demand; rendered audio is cached on the turn. */
export async function voicePlayLine(core: NovelCore, runtime: ProjectRuntime, params: { session: string; turn: string; line: number }, task: TaskContext): Promise<{ path: string }> {
  const { project } = runtime
  const session = await requireSession(project, params.session)
  const turn = session.turns.find(candidate => candidate.id === params.turn)
  // line -1 addresses the narration.
  const line = params.line < 0 ? undefined : turn?.lines[params.line]
  if (turn === undefined || (params.line >= 0 && line === undefined)) throw new ProjectError('novel/not-found', 'no such line')
  if (line?.audio !== undefined) return { path: line.audio }
  const provider = await requireSpeech(core, runtime)
  const settings = (await core.settingsOf(runtime)).tts
  const manifest = await project.manifest()
  const characters = await project.characters()
  const text = line?.text ?? turn.narration ?? ''
  if (text.length === 0) throw new ProjectError('novel/empty', 'nothing to speak')
  // The interlude speaks with the book's voices: whoever was cast for the audio drama sounds the same here.
  const cast = await openCast(project, settings)
  const choice = voiceFor(
    line === undefined ? { kind: 'narration' } : { kind: 'dialogue', ...(line.character !== undefined ? { speaker: line.character } : {}), speakerName: line.speaker, ...(line.emotion !== undefined || line.action !== undefined ? { direction: [line.emotion, line.action].filter(Boolean).join('，') } : {}) },
    characters,
    settings,
    cast.taken,
    cast.extras,
  )
  const key = hashText([settings.provider, choice.voice ?? '', choice.direction ?? '', text].join('|')).slice(0, 10)
  const relative = `audio/play/${session.id}/${key}.wav`
  if (!(await project.has(`assets/${relative}`))) {
    const ears = await earsFor(core, runtime)
    const reference = voiceBank(core, runtime, provider, settings, manifest.language, task.signal, undefined, ears)
    // A turn is waited for: one retake at most.
    const take = await speakChecked(provider, await speechRequest(choice, text, manifest.language, reference, task.signal), { ears, retakes: Math.min(1, retakesOf(settings)) })
    await project.writeAsset(relative, encodeWav(take.audio))
  }
  await cast.save().catch(() => {})
  const path = `assets/${relative}`
  if (line !== undefined) {
    const fresh = await requireSession(project, session.id)
    await project.savePlaySession({
      ...fresh,
      turns: fresh.turns.map(candidate => candidate.id !== turn.id ? candidate : { ...candidate, lines: candidate.lines.map((entry, index) => index === params.line ? { ...entry, audio: path } : entry) }),
    })
  }
  return { path }
}

/** Paint the background of a turn's scene; one picture per location is reused across turns. */
export async function paintPlayScene(core: NovelCore, runtime: ProjectRuntime, params: { session: string; turn: string }, task: TaskContext): Promise<{ path: string }> {
  const { project } = runtime
  const session = await requireSession(project, params.session)
  const at = session.turns.findIndex(candidate => candidate.id === params.turn)
  if (at < 0) throw new ProjectError('novel/not-found', 'no such turn')
  // The scene in force is the latest one declared at or before this turn.
  let sceneTurn = at
  while (sceneTurn > 0 && session.turns[sceneTurn]!.scene?.location === undefined) sceneTurn--
  const scene = session.turns[sceneTurn]!.scene
  const location = scene?.location ?? session.location ?? session.situation
  const existing = session.turns.slice(0, at + 1).reverse().find(turn => turn.scene?.background !== undefined && (turn.scene.location ?? '') === (scene?.location ?? ''))?.scene?.background
  if (existing !== undefined) return { path: existing }
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const world = await project.world()
  const entry = world.find(candidate => sameName(candidate.name, location) || location.includes(candidate.name))
  const art = await artDirectionOf(core, runtime, { pin: true })
  const subject = [
    L(lang, '视觉小说背景图，无人物，横幅', 'visual-novel background, no people, landscape'),
    entry?.visualPrompt ?? location,
    scene?.time,
    scene?.mood,
  ].filter(Boolean).join(lang === 'zh' ? '，' : ', ')
  const info = await renderImage(core, runtime, {
    subject,
    kind: 'background',
    target: session.id,
    // The backdrop of an interlude is a stage like a panel is.
    size: pictureSize((await core.imageOf(runtime)), 'panel'),
    name: `bg-${session.id}`,
    record: false,
    art,
    // A place with reference art keeps its look when the time of day or the mood changes.
    ...(entry?.visualImage !== undefined ? { references: [{ path: entry.visualImage, label: L(lang, `场所「${entry.name}」`, `the place "${entry.name}"`) }] } : {}),
  }, task)
  const fresh = await requireSession(project, session.id)
  await project.savePlaySession({
    ...fresh,
    turns: fresh.turns.map((turn, index) => index === sceneTurn ? { ...turn, scene: { ...turn.scene, background: info.path } } : turn),
  })
  return { path: info.path }
}

/** Make sure a character has a portrait for the stage. @returns the portrait path. */
export async function ensurePortrait(core: NovelCore, runtime: ProjectRuntime, ref: string, task: TaskContext): Promise<{ path: string }> {
  const { project } = runtime
  const card = await project.findCharacter(ref)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${ref}"`)
  if (card.visual?.portrait !== undefined && await project.has(card.visual.portrait)) return { path: card.visual.portrait }
  // The same portrait the gallery draws — anchor, sheet reference, the book's art direction and avoid list — but plain:
  // on the stage it is a figure standing before a backdrop of its own, and a turn of the play does not wait for a scene to be picked.
  const info = await illustrate(core, runtime, { kind: 'portrait', target: card.id, plain: true }, task)
  return { path: info.path }
}

/**
 * Rewrite an interlude as a chapter of prose and add it to the book — after the
 * chapter it branched off (`as: 'chapter'`, the default), or as the first
 * chapter of a line of the plot of its own that leaves there (`as: 'line'`):
 * what was played is then another way the story goes, beside the one written.
 * @param params.choice - `line`: what is decided to go this way; the player's first move when left out.
 */
export async function novelizePlay(core: NovelCore, runtime: ProjectRuntime, params: { session: string; title?: string; after?: string; as?: 'chapter' | 'line'; choice?: string }, task: TaskContext): Promise<{ chapterId: string; title: string; words: number; line?: { id: string; title: string } }> {
  const { project } = runtime
  const session = await requireSession(project, params.session)
  if (session.turns.length === 0) throw new ProjectError('novel/empty', 'the interlude has no turns')
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const characters = await project.characters()
  const route = await core.route('writer', runtime, task)
  const anchor = session.anchorChapter !== undefined ? await project.findChapter(session.anchorChapter) : undefined
  const pack = await core.pack(runtime, route, {
    purpose: 'draft',
    ...(anchor !== undefined ? { canonThrough: anchor.index } : {}),
    ...(anchor?.line !== undefined ? { line: anchor.line } : {}),
    brief: session.situation,
    characters: [...session.cast, ...(session.player !== undefined ? [session.player] : [])],
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const transcript = transcriptOf(session, characters, lang === 'zh', 40_000)
  const base = { lang, language: manifest.language, title: manifest.title }
  const response = await core.llm.complete({
    route,
    system: await (async () => { const style = await project.activeStyle(); return withStyleExtra(novelizeSystem({ ...base, style: renderStyle(style, lang) }), style, lang) })(),
    ...(pack.stable.length > 0 ? { stable: pack.stable } : {}),
    prompt: `${pack.rest}\n\n---\n## ${L(lang, '幕间情境', 'The interlude\'s situation')}\n\n${session.situation}\n\n## ${L(lang, '演出记录', 'The log')}\n\n${transcript}\n\n---\n${L(lang, '把这段演出改写成一章小说正文。', 'Rewrite this scene as one chapter of prose.')}`,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
  })
  const text = cleanProse(response.text)
  if (text.length === 0) throw new ProjectError('novel/empty', L(lang, '写手模型的回复里没有正文（只有标题或空白）。请再试一次。', 'the writer model\'s reply held no prose (only a heading or blank lines) — try again'))
  const after = params.after !== undefined ? await project.findChapter(params.after) : anchor
  const title = params.title?.trim() || session.title
  // Played out as another way the story goes: a line of its own, leaving where the scene branched off.
  const firstMove = session.turns.find(turn => turn.input !== undefined)?.input?.text
  const choice = params.choice?.trim() || (firstMove !== undefined ? clip(firstMove.replace(/\s+/g, ' ').trim(), 80) : undefined)
  const line = params.as === 'line'
    ? await project.addLine({ title, ...(after !== undefined ? { from: after.plan.id } : {}), ...(choice !== undefined && choice.length > 0 ? { choice } : {}), premise: clip(session.situation, 200), origin: 'interlude', play: session.id })
    : undefined
  const plan = await project.addChapter({
    title,
    status: 'drafted',
    synopsis: session.situation,
    characters: [...new Set([...(session.player !== undefined ? [session.player] : []), ...session.cast])],
    ...(session.location !== undefined ? { location: session.location } : {}),
    notes: L(lang, `由幕间「${session.title}」改写`, `Novelized from the interlude "${session.title}"`),
  }, line !== undefined ? { line: line.id } : after !== undefined ? { after: after.plan.id } : {})
  const saved = await project.saveChapterText(plan.id, text, { snapshot: false, status: 'drafted' })
  await project.savePlaySession({ ...(await requireSession(project, session.id)), outcome: 'novelized', novelizedChapter: plan.id, ...(line !== undefined ? { novelizedLine: line.id } : {}) })
  await scheduleDigest(core, runtime, plan.id, task)
  task.job?.result({ chapterId: plan.id })
  return { chapterId: plan.id, title, words: saved.words, ...(line !== undefined ? { line: { id: line.id, title: line.title } } : {}) }
}

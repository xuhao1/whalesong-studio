// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Plot derivation: growing the outline from where the story stands.
 *   foundation  an idea → title, premise, cast, world, volumes and opening chapters,
 *   chapters    the next N chapter outlines, driven by character wants and open threads,
 *   beats       one chapter outline → scene beats a writer can follow,
 *   what-if     alternative directions with their consequences, nothing is changed.
 */
import type { Beat, ChapterPlan, CharacterCard, StyleProfile, WorldCategory, WorldEntry } from '../../shared/types'
import { newId, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText, completeJson } from '../llm'
import type { Project } from '../project'
import { ProjectError } from '../project'
import { architectSystem, deriveBeatsTask, deriveChaptersTask, foundationTask, whatIfTask } from '../prompts'
import { L, promptLanguage } from '../render'

const ROLES: CharacterCard['role'][] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']
const CATEGORIES: WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']
const POVS: NonNullable<StyleProfile['pov']>[] = ['first', 'third-limited', 'third-omniscient', 'second', 'multi']

/** Outline overview appended to plotting context: what is planned, written or still open. */
async function outlineOverview(project: Project, zh: boolean): Promise<string> {
  const outline = await project.outline()
  const infos = await project.chapterInfos()
  const lines: string[] = []
  for (const volume of outline.volumes) {
    lines.push(`### ${volume.title}${volume.synopsis !== undefined ? ` — ${volume.synopsis}` : ''}${volume.goal !== undefined ? `${zh ? '（目标：' : ' (goal: '}${volume.goal}${zh ? '）' : ')'}` : ''}`)
    for (const plan of volume.chapters) {
      const info = infos.find(candidate => candidate.id === plan.id)
      const written = info?.hasText === true
      lines.push(`${info?.index ?? '?'}. ${plan.title} [${written ? (zh ? '已写' : 'written') : (zh ? '未写' : 'not written')}]${!written && plan.synopsis !== undefined ? ` ${plan.synopsis}` : ''}`)
    }
  }
  return `## ${zh ? '现有大纲' : 'Outline so far'}\n\n${lines.join('\n')}`
}

function toBeats(raw: unknown, resolve: (name: string) => string): Beat[] {
  const beats: Beat[] = []
  for (const entry of asArray(raw)) {
    const item = typeof entry === 'string' ? { summary: entry } : asRecord(entry)
    const summary = asText(item.summary)
    if (summary === undefined) continue
    const characters = asList(item.characters).map(resolve)
    const location = asText(item.location)
    const conflict = asText(item.conflict)
    const outcome = asText(item.outcome)
    const emotion = asText(item.emotion)
    beats.push({
      id: newId('b'),
      summary,
      ...(characters.length > 0 ? { characters } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(conflict !== undefined ? { conflict } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
      ...(emotion !== undefined ? { emotion } : {}),
    })
  }
  return beats
}

export interface DerivedChapter {
  title: string
  synopsis?: string
  purpose?: string
  pov?: string
  location?: string
  time?: string
  characters: string[]
  beats: Beat[]
  threads: { title: string; action: string }[]
}

export interface DeriveChaptersParams {
  count?: number
  direction?: string
  /** Volume to extend; defaults to the last one. */
  volume?: string
  /** Add the derived chapters to the outline. Default true. */
  apply?: boolean
}

export interface DeriveChaptersResult {
  rationale?: string
  chapters: DerivedChapter[]
  /** Ids of the chapters added to the outline, when applied. */
  added: { id: string; title: string; index: number }[]
}

/** Models like to number a chapter inside its title ("第3章：…", "Chapter 3 - …"); the outline numbers chapters itself. */
export function plainChapterTitle(raw: string): string {
  const cleaned = raw.trim()
    .replace(/^第\s*[0-9０-９零〇一二三四五六七八九十百千两]+\s*[章回节][\s:：、.．\-—]*/u, '')
    .replace(/^chapter\s+(?:\d+|[ivxlc]+)\b[\s:：.\-—]*/i, '')
    .replace(/^[《「『"“](.+)[》」』"”]$/u, '$1')
    .trim()
  return cleaned.length > 0 ? cleaned : raw.trim()
}

export async function deriveChapters(core: NovelCore, runtime: ProjectRuntime, params: DeriveChaptersParams, task: TaskContext): Promise<DeriveChaptersResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const outline = await project.outline()
  const volume = (params.volume !== undefined ? outline.volumes.find(candidate => candidate.id === params.volume || sameName(candidate.title, params.volume!)) : undefined) ?? outline.volumes.at(-1)!
  const count = Math.max(1, Math.min(12, params.count ?? 5))
  const route = await core.route('architect', runtime, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'derive',
    ...(params.direction !== undefined ? { brief: params.direction } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const characters = await project.characters()
  const resolve = (name: string): string => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)?.id ?? name
  const { value } = await completeJson(core.llm, {
    route,
    system: architectSystem(lang),
    prompt: deriveChaptersTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: `${pack.text}\n\n${await outlineOverview(project, lang === 'zh')}`,
      count,
      volume: volume.title,
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
    validate: (raw) => {
      const record = asRecord(raw)
      if (asArray(record.chapters).length === 0) throw new Error('"chapters" is empty')
      return record
    },
  })
  const chapters: DerivedChapter[] = []
  for (const raw of asArray(value.chapters)) {
    const item = asRecord(raw)
    const rawTitle = asText(item.title)
    if (rawTitle === undefined) continue
    const title = plainChapterTitle(rawTitle)
    const synopsis = asText(item.synopsis)
    const purpose = asText(item.purpose)
    const pov = asText(item.pov)
    const location = asText(item.location)
    const time = asText(item.time)
    chapters.push({
      title,
      ...(synopsis !== undefined ? { synopsis } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(pov !== undefined ? { pov: resolve(pov) } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(time !== undefined ? { time } : {}),
      characters: asList(item.characters).map(resolve),
      beats: toBeats(item.beats, resolve),
      threads: asArray(item.threads).map(asRecord).map(thread => ({ title: asText(thread.title) ?? '', action: asText(thread.action) ?? 'advance' })).filter(thread => thread.title.length > 0),
    })
  }
  const added: DeriveChaptersResult['added'] = []
  if (params.apply !== false) {
    for (const chapter of chapters) {
      const threadIds: string[] = []
      for (const touch of chapter.threads) {
        const current = await project.outline()
        const existing = current.threads.find(thread => sameName(thread.title, touch.title))
        if (existing !== undefined) threadIds.push(existing.id)
        else if (touch.action === 'plant') threadIds.push((await project.saveThread({ title: touch.title, kind: 'foreshadow', status: 'open' })).id)
      }
      const plan = await project.addChapter({
        title: chapter.title,
        status: 'outlined',
        ...(chapter.synopsis !== undefined ? { synopsis: chapter.synopsis } : {}),
        ...(chapter.purpose !== undefined ? { purpose: chapter.purpose } : {}),
        ...(chapter.pov !== undefined ? { pov: chapter.pov } : {}),
        ...(chapter.location !== undefined ? { location: chapter.location } : {}),
        ...(chapter.time !== undefined ? { time: chapter.time } : {}),
        ...(chapter.characters.length > 0 ? { characters: chapter.characters } : {}),
        ...(chapter.beats.length > 0 ? { beats: chapter.beats } : {}),
        ...(threadIds.length > 0 ? { threads: threadIds } : {}),
      }, { volume: volume.id })
      const located = await project.findChapter(plan.id)
      added.push({ id: plan.id, title: plan.title, index: located?.index ?? 0 })
    }
  }
  const rationale = asText(value.rationale)
  task.job?.result({ added: added.map(item => item.id) })
  return { ...(rationale !== undefined ? { rationale } : {}), chapters, added }
}

export interface DeriveBeatsResult {
  chapterId: string
  title: string
  index: number
  synopsis?: string
  beats: Beat[]
  applied: boolean
}

export async function deriveBeats(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; direction?: string; apply?: boolean }, task: TaskContext): Promise<DeriveBeatsResult> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('architect', runtime, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'derive',
    chapter,
    ...(params.direction !== undefined ? { brief: params.direction } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const characters = await project.characters()
  const resolve = (name: string): string => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)?.id ?? name
  const { value } = await completeJson(core.llm, {
    route,
    system: architectSystem(lang),
    prompt: deriveBeatsTask({ lang, language: manifest.language, title: manifest.title, context: pack.text, ...(params.direction !== undefined ? { direction: params.direction } : {}) }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
    validate: (raw) => {
      const record = asRecord(raw)
      if (asArray(record.beats).length === 0) throw new Error('"beats" is empty')
      return record
    },
  })
  const beats = toBeats(value.beats, resolve)
  const synopsis = asText(value.synopsis)
  const cast = asList(value.characters).map(resolve)
  const pov = asText(value.pov)
  const applied = params.apply !== false
  if (applied) {
    await project.updateChapter(chapter.plan.id, {
      beats,
      ...(synopsis !== undefined ? { synopsis } : {}),
      ...(cast.length > 0 ? { characters: cast } : {}),
      ...(pov !== undefined ? { pov: resolve(pov) } : {}),
      ...(chapter.plan.status === 'idea' ? { status: 'outlined' as const } : {}),
    })
  }
  return { chapterId: chapter.plan.id, title: chapter.plan.title, index: chapter.index, ...(synopsis !== undefined ? { synopsis } : {}), beats, applied }
}

export interface WhatIfResult {
  branches: { title: string; development: string; consequences: string[]; risks?: string; payoff?: string }[]
  recommendation?: string
}

export async function whatIf(core: NovelCore, runtime: ProjectRuntime, params: { question: string; branches?: number }, task: TaskContext): Promise<WhatIfResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('architect', runtime, task)
  const pack = await core.pack(runtime, route, { purpose: 'derive', brief: params.question, ...(task.signal !== undefined ? { signal: task.signal } : {}) })
  const { value } = await completeJson(core.llm, {
    route,
    system: architectSystem(lang),
    prompt: whatIfTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: `${pack.text}\n\n${await outlineOverview(project, lang === 'zh')}`,
      question: params.question,
      branches: Math.max(2, Math.min(5, params.branches ?? 3)),
    }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
    validate: (raw) => {
      const record = asRecord(raw)
      if (asArray(record.branches).length === 0) throw new Error('"branches" is empty')
      return record
    },
  })
  const recommendation = asText(value.recommendation)
  return {
    branches: asArray(value.branches).map(asRecord).map((branch) => {
      const risks = asText(branch.risks)
      const payoff = asText(branch.payoff)
      return {
        title: asText(branch.title) ?? L(lang, '走向', 'Direction'),
        development: asText(branch.development) ?? '',
        consequences: asList(branch.consequences),
        ...(risks !== undefined ? { risks } : {}),
        ...(payoff !== undefined ? { payoff } : {}),
      }
    }),
    ...(recommendation !== undefined ? { recommendation } : {}),
  }
}

export interface FoundationResult {
  title: string
  characters: number
  worldEntries: number
  volumes: number
  chapters: number
}

/** Develop an idea into a starting bible and outline, written into an existing (usually fresh) project. */
export async function buildFoundation(core: NovelCore, runtime: ProjectRuntime, params: { idea: string; keepTitle?: boolean }, task: TaskContext): Promise<FoundationResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('architect', runtime, task)
  task.job?.progress(0, 2, L(lang, '构思中', 'developing the idea'))
  const { value } = await completeJson(core.llm, {
    route,
    system: architectSystem(lang),
    prompt: foundationTask({ lang, idea: params.idea, language: manifest.language }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
    validate: raw => asRecord(raw),
  })
  task.job?.progress(1, 2, L(lang, '写入设定与大纲', 'writing bible and outline'))
  const title = asText(value.title)
  const genre = asText(value.genre)
  const logline = asText(value.logline)
  const premise = asText(value.premise)
  const themes = asList(value.themes)
  await project.updateManifest({
    ...(params.keepTitle !== true && title !== undefined ? { title } : {}),
    ...(genre !== undefined ? { genre } : {}),
    ...(logline !== undefined ? { logline } : {}),
    ...(premise !== undefined ? { premise } : {}),
    ...(themes.length > 0 ? { themes } : {}),
  })

  let characterCount = 0
  for (const raw of asArray(value.characters)) {
    const item = asRecord(raw)
    const name = asText(item.name)
    if (name === undefined) continue
    const role = asText(item.role) as CharacterCard['role'] | undefined
    await project.saveCharacter({
      name,
      role: role !== undefined && ROLES.includes(role) ? role : 'supporting',
      status: 'planned',
      ...pickText(item, ['gender', 'age', 'tagline', 'personality', 'motivation', 'flaw', 'arc', 'voice', 'appearance', 'background']),
    } as Partial<CharacterCard> & { name: string })
    characterCount += 1
  }
  let worldCount = 0
  for (const raw of asArray(value.world)) {
    const item = asRecord(raw)
    const name = asText(item.name)
    if (name === undefined) continue
    const category = asText(item.category) as WorldCategory | undefined
    const importance = Number(item.importance)
    await project.saveWorld({
      name,
      category: category !== undefined && CATEGORIES.includes(category) ? category : 'other',
      importance: importance === 1 || importance === 3 ? importance : 2,
      ...pickText(item, ['summary', 'body']),
    } as Partial<WorldEntry> & { name: string })
    worldCount += 1
  }
  const style = asRecord(value.style)
  if (Object.keys(style).length > 0) {
    const pov = asText(style.pov) as StyleProfile['pov']
    const rules = asList(style.rules)
    const avoid = asList(style.avoid)
    const styleName = asText(style.name)
    await project.saveStyle({
      id: 'default',
      ...(styleName !== undefined ? { name: styleName } : {}),
      ...(pov !== undefined && POVS.includes(pov) ? { pov } : {}),
      ...pickText(style, ['tone', 'diction', 'rhythm', 'imagery', 'dialogue', 'pacing']),
      ...(rules.length > 0 ? { rules } : {}),
      ...(avoid.length > 0 ? { avoid } : {}),
    })
  }

  const volumes = asArray(value.volumes).map(asRecord).filter(volume => asText(volume.title) !== undefined)
  const characters = await project.characters()
  const resolve = (name: string): string => characters.find(card => sameName(card.name, name))?.id ?? name
  const opening = asArray(value.opening).map(asRecord).filter(chapter => asText(chapter.title) !== undefined)
  await project.updateOutline((draft) => {
    const hasChapters = draft.volumes.some(volume => volume.chapters.length > 0)
    if (!hasChapters && volumes.length > 0) {
      draft.volumes = volumes.map((volume, index) => {
        const synopsis = asText(volume.synopsis)
        const goal = asText(volume.goal)
        return { id: `v${index + 1}`, title: asText(volume.title)!, ...(synopsis !== undefined ? { synopsis } : {}), ...(goal !== undefined ? { goal } : {}), chapters: [] }
      })
    }
  })
  let chapterCount = 0
  const firstVolume = (await project.outline()).volumes[0]!
  for (const chapter of opening) {
    const cast = asList(chapter.characters).map(resolve)
    await project.addChapter({
      title: plainChapterTitle(asText(chapter.title)!),
      status: 'outlined',
      ...pickText(chapter, ['synopsis', 'purpose']),
      ...(cast.length > 0 ? { characters: cast } : {}),
    } as Partial<ChapterPlan> & { title: string }, { volume: firstVolume.id })
    chapterCount += 1
  }
  task.job?.progress(2, 2)
  return { title: (await project.manifest()).title, characters: characterCount, worldEntries: worldCount, volumes: Math.max(1, volumes.length), chapters: chapterCount }
}

/** Copy the non-empty text fields named in `keys`. */
export function pickText(source: Record<string, unknown>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = asText(source[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

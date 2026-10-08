// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Plot derivation: growing the outline from where the story stands.
 *   foundation  an idea → title, premise, cast, world, volumes and opening chapters,
 *   chapters    the next N chapter outlines, driven by character wants and open threads,
 *   beats       one chapter outline → scene beats a writer can follow,
 *   what-if     alternative directions with their consequences, nothing is changed.
 */
import { MAIN_LINE, type Beat, type ChapterPlan, type CharacterCard, type PlotLine, type StyleProfile, type WorldCategory, type WorldEntry } from '../../shared/types'
import { clip, newId, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import type { Project } from '../project'
import { ProjectError } from '../project'
import { architectSystem, deriveBeatsTask, deriveChaptersTask, foundationTask, whatIfTask } from '../prompts'
import { deriveArtDirection } from './illustrate'
import { L, promptLanguage } from '../render'

const ROLES: CharacterCard['role'][] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']
const CATEGORIES: WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']
const POVS: NonNullable<StyleProfile['pov']>[] = ['first', 'third-limited', 'third-omniscient', 'second', 'multi']

/**
 * Outline overview appended to plotting context: what is planned, written or
 * still open — on the main line, or along another line of the plot — and
 * which other ways the story is known to go.
 */
async function outlineOverview(project: Project, zh: boolean, lineId?: string): Promise<string> {
  const outline = await project.outline()
  const infos = await project.chapterInfos(lineId)
  const lines: string[] = []
  const entry = (plan: ChapterPlan, mark = ''): string => {
    const info = infos.find(candidate => candidate.id === plan.id)
    const written = info?.hasText === true
    return `${info?.index ?? '?'}. ${mark}${plan.title} [${written ? (zh ? '已写' : 'written') : (zh ? '未写' : 'not written')}]${!written && plan.synopsis !== undefined ? ` ${plan.synopsis}` : ''}`
  }
  const line = lineId !== undefined ? (outline.lines ?? []).find(candidate => candidate.id === lineId) : undefined
  if (line === undefined) {
    for (const volume of outline.volumes) {
      lines.push(`### ${volume.title}${volume.synopsis !== undefined ? ` — ${volume.synopsis}` : ''}${volume.goal !== undefined ? `${zh ? '（目标：' : ' (goal: '}${volume.goal}${zh ? '）' : ')'}` : ''}`)
      for (const plan of volume.chapters) lines.push(entry(plan))
    }
  } else {
    // Along the line: what it shares with the lines it grew out of, then its own.
    const path = await project.chapters(line.id)
    lines.push(`### ${zh ? `剧情线「${line.title}」` : `The line "${line.title}"`}${line.premise !== undefined ? ` — ${line.premise}` : ''}`)
    for (const chapter of path) lines.push(entry(chapter.plan, chapter.line === line.id ? (zh ? '〔本线〕' : '[this line] ') : ''))
  }
  const others = (outline.lines ?? []).filter(other => other.id !== lineId)
  if (others.length > 0) {
    const all = await project.chapters()
    const where = (id: string | undefined): string => {
      const chapter = id !== undefined ? all.find(candidate => candidate.plan.id === id) : undefined
      return chapter !== undefined ? (zh ? `第${chapter.index}章之后` : `after chapter ${chapter.index}`) : (zh ? '另一条线上' : 'on another line')
    }
    lines.push('', zh ? '### 故事的其它走法（别的剧情线，仅供知晓）' : '### Other ways the story goes (other lines, for your information)')
    for (const other of others) lines.push(`- ${other.title}${zh ? '：' : ': '}${other.from !== undefined ? where(other.from) : (zh ? '从开头' : 'from the start')}${zh ? '分出' : ''}${other.choice !== undefined ? `${zh ? '，抉择：' : ', the choice: '}${other.choice}` : ''}${other.premise !== undefined ? `${zh ? '；' : '; '}${other.premise}` : ''}${zh ? `（${other.chapters.length} 章）` : ` (${other.chapters.length} chapters)`}`)
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

/** How many chapters the planner is asked for in one go; more than that are derived round by round, each from where the last left off. */
const DERIVE_ROUND = 10
/** The most chapters one derivation is asked for: a figure to stop a slip of the hand, not what the planner can do — it derives in rounds. */
export const DERIVE_MOST = 1000

export interface DeriveChaptersParams {
  /** How many chapters; more than ten are derived in rounds. */
  count?: number
  direction?: string
  /** Main line: the volume to extend; defaults to the last one. */
  volume?: string
  /** Add the derived chapters to the outline. Default true; a preview (false) is one round, and neither a rewrite nor a new line. */
  apply?: boolean
  /** The line of the plot to go on with, when it is not the main one. */
  line?: string
  /** The chapter the new ones follow. Default: the end of the line — or, for a rewrite or a new line, the last chapter that is written. */
  after?: string
  /**
   * What becomes of what the line already has after that chapter.
   * `append` (default): nothing — the new chapters are added.
   * `replace`: the new chapters take its place; what was there is removed when none of it is written, and kept as a line put aside when some of it is.
   * `branch`: it stays, and the new chapters open a line of their own that leaves after that chapter.
   */
  mode?: 'append' | 'replace' | 'branch'
  /** `branch`: what the new line is called, and what is decided to go that way. */
  title?: string
  choice?: string
}

export interface DeriveChaptersResult {
  rationale?: string
  chapters: DerivedChapter[]
  /** Ids of the chapters added to the outline, when applied. */
  added: { id: string; title: string; index: number }[]
  /** The line the chapters went to, when it is not the main one. */
  line?: { id: string; title: string; created: boolean }
  /** What became of the chapters that were there before, when the outline was rewritten. */
  replaced?: { chapters: number; kept?: { id: string; title: string } }
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
  const zh = lang === 'zh'
  const mode = params.mode ?? 'append'
  if (mode !== 'append' && params.apply === false) throw new ProjectError('novel/invalid', 'a rewrite or a new line is made, not previewed — leave `apply` out')
  const wanted = Math.max(1, Math.min(DERIVE_MOST, Math.round(params.count ?? 5)))
  let line = params.line !== undefined && params.line !== MAIN_LINE ? await project.findLine(params.line) : undefined
  if (params.line !== undefined && params.line !== MAIN_LINE && line === undefined) throw new ProjectError('novel/not-found', `no plot line matches "${params.line}"`)
  const named = params.after !== undefined ? await project.findChapter(params.after, line?.id) : undefined
  if (params.after !== undefined && named === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.after}"`)

  // Where the new chapters start from: the chapter named, else — when the story is to go another way — the last one that is written.
  const before = await project.chapterInfos(line?.id)
  const lastWritten = before.filter(info => info.hasText).at(-1)
  const fork = named ?? (mode !== 'append' && lastWritten !== undefined ? await project.findChapter(lastWritten.id) : undefined)
  const synopses = (plans: readonly ChapterPlan[]): string => plans.map(plan => `- ${plan.title}${plan.synopsis !== undefined ? `${zh ? '：' : ': '}${clip(plan.synopsis, 160)}` : ''}`).join('\n')
  const lineName = (target: PlotLine | undefined): string => target !== undefined ? L(lang, `剧情线「${target.title}」`, `the line "${target.title}"`) : L(lang, '主线', 'the main line')

  let created = false
  let replaced: DeriveChaptersResult['replaced']
  let situation: string | undefined
  if (mode === 'branch') {
    // What the story does otherwise from here, so the new line is another way and not the same one again.
    const path = await project.chapters(line?.id)
    const rest = fork !== undefined ? path.slice(path.findIndex(chapter => chapter.plan.id === fork.plan.id) + 1) : path
    const source = line
    line = await project.addLine({
      title: params.title?.trim() || (fork !== undefined ? L(lang, `第${fork.index}章之后的另一条线`, `Another way on from chapter ${fork.index}`) : L(lang, '另一种开头', 'Another beginning')),
      ...(fork !== undefined ? { from: fork.plan.id } : {}),
      ...(params.choice !== undefined ? { choice: params.choice } : {}),
      ...(params.direction !== undefined && params.direction.trim().length > 0 ? { premise: clip(params.direction.trim(), 200) } : {}),
      origin: 'planner',
    })
    created = true
    situation = [
      L(lang, `这是一条新的剧情线「${line.title}」：故事${fork !== undefined ? `在第 ${fork.index} 章《${fork.plan.title}》之后` : '从第一页起'}与${lineName(source)}分开，走另一条路。`, `This is a new line of the plot, "${line.title}": the story parts from ${lineName(source)} ${fork !== undefined ? `after chapter ${fork.index}, "${fork.plan.title}"` : 'from the first page'} and goes another way.`),
      params.choice !== undefined && params.choice.trim().length > 0 ? L(lang, `分开的地方，做出的抉择是：${params.choice.trim()}`, `What is decided where they part: ${params.choice.trim()}`) : undefined,
      rest.length > 0 ? L(lang, `${lineName(source)}原来接下去是这样的——新线必须是不同的走向，不要把它再写一遍：\n${synopses(rest.map(chapter => chapter.plan))}`, `This is how ${lineName(source)} goes on from there — the new line has to go differently, not tell the same again:\n${synopses(rest.map(chapter => chapter.plan))}`) : undefined,
    ].filter((part): part is string => part !== undefined).join('\n')
  } else if (mode === 'replace') {
    const home = fork !== undefined ? fork.line : line?.id
    const own = home !== undefined ? ((await project.findLine(home))?.chapters ?? []) : (await project.chapters()).map(chapter => chapter.plan)
    const tail = fork !== undefined ? own.slice(own.findIndex(plan => plan.id === fork.plan.id) + 1) : own
    const infos = new Map(before.map(info => [info.id, info]))
    const written = tail.filter(plan => infos.get(plan.id)?.hasText === true).length
    const cut = await project.cutTail(fork?.plan.id, {
      ...(home !== undefined ? { line: home } : {}),
      // Chapters that are written are never thrown away by a rewrite of the outline: they become a line put aside.
      ...(written > 0 ? { keep: { title: L(lang, `改写前的后续（${new Date().toLocaleDateString(zh ? 'zh-CN' : 'en-US')}）`, `Before the rewrite (${new Date().toLocaleDateString('en-US')})`), origin: 'replaced' as const, shelved: true } } : {}),
    })
    replaced = { chapters: cut.taken.length, ...(cut.line !== undefined ? { kept: { id: cut.line.id, title: cut.line.title } } : {}) }
    if (home !== undefined) line = await project.findLine(home)
    if (cut.taken.length > 0) {
      situation = L(lang, `作者决定重写${fork !== undefined ? `第 ${fork.index} 章《${fork.plan.title}》之后` : '全部'}的大纲。原来的安排如下——它已经被放弃，新的章纲不要沿用它：\n${synopses(cut.taken)}`, `The author is rewriting the outline ${fork !== undefined ? `after chapter ${fork.index}, "${fork.plan.title}"` : 'from the start'}. This is what was planned — it has been given up, and the new outlines must not follow it:\n${synopses(cut.taken)}`)
    }
  }
  if (line?.into !== undefined) {
    const goal = await project.findChapter(line.into)
    if (goal !== undefined) situation = [situation, L(lang, `这条线最后要汇入《${goal.plan.title}》：推演的章节要朝那里收束，让两条路在那一章之前合到一起。`, `This line arrives at "${goal.plan.title}" in the end: the chapters have to lead there, so that the two ways are one again before that chapter.`)].filter(Boolean).join('\n')
  }

  const outline = await project.outline()
  const volume = (params.volume !== undefined ? outline.volumes.find(candidate => candidate.id === params.volume || sameName(candidate.title, params.volume!)) : undefined) ?? outline.volumes.at(-1)!
  const route = await core.route('architect', runtime, task)
  const characters = await project.characters()
  const resolve = (name: string): string => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)?.id ?? name
  // A chapter named in the middle of a line, with what follows it left standing: the planner writes what comes between.
  const inside = mode === 'append' && named !== undefined && before.at(-1)?.id !== named.plan.id ? named : undefined

  const chapters: DerivedChapter[] = []
  const added: DeriveChaptersResult['added'] = []
  const rationales: string[] = []
  let previous: string | undefined
  const rounds = Math.ceil(wanted / DERIVE_ROUND)
  for (let round = 0; round < rounds; round++) {
    task.signal?.throwIfAborted()
    const count = Math.min(DERIVE_ROUND, wanted - round * DERIVE_ROUND)
    if (rounds > 1) task.job?.progress(round, rounds, L(lang, `推演第 ${round * DERIVE_ROUND + 1}–${round * DERIVE_ROUND + count} 章（共 ${wanted} 章，分 ${rounds} 轮）`, `deriving chapters ${round * DERIVE_ROUND + 1}–${round * DERIVE_ROUND + count} of ${wanted} (${rounds} rounds)`))
    const pack = await core.pack(runtime, route, {
      purpose: 'derive',
      ...(line !== undefined ? { line: line.id } : {}),
      ...(inside !== undefined && previous === undefined ? { canonThrough: inside.index } : {}),
      ...(params.direction !== undefined ? { brief: params.direction } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    })
    const { value } = await assign(core, runtime, task, {
      role: 'architect',
      label: rounds > 1 ? L(lang, `推演后续章节（${round + 1}/${rounds}）`, `Deriving the next chapters (${round + 1}/${rounds})`) : L(lang, '推演后续章节', 'Deriving the next chapters'),
      tool: 'submit_chapters',
      what: L(lang, '推演出的章节：标题、梗概、出场人物、节拍', 'the chapters derived: titles, synopses, who appears, beats'),
      system: architectSystem(lang),
      prompt: deriveChaptersTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        context: `${pack.text}\n\n${await outlineOverview(project, zh, line?.id)}`,
        count,
        volume: line !== undefined ? line.title : volume.title,
        ...(params.direction !== undefined ? { direction: params.direction } : {}),
        ...(situation !== undefined ? { situation } : {}),
        ...(inside !== undefined ? { after: `${inside.index}. ${inside.plan.title}` } : {}),
      }),
      validate: (raw) => {
        const record = asRecord(raw)
        if (asArray(record.chapters).length === 0) throw new Error('"chapters" is empty')
        return record
      },
    })
    const derived: DerivedChapter[] = []
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
      derived.push({
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
    chapters.push(...derived)
    const rationale = asText(value.rationale)
    if (rationale !== undefined) rationales.push(rationale)
    if (params.apply === false) break
    for (const chapter of derived) {
      const threadIds: string[] = []
      for (const touch of chapter.threads) {
        const current = await project.outline()
        const existing = current.threads.find(thread => sameName(thread.title, touch.title))
        if (existing !== undefined) threadIds.push(existing.id)
        else if (touch.action === 'plant') threadIds.push((await project.saveThread({ title: touch.title, kind: 'foreshadow', status: 'open' })).id)
      }
      // After the chapter just added; the first one after where the line was left — on that line, which a new line's first chapter has to be told.
      const where = previous !== undefined ? { after: previous }
        : fork !== undefined && fork.line === line?.id && mode !== 'branch' ? { after: fork.plan.id }
          : line !== undefined ? { line: line.id }
            : { volume: volume.id }
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
      }, where)
      previous = plan.id
      const located = await project.findChapter(plan.id)
      added.push({ id: plan.id, title: plan.title, index: located?.index ?? 0 })
    }
    task.job?.result({ added: added.map(item => item.id) })
  }
  if (rounds > 1) task.job?.progress(rounds, rounds)
  task.job?.result({ added: added.map(item => item.id), ...(line !== undefined ? { line: line.id } : {}) })
  return {
    ...(rationales.length > 0 ? { rationale: rationales.join('\n\n') } : {}),
    chapters,
    added,
    ...(line !== undefined ? { line: { id: line.id, title: line.title, created } } : {}),
    ...(replaced !== undefined ? { replaced } : {}),
  }
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
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, `第${chapter.index}章 · 节拍`, `Ch. ${chapter.index} · beats`),
    tool: 'submit_beats',
    what: L(lang, '这一章的节拍', 'the beats of this chapter'),
    system: architectSystem(lang),
    prompt: deriveBeatsTask({ lang, language: manifest.language, title: manifest.title, context: pack.text, ...(params.direction !== undefined ? { direction: params.direction } : {}) }),
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
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, '假设推演', 'What if'),
    tool: 'submit_branches',
    what: L(lang, '几条可能的走向，各自的代价和收获', 'the branches the story could take, with what each costs and gains'),
    system: architectSystem(lang),
    prompt: whatIfTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: `${pack.text}\n\n${await outlineOverview(project, lang === 'zh')}`,
      question: params.question,
      branches: Math.max(2, Math.min(5, params.branches ?? 3)),
    }),
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
  /** The look settled for the book's pictures; absent when the director could not be asked. */
  art?: string
}

/** Develop an idea into a starting bible and outline, written into an existing (usually fresh) project. */
export async function buildFoundation(core: NovelCore, runtime: ProjectRuntime, params: { idea: string; keepTitle?: boolean }, task: TaskContext): Promise<FoundationResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  task.job?.progress(0, 3, L(lang, '构思中', 'developing the idea'))
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, '搭建新书的地基', 'Laying the foundation of a new book'),
    tool: 'submit_foundation',
    what: L(lang, '这本书的地基：故事核、人物、世界、文风、开篇大纲', 'the foundation of the book: premise, cast, world, style, opening outline'),
    system: architectSystem(lang),
    prompt: foundationTask({ lang, idea: params.idea, language: manifest.language }),
    validate: raw => asRecord(raw),
  })
  task.job?.progress(1, 3, L(lang, '写入设定与大纲', 'writing bible and outline'))
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
  // The look of its pictures, from what was just laid down: a book has one of its own from the start.
  task.job?.progress(2, 3, L(lang, '定画风', 'settling the look of its pictures'))
  let art: string | undefined
  let failedArt: string | undefined
  try {
    art = (await deriveArtDirection(core, runtime, { keep: true }, task))?.style
  } catch (error) {
    if (task.signal?.aborted === true) throw error
    // The book stands without it; its bible offers the director again, and says nothing was settled.
    failedArt = error instanceof Error ? error.message : String(error)
  }
  if (failedArt !== undefined) await project.addActivity({ by: 'crew', role: 'director', tool: 'art', summary: L(lang, `没能定下画风（${clip(failedArt, 80)}）：可以在“设定 → 画风”里再让导演来定`, `The look of the pictures could not be settled (${clip(failedArt, 100)}): the bible's art page offers the director again`) }).catch(() => {})
  task.job?.progress(3, 3)
  return { title: (await project.manifest()).title, characters: characterCount, worldEntries: worldCount, volumes: Math.max(1, volumes.length), chapters: chapterCount, ...(art !== undefined ? { art } : {}) }
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

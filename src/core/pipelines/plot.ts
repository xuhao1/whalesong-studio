// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Plot derivation: growing the outline from where the story stands.
 *   foundation  an idea → title, premise, cast, world, volumes and opening chapters,
 *   chapters    the next N chapter outlines, driven by character wants and open threads,
 *   beats       one chapter outline → scene beats a writer can follow,
 *   plan of the text    a chapter that is written → its plan (or its beats alone) as its text has it,
 *   what-if     alternative directions with their consequences, nothing is changed.
 */
import { MAIN_LINE, type Beat, type ChapterPlan, type CharacterCard, type DerivedChapter, type DerivedPlan, type PictureGuide, type PicturesRead, type PlotLine, type ReferencesLooked, type StyleProfile, type WorldCategory, type WorldEntry } from '../../shared/types'
import { clip, hashText, newId, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import type { Project } from '../project'
import { ProjectError } from '../project'
import { architectSystem, planOfTextTask, deriveBeatsTask, deriveChaptersTask, digestSystem, foundationTask, reviseChaptersFollowUp, whatIfTask } from '../prompts'
import { deriveArtDirection } from './illustrate'
import { guidePictures, picturesRead } from './guides'
import { L, promptLanguage } from '../render'

const ROLES: CharacterCard['role'][] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']
const CATEGORIES: WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']
const POVS: NonNullable<StyleProfile['pov']>[] = ['first', 'third-limited', 'third-omniscient', 'second', 'multi']

/**
 * Outline overview appended to plotting context: what is planned, written or
 * still open on the line the planning is for — the main one, or another line
 * of the plot — numbered along that line. The book's other lines are other
 * stories as far as this planning goes, and are not listed: what the author
 * wants taken from one of them, they say in their direction.
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

export type { DerivedChapter }

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
  /**
   * A plan derived before and looked at by the author, with what they want changed in it: the planner hands it back
   * adjusted — what the author did not speak of stays as it was. Only as a preview (`apply: false`), in one round.
   */
  revise?: { chapters: readonly DerivedChapter[]; rationale?: string; feedback: string }
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
  /** Pictures to steer the chapters by: the planner looks at them (or is told what they show) and works them in. */
  guides?: PictureGuide[]
}

export interface DeriveChaptersResult {
  rationale?: string
  chapters: DerivedChapter[]
  /** Ids of the chapters added to the outline, when applied. */
  added: { id: string; title: string; index: number }[]
  /** Where pictures were given: how many, and who looked at them — the planner's own model, or the one set up to look at pictures. */
  pictures?: PicturesRead
  /** Where the book has references and derivations look in them first: what the planner read there. */
  referenced?: ReferencesLooked
  /** The line the chapters went to, when it is not the main one. */
  line?: { id: string; title: string; created: boolean }
  /** What became of the chapters that were there before, when the outline was rewritten. */
  replaced?: { chapters: number; kept?: { id: string; title: string } }
  /** A plan adjusted (`revise`): the planner that derived it went on from where it was, rather than somebody new being handed it. */
  resumed?: true
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
  const revise = params.revise !== undefined && params.revise.chapters.length > 0 && params.revise.feedback.trim().length > 0 ? params.revise : undefined
  if (revise !== undefined && params.apply !== false) throw new ProjectError('novel/invalid', 'a plan is adjusted while it is looked at, before it is added — `revise` goes with `apply: false`')
  // (A plan adjusted is one round, of as many chapters as it had: how many it then has is the author's word to say.)
  const wanted = revise !== undefined ? Math.min(DERIVE_ROUND, revise.chapters.length) : Math.max(1, Math.min(DERIVE_MOST, Math.round(params.count ?? 5)))
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
  // The pictures the author gave: looked at by the planner's model, or put into words for it.
  const guided = await guidePictures(core, runtime, route, params.guides, 'plot', task)
  const characters = await project.characters()
  const resolve = (name: string): string => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)?.id ?? name
  // A chapter named in the middle of a line, with what follows it left standing: the planner writes what comes between.
  const inside = mode === 'append' && named !== undefined && before.at(-1)?.id !== named.plan.id ? named : undefined

  const chapters: DerivedChapter[] = []
  const added: DeriveChaptersResult['added'] = []
  const rationales: string[] = []
  // What the planner read in the book's references, over every round.
  let referenced: ReferencesLooked | undefined
  let resumed = false
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
    const nameOf = (ref: string): string => characters.find(card => card.id === ref)?.name ?? ref
    const { value, referenced: looked, resumed: wentOn } = await assign(core, runtime, task, {
      role: 'architect',
      // A plan handed in to be looked at may have a word of the author's to follow: the planner that derived it is
      // kept for that, and a word that follows is said to it — in the conversation it derived the plan in.
      ...(params.apply === false ? { keep: derivedKey(project.root) } : {}),
      ...(revise !== undefined ? { resume: { key: derivedKey(project.root), prompt: reviseChaptersFollowUp(lang, { handedIn: handedIn(revise.chapters, revise.rationale, nameOf), feedback: revise.feedback.trim(), tool: 'submit_chapters' }) } } : {}),
      label: rounds > 1 ? L(lang, `推演后续章节（${round + 1}/${rounds}）`, `Deriving the next chapters (${round + 1}/${rounds})`) : L(lang, '推演后续章节', 'Deriving the next chapters'),
      // The planner reads the line it plans for, and no other.
      line: line?.id ?? MAIN_LINE,
      lookUp: 'derive',
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
        ...(revise !== undefined ? { revise: { plan: planLines(revise.chapters, ref => characters.find(card => card.id === ref)?.name ?? ref, zh), feedback: revise.feedback.trim() } } : {}),
        ...(inside !== undefined ? { after: `${inside.index}. ${inside.plan.title}` } : {}),
        ...(guided !== undefined ? { pictures: guided.text } : {}),
      }),
      ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
      validate: (raw) => {
        const record = asRecord(raw)
        if (asArray(record.chapters).length === 0) throw new Error('"chapters" is empty')
        return record
      },
    })
    if (looked !== undefined) referenced = mergeLooked(referenced, looked)
    if (wentOn === true) resumed = true
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
        // The pictures this chapter goes by, as the planner numbered them.
        ...(() => {
          const mine = guided !== undefined ? [...new Set(asArray(item.pictures).map(Number).filter(at => Number.isInteger(at) && at >= 1 && at <= guided.guides.length))].map(at => guided.guides[at - 1]!) : []
          return mine.length > 0 ? { guides: mine } : {}
        })(),
      })
    }
    // One chapter asked for, and the planner did not say which pictures it goes by: all of them — there is no other chapter they could be for.
    if (guided !== undefined && wanted === 1 && derived.length === 1 && derived[0]!.guides === undefined) derived[0] = { ...derived[0]!, guides: guided.guides }
    chapters.push(...derived)
    const rationale = asText(value.rationale)
    if (rationale !== undefined) rationales.push(rationale)
    if (params.apply === false) break
    for (const chapter of derived) {
      // After the chapter just added; the first one after where the line was left — on that line, which a new line's first chapter has to be told.
      const where = previous !== undefined ? { after: previous }
        : fork !== undefined && fork.line === line?.id && mode !== 'branch' ? { after: fork.plan.id }
          : line !== undefined ? { line: line.id }
            : { volume: volume.id }
      const plan = await addDerivedChapter(project, chapter, where)
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
    ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}),
    ...(referenced !== undefined ? { referenced } : {}),
    ...(resumed ? { resumed: true as const } : {}),
  }
}

/** The key the planner of a book's plan-to-be-looked-at is kept under. */
const derivedKey = (root: string): string => `derive:${root}`

/** A derived plan as its planner handed it in: the JSON it is shown again when the author has a word to say of it. */
function handedIn(chapters: readonly DerivedChapter[], rationale: string | undefined, nameOf: (ref: string) => string): string {
  return JSON.stringify({
    chapters: chapters.map(chapter => ({
      title: chapter.title,
      ...(chapter.synopsis !== undefined ? { synopsis: chapter.synopsis } : {}),
      ...(chapter.purpose !== undefined ? { purpose: chapter.purpose } : {}),
      ...(chapter.pov !== undefined ? { pov: nameOf(chapter.pov) } : {}),
      ...(chapter.location !== undefined ? { location: chapter.location } : {}),
      ...(chapter.time !== undefined ? { time: chapter.time } : {}),
      characters: chapter.characters.map(nameOf),
      beats: chapter.beats.map(beat => ({ summary: beat.summary, ...(beat.conflict !== undefined ? { conflict: beat.conflict } : {}), ...(beat.outcome !== undefined ? { outcome: beat.outcome } : {}) })),
      threads: chapter.threads,
    })),
    ...(rationale !== undefined ? { rationale } : {}),
  }, null, 1)
}

/** One derived chapter put into the outline: the threads it plants are opened, the ones it touches are tied to it. */
async function addDerivedChapter(project: Project, chapter: DerivedChapter, where: NonNullable<Parameters<Project['addChapter']>[1]>): Promise<ChapterPlan> {
  const threadIds: string[] = []
  for (const touch of chapter.threads) {
    const current = await project.outline()
    const existing = current.threads.find(thread => sameName(thread.title, touch.title))
    if (existing !== undefined) threadIds.push(existing.id)
    else if (touch.action === 'plant') threadIds.push((await project.saveThread({ title: touch.title, kind: 'foreshadow', status: 'open' })).id)
  }
  return await project.addChapter({
    title: chapter.title,
    status: 'outlined',
    ...(chapter.synopsis !== undefined ? { synopsis: chapter.synopsis } : {}),
    ...(chapter.purpose !== undefined ? { purpose: chapter.purpose } : {}),
    ...(chapter.pov !== undefined ? { pov: chapter.pov } : {}),
    ...(chapter.location !== undefined ? { location: chapter.location } : {}),
    ...(chapter.time !== undefined ? { time: chapter.time } : {}),
    ...(chapter.guides !== undefined ? { guides: chapter.guides } : {}),
    ...(chapter.characters.length > 0 ? { characters: chapter.characters } : {}),
    ...(chapter.beats.length > 0 ? { beats: chapter.beats } : {}),
    ...(threadIds.length > 0 ? { threads: threadIds } : {}),
  }, where)
}

/** The plan derived for a book and not yet taken or discarded, where there is one. */
export async function derivedPlan(runtime: ProjectRuntime): Promise<DerivedPlan | undefined> {
  const plan = await runtime.project.readState<DerivedPlan>('derived.json')
  return plan !== undefined && Array.isArray(plan.chapters) && plan.chapters.length > 0 ? plan : undefined
}

/** Keep a plan that came back to be looked at: it takes the place of the one kept before. */
export async function keepDerivedPlan(runtime: ProjectRuntime, plan: DerivedPlan): Promise<void> {
  await runtime.project.writeState(['derived.json'], plan)
}

/** The plan kept was added to the outline, or discarded: nothing waits any more, and its planner is let go. */
export async function settleDerivedPlan(core: NovelCore, runtime: ProjectRuntime): Promise<boolean> {
  core.roles?.release?.(derivedKey(runtime.project.root))
  if (await derivedPlan(runtime) === undefined) return false
  await runtime.project.removeState('derived.json')
  return true
}

/** What comes of chapters derived to be looked at: the derivation, and the plan as it now waits with the book. */
export interface DeriveLookResult extends DeriveChaptersResult {
  waiting?: DerivedPlan
}

/**
 * Derive chapters to be looked at before they are added, and keep the plan with the book — or, where the author has
 * a word to say of the plan that waits (`feedback`), have that plan adjusted: by the planner that derived it, in its
 * own conversation while it is still there, else by one handed the plan and the word. What comes back waits in its
 * place; nothing enters the outline here. One way for the Studio's page and for the showrunner.
 * @param params.job - the job this is done in, for whoever comes back to the plan.
 */
export async function deriveToLook(core: NovelCore, runtime: ProjectRuntime, params: Omit<DeriveChaptersParams, 'apply' | 'revise'> & { feedback?: string; job?: string }, task: TaskContext): Promise<DeriveLookResult> {
  const { feedback, job, ...rest } = params
  const said = feedback?.trim() ?? ''
  const waiting = said.length > 0 ? await derivedPlan(runtime) : undefined
  if (said.length > 0 && waiting === undefined) throw new ProjectError('novel/not-found', 'no derived plan is waiting to be adjusted — derive one first')
  // A plan adjusted stays the plan it was: for the same volume and line, after the same chapter, by the same direction.
  const volume = waiting !== undefined ? waiting.volume : rest.volume
  const direction = waiting !== undefined ? waiting.direction : rest.direction
  const line = waiting !== undefined ? waiting.line : rest.line
  const after = waiting !== undefined ? waiting.after : rest.after
  const result = await deriveChapters(core, runtime, {
    ...rest,
    apply: false,
    volume,
    direction,
    line,
    after,
    ...(waiting !== undefined ? { revise: { chapters: waiting.chapters, ...(waiting.rationale !== undefined ? { rationale: waiting.rationale } : {}), feedback: said } } : {}),
  }, task)
  if (result.chapters.length === 0) return result
  // (The chapter they follow is kept by its id: whoever adds the plan later names no chapter anew.)
  const follows = after !== undefined && after.trim().length > 0 ? await runtime.project.findChapter(after.trim(), result.line?.id) : undefined
  const plan: DerivedPlan = {
    at: new Date().toISOString(),
    ...(job !== undefined ? { job } : {}),
    chapters: result.chapters,
    ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
    ...(volume !== undefined && volume.length > 0 ? { volume } : {}),
    ...(result.line !== undefined ? { line: result.line.id } : {}),
    ...(follows !== undefined ? { after: follows.plan.id } : {}),
    ...(direction !== undefined && direction.trim().length > 0 ? { direction: direction.trim() } : {}),
    ...(waiting !== undefined ? { feedback: [...(waiting.feedback ?? []), said] } : {}),
    ...(result.pictures !== undefined ? { pictures: result.pictures } : waiting?.pictures !== undefined ? { pictures: waiting.pictures } : {}),
    ...(result.referenced !== undefined ? { referenced: result.referenced } : waiting?.referenced !== undefined ? { referenced: waiting.referenced } : {}),
  }
  await keepDerivedPlan(runtime, plan)
  return { ...result, waiting: plan }
}

/**
 * Add the plan that waits to the outline as it stands — on the line and after the chapter it was derived for, else
 * at the end of its volume — and let its planner go.
 * @returns the chapters added; nothing where no plan waits.
 */
export async function enterDerivedPlan(core: NovelCore, runtime: ProjectRuntime): Promise<{ added: { id: string; title: string; index: number }[]; line?: { id: string; title: string } } | undefined> {
  const { project } = runtime
  const plan = await derivedPlan(runtime)
  if (plan === undefined) return undefined
  const outline = await project.outline()
  const line = plan.line !== undefined ? await project.findLine(plan.line) : undefined
  const follows = plan.after !== undefined ? await project.findChapter(plan.after, line?.id) : undefined
  const volume = (plan.volume !== undefined ? outline.volumes.find(candidate => candidate.id === plan.volume || sameName(candidate.title, plan.volume!)) : undefined) ?? outline.volumes.at(-1)
  const added: { id: string; title: string; index: number }[] = []
  let previous = follows?.plan.id
  for (const chapter of plan.chapters) {
    const where = previous !== undefined ? { after: previous } : line !== undefined ? { line: line.id } : volume !== undefined ? { volume: volume.id } : {}
    const made = await addDerivedChapter(project, chapter, where)
    previous = made.id
    added.push({ id: made.id, title: made.title, index: (await project.findChapter(made.id))?.index ?? 0 })
  }
  await settleDerivedPlan(core, runtime)
  return { added, ...(line !== undefined ? { line: { id: line.id, title: line.title } } : {}) }
}

/** A derived plan as the planner is shown it again: every chapter with all that was said of it. */
function planLines(chapters: readonly DerivedChapter[], nameOf: (ref: string) => string, zh: boolean): string {
  const comma = zh ? '、' : ', '
  return chapters.map((chapter, at) => [
    `### ${at + 1}. ${chapter.title}`,
    ...(chapter.synopsis !== undefined ? [chapter.synopsis] : []),
    ...(chapter.purpose !== undefined ? [`${zh ? '作用：' : 'Purpose: '}${chapter.purpose}`] : []),
    ...([chapter.pov !== undefined ? `${zh ? '视角 ' : 'POV '}${nameOf(chapter.pov)}` : undefined, chapter.location, chapter.time].some(Boolean) ? [[chapter.pov !== undefined ? `${zh ? '视角 ' : 'POV '}${nameOf(chapter.pov)}` : undefined, chapter.location, chapter.time].filter(Boolean).join(' · ')] : []),
    ...(chapter.characters.length > 0 ? [`${zh ? '出场：' : 'Cast: '}${chapter.characters.map(nameOf).join(comma)}`] : []),
    ...(chapter.beats.length > 0 ? [`${zh ? '节拍：' : 'Beats:'}\n${chapter.beats.map((beat, index) => `${index + 1}. ${beat.summary}${beat.conflict !== undefined ? `${zh ? '｜阻碍：' : ' | conflict: '}${beat.conflict}` : ''}${beat.outcome !== undefined ? `${zh ? '｜结果：' : ' | outcome: '}${beat.outcome}` : ''}`).join('\n')}`] : []),
    ...(chapter.threads.length > 0 ? [`${zh ? '线索：' : 'Threads: '}${chapter.threads.map(touch => `${touch.action} ${touch.title}`).join(zh ? '；' : '; ')}`] : []),
  ].join('\n')).join('\n\n')
}

/** What was read in the references over several runs of one piece of work, as one account. */
function mergeLooked(before: ReferencesLooked | undefined, next: ReferencesLooked): ReferencesLooked {
  if (before === undefined) return next
  const cannot = next.cannot ?? before.cannot
  return { calls: before.calls + next.calls, read: [...new Set([...before.read, ...next.read])].slice(0, 16), ...(cannot !== undefined && before.calls + next.calls === 0 ? { cannot } : {}) }
}

export interface DeriveBeatsResult {
  chapterId: string
  title: string
  index: number
  synopsis?: string
  beats: Beat[]
  applied: boolean
  /** Where the book has references and derivations look in them first: what the planner read there. */
  referenced?: ReferencesLooked
}

export async function deriveBeats(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; direction?: string; apply?: boolean }, task: TaskContext): Promise<DeriveBeatsResult> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('architect', runtime, task)
  // The pictures the author gave this chapter go with the planning of its beats, as they will with its writing.
  const guided = await guidePictures(core, runtime, route, chapter.plan.guides, 'chapter', task)
  const pack = await core.pack(runtime, route, {
    purpose: 'derive',
    chapter,
    ...(params.direction !== undefined ? { brief: params.direction } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const characters = await project.characters()
  const resolve = (name: string): string => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)?.id ?? name
  const { value, referenced } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, `第${chapter.index}章 · 节拍`, `Ch. ${chapter.index} · beats`),
    line: chapter.line ?? MAIN_LINE,
    lookUp: 'derive',
    tool: 'submit_beats',
    what: L(lang, '这一章的节拍', 'the beats of this chapter'),
    system: architectSystem(lang),
    prompt: deriveBeatsTask({ lang, language: manifest.language, title: manifest.title, context: pack.text, ...(params.direction !== undefined ? { direction: params.direction } : {}), ...(guided !== undefined ? { pictures: guided.text } : {}) }),
    ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
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
  return { chapterId: chapter.plan.id, title: chapter.plan.title, index: chapter.index, ...(synopsis !== undefined ? { synopsis } : {}), beats, applied, ...(referenced !== undefined ? { referenced } : {}) }
}

/** The items of a chapter's plan that its text can set right, beside its beats. */
export type PlanItem = 'synopsis' | 'purpose' | 'location' | 'time' | 'pov' | 'characters'

export interface PlanOfTextResult {
  chapterId: string
  title: string
  index: number
  /** What was read off the text: the beats alone, or the plan — synopsis, what the chapter is for, where, when, whose eyes, who is in it — with them. */
  what: 'beats' | 'plan'
  beats: Beat[]
  /** How many beats the plan had before. */
  was: number
  /** Of the beats now, how many stand as they stood. */
  kept: number
  /** `plan`: the other items the text changed. */
  changed?: PlanItem[]
  synopsis?: string
  applied: boolean
}

/** Where the Studio keeps which text each chapter's plan was last read from (`.novel/plans-read.json`). */
const PLANS_READ = ['plans-read.json']

/**
 * The text a chapter's plan was last read from, as a hash of it — so that a plan is not read from the same text
 * twice, and a plan the author went on to change by hand is not read over because its chapter was digested again.
 * @returns nothing where the plan was never read from its text.
 */
export async function planReadFrom(project: Project, chapterId: string): Promise<string | undefined> {
  return ((await project.readState<Record<string, string>>(...PLANS_READ)) ?? {})[chapterId]
}

/**
 * A chapter's plan set right by its text. What was planned before the chapter was written — or before the author,
 * or a revision, changed it — is read against what the chapter now says, by the continuity editor, in one request
 * (the text and the plan are all there is to it): whoever goes by the plan afterwards — a writer rewriting the
 * chapter, the director cutting it into panels, the planner deriving what follows — then goes by what was written.
 * `beats` changes the beats alone; `plan` the synopsis, what the chapter is for, the place, the time, the point of
 * view and the cast with them. The plan is read off the text anew: asked to keep the beats that "still fit", a model
 * hands the old ones back and a scene the text has beyond them goes without a beat — so the beats there were are not
 * shown to it at all. A beat that comes back in the same words is the same beat and keeps its id; what the text
 * does not say of the place or the time stays as planned; the notes for the writer and the threads are nobody's to
 * change here. The plan as it was stays in its history.
 */
export async function planOfText(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; what?: 'beats' | 'plan'; apply?: boolean }, task: TaskContext): Promise<PlanOfTextResult> {
  const { project } = runtime
  const what = params.what ?? 'plan'
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const text = await project.chapterText(chapter.plan.id)
  if (text.trim().length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has no text to read its plan from — until it is written, its beats are derived from its plan (novel_derive kind=beats)`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const characters = await project.characters()
  const { resolve: who } = await project.castResolver()
  const mine = characters.filter(card => [card.name, ...(card.aliases ?? [])].some(name => who(name, chapter.plan.id).id === card.id))
  const resolve = (name: string): string => who(name, chapter.plan.id).id ?? name
  const nameOf = (ref: string): string => characters.find(card => card.id === ref)?.name ?? ref
  const plan = chapter.plan
  const before = plan.beats ?? []
  const label = zh ? `第 ${chapter.index} 章《${plan.title}》` : `Chapter ${chapter.index}, "${plan.title}"`
  // What a chapter is for is said against the ones beside it: a line of each, along the chapter's own line of the plot.
  let around: string | undefined
  if (what === 'plan') {
    const path = await project.chapters(chapter.line)
    const at = path.findIndex(candidate => candidate.plan.id === plan.id)
    const beside = (other: (typeof path)[number] | undefined, zhWord: string, enWord: string): string | undefined => other !== undefined && (other.plan.synopsis ?? '').trim().length > 0
      ? `${zh ? `${zhWord}（第 ${other.index} 章《${other.plan.title}》）：` : `${enWord} (chapter ${other.index}, "${other.plan.title}"): `}${clip(other.plan.synopsis!.replace(/\s+/g, ' '), 260)}`
      : undefined
    const lines = at < 0 ? [] : [beside(path[at - 1], '上一章', 'The one before'), beside(path[at + 1], '下一章', 'The one after')].filter((line): line is string => line !== undefined)
    if (lines.length > 0) around = lines.join('\n')
  }
  const { value } = await assign(core, runtime, task, {
    role: 'analyst',
    label: what === 'plan' ? L(lang, `第${chapter.index}章 · 照正文更新章纲`, `Ch. ${chapter.index} · the plan by the text`) : L(lang, `第${chapter.index}章 · 照正文更新节拍`, `Ch. ${chapter.index} · beats of the text`),
    line: chapter.line ?? MAIN_LINE,
    tool: what === 'plan' ? 'submit_plan' : 'submit_beats',
    // The text and the plan are all there is to it: one request, whatever the role is set to.
    plain: true,
    what: what === 'plan' ? L(lang, '这一章照正文写的章纲', 'this chapter\'s plan as its text has it') : L(lang, '这一章正文里的节拍', 'the beats this chapter\'s text has'),
    system: digestSystem(lang),
    prompt: planOfTextTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      what,
      chapterLabel: label,
      text,
      ...(plan.synopsis !== undefined ? { synopsis: plan.synopsis } : {}),
      ...(plan.purpose !== undefined ? { purpose: plan.purpose } : {}),
      ...(plan.location !== undefined ? { location: plan.location } : {}),
      ...(plan.time !== undefined ? { time: plan.time } : {}),
      ...(plan.pov !== undefined ? { pov: nameOf(plan.pov) } : {}),
      ...((plan.characters ?? []).length > 0 ? { cast: plan.characters!.map(nameOf).join(zh ? '、' : ', ') } : {}),
      ...(around !== undefined ? { around } : {}),
      knownCharacters: mine.map(card => `${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? ` | ${card.aliases.join('/')}` : ''}`).join('\n'),
    }),
    temperature: 0.1,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asArray(record.beats).length === 0) throw new Error('"beats" is empty')
      if (what === 'plan' && asText(record.synopsis) === undefined) throw new Error('"synopsis" is missing')
      return record
    },
  })
  // A beat handed back as it stood is the same beat: it keeps its id.
  const left = [...before]
  let kept = 0
  const beats = toBeats(value.beats, resolve).map((beat) => {
    const at = left.findIndex(old => old.summary.trim() === beat.summary.trim())
    if (at < 0) return beat
    const [old] = left.splice(at, 1)
    kept += 1
    return { ...beat, id: old!.id }
  })
  const patch: Partial<ChapterPlan> = { beats }
  const changed: PlanItem[] = []
  if (what === 'plan') {
    const synopsis = asText(value.synopsis)
    if (synopsis !== undefined && synopsis !== plan.synopsis) { patch.synopsis = synopsis; changed.push('synopsis') }
    // What the chapter does for the book, by what it turned out to do. (A reading that says nothing of it leaves it.)
    const purpose = asText(value.purpose)
    if (purpose !== undefined && purpose !== plan.purpose) { patch.purpose = purpose; changed.push('purpose') }
    // What the text does not say stays as planned.
    const location = asText(value.location)
    if (location !== undefined && location !== plan.location) { patch.location = location; changed.push('location') }
    const time = asText(value.time)
    if (time !== undefined && time !== plan.time) { patch.time = time; changed.push('time') }
    // The point of view is somebody on file, or it is left alone.
    const pov = asText(value.pov)
    const seen = pov !== undefined ? who(pov, plan.id).id : undefined
    if (seen !== undefined && seen !== plan.pov) { patch.pov = seen; changed.push('pov') }
    const cast = [...new Set(asList(value.characters).map(resolve))]
    const had = plan.characters ?? []
    if (cast.length > 0 && (cast.length !== had.length || cast.some(ref => !had.includes(ref)))) { patch.characters = cast; changed.push('characters') }
  }
  const applied = params.apply !== false
  if (applied) {
    await project.updateChapter(plan.id, patch)
    // The whole plan now stands by this text: noted, for whoever would have it read again.
    if (what === 'plan') await project.updateState<Record<string, string>>(PLANS_READ, {}, read => ({ ...read, [plan.id]: hashText(text) })).catch(() => {})
  }
  return {
    chapterId: plan.id,
    title: plan.title,
    index: chapter.index,
    what,
    beats,
    was: before.length,
    kept,
    ...(what === 'plan' ? { changed, synopsis: patch.synopsis ?? plan.synopsis ?? '' } : {}),
    applied,
  }
}

export interface WhatIfResult {
  branches: { title: string; development: string; consequences: string[]; risks?: string; payoff?: string }[]
  recommendation?: string
  /** Where pictures were given: how many, and who looked at them. */
  pictures?: PicturesRead
  /** Where the book has references and derivations look in them first: what the planner read there. */
  referenced?: ReferencesLooked
}

export async function whatIf(core: NovelCore, runtime: ProjectRuntime, params: { question: string; branches?: number; /** Pictures the ways on are weighed with. */ guides?: PictureGuide[] }, task: TaskContext): Promise<WhatIfResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('architect', runtime, task)
  const guided = await guidePictures(core, runtime, route, params.guides, 'whatif', task)
  const pack = await core.pack(runtime, route, { purpose: 'derive', brief: params.question, ...(task.signal !== undefined ? { signal: task.signal } : {}) })
  const { value, referenced } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, '假设推演', 'What if'),
    ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
    line: MAIN_LINE,
    lookUp: 'derive',
    tool: 'submit_branches',
    what: L(lang, '几条可能的走向，各自的代价和收获', 'the branches the story could take, with what each costs and gains'),
    system: architectSystem(lang),
    prompt: whatIfTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: `${pack.text}\n\n${await outlineOverview(project, lang === 'zh')}${guided !== undefined ? `\n\n${guided.text}` : ''}`,
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
    ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}),
    ...(referenced !== undefined ? { referenced } : {}),
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
    // All of it is in the task: asked in one request, whatever the role is set to.
    plain: true,
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
      ...pickText(style, ['register', 'tone', 'diction', 'rhythm', 'imagery', 'dialogue', 'pacing']),
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

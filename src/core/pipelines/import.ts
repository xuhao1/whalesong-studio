// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Import: an existing manuscript becomes a full project.
 *
 *   split     an editor agent finds the chapters and volumes (see structure.ts); rules stand in where no agent can run
 *
 * and then the analysis, which is a pipeline of its own (`analyzeBook`) because
 * a long book takes it hours and anything can cut it short — it is taken up
 * again where it stopped, and any of its passes can be run again on a book
 * that was imported long ago:
 *
 *   digest    every chapter gets its summary, facts and character moments
 *   cast      the people the chapters name get their cards (see cast.ts)
 *   world     places, groups, objects and terms become world entries
 *   outline   chapters get synopses, the book gets volumes, a logline and a premise
 *   style     a style profile is learned from the text itself
 */
import { mapLimit } from '../util/async'
import { deriveGrowth } from './growth'
import type { StyleProfile, WorldCategory, WorldEntry } from '../../shared/types'
import { ANALYZE_STEPS, analysisSteps, type AnalyzeStep } from '../../shared/types'
import { clip, countWords, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import { ProjectError } from '../project'
import { architectSystem, volumesTask, worldMergeTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { deriveTies, extractStyle } from './bible'
import { mergeCast } from './cast'
import { digestPending, updateArcs } from './digest'
import { pickText } from './plot'
import { findStructure } from './structure'
import { deriveArtDirection } from './illustrate'

export { decodeText, readBookFile } from '../util/bookfile'

export { splitChapters, type SplitChapter } from './structure'

export interface ImportParams {
  text: string
  /** Run the analysis passes after splitting. Default true. */
  analyze?: boolean
  /** Learn a style profile from the text. Default true. */
  style?: boolean
}

export interface ImportResult {
  chapters: number
  words: number
  volumes: number
  characters: number
  worldEntries: number
  digested: number
  failed: { step: string; error: string }[]
  style?: string
  /** Ties written down between the people, places, houses and things of the book, and things noted that happen to them. */
  ties?: { added: number; total: number; events: number }
  /** How many people were read for how they change along the book, and how many stretches were found. */
  growth?: { people: number; stages: number }
  /** How the chapters were found: by the editor agent or by rule, and what there is to say about it. */
  structure: { by: 'agent' | 'rules'; bySize: boolean; note?: string; steps?: number }
}

const CATEGORIES: WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']

export async function importManuscript(core: NovelCore, runtime: ProjectRuntime, params: ImportParams, task: TaskContext): Promise<ImportResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const failed: ImportResult['failed'] = []
  // Finding the chapters, writing them down, and every pass of the analysis.
  const steps = params.analyze === false ? 2 : 2 + ANALYZE_STEPS.length
  let step = 0
  const advance = (label: string): void => { task.job?.progress(step++, steps, label) }

  // ── 1. find the chapters ──
  advance(L(lang, '编辑正在查看书稿、找出章节', 'an editor is reading the manuscript for its chapters'))
  const structure = await findStructure(core, runtime, params.text, task)
  const split = structure.chapters
  if (split.length === 0) throw new ProjectError('novel/empty', L(lang, '这份文本里没有可导入的内容。', 'the text holds nothing to import'))
  if (structure.note !== undefined) task.job?.write(`${structure.note}\n`)
  // A book that names itself knows better than the name its file was saved under.
  if (structure.author !== undefined && manifest.author === undefined) await project.updateManifest({ author: structure.author })

  // ── 2. make volumes and chapters of them ──
  advance(L(lang, `拆分为 ${split.length} 章`, `splitting into ${split.length} chapters`))
  const existing = await project.outline()
  const explicitVolumes = split.some(chapter => chapter.volume !== undefined)
  const hadChapters = existing.volumes.some(volume => volume.chapters.length > 0)
  let volumeId = existing.volumes.at(-1)!.id
  // On an empty outline the text's own volumes replace the placeholder volume instead of following it.
  let replacePlaceholder = !hadChapters && explicitVolumes
  let volumeCount = 0
  const openVolume = async (title: string): Promise<void> => {
    await project.updateOutline((draft) => {
      if (replacePlaceholder) draft.volumes = []
      volumeId = `v${draft.volumes.length + 1}`
      draft.volumes.push({ id: volumeId, title, chapters: [] })
    })
    replacePlaceholder = false
    volumeCount += 1
  }
  const created: string[] = []
  for (const chapter of split) {
    if (chapter.volume !== undefined && explicitVolumes) await openVolume(chapter.volume)
    // Chapters that precede the first volume heading (a prologue) get a volume of their own.
    else if (replacePlaceholder) await openVolume(zh ? '卷首' : 'Opening')
    const plan = await project.addChapter({ title: chapter.title, status: 'drafted' }, { volume: volumeId })
    await project.saveChapterText(plan.id, chapter.text, { snapshot: false, status: 'drafted' })
    created.push(plan.id)
    task.signal?.throwIfAborted()
  }
  const words = split.reduce((sum, chapter) => sum + countWords(chapter.text), 0)
  // How the book was cut is something its author will want to read again, long after the import's progress has scrolled away.
  await project.addActivity({
    by: 'crew',
    role: 'analyst',
    tool: 'import',
    summary: clip(`${L(lang, `导入了 ${created.length} 章${structure.by === 'agent' ? '' : '（按规则切分）'}。`, `Imported ${created.length} chapters${structure.by === 'agent' ? '' : ' (cut by rule)'}. `)}${structure.note ?? ''}`.replace(/\s+/g, ' '), 600),
  }).catch((error: unknown) => { core.log('could not put the import on the book\'s record', error) })
  const result: ImportResult = {
    chapters: created.length,
    words,
    volumes: Math.max(1, volumeCount),
    characters: 0,
    worldEntries: 0,
    digested: 0,
    failed,
    structure: { by: structure.by, bySize: structure.bySize, ...(structure.note !== undefined ? { note: structure.note } : {}), ...(structure.steps !== undefined ? { steps: structure.steps } : {}) },
  }
  if (params.analyze === false) {
    task.job?.progress(steps, steps)
    return result
  }

  // The text's own volumes stand; a book that named none, imported into an empty outline, may be divided by the planner.
  const analysis = await analyzeBook(core, runtime, { ...(params.style !== undefined ? { style: params.style } : {}), divide: !explicitVolumes && !hadChapters, fresh: true }, task, { from: 2, total: steps })
  result.digested = analysis.digested
  result.characters = analysis.characters
  result.worldEntries = analysis.worldEntries
  if (analysis.volumes !== undefined) result.volumes = analysis.volumes
  if (analysis.style !== undefined) result.style = analysis.style
  if (analysis.ties !== undefined) result.ties = analysis.ties
  if (analysis.growth !== undefined) result.growth = analysis.growth
  failed.push(...analysis.failed)
  task.job?.progress(steps, steps)
  task.job?.result({ chapters: result.chapters })
  return result
}

// ───────────────────────────── the analysis ─────────────────────────────

/** What is kept of an analysis that was started, so that one cut short is taken up where it stopped. */
interface AnalysisNote {
  /** 2: the analysis includes settling the look of the book's pictures (`art`). 3: and working out how the things of its world stand to each other (`ties`). 4: and reading how its people change along it (`growth`). */
  schema: 1 | 2 | 3 | 4
  startedAt: string
  /** The book came with no volumes of its own into an empty outline: the planner may divide it. */
  divide?: boolean
  done: AnalyzeStep[]
}

const NOTE = 'analysis.json'

export interface AnalyzeParams {
  /** The passes to run. Default: the ones an analysis that was started has not finished; all of them where none was. */
  steps?: AnalyzeStep[]
  /** Learn a style profile from the text. Default true. */
  style?: boolean
  /** Let the planner divide the book into volumes. Default: as the import that started the analysis found it. */
  divide?: boolean
  /** A new analysis, whatever an earlier one left. */
  fresh?: boolean
}

export interface AnalyzeResult {
  /** The passes that were run. */
  steps: AnalyzeStep[]
  digested: number
  /** Cards made or filled in. */
  characters: number
  /** Names that became aliases. */
  merged: number
  /** People seen in the text who were left as walk-ons. */
  walkOns: number
  worldEntries: number
  volumes?: number
  style?: string
  /** Ties written down between the people, places, houses and things of the book, and things noted that happen to them. */
  ties?: { added: number; total: number; events: number }
  /** How many people were read for how they change along the book, and how many stretches were found. */
  growth?: { people: number; stages: number }
  /** The look settled for the book's pictures. */
  art?: string
  failed: { step: string; error: string }[]
}

/**
 * Read the book and write down what it says: the passes above, in order.
 * Every pass works on all of the book and adds to what is there, so running
 * one again — after more chapters were digested, after an import was cut
 * short — brings the bible up to the text without undoing anybody's work.
 * @param span - where these passes sit in a larger job's progress.
 */
export async function analyzeBook(core: NovelCore, runtime: ProjectRuntime, params: AnalyzeParams, task: TaskContext, span?: { from: number; total: number }): Promise<AnalyzeResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const failed: AnalyzeResult['failed'] = []
  const before = params.fresh === true ? undefined : await project.readState<AnalysisNote>(NOTE)
  // An analysis that was started before a pass existed is finished as it was begun; a new one has them all.
  const note: AnalysisNote = { schema: before?.schema ?? 4, startedAt: before?.startedAt ?? new Date().toISOString(), done: before?.done ?? [], ...(params.divide ?? before?.divide ?? false ? { divide: true } : {}) }
  const wanted = params.steps !== undefined && params.steps.length > 0
    ? ANALYZE_STEPS.filter(step => params.steps!.includes(step))
    : analysisSteps(note.schema).filter(step => !note.done.includes(step))
  // A style nobody wants learned is not something left undone.
  if (params.style === false && !note.done.includes('style')) note.done.push('style')
  const steps = (params.style === false ? wanted.filter(step => step !== 'style') : wanted)
  const result: AnalyzeResult = { steps, digested: 0, characters: 0, merged: 0, walkOns: 0, worldEntries: 0, failed }
  // A pass run by name on a book nobody was analysing is just that pass: it starts no analysis for the book to be told it has not finished.
  const tracked = before !== undefined || params.fresh === true || params.steps === undefined || params.steps.length === 0
  // Written before anything is done: an analysis that never comes back has left word of itself.
  if (tracked) await project.writeState([NOTE], note)
  const from = span?.from ?? 0
  const total = span?.total ?? Math.max(1, steps.length)
  let at = 0
  /** Progress inside the pass that is running: `part` of it is done. */
  const within = (part: number, label: string): void => { task.job?.progress(from + at + Math.min(1, Math.max(0, part)), total, label) }
  const finished = async (step: AnalyzeStep, ok: boolean): Promise<void> => {
    at += 1
    if (!ok || !tracked) return
    if (!note.done.includes(step)) note.done.push(step)
    await project.writeState([NOTE], note)
  }
  const base = { lang, language: manifest.language, title: manifest.title }

  // ── digest every chapter that has text and no memory of it ──
  if (steps.includes('digest')) {
    within(0, L(lang, '逐章提取摘要与事实', 'digesting chapters'))
    const inner: TaskContext = { ...task, job: task.job === undefined ? undefined : { ...task.job, progress: (done, all, label) => { within(done / Math.max(1, all), `${L(lang, '逐章提取', 'digesting')} ${done}/${all}${label !== undefined ? ` · ${label}` : ''}`) } } } as TaskContext
    const digest = await digestPending(core, runtime, inner)
    result.digested = digest.digested.length
    for (const failure of digest.failed) failed.push({ step: `digest ${failure.chapter}`, error: failure.error })
    await finished('digest', digest.failed.length === 0)
  }
  task.signal?.throwIfAborted()
  const memories = await project.memories()

  // ── the cast ──
  if (steps.includes('cast')) {
    within(0, L(lang, '归并人物', 'merging the cast'))
    try {
      const cast = await mergeCast(core, runtime, task, (done, rounds, label) => { within(done / Math.max(1, rounds), `${L(lang, '归并人物', 'merging the cast')} ${Math.min(done + 1, rounds)}/${rounds}${label.length > 0 ? ` · ${label}` : ''}`) })
      result.characters = cast.made + cast.filled
      result.merged = cast.merged
      result.walkOns = cast.walkOns
      failed.push(...cast.failed)
      await finished('cast', cast.failed.length === 0)
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push({ step: 'cast', error: error instanceof Error ? error.message : String(error) })
      await finished('cast', false)
    }
  }

  // ── the world ──
  if (steps.includes('world')) {
    within(0, L(lang, '整理世界观', 'collecting the world'))
    let ok = true
    try {
      const known = await project.world()
      const has = (name: string): boolean => known.some(entry => sameName(entry.name, name) || entry.aliases?.some(alias => sameName(alias, name)) === true)
      const seen = new Map<string, { kind: string; count: number; notes: string[] }>()
      const note = (name: string, kind: string, text: string): void => {
        if (has(name)) return
        const entry = seen.get(name) ?? { kind, count: 0, notes: [] }
        entry.count += 1
        if (entry.notes.length < 3) entry.notes.push(clip(text, 100))
        seen.set(name, entry)
      }
      for (const { memory } of memories) {
        for (const entity of memory.newEntities.filter(candidate => candidate.kind !== 'character')) note(entity.name, entity.kind, entity.description)
        for (const fact of memory.facts.filter(candidate => candidate.kind === 'world')) note(fact.subject, 'term', fact.statement)
      }
      // What the text comes back to most leads; a long book's world is asked for in rounds, like its cast.
      const ranked = [...seen.entries()].sort((left, right) => right[1].count - left[1].count)
      const rounds: [string, { kind: string; count: number; notes: string[] }][][] = []
      for (let start = 0; start < ranked.length; start += WORLD_ROUND) rounds.push(ranked.slice(start, start + WORLD_ROUND))
      for (const [round, names] of rounds.entries()) {
        task.signal?.throwIfAborted()
        within(round / rounds.length, `${L(lang, '整理世界观', 'collecting the world')} ${round + 1}/${rounds.length}`)
        try {
          const lines = names.map(([name, entry]) => `- ${name} [${entry.kind}] ${entry.notes.join('；')}`)
          const { value } = await assign(core, runtime, task, {
            role: 'architect',
            label: L(lang, `整理世界观 ${round + 1}/${rounds.length}`, `The world ${round + 1}/${rounds.length}`),
            tool: 'submit_world',
            what: L(lang, '合并整理后的设定条目', 'the world entries, merged and sorted'),
            system: architectSystem(lang),
            prompt: worldMergeTask({ ...base, sightings: lines.join('\n'), first: round === 0 }),
            temperature: 0.2,
            validate: raw => asRecord(raw),
          })
          for (const raw of asArray(value.entries)) {
            const item = asRecord(raw)
            const name = asText(item.name)
            if (name === undefined) continue
            const category = asText(item.category) as WorldCategory | undefined
            const importance = Number(item.importance)
            const aliases = asList(item.aliases)
            await project.saveWorld({
              name,
              category: category !== undefined && CATEGORIES.includes(category) ? category : 'other',
              // Core canon travels with every request: only what the text comes back to most may be named so.
              importance: importance === 1 && round === 0 ? 1 : importance === 3 ? 3 : 2,
              ...(aliases.length > 0 ? { aliases } : {}),
              ...pickText(item, ['summary', 'body']),
            } as Partial<WorldEntry> & { name: string })
            result.worldEntries += 1
          }
        } catch (error) {
          if (task.signal?.aborted === true) throw error
          ok = false
          failed.push({ step: `world ${round + 1}/${rounds.length}`, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await project.pruneSuggestions()
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      ok = false
      failed.push({ step: 'world', error: error instanceof Error ? error.message : String(error) })
    }
    await finished('world', ok)
  }

  // ── how the people of the book change along it: their ages, and the points where they turn ──
  if (steps.includes('growth')) {
    let ok = true
    // Those the story is carried by, once it has seen them in more than one chapter: a walk-on does not grow.
    const { lives } = await project.lives()
    const due = (await project.characters()).filter(card => ['protagonist', 'deuteragonist', 'antagonist', 'supporting'].includes(card.role) && (card.stages?.length ?? 0) === 0 && (lives[card.id]?.events ?? []).filter(event => event.index >= 1).length >= 2)
    let read = 0
    let stages = 0
    within(0, L(lang, `读 ${due.length} 个人物的成长轨迹`, `reading how ${due.length} people grow`))
    await mapLimit(due, core.parallel('text'), async (card) => {
      try {
        const inner: TaskContext = { origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) }
        stages += (await deriveGrowth(core, runtime, { character: card.id }, inner)).stages.length
      } catch (error) {
        if (task.signal?.aborted === true) throw error
        ok = false
        failed.push({ step: 'growth', error: `${card.name}: ${error instanceof Error ? error.message : String(error)}` })
      }
      read += 1
      within(read / Math.max(1, due.length), L(lang, `读人物的成长轨迹 ${read}/${due.length}`, `reading how people grow ${read}/${due.length}`))
    }, task.signal)
    result.growth = { people: due.length, stages }
    await finished('growth', ok)
  }
  task.signal?.throwIfAborted()

  // ── how the things of the world stand to each other, and what happens to them ──
  if (steps.includes('ties')) {
    within(0, L(lang, '理清地点、家族、人物之间的关系', 'working out how the world stands'))
    let ok = true
    try {
      const ties = await deriveTies(core, runtime, {}, task)
      result.ties = { added: ties.added, total: ties.total, events: ties.events }
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      // A book with no places, houses or things has nothing to tie: that is no pass left undone.
      if (!(error instanceof ProjectError && error.code === 'novel/empty')) {
        ok = false
        failed.push({ step: 'ties', error: error instanceof Error ? error.message : String(error) })
      }
    }
    await finished('ties', ok)
  }
  task.signal?.throwIfAborted()

  // ── outline: synopses, volumes, premise ──
  if (steps.includes('outline')) {
    within(0, L(lang, '生成大纲', 'building the outline'))
    let ok = true
    try {
      const characters = await project.characters()
      for (const { chapter, memory } of memories) {
        const cast = memory.characters.map(moment => characters.find(card => card.id === moment.character)?.id).filter((id): id is string => id !== undefined)
        // What the author wrote into a chapter's plan stays; the digest fills what is empty.
        await project.updateChapter(chapter.plan.id, {
          ...(chapter.plan.synopsis === undefined ? { synopsis: memory.summary } : {}),
          ...(cast.length > 0 && (chapter.plan.characters === undefined || chapter.plan.characters.length === 0) ? { characters: [...new Set(cast)] } : {}),
          ...(memory.storyTime !== undefined && chapter.plan.time === undefined ? { time: memory.storyTime } : {}),
          ...(memory.locations?.[0] !== undefined && chapter.plan.location === undefined ? { location: memory.locations[0] } : {}),
        })
      }
      const briefs = memories.map(({ chapter, memory }) => `${chapter.index}. ${chapter.plan.title} — ${memory.brief}`)
      if (briefs.length > 0) {
        // A line a chapter: as much of it as half of what the planner's model reads.
        const window = await core.windowOf(await core.route('architect', runtime, task)).catch(() => undefined)
        const room = Math.max(20_000, Math.floor((window ?? 200_000) / 2))
        const { value } = await assign(core, runtime, task, {
          role: 'architect',
          label: L(lang, '分卷与梗概', 'Volumes and premise'),
          tool: 'submit_volumes',
          what: L(lang, '分卷、各卷梗概和全书的故事核', 'the volumes, their synopses and the premise of the book'),
          system: architectSystem(lang),
          prompt: volumesTask({ ...base, summaries: clip(briefs.join('\n'), room) }),
          temperature: 0.3,
          validate: raw => asRecord(raw),
        })
        const now = await project.manifest()
        const themes = asList(value.themes)
        await project.updateManifest({
          ...(now.logline === undefined ? pickText(value, ['logline']) : {}),
          ...(now.premise === undefined ? pickText(value, ['premise']) : {}),
          ...(now.genre === undefined ? pickText(value, ['genre']) : {}),
          ...(now.themes === undefined && themes.length > 0 ? { themes } : {}),
        })
        const proposed = asArray(value.volumes).map(asRecord).map(volume => ({
          title: asText(volume.title),
          from: Number(volume.from),
          to: Number(volume.to),
          synopsis: asText(volume.synopsis),
          goal: asText(volume.goal),
        })).filter(volume => volume.title !== undefined && Number.isFinite(volume.from) && Number.isFinite(volume.to))
        // The book is divided only where it came with no volumes of its own, and only while it is still one volume: nobody's own division is redone.
        const outline = await project.outline()
        if (note.divide === true && outline.volumes.length <= 1 && proposed.length > 1) {
          const located = await project.chapters()
          await project.updateOutline((draft) => {
            const all = located.map(chapter => chapter.plan)
            const volumes = proposed.map((volume, index) => ({
              id: `v${index + 1}`,
              title: volume.title!,
              ...(volume.synopsis !== undefined ? { synopsis: volume.synopsis } : {}),
              ...(volume.goal !== undefined ? { goal: volume.goal } : {}),
              chapters: all.filter((_plan, position) => position + 1 >= volume.from && position + 1 <= volume.to),
            }))
            const placed = new Set(volumes.flatMap(volume => volume.chapters.map(plan => plan.id)))
            // Chapters the proposal forgot stay in the book, attached to the last volume.
            volumes.at(-1)!.chapters.push(...all.filter(plan => !placed.has(plan.id)))
            const ordered = volumes.filter(volume => volume.chapters.length > 0)
            if (ordered.length > 0 && ordered.flatMap(volume => volume.chapters).map(plan => plan.id).join() === all.map(plan => plan.id).join()) {
              draft.volumes = ordered
              result.volumes = ordered.length
            }
          })
        } else {
          await project.updateOutline((draft) => {
            for (const volume of draft.volumes) {
              const match = proposed.find(candidate => candidate.title !== undefined && sameName(candidate.title, volume.title))
              if (match?.synopsis !== undefined && volume.synopsis === undefined) volume.synopsis = match.synopsis
            }
          })
        }
      }
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      ok = false
      failed.push({ step: 'outline', error: error instanceof Error ? error.message : String(error) })
    }
    await finished('outline', ok)
  }

  // ── style ──
  if (steps.includes('style')) {
    within(0, L(lang, '提炼文风', 'learning the style'))
    let ok = true
    try {
      // A chapter from the middle shows the settled voice better than an opening.
      const written = (await project.chapterInfos()).filter(chapter => chapter.hasText)
      const sample = written[Math.min(written.length - 1, Math.floor(written.length / 3))]
      if (sample !== undefined) {
        const style: StyleProfile = await extractStyle(core, runtime, { sample: clip(await project.chapterText(sample.id), 5000), name: L(lang, '原作文风', 'Source style'), activate: true }, task)
        result.style = style.name
      }
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      ok = false
      failed.push({ step: 'style', error: error instanceof Error ? error.message : String(error) })
    }
    await finished('style', ok)
  }

  // ── the look of its pictures ──
  if (steps.includes('art')) {
    within(0, L(lang, '定画风', 'settling the look of its pictures'))
    let ok = true
    try {
      // A book the author has already given a look keeps it; asked for by name, the director settles it anew.
      const art = await deriveArtDirection(core, runtime, { keep: params.steps === undefined || params.steps.length === 0 }, task)
      if (art !== undefined) result.art = art.style
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      ok = false
      failed.push({ step: 'art', error: error instanceof Error ? error.message : String(error) })
    }
    await finished('art', ok)
  }
  try {
    await updateArcs(core, runtime, task)
  } catch (error) {
    if (task.signal?.aborted === true) throw error
    failed.push({ step: 'arcs', error: error instanceof Error ? error.message : String(error) })
  }
  task.job?.progress(from + at, total)
  return result
}

/** How many places, groups, objects and terms one request is asked to sort. */
const WORLD_ROUND = 100

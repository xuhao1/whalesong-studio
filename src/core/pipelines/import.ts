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
import { ANALYZE_STEPS, analysisSteps, type AnalyzeStep, type SettledSuggestion } from '../../shared/types'
import { clip, countWords, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import { ProjectError } from '../project'
import { architectSystem, volumesTask, worldMergeTask } from '../prompts'
import { L, languageName, promptLanguage } from '../render'
import { errorMessage } from '../util/async'
import type { JobContext } from '../jobs'
import { translateChapters } from './translate'
import { deriveTies, extractStyle, styleSamples } from './bible'
import { keepNotedScenes } from './scenes'
import { settleSuggestions, settlesItself } from './settle'
import { mergeCast } from './cast'
import { digestPending, updateArcs } from './digest'
import { pickText } from './plot'
import { findStructure } from './structure'
import { deriveArtDirection } from './illustrate'

export { decodeText, readBookFile } from '../util/bookfile'

export { splitChapters, type SplitChapter } from './structure'

export interface ImportLineResult {
  line: { id: string; title: string }
  chapters: number
  words: number
  /** How many of them were digested, and which could not be. */
  digested: number
  failed: { chapter: string; error: string }[]
}

/**
 * Import a manuscript as another line of the plot of a book that is already
 * there: a story that is different from its first chapter and shares the
 * world — the same bible, the same people where they are the same, the same
 * places. The line begins where the story begins and joins nothing; its
 * chapters are digested like any others, so whoever and whatever is new in
 * them comes up as suggestions, and lives, stages and signature scenes are
 * read along it as along any line.
 * @param params.digest - digest its chapters once they are in. Default true.
 */
export async function importLine(core: NovelCore, runtime: ProjectRuntime, params: { text: string; title: string; premise?: string; digest?: boolean }, task: TaskContext): Promise<ImportLineResult> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  task.job?.progress(0, 3, L(lang, '编辑正在查看书稿、找出章节', 'an editor is reading the manuscript for its chapters'))
  const structure = await findStructure(core, runtime, params.text, task)
  if (structure.chapters.length === 0) throw new ProjectError('novel/empty', L(lang, '这份文本里没有可导入的内容。', 'the text holds nothing to import'))
  task.job?.progress(1, 3, L(lang, `拆分为 ${structure.chapters.length} 章，放进新的一条线`, `splitting into ${structure.chapters.length} chapters on a line of their own`))
  const line = await project.addLine({ title: params.title.trim(), ...(params.premise !== undefined && params.premise.trim().length > 0 ? { premise: params.premise.trim() } : {}), origin: 'author' })
  const created: string[] = []
  let words = 0
  for (const chapter of structure.chapters) {
    const plan = await project.addChapter({ title: chapter.title, status: 'drafted' }, { line: line.id })
    await project.saveChapterText(plan.id, chapter.text, { snapshot: false, status: 'drafted' })
    created.push(plan.id)
    words += countWords(chapter.text)
  }
  // (What the author does on the page themselves is not put on the record of what others did.)
  if (task.origin !== 'user') await project.addActivity({ by: 'agent', tool: 'import', summary: L(lang, `导入了另一条故事线「${line.title}」：${created.length} 章`, `Imported another story line, "${line.title}": ${created.length} chapters`) })
  let digested = 0
  let failed: ImportLineResult['failed'] = []
  if (params.digest !== false) {
    task.job?.progress(2, 3, L(lang, `场记收录这条线的 ${created.length} 章`, `the scribe is digesting the line's ${created.length} chapters`))
    const done = await digestPending(core, runtime, task, { chapters: created })
    digested = done.digested.length
    failed = done.failed.map(item => ({ chapter: item.chapter, error: item.error }))
  }
  task.job?.result({ line: line.id, chapters: created.length })
  return { line: { id: line.id, title: line.title }, chapters: created.length, words, digested, failed }
}

export interface ImportParams {
  text: string
  /** Run the analysis passes after splitting. Default true. */
  analyze?: boolean
  /** Learn a style profile from the text. Default true. */
  style?: boolean
  /**
   * The manuscript is in another language than the book is to be in: translate it as it comes in — `to` the book's
   * language (what the book is then read, digested and analysed in), `from` what the manuscript is in where that is
   * known. The names are settled out of the text first; each chapter's original is kept as a version of it.
   */
  translate?: { to: string; from?: string; direction?: string }
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
  /** What became of the translation, where the manuscript was translated as it came in. */
  translated?: { to: string; chapters: number; failed: number; terms: number }
}

/** A job as a step inside it sees it: what the step says of its own progress is shown as a note, and what it would make the job's result or its text is left out. */
function within(job: JobContext): JobContext {
  return {
    id: job.id, kind: job.kind, project: job.project, origin: job.origin, signal: job.signal,
    progress: (_done, _total, label) => { if (label !== undefined) job.note(label) },
    write: (delta) => { job.write(delta) },
    rewrite: () => {},
    result: () => {},
    think: (delta) => { job.think(delta) },
    crew: (run) => { job.crew(run) },
    note: label => job.note(label),
  }
}

const CATEGORIES: WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']

export async function importManuscript(core: NovelCore, runtime: ProjectRuntime, params: ImportParams, task: TaskContext): Promise<ImportResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const failed: ImportResult['failed'] = []
  // Finding the chapters, writing them down, and every pass of the analysis.
  const translating = params.translate !== undefined && params.translate.to.trim().length > 0
  const before = translating ? 3 : 2
  const steps = params.analyze === false ? before : before + ANALYZE_STEPS.length
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
  // ── 3. translate it, where it came in another language: everything after reads the translation ──
  if (translating) {
    const { to, from, direction } = params.translate!
    advance(L(lang, `翻译成${languageName(to)}`, `translating into ${languageName(to)}`))
    // The book is in the language it is translated into; what it came in is what its chapters are noted as translated from.
    if (from !== undefined && from !== to) await project.updateManifest({ language: from })
    try {
      // Its progress is this step's: said where the import's is, without moving the import along.
      const inside = task.job !== undefined ? { ...task, job: within(task.job) } : task
      const made = await translateChapters(core, runtime, { chapters: created, to, ...(from !== undefined ? {} : { from: 'auto' }), settle: true, scan: true, ...(direction !== undefined ? { direction } : {}) }, inside)
      result.translated = { to, chapters: made.translated.length, failed: made.failed.length, terms: made.terms.total }
      for (const item of made.failed) failed.push({ step: 'translate', error: `${item.chapter}: ${item.error}` })
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push({ step: 'translate', error: errorMessage(error) })
    }
    await project.updateManifest({ language: to, ...(from !== undefined && from !== to ? { translatedFrom: from } : {}) })
  }
  if (params.analyze === false) {
    task.job?.progress(steps, steps)
    return result
  }

  // The text's own volumes stand; a book that named none, imported into an empty outline, may be divided by the planner.
  const analysis = await analyzeBook(core, runtime, { ...(params.style !== undefined ? { style: params.style } : {}), divide: !explicitVolumes && !hadChapters, fresh: true }, task, { from: before, total: steps })
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
  /** What was done with the suggestions the digests left: entered, folded into something there, left out. */
  settled?: { entered: number; merged: number; skipped: number }
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
      // What the digests noted as somebody's signature scene had no card to go on until now.
      await keepNotedScenes(runtime, (await project.characters()).map(card => card.id)).catch((error: unknown) => { core.log('could not bring the noted scenes onto the new cards', error) })
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
    const entered: Omit<SettledSuggestion, 'at'>[] = []
    try {
      const known = await project.world()
      const has = (name: string): boolean => known.some(entry => sameName(entry.name, name) || entry.aliases?.some(alias => sameName(alias, name)) === true)
      const seen = new Map<string, { kind: string; count: number; notes: string[]; looks: string[] }>()
      const note = (name: string, kind: string, text: string, looks?: string): void => {
        if (has(name)) return
        const entry = seen.get(name) ?? { kind, count: 0, notes: [], looks: [] }
        entry.count += 1
        if (entry.notes.length < 3) entry.notes.push(clip(text, 100))
        if (looks !== undefined && looks.trim().length > 0 && entry.looks.length < 2) entry.looks.push(clip(looks, 160))
        seen.set(name, entry)
      }
      for (const { memory } of memories) {
        for (const entity of memory.newEntities.filter(candidate => candidate.kind !== 'character')) note(entity.name, entity.kind, entity.description, entity.looks)
        for (const fact of memory.facts.filter(candidate => candidate.kind === 'world')) note(fact.subject, 'term', fact.statement)
      }
      // What the text comes back to most leads; a long book's world is asked for in rounds, like its cast.
      const ranked = [...seen.entries()].sort((left, right) => right[1].count - left[1].count)
      const rounds: [string, { kind: string; count: number; notes: string[]; looks: string[] }][][] = []
      for (let start = 0; start < ranked.length; start += WORLD_ROUND) rounds.push(ranked.slice(start, start + WORLD_ROUND))
      for (const [round, names] of rounds.entries()) {
        task.signal?.throwIfAborted()
        within(round / rounds.length, `${L(lang, '整理世界观', 'collecting the world')} ${round + 1}/${rounds.length}`)
        try {
          const lines = names.map(([name, entry]) => `- ${name} [${entry.kind}] ${L(lang, `${entry.count} 章`, `${entry.count} ch.`)} ${entry.notes.join('；')}${entry.looks.length > 0 ? L(lang, ` ｜样子：${entry.looks.join('；')}`, ` | looks: ${entry.looks.join('; ')}`) : ''}`)
          const { value } = await assign(core, runtime, task, {
            role: 'architect',
            label: L(lang, `整理世界观 ${round + 1}/${rounds.length}`, `The world ${round + 1}/${rounds.length}`),
            tool: 'submit_world',
            // What the digests wrote of each thing is in the task: one request a round, whatever the role is set to.
            plain: true,
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
            const saved = await project.saveWorld({
              name,
              category: category !== undefined && CATEGORIES.includes(category) ? category : 'other',
              // Core canon travels with every request: only what the text comes back to most may be named so.
              importance: importance === 1 && round === 0 ? 1 : importance === 3 ? 3 : 2,
              ...(aliases.length > 0 ? { aliases } : {}),
              ...pickText(item, ['summary', 'body']),
              // What it looks like, where the text says: a picture of it starts from this.
              ...(asText(item.look) !== undefined ? { visualPrompt: asText(item.look)! } : {}),
            } as Partial<WorldEntry> & { name: string })
            result.worldEntries += 1
            entered.push({ id: `import:${saved.id}`, kind: 'new-world', title: saved.name, detail: saved.summary ?? '', payload: { name: saved.name, category: saved.category }, verdict: 'entered', target: { type: 'world', id: saved.id } })
          }
          // What the planner found not worth an entry: on record, for the author to enter after all.
          for (const raw of asArray(value.skip)) {
            const item = asRecord(raw)
            const name = asText(item.name)
            const was = name !== undefined ? names.find(([listed]) => sameName(listed, name)) : undefined
            if (name === undefined || was === undefined) continue
            const kind = was[1].kind as WorldCategory
            const why = asText(item.why)
            entered.push({ id: `import:skip:${name}`, kind: 'new-world', title: name, detail: was[1].notes.join('；'), payload: { name, category: CATEGORIES.includes(kind) ? kind : 'other', ...(was[1].notes[0] !== undefined ? { summary: was[1].notes[0] } : {}) }, verdict: 'skipped', ...(why !== undefined ? { why } : {}) })
          }
        } catch (error) {
          if (task.signal?.aborted === true) throw error
          ok = false
          failed.push({ step: `world ${round + 1}/${rounds.length}`, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await project.pruneSuggestions()
      await project.noteSettled(entered)
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
    await mapLimit(due, await core.parallelFor('text', runtime), async (card) => {
      try {
        const inner: TaskContext = { origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) }
        stages += (await deriveGrowth(core, runtime, { character: card.id, plain: true }, inner)).stages.length
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
      const ties = await deriveTies(core, runtime, { plain: true }, task)
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
      const { whose } = await project.castResolver()
      for (const { chapter, memory } of memories) {
        const cast = memory.characters.map(moment => whose(moment, chapter.plan.id)).filter((id): id is string => id !== undefined)
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
          // All of it is in the task: asked in one request, whatever the role is set to.
          plain: true,
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
      // Passages from three places of the book: what holds across them is its style, not one scene's manner.
      const sample = await styleSamples(project)
      if (sample.trim().length >= 80) {
        const style: StyleProfile = await extractStyle(core, runtime, { sample, name: L(lang, '原作文风', 'Source style'), activate: true }, task)
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
  // What the digests proposed and no pass above made of: looked over by the planner and entered where it is worth it.
  if (settlesItself(core) && (steps.includes('world') || steps.includes('cast') || steps.includes('digest'))) {
    try {
      const settled = await settleSuggestions(core, runtime, { ...task, job: undefined } as TaskContext)
      result.settled = { entered: settled.entered.length, merged: settled.merged.length, skipped: settled.skipped }
      failed.push(...settled.failed)
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push({ step: 'settle', error: error instanceof Error ? error.message : String(error) })
    }
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

export interface RereadParams {
  /** Empty what the chapter outlines took from the text too (synopsis, who is in it, where, when, its threads). Default true. */
  plans?: boolean
  /** Forget what the reviews found. Default true. */
  reviews?: boolean
  /** Learn the style anew. Default true. */
  style?: boolean
}

export interface RereadResult {
  cleared: { digests: number; characters: number; world: number; ties: number; threads: number; reviews: number; suggestions: number; plans: number }
  analysis: AnalyzeResult
  /** Cards and entries of a name there was before, that have their pictures again. */
  pictures: { people: number; things: number }
  /** Who had pictures and has no card now: the pictures are in the gallery still. */
  without: string[]
}

const PERSON_PICTURES = ['prompt', 'negative', 'sheet', 'sheetFront', 'mainSheet', 'sheets', 'fronts', 'looks', 'portrait', 'portraits', 'face', 'sprites'] as const
const THING_PICTURES = ['visualPrompt', 'visualImage', 'visualImages', 'visualMain', 'spots'] as const

/**
 * Read the book again from nothing but its text: everything that was read off it — digests, cards, entries, ties,
 * threads, suggestions, what reviews found, what the outlines took from the chapters — is cleared, and the book is
 * taken in anew. The text stays, with its versions, and so does what was made for the eye and the ear: pictures stay
 * in the gallery and come back onto the card or entry of the same name; voices are kept by a person's name. A card or
 * an entry that is cleared is in the list of removed ones (or, where the name comes back, in its history).
 */
export async function rereadBook(core: NovelCore, runtime: ProjectRuntime, params: RereadParams, task: TaskContext): Promise<RereadResult> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  task.job?.progress(0, ANALYZE_STEPS.length + 1, L(lang, '清掉从正文读出来的东西', 'clearing what was read off the text'))
  // Every chapter of every line.
  const infos = await project.chapterInfos()
  const outline = await project.outline()
  for (const line of outline.lines ?? []) {
    for (const info of await project.chapterInfos(line.id)) if (!infos.some(known => known.id === info.id)) infos.push(info)
  }
  const characters = await project.characters()
  const world = await project.world()
  // What was drawn of whom, by every name they went by: it goes back onto whoever is called so afterwards.
  const drawn = characters.flatMap((card) => {
    const visual = Object.fromEntries(PERSON_PICTURES.flatMap(key => (card.visual?.[key] !== undefined ? [[key, card.visual[key]]] : [])))
    return Object.keys(visual).length > 0 ? [{ name: card.name, names: [card.name, ...(card.aliases ?? [])], visual }] : []
  })
  const shown = world.flatMap((entry) => {
    // What was drawn of it, with the words it was drawn from; a look nobody drew yet is read off the text anew.
    if (entry.visualImage === undefined) return []
    const pictures = Object.fromEntries(THING_PICTURES.flatMap(key => (entry[key] !== undefined ? [[key, entry[key]]] : [])))
    return [{ name: entry.name, names: [entry.name, ...(entry.aliases ?? [])], pictures }]
  })
  const ties = await project.clearTies()
  for (const card of characters) await project.deleteCharacter(card.id)
  for (const entry of world) await project.deleteWorld(entry.id)
  const threads = outline.threads.length
  if (threads > 0) await project.updateOutline((draft) => { draft.threads = [] })
  let plans = 0
  if (params.plans !== false) {
    for (const info of infos.filter(candidate => candidate.hasText)) {
      const plan = (await project.findChapter(info.id))?.plan
      if (plan === undefined || (plan.synopsis === undefined && plan.location === undefined && plan.time === undefined && (plan.characters ?? []).length === 0 && (plan.threads ?? []).length === 0)) continue
      await project.updateChapter(info.id, { synopsis: '', location: '', time: '', characters: [], threads: [] })
      plans += 1
    }
  } else {
    // Outlines kept: who is in a chapter and what it carries pointed at cards and threads that are gone.
    for (const info of infos) {
      const plan = (await project.findChapter(info.id))?.plan
      if (plan !== undefined && ((plan.characters ?? []).length > 0 || (plan.threads ?? []).length > 0)) await project.updateChapter(info.id, { characters: [], threads: [] })
    }
  }
  const forgot = await project.forgetReading(infos.map(info => info.id), { reviews: params.reviews !== false })
  task.signal?.throwIfAborted()
  const analysis = await analyzeBook(core, runtime, { fresh: true, ...(params.style === false ? { style: false } : {}) }, task, { from: 1, total: ANALYZE_STEPS.length + 1 })
  // The pictures, back onto whoever bears the name now.
  const pictures = { people: 0, things: 0 }
  const without: string[] = []
  const cards = await project.characters()
  for (const had of drawn) {
    const card = cards.find(candidate => had.names.some(name => sameName(candidate.name, name) || (candidate.aliases ?? []).some(alias => sameName(alias, name))))
    if (card === undefined) {
      without.push(had.name)
      continue
    }
    await project.saveCharacter({ id: card.id, visual: had.visual })
    pictures.people += 1
  }
  const entries = await project.world()
  for (const had of shown) {
    const entry = entries.find(candidate => had.names.some(name => sameName(candidate.name, name) || (candidate.aliases ?? []).some(alias => sameName(alias, name))))
    if (entry === undefined) {
      without.push(had.name)
      continue
    }
    await project.saveWorld({ id: entry.id, ...had.pictures })
    pictures.things += 1
  }
  await project.addActivity({
    by: 'crew',
    tool: 'reread',
    summary: L(lang,
      `纯净重新收录：清掉 ${characters.length} 张人物卡、${world.length} 条设定、${ties} 条关系、${threads} 条线索、${forgot.digests} 章的收录，从正文重读了一遍；现在 ${cards.length} 张人物卡、${entries.length} 条设定。`,
      `Read again from the text alone: ${characters.length} card(s), ${world.length} entr${world.length === 1 ? 'y' : 'ies'}, ${ties} tie(s), ${threads} thread(s) and the digests of ${forgot.digests} chapter(s) cleared; now ${cards.length} card(s) and ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`),
  }).catch((error: unknown) => { core.log('could not put the rereading on the book\'s record', error) })
  const result: RereadResult = { cleared: { digests: forgot.digests, characters: characters.length, world: world.length, ties, threads, reviews: forgot.reviews, suggestions: forgot.suggestions, plans }, analysis, pictures, without }
  task.job?.result({ reread: { cleared: result.cleared, pictures, without: without.slice(0, 40), characters: cards.length, world: entries.length, failed: analysis.failed.length } })
  return result
}

/** How many places, groups, objects and terms one request is asked to sort. */
const WORLD_ROUND = 100

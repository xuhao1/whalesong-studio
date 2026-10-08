// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Batches: the same work done to many chapters, characters or places in one
 * go, as one job.
 *
 * A batch is a set of steps — one thing done to one target — with what each
 * has to wait for. Whatever can run, runs: a chapter's voices, its sounds and
 * its storyboard side by side once its script stands; ten chapters at once
 * where each is its own; chapter after chapter where one builds on the last,
 * as writing does. How many requests go out at once is not the batch's to
 * say: every step works through the same gates as work started by hand.
 *
 * A step that fails is the only thing that fails: its row stops there, the
 * others go on, and the batch says in the end what did not come about. Every
 * step first looks whether there is anything to do, so a batch run again does
 * what was left — nothing is made twice.
 */
import {
  MAIN_LINE, STAGE_STEPS, TEXT_STEPS,
  type ArtStep, type BatchKind, type BatchRowView, type BatchStepState, type BatchStepView, type BatchView, type PromptLanguage, type StageStatus, type StageStep,
  type StoryboardDensity, type TextStep,
} from '../../shared/types'
import { hashText, proseOnly } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import type { JobContext } from '../jobs'
import { soundSetup } from '../media/sound'
import { ProjectError } from '../project'
import { L, promptLanguage } from '../render'
import { errorMessage, isAbort } from '../util/async'
import { buildAudioScript, designCharacterVoice, isSkipped, soundPlan, synthesizeChapter } from './audio'
import { buildStoryboard, renderPanels } from './comic'
import { digestChapter, updateArcs } from './digest'
import { illustrate } from './illustrate'
import { deriveBeats } from './plot'
import { reviewChapter } from './review'
import { renderSound } from './sound'
import { chapterVideo, produceVideo } from './video'
import { writeChapter } from './write'

/** One thing done to one target. */
export interface BatchStep {
  /** The row it belongs to. */
  target: string
  /** The step's name: the column it is shown in. */
  op: string
  /** Steps — as `target:op` — that have to be settled first. One that failed keeps this one from running. */
  after?: string[]
  /** Why there is nothing to do, in a few words; undefined when there is. Asked right before the step would run. */
  skip?(): Promise<string | undefined> | string | undefined
  /** Do it. @returns what came of it, in a few words. */
  run(task: TaskContext): Promise<string | undefined>
  /** The step writes prose the author follows as it comes: its stream is the job's. */
  stream?: boolean
}

export interface BatchPlan {
  what: BatchKind
  columns: string[]
  rows: Omit<BatchRowView, 'steps'>[]
  steps: BatchStep[]
  /** How many steps of one name run side by side. A name left out runs one at a time. */
  lanes: Record<string, number>
  /** Run once every step is settled, when at least one was done (the arcs after a run of digests). */
  finish?(task: TaskContext): Promise<void>
}

export interface BatchResult {
  batch: BatchView
  done: number
  skipped: number
  failed: { target: string; label: string; op: string; error: string }[]
}

const key = (target: string, op: string): string => `${target}:${op}`
const SETTLED: readonly BatchStepState[] = ['done', 'skipped', 'failed', 'blocked']
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))

/**
 * Run a batch to its end.
 * @throws when the task is cancelled; never because a step failed.
 */
export async function runBatch(plan: BatchPlan, task: TaskContext, lang: PromptLanguage): Promise<BatchResult> {
  const order = new Map(plan.rows.map((row, at) => [row.id, at]))
  const column = new Map(plan.columns.map((op, at) => [op, at]))
  // Rows first: a chapter that has begun is finished before the next is started on, as far as the lanes allow.
  const steps = [...plan.steps].sort((left, right) => (order.get(left.target) ?? 0) - (order.get(right.target) ?? 0) || (column.get(left.op) ?? 0) - (column.get(right.op) ?? 0))
  const views = new Map<string, BatchStepView>(steps.map(step => [key(step.target, step.op), { state: 'waiting' }]))
  const rowLabel = new Map(plan.rows.map(row => [row.id, row.label]))
  const running = new Map<string, number>()
  let settled = 0
  let failed = 0
  let done = 0

  const view = (): BatchView => ({
    what: plan.what,
    columns: plan.columns,
    rows: plan.rows.map(row => ({
      ...row,
      steps: Object.fromEntries(steps.filter(step => step.target === row.id).map(step => [step.op, views.get(key(step.target, step.op))!])),
    })),
    total: steps.length,
    settled,
    failed,
  })
  const publish = (): void => {
    const active = steps.filter(step => views.get(key(step.target, step.op))!.state === 'running')
    const label = active.slice(0, 3).map((step) => {
      const progress = views.get(key(step.target, step.op))!.progress
      return `${rowLabel.get(step.target) ?? step.target} · ${stepName(step.op, lang)}${progress !== undefined && progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''}`
    }).join(lang === 'zh' ? '；' : '; ')
    task.job?.progress(settled, steps.length, active.length > 3 ? `${label}${L(lang, ` 等 ${active.length} 项`, ` and ${active.length - 3} more`)}` : label)
    task.job?.result({ batch: view() })
  }
  const settle = (id: string, state: BatchStepState, note?: string): void => {
    // Whoever worked on it stays named: a step that is over can still be opened and read.
    const run = views.get(id)?.run
    views.set(id, { state, ...(note !== undefined && note.length > 0 ? { note: note.length > 240 ? `${note.slice(0, 240)}…` : note } : {}), ...(run !== undefined ? { run: { ...run, running: false } } : {}) })
    settled += 1
    if (state === 'failed' || state === 'blocked') failed += 1
    if (state === 'done') done += 1
  }

  /** The job as one step sees it: what it reports is the step's own, shown in its place in the batch. */
  const jobFor = (step: BatchStep, id: string): JobContext | undefined => {
    const parent = task.job
    if (parent === undefined) return undefined
    const patch = (change: Partial<BatchStepView>): void => {
      const current = views.get(id)!
      if (current.state !== 'running') return
      views.set(id, { ...current, ...change })
      publish()
    }
    return {
      id: parent.id,
      kind: parent.kind,
      project: parent.project,
      origin: parent.origin,
      signal: parent.signal,
      progress: (at, total, label) => { patch({ progress: { done: at, total, ...(label !== undefined ? { label } : {}) } }) },
      // Many steps talk at once: only the one the author reads along with gets the job's own stream.
      write: (delta) => { if (step.stream === true) parent.write(delta) },
      rewrite: (text) => { if (step.stream === true) parent.rewrite(text) },
      result: (value) => {
        patch({ detail: { ...views.get(id)!.detail, ...value } })
        // Which chapter is being written right now: a Studio showing it tails the stream.
        if (step.stream === true && typeof value.chapterId === 'string') parent.result({ chapterId: value.chapterId })
      },
      think: (delta) => { parent.think(delta) },
      crew: (run) => {
        parent.crew(run)
        // The run is this step's own: with many agents at work in one batch, each cell leads to its own.
        if (run.session !== undefined) patch({ run: { role: run.role, session: run.session, ...(run.parent !== undefined ? { parent: run.parent } : {}), ...(run.running === true ? { running: true } : {}) } })
      },
      note: (label) => {
        const before = views.get(id)!.progress
        patch({ progress: { done: before?.done ?? 0, total: before?.total ?? 0, label } })
        return () => { if (before !== undefined) patch({ progress: before }) }
      },
    }
  }

  const start = async (step: BatchStep): Promise<void> => {
    const id = key(step.target, step.op)
    try {
      const why = await step.skip?.()
      if (why !== undefined) {
        settle(id, 'skipped', why)
        return
      }
      views.set(id, { state: 'running' })
      publish()
      const job = jobFor(step, id)
      const note = await step.run({ ...task, ...(job !== undefined ? { job } : {}) })
      settle(id, 'done', note)
    } catch (error) {
      if (task.signal?.aborted === true || isAbort(error)) throw error
      settle(id, 'failed', errorMessage(error))
    }
  }

  publish()
  const inFlight = new Set<Promise<void>>()
  let stopped: unknown
  for (;;) {
    if (stopped === undefined && task.signal?.aborted !== true) {
      for (const step of steps) {
        const id = key(step.target, step.op)
        if (views.get(id)!.state !== 'waiting') continue
        const before = (step.after ?? []).map(dependency => views.get(dependency)).filter((dependency): dependency is BatchStepView => dependency !== undefined)
        if (before.some(dependency => dependency.state === 'failed' || dependency.state === 'blocked')) {
          settle(id, 'blocked', L(lang, '前一步没有完成', 'an earlier step did not complete'))
          continue
        }
        if (before.some(dependency => !SETTLED.includes(dependency.state))) continue
        const lane = Math.max(1, plan.lanes[step.op] ?? 1)
        if ((running.get(step.op) ?? 0) >= lane) continue
        running.set(step.op, (running.get(step.op) ?? 0) + 1)
        // Marked at once, so the next look does not start it twice.
        views.set(id, { state: 'running' })
        const work: Promise<void> = start(step).catch((error: unknown) => { stopped ??= error }).finally(() => {
          running.set(step.op, (running.get(step.op) ?? 1) - 1)
          inFlight.delete(work)
        })
        inFlight.add(work)
      }
      publish()
    }
    if (inFlight.size === 0) break
    await Promise.race(inFlight)
  }
  if (stopped !== undefined) throw stopped
  task.signal?.throwIfAborted()
  // Steps that wait on each other in a circle never got their turn: said, not left hanging.
  for (const step of steps) if (views.get(key(step.target, step.op))!.state === 'waiting') settle(key(step.target, step.op), 'blocked', L(lang, '等不到它要等的那一步', 'what it waits for never came'))
  if (done > 0 && plan.finish !== undefined) {
    try {
      await plan.finish(task)
    } catch (error) {
      if (task.signal?.aborted === true) throw error
    }
  }
  publish()
  const failures = steps.filter(step => views.get(key(step.target, step.op))!.state === 'failed').map(step => ({ target: step.target, label: rowLabel.get(step.target) ?? step.target, op: step.op, error: views.get(key(step.target, step.op))!.note ?? '' }))
  return { batch: view(), done, skipped: steps.filter(step => views.get(key(step.target, step.op))!.state === 'skipped').length, failed: failures }
}

const STEP_NAMES: Record<string, [string, string]> = {
  script: ['脚本', 'script'],
  voice: ['配音', 'voices'],
  sound: ['声音', 'sound'],
  storyboard: ['分镜', 'storyboard'],
  panels: ['画面', 'panels'],
  video: ['成片', 'video'],
  beats: ['节拍', 'beats'],
  write: ['写作', 'writing'],
  digest: ['收录', 'memory'],
  review: ['审校', 'review'],
  sheet: ['人设图', 'design sheet'],
  portrait: ['立绘', 'portrait'],
  place: ['场景设定图', 'place art'],
  item: ['物品设定图', 'thing art'],
  scene: ['插图', 'illustration'],
  cover: ['封面', 'cover'],
}

/** A step's name in words. */
export function stepName(op: string, lang: PromptLanguage): string {
  return STEP_NAMES[op]?.[lang === 'zh' ? 0 : 1] ?? op
}

/** The chapters a batch is about, in reading order: the ones named, or every one of the line. */
async function chaptersOf(runtime: ProjectRuntime, refs: readonly string[] | undefined, line: string | undefined): Promise<{ id: string; index: number; title: string; label: string; hasText: boolean }[]> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  const on = line !== undefined && line !== MAIN_LINE ? (await project.findLine(line))?.id : undefined
  if (line !== undefined && line !== MAIN_LINE && on === undefined) throw new ProjectError('novel/not-found', `no plot line matches "${line}"`)
  const infos = await project.chapterInfos(on)
  let chosen = infos
  if (refs !== undefined) {
    const wanted = new Set<string>()
    for (const ref of refs) {
      const chapter = await project.findChapter(ref, on)
      if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
      wanted.add(chapter.plan.id)
    }
    chosen = infos.filter(info => wanted.has(info.id))
    // A chapter of another line, named by its id, is still wanted: it is read where that line puts it.
    for (const id of wanted) {
      if (chosen.some(info => info.id === id)) continue
      const located = await project.findChapter(id)
      const info = located !== undefined ? (await project.chapterInfos(located.line)).find(candidate => candidate.id === id) : undefined
      if (info !== undefined) chosen.push(info)
    }
  }
  return chosen.map(info => ({ id: info.id, index: info.index, title: info.title, label: L(lang, `第${info.index}章 ${info.title}`, `Ch. ${info.index} ${info.title}`), hasText: info.hasText }))
}

// ───────────────────────────── the stage ─────────────────────────────

export interface StageBatchParams {
  /** Chapters to produce; left out: every chapter of the line that has text. */
  chapters?: string[]
  line?: string
  /** Which steps; left out: all that can be done with what is set up, but the video. */
  steps?: StageStep[]
  /** Do again what is already there. */
  force?: boolean
  density?: StoryboardDensity
  maxPanels?: number
  /** What the author wants of the videos. */
  direction?: string
  /** false: videos without subtitles. Left out: with them. */
  subtitles?: boolean
}

/** What each step of the stage needs that may not be there, as the author would be told. */
export async function stageReadiness(core: NovelCore, runtime: ProjectRuntime, task: Pick<TaskContext, 'agentRoute'> = {}): Promise<Partial<Record<StageStep, string>>> {
  const lang = promptLanguage((await runtime.project.manifest()).language)
  const settings = await core.settings.get()
  const missing: Partial<Record<StageStep, string>> = {}
  if (await core.ttsProvider(runtime) === undefined) missing.voice = L(lang, '还没有配置语音模型', 'no speech model is set up')
  if (soundSetup(settings) === undefined) missing.sound = L(lang, '还没有能生成声音的模型', 'nothing is set up that can make sound')
  if (await core.imageProvider(runtime) === undefined) missing.panels = L(lang, '还没有配置图像模型', 'no image model is set up')
  if (runtime.project.sealed) missing.video = L(lang, '加密的书不能剪成视频文件', 'a sealed book cannot be cut into a video file')
  else {
    const { findProgram } = await import('./video')
    if (await findProgram('ffmpeg') === undefined || await findProgram('ffprobe') === undefined) missing.video = L(lang, '这台电脑上没有 ffmpeg / ffprobe', 'ffmpeg / ffprobe are not on this computer')
    else {
      try {
        const route = await core.route('producer', runtime, task)
        if (core.roles?.can(route) !== true) missing.video = L(lang, `后期的模型 ${route.model} 当不了 agent`, `post-production's model ${route.model} cannot run as an agent`)
      } catch (error) {
        missing.video = errorMessage(error)
      }
    }
  }
  return missing
}

export async function stagePlan(core: NovelCore, runtime: ProjectRuntime, params: StageBatchParams, task: Pick<TaskContext, 'agentRoute'> = {}): Promise<BatchPlan> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  const chapters = (await chaptersOf(runtime, params.chapters, params.line)).filter(chapter => params.chapters !== undefined || chapter.hasText)
  if (chapters.length === 0) throw new ProjectError('novel/empty', L(lang, '没有可以制作的章节：先写出正文。', 'there is no chapter to produce: write some text first'))
  const missing = await stageReadiness(core, runtime, task)
  const wanted = new Set<StageStep>(params.steps !== undefined && params.steps.length > 0 ? params.steps : STAGE_STEPS.filter(step => step !== 'video' && missing[step] === undefined))
  const columns = STAGE_STEPS.filter(step => wanted.has(step))
  const force = params.force === true ? { force: true } : {}
  const steps: BatchStep[] = []
  for (const chapter of chapters) {
    const id = chapter.id
    const after = (...ops: StageStep[]): string[] => ops.filter(op => wanted.has(op)).map(op => key(id, op))
    const unavailable = (op: StageStep) => (): string | undefined => !chapter.hasText ? L(lang, '这一章还没有正文', 'this chapter has no text yet') : missing[op]
    if (wanted.has('script')) {
      steps.push({
        target: id,
        op: 'script',
        skip: unavailable('script'),
        async run(sub) {
          const script = await buildAudioScript(core, runtime, { chapter: id, ...force }, sub)
          const note = L(lang, `${script.lines.length} 句`, `${script.lines.length} lines`)
          // A script the director could not deliver is cut by rule and has no speakers: that is not a script done.
          if (script.degraded !== undefined) throw new Error(L(lang, `${script.degraded.blocks}/${script.degraded.of} 段没能由导演编排（${script.degraded.reason}）`, `${script.degraded.blocks} of ${script.degraded.of} passages could not be directed (${script.degraded.reason})`))
          return note
        },
      })
    }
    if (wanted.has('voice')) {
      steps.push({
        target: id,
        op: 'voice',
        after: after('script'),
        skip: unavailable('voice'),
        async run(sub) {
          const result = await synthesizeChapter(core, runtime, { chapter: id, ...force }, sub)
          const note = L(lang, `合成 ${result.rendered} 句，已有 ${result.cached} 句${result.flagged > 0 ? `，${result.flagged} 句待复听` : ''}`, `${result.rendered} voiced, ${result.cached} already there${result.flagged > 0 ? `, ${result.flagged} to re-listen` : ''}`)
          if (result.failed > 0) throw new Error(L(lang, `${result.failed} 句没有合成出来（${note}）`, `${result.failed} lines were not voiced (${note})`))
          return note
        },
      })
    }
    if (wanted.has('sound')) {
      steps.push({
        target: id,
        op: 'sound',
        after: after('script'),
        skip: unavailable('sound'),
        async run(sub) {
          const result = await renderSound(core, runtime, { chapter: id, ...force }, sub)
          const note = result.rendered + result.kept === 0 ? L(lang, '脚本里没有要生成的声音', 'the script asks for no sound') : L(lang, `生成 ${result.rendered} 处，已有 ${result.kept} 处`, `${result.rendered} made, ${result.kept} already there`)
          if (result.failed.length > 0) throw new Error(L(lang, `${result.failed.length} 处声音没有生成出来：${result.failed[0]!.error}`, `${result.failed.length} sounds were not made: ${result.failed[0]!.error}`))
          return note
        },
      })
    }
    if (wanted.has('storyboard')) {
      steps.push({
        target: id,
        op: 'storyboard',
        after: after('script'),
        skip: unavailable('storyboard'),
        async run(sub) {
          const board = await buildStoryboard(core, runtime, { chapter: id, ...force, ...(params.density !== undefined ? { density: params.density } : {}), ...(params.maxPanels !== undefined ? { maxPanels: params.maxPanels } : {}) }, sub)
          return L(lang, `${board.panels.length} 格`, `${board.panels.length} panels`)
        },
      })
    }
    if (wanted.has('panels')) {
      steps.push({
        target: id,
        op: 'panels',
        after: after('storyboard'),
        skip: unavailable('panels'),
        async run(sub) {
          const result = await renderPanels(core, runtime, { chapter: id, ...force }, sub)
          const note = L(lang, `绘制 ${result.rendered} 格，共 ${result.panels} 格`, `${result.rendered} drawn of ${result.panels}`)
          if (result.failed > 0) throw new Error(L(lang, `${result.failed} 格没有画出来（${note}）`, `${result.failed} panels were not drawn (${note})`))
          return note
        },
      })
    }
    if (wanted.has('video')) {
      steps.push({
        target: id,
        op: 'video',
        after: after('voice', 'sound', 'panels'),
        async skip() {
          const no = unavailable('video')()
          if (no !== undefined) return no
          return params.force !== true && await chapterVideo(runtime, id) !== undefined ? L(lang, '已有成片', 'there is a video already') : undefined
        },
        async run(sub) {
          const result = await produceVideo(core, runtime, { chapter: id, ...(params.subtitles === false ? { subtitles: false } : {}), ...(params.direction !== undefined ? { direction: params.direction } : {}) }, sub)
          return L(lang, `${Math.round(result.video.duration)} 秒`, `${Math.round(result.video.duration)} s`)
        },
      })
    }
  }
  const text = core.parallel('text')
  return {
    what: 'stage',
    columns,
    rows: chapters.map(chapter => ({ id: chapter.id, label: chapter.label, kind: 'chapter' as const })),
    steps,
    // A chapter's script is a few passages, its voices a hundred lines: enough chapters at once to keep every gate busy, few enough that the first ones are done first.
    lanes: {
      script: clamp(Math.ceil(text / 2), 2, 8),
      voice: clamp(Math.ceil(core.parallel('speech') / 32), 2, 8),
      sound: clamp(Math.ceil(core.parallel('sound') / 8), 2, 8),
      storyboard: clamp(Math.ceil(text / 2), 2, 8),
      panels: clamp(Math.ceil(core.parallel('image') / 8), 2, 8),
      video: 1,
    },
  }
}

/** Where the stage production of each chapter of a line stands. */
export async function stageOverview(core: NovelCore, runtime: ProjectRuntime, line?: string): Promise<StageStatus[]> {
  const { project } = runtime
  const settings = await core.settings.get()
  const on = line !== undefined && line !== MAIN_LINE ? (await project.findLine(line))?.id : undefined
  const beds = soundPlan(settings).beds
  const out: StageStatus[] = []
  for (const info of await project.chapterInfos(on)) {
    if (!info.hasText) continue
    const [script, board, video] = await Promise.all([project.audioScript(info.id), project.comicBoard(info.id), chapterVideo(runtime, info.id)])
    const textHash = script !== undefined || board !== undefined ? hashText(proseOnly(await project.chapterText(info.id))) : undefined
    const spoken = script?.lines.filter(entry => !isSkipped(entry, settings.tts)) ?? []
    // The sounds a model is asked for: every effect and piece of music, and the beds unless the book keeps to the browser's.
    const wantedCues = script?.cues.filter(cue => (cue.kind ?? 'bed') !== 'bed' || (beds === 'generate' && (cue.caption ?? cue.prompt ?? cue.note) !== undefined)) ?? []
    out.push({
      id: info.id,
      index: info.index,
      title: info.title,
      words: info.words,
      ...(script !== undefined ? { script: { lines: script.lines.length, spoken: spoken.length, voiced: spoken.filter(entry => entry.audio !== undefined).length, stale: script.textHash !== textHash, seconds: Math.round(spoken.reduce((sum, entry) => sum + (entry.duration ?? 0), 0)) } } : {}),
      ...(script !== undefined && wantedCues.length > 0 ? { sound: { wanted: wantedCues.length, made: wantedCues.filter(cue => cue.audio !== undefined).length } } : {}),
      ...(board !== undefined ? { board: { panels: board.panels.length, drawn: board.panels.filter(panel => panel.image !== undefined).length, stale: board.textHash !== textHash } } : {}),
      ...(video !== undefined ? { video: { duration: video.duration, createdAt: video.createdAt } } : {}),
    })
  }
  return out
}

// ───────────────────────────── the text ─────────────────────────────

export interface TextBatchParams {
  /** Chapters to work on, in whatever order: they are taken in reading order. */
  chapters?: string[]
  /** Without `chapters`: this many chapters from the first one the steps have something to do for. */
  count?: number
  line?: string
  steps: TextStep[]
  /** What every chapter written in this batch should keep to, in the author's words. */
  brief?: string
  /** A length recommended for every chapter written; left out, each chapter's own, else the book's, else the writer judges. */
  words?: number
  /** Write chapters that have text again; derive beats where there are some. */
  redo?: boolean
  /** What the reviews should look at. */
  focus?: string
}

export async function textPlan(core: NovelCore, runtime: ProjectRuntime, params: TextBatchParams): Promise<BatchPlan> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  const wanted = new Set<TextStep>(params.steps)
  if (wanted.size === 0) throw new ProjectError('novel/invalid', '`steps` names at least one of beats, write, digest, review')
  const redo = params.redo === true
  const all = await chaptersOf(runtime, params.chapters, params.line)
  const infos = new Map<string, { hasText: boolean; digested: boolean; beats: number; reviewed: boolean }>()
  for (const chapter of all) {
    const located = await project.findChapter(chapter.id)
    const facts = (await project.chapterInfos(located?.line)).find(info => info.id === chapter.id)
    infos.set(chapter.id, { hasText: facts?.hasText === true, digested: facts?.digested === true, beats: located?.plan.beats?.length ?? 0, reviewed: facts?.openIssues !== undefined })
  }
  let chapters = all
  if (params.chapters === undefined) {
    // From the first chapter the batch has anything to do for; so many of them.
    const todo = (id: string): boolean => {
      const facts = infos.get(id)!
      // Beats are for a chapter still to be written; one that has its text has no use for them, unless it is to be done again.
      return (wanted.has('write') && (!facts.hasText || redo)) || (wanted.has('beats') && (facts.beats === 0 || redo) && (!facts.hasText || redo))
        || (!wanted.has('write') && wanted.has('digest') && facts.hasText && (!facts.digested || redo)) || (!wanted.has('write') && wanted.has('review') && facts.hasText && (!facts.reviewed || redo))
    }
    chapters = all.filter(chapter => todo(chapter.id))
    if (params.count !== undefined && params.count > 0) chapters = chapters.slice(0, Math.round(params.count))
  }
  if (chapters.length === 0) throw new ProjectError('novel/empty', L(lang, '这些步骤在选中的章节里没有要做的事。', 'the steps have nothing to do for the chapters chosen'))
  const columns = TEXT_STEPS.filter(step => wanted.has(step))
  const writing = wanted.has('write')
  const steps: BatchStep[] = []
  let previous: string | undefined
  for (const chapter of chapters) {
    const id = chapter.id
    const facts = infos.get(id)!
    // Writing goes chapter after chapter: each is written knowing the one before, and what was learned from it.
    const chain = writing && previous !== undefined ? [key(previous, wanted.has('digest') ? 'digest' : 'write')] : []
    if (wanted.has('beats')) {
      steps.push({
        target: id,
        op: 'beats',
        after: chain,
        skip: () => facts.hasText && !redo ? L(lang, '已有正文', 'already written') : facts.beats > 0 && !redo ? L(lang, `已有 ${facts.beats} 个节拍`, `has ${facts.beats} beats`) : undefined,
        async run(sub) {
          const result = await deriveBeats(core, runtime, { chapter: id }, sub)
          return L(lang, `${result.beats.length} 个节拍`, `${result.beats.length} beats`)
        },
      })
    }
    if (writing) {
      steps.push({
        target: id,
        op: 'write',
        after: [...chain, ...(wanted.has('beats') ? [key(id, 'beats')] : [])],
        stream: true,
        skip: () => facts.hasText && !redo ? L(lang, '已有正文', 'already written') : undefined,
        async run(sub) {
          // Memory is this batch's own next step, so that the chapter after it waits for it.
          const result = await writeChapter(core, runtime, { chapter: id, mode: 'draft', digest: false, ...(params.brief !== undefined ? { brief: params.brief } : {}), ...(params.words !== undefined && params.words > 0 ? { words: params.words } : {}) }, sub)
          facts.hasText = true
          facts.digested = false
          return L(lang, `${result.wordsWritten} 字${result.budget === undefined ? '（篇幅由写手判断）' : ''}${result.cachedTokens !== undefined ? ` · 缓存命中 ${Math.round(result.cachedTokens / 1000)}K` : ''}`, `${result.wordsWritten} words${result.budget === undefined ? ' (length left to the writer)' : ''}${result.cachedTokens !== undefined ? ` · ${Math.round(result.cachedTokens / 1000)}K cached` : ''}`)
        },
      })
    }
    if (wanted.has('digest')) {
      steps.push({
        target: id,
        op: 'digest',
        after: writing ? [key(id, 'write')] : [],
        skip: () => !facts.hasText ? L(lang, '还没有正文', 'no text yet') : facts.digested && !redo ? L(lang, '记忆已是最新', 'memory is current') : undefined,
        async run(sub) {
          const memory = await digestChapter(core, runtime, id, sub, redo ? { force: true } : {})
          // The chapters after this one are written with the arcs brought up to it.
          if (writing) await updateArcs(core, runtime, sub).catch((error: unknown) => { if (sub.signal?.aborted === true) throw error })
          facts.digested = true
          return memory !== undefined ? L(lang, `${memory.facts.length} 条事实，${memory.characters.length} 个人物`, `${memory.facts.length} facts, ${memory.characters.length} characters`) : undefined
        },
      })
    }
    if (wanted.has('review')) {
      steps.push({
        target: id,
        op: 'review',
        after: wanted.has('digest') ? [key(id, 'digest')] : writing ? [key(id, 'write')] : [],
        skip: () => !facts.hasText ? L(lang, '还没有正文', 'no text yet') : facts.reviewed && !redo && !writing ? L(lang, '已审校过', 'reviewed already') : undefined,
        async run(sub) {
          const review = await reviewChapter(core, runtime, { chapter: id, ...(params.focus !== undefined ? { focus: params.focus } : {}) }, sub)
          return L(lang, `${review.issues.length} 条问题`, `${review.issues.length} issues`)
        },
      })
    }
    previous = id
  }
  const text = core.parallel('text')
  return {
    what: 'text',
    columns,
    rows: chapters.map(chapter => ({ id: chapter.id, label: chapter.label, kind: 'chapter' as const })),
    steps,
    lanes: { beats: writing ? 1 : text, write: 1, digest: writing ? 1 : text, review: text },
    // Without writing, the digests ran side by side: the arcs are brought up once, at the end.
    ...(wanted.has('digest') && !writing ? { finish: async (sub: TaskContext) => { await updateArcs(core, runtime, sub) } } : {}),
  }
}

// ───────────────────────────── pictures and voices ─────────────────────────────

export interface ArtBatchParams {
  /** Characters to draw a design sheet for. */
  sheets?: string[]
  portraits?: string[]
  /** Characters to design a voice of their own for. */
  voices?: string[]
  /** World entries to draw reference art for. */
  places?: string[]
  /** World entries that are things, to draw design art for: the object alone. */
  items?: string[]
  /** Chapters to illustrate, one picture each. */
  scenes?: string[]
  cover?: boolean
  /** Put each chapter's picture at the head of its text. */
  insert?: boolean
  /** Draw again what is already there. */
  force?: boolean
}

export async function artPlan(core: NovelCore, runtime: ProjectRuntime, params: ArtBatchParams): Promise<BatchPlan> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const force = params.force === true
  const [characters, world, pictures] = await Promise.all([project.characters(), project.world(), project.illustrations()])
  const rows: BatchPlan['rows'] = []
  const steps: BatchStep[] = []
  const row = (id: string, label: string, kind: BatchRowView['kind']): void => {
    if (!rows.some(entry => entry.id === id)) rows.push({ id, label, kind })
  }
  const noImages = await core.imageProvider(runtime) === undefined ? L(lang, '还没有配置图像模型', 'no image model is set up') : undefined
  const noVoices = await core.ttsProvider(runtime).then(provider => provider === undefined ? L(lang, '还没有配置语音模型', 'no speech model is set up') : provider.designVoice === undefined ? L(lang, '现在的语音模型不能设计声线', 'the speech model in use cannot design voices') : undefined)
  const card = async (ref: string) => {
    const found = await project.findCharacter(ref)
    if (found === undefined) throw new ProjectError('novel/not-found', `no character matches "${ref}"`)
    return found
  }
  const sheetOf = new Map<string, string>()
  for (const ref of params.sheets ?? []) {
    const who = await card(ref)
    row(who.id, who.name, 'character')
    sheetOf.set(who.id, key(who.id, 'sheet'))
    steps.push({
      target: who.id,
      op: 'sheet',
      skip: async () => noImages ?? (!force && (await project.findCharacter(who.id))?.visual?.sheet !== undefined ? L(lang, '已有人设图', 'has a design sheet') : undefined),
      async run(sub) {
        await illustrate(core, runtime, { kind: 'sheet', target: who.id }, sub)
        return undefined
      },
    })
  }
  for (const ref of params.portraits ?? []) {
    const who = await card(ref)
    row(who.id, who.name, 'character')
    steps.push({
      target: who.id,
      op: 'portrait',
      // Drawn against the sheet when this batch makes one: the same person in both.
      after: sheetOf.has(who.id) ? [sheetOf.get(who.id)!] : [],
      skip: async () => noImages ?? (!force && (await project.findCharacter(who.id))?.visual?.portrait !== undefined ? L(lang, '已有立绘', 'has a portrait') : undefined),
      async run(sub) {
        await illustrate(core, runtime, { kind: 'portrait', target: who.id }, sub)
        return undefined
      },
    })
  }
  for (const ref of params.voices ?? []) {
    const who = await card(ref)
    row(who.id, who.name, 'character')
    steps.push({
      target: who.id,
      op: 'voice',
      skip: async () => noVoices ?? (!force && (await project.findCharacter(who.id))?.voiceProfile?.voice !== undefined ? L(lang, '已有自己的声线', 'has a voice of their own') : undefined),
      async run(sub) {
        await designCharacterVoice(core, runtime, { character: who.id }, sub)
        return undefined
      },
    })
  }
  const placeSteps: string[] = []
  for (const ref of params.places ?? []) {
    const entry = world.find(candidate => candidate.id === ref) ?? await project.findWorld(ref)
    if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${ref}"`)
    row(entry.id, entry.name, 'place')
    placeSteps.push(key(entry.id, 'place'))
    steps.push({
      target: entry.id,
      op: 'place',
      skip: async () => noImages ?? (!force && (await project.findWorld(entry.id))?.visualImage !== undefined ? L(lang, '已有场景设定图', 'has place art') : undefined),
      async run(sub) {
        await illustrate(core, runtime, { kind: 'location', target: entry.id }, sub)
        return undefined
      },
    })
  }
  for (const ref of params.items ?? []) {
    const entry = world.find(candidate => candidate.id === ref) ?? await project.findWorld(ref)
    if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${ref}"`)
    row(entry.id, entry.name, 'place')
    placeSteps.push(key(entry.id, 'item'))
    steps.push({
      target: entry.id,
      op: 'item',
      skip: async () => noImages ?? (!force && (await project.findWorld(entry.id))?.visualImage !== undefined ? L(lang, '已有物品设定图', 'has design art') : undefined),
      async run(sub) {
        await illustrate(core, runtime, { kind: 'item', target: entry.id }, sub)
        return undefined
      },
    })
  }
  // Scenes and the cover are drawn against the sheets, the places and the things: they wait for the ones this batch makes.
  const references = [...sheetOf.values(), ...placeSteps]
  if (params.scenes !== undefined && params.scenes.length > 0) {
    for (const chapter of await chaptersOf(runtime, params.scenes, undefined)) {
      row(chapter.id, chapter.label, 'chapter')
      steps.push({
        target: chapter.id,
        op: 'scene',
        after: references,
        skip: () => noImages ?? (!chapter.hasText ? L(lang, '这一章还没有正文', 'this chapter has no text yet') : !force && pictures.some(picture => picture.kind === 'scene' && picture.target === chapter.id) ? L(lang, '已有插图', 'has an illustration') : undefined),
        async run(sub) {
          const result = await illustrate(core, runtime, { kind: 'scene', target: chapter.id, ...(params.insert === true ? { insert: true } : {}) }, sub)
          return result.inserted ? L(lang, '已放进正文', 'placed in the text') : undefined
        },
      })
    }
  }
  if (params.cover === true) {
    row('book', L(lang, `《${manifest.title}》`, `"${manifest.title}"`), 'book')
    steps.push({
      target: 'book',
      op: 'cover',
      after: [...sheetOf.values()],
      skip: async () => noImages ?? (!force && await project.cover() !== undefined ? L(lang, '已有封面', 'has a cover') : undefined),
      async run(sub) {
        await illustrate(core, runtime, { kind: 'cover' }, sub)
        return undefined
      },
    })
  }
  if (steps.length === 0) throw new ProjectError('novel/invalid', 'name what to make: `sheets`, `portraits`, `voices`, `places`, `items`, `scenes` or `cover`')
  const ops: ArtStep[] = ['sheet', 'portrait', 'voice', 'place', 'item', 'scene', 'cover']
  const image = core.parallel('image')
  // One request each: as many side by side as the gate lets through.
  return {
    what: 'art',
    columns: ops.filter(op => steps.some(step => step.op === op)),
    rows,
    steps,
    lanes: { sheet: image, portrait: image, place: image, item: image, scene: image, cover: 1, voice: core.parallel('speech') },
  }
}

/** What a finished batch came to, in a sentence — for a tool's answer and for the book's record. */
export function batchSummary(result: BatchResult, lang: PromptLanguage): string {
  const parts = [
    L(lang, `完成 ${result.done} 项`, `${result.done} done`),
    result.skipped > 0 ? L(lang, `${result.skipped} 项不需要做`, `${result.skipped} needed nothing`) : undefined,
    result.failed.length > 0 ? L(lang, `${result.failed.length} 项没有做成`, `${result.failed.length} did not come about`) : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.join(lang === 'zh' ? '，' : ', ')
}

/** The steps of a batch that did not come about, one to a line. */
export function batchFailures(result: BatchResult, lang: PromptLanguage, limit = 12): string {
  return result.failed.slice(0, limit).map(item => `- ${item.label} · ${stepName(item.op, lang)}${lang === 'zh' ? '：' : ': '}${item.error}`).join('\n')
}

export type { ArtStep, BatchView, StageStep, TextStep }

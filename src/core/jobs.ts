// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Long-running work (drafting, importing, synthesizing) as observable jobs.
 * A job carries progress, a streamed text buffer the UI tails while prose is
 * being written, and a cancel switch. Jobs live in memory; what they produce
 * is written to the project by the pipeline that runs inside them.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { CrewRun, JobInfo, JobKind, JobProgress } from '../shared/types'
import { newId } from '../shared/text'
import { anySignal, errorMessage, isAbort } from './util/async'

export interface JobSpec {
  kind: JobKind
  title: string
  project: string
  target?: string
  origin: 'agent' | 'user'
  /** Cancellation owned by whoever started the job (a tool call's signal). */
  signal?: AbortSignal
}

export interface JobContext {
  readonly id: string
  /** What kind of work this is and which book it is for: the usage ledger files calls under both. */
  readonly kind: JobKind
  readonly project: string
  readonly origin: 'agent' | 'user'
  /** Aborts when the job is cancelled from the UI or by its starter. */
  readonly signal: AbortSignal
  progress(done: number, total: number, label?: string): void
  /** Append to the streamed text. */
  write(delta: string): void
  /** Replace the streamed text (a new attempt, a new section). */
  rewrite(text: string): void
  result(value: Record<string, unknown>): void
  /**
   * A model is reasoning before it answers: `delta` is the next piece of what it
   * thinks — the chain of thought itself where the model shows it, a summary of
   * it where it does not. Kept beside the text for whoever watches the job.
   */
  think(delta: string): void
  /** A role of the crew worked in this job: put its run on the job, for whoever wants to open it. */
  crew(run: CrewRun): void
  /**
   * Say what is happening right now where the progress label is shown, without
   * moving the progress itself — a call being repeated, a wait.
   * @returns puts the earlier label back, unless the work has moved on since.
   */
  note(label: string): () => void
}

const active = new AsyncLocalStorage<JobContext>()

/**
 * The job the current async call chain runs in, if any. Lets the model adapter
 * report "still thinking" without every pipeline threading a callback through.
 */
export function currentJob(): JobContext | undefined {
  return active.getStore()
}

interface JobRecord {
  info: JobInfo
  text: string
  /** Everything the models of this job thought, in order; calls are set apart by a blank line. */
  thought: string
  /** Characters of thought in the burst that is running now. */
  burst: number
  controller: AbortController
}

/** Thought is kept for reading along, not for the record: the tail is enough. */
const THOUGHT_LIMIT = 400_000
/** How many of a job's agent runs stay listed with it: a batch over a whole book has hundreds, and the list travels to every open Studio. */
const CREW_RUNS_KEPT = 400

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly listeners = new Set<() => void>()
  private tickValue = 0

  /** Bumped on every job change; the UI long-polls on it together with the project revision. */
  get tick(): number {
    return this.tickValue
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Something beside the jobs changed that whoever watches them should see (a gate slowed down). */
  touch(): void {
    this.notify()
  }

  private notify(): void {
    this.tickValue += 1
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // never let an observer break a job
      }
    }
  }

  /**
   * Run `task` as a job. The returned promise settles with the task's outcome;
   * a rejection is also recorded on the job, so it is safe to leave unawaited.
   */
  start<T>(spec: JobSpec, task: (job: JobContext) => Promise<T>): { id: string; done: Promise<T> } {
    const id = newId('job')
    const controller = new AbortController()
    const record: JobRecord = {
      info: {
        id,
        kind: spec.kind,
        title: spec.title,
        status: 'running',
        project: spec.project,
        ...(spec.target !== undefined ? { target: spec.target } : {}),
        startedAt: new Date().toISOString(),
        streamLength: 0,
        origin: spec.origin,
      },
      text: '',
      thought: '',
      burst: 0,
      controller,
    }
    this.jobs.set(id, record)
    this.prune()
    this.notify()

    const signal = anySignal(controller.signal, spec.signal)!
    let lastNotify = 0
    const throttled = (): void => {
      // Streaming deltas arrive many times a second; observers only need a few.
      const now = Date.now()
      if (now - lastNotify < 250) return
      lastNotify = now
      this.notify()
    }
    const context: JobContext = {
      id,
      kind: spec.kind,
      project: spec.project,
      origin: spec.origin,
      signal,
      progress: (done, total, label) => {
        const progress: JobProgress = { done, total, ...(label !== undefined ? { label } : {}) }
        record.info = { ...record.info, progress }
        throttled()
      },
      write: (delta) => {
        record.text += delta
        record.burst = 0
        const { thinking: _thinking, ...info } = record.info
        record.info = { ...info, streamLength: record.text.length }
        throttled()
      },
      rewrite: (text) => {
        record.text = text
        record.burst = 0
        const { thinking: _thinking, ...info } = record.info
        record.info = { ...info, streamLength: text.length }
        throttled()
      },
      think: (delta) => {
        if (delta.length === 0) return
        const before = record.thought.length
        // A new burst — another call, or thought resumed after some text — starts its own paragraph.
        if (record.burst === 0 && record.thought.length > 0) record.thought += '\n\n'
        record.thought += delta
        const added = record.thought.length - before
        if (record.thought.length > THOUGHT_LIMIT) record.thought = record.thought.slice(-THOUGHT_LIMIT)
        record.burst += delta.length
        record.info = { ...record.info, thinking: record.burst, thoughtLength: (record.info.thoughtLength ?? 0) + added }
        throttled()
      },
      result: (value) => {
        record.info = { ...record.info, result: { ...record.info.result, ...value } }
        throttled()
      },
      crew: (run) => {
        // A run is listed when it starts and again when it ends: the second word on a session replaces the first.
        const before = record.info.crew ?? []
        const at = run.session !== undefined ? before.findIndex(known => known.session === run.session) : -1
        const next = at >= 0 ? before.map((known, index) => (index === at ? run : known)) : [...before, run]
        record.info = { ...record.info, crew: next.slice(-CREW_RUNS_KEPT) }
        throttled()
      },
      note: (label) => {
        const before = record.info.progress
        record.info = { ...record.info, progress: { done: before?.done ?? 0, total: before?.total ?? 0, label } }
        this.notify()
        return () => {
          const now = record.info.progress
          if (record.info.status !== 'running' || now?.label !== label) return
          record.info = { ...record.info, progress: { done: now.done, total: now.total, ...(before?.label !== undefined ? { label: before.label } : {}) } }
          this.notify()
        }
      },
    }

    const done = (async () => {
      try {
        const value = await active.run(context, async () => await task(context))
        const { thinking: _thinking, ...info } = record.info
        record.info = { ...info, status: 'done', endedAt: new Date().toISOString() }
        return value
      } catch (error) {
        const cancelled = signal.aborted || isAbort(error)
        record.info = {
          ...record.info,
          status: cancelled ? 'cancelled' : 'failed',
          endedAt: new Date().toISOString(),
          ...(cancelled ? {} : { error: errorMessage(error) }),
        }
        throw error
      } finally {
        this.notify()
      }
    })()
    // The job record already carries the failure; an unobserved rejection must not take the process down.
    done.catch(() => {})
    return { id, done }
  }

  get(id: string): JobInfo | undefined {
    return this.jobs.get(id)?.info
  }

  /** Jobs of one project (or all), newest first. */
  list(project?: string): JobInfo[] {
    return [...this.jobs.values()]
      .map(record => record.info)
      .filter(info => project === undefined || info.project === project)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  /** Streamed text from `cursor` on — and, when `thoughtCursor` is given, the models' thought from there on. */
  read(id: string, cursor = 0, thoughtCursor?: number): { text: string; cursor: number; info: JobInfo; thought?: string; thoughtCursor?: number } | undefined {
    const record = this.jobs.get(id)
    if (record === undefined) return undefined
    // A rewrite can shorten the buffer; start over from the top in that case.
    const from = cursor > record.text.length ? 0 : cursor
    const state = { text: record.text.slice(from), cursor: record.text.length, info: record.info }
    if (thoughtCursor === undefined) return state
    // The thought buffer keeps its tail only; a reader that fell behind the cut starts from what is left.
    const total = record.info.thoughtLength ?? record.thought.length
    const start = Math.max(0, record.thought.length - Math.max(0, total - thoughtCursor))
    return { ...state, thought: thoughtCursor > total ? record.thought : record.thought.slice(start), thoughtCursor: total }
  }

  cancel(id: string): boolean {
    const record = this.jobs.get(id)
    if (record === undefined || record.info.status !== 'running') return false
    record.controller.abort(new Error('aborted'))
    return true
  }

  /** Cancel everything still running (plugin unload). */
  cancelAll(): void {
    for (const record of this.jobs.values()) if (record.info.status === 'running') record.controller.abort(new Error('aborted'))
  }

  private prune(keep = 60): void {
    const finished = [...this.jobs.values()].filter(record => record.info.status !== 'running')
    finished.sort((left, right) => left.info.startedAt.localeCompare(right.info.startedAt))
    for (const record of finished.slice(0, Math.max(0, finished.length - keep))) this.jobs.delete(record.info.id)
  }
}

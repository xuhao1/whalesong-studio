// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The record of calls: what the Studio sent to a text model for a book, and
 * what the model said.
 *
 * A model answers from what it is sent and from nothing else. When two pieces
 * of writing come out unlike each other — or one comes out wrong — the first
 * thing to look at is what each call was sent and how the model was set. The
 * usage ledger counts calls; this keeps them: the rules of the role, what
 * opened the request, the request, the reply, the model and its settings, how
 * long it took and how it ended.
 *
 * It is kept in the book, under `.novel/calls/`: a sealed book's record is
 * sealed with it, and nothing of a book lies in the open anywhere else. One
 * document a call; what a run of calls has in common — the rules of a role,
 * the story so far sent ahead of chapter after chapter — is kept once and
 * shared. A book keeps as many megabytes of it as the author says
 * (`callsMb`), the oldest going first.
 *
 * Calls made by a role working as an agent are the Harness's own loop and are
 * not here: such a run is a conversation of its own, opened from its job.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { CALLS_MB_DEFAULT, type CallRecord, type CallRow, type NovelSettings } from '../shared/types'
import { currentJob, type JobManager } from './jobs'
import type { LlmBackend, LlmRequest, LlmResponse } from './llm'
import type { Project } from './project'
import { errorMessage, isAbort } from './util/async'

const DIR = 'calls'
const INDEX = 'index.json'
const PARTS = 'parts'
/** A stretch shorter than this is kept with its call: sharing it saves nothing worth a file. */
const SHARED_FROM = 1500
/** Calls a book keeps at most, whatever their size: the list of them is one document, written with every call. */
export const CALLS_MOST = 3000

interface Index {
  schema: 1
  calls: CallRow[]
  /** The shared parts there are, and the bytes each takes. */
  parts: Record<string, number>
}

/** A call as its document holds it: a shared part is named, not repeated. */
type Kept = Omit<CallRecord, 'bytes'> & { systemPart?: string; stablePart?: string }

interface Scope {
  /** What the work is for: a chapter, or whatever else the step works on. */
  target?: string
  /** What the work is within its job: a step of a batch, the digest that follows a chapter written. */
  step?: string
}

const scopes = new AsyncLocalStorage<Scope>()

/**
 * Say what a stretch of work is for, where its job alone does not: a step of a batch, one chapter of a run of them.
 * Every call made inside is filed under it.
 */
export function callsFor<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
  return scopes.run({ ...scopes.getStore(), ...scope }, work)
}

export interface CallsHost {
  jobs: Pick<JobManager, 'get'>
  settings(): NovelSettings
  /** The book at a root, where it is open. */
  book(root: string): Promise<Project | undefined>
  log(message: string, error?: unknown): void
}

type About = Pick<CallRow, 'kind' | 'title' | 'job' | 'step'> & { ref?: string }

interface Outcome {
  reply: string
  finish?: string
  usage?: LlmResponse['usage']
  thought?: number
  error?: string
  stopped?: boolean
}

const fresh = (): Index => ({ schema: 1, calls: [], parts: {} })

export class CallLog {
  /** One writer at a time for a book's record: calls end side by side, and the list of them is one document. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly host: CallsHost) {}

  /** Megabytes of calls a book keeps; 0 when none is kept. */
  megabytes(): number {
    const set = this.host.settings().callsMb
    return typeof set === 'number' && Number.isFinite(set) && set >= 0 ? set : CALLS_MB_DEFAULT
  }

  /** Keep every call that goes through a backend for a book. Keeping never fails a call, and a call is on record by the time it returns. */
  wrap(llm: LlmBackend): LlmBackend {
    const kept = Object.create(llm) as LlmBackend
    kept.complete = async (request) => {
      const book = request.route.for?.book
      if (book === undefined || this.megabytes() <= 0) return await llm.complete(request)
      const started = Date.now()
      const about = this.about()
      let partial = ''
      try {
        const response = await llm.complete({ ...request, onText: (delta, total) => { partial = total; request.onText?.(delta, total) } })
        await this.keep(book, request, about, started, { reply: response.text, finish: response.finish, ...(response.usage !== undefined ? { usage: response.usage } : {}), ...(response.thought !== undefined ? { thought: response.thought } : {}) })
        return response
      } catch (error) {
        const stopped = isAbort(error) || request.signal?.aborted === true
        await this.keep(book, request, about, started, { reply: partial, error: stopped ? 'stopped' : errorMessage(error), ...(stopped ? { stopped: true } : {}) })
        throw error
      }
    }
    return kept
  }

  /** What the call under way is for, as far as its job and whoever runs it say. */
  private about(): About {
    const job = currentJob()
    const info = job !== undefined ? this.host.jobs.get(job.id) : undefined
    const scope = scopes.getStore()
    const named = info?.result?.chapterId
    const ref = scope?.target ?? (typeof named === 'string' && named.length > 0 ? named : info?.target)
    return {
      ...(job !== undefined ? { kind: job.kind, job: job.id } : {}),
      ...(info !== undefined ? { title: info.title } : {}),
      ...(scope?.step !== undefined ? { step: scope.step } : {}),
      ...(ref !== undefined && ref.length > 0 ? { ref } : {}),
    }
  }

  private queue<T>(root: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(root) ?? Promise.resolve()).then(work, work)
    this.queues.set(root, next.catch(() => {}))
    return next
  }

  private async index(project: Project): Promise<Index> {
    const read = await project.readRecord<Partial<Index>>(DIR, INDEX).catch(() => undefined)
    if (read === undefined || read === null || !Array.isArray(read.calls)) return fresh()
    return { schema: 1, calls: read.calls, parts: typeof read.parts === 'object' && read.parts !== null ? read.parts : {} }
  }

  private async keep(root: string, request: LlmRequest, about: About, started: number, outcome: Outcome): Promise<void> {
    try {
      await this.queue(root, async () => {
        const megabytes = this.megabytes()
        const project = await this.host.book(root)
        if (project === undefined || megabytes <= 0) return
        const { route } = request
        const at = new Date(started).toISOString()
        const id = `${at.replace(/\D/g, '').slice(0, 17)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`
        const index = await this.index(project)
        const parts: string[] = []
        /** A long stretch is kept once for all the calls that send it. */
        const share = async (text: string | undefined): Promise<string | undefined> => {
          if (text === undefined || text.length < SHARED_FROM) return undefined
          const name = createHash('sha256').update(text).digest('hex').slice(0, 24)
          if (index.parts[name] === undefined || !(await project.hasRecord(DIR, PARTS, `${name}.json`))) index.parts[name] = await project.writeRecord([DIR, PARTS, `${name}.json`], { text })
          if (!parts.includes(name)) parts.push(name)
          return name
        }
        const systemPart = await share(request.system)
        const stablePart = await share(request.stable)
        // Which chapter it was for is kept as the chapter's id, however the job named it.
        const chapter = about.ref !== undefined ? (await project.findChapter(about.ref).catch(() => undefined))?.plan.id : undefined
        const temperature = request.temperature ?? route.temperature
        const maxTokens = request.maxTokens ?? route.maxTokens
        const pictures = (request.images ?? []).map((image, at) => image.name ?? `#${at + 1}`)
        const row: CallRow = {
          id,
          at,
          ...(about.kind !== undefined ? { kind: about.kind } : {}),
          ...(about.title !== undefined ? { title: about.title } : {}),
          ...(about.job !== undefined ? { job: about.job } : {}),
          ...(about.step !== undefined ? { step: about.step } : {}),
          ...(chapter !== undefined ? { chapter } : about.ref !== undefined ? { target: about.ref } : {}),
          role: route.for?.role ?? 'writer',
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort !== undefined && route.reasoningEffort.length > 0 ? { effort: route.reasoningEffort } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          sent: (request.system?.length ?? 0) + (request.stable?.length ?? 0) + request.prompt.length,
          got: outcome.reply.length,
          ...(outcome.usage !== undefined ? { input: outcome.usage.inputTokens, output: outcome.usage.outputTokens, ...(outcome.usage.cachedTokens !== undefined ? { cached: outcome.usage.cachedTokens } : {}) } : {}),
          ...(outcome.thought !== undefined && outcome.thought > 0 ? { thought: outcome.thought } : {}),
          ms: Date.now() - started,
          ...(outcome.finish !== undefined ? { finish: outcome.finish } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(outcome.stopped === true ? { stopped: true } : {}),
          ...(pictures.length > 0 ? { images: pictures } : {}),
          bytes: 0,
          ...(parts.length > 0 ? { parts } : {}),
        }
        const { bytes: _bytes, ...head } = row
        const kept: Kept = {
          ...head,
          ...(systemPart !== undefined ? { systemPart } : request.system !== undefined && request.system.length > 0 ? { system: request.system } : {}),
          ...(stablePart !== undefined ? { stablePart } : request.stable !== undefined && request.stable.length > 0 ? { stable: request.stable } : {}),
          prompt: request.prompt,
          reply: outcome.reply,
        }
        row.bytes = await project.writeRecord([DIR, `${id}.json`], kept)
        index.calls.push(row)
        await this.trim(project, index, megabytes * 1024 * 1024)
        await project.writeRecord([DIR, INDEX], index)
      })
    } catch (error) {
      // A call that could not be put on record is still a call that was made: the work goes on.
      this.host.log('could not keep a call on record', error)
    }
  }

  /** Let the oldest calls go until the record fits, and with them the shared parts no call left names. */
  private async trim(project: Project, index: Index, most: number): Promise<void> {
    const uses = new Map<string, number>()
    for (const call of index.calls) for (const part of call.parts ?? []) uses.set(part, (uses.get(part) ?? 0) + 1)
    let total = index.calls.reduce((sum, call) => sum + call.bytes, 0) + [...uses.keys()].reduce((sum, part) => sum + (index.parts[part] ?? 0), 0)
    // (The call just made stays, however large it is: a record that cannot hold one call holds nothing.)
    while (index.calls.length > 1 && (index.calls.length > CALLS_MOST || total > most)) {
      const gone = index.calls.shift()!
      total -= gone.bytes
      for (const part of gone.parts ?? []) {
        const left = (uses.get(part) ?? 1) - 1
        if (left > 0) uses.set(part, left)
        else {
          uses.delete(part)
          total -= index.parts[part] ?? 0
        }
      }
      await project.dropRecord(DIR, `${gone.id}.json`).catch(() => {})
    }
    for (const part of Object.keys(index.parts)) {
      if (uses.has(part)) continue
      delete index.parts[part]
      await project.dropRecord(DIR, PARTS, `${part}.json`).catch(() => {})
    }
  }

  /**
   * The calls on record for a book, the latest first.
   * @param filter.chapter - only the calls made for this chapter (its id).
   * @returns `total` and `bytes` are of the whole record, whatever was asked for.
   */
  async list(project: Project, filter: { chapter?: string; limit?: number } = {}): Promise<{ calls: CallRow[]; total: number; bytes: number }> {
    const index = await this.queue(project.root, async () => await this.index(project))
    const named = new Set(index.calls.flatMap(call => call.parts ?? []))
    const bytes = index.calls.reduce((sum, call) => sum + call.bytes, 0) + [...named].reduce((sum, part) => sum + (index.parts[part] ?? 0), 0)
    let calls = [...index.calls].reverse()
    if (filter.chapter !== undefined) calls = calls.filter(call => call.chapter === filter.chapter)
    if (filter.limit !== undefined && filter.limit > 0) calls = calls.slice(0, Math.round(filter.limit))
    return { calls, total: index.calls.length, bytes }
  }

  /** One call with everything that was sent and said. */
  async read(project: Project, id: string): Promise<CallRecord | undefined> {
    if (!/^[\w-]+$/.test(id)) return undefined
    const kept = await project.readRecord<Kept>(DIR, `${id}.json`)
    if (kept === undefined || kept === null || typeof kept.prompt !== 'string') return undefined
    const part = async (name: string | undefined): Promise<string | undefined> => (name !== undefined ? (await project.readRecord<{ text?: string }>(DIR, PARTS, `${name}.json`))?.text : undefined)
    const { systemPart, stablePart, ...call } = kept
    const system = call.system ?? await part(systemPart)
    const stable = call.stable ?? await part(stablePart)
    const row = (await this.index(project)).calls.find(known => known.id === id)
    return { ...call, ...(system !== undefined ? { system } : {}), ...(stable !== undefined ? { stable } : {}), bytes: row?.bytes ?? 0 }
  }

  /**
   * Take calls off the record for good.
   * @param ids - which; left out, every one of them.
   * @returns how many went.
   */
  async remove(project: Project, ids?: readonly string[]): Promise<number> {
    return await this.queue(project.root, async () => {
      const index = await this.index(project)
      const going = ids === undefined ? undefined : new Set(ids)
      const gone = index.calls.filter(call => going === undefined || going.has(call.id))
      if (gone.length === 0) return 0
      index.calls = index.calls.filter(call => going !== undefined && !going.has(call.id))
      for (const call of gone) await project.dropRecord(DIR, `${call.id}.json`).catch(() => {})
      // (No size to hold it to here: this only lets go of the parts nobody names any more.)
      await this.trim(project, index, Number.POSITIVE_INFINITY)
      await project.writeRecord([DIR, INDEX], index)
      return gone.length
    })
  }

  /** Everything queued for a book's record is on disk (tests; a list asked for right after a call). */
  async settled(root: string): Promise<void> {
    await this.queues.get(root)
  }
}

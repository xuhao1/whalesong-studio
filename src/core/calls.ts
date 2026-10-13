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
 * A role working as an agent makes its requests on the Harness's own loop, a
 * request a step: each is kept here too ({@link CallLog.keepStep}), told by
 * whoever runs the role — the rules, the tools it was offered, what is new
 * with this request, the reply. A step holds only what is new with it and
 * names the step before; what the earlier steps had already sent is read off
 * them, so a run of forty steps is kept once and not forty times over.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { CALLS_MB_DEFAULT, type CallRecord, type CallRow, type JobKind, type ModelRoute, type NovelSettings } from '../shared/types'
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

/**
 * A call as its document holds it: a shared part is named, not repeated — and a step of an agent's run names the
 * step before it (`prev`) in place of repeating what that one and the ones before it sent.
 */
type Kept = Omit<CallRecord, 'bytes'> & { systemPart?: string; stablePart?: string; toolsPart?: string; prev?: string }

/** Said where a step's earlier steps are no longer on record (the oldest calls go first, and calls can be deleted). */
const GONE = '[… the earlier requests of this run are no longer on record: what they had already sent is missing here …]'

interface Scope {
  /** What the work is for: a chapter, or whatever else the step works on. */
  target?: string
  /** What the work is within its job: a step of a batch, the digest that follows a chapter written. */
  step?: string
}

const scopes = new AsyncLocalStorage<Scope>()

/** What the work under way is for, as it was said ({@link callsFor}): taken along by whoever calls back from outside it. */
export function callScope(): Scope | undefined {
  return scopes.getStore()
}

/** One request a role working as an agent made, as whoever runs the role saw it go and come back. */
export interface AgentStep {
  /** The book's root. */
  book: string
  /** The job the run belongs to, and what its work was said to be for when the run began. */
  job?: { id: string; kind: JobKind }
  scope?: Scope
  role: CallRow['role']
  route: ModelRoute
  /** The run: the session it is recorded in, what it is called, and the how-manieth request of it this is (from 1). */
  session: string
  label?: string
  step: number
  startedAt: number
  /** The standing rules it works by, as the model was sent them. */
  system: string
  /** The tools it was offered, said for a reader, and how many there are. */
  tools?: string
  toolCount?: number
  /** What is new with this request, rendered message by message. */
  fresh: string
  /** Characters of everything the request carried, the earlier messages too. */
  sent: number
  reply: string
  usage?: LlmResponse['usage']
  thought?: number
  finish?: string
  error?: string
  stopped?: boolean
  images?: string[]
}

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

  /** The step last kept of each agent's run under way, by its session: what the next step of the run goes on from. */
  private readonly lastOf = new Map<string, string>()

  /**
   * Keep one request of a role working as an agent. Keeping never fails the run; the steps of a run are kept in the
   * order they were made.
   */
  async keepStep(step: AgentStep): Promise<void> {
    if (this.megabytes() <= 0) return
    const info = step.job !== undefined ? this.host.jobs.get(step.job.id) : undefined
    const named = info?.result?.chapterId
    const ref = step.scope?.target ?? (typeof named === 'string' && named.length > 0 ? named : info?.target)
    const about: About = {
      ...(step.job !== undefined ? { kind: step.job.kind, job: step.job.id } : {}),
      ...(info !== undefined ? { title: info.title } : {}),
      ...(step.scope?.step !== undefined ? { step: step.scope.step } : {}),
      ...(ref !== undefined && ref.length > 0 ? { ref } : {}),
    }
    await this.put(step.book, about, step.startedAt, {
      route: step.route,
      role: step.role,
      system: step.system,
      prompt: step.fresh,
      sent: step.sent,
      ...(step.tools !== undefined && step.tools.length > 0 ? { tools: step.tools } : {}),
      ...(step.images !== undefined && step.images.length > 0 ? { images: step.images } : {}),
      agent: { session: step.session, step: step.step, ...(step.label !== undefined ? { label: step.label } : {}), ...(step.toolCount !== undefined ? { tools: step.toolCount } : {}) },
    }, { reply: step.reply, ...(step.finish !== undefined ? { finish: step.finish } : {}), ...(step.usage !== undefined ? { usage: step.usage } : {}), ...(step.thought !== undefined ? { thought: step.thought } : {}), ...(step.error !== undefined ? { error: step.error } : {}), ...(step.stopped === true ? { stopped: true } : {}) })
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
    const temperature = request.temperature ?? request.route.temperature
    const maxTokens = request.maxTokens ?? request.route.maxTokens
    await this.put(root, about, started, {
      route: request.route,
      role: request.route.for?.role ?? 'writer',
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.stable !== undefined ? { stable: request.stable } : {}),
      prompt: request.prompt,
      sent: (request.system?.length ?? 0) + (request.stable?.length ?? 0) + request.prompt.length,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      images: (request.images ?? []).map((image, at) => image.name ?? `#${at + 1}`),
    }, outcome)
  }

  /** Put one call on a book's record: what was sent, part by part, and how it went. */
  private async put(root: string, about: About, started: number, sent: {
    route: ModelRoute
    role: CallRow['role']
    system?: string
    stable?: string
    tools?: string
    prompt: string
    /** Characters of all that was sent. */
    sent: number
    temperature?: number
    maxTokens?: number
    images?: string[]
    agent?: NonNullable<CallRow['agent']>
  }, outcome: Outcome): Promise<void> {
    try {
      await this.queue(root, async () => {
        const megabytes = this.megabytes()
        const project = await this.host.book(root)
        if (project === undefined || megabytes <= 0) return
        const { route } = sent
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
        const systemPart = await share(sent.system)
        const stablePart = await share(sent.stable)
        const toolsPart = await share(sent.tools)
        // Which chapter it was for is kept as the chapter's id, however the job named it.
        const chapter = about.ref !== undefined ? (await project.findChapter(about.ref).catch(() => undefined))?.plan.id : undefined
        const temperature = sent.temperature
        const maxTokens = sent.maxTokens ?? route.maxTokens
        const pictures = sent.images ?? []
        // A step of an agent's run goes on from the step kept before it, where that one is still on record.
        const before = sent.agent !== undefined && sent.agent.step > 1 ? this.lastOf.get(sent.agent.session) : undefined
        const prev = before !== undefined && index.calls.some(call => call.id === before) ? before : undefined
        const row: CallRow = {
          id,
          at,
          ...(about.kind !== undefined ? { kind: about.kind } : {}),
          ...(about.title !== undefined ? { title: about.title } : {}),
          ...(about.job !== undefined ? { job: about.job } : {}),
          ...(about.step !== undefined ? { step: about.step } : {}),
          ...(chapter !== undefined ? { chapter } : about.ref !== undefined ? { target: about.ref } : {}),
          role: sent.role,
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort !== undefined && route.reasoningEffort.length > 0 ? { effort: route.reasoningEffort } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          sent: sent.sent,
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
          ...(sent.agent !== undefined ? { agent: sent.agent } : {}),
        }
        const { bytes: _bytes, ...head } = row
        const kept: Kept = {
          ...head,
          ...(systemPart !== undefined ? { systemPart } : sent.system !== undefined && sent.system.length > 0 ? { system: sent.system } : {}),
          ...(stablePart !== undefined ? { stablePart } : sent.stable !== undefined && sent.stable.length > 0 ? { stable: sent.stable } : {}),
          ...(toolsPart !== undefined ? { toolsPart } : sent.tools !== undefined && sent.tools.length > 0 ? { tools: sent.tools } : {}),
          ...(prev !== undefined ? { prev } : {}),
          prompt: sent.prompt,
          reply: outcome.reply,
        }
        row.bytes = await project.writeRecord([DIR, `${id}.json`], kept)
        index.calls.push(row)
        if (sent.agent !== undefined) {
          this.lastOf.set(sent.agent.session, id)
          // (A run's last step is forgotten with the oldest of them: the map holds the runs under way, not every run there ever was.)
          if (this.lastOf.size > 400) this.lastOf.delete(this.lastOf.keys().next().value as string)
        }
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
   * @param filter.job - only the calls made in this job (its id).
   * @returns `total` and `bytes` are of the whole record, whatever was asked for.
   */
  async list(project: Project, filter: { chapter?: string; job?: string; limit?: number } = {}): Promise<{ calls: CallRow[]; total: number; bytes: number }> {
    const index = await this.queue(project.root, async () => await this.index(project))
    const named = new Set(index.calls.flatMap(call => call.parts ?? []))
    const bytes = index.calls.reduce((sum, call) => sum + call.bytes, 0) + [...named].reduce((sum, part) => sum + (index.parts[part] ?? 0), 0)
    let calls = [...index.calls].reverse()
    if (filter.chapter !== undefined) calls = calls.filter(call => call.chapter === filter.chapter)
    if (filter.job !== undefined) calls = calls.filter(call => call.job === filter.job)
    if (filter.limit !== undefined && filter.limit > 0) calls = calls.slice(0, Math.round(filter.limit))
    return { calls, total: index.calls.length, bytes }
  }

  /** One call with everything that was sent and said. */
  async read(project: Project, id: string): Promise<CallRecord | undefined> {
    if (!/^[\w-]+$/.test(id)) return undefined
    const kept = await project.readRecord<Kept>(DIR, `${id}.json`)
    if (kept === undefined || kept === null || typeof kept.prompt !== 'string') return undefined
    const part = async (name: string | undefined): Promise<string | undefined> => (name !== undefined ? (await project.readRecord<{ text?: string }>(DIR, PARTS, `${name}.json`))?.text : undefined)
    const { systemPart, stablePart, toolsPart, prev, ...call } = kept
    const system = call.system ?? await part(systemPart)
    const tools = call.tools ?? await part(toolsPart)
    let stable = call.stable ?? await part(stablePart)
    // A step of an agent's run: what its earlier steps had already sent, read off them in the order they went.
    if (call.agent !== undefined && call.agent.step > 1) {
      const earlier: string[] = []
      let at = prev
      for (let left = call.agent.step - 1; left > 0; left--) {
        const before = at !== undefined && /^[\w-]+$/.test(at) ? await project.readRecord<Kept>(DIR, `${at}.json`).catch(() => undefined) : undefined
        if (before === undefined || before === null || typeof before.prompt !== 'string') {
          earlier.unshift(GONE)
          break
        }
        earlier.unshift(before.prompt)
        at = before.prev
      }
      stable = earlier.join('\n\n')
    }
    const row = (await this.index(project)).calls.find(known => known.id === id)
    return { ...call, ...(system !== undefined ? { system } : {}), ...(tools !== undefined ? { tools } : {}), ...(stable !== undefined && stable.length > 0 ? { stable } : {}), bytes: row?.bytes ?? 0 }
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

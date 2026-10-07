// SPDX-License-Identifier: LGPL-3.0-or-later
/** Plumbing shared by the model-facing tools. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type InferArgs, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { NovelCore, ProjectRuntime, TaskContext } from '../../core/core'
import type { JobContext } from '../../core/jobs'
import { LlmCallError } from '../../core/llm'
import { ProviderError } from '../../core/media/http'
import { ProjectError } from '../../core/project'
import { displayPath } from '../../core/util/fs'
import type { NovelService } from '../../host/service'
import type { JobKind } from '../../shared/types'

/** JSON a tool may return (the Harness requires lossless JSON). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface ToolEnv {
  service: NovelService
  core: NovelCore
  agent: Agent
  signal: AbortSignal
  /** Session workspace directory. */
  workspace: string
  /** The book this call named, when it named one other than the book in play. */
  book?: string
  /** The book this call acts on — the one it named, else the book in play; throws with guidance when there is none. */
  project(): Promise<ProjectRuntime>
  /** Move the session, and the Studio beside it, onto a book. */
  switchTo(runtime: ProjectRuntime): Promise<void>
  /** Task context for direct pipeline calls. */
  task: TaskContext
  /** Run a pipeline as a job the Studio can watch, and wait for it. */
  job<T>(kind: JobKind, title: string, target: string | undefined, run: (task: TaskContext, job: JobContext) => Promise<T>): Promise<T>
  /** Project-relative display path. */
  where(runtime: ProjectRuntime): string
}

export interface ToolOutcome {
  /** What the model reads. */
  text: string
  /** Structured result for programmatic callers (PTC mode). */
  data?: Json
}

export interface NovelToolSpec<S extends ParameterSchemaSpec> {
  name: string
  description: string
  parameters: S
  /** Changes project files or spends on media: asks first in a read-only session. */
  mutating?: boolean | ((args: InferArgs<S>) => boolean)
  /**
   * How the tool treats books other than the one in play. By default it takes an
   * optional `book` and acts on that one for this call only, leaving the session
   * where it is. `false`: the tool is about the session, not about a book.
   * `'switch'`: naming a book moves the session, and the Studio, onto it.
   */
  book?: false | 'switch'
  run(args: InferArgs<S>, env: ToolEnv): Promise<ToolOutcome>
}

const BOOK_PARAMETER = {
  type: 'string',
  description: 'Another book to act on for this call only: its title or its path. Leave it out for the book in play. It does not move the session — novel_status with `project` does that.',
} as const

const SWITCH_PARAMETER = {
  type: 'string',
  description: 'A book to move this session and the Studio onto first: its title or its path. Leave it out to stay on the book in play.',
} as const


/** Names of tools that write, with their per-call test; consulted by the read-only gate. */
export const MUTATING = new Map<string, (args: unknown) => boolean>()

/** Errors whose message is written for the model; everything else is an unexpected failure. */
function isExpected(error: unknown): boolean {
  return error instanceof ProjectError || error instanceof ProviderError || error instanceof LlmCallError
}

export function novelTool<const S extends ParameterSchemaSpec>(service: NovelService, spec: NovelToolSpec<S>): ToolDefinition {
  if (spec.mutating !== undefined && spec.mutating !== false) {
    const test = spec.mutating
    MUTATING.set(spec.name, typeof test === 'function' ? (args => test(args as InferArgs<S>)) : () => true)
  }
  const parameters = (spec.book === false ? spec.parameters : { ...spec.parameters, book: spec.book === 'switch' ? SWITCH_PARAMETER : BOOK_PARAMETER }) as S
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string', required: true, description: 'Human-readable result.' },
          data: { type: 'json', description: 'Structured result.' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    // Model work can take minutes; overlapping calls on one manuscript would interleave writes.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new ProjectError('novel/invalid', `${spec.name} needs a calling agent`)
      const core = service.core
      const workspace = service.workspaceOfAgent(agent)
      const task = service.agentTask(agent, exec.signal)
      const raw = spec.book === false ? undefined : (args as { book?: unknown }).book
      const named = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined
      const switchTo = async (runtime: ProjectRuntime): Promise<void> => { await service.bind(agent.id, { project: runtime.project.root }, 'agent') }
      // The book the call ended up acting on, so its result can say so.
      let used: ProjectRuntime | undefined
      const book = spec.book === 'switch' ? undefined : named
      const project = async (): Promise<ProjectRuntime> => (used = await service.requireProject(agent, book))
      const env: ToolEnv = {
        service,
        core,
        agent,
        signal: exec.signal,
        workspace,
        ...(book !== undefined ? { book } : {}),
        project,
        switchTo,
        task,
        job: async (kind, title, target, run) => {
          const runtime = await project()
          const started = core.jobs.start({ kind, title, project: runtime.project.root, origin: 'agent', signal: exec.signal, ...(target !== undefined ? { target } : {}) }, async job => await run({ ...task, signal: job.signal, job }, job))
          return await started.done
        },
        where: runtime => displayPath(workspace, runtime.project.root),
      }
      try {
        if (named !== undefined && spec.book === 'switch') await switchTo(await service.resolveBook(named, workspace))
        const outcome = await spec.run(args as InferArgs<S>, env)
        // In a conversation that has been on more than one book, every result says which book it is about.
        const several = (service.sessions.peek(agent.id)?.books?.length ?? 0) > 1
        const label = used !== undefined && (book !== undefined || several) ? `[Book: "${(await used.project.manifest()).title}" — ${displayPath(workspace, used.project.root)}]\n` : ''
        return { text: `${label}${outcome.text}`, ...(outcome.data !== undefined ? { data: outcome.data } : {}) } as never
      } catch (error) {
        // The message of an expected failure already tells the model what to do next.
        if (isExpected(error)) throw new Error(error instanceof Error ? error.message : String(error))
        throw error
      }
    },
  })
}

/**
 * A parameter that takes a list of strings. Models now and then send one string
 * where a list is asked for — comma-separated, or a JSON array inside quotes —
 * and a call refused for that is a wasted turn, so both forms are accepted.
 */
export function listParameter<const E extends readonly string[] | undefined = undefined>(description: string, options: { enum?: E } = {}) {
  return {
    description: `${description} A list of strings; one comma-separated string works too.`,
    oneOf: [
      { type: 'array', items: { type: 'string', ...(options.enum !== undefined ? { enum: options.enum as readonly string[] } : {}) } },
      { type: 'string' },
    ],
  } as const
}

/** The items of a list parameter, however the model wrote it; `undefined` when it was left out. */
export function listOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const clean = (items: unknown[]): string[] => items.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item.length > 0)
  if (Array.isArray(value)) return clean(value)
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) return clean(parsed)
    } catch {
      // not JSON after all: a plain list that happens to start with a bracket
    }
  }
  return clean(text.split(/[,，;；、\n]+/))
}

/** Trim a possibly long field for a tool result. */
export function brief(text: string | undefined, max = 200): string {
  if (text === undefined) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Make an arbitrary value safe to return as tool data. */
export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

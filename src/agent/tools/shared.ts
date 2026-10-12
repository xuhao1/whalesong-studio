// SPDX-License-Identifier: LGPL-3.0-or-later
/** Plumbing shared by the model-facing tools. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { changedBy } from '../../core/cause'
import { defineTool, type InferArgs, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { NovelCore, ProjectRuntime, TaskContext } from '../../core/core'
import type { JobContext } from '../../core/jobs'
import { LlmCallError } from '../../core/llm'
import { ProviderError } from '../../core/media/http'
import { ProjectError } from '../../core/project'
import { displayPath } from '../../core/util/fs'
import type { NovelService } from '../../host/service'
import type { FiguresKept, JobKind, MaterialUsed, PicturesRead, ReferencesLooked } from '../../shared/types'

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
  /**
   * Pictures the model is to see with the result, as the blocks DSH carries them in (`NovelService.pictureBlocks`):
   * they follow the text, in this order.
   */
  images?: readonly { type: 'image'; attachment: unknown }[]
  /**
   * How the change reads on the book's record, when the tool can say it better
   * than the first line of its result — and, for a manuscript edit, the
   * version that undoes it. `false` keeps the call off the record.
   */
  record?: { summary?: string | [zh: string, en: string]; chapter?: string; version?: string } | false
}

/** What each tool is to the author, for the book's record. */
const RECORD_LABELS: Record<string, [string, string]> = {
  novel_init: ['创建了这本书', 'Created the book'],
  novel_bible: ['改了设定', 'Changed the bible'],
  novel_outline: ['调整了大纲', 'Changed the outline'],
  novel_reference: ['动了参考文献', 'Changed the references'],
  novel_jot: ['记了随笔', 'Kept a jotting'],
  novel_derive: ['让策划推演', 'Had the planner derive'],
  novel_write: ['让写手写作', 'Had the writer draft'],
  novel_revise: ['让写手修订', 'Had the writer revise'],
  novel_edit: ['亲手改了正文', 'Edited the text by hand'],
  novel_memory: ['修正了记忆', 'Corrected the memory'],
  novel_digest: ['收录了记忆', 'Digested memory'],
  novel_review: ['做了审校', 'Reviewed'],
  novel_import: ['导入了稿件', 'Imported a manuscript'],
  novel_illustrate: ['画了图', 'Drew a picture'],
  novel_audio: ['做了有声版的工作', 'Worked on the audio version'],
  novel_comic: ['做了有声漫的工作', 'Worked on the motion comic'],
  novel_video: ['让后期剪了视频', 'Had post-production cut a video'],
  novel_batch: ['做了一次批量任务', 'Ran a batch'],
  novel_play: ['进行了幕间', 'Ran an interlude'],
  novel_settings: ['改了作品信息', 'Changed the book\'s details'],
  novel_manage: ['做了一处手动调整', 'Made a hand edit'],
  novel_share: ['改了在其他设备上阅读的开关', 'Changed reading on other devices'],
  novel_export: ['导出了全书', 'Exported the book'],
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
          images: { type: 'json', description: 'Pictures handed back with the result.' },
        },
        additionalProperties: false,
      },
      // Text first; pictures a tool hands back ride beside it as image blocks — the way DSH's own read_image does.
      render: (_args, value) => {
        const outcome = value as { text: string; images?: unknown }
        const pictures = Array.isArray(outcome.images) ? outcome.images.filter((item): item is { attachment: unknown } => typeof item === 'object' && item !== null && 'attachment' in item) : []
        return [{ type: 'text', text: outcome.text }, ...pictures.map(item => ({ type: 'image', attachment: item.attachment }))] as never
      },
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
      const project = async (): Promise<ProjectRuntime> => {
        used = await service.requireProject(agent, book)
        // What the tool reads or writes of the book ends up in this conversation's log: noted, so a book that is sealed takes the conversation under its seal.
        void service.sessionBooks.touch(agent.id, used.project.root).catch(() => {})
        return used
      }
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
        // What the showrunner's tool changes is on record as its doing, where a version of a card or a plan is kept.
        const outcome = await changedBy('agent', async () => await spec.run(args as InferArgs<S>, env))
        // Whatever changed the book goes on its record, where the author reads what the showrunner did.
        if (used !== undefined && outcome.record !== false && MUTATING.get(spec.name)?.(args) === true) {
          const how = (args as { action?: unknown; scope?: unknown; kind?: unknown; chapter?: unknown; target?: unknown; ref?: unknown })
          const action = [how.action, how.scope, how.kind].find((value): value is string => typeof value === 'string')
          // On the record in the book's own language: it is the author who reads it.
          const zh = (await used.project.manifest().catch(() => undefined))?.language.toLowerCase().startsWith('zh') === true
          const given = outcome.record?.summary
          const about = [how.chapter, how.target, how.ref].find((value): value is string => typeof value === 'string' && value.trim().length > 0)
          const label = RECORD_LABELS[spec.name]
          const summary = given !== undefined
            ? typeof given === 'string' ? given : given[zh ? 0 : 1]
            : label !== undefined ? `${label[zh ? 0 : 1]}${action !== undefined ? `${zh ? '（' : ' ('}${action}${zh ? '）' : ')'}` : ''}${about !== undefined ? `${zh ? '：' : ': '}${about}` : ''}` : outcome.text.split('\n').find(line => line.trim().length > 0) ?? spec.name
          await used.project.addActivity({
            by: 'agent',
            tool: spec.name,
            ...(action !== undefined ? { action } : {}),
            summary,
            ...(outcome.record?.chapter !== undefined ? { chapter: outcome.record.chapter } : {}),
            ...(outcome.record?.version !== undefined ? { version: outcome.record.version } : {}),
          }).catch((error: unknown) => { service.log('could not put a change on the book\'s record', error) })
        }
        // In a conversation that has been on more than one book, every result says which book it is about.
        const several = (service.sessions.peek(agent.id)?.books?.length ?? 0) > 1
        const label = used !== undefined && (book !== undefined || several) ? `[Book: "${(await used.project.manifest()).title}" — ${displayPath(workspace, used.project.root)}]\n` : ''
        return { text: `${label}${outcome.text}`, ...(outcome.data !== undefined ? { data: outcome.data } : {}), ...(outcome.images !== undefined && outcome.images.length > 0 ? { images: outcome.images } : {}) } as never
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
/**
 * How the pictures given to a piece of work were read, as a line of a tool's answer — with what to tell the author
 * where the model that did the work does not say whether it takes pictures.
 * @param who - the one whose work it was: `writer`, `planner`.
 */
export function picturesSaid(read: PicturesRead | undefined, who: string): string | undefined {
  if (read === undefined) return undefined
  if (read.by === 'titles') return `Pictures: ${read.count} given — the ${who}'s model takes no pictures and no model is set up to look at them, so it went by what each picture is called only (its record in the book, what the author said of it)${read.untitled !== undefined && read.untitled > 0 ? `; ${read.untitled} of them had neither, and counted for nothing` : ''}: tell the author, and that a model to look at pictures can be set (novel_settings: vision) to have them read.`
  return `Pictures: ${read.count} given — ${read.by === 'vision' ? `put into words for the ${who} by ${read.model ?? 'the picture model'}` : read.unsure === true ? `sent to the ${who}'s model, which does not say whether it takes pictures: tell the author, and that a model to look at pictures can be set (novel_settings: vision)` : `looked at by the ${who}'s own model`}.`
}

/**
 * What was done for the pictures in a chapter's text when the text was written anew, as a line of a tool's answer.
 * @param how - `revised`: a model rewrote text that had them; `drafted`: a chapter drafted over from nothing;
 * `put`: text the showrunner put in the place of text.
 */
export function figuresSaid(figures: FiguresKept | undefined, how: 'revised' | 'drafted' | 'put' = 'revised'): string | undefined {
  if (figures === undefined || (figures.back <= 0 && figures.made <= 0)) return undefined
  const back = figures.back <= 0 ? undefined : how === 'drafted'
    ? `the ${figures.back} picture(s) the chapter had in its text are in the new draft — placed by the lines most like the ones they stood by, else as far down as they stood; the author can move them (the Pictures column beside the text)`
    : how === 'put'
      ? `the text you put in did not have ${figures.back} picture line(s) that stood there: they were put back where they stood (a picture is taken out with action=delete on its own line, and only when the author asks)`
      : `the writer left out ${figures.back} picture line(s) of the text: they were put back where they stood`
  const made = figures.made <= 0 ? undefined : `${figures.made} picture line(s) naming no picture of the book were taken out`
  return `Pictures in the text: ${[back, made].filter(part => part !== undefined).join('; ')}.`
}

/**
 * What the writer was handed for a piece of writing and who put it together, for the showrunner to pass on. Nothing,
 * where nobody was asked to write.
 */
export function materialSaid(material: MaterialUsed | undefined): string | undefined {
  if (material === undefined) return undefined
  // Meant for the writer as an agent, and written the other way when that came to nothing.
  const instead = material.instead !== undefined ? ` (The writer was to write this as an agent and it came to nothing — ${material.instead} — so it was written in one request instead. Tell the author.)` : ''
  if (material.by === 'agent') {
    return `Written by the writer as an agent: nobody prepared its material — it read in the book for itself${material.steps !== undefined ? ` (${material.steps} tool calls)` : ''}, handed the text in${material.drafts !== undefined && material.drafts > 1 ? ` ${material.drafts} times over` : ''}${material.edits !== undefined && material.edits > 0 ? ` and changed ${material.edits} place(s) of it before calling it done` : ''}. It was given ~${material.tokens} tokens to start from (the plan, what it was planned with, where the chapter joins).${material.note !== undefined ? ` Its own word: ${material.note}` : ''}`
  }
  if (material.by === 'rules') {
    if (instead.length > 0) return `Material: packed by the Studio's standing rules (~${material.tokens} tokens).${instead}`
    return material.why !== undefined
      ? `Material: packed by the Studio's standing rules (~${material.tokens} tokens) — the planner was to prepare it and could not: ${material.why}. Tell the author.`
      : `Material: packed by the Studio's standing rules (~${material.tokens} tokens).`
  }
  const went = [
    material.chapters !== undefined && material.chapters.length > 0 ? `chapter(s) ${material.chapters.join(', ')} word for word` : undefined,
    material.summaries !== undefined ? `${material.summaries} chapter(s) in outline` : undefined,
    material.excerpts !== undefined ? `${material.excerpts} passage(s) of earlier text` : undefined,
    material.people !== undefined ? `the cards of ${material.people.join(', ')}` : undefined,
    material.world !== undefined ? `of the world: ${material.world.join(', ')}` : undefined,
    material.threads !== undefined ? `threads: ${material.threads.join(', ')}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return `Material: prepared for this piece by the planner (${material.how === 'agent' ? `as an agent${material.steps !== undefined ? `, ${material.steps} tool calls` : ''}` : 'in one request, choosing from the book\'s lists without reading in it'}), ~${material.tokens} tokens — ${went.length > 0 ? went.join('; ') : 'its own account of where the story stands, and nothing of the book word for word'}.${material.note !== undefined ? ` The planner: ${material.note}` : ''} The author can read all of it on the writing page (the line under the brief box).${instead}`
}

/**
 * What a role read in the book's references for a piece of work that was to look in them first, for the showrunner to
 * pass on. Nothing, where the work was not of that kind.
 * @param who - the one whose work it was: `planner`, `reviewer`.
 */
export function referencesSaid(looked: ReferencesLooked | undefined, who: string): string | undefined {
  if (looked === undefined) return undefined
  if (looked.cannot !== undefined) return `References: NOT looked at — ${looked.cannot} Tell the author (the ${who} reads in them only when it works as an agent: Settings → Models).`
  if (looked.calls === 0) return `References: the ${who} was to look in them first and did not read anything in them. Tell the author.`
  return `References: the ${who} looked in them first (${looked.calls} read${looked.calls === 1 ? '' : 's'}): ${looked.read.join('; ')}.`
}

export function brief(text: string | undefined, max = 200): string {
  if (text === undefined) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Make an arbitrary value safe to return as tool data. */
export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

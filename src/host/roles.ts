// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The crew as agents of the Harness.
 *
 * A role's run is a subagent: it is started through `ctx.subagents` under the
 * conversation that asked for the work, by a provider this plugin registers
 * there. What the Harness does for every child it then does for a role — the
 * child joins its parent's composition (so the author's own tools, skills and
 * instructions are within reach of it), takes its parent's permissions with
 * approval pinned to "never", counts against the delegation depth, is entered
 * in the parent's catalog of children and can be opened from the parent's
 * header, every step of it on record. What the provider adds is what makes it
 * *this* role: its persona and standing rules, the tools the Studio gives it,
 * its skills, and which of the conversation's other tools it may see.
 *
 * Work that no conversation asked for — a button in the Studio's own page — has
 * no parent to hang from; it runs on the same loop as an agent of its own.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-skill'
import {
  appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides, childSessionMeta, resolveChildAgentOptions, resolveChildDepth,
  type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentResult, type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-approval'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { callScope, type AgentStep } from '../core/calls'
import { currentJob, type JobContext } from '../core/jobs'
import { LlmCallError } from '../core/llm'
import { PROJECT_CONTEXT, SHOWRUNNER_SECTION, type RoleOutcome, type RoleRunner, type RoleTask } from '../core/roles'
import type { ModelRoute } from '../shared/types'
import { imageBlocks, type ImageBlock } from './pictures'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** What the Studio tells an agent of its own while it works. */
    'novel-studio': { kind: 'novel-studio' } & ContextFormed
  }
}

/** The shares of its budget at which a run is told how much is left. */
const BUDGET_MARKS = [0.5, 0.75, 0.9]

/** The name the crew's provider goes by on `ctx.subagents`. */
export const CREW_PROVIDER = 'novel-crew'
/** The preset a run without a parent composes itself from, to have the tools a conversation would give it. */
export const CREW_PRESET = 'novelist'

/** Tool calls a role may make before it is told to finish. */
const DEFAULT_STEPS = 40
/** Calls of closing tools still answered once the budget is spent. */
const CLOSING_STEPS = 6
/** Times an agent that stopped without handing in its work is told so. */
const NUDGES = 2

/** Freeze a value all the way down, the way the Harness publishes messages. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) frozen(item)
    Object.freeze(value)
  }
  return value
}

export interface RoleUsage {
  route: ModelRoute
  inputTokens: number
  outputTokens: number
  /** How much of the input the provider read from its cache. */
  cachedTokens?: number
}

/** One run, from the moment it is asked for to the moment it is read. */
interface Staged {
  task: RoleTask
  /** The job this run belongs to: the loop calls back from its own chain of calls, where the job is no longer in sight. */
  job: JobContext | undefined
  limit: number
  steps: number
  said: string
  last: string
  cancelled: boolean
  /** The task's pictures, as DSH carries them in a message. */
  pictures: ImageBlock[]
  child?: Agent
  /** What the work was said to be for when the run was asked for (a step of a batch, a chapter): the record of its requests is filed under it. */
  scope: ReturnType<typeof callScope>
  /** Requests made so far, and the messages they have sent — by id: what a later request carries beyond them is what is new with it. */
  requests: number
  sent: Set<string>
  /** The request under way: what it sent, and what has come back so far. */
  asking?: Asking
}

/** One request of a run, from the moment it goes out. */
interface Asking {
  at: number
  ids: string[]
  system: string
  tools?: string
  toolCount: number
  fresh: string
  chars: number
  thought: number
  text: string
  calls: Map<number, { name: string; args: string }>
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number }
  finish?: string
}

/** A message as the model is sent it, for a reader: who speaks, and what — a tool asked for by its name and what it was given, a tool's answer under the tool's name. */
function rendered(message: { role: string; content: readonly unknown[]; toolCallId?: unknown; isError?: boolean }, names: Map<string, string>): string {
  const said: string[] = []
  for (const raw of message.content) {
    const block = raw as { type?: string; text?: string; id?: unknown; name?: string; arguments?: string; toolName?: string }
    if (block.type === 'text') said.push(block.text ?? '')
    else if (block.type === 'tool-call') {
      if (typeof block.id === 'string' && block.name !== undefined) names.set(block.id, block.name)
      said.push(`→ ${block.name ?? 'tool'} ${block.arguments ?? ''}`.trimEnd())
    } else if (block.type === 'image') said.push('[image]')
    else if (block.type === 'reasoning') continue
    else if (block.type === 'tool-addition' || block.type === 'tool-removal') said.push(`[${block.type}: ${block.toolName ?? ''}]`)
    else said.push(`[${block.type ?? 'block'}]`)
  }
  const tool = message.role === 'tool' ? names.get(typeof message.toolCallId === 'string' ? message.toolCallId : '') : undefined
  const who = message.role === 'tool' ? `[tool result${tool !== undefined ? `: ${tool}` : ''}${message.isError === true ? ' — failed' : ''}]` : `[${message.role}]`
  return `${who}\n${said.join('\n').trim()}`
}

/** The tools a request offers, for a reader: each by its name, what it is for, and what it takes. */
function toolsSaid(tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[]): string {
  return tools.map(tool => `## ${tool.name}\n${tool.description.trim()}\n${JSON.stringify(tool.parameters)}`).join('\n\n')
}

function textOf(content: readonly unknown[]): string {
  return content.map(block => (block as { type?: string; text?: string }).type === 'text' ? (block as { text?: string }).text ?? '' : '').join('').trim()
}

export interface CrewRunner extends RoleRunner {
  /** The provider to register on `ctx.subagents`. */
  provider: SubagentProvider
  /** Ids of the sessions that are role runs right now; the agent-plane half leaves them to their own prompt. */
  isRole(sessionId: string): boolean
}

export function createRoleRunner(ctx: Context, options: {
  log: (message: string, error?: unknown) => void
  onUsage?: (usage: RoleUsage) => void
  /** A role's run got a session of its own: which one, for which book, and under which conversation. */
  onRun?: (run: { session: string; book?: string; parent?: string }) => void
  /** One request of a role's run went out and came back: what it sent, and what was said — for the book's record of calls. */
  onStep?: (step: AgentStep) => void
}): CrewRunner {
  const can = (route: ModelRoute): boolean => route.baseURL === undefined && route.provider.length > 0 && route.model.length > 0 && ctx.get('agents') !== undefined
  /** Runs being started, by the signal each start was given: how a task reaches the provider through the Harness's own request. */
  const staged = new WeakMap<AbortSignal, Staged>()
  const live = new Set<string>()

  /** Everything that makes a child this role: called inside the creation window, before anything can see the agent. */
  const compose = (scope: Context, child: Agent, run: Staged): void => {
    const { task } = run
    run.child = child
    live.add(child.id)
    scope.effect(() => () => { live.delete(child.id) }, 'novel: role agent')

    // ── which of the conversation's tools it sees ──
    const inherited = scope.tools.schemas(child as never).map(schema => schema.name)
    const inherit = task.inherit ?? { mode: 'none' as const }
    if (inherit.mode === 'none') {
      if (inherited.length > 0) scope.tools.restrict({ allow: [] })
    } else if (inherit.mode === 'named') {
      const names = new Set(inherit.names)
      scope.tools.restrict({ allow: inherited.filter(name => names.has(name)) })
    } else {
      const except = inherit.except
      const deny = except !== undefined ? inherited.filter(name => except(name)) : []
      if (deny.length > 0) scope.tools.restrict({ deny })
    }

    // ── who it is ──
    scope.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: task.persona,
      interpolate: false,
    })
    // The showrunner's standing instructions and its digest of the book are the showrunner's: a role has its own in their place.
    scope.systemPrompt.section({ name: SHOWRUNNER_SECTION, order: 100, text: task.rules ?? '', interpolate: false })
    scope.systemPrompt.context({ name: PROJECT_CONTEXT, order: 200, text: '' })

    // ── its skills ──
    const skills = scope.get('skills')
    if (skills !== undefined) {
      for (const skill of task.skills ?? []) {
        try {
          skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'runtime', ...(skill.base !== undefined ? { resourceBase: { kind: 'directory' as const, path: skill.base } } : {}) })
        } catch (error) {
          options.log(`could not give the ${task.role} agent the skill "${skill.name}"`, error)
        }
      }
    }

    // ── its own tools ──
    const closing = task.tools.filter(tool => tool.closing === true).map(tool => tool.name)
    const own = new Set(task.tools.map(tool => tool.name))
    for (const tool of task.tools) {
      scope.tools.register(defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as ParameterSchemaSpec,
        output: {
          schema: { type: 'object', properties: { text: { type: 'string', required: true } }, additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
        },
        // The tools of one run work on one piece of work; their order is the order the model gave.
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const given = args as Record<string, unknown>
          // The task of the moment: an agent kept and gone on with (`resume`) works for another task than it began with,
          // whose tool of the same name is the one that answers now.
          const now = run.task.tools.find(candidate => candidate.name === tool.name) ?? tool
          try {
            const text = await now.run(given)
            run.task.onStep?.({ tool: tool.name, args: given, ok: true, result: text })
            if (tool.final === true) exec.concludeTurn()
            return { text } as never
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            run.task.onStep?.({ tool: tool.name, args: given, ok: false, result: message })
            // Thrown plainly: the loop hands the message to the model as the tool's failure.
            throw new Error(message)
          }
        },
      }))
    }

    // ── its budget: every tool call counts, whoever the tool belongs to ──
    scope.on('tools/pre-execute', async (exec, next) => {
      run.steps += 1
      // Past the budget only the closing tools answer, and only for a few calls: a model that cannot bring itself to close is stopped.
      if (run.steps > run.limit + CLOSING_STEPS) {
        run.cancelled = true
        child.cancel({ kind: 'parent' } as never)
        return { kind: 'deny', reason: 'the run was stopped: it did not close its work' }
      }
      if (run.steps > run.limit && !closing.includes(exec.name)) {
        return { kind: 'deny', reason: `you have used the ${run.limit} tool calls this task allows — close the work now with what you have (${closing.join(', ') || 'your answer'})` }
      }
      return await next()
    })
    // ── how far into its budget it is ──
    // Told in good time, a model wraps up; told at the end, it has nothing left to wrap up with. And told beside
    // whatever tool it just used: a role that works with the conversation's tools — post-production lives in a
    // shell — never reads a note that rides on the role's own tools only.
    let noted = -1
    scope.on('tools/post-execute', async (_exec, _result, next) => {
      const decision = await next()
      let due = -1
      for (let index = 0; index < BUDGET_MARKS.length; index++) if (run.steps >= Math.ceil(run.limit * BUDGET_MARKS[index]!)) due = index
      // (A run gone on with counts its steps from nothing again: so do the marks.)
      if (due < noted) noted = due
      if (due <= noted || run.steps > run.limit) return decision
      noted = due
      const left = run.limit - run.steps
      let own: string | undefined
      try {
        own = run.task.budgetNote?.({ used: run.steps, limit: run.limit, left })
      } catch (error) {
        options.log(`could not ask the ${task.role} task what it still owes`, error)
      }
      const note = createUserMessage({
        content: [{ type: 'text', text: `[Novel Studio] ${run.steps} of the ${run.limit} tool calls this task allows are used; ${left} are left. When they are gone only ${closing.join(', ') || 'your answer'} still works — so whatever is to be handed in has to exist before then.${own !== undefined && own.length > 0 ? `\n${own}` : ''}` }],
        source: { kind: 'novel-studio', form: 'notice', summary: `${run.steps}/${run.limit} tool calls used` },
      })
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), note] }
    })
    // What the conversation's own tools answered is part of the run's account too.
    scope.on('tools/result', (exec, result) => {
      if (own.has(exec.name)) return undefined
      try {
        const text = textOf(result.content)
        run.task.onStep?.({ tool: exec.name, args: (exec.arguments ?? {}) as Record<string, unknown>, ok: !result.isError, result: text.length > 0 ? text : result.isError ? 'failed' : 'done' })
      } catch (error) {
        options.log(`could not report a step of the ${task.role} agent`, error)
      }
      return undefined
    })

    // Tool calls the model asked for, by their ids: a tool's answer is said under the tool's name.
    const called = new Map<string, string>()
    /** What the request going out carries, as the session has it at this moment — nothing of it is the model's answer yet. */
    const asked = (): Asking | undefined => {
      const book = run.task.route.for?.book
      if (options.onStep === undefined || book === undefined) return undefined
      try {
        const messages = child.session.deriveMessages() as unknown as { id: string; role: string; content: readonly unknown[]; toolCallId?: unknown; isError?: boolean }[]
        const header = child.session.requestHeader()
        const system: string[] = []
        const fresh: string[] = []
        let chars = 0
        for (const message of messages) {
          const text = rendered(message, called)
          chars += text.length
          if (message.role === 'system') system.push(textOf(message.content))
          else if (!run.sent.has(message.id)) fresh.push(text)
        }
        const tools = header?.tools ?? []
        const said = tools.length > 0 ? toolsSaid(tools) : undefined
        return { at: Date.now(), ids: messages.map(message => message.id), system: system.join('\n\n'), ...(said !== undefined ? { tools: said } : {}), toolCount: tools.length, fresh: fresh.join('\n\n'), chars: chars + (said?.length ?? 0), thought: 0, text: '', calls: new Map() }
      } catch (error) {
        options.log(`could not read what the ${task.role} agent is sending`, error)
        return undefined
      }
    }
    /** The request is over: it goes on the record with what came back. */
    const answered = (asking: Asking, committed: boolean): void => {
      const book = run.task.route.for?.book
      if (options.onStep === undefined || book === undefined) return
      run.requests += 1
      for (const id of asking.ids) run.sent.add(id)
      const tools = [...asking.calls.values()].map(call => `→ ${call.name} ${call.args}`.trimEnd())
      const reply = [asking.text.trim(), ...tools].filter(part => part.length > 0).join('\n')
      try {
        options.onStep({
          book,
          ...(run.job !== undefined ? { job: { id: run.job.id, kind: run.job.kind } } : {}),
          ...(run.scope !== undefined ? { scope: run.scope } : {}),
          role: (run.task.route.for?.role ?? run.task.role) as AgentStep['role'],
          route: run.task.route,
          session: child.id,
          label: run.task.label,
          step: run.requests,
          startedAt: asking.at,
          system: asking.system,
          ...(asking.tools !== undefined ? { tools: asking.tools, toolCount: asking.toolCount } : {}),
          fresh: asking.fresh,
          sent: asking.chars,
          reply,
          ...(asking.usage !== undefined ? { usage: asking.usage } : {}),
          ...(asking.thought > 0 ? { thought: asking.thought } : {}),
          ...(asking.finish !== undefined ? { finish: asking.finish } : {}),
          ...(committed ? {} : run.cancelled ? { error: 'stopped', stopped: true } : { error: 'the request did not come back' }),
          ...(run.requests === 1 && run.pictures.length > 0 ? { images: run.pictures.map((_picture, at) => `#${at + 1}`) } : {}),
        })
      } catch (error) {
        options.log(`could not put a request of the ${task.role} agent on record`, error)
      }
    }
    scope.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'start') {
        run.said = ''
        const asking = asked()
        if (asking !== undefined) run.asking = asking
        else delete run.asking
      } else if (frame.type === 'chunk') {
        const chunk = frame.chunk
        if (chunk.type === 'text-delta') {
          run.said += chunk.text
          if (run.asking !== undefined) run.asking.text += chunk.text
          run.task.onText?.(chunk.text)
        } else if (chunk.type === 'reasoning-delta') {
          if (run.asking !== undefined) run.asking.thought += chunk.text.length
          run.job?.think(chunk.text)
        } else if (chunk.type === 'tool-call-delta') {
          if (run.asking !== undefined) {
            const call = run.asking.calls.get(chunk.index) ?? { name: '', args: '' }
            if (chunk.name !== undefined) call.name = chunk.name
            call.args += chunk.argumentsDelta
            run.asking.calls.set(chunk.index, call)
          }
        } else if (chunk.type === 'finish') {
          if (run.asking !== undefined) run.asking.finish = (chunk as { reason?: { kind?: string } }).reason?.kind ?? run.asking.finish
        } else if (chunk.type === 'usage') {
          const usage = {
            inputTokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
            outputTokens: chunk.usage.outputTokens,
            ...(chunk.usage.cacheReadTokens !== undefined && chunk.usage.cacheReadTokens > 0 ? { cachedTokens: chunk.usage.cacheReadTokens } : {}),
          }
          if (run.asking !== undefined) run.asking.usage = usage
          options.onUsage?.({ route: run.task.route, ...usage })
        }
      } else {
        if (run.said.trim().length > 0) run.last = run.said
        // (An attempt that was abandoned is on record too, as what was sent and how far the answer got.)
        const asking = run.asking
        delete run.asking
        if (asking !== undefined) answered(asking, frame.outcome.kind === 'committed')
      }
    })
  }

  /** Give the agent its task and see it through: one turn, and another when it stopped without handing in. */
  const drive = async (child: Agent, run: Staged, signal: AbortSignal | undefined): Promise<RoleOutcome['stop']> => {
    const { task } = run
    const say = (text: string, pictures: readonly ImageBlock[] = []): void => {
      child.followup(frozen({ id: randomUUID(), role: 'user', content: [...pictures, { type: 'text', text }], source: { kind: 'user' } }) as never)
    }
    const stop = (): void => {
      run.cancelled = true
      child.cancel({ kind: 'parent' } as never)
    }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      if (signal?.aborted === true) stop()
      const ended = (): RoleOutcome['stop'] => {
        // How the turn ended is in the session's own log.
        let reason: string | undefined
        for (const event of [...child.session.snapshotEvents(0 as never)].reverse()) {
          if (event.type === 'turn/end') {
            reason = (event.data as { reason?: { kind?: string } }).reason?.kind
            break
          }
        }
        const recorded: RoleOutcome['stop'] = reason === 'completed' ? 'completed' : reason === 'max-tokens' ? 'max-tokens' : reason === 'aborted' ? 'aborted' : reason === 'blocked' ? 'refusal' : 'error'
        return run.cancelled && recorded !== 'completed' ? 'aborted' : recorded
      }
      if (run.cancelled) return 'aborted'
      // The task's pictures go with its words, in the one message.
      say(task.prompt, run.pictures)
      await child.whenIdle()
      let outcome = ended()
      for (let nudge = 0; nudge < NUDGES && outcome === 'completed' && !run.cancelled; nudge++) {
        const missing = task.unfinished?.()
        if (missing === undefined) break
        say(missing)
        await child.whenIdle()
        outcome = ended()
      }
      return outcome
    } finally {
      signal?.removeEventListener('abort', stop)
    }
  }

  // ── agents kept after their run, for a word that may follow ──
  /** How long an agent is kept with nothing said to it. */
  const KEEP_MS = 30 * 60_000
  interface Kept { run: Staged; child: Agent; parent?: string; dispose: () => Promise<void>; timer?: ReturnType<typeof setTimeout> }
  const kept = new Map<string, Kept>()
  const letGo = (entry: Kept): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    void entry.dispose().catch((error: unknown) => { options.log(`could not dispose the ${entry.run.task.role} agent that was kept`, error) })
  }
  const keep = (key: string, entry: Kept): void => {
    const before = kept.get(key)
    if (before !== undefined && before !== entry) letGo(before)
    entry.timer = setTimeout(() => { if (kept.get(key) === entry) { kept.delete(key); letGo(entry) } }, KEEP_MS)
    ;(entry.timer as { unref?: () => void }).unref?.()
    kept.set(key, entry)
  }
  /** Still there to be spoken to: the Harness has it on its list, and nothing stopped it. */
  const there = (entry: Kept): boolean => ctx.get('agents')?.get(entry.child.id) === entry.child
  ctx.effect(() => () => {
    for (const entry of kept.values()) letGo(entry)
    kept.clear()
  }, 'novel: roles kept')
  /** Go on with an agent that was kept: the task's prompt is the next message of its conversation. */
  const more = async (entry: Kept, task: RoleTask): Promise<RoleOutcome> => {
    const { run, child } = entry
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    run.task = task
    run.job = currentJob()
    run.scope = callScope()
    run.limit = Math.max(4, task.maxSteps ?? DEFAULT_STEPS)
    run.steps = 0
    run.said = ''
    run.last = ''
    run.cancelled = false
    run.pictures = await imageBlocks(ctx, task.images, true)
    try {
      task.onStart?.({ session: child.id, ...(entry.parent !== undefined ? { parent: entry.parent } : {}) })
    } catch {
      // an observer must not stop the run
    }
    let stop: RoleOutcome['stop'] = 'error'
    try {
      stop = await drive(child, run, task.signal)
      return { text: run.last.trim(), stop, steps: run.steps, session: child.id, ...(entry.parent !== undefined ? { parent: entry.parent } : {}), resumed: true }
    } finally {
      if (task.keep !== undefined && stop === 'completed' && !run.cancelled && there(entry)) keep(task.keep, entry)
      else letGo(entry)
    }
  }

  /** The one-shot descriptor goes into the child's log inside its first turn, before its first request. */
  const describe = (scope: Context, descriptor: ResolvedSubagentStartRequest['descriptor']): void => {
    let appended = false
    scope.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (!appended && decision.kind === 'enter') {
        appended = true
        agent.session.append('subagent/descriptor', descriptor as never)
      }
      return decision
    })
  }

  const provider: SubagentProvider = {
    name: CREW_PROVIDER,
    // The crew is started by the Studio, which composes each child itself: none of the tool-facing options apply.
    capabilities: { agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
    inheritsParentContext: false,

    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      const run = staged.get(request.signal)
      if (run === undefined) throw new Error(`the "${CREW_PROVIDER}" provider runs the roles of Novel Studio, which starts them itself; delegate with the novel_crew tool instead`)
      if (request.signal.aborted) throw new Error('the role was cancelled before it started')
      const parent = request.parent
      const depth = resolveChildDepth(parent, request.maxDepth)
      // Captured before the first await: a later change of the parent's permissions belongs to the parent's future.
      const inherited = captureDelegatedPolicyOverrides(parent)
      const sessionId = randomUUID()
      options.onRun?.({ session: sessionId, ...(run.task.cwd !== undefined ? { book: run.task.cwd } : {}), parent: parent.id })
      try {
        run.task.onStart?.({ session: sessionId, parent: parent.id })
      } catch {
        // an observer must not stop the run
      }
      const handle = await parent.ctx.agents.create({
        sessionId: sessionId as never,
        parentAgent: parent,
        meta: childSessionMeta(parent, depth, false),
        agentOptions: resolveChildAgentOptions(parent, request.agentOptions, depth),
        signal: request.signal,
        // Composition only: the scope is filled before the agent is announced, so nothing ever sees it half made.
        setup: (scope, child) => {
          appendDelegatedPolicyOverrides(child.session, inherited)
          // Joins the parent's composition and states the delegation's fixed scope; the persona and the tools are the role's own, below.
          applyChildComposition(scope, parent, {})
          compose(scope, child, run)
          describe(scope, request.descriptor)
        },
      })
      const child = handle.agent
      const result: Promise<SubagentResult> = (async () => {
        const stop = await drive(child, run, request.signal)
        return { output: run.last.trim().length > 0 ? [{ type: 'text', text: run.last.trim() }] : [], stopReason: stop } as SubagentResult
      })()
      return {
        id: child.id,
        localAgent: child,
        result,
        async dispose(): Promise<void> {
          run.cancelled = true
          const settled = await Promise.allSettled([handle.dispose(), result])
          if (settled[0].status === 'rejected') throw settled[0].reason
        },
      }
    },
  }

  /** A run nobody's conversation asked for: an agent of its own on the same loop. */
  const alone = async (task: RoleTask, run: Staged): Promise<RoleOutcome> => {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new LlmCallError('this Harness runs no agent loop', 'NO_AGENT_LOOP')
    const presets = (task.inherit ?? { mode: 'none' }).mode === 'none' ? undefined : ctx.get('agentPresets')
    let preset: string | undefined
    try {
      const found = await presets?.resolve(CREW_PRESET)
      if (found !== undefined && found.broken === undefined) preset = found.id
    } catch {
      // No such preset in this deployment: the role works with its own tools.
      preset = undefined
    }
    const sessionId = randomUUID()
    options.onRun?.({ session: sessionId, ...(task.cwd !== undefined ? { book: task.cwd } : {}) })
    try {
      task.onStart?.({ session: sessionId })
    } catch {
      // an observer must not stop the run
    }
    const { route } = task
    let handle: AgentHandle
    handle = await agents.create({
      sessionId: sessionId as never,
      meta: {
        ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
        ...(preset !== undefined ? { agentPreset: preset } : {}),
        // Not a conversation of the author's: kept out of the list of sessions.
        origin: 'subagent',
        delegationDepth: 1,
      },
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort !== undefined && route.reasoningEffort.length > 0 ? { reasoningEffort: route.reasoningEffort as never } : {}),
        ...(route.maxTokens !== undefined && route.maxTokens > 0 ? { maxTokens: route.maxTokens } : {}),
      },
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      setup: async (scope, child) => {
        // Nobody is there to answer a question about permissions: what would ask is refused, as it is for any delegated agent.
        appendDelegatedPolicyOverrides(child.session, { permissionPreset: undefined, sandboxMode: undefined, approvalPolicy: ctx.get('approval') === undefined ? undefined : 'never' })
        if (preset !== undefined) await presets?.mount(scope, preset)
        compose(scope, child, run)
      },
    })
    let stop: RoleOutcome['stop'] = 'error'
    try {
      stop = await drive(handle.agent, run, task.signal)
      return { text: run.last.trim(), stop, steps: run.steps, session: sessionId }
    } finally {
      // Kept for a word that may follow, where the task asks for it and the run ended well; else gone:
      // stops the loop, takes the agent off the registry and unwinds everything registered above.
      if (task.keep !== undefined && stop === 'completed' && !run.cancelled) keep(task.keep, { run, child: handle.agent, dispose: async () => { run.cancelled = true; await handle.dispose() } })
      else await handle.dispose().catch((error: unknown) => { options.log(`could not dispose the ${task.role} agent`, error) })
    }
  }

  return {
    can,
    provider,
    isRole: sessionId => live.has(sessionId),

    has: key => { const entry = kept.get(key); return entry !== undefined && there(entry) },
    release: (key) => {
      const entry = kept.get(key)
      if (entry === undefined) return
      kept.delete(key)
      letGo(entry)
    },

    async run(task: RoleTask): Promise<RoleOutcome> {
      const { route } = task
      if (task.resume !== undefined) {
        const entry = kept.get(task.resume)
        if (entry !== undefined) kept.delete(task.resume)
        if (entry === undefined || !there(entry)) {
          if (entry !== undefined) letGo(entry)
          throw new LlmCallError(`the "${task.role}" agent that was to go on is not kept any more`, 'KEPT_GONE')
        }
        return await more(entry, task)
      }
      if (!can(route)) throw new LlmCallError(`the "${task.role}" role works as an agent and needs a model from Settings → Models to run on; ${route.model} is an endpoint the Studio calls directly`, 'NO_AGENT_LOOP')
      const run: Staged = { task, job: currentJob(), scope: callScope(), requests: 0, sent: new Set(), limit: Math.max(4, task.maxSteps ?? DEFAULT_STEPS), steps: 0, said: '', last: '', cancelled: false, pictures: await imageBlocks(ctx, task.images, true) }
      const parent = task.parent as Agent | undefined
      const subagents = ctx.get('subagents')
      // A parent that is gone cannot take a child; the work is still done.
      if (parent === undefined || subagents === undefined || subagents.getProvider(CREW_PROVIDER) === undefined || ctx.get('agents')?.get(parent.id) !== parent) return await alone(task, run)

      // The Harness's own request carries the task to the provider by the identity of this signal.
      const controller = new AbortController()
      const abort = (): void => { controller.abort(task.signal?.reason) }
      task.signal?.addEventListener('abort', abort, { once: true })
      if (task.signal?.aborted === true) abort()
      staged.set(controller.signal, run)
      let started: SubagentRun
      try {
        started = await subagents.start(CREW_PROVIDER, {
          label: task.label,
          prompt: [...run.pictures, { type: 'text', text: task.prompt }] as never,
          parent,
          signal: controller.signal,
          agentOptions: {
            provider: route.provider,
            model: route.model,
            ...(route.reasoningEffort !== undefined && route.reasoningEffort.length > 0 ? { reasoningEffort: route.reasoningEffort as never } : {}),
            ...(route.maxTokens !== undefined && route.maxTokens > 0 ? { maxTokens: route.maxTokens } : {}),
          },
        })
      } catch (error) {
        task.signal?.removeEventListener('abort', abort)
        throw error
      }
      let stop: RoleOutcome['stop'] = 'error'
      try {
        const result = await started.result
        stop = result.stopReason as RoleOutcome['stop']
        return { text: run.last.trim(), stop, steps: run.steps, session: started.id, parent: parent.id }
      } finally {
        task.signal?.removeEventListener('abort', abort)
        // Kept for a word that may follow, where the task asks for it and the run ended well; else gone.
        if (task.keep !== undefined && stop === 'completed' && !run.cancelled && run.child !== undefined) keep(task.keep, { run, child: run.child, parent: parent.id, dispose: async () => { await started.dispose() } })
        else await started.dispose().catch((error: unknown) => { options.log(`could not dispose the ${task.role} agent`, error) })
      }
    },
  }
}

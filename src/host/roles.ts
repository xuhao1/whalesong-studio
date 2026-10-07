// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Roles as agents, on the Harness's own agent loop.
 *
 * One run is one agent: created through `ctx.agents` with a scope of its own
 * that holds nothing but the role's persona and the role's tools, given its
 * task as a user message, driven by the loop until it has nothing more to do,
 * then disposed. Everything between — the model requests and their retries,
 * the tool calls, the session log, the token meter, cancellation — is the
 * Harness's. This is the way the Harness's own in-process subagents are run
 * (`dsh-subagent-in-process-driver`), minus the parent's preset: a role agent
 * is not a second showrunner and must not see the showrunner's tools.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { currentJob } from '../core/jobs'
import { LlmCallError } from '../core/llm'
import type { RoleOutcome, RoleRunner, RoleTask } from '../core/roles'
import type { ModelRoute } from '../shared/types'

/** Tool calls a role may make before it is told to finish. */
const DEFAULT_STEPS = 40
/** Calls of closing tools still answered once the budget is spent. */
const CLOSING_STEPS = 6

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
}

export function createRoleRunner(ctx: Context, options: { log: (message: string, error?: unknown) => void; onUsage?: (usage: RoleUsage) => void }): RoleRunner {
  const can = (route: ModelRoute): boolean => route.baseURL === undefined && route.provider.length > 0 && route.model.length > 0 && ctx.get('agents') !== undefined
  return {
    can,

    async run(task: RoleTask): Promise<RoleOutcome> {
      const { route } = task
      if (!can(route)) throw new LlmCallError(`the "${task.role}" role works as an agent and needs a model from Settings → Models to run on; ${route.model} is an endpoint the Studio calls directly`, 'NO_AGENT_LOOP')
      const parent = task.parent as Agent | undefined
      const agents = (parent?.ctx ?? ctx).get('agents')
      if (agents === undefined) throw new LlmCallError('this Harness runs no agent loop', 'NO_AGENT_LOOP')
      // The job this run belongs to: the loop calls back from its own chain of calls, where the job is no longer in sight.
      const job = currentJob()
      const limit = Math.max(4, task.maxSteps ?? DEFAULT_STEPS)
      const closing = task.tools.filter(tool => tool.closing === true).map(tool => tool.name)
      const sessionId = randomUUID()
      let steps = 0
      let said = ''
      let last = ''
      let cancelled = false
      let child: Agent | undefined

      const handle = await agents.create({
        sessionId: sessionId as never,
        ...(parent !== undefined ? { parentAgent: parent } : {}),
        meta: {
          ...(task.cwd !== undefined ? { cwd: task.cwd } : parent?.session.header.cwd !== undefined ? { cwd: parent.session.header.cwd } : {}),
          ...(parent !== undefined ? { parentSession: parent.session.header.id } : {}),
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
        // Composition only: the scope is filled before the agent is announced, so nothing ever sees it half made.
        setup: (scope) => {
          scope.systemPrompt.section({
            name: 'deployment:persona-prefix',
            order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
            text: task.persona,
            interpolate: false,
          })
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
              async execute(args) {
                steps += 1
                const given = args as Record<string, unknown>
                // Past the budget only the closing tools answer, and only for a few calls: a model that cannot bring itself to close is stopped.
                if (steps > limit + CLOSING_STEPS) {
                  cancelled = true
                  child?.cancel({ kind: 'parent' } as never)
                  throw new Error('the run was stopped: it did not close its work')
                }
                try {
                  if (steps > limit && tool.closing !== true) throw new Error(`you have used the ${limit} tool calls this task allows — close the work now with what you have (${closing.join(', ') || 'your answer'})`)
                  const text = await tool.run(given)
                  task.onStep?.({ tool: tool.name, args: given, ok: true, result: text })
                  // Told in good time, a model wraps up; told at the end, it has nothing left to wrap up with.
                  const budget = steps >= limit * 0.6 && steps <= limit && tool.closing !== true ? `\n[${steps} of ${limit} tool calls used]` : ''
                  return { text: `${text}${budget}` } as never
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error)
                  task.onStep?.({ tool: tool.name, args: given, ok: false, result: message })
                  // Thrown plainly: the loop hands the message to the model as the tool's failure.
                  throw new Error(message)
                }
              },
            }))
          }
          scope.on('agent/assistant-stream', ({ frame }) => {
            if (frame.type === 'start') {
              said = ''
            } else if (frame.type === 'chunk') {
              const chunk = frame.chunk
              if (chunk.type === 'text-delta') {
                said += chunk.text
                task.onText?.(chunk.text)
              } else if (chunk.type === 'reasoning-delta') {
                job?.think(chunk.text)
              } else if (chunk.type === 'usage') {
                options.onUsage?.({
                  route,
                  inputTokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
                  outputTokens: chunk.usage.outputTokens,
                })
              }
            } else if (said.trim().length > 0) {
              last = said
            }
          })
        },
      })
      child = handle.agent

      const stop = (): void => {
        cancelled = true
        handle.agent.cancel({ kind: 'parent' } as never)
      }
      task.signal?.addEventListener('abort', stop, { once: true })
      try {
        if (task.signal?.aborted === true) stop()
        if (!cancelled) {
          handle.agent.followup(frozen({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: task.prompt }],
            source: { kind: 'user' },
          }) as never)
          await handle.agent.whenIdle()
        }
        // How the turn ended is in the session's own log.
        let reason: string | undefined
        for (const event of [...handle.agent.session.snapshotEvents(0 as never)].reverse()) {
          if (event.type === 'turn/end') {
            reason = (event.data as { reason?: { kind?: string } }).reason?.kind
            break
          }
        }
        const recorded: RoleOutcome['stop'] = reason === 'completed' ? 'completed' : reason === 'max-tokens' ? 'max-tokens' : reason === 'aborted' ? 'aborted' : reason === 'blocked' ? 'refusal' : 'error'
        return { text: last.trim(), stop: cancelled && recorded !== 'completed' ? 'aborted' : recorded, steps, session: sessionId }
      } finally {
        task.signal?.removeEventListener('abort', stop)
        // Stops the loop, takes the agent off the registry and unwinds everything registered above.
        await handle.dispose().catch((error: unknown) => { options.log(`could not dispose the ${task.role} agent`, error) })
      }
    },
  }
}

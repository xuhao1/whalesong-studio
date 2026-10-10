// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Roles that work as agents.
 *
 * The Studio's crew — the continuity keeper, the story planner, the director,
 * post-production — are agents: each a persona, working rules, skills, tools
 * and permissions of its own, on a model of its own. They run on the Harness's
 * agent loop — the loop the showrunner runs on — so that requests, retries,
 * tool calls, the session log, the token meter, permissions and cancellation
 * are the Harness's, not a second copy of them kept here. A run is a child of
 * the conversation that asked for it and is listed under that conversation,
 * where its every step can be read.
 *
 * The core knows only this interface. The Host half implements it on
 * `ctx.subagents`; tests plug in a script that calls the tools the way a model
 * would.
 */
import type { ModelRoute } from '../shared/types'
import type { LlmImage } from './llm'

/** A parameter of a role's tool, in the shape the Harness declares tool parameters. */
export type RoleValue =
  | { type: 'string'; description?: string; enum?: readonly string[] }
  | { type: 'integer' | 'number' | 'boolean'; description?: string }
  | { type: 'array'; description?: string; items?: RoleValue }
  | { type: 'object'; description?: string; properties?: Record<string, RoleParameter>; additionalProperties: boolean }
  /** Any JSON value: for a result whose shape the task spells out in words. */
  | { type: 'json'; description?: string }

export type RoleParameter = RoleValue & { required?: true }

export interface RoleTool {
  name: string
  description: string
  parameters: Record<string, RoleParameter>
  /** Stays callable when the run's step budget is spent: what the agent closes its work with. */
  closing?: true
  /**
   * A call that succeeds ends the agent's turn: the work is handed in and there
   * is nothing left to say. Saves the request a model would spend saying so.
   */
  final?: true
  /**
   * @returns what the model reads.
   * @throws an Error whose message is the tool's failure as the model reads it, so it can try something else.
   */
  run(args: Record<string, unknown>): Promise<string> | string
}

/** A guide the agent loads when its work calls for it. */
export interface RoleSkill {
  /** Kebab-case name the agent asks for it by. */
  name: string
  /** When to load it, in one sentence. */
  description: string
  /** The guide itself, Markdown. */
  content: string
  /** The directory the guide's own files are in, when it has any. */
  base?: string
}

/**
 * What a role sees of the tools the conversation's own agent has — reading and
 * writing files, the shell, the web, whatever the author's Harness mounts —
 * beside the tools the Studio gives it:
 *
 * - `none`  its own tools and nothing else;
 * - `named` its own, and the ones named (those of them that exist);
 * - `all`   everything, except what `except` names.
 */
export type RoleInherit =
  | { mode: 'none' }
  | { mode: 'named'; names: readonly string[] }
  | { mode: 'all'; except?: (name: string) => boolean }

export interface RoleStep {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  /** What the tool answered, or why it failed. */
  result: string
}

export interface RoleTask {
  /** Short name of the role, for the logs: `analyst`. */
  role: string
  /** What this run is, in a few words, as the author reads it in the list of a conversation's agents. */
  label: string
  /** Who the agent is: the head of its system prompt. */
  persona: string
  /** How it works here: standing rules, in the place the showrunner's own instructions have in its prompt. */
  rules?: string
  /** The task: the agent's first message from outside. */
  prompt: string
  /** Pictures that go with the task, for an agent whose model sees them. */
  images?: LlmImage[]
  tools: RoleTool[]
  skills?: RoleSkill[]
  /** The conversation's other tools the agent may use; none by default. */
  inherit?: RoleInherit
  route: ModelRoute
  signal?: AbortSignal
  /** Tool calls after which the agent is told to wrap up; a few more end the run. */
  maxSteps?: number
  /**
   * Something of this task's own to say when the run is told how much of its
   * budget is gone (at half, three quarters and nine tenths of it): what it
   * still owes, said while there are calls left to do it with.
   */
  budgetNote?: (budget: { used: number; limit: number; left: number }) => string | undefined
  /** Every tool call, as it settles — the agent's own tools and the conversation's alike. */
  onStep?: (step: RoleStep) => void
  /** What the agent says between tool calls, as it says it. */
  onText?: (delta: string) => void
  /**
   * Asked when the agent stops: undefined when its work is handed in, else what
   * to tell it — it then gets one more turn. Asked at most twice.
   */
  unfinished?: () => string | undefined
  /** The conversation's agent that asked for the work, when one did: the run becomes its child. */
  parent?: unknown
  /** Working directory the run is recorded under, where it has no parent to take it from. */
  cwd?: string
  /** Told as the run begins: the session it is recorded in, and the conversation it is listed under when it has one — enough to open it while it works. */
  onStart?: (run: { session: string; parent?: string }) => void
}

export interface RoleOutcome {
  /** What the agent said last. */
  text: string
  stop: 'completed' | 'max-tokens' | 'aborted' | 'refusal' | 'error'
  /** Tool calls made. */
  steps: number
  /** The session the run is recorded in, where the Harness keeps one. */
  session?: string
  /** The conversation the run is listed under, when it has one. */
  parent?: string
}

export interface RoleRunner {
  /**
   * Whether a route can drive an agent. The agent loop takes the Harness's own
   * providers; an endpoint the Studio calls itself is not one of them.
   */
  can(route: ModelRoute): boolean
  run(task: RoleTask): Promise<RoleOutcome>
}

/** Names the two halves of the plugin agree on: what a role's own prompt takes the place of. */
export const SHOWRUNNER_SECTION = 'novel:showrunner'
export const PROJECT_CONTEXT = 'novel:project'

/** Coerce a tool argument the way models send them: a number as a string, a single item where a list is meant. */
export function argText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export function argInt(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  return Number.isFinite(number) ? Math.trunc(number) : undefined
}

export function argList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

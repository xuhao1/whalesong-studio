// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Roles that work as agents.
 *
 * Much of what the Studio asks of a model is one question with one answer: a
 * chapter from its outline, a summary from a chapter. Some work is not like
 * that. Finding where the chapters of a manuscript begin — a file scraped from
 * a web page, its headings glued to navigation text — takes looking, trying,
 * checking and correcting, and no fixed sequence of prompts does it well.
 *
 * That work is given to an agent: a persona, a few tools, a task. It runs on
 * the Harness's own agent loop — the loop the showrunner runs on — so that
 * requests, retries, tool calls, the session log, the token meter and
 * cancellation are the Harness's, not a second copy of them kept here.
 *
 * The core knows only this interface. The Host half implements it on
 * `ctx.agents`; tests plug in a script that calls the tools the way a model
 * would.
 */
import type { ModelRoute } from '../shared/types'

/** A parameter of a role's tool, in the shape the Harness declares tool parameters. */
export type RoleValue =
  | { type: 'string'; description?: string; enum?: readonly string[] }
  | { type: 'integer' | 'number' | 'boolean'; description?: string }
  | { type: 'array'; description?: string; items?: RoleValue }
  | { type: 'object'; description?: string; properties?: Record<string, RoleParameter>; additionalProperties: boolean }

export type RoleParameter = RoleValue & { required?: true }

export interface RoleTool {
  name: string
  description: string
  parameters: Record<string, RoleParameter>
  /** Stays callable when the run's step budget is spent: what the agent closes its work with. */
  closing?: true
  /**
   * @returns what the model reads.
   * @throws an Error whose message is the tool's failure as the model reads it, so it can try something else.
   */
  run(args: Record<string, unknown>): Promise<string> | string
}

export interface RoleStep {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  /** What the tool answered, or why it failed. */
  result: string
}

export interface RoleTask {
  /** Short name of the role, for the session's label and the logs: `importer`. */
  role: string
  /** What this run is, in a few words, as the author would read it in a list of sessions. */
  label: string
  /** Who the agent is and how it works: its system prompt. */
  persona: string
  /** The task: the agent's first and only message from outside. */
  prompt: string
  tools: RoleTool[]
  route: ModelRoute
  signal?: AbortSignal
  /** Tool calls after which the agent is told to wrap up; twice as many end the run. */
  maxSteps?: number
  /** Every tool call, as it settles. */
  onStep?: (step: RoleStep) => void
  /** What the agent says between tool calls, as it says it. */
  onText?: (delta: string) => void
  /** The conversation's agent that asked for the work, when one did: the run becomes its child. */
  parent?: unknown
  /** Working directory the run is recorded under. */
  cwd?: string
}

export interface RoleOutcome {
  /** What the agent said last. */
  text: string
  stop: 'completed' | 'max-tokens' | 'aborted' | 'refusal' | 'error'
  /** Tool calls made. */
  steps: number
  /** The session the run is recorded in, where the Harness keeps one. */
  session?: string
}

export interface RoleRunner {
  /**
   * Whether a route can drive an agent. The agent loop takes the Harness's own
   * providers; an endpoint the Studio calls itself is not one of them.
   */
  can(route: ModelRoute): boolean
  run(task: RoleTask): Promise<RoleOutcome>
}

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

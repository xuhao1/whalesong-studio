// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Small per-session facts the plugin keeps outside the session log: the
 * working mode and the book in play — the one project the conversation and
 * the Studio beside it are both on. Kept in one JSON file under the Harness home.
 */
import { join } from 'node:path'
import { WORK_MODES, type WorkMode } from '../shared/types'
import { resolveDshHome } from './settings'
import { KeyedMutex } from './util/async'
import { readJson, writeJson } from './util/fs'

/** Who moved a session to another book: the author in the Studio, or the session's own model through a tool. */
export type SwitchedBy = 'author' | 'agent'

export interface SessionState {
  mode: WorkMode
  /** Absolute root of the project this session is bound to, when chosen explicitly. */
  project?: string
  /** Roots of the books this session has been on, oldest first, the book in play last. */
  books?: string[]
  /** The last change of book, kept so the model can tell which turns were about which book. */
  switched?: { from: string; by: SwitchedBy; at: string }
  updatedAt: string
}

/** How many earlier books a session remembers. */
const TRAIL = 8

const DEFAULT_MODE: WorkMode = 'draft'
const KEEP = 400

export class SessionStateStore {
  private states: Record<string, SessionState> | undefined
  private readonly mutex = new KeyedMutex()
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor(private readonly file = join(resolveDshHome(), 'novel-writer', 'sessions.json')) {}

  private async load(): Promise<Record<string, SessionState>> {
    if (this.states === undefined) {
      try {
        this.states = (await readJson<Record<string, SessionState>>(this.file)) ?? {}
      } catch {
        this.states = {}
      }
    }
    return this.states
  }

  async get(sessionId: string): Promise<SessionState> {
    const states = await this.load()
    const state = states[sessionId]
    if (state === undefined || !WORK_MODES.includes(state.mode)) return { mode: DEFAULT_MODE, updatedAt: '' }
    return state
  }

  /** Mode of a session when already loaded; avoids async work on prompt assembly. */
  peek(sessionId: string): SessionState | undefined {
    return this.states?.[sessionId]
  }

  /**
   * @param move - for a change of project: who made it, and the book the session
   *   was on until now (which may have been the workspace's only one, never bound).
   */
  async update(sessionId: string, patch: Partial<Pick<SessionState, 'mode' | 'project'>>, move?: { by: SwitchedBy; from?: string }): Promise<SessionState> {
    return await this.mutex.run('sessions', async () => {
      const states = await this.load()
      const current = await this.get(sessionId)
      const now = new Date().toISOString()
      const next: SessionState = { ...current, ...patch, updatedAt: now }
      if (patch.project === '') delete next.project
      else if (patch.project !== undefined) {
        const from = move?.from ?? current.project
        const trail = [...(current.books ?? []), ...(from !== undefined ? [from] : [])].filter((root, index, all) => root !== patch.project && all.indexOf(root) === index)
        next.books = [...trail, patch.project].slice(-TRAIL)
        if (from !== undefined && from !== patch.project) next.switched = { from, by: move?.by ?? 'author', at: now }
      }
      states[sessionId] = next
      const ids = Object.keys(states)
      if (ids.length > KEEP) {
        ids.sort((left, right) => states[left]!.updatedAt.localeCompare(states[right]!.updatedAt))
        for (const id of ids.slice(0, ids.length - KEEP)) delete states[id]
      }
      await writeJson(this.file, states)
      for (const listener of [...this.listeners]) listener(sessionId)
      return next
    })
  }

  /** A book is gone: no session is on it any more, and none remembers having been. */
  async forget(root: string): Promise<void> {
    await this.mutex.run('sessions', async () => {
      const states = await this.load()
      const touched: string[] = []
      for (const [id, state] of Object.entries(states)) {
        if (state.project !== root && state.switched?.from !== root && state.books?.includes(root) !== true) continue
        const next: SessionState = { ...state, updatedAt: new Date().toISOString() }
        if (next.project === root) delete next.project
        if (next.switched?.from === root) delete next.switched
        if (next.books !== undefined) next.books = next.books.filter(book => book !== root)
        states[id] = next
        touched.push(id)
      }
      if (touched.length === 0) return
      await writeJson(this.file, states)
      for (const id of touched) for (const listener of [...this.listeners]) listener(id)
    })
  }

  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

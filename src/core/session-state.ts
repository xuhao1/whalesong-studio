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

/**
 * Which conversations hold something of which book — beyond the one a
 * conversation is on: a book a tool was pointed at for one call, a role's run
 * that worked on a book as some conversation's child. Kept so that a book
 * that is sealed can take every conversation about it under its seal.
 */
export class SessionBooks {
  private held: Record<string, string[]> | undefined
  private readonly mutex = new KeyedMutex()

  constructor(private readonly file = join(resolveDshHome(), 'novel-writer', 'session-books.json')) {}

  private async load(): Promise<Record<string, string[]>> {
    if (this.held === undefined) {
      try {
        this.held = (await readJson<Record<string, string[]>>(this.file)) ?? {}
      } catch {
        this.held = {}
      }
    }
    return this.held
  }

  /** Note that a conversation holds something of a book. Written only when that is news. */
  async touch(sessionId: string, root: string): Promise<void> {
    if ((await this.load())[sessionId]?.includes(root) === true) return
    await this.mutex.run('books', async () => {
      const held = await this.load()
      if (held[sessionId]?.includes(root) === true) return
      held[sessionId] = [...(held[sessionId] ?? []), root]
      // Runs come by the hundred: the oldest notes go once there are a great many.
      const ids = Object.keys(held)
      if (ids.length > TOUCH_KEEP) for (const id of ids.slice(0, ids.length - TOUCH_KEEP)) delete held[id]
      await writeJson(this.file, held)
    })
  }

  /** The books a conversation holds something of: one, for a role's run — the book it worked on. */
  async booksOf(sessionId: string): Promise<string[]> {
    return [...((await this.load())[sessionId] ?? [])]
  }

  /** Ids of the conversations that hold something of a book. */
  async sessionsOf(root: string): Promise<string[]> {
    return Object.entries(await this.load()).filter(([, roots]) => roots.includes(root)).map(([id]) => id)
  }

  /** A book is gone: nothing is kept about who held it. */
  async forget(root: string): Promise<void> {
    await this.mutex.run('books', async () => {
      const held = await this.load()
      let changed = false
      for (const [id, roots] of Object.entries(held)) {
        if (!roots.includes(root)) continue
        changed = true
        const rest = roots.filter(candidate => candidate !== root)
        if (rest.length > 0) held[id] = rest
        else delete held[id]
      }
      if (changed) await writeJson(this.file, held)
    })
  }
}

const TOUCH_KEEP = 20_000

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

  /** Ids of the sessions that are on a book, or have been. */
  async sessionsOn(root: string): Promise<string[]> {
    const states = await this.load()
    return Object.entries(states).filter(([, state]) => state.project === root || state.books?.includes(root) === true).map(([id]) => id)
  }

  /** The book a session was put on by name, when it was. */
  async boundTo(sessionId: string): Promise<string | undefined> {
    return (await this.load())[sessionId]?.project
  }

  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

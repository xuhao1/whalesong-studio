// SPDX-License-Identifier: LGPL-3.0-or-later
/** The Studio put beside a conversation the author steps into: when it is opened there, how often, and when not at all. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BESIDE_ARRIVAL_MS, BESIDE_TRIES, bringBeside, type BesideHost } from '../src/client/beside'

/** DSH's word on which conversation is on screen, with the listeners it tells. */
function screen(initial?: string): { now: string | undefined; show(id: string | undefined): void; listeners: Set<() => void>; getSnapshot(): string | undefined; subscribe(listener: () => void): () => void } {
  const listeners = new Set<() => void>()
  const state = {
    now: initial,
    listeners,
    show(id: string | undefined): void {
      state.now = id
      for (const listener of [...listeners]) listener()
    },
    getSnapshot: () => state.now,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return state
}

/**
 * A column as DSH keeps it: a page opened in a conversation's column before the column is set up is dropped.
 * @param ready - how long after a conversation is shown its column takes a page.
 */
function columns(onScreen: ReturnType<typeof screen>, ready: number): { opened: string[]; standing: Set<string>; openIn(id: string): void; shownAt: Map<string, number> } {
  const shownAt = new Map<string, number>()
  onScreen.subscribe(() => { if (onScreen.now !== undefined && !shownAt.has(onScreen.now)) shownAt.set(onScreen.now, Date.now()) })
  const standing = new Set<string>()
  const opened: string[] = []
  return {
    opened,
    standing,
    shownAt,
    openIn(id: string) {
      opened.push(id)
      const since = shownAt.get(id)
      if (since !== undefined && Date.now() - since >= ready) standing.add(id)
    },
  }
}

describe('the Studio beside a conversation the author steps into', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const host = (onScreen: ReturnType<typeof screen>, column: ReturnType<typeof columns>, extra: Partial<BesideHost> = {}): BesideHost & { here: number } => {
    const made = {
      onScreen,
      openIn: (id: string) => { column.openIn(id) },
      openHere: () => { made.here += 1 },
      stands: (id: string) => column.standing.has(id),
      waiting: new Set<() => void>(),
      here: 0,
      ...extra,
    }
    return made
  }

  it('is opened once the conversation is on screen — not before, and not in the moment it arrives', () => {
    const onScreen = screen('parent')
    const column = columns(onScreen, 50)
    const studio = host(onScreen, column)
    bringBeside('agent', studio)
    // Not on screen yet: nothing is opened anywhere.
    vi.advanceTimersByTime(500)
    expect(column.opened).toEqual([])
    onScreen.show('agent')
    // On screen this instant: DSH sets the column up after saying so — a page opened now would be dropped.
    expect(column.opened).toEqual([])
    vi.advanceTimersByTime(BESIDE_TRIES[0]! - 1)
    expect(column.opened).toEqual([])
    vi.advanceTimersByTime(1)
    expect(column.opened).toEqual(['agent'])
    expect(column.standing.has('agent')).toBe(true)
    // It stands there: no further try, and nothing left waiting.
    vi.advanceTimersByTime(10_000)
    expect(column.opened).toEqual(['agent'])
    expect(studio.waiting.size).toBe(0)
    expect(onScreen.listeners.size).toBe(1)
  })

  it('is opened again for as long as no Studio stands there — a column slow to be set up drops the first tries', () => {
    const onScreen = screen('parent')
    // The column takes a page only a second after the conversation is shown.
    const column = columns(onScreen, 1000)
    const studio = host(onScreen, column)
    bringBeside('agent', studio)
    onScreen.show('agent')
    vi.advanceTimersByTime(BESIDE_TRIES[0]!)
    expect(column.opened).toHaveLength(1)
    expect(column.standing.has('agent')).toBe(false)
    vi.advanceTimersByTime(BESIDE_TRIES[1]!)
    expect(column.opened).toHaveLength(2)
    vi.advanceTimersByTime(BESIDE_TRIES[2]!)
    // 80 + 320 + 700 ms after it was shown: the column is there, and this try takes.
    expect(column.opened).toHaveLength(3)
    expect(column.standing.has('agent')).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(column.opened).toHaveLength(3)
    expect(studio.waiting.size).toBe(0)
  })

  it('gives up when the tries are used up, and stops at once when the author has gone on', () => {
    const onScreen = screen('parent')
    // A column that never takes the page.
    const never = columns(onScreen, Number.POSITIVE_INFINITY)
    const stubborn = host(onScreen, never)
    bringBeside('agent', stubborn)
    onScreen.show('agent')
    vi.advanceTimersByTime(60_000)
    expect(never.opened).toHaveLength(BESIDE_TRIES.length)
    expect(stubborn.waiting.size).toBe(0)

    // The author steps into one agent and, before its column is there, on into another conversation.
    const column = columns(onScreen, 1000)
    const studio = host(onScreen, column)
    onScreen.show('parent')
    bringBeside('other', studio)
    onScreen.show('other')
    vi.advanceTimersByTime(BESIDE_TRIES[0]!)
    expect(column.opened).toEqual(['other'])
    onScreen.show('elsewhere')
    vi.advanceTimersByTime(60_000)
    // Nothing more is opened in the conversation left behind, and nothing in the one arrived in.
    expect(column.opened).toEqual(['other'])
    expect(studio.waiting.size).toBe(0)
  })

  it('opens nothing in a conversation that never comes on screen, and a page that is asked for twice is brought twice', () => {
    const onScreen = screen('parent')
    const column = columns(onScreen, 0)
    const studio = host(onScreen, column)
    bringBeside('agent', studio)
    vi.advanceTimersByTime(BESIDE_ARRIVAL_MS + 1)
    expect(studio.waiting.size).toBe(0)
    // Shown long after: nobody is waiting for it any more.
    onScreen.show('agent')
    vi.advanceTimersByTime(60_000)
    expect(column.opened).toEqual([])

    // Already on screen with a Studio beside it — the author asks from another page of the book: once more, to take it there.
    column.standing.add('agent')
    bringBeside('agent', studio)
    vi.advanceTimersByTime(BESIDE_TRIES[0]!)
    expect(column.opened).toEqual(['agent'])
    vi.advanceTimersByTime(60_000)
    expect(column.opened).toEqual(['agent'])
  })

  it('ends every wait when the plugin is taken out, and falls back to the conversation on screen on a DSH that cannot name one', () => {
    const onScreen = screen('parent')
    const column = columns(onScreen, 0)
    const studio = host(onScreen, column)
    bringBeside('agent', studio)
    expect(studio.waiting.size).toBe(1)
    for (const end of [...studio.waiting]) end()
    onScreen.show('agent')
    vi.advanceTimersByTime(60_000)
    expect(column.opened).toEqual([])
    expect(onScreen.listeners.size).toBe(1)

    // No word on which conversation is on screen, or no way to open a page in a named one: in the one on screen, a moment later.
    for (const older of [host(onScreen, column, { onScreen: undefined }), host(onScreen, column, { openIn: undefined })]) {
      bringBeside('agent', older)
      expect(older.here).toBe(0)
      vi.advanceTimersByTime(600)
      expect(older.here).toBe(1)
      expect(older.waiting.size).toBe(0)
    }
    // A sidebar that will not open it there is the end of it, not an error thrown into DSH.
    const refusing = host(onScreen, column, { onScreen: undefined, openHere: () => { throw new Error('no conversation on screen') } })
    bringBeside('agent', refusing)
    expect(() => { vi.advanceTimersByTime(600) }).not.toThrow()
  })
})

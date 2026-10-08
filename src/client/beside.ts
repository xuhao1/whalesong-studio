// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Studio put beside a conversation — and kept there.
 *
 * In DSH the column on the right is each conversation's own. A role at work is
 * a conversation of its own, with a column that has nothing in it: step into
 * it from the Studio, and the Studio is gone. So whoever takes the author into
 * such a conversation also puts the Studio beside it.
 *
 * That is one call (`openTabIn`) — which DSH drops without a word when it
 * comes in the moment a conversation is first shown: it says the conversation
 * is on screen, and sets the conversation's column up after that. A page
 * opened in between is not there once the column is. This is what happened to
 * the Studio beside an agent that had only just started, while one beside an
 * agent looked at before (its column long set up) stayed.
 *
 * So the page is opened a moment after the conversation is on screen, and
 * opened again — a few times, further and further apart — for as long as no
 * Studio stands there. It ends when one does, when the author has gone on to
 * another conversation, or when the tries are used up.
 */

/** The conversation on screen, as DSH tells it. */
export interface OnScreen {
  getSnapshot(): string | undefined
  subscribe(listener: () => void): () => void
}

export interface BesideHost {
  /** Absent on a DSH that does not tell which conversation is on screen. */
  onScreen: OnScreen | undefined
  /** Open the Studio's page in the column of one conversation; absent on a DSH that cannot. */
  openIn: ((sessionId: string) => void) | undefined
  /** Open it in the column of whichever conversation is on screen. */
  openHere: () => void
  /** Whether a Studio stands beside a conversation right now. */
  stands: (sessionId: string) => boolean
  /** Every wait that is still on puts its end here, for whoever takes the plugin out of the window. */
  waiting: Set<() => void>
}

/** After the conversation is on screen: the first try, then the waits before each further one, in milliseconds. */
export const BESIDE_TRIES: readonly number[] = [80, 320, 700, 1400, 2500]
/** How long a conversation is waited for to come on screen at all. */
export const BESIDE_ARRIVAL_MS = 10_000

/**
 * Put the Studio beside one conversation: once that conversation is on screen, and until a Studio stands there.
 * A conversation that never comes on screen — the author went elsewhere — gets nothing opened in it.
 */
export function bringBeside(sessionId: string, host: BesideHost): void {
  const { onScreen, openIn, waiting } = host
  if (onScreen === undefined || openIn === undefined) {
    // A DSH that cannot open a page in a conversation it is told: in the one on screen, once that has changed.
    const end = (): void => {
      clearTimeout(soon)
      waiting.delete(end)
    }
    const soon = setTimeout(() => {
      end()
      try {
        host.openHere()
      } catch {
        // The author opens it from the sidebar's own menu.
      }
    }, 600)
    waiting.add(end)
    return
  }
  let over = false
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = (): void => {
    if (over) return
    over = true
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe?.()
    unsubscribe = undefined
    waiting.delete(end)
  }
  const open = (attempt: number): void => {
    if (over) return
    // Elsewhere by now: nothing is opened behind the author's back. There already, after a try: done.
    if (onScreen.getSnapshot() !== sessionId || (attempt > 0 && host.stands(sessionId))) {
      end()
      return
    }
    try {
      openIn(sessionId)
    } catch {
      // The column is not there to be opened in yet: the next try finds it.
    }
    const wait = BESIDE_TRIES[attempt + 1]
    if (wait === undefined) end()
    else timer = setTimeout(() => { open(attempt + 1) }, wait)
  }
  const arrived = (): void => {
    unsubscribe?.()
    unsubscribe = undefined
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { open(0) }, BESIDE_TRIES[0])
  }
  waiting.add(end)
  if (onScreen.getSnapshot() === sessionId) {
    arrived()
    return
  }
  let subscribing = true
  let early = false
  unsubscribe = onScreen.subscribe(() => {
    if (over || onScreen.getSnapshot() !== sessionId) return
    // Told while still being listened for: taken up once the listening is in place.
    if (subscribing) early = true
    else if (unsubscribe !== undefined) arrived()
  })
  subscribing = false
  if (early) {
    arrived()
    return
  }
  // The conversation did not come on screen: nothing is opened later on, when nobody expects it.
  timer = setTimeout(end, BESIDE_ARRIVAL_MS)
}

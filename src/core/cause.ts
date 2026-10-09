// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * For whom, or what, the book is being changed right now.
 *
 * A version of a card says not only how the card was but what changed it —
 * the author by hand, the showrunner, a job of the Studio, a version put
 * back. Whoever starts a piece of work says so once, here; whatever that work
 * then changes, however deep in a pipeline, is kept under that word. Where
 * nobody says anything, a change is the author's own.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const cause = new AsyncLocalStorage<string>()

/**
 * Whatever `work` changes in a book is on record as changed for this reason: `agent` (the showrunner's tool),
 * `device` (a phone or another tab), `restore` (an earlier version put back), `removed`, `job-<title>` (a job of the
 * Studio: a digest, a derived look…). The innermost word holds: a job the showrunner starts is that job's.
 */
export function changedBy<T>(why: string, work: () => Promise<T>): Promise<T> {
  return cause.run(why, work)
}

/** What the book is being changed for; nothing where nobody said — the author's own hand. */
export function changing(): string | undefined {
  return cause.getStore()
}

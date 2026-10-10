// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Writing in rounds: chapters that were written are reviewed, what the review
 * found is mended across them in one go by the planner — the same mending a
 * list of issues gets when the author hands it over ({@link fixIssues}) — the
 * chapters that changed are digested and reviewed again, and so on, until
 * nothing of the gravity asked for is left or the rounds are used up.
 *
 * It is a way of writing the author chooses, and pays for: every round is one
 * run of the planner, and a rewrite, a digest and a review for each chapter
 * it changes. What a round changes is applied to the text as it goes — a
 * round reads what the round before made — and every text it replaces is a
 * version of its chapter.
 */
import { fuzzyFind } from '../../shared/text'
import type { IssueSeverity } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { L, promptLanguage } from '../render'
import { digestChapter } from './digest'
import { reviewChapter } from './review'
import { fixIssues } from './revise'

export interface IterateParams {
  /** The chapters written in rounds. */
  chapters: string[]
  /** How many rounds at most. Default 2; never more than 5. */
  rounds?: number
  /** What is worth a round: issues this grave or graver. Default `medium`. */
  atLeast?: IssueSeverity
  /** What the reviews look at. */
  focus?: string
}

export interface IterateRound {
  round: number
  /** Open issues of the gravity asked for when the round began, and in how many chapters. */
  issues: number
  chapters: number
  /** The chapters the round rewrote, by id. */
  rewritten: string[]
  /** What the planner said of the round. */
  note?: string
}

export interface IterateResult {
  rounds: IterateRound[]
  /** Issues of that gravity still open at the end. */
  left: number
  /** Why it stopped: nothing left to mend, the rounds were used up, or a round changed nothing. */
  ended: 'clean' | 'rounds' | 'stuck'
}

const GRAVITY: Record<string, number> = { high: 3, critical: 3, medium: 2, major: 2, low: 1, minor: 1 }

export async function iterateChapters(core: NovelCore, runtime: ProjectRuntime, params: IterateParams, task: TaskContext): Promise<IterateResult> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  const most = Math.max(1, Math.min(5, Math.round(params.rounds ?? 2)))
  const floor = GRAVITY[params.atLeast ?? 'medium'] ?? 2
  const chapters = [...new Set(params.chapters)]
  const result: IterateResult = { rounds: [], left: 0, ended: 'rounds' }
  /** The open issues worth a round, chapter by chapter. */
  const open = async (): Promise<Map<string, number>> => {
    const found = new Map<string, number>()
    for (const id of chapters) {
      const count = ((await project.review(id))?.issues ?? []).filter(issue => issue.resolved !== true && (GRAVITY[issue.severity] ?? 1) >= floor).length
      if (count > 0) found.set(id, count)
    }
    return found
  }
  const total = (found: Map<string, number>): number => [...found.values()].reduce((sum, count) => sum + count, 0)
  /** Read by the reviewer as it is now: each chapter named, side by side as far as the settings allow. */
  const review = async (ids: readonly string[]): Promise<void> => {
    await Promise.all(ids.map(async (id) => {
      if ((await project.chapterText(id)).trim().length === 0) return
      await core.through('text', async () => { await reviewChapter(core, runtime, { chapter: id, ...(params.focus !== undefined ? { focus: params.focus } : {}) }, task) }, task.signal !== undefined ? { signal: task.signal } : {}, runtime)
    }))
  }
  // Whatever of these has not been reviewed yet is, first: a round goes by what a review found.
  const unread: string[] = []
  for (const id of chapters) if ((await project.review(id)) === undefined) unread.push(id)
  if (unread.length > 0) {
    const restore = task.job?.note(L(lang, `审校 ${unread.length} 章…`, `Reviewing ${unread.length} chapter(s)…`))
    try {
      await review(unread)
    } finally {
      restore?.()
    }
  }
  for (let round = 1; round <= most; round++) {
    task.signal?.throwIfAborted()
    const found = await open()
    if (found.size === 0) {
      result.ended = 'clean'
      break
    }
    const said = task.job?.note(L(lang, `第 ${round} 轮修订：策划在看 ${found.size} 章里的 ${total(found)} 个问题…`, `Round ${round}: the planner is reading ${total(found)} issue(s) in ${found.size} chapter(s)…`))
    let rewritten: string[] = []
    let note: string | undefined
    try {
      const mended = await fixIssues(core, runtime, { atLeast: params.atLeast ?? 'medium', chapters: [...found.keys()] }, task)
      note = mended.book?.note
      // What the round proposed is the text from here on: the next round reads it. Each text replaced is a version.
      const pending = (await project.proposals()).filter(proposal => proposal.status === 'pending' && mended.book !== undefined && (proposal.batchId === mended.book.batchId || proposal.batches?.includes(mended.book.batchId) === true))
      for (const proposal of pending) {
        const text = await project.chapterText(proposal.chapterId)
        let next: string | undefined
        if (proposal.kind === 'chapter') next = proposal.after
        else {
          const range = fuzzyFind(text, proposal.before)
          if (range !== undefined) next = text.slice(0, range.start) + proposal.after + text.slice(range.end)
        }
        if (next === undefined) {
          await project.setProposalStatus(proposal.id, 'rejected')
          continue
        }
        await project.saveChapterText(proposal.chapterId, next, { reason: 'before-revise' })
        await project.setProposalStatus(proposal.id, 'accepted')
        if (!rewritten.includes(proposal.chapterId)) rewritten.push(proposal.chapterId)
      }
    } finally {
      said?.()
    }
    result.rounds.push({ round, issues: total(found), chapters: found.size, rewritten, ...(note !== undefined ? { note } : {}) })
    task.job?.result({ rounds: result.rounds })
    if (rewritten.length === 0) {
      // The planner changed nothing: another round would ask the same of the same text.
      result.ended = 'stuck'
      break
    }
    // The chapters that changed are read again — by the scribe, for what the book now knows, and by the reviewer: what
    // was mended is gone from the review, and what the mending broke is in it.
    const again = task.job?.note(L(lang, `第 ${round} 轮：重新收录、审校改过的 ${rewritten.length} 章…`, `Round ${round}: digesting and reviewing the ${rewritten.length} chapter(s) that changed…`))
    try {
      for (const id of rewritten) await digestChapter(core, runtime, id, task, { force: true }).catch((error: unknown) => { if (task.signal?.aborted === true) throw error })
      await review(rewritten)
    } finally {
      again?.()
    }
    rewritten = []
  }
  result.left = total(await open())
  if (result.left === 0) result.ended = 'clean'
  task.job?.result({ rounds: result.rounds, left: result.left, ended: result.ended })
  return result
}

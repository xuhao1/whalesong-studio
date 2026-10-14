// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What is on file for a chapter — and the one rule that keeps it from piling up.
 *
 * Whoever finds problems in a chapter, or settles what changes in it, used to
 * work from the text alone: a reviewer read the chapter as it stood, knowing
 * neither the issues already filed for it nor the changes that waited to be
 * accepted, so a second look found the same fault again, filed it again, and
 * had it mended again — two proposals for one sentence, in the same direction.
 *
 * Two things here against that. What is on file is said to whoever works on
 * the chapter ({@link onFile}): the issues still open, the changes that wait
 * (what they replace, with what, for which issue), and the changes the author
 * turned down — a direction refused is not proposed a second time. And a
 * passage has one change waiting, whoever proposes ({@link proposeSpan}): the
 * same words again are no new proposal, other words take the earlier one's
 * place.
 */
import type { Proposal, ReviewIssue } from '../../shared/types'
import { clip, fuzzyFind } from '../../shared/text'
import type { ProjectRuntime } from '../core'
import { L } from '../render'

/** Find a passage in a text; with a position hint, the occurrence nearest to it wins. */
export function locateNear(text: string, quote: string, near?: number): { start: number; end: number } | undefined {
  if (quote.length === 0) return undefined
  if (near !== undefined) {
    let best: number | undefined
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
      if (best === undefined || Math.abs(at - near) < Math.abs(best - near)) best = at
    }
    if (best !== undefined) return { start: best, end: best + quote.length }
  }
  return fuzzyFind(text, quote)
}

/** How many of each kind are said for one chapter at most: what is on file is a reminder, not the work. */
const ISSUES_SAID = 40
const WAITING_SAID = 30
const REFUSED_SAID = 12

export interface OnFile {
  /** The block for a task, headed; empty where nothing is on file. */
  text: string
  issues: number
  waiting: number
  refused: number
}

const oneLine = (text: string, most: number): string => clip(text.replace(/\s+/g, ' ').trim(), most)

/**
 * What is on file for these chapters, as whoever works on them is told it: the issues still open (and which of them
 * have a change waiting), the changes that wait, and the changes the author turned down.
 * @param chapters - the chapters, each with the number it is called by in the task.
 * @param options.issues - `false`: the issues are not listed (the task lists them itself).
 */
export async function onFile(runtime: ProjectRuntime, chapters: readonly { id: string; index: number; title: string }[], lang: 'zh' | 'en', options: { issues?: boolean } = {}): Promise<OnFile> {
  const { project } = runtime
  const proposals = await project.proposals()
  const parts: string[] = []
  let issues = 0
  let waiting = 0
  let refused = 0
  for (const chapter of chapters) {
    const lines: string[] = []
    const mine = proposals.filter(proposal => proposal.chapterId === chapter.id)
    const pending = mine.filter(proposal => proposal.status === 'pending')
    // Turned down by the author — not one a later proposal took the place of, which nobody refused.
    const no = mine.filter(proposal => proposal.status === 'rejected' && proposal.supersededBy === undefined && proposal.kind === 'span').slice(-REFUSED_SAID)
    const answered = new Set(pending.flatMap(proposal => proposal.issues ?? []))
    const open: ReviewIssue[] = options.issues === false ? [] : ((await project.review(chapter.id))?.issues ?? []).filter(issue => issue.resolved !== true).slice(0, ISSUES_SAID)
    if (open.length > 0) {
      lines.push(L(lang, '已经记下、还开着的问题（不再重报；它现在是另一个样子了，才另记一条）：', 'Issues already filed and still open (not filed again — a new one only where it is a different matter now):'))
      for (const issue of open) {
        const has = answered.has(issue.id) ? L(lang, '（已有提案在等）', ' (a change waits for it)') : ''
        lines.push(`- [${issue.id}]${has}${issue.quote !== undefined ? ` ${L(lang, '「', '"')}${oneLine(issue.quote, 60)}${L(lang, '」', '"')}` : ''} ${oneLine(issue.explanation, 120)}`)
      }
      issues += open.length
    }
    if (pending.length > 0) {
      lines.push(L(lang, '等着作者确认的改动（它圈住的句子不再圈；要改得不一样才圈进来——那会取代它）：', 'Changes that wait for the author (the sentences one takes in are not taken in again — only where they are to read otherwise, and that takes its place):'))
      for (const proposal of pending.slice(-WAITING_SAID)) {
        const forIssues = proposal.issues !== undefined && proposal.issues.length > 0 ? L(lang, `（为 ${proposal.issues.join('、')}）`, ` (for ${proposal.issues.join(', ')})`) : ''
        lines.push(proposal.kind === 'chapter'
          ? `- [${proposal.id}]${forIssues} ${L(lang, '整章重写：', 'the chapter written over: ')}${oneLine(proposal.instruction, 100)}`
          : `- [${proposal.id}]${forIssues} ${L(lang, '「', '"')}${oneLine(proposal.before, 70)}${L(lang, '」→「', '" → "')}${oneLine(proposal.after, 90)}${L(lang, '」', '"')}`)
      }
      waiting += pending.length
    }
    if (no.length > 0) {
      lines.push(L(lang, '作者放弃过的改法（同样的改法不再提）：', 'Changes the author turned down (the same change is not proposed again):'))
      for (const proposal of no) lines.push(`- ${L(lang, '「', '"')}${oneLine(proposal.before, 70)}${L(lang, '」→「', '" → "')}${oneLine(proposal.after, 90)}${L(lang, '」', '"')}`)
      refused += no.length
    }
    if (lines.length > 0) parts.push(`### ${L(lang, `第 ${chapter.index} 章《${chapter.title}》`, `Chapter ${chapter.index}, "${chapter.title}"`)}\n${lines.join('\n')}`)
  }
  const text = parts.length > 0 ? `## ${L(lang, '已经在案的', 'Already on file')}\n\n${parts.join('\n\n')}` : ''
  return { text, issues, waiting, refused }
}

export interface Proposed {
  proposal: Proposal
  /** The very change already waited: nothing new was proposed, and the one that waits answers for these issues too. */
  same?: true
  /** How many waiting changes of the same passage this one took the place of. */
  replaced: number
}

/**
 * Propose a change to a passage — one place, one change that waits. Where a waiting change is of the same passage
 * (theirs and this one's overlap in the chapter as the book has it): the same words — nothing new is proposed, and
 * the one that waits is said to answer for these issues too; other words — this one takes its place, carrying what
 * it was for (turned down, the earlier one comes back to wait, as with any proposal made on top of another).
 * @param text - the chapter as the manuscript has it: where `input.before` stands at `input.at`.
 */
export async function proposeSpan(runtime: ProjectRuntime, text: string, input: Omit<Proposal, 'id' | 'createdAt' | 'status'>, lang: 'zh' | 'en'): Promise<Proposed> {
  const { project } = runtime
  const start = input.at ?? locateNear(text, input.before)?.start
  const waiting = (await project.proposals()).filter(proposal => proposal.status === 'pending' && proposal.kind === 'span' && proposal.chapterId === input.chapterId)
  const over: Proposal[] = []
  if (start !== undefined) {
    const end = start + input.before.length
    for (const proposal of waiting) {
      const range = locateNear(text, proposal.before, proposal.at)
      if (range !== undefined && range.start < end && start < range.end) over.push(proposal)
    }
  }
  const same = over.find(proposal => proposal.before === input.before && proposal.after === input.after)
  if (same !== undefined) {
    const issues = [...new Set([...(same.issues ?? []), ...(input.issues ?? [])])]
    const batches = [...new Set([...(same.batches ?? []), ...(input.batchId !== undefined && input.batchId !== same.batchId ? [input.batchId] : [])])]
    const noted = issues.length !== (same.issues?.length ?? 0) || batches.length !== (same.batches?.length ?? 0)
      ? await project.noteProposal(same.id, { ...(issues.length > 0 ? { issues } : {}), ...(batches.length > 0 ? { batches } : {}) })
      : undefined
    return { proposal: noted ?? same, same: true, replaced: 0 }
  }
  if (over.length === 0) return { proposal: await project.addProposal(input), replaced: 0 }
  const issues = [...new Set([...over.flatMap(proposal => proposal.issues ?? []), ...(input.issues ?? [])])]
  const batches = [...new Set([...over.flatMap(proposal => [...(proposal.batchId !== undefined ? [proposal.batchId] : []), ...(proposal.batches ?? [])]), ...(input.batches ?? [])])].filter(batch => batch !== input.batchId)
  const says = L(lang, `取代了同一处先前的 ${over.length} 条提案；放弃这一条，先前的回来等你确认。`, `Takes the place of ${over.length} earlier change(s) to the same passage; turned down, they come back to wait.`)
  const proposal = await project.addProposal({
    ...input,
    ...(issues.length > 0 ? { issues } : {}),
    ...(batches.length > 0 ? { batches } : {}),
    supersedes: [...over.flatMap(earlier => earlier.supersedes ?? []), ...over.map(earlier => earlier.id)],
    rationale: input.rationale !== undefined ? `${input.rationale}${lang === 'zh' ? '' : ' '}${says}` : says,
  })
  for (const earlier of over) await project.supersedeProposal(earlier.id, proposal.id)
  return { proposal, replaced: over.length }
}

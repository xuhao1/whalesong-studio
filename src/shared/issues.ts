/**
 * What review issues and the proposals that mend them have to do with each other — the same for the Studio's pages,
 * which show the proposals beneath their issue, and for the tools, which tell the showrunner so.
 */

import type { Proposal, ReviewIssue } from './types'

/**
 * The changes that wait to mend an issue: made for it by name — or, where it was handed over with a batch, that
 * batch's (of the batch, a change to this very chapter that names other issues is theirs, and shown beneath them).
 */
export function mendsOf(proposals: readonly Proposal[], chapterId: string, issue: ReviewIssue): Proposal[] {
  return proposals.filter(proposal => proposal.status === 'pending' && (proposal.issues?.includes(issue.id) === true || (issue.mending !== undefined && (proposal.batchId === issue.mending || proposal.batches?.includes(issue.mending) === true) && !(proposal.chapterId === chapterId && (proposal.issues?.length ?? 0) > 0))))
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What more than one page starts, started one way.
 *
 * A chapter is reviewed from the review page, the writing page and the page
 * it is read on; it is digested from the overview and from where it is
 * written; a set of proposals is settled where a chapter is written and where
 * all of them are listed; the planner looks over the names without a card
 * from the cast and from the suggestions. Each of those is one operation —
 * the same request, the same thing said when it goes wrong — whichever
 * button it is under: kept here, so that it is changed in one place.
 */
import type { Proposal } from '../shared/types'
import { useProject, useShared, useStudio, useT } from './ui'

export interface BookActions {
  /**
   * Have a chapter reviewed. What the review finds goes on to be mended by itself — each change a proposal beneath its
   * issue — unless the author has that switched off (`reviewMends`, see `useReviewMends`).
   */
  review: (chapter: string) => Promise<void>
  /** Digest chapters: the ones named — again, where they were digested before — or, with none named, every one that is not. */
  digest: (chapters?: readonly string[]) => Promise<void>
  /**
   * Clear a chapter's memory: its digest, and what the digest left in the book. What went is said. (The author is
   * asked first by whoever shows the button: `forgetAsk` is the question.)
   */
  forget: (chapter: string) => Promise<void>
  forgetAsk: string
  /** Have the planner look over the names that have no card: the ones not looked at yet, or (`again`) all of them. */
  siftCast: (again: boolean) => Promise<void>
  /**
   * Take or turn down every proposal of a set, in the order they stand in the text (a change further down is still
   * found when the ones above it went in first). What could not be settled is said, and the rest are settled all the same.
   */
  settleProposals: (proposals: readonly Proposal[], accept: boolean) => Promise<void>
}

export function useBookActions(): BookActions {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [order] = useShared<'queue' | 'apart'>('mend.order', 'queue')
  return {
    review: async (chapter) => {
      // (The mending that follows takes its turn among the mendings as the author has them ordered.)
      await controller.api.call('ai.review', { root, chapter, order })
      await controller.refreshJobs()
    },
    digest: async (chapters) => {
      await controller.api.call('ai.digest', chapters !== undefined ? { root, chapters: [...chapters], force: true } : { root })
      await controller.refreshJobs()
    },
    forgetAsk: t('清除这一章的记忆？收录出来的摘要、事实、人物状态会删掉；它在线索上留的“埋于 / 推进于这一章”、章纲里由收录填上的空栏、它提的还没处理的建议也一起去掉。正文不动；要记忆时再点“收录”。', 'Clear this chapter\'s memory? Its summary, facts and where its people stand are deleted — with the marks it left on the threads, the blanks of the plan the digest filled, and what it suggested that still waits. The text is not touched; a digest brings the memory back.'),
    forget: async (chapter) => {
      const done = await controller.api.call('chapter.forget', { root, id: chapter })
      await controller.refreshProject()
      if (!done.forgot) {
        controller.toast('info', t('这一章本来就没有记忆。', 'This chapter had no memory.'))
        return
      }
      const names: Record<string, [string, string]> = { synopsis: ['梗概', 'synopsis'], location: ['地点', 'place'], time: ['故事时间', 'story time'], characters: ['出场人物', 'cast'], threads: ['线索', 'threads'] }
      const fields = done.fields.map(field => t(...(names[field] ?? [field, field]))).join(t('、', ', '))
      controller.toast('success', [
        t('这一章的记忆清掉了', 'The chapter\'s memory is cleared'),
        ...(fields.length > 0 ? [t(`章纲里由收录填上的${fields}清空了`, `the plan's ${fields}, filled by the digest, emptied`)] : []),
        ...(done.threads > 0 ? [t(`从 ${done.threads} 条线索上去掉了这一章的记号${done.gone > 0 ? `（其中 ${done.gone} 条只有这一章提过，没人确认，已删）` : ''}`, `its marks taken off ${done.threads} thread(s)${done.gone > 0 ? ` (${done.gone} that only it had proposed are gone)` : ''}`)] : []),
        ...(done.suggestions > 0 ? [t(`它提的 ${done.suggestions} 条建议撤了`, `${done.suggestions} suggestion(s) of its dropped`)] : []),
      ].join(t('；', '; ')) + t('。', '.'))
    },
    siftCast: async (again) => {
      await controller.api.call('cast.sift', { root, ...(again ? { all: true } : {}) })
      await controller.refreshJobs()
    },
    settleProposals: async (proposals, accept) => {
      let failed = 0
      for (const proposal of [...proposals].sort((left, right) => (left.chapterId === right.chapterId ? (left.at ?? 0) - (right.at ?? 0) : 0))) {
        try {
          if (accept) await controller.api.call('proposal.accept', { root, id: proposal.id })
          else await controller.api.call('proposal.reject', { root, id: proposal.id })
        } catch {
          failed += 1
        }
      }
      if (failed > 0) controller.toast('error', t(`${failed} 条提案没能处理，正文可能已被改过`, `${failed} proposal(s) could not be applied: the text may have changed`))
    },
  }
}

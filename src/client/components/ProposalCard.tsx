// SPDX-License-Identifier: LGPL-3.0-or-later
/** A pending manuscript change with its diff and the accept / reject decision. */
import { useMemo, useState } from 'react'
import { countWords } from '../../shared/text'
import type { Proposal, SettledProposal } from '../../shared/types'
import { figuresKeptWord, picturesReadWord } from '../Guides'
import { compactDiff, diffInline, diffText } from '../diff'
import { useBookActions } from '../actions'
import { Button, Chip, cx, useAction, useConfirm, useProject, useStudio, useT } from '../ui'

export function DiffView({ before, after, whole }: { before: string; after: string; whole?: boolean }) {
  const parts = useMemo(() => {
    const full = before.length + after.length > 1200 || before.includes('\n') ? diffText(before, after) : diffInline(before, after)
    return whole === true ? full : compactDiff(full)
  }, [before, after, whole])
  return (
    <div className="nv-diff">
      {parts.map((part, index) => part.kind === 'gap'
        ? <span key={index} className="nv-diff-gap">⋯</span>
        : <span key={index} className={cx(part.kind === 'add' && 'nv-diff-add', part.kind === 'del' && 'nv-diff-del')}>{part.text}</span>)}
    </div>
  )
}

/**
 * Every proposal of a set taken or turned down in one go — the same two buttons wherever proposals are listed: in a
 * chapter's panel, beneath the issues they mend, on the page of them all. They are settled in the order they stand in
 * the text; what could not be is said, and the rest are settled all the same.
 * @param ask - the author is asked before they are taken, too (a set that is not all in view); turning down is always
 *   asked, and so is taking a set that reaches into more than one chapter — part of it is not on the page in hand.
 */
export function SettleAll({ proposals, ask, onSettled }: { proposals: readonly Proposal[]; ask?: boolean; onSettled?: (accepted: boolean) => void }) {
  const t = useT()
  const actions = useBookActions()
  const confirm = useConfirm()
  const { busy, run } = useAction()
  const count = proposals.length
  const chapters = new Set(proposals.map(proposal => proposal.chapterId)).size
  const within = chapters > 1 ? t(`（${chapters} 章）`, ` (in ${chapters} chapters)`) : ''
  const settle = (accept: boolean): void => {
    void run(async () => {
      await actions.settleProposals(proposals, accept)
      onSettled?.(accept)
    })
  }
  return (
    <>
      <Button size="sm" variant="ghost" busy={busy} disabled={count === 0} onClick={() => { confirm.ask(t(`放弃这 ${count} 处修订${within}？放弃的留在“归档”里，可以放回。`, `Turn down these ${count} change(s)${within}? They are kept in the archive and can be put back.`), () => { settle(false) }) }}>{t('全部放弃', 'Reject all')}</Button>
      <Button size="sm" variant="primary" icon="check" busy={busy} disabled={count === 0} onClick={() => {
        if (ask === true || chapters > 1) confirm.ask(t(`采纳这 ${count} 处修订${within}？采纳前的正文会存入各章的“版本”。`, `Accept these ${count} change(s)${within}? The text before each is kept under Versions.`), () => { settle(true) })
        else settle(true)
      }}>{t('全部采纳', 'Accept all')}</Button>
      {confirm.element}
    </>
  )
}

/** @param bare - beneath the issue it mends: what it was asked is the issue above, and is not said again. */
export function ProposalCard({ proposal, showChapter, onSettled, bare }: { proposal: Proposal; showChapter?: boolean; onSettled?: (accepted: boolean) => void; bare?: boolean }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const [whole, setWhole] = useState(false)
  const chapter = project.chapters.find(candidate => candidate.id === proposal.chapterId)
  const delta = countWords(proposal.after) - countWords(proposal.before)
  const settle = (accept: boolean): Promise<unknown> => run(async () => {
    if (accept) await controller.api.call('proposal.accept', { root, id: proposal.id })
    else await controller.api.call('proposal.reject', { root, id: proposal.id })
    onSettled?.(accept)
  })
  return (
    <article className="nv-proposal">
      <header className="nv-proposal-head">
        <Chip tone={proposal.kind === 'chapter' ? 'violet' : 'blue'}>{proposal.kind === 'chapter' ? t('整章', 'Chapter') : t('片段', 'Passage')}</Chip>
        {showChapter === true && chapter !== undefined ? (
          <button type="button" className="nv-link" onClick={() => { controller.setView('write', chapter.id) }}>{t(`第 ${chapter.index} 章 ${chapter.title}`, `Ch. ${chapter.index} ${chapter.title}`)}</button>
        ) : null}
        <span className="nv-muted nv-small">{proposal.createdBy === 'agent' ? t('总编提出', 'by the agent') : t('你发起', 'yours')}{proposal.wroteBy !== undefined ? ` · ${proposal.wroteBy === 'planner' ? t('策划写的', 'written by the planner') : t('写手写的', 'written by the writer')}` : ''} · {delta >= 0 ? '+' : ''}{delta}{t(' 字', ' words')}</span>
      </header>
      {bare === true ? null : <p className="nv-proposal-instruction">{proposal.instruction}</p>}
      {proposal.rationale !== undefined ? <p className="nv-muted nv-small">{proposal.rationale}</p> : null}
      {proposal.pictures !== undefined ? <p className="nv-muted nv-small">{picturesReadWord(proposal.pictures, t)}</p> : null}
      {proposal.figures !== undefined ? <p className="nv-muted nv-small">{figuresKeptWord(proposal.figures, t)}</p> : null}
      <DiffView before={proposal.before} after={proposal.after} whole={whole} />
      <footer className="nv-proposal-foot">
        <Button size="sm" variant="ghost" onClick={() => { setWhole(value => !value) }}>{whole ? t('只看改动', 'Changes only') : t('看全文对比', 'Full text')}</Button>
        <span className="nv-spacer" />
        <Button size="sm" variant="ghost" icon="x" busy={busy} onClick={() => { settle(false) }}>{t('放弃', 'Reject')}</Button>
        <Button size="sm" variant="primary" icon="check" busy={busy} onClick={() => { settle(true) }}>{t('采纳', 'Accept')}</Button>
      </footer>
    </article>
  )
}

/**
 * A proposal the author settled, as the archive shows it. One that was turned down can be put back to wait, or taken
 * after all — a no that was a slip of the hand is not the end of it.
 * @param bare - under the instruction of its round, which is said once above.
 */
export function SettledCard({ proposal, showChapter, bare, onChanged }: { proposal: SettledProposal; showChapter?: boolean; bare?: boolean; onChanged?: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const [whole, setWhole] = useState(false)
  const chapter = project.chapters.find(candidate => candidate.id === proposal.chapterId)
  const down = proposal.status === 'rejected'
  // A passage whose sentences are gone from the chapter cannot be taken any more; a whole chapter can, over what came since.
  const gone = proposal.kind === 'span' && !proposal.stands
  const back = (accept: boolean): Promise<unknown> => run(async () => {
    await controller.api.call('proposal.restore', { root, id: proposal.id })
    if (accept) await controller.api.call('proposal.accept', { root, id: proposal.id })
    controller.toast('success', accept ? t('采纳了，已写进正文', 'Accepted, and written into the text') : t('放回去了：它又在待处理的提案里', 'Put back: it waits among the proposals again'))
    onChanged?.()
  })
  const when = new Date(proposal.settledAt ?? proposal.createdAt).toLocaleString()
  return (
    <article className="nv-proposal nv-proposal-settled">
      <header className="nv-proposal-head">
        <Chip tone={down ? 'amber' : 'green'}>{down ? t('已放弃', 'Turned down') : t('已采纳', 'Accepted')}</Chip>
        <Chip tone={proposal.kind === 'chapter' ? 'violet' : 'blue'}>{proposal.kind === 'chapter' ? t('整章', 'Chapter') : t('片段', 'Passage')}</Chip>
        {showChapter === true && chapter !== undefined ? (
          <button type="button" className="nv-link" onClick={() => { controller.setView('write', chapter.id) }}>{t(`第 ${chapter.index} 章 ${chapter.title}`, `Ch. ${chapter.index} ${chapter.title}`)}</button>
        ) : null}
        <span className="nv-muted nv-small">{proposal.settledAt !== undefined ? when : t(`提出于 ${when}`, `made ${when}`)}</span>
      </header>
      {bare === true ? null : <p className="nv-proposal-instruction">{proposal.instruction}</p>}
      {proposal.rationale !== undefined ? <p className="nv-muted nv-small">{proposal.rationale}</p> : null}
      <DiffView before={proposal.before} after={proposal.after} whole={whole} />
      {down && !proposal.stands ? (
        <p className="nv-note nv-small">{gone
          ? t('它要改的那几句已经不在正文里了：放回去也采纳不了。', 'The sentences it changes are no longer in the chapter: put back, it could not be taken.')
          : t('这一章在它之后改过：采纳它，会用它的整章盖掉之后的改动（之前的正文在“版本”里）。', 'The chapter was changed since: taken, it writes its whole chapter over what came after (the text before is kept under Versions).')}</p>
      ) : null}
      <footer className="nv-proposal-foot">
        <Button size="sm" variant="ghost" onClick={() => { setWhole(value => !value) }}>{whole ? t('只看改动', 'Changes only') : t('看全文对比', 'Full text')}</Button>
        <span className="nv-spacer" />
        {down ? (
          <>
            <Button size="sm" variant="ghost" icon="undo" busy={busy} disabled={gone} onClick={() => { back(false) }} title={t('放回待处理的提案里，之后再定', 'Back among the waiting proposals, to settle later')}>{t('放回', 'Put back')}</Button>
            <Button size="sm" variant="primary" icon="check" busy={busy} disabled={gone} onClick={() => { back(true) }}>{t('采纳', 'Accept')}</Button>
          </>
        ) : <span className="nv-muted nv-small">{t('要撤回，用这一章的“版本”', 'To undo it, use the chapter\'s Versions')}</span>}
      </footer>
    </article>
  )
}

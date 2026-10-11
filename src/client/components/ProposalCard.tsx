// SPDX-License-Identifier: LGPL-3.0-or-later
/** A pending manuscript change with its diff and the accept / reject decision. */
import { useMemo, useState } from 'react'
import { countWords } from '../../shared/text'
import type { Proposal } from '../../shared/types'
import { picturesReadWord } from '../Guides'
import { compactDiff, diffInline, diffText } from '../diff'
import { Button, Chip, cx, useAction, useProject, useStudio, useT } from '../ui'

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
        <span className="nv-muted nv-small">{proposal.createdBy === 'agent' ? t('总编提出', 'by the agent') : t('你发起', 'yours')} · {delta >= 0 ? '+' : ''}{delta}{t(' 字', ' words')}</span>
      </header>
      {bare === true ? null : <p className="nv-proposal-instruction">{proposal.instruction}</p>}
      {proposal.rationale !== undefined ? <p className="nv-muted nv-small">{proposal.rationale}</p> : null}
      {proposal.pictures !== undefined ? <p className="nv-muted nv-small">{picturesReadWord(proposal.pictures, t)}</p> : null}
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

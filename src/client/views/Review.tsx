// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The decision desk: revision proposals to accept or reject, bible suggestions
 * found while digesting, review issues per chapter, and book-wide revisions
 * (including carrying a changed setting or character through the manuscript).
 */
import { useState } from 'react'
import { clip } from '../../shared/text'
import type { Proposal, TextStep } from '../../shared/types'
import { ProposalCard } from '../components/ProposalCard'
import { SUGGESTION_KIND } from '../labels'
import { BatchMatrix, batchOf, useBatchJob } from '../Batch'
import {
  Button, Chip, cx, Empty, Field, Progress, SectionTitle, Select, Tabs, TextArea, useAction, useConfirm, useProject, useSnapshot, useStudio, useT,
} from '../ui'
import { JobBar } from '../JobBar'

type ReviewTab = 'proposals' | 'suggestions' | 'issues' | 'book'

export function ReviewView() {
  const t = useT()
  const { project } = useProject()
  const [tab, setTab] = useState<ReviewTab>(project.proposals.length > 0 || project.suggestions.length === 0 ? 'proposals' : 'suggestions')
  const issues = project.chapters.reduce((sum, chapter) => sum + (chapter.openIssues ?? 0), 0)
  return (
    <div className="nv-page nv-review">
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'proposals', label: t('修订提案', 'Proposals'), icon: 'pen', badge: project.proposals.length },
        { value: 'suggestions', label: t('设定建议', 'Bible suggestions'), icon: 'sparkles', badge: project.suggestions.length },
        { value: 'issues', label: t('审校问题', 'Issues'), icon: 'alert', badge: issues },
        { value: 'book', label: t('全书修订', 'Book-wide revision'), icon: 'wand' },
      ]} />
      {tab === 'proposals' ? <Proposals /> : null}
      {tab === 'suggestions' ? <Suggestions /> : null}
      {tab === 'issues' ? <Issues /> : null}
      {tab === 'book' ? <BookRevision onStarted={() => { setTab('proposals') }} /> : null}
    </div>
  )
}

function Proposals() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const order = new Map(project.chapters.map(chapter => [chapter.id, chapter.index]))
  const sorted = [...project.proposals].sort((left, right) => (order.get(left.chapterId) ?? 0) - (order.get(right.chapterId) ?? 0))
  const groups = new Map<string, Proposal[]>()
  for (const proposal of sorted) {
    const key = proposal.batchId ?? ''
    groups.set(key, [...(groups.get(key) ?? []), proposal])
  }
  const settleAll = (items: Proposal[], accept: boolean): Promise<unknown> => run(async () => {
    let failed = 0
    for (const proposal of items) {
      try {
        if (accept) await controller.api.call('proposal.accept', { root, id: proposal.id })
        else await controller.api.call('proposal.reject', { root, id: proposal.id })
      } catch {
        failed += 1
      }
    }
    if (failed > 0) controller.toast('error', t(`${failed} 条提案没能处理，正文可能已被改过`, `${failed} proposal(s) could not be applied: the text may have changed`))
  })
  if (project.proposals.length === 0) {
    return <Empty icon="checkCircle" title={t('没有待处理的提案', 'No proposals waiting')}>{t('写手和修订提出的改动会先来到这里。', 'Changes the writer and revisions propose arrive here first.')}</Empty>
  }
  return (
    <div className="nv-proposals">
      {[...groups.entries()].map(([batch, items]) => (
        <section key={batch} className="nv-card">
          <SectionTitle actions={items.length > 1 ? (
            <>
              <Button size="sm" variant="ghost" busy={busy} onClick={() => { confirm.ask(t(`放弃这 ${items.length} 条提案？`, `Reject these ${items.length} proposals?`), () => { settleAll(items, false) }) }}>{t('全部放弃', 'Reject all')}</Button>
              <Button size="sm" variant="primary" icon="check" busy={busy} onClick={() => { confirm.ask(t(`采纳这 ${items.length} 条提案？采纳前的正文会存入各章的"版本"。`, `Accept these ${items.length} proposals? The text before each one is kept under Versions.`), () => { settleAll(items, true) }) }}>{t('全部采纳', 'Accept all')}</Button>
            </>
          ) : undefined}>{batch.length > 0 ? t(`全书修订 · ${items.length} 章`, `Book-wide revision · ${items.length} chapters`) : t('单独的提案', 'Individual proposals')}</SectionTitle>
          {batch.length > 0 ? <p className="nv-proposal-instruction">{items[0]!.instruction}</p> : null}
          {items.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} showChapter />)}
        </section>
      ))}
      {confirm.element}
    </div>
  )
}

function Suggestions() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const index = new Map(project.chapters.map(chapter => [chapter.id, chapter]))
  const settle = (id: string, accept: boolean): void => {
    void run(async () => { await controller.api.call(accept ? 'suggestion.accept' : 'suggestion.dismiss', { root, id }) })
  }
  const settleAll = (accept: boolean): Promise<unknown> => run(async () => {
    for (const suggestion of project.suggestions) {
      try {
        await controller.api.call(accept ? 'suggestion.accept' : 'suggestion.dismiss', { root, id: suggestion.id })
      } catch {
        // One stale suggestion must not stop the rest.
      }
    }
  })
  if (project.suggestions.length === 0) {
    return <Empty icon="sparkles" title={t('没有待处理的设定建议', 'No bible suggestions waiting')}>{t('收录章节时发现的新人物、地点和线索会列在这里。', 'New people, places and threads found while digesting are listed here.')}</Empty>
  }
  return (
    <div className="nv-suggestions">
      <div className="nv-toolbar">
        <span className="nv-muted">{t('正文里有、设定里还没有的。采纳会写入设定或大纲。', 'In the text and not yet in the bible. Accepting writes it to the bible or the outline.')}</span>
        <span className="nv-spacer" />
        <Button size="sm" variant="ghost" busy={busy} onClick={() => { settleAll(false) }}>{t('全部忽略', 'Dismiss all')}</Button>
        <Button size="sm" variant="primary" icon="check" busy={busy} onClick={() => { settleAll(true) }}>{t('全部采纳', 'Accept all')}</Button>
      </div>
      <ul className="nv-suggestion-list">
        {project.suggestions.map((suggestion) => {
          const chapter = suggestion.chapterId !== undefined ? index.get(suggestion.chapterId) : undefined
          return (
            <li key={suggestion.id} className="nv-suggestion nv-card">
              <div className="nv-suggestion-main">
                <div className="nv-row-wrap">
                  <Chip tone={suggestion.kind.startsWith('new-') ? 'blue' : 'amber'}>{t(...SUGGESTION_KIND[suggestion.kind])}</Chip>
                  <strong>{suggestion.title}</strong>
                  {chapter !== undefined ? <button type="button" className="nv-link nv-small" onClick={() => { controller.setView('read', chapter.id) }}>{t(`第 ${chapter.index} 章`, `Ch. ${chapter.index}`)}</button> : null}
                </div>
                <p>{suggestion.detail}</p>
              </div>
              <div className="nv-row">
                <Button size="sm" variant="ghost" busy={busy} onClick={() => { settle(suggestion.id, false) }}>{t('忽略', 'Dismiss')}</Button>
                <Button size="sm" variant="primary" busy={busy} onClick={() => { settle(suggestion.id, true) }}>{t('采纳', 'Accept')}</Button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Issues() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const written = project.chapters.filter(chapter => chapter.hasText)
  const pending = written.filter(chapter => chapter.openIssues === undefined)
  const undigested = written.filter(chapter => !chapter.digested)
  // One batch: the chapters are reviewed side by side, as many at once as the settings allow.
  const batchJob = useBatchJob('text')
  const batch = batchJob?.status === 'running' ? batchJob : undefined
  const reviewing = new Set([
    ...jobs.filter(job => job.status === 'running' && job.kind === 'review').map(job => job.target),
    ...(batchOf(batch)?.rows.filter(row => row.steps.review?.state === 'running').map(row => row.id) ?? []),
  ])
  const start = (steps: TextStep[], chapters: string[]): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('batch.text', { root, steps, chapters })
    await controller.refreshJobs()
  })
  if (written.length === 0) return <Empty icon="alert" title={t('还没有可审校的正文', 'No prose to review yet')} />
  return (
    <div className="nv-issues">
      <div className="nv-toolbar">
        <span className="nv-muted">{t('审校对照设定、记忆与文风逐章检查。', 'A review checks each chapter against the bible, memory and style.')}</span>
        <span className="nv-spacer" />
        {batch === undefined && undigested.length > 0 ? <Button size="sm" icon="layers" pending={t('正在开始…', 'Starting…')} onClick={() => start(['digest'], undigested.map(chapter => chapter.id))} title={t('审校要对照记忆：先把还没收录的章节收录进去', 'A review checks against memory: take the chapters that are not digested yet into it first')}>{t(`收录未收录的 ${undigested.length} 章`, `Digest ${undigested.length} chapters`)}</Button> : null}
        {batch === undefined && pending.length > 0 ? <Button size="sm" icon="checkCircle" pending={t('正在开始…', 'Starting…')} onClick={() => start(['review'], pending.map(chapter => chapter.id))}>{t(`一键审校未审的 ${pending.length} 章`, `Review ${pending.length} unreviewed chapters`)}</Button> : null}
        {batch === undefined && pending.length === 0 && written.length > 1 ? <Button size="sm" variant="ghost" icon="refresh" pending={t('正在开始…', 'Starting…')} onClick={() => controller.guard(async () => { await controller.api.call('batch.text', { root, steps: ['review'], chapters: written.map(chapter => chapter.id), redo: true }); await controller.refreshJobs() })}>{t('全部重审', 'Review all again')}</Button> : null}
      </div>
      {batchJob !== undefined && (batch !== undefined || batchJob.status !== 'done' || (batchOf(batchJob)?.failed ?? 0) > 0) ? <div className="nv-card"><BatchMatrix job={batchJob} compact /></div> : null}
      <ul className="nv-list nv-card">
        {written.map(chapter => (
          <li key={chapter.id}>
            <div className="nv-list-row is-static">
              <span className="nv-list-index">{chapter.index}</span>
              <span className="nv-list-title">{chapter.title}</span>
              <span className="nv-list-side">
                {chapter.openIssues === undefined ? <Chip>{t('未审', 'Not reviewed')}</Chip> : chapter.openIssues === 0 ? <Chip tone="green">{t('无待办', 'Clear')}</Chip> : <Chip tone="amber">{t(`${chapter.openIssues} 个问题`, `${chapter.openIssues} open`)}</Chip>}
                <Button size="sm" variant="ghost" busy={reviewing.has(chapter.id)} disabled={batch !== undefined} onClick={() => controller.guard(async () => { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() })}>{chapter.openIssues === undefined ? t('审校', 'Review') : t('重审', 'Again')}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="eye"
                  onClick={() => {
                    // Looked at from the review: with what the review found marked in the text.
                    try {
                      localStorage.setItem('novel-studio:annotate', '1')
                    } catch {
                      // The notes can still be switched on there.
                    }
                    controller.setView('read', chapter.id)
                  }}
                  title={t('观看：在"观看"里读这一章，审校出的问题标在正文上', 'View: read the chapter in the viewer, with what the review found marked in the text')}
                />
                <Button size="sm" variant="ghost" icon="arrowRight" onClick={() => { controller.setView('write', chapter.id) }} title={t('打开这一章', 'Open the chapter')} />
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BookRevision({ onStarted }: { onStarted: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const [instruction, setInstruction] = useState('')
  const [scope, setScope] = useState<'auto' | 'pick'>('auto')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<{ note?: string; changed: number; untouched: number; failed: number } | undefined>()
  const written = project.chapters.filter(chapter => chapter.hasText)
  const running = jobs.find(job => job.status === 'running' && job.kind === 'revise' && job.title === 'revise book')

  const start = (): void => {
    setSummary(undefined)
    void controller.guard(async () => {
      const info = await controller.run('ai.reviseBook', { root, instruction: instruction.trim(), ...(scope === 'pick' && picked.size > 0 ? { chapters: [...picked] } : {}) })
      const output = info.result?.output as { note?: string; untouched?: number; results?: unknown[]; failed?: unknown[] } | undefined
      setSummary({ ...(output?.note !== undefined ? { note: output.note } : {}), changed: output?.results?.length ?? 0, untouched: output?.untouched ?? 0, failed: output?.failed?.length ?? 0 })
      if ((output?.results?.length ?? 0) > 0) onStarted()
    })
  }
  const fromWorld = (id: string): void => {
    const entry = project.world.find(candidate => candidate.id === id)
    if (entry === undefined) return
    setInstruction(t(
      `世界观设定「${entry.name}」已更新为：${clip([entry.summary, entry.body].filter(Boolean).join(' '), 600)}\n请找出正文中与新设定矛盾、或需要与之呼应的地方并改写；与此无关的内容一字不动。`,
      `The world entry "${entry.name}" now reads: ${clip([entry.summary, entry.body].filter(Boolean).join(' '), 600)}\nFind every place in the manuscript that contradicts it or should now reflect it, and rewrite those; leave everything else untouched.`,
    ))
  }
  const fromCharacter = (id: string): void => {
    const card = project.characters.find(candidate => candidate.id === id)
    if (card === undefined) return
    const facts = [card.tagline, card.personality, card.voice !== undefined ? t(`说话方式：${card.voice}`, `voice: ${card.voice}`) : undefined, card.appearance !== undefined ? t(`外貌：${card.appearance}`, `appearance: ${card.appearance}`) : undefined].filter(Boolean).join('；')
    setInstruction(t(
      `人物「${card.name}」的设定已更新：${clip(facts, 600)}\n请让正文中${card.name}的言行、外貌描写与对白都符合新设定；不改变情节走向，与此无关的内容一字不动。`,
      `The character "${card.name}" has been revised: ${clip(facts, 600)}\nMake ${card.name}'s actions, description and dialogue throughout the manuscript match; do not change the plot, and leave everything unrelated untouched.`,
    ))
  }

  return (
    <div className="nv-book-revision">
      <section className="nv-card">
        <SectionTitle>{t('对全书提一个修改要求', 'Ask for a change across the whole book')}</SectionTitle>
        <p className="nv-muted nv-small">{t('策划先判断哪些章节受影响，写手只改这些章；改动作为提案等你确认。', 'The planner decides which chapters are affected and the writer changes only those; each change waits as a proposal.')}</p>
        <div className="nv-form-grid">
          {project.world.length > 0 ? (
            <Field label={t('同步一条世界观变更', 'Carry a world change through')}>
              <Select value="" options={[{ value: '', label: t('选择设定条目…', 'Pick an entry…') }, ...project.world.map(entry => ({ value: entry.id, label: entry.name }))]} onChange={fromWorld} />
            </Field>
          ) : null}
          {project.characters.length > 0 ? (
            <Field label={t('同步一次人物变更', 'Carry a character change through')}>
              <Select value="" options={[{ value: '', label: t('选择人物…', 'Pick a character…') }, ...project.characters.map(card => ({ value: card.id, label: card.name }))]} onChange={fromCharacter} />
            </Field>
          ) : null}
        </div>
        <Field label={t('修改要求', 'The instruction')}>
          <TextArea value={instruction} minRows={4} maxRows={14} placeholder={t('例：把所有“灵力”改称“炁”并调整相关描写', 'E.g. call every "spirit power" "qi" and adjust the descriptions around it')} onChange={(event) => { setInstruction(event.target.value) }} />
        </Field>
        <Field label={t('范围', 'Scope')}>
          <Select value={scope} options={[{ value: 'auto', label: t('由策划判断哪些章节需要改', 'Let the planner decide which chapters change') }, { value: 'pick', label: t('只在我选的章节里改', 'Only the chapters I pick') }]} onChange={setScope} />
        </Field>
        {scope === 'pick' ? (
          <div className="nv-chips">
            {written.map(chapter => <Chip key={chapter.id} tone={picked.has(chapter.id) ? 'blue' : 'neutral'} active={picked.has(chapter.id)} onClick={() => { setPicked((previous) => { const next = new Set(previous); if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id); return next }) }}>{chapter.index}. {chapter.title}</Chip>)}
          </div>
        ) : null}
        {running !== undefined ? <JobBar job={running} /> : null}
        {summary !== undefined ? (
          <p className={cx('nv-note', summary.failed > 0 && 'is-warn')}>
            {t(`改了 ${summary.changed} 章，${summary.untouched} 章判断为不受影响${summary.failed > 0 ? `，${summary.failed} 章失败` : ''}。`, `${summary.changed} chapters changed, ${summary.untouched} judged unaffected${summary.failed > 0 ? `, ${summary.failed} failed` : ''}.`)}
            {summary.note !== undefined ? ` ${summary.note}` : ''}
          </p>
        ) : null}
        <div className="nv-form-actions">
          <Button variant="primary" icon="wand" busy={running !== undefined} disabled={instruction.trim().length === 0 || written.length === 0 || (scope === 'pick' && picked.size === 0)} onClick={start}>{t('开始修订', 'Start the revision')}</Button>
        </div>
      </section>
    </div>
  )
}

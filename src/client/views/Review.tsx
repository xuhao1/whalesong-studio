// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The decision desk: revision proposals to accept or reject, bible suggestions
 * found while digesting, review issues per chapter, and book-wide revisions
 * (including carrying a changed setting or character through the manuscript).
 */
import { Fragment, useState, type ReactNode } from 'react'
import { clip } from '../../shared/text'
import { MAIN_LINE, type ChapterInfo, type IssueSeverity, type PictureGuide, type PicturesRead, type Proposal, type TextStep } from '../../shared/types'
import { GuidePictures, picturesReadWord } from '../Guides'
import { ProposalCard } from '../components/ProposalCard'
import { SEVERITY, SEVERITY_TONE, SUGGESTION_KIND } from '../labels'
import { IssueBatchBar, IssueCard, MendOrderMenu, useMendOrder } from '../Issues'
import { Icon } from '../icons'
import { BatchMatrix, batchOf, useBatchJob } from '../Batch'
import {
  Button, Chip, cx, Empty, Field, Progress, SectionTitle, Select, Tabs, TextArea, TextInput, useAction, useBookLine, useConfirm, useKept, useLoad, useProject, useRunningJob, useSnapshot, useStudio, useT,
  ViewButton,
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
  // New people are not proposed chapter by chapter: the planner looks through the names without a card and says who
  // is worth one. The rest are walk-ons — on their own list, with what the planner said of each. (A Host from before
  // answers with an error: then this line is not shown.)
  const names = useLoad(async signal => await controller.api.call('cast.walkons', { root }, signal).catch(() => undefined), [root, project.revision])
  const sifting = useRunningJob(job => job.kind === 'bible' && job.title === 'sift cast') !== undefined
  const walkOns = names.data?.walkons ?? []
  const left = walkOns.filter(item => item.verdict?.is === 'walkon').length
  const due = walkOns.filter(item => item.verdict === undefined || item.chapters.length > item.verdict.seen)
  // Proposed chapter by chapter by an older version, and never looked at by the planner.
  const unsifted = project.suggestions.filter(item => item.kind === 'new-character' && item.sifted !== true).length
  const sift = (again: boolean): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('cast.sift', { root, ...(again ? { all: true } : {}) })
    await controller.refreshJobs()
  })
  const people = names.data === undefined || (unsifted === 0 && due.length === 0 && left === 0) ? null : (
    <div className="nv-note nv-sift">
      <span>
        {unsifted > 0 ? t(`${unsifted} 条"新人物"是以前逐章提的，没筛过。`, `${unsifted} "new character" suggestion(s) were made chapter by chapter and never looked through. `) : ''}
        {due.length > 0 ? t(`${due.length} 个没立卡的名字策划还没看过。`, `${due.length} name(s) without a card have not been looked at. `) : ''}
        {left > 0 ? t(`${left} 个名字被策划留作龙套。`, `${left} name(s) were left as walk-ons by the planner.`) : ''}
      </span>
      <span className="nv-spacer" />
      {left > 0 || due.length > 0 ? <button type="button" className="nv-link nv-small" onClick={() => { controller.setCastTab('walkons'); controller.setView('cast') }}>{t('去龙套名单看', 'See the walk-ons')}</button> : null}
      {unsifted > 0 || due.length > 0 ? <Button size="sm" icon="sparkles" busy={sifting} pending={t('策划在筛…', 'The planner is looking…')} onClick={() => sift(unsifted > 0)} title={t('策划逐个看：值得立卡的留在这里并写明理由，是别名的改成并入建议，其余回到龙套名单', 'The planner looks at each: worth a card stays here with the reason, another name becomes a suggestion to fold it in, the rest go back to the walk-ons')}>{t('让策划筛一遍', 'Have the planner look')}</Button> : null}
    </div>
  )
  // What the planner settled without asking: entered, folded into something there, left out — each to be changed here.
  // (A Host from before suggestions were settled answers with an error: then they wait one by one, as they did.)
  const settled = useLoad(async signal => await controller.api.call('suggestion.settled', { root }, signal).catch(() => undefined), [root, project.revision])
  const settling = useRunningJob(job => job.kind === 'bible' && job.title === 'settle suggestions') !== undefined
  const auto = settled.data?.auto === true
  const record = settled.data?.items ?? []
  const [more, setMore] = useKept<'entered' | 'skipped' | ''>('review.settled', 'entered')
  const overrule = (id: string, to: 'undo' | 'enter'): void => {
    void run(async () => {
      await controller.api.call('suggestion.overrule', { root, id, to })
      settled.reload()
    })
  }
  const settleNow = (): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('suggestion.settle', { root })
    await controller.refreshJobs()
  })
  const open = (target: { type: 'character' | 'world'; id: string }): void => {
    if (target.type === 'character') controller.openCharacter(target.id)
    else controller.openWorld(target.id)
  }
  const entered = record.filter(item => item.verdict === 'entered' || item.verdict === 'merged')
  const outside = record.filter(item => item.verdict === 'skipped' || item.verdict === 'undone')
  const row = (item: (typeof record)[number]) => {
    const chapter = item.chapterId !== undefined ? index.get(item.chapterId) : undefined
    const isIn = item.verdict === 'entered' || item.verdict === 'merged'
    return (
      <li key={item.id} className={cx('nv-suggestion nv-card nv-settled', !isIn && 'is-out')}>
        <div className="nv-suggestion-main">
          <div className="nv-row-wrap">
            <Chip tone={item.kind.startsWith('new-') ? 'blue' : 'amber'}>{t(...SUGGESTION_KIND[item.kind])}</Chip>
            <strong>{item.title}</strong>
            {item.verdict === 'merged' ? <span className="nv-muted nv-small">{t(`并入「${item.into ?? ''}」`, `folded into "${item.into ?? ''}"`)}</span> : null}
            {item.verdict === 'undone' ? <span className="nv-muted nv-small">{t('你撤回了', 'you took it back')}</span> : null}
            {chapter !== undefined ? <button type="button" className="nv-link nv-small" onClick={() => { controller.setView('read', chapter.id) }}>{t(`第 ${chapter.index} 章`, `Ch. ${chapter.index}`)}</button> : null}
          </div>
          {item.why !== undefined && item.why.length > 0 ? <p>{t('策划：', 'Planner: ')}{item.why}</p> : null}
          {item.detail.length > 0 && item.detail !== item.why ? <p className="nv-muted nv-small">{item.detail}</p> : null}
        </div>
        <div className="nv-row">
          {isIn && item.target !== undefined ? <Button size="sm" variant="ghost" onClick={() => { open(item.target!) }}>{t('打开', 'Open')}</Button> : null}
          {isIn && item.target === undefined && (item.kind === 'new-thread' || item.kind === 'thread-status') ? <Button size="sm" variant="ghost" onClick={() => { controller.setView('outline') }}>{t('去线索', 'Threads')}</Button> : null}
          {isIn
            ? <Button size="sm" variant="ghost" busy={busy} onClick={() => { overrule(item.id, 'undo') }}>{t('撤回', 'Take back')}</Button>
            : <Button size="sm" variant="primary" busy={busy} onClick={() => { overrule(item.id, 'enter') }}>{t('收进', 'Enter')}</Button>}
        </div>
      </li>
    )
  }
  const settledPart = record.length === 0 ? null : (
    <section className="nv-settled-part">
      <div className="nv-toolbar">
        <button type="button" className={cx('nv-fold-head', more === 'entered' && 'is-open')} onClick={() => { setMore(more === 'entered' ? '' : 'entered') }}>
          <Icon name={more === 'entered' ? 'chevronDown' : 'chevronRight'} size={14} />{t(`策划收进的 · ${entered.length}`, `Entered by the planner · ${entered.length}`)}
        </button>
        <button type="button" className={cx('nv-fold-head', more === 'skipped' && 'is-open')} onClick={() => { setMore(more === 'skipped' ? '' : 'skipped') }}>
          <Icon name={more === 'skipped' ? 'chevronDown' : 'chevronRight'} size={14} />{t(`没收进的 · ${outside.length}`, `Left out · ${outside.length}`)}
        </button>
      </div>
      {more === 'entered' ? (entered.length > 0 ? <ul className="nv-suggestion-list">{entered.map(row)}</ul> : <p className="nv-muted nv-small">{t('还没有。', 'Nothing yet.')}</p>) : null}
      {more === 'skipped' ? (outside.length > 0 ? <ul className="nv-suggestion-list">{outside.map(row)}</ul> : <p className="nv-muted nv-small">{t('没有。', 'None.')}</p>) : null}
    </section>
  )
  // What the planner put here after looking through the book comes first: it is what was asked for, and it has reasons.
  const ordered = [...project.suggestions].sort((left, right) => Number(right.sifted === true) - Number(left.sifted === true))
  // A change to what somebody wrote is the author's to say, whoever settles the rest.
  const mine = project.suggestions.filter(item => item.kind === 'bible-edit').length
  const theirs = project.suggestions.length - mine
  if (project.suggestions.length === 0) {
    return (
      <>
        {people}
        {record.length === 0
          ? <Empty icon="sparkles" title={t('没有待处理的设定建议', 'No bible suggestions waiting')}>{auto ? t('收录时发现的人物、地点、物件和线索，由策划审定后直接收进设定；收进了什么会列在这里。', 'People, places, things and threads found while digesting are settled by the planner and entered; what entered is listed here.') : t('策划筛出的新人物、收录时发现的地点和线索会列在这里。', 'New people the planner finds worth a card, and places and threads found while digesting, are listed here.')}</Empty>
          : <div className="nv-suggestions">{settledPart}</div>}
      </>
    )
  }
  return (
    <div className="nv-suggestions">
      {people}
      <div className="nv-toolbar">
        <span className="nv-muted">{auto && theirs > 0
          ? t(`${theirs} 条还没审定。`, `${theirs} not settled yet.`)
          : t('正文里有、设定里还没有的。采纳会写入设定或大纲。', 'In the text and not yet in the bible. Accepting writes it to the bible or the outline.')}</span>
        <span className="nv-spacer" />
        {settled.data !== undefined && theirs > 0 ? <Button size="sm" icon="sparkles" variant={auto ? 'primary' : 'outline'} busy={settling} pending={t('策划在审定…', 'The planner is settling…')} onClick={settleNow} title={t('策划逐条看：值得的收进设定，是别名的并入，其余不收；都列在下面，可以改', 'The planner looks at each: what is worth it enters the bible, another name is folded in, the rest is left out; all listed below, to be changed')}>{t(`让策划审定（${theirs}）`, `Have the planner settle (${theirs})`)}</Button> : null}
        <Button size="sm" variant="ghost" busy={busy} onClick={() => { settleAll(false) }}>{t('全部忽略', 'Dismiss all')}</Button>
        <Button size="sm" variant={auto ? 'outline' : 'primary'} icon="check" busy={busy} onClick={() => { settleAll(true) }}>{t('全部采纳', 'Accept all')}</Button>
      </div>
      <ul className="nv-suggestion-list">
        {ordered.map((suggestion) => {
          const chapter = suggestion.chapterId !== undefined ? index.get(suggestion.chapterId) : undefined
          return (
            <li key={suggestion.id} className="nv-suggestion nv-card">
              <div className="nv-suggestion-main">
                <div className="nv-row-wrap">
                  <Chip tone={suggestion.kind.startsWith('new-') ? 'blue' : 'amber'}>{t(...SUGGESTION_KIND[suggestion.kind])}</Chip>
                  <strong>{suggestion.title}</strong>
                  {suggestion.sifted === true ? <Chip tone="violet" title={t('策划看过全书里这个名字之后提的；下面是它的理由', 'Proposed by the planner after it looked at this name across the book; its reason is below')}>{t('策划筛出', 'planner')}</Chip> : null}
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
      {settledPart}
    </div>
  )
}

const GRAVITY: Record<IssueSeverity, number> = { high: 3, medium: 2, low: 1 }

/**
 * What the reviews found, across chapters: ticked into a batch that one planner mends together, or every one from a
 * severity up in one click. The bar is one; the issues are shown chapter by chapter, where the page unfolds a chapter.
 */
function useIssueBoard() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  // (A Host from before reviews were listed answers with an error: then there is no board, and the chapters as they were.)
  const listed = useLoad(async signal => await controller.api.call('review.list', { root }, signal).catch(() => undefined), [root, project.revision])
  const [level, setLevel] = useKept<IssueSeverity>('review.level', 'low')
  const [from, setFrom] = useKept<IssueSeverity>('review.from', 'high')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const confirm = useConfirm()
  const [order] = useMendOrder()
  const checking = useRunningJob(job => job.kind === 'review' && job.title === 'recheck issues') !== undefined
  const open = (listed.data?.reviews ?? []).flatMap(review => review.issues.filter(issue => issue.resolved !== true).map(issue => ({ review, issue, key: `${review.chapterId}/${issue.id}` })))
  const shown = open.filter(item => GRAVITY[item.issue.severity] >= GRAVITY[level])
  const chosen = shown.filter(item => picked.has(item.key))
  const grave = open.filter(item => GRAVITY[item.issue.severity] >= GRAVITY[from])
  const levels = (all: string, allEn: string): { value: IssueSeverity; label: string }[] => [
    { value: 'high', label: t('严重', 'High') },
    { value: 'medium', label: t('中等及以上', 'Medium and up') },
    { value: 'low', label: t(all, allEn) },
  ]
  const tick = (keys: string[], on: boolean): void => {
    setPicked((previous) => {
      const next = new Set(previous)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }
  const everyShown = shown.length > 0 && chosen.length === shown.length
  const of = (chapterId: string) => shown.filter(item => item.review.chapterId === chapterId)
  const toolbar = open.length === 0 ? null : (
    <div className="nv-card nv-issue-board">
      <div className="nv-toolbar">
        <span className="nv-muted nv-small">{t('显示', 'Show')}</span>
        <Select value={level} onChange={setLevel} options={levels('全部问题', 'Every issue')} />
        <button type="button" className="nv-link nv-small" disabled={shown.length === 0} onClick={() => { tick(shown.map(item => item.key), !everyShown) }}>{everyShown ? t('全不选', 'None') : t(`全选 ${shown.length} 个`, `All ${shown.length}`)}</button>
        <span className="nv-spacer" />
        <Button size="sm" variant="ghost" icon="refresh" busy={checking} pending={t('核对中…', 'Checking…')} title={t('对照现在的正文，把已经修好的标为已处理', 'Read them against the text as it stands and mark what is already mended')} onClick={() => controller.guard(async () => {
          await controller.api.call('review.recheck', { root })
          await controller.refreshJobs()
        })}>{t('核对', 'Check again')}</Button>
        <Select value={from} onChange={setFrom} options={levels('全部', 'All')} />
        <Button size="sm" icon="wand" disabled={grave.length === 0} onClick={() => {
          confirm.ask(t(`把 ${grave.length} 个问题交给策划一起修？改动会作为提案等你确认。`, `Hand ${grave.length} issue(s) to the planner to mend together? The changes wait as proposals.`), () => {
            void controller.guard(async () => {
              await controller.api.call('ai.fixIssues', { root, atLeast: from, order })
              await controller.refreshJobs()
              controller.toast('info', t(`策划正在把这 ${grave.length} 个问题放在一起看，改动会作为提案等你确认。`, `The planner is reading these ${grave.length} side by side; the changes will wait as proposals.`))
            })
          })
        }}>{t(`自动修复重大问题 · ${grave.length}`, `Mend the grave ones · ${grave.length}`)}</Button>
      </div>
      <IssueBatchBar chosen={chosen.map(item => ({ chapterId: item.review.chapterId, issue: item.issue }))} onStarted={() => { setPicked(new Set()) }} />
      {confirm.element}
    </div>
  )
  /** The issues of one chapter that the filter shows, as cards to tick. */
  const cards = (chapterId: string): ReactNode => {
    const mine = of(chapterId)
    if (mine.length === 0) return null
    const all = mine.every(item => picked.has(item.key))
    return (
      <div className="nv-issue-chapter">
        <button type="button" className="nv-link nv-small" onClick={() => { tick(mine.map(item => item.key), !all) }}>{all ? t('不选这一章', 'Untick these') : t(`选这一章的 ${mine.length} 个`, `Tick these ${mine.length}`)}</button>
        <div className="nv-issue-grid">
          {mine.map(item => <IssueCard key={item.key} chapterId={chapterId} issue={item.issue} selected={picked.has(item.key)} onSelect={(on) => { tick([item.key], on) }} onChanged={listed.reload} />)}
        </div>
      </div>
    )
  }
  return { toolbar, cards, shownIn: (chapterId: string): number => of(chapterId).length, pickedIn: (chapterId: string): number => of(chapterId).filter(item => picked.has(item.key)).length, counts: (chapterId: string): { severity: IssueSeverity; count: number }[] => (['high', 'medium', 'low'] as const).map(severity => ({ severity, count: of(chapterId).filter(item => item.issue.severity === severity).length })).filter(item => item.count > 0) }
}

function Issues() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const board = useIssueBoard()
  // Which chapters are unfolded to show their issues: a book's issues are read chapter by chapter, not as one long page.
  const [unfolded, setUnfolded] = useKept<string[]>('review.unfolded', [])
  // Line by line: the main one, then what each other line of the plot has of its own — every line counts its own chapters.
  const groups = [
    { id: MAIN_LINE, title: t('主线', 'Main line'), chapters: project.chapters.filter(chapter => chapter.hasText) },
    ...(project.lines ?? []).map(line => ({ id: line.id, title: project.outline.lines?.find(candidate => candidate.id === line.id)?.title ?? line.id, chapters: line.chapters.filter(chapter => chapter.hasText) })),
  ].filter(group => group.chapters.length > 0)
  const written = groups.flatMap(group => group.chapters)
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
  /** One chapter of the page: what was found in it, counted by how grave, and unfolded on a click. */
  const row = (chapter: ChapterInfo): ReactNode => (
    <li key={chapter.id}>
      <div className="nv-list-row is-static">
        <button type="button" className="nv-issue-fold" disabled={board.shownIn(chapter.id) === 0} aria-expanded={unfolded.includes(chapter.id)} onClick={() => { setUnfolded(unfolded.includes(chapter.id) ? unfolded.filter(id => id !== chapter.id) : [...unfolded, chapter.id]) }}>
          <Icon name={unfolded.includes(chapter.id) && board.shownIn(chapter.id) > 0 ? 'chevronDown' : 'chevronRight'} size={14} />
          <span className="nv-list-index">{chapter.index}</span>
          <span className="nv-list-title">{chapter.title}</span>
          {board.counts(chapter.id).map(item => <Chip key={item.severity} tone={SEVERITY_TONE[item.severity]}>{t(`${item.count} ${SEVERITY[item.severity][0]}`, `${item.count} ${SEVERITY[item.severity][1].toLowerCase()}`)}</Chip>)}
          {board.pickedIn(chapter.id) > 0 ? <Chip tone="blue">{t(`已选 ${board.pickedIn(chapter.id)}`, `${board.pickedIn(chapter.id)} ticked`)}</Chip> : null}
        </button>
        <span className="nv-list-side">
          {chapter.openIssues === undefined ? <Chip>{t('未审', 'Not reviewed')}</Chip> : chapter.openIssues === 0 ? <Chip tone="green">{t('无待办', 'Clear')}</Chip> : board.counts(chapter.id).length > 0 ? null : <Chip tone="amber">{t(`${chapter.openIssues} 个问题`, `${chapter.openIssues} open`)}</Chip>}
          <Button size="sm" variant="ghost" busy={reviewing.has(chapter.id)} disabled={batch !== undefined} onClick={() => controller.guard(async () => { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() })}>{chapter.openIssues === undefined ? t('审校', 'Review') : t('重审', 'Again')}</Button>
          <Button size="sm" variant="ghost" icon="arrowRight" onClick={() => { controller.setView('write', chapter.id) }} title={t('打开这一章', 'Open the chapter')} />
          <ViewButton
            bare
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
        </span>
      </div>
      {unfolded.includes(chapter.id) ? board.cards(chapter.id) : null}
    </li>
  )
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
      {board.toolbar}
      <ul className="nv-list nv-card">
        {groups.map(group => (
          <Fragment key={group.id}>
            {groups.length > 1 ? <li className="nv-review-line"><Icon name="branch" size={12} /><span>{group.title}</span><span className="nv-muted nv-small">{t(`${group.chapters.length} 章`, `${group.chapters.length} chapters`)}</span></li> : null}
            {group.chapters.map(row)}
          </Fragment>
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
  const [summary, setSummary] = useState<{ note?: string; changed: number; untouched: number; failed: number; pictures?: PicturesRead } | undefined>()
  // Pictures the revision goes by: the planner scopes it with them, and every chapter is rewritten by them.
  const [guides, setGuides] = useState<PictureGuide[]>([])
  // A revision is of one line of the plot: its chapters as they are read on it.
  const others = project.outline.lines ?? []
  const [line, setLine] = useBookLine()
  const known = new Map([...project.chapters, ...(project.lines ?? []).flatMap(candidate => candidate.chapters)].map(info => [info.id, info]))
  const path = line === MAIN_LINE ? project.chapters : (project.lines?.find(candidate => candidate.id === line)?.path ?? []).map(id => known.get(id)).filter((info): info is ChapterInfo => info !== undefined)
  const written = path.filter(chapter => chapter.hasText)
  const underWay = jobs.filter(job => job.status === 'running' && job.kind === 'revise' && job.project === root && job.title === 'revise book')
  const [order] = useMendOrder()

  const start = (): void => {
    setSummary(undefined)
    void controller.guard(async () => {
      const info = await controller.run('ai.reviseBook', { root, instruction: instruction.trim(), order, ...(guides.length > 0 ? { guides } : {}), ...(line !== MAIN_LINE ? { line } : {}), ...(scope === 'pick' && picked.size > 0 ? { chapters: [...picked].filter(id => written.some(chapter => chapter.id === id)) } : {}) })
      const output = info.result?.output as { note?: string; untouched?: number; results?: unknown[]; failed?: unknown[]; pictures?: PicturesRead } | undefined
      setSummary({ ...(output?.note !== undefined ? { note: output.note } : {}), changed: output?.results?.length ?? 0, untouched: output?.untouched ?? 0, failed: output?.failed?.length ?? 0, ...(output?.pictures !== undefined ? { pictures: output.pictures } : {}) })
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
        <GuidePictures value={guides} onChange={setGuides} hint={t('策划照着图划范围，每一章照着图改', 'The planner scopes it by them; each chapter is rewritten by them')} />
        {others.length > 0 ? (
          <Field label={t('哪条线', 'Which line')}>
            <Select value={line} options={[{ value: MAIN_LINE, label: t('主线', 'Main line') }, ...others.map(item => ({ value: item.id, label: item.title }))]} onChange={(value) => { setLine(value); setPicked(new Set()) }} />
          </Field>
        ) : null}
        <Field label={t('范围', 'Scope')}>
          <Select value={scope} options={[{ value: 'auto', label: t('由策划判断哪些章节需要改', 'Let the planner decide which chapters change') }, { value: 'pick', label: t('只在我选的章节里改', 'Only the chapters I pick') }]} onChange={setScope} />
        </Field>
        {scope === 'pick' ? (
          <div className="nv-chips">
            {written.map(chapter => <Chip key={chapter.id} tone={picked.has(chapter.id) ? 'blue' : 'neutral'} active={picked.has(chapter.id)} onClick={() => { setPicked((previous) => { const next = new Set(previous); if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id); return next }) }}>{chapter.index}. {chapter.title}</Chip>)}
          </div>
        ) : null}
        {underWay.map(job => <JobBar key={job.id} job={job} />)}
        {summary !== undefined ? (
          <p className={cx('nv-note', summary.failed > 0 && 'is-warn')}>
            {t(`改了 ${summary.changed} 章，${summary.untouched} 章判断为不受影响${summary.failed > 0 ? `，${summary.failed} 章失败` : ''}。`, `${summary.changed} chapters changed, ${summary.untouched} judged unaffected${summary.failed > 0 ? `, ${summary.failed} failed` : ''}.`)}
            {summary.note !== undefined ? ` ${summary.note}` : ''}
            {summary.pictures !== undefined ? ` ${picturesReadWord(summary.pictures, t)}。` : ''}
          </p>
        ) : null}
        <div className="nv-form-actions">
          <div className="nv-split-btn">
            <Button variant="primary" icon="wand" disabled={instruction.trim().length === 0 || written.length === 0 || (scope === 'pick' && picked.size === 0)} onClick={start}>{t('开始修订', 'Start the revision')}</Button>
            <MendOrderMenu />
          </div>
        </div>
      </section>
    </div>
  )
}

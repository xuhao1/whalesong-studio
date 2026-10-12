// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a review found, and what to do about it — the same card in the editor's
 * panel and over the reader's page.
 *
 * A problem can be mended where it was found, or wherever it reaches: a slip
 * of a name is a sentence, a contradiction is often half the book. And the
 * author has something to say about how: the card takes their words and hands
 * them on with the problem.
 *
 *   IssueCard     one issue: what is wrong, the author's say (kept with the issue), mend here / mend everywhere / settled; ticked, it is one of a batch
 *   LeadBar       a review led by the author: what they noticed, in a sentence — found in the book, filed as issues, mended
 *   issueMarks    where the issues of a chapter sit in its text, for a page that marks them
 */
import { MAIN_LINE, type ChapterInfo, type ChapterReview, type JobInfo, type ReviewIssue } from '../shared/types'
import { clip, fuzzyFind } from '../shared/text'
import { ISSUE_TYPE, SEVERITY, SEVERITY_TONE } from './labels'
import { ProposalCard } from './components/ProposalCard'
import { JobBar } from './JobBar'
import { useMaterialBy, useMaterialItems } from './Material'
import { useState, type ReactNode } from 'react'
import { Button, Chip, cx, Menu, Select, TextArea, TextInput, useAction, useBookLine, useKept, useProject, useRunningJob, useShared, useSnapshot, useStudio, useT } from './ui'

export interface IssueMark {
  id: string
  start: number
  end: number
  tone: 'red' | 'amber' | 'blue'
}

/**
 * Where a chapter's open issues sit in its text. An issue that quotes nothing,
 * or whose quote has been rewritten since, has no place on the page.
 * @returns `marks` in reading order, none overlapping another; `loose`: the issues with no place.
 */
export function issueMarks(text: string, review: ChapterReview | undefined): { marks: IssueMark[]; loose: ReviewIssue[] } {
  const marks: IssueMark[] = []
  const loose: ReviewIssue[] = []
  for (const issue of review?.issues ?? []) {
    if (issue.resolved === true) continue
    const range = issue.quote !== undefined && issue.quote.trim().length > 0 ? fuzzyFind(text, issue.quote.trim()) : undefined
    if (range === undefined) {
      loose.push(issue)
      continue
    }
    const tone = SEVERITY_TONE[issue.severity]
    marks.push({ id: issue.id, start: range.start, end: range.end, tone: tone === 'red' ? 'red' : tone === 'amber' ? 'amber' : 'blue' })
  }
  marks.sort((left, right) => left.start - right.start || right.end - left.end)
  const kept: IssueMark[] = []
  for (const mark of marks) {
    // Two issues about the same words: the first is marked, the other is found through it or in the list.
    if (kept.length > 0 && mark.start < kept.at(-1)!.end) continue
    kept.push(mark)
  }
  return { marks: kept, loose }
}

/** How a mending asked for while others are under way is taken: after them, going on from what they change — or at once, by itself. */
export type MendOrder = 'queue' | 'apart'

/** The order mendings are asked for in: one choice for every button on screen. In line unless the author says otherwise — the surer way. */
export function useMendOrder(): [MendOrder, (order: MendOrder) => void] {
  return useShared<MendOrder>('mend.order', 'queue')
}

/** Whose model writes: the writer's, or the crew's (the planner). */
export type MendBy = 'writer' | 'planner'

/**
 * Who writes them, as the Studio's settings have it (`mendBy`) — and the way to say otherwise from beside the buttons
 * that mend: it is a setting, kept, since it says which of the author's models is fit for the work.
 */
export function useMendBy(): [MendBy, (by: MendBy) => void] {
  const { controller } = useStudio()
  // (The crew's model unless the author set the writer's: a change pinned to a sentence or two is its kind of work.)
  const by: MendBy = useSnapshot(snapshot => snapshot.settings?.settings.mendBy) === 'writer' ? 'writer' : 'planner'
  return [by, (next) => {
    void controller.guard(async () => {
      await controller.saveSettings({ mendBy: next })
    })
  }]
}

/**
 * Whose model rewrites a passage the author selected, and writes a chapter over whole (`rewriteBy`): the writer's
 * unless the author set the crew's — and the way to say so from beside the buttons that rewrite.
 */
export function useRewriteBy(): [MendBy, (by: MendBy) => void] {
  const { controller } = useStudio()
  const by: MendBy = useSnapshot(snapshot => snapshot.settings?.settings.rewriteBy) === 'planner' ? 'planner' : 'writer'
  return [by, (next) => {
    void controller.guard(async () => {
      await controller.saveSettings({ rewriteBy: next })
    })
  }]
}

/** How far a mending reaches: through — every place, what changes with each, as much of a place as has to move — or the least change. */
export type MendReach = 'bold' | 'careful'

/**
 * How far a mending reaches, as the Studio's settings have it (`mendReach`: through unless the author set the least
 * change) — and the way to say otherwise from beside the buttons that mend.
 */
export function useMendReach(): [MendReach, (reach: MendReach) => void] {
  const { controller } = useStudio()
  const reach: MendReach = useSnapshot(snapshot => snapshot.settings?.settings.mendReach) === 'careful' ? 'careful' : 'bold'
  return [reach, (next) => {
    void controller.guard(async () => {
      await controller.saveSettings({ mendReach: next })
    })
  }]
}

/** The two entries a menu beside a mending button has for it. */
export function useReachItems(): { label: string; onSelect: () => void }[] {
  const t = useT()
  const [reach, setReach] = useMendReach()
  return [
    { label: t(`${reach === 'bold' ? '✓ ' : ''}改多少 · 主动：改到位，牵连到的一并改`, `${reach === 'bold' ? '✓ ' : ''}How far · bold: mended through, with what hangs on it`), onSelect: () => { setReach('bold') } },
    { label: t(`${reach === 'careful' ? '✓ ' : ''}改多少 · 保守：能少改就少改`, `${reach === 'careful' ? '✓ ' : ''}How far · careful: the least change`), onSelect: () => { setReach('careful') } },
  ]
}

/** The small triangle beside the buttons that rewrite a passage: whose model does it. */
export function RewriteByMenu() {
  const t = useT()
  const [by, setBy] = useRewriteBy()
  const [material] = useMaterialBy()
  const materials = useMaterialItems()
  return (
    <Menu icon="chevronDown" variant="ghost" size="sm" align="end" label={`${by === 'planner' ? t('编排模型改', 'By the crew\'s model') : t('写手改', 'By the writer')} · ${material === 'rules' ? t('按规则拼', 'packed by rule') : t('策划备料', 'planner\'s material')}`} items={[
      { label: t(`${by === 'writer' ? '✓ ' : ''}改写一段、整章重写：由写手模型写`, `${by === 'writer' ? '✓ ' : ''}A passage rewritten, a chapter written over: the writer's model`), onSelect: () => { setBy('writer') } },
      { label: t(`${by === 'planner' ? '✓ ' : ''}改写一段、整章重写：由编排模型写`, `${by === 'planner' ? '✓ ' : ''}A passage rewritten, a chapter written over: the crew's model`), onSelect: () => { setBy('planner') } },
      'separator',
      ...materials,
    ]} />
  )
}

/** The small triangle beside the buttons that mend: in line or apart, how far a mending reaches, and whose model writes the changed words. */
export function MendOrderMenu() {
  const t = useT()
  const [order, setOrder] = useMendOrder()
  const [by, setBy] = useMendBy()
  const [whole, setWhole] = useRewriteBy()
  const [reach] = useMendReach()
  const reaches = useReachItems()
  return (
    <Menu icon="chevronDown" variant="ghost" size="sm" align="end" label={`${order === 'queue' ? t('排队', 'In line') : t('分别', 'Apart')} · ${reach === 'bold' ? t('主动', 'bold') : t('保守', 'careful')} · ${by === 'planner' ? t('策划写', 'planner writes') : t('写手写', 'writer writes')}`} items={[
      { label: t(`${order === 'queue' ? '✓ ' : ''}排队：等前面的修复做完，接着它们改`, `${order === 'queue' ? '✓ ' : ''}In line: after the mendings under way, going on from them`), onSelect: () => { setOrder('queue') } },
      { label: t(`${order === 'apart' ? '✓ ' : ''}分别：马上开始，各改各的`, `${order === 'apart' ? '✓ ' : ''}Apart: at once, each by itself`), onSelect: () => { setOrder('apart') } },
      'separator',
      ...reaches,
      'separator',
      { label: t(`${by === 'planner' ? '✓ ' : ''}按处修改：由编排模型直接写（不经写手）`, `${by === 'planner' ? '✓ ' : ''}Changes by places: the crew's model writes them itself (no writer)`), onSelect: () => { setBy('planner') } },
      { label: t(`${by === 'writer' ? '✓ ' : ''}按处修改：策划定在哪改，写手模型写`, `${by === 'writer' ? '✓ ' : ''}Changes by places: the planner settles where, the writer's model writes`), onSelect: () => { setBy('writer') } },
      'separator',
      { label: t(`${whole === 'writer' ? '✓ ' : ''}整章重写：由写手模型写`, `${whole === 'writer' ? '✓ ' : ''}A chapter written over: the writer's model`), onSelect: () => { setWhole('writer') } },
      { label: t(`${whole === 'planner' ? '✓ ' : ''}整章重写：由编排模型写`, `${whole === 'planner' ? '✓ ' : ''}A chapter written over: the crew's model`), onSelect: () => { setWhole('planner') } },
    ]} />
  )
}

/** How many mendings of this book are under way or waiting their turn. */
export function useMendings(): number {
  const { root } = useProject()
  return useSnapshot(snapshot => snapshot.jobs.filter(job => job.status === 'running' && job.kind === 'revise' && job.project === root).length)
}

/** How one issue is mended: the place it quotes, a place the planner settles, the chapter written over, or traced through the book. */
export type MendScope = 'passage' | 'place' | 'book' | 'chapter'

/**
 * Problems of how the words are put — style, language, pace — are mended where the review points; problems of things
 * not agreeing — a fact, a time, a cause, how somebody behaves — show at one place and can be mended at another, so
 * for those the planner settles where. Either can be asked for from the card's menu.
 */
const AT_THE_QUOTE = new Set(['style', 'language', 'pacing'])

/** Under which name what the author is typing about an issue is kept on this screen. */
export const issueNoteKey = (chapterId: string, issueId: string): string => `issue.note.${chapterId}.${issueId}`

/**
 * @param before - asked before a fix is started (the editor saves what is being typed); a `false` calls it off.
 * @param after - told once a fix has been started.
 * @param onLocate - show the quoted words in the text.
 */
export function IssueCard({ chapterId, issue, onLocate, onChanged, before, after, className, selected, onSelect }: {
  chapterId: string
  issue: ReviewIssue
  onLocate?: (quote: string) => void
  onChanged?: () => void
  before?: () => Promise<boolean>
  after?: (scope: MendScope) => void
  className?: string
  /** One of a batch to be mended together: shown with a tick box. */
  selected?: boolean
  onSelect?: (on: boolean) => void
}) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [note, setNote] = useKept(issueNoteKey(chapterId, issue.id), issue.note ?? '')
  // What was made to mend this issue and waits to be accepted: shown beneath it, settled here.
  // (Of the batch it was handed over with, a change to this very chapter that names other issues is theirs, and shown beneath them.)
  const mends = project.proposals.filter(proposal => proposal.status === 'pending' && (proposal.issues?.includes(issue.id) === true || (issue.mending !== undefined && (proposal.batchId === issue.mending || proposal.batches?.includes(issue.mending) === true) && !(proposal.chapterId === chapterId && (proposal.issues?.length ?? 0) > 0))))
  const mendsHere = mends.filter(proposal => proposal.chapterId === chapterId)
  const mendsElsewhere = mends.filter(proposal => proposal.chapterId !== chapterId)
  const elsewhere = new Set(mendsElsewhere.map(proposal => proposal.chapterId)).size
  const [asked, setAsked] = useState(false)
  const revising = useRunningJob(job => job.kind === 'revise') !== undefined
  const under = useMendings()
  const [order] = useMendOrder()
  const [reach] = useMendReach()
  const reaches = useReachItems()
  const bold = reach === 'bold'
  // What the author says of an issue is kept with it: it goes along when the issue is mended in a batch, and to the showrunner.
  const keep = (): void => {
    if (note.trim() === (issue.note ?? '')) return
    // (A Host from before notes were kept refuses: the words stay in the box and still go along with a fix started here.)
    void controller.api.call('review.note', { root, chapter: chapterId, issue: issue.id, note: note.trim() }).then(() => { onChanged?.() }, () => {})
  }
  const here = useAction()
  const everywhere = useAction()
  const whole = useAction()
  const settle = useAction()
  // The mending the card's first button does: at the quoted place, or at the place the planner settles.
  const settled = issue.quote === undefined || !AT_THE_QUOTE.has(issue.type)
  const fix = (scope: MendScope) => async (): Promise<void> => {
    if (before !== undefined && !(await before())) return
    await controller.api.call('ai.fixIssue', { root, chapter: chapterId, issue: issue.id, scope, order, ...(note.trim().length > 0 ? { note: note.trim() } : {}) })
    await controller.refreshJobs()
    controller.toast('info', under > 0 && order === 'queue'
      ? t(`排在前面 ${under} 个修复后面，接着它们改；改好之后，对比会出现在这条问题下面。`, `In line behind ${under} mending(s), going on from them; the changes will show beneath this issue.`)
      : scope === 'book'
        ? t('策划正在查这个问题牵涉到哪几处；改好之后，每一处的对比会出现在这条问题下面。', 'The planner is tracing which places this reaches; each change will show beneath this issue.')
        : scope === 'place' || (scope === 'passage' && issue.quote === undefined)
          ? bold
            ? t('策划在定改哪几处；改好之后，每一处的对比会出现在这条问题下面。', 'The planner is settling which places change; each change will show beneath this issue.')
            : t('策划在定改哪一处；改好之后，对比会出现在这条问题下面。', 'The planner is settling which place to change; the change will show beneath this issue.')
          : t('改好之后，对比会出现在这条问题下面。', 'The rewrite will show beneath this issue.'))
    setAsked(true)
    after?.(scope)
  }
  const open = issue.resolved !== true
  return (
    <article className={cx('nv-issue', !open && 'is-resolved', className)}>
      <header>
        {onSelect !== undefined && open ? <input type="checkbox" checked={selected === true} onChange={(event) => { onSelect(event.target.checked) }} aria-label={t('选中这个问题', 'Select this issue')} /> : null}
        <Chip tone={SEVERITY_TONE[issue.severity]}>{t(...SEVERITY[issue.severity])}</Chip>
        <Chip>{t(...ISSUE_TYPE[issue.type])}</Chip>
        {issue.lead !== undefined ? <Chip tone="violet" title={t(`照你说的这句话找到的：${issue.lead}`, `Found by what you said: ${issue.lead}`)}>{t('你提的', 'Yours')}</Chip> : null}
        {issue.mending !== undefined && open ? <Chip tone="blue">{t('已交给修复', 'Handed over')}</Chip> : null}
      </header>
      {issue.quote !== undefined ? (
        onLocate !== undefined
          ? <button type="button" className="nv-issue-quote" onClick={() => { onLocate(issue.quote!) }} title={t('在正文中定位', 'Locate in the text')}>{issue.quote}</button>
          : <blockquote className="nv-issue-quote">{issue.quote}</blockquote>
      ) : null}
      <p>{issue.explanation}</p>
      {issue.suggestion !== undefined ? <p className="nv-muted nv-small">{t('建议：', 'Suggestion: ')}{issue.suggestion}</p> : null}
      {issue.checked !== undefined && issue.checked.verdict !== 'stands' ? <p className="nv-muted nv-small">{issue.checked.verdict === 'fixed' ? t('修订后核对：已解决', 'Looked at again after a revision: settled') : t('修订后核对：已按现在的正文更新', 'Looked at again after a revision: brought up to the text')}{issue.checked.why !== undefined ? t(`——${issue.checked.why}`, ` — ${issue.checked.why}`) : ''}</p> : null}
      {open ? (
        <TextArea
          className="nv-issue-note"
          minRows={1}
          maxRows={6}
          value={note}
          placeholder={t('你想怎么改？', 'How do you want it mended?')}
          onChange={(event) => { setNote(event.target.value) }}
          onBlur={keep}
        />
      ) : null}
      <footer>
        {open ? (
          <>
            <Button size="sm" icon="wand" busy={here.busy} pending={t('正在开始…', 'Starting…')} onClick={() => here.run(fix(settled ? 'place' : 'passage'))} title={settled
              ? bold ? t('策划定改哪几处，把它改到位——牵连到的呼应一并改', 'The planner settles which places change and mends it through — with what hangs on it') : t('策划定改哪一处最省，只改那一处', 'The planner settles which place mends it with the least change, and only that place changes')
              : bold ? t('改引文所在的这一段', 'Rewrite the passage the quote stands in') : t('只改引文这一处', 'Rewrite the quoted place only')}>
              {settled ? bold ? t('修这个问题', 'Mend it') : t('修一处', 'Mend one place') : t('修这一处', 'Mend it here')}
            </Button>
            <Button size="sm" icon="layers" busy={everywhere.busy} pending={t('正在开始…', 'Starting…')} onClick={() => everywhere.run(fix('book'))} title={t('策划查清牵涉到别的章节和设定的哪几处，一处处改', 'The planner traces the chapters and the bible it reaches, and mends them together')}>
              {t('全局修复', 'Mend it everywhere')}
            </Button>
            <Menu icon="more" variant="ghost" size="sm" align="end" items={[
              ...(issue.quote !== undefined ? [settled
                ? { label: bold ? t('只改引文所在的这一段', 'Rewrite only the passage the quote stands in') : t('只改引文这一处', 'Rewrite the quoted place only'), icon: 'wand' as const, onSelect: () => { void whole.run(fix('passage')) } }
                : { label: bold ? t('让策划定改哪几处', 'Let the planner settle the places') : t('让策划定改哪一处', 'Let the planner settle the place'), icon: 'wand' as const, onSelect: () => { void whole.run(fix('place')) } }] : []),
              { label: t('整章重写', 'Rewrite the whole chapter'), icon: 'refresh', onSelect: () => { void whole.run(fix('chapter')) } },
              'separator' as const,
              ...reaches,
            ]} />
            {under > 0 ? <MendOrderMenu /> : null}
          </>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon={open ? 'check' : 'undo'}
          busy={settle.busy}
          onClick={() => settle.run(async () => {
            await controller.api.call('review.resolve', { root, chapter: chapterId, issue: issue.id, resolved: open })
            onChanged?.()
          })}
        >
          {open ? t('标为已处理', 'Mark as settled') : t('重新打开', 'Reopen')}
        </Button>
      </footer>
      {asked && revising && mends.length === 0 ? <p className="nv-muted nv-small">{t('正在改…', 'Being mended…')}</p> : null}
      {mendsHere.map(proposal => (proposal.issues?.length ?? 0) > 1
        ? <details key={proposal.id} className="nv-issue-mend"><summary>{proposal.kind === 'span' ? t(`一处修改（这一批在修这一章的 ${proposal.issues!.length} 个问题）`, `A change to one place (the batch mends ${proposal.issues!.length} issues of this chapter)`) : t(`这一章的修改（同时修 ${proposal.issues!.length} 个问题）`, `This chapter's change (mends ${proposal.issues!.length} issues)`)}</summary><ProposalCard bare proposal={proposal} onSettled={() => { onChanged?.() }} /></details>
        : <ProposalCard key={proposal.id} bare proposal={proposal} onSettled={() => { onChanged?.() }} />)}
      {mendsElsewhere.length > 0 ? (
        <details className="nv-issue-mend">
          <summary>{elsewhere === mendsElsewhere.length
            ? t(`这次修复还改了别的 ${elsewhere} 章`, `This mending also changed ${elsewhere} other chapter(s)`)
            : t(`这次修复还改了别的 ${elsewhere} 章里的 ${mendsElsewhere.length} 处`, `This mending also changed ${mendsElsewhere.length} place(s) in ${elsewhere} other chapter(s)`)}</summary>
          {mendsElsewhere.map(proposal => <ProposalCard key={proposal.id} bare proposal={proposal} showChapter onSettled={() => { onChanged?.() }} />)}
        </details>
      ) : null}
    </article>
  )
}

/** What a review led by the author came to (`ai.reviewLead`). */
interface LeadOutput { found?: { chapterId: string; index: number }[]; chapters?: number; fix?: boolean; note?: string; book?: { results?: unknown[]; failed?: unknown[]; direct?: boolean } }

/** …said in a line. */
export function leadWord(output: LeadOutput | undefined, t: (zh: string, en: string) => string): string {
  const found = output?.found?.length ?? 0
  const note = output?.note !== undefined && output.note.trim().length > 0 ? clip(output.note.trim(), 220) : undefined
  const said = note !== undefined ? t(` 策划：${note}`, ` The planner: ${note}`) : ''
  if (found === 0) return t(`照你说的没有找到。${said}`, `Nothing was found for it.${said}`)
  const chapters = [...new Set(output!.found!.map(item => item.index))].sort((left, right) => left - right)
  const where = t(`照你说的找到了 ${found} 处（第 ${chapters.join('、')} 章），记成了审校问题`, `Found in ${found} place(s) (chapter ${chapters.join(', ')}), each filed as an issue`)
  const made = output?.book?.results?.length ?? 0
  const failed = output?.book?.failed?.length ?? 0
  const changed = output?.fix === false
    ? t('；这一次只找，没有改。', '; found only, nothing changed.')
    : made === 0
      ? t(`；没有出修改${failed > 0 ? `（${failed} 处没改成）` : ''}。`, `; no change was made${failed > 0 ? ` (${failed} failed)` : ''}.`)
      : t(`；改了 ${made} 处${output?.book?.direct === true ? '（策划直接写的）' : ''}，在各条问题下面等你确认${failed > 0 ? `，${failed} 处没改成` : ''}。`, `; ${made} change(s)${output?.book?.direct === true ? ' (written by the planner itself)' : ''} wait beneath the issues${failed > 0 ? `, ${failed} failed` : ''}.`)
  return `${where}${changed}${said}`
}

/** The reviews led by the author that are under way or over, for this book: the last one says what it came to. */
export function useLeadJobs(): { running: JobInfo[]; last: JobInfo | undefined } {
  const { root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const mine = jobs.filter(job => job.kind === 'revise' && job.title === 'review by lead' && job.project === root)
  return { running: mine.filter(job => job.status === 'running'), last: mine.filter(job => job.status === 'done').at(-1) }
}

/**
 * A review led by the author. They have noticed something already — a pair of glasses that come and go, days that do
 * not add up — and say it in a sentence: the planner goes into the book for it, files each place it shows as an issue
 * of its chapter (marked as the author's own), and mends it, each change shown beneath its issue. "Find only" files
 * and changes nothing.
 * @param chapters - keep it to these chapters (the editor's panel: the one that is open); left out, the author picks — the whole line of the plot in hand, or chapters of it.
 * @param before - asked before it is started (the editor saves what is being typed); a `false` calls it off.
 */
export function LeadBar({ chapters, before, onStarted, className }: { chapters?: string[]; before?: () => Promise<boolean>; onStarted?: () => void; className?: string }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const fixed = chapters !== undefined
  const [lead, setLead] = useKept(fixed ? `review.lead.${chapters.join(',')}` : 'review.lead', '')
  const [scope, setScope] = useState<'line' | 'pick'>('line')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [order] = useMendOrder()
  const [by] = useMendBy()
  const under = useMendings()
  const { running, last } = useLeadJobs()
  // The line of the plot in hand: its chapters as they are read on it.
  const others = project.outline.lines ?? []
  const [line, setLine] = useBookLine()
  const known = new Map([...project.chapters, ...(project.lines ?? []).flatMap(candidate => candidate.chapters)].map(info => [info.id, info]))
  const path = line === MAIN_LINE ? project.chapters : (project.lines?.find(candidate => candidate.id === line)?.path ?? []).map(id => known.get(id)).filter((info): info is ChapterInfo => info !== undefined)
  const written = path.filter(chapter => chapter.hasText)
  const within = fixed ? chapters : scope === 'pick' ? [...picked].filter(id => written.some(chapter => chapter.id === id)) : undefined
  const ready = lead.trim().length > 0 && (fixed || (written.length > 0 && (scope === 'line' || (within?.length ?? 0) > 0)))
  const start = (fix: boolean): Promise<unknown> => controller.guard(async () => {
    if (before !== undefined && !(await before())) return
    await controller.api.call('ai.reviewLead', { root, lead: lead.trim(), fix, order, ...(within !== undefined ? { chapters: within } : {}), ...(!fixed && line !== MAIN_LINE ? { line } : {}) })
    await controller.refreshJobs()
    controller.toast('info', fix
      ? under > 0 && order === 'queue'
        ? t(`排在前面 ${under} 个修复后面；找到的会记成审校问题，改动出现在各条问题下面。`, `In line behind ${under} mending(s); what is found is filed as issues, and the changes show beneath them.`)
        : t(`策划照你说的去书里找；找到的记成审校问题，改动${by === 'planner' ? '由策划直接写，' : ''}出现在各条问题下面。`, `The planner is looking for it; what is found is filed as issues, and the changes${by === 'planner' ? ', written by the planner itself,' : ''} show beneath them.`)
      : t('策划照你说的去书里找；找到的记成审校问题，这一次不改。', 'The planner is looking for it; what is found is filed as issues, and nothing is changed this time.'))
    setLead('')
    onStarted?.()
  })
  return (
    <div className={cx('nv-card nv-lead', className)}>
      <div className="nv-lead-head">
        <strong>{t('照引导审校', 'Review by a lead')}</strong>
        <span className="nv-muted nv-small">{fixed ? t('你在这一章里已经发现的问题，写一句：策划找出来、记成问题，再修。', 'What you noticed in this chapter already, in a sentence: the planner finds it, files it, and mends it.') : t('你已经发现的问题，写一句：策划去书里找出来、记成审校问题，再修。', 'What you noticed already, in a sentence: the planner finds it in the book, files it as issues, and mends it.')}</span>
      </div>
      <TextArea value={lead} minRows={fixed ? 1 : 2} maxRows={8} placeholder={t('例：柳先生的眼镜一会儿有一会儿没有', 'E.g. his glasses come and go')} onChange={(event) => { setLead(event.target.value) }} />
      {!fixed ? (
        <div className="nv-row nv-lead-scope">
          {others.length > 0 ? <Select value={line} options={[{ value: MAIN_LINE, label: t('主线', 'Main line') }, ...others.map(item => ({ value: item.id, label: item.title }))]} onChange={(value) => { setLine(value); setPicked(new Set()) }} /> : null}
          <Select value={scope} options={[{ value: 'line', label: t(`在这条线写了的 ${written.length} 章里找`, `Look through the ${written.length} written chapters of this line`) }, { value: 'pick', label: t('只在我选的章节里找', 'Only the chapters I pick') }]} onChange={setScope} />
        </div>
      ) : null}
      {!fixed && scope === 'pick' ? (
        <div className="nv-chips">
          {written.map(chapter => <Chip key={chapter.id} tone={picked.has(chapter.id) ? 'blue' : 'neutral'} active={picked.has(chapter.id)} onClick={() => { setPicked((previous) => { const next = new Set(previous); if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id); return next }) }}>{chapter.index}. {chapter.title}</Chip>)}
        </div>
      ) : null}
      <div className="nv-row nv-lead-actions">
        <div className="nv-split-btn">
          <Button size="sm" variant="primary" icon="wand" disabled={!ready} pending={t('正在开始…', 'Starting…')} onClick={() => start(true)} title={t('找到的每一处记成这一章的审校问题；修改是提案，出现在各条问题下面', 'Each place found is filed as an issue of its chapter; the changes are proposals, shown beneath the issues')}>{t('找出来并修', 'Find and mend')}</Button>
          <MendOrderMenu />
        </div>
        <Button size="sm" variant="outline" icon="search" disabled={!ready} pending={t('正在开始…', 'Starting…')} onClick={() => start(false)} title={t('只记成审校问题，先不改', 'Filed as issues, nothing changed yet')}>{t('只找出来', 'Find only')}</Button>
      </div>
      {running.map(job => <JobBar key={job.id} job={job} />)}
      {running.length === 0 && last !== undefined ? <p className="nv-note nv-small">{t('上一次：', 'Last time: ')}{leadWord(last.result?.output as LeadOutput | undefined, t)}</p> : null}
    </div>
  )
}

/** One issue of a batch, named where its review found it. */
export interface BatchItem {
  chapterId: string
  issue: ReviewIssue
}

/**
 * Mend the ticked issues together: a word on the batch, and the button that hands them — each with what the author
 * says of it — to one planner. The same bar wherever issues are ticked: the review page, the editor's panel, the reader.
 * @param before - asked before the batch is started (the editor saves what is being typed); a `false` calls it off.
 */
export function IssueBatchBar({ chosen, before, onStarted, children }: { chosen: BatchItem[]; before?: () => Promise<boolean>; onStarted?: () => void; children?: ReactNode }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [say, setSay] = useKept('review.say', '')
  // Other mendings do not stand in the way: this batch waits for them, or runs beside them, as the author chose.
  const under = useMendings()
  const [order] = useMendOrder()
  const start = (): Promise<unknown> => controller.guard(async () => {
    if (before !== undefined && !(await before())) return
    await controller.api.call('ai.fixIssues', {
      root,
      order,
      issues: chosen.map((item) => {
        // What is being typed on this screen is what is meant, also where it has not reached the book yet.
        const note = String(controller.kept.get(issueNoteKey(item.chapterId, item.issue.id)) ?? item.issue.note ?? '').trim()
        return { chapter: item.chapterId, issue: item.issue.id, ...(note.length > 0 ? { note } : {}) }
      }),
      ...(say.trim().length > 0 ? { note: say.trim() } : {}),
    })
    await controller.refreshJobs()
    controller.toast('info', under > 0 && order === 'queue'
      ? t(`这 ${chosen.length} 个问题排在前面 ${under} 个修复后面，接着它们改。`, `These ${chosen.length} are in line behind ${under} mending(s), and go on from them.`)
      : t(`策划正在把这 ${chosen.length} 个问题放在一起看；改好之后，对比会出现在各条问题下面。`, `The planner is reading these ${chosen.length} side by side; the changes will show beneath the issues.`))
    onStarted?.()
  })
  return (
    <div className="nv-assist nv-issue-batch">
      {children}
      <TextInput value={say} placeholder={t('对这一批的要求', 'What to ask of this batch')} onChange={(event) => { setSay(event.target.value) }} />
      <div className="nv-split-btn">
        <Button size="sm" variant="primary" icon="layers" disabled={chosen.length === 0} onClick={start}>{t(`一起修选中的 ${chosen.length} 个`, `Mend the ${chosen.length} chosen together`)}</Button>
        <MendOrderMenu />
      </div>
      {under > 0 ? <span className="nv-muted nv-small">{order === 'queue' ? t(`${under} 个修复在做，新的排在后面`, `${under} mending(s) under way; a new one waits its turn`) : t(`${under} 个修复在做，新的同时开始`, `${under} mending(s) under way; a new one starts beside them`)}</span> : null}
    </div>
  )
}

/**
 * The issues of one chapter, each with a tick box, and the bar that mends the ticked ones together — what the
 * editor's panel and the reader show beside the text.
 */
export function IssueList({ chapterId, issues, onLocate, onChanged, before, after, className }: {
  chapterId: string
  issues: ReviewIssue[]
  onLocate?: (quote: string) => void
  onChanged?: () => void
  before?: () => Promise<boolean>
  after?: (scope: MendScope) => void
  className?: string
}) {
  const t = useT()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const open = issues.filter(issue => issue.resolved !== true)
  const chosen = open.filter(issue => picked.has(issue.id))
  const every = open.length > 0 && chosen.length === open.length
  const tick = (ids: string[], on: boolean): void => {
    setPicked((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }
  return (
    <div className={cx('nv-issue-list', className)}>
      {open.length > 1 ? (
        <IssueBatchBar chosen={chosen.map(issue => ({ chapterId, issue }))} {...(before !== undefined ? { before } : {})} onStarted={() => { setPicked(new Set()); after?.('book') }}>
          <button type="button" className="nv-link nv-small" onClick={() => { tick(open.map(issue => issue.id), !every) }}>{every ? t('全不选', 'None') : t(`全选 ${open.length} 个`, `All ${open.length}`)}</button>
        </IssueBatchBar>
      ) : null}
      {issues.map(issue => (
        <IssueCard
          key={issue.id}
          chapterId={chapterId}
          issue={issue}
          {...(onLocate !== undefined ? { onLocate } : {})}
          {...(onChanged !== undefined ? { onChanged } : {})}
          {...(before !== undefined ? { before } : {})}
          {...(after !== undefined ? { after } : {})}
          {...(open.length > 1 ? { selected: picked.has(issue.id), onSelect: (on: boolean) => { tick([issue.id], on) } } : {})}
        />
      ))}
    </div>
  )
}

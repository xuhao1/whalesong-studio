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
 *   ReviseBar     review and revision, one bar wherever it is offered: nothing said, a review; a sentence said, the planner tells whether it is a fault to find and mend or a change to carry out
 *   MendsBar      the changes that wait beneath a set of issues, taken or turned down in one go
 *   ReviewMendsMenu  beside the buttons that review: whether what a review finds goes on to be mended by itself
 *   issueMarks    where the issues of a chapter sit in its text, for a page that marks them
 */
import { MAIN_LINE, type ChapterInfo, type ChapterReview, type IssueEvidence, type JobInfo, type PictureGuide, type Proposal, type ReviewIssue } from '../shared/types'
import { clip, fuzzyFind } from '../shared/text'
import { mendsOf } from '../shared/issues'
import { ISSUE_TYPE, SEVERITY, SEVERITY_TONE } from './labels'
import { ProposalCard, SettleAll } from './components/ProposalCard'
import { useBookActions } from './actions'
import { useBatchJob } from './Batch'
import { GuidePictures } from './Guides'
import { JobBar } from './JobBar'
import { useAuto, useAutoSave, useMaterialBy, useMaterialItems, useWriting, useWritingSave } from './Material'
import { useState, type ReactNode } from 'react'
import { Button, Chip, cx, Menu, Select, TextArea, TextInput, useAction, useBookLine, useConfirm, useKept, useProject, useRunningJob, useShared, useSnapshot, useStudio, useT } from './ui'

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
/** Who writes the words of a revision made by places: the planner telling place by place, the planner always, the writer always. */
export type MendWay = MendBy | 'auto'

/** One of them in a word: for the label of a menu, a list of what a book has its own of. */
export const mendWayWord = (by: MendWay, t: (zh: string, en: string) => string): string => (by === 'auto' ? t('策划判断', 'the planner tells') : by === 'planner' ? t('策划写', 'planner writes') : t('写手写', 'writer writes'))

/**
 * Who writes them, as it holds for the book in hand (`mendBy`: the book's own, else the Studio's) — and the way to
 * say otherwise from beside the buttons that mend: it is a setting, kept, since it says which of the author's models
 * is fit for the work.
 * @returns who; the way to set it (saved where what holds is kept); and whether it is the book's own.
 */
export function useMendBy(): [MendWay, (by: MendWay) => void, boolean] {
  // (Told place by place by the planner unless the author set one of the two: a change pinned to a word or two is
  // the planner's kind of work, a passage to be written the writer's.)
  const { set, own } = useWriting()
  const save = useWritingSave()
  return [set.mendBy, (next) => { save('mendBy', next) }, own.mendBy !== undefined]
}

/**
 * Whose model rewrites a passage the author selected, and writes a chapter over whole (`rewriteBy`): the writer's
 * unless the author set the crew's — and the way to say so from beside the buttons that rewrite.
 */
export function useRewriteBy(): [MendBy, (by: MendBy) => void, boolean] {
  const { set, own } = useWriting()
  const save = useWritingSave()
  return [set.rewriteBy, (next) => { save('rewriteBy', next) }, own.rewriteBy !== undefined]
}

/** How far a mending reaches: through — every place, what changes with each, as much of a place as has to move — or the least change. */
export type MendReach = 'bold' | 'careful'

/**
 * How far a mending reaches, as it holds for the book in hand (`mendReach`: the book's own, else the Studio's;
 * through unless the author set the least change) — and the way to say otherwise from beside the buttons that mend.
 */
export function useMendReach(): [MendReach, (reach: MendReach) => void, boolean] {
  const { set, own } = useWriting()
  const save = useWritingSave()
  return [set.mendReach, (next) => { save('mendReach', next) }, own.mendReach !== undefined]
}

/** Said after an entry of a menu that changes a setting the book has its own of: the pick is saved in the book. */
export const ownWord = (ofBook: boolean, t: (zh: string, en: string) => string): string => (ofBook ? t('（这本书自己的设置）', ' (this book\'s own)') : '')

/** The two entries a menu beside a mending button has for it. */
export function useReachItems(): { label: string; onSelect: () => void }[] {
  const t = useT()
  const [reach, setReach, ofBook] = useMendReach()
  const mine = ownWord(ofBook, t)
  return [
    { label: t(`${reach === 'bold' ? '✓ ' : ''}改多少 · 主动：改到位，牵连到的一并改${mine}`, `${reach === 'bold' ? '✓ ' : ''}How far · bold: mended through, with what hangs on it${mine}`), onSelect: () => { setReach('bold') } },
    { label: t(`${reach === 'careful' ? '✓ ' : ''}改多少 · 保守：能少改就少改${mine}`, `${reach === 'careful' ? '✓ ' : ''}How far · careful: the least change${mine}`), onSelect: () => { setReach('careful') } },
  ]
}

/** The title of the job that mends what reviews just found (the Host's `MEND_REVIEW_JOB`). */
export const MEND_REVIEW_JOB = 'mend review'

/**
 * Whether what a review finds goes on to be mended by itself, as it holds for the book in hand (`reviewMends`: the
 * book's own switch, else the Studio's; yes unless the author switched it off) — and the way to say otherwise from
 * beside the buttons that review.
 * @returns whether; the way to flip it (saved where what holds is kept); and whether it is the book's own.
 */
export function useReviewMends(): [boolean, (on: boolean) => void, boolean] {
  const { set, own } = useAuto()
  const save = useAutoSave()
  return [set.reviewMends, (next) => { save('reviewMends', next) }, own.reviewMends !== undefined]
}

/** The small triangle beside the buttons that review: what a review finds is mended by itself, or only listed. */
export function ReviewMendsMenu({ variant = 'ghost' }: { variant?: 'ghost' | 'outline' }) {
  const t = useT()
  const [on, setOn, ofBook] = useReviewMends()
  const mine = ownWord(ofBook, t)
  return (
    <Menu icon="chevronDown" variant={variant} size="sm" align="end" label={on ? t('审校之后：出修订提案', 'After a review: proposals') : t('审校之后：只列问题', 'After a review: issues only')} items={[
      { label: t(`${on ? '✓ ' : ''}审校之后把找到的问题交给策划修订：改动是提案，出现在各条问题下面${mine}`, `${on ? '✓ ' : ''}After a review, the planner mends what it found: each change a proposal beneath its issue${mine}`), onSelect: () => { setOn(true) } },
      { label: t(`${on ? '' : '✓ '}只审校：列出问题，先不改${mine}`, `${on ? '' : '✓ '}Review only: the issues are listed, nothing changes${mine}`), onSelect: () => { setOn(false) } },
    ]} />
  )
}

/** The small triangle beside the buttons that rewrite a passage: whose model does it. */
export function RewriteByMenu() {
  const t = useT()
  const [by, setBy, ofBook] = useRewriteBy()
  const mine = ownWord(ofBook, t)
  const [material] = useMaterialBy()
  const materials = useMaterialItems()
  return (
    <Menu icon="chevronDown" variant="ghost" size="sm" align="end" label={`${by === 'planner' ? t('编排模型改', 'By the crew\'s model') : t('写手改', 'By the writer')} · ${material === 'rules' ? t('按规则拼', 'packed by rule') : t('策划备料', 'planner\'s material')}`} items={[
      { label: t(`${by === 'writer' ? '✓ ' : ''}改写一段、整章重写：由写手模型写${mine}`, `${by === 'writer' ? '✓ ' : ''}A passage rewritten, a chapter written over: the writer's model${mine}`), onSelect: () => { setBy('writer') } },
      { label: t(`${by === 'planner' ? '✓ ' : ''}改写一段、整章重写：由编排模型写${mine}`, `${by === 'planner' ? '✓ ' : ''}A passage rewritten, a chapter written over: the crew's model${mine}`), onSelect: () => { setBy('planner') } },
      'separator',
      ...materials,
    ]} />
  )
}

/** The small triangle beside the buttons that mend: in line or apart, how far a mending reaches, and whose model writes the changed words. */
export function MendOrderMenu() {
  const t = useT()
  const [order, setOrder] = useMendOrder()
  const [by, setBy, byBook] = useMendBy()
  const [whole, setWhole, wholeBook] = useRewriteBy()
  const [reach] = useMendReach()
  const reaches = useReachItems()
  const mine = ownWord(byBook, t)
  const mineWhole = ownWord(wholeBook, t)
  return (
    <Menu icon="chevronDown" variant="ghost" size="sm" align="end" label={`${order === 'queue' ? t('排队', 'In line') : t('分别', 'Apart')} · ${reach === 'bold' ? t('主动', 'bold') : t('保守', 'careful')} · ${mendWayWord(by, t)}`} items={[
      { label: t(`${order === 'queue' ? '✓ ' : ''}排队：等前面的修订做完，接着它们改`, `${order === 'queue' ? '✓ ' : ''}In line: after the mendings under way, going on from them`), onSelect: () => { setOrder('queue') } },
      { label: t(`${order === 'apart' ? '✓ ' : ''}分别：马上开始，各改各的`, `${order === 'apart' ? '✓ ' : ''}Apart: at once, each by itself`), onSelect: () => { setOrder('apart') } },
      'separator',
      ...reaches,
      'separator',
      { label: t(`${by === 'auto' ? '✓ ' : ''}按处修订：策划判断——小改动它直接写，要成段写的交给写手模型${mine}`, `${by === 'auto' ? '✓ ' : ''}Changes by places: the planner tells — a small change it writes itself, a passage goes to the writer's model${mine}`), onSelect: () => { setBy('auto') } },
      { label: t(`${by === 'planner' ? '✓ ' : ''}按处修订：由编排模型直接写（不经写手）${mine}`, `${by === 'planner' ? '✓ ' : ''}Changes by places: the crew's model writes them itself (no writer)${mine}`), onSelect: () => { setBy('planner') } },
      { label: t(`${by === 'writer' ? '✓ ' : ''}按处修订：策划定在哪改，每一处都由写手模型写${mine}`, `${by === 'writer' ? '✓ ' : ''}Changes by places: the planner settles where, the writer's model writes every one${mine}`), onSelect: () => { setBy('writer') } },
      'separator',
      { label: t(`${whole === 'writer' ? '✓ ' : ''}整章重写：由写手模型写${mineWhole}`, `${whole === 'writer' ? '✓ ' : ''}A chapter written over: the writer's model${mineWhole}`), onSelect: () => { setWhole('writer') } },
      { label: t(`${whole === 'planner' ? '✓ ' : ''}整章重写：由编排模型写${mineWhole}`, `${whole === 'planner' ? '✓ ' : ''}A chapter written over: the crew's model${mineWhole}`), onSelect: () => { setWhole('planner') } },
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

/** Where what an issue is at odds with stands, and the words — as the card says it. */
export function evidenceWord(against: IssueEvidence, t: (zh: string, en: string) => string): string {
  const number = against.ref?.replace(/[^\d]/g, '')
  const where = against.kind === 'chapter' ? t(`第 ${number !== undefined && number.length > 0 ? number : against.ref ?? '?'} 章`, `chapter ${number !== undefined && number.length > 0 ? number : against.ref ?? '?'}`)
    : against.kind === 'here' ? t('本章另一处', 'elsewhere in this chapter')
      : against.kind === 'character' ? t(`人物卡“${against.ref ?? ''}”`, `the card "${against.ref ?? ''}"`)
        : against.kind === 'world' ? t(`设定“${against.ref ?? ''}”`, `the entry "${against.ref ?? ''}"`)
          : against.kind === 'plan' ? t('本章章纲', 'this chapter\'s plan')
            : against.kind === 'style' ? t('设定的文风', 'the style set')
              : t(`参考文献${against.ref !== undefined ? `《${against.ref}》` : ''}`, `a reference${against.ref !== undefined ? ` ("${against.ref}")` : ''}`)
  return t(`${where}「${against.quote}」`, `${where}: "${against.quote}"`)
}

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
  const mends = mendsOf(project.proposals, chapterId, issue)
  const mendsHere = mends.filter(proposal => proposal.chapterId === chapterId)
  const mendsElsewhere = mends.filter(proposal => proposal.chapterId !== chapterId)
  const elsewhere = new Set(mendsElsewhere.map(proposal => proposal.chapterId)).size
  const [asked, setAsked] = useState(false)
  const revising = useRunningJob(job => job.kind === 'revise') !== undefined
  // The review that found it handed it on by itself (`reviewMends`): said while that mending is at work on it.
  const handedOn = useRunningJob(job => job.kind === 'revise' && job.title === MEND_REVIEW_JOB && job.project === root && (job.target === undefined || job.target === chapterId)) !== undefined
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
  // What the review handed in for it, where nothing was done with that yet and the author has not written otherwise.
  const ready = issue.fix !== undefined && issue.mending === undefined && note.trim().length === 0
  // What the one button does: what the review said of the issue decides — it reaches another chapter (the planner
  // traces it), or it is closed where it stands (at the quote, or where the planner settles).
  const main: MendScope = issue.wider === true && !ready ? 'book' : settled ? 'place' : 'passage'
  const fix = (scope: MendScope, anew = false) => async (): Promise<void> => {
    if (before !== undefined && !(await before())) return
    await controller.api.call('ai.fixIssue', { root, chapter: chapterId, issue: issue.id, scope, order, ...(note.trim().length > 0 ? { note: note.trim() } : {}), ...(anew ? { anew: true } : {}) })
    await controller.refreshJobs()
    controller.toast('info', under > 0 && order === 'queue'
      ? t(`排在前面 ${under} 个修订后面，接着它们改；改好之后，对比会出现在这条问题下面。`, `In line behind ${under} mending(s), going on from them; the changes will show beneath this issue.`)
      : ready && !anew && scope !== 'book' && scope !== 'chapter'
        ? issue.fix!.replace !== undefined
          ? t('审校写好的改法成了提案，就在这条问题下面，等你确认。', 'The change the review wrote out is a proposal beneath this issue now, waiting for you.')
          : t('写手照审校说的在写这一处；写好之后，对比会出现在这条问题下面。', 'The writer is writing this place by what the review said; the change will show beneath this issue.')
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
        {issue.mending !== undefined && open ? <Chip tone="blue">{t('已交给修订', 'Handed over')}</Chip> : null}
        {issue.unverified === true && open ? <Chip tone="amber" title={t('审校说这一处和别处对不上，却没有写出是哪里的哪句话——可能是凭印象说的，动手前先核一下', 'The review says this is at odds with something and does not say with what words, where — it may be from memory: check before acting on it')}>{t('没附出处', 'No evidence given')}</Chip> : null}
        {issue.wider === true && open && issue.mending === undefined ? <Chip title={t('审校说要动别的章节才能解决：点“修订”，策划去查该改哪一头', 'The review says mending it takes a change in another chapter: Revise has the planner trace which end changes')}>{t('牵连别章', 'Reaches another chapter')}</Chip> : null}
        {issue.fix !== undefined && open && issue.mending === undefined ? <Chip tone="green" title={issue.fix.replace !== undefined ? t('审校已经写好了改法：点“修订”直接出提案，不再调模型', 'The review wrote the change out: Revise proposes it as it stands, with no further call') : t('审校说清了怎么改：点“修订”交给写手写这一处', 'The review said how it changes: Revise hands this place to the writer')}>{issue.fix.replace !== undefined ? t('改法已写好', 'Change written out') : t('改法已说清', 'Change described')}</Chip> : null}
      </header>
      {issue.quote !== undefined ? (
        onLocate !== undefined
          ? <button type="button" className="nv-issue-quote" onClick={() => { onLocate(issue.quote!) }} title={t('在正文中定位', 'Locate in the text')}>{issue.quote}</button>
          : <blockquote className="nv-issue-quote">{issue.quote}</blockquote>
      ) : null}
      <p>{issue.explanation}</p>
      {issue.against !== undefined ? <p className="nv-muted nv-small" title={t('审校引的这句话，已经到它说的地方核对过：那里确实有', 'What the review quotes was looked for where it says it stands: it is there')}>{t('对不上的是：', 'At odds with: ')}{evidenceWord(issue.against, t)}</p> : null}
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
            {/* One button: how far it reaches is settled by whoever does it — what the review wrote out is proposed as it
                stands, a passage goes to the writer, what reaches another chapter is traced by the planner. The ways to
                say otherwise for this once are under the menu beside it. */}
            <Button size="sm" icon="wand" busy={here.busy} pending={t('正在开始…', 'Starting…')} onClick={() => here.run(fix(main))} title={ready
              ? issue.fix!.replace !== undefined
                ? t('审校已经写好了改法：直接出提案，不再调模型', 'The review wrote the change out: it is proposed as it stands, with no further call')
                : t('审校说清了怎么改：交给写手写这一处', 'The review said how it changes: the writer writes this place')
              : main === 'book'
                ? t('审校说要动别的章节才能解决：策划查清牵涉到哪几处，一处处改', 'The review says it takes a change in another chapter: the planner traces the places it reaches')
                : main === 'place'
                  ? bold ? t('策划定改哪几处，把它改到位——牵连到的呼应一并改', 'The planner settles which places change and mends it through — with what hangs on it') : t('策划定改哪一处最省，只改那一处', 'The planner settles which place mends it with the least change')
                  : bold ? t('改引文所在的这一段', 'Rewrite the passage the quote stands in') : t('只改引文这一处', 'Rewrite the quoted place only')}>
              {t('修订', 'Revise')}
            </Button>
            <Menu icon="more" variant="ghost" size="sm" align="end" items={[
              ...(main !== 'book' ? [{ label: t('全书修订：把牵涉到的章节和设定都查一遍', 'Through the book: trace the chapters and the bible it reaches'), icon: 'layers' as const, onSelect: () => { void everywhere.run(fix('book')) } }] : []),
              ...(issue.quote !== undefined ? [settled || main === 'book' || ready
                ? { label: bold ? t('只改引文所在的这一段（另写一遍，不用审校的改法）', 'Rewrite only the passage the quote stands in (anew, not by the review\'s change)') : t('只改引文这一处（另写一遍，不用审校的改法）', 'Rewrite the quoted place only (anew, not by the review\'s change)'), icon: 'wand' as const, onSelect: () => { void whole.run(fix('passage', true)) } }
                : { label: bold ? t('让策划定改哪几处', 'Let the planner settle the places') : t('让策划定改哪一处', 'Let the planner settle the place'), icon: 'wand' as const, onSelect: () => { void whole.run(fix('place', true)) } }] : []),
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
      {!asked && handedOn && open && mends.length === 0 && issue.mending === undefined ? <p className="nv-muted nv-small">{t('审校之后交给策划在修订…改动会出现在这里。', 'Handed to the planner after the review… the change will show here.')}</p> : null}
      {mendsHere.map(proposal => (proposal.issues?.length ?? 0) > 1
        ? <details key={proposal.id} className="nv-issue-mend"><summary>{proposal.kind === 'span' ? t(`一处修订（这一批在修订这一章的 ${proposal.issues!.length} 个问题）`, `A change to one place (the batch mends ${proposal.issues!.length} issues of this chapter)`) : t(`这一章的修订（同时修订 ${proposal.issues!.length} 个问题）`, `This chapter's change (mends ${proposal.issues!.length} issues)`)}</summary><ProposalCard bare proposal={proposal} onSettled={() => { onChanged?.() }} /></details>
        : <ProposalCard key={proposal.id} bare proposal={proposal} onSettled={() => { onChanged?.() }} />)}
      {mendsElsewhere.length > 0 ? (
        <details className="nv-issue-mend">
          <summary>{elsewhere === mendsElsewhere.length
            ? t(`这次修订还改了别的 ${elsewhere} 章`, `This mending also changed ${elsewhere} other chapter(s)`)
            : t(`这次修订还改了别的 ${elsewhere} 章里的 ${mendsElsewhere.length} 处`, `This mending also changed ${mendsElsewhere.length} place(s) in ${elsewhere} other chapter(s)`)}</summary>
          {mendsElsewhere.map(proposal => <ProposalCard key={proposal.id} bare proposal={proposal} showChapter onSettled={() => { onChanged?.() }} />)}
        </details>
      ) : null}
    </article>
  )
}

/** What the author's sentence came to (`ai.reviewLead`). */
interface LeadOutput { found?: { chapterId: string; index: number }[]; chapters?: number; fix?: boolean; note?: string; book?: { results?: { index?: number }[]; failed?: unknown[]; direct?: boolean; wrote?: { analyst?: number; planner?: number; writer?: number } } }

/**
 * Whose words the changes of a revision are, in a few words: the planner's own, the writer's model's, or so many of
 * each — said with what the revision came to, since the two are not the same price.
 * @param direct - what a Host half older than this page says in place of the counts.
 */
export function wroteWord(wrote: { analyst?: number; planner?: number; writer?: number } | undefined, direct: boolean, t: (zh: string, en: string) => string): string {
  const found = wrote?.analyst ?? 0
  const own = wrote?.planner ?? 0
  const handed = wrote?.writer ?? 0
  // (The reviewer's own small changes cost no call; the planner's cost its own run; the writer's a call a place.)
  const parts = [
    found > 0 ? t(`${found} 处场记审校时直接改好`, `${found} mended by the reviewer as it read`) : undefined,
    own > 0 ? t(`${own} 处策划直接改`, `${own} written by the planner itself`) : undefined,
    handed > 0 ? t(`${handed} 处交给写手写`, `${handed} by the writer`) : undefined,
  ].filter((part): part is string => part !== undefined)
  if (parts.length > 1) return parts.join(t('，', ', '))
  if (found > 0) return t('场记审校时直接改好的', 'mended by the reviewer as it read')
  if (own > 0 || (wrote === undefined && direct)) return t('策划直接写的', 'written by the planner itself')
  if (handed > 0) return t('写手写的', 'written by the writer')
  return ''
}

/** …said in a line. */
export function leadWord(output: LeadOutput | undefined, t: (zh: string, en: string) => string): string {
  const found = output?.found?.length ?? 0
  const note = output?.note !== undefined && output.note.trim().length > 0 ? clip(output.note.trim(), 220) : undefined
  const said = note !== undefined ? t(` 策划：${note}`, ` The planner: ${note}`) : ''
  const made = output?.book?.results?.length ?? 0
  const failed = output?.book?.failed?.length ?? 0
  const who = wroteWord(output?.book?.wrote, output?.book?.direct === true, t)
  if (found === 0) {
    // Taken as a request: nothing was filed, and the places it reaches wait as a round of proposals.
    if (made > 0) {
      const at = [...new Set((output?.book?.results ?? []).map(item => item.index).filter((index): index is number => typeof index === 'number'))].sort((left, right) => left - right)
      return t(
        `当作修改要求办的：改了 ${made} 处${at.length > 0 ? `（第 ${at.join('、')} 章）` : ''}${who.length > 0 ? `，${who}` : ''}，在“修订提案”里等你确认${failed > 0 ? `；${failed} 处没改成` : ''}。${said}`,
        `Taken as a request: ${made} change(s)${at.length > 0 ? ` (chapter ${at.join(', ')})` : ''}${who.length > 0 ? `, ${who},` : ''} wait under Proposals${failed > 0 ? `; ${failed} failed` : ''}.${said}`,
      )
    }
    return t(`照你说的没有找到要改的地方。${said}`, `Nothing was found for it.${said}`)
  }
  const chapters = [...new Set(output!.found!.map(item => item.index))].sort((left, right) => left - right)
  const where = t(`照你说的找到了 ${found} 处（第 ${chapters.join('、')} 章），记成了审校问题`, `Found in ${found} place(s) (chapter ${chapters.join(', ')}), each filed as an issue`)
  const changed = output?.fix === false
    ? t('；这一次只找，没有改。', '; found only, nothing changed.')
    : made === 0
      ? t(`；没有出修订${failed > 0 ? `（${failed} 处没改成）` : ''}。`, `; no change was made${failed > 0 ? ` (${failed} failed)` : ''}.`)
      : t(`；修订了 ${made} 处${who.length > 0 ? `（${who}）` : ''}，在各条问题下面等你确认${failed > 0 ? `，${failed} 处没改成` : ''}。`, `; ${made} change(s)${who.length > 0 ? ` (${who})` : ''} wait beneath the issues${failed > 0 ? `, ${failed} failed` : ''}.`)
  return `${where}${changed}${said}`
}

/** The pieces of work started by a sentence of the author's that are under way or over, for this book: the last one says what it came to. */
export function useLeadJobs(): { running: JobInfo[]; last: JobInfo | undefined } {
  const { root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const mine = jobs.filter(job => job.kind === 'revise' && job.title === 'review by lead' && job.project === root)
  // (Whatever order they are listed in — the Host lists the newest first — the last is the one started last.)
  const done = mine.filter(job => job.status === 'done').sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  return { running: mine.filter(job => job.status === 'running'), last: done.at(-1) }
}

/** A chapter nobody reviewed yet (one that only holds what the author's own words found in it was not). */
const unreviewed = (info: ChapterInfo): boolean => info.openIssues === undefined || info.unreviewed === true

/**
 * Review and revision: one bar, the same wherever a chapter — or a line of them — is to be reviewed or changed. The
 * review page has it for a line of the plot or chapters picked from it; the editor's panel and the reader have it
 * for the chapter in hand.
 *
 * Nothing said: a review. The scribe reads each chapter in reach and lists what it finds — and what it finds goes on
 * to be mended by itself unless the author has that switched off (the small triangle beside the button).
 *
 * Something said, in a sentence: the planner tells what it is. Something the author noticed that is wrong — a pair
 * of glasses that come and go, days that do not add up: the planner finds it in the book, files each place it shows
 * as an issue of its chapter (marked as the author's own), and mends it, each change shown beneath its issue. A
 * change the author wants made — a thing called otherwise, a card that changed and has to show: the planner names
 * the places it reaches and changes them; the changes wait as a round of proposals. "Find only" files and changes
 * nothing.
 * @param chapters - keep it to these chapters (beside a chapter: the one that is open); left out, the author picks — the whole line of the plot in hand, or chapters of it.
 * @param before - asked before anything is started (the editor saves what is being typed); a `false` calls it off.
 * @param onProposals - where the changes of a request wait: the way there, offered once such a round has been made.
 * @param disabled - there is nothing to review or change yet (a chapter without text).
 */
export function ReviseBar({ chapters, before, onStarted, onProposals, className, disabled, children }: { chapters?: string[]; before?: () => Promise<boolean>; onStarted?: (what: 'review' | 'revise') => void; onProposals?: () => void; className?: string; disabled?: boolean; children?: ReactNode }) {
  const { controller } = useStudio()
  const t = useT()
  const actions = useBookActions()
  const confirm = useConfirm()
  const { project, root } = useProject()
  const fixed = chapters !== undefined
  const [say, setSay] = useKept(fixed ? `review.lead.${chapters.join(',')}` : 'review.lead', '')
  const [scope, setScope] = useState<'line' | 'pick'>('line')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // Pictures the change goes by: the planner looks into it with them, and every place is changed by them.
  const [guides, setGuides] = useState<PictureGuide[]>([])
  const [order] = useMendOrder()
  const [by] = useMendBy()
  const under = useMendings()
  const { running, last } = useLeadJobs()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const batch = useBatchJob('text')?.status === 'running'
  // The line of the plot in hand: its chapters as they are read on it.
  const others = project.outline.lines ?? []
  const [line, setLine] = useBookLine()
  const known = new Map([...project.chapters, ...(project.lines ?? []).flatMap(candidate => candidate.chapters)].map(info => [info.id, info]))
  const path = line === MAIN_LINE ? project.chapters : (project.lines?.find(candidate => candidate.id === line)?.path ?? []).map(id => known.get(id)).filter((info): info is ChapterInfo => info !== undefined)
  const written = path.filter(chapter => chapter.hasText)
  const within = fixed ? chapters : scope === 'pick' ? [...picked].filter(id => written.some(chapter => chapter.id === id)) : undefined
  const said = say.trim()
  const ready = disabled !== true && (fixed || (written.length > 0 && (scope === 'line' || (within?.length ?? 0) > 0)))

  // ── nothing said: a review ──
  // The chapters named are reviewed, again where they were before; a whole line, the ones nobody reviewed yet — and
  // all of them again (asked first) once none is left.
  const reach: ChapterInfo[] = fixed ? chapters.map(id => known.get(id)).filter((info): info is ChapterInfo => info !== undefined && info.hasText) : scope === 'pick' ? written.filter(chapter => picked.has(chapter.id)) : written
  const fresh = reach.filter(unreviewed)
  const wholeLine = !fixed && scope === 'line'
  const due = wholeLine && fresh.length > 0 ? fresh : reach
  const again = wholeLine && fresh.length === 0 && reach.length > 0
  const reviewing = batch || jobs.some(job => job.status === 'running' && job.kind === 'review' && job.title === 'review' && job.project === root && (!fixed || chapters.includes(job.target ?? '')))
  const review = (): Promise<unknown> => controller.guard(async () => {
    if (before !== undefined && !(await before())) return
    if (due.length === 1) await actions.review(due[0]!.id)
    else {
      await controller.api.call('batch.text', { root, steps: ['review'], chapters: due.map(chapter => chapter.id), ...(due.some(chapter => !unreviewed(chapter)) ? { redo: true } : {}) })
      await controller.refreshJobs()
    }
    onStarted?.('review')
  })
  const reviewLabel = fixed
    ? reach.some(unreviewed) || reach.length === 0 ? t('审校这一章', 'Review this chapter') : t('重新审校', 'Review again')
    : scope === 'pick'
      ? t(`审校选中的 ${due.length} 章`, `Review the ${due.length} picked`)
      : again ? t(`全部重审 · ${due.length} 章`, `Review all ${due.length} again`) : t(`审校未审的 ${due.length} 章`, `Review ${due.length} unreviewed`)

  // ── something said: the planner tells what it is, and carries it out ──
  const start = (fix: boolean): Promise<unknown> => controller.guard(async () => {
    if (before !== undefined && !(await before())) return
    await controller.api.call('ai.reviewLead', { root, lead: said, fix, order, ...(within !== undefined ? { chapters: within } : {}), ...(!fixed && line !== MAIN_LINE ? { line } : {}), ...(guides.length > 0 ? { guides } : {}) })
    await controller.refreshJobs()
    controller.toast('info', fix
      ? under > 0 && order === 'queue'
        ? t(`排在前面 ${under} 个修订后面，接着它们改；改动出现在各条问题下面，或“修订提案”里。`, `In line behind ${under} revision(s), going on from them; the changes show beneath the issues, or under Proposals.`)
        : t(`策划在看你说的：是毛病，找到的记成审校问题，改动${by === 'planner' ? '由策划直接写，' : by === 'auto' ? '（小的策划直接写，要成段写的交给写手）' : ''}出现在各条问题下面；是修改要求，改动在“修订提案”里等你确认。`, `The planner is looking into it: a fault is filed as issues and the changes${by === 'planner' ? ', written by the planner itself,' : by === 'auto' ? ' (small ones written by the planner, passages by the writer)' : ''} show beneath them; a request is carried out and its changes wait under Proposals.`)
      : t('策划照你说的去查；找到的记成审校问题，这一次不改。', 'The planner is looking into it; what is found is filed as issues, and nothing is changed this time.'))
    setSay('')
    setGuides([])
    onStarted?.('revise')
  })
  // A change to the bible carried through the text: said for the author, in the box, to be sent or changed first.
  const fromWorld = (id: string): void => {
    const entry = project.world.find(candidate => candidate.id === id)
    if (entry === undefined) return
    setSay(t(
      `世界观设定「${entry.name}」已更新为：${clip([entry.summary, entry.body].filter(Boolean).join(' '), 600)}\n请找出正文中与新设定矛盾、或需要与之呼应的地方并改写；与此无关的内容一字不动。`,
      `The world entry "${entry.name}" now reads: ${clip([entry.summary, entry.body].filter(Boolean).join(' '), 600)}\nFind every place in the manuscript that contradicts it or should now reflect it, and rewrite those; leave everything else untouched.`,
    ))
  }
  const fromCharacter = (id: string): void => {
    const card = project.characters.find(candidate => candidate.id === id)
    if (card === undefined) return
    const facts = [card.tagline, card.personality, card.voice !== undefined ? t(`说话方式：${card.voice}`, `voice: ${card.voice}`) : undefined, card.appearance !== undefined ? t(`外貌：${card.appearance}`, `appearance: ${card.appearance}`) : undefined].filter(Boolean).join('；')
    setSay(t(
      `人物「${card.name}」的设定已更新：${clip(facts, 600)}\n请让正文中${card.name}的言行、外貌描写与对白都符合新设定；不改变情节走向，与此无关的内容一字不动。`,
      `The character "${card.name}" has been revised: ${clip(facts, 600)}\nMake ${card.name}'s actions, description and dialogue throughout the manuscript match; do not change the plot, and leave everything unrelated untouched.`,
    ))
  }
  const lastOutput = last?.result?.output as LeadOutput | undefined
  const asRequest = (lastOutput?.found?.length ?? 0) === 0 && (lastOutput?.book?.results?.length ?? 0) > 0
  return (
    <div className={cx('nv-card nv-lead', className)}>
      <div className="nv-lead-head">
        <strong>{t('审校和修订', 'Review and revision')}</strong>
        <span className="nv-muted nv-small">{fixed
          ? t('这一章哪里不对、要改什么，写一句——是毛病还是修改要求，策划自己判断。不写就是审校。', 'What is wrong with this chapter, or what is to change, in a sentence — the planner tells which it is. Nothing said: a review.')
          : t('哪里不对、要改什么，写一句——是毛病还是修改要求，策划自己判断。不写就是审校。', 'What is wrong, or what is to change, in a sentence — the planner tells which it is. Nothing said: a review.')}</span>
      </div>
      <TextArea value={say} minRows={fixed ? 1 : 2} maxRows={10} disabled={disabled === true} placeholder={t('例：柳先生的眼镜一会儿有一会儿没有；把“灵力”都改称“炁”', 'E.g. his glasses come and go; call every "spirit power" "qi"')} onChange={(event) => { setSay(event.target.value) }} />
      {!fixed ? (
        <div className="nv-row nv-lead-scope">
          {others.length > 0 ? <Select value={line} options={[{ value: MAIN_LINE, label: t('主线', 'Main line') }, ...others.map(item => ({ value: item.id, label: item.title }))]} onChange={(value) => { setLine(value); setPicked(new Set()) }} /> : null}
          <Select value={scope} options={[{ value: 'line', label: t(`这条线写了的 ${written.length} 章`, `The ${written.length} written chapters of this line`) }, { value: 'pick', label: t('只在我选的章节里', 'Only the chapters I pick') }]} onChange={setScope} />
          {project.world.length > 0 ? <Select value="" options={[{ value: '', label: t('同步一条世界观变更…', 'Carry a world change through…') }, ...project.world.map(entry => ({ value: entry.id, label: entry.name }))]} onChange={fromWorld} /> : null}
          {project.characters.length > 0 ? <Select value="" options={[{ value: '', label: t('同步一次人物变更…', 'Carry a character change through…') }, ...project.characters.map(card => ({ value: card.id, label: card.name }))]} onChange={fromCharacter} /> : null}
        </div>
      ) : null}
      {!fixed && scope === 'pick' ? (
        <div className="nv-chips">
          {written.map(chapter => <Chip key={chapter.id} tone={picked.has(chapter.id) ? 'blue' : 'neutral'} active={picked.has(chapter.id)} onClick={() => { setPicked((previous) => { const next = new Set(previous); if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id); return next }) }}>{chapter.index}. {chapter.title}</Chip>)}
        </div>
      ) : null}
      {/* (Pictures are for a change: a review reads the text.) */}
      {said.length > 0 ? <GuidePictures brief value={guides} onChange={setGuides} {...(fixed && chapters.length === 1 ? { chapter: chapters[0]! } : {})} hint={t('策划照着图去查、去定改哪几处，每一处照着图改（只这一次）', 'The planner looks into it and settles the places by them, and each place is changed by them (this once)')} /> : null}
      <div className="nv-row nv-lead-actions">
        {said.length === 0 ? (
          <>
            <Button size="sm" variant="primary" icon="checkCircle" busy={reviewing} disabled={!ready || due.length === 0} pending={t('审校中…', 'Reviewing…')} onClick={() => { if (again) confirm.ask(t(`这条线的 ${due.length} 章都审校过了：全部重审？`, `All ${due.length} chapters of this line were reviewed: review them all again?`), () => { void review() }); else void review() }} title={t('没写要求：场记逐章审校，对照设定、记忆与文风列出问题', 'Nothing said: the scribe reviews each chapter against the bible, memory and style, and lists what it finds')}>{reviewLabel}</Button>
            <ReviewMendsMenu />
          </>
        ) : (
          <>
            <div className="nv-split-btn">
              <Button size="sm" variant="primary" icon="wand" disabled={!ready} pending={t('正在开始…', 'Starting…')} onClick={() => start(true)} title={t('策划判断你说的是什么：是毛病，找出来、记成审校问题、再修订，改动出现在各条问题下面；是修改要求，照着改，改动在“修订提案”里。都是提案，采纳了才进正文', 'The planner tells what it is: a fault is found, filed as issues and mended, the changes beneath them; a request is carried out, its changes under Proposals. All of them proposals — nothing enters the text until you accept it')}>{t('修订', 'Revise')}</Button>
              <MendOrderMenu />
            </div>
            <Button size="sm" variant="outline" icon="search" disabled={!ready} pending={t('正在开始…', 'Starting…')} onClick={() => start(false)} title={t('只查、只记成审校问题，先不改', 'Looked into and filed as issues, nothing changed yet')}>{t('只找出来', 'Find only')}</Button>
          </>
        )}
        {children}
      </div>
      {running.map(job => <JobBar key={job.id} job={job} />)}
      {running.length === 0 && last !== undefined ? (
        <p className="nv-note nv-small">
          {t('上一次：', 'Last time: ')}{leadWord(lastOutput, t)}
          {asRequest && onProposals !== undefined ? <>{' '}<button type="button" className="nv-link" onClick={onProposals}>{t('去看', 'See them')}</button></> : null}
        </p>
      ) : null}
      {confirm.element}
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
      ? t(`这 ${chosen.length} 个问题排在前面 ${under} 个修订后面，接着它们改。`, `These ${chosen.length} are in line behind ${under} mending(s), and go on from them.`)
      : t(`策划正在把这 ${chosen.length} 个问题放在一起看；改好之后，对比会出现在各条问题下面。`, `The planner is reading these ${chosen.length} side by side; the changes will show beneath the issues.`))
    onStarted?.()
  })
  return (
    <div className="nv-assist nv-issue-batch">
      {children}
      <TextInput value={say} placeholder={t('对这一批的要求', 'What to ask of this batch')} onChange={(event) => { setSay(event.target.value) }} />
      <div className="nv-split-btn">
        <Button size="sm" variant="primary" icon="layers" disabled={chosen.length === 0} onClick={start}>{t(`一起修订选中的 ${chosen.length} 个`, `Mend the ${chosen.length} chosen together`)}</Button>
        <MendOrderMenu />
      </div>
      {under > 0 ? <span className="nv-muted nv-small">{order === 'queue' ? t(`${under} 个修订在做，新的排在后面`, `${under} mending(s) under way; a new one waits its turn`) : t(`${under} 个修订在做，新的同时开始`, `${under} mending(s) under way; a new one starts beside them`)}</span> : null}
    </div>
  )
}

/** The changes that wait beneath a set of issues, each once, in the order of the issues. */
export function mendsOfAll(proposals: readonly Proposal[], items: readonly BatchItem[]): Proposal[] {
  const seen = new Set<string>()
  const out: Proposal[] = []
  for (const item of items) {
    for (const proposal of mendsOf(proposals, item.chapterId, item.issue)) {
      if (seen.has(proposal.id)) continue
      seen.add(proposal.id)
      out.push(proposal)
    }
  }
  return out
}

/**
 * The changes that wait beneath a set of issues, taken or turned down in one go: a line above the issues — in the
 * editor's panel and the reader's, over a chapter of the review page, and over the review page as a whole. Nothing
 * is shown where fewer than `least` wait (one change has its own two buttons right beneath its issue).
 * @param ask - the author is asked before they are taken (where not every one of them is in view).
 */
export function MendsBar({ items, least = 2, ask, onSettled, className }: { items: readonly BatchItem[]; least?: number; ask?: boolean; onSettled?: () => void; className?: string }) {
  const t = useT()
  const { project } = useProject()
  const waiting = mendsOfAll(project.proposals, items)
  if (waiting.length < Math.max(1, least)) return null
  const chapters = new Set(waiting.map(proposal => proposal.chapterId)).size
  return (
    <div className={cx('nv-row nv-proposals-all nv-mends-all', className)}>
      <span className="nv-muted nv-small">{chapters > 1
        ? t(`${waiting.length} 处修订在等你确认（${chapters} 章）`, `${waiting.length} changes wait for you (in ${chapters} chapters)`)
        : t(`${waiting.length} 处修订在等你确认`, `${waiting.length} change(s) wait for you`)}</span>
      <span className="nv-spacer" />
      <SettleAll proposals={waiting} {...(ask === true ? { ask: true } : {})} onSettled={() => { onSettled?.() }} />
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
      {/* Every change that waits beneath these issues — in this chapter, and where a mending reached into others — settled at once. */}
      <MendsBar items={issues.map(issue => ({ chapterId, issue }))} onSettled={() => { onChanged?.() }} />
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

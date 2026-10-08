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
 *   issueMarks    where the issues of a chapter sit in its text, for a page that marks them
 */
import type { ChapterReview, ReviewIssue } from '../shared/types'
import { fuzzyFind } from '../shared/text'
import { ISSUE_TYPE, SEVERITY, SEVERITY_TONE } from './labels'
import { Button, Chip, cx, TextArea, useAction, useKept, useProject, useStudio, useT } from './ui'

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
  after?: (scope: 'passage' | 'book') => void
  className?: string
  /** One of a batch to be mended together: shown with a tick box. */
  selected?: boolean
  onSelect?: (on: boolean) => void
}) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [note, setNote] = useKept(issueNoteKey(chapterId, issue.id), issue.note ?? '')
  // What the author says of an issue is kept with it: it goes along when the issue is mended in a batch, and to the showrunner.
  const keep = (): void => {
    if (note.trim() === (issue.note ?? '')) return
    // (A Host from before notes were kept refuses: the words stay in the box and still go along with a fix started here.)
    void controller.api.call('review.note', { root, chapter: chapterId, issue: issue.id, note: note.trim() }).then(() => { onChanged?.() }, () => {})
  }
  const here = useAction()
  const everywhere = useAction()
  const settle = useAction()
  const fix = (scope: 'passage' | 'book') => async (): Promise<void> => {
    if (before !== undefined && !(await before())) return
    await controller.api.call('ai.fixIssue', { root, chapter: chapterId, issue: issue.id, scope, ...(note.trim().length > 0 ? { note: note.trim() } : {}) })
    await controller.refreshJobs()
    controller.toast('info', scope === 'book'
      ? t('策划正在查这个问题牵涉的范围，改动会作为提案等你确认。', 'The planner is tracing how far this reaches; the changes will wait as proposals.')
      : t('改好之后会作为一条提案等你确认。', 'The rewrite will wait for you as a proposal.'))
    after?.(scope)
  }
  const open = issue.resolved !== true
  return (
    <article className={cx('nv-issue', !open && 'is-resolved', className)}>
      <header>
        {onSelect !== undefined && open ? <input type="checkbox" checked={selected === true} onChange={(event) => { onSelect(event.target.checked) }} aria-label={t('选中这个问题', 'Select this issue')} /> : null}
        <Chip tone={SEVERITY_TONE[issue.severity]}>{t(...SEVERITY[issue.severity])}</Chip>
        <Chip>{t(...ISSUE_TYPE[issue.type])}</Chip>
        {issue.mending !== undefined && open ? <Chip tone="blue">{t('已交给修复', 'Handed over')}</Chip> : null}
      </header>
      {issue.quote !== undefined ? (
        onLocate !== undefined
          ? <button type="button" className="nv-issue-quote" onClick={() => { onLocate(issue.quote!) }} title={t('在正文中定位', 'Locate in the text')}>{issue.quote}</button>
          : <blockquote className="nv-issue-quote">{issue.quote}</blockquote>
      ) : null}
      <p>{issue.explanation}</p>
      {issue.suggestion !== undefined ? <p className="nv-muted nv-small">{t('建议：', 'Suggestion: ')}{issue.suggestion}</p> : null}
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
            <Button size="sm" icon="wand" busy={here.busy} pending={t('正在开始…', 'Starting…')} onClick={() => here.run(fix('passage'))} title={issue.quote !== undefined ? t('只改引文这一处', 'Rewrite the quoted place only') : t('按它重写这一章', 'Rewrite the chapter for it')}>
              {issue.quote !== undefined ? t('修这一处', 'Mend it here') : t('修这一章', 'Mend the chapter')}
            </Button>
            <Button size="sm" icon="layers" busy={everywhere.busy} pending={t('正在开始…', 'Starting…')} onClick={() => everywhere.run(fix('book'))} title={t('让策划查清牵涉的章节和设定，一起改', 'The planner traces the chapters and the bible it reaches, and mends them together')}>
              {t('全局修复', 'Mend it everywhere')}
            </Button>
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
    </article>
  )
}

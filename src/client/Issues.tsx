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
 *   IssueCard     one issue: what is wrong, the author's say, mend here / mend everywhere / settled
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

/**
 * @param before - asked before a fix is started (the editor saves what is being typed); a `false` calls it off.
 * @param after - told once a fix has been started.
 * @param onLocate - show the quoted words in the text.
 */
export function IssueCard({ chapterId, issue, onLocate, onChanged, before, after, className }: {
  chapterId: string
  issue: ReviewIssue
  onLocate?: (quote: string) => void
  onChanged?: () => void
  before?: () => Promise<boolean>
  after?: (scope: 'passage' | 'book') => void
  className?: string
}) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [note, setNote] = useKept(`issue.note.${chapterId}.${issue.id}`, '')
  const here = useAction()
  const everywhere = useAction()
  const settle = useAction()
  const fix = (scope: 'passage' | 'book') => async (): Promise<void> => {
    if (before !== undefined && !(await before())) return
    await controller.api.call('ai.fixIssue', { root, chapter: chapterId, issue: issue.id, scope, ...(note.trim().length > 0 ? { note: note.trim() } : {}) })
    await controller.refreshJobs()
    controller.toast('info', scope === 'book'
      ? t('策划正在查这个问题牵涉到哪些章节和设定；每一处改动都会作为提案（设定的改动作为建议）等你确认。', 'The planner is tracing this problem through the chapters and the bible; every change will wait for you as a proposal (changes to the bible as suggestions).')
      : t('改好之后会作为一条提案等你确认。', 'The rewrite will wait for you as a proposal.'))
    after?.(scope)
  }
  const open = issue.resolved !== true
  return (
    <article className={cx('nv-issue', !open && 'is-resolved', className)}>
      <header>
        <Chip tone={SEVERITY_TONE[issue.severity]}>{t(...SEVERITY[issue.severity])}</Chip>
        <Chip>{t(...ISSUE_TYPE[issue.type])}</Chip>
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
          placeholder={t('你想怎么改？（可不填：不填就按上面的建议改）', 'How do you want it mended? (Optional: left empty, the suggestion above is followed)')}
          onChange={(event) => { setNote(event.target.value) }}
        />
      ) : null}
      <footer>
        {open ? (
          <>
            <Button size="sm" icon="wand" busy={here.busy} pending={t('正在开始…', 'Starting…')} onClick={() => here.run(fix('passage'))} title={issue.quote !== undefined ? t('只改引文这一处', 'Rewrite the quoted place only') : t('这个问题没有引用具体的句子：按它重写这一章', 'This problem quotes no sentence: the chapter is rewritten for it')}>
              {issue.quote !== undefined ? t('修这一处', 'Mend it here') : t('修这一章', 'Mend the chapter')}
            </Button>
            <Button size="sm" icon="layers" busy={everywhere.busy} pending={t('正在开始…', 'Starting…')} onClick={() => everywhere.run(fix('book'))} title={t('让策划查清这个问题在全书的影响范围，把牵涉到的章节和设定一起改；每一处改动都等你确认', 'The planner traces how far the problem reaches and changes every chapter and bible entry it touches; each change waits for your yes')}>
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

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Review: an editor's read of one chapter against the bible, the story so far
 * and the style profile. Issues anchor to exact quotes so the UI can jump to
 * them and a fix can be requested as a span revision.
 */
import type { ChapterReview, IssueSeverity, IssueType, ReviewIssue } from '../../shared/types'
import { fuzzyFind, hashText, newId } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asRecord, asText } from '../llm'
import { assign } from '../crew'
import { ProjectError } from '../project'
import { recheckTask, reviewTask } from '../prompts'
import { L, promptLanguage } from '../render'

const SEVERITIES: IssueSeverity[] = ['high', 'medium', 'low']
const TYPES: IssueType[] = ['continuity', 'character', 'world', 'timeline', 'style', 'pacing', 'logic', 'language']

export async function reviewChapter(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; focus?: string }, task: TaskContext): Promise<ChapterReview & { title: string; index: number }> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const text = await project.chapterText(chapter.plan.id)
  if (text.length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has no text to review`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('analyst', runtime, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'review',
    chapter,
    ...(params.focus !== undefined ? { brief: params.focus } : {}),
    includeChapterText: true,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const style = await project.activeStyle()
  const styleNote = style !== undefined
    ? `\n\n## ${L(lang, '设定的文风', 'Style profile')}\n\n${[style.tone, style.diction, style.rhythm, ...(style.rules ?? []), ...(style.avoid ?? []).map(item => `${L(lang, '避免', 'avoid')}: ${item}`)].filter(Boolean).join('\n')}`
    : ''
  const { value } = await assign(core, runtime, task, {
    role: 'analyst',
    label: L(lang, `第${chapter.index}章 · 审校`, `Ch. ${chapter.index} · review`),
    tool: 'file_review',
    what: L(lang, '这一章的审校意见：总评和逐条问题', 'the review of this chapter: a verdict and the issues, one by one'),
    prompt: reviewTask({ lang, language: manifest.language, title: manifest.title, context: `${pack.text}${styleNote}`, ...(params.focus !== undefined ? { focus: params.focus } : {}) }),
    temperature: 0.2,
    validate: raw => asRecord(raw),
  })
  const issues: ReviewIssue[] = []
  for (const raw of asArray(value.issues)) {
    const item = asRecord(raw)
    const explanation = asText(item.explanation)
    if (explanation === undefined) continue
    const severity = asText(item.severity) as IssueSeverity | undefined
    const type = asText(item.type) as IssueType | undefined
    const quote = asText(item.quote)
    const suggestion = asText(item.suggestion)
    // A quote that is not in the text cannot anchor anything; keep the issue, drop the anchor.
    const anchored = quote !== undefined ? fuzzyFind(text, quote) : undefined
    issues.push({
      id: newId('is'),
      severity: severity !== undefined && SEVERITIES.includes(severity) ? severity : 'medium',
      type: type !== undefined && TYPES.includes(type) ? type : 'logic',
      ...(anchored !== undefined ? { quote: text.slice(anchored.start, anchored.end) } : {}),
      explanation,
      ...(suggestion !== undefined ? { suggestion } : {}),
    })
  }
  const order: Record<IssueSeverity, number> = { high: 0, medium: 1, low: 2 }
  issues.sort((left, right) => order[left.severity] - order[right.severity])
  const review: ChapterReview = {
    chapterId: chapter.plan.id,
    textHash: hashText(text),
    createdAt: new Date().toISOString(),
    verdict: asText(value.verdict) ?? '',
    issues,
  }
  await project.saveReview(review)
  task.job?.result({ chapterId: chapter.plan.id, issues: issues.length })
  return { ...review, title: chapter.plan.title, index: chapter.index }
}

export async function resolveIssue(runtime: ProjectRuntime, chapterId: string, issueId: string, resolved: boolean): Promise<ChapterReview | undefined> {
  const review = await runtime.project.review(chapterId)
  if (review === undefined) return undefined
  const next: ChapterReview = { ...review, issues: review.issues.map(issue => issue.id === issueId ? { ...issue, resolved } : issue) }
  await runtime.project.saveReview(next)
  return next
}

export interface RecheckResult {
  /** How many open issues were looked at again, in how many chapters. */
  looked: number
  chapters: number
  /** Settled by the change: marked as such. */
  fixed: { chapterId: string; index: number; issue: string; why?: string }[]
  /** Still there, reading differently now: quote and explanation brought up to the text. */
  changed: { chapterId: string; index: number; issue: string }[]
}

/**
 * After proposals were accepted: look again at what is still open. A change
 * made to mend one thing often settles another beside it — or, mended across
 * the book, an issue in a chapter that did not change at all — and moves the
 * sentence a third one quoted. The reviewer reads the open issues of the
 * chapters that changed, and those that were handed over with the same batch
 * wherever they are, against the text as it stands: what the change settled
 * is marked settled, what reads differently is brought up to date.
 * @param params.chapters - chapters whose text changed.
 * @param params.batches - batches of proposals accepted from: issues handed over with them are looked at wherever they are.
 * @param params.changes - what was changed, for the reviewer: a few lines per accepted proposal.
 */
export async function recheckIssues(core: NovelCore, runtime: ProjectRuntime, params: { chapters: string[]; batches?: string[]; changes: string }, task: TaskContext): Promise<RecheckResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const changed = new Set(params.chapters)
  const batches = new Set(params.batches ?? [])
  const result: RecheckResult = { looked: 0, chapters: 0, fixed: [], changed: [] }
  const stopped = (): boolean => task.signal?.aborted === true
  for (const review of await listReviews(runtime)) {
    // Of a chapter that changed: everything open. Of any other: what was handed over with a batch now accepted from.
    const due = review.issues.filter(issue => issue.resolved !== true && (changed.has(review.chapterId) || (issue.mending !== undefined && batches.has(issue.mending))))
    if (due.length === 0) continue
    if (stopped()) break
    const text = await project.chapterText(review.chapterId)
    const listed = due.map(issue => [
      `- id: ${issue.id}`,
      L(lang, `  说明：${issue.explanation}`, `  what: ${issue.explanation}`),
      issue.quote !== undefined ? L(lang, `  当时引的原文："${issue.quote}"${fuzzyFind(text, issue.quote) === undefined ? '（现在的正文里已经没有这一句）' : ''}`, `  quoted then: "${issue.quote}"${fuzzyFind(text, issue.quote) === undefined ? ' (no longer in the text)' : ''}`) : '',
    ].filter(line => line.length > 0).join('\n')).join('\n')
    let verdicts: unknown[]
    try {
      const { value } = await assign(core, runtime, task, {
        role: 'analyst',
        label: L(lang, `第${review.index}章 · 核对审校意见`, `Ch. ${review.index} · issues looked at again`),
        tool: 'file_recheck',
        what: L(lang, '这一章还开着的审校意见现在各自怎样了', 'how each of this chapter\'s open issues stands now'),
        prompt: recheckTask({ lang, language: manifest.language, title: manifest.title, chapter: L(lang, `第 ${review.index} 章《${review.title}》`, `chapter ${review.index}, "${review.title}"`), text, issues: listed, changes: params.changes }),
        temperature: 0.1,
        validate: raw => asRecord(raw),
      })
      verdicts = asArray(value.issues)
    } catch (error) {
      if (stopped()) throw error
      core.log(`could not look again at the issues of ${review.chapterId}`, error)
      continue
    }
    result.looked += due.length
    result.chapters += 1
    const at = new Date().toISOString()
    const said = new Map(verdicts.map(raw => asRecord(raw)).map(item => [asText(item.id) ?? '', item]))
    const current = await project.review(review.chapterId)
    if (current === undefined) continue
    await project.saveReview({ ...current, issues: current.issues.map((issue) => {
      const item = said.get(issue.id)
      if (item === undefined || issue.resolved === true || !due.some(asked => asked.id === issue.id)) return issue
      const verdict = asText(item.verdict)
      const why = asText(item.why)
      const note = why !== undefined ? { why } : {}
      // A quote is kept only where the text has it: an issue is anchored to words that are there, or to none.
      const quoted = asText(item.quote)
      const anchored = quoted !== undefined ? fuzzyFind(text, quoted) : undefined
      const quote = anchored !== undefined ? { quote: text.slice(anchored.start, anchored.end) } : {}
      if (verdict === 'fixed') {
        result.fixed.push({ chapterId: review.chapterId, index: review.index, issue: issue.id, ...note })
        return { ...issue, resolved: true, checked: { at, verdict: 'fixed' as const, ...note } }
      }
      if (verdict === 'changed') {
        result.changed.push({ chapterId: review.chapterId, index: review.index, issue: issue.id })
        const { quote: _was, ...rest } = issue
        return { ...rest, ...quote, explanation: asText(item.explanation) ?? issue.explanation, checked: { at, verdict: 'changed' as const, ...note } }
      }
      // It stands; where its sentence moved, it is anchored to the sentence that stands for it now.
      const moved = issue.quote !== undefined && fuzzyFind(text, issue.quote) === undefined
      const { quote: _was, ...rest } = issue
      return { ...(moved ? rest : issue), ...(moved ? quote : {}), checked: { at, verdict: 'stands' as const, ...note } }
    }) })
  }
  if (result.looked > 0) {
    await project.addActivity({ by: 'crew', role: 'analyst', tool: 'review', summary: L(lang, `修订之后把 ${result.chapters} 章里还开着的 ${result.looked} 条审校意见重新看了一遍：${result.fixed.length} 条已随修改解决，${result.changed.length} 条按现在的正文更新`, `After the revision, looked again at ${result.looked} open issue(s) in ${result.chapters} chapter(s): ${result.fixed.length} settled by the change, ${result.changed.length} brought up to the text`) })
  }
  task.job?.result({ looked: result.looked, fixed: result.fixed.length, changed: result.changed.length })
  return result
}

/** What waits to be looked at again per book: acceptances that come one after another are answered by one look. */
const pendingRechecks = new Map<string, { timer: ReturnType<typeof setTimeout>; chapters: Set<string>; batches: Set<string>; changes: string[] }>()

/**
 * Have the open issues looked at again once a proposal was accepted — in the
 * background, a moment later, so that a batch accepted in one go is one look.
 * Nothing is asked where nothing is open.
 */
export function scheduleRecheck(core: NovelCore, runtime: ProjectRuntime, accepted: { chapterId: string; batchId?: string; change: string }, task: Pick<TaskContext, 'origin' | 'agentRoute'>): void {
  if (core.currentSettings().recheckIssues === false) return
  const root = runtime.project.root
  const waiting = pendingRechecks.get(root) ?? { timer: undefined as unknown as ReturnType<typeof setTimeout>, chapters: new Set<string>(), batches: new Set<string>(), changes: [] }
  if (waiting.timer !== undefined) clearTimeout(waiting.timer)
  waiting.chapters.add(accepted.chapterId)
  if (accepted.batchId !== undefined) waiting.batches.add(accepted.batchId)
  waiting.changes.push(accepted.change)
  waiting.timer = setTimeout(() => {
    pendingRechecks.delete(root)
    const params = { chapters: [...waiting.chapters], batches: [...waiting.batches], changes: waiting.changes.join('\n\n') }
    void (async () => {
      // Asked only where something is open that the change could have touched.
      const open = (await listReviews(runtime)).some(review => review.issues.some(issue => issue.resolved !== true && (waiting.chapters.has(review.chapterId) || (issue.mending !== undefined && waiting.batches.has(issue.mending)))))
      if (!open) return
      core.jobs.start({ kind: 'review', title: 'recheck issues', project: root, origin: task.origin }, async (job) => {
        await recheckIssues(core, runtime, params, { origin: task.origin, signal: job.signal, job, ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) })
      })
    })().catch((error: unknown) => { core.log('could not start looking again at the open issues', error) })
  }, 1500)
  waiting.timer.unref?.()
  pendingRechecks.set(root, waiting)
}

/** Keep what the author says of how an issue is to be mended; an empty note takes it off. */
export async function noteIssue(runtime: ProjectRuntime, chapterId: string, issueId: string, note: string): Promise<ChapterReview | undefined> {
  const review = await runtime.project.review(chapterId)
  if (review === undefined || !review.issues.some(issue => issue.id === issueId)) return undefined
  const said = note.trim()
  const next: ChapterReview = { ...review, issues: review.issues.map((issue) => {
    if (issue.id !== issueId) return issue
    const { note: _was, ...rest } = issue
    return said.length > 0 ? { ...rest, note: said } : rest
  }) }
  await runtime.project.saveReview(next)
  return next
}

/** Every chapter's review that there is, in reading order along the main line, then the other lines'. */
export async function listReviews(runtime: ProjectRuntime): Promise<(ChapterReview & { index: number; title: string })[]> {
  const { project } = runtime
  const seen = new Set<string>()
  const out: (ChapterReview & { index: number; title: string })[] = []
  const lines = [undefined, ...((await project.outline()).lines ?? []).map(line => line.id)]
  for (const line of lines) {
    for (const chapter of await project.chapters(line)) {
      if (seen.has(chapter.plan.id)) continue
      seen.add(chapter.plan.id)
      const review = await project.review(chapter.plan.id)
      if (review !== undefined) out.push({ ...review, index: chapter.index, title: chapter.plan.title })
    }
  }
  return out
}

/** Throw a chapter's review away: its verdict and every issue, resolved or not. */
export async function clearReview(runtime: ProjectRuntime, chapterRef: string): Promise<{ chapterId: string; removed: boolean }> {
  const chapter = await runtime.project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  return { chapterId: chapter.plan.id, removed: await runtime.project.removeReview(chapter.plan.id) }
}

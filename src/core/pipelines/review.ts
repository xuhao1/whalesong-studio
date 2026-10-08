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
import { reviewTask } from '../prompts'
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

/** Throw a chapter's review away: its verdict and every issue, resolved or not. */
export async function clearReview(runtime: ProjectRuntime, chapterRef: string): Promise<{ chapterId: string; removed: boolean }> {
  const chapter = await runtime.project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  return { chapterId: chapter.plan.id, removed: await runtime.project.removeReview(chapter.plan.id) }
}

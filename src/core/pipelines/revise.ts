// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Revision at three scales:
 *   span     rewrite a selected passage in place ("local revision"),
 *   chapter  rewrite one chapter to an instruction,
 *   book     apply one instruction across the book — triage finds the chapters
 *            it really touches, each is rewritten on its own ("global revision").
 *
 * A revision either applies at once (the old text is snapshotted first) or
 * becomes a proposal that waits for accept/reject in the review panel.
 */
import type { IssueSeverity, Proposal, ReviewIssue } from '../../shared/types'
import { clip, clipTail, countWords, fuzzyFind, newId } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asRecord, asText } from '../llm'
import { assign } from '../crew'
import type { LocatedChapter } from '../project'
import { ProjectError } from '../project'
import { architectSystem, reviseChapterSystem, reviseChapterTask, reviseSpanSystem, reviseSpanTask, triageTask } from '../prompts'
import { L, promptLanguage, renderStyle } from '../render'
import { mapLimit } from '../util/async'
import { scheduleDigest } from './digest'
import { scheduleRecheck } from './review'
import { cleanProse } from './write'

export interface ReviseSpanParams {
  chapter: string
  /** The passage to rewrite, quoted from the chapter (whitespace and quote style may drift). */
  quote?: string
  /** Character offsets of the passage, as an alternative to `quote`. */
  start?: number
  end?: number
  instruction: string
  /** Apply immediately instead of creating a proposal. */
  apply?: boolean
}

export interface ReviseChapterParams {
  chapter: string
  instruction: string
  apply?: boolean
  batchId?: string
}

export interface ReviseResult {
  chapterId: string
  title: string
  index: number
  kind: 'span' | 'chapter'
  applied: boolean
  /** Present when the change waits for review. */
  proposalId?: string
  wordsBefore: number
  wordsAfter: number
  before: string
  after: string
}

function shouldApply(core: NovelCore, task: TaskContext, explicit: boolean | undefined, fallback: boolean): boolean {
  if (explicit !== undefined) return explicit
  if (task.origin === 'agent') return !core.currentSettings().reviewAgentRevisions
  return fallback
}

async function requireChapter(runtime: ProjectRuntime, ref: string): Promise<{ chapter: LocatedChapter; text: string }> {
  const chapter = await runtime.project.findChapter(ref)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
  const text = await runtime.project.chapterText(chapter.plan.id)
  if (text.length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has no text to revise — draft it first`)
  return { chapter, text }
}

/** Find a quoted passage; with a position hint, the occurrence nearest to it wins. */
function locateQuote(text: string, quote: string, near?: number): { start: number; end: number } | undefined {
  if (near !== undefined) {
    let best: number | undefined
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
      if (best === undefined || Math.abs(at - near) < Math.abs(best - near)) best = at
    }
    if (best !== undefined) return { start: best, end: best + quote.length }
  }
  return fuzzyFind(text, quote)
}

export async function reviseSpan(core: NovelCore, runtime: ProjectRuntime, params: ReviseSpanParams, task: TaskContext): Promise<ReviseResult> {
  const { project } = runtime
  const { chapter, text } = await requireChapter(runtime, params.chapter)
  task.job?.result({ chapterId: chapter.plan.id })
  let range: { start: number; end: number } | undefined
  if (params.quote !== undefined && params.quote.trim().length > 0) {
    range = locateQuote(text, params.quote.trim(), params.start)
    if (range === undefined) throw new ProjectError('novel/not-found', 'the quoted passage was not found in the chapter — quote it exactly as it stands in the text (novel_read shows the current text)')
  } else if (params.start !== undefined && params.end !== undefined) {
    range = { start: Math.max(0, Math.min(text.length, params.start)), end: Math.max(0, Math.min(text.length, params.end)) }
  }
  if (range === undefined || range.end <= range.start) throw new ProjectError('novel/invalid', 'name the passage to revise with `quote` (or `start`/`end`)')

  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const passage = text.slice(range.start, range.end)
  const route = await core.route('writer', runtime, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'revise',
    chapter,
    brief: params.instruction,
    focus: passage,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const base = { lang, language: manifest.language, title: manifest.title }
  const response = await core.llm.complete({
    route,
    system: reviseSpanSystem({ ...base, style: renderStyle(await project.activeStyle(), lang) }),
    prompt: reviseSpanTask({
      ...base,
      context: pack.text,
      before: clipTail(text.slice(0, range.start), 1800),
      passage,
      after: clip(text.slice(range.end), 900),
      instruction: params.instruction,
    }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
  })
  let after = cleanProse(response.text).replace(/^<<<\s*/, '').replace(/\s*>>>$/, '').trim()
  if (after.length === 0) throw new ProjectError('novel/empty', 'the writer model returned an empty revision')
  // Keep the passage's own framing: a selection inside a paragraph must not gain paragraph breaks at its edges.
  const leading = /^\s*/.exec(passage)?.[0] ?? ''
  const trailing = /\s*$/.exec(passage)?.[0] ?? ''
  after = `${leading}${after}${trailing}`

  const apply = shouldApply(core, task, params.apply, false)
  const result: ReviseResult = {
    chapterId: chapter.plan.id,
    title: chapter.plan.title,
    index: chapter.index,
    kind: 'span',
    applied: apply,
    wordsBefore: countWords(passage),
    wordsAfter: countWords(after),
    before: passage,
    after,
  }
  if (apply) {
    await project.saveChapterText(chapter.plan.id, text.slice(0, range.start) + after + text.slice(range.end), { reason: 'before-revise' })
    scheduleDigest(core, runtime, chapter.plan.id, task)
  } else {
    const proposal = await project.addProposal({ chapterId: chapter.plan.id, kind: 'span', instruction: params.instruction, before: passage, after, createdBy: task.origin })
    result.proposalId = proposal.id
  }
  task.job?.result({ chapterId: chapter.plan.id, ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}) })
  return result
}

export async function reviseChapter(core: NovelCore, runtime: ProjectRuntime, params: ReviseChapterParams, task: TaskContext): Promise<ReviseResult> {
  const { project } = runtime
  const { chapter, text } = await requireChapter(runtime, params.chapter)
  task.job?.result({ chapterId: chapter.plan.id })
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('writer', runtime, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'revise',
    chapter,
    brief: params.instruction,
    includeChapterText: true,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const base = { lang, language: manifest.language, title: manifest.title }
  const words = countWords(text)
  const response = await core.llm.complete({
    route,
    system: reviseChapterSystem({ ...base, style: renderStyle(await project.activeStyle(), lang) }),
    prompt: reviseChapterTask({ ...base, context: pack.text, instruction: params.instruction }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
  })
  const after = cleanProse(response.text, chapter.plan.title)
  if (after.length === 0) throw new ProjectError('novel/empty', 'the writer model returned an empty revision')
  if (response.finish === 'max-tokens' && countWords(after) < words * 0.8) {
    throw new ProjectError('novel/truncated', 'the revision was cut off at the output limit — clear or raise "max output tokens" on the writer role in Novel Studio → Settings (a model that reasons spends its reasoning out of the same allowance), or revise the chapter in smaller passages')
  }
  const apply = shouldApply(core, task, params.apply, false)
  const result: ReviseResult = {
    chapterId: chapter.plan.id,
    title: chapter.plan.title,
    index: chapter.index,
    kind: 'chapter',
    applied: apply,
    wordsBefore: words,
    wordsAfter: countWords(after),
    before: text,
    after,
  }
  if (apply) {
    await project.saveChapterText(chapter.plan.id, after, { reason: 'before-revise', status: chapter.plan.status === 'final' ? 'final' : 'revised' })
    scheduleDigest(core, runtime, chapter.plan.id, task)
  } else {
    const proposal = await project.addProposal({
      chapterId: chapter.plan.id,
      kind: 'chapter',
      instruction: params.instruction,
      before: text,
      after,
      createdBy: task.origin,
      ...(params.batchId !== undefined ? { batchId: params.batchId } : {}),
    })
    result.proposalId = proposal.id
  }
  task.job?.result({ chapterId: chapter.plan.id, ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}) })
  return result
}

export interface ReviseBookParams {
  instruction: string
  /** Restrict to these chapters instead of letting triage choose. */
  chapters?: string[]
  /** Apply every rewrite immediately. Default: proposals for review. */
  apply?: boolean
  concurrency?: number
  /** The planner may also say what the bible should read otherwise; each such change waits as a suggestion. */
  bible?: boolean
  /** What the writer of one chapter is told, in place of the instruction with the planner's reason for that chapter appended. */
  brief?: (chapterId: string, reason: string) => string
}

export interface ReviseBookResult {
  batchId: string
  note?: string
  /** Chapters triage judged untouched by the instruction. */
  untouched: number
  /** Changes to the bible the planner proposed; they wait among the suggestions. */
  bible?: { name: string; field: string }[]
  results: (Pick<ReviseResult, 'chapterId' | 'title' | 'index' | 'applied' | 'proposalId' | 'wordsBefore' | 'wordsAfter'> & { reason: string })[]
  failed: { chapterId: string; error: string }[]
}

export async function reviseBook(core: NovelCore, runtime: ProjectRuntime, params: ReviseBookParams, task: TaskContext): Promise<ReviseBookResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const infos = (await project.chapterInfos()).filter(info => info.hasText)
  if (infos.length === 0) throw new ProjectError('novel/empty', 'no chapter has text yet')

  let targets: { id: string; reason: string }[]
  let note: string | undefined
  let bible: { name: string; field: string }[] = []
  if (params.chapters !== undefined && params.chapters.length > 0) {
    targets = []
    for (const ref of params.chapters) {
      const chapter = await project.findChapter(ref)
      if (chapter !== undefined && infos.some(info => info.id === chapter.plan.id)) targets.push({ id: chapter.plan.id, reason: params.instruction })
    }
  } else {
    task.job?.progress(0, 1, L(lang, '判断哪些章节需要修改', 'deciding which chapters change'))
    const lines: string[] = []
    for (const info of infos) {
      const memory = await project.memory(info.id)
      const text = memory?.summary ?? clip(await project.chapterText(info.id), 300)
      lines.push(`${info.index}. ${info.title}\n${text}`)
    }
    const { value } = await assign(core, runtime, task, {
      role: 'architect',
      label: L(lang, '全书修订 · 划定范围', 'Book-wide revision · scope'),
      tool: 'submit_scope',
      what: L(lang, '哪些章节要改、各自怎么改', 'which chapters change, and how each of them does'),
      system: architectSystem(lang),
      prompt: triageTask({ lang, language: manifest.language, title: manifest.title, instruction: params.instruction, chapters: lines.join('\n\n'), ...(params.bible === true ? { bible: true } : {}) }),
      temperature: 0.2,
      validate: raw => asRecord(raw),
    })
    note = asText(value.note)
    if (params.bible === true) bible = await proposeBibleEdits(runtime, asArray(value.bible), lang)
    targets = []
    for (const raw of asArray(value.chapters)) {
      const item = asRecord(raw)
      const index = Number(item.index)
      const info = infos.find(candidate => candidate.index === index)
      if (info !== undefined && !targets.some(target => target.id === info.id)) targets.push({ id: info.id, reason: asText(item.reason) ?? params.instruction })
    }
  }

  const batchId = newId('batch')
  const apply = params.apply === true
  const results: ReviseBookResult['results'] = []
  const failed: ReviseBookResult['failed'] = []
  let done = 0
  task.job?.progress(0, targets.length)
  await mapLimit(targets, params.concurrency ?? core.parallel('text'), async (target) => {
    try {
      const instruction = params.brief !== undefined ? params.brief(target.id, target.reason === params.instruction ? '' : target.reason)
        : target.reason === params.instruction ? params.instruction : `${params.instruction}\n\n${L(lang, '具体到本章', 'For this chapter specifically')}${lang === 'zh' ? '：' : ': '}${target.reason}`
      // Per-chapter streams would interleave in one job buffer, so the batch reports progress only.
      const inner: TaskContext = { origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) }
      const result = await reviseChapter(core, runtime, { chapter: target.id, instruction, apply, batchId }, inner)
      results.push({
        chapterId: result.chapterId,
        title: result.title,
        index: result.index,
        applied: result.applied,
        ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}),
        wordsBefore: result.wordsBefore,
        wordsAfter: result.wordsAfter,
        reason: target.reason,
      })
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push({ chapterId: target.id, error: error instanceof Error ? error.message : String(error) })
    }
    done += 1
    task.job?.progress(done, targets.length)
  }, task.signal)
  results.sort((left, right) => left.index - right.index)
  task.job?.result({ batchId })
  return { batchId, ...(note !== undefined ? { note } : {}), untouched: infos.length - targets.length, ...(bible.length > 0 ? { bible } : {}), results, failed }
}

const CHARACTER_FIELDS = ['tagline', 'appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice', 'age', 'gender']
const WORLD_FIELDS = ['summary', 'body']

/**
 * File what the planner says the bible should read otherwise as suggestions:
 * the bible is the author's, and a change to it is theirs to accept.
 */
async function proposeBibleEdits(runtime: ProjectRuntime, raw: unknown[], lang: 'zh' | 'en'): Promise<{ name: string; field: string }[]> {
  const { project } = runtime
  const filed: { name: string; field: string }[] = []
  const suggestions: Parameters<typeof project.addSuggestions>[0] = []
  for (const entry of raw) {
    const item = asRecord(entry)
    const kind = asText(item.kind)
    const name = asText(item.name)
    const field = asText(item.field)
    const value = asText(item.value)
    if (name === undefined || field === undefined || value === undefined) continue
    const reason = asText(item.reason)
    if (kind === 'world') {
      const found = await project.findWorld(name)
      if (found === undefined || !WORLD_FIELDS.includes(field)) continue
      suggestions.push({ kind: 'bible-edit', title: L(lang, `修改设定：${found.name} · ${field}`, `Change the bible: ${found.name} · ${field}`), detail: `${reason !== undefined ? `${reason}\n` : ''}→ ${value}`, payload: { target: 'world', id: found.id, name: found.name, field, value } })
      filed.push({ name: found.name, field })
    } else {
      const card = await project.findCharacter(name)
      if (card === undefined || !CHARACTER_FIELDS.includes(field)) continue
      suggestions.push({ kind: 'bible-edit', title: L(lang, `修改人物卡：${card.name} · ${field}`, `Change the card: ${card.name} · ${field}`), detail: `${reason !== undefined ? `${reason}\n` : ''}→ ${value}`, payload: { target: 'character', id: card.id, name: card.name, field, value } })
      filed.push({ name: card.name, field })
    }
  }
  await project.addSuggestions(suggestions)
  return filed
}

// ───────────────────────────── fixing what a review found ─────────────────────────────

export interface FixIssueParams {
  chapter: string
  /** Id of the issue in the chapter's review. */
  issue: string
  /** What the author wants done about it, in their words. */
  note?: string
  /**
   * `passage`: the place the issue quotes (the whole chapter where it quotes none).
   * `book`: wherever the problem reaches — the planner traces it through the chapters and the bible.
   */
  scope: 'passage' | 'book'
}

export interface FixIssueResult {
  scope: 'passage' | 'chapter' | 'book'
  passage?: ReviseResult
  book?: ReviseBookResult
}

const ISSUE_TYPE_ZH: Record<string, string> = { continuity: '连贯', character: '人物', world: '世界观', timeline: '时间线', style: '文风', pacing: '节奏', logic: '逻辑', language: '语言' }
const SEVERITY_ZH: Record<string, string> = { high: '严重', medium: '中等', low: '轻微', critical: '严重', major: '重要', minor: '轻微' }

/** What a review found, as an instruction to whoever mends it. */
export function issueInstruction(lang: 'zh' | 'en', chapter: { index: number; title: string }, issue: { type: string; severity: string; quote?: string; explanation: string; suggestion?: string }, note: string | undefined, wide: boolean): string {
  const said = note !== undefined && note.trim().length > 0 ? note.trim() : undefined
  return lang === 'zh'
    ? [
        `审校在第 ${chapter.index} 章《${chapter.title}》发现一个问题（${ISSUE_TYPE_ZH[issue.type] ?? issue.type}，${SEVERITY_ZH[issue.severity] ?? issue.severity}）：${issue.explanation}`,
        issue.quote !== undefined ? `原文："${issue.quote}"` : undefined,
        issue.suggestion !== undefined ? `审校的建议：${issue.suggestion}` : undefined,
        said !== undefined ? `作者对怎么改的要求（以此为准）：${said}` : undefined,
        wide ? `请把这个问题在全书里的影响查清楚：除了第 ${chapter.index} 章本身，还有哪些章节写到了与它相关的事实、因果或人物表现，需要一起改才能前后一致；与此无关的内容保持原样。` : '修正这个问题，别的不要动。',
      ].filter(Boolean).join('\n')
    : [
        `A review found a problem in chapter ${chapter.index}, "${chapter.title}" (${issue.type}, ${issue.severity}): ${issue.explanation}`,
        issue.quote !== undefined ? `The text: "${issue.quote}"` : undefined,
        issue.suggestion !== undefined ? `The review suggests: ${issue.suggestion}` : undefined,
        said !== undefined ? `What the author wants done about it (this decides): ${said}` : undefined,
        wide ? `Trace this problem through the whole book: besides chapter ${chapter.index} itself, which chapters state facts, causes or behaviour that depend on it and have to change with it for the book to agree with itself; leave everything else as it is.` : 'Mend this problem and change nothing else.',
      ].filter(Boolean).join('\n')
}

/**
 * Mend what a review found: where it was found, or wherever it reaches.
 * Every change comes back as a proposal (and, for the bible, a suggestion).
 */
export async function fixIssue(core: NovelCore, runtime: ProjectRuntime, params: FixIssueParams, task: TaskContext): Promise<FixIssueResult> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const review = await project.review(chapter.plan.id)
  const issue = review?.issues.find(candidate => candidate.id === params.issue)
  if (issue === undefined) throw new ProjectError('novel/not-found', `chapter ${chapter.index} has no review issue "${params.issue}" — run the review again, or pass the instruction itself to a revision`)
  const lang = promptLanguage((await project.manifest()).language)
  const where = { index: chapter.index, title: chapter.plan.title }
  if (params.scope === 'book') {
    const book = await reviseBook(core, runtime, { instruction: issueInstruction(lang, where, issue, params.note, true), bible: true }, task)
    return { scope: 'book', book }
  }
  const instruction = issueInstruction(lang, where, issue, params.note, false)
  const text = await project.chapterText(chapter.plan.id)
  const range = issue.quote !== undefined ? fuzzyFind(text, issue.quote.trim()) : undefined
  // A problem that quotes nothing — pacing, a missing beat — or whose quote has since been rewritten is the chapter's.
  if (range === undefined) return { scope: 'chapter', passage: await reviseChapter(core, runtime, { chapter: chapter.plan.id, instruction }, task) }
  return { scope: 'passage', passage: await reviseSpan(core, runtime, { chapter: chapter.plan.id, start: range.start, end: range.end, quote: text.slice(range.start, range.end), instruction }, task) }
}

export interface FixIssuesParams {
  /** The issues to mend together, each named where its review found it; `note`: what the author says of that one (else the note kept on it). */
  issues?: { chapter: string; issue: string; note?: string }[]
  /** Instead of naming them: every open issue this grave or graver — `high`; `medium`: high and medium; `low`: all of them. */
  atLeast?: IssueSeverity
  /** With `atLeast`: only in these chapters. */
  chapters?: string[]
  /** What the author says of the whole batch. */
  note?: string
}

export interface FixIssuesResult {
  /** How many issues were handed over, in how many chapters. */
  issues: number
  chapters: number
  book?: ReviseBookResult
}

const GRAVITY: Record<string, number> = { high: 3, critical: 3, medium: 2, major: 2, low: 1, minor: 1 }

/**
 * Mend several things a review found in one go — also across chapters. One
 * planner reads them all side by side, with what the author said of each,
 * and settles which chapters change and how; each chapter is then rewritten
 * once, for everything that concerns it. That is what keeps the mending of a
 * fact, or of how somebody behaves, the same from chapter to chapter — which
 * mending issue by issue does not. Every change waits as a proposal, a
 * change to the bible as a suggestion.
 */
export async function fixIssues(core: NovelCore, runtime: ProjectRuntime, params: FixIssuesParams, task: TaskContext): Promise<FixIssuesResult> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  type Found = { chapter: { id: string; index: number; title: string }; issue: ReviewIssue; note?: string }
  const found: Found[] = []
  if (params.issues !== undefined && params.issues.length > 0) {
    for (const asked of params.issues) {
      const chapter = await project.findChapter(asked.chapter)
      if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${asked.chapter}"`)
      const issue = (await project.review(chapter.plan.id))?.issues.find(candidate => candidate.id === asked.issue)
      if (issue === undefined) throw new ProjectError('novel/not-found', `chapter ${chapter.index} has no review issue "${asked.issue}" — run the review again`)
      const note = asked.note?.trim() || issue.note
      found.push({ chapter: { id: chapter.plan.id, index: chapter.index, title: chapter.plan.title }, issue, ...(note !== undefined && note.length > 0 ? { note } : {}) })
    }
  } else {
    const floor = GRAVITY[params.atLeast ?? 'high'] ?? 3
    const only = params.chapters !== undefined && params.chapters.length > 0 ? new Set((await Promise.all(params.chapters.map(ref => project.findChapter(ref)))).map(chapter => chapter?.plan.id)) : undefined
    for (const chapter of await project.chapters()) {
      if (only !== undefined && !only.has(chapter.plan.id)) continue
      for (const issue of (await project.review(chapter.plan.id))?.issues ?? []) {
        if (issue.resolved === true || (GRAVITY[issue.severity] ?? 1) < floor) continue
        found.push({ chapter: { id: chapter.plan.id, index: chapter.index, title: chapter.plan.title }, issue, ...(issue.note !== undefined ? { note: issue.note } : {}) })
      }
    }
  }
  if (found.length === 0) return { issues: 0, chapters: 0 }
  found.sort((left, right) => left.chapter.index - right.chapter.index)
  const said = params.note?.trim() ?? ''
  /** One issue, as whoever mends it reads it. */
  const told = (item: Found, at: number): string => lang === 'zh'
    ? [
        `${at + 1}. （${ISSUE_TYPE_ZH[item.issue.type] ?? item.issue.type}，${SEVERITY_ZH[item.issue.severity] ?? item.issue.severity}）${item.issue.explanation}`,
        item.issue.quote !== undefined ? `   原文："${item.issue.quote}"` : undefined,
        item.issue.suggestion !== undefined ? `   审校的建议：${item.issue.suggestion}` : undefined,
        item.note !== undefined ? `   作者对怎么改的要求（以此为准）：${item.note}` : undefined,
      ].filter(Boolean).join('\n')
    : [
        `${at + 1}. (${item.issue.type}, ${item.issue.severity}) ${item.issue.explanation}`,
        item.issue.quote !== undefined ? `   The text: "${item.issue.quote}"` : undefined,
        item.issue.suggestion !== undefined ? `   The review suggests: ${item.issue.suggestion}` : undefined,
        item.note !== undefined ? `   What the author wants done about it (this decides): ${item.note}` : undefined,
      ].filter(Boolean).join('\n')
  const byChapter = new Map<string, Found[]>()
  for (const item of found) byChapter.set(item.chapter.id, [...(byChapter.get(item.chapter.id) ?? []), item])
  const head = (chapter: Found['chapter']): string => L(lang, `### 第 ${chapter.index} 章《${chapter.title}》`, `### Chapter ${chapter.index}, "${chapter.title}"`)
  const all = [...byChapter.values()].map(items => `${head(items[0]!.chapter)}\n${items.map(told).join('\n')}`).join('\n\n')
  const instruction = L(lang,
    `审校在这本书里发现了下面 ${found.length} 个问题，作者要把它们一起修掉：\n\n${all}\n${said.length > 0 ? `\n作者对这一批的总要求（以此为准）：${said}\n` : ''}\n请把它们放在一起看：同一章的几个问题在一次修改里改完；彼此有牵连的（同一个事实、同一条因果、同一个人物的表现）前后改成一致，不要这一章改成这样、那一章改成那样。除了上面点到的章节，还有哪些章节写到了与它们相关的事实、因果或人物表现，需要一起改才能前后一致；与此无关的内容保持原样。`,
    `A review found the ${found.length} problems below in this book, and the author wants them mended together:\n\n${all}\n${said.length > 0 ? `\nWhat the author says of the whole batch (this decides): ${said}\n` : ''}\nRead them side by side: the problems of one chapter are mended in one rewrite of it; those that hang together (one fact, one chain of cause, how one person behaves) are mended the same way from chapter to chapter. Besides the chapters named above, which chapters state facts, causes or behaviour that depend on them and have to change with them for the book to agree with itself; leave everything else as it is.`)
  const oneLine = found.map(item => L(lang, `第 ${item.chapter.index} 章：${clip(item.issue.explanation, 60)}`, `Chapter ${item.chapter.index}: ${clip(item.issue.explanation, 80)}`)).join('\n')
  const book = await reviseBook(core, runtime, {
    instruction,
    bible: true,
    // The writer of one chapter mends what is that chapter's — in full — and knows what else is being mended, to agree with it.
    brief: (chapterId, reason) => {
      const mine = byChapter.get(chapterId)
      return [
        mine !== undefined
          ? L(lang, `审校在这一章发现了下面的问题，这一次一起改掉：\n${mine.map(told).join('\n')}`, `A review found the problems below in this chapter; mend them all in this rewrite:\n${mine.map(told).join('\n')}`)
          : L(lang, '这一章本身没有被点名的问题：它写到了别的章节正在修的事，要跟着改才能前后一致。', 'No problem was named in this chapter itself: it tells of things being mended in other chapters, and has to change with them for the book to agree with itself.'),
        said.length > 0 ? L(lang, `作者对这一批的总要求（以此为准）：${said}`, `What the author says of the whole batch (this decides): ${said}`) : '',
        reason.length > 0 ? L(lang, `策划对这一章的安排：${reason}`, `What the planner settled for this chapter: ${reason}`) : '',
        found.length > (mine?.length ?? 0) ? L(lang, `这一批同时在修的问题（别的章节的不在这一章里改；写到相关的事时与它们的改法保持一致）：\n${oneLine}`, `What is being mended in the same batch (other chapters' problems are not mended here; where this chapter touches them, agree with how they are mended):\n${oneLine}`) : '',
        L(lang, '只改为解决这些问题必须改的地方，别的不要动。', 'Change only what mending these takes; leave the rest as it is.'),
      ].filter(part => part.length > 0).join('\n\n')
    },
  }, task)
  // Each issue handed over says so, until its proposals are settled and the author marks it.
  for (const [chapterId, items] of byChapter) {
    const review = await project.review(chapterId)
    if (review === undefined) continue
    const ids = new Set(items.map(item => item.issue.id))
    await project.saveReview({ ...review, issues: review.issues.map(issue => ids.has(issue.id) ? { ...issue, mending: book.batchId } : issue) })
  }
  return { issues: found.length, chapters: byChapter.size, book }
}

/** Apply a pending proposal to the manuscript. */
export async function acceptProposal(core: NovelCore, runtime: ProjectRuntime, id: string, task: Pick<TaskContext, 'origin' | 'agentRoute'>): Promise<Proposal> {
  const { project } = runtime
  const proposal = (await project.proposals()).find(item => item.id === id)
  if (proposal === undefined) throw new ProjectError('novel/not-found', `no proposal "${id}"`)
  if (proposal.status !== 'pending') throw new ProjectError('novel/invalid', `proposal "${id}" is already ${proposal.status}`)
  const text = await project.chapterText(proposal.chapterId)
  let next: string
  if (proposal.kind === 'chapter') {
    next = proposal.after
  } else {
    const range = fuzzyFind(text, proposal.before)
    if (range === undefined) {
      throw new ProjectError('novel/stale-proposal', 'the passage this proposal replaces is no longer in the chapter — it was edited since; reject the proposal and revise again')
    }
    next = text.slice(0, range.start) + proposal.after + text.slice(range.end)
  }
  await project.saveChapterText(proposal.chapterId, next, { reason: 'before-revise' })
  const updated = (await project.setProposalStatus(id, 'accepted'))!
  scheduleDigest(core, runtime, proposal.chapterId, task)
  // What else the change settled, or moved: the issues still open there are looked at again.
  const where = await project.findChapter(proposal.chapterId)
  const lang = promptLanguage((await project.manifest()).language)
  scheduleRecheck(core, runtime, {
    chapterId: proposal.chapterId,
    ...(proposal.batchId !== undefined ? { batchId: proposal.batchId } : {}),
    change: L(lang,
      `第 ${where?.index ?? '?'} 章${proposal.kind === 'span' ? `改了一处：\n原文：${clip(proposal.before, 400)}\n改成：${clip(proposal.after, 400)}` : '整章重写过'}\n为的是：${clip(proposal.instruction, 600)}`,
      `Chapter ${where?.index ?? '?'}${proposal.kind === 'span' ? ` — one passage changed:\nwas: ${clip(proposal.before, 500)}\nnow: ${clip(proposal.after, 500)}` : ' was rewritten whole'}\nfor: ${clip(proposal.instruction, 800)}`),
  }, task)
  return updated
}

export async function rejectProposal(runtime: ProjectRuntime, id: string): Promise<Proposal | undefined> {
  return await runtime.project.setProposalStatus(id, 'rejected')
}

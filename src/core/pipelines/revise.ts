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
import type { Proposal } from '../../shared/types'
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
      const instruction = target.reason === params.instruction ? params.instruction : `${params.instruction}\n\n${L(lang, '具体到本章', 'For this chapter specifically')}${lang === 'zh' ? '：' : ': '}${target.reason}`
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
  return updated
}

export async function rejectProposal(runtime: ProjectRuntime, id: string): Promise<Proposal | undefined> {
  return await runtime.project.setProposalStatus(id, 'rejected')
}

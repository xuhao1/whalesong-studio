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
import { asArray, asRecord, asText, completeJson } from '../llm'
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
}

export interface ReviseBookResult {
  batchId: string
  note?: string
  /** Chapters triage judged untouched by the instruction. */
  untouched: number
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
    const route = await core.route('architect', runtime, task)
    const { value } = await completeJson(core.llm, {
      route,
      system: architectSystem(lang),
      prompt: triageTask({ lang, language: manifest.language, title: manifest.title, instruction: params.instruction, chapters: lines.join('\n\n') }),
      temperature: 0.2,
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      validate: raw => asRecord(raw),
    })
    note = asText(value.note)
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
  await mapLimit(targets, params.concurrency ?? 2, async (target) => {
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
  return { batchId, ...(note !== undefined ? { note } : {}), untouched: infos.length - targets.length, results, failed }
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

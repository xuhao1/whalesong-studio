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
import { MAIN_LINE, type IssueSeverity, type Proposal, type ReviewIssue } from '../../shared/types'
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
  /** The review issues this mends: the proposal says so. */
  issues?: string[]
  /** Go on from the changes that still wait for this chapter; see `ReviseChapterParams.onto`. */
  onto?: boolean
}

export interface ReviseChapterParams {
  chapter: string
  instruction: string
  apply?: boolean
  batchId?: string
  /** The review issues this mends: the proposal says so. */
  issues?: string[]
  /**
   * Go on from the changes that still wait for this chapter: the writer reads the chapter as it would stand with them
   * accepted, and the proposal made stands for them too — one change to look at and accept, in place of the ones it
   * took in. How a mending that follows another keeps to what the first one settled.
   */
  onto?: boolean
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

/**
 * The chapter as it would read with what waits for it accepted, oldest first: a whole-chapter change where nothing was
 * taken in before it, a passage where it is still found. What could not be taken in is left waiting by itself.
 */
async function onPending(runtime: ProjectRuntime, chapterId: string, text: string): Promise<{ text: string; used: Proposal[] }> {
  const waiting = (await runtime.project.proposals()).filter(proposal => proposal.status === 'pending' && proposal.chapterId === chapterId).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  let out = text
  const used: Proposal[] = []
  for (const proposal of waiting) {
    if (proposal.kind === 'chapter') {
      if (out !== text || proposal.before !== text) continue
      out = proposal.after
    } else {
      const range = fuzzyFind(out, proposal.before)
      if (range === undefined) continue
      out = out.slice(0, range.start) + proposal.after + out.slice(range.end)
    }
    used.push(proposal)
  }
  return { text: out, used }
}

/**
 * What a proposal made on top of others carries of them — the issues and batches they were for, and whom it stands
 * for now — read once the rewrite is back: the author may have settled one of them while the writer worked.
 * @returns `carried`: the fields for the new proposal; `settle`: the proposals it takes the place of.
 */
async function takenIn(runtime: ProjectRuntime, used: readonly Proposal[], issues: readonly string[] | undefined, lang: 'zh' | 'en'): Promise<{ carried: Partial<Proposal>; settle: Proposal[] }> {
  if (used.length === 0) return { carried: issues !== undefined && issues.length > 0 ? { issues: [...issues] } : {}, settle: [] }
  const now = new Map((await runtime.project.proposals()).map(proposal => [proposal.id, proposal.status]))
  const settle = used.filter(proposal => now.get(proposal.id) === 'pending')
  const dropped = used.filter(proposal => now.get(proposal.id) === 'rejected').length
  const all = [...new Set([...used.flatMap(proposal => proposal.issues ?? []), ...(issues ?? [])])]
  const batches = [...new Set(used.flatMap(proposal => [...(proposal.batchId !== undefined ? [proposal.batchId] : []), ...(proposal.batches ?? [])]))]
  const says = [
    ...(settle.length > 0 ? [L(lang, `接着还没采纳的 ${settle.length} 处修改改的：采纳这一条就包含它们；放弃它，那 ${settle.length} 处回来单独等你确认。`, `Made on top of ${settle.length} change(s) that were still waiting: accepting this one accepts them; turned down, they come back to wait by themselves.`)] : []),
    // (Nothing is taken back behind the author: what they turned down meanwhile is named, and this proposal is theirs to turn down too.)
    ...(dropped > 0 ? [L(lang, `写的时候它依据的修改里有 ${dropped} 处被你放弃了，这一条里仍然带着——不要的话放弃这一条，重新修。`, `${dropped} of the change(s) it was written on top of were turned down meanwhile and are still in it — turn this one down and mend again if they are not wanted.`)] : []),
  ]
  return {
    carried: {
      ...(all.length > 0 ? { issues: all } : {}),
      ...(settle.length > 0 ? { supersedes: [...settle.flatMap(proposal => proposal.supersedes ?? []), ...settle.map(proposal => proposal.id)] } : {}),
      ...(batches.length > 0 ? { batches } : {}),
      ...(says.length > 0 ? { rationale: says.join(lang === 'zh' ? '' : ' ') } : {}),
    },
    settle,
  }
}

/** The proposals a later one took in are settled by it: they wait no longer by themselves. */
async function settleTakenIn(runtime: ProjectRuntime, used: readonly Proposal[], by: string): Promise<void> {
  for (const proposal of used) await runtime.project.supersedeProposal(proposal.id, by)
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
  const found = await requireChapter(runtime, params.chapter)
  const { chapter } = found
  const apply = shouldApply(core, task, params.apply, false)
  // Going on from what waits: the passage is looked for, and rewritten, in the chapter as it would stand with that in.
  // (Not where the change is applied outright: that is made to the text as it stands, and accepts nothing for the author.)
  const based = params.onto === true && !apply ? await onPending(runtime, chapter.plan.id, found.text) : { text: found.text, used: [] as Proposal[] }
  const text = based.text
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
  } else if (based.used.length === 0 || (based.used.every(proposal => proposal.kind === 'span') && found.text.includes(passage))) {
    // A change of its own — also when it was written knowing the ones that wait: the passage is as the book has it,
    // and none of them rewrites the chapter, so each is accepted or turned down by itself.
    const proposal = await project.addProposal({ chapterId: chapter.plan.id, kind: 'span', instruction: params.instruction, before: passage, after, createdBy: task.origin, ...(params.issues !== undefined && params.issues.length > 0 ? { issues: params.issues } : {}) })
    result.proposalId = proposal.id
  } else {
    // The passage is one a waiting change made, or stands in a chapter rewritten whole: one proposal for the chapter
    // with all of them and this one in.
    const taken = await takenIn(runtime, based.used, params.issues, lang)
    const proposal = await project.addProposal({ chapterId: chapter.plan.id, kind: 'chapter', instruction: params.instruction, before: found.text, after: text.slice(0, range.start) + after + text.slice(range.end), createdBy: task.origin, ...taken.carried })
    await settleTakenIn(runtime, taken.settle, proposal.id)
    result.proposalId = proposal.id
  }
  task.job?.result({ chapterId: chapter.plan.id, ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}) })
  return result
}

export async function reviseChapter(core: NovelCore, runtime: ProjectRuntime, params: ReviseChapterParams, task: TaskContext): Promise<ReviseResult> {
  const { project } = runtime
  const { chapter, text } = await requireChapter(runtime, params.chapter)
  const apply = shouldApply(core, task, params.apply, false)
  // (Applied outright, the rewrite is of the text as it stands: nothing that waits is accepted on the author's behalf.)
  const based = params.onto === true && !apply ? await onPending(runtime, chapter.plan.id, text) : { text, used: [] as Proposal[] }
  task.job?.result({ chapterId: chapter.plan.id })
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('writer', runtime, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'revise',
    chapter,
    brief: params.instruction,
    includeChapterText: true,
    ...(based.used.length > 0 ? { chapterText: based.text } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const base = { lang, language: manifest.language, title: manifest.title }
  const words = countWords(based.text)
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
    const taken = await takenIn(runtime, based.used, params.issues, lang)
    const proposal = await project.addProposal({
      chapterId: chapter.plan.id,
      kind: 'chapter',
      instruction: params.instruction,
      before: text,
      after,
      createdBy: task.origin,
      ...(params.batchId !== undefined ? { batchId: params.batchId } : {}),
      ...taken.carried,
    })
    await settleTakenIn(runtime, taken.settle, proposal.id)
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
  /** The review issues a chapter's rewrite mends, for its proposal to say so. */
  issuesOf?: (chapterId: string) => string[]
  /** The line of the plot the revision is of, by id, when it is not the main one: its chapters are the ones looked at, numbered along it. */
  line?: string
  /** Go on from the changes that still wait: every chapter is rewritten as `ReviseChapterParams.onto` says, and the planner is told which chapters have some. */
  onto?: boolean
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
  // One line of the plot at a time: its chapters as they are read on it, numbered along it.
  const along = params.line !== undefined && params.line !== MAIN_LINE ? params.line : undefined
  const infos = (await project.chapterInfos(along)).filter(info => info.hasText)
  if (infos.length === 0) throw new ProjectError('novel/empty', 'no chapter has text yet')

  let targets: { id: string; reason: string }[]
  let note: string | undefined
  let bible: { name: string; field: string }[] = []
  if (params.chapters !== undefined && params.chapters.length > 0) {
    targets = []
    for (const ref of params.chapters) {
      const chapter = await project.findChapter(ref, along)
      if (chapter !== undefined && infos.some(info => info.id === chapter.plan.id)) targets.push({ id: chapter.plan.id, reason: params.instruction })
    }
  } else {
    task.job?.progress(0, 1, L(lang, '判断哪些章节需要修改', 'deciding which chapters change'))
    const lines: string[] = []
    // Going on from what waits: the planner is told which chapters have a change waiting, and what it was for.
    const waiting = params.onto === true ? (await project.proposals()).filter(proposal => proposal.status === 'pending') : []
    for (const info of infos) {
      const memory = await project.memory(info.id)
      const text = memory?.summary ?? clip(await project.chapterText(info.id), 300)
      const pending = waiting.filter(proposal => proposal.chapterId === info.id)
      lines.push(`${info.index}. ${info.title}\n${text}${pending.length > 0 ? `\n${L(lang, `（这一章已有 ${pending.length} 处还没采纳的修改，这次会接着它们改：${clip(pending.map(proposal => proposal.instruction.replace(/\s+/g, ' ')).join('；'), 240)}）`, `(${pending.length} change(s) to this chapter still wait, and this revision goes on from them: ${clip(pending.map(proposal => proposal.instruction.replace(/\s+/g, ' ')).join('; '), 300)})`)}` : ''}`)
    }
    const { value } = await assign(core, runtime, task, {
      role: 'architect',
      label: L(lang, '全书修订 · 划定范围', 'Book-wide revision · scope'),
      line: along ?? MAIN_LINE,
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
      const result = await reviseChapter(core, runtime, { chapter: target.id, instruction, apply, batchId, ...(params.onto === true ? { onto: true } : {}), ...(params.issuesOf !== undefined ? { issues: params.issuesOf(target.id) } : {}) }, inner)
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
  /** Go on from the changes that still wait (`ReviseChapterParams.onto`): a mending that follows others. */
  onto?: boolean
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
    const book = await reviseBook(core, runtime, { instruction: issueInstruction(lang, where, issue, params.note, true), bible: true, ...(chapter.line !== undefined ? { line: chapter.line } : {}), ...(params.onto === true ? { onto: true } : {}), issuesOf: chapterId => (chapterId === chapter.plan.id ? [issue.id] : []) }, task)
    // Handed over: the issue says with which batch of proposals, and they are shown beneath it.
    const current = await project.review(chapter.plan.id)
    if (current !== undefined) await project.saveReview({ ...current, issues: current.issues.map(item => item.id === issue.id ? { ...item, mending: book.batchId } : item) })
    return { scope: 'book', book }
  }
  const instruction = issueInstruction(lang, where, issue, params.note, false)
  const onto = params.onto === true ? { onto: true } : {}
  // (Going on from what waits, the quote is looked for in the chapter as it would stand with that in.)
  const text = params.onto === true ? (await onPending(runtime, chapter.plan.id, await project.chapterText(chapter.plan.id))).text : await project.chapterText(chapter.plan.id)
  const range = issue.quote !== undefined ? fuzzyFind(text, issue.quote.trim()) : undefined
  // A problem that quotes nothing — pacing, a missing beat — or whose quote has since been rewritten is the chapter's.
  if (range === undefined) return { scope: 'chapter', passage: await reviseChapter(core, runtime, { chapter: chapter.plan.id, instruction, issues: [issue.id], ...onto }, task) }
  return { scope: 'passage', passage: await reviseSpan(core, runtime, { chapter: chapter.plan.id, start: range.start, end: range.end, quote: text.slice(range.start, range.end), instruction, issues: [issue.id], ...onto }, task) }
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
  /** Go on from the changes that still wait (`ReviseChapterParams.onto`): a batch that follows others. */
  onto?: boolean
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
  // Each chapter by its place on the line it belongs to: a book may hold several lines, and each counts its own.
  const everywhere = [...await project.chapters()]
  for (const line of await project.lines()) for (const chapter of await project.chapters(line.id)) if (chapter.line === line.id) everywhere.push(chapter)
  const placeOf = new Map(everywhere.map(chapter => [chapter.plan.id, chapter]))
  const all: Found[] = []
  if (params.issues !== undefined && params.issues.length > 0) {
    for (const asked of params.issues) {
      const named = await project.findChapter(asked.chapter)
      const chapter = named !== undefined ? placeOf.get(named.plan.id) : undefined
      if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${asked.chapter}"`)
      const issue = (await project.review(chapter.plan.id))?.issues.find(candidate => candidate.id === asked.issue)
      if (issue === undefined) throw new ProjectError('novel/not-found', `chapter ${chapter.index} has no review issue "${asked.issue}" — run the review again`)
      const note = asked.note?.trim() || issue.note
      all.push({ chapter: { id: chapter.plan.id, index: chapter.index, title: chapter.plan.title }, line: chapter.line ?? MAIN_LINE, issue, ...(note !== undefined && note.length > 0 ? { note } : {}) })
    }
  } else {
    const floor = GRAVITY[params.atLeast ?? 'high'] ?? 3
    const only = params.chapters !== undefined && params.chapters.length > 0 ? new Set((await Promise.all(params.chapters.map(ref => project.findChapter(ref)))).map(chapter => chapter?.plan.id)) : undefined
    for (const chapter of everywhere) {
      if (only !== undefined && !only.has(chapter.plan.id)) continue
      for (const issue of (await project.review(chapter.plan.id))?.issues ?? []) {
        if (issue.resolved === true || (GRAVITY[issue.severity] ?? 1) < floor) continue
        all.push({ chapter: { id: chapter.plan.id, index: chapter.index, title: chapter.plan.title }, line: chapter.line ?? MAIN_LINE, issue, ...(issue.note !== undefined ? { note: issue.note } : {}) })
      }
    }
  }
  if (all.length === 0) return { issues: 0, chapters: 0 }
  // A line of the plot is a story of its own: what was found on one is mended on that one, by a planner that reads it
  // alone. A batch that reaches over several lines is as many pieces of work.
  const lines = [...new Set(all.map(item => item.line))]
  let last: FixIssuesResult | undefined
  let chapters = 0
  for (const line of lines) {
    task.signal?.throwIfAborted()
    last = await fixOnLine(core, runtime, params, all.filter(item => item.line === line), line, task)
    chapters += last.chapters
  }
  return { issues: all.length, chapters, ...(last?.book !== undefined ? { book: last.book } : {}) }
}

type Found = { chapter: { id: string; index: number; title: string }; line: string; issue: ReviewIssue; note?: string }

/** The issues of one line of the plot, mended together. */
async function fixOnLine(core: NovelCore, runtime: ProjectRuntime, params: FixIssuesParams, found: Found[], line: string, task: TaskContext): Promise<FixIssuesResult> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
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
    ...(line !== MAIN_LINE ? { line } : {}),
    ...(params.onto === true ? { onto: true } : {}),
    issuesOf: chapterId => (byChapter.get(chapterId) ?? []).map(item => item.issue.id),
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

const mendings = new Map<string, Set<Promise<void>>>()

/**
 * Run a piece of mending in its turn. Mendings of a book need not wait for each other — two that have nothing to do
 * with one another, on different lines of the plot or far apart in the story, are quicker side by side. One that is
 * to keep to what the others settle waits for every mending of the book asked for before it, and then goes on from
 * what they left waiting (`onto`).
 * @param order - `queue`: after the mendings already asked for, on top of their changes. `apart`: at once, on the text as it stands.
 * @param run - the work; told whether it goes on from what waits.
 */
export async function mendInTurn<T>(runtime: ProjectRuntime, order: 'queue' | 'apart', task: TaskContext, run: (onto: boolean) => Promise<T>): Promise<T> {
  const root = runtime.project.root
  const asked = mendings.get(root) ?? new Set<Promise<void>>()
  mendings.set(root, asked)
  const before = [...asked]
  let done!: () => void
  const mine = new Promise<void>((resolve) => { done = resolve })
  asked.add(mine)
  try {
    if (order === 'queue' && before.length > 0) {
      const lang = promptLanguage((await runtime.project.manifest()).language)
      const restore = task.job?.note(L(lang, `排队中：前面还有 ${before.length} 个修复任务，做完接着它们改`, `In line: ${before.length} mending(s) before this one; it goes on from them`))
      try {
        await new Promise<void>((resolve, reject) => {
          const stop = (): void => { reject(task.signal?.reason instanceof Error ? task.signal.reason : new Error('aborted')) }
          if (task.signal?.aborted === true) { stop(); return }
          task.signal?.addEventListener('abort', stop, { once: true })
          void Promise.all(before).then(() => { task.signal?.removeEventListener('abort', stop); resolve() })
        })
      } finally {
        restore?.()
      }
    }
    return await run(order === 'queue')
  } finally {
    done()
    asked.delete(mine)
    if (asked.size === 0) mendings.delete(root)
  }
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
    ...(proposal.batches !== undefined ? { batches: proposal.batches } : {}),
    change: L(lang,
      `第 ${where?.index ?? '?'} 章${proposal.kind === 'span' ? `改了一处：\n原文：${clip(proposal.before, 400)}\n改成：${clip(proposal.after, 400)}` : '整章重写过'}\n为的是：${clip(proposal.instruction, 600)}`,
      `Chapter ${where?.index ?? '?'}${proposal.kind === 'span' ? ` — one passage changed:\nwas: ${clip(proposal.before, 500)}\nnow: ${clip(proposal.after, 500)}` : ' was rewritten whole'}\nfor: ${clip(proposal.instruction, 800)}`),
  }, task)
  return updated
}

/**
 * Turn a pending proposal down. One made on top of others stood for them: turned down, they wait by themselves again —
 * what the author said no to is the last mending, not the ones before it.
 */
export async function rejectProposal(runtime: ProjectRuntime, id: string): Promise<Proposal | undefined> {
  const rejected = await runtime.project.setProposalStatus(id, 'rejected')
  if (rejected?.supersedes !== undefined && rejected.supersedes.length > 0) await runtime.project.restoreSuperseded(id)
  return rejected
}

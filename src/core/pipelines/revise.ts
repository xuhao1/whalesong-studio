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
import { keptPictures } from '../../shared/embedded'
import { MAIN_LINE, type ChapterReview, type FiguresKept, type IssueSeverity, type IssueType, type PictureGuide, type PicturesRead, type Proposal, type ReviewIssue, type SettledProposal } from '../../shared/types'
import { changedCore, clip, clipTail, countWords, fuzzyFind, hashText, newId, occurrences } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asRecord, asText } from '../llm'
import { assign, crewPlan } from '../crew'
import type { LocatedChapter } from '../project'
import { ProjectError } from '../project'
import { architectSystem, mendTask, reviseChapterSystem, reviseChapterTask, reviseSpanSystem, reviseSpanTask } from '../prompts'
import { L, promptLanguage, renderStyle } from '../render'
import { mapLimit } from '../util/async'
import { scheduleDigest } from './digest'
import { schedulePlanFollow } from './follow'
import { scheduleRecheck } from './review'
import { cleanProse } from './write'
import { guidePictures, picturesRead } from './guides'

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
  /** Pictures to rewrite the passage by: given for this rewrite, and for no other (the chapter's own are for writing the chapter). */
  guides?: PictureGuide[]
  /** The mending it is one place of: its proposal is grouped with the others of it. */
  batchId?: string
  /**
   * Hold the change to what changed: the sentences the writer handed back as they stood, at either end of the
   * passage, are left out of the proposal — it replaces the smallest stretch of whole sentences that is no longer
   * what it was (and that is found once in the chapter). How a place somebody else chose is mended; a passage the
   * author selected is theirs, and stays as selected.
   */
  tight?: boolean
  /**
   * What the passage is to read, written by whoever settled the place: nobody is asked to rewrite it, and this is
   * what is proposed (an empty text: the passage goes). How the crew's model mends a place itself (`mendBy`).
   */
  written?: string
  /** Why it changes so, for the proposal to say (beside `written`). */
  why?: string
  /**
   * Whose model rewrites the passage where nothing is `written`. Left out: as the settings say of a passage the
   * author picks (`rewriteBy`); a mending says which itself (`mendBy`).
   */
  by?: 'writer' | 'planner'
}

/**
 * Whether the words of a change made by places are the planner's own — asked for outright, else as the settings say
 * (`mendBy`: the planner's unless the author set the writer's).
 */
export function mendsDirect(core: NovelCore, explicit?: boolean): boolean {
  return explicit ?? core.currentSettings().mendBy !== 'writer'
}

/**
 * Whose model rewrites a passage the author selected, or a chapter written over whole — said outright, else as the
 * settings say (`rewriteBy`: the writer's unless the author set the planner's).
 */
export function rewritesBy(core: NovelCore, explicit?: 'writer' | 'planner'): 'writer' | 'planner' {
  return explicit ?? (core.currentSettings().rewriteBy === 'planner' ? 'planner' : 'writer')
}

export interface ReviseChapterParams {
  chapter: string
  instruction: string
  apply?: boolean
  batchId?: string
  /** Pictures to rewrite the chapter by. Left out: the ones kept on its plan, as when it is written. */
  guides?: PictureGuide[]
  /** The review issues this mends: the proposal says so. */
  issues?: string[]
  /** Whose model writes the chapter over. Left out: as the settings say (`rewriteBy`). */
  by?: 'writer' | 'planner'
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
  /** Where it was written by pictures: how many, and who looked at them. */
  pictures?: PicturesRead
  /** The pictures in the text were not all handed back as they stood: how many were put back, how many of the writer's own making taken out. */
  figures?: FiguresKept
  /** Whose model wrote it: the writer's, or the planner's (the settings `rewriteBy` / `mendBy`, or as the caller said). */
  who?: 'writer' | 'planner'
}

/** What was done for a text's pictures, where anything was. */
export function figuresOf(kept: { back: number; made: number }): { figures?: FiguresKept } {
  return kept.back > 0 || kept.made > 0 ? { figures: { back: kept.back, made: kept.made } } : {}
}

export function shouldApply(core: NovelCore, task: TaskContext, explicit: boolean | undefined, fallback: boolean): boolean {
  if (explicit !== undefined) return explicit
  if (task.origin === 'agent') return !core.currentSettings().reviewAgentRevisions
  return fallback
}

export async function requireChapter(runtime: ProjectRuntime, ref: string): Promise<{ chapter: LocatedChapter; text: string }> {
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
export async function onPending(runtime: ProjectRuntime, chapterId: string, text: string): Promise<{ text: string; used: Proposal[] }> {
  const waiting = (await runtime.project.proposals()).filter(proposal => proposal.status === 'pending' && proposal.chapterId === chapterId).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  let out = text
  const used: Proposal[] = []
  for (const proposal of waiting) {
    if (proposal.kind === 'chapter') {
      if (out !== text || proposal.before !== text) continue
      out = proposal.after
    } else {
      const range = locateQuote(out, proposal.before, proposal.at)
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
export async function takenIn(runtime: ProjectRuntime, used: readonly Proposal[], issues: readonly string[] | undefined, lang: 'zh' | 'en'): Promise<{ carried: Partial<Proposal>; settle: Proposal[] }> {
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
export async function settleTakenIn(runtime: ProjectRuntime, used: readonly Proposal[], by: string): Promise<void> {
  for (const proposal of used) await runtime.project.supersedeProposal(proposal.id, by)
}

/**
 * A rewriting parted as its chapter parts paragraphs. Where the chapter keeps an empty line between paragraphs and
 * never breaks a line otherwise, a single line break in what a model handed in is a paragraph break written the
 * model's way: it is given the empty line.
 */
export function partedAs(text: string, after: string): string {
  if (!text.includes('\n\n') || /[^\n]\n[^\n]/.test(text)) return after
  return after.replace(/([^\n])\n(?=[^\n])/g, '$1\n\n')
}

/** Find a quoted passage; with a position hint, the occurrence nearest to it wins. */
export function locateQuote(text: string, quote: string, near?: number): { start: number; end: number } | undefined {
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
  let after: string
  let guided: Awaited<ReturnType<typeof guidePictures>>
  // Whose words they are: whoever settled the place wrote them, else the model the settings (or the caller) name.
  const who: 'writer' | 'planner' = params.written !== undefined ? 'planner' : rewritesBy(core, params.by)
  if (params.written !== undefined) {
    // Whoever settled the place wrote what it is to read: nobody is asked.
    after = cleanProse(params.written).trim()
    if (after.length === 0) {
      // Taken out. Where the whole line goes, the break it stood before goes with it — once.
      const lineStart = text.lastIndexOf('\n', range.start - 1) + 1
      const next = text.indexOf('\n', range.end)
      const lineEnd = next < 0 ? text.length : next
      if (text.slice(lineStart, range.start).trim().length === 0 && text.slice(range.end, lineEnd).trim().length === 0) {
        let end = lineEnd
        while (text[end] === '\n') end += 1
        let start = lineStart
        // (The last line of the chapter: the break before it goes instead.)
        if (end >= text.length) while (start > 0 && text[start - 1] === '\n') start -= 1
        range = { start, end }
      }
    }
  } else {
    const route = await core.route(who === 'planner' ? 'architect' : 'writer', runtime, task)
    guided = await guidePictures(core, runtime, route, params.guides, 'passage', task)
    const pack = await core.pack(runtime, route, {
      purpose: 'revise',
      chapter,
      brief: params.instruction,
      focus: text.slice(range.start, range.end),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    })
    const base = { lang, language: manifest.language, title: manifest.title }
    const response = await core.llm.complete({
      route,
      system: reviseSpanSystem({ ...base, style: renderStyle(await project.activeStyle(), lang) }),
      ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
      prompt: reviseSpanTask({
        ...base,
        context: `${pack.text}${guided !== undefined ? `\n\n${guided.text}` : ''}`,
        before: clipTail(text.slice(0, range.start), 1800),
        passage: text.slice(range.start, range.end),
        after: clip(text.slice(range.end), 900),
        instruction: params.instruction,
      }),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      onText: (_delta, total) => { task.job?.rewrite(total) },
    })
    after = cleanProse(response.text).replace(/^<<<\s*/, '').replace(/\s*>>>$/, '').trim()
    if (after.length === 0) throw new ProjectError('novel/empty', 'the model returned an empty revision')
  }
  const passage = text.slice(range.start, range.end)
  after = partedAs(found.text, after)
  // The passage's pictures are the text's, not the writer's: one left out goes back where it stood.
  const held = keptPictures(passage, after)
  after = held.text.trim()
  const figures = figuresOf(held)
  // Keep the passage's own framing: a selection inside a paragraph must not gain paragraph breaks at its edges.
  // (A passage taken out leaves nothing, its framing neither.)
  const leading = /^\s*/.exec(passage)?.[0] ?? ''
  const trailing = /\s*$/.exec(passage)?.[0] ?? ''
  if (after.length > 0) after = `${leading}${after}${trailing}`
  if (after === passage) throw new ProjectError('novel/invalid', 'what the passage is to read is what it reads already — there is nothing to change')
  // Held to what changed (see `tight`): the proposal is of the sentences that differ, where they stand once.
  const shown = params.tight === true ? changedCore(passage, after, stretch => occurrences(found.text, stretch) === 1) : { before: passage, after, start: 0 }
  const at = range.start + shown.start

  const result: ReviseResult = {
    chapterId: chapter.plan.id,
    title: chapter.plan.title,
    index: chapter.index,
    kind: 'span',
    applied: apply,
    wordsBefore: countWords(shown.before),
    wordsAfter: countWords(shown.after),
    before: shown.before,
    after: shown.after,
    ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}),
    ...figures,
    who,
  }
  const read = { ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}), ...figures }
  if (apply) {
    await project.saveChapterText(chapter.plan.id, text.slice(0, range.start) + after + text.slice(range.end), { reason: 'before-revise' })
    scheduleDigest(core, runtime, chapter.plan.id, task)
  } else if (based.used.length === 0 || (based.used.every(proposal => proposal.kind === 'span') && found.text.includes(shown.before))) {
    // A change of its own — also when it was written knowing the ones that wait: the passage is as the book has it,
    // and none of them rewrites the chapter, so each is accepted or turned down by itself.
    const proposal = await project.addProposal({ chapterId: chapter.plan.id, kind: 'span', instruction: params.instruction, before: shown.before, after: shown.after, at, createdBy: task.origin, ...read, ...(params.why !== undefined ? { rationale: params.why } : {}), ...(params.batchId !== undefined ? { batchId: params.batchId } : {}), ...(params.issues !== undefined && params.issues.length > 0 ? { issues: params.issues } : {}) })
    result.proposalId = proposal.id
  } else {
    // The passage is one a waiting change made, or stands in a chapter rewritten whole: one proposal for the chapter
    // with all of them and this one in.
    const taken = await takenIn(runtime, based.used, params.issues, lang)
    const proposal = await project.addProposal({ chapterId: chapter.plan.id, kind: 'chapter', instruction: params.instruction, before: found.text, after: text.slice(0, range.start) + after + text.slice(range.end), createdBy: task.origin, ...read, ...(params.batchId !== undefined ? { batchId: params.batchId } : {}), ...taken.carried })
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
  // Whose model writes it over: the writer's, unless the author has the crew's do such rewriting (or the caller says).
  const who = rewritesBy(core, params.by)
  const route = await core.route(who === 'planner' ? 'architect' : 'writer', runtime, task)
  // Rewritten whole, the chapter still goes by the pictures the author gave it — or by the ones given to this revision.
  const guided = await guidePictures(core, runtime, route, params.guides ?? chapter.plan.guides, 'revise', task)
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
    ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
    prompt: reviseChapterTask({ ...base, context: `${pack.text}${guided !== undefined ? `\n\n${guided.text}` : ''}`, instruction: params.instruction }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
  })
  const written = cleanProse(response.text, chapter.plan.title)
  if (written.length === 0) throw new ProjectError('novel/empty', `the ${who === 'planner' ? "planner's" : "writer's"} model returned an empty revision`)
  // The chapter's pictures stay in it through a rewriting: one the writer left out goes back where it stood.
  const held = keptPictures(based.text, written)
  const after = held.text
  const figures = figuresOf(held)
  if (response.finish === 'max-tokens' && countWords(after) < words * 0.8) {
    throw new ProjectError('novel/truncated', `the revision was cut off at the output limit — clear or raise "max output tokens" on the ${who === 'planner' ? "planner's" : "writer's"} role in Novel Studio → Settings (a model that reasons spends its reasoning out of the same allowance), or revise the chapter in smaller passages`)
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
    ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}),
    ...figures,
    who,
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
      ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}),
      ...figures,
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
  /** Only these chapters: the planner looks at them and at nothing else, and nothing outside them changes. */
  chapters?: string[]
  /** Apply every rewrite immediately. Default: proposals for review. */
  apply?: boolean
  concurrency?: number
  /** The planner may also say what the bible should read otherwise; each such change waits as a suggestion. */
  bible?: boolean
  /**
   * What the writer of one chapter is told, in place of the instruction with the planner's reason for that chapter
   * appended. `place`: it is told to whoever rewrites one place of the chapter — what is being mended there, for it
   * to know; what that place is to become is said after it.
   */
  brief?: (chapterId: string, reason: string, place?: boolean) => string
  /** The review issues a chapter's rewrite mends, for its proposal to say so. */
  issuesOf?: (chapterId: string) => string[]
  /** The line of the plot the revision is of, by id, when it is not the main one: its chapters are the ones looked at, numbered along it. */
  line?: string
  /** Go on from the changes that still wait: every chapter is rewritten as `ReviseChapterParams.onto` says, and the planner is told which chapters have some. */
  onto?: boolean
  /** Pictures the revision goes by: the planner scopes it with them, and each chapter is rewritten by them. */
  guides?: PictureGuide[]
  /**
   * What is asked is a change the author wants made through the book, in their words — not a problem a review found:
   * the planner is told so, and names every place the change reaches.
   */
  asked?: boolean
  /** The problem itself and no more — what hangs on it elsewhere in the book is not traced. */
  narrow?: boolean
  /**
   * Chapters whose text goes to the planner whole, to quote from — the ones the problems were found in. Left out:
   * the chapters named in `chapters`; else every chapter where the book is short enough, or where the planner cannot
   * read chapters by itself (as many as there is room for).
   */
  texts?: string[]
  /** The issues every change of this mending is for, whichever chapter it lands in (in place of `issuesOf`). */
  mends?: string[]
  /**
   * The planner writes what each place is to read, and that is what is proposed: the writer's model is not asked for
   * the places. Left out: as the settings say (`mendBy`). (Whose model writes over a chapter that places will not do
   * for is another setting: `rewriteBy`.)
   */
  direct?: boolean
  /**
   * What the author said, where `instruction` holds more than that (a lead with the passage they pointed at): what
   * the issues filed and the changes proposed are said to be for.
   */
  said?: string
  /**
   * What is given in `instruction` is something the author noticed in the book and wants found: the planner says
   * first where it shows — each place quoted, and filed as an issue of that chapter's review, marked as the author's
   * own (`ReviewIssue.lead`) — and then, with `fix`, names the places that mend it, whose changes are shown beneath
   * those issues. `find`: found and filed, nothing changed.
   */
  lead?: 'fix' | 'find'
}

/** A place the planner named: where it is in its chapter, and what is to change there — or, written by the planner itself, what it is to read (`written`). */
interface Place { id: string; index: number; start: number; end: number; quote: string; how: string; written?: string }

/** Where what the author noticed shows, as the planner found it: the chapter, the words quoted, and what is wrong there. */
interface Finding { id: string; index: number; start: number; end: number; quote: string; type: IssueType; severity: IssueSeverity; explanation: string; suggestion?: string }

/** One of them filed as an issue of its chapter's review. */
export interface FiledFinding { chapterId: string; index: number; issue: string; quote?: string; explanation: string; severity: IssueSeverity; /** It was on file already (the same words quoted, still open) and was not added twice. */ known?: true }

const ISSUE_TYPES: IssueType[] = ['continuity', 'character', 'world', 'timeline', 'style', 'pacing', 'logic', 'language']
const ISSUE_SEVERITIES: IssueSeverity[] = ['high', 'medium', 'low']

/** How much of the chapters concerned goes to the planner word for word, in characters; past this, it reads them with its tools. */
const PLACES_TEXT = 36000

export interface ReviseBookResult {
  batchId: string
  note?: string
  /** Chapters the planner left as they are. */
  untouched: number
  /** Changes to the bible the planner proposed; they wait among the suggestions. */
  bible?: { name: string; field: string }[]
  /** One for each change made: a place rewritten (`span`) or a chapter written over — several of one chapter where several of its places changed. */
  results: (Pick<ReviseResult, 'chapterId' | 'title' | 'index' | 'applied' | 'proposalId' | 'wordsBefore' | 'wordsAfter' | 'figures'> & { reason: string; kind: 'span' | 'chapter' })[]
  failed: { chapterId: string; error: string }[]
  /** Where pictures were given: how many, and who looked at them — the planner that scoped it, or the writer where the chapters were named. */
  pictures?: PicturesRead
  /** Where the author's lead was followed (`ReviseBookParams.lead`): the places it shows, each now an issue of its chapter's review. */
  found?: FiledFinding[]
  /** The planner wrote the changed words itself (`ReviseBookParams.direct`). */
  direct?: true
}

/**
 * A change made through the book — a problem a review found mended, or something the author asks for — by places:
 * the planner names the places that change, each quoted from the text with what is to change there, and the writer
 * rewrites those and nothing else, so every place comes back as a change of its own to look at. A chapter is written
 * over whole only where the planner says places will not do.
 */
export async function reviseBook(core: NovelCore, runtime: ProjectRuntime, params: ReviseBookParams, task: TaskContext): Promise<ReviseBookResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // One line of the plot at a time: its chapters as they are read on it, numbered along it.
  const along = params.line !== undefined && params.line !== MAIN_LINE ? params.line : undefined
  const every = (await project.chapterInfos(along)).filter(info => info.hasText)
  if (every.length === 0) throw new ProjectError('novel/empty', 'no chapter has text yet')
  // Where the author named chapters, those are all there is to change: the planner sees them and no other.
  let infos = every
  const named = params.chapters !== undefined && params.chapters.length > 0
  if (named) {
    const chosen = new Set<string>()
    for (const ref of params.chapters!) {
      const chapter = await project.findChapter(ref, along)
      if (chapter !== undefined) chosen.add(chapter.plan.id)
    }
    infos = every.filter(info => chosen.has(info.id))
    if (infos.length === 0) throw new ProjectError('novel/not-found', 'none of the chapters named has text on this line of the plot')
  }

  let note: string | undefined
  let bible: { name: string; field: string }[] = []
  let pictures: PicturesRead | undefined
  let places: Place[] = []
  let findings: Finding[] = []
  const lead = params.lead
  const direct = lead !== 'find' && mendsDirect(core, params.direct)
  task.job?.progress(0, 1, lead === 'find' ? L(lang, '照你说的去找', 'looking for what you noticed') : lead === 'fix' ? L(lang, '照你说的去找，再定在哪几处改', 'looking for what you noticed, then settling which places change') : L(lang, '定在哪几处改', 'settling which places change'))
  const lines: string[] = []
  // Going on from what waits: the planner is told which chapters have a change waiting, and what it was for.
  const waiting = params.onto === true ? (await project.proposals()).filter(proposal => proposal.status === 'pending') : []
  // The planner quotes the text: each chapter as this revision finds it — with what waits laid in, where it goes on
  // from that. (Such a chapter is what its reading tool shows it too: what it copies is what it is checked against.)
  const stands = new Map<string, string>()
  const laidIn = new Map<string, string>()
  for (const info of infos) {
    const memory = await project.memory(info.id)
    const own = await project.chapterText(info.id)
    stands.set(info.id, params.onto === true ? (await onPending(runtime, info.id, own)).text : own)
    if (stands.get(info.id) !== own) laidIn.set(info.id, stands.get(info.id)!)
    const text = memory?.summary ?? clip(own, 300)
    const pending = waiting.filter(proposal => proposal.chapterId === info.id)
    lines.push(`${info.index}. ${info.title}\n${text}${pending.length > 0 ? `\n${L(lang, `（这一章已有 ${pending.length} 处还没采纳的修改，这次会接着它们改：${clip(pending.map(proposal => proposal.instruction.replace(/\s+/g, ' ')).join('；'), 240)}）`, `(${pending.length} change(s) to this chapter still wait, and this revision goes on from them: ${clip(pending.map(proposal => proposal.instruction.replace(/\s+/g, ' ')).join('; '), 300)})`)}` : ''}`)
  }
  // The planner scopes the revision with the pictures it goes by in sight (or in words).
  const route = await core.route('architect', runtime, task)
  const guided = await guidePictures(core, runtime, route, params.guides, 'revise', task)
  pictures = picturesRead(guided)
  const reads = crewPlan(core, 'architect', manifest).mode !== 'call' && core.roles !== undefined && core.roles.can(route)
  // What goes along whole, to be quoted from: the chapters the problems were found in, or the ones the author named;
  // else the whole line where it is short — and, for a planner that cannot read chapters by itself, as much as fits.
  const all = infos.reduce((sum, info) => sum + (stands.get(info.id)?.length ?? 0), 0)
  const whole = params.texts ?? (named || all <= PLACES_TEXT || !reads ? infos.map(info => info.id) : [])
  const shown: string[] = []
  let room = PLACES_TEXT
  for (const id of whole) {
    const info = infos.find(candidate => candidate.id === id)
    const text = stands.get(id)
    if (info === undefined || text === undefined || text.length > room) continue
    room -= text.length
    shown.push(`${L(lang, `### 第 ${info.index} 章《${info.title}》`, `### Chapter ${info.index}, "${info.title}"`)}\n\n${text}`)
  }
  const summaries = `${lines.join('\n\n')}${guided !== undefined ? `\n\n${guided.text}` : ''}`
  const asked = params.asked === true
  // (Where the planner writes the changed words itself, it is told how the book is written.)
  const style = direct ? renderStyle(await project.activeStyle(), lang) : undefined
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: lead === 'find' ? L(lang, '照引导审校 · 找出来', 'Review by a lead · finding it')
      : lead === 'fix' ? L(lang, '照引导审校 · 找出来并修', 'Review by a lead · finding and mending it')
        : asked ? L(lang, '全书修订 · 定在哪几处改', 'Book-wide revision · which places change') : L(lang, '修问题 · 定在哪几处改', 'Mending · which places change'),
    line: along ?? MAIN_LINE,
    tool: lead === 'find' ? 'submit_findings' : 'submit_places',
    what: lead === 'find' ? L(lang, '它在哪几处露出来', 'where it shows')
      : direct ? L(lang, '改哪几处、每一处改成什么', 'which places change, and what each of them is to read')
        : L(lang, '改哪几处、各怎么改', 'which places change, and how each of them does'),
    system: architectSystem(lang),
    ...(laidIn.size > 0 ? { texts: laidIn } : {}),
    ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
    prompt: mendTask({ lang, language: manifest.language, title: manifest.title, instruction: params.instruction, chapters: summaries, ...(shown.length > 0 ? { texts: shown.join('\n\n'), ...(shown.length === infos.length ? { allGiven: true } : {}) } : {}), wide: params.narrow !== true, reads, ...(asked ? { asked: true } : {}), ...(named ? { only: true } : {}), ...(params.bible === true ? { bible: true } : {}), ...(lead !== undefined ? { lead } : {}), ...(direct ? { direct: true, ...(style !== undefined ? { style } : {}) } : {}) }),
    temperature: 0.2,
    // What is quoted is looked for in the text at once: a place that is not there, or that is there twice, is sent
    // back to be quoted as it stands.
    validate: (raw) => {
      const record = asRecord(raw)
      const wrong: string[] = []
      if (lead !== undefined) findings = findingsIn(record, infos, stands, lang, wrong)
      places = lead === 'find' ? [] : placesIn(record, infos, stands, lang, direct, wrong)
      if (wrong.length > 0) throw new Error(`${wrong.join('\n')}\n${L(lang, '改好这几条，把整个结果重新交一次。', 'Put these right and hand the whole result in again.')}`)
      return record
    },
  })
  note = asText(value.note)
  if (params.bible === true && lead !== 'find') bible = await proposeBibleEdits(runtime, asArray(value.bible), lang)
  // What was found is on file before anything is changed for it: each place an issue of its chapter, and the changes
  // made below say which of them they are for.
  const batchId = newId('batch')
  // (Said to be handed over only where something is being changed for them.)
  const filed = lead !== undefined ? await fileFindings(runtime, findings, params.said ?? params.instruction, lead === 'fix' && (places.length > 0 || asArray(value.chapters).length > 0) ? batchId : undefined) : []
  const ofFinding = new Map(filed.map((item, at) => [findings[at]!, item.issue]))
  const targets: { id: string; reason: string }[] = []
  for (const raw of lead === 'find' ? [] : asArray(value.chapters)) {
    const item = asRecord(raw)
    const index = Number(item.index)
    const info = infos.find(candidate => candidate.index === index)
    if (info !== undefined && !targets.some(target => target.id === info.id)) targets.push({ id: info.id, reason: asText(item.reason) ?? params.instruction })
  }
  // A chapter written over whole takes the places named in it along: they are said to whoever writes it over.
  for (const target of targets) {
    const inside = places.filter(place => place.id === target.id)
    if (inside.length > 0) target.reason = `${target.reason}${lang === 'zh' ? '；' : '; '}${inside.map(place => place.how).join(lang === 'zh' ? '；' : '; ')}`
  }
  places = places.filter(place => !targets.some(target => target.id === place.id))

  const apply = params.apply === true
  const results: ReviseBookResult['results'] = []
  const failed: ReviseBookResult['failed'] = []
  let done = 0
  const total = targets.length + places.length
  task.job?.progress(0, total)
  // Per-chapter streams would interleave in one job buffer, so the batch reports progress only.
  const inner = (): TaskContext => ({ origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) })
  /**
   * The issues a change is for. Where the author's lead was followed: the findings the place takes in — else, the
   * place being elsewhere in the chapter, all that were found in that chapter (a chapter nothing was found in changes
   * for the batch as a whole, and says so through it).
   */
  const issuesFor = (chapterId: string, place?: Place): string[] | undefined => {
    if (lead === undefined) return params.mends ?? params.issuesOf?.(chapterId)
    const here = findings.filter(finding => finding.id === chapterId)
    const taken = place !== undefined ? here.filter(finding => finding.start < place.end && place.start < finding.end) : []
    const ids = (taken.length > 0 ? taken : here).map(finding => ofFinding.get(finding)).filter((id): id is string => id !== undefined)
    return ids.length > 0 ? [...new Set(ids)] : undefined
  }
  const colon = lang === 'zh' ? '：' : ': '
  const over = async (target: { id: string; reason: string }): Promise<void> => {
    try {
      const instruction = params.brief !== undefined ? params.brief(target.id, target.reason === params.instruction ? '' : target.reason)
        : target.reason === params.instruction ? params.instruction : `${params.instruction}\n\n${L(lang, '具体到本章', 'For this chapter specifically')}${colon}${target.reason}`
      const issues = issuesFor(target.id)
      const result = await reviseChapter(core, runtime, { chapter: target.id, instruction, apply, batchId, ...(params.onto === true ? { onto: true } : {}), ...(issues !== undefined ? { issues } : {}), ...(params.guides !== undefined && params.guides.length > 0 ? { guides: params.guides } : {}) }, inner())
      results.push({
        chapterId: result.chapterId,
        title: result.title,
        index: result.index,
        applied: result.applied,
        ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}),
        wordsBefore: result.wordsBefore,
        wordsAfter: result.wordsAfter,
        reason: target.reason,
        kind: 'chapter',
        ...(result.figures !== undefined ? { figures: result.figures } : {}),
      })
      pictures ??= result.pictures
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push({ chapterId: target.id, error: error instanceof Error ? error.message : String(error) })
    }
    done += 1
    task.job?.progress(done, total)
  }
  // The places of one chapter are rewritten one after the other, top to bottom — each change laid where the one
  // before left the text (applied), or beside it (waiting) — and chapters side by side. The writer is told what is
  // being mended, and of this one place what the planner settled.
  const here = async (group: Place[]): Promise<void> => {
    for (const place of group.sort((left, right) => left.start - right.start)) {
      try {
        const told = params.brief !== undefined ? params.brief(place.id, '', true) : params.said ?? params.instruction
        // The place is all that may change, and of it only what the planner said: the writer is told both.
        const instruction = `${told}\n\n${L(lang, '这一次只改下面这一处：能动的只有这一处里的字，它前后的正文不会变。策划定的改法', 'This time only the passage below changes: nothing outside it will, so it has to join what stands on both sides. What the planner settled for it')}${colon}${place.how}\n${L(lang, '改法没有提到的字句照原样交回，不顺手润色，不添改法之外的内容。', 'Hand back as they stand the words this does not speak of: no polishing in passing, nothing added beyond it.')}`
        const issues = issuesFor(place.id, place)
        // (Written by the planner: the place is what it handed in, and what the proposal says it is for is the mending itself.)
        const result = await reviseSpan(core, runtime, { chapter: place.id, quote: place.quote, start: place.start, instruction: place.written !== undefined ? told : instruction, apply, batchId, tight: true, ...(place.written !== undefined ? { written: place.written, why: place.how } : { by: 'writer' as const }), ...(params.onto === true ? { onto: true } : {}), ...(issues !== undefined ? { issues } : {}), ...(params.guides !== undefined && params.guides.length > 0 ? { guides: params.guides } : {}) }, inner())
        results.push({
          chapterId: result.chapterId,
          title: result.title,
          index: result.index,
          applied: result.applied,
          ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}),
          wordsBefore: result.wordsBefore,
          wordsAfter: result.wordsAfter,
          reason: place.how,
          kind: 'span',
          ...(result.figures !== undefined ? { figures: result.figures } : {}),
        })
        pictures ??= result.pictures
      } catch (error) {
        if (task.signal?.aborted === true) throw error
        failed.push({ chapterId: place.id, error: error instanceof Error ? error.message : String(error) })
      }
      done += 1
      task.job?.progress(done, total)
    }
  }
  const groups = new Map<string, Place[]>()
  for (const place of places) groups.set(place.id, [...(groups.get(place.id) ?? []), place])
  const work: (() => Promise<void>)[] = [...targets.map(target => async () => { await over(target) }), ...[...groups.values()].map(group => async () => { await here(group) })]
  await mapLimit(work, params.concurrency ?? await core.parallelFor('text', runtime), async (run) => { await run() }, task.signal)
  results.sort((left, right) => left.index - right.index)
  task.job?.result({ batchId, ...(lead !== undefined ? { found: filed.length } : {}) })
  const touched = new Set([...targets.map(target => target.id), ...places.map(place => place.id)])
  return { batchId, ...(note !== undefined ? { note } : {}), untouched: infos.length - touched.size, ...(bible.length > 0 ? { bible } : {}), results, failed, ...(pictures !== undefined ? { pictures } : {}), ...(lead !== undefined ? { found: filed } : {}), ...(direct ? { direct: true as const } : {}) }
}

/**
 * Where what the author noticed shows, as a planner handed it in, each place found in its chapter. What cannot be
 * used is said into `wrong`, with the places' own faults, for the whole to be handed in again.
 */
function findingsIn(record: Record<string, unknown>, infos: readonly { id: string; index: number; title: string }[], stands: ReadonlyMap<string, string>, lang: 'zh' | 'en', wrong: string[]): Finding[] {
  const found: Finding[] = []
  asArray(record.findings).forEach((entry, at) => {
    const item = asRecord(entry)
    const nth = at + 1
    const index = Number(item.chapter ?? item.index)
    const info = infos.find(candidate => candidate.index === index)
    const quote = asText(item.quote)
    const explanation = asText(item.explanation)
    if (info === undefined) {
      wrong.push(L(lang, `findings 第 ${nth} 条：第 ${String(item.chapter ?? item.index)} 章不在这次能查的章节里（没有这一章，它还没有正文，或者作者没让查它）`, `findings[${nth}]: chapter ${String(item.chapter ?? item.index)} is not among the chapters this looks at (no such chapter, no text yet, or not one the author named)`))
      return
    }
    if (quote === undefined || [...quote].length < 2 || explanation === undefined) {
      wrong.push(L(lang, `findings 第 ${nth} 条：quote（露出问题的原文）和 explanation（这一处是什么问题）都要写`, `findings[${nth}]: both quote (the text it shows in) and explanation (what is wrong there) are needed`))
      return
    }
    const text = stands.get(info.id) ?? ''
    const range = fuzzyFind(text, quote)
    if (range === undefined) {
      wrong.push(L(lang, `findings 第 ${nth} 条：第 ${info.index} 章里找不到这段原文——quote 从正文里逐字照抄，不改写、不省略、不用省略号连接两处：“${clip(quote, 60)}”`, `findings[${nth}]: chapter ${info.index} does not have this text — copy quote word for word from the chapter, nothing reworded, nothing left out, no ellipsis joining two places: "${clip(quote, 80)}"`))
      return
    }
    const type = asText(item.type) as IssueType | undefined
    const severity = asText(item.severity) as IssueSeverity | undefined
    const suggestion = asText(item.suggestion)
    // (The same words named twice are one place.)
    if (found.some(other => other.id === info.id && other.start === range.start && other.end === range.end)) return
    found.push({ id: info.id, index: info.index, start: range.start, end: range.end, quote: text.slice(range.start, range.end), type: type !== undefined && ISSUE_TYPES.includes(type) ? type : 'continuity', severity: severity !== undefined && ISSUE_SEVERITIES.includes(severity) ? severity : 'medium', explanation, ...(suggestion !== undefined ? { suggestion } : {}) })
  })
  return found
}

/**
 * File what was found by the author's lead as issues of the chapters it was found in — beside whatever a review of
 * the chapter left there. A chapter that was never reviewed gets a review that says so (`unread`) and holds these
 * alone; a place already on file, the same words quoted and still open, is not added twice.
 * @param mending - the batch of changes being made for them, where there is one.
 */
async function fileFindings(runtime: ProjectRuntime, findings: readonly Finding[], lead: string, mending: string | undefined): Promise<FiledFinding[]> {
  const { project } = runtime
  const said = lead.trim()
  const filed: FiledFinding[] = []
  const byChapter = new Map<string, Finding[]>()
  for (const finding of findings) byChapter.set(finding.id, [...(byChapter.get(finding.id) ?? []), finding])
  const ids = new Map<Finding, FiledFinding>()
  for (const [chapterId, mine] of byChapter) {
    const text = await project.chapterText(chapterId)
    const review: ChapterReview = (await project.review(chapterId)) ?? { chapterId, textHash: hashText(text), createdAt: new Date().toISOString(), verdict: '', issues: [], unread: true }
    const issues = [...review.issues]
    for (const finding of mine) {
      // An issue is anchored to words the chapter has: found among changes that still wait, it is filed without them.
      const anchored = fuzzyFind(text, finding.quote)
      const quote = anchored !== undefined ? text.slice(anchored.start, anchored.end) : undefined
      const at = quote !== undefined ? issues.findIndex(issue => issue.resolved !== true && issue.quote === quote) : -1
      if (at >= 0) {
        const known = issues[at]!
        issues[at] = { ...known, lead: known.lead ?? said, ...(mending !== undefined ? { mending } : {}) }
        ids.set(finding, { chapterId, index: finding.index, issue: known.id, quote, explanation: known.explanation, severity: known.severity, known: true })
        continue
      }
      const issue: ReviewIssue = { id: newId('is'), severity: finding.severity, type: finding.type, ...(quote !== undefined ? { quote } : {}), explanation: finding.explanation, ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}), lead: said, ...(mending !== undefined ? { mending } : {}) }
      issues.push(issue)
      ids.set(finding, { chapterId, index: finding.index, issue: issue.id, ...(quote !== undefined ? { quote } : {}), explanation: issue.explanation, severity: issue.severity })
    }
    await project.saveReview({ ...review, issues })
  }
  for (const finding of findings) filed.push(ids.get(finding)!)
  return filed
}

/**
 * The places a planner named, each found in its chapter. What is quoted is looked for where it is said to stand —
 * white space and the style of quotation marks forgiven, nothing else — and what is wrong with any of them is said
 * all at once, for the planner to hand the whole in again.
 * @throws Error naming every place that cannot be used, and why.
 */
function placesIn(record: Record<string, unknown>, infos: readonly { id: string; index: number; title: string }[], stands: ReadonlyMap<string, string>, lang: 'zh' | 'en', direct = false, faults?: string[]): Place[] {
  const wrong: string[] = faults ?? []
  const places: Place[] = []
  asArray(record.edits).forEach((entry, at) => {
    const item = asRecord(entry)
    const nth = at + 1
    const index = Number(item.chapter ?? item.index)
    const info = infos.find(candidate => candidate.index === index)
    const find = asText(item.find)
    // Written by the planner itself: what the place is to read (an empty text takes it out), and a word on why.
    const written = direct && typeof item.replace === 'string' ? item.replace : undefined
    const how = direct ? asText(item.why) ?? asText(item.how) ?? L(lang, '策划改的', 'changed by the planner') : asText(item.how)
    if (info === undefined) {
      wrong.push(L(lang, `edits 第 ${nth} 条：第 ${String(item.chapter ?? item.index)} 章不在这次能改的章节里（没有这一章，它还没有正文，或者作者没让动它）`, `edits[${nth}]: chapter ${String(item.chapter ?? item.index)} is not among the chapters this may change (no such chapter, no text yet, or not one the author named)`))
      return
    }
    if (direct && (find === undefined || [...find].length < 2 || written === undefined)) {
      wrong.push(L(lang, `edits 第 ${nth} 条：find（要换掉的原文）和 replace（这一处改好之后的全文；整句删掉给空字符串）都要写`, `edits[${nth}]: both find (the text replaced) and replace (the whole of the place as it is to read; an empty string where it goes) are needed`))
      return
    }
    if (find === undefined || [...find].length < 2 || how === undefined) {
      wrong.push(L(lang, `edits 第 ${nth} 条：find（要改的原文）和 how（改成什么样）都要写`, `edits[${nth}]: both find (the text to change) and how (what it is to say instead) are needed`))
      return
    }
    const text = stands.get(info.id) ?? ''
    const range = fuzzyFind(text, find)
    if (range === undefined) {
      wrong.push(L(lang, `edits 第 ${nth} 条：第 ${info.index} 章里找不到这段原文——find 从正文里逐字照抄，不改写、不省略、不用省略号连接两处：“${clip(find, 60)}”`, `edits[${nth}]: chapter ${info.index} does not have this text — copy find word for word from the chapter, nothing reworded, nothing left out, no ellipsis joining two places: "${clip(find, 80)}"`))
      return
    }
    const all = countWords(text)
    if (all > 400 && countWords(text.slice(range.start, range.end)) > all * 0.6) {
      wrong.push(L(lang, `edits 第 ${nth} 条：圈了第 ${info.index} 章的大半——缩到真要改的那几句；这一章真要通篇改，就把它列进 chapters`, `edits[${nth}]: this takes in most of chapter ${info.index} — narrow it to the sentences that have to change; where the chapter has to change throughout, list it under chapters instead`))
      return
    }
    // A place is one place: words that stand twice in the chapter do not say which of the two is meant.
    const times = occurrences(text, text.slice(range.start, range.end))
    if (times > 1) {
      wrong.push(L(lang, `edits 第 ${nth} 条：这段原文在第 ${info.index} 章里出现了 ${times} 次，定不了是哪一处——连它前面或后面的半句一起抄，让它只对得上一处：“${clip(find, 60)}”`, `edits[${nth}]: this text stands ${times} times in chapter ${info.index}, which does not say which place is meant — copy the half-sentence before or after it too, so that it is found once: "${clip(find, 80)}"`))
      return
    }
    if (places.some(other => other.id === info.id && range.start < other.end && other.start < range.end)) {
      wrong.push(L(lang, `edits 第 ${nth} 条：和前面的一条在第 ${info.index} 章里重叠——并成一处`, `edits[${nth}]: overlaps an earlier place in chapter ${info.index} — make them one`))
      return
    }
    if (written !== undefined && written.trim() === text.slice(range.start, range.end).trim()) {
      wrong.push(L(lang, `edits 第 ${nth} 条：replace 和 find 一样，没有改动——这一处不用改就不列`, `edits[${nth}]: replace reads as find does, so nothing changes — a place that need not change is not listed`))
      return
    }
    places.push({ id: info.id, index: info.index, start: range.start, end: range.end, quote: text.slice(range.start, range.end), how, ...(written !== undefined ? { written } : {}) })
  })
  if (faults === undefined && wrong.length > 0) throw new Error(`${wrong.join('\n')}\n${L(lang, '改好这几条，把整个结果重新交一次。', 'Put these right and hand the whole result in again.')}`)
  return places
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
   * `passage`: the place the issue quotes; where it quotes none (or what it quoted is no longer there), the planner
   * settles which place — or few places — mends it with the least change, in this chapter or at the other end of
   * what does not agree, and the writer rewrites those and nothing else.
   * `book`: wherever the problem reaches — the planner traces it through the chapters and the bible, and names the
   * places that change with it.
   * `place`: the planner settles the place whatever the issue quotes — what a review quotes is where the problem
   * shows, which for things that do not agree is not always where it is mended with the least change.
   * `chapter`: the chapter written over whole for it — asked for in so many words, never fallen back to.
   */
  scope: 'passage' | 'place' | 'book' | 'chapter'
  /** Go on from the changes that still wait (`ReviseChapterParams.onto`): a mending that follows others. */
  onto?: boolean
}

export interface FixIssueResult {
  /** How it was mended: the quoted `passage` rewritten; `places` the planner chose; the `chapter` written over; or traced through the `book`. */
  scope: 'passage' | 'places' | 'chapter' | 'book'
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
    const book = await reviseBook(core, runtime, { instruction: issueInstruction(lang, where, issue, params.note, true), bible: true, texts: [chapter.plan.id], ...(chapter.line !== undefined ? { line: chapter.line } : {}), ...(params.onto === true ? { onto: true } : {}), issuesOf: chapterId => (chapterId === chapter.plan.id ? [issue.id] : []) }, task)
    // Handed over: the issue says with which batch of proposals, and they are shown beneath it.
    const current = await project.review(chapter.plan.id)
    if (current !== undefined) await project.saveReview({ ...current, issues: current.issues.map(item => item.id === issue.id ? { ...item, mending: book.batchId } : item) })
    return { scope: 'book', book }
  }
  const instruction = issueInstruction(lang, where, issue, params.note, false)
  const onto = params.onto === true ? { onto: true } : {}
  // (Going on from what waits, the quote is looked for in the chapter as it would stand with that in.)
  const text = params.onto === true ? (await onPending(runtime, chapter.plan.id, await project.chapterText(chapter.plan.id))).text : await project.chapterText(chapter.plan.id)
  const range = issue.quote !== undefined && params.scope !== 'place' ? fuzzyFind(text, issue.quote.trim()) : undefined
  // Written over whole only when that is what was asked for.
  if (params.scope === 'chapter') return { scope: 'chapter', passage: await reviseChapter(core, runtime, { chapter: chapter.plan.id, instruction, issues: [issue.id], ...onto }, task) }
  // A problem that quotes nothing — a contradiction, a missing word of explanation, a beat that comes too soon — or
  // whose quote has since been rewritten can mostly be taken hold of in more than one place, and one is enough: the
  // planner settles which, and the writer rewrites that place. Nothing is written over for it.
  if (range === undefined) {
    const book = await reviseBook(core, runtime, { instruction, narrow: true, texts: [chapter.plan.id], mends: [issue.id], ...(chapter.line !== undefined ? { line: chapter.line } : {}), ...onto }, task)
    const current = await project.review(chapter.plan.id)
    if (current !== undefined) await project.saveReview({ ...current, issues: current.issues.map(item => item.id === issue.id ? { ...item, mending: book.batchId } : item) })
    return { scope: 'places', book }
  }
  // (Where the author has the crew's model make such changes, the quoted place is rewritten by it.)
  return { scope: 'passage', passage: await reviseSpan(core, runtime, { chapter: chapter.plan.id, start: range.start, end: range.end, quote: text.slice(range.start, range.end), instruction, issues: [issue.id], tight: true, ...onto, by: mendsDirect(core) ? 'planner' as const : 'writer' as const }, task) }
}

export interface LeadReviewParams {
  /** What the author noticed in the book, in their words — a problem, or a kind of problem to look for. */
  lead: string
  /** Only these chapters are looked at, and nothing outside them changes. */
  chapters?: string[]
  /** The line of the plot looked at, by id, when it is not the main one. */
  line?: string
  /** `false`: found and filed as issues, nothing changed. Default: found, filed, and mended — each change waits as a proposal beneath its issue. */
  fix?: boolean
  /**
   * The passage the author pointed at when they said it, quoted from the (one) chapter named in `chapters` — "this
   * is wrong here": the planner is told where the author saw it, and looks there first.
   */
  passage?: string
  /** The planner writes the changed words itself. Left out: as the settings say (`mendBy`). */
  direct?: boolean
}

export interface LeadReviewResult {
  /** Where it shows: each place an issue of its chapter's review now. */
  found: FiledFinding[]
  /** In how many chapters. */
  chapters: number
  /** Whether it was to be mended too. */
  fix: boolean
  /** What the planner says of it: where the root lies — or, where nothing was found, where it looked. */
  note?: string
  /** The changes made for it (with `fix`). */
  book: ReviseBookResult
}

/**
 * A review led by the author. They have noticed something in their book already — a pair of glasses that come and go,
 * a day that does not add up — and say it in a sentence; the planner goes into the book for it, says where it shows
 * (each place quoted, and filed as an issue of that chapter's review, marked as the author's own), and mends it by
 * places, each change shown beneath the issue it is for. One run of the planner finds and settles.
 *
 * It is looked for in the book as it stands: what the author noticed, they noticed in the text they have, and an
 * issue quotes that text — so changes that still wait for a chapter are not laid in first, as they are for a mending
 * that goes on from others (a place found in words only a waiting change has could be filed under no sentence).
 */
export async function reviewByLead(core: NovelCore, runtime: ProjectRuntime, params: LeadReviewParams, task: TaskContext): Promise<LeadReviewResult> {
  const lead = params.lead.trim()
  if (lead.length === 0) throw new ProjectError('novel/invalid', 'say what you noticed: the lead is empty')
  const fix = params.fix !== false
  // Said of a passage: the planner is told which, in the author's chapter — the sentence they said stays what is kept.
  const pointed = params.passage?.trim()
  let instruction = lead
  if (pointed !== undefined && pointed.length > 0) {
    const lang = promptLanguage((await runtime.project.manifest()).language)
    const where = params.chapters?.length === 1 ? await runtime.project.findChapter(params.chapters[0]!, params.line) : undefined
    const head = where !== undefined
      ? L(lang, `作者是指着第 ${where.index} 章的这一段说的（问题在这里露出来；它牵连到的别处也要找）：`, `The author said it of this passage of chapter ${where.index} (it shows here; where else it reaches is to be found too):`)
      : L(lang, '作者是指着这一段说的（问题在这里露出来；它牵连到的别处也要找）：', 'The author said it of this passage (it shows here; where else it reaches is to be found too):')
    instruction = `${lead}\n\n${head}\n「${clip(pointed, 1200)}」`
  }
  const book = await reviseBook(core, runtime, {
    instruction,
    ...(instruction !== lead ? { said: lead } : {}),
    lead: fix ? 'fix' : 'find',
    bible: true,
    ...(params.chapters !== undefined && params.chapters.length > 0 ? { chapters: params.chapters } : {}),
    ...(params.line !== undefined ? { line: params.line } : {}),
    ...(params.direct !== undefined ? { direct: params.direct } : {}),
  }, task)
  const found = book.found ?? []
  const chapters = new Set(found.map(item => item.chapterId)).size
  task.job?.result({ batchId: book.batchId, found: found.length, chapters, fix, places: book.results.length, failed: book.failed.length, ...(book.note !== undefined ? { note: book.note } : {}) })
  return { found, chapters, fix, ...(book.note !== undefined ? { note: book.note } : {}), book }
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
    `审校在这本书里发现了下面 ${found.length} 个问题，作者要把它们一起修掉：\n\n${all}\n${said.length > 0 ? `\n作者对这一批的总要求（以此为准）：${said}\n` : ''}\n请把它们放在一起看：一处改动能同时解决几个问题的，就只改那一处；彼此有牵连的（同一个事实、同一条因果、同一个人物的表现）前后改成一致，不要这一章改成这样、那一章改成那样。除了上面点到的章节，还有哪些章节写到了与它们相关的事实、因果或人物表现，需要一起改才能前后一致；与此无关的内容保持原样。`,
    `A review found the ${found.length} problems below in this book, and the author wants them mended together:\n\n${all}\n${said.length > 0 ? `\nWhat the author says of the whole batch (this decides): ${said}\n` : ''}\nRead them side by side: where one change mends several of them, make that one change; those that hang together (one fact, one chain of cause, how one person behaves) are mended the same way from chapter to chapter. Besides the chapters named above, which chapters state facts, causes or behaviour that depend on them and have to change with them for the book to agree with itself; leave everything else as it is.`)
  const oneLine = found.map(item => L(lang, `第 ${item.chapter.index} 章：${clip(item.issue.explanation, 60)}`, `Chapter ${item.chapter.index}: ${clip(item.issue.explanation, 80)}`)).join('\n')
  const book = await reviseBook(core, runtime, {
    instruction,
    bible: true,
    texts: [...byChapter.keys()],
    ...(line !== MAIN_LINE ? { line } : {}),
    ...(params.onto === true ? { onto: true } : {}),
    issuesOf: chapterId => (byChapter.get(chapterId) ?? []).map(item => item.issue.id),
    // The writer of one chapter mends what is that chapter's — in full — and knows what else is being mended, to agree with it.
    brief: (chapterId, reason, place) => {
      const mine = byChapter.get(chapterId)
      return [
        mine !== undefined
          ? place === true
            ? L(lang, `这一章正在修下面的问题（你只改交给你的那一处；别的地方另有安排）：\n${mine.map(told).join('\n')}`, `These problems of this chapter are being mended (you change the one place handed to you; the others are seen to separately):\n${mine.map(told).join('\n')}`)
            : L(lang, `审校在这一章发现了下面的问题，这一次一起改掉：\n${mine.map(told).join('\n')}`, `A review found the problems below in this chapter; mend them all in this rewrite:\n${mine.map(told).join('\n')}`)
          : L(lang, '这一章本身没有被点名的问题：它写到了别的章节正在修的事，要跟着改才能前后一致。', 'No problem was named in this chapter itself: it tells of things being mended in other chapters, and has to change with them for the book to agree with itself.'),
        said.length > 0 ? L(lang, `作者对这一批的总要求（以此为准）：${said}`, `What the author says of the whole batch (this decides): ${said}`) : '',
        reason.length > 0 ? L(lang, `策划对这一章的安排：${reason}`, `What the planner settled for this chapter: ${reason}`) : '',
        found.length > (mine?.length ?? 0) ? L(lang, `这一批同时在修的问题（别的章节的不在这一章里改；写到相关的事时与它们的改法保持一致）：\n${oneLine}`, `What is being mended in the same batch (other chapters' problems are not mended here; where this chapter touches them, agree with how they are mended):\n${oneLine}`) : '',
        place === true ? '' : L(lang, '只改为解决这些问题必须改的地方，别的不要动。', 'Change only what mending these takes; leave the rest as it is.'),
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
    // (Where the passage reads the same in more than one place, the one it was made for: the nearest to where it stood.)
    const range = locateQuote(text, proposal.before, proposal.at)
    if (range === undefined) {
      throw new ProjectError('novel/stale-proposal', 'the passage this proposal replaces is no longer in the chapter — it was edited since; reject the proposal and revise again')
    }
    next = text.slice(0, range.start) + proposal.after + text.slice(range.end)
  }
  await project.saveChapterText(proposal.chapterId, next, { reason: 'before-revise' })
  const updated = (await project.setProposalStatus(id, 'accepted'))!
  scheduleDigest(core, runtime, proposal.chapterId, task)
  // The chapter's plan follows what was accepted — also where chapters are not digested by themselves.
  schedulePlanFollow(core, runtime, proposal.chapterId, task)
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

/**
 * The proposals the author settled, the latest first — what was turned down above all: it is kept so that it can be
 * read again and, where the no was a slip, put back. One that a later proposal took in is not among them: nobody
 * turned it down, and the proposal that stands for it brings it back when that one is turned down.
 * @param options.chapter - only this chapter's.
 * @param options.what - `rejected` (the default) or `accepted`.
 * @returns the proposals, each with whether it could still be taken (`stands`), and how many there are in all.
 */
export async function settledProposals(runtime: ProjectRuntime, options: { chapter?: string; what?: 'rejected' | 'accepted'; limit?: number } = {}): Promise<{ items: SettledProposal[]; total: number }> {
  const { project } = runtime
  const what = options.what ?? 'rejected'
  const chapter = options.chapter !== undefined ? (await project.findChapter(options.chapter))?.plan.id ?? options.chapter : undefined
  const when = (proposal: Proposal): string => proposal.settledAt ?? proposal.createdAt
  const all = (await project.proposals())
    .filter(proposal => proposal.status === what && proposal.supersededBy === undefined && (chapter === undefined || proposal.chapterId === chapter))
    .sort((left, right) => when(right).localeCompare(when(left)))
  const shown = all.slice(0, Math.max(1, options.limit ?? 200))
  const texts = new Map<string, string>()
  const items: SettledProposal[] = []
  for (const proposal of shown) {
    if (!texts.has(proposal.chapterId)) texts.set(proposal.chapterId, await project.chapterText(proposal.chapterId).catch(() => ''))
    const text = texts.get(proposal.chapterId)!
    items.push({ ...proposal, stands: proposal.kind === 'chapter' ? text === proposal.before : locateQuote(text, proposal.before, proposal.at) !== undefined })
  }
  return { items, total: all.length }
}

/**
 * Put a proposal the author turned down back to wait: the no is taken back, and it can be accepted like any other.
 * Where it had been made on top of changes that waited — and they wait again since it was turned down — it stands for
 * them once more.
 * @throws ProjectError `novel/not-found`; `novel/invalid` where it was not turned down by the author.
 */
export async function restoreProposal(runtime: ProjectRuntime, id: string): Promise<Proposal> {
  const { project } = runtime
  const proposal = (await project.proposals()).find(item => item.id === id)
  if (proposal === undefined) throw new ProjectError('novel/not-found', `no proposal "${id}"`)
  if (proposal.status !== 'rejected') throw new ProjectError('novel/invalid', `proposal "${id}" is ${proposal.status}, not turned down — there is nothing to put back`)
  if (proposal.supersededBy !== undefined) throw new ProjectError('novel/invalid', `proposal "${id}" was taken into a later one (${proposal.supersededBy}) and is settled by that one`)
  const back = (await project.setProposalStatus(id, 'pending'))!
  for (const earlier of proposal.supersedes ?? []) await project.supersedeProposal(earlier, id)
  return back
}

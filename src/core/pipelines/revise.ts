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
import { isPictureLine, keptPictures } from '../../shared/embedded'
import { autoOf, CHAPTER_CONTEXT_DEFAULT, PASSAGE_CONTEXT_DEFAULT, MAIN_LINE, writingOf, type AutoSaid, type IssueEvidence, type MaterialUsed, type MendBy, type MendReach, type ChapterReview, type FiguresKept, type IssueSeverity, type IssueType, type PictureGuide, type PicturesRead, type Proposal, type ReviewIssue, type SettledProposal, type WritingSaid } from '../../shared/types'
import { changedCore, clip, clipTail, countWords, fuzzyFind, hashText, newId, occurrences } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asRecord, asText } from '../llm'
import { assign, crewPlan } from '../crew'
import type { LocatedChapter } from '../project'
import { ProjectError } from '../project'
import { architectSystem, mendTask, reviseChapterSystem, reviseChapterTask, reviseSpanSystem, reviseSpanTask } from '../prompts'
import { L, promptLanguage, renderStyle, styleExtra, withStyleExtra } from '../render'
import { mapLimit } from '../util/async'
import { scheduleDigest } from './digest'
import { schedulePlanFollow } from './follow'
import { scheduleRecheck, settleIssues } from './review'
import { cleanProse } from './write'
import { guidePictures, picturesRead } from './guides'
import { keepMaterial, materialUsed, prepareMaterial } from './material'
import { locateNear, onFile, proposeSpan } from './onfile'
import { bookBase, storyLedger } from './editorial'

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
  /**
   * Who prepares what whoever rewrites the passage is handed. Left out: as the settings say (`materialBy`) — the
   * planner looks first. A place the planner itself settled, and said how to change, is rewritten by what the rules
   * pack (`rules`): it was looked at already. `place`: nothing is packed — the passage, what stands around it in
   * its chapter, and what whoever handed it over wrote into the instruction (what to hold to, and from where) are
   * all the writer is given: a place settled by somebody who read for it needs no second gathering of the book.
   */
  material?: 'planner' | 'rules' | 'place'
  /** Whose words `written` is, where it is not the planner's: the reviewer's, who mended what it found itself. */
  writtenBy?: 'analyst'
}

/**
 * Whether a mending goes through — every place, what changes with each, as much of a place as has to move — or keeps
 * to the least change: asked for outright, else as the book has it, else as the settings say (`mendReach`: through
 * unless the author set `careful`).
 * @param book - the book that is mended, for what it has of its own (`ProjectManifest.mendReach`).
 */
export function mendsBold(core: NovelCore, explicit?: MendReach, book?: WritingSaid): boolean {
  return (explicit ?? writingOf(core.currentSettings(), book).mendReach) !== 'careful'
}

/** Above this share of a chapter a place widened around a quote is no place any more: the quote stays as it was. */
const WIDE_MOST = 0.5
/** A paragraph shorter than this takes its neighbours with it when a quoted place is widened. */
const WIDE_SHORT = 160

/**
 * The stretch that may change with a quoted place when its mending is to go through: the paragraph (or paragraphs) the
 * quote stands in, and — where that is short, a line of talk — the paragraph before and the one after too. Never
 * across a picture's line, never the bare breaks around it, and never the greater part of the chapter (then the quote
 * stays as it was).
 */
export function widenedPlace(text: string, range: { start: number; end: number }): { start: number; end: number } {
  const lineStart = (at: number): number => text.lastIndexOf('\n', at - 1) + 1
  const lineEnd = (at: number): number => { const next = text.indexOf('\n', at); return next < 0 ? text.length : next }
  let start = lineStart(range.start)
  let end = lineEnd(range.end)
  if (end - start < WIDE_SHORT) {
    // The paragraph before: the nearest line above that has words, unless a picture stands between.
    let above = start
    while (above > 0) {
      const from = lineStart(above - 1)
      const line = text.slice(from, above - 1)
      above = from
      if (line.trim().length === 0) continue
      if (!isPictureLine(line)) start = from
      break
    }
    let below = end
    while (below < text.length) {
      const to = lineEnd(below + 1)
      const line = text.slice(below + 1, to)
      below = to
      if (line.trim().length === 0) continue
      if (!isPictureLine(line)) end = to
      break
    }
  }
  if (end - start > text.length * WIDE_MOST) return range
  return { start, end }
}

/**
 * Who writes the words of a change made by places — asked for outright, else as the book has it, else as the
 * settings say (`mendBy`): the planner telling place by place (`auto`, where nothing is set), the planner always, or
 * the writer always.
 * @param explicit - said for this piece of work: a way, or — the older spelling — `true` for the planner's own
 * words and `false` for the writer's.
 * @param book - the book that is mended, for what it has of its own (`ProjectManifest.mendBy`).
 */
export function mendsBy(core: NovelCore, explicit?: MendBy | boolean, book?: WritingSaid): MendBy {
  if (explicit === true) return 'planner'
  if (explicit === false) return 'writer'
  return explicit ?? writingOf(core.currentSettings(), book).mendBy
}

/**
 * Whose model rewrites a passage the author selected, or a chapter written over whole — said outright, else as the
 * book has it, else as the settings say (`rewriteBy`: the writer's unless the author set the planner's).
 * @param book - the book it is of, for what it has of its own (`ProjectManifest.rewriteBy`).
 */
export function rewritesBy(core: NovelCore, explicit?: 'writer' | 'planner', book?: WritingSaid): 'writer' | 'planner' {
  return explicit ?? writingOf(core.currentSettings(), book).rewriteBy
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
  /** Who prepares what whoever writes it over is handed; see `ReviseSpanParams.material`. */
  material?: 'planner' | 'rules'
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
  /** What whoever wrote it was handed, and who put it together; absent where nobody was asked to write (`written`). */
  material?: MaterialUsed
  /** The very change already waited for this passage: nothing new was proposed (`proposalId` is the one that waits). */
  same?: true
  /** How many waiting changes of the same passage this one took the place of. */
  replaced?: number
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
export const locateQuote = locateNear

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
  let material: MaterialUsed | undefined
  // Whose words they are: whoever settled the place wrote them, else the model the settings (or the caller) name.
  const who: 'writer' | 'planner' = params.written !== undefined ? 'planner' : rewritesBy(core, params.by, manifest)
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
    // A passage is rewritten with what bears on it — not with the book: handed every chapter before and after word
    // for word (as a chapter's writing once was), the one line that says what to change was a few words at the end of
    // hundreds of thousands, and what came back was the passage hardly touched. What bears on it the planner settles,
    // having looked — whose cards, which of the world, the lines elsewhere it has to agree with, what is asked and
    // what must hold; where it is not asked, the rules pack the bible, the people and the story around the chapter.
    const base = { lang, language: manifest.language, title: manifest.title }
    let context: string
    if (params.material === 'place') {
      // Handed over by somebody who read for it: what the place is to say and what it has to hold to are in the
      // instruction, and the passage's surroundings follow below. Nothing of the book is gathered a second time.
      context = L(lang,
        `这是第 ${chapter.index} 章《${chapter.plan.title}》里的一处。交办的人已经查过设定和前文：这一处要写成什么样、要守住哪些事实，都写在下面的修改要求里——照它写，不添要求和原文里没有的名字、年份、来历。`,
        `A place in chapter ${chapter.index}, "${chapter.plan.title}". Whoever handed it over has looked in the bible and the earlier text: what the place is to say and the facts to hold to are in the instruction below — write by it, and bring in no name, year or origin that neither it nor the text has.`)
    } else {
      const limit = (await core.settingsOf(runtime)).context.passageTokens ?? PASSAGE_CONTEXT_DEFAULT
      const prepared = await prepareMaterial(core, runtime, { work: 'passage', chapter, instruction: params.instruction, text, range, budget: limit, ...(params.material !== undefined ? { by: params.material } : {}) }, task)
      // (The planner may want the passage's whole chapter before the writer's eyes: it goes as the work has it.)
      const whole = prepared.chosen?.chapters.includes(chapter.plan.id) === true
      const pack = await core.pack(runtime, route, {
        purpose: 'revise',
        chapter,
        brief: params.instruction,
        focus: text.slice(range.start, range.end),
        ...(prepared.chosen !== undefined ? { chosen: prepared.chosen, ...(whole ? { includeChapterText: true, chapterText: text } : {}) } : { limit }),
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
      })
      material = materialUsed(prepared, pack)
      task.job?.result({ chapterId: chapter.plan.id, material })
      context = pack.text
    }
    const prompt = reviseSpanTask({
      ...base,
      context: `${context}${guided !== undefined ? `\n\n${guided.text}` : ''}`,
      before: clipTail(text.slice(0, range.start), 4000),
      passage: text.slice(range.start, range.end),
      after: clip(text.slice(range.end), 2000),
      instruction: params.instruction,
    })
    // (Kept where the author asked for this rewriting themselves: a place of a mending is one of many, and not theirs to read by itself.)
    if (params.batchId === undefined && material !== undefined) await keepMaterial(runtime, { ...material, chapter: chapter.plan.id, work: 'passage', instruction: params.instruction, text: prompt }).catch((error: unknown) => { core.log(`could not keep the material of ${chapter.plan.id}`, error) })
    const response = await core.llm.complete({
      route,
      system: await (async () => { const style = await project.activeStyle(); return withStyleExtra(reviseSpanSystem({ ...base, style: renderStyle(style, lang) }), style, lang) })(),
      ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
      prompt,
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
    ...(material !== undefined ? { material } : {}),
  }
  const read = { ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}), ...figures }
  if (apply) {
    await project.saveChapterText(chapter.plan.id, text.slice(0, range.start) + after + text.slice(range.end), { reason: 'before-revise' })
    // (Made for issues and applied outright, as a change accepted is: they are settled by it.)
    if (params.issues !== undefined && params.issues.length > 0) await settleIssues(runtime, params.issues, L(lang, '按修订改了', 'mended by a revision'))
    await scheduleDigest(core, runtime, chapter.plan.id, task)
  } else if (based.used.length === 0 || (based.used.every(proposal => proposal.kind === 'span') && found.text.includes(shown.before))) {
    // A change of its own — also when it was written knowing the ones that wait: the passage is as the book has it,
    // and none of them rewrites the chapter, so each is accepted or turned down by itself. One place, one change
    // that waits: the same words again are no new proposal, other words take the earlier one's place.
    const proposed = await proposeSpan(runtime, found.text, { chapterId: chapter.plan.id, kind: 'span', instruction: params.instruction, before: shown.before, after: shown.after, at: locateNear(found.text, shown.before, at)?.start ?? at, createdBy: task.origin, wroteBy: params.written !== undefined && params.writtenBy !== undefined ? params.writtenBy : who, ...read, ...(params.why !== undefined ? { rationale: params.why } : {}), ...(params.batchId !== undefined ? { batchId: params.batchId } : {}), ...(params.issues !== undefined && params.issues.length > 0 ? { issues: params.issues } : {}) }, lang)
    result.proposalId = proposed.proposal.id
    if (proposed.same === true) result.same = true
    if (proposed.replaced > 0) result.replaced = proposed.replaced
  } else {
    // The passage is one a waiting change made, or stands in a chapter rewritten whole: one proposal for the chapter
    // with all of them and this one in.
    const taken = await takenIn(runtime, based.used, params.issues, lang)
    const proposal = await project.addProposal({ chapterId: chapter.plan.id, kind: 'chapter', instruction: params.instruction, before: found.text, after: text.slice(0, range.start) + after + text.slice(range.end), createdBy: task.origin, wroteBy: who, ...read, ...(params.batchId !== undefined ? { batchId: params.batchId } : {}), ...taken.carried })
    await settleTakenIn(runtime, taken.settle, proposal.id)
    result.proposalId = proposal.id
  }
  task.job?.result({ chapterId: chapter.plan.id, ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}) })
  return result
}

/** How much goes with a chapter that is revised, beside the chapter itself (`context.chapterTokens`). */
export async function chapterContext(core: NovelCore, runtime: ProjectRuntime): Promise<number> {
  return (await core.settingsOf(runtime)).context.chapterTokens ?? CHAPTER_CONTEXT_DEFAULT
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
  const who = rewritesBy(core, params.by, manifest)
  const route = await core.route(who === 'planner' ? 'architect' : 'writer', runtime, task)
  // Rewritten whole, the chapter still goes by the pictures the author gave it — or by the ones given to this revision.
  const guided = await guidePictures(core, runtime, route, params.guides ?? chapter.plan.guides, 'revise', task)
  // A chapter written over to an instruction is not the book written on: it goes with what the planner, having
  // looked, finds it needs — or, where the planner is not asked, with the chapters next to it and what of the bible
  // it touches. Never with half the model's window of everything before, in which the instruction is one line among
  // hundreds of thousands.
  const limit = await chapterContext(core, runtime)
  const prepared = await prepareMaterial(core, runtime, { work: 'chapter', chapter, instruction: params.instruction, text: based.text, ...(chapter.plan.referenceNotes !== undefined ? { notes: chapter.plan.referenceNotes } : {}), budget: limit, ...(params.material !== undefined ? { by: params.material } : {}) }, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'revise',
    chapter,
    brief: params.instruction,
    includeChapterText: true,
    ...(prepared.chosen !== undefined ? { chosen: prepared.chosen } : { limit }),
    ...(based.used.length > 0 ? { chapterText: based.text } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const material = materialUsed(prepared, pack)
  task.job?.result({ chapterId: chapter.plan.id, material })
  const base = { lang, language: manifest.language, title: manifest.title }
  const words = countWords(based.text)
  const prompt = reviseChapterTask({ ...base, context: `${pack.text}${guided !== undefined ? `\n\n${guided.text}` : ''}`, instruction: params.instruction })
  if (params.batchId === undefined) await keepMaterial(runtime, { ...material, chapter: chapter.plan.id, work: 'chapter', instruction: params.instruction, text: prompt }).catch((error: unknown) => { core.log(`could not keep the material of ${chapter.plan.id}`, error) })
  const response = await core.llm.complete({
    route,
    system: await (async () => { const style = await project.activeStyle(); return withStyleExtra(reviseChapterSystem({ ...base, style: renderStyle(style, lang) }), style, lang) })(),
    ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
    prompt,
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
    material,
  }
  if (apply) {
    await project.saveChapterText(chapter.plan.id, after, { reason: 'before-revise', status: chapter.plan.status === 'final' ? 'final' : 'revised' })
    // (Made for issues and applied outright, as a change accepted is: they are settled by it.)
    if (params.issues !== undefined && params.issues.length > 0) await settleIssues(runtime, params.issues, L(lang, '按修订改了', 'mended by a revision'))
    await scheduleDigest(core, runtime, chapter.plan.id, task)
  } else {
    const taken = await takenIn(runtime, based.used, params.issues, lang)
    const proposal = await project.addProposal({
      chapterId: chapter.plan.id,
      kind: 'chapter',
      instruction: params.instruction,
      before: text,
      after,
      createdBy: task.origin,
      wroteBy: who,
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
  /** How far it reaches. Left out: as the settings say (`mendReach`). */
  reach?: MendReach
  /**
   * The planner writes what each place is to read, and that is what is proposed: the writer's model is not asked for
   * the places. Left out: as the settings say (`mendBy`). (Whose model writes over a chapter that places will not do
   * for is another setting: `rewriteBy`.)
   */
  direct?: boolean
  /** Who writes the words of the places, said for this once (`mendBy`): comes before `direct`. */
  by?: MendBy
  /**
   * Settled in one request, from what is given: the planner is handed the chapters' text and reads nothing more. For
   * a mending that is small by its nature — one issue, at the place it quotes — where an agent's steps, each sending
   * the whole of the task again, would cost more than what is mended.
   */
  plain?: boolean
  /**
   * What the author said, where `instruction` holds more than that (a lead with the passage they pointed at): what
   * the issues filed and the changes proposed are said to be for.
   */
  said?: string
  /**
   * What is given in `instruction` is what the author said of the book, in a sentence, and the planner tells which of
   * two things it is. Something they noticed that is wrong: the planner says first where it shows — each place
   * quoted, and filed as an issue of that chapter's review, marked as the author's own (`ReviewIssue.lead`) — and
   * then, with `fix`, names the places that mend it, whose changes are shown beneath those issues. A change they
   * want made: nothing is filed, and the places it reaches are named — the changes wait as a round of proposals.
   * `find`: nothing changed either way — what is wrong, or what the change would reach, is filed.
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
  results: (Pick<ReviseResult, 'chapterId' | 'title' | 'index' | 'applied' | 'proposalId' | 'wordsBefore' | 'wordsAfter' | 'figures' | 'who'> & { reason: string; kind: 'span' | 'chapter' })[]
  failed: { chapterId: string; error: string }[]
  /** Where pictures were given: how many, and who looked at them — the planner that scoped it, or the writer where the chapters were named. */
  pictures?: PicturesRead
  /** Where the author's lead was followed (`ReviseBookParams.lead`): the places it shows, each now an issue of its chapter's review. */
  found?: FiledFinding[]
  /** The planner wrote the changed words itself (`ReviseBookParams.direct`): every place its own. */
  direct?: true
  /**
   * Whose words the changes are, counted: the planner's own (small changes, where it tells place by place — or all of
   * them, where it writes every place) and the writer's model's (places where a passage was to be written, chapters
   * written over by it).
   */
  wrote?: { planner: number; writer: number }
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
  const own = await project.manifest()
  // Whose words the places are: the planner's, the writer's — or told place by place by the planner, which writes a
  // small change itself and hands a place where a passage is to be written to the writer's model.
  const by = mendsBy(core, params.by ?? params.direct, own)
  const direct = lead !== 'find' && by === 'planner'
  const mixed = lead !== 'find' && by === 'auto'
  const bold = mendsBold(core, params.reach, own)
  task.job?.progress(0, 1, lead === 'find' ? L(lang, '照你说的去查', 'looking into what you said') : lead === 'fix' ? L(lang, '照你说的去查，再定在哪几处改', 'looking into what you said, then settling which places change') : L(lang, '定在哪几处改', 'settling which places change'))
  // The planner quotes the text: each chapter as this revision finds it — with what waits laid in, where it goes on
  // from that. (Such a chapter is what its reading tool shows it too: what it copies is what it is checked against.)
  const stands = new Map<string, string>()
  const laidIn = new Map<string, string>()
  for (const info of infos) {
    const own = await project.chapterText(info.id)
    stands.set(info.id, params.onto === true ? (await onPending(runtime, info.id, own)).text : own)
    if (stands.get(info.id) !== own) laidIn.set(info.id, stands.get(info.id)!)
  }
  // The planner scopes the revision with the pictures it goes by in sight (or in words).
  const route = await core.route('architect', runtime, task)
  const guided = await guidePictures(core, runtime, route, params.guides, 'revise', task)
  pictures = picturesRead(guided)
  const reads = params.plain !== true && crewPlan(core, 'architect', manifest).mode !== 'call' && core.roles !== undefined && core.roles.can(route)
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
  const asked = params.asked === true
  // What every pass of this book starts from: its base — what it is, how it is written and what the author added
  // for whoever writes it, everybody and everything by name, the outline — and the story so far, a summary a
  // chapter. The same for every revision of the book, whatever is asked this time: said before anything else.
  const base = await bookBase(runtime, lang, along ?? MAIN_LINE)
  const story = `${(await storyLedger(runtime, lang, undefined, along ?? MAIN_LINE)).text}${guided !== undefined ? `\n\n${guided.text}` : ''}`
  // What is on file for the chapters this may change — the changes that wait, what the author turned down, and
  // (for a sentence of the author's, which files what it finds) the issues already open — so that nothing is
  // proposed, or filed, a second time. (For a mending the issues are the task itself.)
  const file = await onFile(runtime, infos.slice(0, 60).map(info => ({ id: info.id, index: info.index, title: info.title })), lang, { issues: lead !== undefined })
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: lead === 'find' ? L(lang, '审校和修订 · 只找出来', 'Review and revision · finding only')
      : lead === 'fix' ? L(lang, '审校和修订 · 照作者说的', 'Review and revision · by what the author said')
        : asked ? L(lang, '全书修订 · 定在哪几处改', 'Book-wide revision · which places change') : L(lang, '修问题 · 定在哪几处改', 'Mending · which places change'),
    line: along ?? MAIN_LINE,
    tool: lead === 'find' ? 'submit_findings' : 'submit_places',
    what: lead === 'find' ? L(lang, '它在哪几处露出来', 'where it shows')
      : direct ? L(lang, '改哪几处、每一处改成什么', 'which places change, and what each of them is to read')
        : mixed ? L(lang, '改哪几处：小改动改成什么，要成段写的各怎么改', 'which places change: what the small ones are to read, and how those that take a passage change')
          : L(lang, '改哪几处、各怎么改', 'which places change, and how each of them does'),
    system: architectSystem(lang),
    ...(params.plain === true ? { plain: true } : {}),
    ...(laidIn.size > 0 ? { texts: laidIn } : {}),
    ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
    prompt: mendTask({ lang, language: manifest.language, title: manifest.title, instruction: params.instruction, book: base, story, ...(file.text.length > 0 ? { onFile: file.text } : {}), ...(params.onto === true && laidIn.size > 0 ? { onto: true } : {}), ...(shown.length > 0 ? { texts: shown.join('\n\n'), ...(shown.length === infos.length ? { allGiven: true } : {}) } : {}), wide: params.narrow !== true, reads, ...(asked ? { asked: true } : {}), ...(named ? { only: infos.map(info => info.index).join(lang === 'zh' ? '、' : ', ') } : {}), ...(params.bible === true ? { bible: true } : {}), ...(lead !== undefined ? { lead } : {}), ...(direct ? { direct: true, styled: true } : mixed ? { mixed: true, styled: true } : {}), ...(bold ? { bold: true } : {}) }),
    temperature: 0.2,
    // What is quoted is looked for in the text at once: a place that is not there, or that is there twice, is sent
    // back to be quoted as it stands.
    validate: (raw) => {
      const record = asRecord(raw)
      const wrong: string[] = []
      if (lead !== undefined) findings = findingsIn(record, infos, stands, lang, wrong)
      places = lead === 'find' ? [] : placesIn(record, infos, stands, lang, direct ? 'planner' : mixed ? 'auto' : 'writer', wrong)
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
      // (The planner that named this chapter looked at it: nobody looks again before it is written over.)
      const result = await reviseChapter(core, runtime, { chapter: target.id, instruction, apply, batchId, material: 'rules', ...(params.onto === true ? { onto: true } : {}), ...(issues !== undefined ? { issues } : {}), ...(params.guides !== undefined && params.guides.length > 0 ? { guides: params.guides } : {}) }, inner())
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
        ...(result.who !== undefined ? { who: result.who } : {}),
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
        const instruction = `${told}\n\n${L(lang, '这一次只改下面这一处：能动的只有这一处里的字，它前后的正文不会变。策划定的改法', 'This time only the passage below changes: nothing outside it will, so it has to join what stands on both sides. What the planner settled for it')}${colon}${place.how}\n${bold
          ? L(lang, '照这个改法把这一处改到位：这一处里为了通顺、站得住而要跟着动的字句可以改，要补的写够——只用设定和前文已经有的事实，原文交代过的信息不丢；用不着动的照原样交回，和改法无关的不借机改。', 'Carry it through at this place: words of it that have to move for the change to read well and hold may change, and what has to be added is written in full — out of what the bible and the text so far already hold, with nothing the text told lost; what need not change goes back as it stands, and nothing that has no part in it is changed under cover of it.')
          : L(lang, '改法没有提到的字句照原样交回，不顺手润色，不添改法之外的内容。', 'Hand back as they stand the words this does not speak of: no polishing in passing, nothing added beyond it.')}`
        const issues = issuesFor(place.id, place)
        // (Written by the planner: the place is what it handed in, and what the proposal says it is for is the mending itself.)
        // (The planner read for this place and said what it has to hold to: the writer is handed the place, what
        // stands around it, and that — nothing of the book is gathered for it again.)
        const result = await reviseSpan(core, runtime, { chapter: place.id, quote: place.quote, start: place.start, instruction: place.written !== undefined ? told : instruction, apply, batchId, tight: true, material: 'place', ...(place.written !== undefined ? { written: place.written, why: place.how } : { by: 'writer' as const }), ...(params.onto === true ? { onto: true } : {}), ...(issues !== undefined ? { issues } : {}), ...(params.guides !== undefined && params.guides.length > 0 ? { guides: params.guides } : {}) }, inner())
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
          ...(result.who !== undefined ? { who: result.who } : {}),
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
  // Whose words they are, counted: said with what the revision came to — nothing is written by a model nobody named.
  const wrote = { planner: results.filter(result => result.who === 'planner').length, writer: results.filter(result => result.who === 'writer').length }
  return { batchId, ...(note !== undefined ? { note } : {}), untouched: infos.length - touched.size, ...(bible.length > 0 ? { bible } : {}), results, failed, ...(pictures !== undefined ? { pictures } : {}), ...(lead !== undefined ? { found: filed } : {}), ...(direct ? { direct: true as const } : {}), ...(results.length > 0 ? { wrote } : {}) }
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
function placesIn(record: Record<string, unknown>, infos: readonly { id: string; index: number; title: string }[], stands: ReadonlyMap<string, string>, lang: 'zh' | 'en', by: MendBy = 'writer', faults?: string[]): Place[] {
  const direct = by === 'planner'
  const wrong: string[] = faults ?? []
  const places: Place[] = []
  asArray(record.edits).forEach((entry, at) => {
    const item = asRecord(entry)
    const nth = at + 1
    const index = Number(item.chapter ?? item.index)
    const info = infos.find(candidate => candidate.index === index)
    const find = asText(item.find)
    // Written by the planner itself: what the place is to read (an empty text takes it out), and a word on why.
    // Where it tells place by place, a place it wrote is one that has a `replace`; one with only a `how` is the writer's.
    const written = by !== 'writer' && typeof item.replace === 'string' ? item.replace : undefined
    const how = written !== undefined || direct ? asText(item.why) ?? asText(item.how) ?? L(lang, '策划改的', 'changed by the planner') : asText(item.how)
    if (info === undefined) {
      wrong.push(L(lang, `edits 第 ${nth} 条：第 ${String(item.chapter ?? item.index)} 章不在这次能改的章节里（没有这一章，它还没有正文，或者作者没让动它）`, `edits[${nth}]: chapter ${String(item.chapter ?? item.index)} is not among the chapters this may change (no such chapter, no text yet, or not one the author named)`))
      return
    }
    if (direct && (find === undefined || [...find].length < 2 || written === undefined)) {
      wrong.push(L(lang, `edits 第 ${nth} 条：find（要换掉的原文）和 replace（这一处改好之后的全文；整句删掉给空字符串）都要写`, `edits[${nth}]: both find (the text replaced) and replace (the whole of the place as it is to read; an empty string where it goes) are needed`))
      return
    }
    if (by === 'auto' && (find === undefined || [...find].length < 2 || (written === undefined && how === undefined))) {
      wrong.push(L(lang, `edits 第 ${nth} 条：find（这一处的原文）要写，再给 replace（小改动：你直接写出这一处改好之后的全文）或 how（要成段新写的：说清改成什么样，交给写手）当中的一个`, `edits[${nth}]: find (the text of the place) is needed, with one of replace (a small change: the whole of the place as it is to read, written by you) and how (a passage to be written: what it is to say instead, for the writer)`))
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
  /** How far it reaches. Left out: as the settings say (`mendReach`). */
  reach?: MendReach
  /** Mend it anew, whatever the review that found it said of how it is closed (`ReviewIssue.fix`): somebody settles it again. */
  anew?: boolean
}

export interface FixIssueResult {
  /** How it was mended: the quoted `passage` rewritten; `places` the planner chose; the `chapter` written over; or traced through the `book`. */
  scope: 'passage' | 'places' | 'chapter' | 'book'
  passage?: ReviseResult
  book?: ReviseBookResult
  /** It was closed as the review that found it said (`ReviewIssue.fix`): its own change proposed as it stands, or its passage written by the writer. */
  closed?: ClosedIssues
}

/** Where what an issue rests on stands, in a few words (`ReviewIssue.against`). */
export function evidenceSaid(lang: 'zh' | 'en', against: IssueEvidence | undefined): string | undefined {
  if (against === undefined) return undefined
  const number = against.ref?.replace(/[^\d]/g, '')
  const where = against.kind === 'chapter' ? L(lang, `第 ${number !== undefined && number.length > 0 ? number : against.ref ?? '?'} 章`, `chapter ${number !== undefined && number.length > 0 ? number : against.ref ?? '?'}`)
    : against.kind === 'here' ? L(lang, '本章另一处', 'elsewhere in this chapter')
      : against.kind === 'character' ? L(lang, `人物卡“${against.ref ?? ''}”`, `the card "${against.ref ?? ''}"`)
        : against.kind === 'world' ? L(lang, `设定“${against.ref ?? ''}”`, `the entry "${against.ref ?? ''}"`)
          : against.kind === 'plan' ? L(lang, '本章章纲', 'this chapter\'s plan')
            : against.kind === 'style' ? L(lang, '设定的文风', 'the style set')
              : L(lang, `参考文献${against.ref !== undefined ? `《${against.ref}》` : ''}`, `the reference${against.ref !== undefined ? ` "${against.ref}"` : ''}`)
  return L(lang, `${where}：“${against.quote}”`, `${where}: "${against.quote}"`)
}

const ISSUE_TYPE_ZH: Record<string, string> = { continuity: '连贯', character: '人物', world: '世界观', timeline: '时间线', style: '文风', pacing: '节奏', logic: '逻辑', language: '语言' }
const SEVERITY_ZH: Record<string, string> = { high: '严重', medium: '中等', low: '轻微', critical: '严重', major: '重要', minor: '轻微' }

/** What a review found, as an instruction to whoever mends it. */
export function issueInstruction(lang: 'zh' | 'en', chapter: { index: number; title: string }, issue: { type: string; severity: string; quote?: string; explanation: string; suggestion?: string; against?: IssueEvidence }, note: string | undefined, wide: boolean, bold = false): string {
  const said = note !== undefined && note.trim().length > 0 ? note.trim() : undefined
  const rests = evidenceSaid(lang, issue.against)
  return lang === 'zh'
    ? [
        `审校在第 ${chapter.index} 章《${chapter.title}》发现一个问题（${ISSUE_TYPE_ZH[issue.type] ?? issue.type}，${SEVERITY_ZH[issue.severity] ?? issue.severity}）：${issue.explanation}`,
        issue.quote !== undefined ? `原文："${issue.quote}"` : undefined,
        rests !== undefined ? `它对不上的是（已核对过原处）：${rests}` : undefined,
        issue.suggestion !== undefined ? `审校的建议：${issue.suggestion}` : undefined,
        said !== undefined ? `作者对怎么改的要求（以此为准）：${said}` : undefined,
        wide ? `请把这个问题在全书里的影响查清楚：除了第 ${chapter.index} 章本身，还有哪些章节写到了与它相关的事实、因果或人物表现，需要一起改才能前后一致；与此无关的内容保持原样。` : bold ? '把这个问题改到位：它牵动的呼应、反应和衔接一并改；与它无关的内容保持原样。' : '修正这个问题，别的不要动。',
      ].filter(Boolean).join('\n')
    : [
        `A review found a problem in chapter ${chapter.index}, "${chapter.title}" (${issue.type}, ${issue.severity}): ${issue.explanation}`,
        issue.quote !== undefined ? `The text: "${issue.quote}"` : undefined,
        rests !== undefined ? `What it is at odds with (looked for there): ${rests}` : undefined,
        issue.suggestion !== undefined ? `The review suggests: ${issue.suggestion}` : undefined,
        said !== undefined ? `What the author wants done about it (this decides): ${said}` : undefined,
        wide ? `Trace this problem through the whole book: besides chapter ${chapter.index} itself, which chapters state facts, causes or behaviour that depend on it and have to change with it for the book to agree with itself; leave everything else as it is.` : bold ? 'Mend this problem through: what answers to it, echoes it or joins on it changes with it; leave what has nothing to do with it as it is.' : 'Mend this problem and change nothing else.',
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
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const where = { index: chapter.index, title: chapter.plan.title }
  const bold = mendsBold(core, params.reach, manifest)
  const reach = { reach: bold ? 'bold' as const : 'careful' as const }
  // The review that found it said how it is closed, and nothing was done with that yet: that is what mending it
  // here comes to — its change proposed as it stands, or its passage written by the writer — unless the author wrote
  // how they want it mended, or asks for it to be settled anew. (Where the chapter no longer has the place as the
  // review found it, it is settled as any other issue is.)
  if ((params.scope === 'passage' || params.scope === 'place') && params.anew !== true && issue.fix !== undefined && issue.mending === undefined && issue.resolved !== true && (params.note === undefined || params.note.trim().length === 0)) {
    const closed = await closeIssues(core, runtime, [{ chapter: chapter.plan.id, issue: issue.id }], task)
    if (closed.issues > 0) return { scope: 'passage', closed }
  }
  if (params.scope === 'book') {
    const book = await reviseBook(core, runtime, { instruction: issueInstruction(lang, where, issue, params.note, true), bible: true, ...reach, texts: [chapter.plan.id], ...(chapter.line !== undefined ? { line: chapter.line } : {}), ...(params.onto === true ? { onto: true } : {}), issuesOf: chapterId => (chapterId === chapter.plan.id ? [issue.id] : []) }, task)
    // Handed over: the issue says with which batch of proposals, and they are shown beneath it.
    const current = await project.review(chapter.plan.id)
    if (current !== undefined) await project.saveReview({ ...current, issues: current.issues.map(item => item.id === issue.id ? { ...item, mending: book.batchId } : item) })
    return { scope: 'book', book }
  }
  const instruction = issueInstruction(lang, where, issue, params.note, false, bold)
  const onto = params.onto === true ? { onto: true } : {}
  // (Going on from what waits, the quote is looked for in the chapter as it would stand with that in.)
  const text = params.onto === true ? (await onPending(runtime, chapter.plan.id, await project.chapterText(chapter.plan.id))).text : await project.chapterText(chapter.plan.id)
  const range = issue.quote !== undefined && params.scope !== 'place' ? fuzzyFind(text, issue.quote.trim()) : undefined
  // Written over whole only when that is what was asked for.
  if (params.scope === 'chapter') return { scope: 'chapter', passage: await reviseChapter(core, runtime, { chapter: chapter.plan.id, instruction, issues: [issue.id], ...onto }, task) }
  // A problem that quotes nothing — a contradiction, a missing word of explanation, a beat that comes too soon — or
  // whose quote has since been rewritten can mostly be taken hold of in more than one place, and one is enough: the
  // planner settles which, and the writer rewrites that place. Nothing is written over for it.
  const by = mendsBy(core, undefined, manifest)
  // Where the planner tells place by place, an issue mended at its quote goes to it too — with this chapter before it
  // and nothing else to change: a word put right it writes itself, and only a passage to be written reaches the
  // writer's model. (Mended at the quote outright, the place would be rewritten by one model or the other unasked.)
  // In one request: the review that found it said what is wrong and where, and an agent's steps would each send the
  // chapter again for a change of a few words.
  const told = range !== undefined && by === 'auto'
  if (range === undefined || told) {
    const book = await reviseBook(core, runtime, { instruction, narrow: true, ...reach, ...(told ? { chapters: [chapter.plan.id], plain: true } : {}), texts: [chapter.plan.id], mends: [issue.id], ...(chapter.line !== undefined ? { line: chapter.line } : {}), ...onto }, task)
    const current = await project.review(chapter.plan.id)
    if (current !== undefined) await project.saveReview({ ...current, issues: current.issues.map(item => item.id === issue.id ? { ...item, mending: book.batchId } : item) })
    return { scope: 'places', book }
  }
  // Mended through, the quote is where the problem shows and the paragraph around it is what may change: what did
  // not change is left out of the proposal afterwards (`tight`).
  const wide = bold ? widenedPlace(text, range) : range
  const quoted = text.slice(range.start, range.end)
  const said = wide.start === range.start && wide.end === range.end
    ? instruction
    : `${instruction}\n\n${L(lang,
      `问题露在“${clip(quoted, 120)}”这里。交给你的是它所在的这一段：在这一段里把问题改到位——为了通顺、站得住，这一段里别的句子可以跟着动，要补的写够（只用设定和前文已经有的事实，原文交代过的信息不丢）；用不着动的句子原样交回。`,
      `It shows at "${clip(quoted, 160)}". What you are handed is the passage it stands in: mend it through within that passage — other sentences of it may move for the change to read well and hold, and what has to be added is written in full (out of what the bible and the text so far already hold, with nothing the text told lost); sentences that need no change go back as they stand.`)}`
  // (Where the author has the crew's model make such changes, the quoted place is rewritten by it. The review that
  // found the issue looked at the chapter and said what is wrong and what to do: nobody prepares material again.)
  return { scope: 'passage', passage: await reviseSpan(core, runtime, { chapter: chapter.plan.id, start: wide.start, end: wide.end, quote: text.slice(wide.start, wide.end), instruction: said, issues: [issue.id], tight: true, material: 'rules', ...onto, by: by === 'writer' ? 'writer' as const : 'planner' as const }, task) }
}

export interface LeadReviewParams {
  /** What the author says of the book, in their words: something they noticed that is wrong, or a change they want made — the planner tells which. */
  lead: string
  /** Pictures it goes by: the planner looks into it with them, and each place is changed by them. */
  guides?: PictureGuide[]
  /** Only these chapters are looked at, and nothing outside them changes. */
  chapters?: string[]
  /** The line of the plot looked at, by id, when it is not the main one. */
  line?: string
  /** `false`: found and filed as issues, nothing changed. Default: carried out — a fault found, filed and mended, each change a proposal beneath its issue; a request made through the places it reaches, the changes a round of proposals. */
  fix?: boolean
  /**
   * The passage the author pointed at when they said it, quoted from the (one) chapter named in `chapters` — "this
   * is wrong here": the planner is told where the author saw it, and looks there first.
   */
  passage?: string
  /** The planner writes the changed words itself. Left out: as the settings say (`mendBy`). */
  direct?: boolean
  /** Who writes the changed words, for this once (`mendBy`): comes before `direct`. */
  by?: MendBy
  /** How far the mending reaches. Left out: as the settings say (`mendReach`). */
  reach?: MendReach
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
 * What the author says of their book, in a sentence, carried out — the one way a word of theirs becomes changes,
 * wherever it is said (the review page, beside a chapter, of a passage). The planner tells what it is. Something
 * they noticed — a pair of glasses that come and go, a day that does not add up: the planner goes into the book for
 * it, says where it shows (each place quoted, and filed as an issue of that chapter's review, marked as the author's
 * own), and mends it by places, each change shown beneath the issue it is for. A change they want — a thing called
 * otherwise, a card that changed and has to show: the places it reaches are named and changed, and wait as a round
 * of proposals; nothing is filed. One run of the planner tells, finds and settles.
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
    ...(params.by !== undefined ? { by: params.by } : {}),
    ...(params.reach !== undefined ? { reach: params.reach } : {}),
    ...(params.guides !== undefined && params.guides.length > 0 ? { guides: params.guides } : {}),
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
  /** How far the mending reaches. Left out: as the settings say (`mendReach`). */
  reach?: MendReach
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
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  found.sort((left, right) => left.chapter.index - right.chapter.index)
  const said = params.note?.trim() ?? ''
  const bold = mendsBold(core, params.reach, manifest)
  /** One issue, as whoever mends it reads it. */
  const told = (item: Found, at: number): string => lang === 'zh'
    ? [
        `${at + 1}. （${ISSUE_TYPE_ZH[item.issue.type] ?? item.issue.type}，${SEVERITY_ZH[item.issue.severity] ?? item.issue.severity}）${item.issue.explanation}`,
        item.issue.quote !== undefined ? `   原文："${item.issue.quote}"` : undefined,
        item.issue.against !== undefined ? `   它对不上的是（已核对过原处）：${evidenceSaid(lang, item.issue.against)}` : undefined,
        item.issue.suggestion !== undefined ? `   审校的建议：${item.issue.suggestion}` : undefined,
        item.note !== undefined ? `   作者对怎么改的要求（以此为准）：${item.note}` : undefined,
      ].filter(Boolean).join('\n')
    : [
        `${at + 1}. (${item.issue.type}, ${item.issue.severity}) ${item.issue.explanation}`,
        item.issue.quote !== undefined ? `   The text: "${item.issue.quote}"` : undefined,
        item.issue.against !== undefined ? `   What it is at odds with (looked for there): ${evidenceSaid(lang, item.issue.against)}` : undefined,
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
  // What goes to the planner whole, to quote from: the chapters the issues were found in — and the chapters they
  // are at odds with, where a review said which (the other end of what does not agree is as likely where it is mended).
  const rested: string[] = []
  for (const item of found) {
    if (item.issue.against?.kind !== 'chapter' || item.issue.against.ref === undefined) continue
    const other = await project.findChapter(item.issue.against.ref.replace(/[^\d]/g, '') || item.issue.against.ref, line !== MAIN_LINE ? line : undefined)
    if (other !== undefined && !byChapter.has(other.plan.id) && !rested.includes(other.plan.id)) rested.push(other.plan.id)
  }
  const book = await reviseBook(core, runtime, {
    instruction,
    bible: true,
    reach: bold ? 'bold' : 'careful',
    texts: [...byChapter.keys(), ...rested],
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
        place === true ? '' : bold
          ? L(lang, '把这些问题改到位——它们牵动的呼应、反应和衔接一并改；和它们无关的地方不动。', 'Mend these through — what answers to them, echoes them or joins on them changes with them; leave what has nothing to do with them.')
          : L(lang, '只改为解决这些问题必须改的地方，别的不要动。', 'Change only what mending these takes; leave the rest as it is.'),
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

/** The title of the job that mends what reviews just found; the Studio's page tells it by this, and says its ending. */
export const MEND_REVIEW_JOB = 'mend review'

/**
 * Whether a review hands what it found on to be mended (`reviewMends`). Unset: yes — a review that only lists what is
 * wrong leaves the author to hand every issue over by hand, where saying one sentence about a chapter already comes
 * back with the changes beneath what was found. Whoever asks for one review may say otherwise for it.
 */
export function reviewMends(core: NovelCore, explicit?: boolean, book?: AutoSaid): boolean {
  return explicit ?? autoOf(core.currentSettings(), book).reviewMends
}

/**
 * What the reviews of these chapters hold that is open and was handed to nobody yet.
 * @param only - `wider`: of them, the ones their review says take a change in another chapter (`ReviewIssue.wider`) —
 *   what is the planner's to trace; `closing`: the ones that say how they are closed in their own chapter (`ReviewIssue.fix`).
 */
export async function unmended(runtime: ProjectRuntime, chapters: readonly string[], only?: 'wider' | 'closing'): Promise<{ chapter: string; issue: string }[]> {
  const found: { chapter: string; issue: string }[] = []
  for (const id of [...new Set(chapters)]) {
    for (const issue of (await runtime.project.review(id))?.issues ?? []) {
      if (issue.resolved === true || issue.mending !== undefined) continue
      if (only === 'wider' && issue.wider !== true) continue
      if (only === 'closing' && issue.fix === undefined) continue
      found.push({ chapter: id, issue: issue.id })
    }
  }
  return found
}

export interface ClosedIssues {
  /** The batch the changes are of: each issue closed says so (`ReviewIssue.mending`). */
  batchId: string
  /** How many issues were closed. */
  issues: number
  chapters: number
  /** Changes the reviewer had written out itself: proposals as they are, nobody asked. */
  own: number
  /** Passages the writer's model wrote, by what the reviewer said of them. */
  writer: number
  /** Places where the very change already waited: nothing new was proposed. */
  same: number
  failed: { chapterId: string; issue: string; error: string }[]
}

/**
 * Close the issues that say how they are closed (`ReviewIssue.fix`) — what a review found and could mend in its own
 * chapter. A small change it wrote out is the proposal as it stands: nobody is asked. A passage it described goes
 * to the writer's model, with the place, what stands around it and what the reviewer said of it — nothing of the
 * book is gathered again. Each waits beneath its issue. What the chapter no longer has as the review found it (the
 * text changed since) is left for a look by somebody: it fails, and says so.
 */
export async function closeIssues(core: NovelCore, runtime: ProjectRuntime, items: readonly { chapter: string; issue: string }[], task: TaskContext): Promise<ClosedIssues> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const bold = mendsBold(core, undefined, manifest)
  const batchId = newId('batch')
  const result: ClosedIssues = { batchId, issues: 0, chapters: 0, own: 0, writer: 0, same: 0, failed: [] }
  const byChapter = new Map<string, string[]>()
  for (const item of items) byChapter.set(item.chapter, [...(byChapter.get(item.chapter) ?? []), item.issue])
  const inner = (): TaskContext => ({ origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) })
  let done = 0
  const total = items.length
  task.job?.progress(0, total, L(lang, '照审校写好的改法出提案', 'proposing what the review wrote out'))
  // Chapters side by side; the places of one chapter one after the other, top to bottom.
  const work = [...byChapter].map(([chapterId, ids]) => async (): Promise<void> => {
    const located = await project.findChapter(chapterId)
    const review = await project.review(chapterId)
    if (located === undefined || review === undefined) return
    const text = await project.chapterText(chapterId)
    const due = review.issues.filter(issue => ids.includes(issue.id) && issue.resolved !== true && issue.mending === undefined && issue.fix !== undefined)
      .map(issue => ({ issue, range: fuzzyFind(text, issue.fix!.find) }))
      .sort((left, right) => (left.range?.start ?? 0) - (right.range?.start ?? 0))
    const closed: string[] = []
    for (const { issue, range } of due) {
      try {
        if (range === undefined) throw new ProjectError('novel/not-found', L(lang, '审校圈的那一处正文已经变了，照原来的改法改不了——在问题上点“修订”让策划重新定', 'the text the review took in has changed since: its change cannot be made as it was written — press Revise on the issue for the planner to settle it anew'))
        const where = { index: located.index, title: located.plan.title }
        const fix = issue.fix!
        const said = issueInstruction(lang, where, issue, issue.note, false, bold)
        const revised = fix.replace !== undefined
          ? await reviseSpan(core, runtime, { chapter: chapterId, quote: text.slice(range.start, range.end), start: range.start, instruction: said, written: fix.replace, writtenBy: 'analyst', why: issue.explanation, issues: [issue.id], batchId, tight: true, material: 'place' }, inner())
          : await reviseSpan(core, runtime, {
              chapter: chapterId, quote: text.slice(range.start, range.end), start: range.start,
              instruction: `${said}\n\n${L(lang, '这一次只改下面这一处：能动的只有这一处里的字，它前后的正文不会变。审校定的改法', 'This time only the passage below changes: nothing outside it will, so it has to join what stands on both sides. What the review settled for it')}${lang === 'zh' ? '：' : ': '}${fix.how ?? ''}`,
              by: 'writer', issues: [issue.id], batchId, tight: true, material: 'place',
            }, inner())
        if (revised.same === true) result.same += 1
        else if (fix.replace !== undefined) result.own += 1
        else result.writer += 1
        closed.push(issue.id)
      } catch (error) {
        if (task.signal?.aborted === true) throw error
        result.failed.push({ chapterId, issue: issue.id, error: error instanceof Error ? error.message : String(error) })
      }
      done += 1
      task.job?.progress(done, total)
    }
    if (closed.length > 0) {
      // Each issue closed says with which batch of proposals, until they are settled.
      const current = await project.review(chapterId)
      if (current !== undefined) await project.saveReview({ ...current, issues: current.issues.map(item => closed.includes(item.id) ? { ...item, mending: batchId } : item) })
      result.issues += closed.length
      result.chapters += 1
    }
  })
  await mapLimit(work, await core.parallelFor('text', runtime), async (run) => { await run() }, task.signal)
  return result
}

/**
 * What reviews just found, handed on to be mended — a job of its own, started when the reviews are over: the issues
 * can be read while it works, it is stopped by itself, and it takes its turn among the mendings. Two parts:
 *
 *  - what a review said how to close in its own chapter ({@link closeIssues}): its own small changes become
 *    proposals as they stand, its passages go to the writer;
 *  - what a review said takes a change in another chapter (`ReviewIssue.wider`): one planner reads those side by
 *    side and traces them ({@link fixIssues}) — which end changes, and what has to change with it.
 *
 * What a review left to the author — whether it changes at all, and which way — waits for the author: nothing is
 * proposed for it unasked. Every change waits as a proposal beneath the issue it is for.
 * @param chapters - the chapters reviewed; of their issues, the open ones that were handed to nobody yet.
 * @returns the job started and how many issues it was handed — nothing where none waits.
 */
export async function mendReviewed(core: NovelCore, runtime: ProjectRuntime, chapters: readonly string[], task: Pick<TaskContext, 'origin' | 'agentRoute' | 'caller'>, options: { order?: 'queue' | 'apart' } = {}): Promise<{ jobId: string; issues: number } | undefined> {
  const closing = await unmended(runtime, chapters, 'closing')
  const wider = (await unmended(runtime, chapters, 'wider')).filter(item => !closing.some(other => other.issue === item.issue))
  if (closing.length + wider.length === 0) return undefined
  const within = [...new Set([...closing, ...wider].map(item => item.chapter))]
  const order = options.order === 'apart' ? 'apart' : 'queue'
  const started = core.jobs.start({ kind: 'revise', title: MEND_REVIEW_JOB, project: runtime.project.root, origin: task.origin, ...(within.length === 1 ? { target: within[0]! } : {}) }, async (job) => {
    const sub: TaskContext = { origin: task.origin, signal: job.signal, job, ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}), ...(task.caller !== undefined ? { caller: task.caller } : {}) }
    // (Asked again when its turn comes: what the author settled or handed over meanwhile is not mended twice.)
    const closed = await mendInTurn(runtime, order, sub, async () => {
      const due = await unmended(runtime, within, 'closing')
      return due.length > 0 ? await closeIssues(core, runtime, due, sub) : undefined
    })
    // (What the reviewer closed stands whatever comes of the tracing: a planner that could not settle the rest is
    // said with the result, and takes nothing back.)
    let untraced: { issues: number; error: string } | undefined
    const traced: FixIssuesResult = await mendInTurn(runtime, order, sub, async (onto) => {
      const due = await unmended(runtime, within, 'wider')
      if (due.length === 0) return { issues: 0, chapters: 0 }
      try {
        return await fixIssues(core, runtime, { issues: due, ...(onto ? { onto: true } : {}) }, sub)
      } catch (error) {
        if (job.signal.aborted) throw error
        untraced = { issues: due.length, error: error instanceof Error ? error.message : String(error) }
        core.log('could not trace the issues a review said reach another chapter', error)
        return { issues: 0, chapters: 0 }
      }
    })
    const book = traced.book
    const wrote = { analyst: closed?.own ?? 0, planner: book?.wrote?.planner ?? 0, writer: (closed?.writer ?? 0) + (book?.wrote?.writer ?? 0) }
    const failed = (closed?.failed.length ?? 0) + (book?.failed.length ?? 0) + (untraced?.issues ?? 0)
    const output = {
      issues: (closed?.issues ?? 0) + traced.issues,
      chapters: new Set([...within]).size,
      places: (closed?.own ?? 0) + (closed?.writer ?? 0) + (book?.results.length ?? 0),
      failed,
      ...(closed !== undefined && closed.same > 0 ? { same: closed.same } : {}),
      wrote,
      ...(book?.note !== undefined ? { note: book.note } : {}),
      ...(untraced !== undefined ? { untraced: untraced.error } : {}),
    }
    job.result({ output })
    return output
  })
  // (Recorded on the job where it fails: nobody waits for it here.)
  started.done.catch(() => {})
  return { jobId: started.id, issues: closing.length + wider.length }
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
  await scheduleDigest(core, runtime, proposal.chapterId, task)
  // The chapter's plan follows what was accepted — also where chapters are not digested by themselves.
  schedulePlanFollow(core, runtime, proposal.chapterId, task)
  const where = await project.findChapter(proposal.chapterId)
  const lang = promptLanguage((await project.manifest()).language)
  // The issues it was made for are settled by its being taken: said so on them, with nobody asked.
  const answered = proposal.issues ?? []
  await settleIssues(runtime, answered, L(lang, '按采纳的修订提案改了', 'mended by the change that was accepted'))
  // What else it moved: an issue still open in the chapter whose words the change took away is read again — and
  // nothing else is. (A chapter written over is read for everything open in it: all of it may have moved.)
  const open = ((await project.review(proposal.chapterId))?.issues ?? []).filter(issue => issue.resolved !== true && !answered.includes(issue.id))
  const moved = proposal.kind === 'chapter' ? undefined : open.filter(issue => issue.quote !== undefined && fuzzyFind(text, issue.quote) !== undefined && fuzzyFind(next, issue.quote) === undefined).map(issue => issue.id)
  // (A change that names no issue of its own — one of a batch, made in another chapter than the issues were found in
  // — settles what it settles: the issues handed over with its batch are read again wherever they are, as before.)
  const unnamed = answered.length === 0 && (proposal.batchId !== undefined || (proposal.batches?.length ?? 0) > 0)
  if ((moved === undefined ? open.length > 0 : moved.length > 0) || unnamed) {
    scheduleRecheck(core, runtime, {
      chapterId: proposal.chapterId,
      ...(moved !== undefined ? { only: moved } : {}),
      ...(unnamed && proposal.batchId !== undefined ? { batchId: proposal.batchId } : {}),
      ...(unnamed && proposal.batches !== undefined ? { batches: proposal.batches } : {}),
      change: L(lang,
        `第 ${where?.index ?? '?'} 章${proposal.kind === 'span' ? `改了一处：\n原文：${clip(proposal.before, 400)}\n改成：${clip(proposal.after, 400)}` : '整章重写过'}\n为的是：${clip(proposal.instruction, 600)}`,
        `Chapter ${where?.index ?? '?'}${proposal.kind === 'span' ? ` — one passage changed:\nwas: ${clip(proposal.before, 500)}\nnow: ${clip(proposal.after, 500)}` : ' was rewritten whole'}\nfor: ${clip(proposal.instruction, 800)}`),
    }, task)
  }
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

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Review: an editor's read of one chapter against the bible, the story so far
 * and the style profile. Issues anchor to exact quotes so the UI can jump to
 * them and a fix can be requested as a span revision.
 */
import { MAIN_LINE, READ_DEFAULT, type ChapterReview, type IssueEvidence, type IssueSeverity, type IssueType, type MendBy, type ReviewIssue } from '../../shared/types'
import { clip, fuzzyFind, hashText, newId, occurrences } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asRecord, asText } from '../llm'
import { assign, crewPlan } from '../crew'
import { ProjectError } from '../project'
import { recheckTask, reviewTask } from '../prompts'
import { looksFirst } from '../references'
import { L, promptLanguage } from '../render'
import { bookBase, chapterInHand, checkEvidence, EVIDENCE_KINDS, placed, storyLedger } from './editorial'
import { onFile } from './onfile'

const SEVERITIES: IssueSeverity[] = ['high', 'medium', 'low']
const TYPES: IssueType[] = ['continuity', 'character', 'world', 'timeline', 'style', 'pacing', 'logic', 'language']
/** The kinds of issue that come of holding the chapter against something else: each says what, and where it stands. */
const HELD_AGAINST: IssueType[] = ['continuity', 'timeline', 'world', 'character']
/** How often a review is sent back for what it quoted before what cannot be found is let go of. */
const SENT_BACK_MOST = 2

export interface ReviewParams {
  chapter: string
  focus?: string
  /**
   * Who writes what mends an issue, where the review's findings go on to be mended (`mendBy`): the reviewer is then
   * asked to close each issue it can — a small change written out, or a passage described for the writer — and what
   * it hands in for that is kept on the issue (`ReviewIssue.fix`). Left out: the review lists what is wrong.
   */
  mends?: MendBy
}

export type Reviewed = ChapterReview & {
  title: string
  index: number
  /** Issues let go of because what they quoted of another chapter, a card or an entry was not found there. */
  unfounded?: number
  /** Issues that were on file already and stay as they were (handed over, the author's own, or said again by this review). */
  kept?: number
  /** How much the reviewer read with its tools beside what it was handed. */
  read?: { tokens: number; calls: number; capped?: true }
}

/** What a reviewer handed in of one issue, before it is an issue. */
interface Handed { item: Record<string, unknown>; nth: number }

/**
 * Review a chapter. The reviewer starts from the book's base, the story so far in outline and the chapter in hand —
 * not from the earlier text word for word — and reads what it needs: what it says the chapter is at odds with, it
 * quotes, and what it quotes is looked for where it is said to stand. It is told what is on file for the chapter —
 * the issues still open, the changes that wait, the changes the author turned down — so that nothing is filed, or
 * mended, a second time.
 */
export async function reviewChapter(core: NovelCore, runtime: ProjectRuntime, params: ReviewParams, task: TaskContext): Promise<Reviewed> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const text = await project.chapterText(chapter.plan.id)
  if (text.length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has no text to review`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('analyst', runtime, task)
  const line = chapter.line ?? MAIN_LINE
  // The book goes by other books, and a review holds the chapter against them: the reviewer looks in them first where
  // it has the tools to, and is handed what the planner took out of them for whoever wrote the chapter.
  const against = await looksFirst(runtime, 'review').catch(() => false)
  const withTools = crewPlan(core, 'analyst', manifest).mode !== 'call' && core.roles !== undefined && core.roles.can(route)
  const [book, story, hand, file] = [await bookBase(runtime, lang, line), await storyLedger(runtime, lang, chapter), await chapterInHand(runtime, chapter, lang, text), await onFile(runtime, [placed(chapter)], lang)]
  const cap = (await core.settingsOf(runtime)).context.readTokens ?? READ_DEFAULT
  // What was handed in and held: checked where it reads from (`check`), and what the last check found wrong with it.
  let sent = 0
  // Of what was handed in last: issues whose evidence is not where it was said to stand (not filed), issues that
  // give none where one is due (filed, and said to be unchecked), and ways of closing that cannot be used (the issue
  // is filed without one).
  let bad = new Map<number, string>()
  let bare = new Set<number>()
  let loose = new Set<number>()
  const handedOf = (record: Record<string, unknown>): Handed[] => asArray(record.issues).map((raw, at) => ({ item: asRecord(raw), nth: at + 1 }))
  const evidenceOf = (item: Record<string, unknown>): IssueEvidence | undefined => {
    const raw = asRecord(item.against)
    const quote = asText(raw.quote)
    const kind = asText(raw.kind) as IssueEvidence['kind'] | undefined
    if (quote === undefined || kind === undefined || !EVIDENCE_KINDS.includes(kind)) return undefined
    // (A chapter is kept by its number, however it was written: "第2章", "2", "chapter 2".)
    const said = asText(raw.ref)
    const ref = kind === 'chapter' && said !== undefined && /\d/.test(said) ? said.replace(/[^\d]/g, '') : said
    return { kind, quote, ...(ref !== undefined ? { ref } : {}) }
  }
  /** What is wrong with the way an issue is to be closed (`find` with `replace` or `how`), where it says one. */
  const closingFault = (item: Record<string, unknown>): string | undefined => {
    const find = asText(item.find)
    const replace = typeof item.replace === 'string' ? item.replace : undefined
    const how = asText(item.how)
    if (find === undefined && replace === undefined && how === undefined) return undefined
    if (find === undefined || [...find].length < 2) return L(lang, 'find 没有写：圈出这一处的原文，逐字照抄', 'find is missing: take in the text of the place, word for word')
    const range = fuzzyFind(text, find)
    if (range === undefined) return L(lang, `find 在本章正文里找不到：“${clip(find, 50)}”——从正文逐字照抄，不改写、不用省略号`, `find is not in the chapter: "${clip(find, 60)}" — copy it from the text, nothing reworded, no ellipsis`)
    if (occurrences(text, text.slice(range.start, range.end)) > 1) return L(lang, `find 在本章出现不止一次，定不了是哪一处：“${clip(find, 40)}”——连它前后的半句一起抄`, `find stands more than once in the chapter: "${clip(find, 50)}" — copy the half-sentence beside it too`)
    if (replace === undefined && how === undefined) return L(lang, 'find 后面要给 replace（你直接改）或 how（交给写手）当中的一个', 'find needs one of replace (your own change) and how (for the writer)')
    if (replace !== undefined && replace.trim() === text.slice(range.start, range.end).trim()) return L(lang, 'replace 和 find 一样，没有改动', 'replace reads as find does: nothing changes')
    return undefined
  }
  const { value, referenced, read } = await assign(core, runtime, task, {
    role: 'analyst',
    label: L(lang, `第${chapter.index}章 · 审校`, `Ch. ${chapter.index} · review`),
    line,
    lookUp: 'review',
    tool: 'file_review',
    what: L(lang, '这一章的审校意见：总评和逐条问题', 'the review of this chapter: a verdict and the issues, one by one'),
    prompt: reviewTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      book,
      story: story.text,
      hand,
      ...(file.text.length > 0 ? { onFile: file.text } : {}),
      ...(params.focus !== undefined ? { focus: params.focus } : {}),
      ...(against ? { references: { look: withTools, ...(chapter.plan.referenceNotes !== undefined && chapter.plan.referenceNotes.trim().length > 0 ? { notes: chapter.plan.referenceNotes } : {}) } } : {}),
      ...(params.mends !== undefined ? { mends: params.mends } : {}),
      reads: withTools,
    }),
    temperature: 0.2,
    ...(cap > 0 ? { readCap: cap } : {}),
    validate: raw => asRecord(raw),
    // What it quoted of somewhere else is looked for there; how it would close an issue is looked for in the chapter.
    // Sent back twice at most: after that — or where nobody will be asked again — what does not hold is let go of
    // (the issue, where its evidence is not found; only the way of closing it, where that is what is wrong).
    check: async (record, last) => {
      sent += 1
      const faults: string[] = []
      bad = new Map()
      bare = new Set()
      loose = new Set()
      // Two issues are not closed at one place: each would be proposed without the other's change in it, and the
      // later would take the earlier one's place.
      const taken: { nth: number; start: number; end: number }[] = []
      for (const { item, nth } of handedOf(record)) {
        if (asText(item.explanation) === undefined) continue
        const type = asText(item.type) as IssueType | undefined
        const evidence = evidenceOf(item)
        if (evidence === undefined && type !== undefined && HELD_AGAINST.includes(type) && asRecord(item.against).quote !== undefined) {
          bare.add(nth)
          faults.push(L(lang, `issues 第 ${nth} 条：against 要写 kind（chapter / here / character / world / plan / style / reference）和 quote`, `issues[${nth}]: against needs a kind (chapter / here / character / world / plan / style / reference) and a quote`))
        } else if (evidence !== undefined) {
          const wrong = await checkEvidence(runtime, chapter, text, evidence, lang)
          if (wrong !== undefined) bad.set(nth, wrong)
        } else if (type !== undefined && HELD_AGAINST.includes(type)) {
          bare.add(nth)
          faults.push(L(lang, `issues 第 ${nth} 条：这是一条“对不上”的问题（${type}），要写 against——它对不上的是哪里的哪句话；只是这一章自己的毛病，就把 type 改成 logic、style、pacing 或 language`, `issues[${nth}]: this is an issue of things not agreeing (${type}) and needs \`against\` — the words it is at odds with, and where they stand; where it is a fault of this chapter alone, its type is logic, style, pacing or language`))
        }
        let closing = closingFault(item)
        const place = closing === undefined && asText(item.find) !== undefined ? fuzzyFind(text, asText(item.find)!) : undefined
        if (place !== undefined) {
          const other = taken.find(earlier => earlier.start < place.end && place.start < earlier.end)
          if (other !== undefined) closing = L(lang, `find 和第 ${other.nth} 条圈的地方重叠——两条问题要改的是同一处，就把改法并进其中一条（另一条不写 find），不要各改各的`, `find overlaps what issue ${other.nth} takes in — where two issues change the same place, put the change into one of them (the other gives no find): not one each`)
          else taken.push({ nth, start: place.start, end: place.end })
        }
        if (closing !== undefined) { loose.add(nth); if (!bad.has(nth)) faults.push(L(lang, `issues 第 ${nth} 条：${closing}`, `issues[${nth}]: ${closing}`)) }
      }
      for (const [nth, wrong] of bad) faults.push(L(lang, `issues 第 ${nth} 条：${wrong}`, `issues[${nth}]: ${wrong}`))
      if (faults.length > 0 && last !== true && sent <= SENT_BACK_MOST) throw new Error(`${faults.join('\n')}\n${L(lang, '改好这几条（查不到原话的就去掉这一条），把整个结果重新交一次。', 'Put these right (an issue whose words cannot be found is left out) and hand the whole result in again.')}`)
    },
  })
  const fresh: ReviewIssue[] = []
  let unfounded = 0
  for (const { item, nth } of handedOf(value)) {
    const explanation = asText(item.explanation)
    if (explanation === undefined) continue
    // What it rests on was not found where it was said to stand: not filed.
    if (bad.has(nth)) { unfounded += 1; continue }
    const severity = asText(item.severity) as IssueSeverity | undefined
    const type = asText(item.type) as IssueType | undefined
    const quote = asText(item.quote)
    const suggestion = asText(item.suggestion)
    // A quote that is not in the text cannot anchor anything; keep the issue, drop the anchor.
    const anchored = quote !== undefined ? fuzzyFind(text, quote) : undefined
    const evidence = evidenceOf(item)
    const find = asText(item.find)
    const range = find !== undefined && !loose.has(nth) ? fuzzyFind(text, find) : undefined
    const replace = typeof item.replace === 'string' ? item.replace : undefined
    const how = asText(item.how)
    // How it is closed, where it can be in this chapter: the reviewer's own words, or what it says of a passage for
    // the writer. (Where the author has the writer write every place, words it wrote out are what the writer is told.)
    const closing: { replace: string } | { how: string } | undefined = range === undefined ? undefined
      : params.mends === 'writer' ? (how !== undefined ? { how } : replace !== undefined && replace.trim().length > 0 ? { how: L(lang, `改成：${replace}`, `It is to read: ${replace}`) } : undefined)
        : replace !== undefined ? { replace } : how !== undefined ? { how } : undefined
    fresh.push({
      id: newId('is'),
      severity: severity !== undefined && SEVERITIES.includes(severity) ? severity : 'medium',
      type: type !== undefined && TYPES.includes(type) ? type : 'logic',
      ...(anchored !== undefined ? { quote: text.slice(anchored.start, anchored.end) } : {}),
      explanation,
      ...(suggestion !== undefined ? { suggestion } : {}),
      ...(evidence !== undefined ? { against: evidence } : bare.has(nth) ? { unverified: true as const } : {}),
      ...(closing !== undefined ? { fix: { find: text.slice(range!.start, range!.end), ...closing } } : {}),
      ...(item.wider === true && closing === undefined ? { wider: true as const } : {}),
    })
  }
  const order: Record<IssueSeverity, number> = { high: 0, medium: 1, low: 2 }
  fresh.sort((left, right) => order[left.severity] - order[right.severity])
  // What was on file and stays. The reviewer was told the issues still open and asked not to file them again — so an
  // issue on file stays unless the reviewer says it no longer holds (`gone`: the text was changed since): those are
  // marked settled, saying so. An issue this review says again all the same, of the very same words, is the one on
  // file — it keeps its id, and with it the changes that wait for it — not a second one.
  const before = ((await project.review(chapter.plan.id))?.issues ?? []).filter(issue => issue.resolved !== true)
  // (What the author noticed themselves is theirs to settle: a reviewer's word that it is gone does not settle it.)
  const gone = new Set(asArray(value.gone).map(item => asText(item)).filter((id): id is string => id !== undefined && before.some(issue => issue.id === id && issue.lead === undefined)))
  const issues: ReviewIssue[] = []
  const taken = new Set<string>()
  for (const issue of fresh) {
    // The same issue: of the very same words — or, quoting none, of the same kind and at odds with the very same words elsewhere.
    const known = before.find(old => !taken.has(old.id) && (issue.quote !== undefined
      ? old.quote === issue.quote
      : old.quote === undefined && old.type === issue.type && issue.against !== undefined && old.against !== undefined && old.against.kind === issue.against.kind && old.against.quote === issue.against.quote))
    if (known !== undefined) {
      taken.add(known.id)
      // (Said anew: what it is and how to close it are as this review has them; whose it is, what the author wrote of it and what waits for it stay.)
      issues.push({ ...issue, id: known.id, ...(known.note !== undefined ? { note: known.note } : {}), ...(known.mending !== undefined ? { mending: known.mending } : {}), ...(known.lead !== undefined ? { lead: known.lead } : {}) })
    } else issues.push(issue)
  }
  // (An issue whose words the chapter no longer has, and that this review did not say again, went with them.)
  for (const old of before) if (!taken.has(old.id) && old.lead === undefined && old.quote !== undefined && fuzzyFind(text, old.quote) === undefined) gone.add(old.id)
  const kept = before.filter(issue => !taken.has(issue.id) && !gone.has(issue.id))
  issues.push(...kept)
  const at = new Date().toISOString()
  for (const issue of before.filter(old => gone.has(old.id) && !taken.has(old.id))) {
    issues.push({ ...issue, resolved: true, checked: { at, verdict: 'fixed' as const, why: L(lang, '重新审校时，现在的正文已经没有这个问题', 'reviewed again: the text as it stands no longer has it') } })
  }
  const review: ChapterReview = {
    chapterId: chapter.plan.id,
    textHash: hashText(text),
    createdAt: new Date().toISOString(),
    verdict: asText(value.verdict) ?? '',
    issues,
    ...(referenced !== undefined ? { referenced } : {}),
  }
  await project.saveReview(review)
  const stays = kept.length + taken.size
  if (gone.size > 0) task.job?.write(L(lang, `\n在案的 ${gone.size} 条问题，审校说现在的正文已经没有了，标为已处理。\n`, `\n${gone.size} issue(s) on file the review says the text no longer has: marked settled.\n`))
  task.job?.result({ chapterId: chapter.plan.id, issues: issues.length, ...(referenced !== undefined ? { referenced } : {}), ...(unfounded > 0 ? { unfounded } : {}), ...(stays > 0 ? { kept: stays } : {}), ...(read !== undefined ? { read } : {}) })
  return { ...review, title: chapter.plan.title, index: chapter.index, ...(unfounded > 0 ? { unfounded } : {}), ...(stays > 0 ? { kept: stays } : {}), ...(read !== undefined ? { read } : {}) }
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
 * @param params.only - of a chapter that changed, only these issues are read again (by chapter id): the ones the
 *   change moved the words of. A chapter not named here is read for everything open, as one written over is.
 */
export async function recheckIssues(core: NovelCore, runtime: ProjectRuntime, params: { chapters: string[]; batches?: string[]; changes: string; only?: Record<string, string[]> }, task: TaskContext): Promise<RecheckResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const changed = new Set(params.chapters)
  const batches = new Set(params.batches ?? [])
  const narrowed = (chapterId: string, issueId: string): boolean => params.only?.[chapterId] === undefined || params.only[chapterId]!.includes(issueId)
  const result: RecheckResult = { looked: 0, chapters: 0, fixed: [], changed: [] }
  const stopped = (): boolean => task.signal?.aborted === true
  for (const review of await listReviews(runtime)) {
    // Of a chapter that changed: everything open. Of any other: what was handed over with a batch now accepted from.
    const due = review.issues.filter(issue => issue.resolved !== true && ((changed.has(review.chapterId) && narrowed(review.chapterId, issue.id)) || (issue.mending !== undefined && batches.has(issue.mending))))
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
        // All of it is in the task: asked in one request, whatever the role is set to.
        plain: true,
        label: L(lang, `第${review.index}章 · 核对审校意见`, `Ch. ${review.index} · issues looked at again`),
        line: await project.lineOf(review.chapterId),
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

/**
 * The issues a change was made for are settled by its being accepted: said so on each, with nobody asked. (What the
 * author took was the mending of these very issues; one that is not mended after all is theirs to open again.)
 * @returns how many were marked.
 */
export async function settleIssues(runtime: ProjectRuntime, issueIds: readonly string[], why: string): Promise<number> {
  if (issueIds.length === 0) return 0
  const { project } = runtime
  const wanted = new Set(issueIds)
  const at = new Date().toISOString()
  let marked = 0
  for (const review of await listReviews(runtime)) {
    if (!review.issues.some(issue => wanted.has(issue.id) && issue.resolved !== true)) continue
    const current = await project.review(review.chapterId)
    if (current === undefined) continue
    await project.saveReview({ ...current, issues: current.issues.map((issue) => {
      if (!wanted.has(issue.id) || issue.resolved === true) return issue
      marked += 1
      return { ...issue, resolved: true, checked: { at, verdict: 'fixed' as const, why } }
    }) })
  }
  return marked
}

/** What waits to be looked at again per book: acceptances that come one after another are answered by one look. */
const pendingRechecks = new Map<string, { timer: ReturnType<typeof setTimeout>; chapters: Set<string>; batches: Set<string>; changes: string[]; only: Map<string, Set<string> | 'all'> }>()

/**
 * Have the open issues looked at again once a proposal was accepted — in the
 * background, a moment later, so that a batch accepted in one go is one look.
 * Nothing is asked where nothing is open.
 */
export function scheduleRecheck(core: NovelCore, runtime: ProjectRuntime, accepted: { chapterId: string; batchId?: string; batches?: readonly string[]; change: string; /** Of this chapter, only these issues need a look: the ones the change moved the words of. Left out: everything open in it. */ only?: readonly string[] }, task: Pick<TaskContext, 'origin' | 'agentRoute'>): void {
  const root = runtime.project.root
  const waiting = pendingRechecks.get(root) ?? { timer: undefined as unknown as ReturnType<typeof setTimeout>, chapters: new Set<string>(), batches: new Set<string>(), changes: [], only: new Map<string, Set<string> | 'all'>() }
  if (waiting.timer !== undefined) clearTimeout(waiting.timer)
  waiting.chapters.add(accepted.chapterId)
  // (Narrowed for a chapter only while every change to it was: one that asks for all of it has all of it read.)
  const before = waiting.only.get(accepted.chapterId)
  if (accepted.only === undefined) waiting.only.set(accepted.chapterId, 'all')
  else if (before !== 'all') waiting.only.set(accepted.chapterId, new Set([...(before ?? []), ...accepted.only]))
  if (accepted.batchId !== undefined) waiting.batches.add(accepted.batchId)
  // (A change made on top of others stands for their batches too.)
  for (const batch of accepted.batches ?? []) waiting.batches.add(batch)
  waiting.changes.push(accepted.change)
  waiting.timer = setTimeout(() => {
    pendingRechecks.delete(root)
    const only = Object.fromEntries([...waiting.only].filter((entry): entry is [string, Set<string>] => entry[1] !== 'all').map(([chapter, ids]) => [chapter, [...ids]]))
    const params = { chapters: [...waiting.chapters], batches: [...waiting.batches], changes: waiting.changes.join('\n\n'), ...(Object.keys(only).length > 0 ? { only } : {}) }
    void (async () => {
      if (!(await core.autoFor(runtime)).recheckIssues) return
      // Asked only where something is open that the change could have touched.
      const open = (await listReviews(runtime)).some(review => review.issues.some(issue => issue.resolved !== true && ((waiting.chapters.has(review.chapterId) && (only[review.chapterId] === undefined || only[review.chapterId]!.includes(issue.id))) || (issue.mending !== undefined && waiting.batches.has(issue.mending)))))
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

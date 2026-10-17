// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Context packing: what a model gets to read before it works on a chapter.
 *
 * The story travels in two layers:
 *   an outline of what came before — every chapter that is not sent word for
 *       word, as its summary, oldest first;
 *   the text itself — as many whole chapters up to the one in hand as the
 *       budget holds, word for word and in order.
 * The budget for the text is half of the model's window unless the author set
 * a figure, and it is spent in whole chapters. A chapter that already has
 * chapters after it — one being rewritten — gets what follows it too.
 *
 * The order is made for the providers' prefix caches. What stays the same
 * from one chapter to the next comes first — the book, the world, who is in
 * it, the outline of what came before, the text — and each new chapter only
 * adds to the end of that; what belongs to this one piece of work comes after
 * it. The window of text does not slide chapter by chapter, which would change
 * the prefix every time: it holds its first chapter until the chapters no
 * longer fit, then lets go of the oldest quarter at once.
 */
import { stageAt } from '../shared/stages'
import type { CharacterCard, ChapterMemory, ContextStrategy, PromptLanguage, WorldEntry } from '../shared/types'
import { clip, clipTail, estimateTokens, proseOnly, sameName } from '../shared/text'
import { livesFrom, type LocatedChapter, type Project } from './project'
import {
  L, promptLanguage, renderCharacter, renderManifest, renderMoment, renderPlan, renderThread, renderWorld,
} from './render'
import { derivationRecords, intentTitle, lineIntentsTitle, renderIntent, renderLineIntents, type IntentChapter } from './derivations'
import { foundJottings, renderJottings } from './jottings'
import { chapterAsMeant } from './plans'
import { tokenize, type RetrievalIndex } from './retrieval'

export interface ArcSummary {
  /** First and last chapter ids covered. */
  from: string
  to: string
  fromIndex: number
  toIndex: number
  summary: string
  /** Hash of the chapter summaries it was written from. */
  hash: string
}

/**
 * How the story so far ended up travelling: `full` — every chapter word for
 * word; `window` — the nearest chapters word for word, the ones before them as
 * an outline; `retrieval` — no chapter whole, only the outline, what was looked
 * up, and the end of the chapter before.
 */
export type PackedStrategy = 'full' | 'window' | 'retrieval' | 'chosen'

/**
 * What goes along with a piece of writing where somebody chose it — the planner, having read in the book for this one
 * piece — instead of the packer's own rules: the chapters that travel word for word and the ones told in outline, the
 * stretches of text to hold the writing against, whose cards, which of the world, which threads; and what the planner
 * says in its own words. With this, nothing is found by search or by nearness: what is here goes, and nothing else
 * does — but what the work stands on whoever prepares it (the book, the world's core, the chapter's own plan and what
 * it was planned with, where it has to join, the chapter itself where that is worked on).
 */
export interface ChosenMaterial {
  /** Chapters that travel word for word, by id. */
  chapters: string[]
  /** Chapters told by their summaries, by id. */
  summaries: string[]
  /** Stretches of chapters, word for word: which chapter, the words, and what they are along for. */
  excerpts: { chapter: string; text: string; why?: string }[]
  /** Whose cards go whole, by id. */
  people: string[]
  /** Entries of the world, by id (the core ones go whatever is here). */
  world: string[]
  /** Threads, by id. */
  threads: string[]
  /** In the planner's words: what is asked of the writer, where the story stands, what must hold, the form, the voice. */
  words: { task?: string; situation?: string; keep?: string[]; form?: string; voice?: string }
}

export interface PackOptions {
  purpose: 'draft' | 'continue' | 'revise' | 'review' | 'derive' | 'play' | 'stage'
  /** Chapter the task is about; canon is everything before it on the line it belongs to. */
  chapter?: LocatedChapter
  /**
   * Without a focus chapter: treat only chapters up to this 1-based position
   * as known canon (an interlude branching off mid-book).
   */
  canonThrough?: number
  /** Without a focus chapter: the line of the plot the task is on, when it is not the main one. */
  line?: string
  /** The task brief; also steers retrieval and cast detection. */
  brief?: string
  /** Extra text that steers retrieval and cast detection (a selected passage). */
  focus?: string
  /** Characters to include regardless of detection (ids or names). */
  characters?: string[]
  /** Tokens the manuscript's own text may take, word for word. 0: none of it but the end of the chapter before. */
  textBudget: number
  /** Tokens everything else may take together: the book, the world, the people, the outline of what came before, what is looked up. */
  sideBudget: number
  /** Characters of the preceding text sent word for word when no whole chapter is. */
  tailChars: number
  /** Include the focus chapter's own text (continue, revise, review). */
  includeChapterText?: boolean
  /** With `includeChapterText`: the chapter as the task has it, where that is not how the manuscript has it yet. */
  chapterText?: string
  /** What goes along was chosen for this piece of work: the packer's own choosing — by nearness, by search — is left out. */
  chosen?: ChosenMaterial
  signal?: AbortSignal
}

export interface ContextPack {
  /** The whole of it: `stable` and then `rest`. */
  text: string
  /**
   * The head of the text that is the same for the next chapter too — the next
   * one's only goes on where this ends — until the window of text lets go of
   * its oldest chapters. Sent as a block of its own, a provider can keep it.
   */
  stable: string
  /** What belongs to this piece of work alone. */
  rest: string
  tokens: number
  stableTokens: number
  strategy: PackedStrategy
  language: PromptLanguage
  cast: CharacterCard[]
  included: {
    /** Chapters before the one in hand that travel word for word. */
    fullChapters: number
    /** Chapters (and arcs of chapters) that travel as a summary. */
    summaries: number
    passages: number
    worldEntries: number
    /** The author's jottings that bear on the chapter and went along; absent where none did. */
    jottings?: number
    /** Records of the derivations the chapter (or, with no chapter, the line) was planned by that went along: what the author gave them to go by, what the planner said. Absent where none did. */
    intent?: number
    /** Chapters after the one in hand that travel word for word. */
    following: number
  }
  /** The chapters before the one in hand sent word for word: the first and the last, by their place on the line. */
  window?: { from: number; to: number }
}

interface Section {
  title: string
  body: string
}

const ROLE_RANK: Record<CharacterCard['role'], number> = { protagonist: 0, deuteragonist: 1, antagonist: 2, supporting: 3, minor: 4, cameo: 5 }

/** Characters whose name or alias occurs in the text. */
export function detectCharacters(text: string, characters: CharacterCard[]): CharacterCard[] {
  if (text.length === 0) return []
  const folded = text.normalize('NFKC')
  return characters.filter((card) => {
    const names = [card.name, ...(card.aliases ?? [])].filter(name => name.trim().length >= 2 || /[一-鿿]/.test(name))
    return names.some(name => name.length > 0 && folded.includes(name.normalize('NFKC')))
  })
}

/** What a model is taken to hold when neither the endpoint nor the author says: enough for any current model, small enough to be safe. */
export const ASSUMED_CONTEXT_WINDOW = 200_000

/** The share of its budget the window of text keeps when it lets go of its oldest chapters. */
const KEEP_SHARE = 0.75
/** The most of the text budget that goes to what follows the chapter in hand, when what precedes it could use it all. */
const FOLLOWING_SHARE = 0.3

/**
 * Whether the chapter in hand is what the work is done on — revised, reviewed — and so goes into the request whole,
 * beside the budgets, rather than as much of its end as they leave room for.
 */
export function ownsChapter(options: Pick<PackOptions, 'purpose' | 'includeChapterText'>): boolean {
  return options.includeChapterText === true && (options.purpose === 'revise' || options.purpose === 'review')
}

/**
 * How many tokens the story's own text and everything beside it may take, for
 * a model with this window.
 * @param own - the author's figure for the text; unset, the text gets half the window.
 * @param side - the author's figure for everything beside the text; unset, 22 % of the window and 120,000 at most.
 */
export function contextBudgets(preference: ContextStrategy, own: number | undefined, contextWindow: number | undefined, side?: number): { textBudget: number; sideBudget: number; window: number; reserve: number } {
  const window = Math.max(8000, contextWindow ?? ASSUMED_CONTEXT_WINDOW)
  // What the instructions, the reply and the error of an estimate need.
  const reserve = Math.min(Math.floor(window * 0.12), 48_000)
  // The author's figure holds as far as the window does: never more than half of it.
  const sideBudget = side !== undefined && side > 0
    ? Math.max(3000, Math.min(Math.round(side), Math.floor(window / 2)))
    : Math.max(3000, Math.min(Math.floor(window * 0.22), 120_000))
  const room = Math.max(0, window - reserve - sideBudget)
  if (preference === 'retrieval') return { textBudget: 0, sideBudget, window, reserve }
  if (preference === 'full') return { textBudget: room, sideBudget, window, reserve }
  return { textBudget: Math.min(room, own !== undefined && own > 0 ? Math.round(own) : Math.floor(window / 2)), sideBudget, window, reserve }
}

/**
 * Where the window of text starts once these chapters are written — the same
 * answer every time for the same chapters, so the head of the prompt a
 * provider has cached stays valid: the window holds its first chapter until
 * the chapters no longer fit, then moves on far enough to leave a quarter of
 * the budget free for the chapters to come.
 * @param costs - tokens of each chapter before the one in hand, in reading order.
 * @returns index into `costs` of the first chapter sent word for word; `costs.length` when not even the last one fits.
 */
export function windowStart(costs: readonly number[], budget: number): number {
  let start = 0
  let held = 0
  for (let at = 0; at < costs.length; at++) {
    held += costs[at]!
    if (held <= budget) continue
    // Let go of the oldest — never of the chapter just added while it fits by itself.
    const keep = budget * KEEP_SHARE
    while (start < at && held > keep) held -= costs[start++]!
    if (held > budget) {
      held = 0
      start = at + 1
    }
  }
  return start
}

/** Token counts of chapter texts already measured, by project: a long book is not counted again for every chapter written. */
const measured = new WeakMap<Project, Map<string, { text: string; tokens: number }>>()

function tokensOf(project: Project, id: string, text: string): number {
  let known = measured.get(project)
  if (known === undefined) measured.set(project, known = new Map())
  const hit = known.get(id)
  if (hit !== undefined && hit.text === text) return hit.tokens
  const tokens = estimateTokens(text)
  known.set(id, { text, tokens })
  return tokens
}

/** How many jottings go along with a chapter at most, and how many of the chapter's own terms one has to share to be one of them. */
const JOTTINGS_ALONG = 3
const JOTTING_SHARED = 3

export async function packContext(project: Project, index: RetrievalIndex, options: PackOptions): Promise<ContextPack> {
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // A chapter drafted — for the first time, or over what it has — is written by what was meant for it, not by what an
  // earlier draft of it happened to be: its plan goes without the blanks that draft's digest filled in (where, when,
  // who, which threads), and the threads without the marks that draft left on them. (Gone on with, revised or read,
  // a chapter is taken as it stands.)
  const current = options.purpose === 'draft' && options.chapter !== undefined ? await chapterAsMeant(project, options.chapter) : options.chapter
  const anew = options.purpose === 'draft' ? current?.plan : undefined
  // A world may hold several stories. Whoever works on one line of the plot reads that line: its chapters as they are
  // read by whoever reaches this one, its people, its threads — and the world, which they share. Nothing of another
  // line comes in by itself; what does is named, by the chapter's plan or by whoever gave the task.
  const scope = await project.lineScope(current !== undefined ? await project.lineOf(current.plan.id) : options.line, anew)
  const path = scope.path
  const [everyone, everything] = await Promise.all([project.characters(), project.world()])
  const characters = everyone.filter(card => scope.has(card))
  const world = everything.filter(entry => scope.knows(entry))
  const at = current !== undefined ? path.findIndex(chapter => chapter.plan.id === current.plan.id) : -1
  const limit = at >= 0 ? at + 1 : options.canonThrough !== undefined ? options.canonThrough + 1 : undefined
  const before = limit === undefined ? path : path.filter(chapter => chapter.index < limit)
  const after = at >= 0 ? path.slice(at + 1) : []
  const chapterLabel = (id: string): string => {
    const chapter = path.find(candidate => candidate.plan.id === id)
    return chapter === undefined ? id : L(lang, `第${chapter.index}章`, `ch. ${chapter.index}`)
  }
  const nameOf = (ref: string): string => everyone.find(card => card.id === ref)?.name ?? ref
  const heading = (chapter: LocatedChapter): string => `${L(lang, `第${chapter.index}章`, `Chapter ${chapter.index}`)} ${chapter.plan.title}`

  // What was chosen for this piece of work goes as chosen: whoever chose measured it, and nothing of it is cut here.
  const chosen = options.chosen
  const free = chosen !== undefined
  let side = free ? Number.MAX_SAFE_INTEGER : options.sideBudget
  const sections: Record<string, Section | undefined> = {}
  /** Put a section in, cut to what is left of the side budget (and to its own cap). */
  const take = (key: string, title: string, body: string, cap?: number): number => {
    const trimmed = body.trim()
    if (trimmed.length === 0 || side <= 0) return 0
    const allowed = free ? Number.POSITIVE_INFINITY : Math.min(side, cap ?? side)
    let text = trimmed
    let tokens = estimateTokens(text)
    if (tokens > allowed) {
      // Token estimates are per character class; scale the cut and re-measure.
      text = clip(trimmed, Math.max(80, Math.floor(trimmed.length * allowed / tokens)))
      tokens = estimateTokens(text)
    }
    sections[key] = { title, body: text }
    side -= tokens
    return tokens
  }
  /** Put a section in that was measured against the text budget already. */
  const place = (key: string, title: string, body: string): void => {
    if (body.trim().length > 0) sections[key] = { title, body: body.trim() }
  }
  const share = (fraction: number): number => Math.floor(options.sideBudget * fraction)

  // The chapter's own outline is what the work is about: it is counted before anything can crowd it out, and read last.
  const planText = current !== undefined ? renderPlan(current.plan, current.index, lang, nameOf) : ''
  if (current !== undefined) take('plan', L(lang, '本章章纲', 'This chapter\'s outline'), planText)

  // (Prose only: a picture's line in a chapter is not the story, and a writer shown such lines writes some of its own.)
  const texts = new Map<string, string>()
  const textOf = async (chapter: LocatedChapter): Promise<string> => {
    let text = texts.get(chapter.plan.id)
    if (text === undefined) texts.set(chapter.plan.id, text = proseOnly(await project.chapterText(chapter.plan.id)))
    return text
  }

  // The thinking the chapter was planned with — the direction the author gave when its stretch of the story was derived
  // (which way it goes, in which key), what the planner said of what it handed in — goes to whoever lays out its beats
  // or writes it, with which chapters that thinking covers and where this one stands among them: an outline says what
  // happens, and what it was meant to be is said there. Counted with the plan, before anything can crowd it out.
  let intent = 0
  const planned = options.purpose === 'draft' || options.purpose === 'continue' || options.purpose === 'revise' || options.purpose === 'derive'
  const records = planned ? await derivationRecords(project) : []
  if (current !== undefined && records.length > 0) {
    const mine = records.filter(record => record.chapters.includes(current.plan.id))
    if (mine.length > 0) {
      const covered = new Set(mine.flatMap(record => record.chapters))
      const told: IntentChapter[] = []
      for (const chapter of path) told.push({ id: chapter.plan.id, index: chapter.index, title: chapter.plan.title, written: covered.has(chapter.plan.id) && chapter.plan.id !== current.plan.id && (await textOf(chapter)).length > 0 })
      // (Whoever lays the beats out anew is given the author's word of the moment, not the one of the time before.)
      const made = renderIntent(mine, current.plan.id, told, lang, options.purpose !== 'derive')
      if (made !== undefined && take('intent', intentTitle(lang), made.text, share(0.12)) > 0) intent = made.records
    }
  }

  // ── what stays the same from chapter to chapter ──
  take('project', L(lang, '作品', 'The book'), renderManifest(manifest, lang, scope.apart && scope.title !== undefined ? { title: scope.title, premise: scope.premise } : undefined))

  const core = world.filter(entry => entry.importance === 1)
  const coreTokens = take('world', L(lang, '世界观核心设定', 'World: core canon'), core.map(entry => renderWorld(entry, lang)).join('\n\n'), share(0.18))

  // Everybody the book has, the same way whatever the chapter: the leads in full, the rest in a line each.
  const ranked = [...characters].sort((left, right) => ROLE_RANK[left.role] - ROLE_RANK[right.role])
  const inFull = new Set<string>()
  const peopleCap = share(0.3)
  let peopleTokens = 0
  const people: string[] = []
  // (Chosen: nobody is listed for being in the book — whoever is wanted is given whole further down, with where they stand.)
  for (const card of free ? [] : ranked) {
    const full = ROLE_RANK[card.role] <= ROLE_RANK.supporting ? renderCharacter(card, lang, { resolveName: nameOf }) : undefined
    const cost = full !== undefined ? estimateTokens(full) : 0
    if (full !== undefined && (peopleTokens + cost <= peopleCap || inFull.size < 2)) {
      people.push(full)
      inFull.add(card.id)
      peopleTokens += cost
    }
  }
  // Who is alive and who is gone is no part of this: that depends on the line and on the chapter in hand, and is said
  // further down, with what belongs to this piece of work.
  const lesser = free ? [] : ranked.filter(card => !inFull.has(card.id))
  take('people', L(lang, '人物', 'Characters'), [
    ...people,
    ...(lesser.length > 0 ? [`${L(lang, '其他人物（未必出场）：', 'Others (not necessarily present):')}\n${lesser.map(card => renderCharacter(card, lang, { brief: true })).join('\n')}`] : []),
  ].join('\n\n'), share(0.4))

  // ── the story so far: which chapters travel word for word ──
  const blockOf = async (chapter: LocatedChapter): Promise<string> => `${heading(chapter)}\n\n${await textOf(chapter)}`
  const written: LocatedChapter[] = []
  const costs: number[] = []
  for (const chapter of before) {
    const text = await textOf(chapter)
    if (text.length === 0) continue
    written.push(chapter)
    costs.push(tokensOf(project, chapter.plan.id, text) + 12)
  }
  const later: LocatedChapter[] = []
  const laterCosts: number[] = []
  // What follows the chapter in hand only matters where it has to be led into: when the chapter is written, continued or revised.
  const withFollowing = options.purpose === 'draft' || options.purpose === 'continue' || options.purpose === 'revise'
  for (const chapter of after) {
    const text = await textOf(chapter)
    if (text.length === 0) continue
    later.push(chapter)
    laterCosts.push(tokensOf(project, chapter.plan.id, text) + 12)
  }
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)
  const followingWanted = withFollowing ? sum(laterCosts) : 0
  // What precedes comes first; what follows gets what that leaves, and no less than its share when both want more than there is.
  const precedingBudget = sum(costs) + followingWanted <= options.textBudget ? options.textBudget - followingWanted : options.textBudget - Math.min(followingWanted, Math.floor(options.textBudget * FOLLOWING_SHARE))
  const takenWhole = new Set(chosen?.chapters ?? [])
  const first = free ? written.length : options.textBudget > 0 ? windowStart(costs, precedingBudget) : written.length
  // Chosen: the chapters named, wherever they stand; by rule: as many of the nearest as the budget holds.
  const inWindow = free ? written.filter(chapter => takenWhole.has(chapter.plan.id)) : written.slice(first)
  const outside = free ? [] : written.slice(0, first)
  let followingBudget = withFollowing ? options.textBudget - sum(costs.slice(first)) : 0
  const followingWhole: LocatedChapter[] = free ? later.filter(chapter => takenWhole.has(chapter.plan.id)) : []
  for (const [position, chapter] of free ? [] : later.entries()) {
    // Nearest first, whole chapters, and without a gap: a chapter is no use without the ones between.
    if (laterCosts[position]! > followingBudget) break
    followingWhole.push(chapter)
    followingBudget -= laterCosts[position]!
  }

  // ── the outline of what came before the text ──
  const windowFrom = inWindow[0]?.index ?? limit ?? path.length + 1
  const memories = await project.memories(path)
  const priorMemories = memories.filter(entry => limit === undefined || entry.chapter.index < limit)
  let summaries = 0
  const memoryOf = new Map(memories.map(entry => [entry.chapter.plan.id, entry.memory]))
  if (outside.length > 0) {
    const arcs = (await project.readState<ArcSummary[]>('memory', 'arcs.json')) ?? []
    // An arc stands for its chapters where it lies wholly before the text, on this very line.
    const usable = arcs.filter(arc => arc.toIndex < windowFrom && path[arc.fromIndex - 1]?.plan.id === arc.from && path[arc.toIndex - 1]?.plan.id === arc.to)
    const coveredTo = usable.reduce((max, arc) => Math.max(max, arc.toIndex), 0)
    const arcLines = usable.map(arc => `${L(lang, `第${arc.fromIndex}–${arc.toIndex}章`, `Chapters ${arc.fromIndex}–${arc.toIndex}`)}  ${arc.summary}`)
    // A chapter that has no memory yet is told by what its outline says of it: nothing that was written goes unmentioned.
    const single = outside.filter(chapter => chapter.index > coveredTo).map(chapter => ({ chapter, memory: memoryOf.get(chapter.plan.id) })).filter(entry => entry.memory !== undefined || entry.chapter.plan.synopsis !== undefined)
    const label = (entry: typeof single[number], withTitle: boolean): string => `${L(lang, `第${entry.chapter.index}章`, `Ch. ${entry.chapter.index}`)}${withTitle ? `《${entry.chapter.plan.title}》` : ''}`
    const line = (entry: typeof single[number], withTitle: boolean, full: boolean): string => entry.memory !== undefined ? renderSummary(entry.memory, label(entry, withTitle), full) : `${label(entry, withTitle)}  ${entry.chapter.plan.synopsis!}`
    const cap = share(inWindow.length === 0 ? 0.5 : 0.3)
    let story = [...arcLines, ...single.map(entry => line(entry, true, true))].join('\n')
    // Too long for its share: the older chapters shrink to a line each, the nearest few keep their summaries.
    if (estimateTokens(story) > cap) story = [...arcLines, ...single.map((entry, position) => line(entry, false, position >= single.length - 3))].join('\n')
    summaries = usable.length + single.length
    take('earlier', inWindow.length > 0 ? L(lang, `前情梗概（第 ${windowFrom} 章之前）`, `The story before chapter ${windowFrom}, in outline`) : L(lang, '前情提要', 'The story so far'), story, cap)
  }

  if (chosen !== undefined && chosen.summaries.length > 0) {
    // The chapters whoever prepared this wants told, each by its summary — before the one in hand or after it.
    const wanted = new Set(chosen.summaries)
    const told = path.filter(chapter => wanted.has(chapter.plan.id) && chapter.plan.id !== current?.plan.id && !takenWhole.has(chapter.plan.id)).flatMap((chapter) => {
      const said = memoryOf.get(chapter.plan.id)?.summary ?? chapter.plan.synopsis
      return said !== undefined && said.trim().length > 0 ? [`${L(lang, `第${chapter.index}章`, `Ch. ${chapter.index}`)}《${chapter.plan.title}》  ${said.trim()}`] : []
    })
    summaries = told.length
    take('earlier', L(lang, '相关章节的梗概', 'The chapters that bear on this, in outline'), told.join('\n'))
  }

  // ── the text itself ──
  if (inWindow.length > 0) {
    const blocks: string[] = []
    for (const chapter of inWindow) blocks.push(await blockOf(chapter))
    // Named by where it starts only: the same heading when the next chapter is added to its end.
    place('story', free ? L(lang, '前文原文（为这一次挑出来的章节，按顺序）', 'Earlier chapters, word for word (the ones chosen for this, in order)') : first === 0 ? L(lang, '前文正文（从第一章起，按顺序）', 'The text so far (from the first chapter, in order)') : L(lang, `前文正文（从第 ${inWindow[0]!.index} 章起，按顺序）`, `The text so far (from chapter ${inWindow[0]!.index} on, in order)`), blocks.join('\n\n———\n\n'))
  }
  // (Chosen for one piece of work, only the book and the world's core are what the next piece shares.)
  const stableKeys = free ? ['project', 'world'] : ['project', 'world', 'people', 'earlier', 'story']

  // ── what belongs to this piece of work ──
  // (A revision that goes on from changes still waiting reads the chapter as it would stand with them in.)
  // The chapter a revision rewrites travels as it stands, picture lines and all: what comes back is the whole chapter,
  // and they are to be in it where they were. Read, reviewed or gone on from, it is prose like the others.
  const currentText = current === undefined || options.includeChapterText !== true
    ? ''
    : options.purpose === 'revise' ? options.chapterText ?? await project.chapterText(current.plan.id) : proseOnly(options.chapterText ?? await textOf(current))
  const previous = written.at(-1)
  const previousText = previous !== undefined ? await textOf(previous) : ''

  if (later.length > 0) {
    const whole: string[] = []
    for (const chapter of followingWhole) whole.push(await blockOf(chapter))
    // (Chosen: of what follows and was not taken whole, the chapter this one leads into is told — it has to be led into, whoever chose.)
    const restOf = free ? later.filter(chapter => !takenWhole.has(chapter.plan.id) && !(chosen?.summaries ?? []).includes(chapter.plan.id)).slice(0, 1) : later.slice(followingWhole.length)
    const outlineOf = (free && !withFollowing ? [] : restOf).map((chapter) => {
      const memory = memoryOf.get(chapter.plan.id)
      return `${heading(chapter)}  ${memory?.summary ?? chapter.plan.synopsis ?? L(lang, '（已有正文，尚无摘要）', '(written, not yet summarized)')}`
    })
    const note = withFollowing
      ? L(lang, '这一章之后的章节已经写好了。本章必须接得上它们：不得与下文已经发生的事相矛盾，也不要把下文的情节提前写掉。', 'The chapters after this one are already written. This chapter has to lead into them: nothing in it may contradict what happens there, and nothing of it may be told ahead.')
      : L(lang, '这一章之后已经写好的章节：', 'The chapters already written after this one:')
    if (whole.length > 0) place('following', L(lang, '下文正文（本章之后，按顺序）', 'The text that follows (after this chapter, in order)'), `${note}\n\n${whole.join('\n\n———\n\n')}`)
    if (outlineOf.length > 0) take('followingOutline', whole.length > 0 ? L(lang, '再往后的章节（梗概）', 'Further on (in outline)') : L(lang, '下文梗概（本章之后已经写好的章节）', 'What follows, in outline (chapters already written after this one)'), `${whole.length > 0 ? '' : `${note}\n\n`}${outlineOf.join('\n')}`, share(0.12))
  }

  // Chapters that come before this one and are not written yet — being written beside it, or left for later: what their
  // outlines say, so that this chapter follows from where they are to leave the story and does not tell their part.
  if (current !== undefined && (options.purpose === 'draft' || options.purpose === 'continue' || options.purpose === 'derive')) {
    const gap = before.filter(chapter => chapter.plan.id !== current.plan.id && (texts.get(chapter.plan.id) ?? '').length === 0 && (chapter.plan.synopsis !== undefined || (chapter.plan.beats ?? []).length > 0))
    if (gap.length > 0) {
      const told = gap.map(chapter => `${heading(chapter)}  ${chapter.plan.synopsis ?? chapter.plan.beats!.map(beat => beat.summary).join(lang === 'zh' ? '；' : '; ')}`)
      take('gap', L(lang, '排在本章之前、还没有写出来的章节（按章纲）', 'Chapters before this one that are not written yet (by their outlines)'), `${L(lang, '这些章节的正文还没有（可能正在同时写）。本章接在它们章纲写的结果之后：不要重写它们的内容，也不要与它们的章纲相矛盾。', 'Their text is not there yet (they may be being written at this moment). This chapter follows from what their outlines say happens: do not tell their part again, and do not contradict their outlines.')}\n\n${told.join('\n')}`, share(0.12))
    }
  }

  // Who is in this chapter: named by the task and the plan, or found in the text around it.
  const asked = [options.brief, options.focus, planText].filter(Boolean).join('\n')
  const signals = [asked, clipTail(currentText, 4000, ''), clipTail(previousText, 1500, '')].filter(Boolean).join('\n')
  const cast = new Map<string, CharacterCard>()
  const called = (card: CharacterCard, ref: string): boolean => sameName(card.name, ref) || card.aliases?.some(alias => sameName(alias, ref)) === true
  const addCast = (ref: string | undefined): void => {
    if (ref === undefined) return
    // This line's own first; somebody of another line is wanted here once the plan or the task names them.
    const card = everyone.find(candidate => candidate.id === ref) ?? characters.find(candidate => called(candidate, ref)) ?? everyone.find(candidate => called(candidate, ref))
    if (card !== undefined) cast.set(card.id, card)
  }
  for (const ref of options.characters ?? []) addCast(ref)
  // Chosen: whoever was named for this piece, and nobody found by their name standing somewhere near it.
  for (const ref of chosen?.people ?? []) addCast(ref)
  if (!free) {
    if (current !== undefined) {
      addCast(current.plan.pov)
      for (const ref of current.plan.characters ?? []) addCast(ref)
      for (const beat of current.plan.beats ?? []) for (const ref of beat.characters ?? []) addCast(ref)
    }
    for (const card of detectCharacters(signals, characters)) cast.set(card.id, card)
    // Named in the plan or in the task itself, somebody of another line comes in too — unless one of this line's people answers to that name.
    for (const card of detectCharacters(asked, everyone.filter(candidate => !scope.has(candidate)))) {
      if (![card.name, ...(card.aliases ?? [])].some(name => characters.some(own => called(own, name)))) cast.set(card.id, card)
    }
    // A book with no declared cast for the task still needs its leads in view.
    if (cast.size === 0) for (const card of characters.filter(candidate => candidate.role === 'protagonist' || candidate.role === 'deuteragonist').slice(0, 4)) cast.set(card.id, card)
  }
  const castList = [...cast.values()].sort((left, right) => ROLE_RANK[left.role] - ROLE_RANK[right.role])

  // Where each of them stands now — the part of a character that changes with every chapter.
  const latestMoment = (card: CharacterCard): string | undefined => {
    for (let i = priorMemories.length - 1; i >= 0; i--) {
      const entry = priorMemories[i]!
      const moment = entry.memory.characters.find(candidate => candidate.character === card.id || sameName(candidate.name, card.name))
      if (moment !== undefined) return renderMoment(moment, chapterLabel(entry.chapter.plan.id), lang)
    }
    return undefined
  }
  const quotesOf = (card: CharacterCard): string[] => {
    const quotes: string[] = []
    for (let i = priorMemories.length - 1; i >= 0 && quotes.length < 2; i--) {
      const moment = priorMemories[i]!.memory.characters.find(candidate => candidate.character === card.id || sameName(candidate.name, card.name))
      if (moment?.quote !== undefined && moment.quote.length > 0) quotes.push(moment.quote)
    }
    return quotes
  }
  const colon = lang === 'zh' ? '：' : ': '
  const castBlocks: string[] = []
  const lineIds = path.map(chapter => chapter.plan.id)
  const stageNote = (card: CharacterCard): string | undefined => {
    const stage = stageAt(card, current?.plan.id, lineIds)
    if (stage === undefined) return undefined
    return [
      `${L(lang, '这一章时', 'At this chapter')}${colon}${stage.title}${stage.age !== undefined ? L(lang, `，${stage.age}`, `, ${stage.age}`) : ''}`,
      stage.appearance !== undefined ? `${L(lang, '样子', 'look')}${colon}${stage.appearance}` : undefined,
      stage.persona !== undefined ? `${L(lang, '为人', 'bearing')}${colon}${stage.persona}` : undefined,
    ].filter((part): part is string => part !== undefined).join(lang === 'zh' ? '；' : '; ')
  }
  for (const card of castList) {
    const moment = latestMoment(card)
    const quotes = quotesOf(card)
    const lines = [
      // Whoever only had a line above is given whole here, where the chapter needs them.
      inFull.has(card.id) ? `【${card.name}】` : renderCharacter(card, lang, { resolveName: nameOf }),
      // The stretch of their life that holds at this chapter: how old they are here, and how they look and stand where that is not what the card says.
      stageNote(card),
      moment !== undefined ? `${L(lang, '当前状态', 'Current state')}${colon}${moment}` : undefined,
      quotes.length > 0 ? `${L(lang, '原文台词参考', 'Lines from the text')}${colon}${quotes.map(quote => `"${quote}"`).join(' ')}` : undefined,
    ].filter((line): line is string => line !== undefined)
    // Nothing to add to the card above: the name alone would say nothing.
    if (lines.length > 1 || !inFull.has(card.id)) castBlocks.push(lines.join('\n'))
  }
  take('cast', free ? L(lang, '人物（卡片，和各人此刻的状态）', 'The people (their cards, and where each stands now)') : L(lang, '本章人物此刻的状态', 'Where the people of this chapter stand now'), castBlocks.join('\n\n'), share(0.2))

  // Who is out of the story by now: on this chapter's own line, and as far as the chapters before it — somebody who dies
  // in chapter 16 is alive to whoever writes chapter 5 again, and alive on a line that parted before. Named whatever the
  // scene: the cheapest guard against a resurrection.
  const told = livesFrom(priorMemories, characters, before, (await project.castResolver()).whose)
  const goneBy = (how: 'death' | 'exit'): string => ranked
    .flatMap((card) => {
      const when = told[card.id]?.[how]
      return when !== undefined ? [`${card.name}${when === 0 ? L(lang, '（故事开始之前）', ' (before the story begins)') : L(lang, `（第${when}章）`, ` (ch. ${when})`)}`] : []
    })
    .join(lang === 'zh' ? '、' : ', ')
  const dead = goneBy('death')
  const left = goneBy('exit')
  take('gone', L(lang, '到这里为止，已经不在故事里的人', 'Out of the story by now'), [
    ...(dead.length > 0 ? [`${L(lang, '已死亡（可以被提起，不能再以活人身份出场）：', 'Dead (may be mentioned, must not appear alive): ')}${dead}`] : []),
    ...(left.length > 0 ? [`${L(lang, '已离开故事（章纲没有安排，就不要让他们回来）：', 'Gone from the story (not to come back unless the outline brings them): ')}${left}`] : []),
  ].join('\n'), share(0.06))

  // Threads the reader is waiting on.
  // This line's own, as they stand at its end: one that was paid off on another line still waits here. The chapters
  // a thread names are this line's only.
  // (For a chapter drafted anew the line's threads are without that chapter's own marks already: see `lineScope`.)
  const openThreads = scope.threads.filter(entry => entry.open).map(({ thread }) => ({
    ...thread,
    ...(thread.planted !== undefined ? { planted: thread.planted.filter(id => scope.reads(id)) } : {}),
    ...(thread.advanced !== undefined ? { advanced: thread.advanced.filter(id => scope.reads(id)) } : {}),
  }))
  if (chosen !== undefined) {
    // The threads named for this piece, as they stand on this line — open or not: whoever named one had a reason.
    const mine = new Set(current?.plan.threads ?? [])
    const named = scope.threads.filter(entry => chosen.threads.includes(entry.thread.id)).map(({ thread }) => ({
      ...thread,
      ...(thread.planted !== undefined ? { planted: thread.planted.filter(id => scope.reads(id)) } : {}),
      ...(thread.advanced !== undefined ? { advanced: thread.advanced.filter(id => scope.reads(id)) } : {}),
    }))
    take('threads', L(lang, '这一次要顾及的线索与伏笔', 'The threads this piece has to mind'), named.map(thread => `${mine.has(thread.id) ? L(lang, '★本章涉及 ', '★ in this chapter ') : ''}${renderThread(thread, lang, chapterLabel)}`).join('\n'))
  } else if (openThreads.length > 0) {
    const mine = new Set(current?.plan.threads ?? [])
    const ordered = [...openThreads.filter(thread => mine.has(thread.id)), ...openThreads.filter(thread => !mine.has(thread.id))]
    take('threads', L(lang, '尚未回收的线索与伏笔', 'Open threads'), ordered.map(thread => `${mine.has(thread.id) ? L(lang, '★本章涉及 ', '★ in this chapter ') : ''}${renderThread(thread, lang, chapterLabel)}`).join('\n'), share(0.08))
  }

  // What is looked up for this chapter: lore it touches, and passages of the chapters that do not travel whole.
  const query = [options.brief, options.focus, current?.plan.synopsis, current?.plan.beats?.map(beat => beat.summary).join(' '), castList.map(card => card.name).join(' ')].filter(Boolean).join('\n').slice(0, 1500)
  let worldEntries = core.length > 0 && coreTokens > 0 ? core.length : 0
  let passages = 0
  let jotted = 0
  if (chosen !== undefined) {
    // What of the world was named for this piece (its core went above), and the stretches of text to hold it against.
    const picked = world.filter(entry => entry.importance !== 1 && chosen.world.includes(entry.id))
    worldEntries += picked.length
    take('lore', L(lang, '用得上的设定', 'What of the world this piece needs'), picked.map(entry => renderWorld(entry, lang)).join('\n\n'))
    const order = new Map(path.map((chapter, position) => [chapter.plan.id, position]))
    const stretches = chosen.excerpts.filter(item => order.has(item.chapter) && item.text.trim().length > 0).sort((left, right) => order.get(left.chapter)! - order.get(right.chapter)!)
    passages = stretches.length
    take('passages', L(lang, '要对着看的原文片段（按章节顺序）', 'Passages to hold this against, word for word (in order)'), stretches.map((item) => {
      const chapter = path[order.get(item.chapter)!]!
      return `〔${heading(chapter)}${item.why !== undefined && item.why.trim().length > 0 ? L(lang, `——${item.why.trim()}`, ` — ${item.why.trim()}`) : ''}〕\n${item.text.trim()}`
    }).join('\n\n'))
  } else if (query.trim().length > 0) {
    const named = world.filter(entry => entry.importance !== 1 && [entry.name, ...(entry.aliases ?? [])].some(name => name.length > 1 && query.includes(name)))
    const hits = await index.search(query, { sources: ['world'], limit: 6, within: (_source, ref) => world.some(entry => entry.id === ref), ...(options.signal !== undefined ? { signal: options.signal } : {}) })
    const picked = new Map<string, WorldEntry>()
    for (const entry of named) picked.set(entry.id, entry)
    for (const hit of hits) {
      const entry = world.find(candidate => candidate.id === hit.ref)
      if (entry !== undefined && entry.importance !== 1 && hit.score > 0.35) picked.set(entry.id, entry)
    }
    if (picked.size > 0) {
      worldEntries += picked.size
      take('lore', L(lang, '与本章相关的设定', 'World: relevant to this chapter'), [...picked.values()].map(entry => renderWorld(entry, lang)).join('\n\n'), share(0.12))
    }
    if (outside.length > 0 || (inWindow.length === 0 && written.length > 0)) {
      const cap = share(0.16)
      const whole = new Set(inWindow.map(chapter => chapter.plan.id))
      const onPath = new Set(written.map(chapter => chapter.plan.id))
      const found = await index.search(query, {
        sources: ['manuscript'],
        limit: Math.max(3, Math.floor(cap / 450)) + whole.size,
        // The chapters of another line take no place among the hits.
        within: (_source, ref) => onPath.has(ref),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      // Only from chapters this line has read and the text above does not already carry; the end of the chapter before travels by itself.
      const usable = found.filter(hit => onPath.has(hit.ref) && !whole.has(hit.ref) && !(inWindow.length === 0 && hit.ref === previous?.plan.id && previousText.length <= options.tailChars))
      const order = new Map(written.map((chapter, position) => [chapter.plan.id, position]))
      const ordered = usable.slice(0, Math.max(3, Math.floor(cap / 450))).sort((left, right) => (order.get(left.ref) ?? 0) - (order.get(right.ref) ?? 0) || (left.offset ?? 0) - (right.offset ?? 0))
      passages = ordered.length
      take('passages', L(lang, '可能相关的更早片段（按章节顺序）', 'Possibly relevant earlier passages (in order)'), ordered.map(hit => `〔${hit.title}〕\n${hit.text}`).join('\n\n'), cap)
    }
  }

  // The author's jottings that bear on this chapter — a turn not thought through, a setting not settled — go along
  // where it is planned or written: found by the same search, among the ones the author lets be found, and only those
  // that share more than a stray word with what the chapter is about. Named for what they are: ideas, not canon.
  if (!free && query.trim().length > 0 && (options.purpose === 'draft' || options.purpose === 'continue' || options.purpose === 'derive')) {
    const noted = await index.search(query, { sources: ['jotting'], limit: 6, ...(options.signal !== undefined ? { signal: options.signal } : {}) })
    if (noted.length > 0) {
      const about = new Set(tokenize(query).filter(term => term.length > 1))
      const found = await foundJottings(project)
      const picked = [...new Set(noted.map(hit => hit.ref))]
        .map(id => found.find(item => item.id === id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined && new Set(tokenize(`${item.title ?? ''}\n${item.text}`).filter(term => about.has(term))).size >= JOTTING_SHARED)
        .slice(0, JOTTINGS_ALONG)
      if (picked.length > 0) {
        jotted = picked.length
        take('jottings', L(lang, '作者的随笔里和这一章沾边的（没想好的想法：用得上就用；不是设定，也不是已经发生的事，和设定、正文对不上时以设定和正文为准）', "The author's jottings that touch this chapter (ideas not settled: use what serves; neither canon nor anything that has happened — where they differ, the bible and the text hold)"), renderJottings(picked, lang), share(0.06))
      }
    }
  }

  // What comes next on a line is planned knowing what the stretches before it were meant to be: their key, their intent.
  if (current === undefined && options.purpose === 'derive' && records.length > 0) {
    const made = renderLineIntents(records, before.map(chapter => ({ id: chapter.plan.id, index: chapter.index, title: chapter.plan.title, written: false })), lang)
    if (made !== undefined && take('intents', lineIntentsTitle(lang), made.text, share(0.08)) > 0) intent = made.records
  }

  // The volume the chapter is in: what it is about and where it must leave the story — to steer by, not to write ahead.
  // (A chapter of another line is in a volume only as far as where that line leaves the main one: none goes with it.)
  if (current !== undefined && planned && current.line === undefined) {
    const volume = current.volume
    const told = [
      (volume.synopsis?.trim() ?? '').length > 0 ? `${L(lang, '梗概', 'Synopsis')}${colon}${volume.synopsis!.trim()}` : '',
      (volume.goal?.trim() ?? '').length > 0 ? `${L(lang, '要把故事带到哪里', 'Where it must leave the story')}${colon}${volume.goal!.trim()}` : '',
    ].filter(line => line.length > 0)
    if (told.length > 0) take('volume', L(lang, `本卷「${volume.title}」（这一章所在的卷：用来把握方向；本章之后的事不要提前写）`, `This volume, "${volume.title}" (the one the chapter is in: to steer by — what comes after this chapter is not written ahead)`), told.join('\n'), share(0.08))
  }

  // Where the story goes next, so the writer does not pre-empt it — unless the text that follows already says so.
  if (current !== undefined && followingWhole.length === 0 && (options.purpose === 'draft' || options.purpose === 'continue')) {
    const next = path.find(chapter => chapter.index === current.index + 1)
    if (next?.plan.synopsis !== undefined) {
      take('next', L(lang, '下一章预告（只用于把握收束，不要提前写）', 'Next chapter (for landing this one only — do not write it)'), `${next.plan.title}${colon}${next.plan.synopsis}`, 400)
    }
  }
  // Whoever lays out this chapter's beats leads them to where the next chapter's outline begins — where that one is not written yet (one that is, is told above).
  if (current !== undefined && options.purpose === 'derive') {
    const next = path.find(chapter => chapter.index === current.index + 1)
    if (next?.plan.synopsis !== undefined && (texts.get(next.plan.id) ?? '').length === 0) {
      take('next', L(lang, '下一章的章纲（这一章的节拍要引到那里；它的事不要提前排掉）', "The next chapter's outline (this chapter's beats lead there; what is its to tell is not told ahead)"), `${next.plan.title}${colon}${next.plan.synopsis}`, 400)
    }
  }

  // With no chapter whole, the end of the one before still travels word for word. (Chosen: where the chapter before
  // was not taken whole and this piece begins or goes on the chapter, or writes it over — it has to join there.)
  const joins = options.purpose === 'draft' || options.purpose === 'continue' || (options.purpose === 'revise' && options.includeChapterText === true)
  if ((free ? joins && previous !== undefined && !takenWhole.has(previous.plan.id) : inWindow.length === 0) && previousText.length > 0) {
    take('tail', L(lang, `上一章《${previous!.plan.title}》结尾原文`, `End of the previous chapter, "${previous!.plan.title}"`), clipTail(previousText, options.tailChars))
  }
  if (currentText.length > 0) {
    const room = Math.max(1000, side - 200)
    // A chapter that is gone on from is read for where it stops: its end is what has to be there. A chapter that is
    // revised or reviewed is the work itself, and travels whole whatever is left of the budget — cut to its end, it
    // was written over, or judged, as its last few thousand characters (`ownsChapter`: who packs it makes room).
    const body = ownsChapter(options) || estimateTokens(currentText) <= room ? currentText : clipTail(currentText, Math.max(options.tailChars, Math.floor(currentText.length * room / estimateTokens(currentText))))
    place('current', L(lang, '本章已有正文', 'This chapter so far'), body)
    side -= estimateTokens(body)
  }

  if (chosen !== undefined) {
    const { words } = chosen
    take('asked', L(lang, '这一次要写的（策划的交代）', 'What is to be written this time (the planner\'s brief)'), words.task ?? '')
    take('situation', L(lang, '落笔前要知道的', 'What to know before writing'), words.situation ?? '')
    take('keep', L(lang, '不能写错的', 'What must hold'), (words.keep ?? []).filter(item => item.trim().length > 0).map(item => `- ${item.trim()}`).join('\n'))
    take('form', L(lang, '书写格式', 'Form'), words.form ?? '')
    take('voice', L(lang, '文风上这一次要把握的', 'Of the voice, for this piece'), words.voice ?? '')
  }

  const render = (keys: string[]): string => keys.map(key => sections[key]).filter((section): section is Section => section !== undefined).map(section => `## ${section.title}\n\n${section.body}`).join('\n\n')
  const stable = render(stableKeys)
  // Chosen: the brief first, then who and what, then the text to hold it against, then where it joins and how it is to
  // be written; by rule: as it always was. Either way the chapter's own plan is read last.
  const rest = render(free
    ? ['asked', 'situation', 'keep', 'cast', 'gone', 'threads', 'lore', 'earlier', 'story', 'passages', 'gap', 'following', 'followingOutline', 'volume', 'next', 'tail', 'form', 'voice', 'current', 'intent', 'plan']
    : ['gap', 'following', 'followingOutline', 'cast', 'gone', 'threads', 'lore', 'passages', 'jottings', 'intents', 'volume', 'next', 'tail', 'current', 'intent', 'plan'])
  const text = [stable, rest].filter(part => part.length > 0).join('\n\n')
  const stableTokens = estimateTokens(stable)
  return {
    text,
    stable,
    rest,
    tokens: stableTokens + estimateTokens(rest),
    stableTokens,
    // With nothing written yet, all of it travels.
    strategy: free ? 'chosen' : written.length === 0 ? 'full' : inWindow.length === 0 ? 'retrieval' : outside.length === 0 ? 'full' : 'window',
    language: lang,
    cast: castList,
    included: { fullChapters: inWindow.length, summaries, passages, worldEntries, following: followingWhole.length, ...(jotted > 0 ? { jottings: jotted } : {}), ...(intent > 0 ? { intent } : {}) },
    ...(inWindow.length > 0 ? { window: { from: inWindow[0]!.index, to: inWindow.at(-1)!.index } } : {}),
  }
}

function renderSummary(memory: ChapterMemory, label: string, full: boolean): string {
  return `${label}  ${full ? memory.summary : memory.brief}`
}

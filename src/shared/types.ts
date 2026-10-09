// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Domain model of a novel project. Shared by the Host, the agent tools and the
 * browser UI, so this module must stay free of Node and DOM imports.
 *
 * On disk a project is a plain directory (see docs/project-format.md):
 * Markdown for everything a human writes, JSON for structure and machine memory.
 */

import type { Tie } from './ties'

/** ISO-8601 timestamp string. */
export type Timestamp = string

/** Languages the built-in prompts are written in; other values fall back to English prompts. */
export type PromptLanguage = 'zh' | 'en'

// ───────────────────────────── project ─────────────────────────────

export interface ProjectManifest {
  /** On-disk schema version of `novel.json`. */
  schema: 1
  id: string
  title: string
  author?: string
  /** BCP-47-ish language of the manuscript (`zh`, `en`, `ja`, …). */
  language: string
  genre?: string
  /** One-sentence hook. */
  logline?: string
  /** The story's core idea, stakes and promise in a few paragraphs. */
  premise?: string
  themes?: string[]
  /** Planned total length, in words/characters of the manuscript language. */
  targetWords?: number
  /**
   * A length the book recommends for a chapter that names none of its own.
   * Absent: whoever writes the chapter judges its length from what it has to do.
   */
  chapterBudget?: number
  /**
   * Where `chapterBudget` used to live. Every book was stamped with 3000
   * (2500 outside Chinese) here whether its author wanted that or not, so those
   * two figures are no longer read as a wish; see {@link chapterBudgetOf}.
   */
  chapterWords?: number
  /** Id of the style profile used when a task names none. */
  activeStyle?: string
  /**
   * Art direction added to every image prompt so the book keeps one look. While
   * unset, the Studio-wide direction (or the built-in starting point) applies;
   * the first picture drawn for the book writes that text here, so the look is
   * visible, editable and stays put.
   */
  artStyle?: string
  /** Things that must not appear in any picture of this book (objects, motifs, text, styles). */
  artAvoid?: string[]
  /** Project-relative path of the picture shown as the book's cover; the latest cover drawn stands in while unset. */
  cover?: string
  /** How finely this book's motion comics are cut into panels. */
  storyboard?: StoryboardSettings
  /** This book's own models: a role named here runs on it for this book, whatever the Studio-wide settings say. */
  models?: Partial<TextModelRouting>
  /** This book's own way of working its crew: a role named here is set so for this book, whatever the Studio-wide settings say. */
  crew?: CrewSettings
  /** Free-form notes that always travel with the project digest. */
  notes?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ───────────────────────────── story bible ─────────────────────────────

export type CharacterRole = 'protagonist' | 'deuteragonist' | 'antagonist' | 'supporting' | 'minor' | 'cameo'

export interface CharacterRelationship {
  /** Character id, or a free name when the other party has no card yet. */
  target: string
  /** Short label: "师徒", "rival", "ex-lover"… */
  kind: string
  note?: string
}

/** Structured personality: what makes this person choose and speak the way they do. */
export interface CharacterPersona {
  /** Core traits with a rough intensity (1 faint … 5 defining). */
  traits?: { name: string; level?: number }[]
  /** What they would sacrifice for, in priority order. */
  values?: string[]
  /** Verbal habits: catchphrases, register, sentence shape, dialect. */
  speech?: string[]
  /** Lines they would never cross, things they would never say. */
  taboos?: string[]
  /** Typical reactions under pressure. */
  underPressure?: string
}

/** One way a character is dressed and turned out: everyday clothes, armour, mourning dress… */
export interface CharacterLook {
  /** Stable id within the character. */
  id: string
  /** What the author calls it. */
  name: string
  /** What this look changes on top of the character's anchor: clothing, gear, hair worn differently. */
  prompt?: string
  /** When it is worn, in words; read when a scene has to decide what the character wears. */
  when?: string
  /** Project-relative path of the design sheet (front, side and back) of this look. */
  sheet?: string
}

/** A moment of the book a person is remembered by, written as the picture a portrait of it would be. */
export interface SignatureScene {
  /** Stable id within the character. */
  id: string
  /** What the moment is called, in a few words: 葬花. */
  title: string
  /** The chapter it is from, by id. */
  chapter?: string
  /** The moment as a picture, in the language of the book: where, doing what, holding what, the light. */
  text: string
  /** Why it is theirs, in a sentence — the director's, for the author. */
  why?: string
  /** Project-relative path of the portrait drawn of it. */
  portrait?: string
}

export interface CharacterVisual {
  /**
   * The character's visual anchor: a short, concrete, drawable description
   * (build, face, hair, clothing, signature items) restated in every image
   * prompt that shows them. Written for an image model, not for a reader.
   */
  prompt?: string
  /** What must not be drawn on or around this character (things the description tends to evoke by mistake). */
  negative?: string
  /**
   * Project-relative path of the character's design sheet: the same person from
   * the front, the side and the back. It is the reference image sent along
   * whenever the character is drawn again, which is what keeps them the same
   * person from picture to picture.
   */
  sheet?: string
  /** Further looks (outfits), each with a sheet derived from the main one. */
  looks?: CharacterLook[]
  /** Project-relative path of the bust portrait (avatars, the interlude stage); the reference when there is no sheet. */
  portrait?: string
  /**
   * The moments of the book a reader remembers them by, the most their own first — each written as the picture a
   * portrait of it would be. The director finds them in the book; the author reads, rewrites, reorders, adds and
   * removes them, and picks which one a portrait shows.
   */
  scenes?: SignatureScene[]
  /** Which of `scenes` a portrait shows where nothing else is said (by id). Left out: the first. */
  sceneAt?: string
  /** As books of releases 40 and 41 kept it: one moment, as one paragraph. Read as the first of `scenes` where there are none. */
  scene?: string
  /** Emotion → sprite path, used by the interlude (visual-novel) stage. */
  sprites?: Record<string, string>
}

/** `auto` leaves the cutting to the model; the others ask for fewer or more panels. */
export type StoryboardDensity = 'auto' | 'sparse' | 'balanced' | 'dense'

export const STORYBOARD_DENSITIES: readonly StoryboardDensity[] = ['auto', 'sparse', 'balanced', 'dense']

/** How long a picture stays on screen on average, in seconds, for each density that names a pace. */
export const PANEL_SECONDS: Record<Exclude<StoryboardDensity, 'auto'>, number> = { sparse: 26, balanced: 13, dense: 6.5 }

export interface StoryboardSettings {
  density?: StoryboardDensity
  /** The most panels one chapter may be cut into, whatever the density. */
  maxPanels?: number
}

export interface CharacterVoiceProfile {
  /** TTS provider id this voice belongs to. */
  provider?: string
  /** Provider voice id (a stock voice or one designed for this character). */
  voice?: string
  /** Baseline delivery instructions merged into every line. */
  instructions?: string
  /** The description a designed voice was created from. */
  designPrompt?: string
  /** Project-relative path of an audition sample. */
  sample?: string
}

/**
 * Something of a character's life the author wrote down themselves: that they
 * come on, come back, leave for good or die at a chapter — where the digest
 * of that chapter missed it, has it wrong, or was never made. It holds on
 * every line of the plot the chapter is read on, and over what the digest
 * says. Without a chapter it lies before the story begins: somebody dead, or
 * gone, before the first page.
 */
export interface LifeMark {
  /** The chapter it happens in. Absent: before the story begins (`death` and `exit` only). */
  chapter?: string
  kind: 'enter' | 'return' | 'exit' | 'death'
  /** What happened, in a few words. */
  what?: string
}

/**
 * A stretch of a character's life in the book: from a chapter on, how old they are, who they are and how they look.
 * People are not the same from the first chapter to the last — they grow up, marry, take orders, fall — and a card
 * that says one age and one face says it of no chapter in particular. The stretches are found in the book (the
 * planner reads for the points where somebody turns), and the author's to rewrite.
 */
export interface CharacterStage {
  /** Stable id within the character. */
  id: string
  /** What the stretch is called: 幼年 · 入府之后 · 出家之后. */
  title: string
  /** The chapter it begins with, by id. Left out: as they are when the story begins. */
  from?: string
  /** How old they are in it, as the book has it or lets one tell: 约十三岁（少年）. */
  age?: string
  /** What turned at this point, in a sentence. */
  what?: string
  /** How they look in it — for readers and for the writer. Left out: as the card has it. */
  appearance?: string
  /** Who they are in it — station, bearing, temper — where that is not what the card says. */
  persona?: string
  /** Their look in it as an image model is told, with the design sheet and the portrait drawn of it. */
  visual?: { prompt?: string; negative?: string; sheet?: string; portrait?: string }
}

export interface CharacterCard {
  id: string
  name: string
  aliases?: string[]
  role: CharacterRole
  /** One-line identity: who they are in the story. */
  tagline?: string
  gender?: string
  age?: string
  appearance?: string
  personality?: string
  background?: string
  /** What they want, and what they actually need. */
  motivation?: string
  flaw?: string
  /** Planned change across the story. */
  arc?: string
  /** How they sound in prose dialogue. */
  voice?: string
  abilities?: string
  /** Known to the author, hidden from other characters or the reader. */
  secrets?: string
  persona?: CharacterPersona
  relationships?: CharacterRelationship[]
  tags?: string[]
  /** Chapter id of the first and latest on-page appearance (maintained by digest). */
  firstAppearance?: string
  lastAppearance?: string
  /** Their life on the page in a paragraph: where they come on, what they go through, how they leave — written from the chapter digests, and the author's to edit. */
  life?: string
  /** What the author wrote down of their life themselves, one mark a chapter at most: it holds over the digests (`Project.markLife`). */
  lifeMarks?: LifeMark[]
  /** The stretches of their life in the book, in the order they come: how old, who and how they look from which chapter on. */
  stages?: CharacterStage[]
  /** The lines of the plot they belong to, by id (`main` for the main line). Left out: every line — the world is shared, and so is whoever is in it. */
  lines?: string[]
  visual?: CharacterVisual
  voiceProfile?: CharacterVoiceProfile
  /** Free-form Markdown body below the front matter. */
  notes?: string
  updatedAt?: Timestamp
}

/**
 * Something that happens to a place, a house or a thing at a chapter of the
 * story: it comes to be, it changes — hands, name, shape —, it falls into
 * decline, it is no more. What a place's page tells as its course, and what
 * decides whether it stands at a chapter the story is looked at.
 */
export interface WorldEvent {
  /** The chapter it happens in. */
  chapter: string
  /** `begin`: built, founded, made, first there. `change`: another owner, name or shape. `decline`: left to ruin, fallen from what it was. `end`: destroyed, lost, dissolved. */
  kind: 'begin' | 'change' | 'decline' | 'end'
  /** What happened, in a few words. */
  what: string
  /** A picture of the place or the thing as it is from this on — built, changed, in ruins: what the viewer shows when the story is looked at from here. */
  image?: string
}

export const WORLD_EVENT_KINDS: readonly WorldEvent['kind'][] = ['begin', 'change', 'decline', 'end']

/**
 * A course written anew, with the pictures of the turns it keeps. A turn is the
 * same turn by its chapter and its kind: reworded, it is still drawn as it was.
 * For whoever rewrites a course in words alone; a list that means to take a
 * picture away is saved as it is.
 */
export function withTurnPictures(course: readonly WorldEvent[], before: readonly WorldEvent[] | undefined): WorldEvent[] {
  return course.map((turn) => {
    if (turn.image !== undefined) return turn
    const drawn = before?.find(other => other.chapter === turn.chapter && other.kind === turn.kind)?.image
    return drawn !== undefined ? { ...turn, image: drawn } : turn
  })
}

export type WorldCategory =
  | 'setting' | 'location' | 'faction' | 'system' | 'item' | 'history' | 'culture' | 'rule' | 'term' | 'other'

export interface WorldEntry {
  id: string
  name: string
  aliases?: string[]
  category: WorldCategory
  /** The lines of the plot it belongs to, by id (`main` for the main line). Left out: every line. */
  lines?: string[]
  /** 1 = core canon that always travels in context, 2 = normal, 3 = detail fetched on demand. */
  importance: 1 | 2 | 3
  /**
   * How much of the story the entry carries, when the author says: `core`,
   * `major`, `minor`, or passed `once`. Left out, it is read off where the
   * chapters name it (`shared/world.ts`). Not `importance`, which is about
   * how the entry travels to a model.
   */
  weight?: 'core' | 'major' | 'minor' | 'once'
  summary?: string
  /** Ids of related entries. */
  related?: string[]
  tags?: string[]
  /** What a picture of it shows: a place (the background of comics and interludes), a thing (its shape, material, marks). */
  visualPrompt?: string
  /** Project-relative path of its design picture — a place's, a thing's; sent along when a scene is set there or shows it. */
  visualImage?: string
  /**
   * Where on that picture the marks of what stands in the place were put by
   * the author: by `world:<id>` or `character:<id>`, as fractions of the
   * picture's width and height. What is not here is laid out by itself (`shared/scene.ts`).
   */
  spots?: Record<string, { x: number; y: number }>
  /** What happens to it over the story, chapter by chapter: built, changed, in decline, gone (`WorldEvent`). */
  events?: WorldEvent[]
  /** Free-form Markdown body. */
  body?: string
  updatedAt?: Timestamp
}

/**
 * What a look over the bible's entries found: the same thing written down more
 * than once, and entries filed under the wrong kind. A proposal — nothing is
 * changed until the author says which of it to go by.
 */
export interface WorldTidy {
  same: { keep: { id: string; name: string }; others: { id: string; name: string }[]; why?: string }[]
  kinds: { id: string; name: string; from: WorldCategory; to: WorldCategory; why?: string }[]
  /** How many entries were looked over. */
  entries: number
}

export type NarrativePov = 'first' | 'third-limited' | 'third-omniscient' | 'second' | 'multi'

export interface StyleExemplar {
  label?: string
  text: string
}

export interface StyleProfile {
  id: string
  name: string
  pov?: NarrativePov
  tense?: 'past' | 'present'
  /** Emotional temperature and attitude of the narration. */
  tone?: string
  /** Word choice and register. */
  diction?: string
  /** Sentence length, paragraphing, cadence. */
  rhythm?: string
  /** Density and kind of imagery / rhetoric. */
  imagery?: string
  /** How dialogue is written and attributed. */
  dialogue?: string
  pacing?: string
  /** Positive rules the writer must follow. */
  rules?: string[]
  /** Words, clichés and habits to avoid. */
  avoid?: string[]
  /** Reference passages that show the target touch. */
  exemplars?: StyleExemplar[]
  /** Free-form Markdown description. */
  body?: string
  updatedAt?: Timestamp
}

// ───────────────────────────── outline ─────────────────────────────

export type ChapterStatus = 'idea' | 'outlined' | 'drafted' | 'revised' | 'final'

export interface Beat {
  id: string
  summary: string
  characters?: string[]
  location?: string
  /** What stands in the way. */
  conflict?: string
  /** How the beat turns. */
  outcome?: string
  emotion?: string
}

export interface ChapterPlan {
  id: string
  title: string
  synopsis?: string
  /** What this chapter does for the book: plot, character, payoff, setup. */
  purpose?: string
  /** Character id whose point of view carries the chapter. */
  pov?: string
  location?: string
  /** Story time ("第三天夜里", "1921-04"). */
  time?: string
  /** Character ids planned to appear. */
  characters?: string[]
  /** Thread ids this chapter plants, advances or pays off. */
  threads?: string[]
  beats?: Beat[]
  status: ChapterStatus
  /** A length recommended for this chapter. Absent: the book's own recommendation, else whoever writes it judges. */
  targetWords?: number
  notes?: string
}

export interface Volume {
  id: string
  title: string
  synopsis?: string
  /** Where the volume must leave the story. */
  goal?: string
  chapters: ChapterPlan[]
}

export type ThreadKind = 'foreshadow' | 'mystery' | 'subplot' | 'promise' | 'motif'
export type ThreadStatus = 'open' | 'paid' | 'dropped'

/** A long-running line the reader is waiting on: a planted gun, a mystery, a promise. */
export interface PlotThread {
  id: string
  title: string
  kind: ThreadKind
  status: ThreadStatus
  description?: string
  /** Chapter ids where it was planted / advanced / paid off. */
  planted?: string[]
  advanced?: string[]
  paid?: string[]
  /** True when digest proposed it and nobody confirmed it yet. */
  auto?: boolean
}

/** The chapter lengths every book used to be stamped with at creation, by language; nobody chose them. */
const STAMPED_CHAPTER_WORDS = [3000, 2500]

/**
 * The length a book recommends for a chapter, when its author set one.
 * A figure in the old place counts only when it is not one of the stamps.
 */
export function chapterBudgetOf(manifest: Pick<ProjectManifest, 'chapterBudget' | 'chapterWords'>): number | undefined {
  const own = manifest.chapterBudget
  if (typeof own === 'number' && own > 0) return Math.round(own)
  const old = manifest.chapterWords
  return typeof old === 'number' && old > 0 && !STAMPED_CHAPTER_WORDS.includes(old) ? Math.round(old) : undefined
}

/** How a line of the plot came about. */
export type PlotLineOrigin = 'author' | 'planner' | 'interlude' | 'replaced' | 'main'

/** The name the main line goes by wherever a line is named. */
export const MAIN_LINE = 'main'

/** Whether a card or an entry belongs to a line of the plot: one that names no lines belongs to all of them. */
export function belongsTo(item: { lines?: string[] | undefined }, line: string | undefined): boolean {
  return item.lines === undefined || item.lines.length === 0 || item.lines.includes(line ?? MAIN_LINE)
}

/**
 * Whether somebody is one of a line's people. Where the author said which lines they belong to, it is as said. Where
 * nothing is said, they belong where they are seen — to the lines whose chapters have them — and to every line as long
 * as no chapter has them yet: a card nobody has written into the story is everybody's to use.
 * @param seen - the lines they are seen on, by id (`main` for the main one), read off the digests.
 */
export function ofLine(card: { lines?: string[] | undefined }, line: string | undefined, seen: readonly string[] | undefined): boolean {
  if (card.lines !== undefined && card.lines.length > 0) return card.lines.includes(line ?? MAIN_LINE)
  return seen === undefined || seen.length === 0 || seen.includes(line ?? MAIN_LINE)
}

/**
 * A line of the plot beside the main one: another way the story goes from
 * some chapter on — or the way it went before it was rewritten. The main line
 * is the outline's volumes; other lines leave it (or each other) after a
 * chapter and may arrive at one again, which makes the plot a graph.
 */
export interface PlotLine {
  id: string
  title: string
  /** What sets this line apart, in a sentence or two. */
  premise?: string
  /** The chapter this line leaves after. Absent: it tells the story another way from the first page. */
  from?: string
  /** What is decided at the end of `from` to go this way — the words a reader who plays the story would choose. */
  choice?: string
  /** The chapters of this line, in order. */
  chapters: ChapterPlan[]
  /** The chapter, on another line, this one arrives at; from there the two are one story again. */
  into?: string
  origin: PlotLineOrigin
  /** The interlude this line grew out of. */
  play?: string
  /** Put aside: kept and shown, not offered when the next chapter is chosen. */
  shelved?: boolean
  createdAt: Timestamp
}

export interface Outline {
  schema: 1
  /** The main line, volume by volume. */
  volumes: Volume[]
  threads: PlotThread[]
  /** The lines beside the main one; absent in a book that has only ever gone one way. */
  lines?: PlotLine[]
}

// ───────────────────────────── manuscript & memory ─────────────────────────────

export interface ChapterInfo {
  id: string
  title: string
  volumeId: string
  /** 1-based position in reading order. */
  index: number
  status: ChapterStatus
  /** Length of the saved text (CJK characters + Latin words). */
  words: number
  hasText: boolean
  updatedAt?: Timestamp
  /** True when the saved memory was extracted from the current text. */
  digested: boolean
  /** Unresolved issues of the latest review; absent when the chapter was never reviewed. */
  openIssues?: number
  /** The line the chapter belongs to, when it is not the main one. */
  line?: string
  /** The recommended length in force for the chapter — its own, else the book's — when there is one. */
  budget?: number
}

/** A line of the plot as a screen needs it: its own chapters with their facts, and the whole way it is read. */
export interface PlotLineInfo {
  id: string
  /** The line's own chapters; `index` is each one's place on the line's path. */
  chapters: ChapterInfo[]
  /** Ids of every chapter read on this line, in order: what comes before it, its own, and what it arrives at. */
  path: string[]
}

export type FactKind = 'state' | 'relationship' | 'knowledge' | 'item' | 'world' | 'event'

export interface MemoryFact {
  subject: string
  statement: string
  kind: FactKind
}

export interface CharacterMoment {
  /** Character id when resolved, otherwise the name as written. */
  character: string
  name: string
  /** What they did or went through in the chapter. */
  role?: string
  /** Condition at chapter end: injuries, mood, resources, resolve. */
  stateAfter?: string
  location?: string
  emotion?: string
  /** What they learned in this chapter. */
  learned?: string[]
  /** A line worth keeping as a voice reference. */
  quote?: string
  /** Lifecycle hint detected from the text. */
  lifecycle?: 'enter' | 'exit' | 'death' | 'return'
}

export interface EntityCandidate {
  name: string
  kind: 'character' | 'location' | 'item' | 'faction' | 'term'
  description: string
}

export interface ThreadTouch {
  title: string
  action: 'plant' | 'advance' | 'payoff'
  note?: string
  /** Resolved thread id, when the title matched an existing thread. */
  threadId?: string
}

/** Machine memory extracted from one chapter ("digest"). */
export interface ChapterMemory {
  schema: 1
  chapterId: string
  /** Hash of the text this memory was extracted from. */
  textHash: string
  updatedAt: Timestamp
  /** One line. */
  brief: string
  /** A few hundred characters. */
  summary: string
  storyTime?: string
  locations?: string[]
  facts: MemoryFact[]
  characters: CharacterMoment[]
  newEntities: EntityCandidate[]
  threads: ThreadTouch[]
  openQuestions?: string[]
}

/** A suggestion produced by analysis that waits for a human or the orchestrator to accept. */
/** The passes that read an imported book and write down what it says; see `analyzeBook`. */
export type AnalyzeStep = 'digest' | 'cast' | 'growth' | 'world' | 'ties' | 'outline' | 'style' | 'art'
/**
 * In the order they run. Two came later than the others, and an analysis
 * started before one of them existed is whole without it: `art` — the look of
 * the book's pictures — and `ties` — how its people, places, houses and
 * things stand to each other, and what happens to the places over the story.
 */
export const ANALYZE_STEPS: readonly AnalyzeStep[] = ['digest', 'cast', 'growth', 'world', 'ties', 'outline', 'style', 'art']

/**
 * The passes an analysis has to do, by the form of the note it left when it
 * was started: 1 — the first five; 2 — with `art`; 3 — with `ties`; 4 — with `growth` (how the people of the book
 * change along it: their ages and the points where they turn).
 */
export function analysisSteps(schema: number | undefined): AnalyzeStep[] {
  const form = schema ?? 1
  return ANALYZE_STEPS.filter(step => (step !== 'art' || form >= 2) && (step !== 'ties' || form >= 3) && (step !== 'growth' || form >= 4))
}

export interface Suggestion {
  id: string
  /**
   * `bible-edit`: a field of a character card or a world entry should read otherwise — found while a problem was being traced through the book.
   * `alias`: a name the page uses is another name of somebody who has a card (`payload.name`, `payload.target`: the card's id).
   */
  kind: 'new-character' | 'new-world' | 'new-thread' | 'thread-status' | 'bible-edit' | 'alias'
  title: string
  detail: string
  /** Put here by the planner after it looked through the names without a card: `detail` is its reason. */
  sifted?: true
  /** Chapter that triggered it. */
  chapterId?: string
  /** Payload applied on accept. */
  payload: Record<string, unknown>
  createdAt: Timestamp
}

export interface VersionInfo {
  id: string
  chapterId: string
  createdAt: Timestamp
  /** Why the snapshot was taken: "before-revise", "manual", "before-import"… */
  reason: string
  words: number
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected'

/** A change to the manuscript that waits for review. */
export interface Proposal {
  id: string
  chapterId: string
  kind: 'span' | 'chapter'
  status: ProposalStatus
  /** The instruction that produced it. */
  instruction: string
  rationale?: string
  /** Exact text being replaced (whole chapter text for `chapter`). */
  before: string
  after: string
  /** Groups proposals created by one global revision. */
  batchId?: string
  /** The review issues it was made to mend, by id: it is shown beneath them, to be accepted or rejected there. */
  issues?: string[]
  /**
   * Made on top of changes that were still waiting — a mending that goes on from the ones before it: the proposals it
   * took in and stands for now (accepting it accepts them), and the batches those belonged to, so that an issue handed
   * over with one of them still finds what mends it.
   */
  supersedes?: string[]
  batches?: string[]
  /** Taken into a later proposal that goes on from it: settled by that one. */
  supersededBy?: string
  createdBy: 'agent' | 'user'
  createdAt: Timestamp
}

export type IssueSeverity = 'high' | 'medium' | 'low'
export type IssueType = 'continuity' | 'character' | 'world' | 'timeline' | 'style' | 'pacing' | 'logic' | 'language'

export interface ReviewIssue {
  id: string
  severity: IssueSeverity
  type: IssueType
  /** Exact quote from the chapter the issue anchors to, when there is one. */
  quote?: string
  explanation: string
  suggestion?: string
  resolved?: boolean
  /** What the author says of how to mend it, in their words; it goes with the issue to whoever mends it. */
  note?: string
  /** It was handed over to be mended — the batch of proposals that came of it — and waits on those proposals. */
  mending?: string
  /** Looked at again after the text changed: what was found — that the change settled it, or how it reads now. */
  checked?: { at: Timestamp; verdict: 'fixed' | 'stands' | 'changed'; why?: string }
}

export interface ChapterReview {
  chapterId: string
  textHash: string
  createdAt: Timestamp
  verdict: string
  issues: ReviewIssue[]
}

// ───────────────────────────── retrieval ─────────────────────────────

export type SearchSource = 'manuscript' | 'character' | 'world' | 'memory' | 'outline'

export interface SearchHit {
  source: SearchSource
  /** Chapter id, character id, world entry id… */
  ref: string
  title: string
  text: string
  score: number
  /** Character offset inside the chapter text for manuscript hits. */
  offset?: number
}

// ───────────────────────────── models & settings ─────────────────────────────

/**
 * Where a text role's calls go. Without `baseURL` it is a model configured in
 * the Harness (Settings → Models) and `provider` is that route's id. With
 * `baseURL` the Studio calls an OpenAI-compatible endpoint of its own and
 * `provider` only labels the service (`bailian`, `openrouter`, `custom`…).
 */
export interface ModelRoute {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  /** A level of the model's own vocabulary (Harness routes) or one of `off|minimal|low|medium|high|xhigh` (direct endpoints). */
  reasoningEffort?: string
  /** OpenAI-compatible root (`…/v1`) of a direct endpoint. */
  baseURL?: string
  /** Context window of the model in tokens, when the Studio cannot learn it from the endpoint. */
  contextWindow?: number
  /** Read the key from this environment variable / Harness credential instead of the one saved for the endpoint. */
  apiKeyRef?: string
  /** Set by the Studio on the route it resolved for a call — which role and book the call serves — so usage can be told apart. Never saved. */
  for?: { role: TextRole; book?: string; title?: string }
}

export interface TextModelRouting {
  /** Writes and rewrites prose. */
  writer?: ModelRoute
  /** Summaries, extraction, checks — fast and literal. */
  analyst?: ModelRoute
  /** Plot derivation and brainstorming. */
  architect?: ModelRoute
  /** Stages finished chapters: audio scripts, storyboards, real-time interlude turns. */
  director?: ModelRoute
  /** Post-production: cuts prepared voice, sound and pictures into a video, with a shell at hand. */
  producer?: ModelRoute
}

export type TextRole = keyof TextModelRouting

/**
 * The roles that work as agents: each a persona, tools, skills and permissions
 * of its own on the Harness's agent loop. The writer is not one of them — it
 * writes, and has nothing to look up or to call.
 */
export type CrewRole = Exclude<TextRole, 'writer'>

export const CREW_ROLES: readonly CrewRole[] = ['analyst', 'architect', 'director', 'producer']

export interface CrewRoleSettings {
  /**
   * `agent` (default): the role works as an agent, with tools, and its run is
   * listed under the conversation that asked for it. `call`: one request, one
   * answer, as it was before there were agents — cheaper, and blind.
   */
  mode?: 'agent' | 'call'
  /**
   * `own` (default): the tools the Studio gives the role, and the few of the
   * Harness's that its work calls for (the planner searches the web,
   * post-production has a shell). `all`: every tool the conversation itself has.
   */
  tools?: 'own' | 'all'
  /** Tool calls a run may make before it is told to wrap up. */
  steps?: number
}

export interface CrewSettings {
  analyst?: CrewRoleSettings
  architect?: CrewRoleSettings
  director?: CrewRoleSettings
  producer?: CrewRoleSettings
}

export type ContextStrategy = 'auto' | 'retrieval' | 'full'

export interface ContextSettings {
  /**
   * `full` sends the whole manuscript when it fits, `retrieval` always packs by
   * relevance, `auto` picks per call from the model's context window.
   */
  strategy: ContextStrategy
  /**
   * Tokens of the manuscript's own text that travel word for word — the
   * chapters before the one in hand, and after it when it is being rewritten.
   * Unset: half of the window of the model that does the work.
   */
  budgetTokens?: number
  /** How many characters of the preceding text are always included verbatim. */
  tailChars: number
  /**
   * Tokens for everything beside the story's text: the bible, the cast, open
   * threads, lore and retrieved passages. Unset: 22 % of the model's window,
   * 120,000 at most.
   */
  sideTokens?: number
  /**
   * Tokens of context an interlude's turn carries: a turn has to answer while
   * the player waits. Unset: {@link PLAY_CONTEXT_DEFAULT}.
   */
  playTokens?: number
}

/** What a turn of an interlude carries when the author has set no figure of their own. */
export const PLAY_CONTEXT_DEFAULT = 24_000

/** How many requests of one kind run at once when the author has set no number of their own. */
export const PARALLEL_DEFAULT = 8
/** The most a number of parallel requests may be set to. */
export const PARALLEL_MAX = 256

/** A number of parallel requests as the settings hold it, brought into range; the default when none is set. */
export function parallelOf(value: unknown): number {
  const wanted = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  return Number.isFinite(wanted) && wanted >= 1 ? Math.min(PARALLEL_MAX, Math.round(wanted)) : PARALLEL_DEFAULT
}

/**
 * `openrouter` is OpenRouter's `/images` endpoint, `openai` any OpenAI-compatible
 * `/images/generations`, `dashscope` Aliyun Bailian's native image models, and
 * `codex` the image generation of a ChatGPT subscription (no key of its own).
 */
/** `comfyui` and `diffusers` draw on the author's own machine: a running ComfyUI server, or the Diffusers library in their Python. */
export type ImageProviderKind = 'dashscope' | 'openai' | 'openrouter' | 'codex' | 'comfyui' | 'diffusers' | 'none'
/** How a ChatGPT subscription is reached: the Codex Connect plugin, the local Codex CLI, or whichever is signed in. */
export type CodexBridgeKind = 'auto' | 'connect' | 'cli'
export interface ImageSettings {
  provider: ImageProviderKind
  baseURL?: string
  /** Read the key from this environment variable / Harness credential instead of the one saved for the endpoint. */
  apiKeyRef?: string
  model?: string
  /** `low`, `medium`, `high` or `auto`, for endpoints that take a quality. */
  quality?: string
  /**
   * `openai`: whether the endpoint is a server of the author's own — a model on their machine or their network behind
   * `/v1/images/generations`. Such a server is asked for one picture at a time, at one of the sizes it draws (`sizes`),
   * with a model, a prompt, a count of one and a size and nothing else; it is waited for as long as it says when it is
   * busy (`429` with `Retry-After`), and needs no key unless it asks for one. Unset: judged by the address — this
   * machine, a private network — unless the model is one of OpenAI's.
   */
  local?: boolean
  /**
   * `openai`: the sizes the endpoint draws, as `WIDTHxHEIGHT`; a picture is asked for at whichever is nearest in shape.
   * Unset: for a server of the author's own, 768x768, 768x512 and 512x768; for GPT Image, its own three; for anything
   * else, the size wanted as it is.
   */
  sizes?: string[]
  /** `codex` only: which bridge to the ChatGPT subscription to use. */
  bridge?: CodexBridgeKind
  /**
   * `comfyui`: the workflow to run — the path of a file exported from ComfyUI in API format, or that JSON itself. The
   * Studio fills in `%prompt%`, `%negative_prompt%`, `%width%`, `%height%`, `%seed%`, `%steps%`, `%scale%` and
   * `%model%`. Left out: a plain text-to-image graph for the checkpoint named under `model`.
   */
  workflow?: string
  /** `comfyui`: the workflow for a picture that has reference pictures to hold to; it loads them as `%image1%`, `%image2%`, …. Left out: reference pictures do not go along. */
  editWorkflow?: string
  /**
   * `comfyui`, with no workflow named and a `model` that is a diffusion model alone (the server's `diffusion_models`, not
   * a checkpoint): the text encoder and the VAE it is loaded with, and the kind the encoder is loaded as (CLIPLoader's
   * `type`: `qwen_image`, `flux2`, `sd3`…). Left out, the Studio takes what the server leaves no choice about.
   */
  textEncoder?: string
  vae?: string
  encoderType?: string
  /** `diffusers`: the Python to run — one that has `diffusers` and `torch`. Left out: `python3` (`python` on Windows). */
  python?: string
  /** `diffusers`: `cuda`, `mps`, `cpu`; left out, the best there is. */
  device?: string
  /** `diffusers`: `float16`, `float32`, `bfloat16`; left out, float16 on CUDA and float32 elsewhere. */
  dtype?: string
  /** `comfyui`, `diffusers`: sampling steps. Left out: 25 for the built-in ComfyUI graph, the pipeline's own for Diffusers. */
  steps?: number
  /** `comfyui`, `diffusers`: guidance scale (CFG). Left out: 7 for the built-in ComfyUI graph, the pipeline's own for Diffusers. */
  guidance?: number
  /** `1024x1024`, `1280x720`… What a picture of no particular kind is drawn at; each kind the Studio draws has its own shape (see `aspects`). */
  size?: string
  /** How fine pictures are drawn: `720p` (the default), `1080p`, `2k`, `4k` — as many pixels as a screen of that name, in whatever shape. */
  resolution?: string
  /** The shape of each kind of picture — `cover`, `portrait`, `sheet`, `location`, `scene`, `panel` — as an aspect (`16:9`) or exact pixels (`1600x900`). Unset: a cover stands, a stage lies. */
  aspects?: Partial<Record<string, string>>
  /** Style phrase appended to every prompt so a book keeps one look. */
  stylePrompt?: string
  negativePrompt?: string
  /** Pictures drawn at once, over everything the Studio is doing ({@link PARALLEL_DEFAULT} when unset). */
  concurrency?: number
  /**
   * How many reference images go along with one picture — design sheets of the
   * people in it, the art of the place. Unset: {@link REFERENCES_DEFAULT},
   * which every image model that takes references at all accepts; models that
   * take more hold more faces steady.
   */
  references?: number
  /**
   * Draw somebody's design sheet before any picture that shows them, where they have none — always before a portrait,
   * and before a scene, a panel or a cover for whoever comes back in the book. Unset: yes. `false`: pictures are drawn
   * from what there is.
   */
  sheetFirst?: boolean
  /**
   * A portrait asked for with nothing said of it shows the person in their signature scene, which the director picks
   * from the book and keeps on the card (`visual.scenes`). Unset: yes. `false`: such a portrait is plain — facing the
   * viewer, on a plain ground.
   */
  portraitScene?: boolean
}

/** How an author's loose notes on a picture of somebody were sorted. */
export interface SortedNotes {
  /** What went into how the person looks, for every picture from now on. */
  kept: string[]
  /** What holds for this one picture only. */
  once: string[]
  /** What the picture drawn had no place for: a design sheet has no snow and no night. */
  unused: string[]
  /** The direction this one picture was given. */
  picture?: string
  /** Nobody could be reached to sort them: all of it went to this one picture, and nothing into the look. */
  unsorted?: true
}

/**
 * Something about to be drawn, as far as the question "whose design sheet
 * would it draw first" needs to know it: a picture by its kind and target, or
 * the panels of a chapter's storyboard.
 */
export type SheetsAsk =
  | { kind: 'portrait' | 'scene' | 'cover' | 'custom'; target?: string; quote?: string; characters?: string[] }
  | { kind: 'panels'; chapter: string; panels?: string[]; force?: boolean }

/** Reference images per picture when the author has set no number of their own, and the most that can be set. */
export const REFERENCES_DEFAULT = 3
export const REFERENCES_MAX = 10

/** The number of reference images per picture as the settings hold it, brought into range. */
export function referencesOf(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : REFERENCES_DEFAULT
  return Math.max(0, Math.min(REFERENCES_MAX, number))
}

/**
 * `qwen-audiogen` is Bailian's audio generation (qwen-audio-3.1-tts-next: a
 * described or cloned voice per line), `qwen-realtime` an omni model reading
 * over WebSocket, `dashscope` Qwen-TTS with voice design, `openrouter`
 * OpenRouter's `/audio/speech`, `openai` any OpenAI-compatible `/audio/speech`.
 */
export type TtsProviderKind = 'qwen-audiogen' | 'qwen-realtime' | 'dashscope' | 'openrouter' | 'openai' | 'none'
export interface TtsSettings {
  provider: TtsProviderKind
  /** HTTP(S) base for HTTP providers, WS(S) URL for realtime providers. */
  baseURL?: string
  /** Read the key from this environment variable / Harness credential instead of the one saved for the endpoint. */
  apiKeyRef?: string
  model?: string
  /** Sample rate of raw PCM an endpoint answers with, when it does not say (default 24000). */
  sampleRate?: number
  /** Model that speaks designed voices (DashScope voice design). */
  designedVoiceModel?: string
  narratorVoice?: string
  narratorInstructions?: string
  /** Fallback voices by rough casting type. */
  defaultVoices?: { female?: string; male?: string; neutral?: string }
  /** Lines spoken at once, over everything the Studio is doing ({@link PARALLEL_DEFAULT} when unset). */
  concurrency?: number
  /**
   * How many more times a line is spoken when the take does not pass the
   * listening check (cut short, silent, or not in the voice it was cast with).
   * 0 switches the retakes off; the check still marks such lines.
   */
  retakes?: number
  /**
   * What happens to narration that only says who spoke, between two spoken
   * lines: `drop` (default) leaves it unspoken, as an audio drama would; `read`
   * has the narrator read every word, as an audiobook would.
   */
  speechTags?: 'drop' | 'read'
}

/** Where sounds that are not speech come from: effects, music, generated ambience. */
export type SoundProviderKind = 'auto' | 'qwen-audiogen' | 'none'
export interface SoundSettings {
  /**
   * `auto` (default) uses the speech setup when its model can generate sound
   * as well as speech (Bailian audio generation); `none` keeps to the beds the
   * browser synthesizes; `qwen-audiogen` names an endpoint of its own.
   */
  provider: SoundProviderKind
  baseURL?: string
  /** Read the key from this environment variable / Harness credential instead of the one saved for the endpoint. */
  apiKeyRef?: string
  model?: string
  /** Have the director place spot effects (default true). */
  effects?: boolean
  /** Have the director place music (default true). */
  music?: boolean
  /**
   * Where the ambience under a scene comes from: `generate` (default) has the
   * sound model make it from the cue's description; `browser` keeps to the
   * beds the player synthesizes. Without a sound model, and until a bed has
   * been generated, the synthesized one plays in either case.
   */
  beds?: 'generate' | 'browser'
  /**
   * Sounds made at once, when sound has an endpoint of its own. While it rides
   * on the speech setup it shares that setup's number: both ask the same model.
   */
  concurrency?: number
}

export type EmbeddingProviderKind = 'openai' | 'none'
export interface EmbeddingSettings {
  provider: EmbeddingProviderKind
  baseURL?: string
  /** Read the key from this environment variable / Harness credential instead of the one saved for the endpoint. */
  apiKeyRef?: string
  model?: string
  dimensions?: number
}

export interface NovelSettings {
  schema: 1
  models: TextModelRouting
  context: ContextSettings
  image: ImageSettings
  tts: TtsSettings
  /** Effects, music and generated ambience; absent in settings saved before there were any. */
  sound?: SoundSettings
  embedding: EmbeddingSettings
  /** How the crew works: which roles are agents, and what tools each may reach. Absent in settings saved before there was a crew. */
  crew?: CrewSettings
  /**
   * Pieces of text work running at once — a role's run on a script passage, a
   * storyboard, a digest, a review, a chapter's beats — over everything the
   * Studio is doing ({@link PARALLEL_DEFAULT} when unset).
   */
  textConcurrency?: number
  /** Run digest automatically after a chapter is written or revised. */
  autoDigest: boolean
  /** After a proposal is accepted, have the reviewer look again at the issues still open in what changed. Unset: yes. */
  recheckIssues?: boolean
  /** After chapters are digested, have the planner look through the names that have no card yet and say who is worth one. Unset: yes. */
  siftCast?: boolean
  /** Manuscript revisions requested by the agent wait for review instead of applying directly. */
  reviewAgentRevisions: boolean
  /**
   * What happens when the showrunner reaches for a book's own files with raw
   * file tools instead of the novel_* tools, which keep versions, memory and
   * search in step: `guide` (default) refuses and names the tool to use; `ask`
   * puts the question to the author each time; `allow` lets it through — the
   * change is then noticed afterwards, recorded, and memory digested again.
   */
  agentFiles?: 'guide' | 'ask' | 'allow'
  /** The reader served to other devices on the local network. */
  share?: ShareSettings
  /** First-run guide: when it was completed or put aside, so it only opens by itself once. */
  setup?: { done?: boolean; at?: string }
  /** What the author pays per model, by model id: turns the usage ledger into money. */
  prices?: Record<string, PriceEntry>
  /** Which round of defaults this file has been brought up to; see the settings store's migration. */
  revision?: number
  /** Where these settings stand against the recommendations that ship with the plugin (`recommended.json`). */
  recommended?: RecommendedState
}

/** One setting the recommendations moved, or would move: which, from what, to what. */
export interface RecommendedChange {
  /** `image.model`, `tts.model`, `tts.narratorVoice`, `embedding.model`. */
  key: string
  from: string
  to: string
}

export interface RecommendedState {
  /** false: the author keeps what they have when the recommendations change. Unset: they follow. */
  follow?: boolean
  /** The issue these settings were last brought up against. */
  version?: number
  /** What of the settings was a recommendation when it was set: only these move with a later issue — a value the author chose is theirs. */
  adopted?: Record<string, string>
  /** What the latest issue changed here (`pending`: would change, were the author following) — shown until the author has read it. */
  notice?: { version: number; date: string; changes: RecommendedChange[]; pending?: boolean }
}

/**
 * Reading on another device. Off unless the author turns it on; while it is
 * on, the Studio listens on the local network and whoever has the address
 * (which carries the token) can read the shared books — and nothing else.
 */
export interface ShareSettings {
  enabled: boolean
  /** Port the reader listens on. */
  port?: number
  /** The secret part of the address. */
  token?: string
  /** Roots of the books that are shared. */
  books?: string[]
  /**
   * Roots of the shared books that may also be changed from another device:
   * their text edited, their interludes played (which calls the models set up
   * here). Every other shared book is read-only there.
   */
  edit?: string[]
}

// ───────────────────────────── usage ─────────────────────────────

export type UsageKind = 'text' | 'image' | 'speech' | 'embedding'

/** Unit prices of one model, in the author's own currency; any field may be left out. */
export interface PriceEntry {
  /** Per million input tokens. */
  input?: number
  /** Per million input tokens the provider read from its cache; the input price when unset. */
  cached?: number
  /** Per million output tokens. */
  output?: number
  /** Per picture. */
  image?: number
  /** Per minute of generated speech. */
  minute?: number
  /** Per 10,000 characters spoken or embedded. */
  chars10k?: number
  /** Sign shown with the figures: ¥, $, … */
  currency?: string
}

/** One call to a model, as the ledger keeps it. */
export interface UsageEvent {
  at: Timestamp
  kind: UsageKind
  model: string
  /** Where the call went: a Harness provider id, or the host of an endpoint named in the Studio. */
  via: string
  /** Root and title of the book the call was for, when known. */
  book?: string
  bookTitle?: string
  /** Text calls: which role spoke. */
  role?: TextRole
  /** The kind of job the call was part of. */
  task?: JobKind
  origin?: 'agent' | 'user'
  /** Text and embeddings: tokens in and out. */
  input?: number
  output?: number
  /** Text: how much of `input` the provider read from its cache, when it said. */
  cached?: number
  /** The endpoint did not report tokens; they were estimated from the text. */
  estimated?: boolean
  images?: number
  /** Speech: characters spoken and seconds of audio produced. */
  chars?: number
  seconds?: number
}

export interface UsageAmount {
  currency: string
  amount: number
}

export interface UsageRow {
  key: string
  label: string
  kind?: UsageKind
  calls: number
  input: number
  output: number
  /** Input tokens read from a provider's cache; absent on a Host from before they were counted. */
  cached?: number
  images: number
  seconds: number
  chars: number
  /** Some of the token counts are estimates. */
  estimated: boolean
  cost: UsageAmount[]
  /** Usage in this row that has no price to go by. */
  unpriced: boolean
}

export interface UsageSummary {
  since: Timestamp
  until: Timestamp
  total: UsageRow
  byModel: UsageRow[]
  /** Text roles, then pictures, speech and retrieval. */
  byRole: UsageRow[]
  byBook: UsageRow[]
  byDay: UsageRow[]
  /** Models that were used and have no price yet. */
  unpriced: string[]
}

// ───────────────────────────── jobs ─────────────────────────────

export type JobKind =
  | 'write' | 'revise' | 'digest' | 'derive' | 'review' | 'import' | 'bible'
  | 'illustrate' | 'audio' | 'comic' | 'play' | 'export' | 'index' | 'seal'
  | 'video' | 'crew' | 'batch'
  /** Adding or removing a DSH plugin the Studio's crew can call on. */
  | 'install'

/** One piece of work a role of the crew did inside a job. */
export interface CrewRun {
  role: CrewRole
  /** What it was asked to do, in a few words. */
  label: string
  /** `agent`: on the agent loop, with tools. `call`: one request — the role is set that way, or cannot run as an agent, or its agent run fell through. */
  by: 'agent' | 'call'
  /** Tool calls the agent made. */
  steps?: number
  /** The session the run is recorded in, and the conversation it is listed under: together they open it. */
  session?: string
  parent?: string
  /** Why it was done the lesser way, when it was. */
  note?: string
  /** Still at work: listed from the moment it starts, so that it can be opened and watched. */
  running?: boolean
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobProgress {
  done: number
  total: number
  label?: string
}

export interface JobInfo {
  id: string
  kind: JobKind
  title: string
  status: JobStatus
  /** Project root the job belongs to. */
  project: string
  /** Chapter (or other entity) the job is about. */
  target?: string
  progress?: JobProgress
  startedAt: Timestamp
  endedAt?: Timestamp
  error?: string
  /** Length of the streamed text so far. */
  streamLength: number
  /** Set while a model reasons before answering: characters of thought so far. */
  thinking?: number
  /** Characters of thought the job's models have shown so far, over all its calls. */
  thoughtLength?: number
  /** Small JSON result for the UI (ids of what was produced). */
  result?: Record<string, unknown>
  /** The roles that worked in this job, in order. */
  crew?: CrewRun[]
  origin: 'agent' | 'user'
}

// ───────────────────────────── gates ─────────────────────────────

/** The kinds of request the Studio keeps a gate for: so many of each go out at once, whichever job asks. */
export type GateKind = 'text' | 'speech' | 'image' | 'sound'

/** How a gate stands. */
export interface GateState {
  /** What the author allows at once. */
  ceiling: number
  /** What the gate lets through right now: the ceiling, or less while the service pushes back. */
  limit: number
  active: number
  waiting: number
  /** Milliseconds until the next request is let through, while the gate pauses. */
  pausedMs: number
  /** Times the service pushed back since the gate last ran at its ceiling. */
  throttled: number
}

// ───────────────────────────── batches ─────────────────────────────

/** What a batch is of: the stage production of chapters, work on their text, or pictures and voices for the book. */
export type BatchKind = 'stage' | 'text' | 'art'

/** The steps of putting a chapter on stage, in the order they depend on each other. */
export type StageStep = 'script' | 'voice' | 'sound' | 'storyboard' | 'panels' | 'video'
export const STAGE_STEPS: readonly StageStep[] = ['script', 'voice', 'sound', 'storyboard', 'panels', 'video']

/** The steps of work on a chapter's text. */
export type TextStep = 'beats' | 'write' | 'digest' | 'review'
export const TEXT_STEPS: readonly TextStep[] = ['beats', 'write', 'digest', 'review']

/** Pictures and voices made for the book's people, places and chapters. */
export type ArtStep = 'sheet' | 'portrait' | 'voice' | 'place' | 'item' | 'scene' | 'cover'
export const ART_STEPS: readonly ArtStep[] = ['sheet', 'portrait', 'voice', 'place', 'item', 'scene', 'cover']

export type BatchStepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed' | 'blocked'

/** One step of a batch — one thing done to one chapter, character or place — as whoever watches the batch sees it. */
export interface BatchStepView {
  state: BatchStepState
  /** What came of it, or why it did not happen, in a few words. */
  note?: string
  /** While it runs: how far it is. */
  progress?: { done: number; total: number; label?: string }
  /** While it runs: what the step itself reports (which lines are in the booth, …). */
  detail?: Record<string, unknown>
  /**
   * The role that works (or worked) on this step as an agent, and where its
   * run is recorded: a step can be opened and watched by itself, whichever of
   * the batch's many agents it is. Absent for a step no agent did.
   */
  run?: Pick<CrewRun, 'role' | 'session' | 'parent' | 'running'>
}

export interface BatchRowView {
  /** The chapter, character or world entry the row is about; `book` for the book itself. */
  id: string
  label: string
  kind: 'chapter' | 'character' | 'place' | 'book'
  /** By step name. A step the batch does not do to this row is absent. */
  steps: Record<string, BatchStepView>
}

/** A batch as it stands: every row and step, and how many are settled. Travels as `result.batch` of the job. */
export interface BatchView {
  what: BatchKind
  /** The steps of this batch, in order. */
  columns: string[]
  rows: BatchRowView[]
  total: number
  /** Steps that are done, skipped, failed or blocked. */
  settled: number
  failed: number
}

/** Where a chapter's stage production stands. */
export interface StageStatus {
  id: string
  index: number
  title: string
  words: number
  /** Lines of the script, and how many of those that are spoken have a voice. Absent: no script yet. */
  script?: { lines: number; spoken: number; voiced: number; stale: boolean; seconds: number }
  /** Sounds the script asks a model for, and how many are made. */
  sound?: { wanted: number; made: number }
  /** Panels of the storyboard, and how many are drawn. Absent: no storyboard yet. */
  board?: { panels: number; drawn: number; stale: boolean }
  video?: { duration: number; createdAt: Timestamp }
}

/** The video of a chapter, cut by post-production from the chapter's voice, sound and pictures. */
export interface ChapterVideo {
  schema: 1
  chapterId: string
  /** Project-relative path of the file. */
  path: string
  /** Seconds. */
  duration: number
  width: number
  height: number
  /** Bytes. */
  size: number
  createdAt: Timestamp
  /** What post-production says about its cut. */
  note?: string
  /** What it was cut from: lines with and without a voice, panels drawn and not, sound clips. */
  material?: { spoken: number; silent: number; drawn: number; undrawn: number; clips: number }
  /**
   * The subtitles of the cut. `path`: a WebVTT copy of the file's subtitle
   * track, which a web player can show (it shows nothing of a track inside an
   * MP4). `burned`: the words are in the picture already, and the player
   * leaves the track off.
   */
  subtitles?: { path?: string; burned: boolean }
}

// ───────────────────────────── stage: audio, comic, interlude ─────────────────────────────

export type AudioLineKind = 'narration' | 'dialogue' | 'thought'

export interface AudioLine {
  id: string
  kind: AudioLineKind
  /** Character id for dialogue and thought; absent for narration. */
  speaker?: string
  /** Display name of the speaker as written. */
  speakerName?: string
  text: string
  /** Delivery direction: emotion, pace, volume. */
  direction?: string
  /** Project-relative path of the synthesized segment. */
  audio?: string
  /** Duration in seconds once synthesized. */
  duration?: number
  /** Hash of the synthesis inputs the audio was rendered from. */
  renderKey?: string
  error?: string
  /** How many times the line was spoken before this take was kept, when more than once. */
  takes?: number
  /** What the listening check still finds wrong with the kept take. */
  check?: TakeIssue[]
  /**
   * Narration that only says who spoke ("他说，", "she asked.") and sits
   * between two spoken lines. With a voice per speaker it tells the listener
   * nothing, and a clip of two syllables is where a speech model is at its
   * worst — so it is left unspoken unless the author wants every word read.
   */
  tag?: boolean
  /** The author's own word on this line: `false` leaves it unspoken, `true` has it spoken even though it is a tag. */
  voiced?: boolean
  /** Not stored: set on scripts handed to a player when the line is left unspoken under the current settings. */
  skip?: boolean
}

/**
 * What can be wrong with a synthesized line, as far as measuring it can tell:
 * nothing audible, most of the words missing, far longer than its words, or a
 * voice that sits well away from the one the speaker was cast with.
 */
export type TakeIssue = 'silent' | 'short' | 'long' | 'drift'

/** Procedural ambience beds the browser can synthesize without any asset. */
export type AmbiencePreset =
  | 'none' | 'rain' | 'storm' | 'wind' | 'night' | 'forest' | 'sea' | 'river' | 'fire' | 'city' | 'crowd'
  | 'tavern' | 'battle' | 'cave' | 'snow' | 'train' | 'spaceship' | 'tension' | 'serene'

/**
 * What kind of sound a cue is. A bed runs under the lines until the next bed;
 * an effect is heard once where it is placed; music runs under a scene until
 * the next music cue.
 */
export type SoundKind = 'bed' | 'effect' | 'music'

/**
 * A sound the telling does not speak: the room, a door, a held chord. Each has
 * a caption the reader can see beside the text — atmosphere for the eye as well
 * as the ear — and may have a clip generated for it.
 */
export interface AudioCue {
  /** Stable within the script; older scripts have none. */
  id?: string
  /** Line id the cue starts at. */
  at: string
  /** Bed and music are continuous, an effect is a single event. Absent on older scripts: a bed. */
  kind?: SoundKind
  /** The bed the browser synthesizes when there is no generated clip; `none` for effects and music. */
  ambience: AmbiencePreset
  /** 0…1 */
  intensity?: number
  /** What the reader is shown: the sound in a few words of the manuscript's language. */
  caption?: string
  /** What the sound model is asked for. */
  prompt?: string
  /** Older scripts kept their caption here. */
  note?: string
  /** Project-relative path of the generated clip. */
  audio?: string
  /** Duration of the clip in seconds. */
  duration?: number
  /** Hash of what the clip was generated from. */
  renderKey?: string
  error?: string
}

export interface AudioScript {
  schema: 1
  chapterId: string
  textHash: string
  updatedAt: Timestamp
  /**
   * How the lines were shaped. 2: narration is spoken in whole takes and
   * stranded speech tags are marked. Absent on scripts cut the older, finer way.
   */
  shape?: number
  lines: AudioLine[]
  cues: AudioCue[]
  /**
   * Set when part of the chapter could not be directed by the model and was
   * cut by rule instead: those passages have no speakers and no delivery
   * notes, so their dialogue is read in the narrator's voice.
   */
  degraded?: { blocks: number; of: number; reason: string }
}

/**
 * Who speaks with which voice, for the whole book. Casting is decided once and
 * kept here, so a character does not change voice from chapter to chapter, and
 * each voice is remembered by how it sounds so a stray take can be told apart.
 */
export interface VoiceCast {
  schema: 1
  /** The speech setup these voices belong to; another provider or model starts a new sheet. */
  provider: string
  model?: string
  /** Character id → the voice cast for them, for characters whose card names none. */
  characters: Record<string, string>
  /** Speakers without a card, by name as written → voice. */
  extras: Record<string, string>
  /** Voice → its usual pitch in Hz, read from its reference clip or from lines already spoken. */
  prints: Record<string, VoicePrint>
  updatedAt: Timestamp
}

export interface VoicePrint {
  pitch: number
  /** How many clips the figure rests on. */
  samples: number
  /** Read from the voice's reference clip rather than learned from lines. */
  anchored?: boolean
}

export type CameraMove = 'still' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down'

export interface ComicPanel {
  id: string
  /** Audio line ids this panel stays on screen for. */
  lines: string[]
  /** Where in its first line the panel comes on, as a fraction of that line (0 = with the line; absent = 0). */
  begin?: number
  /** Where in its last line the panel goes off (1 = with the line's end; absent = 1). */
  end?: number
  /** What the panel shows, in plain words. */
  description: string
  /** Final image prompt. */
  prompt: string
  camera: CameraMove
  characters?: string[]
  location?: string
  image?: string
  error?: string
}

export interface ComicBoard {
  schema: 1
  chapterId: string
  textHash: string
  updatedAt: Timestamp
  /** Art direction shared by every panel. */
  style: string
  panels: ComicPanel[]
  /** What the board was cut with. */
  density?: StoryboardDensity
  maxPanels?: number
  /** Set when the cut came out other than asked (a pass that stopped early, fewer panels than wanted). */
  note?: string
}

export interface PlayLine {
  speaker: string
  /** Character id when the speaker has a card. */
  character?: string
  text: string
  emotion?: string
  /** Stage direction shown beside the line. */
  action?: string
  audio?: string
}

export interface PlayTurn {
  id: string
  /** What the player did to cause this turn (absent for the opening). */
  input?: { kind: 'say' | 'do' | 'choice' | 'direct'; text: string }
  narration?: string
  lines: PlayLine[]
  choices: string[]
  /** Set when the scene changed. */
  scene?: { location?: string; time?: string; mood?: string; ambience?: AmbiencePreset; background?: string }
  ended?: boolean
  createdAt: Timestamp
}

/** A playable interlude: a role-play scene branched off the canon. */
export interface PlaySession {
  schema: 1
  id: string
  title: string
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Chapter the interlude branches from; canon up to and including it is known. */
  anchorChapter?: string
  /** Character id the human plays; absent = the human directs from outside. */
  player?: string
  cast: string[]
  location?: string
  /** The starting situation. */
  situation: string
  tone?: string
  /** Live variables the director tracks (affection, clues, …). */
  state?: Record<string, string | number>
  turns: PlayTurn[]
  /** What became of it. */
  outcome?: 'open' | 'discarded' | 'side-story' | 'novelized'
  /** Chapter created when it was novelized. */
  novelizedChapter?: string
  /** The line of the plot the scene became the first chapter of, when it was novelized as another way the story goes. */
  novelizedLine?: string
}

/** One part of what a picture's subject was put together from. */
export interface IllustrationPiece {
  /**
   * What the words are of. `frame`: what kind of picture it is and how it is laid out. `look`: how the person, the
   * place or the thing looks. `outfit`: the look (outfit) worn, where it is not the main one. `expression`: what the
   * face is to show. `ask`: what was asked of this one picture and of no other. `composed`: a description the director
   * wrote for it, from the book. `scene`: the moment of the book a portrait shows, as kept on the person's card.
   */
  of: 'frame' | 'look' | 'outfit' | 'expression' | 'ask' | 'composed' | 'scene'
  text: string
  /**
   * Where the words were taken from. A `look`: what is written for an image model (`anchor` — a visual anchor, a
   * place's look), or, lacking that, the prose of the card (`card`). A `scene`: the one kept on the person's card
   * (`card`), or one the director picked for this picture alone, guided by what the author asked of it (`asked`).
   */
  from?: 'anchor' | 'card' | 'asked'
  /** A `scene` picked for this picture alone: what the author asked, which guided the pick. It is not itself part of the prompt. */
  asked?: string
}

/** What an image prompt was assembled from, so the history shows where every part came from. */
export interface IllustrationParts {
  /** The picture itself, as asked for or composed. */
  subject: string
  /** The subject part by part, for the kinds of picture that are put together from parts (a portrait, a sheet, design art, a cover). */
  pieces?: IllustrationPiece[]
  /** The subject was longer than fits beside the lines that keep a book's pictures alike, and was cut. */
  clipped?: boolean
  /** The art direction that was added, if any. */
  style?: string
  styleSource?: 'book' | 'studio' | 'default'
  /** Everything the picture was told to keep out. */
  avoid?: string[]
  /** Reference images sent along: project-relative path and who it shows. */
  references?: { path: string; label: string }[]
  /** What the prompt said of the reference images: who each one shows, and what they are there for. */
  referenceNote?: string
}

/** What went to an image service for one picture, word for word. */
export interface IllustrationSent {
  /** The prompt as the model got it: what the Studio put together, and what the way to that model adds — things to keep out, where the service has no field for them; how the frame is shaped, where it takes no size. */
  prompt: string
  /** What to keep out, where the service takes it as a field of its own. */
  negative?: string
  /** The size or shape asked for, in the service's own terms. */
  size?: string
  /**
   * How it was sampled, where the Studio built the graph itself (a model on a ComfyUI server, no workflow named), and
   * where the steps and the guidance came from: the `settings`, the `server`'s own last run of that model, or the
   * `builtin` figures for a model of its kind.
   */
  sampling?: { steps: number; guidance: number; sampler: string; scheduler: string; from: 'settings' | 'server' | 'builtin' }
}

export interface IllustrationInfo {
  id: string
  /** Project-relative path. */
  path: string
  /** The prompt as the Studio put it together: subject, reference images, art direction. What reached the model word for word is `sent`. */
  prompt: string
  parts?: IllustrationParts
  kind: 'portrait' | 'sheet' | 'scene' | 'location' | 'item' | 'cover' | 'panel' | 'background' | 'sprite'
  /** Chapter / character / world entry it belongs to. */
  target?: string
  createdAt: Timestamp
  model?: string
  /** The image service it was drawn with. */
  provider?: ImageProviderKind
  /** The size the Studio asked for, `WIDTHxHEIGHT`. */
  size?: string
  /** What went to the image service, word for word. Pictures drawn before this was kept have none. */
  sent?: IllustrationSent
}

// ───────────────────────────── working modes ─────────────────────────────

/**
 * How the orchestrator behaves in a session. One project, one canon — the mode
 * only changes what the orchestrator may touch and what it optimizes for.
 */
export type WorkMode = 'ideate' | 'bible' | 'outline' | 'draft' | 'revise' | 'review' | 'stage' | 'play'

export const WORK_MODES: readonly WorkMode[] = ['ideate', 'bible', 'outline', 'draft', 'revise', 'review', 'stage', 'play']

// ───────────────────────────── aggregate views ─────────────────────────────

/** Parts by weight, heaviest first: the order characters are listed in everywhere. */
export const ROLE_ORDER: readonly CharacterRole[] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']

/**
 * The cast in the order it is listed by default: by the weight of the part;
 * within one weight, whoever is in more chapters first; then by who came on
 * the page first. A list ordered by the alphabet puts a walk-on above the lead.
 * @param presence - which chapters each is in; left out, parts of one weight keep the order they came in.
 */
export function castOrder<T extends Pick<CharacterCard, 'id' | 'role'>>(cards: readonly T[], presence: readonly CastPresence[] = [], chapterOrder: readonly string[] = []): T[] {
  const seen = new Map(presence.map(entry => [entry.character, entry.chapters]))
  const place = new Map(chapterOrder.map((id, index) => [id, index]))
  const first = (id: string): number => {
    const chapters = seen.get(id)
    return chapters !== undefined && chapters.length > 0 ? place.get(chapters[0]!) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER
  }
  return cards.map((card, index) => ({ card, index })).sort((left, right) =>
    ROLE_ORDER.indexOf(left.card.role) - ROLE_ORDER.indexOf(right.card.role)
    || (seen.get(right.card.id)?.length ?? 0) - (seen.get(left.card.id)?.length ?? 0)
    || first(left.card.id) - first(right.card.id)
    || left.index - right.index,
  ).map(item => item.card)
}

export interface CastPresence {
  character: string
  /** Chapter ids the character appears in, in reading order. */
  chapters: string[]
  /** Chapters since the last appearance (0 = in the latest digested chapter). */
  absentFor: number
  /**
   * On the main line, as the digests have it: the chapter (1-based place) they die in, or leave the story for good —
   * when that is the last word on them. Along another line it may be otherwise (`Project.lives`).
   */
  death?: number
  exit?: number
}

/**
 * Someone the page names who has no character card: a walk-on. Gathered from
 * chapter memories, pending suggestions, the audio scripts and the voice sheet.
 */
export interface WalkOn {
  name: string
  /** What the page says of them, in a line. */
  note?: string
  /** Chapters they were seen in, in reading order. */
  chapters: string[]
  /** Lines they speak across the audio scripts. */
  lines: number
  /** The voice the audio drama cast them with. */
  voice?: string
  /** A pending suggestion that proposes a card for them. */
  suggestion?: string
  /** A character whose name is close enough that this may be them under another name. */
  near?: string
  /** The author took them off the list. */
  ignored?: boolean
  /** What the planner made of them when it last looked through the names without a card. */
  verdict?: WalkOnVerdict
}

/** What a ComfyUI server has to draw with, as it says itself. */
export interface ComfyCatalog {
  /** The address that answered. */
  base: string
  version?: string
  /** The device it draws on, with its memory. */
  device?: string
  /** Whole models: a diffusion model with its text encoder and VAE in one file. */
  checkpoints: string[]
  /** Diffusion models alone: each needs a text encoder and a VAE named beside it. */
  diffusion: string[]
  encoders: string[]
  vaes: string[]
  /** The kinds a text encoder can be loaded as. */
  encoderTypes: string[]
  /** The last run of the server that made a picture, where its history has one: what it drew with, and the nodes it ran. */
  last?: { model?: string; nodes: string[] }
  /** The workflows saved on the server (in its editor), by their path under its workflows folder. */
  workflows: string[]
}

/**
 * What the planner said of a name the page uses for somebody without a card: worth a card (then a suggestion says
 * so), another name of somebody (`same`), or a walk-on — left where they are, in the list of walk-ons, with why.
 */
export interface WalkOnVerdict {
  is: 'card' | 'alias' | 'walkon'
  /** The planner's reason, in a line. */
  why?: string
  /** `alias`: whose other name it is, as the planner named them. */
  same?: string
  at: Timestamp
  /** In how many chapters they were seen when this was said: seen in more since, they are looked at again. */
  seen: number
}

/**
 * One thing that changed the book, kept so nothing changes it unseen: what
 * the showrunner did with its tools, and what was changed in the files behind
 * the Studio's back. The author reads these on the overview and can undo a
 * manuscript edit from there.
 */
export interface ActivityEntry {
  id: string
  at: Timestamp
  /** agent: a tool call of the showrunner. outside: files changed by something that is not the Studio. device: a change made from a phone or tablet through the shared reader. crew: a role of the crew working as an agent (`role` says which). editor: what `crew` was called when the only such agent was the one that finds a manuscript's chapters. */
  by: 'agent' | 'outside' | 'device' | 'crew' | 'editor'
  /** The role that made the change, for `crew`. */
  role?: CrewRole
  /** The tool (`novel_edit`), or `files` for a change from outside. */
  tool: string
  action?: string
  /** One line, in words the author can read. */
  summary: string
  /** Chapter the change was made to. */
  chapter?: string
  /** Version holding the chapter as it was before the change: restoring it undoes the change. */
  version?: string
}

export interface ProjectStats {
  words: number
  chapters: number
  chaptersWithText: number
  characters: number
  worldEntries: number
  openThreads: number
  pendingProposals: number
  pendingSuggestions: number
  undigested: number
}

/** Everything the Studio shell needs to draw a project at a glance. */
export interface ProjectState {
  /** Absolute project root on the Host. */
  root: string
  /** Bumped on every change; the UI long-polls on it. */
  revision: number
  manifest: ProjectManifest
  outline: Outline
  chapters: ChapterInfo[]
  characters: CharacterCard[]
  world: WorldEntry[]
  styles: StyleProfile[]
  stats: ProjectStats
  suggestions: Suggestion[]
  proposals: Proposal[]
  presence: CastPresence[]
  /** Project-relative path of the cover picture, when the book has one. */
  cover?: string
  /** What changed the book lately, newest first. Absent on a Host from before this was kept. */
  activity?: ActivityEntry[]
  /** The lines of the plot beside the main one, with their chapters' facts. Absent on a Host from before there were lines, and in a book that has none. */
  lines?: PlotLineInfo[]
  /** An analysis of the book (an import's) that was started and not finished: the passes still to run. */
  analysis?: { pending: AnalyzeStep[] }
  /** People the chapters come back to who have no character card: how many, and the most present of them. */
  uncarded?: { count: number; names: string[] }
  /** Chapters taken out of the book that can be put back, newest first. Absent when there are none, and on a Host from before they were kept. */
  removed?: RemovedChapter[]
  /** Where each entry of the bible is named, chapter by chapter: what its weight in the story is read off. Absent on a Host from before entries were weighed. */
  worldPresence?: { entry: string; chapters: string[] }[]
  /** How the things of the book's world stand to each other: what is in what, who belongs where, lives where, holds what. Absent on a Host from before there were ties. */
  ties?: Tie[]
  /** Where the author moved people to on the picture of who is what to whom, by their id, in the units of its layout; whoever is not here stands where the layout puts them. */
  graph?: Record<string, { x: number; y: number }>
}

/**
 * A chapter that was taken out of the book, kept so that it can be put back:
 * its plan, where it stood, and the version that holds its text. What was
 * made from it — its digest, review, voices, pictures — stays where it was
 * and is the chapter's again when it returns.
 */
export interface RemovedChapter {
  plan: ChapterPlan
  removedAt: Timestamp
  /** Where it stood: its volume (main line) or its line, and the chapter it came after. */
  volume?: string
  line?: string
  after?: string
  /** The reading order it had, for telling the author which chapter it was. */
  index: number
  words: number
  /** The version that holds its text as it was; absent for a chapter that had none. */
  version?: string
}

export interface ProjectRef {
  root: string
  title: string
  /** Path relative to the workspace, `.` for the workspace root itself. */
  relative: string
  /** Manifest id, which media URLs name the project by. */
  id?: string
  /** Project-relative path of the cover picture, when the book has one. */
  cover?: string
  /** The book's files are encrypted where they lie. */
  sealed?: boolean
  /** Sealed, and not unlocked: only the name on the shelf can be shown. */
  locked?: boolean
  /** What of the book there is to read, hear and watch right now. Absent on a locked book, and from a Host that did not count yet. */
  shows?: BookShows
}

/** A way of taking a book in, how many chapters offer it, and the first of them in reading order. */
export interface ShowCount {
  chapters: number
  first: string
}

/** What a book offers a reader right now: text to read, voices to hear, pictures to watch. A way with nothing to it is left out. */
export interface BookShows {
  read?: ShowCount
  /** Chapters whose script has at least one line spoken. */
  listen?: ShowCount
  /** Chapters with a storyboard that has at least one panel drawn, or with a video. */
  watch?: ShowCount
}

/**
 * How a book is locked. A sealed book has every file of it encrypted on disk;
 * it is read only after it was opened one of the listed ways, and only until
 * it is locked again or the Harness quits.
 */
export interface BookLock {
  sealed: boolean
  locked: boolean
  /** The name the shelf shows while it is locked. */
  title?: string
  /** The ways the book opens: a password, this computer's own unlock, a device that was let in. */
  ways: { kind: 'password' | 'device' | 'grant'; id?: string; label?: string; at?: string }[]
}

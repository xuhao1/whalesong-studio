// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Domain model of a novel project. Shared by the Host, the agent tools and the
 * browser UI, so this module must stay free of Node and DOM imports.
 *
 * On disk a project is a plain directory (see docs/project-format.md):
 * Markdown for everything a human writes, JSON for structure and machine memory.
 */

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
  /** Typical chapter length the writer aims for. */
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
  /** Per-project overrides of the global model routing. */
  models?: Partial<TextModelRouting>
  /** Free-form notes that always travel with the project digest. */
  notes?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ───────────────────────────── story bible ─────────────────────────────

export type CharacterRole = 'protagonist' | 'deuteragonist' | 'antagonist' | 'supporting' | 'minor' | 'cameo'

/** Where a character is in their life on the page. Drives ensemble-cast scheduling. */
export type CharacterStatus = 'planned' | 'active' | 'offstage' | 'retired' | 'dead'

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

export interface CharacterCard {
  id: string
  name: string
  aliases?: string[]
  role: CharacterRole
  status: CharacterStatus
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
  visual?: CharacterVisual
  voiceProfile?: CharacterVoiceProfile
  /** Free-form Markdown body below the front matter. */
  notes?: string
  updatedAt?: Timestamp
}

export type WorldCategory =
  | 'setting' | 'location' | 'faction' | 'system' | 'item' | 'history' | 'culture' | 'rule' | 'term' | 'other'

export interface WorldEntry {
  id: string
  name: string
  aliases?: string[]
  category: WorldCategory
  /** 1 = core canon that always travels in context, 2 = normal, 3 = detail fetched on demand. */
  importance: 1 | 2 | 3
  summary?: string
  /** Ids of related entries. */
  related?: string[]
  tags?: string[]
  /** Visual prompt for locations (backgrounds in comics and interludes). */
  visualPrompt?: string
  /** Project-relative path of the place's reference art; sent along when a scene is set there. */
  visualImage?: string
  /** Free-form Markdown body. */
  body?: string
  updatedAt?: Timestamp
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

export interface Outline {
  schema: 1
  volumes: Volume[]
  threads: PlotThread[]
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
export interface Suggestion {
  id: string
  kind: 'new-character' | 'new-world' | 'character-status' | 'new-thread' | 'thread-status'
  title: string
  detail: string
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
  /** Real-time interlude (role-play) turns. */
  director?: ModelRoute
}

export type TextRole = keyof TextModelRouting

export type ContextStrategy = 'auto' | 'retrieval' | 'full'

export interface ContextSettings {
  /**
   * `full` sends the whole manuscript when it fits, `retrieval` always packs by
   * relevance, `auto` picks per call from the model's context window.
   */
  strategy: ContextStrategy
  /** Upper bound of tokens the packed context may use. */
  budgetTokens: number
  /** How many characters of the preceding text are always included verbatim. */
  tailChars: number
}

/**
 * `openrouter` is OpenRouter's `/images` endpoint, `openai` any OpenAI-compatible
 * `/images/generations`, `dashscope` Aliyun Bailian's native image models, and
 * `codex` the image generation of a ChatGPT subscription (no key of its own).
 */
export type ImageProviderKind = 'dashscope' | 'openai' | 'openrouter' | 'codex' | 'none'
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
  /** `codex` only: which bridge to the ChatGPT subscription to use. */
  bridge?: CodexBridgeKind
  /** `1024x1024`, `1280x720`… */
  size?: string
  /** Style phrase appended to every prompt so a book keeps one look. */
  stylePrompt?: string
  negativePrompt?: string
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
  /** Parallel synthesis requests. */
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
  /** Run digest automatically after a chapter is written or revised. */
  autoDigest: boolean
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
  origin: 'agent' | 'user'
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
}

/** What an image prompt was assembled from, so the history shows where every part came from. */
export interface IllustrationParts {
  /** The picture itself, as asked for or composed. */
  subject: string
  /** The art direction that was added, if any. */
  style?: string
  styleSource?: 'book' | 'studio' | 'default'
  /** Everything the picture was told to keep out. */
  avoid?: string[]
  /** Reference images sent along: project-relative path and who it shows. */
  references?: { path: string; label: string }[]
}

export interface IllustrationInfo {
  id: string
  /** Project-relative path. */
  path: string
  /** The prompt exactly as it was sent. */
  prompt: string
  parts?: IllustrationParts
  kind: 'portrait' | 'sheet' | 'scene' | 'location' | 'cover' | 'panel' | 'background' | 'sprite'
  /** Chapter / character / world entry it belongs to. */
  target?: string
  createdAt: Timestamp
  model?: string
}

// ───────────────────────────── working modes ─────────────────────────────

/**
 * How the orchestrator behaves in a session. One project, one canon — the mode
 * only changes what the orchestrator may touch and what it optimizes for.
 */
export type WorkMode = 'ideate' | 'bible' | 'outline' | 'draft' | 'revise' | 'review' | 'stage' | 'play'

export const WORK_MODES: readonly WorkMode[] = ['ideate', 'bible', 'outline', 'draft', 'revise', 'review', 'stage', 'play']

// ───────────────────────────── aggregate views ─────────────────────────────

export interface CastPresence {
  character: string
  /** Chapter ids the character appears in, in reading order. */
  chapters: string[]
  /** Chapters since the last appearance (0 = in the latest digested chapter). */
  absentFor: number
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
  /** agent: a tool call of the showrunner. outside: files changed by something that is not the Studio. device: a change made from a phone or tablet through the shared reader. */
  by: 'agent' | 'outside' | 'device'
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

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The contract between the Studio (browser) and the Host half.
 *
 * Transport: one authenticated route, `POST /api/novel/rpc`, called through
 * the Harness Connection (`ctx.connection.rpc.call('/api', 'novel/rpc', …)`),
 * so it works unchanged in the Web UI and in the Desktop app. Binary media is
 * read through `GET /api/novel/media?project=<manifest id>&path=…`.
 *
 * Methods that start model work return a job id at once; the Studio follows
 * the job through `jobs.read` and learns about everything else through the
 * long-poll `events.wait`.
 */
import type { Album, AlbumCounts } from './album'
import type { Life } from './life'
import type { LineWorld } from './worldline'
import type { Tie } from './ties'
import type { Recommended } from './recommended'
import type { ServiceId, SetupPart } from './services'
import type {
  AnalyzeStep,
  PriceEntry,
  UsageSummary,
  TtsProviderKind,
  AmbiencePreset, AudioCue, AudioLine, AudioScript, BookLock, ChapterMemory, ChapterPlan, ChapterReview, CharacterCard, CharacterRole, ComicBoard, ComicPanel, LifeMark, SheetsAsk,
  ChapterVideo, CrewRole, GateKind, GateState, IllustrationInfo, JobInfo, ModelRoute, NovelSettings, PlaySession, PlayTurn, ProjectManifest, ProjectRef, ProjectState, RecommendedState,
  Proposal, SearchHit, SearchSource, SoundKind, StageStatus, StageStep, StoryboardDensity, StyleProfile, TextRole, TextStep, VersionInfo, WalkOn, WorkMode, WorldEntry,
} from './types'

/**
 * How a book is locked, as a screen needs it: besides the book's own state,
 * what this computer can do to unlock it.
 */
export interface LockView extends BookLock {
  /** This computer's own unlock: a fingerprint or face, or the computer's password. */
  device: { available: boolean; biometrics: boolean; method: 'touch-id' | 'windows-hello' | 'password' | 'none'; host: string }
  /** The book opens with this computer's own unlock. */
  deviceOn: boolean
  /**
   * The conversations about this book that DSH keeps: how many are under the
   * seal, how many lie plain in DSH's store (all of them while the book is
   * open), and how many of those wait to be sealed because they are in use.
   * Absent on a Host from before conversations were sealed with their book.
   */
  conversations?: { sealed: number; open: number; waiting: number }
}

export const RPC_ENDPOINT = 'novel/rpc'
export const MEDIA_PATH = 'api/novel/media'

export interface WorkspaceInfo {
  id?: string
  title: string
  path: string
  projects: ProjectRef[]
}

export interface ModelOption {
  provider: string
  providerName: string
  id: string
  name: string
  description?: string
}

/** What a text model can be asked to do beyond the defaults. */
export interface ModelDetails {
  contextWindow?: number
  /** Tokens a reply runs to when the role sets no limit of its own; absent when the endpoint decides and does not say. */
  outputCap?: number
  /** The most the model can write in one reply, when its maker documents it. */
  maxOutput?: number
  /** Reasoning levels this model accepts; empty when it has none to choose from. */
  efforts: { id: string; name: string; description?: string }[]
  defaultEffort?: string
}

export interface VoiceOption {
  id: string
  gender: string
  age: string
  note: string
  accent?: string
}

/** Whether a key will be found for an endpoint and where from — never the key itself. */
export interface KeyState {
  /** Host the key belongs to. */
  host: string
  configured: boolean
  /** Saved in the Studio, found in a conventional environment variable, or read from a name the slot gives. */
  source?: 'saved' | 'env' | 'named'
  /** The variable or credential name, when the source is one. */
  name?: string
}

/** How a ChatGPT subscription can be reached from this machine (presence only). */
export interface CodexStatus {
  /** The Codex Connect plugin is mounted in this Harness. */
  connect: boolean
  connectSignedIn: boolean
  /** The Codex CLI is installed on the machine that runs the Harness. */
  cli: boolean
  cliSignedIn: boolean
}

export type ModelKind = 'text' | 'embedding' | 'image' | 'speech'

/** A model an endpoint says it serves. */
export interface EndpointModel {
  id: string
  name?: string
  contextWindow?: number
  voices?: string[]
  /** Speech models: the protocol that drives this model; choosing the model switches to it. */
  via?: TtsProviderKind
  /** Speech models: the endpoint serves it, but over a protocol the Studio does not speak yet. */
  unsupported?: boolean
}

/** A provider the Harness itself reaches (Settings → Models, a sign-in plugin), as a source of text models. */
export interface ProviderOption {
  id: string
  name: string
  /** How many models it listed. */
  models: number
  /** Why it listed none, when it failed to. */
  error?: string
}

/** The outcome of asking an endpoint whether a key opens it. */
export interface EndpointCheck {
  ok: boolean
  /** How many models the endpoint listed. */
  models?: number
  message?: string
}

/** The reader served to other devices on the local network, as it stands. */
export interface ShareStatus {
  /** The author switched it on. */
  enabled: boolean
  /** It is listening right now. */
  running: boolean
  port?: number
  /** The port that was asked for, when another program holds it and the reader listens on `port` instead. */
  instead?: number
  /** Addresses a device on the same network can open, the likeliest first. Each carries the secret token. */
  urls: string[]
  /** The books that can be read there, and whether they can also be changed from there. */
  books: { root: string; id: string; title: string; /** read: nothing can be changed from another device. edit: text can be edited and interludes played there. */ mode?: 'read' | 'edit'; /** The book is sealed: a device shows its password once before it is let in. */ sealed?: boolean }[]
  /** Why it is not listening although it is switched on. */
  error?: string
}

export interface SettingsView {
  settings: NovelSettings
  /** Text models configured in the Harness (Settings → Models). */
  models: ModelOption[]
  /** Every provider the Harness reaches, including those that could not list their models just now. */
  providers: ProviderOption[]
  defaultRoute?: ModelRoute
  voices: VoiceOption[]
  /** Key availability by endpoint host: every endpoint in the settings plus the known services. */
  keys: Record<string, KeyState>
  codex: CodexStatus
  /** What is usable right now, slot by slot. */
  ready: { text: boolean; embedding: boolean; image: boolean; tts: boolean; /** Something can generate effects, music and beds. Absent on a Host from before there was sound. */ sound?: boolean }
  /** Nothing has been set up and the first-run guide has not been put aside. */
  setupNeeded: boolean
  /** How the crew stands right now. Absent on a Host from before there was a crew. */
  crew?: CrewView
  /** What the context settings come to for the models in use. Absent on a Host from before the story travelled as outline and text. */
  context?: ContextView[]
  version: string
  /** The recommendations in force and where the settings stand against them. Absent on a Host from before they were a file. */
  recommended?: RecommendedView
  /** The build the Host runs and the one installed now; `stale` when they differ. Absent on a Host from before builds were named. */
  build?: { running?: string; installed?: string; stale: boolean; /** The Host half can be replaced by the installed one while DSH runs (`host.reload`). Absent on a Host that DSH loaded whole. */ reloadable?: boolean }
}

/** The issue of the recommendations (`recommended.json`) in force, and what the author has said about following it. */
export interface RecommendedView {
  version: number
  date: string
  notes?: { zh?: string; en?: string }
  /** Settings that are a recommendation move with the next issue. */
  follow: boolean
  /** What the latest issue changed here, or — `pending` — would change; shown until the author has settled it. */
  notice?: NonNullable<RecommendedState['notice']>
  /** The issue itself, so that the Studio offers what the Host does. */
  table: Recommended
}

/** What publishing a book as a site would do. */
export interface SitePlan {
  /** The folder it goes to: the one asked for, else the one beside the book. */
  out: string
  /** The book is sealed: what is published is not. */
  sealed: boolean
  /** Chapters with text, and how many of them have a voice or a comic to go with. */
  chapters: number
  voiced: number
  drawn: number
  /** The people and the things of the world a reader would be shown, kind by kind. */
  album?: AlbumCounts
  /** Interludes kept as side stories. */
  sides?: number
  /** Chapters that have a finished video, and what the files weigh together. Absent from a Host that publishes none. */
  videos?: { chapters: number; bytes: number }
  /** The other ways the story goes that a reader may take — lines beside the main one, not put aside, with a written chapter of their own: their names, and how many chapters only they have. */
  lines?: { titles: string[]; chapters: number }
  /** The folder holds a site published before, of this book or another. */
  previous?: { publishedAt: string; files: number; sameBook: boolean }
  /** The folder exists and holds something that is not a site published from here. */
  occupied?: boolean
  /** Sound can go out compressed: ffmpeg is on this computer. Absent from a Host that publishes sound only as it lies in the book. */
  press?: boolean
  /** Pictures can go out as JPEG: ffmpeg is on this computer. Absent from a Host that publishes pictures only as they lie in the book. */
  jpeg?: boolean
}

/** What a publication wrote. */
export interface SiteDone {
  dir: string
  chapters: number
  album?: AlbumCounts
  /** Side stories the site has; absent from a Host that publishes none. */
  sides?: number
  /** Chapters whose finished video the site carries. */
  videos?: number
  /** Lines of the plot beside the main one the site carries, and the chapters only they have. */
  lines?: { lines: number; chapters: number }
  files: number
  bytes: number
  written: number
  removed: number
  missing: string[]
  /** Uncompressed sound that went out compressed: how many files, their size before and after; `failed` went out as they are. */
  sound?: { files: number; from: number; to: number; failed: string[]; reason?: string }
  /** Compressed sound was wanted and this computer has no ffmpeg to make it: the sound went out as it lies in the book. */
  unpressed?: boolean
  /**
   * Pictures kept without loss (PNG) that went out as JPEG: how many, their size before and after; `failed` went out as they are,
   * and so did the `kept` — see-through somewhere, which a JPEG cannot be.
   */
  pictures?: { files: number; from: number; to: number; failed: string[]; reason?: string; kept?: number }
  /** JPEG pictures were wanted and this computer has no ffmpeg to make them: the pictures went out as they lie in the book. */
  unshrunk?: boolean
}

/** How much of a model's window the story so far gets, role by role — what the context settings come to for the models in use. */
export interface ContextView {
  role: TextRole
  model?: string
  /** The model's context window; absent when neither DSH nor the endpoint says, and a cautious figure is assumed. */
  window?: number
  /** Tokens of the manuscript's own text sent word for word, in whole chapters. */
  textBudget: number
  /** Tokens everything else may take: the book, the world, the people, the outline of what came before, what is looked up. */
  sideBudget: number
}

/** Whether a chapter's video can be cut right now, and from what. */
export interface VideoReady {
  ffmpeg: boolean
  /** Post-production's model can drive an agent. */
  agent: boolean
  model?: string
  /** Why it cannot be cut yet, in words for the author; absent when it can. */
  blocked?: string
  counts?: { spoken: number; silent: number; drawn: number; undrawn: number; clips: number; seconds: number }
}

/** The crew as a screen needs it: who can work as an agent, and what is at hand for them. */
export interface CrewView {
  /** DSH runs an agent loop here at all (it does everywhere but in a bare, headless core). */
  loop: boolean
  /** DSH's subagent service is mounted: a role's run is a child of the conversation, listed under it and open to be watched. Absent on a Host from before this was told. */
  subagents?: boolean
  roles: {
    role: CrewRole
    /** The model the role would run on with nothing else said: its own, or the one DSH starts conversations with. */
    model?: string
    provider?: string
    /** That model can drive an agent. */
    agent: boolean
    /** That model is a directly called endpoint of the old kind: plain calls only. */
    direct: boolean
    /** The conversation's tools the role sees unless the author opens them all. */
    own: string[]
    /** Tool calls a run gets unless the author sets another number. */
    steps: number
  }[]
  /** Outside coding agents the author installed in DSH as subagent providers. */
  help: { claudeCode: boolean; codex: boolean }
  /** The same, as the DSH plugins they come in: what is installed, and whether the Studio can install one here. Absent on a Host from before this was told. */
  helpers?: HelpView
  /** ffmpeg and ffprobe are on this computer: videos can be cut and checked. */
  ffmpeg: boolean
}

export interface ChapterDocument {
  plan: ChapterPlan
  index: number
  volumeId: string
  text: string
  memory?: ChapterMemory
  review?: ChapterReview
  versions: VersionInfo[]
  missingImages: string[]
}

export interface FindMatch {
  chapterId: string
  title: string
  index: number
  offset: number
  /** Text around the match; `at` is where the match starts inside it. */
  snippet: string
  at: number
  length: number
}

export interface OutlineOpInput {
  op: string
  [key: string]: unknown
}

export interface JobStarted {
  jobId: string
}

/** An outside coding agent the crew can hand work to: a subagent provider that comes as an official DSH plugin. */
export interface HelpPackage {
  id: 'claude-code' | 'codex'
  /** The DSH plugin it comes in. */
  package: string
  /** The plugin is among this DSH profile's plugins. */
  installed: boolean
  version?: string
  /** Its provider answers: a role can call on it now. */
  connected: boolean
  /** Installed by the author, so it can be removed here. */
  removable: boolean
}

export interface HelpView {
  /** DSH's plugin manager is at hand: installing and removing work from the Studio. */
  manage: boolean
  packages: HelpPackage[]
}

export interface NovelRpc {
  // ── workspace & project ──
  'workspace.info': { params: { sessionId?: string }; result: { workspaces: WorkspaceInfo[]; current?: string; active?: string; mode?: WorkMode; /** Folder a new workspace is created in by default. */ home?: string; /** The Host runs a build that is no longer the installed one. */ stale?: boolean; /** …and can put the installed one up itself (`host.reload`), without DSH restarting. */ reloadable?: boolean } }
  /** Register a folder as a Harness workspace: an existing `path`, or a new folder called `name` under the default location. */
  'workspace.create': { params: { name?: string; path?: string }; result: WorkspaceInfo }
  'project.create': { params: { workspace: string; title: string; language?: string; genre?: string; logline?: string; premise?: string; author?: string; idea?: string; /** The title is a placeholder: let the drafted foundation name the book. */ untitled?: boolean; sessionId?: string; /** Seal the book the moment it exists: everything written to it from then on is ciphertext. `label` is the name the shelf shows while it is locked. */ seal?: { password: string; label?: string } }; result: { root: string; jobId?: string; sealed?: boolean } }
  'project.state': { params: { root: string }; result: ProjectState }
  'project.update': { params: { root: string; patch: Partial<ProjectManifest> }; result: ProjectManifest }
  /**
   * Take a book off the shelf. Its own files are moved to the system trash
   * (`where: 'trash'`) or, where that cannot be reached, to a folder of the
   * Studio's own (`holding`) — `path` says where they are now. Nothing is
   * erased, and whatever else was in the book's folder stays (`left`).
   */
  'project.delete': { params: { root: string }; result: { title: string; where: 'trash' | 'holding' | 'beside'; path: string; left: string[]; folderRemoved: boolean } }
  // ── sealed books ──
  'lock.get': { params: { root: string }; result: LockView }
  /** Seal a book: every file of it is encrypted where it lies. `device` also lets this computer's own unlock open it. */
  'lock.seal': { params: { root: string; password: string; label?: string; device?: boolean }; result: JobStarted }
  /** Take the seal off; the book has to be unlocked. */
  'lock.unseal': { params: { root: string }; result: JobStarted }
  /** Unlock with the password, or (`device`) with this computer's own unlock — the system asks for a fingerprint or its password. */
  'lock.open': { params: { root: string; password?: string; device?: boolean }; result: LockView }
  'lock.close': { params: { root: string }; result: LockView }
  /** Change how an unlocked book opens: a new password, the name on the shelf, this computer's unlock on or off, or a device's grant withdrawn. */
  'lock.change': { params: { root: string; password?: string; label?: string; device?: boolean; forget?: { kind: 'grant' | 'device'; id: string } }; result: LockView }
  /**
   * The conversation to talk to the showrunner in. With `root`: the one that is on that book already, else (with `create`) a new one — a novelist's, in the book's workspace, named after the book and put on it. With `workspace` alone: a new novelist's conversation in that folder.
   * `sessionId` is absent where there is none and none was to be made, or this Harness cannot make one.
   */
  'conversation.open': { params: { root?: string; workspace?: string; create?: boolean }; result: { sessionId?: string; created?: boolean; title?: string } }
  'session.bind': { params: { sessionId: string; project?: string; mode?: WorkMode }; result: { mode: WorkMode; project?: string } }
  'events.wait': { params: { root?: string; revision: number; tick: number; timeoutMs?: number; /** With a session: also wake when its book in play is no longer `active`. */ sessionId?: string; active?: string }; result: { revision: number; tick: number; /** Root of the session's book in play. */ active?: string; mode?: WorkMode; /** The Host runs a build that is no longer the installed one: it has to be replaced to catch up with the Studio. */ stale?: boolean; /** …which it can do itself (`host.reload`); absent, DSH has to be restarted. */ reloadable?: boolean } }

  // ── bible ──
  'character.save': { params: { root: string; card: Partial<CharacterCard> }; result: CharacterCard }
  'character.delete': { params: { root: string; id: string }; result: { deleted: boolean } }
  /** Write down something of a character's life at a chapter (absent: before the story begins), over what its digest says; without `kind` the mark of that chapter is taken back. */
  'character.mark': { params: { root: string; id: string; chapter?: string; kind?: LifeMark['kind']; what?: string }; result: CharacterCard }
  'character.expand': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  /** Distill a character's appearance into a visual anchor for image generation. */
  'character.visual': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  /** Have the director find, in the book, the moments somebody is remembered by — their signature scenes — and keep them on their card (`visual.scenes`), the most their own first. A job; its result is the list, or says the book has none yet. */
  'character.scene': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  'world.save': { params: { root: string; entry: Partial<WorldEntry> }; result: WorldEntry }
  /** Make several entries one: `fold` are folded into `keep` — names, text, picture, ties, marks on scenes all go with them. */
  'world.merge': { params: { root: string; keep: string; fold: string[] }; result: { entry: WorldEntry; folded: string[]; ties: number } }
  /** Have the planner look for entries that are one thing under several names, and entries filed under the wrong kind. A job; its result is a `WorldTidy` — a proposal, nothing is changed. */
  'ai.worldTidy': { params: { root: string }; result: JobStarted }
  /**
   * Put the mark of something that stands in a place at a spot of the place's picture (`at`, fractions of its width and height),
   * or let it be laid out by itself again (no `at`); without a `key`, every mark of the picture is let go.
   */
  'world.pin': { params: { root: string; id: string; key?: string; at?: { x: number; y: number } }; result: WorldEntry }
  /**
   * Put somebody at a spot of the picture of who is what to whom (in the units of its layout), let them stand where
   * the layout puts them again (no `at`), or let everybody (no `id`). Kept with the book; nothing of its record.
   */
  'graph.place': { params: { root: string; id?: string; at?: { x: number; y: number } }; result: { graph: Record<string, { x: number; y: number }> } }
  'world.delete': { params: { root: string; id: string }; result: { deleted: boolean } }
  /** Add a tie between two things of the book's world, or say again one that is there (its chapters, its note). Ends by id or by name. */
  'tie.save': { params: { root: string; tie: Omit<Tie, 'id'> & { id?: string } }; result: Tie }
  'tie.remove': { params: { root: string; id: string }; result: { removed: boolean } }
  /**
   * Have the planner work out how the things of the world stand to each other — what is in what, who belongs where, lives
   * where, holds what, from which chapter to which — from the bible and the chapter digests. A job; its result says what was found.
   */
  'ai.ties': { params: { root: string; direction?: string }; result: JobStarted }
  'world.expand': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  /** Have the director write down how a place or a thing looks, from what the book says of it; kept on the entry. A job. */
  'ai.worldLook': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  'style.save': { params: { root: string; style: Partial<StyleProfile>; activate?: boolean }; result: StyleProfile }
  'style.delete': { params: { root: string; id: string }; result: { deleted: boolean } }
  'style.extract': { params: { root: string; sample: string; name?: string; activate?: boolean }; result: JobStarted }
  'style.sample': { params: { root: string; style?: string; draft?: StyleProfile; scene?: string }; result: JobStarted }
  /** People on the page without a card. */
  'cast.walkons': { params: { root: string; ignored?: boolean }; result: { walkons: WalkOn[] } }
  /** Give a walk-on a card, fold them into a character as an alias, or take them off the list. */
  'cast.settle': { params: { root: string; name: string; action: 'card' | 'alias' | 'ignore' | 'restore'; target?: string; role?: CharacterRole }; result: { walkons: WalkOn[]; card?: CharacterCard; lines: number } }
  'suggestion.accept': { params: { root: string; id: string }; result: { ok: boolean } }
  'suggestion.dismiss': { params: { root: string; id: string }; result: { ok: boolean } }

  // ── outline ──
  'outline.apply': { params: { root: string; ops: OutlineOpInput[] }; result: { results: { op: string; ok: boolean; id?: string; message: string }[] } }
  /**
   * Fill what chapter plans leave empty — synopsis, place, time, cast, threads — from the chapters' digests; nothing that is written is replaced.
   * `dry`: only count. Result: chapters touched and fields filled.
   */
  'outline.fill': { params: { root: string; dry?: boolean }; result: { chapters: number; fields: number } }

  // ── manuscript ──
  'chapter.read': { params: { root: string; id: string }; result: ChapterDocument }
  'chapter.save': { params: { root: string; id: string; text: string; reason?: string }; result: { words: number; changed: boolean } }
  'chapter.version': { params: { root: string; id: string; version: string }; result: { text: string } }
  'chapter.restore': { params: { root: string; id: string; version: string }; result: { ok: boolean } }
  'search': { params: { root: string; query: string; sources?: SearchSource[]; limit?: number }; result: { hits: SearchHit[]; embedded: number; indexed: number; embeddingError?: string } }
  'find': { params: { root: string; query: string; limit?: number }; result: { matches: FindMatch[]; total: number } }

  // ── model work (jobs) ──
  'ai.write': { params: { root: string; chapter?: string; brief?: string; mode?: 'draft' | 'continue'; words?: number; style?: string; /** With no chapter named: the line of the plot to go on with. */ line?: string }; result: JobStarted }
  'ai.reviseSpan': { params: { root: string; chapter: string; start: number; end: number; quote?: string; instruction: string }; result: JobStarted }
  'ai.reviseChapter': { params: { root: string; chapter: string; instruction: string }; result: JobStarted }
  /** Mend what a review found: at the place it quotes (`passage`), or wherever it reaches (`book` — the planner traces it through the chapters and the bible). `note` is what the author wants done about it. Changes come back as proposals. */
  'ai.fixIssue': { params: { root: string; chapter: string; issue: string; note?: string; scope: 'passage' | 'book' }; result: JobStarted }
  'ai.reviseBook': { params: { root: string; instruction: string; chapters?: string[] }; result: JobStarted }
  'ai.digest': { params: { root: string; chapters?: string[]; force?: boolean }; result: JobStarted }
  'ai.review': { params: { root: string; chapter: string; focus?: string }; result: JobStarted }
  /**
   * Derive chapter outlines. `line` and `after` say where; `mode` what becomes of what is there already:
   * `append` adds, `replace` puts the new chapters in its place (written chapters are kept as a line put aside),
   * `branch` leaves it and opens a line of its own (`title`, `choice`). More than ten chapters are derived in rounds.
   */
  'ai.deriveChapters': { params: { root: string; count?: number; direction?: string; volume?: string; apply?: boolean; line?: string; after?: string; mode?: 'append' | 'replace' | 'branch'; title?: string; choice?: string }; result: JobStarted }
  'ai.deriveBeats': { params: { root: string; chapter: string; direction?: string }; result: JobStarted }
  'ai.whatIf': { params: { root: string; question: string; branches?: number }; result: JobStarted }
  /** Read the book and write down what it says — the passes of an import's analysis, on a book that has its chapters. Without `steps`: what an analysis that was cut short has left to do (all of it where none was started). */
  'ai.analyze': { params: { root: string; steps?: AnalyzeStep[] }; result: JobStarted }
  /** Have the director settle the look of the book's pictures from the book itself; `direction` is what the author wants of it. The look is written into the book (`novel.json`: `artStyle`, `artAvoid`). */
  'ai.artDirection': { params: { root: string; direction?: string }; result: JobStarted }
  'ai.import': { params: { root: string; text?: string; /** A book file to read on the Host (EPUB); `data` is base64. */ file?: { name: string; data: string }; analyze?: boolean }; result: JobStarted }
  'ai.foundation': { params: { root: string; idea: string }; result: JobStarted }
  'ai.index': { params: { root: string }; result: JobStarted }
  'proposal.accept': { params: { root: string; id: string }; result: Proposal }
  'proposal.reject': { params: { root: string; id: string }; result: { ok: boolean } }
  'review.resolve': { params: { root: string; chapter: string; issue: string; resolved: boolean }; result: { ok: boolean } }
  /** Throw a chapter's review away. */
  'review.clear': { params: { root: string; chapter: string }; result: { removed: boolean } }

  // ── batches: the same work for many chapters, characters or places, as one job ──
  /** Where the stage production of each written chapter stands, and what each step lacks to run at all. */
  'batch.overview': { params: { root: string; line?: string }; result: { chapters: StageStatus[]; missing: Partial<Record<StageStep, string>> } }
  /** Script, voices, sound, storyboard, panels, video — whichever are named — for the chapters named (all written ones when left out). */
  'batch.stage': { params: { root: string; chapters?: string[]; line?: string; steps?: StageStep[]; force?: boolean; density?: StoryboardDensity; maxPanels?: number; direction?: string; subtitles?: boolean; sheetFirst?: boolean }; result: JobStarted }
  /** Beats, writing, memory, review for a run of chapters. Writing goes chapter after chapter; the rest side by side. */
  'batch.text': { params: { root: string; chapters?: string[]; count?: number; line?: string; steps: TextStep[]; brief?: string; words?: number; redo?: boolean; focus?: string }; result: JobStarted }
  /** Design sheets, portraits and voices for characters, reference art for places, design art for things, an illustration per chapter, a cover. */
  'batch.art': { params: { root: string; sheets?: string[]; portraits?: string[]; voices?: string[]; places?: string[]; items?: string[]; scenes?: string[]; cover?: boolean; insert?: boolean; force?: boolean; sheetFirst?: boolean }; result: JobStarted }

  // ── jobs ──
  /** `gates`: the kinds of request that have work waiting or a service pushing back right now. */
  'jobs.list': { params: { root?: string }; result: { jobs: JobInfo[]; gates?: Partial<Record<GateKind, GateState>> } }
  /** `thoughtCursor` asks for the models' thought as well, from that many characters on. */
  'jobs.read': { params: { id: string; cursor?: number; thoughtCursor?: number; waitMs?: number }; result: { text: string; cursor: number; info: JobInfo; thought?: string; thoughtCursor?: number } }
  'jobs.cancel': { params: { id: string }; result: { cancelled: boolean } }

  // ── stage: illustration ──
  'image.create': { params: { root: string; kind: 'portrait' | 'sheet' | 'scene' | 'location' | 'item' | 'cover' | 'custom'; target?: string; quote?: string; prompt?: string; size?: string; insert?: boolean; /** Portrait, sheet: the author's loose ideas — what is of the person goes into their look, what is of this picture directs it only. */ notes?: string; /** Sheet: which look (outfit) to draw. */ look?: string; looks?: Record<string, string>; characters?: string[]; avoid?: string[]; raw?: boolean; /** false: this once, no design sheet is drawn first. */ sheetFirst?: boolean; /** Portrait: plain — facing the viewer on a plain ground, not their signature scene. */ plain?: boolean; /** Portrait: which of their signature scenes it shows (by id). */ scene?: string; /** Location, item: the turn of its course to draw it at (`<chapter>` or `<chapter>:<kind>`); the picture is kept with that turn. */ event?: string }; result: JobStarted }
  /**
   * Whose design sheets what is about to be drawn would draw first — asked before any of it is started, so that the author
   * can be told and say yes, or not this time. `unknown`: asks that cannot be told yet (panels with no storyboard).
   */
  'image.sheetsFirst': { params: { root: string; asks: SheetsAsk[] }; result: { people: { id: string; name: string }[]; unknown: number } }
  'image.list': { params: { root: string }; result: { images: IllustrationInfo[] } }
  /** `released`: whose picture it was — the cards and entries it was taken off, by name. Absent from a Host before the picture was taken off them. */
  'image.delete': { params: { root: string; id: string }; result: { ok: boolean; released?: string[] } }

  // ── stage: audio drama ──
  'audio.script': { params: { root: string; chapter: string }; result: { script?: AudioScript; stale: boolean; /** The voice each speaker of this chapter has, or will get, in the audio drama. */ cast?: { characters: Record<string, string>; extras: Record<string, string> }; /** What can make sound for this book, when something can. */ sound?: { model: string; shared: boolean; beds: 'generate' | 'browser' } } }
  'audio.build': { params: { root: string; chapter: string; force?: boolean }; result: JobStarted }
  'audio.synthesize': { params: { root: string; chapter: string; lines?: string[]; force?: boolean }; result: JobStarted }
  /** `voiced`: false leaves the line unspoken, true has it spoken, null hands it back to the book's rule for speech tags. */
  'audio.updateLine': { params: { root: string; chapter: string; line: string; patch: Partial<Pick<AudioLine, 'text' | 'kind' | 'speaker' | 'speakerName' | 'direction'>> & { voiced?: boolean | null } }; result: AudioScript }
  /** Shape a script cut the older, finer way — narration in whole takes — without asking a model again. */
  'audio.reshape': { params: { root: string; chapter: string }; result: { script: AudioScript; before: number; after: number; kept: number } }
  /** Take one line out of the script; cues and storyboard panels that hung on it are settled. */
  'audio.removeLine': { params: { root: string; chapter: string; line: string }; result: { script: AudioScript; panels: number } }
  /** Throw the chapter's script away. */
  'audio.clear': { params: { root: string; chapter: string }; result: { removed: boolean } }
  /** Generate the clips of the chapter's sound cues: effects, music and beds. */
  'audio.sound': { params: { root: string; chapter: string; cues?: string[]; kinds?: SoundKind[]; force?: boolean }; result: JobStarted }
  /** Change one sound cue, drop its clip, or take the cue out. */
  'audio.updateCue': { params: { root: string; chapter: string; cue: string; patch?: Partial<Pick<AudioCue, 'kind' | 'at' | 'caption' | 'prompt' | 'ambience' | 'intensity'>>; remove?: boolean; dropClip?: boolean }; result: AudioScript }
  'audio.addCue': { params: { root: string; chapter: string; at: string; kind: SoundKind; caption?: string; prompt?: string; ambience?: AmbiencePreset; intensity?: number }; result: AudioScript }
  'audio.export': { params: { root: string; chapter: string }; result: { path: string; duration: number; missing: number } }
  /** A job whose output is `{ path, duration }`: a new voice is set up before it speaks, and that takes a while. */
  'voice.audition': { params: { root: string; voice?: string; /** Hear this character as their lines will sound, when no voice is named. */ character?: string; text: string; direction?: string }; result: JobStarted }
  'voice.design': { params: { root: string; character: string; prompt?: string }; result: JobStarted }

  // ── stage: motion comic ──
  'comic.board': { params: { root: string; chapter: string }; result: { board?: ComicBoard; stale: boolean } }
  'comic.build': { params: { root: string; chapter: string; force?: boolean; /** How finely to cut; the book's own setting when left out. */ density?: StoryboardDensity; maxPanels?: number }; result: JobStarted }
  'comic.render': { params: { root: string; chapter: string; panels?: string[]; force?: boolean; /** false: this once, no design sheet is drawn first. */ sheetFirst?: boolean }; result: JobStarted }
  'comic.updatePanel': { params: { root: string; chapter: string; panel: string; patch: Partial<Pick<ComicPanel, 'prompt' | 'description' | 'camera'>> }; result: ComicBoard }
  /** Take one panel out; its lines go to a neighbour. */
  'comic.removePanel': { params: { root: string; chapter: string; panel: string }; result: ComicBoard }
  /** Throw the chapter's storyboard away; its pictures stay in the gallery. */
  'comic.clear': { params: { root: string; chapter: string }; result: { removed: boolean } }
  /** The chapter's video, and what a new one could be cut from. */
  'video.status': { params: { root: string; chapter: string }; result: { video?: ChapterVideo; ready: VideoReady } }
  /** Have post-production cut the chapter's video. */
  'video.produce': { params: { root: string; chapter: string; direction?: string; /** false: the author wants no subtitles. Default: the cut carries them. */ subtitles?: boolean }; result: JobStarted }
  /** Delete the chapter's video file. */
  'video.remove': { params: { root: string; chapter: string }; result: { removed: boolean } }

  // ── stage: interlude ──
  'play.list': { params: { root: string }; result: { sessions: Pick<PlaySession, 'id' | 'title' | 'updatedAt' | 'outcome' | 'player' | 'cast' | 'anchorChapter'>[] } }
  'play.get': { params: { root: string; id: string }; result: PlaySession }
  'play.start': { params: { root: string; title?: string; anchor?: string; player?: string; cast: string[]; location?: string; situation: string; tone?: string }; result: PlaySession }
  'play.turn': { params: { root: string; id: string; kind?: 'say' | 'do' | 'choice' | 'direct'; text: string }; result: { session: PlaySession; turn: PlayTurn } }
  'play.rewind': { params: { root: string; id: string }; result: PlaySession }
  'play.outcome': { params: { root: string; id: string; outcome: 'open' | 'discarded' | 'side-story' }; result: PlaySession }
  'play.delete': { params: { root: string; id: string }; result: { ok: boolean } }
  'play.voice': { params: { root: string; id: string; turn: string; line: number }; result: { path: string } }
  'play.scene': { params: { root: string; id: string; turn: string }; result: { path: string } }
  'play.portrait': { params: { root: string; character: string }; result: { path: string } }
  /** `as: 'line'`: the scene becomes the first chapter of a line of the plot of its own, leaving where it branched off. */
  'play.novelize': { params: { root: string; id: string; title?: string; as?: 'chapter' | 'line'; choice?: string }; result: JobStarted }

  // ── export ──
  'export.book': { params: { root: string; format: 'markdown' | 'text' | 'html' | 'epub' }; result: { path: string; chapters: number; bytes: number; absolute: string } }
  /** Where a book would be published as a site, and what there is to publish. */
  /**
   * Everyone's life along one line of the plot, read off the chapter digests: the chapters of the line, and for each
   * character who is in any of them the chapters they are in with what was noted. The main line when `line` is left out.
   */
  /** The world as a line of the plot leaves it: who has come on and how they stand at its end, which threads are open and which paid off. The main line when `line` is left out. */
  'line.world': { params: { root: string; line?: string }; result: LineWorld }
  'cast.lives': { params: { root: string; line?: string }; result: { chapters: { id: string; index: number; title: string; digested: boolean }[]; lives: Record<string, Life> } }
  /** Have continuity write somebody's life on the page as a paragraph, from what the digests noted; saved on the card. A job. */
  'ai.characterLife': { params: { root: string; id: string; line?: string }; result: JobStarted }
  'site.plan': { params: { root: string; out?: string }; result: SitePlan }
  /**
   * Publish a book as a site of its own: a folder any static host serves. A job; its result is a `SiteDone`.
   * A sealed book is published in the open, and only when `sealedOk` says the author knows.
   */
  'site.publish': { params: {
    root: string
    out?: string
    /** Only these chapters; or, with `upto`, the written chapters of the main line as far as that one — a book published a part at a time. */
    chapters?: string[]
    upto?: string
    listen?: boolean
    watch?: boolean
    album?: boolean
    sides?: boolean
    /** `false` leaves the finished videos out: the motion comic still plays, and the site is much smaller. */
    video?: boolean
    /** `false` publishes the main line only. (With `chapters` or `upto` — a part of the book — it is the main line anyway.) */
    lines?: boolean
    /** How the site opens for a visitor who has set nothing: the publisher's own reading settings, as their browser keeps them. */
    defaults?: { prefs?: object; options?: object }
    /** `false` publishes voices and sound as they lie in the book (WAV); otherwise they go out as AAC, a quarter the size, when this computer has ffmpeg. */
    press?: boolean
    /** `false` publishes pictures as they lie in the book (PNG); otherwise PNG pictures go out as JPEG — looking the same, a fifth to a tenth the size — when this computer has ffmpeg. */
    jpeg?: boolean
    sealedOk?: boolean
  }; result: JobStarted }
  /** Where the book was last read, on whichever device; with `chapter`, leave the Studio's own place there. Nothing when nobody left one. */
  'reader.position': { params: { root: string; chapter?: string }; result: { position?: { chapter: string; at: string; by: string } } }
  /** The people and the world of a book as its viewer shows them — to the author: also who and what the text has not come to yet. */
  /** `line`: the album along a line of the plot other than the main one — a Host from before that answers with the main line's. */
  'reader.album': { params: { root: string; line?: string }; result: Album }
  /** The interludes kept as side stories, as the viewer lists them; with `id`, one of them as it is read. */
  'reader.sides': { params: { root: string; id?: string }; result: { sides: { id: string; title: string; turns: number; situation?: string }[]; play?: Pick<PlaySession, 'id' | 'title' | 'situation' | 'location' | 'turns'> } }

  // ── reading on other devices ──
  'share.status': { params: Record<string, never>; result: ShareStatus }
  /** Switch the reader for other devices on or off, share or stop sharing a book, move it to another port, or replace its address (`renew`) so earlier links stop working. */
  'share.update': { params: { enabled?: boolean; book?: { root: string; shared: boolean; mode?: 'read' | 'edit' }; port?: number; renew?: boolean }; result: ShareStatus }

  // ── settings ──
  'usage.summary': { params: { /** Only calls made for this book. */ root?: string; range?: 'today' | '7d' | '30d' | 'all' }; result: { summary: UsageSummary; prices: Record<string, PriceEntry>; /** When counting began: the first call on record. */ begun?: string } }
  /**
   * Put the installed build of the Host half up in place of the one that runs, without restarting DSH.
   * Answered before it happens: `jobs` is how many running jobs the change stops. The Studio's routes are away for a moment afterwards.
   */
  'host.reload': { params: Record<string, never>; result: { jobs: number } }
  /** Install an outside-help plugin through DSH's own plugin manager (it downloads the package). The job's result says how it went and whether DSH has to be restarted. */
  'help.install': { params: { id: HelpPackage['id'] }; result: JobStarted }
  /** Remove an outside-help plugin the author installed. */
  'help.remove': { params: { id: HelpPackage['id'] }; result: HelpView & { message?: string } }
  'settings.get': { params: Record<string, never>; result: SettingsView }
  /** `keys` maps an endpoint address to the key to save for its host; an empty string forgets the saved key. */
  'settings.update': { params: { patch: Record<string, unknown>; keys?: Record<string, string> }; result: SettingsView }
  'key.state': { params: { endpoints: { url: string; ref?: string }[] }; result: { states: KeyState[] } }
  /** List what an endpoint serves; `key` tries a key that has not been saved yet. */
  'endpoint.models': { params: { url: string; kind: ModelKind; key?: string; ref?: string }; result: { models: EndpointModel[] } }
  'endpoint.check': { params: { url: string; key?: string; ref?: string }; result: EndpointCheck }
  /** One-click setup: save the key and fill the chosen slots with the service's recommended models. */
  'setup.apply': { params: { service: ServiceId | 'codex'; key?: string; origin?: string; parts: SetupPart[] }; result: { view: SettingsView; check: EndpointCheck } }
  /** Mark the first-run guide as seen so it no longer opens by itself. */
  'setup.dismiss': { params: Record<string, never>; result: SettingsView }
  /** Settle the notice an issue of the recommendations left: take it up, keep what is there, take it back, or just have read it. */
  'recommended.settle': { params: { action: 'adopt' | 'keep' | 'revert' | 'dismiss' }; result: SettingsView }
  'model.info': { params: { provider: string; model: string; baseURL?: string }; result: ModelDetails }
}

export type RpcMethod = keyof NovelRpc
export type RpcParams<M extends RpcMethod> = NovelRpc[M]['params']
export type RpcResult<M extends RpcMethod> = NovelRpc[M]['result']

/** What travels in the Connection payload. */
export interface RpcEnvelope {
  method: string
  params: unknown
  /** The conversation this Studio sits beside, when it sits beside one: work it starts belongs to that conversation. */
  session?: string
}

/** Stable failure codes of the route (`details` is always an object). */
export type RpcErrorCode =
  | 'novel/bad-request' | 'novel/unknown-method' | 'novel/no-project' | 'novel/not-found' | 'novel/invalid'
  | 'novel/empty' | 'novel/provider' | 'novel/model' | 'novel/cancelled' | 'novel/internal' | string

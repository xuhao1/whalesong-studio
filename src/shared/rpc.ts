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
import type { ImageLimits } from './images'
import type { Life } from './life'
import type { PortraitPlace } from './reader'
import type { LineWorld } from './worldline'
import type { Tie } from './ties'
import type { Recommended } from './recommended'
import type { ServiceId, SetupPart } from './services'
import type {
  AnalyzeStep, ComfyCatalog,
  PriceEntry,
  UsageSummary,
  TtsProviderKind, TtsSettings, SpeechTrial, PictureGuide, ReferenceAspect, ReferenceShelf,
  AmbiencePreset, AudioCue, AudioLine, AudioScript, BookLock, ChapterMemory, ChapterPlan, ChapterReview, IssueSeverity, CharacterCard, CharacterRole, ComicBoard, ComicPanel, LifeMark, SheetsAsk,
  ChapterVideo, CrewRole, GateKind, GateState, IllustrationInfo, ImageTrial, JobInfo, SettledSuggestion, ModelRoute, NovelSettings, PictureWhole, PlaySession, PlayTurn, ProjectManifest, ProjectRef, ProjectState, RecommendedState,
  Proposal, SearchHit, SearchSource, SoundKind, StageStatus, StageStep, StoryboardDensity, StyleProfile, TextRole, TextStep, VersionInfo, WalkOn, WorkMode, WorldEntry, HistoryKind, HistoryVersion, GlossaryTerm, ChapterTranslation,
} from './types'

/**
 * How a book is locked, as a screen needs it: besides the book's own state,
 * what this computer can do to unlock it.
 */
/** How the private shelf stands: whether one was set up on this computer, and whether it is open now. */
export interface PrivateShelfState {
  set: boolean
  open: boolean
  /** This computer's own unlock, as for a sealed book. Absent on a Host from before the shelf opened by it. */
  device?: LockView['device']
  /** The shelf opens with this computer's own unlock. */
  deviceOn?: boolean
}

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
  /** Whether it takes pictures, where its provider says; absent, nobody said. */
  sees?: boolean
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
  /** Image models: what the endpoint says of the pictures it draws — how large, how long a prompt — where it says. */
  image?: ImageLimits
  /** The endpoint lists it without saying what it is, and its name does not say either: offered after the others. */
  unsure?: boolean
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

/** The door through which a phone on the network works the Studio: DSH's own page of this computer, handed on. */
export interface RemoteStatus {
  /** DSH serves a web page here that can be handed on (it runs as `dsh web`); not so in the desktop app. */
  possible: boolean
  running: boolean
  port?: number
  /** Addresses a device on the same network opens, the likeliest first. Each carries the door's token. */
  urls: string[]
  since?: string
  /** When it closes by itself. */
  until?: string
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
  /** The same told for the book that was asked about, with its own settings counted in. Absent where no book was named, and on a Host from before a book had services of its own. */
  book?: BookSettingsView
}

/** How the settings stand for one book: what it can do with its own services, and what its crew really runs on. */
export interface BookSettingsView {
  root: string
  ready: { image: boolean; tts: boolean; sound: boolean; embedding: boolean }
  /** The crew as it stands for this book: each role on the model the book gives it, where it gives one. */
  roles: CrewView['roles']
  context: ContextView[]
  /** Stock voices of the speech service the book speaks with. */
  voices: VoiceOption[]
  /**
   * Roles this book names a model for that DSH does not list now (the provider is gone, or no longer has the model):
   * the role cannot run on it. Told so the page can say it and offer the way out, not found when a job fails.
   */
  unlisted: { role: TextRole; provider: string; model: string; /** The provider itself is not among DSH's. */ noProvider: boolean }[]
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
  /** The pictures of people's moments that fall in this chapter, each where the chapter tells it: shown beside the text, not part of it. */
  figures?: { path: string; caption: string; after: number }[]
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
  'workspace.info': { params: { sessionId?: string }; result: { workspaces: WorkspaceInfo[]; /** The private shelf; absent from a Host that has none. */ shelf?: PrivateShelfState; current?: string; active?: string; mode?: WorkMode; /** Folder a new workspace is created in by default. */ home?: string; /** The Host runs a build that is no longer the installed one. */ stale?: boolean; /** …and can put the installed one up itself (`host.reload`), without DSH restarting. */ reloadable?: boolean } }
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
  // ── the private shelf: books not shown among the others until its password is given ──
  'shelf.get': { params: Record<string, never>; result: PrivateShelfState }
  /** Set it up (opened at once). Books already here that stand on a shelf this password opens are on it again. */
  'shelf.setup': { params: { password: string }; result: PrivateShelfState }
  'shelf.open': { params: { password?: string; /** By this computer's own unlock, where the shelf was set up for it. */ device?: boolean }; result: PrivateShelfState }
  /** Let this computer's own unlock (a fingerprint, the computer's password) open the shelf, which is open now; or stop letting it. */
  'shelf.device': { params: { on: boolean }; result: PrivateShelfState }
  /** Close it: every book on it is locked and leaves the shelf's list. */
  'shelf.close': { params: Record<string, never>; result: PrivateShelfState }
  'shelf.change': { params: { password: string; next: string }; result: PrivateShelfState }
  /**
   * Put a book on it (the shelf has to be open). A plain book is sealed for it. `own`: the book asks for a password
   * of its own besides — a string sets one, `true` keeps the one a sealed book has.
   */
  'shelf.add': { params: { root: string; own?: string | boolean }; result: JobStarted }
  /** Take a book off it: shown among the others again, still sealed. `password`: what opens it from now on, where the shelf's key was all that did. */
  'shelf.remove': { params: { root: string; password?: string }; result: PrivateShelfState }
  /**
   * The conversation to talk to the showrunner in. With `root`: the one that is on that book already, else (with `create`) a new one — a novelist's, in the book's workspace, named after the book and put on it. With `workspace` alone: a new novelist's conversation in that folder.
   * `sessionId` is absent where there is none and none was to be made, or this Harness cannot make one.
   */
  'conversation.open': { params: { root?: string; workspace?: string; create?: boolean }; result: { sessionId?: string; created?: boolean; title?: string } }
  'session.bind': { params: { sessionId: string; project?: string; mode?: WorkMode }; result: { mode: WorkMode; project?: string } }
  'events.wait': { params: { root?: string; revision: number; tick: number; timeoutMs?: number; /** With a session: also wake when its book in play is no longer `active`. */ sessionId?: string; active?: string }; result: { revision: number; tick: number; /** Root of the session's book in play. */ active?: string; mode?: WorkMode; /** The Host runs a build that is no longer the installed one: it has to be replaced to catch up with the Studio. */ stale?: boolean; /** …which it can do itself (`host.reload`); absent, DSH has to be restarted. */ reloadable?: boolean } }

  // ── bible ──
  'character.save': { params: { root: string; card: Partial<CharacterCard> }; result: CharacterCard }
  /** Have one of the pictures drawn of a moment of somebody's (`scene`: its id on their card) stand for it — in their panel, and in the text where the moment is told. */
  'character.scenePicture': { params: { root: string; id: string; scene: string; path: string }; result: CharacterCard }
  'character.delete': { params: { root: string; id: string }; result: { deleted: boolean } }
  /** Write down something of a character's life at a chapter (absent: before the story begins), over what its digest says; without `kind` the mark of that chapter is taken back. */
  'character.mark': { params: { root: string; id: string; chapter?: string; kind?: LifeMark['kind']; what?: string }; result: CharacterCard }
  'character.expand': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  /** Distill a character's appearance into a visual anchor for image generation. */
  'character.visual': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  /** Have the director find, in the book, the moments somebody is remembered by — their signature scenes — and keep them on their card (`visual.scenes`), the most their own first. A job; its result is the list, or says the book has none yet. */
  'character.scene': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  /** Have the planner find the stretches of somebody's life in the book — how old they are as they enter, where they turn in age, look and station — and keep them on their card (`stages`). A job. */
  'character.growth': { params: { root: string; id: string; direction?: string }; result: JobStarted }
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
  /** Ask a ComfyUI server what it has to draw with. `baseURL`: the address as typed; left out, the one in the settings. */
  'image.comfy': { params: { baseURL?: string }; result: ComfyCatalog }
  /** The last run of that server that made a picture, as a workflow with the Studio's placeholders in it: what the settings keep as the workflow. */
  'image.comfyAdopt': { params: { baseURL?: string }; result: { workflow: string; model?: string; nodes: string[]; images: number } }
  /** A workflow saved on that server (`path` under its workflows folder), as a workflow the Studio fills in: converted from the editor's format, with placeholders for the words, the size, the seed and the reference pictures. */
  'image.comfyTake': { params: { baseURL?: string; path: string }; result: { workflow: string; model?: string; nodes: string[]; images: number } }
  /** Have the planner look through the names without a card and say who is worth one. `all`: every name again, also those already looked at or proposed. */
  'cast.sift': { params: { root: string; all?: boolean; direction?: string }; result: JobStarted }
  'cast.settle': { params: { root: string; name: string; /** Which of two walk-ons by one name: the story they are of. */ story?: string; action: 'card' | 'alias' | 'ignore' | 'restore'; target?: string; role?: CharacterRole }; result: { walkons: WalkOn[]; card?: CharacterCard; lines: number } }
  'suggestion.accept': { params: { root: string; id: string }; result: { ok: boolean } }
  'suggestion.dismiss': { params: { root: string; id: string }; result: { ok: boolean } }
  /** Read the book again from nothing but its text: what was read off it is cleared first, then it is taken in anew. */
  'import.reread': { params: { root: string; plans?: boolean; reviews?: boolean; style?: boolean }; result: { jobId: string } }
  /** What was settled of the suggestions without the author being asked, the latest first. */
  'suggestion.settled': { params: { root: string }; result: { items: SettledSuggestion[]; auto: boolean } }
  /** Have the planner settle what waits, now. */
  'suggestion.settle': { params: { root: string }; result: { jobId: string } }
  /** Say otherwise of one that was settled: `undo` takes back what entered, `enter` enters what was left out. */
  'suggestion.overrule': { params: { root: string; id: string; to: 'undo' | 'enter' }; result: { item: SettledSuggestion } }

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
  'ai.write': { params: { root: string; chapter?: string; brief?: string; mode?: 'draft' | 'continue'; words?: number; style?: string; /** With no chapter named: the line of the plot to go on with. */ line?: string; /** Pictures to write this pass by, instead of the ones kept on the chapter's plan. */ guides?: PictureGuide[] }; result: JobStarted }
  'ai.reviseSpan': { params: { root: string; chapter: string; start: number; end: number; quote?: string; instruction: string; /** Pictures to rewrite the passage by. */ guides?: PictureGuide[] }; result: JobStarted }
  'ai.reviseChapter': { params: { root: string; chapter: string; instruction: string; /** Pictures to rewrite it by, in place of the ones kept on its plan. */ guides?: PictureGuide[] }; result: JobStarted }
  /** Mend what a review found: at the place it quotes (`passage`), or wherever it reaches (`book` — the planner traces it through the chapters and the bible). `note` is what the author wants done about it. Changes come back as proposals. */
  /** `order` — `queue`: after the mendings already asked for, going on from what they leave waiting; `apart` (as before it could be said): at once, on the text as it stands. */
  'ai.fixIssue': { params: { root: string; chapter: string; issue: string; note?: string; scope: 'passage' | 'book'; order?: 'queue' | 'apart' }; result: JobStarted }
  'ai.reviseBook': { params: { root: string; instruction: string; chapters?: string[]; /** The line of the plot the revision is of, when it is not the main one. */ line?: string; order?: 'queue' | 'apart'; /** Pictures the revision goes by. */ guides?: PictureGuide[] }; result: JobStarted }
  'ai.digest': { params: { root: string; chapters?: string[]; force?: boolean }; result: JobStarted }
  'ai.review': { params: { root: string; chapter: string; focus?: string }; result: JobStarted }
  /**
   * Derive chapter outlines. `line` and `after` say where; `mode` what becomes of what is there already:
   * `append` adds, `replace` puts the new chapters in its place (written chapters are kept as a line put aside),
   * `branch` leaves it and opens a line of its own (`title`, `choice`). More than ten chapters are derived in rounds.
   */
  'ai.deriveChapters': { params: { root: string; count?: number; direction?: string; volume?: string; apply?: boolean; line?: string; after?: string; mode?: 'append' | 'replace' | 'branch'; title?: string; choice?: string; /** Pictures to steer the chapters by. */ guides?: PictureGuide[] }; result: JobStarted }
  /**
   * Bring a picture into the book to steer a plot or a chapter by: kept among its files (`assets/guides/`), where the
   * same picture brought twice is one file. `data` is the picture's bytes in base64.
   */
  'guide.add': { params: { root: string; mediaType: string; data: string }; result: { path: string } }
  // ── references: the books this one goes by ──
  /** The references of a book, each as it is found now, and how they are used. */
  'references.list': { params: { root: string }; result: ReferenceShelf }
  /**
   * Take a reference: a book of the shelf (`book`: its folder) — consulted as it is organised there — or a manuscript
   * (`text`, or `file` to be read on the Host; `data` is base64) — kept with this book and consulted as plain text.
   * `note`: how to go by it, in the author's words. `scope`: what of a shelf book is open; left out: all of it.
   */
  'references.add': { params: { root: string; book?: string; text?: string; file?: { name: string; data: string }; title?: string; note?: string; scope?: ReferenceAspect[] }; result: ReferenceShelf }
  /** What the author says of a reference: how to go by it, what of it is open (`null`: all of it), whether it is consulted, what a manuscript is called. */
  'references.update': { params: { root: string; id: string; note?: string; scope?: ReferenceAspect[] | null; off?: boolean; title?: string }; result: ReferenceShelf }
  /** Take a reference off the list; a manuscript taken in for this book goes with it. */
  'references.remove': { params: { root: string; id: string }; result: ReferenceShelf }
  /** Whether the planner looks in the references before a chapter is written. */
  'references.settings': { params: { root: string; beforeWriting: boolean }; result: ReferenceShelf }
  /** Have the planner look in the references for one chapter and keep its notes on the chapter's plan. */
  'references.consult': { params: { root: string; chapter: string; direction?: string }; result: JobStarted }
  'ai.deriveBeats': { params: { root: string; chapter: string; direction?: string }; result: JobStarted }
  'ai.whatIf': { params: { root: string; question: string; branches?: number; /** Pictures the ways on are weighed with. */ guides?: PictureGuide[] }; result: JobStarted }
  /** Read the book and write down what it says — the passes of an import's analysis, on a book that has its chapters. Without `steps`: what an analysis that was cut short has left to do (all of it where none was started). */
  'ai.analyze': { params: { root: string; steps?: AnalyzeStep[] }; result: JobStarted }
  /** Have the director settle the look of the book's pictures from the book itself; `direction` is what the author wants of it. The look is written into the book (`novel.json`: `artStyle`, `artAvoid`). */
  'ai.artDirection': { params: { root: string; direction?: string }; result: JobStarted }
  /** On which lines of the plot each character is seen, read off the digests along each line. */
  'lines.seen': { params: { root: string }; result: { lines: { id: string; title: string; /** The line its story begins on: lines that parted from one another tell one story. Absent from a Host before this. */ story?: string }[]; people: Record<string, string[]>; /** The bible's entries the same way: the lines whose text names each. Not sent by a Host from before. */ world?: Record<string, string[]> } }
  /**
   * File a batch of cards and entries under lines of the plot: these and no other; no line named — every line again.
   * `byText`: each under the lines it is found on (what is on all of them, or on none, is `left` as it was).
   */
  'lines.assign': { params: { root: string; lines?: string[]; byText?: boolean; characters?: string[]; world?: string[] }; result: { characters: string[]; world: string[]; lines: string[]; left?: string[] } }
  /** Where each entry of the bible is named along a line, and how many written chapters the line has to name it in. */
  'world.presence': { params: { root: string; line?: string }; result: { presence: { entry: string; chapters: string[] }[]; written: number } }
  /**
   * Import a manuscript as another line of this book's plot: a story different from its first chapter, in the same
   * world. The line begins where the story begins; its chapters are digested unless `digest` is false. A job.
   */
  'line.import': { params: { root: string; title?: string; premise?: string; text?: string; file?: { name: string; data: string }; digest?: boolean }; result: JobStarted }
  'ai.import': { params: { root: string; text?: string; /** A book file to read on the Host (EPUB); `data` is base64. */ file?: { name: string; data: string }; analyze?: boolean; /** The manuscript is in another language than the book is to be in: translate it as it comes in (`to` the book's language). */ translate?: { to: string; from?: string; direction?: string } }; result: JobStarted }
  /** Translate chapters into a language: the names settled first where none are, each chapter by the glossary, its original kept as a version. Left without `chapters`: every chapter of `line` that has text. */
  'ai.translate': { params: { root: string; to: string; chapters?: string[]; line?: string; /** What the text is in; `auto` lets the translator tell. Left out: what each chapter is in now. */ from?: string; settle?: boolean; direction?: string }; result: JobStarted }
  /** Settle how the book's names are written in a language, before anything is translated: off the cards, and out of the text with `scan`. Adds; writes over nothing. */
  'ai.settleTerms': { params: { root: string; to: string; from?: string; scan?: boolean; direction?: string }; result: JobStarted }
  /** The book's glossaries by language, and which chapters are translations. */
  'glossary.read': { params: { root: string }; result: { glossaries: Record<string, GlossaryTerm[]>; translations: Record<string, ChapterTranslation> } }
  /** The glossary of a language as the author leaves it: what they changed or added is theirs, and no pass writes over it. */
  'glossary.save': { params: { root: string; to: string; terms: GlossaryTerm[] }; result: { terms: GlossaryTerm[] } }
  /** Put a translated chapter's original back as its text. */
  'chapter.untranslate': { params: { root: string; id: string }; result: { ok: boolean } }
  'ai.foundation': { params: { root: string; idea: string }; result: JobStarted }
  'ai.index': { params: { root: string }; result: JobStarted }
  'proposal.accept': { params: { root: string; id: string }; result: Proposal }
  'proposal.reject': { params: { root: string; id: string }; result: { ok: boolean } }
  'review.resolve': { params: { root: string; chapter: string; issue: string; resolved: boolean }; result: { ok: boolean } }
  /** Throw a chapter's review away. */
  'review.clear': { params: { root: string; chapter: string }; result: { removed: boolean } }
  /** Keep what the author says of how an issue is to be mended (an empty note takes it off). */
  'review.note': { params: { root: string; chapter: string; issue: string; note: string }; result: { ok: boolean } }
  /** Have the reviewer read the issues still open against the text as it stands now: what a revision settled is marked settled, what reads differently is brought up to date. `chapters`: only these. A job. */
  'review.recheck': { params: { root: string; chapters?: string[] }; result: JobStarted }
  /** Every review there is, in reading order — what a page that lists issues across chapters shows. */
  'review.list': { params: { root: string }; result: { reviews: (ChapterReview & { index: number; title: string })[] } }
  /**
   * Mend several issues in one go, also across chapters: one planner reads them side by side and each chapter is
   * rewritten once. `issues` names them (with what the author says of each); or `atLeast` takes every open issue that
   * grave or graver. Every change waits as a proposal. A job.
   */
  'ai.fixIssues': { params: { root: string; issues?: { chapter: string; issue: string; note?: string }[]; atLeast?: IssueSeverity; chapters?: string[]; note?: string; order?: 'queue' | 'apart' }; result: JobStarted }

  // ── batches: the same work for many chapters, characters or places, as one job ──
  /** Where the stage production of each written chapter stands, and what each step lacks to run at all. */
  'batch.overview': { params: { root: string; line?: string }; result: { chapters: StageStatus[]; missing: Partial<Record<StageStep, string>> } }
  /** Script, voices, sound, storyboard, panels, video — whichever are named — for the chapters named (all written ones when left out). */
  'batch.stage': { params: { root: string; chapters?: string[]; line?: string; steps?: StageStep[]; force?: boolean; density?: StoryboardDensity; maxPanels?: number; direction?: string; subtitles?: boolean; sheetFirst?: boolean }; result: JobStarted }
  /** Beats, writing, memory, review for a run of chapters. Writing goes chapter after chapter; the rest side by side. */
  'batch.text': { params: { root: string; chapters?: string[]; count?: number; line?: string; steps: TextStep[]; brief?: string; words?: number; redo?: boolean; focus?: string; /** Writing: one chapter after the other (default), or side by side. */ order?: 'sequence' | 'together' | 'iterate'; /** With `iterate`: rounds of review and mending at most, and how grave an issue is worth one. */ rounds?: number; atLeast?: 'high' | 'medium' | 'low' }; result: JobStarted }
  /** Design sheets, portraits and voices for characters, reference art for places, design art for things, an illustration per chapter, a cover. */
  'batch.art': { params: { root: string; sheets?: string[]; portraits?: string[]; voices?: string[]; places?: string[]; items?: string[]; scenes?: string[]; cover?: boolean; insert?: boolean; force?: boolean; sheetFirst?: boolean }; result: JobStarted }

  // ── jobs ──
  /** `gates`: the kinds of request that have work waiting or a service pushing back right now. */
  'jobs.list': { params: { root?: string }; result: { jobs: JobInfo[]; gates?: Partial<Record<GateKind, GateState>> } }
  /** `thoughtCursor` asks for the models' thought as well, from that many characters on. */
  'jobs.read': { params: { id: string; cursor?: number; thoughtCursor?: number; waitMs?: number }; result: { text: string; cursor: number; info: JobInfo; thought?: string; thoughtCursor?: number } }
  'jobs.cancel': { params: { id: string }; result: { cancelled: boolean } }

  // ── stage: illustration ──
  'image.create': { params: { root: string; kind: 'portrait' | 'sheet' | 'scene' | 'location' | 'item' | 'cover' | 'custom'; target?: string; quote?: string; prompt?: string; size?: string; insert?: boolean; /** Portrait, sheet: the author's loose ideas — what is of the person goes into their look, what is of this picture directs it only. */ notes?: string; /** Sheet: which look (outfit) to draw. */ look?: string; looks?: Record<string, string>; characters?: string[]; avoid?: string[]; raw?: boolean; /** false: this once, no design sheet is drawn first. */ sheetFirst?: boolean; /** What this picture of a person is drawn against, this once: a sheet against their `portrait` or from the `words` alone; a portrait against their `sheet` or from the `words` alone. Left out: by `image.lead`. */ from?: 'portrait' | 'sheet' | 'words'; /** Portrait: true — the plain likeness alone; false — their signature scene alone. Left out: what `image.portraits` says (by default both, one of each). */ plain?: boolean; /** Portrait: which of their signature scenes it shows (by id). */ scene?: string; /** Portrait, sheet: which stretch of their life it shows (a stage's id). */ stage?: string; /** Location, item: the turn of its course to draw it at (`<chapter>` or `<chapter>:<kind>`); the picture is kept with that turn. */ event?: string; /** Portrait: draw it once with each of these services, to compare them; none becomes their portrait until the author takes it. */ trials?: ImageTrial[] }; result: JobStarted }
  /**
   * Whose design sheets what is about to be drawn would draw first — asked before any of it is started, so that the author
   * can be told and say yes, or not this time. `unknown`: asks that cannot be told yet (panels with no storyboard).
   */
  /**
   * Draw a picture again from its record — whatever kind it is. `subject`: its words as the author rewrote them (the
   * art direction, what it kept out and its references go along as before). `change`: the picture itself is sent
   * along, to be drawn again with this one thing changed. The new picture takes the old one's place wherever it
   * hangs; the old one stays in the gallery. A job; its result names whose picture the new one is (`replaced`).
   */
  'image.redraw': { params: { root: string; picture: string; subject?: string; change?: string; /** The whole prompt, as the author rewrote it ({@link PictureWhole}): sent as it stands, with the pictures the one before went with. Not with `subject` or `change`. */ prompt?: string; /** With `prompt`: everything to keep out. Left out: what the picture kept out before. */ avoid?: string[]; /** Draw it as it is with each of these services, to compare them: nothing is replaced. */ trials?: ImageTrial[] }; result: JobStarted }
  /** Everything a picture was drawn from — the prompt whole, what was kept out, the pictures that went along — for its author to rewrite and draw it again by (`image.redraw` with `prompt`). */
  'image.whole': { params: { root: string; picture: string }; result: PictureWhole }
  /** The image services there are to try for a book — the one that draws for it now, and the ones set up before — and whether each can draw right now. */
  'trial.setups': { params: { root: string }; result: { image: (ImageTrial & { id: string; current: boolean; ready: boolean })[]; /** The speech setups there are to try, the same way. Absent from a Host that cannot compare speech yet. */ speech?: (SpeechTrial & { id: string; current: boolean; ready: boolean })[] } }
  /** The same words spoken by each of several speech setups — as a character's line, or the narrator's — to be listened to side by side. Nothing is cast or kept by it but the clips. */
  'trial.speak': { params: { root: string; text: string; character?: string; direction?: string; with: SpeechTrial[] }; result: JobStarted }
  /**
   * Have a speech setup that was tried speak from now on: for this book (`book`: it becomes the book's own setup) or
   * for every book (`studio`; the one left is remembered). `voice` with `character`: that character speaks with this
   * voice of it.
   */
  'trial.takeSpeech': { params: { root: string; tts: Partial<TtsSettings>; for: 'book' | 'studio'; character?: string; voice?: string }; result: { ok: boolean; label: string } }
  /**
   * Take one of the pictures drawn to compare services: it stands in the text again, and — `instead` — takes the place
   * of the picture it was tried against wherever that one hung, or — a portrait with nothing named — becomes the
   * person's first portrait. `others`: the rest of the comparison, deleted with that.
   */
  'trial.adopt': { params: { root: string; path: string; instead?: string; others?: string[] }; result: { ok: boolean; replaced: string[]; removed: number } }
  /** Have several of DSH's models write the same chapter at once; the chapter keeps its text, the drafts are kept among its versions (job result: `drafts`). */
  'trial.write': { params: { root: string; chapter?: string; brief?: string; mode?: 'draft' | 'continue'; words?: number; line?: string; guides?: PictureGuide[]; with: { provider: string; model: string; reasoningEffort?: string }[] }; result: JobStarted }
  /** One draft of such a comparison, whole: its text. */
  'trial.draft': { params: { root: string; chapter: string; version: string }; result: { text: string } }
  /** Have several of DSH's models plan the same chapters to come at once: previews only (job result: `plans`). */
  'trial.derive': { params: { root: string; count?: number; direction?: string; volume?: string; guides?: PictureGuide[]; with: { provider: string; model: string; reasoningEffort?: string }[] }; result: JobStarted }
  'image.sheetsFirst': { params: { root: string; asks: SheetsAsk[] }; result: { people: { id: string; name: string }[]; unknown: number; /** The sheets would be drawn after the portraits asked for, against them (`image.lead` is `portrait`). */ after?: boolean } }
  'image.list': { params: { root: string }; result: { images: IllustrationInfo[] } }
  /** The portraits of people and where each stands in the book — those of one chapter, of one person, or all — the ones kept out of the text among them. */
  'figures.list': { params: { root: string; chapter?: string; character?: string }; result: { portraits: PortraitPlace[] } }
  /** Keep a portrait out of the text (`show: false`), or let it stand there again. */
  'figures.show': { params: { root: string; path: string; show: boolean }; result: { ok: boolean } }
  /**
   * Put a picture the book has into a chapter's text: after its `after`-th paragraph (0: before everything), after the
   * paragraph a `quote` ends in, or — neither said — at the end. Result: the chapter, and the paragraph it now follows.
   */
  /**
   * The versions kept of a card, an entry, a style, a chapter's plan, a thread or the book's own information — each
   * the thing as it was until something changed it — the latest first. (A chapter's text has `chapter.version`.)
   */
  'history.list': { params: { root: string; kind: HistoryKind; id: string }; result: { versions: HistoryVersion[] } }
  /** A thing as one of its versions has it, and as it is now (nothing, where it is no longer in the book). */
  'history.read': { params: { root: string; kind: HistoryKind; id: string; version: string }; result: { was: Record<string, unknown>; now?: Record<string, unknown> } }
  /** Put a version back — the whole of it, or the `fields` named (`tagline`, `visual.prompt`). Pictures stay as they are now. What the thing is now is kept as a version first. */
  'history.restore': { params: { root: string; kind: HistoryKind; id: string; version: string; fields?: string[] }; result: { ok: boolean } }
  /** Cards and entries taken out of the book that can be put back as they last were. */
  'history.removed': { params: { root: string }; result: { removed: { kind: HistoryKind; id: string; name: string; at: string; version: string }[] } }
  /** Throw away for good what is kept of a card or an entry that was deleted: it can no longer be had back. */
  'history.forget': { params: { root: string; kind: HistoryKind; id: string }; result: { ok: boolean } }
  'image.place': { params: { root: string; picture: string; chapter: string; after?: number; quote?: string; alt?: string }; result: { chapter: string; after: number } }
  /** `released`: whose picture it was — the cards and entries it was taken off, by name. Absent from a Host before the picture was taken off them. */
  /** Take a picture out of the book — by the id of its record, or by its path where it has none: its file, its record, and off every card and entry that shows it (`released`: whose it was). */
  'image.delete': { params: { root: string; id?: string; path?: string; /** Several at once, by path. */ paths?: string[] }; result: { ok: boolean; released?: string[]; /** How many pictures went, where several were named. */ removed?: number } }

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
  'comic.render': { params: { root: string; chapter: string; panels?: string[]; force?: boolean; /** false: this once, no design sheet is drawn first. */ sheetFirst?: boolean; /** false: this once, the art of the things a panel shows does not go along. */ things?: boolean }; result: JobStarted }
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
  /** The door for working the Studio from a phone. `open` / `close` it; it is never remembered across a restart. */
  'remote.status': { params: Record<string, never>; result: RemoteStatus }
  'remote.open': { params: Record<string, never>; result: RemoteStatus }
  'remote.close': { params: Record<string, never>; result: RemoteStatus }
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
  'settings.get': { params: { /** A book to tell the settings for as well (`book` in the answer). */ root?: string }; result: SettingsView }
  /** `keys` maps an endpoint address to the key to save for its host; an empty string forgets the saved key. */
  'settings.update': { params: { patch: Record<string, unknown>; keys?: Record<string, string>; root?: string }; result: SettingsView }
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

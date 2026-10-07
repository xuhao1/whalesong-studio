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
import type { ServiceId, SetupPart } from './services'
import type {
  PriceEntry,
  UsageSummary,
  TtsProviderKind,
  AudioLine, AudioScript, ChapterMemory, ChapterPlan, ChapterReview, CharacterCard, ComicBoard, ComicPanel,
  IllustrationInfo, JobInfo, ModelRoute, NovelSettings, PlaySession, PlayTurn, ProjectManifest, ProjectRef, ProjectState,
  Proposal, SearchHit, SearchSource, StoryboardDensity, StyleProfile, VersionInfo, WorkMode, WorldEntry,
} from './types'

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
  /** The books that can be read there. */
  books: { root: string; id: string; title: string }[]
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
  ready: { text: boolean; embedding: boolean; image: boolean; tts: boolean }
  /** Nothing has been set up and the first-run guide has not been put aside. */
  setupNeeded: boolean
  version: string
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

export interface NovelRpc {
  // ── workspace & project ──
  'workspace.info': { params: { sessionId?: string }; result: { workspaces: WorkspaceInfo[]; current?: string; active?: string; mode?: WorkMode; /** Folder a new workspace is created in by default. */ home?: string } }
  /** Register a folder as a Harness workspace: an existing `path`, or a new folder called `name` under the default location. */
  'workspace.create': { params: { name?: string; path?: string }; result: WorkspaceInfo }
  'project.create': { params: { workspace: string; title: string; language?: string; genre?: string; logline?: string; premise?: string; author?: string; idea?: string; /** The title is a placeholder: let the drafted foundation name the book. */ untitled?: boolean; sessionId?: string }; result: { root: string; jobId?: string } }
  'project.state': { params: { root: string }; result: ProjectState }
  'project.update': { params: { root: string; patch: Partial<ProjectManifest> }; result: ProjectManifest }
  /**
   * Take a book off the shelf. Its own files are moved to the system trash
   * (`where: 'trash'`) or, where that cannot be reached, to a folder of the
   * Studio's own (`holding`) — `path` says where they are now. Nothing is
   * erased, and whatever else was in the book's folder stays (`left`).
   */
  'project.delete': { params: { root: string }; result: { title: string; where: 'trash' | 'holding' | 'beside'; path: string; left: string[]; folderRemoved: boolean } }
  'session.bind': { params: { sessionId: string; project?: string; mode?: WorkMode }; result: { mode: WorkMode; project?: string } }
  'events.wait': { params: { root?: string; revision: number; tick: number; timeoutMs?: number; /** With a session: also wake when its book in play is no longer `active`. */ sessionId?: string; active?: string }; result: { revision: number; tick: number; /** Root of the session's book in play. */ active?: string; mode?: WorkMode } }

  // ── bible ──
  'character.save': { params: { root: string; card: Partial<CharacterCard> }; result: CharacterCard }
  'character.delete': { params: { root: string; id: string }; result: { deleted: boolean } }
  'character.expand': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  /** Distill a character's appearance into a visual anchor for image generation. */
  'character.visual': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  'world.save': { params: { root: string; entry: Partial<WorldEntry> }; result: WorldEntry }
  'world.delete': { params: { root: string; id: string }; result: { deleted: boolean } }
  'world.expand': { params: { root: string; id: string; direction?: string }; result: JobStarted }
  'style.save': { params: { root: string; style: Partial<StyleProfile>; activate?: boolean }; result: StyleProfile }
  'style.delete': { params: { root: string; id: string }; result: { deleted: boolean } }
  'style.extract': { params: { root: string; sample: string; name?: string; activate?: boolean }; result: JobStarted }
  'style.sample': { params: { root: string; style?: string; draft?: StyleProfile; scene?: string }; result: JobStarted }
  'suggestion.accept': { params: { root: string; id: string }; result: { ok: boolean } }
  'suggestion.dismiss': { params: { root: string; id: string }; result: { ok: boolean } }

  // ── outline ──
  'outline.apply': { params: { root: string; ops: OutlineOpInput[] }; result: { results: { op: string; ok: boolean; id?: string; message: string }[] } }

  // ── manuscript ──
  'chapter.read': { params: { root: string; id: string }; result: ChapterDocument }
  'chapter.save': { params: { root: string; id: string; text: string; reason?: string }; result: { words: number; changed: boolean } }
  'chapter.version': { params: { root: string; id: string; version: string }; result: { text: string } }
  'chapter.restore': { params: { root: string; id: string; version: string }; result: { ok: boolean } }
  'search': { params: { root: string; query: string; sources?: SearchSource[]; limit?: number }; result: { hits: SearchHit[]; embedded: number; indexed: number; embeddingError?: string } }
  'find': { params: { root: string; query: string; limit?: number }; result: { matches: FindMatch[]; total: number } }

  // ── model work (jobs) ──
  'ai.write': { params: { root: string; chapter?: string; brief?: string; mode?: 'draft' | 'continue'; words?: number; style?: string }; result: JobStarted }
  'ai.reviseSpan': { params: { root: string; chapter: string; start: number; end: number; quote?: string; instruction: string }; result: JobStarted }
  'ai.reviseChapter': { params: { root: string; chapter: string; instruction: string }; result: JobStarted }
  'ai.reviseBook': { params: { root: string; instruction: string; chapters?: string[] }; result: JobStarted }
  'ai.digest': { params: { root: string; chapters?: string[]; force?: boolean }; result: JobStarted }
  'ai.review': { params: { root: string; chapter: string; focus?: string }; result: JobStarted }
  'ai.deriveChapters': { params: { root: string; count?: number; direction?: string; volume?: string; apply?: boolean }; result: JobStarted }
  'ai.deriveBeats': { params: { root: string; chapter: string; direction?: string }; result: JobStarted }
  'ai.whatIf': { params: { root: string; question: string; branches?: number }; result: JobStarted }
  'ai.import': { params: { root: string; text?: string; /** A book file to read on the Host (EPUB); `data` is base64. */ file?: { name: string; data: string }; analyze?: boolean }; result: JobStarted }
  'ai.foundation': { params: { root: string; idea: string }; result: JobStarted }
  'ai.index': { params: { root: string }; result: JobStarted }
  'proposal.accept': { params: { root: string; id: string }; result: Proposal }
  'proposal.reject': { params: { root: string; id: string }; result: { ok: boolean } }
  'review.resolve': { params: { root: string; chapter: string; issue: string; resolved: boolean }; result: { ok: boolean } }

  // ── jobs ──
  'jobs.list': { params: { root?: string }; result: { jobs: JobInfo[] } }
  'jobs.read': { params: { id: string; cursor?: number; waitMs?: number }; result: { text: string; cursor: number; info: JobInfo } }
  'jobs.cancel': { params: { id: string }; result: { cancelled: boolean } }

  // ── stage: illustration ──
  'image.create': { params: { root: string; kind: 'portrait' | 'sheet' | 'scene' | 'location' | 'cover' | 'custom'; target?: string; quote?: string; prompt?: string; size?: string; insert?: boolean; /** Sheet: which look (outfit) to draw. */ look?: string; looks?: Record<string, string>; characters?: string[]; avoid?: string[]; raw?: boolean }; result: JobStarted }
  'image.list': { params: { root: string }; result: { images: IllustrationInfo[] } }
  'image.delete': { params: { root: string; id: string }; result: { ok: boolean } }

  // ── stage: audio drama ──
  'audio.script': { params: { root: string; chapter: string }; result: { script?: AudioScript; stale: boolean; /** The voice each speaker of this chapter has, or will get, in the audio drama. */ cast?: { characters: Record<string, string>; extras: Record<string, string> } } }
  'audio.build': { params: { root: string; chapter: string; force?: boolean }; result: JobStarted }
  'audio.synthesize': { params: { root: string; chapter: string; lines?: string[]; force?: boolean }; result: JobStarted }
  'audio.updateLine': { params: { root: string; chapter: string; line: string; patch: Partial<Pick<AudioLine, 'text' | 'kind' | 'speaker' | 'speakerName' | 'direction'>> }; result: AudioScript }
  'audio.export': { params: { root: string; chapter: string }; result: { path: string; duration: number; missing: number } }
  /** A job whose output is `{ path, duration }`: a new voice is set up before it speaks, and that takes a while. */
  'voice.audition': { params: { root: string; voice?: string; /** Hear this character as their lines will sound, when no voice is named. */ character?: string; text: string; direction?: string }; result: JobStarted }
  'voice.design': { params: { root: string; character: string; prompt?: string }; result: JobStarted }

  // ── stage: motion comic ──
  'comic.board': { params: { root: string; chapter: string }; result: { board?: ComicBoard; stale: boolean } }
  'comic.build': { params: { root: string; chapter: string; force?: boolean; /** How finely to cut; the book's own setting when left out. */ density?: StoryboardDensity; maxPanels?: number }; result: JobStarted }
  'comic.render': { params: { root: string; chapter: string; panels?: string[]; force?: boolean }; result: JobStarted }
  'comic.updatePanel': { params: { root: string; chapter: string; panel: string; patch: Partial<Pick<ComicPanel, 'prompt' | 'description' | 'camera'>> }; result: ComicBoard }

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
  'play.novelize': { params: { root: string; id: string; title?: string }; result: JobStarted }

  // ── export ──
  'export.book': { params: { root: string; format: 'markdown' | 'text' | 'html' | 'epub' }; result: { path: string; chapters: number; bytes: number; absolute: string } }

  // ── reading on other devices ──
  'share.status': { params: Record<string, never>; result: ShareStatus }
  /** Switch the reader for other devices on or off, share or stop sharing a book, move it to another port, or replace its address (`renew`) so earlier links stop working. */
  'share.update': { params: { enabled?: boolean; book?: { root: string; shared: boolean }; port?: number; renew?: boolean }; result: ShareStatus }

  // ── settings ──
  'usage.summary': { params: { /** Only calls made for this book. */ root?: string; range?: 'today' | '7d' | '30d' | 'all' }; result: { summary: UsageSummary; prices: Record<string, PriceEntry>; /** When counting began: the first call on record. */ begun?: string } }
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
  'model.info': { params: { provider: string; model: string; baseURL?: string }; result: ModelDetails }
}

export type RpcMethod = keyof NovelRpc
export type RpcParams<M extends RpcMethod> = NovelRpc[M]['params']
export type RpcResult<M extends RpcMethod> = NovelRpc[M]['result']

/** What travels in the Connection payload. */
export interface RpcEnvelope {
  method: string
  params: unknown
}

/** Stable failure codes of the route (`details` is always an object). */
export type RpcErrorCode =
  | 'novel/bad-request' | 'novel/unknown-method' | 'novel/no-project' | 'novel/not-found' | 'novel/invalid'
  | 'novel/empty' | 'novel/provider' | 'novel/model' | 'novel/cancelled' | 'novel/internal' | string

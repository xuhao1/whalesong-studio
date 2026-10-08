// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Studio state for one mounted Studio (the global page, or one sidebar tab).
 * It mirrors Host state — the workspace list, the open project, running jobs —
 * and stays current through one long-poll on the Host's change counters.
 * Views read a snapshot and call actions; they never talk to the wire.
 */
import type { EndpointCheck, JobStarted, LockView, RpcMethod, RpcParams, SettingsView, WorkspaceInfo } from '../shared/rpc'
import { parseRecommended, setRecommended } from '../shared/recommended'
import type { ServiceId, SetupPart } from '../shared/services'
import type { GateKind, GateState, JobInfo, ProjectState, WorkMode } from '../shared/types'
import { isCancelled, messageOf, RpcError, type NovelApi } from './api'

export type StudioView = 'home' | 'bible' | 'outline' | 'write' | 'read' | 'cast' | 'review' | 'stage' | 'settings' | 'setup' | 'usage'
/** `audio` is kept for links made before the audio drama moved into the reader: it opens the reader's listening mode. */
export type StageTab = 'audio' | 'comic' | 'play' | 'gallery' | 'production'
/** The reader shows the same chapter two ways: to be read, or to be listened to. */
/** How a chapter is taken in: read, heard as an audio drama, or watched as a motion comic. */
export type ReadMode = 'read' | 'listen' | 'watch'
/** Where the viewer stands: in the text, among the book's people, in its world, among its side stories — or on the page of one of them. */
export interface ViewerAt {
  section: 'text' | 'people' | 'world' | 'sides'
  end?: { type: 'character' | 'world'; id: string }
  /** The side story that is open. */
  side?: string
}

/** `lives`: everyone's life chapter by chapter — what the lifecycle board and the presence grid were, in one table. */
export type CastTab = 'cards' | 'lives' | 'relations' | 'walkons'

/** A request to the Host that changes or makes something and has not answered yet. */
export interface Activity {
  id: number
  method: RpcMethod
  since: number
}

/**
 * Requests that fetch what a screen shows, or that wait on purpose. They have
 * their own spinners, or none is wanted; everything else is somebody's click
 * and is shown as work in progress until it answers.
 */
const QUIET: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'events.wait', 'jobs.read', 'jobs.list', 'jobs.cancel', 'project.state', 'workspace.info', 'settings.get', 'key.state', 'model.info', 'conversation.open',
  'audio.script', 'comic.board', 'image.list', 'chapter.read', 'chapter.version', 'chapter.save', 'usage.summary', 'find', 'search',
  'play.list', 'play.get', 'share.status', 'reader.album', 'reader.sides', 'reader.position', 'world.pin', 'line.world', 'cast.lives',
])
/** How long a request may take before it is worth saying that it is running. */
const ACTIVITY_AFTER_MS = 350

/** A settings view brings the recommendations its Host works by: the Studio offers the same models the Host would set. */
function taking(view: SettingsView): SettingsView {
  setRecommended(parseRecommended(view.recommended?.table))
  return view
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

export interface StudioSnapshot {
  status: 'loading' | 'ready' | 'error'
  error?: string
  workspaces: WorkspaceInfo[]
  /** Workspace of the session this Studio belongs to (sidebar tabs). */
  sessionWorkspace?: string
  /** Workspace the Studio is looking at. */
  workspace?: string
  /** Root of the open project. */
  root?: string
  /**
   * Root of the book in play for the session beside this Studio — the book its
   * showrunner works on. The Studio and the conversation move between books together.
   */
  sessionBook?: string
  /** The book in play just changed: who moved it and to which title, for one notice on screen. */
  bookMoved?: { by: 'author' | 'agent'; title: string; nonce: number }
  /** Something was asked for that needs a capability nobody has set up yet: the Studio says so and shows the way. */
  needs?: { what: Capability; detail?: string; nonce: number }
  /** The part of the settings a link asked for. */
  settingsFocus?: Capability | 'crew' | 'recommended'
  /** A long job nobody was waiting on just finished, for one notice on screen. */
  jobEnded?: { job: JobInfo; nonce: number }
  project?: ProjectState
  jobs: JobInfo[]
  /** The kinds of request that have work waiting, or a service pushing back, right now. */
  gates?: Partial<Record<GateKind, GateState>>
  mode?: WorkMode
  view: StudioView
  /** Chapter in focus across views (editor, reader, stage). */
  chapterId?: string
  settings?: SettingsView
  /** Folder a new workspace is created in by default. */
  workspaceHome?: string
  /** Tab of the stage a link asked for. */
  stageTab?: StageTab
  /** How the reader shows the chapter. */
  readMode: ReadMode
  /** Which half of the viewer is open: the text, or the album of the people and the world. */
  album: ViewerAt
  /** Clicks still being worked on by the Host, oldest first. */
  activity: Activity[]
  toasts: Toast[]
  /**
   * The book this Studio was asked to show is sealed and locked: nothing of it
   * can be read until its author unlocks it. `view` says how it opens.
   */
  lock?: { root: string; view?: LockView; /** Whether opening it was to move the conversation onto it as well. */ bind?: boolean }
  /** A card a link asked the bible to open: the cast board, a tool row, a name in a script. */
  entity?: { kind: 'character' | 'world' | 'art'; id: string; nonce: number }
  /** Tab of the cast view a link asked for. */
  castTab?: CastTab
  /** A place in the manuscript a view was asked to show (a search hit, a review quote). */
  jump?: { chapterId: string; offset: number; length: number; nonce: number }
  /**
   * The conversation a book was just given, for the Studio to say so once:
   * where the author goes to talk the book over with the showrunner.
   */
  conversation?: { root: string; sessionId: string; created: boolean; title?: string; nonce: number }
  /**
   * The Host half is older than this Studio: the Harness swapped the Studio in
   * when the plugin was updated on disk, and the Host runs on as it was loaded
   * until the Harness restarts. What is new in the Studio may not work till then.
   */
  hostStale?: boolean
  /** …and that Host half can put the installed one up in its own place: one press, no restart of DSH. */
  hostReloadable?: boolean
}

/**
 * One call the Host does not know says it for every Studio in the window: the
 * Host is older than the Studio. Forgotten when the Host comes back.
 */
const olderHost = { known: false, listeners: new Set<() => void>() }

export function noteOlderHost(known = true): void {
  if (olderHost.known === known) return
  olderHost.known = known
  for (const listener of [...olderHost.listeners]) listener()
}

/** Under this name and a book's id: the chapter this device read last. */
const LAST_READ = 'novel-studio:last-read:'

/** Where the author was in a Studio: found again when the Harness swaps the Studio in anew, or the page is loaded again. */
interface Place {
  root?: string
  /** On the bookshelf on purpose. */
  shelf?: boolean
  view?: StudioView
  chapterId?: string
  stageTab?: StageTab
  readMode?: ReadMode
  castTab?: CastTab
  album?: ViewerAt
}

const VIEWS: readonly StudioView[] = ['home', 'bible', 'outline', 'write', 'read', 'cast', 'review', 'stage', 'settings', 'usage']
const STAGE_TABS: readonly StageTab[] = ['audio', 'comic', 'play', 'gallery', 'production']
const CAST_TABS: readonly CastTab[] = ['cards', 'lives', 'relations', 'walkons']
/** A place kept from before the two were one table still opens it. */
const castTabOf = (value: unknown): CastTab | undefined => (value === 'board' || value === 'presence' ? 'lives' : CAST_TABS.includes(value as CastTab) ? value as CastTab : undefined)

/** A kept place in the viewer, when what was kept is one. */
function viewerAt(value: unknown): ViewerAt | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { section, end, side } = value as { section?: unknown; end?: { type?: unknown; id?: unknown }; side?: unknown }
  if (section !== 'text' && section !== 'people' && section !== 'world' && section !== 'sides') return undefined
  const named = end !== undefined && end !== null && (end.type === 'character' || end.type === 'world') && typeof end.id === 'string' && end.id.length > 0
  return { section, ...(named ? { end: { type: end.type as 'character' | 'world', id: end.id as string } } : {}), ...(section === 'sides' && typeof side === 'string' && side.length > 0 ? { side } : {}) }
}

function readPlace(key: string): Place | undefined {
  try {
    const raw = globalThis.sessionStorage?.getItem(key)
    if (raw === null || raw === undefined) return undefined
    const data = JSON.parse(raw) as Record<string, unknown>
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
    const root = text(data.root)
    const chapterId = text(data.chapterId)
    return {
      ...(root !== undefined ? { root } : {}),
      ...(data.shelf === true ? { shelf: true } : {}),
      ...(VIEWS.includes(data.view as StudioView) ? { view: data.view as StudioView } : {}),
      ...(chapterId !== undefined ? { chapterId } : {}),
      ...(STAGE_TABS.includes(data.stageTab as StageTab) ? { stageTab: data.stageTab as StageTab } : {}),
      ...(data.readMode === 'read' || data.readMode === 'listen' || data.readMode === 'watch' ? { readMode: data.readMode } : {}),
      ...(castTabOf(data.castTab) !== undefined ? { castTab: castTabOf(data.castTab)! } : {}),
      ...(viewerAt(data.album) !== undefined ? { album: viewerAt(data.album)! } : {}),
    }
  } catch {
    // No storage here, or something else's data under the name: the Studio opens where it always did.
    return undefined
  }
}

/** What a piece of work can need that is set up in the settings. */
export type Capability = 'text' | 'image' | 'tts' | 'embedding'

/**
 * Whether a failure says "this was never set up" rather than "this went wrong",
 * and what is missing. The Host words these for a person (and for the
 * showrunner); here they decide between a passing error and a way forward.
 */
export function missingCapability(message: string): Capability | undefined {
  if (/speech synthesis is not configured|(?:Speech|Voice design): (?:no API key|"[^"]*" is not set)/i.test(message)) return 'tts'
  if (/image generation is not configured|Image generation: (?:no API key|"[^"]*" is not set)|images through a ChatGPT subscription need|Codex Connect plugin is not installed|Codex CLI is not (?:installed|signed in)|ChatGPT is not signed in/i.test(message)) return 'image'
  if (/Embeddings: (?:no API key|"[^"]*" is not set)/i.test(message)) return 'embedding'
  if (/: no API key is saved for |" is not set — export it/i.test(message)) return 'text'
  return undefined
}

export interface JobFollower {
  /** Resolves with the job's final info; rejects when the job failed or was cancelled. */
  done: Promise<JobInfo>
  /** Stop the job. */
  cancel(): void
  /** Stop watching; the job keeps running. */
  detach(): void
}

type JobMethod = { [M in RpcMethod]: NovelRpcResult<M> extends JobStarted ? M : never }[RpcMethod]
type NovelRpcResult<M extends RpcMethod> = import('../shared/rpc').RpcResult<M>

export class StudioController {
  /** The place last left with the book, so that one chapter is left there once. */
  private positionLeft: string | undefined
  private snapshot: StudioSnapshot = { status: 'loading', workspaces: [], jobs: [], view: 'home', readMode: 'read', album: { section: 'text' }, activity: [], toasts: [] }
  private readonly listeners = new Set<() => void>()
  private abort = new AbortController()
  private revision = -1
  private tick = -1
  private disposed = false
  private toastSeq = 0
  private polling = false
  private visible = true
  private pollAbort: AbortController | undefined
  /** Someone (a link, the author) already chose where to look; the first-run guide must not take over. */
  private navigated = false
  /** The author went to the bookshelf on purpose; refreshing the list must not reopen a book behind their back. */
  private onShelf = false
  /** Jobs somebody awaits: their outcome reaches the author through that caller. */
  private readonly followed = new Set<string>()
  /** Each job's status at the last look, to notice the ones that end. */
  private readonly seen = new Map<string, JobInfo['status']>()
  private readonly since = Date.now()
  private readonly inFlight = new Map<number, Activity>()
  private activitySeq = 0
  /** The Host, with every click-driven request counted while it is out. */
  readonly api: NovelApi
  /**
   * What the author typed on a screen and has not sent yet, kept for as long as
   * this Studio is open: leaving the screen — to change a setting, to look
   * something up — and coming back finds it as it was. Memory only, never saved.
   */
  readonly kept = new Map<string, unknown>()
  /** Under which name this Studio's place is kept; one per conversation, one for the page. */
  private readonly placeKey: string
  private placeSaved = ''
  /** The book this Studio was on when it was last seen. */
  private resume: string | undefined
  /** The connection to the Host broke: when it is back, the Host may be another build. */
  private reconnecting = false
  /** Has the Harness read its list of conversations again; set by whoever shows this Studio. */
  refreshSessions: (() => void) | undefined
  /**
   * The conversation of the book that is open, for a Studio that sits beside
   * none: work started on the Studio's own page is that conversation's, so the
   * agents doing it are its children — listed under it, and open to be watched.
   */
  private bookSession: { root: string; sessionId: string } | undefined

  /**
   * The Studio's own page, opened by the author just now (not put back after a
   * swap or a reload): which book it shows is decided by where they come from.
   */
  private arrival: { sessionId?: string; place?: Place } | undefined

  /**
   * @param arrival - for the Studio's page, when the author opened it themselves: the conversation they came from, if any.
   *   The page then shows that conversation's book, and the shelf when it is about none — not whatever book the page was last on.
   */
  constructor(api: NovelApi, readonly sessionId?: string, arrival?: { sessionId?: string }) {
    this.placeKey = `novel-studio:place:${sessionId ?? 'page'}`
    const remembered = readPlace(this.placeKey)
    if (sessionId === undefined && arrival !== undefined) this.arrival = { ...arrival, ...(remembered !== undefined ? { place: remembered } : {}) }
    const place = this.arrival === undefined ? remembered : undefined
    if (place !== undefined) {
      this.resume = place.root
      this.onShelf = place.shelf === true
      // Where the author was is where they chose to be: the first-run guide does not take over.
      if (place.view !== undefined && place.view !== 'home') this.navigated = true
      // A place found again is not a chapter being read now: it is not left with the book a second time —
      // somebody may have read on from there on another device since.
      if (place.root !== undefined && place.chapterId !== undefined) this.positionLeft = `${place.root}:${place.chapterId}`
      this.snapshot = {
        ...this.snapshot,
        ...(place.view !== undefined ? { view: place.view } : {}),
        ...(place.chapterId !== undefined ? { chapterId: place.chapterId } : {}),
        ...(place.stageTab !== undefined ? { stageTab: place.stageTab } : {}),
        ...(place.readMode !== undefined ? { readMode: place.readMode } : {}),
        ...(place.castTab !== undefined ? { castTab: place.castTab } : {}),
        ...(place.album !== undefined ? { album: place.album } : {}),
      }
    }
    if (olderHost.known) this.snapshot = { ...this.snapshot, hostStale: true }
    olderHost.listeners.add(this.onOlderHost)
    this.api = {
      media: api.media.bind(api),
      call: (method, params, signal) => {
        const session = this.sessionId ?? (this.bookSession !== undefined && this.bookSession.root === this.snapshot.root ? this.bookSession.sessionId : undefined)
        if (QUIET.has(method)) return api.call(method, params, signal, session)
        const entry: Activity = { id: ++this.activitySeq, method, since: Date.now() }
        this.inFlight.set(entry.id, entry)
        // A request that answers at once never shows; one that takes a moment says what it is doing.
        const timer = setTimeout(() => { if (this.inFlight.has(entry.id) && !this.disposed) this.set({ activity: [...this.inFlight.values()] }) }, ACTIVITY_AFTER_MS)
        const settle = (): void => {
          clearTimeout(timer)
          this.inFlight.delete(entry.id)
          if (!this.disposed && this.snapshot.activity.some(item => item.id === entry.id)) this.set({ activity: [...this.inFlight.values()] })
        }
        const pending = api.call(method, params, signal, session)
        pending.then(settle, settle)
        return pending
      },
    }
  }

  getSnapshot = (): StudioSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<StudioSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  /** Tell whoever watches, and keep the place for a Studio that is put here anew. */
  private emit(): void {
    this.remember()
    for (const listener of [...this.listeners]) listener()
  }

  private remember(): void {
    const { root, view, chapterId, stageTab, readMode, castTab, album } = this.snapshot
    const place: Place = {
      ...(root !== undefined && !this.onShelf ? { root } : {}),
      ...(this.onShelf ? { shelf: true } : {}),
      // The guide is where a Studio with nothing set up opens by itself; nobody is put back onto it.
      ...(view !== 'setup' ? { view } : {}),
      ...(chapterId !== undefined ? { chapterId } : {}),
      ...(stageTab !== undefined ? { stageTab } : {}),
      readMode,
      ...(castTab !== undefined ? { castTab } : {}),
      ...(album.section !== 'text' ? { album } : {}),
    }
    // The chapter a book was read at last, kept by this device: where its cover leads back to.
    const book = this.snapshot.project?.manifest.id
    if (view === 'read' && chapterId !== undefined && book !== undefined && this.snapshot.project?.root === root) {
      try {
        globalThis.localStorage?.setItem(`${LAST_READ}${book}`, chapterId)
      } catch {
        // Without storage a book opens at its first chapter.
      }
      // And left with the book, once for each chapter come to: a phone picks the book up where the computer left it.
      const left = `${root}:${chapterId}`
      if (root !== undefined && this.positionLeft !== left) {
        this.positionLeft = left
        void this.api.call('reader.position', { root, chapter: chapterId }).catch(() => {})
      }
    }
    const text = JSON.stringify(place)
    if (text === this.placeSaved) return
    this.placeSaved = text
    try {
      globalThis.sessionStorage?.setItem(this.placeKey, text)
    } catch {
      // Without storage the Studio opens at its start next time, as it did before.
    }
  }

  private readonly onOlderHost = (): void => {
    if (this.disposed) return
    if (olderHost.known !== (this.snapshot.hostStale === true)) this.set({ hostStale: olderHost.known })
  }

  // ───────────── lifecycle ─────────────

  async start(): Promise<void> {
    this.disposed = false
    olderHost.listeners.add(this.onOlderHost)
    this.abort = new AbortController()
    try {
      // Both answers decide the first screen: a Studio with nothing set up opens on the guide.
      const [, settings] = await Promise.all([this.loadWorkspaces(), this.loadSettings().catch(() => undefined)])
      this.set({ status: 'ready', ...(settings?.setupNeeded === true && !this.navigated ? { view: 'setup' as const } : {}) })
    } catch (error) {
      if (!this.disposed) this.set({ status: 'error', error: messageOf(error) })
    }
    void this.poll()
  }

  dispose(): void {
    this.disposed = true
    olderHost.listeners.delete(this.onOlderHost)
    this.abort.abort()
    this.pollAbort?.abort()
  }

  /**
   * A Studio nobody can see (a hidden sidebar tab, a background window) stops
   * long-polling: browsers allow only a handful of connections per host, and
   * the Harness needs them. Coming back refreshes at once.
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) {
      this.pollAbort?.abort()
      return
    }
    if (this.disposed || this.snapshot.status !== 'ready') return
    void this.refreshProject()
    void this.refreshJobs()
    void this.poll()
  }

  /** Reload the workspace list and re-resolve the session's project. */
  async loadWorkspaces(): Promise<void> {
    const info = await this.api.call('workspace.info', this.sessionId !== undefined ? { sessionId: this.sessionId } : {}, this.abort.signal)
    const workspace = this.snapshot.workspace ?? info.current ?? info.workspaces.find(candidate => candidate.projects.length > 0)?.path ?? info.workspaces[0]?.path
    this.set({
      workspaces: info.workspaces,
      ...(info.active !== undefined ? { sessionBook: info.active } : {}),
      ...(info.current !== undefined ? { sessionWorkspace: info.current } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(info.mode !== undefined ? { mode: info.mode } : {}),
      ...(info.home !== undefined ? { workspaceHome: info.home } : {}),
      ...(info.stale === true ? { hostStale: true, hostReloadable: info.reloadable === true } : {}),
    })
    if (this.arrival !== undefined) {
      const arrival = this.arrival
      this.arrival = undefined
      // The book of the conversation the author came from; a conversation about no book, or none at all, leads to the shelf.
      const from = arrival.sessionId !== undefined ? (await this.api.call('workspace.info', { sessionId: arrival.sessionId }, this.abort.signal).catch(() => undefined))?.active : undefined
      if (from === undefined) {
        this.onShelf = true
        this.set({ view: 'home' })
        return
      }
      // Back on the book the page was last on: back on the page of it, too.
      const place = arrival.place?.root === from ? arrival.place : undefined
      if (place?.view !== undefined && place.view !== 'home') this.navigated = true
      if (place?.root !== undefined && place.chapterId !== undefined) this.positionLeft = `${place.root}:${place.chapterId}`
      this.set({
        view: place?.view ?? 'home',
        ...(place?.chapterId !== undefined ? { chapterId: place.chapterId } : {}),
        ...(place?.stageTab !== undefined ? { stageTab: place.stageTab } : {}),
        ...(place?.readMode !== undefined ? { readMode: place.readMode } : {}),
        ...(place?.castTab !== undefined ? { castTab: place.castTab } : {}),
        ...(place?.album !== undefined ? { album: place.album } : {}),
      })
      await this.openProject(from, false)
      return
    }
    if (this.snapshot.root === undefined && !this.onShelf) {
      const projects = info.workspaces.find(candidate => candidate.path === workspace)?.projects ?? []
      // The conversation's book first; else the book this Studio was on when it was last here, if it is still on a shelf.
      const resumed = this.resume !== undefined && info.workspaces.some(candidate => candidate.projects.some(project => project.root === this.resume)) ? this.resume : undefined
      const root = info.active ?? resumed ?? (projects.length === 1 ? projects[0]!.root : undefined)
      if (root !== undefined) await this.openProject(root, false)
    }
  }

  /**
   * Open a book. In a session's Studio that also moves the conversation onto it
   * (`bind`): the showrunner is told, and works on this book from its next step.
   */
  async openProject(root: string, bind = true): Promise<void> {
    let project: ProjectState
    try {
      project = await this.api.call('project.state', { root }, this.abort.signal)
    } catch (error) {
      // A sealed book that is locked: there is nothing to show but the way to unlock it.
      if (error instanceof RpcError && error.code === 'novel/locked') {
        await this.showLock(root, bind)
        return
      }
      throw error
    }
    if (this.snapshot.lock !== undefined) {
      const { lock: _lock, ...rest } = this.snapshot
      this.snapshot = rest
    }
    this.onShelf = false
    this.revision = project.revision
    const chapterId = this.snapshot.chapterId !== undefined && [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].some(chapter => chapter.id === this.snapshot.chapterId)
      ? this.snapshot.chapterId
      : (project.chapters.find(chapter => !chapter.hasText) ?? project.chapters.at(-1))?.id
    const before = this.snapshot.sessionBook
    const moves = bind && this.sessionId !== undefined && before !== root
    // Claimed before the Host confirms, so the wake-up our own move causes is not mistaken for the showrunner's.
    this.set({ root, project, status: 'ready', ...(chapterId !== undefined ? { chapterId } : {}), ...(moves ? { sessionBook: root } : {}) })
    // On the Studio's own page: whose conversation the work started here belongs to. Looked up, never made, and not waited for.
    if (this.sessionId === undefined && this.bookSession?.root !== root) {
      void this.api.call('conversation.open', { root, create: false }, this.abort.signal)
        .then((found) => { if (found.sessionId !== undefined && this.snapshot.root === root) this.bookSession = { root, sessionId: found.sessionId } })
        .catch(() => {})
    }
    await this.refreshJobs()
    if (!moves || this.sessionId === undefined) return
    try {
      await this.api.call('session.bind', { sessionId: this.sessionId, project: root })
      if (before !== undefined) this.set({ bookMoved: { by: 'author', title: project.manifest.title, nonce: Date.now() } })
    } catch {
      // The Studio works on the book regardless; only the conversation stays where it was.
      const { sessionBook: _claimed, ...rest } = this.snapshot
      this.snapshot = { ...rest, ...(before !== undefined ? { sessionBook: before } : {}) }
      this.emit()
    }
  }

  /** The showrunner (or another window) moved the session to another book: go where the conversation is. */
  private async followSession(active: string | undefined, mode: WorkMode | undefined): Promise<void> {
    if (mode !== undefined && mode !== this.snapshot.mode) this.set({ mode })
    if (active === undefined || active === this.snapshot.sessionBook) return
    this.set({ sessionBook: active })
    if (active === this.snapshot.root) return
    await this.loadWorkspaces().catch(() => {})
    await this.openProject(active, false)
    const title = this.snapshot.project?.manifest.title
    if (title !== undefined) this.set({ bookMoved: { by: 'agent', title, nonce: Date.now() } })
  }

  /** Make sure the Studio is on the session's book before following a link the showrunner sent. */
  async syncSession(): Promise<void> {
    if (this.sessionId === undefined) return
    const info = await this.api.call('workspace.info', { sessionId: this.sessionId }, this.abort.signal)
    await this.followSession(info.active, info.mode)
  }

  /** Stand before a locked book: its name, and the ways it opens. */
  private async showLock(root: string, bind = false): Promise<void> {
    this.onShelf = false
    const { project: _project, chapterId: _chapter, ...rest } = this.snapshot
    this.snapshot = { ...rest, root, jobs: [], status: 'ready', lock: { root, bind } }
    this.emit()
    try {
      const view = await this.api.call('lock.get', { root }, this.abort.signal)
      if (this.snapshot.lock?.root === root) this.set({ lock: { root, view, bind } })
    } catch {
      // The lock screen works without the details; unlocking will say what is wrong.
    }
  }

  /**
   * Unlock the book this Studio stands before, with its password or with this
   * computer's own unlock, and open it.
   * @throws RpcError `novel/wrong-key` when it does not open that way.
   */
  async unlock(how: { password?: string; device?: boolean }): Promise<void> {
    const lock = this.snapshot.lock
    if (lock === undefined) return
    await this.api.call('lock.open', { root: lock.root, ...how })
    // The conversations about the book are back where the Harness keeps them.
    this.conversationsMoved()
    await this.loadWorkspaces().catch(() => {})
    // Opened the way it was asked for before the lock stood in the way: with the conversation, or without.
    await this.openProject(lock.root, lock.bind === true)
  }

  /** Lock the open book: its key is forgotten on the Host, and this Studio stands before it again. */
  async lockBook(): Promise<void> {
    const root = this.snapshot.root
    if (root === undefined) return
    await this.api.call('lock.close', { root })
    // The conversations about the book went under its seal with it.
    this.conversationsMoved()
    await this.showLock(root)
    await this.loadWorkspaces().catch(() => {})
  }

  private conversationsMoved(): void {
    try {
      this.refreshSessions?.()
    } catch {
      // The Harness shows them the next time it reads its list by itself.
    }
  }

  /**
   * The conversation to talk a book over in: the one that is on it, or — asked
   * to make one — a new one named after the book. Remembered for one notice.
   * @returns nothing on a Harness that cannot say (an older Host, no session service).
   */
  async conversationFor(root: string, create: boolean): Promise<{ sessionId: string; created: boolean; title?: string } | undefined> {
    try {
      const found = await this.api.call('conversation.open', { root, create })
      if (found.sessionId === undefined) return undefined
      const conversation = { sessionId: found.sessionId, created: found.created === true, ...(found.title !== undefined ? { title: found.title } : {}) }
      if (this.sessionId === undefined) this.bookSession = { root, sessionId: found.sessionId }
      if (conversation.created) {
        this.conversationsMoved()
        if (!this.disposed) this.set({ conversation: { root, ...conversation, nonce: Date.now() } })
      }
      return conversation
    } catch (error) {
      // An older Host does not know the call: the book is none the worse, the author starts a conversation by hand.
      if (error instanceof RpcError && error.code === 'novel/unknown-method') return undefined
      throw error
    }
  }

  /** The conversation beside this Studio is the one a book made here is on: said once, like a conversation that was made for a book. */
  noteOwnConversation(root: string): void {
    if (this.sessionId !== undefined && !this.disposed) this.set({ conversation: { root, sessionId: this.sessionId, created: false, nonce: Date.now() } })
  }

  dismissConversation(): void {
    if (this.snapshot.conversation === undefined) return
    const { conversation: _conversation, ...rest } = this.snapshot
    this.snapshot = rest
    this.emit()
  }

  closeProject(): void {
    this.onShelf = true
    const { root: _root, project: _project, chapterId: _chapter, lock: _lock, ...rest } = this.snapshot
    this.snapshot = { ...rest, jobs: [], view: 'home' }
    this.emit()
    // The shelf shows the books as they are now: sealed, locked, renamed since it was last read.
    void this.loadWorkspaces().catch(() => {})
  }

  setWorkspace(path: string): void {
    this.set({ workspace: path })
  }

  setView(view: StudioView, chapterId?: string): void {
    this.navigated = true
    // A chapter asked for by name is its text; without one the viewer opens where it was left.
    this.set({ view, ...(chapterId !== undefined ? { chapterId, ...(view === 'read' ? { album: { section: 'text' as const } } : {}) } : {}) })
  }

  /**
   * Follow a link into the Studio. The chapter may be named loosely — an id, a
   * number or a title — because links come from what the showrunner was told.
   */
  navigate(target: { view?: StudioView; chapter?: string; tab?: StageTab; mode?: ReadMode }): void {
    this.navigated = true
    const chapters = this.snapshot.project?.chapters ?? []
    const ref = target.chapter?.trim()
    const chapter = ref === undefined || ref.length === 0 ? undefined
      : chapters.find(candidate => candidate.id === ref)
        ?? (/^\d+$/.test(ref) ? chapters.find(candidate => candidate.index === Number(ref)) : undefined)
        ?? chapters.find(candidate => candidate.title === ref)
        ?? chapters.find(candidate => candidate.title.includes(ref) || ref.includes(candidate.title))
    // The audio drama lives in the reader now: a link to the stage's old audio tab opens the reader, listening.
    const listening = target.view === 'stage' && target.tab === 'audio'
    const view = listening ? 'read' : target.view
    const mode = listening ? 'listen' : target.mode ?? (target.view === 'read' ? 'read' : undefined)
    this.set({
      ...(view !== undefined ? { view } : {}),
      ...(chapter !== undefined ? { chapterId: chapter.id } : {}),
      ...(target.tab !== undefined && !listening ? { stageTab: target.tab } : {}),
      ...(mode !== undefined ? { readMode: mode } : {}),
      // A link to the reader is a link to the text.
      ...(view === 'read' ? { album: { section: 'text' as const } } : {}),
    })
  }

  /**
   * Follow a link the showrunner sent. Its call may have moved the session to
   * another book a moment ago, so the Studio catches up with the conversation
   * before looking for the chapter.
   */
  async show(target: { view?: StudioView; chapter?: string; tab?: StageTab; mode?: ReadMode }): Promise<void> {
    this.navigated = true
    if (target.view !== undefined) this.navigate({ view: target.view, ...(target.tab !== undefined ? { tab: target.tab } : {}), ...(target.mode !== undefined ? { mode: target.mode } : {}) })
    await this.syncSession().catch(() => {})
    if (!this.disposed) this.navigate(target)
  }

  setStageTab(tab: StageTab): void {
    this.set({ stageTab: tab })
  }

  /** Open the reader on a chapter, to read it or to listen to it. */
  openReader(mode: ReadMode, chapterId?: string): void {
    this.navigated = true
    this.set({ view: 'read', readMode: mode, album: { section: 'text' }, ...(chapterId !== undefined ? { chapterId } : {}) })
  }

  /**
   * Open the viewer on the book's people or its world — on the page of one of
   * them when one is named. It is the other side of every page where they are
   * edited: the same person, the same place, to be looked at.
   */
  openAlbum(at: ViewerAt): void {
    this.navigated = true
    this.set({ view: 'read', album: at })
  }

  /** Change the half of the viewer that is open, staying in it. */
  setAlbum(at: ViewerAt): void {
    this.set({ album: at })
  }

  /**
   * Open a book to be read: at the chapter this device read last, else its
   * first chapter with text. A book with nothing written yet — or one that is
   * locked — opens as any book does, on its overview or its lock.
   */
  async readBook(root: string, how: 'read' | 'listen' | 'watch' = 'read', at?: string): Promise<void> {
    await this.openProject(root)
    const project = this.snapshot.project
    if (project === undefined || this.snapshot.root !== root || this.snapshot.lock !== undefined) return
    const written = [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].filter(chapter => chapter.hasText)
    if (written.length === 0) return
    // Heard or watched: at the chapter that has something to hear or watch — the shelf names the first that does.
    if (how !== 'read') {
      this.openReader(how, written.some(chapter => chapter.id === at) ? at! : written[0]!.id)
      return
    }
    let last: string | null | undefined
    try {
      last = globalThis.localStorage?.getItem(`${LAST_READ}${project.manifest.id}`)
    } catch {
      last = undefined
    }
    // Where it was last read on any device — this one's own place is left there too, so the latest of them all is what it says.
    // (A Host from before places were kept answers with an error: then this device's own memory stands.)
    const anywhere = await this.api.call('reader.position', { root }).then(answer => answer.position?.chapter, () => undefined)
    if (this.snapshot.root !== root) return
    this.openReader('read', (written.find(chapter => chapter.id === anywhere) ?? written.find(chapter => chapter.id === last) ?? written[0]!).id)
  }

  setReadMode(mode: ReadMode): void {
    if (this.snapshot.readMode !== mode) this.set({ readMode: mode })
  }

  /** Register a folder as a workspace and look at it. */
  async createWorkspace(input: { name?: string; path?: string }): Promise<WorkspaceInfo> {
    const created = await this.api.call('workspace.create', input)
    await this.loadWorkspaces()
    this.set({ workspace: created.path })
    return created
  }

  /** Open a character's card: on the people page, among the cards. */
  openCharacter(id: string): void {
    this.navigated = true
    this.set({ view: 'cast', castTab: 'cards', entity: { kind: 'character', id, nonce: Date.now() } })
  }

  /** Open a world entry in the bible. */
  openWorld(id: string): void {
    this.navigated = true
    this.set({ view: 'bible', entity: { kind: 'world', id, nonce: Date.now() } })
  }

  /** Open the look of the book's pictures: the art direction, a page of its bible. */
  openArt(): void {
    this.navigated = true
    this.kept.set('bible.tab', 'art')
    this.set({ view: 'bible', entity: { kind: 'art', id: '', nonce: Date.now() } })
  }

  /** Look at one thing in the viewer: somebody's page, or the page of a place, a house, a thing — from where the world is walked on. */
  openExplore(end: { type: 'character' | 'world'; id: string }): void {
    this.openAlbum({ section: end.type === 'character' ? 'people' : 'world', end })
  }

  /** Open the people page, on one of its tabs. */
  openCast(tab?: CastTab): void {
    this.navigated = true
    this.set({ view: 'cast', ...(tab !== undefined ? { castTab: tab } : {}) })
  }

  setCastTab(tab: CastTab): void {
    if (this.snapshot.castTab !== tab) this.set({ castTab: tab })
  }

  focusChapter(chapterId: string): void {
    this.set({ chapterId })
  }

  /** Open a chapter at a character offset in the editor or the reader. */
  jumpTo(chapterId: string, offset: number, length: number, view: 'write' | 'read' = 'write'): void {
    this.set({ view, chapterId, jump: { chapterId, offset, length, nonce: Date.now() }, ...(view === 'read' ? { album: { section: 'text' as const } } : {}) })
  }

  /** Forget a jump once a view has shown it, so coming back to the chapter does not replay it. */
  consumeJump(nonce: number): void {
    if (this.snapshot.jump?.nonce !== nonce) return
    const { jump: _jump, ...rest } = this.snapshot
    this.snapshot = rest
    this.emit()
  }

  async setMode(mode: WorkMode): Promise<void> {
    if (this.sessionId === undefined) return
    const state = await this.api.call('session.bind', { sessionId: this.sessionId, mode })
    this.set({ mode: state.mode })
  }

  // ───────────── live updates ─────────────

  private async poll(): Promise<void> {
    if (this.polling || this.disposed || !this.visible) return
    this.polling = true
    const abort = new AbortController()
    this.pollAbort = abort
    const signal = abort.signal
    while (!this.disposed && this.visible && !signal.aborted) {
      try {
        // A locked book has nothing to watch; the session's own book is still followed.
        const root = this.snapshot.lock !== undefined ? undefined : this.snapshot.root
        const next = await this.api.call('events.wait', {
          ...(root !== undefined ? { root } : {}),
          revision: this.revision,
          tick: this.tick,
          timeoutMs: 25_000,
          ...(this.sessionId !== undefined ? { sessionId: this.sessionId, ...(this.snapshot.sessionBook !== undefined ? { active: this.snapshot.sessionBook } : {}) } : {}),
        }, signal)
        if (this.disposed) break
        if (this.reconnecting) {
          // The Host is back, perhaps restarted: what was said of the old one no longer holds.
          this.reconnecting = false
          noteOlderHost(false)
        }
        if ((next.stale === true) !== (this.snapshot.hostStale === true) && !olderHost.known) this.set({ hostStale: next.stale === true, hostReloadable: next.stale === true && next.reloadable === true })
        if (this.sessionId !== undefined) await this.followSession(next.active, next.mode)
        const projectChanged = next.revision !== this.revision && root !== undefined && root === this.snapshot.root
        const jobsChanged = next.tick !== this.tick
        this.tick = next.tick
        if (projectChanged) await this.refreshProject()
        else this.revision = root === this.snapshot.root ? next.revision : -1
        if (jobsChanged) await this.refreshJobs()
      } catch (error) {
        if (this.disposed || signal.aborted || isCancelled(error)) break
        if (error instanceof RpcError && error.code === 'novel/locked' && this.snapshot.root !== undefined && this.snapshot.lock === undefined) await this.showLock(this.snapshot.root)
        // The Host restarted or the network blinked; back off and try again.
        if (error instanceof RpcError && error.code === 'novel/transport') this.reconnecting = true
        await new Promise(resolve => setTimeout(resolve, 2500))
      }
    }
    this.polling = false
    // Hidden and shown again while the last request was still unwinding: pick the loop back up.
    if (!this.disposed && this.visible && signal.aborted) void this.poll()
  }

  async refreshProject(): Promise<void> {
    const root = this.snapshot.root
    if (root === undefined) return
    if (this.snapshot.lock?.root === root) return
    try {
      const project = await this.api.call('project.state', { root }, this.abort.signal)
      if (this.snapshot.root !== root) return
      this.revision = project.revision
      this.set({ project })
    } catch (error) {
      // Locked from elsewhere — another window, the Harness restarted: this Studio stands before the lock too.
      if (error instanceof RpcError && error.code === 'novel/locked' && this.snapshot.root === root) await this.showLock(root)
      else if (!isCancelled(error) && !this.disposed) this.toast('error', messageOf(error))
    }
  }

  async refreshJobs(): Promise<void> {
    const root = this.snapshot.root
    try {
      const { jobs, gates } = await this.api.call('jobs.list', root !== undefined ? { root } : {}, this.abort.signal)
      if (this.snapshot.root !== root) return
      this.set({ jobs, gates: gates ?? {} })
      this.noteEndings(jobs)
    } catch {
      // The next tick retries.
    }
  }

  /**
   * Most buttons start a job and return; nobody waits for it. When such a job
   * ends, say so: a failure must not be findable only in the jobs menu, least
   * of all the instant failure of something that was never set up.
   */
  private noteEndings(jobs: JobInfo[]): void {
    for (const job of jobs) {
      const before = this.seen.get(job.id)
      this.seen.set(job.id, job.status)
      if (job.status === 'running' || before === job.status) continue
      // What was already over when this Studio opened is history, and the showrunner reports its own jobs in the conversation.
      const watched = before === 'running' || (before === undefined && Date.parse(job.startedAt) >= this.since - 2000)
      if (!watched || job.origin !== 'user' || this.followed.has(job.id)) continue
      if (job.status === 'failed') this.report(new Error(job.error ?? 'failed'))
      else if (job.status === 'done' && (job.kind === 'audio' || job.kind === 'comic' || job.kind === 'batch' || (job.kind === 'review' && job.title === 'recheck issues'))) this.set({ jobEnded: { job, nonce: Date.now() } })
    }
  }

  // ───────────── jobs ─────────────

  /**
   * Start a job-backed method and follow it.
   * @param onText - called with the whole streamed text whenever it grows.
   */
  async run<M extends JobMethod>(method: M, params: RpcParams<M>, onText?: (text: string, info: JobInfo) => void): Promise<JobInfo> {
    const started = await this.api.call(method, params) as JobStarted
    void this.refreshJobs()
    try {
      return await this.follow(started.jobId, onText).done
    } finally {
      // Whoever waited for it sees that it is over at once — not at the next turn of the watch, which rests while the Studio is out of sight.
      void this.refreshJobs()
    }
  }

  /**
   * Follow a running job by id: its text as it is written and, when `onThought`
   * is given, what its models think before and between the words.
   */
  follow(jobId: string, onText?: (text: string, info: JobInfo) => void, onThought?: (thought: string, info: JobInfo) => void): JobFollower {
    this.followed.add(jobId)
    const controller = new AbortController()
    const done = (async (): Promise<JobInfo> => {
      let cursor = 0
      let text = ''
      let thoughtCursor = 0
      let thought = ''
      for (;;) {
        const state = await this.api.call('jobs.read', { id: jobId, cursor, waitMs: 15_000, ...(onThought !== undefined ? { thoughtCursor } : {}) }, controller.signal)
        // A rewrite restarts the buffer: the Host answers from the top when the cursor overshoots.
        if (state.cursor < cursor) text = ''
        if (state.text.length > 0) {
          text = state.cursor - state.text.length === 0 ? state.text : text + state.text
          cursor = state.cursor
          onText?.(text, state.info)
        } else if (state.cursor !== cursor) {
          cursor = state.cursor
        }
        // A Host from before thought was kept answers without it; then there is simply nothing to show.
        if (state.thought !== undefined && state.thought.length > 0) {
          thought += state.thought
          thoughtCursor = state.thoughtCursor ?? thoughtCursor + state.thought.length
          onThought?.(thought, state.info)
        }
        if (state.info.status === 'done') return state.info
        if (state.info.status === 'failed') throw new Error(state.info.error ?? 'failed')
        if (state.info.status === 'cancelled') throw new Error('cancelled')
      }
    })()
    // A follower nobody awaits (a detached tail) must not surface as an unhandled rejection.
    done.catch(() => {})
    return {
      done,
      cancel: () => {
        void this.api.call('jobs.cancel', { id: jobId }).catch(() => {})
        controller.abort()
      },
      detach: () => { controller.abort() },
    }
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.api.call('jobs.cancel', { id: jobId }).catch(() => {})
  }

  // ───────────── settings & feedback ─────────────

  async loadSettings(): Promise<SettingsView> {
    const settings = taking(await this.api.call('settings.get', {}))
    this.set({ settings, ...(settings.build?.stale === true ? { hostStale: true, hostReloadable: settings.build.reloadable === true } : {}) })
    return settings
  }

  /**
   * Have the Host half replaced by the installed one, DSH staying up. The old
   * half answers and goes; its routes are away until the new one is up.
   * @returns how many running jobs the change stopped.
   * @throws when the new half does not answer within half a minute — the banner stays, and says to restart DSH.
   */
  async reloadHost(): Promise<number> {
    const { jobs } = await this.api.call('host.reload', {})
    const until = Date.now() + 30_000
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 700))
      try {
        const settings = taking(await this.api.call('settings.get', {}))
        if (settings.build?.stale !== true) {
          noteOlderHost(false)
          this.set({ settings, hostStale: false, hostReloadable: false })
          break
        }
      } catch {
        // Between the two halves there is nobody to answer.
      }
      if (Date.now() > until) throw new Error('the new Host half did not come up')
    }
    // Everything on screen was read from the half that is gone.
    this.revision = -1
    this.tick = -1
    await Promise.all([this.loadWorkspaces().catch(() => {}), this.refreshJobs().catch(() => {}), this.snapshot.root !== undefined && this.snapshot.lock === undefined ? this.refreshProject().catch(() => {}) : Promise.resolve()])
    return jobs
  }

  /** Save settings; `keys` maps endpoint addresses to keys typed for them. */
  async saveSettings(patch: Record<string, unknown>, keys?: Record<string, string>): Promise<SettingsView> {
    const settings = taking(await this.api.call('settings.update', { patch, ...(keys !== undefined && Object.keys(keys).length > 0 ? { keys } : {}) }))
    this.set({ settings })
    return settings
  }

  /** Settle what an issue of the recommendations left to be said: take it up, keep what is there, take it back, or just have read it. */
  async settleRecommended(action: 'adopt' | 'keep' | 'revert' | 'dismiss'): Promise<void> {
    this.set({ settings: taking(await this.api.call('recommended.settle', { action })) })
  }

  /** One-click setup of a service. The settings only change when the key works. */
  async applySetup(input: { service: ServiceId | 'codex'; key?: string; origin?: string; parts: SetupPart[] }): Promise<EndpointCheck> {
    const { view, check } = await this.api.call('setup.apply', input)
    this.set({ settings: taking(view) })
    return check
  }

  /** Put the first-run guide aside for good. */
  async dismissSetup(): Promise<void> {
    this.set({ settings: taking(await this.api.call('setup.dismiss', {})) })
  }

  toast(kind: Toast['kind'], text: string): void {
    const id = ++this.toastSeq
    this.set({ toasts: [...this.snapshot.toasts, { id, kind, text }].slice(-4) })
    setTimeout(() => {
      if (!this.disposed) this.set({ toasts: this.snapshot.toasts.filter(toast => toast.id !== id) })
    }, kind === 'error' ? 8000 : 3500)
  }

  dismissToast(id: number): void {
    this.set({ toasts: this.snapshot.toasts.filter(toast => toast.id !== id) })
  }

  /** Run an action and surface its failure instead of an unhandled rejection. */
  async guard<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action()
    } catch (error) {
      this.report(error)
      return undefined
    }
  }

  /** Show a failure: one that means "this was never set up" becomes the way to set it up, anything else a passing message. */
  report(error: unknown): void {
    if (isCancelled(error) || messageOf(error) === 'cancelled') return
    const message = messageOf(error)
    const what = missingCapability(message)
    if (what !== undefined) this.set({ needs: { what, detail: message, nonce: Date.now() } })
    else this.toast('error', message)
  }

  /**
   * Whether images or speech are set up. When they are not, the Studio says so
   * and offers the way to the settings, and the caller should not start the work.
   */
  need(what: 'image' | 'tts'): boolean {
    const ready = this.snapshot.settings?.ready
    // Not known yet: let the work start; the Host answers the same question.
    if (ready === undefined || ready[what]) return true
    this.set({ needs: { what, nonce: Date.now() } })
    return false
  }

  dismissNeed(): void {
    if (this.snapshot.needs === undefined) return
    const { needs: _needs, ...rest } = this.snapshot
    this.snapshot = rest
    this.emit()
  }

  /** Go to the settings, at the part that sets a capability up. */
  openSettings(focus?: Capability | 'crew' | 'recommended'): void {
    this.navigated = true
    const { needs: _needs, settingsFocus: _focus, ...rest } = this.snapshot
    this.snapshot = { ...rest, view: 'settings', ...(focus !== undefined ? { settingsFocus: focus } : {}) }
    this.emit()
  }

  /** The settings showed what a link asked for. */
  consumeSettingsFocus(): void {
    if (this.snapshot.settingsFocus === undefined) return
    const { settingsFocus: _focus, ...rest } = this.snapshot
    this.snapshot = rest
    this.emit()
  }
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Studio state for one mounted Studio (the global page, or one sidebar tab).
 * It mirrors Host state — the workspace list, the open project, running jobs —
 * and stays current through one long-poll on the Host's change counters.
 * Views read a snapshot and call actions; they never talk to the wire.
 */
import type { EndpointCheck, JobStarted, LockView, RpcMethod, RpcParams, SettingsView, WorkspaceInfo } from '../shared/rpc'
import type { ServiceId, SetupPart } from '../shared/services'
import type { JobInfo, ProjectState, WorkMode } from '../shared/types'
import { isCancelled, messageOf, RpcError, type NovelApi } from './api'

export type StudioView = 'home' | 'bible' | 'outline' | 'write' | 'read' | 'cast' | 'review' | 'stage' | 'settings' | 'setup' | 'usage'
/** `audio` is kept for links made before the audio drama moved into the reader: it opens the reader's listening mode. */
export type StageTab = 'audio' | 'comic' | 'play' | 'gallery'
/** The reader shows the same chapter two ways: to be read, or to be listened to. */
export type ReadMode = 'read' | 'listen'

export type CastTab = 'board' | 'presence' | 'relations' | 'walkons'

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
  'events.wait', 'jobs.read', 'jobs.list', 'jobs.cancel', 'project.state', 'workspace.info', 'settings.get', 'key.state', 'model.info',
  'audio.script', 'comic.board', 'image.list', 'chapter.read', 'chapter.version', 'chapter.save', 'usage.summary', 'find', 'search',
  'play.list', 'play.get', 'share.status',
])
/** How long a request may take before it is worth saying that it is running. */
const ACTIVITY_AFTER_MS = 350

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
  settingsFocus?: Capability
  /** A long job nobody was waiting on just finished, for one notice on screen. */
  jobEnded?: { job: JobInfo; nonce: number }
  project?: ProjectState
  jobs: JobInfo[]
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
  /** Clicks still being worked on by the Host, oldest first. */
  activity: Activity[]
  toasts: Toast[]
  /**
   * The book this Studio was asked to show is sealed and locked: nothing of it
   * can be read until its author unlocks it. `view` says how it opens.
   */
  lock?: { root: string; view?: LockView; /** Whether opening it was to move the conversation onto it as well. */ bind?: boolean }
  /** A card a link asked the bible to open: the cast board, a tool row, a name in a script. */
  entity?: { kind: 'character' | 'world'; id: string; nonce: number }
  /** Tab of the cast view a link asked for. */
  castTab?: CastTab
  /** A place in the manuscript a view was asked to show (a search hit, a review quote). */
  jump?: { chapterId: string; offset: number; length: number; nonce: number }
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
  private snapshot: StudioSnapshot = { status: 'loading', workspaces: [], jobs: [], view: 'home', readMode: 'read', activity: [], toasts: [] }
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

  constructor(api: NovelApi, readonly sessionId?: string) {
    this.api = {
      media: api.media.bind(api),
      call: (method, params, signal) => {
        if (QUIET.has(method)) return api.call(method, params, signal)
        const entry: Activity = { id: ++this.activitySeq, method, since: Date.now() }
        this.inFlight.set(entry.id, entry)
        // A request that answers at once never shows; one that takes a moment says what it is doing.
        const timer = setTimeout(() => { if (this.inFlight.has(entry.id) && !this.disposed) this.set({ activity: [...this.inFlight.values()] }) }, ACTIVITY_AFTER_MS)
        const settle = (): void => {
          clearTimeout(timer)
          this.inFlight.delete(entry.id)
          if (!this.disposed && this.snapshot.activity.some(item => item.id === entry.id)) this.set({ activity: [...this.inFlight.values()] })
        }
        const pending = api.call(method, params, signal)
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
    for (const listener of [...this.listeners]) listener()
  }

  // ───────────── lifecycle ─────────────

  async start(): Promise<void> {
    this.disposed = false
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
    })
    if (this.snapshot.root === undefined && !this.onShelf) {
      const projects = info.workspaces.find(candidate => candidate.path === workspace)?.projects ?? []
      const root = info.active ?? (projects.length === 1 ? projects[0]!.root : undefined)
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
    const chapterId = this.snapshot.chapterId !== undefined && project.chapters.some(chapter => chapter.id === this.snapshot.chapterId)
      ? this.snapshot.chapterId
      : (project.chapters.find(chapter => !chapter.hasText) ?? project.chapters.at(-1))?.id
    const before = this.snapshot.sessionBook
    const moves = bind && this.sessionId !== undefined && before !== root
    // Claimed before the Host confirms, so the wake-up our own move causes is not mistaken for the showrunner's.
    this.set({ root, project, status: 'ready', ...(chapterId !== undefined ? { chapterId } : {}), ...(moves ? { sessionBook: root } : {}) })
    await this.refreshJobs()
    if (!moves || this.sessionId === undefined) return
    try {
      await this.api.call('session.bind', { sessionId: this.sessionId, project: root })
      if (before !== undefined) this.set({ bookMoved: { by: 'author', title: project.manifest.title, nonce: Date.now() } })
    } catch {
      // The Studio works on the book regardless; only the conversation stays where it was.
      const { sessionBook: _claimed, ...rest } = this.snapshot
      this.snapshot = { ...rest, ...(before !== undefined ? { sessionBook: before } : {}) }
      for (const listener of [...this.listeners]) listener()
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
    for (const listener of [...this.listeners]) listener()
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
    await this.loadWorkspaces().catch(() => {})
    // Opened the way it was asked for before the lock stood in the way: with the conversation, or without.
    await this.openProject(lock.root, lock.bind === true)
  }

  /** Lock the open book: its key is forgotten on the Host, and this Studio stands before it again. */
  async lockBook(): Promise<void> {
    const root = this.snapshot.root
    if (root === undefined) return
    await this.api.call('lock.close', { root })
    await this.showLock(root)
    await this.loadWorkspaces().catch(() => {})
  }

  closeProject(): void {
    this.onShelf = true
    const { root: _root, project: _project, chapterId: _chapter, lock: _lock, ...rest } = this.snapshot
    this.snapshot = { ...rest, jobs: [], view: 'home' }
    for (const listener of [...this.listeners]) listener()
    // The shelf shows the books as they are now: sealed, locked, renamed since it was last read.
    void this.loadWorkspaces().catch(() => {})
  }

  setWorkspace(path: string): void {
    this.set({ workspace: path })
  }

  setView(view: StudioView, chapterId?: string): void {
    this.navigated = true
    this.set({ view, ...(chapterId !== undefined ? { chapterId } : {}) })
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
    this.set({ view: 'read', readMode: mode, ...(chapterId !== undefined ? { chapterId } : {}) })
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

  /** Open a character's card in the bible. */
  openCharacter(id: string): void {
    this.navigated = true
    this.set({ view: 'bible', entity: { kind: 'character', id, nonce: Date.now() } })
  }

  /** Open a world entry in the bible. */
  openWorld(id: string): void {
    this.navigated = true
    this.set({ view: 'bible', entity: { kind: 'world', id, nonce: Date.now() } })
  }

  /** Open the ensemble view, on one of its tabs. */
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
    this.set({ view, chapterId, jump: { chapterId, offset, length, nonce: Date.now() } })
  }

  /** Forget a jump once a view has shown it, so coming back to the chapter does not replay it. */
  consumeJump(nonce: number): void {
    if (this.snapshot.jump?.nonce !== nonce) return
    const { jump: _jump, ...rest } = this.snapshot
    this.snapshot = rest
    for (const listener of [...this.listeners]) listener()
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
      const { jobs } = await this.api.call('jobs.list', root !== undefined ? { root } : {}, this.abort.signal)
      if (this.snapshot.root !== root) return
      this.set({ jobs })
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
      else if (job.status === 'done' && (job.kind === 'audio' || job.kind === 'comic')) this.set({ jobEnded: { job, nonce: Date.now() } })
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
    return await this.follow(started.jobId, onText).done
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
    const settings = await this.api.call('settings.get', {})
    this.set({ settings })
    return settings
  }

  /** Save settings; `keys` maps endpoint addresses to keys typed for them. */
  async saveSettings(patch: Record<string, unknown>, keys?: Record<string, string>): Promise<SettingsView> {
    const settings = await this.api.call('settings.update', { patch, ...(keys !== undefined && Object.keys(keys).length > 0 ? { keys } : {}) })
    this.set({ settings })
    return settings
  }

  /** One-click setup of a service. The settings only change when the key works. */
  async applySetup(input: { service: ServiceId | 'codex'; key?: string; origin?: string; parts: SetupPart[] }): Promise<EndpointCheck> {
    const { view, check } = await this.api.call('setup.apply', input)
    this.set({ settings: view })
    return check
  }

  /** Put the first-run guide aside for good. */
  async dismissSetup(): Promise<void> {
    this.set({ settings: await this.api.call('setup.dismiss', {}) })
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
    for (const listener of [...this.listeners]) listener()
  }

  /** Go to the settings, at the part that sets a capability up. */
  openSettings(focus?: Capability): void {
    this.navigated = true
    const { needs: _needs, settingsFocus: _focus, ...rest } = this.snapshot
    this.snapshot = { ...rest, view: 'settings', ...(focus !== undefined ? { settingsFocus: focus } : {}) }
    for (const listener of [...this.listeners]) listener()
  }

  /** The settings showed what a link asked for. */
  consumeSettingsFocus(): void {
    if (this.snapshot.settingsFocus === undefined) return
    const { settingsFocus: _focus, ...rest } = this.snapshot
    this.snapshot = rest
    for (const listener of [...this.listeners]) listener()
  }
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * `ctx.novel` — the Host-plane service of the plugin. It owns the studio
 * engine and answers the two questions every caller has: which directory is
 * this session's workspace, and which novel project lives there.
 *
 * The agent-plane half (tools, prompt, commands) and the browser route both
 * consume this one service, so a chapter written by the orchestrator shows up
 * in the Studio the moment it lands on disk.
 */
import { stopLocalWorkers } from '../core/media/local'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workspace'
import { randomBytes } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { mountAgent as mountAgentHalf } from '../agent/mount'
import { NovelCore, type ProjectRuntime, type RemovedBook, type TaskContext } from '../core/core'
import { listEndpointModels, modelsBase } from '../core/media/discovery'
import { ProviderError } from '../core/media/http'
import { soundSetup } from '../core/media/sound'
import { attachReconciler } from '../core/reconcile'
import { readStub, VaultError } from '../core/util/vault'
import { BuildWatch, type BuildState } from './build'
import { createDeviceAuth, type DeviceAuth } from './device-auth'
import { DOOR_VERSION, type HostControl } from './door'
import { bookInPlay, type InPlayClues } from './in-play'
import { ProjectError } from '../core/project'
import { SessionBooks, SessionStateStore, type SwitchedBy } from '../core/session-state'
import { DEFAULT_SETTINGS, mergeSettings, SettingsStore, type DeepPartial } from '../core/settings'
import { errorMessage } from '../core/util/async'
import { displayPath, exists } from '../core/util/fs'
import type { CodexStatus, EndpointCheck, EndpointModel, HelpPackage, HelpView, KeyState, LockView, ModelKind, PrivateShelfState, ShareStatus, WorkspaceInfo } from '../shared/rpc'
import { unlistedModels } from '../shared/recommended'
import { localImages } from '../shared/images'
import { compatibleBase, hostOf, originOf, recommendedSetup, SERVICES, serviceOf, setupPatch, speechProtocol, type ServiceId, type SetupPart } from '../shared/services'
import type { ModelRoute, NovelSettings, ProjectRef, WorkMode } from '../shared/types'
import { codexStatus, createCodexBridge } from './codex'
import { KeyStore } from './keys'
import { followRecommended, loadRecommended, noteAdopted } from './recommended'
import { createHarnessLlm } from './llm-backend'
import { createRoleRunner, CREW_PRESET, type CrewRunner } from './roles'
import { SessionSeal } from './session-seal'
import { ShareServer } from './share'
import { RemoteDoor } from './remote'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Novel Writer studio engine and workspace resolution. */
    novel: NovelService
  }
}

export interface NovelServiceConfig {
  /** Deployment defaults overlaid by each user's saved settings. */
  settings?: DeepPartial<NovelSettings>
}

type SessionId = Agent['id']

/** The outside coding agents the crew can call on, and the official DSH plugin each comes in. */
const HELP_PACKAGES: readonly Pick<HelpPackage, 'id' | 'package'>[] = [
  { id: 'claude-code', package: '@deepseek-ai/dsh-subagent-claude-code' },
  { id: 'codex', package: '@deepseek-ai/dsh-subagent-codex' },
]

export class NovelService extends Service {
  readonly core: NovelCore
  readonly sessions = new SessionStateStore()
  /** Which conversations hold something of which book: what a sealed book takes under its seal with it. */
  readonly sessionBooks = new SessionBooks()
  readonly keys: KeyStore
  /** The reader served to other devices on the local network; closed unless the author switched it on. */
  readonly share: ShareServer
  /** The door for working the Studio from a phone; closed until the author opens it. Open while this Host half is replaced, it is handed to the next. */
  readonly remote: RemoteDoor
  /** Runs the crew's roles as agents of the Harness. */
  readonly crew: CrewRunner
  /** Keeps the conversations about a sealed book under its seal while it is locked. */
  readonly sessionSeal: SessionSeal

  /** Which build this Host half is, against the one installed now. */
  private readonly build = new BuildWatch()

  /**
   * @param control - the door this Host half came in by, when it came in by one: what lets it be replaced while DSH runs.
   */
  /** Settled once the settings have been brought up against the recommendations in force: what is shown of them before that could be about to change. */
  readonly recommendations: Promise<void>

  constructor(ctx: Context, config: NovelServiceConfig = {}, private readonly control?: HostControl) {
    super(ctx, 'novel')
    this.keys = new KeyStore(ctx, (message, error) => { this.log(message, error) })
    const defaults = config.settings !== undefined ? mergeSettings(structuredClone(DEFAULT_SETTINGS), config.settings) : DEFAULT_SETTINGS
    // The crew works as agents on the Harness's own loop, each run a child of the conversation that asked for it.
    this.crew = createRoleRunner(ctx, {
      log: (message, error) => { this.log(message, error) },
      // A role's run holds the book it worked on, and so does the conversation it was a child of — the run is listed there by what it did.
      onRun: ({ session, book, parent }) => {
        if (book === undefined) return
        for (const id of [session, parent]) if (id !== undefined) void this.sessionBooks.touch(id, resolve(book)).catch((error: unknown) => { this.log('could not note which book a conversation holds', error) })
      },
      // The Harness meters these calls itself; the Studio's ledger, which the author reads by book and by role, counts them too.
      onUsage: ({ route, inputTokens, outputTokens, cachedTokens }) => {
        const tag = route.for
        this.core.usage.record({
          kind: 'text',
          model: route.model,
          via: route.provider,
          input: inputTokens,
          output: outputTokens,
          ...(cachedTokens !== undefined ? { cached: cachedTokens } : {}),
          ...(tag !== undefined ? { role: tag.role as never, ...(tag.book !== undefined ? { book: tag.book } : {}), ...(tag.title !== undefined ? { bookTitle: tag.title } : {}) } : {}),
        })
      },
    })
    // Registered wherever the Harness delegates at all: the provider is how a role's run becomes a child the Harness knows.
    ctx.inject(['subagents'], (inner) => {
      try {
        inner.subagents.registerProvider(this.crew.provider)
      } catch (error) {
        this.log('could not register the crew with the Harness\'s subagents; roles will run without a place in the conversation', error)
      }
    })
    this.core = new NovelCore({
      llm: createHarnessLlm(ctx),
      roles: this.crew,
      credentials: this.keys,
      bridges: { codex: createCodexBridge(ctx) },
      settings: new SettingsStore(defaults),
      log: (message, error) => { this.log(message, error) },
    })
    // Files changed behind the Studio's back are noticed, recorded and digested again.
    attachReconciler(this.core)
    ctx.effect(() => () => { this.core.dispose(); stopLocalWorkers() }, 'novel: studio engine')
    this.share = new ShareServer(this.core, (message, error) => { this.log(message, error) })
    ctx.effect(() => () => { void this.share.close().catch(() => {}) }, 'novel: reader for other devices')
    this.remote = new RemoteDoor((message, error) => { this.log(message, error) }, undefined, join(this.core.settings.folder, 'phone-door.json'))
    // (Open while the Host half before this one was replaced: opened again as it was — a phone at work keeps its link.)
    void this.remote.resume().catch(() => {})
    ctx.effect(() => () => { void this.remote.park().catch(() => {}) }, 'novel: the door for a phone')
    this.sessionSeal = new SessionSeal(ctx, this)
    // The recommendations that came with this build are put in force, and the settings brought up against them: an update of the plugin is when they change.
    this.recommendations = loadRecommended((message, error) => { this.log(message, error) })
      .then(() => followRecommended(this.core.settings))
      .catch((error: unknown) => { this.log('could not bring the settings up against the recommendations', error) })
      // From here on, a setting that becomes what is recommended is one a later issue may move.
      .then(() => { ctx.effect(() => this.core.settings.onChange(() => { void noteAdopted(this.core.settings).catch((error: unknown) => { this.log('could not note which settings are a recommendation', error) }) }), 'novel: recommendations') })
      .catch(() => {})
    void this.recommendations
      .then(() => this.core.ready())
      .catch((error: unknown) => { this.log('settings could not be loaded', error) })
      // Sharing that was on when the Harness last quit is on again when it starts.
      .then(() => this.share.apply())
      .catch(() => {})
      // A sealed book that is locked — every one is, when DSH starts — has its conversations under the seal: what was in use when it was last locked goes there now.
      .then(() => { this.sessionSeal.start(() => this.sealedBooks()) })
      .catch((error: unknown) => { this.log('could not look after the conversations of sealed books', error) })
  }

  /** Roots of the sealed books in the workspaces DSH knows. */
  private async sealedBooks(): Promise<string[]> {
    const roots: string[] = []
    for (const workspace of this.ctx.get('workspaceRegistry')?.list() ?? []) {
      for (const book of await this.safeDiscover(workspace.path)) if (await readStub(book.root) !== undefined) roots.push(book.root)
    }
    return [...new Set(roots)]
  }

  /**
   * Take a book off the shelf. Its own files go to the trash, where they can be
   * put back; sessions that were on it are on no book, and it is no longer
   * shared with other devices.
   */
  // ───────────── sealed books ─────────────

  /** This computer's own way of proving its owner is present; undefined where the Studio knows none. */
  readonly device: DeviceAuth | undefined = createDeviceAuth()

  /** The slot id of this computer in a book's list of ways to open it. */
  private deviceSlot(): string {
    return `host:${hostname()}`
  }

  async lockView(root: string): Promise<LockView> {
    const lock = await this.core.lockOf(root)
    const device = await this.device?.info().catch(() => undefined) ?? { available: false, biometrics: false, method: 'none' as const, host: hostname() }
    // Only a sealed book has conversations to put under a seal.
    const conversations = lock.sealed ? await this.sessionSeal.status(root).catch(() => undefined) : undefined
    return { ...lock, device, deviceOn: lock.ways.some(way => way.kind === 'device' && way.id === this.deviceSlot()), ...(conversations !== undefined ? { conversations } : {}) }
  }

  /** Let this computer's own unlock open a book that is unlocked now, or stop letting it. */
  async setDeviceUnlock(root: string, on: boolean): Promise<void> {
    const stub = await readStub(resolve(root))
    if (stub === undefined) throw new ProjectError('novel/invalid', 'this book is not sealed')
    if (!on) {
      await this.core.rekeyBook(root, { remove: { kind: 'device', id: this.deviceSlot() } })
      await this.device?.remove(stub.id).catch(() => {})
      return
    }
    const info = await this.device?.info()
    if (this.device === undefined || info === undefined || !info.available) throw new ProjectError('novel/unsupported', 'this computer offers no way to prove its owner is present — the book opens with its password')
    // A secret of its own for this computer, kept by the account's credential store; what it unwraps is in the book's novel.json.
    const secret = randomBytes(32)
    await this.device.store(stub.id, secret)
    try {
      await this.core.rekeyBook(root, { add: this.core.slotFor('device', this.deviceSlot(), secret, info.host) })
    } finally {
      secret.fill(0)
    }
  }

  /**
   * Unlock a sealed book: with its password, or by this computer's own unlock —
   * the system asks for a fingerprint or the computer's password, and only on a
   * yes is the book's key fetched from the credential store.
   * @throws ProjectError `novel/wrong-key` when it does not open that way.
   */
  async unlockBook(root: string, how: { password?: string; device?: boolean }, signal?: AbortSignal): Promise<void> {
    const stub = await readStub(resolve(root))
    if (stub === undefined) return
    try {
      if (how.password !== undefined && how.password.length > 0) {
        await this.core.unlockBook(root, { password: how.password })
        return
      }
      if (how.device !== true) throw new ProjectError('novel/invalid', 'give the password, or ask for this computer\'s own unlock')
      const zh = this.locale().startsWith('zh')
      await this.byPresence({ id: stub.id, set: stub.sealed.slots.some(slot => slot.kind === 'device' && slot.id === this.deviceSlot()), reason: zh ? `解锁《${stub.title}》` : `unlock "${stub.title}"`, what: 'this book' }, async (secret) => { await this.core.unlockBook(root, { kind: 'device', id: this.deviceSlot(), secret }) }, signal)
    } catch (error) {
      if (error instanceof VaultError) throw new ProjectError(error.code === 'wrong-key' ? 'novel/wrong-key' : 'novel/invalid', error.message)
      throw error
    }
  }

  /**
   * Open something by this computer's own unlock — a sealed book, the private shelf: the system asks for a fingerprint
   * or the computer's password, and only on a yes is the secret that opens it fetched from the account's credential store.
   * @param of.id - what the secret is kept under.
   * @param of.set - whether it was set up to open this way on this computer.
   * @throws ProjectError `novel/wrong-key` where it was not, the owner was not confirmed, or the secret is gone.
   */
  private async byPresence(of: { id: string; set: boolean; reason: string; what: string }, open: (secret: Buffer) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.device === undefined) throw new ProjectError('novel/invalid', 'give the password: this computer offers no unlock of its own')
    if (!of.set) throw new ProjectError('novel/wrong-key', `${of.what} was not set up to open with this computer's unlock — use its password, then switch that on`)
    const confirmed = await this.device.confirm(of.reason, signal)
    if (!confirmed) throw new ProjectError('novel/wrong-key', 'the system did not confirm that it is you')
    const secret = await this.device.load(of.id)
    if (secret === undefined) throw new ProjectError('novel/wrong-key', `the key this computer kept for ${of.what} is gone — use the password, then switch this computer's unlock on again`)
    try {
      await open(secret)
    } finally {
      secret.fill(0)
    }
  }

  // ───────────── the private shelf: opened the way a sealed book is ─────────────

  /** What the shelf's secret is kept under in this account's credential store. */
  private shelfSecretId(id: string): string {
    return `shelf:${id}`
  }

  /** How the private shelf stands, with this computer's own unlock: whether there is one, and whether the shelf opens by it. */
  async shelfView(): Promise<PrivateShelfState> {
    const state = await this.core.shelfState()
    const device = await this.device?.info().catch(() => undefined) ?? { available: false, biometrics: false, method: 'none' as const, host: hostname() }
    return { set: state.set, open: state.open, device, deviceOn: state.devices.includes(this.deviceSlot()) }
  }

  /** Let this computer's own unlock open the private shelf (which is open now), or stop letting it. */
  async setShelfDeviceUnlock(on: boolean): Promise<void> {
    const state = await this.core.shelfState()
    if (state.id === undefined) throw new ProjectError('novel/invalid', 'no private shelf is set up here')
    if (!on) {
      await this.core.shelfWay({ remove: { kind: 'device', id: this.deviceSlot() } })
      await this.device?.remove(this.shelfSecretId(state.id)).catch(() => {})
      return
    }
    const info = await this.device?.info()
    if (this.device === undefined || info === undefined || !info.available) throw new ProjectError('novel/unsupported', 'this computer offers no way to prove its owner is present — the shelf opens with its password')
    if (!state.open) throw new ProjectError('novel/locked', 'open the private shelf with its password first')
    const secret = randomBytes(32)
    await this.device.store(this.shelfSecretId(state.id), secret)
    try {
      await this.core.shelfWay({ add: this.core.slotFor('device', this.deviceSlot(), secret, info.host) })
    } finally {
      secret.fill(0)
    }
  }

  /**
   * Open the private shelf: with its password, or by this computer's own unlock.
   * @throws ProjectError `novel/wrong-key` when it does not open that way.
   */
  async unlockShelf(how: { password?: string; device?: boolean }, signal?: AbortSignal): Promise<void> {
    try {
      if (how.password !== undefined && how.password.length > 0) {
        await this.core.openShelf(how.password)
        return
      }
      if (how.device !== true) throw new ProjectError('novel/invalid', 'give the password, or ask for this computer\'s own unlock')
      const state = await this.core.shelfState()
      if (state.id === undefined) throw new ProjectError('novel/invalid', 'no private shelf is set up here')
      const zh = this.locale().startsWith('zh')
      await this.byPresence({ id: this.shelfSecretId(state.id), set: state.devices.includes(this.deviceSlot()), reason: zh ? '打开小说工坊的私密书架' : 'open Novel Studio\'s private shelf', what: 'the private shelf' }, async (secret) => { await this.core.openShelfWith('device', this.deviceSlot(), secret) }, signal)
    } catch (error) {
      if (error instanceof VaultError) throw new ProjectError(error.code === 'wrong-key' ? 'novel/wrong-key' : 'novel/invalid', error.message)
      throw error
    }
  }

  /** The language the author reads system prompts in, as far as the Host can tell. */
  private locale(): string {
    return (process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale ?? 'en').toLowerCase()
  }

  async deleteBook(root: string): Promise<RemovedBook> {
    // A locked book is taken off the shelf as it lies; its folder is found without opening it.
    const book = (await this.core.lockOf(root)).locked ? resolve(root) : (await this.core.runtime(root)).project.root
    // A workspace folder is the Harness's, and other things may live in it: only the book leaves.
    const isWorkspace = (await this.workspaces()).some(workspace => resolve(workspace.path) === book)
    const removed = await this.core.removeBook(book, isWorkspace)
    await this.sessions.forget(book).catch((error: unknown) => { this.log('could not release the sessions of a removed book', error) })
    await this.sessionBooks.forget(book).catch(() => {})
    for (const [session, shown] of this.shown) if (shown === book) this.shown.delete(session)
    const shared = (await this.core.settings.get()).share?.books
    if (shared?.includes(book) === true) await this.core.settings.update({ share: { books: shared.filter(item => item !== book) } } as DeepPartial<NovelSettings>)
    return removed
  }

  /**
   * Switch the reader for other devices on or off, share or stop sharing a
   * book, move it to another port, or replace its address.
   * @throws ProjectError `novel/invalid` for a port that cannot be listened on.
   */
  async updateShare(input: { enabled?: boolean; book?: { root: string; shared: boolean; mode?: 'read' | 'edit' }; port?: number; renew?: boolean }): Promise<ShareStatus> {
    const current = (await this.core.settings.get()).share ?? { enabled: false }
    const books = new Set(current.books ?? [])
    const edit = new Set(current.edit ?? [])
    if (input.book !== undefined) {
      const root = (await this.core.runtime(input.book.root)).project.root
      if (input.book.shared) books.add(root)
      else books.delete(root)
      // Being changeable from another device is asked for book by book, and goes when the book stops being shared.
      if (input.book.shared && input.book.mode === 'edit') edit.add(root)
      else if (!input.book.shared || input.book.mode === 'read') edit.delete(root)
    }
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535)) {
      throw new ProjectError('novel/invalid', 'the port is a whole number between 1024 and 65535')
    }
    await this.core.settings.update({
      share: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.book !== undefined ? { books: [...books], edit: [...edit] } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        // A new address: whoever holds the old link can no longer read.
        ...(input.renew === true ? { token: randomBytes(18).toString('base64url') } : {}),
      },
    } as DeepPartial<NovelSettings>)
    await this.share.apply()
    return await this.share.status()
  }

  log(message: string, error?: unknown): void {
    try {
      this.ctx.logger.warn(`[novel] ${message}${error !== undefined ? `: ${errorMessage(error)}` : ''}`)
    } catch {
      console.warn(`[novel] ${message}`, error ?? '')
    }
  }

  // ───────────── this Host half, and the one installed ─────────────

  /** This Host half can be replaced by the installed one without DSH restarting. */
  get reloadable(): boolean {
    return this.control !== undefined && this.control.version >= DOOR_VERSION
  }

  /** Which build runs and which is installed; `reloadable` says whether the Studio can make them one itself. */
  async buildState(): Promise<BuildState & { reloadable: boolean }> {
    return { ...await this.build.state(), reloadable: this.reloadable }
  }

  /**
   * Take this Host half down and put up the one that is installed now: jobs
   * that run are stopped, books that were unlocked are locked again, and every
   * tool and route comes back from the new code. Answered before it happens —
   * the answer travels on a route that is about to go down.
   * @returns what the change interrupts, as counted when it was asked for.
   * @throws ProjectError `novel/unsupported` on a Host half that DSH loaded itself, with no door to change through.
   */
  reload(): { jobs: number } {
    const control = this.control
    if (control === undefined || !this.reloadable) throw new ProjectError('novel/unsupported', 'This Host half was loaded by DSH itself and cannot be replaced while DSH runs: restart DSH.')
    const jobs = this.core.jobs.list().filter(job => job.status === 'running').length
    const timer = setTimeout(() => {
      control.reload().catch((error: unknown) => { this.log('the installed Host half could not be put up; the running one stays', error) })
    }, 200)
    timer.unref?.()
    return { jobs }
  }

  // ───────────── workspaces ─────────────

  /** Every workspace the Harness knows, with the projects found in each. */
  async workspaces(): Promise<WorkspaceInfo[]> {
    const registry = this.ctx.get('workspaceRegistry')
    const rows: WorkspaceInfo[] = []
    const seen = new Set<string>()
    if (registry !== undefined) {
      for (const workspace of registry.list()) {
        if (seen.has(workspace.path)) continue
        seen.add(workspace.path)
        rows.push({ id: workspace.id, title: workspace.title, path: workspace.path, projects: await this.safeDiscover(workspace.path) })
      }
    }
    const fallback = this.ctx.get('sandboxPolicy')?.workspaceRoot
    if (rows.length === 0 && fallback !== undefined) {
      rows.push({ title: fallback.split(/[\\/]/).filter(Boolean).at(-1) ?? fallback, path: fallback, projects: await this.safeDiscover(fallback) })
    }
    return rows
  }

  /** The folder new workspaces go into: next to the ones the Harness already has. */
  workspaceHome(): string {
    const paths = this.ctx.get('workspaceRegistry')?.list().map(workspace => workspace.path) ?? []
    // Beside the Harness's own default workspace when there is one, else beside whatever is registered first.
    const anchor = paths.find(path => basename(path) === 'default-workspace') ?? paths.find(path => basename(dirname(path)) === 'deepseek-harness') ?? paths.at(-1)
    return anchor !== undefined ? dirname(anchor) : join(homedir(), 'Documents', 'deepseek-harness')
  }

  /**
   * Register a folder as a Harness workspace so books can be kept in it: an
   * existing folder by `path`, or a new one called `name` in the default place.
   * @throws ProjectError `novel/invalid` when the Harness has no workspace registry or the name cannot be a folder.
   */
  async createWorkspace(input: { name?: string; path?: string }): Promise<WorkspaceInfo> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) throw new ProjectError('novel/invalid', 'this Harness has no workspace registry; add a workspace in the left sidebar instead')
    let target: string
    if (input.path !== undefined && input.path.trim().length > 0) {
      target = input.path.trim()
      if (!isAbsolute(target)) throw new ProjectError('novel/invalid', 'a workspace folder is given by its full path')
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(target)
      } catch {
        throw new ProjectError('novel/not-found', `there is no folder at ${target}`)
      }
      if (!info.isDirectory()) throw new ProjectError('novel/invalid', `${target} is not a folder`)
    } else {
      const name = (input.name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/^\.+/, '').trim().slice(0, 80)
      if (name.length === 0) throw new ProjectError('novel/invalid', 'give the new workspace a name')
      const home = this.workspaceHome()
      target = join(home, name)
      for (let n = 2; await exists(target); n++) target = join(home, `${name}-${n}`)
      await mkdir(target, { recursive: true })
    }
    const workspace = await registry.create(target)
    return { id: workspace.id, title: workspace.title, path: workspace.path, projects: await this.safeDiscover(workspace.path) }
  }

  private async safeDiscover(path: string): Promise<WorkspaceInfo['projects']> {
    try {
      return await this.core.discover(path)
    } catch (error) {
      this.log(`could not scan ${path}`, error)
      return []
    }
  }

  /** Working directory of a session, live or stored. */
  async workspaceOfSession(sessionId: string): Promise<string | undefined> {
    const id = sessionId as SessionId
    const live = this.ctx.get('sessions')?.get(id)?.header.cwd
    if (live !== undefined) return live
    try {
      const stored = await this.ctx.get('sessionPersistence')?.stat(id)
      if (stored?.header.cwd !== undefined) return stored.header.cwd
    } catch (error) {
      this.log(`could not read session ${sessionId}`, error)
    }
    return undefined
  }

  workspaceOfAgent(agent: Agent): string {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined) return cwd
    const policy = this.ctx.get('sandboxPolicy')
    return policy !== undefined ? policy.resolve({ session: agent.session }).workspaceRoot : process.cwd()
  }

  /** Whether the session's sandbox forbids writing project files without asking. */
  isReadOnly(agent: Agent): boolean {
    try {
      return this.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode === 'read-only'
    } catch {
      return false
    }
  }

  /** Whether DSH's subagent service is there: what makes a role's run a child of the conversation, listed under it. */
  subagentsMounted(): boolean {
    try {
      return this.ctx.get('subagents') !== undefined
    } catch {
      return false
    }
  }

  // ───────────── the agent half ─────────────

  /**
   * Give a session what a novelist's session has: tools, instructions, digest.
   * Called by the entry a preset names (`dsh-novel-writer/agent`), which holds
   * no code of its own — so what is mounted is always of this Host's build.
   */
  mountAgent(ctx: Context): void {
    mountAgentHalf(ctx)
  }

  // ───────────── projects per session ─────────────

  /**
   * The book in play for a session: the conversation and the Studio beside it
   * are both on this book. In what order it is looked for — and why a role's
   * run is on the book it works on, not on the book its folder happens to be —
   * is said in `in-play.ts`.
   */
  async projectOfSession(sessionId: string, workspace?: string): Promise<ProjectRuntime | undefined> {
    return await bookInPlay(sessionId, {
      ...this.clues(),
      at: async root => await this.core.tryRuntime(root),
      inFolder: async folder => await this.core.defaultProject(folder),
    }, workspace)
  }

  /**
   * Root of the book in play for a session, found without opening it: a sealed
   * book that is locked is still the book the session is on, and the Studio
   * beside the conversation has its lock to show.
   */
  async bookOfSession(sessionId: string, workspace?: string): Promise<string | undefined> {
    try {
      return (await this.projectOfSession(sessionId, workspace))?.project.root
    } catch (error) {
      if (!(error instanceof ProjectError) || error.code !== 'novel/locked') throw error
      // Looked for in the same order, by what a sealed book shows of itself while it is locked.
      const sealed = async (root: string): Promise<string | undefined> => (await readStub(resolve(root)) !== undefined ? resolve(root) : undefined)
      return await bookInPlay(sessionId, {
        ...this.clues(),
        at: sealed,
        inFolder: async (folder) => {
          const direct = await sealed(folder)
          if (direct !== undefined) return direct
          const refs = await this.safeDiscover(folder)
          return refs.length === 1 ? refs[0]!.root : undefined
        },
      }, workspace)
    }
  }

  /** What this Host knows of its conversations, for one search for the book a conversation is on. */
  private clues(): Pick<InPlayClues<never>, 'named' | 'held' | 'worksFor' | 'folder'> {
    // What DSH keeps at the head of a session is read once for one search, whichever of its facts is asked for first.
    const headers = new Map<string, Promise<{ cwd?: string; origin?: string; parentSession?: string } | undefined>>()
    const header = (sessionId: string): Promise<{ cwd?: string; origin?: string; parentSession?: string } | undefined> => {
      let found = headers.get(sessionId)
      if (found === undefined) {
        found = (async () => {
          const id = sessionId as SessionId
          const live = this.ctx.get('sessions')?.get(id)?.header
          if (live !== undefined) return live
          try {
            return (await this.ctx.get('sessionPersistence')?.stat(id))?.header
          } catch (error) {
            this.log(`could not read session ${sessionId}`, error)
            return undefined
          }
        })()
        headers.set(sessionId, found)
      }
      return found
    }
    return {
      named: async sessionId => (await this.sessions.get(sessionId)).project,
      held: async sessionId => await this.sessionBooks.booksOf(sessionId),
      // A role's run, a subagent of DSH's: a child of the conversation that asked for it, or — a run nobody's conversation asked for — marked as no conversation of the author's.
      worksFor: async (sessionId) => {
        const known = await header(sessionId)
        if (known?.parentSession !== undefined) return { parent: known.parentSession }
        return known?.origin === 'subagent' || this.crew.isRole(sessionId) ? {} : undefined
      },
      folder: async sessionId => (await header(sessionId))?.cwd ?? await this.workspaceOfSession(sessionId),
    }
  }

  async projectOfAgent(agent: Agent): Promise<ProjectRuntime | undefined> {
    return await this.projectOfSession(agent.id, this.workspaceOfAgent(agent))
  }

  /**
   * The book a tool call acts on. A call that names one gets that one. Otherwise
   * it is the book the calling model was last shown as in play — not necessarily
   * the one in play this instant: when the author changes book in the Studio
   * while the model is mid-step, the calls it already decided on were meant for
   * the book it knew, and must not land on another.
   * @throws ProjectError `novel/no-project` or `novel/not-found`, with guidance the model can act on.
   */
  async requireProject(agent: Agent, book?: string): Promise<ProjectRuntime> {
    const workspace = this.workspaceOfAgent(agent)
    if (book !== undefined && book.trim().length > 0) return await this.resolveBook(book, workspace)
    try {
      const shown = this.shown.get(agent.id)
      if (shown !== undefined) {
        const known = await this.core.tryRuntime(shown)
        if (known !== undefined) return known
      }
      const runtime = await this.projectOfAgent(agent)
      if (runtime !== undefined) return runtime
    } catch (error) {
      if (!(error instanceof ProjectError) || error.code !== 'novel/locked') throw error
      // The call named no book and the one in play is locked: say which books it could have named instead.
      const locked = await this.bookOfSession(agent.id, workspace).catch(() => undefined)
      const others = (await this.booksNear(agent.id, workspace).catch(() => [])).filter(ref => ref.root !== locked)
      if (others.length === 0) throw error
      throw new ProjectError('novel/locked', `${error.message}. That is the book this conversation is on. Other books in reach: ${others.slice(0, 8).map(ref => `"${ref.title}" (${ref.relative})`).join(', ')} — to work on one of those, name it with \`book\``)
    }
    const refs = await this.safeDiscover(workspace)
    if (refs.length > 1) {
      throw new ProjectError('novel/no-project', `this workspace holds several novel projects (${refs.map(ref => `"${ref.title}" at ${ref.relative}`).join(', ')}) — call novel_status with \`project\` set to one of them to choose`)
    }
    throw new ProjectError('novel/no-project', `no novel project in ${workspace} yet — create one with novel_init (ask the author for the title and premise first unless they already gave them)`)
  }

  /** Root of the book a session's model was last shown as in play. */
  private readonly shown = new Map<string, string>()

  /** Record which book a session's model has just been told is in play (`undefined`: none). */
  markShown(sessionId: string, root: string | undefined): void {
    if (root === undefined) this.shown.delete(sessionId)
    else this.shown.set(sessionId, root)
  }

  forgetSession(sessionId: string): void {
    this.shown.delete(sessionId)
  }

  /**
   * The books a session most likely means besides the one in play: those of its
   * workspace and those it has been on. Cheap enough to compute with every digest.
   */
  async booksNear(sessionId: string, workspace: string | undefined): Promise<ProjectRef[]> {
    const refs = workspace !== undefined ? [...await this.safeDiscover(workspace)] : []
    for (const root of (await this.sessions.get(sessionId)).books ?? []) {
      if (refs.some(ref => ref.root === root)) continue
      const ref = await this.bookRef(root, workspace)
      if (ref !== undefined) refs.push(ref)
    }
    return refs
  }

  /** Title and findable path of the book at a root; `undefined` when there is no book there any more. */
  async bookRef(root: string, workspace: string | undefined): Promise<ProjectRef | undefined> {
    try {
      const runtime = await this.core.tryRuntime(root)
      if (runtime === undefined) return undefined
      return { root, title: (await runtime.project.manifest()).title, relative: workspace !== undefined ? displayPath(workspace, root) : root }
    } catch (error) {
      this.log(`could not read the book at ${root}`, error)
      return undefined
    }
  }

  /** Every book a session can reach: its own workspace first, then the other registered ones. */
  async booksInReach(workspace: string | undefined): Promise<ProjectRef[]> {
    const seen = new Set<string>()
    const refs: ProjectRef[] = []
    const add = (found: ProjectRef[]): void => {
      for (const ref of found) {
        if (seen.has(ref.root)) continue
        seen.add(ref.root)
        refs.push(ref)
      }
    }
    if (workspace !== undefined) add(await this.safeDiscover(workspace))
    for (const other of await this.workspaces()) {
      // Paths relative to another workspace would mislead; outside the session's own, a book goes by its full path.
      if (other.path !== workspace) add(other.projects.map(ref => ({ ...ref, relative: ref.root })))
    }
    return refs
  }

  /**
   * Find a book by what a person or a model would call it: its title (with or
   * without 《》 or quotes), its folder, or a path.
   * @throws ProjectError `novel/not-found` naming the books there are.
   */
  async resolveBook(ref: string, workspace: string | undefined): Promise<ProjectRuntime> {
    const wanted = ref.trim()
    const direct = isAbsolute(wanted) ? resolve(wanted) : workspace !== undefined ? resolve(workspace, wanted) : undefined
    if (direct !== undefined) {
      const at = await this.core.tryRuntime(direct)
      if (at !== undefined) return at
    }
    const plain = (text: string): string => text.replace(/[《》「」『』"'“”‘’]/g, '').trim().toLowerCase()
    const key = plain(wanted)
    const books = await this.booksInReach(workspace)
    const matches = (test: (book: ProjectRef) => boolean): ProjectRef[] => books.filter(test)
    const found = [
      matches(book => plain(book.title) === key),
      matches(book => book.relative.toLowerCase() === key || basename(book.root).toLowerCase() === key),
      matches(book => key.length > 0 && (plain(book.title).includes(key) || key.includes(plain(book.title)))),
    ].find(list => list.length > 0) ?? []
    const list = (items: ProjectRef[]): string => items.map(book => `"${book.title}" (${book.relative})`).join(', ')
    if (found.length === 1) {
      const runtime = await this.core.tryRuntime(found[0]!.root)
      if (runtime !== undefined) return runtime
    }
    if (found.length > 1) throw new ProjectError('novel/not-found', `"${ref}" could be any of ${list(found)} — name the book by its path`)
    throw new ProjectError('novel/not-found', books.length > 0 ? `no book called "${ref}" — the books here are ${list(books)}` : `no book called "${ref}", and no novel project in reach yet`)
  }

  /**
   * Put a session on a book (or change its mode). `by` says who moved it: the
   * author in the Studio, or the session's own model — which then already knows.
   */
  async bind(sessionId: string, patch: { project?: string; mode?: WorkMode }, by: SwitchedBy = 'author'): Promise<{ mode: WorkMode; project?: string }> {
    // Where it comes from is found without opening it: a session whose book is locked can still be moved onto another.
    const from = patch.project !== undefined && patch.project !== '' ? await this.bookOfSession(sessionId).catch(() => undefined) : undefined
    const state = await this.sessions.update(sessionId, patch, { by, ...(from !== undefined ? { from } : {}) })
    if (by === 'agent' && state.project !== undefined && patch.project !== undefined) this.markShown(sessionId, state.project)
    return { mode: state.mode, ...(state.project !== undefined ? { project: state.project } : {}) }
  }

  // ───────────── a conversation for a book ─────────────

  /**
   * The conversation to talk to the showrunner in.
   *
   * For a book: the one that is on it already — the latest, when there are
   * several — else, when asked to, a new one: a novelist's conversation in the
   * book's workspace, named after the book and put on it, so that the Studio
   * beside it shows this book and the showrunner works on it from its first
   * word. For a folder alone: a new novelist's conversation there.
   * @returns nothing where there is none and none was to be made, or where this Harness has no way to make one.
   */
  async conversationFor(target: { root?: string; workspace?: string }, create: boolean): Promise<{ sessionId: string; created: boolean; title?: string } | undefined> {
    const root = target.root !== undefined ? resolve(target.root) : undefined
    const persistence = this.ctx.get('sessionPersistence')
    if (root !== undefined) {
      // The ones that are on this book now, the one last moved first.
      const on: { id: string; at: string }[] = []
      for (const id of await this.sessions.sessionsOn(root)) {
        const state = await this.sessions.get(id)
        if (state.project !== undefined && resolve(state.project) === root) on.push({ id, at: state.updatedAt })
      }
      on.sort((left, right) => right.at.localeCompare(left.at))
      // Only conversations DSH still has, and no role's run: those are records, not places to talk.
      for (const { id } of on) {
        const header = this.ctx.get('sessions')?.get(id as SessionId)?.header ?? await persistence?.stat(id as SessionId).then(stored => stored?.header, () => undefined)
        if (header !== undefined && header.origin !== 'subagent' && header.parentSession === undefined) return { sessionId: id, created: false }
      }
    }
    if (!create) return undefined
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) return undefined
    const stub = root !== undefined ? await readStub(root) : undefined
    const title = root === undefined ? undefined : stub?.title ?? (await this.core.tryRuntime(root).then(runtime => runtime?.project.manifest(), () => undefined))?.title
    // The registered workspace the book lies in: the conversation is listed there, beside the others about its books.
    const home = root ?? (target.workspace !== undefined ? resolve(target.workspace) : undefined)
    if (home === undefined) return undefined
    const workspaces = this.ctx.get('workspaceRegistry')?.list() ?? []
    const inside = (path: string): boolean => home === path || home.startsWith(path.endsWith(sep) ? path : path + sep)
    const workspace = workspaces.filter(candidate => inside(candidate.path)).sort((left, right) => right.path.length - left.path.length)[0]
    const made = await controller.create({ ...(workspace !== undefined ? { workspaceId: workspace.id } : { cwd: root !== undefined ? dirname(root) : home }), agentPreset: CREW_PRESET })
    const sessionId = made.sessionId as string
    if (root !== undefined) await this.bind(sessionId, { project: root }, 'author')
    let named: string | undefined
    if (title !== undefined && title.trim().length > 0) {
      named = /[\u3400-\u9fff]/.test(title) ? `《${title.trim()}》` : title.trim()
      // A name is a convenience: a conversation that could not be named is still the book's.
      await controller.rename({ sessionId: made.sessionId, title: named }).catch((error: unknown) => { this.log(`could not name the conversation of ${root ?? home}`, error) })
    }
    return { sessionId, created: true, ...(named !== undefined ? { title: named } : {}) }
  }

  // ───────────── tasks ─────────────

  /**
   * The live agent of a conversation, woken if it sleeps: what work started in
   * the Studio beside that conversation hangs its role agents from.
   * @returns undefined when the session is not a conversation of its own (or is gone).
   */
  async agentOfSession(sessionId: string): Promise<Agent | undefined> {
    const id = sessionId as SessionId
    const live = this.ctx.get('agents')?.get(id)
    if (live !== undefined) return live
    try {
      const found = await this.ctx.get('sessionController')?.resolveAgent(id)
      return found !== undefined && 'agent' in found ? found.agent : undefined
    } catch (error) {
      this.log(`could not wake session ${sessionId}`, error)
      return undefined
    }
  }

  /** Outside coding agents the author installed in DSH: the subagent providers DSH's own delegation tool reaches. */
  outsideHelp(): { claudeCode: boolean; codex: boolean } {
    const subagents = this.ctx.get('subagents')
    return { claudeCode: subagents?.getProvider('claude-code') !== undefined, codex: subagents?.getProvider('codex') !== undefined }
  }

  /**
   * The same help as the DSH plugins it comes in. Installing and removing go
   * through DSH's own plugin manager — the one behind DSH's Settings → Plugins
   * — so a plugin the Studio installs is in every way one the author installed there.
   */
  async helpView(): Promise<HelpView> {
    const connected = this.outsideHelp()
    const manager = this.ctx.get('pluginManager')
    let bundles: { name: string; version?: string; installed: boolean; removable: boolean }[] = []
    try {
      bundles = manager !== undefined ? await manager.listBundles() : []
    } catch (error) {
      this.log('could not read the plugins of this DSH profile', error)
    }
    return {
      manage: manager !== undefined,
      packages: HELP_PACKAGES.map((entry) => {
        const bundle = bundles.find(candidate => candidate.name === entry.package)
        return {
          ...entry,
          installed: bundle !== undefined,
          ...(bundle?.version !== undefined ? { version: bundle.version } : {}),
          connected: entry.id === 'claude-code' ? connected.claudeCode : connected.codex,
          removable: bundle?.removable === true,
        }
      }),
    }
  }

  /**
   * Install an outside-help plugin. It downloads a package: only ever started by the author pressing the button.
   * @returns what the author is told: that it is in, that DSH has to be restarted for it, or why it did not go in.
   * @throws ProjectError when DSH has no plugin manager here, or the installation failed (with the manager's own account of why).
   */
  async installHelp(id: HelpPackage['id'], signal?: AbortSignal): Promise<{ application: string; restart: boolean; message: string }> {
    const entry = HELP_PACKAGES.find(candidate => candidate.id === id)
    const manager = this.ctx.get('pluginManager')
    if (entry === undefined) throw new ProjectError('novel/invalid', `no outside help is called "${id}"`)
    if (manager === undefined) throw new ProjectError('novel/unsupported', 'This DSH has no plugin manager: install the plugin with `dsh plugin add` and restart DSH.')
    const requestId = `novel-help-${id}-${Date.now()}` as never
    const stop = (): void => { void manager.cancelInstall(requestId).catch(() => {}) }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      const result = await manager.installBundle(entry.package, { enabled: true, requestId })
      if (result.application === 'failed' || result.application === 'cancelled') {
        const detail = result.error !== undefined ? ((result.error as { message?: string }).message ?? JSON.stringify(result.error)) : ''
        throw new ProjectError(result.application === 'cancelled' ? 'novel/cancelled' : 'novel/provider', `${entry.package} ${result.application === 'cancelled' ? 'was not installed: stopped' : 'could not be installed'}${detail.length > 0 ? `: ${detail}` : ''}${result.pendingBuilds !== undefined && result.pendingBuilds.length > 0 ? ` (packages waiting for their install scripts to be allowed: ${result.pendingBuilds.join(', ')} — allow them under DSH's Settings → Plugins)` : ''}`)
      }
      const restart = result.application === 'restart-required'
      return { application: result.application, restart, message: restart ? `${entry.package} is installed; DSH has to be restarted for it to answer.` : result.application === 'overridden' ? `${entry.package} is installed, and a setting of this profile keeps it switched off: switch it on under DSH's Settings → Plugins.` : `${entry.package} is installed.` }
    } finally {
      signal?.removeEventListener('abort', stop)
    }
  }

  /** Remove an outside-help plugin the author installed. */
  async removeHelp(id: HelpPackage['id']): Promise<string | undefined> {
    const entry = HELP_PACKAGES.find(candidate => candidate.id === id)
    const manager = this.ctx.get('pluginManager')
    if (entry === undefined) throw new ProjectError('novel/invalid', `no outside help is called "${id}"`)
    if (manager === undefined) throw new ProjectError('novel/unsupported', 'This DSH has no plugin manager: remove the plugin with `dsh plugin remove`.')
    const result = await manager.removeBundle(entry.package)
    if (result.application === 'failed') throw new ProjectError('novel/provider', `${entry.package} could not be removed${result.error !== undefined ? `: ${(result.error as { message?: string }).message ?? JSON.stringify(result.error)}` : ''}`)
    return result.application === 'restart-required' ? `${entry.package} is removed; DSH has to be restarted for it to be gone.` : undefined
  }

  /** Task context for work started by an agent's tool call. */
  agentTask(agent: Agent | undefined, signal: AbortSignal): TaskContext {
    const route = agent !== undefined ? this.routeOf(agent) : undefined
    return { origin: 'agent', signal, ...(route !== undefined ? { agentRoute: route } : {}), ...(agent !== undefined ? { caller: agent } : {}) }
  }

  routeOf(agent: Agent): ModelRoute | undefined {
    const { provider, model, reasoningEffort } = agent.options
    if (provider === undefined || model === undefined) return undefined
    return { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
  }

  // ───────────── keys, endpoints and setup ─────────────

  /** Every endpoint the settings talk to, with the name each slot reads its key from (if any). */
  endpointsOf(settings: NovelSettings): { url: string; ref?: string }[] {
    const slots: { url: string | undefined; ref: string | undefined }[] = [
      ...Object.values(settings.models).map(route => ({ url: route?.baseURL, ref: route?.apiKeyRef })),
      { url: settings.embedding.provider !== 'none' ? settings.embedding.baseURL : undefined, ref: settings.embedding.apiKeyRef },
      { url: keyedImages(settings) ? settings.image.baseURL ?? defaultEndpoint(settings.image.provider) : undefined, ref: settings.image.apiKeyRef },
      { url: settings.tts.provider !== 'none' ? settings.tts.baseURL ?? defaultEndpoint(settings.tts.provider) : undefined, ref: settings.tts.apiKeyRef },
      // Sound with an endpoint of its own; when it rides on the speech setup, that slot already covers it.
      { url: settings.sound?.provider === 'qwen-audiogen' ? settings.sound.baseURL ?? defaultEndpoint('qwen-audiogen') : undefined, ref: settings.sound?.apiKeyRef },
    ]
    return slots.filter((slot): slot is { url: string; ref: string | undefined } => slot.url !== undefined && slot.url.trim().length > 0)
      .map(slot => ({ url: slot.url, ...(slot.ref !== undefined && slot.ref.length > 0 ? { ref: slot.ref } : {}) }))
  }

  /** Key availability for the settings' endpoints and the known services, keyed by host. */
  async keyStates(settings: NovelSettings): Promise<Record<string, KeyState>> {
    const states: Record<string, KeyState> = {}
    for (const service of Object.values(SERVICES)) {
      if (service.origin.length === 0) continue
      const state = await this.keys.describe(service.origin)
      states[state.host] = state
    }
    for (const endpoint of this.endpointsOf(settings)) {
      const state = await this.keys.describe(endpoint.url, endpoint.ref)
      // A slot that names its key is reported under its own name, without hiding the host's saved key.
      states[endpoint.ref !== undefined ? `${state.host}#${endpoint.ref}` : state.host] = state
    }
    return states
  }

  async codex(): Promise<CodexStatus> {
    return await codexStatus(this.ctx)
  }

  /** Whether the key of a slot is at hand, given the states `keyStates` reported. */
  hasKey(keys: Record<string, KeyState>, url: string | undefined, ref: string | undefined): boolean {
    const host = hostOf(url)
    return host !== undefined && keys[ref !== undefined && ref.length > 0 ? `${host}#${ref}` : host]?.configured === true
  }

  /** Which of the optional capabilities can be used right now. */
  mediaReady(settings: NovelSettings, keys: Record<string, KeyState>, codex: CodexStatus): { embedding: boolean; image: boolean; tts: boolean; sound: boolean } {
    const sound = soundSetup(settings)
    return {
      sound: sound !== undefined && this.hasKey(keys, sound.baseURL ?? defaultEndpoint('qwen-audiogen'), sound.apiKeyRef),
      embedding: settings.embedding.provider !== 'none' && settings.embedding.model !== undefined && this.hasKey(keys, settings.embedding.baseURL, settings.embedding.apiKeyRef),
      image: settings.image.provider === 'codex'
        ? codexReady(codex, settings.image.bridge)
        // A model on this machine holds no key: a ComfyUI server is there or it is not, Diffusers needs its model named.
        : settings.image.provider === 'comfyui' ? true
          : settings.image.provider === 'diffusers' ? (settings.image.model ?? '').trim().length > 0
            // A server of the author's own may take no key: it is ready once it is told which model to draw with.
            : localImages(settings.image) ? (settings.image.model ?? '').trim().length > 0
            : settings.image.provider !== 'none' && this.hasKey(keys, settings.image.baseURL ?? defaultEndpoint(settings.image.provider), settings.image.apiKeyRef),
      tts: settings.tts.provider !== 'none' && this.hasKey(keys, settings.tts.baseURL ?? defaultEndpoint(settings.tts.provider), settings.tts.apiKeyRef),
    }
  }

  /** The key to try against an endpoint: one just typed, a named one, or the saved one. */
  private async keyFor(url: string, typed?: string, ref?: string): Promise<string | undefined> {
    const fresh = typed?.trim()
    if (fresh !== undefined && fresh.length > 0) return fresh
    if (ref !== undefined && ref.trim().length > 0) return await this.keys.named(ref)
    return await this.keys.forEndpoint(url)
  }

  async endpointModels(url: string, kind: ModelKind, typed?: string, ref?: string, signal?: AbortSignal): Promise<EndpointModel[]> {
    if (hostOf(url) === undefined) throw new ProjectError('novel/invalid', 'enter the endpoint address first')
    const listed: EndpointModel[] = await listEndpointModels(url, kind, await this.keyFor(url, typed, ref), signal)
    if (kind !== 'speech') return listed
    // Everything that can speak is listed; each model says which protocol drives it, and those nothing drives yet say so.
    const service = serviceOf(url)
    for (const id of unlistedModels(service, 'tts')) if (!listed.some(model => model.id === id)) listed.unshift({ id })
    const tagged = listed.map((model) => {
      const via = speechProtocol(service, model.id)
      return via !== undefined ? { ...model, via } : { ...model, unsupported: true }
    })
    return [...tagged.filter(model => model.unsupported !== true), ...tagged.filter(model => model.unsupported === true)]
  }

  /** Ask an endpoint whether the key opens it. Never throws: the answer is the outcome. */
  async checkEndpoint(url: string, typed?: string, ref?: string, signal?: AbortSignal): Promise<EndpointCheck> {
    if (hostOf(url) === undefined) return { ok: false, message: 'the endpoint address is not a URL' }
    const key = await this.keyFor(url, typed, ref)
    if (key === undefined) return { ok: false, message: 'no key yet' }
    try {
      // OpenRouter lists models to anyone; only its key endpoint says whether a key is real.
      if (serviceOf(url) === 'openrouter') {
        const response = await fetch(`${modelsBase(url)}/key`, { headers: { authorization: `Bearer ${key}` }, signal: signal ?? AbortSignal.timeout(20_000) })
        if (!response.ok) return { ok: false, message: response.status === 401 || response.status === 403 ? 'the key was refused' : `the endpoint answered ${response.status}` }
        return { ok: true }
      }
      const models = await listEndpointModels(url, 'text', key, signal)
      return { ok: true, models: models.length }
    } catch (error) {
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) return { ok: false, message: 'the key was refused' }
      // Plenty of working endpoints have no model list; that is not a reason to refuse the key.
      if (error instanceof ProviderError && error.status === 404) return { ok: true }
      return { ok: false, message: errorMessage(error) }
    }
  }

  /**
   * One-click setup: save the key, check it, and fill the chosen slots —
   * pictures, speech, search — with the service's recommended models. Text
   * models are not set here: they are DSH's. A key that is refused is not saved
   * and nothing is changed.
   */
  async applySetup(input: { service: ServiceId | 'codex'; key?: string; origin?: string; parts: SetupPart[] }): Promise<{ settings: NovelSettings; check: EndpointCheck }> {
    const done = { setup: { done: true, at: new Date().toISOString() } }
    if (input.service === 'codex') {
      const status = await this.codex()
      const ready = codexReady(status, undefined)
      const settings = await this.core.settings.update({ image: { provider: 'codex', size: '1536x1024', baseURL: null, model: null, apiKeyRef: null }, ...done } as DeepPartial<NovelSettings>)
      return { settings, check: ready ? { ok: true } : { ok: false, message: status.connect ? 'Codex Connect is installed but not signed in yet' : status.cli ? 'the Codex CLI is installed but not signed in yet' : 'neither Codex Connect nor the Codex CLI was found' } }
    }
    const origin = input.service === 'custom' ? input.origin?.trim() : originOf(input.origin) ?? SERVICES[input.service].origin
    const setup = recommendedSetup(input.service, origin)
    if (setup === undefined || origin === undefined || origin.length === 0) throw new ProjectError('novel/invalid', 'this service has no one-click setup; configure its slots one by one')
    const endpoint = compatibleBase(input.service, origin)
    const check = await this.checkEndpoint(endpoint, input.key)
    if (!check.ok) return { settings: await this.core.settings.get(), check }
    if (input.key !== undefined && input.key.trim().length > 0) await this.keys.save(endpoint, input.key)
    const patch = setupPatch(setup, input.parts)
    // A slot that used to read its key from a name now uses the one saved for the service.
    const settings = await this.core.settings.update({
      ...(patch.embedding !== undefined ? { embedding: { ...patch.embedding, apiKeyRef: null } } : {}),
      ...(patch.image !== undefined ? { image: { ...patch.image, apiKeyRef: null, bridge: null, quality: null } } : {}),
      ...(patch.tts !== undefined ? { tts: { ...patch.tts, apiKeyRef: null, designedVoiceModel: null, sampleRate: null, defaultVoices: null, ...(patch.tts.narratorVoice === undefined ? { narratorVoice: null } : {}) } } : {}),
      ...done,
    } as DeepPartial<NovelSettings>)
    return { settings, check }
  }
}

/** Whether the chosen way to a ChatGPT subscription is signed in. */
export function codexReady(codex: CodexStatus, bridge: NovelSettings['image']['bridge']): boolean {
  const connect = codex.connect && codex.connectSignedIn
  const cli = codex.cli && codex.cliSignedIn
  return bridge === 'connect' ? connect : bridge === 'cli' ? cli : connect || cli
}

/** The endpoint a provider kind talks to when its slot leaves the address empty. */
/** Whether pictures come from a service that is reached with a key. */
function keyedImages(settings: NovelSettings): boolean {
  return !['none', 'codex', 'comfyui', 'diffusers'].includes(settings.image.provider)
}

function defaultEndpoint(provider: string): string | undefined {
  if (provider === 'dashscope' || provider === 'qwen-audiogen' || provider === 'qwen-realtime') return SERVICES.bailian.origin
  if (provider === 'openrouter') return compatibleBase('openrouter')
  if (provider === 'openai') return compatibleBase('openai')
  return undefined
}

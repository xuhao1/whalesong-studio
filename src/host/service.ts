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
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { randomBytes } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { NovelCore, type ProjectRuntime, type RemovedBook, type TaskContext } from '../core/core'
import { listEndpointModels, modelsBase } from '../core/media/discovery'
import { ProviderError } from '../core/media/http'
import { soundSetup } from '../core/media/sound'
import { attachReconciler } from '../core/reconcile'
import { readStub, VaultError } from '../core/util/vault'
import { createDeviceAuth, type DeviceAuth } from './device-auth'
import { ProjectError } from '../core/project'
import { SessionStateStore, type SwitchedBy } from '../core/session-state'
import { DEFAULT_SETTINGS, mergeSettings, SettingsStore, type DeepPartial } from '../core/settings'
import { errorMessage } from '../core/util/async'
import { displayPath, exists } from '../core/util/fs'
import type { CodexStatus, EndpointCheck, EndpointModel, KeyState, LockView, ModelKind, ShareStatus, WorkspaceInfo } from '../shared/rpc'
import { compatibleBase, hostOf, originOf, recommendedSetup, SERVICES, serviceOf, setupPatch, speechProtocol, UNLISTED_SPEECH, type ServiceId, type SetupPart } from '../shared/services'
import type { ModelRoute, NovelSettings, ProjectRef, WorkMode } from '../shared/types'
import { codexStatus, createCodexBridge } from './codex'
import { KeyStore } from './keys'
import { createHarnessLlm } from './llm-backend'
import { ShareServer } from './share'

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

export class NovelService extends Service {
  readonly core: NovelCore
  readonly sessions = new SessionStateStore()
  readonly keys: KeyStore
  /** The reader served to other devices on the local network; closed unless the author switched it on. */
  readonly share: ShareServer

  constructor(ctx: Context, config: NovelServiceConfig = {}) {
    super(ctx, 'novel')
    this.keys = new KeyStore(ctx, (message, error) => { this.log(message, error) })
    const defaults = config.settings !== undefined ? mergeSettings(structuredClone(DEFAULT_SETTINGS), config.settings) : DEFAULT_SETTINGS
    this.core = new NovelCore({
      llm: createHarnessLlm(ctx),
      credentials: this.keys,
      bridges: { codex: createCodexBridge(ctx) },
      settings: new SettingsStore(defaults),
      log: (message, error) => { this.log(message, error) },
    })
    // Files changed behind the Studio's back are noticed, recorded and digested again.
    attachReconciler(this.core)
    ctx.effect(() => () => { this.core.dispose() }, 'novel: studio engine')
    this.share = new ShareServer(this.core, (message, error) => { this.log(message, error) })
    ctx.effect(() => () => { void this.share.close().catch(() => {}) }, 'novel: reader for other devices')
    void this.core.ready()
      .catch((error: unknown) => { this.log('settings could not be loaded', error) })
      // Sharing that was on when the Harness last quit is on again when it starts.
      .then(() => this.share.apply())
      .catch(() => {})
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
    return { ...lock, device, deviceOn: lock.ways.some(way => way.kind === 'device' && way.id === this.deviceSlot()) }
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
      if (how.device !== true || this.device === undefined) throw new ProjectError('novel/invalid', 'give the password, or ask for this computer\'s own unlock')
      if (!stub.sealed.slots.some(slot => slot.kind === 'device' && slot.id === this.deviceSlot())) throw new ProjectError('novel/wrong-key', 'this book was not set up to open with this computer\'s unlock — use its password, then switch that on')
      const zh = this.locale().startsWith('zh')
      const confirmed = await this.device.confirm(zh ? `解锁《${stub.title}》` : `unlock "${stub.title}"`, signal)
      if (!confirmed) throw new ProjectError('novel/wrong-key', 'the system did not confirm that it is you')
      const secret = await this.device.load(stub.id)
      if (secret === undefined) throw new ProjectError('novel/wrong-key', 'the key this computer kept for the book is gone — use the password, then switch this computer\'s unlock on again')
      try {
        await this.core.unlockBook(root, { kind: 'device', id: this.deviceSlot(), secret })
      } finally {
        secret.fill(0)
      }
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

  // ───────────── projects per session ─────────────

  /**
   * The book in play for a session: the one bound to it, else the workspace's
   * only one. The conversation and the Studio beside it are both on this book.
   */
  async projectOfSession(sessionId: string, workspace?: string): Promise<ProjectRuntime | undefined> {
    const state = await this.sessions.get(sessionId)
    if (state.project !== undefined) {
      const bound = await this.core.tryRuntime(state.project)
      if (bound !== undefined) return bound
    }
    const cwd = workspace ?? await this.workspaceOfSession(sessionId)
    return cwd !== undefined ? await this.core.defaultProject(cwd) : undefined
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
    const shown = this.shown.get(agent.id)
    if (shown !== undefined) {
      const known = await this.core.tryRuntime(shown)
      if (known !== undefined) return known
    }
    const runtime = await this.projectOfAgent(agent)
    if (runtime !== undefined) return runtime
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
    const from = patch.project !== undefined && patch.project !== '' ? (await this.projectOfSession(sessionId))?.project.root : undefined
    const state = await this.sessions.update(sessionId, patch, { by, ...(from !== undefined ? { from } : {}) })
    if (by === 'agent' && state.project !== undefined && patch.project !== undefined) this.markShown(sessionId, state.project)
    return { mode: state.mode, ...(state.project !== undefined ? { project: state.project } : {}) }
  }

  // ───────────── tasks ─────────────

  /** Task context for work started by an agent's tool call. */
  agentTask(agent: Agent | undefined, signal: AbortSignal): TaskContext {
    const route = agent !== undefined ? this.routeOf(agent) : undefined
    return { origin: 'agent', signal, ...(route !== undefined ? { agentRoute: route } : {}) }
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
      { url: settings.image.provider !== 'none' && settings.image.provider !== 'codex' ? settings.image.baseURL ?? defaultEndpoint(settings.image.provider) : undefined, ref: settings.image.apiKeyRef },
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
    for (const id of UNLISTED_SPEECH[service] ?? []) if (!listed.some(model => model.id === id)) listed.unshift({ id })
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
   * One-click setup: save the key, check it, and fill the chosen slots with
   * the service's recommended models. A key that is refused is not saved and
   * nothing is changed.
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
      ...(patch.models !== undefined ? { models: patch.models } : {}),
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
function defaultEndpoint(provider: string): string | undefined {
  if (provider === 'dashscope' || provider === 'qwen-audiogen' || provider === 'qwen-realtime') return SERVICES.bailian.origin
  if (provider === 'openrouter') return compatibleBase('openrouter')
  if (provider === 'openai') return compatibleBase('openai')
  return undefined
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The studio engine: owns open projects, their search indexes, settings, jobs
 * and provider factories. It has no knowledge of Cordis or HTTP — the Host
 * half wires it to the Harness, tests drive it directly.
 */
import { mkdir, rename, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { ModelRoute, NovelSettings, ProjectRef, TextRole } from '../shared/types'
import { chooseStrategy, packContext, type ContextPack, type PackOptions } from './context'
import { JobManager, type JobContext } from './jobs'
import { resolveRoute, type LlmBackend } from './llm'
import { createRoutedLlm } from './media/chat'
import { createEmbedder } from './media/embedding'
import type { KeySource } from './media/http'
import { createImageProvider, type ImageBridges, type ImageProvider } from './media/image'
import { meterEmbedder, meterImages, meterLlm, meterSpeech, UsageStore } from './usage'
import { hostOf } from '../shared/services'
import { createTtsProvider, type TtsProvider } from './media/tts'
import { BOOK_ENTRIES, MANIFEST_FILE, Project, ProjectError, type CreateProjectInput } from './project'
import { RetrievalIndex, type Embedder } from './retrieval'
import { DEFAULT_SETTINGS, resolveDshHome, SettingsStore } from './settings'
import { exists, listDir } from './util/fs'
import { moveToTrash, type Trashed } from './util/trash'

export interface CoreOptions {
  /** Models configured in the Harness; routes that name their own endpoint are called by the core itself. */
  llm: LlmBackend
  /** Where the keys of endpoints come from. */
  credentials: KeySource
  /** Capabilities only the Host can provide (a ChatGPT subscription's image generation). */
  bridges?: ImageBridges
  settings?: SettingsStore
  /** Where calls to models are counted; a store under the Harness home by default. */
  usage?: UsageStore
  /** Diagnostic sink; the Host forwards it to the Harness logger. */
  log?: (message: string, error?: unknown) => void
  /** Where removed books go: the system trash by default, `null` for none (they then go to `holding`). */
  trash?: { files: string; info?: string } | null
  /** Where removed books go when the trash cannot take them; a folder under the Harness home by default. */
  holding?: string
}

/** What became of a book that was removed. */
export interface RemovedBook extends Trashed {
  title: string
  /** Entries of the folder that were not the book's own and were left where they were. */
  left: string[]
  /** The folder the book was in is gone too (it held nothing else). */
  folderRemoved: boolean
}

export interface ProjectRuntime {
  project: Project
  index: RetrievalIndex
}

/** Who started a task and how it reports back. */
export interface TaskContext {
  origin: 'agent' | 'user'
  signal?: AbortSignal
  /** Model of the calling agent; stands in for unconfigured roles. */
  agentRoute?: ModelRoute
  /** Set when the task runs as an observable job. */
  job?: JobContext
}

export class NovelCore {
  readonly jobs = new JobManager()
  readonly settings: SettingsStore
  readonly llm: LlmBackend
  readonly credentials: KeySource
  private readonly runtimes = new Map<string, Promise<ProjectRuntime | undefined>>()
  /** Manifest id → root of every project opened in this process; lets URLs name a project without its path. */
  /** Every call to a model, counted. */
  readonly usage: UsageStore
  private readonly rootsById = new Map<string, string>()
  private snapshot: NovelSettings = DEFAULT_SETTINGS
  private embedderCache: { key: string; value: Embedder | undefined } | undefined
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: CoreOptions) {
    this.credentials = options.credentials
    this.usage = options.usage ?? new UsageStore(undefined, options.log)
    this.llm = meterLlm(createRoutedLlm(options.llm, options.credentials), (event) => { this.usage.record(event) })
    this.settings = options.settings ?? new SettingsStore()
    this.unsubscribe = this.settings.onChange(() => { void this.refreshSettings() })
  }

  /** Load settings once before first use. */
  async ready(): Promise<void> {
    await this.refreshSettings()
  }

  private async refreshSettings(): Promise<void> {
    try {
      this.snapshot = await this.settings.get()
      this.embedderCache = undefined
    } catch (error) {
      this.log('failed to load settings', error)
    }
  }

  log(message: string, error?: unknown): void {
    this.options.log?.(message, error)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.jobs.cancelAll()
    for (const pending of this.runtimes.values()) {
      void pending.then(runtime => runtime?.project.dispose(), () => {})
    }
    this.runtimes.clear()
  }

  // ───────────── projects ─────────────

  /** Open the project at `root`, or undefined when the directory holds none. */
  async tryRuntime(root: string): Promise<ProjectRuntime | undefined> {
    const key = resolve(root)
    let pending = this.runtimes.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const project = await Project.open(key)
        if (project === undefined) return undefined
        this.rootsById.set((await project.manifest()).id, key)
        return { project, index: new RetrievalIndex(project, () => this.embedder()) }
      })()
      this.runtimes.set(key, pending)
      // A directory without a project today may get one tomorrow: do not cache the miss.
      pending.then((runtime) => { if (runtime === undefined && this.runtimes.get(key) === pending) this.runtimes.delete(key) }, () => { this.runtimes.delete(key) })
    }
    return await pending
  }

  async runtime(root: string): Promise<ProjectRuntime> {
    const runtime = await this.tryRuntime(root)
    if (runtime === undefined) throw new ProjectError('novel/no-project', `no novel project in ${root} — create one first (novel_init, or "New project" in Novel Studio)`)
    return runtime
  }

  async create(root: string, input: CreateProjectInput): Promise<ProjectRuntime> {
    const key = resolve(root)
    const project = await Project.create(key, input)
    const runtime: ProjectRuntime = { project, index: new RetrievalIndex(project, () => this.embedder()) }
    this.runtimes.set(key, Promise.resolve(runtime))
    this.rootsById.set((await project.manifest()).id, key)
    return runtime
  }

  /**
   * Take a book away: everything that is the book's own is gathered into one
   * folder and moved to the trash, from where it can be put back. Whatever else
   * lies in the book's folder is the author's and stays; the folder itself goes
   * only when nothing is left in it and nobody else relies on it.
   * @param keepFolder - the folder is more than this book's (a workspace root): never remove it.
   * @throws ProjectError `novel/no-project` when there is no book at `root`.
   */
  async removeBook(root: string, keepFolder: boolean): Promise<RemovedBook> {
    const key = resolve(root)
    const runtime = await this.runtime(key)
    const manifest = await runtime.project.manifest()
    for (const job of this.jobs.list(key)) if (job.status === 'running') this.jobs.cancel(job.id)
    // Nothing may be writing into the book while it is carried off.
    runtime.project.dispose()
    this.runtimes.delete(key)
    this.rootsById.delete(manifest.id)
    // The author's own clock: this name is what they will look for in the trash.
    const now = new Date()
    const two = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`
    const label = `${manifest.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60) || 'novel'} (Novel Studio ${stamp})`
    // Gathered beside where it was first, so the move to the trash is one step that either happens or does not.
    const bundle = join(key, `.${label}`)
    await mkdir(bundle)
    const moved: string[] = []
    try {
      for (const entry of BOOK_ENTRIES) {
        if (!(await exists(join(key, entry)))) continue
        await rename(join(key, entry), join(bundle, entry))
        moved.push(entry)
      }
    } catch (error) {
      // Put back what was already gathered: a book is removed whole or not at all.
      for (const entry of moved) await rename(join(bundle, entry), join(key, entry)).catch(() => {})
      await rmdir(bundle).catch(() => {})
      throw error
    }
    const visible = join(dirname(bundle), label)
    const staged = await rename(bundle, visible).then(() => visible, () => bundle)
    const trashed = await moveToTrash(staged, {
      holding: this.options.holding ?? join(resolveDshHome(), 'novel-writer', 'removed'),
      ...(this.options.trash !== undefined ? { trash: this.options.trash } : {}),
    })
    const left = (await listDir(key)).filter(name => trashed.where !== 'beside' || name !== basename(staged))
    let folderRemoved = false
    if (!keepFolder && left.length === 0 && trashed.where !== 'beside') {
      // Only an empty folder can be removed this way; anything in it keeps it.
      folderRemoved = await rmdir(key).then(() => true, () => false)
    }
    return { ...trashed, title: manifest.title, left, folderRemoved }
  }

  /** The open project with this manifest id. */
  async runtimeById(id: string): Promise<ProjectRuntime | undefined> {
    const root = this.rootsById.get(id)
    return root !== undefined ? await this.tryRuntime(root) : undefined
  }

  /** Projects reachable from a workspace: the directory itself, then its direct children. */
  async discover(workspace: string): Promise<ProjectRef[]> {
    const base = resolve(workspace)
    const refs: ProjectRef[] = []
    const consider = async (root: string): Promise<void> => {
      if (!(await exists(join(root, MANIFEST_FILE)))) return
      try {
        const runtime = await this.tryRuntime(root)
        if (runtime === undefined) return
        const manifest = await runtime.project.manifest()
        const cover = await runtime.project.cover()
        refs.push({ root, title: manifest.title, relative: relative(base, root) || '.', id: manifest.id, ...(cover !== undefined ? { cover } : {}) })
      } catch (error) {
        this.log(`skipping unreadable project at ${root}`, error)
      }
    }
    await consider(base)
    for (const name of await listDir(base)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const child = join(base, name)
      try {
        if ((await stat(child)).isDirectory()) await consider(child)
      } catch {
        // unreadable entries are simply not projects
      }
    }
    return refs
  }

  /**
   * The project a workspace works on by default: the workspace root when it is
   * a project, else the only project below it.
   */
  async defaultProject(workspace: string): Promise<ProjectRuntime | undefined> {
    const direct = await this.tryRuntime(workspace)
    if (direct !== undefined) return direct
    const refs = await this.discover(workspace)
    return refs.length === 1 ? await this.tryRuntime(refs[0]!.root) : undefined
  }

  /** A directory name for a new project titled `title` under `workspace`. */
  async suggestRoot(workspace: string, title: string): Promise<string> {
    const base = resolve(workspace)
    const entries = (await listDir(base)).filter(name => !name.startsWith('.'))
    // An empty workspace becomes the project itself; otherwise the book gets its own folder.
    if (entries.length === 0) return base
    const clean = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'novel'
    let candidate = join(base, clean)
    for (let n = 2; await exists(candidate); n++) candidate = join(base, `${clean}-${n}`)
    return candidate
  }

  describe(root: string): string {
    return basename(root)
  }

  // ───────────── models & providers ─────────────

  currentSettings(): NovelSettings {
    return this.snapshot
  }

  async route(role: TextRole, runtime: ProjectRuntime | undefined, task?: Pick<TaskContext, 'agentRoute'>): Promise<ModelRoute> {
    const settings = await this.settings.get()
    const manifest = runtime !== undefined ? await runtime.project.manifest() : undefined
    const route = resolveRoute(role, settings, this.llm, {
      ...(manifest !== undefined ? { manifest } : {}),
      ...(task?.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}),
    })
    // The call this route is for says which role and book it serves, so the ledger can tell them apart.
    return { ...route, for: { role, ...(runtime !== undefined ? { book: runtime.project.root } : {}), ...(manifest !== undefined ? { title: manifest.title } : {}) } }
  }

  embedder(): Embedder | undefined {
    const settings = this.snapshot.embedding
    const key = JSON.stringify(settings)
    if (this.embedderCache?.key !== key) {
      const embedder = createEmbedder(settings, this.credentials)
      this.embedderCache = {
        key,
        value: embedder !== undefined ? meterEmbedder(embedder, settings.model ?? 'embedding', hostOf(settings.baseURL) ?? settings.provider, (event) => { this.usage.record(event) }) : undefined,
      }
    }
    return this.embedderCache.value
  }

  /** @param runtime - the book the pictures are for, so the ledger files them under it. */
  async imageProvider(runtime?: ProjectRuntime): Promise<ImageProvider | undefined> {
    const provider = createImageProvider((await this.settings.get()).image, this.credentials, this.options.bridges)
    return provider !== undefined ? meterImages(provider, (event) => { this.usage.record(event) }, await this.bookTag(runtime)) : undefined
  }

  /** @param runtime - the book the voices are for, so the ledger files them under it. */
  async ttsProvider(runtime?: ProjectRuntime): Promise<TtsProvider | undefined> {
    const settings = (await this.settings.get()).tts
    const provider = createTtsProvider(settings, this.credentials)
    return provider !== undefined ? meterSpeech(provider, settings.model ?? settings.provider, (event) => { this.usage.record(event) }, await this.bookTag(runtime)) : undefined
  }

  private async bookTag(runtime: ProjectRuntime | undefined): Promise<{ root: string; title: string } | undefined> {
    if (runtime === undefined) return undefined
    return { root: runtime.project.root, title: (await runtime.project.manifest()).title }
  }

  // ───────────── context ─────────────

  /** Pack context for a task with the configured strategy and the model's window in mind. */
  async pack(runtime: ProjectRuntime, route: ModelRoute, options: Omit<PackOptions, 'budgetTokens' | 'strategy' | 'tailChars'> & { budgetTokens?: number }): Promise<ContextPack> {
    const settings = (await this.settings.get()).context
    let window: number | undefined
    try {
      window = await this.llm.contextWindow(route)
    } catch {
      window = undefined
    }
    const base = options.budgetTokens ?? settings.budgetTokens
    // The budget is already held to what the window leaves room for.
    const chosen = await chooseStrategy(runtime.project, settings.strategy, base, window, options.chapter?.index)
    return await packContext(runtime.project, runtime.index, {
      ...options,
      strategy: chosen.strategy,
      budgetTokens: chosen.budgetTokens,
      tailChars: settings.tailChars,
    })
  }
}

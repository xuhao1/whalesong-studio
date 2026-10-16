// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The studio engine: owns open projects, their search indexes, settings, jobs
 * and provider factories. It has no knowledge of Cordis or HTTP — the Host
 * half wires it to the Harness, tests drive it directly.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, rename, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { imageParallel, imageService, imageWays, localImages, ttsService, ttsWays, withBook } from '../shared/images'
import { autoOf, parallelOf, TTS_SERVICE_KEYS, type AutoSet, type BookLock, type ImageSettings, type ModelRoute, type NovelSettings, type ProjectManifest, type ProjectRef, type TextRole, type TtsSettings } from '../shared/types'
import { contextBudgets, ownsChapter, packContext, type ContextPack, type PackOptions } from './context'
import { currentJob, JobManager, type JobContext } from './jobs'
import { resolveRoute, retrying, type LlmBackend } from './llm'
import type { RoleRunner } from './roles'
import { createRoutedLlm } from './media/chat'
import { createEmbedder } from './media/embedding'
import type { KeySource } from './media/http'
import { createImageProvider, type ImageBridges, type ImageProvider } from './media/image'
import { meterEmbedder, meterImages, meterLlm, meterSpeech, UsageStore } from './usage'
import { CallLog } from './calls'
import { hostOf } from '../shared/services'
import { estimateTokens } from '../shared/text'
import { createTtsProvider, type TtsProvider } from './media/tts'
import { createSoundProvider, soundSetup, type SoundProvider } from './media/sound'
import { BOOK_ENTRIES, MANIFEST_FILE, Project, ProjectError, type CreateProjectInput } from './project'
import { RetrievalIndex, type Embedder } from './retrieval'
import { DEFAULT_SETTINGS, resolveDshHome, SettingsStore } from './settings'
import { exists, listDir, readJson, writeJson } from './util/fs'
import { Gate, type GateKind, type GateOptions, type GateState } from './util/gate'
import { moveToTrash, type Trashed } from './util/trash'
import {
  dropOpen, newDrop, newKey, openWithPassword, openWithSecret, passwordSlot, readStub, SEALED_SUFFIX, SealedFiles, sealTree, secretSlot, unsealTree, VaultError, writeStub,
  type SealedStub, type SealSlot, type ShelfMark,
} from './util/vault'
import { PrivateShelf, type ShelfFile } from './shelf'

/** A stub's seal as it stands once nothing is being sealed or unsealed any more. */
function unpending(sealed: SealedStub['sealed']): SealedStub['sealed'] {
  const { pending: _pending, ...rest } = sealed
  return rest
}

export interface CoreOptions {
  /** Models configured in the Harness; routes that name their own endpoint are called by the core itself. */
  llm: LlmBackend
  /** Where the keys of endpoints come from. */
  credentials: KeySource
  /** Capabilities only the Host can provide (a ChatGPT subscription's image generation). */
  bridges?: ImageBridges
  /** Runs a role as an agent on the Harness's agent loop; absent where there is no such loop (tests without one, a bare core). */
  roles?: RoleRunner
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
  /** The conversation's agent that asked for the work, as the Host knows it: an agent a role starts becomes its child. */
  caller?: unknown
  /** Set when the task runs as an observable job. */
  job?: JobContext
}

/** What a trial is of: an image service or a speech setup other than the one in force, a model other than a role's own. */
export interface Trial {
  image?: Partial<ImageSettings>
  tts?: Partial<TtsSettings>
  routes?: Partial<Record<TextRole, ModelRoute>>
}

const trials = new AsyncLocalStorage<Trial>()

export class NovelCore {
  readonly jobs = new JobManager()
  readonly settings: SettingsStore
  readonly llm: LlmBackend
  /** Roles that work as agents, where the Host can run them. */
  readonly roles: RoleRunner | undefined
  readonly credentials: KeySource
  private readonly runtimes = new Map<string, Promise<ProjectRuntime | undefined>>()
  /** Manifest id → root of every project opened in this process; lets URLs name a project without its path. */
  /** Every call to a model, counted. */
  readonly usage: UsageStore
  /** Every call to a text model for a book, kept: what was sent, and what was said. */
  readonly calls: CallLog
  private readonly rootsById = new Map<string, string>()
  /** Keys of the sealed books that are unlocked right now. They live here and nowhere else, and go when the process does. */
  private readonly bookKeys = new Map<string, Buffer>()
  /** The private shelf: books not shown among the others until its password is given. */
  private readonly shelf: PrivateShelf
  /**
   * Sealed books that were opened by another device — its grant, or the
   * password typed on it — and by nobody at this computer. They can be served
   * to devices; to the Studio and the showrunner here they are still locked.
   */
  private readonly deviceOnly = new Set<string>()
  private snapshot: NovelSettings = DEFAULT_SETTINGS
  /**
   * How many requests of each kind are out at once — over every job, whoever
   * started it. The numbers are the author's; a gate slows down by itself when
   * its service pushes back, and says so.
   */
  private readonly gates: Record<GateKind, Gate> = {
    text: new Gate('text', parallelOf(undefined)),
    speech: new Gate('speech', parallelOf(undefined)),
    image: new Gate('image', parallelOf(undefined)),
    sound: new Gate('sound', parallelOf(undefined)),
  }
  /** Gates of services that are not the Studio's own for their kind (a book's, one on trial), by what they are. */
  private readonly sideGates = new Map<string, Gate>()
  /** Embedders by the setup they were made for: the Studio's, and each book's own. */
  private readonly embedders = new Map<string, { value: Embedder | undefined }>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: CoreOptions) {
    this.credentials = options.credentials
    this.usage = options.usage ?? new UsageStore(undefined, options.log)
    // Made again when a call fails the way calls do in passing; every attempt is a call, and is counted as one.
    this.calls = new CallLog({
      jobs: this.jobs,
      settings: () => this.snapshot,
      book: async root => (await this.tryRuntime(root).catch(() => undefined))?.project,
      log: (message, error) => { this.log(message, error) },
    })
    // …and kept as one: what a call made again until it worked was sent, and what it said in the end.
    this.llm = this.calls.wrap(retrying(meterLlm(createRoutedLlm(options.llm, options.credentials), (event) => { this.usage.record(event) })))
    this.roles = options.roles
    this.settings = options.settings ?? new SettingsStore()
    this.shelf = new PrivateShelf(join(this.settings.folder, 'private-shelf.json'))
    this.unsubscribe = this.settings.onChange(() => { void this.refreshSettings() })
    // A gate that slows down or picks up again is something whoever watches the jobs should see.
    for (const gate of Object.values(this.gates)) gate.onChange(() => { this.jobs.touch() })
  }

  /** Load settings once before first use. */
  async ready(): Promise<void> {
    await this.refreshSettings()
  }

  private async refreshSettings(): Promise<void> {
    try {
      this.snapshot = await this.settings.get()
      // A key changed is a setup changed: every embedder is made again when next asked for.
      this.embedders.clear()
      this.gates.text.setCeiling(parallelOf(this.snapshot.textConcurrency))
      this.gates.speech.setCeiling(parallelOf(this.snapshot.tts.concurrency))
      // A server of the author's own draws one picture at a time, whatever number is set.
      this.gates.image.setCeiling(imageParallel(this.snapshot.image))
      this.gates.sound.setCeiling(parallelOf(this.snapshot.sound?.concurrency))
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
    for (const key of this.bookKeys.values()) key.fill(0)
    this.bookKeys.clear()
    this.deviceOnly.clear()
    for (const pending of this.runtimes.values()) {
      void pending.then(runtime => runtime?.project.dispose(), () => {})
    }
    this.runtimes.clear()
  }

  /**
   * A core that was taken down opens no book. Whatever of the Host half it belonged to is still on its way when
   * that half is replaced — a request being answered, a timer — would otherwise open the book anew, and with it a
   * watcher nobody closes: one that takes every write of the half that came after for a change from outside.
   * @throws ProjectError `novel/replaced`.
   */
  private alive(): void {
    if (this.disposed) throw new ProjectError('novel/replaced', 'this half of Whalesong Studio was replaced by a newer one while it worked — ask again')
  }

  // ───────────── projects ─────────────

  /**
   * Open the project at `root`, or undefined when the directory holds none.
   * @param scope - `device`: asked for by the reader for other devices, which may read a book a device opened.
   * @throws ProjectError `novel/locked` for a sealed book that is locked — or open to devices only, for anyone else.
   */
  async tryRuntime(root: string, scope?: 'device'): Promise<ProjectRuntime | undefined> {
    this.alive()
    const key = resolve(root)
    if (scope !== 'device' && this.deviceOnly.has(key)) throw new ProjectError('novel/locked', `"${(await readStub(key))?.title ?? 'this book'}" is locked — its author unlocks it in Whalesong Studio`)
    let pending = this.runtimes.get(key)
    if (pending === undefined) {
      pending = (async () => {
        // A sealed book opens only with its key; without one this throws `novel/locked`.
        const project = await Project.open(key, this.bookKeys.get(key))
        if (project === undefined) return undefined
        // Taken down while the book was being opened: it is closed again, not kept.
        if (this.disposed) {
          project.dispose()
          return undefined
        }
        this.rootsById.set((await project.manifest()).id, key)
        const runtime: ProjectRuntime = { project, index: new RetrievalIndex(project, () => this.embedder(project)) }
        this.announce(runtime)
        return runtime
      })()
      this.runtimes.set(key, pending)
      // A directory without a project today may get one tomorrow: do not cache the miss.
      pending.then((runtime) => { if (runtime === undefined && this.runtimes.get(key) === pending) this.runtimes.delete(key) }, () => { this.runtimes.delete(key) })
    }
    return await pending
  }

  async runtime(root: string): Promise<ProjectRuntime> {
    const runtime = await this.tryRuntime(root)
    if (runtime === undefined) throw new ProjectError('novel/no-project', `no novel project in ${root} — create one first (novel_init, or "New project" in Whalesong Studio)`)
    return runtime
  }

  async create(root: string, input: CreateProjectInput): Promise<ProjectRuntime> {
    this.alive()
    const key = resolve(root)
    const project = await Project.create(key, input)
    const runtime: ProjectRuntime = { project, index: new RetrievalIndex(project, () => this.embedder(project)) }
    this.runtimes.set(key, Promise.resolve(runtime))
    this.rootsById.set((await project.manifest()).id, key)
    this.announce(runtime)
    return runtime
  }

  private readonly openers = new Set<(runtime: ProjectRuntime) => void>()

  /** Be told of every book this engine opens or creates from now on. */
  onRuntime(listener: (runtime: ProjectRuntime) => void): () => void {
    this.openers.add(listener)
    return () => { this.openers.delete(listener) }
  }

  private announce(runtime: ProjectRuntime): void {
    for (const listener of [...this.openers]) {
      try {
        listener(runtime)
      } catch (error) {
        this.log('a listener for opened books failed', error)
      }
    }
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
    // A locked book can be taken off the shelf as it is: what goes to the trash is still sealed.
    const stub = await readStub(key)
    const locked = stub !== undefined && !this.bookKeys.has(key)
    const runtime = locked ? undefined : await this.runtime(key)
    const manifest = runtime !== undefined ? await runtime.project.manifest() : { id: stub!.id, title: stub!.title }
    for (const job of this.jobs.list(key)) if (job.status === 'running') this.jobs.cancel(job.id)
    // Nothing may be writing into the book while it is carried off.
    runtime?.project.dispose()
    this.runtimes.delete(key)
    this.rootsById.delete(manifest.id)
    this.bookKeys.get(key)?.fill(0)
    this.bookKeys.delete(key)
    this.deviceOnly.delete(key)
    // The author's own clock: this name is what they will look for in the trash.
    const now = new Date()
    const two = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`
    const label = `${manifest.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60) || 'novel'} (Whalesong Studio ${stamp})`
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

  // ───────────── sealed books ─────────────

  private readonly lockWatchers = new Set<(root: string) => void>()

  /** Be told whenever a book is locked, unlocked, sealed or unsealed. */
  onLock(listener: (root: string) => void): () => void {
    this.lockWatchers.add(listener)
    return () => { this.lockWatchers.delete(listener) }
  }

  private readonly lockPreparers = new Set<(root: string) => Promise<void>>()

  /**
   * Be given a moment before a book is locked, while its key is still at hand:
   * whatever has to go under the seal with it can be put there and checked.
   * A preparer that fails does not keep the book open.
   */
  onBeforeLock(listener: (root: string) => Promise<void>): () => void {
    this.lockPreparers.add(listener)
    return () => { this.lockPreparers.delete(listener) }
  }

  private async prepareLock(root: string): Promise<void> {
    for (const listener of [...this.lockPreparers]) {
      try {
        await listener(root)
      } catch (error) {
        this.log('preparing a book for locking failed', error)
      }
    }
  }

  private lockChanged(root: string): void {
    for (const listener of [...this.lockWatchers]) {
      try {
        listener(root)
      } catch (error) {
        this.log('a listener for locked books failed', error)
      }
    }
  }

  /** How a book is locked: whether it is sealed at all, whether it is open now, and the ways it opens. */
  async lockOf(root: string): Promise<BookLock> {
    const key = resolve(root)
    const stub = await readStub(key)
    if (stub === undefined) return { sealed: false, locked: false, ways: [] }
    const mark = stub.sealed.shelf
    // A book of the private shelf is not named while that shelf is closed.
    const hidden = mark !== undefined && this.shelf.held()?.id !== mark.id && !this.bookKeys.has(key)
    return {
      sealed: true,
      locked: !this.bookKeys.has(key) || this.deviceOnly.has(key),
      title: hidden ? '' : stub.title,
      ...(mark !== undefined ? { shelf: { own: mark.own === true } } : {}),
      ways: stub.sealed.slots.map(slot => ({ kind: slot.kind, ...(slot.id !== undefined ? { id: slot.id } : {}), ...(slot.label !== undefined ? { label: slot.label } : {}), ...(slot.at !== undefined ? { at: slot.at } : {}) })),
    }
  }

  /** The key of a sealed book that is open now; for adding another way to open it. */
  keyOf(root: string): Buffer | undefined {
    return this.bookKeys.get(resolve(root))
  }

  /** Close a book's runtime so nothing reads or writes its files while they are being changed underneath. */
  private async release(key: string): Promise<void> {
    // Everything running on the book stops — except the job doing this very work.
    const self = currentJob()?.id
    for (const job of this.jobs.list(key)) if (job.status === 'running' && job.id !== self) this.jobs.cancel(job.id)
    const pending = this.runtimes.get(key)
    this.runtimes.delete(key)
    const runtime = await pending?.catch(() => undefined)
    runtime?.project.dispose()
  }

  /**
   * Do something to a book's files that nothing else may watch: its runtime is
   * closed, and whoever asks for the book meanwhile waits and gets it as it is
   * afterwards — never a book half sealed.
   */
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    await this.release(key)
    let finish!: (runtime: ProjectRuntime | undefined | Promise<ProjectRuntime | undefined>) => void
    const gate = new Promise<ProjectRuntime | undefined>((resolve) => { finish = resolve })
    // Nobody may be waiting; a book that ends up locked must not count as an unhandled failure.
    gate.catch(() => {})
    this.runtimes.set(key, gate)
    try {
      return await work()
    } finally {
      if (this.runtimes.get(key) === gate) this.runtimes.delete(key)
      const fresh = this.tryRuntime(key)
      fresh.catch(() => {})
      finish(fresh)
      this.lockChanged(key)
    }
  }

  /**
   * Seal a book: every file of it is encrypted where it lies, under a new key
   * that `password` opens. The book stays open in this process afterwards.
   * @param label - the name the shelf shows while the book is locked. Default: its title.
   * @throws ProjectError `novel/invalid` when the book is sealed already; VaultError `weak` for a password too short.
   */
  async sealBook(root: string, input: { password: string; label?: string }, onProgress?: (done: number) => void): Promise<{ files: number }> {
    const key = resolve(root)
    if (await readStub(key) !== undefined) throw new ProjectError('novel/invalid', 'this book is sealed already')
    const manifest = await readJson<ProjectManifest>(join(key, MANIFEST_FILE))
    if (manifest === undefined) throw new ProjectError('novel/no-project', `no novel project in ${root}`)
    const bookKey = newKey()
    const slot = await passwordSlot(input.password, bookKey)
    return await this.sealUnder(key, manifest, bookKey, [slot], input.label, undefined, onProgress)
  }

  /** Put a plain book's files under a key: what `sealBook` and a private shelf both do, each with its own way of opening it. */
  private async sealUnder(key: string, manifest: ProjectManifest, bookKey: Buffer, slots: SealSlot[], label: string | undefined, shelf: ShelfMark | undefined, onProgress?: (done: number) => void): Promise<{ files: number }> {
    return await this.exclusive(key, async () => {
      // The key is put in safekeeping before the first file is sealed with it: the manifest goes under the seal, then
      // `novel.json` says the book is sealed and how it opens. Cut off after this point, the work is finished at the next unlock.
      const store = new SealedFiles(key, bookKey)
      await store.writeJson(join(key, MANIFEST_FILE), manifest)
      // With the drop, what is not the Studio's own to encrypt — the conversations about the book — can be put under the seal while it is locked.
      const drop = newDrop(bookKey)
      const sealed = { v: 1 as const, slots, drop, ...(shelf !== undefined ? { shelf } : {}) }
      const stub: SealedStub = { schema: 1, id: manifest.id, title: label?.trim() || manifest.title, sealed: { ...sealed, pending: true } }
      await writeStub(key, stub)
      const files = await sealTree(key, BOOK_ENTRIES, bookKey, onProgress)
      await writeStub(key, { ...stub, sealed })
      this.bookKeys.set(key, bookKey)
      return { files: files + 1 }
    })
  }

  // ───────────── the private shelf ─────────────

  /** How the private shelf stands: whether one was set up here, and whether it is open now. */
  async shelfState(): Promise<{ set: boolean; open: boolean; /** Which shelf it is. */ id?: string; /** The keepers of its other ways in (`host:…`). */ devices: string[] }> {
    const file = await this.shelf.file()
    return { set: file !== undefined, open: file !== undefined && this.shelf.open, ...(file !== undefined ? { id: file.id } : {}), devices: (file?.ways ?? []).filter(way => way.kind === 'device' && way.id !== undefined).map(way => way.id!) }
  }

  /** Open the private shelf by a secret its keeper holds (this computer's own unlock). @throws VaultError `wrong-key`. */
  async openShelfWith(kind: 'device', id: string, secret: Buffer): Promise<void> {
    await this.shelf.unlockWith(kind, id, secret)
  }

  /** Let a keeper's secret open the private shelf, which must be open; or stop letting it. */
  async shelfWay(change: { add: (key: Buffer) => SealSlot } | { remove: { kind: 'device'; id: string } }): Promise<void> {
    if ('add' in change) {
      if (!this.shelf.open) throw new ProjectError('novel/locked', 'open the private shelf first')
      await this.shelf.allow(change.add)
    } else await this.shelf.forbid(change.remove.kind, change.remove.id)
  }

  /** The books under these folders that stand on a private shelf — any shelf, open or not: read off their stubs alone. */
  async shelved(workspaces: readonly string[]): Promise<string[]> {
    const roots: string[] = []
    for (const workspace of workspaces) {
      const base = resolve(workspace)
      const folders = [base, ...(await listDir(base).catch(() => [] as string[])).filter(name => !name.startsWith('.') && name !== 'node_modules').map(name => join(base, name))]
      for (const folder of folders) if ((await readStub(folder).catch(() => undefined))?.sealed.shelf !== undefined && !roots.includes(folder)) roots.push(folder)
    }
    return roots
  }

  /**
   * Set the private shelf up, open. Books among `roots` that stand on a shelf whose file is gone are on it again
   * where the password is that shelf's (a book carries what it takes).
   * @throws VaultError `weak`; ProjectError `novel/invalid` where there is a shelf already.
   */
  async setupShelf(password: string, roots: readonly string[] = []): Promise<void> {
    if (await this.shelf.file() !== undefined) throw new ProjectError('novel/invalid', 'a private shelf is set up here already')
    const carried: ShelfFile[] = []
    for (const root of roots) {
      const mark = (await readStub(resolve(root)))?.sealed.shelf
      if (mark?.slot !== undefined && !carried.some(file => file.id === mark.id)) carried.push({ schema: 1, id: mark.id, slot: mark.slot })
    }
    await this.shelf.setup(password, carried)
  }

  /** @throws VaultError `wrong-key`. */
  async openShelf(password: string): Promise<void> {
    await this.shelf.unlock(password)
  }

  /** Close the private shelf: every book on it that is open is locked, and the shelf's key forgotten. */
  async closeShelf(): Promise<void> {
    const held = this.shelf.held()
    if (held !== undefined) {
      for (const key of [...this.bookKeys.keys()]) {
        if ((await readStub(key))?.sealed.shelf?.id === held.id) await this.lockBook(key)
      }
    }
    this.shelf.lock()
  }

  /** Another password for the private shelf. Books on it that are within reach (`roots`) carry the new one from now on. */
  async rekeyShelf(password: string, next: string, roots: readonly string[] = []): Promise<void> {
    const file = await this.shelf.change(password, next)
    for (const root of roots) {
      const key = resolve(root)
      const stub = await readStub(key)
      if (stub?.sealed.shelf?.id === file.id && stub.sealed.shelf.slot !== undefined) await writeStub(key, { ...stub, sealed: { ...stub.sealed, shelf: { ...stub.sealed.shelf, slot: file.slot } } })
    }
  }

  /**
   * Put a book on the private shelf. A plain book is sealed for it — under the shelf's key, or under a password of
   * its own (`own`) where it is to ask for one besides. A book that is sealed already (and unlocked) keeps its seal:
   * the shelf's key is added to what opens it, unless it is to keep to its own password (`own: true`, or a new one).
   * @throws ProjectError `novel/locked` while the shelf is closed, or the book sealed and locked.
   */
  async shelveBook(root: string, how: { own?: string | true } = {}, onProgress?: (done: number) => void): Promise<{ files: number }> {
    const key = resolve(root)
    const held = this.shelf.held()
    if (held === undefined) throw new ProjectError('novel/locked', 'open the private shelf first')
    const stub = await readStub(key)
    const own = how.own !== undefined
    const mark: ShelfMark = own ? { id: held.id, own: true } : { id: held.id, slot: held.slot }
    if (stub === undefined) {
      const manifest = await readJson<ProjectManifest>(join(key, MANIFEST_FILE))
      if (manifest === undefined) throw new ProjectError('novel/no-project', `no novel project in ${root}`)
      if (how.own === true) throw new ProjectError('novel/invalid', 'a book that is to ask for a password of its own needs one')
      const bookKey = newKey()
      const slots = typeof how.own === 'string' ? [await passwordSlot(how.own, bookKey)] : [secretSlot('shelf', held.id, held.key, bookKey)]
      const done = await this.sealUnder(key, manifest, bookKey, slots, undefined, mark, onProgress)
      return done
    }
    const bookKey = this.bookKeys.get(key)
    if (bookKey === undefined) throw new ProjectError('novel/locked', 'unlock the book first')
    let slots = stub.sealed.slots.filter(slot => slot.kind !== 'shelf')
    if (typeof how.own === 'string') slots = [await passwordSlot(how.own, bookKey), ...slots.filter(slot => slot.kind !== 'password')]
    if (!own) slots = [...slots, secretSlot('shelf', held.id, held.key, bookKey)]
    if (own && !slots.some(slot => slot.kind === 'password')) throw new ProjectError('novel/invalid', 'a book that is to ask for a password of its own needs one')
    await writeStub(key, { ...stub, sealed: { ...unpending(stub.sealed), slots, shelf: mark } })
    this.lockChanged(key)
    return { files: 0 }
  }

  /**
   * Take a book off the private shelf: it is shown among the others again. It stays sealed — by the password it
   * has, or by the one given here where the shelf's key was all that opened it.
   * @throws ProjectError `novel/locked` while it is locked; `novel/invalid` where it would be left with nothing to open it.
   */
  async unshelveBook(root: string, password?: string): Promise<void> {
    const key = resolve(root)
    const stub = await readStub(key)
    if (stub?.sealed.shelf === undefined) return
    const bookKey = this.bookKeys.get(key)
    if (bookKey === undefined) throw new ProjectError('novel/locked', 'unlock the book first')
    let slots = stub.sealed.slots.filter(slot => slot.kind !== 'shelf')
    if (password !== undefined && password.length > 0) slots = [await passwordSlot(password, bookKey), ...slots.filter(slot => slot.kind !== 'password')]
    if (!slots.some(slot => slot.kind === 'password')) throw new ProjectError('novel/invalid', 'off the shelf the book needs a password of its own: give it one, or take its seal off instead')
    const { shelf: _shelf, ...sealed } = unpending(stub.sealed)
    await writeStub(key, { ...stub, sealed: { ...sealed, slots } })
    this.lockChanged(key)
  }

  /**
   * Take the seal off: every file becomes a plain file again. The book has to be unlocked.
   * @throws ProjectError `novel/locked` when it is not.
   */
  async unsealBook(root: string, onProgress?: (done: number) => void): Promise<{ files: number; left: number }> {
    const key = resolve(root)
    const bookKey = this.bookKeys.get(key)
    const stub = await readStub(key)
    if (stub === undefined) throw new ProjectError('novel/invalid', 'this book is not sealed')
    if (bookKey === undefined) throw new ProjectError('novel/locked', 'unlock the book first')
    const store = new SealedFiles(key, bookKey)
    const manifest = await store.readJson<ProjectManifest>(join(key, MANIFEST_FILE))
    if (manifest === undefined) throw new ProjectError('novel/invalid', 'the sealed book has no manifest — it cannot be unsealed safely')
    return await this.exclusive(key, async () => {
      await writeStub(key, { ...stub, sealed: { ...stub.sealed, pending: true } })
      const result = await unsealTree(key, BOOK_ENTRIES, bookKey, onProgress)
      if (result.left > 0) {
        // Something would not open: nothing is lost, but the book cannot be called plain. What was opened goes back under the seal.
        await sealTree(key, BOOK_ENTRIES, bookKey)
        await writeStub(key, { ...stub, sealed: unpending(stub.sealed) })
        return { files: 0, left: result.left }
      }
      await writeJson(join(key, MANIFEST_FILE), manifest)
      await store.removePath(join(key, MANIFEST_FILE))
      this.bookKeys.delete(key)
      bookKey.fill(0)
      return { files: result.opened + 1, left: 0 }
    })
  }

  /**
   * Open a sealed book for this process: with its password, or with a secret
   * another keeper holds (this computer's credential store, a device's grant).
   * @throws VaultError `wrong-key`.
   */
  /**
   * @param scope - `device`: the book is opened for the reader on other devices only; at this computer it stays locked.
   */
  async unlockBook(root: string, how: { password: string } | { kind: 'device' | 'grant' | 'shelf'; id: string; secret: Buffer }, scope?: 'device'): Promise<void> {
    const key = resolve(root)
    const stub = await readStub(key)
    if (stub === undefined) return
    if (this.bookKeys.has(key)) {
      // Open already: the way offered is still checked, so "it opened" always means "that was right".
      if ('password' in how) await openWithPassword(stub, how.password)
      else openWithSecret(stub, how.kind, how.id, how.secret)
      // Opened by a device before, and now by its author at this computer: open here too.
      if (scope !== 'device' && this.deviceOnly.delete(key)) this.lockChanged(key)
      return
    }
    const bookKey = 'password' in how ? await openWithPassword(stub, how.password) : openWithSecret(stub, how.kind, how.id, how.secret)
    if (stub.sealed.pending === true) {
      // Sealing or unsealing was cut off last time: some files lie plain. They go under the seal before anything reads the book.
      await sealTree(key, BOOK_ENTRIES, bookKey)
      await writeStub(key, { ...stub, sealed: unpending(stub.sealed) })
    }
    // A book sealed before there was a drop gets one the first time it is opened.
    if (stub.sealed.drop === undefined) {
      const current = await readStub(key)
      if (current !== undefined && current.sealed.drop === undefined) await writeStub(key, { ...current, sealed: { ...current.sealed, drop: newDrop(bookKey) } })
    }
    this.bookKeys.set(key, bookKey)
    if (scope === 'device') this.deviceOnly.add(key)
    this.runtimes.delete(key)
    try {
      await this.tryRuntime(key, 'device')
    } catch (error) {
      this.bookKeys.delete(key)
      this.deviceOnly.delete(key)
      throw error
    }
    // To this computer nothing changed when a device opened the book for itself.
    if (scope !== 'device') this.lockChanged(key)
  }

  /** Lock a sealed book: its key is forgotten, and nothing of it can be read until it is unlocked again. */
  async lockBook(root: string): Promise<boolean> {
    const key = resolve(root)
    if (!this.bookKeys.has(key)) return false
    await this.release(key)
    await this.prepareLock(key)
    this.bookKeys.get(key)?.fill(0)
    this.bookKeys.delete(key)
    this.deviceOnly.delete(key)
    this.lockChanged(key)
    return true
  }

  /** The public half of a sealed book's drop: anything may be encrypted to it while the book is locked. */
  async dropOf(root: string): Promise<string | undefined> {
    return (await readStub(resolve(root)))?.sealed.drop?.publicKey
  }

  /**
   * Read what was put under a book's seal through its drop. The book has to be unlocked.
   * @throws ProjectError `novel/locked` when it is not; VaultError when the piece does not open.
   */
  async openDropped(root: string, blob: Uint8Array): Promise<Buffer> {
    const key = resolve(root)
    const bookKey = this.bookKeys.get(key)
    const drop = (await readStub(key))?.sealed.drop
    if (bookKey === undefined || drop === undefined) throw new ProjectError('novel/locked', 'unlock the book first')
    return dropOpen(drop, bookKey, blob)
  }

  /** Whether a sealed book is open for other devices only — locked as far as this computer goes. */
  openToDevicesOnly(root: string): boolean {
    return this.deviceOnly.has(resolve(root))
  }

  /** Lock every sealed book that is open (the author stepped away; the Harness is quitting). */
  async lockAll(): Promise<number> {
    const open = [...this.bookKeys.keys()]
    for (const key of open) await this.lockBook(key)
    // The private shelf with them: stepping away closes everything a password opened.
    this.shelf.lock()
    return open.length
  }

  /**
   * Change how a sealed, unlocked book opens: set a new password, or add or
   * remove another keeper's slot.
   */
  async rekeyBook(root: string, change: { password: string } | { add: SealSlot | ((key: Buffer) => SealSlot) } | { remove: { kind: SealSlot['kind']; id?: string } } | { label: string }): Promise<BookLock> {
    const key = resolve(root)
    const stub = await readStub(key)
    const bookKey = this.bookKeys.get(key)
    if (stub === undefined) throw new ProjectError('novel/invalid', 'this book is not sealed')
    if (bookKey === undefined) throw new ProjectError('novel/locked', 'unlock the book first')
    let slots = stub.sealed.slots
    let title = stub.title
    if ('password' in change) slots = [await passwordSlot(change.password, bookKey), ...slots.filter(slot => slot.kind !== 'password')]
    else if ('add' in change) {
      const slot = typeof change.add === 'function' ? change.add(bookKey) : change.add
      slots = [...slots.filter(existing => !(existing.kind === slot.kind && existing.id === slot.id)), slot]
    } else if ('remove' in change) {
      slots = slots.filter(slot => !(slot.kind === change.remove.kind && (change.remove.id === undefined || slot.id === change.remove.id)))
      if (!slots.some(slot => slot.kind === 'password' || slot.kind === 'shelf')) throw new ProjectError('novel/invalid', 'a sealed book always keeps a password: it is what opens it when everything else is gone')
    } else if (change.label.trim().length > 0) title = change.label.trim()
    await writeStub(key, { ...stub, title, sealed: { ...unpending(stub.sealed), slots } })
    return await this.lockOf(key)
  }

  /** A slot another keeper opens with a secret of 32 bytes; made here so the book's key never leaves the engine. */
  slotFor(kind: 'device' | 'grant', id: string, secret: Buffer, label?: string): (key: Buffer) => SealSlot {
    return key => secretSlot(kind, id, secret, key, label)
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
        const stub = await readStub(root)
        const mark = stub?.sealed.shelf
        const onShelf = mark !== undefined ? { private: true as const, ...(mark.own === true ? { own: true as const } : {}) } : {}
        if (mark !== undefined) {
          // A book of the private shelf: among the books only while that shelf is open — and opened by it, unless it keeps to a password of its own.
          const held = this.shelf.held()
          if (held === undefined || held.id !== mark.id) return
          if (!this.bookKeys.has(resolve(root)) && mark.own !== true) await this.unlockBook(root, { kind: 'shelf', id: held.id, secret: held.key }).catch((error: unknown) => { this.log(`the private shelf could not open the book at ${root}`, error) })
        }
        if (stub !== undefined && (!this.bookKeys.has(resolve(root)) || this.deviceOnly.has(resolve(root)))) {
          // Locked: on the shelf under the name its author chose to show, and nothing more.
          this.rootsById.set(stub.id, resolve(root))
          refs.push({ root, title: stub.title, relative: relative(base, root) || '.', id: stub.id, sealed: true, locked: true, ...onShelf })
          return
        }
        const runtime = await this.tryRuntime(root)
        if (runtime === undefined) return
        const manifest = await runtime.project.manifest()
        const cover = await runtime.project.cover()
        // What there is to read, hear and watch: the shelf leads straight to each. A book that cannot be counted is on the shelf all the same.
        const shows = await runtime.project.shows().catch(() => undefined)
        // A sealed book shows no cover on the shelf, open or not: what it holds is not for whoever glances at the shelf.
        refs.push({ root, title: manifest.title, relative: relative(base, root) || '.', id: manifest.id, ...(cover !== undefined && stub === undefined ? { cover } : {}), ...(shows !== undefined ? { shows } : {}), ...(stub !== undefined ? { sealed: true } : {}), ...onShelf })
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

  /**
   * What follows by itself for a book once text is written, changed or reviewed (`AUTO_KEYS`): the book's own
   * switches where it has them, the Studio's for the rest. Read where the work is about to start — a book whose
   * manifest cannot be read goes by the Studio's.
   */
  async autoFor(runtime: ProjectRuntime | undefined): Promise<AutoSet> {
    const book = runtime !== undefined ? await runtime.project.manifest().catch(() => undefined) : undefined
    return autoOf(this.snapshot, book)
  }

  /**
   * The settings as they hold for a book: the Studio's, with the book's own pictures, speech and sound where it has
   * them (`novel.json`) — and, inside a trial, with whatever the trial is of.
   */
  async settingsOf(runtime: ProjectRuntime | undefined): Promise<NovelSettings> {
    const settings = await this.settings.get()
    const held = runtime !== undefined ? withBook(settings, await runtime.project.manifest()) : settings
    const trial = trials.getStore()
    if (trial?.image === undefined && trial?.tts === undefined) return held
    // What is tried is the service; the author's ways with it — which picture leads, how the narrator reads — hold as they are.
    return {
      ...held,
      ...(trial.image !== undefined ? { image: { ...imageWays(held.image), ...imageService(trial.image) } as ImageSettings } : {}),
      ...(trial.tts !== undefined ? { tts: { ...ttsWays(held.tts), ...ttsService(trial.tts) } as TtsSettings } : {}),
    }
  }

  /** The image settings as they hold for a book; see {@link settingsOf}. */
  async imageOf(runtime: ProjectRuntime | undefined): Promise<NovelSettings['image']> {
    return (await this.settingsOf(runtime)).image
  }

  /**
   * Do a piece of work with another setup than the one in force — another image service, another model for a role —
   * to see what it makes of the same task. Whatever runs inside draws and writes with it; nothing is saved to the settings.
   */
  trial<T>(of: Trial, work: () => Promise<T>): Promise<T> {
    return trials.run(of, work)
  }

  async route(role: TextRole, runtime: ProjectRuntime | undefined, task?: Pick<TaskContext, 'agentRoute'>): Promise<ModelRoute> {
    const settings = await this.settings.get()
    const manifest = runtime !== undefined ? await runtime.project.manifest() : undefined
    const tried = trials.getStore()?.routes?.[role]
    const route = tried ?? resolveRoute(role, settings, this.llm, {
      ...(manifest !== undefined ? { manifest } : {}),
      ...(task?.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}),
    })
    // The call this route is for says which role and book it serves, so the ledger can tell them apart.
    return { ...route, for: { role, ...(runtime !== undefined ? { book: runtime.project.root } : {}), ...(manifest !== undefined ? { title: manifest.title } : {}) } }
  }

  /**
   * The model that looks at pictures for a role whose own model cannot: the book's where it names one, the Studio's
   * otherwise; none where neither does.
   */
  async visionRoute(runtime?: ProjectRuntime): Promise<ModelRoute | undefined> {
    const route = (await this.settingsOf(runtime)).vision
    if (route === undefined || route.provider.length === 0 || route.model.length === 0) return undefined
    const manifest = runtime !== undefined ? await runtime.project.manifest() : undefined
    return { provider: route.provider, model: route.model, ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}), for: { role: 'vision', ...(runtime !== undefined ? { book: runtime.project.root } : {}), ...(manifest !== undefined ? { title: manifest.title } : {}) } }
  }

  /**
   * What passages are embedded with: the Studio's endpoint, or — for a book that has retrieval of its own — the
   * book's. One embedder per setup, kept while the setup stands.
   */
  async embedder(project?: Project): Promise<Embedder | undefined> {
    const settings = (project !== undefined ? withBook(this.snapshot, await project.manifest().catch(() => undefined)) : this.snapshot).embedding
    const key = JSON.stringify(settings)
    let held = this.embedders.get(key)
    if (held === undefined) {
      const embedder = createEmbedder(settings, this.credentials)
      held = { value: embedder !== undefined ? meterEmbedder(embedder, settings.model ?? 'embedding', hostOf(settings.baseURL) ?? settings.provider, (event) => { this.usage.record(event) }) : undefined }
      this.embedders.set(key, held)
    }
    return held.value
  }

  // ───────────── how much at once ─────────────

  /**
   * The gate a kind of request goes through. Sound that rides on the speech
   * setup goes through the speech gate: both ask the same model, and it counts
   * them together.
   */
  gate(kind: GateKind): Gate {
    return kind === 'sound' && soundSetup(this.snapshot)?.shared === true ? this.gates.speech : this.gates[kind]
  }

  /** How many requests of a kind the author lets out at once, over every book that has no number of its own. */
  parallel(kind: GateKind): number {
    return this.gate(kind).ceiling
  }

  /**
   * The gate a book's requests of a kind go through. A book with a number of its own for the kind has a gate of its
   * own, which counts its requests alone; so has a service that is not the Studio's (a book's own, one on trial) — a
   * server that draws one picture at a time is asked for one, whatever the Studio's draws. Everything else goes
   * through the Studio's gates, where the work of every book is counted together.
   */
  async gateOf(kind: GateKind, runtime: ProjectRuntime | undefined): Promise<Gate> {
    if (runtime === undefined) return this.gate(kind)
    const settings = await this.settingsOf(runtime)
    const own = (await runtime.project.manifest()).parallel?.[kind]
    const book = { book: runtime.project.root }
    if (kind === 'text') return own !== undefined ? this.sideGate('text', book, parallelOf(own)) : this.gates.text
    if (kind === 'image') {
      const { concurrency: _mine, ...mine } = imageService(settings.image)
      const { concurrency: _main, ...main } = imageService(this.snapshot.image)
      const same = JSON.stringify(mine) === JSON.stringify(main)
      // A server of the author's own draws one picture at a time, whatever number is set.
      if (own !== undefined) return this.sideGate('image', same ? book : { ...book, ...mine }, localImages(settings.image) ? 1 : parallelOf(own))
      return same ? this.gates.image : this.sideGate('image', mine, imageParallel(settings.image))
    }
    if (kind === 'speech') {
      const service = (value: NovelSettings['tts']): object => Object.fromEntries(TTS_SERVICE_KEYS.filter(key => key !== 'narratorVoice' && key !== 'defaultVoices' && value[key] !== undefined).map(key => [key, value[key]]))
      const same = JSON.stringify(service(settings.tts)) === JSON.stringify(service(this.snapshot.tts))
      if (own !== undefined) return this.sideGate('speech', same ? book : { ...book, ...service(settings.tts) }, parallelOf(own))
      return same ? this.gates.speech : this.sideGate('speech', service(settings.tts), parallelOf(settings.tts.concurrency))
    }
    if (own !== undefined) return this.sideGate('sound', book, parallelOf(own))
    return soundSetup(settings)?.shared === true ? await this.gateOf('speech', runtime) : this.gates.sound
  }

  /** How many requests of a kind go out at once for a book: its own number where it has one, the Studio's otherwise. */
  async parallelFor(kind: GateKind, runtime: ProjectRuntime | undefined): Promise<number> {
    return (await this.gateOf(kind, runtime)).ceiling
  }

  /**
   * Make a request through its gate; the work of a batch waits behind whatever the author asked for by hand.
   * @param runtime - the book the request is for: one with a number of its own for the kind is counted apart.
   */
  async through<T>(kind: GateKind, task: (attempt: number) => Promise<T>, options: GateOptions = {}, runtime?: ProjectRuntime): Promise<T> {
    return await (await this.gateOf(kind, runtime)).run(task, { background: currentJob()?.kind === 'batch', ...options })
  }

  /** The gates that have something to say: work waiting at them, or a service pushing back. */
  gateStates(): Partial<Record<GateKind, GateState>> {
    const states: Partial<Record<GateKind, GateState>> = {}
    const telling = (state: GateState): boolean => state.active > 0 || state.waiting > 0 || state.limit < state.ceiling || state.pausedMs > 0
    for (const kind of Object.keys(this.gates) as GateKind[]) {
      // Shared with speech: said once, there.
      if (this.gate(kind) !== this.gates[kind]) continue
      const state = this.gates[kind].state()
      if (telling(state)) states[kind] = state
    }
    // A gate of a book's own, or of a service on the side, is heard where the Studio's of its kind has nothing to say — the one with the most waiting.
    for (const [key, gate] of this.sideGates) {
      const kind = key.slice(0, key.indexOf(':')) as GateKind
      const state = gate.state()
      if (!telling(state)) continue
      const said = states[kind]
      if (said === undefined || (said.waiting === 0 && said.limit >= said.ceiling && said.pausedMs === 0 && state.waiting + (state.limit < state.ceiling ? 1 : 0) > 0)) states[kind] = state
    }
    return states
  }

  /** A gate beside the Studio's own of its kind, by what it is for; made when first asked for, and kept at the number given. */
  private sideGate(kind: GateKind, what: object, ceiling: number): Gate {
    const key = `${kind}:${JSON.stringify(what)}`
    let gate = this.sideGates.get(key)
    if (gate === undefined) {
      gate = new Gate(kind, ceiling)
      gate.onChange(() => { this.jobs.touch() })
      this.sideGates.set(key, gate)
    }
    gate.setCeiling(ceiling)
    return gate
  }

  /**
   * The service pictures are drawn with for a book: its own where it has one, the Studio's otherwise (and, in a trial, the one tried).
   * @param runtime - the book the pictures are for, so the ledger files them under it.
   */
  async imageProvider(runtime?: ProjectRuntime): Promise<ImageProvider | undefined> {
    const settings = await this.imageOf(runtime)
    const provider = createImageProvider(settings, this.credentials, this.options.bridges)
    if (provider === undefined) return undefined
    const metered = meterImages(provider, (event) => { this.usage.record(event) }, await this.bookTag(runtime))
    const gate = await this.gateOf('image', runtime)
    const background = (): boolean => currentJob()?.kind === 'batch'
    return {
      kind: metered.kind,
      model: metered.model,
      generate: request => gate.run(() => metered.generate(request), { background: background(), ...(request.signal !== undefined ? { signal: request.signal } : {}) }),
      ...(metered.prompting !== undefined ? { prompting: async signal => await metered.prompting!(signal) } : {}),
    }
  }

  /**
   * The service that speaks for a book: its own where it has one, the Studio's otherwise.
   * @param runtime - the book the voices are for, so the ledger files them under it.
   */
  async ttsProvider(runtime?: ProjectRuntime): Promise<TtsProvider | undefined> {
    const settings = (await this.settingsOf(runtime)).tts
    const provider = createTtsProvider(settings, this.credentials)
    if (provider === undefined) return undefined
    const metered = meterSpeech(provider, settings.model ?? settings.provider, (event) => { this.usage.record(event) }, await this.bookTag(runtime))
    const gate = await this.gateOf('speech', runtime)
    const through = <T>(task: () => Promise<T>, options: GateOptions): Promise<T> => gate.run(task, { background: currentJob()?.kind === 'batch', ...options })
    const gated: TtsProvider = Object.create(metered) as TtsProvider
    gated.synthesize = request => through(() => metered.synthesize(request), {
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.onStart !== undefined ? { onStart: request.onStart } : {}),
    })
    if (metered.anchor !== undefined) {
      const anchor = metered.anchor.bind(metered)
      gated.anchor = (voice, options) => through(() => anchor(voice, options), options.signal !== undefined ? { signal: options.signal } : {})
    }
    if (metered.designVoice !== undefined) {
      const design = metered.designVoice.bind(metered)
      gated.designVoice = request => through(() => design(request), request.signal !== undefined ? { signal: request.signal } : {})
    }
    return gated
  }

  /** The model that makes effects, music and generated beds — by default the speech setup, when it can. */
  async soundProvider(runtime?: ProjectRuntime): Promise<SoundProvider | undefined> {
    const provider = createSoundProvider(await this.settingsOf(runtime), this.credentials)
    if (provider === undefined) return undefined
    const tag = await this.bookTag(runtime)
    const metered: SoundProvider = Object.create(provider) as SoundProvider
    const gate = await this.gateOf('sound', runtime)
    metered.generate = request => gate.run(async () => {
      const audio = await provider.generate(request)
      // Billed like speech — by the second — and filed with it.
      this.usage.record({ kind: 'speech', model: provider.model, via: provider.kind, chars: 0, seconds: Number((audio.pcm.length / audio.sampleRate).toFixed(2)), ...(tag !== undefined ? { book: tag.root, bookTitle: tag.title } : {}) })
      return audio
    }, { background: currentJob()?.kind === 'batch', ...(request.signal !== undefined ? { signal: request.signal } : {}) })
    return metered
  }

  private async bookTag(runtime: ProjectRuntime | undefined): Promise<{ root: string; title: string } | undefined> {
    if (runtime === undefined) return undefined
    // The usage ledger is kept outside the book, in the clear: a sealed book is entered there under the name its author chose for the shelf.
    const sealed = runtime.project.sealed ? await readStub(runtime.project.root) : undefined
    return { root: runtime.project.root, title: sealed?.title ?? (await runtime.project.manifest()).title }
  }

  // ───────────── context ─────────────

  /**
   * Pack context for a task: the manuscript's own text gets half of the
   * model's window (or the author's figure), spent in whole chapters.
   * @param options.limit - hold the whole pack to about this many tokens, for work that has to answer at once.
   */
  async pack(runtime: ProjectRuntime, route: ModelRoute, options: Omit<PackOptions, 'textBudget' | 'sideBudget' | 'tailChars'> & { limit?: number }): Promise<ContextPack> {
    const settings = (await this.settingsOf(runtime)).context
    const budgets = contextBudgets(settings.strategy, settings.budgetTokens, await this.windowOf(route), settings.sideTokens)
    const { limit, ...rest } = options
    let textBudget = limit !== undefined ? Math.min(budgets.textBudget, Math.floor(limit * 0.6)) : budgets.textBudget
    const sideBudget = limit !== undefined ? Math.min(budgets.sideBudget, Math.floor(limit * 0.4)) : budgets.sideBudget
    // The chapter that is revised or reviewed goes whole, beside these budgets: where the window is small, the other
    // chapters' text gives way to it — never the chapter to them. (What was chosen for the work goes as chosen:
    // whoever chose held it to a size.)
    if (rest.chosen === undefined && ownsChapter(rest) && rest.chapter !== undefined) {
      const own = estimateTokens(rest.chapterText ?? await runtime.project.chapterText(rest.chapter.plan.id))
      textBudget = Math.max(0, Math.min(textBudget, budgets.window - budgets.reserve - sideBudget - own))
    }
    return await packContext(runtime.project, runtime.index, { ...rest, textBudget, sideBudget, tailChars: settings.tailChars })
  }

  /**
   * About how much the material the planner chooses for a chapter's writing may come to: what the story's own text
   * may take when it is packed by rule, and never more than 120,000 tokens — it is chosen for one chapter, not carried
   * for the book.
   */
  async materialBudget(runtime: ProjectRuntime, route: ModelRoute): Promise<number> {
    const settings = (await this.settingsOf(runtime)).context
    const budgets = contextBudgets(settings.strategy, settings.budgetTokens, await this.windowOf(route), settings.sideTokens)
    return Math.max(8000, Math.min(120_000, budgets.textBudget > 0 ? budgets.textBudget : budgets.sideBudget))
  }

  /** The context window of the model behind a route, when it is known. */
  async windowOf(route: ModelRoute): Promise<number | undefined> {
    try {
      return await this.llm.contextWindow(route)
    } catch {
      return undefined
    }
  }
}

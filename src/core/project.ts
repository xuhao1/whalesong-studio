// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * One novel project on disk. The directory layout is the storage format:
 *
 *   novel.json                 manifest
 *   outline.json               volumes → chapters → beats, plus plot threads — and the lines
 *                              of the plot beside the main one, where the book has any
 *   bible/characters/<id>.md   character cards (YAML front matter + notes)
 *   bible/world/<id>.md        world entries
 *   bible/styles/<id>.md       style profiles
 *   manuscript/<chapter>.md    chapter prose, nothing but prose
 *   assets/                    generated images and audio
 *   .novel/                    machine memory: digests, versions, proposals, scripts, index
 *
 * Every write is atomic and bumps the project revision that the UI long-polls on.
 * Files edited by hand or by other tools are picked up through a directory watch.
 */
import { watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import {
  analysisSteps, type AnalyzeStep,
  castOrder, chapterBudgetOf, MAIN_LINE,
  type ActivityEntry, type BookShows, type CharacterLook, type CharacterMoment, type ShowCount,
  type AudioScript, type CastPresence, type ChapterInfo, type ChapterMemory, type ChapterPlan, type ChapterReview, type ChapterStatus, type CharacterCard,
  type ComicBoard, type IllustrationInfo, type Outline, type PlaySession, type PlotLine, type PlotLineInfo, type PlotLineOrigin, type PlotThread, type ProjectManifest, type ProjectState, type ProjectStats, type Proposal, type RemovedChapter,
  type StyleProfile, type Suggestion, type VersionInfo, type VoiceCast, type Volume, type WorldEntry,
} from '../shared/types'
import { lifeOf, statusAt, type Life } from '../shared/life'
import type { LinePerson, LineThread, LineWorld } from '../shared/worldline'
import { TIE_ENDS, TIE_KINDS, type Tie, type TieEnd } from '../shared/ties'
import { worldPresence, type WorldPresence } from '../shared/world'
import { countWords, hashText, newId, normalizeProse, proseOnly, sameName, slugify } from '../shared/text'
import { KeyedMutex } from './util/async'
import {
  containedPath, ensureDir, exists, listDir, mtimeOf, readJson, readText, relativePosix, removePath, writeAtomic, writeJson,
} from './util/fs'
import { parseFrontMatter, renderFrontMatter } from './util/frontmatter'
import { PlainFiles, readStub, SealedFiles, type FileStore } from './util/vault'

export const MANIFEST_FILE = 'novel.json'
const OUTLINE_FILE = 'outline.json'
/** The ties between the things of the book's world, kept with the bible. */
const TIES_FILE = 'relations.json'
/** Chapters taken out of the book, kept so they can be put back. */
const REMOVED_FILE = 'removed.json'
const STATE_DIR = '.novel'
/** Everything in a project folder that is the book's own. Whatever else sits beside it is the author's and is never touched. */
export const BOOK_ENTRIES = ['novel.json', 'outline.json', 'bible', 'manuscript', 'assets', 'export', STATE_DIR] as const

export interface CreateProjectInput {
  title: string
  language?: string
  author?: string
  genre?: string
  logline?: string
  premise?: string
  themes?: string[]
  targetWords?: number
  /** A length recommended for every chapter that names none of its own; left out, whoever writes judges. */
  chapterBudget?: number
}

/** A chapter plan with its position resolved. */
export interface LocatedChapter {
  plan: ChapterPlan
  /** The volume it sits in; for a chapter of another line, the volume that line leaves the main one in. */
  volume: Volume
  /** 1-based reading order on the line it was looked up on: the main line, or the one it belongs to. */
  index: number
  /** The line the chapter belongs to, when it is not the main one. */
  line?: string
}

/** Where a new chapter goes. */
export interface ChapterPlace {
  volume?: string
  before?: string
  after?: string
  /** The line it is added to, when that is not the main one and no neighbour says so already. */
  line?: string
}

/** History that is kept for looking back, not for working from: bounded so that a book worked on for years stays quick to open. */
const ACTIVITY_KEPT = 5000
const SETTLED_PROPOSALS_KEPT = 500

export class ProjectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

interface CachedDoc<T> {
  mtime: number
  value: T
}

type ChangeListener = (revision: number) => void

export class Project {
  private revisionValue = 1
  private readonly listeners = new Set<ChangeListener>()
  private readonly cache = new Map<string, CachedDoc<unknown>>()
  private readonly mutex = new KeyedMutex()
  private watcher: FSWatcher | undefined
  private watchTimer: NodeJS.Timeout | undefined
  /**
   * What this process itself put on disk: for each path, when, and the
   * modification time the file had right after. A watch event for a file that
   * still has that time is the Studio's own write coming back, however late
   * the event arrives; anything else was changed by someone else.
   */
  private readonly ownWrites = new Map<string, { at: number; mtime: number }>()
  private readonly outsiders = new Set<(paths: string[]) => void>()
  /** Files changed from outside since the last report. */
  private readonly outside = new Set<string>()
  private disposed = false

  /**
   * @param files - how the book's files are read and written: as they are, or
   *   through the book's key when it is sealed.
   */
  private constructor(readonly root: string, readonly files: FileStore = new PlainFiles()) {}

  // ───────────── lifecycle ─────────────

  /** Open an existing project. @returns undefined when `root` holds no manifest. */
  /**
   * @param key - the key of a sealed book.
   * @throws ProjectError `novel/locked` when the book is sealed and no key was given.
   */
  static async open(root: string, key?: Buffer): Promise<Project | undefined> {
    if (!(await exists(join(root, MANIFEST_FILE)))) return undefined
    const stub = await readStub(root)
    if (stub !== undefined && key === undefined) throw new ProjectError('novel/locked', `"${stub.title}" is locked — its author unlocks it in Novel Studio`)
    const project = new Project(root, stub !== undefined ? new SealedFiles(root, key!) : new PlainFiles())
    await project.manifest()
    project.startWatching()
    return project
  }

  static async create(root: string, input: CreateProjectInput): Promise<Project> {
    if (await exists(join(root, MANIFEST_FILE))) {
      throw new ProjectError('novel/project-exists', `a novel project already exists in ${root}`)
    }
    const now = new Date().toISOString()
    const language = input.language ?? 'zh'
    const manifest: ProjectManifest = {
      schema: 1,
      id: newId('novel'),
      title: input.title.trim() || (language.startsWith('zh') ? '未命名作品' : 'Untitled'),
      language,
      ...optional('author', input.author),
      ...optional('genre', input.genre),
      ...optional('logline', input.logline),
      ...optional('premise', input.premise),
      ...(input.themes !== undefined && input.themes.length > 0 ? { themes: input.themes } : {}),
      ...(input.targetWords !== undefined ? { targetWords: input.targetWords } : {}),
      // No length is stamped on a book: a chapter is as long as it needs to be unless its author says otherwise.
      ...(input.chapterBudget !== undefined && input.chapterBudget > 0 ? { chapterBudget: Math.round(input.chapterBudget) } : {}),
      activeStyle: 'default',
      createdAt: now,
      updatedAt: now,
    }
    await ensureDir(root)
    await writeJson(join(root, MANIFEST_FILE), manifest)
    const zh = language.startsWith('zh')
    const outline: Outline = {
      schema: 1,
      volumes: [{ id: 'v1', title: zh ? '第一卷' : 'Volume One', chapters: [] }],
      threads: [],
    }
    await writeJson(join(root, OUTLINE_FILE), outline)
    for (const dir of ['bible/characters', 'bible/world', 'bible/styles', 'manuscript', 'assets', STATE_DIR]) {
      await ensureDir(join(root, dir))
    }
    await writeAtomic(join(root, 'bible/styles/default.md'), renderFrontMatter(defaultStyle(zh), ''))
    await writeAtomic(join(root, STATE_DIR, 'README.md'), stateReadme(zh))
    const project = new Project(root)
    // What was just laid down is the Studio's own, though it was written before there was a project to write it.
    for (const file of [MANIFEST_FILE, OUTLINE_FILE, 'bible/styles/default.md', join(STATE_DIR, 'README.md')]) {
      const path = join(root, file)
      project.ownWrites.set(path, { at: Date.now(), mtime: await mtimeOf(path) })
    }
    project.startWatching()
    return project
  }

  dispose(): void {
    this.disposed = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
    this.listeners.clear()
    this.outsiders.clear()
  }

  get revision(): number {
    return this.revisionValue
  }

  /**
   * Subscribe to changes made to the book's files by something other than the
   * Studio — an editor, a script, a file tool. The listener gets the
   * project-relative paths that changed, a moment after the last of them.
   */
  onOutside(listener: (paths: string[]) => void): () => void {
    this.outsiders.add(listener)
    return () => { this.outsiders.delete(listener) }
  }

  /** Subscribe to revision changes. @returns the unsubscriber. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Record a change and wake every waiter. */
  touch(): void {
    this.revisionValue += 1
    for (const listener of [...this.listeners]) {
      try {
        listener(this.revisionValue)
      } catch {
        // A broken subscriber must not block the write that triggered it.
      }
    }
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (this.disposed || filename === null) return
        const name = String(filename)
        if (name.endsWith('.tmp') || name.includes('.novel/index') || name.includes('.novel\\index') || name.includes('node_modules')) return
        this.outside.add(name)
        if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined
          void this.sift().catch(() => {})
        }, 200)
      })
      // Watch failures (EMFILE, unmounted volumes) degrade to "no live external updates".
      this.watcher.on('error', () => {
        this.watcher?.close()
        this.watcher = undefined
      })
    } catch {
      this.watcher = undefined
    }
  }

  /** Tell the changes somebody else made from the Studio's own writes coming back, and pass the former on. */
  private async sift(): Promise<void> {
    if (this.disposed) return
    const names = [...this.outside]
    this.outside.clear()
    const paths: string[] = []
    for (const name of names) {
      const physical = join(this.root, name)
      const own = this.ownWrites.get(physical)
      if (own !== undefined) {
        // Still being written, or exactly as the Studio left it (gone, when the Studio removed it).
        if (own.mtime < 0 ? Date.now() - own.at < 5000 : await mtimeOf(physical) === own.mtime) continue
      }
      // A sealed file is known to the rest of the Studio by the path it stands for.
      const known = this.files.logical(name)
      if (known !== undefined) paths.push(known)
    }
    if (this.disposed || paths.length === 0) return
    this.touch()
    for (const listener of [...this.outsiders]) {
      try {
        listener(paths)
      } catch {
        // A broken subscriber must not stop the others from hearing of the change.
      }
    }
  }

  /** Note that the Studio is about to write (or remove) a file, and afterwards how it left it. */
  private async own(path: string, work: () => Promise<void>): Promise<void> {
    const physical = this.files.physical(path)
    this.ownWrites.set(physical, { at: Date.now(), mtime: -1 })
    if (this.ownWrites.size > 4000) {
      const cutoff = Date.now() - 60_000
      for (const [key, entry] of this.ownWrites) if (entry.at < cutoff) this.ownWrites.delete(key)
    }
    try {
      await work()
    } finally {
      this.ownWrites.set(physical, { at: Date.now(), mtime: await mtimeOf(physical).catch(() => 0) })
    }
  }

  // ───────────── low-level documents ─────────────

  path(...parts: string[]): string {
    return containedPath(this.root, join(...parts))
  }

  statePath(...parts: string[]): string {
    return this.path(STATE_DIR, ...parts)
  }

  /** Project-relative POSIX form of an absolute path inside the project. */
  relative(path: string): string {
    return relativePosix(this.root, path)
  }

  private async cached<T>(path: string, load: (mtime: number) => Promise<T>): Promise<T> {
    const mtime = await this.files.mtimeOf(path)
    const hit = this.cache.get(path) as CachedDoc<T> | undefined
    if (hit !== undefined && hit.mtime === mtime) return hit.value
    const value = await load(mtime)
    this.cache.set(path, { mtime, value })
    return value
  }

  private async write(path: string, data: string | Uint8Array, notify = true): Promise<void> {
    await this.own(path, async () => { await this.files.writeAtomic(path, data) })
    this.cache.delete(path)
    if (notify) this.touch()
  }

  private async writeDoc(path: string, value: unknown, notify = true): Promise<void> {
    await this.write(path, `${JSON.stringify(value, null, 2)}\n`, notify)
  }

  private async remove(path: string): Promise<void> {
    await this.own(path, async () => { await this.files.removePath(path) })
    this.cache.delete(path)
    this.touch()
  }

  /** Read a JSON document under `.novel/`. */
  async readState<T>(...parts: string[]): Promise<T | undefined> {
    const path = this.statePath(...parts)
    return await this.cached(path, async () => await this.files.readJson<T>(path))
  }

  /** Write a JSON document under `.novel/`. */
  async writeState(parts: string[], value: unknown, notify = true): Promise<void> {
    await this.writeDoc(this.statePath(...parts), value, notify)
  }

  async removeState(...parts: string[]): Promise<void> {
    await this.remove(this.statePath(...parts))
  }

  /** Serialized read-modify-write of one `.novel/` JSON document. */
  async updateState<T>(parts: string[], fallback: T, mutate: (current: T) => T | Promise<T>): Promise<T> {
    const path = this.statePath(...parts)
    return await this.mutex.run(path, async () => {
      const current = (await this.files.readJson<T>(path)) ?? fallback
      const next = await mutate(current)
      await this.writeDoc(path, next)
      return next
    })
  }

  /** Store binary output (an image, an audio segment) under `assets/`. @returns the project-relative path. */
  async writeAsset(relativePath: string, data: Uint8Array): Promise<string> {
    const path = this.path('assets', relativePath)
    await this.write(path, data)
    return this.relative(path)
  }

  // ───────────── manifest ─────────────

  async manifest(): Promise<ProjectManifest> {
    const path = this.path(MANIFEST_FILE)
    return await this.cached(path, async () => {
      const manifest = await this.files.readJson<ProjectManifest>(path)
      if (manifest === undefined) throw new ProjectError('novel/no-project', `no ${MANIFEST_FILE} in ${this.root}`)
      return {
        ...manifest,
        schema: 1,
        id: manifest.id ?? newId('novel'),
        title: manifest.title ?? basename(this.root),
        language: manifest.language ?? 'zh',
        createdAt: manifest.createdAt ?? new Date().toISOString(),
        updatedAt: manifest.updatedAt ?? new Date().toISOString(),
      }
    })
  }

  async updateManifest(patch: Partial<ProjectManifest>): Promise<ProjectManifest> {
    const path = this.path(MANIFEST_FILE)
    return await this.mutex.run(path, async () => {
      const current = await this.manifest()
      const next: ProjectManifest = { ...current, ...stripUndefined(patch), schema: 1, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() }
      // The recommended chapter length has one home. Whoever still names the old one means the new; nothing, or zero, takes the recommendation away.
      if ('chapterBudget' in patch || 'chapterWords' in patch) {
        const wanted = (patch.chapterBudget ?? patch.chapterWords) as number | null | undefined
        delete next.chapterWords
        if (typeof wanted === 'number' && wanted > 0) next.chapterBudget = Math.round(wanted)
        else delete next.chapterBudget
      }
      await this.writeDoc(path, next)
      return next
    })
  }

  // ───────────── bible: generic Markdown cards ─────────────

  private async cards<T extends { id: string; updatedAt?: string }>(dir: string, normalize: (data: Partial<T>, body: string, id: string) => T): Promise<T[]> {
    const base = this.path('bible', dir)
    const names = (await this.files.listDir(base)).filter(name => name.endsWith('.md'))
    const cards: T[] = []
    for (const name of names) {
      const path = join(base, name)
      const card = await this.cached(path, async (mtime) => {
        const text = (await this.files.readText(path)) ?? ''
        const { data, body } = parseFrontMatter<T>(text)
        const card = normalize(data, body, name.slice(0, -3))
        if (card.updatedAt === undefined && mtime > 0) card.updatedAt = new Date(mtime).toISOString()
        return card
      })
      cards.push(card)
    }
    return cards
  }

  private async saveCard(dir: string, id: string, data: object, body: string | undefined): Promise<void> {
    await this.write(this.path('bible', dir, `${id}.md`), renderFrontMatter(data, body))
  }

  private async uniqueId(dir: string, name: string, fallback: string): Promise<string> {
    const base = slugify(name, fallback)
    const taken = new Set((await this.files.listDir(this.path('bible', dir))).map(file => file.replace(/\.md$/, '')))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  // ───────────── characters ─────────────

  async characters(): Promise<CharacterCard[]> {
    return await this.cards<CharacterCard>('characters', (data, body, id) => {
      // Looks written by hand in the front matter have no id yet; everything downstream names looks by id.
      const visual = isPlainRecord(data.visual) && Array.isArray((data.visual as { looks?: unknown }).looks)
        ? { visual: { ...data.visual, looks: reconcileLooks((data.visual as { looks: unknown }).looks) } as CharacterCard['visual'] }
        : {}
      return {
        ...data,
        ...visual,
        id: typeof data.id === 'string' && data.id.length > 0 ? data.id : id,
        name: typeof data.name === 'string' && data.name.length > 0 ? data.name : id,
        role: data.role ?? 'supporting',
        status: data.status ?? 'planned',
        ...(body.length > 0 ? { notes: body } : {}),
      }
    })
  }

  /** Find a character by id, name or alias. */
  async findCharacter(ref: string): Promise<CharacterCard | undefined> {
    const wanted = ref.trim()
    if (wanted.length === 0) return undefined
    const all = await this.characters()
    return all.find(card => card.id === wanted)
      ?? all.find(card => sameName(card.name, wanted))
      ?? all.find(card => card.aliases?.some(alias => sameName(alias, wanted)) === true)
  }

  /**
   * Create or update a character. Fields absent from `input` keep their value;
   * a field set to `null` or an empty string is cleared.
   */
  async saveCharacter(input: Partial<CharacterCard> & { name?: string }): Promise<CharacterCard> {
    return await this.mutex.run('characters', async () => {
      const existing = input.id !== undefined ? await this.findCharacter(input.id) : input.name !== undefined ? await this.findCharacter(input.name) : undefined
      if (existing === undefined && (input.name === undefined || input.name.trim().length === 0)) {
        throw new ProjectError('novel/invalid', 'a new character needs a name')
      }
      const id = existing?.id ?? await this.uniqueId('characters', input.name!, 'character')
      const merged = mergeCard<CharacterCard>(existing ?? { id, name: input.name!.trim(), role: 'supporting', status: 'planned' }, input)
      merged.id = id
      merged.updatedAt = new Date().toISOString()
      // A look that is saved again is still the same look: it keeps its id and the sheet drawn for it.
      const looks = isPlainRecord(input.visual) ? (input.visual as { looks?: unknown }).looks : undefined
      if (Array.isArray(looks) && merged.visual !== undefined) {
        const kept = reconcileLooks(looks, existing?.visual?.looks)
        if (kept.length > 0) merged.visual.looks = kept
        else delete merged.visual.looks
      }
      const { notes, ...data } = merged
      await this.saveCard('characters', id, data, notes)
      return merged
    })
  }

  async deleteCharacter(ref: string): Promise<boolean> {
    const card = await this.findCharacter(ref)
    if (card === undefined) return false
    await this.remove(this.path('bible', 'characters', `${card.id}.md`))
    await this.dropTiesOf({ type: 'character', id: card.id })
    return true
  }

  // ───────────── ties: how the things of the world stand to each other ─────────────

  /** The ties of the book's world: what is in what, who belongs where, who lives where, who holds what (`bible/relations.json`). */
  async ties(): Promise<Tie[]> {
    const path = this.path('bible', TIES_FILE)
    return await this.cached(path, async () => {
      const stored = await this.files.readJson<{ relations?: unknown }>(path)
      const list = Array.isArray(stored?.relations) ? stored.relations : []
      return list.filter((item): item is Tie => {
        const tie = item as Partial<Tie> | null
        return tie !== null && typeof tie === 'object' && typeof tie.id === 'string' && (TIE_KINDS as readonly string[]).includes(tie.kind ?? '')
          && typeof tie.from?.id === 'string' && typeof tie.to?.id === 'string'
      })
    })
  }

  private async writeTies(mutate: (current: Tie[]) => Tie[]): Promise<Tie[]> {
    const path = this.path('bible', TIES_FILE)
    return await this.mutex.run(path, async () => {
      const next = mutate(await this.ties())
      await this.writeDoc(path, { schema: 1, relations: next })
      return next
    })
  }

  /**
   * Add a tie, or say again one that is there: the same kind between the same
   * two things is one tie, and saying it again sets its chapters and its note.
   * Its ends may be named by id or by name.
   * @throws ProjectError `novel/not-found` when an end does not exist; `novel/invalid` when the kind does not connect such things, or a thing with itself.
   */
  async saveTie(input: Omit<Tie, 'id'> & { id?: string }): Promise<Tie> {
    if (!(TIE_KINDS as readonly string[]).includes(input.kind)) throw new ProjectError('novel/invalid', `"${String(input.kind)}" is no kind of tie: one of ${TIE_KINDS.join(', ')}`)
    const wanted = TIE_ENDS[input.kind]
    const resolve = async (end: TieEnd, side: 'from' | 'to'): Promise<TieEnd> => {
      if (end.type !== wanted[side]) throw new ProjectError('novel/invalid', `a "${input.kind}" tie goes from a ${wanted.from === 'character' ? 'character' : 'world entry'} to a ${wanted.to === 'character' ? 'character' : 'world entry'}`)
      if (end.type === 'character') {
        const card = await this.findCharacter(end.id)
        if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${end.id}"`)
        return { type: 'character', id: card.id }
      }
      const entry = await this.findWorld(end.id)
      if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${end.id}"`)
      return { type: 'world', id: entry.id }
    }
    const from = await resolve(input.from, 'from')
    const to = await resolve(input.to, 'to')
    if (from.type === to.type && from.id === to.id) throw new ProjectError('novel/invalid', 'a thing is not tied to itself')
    let saved: Tie | undefined
    await this.writeTies((current) => {
      const at = current.findIndex(tie => (input.id !== undefined && tie.id === input.id) || (tie.kind === input.kind && tie.from.type === from.type && tie.from.id === from.id && tie.to.type === to.type && tie.to.id === to.id))
      const tie: Tie = {
        id: at >= 0 ? current[at]!.id : newId('tie'),
        kind: input.kind,
        from,
        to,
        ...(input.since !== undefined && input.since.length > 0 ? { since: input.since } : {}),
        ...(input.until !== undefined && input.until.length > 0 ? { until: input.until } : {}),
        ...(input.note !== undefined && input.note.trim().length > 0 ? { note: input.note.trim() } : {}),
      }
      saved = tie
      return at >= 0 ? current.map((known, index) => (index === at ? tie : known)) : [...current, tie]
    })
    return saved!
  }

  async removeTie(id: string): Promise<boolean> {
    let removed = false
    await this.writeTies((current) => {
      removed = current.some(tie => tie.id === id)
      return removed ? current.filter(tie => tie.id !== id) : current
    })
    return removed
  }

  /** A card or an entry is gone: the ties that named it go with it. */
  private async dropTiesOf(end: TieEnd): Promise<void> {
    const named = (tie: Tie): boolean => (tie.from.type === end.type && tie.from.id === end.id) || (tie.to.type === end.type && tie.to.id === end.id)
    if (!(await this.ties()).some(named)) return
    await this.writeTies(current => current.filter(tie => !named(tie)))
  }

  // ───────────── world ─────────────

  async world(): Promise<WorldEntry[]> {
    return await this.cards<WorldEntry>('world', (data, body, id) => ({
      ...data,
      id: typeof data.id === 'string' && data.id.length > 0 ? data.id : id,
      name: typeof data.name === 'string' && data.name.length > 0 ? data.name : id,
      category: data.category ?? 'other',
      importance: data.importance === 1 || data.importance === 3 ? data.importance : 2,
      ...(body.length > 0 ? { body } : {}),
    }))
  }

  async findWorld(ref: string): Promise<WorldEntry | undefined> {
    const wanted = ref.trim()
    if (wanted.length === 0) return undefined
    const all = await this.world()
    return all.find(entry => entry.id === wanted)
      ?? all.find(entry => sameName(entry.name, wanted))
      ?? all.find(entry => entry.aliases?.some(alias => sameName(alias, wanted)) === true)
  }

  async saveWorld(input: Partial<WorldEntry> & { name?: string }): Promise<WorldEntry> {
    return await this.mutex.run('world', async () => {
      const existing = input.id !== undefined ? await this.findWorld(input.id) : input.name !== undefined ? await this.findWorld(input.name) : undefined
      if (existing === undefined && (input.name === undefined || input.name.trim().length === 0)) {
        throw new ProjectError('novel/invalid', 'a new world entry needs a name')
      }
      const id = existing?.id ?? await this.uniqueId('world', input.name!, 'entry')
      const merged = mergeCard<WorldEntry>(existing ?? { id, name: input.name!.trim(), category: 'other', importance: 2 }, input)
      merged.id = id
      merged.updatedAt = new Date().toISOString()
      const { body, ...data } = merged
      await this.saveCard('world', id, data, body)
      return merged
    })
  }

  async deleteWorld(ref: string): Promise<boolean> {
    const entry = await this.findWorld(ref)
    if (entry === undefined) return false
    await this.remove(this.path('bible', 'world', `${entry.id}.md`))
    await this.dropTiesOf({ type: 'world', id: entry.id })
    return true
  }

  /**
   * Make several entries one: the same place, house or thing written down
   * under different names. `keep` stays and the others are folded into it —
   * their names become its other names, what they say that it does not is
   * kept under their name in its text, a picture it lacks is taken over — and
   * everything that pointed at one of them points at it: ties, the marks on
   * scenes, what other entries go with, the gallery's record of their pictures.
   * @returns the entry as it is now, the names folded in, and how many ties were moved or dropped as doubles.
   * @throws ProjectError `novel/not-found` when `keep` matches nothing; `novel/invalid` when nothing else is named.
   */
  async mergeWorld(keepRef: string, foldRefs: readonly string[]): Promise<{ entry: WorldEntry; folded: string[]; ties: number }> {
    const keep = await this.findWorld(keepRef)
    if (keep === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${keepRef}"`)
    const folded: WorldEntry[] = []
    for (const ref of foldRefs) {
      const entry = await this.findWorld(ref)
      if (entry !== undefined && entry.id !== keep.id && !folded.some(other => other.id === entry.id)) folded.push(entry)
    }
    if (folded.length === 0) throw new ProjectError('novel/invalid', `name at least one other entry to fold into "${keep.name}"`)
    const gone = new Set(folded.map(entry => entry.id))
    const names = [...new Set([...(keep.aliases ?? []), ...folded.flatMap(entry => [entry.name, ...(entry.aliases ?? [])])])].filter(name => name !== keep.name)
    const summary = keep.summary ?? folded.find(entry => entry.summary !== undefined)?.summary
    // What the others say is not thrown away: each keeps a paragraph under its own name.
    const extra = folded.map((entry) => {
      const said = [entry.summary !== summary ? entry.summary : undefined, entry.body].filter((part): part is string => part !== undefined && part.trim().length > 0)
      return said.length > 0 ? `### ${entry.name}\n\n${said.join('\n\n')}` : undefined
    }).filter((part): part is string => part !== undefined)
    const body = [keep.body, ...extra].filter((part): part is string => part !== undefined && part.trim().length > 0).join('\n\n')
    const pictured = keep.visualImage !== undefined ? undefined : folded.find(entry => entry.visualImage !== undefined)
    const repoint = (key: string): string => (key.startsWith('world:') && gone.has(key.slice(6)) ? `world:${keep.id}` : key)
    const spots = Object.fromEntries([...folded.flatMap(entry => (pictured?.id === entry.id ? Object.entries(entry.spots ?? {}) : [])), ...Object.entries(keep.spots ?? {})].map(([key, at]) => [repoint(key), at] as const).filter(([key]) => key !== `world:${keep.id}`))
    const related = [...new Set([...(keep.related ?? []), ...folded.flatMap(entry => entry.related ?? [])])].filter(id => id !== keep.id && !gone.has(id))
    // What happened to any of them happened to the one thing they are; said twice of one chapter, it is said once.
    const course = [...(keep.events ?? []), ...folded.flatMap(entry => entry.events ?? [])].filter((event, index, all) => all.findIndex(other => other.chapter === event.chapter && other.kind === event.kind) === index)
    const entry = await this.saveWorld({
      id: keep.id,
      ...(names.length > 0 ? { aliases: names } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(body.length > 0 ? { body } : {}),
      // As heavy as the heaviest of them: one of them travelling with every request means the place does.
      importance: Math.min(keep.importance, ...folded.map(other => other.importance)) as WorldEntry['importance'],
      ...(keep.weight === undefined && folded.find(other => other.weight !== undefined)?.weight !== undefined ? { weight: folded.find(other => other.weight !== undefined)!.weight! } : {}),
      ...(pictured !== undefined ? { visualImage: pictured.visualImage!, ...(keep.visualPrompt === undefined && pictured.visualPrompt !== undefined ? { visualPrompt: pictured.visualPrompt } : {}) } : {}),
      ...(related.length > 0 ? { related } : {}),
      ...(Object.keys(spots).length > 0 ? { spots } : {}),
      ...(course.length > 0 ? { events: course } : {}),
    })
    // Ties: every end that named one of them names the one that stays; a tie that became a double, or a thing tied to itself, goes.
    let moved = 0
    if ((await this.ties()).some(tie => (tie.from.type === 'world' && gone.has(tie.from.id)) || (tie.to.type === 'world' && gone.has(tie.to.id)))) {
      await this.writeTies((current) => {
        const seen = new Set<string>()
        const next: Tie[] = []
        for (const tie of current) {
          const from = tie.from.type === 'world' && gone.has(tie.from.id) ? { type: 'world' as const, id: keep.id } : tie.from
          const to = tie.to.type === 'world' && gone.has(tie.to.id) ? { type: 'world' as const, id: keep.id } : tie.to
          if (from !== tie.from || to !== tie.to) moved += 1
          const key = `${tie.kind}|${from.type}:${from.id}|${to.type}:${to.id}`
          if ((from.type === to.type && from.id === to.id) || seen.has(key)) continue
          seen.add(key)
          next.push(from === tie.from && to === tie.to ? tie : { ...tie, from, to })
        }
        return next
      })
    }
    // What other entries go with, and the marks on their scenes.
    for (const other of await this.world()) {
      if (other.id === keep.id || gone.has(other.id)) continue
      const goesWith = other.related?.some(id => gone.has(id)) === true
      const marked = Object.keys(other.spots ?? {}).some(key => key.startsWith('world:') && gone.has(key.slice(6)))
      if (!goesWith && !marked) continue
      const { body: text, ...data } = {
        ...other,
        ...(goesWith ? { related: [...new Set(other.related!.map(id => (gone.has(id) ? keep.id : id)))] } : {}),
        ...(marked ? { spots: Object.fromEntries(Object.entries(other.spots!).map(([key, at]) => [repoint(key), at])) } : {}),
        updatedAt: new Date().toISOString(),
      }
      await this.mutex.run('world', async () => { await this.saveCard('world', other.id, data, text) })
    }
    // The gallery's record of their pictures: they are the pictures of the one that stays.
    if ((await this.illustrations()).some(item => (item.kind === 'location' || item.kind === 'item') && item.target !== undefined && gone.has(item.target))) {
      await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], current => current.map(item => ((item.kind === 'location' || item.kind === 'item') && item.target !== undefined && gone.has(item.target) ? { ...item, target: keep.id } : item)))
    }
    for (const other of folded) await this.remove(this.path('bible', 'world', `${other.id}.md`))
    return { entry, folded: folded.map(other => other.name), ties: moved }
  }

  // ───────────── styles ─────────────

  async styles(): Promise<StyleProfile[]> {
    return await this.cards<StyleProfile>('styles', (data, body, id) => ({
      ...data,
      id: typeof data.id === 'string' && data.id.length > 0 ? data.id : id,
      name: typeof data.name === 'string' && data.name.length > 0 ? data.name : id,
      ...(body.length > 0 ? { body } : {}),
    }))
  }

  async findStyle(ref: string): Promise<StyleProfile | undefined> {
    const all = await this.styles()
    return all.find(style => style.id === ref) ?? all.find(style => sameName(style.name, ref))
  }

  /** The style a task should use when it names none. */
  async activeStyle(): Promise<StyleProfile | undefined> {
    const manifest = await this.manifest()
    const all = await this.styles()
    return all.find(style => style.id === manifest.activeStyle) ?? all[0]
  }

  async saveStyle(input: Partial<StyleProfile> & { name?: string }): Promise<StyleProfile> {
    return await this.mutex.run('styles', async () => {
      const existing = input.id !== undefined ? await this.findStyle(input.id) : input.name !== undefined ? await this.findStyle(input.name) : undefined
      if (existing === undefined && (input.name === undefined || input.name.trim().length === 0)) {
        throw new ProjectError('novel/invalid', 'a new style needs a name')
      }
      const id = existing?.id ?? await this.uniqueId('styles', input.name!, 'style')
      const merged = mergeCard<StyleProfile>(existing ?? { id, name: input.name!.trim() }, input)
      merged.id = id
      merged.updatedAt = new Date().toISOString()
      const { body, ...data } = merged
      await this.saveCard('styles', id, data, body)
      return merged
    })
  }

  async deleteStyle(ref: string): Promise<boolean> {
    const style = await this.findStyle(ref)
    if (style === undefined) return false
    await this.remove(this.path('bible', 'styles', `${style.id}.md`))
    return true
  }

  // ───────────── outline ─────────────

  async outline(): Promise<Outline> {
    const path = this.path(OUTLINE_FILE)
    return await this.cached(path, async () => {
      const outline = await this.files.readJson<Outline>(path)
      return normalizeOutline(outline)
    })
  }

  /** Serialized read-modify-write of the outline. The mutator may edit the draft in place. */
  async updateOutline(mutate: (draft: Outline) => void | Promise<void>): Promise<Outline> {
    const path = this.path(OUTLINE_FILE)
    return await this.mutex.run(path, async () => {
      const draft = structuredClone(await this.outline())
      await mutate(draft)
      const next = normalizeOutline(draft)
      await this.writeDoc(path, next)
      return next
    })
  }

  /**
   * Chapters in reading order with their volume and 1-based index.
   * @param line - a line of the plot other than the main one: the chapters as
   *   they are read on it — what comes before it, its own, and what it arrives at.
   * @throws ProjectError `novel/not-found` when the book has no such line.
   */
  async chapters(line?: string): Promise<LocatedChapter[]> {
    const outline = await this.outline()
    return located(linePath(outline, lineOf(outline, line)))
  }

  /** The chapters in the order whoever reaches this one has read them: the line it belongs to, whole. */
  async pathOf(chapterId: string): Promise<LocatedChapter[]> {
    const outline = await this.outline()
    return located(linePath(outline, homeOf(outline, chapterId) ?? undefined))
  }

  /**
   * Resolve a chapter reference the way a human or a model writes it: an id
   * (`ch003`), a number (`3`, `第3章`, `chapter 3`), `last`/`latest`, or a title.
   * Numbers and `last` count along the main line unless `line` names another;
   * an id finds its chapter on whichever line it is.
   */
  async findChapter(ref: string | number, line?: string): Promise<LocatedChapter | undefined> {
    const all = await this.chapters(line)
    if (typeof ref === 'number') return all[ref - 1]
    const wanted = ref.trim()
    if (wanted.length === 0) return undefined
    const byId = all.find(chapter => chapter.plan.id === wanted)
    if (byId !== undefined) return byId
    const outline = await this.outline()
    // A chapter of another line, by its id: placed on the line it belongs to.
    if (homeOf(outline, wanted) !== undefined) return (await this.pathOf(wanted)).find(chapter => chapter.plan.id === wanted)
    if (/^(last|latest|最后|最新|最后一章|最新一章)$/i.test(wanted)) return all.at(-1)
    const number = /^(?:第\s*)?(\d+)\s*(?:章|回|节)?$/.exec(wanted) ?? /^(?:chapter|ch\.?)\s*(\d+)$/i.exec(wanted)
    if (number !== null) return all[Number(number[1]) - 1]
    const here = all.find(chapter => sameName(chapter.plan.title, wanted)) ?? all.find(chapter => chapter.plan.title.includes(wanted))
    if (here !== undefined || line !== undefined) return here
    // By title, a chapter of another line is still that chapter.
    for (const other of outline.lines ?? []) {
      const plan = other.chapters.find(chapter => sameName(chapter.title, wanted))
      if (plan !== undefined) return (await this.pathOf(plan.id)).find(chapter => chapter.plan.id === plan.id)
    }
    return undefined
  }

  private async nextChapterId(outline: Outline): Promise<string> {
    const files = await this.files.listDir(this.path('manuscript'))
    let max = 0
    const scan = (id: string): void => {
      const match = /^ch(\d+)$/.exec(id)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    for (const holder of holders(outline)) for (const chapter of holder.chapters) scan(chapter.id)
    for (const file of files) scan(file.replace(/\.md$/, ''))
    // A chapter that was taken out keeps its number: what was made from it still lies under that number, and it may come back.
    for (const removed of await this.removedChapters()) scan(removed.plan.id)
    for (const name of await this.files.listDir(this.statePath('versions'))) scan(name)
    return `ch${String(max + 1).padStart(3, '0')}`
  }

  /** Append (or insert) a chapter plan. @returns the created plan. */
  async addChapter(input: Partial<ChapterPlan> & { title: string }, where: ChapterPlace = {}): Promise<ChapterPlan> {
    let created!: ChapterPlan
    await this.updateOutline(async (draft) => {
      const id = await this.nextChapterId(draft)
      created = { ...stripUndefined(input), id, title: input.title.trim(), status: input.status ?? (input.synopsis !== undefined ? 'outlined' : 'idea') }
      insertChapter(draft, created, where)
    })
    return created
  }

  async updateChapter(ref: string, patch: Partial<ChapterPlan>): Promise<ChapterPlan> {
    const located = await this.findChapter(ref)
    if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
    let updated!: ChapterPlan
    await this.updateOutline((draft) => {
      for (const holder of holders(draft)) {
        const index = holder.chapters.findIndex(chapter => chapter.id === located.plan.id)
        if (index < 0) continue
        updated = mergeCard<ChapterPlan>(holder.chapters[index]!, { ...patch, id: located.plan.id })
        holder.chapters[index] = updated
      }
    })
    return updated
  }

  async moveChapter(ref: string, where: ChapterPlace): Promise<void> {
    const located = await this.findChapter(ref)
    if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
    await this.updateOutline((draft) => {
      for (const holder of holders(draft)) holder.chapters = holder.chapters.filter(chapter => chapter.id !== located.plan.id)
      // With nothing said about where, a chapter stays on the line and in the volume it was in.
      const home: ChapterPlace = located.line !== undefined ? { line: located.line } : { volume: located.volume.id }
      insertChapter(draft, located.plan, { ...(where.volume === undefined && where.line === undefined ? home : {}), ...where })
    })
  }

  /** Remove a chapter from the outline; its text is snapshotted, then deleted. */
  /**
   * Take a chapter out of the book. It is kept — plan, place and text — among
   * the removed chapters and can be put back ({@link restoreChapter}); what was
   * made from it stays under its number.
   */
  async removeChapter(ref: string): Promise<boolean> {
    const located = await this.findChapter(ref)
    if (located === undefined) return false
    const id = located.plan.id
    const text = await this.chapterText(id)
    const version = text.length > 0 ? await this.snapshot(id, 'before-delete') : undefined
    const path = await this.pathOf(id)
    const at = path.findIndex(chapter => chapter.plan.id === id)
    const before = path[at - 1]
    const record: RemovedChapter = {
      plan: located.plan,
      removedAt: new Date().toISOString(),
      ...(located.line !== undefined ? { line: located.line } : { volume: located.volume.id }),
      // The chapter before it on its own line: one of the main line is not where a line's first chapter stood.
      ...(before !== undefined && before.line === located.line ? { after: before.plan.id } : {}),
      index: located.index,
      words: countWords(proseOnly(text)),
      ...(version !== undefined ? { version } : {}),
    }
    await this.writeState([REMOVED_FILE], [record, ...(await this.removedChapters()).filter(removed => removed.plan.id !== id)], false)
    await this.updateOutline((draft) => {
      for (const holder of holders(draft)) holder.chapters = holder.chapters.filter(chapter => chapter.id !== id)
      // Lines that left after it, or arrived at it, now do so at its neighbours.
      for (const line of draft.lines ?? []) {
        if (line.from === id) {
          const previous = path[at - 1]?.plan.id
          if (previous !== undefined) line.from = previous
          else delete line.from
        }
        if (line.into === id) {
          const next = path[at + 1]?.plan.id
          if (next !== undefined && !line.chapters.some(chapter => chapter.id === next)) line.into = next
          else delete line.into
        }
      }
    })
    await this.remove(this.path('manuscript', `${id}.md`))
    return true
  }

  /** Chapters taken out of the book that can be put back, newest first. */
  async removedChapters(): Promise<RemovedChapter[]> {
    return (await this.readState<RemovedChapter[]>(REMOVED_FILE)) ?? []
  }

  /**
   * Put a removed chapter back: where it stood when the chapter it came after
   * is still there, else at the end of its volume or line; with its text as
   * it was. Its digest, review and whatever else was made from it were never
   * taken away, and are its own again.
   * @throws ProjectError `novel/not-found` when no removed chapter has this id.
   */
  async restoreChapter(id: string): Promise<LocatedChapter> {
    const removed = await this.removedChapters()
    const record = removed.find(candidate => candidate.plan.id === id)
    if (record === undefined) throw new ProjectError('novel/not-found', `no removed chapter "${id}"`)
    // By its id alone: a reference is also read as a position, and position 2 is some other chapter now.
    if (holders(await this.outline()).some(holder => holder.chapters.some(chapter => chapter.id === id))) throw new ProjectError('novel/conflict', `chapter ${id} is in the book already`)
    await this.updateOutline((draft) => {
      const here = (candidate: string | undefined): boolean => candidate !== undefined && holders(draft).some(holder => holder.chapters.some(chapter => chapter.id === candidate))
      const line = record.line !== undefined && (draft.lines ?? []).some(candidate => candidate.id === record.line) ? record.line : undefined
      if (here(record.after)) insertChapter(draft, record.plan, { after: record.after! })
      else if (line !== undefined) {
        // It was the first of its line.
        const holder = draft.lines!.find(candidate => candidate.id === line)!
        holder.chapters.unshift(record.plan)
      } else if (record.after === undefined && record.volume !== undefined && draft.volumes.some(volume => volume.id === record.volume)) {
        // It was the first of its volume.
        draft.volumes.find(volume => volume.id === record.volume)!.chapters.unshift(record.plan)
      } else insertChapter(draft, record.plan, { ...(record.volume !== undefined ? { volume: record.volume } : {}) })
    })
    if (record.version !== undefined) {
      const text = await this.versionText(id, record.version)
      if (text !== undefined) await this.saveChapterText(id, text, { snapshot: false, status: record.plan.status })
    }
    await this.writeState([REMOVED_FILE], removed.filter(candidate => candidate.plan.id !== id), false)
    const back = await this.findChapter(id)
    if (back === undefined) throw new ProjectError('novel/internal', `chapter ${id} could not be put back`)
    return back
  }

  // ───────────── lines of the plot ─────────────

  /** The lines beside the main one. */
  async lines(): Promise<PlotLine[]> {
    return (await this.outline()).lines ?? []
  }

  /** A line by its id or its title; undefined for the main line and for a name no line has. */
  async findLine(ref: string): Promise<PlotLine | undefined> {
    const wanted = ref.trim()
    const lines = await this.lines()
    return lines.find(line => line.id === wanted) ?? lines.find(line => sameName(line.title, wanted))
  }

  /**
   * Open a line: another way the story goes from the end of a chapter on.
   * @throws ProjectError `novel/not-found` when `from` names no chapter.
   */
  async addLine(input: { title: string; from?: string; choice?: string; premise?: string; origin?: PlotLineOrigin; play?: string; shelved?: boolean }): Promise<PlotLine> {
    const from = input.from !== undefined ? await this.findChapter(input.from) : undefined
    if (input.from !== undefined && from === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${input.from}"`)
    let created!: PlotLine
    await this.updateOutline((draft) => {
      created = {
        id: newId('ln'),
        title: input.title.trim() || 'Line',
        ...optional('premise', input.premise?.trim()),
        ...(from !== undefined ? { from: from.plan.id } : {}),
        ...optional('choice', input.choice?.trim()),
        chapters: [],
        origin: input.origin ?? 'author',
        ...optional('play', input.play),
        ...(input.shelved === true ? { shelved: true } : {}),
        createdAt: new Date().toISOString(),
      }
      draft.lines = [...(draft.lines ?? []), created]
    })
    return created
  }

  /**
   * Change a line's name and what it says of itself, put it aside or take it
   * up again, move where it leaves — or say where it arrives: `into` names the
   * chapter of another line from which the two are one story again; `null`
   * takes that away.
   * @throws ProjectError `novel/invalid` when the line would arrive at one of its own chapters, or go round in a circle.
   */
  async updateLine(ref: string, patch: { title?: string; premise?: string; choice?: string; shelved?: boolean; from?: string | null; into?: string | null }): Promise<PlotLine> {
    const line = await this.findLine(ref)
    if (line === undefined) throw new ProjectError('novel/not-found', `no plot line matches "${ref}"`)
    const resolve = async (wanted: string | null | undefined, what: string): Promise<string | null | undefined> => {
      if (wanted === undefined || wanted === null) return wanted
      const chapter = await this.findChapter(wanted)
      if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${wanted}"`)
      if (line.chapters.some(own => own.id === chapter.plan.id)) throw new ProjectError('novel/invalid', `a line cannot ${what} one of its own chapters`)
      return chapter.plan.id
    }
    const from = await resolve(patch.from, 'leave after')
    const into = await resolve(patch.into, 'arrive at')
    let updated!: PlotLine
    await this.updateOutline((draft) => {
      const target = (draft.lines ?? []).find(candidate => candidate.id === line.id)!
      if (patch.title !== undefined && patch.title.trim().length > 0) target.title = patch.title.trim()
      for (const key of ['premise', 'choice'] as const) {
        const value = patch[key]
        if (value === undefined) continue
        if (value.trim().length > 0) target[key] = value.trim()
        else delete target[key]
      }
      if (patch.shelved !== undefined) {
        if (patch.shelved) target.shelved = true
        else delete target.shelved
      }
      if (from === null) delete target.from
      else if (from !== undefined) target.from = from
      if (into === null) delete target.into
      else if (into !== undefined) target.into = into
      // Where it leaves and where it arrives must leave a way through: its own chapters still on its path, each once.
      const path = linePath(draft, target)
      if (target.chapters.some(own => path.filter(entry => entry.plan.id === own.id).length !== 1) || (target.into !== undefined && !path.some(entry => entry.plan.id === target.into)) || (target.from !== undefined && !path.some(entry => entry.plan.id === target.from))) {
        throw new ProjectError('novel/invalid', 'that would make the line go round in a circle: it has to leave before the chapter it arrives at')
      }
      updated = target
    })
    return updated
  }

  /**
   * Take a line out of the book with its chapters; their text is snapshotted
   * first, then deleted. Lines that left from its chapters leave where it did.
   */
  async removeLine(ref: string): Promise<{ line: PlotLine; chapters: number; written: number } | undefined> {
    const line = await this.findLine(ref)
    if (line === undefined) return undefined
    const gone = new Set(line.chapters.map(chapter => chapter.id))
    let written = 0
    for (const id of gone) {
      if ((await this.chapterText(id)).length === 0) continue
      written += 1
      await this.snapshot(id, 'before-delete')
    }
    await this.updateOutline((draft) => {
      draft.lines = (draft.lines ?? []).filter(candidate => candidate.id !== line.id)
      for (const other of draft.lines) {
        if (other.from !== undefined && gone.has(other.from)) {
          if (line.from !== undefined) other.from = line.from
          else delete other.from
        }
        if (other.into !== undefined && gone.has(other.into)) delete other.into
      }
    })
    for (const id of gone) await this.remove(this.path('manuscript', `${id}.md`))
    return { line, chapters: gone.size, written }
  }

  /**
   * Make a line the main one. The chapters read on it become the book as it
   * is read, exported and staged; what the main line had in their place
   * becomes a line of its own, leaving and arriving where the two part and meet.
   * @param formerTitle - what the stretch of the old main line is called as a line.
   */
  async promoteLine(ref: string, formerTitle: string): Promise<{ promoted: PlotLine; former: PlotLine[] }> {
    const line = await this.findLine(ref)
    if (line === undefined) throw new ProjectError('novel/not-found', `no plot line matches "${ref}"`)
    const former: PlotLine[] = []
    await this.updateOutline((draft) => {
      const target = (draft.lines ?? []).find(candidate => candidate.id === line.id)!
      const path = linePath(draft, target)
      const onPath = new Set(path.map(entry => entry.plan.id))
      const old = linePath(draft, undefined)
      const wasMain = new Map(old.map(entry => [entry.plan.id, entry.volume.id]))
      // Stretches of the old main line the new one does not pass through.
      let run: ChapterPlan[] = []
      let before: string | undefined
      const close = (into?: string): void => {
        if (run.length === 0) return
        former.push({
          id: newId('ln'),
          title: former.length === 0 ? formerTitle : `${formerTitle} ${former.length + 1}`,
          ...(before !== undefined ? { from: before } : {}),
          chapters: run,
          ...(into !== undefined ? { into } : {}),
          origin: 'main',
          createdAt: new Date().toISOString(),
        })
        run = []
      }
      for (const entry of old) {
        if (onPath.has(entry.plan.id)) {
          close(entry.plan.id)
          before = entry.plan.id
        } else run.push(entry.plan)
      }
      close()
      // The new main line, volume by volume: a chapter that was on the main line stays in its volume, one that comes from a line joins the volume the story is in at that point.
      const shelves = new Map<string, ChapterPlan[]>(draft.volumes.map(volume => [volume.id, []]))
      let current = draft.volumes[0]!.id
      for (const entry of path) {
        current = wasMain.get(entry.plan.id) ?? current
        shelves.get(current)!.push(entry.plan)
      }
      for (const volume of draft.volumes) volume.chapters = shelves.get(volume.id) ?? []
      // Lines whose first chapters are now the main line's leave after the last of those.
      const kept: PlotLine[] = []
      for (const other of draft.lines ?? []) {
        if (other.id === target.id) continue
        const lost = other.chapters.filter(chapter => onPath.has(chapter.id))
        if (lost.length === 0) {
          kept.push(other)
          continue
        }
        other.chapters = other.chapters.filter(chapter => !onPath.has(chapter.id))
        other.from = lost.at(-1)!.id
        if (other.chapters.length > 0) kept.push(other)
      }
      draft.lines = [...kept, ...former]
    })
    return { promoted: line, former }
  }

  /**
   * Take what follows a chapter out of the line it is on — to make room for
   * another way on. What is taken becomes a line of its own that leaves after
   * that chapter (`keep`), or is removed, its text snapshotted first.
   * @param after - the last chapter that stays; absent: the line is emptied from its first chapter.
   * @param line - the line to cut, when `after` is absent and it is not the main one.
   * @returns the chapters taken, and the line they now are when they were kept.
   */
  async cutTail(after: string | undefined, options: { line?: string; keep?: { title: string; origin?: PlotLineOrigin; shelved?: boolean; premise?: string } } = {}): Promise<{ taken: ChapterPlan[]; line?: PlotLine }> {
    const anchor = after !== undefined ? await this.findChapter(after) : undefined
    if (after !== undefined && anchor === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${after}"`)
    const home = anchor !== undefined ? anchor.line : options.line !== undefined && options.line !== MAIN_LINE ? (await this.findLine(options.line))?.id : undefined
    let taken: ChapterPlan[] = []
    let made: PlotLine | undefined
    await this.updateOutline((draft) => {
      const source = home !== undefined ? (draft.lines ?? []).find(candidate => candidate.id === home) : undefined
      if (source !== undefined) {
        const at = anchor !== undefined ? source.chapters.findIndex(chapter => chapter.id === anchor.plan.id) : -1
        taken = source.chapters.slice(at + 1)
        source.chapters = source.chapters.slice(0, at + 1)
      } else {
        let past = anchor === undefined
        for (const volume of draft.volumes) {
          const stay: ChapterPlan[] = []
          for (const chapter of volume.chapters) {
            if (past) taken.push(chapter)
            else stay.push(chapter)
            if (chapter.id === anchor?.plan.id) past = true
          }
          volume.chapters = stay
        }
      }
      if (taken.length === 0 || options.keep === undefined) return
      made = {
        id: newId('ln'),
        title: options.keep.title,
        ...optional('premise', options.keep.premise),
        ...(anchor !== undefined ? { from: anchor.plan.id } : source?.from !== undefined ? { from: source.from } : {}),
        chapters: taken,
        // What the cut line arrived at, its taken end still arrives at; the line itself now ends open.
        ...(source?.into !== undefined ? { into: source.into } : {}),
        origin: options.keep.origin ?? 'replaced',
        ...(options.keep.shelved === true ? { shelved: true } : {}),
        createdAt: new Date().toISOString(),
      }
      if (source?.into !== undefined) delete source.into
      draft.lines = [...(draft.lines ?? []), made]
    })
    if (options.keep === undefined) {
      const gone = new Set(taken.map(chapter => chapter.id))
      for (const id of gone) {
        if ((await this.chapterText(id)).length > 0) await this.snapshot(id, 'before-delete')
      }
      await this.updateOutline((draft) => {
        for (const other of draft.lines ?? []) {
          if (other.from !== undefined && gone.has(other.from)) {
            if (anchor !== undefined) other.from = anchor.plan.id
            else delete other.from
          }
          if (other.into !== undefined && gone.has(other.into)) delete other.into
        }
      })
      for (const id of gone) await this.remove(this.path('manuscript', `${id}.md`))
    }
    return { taken, ...(made !== undefined ? { line: made } : {}) }
  }

  async saveThread(input: Partial<PlotThread> & { title?: string }): Promise<PlotThread> {
    let saved!: PlotThread
    await this.updateOutline((draft) => {
      const existing = draft.threads.find(thread => thread.id === input.id) ?? (input.title !== undefined ? draft.threads.find(thread => sameName(thread.title, input.title!)) : undefined)
      if (existing === undefined) {
        if (input.title === undefined || input.title.trim().length === 0) throw new ProjectError('novel/invalid', 'a new thread needs a title')
        saved = { ...stripUndefined(input), id: newId('th'), title: input.title.trim(), kind: input.kind ?? 'foreshadow', status: input.status ?? 'open' }
        draft.threads.push(saved)
      } else {
        saved = mergeCard<PlotThread>(existing, { ...input, id: existing.id })
        draft.threads[draft.threads.indexOf(existing)] = saved
      }
    })
    return saved
  }

  async deleteThread(id: string): Promise<boolean> {
    let removed = false
    await this.updateOutline((draft) => {
      const before = draft.threads.length
      draft.threads = draft.threads.filter(thread => thread.id !== id)
      removed = draft.threads.length !== before
    })
    return removed
  }

  // ───────────── manuscript ─────────────

  private chapterPath(id: string): string {
    if (!/^[\w一-鿿-]+$/.test(id)) throw new ProjectError('novel/invalid', `invalid chapter id "${id}"`)
    return this.path('manuscript', `${id}.md`)
  }

  /** Chapter prose, or an empty string when nothing is written yet. */
  async chapterText(id: string): Promise<string> {
    const path = this.chapterPath(id)
    return await this.cached(path, async () => normalizeProse((await this.files.readText(path)) ?? ''))
  }

  /**
   * Save chapter prose. The previous text is snapshotted first unless
   * `snapshot` is false; the chapter's outline status follows the text.
   */
  async saveChapterText(id: string, text: string, options: { reason?: string; snapshot?: boolean; status?: ChapterStatus } = {}): Promise<{ words: number; changed: boolean }> {
    const path = this.chapterPath(id)
    const next = normalizeProse(text)
    return await this.mutex.run(path, async () => {
      const previous = await this.chapterText(id)
      if (previous === next) return { words: countWords(proseOnly(next)), changed: false }
      if (previous.length > 0 && options.snapshot !== false) await this.snapshot(id, options.reason ?? 'edit', previous)
      await this.write(path, next.length > 0 ? `${next}\n` : '')
      const located = await this.findChapter(id)
      if (located !== undefined) {
        const status = options.status ?? (next.length === 0 ? located.plan.status : promote(located.plan.status))
        if (status !== located.plan.status) await this.updateChapter(id, { status })
      }
      return { words: countWords(proseOnly(next)), changed: true }
    })
  }

  /**
   * Per-chapter facts for lists: length, status, whether memory is current.
   * @param line - a line other than the main one: the chapters as read on it.
   */
  async chapterInfos(line?: string): Promise<ChapterInfo[]> {
    const located = await this.chapters(line)
    const book = chapterBudgetOf(await this.manifest())
    const infos: ChapterInfo[] = []
    for (const { plan, volume, index, line: home } of located) {
      const budget = plan.targetWords !== undefined && plan.targetWords > 0 ? plan.targetWords : book
      const path = this.chapterPath(plan.id)
      const text = await this.chapterText(plan.id)
      const memory = text.length > 0 ? await this.memory(plan.id) : undefined
      const review = text.length > 0 ? await this.review(plan.id) : undefined
      const mtime = text.length > 0 ? await this.files.mtimeOf(path) : 0
      infos.push({
        id: plan.id,
        title: plan.title,
        volumeId: volume.id,
        index,
        status: plan.status,
        words: countWords(proseOnly(text)),
        hasText: text.length > 0,
        ...(mtime > 0 ? { updatedAt: new Date(mtime).toISOString() } : {}),
        digested: memory !== undefined && memory.textHash === hashText(text),
        ...(review !== undefined ? { openIssues: review.issues.filter(issue => issue.resolved !== true).length } : {}),
        ...(home !== undefined ? { line: home } : {}),
        ...(budget !== undefined ? { budget } : {}),
      })
    }
    return infos
  }

  // ───────────── versions ─────────────

  /** Save the current (or given) text as a version. @returns the version id, or undefined for empty text. */
  async snapshot(chapterId: string, reason: string, text?: string): Promise<string | undefined> {
    const content = text ?? await this.chapterText(chapterId)
    if (content.length === 0) return undefined
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const id = `${stamp}__${slugify(reason, 'edit')}`
    const path = this.statePath('versions', chapterId, `${id}.md`)
    await this.own(path, async () => { await this.files.writeAtomic(path, content) })
    await this.pruneVersions(chapterId)
    return id
  }

  /** Whether an autosave should take a restore point: at most one `edit` snapshot per window. */
  async editSnapshotDue(chapterId: string, windowMs = 10 * 60_000): Promise<boolean> {
    const names = (await this.files.listDir(this.statePath('versions', chapterId))).filter(name => name.endsWith('__edit.md')).sort()
    const last = names.at(-1)
    if (last === undefined) return true
    const at = Date.parse(last.slice(0, last.indexOf('__')).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4'))
    return !Number.isFinite(at) || Date.now() - at > windowMs
  }

  private async pruneVersions(chapterId: string, keep = 40): Promise<void> {
    const dir = this.statePath('versions', chapterId)
    const names = (await this.files.listDir(dir)).filter(name => name.endsWith('.md'))
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await this.files.removePath(join(dir, name))
  }

  async versions(chapterId: string): Promise<VersionInfo[]> {
    const dir = this.statePath('versions', chapterId)
    const names = (await this.files.listDir(dir)).filter(name => name.endsWith('.md'))
    const versions: VersionInfo[] = []
    for (const name of names) {
      const id = name.slice(0, -3)
      const [stamp, reason] = id.split('__')
      const text = (await this.files.readText(join(dir, name))) ?? ''
      const iso = (stamp ?? '').replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4')
      versions.push({ id, chapterId, createdAt: iso, reason: reason ?? 'edit', words: countWords(text) })
    }
    return versions.reverse()
  }

  async versionText(chapterId: string, versionId: string): Promise<string | undefined> {
    if (!/^[\w.-]+$/.test(versionId)) return undefined
    return await this.files.readText(this.statePath('versions', chapterId, `${versionId}.md`))
  }

  async restoreVersion(chapterId: string, versionId: string): Promise<boolean> {
    const text = await this.versionText(chapterId, versionId)
    if (text === undefined) return false
    await this.saveChapterText(chapterId, text, { reason: 'before-restore' })
    return true
  }

  // ───────────── memory ─────────────

  async memory(chapterId: string): Promise<ChapterMemory | undefined> {
    return await this.readState<ChapterMemory>('memory', `${chapterId}.json`)
  }

  async saveMemory(memory: ChapterMemory): Promise<void> {
    await this.writeState(['memory', `${memory.chapterId}.json`], memory)
  }

  /**
   * Memories of chapters in reading order (chapters without memory are skipped).
   * @param path - the chapters to go through, when not the main line's.
   */
  async memories(path?: readonly LocatedChapter[]): Promise<{ chapter: LocatedChapter; memory: ChapterMemory }[]> {
    const out: { chapter: LocatedChapter; memory: ChapterMemory }[] = []
    for (const chapter of path ?? await this.chapters()) {
      const memory = await this.memory(chapter.plan.id)
      if (memory !== undefined) out.push({ chapter, memory })
    }
    return out
  }

  // ───────────── suggestions, proposals, reviews ─────────────

  async suggestions(): Promise<Suggestion[]> {
    return (await this.readState<Suggestion[]>('suggestions.json')) ?? []
  }

  async addSuggestions(items: Omit<Suggestion, 'id' | 'createdAt'>[]): Promise<void> {
    if (items.length === 0) return
    await this.updateState<Suggestion[]>(['suggestions.json'], [], (current) => {
      const next = [...current]
      for (const item of items) {
        // The same finding from a re-digest must not pile up.
        if (next.some(existing => existing.kind === item.kind && sameName(existing.title, item.title))) continue
        next.push({ ...item, id: newId('sg'), createdAt: new Date().toISOString() })
      }
      // Everything found stays until it is settled. There was a ceiling here once, and it dropped the oldest first — in an imported book, the leads, who are met in the first chapters.
      return next
    })
  }

  /**
   * Drop the suggestions the bible has caught up with: a new character who has
   * a card by now (under that name or as an alias), a new world entry that exists.
   * @returns how many were dropped.
   */
  async pruneSuggestions(): Promise<number> {
    const [characters, world] = await Promise.all([this.characters(), this.world()])
    const carded = (name: string): boolean => characters.some(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)
    const entered = (name: string): boolean => world.some(entry => sameName(entry.name, name) || entry.aliases?.some(alias => sameName(alias, name)) === true)
    let dropped = 0
    await this.updateState<Suggestion[]>(['suggestions.json'], [], current => current.filter((item) => {
      const name = typeof item.payload.name === 'string' ? item.payload.name : undefined
      const settled = name !== undefined && ((item.kind === 'new-character' && carded(name)) || (item.kind === 'new-world' && entered(name)))
      if (settled) dropped += 1
      return !settled
    }))
    return dropped
  }

  async takeSuggestion(id: string): Promise<Suggestion | undefined> {
    let taken: Suggestion | undefined
    await this.updateState<Suggestion[]>(['suggestions.json'], [], (current) => {
      taken = current.find(item => item.id === id)
      return current.filter(item => item.id !== id)
    })
    return taken
  }

  async proposals(): Promise<Proposal[]> {
    return (await this.readState<Proposal[]>('proposals.json')) ?? []
  }

  async addProposal(input: Omit<Proposal, 'id' | 'createdAt' | 'status'>): Promise<Proposal> {
    const proposal: Proposal = { ...input, id: newId('pp'), status: 'pending', createdAt: new Date().toISOString() }
    await this.updateState<Proposal[]>(['proposals.json'], [], (current) => {
      // What is waiting is all kept; of what was settled, the latest stay as a record.
      const settled = current.filter(item => item.status !== 'pending').slice(-SETTLED_PROPOSALS_KEPT)
      return [...settled, ...current.filter(item => item.status === 'pending'), proposal]
    })
    return proposal
  }

  async setProposalStatus(id: string, status: Proposal['status']): Promise<Proposal | undefined> {
    let found: Proposal | undefined
    await this.updateState<Proposal[]>(['proposals.json'], [], current => current.map((item) => {
      if (item.id !== id) return item
      found = { ...item, status }
      return found
    }))
    return found
  }

  async review(chapterId: string): Promise<ChapterReview | undefined> {
    return await this.readState<ChapterReview>('reviews', `${chapterId}.json`)
  }

  async saveReview(review: ChapterReview): Promise<void> {
    await this.writeState(['reviews', `${review.chapterId}.json`], review)
  }

  async removeReview(chapterId: string): Promise<boolean> {
    if ((await this.review(chapterId)) === undefined) return false
    await this.removeState('reviews', `${chapterId}.json`)
    return true
  }

  // ───────────── stage documents ─────────────

  async audioScript(chapterId: string): Promise<AudioScript | undefined> {
    return await this.readState<AudioScript>('audio', `${chapterId}.json`)
  }

  async saveAudioScript(script: AudioScript, notify = true): Promise<void> {
    await this.writeState(['audio', `${script.chapterId}.json`], script, notify)
  }

  /** Take a chapter's audio script away; the takes spoken for it stay on disk, where a script made again finds them. */
  async removeAudioScript(chapterId: string): Promise<boolean> {
    if ((await this.audioScript(chapterId)) === undefined) return false
    await this.removeState('audio', `${chapterId}.json`)
    return true
  }

  /** The book's voice sheet: who was cast with which voice, and how each voice sounds. */
  async voiceCast(): Promise<VoiceCast | undefined> {
    return await this.readState<VoiceCast>('voices.json')
  }

  /** Change the voice sheet under its lock; several renders may be casting at once. */
  async updateVoiceCast(fallback: VoiceCast, mutate: (current: VoiceCast) => VoiceCast): Promise<VoiceCast> {
    return await this.updateState<VoiceCast>(['voices.json'], fallback, mutate)
  }

  async comicBoard(chapterId: string): Promise<ComicBoard | undefined> {
    return await this.readState<ComicBoard>('comic', `${chapterId}.json`)
  }

  async saveComicBoard(board: ComicBoard, notify = true): Promise<void> {
    await this.writeState(['comic', `${board.chapterId}.json`], board, notify)
  }

  /** Take a chapter's storyboard away; the pictures drawn for it stay in the gallery. */
  async removeComicBoard(chapterId: string): Promise<boolean> {
    if ((await this.comicBoard(chapterId)) === undefined) return false
    await this.removeState('comic', `${chapterId}.json`)
    return true
  }

  /** Delete a file under `assets/`. @returns whether there was one. */
  async removeAsset(relativePath: string): Promise<boolean> {
    const path = this.path('assets', relativePath)
    if (!(await this.has(this.relative(path)))) return false
    await this.remove(path)
    return true
  }

  /**
   * What of the book there is to read, hear and watch — counted for the shelf,
   * so cheaply: the chapters as the outline has them, and one look at each
   * script, storyboard and video that exists.
   */
  async shows(): Promise<BookShows> {
    const chapters = await this.chapterInfos()
    const order = new Map(chapters.map((chapter, index) => [chapter.id, index]))
    const count = (ids: string[]): ShowCount | undefined => {
      const known = ids.filter(id => order.has(id)).sort((left, right) => order.get(left)! - order.get(right)!)
      return known.length > 0 ? { chapters: known.length, first: known[0]! } : undefined
    }
    const stored = async (part: string): Promise<string[]> => (await this.files.listDir(this.statePath(part)).catch(() => [] as string[])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length))
    const [scripts, boards, videos] = await Promise.all([stored('audio'), stored('comic'), stored('video')])
    const spoken: string[] = []
    for (const id of scripts) if ((await this.audioScript(id))?.lines.some(line => line.audio !== undefined) === true) spoken.push(id)
    const drawn = new Set<string>()
    for (const id of boards) if ((await this.comicBoard(id))?.panels.some(panel => panel.image !== undefined) === true) drawn.add(id)
    for (const id of videos) {
      const record = await this.readState<{ path?: string }>('video', `${id}.json`)
      if (record?.path !== undefined && await this.has(record.path)) drawn.add(id)
    }
    const read = count(chapters.filter(chapter => chapter.hasText).map(chapter => chapter.id))
    const listen = count(spoken)
    const watch = count([...drawn])
    return { ...(read !== undefined ? { read } : {}), ...(listen !== undefined ? { listen } : {}), ...(watch !== undefined ? { watch } : {}) }
  }

  async playSessions(): Promise<PlaySession[]> {
    const names = (await this.files.listDir(this.statePath('play'))).filter(name => name.endsWith('.json'))
    const sessions: PlaySession[] = []
    for (const name of names) {
      const session = await this.readState<PlaySession>('play', name)
      if (session !== undefined) sessions.push(session)
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async playSession(id: string): Promise<PlaySession | undefined> {
    if (!/^[\w-]+$/.test(id)) return undefined
    return await this.readState<PlaySession>('play', `${id}.json`)
  }

  async savePlaySession(session: PlaySession): Promise<void> {
    await this.writeState(['play', `${session.id}.json`], { ...session, updatedAt: new Date().toISOString() })
  }

  async deletePlaySession(id: string): Promise<void> {
    if (/^[\w-]+$/.test(id)) await this.removeState('play', `${id}.json`)
  }

  async illustrations(): Promise<IllustrationInfo[]> {
    return (await this.readState<IllustrationInfo[]>('illustrations.json')) ?? []
  }

  /**
   * The picture that stands for the book: the one the author chose, else the
   * latest cover drawn. A chosen picture that no longer exists is not a cover.
   */
  async cover(): Promise<string | undefined> {
    const chosen = (await this.manifest()).cover
    if (chosen !== undefined && chosen.length > 0 && await this.has(chosen)) return chosen
    const drawn = (await this.illustrations()).filter(item => item.kind === 'cover').at(-1)?.path
    return drawn !== undefined && await this.has(drawn) ? drawn : undefined
  }

  async addIllustration(info: IllustrationInfo): Promise<void> {
    await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], current => [...current, info])
  }

  async removeIllustration(id: string): Promise<void> {
    let path: string | undefined
    await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], (current) => {
      path = current.find(item => item.id === id)?.path
      return current.filter(item => item.id !== id)
    })
    if (path !== undefined) await this.remove(this.path(path))
  }

  // ───────────── aggregate ─────────────

  /**
   * Everyone's life along one line of the plot: the chapters each character
   * is in, with what the chapter's digest noted of them — read off the digests
   * of the chapters on that line's path, and nothing else.
   * @param line - a line by id or title; the main line when left out.
   */
  async lives(line?: string): Promise<{ chapters: { id: string; index: number; title: string; digested: boolean }[]; lives: Record<string, Life> }> {
    const path = await this.chapters(line)
    const characters = await this.characters()
    const byCharacter = new Map<string, { chapter: string; index: number; moment: CharacterMoment }[]>()
    const digested = new Set<string>()
    for (const { chapter, memory } of await this.memories(path)) {
      digested.add(chapter.plan.id)
      const here = new Set<string>()
      for (const moment of memory.characters) {
        const card = characters.find(candidate => candidate.id === moment.character) ?? characters.find(candidate => sameName(candidate.name, moment.name) || candidate.aliases?.some(alias => sameName(alias, moment.name)) === true)
        // One note per character and chapter: a digest that names somebody twice (by name and by an alias) says one thing.
        if (card === undefined || here.has(card.id)) continue
        here.add(card.id)
        byCharacter.set(card.id, [...(byCharacter.get(card.id) ?? []), { chapter: chapter.plan.id, index: chapter.index, moment }])
      }
    }
    const lives: Record<string, Life> = {}
    for (const [id, moments] of byCharacter) lives[id] = lifeOf(moments)
    return { chapters: path.map(chapter => ({ id: chapter.plan.id, index: chapter.index, title: chapter.plan.title, digested: digested.has(chapter.plan.id) })), lives }
  }

  /**
   * The world as a line of the plot leaves it (`shared/worldline.ts`): everybody
   * the digests along it name, as they stand at its end, and the threads it
   * planted and paid off. Read off the digests; a chapter not digested says nothing.
   * @param line - the line's id; the main line when left out.
   * @throws ProjectError `novel/not-found` when no line has that id.
   */
  async lineWorld(line?: string): Promise<LineWorld> {
    const outline = await this.outline()
    const info = line !== undefined && line !== MAIN_LINE ? outline.lines?.find(candidate => candidate.id === line) : undefined
    const [infos, told, cards, memories] = await Promise.all([this.chapterInfos(line), this.lives(line), this.characters(), this.chapters(line).then(path => this.memories(path))])
    // As far as the line is known: the last chapter of it there is a digest of. Counted to the end of a line whose later
    // chapters nobody has read yet, everyone would be "away".
    const end = Math.max(0, ...memories.map(entry => entry.chapter.index))
    // What each came to know, chapter by chapter, as the digests noted it.
    const learned = new Map<string, NonNullable<LinePerson['learned']>>()
    for (const { chapter, memory } of memories) {
      for (const moment of memory.characters) {
        if (moment.learned === undefined || moment.learned.length === 0) continue
        const card = cards.find(candidate => candidate.id === moment.character) ?? cards.find(candidate => sameName(candidate.name, moment.name) || candidate.aliases?.some(alias => sameName(alias, moment.name)) === true)
        if (card === undefined) continue
        const known = learned.get(card.id) ?? []
        for (const what of moment.learned) if (what.trim().length > 0 && !known.some(item => item.what === what.trim())) known.push({ index: chapter.index, chapter: chapter.plan.id, what: what.trim() })
        learned.set(card.id, known)
      }
    }
    const people: LinePerson[] = []
    for (const card of castOrder(cards, await this.presence(), infos.map(chapter => chapter.id))) {
      const life = told.lives[card.id]
      const last = life?.events.at(-1)
      if (life === undefined || last === undefined || life.first === undefined) continue
      people.push({
        id: card.id,
        name: card.name,
        role: card.role,
        // Where the digests of the line end: somebody not seen for its last chapters is away, not gone.
        status: statusAt(life, end),
        first: life.first,
        last: last.index,
        lastChapter: last.chapter,
        ...(life.death !== undefined ? { death: life.death } : {}),
        ...(life.exit !== undefined ? { exit: life.exit } : {}),
        ...(last.where !== undefined ? { where: last.where } : {}),
        ...(last.state !== undefined ? { state: last.state } : {}),
        chapters: life.events.length,
        ...(learned.has(card.id) ? { learned: learned.get(card.id)! } : {}),
      })
    }
    const threads = new Map<string, LineThread>()
    for (const { chapter, memory } of memories) {
      for (const touch of memory.threads) {
        const title = touch.title.trim()
        const key = touch.threadId ?? title.toLowerCase().replace(/\s+/g, '')
        if (key.length === 0) continue
        const known = outline.threads.find(thread => thread.id === touch.threadId)
        const entry = threads.get(key) ?? { key, title: known?.title ?? title, state: 'open' as const, planted: chapter.index, last: chapter.index, lastChapter: chapter.plan.id, touches: 0 }
        entry.touches += 1
        entry.last = chapter.index
        entry.lastChapter = chapter.plan.id
        // The last word along the line decides: a thread taken up again after a payoff is open again.
        entry.state = touch.action === 'payoff' ? 'paid' : 'open'
        threads.set(key, entry)
      }
    }
    return {
      line: info?.id ?? MAIN_LINE,
      ...(info !== undefined ? { title: info.title } : {}),
      path: infos.map(chapter => ({ id: chapter.id, index: chapter.index, title: chapter.title, hasText: chapter.hasText, digested: chapter.digested })),
      people,
      threads: [...threads.values()].sort((one, other) => one.planted - other.planted),
    }
  }

  private seenAt: { revision: number; value: WorldPresence[] } | undefined

  /** Where each entry of the bible is named, and how many chapters there are to name it in. */
  async worldPresence(): Promise<{ presence: WorldPresence[]; written: number }> {
    const chapters = await this.chapterInfos()
    return { presence: await this.worldSeen(await this.world(), chapters), written: chapters.filter(chapter => chapter.hasText).length }
  }

  /**
   * Where each entry of the bible is named: in the text of which chapters, by
   * its name or another of its names, and where a digest wrote a place down.
   * Read once per state of the book — the whole manuscript is gone through.
   */
  private async worldSeen(world: readonly WorldEntry[], chapters: readonly ChapterInfo[]): Promise<WorldPresence[]> {
    if (this.seenAt?.revision === this.revisionValue) return this.seenAt.value
    const revision = this.revisionValue
    const written = chapters.filter(chapter => chapter.hasText)
    const texts = await Promise.all(written.map(async chapter => ({ id: chapter.id, text: await this.chapterText(chapter.id) })))
    const noted = new Map<string, readonly string[]>()
    for (const { chapter, memory } of await this.memories()) if (memory.locations !== undefined) noted.set(chapter.plan.id, memory.locations)
    const value = worldPresence(world, texts, noted)
    this.seenAt = { revision, value }
    return value
  }

  /** Which chapters each character appears in, from chapter memories. */
  async presence(): Promise<CastPresence[]> {
    return (await this.castFacts()).presence
  }

  /**
   * Who is on the page, card by card — and who the chapters come back to
   * that has no card at all: in a book whose import was cut short, or whose
   * author never settled what the digests found, that is where the leads are.
   */
  private async castFacts(): Promise<{ presence: CastPresence[]; uncarded: { count: number; names: string[] } }> {
    const memories = await this.memories()
    const characters = await this.characters()
    const digested = memories.map(entry => entry.chapter.plan.id)
    const byCharacter = new Map<string, string[]>()
    const strangers = new Map<string, { name: string; chapters: number }>()
    for (const { chapter, memory } of memories) {
      const here = new Set<string>()
      for (const moment of memory.characters) {
        const card = characters.find(candidate => candidate.id === moment.character) ?? characters.find(candidate => sameName(candidate.name, moment.name) || candidate.aliases?.some(alias => sameName(alias, moment.name)) === true)
        if (card === undefined) {
          const key = moment.name.trim().toLowerCase()
          if (key.length === 0 || key.length > 24 || here.has(key)) continue
          here.add(key)
          const entry = strangers.get(key) ?? { name: moment.name.trim(), chapters: 0 }
          entry.chapters += 1
          strangers.set(key, entry)
          continue
        }
        const list = byCharacter.get(card.id) ?? []
        if (!list.includes(chapter.plan.id)) list.push(chapter.plan.id)
        byCharacter.set(card.id, list)
      }
    }
    const presence = characters.map((card) => {
      const chapters = byCharacter.get(card.id) ?? []
      const last = chapters.at(-1)
      const absentFor = last === undefined ? digested.length : digested.length - 1 - digested.indexOf(last)
      return { character: card.id, chapters, absentFor }
    })
    // Coming back is what makes a part: three chapters in a long book, two in a short one.
    const least = digested.length > 12 ? 3 : 2
    const recurring = [...strangers.values()].filter(entry => entry.chapters >= least).sort((left, right) => right.chapters - left.chapters)
    return { presence, uncarded: { count: recurring.length, names: recurring.slice(0, 6).map(entry => entry.name) } }
  }

  /** The passes of an analysis (an import's) that was started on this book and not finished. */
  async analysisPending(): Promise<AnalyzeStep[]> {
    const note = await this.readState<{ schema?: number; done?: AnalyzeStep[] }>('analysis.json')
    if (note === undefined) return []
    // An analysis from before a pass existed never had it to do.
    return analysisSteps(note.schema).filter(step => note.done?.includes(step) !== true)
  }

  async state(): Promise<ProjectState> {
    const [manifest, outline, chapters, characters, world, styles, suggestions, proposals, cast, cover, activity, pending, removed] = await Promise.all([
      this.manifest(), this.outline(), this.chapterInfos(), this.characters(), this.world(), this.styles(),
      this.suggestions(), this.proposals(), this.castFacts(), this.cover(), this.activity(20), this.analysisPending(), this.removedChapters(),
    ])
    const presence = cast.presence
    const lines: PlotLineInfo[] = []
    for (const line of outline.lines ?? []) {
      const path = await this.chapterInfos(line.id)
      lines.push({ id: line.id, chapters: path.filter(info => info.line === line.id), path: path.map(info => info.id) })
    }
    const stats: ProjectStats = {
      words: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
      chapters: chapters.length,
      chaptersWithText: chapters.filter(chapter => chapter.hasText).length,
      characters: characters.length,
      worldEntries: world.length,
      openThreads: outline.threads.filter(thread => thread.status === 'open').length,
      pendingProposals: proposals.filter(proposal => proposal.status === 'pending').length,
      pendingSuggestions: suggestions.length,
      undigested: chapters.filter(chapter => chapter.hasText && !chapter.digested).length,
    }
    return {
      root: this.root,
      revision: this.revision,
      manifest,
      outline,
      chapters,
      // Listed by the weight of the part and by presence, not by file name: what every page shows first is who carries the story.
      characters: castOrder(characters, presence, chapters.map(chapter => chapter.id)),
      world,
      styles,
      stats,
      suggestions,
      proposals: proposals.filter(proposal => proposal.status === 'pending'),
      presence,
      ...(cover !== undefined ? { cover } : {}),
      activity,
      ...(lines.length > 0 ? { lines } : {}),
      ...(pending.length > 0 ? { analysis: { pending } } : {}),
      ...(cast.uncarded.count > 0 ? { uncarded: cast.uncarded } : {}),
      ...(removed.length > 0 ? { removed } : {}),
      worldPresence: await this.worldSeen(world, chapters),
      ties: await this.ties(),
    }
  }

  // ───────────── activity ─────────────

  /** What changed the book lately, newest first. */
  async activity(limit = 40): Promise<ActivityEntry[]> {
    return ((await this.readState<ActivityEntry[]>('activity.json')) ?? []).slice(0, limit)
  }

  /** Put a change on the record. The newest five thousand are kept. */
  async addActivity(entry: Omit<ActivityEntry, 'id' | 'at'>): Promise<ActivityEntry> {
    const record: ActivityEntry = { id: newId('act'), at: new Date().toISOString(), ...entry, summary: entry.summary.replace(/\s+/g, ' ').trim().slice(0, 240) }
    await this.updateState<ActivityEntry[]>(['activity.json'], [], current => [record, ...current].slice(0, ACTIVITY_KEPT))
    return record
  }

  /** Whether a file or folder exists inside the project. */
  async has(relativePath: string): Promise<boolean> {
    return await this.files.exists(this.path(relativePath)).catch(() => false)
  }

  /**
   * The bytes of one of the book's files, by its path inside the book — read
   * through the book's key when it is sealed.
   * @throws an ENOENT error when there is no such file.
   */
  async readFile(relativePath: string): Promise<Buffer> {
    const data = await this.files.readBytes(this.path(relativePath))
    if (data === undefined) throw Object.assign(new Error(`no such file in the book: ${relativePath}`), { code: 'ENOENT' })
    return data
  }

  /** Write one of the book's files by its path inside the book. @returns the project-relative path. */
  async writeFile(relativePath: string, data: string | Uint8Array): Promise<string> {
    const path = this.path(relativePath)
    await this.write(path, data)
    return this.relative(path)
  }

  /** Size and modification time of a file of the book, or undefined when there is none. */
  async fileInfo(relativePath: string): Promise<{ size: number; mtime: number } | undefined> {
    const path = this.path(relativePath)
    const size = await this.files.sizeOf(path)
    return size !== undefined ? { size, mtime: await this.files.mtimeOf(path) } : undefined
  }

  /** Whether the book's files are encrypted where they lie. */
  get sealed(): boolean {
    return this.files.sealed
  }
}

// ───────────── helpers ─────────────

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  if (value === undefined) return {}
  if (typeof value === 'string' && value.trim().length === 0) return {}
  return { [key]: value } as Record<K, V>
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry
  return out as T
}

/**
 * Merge a patch into a card: undefined keeps, `null` or an empty string/array
 * clears, a nested record is merged field by field, everything else replaces.
 */
export function mergeCard<T extends object>(base: T, patch: Partial<Record<keyof T, unknown>>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value === null || (typeof value === 'string' && value.trim().length === 0) || (Array.isArray(value) && value.length === 0)) {
      delete out[key]
      continue
    }
    // A patch to a nested record (visual, voiceProfile, persona) changes the fields it names and keeps the rest:
    // setting a visual anchor must not lose the portrait that sits beside it.
    const current = out[key]
    if (isPlainRecord(value)) {
      const nested = mergeCard<Record<string, unknown>>(isPlainRecord(current) ? current : {}, value)
      if (Object.keys(nested).length === 0) delete out[key]
      else out[key] = nested
      continue
    }
    out[key] = typeof value === 'string' ? value.trim() : value
  }
  return out as T
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Bring a character's looks (outfits) into the shape everything else relies
 * on. Every look ends up with an id and a name. A look that was on the card
 * before — the same id, or the same name — keeps what the new version does not
 * mention, above all the design sheet drawn for it; an empty string clears a field.
 * @param incoming - the looks as written by the author, a model or a file.
 * @param existing - the looks on the card before this save.
 */
export function reconcileLooks(incoming: unknown, existing: readonly CharacterLook[] = []): CharacterLook[] {
  if (!Array.isArray(incoming)) return []
  const out: CharacterLook[] = []
  for (const raw of incoming) {
    if (!isPlainRecord(raw)) continue
    const given = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : undefined
    const named = typeof raw.name === 'string' ? raw.name.trim() : ''
    const before = (given !== undefined ? existing.find(look => look.id === given) : undefined)
      ?? (named.length > 0 ? existing.find(look => sameName(look.name, named)) : undefined)
    const name = named.length > 0 ? named : before?.name ?? ''
    if (name.length === 0) continue
    let id = given ?? before?.id ?? slugify(name, '')
    if (id.length === 0) id = newId('look')
    while (out.some(look => look.id === id)) id = `${id}-2`
    const field = (key: 'prompt' | 'when' | 'sheet'): string | undefined => {
      const value = raw[key]
      if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : undefined
      return value === null ? undefined : before?.[key]
    }
    const prompt = field('prompt')
    const when = field('when')
    const sheet = field('sheet')
    out.push({ id, name, ...(prompt !== undefined ? { prompt } : {}), ...(when !== undefined ? { when } : {}), ...(sheet !== undefined ? { sheet } : {}) })
  }
  return out
}

/**
 * Add looks to the ones a character has, or update them, without touching the
 * rest: how a model edits a wardrobe, since it names the looks it means and
 * not the whole list. An entry with `remove: true` takes its look away.
 */
export function upsertLooks(existing: readonly CharacterLook[], changes: unknown): CharacterLook[] {
  if (!Array.isArray(changes)) return [...existing]
  const list: Record<string, unknown>[] = existing.map(look => ({ ...look }))
  for (const raw of changes) {
    if (!isPlainRecord(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const at = list.findIndex(look => (id.length > 0 && look.id === id) || (name.length > 0 && typeof look.name === 'string' && sameName(look.name, name)))
    if (raw.remove === true) {
      if (at >= 0) list.splice(at, 1)
      continue
    }
    const { remove: _remove, ...change } = raw
    if (at >= 0) list[at] = { ...list[at], ...change }
    else list.push(change)
  }
  return reconcileLooks(list, existing)
}

function normalizeOutline(outline: Outline | undefined): Outline {
  const volumes = (outline?.volumes ?? []).map((volume, index) => ({
    ...volume,
    id: volume.id ?? `v${index + 1}`,
    title: volume.title ?? `Volume ${index + 1}`,
    chapters: (volume.chapters ?? []).map(chapter => ({
      ...chapter,
      title: chapter.title ?? chapter.id,
      status: chapter.status ?? 'idea',
      ...(chapter.beats !== undefined ? { beats: chapter.beats.map(beat => ({ ...beat, id: beat.id ?? newId('b') })) } : {}),
    })),
  }))
  if (volumes.length === 0) volumes.push({ id: 'v1', title: 'Volume 1', chapters: [] })
  const lines = (outline?.lines ?? []).map(line => ({
    ...line,
    id: line.id ?? newId('ln'),
    title: line.title ?? 'Line',
    origin: line.origin ?? 'author' as const,
    createdAt: line.createdAt ?? new Date().toISOString(),
    chapters: (line.chapters ?? []).map(normalizeChapter),
  }))
  return { schema: 1, volumes, threads: outline?.threads ?? [], ...(lines.length > 0 ? { lines } : {}) }
}

function normalizeChapter(chapter: ChapterPlan): ChapterPlan {
  return {
    ...chapter,
    title: chapter.title ?? chapter.id,
    status: chapter.status ?? 'idea',
    ...(chapter.beats !== undefined ? { beats: chapter.beats.map(beat => ({ ...beat, id: beat.id ?? newId('b') })) } : {}),
  }
}

/** Every list of chapters an outline has: each volume's, each line's. */
function holders(outline: Outline): { chapters: ChapterPlan[] }[] {
  return [...outline.volumes, ...(outline.lines ?? [])]
}

/** The line a name stands for: undefined for the main one. @throws ProjectError when no line has that id. */
function lineOf(outline: Outline, line: string | undefined): PlotLine | undefined {
  if (line === undefined || line === MAIN_LINE) return undefined
  const found = (outline.lines ?? []).find(candidate => candidate.id === line)
  if (found === undefined) throw new ProjectError('novel/not-found', `no plot line "${line}"`)
  return found
}

/** The line a chapter belongs to: `null` for the main line, undefined when the outline has no such chapter. */
function homeOf(outline: Outline, chapterId: string): PlotLine | null | undefined {
  for (const volume of outline.volumes) if (volume.chapters.some(chapter => chapter.id === chapterId)) return null
  for (const line of outline.lines ?? []) if (line.chapters.some(chapter => chapter.id === chapterId)) return line
  return undefined
}

interface Placed {
  plan: ChapterPlan
  volume: Volume
  line?: string
}

/**
 * The chapters read on a line, in order: what comes before it on the lines it
 * grew out of, its own, and — when it arrives somewhere — what follows there.
 */
function linePath(outline: Outline, line: PlotLine | undefined, seen: ReadonlySet<string> = new Set()): Placed[] {
  if (line === undefined) return outline.volumes.flatMap(volume => volume.chapters.map(plan => ({ plan, volume })))
  // A line that leads back to itself: stop rather than go round.
  if (seen.has(line.id)) return []
  const guard = new Set(seen).add(line.id)
  const out: Placed[] = []
  if (line.from !== undefined) {
    const home = homeOf(outline, line.from)
    if (home !== undefined) {
      const before = linePath(outline, home ?? undefined, guard)
      out.push(...before.slice(0, before.findIndex(entry => entry.plan.id === line.from) + 1))
    }
  }
  const volume = out.at(-1)?.volume ?? outline.volumes[0]!
  for (const plan of line.chapters) out.push({ plan, volume, line: line.id })
  if (line.into !== undefined) {
    const home = homeOf(outline, line.into)
    if (home !== undefined) {
      const rest = linePath(outline, home ?? undefined, guard)
      const at = rest.findIndex(entry => entry.plan.id === line.into)
      if (at >= 0) for (const entry of rest.slice(at)) if (!out.some(known => known.plan.id === entry.plan.id)) out.push(entry)
    }
  }
  return out
}

function located(path: Placed[]): LocatedChapter[] {
  return path.map((entry, at) => ({ ...entry, index: at + 1 }))
}


function insertChapter(draft: Outline, plan: ChapterPlan, where: ChapterPlace): void {
  const anchor = where.before ?? where.after
  if (anchor !== undefined) {
    // Beside a chapter means on that chapter's line, whichever it is.
    for (const holder of holders(draft)) {
      const at = holder.chapters.findIndex(chapter => chapter.id === anchor)
      if (at < 0) continue
      holder.chapters.splice(where.before !== undefined ? at : at + 1, 0, plan)
      return
    }
  }
  const line = lineOf(draft, where.line)
  if (line !== undefined) {
    line.chapters.push(plan)
    return
  }
  const volume = draft.volumes.find(candidate => candidate.id === where.volume || (where.volume !== undefined && sameName(candidate.title, where.volume))) ?? draft.volumes.at(-1)!
  volume.chapters.push(plan)
}

function promote(status: ChapterStatus): ChapterStatus {
  return status === 'idea' || status === 'outlined' ? 'drafted' : status
}

function defaultStyle(zh: boolean): StyleProfile {
  return zh
    ? {
        id: 'default',
        name: '默认文风',
        pov: 'third-limited',
        tense: 'past',
        tone: '克制、具体、有画面感，情绪藏在动作与细节里',
        diction: '现代白话，用词准确，少用成语堆砌与四字套话',
        rhythm: '长短句交错；动作场面用短句，心理与环境可以舒缓',
        imagery: '比喻要少而准，优先写可感知的细节（声音、气味、温度、触感）',
        dialogue: '对白口语化、各有腔调，避免人物替作者解释设定；少用"说道"以外的花哨提示语',
        pacing: '每个场景都要有推进：新的信息、新的选择或关系的变化',
        rules: ['展示而非告知：用行动和细节呈现情绪', '每章结尾留下一个向前的钩子', '严格遵守设定集与前文事实'],
        avoid: ['"不由得""仿佛""似乎"等口头禅式虚词连用', '总结式、升华式的段落结尾', '排比抒情与空泛感叹', '"命运的齿轮开始转动"之类的陈词滥调'],
      }
    : {
        id: 'default',
        name: 'Default style',
        pov: 'third-limited',
        tense: 'past',
        tone: 'Restrained and concrete; emotion lives in action and detail',
        diction: 'Plain, precise modern prose; no purple vocabulary',
        rhythm: 'Vary sentence length; short sentences for action, room to breathe for interiority',
        imagery: 'Few, exact metaphors; favor sensory detail over abstraction',
        dialogue: 'Natural and distinct per speaker; no exposition disguised as speech; plain dialogue tags',
        pacing: 'Every scene moves something: new information, a choice, or a shift in a relationship',
        rules: ['Show, do not tell', 'End each chapter on a forward hook', 'Never contradict the story bible or earlier chapters'],
        avoid: ['Summarizing or moralizing paragraph endings', 'Stock phrases and clichés', 'Filter words stacked together ("seemed to", "couldn\'t help but")'],
      }
}

function stateReadme(zh: boolean): string {
  return zh
    ? '# .novel\n\n这里是小说工坊维护的机器记忆：章节摘要与事实（memory/）、版本快照（versions/）、修订提案、审校结果、有声与分镜脚本、检索索引（index/，可随时重建）。\n\n可以纳入版本管理；`index/` 建议忽略。\n'
    : '# .novel\n\nMachine memory maintained by Novel Writer: chapter digests (memory/), version snapshots (versions/), revision proposals, reviews, audio scripts, storyboards and the search index (index/, rebuildable at any time).\n\nSafe to commit; `index/` is best ignored.\n'
}

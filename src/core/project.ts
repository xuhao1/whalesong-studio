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
import { sceneOfPicture, scenesOf } from '../shared/art'
import { figureSpots, placeFigures, spotsNear, type ChapterFigure, type PortraitPlace } from '../shared/reader'
import { mainSheetOf, sheetFronts, sheetPool } from '../shared/sheets'
import { artPool, mainArtOf } from '../shared/arts'
import { pixelsOf } from './media/pixels'
import { watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import {
  analysisSteps, type AnalyzeStep,
  belongsTo, castOrder, chapterBudgetOf, MAIN_LINE,
  type ActivityEntry, type BookShows, type DerivedPlan, type ChapterTranslation, type GlossaryTerm, type HistoryKind, type HistoryVersion, type Timestamp, type CharacterLook, type CharacterMoment, type LifeMark, type ShowCount,
  type AudioScript, type CastPresence, type ChapterInfo, type ChapterMemory, type ChapterPlan, type ChapterReview, type ChapterStatus, type CharacterCard,
  type ComicBoard, type ComicPanel, type IllustrationInfo, type MaterialKept, type Outline, type PlaySession, type PlotLine, type PlotLineInfo, type PlotLineOrigin, type PlotThread, type ProjectManifest, type ProjectState, type ProjectStats, type Proposal, type RemovedChapter,
  type SettledSuggestion, type StyleProfile, type Suggestion, type ThreadTouch, type VersionInfo, type VersionMade, type VoiceCast, type Volume, type WorldEntry,
} from '../shared/types'
import { lifeOf, statusAt, type Life } from '../shared/life'
import type { LinePerson, LineThread, LineWorld } from '../shared/worldline'
import { TIE_ENDS, TIE_KINDS, type Tie, type TieEnd } from '../shared/ties'
import { worldPresence, type WorldPresence } from '../shared/world'
import { countWords, hashText, newId, normalizeProse, proseOnly, sameName, slugify, fuzzyFind } from '../shared/text'
import { KeyedMutex } from './util/async'
import {
  containedPath, ensureDir, exists, listDir, mtimeOf, readJson, readText, relativePosix, removePath, writeAtomic, writeJson,
} from './util/fs'
import { parseFrontMatter, renderFrontMatter } from './util/frontmatter'
import { changedBy, changing } from './cause'
import { getAt, isRecord, said, unversioned } from '../shared/history'
import { PlainFiles, readStub, SealedFiles, type FileStore } from './util/vault'
import { threadWithout } from './plans'

export const MANIFEST_FILE = 'novel.json'
const OUTLINE_FILE = 'outline.json'
/** The ties between the things of the book's world, kept with the bible. */
const TIES_FILE = 'relations.json'
const GLOSSARY_FILE = 'glossary.json'
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

/** What a line of the plot has of the book: what whoever works on that line reads. See `Project.lineScope`. */
export interface LineScope {
  /** The line's id: `main` for the main one. */
  line: string
  /** Its name; absent for the main line. */
  title?: string
  /** What sets it apart, as the author put it. */
  premise?: string
  /** A story of its own from the first page: it parts from no other line, and what the book says its story is — the main line's — is not this one's. */
  apart: boolean
  /** The chapters read on it, in order, numbered along it. */
  path: LocatedChapter[]
  /** Whether a chapter is read on it. */
  reads: (chapterId: string) => boolean
  /** Whether somebody is one of its people: as the author said, else as the chapters have them (`ofLine`). */
  has: (card: Pick<CharacterCard, 'id' | 'lines'>) => boolean
  /**
   * Whether something of the world is its to know: all of the world, but for what is filed under other lines — by the
   * author, or because a digest of another line found it there. (Not by where the text happens to name it: an entry the
   * whole book stands on may be spelled out on one line only.)
   */
  knows: (entry: Pick<WorldEntry, 'lines'>) => boolean
  /** The threads that are its own — planted, taken up or planned on it, or touched by no line yet — and whether each still waits at its end. */
  threads: { thread: PlotThread; open: boolean }[]
  /** How many lines the book has beside this one. */
  others: number
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
/** Versions that are kept of a chapter's text, and of any one card, entry or plan: enough that nobody meets the end of them while writing a book. */
const VERSIONS_KEPT = 400
/** Why a chapter's text was kept when it is the text a translation took the place of. */
export const ORIGINAL_REASON = 'before-translate'
/** The author's own saves of a card are kept as versions at most this often: the version before a sitting, not one a press. */
const EDIT_WINDOW_MS = 5 * 60_000

/** When a version's file says it was made (`2026-10-10T07-10-00-000Z`), as a time. */
const isoOf = (stamp: string): string => stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4')

/** What a file kept beside a version says of how the version was made; nothing where it says nothing that can be read. */
function madeOf(raw: string | undefined): VersionMade | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  try {
    const said = JSON.parse(raw) as Partial<VersionMade> | null
    if (said === null || typeof said !== 'object' || said.how !== 'trial' || typeof said.model !== 'string' || typeof said.provider !== 'string') return undefined
    return {
      how: 'trial',
      label: typeof said.label === 'string' && said.label.length > 0 ? said.label : said.model,
      provider: said.provider,
      model: said.model,
      ...(typeof said.effort === 'string' && said.effort.length > 0 ? { effort: said.effort } : {}),
      ...(typeof said.round === 'string' && said.round.length > 0 ? { round: said.round } : {}),
      ...(typeof said.brief === 'string' && said.brief.length > 0 ? { brief: said.brief } : {}),
      ...(said.material !== undefined && said.material !== null && typeof said.material === 'object' && (said.material.by === 'planner' || said.material.by === 'rules') && typeof said.material.tokens === 'number' ? { material: said.material } : {}),
    }
  } catch {
    return undefined
  }
}

/** Put something at a path of a thing, making the way there; nothing put there takes what was there away. */
function setAt(value: Record<string, unknown>, path: string, put: unknown): void {
  const keys = path.split('.')
  let at = value
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(at[key])) {
      if (put === undefined) return
      at[key] = {}
    }
    at = at[key] as Record<string, unknown>
  }
  const last = keys.at(-1)!
  if (put === undefined) delete at[last]
  else at[last] = structuredClone(put)
}

/** A field of `next` that a version is not about, made what it is in `now`: by the same element of a list where the field lies in one (told by its id, else by its place). */
function carry(now: Record<string, unknown>, next: Record<string, unknown>, path: string): void {
  if (!path.includes('[].')) {
    setAt(next, path, getAt(now, path))
    return
  }
  const [head, ...rest] = path.split('[].')
  const [mine, theirs] = [getAt(next, head!), getAt(now, head!)]
  if (!Array.isArray(mine)) return
  const tail = rest.join('[].')
  mine.forEach((item, index) => {
    if (!isRecord(item)) return
    const same = Array.isArray(theirs) ? (theirs.find(other => isRecord(other) && other.id !== undefined && other.id === item.id) ?? (item.id === undefined ? theirs[index] : undefined)) : undefined
    // An element the thing no longer has keeps the picture its version names: it may well still be there.
    if (isRecord(same)) carry(same, item, tail)
  })
}

const SETTLED_PROPOSALS_KEPT = 500

/**
 * What a portrait of somebody is of: one of their moments (the scene that keeps it, or what its record says it was
 * drawn of), a stretch of their life, or the person — a likeness, of no moment in particular.
 */
export function portraitIsOf(card: Pick<CharacterCard, 'visual' | 'stages'>, path: string, record: IllustrationInfo | undefined): 'moment' | 'stage' | 'person' {
  if (record?.moment !== undefined || scenesOf(card).some(scene => scene.portrait === path)) return 'moment'
  if (sceneOfPicture(scenesOf(card), path, record) !== undefined) return 'moment'
  return (card.stages ?? []).some(stage => stage.visual?.portrait === path) ? 'stage' : 'person'
}

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

  // Records kept beside the book under `.novel/` that are no part of it as its pages show it (the record of calls):
  // written, read and removed without anybody's page loading anew, and never held in memory once read.

  async readRecord<T>(...parts: string[]): Promise<T | undefined> {
    return await this.files.readJson<T>(this.statePath(...parts))
  }

  /** @returns the bytes the document takes. */
  async writeRecord(parts: string[], value: unknown): Promise<number> {
    const text = `${JSON.stringify(value)}\n`
    await this.write(this.statePath(...parts), text, false)
    return Buffer.byteLength(text)
  }

  async hasRecord(...parts: string[]): Promise<boolean> {
    return await this.files.exists(this.statePath(...parts))
  }

  async dropRecord(...parts: string[]): Promise<void> {
    const path = this.statePath(...parts)
    await this.own(path, async () => { await this.files.removePath(path) })
    this.cache.delete(path)
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

  async updateManifest(patch: Partial<ProjectManifest>, options: { /** A field named as nothing is taken away (a version put back whole), not left as it is. */ exact?: boolean } = {}): Promise<ProjectManifest> {
    const path = this.path(MANIFEST_FILE)
    return await this.mutex.run(path, async () => {
      const current = await this.manifest()
      const next: ProjectManifest = { ...current, ...stripUndefined(patch), schema: 1, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() }
      if (options.exact === true) for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[key]
      // The recommended chapter length has one home. Whoever still names the old one means the new; nothing, or zero, takes the recommendation away.
      if ('chapterBudget' in patch || 'chapterWords' in patch) {
        const wanted = (patch.chapterBudget ?? patch.chapterWords) as number | null | undefined
        delete next.chapterWords
        if (typeof wanted === 'number' && wanted > 0) next.chapterBudget = Math.round(wanted)
        else delete next.chapterBudget
      }
      // Services of the book's own named as nothing are taken off it: the Studio's hold for it again.
      for (const key of ['image', 'tts', 'sound', 'embedding', 'context', 'parallel', 'vision', 'materialBy'] as const) if ((patch as Record<string, unknown>)[key] === null) delete next[key]
      // (A way of writing that is none of the three is no way of its own.)
      if (next.materialBy !== undefined && next.materialBy !== 'planner' && next.materialBy !== 'rules' && next.materialBy !== 'agent') delete next.materialBy
      // Budgets and numbers of its own that name nothing are none of its own.
      for (const key of ['context', 'parallel'] as const) if (next[key] !== undefined && Object.values(next[key]!).every(value => value === undefined || value === null)) delete next[key]
      // A cover named as nothing is no cover named: the latest one drawn stands in again.
      if (typeof next.cover === 'string' && next.cover.trim().length === 0) delete next.cover
      // The book as it was said to be, before this: kept, where what it says has changed.
      if (said('book', current as unknown as Record<string, unknown>) !== said('book', next as unknown as Record<string, unknown>)) await this.keep('book', 'novel', `${JSON.stringify(current, null, 2)}\n`, 'json')
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
    const path = this.path('bible', dir, `${id}.md`)
    const next = renderFrontMatter(data, body)
    // As it was, before this: kept, where what it says has changed.
    const kind = dir === 'characters' ? 'character' as const : dir === 'world' ? 'world' as const : dir === 'styles' ? 'style' as const : undefined
    const before = kind !== undefined ? await this.files.readText(path) : undefined
    if (kind !== undefined && before !== undefined && before !== null) {
      const was = parseFrontMatter<Record<string, unknown>>(before)
      if (said(kind, { ...was.data, notes: was.body }) !== said(kind, { ...data, notes: body ?? '' })) await this.keep(kind, id, before, 'md')
    }
    await this.write(path, next)
  }

  // ───────────── history: how a thing was before it was changed ─────────────

  /** Whatever `work` changes in the book is on record as changed for this reason ({@link changedBy}). */
  async because<T>(why: string, work: () => Promise<T>): Promise<T> {
    return await changedBy(why, work)
  }

  /**
   * Keep a thing as it was before a change. A version is the thing *before* something changed it, named by when and
   * why it was changed. The author's own saves are kept at most once in a few minutes — the version before a sitting
   * of edits is the one to go back to, not one for every press of Save; whatever else changes a thing is kept each time.
   */
  private async keep(kind: HistoryKind, id: string, before: string, ext: 'md' | 'json'): Promise<void> {
    const why = (changing() ?? 'edit').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'edit'
    const dir = this.statePath('history', kind, id)
    if (why === 'edit') {
      // Only while the latest version is itself one of theirs: what somebody else made of the thing in between is kept.
      const last = (await this.files.listDir(dir)).filter(name => /\.(md|json)$/.test(name)).sort().at(-1)
      const at = last?.includes('__edit.') === true ? Date.parse(isoOf(last.slice(0, last.indexOf('__')))) : Number.NaN
      if (Number.isFinite(at) && Date.now() - at < EDIT_WINDOW_MS) return
    } else if (kind === 'ties') {
      // The table of ties is written a row at a time: one pass over it is one version — the table as it was before the pass began.
      const last = (await this.files.listDir(dir)).filter(name => /\.(md|json)$/.test(name)).sort().at(-1)
      const at = last?.includes(`__${why}.`) === true ? Date.parse(isoOf(last.slice(0, last.indexOf('__')))) : Number.NaN
      if (Number.isFinite(at) && Date.now() - at < EDIT_WINDOW_MS) return
    }
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}__${why}.${ext}`)
    await this.own(path, async () => { await this.files.writeAtomic(path, before) })
    const all = (await this.files.listDir(dir)).filter(name => /\.(md|json)$/.test(name)).sort()
    for (const name of all.slice(0, Math.max(0, all.length - VERSIONS_KEPT))) await this.files.removePath(join(dir, name))
  }

  /** A card as it last was, kept as it is taken out of the book: what was deleted can be had back. */
  private async keepRemoved(kind: HistoryKind, dir: string, id: string): Promise<void> {
    const text = await this.files.readText(this.path('bible', dir, `${id}.md`))
    if (text !== undefined && text !== null) await this.because('removed', async () => { await this.keep(kind, id, text, 'md') })
  }

  /** Cards and entries that were taken out of the book and are not in it now, the latest first: each can be put back from its last version. */
  async removedCards(): Promise<{ kind: HistoryKind; id: string; name: string; at: Timestamp; version: string }[]> {
    const out: { kind: HistoryKind; id: string; name: string; at: Timestamp; version: string }[] = []
    for (const [kind, dir] of [['character', 'characters'], ['world', 'world'], ['style', 'styles']] as const) {
      const here = new Set((await this.files.listDir(this.path('bible', dir)).catch(() => [] as string[])).map(name => name.replace(/\.md$/, '')))
      for (const id of await this.files.listDir(this.statePath('history', kind)).catch(() => [] as string[])) {
        if (here.has(id)) continue
        const last = (await this.history(kind, id))[0]
        if (last === undefined || last.why !== 'removed') continue
        const was = await this.historyOf(kind, id, last.id)
        out.push({ kind, id, name: typeof was?.name === 'string' ? was.name : id, at: last.at, version: last.id })
      }
    }
    return out.sort((left, right) => right.at.localeCompare(left.at))
  }

  /**
   * Throw the versions of a card or an entry away for good — one that is no longer in the book: it leaves the list
   * of what can be had back. (What is in the book keeps its history; that is what a history is for.)
   * @throws ProjectError `novel/invalid` for a thing that is in the book.
   */
  async forgetRemoved(kind: HistoryKind, id: string): Promise<void> {
    if (!/^[^/\\\0]+$/.test(id) || id === '.' || id === '..') throw new ProjectError('novel/invalid', `"${id}" names nothing a history is kept of`)
    if (await this.current(kind, id) !== undefined) throw new ProjectError('novel/invalid', `${kind} "${id}" is in the book: its history stays with it`)
    const dir = this.statePath('history', kind, id)
    for (const name of await this.files.listDir(dir)) await this.files.removePath(join(dir, name))
    await this.files.removePath(dir)
  }

  /** The versions kept of a thing, the latest first: each is the thing as it was until then. */
  async history(kind: HistoryKind, id: string): Promise<HistoryVersion[]> {
    if (!/^[^/\\\0]+$/.test(id) || id === '.' || id === '..') return []
    const names = (await this.files.listDir(this.statePath('history', kind, id)).catch(() => [] as string[])).filter(name => /\.(md|json)$/.test(name)).sort()
    return names.reverse().map((name) => {
      const stem = name.replace(/\.(md|json)$/, '')
      const [stamp, why] = stem.split('__')
      return { id: stem, kind, of: id, at: isoOf(stamp ?? ''), why: why ?? 'edit' }
    })
  }

  /** A thing as it is now, read the way one of its versions is read; nothing where it is no longer in the book. */
  async current(kind: HistoryKind, id: string): Promise<Record<string, unknown> | undefined> {
    // By its id alone: a card that is gone is not the one that now bears its name.
    if (kind === 'character') return (await this.characters()).find(card => card.id === id) as unknown as Record<string, unknown> | undefined
    if (kind === 'world') return (await this.world()).find(entry => entry.id === id) as unknown as Record<string, unknown> | undefined
    if (kind === 'style') return (await this.styles()).find(style => style.id === id) as unknown as Record<string, unknown> | undefined
    if (kind === 'book') return await this.manifest() as unknown as Record<string, unknown>
    if (kind === 'ties') return { relations: await this.ties() }
    if (kind === 'script') return await this.audioScript(id) as unknown as Record<string, unknown> | undefined
    if (kind === 'board') return await this.comicBoard(id) as unknown as Record<string, unknown> | undefined
    const outline = await this.outline()
    if (kind === 'thread') return outline.threads.find(thread => thread.id === id) as unknown as Record<string, unknown> | undefined
    if (kind === 'volume') return shelfOf(outline.volumes.find(volume => volume.id === id))
    if (kind === 'line') return shelfOf((outline.lines ?? []).find(line => line.id === id))
    return holders(outline).flatMap(holder => holder.chapters).find(plan => plan.id === id) as unknown as Record<string, unknown> | undefined
  }

  /** A thing as one of its versions has it — read the way the thing itself is read. Nothing for a version that is not there. */
  async historyOf(kind: HistoryKind, id: string, version: string): Promise<Record<string, unknown> | undefined> {
    if (!/^[\w.-]+$/.test(version) || !/^[^/\\\0]+$/.test(id) || id === '..') return undefined
    const dir = this.statePath('history', kind, id)
    const card = await this.files.readText(join(dir, `${version}.md`))
    if (card !== undefined && card !== null) {
      const { data, body } = parseFrontMatter<Record<string, unknown>>(card)
      return { ...data, id, ...(body.length > 0 ? { [kind === 'character' ? 'notes' : 'body']: body } : {}) }
    }
    const doc = await this.files.readJson<Record<string, unknown>>(join(dir, `${version}.json`))
    return doc ?? undefined
  }

  /**
   * Put a version back: the whole of it, or the fields named. What the thing is now is kept first (as changed by
   * `restore`), so that putting a version back can itself be undone. Pictures are no part of it: a card put back
   * keeps the pictures it has now — those are kept for as long as nobody deletes them, and are another matter.
   * @param fields - only these, by their path (`tagline`, `visual.prompt`); left out, everything.
   * @throws ProjectError `novel/not-found` where the thing or the version is not there.
   */
  async restoreHistory(kind: HistoryKind, id: string, version: string, fields?: readonly string[]): Promise<void> {
    const old = await this.historyOf(kind, id, version)
    if (old === undefined) throw new ProjectError('novel/not-found', `no version "${version}" of ${kind} "${id}"`)
    const some = fields !== undefined && fields.length > 0 ? fields : undefined
    /** The thing as it is now, with what the version has in the fields asked for — and the pictures of now. */
    const mixed = (now: Record<string, unknown>): Record<string, unknown> => {
      const next = some === undefined ? structuredClone(old) : structuredClone(now)
      if (some !== undefined) for (const field of some) setAt(next, field, getAt(old, field))
      for (const path of unversioned(kind)) carry(now, next, path)
      return next
    }
    await this.because('restore', async () => {
      if (kind === 'character' || kind === 'world' || kind === 'style') {
        const dir = kind === 'character' ? 'characters' : kind === 'world' ? 'world' : 'styles'
        await this.mutex.run(dir, async () => {
          const path = this.path('bible', dir, `${id}.md`)
          const text = await this.files.readText(path)
          // Gone since: the version is the thing again (a card that was deleted comes back as it last was).
          const now = text !== undefined && text !== null ? parseFrontMatter<Record<string, unknown>>(text) : { data: {} as Record<string, unknown>, body: '' }
          // The text below the front matter, by the name the thing has for it.
          const key = kind === 'character' ? 'notes' : 'body'
          const { [key]: body, ...data } = mixed({ ...now.data, id, [key]: now.body }) as Record<string, unknown>
          await this.saveCard(dir, id, { ...data, id, updatedAt: new Date().toISOString() }, typeof body === 'string' ? body : undefined)
        })
        return
      }
      if (kind === 'book') {
        const now = await this.manifest() as unknown as Record<string, unknown>
        const { id: _id, schema: _schema, createdAt: _created, updatedAt: _updated, ...patch } = mixed(now)
        // What the version does not have is taken away, where everything is put back.
        if (some === undefined) for (const key of Object.keys(now)) if (!(key in patch) && !['id', 'schema', 'createdAt', 'updatedAt', 'cover'].includes(key)) (patch as Record<string, unknown>)[key] = undefined
        await this.updateManifest(patch as Partial<ProjectManifest>, { exact: true })
        return
      }
      if (kind === 'ties') {
        // Ties to what the book no longer has are not put back: they would hold on to nothing.
        const [people, things] = [new Set((await this.characters()).map(card => card.id)), new Set((await this.world()).map(entry => entry.id))]
        const there = (end: Tie['from']): boolean => (end.type === 'character' ? people : things).has(end.id)
        const were = Array.isArray(old.relations) ? (old.relations as Tie[]).filter(tie => there(tie.from) && there(tie.to)) : []
        await this.writeTies(() => were)
        return
      }
      if (kind === 'script' || kind === 'board') {
        const now = (kind === 'script' ? await this.audioScript(id) : await this.comicBoard(id)) as unknown as Record<string, unknown> | undefined
        const next = { ...mixed(now ?? {}), schema: 1, chapterId: id, updatedAt: new Date().toISOString() }
        if (kind === 'script') await this.saveAudioScript(next as unknown as AudioScript)
        else await this.saveComicBoard(next as unknown as ComicBoard)
        return
      }
      await this.updateOutline((draft) => {
        if (kind === 'volume' || kind === 'line') {
          const holder = kind === 'volume' ? draft.volumes.find(volume => volume.id === id) : (draft.lines ?? []).find(line => line.id === id)
          if (holder === undefined) throw new ProjectError('novel/not-found', `no ${kind} "${id}"`)
          const { chapters, id: _id, ...words } = mixed(shelfOf(holder)!)
          // What it is called and says, as the version has it; what the version has not, it has no longer.
          const record = holder as unknown as Record<string, unknown>
          for (const key of Object.keys(record)) if (key !== 'id' && key !== 'chapters' && key !== 'createdAt' && key !== 'origin' && key !== 'play' && !(key in words)) delete record[key]
          Object.assign(record, words)
          // Its chapters in the order the version has them — those it still holds; what came to it since stays after them.
          // (A chapter moved elsewhere since is not pulled back: where a chapter is, is a move of its own.)
          const order = Array.isArray(chapters) ? chapters.map(String) : []
          const rank = (plan: ChapterPlan): number => { const at = order.indexOf(plan.id); return at < 0 ? order.length : at }
          holder.chapters = holder.chapters.map((plan, at) => ({ plan, at })).sort((left, right) => rank(left.plan) - rank(right.plan) || left.at - right.at).map(item => item.plan)
          const knot = knotIn(draft)
          if (knot !== undefined) throw new ProjectError('novel/invalid', knot)
          return
        }
        if (kind === 'thread') {
          const at = draft.threads.findIndex(thread => thread.id === id)
          if (at < 0) throw new ProjectError('novel/not-found', `no thread "${id}"`)
          draft.threads[at] = { ...mixed(draft.threads[at] as unknown as Record<string, unknown>), id } as unknown as PlotThread
          return
        }
        for (const holder of holders(draft)) {
          const at = holder.chapters.findIndex(plan => plan.id === id)
          if (at < 0) continue
          const now = holder.chapters[at]!
          // Where the chapter stands — written, digested — is what its text is now, not what its plan once said.
          holder.chapters[at] = { ...mixed(now as unknown as Record<string, unknown>), id, status: now.status } as unknown as ChapterPlan
          return
        }
        throw new ProjectError('novel/not-found', `no chapter "${id}"`)
      })
    })
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
      // A card once carried one word for where its character stood in the book (`status`). Where somebody stands is
      // read off the digests, line by line and chapter by chapter (`lives`); the word is not read, and not written again.
      const { status: _label, ...kept } = data as typeof data & { status?: unknown }
      return {
        ...kept,
        ...visual,
        id: typeof data.id === 'string' && data.id.length > 0 ? data.id : id,
        name: typeof data.name === 'string' && data.name.length > 0 ? data.name : id,
        role: data.role ?? 'supporting',
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
  /**
   * Have one of the pictures drawn of a moment of somebody's stand for that moment: in the panel of their moments,
   * and in the text where the moment is told. The others drawn of it stay among their portraits. Taken this way a
   * picture is one like any other — one that was drawn only to be compared is no longer kept out of the text — and
   * one the gallery had of them joins their portraits.
   * @throws ProjectError `novel/not-found` for somebody or a moment that is not there.
   */
  async setScenePicture(character: string, scene: string, path: string): Promise<CharacterCard> {
    const card = await this.findCharacter(character)
    if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${character}"`)
    const kept = scenesOf(card)
    if (!kept.some(item => item.id === scene)) throw new ProjectError('novel/not-found', `"${card.name}" has no signature scene "${scene}"`)
    const listed = card.visual?.portraits ?? (card.visual?.portrait !== undefined ? [card.visual.portrait] : [])
    const saved = await this.saveCharacter({ id: card.id, visual: {
      ...(listed.includes(path) ? {} : { portraits: [...listed, path] }),
      // (The single paragraph of an earlier card becomes a list of one with it.)
      scenes: kept.map(item => (item.id === scene ? { ...item, ...(item.id === 'kept' ? { id: newId('scene') } : {}), portrait: path } : item)),
      ...(kept.some(item => item.id === 'kept') ? { scene: '' } : {}),
    } })
    await this.holdFigure(path, false)
    return saved
  }

  async saveCharacter(given: Partial<CharacterCard> & { name?: string }): Promise<CharacterCard> {
    // Whoever still sends the one-word label of older versions (a page not reloaded yet, a suggestion made before) is not refused: it is left out.
    const { status: _label, ...input } = given as Partial<CharacterCard> & { name?: string; status?: unknown }
    return await this.mutex.run('characters', async () => {
      let existing = input.id !== undefined ? await this.findCharacter(input.id) : input.name !== undefined ? await this.findCharacter(input.name) : undefined
      // A card made for somebody met in a chapter (a suggestion taken up names where they first appear) is the card
      // of whoever bears the name in that chapter's story — not of a namesake in another story, whom the name alone
      // would find. Where that story has nobody by the name yet, it is a new card.
      if (input.id === undefined && existing !== undefined && input.name !== undefined && input.firstAppearance !== undefined) {
        const where = await this.whereabouts()
        const who = where.resolve(input.name, input.firstAppearance).id
        existing = who === existing.id ? existing : who !== undefined ? await this.findCharacter(who) : undefined
        if (existing === undefined) {
          // A namesake of somebody in another story: their card goes by the name with their story after it, as a
          // digest keeps them — two cards of one name would be told apart by nothing that goes by names.
          const home = where.story(input.firstAppearance)
          const wide = /[\u3400-\u9fff]/u.test(input.name)
          const title = home === MAIN_LINE ? (wide ? '主线' : 'main line') : ((await this.outline()).lines ?? []).find(line => line.id === home)?.title ?? home
          input.name = wide ? `${input.name.trim()}（${title}）` : `${input.name.trim()} (${title})`
          existing = await this.findCharacter(input.name)
        }
      }
      if (existing === undefined && (input.name === undefined || input.name.trim().length === 0)) {
        throw new ProjectError('novel/invalid', 'a new character needs a name')
      }
      const id = existing?.id ?? await this.uniqueId('characters', input.name!, 'character')
      const merged = mergeCard<CharacterCard>(existing ?? { id, name: input.name!.trim(), role: 'supporting' }, input)
      merged.id = id
      merged.updatedAt = new Date().toISOString()
      // A look that is saved again is still the same look: it keeps its id and the sheet drawn for it.
      const looks = isPlainRecord(input.visual) ? (input.visual as { looks?: unknown }).looks : undefined
      if (Array.isArray(looks) && merged.visual !== undefined) {
        const kept = reconcileLooks(looks, existing?.visual?.looks)
        if (kept.length > 0) merged.visual.looks = kept
        else delete merged.visual.looks
      }
      // Their portraits are kept together. A list handed in is the author's order; a portrait named alone is a new
      // one — it goes first, and those before it stay — or, named as nothing, the one that stands for them taken
      // away. Which one stands for them (`portrait`) is the one the author chose (`face`) while it is among them:
      // a portrait drawn after a choice was made does not take its place. With no choice made it is the first of
      // their plain likenesses — a picture of one of their moments shows what they did, not who they are — and the
      // first of all where they have no likeness.
      const pictures = isPlainRecord(input.visual) ? input.visual as { portrait?: unknown; portraits?: unknown; face?: unknown } : undefined
      if (pictures !== undefined && (Array.isArray(pictures.portraits) || typeof pictures.portrait === 'string' || pictures.portrait === null || 'face' in pictures)) {
        const before = existing?.visual?.portraits ?? (existing?.visual?.portrait !== undefined ? [existing.visual.portrait] : [])
        const named = typeof pictures.portrait === 'string' ? pictures.portrait.trim() : ''
        const list = Array.isArray(pictures.portraits)
          ? [...new Set(pictures.portraits.filter((path): path is string => typeof path === 'string' && path.trim().length > 0).map(path => path.trim()))]
          : named.length > 0 ? [named, ...before.filter(path => path !== named)]
            : pictures.portrait === null ? before.filter(path => path !== existing?.visual?.portrait) : before
        // The choice: what this call says of it, else what the card had.
        const wanted = 'face' in pictures ? (typeof pictures.face === 'string' ? pictures.face.trim() : '') : existing?.visual?.face ?? ''
        const face = wanted.length > 0 && list.includes(wanted) ? wanted : undefined
        const visual: NonNullable<CharacterCard['visual']> = merged.visual ?? {}
        if (face !== undefined) visual.face = face
        else delete visual.face
        // …else their newest plain likeness — what they look like, which is what stands for a person — else the newest of any.
        const records = face === undefined && list.length > 1 ? new Map((await this.illustrations()).map(record => [record.path, record])) : undefined
        const likeness = records !== undefined ? list.find(path => portraitIsOf(merged, path, records.get(path)) === 'person') : undefined
        if (list.length > 0) visual.portrait = face ?? likeness ?? list[0]!
        else delete visual.portrait
        if (list.length > 1) visual.portraits = list
        else delete visual.portraits
        if (Object.keys(visual).length > 0) merged.visual = visual
        else delete merged.visual
      }
      await this.settleSheets(merged, existing, isPlainRecord(input.visual) ? input.visual : undefined)
      const { notes, ...data } = merged
      await this.saveCard('characters', id, data, notes)
      return merged
    })
  }

  /**
   * A person's design sheets are kept together, like their portraits. A sheet named alone (`sheet`) is a new one: it
   * goes first, and those before it stay; a list handed in (`sheets`) is the author's — which are kept, in what order;
   * the sheet of a stretch of their life is one of them too, and the one a stretch had before stays among them, not in
   * use. Which is the main one (`sheet`): the one the author chose (`mainSheet`), while it is among them and no
   * stretch's — a sheet drawn after a choice was made does not take its place; with no choice made, a sheet newly
   * named is the main one, and otherwise the main sheet stays what it was. It changes for nothing else: where it is
   * taken away or becomes a stretch's, the one kept right behind it — usually the one it was drawn from — is next.
   * Whether a sheet is the front view alone is kept with the sheet (`fronts`), so that it holds whatever the sheet
   * is used as; of one that joins without that being said, its shape says it — one figure stands upright.
   * @param said - what this save says of the card's pictures, as it came.
   */
  private async settleSheets(merged: CharacterCard, existing: CharacterCard | undefined, said: Record<string, unknown> | undefined): Promise<void> {
    const before = existing !== undefined ? sheetPool(existing) : []
    const known = new Set(before)
    const named = typeof said?.sheet === 'string' ? said.sheet.trim() : ''
    const cleared = said !== undefined && 'sheet' in said && named.length === 0
    let pool = Array.isArray(said?.sheets)
      ? [...new Set(said.sheets.filter((path): path is string => typeof path === 'string' && path.trim().length > 0).map(path => path.trim()))]
      // (One of theirs already, named again, stays where it is: which is the main one is said with `mainSheet`.)
      : named.length > 0 ? (known.has(named) ? before : [named, ...before])
        // The main sheet named as nothing: that one taken away, the others kept.
        : cleared ? before.filter(path => path !== existing?.visual?.sheet) : before
    // The sheet of a stretch is one of theirs: a new one first, like any sheet newly drawn.
    const stages = merged.stages ?? []
    for (const stage of stages) {
      const path = stage.visual?.sheet
      if (path !== undefined && path.length > 0 && !pool.includes(path)) pool = [path, ...pool]
    }
    if (pool.length === 0 && existing?.visual?.sheet === undefined && existing?.visual?.sheets === undefined) return

    const fronts = Array.isArray(said?.fronts) ? new Set(said.fronts.filter((path): path is string => typeof path === 'string')) : existing !== undefined ? sheetFronts(existing) : new Set<string>()
    const flag = (path: string, front: boolean): void => { if (front) fronts.add(path); else fronts.delete(path) }
    // Said of the sheet named: where this save says it — and of a new one always, unless the whole list of them was handed in.
    if (named.length > 0 && ('sheetFront' in (said ?? {}) || (!known.has(named) && !Array.isArray(said?.fronts)))) flag(named, said?.sheetFront === true)
    for (const stage of stages) {
      const path = stage.visual?.sheet
      if (path !== undefined && !known.has(path) && path !== named) flag(path, stage.visual?.sheetFront === true)
    }
    // One that joins by the list alone (out of the gallery): one figure stands upright, three lie side by side.
    if (Array.isArray(said?.sheets) && !Array.isArray(said?.fronts)) {
      for (const path of pool) {
        if (known.has(path) || path === named || stages.some(stage => stage.visual?.sheet === path)) continue
        const frame = await this.readFile(path).then(pixelsOf).catch(() => undefined)
        if (frame !== undefined) flag(path, frame.height > frame.width)
      }
    }

    const staged = new Set(stages.map(stage => stage.visual?.sheet).filter((path): path is string => path !== undefined && path.length > 0))
    const wanted = said !== undefined && 'mainSheet' in said ? (typeof said.mainSheet === 'string' ? said.mainSheet.trim() : '') : existing?.visual?.mainSheet ?? ''
    const free = (path: string): boolean => pool.includes(path) && !staged.has(path)
    const was = existing?.visual?.sheet
    // With no choice in the way, a sheet newly named is the main one; else the one there was — or, that one gone or a
    // stretch's now, the one that stood right behind it (before it, where nothing stood behind).
    const current = named.length > 0 && !known.has(named) ? named
      : was === undefined || free(was) ? was
        : before.slice(before.indexOf(was) + 1).find(free) ?? before.slice(0, Math.max(0, before.indexOf(was))).reverse().find(free)
    const main = mainSheetOf(pool, staged, wanted.length > 0 ? wanted : undefined, current)
    const visual: NonNullable<CharacterCard['visual']> = merged.visual ?? {}
    if (main.path !== undefined) visual.sheet = main.path
    else delete visual.sheet
    if (main.path !== undefined && fronts.has(main.path)) visual.sheetFront = true
    else delete visual.sheetFront
    if (main.chosen) visual.mainSheet = main.path!
    else delete visual.mainSheet
    // The list is written where it says more than the main sheet does by itself.
    const listed = pool.length > 1 || (pool.length === 1 && pool[0] !== main.path)
    if (listed) visual.sheets = pool
    else delete visual.sheets
    const upright = pool.filter(path => fronts.has(path))
    if (listed && upright.length > 0) visual.fronts = upright
    else delete visual.fronts
    if (Object.keys(visual).length > 0) merged.visual = visual
    else delete merged.visual
    // A stretch's sheet is the front view alone where the sheet is — whatever was said of the sheet it had before.
    if (stages.some(stage => stage.visual?.sheet !== undefined)) {
      merged.stages = stages.map((stage) => {
        if (stage.visual?.sheet === undefined) return stage
        const { sheetFront: _was, ...rest } = stage.visual
        return { ...stage, visual: { ...rest, ...(fronts.has(stage.visual.sheet) ? { sheetFront: true } : {}) } }
      })
    }
  }

  /**
   * Write down something of a character's life — that they come on, come back, leave for good or die at a chapter — or
   * take such a mark back. One mark a chapter: another for the same chapter replaces it. It holds over what the digest
   * of that chapter says, on every line the chapter is read on.
   * @param mark.chapter - the chapter, by id, title or number (along `line`); absent: before the story begins.
   * @param mark.kind - absent: the mark of that chapter is taken back.
   * @throws ProjectError `novel/not-found` for a character or a chapter nobody answers to; `novel/invalid` for a coming-on before the story.
   */
  async markLife(ref: string, mark: { chapter?: string | number; kind?: LifeMark['kind']; what?: string; line?: string }): Promise<CharacterCard> {
    const card = await this.findCharacter(ref)
    if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${ref}"`)
    const chapter = mark.chapter !== undefined && String(mark.chapter).trim().length > 0 ? await this.findChapter(mark.chapter, mark.line) : undefined
    if (mark.chapter !== undefined && String(mark.chapter).trim().length > 0 && chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${mark.chapter}"`)
    if (chapter === undefined && mark.kind !== undefined && mark.kind !== 'death' && mark.kind !== 'exit') {
      throw new ProjectError('novel/invalid', 'before the story begins somebody can only be dead or gone — name the chapter they come on or come back in')
    }
    const id = chapter?.plan.id
    const others = (card.lifeMarks ?? []).filter(other => other.chapter !== id)
    const what = mark.what?.trim()
    const next = mark.kind === undefined ? others : [...others, { ...(id !== undefined ? { chapter: id } : {}), kind: mark.kind, ...(what !== undefined && what.length > 0 ? { what } : {}) }]
    return await this.saveCharacter({ id: card.id, lifeMarks: next })
  }

  async deleteCharacter(ref: string): Promise<boolean> {
    const card = await this.findCharacter(ref)
    if (card === undefined) return false
    await this.keepRemoved('character', 'characters', card.id)
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

  /** Empty the table of ties; what it said stays in its history. */
  async clearTies(): Promise<number> {
    const before = (await this.ties()).length
    if (before > 0) await this.writeTies(() => [])
    return before
  }

  private async writeTies(mutate: (current: Tie[]) => Tie[]): Promise<Tie[]> {
    const path = this.path('bible', TIES_FILE)
    return await this.mutex.run(path, async () => {
      const current = await this.ties()
      const next = mutate(current)
      // The table as it was, where this changed what it says: one history for the whole of it.
      if (said('ties', { relations: current }) !== said('ties', { relations: next })) await this.keep('ties', 'all', `${JSON.stringify({ relations: current }, null, 2)}\n`, 'json')
      await this.writeDoc(path, { schema: 1, relations: next })
      return next
    })
  }

  // ───────────── the glossary: what the book's names are in another language ─────────────

  /** Every glossary the book has, by the language it renders the book's names in (`bible/glossary.json`). */
  async glossaries(): Promise<Record<string, GlossaryTerm[]>> {
    const path = this.path('bible', GLOSSARY_FILE)
    return await this.cached(path, async () => {
      const stored = await this.files.readJson<{ to?: unknown }>(path)
      const out: Record<string, GlossaryTerm[]> = {}
      if (stored?.to === null || typeof stored?.to !== 'object') return out
      for (const [language, list] of Object.entries(stored.to as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue
        out[language] = list.filter((item): item is GlossaryTerm => item !== null && typeof item === 'object' && typeof (item as GlossaryTerm).source === 'string' && typeof (item as GlossaryTerm).target === 'string' && (item as GlossaryTerm).source.trim().length > 0 && (item as GlossaryTerm).target.trim().length > 0)
      }
      return out
    })
  }

  /** The book's names and terms as they are to be written in a language; none where nothing was settled for it. */
  async glossary(to: string): Promise<GlossaryTerm[]> {
    return (await this.glossaries())[to] ?? []
  }

  /**
   * Change the glossary of a language. One rendering a word: of two terms with the same source, the first stands.
   * @returns the glossary as it is after.
   */
  async updateGlossary(to: string, mutate: (current: GlossaryTerm[]) => GlossaryTerm[]): Promise<GlossaryTerm[]> {
    const path = this.path('bible', GLOSSARY_FILE)
    return await this.mutex.run(path, async () => {
      const all = { ...(await this.glossaries()) }
      const seen = new Set<string>()
      const next = mutate(all[to] ?? []).map(term => ({ ...term, source: term.source.trim(), target: term.target.trim() })).filter((term) => {
        const key = term.source.toLowerCase()
        if (term.source.length === 0 || term.target.length === 0 || seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (next.length > 0) all[to] = next
      else delete all[to]
      if (Object.keys(all).length > 0) await this.writeDoc(path, { schema: 1, to: all })
      else await this.remove(path)
      return next
    })
  }

  /** Which chapters' text is a translation, and of what (`.novel/translations.json`). */
  async translations(): Promise<Record<string, ChapterTranslation>> {
    return (await this.readState<Record<string, ChapterTranslation>>('translations.json')) ?? {}
  }

  /** Note that a chapter's text is now a translation — or, with nothing, that it is the original again. */
  async noteTranslation(chapterId: string, note?: ChapterTranslation): Promise<void> {
    await this.updateState<Record<string, ChapterTranslation>>(['translations.json'], {}, (current) => {
      const { [chapterId]: _was, ...others } = current
      return note !== undefined ? { ...others, [chapterId]: note } : others
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
      this.settleArt(merged, existing, input as Record<string, unknown>)
      const { body, ...data } = merged
      await this.saveCard('world', id, data, body)
      return merged
    })
  }

  /**
   * The design pictures of a place, a house or a thing are kept together, like a person's design sheets. A picture
   * named alone (`visualImage`) is a new one: it goes first, and those before it stay; a list handed in
   * (`visualImages`) is the author's — which are kept, in what order. Which is the main one (`visualImage`): the one
   * the author chose (`visualMain`), while it is among them — a picture drawn after a choice was made does not take
   * its place, and one chosen that was not among them joins them; with no choice made, a picture newly named is the
   * main one, and otherwise the main picture stays what it was. Where it is taken away, the one kept right behind it
   * is next.
   * @param said - what this save says of the entry, as it came.
   */
  private settleArt(merged: WorldEntry, existing: WorldEntry | undefined, said: Record<string, unknown>): void {
    const before = existing !== undefined ? artPool(existing) : []
    const known = new Set(before)
    const named = typeof said.visualImage === 'string' ? said.visualImage.trim() : ''
    const cleared = 'visualImage' in said && said.visualImage !== undefined && named.length === 0
    let pool = Array.isArray(said.visualImages)
      ? [...new Set(said.visualImages.filter((path): path is string => typeof path === 'string' && path.trim().length > 0).map(path => path.trim()))]
      // (One of its own already, named again, stays where it is: which is the main one is said with `visualMain`.)
      : named.length > 0 ? (known.has(named) ? before : [named, ...before])
        // The main picture named as nothing: that one taken away, the others kept.
        : cleared ? before.filter(path => path !== existing?.visualImage) : before
    const wanted = 'visualMain' in said && said.visualMain !== undefined ? (typeof said.visualMain === 'string' ? said.visualMain.trim() : '') : existing?.visualMain ?? ''
    // Chosen out of the gallery — one drawn before pictures were kept side by side, or drawn to compare: it joins them.
    if ('visualMain' in said && wanted.length > 0 && !pool.includes(wanted)) pool = [wanted, ...pool]
    const was = existing?.visualImage
    // With no choice in the way, a picture newly named is the main one; else the one there was — or, that one gone,
    // the one that stood right behind it (before it, where nothing stood behind).
    const current = named.length > 0 && !known.has(named) ? named
      : was === undefined || pool.includes(was) ? was
        : before.slice(before.indexOf(was) + 1).find(path => pool.includes(path)) ?? before.slice(0, Math.max(0, before.indexOf(was))).reverse().find(path => pool.includes(path))
    const main = mainArtOf(pool, wanted.length > 0 ? wanted : undefined, current)
    if (main.path !== undefined) merged.visualImage = main.path
    else delete merged.visualImage
    if (main.chosen) merged.visualMain = main.path!
    else delete merged.visualMain
    // The list is written where it says more than the main picture does by itself.
    if (pool.length > 1 || (pool.length === 1 && pool[0] !== main.path)) merged.visualImages = pool
    else delete merged.visualImages
  }

  async deleteWorld(ref: string): Promise<boolean> {
    const entry = await this.findWorld(ref)
    if (entry === undefined) return false
    await this.keepRemoved('world', 'world', entry.id)
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
      ...(pictured !== undefined && keep.visualPrompt === undefined && pictured.visualPrompt !== undefined ? { visualPrompt: pictured.visualPrompt } : {}),
      // The pictures of all of them are pictures of the one thing: kept side by side, its own first.
      ...(folded.some(other => artPool(other).length > 0) ? { visualImages: [...new Set([...artPool(keep), ...folded.flatMap(other => artPool(other))])] } : {}),
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
    await this.keepRemoved('style', 'styles', style.id)
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
      const current = await this.outline()
      const draft = structuredClone(current)
      await mutate(draft)
      const next = normalizeOutline(draft)
      // Every chapter's plan and every thread as it was, where this changed what it says: kept one by one — a plan has
      // a history of its own, and the outline of a long book is not copied whole for a word changed in one chapter.
      const plansNow = new Map(holders(next).flatMap(holder => holder.chapters).map(plan => [plan.id, plan]))
      for (const plan of holders(current).flatMap(holder => holder.chapters)) {
        const now = plansNow.get(plan.id)
        if (now !== undefined && said('plan', plan as unknown as Record<string, unknown>) !== said('plan', now as unknown as Record<string, unknown>)) await this.keep('plan', plan.id, `${JSON.stringify(plan, null, 2)}\n`, 'json')
      }
      // And each volume, each line beside the main one: what it is called and says, and its chapters in their order.
      for (const [kind, were, are] of [['volume', current.volumes, next.volumes], ['line', current.lines ?? [], next.lines ?? []]] as const) {
        const now = new Map(are.map(holder => [holder.id, holder]))
        for (const holder of were) {
          const [before, after] = [shelfOf(holder)!, shelfOf(now.get(holder.id))]
          if (after === undefined) continue
          // Its words, or the order of the chapters it had and still has: a chapter that came to it or left it is
          // no change of the volume (a book being written gains a chapter every day; where a chapter is, is a move of its own).
          const [were, are] = [before.chapters as string[], after.chapters as string[]]
          const reordered = were.filter(id => are.includes(id)).join('\n') !== are.filter(id => were.includes(id)).join('\n')
          if (reordered || said(kind, { ...before, chapters: [] }) !== said(kind, { ...after, chapters: [] })) await this.keep(kind, holder.id, `${JSON.stringify(before, null, 2)}\n`, 'json')
        }
      }
      const threadsNow = new Map(next.threads.map(thread => [thread.id, thread]))
      for (const thread of current.threads) {
        const now = threadsNow.get(thread.id)
        if (now !== undefined && said('thread', thread as unknown as Record<string, unknown>) !== said('thread', now as unknown as Record<string, unknown>)) await this.keep('thread', thread.id, `${JSON.stringify(thread, null, 2)}\n`, 'json')
      }
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

  /** The line of the plot a chapter is of: its id, `main` for the main line. */
  async lineOf(chapterId: string): Promise<string> {
    return homeOf(await this.outline(), chapterId)?.id ?? MAIN_LINE
  }

  /**
   * The lines of the plot that read a chapter, in the book's order: the chapter's own, and every line that parts from
   * it later on. `every` says whether that is all the lines the book has.
   */
  async linesReading(chapterId: string): Promise<{ lines: string[]; every: boolean }> {
    const outline = await this.outline()
    const all = [MAIN_LINE, ...(outline.lines ?? []).map(line => line.id)]
    const lines = all.filter(id => linePath(outline, lineOf(outline, id)).some(entry => entry.plan.id === chapterId))
    return { lines, every: lines.length === all.length }
  }

  /**
   * On which lines of the plot each character is seen — read off the digests along each line. What the page shows
   * beside a name where the author has not said which lines somebody belongs to.
   */
  async seenOn(): Promise<{ lines: { id: string; title: string; /** The line its story begins on: its own id for a story of its own, the line it parted from — followed back — otherwise. */ story: string }[]; people: Record<string, string[]>; world: Record<string, string[]> }> {
    const outline = await this.outline()
    const storyOf = storiesOf(outline)
    const lines = [{ id: MAIN_LINE, title: '', story: MAIN_LINE }, ...(outline.lines ?? []).map(line => ({ id: line.id, title: line.title, story: storyOf(line.id) }))]
    const { people: where } = await this.whereabouts()
    const people: Record<string, string[]> = {}
    for (const line of lines) {
      const path = new Set(linePath(outline, lineOf(outline, line.id)).map(entry => entry.plan.id))
      for (const [id, chapters] of where) if ([...chapters].some(chapter => path.has(chapter))) people[id] = [...(people[id] ?? []), line.id]
    }
    // The bible's entries: on which lines the text names them. A hint for the author and what "file by the text" goes
    // by — not what decides whose an entry is (`LineScope.knows`).
    const named = await this.worldLines()
    const world: Record<string, string[]> = {}
    for (const line of lines) for (const [id, on] of named) if (on.has(line.id)) world[id] = [...(world[id] ?? []), line.id]
    return { lines, people, world }
  }

  private worldAt: { revision: number; lines: Map<string, Set<string>> } | undefined

  /**
   * On which lines of the plot each entry of the bible is named — by the text of the chapters each line reads, and by
   * what their digests wrote down. Shown beside an entry nobody filed, and what a batch is filed by when the author
   * says "by the text".
   */
  private async worldLines(): Promise<Map<string, Set<string>>> {
    const revision = this.revisionValue
    if (this.worldAt?.revision === revision) return this.worldAt.lines
    const outline = await this.outline()
    const lines = new Map<string, Set<string>>()
    for (const id of [MAIN_LINE, ...(outline.lines ?? []).map(line => line.id)]) {
      for (const item of (await this.worldPresence(id)).presence) {
        if (item.chapters.length === 0) continue
        const on = lines.get(item.entry) ?? new Set<string>()
        on.add(id)
        lines.set(item.entry, on)
      }
    }
    if (this.revisionValue === revision) this.worldAt = { revision, lines }
    return lines
  }

  /**
   * File a batch of cards and entries under lines of the plot at once: they belong to these lines and to no other — or,
   * with no line named, to every line again.
   * @param input.byText - instead of naming lines: each is filed under the lines it is found on — an entry where the
   *   text names it, a person where the chapters have them. What is found on every line, or on none, is left unfiled:
   *   it is everybody's.
   * @returns who and what was filed, under which lines where they were named, and what `byText` left as it was.
   * @throws ProjectError `novel/not-found` for a line the book does not have.
   */
  async assignLines(input: { lines?: readonly string[]; byText?: boolean; characters?: readonly string[]; world?: readonly string[] }): Promise<{ characters: string[]; world: string[]; lines: string[]; left?: string[] }> {
    const outline = await this.outline()
    const every = [MAIN_LINE, ...(outline.lines ?? []).map(line => line.id)]
    const known = new Set(every)
    const lines = [...new Set((input.lines ?? []).map(id => id.trim()).filter(id => id.length > 0))]
    const unknown = lines.find(id => !known.has(id))
    if (unknown !== undefined) throw new ProjectError('novel/not-found', `no line of the plot has the id "${unknown}" — the lines: ${every.join(', ')}`)
    const found = input.byText === true ? await this.seenOn() : undefined
    const left: string[] = []
    // By the text: the lines it is found on, in the book's order — unless that is all of them, or none.
    const under = (on: readonly string[] | undefined, name: string): string[] | undefined => {
      if (found === undefined) return lines
      const here = every.filter(id => on?.includes(id) === true)
      if (here.length > 0 && here.length < every.length) return here
      left.push(name)
      return undefined
    }
    const characters: string[] = []
    for (const ref of input.characters ?? []) {
      const card = await this.findCharacter(ref)
      if (card === undefined) continue
      const filed = under(found?.people[card.id], card.name)
      if (filed === undefined) continue
      await this.saveCharacter({ id: card.id, lines: filed })
      characters.push(card.name)
    }
    const world: string[] = []
    for (const ref of input.world ?? []) {
      const entry = await this.findWorld(ref)
      if (entry === undefined) continue
      const filed = under(found?.world[entry.id], entry.name)
      if (filed === undefined) continue
      await this.saveWorld({ id: entry.id, lines: filed })
      world.push(entry.name)
    }
    return { characters, world, lines: found === undefined ? lines : [], ...(found !== undefined ? { left } : {}) }
  }

  /**
   * The line somebody's story is read along where nobody says which: the main line if they are of it — said so, or seen
   * there, or seen nowhere yet — else the first line that has them. A world may hold several stories, and a person of
   * one of them is read in that one.
   */
  async lineOfCharacter(card: Pick<CharacterCard, 'id' | 'lines'>): Promise<string> {
    const { lines, people } = await this.seenOn()
    const said = (card.lines ?? []).filter(id => lines.some(line => line.id === id))
    const theirs = said.length > 0 ? said : people[card.id] ?? []
    return theirs.length === 0 || theirs.includes(MAIN_LINE) ? MAIN_LINE : theirs[0]!
  }

  private whereAt: { revision: number; people: Map<string, Set<string>>; threads: Map<string, Map<string, ThreadTouch['action'] | 'plan'>>; resolve: WhoIs; whose: WhoseMoment; story: (chapterId: string | undefined) => string } | undefined

  /**
   * In which chapters each character is found — by the chapter's digest, or cast by its plan — and each thread is
   * touched, on whichever line: read off every chapter once for a state of the book. What says whose a character or a thread is without anybody saying.
   *
   * Who a digest's "somebody" is goes by the story the chapter is of ({@link WhoseMoment}): a world may hold several
   * stories that each have a narrator, a mother, a boss — and a digest of an older day took whoever bore the name,
   * in whichever story, for the same card. That is not undone by digesting the book again; it is read aright here.
   */
  private async whereabouts(): Promise<{ people: Map<string, Set<string>>; threads: Map<string, Map<string, ThreadTouch['action'] | 'plan'>>; resolve: WhoIs; whose: WhoseMoment; story: (chapterId: string | undefined) => string }> {
    const revision = this.revisionValue
    if (this.whereAt?.revision === revision) return this.whereAt
    const [outline, cards] = await Promise.all([this.outline(), this.characters()])
    const key = (name: string): string => name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    // Cards by a name: several where stories that are apart from their first page each have somebody called so.
    const byName = new Map<string, CharacterCard[]>()
    for (const card of cards) for (const name of [card.name, ...(card.aliases ?? [])]) byName.set(key(name), [...(byName.get(key(name)) ?? []).filter(other => other.id !== card.id), card])
    const ids = new Set(cards.map(card => card.id))
    const people = new Map<string, Set<string>>()
    const threads = new Map<string, Map<string, ThreadTouch['action'] | 'plan'>>()
    const touched = (thread: string, chapter: string, how: ThreadTouch['action'] | 'plan'): void => { threads.set(thread, (threads.get(thread) ?? new Map()).set(chapter, how)) }
    const known = new Set<string>()
    // The story a chapter is of: the line it is on, followed back to where that line began. A line that parts from
    // another tells that one's story on; a line of its own from the first page is a story of its own.
    const storyOfLine = storiesOf(outline)
    const home = new Map<string, string>()
    for (const volume of outline.volumes) for (const plan of volume.chapters) home.set(plan.id, MAIN_LINE)
    for (const line of outline.lines ?? []) for (const plan of line.chapters) home.set(plan.id, storyOfLine(line.id))
    const story = (chapterId: string | undefined): string => (chapterId !== undefined ? home.get(chapterId) : undefined) ?? MAIN_LINE
    const plans: ChapterPlan[] = []
    for (const holder of holders(outline)) for (const plan of holder.chapters) plans.push(plan)
    const memories = new Map<string, ChapterMemory>()
    for (const plan of plans) {
      const memory = await this.memory(plan.id)
      if (memory !== undefined) memories.set(plan.id, memory)
    }
    const castOf = (plan: ChapterPlan): string[] => [plan.pov, ...(plan.characters ?? []), ...(plan.beats ?? []).flatMap(beat => beat.characters ?? [])].filter((ref): ref is string => ref !== undefined && ref.length > 0)

    // ── which stories each card is of ──
    // What does not go by a name alone says so: the lines the author filed the card under (and then those only); the
    // chapter it first appeared in — where it was made from —, or, with none on it, the story that speaks of it most;
    // a digest that settled who it is as it read the chapter (`CharacterMoment.by`); the plan of a chapter nobody has
    // digested yet (the planner, or the author, put them there); what the author wrote of their life at a chapter.
    // Not: an older digest's bare id in another story, nor a plan's cast copied from such a digest — an id is made of
    // the name, and both took whoever bore it for the card.
    const stories = new Map<string, Set<string>>()
    const of = (card: string, which: string): void => { stories.set(card, (stories.get(card) ?? new Set<string>()).add(which)) }
    const spoken = new Map<string, Map<string, number>>()
    for (const plan of plans) {
      const memory = memories.get(plan.id)
      const here = new Set<string>()
      for (const moment of memory?.characters ?? []) {
        if (!ids.has(moment.character)) continue
        here.add(moment.character)
        if (moment.by !== undefined) of(moment.character, story(plan.id))
      }
      for (const ref of castOf(plan)) {
        if (!ids.has(ref)) continue
        here.add(ref)
        if (memory === undefined) of(ref, story(plan.id))
      }
      for (const id of here) {
        const counts = spoken.get(id) ?? new Map<string, number>()
        counts.set(story(plan.id), (counts.get(story(plan.id)) ?? 0) + 1)
        spoken.set(id, counts)
      }
    }
    for (const card of cards) {
      if ((card.lines ?? []).length > 0) {
        stories.set(card.id, new Set(card.lines!.map(line => storyOfLine(line))))
        continue
      }
      for (const mark of card.lifeMarks ?? []) if (mark.chapter !== undefined && home.has(mark.chapter)) of(card.id, story(mark.chapter))
      if (card.firstAppearance !== undefined && home.has(card.firstAppearance)) {
        of(card.id, story(card.firstAppearance))
        continue
      }
      const counts = [...(spoken.get(card.id) ?? [])]
      if (counts.length === 0) continue
      const most = Math.max(...counts.map(([, times]) => times))
      // (Equal: the first in reading order — the main story before a line beside it.)
      of(card.id, counts.find(([, times]) => times === most)![0])
    }
    const seen = (card: string, chapter: string): void => {
      people.set(card, (people.get(card) ?? new Set()).add(chapter))
      of(card, story(chapter))
    }
    /**
     * Who a name in a chapter is. Somebody of that chapter's story by that name; else a card no story has yet (the
     * author made it ahead). A card of another story is another person where the name is only how a narrator calls
     * themself ("我"), or where the author filed that card under lines of its own; for a proper name it is given back
     * as `elsewhere` — the same person crossing over, or a namesake: whoever reads the chapter says.
     */
    const resolve: WhoIs = (name, chapterId) => {
      const named = byName.get(key(name)) ?? []
      if (named.length === 0) return {}
      const here = story(chapterId)
      const mine = named.filter(card => stories.get(card.id)?.has(here) === true)
      if (mine.length > 0) return { id: (mine.find(card => sameName(card.name, name)) ?? mine[0]!).id }
      const free = named.filter(card => (stories.get(card.id)?.size ?? 0) === 0)
      if (free.length > 0) return { id: free[0]!.id }
      if (selfNamed(name)) return {}
      const elsewhere = named.filter(card => (card.lines ?? []).length === 0)
      return elsewhere.length > 0 ? { elsewhere } : {}
    }
    const whose: WhoseMoment = (moment, chapterId) => {
      if (ids.has(moment.character)) {
        // Settled as the chapter was digested: it stands.
        if (moment.by !== undefined) return moment.character
        // An older digest's word holds within the card's own stories.
        if (stories.get(moment.character)?.has(story(chapterId)) === true) return moment.character
      }
      return resolve(moment.name, chapterId).id
    }
    // First what stands by itself; then, with every card's stories known from that, what goes by a name.
    const later: { name: string; chapter: string }[] = []
    for (const plan of plans) {
      known.add(plan.id)
      for (const thread of plan.threads ?? []) touched(thread, plan.id, 'plan')
      const memory = memories.get(plan.id)
      // Cast by a chapter's plan, somebody is that line's before a word of the chapter is written. Once it is
      // digested, who is in it is the digest's to say — but for those of the chapter's own story, whom the plan may
      // have and the chapter not.
      for (const ref of castOf(plan)) {
        if (!ids.has(ref)) later.push({ name: ref, chapter: plan.id })
        else if (memory === undefined || stories.get(ref)?.has(story(plan.id)) === true) seen(ref, plan.id)
      }
      for (const moment of memory?.characters ?? []) {
        if (ids.has(moment.character) && (moment.by !== undefined || stories.get(moment.character)?.has(story(plan.id)) === true)) seen(moment.character, plan.id)
        else later.push({ name: moment.name, chapter: plan.id })
      }
    }
    for (const { name, chapter } of later) {
      const card = resolve(name, chapter).id
      if (card !== undefined) seen(card, chapter)
    }
    for (const plan of plans) {
      const memory = memories.get(plan.id)
      if (memory !== undefined) {
        for (const touch of memory.threads) {
          const thread = outline.threads.find(candidate => candidate.id === touch.threadId) ?? outline.threads.find(candidate => sameName(candidate.title, touch.title))
          // What the chapter did to it says more than that its plan named it.
          if (thread !== undefined) touched(thread.id, plan.id, touch.action)
        }
      }
    }
    // What the author wrote down of a life at a chapter places them there as well; a mark before the story is of no line.
    for (const card of cards) for (const mark of card.lifeMarks ?? []) if (mark.chapter !== undefined && known.has(mark.chapter)) seen(card.id, mark.chapter)
    // Where a thread says itself it was planted, taken up and paid off: the same, for a chapter whose digest no longer names it.
    for (const thread of outline.threads) {
      for (const [how, chapters] of [['plant', thread.planted], ['advance', thread.advanced], ['payoff', thread.paid]] as const) {
        for (const chapter of chapters ?? []) if (known.has(chapter) && threads.get(thread.id)?.has(chapter) !== true) touched(thread.id, chapter, how)
      }
    }
    const value = { revision, people, threads, resolve, whose, story }
    if (this.revisionValue === revision) this.whereAt = value
    return value
  }

  /**
   * Who a name is in a chapter, told by the story the chapter is of — so that two stories in one world that each call
   * somebody "我", or each have a 小李, do not find themselves sharing a card. See `resolve` in {@link whereabouts}.
   * @returns `resolve` (the card a name is, or the namesakes of other stories for whoever reads the chapter to judge),
   *   `whose` (the card a digest's note on somebody is of — every reading of a digest goes by it) and `story` (the
   *   line a chapter's story begins on).
   */
  async castResolver(): Promise<{ resolve: WhoIs; whose: WhoseMoment; story: (chapterId: string | undefined) => string }> {
    const { resolve, whose, story } = await this.whereabouts()
    return { resolve, whose, story }
  }

  /**
   * What a line of the plot has of the book — what whoever works on it reads, and nothing of the other lines:
   * its chapters, its people, what it may know of the world, the threads that are its own.
   * @param line - the line's id; the main line when left out.
   * @param anew - the plan, as it was meant, of a chapter that is being drafted (see `plans.ts`): the line is taken
   *   as it stands without that chapter's last draft — it counts for whom its plan casts and the threads its plan
   *   names, not for whom and what a digest found in it, and the threads go without its marks.
   * @throws ProjectError `novel/not-found` when no line has that id.
   */
  async lineScope(line?: string, anew?: ChapterPlan): Promise<LineScope> {
    const outline = await this.outline()
    const home = lineOf(outline, line)
    const id = home?.id ?? MAIN_LINE
    const path = located(linePath(outline, home))
    const on = new Set(path.map(chapter => chapter.plan.id))
    const where = await this.whereabouts()
    const castAnew = anew !== undefined ? new Set([anew.pov, ...(anew.characters ?? []), ...(anew.beats ?? []).flatMap(beat => beat.characters ?? [])]) : undefined
    const has = (card: Pick<CharacterCard, 'id' | 'lines'>): boolean => {
      if (card.lines !== undefined && card.lines.length > 0) return card.lines.includes(id)
      const found = where.people.get(card.id)
      const chapters = found !== undefined && anew !== undefined && found.has(anew.id) && !castAnew!.has(card.id) ? new Set([...found].filter(chapter => chapter !== anew.id)) : found
      return chapters === undefined || chapters.size === 0 || [...chapters].some(chapter => on.has(chapter))
    }
    const threads: LineScope['threads'] = []
    for (const held of outline.threads) {
      const thread = anew !== undefined ? threadWithout(held, anew.id) : held
      if (thread === undefined) continue
      const all = where.threads.get(thread.id)
      const touches = all !== undefined && anew !== undefined && all.has(anew.id)
        ? new Map([...all].filter(([chapter]) => chapter !== anew.id).concat((anew.threads ?? []).includes(thread.id) ? [[anew.id, 'plan']] : []))
        : all
      const here = path.filter(chapter => touches?.has(chapter.plan.id) === true)
      // A thread nothing has touched yet is a plan of the author's: every line may take it up.
      if (touches !== undefined && touches.size > 0 && here.length === 0) continue
      // Whether the reader still waits: the last word along this very line decides — a thread paid off on another line
      // is open here. Given up by the author, it is given up everywhere; on the main line their word stands as it is.
      const done = [...here].reverse().map(chapter => touches!.get(chapter.plan.id)).find(how => how !== 'plan')
      const open = thread.status === 'dropped' ? false : home === undefined ? thread.status === 'open' : done !== 'payoff'
      threads.push({ thread, open })
    }
    return {
      line: id,
      ...(home !== undefined ? { title: home.title } : {}),
      ...(home?.premise !== undefined ? { premise: home.premise } : {}),
      apart: home !== undefined && home.from === undefined,
      path,
      reads: chapter => on.has(chapter),
      has,
      knows: entry => belongsTo(entry, id),
      threads,
      others: (outline.lines ?? []).length,
    }
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
        const held = holder.chapters[index]!
        updated = mergeCard<ChapterPlan>(held, { ...patch, id: located.plan.id })
        // A field read off the chapter that somebody now sets otherwise is theirs from here on: it is what is meant.
        if (!('fromText' in patch) && updated.fromText !== undefined) {
          const still = updated.fromText.filter(field => JSON.stringify(updated[field]) === JSON.stringify(held[field]) && updated[field] !== undefined)
          if (still.length > 0) updated.fromText = still
          else delete updated.fromText
        }
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

  /**
   * Move chapters — one, or a run of them — to another place: elsewhere on their line, onto another line, or onto a
   * line just opened for them. They keep their order, and everything made from them stays with them: a chapter is
   * found by its id, wherever it lies. A line that leaves after one of them, or arrives at one, goes where it goes —
   * that is how the plot is wired anew. What must not come of it is a knot — a line that leaves after one of its own
   * chapters, or a way round in a circle: then nothing is moved.
   * @param where - as for one chapter: beside another (`before` / `after`), else at the end of `line`, else (the main
   *   line) at the end of `volume`. Nothing said: the end of the line the first of them is on.
   * @throws ProjectError `novel/invalid` when the plot would no longer be a way through; `novel/not-found` for a chapter that is not there.
   */
  async moveChapters(refs: readonly string[], where: ChapterPlace = {}): Promise<LocatedChapter[]> {
    const found: LocatedChapter[] = []
    for (const ref of refs) {
      const chapter = await this.findChapter(ref)
      if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
      if (!found.some(known => known.plan.id === chapter.plan.id)) found.push(chapter)
    }
    if (found.length === 0) return []
    const moved = new Set(found.map(chapter => chapter.plan.id))
    if ((where.before !== undefined && moved.has(where.before)) || (where.after !== undefined && moved.has(where.after))) throw new ProjectError('novel/invalid', 'a chapter cannot be put beside itself')
    await this.updateOutline((draft) => {
      for (const holder of holders(draft)) holder.chapters = holder.chapters.filter(chapter => !moved.has(chapter.id))
      const first = found[0]!
      const said = where.before !== undefined || where.after !== undefined || where.line !== undefined || where.volume !== undefined
      const place: ChapterPlace = said ? where : first.line !== undefined ? { line: first.line } : { volume: first.volume.id }
      let last: string | undefined
      for (const chapter of found) {
        insertChapter(draft, chapter.plan, last !== undefined ? { after: last } : place)
        last = chapter.plan.id
      }
      const knot = knotIn(draft)
      if (knot !== undefined) throw new ProjectError('novel/invalid', knot)
    })
    const out: LocatedChapter[] = []
    for (const chapter of found) {
      const now = await this.findChapter(chapter.plan.id)
      if (now !== undefined) out.push(now)
    }
    return out
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
        ...(memory !== undefined ? { memory: memory.textHash === hashText(text) ? 'current' as const : 'stale' as const } : {}),
        ...(review !== undefined ? { openIssues: review.issues.filter(issue => issue.resolved !== true).length } : {}),
        ...(review?.unread === true ? { unreviewed: true as const } : {}),
        ...(home !== undefined ? { line: home } : {}),
        ...(budget !== undefined ? { budget } : {}),
      })
    }
    return infos
  }

  // ───────────── versions ─────────────

  /** Save the current (or given) text as a version. @returns the version id, or undefined for empty text. */
  async snapshot(chapterId: string, reason: string, text?: string, made?: VersionMade): Promise<string | undefined> {
    const content = text ?? await this.chapterText(chapterId)
    if (content.length === 0) return undefined
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const id = `${stamp}__${slugify(reason, 'edit')}`
    const path = this.statePath('versions', chapterId, `${id}.md`)
    await this.own(path, async () => { await this.files.writeAtomic(path, content) })
    // How it was made is kept beside it, in a file of its own: the version itself stays the text and nothing else.
    if (made !== undefined) {
      const note = this.statePath('versions', chapterId, `${id}.json`)
      await this.own(note, async () => { await this.files.writeAtomic(note, `${JSON.stringify(made, null, 2)}\n`) })
    }
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

  private async pruneVersions(chapterId: string, keep = VERSIONS_KEPT): Promise<void> {
    const dir = this.statePath('versions', chapterId)
    // A chapter as it was before it was translated is its original: never let go, however many versions come after.
    const names = (await this.files.listDir(dir)).filter(name => name.endsWith('.md') && !name.endsWith(`__${ORIGINAL_REASON}.md`))
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await this.files.removePath(join(dir, name))
      await this.files.removePath(join(dir, `${name.slice(0, -3)}.json`))
      await this.files.removePath(join(dir, `${name.slice(0, -3)}.material.json`))
    }
  }

  /**
   * Keep, beside a version, all its writer was handed: a draft written to be compared is read against what it was
   * written from. It goes when the version goes.
   */
  async keepVersionMaterial(chapterId: string, versionId: string, kept: MaterialKept): Promise<void> {
    if (!/^[\w.-]+$/.test(versionId)) return
    const path = this.statePath('versions', chapterId, `${versionId}.material.json`)
    await this.own(path, async () => { await this.files.writeAtomic(path, `${JSON.stringify(kept)}\n`) })
  }

  /** What the writer of a version was handed, where it was kept with it. */
  async versionMaterial(chapterId: string, versionId: string): Promise<MaterialKept | undefined> {
    if (!/^[\w.-]+$/.test(versionId)) return undefined
    return await this.files.readJson<MaterialKept>(this.statePath('versions', chapterId, `${versionId}.material.json`))
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
      // What is kept of how it was made: only a draft written to be compared has any.
      const made = (reason ?? '').startsWith('trial') ? madeOf(await this.files.readText(join(dir, `${id}.json`))) : undefined
      versions.push({ id, chapterId, createdAt: iso, reason: reason ?? 'edit', words: countWords(text), ...(made !== undefined ? { made } : {}) })
    }
    return versions.reverse()
  }

  /**
   * Delete versions of a chapter for good — drafts nobody took, restore points no longer wanted. The chapter as it
   * was before it was translated is not among what this deletes: it is the only copy of the original.
   * @returns how many went, and the ones that were asked for and stay (`kept`).
   */
  async dropVersions(chapterId: string, ids: readonly string[]): Promise<{ removed: number; kept: string[] }> {
    const dir = this.statePath('versions', chapterId)
    const there = new Set((await this.files.listDir(dir)).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)))
    let removed = 0
    const kept: string[] = []
    for (const id of new Set(ids)) {
      if (!/^[\w.-]+$/.test(id) || !there.has(id)) continue
      if (id.endsWith(`__${ORIGINAL_REASON}`)) {
        kept.push(id)
        continue
      }
      await this.files.removePath(join(dir, `${id}.md`))
      await this.files.removePath(join(dir, `${id}.json`))
      await this.files.removePath(join(dir, `${id}.material.json`))
      removed += 1
    }
    return { removed, kept }
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
    // "Mark as dead?" asked to change a word on a card that cards no longer have: the digest it came from says it by itself.
    return ((await this.readState<Suggestion[]>('suggestions.json')) ?? []).filter(item => (item.kind as string) !== 'character-status')
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
      const settled = name !== undefined && (((item.kind === 'new-character' || item.kind === 'alias') && carded(name)) || (item.kind === 'new-world' && entered(name)))
      if (settled) dropped += 1
      return !settled
    }))
    return dropped
  }

  /**
   * Forget what was read off the text: the digests of these chapters and the summaries of stretches made of them, what
   * waits to be suggested and what was settled of it, what was said of the names without a card, the note of an
   * analysis — and, where asked, what a review found. The text and what was made from it for the eye and the ear stay.
   */
  async forgetReading(chapters: readonly string[], also: { reviews?: boolean } = {}): Promise<{ digests: number; reviews: number; suggestions: number }> {
    let digests = 0
    let reviews = 0
    for (const id of chapters) {
      if (await this.memory(id) !== undefined) {
        await this.removeState('memory', `${id}.json`)
        digests += 1
      }
      if (also.reviews === true && await this.removeReview(id)) reviews += 1
    }
    const suggestions = (await this.suggestions()).length
    for (const file of [['memory', 'arcs.json'], ['suggestions.json'], ['settled.json'], ['walkons.json'], ['analysis.json']]) await this.removeState(...file).catch(() => undefined)
    return { digests, reviews, suggestions }
  }

  /** What was settled of the suggestions without the author being asked, the latest first. */
  async settled(): Promise<SettledSuggestion[]> {
    return (await this.readState<SettledSuggestion[]>('settled.json')) ?? []
  }

  /** Keep word of suggestions that were settled; the oldest give way once there are a great many. */
  async noteSettled(items: Omit<SettledSuggestion, 'at'>[]): Promise<void> {
    if (items.length === 0) return
    const at = new Date().toISOString()
    await this.updateState<SettledSuggestion[]>(['settled.json'], [], current => [...items.map(item => ({ ...item, at })), ...current.filter(old => !items.some(item => item.id === old.id))].slice(0, 600))
  }

  /** Say otherwise of one that was settled: taken back, or entered after all. */
  async resettle(id: string, verdict: SettledSuggestion['verdict'], target?: SettledSuggestion['target']): Promise<SettledSuggestion | undefined> {
    let found: SettledSuggestion | undefined
    await this.updateState<SettledSuggestion[]>(['settled.json'], [], current => current.map((item) => {
      if (item.id !== id) return item
      const { target: _was, ...rest } = item
      found = { ...rest, verdict, ...(target !== undefined ? { target } : {}), at: new Date().toISOString() }
      return found
    }))
    return found
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
      // When it was settled is kept with it; put back to wait, it has not been.
      const { settledAt: _was, ...rest } = item
      found = { ...rest, status, ...(status !== 'pending' ? { settledAt: new Date().toISOString() } : {}) }
      return found
    }))
    return found
  }

  /**
   * Settle a proposal that a later one took in — a mending that went on from it: it waits no longer by itself.
   * @param by - the proposal that stands for it now.
   */
  async supersedeProposal(id: string, by: string): Promise<void> {
    await this.updateState<Proposal[]>(['proposals.json'], [], current => current.map(item => (item.id === id && item.status === 'pending' ? { ...item, status: 'rejected' as const, supersededBy: by } : item)))
  }

  /**
   * The proposals a later one took in wait by themselves again: the one that stood for them was turned down, and what
   * they changed was not what the author turned down.
   * @returns how many came back.
   */
  async restoreSuperseded(by: string): Promise<number> {
    let back = 0
    await this.updateState<Proposal[]>(['proposals.json'], [], current => current.map((item) => {
      if (item.supersededBy !== by || item.status !== 'rejected') return item
      back += 1
      const { supersededBy: _gone, ...rest } = item
      return { ...rest, status: 'pending' as const }
    }))
    return back
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

  /** The portraits the author keeps out of the text, by path. */
  async hiddenFigures(): Promise<string[]> {
    return (await this.readState<string[]>('figures-hidden.json')) ?? []
  }

  /** The portraits the author asked into the text beside the ones that stand there by themselves, by path. */
  async shownFigures(): Promise<string[]> {
    return (await this.readState<string[]>('figures-shown.json')) ?? []
  }

  private async figureList(file: 'figures-hidden.json' | 'figures-shown.json', path: string, listed: boolean): Promise<void> {
    const current = (await this.readState<string[]>(file)) ?? []
    if (current.includes(path) === listed) return
    await this.updateState<string[]>([file], [], now => (listed ? (now.includes(path) ? now : [...now, path]) : now.filter(item => item !== path)))
  }

  /**
   * The author's say on one portrait: in the text, or out of it. Only what differs from where it would stand by
   * itself is written down — one that stands there anyway is noted when it is kept out, one that does not when it is
   * asked in — so the rule goes on holding for every picture nobody said anything about.
   * @param key - the place's key: the picture's path, or `<path>#face` for its place as the portrait of the person.
   */
  async showFigure(key: string, show: boolean): Promise<void> {
    const place = (await this.portraitPlaces()).find(item => item.key === key)
    const byItself = place === undefined || place.spare === undefined
    await this.figureList('figures-hidden.json', key, !show && byItself)
    await this.figureList('figures-shown.json', key, show && !byItself)
  }

  /**
   * Keep a picture out of the text whatever would have it stand there — one drawn only to be compared — or let it be a
   * picture like any other again, standing where the rule has it.
   */
  async holdFigure(path: string, out: boolean): Promise<void> {
    await this.figureList('figures-hidden.json', path, out)
    if (out) await this.figureList('figures-shown.json', path, false)
  }

  /**
   * Every portrait of everybody, and where it stands in the book.
   *
   * A portrait of one of their moments stands where the chapter tells that moment; the portrait that stands for the
   * person (`visual.portrait`: the one the author chose, else their newest plain likeness, else the newest) stands
   * where they first come on (one of a period of their life, where the period begins) — unless a moment of theirs is
   * shown right there: at the same place of the chapter, or so near it that a reader would have both pictures before
   * them ({@link spotsNear}). Then the moment is the picture of them there. (The same picture is never shown twice in
   * a chapter, however far apart its two places.) Of several pictures of one moment the first as the author has them
   * in order is the one. Whatever does not stand by this is `spare`; the author asks any of them in, and keeps any of
   * the others out.
   *
   * The portrait that stands for the person may be one of a moment's: it then has two places — as the picture of
   * the moment, and as the picture of the person (`key` ends in `#face` for that one).
   */
  async portraitPlaces(): Promise<(PortraitPlace & { told: string; names?: string[] })[]> {
    const [characters, records, hidden, shown, outline] = await Promise.all([this.characters(), this.illustrations(), this.hiddenFigures(), this.shownFigures(), this.outline()])
    // Who is in which chapter is read only for somebody whose card does not say where they first come on.
    let seen: CastPresence[] | undefined
    const firstSeen = async (id: string): Promise<string | undefined> => {
      seen ??= await this.presence().catch(() => [] as CastPresence[])
      return seen.find(entry => entry.character === id)?.chapters[0]
    }
    const kept = new Set(hidden)
    const asked = new Set(shown)
    const byPath = new Map(records.map(record => [record.path, record]))
    // Every chapter of every line, as it is counted along its own.
    const places = new Map<string, { index: number; title: string }>()
    for (const line of [undefined, ...(outline.lines ?? []).map(line => line.id)]) for (const chapter of located(linePath(outline, lineOf(outline, line)))) if (!places.has(chapter.plan.id)) places.set(chapter.plan.id, { index: chapter.index, title: chapter.plan.title })
    // Where somebody first comes on along a line other than the main one — read only for whoever the main line never shows.
    let elsewhere: Map<string, string> | undefined
    const firstElsewhere = async (id: string): Promise<string | undefined> => {
      if (elsewhere === undefined) {
        elsewhere = new Map()
        for (const line of outline.lines ?? []) {
          const along = await this.lives(line.id).catch(() => undefined)
          if (along === undefined) continue
          for (const [who, life] of Object.entries(along.lives)) {
            const at = life.first !== undefined ? along.chapters.find(chapter => chapter.index === life.first)?.id : undefined
            if (at !== undefined && !elsewhere.has(who)) elsewhere.set(who, at)
          }
        }
      }
      return elsewhere.get(id)
    }
    type Held = PortraitPlace & { told: string; names?: string[] }
    const out: Held[] = []
    // The text of a chapter, read where two pictures of one person fall in it: how near they stand is the text's to say.
    const texts = new Map<string, Promise<string>>()
    const textOf = (chapter: string): Promise<string> => {
      let text = texts.get(chapter)
      if (text === undefined) texts.set(chapter, text = this.chapterText(chapter).catch(() => ''))
      return text
    }
    for (const card of characters) {
      const scenes = scenesOf(card)
      const stages = card.stages ?? []
      // In the author's order: the portraits as they stand on the card first, then what else there is of them.
      const paths = [...new Set([
        ...(card.visual?.portraits ?? []),
        ...(card.visual?.portrait !== undefined ? [card.visual.portrait] : []),
        ...scenes.flatMap(scene => (scene.portrait !== undefined ? [scene.portrait] : [])),
        ...stages.flatMap(stage => (stage.visual?.portrait !== undefined ? [stage.visual.portrait] : [])),
        ...records.filter(record => record.kind === 'portrait' && record.target === card.id).map(record => record.path),
      ])]
      if (paths.length === 0) continue
      // Where they first come on: what the digests have, else the first chapter that has them at all.
      const first = card.firstAppearance ?? await firstSeen(card.id) ?? await firstElsewhere(card.id)
      const mine: { place: Held; of: 'moment' | 'stage' | 'person'; group: string }[] = []
      for (const path of paths) {
        const record = byPath.get(path)
        // The moment it is of: the one that keeps it, the one its record names, or the one its record was written from.
        const scene = sceneOfPicture(scenes, path, record)
        const stage = stages.find(item => item.visual?.portrait === path)
        const title = scene?.title ?? record?.moment?.title
        const of = portraitIsOf(card, path, record)
        const names = [card.name, ...(card.aliases ?? [])]
        const chapter = [scene?.chapter, record?.moment?.chapter, stage?.from, first].find(id => id !== undefined && places.has(id))
        const at = chapter !== undefined ? places.get(chapter) : undefined
        mine.push({
          of,
          group: of === 'moment' ? `moment:${scene?.id ?? record?.moment?.scene ?? title ?? ''}` : of === 'stage' ? `stage:${stage!.id}` : 'person',
          place: {
            key: path,
            path,
            as: of === 'stage' ? 'period' : of,
            character: card.id,
            name: card.name,
            ...(title !== undefined && title.length > 0 ? { title } : {}),
            ...(chapter !== undefined && at !== undefined ? { chapter, index: at.index, chapterTitle: at.title } : {}),
            hidden: false,
            // What the text is searched for to place it: the moment as it is written — else where it first names them.
            told: scene !== undefined ? `${scene.title}${scene.text}` : `${title ?? ''}${names.join('')}`,
            ...(of !== 'moment' ? { names } : {}),
          },
        })
      }
      // The portrait that stands for them. Where it is a picture of a moment (or of a period), it stands for the
      // person as well, in a place of its own: where they first come on.
      const face = card.visual?.portrait
      const faced = face !== undefined ? mine.find(item => item.place.path === face) : undefined
      if (faced !== undefined && faced.of !== 'person') {
        const at = first !== undefined ? places.get(first) : undefined
        mine.push({
          of: 'person',
          group: 'person',
          place: {
            key: `${faced.place.path}#face`,
            path: faced.place.path,
            as: 'person',
            character: card.id,
            name: card.name,
            ...(first !== undefined && at !== undefined ? { chapter: first, index: at.index, chapterTitle: at.title } : {}),
            hidden: false,
            told: [card.name, ...(card.aliases ?? [])].join(''),
            names: [card.name, ...(card.aliases ?? [])],
          },
        })
      }
      // One picture for each moment and each period — the one the moment keeps as its own (the author's choice among
      // those drawn of it), else the first of each as they are in order — and one for the person: the one that stands for them.
      const led = new Set<string>()
      const own = new Map(scenes.filter(scene => scene.portrait !== undefined).map(scene => [`moment:${scene.id}`, scene.portrait!]))
      // A moment's own picture leads its group wherever it stands in the order.
      mine.sort((left, right) => Number(own.get(right.group) === right.place.path) - Number(own.get(left.group) === left.place.path))
      for (const item of mine) {
        if (item.of === 'person') {
          if (face !== undefined && item.place.path !== face) item.place.spare = 'person'
          else if (led.has('person')) item.place.spare = 'person'
          else led.add('person')
        } else if (led.has(item.group)) item.place.spare = item.of === 'moment' ? 'moment' : 'person'
        else led.add(item.group)
      }
      const stands = (place: Held): boolean => !kept.has(place.key) && (place.spare === undefined || asked.has(place.key))
      // Where a moment of theirs is shown right there — the same place of the chapter, or so near that both would be
      // seen together — that is the picture of them: the one of the person does not stand beside it. Further apart in
      // the same chapter, each stands in its place (they are two pictures: how they look, and what they did). The
      // same picture is not shown twice in a chapter, wherever its places are.
      for (const rank of ['stage', 'person'] as const) {
        for (const item of mine) {
          const chapter = item.place.chapter
          if (item.of !== rank || item.place.spare !== undefined || chapter === undefined) continue
          const rivals = mine.filter(other => other !== item && (other.of === 'moment' || (rank === 'person' && other.of === 'stage')) && other.place.chapter === chapter && stands(other.place))
          if (rivals.length === 0) continue
          let over = rivals.some(other => other.place.path === item.place.path)
          if (!over) {
            const text = await textOf(chapter)
            const spots = figureSpots(text, [item.place, ...rivals.map(other => other.place)])
            over = rivals.some((_other, at) => spotsNear(text, spots[0], spots[at + 1]))
          }
          if (over) item.place.spare = 'chapter'
        }
      }
      for (const { place } of mine) out.push({ ...place, hidden: !stands(place) })
    }
    return out
  }

  /**
   * The portraits that stand in a chapter, each where the chapter tells it: shown beside the text to whoever reads it,
   * without being written into it — see {@link portraitPlaces} for which.
   */
  async chapterFigures(chapterId: string, text?: string): Promise<ChapterFigure[]> {
    const moments = (await this.portraitPlaces())
      .filter(place => place.chapter === chapterId && !place.hidden)
      .map(place => ({ path: place.path, key: place.key, caption: place.title !== undefined ? `${place.title} · ${place.name}` : place.name, told: place.told, ...(place.names !== undefined ? { names: place.names } : {}) }))
    return moments.length > 0 ? placeFigures(text ?? await this.chapterText(chapterId), moments) : []
  }

  // ───────────── stage documents ─────────────

  async audioScript(chapterId: string): Promise<AudioScript | undefined> {
    return await this.readState<AudioScript>('audio', `${chapterId}.json`)
  }

  async saveAudioScript(script: AudioScript, notify = true): Promise<void> {
    await this.keepDoc('script', script.chapterId, await this.audioScript(script.chapterId), script)
    await this.writeState(['audio', `${script.chapterId}.json`], script, notify)
  }

  /**
   * A chapter's script or storyboard as it was, kept where what is about to be written says something else: who says
   * what and how, what a panel shows. A take spoken or a picture drawn changes nothing of that, and keeps nothing.
   * @param next - what is about to be written; left out when the thing is taken away.
   */
  private async keepDoc(kind: 'script' | 'board', id: string, before: object | undefined, next?: object): Promise<void> {
    if (before === undefined) return
    if (next !== undefined && said(kind, before as Record<string, unknown>) === said(kind, next as Record<string, unknown>)) return
    const kept = async (): Promise<void> => { await this.keep(kind, id, `${JSON.stringify(before, null, 2)}\n`, 'json') }
    if (next === undefined) await this.because('removed', kept)
    else await kept()
  }

  /** Take a chapter's audio script away; the takes spoken for it stay on disk, where a script made again finds them. */
  async removeAudioScript(chapterId: string): Promise<boolean> {
    const script = await this.audioScript(chapterId)
    if (script === undefined) return false
    await this.keepDoc('script', chapterId, script)
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
    await this.keepDoc('board', board.chapterId, await this.comicBoard(board.chapterId), board)
    await this.writeState(['comic', `${board.chapterId}.json`], board, notify)
  }

  /**
   * Change panels of a chapter's storyboard as it is *now*, under its lock: several drawings of one chapter — a panel
   * drawn again here, three more there — each keep what they drew without writing over what another kept meanwhile.
   * A panel the storyboard no longer has is let be.
   * @returns the storyboard as it then stands; nothing where the chapter has none (it was taken away meanwhile).
   */
  async patchComicPanels(chapterId: string, updates: ReadonlyMap<string, Partial<ComicPanel>>): Promise<ComicBoard | undefined> {
    const path = this.statePath('comic', `${chapterId}.json`)
    return await this.mutex.run(path, async () => {
      const current = await this.files.readJson<ComicBoard>(path)
      if (current === undefined || current === null) return undefined
      const next: ComicBoard = {
        ...current,
        updatedAt: new Date().toISOString(),
        panels: current.panels.map((panel) => {
          const update = updates.get(panel.id)
          if (update === undefined) return panel
          const merged = { ...panel, ...update }
          // A picture takes the place of whatever went wrong before it; `image: undefined`, said outright, takes the picture off the panel.
          if (update.image !== undefined) delete merged.error
          else if ('image' in update) delete merged.image
          return merged
        }),
      }
      await this.keepDoc('board', chapterId, current, next)
      await this.writeDoc(path, next)
      return next
    })
  }

  /** Take a chapter's storyboard away; the pictures drawn for it stay in the gallery. */
  async removeComicBoard(chapterId: string): Promise<boolean> {
    const board = await this.comicBoard(chapterId)
    if (board === undefined) return false
    await this.keepDoc('board', chapterId, board)
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

  /** Every chapter's storyboard the book has. */
  async comicBoards(): Promise<ComicBoard[]> {
    const names = (await this.files.listDir(this.statePath('comic')).catch(() => [] as string[])).filter(name => name.endsWith('.json'))
    const boards = await Promise.all(names.map(name => this.readState<ComicBoard>('comic', name)))
    return boards.filter((board): board is ComicBoard => board !== undefined && board !== null && Array.isArray(board.panels))
  }

  /**
   * Every picture of the book, oldest first: those on record, and — a picture is a picture, whatever page made it —
   * the panels of its storyboards that were drawn before panels were kept on record. Of such a panel what is known
   * is said: its prompt, its chapter, when the storyboard was last touched; its id names the panel
   * (`panel:<chapter>:<panel>`), since there is no record to name it by.
   */
  async pictures(): Promise<IllustrationInfo[]> {
    const recorded = await this.illustrations()
    const known = new Set(recorded.map(item => item.path))
    const loose: IllustrationInfo[] = []
    for (const board of await this.comicBoards()) {
      for (const panel of board.panels) {
        if (panel.image === undefined || known.has(panel.image)) continue
        known.add(panel.image)
        loose.push({ id: `panel:${board.chapterId}:${panel.id}`, path: panel.image, prompt: panel.prompt, kind: 'panel', target: board.chapterId, createdAt: board.updatedAt })
      }
    }
    return loose.length === 0 ? recorded : [...recorded, ...loose].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /** The panel a picture is the picture of, where it is one's: which chapter's storyboard, which panel of it, and where in the row. */
  async panelOf(path: string): Promise<{ board: ComicBoard; panel: ComicPanel; index: number } | undefined> {
    for (const board of await this.comicBoards()) {
      const index = board.panels.findIndex(panel => panel.image === path)
      if (index >= 0) return { board, panel: board.panels[index]!, index }
    }
    return undefined
  }

  /**
   * The picture that stands for the book: the one the author chose, else the
   * latest cover drawn. A chosen picture that no longer exists is not a cover.
   */
  async cover(): Promise<string | undefined> {
    const chosen = (await this.manifest()).cover
    if (chosen !== undefined && chosen.length > 0 && await this.has(chosen)) return chosen
    // (A cover drawn only to be compared with others is no cover until the author takes it.)
    const drawn = (await this.illustrations()).filter(item => item.kind === 'cover' && item.trial?.hang === undefined).at(-1)?.path
    return drawn !== undefined && await this.has(drawn) ? drawn : undefined
  }

  /**
   * A picture drawn to be compared was taken: it is a picture like any other from here on — its record no longer says
   * where it waits to go, and it stands in the text where the others of its kind would.
   */
  async tookTrial(path: string): Promise<void> {
    await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], current => current.map((item) => {
      if (item.path !== path || item.trial?.hang === undefined) return item
      const { hang: _hung, ...trial } = item.trial
      return { ...item, trial }
    }))
    await this.holdFigure(path, false)
  }

  /**
   * The picture others waited to take the place of has had its place taken (`by`): they wait to take it from that
   * one now — a second one chosen of the same comparison goes where the first went.
   */
  async trialsInstead(of: string, by: string): Promise<void> {
    await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], current => current.map((item) => {
      const hang = item.trial?.hang
      if (item.path === by || hang === undefined || hang.as !== 'instead' || hang.of !== of) return item
      return { ...item, trial: { ...item.trial!, hang: { as: 'instead', of: by } } }
    }))
  }

  async addIllustration(info: IllustrationInfo): Promise<void> {
    await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], current => [...current, info])
  }

  /**
   * Take a picture out of the book: its file, its record in the gallery where it has one, and every place that
   * shows it — a card's portraits, its design sheet, a look's or a stretch's pictures, the portrait of a moment; an
   * entry's design art, the picture of a turn of its course; the cover. Text that embeds it is let be.
   * @param ref - the picture, by the id of its record or by its path (one drawn before records were kept, or copied in).
   * @returns whose picture it was, by name — nobody where it hung nowhere.
   * @throws ProjectError `novel/invalid` for a path that is not one of the book's pictures.
   */
  async removePicture(ref: { id?: string; path?: string }): Promise<string[]> {
    let path: string | undefined = ref.path?.trim()
    await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], (current) => {
      const record = ref.id !== undefined ? current.find(item => item.id === ref.id) : current.find(item => item.path === path)
      if (record !== undefined) path = record.path
      if (path === undefined) return current
      // A picture made of this one by hand (cut, turned) has nothing to be made anew from once this is gone: it is a
      // picture on its own from here on.
      const made = current.some(item => item.edited?.of === path)
      if (record === undefined && !made) return current
      return current.filter(item => item !== record).map((item) => {
        if (item.edited?.of !== path) return item
        const { edited: _made, ...alone } = item
        return alone
      })
    })
    if (path === undefined || path.length === 0) return []
    if (!/^assets\/[^\0]+\.(png|jpe?g|webp|gif)$/i.test(path) || path.split('/').includes('..')) throw new ProjectError('novel/invalid', `"${path}" is not one of the book's pictures`)
    await this.remove(this.path(path))
    return await this.letGo(path, true)
  }

  /**
   * Take a picture down from whoever holds it as theirs — a card's portraits, its design sheets, a look's or a
   * stretch's pictures, the portrait of a moment; an entry's design pictures, the picture of a turn of its course.
   * The picture itself stays in the book: its file, its record. Where the text shows it, the panel of a storyboard
   * it is the picture of, and its being the cover are let be: those show a picture, whoever's it is.
   * @returns who held it, by name.
   */
  async takeDown(path: string): Promise<string[]> {
    return await this.letGo(path, false)
  }

  /**
   * Say anew what a picture of the book is — what kind of picture, and whose: its record is kept by that from here
   * on, and made where the picture had none. What one drawn here was made as is kept beside it (`madeAs`): the
   * record of its making is of that. Filed again as what it was made as, nothing is said. Nothing is hung by this: see `usePictureAs`.
   * @param from - the picture as it is known where it has no record of its own (a panel drawn before records were kept).
   * @returns its record as it stands now.
   */
  async refilePicture(path: string, as: { kind: IllustrationInfo['kind']; target?: string; moment?: NonNullable<IllustrationInfo['moment']>; /** A portrait drawn of a moment, said to be of none. */ ofNoMoment?: boolean }, from?: IllustrationInfo): Promise<IllustrationInfo> {
    let filed: IllustrationInfo | undefined
    await this.updateState<IllustrationInfo[]>(['illustrations.json'], [], (current) => {
      const at = current.findIndex(item => item.path === path)
      const old = at >= 0 ? current[at]! : from
      const { target: _whose, moment: _moment, ofNoMoment: _apart, madeAs: made, trial, ...rest } = old ?? { id: '', path, prompt: '', kind: as.kind, createdAt: new Date().toISOString() }
      const was = made ?? (old !== undefined ? { kind: old.kind, ...(old.target !== undefined ? { target: old.target } : {}) } : undefined)
      const { hang: _waits, ...tried } = trial ?? { id: '', label: '' }
      filed = {
        ...rest,
        // (A record made here has an id of its own: the one a picture without a record goes by names where it is shown.)
        id: at >= 0 ? rest.id : newId('img'),
        kind: as.kind,
        ...(as.target !== undefined ? { target: as.target } : {}),
        ...(as.moment !== undefined ? { moment: as.moment } : as.ofNoMoment === true ? { ofNoMoment: true } : {}),
        ...(trial !== undefined ? { trial: tried } : {}),
        // (One brought in was not made as anything: there is no record of its making to be of something else.)
        ...(was !== undefined && rest.imported !== true && (was.kind !== as.kind || was.target !== as.target) ? { madeAs: was } : {}),
      }
      const record = filed
      return at >= 0 ? current.map((item, index) => (index === at ? record : item)) : [...current, record]
    })
    return filed!
  }

  /** Every place that holds a picture lets go of it: the cards and the entries — and, where it is gone from the book (`gone`), the panels and the cover too. */
  private async letGo(gone: string, all: boolean): Promise<string[]> {
    const held: string[] = []
    for (const card of await this.characters()) {
      const visual = card.visual
      const looks = visual?.looks ?? []
      const dressed = looks.some(look => look.sheet === gone)
      const scenes = visual?.scenes ?? []
      const staged = scenes.some(scene => scene.portrait === gone)
      const portraits = visual?.portraits ?? (visual?.portrait !== undefined ? [visual.portrait] : [])
      const faced = portraits.includes(gone)
      const stages = card.stages ?? []
      const aged = stages.some(stage => stage.visual?.sheet === gone || stage.visual?.portrait === gone)
      const sheets = sheetPool(card)
      const sheeted = sheets.includes(gone)
      if (!(faced || sheeted || dressed || staged || aged)) continue
      await this.saveCharacter({
        id: card.id,
        ...(faced || sheeted || dressed || staged ? { visual: {
          ...(faced ? { portraits: portraits.filter(item => item !== gone) } : {}),
          // Out of the sheets kept of them — whatever it was used as: another becomes the main one, a stretch is without.
          ...(sheeted ? { sheets: sheets.filter(item => item !== gone), fronts: [...sheetFronts(card)].filter(item => item !== gone) } : {}),
          ...(dressed ? { looks: looks.map(look => (look.sheet === gone ? { ...look, sheet: '' } : look)) } : {}),
          ...(staged ? { scenes: scenes.map(({ portrait, ...scene }) => (portrait === undefined || portrait === gone ? scene : { ...scene, portrait })) } : {}),
        } } : {}),
        ...(aged ? { stages: stages.map((stage) => {
          if (stage.visual?.sheet !== gone && stage.visual?.portrait !== gone) return stage
          const { sheet, portrait, ...rest } = stage.visual
          const kept = { ...rest, ...(sheet !== undefined && sheet !== gone ? { sheet } : {}), ...(portrait !== undefined && portrait !== gone ? { portrait } : {}) }
          const { visual: _was, ...bare } = stage
          return Object.keys(kept).length > 0 ? { ...bare, visual: kept } : bare
        }) } : {}),
      })
      held.push(card.name)
    }
    for (const entry of await this.world()) {
      const turns = entry.events ?? []
      const turned = turns.some(turn => turn.image === gone)
      const arts = artPool(entry)
      const pictured = arts.includes(gone)
      if (!pictured && !turned) continue
      await this.saveWorld({
        id: entry.id,
        // Out of the design pictures kept of it — the main one or not: where it was the main one, the next is.
        ...(pictured ? (arts.length > 1 ? { visualImages: arts.filter(item => item !== gone) } : { visualImage: '', visualImages: [] }) : {}),
        ...(turned ? { events: turns.map(({ image, ...turn }) => (image === undefined || image === gone ? turn : { ...turn, image })) } : {}),
      })
      held.push(entry.name)
    }
    if (!all) return held
    // A panel of a storyboard that showed it is a panel without a picture again.
    for (const board of await this.comicBoards()) {
      const shown = board.panels.filter(panel => panel.image === gone)
      if (shown.length === 0) continue
      await this.patchComicPanels(board.chapterId, new Map(shown.map(panel => [panel.id, { image: undefined } as Partial<ComicPanel>])))
      held.push((await this.findChapter(board.chapterId))?.plan.title ?? board.chapterId)
    }
    const manifest = await this.manifest()
    if (manifest.cover === gone) {
      await this.updateManifest({ cover: '' })
      held.push(manifest.title)
    }
    return held
  }

  /**
   * A picture drawn again takes the place of the one it was drawn from, wherever that one hangs: a card's design
   * sheet, a look's sheet, a stretch's pictures, the portrait of a moment; an entry's design art, the picture of a
   * turn of its course; the cover. Among somebody's portraits, and among their design sheets, it is put before the
   * old one, which stays — they are kept side by side, the old sheet not in use. The old picture itself, its file and
   * its record, is let be: the gallery has both.
   * @returns whose picture it is now, by name — nobody where the old one hung nowhere.
   */
  async replacePicture(old: string, next: string): Promise<string[]> {
    const held: string[] = []
    for (const card of await this.characters()) {
      const visual = card.visual
      const looks = visual?.looks ?? []
      const dressed = looks.some(look => look.sheet === old)
      const scenes = visual?.scenes ?? []
      const staged = scenes.some(scene => scene.portrait === old)
      const portraits = visual?.portraits ?? (visual?.portrait !== undefined ? [visual.portrait] : [])
      const faced = portraits.includes(old)
      const stages = card.stages ?? []
      const aged = stages.some(stage => stage.visual?.sheet === old || stage.visual?.portrait === old)
      const sheets = sheetPool(card)
      const sheeted = sheets.includes(old)
      if (!(faced || sheeted || dressed || staged || aged)) continue
      await this.saveCharacter({
        id: card.id,
        ...(faced || sheeted || dressed || staged ? { visual: {
          ...(faced ? { portraits: portraits.flatMap(item => (item === old ? [next, old] : [item])), ...(visual?.face === old ? { face: next } : {}) } : {}),
          // Among their sheets it is put before the old one, which stays, not in use: what the old one was — the
          // main sheet (chosen, or for being first), a stretch's — the new one is.
          ...(sheeted ? {
            sheets: sheets.flatMap(item => (item === old ? [next, old] : [item])),
            fronts: [...sheetFronts(card), ...(sheetFronts(card).has(old) ? [next] : [])],
            ...(visual?.sheet === old ? { sheet: next } : {}),
            ...(visual?.mainSheet === old ? { mainSheet: next } : {}),
          } : {}),
          ...(dressed ? { looks: looks.map(look => (look.sheet === old ? { ...look, sheet: next } : look)) } : {}),
          ...(staged ? { scenes: scenes.map(scene => (scene.portrait === old ? { ...scene, portrait: next } : scene)) } : {}),
        } } : {}),
        ...(aged ? { stages: stages.map(stage => (stage.visual?.sheet === old || stage.visual?.portrait === old
          ? { ...stage, visual: { ...stage.visual, ...(stage.visual.sheet === old ? { sheet: next } : {}), ...(stage.visual.portrait === old ? { portrait: next } : {}) } }
          : stage)) } : {}),
      })
      held.push(card.name)
    }
    for (const entry of await this.world()) {
      const turns = entry.events ?? []
      const turned = turns.some(turn => turn.image === old)
      const arts = artPool(entry)
      const pictured = arts.includes(old)
      if (!pictured && !turned) continue
      await this.saveWorld({
        id: entry.id,
        // Among its design pictures it is put before the old one, which stays, not in use: what the old one was —
        // the main picture, chosen or for being first — the new one is.
        ...(pictured ? {
          visualImages: arts.flatMap(item => (item === old ? [next, old] : [item])),
          ...(entry.visualImage === old ? { visualImage: next } : {}),
          ...(entry.visualMain === old ? { visualMain: next } : {}),
        } : {}),
        ...(turned ? { events: turns.map(turn => (turn.image === old ? { ...turn, image: next } : turn)) } : {}),
      })
      held.push(entry.name)
    }
    for (const board of await this.comicBoards()) {
      const shown = board.panels.filter(panel => panel.image === old)
      if (shown.length === 0) continue
      await this.patchComicPanels(board.chapterId, new Map(shown.map(panel => [panel.id, { image: next }])))
      held.push((await this.findChapter(board.chapterId))?.plan.title ?? board.chapterId)
    }
    const manifest = await this.manifest()
    if (manifest.cover === old) {
      await this.updateManifest({ cover: next })
      held.push(manifest.title)
    }
    return held
  }

  /**
   * Put a picture the book has into a chapter's text: after the paragraph so many from the top (`after`, counting
   * from 1; 0 is before everything), after the paragraph a passage ends in (`quote`), or at the end. The text as it
   * was is kept as a version.
   * @returns where it went: the paragraph it now follows (0 for the top).
   * @throws ProjectError `novel/not-found` for a chapter that is not there; `novel/invalid` for what is not a picture of the book.
   */
  async placePicture(chapterRef: string, path: string, where: { after?: number; quote?: string; alt?: string } = {}): Promise<{ chapter: string; after: number }> {
    const chapter = await this.findChapter(chapterRef)
    if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
    if (!/^assets\/[^\0]+\.(png|jpe?g|webp|gif)$/i.test(path) || path.split('/').includes('..') || !await this.has(path)) throw new ProjectError('novel/invalid', `"${path}" is not one of the book's pictures`)
    const text = await this.chapterText(chapter.plan.id)
    // Paragraphs as the text has them — runs of lines parted by blank ones — and where each ends. The text itself is
    // not written anew: the picture goes in at one place, and everything else stays as its author left it.
    const ends: number[] = []
    let at = 0
    for (const part of text.split(/(\n{2,})/)) {
      at += part.length
      if (part.trim().length > 0) ends.push(at)
    }
    let after = ends.length
    if (where.quote !== undefined && where.quote.trim().length > 0) {
      const found = fuzzyFind(text, where.quote.trim())
      if (found !== undefined) after = Math.max(1, ends.findIndex(stop => stop >= found.end) + 1 || ends.length)
    } else if (where.after !== undefined && Number.isFinite(where.after)) after = Math.max(0, Math.min(ends.length, Math.floor(where.after)))
    const tag = `![${(where.alt ?? '').replace(/[\]\n]/g, ' ').trim()}](${path})`
    const stop = after === 0 ? 0 : ends[after - 1]!
    const before = text.slice(0, stop)
    const rest = text.slice(stop).replace(/^\n+/, '')
    const next = `${before}${before.length > 0 ? '\n\n' : ''}${tag}${rest.length > 0 ? `\n\n${rest}` : '\n'}`
    await this.saveChapterText(chapter.plan.id, next, { reason: 'before-illustration' })
    return { chapter: chapter.plan.id, after }
  }

  /** The chapters whose text shows a picture — a line of it names the picture — on every line of the plot, by title. */
  async textsShowing(path: string): Promise<string[]> {
    const outline = await this.outline()
    const shown: string[] = []
    for (const plan of [...outline.volumes.flatMap(volume => volume.chapters), ...(outline.lines ?? []).flatMap(line => line.chapters)]) {
      const text = await this.chapterText(plan.id).catch(() => '')
      if (text.includes(`](${path})`)) shown.push(plan.title)
    }
    return shown
  }

  /**
   * A design sheet that has come to show one figure alone — cut down from the three views to the one that faces — is
   * kept as that wherever it is somebody's sheet: one of theirs, a stretch's, a look's. Whoever shows it, or holds a
   * picture against it, then takes it whole.
   */
  async sheetShowsOne(path: string): Promise<void> {
    for (const card of await this.characters()) {
      const fronts = sheetFronts(card)
      const looks = card.visual?.looks ?? []
      const stages = card.stages ?? []
      const listed = sheetPool(card).includes(path) && !fronts.has(path)
      const dressed = looks.some(look => look.sheet === path && look.sheetFront !== true)
      const aged = stages.some(stage => stage.visual?.sheet === path && stage.visual.sheetFront !== true)
      if (!listed && !dressed && !aged) continue
      await this.saveCharacter({
        id: card.id,
        ...(listed || dressed ? { visual: {
          ...(listed ? { fronts: [...fronts, path] } : {}),
          ...(dressed ? { looks: looks.map(look => (look.sheet === path ? { ...look, sheetFront: true } : look)) } : {}),
        } } : {}),
        ...(aged ? { stages: stages.map(stage => (stage.visual?.sheet === path ? { ...stage, visual: { ...stage.visual, sheetFront: true } } : stage)) } : {}),
      })
    }
  }

  /** {@link removePicture}, by the id of a picture's record. */
  async removeIllustration(id: string): Promise<string[]> {
    return await this.removePicture({ id })
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
    const memories = await this.memories(path)
    const digested = new Set(memories.map(entry => entry.chapter.plan.id))
    return { chapters: path.map(chapter => ({ id: chapter.plan.id, index: chapter.index, title: chapter.plan.title, digested: digested.has(chapter.plan.id) })), lives: livesFrom(memories, await this.characters(), path, (await this.castResolver()).whose) }
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
    const { whose } = await this.castResolver()
    for (const { chapter, memory } of memories) {
      for (const moment of memory.characters) {
        if (moment.learned === undefined || moment.learned.length === 0) continue
        const card = cards.find(candidate => candidate.id === whose(moment, chapter.plan.id))
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

  private seenAt: { revision: number; lines: Map<string, WorldPresence[]> } | undefined

  /**
   * Where each entry of the bible is named, and how many chapters there are to name it in.
   * @param line - a line other than the main one: as read along it.
   */
  async worldPresence(line?: string): Promise<{ presence: WorldPresence[]; written: number }> {
    const along = line !== undefined && line !== MAIN_LINE ? line : undefined
    const chapters = await this.chapterInfos(along)
    return { presence: await this.worldSeen(await this.world(), chapters, along), written: chapters.filter(chapter => chapter.hasText).length }
  }

  /**
   * Where each entry of the bible is named: in the text of which chapters, by
   * its name or another of its names, and where a digest wrote a place down.
   * Read once per state of the book — the whole manuscript is gone through.
   */
  private async worldSeen(world: readonly WorldEntry[], chapters: readonly ChapterInfo[], line?: string): Promise<WorldPresence[]> {
    const revision = this.revisionValue
    if (this.seenAt?.revision !== revision) this.seenAt = { revision, lines: new Map() }
    const kept = this.seenAt.lines.get(line ?? MAIN_LINE)
    if (kept !== undefined) return kept
    const written = chapters.filter(chapter => chapter.hasText)
    const texts = await Promise.all(written.map(async chapter => ({ id: chapter.id, text: await this.chapterText(chapter.id) })))
    const noted = new Map<string, readonly string[]>()
    // What a chapter's digest wrote down is there, whether the text spells the name out or only points at it: where it
    // happens, and whatever it met for the first time.
    for (const { chapter, memory } of await this.memories(line !== undefined ? await this.chapters(line) : undefined)) {
      const names = [...(memory.locations ?? []), ...(memory.newEntities ?? []).filter(entity => entity.kind !== 'character').map(entity => entity.name)]
      if (names.length > 0) noted.set(chapter.plan.id, names)
    }
    const value = worldPresence(world, texts, noted)
    // Kept for the state of the book it was read from: something may have been written while the manuscript was gone through.
    if (this.seenAt.revision === revision) this.seenAt.lines.set(line ?? MAIN_LINE, value)
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
    const { whose } = await this.castResolver()
    for (const { chapter, memory } of memories) {
      const here = new Set<string>()
      for (const moment of memory.characters) {
        const card = characters.find(candidate => candidate.id === whose(moment, chapter.plan.id))
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
    const told = livesFrom(memories, characters, await this.chapters(), whose)
    const presence = characters.map((card): CastPresence => {
      const chapters = byCharacter.get(card.id) ?? []
      const last = chapters.at(-1)
      const absentFor = last === undefined ? digested.length : digested.length - 1 - digested.indexOf(last)
      const life = told[card.id]
      return { character: card.id, chapters, absentFor, ...(life?.death !== undefined ? { death: life.death } : {}), ...(life?.exit !== undefined ? { exit: life.exit } : {}) }
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
    // Stamped with the revision it was begun at: what is written while it is being read — a proposal added a moment
    // after the others — makes the book newer than this says, and whoever holds it asks again.
    const revision = this.revision
    const [manifest, outline, chapters, characters, world, styles, suggestions, proposals, cast, cover, activity, pending, removed] = await Promise.all([
      this.manifest(), this.outline(), this.chapterInfos(), this.characters(), this.world(), this.styles(),
      this.suggestions(), this.proposals(), this.castFacts(), this.cover(), this.activity(20), this.analysisPending(), this.removedChapters(),
    ])
    const presence = cast.presence
    const graph = await this.graphPlaces()
    const translations = await this.translations()
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
    const references = await this.referenceCount()
    const jottings = await this.jottingCount()
    const derivations = await this.derivationCount()
    // Pictures drawn to be compared that nobody has taken yet: said with the book, so that wherever the author is they can be found again.
    const waiting = (await this.illustrations()).filter(item => item.trial?.hang !== undefined).length
    const derived = await this.readState<DerivedPlan>('derived.json')
    return {
      root: this.root,
      revision,
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
      // (One a later proposal took in was not turned down by anybody: it is that proposal's to bring back.)
      ...(proposals.some(proposal => proposal.status === 'rejected' && proposal.supersededBy === undefined) ? { turnedDown: proposals.filter(proposal => proposal.status === 'rejected' && proposal.supersededBy === undefined).length } : {}),
      presence,
      ...(cover !== undefined ? { cover } : {}),
      activity,
      ...(lines.length > 0 ? { lines } : {}),
      ...(pending.length > 0 ? { analysis: { pending } } : {}),
      ...(cast.uncarded.count > 0 ? { uncarded: cast.uncarded } : {}),
      ...(removed.length > 0 ? { removed } : {}),
      worldPresence: await this.worldSeen(world, chapters),
      ties: await this.ties(),
      ...(Object.keys(graph).length > 0 ? { graph } : {}),
      ...(Object.keys(translations).length > 0 ? { translations } : {}),
      ...(references > 0 ? { references } : {}),
      ...(jottings > 0 ? { jottings } : {}),
      ...(derivations !== undefined ? { derivations } : {}),
      ...(waiting > 0 ? { waiting } : {}),
      ...(derived !== undefined && Array.isArray(derived.chapters) && derived.chapters.length > 0 ? { derived: { chapters: derived.chapters.length, at: derived.at } } : {}),
    }
  }

  /** The records of the book's derivations: how many, and when one last changed — read off their file, which the engine keeps (`derivations/index.json`). */
  private async derivationCount(): Promise<{ count: number; at: string } | undefined> {
    try {
      const file = JSON.parse((await this.readFile('derivations/index.json')).toString('utf8')) as { items?: { changed?: unknown }[] }
      const items = Array.isArray(file.items) ? file.items : []
      if (items.length === 0) return undefined
      return { count: items.length, at: items.reduce((latest, item) => typeof item.changed === 'string' && item.changed > latest ? item.changed : latest, '') }
    } catch {
      return undefined
    }
  }

  /** How many jottings the book keeps: counted off their file, which the engine keeps (`jottings/index.json`). */
  private async jottingCount(): Promise<number> {
    try {
      const file = JSON.parse((await this.readFile('jottings/index.json')).toString('utf8')) as { items?: unknown[] }
      return Array.isArray(file.items) ? file.items.length : 0
    } catch {
      return 0
    }
  }

  /** How many references of the book are consulted now: counted off its list, which the engine keeps (`references/index.json`). */
  private async referenceCount(): Promise<number> {
    try {
      const index = JSON.parse((await this.readFile('references/index.json')).toString('utf8')) as { items?: { off?: boolean }[] }
      return Array.isArray(index.items) ? index.items.filter(item => item?.off !== true).length : 0
    } catch {
      return 0
    }
  }

  /**
   * Where the author moved people to on the picture of who is what to whom
   * (`.novel/graph.json`): theirs alone, so nothing of the book's record.
   * Whoever has no card any more is left out.
   */
  async graphPlaces(): Promise<Record<string, { x: number; y: number }>> {
    const kept = (await this.readState<Record<string, { x: number; y: number }>>('graph.json')) ?? {}
    const cards = new Set((await this.characters()).map(card => card.id))
    return Object.fromEntries(Object.entries(kept).filter(([id, at]) => cards.has(id) && Number.isFinite(at?.x) && Number.isFinite(at?.y)))
  }

  /**
   * Put somebody at a spot of that picture, or let them stand where the layout
   * puts them again (no `at`), or let everybody (no `id`).
   * @throws ProjectError `novel/not-found` for somebody without a card; `novel/invalid` for a spot that is no spot.
   */
  async placeInGraph(id?: string, at?: { x: number; y: number }): Promise<Record<string, { x: number; y: number }>> {
    const card = id !== undefined ? await this.findCharacter(id) : undefined
    if (id !== undefined && card === undefined) throw new ProjectError('novel/not-found', `no character matches "${id}"`)
    if (at !== undefined && !(Number.isFinite(at.x) && Number.isFinite(at.y))) throw new ProjectError('novel/invalid', 'a place on the picture is {x, y}, two numbers')
    await this.updateState<Record<string, { x: number; y: number }>>(['graph.json'], {}, (current) => {
      if (card === undefined) return {}
      const { [card.id]: _was, ...others } = current
      // Kept to a tenth of a unit: nobody places a mark finer than that, and the file stays readable.
      return at !== undefined ? { ...others, [card.id]: { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 } } : others
    })
    return await this.graphPlaces()
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

  /**
   * Take away a manuscript kept among the book's references. Only a file of that folder: every other file of a book
   * has its own way of going — a chapter into the removed ones, a picture off whatever shows it.
   * @throws ProjectError `novel/invalid` for any other path.
   */
  async removeReferenceFile(relativePath: string): Promise<void> {
    if (!/^references\/[^/]+\.txt$/.test(relativePath.replace(/\\/g, '/'))) throw new ProjectError('novel/invalid', `not a reference's file: ${relativePath}`)
    await this.remove(this.path(relativePath))
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
 * Everyone's life as a run of chapters tells it: what their digests noted, and
 * over it what the author wrote down themselves (`CharacterCard.lifeMarks`).
 * The chapters handed in are all that has happened — one line of the plot, or
 * that line as far as some chapter.
 * @param path - the chapters that count, in reading order: a mark holds where its chapter is among them, digested or not;
 *   a mark with no chapter lies before the story, and holds on every line.
 */
export function livesFrom(memories: readonly { chapter: LocatedChapter; memory: ChapterMemory }[], characters: readonly CharacterCard[], path: readonly LocatedChapter[], whose?: WhoseMoment): Record<string, Life> {
  type Noted = { chapter: string; index: number; moment: Pick<CharacterMoment, 'role' | 'stateAfter' | 'location' | 'lifecycle'>; mark?: LifeMark }
  const byCharacter = new Map<string, Noted[]>()
  for (const { chapter, memory } of memories) {
    const here = new Set<string>()
    for (const moment of memory.characters) {
      // Whose note it is goes by the chapter's story where the book can say (`Project.castResolver`); by the id and the name alone otherwise.
      const card = whose !== undefined
        ? characters.find(candidate => candidate.id === whose(moment, chapter.plan.id))
        : characters.find(candidate => candidate.id === moment.character) ?? characters.find(candidate => sameName(candidate.name, moment.name) || candidate.aliases?.some(alias => sameName(alias, moment.name)) === true)
      // One note per character and chapter: a digest that names somebody twice (by name and by an alias) says one thing.
      if (card === undefined || here.has(card.id)) continue
      here.add(card.id)
      byCharacter.set(card.id, [...(byCharacter.get(card.id) ?? []), { chapter: chapter.plan.id, index: chapter.index, moment }])
    }
  }
  // What the author wrote down themselves: on the digest's note of that chapter where there is one, a note of its own where there is none.
  const indexOf = new Map(path.map(chapter => [chapter.plan.id, chapter.index]))
  for (const card of characters) {
    for (const mark of card.lifeMarks ?? []) {
      const index = mark.chapter === undefined ? 0 : indexOf.get(mark.chapter)
      // A chapter that is not on this line — or was taken out of the book — says nothing here.
      if (index === undefined) continue
      const noted = byCharacter.get(card.id) ?? []
      const there = noted.find(item => item.index === index)
      if (there !== undefined) there.mark = mark
      else noted.push({ chapter: mark.chapter ?? '', index, moment: {}, mark })
      byCharacter.set(card.id, noted)
    }
  }
  const lives: Record<string, Life> = {}
  for (const [id, moments] of byCharacter) lives[id] = lifeOf(moments)
  return lives
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
/** Who a name in a chapter is: the card's id; or, for a proper name borne only by cards of other stories, those cards. */
export type WhoIs = (name: string, chapterId: string | undefined) => { id?: string; elsewhere?: CharacterCard[] }

/**
 * Whose card a digest's note on somebody is, in the chapter it was made of — or nobody's on file. What a digest
 * settled as it read the chapter stands (`CharacterMoment.by`); an older digest's id holds within the stories its card
 * is of, and beyond them the note goes by its name, as the chapter's own story has it. Every reading of a digest —
 * who is on a line, a life, who is a walk-on — asks this, so that they agree.
 */
export type WhoseMoment = (moment: Pick<CharacterMoment, 'character' | 'name' | 'by'>, chapterId: string) => string | undefined

/** How a narrator calls themself: a word that names whoever tells the story, a different person in each. */
const SELF_WORDS = new Set(['我', '吾', '俺', '咱', '余', '本人', '在下', '鄙人', '叙述者', '叙事者', 'i', 'me', 'myself', 'narrator', 'thenarrator'])
export function selfNamed(name: string): boolean {
  return SELF_WORDS.has(name.normalize('NFKC').replace(/[\s"'“”‘’「」『』（）()]+/gu, '').toLowerCase())
}

/** For each line, the line its story begins on: itself, or the one it parted from, and so on back; the main line for a line the book does not have. */
function storiesOf(outline: Outline): (line: string | undefined) => string {
  const found = new Map<string, string>()
  const walk = (id: string, guard: Set<string>): string => {
    if (id === MAIN_LINE) return MAIN_LINE
    const known = found.get(id)
    if (known !== undefined) return known
    const line = (outline.lines ?? []).find(candidate => candidate.id === id)
    if (line === undefined) return MAIN_LINE
    let root = id
    if (line.from !== undefined && !guard.has(id)) {
      guard.add(id)
      const parent = homeOf(outline, line.from)
      // Parted from a chapter of the main line, or of another line; a chapter that is gone leaves the line a story of its own.
      if (parent !== undefined) root = parent === null ? MAIN_LINE : walk(parent.id, guard)
    }
    found.set(id, root)
    return root
  }
  return line => walk(line ?? MAIN_LINE, new Set())
}

/** A volume, or a line beside the main one, as a version is about it: what it is called and says, and its chapters by id, in their order. */
function shelfOf(holder: Volume | PlotLine | undefined): Record<string, unknown> | undefined {
  return holder !== undefined ? { ...holder, chapters: holder.chapters.map(plan => plan.id) } : undefined
}

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

/**
 * What is wrong with the plot as a way through, where something is: a line that leaves after, or arrives at, one of
 * its own chapters; a line whose way leads back into itself. Undefined where every line can be read from its start
 * to its end with each of its chapters met once.
 */
function knotIn(outline: Outline): string | undefined {
  for (const line of outline.lines ?? []) {
    const own = new Set(line.chapters.map(chapter => chapter.id))
    if (line.from !== undefined && own.has(line.from)) return `the line "${line.title}" would leave after one of its own chapters — say first where it leaves (update-line from)`
    if (line.into !== undefined && own.has(line.into)) return `the line "${line.title}" would arrive at one of its own chapters — say first where it arrives (update-line into)`
    const path = linePath(outline, line)
    const there = (id: string | undefined): boolean => id === undefined || homeOf(outline, id) === undefined || path.some(entry => entry.plan.id === id)
    if (line.chapters.some(chapter => path.filter(entry => entry.plan.id === chapter.id).length !== 1) || !there(line.from) || !there(line.into)) {
      return `that would make the line "${line.title}" go round in a circle: it leaves after a chapter that comes after it`
    }
  }
  return undefined
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

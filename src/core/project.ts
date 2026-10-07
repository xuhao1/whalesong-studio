// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * One novel project on disk. The directory layout is the storage format:
 *
 *   novel.json                 manifest
 *   outline.json               volumes → chapters → beats, plus plot threads
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
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  CharacterLook,
  AudioScript, CastPresence, ChapterInfo, ChapterMemory, ChapterPlan, ChapterReview, ChapterStatus, CharacterCard,
  ComicBoard, IllustrationInfo, Outline, PlaySession, PlotThread, ProjectManifest, ProjectState, ProjectStats, Proposal,
  StyleProfile, Suggestion, VersionInfo, VoiceCast, Volume, WorldEntry,
} from '../shared/types'
import { countWords, hashText, newId, normalizeProse, proseOnly, sameName, slugify } from '../shared/text'
import { KeyedMutex } from './util/async'
import {
  containedPath, ensureDir, exists, listDir, mtimeOf, readJson, readText, relativePosix, removePath, writeAtomic, writeJson,
} from './util/fs'
import { parseFrontMatter, renderFrontMatter } from './util/frontmatter'

export const MANIFEST_FILE = 'novel.json'
const OUTLINE_FILE = 'outline.json'
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
  chapterWords?: number
}

/** A chapter plan with its position resolved. */
export interface LocatedChapter {
  plan: ChapterPlan
  volume: Volume
  /** 1-based reading order across the whole book. */
  index: number
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
  /** Paths this process wrote recently; their watch events are not external edits. */
  private readonly ownWrites = new Map<string, number>()
  private disposed = false

  private constructor(readonly root: string) {}

  // ───────────── lifecycle ─────────────

  /** Open an existing project. @returns undefined when `root` holds no manifest. */
  static async open(root: string): Promise<Project | undefined> {
    if (!(await exists(join(root, MANIFEST_FILE)))) return undefined
    const project = new Project(root)
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
      chapterWords: input.chapterWords ?? (language.startsWith('zh') ? 3000 : 2500),
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
    project.startWatching()
    return project
  }

  dispose(): void {
    this.disposed = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
    this.listeners.clear()
  }

  get revision(): number {
    return this.revisionValue
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
        const own = this.ownWrites.get(join(this.root, name))
        if (own !== undefined && Date.now() - own < 1500) return
        if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => {
          this.watchTimer = undefined
          if (!this.disposed) this.touch()
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
    const mtime = await mtimeOf(path)
    const hit = this.cache.get(path) as CachedDoc<T> | undefined
    if (hit !== undefined && hit.mtime === mtime) return hit.value
    const value = await load(mtime)
    this.cache.set(path, { mtime, value })
    return value
  }

  private async write(path: string, data: string | Uint8Array, notify = true): Promise<void> {
    this.ownWrites.set(path, Date.now())
    if (this.ownWrites.size > 500) {
      const cutoff = Date.now() - 5000
      for (const [key, at] of this.ownWrites) if (at < cutoff) this.ownWrites.delete(key)
    }
    await writeAtomic(path, data)
    this.cache.delete(path)
    if (notify) this.touch()
  }

  private async writeDoc(path: string, value: unknown, notify = true): Promise<void> {
    await this.write(path, `${JSON.stringify(value, null, 2)}\n`, notify)
  }

  private async remove(path: string): Promise<void> {
    this.ownWrites.set(path, Date.now())
    await removePath(path)
    this.cache.delete(path)
    this.touch()
  }

  /** Read a JSON document under `.novel/`. */
  async readState<T>(...parts: string[]): Promise<T | undefined> {
    const path = this.statePath(...parts)
    return await this.cached(path, async () => await readJson<T>(path))
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
      const current = (await readJson<T>(path)) ?? fallback
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
      const manifest = await readJson<ProjectManifest>(path)
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
      await this.writeDoc(path, next)
      return next
    })
  }

  // ───────────── bible: generic Markdown cards ─────────────

  private async cards<T extends { id: string; updatedAt?: string }>(dir: string, normalize: (data: Partial<T>, body: string, id: string) => T): Promise<T[]> {
    const base = this.path('bible', dir)
    const names = (await listDir(base)).filter(name => name.endsWith('.md'))
    const cards: T[] = []
    for (const name of names) {
      const path = join(base, name)
      const card = await this.cached(path, async (mtime) => {
        const text = (await readText(path)) ?? ''
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
    const taken = new Set((await listDir(this.path('bible', dir))).map(file => file.replace(/\.md$/, '')))
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
    return true
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
    return true
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
      const outline = await readJson<Outline>(path)
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

  /** Chapters in reading order with their volume and 1-based index. */
  async chapters(): Promise<LocatedChapter[]> {
    return locate(await this.outline())
  }

  /**
   * Resolve a chapter reference the way a human or a model writes it: an id
   * (`ch003`), a number (`3`, `第3章`, `chapter 3`), `last`/`latest`, or a title.
   */
  async findChapter(ref: string | number): Promise<LocatedChapter | undefined> {
    const all = await this.chapters()
    if (typeof ref === 'number') return all[ref - 1]
    const wanted = ref.trim()
    if (wanted.length === 0) return undefined
    const byId = all.find(chapter => chapter.plan.id === wanted)
    if (byId !== undefined) return byId
    if (/^(last|latest|最后|最新|最后一章|最新一章)$/i.test(wanted)) return all.at(-1)
    const number = /^(?:第\s*)?(\d+)\s*(?:章|回|节)?$/.exec(wanted) ?? /^(?:chapter|ch\.?)\s*(\d+)$/i.exec(wanted)
    if (number !== null) return all[Number(number[1]) - 1]
    return all.find(chapter => sameName(chapter.plan.title, wanted))
      ?? all.find(chapter => chapter.plan.title.includes(wanted))
  }

  private async nextChapterId(outline: Outline): Promise<string> {
    const files = await listDir(this.path('manuscript'))
    let max = 0
    const scan = (id: string): void => {
      const match = /^ch(\d+)$/.exec(id)
      if (match !== null) max = Math.max(max, Number(match[1]))
    }
    for (const volume of outline.volumes) for (const chapter of volume.chapters) scan(chapter.id)
    for (const file of files) scan(file.replace(/\.md$/, ''))
    return `ch${String(max + 1).padStart(3, '0')}`
  }

  /** Append (or insert) a chapter plan. @returns the created plan. */
  async addChapter(input: Partial<ChapterPlan> & { title: string }, where: { volume?: string; before?: string; after?: string } = {}): Promise<ChapterPlan> {
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
      for (const volume of draft.volumes) {
        const index = volume.chapters.findIndex(chapter => chapter.id === located.plan.id)
        if (index < 0) continue
        updated = mergeCard<ChapterPlan>(volume.chapters[index]!, { ...patch, id: located.plan.id })
        volume.chapters[index] = updated
      }
    })
    return updated
  }

  async moveChapter(ref: string, where: { volume?: string; before?: string; after?: string }): Promise<void> {
    const located = await this.findChapter(ref)
    if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
    await this.updateOutline((draft) => {
      for (const volume of draft.volumes) volume.chapters = volume.chapters.filter(chapter => chapter.id !== located.plan.id)
      insertChapter(draft, located.plan, { volume: where.volume ?? located.volume.id, ...where })
    })
  }

  /** Remove a chapter from the outline; its text is snapshotted, then deleted. */
  async removeChapter(ref: string): Promise<boolean> {
    const located = await this.findChapter(ref)
    if (located === undefined) return false
    const text = await this.chapterText(located.plan.id)
    if (text.length > 0) await this.snapshot(located.plan.id, 'before-delete')
    await this.updateOutline((draft) => {
      for (const volume of draft.volumes) volume.chapters = volume.chapters.filter(chapter => chapter.id !== located.plan.id)
    })
    await this.remove(this.path('manuscript', `${located.plan.id}.md`))
    return true
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
    return await this.cached(path, async () => normalizeProse((await readText(path)) ?? ''))
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

  /** Per-chapter facts for lists: length, status, whether memory is current. */
  async chapterInfos(): Promise<ChapterInfo[]> {
    const located = await this.chapters()
    const infos: ChapterInfo[] = []
    for (const { plan, volume, index } of located) {
      const path = this.chapterPath(plan.id)
      const text = await this.chapterText(plan.id)
      const memory = text.length > 0 ? await this.memory(plan.id) : undefined
      const review = text.length > 0 ? await this.review(plan.id) : undefined
      const mtime = text.length > 0 ? await mtimeOf(path) : 0
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
    this.ownWrites.set(path, Date.now())
    await writeAtomic(path, content)
    await this.pruneVersions(chapterId)
    return id
  }

  /** Whether an autosave should take a restore point: at most one `edit` snapshot per window. */
  async editSnapshotDue(chapterId: string, windowMs = 10 * 60_000): Promise<boolean> {
    const names = (await listDir(this.statePath('versions', chapterId))).filter(name => name.endsWith('__edit.md')).sort()
    const last = names.at(-1)
    if (last === undefined) return true
    const at = Date.parse(last.slice(0, last.indexOf('__')).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4'))
    return !Number.isFinite(at) || Date.now() - at > windowMs
  }

  private async pruneVersions(chapterId: string, keep = 40): Promise<void> {
    const dir = this.statePath('versions', chapterId)
    const names = (await listDir(dir)).filter(name => name.endsWith('.md'))
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await removePath(join(dir, name))
  }

  async versions(chapterId: string): Promise<VersionInfo[]> {
    const dir = this.statePath('versions', chapterId)
    const names = (await listDir(dir)).filter(name => name.endsWith('.md'))
    const versions: VersionInfo[] = []
    for (const name of names) {
      const id = name.slice(0, -3)
      const [stamp, reason] = id.split('__')
      const text = (await readText(join(dir, name))) ?? ''
      const iso = (stamp ?? '').replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4')
      versions.push({ id, chapterId, createdAt: iso, reason: reason ?? 'edit', words: countWords(text) })
    }
    return versions.reverse()
  }

  async versionText(chapterId: string, versionId: string): Promise<string | undefined> {
    if (!/^[\w.-]+$/.test(versionId)) return undefined
    return await readText(this.statePath('versions', chapterId, `${versionId}.md`))
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

  /** Memories of chapters in reading order (chapters without memory are skipped). */
  async memories(): Promise<{ chapter: LocatedChapter; memory: ChapterMemory }[]> {
    const out: { chapter: LocatedChapter; memory: ChapterMemory }[] = []
    for (const chapter of await this.chapters()) {
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
      return next.slice(-200)
    })
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
      const settled = current.filter(item => item.status !== 'pending').slice(-60)
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

  // ───────────── stage documents ─────────────

  async audioScript(chapterId: string): Promise<AudioScript | undefined> {
    return await this.readState<AudioScript>('audio', `${chapterId}.json`)
  }

  async saveAudioScript(script: AudioScript, notify = true): Promise<void> {
    await this.writeState(['audio', `${script.chapterId}.json`], script, notify)
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

  async playSessions(): Promise<PlaySession[]> {
    const names = (await listDir(this.statePath('play'))).filter(name => name.endsWith('.json'))
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

  /** Which chapters each character appears in, from chapter memories. */
  async presence(): Promise<CastPresence[]> {
    const memories = await this.memories()
    const characters = await this.characters()
    const digested = memories.map(entry => entry.chapter.plan.id)
    const byCharacter = new Map<string, string[]>()
    for (const { chapter, memory } of memories) {
      for (const moment of memory.characters) {
        const card = characters.find(candidate => candidate.id === moment.character) ?? characters.find(candidate => sameName(candidate.name, moment.name))
        if (card === undefined) continue
        const list = byCharacter.get(card.id) ?? []
        if (!list.includes(chapter.plan.id)) list.push(chapter.plan.id)
        byCharacter.set(card.id, list)
      }
    }
    return characters.map((card) => {
      const chapters = byCharacter.get(card.id) ?? []
      const last = chapters.at(-1)
      const absentFor = last === undefined ? digested.length : digested.length - 1 - digested.indexOf(last)
      return { character: card.id, chapters, absentFor }
    })
  }

  async state(): Promise<ProjectState> {
    const [manifest, outline, chapters, characters, world, styles, suggestions, proposals, presence, cover] = await Promise.all([
      this.manifest(), this.outline(), this.chapterInfos(), this.characters(), this.world(), this.styles(),
      this.suggestions(), this.proposals(), this.presence(), this.cover(),
    ])
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
      characters,
      world,
      styles,
      stats,
      suggestions,
      proposals: proposals.filter(proposal => proposal.status === 'pending'),
      presence,
      ...(cover !== undefined ? { cover } : {}),
    }
  }

  /** Whether an absolute path exists inside the project. */
  async has(relativePath: string): Promise<boolean> {
    try {
      await stat(this.path(relativePath))
      return true
    } catch {
      return false
    }
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
  return { schema: 1, volumes, threads: outline?.threads ?? [] }
}

function locate(outline: Outline): LocatedChapter[] {
  const out: LocatedChapter[] = []
  let index = 0
  for (const volume of outline.volumes) {
    for (const plan of volume.chapters) out.push({ plan, volume, index: ++index })
  }
  return out
}

function insertChapter(draft: Outline, plan: ChapterPlan, where: { volume?: string; before?: string; after?: string }): void {
  const anchor = where.before ?? where.after
  if (anchor !== undefined) {
    for (const volume of draft.volumes) {
      const at = volume.chapters.findIndex(chapter => chapter.id === anchor)
      if (at < 0) continue
      volume.chapters.splice(where.before !== undefined ? at : at + 1, 0, plan)
      return
    }
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

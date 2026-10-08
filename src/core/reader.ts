// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a reader is given, made in one place whoever asks: the Studio's own
 * viewer (over RPC), another device (over the small server in
 * `host/share.ts`), a published site (the same answers written to files).
 *
 *   bookAnswer    one request for something of a book -> its answer
 *   describeBook  a book as a shelf shows it
 *   listChapters  its chapters that can be read, with what each offers
 *   readChapter   one chapter: text, script, storyboard — nothing only the author needs
 *   readAlbum     its people and its world, as a collection of settings prints them
 *   listSides     the interludes kept as side stories; readSide, one of them as it is read
 *
 * Who may ask, and for which book, is the caller's to decide: this module
 * answers for a book that was already opened for whoever is asking.
 */
import type { NovelCore, ProjectRuntime } from './core'
import { playable } from './pipelines/audio'
import { playTurn, rewindPlay, startPlay } from './pipelines/play'
import { chapterVideo, chapterVideoWithSubtitles } from './pipelines/video'
import { albumCounts, albumEmpty, cutAlbum, type Album, type AlbumCounts, type AlbumEntry, type AlbumEvent, type AlbumPerson } from '../shared/album'
import type { ReaderLine } from '../shared/reader'
import { hashText, proseOnly, sameName } from '../shared/text'
import { castOrder, MAIN_LINE, WORLD_EVENT_KINDS, type AudioCue, type AudioLine, type ChapterInfo, type ComicPanel, type PlaySession, type TtsSettings } from '../shared/types'
import { groupOf, WORLD_GROUPS, worldOrder, worldWeight } from '../shared/world'

/** A request that is not answered: the status an HTTP server would give it, and a word for the reader's page to tell cases apart. */
export class ReaderRefused extends Error {
  constructor(readonly status: number, message: string, readonly code = 'refused') {
    super(message)
  }
}

/** One request for something of a book. */
export interface ReaderRequest {
  method: 'GET' | 'POST' | 'PUT'
  /** What is asked for, below the book: `[]` the book itself, `['chapters', id]`, `['album']`, `['sides', id?]`, `['cast']`, `['plays', …]`. */
  path: string[]
  body?: Record<string, unknown>
  /** Who is asking, for the book's own record of what was changed from where. */
  by: string
}

/** A chapter as the reader lists it. */
export interface SharedChapter {
  id: string
  index: number
  title: string
  words: number
  /** Lines of its audio script, and how many of them have a voice. */
  lines: number
  voiced: number
  /** Panels of its motion comic, and how many of them are drawn. */
  panels: number
  drawn: number
  /** It has a finished video: the cut post-production made of it. */
  video?: boolean
  /** The line of the plot it belongs to, when that is not the main one; `index` is then its place along that line. */
  line?: string
}

/** A line of the plot as a reader takes it (`shared/reader.ts`, where a page reads along it). */
export type SharedLine = ReaderLine

export interface SharedBook {
  id: string
  title: string
  author?: string
  language: string
  logline?: string
  cover?: string
  words: number
  chapters: number
  /** What a device may do with the book: read it, or also change it. */
  mode: 'read' | 'edit'
  /** The book is sealed and this device has not shown its password yet: only the name is known. */
  locked?: boolean
}


/** A chapter as it is read, heard and watched. */
export interface SharedChapterData {
  id: string
  index: number
  title: string
  text: string
  script?: { lines: AudioLine[]; cues: AudioCue[] }
  board?: { panels: Pick<ComicPanel, 'id' | 'lines' | 'begin' | 'end' | 'description' | 'camera' | 'image'>[] }
  /** Its finished video, when post-production cut one. */
  video?: SharedVideo
  /** The script was made from an earlier text. */
  stale: boolean
}

/**
 * A chapter's finished video as it is played: the file, its shape, and its
 * lines as a WebVTT file a web player can show (it shows nothing of a track
 * inside an MP4) — `burned` when the words are in the picture already, so
 * that they are not shown twice. `version` changes when the chapter is cut again.
 */
export interface SharedVideo {
  path: string
  duration: number
  width: number
  height: number
  subtitles?: string
  burned?: boolean
  version: string
}

export type SharedPlay = Pick<PlaySession, 'id' | 'title' | 'player' | 'cast' | 'situation' | 'location' | 'turns' | 'outcome' | 'updatedAt'>

const READ_ONLY = (): ReaderRefused => new ReaderRefused(403, 'this book is read-only from other devices', 'read-only')

/**
 * Answer one request about a book.
 * @param mode - what whoever asks may do with the book: read it, or also change its text and play its interludes.
 * @throws ReaderRefused when there is no such thing (404), it may not be done (403, 405), or the request makes no sense (400).
 */
export async function bookAnswer(core: NovelCore, runtime: ProjectRuntime, mode: 'read' | 'edit', request: ReaderRequest): Promise<unknown> {
  const { method, path: rest } = request
  const reading = method === 'GET'
  const body = request.body ?? {}
  const section = rest[0]
  // With the book: how much there is to look at besides the text, so that a page offers what it can show.
  if (rest.length === 0 && reading) {
    const album = albumCounts(await readAlbum(runtime))
    const sides = (await listSides(runtime)).length
    const chapters = await listChapters(runtime)
    // Where the book goes more than one way: the ways, and the chapters only the other ways have.
    const ways = await listLines(runtime, chapters)
    // Where the book was last read, on whichever device: picked up on the next one.
    const position = await readPosition(runtime)
    return { book: await describeBook(runtime, mode), chapters: [...chapters, ...(ways?.chapters ?? [])], ...(ways !== undefined ? { lines: ways.lines } : {}), ...(albumEmpty(album) ? {} : { album }), ...(sides > 0 ? { sides } : {}), ...(position !== undefined ? { position } : {}) }
  }
  // A reader's place is theirs to leave, whatever else they may do with the book: it changes nothing of it.
  if (section === 'position' && rest.length === 1 && method === 'POST') return { position: await savePosition(runtime, body.chapter, request.by) }
  if (section === 'album' && rest.length === 1 && reading) return await readAlbum(runtime)
  if (section === 'chapters' && rest.length === 2) {
    if (reading) {
      const chapter = await readChapter(runtime, rest[1]!, (await core.settings.get()).tts)
      if (chapter === undefined) throw new ReaderRefused(404, 'not found')
      return chapter
    }
    if (method === 'PUT') {
      if (mode !== 'edit') throw READ_ONLY()
      return await saveChapter(runtime, rest[1]!, body.text, request.by)
    }
  }
  if (section === 'cast' && rest.length === 1 && reading) {
    if (mode !== 'edit') throw READ_ONLY()
    return { cast: (await runtime.project.characters()).map(card => ({ id: card.id, name: card.name, role: card.role, ...(card.tagline !== undefined ? { tagline: card.tagline } : {}), ...(card.visual?.portrait !== undefined ? { portrait: card.visual.portrait } : {}) })) }
  }
  // Side stories — interludes the author kept — are finished text: a reader's to read, whoever they are.
  if (section === 'sides' && reading) {
    if (rest.length === 1) return { sides: await listSides(runtime) }
    const side = rest.length === 2 ? await readSide(runtime, rest[1]!) : undefined
    if (side === undefined) throw new ReaderRefused(404, 'not found')
    return { play: side }
  }
  if (section === 'plays') {
    // Interludes call the models set up on this computer: only a book the author made changeable has them.
    if (mode !== 'edit') throw READ_ONLY()
    const task = { origin: 'user' as const }
    if (rest.length === 1 && reading) {
      const sessions = await runtime.project.playSessions()
      return { plays: sessions.filter(session => session.outcome !== 'discarded').map(session => ({ id: session.id, title: session.title, updatedAt: session.updatedAt, turns: session.turns.length, ...(session.player !== undefined ? { player: session.player } : {}), ended: session.outcome !== undefined })) }
    }
    if (rest.length === 1 && method === 'POST') {
      const cast = Array.isArray(body.cast) ? body.cast.filter((item): item is string => typeof item === 'string').slice(0, 12) : []
      const text = (key: string): string | undefined => (typeof body[key] === 'string' && (body[key] as string).trim().length > 0 ? (body[key] as string).trim().slice(0, 4000) : undefined)
      const session = await startPlay(core, runtime, {
        situation: text('situation') ?? '',
        cast,
        ...(text('title') !== undefined ? { title: text('title')! } : {}),
        ...(text('player') !== undefined ? { player: text('player')! } : {}),
        ...(text('anchor') !== undefined ? { anchor: text('anchor')! } : {}),
        ...(text('location') !== undefined ? { location: text('location')! } : {}),
        ...(text('tone') !== undefined ? { tone: text('tone')! } : {}),
      }, task)
      return { play: sharedPlay(session) }
    }
    const playId = rest[1]
    if (playId === undefined || !/^[\w-]{1,80}$/.test(playId)) throw new ReaderRefused(404, 'not found')
    if (rest.length === 2 && reading) {
      const session = await runtime.project.playSession(playId)
      if (session === undefined) throw new ReaderRefused(404, 'not found')
      return { play: sharedPlay(session) }
    }
    if (rest.length === 3 && method === 'POST' && rest[2] === 'turns') {
      const kind = body.kind === 'do' || body.kind === 'choice' || body.kind === 'direct' ? body.kind : 'say'
      const result = await playTurn(core, runtime, { session: playId, kind, text: typeof body.text === 'string' ? body.text.slice(0, 4000) : '' }, task)
      return { play: sharedPlay(result.session) }
    }
    if (rest.length === 3 && method === 'POST' && rest[2] === 'rewind') return { play: sharedPlay(await rewindPlay(runtime, playId)) }
  }
  throw new ReaderRefused(reading ? 404 : 405, 'not found')
}

/** A book as a shelf shows it. */
export async function describeBook(runtime: ProjectRuntime, mode: 'read' | 'edit'): Promise<SharedBook> {
  const { project } = runtime
  const manifest = await project.manifest()
  const chapters = (await project.chapterInfos()).filter(chapter => chapter.hasText)
  const cover = await project.cover()
  return {
    id: manifest.id,
    title: manifest.title,
    ...(manifest.author !== undefined ? { author: manifest.author } : {}),
    language: manifest.language,
    ...(manifest.logline !== undefined ? { logline: manifest.logline } : {}),
    ...(cover !== undefined ? { cover } : {}),
    words: chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    chapters: chapters.length,
    mode,
  }
}

/** The chapters of a book that can be read, in reading order, with what each offers to hear and to watch. */
export async function listChapters(runtime: ProjectRuntime): Promise<SharedChapter[]> {
  const chapters: SharedChapter[] = []
  for (const chapter of await runtime.project.chapterInfos()) if (chapter.hasText) chapters.push(await listed(runtime, chapter))
  return chapters
}

/** A chapter as the reader lists it. */
async function listed(runtime: ProjectRuntime, chapter: ChapterInfo): Promise<SharedChapter> {
  const { project } = runtime
  const script = await project.audioScript(chapter.id)
  const board = await project.comicBoard(chapter.id)
  return {
    id: chapter.id,
    index: chapter.index,
    title: chapter.title,
    words: chapter.words,
    lines: script?.lines.length ?? 0,
    voiced: script?.lines.filter(line => line.audio !== undefined).length ?? 0,
    panels: board?.panels.length ?? 0,
    drawn: board?.panels.filter(panel => panel.image !== undefined).length ?? 0,
    ...(await chapterVideo(runtime, chapter.id) !== undefined ? { video: true } : {}),
  }
}

/**
 * The lines of the plot a reader may take, where the book goes more than one
 * way: the main line and every other that is not put aside and has a written
 * chapter of its own — with those chapters, which a list of the main line's
 * does not have.
 * @returns nothing for a book that is read one way only.
 */
export async function listLines(runtime: ProjectRuntime, main?: SharedChapter[]): Promise<{ lines: SharedLine[]; chapters: SharedChapter[] } | undefined> {
  const { project } = runtime
  const outline = await project.lines()
  if (outline.length === 0) return undefined
  const trunk = main ?? await listChapters(runtime)
  const lines: SharedLine[] = [{ id: MAIN_LINE, title: '', path: trunk.map(chapter => chapter.id), own: trunk.length }]
  const chapters: SharedChapter[] = []
  for (const line of outline) {
    // Put aside by the author: kept in the book, not offered to whoever reads it.
    if (line.shelved === true) continue
    const path = (await project.chapterInfos(line.id)).filter(chapter => chapter.hasText)
    const own = path.filter(chapter => chapter.line === line.id)
    if (own.length === 0) continue
    lines.push({
      id: line.id,
      title: line.title,
      ...(line.premise !== undefined && line.premise.length > 0 ? { premise: line.premise } : {}),
      ...(line.from !== undefined ? { from: line.from } : {}),
      ...(line.choice !== undefined && line.choice.length > 0 ? { choice: line.choice } : {}),
      path: path.map(chapter => chapter.id),
      own: own.length,
    })
    for (const chapter of own) chapters.push({ ...await listed(runtime, chapter), line: line.id })
  }
  return lines.length > 1 ? { lines, chapters } : undefined
}

/** Where a book was last read: the chapter, when, and on what. */
export interface ReadingPosition {
  chapter: string
  at: string
  /** The device, in a few words: "iPhone (192.168.1.7)", "the Studio". */
  by: string
}

const POSITION = 'reading.json'

/** Where the book was last read, on whichever device; nothing when nobody left a place, or the chapter is no longer there to read. */
export async function readPosition(runtime: ProjectRuntime): Promise<ReadingPosition | undefined> {
  const kept = await runtime.project.readState<Partial<ReadingPosition>>(POSITION).catch(() => undefined)
  if (kept === undefined || typeof kept.chapter !== 'string' || typeof kept.at !== 'string') return undefined
  const located = await runtime.project.findChapter(kept.chapter)
  if (located === undefined || located.plan.id !== kept.chapter || (await runtime.project.chapterText(kept.chapter)).trim().length === 0) return undefined
  return { chapter: kept.chapter, at: kept.at, by: typeof kept.by === 'string' ? kept.by : '' }
}

/**
 * Leave a place in the book: the chapter being read, for the next device to pick up.
 * Kept with the book's own state — sealed with it — and not a change of the book: nothing that watches it is told.
 * @throws ReaderRefused 404 when the chapter is none of the book's, or has nothing to read.
 */
export async function savePosition(runtime: ProjectRuntime, chapter: unknown, by: string): Promise<ReadingPosition> {
  const id = typeof chapter === 'string' && /^[\w-]{1,80}$/.test(chapter) ? chapter : undefined
  const located = id !== undefined ? await runtime.project.findChapter(id) : undefined
  if (id === undefined || located === undefined || located.plan.id !== id || (await runtime.project.chapterText(id)).trim().length === 0) throw new ReaderRefused(404, 'not found')
  const position: ReadingPosition = { chapter: id, at: new Date().toISOString(), by: by.slice(0, 80) }
  await runtime.project.writeState([POSITION], { schema: 1, ...position }, false)
  return position
}

/** A chapter for the reader: its text, its audio script and its storyboard, without anything only the author needs. */
export async function readChapter(runtime: ProjectRuntime, id: string, tts: Pick<TtsSettings, 'speechTags'>): Promise<SharedChapterData | undefined> {
  const { project } = runtime
  if (!/^[\w-]{1,80}$/.test(id)) return undefined
  const located = await project.findChapter(id)
  if (located === undefined || located.plan.id !== id) return undefined
  const text = await project.chapterText(id)
  if (text.trim().length === 0) return undefined
  const stored = await project.audioScript(id)
  // As it will play: lines left unspoken say so.
  const script = stored !== undefined ? playable(stored, tts) : undefined
  const board = await project.comicBoard(id)
  const video = await chapterVideoWithSubtitles(runtime, id)
  return {
    id,
    index: located.index,
    title: located.plan.title,
    text,
    ...(script !== undefined ? {
      script: {
        lines: script.lines.map(line => ({
          id: line.id,
          kind: line.kind,
          text: line.text,
          ...(line.speakerName !== undefined ? { speakerName: line.speakerName } : {}),
          ...(line.audio !== undefined ? { audio: line.audio } : {}),
          ...(line.duration !== undefined ? { duration: line.duration } : {}),
          ...(line.renderKey !== undefined ? { renderKey: line.renderKey } : {}),
          ...(line.skip === true ? { skip: true } : {}),
        })),
        // What is heard and what the reader is told of it; how it was asked for is the author's business.
        cues: script.cues.map(cue => ({
          at: cue.at,
          ambience: cue.ambience,
          ...(cue.id !== undefined ? { id: cue.id } : {}),
          ...(cue.kind !== undefined ? { kind: cue.kind } : {}),
          ...(cue.intensity !== undefined ? { intensity: cue.intensity } : {}),
          ...((cue.caption ?? cue.note) !== undefined ? { caption: (cue.caption ?? cue.note)! } : {}),
          ...(cue.audio !== undefined ? { audio: cue.audio } : {}),
          ...(cue.duration !== undefined ? { duration: cue.duration } : {}),
          ...(cue.renderKey !== undefined ? { renderKey: cue.renderKey } : {}),
        })),
      },
    } : {}),
    ...(board !== undefined && board.panels.length > 0 ? {
      board: {
        panels: board.panels.map(panel => ({
          id: panel.id,
          lines: panel.lines,
          description: panel.description,
          camera: panel.camera,
          ...(panel.begin !== undefined ? { begin: panel.begin } : {}),
          ...(panel.end !== undefined ? { end: panel.end } : {}),
          ...(panel.image !== undefined ? { image: panel.image } : {}),
        })),
      },
    } : {}),
    ...(video !== undefined ? {
      video: {
        path: video.path,
        duration: video.duration,
        width: video.width,
        height: video.height,
        ...(video.subtitles?.path !== undefined ? { subtitles: video.subtitles.path } : {}),
        ...(video.subtitles?.burned === true ? { burned: true } : {}),
        version: video.createdAt,
      },
    } : {}),
    stale: stored !== undefined && stored.textHash !== hashText(proseOnly(text)),
  }
}

/**
 * The people and the world of a book for whoever reads it (`shared/album.ts`).
 *
 * A reader is given who and what the text has come to: somebody with a card
 * and no chapter yet is the author's plan, and so is a place nothing was set
 * in. The author's own viewer asks for all of it.
 * @param options.all - also who and what the text has not come to yet, and the notes on the ties.
 * @param options.upTo - as the story stood at this chapter (its place in reading order): for a book published a part at a time.
 */
export async function readAlbum(runtime: ProjectRuntime, options: { all?: boolean; upTo?: number } = {}): Promise<Album> {
  const { project } = runtime
  const infos = await project.chapterInfos()
  const readable = infos.filter(chapter => chapter.hasText)
  const order = new Map(infos.map(chapter => [chapter.id, chapter.index]))
  const latest = readable.at(-1)?.index ?? 0
  const [cards, entries, told, seen, cast, allTies] = await Promise.all([project.characters(), project.world(), project.lives(), project.worldPresence(), project.presence(), project.ties()])
  const all = options.all === true
  const lives = told.lives
  const anyLife = Object.keys(lives).length > 0

  // Ties that have begun in what there is to read; one said to end later is told as holding.
  const ties = allTies
    .filter(tie => all || tie.since === undefined || (order.get(tie.since) ?? 0) <= latest)
    .map(tie => ({
      id: tie.id,
      kind: tie.kind,
      from: tie.from,
      to: tie.to,
      ...(tie.since !== undefined ? { since: tie.since } : {}),
      ...(tie.until !== undefined && (all || (order.get(tie.until) ?? Infinity) <= latest) ? { until: tie.until } : {}),
      ...(all && tie.note !== undefined ? { note: tie.note } : {}),
    }))
  const tied = new Set(ties.flatMap(tie => [tie.from, tie.to]).filter(end => end.type === 'world').map(end => end.id))

  const shownCards = castOrder(cards, cast, infos.map(chapter => chapter.id)).filter(card => all || !anyLife || lives[card.id] !== undefined)
  const here = new Set(shownCards.map(card => card.id))
  const people: AlbumPerson[] = shownCards.map((card) => {
    const looks = (card.visual?.looks ?? []).filter(look => look.sheet !== undefined).map(look => ({ name: look.name, ...(look.when !== undefined ? { when: look.when } : {}), sheet: look.sheet! }))
    const relationships = (card.relationships ?? []).flatMap((relation) => {
      const other = cards.find(candidate => candidate.id === relation.target) ?? cards.find(candidate => sameName(candidate.name, relation.target) || candidate.aliases?.some(alias => sameName(alias, relation.target)) === true)
      // Who somebody is to a person the text has not come to is the author's plan.
      if (other !== undefined && !here.has(other.id)) return []
      return [{ ...(other !== undefined ? { id: other.id } : {}), name: other?.name ?? relation.target, kind: relation.kind, ...(relation.note !== undefined ? { note: relation.note } : {}) }]
    })
    const text = (value: string | undefined): string | undefined => (value !== undefined && value.trim().length > 0 ? value.trim() : undefined)
    return {
      id: card.id,
      name: card.name,
      ...(card.aliases !== undefined && card.aliases.length > 0 ? { aliases: card.aliases } : {}),
      role: card.role,
      ...(text(card.tagline) !== undefined ? { tagline: text(card.tagline)! } : {}),
      ...(text(card.gender) !== undefined ? { gender: text(card.gender)! } : {}),
      ...(text(card.age) !== undefined ? { age: text(card.age)! } : {}),
      ...(text(card.appearance) !== undefined ? { appearance: text(card.appearance)! } : {}),
      ...(text(card.personality) !== undefined ? { personality: text(card.personality)! } : {}),
      ...(text(card.background) !== undefined ? { background: text(card.background)! } : {}),
      ...(text(card.abilities) !== undefined ? { abilities: text(card.abilities)! } : {}),
      ...(text(card.life) !== undefined ? { life: text(card.life)! } : {}),
      ...(card.visual?.portrait !== undefined ? { portrait: card.visual.portrait } : {}),
      ...(card.visual?.sheet !== undefined ? { sheet: card.visual.sheet } : {}),
      ...(looks.length > 0 ? { looks } : {}),
      ...(relationships.length > 0 ? { relationships } : {}),
    }
  })

  const named = new Map(seen.presence.map(item => [item.entry, item.chapters]))
  const shownEntries = entries.filter(entry => all || groupOf(entry.category) === 'ideas' || (named.get(entry.id)?.length ?? 0) > 0 || tied.has(entry.id))
  const known = new Set(shownEntries.map(entry => entry.id))
  const world: AlbumEntry[] = WORLD_GROUPS.flatMap(group => worldOrder(shownEntries.filter(entry => groupOf(entry.category) === group), seen.presence, seen.written).map((entry) => {
    const chapters = (named.get(entry.id) ?? []).map(id => order.get(id)).filter((index): index is number => index !== undefined).sort((left, right) => left - right)
    const related = (entry.related ?? []).filter(id => known.has(id))
    // Its course, by the chapters of the line: what happens in a chapter a reader does not have is the author's plan.
    const course = (entry.events ?? [])
      .map(event => ({ index: order.get(event.chapter), chapter: event.chapter, kind: event.kind, what: event.what }))
      .filter((event): event is AlbumEvent => event.index !== undefined && (all || event.index <= latest) && WORLD_EVENT_KINDS.includes(event.kind) && typeof event.what === 'string')
      .sort((left, right) => left.index - right.index)
    // Pins of what is shown, and well-formed: a mark of somebody the text has not come to says they will be there.
    const pins = Object.entries(entry.spots ?? {}).filter(([key, at]) => typeof at?.x === 'number' && typeof at.y === 'number' && (key.startsWith('character:') ? here.has(key.slice(10)) : key.startsWith('world:') && known.has(key.slice(6))))
    return {
      id: entry.id,
      name: entry.name,
      ...(entry.aliases !== undefined && entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
      category: entry.category,
      group,
      weight: worldWeight(entry, chapters.length, seen.written),
      ...(entry.summary !== undefined && entry.summary.trim().length > 0 ? { summary: entry.summary.trim() } : {}),
      ...(entry.body !== undefined && entry.body.trim().length > 0 ? { body: entry.body.trim() } : {}),
      ...(entry.visualImage !== undefined ? { image: entry.visualImage } : {}),
      ...(entry.visualImage !== undefined && pins.length > 0 ? { spots: Object.fromEntries(pins.map(([key, at]) => [key, { x: at.x, y: at.y }])) } : {}),
      chapters,
      ...(course.length > 0 ? { events: course } : {}),
      ...(related.length > 0 ? { related } : {}),
    }
  }))

  const album: Album = {
    people,
    world,
    ties: ties.filter(tie => (tie.from.type === 'character' ? here.has(tie.from.id) : known.has(tie.from.id)) && (tie.to.type === 'character' ? here.has(tie.to.id) : known.has(tie.to.id))),
    chapters: readable.map(chapter => ({ id: chapter.id, index: chapter.index, title: chapter.title })),
    lives: Object.fromEntries(Object.entries(lives).filter(([id]) => here.has(id))),
  }
  return options.upTo !== undefined ? cutAlbum(album, options.upTo) : album
}

/** The book's own files an album shows. */
export function albumMedia(album: Pick<Album, 'people' | 'world'>): string[] {
  const paths: string[] = []
  for (const person of album.people) {
    if (person.portrait !== undefined) paths.push(person.portrait)
    if (person.sheet !== undefined) paths.push(person.sheet)
    for (const look of person.looks ?? []) paths.push(look.sheet)
  }
  for (const entry of album.world) if (entry.image !== undefined) paths.push(entry.image)
  return paths
}

export type { Album, AlbumCounts }

/** Save a chapter's text from another device: by the same road as an edit in the Studio, and on the book's record. */
export async function saveChapter(runtime: ProjectRuntime, id: string, text: unknown, device: string): Promise<{ words: number; changed: boolean }> {
  const { project } = runtime
  if (typeof text !== 'string') throw new ReaderRefused(400, 'no text')
  const located = /^[\w-]{1,80}$/.test(id) ? await project.findChapter(id) : undefined
  if (located === undefined || located.plan.id !== id) throw new ReaderRefused(404, 'not found')
  const version = (await project.chapterText(id)).length > 0 ? await project.snapshot(id, 'edit-device') : undefined
  const saved = await project.saveChapterText(id, text, { snapshot: false })
  if (saved.changed) {
    const zh = (await project.manifest()).language.toLowerCase().startsWith('zh')
    await project.addActivity({
      by: 'device',
      tool: 'reader',
      chapter: id,
      ...(version !== undefined ? { version } : {}),
      summary: zh ? `在「${device}」上改了第 ${located.index} 章《${located.plan.title}》（现在 ${saved.words} 字）` : `Chapter ${located.index} "${located.plan.title}" was edited on ${device} (now ${saved.words} words)`,
    })
  }
  return saved
}

/** A side story as a list shows it. */
export interface SharedSide {
  id: string
  title: string
  turns: number
  situation?: string
}

/** The interludes the author kept as side stories, the earliest first: what of a book's interludes a reader is given. */
export async function listSides(runtime: ProjectRuntime): Promise<SharedSide[]> {
  const kept = (await runtime.project.playSessions()).filter(session => session.outcome === 'side-story' && session.turns.length > 0)
  return kept.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(session => ({
    id: session.id,
    title: session.title,
    turns: session.turns.length,
    ...(session.situation.trim().length > 0 ? { situation: session.situation.trim().slice(0, 160) } : {}),
  }))
}

/**
 * One side story as it is read: the situation and, turn by turn, what was
 * said and done. What the director tracked, who the author played and the
 * choices that were offered are of the playing, not of the reading.
 * @returns undefined when no interlude of that id was kept as a side story.
 */
export async function readSide(runtime: ProjectRuntime, id: string): Promise<Pick<PlaySession, 'id' | 'title' | 'situation' | 'location' | 'turns'> | undefined> {
  if (!/^[\w-]{1,80}$/.test(id)) return undefined
  const session = await runtime.project.playSession(id)
  if (session === undefined || session.outcome !== 'side-story') return undefined
  return {
    id: session.id,
    title: session.title,
    situation: session.situation,
    ...(session.location !== undefined ? { location: session.location } : {}),
    turns: session.turns.map(turn => ({
      id: turn.id,
      ...(turn.input !== undefined ? { input: turn.input } : {}),
      ...(turn.narration !== undefined ? { narration: turn.narration } : {}),
      lines: turn.lines.map(line => ({ speaker: line.speaker, text: line.text, ...(line.action !== undefined ? { action: line.action } : {}), ...(line.audio !== undefined ? { audio: line.audio } : {}) })),
      // What could have been chosen is not what happened.
      choices: [],
      ...(turn.scene !== undefined ? { scene: turn.scene } : {}),
      ...(turn.ended === true ? { ended: true } : {}),
      createdAt: turn.createdAt,
    })),
  }
}

/** The book's own files a side story shows and plays. */
export function sideMedia(side: Pick<PlaySession, 'turns'>): string[] {
  const paths: string[] = []
  for (const turn of side.turns) {
    if (turn.scene?.background !== undefined) paths.push(turn.scene.background)
    for (const line of turn.lines) if (line.audio !== undefined) paths.push(line.audio)
  }
  return paths
}

/** An interlude as the reader shows it. */
export function sharedPlay(session: PlaySession): SharedPlay {
  return {
    id: session.id,
    title: session.title,
    cast: session.cast,
    situation: session.situation,
    turns: session.turns,
    updatedAt: session.updatedAt,
    ...(session.player !== undefined ? { player: session.player } : {}),
    ...(session.location !== undefined ? { location: session.location } : {}),
    ...(session.outcome !== undefined ? { outcome: session.outcome } : {}),
  }
}

/** What to call the device a request comes from, for the author's eyes. */

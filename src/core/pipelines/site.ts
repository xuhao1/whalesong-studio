// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A book as a site of its own: a folder that any static host serves, with the
 * reader in it and everything the reader asks for written out as files.
 *
 * Nothing here is made for the site. The page is the reader other devices are
 * served; the data is what `core/reader.ts` answers them with, saved under
 * the names the reader looks for when it finds itself on a site
 * (`data/books.json`, `data/<book>/book.json`, `data/<book>/chapters/<id>.json`,
 * `data/<book>/album.json`, `data/<book>/album/<line>.json`, `data/<book>/sides.json`, `data/<book>/sides/<id>.json`);
 * the pictures and the sound are the book's own files, under the same
 * addresses (`media/<book>/assets/…`). So a published book looks and plays
 * exactly as it does on the author's phone — and nothing but what a reader is
 * given leaves the book.
 *
 * Two things are made for the way out, both smaller copies of what stays in
 * the book as it is. A voice lies there uncompressed, four times what a
 * listener needs; given a press (`media/press.ts`) the site carries it as AAC
 * instead. A picture lies there as the PNG the image model made, megabytes of
 * it; given a picture press the site carries it as a JPEG that looks the same.
 * What the reader is told — and what a chapter's prose says where it shows a
 * picture — names the smaller file.
 *
 * Published again, only what changed is written (and only sound and pictures
 * that changed are pressed), and what the last publication wrote and this one
 * does not is taken away. Files in the folder that this did not write are
 * never touched.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { blocksOf } from '../../shared/reader'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import type { PicturePress, SoundPress } from '../media/press'
import { ProjectError } from '../project'
import { albumCounts, albumEmpty, type AlbumCounts } from '../../shared/album'
import { albumMedia, describeBook, listChapters, listLines, listSides, readAlbum, readChapter, readSide, sideMedia, type SharedChapter, type SharedChapterData } from '../reader'
import { MAIN_LINE } from '../../shared/types'

export interface SiteParams {
  /** The folder to publish into; made when it is not there. */
  out: string
  /** Chapters to publish; all that have text when left out. */
  chapters?: string[]
  /** Leave the audio drama out: no script, no voices, no sound. */
  listen?: boolean
  /** Leave the motion comic out. */
  watch?: boolean
  /** Leave the finished videos out: they are by far the largest files a chapter has. */
  video?: boolean
  /** Leave the people and the world out: no album of settings. */
  album?: boolean
  /** Leave the side stories — interludes the author kept — out. */
  sides?: boolean
  /** Publish the main line only: none of the other ways the story goes. (A part of the book — `chapters` — is of the main line anyway.) */
  lines?: boolean
  /** The reader's script (`lib/reader.js`), which the Host knows where to find. */
  reader: Uint8Array
  /** Where the published page says it was made with, and by whom: a link under the contents. */
  credit?: { name: string; url: string }
  /** How the site opens for a visitor who has set nothing: the author's own reading settings (`siteDefaults`). */
  defaults?: SiteDefaults
  /** Uncompressed sound (WAV) goes out through this, smaller and sounding the same; as it lies in the book when left out. */
  press?: SoundPress
  /** Pictures kept without loss (PNG) go out through this, smaller and looking the same; as they lie in the book when left out. */
  pictures?: PicturePress
}

/** Reading settings a site opens with: of the page (`prefs`) and of the player (`options`); a visitor's own replace them. */
export interface SiteDefaults {
  prefs?: { size?: number; theme?: 'auto' | 'paper' | 'night'; serif?: boolean; notes?: boolean; follow?: boolean; names?: boolean; things?: boolean; moments?: boolean; pictures?: 'small' | 'medium' | 'large' | 'full' | 'screen' }
  options?: { rate?: number; voiceVolume?: number; ambienceVolume?: number; ambienceOn?: boolean; autoNext?: boolean }
}

/**
 * Reading settings as they may be written into a page: what is known, within
 * what the reader itself allows, and nothing else — they come from a browser's storage.
 */
export function siteDefaults(raw: unknown): SiteDefaults | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { prefs: page, options: player } = raw as { prefs?: Record<string, unknown>; options?: Record<string, unknown> }
  const within = (value: unknown, low: number, high: number): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : undefined)
  const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)
  const drop = <T extends object>(record: T): T => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
  const prefs = drop({
    size: within(page?.size, 14, 30),
    theme: page?.theme === 'auto' || page?.theme === 'paper' || page?.theme === 'night' ? page.theme : undefined,
    serif: flag(page?.serif),
    notes: flag(page?.notes),
    follow: flag(page?.follow),
    // What is marked and shown in the text, and how large its pictures stand.
    names: flag(page?.names),
    things: flag(page?.things),
    moments: flag(page?.moments),
    pictures: page?.pictures === 'small' || page?.pictures === 'medium' || page?.pictures === 'large' || page?.pictures === 'full' || page?.pictures === 'screen' ? page.pictures : undefined,
  })
  const options = drop({
    rate: within(player?.rate, 0.5, 2),
    voiceVolume: within(player?.voiceVolume, 0, 1),
    ambienceVolume: within(player?.ambienceVolume, 0, 1),
    ambienceOn: flag(player?.ambienceOn),
    autoNext: flag(player?.autoNext),
  })
  if (Object.keys(prefs).length + Object.keys(options).length === 0) return undefined
  return { ...(Object.keys(prefs).length > 0 ? { prefs } : {}), ...(Object.keys(options).length > 0 ? { options } : {}) } as SiteDefaults
}

/** The folder a book is published into: the one the author names, else one beside the book, called after it. */
export function siteFolder(root: string, title: string, out: string | undefined): string {
  const named = typeof out === 'string' ? out.trim() : ''
  if (named.length > 0) return isAbsolute(named) ? resolve(named) : resolve(dirname(root), named)
  return join(dirname(root), `${title.replace(/[\\/:*?"<>|]/g, '').trim() || 'novel'}-site`)
}

/**
 * The chapters a publication up to one chapter takes: those of the main line
 * that have text, as far as that chapter — a book published a part at a time.
 * @throws ProjectError `novel/not-found` when the chapter named is not one of them.
 */
export async function siteChaptersUpTo(runtime: ProjectRuntime, upto: string): Promise<string[]> {
  const written = (await runtime.project.chapterInfos()).filter(chapter => chapter.hasText)
  const ref = upto.trim()
  const last = written.find(chapter => chapter.id === ref) ?? (/^\d+$/.test(ref) ? written.find(chapter => chapter.index === Number(ref)) : undefined) ?? written.find(chapter => chapter.title === ref)
  if (last === undefined) throw new ProjectError('novel/not-found', `no written chapter of the main line matches "${upto}"`)
  return written.filter(chapter => chapter.index <= last.index).map(chapter => chapter.id)
}

export interface SiteResult {
  dir: string
  chapters: number
  /** The people and the things of the world the site shows, kind by kind; absent when it has no album. */
  album?: AlbumCounts
  /** Side stories the site has. */
  sides: number
  /** Chapters whose finished video the site carries; absent when it carries none. */
  videos?: number
  /** Lines of the plot beside the main one the site carries, and how many chapters of their own they have; absent when it carries none. */
  lines?: { lines: number; chapters: number }
  /** Files the site consists of, and their size together. */
  files: number
  bytes: number
  /** Files written this time: the rest were there already, unchanged. */
  written: number
  removed: number
  /** Pictures or sound the book names that are not on disk: left out, and said. */
  missing: string[]
  /**
   * Uncompressed sound that went out pressed: how many files, and their size in the book and in the site.
   * `failed` are files the press could not do, published as they are, with what it said of the first.
   * Absent when no press was given or the book has no such sound.
   */
  sound?: { files: number; from: number; to: number; failed: string[]; reason?: string }
  /**
   * Pictures that went out pressed, told the same way; `kept` counts those the press would not make smaller —
   * see-through somewhere, which the smaller format cannot say — and that went out as they are.
   * Absent when no picture press was given or the book has no such picture.
   */
  pictures?: { files: number; from: number; to: number; failed: string[]; reason?: string; kept?: number }
}

/** The record a publication leaves in its folder: what it wrote, by content. */
interface SiteRecord {
  schema: 1
  book: string
  publishedAt: string
  files: Record<string, string>
  /** Sound and pictures that were pressed: what each was pressed from and how, so that it is not pressed again while neither changes. */
  sources?: Record<string, string>
}

const RECORD = 'site.json'

/** The page: the reader's own shell, marked as a site so that the reader looks for files instead of asking a server. */
export function sitePage(title: string, language: string, credit?: { name: string; url: string }, defaults?: SiteDefaults): string {
  const escape = (text: string): string => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!))
  return `<!doctype html>
<html lang="${escape(language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="novel-site" content="static">
<meta name="novel-books" content="1">
${credit !== undefined ? `<meta name="novel-credit" content="${escape(credit.name)}|${escape(credit.url)}">\n` : ''}${defaults !== undefined ? `<meta name="novel-defaults" content="${escape(JSON.stringify(defaults))}">\n` : ''}<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#f6f1e7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16181d" media="(prefers-color-scheme: dark)">
<title>${escape(title)}</title>
<style>html,body{margin:0;height:100%;background:#f6f1e7}@media(prefers-color-scheme:dark){html,body{background:#16181d}}#app{height:100%}</style>
</head>
<body>
<div id="app"></div>
<noscript>${escape(title)}</noscript>
<script src="reader.js" defer></script>
</body>
</html>
`
}

/** The book's own files a chapter shows and plays. */
function mediaOf(chapter: SharedChapterData): string[] {
  const paths: string[] = []
  for (const block of blocksOf(chapter.text)) if (block.kind === 'image' && block.path.startsWith('assets/')) paths.push(block.path)
  for (const line of chapter.script?.lines ?? []) if (line.audio !== undefined) paths.push(line.audio)
  for (const cue of chapter.script?.cues ?? []) if (cue.audio !== undefined) paths.push(cue.audio)
  for (const panel of chapter.board?.panels ?? []) if (panel.image !== undefined) paths.push(panel.image)
  for (const figure of chapter.figures ?? []) paths.push(figure.path)
  if (chapter.video !== undefined) paths.push(chapter.video.path, ...(chapter.video.subtitles !== undefined ? [chapter.video.subtitles] : []))
  return paths
}

/** A line of prose that shows a picture, as `blocksOf` reads it: the file it names is its second part. */
const PICTURE_LINE = /^([ \t]*!\[[^\]\n]*\]\()([^)\s]+)(\)[ \t]*)$/gm

/**
 * The same data, where every address of a file that went out under another name is that name —
 * a field that is the address, and a line of prose that shows a picture by naming its file.
 */
function renamedIn<T>(data: T, renamed: ReadonlyMap<string, string>): T {
  if (typeof data === 'string') {
    const whole = renamed.get(data)
    if (whole !== undefined) return whole as T
    return (data.includes('](') ? data.replace(PICTURE_LINE, (line: string, open: string, path: string, close: string) => (renamed.has(path) ? `${open}${renamed.get(path)!}${close}` : line)) : data) as T
  }
  if (Array.isArray(data)) return data.map(item => renamedIn(item, renamed) as unknown) as T
  if (typeof data === 'object' && data !== null) return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, renamedIn(value as unknown, renamed)])) as T
  return data
}

/**
 * Publish a book as a static site.
 * @throws ProjectError `novel/empty` when no chapter has text; `novel/invalid` when the folder is inside the book's own.
 */
export async function publishSite(core: NovelCore, runtime: ProjectRuntime, params: SiteParams, task?: TaskContext): Promise<SiteResult> {
  const { project } = runtime
  const out = resolve(params.out)
  const root = resolve(project.root)
  // A site inside the book would be read back as part of it — and, in a sealed book, would lie there in the open.
  if (out === root || out.startsWith(root + sep)) throw new ProjectError('novel/invalid', 'publish into a folder outside the book\'s own')
  const settings = await core.settingsOf(runtime)
  const book = await describeBook(runtime, 'read')
  const wanted = params.chapters !== undefined && params.chapters.length > 0 ? new Set(params.chapters) : undefined
  const trunk = await listChapters(runtime)
  const listed = trunk.filter(chapter => wanted === undefined || wanted.has(chapter.id))
  if (listed.length === 0) throw new ProjectError('novel/empty', 'no chapter has text to publish')
  // The other ways the story goes, with the chapters only they have — for the whole book: a part of it is a part of the main line.
  const ways = params.lines !== false && wanted === undefined ? await listLines(runtime, trunk) : undefined

  let previous: SiteRecord | undefined
  try {
    const record = JSON.parse(await readFile(join(out, RECORD), 'utf8')) as SiteRecord
    if (record.schema === 1 && typeof record.files === 'object' && record.files !== null) previous = record
  } catch {
    // The first publication into this folder.
  }
  const files: Record<string, string> = {}
  const sources: Record<string, string> = {}
  const result: SiteResult = { dir: out, chapters: listed.length, sides: 0, files: 0, bytes: 0, written: 0, removed: 0, missing: [] }
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const put = async (path: string, data: Uint8Array | string): Promise<void> => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const hash = digest(bytes)
    files[path] = hash
    result.files += 1
    result.bytes += bytes.byteLength
    const target = join(out, ...path.split('/'))
    // Written before and still there, the same: left as it is.
    if (previous?.files[path] === hash && await stat(target).then(info => info.size === bytes.byteLength, () => false)) return
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    result.written += 1
  }
  // The names of folders and files are the book's own ids, unescaped: a host decodes an address before it looks for the file.
  const id = book.id
  const media = new Set<string>()
  if (book.cover !== undefined) media.add(book.cover)

  // What the reader will ask for is gathered first and written last: where a sound ends up decides the name it is asked for by.
  const answers: { path: string; data: unknown }[] = []
  const chapters: SharedChapter[] = []
  const count = listed.length + (ways?.chapters.length ?? 0)
  const total = count * 2 + 2
  let done = 0
  for (const ref of [...listed, ...(ways?.chapters ?? [])]) {
    task?.signal?.throwIfAborted()
    const full = await readChapter(runtime, ref.id, settings.tts)
    if (full === undefined) continue
    const { script, board, video, ...rest } = full
    const chapter: SharedChapterData = {
      ...rest,
      ...(params.listen !== false && script !== undefined ? { script } : {}),
      ...(params.watch !== false && board !== undefined ? { board } : {}),
      ...(params.video !== false && video !== undefined ? { video } : {}),
    }
    for (const path of mediaOf(chapter)) media.add(path)
    const { video: filmed, ...listed } = ref
    chapters.push({ ...listed, ...(params.listen === false ? { lines: 0, voiced: 0 } : {}), ...(params.watch === false ? { panels: 0, drawn: 0 } : {}), ...(filmed === true && chapter.video !== undefined ? { video: true } : {}) })
    if (chapter.video !== undefined) result.videos = (result.videos ?? 0) + 1
    answers.push({ path: `data/${id}/chapters/${ref.id}.json`, data: chapter })
    task?.job?.progress(++done, total, ref.title)
  }
  // The book is as long as its main line: what another way adds is counted with that way.
  const mainly = chapters.filter(chapter => chapter.line === undefined)
  const shown = { ...book, chapters: mainly.length, words: mainly.reduce((sum, chapter) => sum + chapter.words, 0) }
  // A way none of whose own chapters could be read is no way to offer.
  const kept = ways?.lines.filter(line => line.id === MAIN_LINE || chapters.some(chapter => chapter.line === line.id)) ?? []
  if (kept.length > 1) result.lines = { lines: kept.length - 1, chapters: chapters.length - mainly.length }
  // The people and the world, as the story stands in what is published: a book published a part at a time tells nothing of what comes after.
  const album = params.album !== false ? await readAlbum(runtime, wanted !== undefined ? { upTo: Math.max(...mainly.map(chapter => chapter.index)) } : {}) : undefined
  const counts = album !== undefined ? albumCounts(album) : undefined
  if (album !== undefined && !albumEmpty(counts)) {
    // Told by the chapters that are published, and no others.
    const published = new Set(chapters.map(chapter => chapter.id))
    answers.push({ path: `data/${id}/album.json`, data: { ...album, chapters: album.chapters.filter(chapter => published.has(chapter.id)) } })
    for (const path of albumMedia(album)) media.add(path)
    result.album = counts!
    // And along every other way through the story the site offers: who is met on it, what stands, what has happened.
    for (const line of kept) {
      if (line.id === MAIN_LINE) continue
      const along = await readAlbum(runtime, { line: line.id })
      answers.push({ path: `data/${id}/album/${line.id}.json`, data: { ...along, chapters: along.chapters.filter(chapter => published.has(chapter.id)) } })
      for (const path of albumMedia(along)) media.add(path)
    }
  }
  // Side stories, whole: they stand beside the book, so a part of the book published takes all of them or none.
  if (params.sides !== false) {
    const sides = await listSides(runtime)
    for (const ref of sides) {
      const side = await readSide(runtime, ref.id)
      if (side === undefined) continue
      for (const path of sideMedia(side)) media.add(path)
      answers.push({ path: `data/${id}/sides/${ref.id}.json`, data: { play: side } })
      result.sides += 1
    }
    if (result.sides > 0) answers.push({ path: `data/${id}/sides.json`, data: { sides } })
  }
  answers.push({ path: 'data/books.json', data: { books: [shown] } })
  answers.push({ path: `data/${id}/book.json`, data: { book: shown, chapters, ...(kept.length > 1 ? { lines: kept } : {}), ...(result.album !== undefined ? { album: result.album } : {}), ...(result.sides > 0 ? { sides: result.sides } : {}) } })

  // The book's own files, by the addresses the reader asks for them under — read through the book's key when it is sealed.
  const { press, pictures } = params
  const renamed = new Map<string, string>()
  const sound: NonNullable<SiteResult['sound']> = { files: 0, from: 0, to: 0, failed: [] }
  const shrunk: NonNullable<SiteResult['pictures']> = { files: 0, from: 0, to: 0, failed: [] }
  // What goes out smaller than it lies in the book: sound kept uncompressed, pictures kept without loss.
  const pressFor = (path: string): { press: SoundPress | PicturePress; tally: NonNullable<SiteResult['pictures']> } | undefined => (
    press !== undefined && /\.wav$/i.test(path) ? { press, tally: sound }
      : pictures !== undefined && /\.png$/i.test(path) ? { press: pictures, tally: shrunk }
        : undefined
  )
  const carry = async (path: string): Promise<void> => {
    // Under its own name, as it is in the book: the reader asks for it percent-encoded, and a host decodes that before it looks for the file.
    const bytes = path.split('/').some(part => part === '..' || part.length === 0) ? undefined : await project.readFile(path).catch(() => undefined)
    if (bytes === undefined) {
      result.missing.push(path)
      return
    }
    // Pressed, it goes out under the name of what it then is — unless the book keeps another file by that very name.
    const by = pressFor(path)
    const smaller = by !== undefined ? `${path.slice(0, path.lastIndexOf('.'))}.${by.press.ext}` : undefined
    if (by !== undefined && smaller !== undefined && !media.has(smaller)) {
      const place = `media/${id}/${smaller}`
      const source = `${digest(bytes)} ${by.press.key}`
      try {
        // Pressed from this very file the last time, and still there as it was written: not pressed again.
        const kept = previous?.sources?.[place] === source ? await readFile(join(out, ...place.split('/'))).catch(() => undefined) : undefined
        const pressed = kept !== undefined && digest(kept) === previous?.files[place] ? kept : await by.press.press(bytes, task?.signal)
        // What the press will not make smaller — a picture that is see-through somewhere — goes as it lies, and is counted.
        if (pressed === undefined) by.tally.kept = (by.tally.kept ?? 0) + 1
        // A sound of a few samples is no smaller in a file that has to say what it is: it goes as it lies too.
        else if (pressed.byteLength < bytes.byteLength) {
          await put(place, pressed)
          sources[place] = source
          renamed.set(path, smaller)
          by.tally.files += 1
          by.tally.from += bytes.byteLength
          by.tally.to += pressed.byteLength
          return
        }
      } catch (error) {
        task?.signal?.throwIfAborted()
        // One file the press cannot do does not stop a book from going out: it is published as it is, and said.
        by.tally.failed.push(path)
        by.tally.reason ??= error instanceof Error ? error.message : String(error)
      }
    }
    await put(`media/${id}/${path}`, bytes)
  }
  const paths = [...media].sort()
  let next = 0
  let carried = 0
  const lane = async (): Promise<void> => {
    while (next < paths.length) {
      task?.signal?.throwIfAborted()
      await carry(paths[next++]!)
      carried += 1
      if (carried % 8 === 0 || carried === paths.length) task?.job?.progress(count + Math.round((carried / paths.length) * count), total, `${carried} / ${paths.length}`)
    }
  }
  // Pressing is the work of another program, several at once; plain copying goes one file after another.
  const lanes = press !== undefined || pictures !== undefined ? Math.max(1, Math.min(8, availableParallelism(), paths.length)) : 1
  const ends = await Promise.allSettled(Array.from({ length: lanes }, lane))
  const broken = ends.find((end): end is PromiseRejectedResult => end.status === 'rejected')
  if (broken !== undefined) throw broken.reason
  result.missing.sort()
  sound.failed.sort()
  shrunk.failed.sort()
  if (sound.files > 0 || sound.failed.length > 0) result.sound = sound
  if (shrunk.files > 0 || shrunk.failed.length > 0 || (shrunk.kept ?? 0) > 0) result.pictures = shrunk

  for (const answer of answers) await put(answer.path, JSON.stringify(renamed.size > 0 ? renamedIn(answer.data, renamed) : answer.data))
  await put('reader.js', params.reader)
  await put('index.html', sitePage(book.title, book.language, params.credit, params.defaults))

  // What the last publication wrote and this one does not: taken away. Nothing else in the folder is touched.
  for (const path of Object.keys(previous?.files ?? {})) {
    if (files[path] !== undefined || path.includes('..')) continue
    await rm(join(out, ...path.split('/')), { force: true })
    result.removed += 1
  }
  const record: SiteRecord = { schema: 1, book: book.id, publishedAt: new Date().toISOString(), files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))), ...(Object.keys(sources).length > 0 ? { sources } : {}) }
  await writeFile(join(out, RECORD), JSON.stringify(record, null, 1))
  task?.job?.progress(total, total)
  return result
}

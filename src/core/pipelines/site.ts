// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A book as a site of its own: a folder that any static host serves, with the
 * reader in it and everything the reader asks for written out as files.
 *
 * Nothing here is made for the site. The page is the reader other devices are
 * served; the data is what `core/reader.ts` answers them with, saved under
 * the names the reader looks for when it finds itself on a site
 * (`data/books.json`, `data/<book>/book.json`, `data/<book>/chapters/<id>.json`,
 * `data/<book>/album.json`, `data/<book>/sides.json`, `data/<book>/sides/<id>.json`);
 * the pictures and the sound are the book's own files, under the same
 * addresses (`media/<book>/assets/…`). So a published book looks and plays
 * exactly as it does on the author's phone — and nothing but what a reader is
 * given leaves the book.
 *
 * Published again, only what changed is written, and what the last
 * publication wrote and this one does not is taken away. Files in the folder
 * that this did not write are never touched.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { blocksOf } from '../../shared/reader'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { ProjectError } from '../project'
import { albumCounts, albumEmpty, type AlbumCounts } from '../../shared/album'
import { albumMedia, describeBook, listChapters, listSides, readAlbum, readChapter, readSide, sideMedia, type SharedChapter, type SharedChapterData } from '../reader'

export interface SiteParams {
  /** The folder to publish into; made when it is not there. */
  out: string
  /** Chapters to publish; all that have text when left out. */
  chapters?: string[]
  /** Leave the audio drama out: no script, no voices, no sound. */
  listen?: boolean
  /** Leave the motion comic out. */
  watch?: boolean
  /** Leave the people and the world out: no album of settings. */
  album?: boolean
  /** Leave the side stories — interludes the author kept — out. */
  sides?: boolean
  /** The reader's script (`lib/reader.js`), which the Host knows where to find. */
  reader: Uint8Array
  /** Where the published page says it was made with, and by whom: a link under the contents. */
  credit?: { name: string; url: string }
  /** How the site opens for a visitor who has set nothing: the author's own reading settings (`siteDefaults`). */
  defaults?: SiteDefaults
}

/** Reading settings a site opens with: of the page (`prefs`) and of the player (`options`); a visitor's own replace them. */
export interface SiteDefaults {
  prefs?: { size?: number; theme?: 'auto' | 'paper' | 'night'; serif?: boolean; notes?: boolean; follow?: boolean }
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
  /** Files the site consists of, and their size together. */
  files: number
  bytes: number
  /** Files written this time: the rest were there already, unchanged. */
  written: number
  removed: number
  /** Pictures or sound the book names that are not on disk: left out, and said. */
  missing: string[]
}

/** The record a publication leaves in its folder: what it wrote, by content. */
interface SiteRecord {
  schema: 1
  book: string
  publishedAt: string
  files: Record<string, string>
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
  return paths
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
  const settings = await core.settings.get()
  const book = await describeBook(runtime, 'read')
  const wanted = params.chapters !== undefined && params.chapters.length > 0 ? new Set(params.chapters) : undefined
  const listed = (await listChapters(runtime)).filter(chapter => wanted === undefined || wanted.has(chapter.id))
  if (listed.length === 0) throw new ProjectError('novel/empty', 'no chapter has text to publish')

  let previous: SiteRecord | undefined
  try {
    const record = JSON.parse(await readFile(join(out, RECORD), 'utf8')) as SiteRecord
    if (record.schema === 1 && typeof record.files === 'object' && record.files !== null) previous = record
  } catch {
    // The first publication into this folder.
  }
  const files: Record<string, string> = {}
  const result: SiteResult = { dir: out, chapters: listed.length, sides: 0, files: 0, bytes: 0, written: 0, removed: 0, missing: [] }
  const put = async (path: string, data: Uint8Array | string): Promise<void> => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
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

  const chapters: SharedChapter[] = []
  const total = listed.length * 2 + 2
  let done = 0
  for (const ref of listed) {
    task?.signal?.throwIfAborted()
    const full = await readChapter(runtime, ref.id, settings.tts)
    if (full === undefined) continue
    const { script, board, ...rest } = full
    const chapter: SharedChapterData = {
      ...rest,
      ...(params.listen !== false && script !== undefined ? { script } : {}),
      ...(params.watch !== false && board !== undefined ? { board } : {}),
    }
    for (const path of mediaOf(chapter)) media.add(path)
    chapters.push({ ...ref, ...(params.listen === false ? { lines: 0, voiced: 0 } : {}), ...(params.watch === false ? { panels: 0, drawn: 0 } : {}) })
    await put(`data/${id}/chapters/${ref.id}.json`, JSON.stringify(chapter))
    task?.job?.progress(++done, total, ref.title)
  }
  const shown = { ...book, chapters: chapters.length, words: chapters.reduce((sum, chapter) => sum + chapter.words, 0) }
  // The people and the world, as the story stands in what is published: a book published a part at a time tells nothing of what comes after.
  const album = params.album !== false ? await readAlbum(runtime, wanted !== undefined ? { upTo: Math.max(...chapters.map(chapter => chapter.index)) } : {}) : undefined
  const counts = album !== undefined ? albumCounts(album) : undefined
  if (album !== undefined && !albumEmpty(counts)) {
    // Told by the chapters that are published, and no others.
    const published = new Set(chapters.map(chapter => chapter.id))
    await put(`data/${id}/album.json`, JSON.stringify({ ...album, chapters: album.chapters.filter(chapter => published.has(chapter.id)) }))
    for (const path of albumMedia(album)) media.add(path)
    result.album = counts!
  }
  // Side stories, whole: they stand beside the book, so a part of the book published takes all of them or none.
  if (params.sides !== false) {
    const sides = await listSides(runtime)
    for (const ref of sides) {
      const side = await readSide(runtime, ref.id)
      if (side === undefined) continue
      for (const path of sideMedia(side)) media.add(path)
      await put(`data/${id}/sides/${ref.id}.json`, JSON.stringify({ play: side }))
      result.sides += 1
    }
    if (result.sides > 0) await put(`data/${id}/sides.json`, JSON.stringify({ sides }))
  }
  await put('data/books.json', JSON.stringify({ books: [shown] }))
  await put(`data/${id}/book.json`, JSON.stringify({ book: shown, chapters, ...(result.album !== undefined ? { album: result.album } : {}), ...(result.sides > 0 ? { sides: result.sides } : {}) }))

  // The book's own files, by the addresses the reader asks for them under — read through the book's key when it is sealed.
  const paths = [...media].sort()
  for (const [index, path] of paths.entries()) {
    task?.signal?.throwIfAborted()
    // Under its own name, as it is in the book: the reader asks for it percent-encoded, and a host decodes that before it looks for the file.
    const bytes = path.split('/').some(part => part === '..' || part.length === 0) ? undefined : await project.readFile(path).catch(() => undefined)
    if (bytes === undefined) result.missing.push(path)
    else await put(`media/${id}/${path}`, bytes)
    if (index % 8 === 0) task?.job?.progress(listed.length + Math.round(((index + 1) / paths.length) * listed.length), total)
  }
  await put('reader.js', params.reader)
  await put('index.html', sitePage(book.title, book.language, params.credit, params.defaults))

  // What the last publication wrote and this one does not: taken away. Nothing else in the folder is touched.
  for (const path of Object.keys(previous?.files ?? {})) {
    if (files[path] !== undefined || path.includes('..')) continue
    await rm(join(out, ...path.split('/')), { force: true })
    result.removed += 1
  }
  const record: SiteRecord = { schema: 1, book: book.id, publishedAt: new Date().toISOString(), files }
  await writeFile(join(out, RECORD), JSON.stringify(record, null, 1))
  task?.job?.progress(total, total)
  return result
}

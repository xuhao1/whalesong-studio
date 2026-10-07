// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Export: compile the manuscript into one deliverable — Markdown, plain text,
 * a self-contained HTML book, or an EPUB. Files land in `export/` inside the
 * project.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { ProjectManifest } from '../../shared/types'
import { embeddedImages, proseOnly } from '../../shared/text'
import type { ProjectRuntime } from '../core'
import type { LocatedChapter, Project } from '../project'
import { ProjectError } from '../project'
import { writeAtomic } from '../util/fs'

export type ExportFormat = 'markdown' | 'text' | 'html' | 'epub'

export interface ExportResult {
  format: ExportFormat
  /** Project-relative path of the file written. */
  path: string
  chapters: number
  bytes: number
}

interface CompiledChapter {
  chapter: LocatedChapter
  text: string
  newVolume: boolean
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

async function compile(project: Project, refs: string[] | undefined): Promise<CompiledChapter[]> {
  const all = await project.chapters()
  let wanted = all
  if (refs !== undefined && refs.length > 0) {
    const ids = new Set<string>()
    for (const ref of refs) {
      const chapter = await project.findChapter(ref)
      if (chapter !== undefined) ids.add(chapter.plan.id)
    }
    wanted = all.filter(chapter => ids.has(chapter.plan.id))
  }
  const out: CompiledChapter[] = []
  let volume: string | undefined
  for (const chapter of wanted) {
    const text = await project.chapterText(chapter.plan.id)
    if (text.length === 0) continue
    out.push({ chapter, text, newVolume: chapter.volume.id !== volume })
    volume = chapter.volume.id
  }
  return out
}

function chapterHeading(chapter: LocatedChapter, zh: boolean): string {
  const title = chapter.plan.title
  // Titles imported with their own numbering ("第三章 夜雨") are kept as they are.
  if (/^(第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章回节]|chapter\s+\d+|序|楔子|尾声|prologue|epilogue)/i.test(title)) return title
  return zh ? `第${chapter.index}章 ${title}` : `Chapter ${chapter.index}: ${title}`
}

/** Paragraphs of a chapter as HTML; embedded illustrations become figures via `image`. */
async function chapterHtml(text: string, image: (path: string, alt: string) => Promise<string | undefined>): Promise<string> {
  const parts: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(trimmed)
    if (match !== null) {
      const src = await image(match[2] ?? '', match[1] ?? '')
      if (src !== undefined) parts.push(`<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(match[1] ?? '')}"/></figure>`)
      continue
    }
    if (/^(\*\s*){3,}$|^-{3,}$|^—{2,}$/.test(trimmed)) {
      parts.push('<hr/>')
      continue
    }
    parts.push(`<p>${escapeHtml(trimmed)}</p>`)
  }
  return parts.join('\n')
}

const BOOK_CSS = `
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 42em; padding: 3em 1.4em 6em; font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif; font-size: 1.08rem; line-height: 1.9; }
h1 { text-align: center; margin: 2em 0 0.4em; font-size: 2rem; }
.author { text-align: center; opacity: 0.7; margin-bottom: 4em; }
h2.volume { text-align: center; margin: 5em 0 2em; font-size: 1.5rem; letter-spacing: 0.2em; }
h3 { margin: 3.5em 0 1.5em; font-size: 1.25rem; text-align: center; }
p { margin: 0; text-indent: 2em; text-align: justify; }
figure { margin: 1.6em 0; text-align: center; }
figure img { max-width: 100%; border-radius: 6px; }
hr { border: 0; text-align: center; margin: 1.6em 0; }
hr::before { content: "* * *"; letter-spacing: 0.6em; opacity: 0.6; }
nav ol { list-style: none; padding: 0; }
nav a { text-decoration: none; color: inherit; opacity: 0.8; }
`

export async function exportBook(runtime: ProjectRuntime, params: { format?: ExportFormat; chapters?: string[] }): Promise<ExportResult> {
  const { project } = runtime
  const format = params.format ?? 'markdown'
  const manifest = await project.manifest()
  const zh = manifest.language.toLowerCase().startsWith('zh')
  const compiled = await compile(project, params.chapters)
  if (compiled.length === 0) throw new ProjectError('novel/empty', 'no chapter has text to export')
  const safeTitle = manifest.title.replace(/[\\/:*?"<>|]/g, '').trim() || 'novel'
  let data: Uint8Array
  let extension: string

  if (format === 'markdown') {
    const lines: string[] = [`# ${manifest.title}`, '']
    if (manifest.author !== undefined) lines.push(`*${manifest.author}*`, '')
    for (const { chapter, text, newVolume } of compiled) {
      if (newVolume) lines.push(`## ${chapter.volume.title}`, '')
      // Image paths are rewritten relative to the export directory.
      lines.push(`### ${chapterHeading(chapter, zh)}`, '', text.replace(/^(!\[[^\]]*\]\()(?!https?:|\/)([^)]*\))$/gm, '$1../$2').split('\n').filter(line => line.trim().length > 0).join('\n\n'), '')
    }
    data = Buffer.from(lines.join('\n'), 'utf8')
    extension = 'md'
  } else if (format === 'text') {
    const lines: string[] = [manifest.title, '']
    if (manifest.author !== undefined) lines.push(manifest.author, '')
    for (const { chapter, text, newVolume } of compiled) {
      if (newVolume) lines.push('', chapter.volume.title, '')
      lines.push('', chapterHeading(chapter, zh), '', ...proseOnly(text).split('\n').filter(line => line.trim().length > 0).map(line => `${zh ? '　　' : ''}${line.trim()}`))
    }
    data = Buffer.from(lines.join('\n'), 'utf8')
    extension = 'txt'
  } else if (format === 'html') {
    const inline = async (path: string): Promise<string | undefined> => {
      try {
        const bytes = await readFile(project.path(path))
        return `data:${MIME[extname(path).toLowerCase()] ?? 'image/png'};base64,${bytes.toString('base64')}`
      } catch {
        return undefined
      }
    }
    const body: string[] = [`<h1>${escapeHtml(manifest.title)}</h1>`]
    if (manifest.author !== undefined) body.push(`<div class="author">${escapeHtml(manifest.author)}</div>`)
    body.push(`<nav><ol>${compiled.map(({ chapter }) => `<li><a href="#${chapter.plan.id}">${escapeHtml(chapterHeading(chapter, zh))}</a></li>`).join('')}</ol></nav>`)
    for (const { chapter, text, newVolume } of compiled) {
      if (newVolume) body.push(`<h2 class="volume">${escapeHtml(chapter.volume.title)}</h2>`)
      body.push(`<h3 id="${chapter.plan.id}">${escapeHtml(chapterHeading(chapter, zh))}</h3>`, await chapterHtml(text, inline))
    }
    data = Buffer.from(`<!doctype html>\n<html lang="${escapeHtml(manifest.language)}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${escapeHtml(manifest.title)}</title><style>${BOOK_CSS}</style></head><body>\n${body.join('\n')}\n</body></html>\n`, 'utf8')
    extension = 'html'
  } else {
    data = await buildEpub(project, manifest, compiled, zh)
    extension = 'epub'
  }
  const path = project.path('export', `${safeTitle}.${extension}`)
  await writeAtomic(path, data)
  return { format, path: project.relative(path), chapters: compiled.length, bytes: data.byteLength }
}

// ───────────────────────────── EPUB ─────────────────────────────

async function buildEpub(project: Project, manifest: ProjectManifest, compiled: CompiledChapter[], zh: boolean): Promise<Uint8Array> {
  const files: { name: string; data: Uint8Array }[] = []
  const add = (name: string, content: string | Uint8Array): void => { files.push({ name, data: typeof content === 'string' ? Buffer.from(content, 'utf8') : content }) }
  // The mimetype entry must come first and stay uncompressed; this writer stores every entry.
  add('mimetype', 'application/epub+zip')
  add('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  add('OEBPS/book.css', BOOK_CSS)
  const images = new Map<string, { name: string; mime: string }>()
  const image = async (path: string): Promise<string | undefined> => {
    const known = images.get(path)
    if (known !== undefined) return `images/${known.name}`
    try {
      const bytes = await readFile(project.path(path))
      const extension = extname(path).toLowerCase()
      const name = `img${images.size + 1}${extension || '.png'}`
      images.set(path, { name, mime: MIME[extension] ?? 'image/png' })
      add(`OEBPS/images/${name}`, bytes)
      return `images/${name}`
    } catch {
      return undefined
    }
  }
  const page = (title: string, body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeHtml(manifest.language)}"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title><link rel="stylesheet" type="text/css" href="book.css"/></head><body>\n${body}\n</body></html>`
  add('OEBPS/title.xhtml', page(manifest.title, `<h1>${escapeHtml(manifest.title)}</h1>${manifest.author !== undefined ? `<div class="author">${escapeHtml(manifest.author)}</div>` : ''}`))
  const items: { id: string; file: string; title: string }[] = []
  for (const { chapter, text, newVolume } of compiled) {
    const heading = chapterHeading(chapter, zh)
    const body = `${newVolume ? `<h2 class="volume">${escapeHtml(chapter.volume.title)}</h2>\n` : ''}<h3>${escapeHtml(heading)}</h3>\n${await chapterHtml(text, image)}`
    const file = `${chapter.plan.id}.xhtml`
    add(`OEBPS/${file}`, page(heading, body))
    items.push({ id: chapter.plan.id, file, title: heading })
  }
  add('OEBPS/nav.xhtml', page(zh ? '目录' : 'Contents', `<nav epub:type="toc"><h2>${zh ? '目录' : 'Contents'}</h2><ol>${items.map(item => `<li><a href="${item.file}">${escapeHtml(item.title)}</a></li>`).join('')}</ol></nav>`))
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  add('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:novel:${escapeHtml(manifest.id)}</dc:identifier>
<dc:title>${escapeHtml(manifest.title)}</dc:title>
<dc:language>${escapeHtml(manifest.language)}</dc:language>
${manifest.author !== undefined ? `<dc:creator>${escapeHtml(manifest.author)}</dc:creator>` : ''}
<meta property="dcterms:modified">${stamp}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="book.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${items.map(item => `<item id="${item.id}" href="${item.file}" media-type="application/xhtml+xml"/>`).join('\n')}
${[...images.values()].map((entry, index) => `<item id="image${index + 1}" href="images/${entry.name}" media-type="${entry.mime}"/>`).join('\n')}
</manifest>
<spine>
<itemref idref="title"/>
<itemref idref="nav"/>
${items.map(item => `<itemref idref="${item.id}"/>`).join('\n')}
</spine>
</package>`)
  return zipStore(files)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A ZIP archive with every entry stored uncompressed — all an EPUB container needs. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength))
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(file.data.length, 20)
    entry.writeUInt32LE(file.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += 30 + name.length + file.data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}

/** Illustrations referenced by a chapter that are missing on disk (shown as a warning in the editor). */
export async function missingImages(project: Project, text: string): Promise<string[]> {
  const missing: string[] = []
  for (const image of embeddedImages(text)) {
    if (/^https?:/.test(image.path)) continue
    if (!(await project.has(image.path))) missing.push(image.path)
  }
  return missing
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Reading a book out of the files novels usually travel in, without any
 * dependency: plain text and Markdown (UTF-8, UTF-16, GB18030), EPUB and Word
 * `.docx`. The result is plain text with headings on their own lines — the
 * form the import pipeline cuts into chapters.
 */
import { inflateRawSync } from 'node:zlib'

export interface BookFile {
  text: string
  /** Title and author when the file states them (EPUB metadata). */
  title?: string
  author?: string
}

/** Decode a text file: UTF-8 (with or without BOM), UTF-16 with BOM, else GB18030 — the usual suspects for novels. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}

// ───────────────────────────── zip ─────────────────────────────

/** Entries of a ZIP archive by name. Stored and deflated entries are read; anything else is skipped. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-central-directory record sits at the very end, before an optional comment.
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65_535); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('not a ZIP archive')
  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)
  const names = new TextDecoder('utf-8')
  const files = new Map<string, Uint8Array>()
  for (let index = 0; index < count && cursor + 46 <= bytes.length; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break
    const method = view.getUint16(cursor + 10, true)
    const compressed = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const local = view.getUint32(cursor + 42, true)
    const name = names.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/') || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) continue
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + compressed)
    try {
      if (method === 0) files.set(name, data)
      else if (method === 8) files.set(name, new Uint8Array(inflateRawSync(data)))
    } catch {
      // a damaged entry is skipped; the rest of the book is still worth reading
    }
  }
  return files
}

// ───────────────────────────── markup to text ─────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: '　', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', copy: '©',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, code: string) => {
    if (code.startsWith('#')) {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** XHTML to plain text: headings become `# ` lines, block elements become paragraphs, everything else is dropped. */
export function htmlToText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|head|nav)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_whole, inner: string) => {
      const title = inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      return title.length > 0 ? `\n\n# ${title}\n\n` : '\n\n'
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|blockquote|h[4-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text).replace(/[ \t ]+\n/g, '\n').replace(/\n[ \t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ───────────────────────────── EPUB ─────────────────────────────

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match !== null ? decodeEntities(match[2] ?? match[3] ?? '') : undefined
}

function resolvePath(base: string, href: string): string {
  const parts = base.split('/').slice(0, -1)
  for (const part of decodeURIComponent(href.split('#')[0]!).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part.length > 0) parts.push(part)
  }
  return parts.join('/')
}

/** @throws when the archive is not an EPUB or holds no readable text. */
export function epubToBook(bytes: Uint8Array): BookFile {
  const files = readZip(bytes)
  const text = (name: string): string | undefined => {
    const data = files.get(name)
    return data !== undefined ? decodeText(data) : undefined
  }
  const container = text('META-INF/container.xml')
  const opfPath = container !== undefined ? attribute(/<rootfile\b[^>]*>/i.exec(container)?.[0] ?? '', 'full-path') : [...files.keys()].find(name => name.endsWith('.opf'))
  const opf = opfPath !== undefined ? text(opfPath) : undefined
  if (opfPath === undefined || opf === undefined) throw new Error('this file is not a readable EPUB (no package document)')
  const manifest = new Map<string, { href: string; type: string }>()
  for (const item of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attribute(item, 'id')
    const href = attribute(item, 'href')
    if (id !== undefined && href !== undefined) manifest.set(id, { href, type: attribute(item, 'media-type') ?? '' })
  }
  const chapters: string[] = []
  for (const ref of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    const item = manifest.get(attribute(ref, 'idref') ?? '')
    if (item === undefined || !/html|xml/i.test(item.type)) continue
    const document = text(resolvePath(opfPath, item.href))
    if (document === undefined) continue
    const plain = htmlToText(document)
    // Cover pages, title pages and blank separators carry no prose worth importing.
    if (plain.replace(/\s/g, '').length >= 20 || /^#\s/m.test(plain)) chapters.push(plain)
  }
  if (chapters.length === 0) throw new Error('this EPUB holds no readable text (it may be image-only or protected)')
  const meta = (name: string): string | undefined => {
    const value = new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, 'i').exec(opf)?.[1]
    const clean = value !== undefined ? decodeEntities(value.replace(/<[^>]+>/g, '')).trim() : ''
    return clean.length > 0 ? clean : undefined
  }
  const title = meta('title')
  const author = meta('creator')
  return { text: chapters.join('\n\n'), ...(title !== undefined ? { title } : {}), ...(author !== undefined ? { author } : {}) }
}

// ───────────────────────────── Word ─────────────────────────────

/** @throws when the archive is not a Word document. */
export function docxToBook(bytes: Uint8Array): BookFile {
  const document = readZip(bytes).get('word/document.xml')
  if (document === undefined) throw new Error('this file is not a readable Word document')
  const xml = decodeText(document)
  const paragraphs: string[] = []
  for (const paragraph of xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
    const line = paragraph
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_whole, inner: string) => `\u0001${inner}\u0002`)
      .replace(/<[^>]+>/g, '')
      .replace(/[\u0001\u0002]/g, '')
    const clean = decodeEntities(line).trim()
    if (clean.length === 0) continue
    const heading = /<w:pStyle\b[^>]*w:val="(?:Heading|heading|标题)\s*([1-3])"/.test(paragraph) || /<w:outlineLvl\b[^>]*w:val="[0-2]"/.test(paragraph)
    paragraphs.push(heading ? `# ${clean}` : clean)
  }
  if (paragraphs.length === 0) throw new Error('this Word document holds no text')
  return { text: paragraphs.join('\n\n') }
}

/** Read a book file by its name and bytes. */
export function readBookFile(name: string, bytes: Uint8Array): BookFile {
  const lower = name.toLowerCase()
  const zipped = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  if (lower.endsWith('.epub') || (zipped && !lower.endsWith('.docx') && readZipSafe(bytes)?.has('META-INF/container.xml') === true)) return epubToBook(bytes)
  if (lower.endsWith('.docx')) return docxToBook(bytes)
  if (zipped) throw new Error('this archive is neither an EPUB nor a Word document')
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xhtml')) return { text: htmlToText(decodeText(bytes)) }
  return { text: decodeText(bytes) }
}

function readZipSafe(bytes: Uint8Array): Map<string, Uint8Array> | undefined {
  try {
    return readZip(bytes)
  } catch {
    return undefined
  }
}

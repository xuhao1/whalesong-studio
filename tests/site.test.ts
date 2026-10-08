// SPDX-License-Identifier: LGPL-3.0-or-later
/** A book published as a site of its own: what goes into the folder, and what happens when it is published again. */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishSite, siteChaptersUpTo, siteDefaults, siteFolder, sitePage } from '../src/core/pipelines/site'
import { bookAnswer, ReaderRefused } from '../src/core/reader'
import { hashText, proseOnly } from '../src/shared/text'
import { createTestBed, type TestBed } from './support/harness'

const READER = new TextEncoder().encode('/* the reader */')

async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...await tree(join(dir, entry.name), path))
    else out.push(path)
  }
  return out.sort()
}

describe('a book as a site', () => {
  let bed: TestBed
  let out: string
  beforeEach(async () => {
    bed = await createTestBed()
    out = await mkdtemp(join(tmpdir(), 'novel-site-'))
    const { project } = bed.runtime
    for (const title of ['雨夜', '旧剑', '来客']) await project.addChapter({ title })
    const picture = await project.writeAsset('images/scene-1.png', new Uint8Array([1, 2, 3, 4]))
    await project.saveChapterText('ch001', `她回到旧居。\n\n![雨里的门](${picture})\n\n门没有锁。`)
    await project.saveChapterText('ch002', '她把剑放回匣中。')
    const voice = await project.writeAsset('audio/ch001/l1.wav', new Uint8Array([9, 9, 9]))
    const sound = await project.writeAsset('audio/ch001/rain.wav', new Uint8Array([7, 7]))
    const panel = await project.writeAsset('images/panel-1.png', new Uint8Array([5, 6]))
    const now = new Date().toISOString()
    const textHash = hashText(proseOnly(await project.chapterText('ch001')))
    await project.saveAudioScript({ schema: 1, chapterId: 'ch001', textHash, updatedAt: now, lines: [{ id: 'l1', kind: 'narration', text: '她回到旧居。', audio: voice, duration: 2 }, { id: 'l2', kind: 'narration', text: '门没有锁。' }], cues: [{ at: 'l1', ambience: 'rain', id: 'c1', kind: 'bed', audio: sound, prompt: 'heavy rain on a tiled roof — how it was asked for is the author\'s business' }] } as never)
    await project.saveComicBoard({ schema: 1, chapterId: 'ch001', textHash, updatedAt: now, style: '', panels: [{ id: 'p1', lines: ['l1'], description: '门', camera: 'still', prompt: 'a door in the rain', image: panel }, { id: 'p2', lines: ['l2'], description: '锁', camera: 'still', prompt: 'a lock' }] } as never)
    await project.writeAsset('images/cover-1.png', new Uint8Array([8]))
    await project.updateManifest({ cover: 'assets/images/cover-1.png', author: '某人' })
  })
  afterEach(async () => {
    await bed.cleanup()
    await rm(out, { recursive: true, force: true })
  })

  it('writes the reader, what the reader asks for, and the book\'s own files it shows and plays — and nothing else of the book', async () => {
    const id = (await bed.runtime.project.manifest()).id
    const result = await publishSite(bed.core, bed.runtime, { out, reader: READER, credit: { name: 'Novel Studio', url: 'https://example.org' } })
    expect(await tree(out)).toEqual([
      'data/books.json',
      `data/${id}/book.json`,
      `data/${id}/chapters/ch001.json`,
      `data/${id}/chapters/ch002.json`,
      'index.html',
      `media/${id}/assets/audio/ch001/l1.wav`,
      `media/${id}/assets/audio/ch001/rain.wav`,
      `media/${id}/assets/images/cover-1.png`,
      `media/${id}/assets/images/panel-1.png`,
      `media/${id}/assets/images/scene-1.png`,
      'reader.js',
      'site.json',
    ])
    expect(result).toMatchObject({ dir: out, chapters: 2, files: 11, written: 11, removed: 0, missing: [] })
    // The data is what a device on the network is answered with.
    const book = JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8'))
    expect(book).toEqual(await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: [], by: 'test' }))
    expect(book.book).toMatchObject({ title: '测试之书', author: '某人', chapters: 2, mode: 'read', cover: 'assets/images/cover-1.png' })
    const chapter = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8'))
    expect(chapter).toEqual(await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['chapters', 'ch001'], by: 'test' }))
    // Nothing only the author needs: how a sound or a picture was asked for stays home.
    expect(JSON.stringify(chapter)).not.toMatch(/tiled roof|a door in the rain/)
    expect(await readFile(join(out, 'media', id, 'assets', 'images', 'scene-1.png'))).toEqual(Buffer.from([1, 2, 3, 4]))
    const page = await readFile(join(out, 'index.html'), 'utf8')
    expect(page).toContain('<meta name="novel-site" content="static">')
    expect(page).toContain('<script src="reader.js" defer></script>')
    expect(page).toContain('Novel Studio|https://example.org')
  })

  it('writes only what changed when published again, and takes away what is no longer part of the book', async () => {
    await publishSite(bed.core, bed.runtime, { out, reader: READER })
    const id = (await bed.runtime.project.manifest()).id
    const untouched = (await stat(join(out, 'media', id, 'assets', 'audio', 'ch001', 'l1.wav'))).mtimeMs
    // A file of the author's own in the folder is none of the site's business.
    await writeFile(join(out, 'CNAME'), 'book.example.org')
    const again = await publishSite(bed.core, bed.runtime, { out, reader: READER })
    expect(again).toMatchObject({ files: 11, written: 0, removed: 0 })
    await bed.runtime.project.saveChapterText('ch002', '她把剑放回匣中，又取了出来。')
    await bed.runtime.project.removeChapter('ch001')
    const third = await publishSite(bed.core, bed.runtime, { out, reader: READER })
    // The book, the shelf and the chapter that changed are written; the first chapter and everything only it used are gone.
    expect(third).toMatchObject({ chapters: 1, written: 3, removed: 5 })
    expect(await tree(out)).toEqual(['CNAME', 'data/books.json', `data/${id}/book.json`, `data/${id}/chapters/ch002.json`, 'index.html', `media/${id}/assets/images/cover-1.png`, 'reader.js', 'site.json'])
    expect(untouched).toBeGreaterThan(0)
  })

  it('leaves the audio drama and the comic out when asked to', async () => {
    const id = (await bed.runtime.project.manifest()).id
    const result = await publishSite(bed.core, bed.runtime, { out, reader: READER, listen: false, watch: false })
    expect(result.files).toBe(8)
    const chapter = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8'))
    expect(chapter.script).toBeUndefined()
    expect(chapter.board).toBeUndefined()
    const { chapters } = JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8'))
    expect(chapters[0]).toMatchObject({ id: 'ch001', lines: 0, voiced: 0, panels: 0, drawn: 0 })
    expect((await tree(out)).filter(path => path.startsWith('media/'))).toEqual([`media/${id}/assets/images/cover-1.png`, `media/${id}/assets/images/scene-1.png`])
  })

  it('says what the book names and the disk does not have, and publishes the rest', async () => {
    await bed.runtime.project.removeAsset('audio/ch001/rain.wav')
    const result = await publishSite(bed.core, bed.runtime, { out, reader: READER })
    expect(result.missing).toEqual(['assets/audio/ch001/rain.wav'])
    expect(result.files).toBe(10)
  })

  it('refuses a folder inside the book, and a book with nothing to read', async () => {
    await expect(publishSite(bed.core, bed.runtime, { out: join(bed.runtime.project.root, 'export', 'site'), reader: READER })).rejects.toThrow(/outside the book/)
    await expect(publishSite(bed.core, bed.runtime, { out, reader: READER, chapters: ['ch003'] })).rejects.toThrow(/no chapter has text/)
    await mkdir(join(out, 'sub'), { recursive: true })
    expect((await publishSite(bed.core, bed.runtime, { out: join(out, 'sub'), reader: READER, chapters: ['ch002'] })).chapters).toBe(1)
  })

  it('answers a reader the same wherever it asks from, and refuses what it may not do', async () => {
    const ask = (mode: 'read' | 'edit', method: 'GET' | 'PUT' | 'POST', path: string[], body?: Record<string, unknown>) => bookAnswer(bed.core, bed.runtime, mode, { method, path, ...(body !== undefined ? { body } : {}), by: '手机' })
    await expect(ask('read', 'GET', ['chapters', 'ch003'])).rejects.toMatchObject({ status: 404 })
    await expect(ask('read', 'PUT', ['chapters', 'ch002'], { text: '改' })).rejects.toMatchObject({ status: 403, code: 'read-only' })
    await expect(ask('read', 'GET', ['plays'])).rejects.toBeInstanceOf(ReaderRefused)
    await expect(ask('edit', 'GET', ['nonsense'])).rejects.toMatchObject({ status: 404 })
    await expect(ask('edit', 'POST', ['nonsense'])).rejects.toMatchObject({ status: 405 })
    expect(await ask('edit', 'PUT', ['chapters', 'ch002'], { text: '她把剑放回匣中。又看了一眼。' })).toMatchObject({ changed: true })
    expect((await bed.runtime.project.activity(1))[0]).toMatchObject({ by: 'device', chapter: 'ch002' })
    expect(await ask('edit', 'GET', ['cast'])).toEqual({ cast: [] })
    expect(sitePage('A & B', 'en')).toContain('<title>A &amp; B</title>')
  })

  it('is published as far as one chapter, when the book goes out a part at a time', async () => {
    const id = (await bed.runtime.project.manifest()).id
    // By id, by number, by title: the written chapters of the main line up to it.
    expect(await siteChaptersUpTo(bed.runtime, 'ch001')).toEqual(['ch001'])
    expect(await siteChaptersUpTo(bed.runtime, '2')).toEqual(['ch001', 'ch002'])
    expect(await siteChaptersUpTo(bed.runtime, '旧剑')).toEqual(['ch001', 'ch002'])
    // A chapter nothing is written of is not somewhere to publish up to.
    await expect(siteChaptersUpTo(bed.runtime, 'ch003')).rejects.toThrow(/no written chapter/)
    const result = await publishSite(bed.core, bed.runtime, { out, reader: READER, chapters: await siteChaptersUpTo(bed.runtime, 'ch001') })
    expect(result.chapters).toBe(1)
    expect((await tree(out)).filter(path => path.includes('/chapters/'))).toEqual([`data/${id}/chapters/ch001.json`])
    expect(JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8')).book.chapters).toBe(1)
  })

  it('opens the way its author reads — with settings that are known, and within what the reader allows', async () => {
    // What a browser's storage holds is not taken on trust.
    expect(siteDefaults({ prefs: { size: 22, theme: 'night', serif: false, notes: 'yes', evil: '<script>' }, options: { rate: 9, voiceVolume: -1, autoNext: false, token: 'x' } })).toEqual({
      prefs: { size: 22, theme: 'night', serif: false },
      options: { rate: 2, voiceVolume: 0, autoNext: false },
    })
    expect(siteDefaults({ prefs: { theme: 'sepia' } })).toBeUndefined()
    expect(siteDefaults(undefined)).toBeUndefined()
    expect(siteDefaults('big')).toBeUndefined()
    const page = sitePage('一本书', 'zh', undefined, siteDefaults({ prefs: { size: 20, theme: 'paper' }, options: { rate: 1.25 } }))
    expect(page).toContain('<meta name="novel-defaults" content="{&quot;prefs&quot;:{&quot;size&quot;:20,&quot;theme&quot;:&quot;paper&quot;},&quot;options&quot;:{&quot;rate&quot;:1.25}}">')
    expect(sitePage('一本书', 'zh')).not.toContain('novel-defaults')
    await publishSite(bed.core, bed.runtime, { out, reader: READER, defaults: { prefs: { size: 24 } } })
    expect(await readFile(join(out, 'index.html'), 'utf8')).toContain('novel-defaults')
  })

  it('goes into the folder its author names, else one beside the book — never a name that is no folder', () => {
    expect(siteFolder('/books/雨夜', '雨夜', undefined)).toBe('/books/雨夜-site')
    expect(siteFolder('/books/雨夜', 'a/b:c?', '')).toBe('/books/abc-site')
    expect(siteFolder('/books/雨夜', '雨夜', 'web')).toBe('/books/web')
    expect(siteFolder('/books/雨夜', '雨夜', '/srv/site')).toBe('/srv/site')
  })
})

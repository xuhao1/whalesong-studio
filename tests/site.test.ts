// SPDX-License-Identifier: LGPL-3.0-or-later
/** A book published as a site of its own: what goes into the folder, and what happens when it is published again. */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PicturePress, SoundPress } from '../src/core/media/press'
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

  it('carries uncompressed sound pressed, under the name of what it then is, and presses it again only when it changes', async () => {
    const { project } = bed.runtime
    const id = (await project.manifest()).id
    await project.writeAsset('audio/ch001/l1.wav', new Uint8Array(64).fill(9))
    await project.writeAsset('audio/ch001/rain.wav', new Uint8Array(48).fill(7))
    const pressed: number[] = []
    const press = (key: string): SoundPress => ({ ext: 'm4a', key, press: async (wav) => { pressed.push(wav.byteLength); return Uint8Array.from([0xaa, wav[0]!]) } })
    const sounds = async (): Promise<string[]> => (await tree(out)).filter(path => path.includes('/audio/'))
    const told = async (): Promise<{ line?: string; cue?: string }> => {
      const chapter = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8'))
      return { line: chapter.script.lines[0].audio, cue: chapter.script.cues[0].audio }
    }
    const first = await publishSite(bed.core, bed.runtime, { out, reader: READER, press: press('fake/1') })
    expect(await sounds()).toEqual([`media/${id}/assets/audio/ch001/l1.m4a`, `media/${id}/assets/audio/ch001/rain.m4a`])
    // The reader is told the name the sound went out under; everything else it is told is as a device on the network gets it.
    expect(await told()).toEqual({ line: 'assets/audio/ch001/l1.m4a', cue: 'assets/audio/ch001/rain.m4a' })
    expect(first).toMatchObject({ files: 11, written: 11, sound: { files: 2, from: 112, to: 4, failed: [] } })
    expect(await readFile(join(out, 'media', id, 'assets', 'audio', 'ch001', 'l1.m4a'))).toEqual(Buffer.from([0xaa, 9]))
    // Pictures are not sound: they go as they are.
    expect(await readFile(join(out, 'media', id, 'assets', 'images', 'scene-1.png'))).toEqual(Buffer.from([1, 2, 3, 4]))
    // Several are pressed at once: which comes first is not said.
    expect([...pressed].sort()).toEqual([48, 64])

    // Published again with nothing changed: nothing is written, and nothing is pressed.
    const again = await publishSite(bed.core, bed.runtime, { out, reader: READER, press: press('fake/1') })
    expect(again).toMatchObject({ files: 11, written: 0, removed: 0, sound: { files: 2, from: 112, to: 4 } })
    expect(pressed).toHaveLength(2)

    // One sound made anew: that one is pressed, the other is not.
    await project.writeAsset('audio/ch001/rain.wav', new Uint8Array(40).fill(3))
    expect(await publishSite(bed.core, bed.runtime, { out, reader: READER, press: press('fake/1') })).toMatchObject({ written: 1, sound: { files: 2, from: 104 } })
    expect(pressed).toHaveLength(3)
    expect(pressed.at(-1)).toBe(40)
    // A pressed file that is gone from the folder, or not what was written, is made again.
    await rm(join(out, 'media', id, 'assets', 'audio', 'ch001', 'l1.m4a'))
    await writeFile(join(out, 'media', id, 'assets', 'audio', 'ch001', 'rain.m4a'), 'something else')
    expect(await publishSite(bed.core, bed.runtime, { out, reader: READER, press: press('fake/1') })).toMatchObject({ written: 2 })
    expect(pressed).toHaveLength(5)
    // Another way of pressing: everything is pressed anew.
    await publishSite(bed.core, bed.runtime, { out, reader: READER, press: press('fake/2') })
    expect(pressed).toHaveLength(7)

    // Without a press the sound goes out as it lies in the book, and the pressed files of last time are taken away.
    const plain = await publishSite(bed.core, bed.runtime, { out, reader: READER })
    expect(plain.sound).toBeUndefined()
    expect(plain).toMatchObject({ files: 11, removed: 2 })
    expect(await sounds()).toEqual([`media/${id}/assets/audio/ch001/l1.wav`, `media/${id}/assets/audio/ch001/rain.wav`])
    expect(await told()).toEqual({ line: 'assets/audio/ch001/l1.wav', cue: 'assets/audio/ch001/rain.wav' })
    expect(JSON.parse(await readFile(join(out, 'site.json'), 'utf8')).sources).toBeUndefined()
    // And pressed again after that: the plain files go, the reader is told the new names.
    expect(await publishSite(bed.core, bed.runtime, { out, reader: READER, press: press('fake/2') })).toMatchObject({ removed: 2, sound: { files: 2 } })
    expect(await sounds()).toEqual([`media/${id}/assets/audio/ch001/l1.m4a`, `media/${id}/assets/audio/ch001/rain.m4a`])
  })

  it('publishes a sound the press cannot do as it is, and says so — and one that would be no smaller', async () => {
    const { project } = bed.runtime
    const id = (await project.manifest()).id
    await project.writeAsset('audio/ch001/l1.wav', new Uint8Array(64).fill(9))
    await project.writeAsset('audio/ch001/rain.wav', new Uint8Array(48).fill(7))
    const stubborn: SoundPress = { ext: 'm4a', key: 'fake/1', press: async (wav) => { if (wav[0] === 7) throw new Error('no sound in it'); return Uint8Array.from([0xaa]) } }
    const result = await publishSite(bed.core, bed.runtime, { out, reader: READER, press: stubborn })
    expect(result.sound).toEqual({ files: 1, from: 64, to: 1, failed: ['assets/audio/ch001/rain.wav'], reason: 'no sound in it' })
    expect((await tree(out)).filter(path => path.includes('/audio/'))).toEqual([`media/${id}/assets/audio/ch001/l1.m4a`, `media/${id}/assets/audio/ch001/rain.wav`])
    const chapter = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8'))
    expect([chapter.script.lines[0].audio, chapter.script.cues[0].audio]).toEqual(['assets/audio/ch001/l1.m4a', 'assets/audio/ch001/rain.wav'])
    expect(await readFile(join(out, 'media', id, 'assets', 'audio', 'ch001', 'rain.wav'))).toEqual(Buffer.from(new Uint8Array(48).fill(7)))

    // A press that makes nothing smaller is not used: the sound goes as it lies, and that is no failure.
    const useless: SoundPress = { ext: 'm4a', key: 'fake/3', press: async wav => new Uint8Array(wav.byteLength + 1) }
    const kept = await publishSite(bed.core, bed.runtime, { out, reader: READER, press: useless })
    expect(kept.sound).toBeUndefined()
    expect((await tree(out)).filter(path => path.includes('/audio/'))).toEqual([`media/${id}/assets/audio/ch001/l1.wav`, `media/${id}/assets/audio/ch001/rain.wav`])

    // Stopped in the middle, it stops: a press that was told to stop is not taken for one that cannot.
    const stop = new AbortController()
    const halted: SoundPress = { ext: 'm4a', key: 'fake/4', press: async () => { stop.abort(); throw new Error('stopped') } }
    await expect(publishSite(bed.core, bed.runtime, { out, reader: READER, press: halted }, { origin: 'user', signal: stop.signal })).rejects.toThrow()
  })

  it('carries pictures kept without loss as smaller ones under the name of what they then are — in the data and in the prose — and presses one again only when it changes', async () => {
    const { project } = bed.runtime
    const id = (await project.manifest()).id
    // The pictures of the fixture: the cover (1 byte), a panel (2), a picture the prose shows (4). One more that is see-through, and one already small.
    const glass = await project.writeAsset('images/glass.png', new Uint8Array([0, 0, 0]))
    const photo = await project.writeAsset('images/photo.jpg', new Uint8Array([4, 4, 4, 4, 4]))
    await project.saveChapterText('ch002', `她把剑放回匣中。\n\n![玻璃](${glass})\n\n  ![旧照](${photo})  \n\n正文里提到 ![不是一行](assets/images/scene-1.png) 的不算图。`)
    const pressed: number[] = []
    // Stands in for the real one: half the bytes; nothing for a picture that is see-through (here: one that begins with 0).
    const press = (key: string): PicturePress => ({ ext: 'jpg', key, press: async (png) => { pressed.push(png.byteLength); return png[0] === 0 ? undefined : new Uint8Array(Math.max(1, png.byteLength >> 1)).fill(0xd8) } })
    const first = await publishSite(bed.core, bed.runtime, { out, reader: READER, pictures: press('fake/1') })
    // The cover is one byte: pressed it would be no smaller, and goes as it lies. The see-through one is counted.
    expect(first.pictures).toEqual({ files: 2, from: 6, to: 3, failed: [], kept: 1 })
    expect([...pressed].sort()).toEqual([1, 2, 3, 4])
    const media = (await tree(out)).filter(path => path.startsWith(`media/${id}/assets/images/`)).map(path => path.split('/').at(-1))
    expect(media).toEqual(['cover-1.png', 'glass.png', 'panel-1.jpg', 'photo.jpg', 'scene-1.jpg'])
    expect(await readFile(join(out, 'media', id, 'assets', 'images', 'scene-1.jpg'))).toEqual(Buffer.from([0xd8, 0xd8]))
    // The reader is told the names the files went out under: where a field is the address, and where a line of prose shows a picture.
    const one = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8'))
    expect(one.text).toContain('![雨里的门](assets/images/scene-1.jpg)')
    expect(one.board.panels[0].image).toBe('assets/images/panel-1.jpg')
    const two = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch002.json'), 'utf8'))
    expect(two.text).toContain('![玻璃](assets/images/glass.png)')
    expect(two.text).toContain('![旧照](assets/images/photo.jpg)')
    // A name in the middle of a sentence is words, not a picture shown: it is left as the author wrote it.
    expect(two.text).toContain('正文里提到 ![不是一行](assets/images/scene-1.png) 的不算图。')
    expect(JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8')).book.cover).toBe('assets/images/cover-1.png')
    // In the book nothing has changed.
    expect(await project.chapterText('ch001')).toContain('assets/images/scene-1.png')
    expect(await project.readFile('assets/images/scene-1.png')).toEqual(Buffer.from([1, 2, 3, 4]))

    // Published again with nothing changed: nothing is written; only what was not made smaller is looked at again.
    pressed.length = 0
    expect(await publishSite(bed.core, bed.runtime, { out, reader: READER, pictures: press('fake/1') })).toMatchObject({ written: 0, pictures: { files: 2, kept: 1 } })
    expect([...pressed].sort()).toEqual([1, 3])
    // One picture drawn anew: that one is pressed.
    await project.writeAsset('images/panel-1.png', new Uint8Array([6, 6, 6, 6, 6, 6]))
    pressed.length = 0
    expect(await publishSite(bed.core, bed.runtime, { out, reader: READER, pictures: press('fake/1') })).toMatchObject({ written: 1, pictures: { files: 2, from: 10, to: 5 } })
    expect([...pressed].sort()).toEqual([1, 3, 6])

    // Sound and pictures each go through their own press, and say so each for themselves.
    const sound: SoundPress = { ext: 'm4a', key: 'fake/1', press: async () => Uint8Array.from([1]) }
    const both = await publishSite(bed.core, bed.runtime, { out, reader: READER, pictures: press('fake/1'), press: sound })
    expect(both.sound).toMatchObject({ files: 2 })
    expect(both.pictures).toMatchObject({ files: 2 })

    // Without the picture press they go out as they lie in the book, and the smaller files of last time are taken away.
    const plain = await publishSite(bed.core, bed.runtime, { out, reader: READER })
    expect(plain.pictures).toBeUndefined()
    expect((await tree(out)).filter(path => path.startsWith(`media/${id}/assets/images/`)).map(path => path.split('/').at(-1))).toEqual(['cover-1.png', 'glass.png', 'panel-1.png', 'photo.jpg', 'scene-1.png'])
    expect(JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8')).text).toContain('assets/images/scene-1.png')
    expect(JSON.parse(await readFile(join(out, 'site.json'), 'utf8')).sources).toBeUndefined()
  })

  it('publishes a picture the press cannot do as it is, and says so — and leaves alone one whose smaller name the book already uses', async () => {
    const { project } = bed.runtime
    const id = (await project.manifest()).id
    // The book keeps a JPEG by the very name the panel would go out under.
    await project.writeAsset('images/panel-1.jpg', new Uint8Array([3, 3, 3]))
    await project.saveChapterText('ch002', '她把剑放回匣中。\n\n![同名](assets/images/panel-1.jpg)')
    const stubborn: PicturePress = { ext: 'jpg', key: 'fake/1', press: async (png) => { if (png.byteLength === 4) throw new Error('no picture in it'); return Uint8Array.from([0xd8]) } }
    const result = await publishSite(bed.core, bed.runtime, { out, reader: READER, pictures: stubborn })
    expect(result.pictures).toEqual({ files: 0, from: 0, to: 0, failed: ['assets/images/scene-1.png'], reason: 'no picture in it' })
    const media = (await tree(out)).filter(path => path.startsWith(`media/${id}/assets/images/`)).map(path => path.split('/').at(-1))
    expect(media).toEqual(['cover-1.png', 'panel-1.jpg', 'panel-1.png', 'scene-1.png'])
    // Each is what it is in the book: the panel its PNG, the picture of chapter 2 the JPEG.
    expect(await readFile(join(out, 'media', id, 'assets', 'images', 'panel-1.png'))).toEqual(Buffer.from([5, 6]))
    expect(await readFile(join(out, 'media', id, 'assets', 'images', 'panel-1.jpg'))).toEqual(Buffer.from([3, 3, 3]))
    expect(JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8')).board.panels[0].image).toBe('assets/images/panel-1.png')
  })

  it('carries a chapter\'s finished video and its words — unless told to leave the videos out', async () => {
    const { project } = bed.runtime
    const id = (await project.manifest()).id
    const film = await project.writeAsset('video/ch001.mp4', new Uint8Array(200).fill(4))
    const words = await project.writeAsset('video/ch001.vtt', new TextEncoder().encode('WEBVTT\n\n00:00.000 --> 00:02.000\n她回到旧居。\n'))
    // What post-production left on its bench while cutting is nobody's to read.
    await project.writeAsset('video/work/ch001/clips/p001.mp4', new Uint8Array(50))
    await project.writeState(['video', 'ch001.json'], { schema: 1, chapterId: 'ch001', path: film, duration: 12.5, width: 1920, height: 1080, size: 200, createdAt: '2026-01-02T03:04:05.000Z', note: 'a note that is the author\'s', subtitles: { path: words, burned: true } })
    const result = await publishSite(bed.core, bed.runtime, { out, reader: READER })
    expect(result.videos).toBe(1)
    expect((await tree(out)).filter(path => path.includes('/video/'))).toEqual([`media/${id}/assets/video/ch001.mp4`, `media/${id}/assets/video/ch001.vtt`])
    expect(await readFile(join(out, 'media', id, 'assets', 'video', 'ch001.mp4'))).toEqual(Buffer.from(new Uint8Array(200).fill(4)))
    const chapter = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8'))
    // The file, its shape, its words and whether they are in the picture — and nothing of how it was cut.
    expect(chapter.video).toEqual({ path: 'assets/video/ch001.mp4', duration: 12.5, width: 1920, height: 1080, subtitles: 'assets/video/ch001.vtt', burned: true, version: '2026-01-02T03:04:05.000Z' })
    expect(chapter).toEqual(await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['chapters', 'ch001'], by: 'test' }))
    const book = JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8'))
    expect(book).toEqual(await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: [], by: 'test' }))
    expect(book.chapters.map((item: { video?: boolean }) => item.video)).toEqual([true, undefined])
    // Sound is pressed; a video is carried as it is.
    const press: SoundPress = { ext: 'm4a', key: 'fake/1', press: async () => Uint8Array.from([1]) }
    await publishSite(bed.core, bed.runtime, { out, reader: READER, press })
    expect((await tree(out)).filter(path => path.includes('/video/'))).toHaveLength(2)

    // Left out: no file, and the reader is told of none — the motion comic is still there to watch.
    const without = await publishSite(bed.core, bed.runtime, { out, reader: READER, video: false })
    expect(without.videos).toBeUndefined()
    expect((await tree(out)).filter(path => path.includes('/video/'))).toEqual([])
    const plain = JSON.parse(await readFile(join(out, 'data', id, 'chapters', 'ch001.json'), 'utf8'))
    expect(plain.video).toBeUndefined()
    expect(plain.board.panels).toHaveLength(2)
    expect(JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8')).chapters[0].video).toBeUndefined()
    // A record whose file is gone is no video.
    await project.removeAsset('video/ch001.mp4')
    expect((await publishSite(bed.core, bed.runtime, { out, reader: READER })).videos).toBeUndefined()
  })

  it('goes into the folder its author names, else one beside the book — never a name that is no folder', () => {
    expect(siteFolder('/books/雨夜', '雨夜', undefined)).toBe('/books/雨夜-site')
    expect(siteFolder('/books/雨夜', 'a/b:c?', '')).toBe('/books/abc-site')
    expect(siteFolder('/books/雨夜', '雨夜', 'web')).toBe('/books/web')
    expect(siteFolder('/books/雨夜', '雨夜', '/srv/site')).toBe('/srv/site')
  })
})

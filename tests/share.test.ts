// SPDX-License-Identifier: LGPL-3.0-or-later
/** Reading on another device: what the reader's server hands out, and everything it must not. */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addresses, ShareServer } from '../src/host/share'
import { readPosition, savePosition } from '../src/core/reader'
import { encodeWav } from '../src/core/media/wav'
import { hashText, proseOnly } from '../src/shared/text'
import { createTestBed, PIXEL, type TestBed } from './support/harness'

/** A port nobody is listening on right now. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => { resolve(typeof address === 'object' && address !== null ? address.port : 0) })
    })
  })
}

describe('the reader for other devices', () => {
  let bed: TestBed
  let share: ShareServer
  let port: number
  let chapterId: string
  beforeEach(async () => {
    bed = await createTestBed({ title: '白页遗骸' })
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '拍卖厅' })
    chapterId = plan.id
    await project.saveChapterText(chapterId, '星灯港的拍卖厅是用一根旧神的肋骨撑起来的。\n\n![穹顶](assets/images/dome.png)\n\n“零七。”')
    await project.addChapter({ title: '还没写的一章' })
    await project.writeAsset('images/dome.png', PIXEL)
    const audio = await project.writeAsset(`audio/${chapterId}/l0-abc.wav`, encodeWav({ pcm: new Int16Array(2400), sampleRate: 24000 }))
    await project.saveAudioScript({
      schema: 1,
      chapterId,
      textHash: hashText(proseOnly(await project.chapterText(chapterId))),
      updatedAt: new Date().toISOString(),
      lines: [{ id: 'l0', kind: 'narration', text: '星灯港的拍卖厅是用一根旧神的肋骨撑起来的。', audio, duration: 0.1, renderKey: 'abc', direction: '沉稳' }, { id: 'l1', kind: 'dialogue', text: '零七。', speakerName: '拍卖师', speaker: 'c_x' }],
      cues: [{ at: 'l0', ambience: 'none' }],
    })
    port = await freePort()
    // On the loopback interface only: a test has no business listening on the network.
    share = new ShareServer(bed.core, () => {}, '127.0.0.1')
  })
  afterEach(async () => {
    await share.close()
    await bed.cleanup()
  })

  const turnOn = async (): Promise<string> => {
    await bed.core.settings.update({ share: { enabled: true, port, books: [bed.runtime.project.root] } })
    await share.apply()
    const status = await share.status()
    expect(status.running).toBe(true)
    // The port asked for was free when it was looked for; a test of another file may have taken it since, and then the reader
    // listens on the next one (which is what it is for). The tests talk to where it listens.
    port = status.port ?? port
    const token = (await bed.core.settings.get()).share!.token!
    expect(token.length).toBeGreaterThanOrEqual(20)
    for (const url of status.urls) expect(url).toContain(`:${port}/${token}/`)
    return `http://127.0.0.1:${port}/${token}`
  }

  it('is closed until it is switched on, and closed again when it is switched off', async () => {
    await share.apply()
    // (Not asked of the network: whether anybody answers on that port is not this reader's doing alone — another test may listen there.)
    expect(await share.status()).toMatchObject({ enabled: false, running: false, urls: [], books: [] })
    // Switched on without a book to share, there is still nothing to serve.
    await bed.core.settings.update({ share: { enabled: true, port, books: [] } })
    await share.apply()
    expect((await share.status()).running).toBe(false)
    const base = await turnOn()
    expect((await fetch(`${base}/api/books`)).status).toBe(200)
    await bed.core.settings.update({ share: { enabled: false } })
    await share.apply()
    expect((await share.status()).running).toBe(false)
    // Nothing of this reader answers there any more. (Whoever listens on the port a moment later — a test of another file — knows nothing of this address.)
    expect(await fetch(`${base}/api/books`).then(response => response.status, () => 0)).not.toBe(200)
  })

  it('serves the shared book, its chapters and their media to whoever has the address', async () => {
    const base = await turnOn()
    const manifest = await bed.runtime.project.manifest()
    const { books } = await (await fetch(`${base}/api/books`)).json() as { books: { id: string; title: string; chapters: number }[] }
    expect(books).toEqual([expect.objectContaining({ id: manifest.id, title: '白页遗骸', chapters: 1 })])
    const detail = await (await fetch(`${base}/api/books/${manifest.id}`)).json() as { chapters: { id: string; title: string; lines: number; voiced: number }[] }
    // Only what has text can be read.
    expect(detail.chapters).toEqual([expect.objectContaining({ id: chapterId, title: '拍卖厅', lines: 2, voiced: 1 })])
    const chapter = await (await fetch(`${base}/api/books/${manifest.id}/chapters/${chapterId}`)).json() as { text: string; stale: boolean; script: { lines: Record<string, unknown>[] } }
    expect(chapter.text).toContain('旧神的肋骨')
    expect(chapter.stale).toBe(false)
    expect(chapter.script.lines[1]).toEqual({ id: 'l1', kind: 'dialogue', text: '零七。', speakerName: '拍卖师' })
    // What only the author needs stays behind: delivery notes, character ids.
    expect(chapter.script.lines[0]).not.toHaveProperty('direction')
    expect(JSON.stringify(chapter)).not.toContain('c_x')
    expect(JSON.stringify(chapter)).not.toContain(bed.runtime.project.root)

    const picture = await fetch(`${base}/media/${manifest.id}/assets/images/dome.png`)
    expect(picture.status).toBe(200)
    expect(picture.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(PIXEL)
    const audio = await fetch(`${base}/media/${manifest.id}/assets/audio/${chapterId}/l0-abc.wav`, { headers: { range: 'bytes=0-43' } })
    expect(audio.status).toBe(206)
    expect(audio.headers.get('content-range')).toMatch(/^bytes 0-43\/\d+$/)
    expect((await audio.arrayBuffer()).byteLength).toBe(44)

    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await page.text()).toContain('<script src="app.js" defer></script>')
  })

  it('hands out nothing else', async () => {
    const base = await turnOn()
    const manifest = await bed.runtime.project.manifest()
    const origin = `http://127.0.0.1:${port}`
    const token = base.slice(origin.length + 1)
    // No token, a wrong token, a token that only starts right: there is nothing here.
    // (The last letter is changed to another one: a token that happens to end in the letter put there would be the right token.)
    for (const path of ['/', '/api/books', `/${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}/api/books`, `/${token.slice(0, 10)}/api/books`, `/${token}x/api/books`]) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(404)
    }
    // The manuscript, the bible, the project file and the settings are not media.
    for (const path of [
      `/media/${manifest.id}/novel.json`,
      `/media/${manifest.id}/manuscript/${chapterId}.md`,
      `/media/${manifest.id}/assets/../novel.json`,
      `/media/${manifest.id}/assets/%2e%2e/novel.json`,
      `/media/${manifest.id}/assets/..%2Fnovel.json`,
      `/media/${manifest.id}/assets/images/%2e%2e/%2e%2e/novel.json`,
      `/media/${manifest.id}/assets/images/dome.png%00.md`,
      `/media/${manifest.id}/.novel/audio/${chapterId}.json`,
      `/api/books/${manifest.id}/chapters/..%2F..%2Fnovel`,
      `/api/books/${manifest.id}/chapters/ch999`,
      '/api/books/someone-elses-book',
      '/api/settings',
    ]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404)
    }
    // A file of another type under assets, and a link that leads out of them.
    await mkdir(join(bed.runtime.project.root, 'assets', 'notes'), { recursive: true })
    await writeFile(join(bed.runtime.project.root, 'assets', 'notes', 'secret.txt'), 'x')
    expect((await fetch(`${base}/media/${manifest.id}/assets/notes/secret.txt`)).status).toBe(404)
    await symlink(join(bed.runtime.project.root, 'novel.json'), join(bed.runtime.project.root, 'assets', 'images', 'leak.png'))
    expect((await fetch(`${base}/media/${manifest.id}/assets/images/leak.png`)).status).toBe(404)
    // Nothing can be changed from here.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect((await fetch(`${base}/api/books`, { method })).status).toBe(405)
    // A book that is not shared does not exist, even to someone with the address.
    const other = await bed.core.create(join(bed.dir, 'other'), { title: '没有分享的书', language: 'zh' })
    expect((await fetch(`${base}/api/books/${(await other.project.manifest()).id}`)).status).toBe(404)
    const { books } = await (await fetch(`${base}/api/books`)).json() as { books: unknown[] }
    expect(books).toHaveLength(1)
  })

  it('stops honouring an address once it is replaced', async () => {
    const base = await turnOn()
    expect((await fetch(`${base}/api/books`)).status).toBe(200)
    await bed.core.settings.update({ share: { token: 'a-brand-new-address-token-0123456789' } })
    await share.apply()
    expect((await fetch(`${base}/api/books`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/a-brand-new-address-token-0123456789/api/books`)).status).toBe(200)
  })

  it('moves to the next free port when the one asked for is taken, and says so', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => { blocker.listen(port, '127.0.0.1', () => { resolve() }) })
    try {
      await bed.core.settings.update({ share: { enabled: true, port, books: [bed.runtime.project.root] } })
      await share.apply()
      const status = await share.status()
      expect(status.running).toBe(true)
      expect(status.instead).toBe(port)
      expect(status.port).toBeGreaterThan(port)
      expect(status.error).toBeUndefined()
      const token = (await bed.core.settings.get()).share!.token!
      expect((await fetch(`http://127.0.0.1:${status.port!}/${token}/api/books`)).status).toBe(200)
      // Applying the same settings again leaves the server where it is.
      await share.apply()
      expect((await share.status()).port).toBe(status.port)
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => { resolve() }) })
    }
  })

  const reader = { 'content-type': 'application/json', 'x-novel-reader': '1' }

  it('changes nothing on a book shared for reading', async () => {
    const base = await turnOn()
    const { id } = await bed.runtime.project.manifest()
    const before = await bed.runtime.project.chapterText(chapterId)
    const { books } = await (await fetch(`${base}/api/books`)).json() as { books: { mode: string }[] }
    expect(books[0]!.mode).toBe('read')
    // Not a request of the reader at all: a form posted from another site looks like this.
    expect((await fetch(`${base}/api/books/${id}/chapters/${chapterId}`, { method: 'PUT', body: '{"text":"x"}' })).status).toBe(400)
    for (const [method, path, body] of [
      ['PUT', `/api/books/${id}/chapters/${chapterId}`, { text: '被改掉的正文' }],
      ['POST', `/api/books/${id}/plays`, { situation: '一场戏', cast: [] }],
      ['POST', `/api/books/${id}/plays/play_x/turns`, { text: '你好' }],
    ] as const) {
      const response = await fetch(`${base}${path}`, { method, headers: reader, body: JSON.stringify(body) })
      expect(response.status, path).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'read-only' })
    }
    for (const path of [`/api/books/${id}/plays`, `/api/books/${id}/cast`]) expect((await fetch(`${base}${path}`)).status, path).toBe(403)
    expect(await bed.runtime.project.chapterText(chapterId)).toBe(before)
    expect(bed.llm.requests).toHaveLength(0)
  })

  it('lets a device edit the text and play interludes once the author made the book changeable', async () => {
    const { project } = bed.runtime
    const { id } = await project.manifest()
    const card = await project.saveCharacter({ name: '白页', role: 'protagonist', status: 'active' })
    await bed.core.settings.update({ share: { enabled: true, port, books: [project.root], edit: [project.root] } })
    await share.apply()
    port = (await share.status()).port ?? port
    const base = `http://127.0.0.1:${port}/${(await bed.core.settings.get()).share!.token!}`
    expect((await share.status()).books).toEqual([expect.objectContaining({ mode: 'edit' })])
    const detail = await (await fetch(`${base}/api/books/${id}`)).json() as { book: { mode: string } }
    expect(detail.book.mode).toBe('edit')
    // The text is saved by the same road as an edit in the Studio: a version of what it was, and a line on the record.
    const saved = await fetch(`${base}/api/books/${id}/chapters/${chapterId}`, { method: 'PUT', headers: reader, body: JSON.stringify({ text: '手机上重写的一章。\n“零七。”' }) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ changed: true })
    expect(await project.chapterText(chapterId)).toBe('手机上重写的一章。\n“零七。”')
    const versions = await project.versions(chapterId)
    expect(versions).toHaveLength(1)
    expect(await project.versionText(chapterId, versions[0]!.id)).toContain('肋骨')
    const record = (await project.activity())[0]!
    expect(record).toMatchObject({ by: 'device', chapter: chapterId, version: versions[0]!.id })
    expect((await fetch(`${base}/api/books/${id}/chapters/${chapterId}`, { method: 'PUT', headers: reader, body: JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) }) })).status).toBe(413)
    // An interlude: started, played a turn, a turn taken back.
    const cast = await (await fetch(`${base}/api/books/${id}/cast`)).json() as { cast: { id: string; name: string }[] }
    expect(cast.cast).toEqual([expect.objectContaining({ id: card.id, name: '白页' })])
    bed.llm.responder = () => JSON.stringify({ narration: '货舱里只有一盏灯。', lines: [{ speaker: '白页', text: '在。' }], choices: ['走近一步', '转身离开'] })
    const started = await fetch(`${base}/api/books/${id}/plays`, { method: 'POST', headers: reader, body: JSON.stringify({ situation: '拍卖结束的那天夜里。', cast: [card.id] }) })
    expect(started.status).toBe(200)
    const { play } = await started.json() as { play: { id: string; turns: { narration?: string; choices: string[] }[] } }
    expect(play.turns).toHaveLength(1)
    expect(play.turns[0]!.choices).toEqual(['走近一步', '转身离开'])
    const turned = await (await fetch(`${base}/api/books/${id}/plays/${play.id}/turns`, { method: 'POST', headers: reader, body: JSON.stringify({ kind: 'choice', text: '走近一步' }) })).json() as { play: { turns: { input?: { kind: string; text: string } }[] } }
    expect(turned.play.turns).toHaveLength(2)
    expect(turned.play.turns[1]!.input).toEqual({ kind: 'choice', text: '走近一步' })
    const list = await (await fetch(`${base}/api/books/${id}/plays`)).json() as { plays: { id: string; turns: number }[] }
    expect(list.plays).toEqual([expect.objectContaining({ id: play.id, turns: 2 })])
    const back = await (await fetch(`${base}/api/books/${id}/plays/${play.id}/rewind`, { method: 'POST', headers: reader, body: '{}' })).json() as { play: { turns: unknown[] } }
    expect(back.play.turns).toHaveLength(1)
    // Saying nothing is told to whoever holds the device, in words, not as a crash.
    const empty = await fetch(`${base}/api/books/${id}/plays/${play.id}/turns`, { method: 'POST', headers: reader, body: JSON.stringify({ text: '  ' }) })
    expect(empty.status).toBe(422)
    // Back to read-only, the same requests are refused again.
    await bed.core.settings.update({ share: { edit: [] } })
    await share.apply()
    expect((await fetch(`${base}/api/books/${id}/chapters/${chapterId}`, { method: 'PUT', headers: reader, body: JSON.stringify({ text: '再改' }) })).status).toBe(403)
  })

  it('serves the storyboard, the sound notes and the lines left unspoken with a chapter', async () => {
    const { project } = bed.runtime
    const { id } = await project.manifest()
    const script = (await project.audioScript(chapterId))!
    await project.saveAudioScript({
      ...script,
      lines: [...script.lines.slice(0, 1), { id: 'l1', kind: 'narration', text: '他说，', tag: true }, { id: 'l2', kind: 'dialogue', text: '零七。', speakerName: '拍卖师' }],
      cues: [{ id: 'c0', at: 'l0', kind: 'bed', ambience: 'crowd', caption: '骨壁大厅里干净的回声', prompt: '只给声音模型看的描述' }, { id: 'c1', at: 'l2', kind: 'effect', ambience: 'none', caption: '嗒——银槌轻碰骨木', prompt: '小银槌碰骨木' }],
    })
    await project.saveComicBoard({ schema: 1, chapterId, textHash: script.textHash, updatedAt: new Date().toISOString(), style: '', panels: [{ id: 'p1', lines: ['l0'], description: '骨质穹顶下的拍卖厅', prompt: '画给绘图模型的提示词', camera: 'zoom-in', image: 'assets/images/dome.png' }, { id: 'p2', lines: ['l2'], begin: 0.5, description: '拍卖师探头', prompt: 'x', camera: 'still' }] })
    const base = await turnOn()
    const chapters = await (await fetch(`${base}/api/books/${id}`)).json() as { chapters: { panels: number; drawn: number }[] }
    expect(chapters.chapters[0]).toMatchObject({ panels: 2, drawn: 1 })
    const chapter = await (await fetch(`${base}/api/books/${id}/chapters/${chapterId}`)).json() as { script: { lines: { id: string; skip?: boolean }[]; cues: Record<string, unknown>[] }; board: { panels: Record<string, unknown>[] } }
    expect(chapter.script.lines.map(line => line.skip === true)).toEqual([false, true, false])
    expect(chapter.script.cues).toEqual([
      { id: 'c0', at: 'l0', kind: 'bed', ambience: 'crowd', caption: '骨壁大厅里干净的回声' },
      { id: 'c1', at: 'l2', kind: 'effect', ambience: 'none', caption: '嗒——银槌轻碰骨木' },
    ])
    expect(chapter.board.panels).toEqual([
      { id: 'p1', lines: ['l0'], description: '骨质穹顶下的拍卖厅', camera: 'zoom-in', image: 'assets/images/dome.png' },
      { id: 'p2', lines: ['l2'], description: '拍卖师探头', camera: 'still', begin: 0.5 },
    ])
    // What the models were asked is the author's business.
    expect(JSON.stringify(chapter)).not.toContain('提示词')
    expect(JSON.stringify(chapter)).not.toContain('只给声音模型')
  })

  it('keeps where the book was last read, so that the next device picks it up there', async () => {
    const { project } = bed.runtime
    const { id } = await project.manifest()
    const base = await turnOn()
    // Nobody has left a place yet.
    expect((await (await fetch(`${base}/api/books/${id}`)).json() as { position?: unknown }).position).toBeUndefined()
    const before = project.revision
    // A reader may leave their place whatever else they may do with the book: this one is read-only.
    const left = await fetch(`${base}/api/books/${id}/position`, { method: 'POST', headers: reader, body: JSON.stringify({ chapter: chapterId }) })
    expect(left.status).toBe(200)
    const position = (await left.json() as { position: { chapter: string; at: string; by: string } }).position
    expect(position).toMatchObject({ chapter: chapterId })
    expect(Date.parse(position.at)).toBeGreaterThan(0)
    expect(position.by.length).toBeGreaterThan(0)
    // The next device to open the book is told; and the Studio, which leaves its own place the same way.
    expect((await (await fetch(`${base}/api/books/${id}`)).json() as { position?: unknown }).position).toEqual(position)
    expect(await readPosition(bed.runtime)).toEqual(position)
    expect((await savePosition(bed.runtime, chapterId, 'Studio')).by).toBe('Studio')
    expect((await (await fetch(`${base}/api/books/${id}`)).json() as { position: { by: string } }).position.by).toBe('Studio')
    // It is no change of the book: nothing that watches the book is told of it.
    expect(project.revision).toBe(before)
    // A chapter that is none of the book's, or has nothing to read, is no place to leave.
    const second = (await project.chapterInfos()).find(chapter => !chapter.hasText)!
    for (const chapter of ['ch999', second.id, '../novel', 12, undefined]) {
      expect((await fetch(`${base}/api/books/${id}/position`, { method: 'POST', headers: reader, body: JSON.stringify({ chapter }) })).status, String(chapter)).toBe(404)
    }
    // A place in a chapter that is gone is no place any more.
    await project.removeChapter(chapterId)
    expect(await readPosition(bed.runtime)).toBeUndefined()
  })

  it('serves a chapter\'s finished video and its words — and nothing from the bench it was cut on', async () => {
    const { project } = bed.runtime
    const { id } = await project.manifest()
    const film = await project.writeAsset(`video/${chapterId}.mp4`, new Uint8Array(4096).fill(7))
    const words = await project.writeAsset(`video/${chapterId}.vtt`, new TextEncoder().encode('WEBVTT\n\n00:00.000 --> 00:01.000\n零七。\n'))
    await project.writeAsset(`video/work/${chapterId}/clips/p001.mp4`, new Uint8Array(64))
    await project.writeAsset(`video/work/${chapterId}/cut.sh`, new TextEncoder().encode('ffmpeg …'))
    await project.writeState(['video', `${chapterId}.json`], { schema: 1, chapterId, path: film, duration: 81, width: 1920, height: 1080, size: 4096, createdAt: '2026-01-02T03:04:05.000Z', note: '后期自己的说明', subtitles: { path: words, burned: false } })
    const base = await turnOn()
    const listed = await (await fetch(`${base}/api/books/${id}`)).json() as { chapters: { video?: boolean }[] }
    expect(listed.chapters[0]!.video).toBe(true)
    const chapter = await (await fetch(`${base}/api/books/${id}/chapters/${chapterId}`)).json() as { video?: Record<string, unknown> }
    expect(chapter.video).toEqual({ path: `assets/video/${chapterId}.mp4`, duration: 81, width: 1920, height: 1080, subtitles: `assets/video/${chapterId}.vtt`, version: '2026-01-02T03:04:05.000Z' })
    expect(JSON.stringify(chapter)).not.toContain('后期自己的说明')
    // A player asks for a video a piece at a time.
    const part = await fetch(`${base}/media/${id}/assets/video/${chapterId}.mp4`, { headers: { range: 'bytes=1000-1999' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-type')).toBe('video/mp4')
    expect(part.headers.get('content-range')).toBe('bytes 1000-1999/4096')
    expect((await part.arrayBuffer()).byteLength).toBe(1000)
    const track = await fetch(`${base}/media/${id}/assets/video/${chapterId}.vtt`)
    expect(track.status).toBe(200)
    expect(track.headers.get('content-type')).toContain('text/vtt')
    expect(await track.text()).toContain('零七。')
    // The bench: clips, scripts, whatever lies there — not a reader's business, whatever kind of file it is.
    expect((await fetch(`${base}/media/${id}/assets/video/work/${chapterId}/clips/p001.mp4`)).status).toBe(404)
    expect((await fetch(`${base}/media/${id}/assets/video/work/${chapterId}/cut.sh`)).status).toBe(404)
  })

  it('asks every device for the password of a sealed book once, and remembers the device', async () => {
    const { project } = bed.runtime
    const root = project.root
    await bed.core.sealBook(root, { password: 'open sesame', label: '锁着的书' })
    const base = await turnOn()
    const stub = (await bed.core.lockOf(root))
    expect(stub.sealed).toBe(true)
    const id = (await (await bed.core.runtime(root)).project.manifest()).id
    // Unlocked on the computer or not, a device that never showed the password gets the name and a lock.
    const shelf = await (await fetch(`${base}/api/books`)).json() as { books: Record<string, unknown>[] }
    expect(shelf.books).toEqual([expect.objectContaining({ id, title: '锁着的书', locked: true })])
    expect(JSON.stringify(shelf)).not.toContain('白页遗骸')
    for (const path of [`/api/books/${id}`, `/api/books/${id}/chapters/${chapterId}`, `/media/${id}/assets/images/dome.png`]) {
      const response = await fetch(`${base}${path}`)
      expect(response.status, path).toBe(423)
    }
    const wrong = await fetch(`${base}/api/books/${id}/unlock`, { method: 'POST', headers: reader, body: JSON.stringify({ password: 'open sesam' }) })
    expect(wrong.status).toBe(403)
    expect(wrong.headers.get('set-cookie')).toBeNull()
    const right = await fetch(`${base}/api/books/${id}/unlock`, { method: 'POST', headers: reader, body: JSON.stringify({ password: 'open sesame' }) })
    expect(right.status).toBe(200)
    const cookie = right.headers.get('set-cookie')!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    const held = { cookie: cookie.split(';')[0]! }
    const opened = await (await fetch(`${base}/api/books/${id}`, { headers: held })).json() as { book: { title: string } }
    expect(opened.book.title).toBe('白页遗骸')
    const picture = await fetch(`${base}/media/${id}/assets/images/dome.png`, { headers: held })
    expect(picture.status).toBe(200)
    expect(picture.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await picture.arrayBuffer()).equals(Buffer.from(PIXEL))).toBe(true)
    const part = await fetch(`${base}/media/${id}/assets/audio/${chapterId}/l0-abc.wav`, { headers: { ...held, range: 'bytes=0-43' } })
    expect(part.status).toBe(206)
    expect((await part.arrayBuffer()).byteLength).toBe(44)
    // The author sees the device among the ways the book opens.
    expect((await bed.core.lockOf(root)).ways.map(way => way.kind)).toEqual(['password', 'grant'])
    // The Harness was restarted: the book is locked on the computer. The device's grant opens it again —
    // for devices. At the computer it is as locked as before: a phone does not unlock the author's desk.
    await bed.core.lockBook(root)
    expect((await bed.core.lockOf(root)).locked).toBe(true)
    expect((await fetch(`${base}/api/books/${id}/chapters/${chapterId}`, { headers: held })).status).toBe(200)
    expect((await bed.core.lockOf(root)).locked).toBe(true)
    await expect(bed.core.runtime(root)).rejects.toMatchObject({ code: 'novel/locked' })
    expect(await bed.core.discover(bed.dir)).toEqual([expect.objectContaining({ title: '锁着的书', locked: true })])
    // Unlocked by its author at the computer, it is open there as well.
    await bed.core.unlockBook(root, { password: 'open sesame' })
    expect((await bed.core.lockOf(root)).locked).toBe(false)
    expect(await (await bed.core.runtime(root)).project.chapterText(chapterId)).toContain('肋骨')
    // Another device, without the grant, is still outside.
    expect((await fetch(`${base}/api/books/${id}`)).status).toBe(423)
    // Withdrawn by the author, the grant opens nothing.
    const grant = (await bed.core.lockOf(root)).ways.find(way => way.kind === 'grant')!
    await bed.core.rekeyBook(root, { remove: { kind: 'grant', id: grant.id! } })
    expect((await fetch(`${base}/api/books/${id}`, { headers: held })).status).toBe(423)
    // Guessing is slowed down.
    for (let n = 0; n < 3; n++) expect((await fetch(`${base}/api/books/${id}/unlock`, { method: 'POST', headers: reader, body: JSON.stringify({ password: `guess ${n}` }) })).status).toBe(403)
    const slowed = await fetch(`${base}/api/books/${id}/unlock`, { method: 'POST', headers: reader, body: JSON.stringify({ password: 'open sesame' }) })
    expect(slowed.status).toBe(429)
  })

  it('offers addresses another device can reach', () => {
    const found = addresses()
    expect(found.every(address => !address.startsWith('127.') && !address.startsWith('169.254.'))).toBe(true)
  })
})

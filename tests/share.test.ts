// SPDX-License-Identifier: LGPL-3.0-or-later
/** Reading on another device: what the reader's server hands out, and everything it must not. */
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addresses, ShareServer } from '../src/host/share'
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
    const token = (await bed.core.settings.get()).share!.token!
    expect(token.length).toBeGreaterThanOrEqual(20)
    for (const url of status.urls) expect(url).toContain(`:${port}/${token}/`)
    return `http://127.0.0.1:${port}/${token}`
  }

  it('is closed until it is switched on, and closed again when it is switched off', async () => {
    await share.apply()
    expect(await share.status()).toMatchObject({ enabled: false, running: false, urls: [], books: [] })
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
    // Switched on without a book to share, there is still nothing to serve.
    await bed.core.settings.update({ share: { enabled: true, port, books: [] } })
    await share.apply()
    expect((await share.status()).running).toBe(false)
    const base = await turnOn()
    expect((await fetch(`${base}/api/books`)).status).toBe(200)
    await bed.core.settings.update({ share: { enabled: false } })
    await share.apply()
    expect((await share.status()).running).toBe(false)
    await expect(fetch(`${base}/api/books`)).rejects.toThrow()
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
    for (const path of ['/', '/api/books', `/${token.slice(0, -1)}x/api/books`, `/${token.slice(0, 10)}/api/books`, `/${token}x/api/books`]) {
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

  it('offers addresses another device can reach', () => {
    const found = addresses()
    expect(found.every(address => !address.startsWith('127.') && !address.startsWith('169.254.'))).toBe(true)
  })
})

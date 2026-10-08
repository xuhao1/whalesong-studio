// SPDX-License-Identifier: LGPL-3.0-or-later
/** Sealed books: what lies on disk, how they open, and what a cut-off sealing leaves behind. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectError } from '../src/core/project'
import { newKey, openWithPassword, passwordSlot, readStub, SEALED_SUFFIX, SealedFiles, secretSlot, openWithSecret, VaultError, writeStub } from '../src/core/util/vault'
import { createDeviceAuth } from '../src/host/device-auth'
import { createTestBed, PIXEL, type TestBed } from './support/harness'

async function everyFile(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await everyFile(path))
    else found.push(path)
  }
  return found
}

describe('a sealed store', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('keeps content and names unreadable on disk, and gives both back with the key', async () => {
    const root = join(bed.dir, 'vault')
    const key = newKey()
    const store = new SealedFiles(root, key)
    const chapter = join(root, 'manuscript', 'ch001.md')
    const card = join(root, 'bible', 'characters', '白页-零七.md')
    await store.writeAtomic(chapter, '星灯港的拍卖厅是用一根旧神的肋骨撑起来的。')
    await store.writeAtomic(card, '---\nname: 白页\n---\n')
    await store.writeJson(join(root, 'outline.json'), { volumes: [] })
    await store.writeAtomic(join(root, 'assets', 'images', 'cover.png'), PIXEL)
    // Nothing on disk says what the book is: no name, no word of it.
    const files = await everyFile(root)
    expect(files).toHaveLength(4)
    for (const file of files) {
      expect(file.endsWith(SEALED_SUFFIX)).toBe(true)
      expect(file).not.toContain('白页')
      expect(file).not.toContain('ch001')
      const raw = await readFile(file)
      expect(raw.includes(Buffer.from('拍卖厅'))).toBe(false)
      expect(raw.includes(Buffer.from('白页'))).toBe(false)
    }
    expect(await store.readText(chapter)).toBe('星灯港的拍卖厅是用一根旧神的肋骨撑起来的。')
    expect(await store.readJson(join(root, 'outline.json'))).toEqual({ volumes: [] })
    expect((await store.readBytes(join(root, 'assets', 'images', 'cover.png')))!.equals(Buffer.from(PIXEL))).toBe(true)
    expect(await store.listDir(join(root, 'bible', 'characters'))).toEqual(['白页-零七.md'])
    expect(await store.listDir(root)).toEqual(['assets', 'bible', 'manuscript', 'outline.json'])
    expect(await store.sizeOf(join(root, 'assets', 'images', 'cover.png'))).toBe(PIXEL.length)
    expect(await store.exists(chapter)).toBe(true)
    expect(await store.exists(join(root, 'manuscript'))).toBe(true)
    expect(await store.readText(join(root, 'manuscript', 'ch002.md'))).toBeUndefined()
    // A name on disk leads back to the path it stands for.
    expect(store.logical(relative(root, store.physical(card)))).toBe('bible/characters/白页-零七.md')
    // Another key sees a folder of files it cannot name or open.
    const stranger = new SealedFiles(root, newKey())
    expect(await stranger.listDir(join(root, 'manuscript'))).toEqual([])
    await expect(stranger.readText(chapter)).resolves.toBeUndefined()
    // A file put where another belongs does not open: content is bound to its place.
    await writeFile(store.physical(join(root, 'manuscript', 'ch009.md')), await readFile(store.physical(chapter)))
    await expect(store.readText(join(root, 'manuscript', 'ch009.md'))).rejects.toBeInstanceOf(VaultError)
    await store.removePath(chapter)
    expect(await store.exists(chapter)).toBe(false)
  })

  it('opens with the password or a keeper\'s secret, and with nothing else', async () => {
    const key = newKey()
    const stub = { schema: 1 as const, id: 'novel_x', title: '一本书', sealed: { v: 1 as const, slots: [await passwordSlot('密码 correct horse', key), secretSlot('device', 'mac', Buffer.alloc(32, 7), key, 'this Mac')] } }
    expect((await openWithPassword(stub, '密码 correct horse')).equals(key)).toBe(true)
    await expect(openWithPassword(stub, '密码 correct hors')).rejects.toMatchObject({ code: 'wrong-key' })
    expect(openWithSecret(stub, 'device', 'mac', Buffer.alloc(32, 7)).equals(key)).toBe(true)
    expect(() => openWithSecret(stub, 'device', 'mac', Buffer.alloc(32, 8))).toThrow(VaultError)
    expect(() => openWithSecret(stub, 'grant', 'mac', Buffer.alloc(32, 7))).toThrow(VaultError)
    await expect(passwordSlot('abc', key)).rejects.toMatchObject({ code: 'weak' })
  })
})

describe('a sealed book', () => {
  let bed: TestBed
  beforeEach(async () => {
    bed = await createTestBed({ title: '白页遗骸' })
    const { project } = bed.runtime
    await project.updateManifest({ logline: '一个誓书全白的少女被拍卖。', author: '某人' })
    await project.saveCharacter({ name: '白页', aliases: ['零七'], role: 'protagonist', status: 'active', appearance: '领口内侧绣着编号' })
    const plan = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(plan.id, '星灯港的拍卖厅是用一根旧神的肋骨撑起来的。\n“零七。”\n“在。”')
    await project.saveChapterText(plan.id, '星灯港的拍卖厅是用一根旧神的肋骨撑起来的。\n“零七。”\n“在。”\n白页没有回答。')
    await project.writeAsset('images/cover.png', PIXEL)
  })
  afterEach(async () => { await bed.cleanup() })

  const leaks = async (root: string, words: string[]): Promise<string[]> => {
    const found: string[] = []
    for (const file of await everyFile(root)) {
      const raw = await readFile(file)
      for (const word of words) if (raw.includes(Buffer.from(word)) || file.includes(word)) found.push(`${word} in ${relative(root, file)}`)
    }
    return found
  }

  it('is sealed whole, opens with its password, and is plain again when the seal is taken off', async () => {
    const root = bed.runtime.project.root
    const before = await bed.runtime.project.state()
    const sealed = await bed.core.sealBook(root, { password: 'open sesame', label: '书稿一' })
    expect(sealed.files).toBeGreaterThan(5)
    // On disk: the stub, and nothing else that can be read — not the title, not a name, not a line.
    expect(await leaks(root, ['白页', '拍卖厅', '零七', '肋骨', '某人', '誓书'])).toEqual([])
    const stub = (await readStub(root))!
    expect(stub).toMatchObject({ title: '书稿一', sealed: { v: 1 } })
    expect(stub.sealed.pending).toBeUndefined()
    expect(JSON.stringify(stub)).not.toContain('白页')
    // Still open in this process, and nothing about the book has changed.
    const during = await (await bed.core.runtime(root)).project.state()
    expect(during.manifest).toEqual(before.manifest)
    expect(during.characters.map(card => card.name)).toEqual(['白页'])
    expect(during.chapters.map(chapter => chapter.words)).toEqual(before.chapters.map(chapter => chapter.words))
    expect(await (await bed.core.runtime(root)).project.versions(before.chapters[0]!.id)).toHaveLength(1)
    expect(await bed.core.lockOf(root)).toMatchObject({ sealed: true, locked: false, title: '书稿一', ways: [{ kind: 'password' }] })
    // Locked: no state, no chapter, no picture — only the name on the shelf.
    expect(await bed.core.lockBook(root)).toBe(true)
    await expect(bed.core.runtime(root)).rejects.toMatchObject({ code: 'novel/locked' })
    await expect(bed.core.tryRuntime(root)).rejects.toBeInstanceOf(ProjectError)
    expect(await bed.core.discover(bed.dir)).toEqual([expect.objectContaining({ title: '书稿一', sealed: true, locked: true })])
    expect((await bed.core.discover(bed.dir))[0]!.cover).toBeUndefined()
    await expect(bed.core.unlockBook(root, { password: 'open sesam' })).rejects.toMatchObject({ code: 'wrong-key' })
    await expect(bed.core.runtime(root)).rejects.toMatchObject({ code: 'novel/locked' })
    await bed.core.unlockBook(root, { password: 'open sesame' })
    const opened = await bed.core.runtime(root)
    expect(await opened.project.chapterText(before.chapters[0]!.id)).toContain('白页没有回答。')
    expect((await opened.project.readFile('assets/images/cover.png')).equals(Buffer.from(PIXEL))).toBe(true)
    expect(await bed.core.discover(bed.dir)).toEqual([expect.objectContaining({ title: '白页遗骸', sealed: true })])
    // Writing while sealed stays sealed.
    await opened.project.saveChapterText(before.chapters[0]!.id, '新的一稿，写着海潮。')
    expect(await leaks(root, ['海潮', '白页'])).toEqual([])
    // A new password replaces the old one without touching a file.
    await bed.core.rekeyBook(root, { password: 'new words' })
    await bed.core.lockBook(root)
    await expect(bed.core.unlockBook(root, { password: 'open sesame' })).rejects.toMatchObject({ code: 'wrong-key' })
    await bed.core.unlockBook(root, { password: 'new words' })
    // Unsealed: plain files again, the same book.
    const plain = await bed.core.unsealBook(root)
    expect(plain.left).toBe(0)
    expect(await readStub(root)).toBeUndefined()
    expect((await everyFile(root)).some(file => file.endsWith(SEALED_SUFFIX))).toBe(false)
    const after = await (await bed.core.runtime(root)).project.state()
    expect(after.manifest).toEqual({ ...before.manifest, updatedAt: after.manifest.updatedAt })
    expect(await readFile(join(root, 'manuscript', `${before.chapters[0]!.id}.md`), 'utf8')).toContain('海潮')
    expect(await bed.core.lockOf(root)).toEqual({ sealed: false, locked: false, ways: [] })
  })

  it('finishes a sealing that was cut off the next time the book is unlocked', async () => {
    const root = bed.runtime.project.root
    const id = (await bed.runtime.project.chapters())[0]!.plan.id
    await bed.core.sealBook(root, { password: 'open sesame' })
    await bed.core.lockBook(root)
    // As if the power went while files were being sealed: one lies plain, and the stub says work was under way.
    await writeFile(join(root, 'manuscript', 'stray.md'), '落在外面的一章。')
    const stub = (await readStub(root))!
    await writeStub(root, { ...stub, sealed: { ...stub.sealed, pending: true } })
    await bed.core.unlockBook(root, { password: 'open sesame' })
    expect((await readStub(root))!.sealed.pending).toBeUndefined()
    expect(await leaks(root, ['落在外面'])).toEqual([])
    const store = (await bed.core.runtime(root)).project.files
    expect(await store.readText(join(root, 'manuscript', 'stray.md'))).toBe('落在外面的一章。')
    expect(await (await bed.core.runtime(root)).project.chapterText(id)).toContain('白页没有回答。')
  })

  it('goes to the trash sealed, without being unlocked', async () => {
    const root = bed.runtime.project.root
    await bed.core.sealBook(root, { password: 'open sesame', label: '锁着的书' })
    await bed.core.lockBook(root)
    const removed = await bed.core.removeBook(root, false)
    expect(removed.title).toBe('锁着的书')
    expect(removed.where).toBe('trash')
    expect(removed.path.startsWith(join(bed.dir, 'trash'))).toBe(true)
    expect(await bed.core.discover(bed.dir)).toEqual([])
    // What lies in the trash is as sealed as it was on the shelf.
    expect(await leaks(removed.path, ['白页', '拍卖厅'])).toEqual([])
  })
})

describe('the computer\'s own unlock', () => {
  // Only what needs no person: whether the owner can be asked at all. The prompt itself is never shown by a test.
  it('is asked of the system through the script host it comes with — nothing of the plugin\'s is compiled for it', async () => {
    const device = createDeviceAuth()
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      // No way to ask is known here: a sealed book opens with its password.
      expect(device).toBeUndefined()
      return
    }
    if (process.platform !== 'darwin') return
    const info = await device!.info()
    expect(typeof info.host).toBe('string')
    expect(['touch-id', 'password', 'none']).toContain(info.method)
    expect(info.available).toBe(info.method !== 'none')
    expect(info.biometrics).toBe(info.method === 'touch-id')
  }, 20_000)
})

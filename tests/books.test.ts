// SPDX-License-Identifier: LGPL-3.0-or-later
/** The bookshelf: a book's cover, and taking a book away without destroying anything. */
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NovelCore } from '../src/core/core'
import { namedKeySource } from '../src/core/media/http'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/settings'
import { SessionStateStore } from '../src/core/session-state'
import { UsageStore } from '../src/core/usage'
import { exists } from '../src/core/util/fs'
import { moveToTrash } from '../src/core/util/trash'
import { FakeLlm, PIXEL } from './support/harness'

describe('the bookshelf', () => {
  let dir: string
  let core: NovelCore
  let trash: string
  let holding: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'novel-books-'))
    trash = join(dir, 'trash')
    holding = join(dir, 'holding')
    await mkdir(trash)
    core = new NovelCore({
      llm: new FakeLlm(),
      credentials: namedKeySource(() => undefined),
      settings: new SettingsStore({ ...DEFAULT_SETTINGS }, join(dir, 'settings.json')),
      usage: new UsageStore(join(dir, 'usage')),
      trash: { files: trash },
      holding,
    })
    await core.ready()
  })
  afterEach(async () => {
    core.dispose()
    await core.usage.settled().catch(() => {})
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  it('shows the cover the author chose, else the latest one drawn', async () => {
    const workspace = join(dir, 'ws')
    const { project } = await core.create(join(workspace, '灯塔来信'), { title: '灯塔来信', language: 'zh' })
    expect(await project.cover()).toBeUndefined()
    expect((await core.discover(workspace))[0]).toMatchObject({ title: '灯塔来信', id: (await project.manifest()).id })
    const first = await project.writeAsset('images/cover.png', PIXEL)
    await project.addIllustration({ id: 'i1', path: first, prompt: 'p', kind: 'cover', createdAt: new Date().toISOString() })
    const scene = await project.writeAsset('images/scene.png', PIXEL)
    await project.addIllustration({ id: 'i2', path: scene, prompt: 'p', kind: 'scene', createdAt: new Date().toISOString() })
    expect((await project.state()).cover).toBe(first)
    expect((await core.discover(workspace))[0]!.cover).toBe(first)
    // Any picture can be made the cover; one that is gone is not a cover.
    await project.updateManifest({ cover: scene })
    expect(await project.cover()).toBe(scene)
    await project.updateManifest({ cover: 'assets/images/nothing.png' })
    expect(await project.cover()).toBe(first)
  })

  it('moves a removed book to the trash whole, and its folder with it when nothing else is there', async () => {
    const workspace = join(dir, 'ws')
    const root = join(workspace, '白页遗骸')
    const { project } = await core.create(root, { title: '白页遗骸', language: 'zh' })
    const chapter = await project.addChapter({ title: '拍卖厅' })
    await project.saveChapterText(chapter.id, '星灯港的拍卖厅是用一根旧神的肋骨撑起来的。')
    await project.writeAsset('images/cover.png', PIXEL)
    const removed = await core.removeBook(root, false)
    expect(removed).toMatchObject({ title: '白页遗骸', where: 'trash', left: [], folderRemoved: true })
    expect(removed.path.startsWith(trash)).toBe(true)
    expect(await exists(root)).toBe(false)
    expect(await core.discover(workspace)).toEqual([])
    expect(await core.tryRuntime(root)).toBeUndefined()
    // Everything is there, as it was.
    expect((await readdir(removed.path)).sort()).toEqual(['.novel', 'assets', 'bible', 'manuscript', 'novel.json', 'outline.json'])
    expect(await readFile(join(removed.path, 'manuscript', `${chapter.id}.md`), 'utf8')).toContain('旧神的肋骨')
    // Putting it back is all it takes to have the book again.
    await mkdir(root)
    for (const entry of await readdir(removed.path)) await rename(join(removed.path, entry), join(root, entry))
    const back = await core.tryRuntime(root)
    expect((await back!.project.manifest()).title).toBe('白页遗骸')
    expect(await back!.project.chapterText(chapter.id)).toContain('旧神的肋骨')
  })

  it('leaves alone whatever in the folder is not the book, and the folder of a workspace', async () => {
    const root = join(dir, 'ws-is-the-book')
    await core.create(root, { title: '七日未寄', language: 'zh' })
    await writeFile(join(root, 'notes.txt'), 'mine')
    await mkdir(join(root, 'research'))
    const removed = await core.removeBook(root, false)
    expect(removed.where).toBe('trash')
    expect(removed.left.sort()).toEqual(['notes.txt', 'research'])
    expect(removed.folderRemoved).toBe(false)
    expect((await readdir(root)).sort()).toEqual(['notes.txt', 'research'])
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('mine')
    // A workspace folder stays even when the book was all it held.
    const workspace = join(dir, 'empty-workspace')
    await core.create(workspace, { title: '只有一本', language: 'zh' })
    const second = await core.removeBook(workspace, true)
    expect(second.folderRemoved).toBe(false)
    expect(await readdir(workspace)).toEqual([])
    await expect(core.removeBook(workspace, true)).rejects.toThrow(/no novel project/)
  })

  it('uses a holding folder when the trash cannot take the book, and never erases it', async () => {
    const root = join(dir, 'ws', 'book')
    await core.create(root, { title: '无处可去', language: 'zh' })
    await rm(trash, { recursive: true })
    // A file where the trash should be: nothing can be moved into it.
    await writeFile(trash, 'not a folder')
    const removed = await core.removeBook(root, false)
    expect(removed.where).toBe('holding')
    expect(removed.path.startsWith(holding)).toBe(true)
    expect((await readdir(removed.path)).includes('novel.json')).toBe(true)
    // Names never collide: a second folder of the same name gets its own.
    const again = join(dir, 'again')
    await mkdir(join(again, 'same name'), { recursive: true })
    await mkdir(join(holding, 'same name'), { recursive: true })
    const moved = await moveToTrash(join(again, 'same name'), { holding, trash: null })
    expect(moved).toEqual({ where: 'holding', path: join(holding, 'same name 2') })
  })

  it('takes every session off a book that is gone', async () => {
    const sessions = new SessionStateStore(join(dir, 'sessions.json'))
    await sessions.update('s1', { project: '/books/a' })
    await sessions.update('s1', { project: '/books/b' })
    await sessions.update('s2', { project: '/books/b' })
    await sessions.update('s3', { project: '/books/c' })
    const touched: string[] = []
    sessions.onChange((id) => { touched.push(id) })
    await sessions.forget('/books/b')
    expect((await sessions.get('s1')).project).toBeUndefined()
    expect((await sessions.get('s1')).books).toEqual(['/books/a'])
    expect((await sessions.get('s2')).project).toBeUndefined()
    expect((await sessions.get('s3')).project).toBe('/books/c')
    expect(touched.sort()).toEqual(['s1', 's2'])
    // A session that had moved off the book no longer remembers coming from it.
    await sessions.update('s4', { project: '/books/d' })
    await sessions.update('s4', { project: '/books/e' })
    expect((await sessions.get('s4')).switched?.from).toBe('/books/d')
    await sessions.forget('/books/d')
    expect((await sessions.get('s4')).switched).toBeUndefined()
    expect((await sessions.get('s4')).project).toBe('/books/e')
  })
})

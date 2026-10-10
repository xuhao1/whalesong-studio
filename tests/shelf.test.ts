// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readStub } from '../src/core/util/vault'
import { createTestBed, PIXEL, type TestBed } from './support/harness'

describe('the private shelf', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ title: '白页遗骸' }) })
  afterEach(async () => { await bed.cleanup() })

  it('hides its books until its password is given, opens them with it, and leaves alone a book that keeps a password of its own', async () => {
    const { core } = bed
    const root = bed.runtime.project.root
    const chapter = await bed.runtime.project.addChapter({ title: '第一章' })
    await bed.runtime.project.saveChapterText(chapter.id, '雨停了。')
    await bed.runtime.project.updateManifest({ cover: await bed.runtime.project.writeAsset('images/cover.png', PIXEL) })
    const second = (await core.create(join(bed.dir, 'second'), { title: '另一本', language: 'zh' })).project.root
    const third = (await core.create(join(bed.dir, 'third'), { title: '普通的书', language: 'zh' })).project.root
    const titles = async (): Promise<string[]> => (await core.discover(bed.dir)).map(book => `${book.title}${book.private === true ? '·私' : ''}${book.own === true ? '·自' : ''}${book.locked === true ? '·锁' : ''}`).sort()

    // No shelf: nothing can be put on one, and a password too short makes none.
    expect(await core.shelfState()).toEqual({ set: false, open: false, devices: [] })
    await expect(core.shelveBook(root)).rejects.toThrow(/open the private shelf/)
    await expect(core.setupShelf('abc')).rejects.toThrow(/four/)
    await core.setupShelf('shelf pass')
    expect(await core.shelfState()).toMatchObject({ set: true, open: true, devices: [] })

    // A plain book goes under the shelf's key; another under a password of its own.
    expect((await core.shelveBook(root)).files).toBeGreaterThan(1)
    await core.shelveBook(second, { own: 'own pass' })
    expect(await titles()).toEqual(['另一本·私·自', '普通的书', '白页遗骸·私'])
    // On the shelf it has no cover: no sealed book has one there.
    expect((await core.discover(bed.dir)).find(book => book.root === root)!.cover).toBeUndefined()
    expect((await core.lockOf(root)).shelf).toEqual({ own: false })

    // Closed: its books are locked, off the list, and not so much as named.
    await core.closeShelf()
    expect(await core.shelfState()).toMatchObject({ set: true, open: false })
    expect(await titles()).toEqual(['普通的书'])
    expect(await core.lockOf(root)).toMatchObject({ sealed: true, locked: true, title: '' })
    await expect(core.runtime(root)).rejects.toThrow()

    // The wrong password opens nothing; the right one the shelf and the books it holds the key of.
    await expect(core.openShelf('not it')).rejects.toThrow(/not the password/)
    await core.openShelf('shelf pass')
    expect(await titles()).toEqual(['另一本·私·自·锁', '普通的书', '白页遗骸·私'])
    expect(await (await core.runtime(root)).project.chapterText(chapter.id)).toBe('雨停了。')
    // The book that keeps to its own password: the shelf's does not open it, its own does.
    await expect(core.unlockBook(second, { password: 'shelf pass' })).rejects.toThrow(/not the password/)
    await core.unlockBook(second, { password: 'own pass' })
    expect(await titles()).toEqual(['另一本·私·自', '普通的书', '白页遗骸·私'])

    // The shelf's password opens a book of it by itself — wherever the book is taken, whatever became of the shelf.
    await core.closeShelf()
    await core.unlockBook(root, { password: 'shelf pass' })
    expect(await (await core.runtime(root)).project.chapterText(chapter.id)).toBe('雨停了。')
    await core.lockBook(root)

    // Another password for the shelf: the old one is nothing, the books carry the new.
    await core.rekeyShelf('shelf pass', 'new shelf pass', await core.shelved([bed.dir]))
    await core.closeShelf()
    await expect(core.openShelf('shelf pass')).rejects.toThrow(/not the password/)
    await expect(core.unlockBook(root, { password: 'shelf pass' })).rejects.toThrow(/not the password/)
    await core.unlockBook(root, { password: 'new shelf pass' })
    await core.lockBook(root)

    // The shelf's own file lost: set up again with its password, it is the same shelf and its books are on it.
    await rm(join(bed.dir, 'private-shelf.json'))
    expect(await core.shelfState()).toEqual({ set: false, open: false, devices: [] })
    await core.setupShelf('new shelf pass', await core.shelved([bed.dir]))
    expect(await titles()).toEqual(['另一本·私·自·锁', '普通的书', '白页遗骸·私'])

    // Taken off the shelf: among the others again, still sealed — by a password it is given, since the shelf's key was all it had.
    await expect(core.unshelveBook(root)).rejects.toThrow(/password of its own/)
    await core.unshelveBook(root, 'its own now')
    expect((await readStub(root))!.sealed.shelf).toBeUndefined()
    await core.closeShelf()
    await core.lockBook(root)
    expect(await titles()).toEqual(['普通的书', '白页遗骸·锁'])
    await expect(core.unlockBook(root, { password: 'new shelf pass' })).rejects.toThrow(/not the password/)
    await core.unlockBook(root, { password: 'its own now' })

    // A sealed book put on the shelf keeps its seal and its password, and opens with the shelf besides.
    await core.openShelf('new shelf pass')
    expect((await core.shelveBook(root)).files).toBe(0)
    await core.closeShelf()
    expect(await titles()).toEqual(['普通的书'])
    await core.openShelf('new shelf pass')
    expect(await titles()).toEqual(['另一本·私·自·锁', '普通的书', '白页遗骸·私'])
    // Stepping away closes everything a password opened.
    await core.lockAll()
    expect(await core.shelfState()).toMatchObject({ set: true, open: false })
    expect(third).toContain('third')
  })

  it('opens the way a sealed book does: by a secret this computer keeps, once it was let in — and by its password as before', async () => {
    const { core } = bed
    const root = bed.runtime.project.root
    await core.setupShelf('shelf pass')
    await core.shelveBook(root)
    // This computer's own unlock: a secret its credential store would keep, wrapped around the shelf's key.
    const secret = randomBytes(32)
    await core.shelfWay({ add: core.slotFor('device', 'host:here', secret, 'here') })
    expect((await core.shelfState()).devices).toEqual(['host:here'])

    await core.closeShelf()
    expect((await core.discover(bed.dir)).map(book => book.title)).toEqual([])
    // Another secret is not let in; neither is the right one under another keeper's name.
    await expect(core.openShelfWith('device', 'host:here', randomBytes(32))).rejects.toThrow(/does not open that way/)
    await expect(core.openShelfWith('device', 'host:elsewhere', secret)).rejects.toThrow(/does not open that way/)
    expect((await core.shelfState()).open).toBe(false)
    await core.openShelfWith('device', 'host:here', secret)
    expect((await core.shelfState()).open).toBe(true)
    // Open that way, the shelf shows and opens its books as it does when opened by its password.
    expect((await core.discover(bed.dir)).map(book => [book.title, book.locked === true])).toEqual([['白页遗骸', false]])
    expect((await core.lockOf(root)).locked).toBe(false)

    // Another password keeps this way in (the key is the same); taking the way out closes it for good.
    await core.rekeyShelf('shelf pass', 'another pass')
    await core.closeShelf()
    await core.openShelfWith('device', 'host:here', secret)
    await core.shelfWay({ remove: { kind: 'device', id: 'host:here' } })
    await core.closeShelf()
    await expect(core.openShelfWith('device', 'host:here', secret)).rejects.toThrow(/does not open that way/)
    await core.openShelf('another pass')
    expect((await core.shelfState()).open).toBe(true)
    // Adding a way in needs the shelf open: it wraps the shelf's key.
    await core.closeShelf()
    await expect(core.shelfWay({ add: core.slotFor('device', 'host:here', secret) })).rejects.toThrow(/open the private shelf/)
  })
})

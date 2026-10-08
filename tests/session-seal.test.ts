// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionBooks, SessionStateStore } from '../src/core/session-state'
import { exists } from '../src/core/util/fs'
import { dropOpen, dropSeal, newDrop, newKey, readStub, VaultError } from '../src/core/util/vault'
import { SessionSeal } from '../src/host/session-seal'
import { createTestBed, type TestBed } from './support/harness'

const PASSWORD = 'correct horse battery'

describe('a book\'s drop', () => {
  it('takes what is sealed to it without the book\'s key, and gives it up only to that key', () => {
    const key = newKey()
    const drop = newDrop(key)
    const plain = Buffer.from('对话记录：第三章里她烧掉了那封信。'.repeat(200))
    const sealed = dropSeal(drop.publicKey, plain)
    // Nothing of what was sealed can be read from what is on disk, and no two sealings are alike.
    expect(sealed.includes(Buffer.from('烧掉'))).toBe(false)
    expect(dropSeal(drop.publicKey, plain).equals(sealed)).toBe(false)
    expect(dropOpen(drop, key, sealed).equals(plain)).toBe(true)
    // Another book's key does not open it; a piece that was changed does not open at all.
    expect(() => dropOpen(drop, newKey(), sealed)).toThrow(VaultError)
    const changed = Buffer.from(sealed)
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    expect(() => dropOpen(drop, key, changed)).toThrow('does not open')
    expect(() => dropOpen(newDrop(key), key, sealed)).toThrow(VaultError)
  })
})

describe('conversations of a sealed book', () => {
  let bed: TestBed
  let home: string
  let before: string | undefined
  let owned: Set<string>
  let headers: { id: string; cwd: string; origin?: 'subagent'; agentPreset?: string; parentSession?: string }[]
  let seal: SessionSeal
  /** The DSH the sealer is given, and what waits for DSH's services to come up. */
  let ctx: Record<string, unknown>
  let up: (() => void)[]
  let states: SessionStateStore
  let books: SessionBooks
  // As DSH lays it out: a folder named after the session, in a folder named after the directory it was started in.
  const dirOf = (slug: string, id: string): string => join(home, 'sessions', slug, id)
  const logOf = (slug: string, id: string): string => join(dirOf(slug, id), 'session.v4.jsonl.zstd')
  const put = async (slug: string, id: string, text: string): Promise<void> => {
    await mkdir(dirOf(slug, id), { recursive: true })
    await writeFile(logOf(slug, id), text)
    await writeFile(join(dirOf(slug, id), 'session.lock'), '')
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), JSON.stringify({ title: text.slice(0, 12) }))
  }

  beforeEach(async () => {
    bed = await createTestBed()
    home = join(bed.dir, 'dsh-home')
    before = process.env.DSH_HOME
    process.env.DSH_HOME = home
    owned = new Set()
    headers = []
    states = new SessionStateStore(join(home, 'novel-writer', 'sessions.json'))
    books = new SessionBooks(join(home, 'novel-writer', 'session-books.json'))
    const slugOf = new Map<string, string>()
    const persistence = {
      async list() { return headers.map(header => ({ header })) },
      async open(id: string) {
        if (owned.has(id)) throw Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' })
        const slugs = await readdir(join(home, 'sessions')).catch(() => [] as string[])
        const found = (await Promise.all(slugs.map(slug => exists(dirOf(slug, id))))).some(Boolean)
        if (!found) throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' })
        return { async flush() {}, async close() {} }
      },
    }
    ctx = { get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined), on: () => () => {}, effect: (make: () => unknown) => { make() }, inject: (_names: string[], apply: () => void) => { up.push(apply) } }
    up = []
    seal = new SessionSeal(ctx as never, { core: bed.core, sessions: states, sessionBooks: books, log: () => {} } as never)
    const root = bed.runtime.project.root
    // The showrunner's conversation, in the folder the book lies in; a role's run, in the book's own folder; and somebody else's.
    headers.push({ id: 'session-showrunner', cwd: dirname(root), agentPreset: 'novelist' }, { id: 'crew-run', cwd: root, origin: 'subagent' }, { id: 'elsewhere', cwd: '/somewhere/else', agentPreset: 'novelist' }, { id: 'other-preset', cwd: dirname(root), agentPreset: 'coder' })
    slugOf.set('session-showrunner', '--work--').set('crew-run', '--work-book--').set('elsewhere', '--else--').set('other-preset', '--work--')
    for (const header of headers) await put(slugOf.get(header.id)!, header.id, `这是 ${header.id} 的对话记录：第三章里她烧掉了那封信。`)
    await bed.runtime.project.saveChapterText((await bed.runtime.project.addChapter({ title: '信' })).id, '她烧掉了那封信。')
    await bed.core.sealBook(root, { password: PASSWORD })
    seal.start(async () => [])
  })
  afterEach(async () => {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    await bed.cleanup()
  })

  it('go under the seal when the book is locked, and come back as they were when it is unlocked', async () => {
    const root = bed.runtime.project.root
    const stub = (await readStub(root))!
    expect(stub.sealed.drop?.publicKey).toBeTypeOf('string')
    const original = await readFile(logOf('--work--', 'session-showrunner'))
    expect(await seal.status(root)).toEqual({ sealed: 0, open: 2, waiting: 0 })

    await bed.core.lockBook(root)
    await seal.sync(root)
    // The conversations about the book are gone from where DSH keeps them, and so is what DSH worked out from them.
    expect(await exists(dirOf('--work--', 'session-showrunner'))).toBe(false)
    expect(await exists(dirOf('--work-book--', 'crew-run'))).toBe(false)
    expect(await exists(join(home, 'storages', 'session_projcache', 'sessions', 'session-showrunner.json'))).toBe(false)
    // Whatever is not this book's stays where it is.
    expect(await exists(logOf('--else--', 'elsewhere'))).toBe(true)
    expect(await exists(logOf('--work--', 'other-preset'))).toBe(true)
    // What is kept instead says nothing of the book.
    const vault = join(home, 'novel-writer', 'sealed-sessions', stub.id)
    expect((await readdir(vault)).sort()).toEqual(['crew-run.json', 'crew-run.nvd', 'session-showrunner.json', 'session-showrunner.nvd'])
    const kept = Buffer.concat(await Promise.all((await readdir(vault)).map(name => readFile(join(vault, name)))))
    expect(kept.includes(Buffer.from('烧掉'))).toBe(false)
    expect(kept.includes(Buffer.from('session-showrunner 的对话'))).toBe(false)
    expect(await seal.status(root)).toEqual({ sealed: 2, open: 0, waiting: 0 })

    await bed.core.unlockBook(root, { password: PASSWORD })
    await seal.sync(root)
    expect((await readFile(logOf('--work--', 'session-showrunner'))).equals(original)).toBe(true)
    expect(await readFile(logOf('--work-book--', 'crew-run'), 'utf8')).toContain('crew-run 的对话记录')
    expect(await exists(join(dirOf('--work--', 'session-showrunner'), 'session.lock'))).toBe(true)
    expect(await exists(vault)).toBe(false)
    expect(await seal.status(root)).toEqual({ sealed: 0, open: 2, waiting: 0 })
  })

  it('leaves a conversation that is in use where it is, and seals it once it is let go', async () => {
    const root = bed.runtime.project.root
    owned.add('session-showrunner')
    await bed.core.lockBook(root)
    const first = await seal.sync(root)
    expect(first).toEqual({ sealed: 1, open: 1, waiting: 1 })
    expect(await exists(logOf('--work--', 'session-showrunner'))).toBe(true)
    // The book is locked by now: what is sealed from here on is sealed without its key.
    owned.delete('session-showrunner')
    expect(await seal.sync(root)).toEqual({ sealed: 2, open: 0, waiting: 0 })
    expect(await exists(dirOf('--work--', 'session-showrunner'))).toBe(false)
    await bed.core.unlockBook(root, { password: PASSWORD })
    await seal.sync(root)
    expect(await readFile(logOf('--work--', 'session-showrunner'), 'utf8')).toContain('session-showrunner 的对话记录')
  })

  it('never overwrites a log DSH has, and keeps a sealed copy it cannot put back', async () => {
    const root = bed.runtime.project.root
    const stub = (await readStub(root))!
    await bed.core.lockBook(root)
    await seal.sync(root)
    // The same conversation exists again when the book is unlocked: DSH's own is the newer one.
    await put('--work--', 'session-showrunner', '后来的记录')
    const vault = join(home, 'novel-writer', 'sealed-sessions', stub.id)
    // And one sealed copy was damaged on disk.
    const damaged = await readFile(join(vault, 'crew-run.nvd'))
    damaged[damaged.length - 3] = damaged[damaged.length - 3]! ^ 0xff
    await writeFile(join(vault, 'crew-run.nvd'), damaged)
    await bed.core.unlockBook(root, { password: PASSWORD })
    await seal.sync(root)
    expect(await readFile(logOf('--work--', 'session-showrunner'), 'utf8')).toBe('后来的记录')
    // What does not open is not thrown away, and nothing half-written is put in its place.
    expect(await exists(join(vault, 'crew-run.nvd'))).toBe(true)
    expect(await exists(dirOf('--work-book--', 'crew-run'))).toBe(false)
  })

  it('counts a conversation put on the book by name, wherever it was started', async () => {
    const root = bed.runtime.project.root
    headers.push({ id: 'moved-here', cwd: '/somewhere/else', agentPreset: 'novelist' })
    await put('--else--', 'moved-here', '在别处开始、后来切到这本书上的对话')
    await states.update('moved-here', { project: root })
    // …and one in the book's folder that was put on another book is not this book's.
    await states.update('session-showrunner', { project: '/another/book' })
    expect(await seal.status(root)).toEqual({ sealed: 0, open: 2, waiting: 0 })
    await bed.core.lockBook(root)
    await seal.sync(root)
    expect(await exists(dirOf('--else--', 'moved-here'))).toBe(false)
    expect(await exists(dirOf('--work--', 'session-showrunner'))).toBe(true)
  })

  it('takes the runs of the roles and the conversation a tool reached the book from, wherever DSH filed them', async () => {
    const root = bed.runtime.project.root
    // A conversation on another book, in another folder, whose showrunner read this book for one call; a role's run under it, filed where its parent is; and that run's own child.
    headers.push(
      { id: 'session-visitor', cwd: '/somewhere/else', agentPreset: 'novelist' },
      { id: 'role-run', cwd: '/somewhere/else', origin: 'subagent', agentPreset: 'novelist', parentSession: 'session-visitor' },
      { id: 'helper', cwd: '/somewhere/else', origin: 'subagent', parentSession: 'role-run' },
      { id: 'stranger', cwd: '/somewhere/else', origin: 'subagent', parentSession: 'elsewhere' },
    )
    for (const id of ['session-visitor', 'role-run', 'helper', 'stranger']) await put('--else--', id, `${id}：这里面有那本书的正文。`)
    expect((await seal.status(root)).open).toBe(2)
    // The Studio notes it as it happens: the run worked on this book.
    await books.touch('role-run', root)
    expect((await seal.status(root)).open).toBe(4)
    // And the tool call that reached the book puts the whole conversation, with everything under it, among the book's.
    await books.touch('session-visitor', root)
    await bed.core.lockBook(root)
    await seal.sync(root)
    for (const id of ['session-visitor', 'role-run', 'helper']) expect(await exists(dirOf('--else--', id))).toBe(false)
    expect(await exists(dirOf('--else--', 'stranger'))).toBe(true)
    expect(await exists(dirOf('--else--', 'elsewhere'))).toBe(true)
    await bed.core.unlockBook(root, { password: PASSWORD })
    await seal.sync(root)
    for (const id of ['session-visitor', 'role-run', 'helper']) expect(await readFile(logOf('--else--', id), 'utf8')).toContain('那本书的正文')
  })

  it('takes what was left in the open when DSH starts — once DSH can say what it has', async () => {
    const root = bed.runtime.project.root
    await bed.core.lockBook(root)
    await seal.sync(root)
    expect(await seal.status(root)).toEqual({ sealed: 2, open: 0, waiting: 0 })
    // The book was opened, a role worked on it, and DSH quit with the book's key in memory only: locked again, its log in the open.
    await put('--work-book--', 'crew-run-2', '这是后来的一次运行：她又写了一封信。')
    headers.push({ id: 'crew-run-2', cwd: root, origin: 'subagent' })
    const later = new SessionSeal(ctx as never, { core: bed.core, sessions: states, sessionBooks: books, log: () => {} } as never)
    up = []
    later.start(async () => [root])
    // Nothing is asked of DSH before its session store and its workspaces are there.
    expect(up).toHaveLength(1)
    await new Promise(done => setTimeout(done, 20))
    expect(await exists(dirOf('--work-book--', 'crew-run-2'))).toBe(true)
    up[0]!()
    await expect.poll(async () => await exists(dirOf('--work-book--', 'crew-run-2'))).toBe(false)
    await expect.poll(async () => (await later.status(root)).sealed).toBe(3)
    // And it comes back with the others when the book is opened.
    await bed.core.unlockBook(root, { password: PASSWORD })
    await later.sync(root)
    expect(await readFile(logOf('--work-book--', 'crew-run-2'), 'utf8')).toContain('她又写了一封信')
  })
})

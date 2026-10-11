// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Project } from '../src/core/project'
import { createTestBed, type TestBed } from './support/harness'

describe('project store', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('a core that was taken down opens no book again — whatever of it is still on its way leaves no watcher behind', async () => {
    const { project } = bed.runtime
    const root = project.root
    const chapter = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(chapter.id, '夜雨敲窗。')
    // The Host half is replaced: its core goes down, and a request it was still answering asks for the book.
    bed.core.dispose()
    await expect(bed.core.tryRuntime(root)).rejects.toMatchObject({ code: 'novel/replaced' })
    await expect(bed.core.runtime(root)).rejects.toMatchObject({ code: 'novel/replaced' })
    await expect(bed.core.create(join(bed.dir, 'another'), { title: '另一本', language: 'zh' })).rejects.toMatchObject({ code: 'novel/replaced' })
    // The half that took its place writes the book: nothing of the old one is there to take that for a change from outside.
    const next = await createTestBed()
    try {
      const again = (await next.core.runtime(root)).project
      const before = (await again.activity()).length
      await again.saveChapterText(chapter.id, '夜雨敲窗。沈璃推开旧居的门。')
      await new Promise(resolve => setTimeout(resolve, 500))
      expect((await again.activity()).filter(entry => entry.by === 'outside')).toHaveLength(0)
      expect((await again.activity()).length).toBe(before)
    } finally {
      await next.cleanup()
    }
  })

  it('creates the directory layout with a manifest, an outline and a default style', async () => {
    const { project } = bed.runtime
    const manifest = await project.manifest()
    expect(manifest.title).toBe('测试之书')
    expect(manifest.language).toBe('zh')
    expect((await project.outline()).volumes).toHaveLength(1)
    expect((await project.activeStyle())?.id).toBe('default')
    expect(await Project.open(bed.dir)).toBeUndefined()
    await expect(Project.create(project.root, { title: 'again' })).rejects.toThrow(/already exists/)
  })

  it('stores characters as Markdown with front matter and merges patches', async () => {
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈璃', role: 'protagonist', personality: '倔强', notes: '自幼习剑。' })
    expect(card.id).toBe('沈璃')
    const file = await readFile(join(project.root, 'bible/characters/沈璃.md'), 'utf8')
    expect(file).toContain('name: 沈璃')
    expect(file).toContain('自幼习剑。')
    const updated = await project.saveCharacter({ id: card.id, personality: '', aliases: ['阿璃'], age: '21' })
    expect(updated.personality).toBeUndefined()
    expect(updated.role).toBe('protagonist')
    expect((await project.findCharacter('阿璃'))?.id).toBe('沈璃')
    // A second character with the same name gets a distinct id only when created without a match.
    const other = await project.saveCharacter({ name: '沈 璃' })
    expect(other.id).toBe('沈璃')
    expect(await project.deleteCharacter('阿璃')).toBe(true)
    expect(await project.characters()).toHaveLength(0)
  })

  it('keeps no word on a card for where its character stands in the book: one left by an older version is not read, and not written again', async () => {
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '阿棠', role: 'supporting', personality: '爱笑' })
    const path = join(project.root, 'bible/characters/阿棠.md')
    // A card as older versions wrote it, with the label in its front matter.
    await writeFile(path, (await readFile(path, 'utf8')).replace('role: supporting', 'role: supporting\nstatus: dead'))
    expect(await readFile(path, 'utf8')).toContain('status: dead')
    const fresh = await Project.open(project.root)
    const read = (await fresh!.findCharacter(card.id))!
    expect(read).toMatchObject({ name: '阿棠', role: 'supporting', personality: '爱笑' })
    expect(read as unknown as Record<string, unknown>).not.toHaveProperty('status')
    // Whoever still sends one — a page not reloaded yet, a suggestion made before — is not refused: it is left out.
    const saved = await fresh!.saveCharacter({ id: card.id, age: '19', status: 'active' } as never)
    expect(saved as unknown as Record<string, unknown>).not.toHaveProperty('status')
    expect(await readFile(path, 'utf8')).not.toContain('status:')
    expect(await readFile(path, 'utf8')).toContain('age:')
  })

  it('picks up cards edited by hand', async () => {
    const { project } = bed.runtime
    await project.saveWorld({ name: '青冥山', category: 'location', summary: '北境群山' })
    const path = join(project.root, 'bible/world/青冥山.md')
    await new Promise(resolve => setTimeout(resolve, 15))
    await writeFile(path, '---\nname: 青冥山\ncategory: location\nimportance: 1\nsummary: 终年积雪\n---\n\n山巅有一座废弃的剑阁。\n')
    const entry = await project.findWorld('青冥山')
    expect(entry?.importance).toBe(1)
    expect(entry?.summary).toBe('终年积雪')
    expect(entry?.body).toContain('剑阁')
  })

  it('numbers chapters, resolves references and moves chapters', async () => {
    const { project } = bed.runtime
    const first = await project.addChapter({ title: '雨夜', synopsis: '她回到旧居。' })
    const second = await project.addChapter({ title: '旧剑' })
    const third = await project.addChapter({ title: '来客' })
    expect([first.id, second.id, third.id]).toEqual(['ch001', 'ch002', 'ch003'])
    expect(first.status).toBe('outlined')
    expect(second.status).toBe('idea')
    expect((await project.findChapter('第2章'))?.plan.id).toBe('ch002')
    expect((await project.findChapter('chapter 3'))?.plan.id).toBe('ch003')
    expect((await project.findChapter(1))?.plan.id).toBe('ch001')
    expect((await project.findChapter('latest'))?.plan.id).toBe('ch003')
    expect((await project.findChapter('旧剑'))?.index).toBe(2)
    await project.moveChapter('ch003', { before: 'ch001' })
    expect((await project.chapters()).map(chapter => chapter.plan.id)).toEqual(['ch003', 'ch001', 'ch002'])
    // Ids are never reused, even after a removal.
    await project.removeChapter('ch002')
    expect((await project.addChapter({ title: '新章' })).id).toBe('ch004')
  })

  it('snapshots text before overwriting and restores versions', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(plan.id, '初稿。')
    expect((await project.findChapter(plan.id))?.plan.status).toBe('drafted')
    await project.saveChapterText(plan.id, '二稿，更长一些。', { reason: 'before-revise' })
    const versions = await project.versions(plan.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]!.reason).toBe('before-revise')
    expect(await project.versionText(plan.id, versions[0]!.id)).toBe('初稿。')
    expect(await project.restoreVersion(plan.id, versions[0]!.id)).toBe(true)
    expect(await project.chapterText(plan.id)).toBe('初稿。')
    expect(await project.versions(plan.id)).toHaveLength(2)
    const infos = await project.chapterInfos()
    expect(infos[0]).toMatchObject({ words: 2, hasText: true, digested: false })
  })

  it('keeps a removed chapter — plan, place and text — and puts it back where it stood', async () => {
    const { project } = bed.runtime
    const first = await project.addChapter({ title: '起' })
    const second = await project.addChapter({ title: '承', synopsis: '她没有接那张剪报。', characters: ['shen'] })
    const third = await project.addChapter({ title: '转' })
    await project.saveChapterText(second.id, '门缝里塞进一张湿剪报。\n\n沈蘅没有接。')
    await project.saveMemory({ schema: 1, chapterId: second.id, textHash: 'x', updatedAt: new Date().toISOString(), brief: '剪报', summary: '剪报塞进门缝。', facts: [], characters: [], newEntities: [], threads: [] })

    expect(await project.removeChapter(second.id)).toBe(true)
    expect((await project.chapters()).map(chapter => chapter.plan.id)).toEqual([first.id, third.id])
    const [record] = await project.removedChapters()
    expect(record).toMatchObject({ plan: { id: second.id, title: '承', synopsis: '她没有接那张剪报。' }, after: first.id, index: 2, words: 15 })
    expect(record!.version).toBeDefined()
    expect((await project.state()).removed).toHaveLength(1)
    // Its number is not given to another chapter: what was made from it still lies under that number.
    const fourth = await project.addChapter({ title: '合' })
    expect(fourth.id).not.toBe(second.id)

    const back = await project.restoreChapter(second.id)
    expect(back.index).toBe(2)
    expect((await project.chapters()).map(chapter => chapter.plan.title)).toEqual(['起', '承', '转', '合'])
    expect(await project.chapterText(second.id)).toBe('门缝里塞进一张湿剪报。\n\n沈蘅没有接。')
    expect((await project.findChapter(second.id))?.plan).toMatchObject({ synopsis: '她没有接那张剪报。', characters: ['shen'], status: 'drafted' })
    // What was made from it was never taken away.
    expect((await project.memory(second.id))?.brief).toBe('剪报')
    expect(await project.removedChapters()).toEqual([])
    expect((await project.state()).removed).toBeUndefined()
    await expect(project.restoreChapter(second.id)).rejects.toThrow(/no removed chapter/)

    // The chapter it came after is gone too: it goes to the end of its volume. The first of a volume goes back to the front.
    await project.removeChapter(third.id)
    await project.removeChapter(second.id)
    await project.removeChapter(first.id)
    expect((await project.restoreChapter(third.id)).index).toBe(2)
    expect((await project.restoreChapter(first.id)).index).toBe(1)
    expect((await project.chapters()).map(chapter => chapter.plan.title)).toEqual(['起', '合', '转'])
  })

  it('counts what there is to read, hear and watch — for the shelf, with the first chapter of each', async () => {
    const { project } = bed.runtime
    expect(await project.shows()).toEqual({})
    for (const title of ['雨夜', '旧剑', '来客']) await project.addChapter({ title })
    await project.saveChapterText('ch002', '她把剑放回匣中。')
    await project.saveChapterText('ch003', '门外有人敲了三下。')
    expect(await project.shows()).toEqual({ read: { chapters: 2, first: 'ch002' } })
    const now = new Date().toISOString()
    // A script nobody has spoken a line of is not something to hear yet; a board with nothing drawn nothing to watch.
    await project.saveAudioScript({ schema: 1, chapterId: 'ch002', textHash: 'x', updatedAt: now, lines: [{ id: 'l1', kind: 'narration', text: '她把剑放回匣中。' }], cues: [] } as never)
    await project.saveComicBoard({ schema: 1, chapterId: 'ch002', textHash: 'x', updatedAt: now, style: '', panels: [{ id: 'p1', prompt: '匣中的剑' }] } as never)
    expect(await project.shows()).toEqual({ read: { chapters: 2, first: 'ch002' } })
    await project.saveAudioScript({ schema: 1, chapterId: 'ch003', textHash: 'x', updatedAt: now, lines: [{ id: 'l1', kind: 'narration', text: '门外有人敲了三下。', audio: 'assets/audio/ch003/l1.wav' }], cues: [] } as never)
    await project.saveComicBoard({ schema: 1, chapterId: 'ch003', textHash: 'x', updatedAt: now, style: '', panels: [{ id: 'p1', prompt: '门', image: 'assets/images/p1.png' }] } as never)
    // A video counts as something to watch where its file is there, and only there.
    await project.writeState(['video', 'ch002.json'], { chapterId: 'ch002', path: 'assets/video/ch002.mp4', duration: 10, createdAt: now })
    expect(await project.shows()).toEqual({ read: { chapters: 2, first: 'ch002' }, listen: { chapters: 1, first: 'ch003' }, watch: { chapters: 1, first: 'ch003' } })
    await project.writeAsset('video/ch002.mp4', new Uint8Array([0, 1, 2]))
    expect((await project.shows()).watch).toEqual({ chapters: 2, first: 'ch002' })
    // What belongs to a chapter that is gone is not on offer.
    await project.removeChapter('ch003')
    expect(await project.shows()).toEqual({ read: { chapters: 1, first: 'ch002' }, watch: { chapters: 1, first: 'ch002' } })
  })

  it('bumps the revision on every write and refuses paths outside the project', async () => {
    const { project } = bed.runtime
    const before = project.revision
    await project.updateManifest({ logline: '一把剑与一场雨。' })
    expect(project.revision).toBeGreaterThan(before)
    expect(() => project.path('../outside.txt')).toThrow(/escapes/)
    expect(() => project.path('/etc/passwd')).toThrow(/escapes/)
  })

  it('reopens from disk with everything intact', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: '沈璃', role: 'protagonist' })
    const plan = await project.addChapter({ title: '雨夜' })
    await project.saveChapterText(plan.id, '夜雨敲窗。')
    await project.saveThread({ title: '断剑的来历', kind: 'mystery' })
    const reopened = await Project.open(project.root)
    expect(reopened).toBeDefined()
    const state = await reopened!.state()
    expect(state.stats).toMatchObject({ words: 4, chapters: 1, characters: 1, openThreads: 1 })
    reopened!.dispose()
  })
})

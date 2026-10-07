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

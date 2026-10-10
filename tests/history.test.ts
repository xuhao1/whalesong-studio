// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changedBy } from '../src/core/cause'
import { changedFields, sayValue } from '../src/shared/history'
import { whyLabel } from '../src/client/labels'
import { createTestBed, PIXEL, type TestBed } from './support/harness'

describe('the history of a card, an entry, a plan, the book', () => {
  let bed: TestBed
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'))
    bed = await createTestBed()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await bed.cleanup()
  })
  /** Time goes on: two versions made in one millisecond would bear one name. */
  const later = (minutes: number): void => { vi.setSystemTime(Date.now() + minutes * 60_000) }

  it('keeps a card as it was when what it says is changed — not for a picture, not for nothing, and the author\'s own saves once a sitting', async () => {
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', tagline: '替人写信的女校书', appearance: '清瘦', notes: '第一稿的备注' })
    // A card just made has no earlier self.
    expect(await project.history('character', card.id)).toEqual([])
    later(1)
    await project.saveCharacter({ id: card.id, tagline: '替别人写爱，替自己留白' })
    const first = await project.history('character', card.id)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: 'character', of: card.id, why: 'edit', at: '2026-10-10T08:01:00.000Z' })
    expect(await project.historyOf('character', card.id, first[0]!.id)).toMatchObject({ id: card.id, name: '沈蘅', tagline: '替人写信的女校书', appearance: '清瘦', notes: '第一稿的备注' })
    // Saved again a minute on, by the same hand: the version before the sitting is the one kept.
    later(1)
    await project.saveCharacter({ id: card.id, tagline: '替别人写爱' })
    expect(await project.history('character', card.id)).toHaveLength(1)
    // A picture is no change to what the card says: nothing is kept for it. Nor for a save that changes nothing.
    later(10)
    const portrait = await project.writeAsset('images/portrait-a.png', PIXEL)
    await project.saveCharacter({ id: card.id, visual: { portrait } })
    await project.saveCharacter({ id: card.id, tagline: '替别人写爱' })
    expect(await project.history('character', card.id)).toHaveLength(1)
    // The sitting is over: the next change by hand is kept again.
    await project.saveCharacter({ id: card.id, appearance: '清瘦，低髻' })
    expect((await project.history('character', card.id)).map(version => version.why)).toEqual(['edit', 'edit'])
    // Whatever else changes it is kept every time, under what changed it: the showrunner, a job of the Studio.
    later(1)
    await changedBy('agent', async () => { await project.saveCharacter({ id: card.id, personality: '克制' }) })
    later(1)
    await changedBy('job-derive visual', async () => { await project.saveCharacter({ id: card.id, visual: { prompt: 'slender woman, low bun' } }) })
    const all = await project.history('character', card.id)
    expect(all.map(version => version.why)).toEqual(['job-derive-visual', 'agent', 'edit', 'edit'])
    // Each is the card as it was until then: the one the job changed has no anchor yet, and has the showrunner's word.
    expect(await project.historyOf('character', card.id, all[0]!.id)).toMatchObject({ personality: '克制', appearance: '清瘦，低髻' })
    expect((await project.historyOf('character', card.id, all[0]!.id))!.visual).toEqual({ portrait })
    expect(await project.historyOf('character', card.id, 'no-such-version')).toBeUndefined()
    expect(await project.history('character', '../outline')).toEqual([])
    // What the showrunner made of it is kept when the author changes it straight after: their sitting began before it.
    later(1)
    await project.saveCharacter({ id: card.id, tagline: '第一句' })
    later(1)
    await changedBy('agent', async () => { await project.saveCharacter({ id: card.id, tagline: '总编的一句' }) })
    later(1)
    await project.saveCharacter({ id: card.id, tagline: '作者又改' })
    const last = await project.history('character', card.id)
    expect(last.slice(0, 3).map(version => version.why)).toEqual(['edit', 'agent', 'edit'])
    expect((await project.historyOf('character', card.id, last[0]!.id))!.tagline).toBe('总编的一句')
    // Where they first and last appear is the digests' to keep, and no change of the card.
    later(10)
    const chapter = await project.addChapter({ title: '渡口' })
    await changedBy('job-digest', async () => { await project.saveCharacter({ id: card.id, firstAppearance: chapter.id, lastAppearance: chapter.id }) })
    expect(await project.history('character', card.id)).toHaveLength(last.length)
    // …and a version put back leaves it where it is.
    await project.restoreHistory('character', card.id, last.at(-1)!.id)
    expect(await project.findCharacter(card.id)).toMatchObject({ tagline: '替人写信的女校书', firstAppearance: chapter.id, lastAppearance: chapter.id, visual: { portrait } })
  })

  it('says in which fields a version and the thing as it is now differ', () => {
    const was = { id: 'a', name: '沈蘅', role: 'protagonist', tagline: '甲', aliases: ['阿蘅'], visual: { prompt: 'one', portrait: 'p1.png', looks: [{ id: 'l1', name: '丧服', sheet: 's1.png' }] }, firstAppearance: 'ch001', updatedAt: '2026-10-10T08:00:00.000Z' }
    const now = { id: 'a', name: '沈蘅', role: 'protagonist', tagline: '乙', aliases: ['阿蘅'], motivation: '', visual: { prompt: 'two', portrait: 'p2.png', looks: [{ id: 'l1', name: '丧服', sheet: 's2.png' }] }, firstAppearance: 'ch002', updatedAt: '2026-10-10T09:00:00.000Z' }
    // Not the pictures, not what the Studio keeps by itself, not when it was touched, not a field left empty.
    expect(changedFields('character', was, now)).toEqual([{ path: 'tagline', was: '甲', now: '乙' }, { path: 'visual.prompt', was: 'one', now: 'two' }])
    expect(changedFields('character', was, was)).toEqual([])
    // A thing that is gone differs in everything its version says.
    expect(changedFields('character', was, undefined).map(field => field.path).sort()).toEqual(['aliases', 'name', 'role', 'tagline', 'visual.looks', 'visual.prompt'])
    // A plan does not differ by where its chapter stands; a list is one field.
    expect(changedFields('plan', { id: 'c', title: '渡口', status: 'outlined', beats: [{ id: 'b1', summary: '到渡口' }] }, { id: 'c', title: '渡口', status: 'drafted', beats: [{ id: 'b1', summary: '到渡口' }, { id: 'b2', summary: '船走了' }] }).map(field => field.path)).toEqual(['beats'])
    expect(sayValue(['甲', '乙'])).toBe('甲\n乙')
    expect(sayValue([{ id: 'b1', summary: '到渡口', characters: ['沈蘅', '阿棠'] }, { id: 'b2', summary: '船走了' }], key => (key === 'summary' ? '梗概' : key))).toBe('梗概: 到渡口\ncharacters: 沈蘅 / 阿棠\n\n梗概: 船走了')
    expect(sayValue(undefined)).toBe('')
  })

  it('says what a version was kept before, in the author\'s words', async () => {
    const { project } = bed.runtime
    const zh = (text: string): string => text
    const card = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', tagline: '甲' })
    later(1)
    // A job is on record under the title its pipeline gave it — as much of it as a file name keeps.
    await changedBy('job-visual anchor 沈蘅', async () => { await project.saveCharacter({ id: card.id, visual: { prompt: 'slender woman' } }) })
    later(1)
    await changedBy('job-what-if', async () => { await project.saveCharacter({ id: card.id, tagline: '乙' }) })
    later(1)
    await changedBy('job-自定义的一件事', async () => { await project.saveCharacter({ id: card.id, tagline: '丙' }) })
    const whys = (await project.history('character', card.id)).map(version => version.why)
    expect(whys).toEqual(['job', 'job-what-if', 'job-visual-anchor'])
    expect(whys.map(why => whyLabel(why, zh))).toEqual(['一项任务修改之前', '"推演"如果""修改之前', '"提炼视觉锚点"修改之前'])
    expect(['edit', 'agent', 'restore', 'removed', 'job-sift-cast'].map(why => whyLabel(why, zh))).toEqual(['你修改之前', '总编修改之前', '恢复旧版本之前', '删除之前', '"筛新名字"修改之前'])
    expect(whyLabel('job-no-such-job', zh)).toBe('"no such job"修改之前')
  })

  it('puts a version back — all of it or the fields named — leaves the pictures as they are now, and keeps what it replaced', async () => {
    const { project } = bed.runtime
    const [first, second, sheet] = [await project.writeAsset('images/p1.png', PIXEL), await project.writeAsset('images/p2.png', PIXEL), await project.writeAsset('images/s1.png', PIXEL)]
    const card = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', tagline: '甲', appearance: '清瘦', visual: { prompt: 'anchor one', portrait: first } })
    later(1)
    await changedBy('agent', async () => { await project.saveCharacter({ id: card.id, tagline: '乙', appearance: '高挑', motivation: '后来加的', visual: { prompt: 'anchor two' } }) })
    later(1)
    await project.saveCharacter({ id: card.id, visual: { portrait: second, sheet } })
    const old = (await project.history('character', card.id)).at(-1)!
    // One field: the tagline as it was; everything else as it is.
    later(1)
    await project.restoreHistory('character', card.id, old.id, ['tagline'])
    expect(await project.findCharacter(card.id)).toMatchObject({ tagline: '甲', appearance: '高挑', motivation: '后来加的', visual: { prompt: 'anchor two', portrait: second, sheet } })
    // A field inside another: the anchor alone.
    later(1)
    await project.restoreHistory('character', card.id, old.id, ['visual.prompt'])
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ prompt: 'anchor one', portrait: second, portraits: [second, first], sheet })
    // The whole of it: what it did not have then is gone — and the pictures are those of now.
    later(1)
    await project.restoreHistory('character', card.id, old.id)
    const back = (await project.findCharacter(card.id))!
    expect(back).toMatchObject({ name: '沈蘅', tagline: '甲', appearance: '清瘦', visual: { prompt: 'anchor one', portrait: second, sheet } })
    expect(back.motivation).toBeUndefined()
    // What each restore replaced is itself a version, so that putting back can be undone.
    const after = await project.history('character', card.id)
    expect(after.filter(version => version.why === 'restore')).toHaveLength(3)
    expect(await project.historyOf('character', card.id, after[0]!.id)).toMatchObject({ tagline: '甲', appearance: '高挑', motivation: '后来加的' })
    await expect(project.restoreHistory('character', card.id, 'no-such-version')).rejects.toThrow(/no version/)
  })

  it('keeps an entry of the bible, a style, a chapter\'s plan, a thread and what the book says of itself the same way', async () => {
    const { project } = bed.runtime
    // An entry: its text is kept, the picture of a turn of its course is not what a version is about.
    const art = await project.writeAsset('images/yard.png', PIXEL)
    const chapter = await project.addChapter({ title: '渡口', synopsis: '她到了渡口' })
    const yard = await project.saveWorld({ name: '大观园', category: 'location', importance: 2, summary: '省亲别墅', events: [{ chapter: chapter.id, kind: 'begin', what: '起造' }] })
    later(1)
    await changedBy('agent', async () => { await project.saveWorld({ id: yard.id, summary: '元妃省亲时所建的园子' }) })
    await project.saveWorld({ id: yard.id, visualImage: art, events: [{ chapter: chapter.id, kind: 'begin', what: '起造', image: art }] })
    const entries = await project.history('world', yard.id)
    expect(entries.map(version => version.why)).toEqual(['agent'])
    later(1)
    await project.restoreHistory('world', yard.id, entries[0]!.id)
    expect(await project.findWorld(yard.id)).toMatchObject({ summary: '省亲别墅', visualImage: art, events: [{ chapter: chapter.id, kind: 'begin', what: '起造', image: art }] })
    // A plan: what it says, not where the chapter stands — writing the chapter is no change of plan.
    later(10)
    await project.updateChapter(chapter.id, { synopsis: '她到了渡口，船已经走了', location: '渡口' })
    await project.saveChapterText(chapter.id, '雨停的时候，她到了渡口。')
    const plans = await project.history('plan', chapter.id)
    expect(plans).toHaveLength(1)
    expect(await project.historyOf('plan', chapter.id, plans[0]!.id)).toMatchObject({ id: chapter.id, title: '渡口', synopsis: '她到了渡口' })
    const drafted = (await project.findChapter(chapter.id))!.plan.status
    later(10)
    await project.restoreHistory('plan', chapter.id, plans[0]!.id)
    const plan = (await project.findChapter(chapter.id))!.plan
    expect(plan).toMatchObject({ synopsis: '她到了渡口', status: drafted })
    expect(plan.location).toBeUndefined()
    expect(await project.history('plan', chapter.id)).toHaveLength(2)
    // The book: its own words, not its cover.
    later(10)
    await project.updateManifest({ logline: '一封寄不出去的信' })
    later(10)
    await project.updateManifest({ logline: '七天之内，信会自己回来', artStyle: '水墨淡彩' })
    await project.updateManifest({ cover: art })
    const books = await project.history('book', 'novel')
    expect(books).toHaveLength(2)
    expect((await project.historyOf('book', 'novel', books[0]!.id))!.logline).toBe('一封寄不出去的信')
    later(10)
    await project.restoreHistory('book', 'novel', books[0]!.id)
    const manifest = await project.manifest()
    expect(manifest).toMatchObject({ logline: '一封寄不出去的信', cover: art })
    expect(manifest.artStyle).toBeUndefined()
    // One field of it only.
    later(10)
    await project.updateManifest({ logline: '第三种说法', premise: '新的故事核' })
    later(10)
    await project.restoreHistory('book', 'novel', (await project.history('book', 'novel'))[0]!.id, ['logline'])
    expect(await project.manifest()).toMatchObject({ logline: '一封寄不出去的信', premise: '新的故事核' })
  })

  it('keeps a volume, a line of the plot, the table of ties, a chapter\'s script and its storyboard the same way', async () => {
    const { project } = bed.runtime
    const [one, two, three] = [await project.addChapter({ title: '一' }), await project.addChapter({ title: '二' }), await project.addChapter({ title: '三' })]
    const volume = (await project.outline()).volumes[0]!
    // A volume: what it is called and says, and the order of its chapters — not what its chapters' plans say.
    later(10)
    await project.updateOutline((draft) => { draft.volumes[0]!.title = '上卷'; draft.volumes[0]!.synopsis = '她还在等' })
    later(10)
    await project.updateChapter(one.id, { synopsis: '只改了一章的章纲' })
    later(10)
    await project.moveChapter(three.id, { before: one.id })
    const volumes = await project.history('volume', volume.id)
    expect(volumes).toHaveLength(2)
    expect(await project.historyOf('volume', volume.id, volumes[0]!.id)).toMatchObject({ title: '上卷', chapters: [one.id, two.id, three.id] })
    expect(changedFields('volume', (await project.historyOf('volume', volume.id, volumes[0]!.id))!, await project.current('volume', volume.id)).map(field => field.path)).toEqual(['chapters'])
    later(10)
    await project.restoreHistory('volume', volume.id, volumes[0]!.id)
    expect((await project.outline()).volumes[0]!.chapters.map(plan => plan.id)).toEqual([one.id, two.id, three.id])
    // Its words alone, from the version before: the order stays as it is.
    later(10)
    await project.restoreHistory('volume', volume.id, volumes[1]!.id, ['title', 'synopsis'])
    const back = (await project.outline()).volumes[0]!
    expect(back.title).toBe(volume.title)
    expect(back.synopsis).toBeUndefined()
    expect(back.chapters.find(plan => plan.id === one.id)?.synopsis).toBe('只改了一章的章纲')

    // A line beside the main one: where it leaves, what it is called.
    later(10)
    const line = await project.addLine({ title: '她把信寄了', from: two.id, choice: '当晚就寄' })
    const own = await project.addChapter({ title: '第四封' }, { line: line.id })
    later(10)
    await project.updateLine(line.id, { title: '寄出去的那条线', from: one.id })
    const lines = await project.history('line', line.id)
    // A chapter that came to it kept nothing: only what it says of itself did.
    expect(lines).toHaveLength(1)
    later(10)
    await project.restoreHistory('line', line.id, lines[0]!.id)
    expect((await project.outline()).lines![0]).toMatchObject({ title: '她把信寄了', from: two.id, chapters: [{ id: own.id }] })

    // The table of ties, whole: one history, and what is put back holds on to nothing that is gone.
    const who = await project.saveCharacter({ name: '沈蘅' })
    const shop = await project.saveWorld({ name: '断肠斋', category: 'location', importance: 2 })
    const box = await project.saveWorld({ name: '七封匣', category: 'item', importance: 2 })
    later(10)
    await project.saveTie({ kind: 'resides', from: { type: 'character', id: who.id }, to: { type: 'world', id: shop.id } })
    later(10)
    await project.saveTie({ kind: 'holds', from: { type: 'character', id: who.id }, to: { type: 'world', id: box.id } })
    later(10)
    const held = (await project.ties()).find(tie => tie.kind === 'holds')!
    await project.removeTie(held.id)
    await project.deleteWorld(box.id)
    const tables = await project.history('ties', 'all')
    expect(tables).toHaveLength(3)
    expect(((await project.historyOf('ties', 'all', tables[0]!.id))!.relations as unknown[])).toHaveLength(2)
    later(10)
    await project.restoreHistory('ties', 'all', tables[0]!.id)
    expect((await project.ties()).map(tie => tie.kind)).toEqual(['resides'])

    // A script: who says what — a take spoken for a line is no change of it, and stays with the line it was spoken for.
    const script = { schema: 1 as const, chapterId: one.id, textHash: 'a', updatedAt: new Date().toISOString(), cues: [], lines: [{ id: 'l0', kind: 'narration' as const, text: '雨停了。' }, { id: 'l1', kind: 'dialogue' as const, speakerName: '沈蘅', text: '进来。' }] }
    await project.saveAudioScript(script)
    later(10)
    await project.saveAudioScript({ ...script, textHash: 'b', lines: script.lines.map(line => ({ ...line, audio: `assets/audio/${line.id}.wav`, duration: 2 })) })
    expect(await project.history('script', one.id)).toHaveLength(0)
    later(10)
    await changedBy('job-audio script', async () => { await project.saveAudioScript({ ...script, lines: [{ id: 'l0', kind: 'narration', text: '雨停了。', audio: 'assets/audio/l0.wav' }, { id: 'l9', kind: 'dialogue', speakerName: '沈蘅', text: '请进。' }] }) })
    const scripts = await project.history('script', one.id)
    expect(scripts.map(version => version.why)).toEqual(['job-audio-script'])
    later(10)
    await project.restoreHistory('script', one.id, scripts[0]!.id)
    expect((await project.audioScript(one.id))!.lines).toMatchObject([{ id: 'l0', text: '雨停了。', audio: 'assets/audio/l0.wav' }, { id: 'l1', text: '进来。', audio: 'assets/audio/l1.wav' }])
    // Taken away, it is had back from its history.
    later(10)
    await project.removeAudioScript(one.id)
    expect((await project.history('script', one.id))[0]!.why).toBe('removed')
    expect(await project.current('script', one.id)).toBeUndefined()
    later(10)
    await project.restoreHistory('script', one.id, (await project.history('script', one.id))[0]!.id)
    expect((await project.audioScript(one.id))!.lines).toHaveLength(2)

    // A storyboard: what its panels show; a panel drawn keeps nothing, and its picture stays when the panel's words are put back.
    const art = await project.writeAsset('images/panel.png', PIXEL)
    const board = { schema: 1 as const, chapterId: one.id, textHash: 'a', updatedAt: new Date().toISOString(), style: '水墨', panels: [{ id: 'p0', lines: ['l0'], description: '雨后的铺子', prompt: '雨后的铺子，门半开', camera: 'still' as const }] }
    await project.saveComicBoard(board)
    later(10)
    await project.patchComicPanels(one.id, new Map([['p0', { image: art }]]))
    expect(await project.history('board', one.id)).toHaveLength(0)
    later(10)
    await project.patchComicPanels(one.id, new Map([['p0', { prompt: '雪夜的铺子' }]]))
    const boards = await project.history('board', one.id)
    expect(boards).toHaveLength(1)
    later(10)
    await project.restoreHistory('board', one.id, boards[0]!.id)
    expect((await project.comicBoard(one.id))!.panels[0]).toMatchObject({ prompt: '雨后的铺子，门半开', image: art })
  })

  it('has a card that was deleted back as it last was', async () => {
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '阿棠', role: 'supporting', tagline: '送信的姑娘' })
    const entry = await project.saveWorld({ name: '断肠斋', category: 'location', importance: 1, summary: '法租界的旧书铺' })
    expect(await project.removedCards()).toEqual([])
    later(1)
    await project.deleteCharacter(card.id)
    later(1)
    await project.deleteWorld(entry.id)
    const removed = await project.removedCards()
    expect(removed.map(item => `${item.kind}:${item.name}`)).toEqual(['world:断肠斋', 'character:阿棠'])
    later(1)
    await project.restoreHistory('character', card.id, removed[1]!.version)
    expect(await project.findCharacter(card.id)).toMatchObject({ name: '阿棠', tagline: '送信的姑娘', role: 'supporting' })
    expect((await project.removedCards()).map(item => item.name)).toEqual(['断肠斋'])
    // What is gone can be thrown away for good — and only what is gone.
    await expect(project.forgetRemoved('character', card.id)).rejects.toThrow(/in the book/)
    await project.forgetRemoved('world', entry.id)
    expect(await project.removedCards()).toEqual([])
    expect(await project.history('world', entry.id)).toEqual([])
  })
})

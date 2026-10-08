// SPDX-License-Identifier: LGPL-3.0-or-later
/** The people and the world of a book as a reader is given them: what goes out, what stays with the author, and how it is cut at a chapter. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishSite } from '../src/core/pipelines/site'
import { bookAnswer, listSides, readAlbum, readSide, ReaderRefused } from '../src/core/reader'
import { albumCounts, cutAlbum, entryImageAt, entryStateAt, standingAt, worldFront, type AlbumEntry } from '../src/shared/album'
import { layoutSpots, SCENE_BAND, SCENE_SPOTS } from '../src/shared/scene'
import type { Tie } from '../src/shared/ties'
import { hashText, proseOnly } from '../src/shared/text'
import { withTurnPictures, type ChapterMemory, type CharacterMoment } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

describe('the album of a book', () => {
  let bed: TestBed
  let ids: { baoyu: string; qingwen: string; later: string; garden: string; court: string; house: string; jade: string; rule: string; planned: string }
  beforeEach(async () => {
    bed = await createTestBed()
    const { project } = bed.runtime
    for (const title of ['入府', '游园', '抱屈', '还没写的一章']) await project.addChapter({ title })
    await project.saveChapterText('ch001', '宝玉在贾家住着。通灵宝玉挂在他颈上。')
    await project.saveChapterText('ch002', '大观园落成，宝玉搬进怡红院，晴雯跟了去。')
    await project.saveChapterText('ch003', '晴雯被撵出大观园，当夜死了。')
    const portrait = await project.writeAsset('images/baoyu.png', new Uint8Array([1]))
    const sheet = await project.writeAsset('images/baoyu-sheet.png', new Uint8Array([2]))
    const look = await project.writeAsset('images/baoyu-look.png', new Uint8Array([3]))
    // A picture named in the book's own language, as generated ones are.
    const picture = await project.writeAsset('images/place-大观园.png', new Uint8Array([4]))
    const baoyu = await project.saveCharacter({
      name: '贾宝玉', aliases: ['宝二爷'], role: 'protagonist', tagline: '荣国府的公子', appearance: '面若中秋之月', personality: '痴', background: '衔玉而生',
      motivation: '不想读书', flaw: '软弱', arc: '终将出家', secrets: '梦游太虚', voice: '半文半白', notes: '作者备注', life: '他在第一章登场。',
      visual: { prompt: 'a boy in red', negative: 'no beard', portrait, sheet, looks: [{ id: 'l1', name: '雀金裘', prompt: 'a cloak of peacock gold', sheet: look }, { id: 'l2', name: '还没画的', prompt: 'x' }] },
      voiceProfile: { voice: 'Serena' } as never,
    })
    const qingwen = await project.saveCharacter({ name: '晴雯', role: 'supporting', relationships: [{ target: baoyu.id, kind: '主仆' }, { target: '多浑虫', kind: '表兄' }] })
    const later = await project.saveCharacter({ name: '甄宝玉', role: 'minor', tagline: '还没写到的人' })
    await project.saveCharacter({ id: baoyu.id, relationships: [{ target: '晴雯', kind: '主仆', note: '最看重的丫鬟' }, { target: later.id, kind: '镜像' }] })
    const garden = await project.saveWorld({ name: '大观园', category: 'location', summary: '为省亲而建', body: '# 布局\n\n- 怡红院\n- 潇湘馆', visualImage: picture, visualPrompt: 'a walled garden, bird\'s eye' })
    const court = await project.saveWorld({ name: '怡红院', category: 'location' })
    const house = await project.saveWorld({ name: '贾家', category: 'faction' })
    const jade = await project.saveWorld({ name: '通灵宝玉', category: 'item' })
    const rule = await project.saveWorld({ name: '金玉良缘', category: 'rule', summary: '金锁配宝玉的说法' })
    const planned = await project.saveWorld({ name: '太虚幻境', category: 'location', summary: '还没写到的地方' })
    await project.saveTie({ kind: 'within', from: { type: 'world', id: court.id }, to: { type: 'world', id: garden.id }, since: 'ch002', note: '第二章大观园落成' })
    await project.saveTie({ kind: 'member', from: { type: 'character', id: baoyu.id }, to: { type: 'world', id: house.id } })
    await project.saveTie({ kind: 'resides', from: { type: 'character', id: baoyu.id }, to: { type: 'world', id: court.id }, since: 'ch002' })
    await project.saveTie({ kind: 'resides', from: { type: 'character', id: qingwen.id }, to: { type: 'world', id: court.id }, since: 'ch002', until: 'ch003' })
    await project.saveTie({ kind: 'holds', from: { type: 'character', id: baoyu.id }, to: { type: 'world', id: jade.id } })
    await project.saveTie({ kind: 'resides', from: { type: 'character', id: later.id }, to: { type: 'world', id: planned.id }, since: 'ch004' })
    const memory = async (chapterId: string, characters: CharacterMoment[]): Promise<void> => {
      const digest: ChapterMemory = { schema: 1, chapterId, textHash: hashText(proseOnly(await project.chapterText(chapterId))), updatedAt: new Date().toISOString(), brief: '', summary: '', facts: [], characters, newEntities: [], threads: [] }
      await project.saveMemory(digest)
    }
    await memory('ch001', [{ character: baoyu.id, name: '贾宝玉', role: '在府里', lifecycle: 'enter' }])
    await memory('ch002', [{ character: baoyu.id, name: '贾宝玉', role: '搬进怡红院' }, { character: qingwen.id, name: '晴雯', role: '跟去怡红院', lifecycle: 'enter' }])
    await memory('ch003', [{ character: baoyu.id, name: '贾宝玉', stateAfter: '悲恸' }, { character: qingwen.id, name: '晴雯', role: '被撵出去', lifecycle: 'death' }])
    ids = { baoyu: baoyu.id, qingwen: qingwen.id, later: later.id, garden: garden.id, court: court.id, house: house.id, jade: jade.id, rule: rule.id, planned: planned.id }
  })
  afterEach(async () => { await bed.cleanup() })

  it('gives a reader who and what the text has come to — and nothing an author only works with', async () => {
    const album = await readAlbum(bed.runtime)
    // Heaviest part first; somebody with a card and no chapter yet is the author's plan.
    expect(album.people.map(person => person.name)).toEqual(['贾宝玉', '晴雯'])
    const baoyu = album.people[0]!
    expect(baoyu).toMatchObject({ aliases: ['宝二爷'], role: 'protagonist', tagline: '荣国府的公子', appearance: '面若中秋之月', personality: '痴', background: '衔玉而生', life: '他在第一章登场。' })
    expect(baoyu.portrait).toMatch(/^assets\/images\/baoyu/)
    // Looks that were drawn; one that was only described is not a picture.
    expect(baoyu.looks).toEqual([{ name: '雀金裘', sheet: expect.stringMatching(/baoyu-look/) }])
    // Who they are to somebody the text has not come to is not said; a name without a card is given as a name.
    expect(baoyu.relationships).toEqual([{ id: ids.qingwen, name: '晴雯', kind: '主仆', note: '最看重的丫鬟' }])
    expect(album.people[1]!.relationships).toEqual([{ id: ids.baoyu, name: '贾宝玉', kind: '主仆' }, { name: '多浑虫', kind: '表兄' }])
    const text = JSON.stringify(album)
    for (const kept of ['不想读书', '软弱', '终将出家', '梦游太虚', '半文半白', '作者备注', 'a boy in red', 'no beard', 'peacock gold', 'Serena', 'bird\'s eye', '第二章大观园落成', '甄宝玉', '太虚幻境']) expect(text).not.toContain(kept)

    // The world: group by group; an idea is given whether or not the text names it, a place nothing was set in is not.
    expect(album.world.map(entry => `${entry.group}:${entry.name}`)).toEqual(['places:大观园', 'places:怡红院', 'factions:贾家', 'items:通灵宝玉', 'ideas:金玉良缘'])
    expect(album.world[0]).toMatchObject({ summary: '为省亲而建', body: '# 布局\n\n- 怡红院\n- 潇湘馆', image: expect.stringMatching(/place-大观园/), chapters: [2, 3] })
    // Ties between what is shown, without the notes on them.
    expect(album.ties.map(tie => tie.kind).sort()).toEqual(['holds', 'member', 'resides', 'resides', 'within'])
    expect(album.ties.every(tie => tie.note === undefined)).toBe(true)
    // Time is told by the chapters there is text of.
    expect(album.chapters.map(chapter => chapter.index)).toEqual([1, 2, 3])
    expect(Object.keys(album.lives).sort()).toEqual([ids.baoyu, ids.qingwen].sort())
    expect(standingAt(album, ids.qingwen, 1)).toBe('planned')
    expect(standingAt(album, ids.qingwen, 2)).toBe('active')
    expect(standingAt(album, ids.qingwen, 3)).toBe('dead')
    expect(standingAt(album, ids.baoyu, undefined)).toBeUndefined()
    expect(albumCounts(album)).toEqual({ people: 2, places: 2, factions: 1, items: 1, ideas: 1 })
  })

  it('gives the author all of it: also who and what the text has not come to, and the notes on the ties', async () => {
    const album = await readAlbum(bed.runtime, { all: true })
    expect(album.people.map(person => person.name)).toEqual(['贾宝玉', '晴雯', '甄宝玉'])
    expect(album.world.map(entry => entry.name)).toContain('太虚幻境')
    expect(album.ties).toHaveLength(6)
    expect(album.ties.find(tie => tie.kind === 'within')?.note).toBe('第二章大观园落成')
    expect(album.people[0]!.relationships?.map(other => other.name)).toEqual(['晴雯', '甄宝玉'])
    // Still not the working fields of a card: the viewer is the viewer, whoever looks.
    expect(JSON.stringify(album)).not.toContain('梦游太虚')
    expect(standingAt(album, ids.later, 3)).toBe('planned')
  })

  it('is cut at a chapter: nothing of what comes after', async () => {
    const whole = await readAlbum(bed.runtime)
    const first = cutAlbum(whole, 1)
    expect(first.people.map(person => person.name)).toEqual(['贾宝玉'])
    expect(first.people[0]!.relationships).toEqual([])
    // The garden is built in chapter 2: neither it, nor what is in it, nor who lives there is told at chapter 1.
    expect(first.world.map(entry => entry.name)).toEqual(['贾家', '通灵宝玉', '金玉良缘'])
    expect(first.ties.map(tie => tie.kind).sort()).toEqual(['holds', 'member'])
    expect(first.chapters.map(chapter => chapter.index)).toEqual([1])
    expect(first.lives[ids.baoyu]).toMatchObject({ first: 1, last: 1, events: [{ index: 1, kind: 'enter' }] })
    const second = cutAlbum(whole, 2)
    expect(second.people.map(person => person.name)).toEqual(['贾宝玉', '晴雯'])
    // She lives there by chapter 2; that it ends in chapter 3 has not happened yet.
    const stay = second.ties.find(tie => tie.kind === 'resides' && tie.from.id === ids.qingwen)
    expect(stay).toMatchObject({ since: 'ch002' })
    expect(stay?.until).toBeUndefined()
    expect(second.lives[ids.qingwen]?.death).toBeUndefined()
    expect(second.world.find(entry => entry.name === '大观园')?.chapters).toEqual([2])
    // Read whole, it says how it ended.
    expect(whole.ties.find(tie => tie.kind === 'resides' && tie.from.id === ids.qingwen)?.until).toBe('ch003')
    expect(whole.lives[ids.qingwen]?.death).toBe(3)
  })

  it('tells the course of a place: built in one chapter, gone in another — and how it stands at the chapter looked at', async () => {
    const { project } = bed.runtime
    await project.saveWorld({ id: ids.garden, events: [
      { chapter: 'ch003', kind: 'decline', what: '抄检之后一天天冷清' },
      { chapter: 'ch002', kind: 'begin', what: '为省亲建成' },
      { chapter: 'ch004', kind: 'end', what: '还没写到的结局' },
      { chapter: 'nowhere', kind: 'change', what: '不在这条线上的一章' },
    ] })
    const garden = (await readAlbum(bed.runtime)).world.find(entry => entry.id === ids.garden)!
    // In reading order; what happens in a chapter a reader does not have is the author's plan.
    expect(garden.events).toEqual([{ index: 2, chapter: 'ch002', kind: 'begin', what: '为省亲建成' }, { index: 3, chapter: 'ch003', kind: 'decline', what: '抄检之后一天天冷清' }])
    expect([1, 2, 3].map(at => entryStateAt(garden, at))).toEqual(['before', 'there', 'declined'])
    expect(entryStateAt(garden, undefined)).toBe('declined')
    // The author sees the end that is planned, too.
    const whole = (await readAlbum(bed.runtime, { all: true })).world.find(entry => entry.id === ids.garden)!
    expect(whole.events).toHaveLength(3)
    expect(entryStateAt(whole, undefined)).toBe('gone')
    expect(entryStateAt(whole, 4)).toBe('gone')
    // Cut at a chapter, what happens to it later has not happened.
    expect(cutAlbum(await readAlbum(bed.runtime), 2).world.find(entry => entry.id === ids.garden)!.events).toEqual([{ index: 2, chapter: 'ch002', kind: 'begin', what: '为省亲建成' }])
    // An entry whose course says nothing is simply there; a change is no state; rebuilt, it is there again.
    expect(entryStateAt({}, 1)).toBe('there')
    expect(entryStateAt({ events: [{ index: 2, chapter: 'c', kind: 'change', what: '易主' }] }, 5)).toBe('there')
    expect(entryStateAt({ events: [{ index: 1, chapter: 'a', kind: 'end', what: '焚毁' }, { index: 3, chapter: 'c', kind: 'begin', what: '重建' }] }, 2)).toBe('gone')
    expect(entryStateAt({ events: [{ index: 1, chapter: 'a', kind: 'end', what: '焚毁' }, { index: 3, chapter: 'c', kind: 'begin', what: '重建' }] }, 3)).toBe('there')
    // Folded into another entry, its course goes along: once for what both say.
    await project.saveWorld({ id: ids.court, events: [{ chapter: 'ch002', kind: 'begin', what: '同一件事的另一种说法' }, { chapter: 'ch003', kind: 'change', what: '改了匾额' }] })
    const merged = await project.mergeWorld(ids.garden, [ids.court])
    expect(merged.entry.events!.map(event => `${event.chapter}:${event.kind}`).sort()).toEqual(['ch002:begin', 'ch003:change', 'ch003:decline', 'ch004:end', 'nowhere:change'].sort())
  })

  it('shows a place as it is at the chapter looked at, where a turn of its course has a picture of its own', async () => {
    const { project } = bed.runtime
    const usual = (await project.findWorld(ids.garden))!.visualImage!
    const ruin = await project.writeAsset('images/place-大观园-ch003-decline.png', new Uint8Array([5]))
    await project.saveWorld({ id: ids.garden, events: [
      { chapter: 'ch002', kind: 'begin', what: '为省亲建成' },
      { chapter: 'ch003', kind: 'decline', what: '抄检之后一天天冷清', image: ruin },
    ] })
    const album = await readAlbum(bed.runtime)
    const garden = album.world.find(entry => entry.id === ids.garden)!
    expect(garden.events).toEqual([{ index: 2, chapter: 'ch002', kind: 'begin', what: '为省亲建成' }, { index: 3, chapter: 'ch003', kind: 'decline', what: '抄检之后一天天冷清', image: ruin }])
    // Before the turn it is as it usually is; from the turn on, as the turn's picture has it; looked at whenever, its design art.
    expect([1, 2, 3, 9].map(at => entryImageAt(garden, at))).toEqual([usual, usual, ruin, ruin])
    expect(entryImageAt(garden, undefined)).toBe(usual)
    // A later turn without a picture leaves it as it was drawn: in ruins, it stays in ruins when its gate is locked, and when it is gone.
    const fallen: Pick<AlbumEntry, 'image' | 'events'> = { image: 'usual.png', events: [{ index: 2, chapter: 'b', kind: 'decline', what: '', image: 'ruin.png' }, { index: 3, chapter: 'c', kind: 'change', what: '' }, { index: 4, chapter: 'd', kind: 'end', what: '' }, { index: 6, chapter: 'f', kind: 'begin', what: '' }] }
    expect([1, 2, 3, 4, 5].map(at => entryImageAt(fallen, at))).toEqual(['usual.png', 'ruin.png', 'ruin.png', 'ruin.png', 'ruin.png'])
    // Built anew, it is as it usually is again.
    expect(entryImageAt(fallen, 6)).toBe('usual.png')
    // A picture of it coming to be holds until the next thing happens to it: the scaffolding is not there for good.
    const built: Pick<AlbumEntry, 'image' | 'events'> = { image: 'usual.png', events: [{ index: 2, chapter: 'b', kind: 'begin', what: '', image: 'scaffold.png' }, { index: 3, chapter: 'c', kind: 'change', what: '' }] }
    expect([1, 2, 3].map(at => entryImageAt(built, at))).toEqual(['usual.png', 'scaffold.png', 'usual.png'])
    // With no design art, the pictures of its turns are all there is: none before the first, the earliest whenever, and no going back to what was never drawn.
    const bare: Pick<AlbumEntry, 'image' | 'events'> = { events: [{ index: 2, chapter: 'b', kind: 'begin', what: '', image: 'a.png' }, { index: 3, chapter: 'c', kind: 'change', what: '' }, { index: 4, chapter: 'd', kind: 'end', what: '', image: 'z.png' }] }
    expect([1, 2, 3, 4].map(at => entryImageAt(bare, at))).toEqual([undefined, 'a.png', 'a.png', 'z.png'])
    expect(entryImageAt(bare, undefined)).toBe('a.png')
    expect(entryImageAt({}, 3)).toBeUndefined()
    // A course reworded keeps the pictures of the turns it keeps — the same turn by chapter and kind; one given anew is as given.
    expect(withTurnPictures(
      [{ chapter: 'ch003', kind: 'decline', what: '抄检之后人去楼空' }, { chapter: 'ch003', kind: 'change', what: '园门上了锁' }, { chapter: 'ch002', kind: 'begin', what: '落成', image: 'new.png' }],
      [{ chapter: 'ch002', kind: 'begin', what: '为省亲建成', image: 'old.png' }, { chapter: 'ch003', kind: 'decline', what: '一天天冷清', image: ruin }],
    )).toEqual([{ chapter: 'ch003', kind: 'decline', what: '抄检之后人去楼空', image: ruin }, { chapter: 'ch003', kind: 'change', what: '园门上了锁' }, { chapter: 'ch002', kind: 'begin', what: '落成', image: 'new.png' }])
    expect(withTurnPictures([{ chapter: 'ch001', kind: 'begin', what: 'x' }], undefined)).toEqual([{ chapter: 'ch001', kind: 'begin', what: 'x' }])

    const out = await mkdtemp(join(tmpdir(), 'novel-album-turns-'))
    try {
      const id = (await project.manifest()).id
      const reader = new TextEncoder().encode('/* the reader */')
      const names = async (): Promise<string[]> => {
        const record = JSON.parse(await readFile(join(out, 'site.json'), 'utf8')) as { files: Record<string, string> }
        return Object.keys(record.files).filter(path => path.startsWith('media/') && path.includes('place-')).map(path => path.split('/').at(-1)!.replace(/-[0-9a-f]{6,}(?=\.png$)/, '')).sort()
      }
      // A site carries the pictures of the turns it tells of —
      await publishSite(bed.core, bed.runtime, { out, reader })
      expect(await names()).toEqual(['place-大观园-ch003-decline.png', 'place-大观园.png'])
      expect((await readFile(join(out, 'media', id, ...ruin.split('/')))).byteLength).toBe(1)
      // — and of no turn after the last chapter published: that has not happened yet.
      await publishSite(bed.core, bed.runtime, { out, reader, chapters: ['ch001', 'ch002'] })
      expect(await names()).toEqual(['place-大观园.png'])
      expect(await readFile(join(out, 'data', id, 'album.json'), 'utf8')).not.toContain('decline')
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('carries where the author pinned the marks of a scene — of what is shown, and no others', async () => {
    const { project } = bed.runtime
    // What the Studio's `world.pin` saves: one mark at a time, the others kept.
    await project.saveWorld({ id: ids.garden, spots: { [`world:${ids.court}`]: { x: 0.31, y: 0.4 } } })
    await project.saveWorld({ id: ids.garden, spots: { [`character:${ids.qingwen}`]: { x: 0.7, y: 0.22 }, [`character:${ids.later}`]: { x: 0.5, y: 0.5 }, 'world:nowhere': { x: 0.1, y: 0.1 } } })
    const garden = (await readAlbum(bed.runtime)).world.find(entry => entry.id === ids.garden)!
    // A mark of somebody the text has not come to says they will be there: not given to a reader.
    expect(garden.spots).toEqual({ [`world:${ids.court}`]: { x: 0.31, y: 0.4 }, [`character:${ids.qingwen}`]: { x: 0.7, y: 0.22 } })
    expect((await readAlbum(bed.runtime, { all: true })).world.find(entry => entry.id === ids.garden)!.spots).toHaveProperty(`character:${ids.later}`)
    // Cut before she comes on, her mark goes with her.
    expect(cutAlbum(await readAlbum(bed.runtime), 2).world.find(entry => entry.id === ids.garden)!.spots).toHaveProperty(`character:${ids.qingwen}`)
    expect(cutAlbum(await readAlbum(bed.runtime, { all: true }), 2).world.find(entry => entry.id === ids.garden)!.spots).not.toHaveProperty(`character:${ids.later}`)
    // A mark let go: laid out by itself again; all let go: nothing is kept.
    await project.saveWorld({ id: ids.garden, spots: { [`world:${ids.court}`]: null } } as never)
    expect((await project.findWorld(ids.garden))!.spots).not.toHaveProperty(`world:${ids.court}`)
    await project.saveWorld({ id: ids.garden, spots: null } as never)
    expect((await project.findWorld(ids.garden))!.spots).toBeUndefined()
    // A place without a picture has no scene to pin on.
    await project.saveWorld({ id: ids.court, spots: { [`character:${ids.baoyu}`]: { x: 0.5, y: 0.5 } } })
    expect((await readAlbum(bed.runtime)).world.find(entry => entry.id === ids.court)!.spots).toBeUndefined()
  })

  it('lays the marks of a scene out by itself where nobody pinned them: the same every time, clear of the edges and of the name', () => {
    const keys = Array.from({ length: 14 }, (_, index) => `world:place-${index}`)
    const spots = layoutSpots(keys)
    // A picture carries so many marks; the rest are in the lists under it.
    expect(spots).toHaveLength(SCENE_SPOTS)
    expect(layoutSpots(keys)).toEqual(spots)
    for (const spot of spots) {
      expect(spot.pinned).toBe(false)
      expect(spot.x).toBeGreaterThanOrEqual(0.04)
      expect(spot.x).toBeLessThanOrEqual(0.96)
      expect(spot.y).toBeGreaterThanOrEqual(SCENE_BAND.top - 0.04)
      expect(spot.y).toBeLessThanOrEqual(SCENE_BAND.bottom + 0.04)
    }
    // No two on top of each other.
    for (const [index, spot] of spots.entries()) for (const other of spots.slice(index + 1)) expect(Math.hypot(spot.x - other.x, (spot.y - other.y) * 0.6)).toBeGreaterThan(0.06)
    // A pin is kept as it is, and the others close ranks around what is left.
    const pinned = layoutSpots(keys.slice(0, 3), { 'world:place-1': { x: 0.9, y: 0.9 } })
    expect(pinned.find(spot => spot.key === 'world:place-1')).toEqual({ key: 'world:place-1', x: 0.9, y: 0.9, pinned: true })
    expect(pinned.filter(spot => !spot.pinned).map(spot => Math.round(spot.x * 10) / 10)).toEqual([0.3, 0.7])
    expect(layoutSpots(['a'])[0]).toMatchObject({ pinned: false })
    expect(layoutSpots([])).toEqual([])
  })

  it('is answered to other devices, and counted with the book', async () => {
    const book = await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: [], by: 'test' }) as { album?: unknown }
    expect(book.album).toEqual({ people: 2, places: 2, factions: 1, items: 1, ideas: 1 })
    const album = await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['album'], by: 'test' })
    expect(album).toEqual(await readAlbum(bed.runtime))
  })

  it('goes into a published site with its pictures — whole, cut at the last chapter published, or not at all', async () => {
    const out = await mkdtemp(join(tmpdir(), 'novel-album-'))
    try {
      const id = (await bed.runtime.project.manifest()).id
      const reader = new TextEncoder().encode('/* the reader */')
      const whole = await publishSite(bed.core, bed.runtime, { out, reader })
      expect(whole.album).toEqual({ people: 2, places: 2, factions: 1, items: 1, ideas: 1 })
      const written = JSON.parse(await readFile(join(out, 'data', id, 'album.json'), 'utf8'))
      expect(written).toEqual(await readAlbum(bed.runtime))
      const record = JSON.parse(await readFile(join(out, 'site.json'), 'utf8')) as { files: Record<string, string> }
      const media = Object.keys(record.files).filter(path => path.startsWith('media/')).map(path => path.split('/').at(-1)!.replace(/-[0-9a-f]+(?=\.png$)/, ''))
      // Each under its own name: a host decodes an address before it looks for the file, so a name is not written escaped.
      expect(media.sort()).toEqual(['baoyu-look.png', 'baoyu-sheet.png', 'baoyu.png', 'place-大观园.png'])
      const garden = (written as { world: { image?: string }[] }).world[0]!.image!
      expect((await readFile(join(out, 'media', id, ...garden.split('/')))).byteLength).toBe(1)
      expect(JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8')).album).toEqual(whole.album)

      // A book published a part at a time tells nothing of what comes after.
      const part = await publishSite(bed.core, bed.runtime, { out, reader, chapters: ['ch001'] })
      expect(part.album).toEqual({ people: 1, places: 0, factions: 1, items: 1, ideas: 1 })
      const cut = JSON.parse(await readFile(join(out, 'data', id, 'album.json'), 'utf8')) as { people: { name: string }[]; chapters: unknown[] }
      expect(cut.people.map(person => person.name)).toEqual(['贾宝玉'])
      expect(cut.chapters).toHaveLength(1)
      expect(JSON.stringify(cut)).not.toContain('晴雯')

      // Left out when the author says so: no file, no count, and the pictures only it showed are taken away again.
      const bare = await publishSite(bed.core, bed.runtime, { out, reader, album: false })
      expect(bare.album).toBeUndefined()
      expect(JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8')).album).toBeUndefined()
      await expect(readFile(join(out, 'data', id, 'album.json'), 'utf8')).rejects.toThrow()
      const after = JSON.parse(await readFile(join(out, 'site.json'), 'utf8')) as { files: Record<string, string> }
      expect(Object.keys(after.files).filter(path => path.startsWith('media/'))).toEqual([])
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('gives a reader the interludes the author kept as side stories — as they went, and no others', async () => {
    const { project } = bed.runtime
    const now = new Date().toISOString()
    const background = await project.writeAsset('images/bg-夜雨.png', new Uint8Array([6]))
    const voice = await project.writeAsset('audio/play/line1.wav', new Uint8Array([7]))
    const session = (id: string, title: string, outcome: 'open' | 'side-story' | 'discarded' | 'novelized', createdAt: string) => ({
      schema: 1 as const, id, title, createdAt, updatedAt: now, cast: [ids.baoyu, ids.qingwen], player: ids.baoyu, situation: '夜里下着雨。', state: { 好感: 3 },
      turns: [{ id: 't1', narration: '灯下。', lines: [{ speaker: '晴雯', character: ids.qingwen, text: '二爷还不睡？', emotion: 'tease', action: '挑灯', audio: voice }], choices: ['装睡', '答话'], scene: { location: '怡红院', background }, createdAt: now }, { id: 't2', input: { kind: 'say' as const, text: '就睡。' }, lines: [], choices: [], ended: true, createdAt: now }],
      outcome,
    })
    await project.savePlaySession(session('play_kept', '雨夜补裘', 'side-story', '2026-01-02T00:00:00.000Z'))
    await project.savePlaySession(session('play_first', '更早的一场', 'side-story', '2026-01-01T00:00:00.000Z'))
    await project.savePlaySession(session('play_open', '还在玩的', 'open', '2026-01-03T00:00:00.000Z'))
    await project.savePlaySession(session('play_gone', '丢掉的', 'discarded', '2026-01-04T00:00:00.000Z'))
    // The earliest first; only what was kept.
    expect((await listSides(bed.runtime)).map(side => [side.id, side.title, side.turns, side.situation])).toEqual([['play_first', '更早的一场', 2, '夜里下着雨。'], ['play_kept', '雨夜补裘', 2, '夜里下着雨。']])
    const side = (await readSide(bed.runtime, 'play_kept'))!
    expect(side).toMatchObject({ id: 'play_kept', title: '雨夜补裘', situation: '夜里下着雨。' })
    expect(side.turns[0]).toMatchObject({ narration: '灯下。', lines: [{ speaker: '晴雯', text: '二爷还不睡？', action: '挑灯', audio: voice }], scene: { location: '怡红院', background }, choices: [] })
    expect(side.turns[1]).toMatchObject({ input: { kind: 'say', text: '就睡。' }, ended: true })
    // What was of the playing — who the author played, what the director tracked, what could have been chosen — is not of the reading.
    const text = JSON.stringify(side)
    for (const kept of ['好感', '装睡', 'tease', 'player']) expect(text).not.toContain(kept)
    expect(side.turns[0]!.lines[0]).not.toHaveProperty('character')
    expect(await readSide(bed.runtime, 'play_open')).toBeUndefined()
    expect(await readSide(bed.runtime, '../etc')).toBeUndefined()

    // Any reader may read them; playing one is still for a book the author made changeable.
    const book = await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: [], by: 'test' }) as { sides?: number }
    expect(book.sides).toBe(2)
    expect(await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['sides'], by: 'test' })).toEqual({ sides: await listSides(bed.runtime) })
    expect(await bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['sides', 'play_kept'], by: 'test' })).toEqual({ play: side })
    await expect(bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['sides', 'play_open'], by: 'test' })).rejects.toBeInstanceOf(ReaderRefused)
    await expect(bookAnswer(bed.core, bed.runtime, 'read', { method: 'GET', path: ['plays'], by: 'test' })).rejects.toMatchObject({ status: 403 })

    // On a site: the list, each one, and what they show and play — or none of it.
    const out = await mkdtemp(join(tmpdir(), 'novel-sides-'))
    try {
      const id = (await project.manifest()).id
      const reader = new TextEncoder().encode('/* the reader */')
      const done = await publishSite(bed.core, bed.runtime, { out, reader })
      expect(done.sides).toBe(2)
      expect(JSON.parse(await readFile(join(out, 'data', id, 'sides.json'), 'utf8')).sides).toHaveLength(2)
      expect(JSON.parse(await readFile(join(out, 'data', id, 'sides', 'play_kept.json'), 'utf8'))).toEqual({ play: side })
      expect(JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8')).sides).toBe(2)
      expect((await readFile(join(out, 'media', id, ...background.split('/')))).byteLength).toBe(1)
      expect((await readFile(join(out, 'media', id, ...voice.split('/')))).byteLength).toBe(1)
      const bare = await publishSite(bed.core, bed.runtime, { out, reader, sides: false })
      expect(bare.sides).toBe(0)
      await expect(readFile(join(out, 'data', id, 'sides.json'), 'utf8')).rejects.toThrow()
      await expect(readFile(join(out, 'media', id, ...voice.split('/')))).rejects.toThrow()
      expect(JSON.parse(await readFile(join(out, 'data', id, 'book.json'), 'utf8')).sides).toBeUndefined()
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('the first page of the world', () => {
  const place = (id: string, weight: AlbumEntry['weight'], chapters: number): AlbumEntry => ({ id, name: id, category: 'location', group: 'places', weight, chapters: Array.from({ length: chapters }, (_, at) => at + 1) })
  const inside = (from: string, to: string, since?: string): Tie => ({ id: `${from}-${to}`, kind: 'within', from: { type: 'world', id: from }, to: { type: 'world', id: to }, ...(since !== undefined ? { since } : {}) })

  it('lays the places out by how much of the story they carry, not by what is in what', () => {
    // A city the text names twice, the house in it the story keeps coming back to, the garden in that house where half the book happens, and an inn passed once.
    const places = [place('garden', 'core', 25), place('house', 'major', 9), place('pavilion', 'major', 4), place('city', 'minor', 2), place('inn', 'once', 1)]
    const ties = [inside('house', 'city'), inside('garden', 'house'), inside('pavilion', 'garden')]
    const front = worldFront(places, ties)
    // The garden is met first, though on the map it is two steps down from the top; a row of each weight, in the order given.
    expect(front.heavy.map(tier => [tier.weight, tier.list.map(entry => entry.id)])).toEqual([['core', ['garden']], ['major', ['house', 'pavilion']]])
    expect(front.rest.map(entry => entry.id)).toEqual(['city', 'inn'])
    // The walk from the outside starts at what is in nothing and has something in it: the city, not the inn.
    expect(front.outermost.map(entry => entry.id)).toEqual(['city'])

    // Nothing weighs much: no rows above, and everything is "the rest" — which a page then shows as it is.
    const light = worldFront([place('a', 'minor', 2), place('b', 'once', 1)], [])
    expect(light).toEqual({ heavy: [], rest: [place('a', 'minor', 2), place('b', 'once', 1)], outermost: [] })
    // Before the garden was laid out in the house (the ties in force at an earlier chapter), the house is no way further in.
    expect(worldFront(places, [inside('house', 'city')]).outermost.map(entry => entry.id)).toEqual(['city'])
    expect(worldFront(places, []).outermost).toEqual([])
    // A row that would be empty is left out.
    expect(worldFront([place('house', 'major', 9), place('inn', 'once', 1)], []).heavy.map(tier => tier.weight)).toEqual(['major'])
  })
})

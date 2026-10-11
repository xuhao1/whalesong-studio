// SPDX-License-Identifier: LGPL-3.0-or-later
/** What shapes a book's pictures: art direction, avoid lists, visual anchors, design sheets and reference images. */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, beforeEach } from 'vitest'
import { pictureRecord } from '../src/agent/tools/studio'
import { sheetsAhead } from '../src/core/pipelines/comic'
import { artDirectionOf, deriveArtDirection, deriveLook, deriveScenes, deriveVisual, illustrate, looksOf, forgetFittedPrompts } from '../src/core/pipelines/illustrate'
import { castAt, deriveGrowth } from '../src/core/pipelines/growth'
import { packContext } from '../src/core/context'
import { inStage, stageAt } from '../src/shared/stages'
import type { CharacterStage } from '../src/shared/types'
import { reconcileLooks, upsertLooks } from '../src/core/project'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import { changedFields } from '../src/shared/history'
import { DEFAULT_ART_STYLE, legacyLook, lookWords, mergeAvoid, resolveArtStyle, sceneFor, sceneOfPicture, scenesOf, shotKey, shotOf, splitAvoid } from '../src/shared/art'
import { createTestBed, FakeImages, PIXEL, type TestBed } from './support/harness'

const ANCHOR = '{"appearance": "二十七八岁的女子，身形清瘦，黑发在颈后盘成扁平的髻，穿未染色的亚麻长外衣", "negative": "cross emblem, halo"}'

let bed: TestBed | undefined
afterEach(async () => {
  await bed?.cleanup()
  bed = undefined
})

/**
 * A Studio that draws. A portrait asked for with nothing said of it is their signature scene here — one picture, as
 * most of these tests are about one picture — unless a test says otherwise; left to itself it is the pair, a plain
 * likeness and the scene (`portraits: 'both'`), which has tests of its own.
 */
async function studio(image: Partial<typeof DEFAULT_SETTINGS.image> = {}): Promise<{ bed: TestBed; images: FakeImages }> {
  const images = new FakeImages()
  bed = await createTestBed({ settings: { image: { ...DEFAULT_SETTINGS.image, provider: 'codex', portraits: 'scene', ...image } }, bridges: images.bridges })
  bed.llm.responder = () => ANCHOR
  return { bed, images }
}

const task = { origin: 'user' as const }

describe('art direction', () => {
  it('prefers the book, then the Studio, then the built-in start', () => {
    expect(resolveArtStyle({ language: 'zh', artStyle: '水墨' }, '厚涂')).toEqual({ text: '水墨', source: 'book' })
    expect(resolveArtStyle({ language: 'zh', artStyle: '  ' }, '厚涂')).toEqual({ text: '厚涂', source: 'studio' })
    expect(resolveArtStyle({ language: 'zh' }, undefined)).toEqual({ text: DEFAULT_ART_STYLE.zh, source: 'default' })
    expect(resolveArtStyle({ language: 'en' }, '')).toEqual({ text: DEFAULT_ART_STYLE.en, source: 'default' })
  })

  it('splits and merges avoid lists without repeats', () => {
    expect(splitAvoid('十字架、哥特式教堂，彩绘玻璃; halo\n')).toEqual(['十字架', '哥特式教堂', '彩绘玻璃', 'halo'])
    expect(splitAvoid(undefined)).toEqual([])
    expect(mergeAvoid(['text', 'Halo'], ['halo', '水印'], undefined)).toEqual(['text', 'Halo', '水印'])
  })

  it('writes the direction in force into the book with the first picture, and says where it came from', async () => {
    const { bed, images } = await studio()
    const before = await artDirectionOf(bed.core, bed.runtime)
    expect(before).toMatchObject({ source: 'default', style: DEFAULT_ART_STYLE.zh })
    expect((await bed.runtime.project.manifest()).artStyle).toBeUndefined()

    const first = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨夜的码头，一盏风灯' }, task)
    expect(first.pinnedStyle).toBe(DEFAULT_ART_STYLE.zh)
    // The brief: what it is for, the picture, the art direction — a line each, under its name.
    expect(first.parts).toMatchObject({ subject: '用途：小说插图\n画面：雨夜的码头，一盏风灯', style: DEFAULT_ART_STYLE.zh, styleSource: 'default' })
    expect(first.prompt).toBe(`用途：小说插图\n画面：雨夜的码头，一盏风灯\n画风：${DEFAULT_ART_STYLE.zh}`)
    expect(images.calls[0]!.prompt).toContain(`画风：${DEFAULT_ART_STYLE.zh}`)
    // On disk, where the author and the agent can both read it.
    const manifest = JSON.parse(await readFile(join(bed.runtime.project.root, 'novel.json'), 'utf8')) as { artStyle?: string }
    expect(manifest.artStyle).toBe(DEFAULT_ART_STYLE.zh)

    const second = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '清晨的码头' }, task)
    expect(second.pinnedStyle).toBeUndefined()
    expect(second.parts?.styleSource).toBe('book')
  })

  it('has the director settle a look that is the book\'s own, from the book', async () => {
    const { bed } = await studio()
    const { project } = bed.runtime
    await project.updateManifest({ genre: '民国悬疑', logline: '一个替人写遗书的女人。', premise: '上海，一九二七年。', artAvoid: ['十字架'] })
    await project.saveCharacter({ name: '沈蘅', role: 'protagonist', appearance: '旧旗袍，瘦', tagline: '代笔人' })
    bed.llm.responder = () => JSON.stringify({ style: '民国月份牌的淡彩，胶片颗粒，煤气灯的暖黄', avoid: ['现代服饰', '十字架', '霓虹'], why: '一九二七年的上海弄堂。' })

    // Proposed only: nothing is written.
    const proposed = await deriveArtDirection(bed.core, bed.runtime, { apply: false, direction: '不要日系' }, task)
    expect(proposed).toMatchObject({ style: '民国月份牌的淡彩，胶片颗粒，煤气灯的暖黄', applied: false, why: '一九二七年的上海弄堂。' })
    expect((await project.manifest()).artStyle).toBeUndefined()
    // The director is given what the book is — and what the author asks, which decides.
    const prompt = bed.llm.requests.at(-1)!.prompt
    for (const word of ['民国悬疑', '一个替人写遗书的女人。', '上海，一九二七年。', '沈蘅', '旧旗袍，瘦', '不要日系']) expect(prompt).toContain(word)

    // Settled: written into the book, its avoid list joined to what the book had, on the record of changes.
    const settled = await deriveArtDirection(bed.core, bed.runtime, {}, task)
    expect(settled?.applied).toBe(true)
    expect(await project.manifest()).toMatchObject({ artStyle: '民国月份牌的淡彩，胶片颗粒，煤气灯的暖黄', artAvoid: ['十字架', '现代服饰', '霓虹'] })
    expect(await artDirectionOf(bed.core, bed.runtime)).toMatchObject({ source: 'book', style: '民国月份牌的淡彩，胶片颗粒，煤气灯的暖黄' })
    expect((await project.activity()).some(entry => entry.tool === 'art' && entry.role === 'director')).toBe(true)

    // A book that has a look keeps it when that is asked; the look it has is shown to the director when it is settled anew.
    bed.llm.responder = () => JSON.stringify({ style: '厚涂' })
    expect(await deriveArtDirection(bed.core, bed.runtime, { keep: true }, task)).toBeUndefined()
    await deriveArtDirection(bed.core, bed.runtime, {}, task)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('民国月份牌的淡彩')
    expect((await project.manifest()).artStyle).toBe('厚涂')
  })

  it('keeps the Studio, book, character and per-call avoid lists out of every picture', async () => {
    const { bed, images } = await studio({ negativePrompt: '文字, 水印' })
    await bed.runtime.project.updateManifest({ artAvoid: ['十字架', '哥特式教堂'] })
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦，黑发盘在脑后', visual: { prompt: 'lean woman, black hair coiled at the nape', negative: 'halo' } })
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '她站在门口', characters: [card.id], avoid: ['彩绘玻璃', '水印'] }, task)
    expect(info.parts?.avoid).toEqual(['文字', '水印', '十字架', '哥特式教堂', '彩绘玻璃', 'halo'])
    for (const word of ['十字架', '哥特式教堂', '彩绘玻璃', 'halo']) expect(images.calls.at(-1)!.prompt).toContain(word)
    // She had no design sheet: it was drawn first — with the lists that hold for every picture of her — and the picture says so.
    expect(info.sheets).toEqual(['沈砚'])
    expect(images.calls).toHaveLength(2)
    for (const word of ['十字架', '哥特式教堂', 'halo']) expect(images.calls[0]!.prompt).toContain(word)
  })

  it('writes whoever a picture of the author\'s own prompt names into the words, not only into the sheets sent along', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const lead = await project.saveCharacter({ name: '沈砚', appearance: '高瘦，黑发盘在脑后', visual: { prompt: 'lean woman, black hair coiled at the nape, moon-white jacket', looks: [{ id: 'rain', name: '雨衣', prompt: 'oiled-paper rain cape' }] } })
    const plain = await project.saveCharacter({ name: '阿棠', appearance: '圆脸，两条短辫' })
    const blank = await project.saveCharacter({ name: '路人' })
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '清晨的码头，她提着竹篮走下石阶。', characters: [lead.id, plain.id, blank.id], sheetFirst: false }, task)
    // What it is for, then the picture as asked; then each of them under their name — the anchor where there is one, the card's prose where not.
    expect(info.parts?.pieces).toEqual([
      { of: 'use', text: '小说插图', label: '用途：' },
      { of: 'picture', text: '清晨的码头，她提着竹篮走下石阶', label: '画面：' },
      { of: 'look', text: 'lean woman, black hair coiled at the nape, moon-white jacket', from: 'anchor', name: '沈砚', label: '人物「沈砚」：' },
      { of: 'look', text: '圆脸，两条短辫', from: 'card', name: '阿棠', label: '人物「阿棠」：' },
    ])
    const sent = images.calls.at(-1)!.prompt
    expect(sent).toContain('用途：小说插图\n画面：清晨的码头，她提着竹篮走下石阶\n人物「沈砚」：lean woman, black hair coiled at the nape, moon-white jacket\n人物「阿棠」：圆脸，两条短辫')
    // Somebody whose card says nothing of looks is not named for nothing.
    expect(sent).not.toContain('路人')
    // In the outfit the picture puts them in.
    const worn = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨里的码头', characters: [lead.id], looks: { 沈砚: '雨衣' }, sheetFirst: false }, task)
    expect(worn.parts?.pieces?.[2]).toMatchObject({ name: '沈砚（雨衣）', text: 'lean woman, black hair coiled at the nape, moon-white jacket，oiled-paper rain cape' })
    // Nobody named: the brief has the picture alone. Sent as written: no one is added to it.
    const empty = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '空无一人的码头' }, task)
    expect(empty.parts?.pieces?.map(piece => piece.of)).toEqual(['use', 'picture'])
    expect(empty.parts?.subject).toBe('用途：小说插图\n画面：空无一人的码头')
    const raw = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: 'a pier at dawn', characters: [lead.id], raw: true, sheetFirst: false }, task)
    expect(raw.parts?.subject).toBe('a pier at dawn')
    expect(raw.parts?.pieces).toBeUndefined()
    expect(images.calls.at(-1)!.prompt).not.toContain('lean woman')
  })

  it('sends a raw prompt exactly as written', async () => {
    const { bed, images } = await studio({ negativePrompt: '文字' })
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: 'a lighthouse', raw: true }, task)
    expect(info.prompt).toBe('a lighthouse')
    expect(info.parts).toEqual({ subject: 'a lighthouse' })
    expect(images.calls[0]!.prompt.startsWith('a lighthouse\n')).toBe(true)
    expect((await bed.runtime.project.manifest()).artStyle).toBeUndefined()
  })
})

describe('visual anchors', () => {
  it('patches one field of a character\'s looks without losing the others', async () => {
    const { bed } = await studio()
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', visual: { portrait: 'assets/images/p.png' } })
    const patched = await bed.runtime.project.saveCharacter({ id: card.id, visual: { prompt: 'lean woman' } })
    expect(patched.visual).toEqual({ portrait: 'assets/images/p.png', prompt: 'lean woman' })
  })

  it('has the director write how somebody looks as their appearance — one text, in the book\'s language — with a never-drawn list', async () => {
    const { bed } = await studio()
    await bed.runtime.project.updateManifest({ artAvoid: ['十字架'] })
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦，教会式环髻，白甲保养极新' })
    const derived = await deriveVisual(bed.core, bed.runtime, { character: card.id }, task)
    expect(derived.appearance).toContain('黑发在颈后盘成扁平的髻')
    // On the card it is the appearance — there is no second text beside it for image models.
    expect(derived.card.appearance).toBe(derived.appearance)
    expect(derived.card.visual).toEqual({ negative: 'cross emblem, halo' })
    // The director is told what the book keeps out, and asked for prose in the book's language.
    const asked = bed.llm.requests.at(-1)!.prompt
    expect(asked).toContain('十字架')
    expect(asked).toContain('请写下这个人物的外貌：一段话，用')
    expect(asked).toContain('只输出 JSON：{"appearance": "", "negative": ""}')
    expect(asked).not.toContain('视觉锚点')
    expect(looksOf(derived.card)).toBe(derived.appearance)

    // A card of an earlier version keeps phrases for image models beside the appearance: pictures go by them, as they
    // did, until they are folded in — which is this same writing, told that the phrases hold where the two differ.
    const old = await bed.runtime.project.saveCharacter({ name: '宝玉', appearance: '总编一根大辫', visual: { prompt: 'boy of thirteen, hair bound in a topknot, Ming-style crimson robe', negative: 'queue' } })
    expect(looksOf(old)).toBe('boy of thirteen, hair bound in a topknot, Ming-style crimson robe')
    expect(legacyLook(old)).toBe('boy of thirteen, hair bound in a topknot, Ming-style crimson robe')
    bed.llm.responder = () => '{"appearance": "十三岁的少年，束发成髻，穿明式大红交领袍", "negative": "辫子"}'
    const folded = await deriveVisual(bed.core, bed.runtime, { character: old.id }, task)
    const told = bed.llm.requests.at(-1)!.prompt
    expect(told).toContain('## 以前另写给绘图模型的短语（"视觉锚点"，现在并进外貌）\nboy of thirteen, hair bound in a topknot, Ming-style crimson robe')
    expect(told).toContain('它和人物卡的外貌说法不一样时，以它为准')
    expect(told).toContain('这个人身上不要画出：queue')
    expect(folded.card.appearance).toBe('十三岁的少年，束发成髻，穿明式大红交领袍')
    expect(folded.card.visual).toEqual({ negative: '辫子' })
    expect(legacyLook(folded.card)).toBeUndefined()
    expect(looksOf(folded.card)).toBe('十三岁的少年，束发成髻，穿明式大红交领袍')
    // A sex and an age the paragraph does not give are said after it — inside its sentence, and once.
    expect(lookWords({ appearance: '灰长衫，圆框眼镜，襟内别着一支木笔杆。', gender: '男', age: '62' })).toBe('灰长衫，圆框眼镜，襟内别着一支木笔杆，男，62岁')
    expect(lookWords({ appearance: '六十二岁的男人，灰长衫。', gender: '男', age: '六十二岁' })).toBe('六十二岁的男人，灰长衫')
    expect(lookWords({ appearance: 'A spare man in a grey gown.', gender: 'male', age: '62' })).toBe('A spare man in a grey gown, male, aged 62')
    expect(lookWords({ gender: '男', age: '62' })).toBe('')
  })

  it('writes a look with the art direction in hand: the period and the forms it fixes hold over the source text', async () => {
    const { bed } = await studio()
    const { project } = bed.runtime
    await project.updateManifest({ artStyle: '淡彩水墨，建筑服饰是典型的明制。', artAvoid: ['现代服饰'] })
    const asked = (): string => bed!.llm.requests.at(-1)!.prompt
    const RULE = '人物卡或原文的写法与它冲突时，以画风为准'
    const UNBLENDED = '不要照搬，也不要折中成两样都有'

    // Written by the director: it is handed the art direction, and told what of it binds how somebody looks.
    const card = await project.saveCharacter({ name: '宝玉', appearance: '总编一根大辫，黑亮如漆，穿石青起花八团倭缎排穗褂' })
    bed.llm.responder = () => '{"appearance": "十三岁的少年，头发总编成一根大辫", "negative": "胡须"}'
    await deriveVisual(bed.core, bed.runtime, { character: card.id }, task)
    expect(asked()).toContain('## 这本书的画风')
    expect(asked()).toContain('淡彩水墨，建筑服饰是典型的明制')
    expect(asked()).toContain(RULE)
    expect(asked()).toContain(UNBLENDED)
    expect(asked()).toContain('把最容易混进来的别的形制也列进去')
    // Written again — the author changed the art direction, or presses the button: the card goes along with the
    // appearance it has now and what is not to be drawn on him, and what comes back takes the appearance's place.
    bed.llm.responder = () => '{"appearance": "十三岁的少年，束发成髻，戴小金冠，穿明式大红交领袍", "negative": "辫子, 剃发"}'
    const again = await deriveVisual(bed.core, bed.runtime, { character: card.id }, task)
    expect(asked()).toContain('十三岁的少年，头发总编成一根大辫')
    expect(asked()).toContain('这个人身上不要画出：胡须')
    expect(asked()).toContain('现在那几项还成立的照旧留着')
    expect(again.card).toMatchObject({ appearance: '十三岁的少年，束发成髻，戴小金冠，穿明式大红交领袍', visual: { negative: '辫子, 剃发' } })

    // The same holds wherever the director writes down a look that lasts: ideas sorted into an appearance, a place, a
    // place at a turn of its course.
    bed.llm.responder = () => JSON.stringify({ appearance: '十三岁的少年，束发成髻，戴小金冠，穿明式大红交领袍', picture: '雪夜', kept: [], once: ['雪夜'], unused: [] })
    await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, notes: '这张要雪夜', sheetFirst: false }, task)
    const sorting = bed.llm.requests.find(request => request.prompt.includes('作者随手写的想法'))!.prompt
    expect(sorting).toContain('淡彩水墨，建筑服饰是典型的明制')
    expect(sorting).toContain('作者这次明说要的样子与画风不一样时，以作者这次说的为准')

    const chapter = await project.addChapter({ title: '入园' })
    await project.saveChapterText(chapter.id, '进了大观园，只见正殿崇阁巍峨。后来园子荒了。')
    const garden = await project.saveWorld({ name: '大观园', category: 'location', summary: '为省亲而建的园子', events: [{ chapter: chapter.id, kind: 'decline', what: '园子荒了' }] })
    bed.llm.responder = () => JSON.stringify({ look: '歇山顶的正殿，朱柱青瓦，回廊环抱。' })
    await deriveLook(bed.core, bed.runtime, { entry: garden.id }, task)
    expect(asked()).toContain('淡彩水墨，建筑服饰是典型的明制')
    expect(asked()).toContain('正文的写法与它冲突时以画风为准')
    await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, event: chapter.id }, task)
    const turning = bed.llm.requests.find(request => request.prompt.includes('在故事里出了一件事'))!.prompt
    expect(turning).toContain('淡彩水墨，建筑服饰是典型的明制')
    expect(turning).toContain('形制照画风写')

    // A book with no art direction of its own hands over the one in force — the built-in start, which fixes no period.
    await project.updateManifest({ artStyle: '' })
    const other = await project.saveCharacter({ name: '沈砚', appearance: '高瘦' })
    bed.llm.responder = () => ANCHOR
    await deriveVisual(bed.core, bed.runtime, { character: other.id }, task)
    expect(asked()).toContain(DEFAULT_ART_STYLE.zh)
    expect(asked()).not.toContain('建筑服饰是典型的明制')
  })

  it('falls back to the words of the card when no anchor exists', () => {
    expect(looksOf({ id: 'c', name: '甲', role: 'minor', appearance: '短发', gender: '女', age: '三十' })).toBe('短发，女，三十')
  })
})

describe('a character\'s wardrobe', () => {
  it('gives every look an id and keeps a drawn sheet when the look is saved again', async () => {
    const { bed } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', visual: { looks: [{ name: '丧服', prompt: 'black robe' } as never] } })
    expect(card.visual?.looks).toEqual([{ id: '丧服', name: '丧服', prompt: 'black robe' }])
    // A sheet drawn for the look…
    await project.saveCharacter({ id: card.id, visual: { looks: [{ id: '丧服', name: '丧服', prompt: 'black robe', sheet: 'assets/images/s.png' }] } })
    // …survives a save that does not mention it (an editor with a stale draft, a model rewriting the outfit).
    const again = await project.saveCharacter({ id: card.id, visual: { looks: [{ name: '丧服', prompt: 'plain black robe', when: '葬礼' } as never] } })
    expect(again.visual?.looks).toEqual([{ id: '丧服', name: '丧服', prompt: 'plain black robe', when: '葬礼', sheet: 'assets/images/s.png' }])
    // The list an editor sends is the whole list: a look left out is gone.
    const cleared = await project.saveCharacter({ id: card.id, visual: { looks: [] } })
    expect(cleared.visual?.looks).toBeUndefined()
  })

  it('reads looks written by hand, without ids', () => {
    expect(reconcileLooks([{ name: ' 戎装 ', prompt: 'lamellar armour' }, { name: '戎装' }, { prompt: 'nameless' }, 'junk'])).toEqual([
      { id: '戎装', name: '戎装', prompt: 'lamellar armour' },
      { id: '戎装-2', name: '戎装' },
    ])
  })

  it('adds to or changes a wardrobe by name and leaves the rest alone', () => {
    const before = [
      { id: 'mourning', name: '丧服', prompt: 'black robe', sheet: 'a.png' },
      { id: 'armour', name: '戎装', prompt: 'lamellar armour', sheet: 'b.png' },
    ]
    expect(upsertLooks(before, [{ name: '丧服', when: '葬礼' }, { name: '雨夜外出', prompt: 'dark wool coat' }])).toEqual([
      { id: 'mourning', name: '丧服', prompt: 'black robe', when: '葬礼', sheet: 'a.png' },
      { id: 'armour', name: '戎装', prompt: 'lamellar armour', sheet: 'b.png' },
      { id: '雨夜外出', name: '雨夜外出', prompt: 'dark wool coat' },
    ])
    expect(upsertLooks(before, [{ name: '戎装', remove: true }])).toEqual([{ id: 'mourning', name: '丧服', prompt: 'black robe', sheet: 'a.png' }])
    expect(upsertLooks(before, 'nonsense')).toEqual(before)
  })
})

describe('design sheets and looks', () => {
  it('draws a three-view sheet from the appearance as the card has it — and has it written first where the card says nothing of looks', async () => {
    const { bed, images } = await studio()
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦，黑发盘在脑后', gender: '女' })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: '沈砚' }, task)
    expect(sheet.kind).toBe('sheet')
    expect(sheet.parts?.subject).toContain('三视图')
    // Her appearance, as written: nobody rewrote it into other words for the image model first.
    expect(sheet.parts?.subject).toContain('人物「沈砚」：高瘦，黑发盘在脑后，女')
    expect(bed.llm.requests).toHaveLength(0)
    expect(images.calls[0]!.references).toHaveLength(0)
    const saved = (await bed.runtime.project.findCharacter(card.id))!
    expect(saved.visual?.sheet).toBe(sheet.path)
    expect(saved.visual?.prompt).toBeUndefined()
    // Somebody whose card says nothing of how they look: the director writes their appearance, from the book, and
    // the sheet is drawn from that — it is on the card from then on.
    const bare = await bed.runtime.project.saveCharacter({ name: '周衡' })
    const his = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: bare.id }, task)
    expect(bed.llm.requests).toHaveLength(1)
    expect(his.parts?.subject).toContain('黑发在颈后盘成扁平的髻')
    expect(his.parts?.avoid).toEqual(['cross emblem', 'halo'])
    expect((await bed.runtime.project.findCharacter(bare.id))!.appearance).toContain('黑发在颈后盘成扁平的髻')
  })

  it('derives a look from the main sheet and keeps both', async () => {
    const { bed, images } = await studio()
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const main = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    await expect(illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服' }, task)).rejects.toThrow(/no look called/)
    const mourning = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服', prompt: 'plain black mourning robe, hair unbound' }, task)
    // The look is drawn against the main sheet, so it is the same person in other clothes — and the prompt says what the
    // reference is for: the face from the picture, the clothes from the words. Never "whatever it shows must match".
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect(mourning.parts?.references).toEqual([{ path: main.path, label: '沈砚的主造型', sheet: true }])
    expect(mourning.parts?.subject).toContain('plain black mourning robe')
    expect(mourning.parts?.referenceNote).toContain('脸、发色、体型照参考图画')
    expect(mourning.parts?.referenceNote).toContain('一律照文字画')
    expect(mourning.prompt).not.toContain('必须与各自的参考图一致')
    const saved = (await bed.runtime.project.findCharacter(card.id))!
    expect(saved.visual?.sheet).toBe(main.path)
    expect(saved.visual?.looks).toEqual([{ id: '丧服', name: '丧服', prompt: 'plain black mourning robe, hair unbound', sheet: mourning.path }])
    // Drawn again, the look is held against the main sheet still — not against its own sheet of before.
    const again = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服' }, task)
    expect(again.parts?.references).toEqual([{ path: main.path, label: '沈砚的主造型', sheet: true }])
  })

  it('draws the main sheet from the words alone, every time: drawn again, it takes no older picture of the person along', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '宝玉', appearance: '面若中秋之月', visual: { prompt: 'boy of thirteen, hair in one thick queue' } })
    const first = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(portrait.parts?.references).toEqual([{ path: first.path, label: '宝玉', sheet: true }])

    // The author changes how they look, and has the sheet drawn again: the new words are all the picture is made of.
    // Held against the old sheet — or against the portrait drawn from it — it would come back as the old sheet.
    await project.saveCharacter({ id: card.id, visual: { prompt: 'boy of thirteen, hair bound in a topknot under a small gold crown' } })
    const second = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    expect(images.calls.at(-1)!.references).toEqual([])
    expect(second.parts?.references).toBeUndefined()
    expect(second.parts?.referenceNote).toBeUndefined()
    expect(second.prompt).not.toContain('参考图')
    expect(second.prompt).toContain('topknot under a small gold crown')
    expect(second.prompt).not.toContain('queue')
    expect(second.path).not.toBe(first.path)
    expect((await project.findCharacter(card.id))!.visual?.sheet).toBe(second.path)
    // The sheet of before stays in the gallery, with its record: what the portrait was drawn against can still be seen.
    expect((await project.illustrations()).map(item => item.path)).toEqual([first.path, portrait.path, second.path])
    // …and on the card, beside the new one, not in use: a sheet drawn again takes nothing away.
    expect((await project.findCharacter(card.id))!.visual?.sheets).toEqual([second.path, first.path])
    expect(second.spare).toBeUndefined()
    // The author chooses the earlier one as the main sheet: one drawn after that waits beside it, and the draw says so.
    await project.saveCharacter({ id: card.id, visual: { mainSheet: first.path } })
    const third = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    expect(third.spare).toBe(true)
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ sheet: first.path, mainSheet: first.path, sheets: [third.path, second.path, first.path] })
    // What is drawn of them goes by the main sheet — the chosen one — not by the newest.
    const after = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(after.parts?.references).toEqual([{ path: first.path, label: '宝玉', sheet: true }])
    await project.saveCharacter({ id: card.id, visual: { mainSheet: second.path } })
    // The portrait is drawn against the sheet in use: drawn again, against the new one.
    const redrawn = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(redrawn.parts?.references).toEqual([{ path: second.path, label: '宝玉', sheet: true }])

    // Somebody who has a portrait and no sheet — drawn before sheets came first, or the sheet was taken out of the
    // gallery: their sheet too is drawn from the words, not from the portrait.
    const other = await project.saveCharacter({ name: '秦钟', appearance: '眉清目秀', visual: { prompt: 'slight boy, fine brows', portrait: portrait.path } })
    const theirs = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: other.id }, task)
    expect(images.calls.at(-1)!.references).toEqual([])
    expect(theirs.parts?.references).toBeUndefined()
  })

  it('keeps on record what a picture was made of, part by part, and what went to the image model word for word', async () => {
    const { bed } = await studio()
    const { project } = bed.runtime
    await project.updateManifest({ artStyle: '淡彩水墨，建筑服饰是典型的明制。', artAvoid: ['现代服饰'] })
    const card = await project.saveCharacter({ name: '沈砚', appearance: '高瘦', personality: '寡言', visual: { prompt: 'lean woman, black hair.', negative: 'halo' } })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, prompt: '袖口挽起' }, task)
    // Every part, in the order it was sent, and what each was taken from.
    expect(sheet.parts?.pieces?.map(piece => piece.of)).toEqual(['use', 'frame', 'look', 'ask'])
    expect(sheet.parts?.pieces?.[2]).toEqual({ of: 'look', text: 'lean woman, black hair', from: 'anchor', name: '沈砚', label: '人物「沈砚」：' })
    expect(sheet.parts?.pieces?.[3]).toEqual({ of: 'ask', text: '袖口挽起', label: '这一张的要求：' })
    // A part a line, each under what it is: what the picture is for, how it is framed, whose look, what was asked.
    expect(sheet.parts?.subject).toBe(sheet.parts!.pieces!.map(piece => `${piece.label ?? ''}${piece.text}`).join('\n'))
    expect(sheet.parts?.subject.split('\n')[0]).toBe('用途：人物设定图（三视图）：「沈砚」')
    expect(sheet.parts?.subject.split('\n')[1]).toContain('构图：同一个人的全身站姿画三次')
    expect(sheet.parts?.style).toBe('淡彩水墨，建筑服饰是典型的明制。')
    expect(sheet.parts?.clipped).toBeUndefined()
    // How it was drawn: the service, the size asked for.
    expect(sheet.provider).toBe('codex')
    expect(sheet.size).toBe('1536x1024')
    // Word for word: what the Studio put together, and what the way to this model adds — the things to keep out, which
    // it has no field for, and the shape of the frame, which it takes no size for.
    expect(sheet.sent?.prompt.startsWith(sheet.prompt)).toBe(true)
    expect(sheet.sent?.prompt).toContain('画风：淡彩水墨，建筑服饰是典型的明制')
    expect(sheet.sent?.prompt).toContain('不要出现：现代服饰、halo')
    // …said after the art direction, as the prompt's last line.
    expect(sheet.prompt.split('\n').slice(-2)).toEqual(['画风：淡彩水墨，建筑服饰是典型的明制', '不要出现：现代服饰、halo'])
    expect(sheet.sent?.prompt).toContain('Landscape 3:2 composition.')
    expect(sheet.sent?.negative).toBeUndefined()

    // A portrait: what kind of picture, the look, the expression, what was asked of this one — and the sheet it is held against.
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, prompt: '雪夜，回头看' }, task)
    // What was asked of this one is said before who they are: it is what the picture is of.
    expect(portrait.parts?.pieces?.map(piece => piece.of)).toEqual(['use', 'picture', 'frame', 'look', 'expression'])
    expect(portrait.parts?.pieces?.[1]).toMatchObject({ text: '雪夜，回头看', label: '画面：' })
    // Her sheet goes along: her line points to it, and her standing look is not written out beside it.
    // (What the line would have said is kept beside the pointer, unsent.)
    expect(portrait.parts?.pieces?.[3]).toEqual({ of: 'look', text: '见图1', from: 'anchor', name: '沈砚', path: sheet.path, byPicture: true, words: 'lean woman, black hair', label: '人物「沈砚」：' })
    expect(portrait.prompt).not.toContain('lean woman')
    expect(portrait.parts?.referenceNote).toContain('图1 是沈砚')
    // What she wears in this picture is the words' to say where they say it; the picture's where they do not.
    expect(portrait.parts?.referenceNote).toContain('衣着和随身的东西，上面另写了的照文字，没写的照图')
    expect(portrait.sent?.prompt).toContain(portrait.parts!.referenceNote!)

    // A place: its look as written on the entry — or, where nothing is written for an image model, its name and summary.
    bed.llm.responder = () => { throw new Error('no model') }
    const written = await project.saveWorld({ name: '咏礼庭', category: 'location', visualPrompt: '低矮的夯土圆厅' })
    const bare = await project.saveWorld({ name: '渡口', category: 'location', summary: '河边的木栈桥' })
    expect((await illustrate(bed.core, bed.runtime, { kind: 'location', target: written.id }, task)).parts?.pieces?.[2]).toEqual({ of: 'look', text: '低矮的夯土圆厅', from: 'anchor', name: '咏礼庭', label: '地点「咏礼庭」：' })
    expect((await illustrate(bed.core, bed.runtime, { kind: 'location', target: bare.id }, task)).parts?.pieces?.[2]).toEqual({ of: 'look', text: '渡口，河边的木栈桥', from: 'card', name: '渡口', label: '地点「渡口」：' })
    // Somebody without an anchor, and no model to write one: the prose of the card stands in, and the record says so.
    const plain = await project.saveCharacter({ name: '阿棠', appearance: '圆脸，爱笑', gender: '女' })
    expect((await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: plain.id }, task)).parts?.pieces?.[2]).toEqual({ of: 'look', text: '圆脸，爱笑，女', from: 'card', name: '阿棠', label: '人物「阿棠」：' })
  })

  it('tells the showrunner how a picture was made, so that a look nobody asked for can be traced', async () => {
    const { bed } = await studio()
    const { project } = bed.runtime
    await project.updateManifest({ artStyle: '淡彩水墨，建筑服饰是典型的明制' })
    const card = await project.saveCharacter({ name: '宝玉', appearance: '面若中秋之月', visual: { prompt: 'boy of thirteen, hair in one thick queue', negative: 'beard' } })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    // The sheet: where the braid comes from is there to be read — the anchor says it — and nothing went along with it.
    const ofSheet = pictureRecord(sheet)
    expect(ofSheet).toContain(`sheet of ${card.id} — ${sheet.path}`)
    expect(ofSheet).toContain('how it looks (the visual anchor / the look written on the entry): boy of thirteen, hair in one thick queue')
    expect(ofSheet).toContain('art direction (the book\'s own): 淡彩水墨，建筑服饰是典型的明制')
    expect(ofSheet).toContain('kept out: beard')
    expect(ofSheet).toContain('No reference picture went with it')
    expect(ofSheet).toContain(sheet.sent!.prompt)
    // The portrait: drawn against the sheet, which is named with its path so that it can be looked up in turn.
    const ofPortrait = pictureRecord(portrait)
    expect(ofPortrait).toContain(`#1 宝玉 — ${sheet.path}`)
    expect(ofPortrait).toContain('what the references are for: 参考图：图1 是宝玉')
    // A picture from before any of this was kept still says what there is of it.
    const old = pictureRecord({ id: 'img_old', path: 'assets/images/old.png', prompt: 'a boy\n画风：水墨', kind: 'sheet', target: card.id, createdAt: '2026-10-08T12:00:00.000Z' })
    expect(old).toContain('subject: (not recorded apart from the whole prompt below)')
    expect(old).toContain('a boy\n画风：水墨')
    expect(old).toContain('drawn before the words as sent were kept')
  })

  it('draws a scene against the sheets of the people in it and the art of the place', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', looks: [{ id: 'mourning', name: '丧服', prompt: 'black mourning robe', when: '葬礼' }] } })
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const look = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服' }, task)
    const place = await project.saveWorld({ name: '咏礼庭', category: 'location', visualPrompt: '低矮的夯土圆厅，屋顶开一个天井' })
    const art = await illustrate(bed.core, bed.runtime, { kind: 'location', target: place.id }, task)
    expect((await project.findWorld(place.id))!.visualImage).toBe(art.path)

    const chapter = await project.addChapter({ title: '守灵' })
    await project.saveChapterText(chapter.id, '沈砚走进咏礼庭，在棺前站了很久。')
    // The director settles the picture: what the frame shows, who is in it and in what, where it is set — and why it thinks so.
    bed.llm.responder = () => '{"picture": "一个高瘦的女人站在夯土圆厅的天井光柱下", "people": ["沈砚"], "wearing": {"沈砚": "丧服"}, "place": "咏礼庭", "why": "正文点了沈砚和咏礼庭；守灵穿的是丧服"}'
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, avoid: ['十字架'] }, task)
    // The director was shown the chapter, its people and their looks to choose from, how the place looks and what must stay out.
    const brief = bed.llm.requests.at(-1)!.prompt
    expect(brief).toContain('## 这一章\n第 1 章《守灵》')
    expect(brief).toContain('沈砚｜')
    expect(brief).toContain('低矮的夯土圆厅')
    expect(brief).toContain('十字架')
    expect(brief).toContain('「丧服」')
    // The brief: what it is for, the director's picture, and her — who is pointed to in the sheet of the outfit she wears there.
    expect(scene.parts?.subject).toBe('用途：小说章节插图\n画面：一个高瘦的女人站在夯土圆厅的天井光柱下\n人物「沈砚（丧服）」：见图1\n地点「咏礼庭」：低矮的夯土圆厅，屋顶开一个天井')
    // What it settled is said with the picture, and kept with it.
    expect(scene.framed).toEqual({ people: ['沈砚'], place: '咏礼庭', why: '正文点了沈砚和咏礼庭；守灵穿的是丧服' })
    expect(scene.passage).toEqual({ why: '正文点了沈砚和咏礼庭；守灵穿的是丧服' })
    // The director is told to call people by name and leave their standing looks to the Studio.
    expect(brief).toContain('人物用姓名称呼')
    expect(scene.parts?.references).toEqual([
      { path: look.path, label: '沈砚（丧服）', sheet: true },
      { path: art.path, label: '场所「咏礼庭」' },
    ])
    expect(images.calls.at(-1)!.references).toHaveLength(2)
    expect(scene.prompt).toContain('参考图：图1 是沈砚（丧服）；图2 是场所「咏礼庭」')
  })

  it('has the director write down how a place or a thing looks, from the book, before its design art is drawn', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '入园' })
    await project.saveChapterText(chapter.id, '进了园门，只见迎面一带翠嶂挡在前面。往前一望，见白石崚嶒，或如鬼怪，或如猛兽，纵横拱立。\n\n再进数步，渐向北边，平坦宽豁，两边飞楼插空，雕甍绣槛，皆隐于山坳树杪之间。')
    const garden = await project.saveWorld({ name: '大观园', aliases: ['园门'], category: 'location', summary: '为省亲而建的园子' })
    const mirror = await project.saveWorld({ name: '风月宝鉴', category: 'item', summary: '两面皆可照人的镜子' })
    const idea = await project.saveWorld({ name: '金玉良缘', category: 'rule' })
    bed.llm.responder = () => JSON.stringify({ look: '一进园门是翠嶂假山，白石嶙峋；其后地势开阔，两侧楼阁隐在树梢之间，雕梁绣槛，粉墙黛瓦。' })
    const made = await deriveLook(bed.core, bed.runtime, { entry: '大观园', direction: '要有水' }, task)
    expect(made.look).toContain('翠嶂假山')
    expect((await project.findWorld(garden.id))!.visualPrompt).toBe(made.look)
    // The director was handed what the bible says of it and where the text names it — by its name or another of its names — and the author's wish.
    const asked = bed.llm.requests.at(-1)!.prompt
    expect(asked).toContain('为省亲而建的园子')
    expect(asked).toContain('第 1 章')
    expect(asked).toContain('迎面一带翠嶂')
    expect(asked).toContain('要有水')
    // An idea of the world is nothing a picture shows; a name nothing answers to is said.
    await expect(deriveLook(bed.core, bed.runtime, { entry: idea.id }, task)).rejects.toThrow(/idea of the world/)
    await expect(deriveLook(bed.core, bed.runtime, { entry: '没有这个地方' }, task)).rejects.toThrow(/no world entry/)

    // Drawn without a look written down: the director writes one first — once — and the picture is drawn from it.
    const requests = bed.llm.requests.length
    bed.llm.responder = () => JSON.stringify({ look: '一面带柄的铜镜，镜背錾着"风月宝鉴"四字，两面皆可照人。' })
    const art = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id }, task)
    expect(bed.llm.requests.length).toBe(requests + 1)
    expect(art.parts?.subject).toContain('一面带柄的铜镜')
    expect((await project.findWorld(mirror.id))!.visualPrompt).toContain('一面带柄的铜镜')
    await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id }, task)
    expect(bed.llm.requests.length).toBe(requests + 1)
    // A place that has its look is drawn from it, and nobody is asked.
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id }, task)
    expect(bed.llm.requests.length).toBe(requests + 1)
    expect(scene.parts?.subject).toContain('翠嶂假山')
    // Where the director cannot be had, a picture is still drawn — from the entry's own words, and the entry is left without a look.
    const inn = await project.saveWorld({ name: '悦来客栈', category: 'location', summary: '城门口的小客栈' })
    bed.llm.responder = () => { throw new Error('the director is not answering') }
    const fallback = await illustrate(bed.core, bed.runtime, { kind: 'location', target: inn.id }, task)
    expect(fallback.parts?.subject).toContain('城门口的小客栈')
    expect((await project.findWorld(inn.id))!.visualPrompt).toBeUndefined()
    expect(images.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('draws a place or a thing as it is at one turn of its course: as the director writes it is then, against its design art, and kept with the turn', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const built = await project.addChapter({ title: '落成' })
    const raided = await project.addChapter({ title: '抄检' })
    await project.saveChapterText(raided.id, '抄检过后，园子里的人一天比一天少。\n\n宝玉再进大观园，只见怡红院的海棠枯了半边，阶下的草没人拔，已经长到了膝盖。')
    const garden = await project.saveWorld({
      name: '大观园', category: 'location', visualPrompt: '粉墙黛瓦的园子，水绕着亭台',
      events: [{ chapter: built.id, kind: 'begin', what: '贾琏会同清客审察地方，各行匠役齐集，起造省亲别院' }, { chapter: raided.id, kind: 'decline', what: '抄检之后人去楼空' }, { chapter: raided.id, kind: 'change', what: '园门上了锁' }],
    })
    // What happened is told as a story — who did what. The director writes what is there to be seen, and that is what is drawn.
    bed.llm.responder = () => JSON.stringify({ look: '园子还只是工地：粉墙才砌到半人高，亭台只立起木架，水道刚挖出土槽，石料木料成堆。' })
    const first = await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, event: `${built.id}:begin` }, task)
    expect(first.parts?.subject).toContain('用途：场景设定图')
    expect(first.parts?.subject).toContain('构图：无人物')
    expect(first.parts?.subject).toContain('亭台只立起木架')
    expect(first.parts?.subject).not.toContain('贾琏')
    // Nothing of its own yet: the turn is drawn from the words alone.
    expect(images.calls.at(-1)!.references).toEqual([])
    const design = await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id }, task)
    expect(design.parts?.subject).toContain('粉墙黛瓦的园子，水绕着亭台')
    // With its design art there, a decline or a change is the same sight altered: the art goes along, as to where and what and not as to its state.
    bed.llm.responder = () => JSON.stringify({ look: '同一座粉墙黛瓦的园子，亭台仍在，只是阶前荒草没膝，海棠枯了半边，窗纸破了，水面浮着落叶。' })
    const ruin = await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, event: `${raided.id}:decline` }, task)
    expect(ruin.parts?.subject).toContain('阶前荒草没膝')
    expect(ruin.parts?.references).toEqual([{ path: design.path, label: '「大观园」平常的样子' }])
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect(ruin.prompt).toContain('它此刻的状态以本描述为准')
    expect(ruin.prompt).not.toContain('必须与各自的参考图一致')
    // People are kept out of it: what happened is told with the people it happened through, the picture is of the place.
    expect(ruin.parts?.avoid).toContain('人物')
    // The director was handed how it usually looks, what happened and at which chapter, what a decline asks to be shown, and where that chapter names it.
    const asked = bed.llm.requests.at(-1)!.prompt
    expect(asked).toContain('粉墙黛瓦的园子，水绕着亭台')
    expect(asked).toContain('第 2 章：抄检之后人去楼空')
    expect(asked).toContain('冷清、失修、荒芜到了什么地步')
    expect(asked).toContain('阶下的草没人拔')
    expect(new Set([first.path, design.path, ruin.path]).size).toBe(3)
    const saved = (await project.findWorld(garden.id))!
    // The design art and the look it was drawn from are what they were; each picture is with its turn, and the turn nobody drew has none.
    expect(saved.visualImage).toBe(design.path)
    expect(saved.visualPrompt).toBe('粉墙黛瓦的园子，水绕着亭台')
    expect(saved.events).toEqual([
      { chapter: built.id, kind: 'begin', what: '贾琏会同清客审察地方，各行匠役齐集，起造省亲别院', image: first.path },
      { chapter: raided.id, kind: 'decline', what: '抄检之后人去楼空', image: ruin.path },
      { chapter: raided.id, kind: 'change', what: '园门上了锁' },
    ])
    // A chapter alone — by its number — is the first turn written in it; drawn again, the turn has the new picture.
    const again = await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, event: '2' }, task)
    expect((await project.findWorld(garden.id))!.events![1]!.image).toBe(again.path)
    // What is only coming to be is another sight altogether: before the design art an image model draws the finished place — so it is drawn from the words alone.
    const anew = await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, event: `${built.id}:begin` }, task)
    expect(images.calls.at(-1)!.references).toEqual([])
    expect(anew.parts?.references).toBeUndefined()
    // A thing has its turns the same way. Where the director cannot be had, a picture is still drawn — from how it usually looks and the turn's own words.
    const mirror = await project.saveWorld({ name: '风月宝鉴', category: 'item', visualPrompt: '一面带柄的铜镜', events: [{ chapter: raided.id, kind: 'end', what: '镜面碎裂' }] })
    bed.llm.responder = () => { throw new Error('the director is not answering') }
    const broken = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id, event: `${raided.id}:end` }, task)
    expect(broken.parts?.subject).toContain('一面带柄的铜镜，这是它终结之后的样子：镜面碎裂')
    const kept = (await project.findWorld(mirror.id))!
    expect(kept.visualImage).toBeUndefined()
    expect(kept.events).toEqual([{ chapter: raided.id, kind: 'end', what: '镜面碎裂', image: broken.path }])
    // A turn nobody wrote down is not made up: the caller is told to write it first, and nobody is asked and nothing drawn.
    const drawn = images.calls.length
    const requests = bed.llm.requests.length
    await expect(illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, event: `${built.id}:end` }, task)).rejects.toThrow(/has nothing at/)
    await expect(illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id, event: '1' }, task)).rejects.toThrow(/write the turn down first/)
    expect(images.calls.length).toBe(drawn)
    expect(bed.llm.requests.length).toBe(requests)
  })

  it('takes a deleted picture off whoever held it up as theirs, and says whose it was', async () => {
    const { bed } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', looks: [{ id: 'mourning', name: '丧服', prompt: 'black mourning robe' }] } })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const look = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服' }, task)
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    const chapter = await project.addChapter({ title: '塌' })
    const place = await project.saveWorld({ name: '咏礼庭', category: 'location', visualPrompt: '低矮的夯土圆厅', events: [{ chapter: chapter.id, kind: 'decline', what: '塌了半边' }] })
    const art = await illustrate(bed.core, bed.runtime, { kind: 'location', target: place.id }, task)
    bed.llm.responder = () => JSON.stringify({ look: '夯土圆厅塌了半边，天井的光照在碎土上' })
    const turn = await illustrate(bed.core, bed.runtime, { kind: 'location', target: place.id, event: chapter.id }, task)
    expect(await project.illustrations()).toHaveLength(5)

    // A look's sheet: the look stays, without it; the person's own sheet and portrait are theirs still.
    expect(await project.removeIllustration(look.id)).toEqual(['沈砚'])
    const dressed = (await project.findCharacter(card.id))!
    expect(dressed.visual?.looks).toEqual([{ id: 'mourning', name: '丧服', prompt: 'black mourning robe' }])
    expect(dressed.visual?.sheet).toBe(sheet.path)
    expect(dressed.visual?.portrait).toBe(portrait.path)
    expect(await project.removeIllustration(portrait.id)).toEqual(['沈砚'])
    expect((await project.findCharacter(card.id))!.visual?.portrait).toBeUndefined()
    // The picture of a turn: the turn stays as it was written, the design art is untouched.
    expect(await project.removeIllustration(turn.id)).toEqual(['咏礼庭'])
    const standing = (await project.findWorld(place.id))!
    expect(standing.events).toEqual([{ chapter: chapter.id, kind: 'decline', what: '塌了半边' }])
    expect(standing.visualImage).toBe(art.path)
    expect(await project.removeIllustration(art.id)).toEqual(['咏礼庭'])
    expect((await project.findWorld(place.id))!.visualImage).toBeUndefined()
    // The files are gone with their records; a picture nobody has is nobody's.
    await expect(readFile(join(bed.runtime.project.root, ...turn.path.split('/')))).rejects.toThrow()
    expect(await project.removeIllustration('img_nothing')).toEqual([])
    expect((await project.illustrations()).map(item => item.id)).toEqual([sheet.id])
  })

  it('composes a cover from what the book is — its story, its tone, its leads — not from its title', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    await project.updateManifest({ genre: '世情', themes: ['盛衰', '情'], logline: '一个大家族的盛极而衰。' })
    const lead = await project.saveCharacter({ name: '贾宝玉', role: 'protagonist', tagline: '衔玉而生的公子', visual: { prompt: '少年，束发嵌宝紫金冠，大红箭袖', negative: '胡须' } })
    await project.saveCharacter({ name: '林黛玉', role: 'deuteragonist', appearance: '两弯似蹙非蹙罥烟眉' })
    await project.saveCharacter({ name: '周瑞家的', role: 'minor', appearance: '中年仆妇' })
    await project.saveWorld({ name: '大观园', category: 'location', importance: 1, visualPrompt: '曲水环绕的江南园林，粉墙黛瓦' })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: lead.id }, task)
    // No premise was ever written down: what the chapters tell stands in for it.
    const chapter = await project.addChapter({ title: '第一回' })
    await project.saveChapterText(chapter.id, '此开卷第一回也。')
    await project.saveMemory({ schema: 1, chapterId: chapter.id, textHash: 'x', updatedAt: '', brief: '甄士隐梦见一僧一道携顽石下凡', summary: '……', facts: [], characters: [], newEntities: [], threads: [] })
    bed.llm.responder = () => '园中曲水边，红衣少年回头望向倚竹而立的素衣少女，落花满地，天色将暮'
    const cover = await illustrate(bed.core, bed.runtime, { kind: 'cover', prompt: '要有落花' }, task)
    const brief = bed.llm.requests.at(-1)!.prompt
    // The director was told what the book is about, how it feels, who leads it and how they look, and where it is set.
    for (const part of ['一个大家族的盛极而衰', '世情', '甄士隐梦见一僧一道携顽石下凡', '束发嵌宝紫金冠', '两弯似蹙非蹙罥烟眉', '曲水环绕的江南园林', '要有落花']) expect(brief, part).toContain(part)
    // Somebody with a small part is not who a cover is about; what must never be drawn on a lead stays out.
    expect(brief).not.toContain('中年仆妇')
    expect(brief).toContain('胡须')
    // What is drawn is the picture the director composed — on a cover's terms, against the lead's sheet.
    expect(cover.parts?.subject).toContain('红衣少年回头望向倚竹而立的素衣少女')
    expect(cover.parts?.subject).toContain('竖幅构图')
    expect(cover.parts?.subject).not.toContain('一个大家族的盛极而衰')
    // The other lead had no sheet: hers was drawn before the cover, and the cover is held against both.
    const hers = (await project.findCharacter('林黛玉'))!.visual!.sheet!
    expect(cover.sheets).toEqual(['林黛玉'])
    expect(cover.parts?.references).toEqual([{ path: sheet.path, label: '贾宝玉', sheet: true }, { path: hers, label: '林黛玉', sheet: true }])
    expect(images.calls.at(-1)!.references).toHaveLength(2)
    expect((await project.findCharacter('周瑞家的'))!.visual?.sheet).toBeUndefined()
  })

  it('draws the design sheet first: before a portrait always, before a scene for whoever comes back in the book', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const sheets = (): number => images.calls.filter(call => call.prompt.includes('三视图')).length
    // A portrait of somebody without a sheet: the sheet first, the portrait against it — and the result names it.
    const lead = await project.saveCharacter({ name: '沈砚', role: 'minor', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: lead.id }, task)
    const made = (await project.findCharacter(lead.id))!
    expect(portrait.sheets).toEqual(['沈砚'])
    expect(images.calls.map(call => call.prompt.includes('三视图'))).toEqual([true, false])
    expect(made.visual?.sheet).toBeDefined()
    expect(portrait.parts?.references).toEqual([{ path: made.visual!.sheet!, label: '沈砚', sheet: true }])
    // Drawn again, there is a sheet: nothing is drawn but the portrait, and nothing is said of sheets.
    const again = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: lead.id }, task)
    expect(again.sheets).toBeUndefined()
    expect(sheets()).toBe(1)

    // A scene: whoever comes back in the book — a part that carries it, or in two chapters or more — gets a sheet before
    // it; somebody seen once does not.
    const friend = await project.saveCharacter({ name: '阿棠', role: 'supporting', appearance: '圆脸，爱笑', visual: { prompt: 'round-faced girl' } })
    const twice = await project.saveCharacter({ name: '老周', role: 'cameo', appearance: '驼背的船夫', visual: { prompt: 'stooped boatman' } })
    const once = await project.saveCharacter({ name: '卖花人', role: 'cameo', appearance: '挎着竹篮', visual: { prompt: 'flower seller with a basket' } })
    const first = await project.addChapter({ title: '码头' })
    const second = await project.addChapter({ title: '渡船', characters: [twice.id] })
    await project.saveChapterText(first.id, '阿棠在码头等船，老周把船靠了岸，卖花人从她身边走过。')
    await project.saveChapterText(second.id, '老周摇着橹。')
    const memory = (chapterId: string, names: string[]) => ({ schema: 1 as const, chapterId, textHash: 'x', updatedAt: '', brief: '', summary: '码头上的早晨', facts: [], newEntities: [], threads: [], characters: names.map(name => ({ character: name, name })) })
    await project.saveMemory(memory(first.id, ['阿棠', '老周', '卖花人']))
    await project.saveMemory(memory(second.id, ['老周']))
    bed.llm.responder = () => '{"picture": "码头上，阿棠望着靠岸的船，老周在船头，卖花人从旁走过", "people": ["阿棠", "老周", "卖花人"]}'
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: first.id, quote: '阿棠在码头等船，老周把船靠了岸，卖花人从她身边走过。' }, task)
    // The passage it was drawn of is kept with the picture.
    expect(scene.passage?.quote).toBe('阿棠在码头等船，老周把船靠了岸，卖花人从她身边走过。')
    expect([...(scene.sheets ?? [])].sort()).toEqual(['老周', '阿棠'].sort())
    expect((await project.findCharacter(friend.id))!.visual?.sheet).toBeDefined()
    expect((await project.findCharacter(twice.id))!.visual?.sheet).toBeDefined()
    expect((await project.findCharacter(once.id))!.visual?.sheet).toBeUndefined()
    expect(sheets()).toBe(3)
    // The scene is held against the sheets just drawn.
    expect(scene.parts?.references?.map(reference => reference.label).sort()).toEqual(['老周', '阿棠'].sort())
    // Whoever has no picture to go along is written out; the two with sheets are pointed to in theirs.
    expect(scene.parts?.subject).toContain('人物「卖花人」：flower seller with a basket')
    expect(scene.parts?.subject).toContain('人物「阿棠」：见图1')
  })

  it('draws a sheet once when two pictures need it at the same time, and none where the author turned it off', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const chapter = await project.addChapter({ title: '守灵' })
    await project.saveChapterText(chapter.id, '沈砚在棺前站了很久。')
    bed.llm.responder = () => '{"picture": "沈砚站在棺前", "people": ["沈砚"]}'
    const [one, two] = await Promise.all([
      illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id }, task),
      illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id }, task),
    ])
    expect(images.calls.filter(call => call.prompt.includes('三视图'))).toHaveLength(1)
    expect(images.calls).toHaveLength(3)
    // Whichever of the two drew it says so; both are held against it.
    expect([...(one.sheets ?? []), ...(two.sheets ?? [])]).toEqual(['沈砚'])
    const sheet = (await project.findCharacter(card.id))!.visual!.sheet!
    for (const scene of [one, two]) expect(scene.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true }])

    // Turned off: a portrait is drawn from what there is, and no sheet with it.
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, sheetFirst: false } })
    const other = await project.saveCharacter({ name: '阿棠', role: 'supporting', appearance: '圆脸', visual: { prompt: 'round-faced girl' } })
    const before = images.calls.length
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: other.id }, task)
    expect(portrait.sheets).toBeUndefined()
    expect(images.calls).toHaveLength(before + 1)
    expect((await project.findCharacter(other.id))!.visual?.sheet).toBeUndefined()
  })

  it('sorts what the author jotted down: what is of the person goes into their appearance, what is of this one picture directs it and is kept nowhere', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦，黑发盘在脑后。', visual: { negative: 'halo' } })
    const sheet = await project.writeAsset('images/sheet-kept.png', new Uint8Array([1]))
    await project.saveCharacter({ id: card.id, visual: { sheet } })
    // The sheet is on record as drawn from how she looked then — before the scar.
    await project.addIllustration({ id: 'img-sheet-kept', path: sheet, kind: 'sheet', target: card.id, prompt: 'sheet', createdAt: new Date().toISOString(), parts: { subject: 'sheet', pieces: [{ of: 'look', text: '高瘦，黑发盘在脑后', from: 'card', name: '沈砚' }] } })
    const SCARRED = '高瘦，黑发盘在脑后，左眉有一道旧疤，常年穿一件灰布袍。'
    const WORKED = '用途：小说人物立绘（定妆照）：只画「沈砚」一个人\n画面：她回头看向身后，肩上落着雪\n环境：雪夜，远处一点灯火\n构图：半身像\n人物「沈砚」：高瘦，黑发盘在脑后，左眉有一道旧疤，常年穿一件灰布袍\n参考图：图1 是沈砚；脸和体型照图'
    const sorting = (): string => JSON.stringify({
      appearance: SCARRED,
      negative: 'halo',
      picture: '雪夜，回头看向身后',
      kept: ['左眉有道疤', '常年灰布袍'],
      once: ['雪夜', '回头看'],
      unused: [],
    })
    // (Two things are asked of the director: to sort the notes, and — what is of this one picture — to work it into the prompt.)
    const writes = (request: { prompt: string }): boolean => request.prompt.includes('下面是工坊排好的画图说明')
    bed.llm.responder = request => (writes(request) ? JSON.stringify({ prompt: WORKED }) : sorting())
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, notes: '左眉有道疤，常年穿灰布袍；这张要雪夜，回头看' }, task)
    // The director was handed the notes, her appearance as it stood, and what kind of picture is about to be drawn.
    const asked = bed.llm.requests.find(request => !writes(request))!.prompt
    for (const part of ['左眉有道疤，常年穿灰布袍；这张要雪夜，回头看', '## 这个人现在的外貌（写手照它写，每一张有此人的图也照它画）\n高瘦，黑发盘在脑后。', '立绘：画的是这个人在书里的一幕', '不要添构图、景别这类他没说的', '"appearance": "分完之后的整段外貌']) expect(asked, part).toContain(part)
    expect(asked).not.toContain('视觉锚点')
    expect(portrait.sorted).toEqual({ kept: ['左眉有道疤', '常年灰布袍'], once: ['雪夜', '回头看'], unused: [], picture: '雪夜，回头看向身后' })
    // Of the person: in their appearance from now on — the one text the writer reads and every picture goes by.
    const after = (await project.findCharacter(card.id))!
    expect(after.appearance).toBe(SCARRED)
    expect(after.visual?.prompt).toBeUndefined()
    expect(after.visual?.sheet).toBe(sheet)
    // Of this picture: in this picture — and nowhere in the look. It is not put beside the other lines as one more:
    // whoever writes the prompt is handed it as what the author asked, and works it into the parts it speaks of.
    expect(portrait.parts?.subject).toContain('雪夜，回头看向身后')
    const working = bed.llm.requests.find(writes)!.prompt
    expect(working).toContain('## 作者对这一张的要求（说明里照原话带着它，在「这一张的要求」或「画面」那一行）\n雪夜，回头看向身后')
    expect(working).toContain('0. 作者的要求不是另加的一行，是要改进提示词里去的')
    expect(working).toContain('地点、时间、天气、光线：改「环境」')
    expect(working).toContain('只动它说到的那几段')
    expect(images.calls.at(-1)!.prompt).toContain(WORKED)
    expect(images.calls.at(-1)!.prompt).not.toContain('画面：雪夜，回头看向身后')
    expect(portrait.written).toContain('环境：雪夜，远处一点灯火')
    expect(portrait.sent?.compact).toMatchObject({ asked: true })
    expect(portrait.sent?.compact?.failed).toBeUndefined()
    // Her sheet goes along, but it was drawn before the scar: what the words now say of her is written out, not left to it.
    expect(portrait.parts?.subject).toContain('左眉有一道旧疤')
    expect(portrait.parts?.subject).not.toContain('纯净的浅色背景')
    expect(JSON.stringify(after)).not.toContain('雪夜')
    // The next portrait, asked for nothing in particular, has the scar and no snow — written out still: her sheet was
    // drawn from what she looked like before, and a line that only pointed to it would lose the scar.
    const written = bed.llm.requests.filter(writes).length
    const plain = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    // (Nothing was asked of it: its brief goes as laid out, and nobody writes it.)
    expect(bed.llm.requests.filter(writes)).toHaveLength(written)
    expect(plain.sent?.compact).toBeUndefined()
    expect(plain.sorted).toBeUndefined()
    expect(plain.parts?.subject).toContain('左眉有一道旧疤')
    expect(plain.parts?.subject).toContain('素净的浅色背景')
    expect(plain.parts?.subject).not.toContain('雪夜')

    // A design sheet has no night and no snow: nothing of it is drawn, and it is said that it was not used.
    bed.llm.responder = () => JSON.stringify({ appearance: SCARRED, negative: 'halo', picture: '', kept: [], once: [], unused: ['雪夜'] })
    const drawn = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, notes: '这张要雪夜' }, task)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('人设图（三视图）')
    expect(drawn.sorted).toEqual({ kept: [], once: [], unused: ['雪夜'] })
    expect(drawn.parts?.subject).not.toContain('雪夜')
    expect((await project.findCharacter(card.id))!.appearance).toBe(SCARRED)

    // A sheet she asks something of: the line is in the brief, and the director writes the prompt with it worked in —
    // "arms at the sides" and "a hand on the hilt" are not both said. A prompt handed in that still has the line is
    // not taken; one that will not come leaves the brief as it is, the line in the author's words, and the record says so.
    const HILT = '用途：人物设定图（三视图）：「沈砚」\n构图：同一个人的全身站姿画三次——正面、侧面、背面，右手按着腰间的刀柄，左手自然垂下\n人物「沈砚」：高瘦，黑发盘在脑后，左眉有一道旧疤，常年穿一件灰布袍，腰间佩一把短刀'
    let tries = 0
    bed.llm.responder = (request) => {
      if (!writes(request)) return JSON.stringify({ appearance: SCARRED, negative: 'halo', picture: '右手按着刀柄', kept: [], once: ['右手按着刀柄'], unused: [] })
      tries += 1
      return JSON.stringify({ prompt: tries === 1 ? `${HILT}\n这一张的要求：右手按着刀柄` : HILT })
    }
    const armed = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, notes: '右手按着刀柄' }, task)
    expect(tries).toBe(2)
    expect(armed.parts?.subject).toContain('这一张的要求：右手按着刀柄')
    expect(images.calls.at(-1)!.prompt).toContain(HILT)
    expect(images.calls.at(-1)!.prompt).not.toContain('这一张的要求')
    expect(armed.sent?.compact).toMatchObject({ asked: true })
    bed.llm.responder = (request) => { if (writes(request)) throw new Error('the director is away'); return JSON.stringify({ appearance: SCARRED, negative: 'halo', picture: '右手按着刀柄', kept: [], once: ['右手按着刀柄'], unused: [] }) }
    forgetFittedPrompts()
    const lined = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, notes: '右手按着刀柄' }, task)
    expect(images.calls.at(-1)!.prompt).toContain('这一张的要求：右手按着刀柄')
    expect(lined.sent?.compact).toMatchObject({ asked: true, failed: true })
    // Where the author has prompts never rewritten, this one is not either: the line goes as it is.
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, promptWrite: 'never' } })
    const asIs = bed.llm.requests.filter(writes).length
    bed.llm.responder = () => JSON.stringify({ appearance: SCARRED, negative: 'halo', picture: '右手按着刀柄', kept: [], once: ['右手按着刀柄'], unused: [] })
    const never = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, notes: '右手按着刀柄' }, task)
    expect(bed.llm.requests.filter(writes)).toHaveLength(asIs)
    expect(images.calls.at(-1)!.prompt).toContain('这一张的要求：右手按着刀柄')
    expect(never.sent?.compact).toBeUndefined()
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, promptWrite: 'fit' } })

    // A card of an earlier version, with phrases for image models beside the appearance: what the ideas change is
    // written into the appearance with those phrases folded in, and the phrases are gone.
    const old = await project.saveCharacter({ name: '顾七', appearance: '黑衣。', visual: { prompt: 'man in black, a long scarf' } })
    bed.llm.responder = () => JSON.stringify({ appearance: '黑衣，颈间一条长围巾，右手缺一指。', picture: '', kept: ['右手缺一指'], once: [], unused: [] })
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: old.id, notes: '右手缺一指' }, task)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('以前另写给绘图模型的短语（现在并进外貌；它和外貌说法不一样时以它为准）：man in black, a long scarf')
    expect((await project.findCharacter(old.id))!).toMatchObject({ appearance: '黑衣，颈间一条长围巾，右手缺一指。' })
    expect((await project.findCharacter(old.id))!.visual?.prompt).toBeUndefined()

    // Nobody to sort them: nothing is guessed — the notes direct this picture, the look stays as it is, and that is said.
    bed.llm.responder = () => { throw new Error('the model is away') }
    const calls = images.calls.length
    const unsorted = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, notes: '披一件红斗篷' }, task)
    expect(unsorted.sorted).toEqual({ kept: [], once: ['披一件红斗篷'], unused: [], picture: '披一件红斗篷', unsorted: true })
    expect(unsorted.parts?.subject).toContain('披一件红斗篷')
    expect(images.calls.at(-1)!.prompt).toContain('画面：披一件红斗篷')
    expect((await project.findCharacter(card.id))!.appearance).toBe(SCARRED)
    expect(images.calls).toHaveLength(calls + 1)
  })

  it('says, before anything is drawn, whose design sheets a picture would draw first — and draws none where the author says not this time', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const lead = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const once = await project.saveCharacter({ name: '卖花人', role: 'cameo', appearance: '挎着竹篮', visual: { prompt: 'flower seller with a basket' } })
    const blank = await project.saveCharacter({ name: '没写外貌的人', role: 'supporting' })
    const chapter = await project.addChapter({ title: '码头' })
    await project.saveChapterText(chapter.id, '沈砚在码头等船，卖花人从她身边走过，没写外貌的人站在远处。')
    const quote = '沈砚在码头等船，卖花人从她身边走过，没写外貌的人站在远处。'
    const names = async (asks: Parameters<typeof sheetsAhead>[2]) => (await sheetsAhead(bed.core, bed.runtime, asks)).people.map(person => person.name)
    // A portrait: whoever it is of, when they have none. A scene, a cover: those who come back — and have a look to draw a sheet from.
    expect(await names([{ kind: 'portrait', target: once.id }])).toEqual(['卖花人'])
    expect(await names([{ kind: 'scene', target: chapter.id, quote }])).toEqual(['沈砚'])
    expect(await names([{ kind: 'cover' }])).toEqual(['沈砚'])
    expect(await names([{ kind: 'custom', characters: [lead.id, once.id, blank.id] }])).toEqual(['沈砚'])
    // Asked together, somebody is named once; a chapter with no storyboard cannot be told yet.
    const ahead = await sheetsAhead(bed.core, bed.runtime, [{ kind: 'scene', target: chapter.id, quote }, { kind: 'cover' }, { kind: 'portrait', target: once.id }, { kind: 'panels', chapter: chapter.id }])
    expect(ahead).toEqual({ people: [{ id: lead.id, name: '沈砚' }, { id: once.id, name: '卖花人' }], unknown: 1 })
    // Asking draws nothing.
    expect(images.calls).toHaveLength(0)

    // "Not this time": the picture is drawn from what there is.
    bed.llm.responder = () => '{"picture": "码头上，沈砚望着靠岸的船", "people": ["沈砚"]}'
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, quote, sheetFirst: false }, task)
    expect(scene.sheets).toBeUndefined()
    expect(images.calls).toHaveLength(1)
    expect((await project.findCharacter(lead.id))!.visual?.sheet).toBeUndefined()
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: lead.id, sheetFirst: false }, task)
    expect(portrait.sheets).toBeUndefined()
    expect(images.calls).toHaveLength(2)
    // Asked again, she is still without one — and with the setting off nobody is.
    expect(await names([{ kind: 'scene', target: chapter.id, quote }])).toEqual(['沈砚'])
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, sheetFirst: false } })
    expect(await names([{ kind: 'scene', target: chapter.id, quote }, { kind: 'portrait', target: once.id }])).toEqual([])
  })

  it('draws a portrait in one of the person\'s signature scenes, which the director finds in the book', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '黛玉', role: 'protagonist', appearance: '两弯似蹙非蹙罥烟眉', personality: '敏感', visual: { prompt: 'slight girl of twelve, fine arched brows' } })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const gate = await project.saveWorld({ name: '沁芳闸', category: 'location', visualPrompt: '石闸，水边桃树' })
    const art = await illustrate(bed.core, bed.runtime, { kind: 'location', target: gate.id }, task)
    const asked = (): string => bed!.llm.requests.at(-1)!.prompt
    const sceneAsks = (): number => bed!.llm.requests.filter(request => request.prompt.includes('名场面')).length

    // A book with nothing written has no moment to pick: nobody is asked, and the portrait is the plain one.
    const blank = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(sceneAsks()).toBe(0)
    expect(blank.scene).toBeUndefined()
    expect(blank.parts?.pieces?.map(piece => piece.of)).toEqual(['use', 'frame', 'look', 'expression'])
    expect(blank.prompt).toContain('面向镜头，素净的浅色背景')

    // With a text to pick from, the director is handed what the digests noted of them — leads into the text — and how
    // they look, and picks the moment.
    const first = await project.addChapter({ title: '入府' })
    const second = await project.addChapter({ title: '葬花' })
    await project.saveChapterText(first.id, '黛玉进了荣府。')
    await project.saveChapterText(second.id, '黛玉在沁芳闸旁，肩上担着花锄，锄上挂着纱囊，手内拿着花帚。')
    await project.saveMemory({ schema: 1, chapterId: second.id, textHash: 'x', updatedAt: '', brief: '', summary: '葬花', facts: [], newEntities: [], threads: [], characters: [{ character: card.id, name: '黛玉', role: '在沁芳闸葬花', location: '沁芳闸' }] })
    const BURY = '暮春，沁芳闸旁，她肩荷花锄，锄上挂着纱囊，手执花帚，落花满地，侧身垂目。'
    const READ = '桃花树下，石上摊开一卷书，她低头看得入神。'
    // A moment is kept as the book tells it; for its picture the director makes one frame of it — the instant, what she
    // has on in it, what is around her — out of the text around the moment.
    const SHOT = { action: '她肩荷花锄，侧身垂目立在花冢前，一手执花帚', outfit: '月白绫袄，青缎背心，白绫细折裙，鬓边一朵素花', look: '', setting: '暮春傍晚，沁芳闸旁的桃林，落花满地，斜光从水面上来', people: [], place: '沁芳闸', things: [], why: '穿戴照第 2 章开头' }
    const framing = (prompt: string): boolean => prompt.includes('请把它整理成一格画面')
    const frames = (): string[] => bed!.llm.requests.filter(request => framing(request.prompt)).map(request => request.prompt)
    const framed = (prompt: string): string => JSON.stringify(prompt.includes('会真记') ? { action: '她低头看石上摊开一卷《会真记》', setting: '桃花树下' } : prompt.includes('共读西厢') ? { action: '她低头看石上摊开一卷书', setting: '桃花树下，落红成阵' } : SHOT)
    bed.llm.responder = request => (framing(request.prompt) ? framed(request.prompt) : JSON.stringify({ scenes: [{ title: '葬花', chapter: 2, scene: BURY, why: '全书里只有她做这件事' }, { title: '共读西厢', chapter: 1, scene: READ, why: '她与书' }] }))
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    const task1 = bed.llm.requests.find(request => request.prompt.includes('名场面'))!.prompt
    for (const part of ['「黛玉」', 'slight girl of twelve, fine arched brows', '第 2 章《葬花》：在沁芳闸葬花（沁芳闸）', '还有 1 章有正文但没有收录', '只从这本书里找', '不要编', '有几幕算几幕', '按分量从重到轻排', '这个人是主体', '别人只作陪衬', '写一个定格的瞬间，不是一段经过']) expect(task1, part).toContain(part)
    // Which moments are fit to be shown is the author's to say — the avoid list, what they ask — and no kind of moment
    // is ruled out by the task: a martyr's portrait may be the martyrdom, a general's the thick of the fight.
    for (const banned of ['施暴', '受刑', '病危', '死状', '厮打']) expect(task1, banned).not.toContain(banned)
    // Nothing was asked: there is no guidance to speak of.
    expect(task1).not.toContain('作者的要求是给你的引导')
    // The moments are kept on the card, the most theirs first, each with the chapter it is from; the result says they
    // were found just now, and which one was drawn.
    const found = scenesOf((await project.findCharacter(card.id))!)
    expect(found.map(scene => [scene.title, scene.chapter, scene.text])).toEqual([['葬花', second.id, BURY], ['共读西厢', first.id, READ]])
    const shot = { action: SHOT.action, outfit: SHOT.outfit, setting: SHOT.setting, place: '沁芳闸', why: SHOT.why, of: shotKey(BURY) }
    expect(portrait.scene).toEqual({ text: BURY, title: '葬花', id: found[0]!.id, chapter: second.id, found: 2, why: '全书里只有她做这件事', shot })
    // The director was handed the moment, the paragraph of the chapter that tells it, who she is and how she usually
    // looks, and what of the bible is named there; what she wears is asked for as the text has it.
    expect(frames()).toHaveLength(1)
    for (const part of ['「黛玉」', `## 这一幕\n葬花：${BURY}`, '第 2 章《葬花》', '## 正文：讲到这一幕的地方\n黛玉在沁芳闸旁，肩上担着花锄', 'slight girl of twelve, fine arched brows', '沁芳闸（location）', 'outfit：这个人此刻的穿戴', '查过仍然没有另外交代，就是平常那一身', 'setting：周围的环境', '写一个定格的瞬间']) expect(frames()[0], part).toContain(part)
    // The frame stays beside the moment: it is what the next picture of it is drawn from, until the moment is told otherwise.
    expect(found[0]!.shot).toEqual(shot)
    expect(shotOf(found[0]!)).toEqual(shot)
    // The portrait: the person is still what the picture is of; their look as the anchor has it; then the moment. No
    // "facing the viewer, plain ground", and no expression read off their temperament beside a moment that has its own.
    // What the picture is of comes first — the moment, in so many words —, then how it is framed, then who is in it and
    // how they look, then the place: a line each.
    // …the instant as the director framed it (the moment as it is told stays on the record beside it, unsent), what is
    // around her, how it is framed, who she is — and, under her name, what she has on in this moment.
    expect(portrait.parts?.pieces?.map(piece => piece.of)).toEqual(['use', 'scene', 'setting', 'frame', 'look', 'outfit', 'place'])
    expect(portrait.parts?.pieces?.[0]).toMatchObject({ label: '用途：', text: '小说人物立绘：「黛玉」的名场面' })
    expect(portrait.parts?.pieces?.[1]).toEqual({ of: 'scene', label: '画面：', text: SHOT.action, from: 'card', told: `葬花：${BURY}` })
    expect(portrait.parts?.pieces?.[2]).toEqual({ of: 'setting', label: '环境：', text: SHOT.setting, from: 'shot' })
    // The framing says who the picture is of and how much of them — and gives the model no instruction beside it.
    expect(portrait.parts?.pieces?.[3]).toEqual({ of: 'frame', label: '构图：', text: '以「黛玉」为主体，半身到七分身，脸看得清' })
    expect(portrait.prompt).not.toContain('谁在做什么')
    // Her sheet goes along and says what the words say: her line points to it.
    expect(portrait.parts?.pieces?.[4]).toMatchObject({ label: '人物「黛玉」：', text: '见图1', byPicture: true })
    expect(portrait.parts?.pieces?.[5]).toEqual({ of: 'outfit', label: '「黛玉」此刻穿着：', text: SHOT.outfit, from: 'shot', name: '黛玉' })
    expect(portrait.prompt.split('\n').slice(0, 6)).toEqual(['用途：小说人物立绘：「黛玉」的名场面', `画面：${SHOT.action}`, `环境：${SHOT.setting}`, '构图：以「黛玉」为主体，半身到七分身，脸看得清', '人物「黛玉」：见图1', `「黛玉」此刻穿着：${SHOT.outfit}`])
    // (Which moment the picture is of is still read off its record: by the moment as told, not by the frame that was sent.)
    expect(sceneOfPicture(found.map(scene => ({ ...scene, portrait: undefined })) as never, portrait.path, { parts: portrait.parts! })?.title).toBe('葬花')
    expect(portrait.prompt).not.toContain('面向镜头')
    expect(portrait.prompt).not.toContain('神态体现')
    // Held against the sheet, and — the moment names a place that has design art — against the place.
    expect(portrait.parts?.references).toEqual([{ path: sheet.path, label: '黛玉', sheet: true }, { path: art.path, label: '场所「沁芳闸」' }])
    expect(images.calls.at(-1)!.references).toHaveLength(2)
    // The portrait of a moment stays with the moment: the panel shows which have been drawn.
    expect(scenesOf((await project.findCharacter(card.id))!)[0]!.portrait).toBe(portrait.path)

    // Drawn again: the first of the card's moments is what is drawn; the director is not asked a second time.
    const asks = sceneAsks()
    const again = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(sceneAsks()).toBe(asks)
    // …nor for the frame: the one kept beside the moment is used.
    expect(frames()).toHaveLength(1)
    expect(again.scene).toEqual({ text: BURY, title: '葬花', id: found[0]!.id, chapter: second.id, shot })
    expect(again.prompt).toContain('肩荷花锄')
    // The author picks another of them for one portrait…
    const other = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, scene: found[1]!.id }, task)
    expect(other.prompt).toContain('石上摊开一卷书')
    expect(other.scene).toMatchObject({ title: '共读西厢', id: found[1]!.id })
    expect(scenesOf((await project.findCharacter(card.id))!).map(scene => scene.portrait)).toEqual([again.path, other.path])
    // …or marks it as the one portraits show; and rewrites its words on the card.
    await project.saveCharacter({ id: card.id, visual: { sceneAt: found[1]!.id, scenes: scenesOf((await project.findCharacter(card.id))!).map(scene => scene.id === found[1]!.id ? { ...scene, text: '桃花树下，石上摊开一卷《会真记》。' } : scene) } })
    // The moment is told otherwise now: the frame made of its old words is not its frame, and one is made anew.
    expect(shotOf(scenesOf((await project.findCharacter(card.id))!)[1]!)).toBeUndefined()
    expect(frames()).toHaveLength(2)
    expect((await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)).prompt).toContain('石上摊开一卷《会真记》')
    expect(frames()).toHaveLength(3)
    expect(scenesOf((await project.findCharacter(card.id))!)[1]!.shot).toMatchObject({ action: '她低头看石上摊开一卷《会真记》', of: shotKey('桃花树下，石上摊开一卷《会真记》。') })
    expect(sceneAsks()).toBe(asks)

    // Something asked of this one portrait does not take the moment's place: it guides the director, who is handed
    // the moments the card keeps — the one a portrait would show first — and what was asked, and settles and writes
    // the moment for this picture by it.
    // The frame of it is written in the same answer: the pick and its frame are one reading of the book.
    bed.llm.responder = () => JSON.stringify({ title: '葬花', chapter: 2, scene: '晴日正午，沁芳闸旁日光透亮，她肩荷花锄，落花满地。', action: '她肩荷花锄，回头望着落花', outfit: '', setting: '晴日正午，沁芳闸旁日光透亮，落花满地', why: '要明亮：改挑了白天的葬花' })
    const bright = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, prompt: '光线明亮些' }, task)
    expect(frames()).toHaveLength(3)
    expect(asked()).toContain('定下这一幕之后，再把它整理成一格画面')
    expect(asked()).toContain('"scene": "", "action": "", "outfit": ""')
    expect(asked()).toContain('## 人物卡上记着的名场面（第一幕是没有别的要求时立绘画的那一幕）\n1. 共读西厢（第 1 章）：桃花树下，石上摊开一卷《会真记》。\n2. 葬花（第 2 章）：')
    expect(asked()).toContain('## 作者对这一张立绘的要求\n光线明亮些')
    expect(asked()).toContain('作者的要求是给你的引导')
    expect(asked()).toContain('记着的第一幕合得上，就还用它，按要求调整')
    const brightShot = { action: '她肩荷花锄，回头望着落花', setting: '晴日正午，沁芳闸旁日光透亮，落花满地', why: '要明亮：改挑了白天的葬花', of: shotKey('晴日正午，沁芳闸旁日光透亮，她肩荷花锄，落花满地。') }
    expect(bright.scene).toEqual({ text: '晴日正午，沁芳闸旁日光透亮，她肩荷花锄，落花满地。', title: '葬花', chapter: second.id, asked: '光线明亮些', why: '要明亮：改挑了白天的葬花', shot: brightShot })
    // The picture is the moment as the director wrote it — what was asked is in it, not sent a second time — and its
    // record says what guided it.
    expect(bright.parts?.pieces?.map(piece => piece.of).slice(0, 5)).toEqual(['use', 'scene', 'setting', 'frame', 'look'])
    expect(bright.parts?.pieces?.[1]).toEqual({ of: 'scene', text: '她肩荷花锄，回头望着落花', label: '画面：', from: 'asked', asked: '光线明亮些', told: '葬花：晴日正午，沁芳闸旁日光透亮，她肩荷花锄，落花满地。' })
    // (Nothing said of what she wears: she is as her sheet has her, and no line says otherwise.)
    expect(bright.parts?.pieces?.some(piece => piece.of === 'outfit')).toBe(false)
    expect(bright.prompt).toContain('日光透亮')
    expect(bright.prompt).not.toContain('光线明亮些')
    // It was for this picture alone: the card keeps the moments it had, and no portrait is hung on one of them.
    const after = scenesOf((await project.findCharacter(card.id))!)
    expect(after.map(scene => scene.text)).toEqual([BURY, '桃花树下，石上摊开一卷《会真记》。'])
    expect(after.map(scene => scene.portrait)).not.toContain(bright.path)
    // No director to guide: what was asked is drawn as asked, as a portrait always was.
    bed.llm.responder = () => { throw new Error('no model') }
    const direct = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, prompt: '雪夜，回头看' }, task)
    expect(direct.scene).toMatchObject({ none: expect.stringContaining('导演没能定下来') })
    expect(direct.parts?.pieces?.map(piece => piece.of)).toEqual(['use', 'picture', 'frame', 'look', 'expression'])
    expect(direct.prompt).toContain('雪夜，回头看')
    expect(direct.prompt).not.toContain('共读西厢')
    // `plain` is what turns the moment off for one picture — the figure the interlude stage stands before a backdrop
    // of its own…
    const plain = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(plain.scene).toBeUndefined()
    expect(plain.prompt).toContain('面向镜头，素净的浅色背景')
    // …and the author's setting, for all of them: portraits are plain, and what is asked is drawn as asked, whatever
    // the card keeps and with nobody asked.
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, portraits: 'plain' } })
    const before = bed.llm.requests.length
    expect((await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)).prompt).toContain('面向镜头，素净的浅色背景')
    expect(bed.llm.requests.length).toBe(before)
    expect((await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, prompt: '雪夜' }, task)).prompt).toContain('用途：小说人物立绘（定妆照）：只画「黛玉」一个人\n画面：雪夜\n构图：半身像\n')
    // (Nobody picks a moment; what was asked of this one is handed to whoever writes its prompt, to be worked in.)
    expect(bed.llm.requests.length).toBe(before + 1)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('## 作者对这一张的要求（说明里照原话带着它，在「这一张的要求」或「画面」那一行）\n雪夜')
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, portraits: 'scene' } })

    // Looked over again on request, with what the author wants of the list: the ones kept go along; one that still
    // holds keeps its id and the portrait drawn of it, one the director drops is gone, a new one is added.
    bed.llm.responder = () => JSON.stringify({ scenes: [{ title: '焚稿', chapter: 2, scene: '病榻前，火盆里烧着诗稿。', why: '作者要的' }, { title: '葬花', chapter: 2, scene: BURY, why: '仍然是她', was: 1 }] })
    const anew = await deriveScenes(bed.core, bed.runtime, { character: card.id, direction: '要焚稿那一幕' }, task)
    expect(asked()).toContain('## 现在记着的名场面（作者让你重新看一遍）\n1. 葬花（第 2 章）：')
    expect(asked()).toContain('## 作者的要求\n要焚稿那一幕')
    expect(asked()).toContain('点名要的那一幕要有')
    expect(anew.scenes.map(scene => scene.title)).toEqual(['焚稿', '葬花'])
    expect(anew.scenes[1]).toMatchObject({ id: found[0]!.id, portrait: again.path, shot })
    expect(anew.scenes[0]!.portrait).toBeUndefined()
    // The one that was marked is gone with its moment: the first is what a portrait shows again.
    expect(anew.card.visual?.sceneAt).toBeUndefined()
    expect(sceneFor(anew.card)?.title).toBe('焚稿')

    // A card of an earlier version kept one paragraph: it is read as a list of one, named by how it began.
    const old = await project.saveCharacter({ name: '宝钗', role: 'supporting', appearance: '脸若银盆', visual: { prompt: 'calm girl', scene: '扑蝶（第 2 章）：滴翠亭外，她举着团扇追一双玉色蝴蝶。' } })
    expect(scenesOf(old)).toEqual([{ id: 'kept', title: '扑蝶', text: '滴翠亭外，她举着团扇追一双玉色蝴蝶。' }])
    // No frame can be had of it (the director answers something else): it is drawn of the moment as it is told, and
    // the picture says so — the framing still has no instruction to the model in it.
    const hers = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: old.id, sheetFirst: false }, task)
    expect(hers.prompt).toContain('画面：扑蝶：滴翠亭外')
    expect(hers.prompt).toContain('构图：以「宝钗」为主体，半身到七分身，脸看得清\n')
    expect(hers.scene).toMatchObject({ title: '扑蝶', unframed: expect.stringContaining('导演没能整理出这一刻的穿着和环境') })
    expect(hers.parts?.pieces?.find(piece => piece.of === 'scene')?.told).toBeUndefined()

    // Somebody the book has no moment for: the director says so, nothing is kept, the portrait is plain — and says why.
    const walkOn = await project.saveCharacter({ name: '卖花人', role: 'cameo', appearance: '挎着竹篮', visual: { prompt: 'flower seller with a basket' } })
    bed.llm.responder = () => JSON.stringify({ scenes: [], why: '只在第 1 章路过一次' })
    const theirs = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: walkOn.id, sheetFirst: false }, task)
    expect(theirs.scene).toEqual({ none: '只在第 1 章路过一次' })
    expect(scenesOf((await project.findCharacter(walkOn.id))!)).toEqual([])
    expect(theirs.prompt).toContain('面向镜头，素净的浅色背景')
    // No model to ask: the portrait is still drawn, plain, and the reason is the failure.
    bed.llm.responder = () => { throw new Error('no model') }
    const failed = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: walkOn.id, sheetFirst: false }, task)
    expect(failed.scene).toMatchObject({ none: expect.stringContaining('导演没能找出来') })
    expect(failed.prompt).toContain('面向镜头，素净的浅色背景')
  })

  it('puts a person\'s signature scenes together from what the digests noted, and reads the book again for nobody', async () => {
    const { bed, images } = await studio({ sheetFirst: false })
    const { project } = bed.runtime
    const { digestChapter } = await import('../src/core/pipelines/digest')
    const card = await project.saveCharacter({ name: '林黛玉', role: 'protagonist', appearance: '怯弱', visual: { prompt: 'slight girl of fifteen, pale, dark hair' } })
    const other = await project.saveCharacter({ name: '贾宝玉', role: 'protagonist', appearance: '少年', visual: { prompt: 'boy of fifteen, jade pendant' } })
    const first = await project.addChapter({ title: '共读' })
    const second = await project.addChapter({ title: '葬花' })
    await project.saveChapterText(first.id, '宝玉在沁芳闸桥边桃花底下看书，黛玉走来。')
    await project.saveChapterText(second.id, '黛玉肩上担着花锄，到花冢前葬花。')
    const notes = (scenes: unknown[]) => () => JSON.stringify({ brief: '一章', summary: '一章。', characters: [{ name: '林黛玉', role: '在场' }, { name: '贾宝玉', role: '在场' }], facts: [], threads: [], newEntities: [], scenes })
    // The digest of a chapter notes, as it reads it, a moment somebody would be remembered by: the task asks for it.
    bed.llm.responder = notes([{ name: '林黛玉', title: '共读西厢', picture: '桃花树下，她接过书坐在石上，落红成阵。', weight: 2 }, { name: '路人', title: '过桥', picture: '一个路人走过石桥，没有回头。', weight: 1 }])
    await digestChapter(bed.core, bed.runtime, first.id, task, { force: true })
    expect(bed.llm.requests.at(-1)!.prompt).toContain('"scenes": [')
    expect(bed.llm.requests.at(-1)!.prompt).toContain('多数章节一幕也没有')
    expect((await project.memory(first.id))!.scenes).toEqual([
      { character: card.id, name: '林黛玉', by: 'story', title: '共读西厢', text: '桃花树下，她接过书坐在石上，落红成阵。', weight: 2 },
      { character: '路人', name: '路人', title: '过桥', text: '一个路人走过石桥，没有回头。', weight: 1 },
    ])
    // It is on her card at once — nobody was asked for it.
    expect(scenesOf((await project.findCharacter(card.id))!)).toEqual([{ id: `noted-${first.id}`, title: '共读西厢', chapter: first.id, text: '桃花树下，她接过书坐在石上，落红成阵。', from: 'digest' }])
    expect(scenesOf((await project.findCharacter(other.id))!)).toEqual([])
    // A later chapter has the one the book remembers her by: it comes first.
    bed.llm.responder = notes([{ name: '林黛玉', title: '葬花', picture: '她肩担花锄，独自立在花冢前，落花满地。', weight: 3 }, { name: '贾宝玉', title: '听吟', picture: '他躲在山坡后，怀里兜着落花，听得痴了。', weight: 2 }])
    await digestChapter(bed.core, bed.runtime, second.id, task, { force: true })
    expect(scenesOf((await project.findCharacter(card.id))!).map(scene => [scene.title, scene.chapter, scene.from])).toEqual([['葬花', second.id, 'digest'], ['共读西厢', first.id, 'digest']])
    expect(scenesOf((await project.findCharacter(other.id))!).map(scene => scene.title)).toEqual(['听吟'])
    // A portrait asked for nothing shows the first of them — and no director is asked to find anything: only to make
    // the one frame of the moment the picture is drawn from.
    const asks = bed.llm.requests.length
    const noting = bed.llm.responder
    bed.llm.responder = () => JSON.stringify({ action: '她肩担花锄，独自立在花冢前', outfit: '素色衣裙', setting: '落花满地' })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    bed.llm.responder = noting
    expect(bed.llm.requests.slice(asks).map(request => request.prompt.includes('请把它整理成一格画面'))).toEqual([true])
    expect(portrait.prompt).toContain('肩担花锄')
    expect(portrait.scene).toMatchObject({ title: '葬花', chapter: second.id })
    expect(images.calls).toHaveLength(1)
    // The portrait drawn of a moment stays with it when the list is brought up to date…
    bed.llm.responder = notes([{ name: '林黛玉', title: '共读西厢', picture: '桃花树下，她接过书坐在石上，落红成阵。', weight: 2 }, { name: '林黛玉', title: '回头', picture: '她在桥头回头看了一眼。', weight: 1 }])
    await digestChapter(bed.core, bed.runtime, first.id, task, { force: true })
    const kept = scenesOf((await project.findCharacter(card.id))!)
    expect(kept.map(scene => scene.title)).toEqual(['葬花', '共读西厢', '回头'])
    expect(kept[0]!.portrait).toBe(portrait.path)
    // …and so does the frame made of it — and the list is the digests' still: a frame beside a moment is no change of the list.
    expect(shotOf(kept[0]!)).toMatchObject({ action: '她肩担花锄，独自立在花冢前', outfit: '素色衣裙' })
    expect(kept.every(scene => scene.from === 'digest')).toBe(true)
    // …for as long as nobody has taken the list in hand. A moment the author rewrote is theirs: the list is let be.
    await project.saveCharacter({ id: card.id, visual: { scenes: [{ id: kept[0]!.id, title: '葬花', chapter: second.id, text: '黄昏，她荷锄立在花冢前。', portrait: portrait.path }, { ...kept[1]! }] } })
    bed.llm.responder = notes([{ name: '林黛玉', title: '焚稿', picture: '她把诗稿一张张投进火盆。', weight: 3 }])
    await digestChapter(bed.core, bed.runtime, second.id, task, { force: true })
    expect(scenesOf((await project.findCharacter(card.id))!).map(scene => scene.title)).toEqual(['葬花', '共读西厢'])
    expect(scenesOf((await project.findCharacter(card.id))!)[0]!.text).toBe('黄昏，她荷锄立在花冢前。')
  })

  it('reads how a person grows along the book, and draws and tells them as the chapter has them', async () => {
    const { bed, images } = await studio()
    const { project, index } = bed.runtime
    // Which stretch holds at a chapter: the last one begun by then; one that begins off the line is another line's.
    const three: CharacterStage[] = [{ id: 'a', title: '幼年' }, { id: 'b', title: '少年', from: 'c3' }, { id: 'x', title: '别的线', from: 'zz' }]
    expect([undefined, 'c1', 'c2', 'c3', 'c4'].map(at => stageAt({ stages: three }, at, ['c1', 'c2', 'c3', 'c4'])?.title)).toEqual(['少年', '幼年', '幼年', '少年', '少年'])
    expect(stageAt({ stages: [{ id: 'b', title: '少年', from: 'c3' }] }, 'c1', ['c1', 'c2', 'c3'])).toBeUndefined()

    const card = await project.saveCharacter({ name: '宝玉', role: 'protagonist', appearance: '面若中秋之月，圆脸，穿大红袄' })
    const ids: string[] = []
    for (const title of ['入府', '读书', '入园', '出家']) ids.push((await project.addChapter({ title })).id)
    for (const id of ids) await project.saveChapterText(id, '宝玉在这里。')
    const memory = (chapterId: string, role: string) => ({ schema: 1 as const, chapterId, textHash: 'x', updatedAt: '', brief: '', summary: role, facts: [], newEntities: [], threads: [], characters: [{ character: card.id, name: '宝玉', role, state: '如常' }] })
    await project.saveMemory(memory(ids[0]!, '随贾母住'))
    await project.saveMemory(memory(ids[2]!, '搬进怡红院'))
    await project.updateChapter(ids[2]!, { time: '六年之后' })

    // The planner is handed the card, what the digests noted, and the book's own clock; it says how old they are as
    // they enter and where they turn.
    bed.llm.responder = () => JSON.stringify({ age: '约七岁（幼年）', stages: [
      { title: '幼年', chapter: 1, age: '约七岁（幼年）', what: '随贾母住' },
      { title: '少年', chapter: 3, age: '约十三岁（少年）', what: '搬进园子', appearance: '身量长开，束发戴冠', persona: '更任性' },
      { title: '', chapter: 4 },
    ] })
    const grown = await deriveGrowth(bed.core, bed.runtime, { character: card.id }, task)
    const asked = bed.llm.requests.at(-1)!.prompt
    for (const part of ['「宝玉」', '第 1 章：随贾母住', '第 3 章：六年之后', '2 章有正文但没有收录', '约十三岁（少年）', '时期不是情节', '不要凑数', '登场时的年纪']) expect(asked, part).toContain(part)
    // Kept on the card in the order they come: the one they enter in begins where they do; the card's own age is
    // filled in where it said none; a stretch with no name is not one.
    expect(grown.stages.map(stage => [stage.title, stage.from, stage.age])).toEqual([['幼年', undefined, '约七岁（幼年）'], ['少年', ids[2], '约十三岁（少年）']])
    expect(grown.card.age).toBe('约七岁（幼年）')
    const youth = grown.stages[1]!

    // The writer is told the stretch that holds at the chapter in hand — and nothing of a later one.
    const pack = async (id: string) => (await packContext(project, index, { purpose: 'draft', chapter: (await project.findChapter(id))!, textBudget: 50_000, sideBudget: 20_000, tailChars: 200 })).rest
    for (const id of ids) await project.updateChapter(id, { characters: [card.id] })
    expect(await pack(ids[1]!)).toContain('这一章时：幼年，约七岁（幼年）')
    expect(await pack(ids[1]!)).not.toContain('束发戴冠')
    expect(await pack(ids[3]!)).toContain('这一章时：少年，约十三岁（少年）；样子：身量长开，束发戴冠；为人：更任性')

    // The sheet of a stretch that looks different is drawn from the stretch's own words: where they are a note of what
    // changed, after how he usually looks — and nobody writes another text for the image model first.
    const main = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const asks = bed.llm.requests.length
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, stage: youth.id }, task)
    expect(bed.llm.requests.length).toBe(asks)
    expect(sheet.prompt).toContain('人物「宝玉」：面若中秋之月，圆脸，穿大红袄；少年：身量长开，束发戴冠，约十三岁（少年）')
    // Like the card's own sheet, it is drawn from the words alone: against the card's sheet it would come back as that sheet.
    expect(sheet.parts?.references ?? []).toEqual([])
    expect(images.calls.at(-1)!.references ?? []).toHaveLength(0)
    // Kept with the stretch; the card's own sheet is as it was.
    let after = (await project.findCharacter(card.id))!
    expect(after.stages![1]!.visual).toEqual({ sheet: sheet.path })
    expect(after.visual).toMatchObject({ sheet: main.path })
    // On request the director writes how he looks in that stretch whole, starting from the card's appearance: it
    // becomes the stretch's own appearance, and what a picture of the stretch goes by.
    bed.llm.responder = () => JSON.stringify({ appearance: '十三岁的少年，身量长开，面若中秋之月，束发戴小冠，穿大红箭袖袍，腰间系着五彩丝绦', negative: '幼童' })
    await deriveVisual(bed.core, bed.runtime, { character: card.id, stage: youth.id }, task)
    const brief = bed.llm.requests.at(-1)!.prompt
    for (const part of ['「少年」这个时期', '约十三岁（少年）', '这个时期已经记下的：身量长开，束发戴冠', '认得出是同一个人的特征', '面若中秋之月，圆脸，穿大红袄', '写成这个时期完整的外貌']) expect(brief, part).toContain(part)
    after = (await project.findCharacter(card.id))!
    expect(after.stages![1]!.appearance).toBe('十三岁的少年，身量长开，面若中秋之月，束发戴小冠，穿大红箭袖袍，腰间系着五彩丝绦')
    expect(after.stages![1]!.visual).toEqual({ sheet: sheet.path })
    expect(after.appearance).toBe('面若中秋之月，圆脸，穿大红袄')

    // A portrait of that stretch is drawn against that stretch's sheet and kept with it; the card's face stays the first.
    await project.saveCharacter({ id: card.id, visual: { portrait: 'assets/images/first.png' } })
    const calls = images.calls.length
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, stage: youth.id, plain: true }, task)
    expect(images.calls.length).toBe(calls + 1)
    expect(portrait.parts?.references).toEqual([{ path: sheet.path, label: '宝玉', sheet: true }])
    const kept = (await project.findCharacter(card.id))!
    expect(kept.stages![1]!.visual?.portrait).toBe(portrait.path)
    expect(kept.visual?.portrait).toBe('assets/images/first.png')
    // Whoever is drawn in a chapter is drawn as that chapter has them: a stretch whose words are a look by
    // themselves is drawn from those.
    const [early, late] = [await castAt(bed.runtime, ids[0], [kept]), await castAt(bed.runtime, ids[3], [kept])]
    expect([early[0]!.visual?.sheet, looksOf(early[0]!)]).toEqual([main.path, '面若中秋之月，圆脸，穿大红袄，约七岁（幼年）'])
    expect([late[0]!.visual?.sheet, late[0]!.age, looksOf(late[0]!)]).toEqual([sheet.path, '约十三岁（少年）', '十三岁的少年，身量长开，面若中秋之月，束发戴小冠，穿大红箭袖袍，腰间系着五彩丝绦，约十三岁（少年）'])
    // A stretch that only says what is different then is still who the card's sheet shows: the sheet goes along, the
    // words say the difference. (Its portrait is that stretch's to have.)
    const old = inStage(kept, { id: 'z', title: '老年', appearance: '须发皆白' })
    expect([old.appearance, old.visual?.sheet, old.visual?.portrait]).toEqual(['面若中秋之月，圆脸，穿大红袄；老年：须发皆白', main.path, undefined])
    // A stretch with a look of its own, written whole, and nothing drawn for it yet shows none of another time's pictures.
    const other = inStage(kept, { id: 'w', title: '出家之后', appearance: '剃了发的中年僧人，面容清瘦，眼窝深陷，披一领大红猩猩毡斗篷，赤着脚站在雪地里，神情空茫' })
    expect([other.appearance, other.visual?.sheet, other.visual?.portrait]).toEqual(['剃了发的中年僧人，面容清瘦，眼窝深陷，披一领大红猩猩毡斗篷，赤着脚站在雪地里，神情空茫', undefined, undefined])
    // (A stretch of an earlier version that still keeps phrases for image models is drawn from those, as it was.)
    expect(looksOf(inStage(kept, { id: 'y', title: '旧', appearance: '白发', visual: { prompt: 'old man, white hair' } }))).toBe('old man, white hair')

    // Looked over again: a stretch that still holds keeps its id and what was written and drawn of it.
    bed.llm.responder = () => JSON.stringify({ stages: [{ title: '幼年', chapter: 1, age: '七岁', was: 1 }, { title: '少年', chapter: 3, age: '十三岁', appearance: '身量长开，束发戴冠', was: 2 }, { title: '出家', chapter: 4, age: '十九岁', what: '离家' }] })
    const again = await deriveGrowth(bed.core, bed.runtime, { character: card.id, direction: '他十九岁出家' }, task)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('## 现在记着的时期（作者让你重新看一遍）\n1. 幼年（故事开始时） · 约七岁（幼年）')
    expect(bed.llm.requests.at(-1)!.prompt).toContain('## 作者的要求\n他十九岁出家')
    expect(again.stages.map(stage => stage.title)).toEqual(['幼年', '少年', '出家'])
    expect(again.stages[1]).toMatchObject({ id: youth.id, age: '十三岁', visual: { sheet: sheet.path, portrait: portrait.path } })
    // The card said an age already: it is the author's to change.
    expect(again.card.age).toBe('约七岁（幼年）')
  })

  it('draws a portrait after the sheet as the same person', async () => {
    const { bed, images } = await studio()
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect((await bed.runtime.project.findCharacter(card.id))!.visual).toMatchObject({ sheet: sheet.path, portrait: portrait.path })
  })
})

describe('what a picture is told, and what goes along with it', () => {
  it('draws a design sheet of the front view alone where the book says so, and holds pictures against it whole', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    // The book's own way with its pictures holds over the Studio's.
    await project.updateManifest({ image: { sheet: 'front' } })
    expect((await bed.core.imageOf(bed.runtime)).sheet).toBe('front')
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    expect(sheet.parts?.subject.split('\n')[0]).toBe('用途：人物设定图（正面全身）：「沈砚」')
    expect(sheet.parts?.subject.split('\n')[1]).toContain('构图：只画这一个人，一次——正面，全身站姿')
    expect(sheet.parts?.subject).not.toContain('三视图')
    // One figure stands: the sheet's shape, upright.
    expect(images.calls.at(-1)!.prompt).toContain('Portrait 2:3 composition.')
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ sheet: sheet.path, sheetFront: true })
    // A portrait held against it takes it as it is — there is no front view to cut out of one figure.
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(portrait.parts?.references).toEqual([{ path: sheet.path, label: '沈砚', sheet: false }])
    // Drawn again as the Studio has it — three views — the card says so no longer.
    await project.updateManifest({ image: { sheet: 'turn' } })
    const turned = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    expect(turned.parts?.subject).toContain('三视图')
    expect((await project.findCharacter(card.id))!.visual!.sheetFront).toBeUndefined()
  })

  it('draws a moment from the one frame the director makes of it: who is in it, what she wears there — one of her looks, or as the text has it — and what is around her', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '守灵' })
    await project.saveChapterText(chapter.id, '灵堂里白幔低垂。\n\n她一身重孝，跪在灵前，往盆里添纸。贾琏立在门边，没有进来。\n\n烛火晃了一下。')
    const feng = await project.saveCharacter({ name: '凤姐', role: 'protagonist', visual: { prompt: 'woman of twenty, phoenix eyes, gold hairpins', looks: [{ id: 'mourning', name: '丧服', when: '守灵', prompt: 'plain white mourning robe, hair unadorned' }], scenes: [{ id: 's1', title: '守灵', chapter: chapter.id, text: '她跪在灵前添纸，火光映着脸。' }] } })
    const lian = await project.saveCharacter({ name: '贾琏', role: 'supporting', visual: { prompt: 'man of twenty-five, dark robe' } })
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: feng.id }, task)
    const mourning = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: feng.id, look: '丧服' }, task)
    const his = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: lian.id }, task)
    images.calls.length = 0
    // The moment's own words name nobody else and say nothing of what she has on: the director read the passage.
    bed.llm.responder = () => JSON.stringify({ action: '她跪在灵前，低头往火盆里添纸；贾琏立在门边', outfit: '腰间系着麻绳', look: '丧服', setting: '夜里的灵堂，白幔低垂，烛火与火盆的光从下方照上来', people: ['贾琏', '没有卡的人'], place: '', things: [], why: '正文写她"一身重孝"' })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: feng.id }, task)
    const handed = bed.llm.requests.at(-1)!.prompt
    // What the director had to read it by: the paragraph that tells the moment with the text before and after it, her
    // looks by name, and who else the chapter has.
    for (const part of ['## 正文：这一幕之前（穿戴、地方多半在这里交代）\n灵堂里白幔低垂。', '## 正文：讲到这一幕的地方\n她一身重孝，跪在灵前，往盆里添纸。贾琏立在门边，没有进来。', '## 正文：紧接着\n烛火晃了一下。', '造型：「丧服」（守灵）：plain white mourning robe, hair unadorned', '贾琏｜supporting｜man of twenty-five, dark robe', '在 look 里写那身造型的名字']) expect(handed, part).toContain(part)
    // She is shown by the sheet of the look she wears there; what the text adds to it stands under her name. He is in
    // the frame — the director said so — and goes along as his sheet has him; somebody with no card is nobody's line.
    expect(portrait.parts!.subject.split('\n')).toEqual([
      '用途：小说人物立绘：「凤姐」的名场面',
      '画面：她跪在灵前，低头往火盆里添纸；贾琏立在门边',
      '环境：夜里的灵堂，白幔低垂，烛火与火盆的光从下方照上来',
      '构图：以「凤姐」为主体，半身到七分身，脸看得清；别的人只作陪衬',
      '人物「凤姐（丧服）」：见图1',
      '「凤姐」此刻穿着：腰间系着麻绳',
      '人物「贾琏」（陪衬）：见图2',
    ])
    expect(portrait.parts?.references?.map(reference => reference.path)).toEqual([mourning.path, his.path])
    expect(images.calls).toHaveLength(1)
    // Where no picture of her goes along, she is written out — in that look — and what she wears there follows.
    const words = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: feng.id, from: 'words' }, task)
    expect(words.parts!.subject.split('\n').slice(4, 6)).toEqual(['人物「凤姐（丧服）」：woman of twenty, phoenix eyes, gold hairpins，plain white mourning robe, hair unadorned', '「凤姐」此刻穿着：腰间系着麻绳'])
    // The author changes the frame on the card — it is theirs to change —: the next picture is drawn from it as changed,
    // and nobody is asked.
    const asks = bed.llm.requests.length
    const kept = scenesOf((await project.findCharacter(feng.id))!)
    await project.saveCharacter({ id: feng.id, visual: { scenes: kept.map(scene => ({ ...scene, shot: { ...scene.shot!, outfit: '', look: '', setting: '雪后的院子' } })) } })
    const changed = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: feng.id }, task)
    expect(bed.llm.requests.length).toBe(asks)
    expect(changed.parts!.subject.split('\n').slice(2, 6)).toEqual(['环境：雪后的院子', '构图：以「凤姐」为主体，半身到七分身，脸看得清；别的人只作陪衬', '人物「凤姐」：见图1', '人物「贾琏」（陪衬）：见图2'])
    // A frame is no version of the card: with one made, changed or cleared, the card says what it said.
    const now = (await project.findCharacter(feng.id))! as unknown as Record<string, unknown>
    const bare = { ...now, visual: { ...(now.visual as Record<string, unknown>), scenes: scenesOf(now as never).map(({ shot: _shot, ...scene }) => scene) } }
    expect(changedFields('character', bare, now)).toEqual([])
  })

  it('says a moment first, then who is in it — the others its words name, each by how they look — and takes their pictures along; sheets it waits for are drawn side by side', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '共读' })
    await project.saveChapterText(chapter.id, '宝玉和黛玉在桃花树下看一本《会真记》。')
    const lin = await project.saveCharacter({ name: '黛玉', role: 'protagonist', visual: { prompt: 'slight girl, fine arched brows', scenes: [{ id: 's1', title: '共读西厢', chapter: chapter.id, text: '桃花树下，黛玉接过宝玉手里的《会真记》，低头看得入神。' }] } })
    const jia = await project.saveCharacter({ name: '宝玉', role: 'protagonist', visual: { prompt: 'boy in a crimson jacket, jade at the collar' } })
    const book = await project.saveWorld({ name: '会真记', category: 'item', importance: 2, visualPrompt: '线装薄册，蓝布封面' })
    const art = await illustrate(bed.core, bed.runtime, { kind: 'item', target: book.id }, task)
    images.calls.length = 0
    // Neither has a sheet: both are drawn before the portrait — started together, neither waiting for the other.
    const started: string[] = []
    const draw = images.bridges.codex!
    let release!: () => void
    const both = new Promise<void>((resolve) => { release = resolve })
    images.bridges.codex = async (prompt, options) => {
      if (prompt.includes('人物设定图')) {
        started.push(prompt.includes('黛玉') ? '黛玉' : '宝玉')
        if (started.length === 2) release()
        // Drawn one after the other, the second would never start: this waits for both.
        await both
      }
      return await draw(prompt, options)
    }
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: lin.id }, task)
    expect(started.sort()).toEqual(['宝玉', '黛玉'])
    expect(portrait.sheets?.sort()).toEqual(['宝玉', '黛玉'])
    // The brief, a line a part, in the order every picture is said in: what it is for, the moment, the framing, her,
    // him (secondary), the thing. Their sheets go along: each of them is pointed to in theirs.
    const lines = portrait.parts!.subject.split('\n')
    expect(lines[0]).toBe('用途：小说人物立绘：「黛玉」的名场面')
    expect(lines[1]).toBe('画面：共读西厢：桃花树下，黛玉接过宝玉手里的《会真记》，低头看得入神')
    expect(lines[2]).toContain('构图：以「黛玉」为主体')
    expect(lines[2]).toContain('别的人只作陪衬')
    expect(lines[3]).toBe('人物「黛玉」：见图1')
    expect(lines[4]).toBe('人物「宝玉」（陪衬）：见图2')
    expect(lines[5]).toBe('物件「会真记」：线装薄册，蓝布封面')
    expect(portrait.prompt).toContain('参考图：图1 是黛玉；图2 是宝玉；图3 是物品「会真记」。')
    // Somebody who has a sheet is never drawn one again for a picture that has them in it — whatever a stretch of
    // their life says of them. He has stretches now, each with a word of how he is then: read at the moment's chapter
    // his card shows that stretch, and his sheet is still the one he has. (Drawn again for every portrait of hers, it
    // would be a new main sheet each time.)
    const sheetsOfHis = (await project.findCharacter(jia.id))!.visual?.sheet
    await project.saveCharacter({ id: jia.id, stages: [{ id: 'weak', title: '病中', appearance: '清减了些，面色发白' }, { id: 'well', title: '病愈', from: chapter.id, appearance: '气色好了，腰间多了一块玉' }] })
    const drawnBefore = images.calls.length
    const again = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: lin.id }, task)
    expect(images.calls.length).toBe(drawnBefore + 1)
    expect(again.sheets).toBeUndefined()
    expect((await project.findCharacter(jia.id))!.visual?.sheet).toBe(sheetsOfHis)
    expect((await project.findCharacter(jia.id))!.visual?.sheets).toBeUndefined()
    // His sheet goes along, and what is different in this stretch is said in words.
    expect(again.parts?.references?.map(reference => reference.path)).toContain(sheetsOfHis)
    expect(again.parts!.subject).toContain('病愈：气色好了，腰间多了一块玉')
    await project.saveCharacter({ id: jia.id, stages: [] })
    // The author has looks written out every time: both are, each under their name, with their pictures along all the same.
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, looks: 'always' } })
    const written = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: lin.id }, task)
    expect(written.parts!.subject.split('\n').slice(3, 5)).toEqual(['人物「黛玉」：slight girl, fine arched brows', '人物「宝玉」（陪衬）：boy in a crimson jacket, jade at the collar'])
    expect(written.parts?.references).toHaveLength(3)
    // Held against her sheet, his, and the thing's own art.
    const now = await project.characters()
    expect(portrait.parts?.references).toEqual([
      { path: now.find(card => card.id === lin.id)!.visual!.sheet, label: '黛玉', sheet: true },
      { path: now.find(card => card.id === jia.id)!.visual!.sheet, label: '宝玉', sheet: true },
      { path: art.path, label: '物品「会真记」' },
    ])
  })

  it('leaves the art of the things a panel shows behind where the author says so', async () => {
    const { panelMakings } = await import('../src/core/pipelines/illustrate')
    const { bed } = await studio()
    const { project } = bed.runtime
    const pen = await project.saveWorld({ name: '寄死笔', category: 'item', importance: 2, visualPrompt: '前清旧笔，笔杆发乌', visualImage: 'assets/images/pen.png' })
    const world = await project.world()
    const panel = { prompt: '她取出寄死笔', description: '她取出寄死笔', characters: [], things: [pen.name] }
    expect(panelMakings(panel, { characters: [], world, most: 3, lang: 'zh' }).references).toEqual([{ path: 'assets/images/pen.png', label: '物品「寄死笔」' }])
    const without = panelMakings(panel, { characters: [], world, most: 3, lang: 'zh', thingArt: false })
    expect(without.references).toEqual([])
    // What it looks like is still said.
    expect(without.subject).toContain('物件「寄死笔」：前清旧笔，笔杆发乌')
  })
})

describe('which picture of a person leads', () => {
  it('reads the settings: the sheet where they say nothing, and the old switch as "neither"', async () => {
    const { leadOf } = await import('../src/shared/images')
    expect(leadOf({})).toBe('sheet')
    expect(leadOf({ sheetFirst: false })).toBe('none')
    expect(leadOf({ lead: 'portrait', sheetFirst: false })).toBe('portrait')
    expect(leadOf({ lead: 'none' })).toBe('none')
  })

  it('lets the portrait lead: drawn from the words alone, and the sheet after it, against it', async () => {
    const { bed, images } = await studio({ lead: 'portrait' })
    const { project } = bed.runtime
    const { sheetsAhead } = await import('../src/core/pipelines/comic')
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    // Asked before anything is drawn: the sheet comes after the portrait, not before it.
    expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'portrait', target: card.id }])).toEqual({ people: [{ id: card.id, name: '沈砚' }], unknown: 0, after: true })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(images.calls).toHaveLength(2)
    // The portrait: nothing to be held against. Then the sheet: her portrait, and what it is there for.
    expect(images.calls[0]!.prompt).toContain('人物立绘')
    expect(images.calls[0]!.references).toHaveLength(0)
    expect(images.calls[1]!.prompt).toContain('人物设定图')
    expect(images.calls[1]!.references).toHaveLength(1)
    expect(images.calls[1]!.prompt).toContain('图1 是沈砚的立绘')
    expect(images.calls[1]!.prompt).toContain('背景、姿势、手里拿的东西、光线和构图都不要带过来')
    expect(portrait.sheetsAfter).toEqual(['沈砚'])
    expect(portrait.sheets).toBeUndefined()
    const made = (await project.findCharacter(card.id))!.visual!
    expect(made.portrait).toBe(portrait.path)
    const sheetRecord = (await project.illustrations()).find(item => item.path === made.sheet)!
    expect(sheetRecord.parts?.references).toEqual([{ path: portrait.path, label: '沈砚的立绘' }])
    // Drawn again, the portrait is still from the words alone — never against the sheet, or it could not change — and
    // the sheet there is stays as it is: nothing is redrawn behind the author's back.
    const again = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(images.calls).toHaveLength(3)
    expect(images.calls[2]!.references).toHaveLength(0)
    expect(again.sheetsAfter).toBeUndefined()
    expect((await project.findCharacter(card.id))!.visual!.sheet).toBe(made.sheet)
    // The sheet drawn again goes by the portrait in use now; "from the words" this once goes by none.
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    expect(images.calls[3]!.references).toHaveLength(1)
    expect((await project.illustrations()).at(-1)!.parts?.references?.[0]?.path).toBe(again.path)
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, from: 'words' }, task)
    expect(images.calls[4]!.references).toHaveLength(0)
    // "Not this time": the portrait alone.
    const other = await project.saveCharacter({ name: '阿棠', role: 'supporting', appearance: '圆脸', visual: { prompt: 'round-faced girl, two short braids' } })
    const alone = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: other.id, plain: true, sheetFirst: false }, task)
    expect(images.calls).toHaveLength(6)
    expect(alone.sheetsAfter).toBeUndefined()
    expect((await project.findCharacter(other.id))!.visual?.sheet).toBeUndefined()
    // A picture she is in still wants her sheet first — and it is drawn against the portrait she has.
    await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '她站在门口', characters: [other.id] }, task)
    expect(images.calls).toHaveLength(8)
    expect(images.calls[6]!.prompt).toContain('人物设定图')
    expect(images.calls[6]!.references).toHaveLength(1)
    expect(images.calls[7]!.references).toHaveLength(1)
  })

  it('draws a sheet against the portrait when asked to, though the sheet leads', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const kept = await project.writeAsset('images/portrait-kept.png', new Uint8Array([1]))
    const card = await project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', portrait: kept } })
    // By itself the sheet is from the words alone, as ever.
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    expect(images.calls[0]!.references).toHaveLength(0)
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, from: 'portrait' }, task)
    expect(images.calls[1]!.references).toHaveLength(1)
    expect((await project.illustrations()).at(-1)!.parts?.references).toEqual([{ path: kept, label: '沈砚的立绘' }])
  })

  it('draws one portrait against the sheet, or from the words alone, as the author says for that one — whichever leads', async () => {
    const { sheetsAhead } = await import('../src/core/pipelines/comic')
    // The sheet leads; this one portrait is asked for from the words alone: no sheet before it, and hers stays behind.
    {
      const { bed, images } = await studio()
      const { project } = bed.runtime
      const bare = await project.saveCharacter({ name: '阿棠', role: 'supporting', appearance: '圆脸', visual: { prompt: 'round-faced girl, two short braids' } })
      expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'portrait', target: bare.id }])).toEqual({ people: [{ id: bare.id, name: '阿棠' }], unknown: 0 })
      expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'portrait', target: bare.id, from: 'words' }])).toEqual({ people: [], unknown: 0 })
      const alone = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: bare.id, plain: true, from: 'words' }, task)
      expect(images.calls).toHaveLength(1)
      expect(images.calls[0]!.references).toHaveLength(0)
      expect(alone.sheets).toBeUndefined()
      expect((await project.findCharacter(bare.id))!.visual?.sheet).toBeUndefined()
      // …and then the sheet against that portrait: the way from a portrait the author likes to a sheet that matches it.
      await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: bare.id, from: 'portrait' }, task)
      expect(images.calls[1]!.references).toHaveLength(1)
      expect((await project.illustrations()).at(-1)!.parts?.references).toEqual([{ path: alone.path, label: '阿棠的立绘' }])
      // With a sheet there, "from the words" still leaves it behind.
      await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: bare.id, plain: true, from: 'words' }, task)
      expect(images.calls[2]!.references).toHaveLength(0)
      await bed.cleanup()
    }
    // The portrait leads; this one is asked for against the sheet: hers is drawn first — from the words, not against
    // the portrait she has, or the new portrait would only come back as the old — and nothing follows.
    {
      const { bed, images } = await studio({ lead: 'portrait' })
      const { project } = bed.runtime
      const kept = await project.writeAsset('images/portrait-kept.png', new Uint8Array([1]))
      const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', portrait: kept } })
      expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'portrait', target: card.id, from: 'sheet' }])).toEqual({ people: [{ id: card.id, name: '沈砚' }], unknown: 0 })
      const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true, from: 'sheet' }, task)
      expect(images.calls).toHaveLength(2)
      expect(images.calls[0]!.prompt).toContain('人物设定图')
      expect(images.calls[0]!.references).toHaveLength(0)
      expect(images.calls[1]!.prompt).toContain('人物立绘')
      expect(images.calls[1]!.references).toHaveLength(1)
      expect(portrait.sheets).toEqual(['沈砚'])
      expect(portrait.sheetsAfter).toBeUndefined()
      expect(portrait.parts?.references).toEqual([{ path: (await project.findCharacter(card.id))!.visual!.sheet, label: '沈砚', sheet: true }])
      await bed.cleanup()
    }
  })

  it('draws nothing for the sake of another picture where neither leads', async () => {
    const { bed, images } = await studio({ lead: 'none' })
    const { project } = bed.runtime
    const { sheetsAhead } = await import('../src/core/pipelines/comic')
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'portrait', target: card.id }, { kind: 'custom', characters: [card.id] }])).toEqual({ people: [], unknown: 0 })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(images.calls).toHaveLength(1)
    expect(portrait.sheets).toBeUndefined()
    expect(portrait.sheetsAfter).toBeUndefined()
    // A sheet that is there still goes along.
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
  })
})

describe('the pictures kept of somebody, and taking one away', () => {
  it('keeps every portrait drawn, the newest first; the author orders them and removes what they do not want', async () => {
    const { bed } = await studio({ sheetFirst: false })
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const first = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    // One portrait is one portrait: no list is kept for it.
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: first.path })
    expect((await project.findCharacter(card.id))!.visual!.portraits).toBeUndefined()
    const second = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    const third = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    // Drawn again, the one before stays: the newest is first, and is their face.
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: third.path, portraits: [third.path, second.path, first.path] })
    // The author's order: the first of it is the face.
    await project.saveCharacter({ id: card.id, visual: { portraits: [first.path, third.path, second.path] } })
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: first.path, portraits: [first.path, third.path, second.path] })
    // One taken away — the face itself: its file and its record go, and the next one is the face.
    expect(await project.removePicture({ path: first.path })).toEqual(['沈砚'])
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: third.path, portraits: [third.path, second.path] })
    expect((await project.illustrations()).map(item => item.path)).not.toContain(first.path)
    await expect(readFile(join(project.root, first.path))).rejects.toThrow()
    // By the id of its record, as the gallery names it; down to one, the list is not kept.
    const record = (await project.illustrations()).find(item => item.path === second.path)!
    expect(await project.removeIllustration(record.id)).toEqual(['沈砚'])
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: third.path })
    expect((await project.findCharacter(card.id))!.visual!.portraits).toBeUndefined()
    // The last one: nobody's face is a file that is gone.
    await project.removePicture({ path: third.path })
    expect((await project.findCharacter(card.id))!.visual?.portrait).toBeUndefined()
  })

  it('takes a picture off everything that shows it — a moment\'s portrait, a stretch\'s sheet, an entry\'s art, the cover — and no file that is not a picture', async () => {
    const { bed } = await studio()
    const { project } = bed.runtime
    const picture = async (name: string): Promise<string> => await project.writeAsset(`images/${name}.png`, new Uint8Array([1]))
    const [moment, aged, art, turn, cover] = [await picture('moment'), await picture('aged'), await picture('art'), await picture('turn'), await picture('cover')]
    const chapter = await project.addChapter({ title: '第一章' })
    const card = await project.saveCharacter({ name: '林黛玉', role: 'protagonist', visual: { portrait: moment, scenes: [{ id: 's1', title: '葬花', text: '她荷锄立在花冢前。', portrait: moment }] }, stages: [{ id: 'young', title: '幼年', visual: { sheet: aged, portrait: aged } } as CharacterStage] })
    const house = await project.saveWorld({ name: '贾府', category: 'faction', importance: 2, visualImage: art, events: [{ chapter: chapter.id, kind: 'decline', what: '抄家', image: turn }] })
    await project.updateManifest({ cover })
    expect(await project.removePicture({ path: moment })).toEqual(['林黛玉'])
    const after = (await project.findCharacter(card.id))!
    expect(after.visual?.portrait).toBeUndefined()
    expect(scenesOf(after)).toEqual([{ id: 's1', title: '葬花', text: '她荷锄立在花冢前。' }])
    expect(await project.removePicture({ path: aged })).toEqual(['林黛玉'])
    expect((await project.findCharacter(card.id))!.stages![0]!.visual).toBeUndefined()
    expect(await project.removePicture({ path: art })).toEqual(['贾府'])
    expect(await project.removePicture({ path: turn })).toEqual(['贾府'])
    const entry = (await project.findWorld(house.id))!
    expect(entry.visualImage).toBeUndefined()
    expect(entry.events).toEqual([{ chapter: chapter.id, kind: 'decline', what: '抄家' }])
    expect(await project.removePicture({ path: cover })).toHaveLength(1)
    expect((await project.manifest()).cover).toBeUndefined()
    // Not a way to remove any file of the book.
    await expect(project.removePicture({ path: 'novel.json' })).rejects.toThrow(/not one of the book's pictures/)
    await expect(project.removePicture({ path: 'assets/../outline.json' })).rejects.toThrow(/not one of the book's pictures/)
    await expect(project.removePicture({ path: `manuscript/${chapter.id}.md` })).rejects.toThrow(/not one of the book's pictures/)
  })

  it('keeps a moment that was drawn, with its picture, whatever the digests come to note of its chapter; the picture the author chooses stands for it', async () => {
    const { bed } = await studio({ sheetFirst: false })
    const { project } = bed.runtime
    const { digestChapter } = await import('../src/core/pipelines/digest')
    const { redrawPicture } = await import('../src/core/pipelines/illustrate')
    const { scenePictures, sceneOfPicture } = await import('../src/shared/art')
    const card = await project.saveCharacter({ name: '林黛玉', role: 'protagonist', appearance: '怯弱', visual: { prompt: 'slight girl of fifteen, pale, dark hair' } })
    const chapter = await project.addChapter({ title: '葬花' })
    await project.saveChapterText(chapter.id, '林黛玉肩上担着花锄。\n\n她到花冢前葬花，落花满地。')
    const notes = (scenes: unknown[]) => () => JSON.stringify({ brief: '一章', summary: '一章。', characters: [{ name: '林黛玉', role: '在场' }], facts: [], threads: [], newEntities: [], scenes })
    bed.llm.responder = notes([{ name: '林黛玉', title: '葬花', picture: '她肩担花锄，独自立在花冢前，落花满地。', weight: 3 }])
    await digestChapter(bed.core, bed.runtime, chapter.id, task, { force: true })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    const scenes = async () => scenesOf((await project.findCharacter(card.id))!)
    expect(await scenes()).toMatchObject([{ id: `noted-${chapter.id}`, title: '葬花', portrait: portrait.path }])
    // The chapter digested again: another moment of hers comes before it, and takes the number it had. The picture
    // goes with the moment it is of — by its name — not with the number.
    bed.llm.responder = notes([{ name: '林黛玉', title: '担锄', picture: '她肩上担着花锄走过沁芳闸。', weight: 3 }, { name: '林黛玉', title: '葬花', picture: '她在花冢前埋下落花。', weight: 3 }])
    await digestChapter(bed.core, bed.runtime, chapter.id, task, { force: true })
    expect((await scenes()).map(scene => [scene.id, scene.title, scene.portrait])).toEqual([[`noted-${chapter.id}`, '担锄', undefined], [`noted-${chapter.id}-2`, '葬花', portrait.path]])
    // …and what says which moment a picture is of reads the same way: the record still names the old number.
    const records = async () => new Map((await project.illustrations()).map(record => [record.path, record]))
    expect(sceneOfPicture(await scenes(), portrait.path, (await records()).get(portrait.path))?.title).toBe('葬花')
    // Digested once more, and the moment is not noted at all: it was drawn, so it stays — after what is noted now,
    // under a number of its own.
    bed.llm.responder = notes([{ name: '林黛玉', title: '担锄', picture: '她肩上担着花锄走过沁芳闸。', weight: 3 }])
    await digestChapter(bed.core, bed.runtime, chapter.id, task, { force: true })
    expect((await scenes()).map(scene => [scene.title, scene.portrait])).toEqual([['担锄', undefined], ['葬花', portrait.path]])
    expect(new Set((await scenes()).map(scene => scene.id)).size).toBe(2)
    // Stable: digested again, the list is as it was.
    const before = JSON.stringify(await scenes())
    await digestChapter(bed.core, bed.runtime, chapter.id, task, { force: true })
    expect(JSON.stringify(await scenes())).toBe(before)

    // Drawn again from its record, the new picture is the moment's — and both are pictures of it.
    const again = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, subject: '她荷锄立在花冢前，回头' }, task)
    const moment = (await scenes())[1]!
    expect(moment.portrait).toBe(again.path)
    const mine = (await project.findCharacter(card.id))!.visual!.portraits!
    expect(scenePictures(moment, await scenes(), mine, path => undefined)).toEqual([again.path])
    const byPath = await records()
    expect(scenePictures(moment, await scenes(), mine, path => byPath.get(path))).toEqual([again.path, portrait.path])
    expect(scenePictures((await scenes())[0]!, await scenes(), mine, path => byPath.get(path))).toEqual([])
    // In the text it is the moment's own picture that stands where the moment is told; the other is kept back.
    const places = async () => (await project.portraitPlaces()).filter(place => place.as === 'moment').map(place => [place.path, place.hidden])
    expect(await places()).toEqual([[again.path, false], [portrait.path, true]])
    // The author takes the first one after all: it is the moment's from then on — on the card, and in the text —
    // though it had been kept out of the text (as a picture drawn only to be compared is).
    await project.holdFigure(portrait.path, true)
    await project.setScenePicture(card.id, moment.id, portrait.path)
    await expect(project.setScenePicture(card.id, 'no-such-moment', portrait.path)).rejects.toThrow(/no signature scene/)
    expect(scenePictures((await scenes())[1]!, await scenes(), mine, path => byPath.get(path))).toEqual([portrait.path, again.path])
    expect(await places()).toEqual([[portrait.path, false], [again.path, true]])
    // (Choosing a picture is not taking the list in hand: it is still brought up to date from the digests, and keeps the choice.)
    bed.llm.responder = notes([{ name: '林黛玉', title: '担锄', picture: '她肩上担着花锄走过沁芳闸。', weight: 3 }, { name: '林黛玉', title: '葬花', picture: '她在花冢前埋下落花。', weight: 2 }])
    await digestChapter(bed.core, bed.runtime, chapter.id, task, { force: true })
    expect((await scenes()).map(scene => [scene.title, scene.portrait])).toEqual([['担锄', undefined], ['葬花', portrait.path]])
  })

  it('attaches a portrait to its moment on the card as the card is once the picture is there, not as it was before', async () => {
    const { bed, images } = await studio({ sheetFirst: false })
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '林黛玉', role: 'protagonist', appearance: '怯弱', visual: { prompt: 'slight girl', scenes: [{ id: 'scene-a', title: '葬花', text: '她肩担花锄，立在花冢前。' }, { id: 'scene-b', title: '焚稿', text: '她把诗稿投进火盆。' }] } })
    // While the picture is being drawn the list is changed under it: another moment is drawn, a third is added.
    const draw = images.bridges.codex!
    let once = true
    images.bridges.codex = async (prompt, options) => {
      if (once) {
        once = false
        await project.saveCharacter({ id: card.id, visual: { scenes: [{ id: 'scene-a', title: '葬花', text: '她肩担花锄，立在花冢前。' }, { id: 'scene-b', title: '焚稿', text: '她把诗稿投进火盆。', portrait: 'assets/images/other.png' }, { id: 'scene-c', title: '题帕', text: '她在旧帕上题诗。' }] } })
      }
      return await draw(prompt, options)
    }
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, scene: 'scene-a' }, task)
    expect(scenesOf((await project.findCharacter(card.id))!).map(scene => [scene.id, scene.portrait])).toEqual([['scene-a', portrait.path], ['scene-b', 'assets/images/other.png'], ['scene-c', undefined]])
    // The one paragraph an earlier card kept is a list of one once it is drawn, with its picture.
    const old = await project.saveCharacter({ name: '宝钗', role: 'supporting', appearance: '端方', visual: { prompt: 'calm girl', scene: '扑蝶（第27章）：她举着扇子追一双玉色蝴蝶。' } })
    const hers = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: old.id }, task)
    const now = (await project.findCharacter(old.id))!
    expect(now.visual?.scene).toBeUndefined()
    expect(scenesOf(now)).toMatchObject([{ title: '扑蝶', text: '她举着扇子追一双玉色蝴蝶。', portrait: hers.path }])
    expect(scenesOf(now)[0]!.id).not.toBe('kept')
  })

  it('takes in a portrait or a design sheet made elsewhere, and hangs it where one drawn here would be', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const { importPicture } = await import('../src/core/pipelines/illustrate')
    const chapter = await project.addChapter({ title: '雨夜' })
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', looks: [{ id: 'coat', name: '大衣', prompt: 'long grey coat' }], scenes: [{ id: 's1', title: '回头', chapter: chapter.id, text: '她在巷口回头。' }] }, stages: [{ id: 'young', title: '少年' }] })
    // (Pictures of a few bytes more than the one pixel: another file each.)
    const file = (tail: number): Uint8Array => Uint8Array.from([...PIXEL, ...new Array<number>(64).fill(tail)])
    // A portrait: among her portraits, first; on record as hers and as brought in — no prompt, nothing drawn.
    const face = await importPicture(bed.runtime, { kind: 'portrait', target: card.id, data: file(1) })
    expect(face.held).toEqual(['沈砚'])
    expect(face.info).toMatchObject({ kind: 'portrait', target: card.id, imported: true, prompt: '', size: '1x1' })
    expect(face.info.path).toMatch(/^assets\/images\/portrait-.+\.png$/)
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: face.info.path })
    expect((await project.illustrations()).filter(item => item.imported === true).map(item => item.path)).toEqual([face.info.path])
    // The same file again is the same picture: one file, one record.
    await importPicture(bed.runtime, { kind: 'portrait', target: card.id, data: file(1) })
    expect((await project.illustrations()).filter(item => item.imported === true)).toHaveLength(1)
    // A sheet: her main sheet — told as the front view alone by its shape (it is no wider than tall) — and what a
    // portrait drawn after it is held against, whole.
    const sheet = await importPicture(bed.runtime, { kind: 'sheet', target: card.id, data: file(2) })
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ sheet: sheet.info.path, sheetFront: true })
    const drawn = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(drawn.parts?.references).toEqual([{ path: sheet.info.path, label: '沈砚', sheet: false }])
    expect(images.calls).toHaveLength(1)
    // Of a look, of a stretch of her life, of one of her moments: each where it belongs.
    const coat = await importPicture(bed.runtime, { kind: 'sheet', target: card.id, look: '大衣', data: file(3), front: false })
    const young = await importPicture(bed.runtime, { kind: 'portrait', target: card.id, stage: 'young', data: file(4) })
    const moment = await importPicture(bed.runtime, { kind: 'portrait', target: card.id, scene: 's1', data: file(5) })
    const now = (await project.findCharacter(card.id))!
    expect(now.visual?.looks).toMatchObject([{ name: '大衣', prompt: 'long grey coat', sheet: coat.info.path }])
    expect(now.stages?.[0]?.visual?.portrait).toBe(young.info.path)
    expect(scenesOf(now)[0]).toMatchObject({ title: '回头', portrait: moment.info.path })
    expect(moment.info.moment).toEqual({ title: '回头', scene: 's1', chapter: chapter.id })
    // What is no picture, and whoever is nobody, is refused.
    await expect(importPicture(bed.runtime, { kind: 'portrait', target: card.id, data: new TextEncoder().encode('not a picture, whatever it is called, and long enough to be looked at for what it is') })).rejects.toThrow(/not a picture/)
    await expect(importPicture(bed.runtime, { kind: 'portrait', target: '没有这个人', data: file(6) })).rejects.toThrow(/no character/)
    await expect(importPicture(bed.runtime, { kind: 'sheet', target: card.id, look: '没有这身', data: file(7) })).rejects.toThrow(/no look/)
  })

  it('draws a picture again from its whole prompt as the author rewrote it: sent as it stands, with what they keep out and the pictures it had', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const { redrawPicture, pictureWhole } = await import('../src/core/pipelines/illustrate')
    await project.updateManifest({ artStyle: '水墨淡彩', artAvoid: ['文字', '水印'] })
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', negative: 'halo' } })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    const sheet = (await project.findCharacter(card.id))!.visual!.sheet!
    // Everything it was drawn from: the prompt whole — the picture, the art direction, what it says of the picture
    // that went along — and, apart from it, what was kept out (the book's list, and hers).
    const whole = await pictureWhole(bed.core, bed.runtime, portrait.id)
    expect(whole.prompt.split('\n')[0]).toBe('用途：小说人物立绘（定妆照）：只画「沈砚」一个人')
    expect(whole.prompt).toContain('画风：水墨淡彩')
    expect(whole.prompt).toContain('参考图：图1 是沈砚')
    expect(whole.prompt).not.toContain('不要出现')
    expect(whole.avoid).toEqual(['文字', '水印', 'halo'])
    expect(whole.references).toEqual([{ path: sheet, label: '沈砚' }])
    expect(whole.brief).toBeUndefined()
    // Rewritten — a line of the art direction changed for this one, one thing no longer kept out — it goes as it stands.
    const mine = whole.prompt.replace('画风：水墨淡彩', '画风：工笔重彩').replace('面向镜头', '侧身回头')
    const calls = images.calls.length
    const drawn = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: mine, avoid: ['文字', 'halo'] }, task)
    expect(images.calls).toHaveLength(calls + 1)
    // (This way to the model takes what is kept out in the prompt alone — its last line — and no size: one sentence on the frame after it.)
    expect(images.calls.at(-1)!.prompt).toBe(`${mine}\n不要出现：文字、halo\n\nSquare 1:1 composition.`)
    expect(images.calls.at(-1)!.prompt).not.toContain('水墨淡彩')
    expect(images.calls.at(-1)!.prompt.match(/参考图：/g)).toHaveLength(1)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect(drawn).toMatchObject({ kind: 'portrait', target: card.id, replaced: ['沈砚'], verbatim: true, prompt: `${mine}\n不要出现：文字、halo` })
    expect(drawn.parts).toMatchObject({ subject: mine, pieces: [{ of: 'composed', text: mine }], avoid: ['文字', 'halo'], references: [{ path: sheet, label: '沈砚', sheet: true }] })
    expect(drawn.parts?.style).toBeUndefined()
    expect((await project.findCharacter(card.id))!.visual!.portraits).toEqual([drawn.path, portrait.path])
    // Its own whole prompt is what the author wrote, and what they kept out.
    expect(await pictureWhole(bed.core, bed.runtime, drawn.id)).toMatchObject({ prompt: mine, avoid: ['文字', 'halo'], references: [{ path: sheet, label: '沈砚' }] })
    // What is kept out left unsaid: as it was. A prompt that lost its word of the picture gets the line back — a picture nothing explains is drawn into the scene.
    const bare = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: '她坐在灯下，半身像' }, task)
    expect(images.calls.at(-1)!.prompt).toMatch(/^她坐在灯下，半身像\n参考图：图1 是沈砚。.+\n不要出现：文字、水印、halo\n\nSquare 1:1 composition\.$/)
    expect(bare.parts?.avoid).toEqual(['文字', '水印', 'halo'])
    // The whole prompt goes alone: not with the picture's words, not with a change.
    await expect(redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: mine, change: '雪夜' }, task)).rejects.toThrow(/whole prompt/)

    // The pictures that go along are the author's to change with it. One added — another picture of the book — goes
    // after the one it had, and the line on which picture is which is said anew of both.
    const lamp = await project.writeAsset('images/lamp.png', PIXEL)
    const more = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: whole.prompt, references: [{ path: sheet }, { path: lamp, label: '那盏灯' }, { path: 'assets/images/no-such.png' }, { path: '../outside.png' }] }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(2)
    expect(more.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true }, { path: lamp, label: '那盏灯' }])
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：见图1')
    expect(images.calls.at(-1)!.prompt.match(/参考图：/g)).toHaveLength(1)
    expect(images.calls.at(-1)!.prompt).toContain('参考图：图1 是沈砚；图2 是那盏灯。')
    // Another order: what pointed to her picture points to where it stands now.
    const turned = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: whole.prompt, references: [{ path: lamp, label: '那盏灯' }, { path: sheet }] }, task)
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：见图2')
    expect(images.calls.at(-1)!.prompt).toContain('参考图：图1 是那盏灯；图2 是沈砚。')
    expect(turned.parts?.references?.map(reference => reference.path)).toEqual([lamp, sheet])
    // Her picture left out: she is written out again, from the words kept beside the pointer, and the other picture is the first.
    await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: whole.prompt, references: [{ path: lamp, label: '那盏灯' }] }, task)
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：lean woman, black hair')
    expect(images.calls.at(-1)!.prompt).not.toContain('见图')
    expect(images.calls.at(-1)!.prompt).toContain('参考图：图1 是那盏灯。')
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    // None at all: no picture goes, and the prompt says nothing of any.
    await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: whole.prompt, references: [] }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(0)
    expect(images.calls.at(-1)!.prompt).not.toContain('参考图')
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：lean woman, black hair')
    // Of a picture that is another one changed — it was sent that picture and a sentence — the whole prompt is the
    // brief it is drawn from in words: the picture, the art direction of the book as it is, the sheet it is held against.
    const changed = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, change: '背景换成雪夜' }, task)
    const told = await pictureWhole(bed.core, bed.runtime, changed.id)
    expect(told.prompt).toContain('这一张的要求：背景换成雪夜')
    expect(told.prompt).toContain('画风：水墨淡彩')
    expect(told.prompt).toContain('参考图：图1 是沈砚')
    expect(told.references).toEqual([{ path: sheet, label: '沈砚' }])
    expect(told.avoid).toEqual(['文字', '水印', 'halo'])
    // Her line only pointed to her sheet ("见图1"). Tried as it is where no picture can go along — a service that takes
    // none — she is written out again, from the words kept beside the pointer, and nothing speaks of pictures.
    const none = { label: 'takes none', image: { ...DEFAULT_SETTINGS.image, provider: 'codex' as const, references: 0 } }
    await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, trials: [none] }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(0)
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：lean woman, black hair')
    expect(images.calls.at(-1)!.prompt).not.toMatch(/见图1|参考图/)
    // …and pointed to again where her sheet does go.
    await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, trials: [{ label: 'takes them', image: { ...DEFAULT_SETTINGS.image, provider: 'codex' as const } }] }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：见图1')
    // The whole prompt, where no picture goes after all: the pointer gives way to her words, and the line on pictures goes.
    await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, prompt: whole.prompt, trials: [none] }, task)
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：lean woman, black hair')
    expect(images.calls.at(-1)!.prompt).not.toMatch(/见图1|参考图/)
    expect(images.calls.at(-1)!.prompt).toContain('画风：水墨淡彩')
  })

  it('gives the whole prompt as the director wrote it out, where it did, with the brief beside it', async () => {
    const { bed, images } = await studio({ promptWrite: 'always' })
    const { project } = bed.runtime
    const { redrawPicture, pictureWhole } = await import('../src/core/pipelines/illustrate')
    forgetFittedPrompts()
    await project.updateManifest({ artStyle: '水墨淡彩', artAvoid: ['文字'] })
    const yard = await project.saveWorld({ name: '后院', category: 'location', importance: 2, visualPrompt: '青砖小院，一口井' })
    bed.llm.responder = request => (request.prompt.includes('提示词') || request.prompt.includes('prompt') ? JSON.stringify({ prompt: '用途：场景设定图\n画面：青砖小院，井边老槐\n画风：水墨淡彩\n不要出现：文字' }) : ANCHOR)
    const art = await illustrate(bed.core, bed.runtime, { kind: 'location', target: yard.id }, task)
    expect(art.written).toBe('用途：场景设定图\n画面：青砖小院，井边老槐\n画风：水墨淡彩\n不要出现：文字')
    const whole = await pictureWhole(bed.core, bed.runtime, art.id)
    expect(whole.prompt).toBe('用途：场景设定图\n画面：青砖小院，井边老槐\n画风：水墨淡彩')
    expect(whole.brief).toContain('青砖小院，一口井')
    expect(whole.brief).not.toContain('不要出现')
    expect(whole.avoid).toEqual(['文字'])
    // Sent again as the author has it, the director is not asked to write it a second time.
    const asks = bed.llm.requests.length
    await redrawPicture(bed.core, bed.runtime, { picture: art.id, prompt: `${whole.prompt}\n这一张的要求：黄昏` }, task)
    expect(bed.llm.requests.length).toBe(asks)
    expect(images.calls.at(-1)!.prompt).toContain('这一张的要求：黄昏\n不要出现：文字')
  })

  it('draws a picture again from its record: its words rewritten, or the picture itself with one thing changed', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const { redrawPicture } = await import('../src/core/pipelines/illustrate')
    await project.updateManifest({ artStyle: '水墨淡彩', artAvoid: ['文字'] })
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    // A portrait drawn after her sheet: held against it.
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    const sheet = (await project.findCharacter(card.id))!.visual!.sheet!
    expect(portrait.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true }])
    // Its words rewritten: what she wrote is the picture; the art direction, what is kept out and the sheet go along as before.
    const calls = images.calls.length
    const reworded = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, subject: '人物立绘，她侧身站在窗前，手里一卷书' }, task)
    expect(images.calls).toHaveLength(calls + 1)
    expect(images.calls.at(-1)!.prompt).toContain('她侧身站在窗前，手里一卷书')
    expect(images.calls.at(-1)!.prompt).not.toContain('面向镜头')
    expect(images.calls.at(-1)!.prompt).toContain('画风：水墨淡彩')
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect(reworded).toMatchObject({ kind: 'portrait', target: card.id, replaced: ['沈砚'] })
    expect(reworded.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true }])
    // It is her face now, and the one before stays beside it.
    expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: reworded.path, portraits: [reworded.path, portrait.path] })
    // One thing changed: the picture goes along with what to change — and that is the whole of what is sent. Not the
    // picture's description, not the art direction, not what to keep out, not a word of what the picture is for.
    const changed = await redrawPicture(bed.core, bed.runtime, { picture: reworded.path, change: '背景换成雪夜。' }, task)
    // (This way to the model has no field for a size: the shape of the frame is its one sentence after the prompt.)
    expect(images.calls.at(-1)!.prompt).toBe('背景换成雪夜\n\nSquare 1:1 composition.')
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect(images.calls.at(-1)!.change).toBe(true)
    expect(changed.prompt).toBe('背景换成雪夜')
    expect(changed.parts).toMatchObject({ subject: '背景换成雪夜', pieces: [{ of: 'change', text: '背景换成雪夜' }], references: [{ path: reworded.path, label: '要改的原图' }] })
    expect(changed.parts?.style).toBeUndefined()
    expect(changed.parts?.avoid).toBeUndefined()
    expect(changed.parts?.referenceNote).toBeUndefined()
    // What it shows in words is kept beside that, unsent: the picture it came from, with the change — its art direction, what it kept out, the sheet it was held against.
    expect(changed.parts?.base).toMatchObject({ subject: '人物立绘，她侧身站在窗前，手里一卷书\n这一张的要求：背景换成雪夜', style: '水墨淡彩', avoid: ['文字'], references: [{ path: sheet, label: '沈砚' }] })
    expect((await project.findCharacter(card.id))!.visual!.portraits).toEqual([changed.path, reworded.path, portrait.path])
    // Changed once more: again the picture and the change alone, and the words keep both changes.
    const twice = await redrawPicture(bed.core, bed.runtime, { picture: changed.id, change: '头发放下来' }, task)
    expect(images.calls.at(-1)!.prompt).toBe('头发放下来\n\nSquare 1:1 composition.')
    expect(twice.parts?.references).toEqual([{ path: changed.path, label: '要改的原图' }])
    expect(twice.parts?.base?.subject).toBe('人物立绘，她侧身站在窗前，手里一卷书\n这一张的要求：背景换成雪夜\n这一张的要求：头发放下来')
    // Its words rewritten, after that: drawn from what it shows in words, as any picture is — with the art direction, against her sheet, not against the picture it was changed from.
    const back = await redrawPicture(bed.core, bed.runtime, { picture: twice.id, subject: '人物立绘，她坐在灯下' }, task)
    expect(images.calls.at(-1)!.prompt).toContain('她坐在灯下')
    expect(images.calls.at(-1)!.prompt).toContain('画风：水墨淡彩')
    expect(images.calls.at(-1)!.prompt).toContain('不要出现：文字')
    expect(images.calls.at(-1)!.change).toBeUndefined()
    expect(back.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true }])
    expect(back.parts?.base).toBeUndefined()
    // The same for a design sheet — the new one takes the sheet's place, the old one stays in the gallery — …
    const record = (await project.illustrations()).find(item => item.path === sheet)!
    const resheet = await redrawPicture(bed.core, bed.runtime, { picture: record.id, change: '袖口加一圈白边' }, task)
    expect(images.calls.at(-1)!.prompt).toMatch(/^袖口加一圈白边\n\n\w+ [\d:]+ composition\.$/)
    expect(resheet).toMatchObject({ kind: 'sheet', replaced: ['沈砚'] })
    expect((await project.findCharacter(card.id))!.visual!.sheet).toBe(resheet.path)
    expect((await project.illustrations()).map(item => item.path)).toContain(sheet)
    // …and stays among the sheets kept of them, right behind the new one, not in use.
    expect((await project.findCharacter(card.id))!.visual!.sheets).toEqual([resheet.path, sheet])
    // …for the art of a place, and for a picture that hangs nowhere: it is in the gallery.
    const yard = await project.saveWorld({ name: '后院', category: 'location', importance: 2, visualPrompt: '青砖小院，一口井' })
    const art = await illustrate(bed.core, bed.runtime, { kind: 'location', target: yard.id }, task)
    const reyard = await redrawPicture(bed.core, bed.runtime, { picture: art.id, subject: '场景设定图，青砖小院，井边一株老槐' }, task)
    expect(reyard.replaced).toEqual(['后院'])
    expect((await project.findWorld(yard.id))!.visualImage).toBe(reyard.path)
    const loose = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '一只纸船' }, task)
    const reloose = await redrawPicture(bed.core, bed.runtime, { picture: loose.id, subject: '两只纸船' }, task)
    expect(reloose.replaced).toEqual([])
    expect((await project.illustrations()).map(item => item.path)).toEqual(expect.arrayContaining([loose.path, reloose.path]))
    // Changed, a picture keeps the frame it has — read off its file, where its record (an older one) names no size.
    const wide = await project.writeAsset('images/wide.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 0xd0, 8, 2, 0, 0, 0]))
    // …and one changed the way it was done at first — its description sent along, held against the picture it came from — is not held against that picture when its words are what it is drawn from.
    await project.addIllustration({ id: 'img_wide', path: wide, kind: 'scene', createdAt: new Date().toISOString(), prompt: '江上一只船，照参考图把这一张重画一遍，只改这一处：加一轮月亮', parts: { subject: '江上一只船，照参考图把这一张重画一遍，只改这一处：加一轮月亮', style: '水墨淡彩', references: [{ path: loose.path, label: '要改的原图' }], referenceNote: '参考图：第1张是要改的原图。' } })
    const widened = await redrawPicture(bed.core, bed.runtime, { picture: 'img_wide', change: '月亮改成残月' }, task)
    expect(images.calls.at(-1)!.prompt).toBe('月亮改成残月\n\nLandscape 16:9 composition.')
    expect(widened.size).toBe('1280x720')
    expect(widened.parts?.base?.references).toBeUndefined()
    const { pictureWords } = await import('../src/shared/art')
    expect(pictureWords(widened)).toMatchObject({ subject: '江上一只船，照参考图把这一张重画一遍，只改这一处：加一轮月亮\n这一张的要求：月亮改成残月', art: true })
    expect(pictureWords({ prompt: 'a boat', parts: { subject: 'a boat', left: [{ path: 'x.png', label: 'the picture to change' }, { path: 'y.png', label: 'Shen' }] } })).toEqual({ subject: 'a boat', references: [{ path: 'y.png', label: 'Shen' }], art: false })
    // Nothing to draw from: it says so.
    await expect(redrawPicture(bed.core, bed.runtime, { picture: loose.id }, task)).rejects.toThrow(/say what to draw/)
    await expect(redrawPicture(bed.core, bed.runtime, { picture: 'assets/images/none.png', change: 'x' }, task)).rejects.toThrow(/no picture on record/)
  })

  it('holds a picture of somebody against the front view of their sheet — one figure of the three — and a sheet against the sheet', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const { cutPng } = await import('../src/core/media/png')
    const { pixelsOf } = await import('../src/core/media/pixels')
    // A sheet as a model draws one: a plain ground, three figures side by side.
    const [width, height] = [900, 600]
    const pixels = new Uint8Array(width * height * 3).fill(236)
    for (const [from, to] of [[80, 260], [380, 520], [640, 820]] as const) for (let y = 50; y < 570; y++) for (let x = from; x < to; x++) pixels.set([70, 90, 96], (y * width + x) * 3)
    const drawn = await cutPng({ width, height, kind: 2, each: 3, pixels }, { left: 0, top: 0, width, height })
    const sheet = await project.writeAsset('images/sheet-yan.png', drawn)
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', sheet } })
    // A portrait: what goes to the model is the first figure alone — a picture of its own, narrower than the sheet and
    // as tall — so that the model has one person to draw from, not three. The record names the sheet, and says so.
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    const sent = images.calls.at(-1)!.references
    expect(sent).toHaveLength(1)
    expect(pixelsOf(sent[0]!.data)).toMatchObject({ height: 600 })
    expect(pixelsOf(sent[0]!.data)!.width).toBeLessThan(330)
    expect(sent[0]!.mime).toBe('image/png')
    expect(portrait.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true, front: true }])
    expect(portrait.prompt).toContain('参考图：图1 是沈砚。')
    // The same for a picture of the author's own prompt that names her…
    const loose = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '她在渡口等船', characters: ['沈砚'] }, task)
    expect(pixelsOf(images.calls.at(-1)!.references[0]!.data)!.width).toBeLessThan(330)
    expect(loose.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true, front: true }])
    // …and drawn again from its words, the front view goes again.
    const { redrawPicture } = await import('../src/core/pipelines/illustrate')
    const again = await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, subject: '人物立绘，她坐在灯下' }, task)
    expect(pixelsOf(images.calls.at(-1)!.references[0]!.data)!.width).toBeLessThan(330)
    expect(again.parts?.references).toEqual([{ path: sheet, label: '沈砚', sheet: true, front: true }])
    // The sheet of one of her looks is itself a sheet — three views are what is asked for: the main sheet goes whole.
    const look = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服', prompt: '素白麻衣' }, task)
    expect(Buffer.from(images.calls.at(-1)!.references[0]!.data).equals(Buffer.from(drawn))).toBe(true)
    expect(look.parts?.references).toEqual([{ path: sheet, label: '沈砚的主造型', sheet: true }])
    // A sheet nothing can be told apart in — here the one-pixel picture the test double draws as that look's sheet — goes as it is.
    const worn = (await project.findCharacter(card.id))!.visual!.looks!.find(item => item.name === '丧服')!
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '她穿着丧服站在灵前', characters: ['沈砚'], looks: { 沈砚: '丧服' } }, task)
    expect(scene.parts?.references).toEqual([{ path: worn.sheet, label: '沈砚（丧服）', sheet: true }])
  })

  it('draws the design art of a house or an organisation as the picture that stands for it', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    bed.llm.responder = () => JSON.stringify({ look: '朱漆大门，门楣悬"敕造荣国府"匾，石狮蹲在阶前。' })
    const house = await project.saveWorld({ name: '贾府', category: 'faction', importance: 2, summary: '金陵四大家族之首' })
    const info = await illustrate(bed.core, bed.runtime, { kind: 'location', target: house.id }, task)
    // The director writes what can be seen of it — its seat, its emblem, its people as a body — and it is drawn as that.
    expect(bed.llm.requests.at(-1)!.prompt).toContain('这个家族或组织')
    expect(bed.llm.requests.at(-1)!.prompt).toContain('徽记、旗号或匾额')
    expect(images.calls[0]!.prompt).toContain('家族或组织的设定图')
    expect(images.calls[0]!.prompt).toContain('朱漆大门')
    expect(images.calls[0]!.prompt).not.toContain('场景设定图，无人物')
    expect((await project.findWorld(house.id))!.visualImage).toBe(info.path)
  })
})

describe('how large a picture is, and in what shape', () => {
  it('gives each shape as many pixels as the screen the fineness is named after', async () => {
    const { pixelSize, pictureSize } = await import('../src/shared/art')
    // The level frame of each name, exactly.
    expect(pixelSize('16:9', '720p')).toBe('1280x720')
    expect(pixelSize('16:9', '1080p')).toBe('1920x1080')
    expect(pixelSize('16:9', '2k')).toBe('2560x1440')
    expect(pixelSize('16:9', '4k')).toBe('3840x2160')
    expect(pixelSize('9:16', '1080p')).toBe('1080x1920')
    // Other shapes: the same count of pixels, in whole eights.
    expect(pixelSize('1:1', '720p')).toBe('960x960')
    expect(pixelSize('3:4', '1080p')).toBe('1248x1664')
    for (const aspect of ['1:1', '3:4', '4:3', '3:2', '2:3'] as const) {
      const [width, height] = pixelSize(aspect, '1080p').split('x').map(Number) as [number, number]
      expect(width % 8).toBe(0)
      expect(height % 8).toBe(0)
      expect(width * height).toBeGreaterThan(1920 * 1080 * 0.97)
      expect(width * height).toBeLessThan(1920 * 1080 * 1.03)
    }
    // Nothing chosen: every kind at the size it has always had.
    expect(pictureSize(undefined, 'panel')).toBe('1280x720')
    expect(pictureSize({}, 'cover')).toBe('768x1152')
    expect(pictureSize({}, 'sheet')).toBe('1536x1024')
    expect(pictureSize({}, 'portrait')).toBe('1024x1024')
    // A fineness chosen: the kind's own shape at that fineness. A shape chosen and no fineness: that shape at 720p.
    expect(pictureSize({ resolution: '1080p' }, 'cover')).toBe('1176x1768')
    expect(pictureSize({ aspects: { portrait: '3:4' } }, 'portrait')).toBe('832x1112')
    // A shape and a fineness chosen; exact pixels typed win over both; nonsense falls back to the kind's own shape.
    expect(pictureSize({ resolution: '1080p', aspects: { cover: '3:4', scene: '1600×900', panel: 'wide' } }, 'cover')).toBe('1248x1664')
    expect(pictureSize({ resolution: '1080p', aspects: { scene: '1600×900' } }, 'scene')).toBe('1600x900')
    expect(pictureSize({ resolution: '1080p', aspects: { panel: 'wide' } }, 'panel')).toBe('1920x1080')
    expect(pictureSize({ resolution: 'huge' }, 'location')).toBe('1280x720')
  })
})

describe('a prompt for a model that reads only so much', () => {
  beforeEach(() => { forgetFittedPrompts() })
  const LONG = '清晨的码头，薄雾未散，一艘乌篷船缓缓靠岸，船篷上还挂着隔夜的露水；她提着一只竹篮走下青石阶，回头望了一眼身后的巷口，巷口的灯笼还亮着，远处传来早市的叫卖声，石阶缝里长着青苔，水面映着灰白的天光'
  const FITS = '清晨薄雾的码头，乌篷船靠岸；少女提竹篮走下青石阶回望巷口。水墨淡彩，明制服饰。'
  /** Plays the director: hands in what it is told to, and keeps what it was asked. */
  const director = (answers: string[]) => {
    const asked: string[] = []
    return { asked, responder: (request: { prompt: string }) => { asked.push(request.prompt); return JSON.stringify({ prompt: answers[Math.min(asked.length, answers.length) - 1] }) } }
  }

  it('has the director write the same picture in fewer words, and keeps both prompts on record', async () => {
    const { bed, images } = await studio({ promptTokens: 60 })
    await bed.runtime.project.updateManifest({ artStyle: '水墨淡彩，明制服饰', artAvoid: ['文字', '水印'] })
    const play = director([FITS])
    bed.llm.responder = play.responder
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: LONG }, task)
    // The director was handed the prompt as composed, what to keep out, how much room there is and for which model.
    expect(play.asked).toHaveLength(1)
    expect(play.asked[0]).toContain(LONG)
    expect(play.asked[0]).toContain('画风：水墨淡彩，明制服饰')
    expect(play.asked[0]).toContain('文字、水印')
    // The count is an estimate, so the director writes to a tenth under what the model reads.
    expect(play.asked[0]).toContain('大约 54 个 token')
    expect(play.asked[0]).toMatch(/要到 54 以内——大约是现在的 \d+%/)
    expect(play.asked[0]).toContain('这张图不带参考图')
    // This way of drawing has no field for what to keep out: it is the brief's last line, and stays the prompt's.
    expect(play.asked[0]).toContain('不要出现：文字、水印\n')
    expect(play.asked[0]).toContain('「不要出现」那一段，说明里有就留着，放在最后')
    // The brief is to be written out under the same names, in the same order, in the book's language.
    expect(play.asked[0]).toContain('分段和次序照原样')
    expect(play.asked[0]).toContain('全文用中文写')
    // What went to the model is the director's prompt — and nothing written after it again.
    expect(images.calls.at(-1)!.prompt.startsWith(FITS)).toBe(true)
    expect(images.calls.at(-1)!.prompt).not.toContain('Avoid:')
    // The record keeps the prompt as the Studio composed it, the one that was sent, and what was done between them.
    expect(info.prompt).toContain(LONG)
    expect(info.sent?.prompt.startsWith(FITS)).toBe(true)
    expect(info.sent?.compact).toMatchObject({ limit: 60 })
    expect(info.sent!.compact!.from).toBeGreaterThan(60)
    expect(info.sent!.compact!.tokens).toBeLessThanOrEqual(54)
    expect(info.sent!.compact!.failed).toBeUndefined()
    // The same picture asked for again is not written again: the director's words are kept.
    const again = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: LONG }, task)
    expect(play.asked).toHaveLength(1)
    expect(again.sent?.prompt.startsWith(FITS)).toBe(true)
    expect(again.sent?.compact).toMatchObject({ limit: 60 })
  })

  it('hands a prompt that is still too long back, and takes the next', async () => {
    const { bed, images } = await studio({ promptTokens: 60 })
    const play = director([LONG, FITS])
    bed.llm.responder = play.responder
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: LONG }, task)
    expect(play.asked).toHaveLength(2)
    expect(play.asked[1]).toMatch(/comes to about \d+ tokens.*at most 54/)
    expect(images.calls.at(-1)!.prompt.startsWith(FITS)).toBe(true)
    expect(info.sent?.compact).toMatchObject({ limit: 60 })
    expect(info.sent!.compact!.cut).toBeUndefined()
  })

  it('leaves the end off what the director wrote when every try was over', async () => {
    const { bed, images } = await studio({ promptTokens: 40 })
    // Shorter than the original both times, and over both times.
    const over = '清晨薄雾的码头，乌篷船靠岸；少女提竹篮走下青石阶，回望巷口，灯笼还亮着，石阶缝里有青苔，水面映着灰白天光。水墨淡彩，明制服饰。'
    const play = director([over, over])
    bed.llm.responder = play.responder
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: `${LONG}。${LONG}` }, task)
    expect(play.asked).toHaveLength(2)
    const sent = images.calls.at(-1)!.prompt
    expect(sent.startsWith('清晨薄雾的码头，乌篷船靠岸')).toBe(true)
    expect(sent).not.toContain('水墨淡彩')
    expect(info.sent?.compact).toMatchObject({ limit: 40, cut: true })
    expect(info.sent!.compact!.tokens).toBeLessThanOrEqual(36)
  })

  it('sends the prompt as it is when the director cannot be had, and says so', async () => {
    const { bed, images } = await studio({ promptTokens: 60 })
    await bed.runtime.project.updateManifest({ artAvoid: ['文字'] })
    bed.llm.responder = () => { throw new Error('the model is away') }
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: LONG }, task)
    expect(images.calls.at(-1)!.prompt).toContain(LONG)
    expect(images.calls.at(-1)!.prompt).toContain('不要出现：文字')
    expect(info.sent?.compact).toMatchObject({ limit: 60, failed: true })
  })

  it('asks nobody where the prompt fits, where no limit is set, or where the author turned it off', async () => {
    for (const image of [{ promptTokens: 4000 }, {}, { promptTokens: 60, promptCompact: false }]) {
      const { bed: made, images } = await studio(image)
      let asked = 0
      made.llm.responder = () => { asked += 1; return JSON.stringify({ prompt: FITS }) }
      const info = await illustrate(made.core, made.runtime, { kind: 'custom', prompt: LONG }, task)
      expect(asked, JSON.stringify(image)).toBe(0)
      expect(images.calls.at(-1)!.prompt).toContain(LONG)
      expect(info.sent?.compact).toBeUndefined()
      await made.cleanup()
      bed = undefined
    }
  })
})

describe('the picture of a passage', () => {
  it('has the director tell whom the passage means from the text before it, and holds the picture against that person', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const sheet = await project.writeAsset('images/sheet-heng.png', new Uint8Array([1]))
    const heng = await project.saveCharacter({ name: '沈蘅', role: 'protagonist', appearance: '清瘦，低髻', visual: { prompt: 'slender woman, low bun, grey qipao', sheet } })
    await project.saveCharacter({ name: '周衡', role: 'supporting', appearance: '三件套', visual: { prompt: 'man in a three-piece suit' } })
    const pen = await project.saveWorld({ name: '寄死笔', category: 'item', importance: 2, summary: '一支前清旧笔', visualPrompt: '笔杆发乌的旧毛笔', visualImage: 'assets/images/pen.png' })
    await project.writeAsset('images/pen.png', new Uint8Array([2]))
    const chapter = await project.addChapter({ title: '旧账', location: '断肠斋', time: '雨夜' })
    await project.saveChapterText(chapter.id, '沈蘅把灯芯拨亮了些。周衡站在柜台外，没有说话。\n\n她从抽屉里取出那支寄死笔，在砚上轻轻一搁。\n\n门外的雨还在下。')
    const quote = '她从抽屉里取出那支寄死笔，在砚上轻轻一搁。'
    const asked: string[] = []
    bed.llm.responder = (request) => { asked.push(request.prompt); return JSON.stringify({ picture: '近景，沈蘅垂着眼，一手拉开抽屉，一手把一支旧笔搁在砚上；灯在她左侧', people: ['沈蘅'], things: ['寄死笔'], why: '这一段的“她”接着上一段，是沈蘅；周衡在柜台外，不入画' }) }
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, quote, prompt: '只画她的手和那支笔' }, task)
    // The director had the passage, what stands before and after it, the chapter, its people, the thing it names, and what the author asked.
    for (const part of ['## 要画的这一段\n她从抽屉里取出那支寄死笔', '## 这一段之前的正文', '沈蘅把灯芯拨亮了些', '## 紧接着的正文\n门外的雨还在下', '地点：断肠斋', '时间：雨夜', '沈蘅｜', '周衡｜', '寄死笔（item）：一支前清旧笔；看上去：笔杆发乌的旧毛笔', '## 作者对这一张的要求\n只画她的手和那支笔', '这一段用代词、称呼指的人，从前文认出是谁']) expect(asked[0], part).toContain(part)
    // The passage names nobody: the picture is held against whom the director told it means — and against the thing's art.
    expect(scene.framed).toEqual({ people: ['沈蘅'], things: ['寄死笔'], why: '这一段的“她”接着上一段，是沈蘅；周衡在柜台外，不入画' })
    expect(scene.parts?.references).toEqual([{ path: sheet, label: '沈蘅', sheet: true }, { path: pen.visualImage, label: '物品「寄死笔」' }])
    expect(scene.parts?.subject).toBe('用途：小说章节插图\n画面：近景，沈蘅垂着眼，一手拉开抽屉，一手把一支旧笔搁在砚上；灯在她左侧\n人物「沈蘅」：见图1\n物件「寄死笔」：笔杆发乌的旧毛笔')
    expect(scene.passage).toEqual({ quote, why: '这一段的“她”接着上一段，是沈蘅；周衡在柜台外，不入画' })
    expect(images.calls.at(-1)!.references).toHaveLength(2)
    // The director names nobody, but its picture calls somebody of the chapter by name: they are in it.
    bed.llm.responder = () => JSON.stringify({ picture: '周衡站在柜台外，雨从他身后的门缝里飘进来' })
    const other = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, quote: '周衡站在柜台外，没有说话。', sheetFirst: false }, task)
    expect(other.framed?.people).toEqual(['周衡'])
    expect(other.parts?.subject).toContain('人物「周衡」：man in a three-piece suit')
    expect((await project.findCharacter(heng.id))!.visual?.sheet).toBe(sheet)
  })
})

describe('who writes the prompt that is sent, and in what language', () => {
  beforeEach(() => { forgetFittedPrompts() })

  it('keeps what travels apart from the prompt out of the prompt the director writes, though the director copied it in', async () => {
    // A service that takes what is kept out in a field of its own (Bailian's), stood in for by a server here.
    const seen: { prompt: string; negative?: string }[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        if (request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: { messages: { content: { text?: string }[] }[] }; parameters: { negative_prompt?: string } }
        seen.push({ prompt: body.input.messages[0]!.content.find(part => part.text !== undefined)!.text!, ...(body.parameters.negative_prompt !== undefined ? { negative: body.parameters.negative_prompt } : {}) })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ output: { choices: [{ message: { content: [{ image: `http://127.0.0.1:${(server.address() as AddressInfo).port}/picture.png` }] } }] } }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    try {
      bed = await createTestBed({ key: 'made-up-for-this-test', settings: { image: { ...DEFAULT_SETTINGS.image, provider: 'dashscope', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'qwen-image-3.0', apiKeyRef: 'A_KEY_FOR_THIS_TEST', promptWrite: 'always' } } })
      const { project } = bed.runtime
      await project.updateManifest({ artStyle: '水墨淡彩', artAvoid: ['文字', '血腥'] })
      const yard = await project.saveWorld({ name: '后院', category: 'location', importance: 2, visualPrompt: '青砖小院，一口井' })
      const asked: string[] = []
      bed.llm.responder = (request) => { asked.push(request.prompt); return JSON.stringify({ prompt: '用途：场景设定图\n画面：青砖小院，井边老槐\n画风：水墨淡彩\n不要出现：文字、血腥' }) }
      const art = await illustrate(bed.core, bed.runtime, { kind: 'location', target: yard.id }, task)
      // The director is told the list goes apart, and not to copy it in…
      expect(asked[0]).toContain('提示词里不要有「不要出现」这一段')
      expect(asked[0]).toContain('## 画面里不要出现（另外交给模型，不写进提示词')
      // …and what it wrote of it all the same is taken out: named in a prompt, those are the things a model draws.
      expect(seen).toEqual([{ prompt: '用途：场景设定图\n画面：青砖小院，井边老槐\n画风：水墨淡彩', negative: '文字、血腥' }])
      expect(art.written).toBe('用途：场景设定图\n画面：青砖小院，井边老槐\n画风：水墨淡彩')
      expect(art.prompt).not.toContain('不要出现')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })

  it('has the director write every brief out where the author says so — the same headings, the numbers of the pictures kept — and sends the brief itself where the director cannot be had', async () => {
    const { bed, images } = await studio({ promptWrite: 'always' })
    const { project } = bed.runtime
    await project.updateManifest({ artStyle: '水墨淡彩', artAvoid: ['文字'] })
    const sheet = await project.writeAsset('images/sheet-kept.png', new Uint8Array([1]))
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair', sheet } })
    const WRITTEN = '用途：小说人物立绘（定妆照）\n构图：半身像，面向镜头，素底\n人物「沈砚」：见图1\n画风：水墨淡彩\n参考图：图1 是沈砚，脸、发型和体型照图\n不要出现：文字'
    const asked: string[] = []
    bed.llm.responder = (request) => { asked.push(request.prompt); return JSON.stringify({ prompt: asked.length === 1 ? '一个高瘦的女人，水墨淡彩' : WRITTEN }) }
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    // No limit of the model's is in play: the director is asked all the same, and is told so.
    expect(asked[0]).toContain('## 画图说明\n用途：小说人物立绘（定妆照）：只画「沈砚」一个人\n构图：半身像，面向镜头，素净的浅色背景\n人物「沈砚」：见图1\n画风：水墨淡彩\n参考图：图1 是沈砚。')
    expect(asked[0]).toContain('这张图带 1 张参考图')
    expect(asked[0]).toContain('篇幅：和说明差不多')
    expect(asked[0]).not.toContain('一次只读得进')
    // The first answer lost the picture that goes along: handed back, and the next taken.
    expect(asked).toHaveLength(2)
    expect(images.calls.at(-1)!.prompt.startsWith(WRITTEN)).toBe(true)
    // The record keeps the brief, what was sent, and that the director wrote it — with no limit to name.
    expect(portrait.prompt).toContain('构图：半身像，面向镜头，素净的浅色背景')
    expect(portrait.sent?.prompt.startsWith(WRITTEN)).toBe(true)
    expect(portrait.sent?.compact).toMatchObject({ from: expect.any(Number), tokens: expect.any(Number) })
    expect(portrait.sent!.compact!.limit).toBeUndefined()
    // A picture changed by one sentence of the author's is sent as they wrote it: nobody rewrites that.
    const before = asked.length
    const { redrawPicture } = await import('../src/core/pipelines/illustrate')
    await redrawPicture(bed.core, bed.runtime, { picture: portrait.id, change: '头发放下来' }, task)
    expect(asked).toHaveLength(before)
    expect(images.calls.at(-1)!.prompt.startsWith('头发放下来')).toBe(true)
    // The director away: the brief is the prompt, and the record says the writing failed.
    bed.llm.responder = () => { throw new Error('away') }
    const plain = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨夜的码头' }, task)
    expect(images.calls.at(-1)!.prompt).toContain('用途：小说插图\n画面：雨夜的码头\n画风：水墨淡彩\n不要出现：文字')
    expect(plain.sent?.compact).toMatchObject({ failed: true })
    expect(plain.sent!.compact!.limit).toBeUndefined()
  })

  it('lays the brief out under English headings where the author has prompts in English, and has the director write all of it in English', async () => {
    const { bed, images } = await studio({ promptLang: 'en', promptWrite: 'always' })
    const { project } = bed.runtime
    await project.updateManifest({ artStyle: '水墨淡彩', artAvoid: ['文字'] })
    const asked: string[] = []
    bed.llm.responder = (request) => { asked.push(request.prompt); return JSON.stringify({ prompt: 'Purpose: an illustration for a novel\nThe picture: a pier on a rainy night\nStyle: ink and light colour\nMust not appear: text' }) }
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '雨夜的码头' }, task)
    expect(info.prompt).toBe('Purpose: an illustration for a novel\nThe picture: 雨夜的码头\nStyle: 水墨淡彩\nMust not appear: 文字')
    // The task is in the book's language; what it asks for is English.
    expect(asked[0]).toContain('全文用英文（English）写')
    expect(images.calls.at(-1)!.prompt.startsWith('Purpose: an illustration for a novel\nThe picture: a pier on a rainy night')).toBe(true)
  })

  it('reads the settings: the director where the brief does not fit, unless the author says always or never — an older switch reads as never', async () => {
    const { promptWriteOf, portraitsOf } = await import('../src/shared/images')
    expect([promptWriteOf({}), promptWriteOf({ promptCompact: false }), promptWriteOf({ promptCompact: true }), promptWriteOf({ promptWrite: 'always', promptCompact: false })]).toEqual(['fit', 'never', 'fit', 'always'])
    // …and what a portrait comes to: both pictures, unless the author says one — an older switch reads as the likeness alone.
    expect([portraitsOf({}), portraitsOf({ portraitScene: false }), portraitsOf({ portraitScene: true }), portraitsOf({ portraits: 'scene', portraitScene: false })]).toEqual(['both', 'plain', 'both', 'scene'])
  })
})

describe('a portrait asked for with nothing said of it', () => {
  /** A book with a moment of hers to show, and a sheet she is held against. */
  async function withMoment() {
    const made = await studio({ portraits: 'both' })
    const { project } = made.bed.runtime
    const chapter = await project.addChapter({ title: '葬花' })
    await project.saveChapterText(chapter.id, '黛玉肩上担着花锄，往花冢去。')
    const sheet = await project.writeAsset('images/sheet-kept.png', new Uint8Array([1]))
    const card = await project.saveCharacter({ name: '黛玉', role: 'protagonist', appearance: '清瘦', firstAppearance: chapter.id, visual: { prompt: 'slight girl, fine arched brows', sheet, scenes: [{ id: 's1', title: '葬花', chapter: chapter.id, text: '她肩担花锄，独自立在花冢前，落花满地。' }] } })
    return { ...made, project, chapter, card, sheet }
  }

  it('is two pictures, one of each: a plain likeness, which stands for them, and their signature scene', async () => {
    const { bed, images, project, card, chapter } = await withMoment()
    const said: Record<string, unknown>[] = []
    const result = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, { origin: 'user', job: { ...quiet(), result: (value: Record<string, unknown>) => { said.push(value) } } as never })
    // The likeness first, then the scene: two calls, each held against her sheet.
    expect(images.calls).toHaveLength(2)
    expect(images.calls[0]!.prompt).toContain('用途：小说人物立绘（定妆照）：只画「黛玉」一个人')
    expect(images.calls[0]!.prompt).toContain('面向镜头，素净的浅色背景')
    expect(images.calls[1]!.prompt).toContain('用途：小说人物立绘：「黛玉」的名场面\n画面：葬花：她肩担花锄')
    expect(images.calls.map(call => call.references.length)).toEqual([1, 1])
    // What comes back is the scene, with the likeness beside it.
    expect(result.scene).toMatchObject({ title: '葬花', id: 's1', chapter: chapter.id })
    expect(result.moment).toMatchObject({ scene: 's1' })
    expect(result.likeness).toMatchObject({ kind: 'portrait', target: card.id })
    expect(result.likeness!.path).not.toBe(result.path)
    expect(result.likeness!.moment).toBeUndefined()
    // Both are hers; the likeness stands for her though the scene was drawn after it, and the scene hangs on its moment.
    const now = (await project.findCharacter(card.id))!
    expect(now.visual).toMatchObject({ portrait: result.likeness!.path, portraits: [result.path, result.likeness!.path] })
    expect(now.visual!.face).toBeUndefined()
    expect(scenesOf(now)[0]!.portrait).toBe(result.path)
    // In the text: the likeness where she first comes on, the scene where it is told — here the same paragraph, so the scene alone.
    expect((await project.chapterFigures(chapter.id)).map(figure => figure.path)).toEqual([result.path])
    expect((await project.portraitPlaces()).map(place => [place.path, place.as, place.spare])).toEqual([[result.path, 'moment', undefined], [result.likeness!.path, 'person', 'chapter']])

    // One of the two asked for alone: the likeness; the scene; a moment named.
    images.calls.length = 0
    const alone = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true }, task)
    expect(alone.likeness).toBeUndefined()
    expect((await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: false }, task)).scene).toMatchObject({ title: '葬花' })
    expect((await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, scene: 's1' }, task)).likeness).toBeUndefined()
    expect(images.calls).toHaveLength(3)
    // Something asked of it guides the director's pick: one picture, as before.
    bed.llm.responder = () => JSON.stringify({ title: '葬花', chapter: 1, scene: '晴日，她肩荷花锄。', why: '明亮' })
    images.calls.length = 0
    expect((await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, prompt: '光线明亮些' }, task)).likeness).toBeUndefined()
    expect(images.calls).toHaveLength(1)
  })

  it('is the likeness alone where the book has no moment to show — and a batch fills in only what is lacking', async () => {
    const { bed, images } = await studio({ portraits: 'both' })
    const { project } = bed.runtime
    const sheet = await project.writeAsset('images/sheet-kept.png', new Uint8Array([1]))
    const card = await project.saveCharacter({ name: '黛玉', role: 'protagonist', appearance: '清瘦', visual: { prompt: 'slight girl', sheet } })
    // Nothing written: one picture, and nothing to say about a scene nobody expects.
    const first = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(images.calls).toHaveLength(1)
    expect(first.scene).toBeUndefined()
    expect(first.likeness).toBeUndefined()
    expect(first.prompt).toContain('定妆照')
    const { lackingPortraits } = await import('../src/core/pipelines/illustrate')
    expect(await lackingPortraits(bed.runtime, (await project.findCharacter(card.id))!)).toEqual({ plain: false, scene: true })
    // The book gets a moment of hers: asked to fill in, only the scene is drawn — the likeness is there.
    const chapter = await project.addChapter({ title: '葬花' })
    await project.saveChapterText(chapter.id, '黛玉肩上担着花锄。')
    await project.saveCharacter({ id: card.id, visual: { scenes: [{ id: 's1', title: '葬花', chapter: chapter.id, text: '她肩担花锄，立在花冢前。' }] } })
    images.calls.length = 0
    const filled = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, fill: true }, task)
    expect(images.calls).toHaveLength(1)
    expect(filled.scene).toMatchObject({ title: '葬花' })
    expect(filled.likeness).toBeUndefined()
    expect(await lackingPortraits(bed.runtime, (await project.findCharacter(card.id))!)).toEqual({ plain: false, scene: false })
    // Nothing lacking: nothing is drawn, and that is said.
    await expect(illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, fill: true }, task)).rejects.toThrow(/都已经有了/)
    // Asked for outright, with nothing said of it: both, again.
    images.calls.length = 0
    expect((await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)).likeness).toBeDefined()
    expect(images.calls).toHaveLength(2)
    // The director asked for her moments and finding none is said with the likeness, which is drawn all the same.
    const bare = await project.saveCharacter({ name: '紫鹃', role: 'supporting', appearance: '圆脸', visual: { prompt: 'round-faced maid', sheet } })
    bed.llm.responder = () => JSON.stringify({ scenes: [], why: '她在书里还没有自己的一幕' })
    images.calls.length = 0
    const hers = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: bare.id }, task)
    expect(images.calls).toHaveLength(1)
    expect(hers.scene).toEqual({ none: '她在书里还没有自己的一幕' })
    expect(hers.prompt).toContain('定妆照')
  })
})

/** A job nobody watches. */
function quiet() {
  return { id: 'job', progress: () => {}, write: () => {}, rewrite: () => {}, result: () => {}, note: () => () => {}, crew: () => {}, signal: undefined }
}


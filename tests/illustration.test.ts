// SPDX-License-Identifier: LGPL-3.0-or-later
/** What shapes a book's pictures: art direction, avoid lists, visual anchors, design sheets and reference images. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pictureRecord } from '../src/agent/tools/studio'
import { sheetsAhead } from '../src/core/pipelines/comic'
import { artDirectionOf, deriveArtDirection, deriveLook, deriveVisual, illustrate, looksOf } from '../src/core/pipelines/illustrate'
import { reconcileLooks, upsertLooks } from '../src/core/project'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import { DEFAULT_ART_STYLE, mergeAvoid, resolveArtStyle, splitAvoid } from '../src/shared/art'
import { createTestBed, FakeImages, type TestBed } from './support/harness'

const ANCHOR = '{"prompt": "woman in her late twenties, lean build, black hair coiled flat at the nape, undyed linen coat", "negative": "cross emblem, halo"}'

let bed: TestBed | undefined
afterEach(async () => {
  await bed?.cleanup()
  bed = undefined
})

async function studio(image: Partial<typeof DEFAULT_SETTINGS.image> = {}): Promise<{ bed: TestBed; images: FakeImages }> {
  const images = new FakeImages()
  bed = await createTestBed({ settings: { image: { ...DEFAULT_SETTINGS.image, provider: 'codex', ...image } }, bridges: images.bridges })
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
    expect(first.parts).toMatchObject({ subject: '雨夜的码头，一盏风灯', style: DEFAULT_ART_STYLE.zh, styleSource: 'default' })
    expect(first.prompt).toBe(`雨夜的码头，一盏风灯\n画风：${DEFAULT_ART_STYLE.zh}`)
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

  it('distills the appearance into an anchor and a never-drawn list', async () => {
    const { bed } = await studio()
    await bed.runtime.project.updateManifest({ artAvoid: ['十字架'] })
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦，教会式环髻，白甲保养极新' })
    const derived = await deriveVisual(bed.core, bed.runtime, { character: card.id }, task)
    expect(derived.prompt).toContain('black hair coiled flat at the nape')
    expect(derived.card.visual).toMatchObject({ prompt: derived.prompt, negative: 'cross emblem, halo' })
    // The analyst is told what the book keeps out, so the anchor steers around it.
    expect(bed.llm.requests.at(-1)!.prompt).toContain('十字架')
    expect(looksOf(derived.card)).toBe(derived.prompt)
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
  it('draws a three-view sheet, distilling the anchor first, and keeps it on the card', async () => {
    const { bed, images } = await studio()
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦，黑发盘在脑后' })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: '沈砚' }, task)
    expect(sheet.kind).toBe('sheet')
    expect(sheet.parts?.subject).toContain('三视图')
    expect(sheet.parts?.subject).toContain('black hair coiled flat at the nape')
    expect(sheet.parts?.avoid).toEqual(['cross emblem', 'halo'])
    expect(images.calls[0]!.references).toHaveLength(0)
    const saved = (await bed.runtime.project.findCharacter(card.id))!
    expect(saved.visual?.sheet).toBe(sheet.path)
    expect(saved.visual?.prompt).toContain('lean build')
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
    expect(mourning.parts?.references).toEqual([{ path: main.path, label: '沈砚的主造型' }])
    expect(mourning.parts?.subject).toContain('plain black mourning robe')
    expect(mourning.parts?.referenceNote).toContain('脸、发色、体型照参考图画')
    expect(mourning.parts?.referenceNote).toContain('一律照文字画')
    expect(mourning.prompt).not.toContain('必须与各自的参考图一致')
    const saved = (await bed.runtime.project.findCharacter(card.id))!
    expect(saved.visual?.sheet).toBe(main.path)
    expect(saved.visual?.looks).toEqual([{ id: '丧服', name: '丧服', prompt: 'plain black mourning robe, hair unbound', sheet: mourning.path }])
    // Drawn again, the look is held against the main sheet still — not against its own sheet of before.
    const again = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服' }, task)
    expect(again.parts?.references).toEqual([{ path: main.path, label: '沈砚的主造型' }])
  })

  it('draws the main sheet from the words alone, every time: drawn again, it takes no older picture of the person along', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '宝玉', appearance: '面若中秋之月', visual: { prompt: 'boy of thirteen, hair in one thick queue' } })
    const first = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(portrait.parts?.references).toEqual([{ path: first.path, label: '宝玉' }])

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
    // The portrait is drawn against the sheet in use: drawn again, against the new one.
    const redrawn = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(redrawn.parts?.references).toEqual([{ path: second.path, label: '宝玉' }])

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
    expect(sheet.parts?.pieces?.map(piece => piece.of)).toEqual(['frame', 'look', 'ask'])
    expect(sheet.parts?.pieces?.[1]).toEqual({ of: 'look', text: 'lean woman, black hair', from: 'anchor' })
    expect(sheet.parts?.pieces?.[2]).toEqual({ of: 'ask', text: '袖口挽起' })
    expect(sheet.parts?.subject).toBe(sheet.parts!.pieces!.map(piece => piece.text).join('，'))
    expect(sheet.parts?.style).toBe('淡彩水墨，建筑服饰是典型的明制。')
    expect(sheet.parts?.clipped).toBeUndefined()
    // How it was drawn: the service, the size asked for.
    expect(sheet.provider).toBe('codex')
    expect(sheet.size).toBe('1536x1024')
    // Word for word: what the Studio put together, and what the way to this model adds — the things to keep out, which
    // it has no field for, and the shape of the frame, which it takes no size for.
    expect(sheet.sent?.prompt.startsWith(sheet.prompt)).toBe(true)
    expect(sheet.sent?.prompt).toContain('画风：淡彩水墨，建筑服饰是典型的明制')
    expect(sheet.sent?.prompt).toContain('Avoid: 现代服饰、halo')
    expect(sheet.sent?.prompt).toContain('Landscape 3:2 composition.')
    expect(sheet.sent?.negative).toBeUndefined()

    // A portrait: what kind of picture, the look, the expression, what was asked of this one — and the sheet it is held against.
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, prompt: '雪夜，回头看' }, task)
    expect(portrait.parts?.pieces?.map(piece => piece.of)).toEqual(['frame', 'look', 'expression', 'ask'])
    expect(portrait.parts?.pieces?.at(-1)?.text).toBe('雪夜，回头看')
    expect(portrait.parts?.referenceNote).toContain('第1张是沈砚')
    expect(portrait.sent?.prompt).toContain(portrait.parts!.referenceNote!)

    // A place: its look as written on the entry — or, where nothing is written for an image model, its name and summary.
    bed.llm.responder = () => { throw new Error('no model') }
    const written = await project.saveWorld({ name: '咏礼庭', category: 'location', visualPrompt: '低矮的夯土圆厅' })
    const bare = await project.saveWorld({ name: '渡口', category: 'location', summary: '河边的木栈桥' })
    expect((await illustrate(bed.core, bed.runtime, { kind: 'location', target: written.id }, task)).parts?.pieces?.[1]).toEqual({ of: 'look', text: '低矮的夯土圆厅', from: 'anchor' })
    expect((await illustrate(bed.core, bed.runtime, { kind: 'location', target: bare.id }, task)).parts?.pieces?.[1]).toEqual({ of: 'look', text: '渡口，河边的木栈桥', from: 'card' })
    // Somebody without an anchor, and no model to write one: the prose of the card stands in, and the record says so.
    const plain = await project.saveCharacter({ name: '阿棠', appearance: '圆脸，爱笑', gender: '女' })
    expect((await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: plain.id }, task)).parts?.pieces?.[1]).toEqual({ of: 'look', text: '圆脸，爱笑，女', from: 'card' })
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
    expect(ofPortrait).toContain('what the references are for: 参考图：第1张是宝玉')
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
    bed.llm.responder = () => '{"description": "一个高瘦的女人站在夯土圆厅的天井光柱下", "wearing": {"沈砚": "丧服"}}'
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id, avoid: ['十字架'] }, task)
    // The composer was shown how the place looks and what must stay out.
    const brief = bed.llm.requests.at(-1)!.prompt
    expect(brief).toContain('低矮的夯土圆厅')
    expect(brief).toContain('十字架')
    expect(brief).toContain('「丧服」')
    expect(scene.parts?.subject).toBe('一个高瘦的女人站在夯土圆厅的天井光柱下')
    expect(scene.parts?.references).toEqual([
      { path: look.path, label: '沈砚（丧服）' },
      { path: art.path, label: '场所「咏礼庭」' },
    ])
    expect(images.calls.at(-1)!.references).toHaveLength(2)
    expect(scene.prompt).toContain('参考图：第1张是沈砚（丧服）；第2张是场所「咏礼庭」')
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
    expect(first.parts?.subject).toContain('场景设定图，无人物')
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
    expect(cover.parts?.references).toEqual([{ path: sheet.path, label: '贾宝玉' }, { path: hers, label: '林黛玉' }])
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
    expect(portrait.parts?.references).toEqual([{ path: made.visual!.sheet!, label: '沈砚' }])
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
    bed.llm.responder = () => '码头上，圆脸的姑娘望着靠岸的船'
    const scene = await illustrate(bed.core, bed.runtime, { kind: 'scene', target: first.id, quote: '阿棠在码头等船，老周把船靠了岸，卖花人从她身边走过。' }, task)
    expect([...(scene.sheets ?? [])].sort()).toEqual(['老周', '阿棠'].sort())
    expect((await project.findCharacter(friend.id))!.visual?.sheet).toBeDefined()
    expect((await project.findCharacter(twice.id))!.visual?.sheet).toBeDefined()
    expect((await project.findCharacter(once.id))!.visual?.sheet).toBeUndefined()
    expect(sheets()).toBe(3)
    // The scene is held against the sheets just drawn.
    expect(scene.parts?.references?.map(reference => reference.label).sort()).toEqual(['老周', '阿棠'].sort())
  })

  it('draws a sheet once when two pictures need it at the same time, and none where the author turned it off', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const chapter = await project.addChapter({ title: '守灵' })
    await project.saveChapterText(chapter.id, '沈砚在棺前站了很久。')
    bed.llm.responder = () => '一个高瘦的女人站在棺前'
    const [one, two] = await Promise.all([
      illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id }, task),
      illustrate(bed.core, bed.runtime, { kind: 'scene', target: chapter.id }, task),
    ])
    expect(images.calls.filter(call => call.prompt.includes('三视图'))).toHaveLength(1)
    expect(images.calls).toHaveLength(3)
    // Whichever of the two drew it says so; both are held against it.
    expect([...(one.sheets ?? []), ...(two.sheets ?? [])]).toEqual(['沈砚'])
    const sheet = (await project.findCharacter(card.id))!.visual!.sheet!
    for (const scene of [one, two]) expect(scene.parts?.references).toEqual([{ path: sheet, label: '沈砚' }])

    // Turned off: a portrait is drawn from what there is, and no sheet with it.
    await bed.core.settings.update({ image: { ...bed.core.currentSettings().image, sheetFirst: false } })
    const other = await project.saveCharacter({ name: '阿棠', role: 'supporting', appearance: '圆脸', visual: { prompt: 'round-faced girl' } })
    const before = images.calls.length
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: other.id }, task)
    expect(portrait.sheets).toBeUndefined()
    expect(images.calls).toHaveLength(before + 1)
    expect((await project.findCharacter(other.id))!.visual?.sheet).toBeUndefined()
  })

  it('sorts what the author jotted down: what is of the person goes into their look, what is of this one picture directs it and is kept nowhere', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: '高瘦，黑发盘在脑后。', visual: { prompt: 'lean woman, black hair coiled at the nape', negative: 'halo' } })
    const sheet = await project.writeAsset('images/sheet-kept.png', new Uint8Array([1]))
    await project.saveCharacter({ id: card.id, visual: { sheet } })
    bed.llm.responder = () => JSON.stringify({
      anchor: 'lean woman, black hair coiled at the nape, a scar through the left brow, worn grey cloth robe',
      negative: 'halo',
      appearance: '左眉有一道旧疤，常年穿一件灰布袍。',
      picture: '雪夜，回头看向身后',
      kept: ['左眉有道疤', '常年灰布袍'],
      once: ['雪夜', '回头看'],
      unused: [],
    })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, notes: '左眉有道疤，常年穿灰布袍；这张要雪夜，回头看' }, task)
    // The director was handed the notes, the anchor as it stood, and what kind of picture is about to be drawn.
    const asked = bed.llm.requests.at(-1)!.prompt
    for (const part of ['左眉有道疤，常年穿灰布袍；这张要雪夜，回头看', 'lean woman, black hair coiled at the nape', '立绘：半身像']) expect(asked, part).toContain(part)
    expect(portrait.sorted).toEqual({ kept: ['左眉有道疤', '常年灰布袍'], once: ['雪夜', '回头看'], unused: [], picture: '雪夜，回头看向身后' })
    // Of the person: in their look from now on — the anchor every picture restates, and the appearance the writer reads.
    const after = (await project.findCharacter(card.id))!
    expect(after.visual?.prompt).toBe('lean woman, black hair coiled at the nape, a scar through the left brow, worn grey cloth robe')
    expect(after.appearance).toBe('高瘦，黑发盘在脑后。左眉有一道旧疤，常年穿一件灰布袍。')
    expect(after.visual?.sheet).toBe(sheet)
    // Of this picture: in this picture — and nowhere in the look.
    expect(portrait.parts?.subject).toContain('雪夜，回头看向身后')
    expect(portrait.parts?.subject).toContain('a scar through the left brow')
    expect(portrait.parts?.subject).not.toContain('纯净的浅色背景')
    expect(JSON.stringify(after)).not.toContain('雪夜')
    // The next portrait, asked for nothing in particular, has the scar and no snow.
    const plain = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(plain.sorted).toBeUndefined()
    expect(plain.parts?.subject).toContain('a scar through the left brow')
    expect(plain.parts?.subject).toContain('纯净的浅色背景')
    expect(plain.parts?.subject).not.toContain('雪夜')

    // A design sheet has no night and no snow: nothing of it is drawn, and it is said that it was not used.
    bed.llm.responder = () => JSON.stringify({ anchor: after.visual!.prompt, negative: 'halo', appearance: '', picture: '', kept: [], once: [], unused: ['雪夜'] })
    const drawn = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, notes: '这张要雪夜' }, task)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('人设图（三视图）')
    expect(drawn.sorted).toEqual({ kept: [], once: [], unused: ['雪夜'] })
    expect(drawn.parts?.subject).not.toContain('雪夜')
    expect((await project.findCharacter(card.id))!.visual?.prompt).toBe(after.visual!.prompt)
    expect((await project.findCharacter(card.id))!.appearance).toBe(after.appearance)

    // Nobody to sort them: nothing is guessed — the notes direct this picture, the look stays as it is, and that is said.
    bed.llm.responder = () => { throw new Error('the model is away') }
    const calls = images.calls.length
    const unsorted = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, notes: '披一件红斗篷' }, task)
    expect(unsorted.sorted).toEqual({ kept: [], once: ['披一件红斗篷'], unused: [], picture: '披一件红斗篷', unsorted: true })
    expect(unsorted.parts?.subject).toContain('披一件红斗篷')
    expect((await project.findCharacter(card.id))!.visual?.prompt).toBe(after.visual!.prompt)
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
    bed.llm.responder = () => '码头上，一个高瘦的女人望着靠岸的船'
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

  it('draws a portrait after the sheet as the same person', async () => {
    const { bed, images } = await studio()
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect((await bed.runtime.project.findCharacter(card.id))!.visual).toMatchObject({ sheet: sheet.path, portrait: portrait.path })
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

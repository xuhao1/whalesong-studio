// SPDX-License-Identifier: LGPL-3.0-or-later
/** What shapes a book's pictures: art direction, avoid lists, visual anchors, design sheets and reference images. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artDirectionOf, deriveVisual, illustrate, looksOf } from '../src/core/pipelines/illustrate'
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

  it('keeps the Studio, book, character and per-call avoid lists out of every picture', async () => {
    const { bed, images } = await studio({ negativePrompt: '文字, 水印' })
    await bed.runtime.project.updateManifest({ artAvoid: ['十字架', '哥特式教堂'] })
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦，黑发盘在脑后', visual: { prompt: 'lean woman, black hair coiled at the nape', negative: 'halo' } })
    const info = await illustrate(bed.core, bed.runtime, { kind: 'custom', prompt: '她站在门口', characters: [card.id], avoid: ['彩绘玻璃', '水印'] }, task)
    expect(info.parts?.avoid).toEqual(['文字', '水印', '十字架', '哥特式教堂', '彩绘玻璃', 'halo'])
    for (const word of ['十字架', '哥特式教堂', '彩绘玻璃', 'halo']) expect(images.calls[0]!.prompt).toContain(word)
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
    expect(looksOf({ id: 'c', name: '甲', role: 'minor', status: 'active', appearance: '短发', gender: '女', age: '三十' })).toBe('短发，女，三十')
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
    // The look is drawn against the main sheet, so it is the same person in other clothes.
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect(mourning.parts?.references).toEqual([{ path: main.path, label: '沈砚' }])
    expect(mourning.parts?.subject).toContain('plain black mourning robe')
    const saved = (await bed.runtime.project.findCharacter(card.id))!
    expect(saved.visual?.sheet).toBe(main.path)
    expect(saved.visual?.looks).toEqual([{ id: '丧服', name: '丧服', prompt: 'plain black mourning robe, hair unbound', sheet: mourning.path }])
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

  it('draws a portrait after the sheet as the same person', async () => {
    const { bed, images } = await studio()
    const card = await bed.runtime.project.saveCharacter({ name: '沈砚', appearance: '高瘦', visual: { prompt: 'lean woman, black hair' } })
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect((await bed.runtime.project.findCharacter(card.id))!.visual).toMatchObject({ sheet: sheet.path, portrait: portrait.path })
  })
})

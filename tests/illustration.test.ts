// SPDX-License-Identifier: LGPL-3.0-or-later
/** What shapes a book's pictures: art direction, avoid lists, visual anchors, design sheets and reference images. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    expect(cover.parts?.references).toEqual([{ path: sheet.path, label: '贾宝玉' }])
    expect(images.calls.at(-1)!.references).toHaveLength(1)
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

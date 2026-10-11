// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures the author gives one picture to go by: a design sheet, or the
 * design art of a place, a house, a thing. They go to the image model with the
 * prompt — after whatever the Studio itself holds the picture against — and
 * the prompt says of each what the author said is wanted of it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/core/settings'
import { illustrate, pictureWhole, redrawPicture } from '../src/core/pipelines/illustrate'
import { createTestBed, FakeImages, PIXEL, type TestBed } from './support/harness'
import { pixelsOf } from '../src/core/media/pixels'
import { cutPng } from '../src/core/media/png'

let bed: TestBed | undefined
afterEach(async () => {
  await bed?.cleanup()
  bed = undefined
})

async function studio(image: Partial<typeof DEFAULT_SETTINGS.image> = {}): Promise<{ bed: TestBed; images: FakeImages }> {
  const images = new FakeImages()
  bed = await createTestBed({ settings: { image: { ...DEFAULT_SETTINGS.image, provider: 'codex', ...image } }, bridges: images.bridges })
  return { bed, images }
}

const task = { origin: 'user' as const }
const LOOK = '二十七八岁的女子，身形清瘦，黑发在颈后盘成扁平的髻，穿未染色的亚麻长外衣，左眉有一道旧疤'
/** The line on the pictures the author gave: what is said of them, whatever picture is asked for. */
const THEIRS = '作者给的参考图，括号里是作者说的话：说了要它什么的，那一样照图画——文字里另有写法的，以图为准——别的照文字；没说的，'

describe('pictures the author gives one picture to go by', () => {
  it('go along with a design sheet, each called by what was said of it', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: LOOK })
    const face = await project.writeAsset('guides/face.png', PIXEL)
    const coat = await project.writeAsset('guides/coat.jpg', PIXEL)
    // What the author said is wanted of a picture is worked into the prompt by whoever writes it: left as a line
    // beside "black hair coiled at the nape", "the hair as in Image 1" loses to the paragraph.
    const WORKED = '用途：人物设定图（三视图）：「沈砚」\n构图：同一个人的全身站姿画三次\n人物「沈砚」：二十七八岁的女子，身形清瘦，脸和发型照图1，穿未染色的亚麻长外衣\n参考图：图1 是作者给的参考图（只要她的脸和发型）；图2 是作者给的参考图。'
    // Handed in once with the words still there that the picture is to stand in for — named as taken out, and not
    // taken out: it goes back.
    let tries = 0
    bed.llm.responder = () => JSON.stringify(++tries === 1
      ? { prompt: `${WORKED}\n黑发在颈后盘成扁平的髻`, replaced: ['黑发在颈后盘成扁平的髻'] }
      : { prompt: WORKED, replaced: ['黑发在颈后盘成扁平的髻'] })
    const drawn = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: face, note: '只要她的脸和发型' }, { path: coat }, { path: face }] }, task)
    // Both go, in the order given, each once.
    expect(images.calls).toHaveLength(1)
    expect(images.calls[0]!.references.map(reference => reference.mime)).toEqual(['image/png', 'image/jpeg'])
    // The brief. Of the second picture nothing was said: how she looks is as it shows, and her line points to it —
    // the words for her stay beside the pointer, unsent (written out beside the picture, they are what gets drawn).
    // The line on the pictures says what each is there for. This is what the director is handed, with what was said
    // of which picture.
    const brief = drawn.prompt
    expect(brief).toContain('人物「沈砚」：见图2')
    expect(brief).not.toContain(LOOK)
    expect(drawn.parts?.pieces?.find(part => part.of === 'look')).toMatchObject({ byPicture: true, words: LOOK })
    expect(brief).toContain('参考图：图1 是作者给的参考图（只要她的脸和发型）；图2 是作者给的参考图。')
    expect(brief).toContain(`${THEIRS}这个人的样子（脸、发式、体型和衣着）照图，图上看不出的照文字。`)
    expect(brief).toContain('这里要的是素净背景上的三视图：站直，两手空着、自然垂在身侧。参考图里的背景、姿势、手里拿的东西、光线和构图都不要带过来；画风照上面写的。')
    // (Not what is said of sheets and design art that go along by themselves.)
    expect(brief).not.toContain('人物的脸、发型和体型照各自的图')
    expect(bed.llm.requests).toHaveLength(2)
    expect(bed.llm.requests[1]!.prompt).toContain('the prompt still says "黑发在颈后盘成扁平的髻"')
    const asked = bed.llm.requests[0]!.prompt
    expect(asked).toContain(brief)
    expect(asked).toContain('## 作者给了参考图，并说了要它的什么（说明里在「参考图」那一段的括号里）\n图1：只要她的脸和发型\n')
    // (Of the second nothing was said: nothing of it is to be worked in.)
    expect(asked).not.toContain('图2：')
    expect(asked).toContain('0. 作者对一张参考图说了要它什么的，那一样就由图来定，文字不再说它：')
    expect(asked).toContain('你看不到图：不要去写图里有什么。')
    expect(asked).toContain('{"prompt": "写成的整段提示词", "replaced": ["被图代替的原话", "…"]}')
    // What goes to the image model is the director's working of it.
    expect(images.calls[0]!.prompt).toContain(WORKED)
    expect(drawn.written).toBe(WORKED)
    // …and its record says that it was worked, and which words gave way to the picture.
    expect(drawn.sent?.compact).toMatchObject({ asked: true, replaced: ['黑发在颈后盘成扁平的髻'] })
    // On its record they are the author's: what the page says of them, and what a redraw goes with.
    expect(drawn.parts?.references).toEqual([
      { path: face, label: '作者给的参考图（只要她的脸和发型）', given: true },
      { path: coat, label: '作者给的参考图', given: true },
    ])
    expect((await project.findCharacter(card.id))!.visual?.sheet).toBe(drawn.path)

    // Drawn again from its whole prompt, it goes with the same pictures — still the author's.
    const whole = await pictureWhole(bed.core, bed.runtime, drawn.id)
    expect(whole.references.map(reference => reference.path)).toEqual([face, coat])
    const again = await redrawPicture(bed.core, bed.runtime, { picture: drawn.id, prompt: whole.prompt }, task)
    expect(images.calls[1]!.references).toHaveLength(2)
    expect(again.parts?.references?.map(reference => reference.given)).toEqual([true, true])
    // …and one added there is one they gave it too.
    const hat = await project.writeAsset('guides/hat.webp', PIXEL)
    const more = await redrawPicture(bed.core, bed.runtime, { picture: again.id, prompt: whole.prompt, references: [{ path: face, label: '她的脸' }, { path: hat, label: '这顶帽子' }] }, task)
    expect(more.parts?.references).toEqual([{ path: face, label: '她的脸', given: true }, { path: hat, label: '这顶帽子', given: true }])

    // Given with nothing said of them, the brief goes as it is: nobody is asked to write it.
    const calls = bed.llm.requests.length
    const plain = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: coat }] }, task)
    expect(bed.llm.requests).toHaveLength(calls)
    expect(plain.written).toBeUndefined()
    expect(images.calls.at(-1)!.prompt).toContain('人物「沈砚」：见图1')
    expect(images.calls.at(-1)!.prompt).toContain('参考图：图1 是作者给的参考图。')
    // With something said of every one, she is written out: the pictures give what was asked of them, the words the rest.
    bed.llm.responder = () => 'no prompt'
    const partly = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: face, note: '只要她的脸' }] }, task)
    expect(partly.prompt).toContain(`人物「沈砚」：${LOOK}`)
    // (The director could not be had for it: the brief goes as it is, and the record says so.)
    expect(partly.sent?.compact).toMatchObject({ asked: true, failed: true })
    bed.llm.responder = () => JSON.stringify({ prompt: WORKED })
    // Without any, a sheet is drawn from the words alone, as before.
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(0)
    expect(images.calls.at(-1)!.prompt).not.toContain('参考图')
    expect(images.calls.at(-1)!.prompt).toContain(`人物「沈砚」：${LOOK}`)
  })

  it('come after what the Studio holds the sheet against by itself: the portrait where that leads, the main look for an outfit', async () => {
    // (Prompts go as the Studio lays them out here: what the brief says is what is looked at.)
    const { bed, images } = await studio({ promptWrite: 'never' })
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: LOOK })
    const portrait = await illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true, from: 'words' }, task)
    const hair = await project.writeAsset('guides/hair.png', PIXEL)
    // Against her portrait, and with a picture given: the portrait first — who she is — then the author's.
    const sheet = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, from: 'portrait', references: [{ path: hair, note: '发髻照这张' }] }, task)
    const sent = images.calls.at(-1)!
    expect(sent.references).toHaveLength(2)
    expect(sent.prompt).toContain('参考图：图1 是沈砚的立绘；图2 是作者给的参考图（发髻照这张）。')
    // What was said of "the reference" while there was one is said of the first.
    expect(sent.prompt).toContain('图1：是同一个人：脸、发型、体型和衣着照图1画。')
    expect(sent.prompt).toContain('图1里的背景、姿势、手里拿的东西、光线和构图都不要带过来。')
    expect(sent.prompt).toContain('作者给的参考图，括号里是作者说的话')
    expect(sent.prompt).toContain('它们的背景、构图和光线同样不要带过来；画风照上面写的。')
    expect(sheet.parts?.references).toEqual([{ path: portrait.path, label: '沈砚的立绘' }, { path: hair, label: '作者给的参考图（发髻照这张）', given: true }])

    // A look: the main sheet first — the same person — and of a picture given, the outfit is what is taken.
    const robe = await project.writeAsset('guides/robe.png', PIXEL)
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '丧服', prompt: '素白麻衣，腰系草绳', references: [{ path: robe }] }, task)
    const look = images.calls.at(-1)!
    expect(look.references).toHaveLength(2)
    expect(look.prompt).toContain('图1 是沈砚的主造型；图2 是作者给的参考图。')
    expect(look.prompt).toContain('图1：是同一个人：脸、发色、体型照图1画')
    expect(look.prompt).toContain('没说的，衣着、装备和头发的梳法照图，图上看不出的照文字。')
    // (She is who the main sheet shows; the outfit is in words, and the picture given.)
    expect(look.prompt).toContain('人物「沈砚」：见图1')
    expect(look.prompt).toContain('素白麻衣，腰系草绳')
    // Written by nobody, where the author has prompts go as laid out: what was said of a picture is in the brief's line alone.
    expect(bed.llm.requests).toHaveLength(0)
  })

  it('go along with the design art of a thing, a place, a house', async () => {
    const { bed, images } = await studio({ promptWrite: 'never' })
    const { project } = bed.runtime
    const photo = await project.writeAsset('guides/mirror.png', PIXEL)
    const mirror = await project.saveWorld({ name: '风月宝鉴', category: 'item', visualPrompt: '一面带柄的铜镜，镜背錾着四个字' })
    const art = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id, references: [{ path: photo, note: '镜柄的形状' }] }, task)
    let sent = images.calls.at(-1)!
    expect(sent.references).toHaveLength(1)
    expect(sent.prompt).toContain('物件「风月宝鉴」：一面带柄的铜镜，镜背錾着四个字')
    expect(sent.prompt).toContain('参考图：图1 是作者给的参考图（镜柄的形状）。')
    expect(sent.prompt).toContain(`${THEIRS}这件东西的样子（形状、材质、纹饰和颜色）照图，图上看不出的照文字。`)
    expect(sent.prompt).toContain('这里要的是素底上完整的这一件：参考图里的背景、手、别的东西、光线和构图都不要带过来；画风照上面写的。')
    expect(art.parts?.references).toEqual([{ path: photo, label: '作者给的参考图（镜柄的形状）', given: true }])
    expect((await project.findWorld(mirror.id))!.visualImage).toBe(art.path)

    const garden = await project.saveWorld({ name: '大观园', category: 'location', visualPrompt: '一座带水池和游廊的大园子' })
    await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, references: [{ path: photo }] }, task)
    sent = images.calls.at(-1)!
    // Nothing said of it: how the place looks is as the picture shows — its line points there.
    expect(sent.prompt).toContain('地点「大观园」：见图1')
    expect(sent.prompt).not.toContain('一座带水池和游廊的大园子')
    expect(sent.prompt).toContain('没说的，这个地方的样子（格局、建筑的式样和材质）照图，图上看不出的照文字。')
    expect(sent.prompt).toContain('这里要的是这个地方的远景，没有人：参考图里的人、构图和光线不要带过来；画风照上面写的。')

    const house = await project.saveWorld({ name: '贾府', category: 'faction', visualPrompt: '朱门高墙，门前一对石狮' })
    await illustrate(bed.core, bed.runtime, { kind: 'location', target: house.id, references: [{ path: photo }] }, task)
    sent = images.calls.at(-1)!
    expect(sent.prompt).toContain('没说的，它看得见的样子（门庭、徽记旗号、衣着的式样）照图，图上看不出的照文字。')

    // Where the author has looks written out whatever picture goes along, they are.
    await bed.core.settings.update({ image: { looks: 'always' } })
    await illustrate(bed.core, bed.runtime, { kind: 'location', target: garden.id, references: [{ path: photo }] }, task)
    expect(images.calls.at(-1)!.prompt).toContain('地点「大观园」：一座带水池和游廊的大园子')
    await bed.core.settings.update({ image: { looks: 'pictured' } })

    // Tried with several services, every one of them gets the pictures given.
    const tried = await illustrate(bed.core, bed.runtime, { kind: 'item', target: mirror.id, references: [{ path: photo }], trials: [{ label: 'Codex again', image: { ...DEFAULT_SETTINGS.image, provider: 'codex' } }] }, task)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    expect((await project.illustrations()).find(item => item.path === tried.tried![0]!.path)!.parts?.references?.[0]).toMatchObject({ path: photo, given: true })
  })

  it('take another person\'s sheet for what it is — somebody else — and of it the likeness of family, not the person', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    bed.llm.responder = request => JSON.stringify({ prompt: /## 说明\n([\s\S]*?)\n\n## /.exec(request.prompt)?.[1] ?? request.prompt, replaced: [] })
    // Her elder sister has a sheet; the cards say what the two are to each other — on the sister's card alone.
    const elder = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: LOOK })
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: elder.id }, task)
    const hers = (await project.findCharacter(elder.id))!.visual!.sheet!
    const SISTER = '十九岁的姑娘，圆脸，两条辫子，蓝布学生装'
    const card = await project.saveCharacter({ name: '沈蕙', role: 'supporting', appearance: SISTER })
    await project.saveCharacter({ id: elder.id, relationships: [{ target: card.id, kind: '姐妹' }] })
    const calls = images.calls.length
    const asks = bed.llm.requests.length
    // Given with nothing said of it: not "the whole look as in this picture" — that is the sister. Her own words stay
    // written out, the picture is called another person's, by name and by what the two are, and what is wanted of it
    // is said for the author: the cut of the face.
    const drawn = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: hers }] }, task)
    expect(images.calls).toHaveLength(calls + 1)
    expect(images.calls.at(-1)!.references).toHaveLength(1)
    const brief = drawn.prompt
    expect(brief).toContain(`人物「沈蕙」：${SISTER}`)
    expect(brief).not.toContain('见图1')
    expect(brief).toContain('参考图：图1 是另一个人「沈砚」（和「沈蕙」：姐妹）的人设图（相貌像沈砚：只取脸型和五官，看得出是一家人；不是同一个人——头发照文字写的梳，不戴图上的发饰；年纪、体型和衣着也照文字）。')
    expect(brief).toContain(`${THEIRS}`)
    expect(brief).toContain('标着“另一个人”的图上是别人：画的不是那个人，只取括号里说的那几样。')
    // What is wanted of it is for whoever writes the prompt to work in, as anything said of a picture given is.
    expect(bed.llm.requests.length).toBe(asks + 1)
    expect(bed.llm.requests.at(-1)!.prompt).toContain('图1：相貌像沈砚：只取脸型和五官，看得出是一家人；不是同一个人——头发照文字写的梳，不戴图上的发饰；年纪、体型和衣着也照文字\n')
    // On its record: a picture the author gave, and whose.
    expect(drawn.parts?.references).toEqual([expect.objectContaining({ path: hers, given: true, label: expect.stringContaining('另一个人「沈砚」') })])
    expect(drawn.parts?.pieces?.find(part => part.of === 'look')?.byPicture).toBeUndefined()
    // The sister's own sheet is untouched, and the new one is the younger one's.
    expect((await project.findCharacter(elder.id))!.visual!.sheet).toBe(hers)
    expect((await project.findCharacter(card.id))!.visual!.sheet).toBe(drawn.path)
    // What the author says is wanted of it holds instead — still as another person's picture.
    const dressed = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: hers, note: '只要这身衣服的款式' }] }, task)
    expect(dressed.prompt).toContain('图1 是另一个人「沈砚」（和「沈蕙」：姐妹）的人设图（只要这身衣服的款式）')
    expect(dressed.prompt).not.toContain('相貌像沈砚')
    // A picture of the person herself — an earlier sheet of hers — is no other person's: the look goes by it, as before.
    const own = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: drawn.path }] }, task)
    expect(own.prompt).toContain('人物「沈蕙」：见图1')
    expect(own.prompt).not.toContain('另一个人')
    // Of an outfit, a picture given is the outfit, whoever wears it there: the sister's sheet lends her clothes, not her face.
    const look = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, look: '姐姐的衣服', prompt: '借来的亚麻长外衣', references: [{ path: hers }] }, task)
    expect(look.prompt).toContain('图1 是沈蕙的主造型；图2 是作者给的参考图。')
    expect(look.prompt).toContain('没说的，衣着、装备和头发的梳法照图')
    expect(look.prompt).not.toContain('另一个人')
  })

  it('send of another person\'s sheet one figure — and its head and shoulders alone where a likeness is all that is wanted', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    bed.llm.responder = request => JSON.stringify({ prompt: /## 说明\n([\s\S]*?)\n\n## /.exec(request.prompt)?.[1] ?? request.prompt, replaced: [] })
    // A sheet as one is drawn: three figures side by side, 900 by 600.
    const [width, height] = [900, 600]
    const pixels = new Uint8Array(width * height * 3).fill(236)
    for (const [from, to] of [[80, 260], [380, 520], [640, 820]] as const) for (let y = 50; y < 570; y++) for (let x = from; x < to; x++) pixels.set([70, 90, 96], (y * width + x) * 3)
    const hers = await project.writeAsset('images/sheet-沈砚-0a0a0a0a.png', await cutPng({ width, height, kind: 2, each: 3, pixels }, { left: 0, top: 0, width, height }))
    await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: LOOK, visual: { sheet: hers } })
    const card = await project.saveCharacter({ name: '沈蕙', role: 'supporting', appearance: '十九岁的姑娘，圆脸，两条辫子，蓝布学生装' })
    // Nothing said of it: the face is wanted — the head and shoulders of the front view go, not the figure (its
    // clothes came along) and not the sheet (the side view's hair did). The record says what went.
    const like = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: hers }] }, task)
    const face = pixelsOf(images.calls.at(-1)!.references[0]!.data)!
    expect(face.width).toBeLessThan(330)
    expect(face.height).toBeLessThan(200)
    expect(like.parts?.references).toEqual([expect.objectContaining({ path: hers, given: true, sheet: true, front: true, face: true })])
    // Something else said of it — the clothes, say: the front view whole, one figure of the three.
    const dressed = await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: hers, note: '只要这身衣服的款式' }] }, task)
    const front = pixelsOf(images.calls.at(-1)!.references[0]!.data)!
    expect(front.width).toBeLessThan(330)
    expect(front.height).toBe(600)
    expect(dressed.parts?.references?.[0]).toMatchObject({ front: true })
    expect(dressed.parts?.references?.[0]?.face).toBeUndefined()
  })

  it('are asked for by name: one that is gone, or given to a picture that takes none, is said', async () => {
    const { bed, images } = await studio()
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: '沈砚', role: 'protagonist', appearance: LOOK })
    await expect(illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: 'assets/guides/gone.png' }] }, task)).rejects.toThrow('参考图不在书里了')
    const face = await project.writeAsset('guides/face.png', PIXEL)
    await expect(illustrate(bed.core, bed.runtime, { kind: 'portrait', target: card.id, plain: true, references: [{ path: face }] }, task)).rejects.toThrow('reference pictures of the author')
    // A path that is no picture of the book is no picture given.
    await illustrate(bed.core, bed.runtime, { kind: 'sheet', target: card.id, references: [{ path: '../outside.png' }, { path: 'novel.json' }] }, task)
    expect(images.calls).toHaveLength(1)
    expect(images.calls[0]!.references).toHaveLength(0)
  })
})

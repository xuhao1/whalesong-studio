// SPDX-License-Identifier: LGPL-3.0-or-later
/** The reader: where the lines of the audio script sit in the prose, and the code a phone scans to open it. */
import { describe, expect, it } from 'vitest'
import { qrCode, qrPath } from '../src/shared/qr'
import { alignScript, blocksOf, segmentsOf, subtitleOf } from '../src/shared/reader'

describe('the script in the prose', () => {
  const text = '更衣间的门开了一条缝。拍卖师探进半个头。\n\n“零七。”\n\n“在。”\n\n门开了。\n她走出去。\n\n![穹顶](assets/images/dome.png)\n\n她用“我”。手册上写她应该用“我们”。'
  const lines = [
    { id: 'l0', text: '更衣间的门开了一条缝。拍卖师探进半个头。' },
    { id: 'l1', text: '零七。' },
    { id: 'l2', text: '在。' },
    // Two paragraphs the script reads as one line.
    { id: 'l3', text: '门开了。她走出去。' },
    { id: 'l4', text: '她用“我”。手册上写她应该用“我们”。' },
  ]

  it('finds every line, across paragraph breaks and without the quotation marks', () => {
    const found = alignScript(text, lines)
    expect(found.size).toBe(5)
    expect(text.slice(found.get('l1')!.start, found.get('l1')!.end)).toBe('零七。')
    expect(text.slice(found.get('l3')!.start, found.get('l3')!.end)).toBe('门开了。\n她走出去。')
    // Lines keep the order of the text: none starts before the one before it ends.
    const order = lines.map(line => found.get(line.id)!)
    for (let index = 1; index < order.length; index++) expect(order[index]!.start).toBeGreaterThanOrEqual(order[index - 1]!.end)
  })

  it('still places a line the director re-punctuated, and skips one that is not there', () => {
    const found = alignScript(text, [
      { id: 'a', text: '更衣间的门开了一条缝，拍卖师探进半个头！' },
      { id: 'b', text: '这句话正文里没有。' },
      { id: 'c', text: '在。' },
    ])
    expect(found.has('a')).toBe(true)
    expect(found.has('b')).toBe(false)
    expect(text.slice(found.get('c')!.start, found.get('c')!.end)).toBe('在。')
  })

  it('places a line the director joined out of two halves of a quote', () => {
    const split = '门响，周衡进来。\n\n“写一封信。”他说，“给一位太太。”\n\n沈蘅没碰银元：“她丈夫知道？”\n\n“知道。”'
    const found = alignScript(split, [
      { id: 'n', text: '门响，周衡进来。' },
      { id: 'a', text: '写一封信。给一位太太。' },
      { id: 'b', text: '她丈夫知道？' },
      { id: 'c', text: '知道。' },
    ])
    // The joined line covers both halves and the "he said" between them.
    expect(split.slice(found.get('a')!.start, found.get('a')!.end)).toBe('写一封信。”他说，“给一位太太。')
    expect(split.slice(found.get('b')!.start, found.get('b')!.end)).toBe('她丈夫知道？')
    // The one-word answer is found after the question, not inside it.
    expect(found.get('c')!.start).toBeGreaterThan(found.get('b')!.end)
    expect(split.slice(found.get('c')!.start, found.get('c')!.end)).toBe('知道。')
  })

  it('cuts a paragraph into what each line covers', () => {
    const found = alignScript(text, lines)
    const ranges = lines.map(line => ({ id: line.id, ...found.get(line.id)! }))
    const blocks = blocksOf(text)
    expect(blocks.map(block => block.kind)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'image', 'paragraph'])
    const spoken = blocks[1] as { text: string; offset: number }
    expect(segmentsOf(spoken, ranges)).toEqual([{ text: '“' }, { text: '零七。', line: 'l1' }, { text: '”' }])
    // The line that spans two paragraphs marks both.
    expect(segmentsOf(blocks[3] as { text: string; offset: number }, ranges)).toEqual([{ text: '门开了。', line: 'l3' }])
    expect(segmentsOf(blocks[4] as { text: string; offset: number }, ranges)).toEqual([{ text: '她走出去。', line: 'l3' }])
    // Every character of every paragraph is in exactly one piece.
    for (const block of blocks) if (block.kind === 'paragraph') expect(segmentsOf(block, ranges).map(segment => segment.text).join('')).toBe(block.text)
    // With no script there is one piece: the paragraph.
    expect(segmentsOf(spoken, [])).toEqual([{ text: spoken.text }])
  })
})

// ───────────── a reader for the code, written from the standard and not from the writer ─────────────

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let value = 1
  for (let power = 0; power < 255; power++) {
    EXP[power] = value
    LOG[value] = power
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let power = 255; power < 512; power++) EXP[power] = EXP[power - 255]!
}
const times = (left: number, right: number): number => (left === 0 || right === 0 ? 0 : EXP[LOG[left]! + LOG[right]!]!)

const BLOCKS: Record<number, { ec: number; blocks: [number, number][] }> = {
  1: { ec: 10, blocks: [[1, 16]] }, 2: { ec: 16, blocks: [[1, 28]] }, 3: { ec: 26, blocks: [[1, 44]] }, 4: { ec: 18, blocks: [[2, 32]] }, 5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] }, 7: { ec: 18, blocks: [[4, 31]] }, 8: { ec: 22, blocks: [[2, 38], [2, 39]] }, 9: { ec: 22, blocks: [[3, 36], [2, 37]] }, 10: { ec: 26, blocks: [[4, 43], [1, 44]] },
}
const CENTRES: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }
const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
]

/** Read a symbol back: format word, mask, codewords, error-correction check, text. */
function readQr(modules: boolean[][]): string {
  const size = modules.length
  const version = (size - 17) / 4
  expect(Number.isInteger(version)).toBe(true)
  // The format word beside the top-left finder, low bit first as the standard lays it out.
  const cells: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
  let word = 0
  cells.forEach(([x, y], bit) => { if (modules[y]![x]) word |= 1 << bit })
  // Its second copy must say the same.
  let copy = 0
  for (let bit = 0; bit < 8; bit++) if (modules[8]![size - 1 - bit]) copy |= 1 << bit
  for (let bit = 8; bit < 15; bit++) if (modules[size - 15 + bit]![8]) copy |= 1 << bit
  expect(copy).toBe(word)
  const plain = word ^ 0x5412
  // A valid format word leaves no remainder when divided by the BCH generator.
  let remainder = plain
  for (let bit = 14; bit >= 10; bit--) if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10)
  expect(remainder).toBe(0)
  expect(plain >>> 13).toBe(0) // level M
  const mask = (plain >>> 10) & 7
  // Which modules carry no data.
  const taken = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const take = (x: number, y: number): void => { if (x >= 0 && y >= 0 && x < size && y < size) taken[y]![x] = true }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) take(cx + dx, cy + dy)
  for (const cy of CENTRES[version]!) {
    for (const cx of CENTRES[version]!) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) take(cx + dx, cy + dy)
    }
  }
  for (let at = 0; at < size; at++) {
    take(at, 6)
    take(6, at)
  }
  for (let at = 0; at < 9; at++) {
    take(8, at)
    take(at, 8)
  }
  for (let at = 0; at < 8; at++) {
    take(size - 1 - at, 8)
    take(8, size - 1 - at)
  }
  if (version >= 7) for (let a = 0; a < 6; a++) for (let b = 0; b < 3; b++) {
    take(size - 11 + b, a)
    take(a, size - 11 + b)
  }
  // The data, in the standard's zigzag, with the mask taken off.
  const bits: number[] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      for (let side = 0; side < 2; side++) {
        const x = right - side
        const y = ((right + 1) & 2) === 0 ? size - 1 - step : step
        if (!taken[y]![x]) bits.push((modules[y]![x] !== MASKS[mask]!(x, y)) ? 1 : 0)
      }
    }
  }
  const spec = BLOCKS[version]!
  const count = spec.blocks.reduce((sum, [blocks]) => sum + blocks, 0)
  const dataTotal = spec.blocks.reduce((sum, [blocks, data]) => sum + blocks * data, 0)
  const codewords: number[] = []
  for (let at = 0; at + 8 <= bits.length && codewords.length < dataTotal + count * spec.ec; at += 8) codewords.push(bits.slice(at, at + 8).reduce((sum, bit) => (sum << 1) | bit, 0))
  expect(codewords).toHaveLength(dataTotal + count * spec.ec)
  // Take the interleaving apart.
  const lengths = spec.blocks.flatMap(([blocks, data]) => new Array<number>(blocks).fill(data))
  const blocks = lengths.map(() => ({ data: [] as number[], ec: [] as number[] }))
  let at = 0
  for (let index = 0; index < Math.max(...lengths); index++) for (let block = 0; block < count; block++) if (index < lengths[block]!) blocks[block]!.data.push(codewords[at++]!)
  for (let index = 0; index < spec.ec; index++) for (let block = 0; block < count; block++) blocks[block]!.ec.push(codewords[at++]!)
  // A block without errors evaluates to zero at every root of the generator.
  for (const block of blocks) {
    const message = [...block.data, ...block.ec]
    for (let root = 0; root < spec.ec; root++) {
      let value = 0
      for (const byte of message) value = times(value, EXP[root]!) ^ byte
      expect(value).toBe(0)
    }
  }
  const stream = blocks.flatMap(block => block.data).flatMap(byte => Array.from({ length: 8 }, (_, bit) => (byte >>> (7 - bit)) & 1))
  const read = (from: number, length: number): number => stream.slice(from, from + length).reduce((sum, bit) => (sum << 1) | bit, 0)
  expect(read(0, 4)).toBe(0b0100)
  const lengthBits = version >= 10 ? 16 : 8
  const length = read(4, lengthBits)
  const bytes = Array.from({ length }, (_, index) => read(4 + lengthBits + index * 8, 8))
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

describe('the code a phone scans', () => {
  it('reads back as what was written, at every size', () => {
    const addresses = [
      'hi',
      'http://10.0.0.7:4319/',
      'http://192.168.31.105:4319/AbCdEfGhIjKlMnOpQrStUvWx/',
      'http://192.168.31.105:4319/AbCdEfGhIjKlMnOpQrStUvWx/#/book/novel_8f3k2m1p',
      'http://xus-macbook-pro.local:4319/AbCdEfGhIjKlMnOpQrStUvWx/#/book/novel_8f3k2m1p',
      `http://example.test/${'x'.repeat(120)}`,
      `http://example.test/${'长'.repeat(60)}`,
    ]
    const sizes = new Set<number>()
    for (const address of addresses) {
      const modules = qrCode(address)
      expect(modules.every(row => row.length === modules.length)).toBe(true)
      sizes.add(modules.length)
      expect(readQr(modules)).toBe(address)
    }
    // From the smallest symbol to the largest this writer makes.
    expect(Math.min(...sizes)).toBe(21)
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(53)
  })

  it('has the three finder patterns, a quiet zone in the drawing, and a limit', () => {
    const modules = qrCode('http://192.168.1.2:4319/token/')
    const size = modules.length
    const finder = (x: number, y: number): boolean => [0, 6].every(edge => modules[y + edge]!.slice(x, x + 7).every(Boolean)) && modules[y + 3]!.slice(x + 2, x + 5).every(Boolean) && !modules[y + 1]![x + 1]
    expect(finder(0, 0) && finder(size - 7, 0) && finder(0, size - 7)).toBe(true)
    // The module that is always dark, and the timing row that alternates.
    expect(modules[size - 8]![8]).toBe(true)
    for (let x = 8; x < size - 8; x++) expect(modules[6]![x]).toBe(x % 2 === 0)
    const drawn = qrPath('http://192.168.1.2:4319/token/')
    expect(drawn.size).toBe(size + 8)
    expect(drawn.path.startsWith('M')).toBe(true)
    expect(() => qrCode('x'.repeat(300))).toThrow()
  })

  it('shows under a picture the sentence the voice has reached, not the whole take', () => {
    const take = '雨落在法租界旧书铺的青瓦上。沈蘅把未卖出的讣文纸收进抽屉，纸边泡软，墨香混着潮气。灯只剩一盏。\n门响，周衡进来。西装三件套没湿，怀表链横在马甲上，压出一道亮痕。'
    expect(subtitleOf(take, 0)).toBe('雨落在法租界旧书铺的青瓦上。')
    expect(subtitleOf(take, 0.3)).toBe('沈蘅把未卖出的讣文纸收进抽屉，纸边泡软，墨香混着潮气。灯只剩一盏。')
    expect(subtitleOf(take, 0.99)).toBe('门响，周衡进来。西装三件套没湿，怀表链横在马甲上，压出一道亮痕。')
    expect(subtitleOf(take, 1)).toBe('门响，周衡进来。西装三件套没湿，怀表链横在马甲上，压出一道亮痕。')
    // A line of one sentence is its own subtitle.
    expect(subtitleOf('零七。', 0.5)).toBe('零七。')
    expect(subtitleOf('He stopped. Then he went on.', 0.9)).toBe('He stopped. Then he went on.')
  })
  it('shows somebody\'s moment, once drawn, after the paragraph of its chapter that tells it — beside the text, not in it', async () => {
    const { placeFigures } = await import('../src/shared/reader')
    const text = '雨停了。\n\n宝玉和黛玉在桃花树下，摊开一卷《会真记》。\n\n晚间，袭人来催。'
    expect(placeFigures(text, [{ path: 'assets/images/a.png', caption: '共读西厢 · 黛玉', told: '共读西厢桃花树下，黛玉接过《会真记》，低头看得入神。' }])).toEqual([{ path: 'assets/images/a.png', caption: '共读西厢 · 黛玉', after: text.indexOf('宝玉和黛玉') }])
    // One nothing of the chapter tells stands at its end; one the text shows already is not shown twice.
    expect(placeFigures(text, [{ path: 'assets/images/b.png', caption: 'x', told: 'zzz' }])[0]!.after).toBe(text.indexOf('晚间'))
    expect(placeFigures(`${text}\n\n![](assets/images/a.png)`, [{ path: 'assets/images/a.png', caption: 'x', told: '桃花树下' }])).toEqual([])
  })

  it('carries a portrait of each moment where the chapter tells it and the one that stands for the person where they first come on — not both in one chapter', async () => {
    const { createTestBed, PIXEL } = await import('./support/harness')
    const bed = await createTestBed()
    try {
      const { project } = bed.runtime
      const first = await project.addChapter({ title: '进府' })
      await project.saveChapterText(first.id, '轿子进了角门。\n\n黛玉下了轿，随婆子往里走。\n\n晚间各自安歇。')
      const later = await project.addChapter({ title: '葬花' })
      await project.saveChapterText(later.id, '园中花谢。\n\n黛玉肩上担着花锄，锄上挂着花囊，往花冢去。\n\n宝玉在山坡上听见。')
      const plain = await project.writeAsset('images/plain.png', PIXEL)
      const other = await project.writeAsset('images/plain-2.png', PIXEL)
      const now = await project.writeAsset('images/zang-2.png', PIXEL)
      const before = await project.writeAsset('images/zang-1.png', PIXEL)
      const card = await project.saveCharacter({
        name: '黛玉',
        role: 'protagonist',
        firstAppearance: first.id,
        visual: { portraits: [now, plain, other], scenes: [{ id: 's1', title: '葬花', chapter: later.id, text: '她肩担花锄，锄上挂着花囊，独自往花冢去', portrait: now }] },
      })
      // An earlier portrait of the same moment: off the card, still in the gallery, and its record says what it is of.
      await project.addIllustration({ id: 'img-old', path: before, prompt: '葬花', kind: 'portrait', target: card.id, createdAt: new Date().toISOString(), moment: { title: '葬花', scene: 's1', chapter: later.id } })
      const places = async (): Promise<unknown[]> => (await project.portraitPlaces()).map(place => [place.key, place.as, place.chapter, place.hidden, place.spare])

      // Nobody chose: the first portrait stands for her. It is the picture of her moment — it stands there, and
      // where she first comes on as the picture of her; the others wait to be asked in.
      expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: now })
      expect(await places()).toEqual([
        [now, 'moment', later.id, false, undefined],
        [plain, 'person', first.id, true, 'person'],
        [other, 'person', first.id, true, 'person'],
        [before, 'moment', later.id, true, 'moment'],
        [`${now}#face`, 'person', first.id, false, undefined],
      ])
      const text = await project.chapterText(first.id)
      // One picture, two places: each is known by its own key, so keeping one out of the text leaves the other in.
      expect(await project.chapterFigures(first.id)).toEqual([{ path: now, key: `${now}#face`, caption: '黛玉', after: text.indexOf('黛玉下了轿') }])
      expect((await project.chapterFigures(later.id)).map(figure => [figure.key, figure.caption])).toEqual([[now, '葬花 · 黛玉']])
      await project.showFigure(`${now}#face`, false)
      expect([await project.chapterFigures(first.id), (await project.chapterFigures(later.id)).map(figure => figure.path)]).toEqual([[], [now]])
      await project.showFigure(`${now}#face`, true)
      expect([(await project.chapterFigures(first.id)).map(figure => figure.key), await project.hiddenFigures(), await project.shownFigures()]).toEqual([[`${now}#face`], [], []])

      // The author chooses the portrait that stands for her: that one, where she first comes on — and it stays
      // chosen when another is drawn after it.
      await project.saveCharacter({ id: card.id, visual: { face: plain } })
      expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: plain, face: plain, portraits: [now, plain, other] })
      expect(await places()).toEqual([
        [now, 'moment', later.id, false, undefined],
        [plain, 'person', first.id, false, undefined],
        [other, 'person', first.id, true, 'person'],
        [before, 'moment', later.id, true, 'moment'],
      ])
      expect(await project.chapterFigures(first.id)).toEqual([{ path: plain, key: plain, caption: '黛玉', after: text.indexOf('黛玉下了轿') }])
      const newer = await project.writeAsset('images/newer.png', PIXEL)
      await project.saveCharacter({ id: card.id, visual: { portrait: newer } })
      expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: plain, face: plain, portraits: [newer, now, plain, other] })
      expect((await project.chapterFigures(first.id)).map(figure => figure.path)).toEqual([plain])
      // A picture that takes the chosen one's place is the chosen one; the choice let go, the newest stands for her again.
      const redrawn = await project.writeAsset('images/plain-redrawn.png', PIXEL)
      await project.replacePicture(plain, redrawn)
      expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: redrawn, face: redrawn })
      await project.saveCharacter({ id: card.id, visual: { face: '' } })
      expect((await project.findCharacter(card.id))!.visual).toMatchObject({ portrait: newer })
      expect((await project.findCharacter(card.id))!.visual!.face).toBeUndefined()
      await project.saveCharacter({ id: card.id, visual: { portraits: [now, plain, other], face: plain } })

      // One the rule leaves out is asked in, and let go again; nothing is written down for what stands as the rule has it.
      await project.showFigure(before, true)
      expect((await project.chapterFigures(later.id)).map(figure => figure.path)).toEqual([now, before])
      expect([await project.hiddenFigures(), await project.shownFigures()]).toEqual([[], [before]])
      await project.showFigure(before, false)
      expect((await project.chapterFigures(later.id)).map(figure => figure.path)).toEqual([now])
      expect([await project.hiddenFigures(), await project.shownFigures()]).toEqual([[], []])

      // One that stands is kept out, and comes back when the author lets it.
      await project.showFigure(now, false)
      expect(await project.chapterFigures(later.id)).toEqual([])
      expect((await project.portraitPlaces()).find(place => place.key === now)).toMatchObject({ hidden: true })
      await project.showFigure(now, true)
      expect([await project.hiddenFigures(), await project.shownFigures()]).toEqual([[], []])

      // She first comes on in the chapter of her moment: the moment is the picture of her there, where it is told — the one of the person is not shown beside it.
      await project.saveCharacter({ id: card.id, firstAppearance: later.id })
      expect((await places()).slice(0, 2)).toEqual([[now, 'moment', later.id, false, undefined], [plain, 'person', later.id, true, 'chapter']])
      const told = await project.chapterText(later.id)
      expect(await project.chapterFigures(later.id)).toEqual([{ path: now, key: now, caption: '葬花 · 黛玉', after: told.indexOf('黛玉肩上担着花锄') }])
      // The moment kept out of the text, the portrait of her is what that chapter has of her again.
      await project.showFigure(now, false)
      expect((await project.chapterFigures(later.id)).map(figure => figure.path)).toEqual([plain])
      await project.showFigure(now, true)
      // The same where the picture of the moment is itself the one that stands for her: once, at the moment — and
      // its place as her portrait is one the author can still ask in, by its own key.
      await project.saveCharacter({ id: card.id, visual: { face: now } })
      expect((await places()).filter(place => (place as string[])[0]!.startsWith(now))).toEqual([[now, 'moment', later.id, false, undefined], [`${now}#face`, 'person', later.id, true, 'chapter']])
      expect((await project.chapterFigures(later.id)).map(figure => figure.path)).toEqual([now])
      await project.saveCharacter({ id: card.id, visual: { face: plain }, firstAppearance: first.id })

      // A picture held out — one drawn only to be compared — stays out whatever the rule would say, until it is let go.
      await project.holdFigure(plain, true)
      expect(await project.chapterFigures(first.id)).toEqual([])
      await project.holdFigure(plain, false)
      expect((await project.chapterFigures(first.id)).map(figure => figure.path)).toEqual([plain])
    } finally {
      await bed.cleanup()
    }
  })
})

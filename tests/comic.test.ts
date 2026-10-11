// SPDX-License-Identifier: LGPL-3.0-or-later
/** Motion comic: how finely a chapter is cut into panels, and that the cut always covers the whole chapter. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LlmRequest } from '../src/core/llm'
import { beatsOf, buildStoryboard, PANEL_SECONDS, planPanels, renderPanels, sheetsAhead } from '../src/core/pipelines/comic'
import type { AudioLine, AudioScript, ComicBoard } from '../src/shared/types'
import { hashText, proseOnly } from '../src/shared/text'
import type { JobContext } from '../src/core/jobs'
import { createTestBed, FakeImages, type TestBed } from './support/harness'

/** A job nobody watches. */
function quietJob(): JobContext {
  return { signal: new AbortController().signal, progress: () => {}, write: () => {}, rewrite: () => {}, result: () => {}, think: () => {}, crew: () => {}, note: () => () => {} } as unknown as JobContext
}

const line = (id: string, text: string, extra: Partial<AudioLine> = {}): AudioLine => ({ id, kind: 'narration', text, ...extra })

/** The units a storyboard request lists, read back out of its prompt. */
function unitsIn(request: LlmRequest): number {
  return request.prompt.split('\n').filter(row => /^\d+ \| /.test(row)).length
}

/** A director that cuts every `per` units — or does what the test tells it to. */
function director(per: number, stopAfter = Infinity): (request: LlmRequest) => string {
  return (request) => {
    const units = Math.min(unitsIn(request), stopAfter)
    const panels = []
    for (let from = 0; from < units; from += per) panels.push({ from, to: Math.min(units - 1, from + per - 1), description: `画面 ${from}`, prompt: `prompt for units ${from}-${Math.min(units - 1, from + per - 1)}`, camera: 'pan-left' })
    return JSON.stringify({ panels })
  }
}

/** Where a panel sits in the script, as line index plus fraction of that line. */
function span(board: ComicBoard, script: AudioScript, index: number): [number, number] {
  const panel = board.panels[index]!
  const first = script.lines.findIndex(entry => entry.id === panel.lines[0])
  const last = script.lines.findIndex(entry => entry.id === panel.lines.at(-1))
  return [first + (panel.begin ?? 0), last + (panel.end ?? 1)]
}

describe('storyboard arithmetic', () => {
  it('cuts a long line into sentence-sized beats and leaves a short one whole', () => {
    const long = '拍卖厅比她预想的窄，但高。三排买主席，木板是打捞上来的船板，一条一条拼起来，缝里还嵌着盐。第一排坐着一个金发女人，白甲没有卸，肩上搭着一条灰披风。她两只手没戴手套，交叠着搁在膝盖上。'
    const beats = beatsOf([line('l0', '门开了。'), line('l1', long, { duration: 20 })])
    expect(beats[0]).toMatchObject({ line: 0, from: 0, to: 1, text: '门开了。' })
    const inside = beats.filter(beat => beat.line === 1)
    expect(inside.length).toBeGreaterThanOrEqual(3)
    // The beats of a line tile it, and share its time by their length.
    expect(inside[0]!.from).toBe(0)
    expect(inside.at(-1)!.to).toBe(1)
    for (let index = 1; index < inside.length; index++) expect(inside[index]!.from).toBeCloseTo(inside[index - 1]!.to, 6)
    expect(inside.reduce((sum, beat) => sum + beat.seconds, 0)).toBeCloseTo(20, 4)
    expect(inside.map(beat => beat.text).join('')).toBe(long)
    // A line never voiced is timed at reading pace.
    expect(beats[0]!.seconds).toBeGreaterThan(0.5)
    expect(beats[0]!.seconds).toBeLessThan(2)
  })

  it('turns a density and a ceiling into a number of panels', () => {
    // Ten minutes of script in sixty beats of ten seconds.
    const beats = Array.from({ length: 60 }, (_, index) => ({ line: index, from: 0, to: 1, text: '…', seconds: 10 }))
    expect(planPanels(beats, 'balanced').target).toBe(Math.round(600 / PANEL_SECONDS.balanced))
    expect(planPanels(beats, 'sparse').target).toBeLessThan(planPanels(beats, 'balanced').target)
    expect(planPanels(beats, 'dense').target).toBe(60)
    const auto = planPanels(beats, 'auto')
    expect(auto.low).toBe(15)
    expect(auto.high).toBe(60)
    // The ceiling holds whatever the density.
    for (const density of ['auto', 'sparse', 'balanced', 'dense'] as const) {
      const plan = planPanels(beats, density, 12)
      expect(plan.maxPanels).toBe(12)
      expect(plan.target).toBeLessThanOrEqual(12)
      expect(plan.high).toBeLessThanOrEqual(12)
    }
    expect(planPanels(beats.slice(0, 1), 'dense')).toMatchObject({ target: 1, low: 1, high: 1 })
  })
})

describe('storyboard', () => {
  let bed: TestBed
  let chapterId: string
  let script: AudioScript
  beforeEach(async () => {
    bed = await createTestBed()
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '拍卖厅' })
    chapterId = plan.id
    // 120 lines of about three seconds each: six minutes.
    const texts = Array.from({ length: 120 }, (_, index) => `第${index + 1}句，她数着槌声往下背。`)
    await project.saveChapterText(chapterId, texts.join('\n'))
    script = {
      schema: 1,
      chapterId,
      textHash: hashText(proseOnly(await project.chapterText(chapterId))),
      updatedAt: new Date().toISOString(),
      lines: texts.map((text, index) => line(`l${index}`, text, { duration: 3 })),
      cues: [{ at: 'l0', ambience: 'none' }],
    }
    await project.saveAudioScript(script)
  })
  afterEach(async () => { await bed.cleanup() })

  const build = async (params: { density?: 'auto' | 'sparse' | 'balanced' | 'dense'; maxPanels?: number } = {}): Promise<ComicBoard> =>
    await buildStoryboard(bed.core, bed.runtime, { chapter: chapterId, force: true, ...params }, { origin: 'user' })

  /** Every line belongs to a panel, in order, and neighbouring panels meet exactly. */
  const expectTiled = (board: ComicBoard): void => {
    expect(span(board, script, 0)[0]).toBe(0)
    expect(span(board, script, board.panels.length - 1)[1]).toBe(script.lines.length)
    for (let index = 1; index < board.panels.length; index++) expect(span(board, script, index)[0]).toBeCloseTo(span(board, script, index - 1)[1], 3)
  }

  it('asks for more or fewer panels as the density says, and covers every line', async () => {
    const asked: string[] = []
    bed.llm.responder = (request) => {
      asked.push(request.prompt)
      return director(4)(request)
    }
    const balanced = await build({ density: 'balanced' })
    expect(balanced.density).toBe('balanced')
    // Three windows of the script, each asked for its share.
    expect(asked).toHaveLength(3)
    expect(asked[0]).toMatch(/大约 \d+ 个画面/)
    expectTiled(balanced)
    expect(balanced.panels).toHaveLength(30)

    asked.length = 0
    bed.llm.responder = (request) => {
      asked.push(request.prompt)
      return director(2)(request)
    }
    const dense = await build({ density: 'dense' })
    expect(dense.panels.length).toBeGreaterThan(balanced.panels.length)
    expectTiled(dense)
    const wantedDense = Number(/大约 (\d+) 个画面/.exec(asked[0]!)![1])
    asked.length = 0
    await build({ density: 'sparse' })
    expect(Number(/大约 (\d+) 个画面/.exec(asked[0]!)![1])).toBeLessThan(wantedDense)
    // Left to the director, the request gives bounds instead of a number.
    asked.length = 0
    const auto = await build({ density: 'auto' })
    expect(asked[0]).toContain('画面数量由你决定')
    expect(auto.density).toBe('auto')
  })

  it('holds the ceiling whatever the director does', async () => {
    bed.llm.responder = director(1)
    const board = await build({ density: 'dense', maxPanels: 10 })
    expect(board.panels).toHaveLength(10)
    expect(board.maxPanels).toBe(10)
    expect(board.note).toContain('10')
    expectTiled(board)
    // The book's own setting is used when the call names none.
    await bed.runtime.project.updateManifest({ storyboard: { density: 'sparse', maxPanels: 6 } })
    const fromBook = await buildStoryboard(bed.core, bed.runtime, { chapter: chapterId, force: true }, { origin: 'user' })
    expect(fromBook.density).toBe('sparse')
    expect(fromBook.panels.length).toBeLessThanOrEqual(6)
  })

  it('asks a director that stops early for the rest, and one that is stingy for more', async () => {
    let calls = 0
    // Each request gets ten units boarded and no more: the passage has to be asked for piece by piece.
    bed.llm.responder = (request) => {
      calls += 1
      return director(5, 10)(request)
    }
    const board = await build({ density: 'balanced' })
    expectTiled(board)
    expect(calls).toBeGreaterThan(3)
    expect(board.panels.length).toBeGreaterThanOrEqual(12)
    // The request for the rest says what the last picture showed.
    const requests = bed.llm.requests.map(request => request.prompt)
    expect(requests.some(prompt => prompt.includes('上一个画面'))).toBe(true)

    // Two panels for a whole window is not a storyboard: the director is told so once.
    bed.llm.requests.length = 0
    let stingy = 0
    bed.llm.responder = (request) => {
      if (request.prompt.includes('could not be used')) return director(4)(request)
      stingy += 1
      const units = unitsIn(request)
      return JSON.stringify({ panels: [{ from: 0, to: 0, description: 'a', prompt: 'a' }, { from: 1, to: units - 1, description: 'b', prompt: 'b' }] })
    }
    const second = await build({ density: 'balanced' })
    expect(stingy).toBe(3)
    expect(bed.llm.requests.filter(request => request.prompt.includes('only 2 panel(s)'))).toHaveLength(3)
    expect(second.panels).toHaveLength(30)
  })

  it('lets a panel begin and end inside a long line', async () => {
    const { project } = bed.runtime
    const long = '拍卖厅比她预想的窄，但高。三排买主席，木板是打捞上来的船板，一条一条拼起来，缝里还嵌着盐。第一排坐着一个金发女人，白甲没有卸，肩上搭着一条灰披风。她两只手没戴手套，交叠着搁在膝盖上，指尖有冻伤旧疤。'
    const one: AudioScript = { ...script, lines: [line('l0', '门开了。她走出去。', { duration: 2 }), line('l1', long, { duration: 24 })] }
    await project.saveChapterText(chapterId, one.lines.map(entry => entry.text).join('\n'))
    one.textHash = hashText(proseOnly(await project.chapterText(chapterId)))
    await project.saveAudioScript(one)
    bed.llm.responder = director(1)
    const board = await buildStoryboard(bed.core, bed.runtime, { chapter: chapterId, force: true, density: 'dense' }, { origin: 'user' })
    expect(board.panels.length).toBeGreaterThanOrEqual(4)
    const inside = board.panels.filter(panel => panel.lines.length === 1 && panel.lines[0] === 'l1')
    expect(inside.length).toBeGreaterThanOrEqual(3)
    expect(inside[0]!.begin).toBeUndefined()
    expect(inside[0]!.end).toBeGreaterThan(0)
    expect(inside[0]!.end).toBeLessThan(1)
    expect(inside[1]!.begin).toBeCloseTo(inside[0]!.end!, 3)
    expect(inside.at(-1)!.end).toBeUndefined()
  })
})

describe('drawing the panels', () => {
  const images = new FakeImages()
  let bed: TestBed
  beforeEach(async () => {
    images.calls.length = 0
    bed = await createTestBed({ settings: { image: { provider: 'codex' } }, bridges: images.bridges })
  })
  afterEach(async () => { await bed.cleanup() })

  it('sends along the art of who is in a panel, of where it is — and of a thing it shows', async () => {
    const { project } = bed.runtime
    const sheet = await project.writeAsset('images/sheet-a.png', new Uint8Array([1]))
    const sheetTwo = await project.writeAsset('images/sheet-b.png', new Uint8Array([2]))
    const sheetThree = await project.writeAsset('images/sheet-c.png', new Uint8Array([3]))
    const placeArt = await project.writeAsset('images/place.png', new Uint8Array([4]))
    const thingArt = await project.writeAsset('images/thing.png', new Uint8Array([5]))
    const one = await project.saveCharacter({ name: '沈璃', visual: { prompt: '青衣', sheet } })
    const two = await project.saveCharacter({ name: '顾七', visual: { prompt: '黑衣', sheet: sheetTwo } })
    const three = await project.saveCharacter({ name: '摆渡人', visual: { prompt: '蓑衣', sheet: sheetThree } })
    await project.saveWorld({ name: '渡口', category: 'location', visualImage: placeArt })
    await project.saveWorld({ name: '断水剑', category: 'item', aliases: ['旧剑'], visualImage: thingArt })
    await project.saveWorld({ name: '没画过的信', category: 'item' })
    const chapter = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(chapter.id, '她把剑放回匣中。')
    // A script and a storyboard of the text as it is: nothing is asked of a model again.
    const textHash = hashText(proseOnly(await project.chapterText(chapter.id)))
    await project.saveAudioScript({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), lines: [line('l1', '她把剑放回匣中。')], cues: [] } as never)
    const panel = (id: string, extra: Record<string, unknown>) => ({ id, lines: ['l1'], description: '', prompt: '', camera: 'still', ...extra })
    await project.saveComicBoard({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), style: '', panels: [
      panel('p1', { description: '她握着断水剑站在渡口', prompt: 'a woman holding a sword', characters: [one.id], location: '渡口' }),
      panel('p2', { description: '三个人在渡口对峙，旧剑横在中间', prompt: 'three people', characters: [one.id, two.id, three.id], location: '渡口' }),
      panel('p3', { description: '匣中的旧剑', prompt: 'a sword in a box' }),
      panel('p4', { description: '桌上一封没画过的信', prompt: 'a letter', characters: [one.id] }),
    ] } as never)
    const done = await renderPanels(bed.core, bed.runtime, { chapter: chapter.id, concurrency: 1 }, { origin: 'user' })
    expect(done).toMatchObject({ rendered: 4, failed: 0 })
    const labels = images.calls.map(call => call.references.map(reference => reference.label ?? ''))
    // One person, the place, and the thing she holds: there is a seat for each.
    expect(labels[0]).toHaveLength(3)
    expect(labels[0]!.join('|')).toMatch(/场所「渡口」.*物品「断水剑」/)
    // Three people and a place: faces first, the place keeps its seat, and the thing — named by its other name — finds none left.
    expect(labels[1]).toHaveLength(3)
    expect(labels[1]!.at(-1)).toBe('场所「渡口」')
    expect(labels[1]!.join('|')).not.toContain('物品')
    // Nobody and nowhere: the thing alone.
    expect(labels[2]).toEqual(['物品「断水剑」'])
    // A thing that was never drawn has nothing to send.
    expect(labels[3]).toHaveLength(1)
    expect(labels[3]!.join('|')).not.toContain('物品')
    // Everyone had a sheet: none was drawn, and nothing is said of sheets.
    expect(done.sheets).toBeUndefined()
  })

  it('draws the design sheet of whoever comes back in the book before the first panel that shows them — once, whatever the number of panels', async () => {
    const { project } = bed.runtime
    const lead = await project.saveCharacter({ name: '沈璃', role: 'protagonist', appearance: '黑发，青衣', visual: { prompt: '青衣的年轻女子' } })
    // Seen in this one chapter only, with a small part: no sheet is drawn for them.
    const passer = await project.saveCharacter({ name: '摆渡人', role: 'cameo', appearance: '蓑衣', visual: { prompt: '披蓑衣的老人' } })
    const chapter = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(chapter.id, '她把剑放回匣中。')
    const textHash = hashText(proseOnly(await project.chapterText(chapter.id)))
    await project.saveAudioScript({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), lines: [line('l1', '她把剑放回匣中。')], cues: [] } as never)
    const panel = (id: string, extra: Record<string, unknown>) => ({ id, lines: ['l1'], description: '', prompt: '', camera: 'still', ...extra })
    await project.saveComicBoard({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), style: '', panels: [
      panel('p1', { description: '她站在渡口', prompt: 'a woman at a ferry', characters: [lead.id] }),
      panel('p2', { description: '她和摆渡人说话', prompt: 'a woman and a ferryman', characters: [lead.id, passer.id] }),
      panel('p3', { description: '她上了船', prompt: 'a woman on a boat', characters: [lead.id] }),
    ] } as never)
    const done = await renderPanels(bed.core, bed.runtime, { chapter: chapter.id }, { origin: 'user' })
    expect(done).toMatchObject({ rendered: 3, failed: 0, sheets: ['沈璃'] })
    // The sheet first, then the three panels — each held against it.
    expect(images.calls).toHaveLength(4)
    expect(images.calls[0]!.prompt).toContain('三视图')
    const sheet = (await project.findCharacter(lead.id))!.visual!.sheet!
    expect(sheet).toBeDefined()
    for (const call of images.calls.slice(1)) expect(call.references.map(reference => reference.label)).toEqual(['沈璃'])
    expect((await project.findCharacter(passer.id))!.visual?.sheet).toBeUndefined()
  })

  it('can be asked first whose sheets the panels would draw — and told "not this time"', async () => {
    const { project } = bed.runtime
    const lead = await project.saveCharacter({ name: '沈璃', role: 'protagonist', appearance: '黑发，青衣', visual: { prompt: '青衣的年轻女子' } })
    const chapter = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(chapter.id, '她把剑放回匣中。')
    // No storyboard yet: who is in the panels cannot be told.
    expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'panels', chapter: chapter.id }])).toEqual({ people: [], unknown: 1 })
    const textHash = hashText(proseOnly(await project.chapterText(chapter.id)))
    await project.saveAudioScript({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), lines: [line('l1', '她把剑放回匣中。')], cues: [] } as never)
    const panel = (id: string, extra: Record<string, unknown>) => ({ id, lines: ['l1'], description: '', prompt: '', camera: 'still', ...extra })
    await project.saveComicBoard({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), style: '', panels: [
      panel('p1', { description: '她站在渡口', prompt: 'a woman at a ferry', characters: [lead.id] }),
      panel('p2', { description: '空的渡口', prompt: 'an empty ferry' }),
    ] } as never)
    expect(await sheetsAhead(bed.core, bed.runtime, [{ kind: 'panels', chapter: chapter.id }])).toEqual({ people: [{ id: lead.id, name: '沈璃' }], unknown: 0 })
    // Only the panel nobody is in: nobody's sheet.
    expect((await sheetsAhead(bed.core, bed.runtime, [{ kind: 'panels', chapter: chapter.id, panels: ['p2'] }])).people).toEqual([])
    // Not this time: the panels are drawn from what there is.
    const done = await renderPanels(bed.core, bed.runtime, { chapter: chapter.id, sheetFirst: false }, { origin: 'user' })
    expect(done).toMatchObject({ rendered: 2, failed: 0 })
    expect(done.sheets).toBeUndefined()
    expect(images.calls).toHaveLength(2)
    expect((await project.findCharacter(lead.id))!.visual?.sheet).toBeUndefined()
    // Everything is drawn now: nothing is left to ask about.
    expect((await sheetsAhead(bed.core, bed.runtime, [{ kind: 'panels', chapter: chapter.id }])).people).toEqual([])
  })

  it('tells the director who wears what, what the chapter\'s things are and where it is set — and draws each panel with the bible\'s looks after the director\'s words', async () => {
    const { project } = bed.runtime
    const sheet = await project.writeAsset('images/sheet-a.png', new Uint8Array([1]))
    const mourning = await project.writeAsset('images/sheet-a-mourning.png', new Uint8Array([2]))
    const placeArt = await project.writeAsset('images/place.png', new Uint8Array([4]))
    const lead = await project.saveCharacter({ name: '沈璃', role: 'protagonist', tagline: '替人写信的女校书', visual: { prompt: 'slender woman, low bun, grey qipao', sheet, negative: '辫子', looks: [{ id: 'm', name: '丧服', when: '守灵那几天', prompt: '素白麻衣，腰系草绳', sheet: mourning }] } })
    await project.saveWorld({ name: '渡口', category: 'location', importance: 2, summary: '城南的旧渡口', visualPrompt: '青石阶伸进水里，一根系船的木桩，对岸是芦苇', visualImage: placeArt })
    await project.saveWorld({ name: '情债簿', category: 'item', importance: 2, summary: '记着谁欠谁一封信的账', visualPrompt: '蓝布封皮的线装薄册，边角磨白，封面没有字' })
    await project.saveWorld({ name: '寄死笔', category: 'rule', importance: 2, summary: '代笔人替死者写完最后一封信的规矩，写完那支笔要折断' })
    await project.saveWorld({ name: '无关的山', category: 'location', importance: 1, summary: '这一章没有写到' })
    const chapter = await project.addChapter({ title: '渡口', location: '渡口', time: '头七的清晨', synopsis: '沈璃穿着丧服到渡口，把情债簿交给摆渡人。' })
    await project.saveChapterText(chapter.id, '沈璃把情债簿放在船板上。她说：寄死笔已经折了。')
    const textHash = hashText(proseOnly(await project.chapterText(chapter.id)))
    await project.saveAudioScript({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), lines: [line('l1', '沈璃把情债簿放在船板上。'), line('l2', '寄死笔已经折了。', { speaker: lead.id, speakerName: '沈璃', kind: 'dialogue' })], cues: [] } as never)
    const asked: string[] = []
    bed.llm.responder = (request) => {
      asked.push(request.prompt)
      return JSON.stringify({ panels: [
        { from: 0, to: 0, description: '她把簿子放在船板上', prompt: '中景，沈璃蹲在船头，把情债簿平放在湿船板上，晨雾，冷光', camera: 'still', characters: ['沈璃'], wearing: { 沈璃: '丧服' }, location: '渡口', things: ['情债簿', '不在设定里的东西'] },
        { from: 1, to: 1, description: '她抬头说话', prompt: '特写，沈璃抬眼，嘴唇微张', camera: 'zoom-in', characters: ['沈璃'], wearing: { 沈璃: '没有这一身' }, location: '渡口', things: [] },
      ] })
    }
    const board = await buildStoryboard(bed.core, bed.runtime, { chapter: chapter.id }, { origin: 'user' })
    // The director is told the chapter, who she is and what else she has to wear, the place, and what the chapter's things are — a rule of this world among them.
    expect(asked[0]).toContain('## 这一章')
    expect(asked[0]).toContain('地点：渡口')
    expect(asked[0]).toContain('时间：头七的清晨')
    expect(asked[0]).toContain('沈璃穿着丧服到渡口')
    expect(asked[0]).toContain('沈璃（替人写信的女校书）: slender woman, low bun, grey qipao')
    expect(asked[0]).toMatch(/造型：「丧服」（守灵那几天） 素白麻衣/)
    expect(asked[0]).toContain('渡口: 青石阶伸进水里')
    expect(asked[0]).toContain('## 物件与名词')
    expect(asked[0]).toMatch(/情债簿（item）: 记着谁欠谁一封信的账；看上去：蓝布封皮/)
    expect(asked[0]).toContain('寄死笔（rule）: 代笔人替死者写完最后一封信的规矩')
    expect(asked[0]).not.toContain('无关的山')
    // What a panel wears and shows is kept with it: a look she has, a thing the bible has — and nothing made up.
    expect(board.panels[0]).toMatchObject({ characters: [lead.id], looks: { [lead.id]: '丧服' }, things: ['情债簿'], location: '渡口' })
    expect(board.panels[1]!.looks).toBeUndefined()
    expect(board.panels[1]!.things).toBeUndefined()

    // Drawn: the director's words, then how she looks in what she wears there, how the place looks, how the thing looks — from the bible, in full.
    const done = await renderPanels(bed.core, bed.runtime, { chapter: chapter.id, concurrency: 1 }, { origin: 'user' })
    expect(done).toMatchObject({ rendered: 2, failed: 0 })
    const first = images.calls[0]!.prompt
    // The brief every picture is laid out as: what it is for, then the director's words as the picture…
    expect(first.startsWith('用途：有声漫的一格画面（分镜）\n画面：中景，沈璃蹲在船头')).toBe(true)
    // …then her, pointed to in the sheet of what she wears there — it goes along, and her look is not written out beside it —
    expect(first).toContain('人物「沈璃（丧服）」：见图1\n')
    expect(first).toContain('地点「渡口」：青石阶伸进水里，一根系船的木桩，对岸是芦苇')
    expect(first).toContain('物件「情债簿」：蓝布封皮的线装薄册，边角磨白，封面没有字')
    expect(first).toContain('不要出现：辫子')
    // Held against the sheet of the look worn, and the place's art.
    expect(images.calls[0]!.references.map(reference => reference.label)).toEqual(['沈璃（丧服）', '场所「渡口」'])
    // In her usual look where the storyboard names none.
    expect(images.calls[1]!.prompt).toContain('人物「沈璃」：见图1\n')
    expect(images.calls[1]!.prompt).not.toContain('素白麻衣')
    expect(images.calls[1]!.references.map(reference => reference.label)).toEqual(['沈璃', '场所「渡口」'])
    // A panel is a picture of the book: on record, part by part, like any other.
    const drawn = (await project.comicBoard(chapter.id))!.panels
    const records = (await project.illustrations()).filter(item => item.kind === 'panel')
    expect(records.map(item => item.path)).toEqual(drawn.map(panel => panel.image))
    expect(records[0]).toMatchObject({ kind: 'panel', target: chapter.id })
    expect(records[0]!.parts!.pieces!.map(piece => piece.of)).toEqual(['use', 'composed', 'look', 'place', 'thing'])
    expect(records[0]!.parts!.references).toEqual([{ path: mourning, label: '沈璃（丧服）', sheet: true }, { path: placeArt, label: '场所「渡口」' }])
  })

  it('keeps a panel\'s picture among the book\'s pictures — one drawn before panels were on record too — and lets it be drawn again, changed and taken away like any other', async () => {
    const { project } = bed.runtime
    const { redrawPicture } = await import('../src/core/pipelines/illustrate')
    const sheet = await project.writeAsset('images/sheet-a.png', new Uint8Array([1]))
    const old = await project.writeAsset('images/panel-old.png', new Uint8Array([9]))
    const lead = await project.saveCharacter({ name: '沈璃', role: 'protagonist', visual: { prompt: 'slender woman, low bun', sheet } })
    const chapter = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(chapter.id, '她把剑放回匣中。')
    const textHash = hashText(proseOnly(await project.chapterText(chapter.id)))
    await project.saveAudioScript({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), lines: [line('l1', '她把剑放回匣中。')], cues: [] } as never)
    await project.saveComicBoard({ schema: 1, chapterId: chapter.id, textHash, updatedAt: '2026-10-01T00:00:00.000Z', style: '', panels: [
      { id: 'p1', lines: ['l1'], description: '她合上剑匣', prompt: '近景，她合上剑匣', camera: 'still', characters: [lead.id], image: old },
      { id: 'p2', lines: ['l1'], description: '空镜', prompt: '空荡的渡口', camera: 'still' },
    ] } as never)
    // Not on record — it was drawn when panels were not — and listed all the same, with what is known of it.
    expect(await project.illustrations()).toEqual([])
    expect(await project.pictures()).toEqual([{ id: `panel:${chapter.id}:p1`, path: old, prompt: '近景，她合上剑匣', kind: 'panel', target: chapter.id, createdAt: '2026-10-01T00:00:00.000Z' }])
    expect(await project.panelOf(old)).toMatchObject({ index: 0, panel: { id: 'p1' } })
    // Its words rewritten: drawn from them, held against what the storyboard says is in the panel — her sheet — and
    // the new picture is the panel's; the old one stays among the pictures.
    const again = await redrawPicture(bed.core, bed.runtime, { picture: `panel:${chapter.id}:p1`, subject: '近景，她合上剑匣，手指停在铜扣上' }, { origin: 'user' })
    expect(images.calls.at(-1)!.prompt).toContain('手指停在铜扣上')
    expect(images.calls.at(-1)!.references.map(reference => reference.label)).toEqual(['沈璃'])
    expect(again).toMatchObject({ kind: 'panel', target: chapter.id, replaced: ['渡口'] })
    expect((await project.comicBoard(chapter.id))!.panels[0]).toMatchObject({ image: again.path, prompt: '近景，她合上剑匣' })
    expect((await project.pictures()).map(item => item.path)).toEqual([again.path])
    // One thing changed: the picture and the change alone, as for any picture.
    const changed = await redrawPicture(bed.core, bed.runtime, { picture: again.id, change: '铜扣改成银的' }, { origin: 'user' })
    expect(images.calls.at(-1)!.prompt.startsWith('铜扣改成银的')).toBe(true)
    expect((await project.comicBoard(chapter.id))!.panels[0]!.image).toBe(changed.path)
    // Taken away: the panel is a panel without a picture again; its neighbour is as it was.
    expect(await project.removePicture({ path: changed.path })).toEqual(['渡口'])
    const board = (await project.comicBoard(chapter.id))!
    expect(board.panels[0]!.image).toBeUndefined()
    expect(board.panels[0]).toMatchObject({ id: 'p1', prompt: '近景，她合上剑匣' })
    expect(board.panels[1]).toMatchObject({ id: 'p2', prompt: '空荡的渡口' })
  })

  it('draws panels of one chapter in several drawings side by side, each keeping what it drew', async () => {
    const { project } = bed.runtime
    const chapter = await project.addChapter({ title: '渡口' })
    await project.saveChapterText(chapter.id, '她把剑放回匣中。')
    const textHash = hashText(proseOnly(await project.chapterText(chapter.id)))
    await project.saveAudioScript({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), lines: [line('l1', '她把剑放回匣中。')], cues: [] } as never)
    const panel = (id: string) => ({ id, lines: ['l1'], description: `画面 ${id}`, prompt: `panel ${id}`, camera: 'still', image: `assets/images/old-${id}.png` })
    await project.saveComicBoard({ schema: 1, chapterId: chapter.id, textHash, updatedAt: new Date().toISOString(), style: '', panels: ['p1', 'p2', 'p3', 'p4'].map(panel) } as never)
    // Three drawings asked for one after another while none has finished — a panel drawn again, another, two more —
    // as three clicks on a page would. Each says which panels it is on.
    const said: Record<string, unknown>[][] = [[], [], []]
    const jobOf = (at: number) => ({ origin: 'user' as const, job: { ...quietJob(), result: (value: Record<string, unknown>) => { said[at]!.push(value) } } })
    const results = await Promise.all([
      renderPanels(bed.core, bed.runtime, { chapter: chapter.id, panels: ['p1'], force: true }, jobOf(0)),
      renderPanels(bed.core, bed.runtime, { chapter: chapter.id, panels: ['p2'], force: true }, jobOf(1)),
      renderPanels(bed.core, bed.runtime, { chapter: chapter.id, panels: ['p3', 'p4'], force: true }, jobOf(2)),
    ])
    expect(results.map(result => result.rendered)).toEqual([1, 1, 2])
    expect(said[0]![0]).toEqual({ chapterId: chapter.id, drawing: ['p1'] })
    expect(said[2]![0]).toEqual({ chapterId: chapter.id, drawing: ['p3', 'p4'] })
    // Every one of the four is the new picture: no drawing wrote its own copy of the storyboard over what another had kept.
    const board = (await project.comicBoard(chapter.id))!
    for (const drawn of board.panels) expect(drawn.image).toMatch(/assets\/images\/panel-/)
    expect(new Set(board.panels.map(drawn => drawn.image)).size).toBe(4)
    // All of them, where no panels are named: said so, for the page's "draw all".
    const all: Record<string, unknown>[] = []
    await renderPanels(bed.core, bed.runtime, { chapter: chapter.id, force: true }, { origin: 'user', job: { ...quietJob(), result: (value) => { all.push(value) } } })
    expect(all[0]).toEqual({ chapterId: chapter.id, drawing: ['p1', 'p2', 'p3', 'p4'], all: true })
    // A panel that was taken out of the storyboard while it was being drawn is let be.
    expect(await project.patchComicPanels(chapter.id, new Map([['gone', { image: 'x.png' }]]))).toMatchObject({ panels: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }] })
    expect(await project.patchComicPanels('ch999', new Map())).toBeUndefined()
  })
})


// SPDX-License-Identifier: LGPL-3.0-or-later
/** Motion comic: how finely a chapter is cut into panels, and that the cut always covers the whole chapter. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LlmRequest } from '../src/core/llm'
import { beatsOf, buildStoryboard, PANEL_SECONDS, planPanels, renderPanels } from '../src/core/pipelines/comic'
import type { AudioLine, AudioScript, ComicBoard } from '../src/shared/types'
import { hashText, proseOnly } from '../src/shared/text'
import { createTestBed, FakeImages, type TestBed } from './support/harness'

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
})


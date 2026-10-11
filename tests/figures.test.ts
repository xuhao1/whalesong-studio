// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The pictures in a chapter's text stay in it when the text is written anew — by the writer revising a passage or a
 * chapter, drafting the chapter over, going on with it, or by the showrunner's own hands: the one who rewrites is told
 * what such a line is, and what comes back is held against the text it replaces.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editChapter } from '../src/core/pipelines/edit'
import { acceptProposal, reviseChapter, reviseSpan } from '../src/core/pipelines/revise'
import { writeChapter } from '../src/core/pipelines/write'
import { createTestBed, type TestBed } from './support/harness'

const LAMP = '![灯下的信](assets/images/lamp.png)'
const RAIN = '![雨停了](assets/images/rain.png)'
const ONE = '沈蘅没有应。门缝里塞进一张湿剪报，纸角碰到柜台，发出轻响。'
const TWO = '阿棠盯着她，半天才说出一句话来：断肠斋的灯今晚没有点。'
const THREE = '她把那支旧笔放回抽屉，抽屉合上的时候，外头的雨正好停了。'
const TEXT = `${ONE}\n\n${LAMP}\n\n${TWO}\n\n${THREE}\n\n${RAIN}`
/** The chapter as a model hands it back that was asked to change the words: reworded, and the pictures gone. */
const REWORDED = ['沈蘅没有应声。门缝里塞进来一张湿透的剪报，纸角碰到柜台，轻轻一响。', '阿棠盯着她看了半天，才说：断肠斋的灯，今晚没有点。', '她把旧笔放回抽屉。抽屉合上时，外头的雨正好停了。']

const task = { origin: 'user' as const }

describe('the pictures in a text that is written anew', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ language: 'zh', title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  it('a chapter rewritten keeps its pictures where they stood: the writer is told what they are, and one it leaves out goes back', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '旧账里的名字' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => REWORDED.join('\n\n')
    const result = await reviseChapter(bed.core, bed.runtime, { chapter: plan.id, instruction: '更冷一点' }, task)
    const request = bed.llm.requests.at(-1)!
    // Told: a line of that shape is a picture, handed back as it stands. And shown: the chapter travels with them.
    expect(request.system).toContain('是插在那里的一张图，不是正文')
    expect(request.system).toContain('本章现有正文没有的图不要添')
    expect(request.prompt).toContain(LAMP)
    // Left out all the same: each is back after the line that the one it followed became.
    expect(result.after).toBe(`${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}\n\n${REWORDED[2]}\n\n${RAIN}`)
    expect(result.figures).toEqual({ back: 2, made: 0 })
    const proposal = (await project.proposals()).find(item => item.id === result.proposalId)!
    expect(proposal.figures).toEqual({ back: 2, made: 0 })
    await acceptProposal(bed.core, bed.runtime, proposal.id, task)
    expect(await project.chapterText(plan.id)).toContain(`${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}`)

    // Handed back as they stood: nothing is touched, and nothing is said.
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => `${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}\n\n${REWORDED[2]}\n\n${RAIN}`
    const kept = await reviseChapter(bed.core, bed.runtime, { chapter: plan.id, instruction: '更冷一点' }, task)
    expect(kept.figures).toBeUndefined()
    expect(kept.after).toBe(`${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}\n\n${REWORDED[2]}\n\n${RAIN}`)

    // A path spoilt, a caption reworded, a picture of the writer's own: the text's lines come back as the text has them.
    bed.llm.responder = () => `${REWORDED[0]}\n\n![一盏灯下的信纸](assets/pictures/lamp.png)\n\n${REWORDED[1]}\n\n![窗外](assets/images/window.png)\n\n${REWORDED[2]}\n\n${RAIN}`
    const mended = await reviseChapter(bed.core, bed.runtime, { chapter: plan.id, instruction: '更冷一点' }, task)
    expect(mended.after).toBe(`${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}\n\n${REWORDED[2]}\n\n${RAIN}`)
    expect(mended.figures).toEqual({ back: 0, made: 1 })
  })

  it('a passage rewritten keeps the picture that stands in it', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '旧账里的名字' })
    await project.saveChapterText(plan.id, TEXT)
    bed.llm.responder = () => `${REWORDED[0]}\n\n${REWORDED[1]}`
    const start = 0
    const end = TEXT.indexOf(TWO) + TWO.length
    const result = await reviseSpan(bed.core, bed.runtime, { chapter: plan.id, start, end, instruction: '更冷一点' }, task)
    expect(bed.llm.requests.at(-1)!.system).toContain('要改的这一段里单独成行的 ![说明](路径) 是插在那里的一张图')
    expect(result.after).toBe(`${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}`)
    expect(result.figures).toEqual({ back: 1, made: 0 })
    // A passage that has none gains none.
    bed.llm.responder = () => `她把旧笔放回抽屉。\n\n![抽屉](assets/images/drawer.png)`
    const plain = await reviseSpan(bed.core, bed.runtime, { chapter: plan.id, quote: THREE, instruction: '短一点' }, task)
    expect(plain.after).toBe('她把旧笔放回抽屉。')
    expect(plain.figures).toEqual({ back: 0, made: 1 })
  })

  it('a chapter drafted over again has the pictures it had; a writer shown no picture lines writes none, and one it makes up comes out', async () => {
    const { project } = bed.runtime
    const first = await project.addChapter({ title: '代笔人的规矩', synopsis: '周衡来写信。' })
    const second = await project.addChapter({ title: '旧账里的名字', synopsis: '夜里有人敲门。' })
    await project.saveChapterText(first.id, `周衡把两枚银元放在柜台上。\n\n![柜台上的银元](assets/images/coins.png)\n\n沈蘅没有看他。`)
    await project.saveChapterText(second.id, TEXT)
    bed.llm.responder = () => '夜里的敲门声一共三下。\n\n沈蘅没有起身。\n\n![敲门](assets/images/knock.png)\n\n门缝里塞进来一张剪报。\n\n阿棠说灯没有点。\n\n她合上抽屉，雨停了。\n\n天快亮了。'
    const result = await writeChapter(bed.core, bed.runtime, { chapter: second.id }, task)
    const request = bed.llm.requests.at(-1)!
    // The story so far travels as prose: the chapter before it has a picture, and the writer is not shown its line.
    expect(`${request.stable ?? ''}${request.prompt}`).toContain('周衡把两枚银元放在柜台上。')
    expect(`${request.stable ?? ''}${request.prompt}`).not.toContain('![')
    const text = await project.chapterText(second.id)
    // Both of the chapter's own are in the new draft — nothing reads like the lines they stood by, so as far down as
    // they stood: after the first of three lines, and at the end — and the one made up is gone.
    expect(text).not.toContain('knock.png')
    expect(text.split('\n').filter(line => line.startsWith('!['))).toEqual([LAMP, RAIN])
    expect(text.indexOf(LAMP)).toBeLessThan(text.indexOf('阿棠说灯没有点。'))
    expect(text.endsWith(RAIN)).toBe(true)
    expect(result.figures).toEqual({ back: 2, made: 1 })

    // Gone on with: what is there stays as it is, and the continuation has no picture of the writer's making.
    bed.llm.responder = () => '第二天，报馆的人来了。\n\n![报馆](assets/images/press.png)\n\n他们带着一张照片。'
    const more = await writeChapter(bed.core, bed.runtime, { chapter: second.id, mode: 'continue' }, task)
    expect(await project.chapterText(second.id)).toBe(`${text}\n\n第二天，报馆的人来了。\n\n他们带着一张照片。`)
    expect(more.figures).toEqual({ back: 0, made: 1 })
  })

  it('text the showrunner puts in the place of text keeps the pictures that stood there; a picture goes out by its own line', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '旧账里的名字' })
    await project.saveChapterText(plan.id, TEXT)
    const agent = { origin: 'agent' as const }
    // The whole chapter set anew, without its pictures: they go back.
    const set = await editChapter(bed.core, bed.runtime, { chapter: plan.id, action: 'set', text: REWORDED.join('\n\n'), apply: true }, agent)
    expect(set.figures).toEqual({ back: 2, made: 0 })
    expect(await project.chapterText(plan.id)).toBe(`${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}\n\n${REWORDED[2]}\n\n${RAIN}`)
    // A passage with a picture in it replaced by words alone: the picture stays.
    const replaced = await editChapter(bed.core, bed.runtime, { chapter: plan.id, action: 'replace', find: `${REWORDED[0]}\n\n${LAMP}\n\n${REWORDED[1]}`, text: '门缝里塞进来一张剪报。阿棠说，灯没有点。', apply: true }, agent)
    expect(replaced.figures).toEqual({ back: 1, made: 0 })
    expect(await project.chapterText(plan.id)).toBe(`门缝里塞进来一张剪报。阿棠说，灯没有点。\n\n${LAMP}\n\n${REWORDED[2]}\n\n${RAIN}`)
    // Words changed where no picture stands: nothing is said of pictures.
    const word = await editChapter(bed.core, bed.runtime, { chapter: plan.id, action: 'replace', find: '剪报', text: '报纸', apply: true }, agent)
    expect(word.figures).toBeUndefined()
    // A picture of the book named in what is put in is a picture placed; a file the book has not is taken out.
    await mkdir(join(project.root, 'assets', 'images'), { recursive: true })
    await writeFile(join(project.root, 'assets', 'images', 'door.png'), 'png')
    const placed = await editChapter(bed.core, bed.runtime, { chapter: plan.id, action: 'replace', find: REWORDED[2]!, text: `${REWORDED[2]}\n\n![门](assets/images/door.png)\n\n![窗](assets/images/nowhere.png)`, apply: true }, agent)
    expect(placed.figures).toEqual({ back: 0, made: 1 })
    expect(await project.chapterText(plan.id)).toBe(`门缝里塞进来一张报纸。阿棠说，灯没有点。\n\n${LAMP}\n\n${REWORDED[2]}\n\n![门](assets/images/door.png)\n\n${RAIN}`)
    // The picture's own line, alone: that change is about the picture, and is made as asked.
    const gone = await editChapter(bed.core, bed.runtime, { chapter: plan.id, action: 'delete', find: LAMP, apply: true }, agent)
    expect(gone.picturesGone).toBe(1)
    expect(await project.chapterText(plan.id)).not.toContain('lamp.png')
    const swapped = await editChapter(bed.core, bed.runtime, { chapter: plan.id, action: 'replace', find: RAIN, text: '![门](assets/images/door.png)', apply: true }, agent)
    expect(swapped.figures).toBeUndefined()
    expect(await project.chapterText(plan.id)).not.toContain('rain.png')
    // Left for the author to settle, the proposal says what was done about the pictures too.
    await project.saveChapterText(plan.id, TEXT)
    const waiting = await editChapter(bed.core, bed.runtime, { chapter: plan.id, action: 'set', text: REWORDED.join('\n\n'), apply: false }, agent)
    expect((await project.proposals()).find(item => item.id === waiting.proposalId)!.figures).toEqual({ back: 2, made: 0 })
  })
})

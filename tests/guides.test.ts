// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures that steer the story: given to a chapter being written or to
 * chapters being planned, looked at by the model that does the work where it
 * takes pictures, and put into words for it by another where it does not.
 */
import { describe, expect, it } from 'vitest'
import { cleanGuides, guidePictures } from '../src/core/pipelines/guides'
import { applyOutlineOps } from '../src/core/pipelines/outline'
import { deriveBeats, deriveChapters } from '../src/core/pipelines/plot'
import { writeChapter } from '../src/core/pipelines/write'
import { createTestBed, PIXEL } from './support/harness'

const WRITER = { provider: 'fake', model: 'pen' }
const PLANNER = { provider: 'fake', model: 'plan' }
const LOOKER = { provider: 'fake', model: 'looker' }

describe('pictures given to steer by', () => {
  it('are paths of the book\'s own pictures, each once, with what was said of them', () => {
    expect(cleanGuides(['assets/images/a.png', { path: 'assets/guides/b.jpg', note: ' 结尾的画面 ' }, 'assets/images/a.png', '../secrets.png', 'assets/../novel.json', 'assets/notes.txt', { path: 7 }, null]))
      .toEqual([{ path: 'assets/images/a.png' }, { path: 'assets/guides/b.jpg', note: '结尾的画面' }])
    expect(cleanGuides(undefined)).toEqual([])
    expect(cleanGuides(Array.from({ length: 30 }, (_item, at) => `assets/guides/${at}.png`))).toHaveLength(12)
  })

  it('go to a writer whose model takes pictures, with the task saying what each is', async () => {
    const bed = await createTestBed({ settings: { models: { writer: WRITER } } })
    try {
      const { project } = bed.runtime
      bed.llm.sight = { pen: true }
      const card = await project.saveCharacter({ name: '黛玉', role: 'protagonist' })
      const chapter = await project.addChapter({ title: '葬花', synopsis: '她去葬花。' })
      const moment = await project.writeAsset('images/zang.png', PIXEL)
      const brought = await project.writeAsset('guides/hill.png', Uint8Array.from([...PIXEL, 0]))
      await project.addIllustration({ id: 'img-1', path: moment, prompt: '葬花', kind: 'portrait', target: card.id, createdAt: new Date().toISOString(), moment: { title: '葬花', scene: 's1', chapter: chapter.id } })
      // Kept on the chapter's plan, through the outline's own way of changing a chapter.
      await applyOutlineOps(bed.runtime, [{ op: 'update-chapter', chapter: chapter.id, guides: [moment, { path: brought, note: '山坡是这样的' }] }])
      expect((await project.findChapter(chapter.id))!.plan.guides).toEqual([{ path: moment }, { path: brought, note: '山坡是这样的' }])

      bed.llm.responder = () => '她肩上担着花锄，往山坡那头去。'
      const result = await writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false }, { origin: 'user' })
      const request = bed.llm.requests.at(-1)!
      expect(request.route.model).toBe('pen')
      // The pictures themselves, in the order the words speak of them.
      expect(request.images?.map(image => [image.mediaType, image.name, image.data.length])).toEqual([['image/png', 'zang.png', PIXEL.length], ['image/png', 'hill.png', PIXEL.length + 1]])
      expect(request.prompt).toContain('## 作者给的参考图')
      expect(request.prompt).toContain('1. 〔立绘 · 黛玉 · 葬花〕')
      expect(request.prompt).toContain('2. 作者说：山坡是这样的')
      expect(request.prompt).toContain('图按下面的次序附在这条消息里')
      expect(result.pictures).toEqual({ count: 2, by: 'self' })
      // Nobody else was asked to look.
      expect(bed.llm.requests).toHaveLength(1)

      // Pictures named for one pass take the place of the plan's for that pass; an empty list takes them off the plan.
      await writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false, guides: [{ path: brought }] }, { origin: 'user' })
      expect(bed.llm.requests.at(-1)!.images).toHaveLength(1)
      await applyOutlineOps(bed.runtime, [{ op: 'update-chapter', chapter: chapter.id, guides: [] }])
      expect((await project.findChapter(chapter.id))!.plan.guides).toBeUndefined()
      await writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false }, { origin: 'user' })
      expect(bed.llm.requests.at(-1)!.images).toBeUndefined()
      expect(bed.llm.requests.at(-1)!.prompt).not.toContain('参考图')
    } finally {
      await bed.cleanup()
    }
  })

  it('are put into words by the model set up to look, for a writer whose model takes none — once', async () => {
    const bed = await createTestBed({ settings: { models: { writer: WRITER } } })
    try {
      const { project } = bed.runtime
      bed.llm.sight = { pen: false, looker: true }
      await project.saveCharacter({ name: '黛玉', role: 'protagonist', appearance: '两弯似蹙非蹙罥烟眉' })
      const chapter = await project.addChapter({ title: '葬花', synopsis: '她去葬花。' })
      const one = await project.writeAsset('guides/one.png', PIXEL)
      const two = await project.writeAsset('guides/two.jpg', Uint8Array.from([...PIXEL, 1]))
      const guides = [{ path: one, note: '结尾停在这里' }, { path: two }]

      // Nobody to look for it: said before any work is done.
      await expect(writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false, guides }, { origin: 'user' })).rejects.toThrow(/看不了图/)
      expect(bed.llm.requests).toHaveLength(0)

      await bed.core.settings.update({ vision: LOOKER })
      bed.llm.responder = request => (request.route.model === 'looker' ? `看到了：${request.images?.[0]?.name}` : '正文。')
      const result = await writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false, guides }, { origin: 'user' })
      const looks = bed.llm.requests.filter(request => request.route.model === 'looker')
      // One picture at a time, each with what the author said of it and who the book's people are.
      expect(looks.map(request => request.images?.map(image => image.name))).toEqual([['one.png'], ['two.jpg']])
      expect(looks[0]!.prompt).toContain('作者说：结尾停在这里')
      expect(looks[0]!.prompt).toContain('黛玉')
      expect(looks[0]!.route.for).toMatchObject({ role: 'vision' })
      expect(looks[1]!.images![0]!.mediaType).toBe('image/jpeg')
      // The writer is told what was seen, and sent no picture.
      const written = bed.llm.requests.at(-1)!
      expect(written.route.model).toBe('pen')
      expect(written.images).toBeUndefined()
      expect(written.prompt).toContain('你看不到图本身')
      expect(written.prompt).toContain('1. 作者说：结尾停在这里\n   图里：看到了：one.png')
      expect(written.prompt).toContain('图里：看到了：two.jpg')
      expect(result.pictures).toEqual({ count: 2, by: 'vision', model: 'looker' })

      // The same pictures again: what was seen is remembered, and nobody looks twice.
      const before = bed.llm.requests.length
      await writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false, guides }, { origin: 'user' })
      expect(bed.llm.requests.slice(before).map(request => request.route.model)).toEqual(['pen'])

      // Two pieces of work given the same new picture at once — a comparison — have it looked at once.
      const fresh = await project.writeAsset('guides/fresh.png', Uint8Array.from([...PIXEL, 9]))
      const start = bed.llm.requests.length
      await Promise.all([1, 2].map(() => guidePictures(bed.core, bed.runtime, WRITER, [fresh], 'chapter', { origin: 'user' })))
      expect(bed.llm.requests.slice(start).filter(request => request.route.model === 'looker')).toHaveLength(1)

      // A book with a model of its own to look: that one, whatever the Studio's is.
      await project.updateManifest({ vision: { provider: 'fake', model: 'book-eyes' } })
      expect((await bed.core.visionRoute(bed.runtime))?.model).toBe('book-eyes')
      expect((await bed.core.visionRoute(undefined))?.model).toBe('looker')
      // One that says it takes no pictures itself is no model to look with.
      bed.llm.sight['book-eyes'] = false
      await expect(writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false, guides }, { origin: 'user' })).rejects.toThrow(/自己看不了图/)
      await project.updateManifest({ vision: null } as never)
      expect((await bed.core.visionRoute(bed.runtime))?.model).toBe('looker')
    } finally {
      await bed.cleanup()
    }
  })

  it('are sent to a model that does not say whether it sees — and that is said', async () => {
    const bed = await createTestBed({ settings: { models: { writer: WRITER } } })
    try {
      const chapter = await bed.runtime.project.addChapter({ title: '一' })
      const one = await bed.runtime.project.writeAsset('guides/one.png', PIXEL)
      const guided = await guidePictures(bed.core, bed.runtime, WRITER, [one], 'chapter', { origin: 'user' })
      expect(guided).toMatchObject({ by: 'self', unsure: true })
      expect(guided!.images).toHaveLength(1)
      bed.llm.responder = () => '正文。'
      expect((await writeChapter(bed.core, bed.runtime, { chapter: chapter.id, digest: false, guides: [{ path: one }] }, { origin: 'user' })).pictures).toEqual({ count: 1, by: 'self', unsure: true })
      // A picture that is no longer there is said, not passed over.
      await expect(guidePictures(bed.core, bed.runtime, WRITER, ['assets/guides/gone.png'], 'chapter', { origin: 'user' })).rejects.toThrow(/不在书里/)
      expect(await guidePictures(bed.core, bed.runtime, WRITER, [], 'chapter', { origin: 'user' })).toBeUndefined()
    } finally {
      await bed.cleanup()
    }
  })

  it('steer chapters being planned, and stay with the chapter that goes by each', async () => {
    const bed = await createTestBed({ settings: { models: { writer: WRITER, architect: PLANNER } } })
    try {
      const { project } = bed.runtime
      bed.llm.sight = { plan: true, pen: true }
      const one = await project.writeAsset('guides/one.png', PIXEL)
      const two = await project.writeAsset('guides/two.png', Uint8Array.from([...PIXEL, 2]))
      bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '码头', synopsis: '她在码头等船。', pictures: [2, 9] }, { title: '回信', synopsis: '信到了。' }], rationale: '照图来。' })
      const derived = await deriveChapters(bed.core, bed.runtime, { count: 2, guides: [{ path: one }, { path: two, note: '码头的清晨' }] }, { origin: 'user' })
      const asked = bed.llm.requests.at(-1)!
      expect(asked.route.model).toBe('plan')
      expect(asked.images).toHaveLength(2)
      // What is to be handed in says where a chapter names its pictures.
      expect(asked.prompt).toContain('每章另加一项 "pictures"')
      expect(asked.prompt.indexOf('每章另加一项')).toBeGreaterThan(asked.prompt.indexOf('只输出 JSON'))
      expect(asked.prompt).toContain('2. 作者说：码头的清晨')
      expect(derived.pictures).toEqual({ count: 2, by: 'self' })
      // The chapter that goes by a picture keeps it on its plan; a number that names no picture is dropped.
      expect(derived.chapters.map(chapter => chapter.guides)).toEqual([[{ path: two, note: '码头的清晨' }], undefined])
      const added = await project.findChapter(derived.added[0]!.id)
      expect(added!.plan.guides).toEqual([{ path: two, note: '码头的清晨' }])

      // Its beats are planned by the same picture, and whoever writes it is shown it — without anybody naming it again.
      bed.llm.responder = () => JSON.stringify({ beats: [{ summary: '她数着船。' }] })
      await deriveBeats(bed.core, bed.runtime, { chapter: added!.plan.id }, { origin: 'user' })
      expect(bed.llm.requests.at(-1)!.images?.map(image => image.name)).toEqual(['two.png'])
      bed.llm.responder = () => '清晨的码头，雾还没有散。'
      const written = await writeChapter(bed.core, bed.runtime, { chapter: added!.plan.id, digest: false }, { origin: 'user' })
      expect(bed.llm.requests.at(-1)!.images?.map(image => image.name)).toEqual(['two.png'])
      expect(written.pictures).toEqual({ count: 1, by: 'self' })

      // A preview carries them too, for the page to add with the chapter.
      bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '再等', synopsis: '又一天。', pictures: [1] }] })
      const preview = await deriveChapters(bed.core, bed.runtime, { count: 1, apply: false, guides: [{ path: one }] }, { origin: 'user' })
      expect(preview.added).toEqual([])
      expect(preview.chapters[0]!.guides).toEqual([{ path: one }])
      // One chapter asked for and no picture named by the planner: they are that chapter's — there is no other they could be for.
      bed.llm.responder = () => JSON.stringify({ chapters: [{ title: '独一章', synopsis: '只有这一章。' }] })
      expect((await deriveChapters(bed.core, bed.runtime, { count: 1, apply: false, guides: [{ path: one }, { path: two }] }, { origin: 'user' })).chapters[0]!.guides).toEqual([{ path: one }, { path: two }])
    } finally {
      await bed.cleanup()
    }
  })

  it('go with the task to a planner that works as an agent', async () => {
    const bed = await createTestBed({ settings: { models: { architect: PLANNER } } })
    try {
      bed.llm.sight = { plan: true }
      bed.roles.enabled = true
      const one = await bed.runtime.project.writeAsset('guides/one.png', PIXEL)
      bed.roles.script = async (_task, call) => { await call('submit_chapters', { result: { chapters: [{ title: '码头', synopsis: '等船。', pictures: [1] }] } }) }
      const derived = await deriveChapters(bed.core, bed.runtime, { count: 1, guides: [{ path: one }] }, { origin: 'user' })
      expect(bed.roles.tasks.at(-1)!.images?.map(image => image.name)).toEqual(['one.png'])
      expect(bed.roles.tasks.at(-1)!.prompt).toContain('作者给的参考图')
      expect(derived.chapters[0]!.guides).toEqual([{ path: one }])
    } finally {
      await bed.cleanup()
    }
  })
})

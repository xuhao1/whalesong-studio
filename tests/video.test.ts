// SPDX-License-Identifier: LGPL-3.0-or-later
/** A chapter's video: the material laid out for post-production, how a result is judged, and what can be taken away again. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav, parseWav } from '../src/core/media/wav'
import { clearAudioScript, removeAudioLine } from '../src/core/pipelines/audio'
import { clearComicBoard, removeComicPanel } from '../src/core/pipelines/comic'
import { clearReview } from '../src/core/pipelines/review'
import { chapterVideo, leftBehind, produceVideo, removeVideo, stillMarks, subtitlePieces, videoFaults, videoMaterials, videoReadiness, writeMaterials, type VideoProbe } from '../src/core/pipelines/video'
import type { AudioScript, ComicBoard } from '../src/shared/types'
import { createTestBed, PIXEL, type TestBed } from './support/harness'

/** A tone of `seconds`, as a take would be. */
function take(seconds: number, rate = 24_000): Uint8Array {
  const pcm = new Int16Array(Math.round(seconds * rate))
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / rate * 2 * Math.PI * 220) * 9000)
  return encodeWav({ pcm, sampleRate: rate })
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A chapter with a script of four lines (three voiced), a board of three panels (two drawn) and three cues. */
async function staged(bed: TestBed): Promise<string> {
  const { project } = bed.runtime
  const plan = await project.addChapter({ title: '旧账里的名字' })
  await project.saveChapterText(plan.id, '门缝里塞进一张湿剪报。\n\n“你看这个。”阿棠说。\n\n沈蘅没有接。\n\n她拿起伞，走进晨雾。')
  const audio = async (name: string, seconds: number): Promise<string> => await project.writeAsset(`audio/${plan.id}/${name}.wav`, take(seconds))
  const script: AudioScript = {
    schema: 1,
    chapterId: plan.id,
    textHash: 'h',
    updatedAt: new Date().toISOString(),
    lines: [
      { id: 'l0', kind: 'narration', text: '门缝里塞进一张湿剪报。', audio: await audio('l0', 2), duration: 2 },
      { id: 'l1', kind: 'dialogue', speakerName: '阿棠', text: '你看这个。', audio: await audio('l1', 1), duration: 1 },
      // Never voiced: held in silence for as long as it takes to read.
      { id: 'l2', kind: 'narration', text: '沈蘅没有接。' },
      { id: 'l3', kind: 'narration', text: '她拿起伞，走进晨雾。', audio: await audio('l3', 3), duration: 3 },
    ],
    cues: [
      { id: 'c0', at: 'l0', kind: 'bed', ambience: 'rain', caption: '雨声', audio: await audio('cue-c0', 4), duration: 4, intensity: 0.6 },
      { id: 'c1', at: 'l1', kind: 'effect', ambience: 'none', caption: '门响' },
      { id: 'c2', at: 'l3', kind: 'bed', ambience: 'wind', caption: '晨风' },
    ],
  }
  await project.saveAudioScript(script)
  const board: ComicBoard = {
    schema: 1,
    chapterId: plan.id,
    textHash: 'h',
    updatedAt: new Date().toISOString(),
    style: 'ink',
    panels: [
      { id: 'p0', lines: ['l0', 'l1'], description: '门缝里的剪报', prompt: 'a', camera: 'zoom-in', image: await project.writeAsset('images/p0.png', PIXEL) },
      { id: 'p1', lines: ['l2'], description: '她没有接', prompt: 'b', camera: 'still' },
      { id: 'p2', lines: ['l3'], description: '晨雾里的伞', prompt: 'c', camera: 'pan-right', image: await project.writeAsset('images/p2.png', PIXEL) },
    ],
  }
  await project.saveComicBoard(board)
  return plan.id
}

describe('material for a video', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  it('lays a chapter out on one timeline', async () => {
    const id = await staged(bed)
    const materials = await videoMaterials(bed.core, bed.runtime, id)
    // Lines follow one another with the pause the joined track leaves: 0.45 s after narration, 0.3 s after speech.
    expect(materials.lines.map(line => [line.id, line.start, line.end])).toEqual([
      ['l0', 0, 2],
      ['l1', 2.45, 3.45],
      ['l2', 3.75, 4.95],
      ['l3', 5.4, 8.4],
    ])
    expect(materials.duration).toBe(8.4)
    expect(materials.lines[2]!.audio).toBeUndefined()
    expect(materials.lines[1]).toMatchObject({ speaker: '阿棠', kind: 'dialogue' })
    expect(materials.lines[0]!.audio).toBe(bed.runtime.project.path('assets', 'audio', id, 'l0.wav'))
    // A picture stays until the next one comes, from the first second to the last.
    expect(materials.panels.map(panel => [panel.id, panel.start, panel.end, panel.image !== undefined])).toEqual([
      ['p0', 0, 3.75, true],
      ['p1', 3.75, 5.4, false],
      ['p2', 5.4, 8.4, true],
    ])
    // A bed runs to the next bed; an effect is a moment.
    expect(materials.cues.map(cue => [cue.kind, cue.start, cue.end, cue.audio !== undefined])).toEqual([
      ['bed', 0, 5.4, true],
      ['effect', 2.45, undefined, false],
      ['bed', 5.4, 8.4, false],
    ])
    expect(materials.counts).toEqual({ spoken: 3, silent: 1, drawn: 2, undrawn: 1, clips: 1 })
    expect(materials.workdir).toBe(bed.runtime.project.path('assets', 'video', 'work', id))
  })

  it('writes the material as a shell takes it: one voice track, subtitles, tables, a base script', async () => {
    const id = await staged(bed)
    const { manifest, materials } = await writeMaterials(bed.runtime, await videoMaterials(bed.core, bed.runtime, id))
    expect(JSON.parse(readFileSync(manifest, 'utf8')).files).toEqual(materials.files)
    // The telling as one track: as long as the timeline, with each take where the timeline puts it.
    const voice = parseWav(readFileSync(materials.files!.voice))
    expect(voice.pcm.length / voice.sampleRate).toBeCloseTo(8.9, 1)
    const loud = (from: number, to: number): number => Math.max(...voice.pcm.subarray(Math.round(from * voice.sampleRate), Math.round(to * voice.sampleRate)).map(Math.abs))
    expect(loud(0.2, 1.8)).toBeGreaterThan(8000)
    expect(loud(2.6, 3.3)).toBeGreaterThan(8000)
    // The unvoiced line is silence.
    expect(loud(3.8, 4.9)).toBe(0)
    expect(loud(5.6, 8.2)).toBeGreaterThan(8000)
    const srt = readFileSync(materials.files!.subtitles, 'utf8')
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,000\n门缝里塞进一张湿剪报。\n')
    expect(srt).toContain('4\n00:00:05,400 --> 00:00:08,400\n她拿起伞，走进晨雾。\n')
    const panels = readFileSync(materials.files!.panels, 'utf8').trimEnd().split('\n').map(row => row.split('\t'))
    expect(panels.map(row => [row[0], row[1], row[2], row[3], row[4]])).toEqual([['1', '0', '3.75', '3.75', 'zoom-in'], ['2', '3.75', '5.4', '1.65', 'still'], ['3', '5.4', '8.4', '3', 'pan-right']])
    expect(panels[1]![5]).toBe('')
    expect(panels[0]![5]).toBe(bed.runtime.project.path('assets', 'images', 'p0.png'))
    const cues = readFileSync(materials.files!.cues, 'utf8').trimEnd().split('\n').map(row => row.split('\t'))
    expect(cues[0]!.slice(0, 5)).toEqual(['bed', '0', '5.4', '4', '0.6'])
    // The skill's base script is at hand where it will be run.
    expect(readFileSync(join(materials.workdir, 'cut-base.sh'), 'utf8')).toContain('-nostdin')
  })

  it('cuts a long line into pieces a screen holds, each with its share of the time', () => {
    const pieces = subtitlePieces('拍卖厅比她预想的窄，但高。三排买主席，木板是打捞上来的船板，一条一条拼起来，缝里还嵌着盐。第一排坐着一个金发女人。', 10, 20)
    expect(pieces.length).toBeGreaterThanOrEqual(3)
    expect(pieces.every(piece => piece.text.length <= 24)).toBe(true)
    expect(pieces.map(piece => piece.text).join('')).toBe('拍卖厅比她预想的窄，但高。三排买主席，木板是打捞上来的船板，一条一条拼起来，缝里还嵌着盐。第一排坐着一个金发女人。')
    expect(pieces[0]!.start).toBe(10)
    expect(pieces.at(-1)!.end).toBeCloseTo(20, 2)
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.start).toBeCloseTo(pieces[i - 1]!.end, 2)
    expect(subtitlePieces('Short one.', 0, 2)).toEqual([{ start: 0, end: 2, text: 'Short one.' }])
    const english = subtitlePieces('The auction hall was narrower than she had expected, but tall: three rows of benches made of salvaged ship planks, laid one by one, with salt still in the seams.', 0, 9)
    expect(english.length).toBeGreaterThan(1)
    expect(english.every(piece => piece.text.length <= 78)).toBe(true)
  })

  it('keeps a closing mark with what it closes and an opening one with what it opens', () => {
    const told = '阿棠的声音贴着门板进来：“沈小姐，报馆又出急刊。”\n沈蘅没有应。她只说了一句：“放下吧……”就再没有声音。'
    const pieces = subtitlePieces(told, 0, 12).map(piece => piece.text)
    expect(pieces.length).toBeGreaterThan(2)
    // Nothing is lost, and the paragraph break leaves no gap in a script that has no spaces.
    expect(pieces.join('')).toBe(told.replace('\n', ''))
    for (const piece of pieces) {
      expect(piece).not.toMatch(/^[”’」』）》。！？；…，、：]/u)
      expect(piece).not.toMatch(/[“‘「『（《]$/u)
    }
    // The quote that closes a sentence at the very limit goes with it, a mark past the limit.
    expect(pieces[0]).toBe('阿棠的声音贴着门板进来：“沈小姐，报馆又出急刊。”')
    expect(pieces).toEqual(['阿棠的声音贴着门板进来：“沈小姐，报馆又出急刊。”', '沈蘅没有应。她只说了一句：“放下吧……”', '就再没有声音。'])
  })

  it('names the moments worth a look, and the words that belong on the picture at each', () => {
    const lines = [
      { start: 0, end: 2.4, text: '敲门声又响了三下。' },
      { start: 2.4, end: 5, text: '沈蘅没有应。' },
      // A silence of a second before the next line.
      { start: 6, end: 9, text: '“沈小姐，报馆又出急刊。”' },
      { start: 9, end: 12, text: '她拿起伞，走进晨雾。' },
    ]
    // Told from the first second: the first line, the silence, the middle, the last.
    expect(stillMarks(lines, 0)).toEqual([
      { at: 1.2, expect: '敲门声又响了三下。' },
      { at: 5.5 },
      { at: 7.5, expect: '“沈小姐，报馆又出急刊。”' },
      { at: 10.5, expect: '她拿起伞，走进晨雾。' },
    ])
    // A title card of four seconds: a look at it first — nothing of the telling belongs there — and everything else four seconds on.
    expect(stillMarks(lines, 4)).toEqual([
      { at: 2 },
      { at: 5.2, expect: '敲门声又响了三下。' },
      { at: 9.5 },
      { at: 11.5, expect: '“沈小姐，报馆又出急刊。”' },
      { at: 14.5, expect: '她拿起伞，走进晨雾。' },
    ])
    expect(stillMarks([], 4)).toEqual([])
  })

  it('refuses a chapter that has nothing to cut from, with what to make first', async () => {
    const { project } = bed.runtime
    const plan = await project.addChapter({ title: '空章' })
    await expect(videoMaterials(bed.core, bed.runtime, plan.id)).rejects.toThrow(/no audio script yet.*novel_audio action=script/)
    await project.saveAudioScript({ schema: 1, chapterId: plan.id, textHash: 'h', updatedAt: '', cues: [], lines: [{ id: 'l0', kind: 'narration', text: '一句。' }] })
    await expect(videoMaterials(bed.core, bed.runtime, plan.id)).rejects.toThrow(/no line .* has been voiced yet/)
    const ready = await videoReadiness(bed.core, bed.runtime, plan.id)
    expect(ready.blocked).toMatch(/has been voiced yet/)
    // No agent loop in a bare core: said, not thrown.
    expect(ready.agent).toBe(false)
  })

  it('judges a video by what it is for', () => {
    const good: VideoProbe = { duration: 8.6, size: 1_000_000, video: { codec: 'h264', width: 1920, height: 1080, fps: 30 }, audio: { codec: 'aac', channels: 2 }, maxVolume: -3, meanVolume: -20, black: 0, frames: [] }
    expect(videoFaults(good, { duration: 8.4 }, true)).toEqual([])
    // A title before the telling is welcome.
    expect(videoFaults({ ...good, duration: 12 }, { duration: 8.4 }, true)).toEqual([])
    const { audio: _audio, ...mute } = good
    expect(videoFaults(mute, { duration: 8.4 }, true).join()).toContain('没有声音')
    const { video: _video, ...blind } = good
    expect(videoFaults(blind, { duration: 8.4 }, false).join()).toContain('No picture')
    expect(videoFaults({ ...good, maxVolume: -70 }, { duration: 8.4 }, true).join()).toContain('几乎是静音')
    expect(videoFaults({ ...good, duration: 4.2 }, { duration: 8.4 }, true).join()).toContain('太短')
    expect(videoFaults({ ...good, duration: 80 }, { duration: 8.4 }, true).join()).toContain('太长')
    expect(videoFaults({ ...good, black: 5 }, { duration: 8.4 }, true).join()).toContain('黑屏')
    expect(videoFaults({ ...good, video: { ...good.video!, width: 320, height: 180 } }, { duration: 8.4 }, true).join()).toContain('太小')
  })

  it('wants the words to reach the viewer, and leaves the way to the cutter', () => {
    const cut: VideoProbe = { duration: 8.6, size: 1_000_000, video: { codec: 'h264', width: 1920, height: 1080, fps: 30 }, audio: { codec: 'aac', channels: 2 }, maxVolume: -3, meanVolume: -20, black: 0, frames: [] }
    // Nobody asked for subtitles: nothing is missing.
    expect(videoFaults(cut, { duration: 8.4 }, true)).toEqual([])
    expect(videoFaults(cut, { duration: 8.4 }, true, { subtitles: false })).toEqual([])
    // Asked for, and neither in the picture nor carried: refused, in words that name both ways and no command.
    const missing = videoFaults(cut, { duration: 8.4 }, true, { subtitles: true })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('没有字幕')
    expect(missing[0]).toContain('burned=true')
    expect(missing[0]).not.toMatch(/-map|-c:s|ffmpeg/)
    expect(videoFaults(cut, { duration: 8.4 }, false, { subtitles: true }).join()).toContain('No subtitles')
    // Drawn into the picture, on the cutter's word; or carried as a track, which is measured.
    expect(videoFaults(cut, { duration: 8.4 }, true, { subtitles: true, burned: true })).toEqual([])
    expect(videoFaults({ ...cut, subtitles: { codec: 'mov_text' } }, { duration: 8.4 }, true, { subtitles: true })).toEqual([])
  })

  it.skipIf(!hasFfmpeg())('has post-production cut it: a video that fails the checks is refused, one that passes becomes the chapter\'s', async () => {
    const id = await staged(bed)
    bed.roles.enabled = true
    const said: string[] = []
    bed.roles.script = async (task, call) => {
      expect(task.role).toBe('producer')
      expect(task.label).toBe('后期 · 第1章 · 成片')
      expect(task.prompt).toContain('materials.json')
      expect(task.prompt).toContain('作者的要求：慢一点')
      // What is wanted of the words is said; how to get them there is not.
      expect(task.prompt).toContain('字幕（必须有）')
      expect(task.prompt).toContain('用什么办法由你定')
      expect(task.prompt).not.toMatch(/-c:s|mov_text|-map/)
      expect(task.tools.map(tool => tool.name)).toEqual(['book_read', 'book_search', 'book_find', 'video_check', 'video_submit'])
      expect(task.skills?.map(skill => skill.name)).toEqual(['novel-video-editing'])
      // Post-production's own work is done with the conversation's tools, where it has them.
      expect(task.inherit).toMatchObject({ mode: 'named' })
      const workdir = bed.runtime.project.path('assets', 'video', 'work', id)
      expect(existsSync(join(workdir, 'voice.wav'))).toBe(true)
      // Nothing was cut here before: nothing is said to be lying around.
      expect(task.prompt).not.toContain('留下的东西')
      // Asked how it stands while nothing has passed: it owes a cut that passes, before anything finer.
      expect(task.budgetNote?.({ used: 100, limit: 200, left: 100 })).toContain('还没有任何一版通过 video_check')
      // A first cut that is far too short…
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=10', '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '2', '-pix_fmt', 'yuv420p', join(workdir, 'short.mp4')])
      said.push(await call('video_check', { path: 'short.mp4' }))
      said.push(await call('video_submit', { path: 'short.mp4', note: '先交一版。' }))
      // …something outside the book…
      said.push(await call('video_submit', { path: '/etc/hosts', note: 'x' }))
      // …one that is as long as the telling, but brings none of its words…
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=10', '-i', join(workdir, 'voice.wav'), '-t', '8.6', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(workdir, 'out.mp4')])
      said.push(await call('video_check', { path: 'out.mp4' }))
      said.push(await call('video_submit', { path: 'out.mp4', note: '没有字幕的一版。' }))
      // Still nothing that would be taken as it is…
      expect(task.budgetNote?.({ used: 150, limit: 200, left: 50 })).toContain('还没有任何一版通过 video_check')
      // …which would do if the words were in its picture, on the cutter's word: a cut that passes, and the Studio has nothing left to press for.
      said.push(await call('video_check', { path: 'out.mp4', burned: true }))
      expect(task.budgetNote?.({ used: 160, limit: 200, left: 40 })).toBeUndefined()
      // …and one that carries them as a track.
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', join(workdir, 'out.mp4'), '-i', join(workdir, 'subtitles.srt'), '-map', '0:v', '-map', '0:a', '-map', '1:s', '-c', 'copy', '-c:s', 'mov_text', join(workdir, 'final.mp4')])
      said.push(await call('video_check', { path: 'final.mp4' }))
      said.push(await call('video_submit', { path: join(workdir, 'final.mp4'), note: '按时间线剪的，一格没有画面，用前一格顶上。' }))
      return ''
    }
    const result = await produceVideo(bed.core, bed.runtime, { chapter: id, direction: '慢一点' }, { origin: 'user' })
    expect(said[0]).toContain('还不能提交')
    expect(said[0]).toContain('太短')
    expect(said[1]).toMatch(/^ERROR: 这段视频还不能收:\n- .*太短/s)
    expect(said[2]).toMatch(/^ERROR: .*outside the book/)
    expect(said[3]).toContain('还不能提交')
    expect(said[3]).toContain('没有字幕')
    expect(said[3]).not.toContain('太短')
    expect(said[4]).toMatch(/^ERROR: 这段视频还不能收:\n- 没有字幕/)
    expect(said[5]).toContain('检查通过')
    expect(said[6]).toContain('检查通过')
    expect(said[6]).toContain('subtitle track mov_text')
    // The stills are taken where the lines are, each said with the words that belong on it.
    expect(said[6]).toMatch(/frame-1\.png @ [\d.]+ s — 「门缝里塞进一张湿剪报。」/)
    expect(said[6]).toContain('看图核对')
    expect(said[7]).toBe('收下了：它现在是这一章的视频。')
    expect(result.video).toMatchObject({ chapterId: id, path: `assets/video/${id}.mp4`, width: 640, height: 360, note: '按时间线剪的，一格没有画面，用前一格顶上。', material: { spoken: 3, silent: 1, drawn: 2, undrawn: 1, clips: 1 }, subtitles: { path: `assets/video/${id}.vtt`, burned: false } })
    expect(result.video.duration).toBeCloseTo(8.6, 0)
    expect(await chapterVideo(bed.runtime, id)).toEqual(result.video)
    // The words a web player shows: a copy of the file's track, kept beside it.
    const words = (await bed.runtime.project.readFile(`assets/video/${id}.vtt`)).toString('utf8')
    expect(words).toMatch(/^WEBVTT/)
    expect(words).toContain('-->')
    expect(words).toContain('门缝里塞进一张湿剪报')
    expect((await bed.runtime.project.activity()).some(entry => entry.by === 'crew' && entry.role === 'producer' && entry.tool === 'video')).toBe(true)

    // And it can be taken away again; what it was cut from stays.
    expect(await removeVideo(bed.runtime, id)).toEqual({ chapterId: id, removed: true })
    expect(await chapterVideo(bed.runtime, id)).toBeUndefined()
    expect(await bed.runtime.project.has(`assets/video/${id}.mp4`)).toBe(false)
    expect(await bed.runtime.project.has(`assets/video/${id}.vtt`)).toBe(false)
    expect(await removeVideo(bed.runtime, id)).toEqual({ chapterId: id, removed: false })
    expect((await bed.runtime.project.audioScript(id))?.lines).toHaveLength(4)
  }, 60_000)

  it('tells the next cut what the last one left in the working directory', async () => {
    if (!hasFfmpeg()) return
    const id = await staged(bed)
    bed.roles.enabled = true
    const workdir = bed.runtime.project.path('assets', 'video', 'work', id)
    // A cut that ran out of its budget: scripts and drawn words, a result that never got written.
    bed.roles.script = async () => {
      execFileSync('mkdir', ['-p', join(workdir, 'subs')])
      for (const name of ['subs/s001.png', 'subs/s002.png', 'render.py']) execFileSync('sh', ['-c', `printf x > "${join(workdir, name)}"`])
      execFileSync('sh', ['-c', `: > "${join(workdir, 'out.mp4')}"`])
      return '额度用完了。'
    }
    await expect(produceVideo(bed.core, bed.runtime, { chapter: id }, { origin: 'user' })).rejects.toMatchObject({ code: 'NO_DELIVERY' })
    // What the Studio laid out is not "left behind"; an empty file is nothing.
    expect(await leftBehind(workdir)).toEqual(['render.py', 'subs/ (2)'])
    let prompt = ''
    bed.roles.script = async (task) => { prompt = task.prompt; return '' }
    await expect(produceVideo(bed.core, bed.runtime, { chapter: id }, { origin: 'user' })).rejects.toMatchObject({ code: 'NO_DELIVERY' })
    expect(prompt).toContain('工作目录里还有以前剪这一章时留下的东西：render.py、subs/ (2)')
  })

  it('says so when post-production hands nothing in', async () => {
    if (!hasFfmpeg()) return
    const id = await staged(bed)
    bed.roles.enabled = true
    bed.roles.script = async () => '这台机器的 ffmpeg 不能用。'
    await expect(produceVideo(bed.core, bed.runtime, { chapter: id }, { origin: 'user' })).rejects.toMatchObject({ code: 'NO_DELIVERY', message: expect.stringContaining('这台机器的 ffmpeg 不能用') })
  })
})

describe('taking away what was made', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ title: '七日未寄' }) })
  afterEach(async () => { await bed.cleanup() })

  it('removes a script line: its cues move on, a panel that showed only it goes', async () => {
    const id = await staged(bed)
    const { project } = bed.runtime
    const done = await removeAudioLine(bed.runtime, id, 'l2')
    expect(done.script.lines.map(line => line.id)).toEqual(['l0', 'l1', 'l3'])
    expect(done.panels).toBe(1)
    expect((await project.comicBoard(id))!.panels.map(panel => panel.id)).toEqual(['p0', 'p2'])
    // A cue that began at a removed line begins at the next thing said — or the one before, at the end.
    const after = await removeAudioLine(bed.runtime, id, 'l1')
    expect(after.script.cues.map(cue => [cue.id, cue.at])).toEqual([['c0', 'l0'], ['c1', 'l3'], ['c2', 'l3']])
    expect(after.panels).toBe(0)
    expect((await project.comicBoard(id))!.panels[0]!.lines).toEqual(['l0'])
    const last = await removeAudioLine(bed.runtime, id, 'l3')
    expect(last.script.cues.every(cue => cue.at === 'l0')).toBe(true)
    await expect(removeAudioLine(bed.runtime, id, 'nope')).rejects.toThrow(/no line "nope"/)
  })

  it('removes a panel: its lines go to a neighbour, so no line is left without a picture', async () => {
    const id = await staged(bed)
    const middle = await removeComicPanel(bed.runtime, id, 'p1')
    expect(middle.panels.map(panel => [panel.id, panel.lines])).toEqual([['p0', ['l0', 'l1', 'l2']], ['p2', ['l3']]])
    // The first panel's lines go to the one after it.
    const first = await removeComicPanel(bed.runtime, id, 'p0')
    expect(first.panels.map(panel => [panel.id, panel.lines])).toEqual([['p2', ['l0', 'l1', 'l2', 'l3']]])
    // The pictures stay where the gallery keeps them.
    expect(await bed.runtime.project.has('assets/images/p0.png')).toBe(true)
    expect((await removeComicPanel(bed.runtime, id, 'p2')).panels).toEqual([])
  })

  it('throws a script, a storyboard and a review away whole', async () => {
    const id = await staged(bed)
    const { project } = bed.runtime
    await project.saveReview({ chapterId: id, textHash: 'h', createdAt: '', verdict: 'ok', issues: [] })
    expect(await clearReview(bed.runtime, id)).toEqual({ chapterId: id, removed: true })
    expect(await project.review(id)).toBeUndefined()
    expect(await clearReview(bed.runtime, id)).toEqual({ chapterId: id, removed: false })
    expect(await clearComicBoard(bed.runtime, id)).toEqual({ chapterId: id, removed: true })
    expect(await project.comicBoard(id)).toBeUndefined()
    expect(await clearAudioScript(bed.runtime, id)).toEqual({ chapterId: id, removed: true })
    expect(await project.audioScript(id)).toBeUndefined()
    // The takes are still on disk for a script made again.
    expect(await project.has(`assets/audio/${id}/l0.wav`)).toBe(true)
    await expect(clearAudioScript(bed.runtime, 'nope')).rejects.toThrow(/no chapter matches/)
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter as a video, made by an agent.
 *
 * Everything the earlier stages made for a chapter — a voice for every line,
 * sound cues, a picture for every panel — is material. Nothing here assembles
 * it by rule: the material is laid out with its timing in one list, and handed
 * to post-production, an agent with a shell, which writes whatever it takes to
 * cut it (ffmpeg, a script of its own), looks at what came out, and may call in
 * an outside coding agent when the work is beyond it. What the Studio keeps for
 * itself is the judging: a video is taken only if it plays, has picture and
 * sound for its whole length, and is as long as the chapter's telling.
 */
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { clip, FFMPEG_INSTALL } from '../../shared/text'
import type { AudioCue, AudioLine, CameraMove, ChapterVideo } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { crewSkillDir, delegate } from '../crew'
import { LlmCallError } from '../llm'
import { encodeWav, parseWav, resample, type PcmAudio } from '../media/wav'
import { ProjectError } from '../project'
import { L, promptLanguage } from '../render'
import { argText, type RoleTool } from '../roles'
import { findProgram } from '../util/program'
import { isSkipped } from './audio'

// ───────────────────────────── the tools on this computer ─────────────────────────────

export { findProgram }

function run(program: string, args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(program, args, { timeout: options.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, ...(options.signal !== undefined ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true) reject(new Error(`${program} did not finish in time`))
      // ffmpeg writes what it found to stderr and may still exit non-zero on a file that is not a video: both are answers.
      else resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// ───────────────────────────── the material ─────────────────────────────

export interface VideoMaterials {
  book: { title: string; language: string; root: string }
  chapter: { id: string; index: number; title: string }
  /** The only directory post-production writes in. */
  workdir: string
  /** Where the finished file is expected (any name in the workdir will do). */
  output: string
  /** A frame the pictures were made for; the video may be cut to another if it has reason. */
  frame: { width: number; height: number; fps: number }
  /** Seconds the telling takes: the last line's end. */
  duration: number
  lines: {
    id: string
    start: number
    end: number
    kind: AudioLine['kind']
    speaker?: string
    text: string
    /** Absolute path of the spoken take; absent for a line that is held in silence. */
    audio?: string
  }[]
  panels: {
    id: string
    start: number
    end: number
    /** Absolute path of the picture; absent when the panel was never drawn. */
    image?: string
    description: string
    camera: CameraMove
    lines: string[]
  }[]
  cues: {
    kind: 'bed' | 'effect' | 'music'
    start: number
    /** Until the next cue of its kind, for beds and music. */
    end?: number
    caption?: string
    /** Absolute path of the generated clip; absent when the cue has none (a bed the browser makes up as it plays). */
    audio?: string
    clipSeconds?: number
    intensity?: number
  }[]
  /** Other pictures of the book that a title or an end card could use. */
  extras: { cover?: string; illustrations: { path: string; kind: string; prompt: string }[] }
  counts: { spoken: number; silent: number; drawn: number; undrawn: number; clips: number }
  /**
   * The same material in forms a shell takes without parsing JSON, written
   * beside this list: the whole telling as one track, the lines as subtitles,
   * the panels and the cues as tab-separated tables.
   */
  files?: { voice: string; subtitles: string; panels: string; cues: string }
}

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000

/** How long a line with no voice is held, the way the player holds it. */
function holdSeconds(text: string): number {
  return Math.max(1.2, text.length * (/[㐀-鿿]/.test(text) ? 0.19 : 0.062))
}

/**
 * Lay a chapter's material out on one timeline: every line with its start and
 * end, every panel over the lines it covers, every cue where it begins.
 * @throws ProjectError `novel/empty` when the chapter has nothing a video could be cut from, with what to make first.
 */
export async function videoMaterials(core: NovelCore, runtime: ProjectRuntime, chapterRef: string): Promise<VideoMaterials> {
  const { project } = runtime
  if (project.sealed) throw new ProjectError('novel/unsupported', 'a sealed book\'s material is kept encrypted and cannot be handed to a shell — unseal the book to cut a video of it')
  const chapter = await project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  const manifest = await project.manifest()
  const script = await project.audioScript(chapter.plan.id)
  if (script === undefined || script.lines.length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has no audio script yet — direct and voice it first (novel_audio action=script, then action=synthesize)`)
  const settings = (await core.settingsOf(runtime)).tts
  const lines: VideoMaterials['lines'] = []
  let cursor = 0
  let spoken = 0
  let silent = 0
  for (const line of script.lines) {
    if (isSkipped(line, settings)) continue
    const voiced = line.audio !== undefined && line.duration !== undefined && line.duration > 0 && await project.has(line.audio)
    const length = voiced ? line.duration! : holdSeconds(line.text)
    if (voiced) spoken += 1
    else silent += 1
    lines.push({
      id: line.id,
      start: round(cursor),
      end: round(cursor + length),
      kind: line.kind,
      ...(line.speakerName !== undefined ? { speaker: line.speakerName } : {}),
      text: line.text,
      ...(voiced ? { audio: project.path(line.audio!) } : {}),
    })
    // The pause the joined chapter track leaves after a line.
    cursor += length + (line.kind === 'narration' ? 0.45 : 0.3)
  }
  if (spoken === 0) throw new ProjectError('novel/empty', `no line of chapter ${chapter.index} has been voiced yet — synthesize its audio first (novel_audio action=synthesize)`)
  const duration = round(lines.at(-1)!.end)
  const at = new Map(lines.map(line => [line.id, line]))

  const board = await project.comicBoard(chapter.plan.id)
  const panels: VideoMaterials['panels'] = []
  for (const panel of board?.panels ?? []) {
    const covered = panel.lines.map(id => at.get(id)).filter((line): line is VideoMaterials['lines'][number] => line !== undefined)
    if (covered.length === 0) continue
    const first = covered[0]!
    const last = covered.at(-1)!
    const start = first.start + (panel.begin ?? 0) * (first.end - first.start)
    const end = last.start + (panel.end ?? 1) * (last.end - last.start)
    const drawn = panel.image !== undefined && await project.has(panel.image)
    panels.push({ id: panel.id, start: round(start), end: round(Math.max(end, start + 0.5)), ...(drawn ? { image: project.path(panel.image!) } : {}), description: panel.description, camera: panel.camera, lines: covered.map(line => line.id) })
  }
  panels.sort((left, right) => left.start - right.start)
  // A picture stays until the next one comes: no gap shows nothing.
  for (let i = 0; i < panels.length; i++) panels[i]!.end = i + 1 < panels.length ? panels[i + 1]!.start : duration
  if (panels.length > 0) panels[0]!.start = 0

  const cues: VideoMaterials['cues'] = []
  const kindOf = (cue: AudioCue): 'bed' | 'effect' | 'music' => cue.kind ?? 'bed'
  for (const cue of script.cues) {
    const line = at.get(cue.at)
    if (line === undefined) continue
    const has = cue.audio !== undefined && await project.has(cue.audio)
    const caption = cue.caption ?? cue.note
    cues.push({
      kind: kindOf(cue),
      start: line.start,
      ...(caption !== undefined ? { caption } : {}),
      ...(has ? { audio: project.path(cue.audio!), ...(cue.duration !== undefined ? { clipSeconds: cue.duration } : {}) } : {}),
      ...(cue.intensity !== undefined ? { intensity: cue.intensity } : {}),
    })
  }
  cues.sort((left, right) => left.start - right.start)
  for (const kind of ['bed', 'music'] as const) {
    const same = cues.filter(cue => cue.kind === kind)
    for (let i = 0; i < same.length; i++) same[i]!.end = i + 1 < same.length ? same[i + 1]!.start : duration
  }

  const illustrations = await project.illustrations()
  const cover = await project.cover()
  const extras: VideoMaterials['extras'] = {
    ...(cover !== undefined && await project.has(cover) ? { cover: project.path(cover) } : {}),
    illustrations: [],
  }
  for (const picture of illustrations) {
    if (picture.kind !== 'scene' && picture.kind !== 'location' && picture.kind !== 'portrait') continue
    if (picture.kind === 'scene' && picture.target !== chapter.plan.id) continue
    if (!(await project.has(picture.path))) continue
    extras.illustrations.push({ path: project.path(picture.path), kind: picture.kind, prompt: clip(picture.prompt, 160) })
  }
  const drawn = panels.filter(panel => panel.image !== undefined).length
  if (drawn === 0 && extras.cover === undefined && extras.illustrations.length === 0) {
    throw new ProjectError('novel/empty', `chapter ${chapter.index} has no picture to show — cut and draw its storyboard first (novel_comic action=storyboard, then action=render)`)
  }

  const workdir = project.path('assets', 'video', 'work', chapter.plan.id)
  return {
    book: { title: manifest.title, language: manifest.language, root: project.root },
    chapter: { id: chapter.plan.id, index: chapter.index, title: chapter.plan.title },
    workdir,
    output: join(workdir, `${chapter.plan.id}.mp4`),
    frame: { width: 1920, height: 1080, fps: 30 },
    duration,
    lines,
    panels,
    cues,
    extras,
    counts: { spoken, silent, drawn, undrawn: panels.length - drawn, clips: cues.filter(cue => cue.audio !== undefined).length },
  }
}

/** Seconds as an SRT timestamp. */
function stamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

/** Marks that close what stands before them: a piece never begins with one. */
const CLOSERS = /[”’」』）)》〉】\]。！？!?；;…，,、：:.]/u
/** Marks that open what follows: a piece never ends on one. */
const OPENERS = /[“‘「『（(《〈【\[]/u

/** A line cut into pieces a screen can hold, each with its share of the line's time. */
export function subtitlePieces(text: string, start: number, end: number): { start: number; end: number; text: string }[] {
  const cjk = /[㐀-鿿぀-ヿ가-힯]/.test(text)
  // A script without spaces between words wants none after its marks either — where paragraphs were joined, say.
  const flat = (cjk ? text.replace(/([。！？；，、：…”’」』）》])\s+/gu, '$1').replace(/\s+([“‘「『（《])/gu, '$1') : text).replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return []
  const limit = cjk ? 24 : 78
  const pieces: string[] = []
  let rest = flat
  while (rest.length > limit) {
    // The last place to break before the limit: after a sentence mark, else a comma, else a space, else at the limit.
    const head = rest.slice(0, limit)
    const at = Math.max(head.search(/[。！？!?；;…][^。！？!?；;…]*$/u), -1)
    const comma = head.search(/[，,、：:][^，,、：:]*$/u)
    const space = cjk ? -1 : head.lastIndexOf(' ')
    let cut = at >= limit * 0.4 ? at + 1 : comma >= limit * 0.4 ? comma + 1 : space >= limit * 0.4 ? space + 1 : limit
    // A closing quote, a second mark of an ellipsis: they belong to what they close, even a little past the limit.
    while (cut < rest.length && CLOSERS.test(rest[cut]!)) cut += 1
    // An opening quote goes on with what it opens.
    while (cut > 1 && OPENERS.test(rest[cut - 1]!)) cut -= 1
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) pieces.push(rest)
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const out: { start: number; end: number; text: string }[] = []
  let cursor = start
  for (const piece of pieces) {
    const length = (end - start) * piece.length / total
    out.push({ start: round(cursor), end: round(cursor + length), text: piece })
    cursor += length
  }
  return out
}

/**
 * Write the material into the working directory: the list itself, and the same
 * thing as a shell likes it — one voice track with every line where the
 * timeline puts it, subtitles, and tables of the panels and the cues.
 */
export async function writeMaterials(runtime: ProjectRuntime, materials: VideoMaterials): Promise<{ manifest: string; materials: VideoMaterials }> {
  const { project } = runtime
  await mkdir(materials.workdir, { recursive: true })
  // The telling as one track: each take at its second, silence where a line has no voice.
  let rate = 24_000
  const takes: { at: number; audio: PcmAudio }[] = []
  for (const line of materials.lines) {
    if (line.audio === undefined) continue
    try {
      const audio = parseWav(await project.readFile(project.relative(line.audio)))
      if (takes.length === 0) rate = audio.sampleRate
      takes.push({ at: line.start, audio: resample(audio, rate) })
    } catch {
      // A take that cannot be read is silence in the track; the list still names its file.
    }
  }
  const pcm = new Int16Array(Math.ceil((materials.duration + 0.5) * rate))
  for (const take of takes) {
    const offset = Math.round(take.at * rate)
    pcm.set(take.audio.pcm.subarray(0, Math.max(0, pcm.length - offset)), offset)
  }
  const files = {
    voice: join(materials.workdir, 'voice.wav'),
    subtitles: join(materials.workdir, 'subtitles.srt'),
    panels: join(materials.workdir, 'panels.tsv'),
    cues: join(materials.workdir, 'cues.tsv'),
  }
  await writeFile(files.voice, encodeWav({ pcm, sampleRate: rate }))
  const subtitles = materials.lines.flatMap(line => subtitlePieces(line.text, line.start, line.end))
  await writeFile(files.subtitles, `${subtitles.map((piece, index) => `${index + 1}\n${stamp(piece.start)} --> ${stamp(piece.end)}\n${piece.text}\n`).join('\n')}`, 'utf8')
  const cell = (value: string | number | undefined): string => value === undefined ? '' : String(value).replace(/[\t\n\r]+/g, ' ')
  await writeFile(files.panels, `${materials.panels.map((panel, index) => [index + 1, panel.start, panel.end, round(panel.end - panel.start), panel.camera, cell(panel.image), cell(panel.description)].join('\t')).join('\n')}\n`, 'utf8')
  await writeFile(files.cues, `${materials.cues.map(cue => [cue.kind, cue.start, cell(cue.end), cell(cue.clipSeconds), cell(cue.intensity), cell(cue.audio), cell(cue.caption)].join('\t')).join('\n')}\n`, 'utf8')
  // The base script of post-production's skill, at hand where it will be run.
  const skill = await crewSkillDir('producer', 'novel-video-editing')
  if (skill !== undefined) await copyFile(join(skill, 'cut-base.sh'), join(materials.workdir, 'cut-base.sh')).catch(() => {})
  const complete = { ...materials, files }
  const manifest = join(materials.workdir, 'materials.json')
  await writeFile(manifest, `${JSON.stringify(complete, null, 2)}\n`, 'utf8')
  return { manifest, materials: complete }
}

// ───────────────────────────── judging a video ─────────────────────────────

export interface VideoProbe {
  duration: number
  size: number
  video?: { codec: string; width: number; height: number; fps: number }
  audio?: { codec: string; channels: number }
  /** The subtitle track the file carries, when it carries one. */
  subtitles?: { codec: string }
  /** Loudest and average level of the sound, dB below full scale. */
  maxVolume?: number
  meanVolume?: number
  /** Seconds of the picture that are black. */
  black: number
  /** Stills taken from it, for eyes that can look. */
  frames: string[]
}

function fraction(value: string | undefined): number {
  if (value === undefined) return 0
  const [top, bottom] = value.split('/').map(Number)
  return bottom !== undefined && bottom > 0 ? top! / bottom : Number.isFinite(top) ? top! : 0
}

/**
 * Measure a video file: what streams it has, how long it is, how loud, how much of it is black.
 * @param stills - a directory to leave a few frames in.
 * @throws ProjectError when the measuring tools are not on this computer or the file is not a video.
 */
/**
 * Measure a video.
 * @param options.stills - a folder to leave stills in.
 * @param options.at - the seconds to take them at (each kept inside the video); left out: four, evenly spread.
 */
export async function probeVideo(path: string, options: { stills?: string; at?: readonly number[]; signal?: AbortSignal } = {}): Promise<VideoProbe> {
  const [ffprobe, ffmpeg] = await Promise.all([findProgram('ffprobe'), findProgram('ffmpeg')])
  if (ffprobe === undefined || ffmpeg === undefined) throw new ProjectError('novel/unsupported', `ffmpeg and ffprobe are needed to cut and to check a video, and they are not on this computer (${FFMPEG_INSTALL[1]})`)
  let info: { size: number }
  try {
    info = await stat(path)
  } catch {
    throw new ProjectError('novel/not-found', `there is no file at ${path}`)
  }
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { ...(options.signal !== undefined ? { signal: options.signal } : {}) })
  let parsed: { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; channels?: number; duration?: string }[] }
  try {
    parsed = JSON.parse(stdout) as typeof parsed
  } catch {
    parsed = {}
  }
  const streams = parsed.streams ?? []
  const video = streams.find(stream => stream.codec_type === 'video')
  const audio = streams.find(stream => stream.codec_type === 'audio')
  const captions = streams.find(stream => stream.codec_type === 'subtitle')
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0)
  if (!Number.isFinite(duration) || duration <= 0 || (video === undefined && audio === undefined)) throw new ProjectError('novel/invalid', `${path} is not a video file ffprobe can read`)
  const probe: VideoProbe = {
    duration: round(duration),
    size: info.size,
    ...(video !== undefined ? { video: { codec: video.codec_name ?? '?', width: video.width ?? 0, height: video.height ?? 0, fps: Math.round(fraction(video.avg_frame_rate ?? video.r_frame_rate) * 100) / 100 } } : {}),
    ...(audio !== undefined ? { audio: { codec: audio.codec_name ?? '?', channels: audio.channels ?? 0 } } : {}),
    ...(captions !== undefined ? { subtitles: { codec: captions.codec_name ?? '?' } } : {}),
    black: 0,
    frames: [],
  }
  // One pass over the whole file: how loud the sound is, and where the picture is black.
  const filters = [
    ...(video !== undefined ? ['-vf', 'blackdetect=d=0.4:pix_th=0.06'] : ['-vn']),
    ...(audio !== undefined ? ['-af', 'volumedetect'] : ['-an']),
  ]
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', path, ...filters, '-f', 'null', '-'], { timeoutMs: 600_000, ...(options.signal !== undefined ? { signal: options.signal } : {}) })
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr)
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)
  if (max !== null) probe.maxVolume = Number(max[1])
  if (mean !== null) probe.meanVolume = Number(mean[1])
  for (const match of stderr.matchAll(/black_duration:([\d.]+)/g)) probe.black += Number(match[1])
  probe.black = round(probe.black)
  if (options.stills !== undefined && video !== undefined) {
    await mkdir(options.stills, { recursive: true })
    const times = options.at !== undefined && options.at.length > 0 ? options.at.map(at => Math.min(Math.max(0, at), Math.max(0, duration - 0.1))) : [0, 1, 2, 3].map(i => duration * (i + 0.5) / 4)
    for (let i = 0; i < times.length; i++) {
      const at = times[i]!
      // PNG: current ffmpeg refuses to write a JPEG from video-range colour without being told twice.
      const file = join(options.stills, `frame-${i + 1}.png`)
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'scale=960:-2', file], { timeoutMs: 60_000, ...(options.signal !== undefined ? { signal: options.signal } : {}) })
      try {
        await access(file)
        probe.frames.push(file)
      } catch {
        // a frame that would not come out is one fewer to look at
      }
    }
  }
  return probe
}

/** A moment of a cut to look at, and the words that should be read on the picture then (none: nothing of the telling). */
export interface StillMark {
  at: number
  expect?: string
}

/**
 * The moments worth a look in a cut that should show its lines: before the
 * telling begins when a title moved it back, the first line, a silence
 * between two lines, the middle and the last line — each with what should be
 * on the picture then. A cutter who can see checks the words against these;
 * a subtitle that comes early, stays too long or never shows is found here.
 * @param lead - seconds the telling begins after the start of the video.
 */
export function stillMarks(lines: readonly { start: number; end: number; text: string }[], lead: number): StillMark[] {
  const pieces = lines.flatMap(line => subtitlePieces(line.text, line.start, line.end))
  if (pieces.length === 0) return []
  const marks: StillMark[] = []
  const middle = (piece: { start: number; end: number; text: string }): StillMark => ({ at: round(lead + (piece.start + piece.end) / 2), expect: piece.text })
  if (lead >= 1) marks.push({ at: round(lead / 2) })
  marks.push(middle(pieces[0]!))
  // A silence between two lines, long enough for a frame to fall wholly inside it.
  for (let index = 1; index < pieces.length; index++) {
    const gap = pieces[index]!.start - pieces[index - 1]!.end
    if (gap >= 0.5) {
      marks.push({ at: round(lead + pieces[index - 1]!.end + gap / 2) })
      break
    }
  }
  if (pieces.length > 2) marks.push(middle(pieces[Math.floor(pieces.length / 2)]!))
  if (pieces.length > 1) marks.push(middle(pieces.at(-1)!))
  return marks
}

/** What the author wants of the words, and what the cutter says of them. */
export interface SubtitleWish {
  /** The author wants the viewer to see the lines. */
  subtitles?: boolean
  /** The cutter says they are drawn into the picture. */
  burned?: boolean
}

/** What is wrong with a video as the cut of this material; empty when it can be taken. */
export function videoFaults(probe: VideoProbe, materials: Pick<VideoMaterials, 'duration'>, zh: boolean, wanted: SubtitleWish = {}): string[] {
  const faults: string[] = []
  const t = (cn: string, en: string): string => zh ? cn : en
  // The words have to reach whoever watches: in the picture, which is the cutter's to say, or as a track, which can be measured. How they get there is the cutter's business.
  if (wanted.subtitles === true && probe.subtitles === undefined && wanted.burned !== true) faults.push(t('没有字幕：作者要观众看得到台词和旁白，而文件里没有字幕轨，你也没有说字已经画进了画面（burned=true）。把字画进画面，或者把 subtitles.srt 作为字幕轨带在成片里——至少其一。', 'No subtitles: the author wants the viewer to see the lines, and the file carries no subtitle track, nor did you say the words are drawn into the picture (burned=true). Draw them into the picture, or carry subtitles.srt in the file as a subtitle track — one of the two at least.'))
  if (probe.video === undefined) faults.push(t('没有画面：文件里没有视频流。', 'No picture: the file has no video stream.'))
  if (probe.audio === undefined) faults.push(t('没有声音：文件里没有音频流。', 'No sound: the file has no audio stream.'))
  else if (probe.maxVolume !== undefined && probe.maxVolume < -45) faults.push(t(`声音几乎是静音（最响处 ${probe.maxVolume} dB）：配音没有混进去。`, `The sound is all but silent (peak ${probe.maxVolume} dB): the voice was not mixed in.`))
  // A title before and a card after are welcome; a telling cut short is not.
  if (probe.duration < materials.duration * 0.92) faults.push(t(`太短：成片 ${probe.duration.toFixed(1)} 秒，而这一章的讲述有 ${materials.duration.toFixed(1)} 秒——有内容被截掉了。`, `Too short: ${probe.duration.toFixed(1)} s, while the chapter's telling takes ${materials.duration.toFixed(1)} s — something was cut off.`))
  if (probe.duration > materials.duration * 1.25 + 30) faults.push(t(`太长：成片 ${probe.duration.toFixed(1)} 秒，讲述只有 ${materials.duration.toFixed(1)} 秒——画面或声音被拉长、重复了。`, `Too long: ${probe.duration.toFixed(1)} s for a telling of ${materials.duration.toFixed(1)} s — picture or sound was stretched or repeated.`))
  if (probe.video !== undefined && probe.black > Math.max(4, probe.duration * 0.15)) faults.push(t(`有 ${probe.black.toFixed(1)} 秒是黑屏：有画面没有放进去，或者路径不对。`, `${probe.black.toFixed(1)} s of it is black: pictures are missing from the cut, or their paths were wrong.`))
  if (probe.video !== undefined && (probe.video.width < 640 || probe.video.height < 360)) faults.push(t(`画面只有 ${probe.video.width}×${probe.video.height}，太小了。`, `The picture is only ${probe.video.width}×${probe.video.height}: too small.`))
  return faults
}

function describeProbe(probe: VideoProbe, materials: Pick<VideoMaterials, 'duration'>, zh: boolean, wanted: SubtitleWish = {}, faults = videoFaults(probe, materials, zh, wanted), marks: readonly StillMark[] = []): string {
  // With marks, each still is said with its moment and the words that belong on it: something to hold the picture against.
  const stills = probe.frames.length === 0 ? '' : marks.length === probe.frames.length
    ? `${zh ? '抽帧（每一帧后面是此刻画面上该有的字；看图核对——字来早了、没撤掉、没出现都算错）' : 'stills (after each: the words that belong on the picture then; look and compare — words that come early, stay or never show are faults)'}:\n${probe.frames.map((file, index) => `  ${file} @ ${marks[index]!.at.toFixed(1)} s — ${marks[index]!.expect !== undefined ? `「${marks[index]!.expect}」` : (zh ? '不该有字幕（讲述还没开始，或两句之间）' : 'no subtitle (the telling has not begun, or between two lines)')}`).join('\n')}`
    : `${zh ? '抽帧' : 'stills'}: ${probe.frames.join(', ')}`
  const facts = [
    `${probe.duration.toFixed(1)} s (${zh ? '讲述' : 'telling'} ${materials.duration.toFixed(1)} s), ${(probe.size / 1_048_576).toFixed(1)} MB`,
    probe.video !== undefined ? `video ${probe.video.codec} ${probe.video.width}×${probe.video.height} @ ${probe.video.fps} fps` : 'no video stream',
    probe.audio !== undefined ? `audio ${probe.audio.codec} ${probe.audio.channels}ch${probe.maxVolume !== undefined ? `, peak ${probe.maxVolume} dB, mean ${probe.meanVolume ?? '?'} dB` : ''}` : 'no audio stream',
    `${probe.subtitles !== undefined ? `subtitle track ${probe.subtitles.codec}` : 'no subtitle track'}${wanted.burned === true ? (zh ? '；你说字已经画进画面——看一眼抽帧确认' : '; you say the words are drawn into the picture — look at the stills to be sure') : ''}`,
    `black ${probe.black.toFixed(1)} s`,
    stills,
  ].filter(line => line.length > 0)
  return `${facts.join('\n')}\n\n${faults.length === 0 ? (zh ? '检查通过：可以提交（video_submit）。' : 'Checks pass: ready to hand in (video_submit).') : `${zh ? '还不能提交' : 'Not ready to hand in'}:\n${faults.map(fault => `- ${fault}`).join('\n')}`}`
}

// ───────────────────────────── the work ─────────────────────────────

const STATE = 'video'

/** A yes of a tool call, however the model wrote it. */
const said = (value: unknown): boolean => value === true || value === 'true'

export async function chapterVideo(runtime: ProjectRuntime, chapterId: string): Promise<ChapterVideo | undefined> {
  const record = await runtime.project.readState<ChapterVideo>(STATE, `${chapterId}.json`)
  if (record === undefined || !(await runtime.project.has(record.path))) return undefined
  return record
}

/** Delete a chapter's video: the file, and the record of it. What it was cut from is untouched. */
export async function removeVideo(runtime: ProjectRuntime, chapterRef: string): Promise<{ chapterId: string; removed: boolean }> {
  const { project } = runtime
  const chapter = await project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  const record = await project.readState<ChapterVideo>(STATE, `${chapter.plan.id}.json`)
  if (record === undefined) return { chapterId: chapter.plan.id, removed: false }
  if (record.path.startsWith('assets/')) await project.removeAsset(record.path.slice('assets/'.length)).catch(() => false)
  // The copy of its words goes with it.
  if (record.subtitles?.path?.startsWith('assets/') === true) await project.removeAsset(record.subtitles.path.slice('assets/'.length)).catch(() => false)
  await project.removeState(STATE, `${chapter.plan.id}.json`)
  return { chapterId: chapter.plan.id, removed: true }
}

export interface VideoReadiness {
  ffmpeg: boolean
  /** The model post-production would run on can drive an agent. */
  agent: boolean
  model?: string
  /** Why the chapter cannot be cut yet, in words for the author; absent when it can. */
  blocked?: string
  /** What there is to cut from. */
  counts?: VideoMaterials['counts'] & { seconds: number }
}

/** Whether a video of a chapter can be made right now, and from what. */
export async function videoReadiness(core: NovelCore, runtime: ProjectRuntime, chapterRef: string, task: Pick<TaskContext, 'agentRoute'> = {}): Promise<VideoReadiness> {
  const [ffmpeg, ffprobe] = await Promise.all([findProgram('ffmpeg'), findProgram('ffprobe')])
  let model: string | undefined
  let agent = false
  try {
    const route = await core.route('producer', runtime, task)
    model = route.model
    agent = core.roles?.can(route) === true
  } catch {
    agent = false
  }
  const base = { ffmpeg: ffmpeg !== undefined && ffprobe !== undefined, agent, ...(model !== undefined ? { model } : {}) }
  try {
    const materials = await videoMaterials(core, runtime, chapterRef)
    return { ...base, counts: { ...materials.counts, seconds: materials.duration } }
  } catch (error) {
    if (error instanceof ProjectError) return { ...base, blocked: error.message }
    throw error
  }
}

/** What the Studio itself lays into a working directory; anything else there is the work of an earlier cut. */
const LAID_OUT = new Set(['materials.json', 'voice.wav', 'subtitles.srt', 'panels.tsv', 'cues.tsv', 'cut-base.sh', 'check'])

/**
 * What earlier cuts of the chapter left in its working directory — scripts,
 * clips, words drawn as pictures — by name, a folder with how much is in it.
 * A cut that ran out of its budget has done work the next one can stand on.
 */
export async function leftBehind(workdir: string): Promise<string[]> {
  const entries = await readdir(workdir, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (LAID_OUT.has(entry.name) || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      const inside = await readdir(join(workdir, entry.name)).catch(() => [])
      if (inside.length > 0) found.push(`${entry.name}/ (${inside.length})`)
    } else if (entry.isFile()) {
      // A file with nothing in it is a cut that never got written.
      const info = await stat(join(workdir, entry.name)).catch(() => undefined)
      if (info !== undefined && info.size > 0) found.push(entry.name)
    }
  }
  return found
}

function brief(materials: VideoMaterials, manifestPath: string, zh: boolean, direction: string | undefined, subtitles: boolean, left: string[] = []): string {
  const { counts } = materials
  const minutes = `${Math.floor(materials.duration / 60)}:${String(Math.round(materials.duration % 60)).padStart(2, '0')}`
  return zh
    ? `把《${materials.book.title.replace(/^[《「『“"]+|[》」』”"]+$/gu, '')}》第 ${materials.chapter.index} 章《${materials.chapter.title}》剪成一段视频（有声漫）。

## 素材
素材清单在 ${manifestPath}（JSON）。先读它——里面是一条排好时间的时间线：
- lines：${materials.lines.length} 句，按顺序讲述，共 ${minutes}（${materials.duration.toFixed(1)} 秒）。每句有 start / end（秒）、说话人、文字；${counts.spoken} 句有配音（audio 是 WAV 的绝对路径）${counts.silent > 0 ? `，${counts.silent} 句没有配音——按它的时长静默停留，把文字显示出来` : ''}。句与句之间的停顿已经算在 start 里。
- panels：${materials.panels.length} 格分镜，各自的 start / end、画面路径（image）、画面说明和镜头运动（camera：still / zoom-in / zoom-out / pan-*）。${counts.undrawn > 0 ? `其中 ${counts.undrawn} 格没有画出来（没有 image）——用相邻的画面、封面或文字卡顶上，不要黑屏。` : ''}${materials.panels.length === 0 ? '这一章没有分镜：用 extras 里的图（封面、插图、人物立绘）自己安排画面。' : ''}
- cues：${materials.cues.length} 处声音提示（bed 环境底、music 配乐、effect 音效），${counts.clips} 处有生成好的音频（audio）；没有 audio 的可以略过。
- extras：封面和这本书的其他插图，片头片尾可以用。
同一份素材还按命令行顺手的形式放在工作目录里：voice.wav（整轨配音——每一句已经放在时间线上它该在的位置，没有配音的句子是静音）、subtitles.srt（按句切好的字幕）、panels.tsv（序号、start、end、时长、camera、图片路径、画面说明，制表符分隔）、cues.tsv（kind、start、end、音频时长、强度、音频路径、说明），还有一份基础脚本 cut-base.sh——在工作目录里运行 bash cut-base.sh out.mp4 就能按这些文件剪出朴素的第一版。
素材只读。你只在工作目录 ${materials.workdir} 里写文件（脚本、中间文件、成片）。${left.length > 0 ? `\n工作目录里还有以前剪这一章时留下的东西：${left.join('、')}——合用就接着用，不合用就不管它。` : ''}

## 要什么
一个能直接播放的 MP4：H.264（yuv420p）+ AAC，${materials.frame.width}×${materials.frame.height}、${materials.frame.fps} fps 左右，带 faststart。画面按时间线换，静态图要有缓慢的镜头运动（按 camera），换画面处可以有短的交叉淡化；配音按时间线对齐，环境声和配乐压在配音下面（配音响的时候把它们压低），音效落在它的时间点上。${subtitles ? '字幕（必须有）：作者要观众看得到台词和旁白，按 subtitles.srt 的时间出现。最好画进画面——字大、有描边、手机上看得清——这样成片发到哪里字都在；这台电脑上实在画不进去，就把 subtitles.srt 作为字幕轨带在成片里（工坊的播放器会显示这条轨，别的播放器在字幕菜单里能选）。两样都没有的成片交不上去；字画进了画面的，检查和提交时说明 burned=true。片头让时间线后移了多少，字幕要一起后移多少。用什么办法由你定。' : '作者不要字幕：画面里不放字幕，也不带字幕轨。'}片头可以有一张标题卡，不要超过 4 秒。
${direction !== undefined ? `\n作者的要求：${direction}\n` : ''}
## 怎么交
1. 做出成片后，先用 video_check 检查（时长、音画流、是否黑屏、是否静音，还会抽几帧放在工作目录的 check/ 里——你的模型能看图的话，用 read_image 看一眼）。
2. 检查有问题就改，再检查。
3. 通过后用 video_submit 提交成片的路径，并用一两句话告诉作者你是怎么剪的。不通过检查的成片交不上去。`
    : `Cut chapter ${materials.chapter.index}, "${materials.chapter.title}", of "${materials.book.title}" into a video (a motion comic with sound).

## Material
The material list is at ${manifestPath} (JSON). Read it first — it is one timeline, already timed:
- lines: ${materials.lines.length} lines told in order, ${minutes} in all (${materials.duration.toFixed(1)} s). Each has start / end (seconds), a speaker and its text; ${counts.spoken} have a voice (audio is the absolute path of a WAV)${counts.silent > 0 ? `, ${counts.silent} have none — hold them in silence for their length and show their text` : ''}. The pauses between lines are already in the start times.
- panels: ${materials.panels.length} storyboard panels with start / end, the picture's path (image), what it shows and its camera move (still / zoom-in / zoom-out / pan-*). ${counts.undrawn > 0 ? `${counts.undrawn} of them were never drawn (no image) — cover them with a neighbouring picture, the cover or a text card; never black.` : ''}${materials.panels.length === 0 ? 'This chapter has no storyboard: arrange the picture yourself from the images in extras (cover, illustrations, portraits).' : ''}
- cues: ${materials.cues.length} sound cues (bed, music, effect), ${counts.clips} of them with a generated clip (audio); a cue without audio may be left out.
- extras: the cover and other pictures of the book, for a title or an end card.
The same material lies in the working directory in forms a shell takes easily: voice.wav (the whole telling as one track — every line already where the timeline puts it, silence for a line without a voice), subtitles.srt (the lines cut for the screen), panels.tsv (number, start, end, length, camera, picture path, description; tab-separated), cues.tsv (kind, start, end, clip length, intensity, audio path, caption), and a base script, cut-base.sh — running bash cut-base.sh out.mp4 in the working directory makes a plain first cut from these files.
The material is read-only. Write only inside the working directory ${materials.workdir} (scripts, intermediate files, the result).${left.length > 0 ? `\nThe working directory also holds what earlier cuts of this chapter left behind: ${left.join(', ')} — build on it where it serves, leave it where it does not.` : ''}

## What is wanted
An MP4 that plays as it is: H.264 (yuv420p) + AAC, about ${materials.frame.width}×${materials.frame.height} at ${materials.frame.fps} fps, with faststart. The picture changes by the timeline; a still gets a slow camera move (per camera), and a short cross-fade where pictures change is welcome; the voice sits where the timeline puts it, beds and music under it (ducked while a voice speaks), an effect at its moment. ${subtitles ? 'Subtitles (required): the author wants the viewer to see the lines, at the times of subtitles.srt. Best drawn into the picture — large, outlined, readable on a phone — so the words go wherever the file goes; where this computer truly cannot do that, carry subtitles.srt in the file as a subtitle track (the Studio\'s player shows that track; other players offer it in their subtitle menu). A cut with neither cannot be handed in; when the words are in the picture, say burned=true as you check and hand in. Shift them by as much as a title card moved the timeline. How you do it is yours to decide.' : 'The author wants no subtitles: none in the picture, and no subtitle track.'} A title card may open it, four seconds at most.
${direction !== undefined ? `\nThe author asks: ${direction}\n` : ''}
## Handing in
1. With a result, run video_check first (length, streams, black frames, silence; it also leaves a few stills in check/ under the working directory — look at them with read_image if your model sees pictures).
2. Correct what it finds, and check again.
3. When it passes, hand the file's path in with video_submit and tell the author in a sentence or two how you cut it. A video that fails the checks cannot be handed in.`
}

export interface VideoResult {
  video: ChapterVideo
  /** What post-production said about its cut. */
  report: string
  steps?: number
}

/**
 * A WebVTT copy of a video's subtitle track, beside the video: what a web player shows.
 * @returns the project-relative path, or undefined when the file carries no track or it would not come out.
 */
async function subtitleCopy(runtime: ProjectRuntime, video: string, signal?: AbortSignal): Promise<string | undefined> {
  const ffmpeg = await findProgram('ffmpeg')
  if (ffmpeg === undefined) return undefined
  const { project } = runtime
  const target = video.replace(/\.[^.]+$/, '.vtt')
  // Read out to a file of its own first: a sealed book's files are not something ffmpeg can write into.
  const scratch = join(tmpdir(), `novel-subs-${process.pid}-${Date.now()}.vtt`)
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', project.path(video), '-map', '0:s:0', '-f', 'webvtt', scratch], { timeoutMs: 120_000, ...(signal !== undefined ? { signal } : {}) })
    const text = await readFile(scratch, 'utf8')
    if (!text.includes('-->')) return undefined
    await project.writeFile(target, text)
    return target
  } catch {
    return undefined
  } finally {
    await rm(scratch, { force: true }).catch(() => {})
  }
}

/**
 * The video of a chapter, with the subtitles a player can show: a video cut
 * before the Studio kept a copy of them gets one the first time it is asked for.
 */
export async function chapterVideoWithSubtitles(runtime: ProjectRuntime, chapterId: string): Promise<ChapterVideo | undefined> {
  const video = await chapterVideo(runtime, chapterId)
  if (video === undefined || video.subtitles !== undefined) return video
  const path = await subtitleCopy(runtime, video.path).catch(() => undefined)
  // Said either way, so that a file with no track is not probed again at every look.
  const next: ChapterVideo = { ...video, subtitles: { ...(path !== undefined ? { path } : {}), burned: false } }
  await runtime.project.writeState([STATE, `${chapterId}.json`], next).catch(() => {})
  return next
}

/**
 * Have post-production cut a chapter's video.
 * @param params.subtitles - false: the author wants no subtitles. Otherwise the cut has to bring the lines to the viewer; how is post-production's to decide.
 * @throws ProjectError when the chapter has nothing to cut from or the tools are missing; LlmCallError when the agent could not run or handed nothing in.
 */
export async function produceVideo(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; direction?: string; subtitles?: boolean }, task: TaskContext): Promise<VideoResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  if (await findProgram('ffmpeg') === undefined || await findProgram('ffprobe') === undefined) {
    throw new ProjectError('novel/unsupported', L(lang, `剪视频需要 ffmpeg 和 ffprobe，这台电脑上没有找到。装上后重试——${FFMPEG_INSTALL[0]}。`, `Cutting a video needs ffmpeg and ffprobe, and neither was found on this computer. Install it and try again — ${FFMPEG_INSTALL[1]}.`))
  }
  task.job?.progress(0, 3, L(lang, '整理素材', 'laying out the material'))
  const { manifest: manifestPath, materials } = await writeMaterials(runtime, await videoMaterials(core, runtime, params.chapter))
  const left = await leftBehind(materials.workdir)

  const inside = (path: string): string => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(materials.workdir, path)
    const within = relative(project.root, absolute)
    if (within.startsWith('..') || isAbsolute(within)) throw new Error(`${path} is outside the book — the result belongs in ${materials.workdir}`)
    return absolute
  }
  let taken: { video: ChapterVideo; note: string } | undefined
  /** A cut has passed the checks: there is something to hand in, whatever happens after. */
  let passed = false
  // A cut of a telling has its words under it unless the author said otherwise — and only where there are words.
  const wantSubtitles = params.subtitles !== false && materials.lines.length > 0
  const tools: RoleTool[] = [
    {
      name: 'video_check',
      description: 'Measure a video you made against this chapter\'s material: its length against the telling, whether it has picture and sound, how loud the sound is, how much of the picture is black, whether it carries a subtitle track; a few stills are left in check/ under the working directory. Run it on every result before handing in.',
      parameters: {
        path: { type: 'string', required: true, description: 'The video file: absolute, or relative to the working directory.' },
        burned: { type: 'boolean', description: 'true when the subtitles are drawn into the picture.' },
        offset: { type: 'number', description: 'Seconds the telling begins after the start of the video (a title card before it). The stills are then taken where the lines are, each with the words that should be on the picture.' },
      },
      async run(args) {
        const path = argText(args.path)
        if (path === undefined) throw new Error('`path` is required')
        try {
          const wanted = { subtitles: wantSubtitles, burned: said(args.burned) }
          const lead = Number(args.offset)
          // Where the words are in the picture, the stills are taken where the words should be — and where they should not.
          const marks = wantSubtitles ? stillMarks(materials.lines, Number.isFinite(lead) && lead > 0 ? lead : 0) : []
          const probe = await probeVideo(inside(path), { stills: join(materials.workdir, 'check'), ...(marks.length > 0 ? { at: marks.map(mark => mark.at) } : {}), ...(task.signal !== undefined ? { signal: task.signal } : {}) })
          const faults = videoFaults(probe, materials, zh, wanted)
          if (faults.length === 0) passed = true
          return describeProbe(probe, materials, zh, wanted, faults, marks)
        } catch (error) {
          if (error instanceof ProjectError) throw new Error(error.message)
          throw error
        }
      },
    },
    {
      name: 'video_submit',
      description: 'Hand in the finished video of this chapter. It is measured once more; a video that fails the checks is refused with what is wrong. Taken, it becomes the chapter\'s video in the Studio, and the work is done.',
      parameters: {
        path: { type: 'string', required: true, description: 'The finished video file: absolute, or relative to the working directory.' },
        note: { type: 'string', required: true, description: 'For the author, one or two sentences: how it was cut, and anything they should know (what was missing, what you chose).' },
        burned: { type: 'boolean', description: 'true when the subtitles are drawn into the picture: a player then leaves a subtitle track of the file off, so the words are not shown twice.' },
      },
      closing: true,
      final: true,
      async run(args) {
        const path = argText(args.path)
        if (path === undefined) throw new Error('`path` is required')
        const source = inside(path)
        let probe: VideoProbe
        try {
          probe = await probeVideo(source, { ...(task.signal !== undefined ? { signal: task.signal } : {}) })
        } catch (error) {
          if (error instanceof ProjectError) throw new Error(error.message)
          throw error
        }
        const burned = said(args.burned)
        const faults = videoFaults(probe, materials, zh, { subtitles: wantSubtitles, burned })
        if (faults.length > 0) throw new Error(`${zh ? '这段视频还不能收' : 'This video cannot be taken yet'}:\n${faults.map(fault => `- ${fault}`).join('\n')}`)
        const target = project.path('assets', 'video', `${materials.chapter.id}.mp4`)
        await mkdir(dirname(target), { recursive: true })
        if (resolve(source) !== resolve(target)) await copyFile(source, target)
        const note = argText(args.note) ?? ''
        // What a web player shows: it shows nothing of a track inside an MP4, so the Studio keeps the track's words beside the file.
        const copy = probe.subtitles !== undefined ? await subtitleCopy(runtime, project.relative(target), task.signal) : undefined
        const video: ChapterVideo = {
          schema: 1,
          chapterId: materials.chapter.id,
          path: project.relative(target),
          duration: probe.duration,
          width: probe.video!.width,
          height: probe.video!.height,
          size: probe.size,
          createdAt: new Date().toISOString(),
          ...(note.length > 0 ? { note } : {}),
          material: materials.counts,
          subtitles: { ...(copy !== undefined ? { path: copy } : {}), burned },
        }
        await project.writeState([STATE, `${materials.chapter.id}.json`], video)
        taken = { video, note }
        return zh ? '收下了：它现在是这一章的视频。' : 'Taken: it is the chapter\'s video now.'
      },
    },
  ]

  task.job?.progress(1, 3, L(lang, '后期在剪', 'post-production is cutting'))
  const done = await delegate(core, runtime, task, {
    role: 'producer',
    label: L(lang, `第${materials.chapter.index}章 · 成片`, `Ch. ${materials.chapter.index} · video`),
    line: await runtime.project.lineOf(materials.chapter.id),
    task: brief(materials, manifestPath, zh, params.direction, wantSubtitles, left),
    tools,
    handIn: 'video_submit',
    // Said while there are calls left to act on it: a cut that passes is worth more than a better one that does not exist.
    budgetNote: () => passed || taken !== undefined ? undefined : L(lang, '到现在还没有任何一版通过 video_check。先用剩下的额度做出一版能通过检查的成片——基础脚本能直接剪出一版——有了它再去打磨。', 'No cut has passed video_check so far. Use what is left to get one that passes first — the base script cuts one as it is — and refine after that.'),
    unfinished: () => taken === undefined ? L(lang, '成片还没有提交：做出来了就先 video_check、再 video_submit；确实做不出来，说明卡在哪里。', 'The video has not been handed in: with a result, run video_check and then video_submit; if it truly cannot be made, say where it is stuck.') : undefined,
  })
  const accepted = taken as { video: ChapterVideo; note: string } | undefined
  if (accepted === undefined) {
    throw new LlmCallError(L(lang, `后期没有交出成片（${done.stop}，${done.run.steps ?? 0} 步）${done.report.length > 0 ? `。它最后说：“${clip(done.report.replace(/\s+/g, ' '), 300)}”` : ''}。它的全过程可以在对话标题栏的子 agent 列表里打开；工作目录是 ${project.relative(materials.workdir)}。`, `Post-production handed in no video (${done.stop}, ${done.run.steps ?? 0} steps)${done.report.length > 0 ? `. Its last words: "${clip(done.report.replace(/\s+/g, ' '), 300)}"` : ''}. Its whole run can be opened from the list of agents in the conversation's header; the working directory is ${project.relative(materials.workdir)}.`), 'NO_DELIVERY')
  }
  task.job?.progress(3, 3, L(lang, '成片已收', 'video taken'))
  await project.addActivity({ by: 'crew', role: 'producer', tool: 'video', summary: L(lang, `剪出了第${materials.chapter.index}章的视频（${accepted.video.duration.toFixed(0)} 秒）${accepted.note.length > 0 ? `：${clip(accepted.note, 120)}` : ''}`, `Cut the video of chapter ${materials.chapter.index} (${accepted.video.duration.toFixed(0)} s)${accepted.note.length > 0 ? `: ${clip(accepted.note, 120)}` : ''}`), chapter: materials.chapter.id }).catch(() => {})
  task.job?.result({ chapterId: materials.chapter.id, video: accepted.video.path })
  return { video: accepted.video, report: accepted.note, ...(done.run.steps !== undefined ? { steps: done.run.steps } : {}) }
}

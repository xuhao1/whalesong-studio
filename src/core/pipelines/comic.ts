// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Motion comic: the audio drama of a chapter gets pictures. A storyboard pass
 * arranges the script into panels and writes one image prompt per panel; the
 * player then holds each panel on screen (with a slow camera move) for exactly
 * as long as what it covers takes to play. Panels reuse each character's
 * visual DNA and the project's art direction.
 *
 * How finely a chapter is cut is the author's call: a density (`sparse`,
 * `balanced`, `dense`) names how long a picture stays on average, `auto`
 * leaves the count to the director, and `maxPanels` is a ceiling that holds
 * whatever the director does. A panel may begin and end inside a long line,
 * so a half-minute of narration is not one frozen picture.
 */
import type { AudioLine, CameraMove, CharacterCard, ComicBoard, ComicPanel, StoryboardDensity } from '../../shared/types'
import { PANEL_SECONDS, STORYBOARD_DENSITIES } from '../../shared/types'
import { clip, hashText, newId, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText, completeJson } from '../llm'
import { speechUnits } from '../media/voiceprint'
import { ProjectError } from '../project'
import { storyboardTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { mapLimit, serializer } from '../util/async'
import { buildAudioScript } from './audio'
import { MAX_REFERENCES } from '../media/image'
import { artDirectionOf, consistencyFor, looksOf, placeNamed, renderImage, requireImages } from './illustrate'

const CAMERAS: CameraMove[] = ['still', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down']

/** The smallest piece of the script a panel may cover: a short line whole, a long one sentence by sentence. */
export interface Beat {
  /** Index of the line in the script. */
  line: number
  /** Where in the line it starts and ends, as fractions of the line. */
  from: number
  to: number
  text: string
  /** About how long it takes to play. */
  seconds: number
}

/** A line longer than this many syllables may be cut inside. */
const BEAT_SPLIT = 45
/** No piece of a split line is shorter than this: about two and a half seconds of speech. */
const BEAT_MIN = 12

/** Cut the script into beats, with the time each takes: measured where the line is voiced, estimated where it is not. */
export function beatsOf(lines: AudioLine[]): Beat[] {
  const beats: Beat[] = []
  lines.forEach((line, index) => {
    const units = Math.max(1, speechUnits(line.text))
    // Unvoiced lines are timed at reading pace, with a breath after each.
    const seconds = line.duration !== undefined && line.duration > 0 ? line.duration : units * 0.21 + 0.3
    const pieces: { from: number; to: number }[] = []
    if (units > BEAT_SPLIT) {
      const sentences = line.text.match(/[^。！？!?…\n]+[。！？!?…]*["”’」』）)]*\s*|\n+/g) ?? [line.text]
      let start = 0
      let cursor = 0
      let held = 0
      for (const sentence of sentences) {
        cursor += sentence.length
        held += speechUnits(sentence)
        if (held >= BEAT_MIN) {
          pieces.push({ from: start, to: cursor })
          start = cursor
          held = 0
        }
      }
      // What is left over is too short to be a shot of its own: it stays with the last one.
      if (start < line.text.length) {
        if (pieces.length > 0) pieces[pieces.length - 1]!.to = line.text.length
        else pieces.push({ from: 0, to: line.text.length })
      }
    }
    if (pieces.length < 2) {
      beats.push({ line: index, from: 0, to: 1, text: line.text, seconds })
      return
    }
    const length = line.text.length
    for (const piece of pieces) {
      beats.push({ line: index, from: piece.from / length, to: piece.to / length, text: line.text.slice(piece.from, piece.to).trim(), seconds: seconds * (piece.to - piece.from) / length })
    }
  })
  return beats
}

export { PANEL_SECONDS }
/** With `auto`, the director stays between these. */
const AUTO_LONGEST = 40
const AUTO_SHORTEST = 4
/** Beats sent to the director in one request: enough to see a scene whole, few enough that the reply stays short. */
const WINDOW = 48

export interface PanelPlan {
  density: StoryboardDensity
  maxPanels?: number
  /** How many panels the board is aimed at; with `auto`, the middle of what the director may choose. */
  target: number
  /** The fewest and most the director is asked for. */
  low: number
  high: number
}

/** Turn a density and a ceiling into numbers for a script of this length. */
export function planPanels(beats: Beat[], density: StoryboardDensity, maxPanels?: number): PanelPlan {
  const total = beats.reduce((sum, beat) => sum + beat.seconds, 0)
  const ceiling = Math.max(1, Math.min(beats.length, maxPanels !== undefined && maxPanels > 0 ? Math.floor(maxPanels) : beats.length))
  const within = (count: number): number => Math.max(1, Math.min(ceiling, Math.round(count)))
  const limit = maxPanels !== undefined && maxPanels > 0 ? { maxPanels: Math.floor(maxPanels) } : {}
  if (density === 'auto') {
    const low = within(Math.ceil(total / AUTO_LONGEST))
    const high = within(Math.max(low, Math.floor(total / AUTO_SHORTEST)))
    return { density, ...limit, target: within((low + high) / 2), low, high }
  }
  const target = within(total / PANEL_SECONDS[density])
  return { density, ...limit, target, low: within(target * 0.75), high: within(Math.max(target, target * 1.3)) }
}

interface DraftPanel {
  /** Beat indexes, inclusive. */
  from: number
  to: number
  description: string
  prompt: string
  camera: CameraMove
  characters: string[]
  location?: string
}

export async function buildStoryboard(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; density?: StoryboardDensity; maxPanels?: number; force?: boolean }, task: TaskContext): Promise<ComicBoard> {
  const { project } = runtime
  const script = await buildAudioScript(core, runtime, { chapter: params.chapter }, task)
  const existing = await project.comicBoard(script.chapterId)
  if (existing !== undefined && existing.textHash === script.textHash && params.force !== true) return existing
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const characters = await project.characters()
  const world = await project.world()
  const direction = await artDirectionOf(core, runtime)
  const art = direction.style
  const speakers = new Set(script.lines.map(line => line.speaker).filter((id): id is string => id !== undefined))
  const text = script.lines.map(line => line.text).join('\n')
  const cast = characters.filter(card => speakers.has(card.id) || text.includes(card.name))
  const locations = world.filter(entry => entry.category === 'location' && text.includes(entry.name))
  // The call's own wish, else the book's, else a picture every dozen seconds or so.
  const wished = params.density ?? manifest.storyboard?.density
  const density: StoryboardDensity = wished !== undefined && STORYBOARD_DENSITIES.includes(wished) ? wished : 'balanced'
  const beats = beatsOf(script.lines)
  const plan = planPanels(beats, density, params.maxPanels ?? manifest.storyboard?.maxPanels)
  const total = beats.reduce((sum, beat) => sum + beat.seconds, 0)
  const route = await core.route('analyst', runtime, task)
  const castText = cast.map(card => `${card.name}: ${looksOf(card) || L(lang, '（未设定外貌）', '(no look defined)')}`).join('\n')
  const placeText = locations.map(entry => `${entry.name}: ${entry.visualPrompt ?? entry.summary ?? ''}`).join('\n')
  const speakerOf = (line: AudioLine): string => line.kind === 'narration' ? L(lang, '旁白', 'narrator') : (line.speakerName ?? '?')

  // One window of the script per request; each is asked for its share of the panels.
  const windows: { start: number; beats: Beat[] }[] = []
  for (let start = 0; start < beats.length; start += WINDOW) windows.push({ start, beats: beats.slice(start, start + WINDOW) })
  let finished = 0
  let early = 0
  task.job?.progress(0, windows.length, L(lang, `编排分镜（目标约 ${plan.target} 格）`, `storyboarding (about ${plan.target} panels)`))

  const boarded = await mapLimit(windows, 2, async (window) => {
    const drafts: DraftPanel[] = []
    let cursor = 0
    // A director that stops before the end of the passage is asked for the rest, not papered over.
    for (let round = 0; round < 4 && cursor < window.beats.length; round++) {
      const rest = window.beats.slice(cursor)
      const share = rest.reduce((sum, beat) => sum + beat.seconds, 0) / Math.max(1, total)
      const scaled = (count: number): number => Math.max(1, Math.min(rest.length, Math.round(count * share)))
      const low = scaled(plan.low)
      const high = Math.max(low, scaled(plan.high))
      const target = Math.max(low, Math.min(high, scaled(plan.target)))
      const count = density === 'auto'
        ? L(lang,
            `画面数量由你决定：该换画面的地方就换，平静的叙述可以停得久一些，一般每个画面停留 5–20 秒。这一段不少于 ${low} 个、不多于 ${high} 个画面。`,
            `You decide how many panels: cut wherever the picture should change; calm narration may hold longer. A panel usually stays 5-20 seconds. For this passage: no fewer than ${low}, no more than ${high}.`)
        : L(lang,
            `这一段大约 ${target} 个画面（${low}–${high} 个之间），平均每个画面停留约 ${Math.round(PANEL_SECONDS[density])} 秒。`,
            `About ${target} panels for this passage (between ${low} and ${high}); a panel stays about ${Math.round(PANEL_SECONDS[density])} seconds on average.`)
      const last = drafts.at(-1)
      let asked = 0
      const { value } = await completeJson(core.llm, {
        route,
        prompt: storyboardTask({
          lang,
          language: manifest.language,
          title: manifest.title,
          units: rest.map((beat, index) => `${index} | ${speakerOf(script.lines[beat.line]!)} | ${Math.max(1, Math.round(beat.seconds))}s | ${clip(beat.text, 140)}`).join('\n'),
          cast: castText,
          locations: placeText,
          artStyle: art,
          avoid: direction.avoid,
          count,
          ...(last !== undefined ? { previous: last.description } : {}),
        }),
        temperature: 0.5,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
        validate: (raw) => {
          asked += 1
          const found: DraftPanel[] = []
          let at = 0
          for (const entry of asArray(asRecord(raw).panels)) {
            const item = asRecord(entry)
            const prompt = asText(item.prompt)
            if (prompt === undefined || at >= rest.length) continue
            // Panels must tile the passage: each one starts where the previous ended, whatever the model claimed.
            const to = Math.max(at, Math.min(rest.length - 1, Number.isFinite(Number(item.to)) ? Number(item.to) : at))
            const camera = asText(item.camera) as CameraMove | undefined
            const location = asText(item.location)
            found.push({
              from: at,
              to,
              description: asText(item.description) ?? clip(prompt, 60),
              prompt,
              camera: camera !== undefined && CAMERAS.includes(camera) ? camera : 'zoom-in',
              characters: asList(item.characters),
              ...(location !== undefined ? { location } : {}),
            })
            at = to + 1
          }
          if (found.length === 0) throw new Error('"panels" is empty')
          // Asked once more when fewer came back than the least that was asked for; what the second answer brings is taken as it is.
          if (asked === 1 && found.length < low) {
            throw new Error(`only ${found.length} panel(s) for a passage that needs about ${target} (no fewer than ${low}) — cut it into more panels, and cover every unit through to index ${rest.length - 1}`)
          }
          return { panels: found, covered: at }
        },
      })
      for (const panel of value.panels) drafts.push({ ...panel, from: panel.from + cursor, to: panel.to + cursor })
      if (value.covered < rest.length) early += 1
      cursor += value.covered
    }
    // Still short of the end after asking for the rest: the last picture holds through what is left.
    if (drafts.length > 0 && cursor < window.beats.length) drafts[drafts.length - 1]!.to = window.beats.length - 1
    finished += 1
    task.job?.progress(finished, windows.length)
    return drafts.map(panel => ({ ...panel, from: panel.from + window.start, to: panel.to + window.start }))
  }, task.signal)

  let drafts = boarded.flat()
  if (drafts.length === 0) throw new ProjectError('novel/empty', 'the storyboard pass produced no usable panel')
  // The ceiling is the author's and holds whatever the director did: the shortest neighbours share a picture until it does.
  const secondsOf = (panel: DraftPanel): number => beats.slice(panel.from, panel.to + 1).reduce((sum, beat) => sum + beat.seconds, 0)
  const directed = drafts.length
  if (plan.maxPanels !== undefined) {
    while (drafts.length > plan.maxPanels) {
      let best = 0
      let least = Infinity
      for (let index = 0; index < drafts.length - 1; index++) {
        const span = secondsOf(drafts[index]!) + secondsOf(drafts[index + 1]!)
        if (span < least) {
          least = span
          best = index
        }
      }
      const kept = drafts[best]!
      const gone = drafts[best + 1]!
      drafts = [...drafts.slice(0, best), { ...kept, to: gone.to, characters: [...new Set([...kept.characters, ...gone.characters])] }, ...drafts.slice(best + 2)]
    }
  }

  const panels: ComicPanel[] = drafts.map((draft) => {
    const first = beats[draft.from]!
    const last = beats[draft.to]!
    const present = draft.characters.map(name => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)?.id).filter((id): id is string => id !== undefined)
    return {
      id: newId('pn'),
      lines: script.lines.slice(first.line, last.line + 1).map(line => line.id),
      ...(first.from > 0.001 ? { begin: Number(first.from.toFixed(4)) } : {}),
      ...(last.to < 0.999 ? { end: Number(last.to.toFixed(4)) } : {}),
      description: draft.description,
      prompt: draft.prompt,
      camera: draft.camera,
      ...(present.length > 0 ? { characters: [...new Set(present)] } : {}),
      ...(draft.location !== undefined ? { location: draft.location } : {}),
    }
  })
  // Pictures already rendered for an identical prompt are kept across re-boards.
  if (existing !== undefined) {
    const rendered = new Map(existing.panels.filter(panel => panel.image !== undefined).map(panel => [panel.prompt, panel.image!]))
    for (const panel of panels) {
      const image = rendered.get(panel.prompt)
      if (image !== undefined) panel.image = image
    }
  }
  const notes = [
    directed > panels.length ? L(lang, `导演排了 ${directed} 格，超过了上限 ${plan.maxPanels}，已把最短的相邻画面合并`, `the director cut ${directed} panels, over the ceiling of ${plan.maxPanels}; the shortest neighbours were merged`) : undefined,
    density !== 'auto' && panels.length < Math.floor(plan.low * 0.6) ? L(lang, `只排出 ${panels.length} 格，少于这个密度该有的约 ${plan.target} 格；可以重做一次，或把密度调得更细`, `only ${panels.length} panels came out, fewer than the ${plan.target} or so this density calls for; redo it, or choose a finer density`) : undefined,
  ].filter((note): note is string => note !== undefined)
  if (early > 0) core.log(`the storyboard director stopped early ${early} time(s) on ${script.chapterId}; the rest was asked for again`)
  const board: ComicBoard = {
    schema: 1,
    chapterId: script.chapterId,
    textHash: script.textHash,
    updatedAt: new Date().toISOString(),
    style: art,
    panels,
    density,
    ...(plan.maxPanels !== undefined ? { maxPanels: plan.maxPanels } : {}),
    ...(notes.length > 0 ? { note: notes.join(L(lang, '；', '; ')) } : {}),
  }
  await project.saveComicBoard(board)
  task.job?.result({ chapterId: board.chapterId, panels: panels.length })
  return board
}

export interface RenderPanelsResult {
  chapterId: string
  panels: number
  rendered: number
  failed: number
}

/** Draw the panels of a chapter's storyboard that have no picture yet. */
export async function renderPanels(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; panels?: string[]; force?: boolean; concurrency?: number }, task: TaskContext): Promise<RenderPanelsResult> {
  const { project } = runtime
  await requireImages(core)
  let board = await buildStoryboard(core, runtime, { chapter: params.chapter }, task)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // The book's art direction as it stands now — not the copy the storyboard was drawn up with.
  const art = await artDirectionOf(core, runtime, { pin: true })
  const characters = await project.characters()
  const world = await project.world()
  const wanted = params.panels !== undefined ? new Set(params.panels) : undefined
  const todo = board.panels.filter(panel => (wanted === undefined || wanted.has(panel.id)) && (params.force === true || panel.image === undefined))
  let rendered = 0
  let failed = 0
  let done = 0
  task.job?.progress(0, todo.length, L(lang, '绘制画面', 'drawing panels'))
  const updates = new Map<string, Partial<ComicPanel>>()
  const inOrder = serializer()
  const flush = (): Promise<void> => inOrder(async () => {
    if (updates.size === 0) return
    board = {
      ...board,
      updatedAt: new Date().toISOString(),
      panels: board.panels.map((panel) => {
        const update = updates.get(panel.id)
        if (update === undefined) return panel
        const next = { ...panel, ...update }
        if (update.image !== undefined) delete next.error
        return next
      }),
    }
    updates.clear()
    await project.saveComicBoard(board)
  })
  await mapLimit(todo, Math.max(1, Math.min(4, params.concurrency ?? 2)), async (panel) => {
    try {
      // Whoever is in the panel brings their design sheet, and the place its reference art.
      const shown = (panel.characters ?? []).map(id => characters.find(card => card.id === id)).filter((card): card is CharacterCard => card !== undefined)
      const consistency = consistencyFor(shown)
      const place = placeNamed(world, panel.location)
      const info = await renderImage(core, runtime, {
        subject: panel.prompt,
        kind: 'panel',
        target: board.chapterId,
        size: '1280x720',
        name: `panel-${board.chapterId}-${hashText(panel.id).slice(0, 4)}`,
        record: false,
        art,
        avoid: consistency.avoid,
        references: place?.visualImage !== undefined
          ? [...consistency.references.slice(0, MAX_REFERENCES - 1), { path: place.visualImage, label: L(lang, `场所「${place.name}」`, `the place "${place.name}"`) }]
          : consistency.references,
      }, task)
      updates.set(panel.id, { image: info.path })
      rendered += 1
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      updates.set(panel.id, { error: error instanceof Error ? error.message : String(error) })
      failed += 1
    }
    done += 1
    task.job?.progress(done, todo.length)
    await flush()
  }, task.signal)
  task.job?.result({ chapterId: board.chapterId, rendered, failed })
  return { chapterId: board.chapterId, panels: board.panels.length, rendered, failed }
}

/** Change one panel of a chapter's storyboard by hand; a new prompt drops the old picture. */
export async function updateComicPanel(runtime: ProjectRuntime, chapterRef: string, panelId: string, patch: Partial<Pick<ComicPanel, 'prompt' | 'description' | 'camera'>>): Promise<ComicBoard> {
  const { project } = runtime
  const located = await project.findChapter(chapterRef)
  const board = located !== undefined ? await project.comicBoard(located.plan.id) : undefined
  if (board === undefined) throw new ProjectError('novel/not-found', 'this chapter has no storyboard')
  if (!board.panels.some(entry => entry.id === panelId)) throw new ProjectError('novel/not-found', `the storyboard has no panel "${panelId}"`)
  const next: ComicBoard = {
    ...board,
    updatedAt: new Date().toISOString(),
    panels: board.panels.map((entry) => {
      if (entry.id !== panelId) return entry
      const merged = { ...entry, ...patch }
      // A changed prompt makes the old picture a picture of something else.
      if (patch.prompt !== undefined && patch.prompt !== entry.prompt) delete merged.image
      return merged
    }),
  }
  await project.saveComicBoard(next)
  return next
}

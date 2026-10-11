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
import { castAt } from './growth'
import type { AudioLine, CameraMove, CharacterCard, ComicBoard, ComicPanel, ImageTrial, StoryboardDensity, SheetsAsk } from '../../shared/types'
import { MAIN_LINE, PANEL_SECONDS, referencesOf, STORYBOARD_DENSITIES } from '../../shared/types'
import { leadOf } from '../../shared/images'
import { clip, hashText, newId, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import { speechUnits } from '../media/voiceprint'
import { ProjectError } from '../project'
import { storyboardTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { mapLimit, serializer } from '../util/async'
import { buildAudioScript } from './audio'
import { artDirectionOf, drawTrials, lackingSheets, looksOf, panelMakings, promptLangOf, renderImage, requireImages, sheetsBefore, sheetsFirst, wardrobeOf, type RenderInput } from './illustrate'
import { pictureSize } from '../../shared/art'
import { groupOf } from '../../shared/world'

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
  /** Who wears what, where it is not their usual: name → look. */
  wearing?: Record<string, string>
  /** Things of the bible the panel shows, as the director named them. */
  things?: string[]
}

export async function buildStoryboard(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; density?: StoryboardDensity; maxPanels?: number; force?: boolean }, task: TaskContext): Promise<ComicBoard> {
  const { project } = runtime
  const script = await buildAudioScript(core, runtime, { chapter: params.chapter }, task)
  const existing = await project.comicBoard(script.chapterId)
  if (existing !== undefined && existing.textHash === script.textHash && params.force !== true) return existing
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // Each of them as this chapter has them: the stretch of their life that holds here.
  const characters = await castAt(runtime, script.chapterId, await project.characters())
  const world = await project.world()
  const direction = await artDirectionOf(core, runtime)
  const art = direction.style
  const speakers = new Set(script.lines.map(line => line.speaker).filter((id): id is string => id !== undefined))
  const text = script.lines.map(line => line.text).join('\n')
  const cast = characters.filter(card => speakers.has(card.id) || text.includes(card.name))
  const located = await project.findChapter(script.chapterId)
  const named = (entry: { name: string; aliases?: string[] }, among: string): boolean => [entry.name, ...(entry.aliases ?? [])].some(name => name.trim().length > 1 && among.includes(name))
  // What the chapter is about, said outside its own words: its plan — the synopsis, each beat, where it is set — and
  // what its digest noted. The text itself often says "the old pen" where the plan says which pen it is.
  const outlinedAs = located?.plan
  const noted = await project.memory(script.chapterId)
  const about = [
    text,
    outlinedAs?.synopsis, outlinedAs?.purpose, outlinedAs?.location, outlinedAs?.notes,
    ...(outlinedAs?.beats ?? []).flatMap(beat => [beat.summary, beat.location, beat.conflict, beat.outcome]),
    noted?.summary, ...(noted?.locations ?? []), ...(noted?.facts ?? []).flatMap(fact => [fact.subject, fact.statement]),
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n')
  // Where the chapter is set, by its plan as well as by its words.
  const locations = world.filter(entry => groupOf(entry.category) === 'places' && named(entry, about))
  // Whatever else of the bible the chapter has to do with — a thing, a house, a rule, a word of this world: the
  // director is told what each is and what there is of it to see, where otherwise a name is all there would be to draw.
  const things = world.filter(entry => groupOf(entry.category) !== 'places' && named(entry, about))
  // The call's own wish, else the book's, else a picture every dozen seconds or so.
  const wished = params.density ?? manifest.storyboard?.density
  const density: StoryboardDensity = wished !== undefined && STORYBOARD_DENSITIES.includes(wished) ? wished : 'balanced'
  const beats = beatsOf(script.lines)
  const plan = planPanels(beats, density, params.maxPanels ?? manifest.storyboard?.maxPanels)
  const total = beats.reduce((sum, beat) => sum + beat.seconds, 0)
  // Who each of them is, how they look, and what else they have to wear: a panel says which look is worn in it.
  const castText = cast.map((card) => {
    const wardrobe = wardrobeOf(card)
    return `${card.name}${card.tagline !== undefined && card.tagline.trim().length > 0 ? L(lang, `（${clip(card.tagline.trim(), 50)}）`, ` (${clip(card.tagline.trim(), 80)})`) : ''}: ${looksOf(card) || L(lang, '（未设定外貌）', '(no look defined)')}${wardrobe !== undefined ? `\n  ${L(lang, '造型：', 'Looks: ')}${wardrobe.slice(wardrobe.indexOf(':') + 1).trim()}` : ''}`
  }).join('\n')
  const placeText = locations.map(entry => `${entry.name}: ${clip(entry.visualPrompt ?? entry.summary ?? '', 260)}`).join('\n')
  const thingText = things.map(entry => `${entry.name}${L(lang, `（${entry.category}）`, ` (${entry.category})`)}: ${clip([entry.summary, entry.visualPrompt].filter((part): part is string => part !== undefined && part.trim().length > 0).join(L(lang, '；看上去：', '; to the eye: ')), 240)}`).join('\n')
  // The chapter the passage is of: where and when it is set, what happens in it.
  const outlined = located?.plan
  const chapterText = outlined === undefined ? '' : [
    L(lang, `第 ${located!.index} 章《${outlined.title}》`, `Chapter ${located!.index}, "${outlined.title}"`),
    outlined.location !== undefined && outlined.location.trim().length > 0 ? L(lang, `地点：${outlined.location}`, `Where: ${outlined.location}`) : undefined,
    outlined.time !== undefined && outlined.time.trim().length > 0 ? L(lang, `时间：${outlined.time}`, `When: ${outlined.time}`) : undefined,
    outlined.synopsis !== undefined && outlined.synopsis.trim().length > 0 ? L(lang, `这一章：${clip(outlined.synopsis.trim(), 300)}`, `What happens: ${clip(outlined.synopsis.trim(), 400)}`) : undefined,
  ].filter((part): part is string => part !== undefined).join('\n')
  const speakerOf = (line: AudioLine): string => line.kind === 'narration' ? L(lang, '旁白', 'narrator') : (line.speakerName ?? '?')

  // One window of the script per request; each is asked for its share of the panels.
  const windows: { start: number; beats: Beat[] }[] = []
  for (let start = 0; start < beats.length; start += WINDOW) windows.push({ start, beats: beats.slice(start, start + WINDOW) })
  let finished = 0
  let early = 0
  task.job?.progress(0, windows.length, L(lang, `编排分镜（目标约 ${plan.target} 格）`, `storyboarding (about ${plan.target} panels)`))

  const boarded = await mapLimit(windows, await core.parallelFor('text', runtime), async (window) => {
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
      const { value } = await assign(core, runtime, task, {
        role: 'director',
        label: L(lang, `${located !== undefined ? `第${located.index}章 · ` : ''}分镜`, `${located !== undefined ? `Ch. ${located.index} · ` : ''}storyboard`),
        ...(located !== undefined ? { line: located.line ?? MAIN_LINE } : {}),
        tool: 'submit_storyboard',
        // The material is all in the task: a few looks at the book at most, then the result.
        // All of it is in the task: asked in one request, whatever the role is set to.
        plain: true,
        maxSteps: 12,
        what: L(lang, '这一段的分镜：每一格画什么、配哪几句', 'the storyboard of this passage: what each panel shows and which lines it carries'),
        prompt: storyboardTask({
          lang,
          language: manifest.language,
          title: manifest.title,
          units: rest.map((beat, index) => `${index} | ${speakerOf(script.lines[beat.line]!)} | ${Math.max(1, Math.round(beat.seconds))}s | ${clip(beat.text, 140)}`).join('\n'),
          cast: castText,
          locations: placeText,
          ...(thingText.length > 0 ? { things: thingText } : {}),
          ...(chapterText.length > 0 ? { chapter: chapterText } : {}),
          artStyle: art,
          avoid: direction.avoid,
          count,
          ...(last !== undefined ? { previous: last.description } : {}),
        }),
        temperature: 0.5,
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
            const wearing = Object.fromEntries(Object.entries(asRecord(item.wearing)).map(([name, look]) => [name, asText(look)]).filter((pair): pair is [string, string] => pair[1] !== undefined))
            const shows = asList(item.things)
            found.push({
              from: at,
              to,
              description: asText(item.description) ?? clip(prompt, 60),
              prompt,
              camera: camera !== undefined && CAMERAS.includes(camera) ? camera : 'zoom-in',
              characters: asList(item.characters),
              ...(location !== undefined ? { location } : {}),
              ...(Object.keys(wearing).length > 0 ? { wearing } : {}),
              ...(shows.length > 0 ? { things: shows } : {}),
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
      drafts = [...drafts.slice(0, best), {
        ...kept,
        to: gone.to,
        characters: [...new Set([...kept.characters, ...gone.characters])],
        ...(kept.wearing !== undefined || gone.wearing !== undefined ? { wearing: { ...gone.wearing, ...kept.wearing } } : {}),
        ...(kept.things !== undefined || gone.things !== undefined ? { things: [...new Set([...(kept.things ?? []), ...(gone.things ?? [])])] } : {}),
      }, ...drafts.slice(best + 2)]
    }
  }

  const panels: ComicPanel[] = drafts.map((draft) => {
    const first = beats[draft.from]!
    const last = beats[draft.to]!
    const who = (name: string): CharacterCard | undefined => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)
    const present = draft.characters.map(name => who(name)?.id).filter((id): id is string => id !== undefined)
    // A look somebody wears here, where they have one of that name; a thing shown, by the name the bible has it under.
    const looks = Object.fromEntries(Object.entries(draft.wearing ?? {}).map(([name, look]) => {
      const card = who(name)
      const has = card?.visual?.looks?.find(candidate => sameName(candidate.name, look))
      return card !== undefined && has !== undefined ? [card.id, has.name] as const : undefined
    }).filter((pair): pair is readonly [string, string] => pair !== undefined))
    const shows = [...new Set((draft.things ?? []).map(name => world.find(entry => sameName(entry.name, name) || (entry.aliases ?? []).some(alias => sameName(alias, name)))?.name).filter((name): name is string => name !== undefined))]
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
      ...(Object.keys(looks).length > 0 ? { looks } : {}),
      ...(shows.length > 0 ? { things: shows } : {}),
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
  /** Whose design sheet was drawn before the panels, for the panels to be held against: they come back in the book and had none. */
  sheets?: string[]
  /** How many of the panels just drawn went without reference pictures they were to be held against: the image service did not take them. */
  unheld?: number
  /** Drawn to compare services: the round the pictures are of, and how many there are — none of them is a panel's picture until taken. */
  round?: string
  tried?: number
}

/** Draw the panels of a chapter's storyboard that have no picture yet. */
/**
 * Whose design sheets a run of pictures would draw first — everything about
 * to be started, asked in one go, before any of it is: so that the author can
 * be told "this will first draw N design sheets" and say yes, or not this time.
 * @returns `unknown`: how many of the asks cannot be told yet — panels of a chapter whose storyboard is not laid out.
 */
export async function sheetsAhead(core: NovelCore, runtime: ProjectRuntime, asks: readonly SheetsAsk[]): Promise<{ people: { id: string; name: string }[]; unknown: number; /** The sheets are drawn after the portraits asked for, against them: the portrait leads. */ after?: true }> {
  const { project } = runtime
  const people = new Map<string, string>()
  let unknown = 0
  // Where the portrait leads, a portrait draws no sheet before it — it draws theirs after it, against it, where they have none.
  const portraitLeads = leadOf(await core.imageOf(runtime)) === 'portrait'
  let following = 0
  for (const ask of asks) {
    let cards: CharacterCard[]
    // (…unless this one is asked for against the sheet: then theirs comes first, as where the sheet leads.)
    if (portraitLeads && ask.kind === 'portrait' && ask.from !== 'sheet') {
      const card = ask.target !== undefined ? await project.findCharacter(ask.target) : undefined
      if (card !== undefined && card.visual?.sheet === undefined) { people.set(card.id, card.name); following += 1 }
      continue
    }
    if (ask.kind === 'panels') {
      const chapter = await project.findChapter(ask.chapter)
      const board = chapter !== undefined ? await project.comicBoard(chapter.plan.id) : undefined
      if (board === undefined) {
        // Who is in the panels is the storyboard's to say, and there is none yet.
        unknown += 1
        continue
      }
      const wanted = ask.panels !== undefined ? new Set(ask.panels) : undefined
      const todo = board.panels.filter(panel => (wanted === undefined || wanted.has(panel.id)) && (ask.force === true || panel.image === undefined))
      const all = await project.characters()
      cards = await lackingSheets(core, runtime, [...new Set(todo.flatMap(panel => panel.characters ?? []))].map(id => all.find(card => card.id === id)).filter((card): card is CharacterCard => card !== undefined), 'returning')
    } else {
      // A picture that cannot be drawn says so when it is started; before that it is nothing to ask about.
      cards = await sheetsBefore(core, runtime, ask).catch(() => [])
    }
    for (const card of cards) people.set(card.id, card.name)
  }
  // (Whether the way to the model takes the sheets along is not said here: it is the service's to show, and is said
  // with the picture once it is drawn — what a service takes changes, and is not always known before it is asked.)
  // Every sheet asked about is one that follows a portrait: the question is then about what comes after, not before.
  const after = following > 0 && following === people.size
  return { people: [...people].map(([id, name]) => ({ id, name })), unknown, ...(after ? { after: true as const } : {}) }
}

export async function renderPanels(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; panels?: string[]; force?: boolean; concurrency?: number; /** `false`: this once, no design sheet is drawn first. */ sheetFirst?: boolean; /** Whether the art of the things a panel shows goes along; left out: as the book (else the Studio) has it. */ things?: boolean; /** Draw each of these panels once with each of these services, to compare them: no panel takes any of the pictures until the author does ({@link hangPicture}). */ trials?: ImageTrial[]; /** With `trials`: the press of a button the pictures are of — taken together, by service. */ trialBatch?: string }, task: TaskContext): Promise<RenderPanelsResult> {
  const { project } = runtime
  await requireImages(core, runtime)
  let board = await buildStoryboard(core, runtime, { chapter: params.chapter }, task)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // The book's art direction as it stands now — not the copy the storyboard was drawn up with.
  const art = await artDirectionOf(core, runtime, { pin: true })
  const world = await project.world()
  const wanted = params.panels !== undefined ? new Set(params.panels) : undefined
  const todo = board.panels.filter(panel => (wanted === undefined || wanted.has(panel.id)) && (params.force === true || panel.image === undefined))
  // Whoever comes back in the book has a design sheet before the first panel that shows them: every panel is held against
  // it, and without it each panel would invent the face anew.
  const cards = await project.characters()
  const inPanels = [...new Set(todo.flatMap(panel => panel.characters ?? []))].map(id => cards.find(card => card.id === id)).filter((card): card is CharacterCard => card !== undefined)
  const first = params.sheetFirst === false ? { drawn: [] as string[] } : await sheetsFirst(core, runtime, inPanels, 'returning', task)
  if (first.drawn.length > 0) task.job?.result({ sheets: first.drawn })
  // Drawn as this chapter has them: the look — and the sheet — of the stretch of their life that holds here.
  const characters = await castAt(runtime, board.chapterId, first.drawn.length > 0 ? await project.characters() : cards)
  const mostReferences = referencesOf((await core.imageOf(runtime)).references)
  // The language the panels' prompts are written in: the book's, unless the author has prompts in English.
  const panelLang = promptLangOf(await core.imageOf(runtime), lang)
  // Whether the art of the things a panel shows goes along: this drawing's own word for it, else the book's, else the Studio's (yes).
  const thingArt = params.things ?? (await core.imageOf(runtime)).panelThings !== false
  let rendered = 0
  let failed = 0
  let unheld = 0
  let done = 0
  // Drawn to be compared: by which services, and the round the pictures are of (taken together, by service).
  const trying = params.trials !== undefined && params.trials.length > 0 ? params.trials : undefined
  const round = params.trialBatch ?? newId('round')
  let tried = 0
  task.job?.progress(0, todo.length, L(lang, '绘制画面', 'drawing panels'))
  // Which panels this drawing is on: another may be started for the others meanwhile, and the page shows which is which.
  task.job?.result({ chapterId: board.chapterId, drawing: todo.map(panel => panel.id), ...(wanted === undefined ? { all: true } : {}) })
  const updates = new Map<string, Partial<ComicPanel>>()
  const inOrder = serializer()
  // Kept into the storyboard as it stands at that moment — not into the copy this drawing started from: another
  // drawing of the same chapter may have kept its panels since.
  const flush = (): Promise<void> => inOrder(async () => {
    if (updates.size === 0) return
    const mine = new Map(updates)
    updates.clear()
    board = await project.patchComicPanels(board.chapterId, mine) ?? board
  })
  await mapLimit(todo, Math.max(1, params.concurrency ?? await core.parallelFor('image', runtime)), async (panel) => {
    try {
      // What the director wrote for the panel, and after it how everyone in it looks in what they wear there, how its
      // place and the things it shows look — as the bible has them now; with their design sheets and art along.
      const makings = panelMakings(panel, { characters, world, most: mostReferences, lang: panelLang, thingArt })
      const input: RenderInput = {
        subject: makings.subject,
        ...(makings.pieces !== undefined ? { pieces: makings.pieces } : {}),
        kind: 'panel',
        target: board.chapterId,
        name: `panel-${board.chapterId}-${hashText(panel.id).slice(0, 4)}`,
        // A panel is a picture of the book like any other: on record, in the gallery, drawn again and changed from there.
        art,
        avoid: makings.avoid,
        references: makings.references,
      }
      if (trying !== undefined) {
        // Tried with several services: each draws it at its own size for a panel; the panel keeps what it has (or
        // nothing) until the author takes one of them.
        const made = await drawTrials(core, runtime, trying, async trial => await renderImage(core, runtime, { ...input, size: pictureSize((await core.imageOf(runtime)), 'panel'), trial: { ...trial, hang: { as: 'panel', chapter: board.chapterId, panel: panel.id }, batch: round } }, task), task)
        if (made.first === undefined) throw new Error(made.pictures.map(picture => `${picture.label}: ${picture.error ?? 'no picture'}`).join('; '))
        tried += made.pictures.filter(picture => picture.path !== undefined).length
        rendered += 1
      } else {
        const info = await renderImage(core, runtime, { ...input, size: pictureSize((await core.imageOf(runtime)), 'panel') }, task)
        updates.set(panel.id, { image: info.path })
        rendered += 1
        if ((info.parts?.left?.length ?? 0) > 0) unheld += 1
      }
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      updates.set(panel.id, { error: error instanceof Error ? error.message : String(error) })
      failed += 1
    }
    done += 1
    task.job?.progress(done, todo.length)
    await flush()
  }, task.signal)
  task.job?.result({ chapterId: board.chapterId, rendered, failed, ...(trying !== undefined ? { round, tried } : {}) })
  return { chapterId: board.chapterId, panels: board.panels.length, rendered, failed, ...(first.drawn.length > 0 ? { sheets: first.drawn } : {}), ...(unheld > 0 ? { unheld } : {}), ...(trying !== undefined ? { round, tried } : {}) }
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

/**
 * Take one panel out of a storyboard. The lines it stayed on screen for go to
 * the panel before it (the one after, when it was the first), so no line is
 * left without a picture. Its picture stays in the gallery.
 */
export async function removeComicPanel(runtime: ProjectRuntime, chapterRef: string, panelId: string): Promise<ComicBoard> {
  const { project } = runtime
  const chapter = await project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  const board = await project.comicBoard(chapter.plan.id)
  if (board === undefined) throw new ProjectError('novel/empty', 'this chapter has no storyboard yet')
  const at = board.panels.findIndex(panel => panel.id === panelId)
  if (at < 0) throw new ProjectError('novel/not-found', `the storyboard has no panel "${panelId}"`)
  const gone = board.panels[at]!
  const panels = board.panels.filter(panel => panel.id !== panelId)
  const heir = panels[at - 1] ?? panels[at]
  if (heir !== undefined) {
    const before = at > 0
    const { begin: _begin, end: _end, ...rest } = heir
    // The heir now runs over whole lines at the side it grew on.
    panels[panels.indexOf(heir)] = {
      ...rest,
      lines: before ? [...heir.lines, ...gone.lines.filter(id => !heir.lines.includes(id))] : [...gone.lines.filter(id => !heir.lines.includes(id)), ...heir.lines],
      ...(before ? (heir.begin !== undefined ? { begin: heir.begin } : {}) : (heir.end !== undefined ? { end: heir.end } : {})),
    }
  }
  const next: ComicBoard = { ...board, updatedAt: new Date().toISOString(), panels }
  await project.saveComicBoard(next)
  return next
}

/** Throw a chapter's storyboard away. The pictures drawn for its panels stay in the gallery, where each can be deleted. */
export async function clearComicBoard(runtime: ProjectRuntime, chapterRef: string): Promise<{ chapterId: string; removed: boolean }> {
  const chapter = await runtime.project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  return { chapterId: chapter.plan.id, removed: await runtime.project.removeComicBoard(chapter.plan.id) }
}

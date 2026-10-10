// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The same piece of work done by several services or models at once, to be
 * compared.
 *
 * Which image service draws best for this book, which model writes its
 * chapters, which plans them — the author finds out by seeing what each makes
 * of the same task: the same portrait, the same chapter, the same stretch of
 * outline. Nothing a trial makes takes the place of anything: pictures stand
 * beside the ones there are, drafts are kept among the chapter's versions,
 * plans are only shown — until the author takes one.
 *
 * (Pictures are tried where they are drawn: `illustrate` and `redrawPicture`
 * take `trials`. What is here is the text side, a line spoken by several
 * speech setups, and what there is to try with.)
 */
import { imageService, imageSetupName, imageSourceOf, speechSetupName, ttsService, withBook, type BookSettings } from '../../shared/images'
import { countWords, hashText, proseOnly, slugify } from '../../shared/text'
import type { ImageSettings, ImageTrial, ModelRoute, NovelSettings, SpeechTrial, TrialDraft, TrialTake, TtsSettings } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { AUDIOGEN_NARRATOR, describesVoices } from '../media/voices'
import { durationOf, encodeWav } from '../media/wav'
import { ProjectError } from '../project'
import { isAbort } from '../util/async'
import { openCast, requireSpeech, speakChecked, speechRequest, voiceBank, voiceFor, type VoiceChoice } from './audio'
import { deriveChapters, type DeriveChaptersParams, type DerivedChapter } from './plot'
import { writeChapter, type WriteParams } from './write'

/** A service pictures can be tried with, as the author is offered it. */
export interface ImageSetupChoice extends ImageTrial {
  /** What it is among the setups: the one in force, or one remembered (`kept`), of the Studio's or of the book's. */
  id: string
  /** It is the one that draws for this book now. */
  current: boolean
}

/**
 * The image services there are to try for a book: the one that draws for it now, and every one the author set up
 * before and moved on from — the Studio's and the book's own. One service set up twice the same is listed once.
 */
export function imageSetups(settings: NovelSettings, manifest?: BookSettings): ImageSetupChoice[] {
  const out: ImageSetupChoice[] = []
  const seen = new Set<string>()
  const add = (id: string, image: Partial<ImageSettings>, current: boolean): void => {
    if (image.provider === undefined || image.provider === 'none') return
    const service = imageService(image)
    const { concurrency: _n, references: _r, resolution: _f, size: _s, ...what } = service
    const key = JSON.stringify(what)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id, label: imageSetupName(image as ImageSettings), image: service, current })
  }
  const held = withBook(settings, manifest).image
  add('current', held, true)
  // The Studio's own, where the book draws with another.
  add('studio', settings.image, false)
  for (const [name, kept] of Object.entries(manifest?.image?.kept ?? {})) add(`book:${name}`, kept, false)
  for (const [name, kept] of Object.entries(settings.image.kept ?? {})) add(`studio:${name}`, kept, false)
  return out
}

/** The same setup with another model of the same service: for trying two models of one service against each other. */
export function withModel(setup: ImageTrial, model: string): ImageTrial {
  const image = { ...setup.image, model }
  return { label: imageSetupName({ provider: image.provider ?? 'none', ...(image.baseURL !== undefined ? { baseURL: image.baseURL } : {}), model }), image }
}

/** A model, as it is said beside what it made. */
const modelName = (route: Pick<ModelRoute, 'provider' | 'model'>): string => `${route.model}`

const seconds = (since: number): number => Math.round((Date.now() - since) / 100) / 10

const quiet = (task: TaskContext): TaskContext => {
  // Several at once would write over each other's stream: what each makes is told when it is whole.
  const { job: _job, ...rest } = task
  return rest
}

function checked(routes: readonly ModelRoute[]): ModelRoute[] {
  const out = routes.filter(route => typeof route?.provider === 'string' && route.provider.length > 0 && typeof route.model === 'string' && route.model.length > 0)
  if (out.length === 0) throw new ProjectError('novel/invalid', 'name the models to compare: `with` takes routes of DSH\'s ({provider, model})')
  if (out.length > 8) throw new ProjectError('novel/invalid', 'eight models at once is the most a comparison takes')
  return out
}

/**
 * Have several models write the same chapter, at the same time, from the same context and the same brief. The
 * chapter keeps its text; each draft is kept among the chapter's versions (so none is lost, and any can be made the
 * chapter by restoring it) and handed back to be read side by side.
 */
export async function trialWrite(core: NovelCore, runtime: ProjectRuntime, params: WriteParams & { with: ModelRoute[] }, task: TaskContext): Promise<{ chapterId: string; drafts: TrialDraft[] }> {
  const routes = checked(params.with)
  const { with: _with, ...write } = params
  const chapter = write.chapter !== undefined ? await runtime.project.findChapter(write.chapter) : undefined
  if (write.chapter !== undefined && chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${write.chapter}"`)
  const drafts: TrialDraft[] = routes.map(route => ({ label: modelName(route), provider: route.provider, model: route.model, seconds: 0 }))
  let chapterId = chapter?.plan.id ?? ''
  const say = (): void => { task.job?.result({ ...(chapterId.length > 0 ? { trialOf: chapterId } : {}), drafts: drafts.map(({ text: _text, ...draft }) => draft) }) }
  say()
  task.job?.progress(0, routes.length)
  let done = 0
  await Promise.all(routes.map(async (route, at) => {
    const began = Date.now()
    try {
      const made = await core.trial({ routes: { writer: route } }, () => writeChapter(core, runtime, { ...write, ...(chapterId.length > 0 ? { chapter: chapterId } : {}), dry: true, digest: false }, quiet(task)))
      chapterId = made.chapterId
      const text = made.text ?? ''
      // Kept among the chapter's versions: a draft that is not taken now can be taken later.
      const version = await runtime.project.snapshot(made.chapterId, `trial-${slugify(route.model, 'model')}`, text)
      drafts[at] = { ...drafts[at]!, text, words: countWords(proseOnly(text)), seconds: seconds(began), ...(version !== undefined ? { version } : {}) }
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      drafts[at] = { ...drafts[at]!, seconds: seconds(began), error: error instanceof Error ? error.message : String(error) }
    }
    done += 1
    task.job?.progress(done, routes.length)
    say()
  }))
  return { chapterId, drafts }
}

/** What one model made of a stretch of outline planned by several. */
export interface TrialPlan {
  label: string
  provider: string
  model: string
  chapters?: DerivedChapter[]
  rationale?: string
  seconds: number
  error?: string
}

/**
 * Have several models plan the same chapters to come, at the same time: each a preview — nothing is added to the
 * outline. The author reads them side by side and adds the one they take (or none).
 */
export async function trialDerive(core: NovelCore, runtime: ProjectRuntime, params: DeriveChaptersParams & { with: ModelRoute[] }, task: TaskContext): Promise<{ plans: TrialPlan[] }> {
  const routes = checked(params.with)
  const { with: _with, ...derive } = params
  const plans: TrialPlan[] = routes.map(route => ({ label: modelName(route), provider: route.provider, model: route.model, seconds: 0 }))
  const say = (): void => { task.job?.result({ plans: plans.map(plan => ({ ...plan })) }) }
  say()
  task.job?.progress(0, routes.length)
  let done = 0
  await Promise.all(routes.map(async (route, at) => {
    const began = Date.now()
    try {
      const made = await core.trial({ routes: { architect: route } }, () => deriveChapters(core, runtime, { ...derive, apply: false }, quiet(task)))
      plans[at] = { ...plans[at]!, chapters: made.chapters, ...(made.rationale !== undefined ? { rationale: made.rationale } : {}), seconds: seconds(began) }
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      plans[at] = { ...plans[at]!, seconds: seconds(began), error: error instanceof Error ? error.message : String(error) }
    }
    done += 1
    task.job?.progress(done, routes.length)
    say()
  }))
  return { plans }
}

/** Whether a setup is one of this source: for telling apart setups of the same service that differ by model only. */
export const sourceOf = (setup: ImageTrial): string => imageSourceOf({ provider: setup.image.provider ?? 'none', ...(setup.image.baseURL !== undefined ? { baseURL: setup.image.baseURL } : {}) })

// ───────────────────────────── speech ─────────────────────────────

/** A speech setup lines can be tried with, as the author is offered it. */
export interface SpeechSetupChoice extends SpeechTrial {
  /** What it is among the setups: the one in force, or one remembered (`kept`), of the Studio's or of the book's. */
  id: string
  /** It is the one that speaks for this book now. */
  current: boolean
}

/**
 * The speech setups there are to try for a book: the one that speaks for it now, and every one the author set up
 * before and moved on from — the Studio's and the book's own. One setup listed twice the same is listed once.
 */
export function speechSetups(settings: NovelSettings, manifest?: BookSettings): SpeechSetupChoice[] {
  const out: SpeechSetupChoice[] = []
  const seen = new Set<string>()
  const add = (id: string, tts: Partial<TtsSettings>, current: boolean): void => {
    if (tts.provider === undefined || tts.provider === 'none') return
    const service = ttsService(tts)
    // The same service with other voices named is the same service to try.
    const { narratorVoice: _n, defaultVoices: _d, ...what } = service
    const key = JSON.stringify(what)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id, label: speechSetupName(tts as TtsSettings), tts: service, current })
  }
  add('current', withBook(settings, manifest).tts, true)
  add('studio', settings.tts, false)
  for (const [name, kept] of Object.entries(manifest?.tts?.kept ?? {})) add(`book:${name}`, kept, false)
  for (const [name, kept] of Object.entries(settings.tts.kept ?? {})) add(`studio:${name}`, kept, false)
  return out
}

/**
 * Have several speech setups speak the same words, at the same time: as a character would speak them in each — the
 * voice that setup has or would cast for them — or as the narrator, where nobody is named. Nothing is cast, learned
 * or saved by it: the clips are samples, to be listened to side by side.
 * @param params.character - whose line it is; the narrator's when left out.
 */
export async function trialSpeak(core: NovelCore, runtime: ProjectRuntime, params: { text: string; character?: string; direction?: string; with: SpeechTrial[] }, task: TaskContext): Promise<{ takes: TrialTake[] }> {
  const { project } = runtime
  const trials = (Array.isArray(params.with) ? params.with : []).filter(trial => trial !== null && typeof trial === 'object' && typeof trial.tts?.provider === 'string' && trial.tts.provider !== 'none')
  if (trials.length === 0) throw new ProjectError('novel/invalid', 'name the speech setups to compare: `with` takes {label, tts, voice?} — see what there is with trial.setups')
  if (trials.length > 8) throw new ProjectError('novel/invalid', 'eight setups at once is the most a comparison takes')
  const text = params.text.trim().slice(0, 600)
  if (text.length === 0) throw new ProjectError('novel/invalid', 'give the words to be spoken')
  const card = params.character !== undefined && params.character.length > 0 ? await project.findCharacter(params.character) : undefined
  if (params.character !== undefined && params.character.length > 0 && card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  const [manifest, characters] = await Promise.all([project.manifest(), project.characters()])
  const round = hashText(`${text}${Date.now()}${Math.random()}`).slice(0, 8)
  const takes: TrialTake[] = trials.map(trial => ({ label: trial.label, ...(trial.tts.model !== undefined ? { model: trial.tts.model } : {}), seconds: 0 }))
  const say = (): void => { task.job?.result({ takes: takes.map(take => ({ ...take })) }) }
  say()
  task.job?.progress(0, trials.length)
  let done = 0
  await Promise.all(trials.map(async (trial, at) => {
    const began = Date.now()
    try {
      takes[at] = await core.trial({ tts: trial.tts }, async () => {
        const provider = await requireSpeech(core, runtime)
        const settings = (await core.settingsOf(runtime)).tts
        const cast = await openCast(project, settings)
        const narrator = settings.narratorVoice ?? (describesVoices(settings.provider) ? AUDIOGEN_NARRATOR : undefined)
        // Heard as a line of theirs would be with this setup — from copies of the sheet: listening casts nobody.
        const usual: VoiceChoice = card !== undefined
          ? voiceFor({ kind: 'dialogue', speaker: card.id, speakerName: card.name, ...(params.direction !== undefined ? { direction: params.direction } : {}) }, characters, settings, new Map(cast.taken), new Map(cast.extras))
          : { ...(narrator !== undefined ? { voice: narrator } : {}), ...((params.direction ?? settings.narratorInstructions) !== undefined ? { direction: (params.direction ?? settings.narratorInstructions)! } : {}) }
        // A voice named for this setup speaks instead of the one it would have (and not through a clip made for another).
        const named = trial.voice?.trim() ?? ''
        const choice: VoiceChoice = named.length > 0 ? { voice: named, ...(usual.direction !== undefined ? { direction: usual.direction } : {}) } : usual
        const reference = voiceBank(core, runtime, provider, settings, manifest.language, task.signal)
        const request = await speechRequest(choice, text, manifest.language, reference, task.signal)
        const take = await speakChecked(provider, request, { retakes: 0 })
        const path = await project.writeAsset(`audio/auditions/trial-${round}-${at + 1}.wav`, encodeWav(take.audio))
        return { label: trial.label, ...(settings.model !== undefined ? { model: settings.model } : {}), ...(choice.voice !== undefined ? { voice: choice.voice } : {}), path, duration: Number(durationOf(take.audio).toFixed(2)), seconds: seconds(began) }
      })
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      takes[at] = { ...takes[at]!, seconds: seconds(began), error: error instanceof Error ? error.message : String(error) }
    }
    done += 1
    task.job?.progress(done, trials.length)
    say()
  }))
  return { takes }
}

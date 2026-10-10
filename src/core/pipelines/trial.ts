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
 * take `trials`. What is here is the text side, and what there is to try with.)
 */
import { imageService, imageSetupName, imageSourceOf, withBook } from '../../shared/images'
import { countWords, proseOnly, slugify } from '../../shared/text'
import type { ImageSettings, ImageTrial, ModelRoute, NovelSettings, ProjectManifest, TrialDraft } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { ProjectError } from '../project'
import { isAbort } from '../util/async'
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
export function imageSetups(settings: NovelSettings, manifest?: Pick<ProjectManifest, 'image' | 'tts' | 'sound'>): ImageSetupChoice[] {
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

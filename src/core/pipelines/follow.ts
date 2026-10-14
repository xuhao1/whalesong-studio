// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter's plan kept in line with its text.
 *
 * A plan is written before its chapter. Once the text is changed — a revision
 * accepted, the chapter written anew, a hand in the file — the plan says what
 * was meant and not what is there, and whoever goes by it afterwards (a writer
 * rewriting the chapter, the director cutting it into panels, the planner
 * deriving what follows) goes by something the book no longer says. A plan can
 * be read against its text ({@link planOfText}: synopsis, purpose, place, time,
 * point of view, cast and beats) — one chapter's, or several in one job; a plan
 * that already stands by the text its chapter has is left alone, and the plan
 * as it was stays in its history.
 *
 * That is the author's to ask for. A plan is what they designed, and a text a
 * model wrote away from it is not made the plan behind their back — else the
 * outline becomes whatever was written, and the next chapters are planned and
 * written by that. Only where the author switched it on (`plansFollow`) does a
 * chapter that was digested before and is changed have its plan read by itself,
 * in the background, a moment later.
 */
import { hashText } from '../../shared/text'
import { autoOf, type AutoSaid } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { errorMessage, mapLimit } from '../util/async'
import { L, promptLanguage } from '../render'
import { planOfText, planReadFrom, type PlanItem } from './plot'

/** The background job's title; the Studio's page says its ending by it. */
export const FOLLOW_JOB = 'plans follow text'

/** One chapter whose plan was read against its text. */
export interface PlanFollowed {
  chapterId: string
  index: number
  title: string
  /** The items the text changed, beside the beats. */
  changed: PlanItem[]
  beats: number
  /** How many beats the plan had before. */
  was: number
  /** Of the beats now, how many stand as they stood. */
  kept: number
}

export interface PlansFollowed {
  read: PlanFollowed[]
  /** Chapters left alone: their plan was read from the very text they have. */
  same: number
  failed: { chapter: string; error: string }[]
}

/** Whether a chapter's plan is yet to be read from the text the chapter has now. */
async function due(runtime: ProjectRuntime, chapterId: string): Promise<boolean> {
  const text = await runtime.project.chapterText(chapterId).catch(() => '')
  return text.trim().length > 0 && await planReadFrom(runtime.project, chapterId) !== hashText(text)
}

/**
 * Read the plans of several chapters against their texts and set them by what is there.
 * @param params.force - read a plan again though it was read from this very text.
 */
export async function plansOfText(core: NovelCore, runtime: ProjectRuntime, params: { chapters: readonly string[]; force?: boolean }, task: TaskContext): Promise<PlansFollowed> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  const zh = lang === 'zh'
  const ids: string[] = []
  for (const ref of params.chapters) {
    const chapter = await project.findChapter(ref)
    if (chapter !== undefined && !ids.includes(chapter.plan.id)) ids.push(chapter.plan.id)
  }
  const result: PlansFollowed = { read: [], same: 0, failed: [] }
  let done = 0
  task.job?.progress(0, ids.length)
  await mapLimit(ids, await core.parallelFor('text', runtime), async (id) => {
    try {
      if ((await project.chapterText(id)).trim().length === 0) return
      if (params.force !== true && !(await due(runtime, id))) {
        result.same += 1
        return
      }
      // The job is the batch's: one chapter's reading does not report as the whole of it.
      const read = await planOfText(core, runtime, { chapter: id, what: 'plan' }, { ...task, job: undefined } as TaskContext)
      result.read.push({ chapterId: read.chapterId, index: read.index, title: read.title, changed: read.changed ?? [], beats: read.beats.length, was: read.was, kept: read.kept })
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      result.failed.push({ chapter: id, error: errorMessage(error) })
    } finally {
      done += 1
      task.job?.progress(done, ids.length)
    }
  }, task.signal)
  result.read.sort((a, b) => a.index - b.index)
  if (result.read.length > 0) {
    const names: Record<PlanItem, [string, string]> = { synopsis: ['梗概', 'synopsis'], purpose: ['作用', 'purpose'], location: ['地点', 'place'], time: ['故事时间', 'story time'], pov: ['视角', 'point of view'], characters: ['出场人物', 'cast'] }
    const said = result.read.map((read) => {
      const items = [...read.changed.map(item => names[item][zh ? 0 : 1]), zh ? `节拍 ${read.beats} 个（原来 ${read.was} 个）` : `${read.beats} beat(s), ${read.was} before`]
      return zh ? `第 ${read.index} 章（${items.join('、')}）` : `chapter ${read.index} (${items.join(', ')})`
    })
    await project.addActivity({ by: 'crew', role: 'analyst', tool: 'outline', summary: L(lang, `章纲照正文更新了：${said.join('；')}。原来的在各章章纲的历史版本里`, `Plans set by their texts: ${said.join('; ')}. What was there is in each plan's history`) }).catch(() => {})
  }
  task.job?.result({ followed: result.read.length, same: result.same, failed: result.failed.length, chapters: result.read.map(({ index, title, changed, beats, was, kept }) => ({ index, title, changed, beats, was, kept })) })
  return result
}

/** Chapters whose text changed, waiting per book for their plans to be read: changes that come one after another are one job. */
const pending = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; chapters: Set<string>; task: Pick<TaskContext, 'origin' | 'agentRoute'> }>()

/** How long after the last change the plans are read (a test shortens it). */
export const followTiming = { delay: 2500 }

/**
 * Whether plans follow their texts by themselves (`plansFollow`). Unset: no — a plan is the author's design, and what
 * a model wrote is made the plan only where the author asks for it.
 */
export const plansFollow = (core: NovelCore, book?: AutoSaid): boolean => autoOf(core.currentSettings(), book).plansFollow

/**
 * Have a chapter's plan read against its text once the text was changed — in the background, a moment later.
 * Nothing is asked where the plan already stands by the text the chapter has.
 */
export function schedulePlanFollow(core: NovelCore, runtime: ProjectRuntime, chapterId: string, task: Pick<TaskContext, 'origin' | 'agentRoute'>): void {
  const root = runtime.project.root
  const waiting = pending.get(root) ?? { timer: undefined, chapters: new Set<string>(), task }
  if (waiting.timer !== undefined) clearTimeout(waiting.timer)
  waiting.chapters.add(chapterId)
  // What the author started is said to the author when it ends, whoever else asked meanwhile.
  if (task.origin === 'user') waiting.task = task
  const fire = (): void => {
    // One reading at a time per book: what came in meanwhile waits for it, and is then read from the text as it is by then.
    if (core.jobs.list(root).some(job => job.kind === 'derive' && job.title === FOLLOW_JOB && job.status === 'running')) {
      waiting.timer = setTimeout(fire, followTiming.delay)
      waiting.timer.unref?.()
      return
    }
    pending.delete(root)
    void (async () => {
      // (Of this book: its own switch where it has one, else the Studio's.)
      if (!(await core.autoFor(runtime)).plansFollow) return
      const chapters: string[] = []
      for (const id of waiting.chapters) if (await due(runtime, id)) chapters.push(id)
      if (chapters.length === 0) return
      const { origin, agentRoute } = waiting.task
      core.jobs.start({ kind: 'derive', title: FOLLOW_JOB, project: root, origin, ...(chapters.length === 1 ? { target: chapters[0]! } : {}) }, async (job) => {
        await plansOfText(core, runtime, { chapters }, { origin, signal: job.signal, job, ...(agentRoute !== undefined ? { agentRoute } : {}) })
      })
    })().catch((error: unknown) => { core.log('could not start reading the plans against their texts', error) })
  }
  waiting.timer = setTimeout(fire, followTiming.delay)
  waiting.timer.unref?.()
  pending.set(root, waiting)
}

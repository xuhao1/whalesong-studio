// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A volume's synopsis read off its chapters.
 *
 * A volume says what it is about in its synopsis, and where it must leave the
 * story in its goal. Both are set by hand, or once when a book is imported;
 * after that the chapters are written and the synopsis says less and less of
 * them — or, for a book imported as one long volume, nothing at all. Here the
 * continuity editor writes it anew from its chapters, in one request: the
 * written ones as their digests tell them (a stretch of ten at a time, where
 * a long volume would not fit otherwise), the ones not written yet by their
 * outlines, as what is still to come — shown nothing of the synopsis there was.
 * That is often the volume's plan; held against the new synopsis in a second,
 * short request, what of it the chapters have not reached stays at the end, as
 * it stood, said to be the plan. The goal is the author's: it is filled where
 * it is empty, never written over.
 *
 * Only when asked: a volume's synopsis is a piece of the design like a
 * chapter's plan, and nothing here runs by itself. The synopsis as it was
 * stays in the volume's history.
 */
import type { Volume, VolumeSynopses, VolumeSynopsisResult, VolumeTold } from '../../shared/types'
import { clip, estimateTokens } from '../../shared/text'
import type { ArcSummary } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { assign } from '../crew'
import { asArray, asRecord, asText } from '../llm'
import { ProjectError, type LocatedChapter } from '../project'
import { volumePlanTask, volumeSynopsisTask, volumeSystem } from '../prompts'
import { L, promptLanguage } from '../render'
import { errorMessage, mapLimit } from '../util/async'

export type { VolumeSynopses, VolumeSynopsisResult, VolumeTold } from '../../shared/types'

/**
 * Write a volume's synopsis off its chapters.
 * @param params.volume - its id or its title.
 * @param params.apply - write it into the outline (default); false: only hand it back, for the author to look at first.
 * @throws ProjectError `novel/not-found` for no such volume; `novel/empty` for one with no chapters, or with nothing
 *   in them to go by (nothing digested, no synopsis in any outline).
 */
export async function volumeSynopsis(core: NovelCore, runtime: ProjectRuntime, params: { volume: string; apply?: boolean }, task: TaskContext): Promise<VolumeSynopsisResult> {
  const read = await readVolume(core, runtime, params, task)
  if (read.applied) await noteVolumeSynopses(runtime, [read])
  return read
}

async function readVolume(core: NovelCore, runtime: ProjectRuntime, params: { volume: string; apply?: boolean }, task: TaskContext): Promise<VolumeSynopsisResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const outline = await project.outline()
  const at = outline.volumes.findIndex(volume => volume.id === params.volume || volume.title.trim() === params.volume.trim())
  if (at < 0) throw new ProjectError('novel/not-found', `no volume matches "${params.volume}"`)
  const volume = outline.volumes[at]!
  const located = await project.chapters()
  const mine = located.filter(chapter => chapter.volume.id === volume.id)
  if (mine.length === 0) throw new ProjectError('novel/empty', `the volume "${volume.title}" has no chapters to write its synopsis from`)
  const infos = new Map((await project.chapterInfos()).map(info => [info.id, info]))
  const memories = new Map((await project.memories(mine)).map(({ chapter, memory }) => [chapter.plan.id, memory]))
  const arcs = (await project.readState<ArcSummary[]>('memory', 'arcs.json')) ?? []

  // Each chapter by what there is to tell of it.
  const label = (chapter: LocatedChapter): string => `${L(lang, `第 ${chapter.index} 章`, `Chapter ${chapter.index}`)} ${chapter.plan.title}`
  const outlined = (chapter: LocatedChapter, why: string): string => {
    const synopsis = chapter.plan.synopsis?.trim() ?? ''
    return synopsis.length > 0 ? `${label(chapter)}${why}\n${synopsis}` : `${label(chapter)}${why}${L(lang, '（章纲里也没有梗概）', ' (its outline has no synopsis either)')}`
  }
  let digested = 0
  let stale = 0
  let planned = 0
  let blank = 0
  let written = 0
  const entries = mine.map((chapter) => {
    const info = infos.get(chapter.plan.id)
    const memory = memories.get(chapter.plan.id)
    const hasText = info?.hasText === true
    if (hasText) written += 1
    if (hasText && memory !== undefined) {
      digested += 1
      const old = info?.memory === 'stale'
      if (old) stale += 1
      const note = old ? L(lang, '（这份摘要是正文改动之前收录的）', ' (digested before its text was last changed)') : ''
      return { chapter, summary: `${label(chapter)}${note}\n${memory.summary.trim()}`, brief: `${label(chapter)}${L(lang, '：', ': ')}${(memory.brief || memory.summary).trim()}` }
    }
    const why = hasText ? L(lang, '（写了，还没收录：下面是它的章纲）', ' (written, not digested: its outline)') : L(lang, '（还没写：下面是它的章纲）', ' (not written yet: its outline)')
    if ((chapter.plan.synopsis?.trim() ?? '').length > 0) planned += 1
    else blank += 1
    const told = outlined(chapter, why)
    return { chapter, summary: told, brief: told.replace(/\n/g, L(lang, '：', ': ')) }
  })
  if (blank === mine.length) throw new ProjectError('novel/empty', `nothing in the volume "${volume.title}" to write its synopsis from: no chapter of it is digested and no outline of it has a synopsis — digest the written chapters first`)

  // As much as half of what the editor's model reads; a long volume goes ten chapters at a time where the book has those stretches summed up, then a line a chapter.
  const route = await core.route('analyst', runtime, task)
  const window = await core.windowOf(route).catch(() => undefined)
  const room = Math.max(20_000, Math.floor((window ?? 200_000) / 2))
  const ids = new Set(mine.map(chapter => chapter.plan.id))
  const within = arcs.filter(arc => ids.has(arc.from) && ids.has(arc.to))
  const byArcs = (line: (entry: typeof entries[number]) => string): string => {
    const out: string[] = []
    for (const entry of entries) {
      const arc = within.find(candidate => entry.chapter.index >= candidate.fromIndex && entry.chapter.index <= candidate.toIndex)
      if (arc === undefined) { out.push(line(entry)); continue }
      if (entry.chapter.index === arc.fromIndex) out.push(`${L(lang, `第 ${arc.fromIndex}–${arc.toIndex} 章（这十章的阶段梗概）`, `Chapters ${arc.fromIndex}–${arc.toIndex} (a synopsis of these ten)`)}\n${arc.summary.trim()}`)
    }
    return out.join('\n\n')
  }
  const ways: [VolumeTold, string][] = [['summaries', entries.map(entry => entry.summary).join('\n\n')]]
  if (within.length > 0) ways.push(['arcs', byArcs(entry => entry.summary)])
  ways.push(['briefs', within.length > 0 ? byArcs(entry => entry.brief) : entries.map(entry => entry.brief).join('\n')])
  let [told, chapters] = ways.find(([, text]) => estimateTokens(text) <= room) ?? ['clipped', ways.at(-1)![1]]
  if (told === 'clipped') chapters = clip(chapters, Math.floor(chapters.length * room / estimateTokens(chapters)))

  // Where the story stood when this volume took it up. (Not the synopsis it had, nor what the next one is to be: a plan
  // shown beside the chapters is written into the story as though it had happened.)
  const previous: Volume | undefined = outline.volumes[at - 1]
  const before = previous !== undefined && (previous.synopsis?.trim() ?? '').length > 0 ? `${zh ? `「${previous.title}」：` : `"${previous.title}": `}${clip(previous.synopsis!.trim(), 600)}` : undefined
  const first = mine[0]!.index
  const last = mine.at(-1)!.index
  const volumeLabel = zh
    ? `「${volume.title}」（全书第 ${first}${last > first ? `–${last}` : ''} 章，共 ${mine.length} 章，写了 ${written} 章）`
    : `"${volume.title}" (chapter${last > first ? `s ${first}–${last}` : ` ${first}`} of the book, ${mine.length} in all, ${written} written)`

  const { value } = await assign(core, runtime, task, {
    role: 'analyst',
    label: L(lang, `「${volume.title}」· 照各章写卷梗概`, `"${volume.title}" · its synopsis from its chapters`),
    // Its chapters are all there is to it: one request, whatever the role is set to.
    plain: true,
    tool: 'submit_volume',
    what: L(lang, '这一卷照各章写的梗概', 'this volume\'s synopsis as its chapters tell it'),
    system: volumeSystem(lang),
    prompt: volumeSynopsisTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      ...(manifest.logline !== undefined ? { logline: manifest.logline } : {}),
      volumeLabel,
      ...(before !== undefined ? { before } : {}),
      chapters,
      count: mine.length,
      unfinished: written < mine.length,
    }),
    temperature: 0.2,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.synopsis) === undefined) throw new Error('"synopsis" is missing')
      return record
    },
  })
  const story = asText(value.synopsis)!.trim()

  // What the synopsis it had says that the chapters have not reached is the plan for the rest of the volume: it stays,
  // as it stood, after what the chapters tell — found by itself, the old synopsis held against the new one.
  const had = volume.synopsis?.trim() ?? ''
  let ahead = ''
  if (had.length > 0) {
    const { value: checked } = await assign(core, runtime, task, {
      role: 'analyst',
      label: L(lang, `「${volume.title}」· 对照原来的卷梗概`, `"${volume.title}" · held against the synopsis it had`),
      plain: true,
      tool: 'submit_plan',
      what: L(lang, '原来的卷梗概里，新写的梗概还没有的', 'what of the synopsis it had the new one does not have'),
      system: volumeSystem(lang),
      prompt: volumePlanTask({ lang, language: manifest.language, title: manifest.title, volume: volume.title, was: had, now: story }),
      temperature: 0,
      validate: (raw) => {
        const record = asRecord(raw)
        if (!Array.isArray(record.plan)) throw new Error('"plan" is missing')
        return record
      },
    })
    ahead = asArray(checked.plan).map(asRecord)
      .filter(point => point.reached !== true && point.reached !== 'true')
      .map(point => asText(point.point)?.trim().replace(/[。；;.,，\s]+$/u, '') ?? '')
      .filter(point => point.length > 0)
      .join(L(lang, '；', '; '))
    if (ahead.length > 0) ahead += L(lang, '。', '.')
  }
  const synopsis = `${story}${ahead.length > 0 ? `\n\n${L(lang, '往后（原来的计划）：', 'Still to come (as planned): ')}${ahead}` : ''}`
  const goal = asText(value.goal)?.trim()
  const goalSet = goal !== undefined && goal.length > 0 && (volume.goal?.trim() ?? '').length === 0
  const applied = params.apply !== false
  if (applied) {
    await project.updateOutline((draft) => {
      const target = draft.volumes.find(candidate => candidate.id === volume.id)
      if (target === undefined) return
      target.synopsis = synopsis
      // The goal is where the author means the volume to go: filled where nobody said, never written over.
      if (goalSet && (target.goal?.trim() ?? '').length === 0) target.goal = goal
    })
  }
  return {
    volumeId: volume.id,
    title: volume.title,
    synopsis,
    ...(ahead.length > 0 ? { ahead } : {}),
    ...(volume.synopsis !== undefined ? { was: volume.synopsis } : {}),
    ...(goal !== undefined && goal.length > 0 ? { goal } : {}),
    goalSet,
    chapters: mine.length,
    written,
    digested,
    stale,
    planned,
    blank,
    told,
    applied,
  }
}

/**
 * Write the synopses of several volumes off their chapters — the ones named, or every volume of the book. A volume
 * with no chapters, or nothing in them to go by, is passed over and said to be.
 */
export async function volumeSynopses(core: NovelCore, runtime: ProjectRuntime, params: { volumes?: readonly string[] }, task: TaskContext): Promise<VolumeSynopses> {
  const { project } = runtime
  const lang = promptLanguage((await project.manifest()).language)
  const outline = await project.outline()
  const wanted = params.volumes === undefined || params.volumes.length === 0
    ? outline.volumes
    : outline.volumes.filter(volume => params.volumes!.some(ref => ref === volume.id || ref.trim() === volume.title.trim()))
  const result: VolumeSynopses = { read: [], skipped: [], failed: [] }
  const order = new Map(outline.volumes.map((volume, index) => [volume.id, index]))
  let done = 0
  task.job?.progress(0, wanted.length)
  await mapLimit(wanted, await core.parallelFor('text', runtime), async (volume) => {
    try {
      if (volume.chapters.length === 0) {
        result.skipped.push({ volumeId: volume.id, title: volume.title, why: L(lang, '没有章节', 'no chapters') })
        return
      }
      // The job is the batch's: one volume's reading does not report as the whole of it.
      result.read.push(await readVolume(core, runtime, { volume: volume.id }, { ...task, job: undefined } as TaskContext))
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      if (error instanceof ProjectError && error.code === 'novel/empty') result.skipped.push({ volumeId: volume.id, title: volume.title, why: L(lang, '各章还没有可以照着写的：没收录，章纲里也没有梗概', 'nothing in its chapters to go by: none digested, no synopsis in their outlines') })
      else result.failed.push({ volumeId: volume.id, title: volume.title, error: errorMessage(error) })
    } finally {
      done += 1
      task.job?.progress(done, wanted.length, volume.title)
    }
  }, task.signal)
  const byOrder = (a: { volumeId: string }, b: { volumeId: string }): number => (order.get(a.volumeId) ?? 0) - (order.get(b.volumeId) ?? 0)
  result.read.sort(byOrder)
  result.skipped.sort(byOrder)
  result.failed.sort(byOrder)
  await noteVolumeSynopses(runtime, result.read)
  task.job?.result({ read: result.read.length, skipped: result.skipped.length, failed: result.failed.length, volumes: result.read.map(({ volumeId, title, chapters, digested, planned, goalSet }) => ({ volumeId, title, chapters, digested, planned, goalSet })) })
  return result
}

/** One line for the book's activity: whose synopses were written off their chapters. */
async function noteVolumeSynopses(runtime: ProjectRuntime, read: readonly VolumeSynopsisResult[]): Promise<void> {
  if (read.length === 0) return
  const lang = promptLanguage((await runtime.project.manifest()).language)
  const names = read.map(item => L(lang, `「${item.title}」`, `"${item.title}"`)).join(L(lang, '、', ', '))
  await runtime.project.addActivity({ by: 'crew', role: 'analyst', tool: 'outline', summary: L(lang, `${names}的卷梗概照各章重写了。原来的在分卷的历史版本里`, `The synopsis of ${names} written anew off its chapters. What was there is in the volume's history`) }).catch(() => {})
}

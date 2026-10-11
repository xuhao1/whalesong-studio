// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Notes out of the references, for a chapter about to be written.
 *
 * The writer writes in one request and has no tools: of the books this one
 * goes by it sees nothing, unless somebody looked for it. That is the
 * planner's work — an agent, with the references to read in as far as the
 * author opened each: before a chapter is written it takes notes for it, and
 * they are kept on the chapter's plan, where the author reads and corrects
 * them and every later pass at the chapter finds them.
 */
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asList, asRecord, asText } from '../llm'
import { assign, crewName, crewPlan } from '../crew'
import { ProjectError } from '../project'
import { referenceNotesTask } from '../prompts'
import { activeReferences, guideWords, referenceListing } from '../references'
import { L, promptLanguage, renderPlan } from '../render'
import { clip } from '../../shared/text'
import { MAIN_LINE } from '../../shared/types'

export interface ConsultResult {
  chapterId: string
  title: string
  index: number
  /** What the planner left for the writer. Empty: it looked, and nothing of the references is of use to this chapter. */
  notes: string
  /** What it read, as it said. */
  used: string[]
  why?: string
}

/** The planner cannot look in the references as things are: it would have to work as an agent, and is not set to — or cannot. */
export const NO_AGENT = 'novel/no-agent'

/** Chapters being looked up right now, by book and chapter: several writers at one chapter wait for the one looking. */
const underway = new Map<string, Promise<ConsultResult>>()

/**
 * Have the planner look in the book's references for one chapter and keep its notes on the chapter's plan.
 * @throws ProjectError `novel/invalid` where the book has no reference that is consulted; {@link NO_AGENT} where the
 *   planner cannot read in them (it has to work as an agent for that).
 */
export async function consultReferences(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; direction?: string }, task: TaskContext): Promise<ConsultResult> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const key = `${project.root}\n${chapter.plan.id}`
  const running = underway.get(key)
  if (running !== undefined && params.direction === undefined) return await running
  const work = (async (): Promise<ConsultResult> => {
    const manifest = await project.manifest()
    const lang = promptLanguage(manifest.language)
    if ((await activeReferences(runtime)).length === 0) throw new ProjectError('novel/invalid', L(lang, '这本书还没有在用的参考文献', 'this book has no reference that is consulted'))
    const name = crewName('architect', lang)
    // Without tools nothing can be read in a reference, and notes written all the same would be made up.
    const route = await core.route('architect', runtime, task)
    if (crewPlan(core, 'architect', manifest).mode === 'call' || core.roles === undefined || !core.roles.can(route)) {
      throw new ProjectError(NO_AGENT, L(lang, `${name}要作为 agent 才能到参考文献里去查（它现在是一问一答，没有工具）。到“设置 → 模型”把 agent 能力范围改成 agent 模式，或者自己在章纲的“参考摘记”里写。`, `${name} has to work as an agent to read in the references (it is set to plain calls now, and has no tools). Set it to agent mode under Settings → Models, or write the chapter's reference notes yourself.`))
    }
    const listing = await referenceListing(core, runtime, lang)
    const path = await project.pathOf(chapter.plan.id)
    const at = path.findIndex(item => item.plan.id === chapter.plan.id)
    const previous = at > 0 ? path[at - 1] : undefined
    const before = previous !== undefined ? `${L(lang, `上一章《${previous.plan.title}》`, `The chapter before, "${previous.plan.title}"`)}${L(lang, '：', ': ')}${clip((await project.memory(previous.plan.id))?.summary ?? previous.plan.synopsis ?? '', 400, '…')}` : ''
    const everyone = await project.characters()
    const { value, run } = await assign<Record<string, unknown>>(core, runtime, task, {
      role: 'architect',
      label: L(lang, `为第 ${chapter.index} 章查参考文献`, `Reading the references for chapter ${chapter.index}`),
      tool: 'reference_notes',
      what: L(lang, '给写手的参考摘记', 'the notes out of the references, for the writer'),
      line: chapter.line ?? MAIN_LINE,
      prompt: referenceNotesTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        chapter: renderPlan(chapter.plan, chapter.index, lang, id => everyone.find(card => card.id === id)?.name ?? id),
        ...(before.length > 0 ? { before } : {}),
        references: `${listing?.guide !== undefined ? `${guideWords(listing.guide, lang)}\n\n` : ''}${listing?.lines ?? ''}`,
        ...(params.direction !== undefined && params.direction.trim().length > 0 ? { direction: params.direction.trim() } : {}),
      }),
      temperature: 0.4,
      validate: (raw) => {
        const record = asRecord(raw)
        if (typeof record.notes !== 'string') throw new Error('"notes" is missing: the notes for the writer, or an empty string where the references have nothing for this chapter')
        return record
      },
    })
    // Answered in one plain call after all (the agent could not run): nothing was read, so nothing is kept.
    if (run.by !== 'agent') throw new ProjectError(NO_AGENT, L(lang, `${name}这次没能作为 agent 运行，没有读到参考文献：摘记没有留。`, `${name} could not run as an agent this time and read nothing of the references: no notes were kept.`))
    const notes = (asText(value.notes) ?? '').trim()
    const why = asText(value.why)
    // Looked at, whatever came of it: an empty hand is kept as that, and nobody looks again by itself.
    await project.updateChapter(chapter.plan.id, { referenceNotes: notes, referencesRead: true })
    const result: ConsultResult = { chapterId: chapter.plan.id, title: chapter.plan.title, index: chapter.index, notes, used: asList(value.used), ...(why !== undefined ? { why } : {}) }
    task.job?.result({ chapterId: chapter.plan.id, referenced: { chars: notes.length, used: result.used, ...(why !== undefined ? { why } : {}) } })
    return result
  })()
  underway.set(key, work)
  try {
    return await work
  } finally {
    if (underway.get(key) === work) underway.delete(key)
  }
}

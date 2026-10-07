// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Drafting: the prose model writes a chapter from its outline and a packed
 * context. The orchestrator never writes prose itself — it decides what gets
 * written and passes a brief; this pipeline turns that into text on disk.
 */
import type { ChapterInfo } from '../../shared/types'
import { clipTail, countWords, normalizeProse } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { LlmCallError, type LlmResponse } from '../llm'
import type { LocatedChapter } from '../project'
import { ProjectError } from '../project'
import { writerSystem, writerTask } from '../prompts'
import { promptLanguage, renderStyle } from '../render'
import { digestChapter, updateArcs } from './digest'

export interface WriteParams {
  /** Chapter reference; `next` (default) picks the first outlined chapter without text. */
  chapter?: string
  /** What this pass should achieve, in the orchestrator's or the user's words. */
  brief?: string
  /** `draft` writes the chapter from the top (replacing any text), `continue` appends. */
  mode?: 'draft' | 'continue'
  /** Target length of the text produced by this call. */
  words?: number
  /** Style profile to use instead of the project's active one. */
  style?: string
  /** Characters to keep in view besides the ones the outline names. */
  characters?: string[]
  /** Override of the auto-digest setting for this call. */
  digest?: boolean
}

export interface WriteResult {
  chapterId: string
  title: string
  index: number
  mode: 'draft' | 'continue'
  /** Words written by this call. */
  wordsWritten: number
  /** Words of the chapter after saving. */
  wordsTotal: number
  model: string
  strategy: string
  contextTokens: number
  cast: string[]
  digested: boolean
  /** True when the model hit its output limit and the text was completed by continuation. */
  continued: boolean
  /** The opening and the closing of what was written, for the orchestrator to judge without rereading. */
  preview: { head: string; tail: string }
  brief?: string
}

/** Remove what models add around prose against instructions: fences, titles, lead-ins. */
export function cleanProse(reply: string, title?: string): string {
  let text = reply.replace(/\r\n?/g, '\n').trim()
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  const lines = text.split('\n')
  // Drop a leading heading or a restated chapter title.
  for (let i = 0; i < 2 && lines.length > 1; i++) {
    const first = lines[0]!.trim()
    const plain = first.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim()
    const isHeading = first.startsWith('#')
      || /^第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节卷]/.test(plain)
      || /^chapter\s+\d+/i.test(plain)
      || (title !== undefined && title.length > 0 && plain === title)
      || /^(正文|以下是正文|以下为正文)[:：]?$/.test(plain)
    if (!isHeading || plain.length > 40) break
    lines.shift()
    while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift()
  }
  return normalizeProse(lines.join('\n'))
}

async function pickChapter(runtime: ProjectRuntime, ref: string | undefined): Promise<LocatedChapter> {
  const { project } = runtime
  if (ref === undefined || /^(next|下一章|下一个)$/i.test(ref.trim())) {
    const infos = await project.chapterInfos()
    const next: ChapterInfo | undefined = infos.find(info => !info.hasText)
    if (next === undefined) throw new ProjectError('novel/not-found', 'every outlined chapter already has text — add a chapter to the outline first (novel_outline or novel_derive)')
    return (await project.findChapter(next.id))!
  }
  const chapter = await project.findChapter(ref)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
  return chapter
}

export async function writeChapter(core: NovelCore, runtime: ProjectRuntime, params: WriteParams, task: TaskContext): Promise<WriteResult> {
  const { project } = runtime
  const chapter = await pickChapter(runtime, params.chapter)
  // Named at once, so a Studio showing this chapter can tail the stream while it is written.
  task.job?.result({ chapterId: chapter.plan.id })
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const existing = await project.chapterText(chapter.plan.id)
  const mode = params.mode ?? 'draft'
  if (mode === 'continue' && existing.length === 0) return await writeChapter(core, runtime, { ...params, mode: 'draft', chapter: chapter.plan.id }, task)

  const style = params.style !== undefined ? await project.findStyle(params.style) : await project.activeStyle()
  if (params.style !== undefined && style === undefined) throw new ProjectError('novel/not-found', `no style matches "${params.style}"`)
  const target = Math.max(200, Math.round(params.words ?? chapter.plan.targetWords ?? manifest.chapterWords ?? (lang === 'zh' ? 3000 : 2500)))
  const route = await core.route('writer', runtime, task)

  task.job?.progress(0, 3, lang === 'zh' ? '整理上下文' : 'packing context')
  const pack = await core.pack(runtime, route, {
    purpose: mode === 'continue' ? 'continue' : 'draft',
    chapter,
    ...(params.brief !== undefined ? { brief: params.brief } : {}),
    ...(params.characters !== undefined ? { characters: params.characters } : {}),
    includeChapterText: mode === 'continue',
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })

  const base = { lang, language: manifest.language, title: manifest.title }
  const system = writerSystem({ ...base, style: renderStyle(style, lang), words: target, continuing: mode === 'continue' })

  task.job?.progress(1, 3, lang === 'zh' ? '写作中' : 'writing')
  let written = ''
  let continued = false
  let response: LlmResponse | undefined
  for (let round = 0; round < 4; round++) {
    const soFar = written
    const prompt = round === 0
      ? writerTask({ ...base, context: pack.text, ...(params.brief !== undefined ? { brief: params.brief } : {}), continuing: mode === 'continue' })
      // The model ran out of output room mid-chapter: show it what it wrote and let it finish.
      : writerTask({
          ...base,
          context: `${pack.text}\n\n## ${lang === 'zh' ? '本章已有正文' : 'This chapter so far'}\n\n${mode === 'continue' ? clipTail(existing, 2000) + '\n\n' : ''}${soFar}`,
          ...(params.brief !== undefined ? { brief: params.brief } : {}),
          continuing: true,
        })
    let partial = ''
    try {
      response = await core.llm.complete({
        route,
        system: round === 0 ? system : writerSystem({ ...base, style: renderStyle(style, lang), words: Math.max(300, target - countWords(soFar)), continuing: true }),
        prompt,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
        onText: (_delta, total) => {
          partial = total
          task.job?.rewrite(soFar.length > 0 ? `${soFar}\n\n${total}` : total)
        },
      })
    } catch (error) {
      // A continuation that comes back with nothing leaves the chapter as far as it got; the rounds before it are not thrown away.
      if (soFar.length > 0 && error instanceof LlmCallError && (error.code === 'EMPTY_RESPONSE' || error.code === 'TRUNCATED')) {
        core.log(`continuing ${chapter.plan.id} got no further`, error)
        break
      }
      // Stopped mid-chapter: what was written is kept when it replaces nothing (an empty chapter, or a continuation).
      const kept = [soFar, cleanProse(partial, chapter.plan.title)].filter(part => part.trim().length > 0).join('\n\n')
      if (task.signal?.aborted === true && kept.length > 0 && (mode === 'continue' || existing.length === 0)) {
        await project.saveChapterText(chapter.plan.id, mode === 'continue' ? `${existing}\n\n${kept}` : kept, { reason: 'before-continue' })
      }
      throw error
    }
    const piece = cleanProse(response.text, chapter.plan.title)
    written = soFar.length > 0 ? `${soFar}\n\n${piece}` : piece
    if (response.finish !== 'max-tokens' || countWords(written) >= target * 1.4) break
    continued = true
  }
  // The model wrote something, and all of it was a heading or a fence.
  if (written.trim().length === 0) throw new ProjectError('novel/empty', lang === 'zh' ? '写手模型的回复里没有正文（只有标题或空白）。请再试一次。' : 'the writer model\'s reply held no prose (only a heading or blank lines) — try again')

  const finalText = mode === 'continue' ? `${existing}\n\n${written}` : written
  task.job?.rewrite(written)
  const saved = await project.saveChapterText(chapter.plan.id, finalText, { reason: mode === 'continue' ? 'before-continue' : 'before-redraft' })

  let digested = false
  const wantDigest = params.digest ?? core.currentSettings().autoDigest
  if (wantDigest) {
    task.job?.progress(2, 3, lang === 'zh' ? '收录记忆' : 'digesting')
    try {
      await digestChapter(core, runtime, chapter.plan.id, task)
      await updateArcs(core, runtime, task)
      digested = true
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      // The prose is saved; a failed digest only means memory is stale and can be redone.
      core.log(`digest after writing ${chapter.plan.id} failed`, error)
    }
  }
  task.job?.progress(3, 3)
  task.job?.result({ chapterId: chapter.plan.id })

  return {
    chapterId: chapter.plan.id,
    title: chapter.plan.title,
    index: chapter.index,
    mode,
    wordsWritten: countWords(written),
    wordsTotal: saved.words,
    model: `${route.provider}/${route.model}`,
    strategy: pack.strategy,
    contextTokens: pack.tokens,
    cast: pack.cast.map(card => card.name),
    digested,
    continued,
    preview: { head: written.slice(0, 220), tail: written.length > 440 ? written.slice(-220) : '' },
    ...(params.brief !== undefined ? { brief: params.brief } : {}),
  }
}

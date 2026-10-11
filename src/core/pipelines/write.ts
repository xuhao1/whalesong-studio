// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Drafting: the prose model writes a chapter from its outline and a packed
 * context. The orchestrator never writes prose itself — it decides what gets
 * written and passes a brief; this pipeline turns that into text on disk.
 */
import { chapterBudgetOf, MAIN_LINE, type ChapterInfo, type PictureGuide, type PicturesRead } from '../../shared/types'
import { clipTail, countWords, normalizeProse, proseOnly } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { LlmCallError, type LlmResponse } from '../llm'
import type { LocatedChapter } from '../project'
import { ProjectError } from '../project'
import { writerSystem, writerTask } from '../prompts'
import { promptLanguage, renderStyle } from '../render'
import { consultsBeforeWriting } from '../references'
import { isAbort } from '../util/async'
import { consultReferences } from './consult'
import { digestChapter, updateArcs } from './digest'
import { guidePictures, picturesLabel, picturesRead } from './guides'

export interface WriteParams {
  /** Chapter reference; `next` (default) picks the first outlined chapter without text. */
  chapter?: string
  /** What this pass should achieve, in the orchestrator's or the user's words. */
  brief?: string
  /** `draft` writes the chapter from the top (replacing any text), `continue` appends. */
  mode?: 'draft' | 'continue'
  /** A length recommended for the text this call produces. Left out: the chapter's own, else the book's, else the writer judges. */
  words?: number
  /** With `chapter` left out or `next`: the line of the plot to go on with, when it is not the main one. */
  line?: string
  /** Style profile to use instead of the project's active one. */
  style?: string
  /** Characters to keep in view besides the ones the outline names. */
  characters?: string[]
  /** Override of the auto-digest setting for this call. */
  digest?: boolean
  /** Pictures to write this pass by, instead of the ones kept on the chapter's plan. */
  guides?: PictureGuide[]
  /**
   * Write, and hand the text back: the chapter keeps what it has, nothing is digested, and nothing is shown as it is
   * written (several writers may be at the same chapter at once, each to be compared with the others).
   */
  dry?: boolean
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
  /** The length the writer was asked for; absent when it was left to judge. */
  budget?: number
  model: string
  /** How the story so far travelled: `full`, `window` (the nearest chapters word for word, the rest in outline) or `retrieval`. */
  strategy: string
  contextTokens: number
  /** The chapters before this one that were sent word for word, by their place on the line. */
  window?: { from: number; to: number }
  /** Chapters after this one that were sent word for word (a chapter being rewritten). */
  following?: number
  /** Input tokens the provider read from its cache, when it said. */
  cachedTokens?: number
  /** The line of the plot the chapter is on, when it is not the main one. */
  line?: string
  cast: string[]
  digested: boolean
  /** True when the model hit its output limit and the text was completed by continuation. */
  continued: boolean
  /** The opening and the closing of what was written, for the orchestrator to judge without rereading. */
  preview: { head: string; tail: string }
  /** `dry`: the text itself, which was not saved. */
  text?: string
  brief?: string
  /** Where the author gave pictures for the chapter: how many, and who looked at them. */
  pictures?: PicturesRead
  /**
   * The book has references: what the writer was handed of them — the notes kept on the chapter's plan. `fresh`: the
   * planner took them just now, for this pass. `none`: no notes went along, and why (the planner looked and found
   * nothing of use, or could not look).
   */
  referenced?: { chars: number; fresh?: boolean; none?: string }
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

async function pickChapter(runtime: ProjectRuntime, ref: string | undefined, line: string | undefined): Promise<LocatedChapter> {
  const { project } = runtime
  const on = line !== undefined && line !== MAIN_LINE ? (await project.findLine(line))?.id : undefined
  if (line !== undefined && line !== MAIN_LINE && on === undefined) throw new ProjectError('novel/not-found', `no plot line matches "${line}"`)
  if (ref === undefined || /^(next|下一章|下一个)$/i.test(ref.trim())) {
    const infos = await project.chapterInfos(on)
    const next: ChapterInfo | undefined = infos.find(info => !info.hasText)
    if (next === undefined) throw new ProjectError('novel/not-found', `every outlined chapter${on !== undefined ? ' of this line' : ''} already has text — add a chapter to the outline first (novel_outline or novel_derive)`)
    return (await project.findChapter(next.id))!
  }
  const chapter = await project.findChapter(ref, on)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
  return chapter
}

export async function writeChapter(core: NovelCore, runtime: ProjectRuntime, params: WriteParams, task: TaskContext): Promise<WriteResult> {
  const { project } = runtime
  const chapter = await pickChapter(runtime, params.chapter, params.line)
  const dry = params.dry === true
  // Named at once, so a Studio showing this chapter can tail the stream while it is written.
  if (!dry) task.job?.result({ chapterId: chapter.plan.id })
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const existing = await project.chapterText(chapter.plan.id)
  const mode = params.mode ?? 'draft'
  if (mode === 'continue' && existing.length === 0) return await writeChapter(core, runtime, { ...params, mode: 'draft', chapter: chapter.plan.id }, task)
  // A chapter of another line is found by its id from here on.
  const { line: _line, ...rest } = params
  params = { ...rest, chapter: chapter.plan.id }

  const style = params.style !== undefined ? await project.findStyle(params.style) : await project.activeStyle()
  if (params.style !== undefined && style === undefined) throw new ProjectError('novel/not-found', `no style matches "${params.style}"`)
  // A recommended length, when somebody set one: for this call, for the chapter, or for the book. Otherwise the writer judges.
  const wished = [params.words, chapter.plan.targetWords, chapterBudgetOf(manifest)].find(value => value !== undefined && value > 0)
  const target = wished !== undefined ? Math.max(200, Math.round(wished)) : undefined
  // Left to judge, the writer is told how long the book's chapters have been running.
  const lengths = target === undefined ? (await project.chapterInfos(chapter.line)).filter(info => info.hasText && info.id !== chapter.plan.id).map(info => info.words) : []
  const usual = lengths.length >= 2 ? Math.round(lengths.reduce((sum, words) => sum + words, 0) / lengths.length / 100) * 100 : undefined
  const route = await core.route('writer', runtime, task)
  // The pictures the author gave this chapter — for this pass, or kept on its plan: the writer looks at them, or is told what they show.
  const guided = await guidePictures(core, runtime, route, params.guides ?? chapter.plan.guides, 'chapter', task)

  // The books this one goes by: the writer has no tools to read in them, so the planner looks for it — once for a
  // chapter, its notes kept on the chapter's plan — unless the author turned that off or wrote the notes themselves.
  let referenceNotes = chapter.plan.referenceNotes
  let referenced: WriteResult['referenced']
  if (await consultsBeforeWriting(runtime)) {
    if (referenceNotes === undefined && chapter.plan.referencesRead !== true) {
      const restore = dry ? undefined : task.job?.note(lang === 'zh' ? '策划在为这一章查参考文献…' : 'The planner is reading the references for this chapter…')
      try {
        referenceNotes = (await consultReferences(core, runtime, { chapter: chapter.plan.id }, task)).notes
        referenced = { chars: referenceNotes.length, fresh: true, ...(referenceNotes.length === 0 ? { none: lang === 'zh' ? '策划查过，这一章用不上参考文献' : 'the planner looked: the references have nothing for this chapter' } : {}) }
      } catch (error) {
        if (isAbort(error) || task.signal?.aborted === true) throw error
        core.log(`could not take notes in the references for ${chapter.plan.id}; writing without them`, error)
        referenced = { chars: 0, none: error instanceof Error ? error.message : String(error) }
      } finally {
        restore?.()
      }
    } else referenced = { chars: referenceNotes?.length ?? 0, ...(referenceNotes === undefined ? { none: lang === 'zh' ? '这一章的参考摘记是空的' : 'this chapter\'s reference notes are empty' } : {}) }
    if (!dry && referenced !== undefined) task.job?.result({ referenced })
  } else if (referenceNotes !== undefined && referenceNotes.trim().length > 0) {
    // Nobody looks before writing here, but the chapter has notes — the author's own, or the planner's of an earlier day: they go along.
    referenced = { chars: referenceNotes.length }
  }
  const notesForWriter = referenceNotes !== undefined && referenceNotes.trim().length > 0 ? { references: referenceNotes } : {}

  if (!dry) task.job?.progress(0, 3, lang === 'zh' ? '整理上下文' : 'packing context')
  const pack = await core.pack(runtime, route, {
    purpose: mode === 'continue' ? 'continue' : 'draft',
    chapter,
    ...(params.brief !== undefined ? { brief: params.brief } : {}),
    ...(params.characters !== undefined ? { characters: params.characters } : {}),
    includeChapterText: mode === 'continue',
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })

  const base = { lang, language: manifest.language, title: manifest.title }
  // The same for every chapter of the book: with the story so far behind it, the head of the request a provider can keep.
  const system = writerSystem({ ...base, style: renderStyle(style, lang) })
  const length = (written: number): { words?: number; usual?: number } => target !== undefined ? { words: Math.max(300, target - written) } : usual !== undefined ? { usual } : {}

  if (!dry) task.job?.progress(1, 3, `${lang === 'zh' ? '写作中' : 'writing'}${picturesLabel(guided, lang)}`)
  let written = ''
  let continued = false
  let cached = 0
  let response: LlmResponse | undefined
  for (let round = 0; round < 4; round++) {
    const soFar = written
    const prompt = round === 0
      ? writerTask({ ...base, context: pack.rest, ...(params.brief !== undefined ? { brief: params.brief } : {}), ...(guided !== undefined ? { pictures: guided.text } : {}), ...notesForWriter, continuing: mode === 'continue', ...(target !== undefined ? { words: target } : usual !== undefined ? { usual } : {}) })
      // The model ran out of output room mid-chapter: show it what it wrote and let it finish.
      : writerTask({
          ...base,
          context: `${pack.rest}\n\n## ${lang === 'zh' ? '本章已有正文' : 'This chapter so far'}\n\n${mode === 'continue' ? clipTail(existing, (await core.settingsOf(runtime)).context.tailChars) + '\n\n' : ''}${soFar}`,
          ...(params.brief !== undefined ? { brief: params.brief } : {}),
          ...(guided !== undefined ? { pictures: guided.text } : {}),
          ...notesForWriter,
          continuing: true,
          ...length(countWords(soFar)),
        })
    let partial = ''
    try {
      response = await core.llm.complete({
        route,
        system,
        ...(pack.stable.length > 0 ? { stable: pack.stable } : {}),
        prompt,
        ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
        onText: (_delta, total) => {
          partial = total
          if (!dry) task.job?.rewrite(soFar.length > 0 ? `${soFar}\n\n${total}` : total)
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
      if (!dry && task.signal?.aborted === true && kept.length > 0 && (mode === 'continue' || existing.length === 0)) {
        await project.saveChapterText(chapter.plan.id, mode === 'continue' ? `${existing}\n\n${kept}` : kept, { reason: 'before-continue' })
      }
      throw error
    }
    cached += response.usage?.cachedTokens ?? 0
    const piece = cleanProse(response.text, chapter.plan.title)
    written = soFar.length > 0 ? `${soFar}\n\n${piece}` : piece
    if (response.finish !== 'max-tokens' || (target !== undefined && countWords(written) >= target * 1.4)) break
    continued = true
  }
  // The model wrote something, and all of it was a heading or a fence.
  if (written.trim().length === 0) throw new ProjectError('novel/empty', lang === 'zh' ? '写手模型的回复里没有正文（只有标题或空白）。请再试一次。' : 'the writer model\'s reply held no prose (only a heading or blank lines) — try again')

  const finalText = mode === 'continue' ? `${existing}\n\n${written}` : written
  if (!dry) task.job?.rewrite(written)
  // Written to be compared: the chapter keeps its text, and the draft goes back to whoever asked.
  const saved = dry ? { words: countWords(proseOnly(finalText)), changed: false } : await project.saveChapterText(chapter.plan.id, finalText, { reason: mode === 'continue' ? 'before-continue' : 'before-redraft' })

  let digested = false
  const wantDigest = !dry && (params.digest ?? core.currentSettings().autoDigest)
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
  if (!dry) {
    task.job?.progress(3, 3)
    task.job?.result({ chapterId: chapter.plan.id })
  }

  return {
    chapterId: chapter.plan.id,
    title: chapter.plan.title,
    index: chapter.index,
    mode,
    wordsWritten: countWords(written),
    wordsTotal: saved.words,
    ...(target !== undefined ? { budget: target } : {}),
    model: `${route.provider}/${route.model}`,
    strategy: pack.strategy,
    contextTokens: pack.tokens,
    ...(pack.window !== undefined ? { window: pack.window } : {}),
    ...(pack.included.following > 0 ? { following: pack.included.following } : {}),
    ...(cached > 0 ? { cachedTokens: cached } : {}),
    ...(chapter.line !== undefined ? { line: chapter.line } : {}),
    cast: pack.cast.map(card => card.name),
    digested,
    continued,
    preview: { head: written.slice(0, 220), tail: written.length > 440 ? written.slice(-220) : '' },
    ...(params.brief !== undefined ? { brief: params.brief } : {}),
    ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}),
    ...(referenced !== undefined ? { referenced } : {}),
    ...(dry ? { text: finalText } : {}),
  }
}

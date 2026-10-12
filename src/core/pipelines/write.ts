// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Drafting: the prose model writes a chapter from its outline and a packed
 * context. The orchestrator never writes prose itself — it decides what gets
 * written and passes a brief; this pipeline turns that into text on disk.
 */
import { keptPictures } from '../../shared/embedded'
import { chapterBudgetOf, MAIN_LINE, type Beat, type ChapterInfo, type FiguresKept, type MaterialUsed, type PictureGuide, type PicturesRead } from '../../shared/types'
import { clip, clipTail, countWords, estimateTokens, normalizeProse, proseOnly } from '../../shared/text'
import type { ContextPack } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { LlmCallError, type LlmResponse } from '../llm'
import type { LocatedChapter } from '../project'
import { ProjectError } from '../project'
import { partHow, writerSystem, writerTask } from '../prompts'
import { promptLanguage, renderStyle } from '../render'
import { activeReferences, consultsBeforeWriting, referenceGuide } from '../references'
import { errorMessage, isAbort } from '../util/async'
import { consultReferences } from './consult'
import { digestChapter, updateArcs } from './digest'
import { guidePictures, picturesLabel, picturesRead } from './guides'
import { composeChapter, type Composed } from './compose'
import { keepMaterial, materialUsed, prepareMaterial, writingBy } from './material'

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
   * How the chapter is written. `planner` / `rules`: by the writer in one request, from what the planner prepared or
   * the Studio packed by rule. `agent`: by the writer as an agent — nobody prepares anything; it reads in the book
   * for itself, hands the text in with a tool and goes over it as often as it sees fit (`composeChapter`). Left out:
   * as the settings say (`materialBy`: the planner prepares, unless the author has it otherwise).
   */
  material?: 'planner' | 'rules' | 'agent'
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
  /** The chapter was asked to be longer than a model writes in one go, and was written in this many parts, beat by beat. */
  parts?: number
  /** A length was asked for and what was written is well short of it (by more than the 15% the writer is allowed): said, not hidden. */
  short?: { asked: number; words: number }
  /** Memory was to be digested after the writing and was not: why. The text is saved all the same. */
  undigested?: string
  /** The opening and the closing of what was written, for the orchestrator to judge without rereading. */
  preview: { head: string; tail: string }
  /** `dry`: the text itself, which was not saved. */
  text?: string
  /** `dry`: all the writer read to write it — kept by whoever keeps the draft, since nothing is kept on the chapter for it. */
  handed?: string
  brief?: string
  /** What the writer was handed, and who put it together: the planner, for this chapter, or the Studio by its rules. */
  material?: MaterialUsed
  /** Where the author gave pictures for the chapter: how many, and who looked at them. */
  pictures?: PicturesRead
  /**
   * The pictures in the chapter's text: `back` — how many the chapter had before it was drafted over, carried into the
   * new draft (after the lines most like the ones they stood by, else as far down as they stood); `made` — how many
   * picture lines the writer put in of its own making, taken out.
   */
  figures?: FiguresKept
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

/** About what a model writes when it is asked for a chapter in one go, whatever length it is asked for: a part is no longer. */
const PART_WORDS = 3000

/**
 * The parts a chapter is written in, where it is asked to be longer than one request yields: its beats in runs, each
 * with its share of the length. Undefined where it is written in one go — no length asked for, one short enough, or
 * a plan without beats to part it by.
 */
export function partsOf(beats: readonly Beat[] | undefined, target: number | undefined): { from: number; to: number; words: number }[] | undefined {
  if (target === undefined || beats === undefined || beats.length < 2 || target <= PART_WORDS * 1.4) return undefined
  const count = Math.min(beats.length, Math.ceil(target / PART_WORDS))
  const parts: { from: number; to: number; words: number }[] = []
  for (let part = 0; part < count; part++) {
    const from = Math.floor(part * beats.length / count)
    const to = Math.floor((part + 1) * beats.length / count) - 1
    parts.push({ from, to, words: Math.max(300, Math.round(target * (to - from + 1) / beats.length / 50) * 50) })
  }
  return parts
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
  // With the notes goes what the author asks of the references at large, where the book still has any: what the notes are for.
  const overall = referenceNotes !== undefined && referenceNotes.trim().length > 0 && (await activeReferences(runtime)).length > 0 ? await referenceGuide(runtime) : undefined
  const notesForWriter = referenceNotes !== undefined && referenceNotes.trim().length > 0 ? { references: referenceNotes, ...(overall !== undefined ? { referenceGuide: overall } : {}) } : {}

  // How the chapter is written. By the writer as an agent, where the author has it so: nobody prepares anything — it
  // reads in the book for itself, hands the text in and goes over it. Otherwise in one request, from what it is
  // handed: the planner looks at the piece first — reads in the book as far as this chapter needs — and chooses it;
  // where the author has it otherwise, or the planner cannot be asked, the Studio packs it by rule.
  const way = writingBy(core, params.material)
  const base = { lang, language: manifest.language, title: manifest.title }
  // The same for every chapter of the book: with the story so far behind it, the head of the request a provider can keep.
  const system = writerSystem({ ...base, style: renderStyle(style, lang) })
  const length = (written: number): { words?: number; usual?: number } => target !== undefined ? { words: Math.max(300, target - written) } : usual !== undefined ? { usual } : {}

  const work = mode === 'continue' ? 'continue' as const : 'draft' as const
  const asked = params.brief !== undefined && params.brief.trim().length > 0 ? { instruction: params.brief.trim() } : {}
  let written = ''
  let handed = ''
  let continued = false
  let cached = 0
  let pack: ContextPack
  let material: MaterialUsed
  let composed: Composed | undefined
  let instead: string | undefined
  if (way === 'agent') {
    if (!dry) task.job?.progress(1, 3, `${lang === 'zh' ? '写手自己读书、动笔' : 'the writer reads and writes for itself'}${picturesLabel(guided, lang)}`)
    try {
      composed = await composeChapter(core, runtime, {
        chapter,
        mode,
        ...(params.brief !== undefined ? { brief: params.brief } : {}),
        route,
        system,
        task: (context, how, keyed) => writerTask({ ...base, context, ...(keyed ? { keyed: true } : {}), ...(params.brief !== undefined ? { brief: params.brief } : {}), ...(guided !== undefined ? { pictures: guided.text } : {}), ...notesForWriter, continuing: mode === 'continue', ...(target !== undefined ? { words: target } : usual !== undefined ? { usual } : {}), how }),
        ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
        ...(target !== undefined ? { target } : {}),
        clean: text => cleanProse(text, chapter.plan.title),
        dry,
      }, task)
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      // The chapter is written all the same — the other way, and the result says why.
      instead = clip(errorMessage(error), 240)
      core.log(`the writer could not write ${chapter.plan.id} as an agent; writing it in one request`, error)
    }
  }
  if (composed !== undefined) {
    written = composed.text
    handed = composed.handed
    pack = composed.pack
    material = { ...composed.used, tokens: estimateTokens(handed) }
    if (!dry) {
      task.job?.result({ chapterId: chapter.plan.id, material })
      // What it was given to start from is kept for the author to look at; what it read beside is in its own run.
      await keepMaterial(runtime, { ...material, chapter: chapter.plan.id, work, ...asked, text: handed }).catch((error: unknown) => { core.log(`could not keep the material of ${chapter.plan.id}`, error) })
    }
  } else {
    const byPlanner = way !== 'rules'
    if (!dry) task.job?.progress(0, 3, byPlanner ? (lang === 'zh' ? '策划在看这一章要什么、备材料' : 'the planner is preparing the material') : lang === 'zh' ? '整理上下文' : 'packing context')
    const prepared = await prepareMaterial(core, runtime, {
      work: mode === 'continue' ? 'continue' : 'draft',
      chapter,
      ...(params.brief !== undefined ? { instruction: params.brief } : {}),
      ...(mode === 'continue' ? { text: existing } : {}),
      ...(referenceNotes !== undefined && referenceNotes.trim().length > 0 ? { notes: referenceNotes } : {}),
      budget: await core.materialBudget(runtime, route),
      ...(params.material !== undefined && params.material !== 'agent' ? { by: params.material } : {}),
    }, task)
    pack = await core.pack(runtime, route, {
      purpose: mode === 'continue' ? 'continue' : 'draft',
      chapter,
      ...(params.brief !== undefined ? { brief: params.brief } : {}),
      ...(params.characters !== undefined ? { characters: params.characters } : {}),
      includeChapterText: mode === 'continue',
      ...(prepared.chosen !== undefined ? { chosen: prepared.chosen } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    })
    // (Meant for the writer as an agent, and written this way when that came to nothing: said with what was handed.)
    material = { ...materialUsed(prepared, pack), ...(instead !== undefined ? { instead } : {}) }
    if (!dry) task.job?.result({ chapterId: chapter.plan.id, material })


    if (!dry) task.job?.progress(1, 3, `${lang === 'zh' ? '写作中' : 'writing'}${picturesLabel(guided, lang)}`)
    let response: LlmResponse | undefined
    // What the chapter was derived with went along: the key it sets is named again with what is asked last.
    const keyed = pack.included.intent !== undefined ? { keyed: true } : {}
    // A chapter asked to be longer than a model writes in one go is written in parts, beat by beat: the same material
    // and the text so far each time (so the head of every request is the one a provider has kept), each part told
    // which beats are its own and where to stop. A model asked for ten thousand words in one request writes the
    // chapter to its end in half of that, and nothing brings the other half.
    const parts = mode === 'draft' ? partsOf(chapter.plan.beats, target) : undefined
    let at = 0
    for (let round = 0; round < (parts !== undefined ? parts.length + 3 : 4); round++) {
      const soFar = written
      const part = parts?.[at]
      // What the parts before this one fell short of is made up over the parts still to come: this part's share of
      // what is left, by its beats (and never so much that one request could not hold it).
      const beatsLeft = part !== undefined ? chapter.plan.beats!.length - part.from : 0
      const share = part !== undefined ? Math.round((target! - countWords(proseOnly(soFar))) * (part.to - part.from + 1) / beatsLeft / 50) * 50 : 0
      const partly = part !== undefined
        ? { words: Math.max(300, Math.min(Math.round(PART_WORDS * 1.6), Math.max(part.words, share))), how: partHow({ ...base, at, of: parts!.length, from: part.from, beats: chapter.plan.beats!.slice(part.from, part.to + 1).map(beat => beat.summary), whole: target! }) }
        : undefined
      if (!dry && parts !== undefined) task.job?.progress(1, 3, `${lang === 'zh' ? `写作中（第 ${at + 1}/${parts.length} 段）` : `writing (part ${at + 1} of ${parts.length})`}${picturesLabel(guided, lang)}`)
      const prompt = round === 0
        ? writerTask({ ...base, context: pack.rest, ...keyed, ...(params.brief !== undefined ? { brief: params.brief } : {}), ...(guided !== undefined ? { pictures: guided.text } : {}), ...notesForWriter, continuing: mode === 'continue', ...(partly ?? (target !== undefined ? { words: target } : usual !== undefined ? { usual } : {})) })
        // The model ran out of output room mid-chapter: show it what it wrote and let it finish.
        : writerTask({
            ...base,
            context: `${pack.rest}\n\n## ${lang === 'zh' ? '本章已有正文' : 'This chapter so far'}\n\n${mode === 'continue' ? clipTail(existing, (await core.settingsOf(runtime)).context.tailChars) + '\n\n' : ''}${soFar}`,
            ...keyed,
            ...(params.brief !== undefined ? { brief: params.brief } : {}),
            ...(guided !== undefined ? { pictures: guided.text } : {}),
            ...notesForWriter,
            continuing: true,
            ...(partly ?? length(countWords(soFar))),
          })
      // What it read is kept for the author to look at: the material, and what was asked last.
      if (round === 0) handed = [pack.stable, prompt].filter(part => part.length > 0).join('\n\n')
      if (round === 0 && !dry) await keepMaterial(runtime, { ...material, chapter: chapter.plan.id, work: mode === 'continue' ? 'continue' : 'draft', ...(params.brief !== undefined && params.brief.trim().length > 0 ? { instruction: params.brief.trim() } : {}), text: handed }).catch((error: unknown) => { core.log(`could not keep the material of ${chapter.plan.id}`, error) })
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
      // Cut short by the model's own limit: the same part is gone on with.
      if (response.finish === 'max-tokens' && !(target !== undefined && countWords(written) >= target * 1.4)) {
        continued = true
        continue
      }
      if (parts === undefined || at >= parts.length - 1) break
      at += 1
    }
  }

  const partsWritten = composed === undefined && mode === 'draft' ? partsOf(chapter.plan.beats, target)?.length : undefined
  // The model wrote something, and all of it was a heading or a fence.
  if (written.trim().length === 0) throw new ProjectError('novel/empty', lang === 'zh' ? '写手模型的回复里没有正文（只有标题或空白）。请再试一次。' : 'the writer model\'s reply held no prose (only a heading or blank lines) — try again')

  // Pictures in a chapter's text are lines the author placed, not prose the writer writes. A line of the writer's own
  // making shows nothing and comes out. A chapter drafted over again keeps the ones it had: none is where it was —
  // the prose is new — so each goes after what reads most like the lines it stood by, or as far down as it stood.
  const held = keptPictures(mode === 'continue' ? '' : existing, written)
  written = held.text
  const figures = held.back > 0 || held.made > 0 ? { figures: { back: held.back, made: held.made } } : {}
  const finalText = mode === 'continue' ? `${existing}\n\n${written}` : written
  if (!dry) task.job?.rewrite(written)
  // Written to be compared: the chapter keeps its text, and the draft goes back to whoever asked.
  const saved = dry ? { words: countWords(proseOnly(finalText)), changed: false } : await project.saveChapterText(chapter.plan.id, finalText, { reason: mode === 'continue' ? 'before-continue' : 'before-redraft' })

  let digested = false
  let undigested: string | undefined
  const wantDigest = !dry && (params.digest ?? core.currentSettings().autoDigest)
  if (wantDigest) {
    task.job?.progress(2, 3, lang === 'zh' ? '收录记忆' : 'digesting')
    // What the scribe says of the chapter is no part of the chapter: it does not go where the chapter was shown as
    // it was written (a digest streams its reply into its job's text, and this job's text is the chapter).
    const apart: TaskContext = task.job !== undefined ? { ...task, job: { ...task.job, write: () => {}, rewrite: () => {} } } : task
    try {
      await digestChapter(core, runtime, chapter.plan.id, apart)
      await updateArcs(core, runtime, apart)
      digested = true
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      // The prose is saved; a failed digest only means memory is stale and can be redone — and it is said.
      core.log(`digest after writing ${chapter.plan.id} failed`, error)
      undigested = clip(errorMessage(error), 240)
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
    wordsWritten: countWords(proseOnly(written)),
    wordsTotal: saved.words,
    ...(target !== undefined ? { budget: target } : {}),
    model: `${route.provider}/${route.model}`,
    strategy: pack.strategy,
    contextTokens: pack.tokens,
    ...(pack.window !== undefined ? { window: pack.window } : {}),
    ...(pack.included.following > 0 ? { following: pack.included.following } : {}),
    ...(pack.included.intent !== undefined ? { intent: pack.included.intent } : {}),
    ...(cached > 0 ? { cachedTokens: cached } : {}),
    ...(chapter.line !== undefined ? { line: chapter.line } : {}),
    cast: pack.cast.map(card => card.name),
    digested,
    continued,
    ...(partsWritten !== undefined ? { parts: partsWritten } : {}),
    // (The writer is allowed fifteen in the hundred either way; a chapter gone on with is asked for what is added.)
    ...(target !== undefined && countWords(proseOnly(written)) < target * 0.85 ? { short: { asked: target, words: countWords(proseOnly(written)) } } : {}),
    ...(undigested !== undefined ? { undigested } : {}),
    preview: { head: written.slice(0, 220), tail: written.length > 440 ? written.slice(-220) : '' },
    ...(params.brief !== undefined ? { brief: params.brief } : {}),
    ...(guided !== undefined ? { pictures: picturesRead(guided)! } : {}),
    ...(referenced !== undefined ? { referenced } : {}),
    material,
    ...figures,
    ...(dry ? { text: finalText, handed } : {}),
  }
}

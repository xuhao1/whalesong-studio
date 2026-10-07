// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Import: an existing manuscript becomes a full project in one pass.
 *
 *   split     chapter (and volume) headings are recognized, or the text is cut by size
 *   digest    every chapter gets its summary, facts and character moments
 *   cast      sightings across chapters are merged into character cards
 *   world     places, groups, objects and terms become world entries
 *   outline   chapters get synopses, the book gets volumes, a logline and a premise
 *   style     a style profile is learned from the text itself
 */
import type { CharacterCard, StyleProfile, WorldCategory, WorldEntry } from '../../shared/types'
import { clip, countWords, normalizeProse, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText, completeJson } from '../llm'
import { ProjectError } from '../project'
import { architectSystem, castMergeTask, volumesTask, worldMergeTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { extractStyle } from './bible'
import { digestPending, updateArcs } from './digest'
import { pickText } from './plot'

export { decodeText, readBookFile } from '../util/bookfile'

export interface SplitChapter {
  title: string
  text: string
  /** Title of the volume this chapter opens, when a volume heading precedes it. */
  volume?: string
}

const CN_NUM = '0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾'
const CHAPTER_HEADING = new RegExp(`^\\s*(?:#{1,4}\\s*)?(?:(?:第\\s*[${CN_NUM}]+\\s*[章回节集话]|(?:chapter|chap\\.?)\\s+(?:\\d+|[ivxlcdm]+|[a-z-]+))(?:[\\s:：.、·—-]+.{0,40})?|(?:序章|序幕|楔子|引子|序言|前言|尾声|终章|后记|番外(?:[\\s:：·—-]*.{0,30})?|prologue|epilogue|interlude)(?:[\\s:：.-]+.{0,40})?)\\s*$`, 'i')
const VOLUME_HEADING = new RegExp(`^\\s*(?:#{1,3}\\s*)?(?:第\\s*[${CN_NUM}]+\\s*[卷部篇册]|(?:volume|book|part)\\s+(?:\\d+|[ivxlcdm]+|[a-z-]+))(?:[\\s:：.、·—-]+.{0,40})?\\s*$`, 'i')
const MARKDOWN_HEADING = /^\s*#{1,3}\s+(.{1,60})\s*$/

/** Cut a manuscript into chapters by its headings, or by size when it has none. */
export function splitChapters(source: string, options: { chunkChars?: number; zh?: boolean } = {}): SplitChapter[] {
  const text = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  const lines = text.split('\n')
  const zh = options.zh ?? /[一-鿿]/.test(text.slice(0, 2000))
  let headings = lines.map((line, index) => ({ index, line })).filter(({ line }) => line.length <= 80 && (CHAPTER_HEADING.test(line) || VOLUME_HEADING.test(line)))
  // Markdown documents often title chapters with plain headings.
  if (headings.filter(heading => !VOLUME_HEADING.test(heading.line)).length < 2) {
    const markdown = lines.map((line, index) => ({ index, line })).filter(({ line }) => MARKDOWN_HEADING.test(line))
    if (markdown.length >= 2) headings = markdown
  }
  const chapters: SplitChapter[] = []
  const clean = (line: string): string => line.replace(/^\s*#{1,4}\s*/, '').trim()
  if (headings.filter(heading => !VOLUME_HEADING.test(heading.line)).length >= 2) {
    let volume: string | undefined
    const preface = normalizeProse(lines.slice(0, headings[0]!.index).join('\n'))
    if (countWords(preface) > 200) chapters.push({ title: zh ? '序' : 'Preface', text: preface })
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]!
      const end = i + 1 < headings.length ? headings[i + 1]!.index : lines.length
      const body = normalizeProse(lines.slice(heading.index + 1, end).join('\n'))
      if (VOLUME_HEADING.test(heading.line) && !CHAPTER_HEADING.test(heading.line)) {
        volume = clean(heading.line)
        // Text directly under a volume heading (an epigraph, an intro) stays with the volume's first chapter.
        if (countWords(body) > 200) chapters.push({ title: volume, text: body, volume })
        continue
      }
      if (body.length === 0) continue
      chapters.push({ title: clean(heading.line), text: body, ...(volume !== undefined ? { volume } : {}) })
      volume = undefined
    }
    if (chapters.length > 0) return chapters
  }
  // No usable headings: cut on paragraph boundaries near the target size.
  const size = options.chunkChars ?? (zh ? 3200 : 9000)
  const paragraphs = normalizeProse(text).split('\n').filter(line => line.trim().length > 0)
  let current: string[] = []
  let length = 0
  for (const paragraph of paragraphs) {
    if (length + paragraph.length > size && current.length > 0) {
      chapters.push({ title: zh ? `第${chapters.length + 1}节` : `Part ${chapters.length + 1}`, text: current.join('\n\n') })
      current = []
      length = 0
    }
    current.push(paragraph)
    length += paragraph.length
  }
  if (current.length > 0) chapters.push({ title: zh ? `第${chapters.length + 1}节` : `Part ${chapters.length + 1}`, text: current.join('\n\n') })
  return chapters
}

export interface ImportParams {
  text: string
  /** Run the analysis passes after splitting. Default true. */
  analyze?: boolean
  /** Learn a style profile from the text. Default true. */
  style?: boolean
}

export interface ImportResult {
  chapters: number
  words: number
  volumes: number
  characters: number
  worldEntries: number
  digested: number
  failed: { step: string; error: string }[]
  style?: string
}

const ROLES: CharacterCard['role'][] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']
const STATUSES: CharacterCard['status'][] = ['planned', 'active', 'offstage', 'retired', 'dead']
const CATEGORIES: WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']

export async function importManuscript(core: NovelCore, runtime: ProjectRuntime, params: ImportParams, task: TaskContext): Promise<ImportResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const split = splitChapters(params.text, { zh })
  if (split.length === 0) throw new ProjectError('novel/empty', 'the text holds nothing to import')
  const failed: ImportResult['failed'] = []
  const steps = params.analyze === false ? 1 : 6
  let step = 0
  const advance = (label: string): void => { task.job?.progress(step++, steps, label) }

  // ── 1. split into volumes and chapters ──
  advance(L(lang, `拆分为 ${split.length} 章`, `splitting into ${split.length} chapters`))
  const existing = await project.outline()
  const explicitVolumes = split.some(chapter => chapter.volume !== undefined)
  const hadChapters = existing.volumes.some(volume => volume.chapters.length > 0)
  let volumeId = existing.volumes.at(-1)!.id
  // On an empty outline the text's own volumes replace the placeholder volume instead of following it.
  let replacePlaceholder = !hadChapters && explicitVolumes
  let volumeCount = 0
  const openVolume = async (title: string): Promise<void> => {
    await project.updateOutline((draft) => {
      if (replacePlaceholder) draft.volumes = []
      volumeId = `v${draft.volumes.length + 1}`
      draft.volumes.push({ id: volumeId, title, chapters: [] })
    })
    replacePlaceholder = false
    volumeCount += 1
  }
  const created: string[] = []
  for (const chapter of split) {
    if (chapter.volume !== undefined && explicitVolumes) await openVolume(chapter.volume)
    // Chapters that precede the first volume heading (a prologue) get a volume of their own.
    else if (replacePlaceholder) await openVolume(zh ? '卷首' : 'Opening')
    const plan = await project.addChapter({ title: chapter.title, status: 'drafted' }, { volume: volumeId })
    await project.saveChapterText(plan.id, chapter.text, { snapshot: false, status: 'drafted' })
    created.push(plan.id)
    task.signal?.throwIfAborted()
  }
  const words = split.reduce((sum, chapter) => sum + countWords(chapter.text), 0)
  const result: ImportResult = { chapters: created.length, words, volumes: Math.max(1, volumeCount), characters: 0, worldEntries: 0, digested: 0, failed }
  if (params.analyze === false) {
    task.job?.progress(steps, steps)
    return result
  }

  // ── 2. digest every chapter ──
  advance(L(lang, '逐章提取摘要与事实', 'digesting chapters'))
  const digestTaskContext: TaskContext = { ...task, job: task.job === undefined ? undefined : { ...task.job, progress: (done, total, label) => { task.job!.progress(1 + done / Math.max(1, total), steps, `${L(lang, '逐章提取', 'digesting')} ${done}/${total}${label !== undefined ? ` · ${label}` : ''}`) } } } as TaskContext
  const digest = await digestPending(core, runtime, digestTaskContext, { chapters: created, concurrency: 4 })
  result.digested = digest.digested.length
  for (const failure of digest.failed) failed.push({ step: `digest ${failure.chapter}`, error: failure.error })
  step = 2

  const memories = (await project.memories()).filter(entry => created.includes(entry.chapter.plan.id))
  const architect = await core.route('architect', runtime, task)
  const base = { lang, language: manifest.language, title: manifest.title }

  // ── 3. cast ──
  advance(L(lang, '归并人物', 'merging the cast'))
  try {
    const sightings = new Map<string, { count: number; first: number; last: number; notes: string[]; quotes: string[] }>()
    for (const { chapter, memory } of memories) {
      for (const moment of memory.characters) {
        const entry = sightings.get(moment.name) ?? { count: 0, first: chapter.index, last: chapter.index, notes: [], quotes: [] }
        entry.count += 1
        entry.last = chapter.index
        if (entry.notes.length < 4 && moment.role !== undefined) entry.notes.push(`${L(lang, `第${chapter.index}章`, `ch.${chapter.index}`)}: ${clip(moment.role, 80)}${moment.stateAfter !== undefined ? ` → ${clip(moment.stateAfter, 60)}` : ''}`)
        if (entry.quotes.length < 2 && moment.quote !== undefined) entry.quotes.push(moment.quote)
        sightings.set(moment.name, entry)
      }
      for (const entity of memory.newEntities.filter(candidate => candidate.kind === 'character')) {
        const entry = sightings.get(entity.name) ?? { count: 0, first: chapter.index, last: chapter.index, notes: [], quotes: [] }
        if (entry.notes.length < 4) entry.notes.push(clip(entity.description, 80))
        sightings.set(entity.name, entry)
      }
    }
    const ranked = [...sightings.entries()].sort((left, right) => right[1].count - left[1].count).slice(0, 90)
    if (ranked.length > 0) {
      const lines = ranked.map(([name, entry]) => `- ${name} (${L(lang, `出场${entry.count}章，第${entry.first}–${entry.last}章`, `${entry.count} chapters, ch.${entry.first}–${entry.last}`)})\n  ${entry.notes.join('\n  ')}${entry.quotes.length > 0 ? `\n  ${L(lang, '台词', 'lines')}: ${entry.quotes.map(quote => `"${clip(quote, 60)}"`).join(' ')}` : ''}`)
      const { value } = await completeJson(core.llm, {
        route: architect,
        system: architectSystem(lang),
        prompt: castMergeTask({ ...base, sightings: lines.join('\n') }),
        temperature: 0.2,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
        validate: raw => asRecord(raw),
      })
      for (const raw of asArray(value.characters)) {
        const item = asRecord(raw)
        const name = asText(item.name)
        if (name === undefined) continue
        const role = asText(item.role) as CharacterCard['role'] | undefined
        const status = asText(item.status) as CharacterCard['status'] | undefined
        const aliases = asList(item.aliases).filter(alias => !sameName(alias, name))
        const relationships = asArray(item.relationships).map(asRecord).map((relation) => {
          const target = asText(relation.target)
          const kind = asText(relation.kind)
          const note = asText(relation.note)
          return target !== undefined && kind !== undefined ? { target, kind, ...(note !== undefined ? { note } : {}) } : undefined
        }).filter((relation): relation is NonNullable<typeof relation> => relation !== undefined)
        await project.saveCharacter({
          name,
          role: role !== undefined && ROLES.includes(role) ? role : 'supporting',
          status: status !== undefined && STATUSES.includes(status) ? status : 'active',
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(relationships.length > 0 ? { relationships } : {}),
          ...pickText(item, ['gender', 'age', 'tagline', 'appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice']),
        } as Partial<CharacterCard> & { name: string })
        result.characters += 1
      }
      await relinkMemories(runtime)
    }
  } catch (error) {
    if (task.signal?.aborted === true) throw error
    failed.push({ step: 'cast', error: error instanceof Error ? error.message : String(error) })
  }

  // ── 4. world ──
  advance(L(lang, '整理世界观', 'collecting the world'))
  try {
    const seen = new Map<string, { kind: string; notes: string[] }>()
    for (const { memory } of memories) {
      for (const entity of memory.newEntities.filter(candidate => candidate.kind !== 'character')) {
        const entry = seen.get(entity.name) ?? { kind: entity.kind, notes: [] }
        if (entry.notes.length < 3) entry.notes.push(clip(entity.description, 100))
        seen.set(entity.name, entry)
      }
      for (const fact of memory.facts.filter(candidate => candidate.kind === 'world')) {
        const entry = seen.get(fact.subject) ?? { kind: 'term', notes: [] }
        if (entry.notes.length < 3) entry.notes.push(clip(fact.statement, 100))
        seen.set(fact.subject, entry)
      }
    }
    if (seen.size > 0) {
      const lines = [...seen.entries()].slice(0, 140).map(([name, entry]) => `- ${name} [${entry.kind}] ${entry.notes.join('；')}`)
      const { value } = await completeJson(core.llm, {
        route: architect,
        system: architectSystem(lang),
        prompt: worldMergeTask({ ...base, sightings: lines.join('\n') }),
        temperature: 0.2,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
        validate: raw => asRecord(raw),
      })
      for (const raw of asArray(value.entries)) {
        const item = asRecord(raw)
        const name = asText(item.name)
        if (name === undefined) continue
        const category = asText(item.category) as WorldCategory | undefined
        const importance = Number(item.importance)
        const aliases = asList(item.aliases)
        await project.saveWorld({
          name,
          category: category !== undefined && CATEGORIES.includes(category) ? category : 'other',
          importance: importance === 1 || importance === 3 ? importance : 2,
          ...(aliases.length > 0 ? { aliases } : {}),
          ...pickText(item, ['summary', 'body']),
        } as Partial<WorldEntry> & { name: string })
        result.worldEntries += 1
      }
    }
  } catch (error) {
    if (task.signal?.aborted === true) throw error
    failed.push({ step: 'world', error: error instanceof Error ? error.message : String(error) })
  }

  // ── 5. outline: synopses, volumes, premise ──
  advance(L(lang, '生成大纲', 'building the outline'))
  try {
    const characters = await project.characters()
    for (const { chapter, memory } of memories) {
      const cast = memory.characters.map(moment => characters.find(card => card.id === moment.character)?.id).filter((id): id is string => id !== undefined)
      await project.updateChapter(chapter.plan.id, {
        synopsis: memory.summary,
        ...(cast.length > 0 ? { characters: [...new Set(cast)] } : {}),
        ...(memory.storyTime !== undefined ? { time: memory.storyTime } : {}),
        ...(memory.locations?.[0] !== undefined ? { location: memory.locations[0] } : {}),
      })
    }
    const briefs = memories.map(({ chapter, memory }) => `${chapter.index}. ${chapter.plan.title} — ${memory.brief}`)
    if (briefs.length > 0) {
      const { value } = await completeJson(core.llm, {
        route: architect,
        system: architectSystem(lang),
        prompt: volumesTask({ ...base, summaries: clip(briefs.join('\n'), 60_000) }),
        temperature: 0.3,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
        validate: raw => asRecord(raw),
      })
      const themes = asList(value.themes)
      await project.updateManifest({
        ...(manifest.logline === undefined ? pickText(value, ['logline']) : {}),
        ...(manifest.premise === undefined ? pickText(value, ['premise']) : {}),
        ...(manifest.genre === undefined ? pickText(value, ['genre']) : {}),
        ...(manifest.themes === undefined && themes.length > 0 ? { themes } : {}),
      })
      const proposed = asArray(value.volumes).map(asRecord).map(volume => ({
        title: asText(volume.title),
        from: Number(volume.from),
        to: Number(volume.to),
        synopsis: asText(volume.synopsis),
        goal: asText(volume.goal),
      })).filter(volume => volume.title !== undefined && Number.isFinite(volume.from) && Number.isFinite(volume.to))
      // Only restructure when the text itself named no volumes and the import started from an empty outline.
      if (!explicitVolumes && !hadChapters && proposed.length > 1) {
        const located = await project.chapters()
        await project.updateOutline((draft) => {
          const all = located.map(chapter => chapter.plan)
          const volumes = proposed.map((volume, index) => ({
            id: `v${index + 1}`,
            title: volume.title!,
            ...(volume.synopsis !== undefined ? { synopsis: volume.synopsis } : {}),
            ...(volume.goal !== undefined ? { goal: volume.goal } : {}),
            chapters: all.filter((_plan, at) => at + 1 >= volume.from && at + 1 <= volume.to),
          }))
          const placed = new Set(volumes.flatMap(volume => volume.chapters.map(plan => plan.id)))
          // Chapters the proposal forgot stay in the book, attached to the last volume.
          volumes.at(-1)!.chapters.push(...all.filter(plan => !placed.has(plan.id)))
          const ordered = volumes.filter(volume => volume.chapters.length > 0)
          if (ordered.length > 0 && ordered.flatMap(volume => volume.chapters).map(plan => plan.id).join() === all.map(plan => plan.id).join()) {
            draft.volumes = ordered
            result.volumes = ordered.length
          }
        })
      } else if (explicitVolumes) {
        await project.updateOutline((draft) => {
          for (const volume of draft.volumes) {
            const match = proposed.find(candidate => candidate.title !== undefined && sameName(candidate.title, volume.title))
            if (match?.synopsis !== undefined && volume.synopsis === undefined) volume.synopsis = match.synopsis
          }
        })
      }
    }
  } catch (error) {
    if (task.signal?.aborted === true) throw error
    failed.push({ step: 'outline', error: error instanceof Error ? error.message : String(error) })
  }

  // ── 6. style ──
  advance(L(lang, '提炼文风', 'learning the style'))
  if (params.style !== false) {
    try {
      // A chapter from the middle shows the settled voice better than an opening.
      const sampleChapter = split[Math.min(split.length - 1, Math.floor(split.length / 3))]!
      const style: StyleProfile = await extractStyle(core, runtime, { sample: clip(sampleChapter.text, 5000), name: L(lang, '原作文风', 'Source style'), activate: true }, task)
      result.style = style.name
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push({ step: 'style', error: error instanceof Error ? error.message : String(error) })
    }
  }
  try {
    await updateArcs(core, runtime, task)
  } catch (error) {
    if (task.signal?.aborted === true) throw error
    failed.push({ step: 'arcs', error: error instanceof Error ? error.message : String(error) })
  }
  task.job?.progress(steps, steps)
  task.job?.result({ chapters: result.chapters })
  return result
}

/**
 * Point chapter memories at character cards created after the memories were
 * written, and bring each card's first/last appearance in line.
 */
export async function relinkMemories(runtime: ProjectRuntime): Promise<void> {
  const { project } = runtime
  const characters = await project.characters()
  const find = (name: string): CharacterCard | undefined => characters.find(card => card.id === name || sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)
  const first = new Map<string, string>()
  const last = new Map<string, string>()
  for (const { chapter, memory } of await project.memories()) {
    let changed = false
    const moments = memory.characters.map((moment) => {
      const card = find(moment.character) ?? find(moment.name)
      if (card === undefined) return moment
      if (!first.has(card.id)) first.set(card.id, chapter.plan.id)
      last.set(card.id, chapter.plan.id)
      if (moment.character === card.id) return moment
      changed = true
      return { ...moment, character: card.id }
    })
    if (changed) await project.saveMemory({ ...memory, characters: moments })
  }
  for (const card of characters) {
    const firstAppearance = first.get(card.id)
    const lastAppearance = last.get(card.id)
    if (firstAppearance === undefined || lastAppearance === undefined) continue
    if (card.firstAppearance !== firstAppearance || card.lastAppearance !== lastAppearance) {
      await project.saveCharacter({ id: card.id, firstAppearance, lastAppearance, ...(card.status === 'planned' ? { status: 'active' as const } : {}) })
    }
  }
}

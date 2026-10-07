// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The showrunner's own hands on the manuscript and on the book's memory.
 *
 * Prose is the writer model's work, and stays so. But a conversation is full
 * of changes that are not writing: the author dictates a sentence, pastes a
 * paragraph of their own, wants a name corrected everywhere, a slip of fact
 * put right. Routing those through a model that rewrites is slow, costs money
 * and is not exact. Here they are made exactly — and by the same road every
 * other change takes: the text before is kept as a version, memory is
 * digested again, and the change goes on the book's record where the author
 * sees it. Nothing changes the book that the Studio does not know of.
 */
import { clip, countWords, fuzzyFind, proseOnly } from '../../shared/text'
import type { ChapterMemory, CharacterMoment, FactKind, MemoryFact } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { ProjectError } from '../project'
import { scheduleDigest } from './digest'

export type EditAction = 'replace' | 'insert' | 'append' | 'set' | 'delete'

export interface EditParams {
  chapter: string
  action: EditAction
  /** replace/delete: the passage to change. insert: the passage the new text goes before or after. */
  find?: string
  /** The new text. */
  text?: string
  /** insert: on which side of `find`. Default: after. */
  where?: 'before' | 'after'
  /** replace/delete: every occurrence instead of the one. */
  all?: boolean
  /** Why, in a few words; kept with the version and on the record. */
  reason?: string
  /** Apply now (true) or leave a proposal for the author (false). Default: by the author's setting for agent changes. */
  apply?: boolean
}

export interface EditResult {
  chapterId: string
  title: string
  index: number
  action: EditAction
  applied: boolean
  proposalId?: string
  /** How many places were changed. */
  changes: number
  wordsBefore: number
  wordsAfter: number
  /** The passage as it was, and as it reads now (clipped). */
  before: string
  after: string
  /** Version holding the chapter as it was. */
  version?: string
  /** What happens to the chapter's memory: being digested again, or left for later because auto-digest is off. */
  memory: 'digesting' | 'stale' | 'unchanged'
  /** Characters named in the changed text: their cards are the canon the change must agree with. */
  characters: string[]
  /** Chapters after this one that already have text and may rest on what was changed. */
  laterChapters: number
}

function occurrences(text: string, passage: string): number[] {
  const found: number[] = []
  for (let at = text.indexOf(passage); at >= 0; at = text.indexOf(passage, at + passage.length)) found.push(at)
  return found
}

function shouldApply(core: NovelCore, task: TaskContext, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit
  return task.origin === 'agent' ? !core.currentSettings().reviewAgentRevisions : true
}

/** Make an exact change to a chapter's text. */
export async function editChapter(core: NovelCore, runtime: ProjectRuntime, params: EditParams, task: TaskContext): Promise<EditResult> {
  const { project } = runtime
  const chapter = await project.findChapter(params.chapter)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${params.chapter}"`)
  const id = chapter.plan.id
  const text = await project.chapterText(id)
  const incoming = params.text?.replace(/\r\n?/g, '\n')
  const needText = (): string => {
    if (incoming === undefined || incoming.trim().length === 0) throw new ProjectError('novel/invalid', `action=${params.action} needs the new text in \`text\``)
    return incoming
  }
  const locate = (): { start: number; end: number }[] => {
    const passage = params.find
    if (passage === undefined || passage.trim().length === 0) throw new ProjectError('novel/invalid', `action=${params.action} needs the passage in \`find\`, copied exactly from the chapter (novel_read)`)
    if (text.length === 0) throw new ProjectError('novel/empty', `chapter ${chapter.index} has no text yet — use action=set to put text in, or have the writer draft it`)
    const exact = occurrences(text, passage)
    if (exact.length === 1 || (exact.length > 1 && params.all === true)) return exact.map(start => ({ start, end: start + passage.length }))
    if (exact.length > 1) throw new ProjectError('novel/ambiguous', `that passage occurs ${exact.length} times in chapter ${chapter.index} — quote more of it so it is unique, or pass all=true to change every one`)
    // Not there to the letter: quotation marks and white space are forgiven, nothing else.
    const loose = fuzzyFind(text, passage)
    if (loose === undefined) throw new ProjectError('novel/not-found', `chapter ${chapter.index} does not contain that passage — read the chapter (novel_read what=chapter) and copy the words exactly`)
    return [loose]
  }

  let next: string
  let before: string
  let after: string
  let changes = 1
  if (params.action === 'set') {
    next = needText()
    before = text
    after = next
  } else if (params.action === 'append') {
    const added = needText()
    next = text.length > 0 ? `${text.replace(/\s+$/u, '')}\n${added.replace(/^\n+/u, '')}` : added
    before = ''
    after = added
  } else {
    const places = locate()
    changes = places.length
    const first = places[0]!
    before = text.slice(first.start, first.end)
    if (params.action === 'insert') {
      const added = needText()
      const at = params.where === 'before' ? first.start : first.end
      // A whole paragraph goes in as one; a few words go in where they are put.
      const block = /\n/.test(added.trim()) || /[。！？!?…”’」』.]\s*$/u.test(added.trim())
      const lead = block && at > 0 && text[at - 1] !== '\n' && params.where !== 'before' ? '\n' : ''
      const trail = block && at < text.length && text[at] !== '\n' && params.where === 'before' ? '\n' : ''
      next = `${text.slice(0, at)}${lead}${added}${trail}${text.slice(at)}`
      before = ''
      after = added
    } else {
      const replacement = params.action === 'delete' ? '' : needText()
      let out = ''
      let cursor = 0
      for (const place of places) {
        out += text.slice(cursor, place.start) + replacement
        cursor = place.end
      }
      next = out + text.slice(cursor)
      // A removed paragraph leaves no hole behind.
      if (params.action === 'delete') next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/u, '')
      after = replacement
    }
  }
  if (next === text) throw new ProjectError('novel/invalid', 'that would change nothing — the text already reads this way')

  const wordsBefore = countWords(proseOnly(text))
  const wordsAfter = countWords(proseOnly(next))
  const cards = await project.characters()
  const touched = `${before}\n${after}`
  const characters = cards.filter(card => [card.name, ...(card.aliases ?? [])].some(name => name.length > 0 && touched.includes(name))).map(card => card.name)
  const laterChapters = (await project.chapterInfos()).filter(info => info.index > chapter.index && info.hasText).length
  const result: EditResult = {
    chapterId: id,
    title: chapter.plan.title,
    index: chapter.index,
    action: params.action,
    applied: shouldApply(core, task, params.apply),
    changes,
    wordsBefore,
    wordsAfter,
    before: clip(before, 400),
    after: clip(after, 600),
    memory: 'unchanged',
    characters,
    laterChapters,
  }
  const reason = params.reason?.trim()
  if (!result.applied) {
    // One exact place is shown as that place; anything wider as the whole chapter, so the author sees all of it.
    const span = (params.action === 'replace' || params.action === 'delete') && changes === 1 && text.includes(before) && before.length > 0
    const proposal = await project.addProposal({
      chapterId: id,
      kind: span ? 'span' : 'chapter',
      instruction: reason ?? `direct ${params.action} by the showrunner`,
      before: span ? before : text,
      after: span ? after : next,
      createdBy: task.origin,
    })
    result.proposalId = proposal.id
    return result
  }
  // The restore point is taken by hand so the record can point at it.
  const version = text.length > 0 ? await project.snapshot(id, task.origin === 'agent' ? 'agent-edit' : 'edit', text) : undefined
  await project.saveChapterText(id, next, { snapshot: false })
  if (version !== undefined) result.version = version
  result.memory = core.currentSettings().autoDigest ? 'digesting' : 'stale'
  scheduleDigest(core, runtime, id, task)
  task.job?.result({ chapterId: id })
  return result
}

export interface MemoryPatch {
  brief?: string
  summary?: string
  storyTime?: string
  locations?: string[]
  /** Facts to add: what is true after this chapter. */
  addFacts?: { subject: string; statement: string; kind?: FactKind }[]
  /** Facts to take out: any fact whose statement contains one of these. */
  removeFacts?: string[]
  /** Where a character stands at the end of the chapter; merged into their entry by name. */
  characters?: { name: string; role?: string; stateAfter?: string; location?: string; emotion?: string; learned?: string[] }[]
  openQuestions?: string[]
}

/**
 * Put the book's memory of a chapter right by hand. The digest reads a chapter
 * the way a careful reader would and is sometimes wrong; later chapters are
 * written from what it recorded, so a wrong record is a wrong book. The text's
 * hash is kept: the memory still belongs to the text as it stands, and is only
 * replaced when the text changes and is digested again.
 */
export async function correctMemory(runtime: ProjectRuntime, chapterRef: string, patch: MemoryPatch): Promise<{ memory: ChapterMemory; changed: string[] }> {
  const { project } = runtime
  const chapter = await project.findChapter(chapterRef)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapterRef}"`)
  const memory = await project.memory(chapter.plan.id)
  if (memory === undefined) throw new ProjectError('novel/not-found', `chapter ${chapter.index} has no memory yet — digest it first (novel_digest), then correct what it got wrong`)
  const changed: string[] = []
  const next: ChapterMemory = { ...memory, updatedAt: new Date().toISOString() }
  const text = (value: string | undefined): string | undefined => (value !== undefined && value.trim().length > 0 ? value.trim() : undefined)
  for (const key of ['brief', 'summary', 'storyTime'] as const) {
    const value = text(patch[key])
    if (value !== undefined && value !== memory[key]) {
      next[key] = value
      changed.push(key)
    }
  }
  if (patch.locations !== undefined) {
    next.locations = patch.locations.map(item => item.trim()).filter(item => item.length > 0)
    changed.push('locations')
  }
  if (patch.openQuestions !== undefined) {
    next.openQuestions = patch.openQuestions.map(item => item.trim()).filter(item => item.length > 0)
    changed.push('openQuestions')
  }
  if (patch.removeFacts !== undefined && patch.removeFacts.length > 0) {
    const gone = patch.removeFacts.map(item => item.trim()).filter(item => item.length > 0)
    const kept = next.facts.filter(fact => !gone.some(needle => fact.statement.includes(needle) || `${fact.subject}${fact.statement}`.includes(needle)))
    if (kept.length !== next.facts.length) changed.push(`facts −${next.facts.length - kept.length}`)
    next.facts = kept
  }
  if (patch.addFacts !== undefined && patch.addFacts.length > 0) {
    const added: MemoryFact[] = patch.addFacts
      .filter(fact => typeof fact.statement === 'string' && fact.statement.trim().length > 0)
      .map(fact => ({ subject: (fact.subject ?? '').trim(), statement: fact.statement.trim(), kind: fact.kind ?? 'event' }))
    if (added.length > 0) {
      next.facts = [...next.facts, ...added]
      changed.push(`facts +${added.length}`)
    }
  }
  if (patch.characters !== undefined && patch.characters.length > 0) {
    const cards = await project.characters()
    const moments: CharacterMoment[] = [...next.characters]
    for (const entry of patch.characters) {
      const name = entry.name?.trim()
      if (name === undefined || name.length === 0) continue
      const card = cards.find(candidate => candidate.name === name || candidate.aliases?.includes(name) === true)
      const at = moments.findIndex(moment => moment.name === name || (card !== undefined && moment.character === card.id))
      const base: CharacterMoment = at >= 0 ? moments[at]! : { character: card?.id ?? name, name: card?.name ?? name }
      const merged: CharacterMoment = {
        ...base,
        ...(text(entry.role) !== undefined ? { role: text(entry.role)! } : {}),
        ...(text(entry.stateAfter) !== undefined ? { stateAfter: text(entry.stateAfter)! } : {}),
        ...(text(entry.location) !== undefined ? { location: text(entry.location)! } : {}),
        ...(text(entry.emotion) !== undefined ? { emotion: text(entry.emotion)! } : {}),
        ...(entry.learned !== undefined ? { learned: entry.learned.map(item => item.trim()).filter(item => item.length > 0) } : {}),
      }
      if (at >= 0) moments[at] = merged
      else moments.push(merged)
      changed.push(`state of ${merged.name}`)
    }
    next.characters = moments
  }
  if (changed.length === 0) throw new ProjectError('novel/invalid', 'nothing to correct — give at least one field that differs from what is recorded')
  await project.saveMemory(next)
  return { memory: next, changed }
}

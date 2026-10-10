// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Structural edits of the outline as a small operation vocabulary, shared by
 * the `novel_outline` tool and the Studio's outline view so both go through
 * the same validation. The lines of the plot are edited with the same
 * vocabulary: opened, renamed, joined to another, made the main one, removed.
 */
import { MAIN_LINE, type Beat, type ChapterPlan, type ChapterStatus, type PictureGuide, type PlotLine, type PlotThread, type ThreadKind, type ThreadStatus } from '../../shared/types'
import { newId, sameName } from '../../shared/text'
import type { ProjectRuntime } from '../core'
import { ProjectError, type ChapterPlace } from '../project'
import { L, promptLanguage } from '../render'
import { foldIn } from './digest'
import { cleanGuides } from './guides'

export type OutlineOp =
  | { op: 'add-volume'; title: string; synopsis?: string; goal?: string; before?: string }
  | { op: 'update-volume'; volume: string; title?: string; synopsis?: string; goal?: string }
  | { op: 'move-volume'; volume: string; before?: string }
  | { op: 'remove-volume'; volume: string }
  | ({ op: 'add-chapter'; title: string; volume?: string; before?: string; after?: string; /** The line it is added to, when that is not the main one. */ line?: string } & ChapterFields)
  | ({ op: 'update-chapter'; chapter: string; title?: string } & ChapterFields)
  | { op: 'move-chapter'; chapter: string; volume?: string; before?: string; after?: string; line?: string }
  /**
   * Move a run of chapters, in their order, to another place — elsewhere on their line, onto another line (`line`;
   * `main` for the main one), or onto a line opened for them (`line: "new"`, with its `title` and, where it parts from
   * the story, the chapter it leaves after: `from`). `before` / `after` say where among the chapters there; left out: the end.
   */
  | { op: 'move-chapters'; chapters: string[]; line?: string; volume?: string; before?: string; after?: string; title?: string; from?: string; choice?: string; premise?: string }
  | { op: 'remove-chapter'; chapter: string }
  /** Put back a chapter that was removed: where it stood, with its text. */
  | { op: 'restore-chapter'; chapter: string }
  /** Open a line of the plot: another way the story goes after `from` (from the first page, when left out). */
  | { op: 'add-line'; title: string; from?: string; choice?: string; premise?: string }
  /** Rename a line, say what sets it apart, put it aside (`shelved`), move where it leaves (`from`), or say where it arrives (`into`; null: nowhere). */
  | { op: 'update-line'; line: string; title?: string; premise?: string; choice?: string; shelved?: boolean; from?: string | null; into?: string | null }
  /** Make a line the main one; what the main line had in its place becomes a line. */
  | { op: 'promote-line'; line: string }
  /** Remove a line with its chapters (their text is snapshotted first). */
  | { op: 'remove-line'; line: string }
  | { op: 'save-thread'; thread?: string; title?: string; kind?: ThreadKind; status?: ThreadStatus; description?: string }
  | { op: 'remove-thread'; thread: string }

export interface ChapterFields {
  synopsis?: string
  purpose?: string
  /** Character id or name. */
  pov?: string
  location?: string
  time?: string
  /** Character ids or names. */
  characters?: string[]
  /** Thread ids or titles. */
  threads?: string[]
  /** Beat summaries, or full beat objects. */
  beats?: (string | Partial<Beat>)[]
  status?: ChapterStatus
  /** A length recommended for the chapter; 0 takes the recommendation away, and whoever writes it judges. */
  targetWords?: number
  /** Pictures to write the chapter by: paths of the book's own pictures, or `{path, note}`. An empty list takes them off. */
  guides?: (string | PictureGuide)[]
  notes?: string
}

export interface OutlineOpResult {
  op: OutlineOp['op']
  ok: boolean
  /** Id of the volume, chapter or thread the op created or touched. */
  id?: string
  message: string
}

const STATUSES: ChapterStatus[] = ['idea', 'outlined', 'drafted', 'revised', 'final']

/** Apply operations in order. A failing op is reported and the rest still run. */
export async function applyOutlineOps(runtime: ProjectRuntime, ops: OutlineOp[]): Promise<OutlineOpResult[]> {
  const { project } = runtime
  const results: OutlineOpResult[] = []
  const characters = await project.characters()
  const resolveCharacter = (ref: string): string => characters.find(card => card.id === ref || sameName(card.name, ref) || card.aliases?.some(alias => sameName(alias, ref)) === true)?.id ?? ref
  const resolveThreads = async (refs: string[]): Promise<string[]> => {
    const outline = await project.outline()
    return refs.map(ref => outline.threads.find(thread => thread.id === ref || sameName(thread.title, ref))?.id ?? ref)
  }
  const chapterPatch = async (fields: ChapterFields): Promise<Partial<ChapterPlan>> => {
    const patch: Partial<ChapterPlan> = {}
    for (const key of ['synopsis', 'purpose', 'location', 'time', 'notes'] as const) if (fields[key] !== undefined) patch[key] = fields[key]
    if (fields.pov !== undefined) patch.pov = fields.pov.length > 0 ? resolveCharacter(fields.pov) : ''
    if (fields.characters !== undefined) patch.characters = [...new Set(fields.characters.map(resolveCharacter))]
    if (fields.threads !== undefined) patch.threads = await resolveThreads(fields.threads)
    if (fields.beats !== undefined) {
      patch.beats = fields.beats.map((beat): Beat => {
        if (typeof beat === 'string') return { id: newId('b'), summary: beat }
        return { ...beat, id: beat.id ?? newId('b'), summary: beat.summary ?? '', ...(beat.characters !== undefined ? { characters: beat.characters.map(resolveCharacter) } : {}) }
      }).filter(beat => beat.summary.trim().length > 0)
    }
    if (fields.status !== undefined) {
      if (!STATUSES.includes(fields.status)) throw new ProjectError('novel/invalid', `unknown chapter status "${fields.status}"`)
      patch.status = fields.status
    }
    // Zero, or anything that is not a length, takes the recommendation away.
    if (fields.targetWords !== undefined) (patch as Record<string, unknown>).targetWords = Number.isFinite(fields.targetWords) && fields.targetWords > 0 ? Math.round(fields.targetWords) : null
    if (fields.guides !== undefined) {
      const guides = cleanGuides(Array.isArray(fields.guides) ? fields.guides : [])
      ;(patch as Record<string, unknown>).guides = guides.length > 0 ? guides : null
    }
    return patch
  }
  const findLine = async (ref: string): Promise<string> => {
    const line = await project.findLine(ref)
    if (line === undefined) throw new ProjectError('novel/not-found', ref === MAIN_LINE ? 'the main line cannot be changed this way' : `no plot line matches "${ref}"`)
    return line.id
  }
  const findVolume = async (ref: string): Promise<string> => {
    const outline = await project.outline()
    const volume = outline.volumes.find(candidate => candidate.id === ref || sameName(candidate.title, ref))
    if (volume === undefined) throw new ProjectError('novel/not-found', `no volume matches "${ref}"`)
    return volume.id
  }

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'add-volume': {
          if (op.title.trim().length === 0) throw new ProjectError('novel/invalid', 'a volume needs a title')
          let id = ''
          await project.updateOutline((draft) => {
            let n = draft.volumes.length + 1
            while (draft.volumes.some(volume => volume.id === `v${n}`)) n++
            id = `v${n}`
            const volume = { id, title: op.title.trim(), ...(op.synopsis !== undefined ? { synopsis: op.synopsis } : {}), ...(op.goal !== undefined ? { goal: op.goal } : {}), chapters: [] }
            const at = op.before !== undefined ? draft.volumes.findIndex(candidate => candidate.id === op.before || sameName(candidate.title, op.before!)) : -1
            if (at >= 0) draft.volumes.splice(at, 0, volume)
            else draft.volumes.push(volume)
          })
          results.push({ op: op.op, ok: true, id, message: `added volume "${op.title}"` })
          break
        }
        case 'update-volume': {
          const id = await findVolume(op.volume)
          await project.updateOutline((draft) => {
            const volume = draft.volumes.find(candidate => candidate.id === id)!
            if (op.title !== undefined && op.title.trim().length > 0) volume.title = op.title.trim()
            if (op.synopsis !== undefined) { if (op.synopsis.length > 0) volume.synopsis = op.synopsis; else delete volume.synopsis }
            if (op.goal !== undefined) { if (op.goal.length > 0) volume.goal = op.goal; else delete volume.goal }
          })
          results.push({ op: op.op, ok: true, id, message: `updated volume ${id}` })
          break
        }
        case 'move-volume': {
          const id = await findVolume(op.volume)
          await project.updateOutline((draft) => {
            const volume = draft.volumes.find(candidate => candidate.id === id)!
            draft.volumes = draft.volumes.filter(candidate => candidate.id !== id)
            const at = op.before !== undefined ? draft.volumes.findIndex(candidate => candidate.id === op.before || sameName(candidate.title, op.before!)) : -1
            if (at >= 0) draft.volumes.splice(at, 0, volume)
            else draft.volumes.push(volume)
          })
          results.push({ op: op.op, ok: true, id, message: `moved volume ${id}` })
          break
        }
        case 'remove-volume': {
          const id = await findVolume(op.volume)
          const outline = await project.outline()
          const volume = outline.volumes.find(candidate => candidate.id === id)!
          if (volume.chapters.length > 0) throw new ProjectError('novel/invalid', `volume "${volume.title}" still has ${volume.chapters.length} chapters — move or remove them first`)
          if (outline.volumes.length === 1) throw new ProjectError('novel/invalid', 'a book keeps at least one volume')
          await project.updateOutline((draft) => { draft.volumes = draft.volumes.filter(candidate => candidate.id !== id) })
          results.push({ op: op.op, ok: true, id, message: `removed volume "${volume.title}"` })
          break
        }
        case 'add-chapter': {
          if (op.title.trim().length === 0) throw new ProjectError('novel/invalid', 'a chapter needs a title')
          const where: ChapterPlace = {}
          if (op.volume !== undefined) where.volume = await findVolume(op.volume)
          if (op.line !== undefined && op.line !== MAIN_LINE) where.line = await findLine(op.line)
          for (const side of ['before', 'after'] as const) {
            const ref = op[side]
            if (ref === undefined) continue
            const anchor = await project.findChapter(ref, where.line)
            if (anchor === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
            where[side] = anchor.plan.id
          }
          const plan = await project.addChapter({ title: op.title, ...(await chapterPatch(op)) }, where)
          const located = await project.findChapter(plan.id)
          results.push({ op: op.op, ok: true, id: plan.id, message: `added chapter ${located?.index ?? '?'} "${plan.title}" (${plan.id})` })
          break
        }
        case 'update-chapter': {
          const patch = await chapterPatch(op)
          if (op.title !== undefined && op.title.trim().length > 0) patch.title = op.title.trim()
          const plan = await project.updateChapter(op.chapter, patch)
          results.push({ op: op.op, ok: true, id: plan.id, message: `updated chapter "${plan.title}" (${plan.id})` })
          break
        }
        case 'move-chapter': {
          const where: ChapterPlace = {}
          if (op.volume !== undefined) where.volume = await findVolume(op.volume)
          if (op.line !== undefined && op.line !== MAIN_LINE) where.line = await findLine(op.line)
          for (const side of ['before', 'after'] as const) {
            const ref = op[side]
            if (ref === undefined) continue
            const anchor = await project.findChapter(ref, where.line)
            if (anchor === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
            where[side] = anchor.plan.id
          }
          const chapter = await project.findChapter(op.chapter)
          if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${op.chapter}"`)
          await project.moveChapter(chapter.plan.id, where)
          const located = await project.findChapter(chapter.plan.id)
          results.push({ op: op.op, ok: true, id: chapter.plan.id, message: `moved "${chapter.plan.title}" to position ${located?.index ?? '?'}` })
          break
        }
        case 'move-chapters': {
          const refs = Array.isArray(op.chapters) ? op.chapters.filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0) : []
          if (refs.length === 0) throw new ProjectError('novel/invalid', 'name the chapters to move')
          const where: ChapterPlace = {}
          let opened: PlotLine | undefined
          if (op.line === 'new') {
            if ((op.title ?? '').trim().length === 0) throw new ProjectError('novel/invalid', 'a line needs a name')
            let from: string | undefined
            if (op.from !== undefined && op.from.trim().length > 0) {
              const leaves = await project.findChapter(op.from)
              if (leaves === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${op.from}"`)
              from = leaves.plan.id
            }
            opened = await project.addLine({ title: op.title!, ...(from !== undefined ? { from } : {}), ...(op.choice !== undefined ? { choice: op.choice } : {}), ...(op.premise !== undefined ? { premise: op.premise } : {}), origin: 'author' })
            where.line = opened.id
          } else {
            if (op.volume !== undefined) where.volume = await findVolume(op.volume)
            if (op.line !== undefined && op.line !== MAIN_LINE) where.line = await findLine(op.line)
            for (const side of ['before', 'after'] as const) {
              const ref = op[side]
              if (ref === undefined) continue
              const anchor = await project.findChapter(ref, where.line)
              if (anchor === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
              where[side] = anchor.plan.id
            }
            // Onto the main line with nothing more said: its end.
            if (op.line === MAIN_LINE && where.before === undefined && where.after === undefined && where.volume === undefined) where.volume = (await project.outline()).volumes.at(-1)!.id
          }
          let moved: Awaited<ReturnType<typeof project.moveChapters>>
          try {
            moved = await project.moveChapters(refs, where)
          } catch (error) {
            // The line opened for them is not left behind empty.
            if (opened !== undefined) await project.removeLine(opened.id).catch(() => undefined)
            throw error
          }
          results.push({ op: op.op, ok: true, ...(opened !== undefined ? { id: opened.id } : {}), message: `moved ${moved.length} chapter(s)${opened !== undefined ? ` onto the new line "${opened.title}" (${opened.id})` : ''}: ${moved.map(chapter => `"${chapter.plan.title}" → ${chapter.index}`).join(', ')}` })
          break
        }
        case 'remove-chapter': {
          const chapter = await project.findChapter(op.chapter)
          if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${op.chapter}"`)
          await project.removeChapter(chapter.plan.id)
          results.push({ op: op.op, ok: true, id: chapter.plan.id, message: `removed chapter "${chapter.plan.title}" (${chapter.plan.id}) — it is kept among the removed chapters and comes back with restore-chapter chapter="${chapter.plan.id}"` })
          break
        }
        case 'restore-chapter': {
          const removed = await project.removedChapters()
          const wanted = op.chapter.trim()
          const record = removed.find(candidate => candidate.plan.id === wanted) ?? removed.find(candidate => sameName(candidate.plan.title, wanted))
          if (record === undefined) throw new ProjectError('novel/not-found', `no removed chapter matches "${op.chapter}"${removed.length > 0 ? ` — removed chapters: ${removed.map(candidate => `${candidate.plan.id} "${candidate.plan.title}"`).join(', ')}` : ' — nothing has been removed'}`)
          const back = await project.restoreChapter(record.plan.id)
          results.push({ op: op.op, ok: true, id: back.plan.id, message: `put chapter "${back.plan.title}" back at position ${back.index}${record.version !== undefined ? ', with its text' : ''}` })
          break
        }
        case 'add-line': {
          if (op.title.trim().length === 0) throw new ProjectError('novel/invalid', 'a line needs a name')
          const line = await project.addLine({ title: op.title, ...(op.from !== undefined ? { from: op.from } : {}), ...(op.choice !== undefined ? { choice: op.choice } : {}), ...(op.premise !== undefined ? { premise: op.premise } : {}), origin: 'author' })
          results.push({ op: op.op, ok: true, id: line.id, message: `opened the line "${line.title}" (${line.id})${line.from !== undefined ? ` after ${line.from}` : ''} — add chapters to it with add-chapter line="${line.id}", or have them derived` })
          break
        }
        case 'update-line': {
          const id = await findLine(op.line)
          const line = await project.updateLine(id, {
            ...(op.title !== undefined ? { title: op.title } : {}),
            ...(op.premise !== undefined ? { premise: op.premise } : {}),
            ...(op.choice !== undefined ? { choice: op.choice } : {}),
            ...(op.shelved !== undefined ? { shelved: op.shelved } : {}),
            ...(op.from !== undefined ? { from: op.from } : {}),
            ...(op.into !== undefined ? { into: op.into } : {}),
          })
          results.push({ op: op.op, ok: true, id: line.id, message: `updated the line "${line.title}"${line.into !== undefined ? `; it arrives at ${line.into}` : ''}${line.shelved === true ? '; it is put aside' : ''}` })
          break
        }
        case 'promote-line': {
          const id = await findLine(op.line)
          const lang = promptLanguage((await project.manifest()).language)
          const done = await project.promoteLine(id, L(lang, '原主线', 'Former main line'))
          // What happened on the line is now what happened in the book: its chapters' memories count for the bible.
          await foldIn(runtime, done.promoted.chapters.map(chapter => chapter.id))
          results.push({ op: op.op, ok: true, id, message: `"${done.promoted.title}" is the main line now${done.former.length > 0 ? `; what the main line had in its place is kept as ${done.former.map(line => `"${line.title}" (${line.chapters.length} chapters)`).join(', ')}` : ''}` })
          break
        }
        case 'remove-line': {
          const id = await findLine(op.line)
          const done = await project.removeLine(id)
          results.push({ op: op.op, ok: true, id, message: `removed the line "${done?.line.title ?? id}" with its ${done?.chapters ?? 0} chapters${done !== undefined && done.written > 0 ? ` (${done.written} had text, which was snapshotted)` : ''}` })
          break
        }
        case 'save-thread': {
          const input: Partial<PlotThread> = {
            ...(op.thread !== undefined ? { id: (await resolveThreads([op.thread]))[0]! } : {}),
            ...(op.title !== undefined ? { title: op.title } : {}),
            ...(op.kind !== undefined ? { kind: op.kind } : {}),
            ...(op.status !== undefined ? { status: op.status } : {}),
            ...(op.description !== undefined ? { description: op.description } : {}),
            // A thread someone saved on purpose is no longer a machine guess.
            auto: false,
          }
          const thread = await project.saveThread(input)
          results.push({ op: op.op, ok: true, id: thread.id, message: `saved thread "${thread.title}" (${thread.status})` })
          break
        }
        case 'remove-thread': {
          const id = (await resolveThreads([op.thread]))[0]!
          const removed = await project.deleteThread(id)
          if (!removed) throw new ProjectError('novel/not-found', `no thread matches "${op.thread}"`)
          results.push({ op: op.op, ok: true, id, message: `removed thread ${id}` })
          break
        }
        default:
          results.push({ op: (op as OutlineOp).op, ok: false, message: `unknown operation "${String((op as { op?: unknown }).op)}"` })
      }
    } catch (error) {
      results.push({ op: op.op, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

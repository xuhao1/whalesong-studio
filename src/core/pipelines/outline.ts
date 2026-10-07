// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Structural edits of the outline as a small operation vocabulary, shared by
 * the `novel_outline` tool and the Studio's outline view so both go through
 * the same validation.
 */
import type { Beat, ChapterPlan, ChapterStatus, PlotThread, ThreadKind, ThreadStatus } from '../../shared/types'
import { newId, sameName } from '../../shared/text'
import type { ProjectRuntime } from '../core'
import { ProjectError } from '../project'

export type OutlineOp =
  | { op: 'add-volume'; title: string; synopsis?: string; goal?: string; before?: string }
  | { op: 'update-volume'; volume: string; title?: string; synopsis?: string; goal?: string }
  | { op: 'move-volume'; volume: string; before?: string }
  | { op: 'remove-volume'; volume: string }
  | ({ op: 'add-chapter'; title: string; volume?: string; before?: string; after?: string } & ChapterFields)
  | ({ op: 'update-chapter'; chapter: string; title?: string } & ChapterFields)
  | { op: 'move-chapter'; chapter: string; volume?: string; before?: string; after?: string }
  | { op: 'remove-chapter'; chapter: string }
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
  targetWords?: number
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
    if (fields.targetWords !== undefined) patch.targetWords = Math.max(0, Math.round(fields.targetWords))
    return patch
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
          const where: { volume?: string; before?: string; after?: string } = {}
          if (op.volume !== undefined) where.volume = await findVolume(op.volume)
          for (const side of ['before', 'after'] as const) {
            const ref = op[side]
            if (ref === undefined) continue
            const anchor = await project.findChapter(ref)
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
          const where: { volume?: string; before?: string; after?: string } = {}
          if (op.volume !== undefined) where.volume = await findVolume(op.volume)
          for (const side of ['before', 'after'] as const) {
            const ref = op[side]
            if (ref === undefined) continue
            const anchor = await project.findChapter(ref)
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
        case 'remove-chapter': {
          const chapter = await project.findChapter(op.chapter)
          if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${op.chapter}"`)
          await project.removeChapter(chapter.plan.id)
          results.push({ op: op.op, ok: true, id: chapter.plan.id, message: `removed chapter "${chapter.plan.title}" (its text was snapshotted)` })
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

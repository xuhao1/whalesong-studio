// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the digests propose for the bible, settled without the author being
 * asked one item at a time: the planner looks the suggestions over — a new
 * place, thing, house or term; a thread planted or paid off; and, after it
 * looked through the names without a card ({@link siftCast}), whoever it
 * found worth one — and what it finds worth entering is entered. What was
 * entered is on record, each with its reason, for the author to open, change
 * or take back; what was not is on record too, and entered by a press.
 *
 * It is asked in one request a batch: everything it judges by is in the task.
 * A change to what somebody already wrote (`bible-edit`) is never settled
 * here — that is the author's to say.
 */
import { sameName, clip } from '../../shared/text'
import { groupOf } from '../../shared/world'
import { autoOf, type AutoSaid, type SettledSuggestion, type Suggestion, type WorldCategory, type WorldEntry } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { assign } from '../crew'
import { asArray, asRecord, asText } from '../llm'
import { architectSystem, settleTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { mapLimit } from '../util/async'
import { ProjectError } from '../project'
import { acceptSuggestion } from './bible'
import { mergeCast } from './cast'
import { keepNotedScenes } from './scenes'
import { settleWalkOn } from '../walkons'

export interface SettleResult {
  /** Suggestions looked at. */
  looked: number
  entered: string[]
  /** Folded into something the bible has already, as another name of it. */
  merged: { name: string; into: string }[]
  skipped: number
  failed: { step: string; error: string }[]
}

/** How many suggestions one request is asked about. */
const SETTLE_ROUND = 80
const CATEGORIES: WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']
/** What the planner settles: what a digest found in the text. (Whom it found worth a card it said already, sifting the names.) */
const JUDGED: Suggestion['kind'][] = ['new-world', 'new-thread', 'thread-status']

const KIND: Record<string, [string, string]> = {
  'new-world': ['新设定', 'new entry'],
  'new-thread': ['新线索', 'new thread'],
  'thread-status': ['线索状态', 'thread'],
}

/**
 * Settle the suggestions that wait: enter what is worth entering, fold in what is another name, and leave the rest
 * out — each on record with why.
 */
export async function settleSuggestions(core: NovelCore, runtime: ProjectRuntime, task: TaskContext): Promise<SettleResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const result: SettleResult = { looked: 0, entered: [], merged: [], skipped: 0, failed: [] }
  const record: Omit<SettledSuggestion, 'at'>[] = []
  const kept = (suggestion: Suggestion, verdict: SettledSuggestion['verdict'], extra: Partial<SettledSuggestion> = {}): void => {
    record.push({ id: suggestion.id, kind: suggestion.kind, title: suggestion.title, detail: suggestion.detail, payload: suggestion.payload, ...(suggestion.chapterId !== undefined ? { chapterId: suggestion.chapterId } : {}), verdict, ...extra })
  }
  await project.pruneSuggestions()
  const waiting = await project.suggestions()

  // ── whoever the planner found worth a card, and whose name is another's: said when it sifted the names — entered now ──
  for (const suggestion of waiting.filter(item => (item.kind === 'new-character' && item.sifted === true) || item.kind === 'alias')) {
    try {
      await acceptSuggestion(runtime, suggestion.id)
      if (suggestion.kind === 'alias') {
        const into = (await project.findCharacter(String(suggestion.payload.target)))?.name ?? String(suggestion.payload.target)
        result.merged.push({ name: String(suggestion.payload.name), into })
        kept(suggestion, 'merged', { why: suggestion.detail, into, target: { type: 'character', id: String(suggestion.payload.target) } })
      } else {
        const card = await project.findCharacter(String(suggestion.payload.name))
        result.entered.push(String(suggestion.payload.name))
        kept(suggestion, 'entered', { why: suggestion.detail, ...(card !== undefined ? { target: { type: 'character', id: card.id } } : {}) })
      }
      result.looked += 1
    } catch (error) {
      result.failed.push({ step: suggestion.title, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Those of them the story leans on get a card as whole as what the digests wrote of them allows — a line is not a card.
  const leaning = record.filter(item => item.kind === 'new-character' && item.verdict === 'entered' && ['protagonist', 'deuteragonist', 'antagonist', 'supporting'].includes(String(item.payload.role))).map(item => String(item.payload.name))
  if (leaning.length > 0) {
    const restore = task.job?.note(L(lang, `策划在给 ${leaning.length} 个新立卡的人物写卡…`, `The planner is writing the cards of ${leaning.length} people just entered…`))
    try {
      const cast = await mergeCast(core, runtime, { origin: task.origin, ...(task.signal !== undefined ? { signal: task.signal } : {}), ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) }, undefined, { only: leaning })
      result.failed.push(...cast.failed)
      await keepNotedScenes(runtime, (await project.characters()).map(card => card.id)).catch(() => [])
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      result.failed.push({ step: 'cards', error: error instanceof Error ? error.message : String(error) })
    } finally {
      restore?.()
    }
  }

  // ── what the digests found in the text: looked over by the planner, a batch a request ──
  const judged = waiting.filter(item => JUDGED.includes(item.kind))
  if (judged.length > 0) {
    const [world, outline, chapters] = await Promise.all([project.world(), project.outline(), project.chapters()])
    const indexOf = new Map(chapters.map(chapter => [chapter.plan.id, chapter.index]))
    const known = (['places', 'factions', 'items', 'ideas'] as const).map((group) => {
      const names = world.filter(entry => groupOf(entry.category) === group).map(entry => `${entry.name}${entry.aliases !== undefined && entry.aliases.length > 0 ? `（${entry.aliases.join(lang === 'zh' ? '、' : ', ')}）` : ''}`)
      return names.length > 0 ? `${L(lang, { places: '地点', factions: '家族与组织', items: '物品', ideas: '世界观与名词' }[group], { places: 'Places', factions: 'Houses', items: 'Things', ideas: 'Lore and terms' }[group])}${L(lang, '：', ': ')}${names.join(L(lang, '、', ', '))}` : undefined
    }).filter((line): line is string => line !== undefined).join('\n')
    const threads = outline.threads.map(thread => `${thread.title}（${thread.status}）`).join(L(lang, '、', ', '))
    const rounds: Suggestion[][] = []
    for (let at = 0; at < judged.length; at += SETTLE_ROUND) rounds.push(judged.slice(at, at + SETTLE_ROUND))
    const restore = task.job?.note(L(lang, `策划在审定 ${judged.length} 条设定建议…`, `The planner is settling ${judged.length} suggestion(s)…`))
    try {
      await mapLimit([...rounds.entries()], Math.max(1, await core.parallelFor('text', runtime)), async ([round, batch]) => {
        task.signal?.throwIfAborted()
        try {
          const lines = batch.map((item, at) => `${at + 1}. [${L(lang, ...(KIND[item.kind] ?? [item.kind, item.kind]))}${item.kind === 'new-world' && typeof item.payload.category === 'string' ? `·${item.payload.category}` : ''}] ${item.title} —— ${clip(item.detail, 200)}${item.chapterId !== undefined && indexOf.has(item.chapterId) ? L(lang, `（第 ${indexOf.get(item.chapterId)} 章）`, ` (chapter ${indexOf.get(item.chapterId)})`) : ''}`)
          const { value } = await core.through('text', async () => await assign(core, runtime, task, {
            role: 'architect',
            label: L(lang, `审定设定建议${rounds.length > 1 ? ` ${round + 1}/${rounds.length}` : ''}`, `Settling suggestions${rounds.length > 1 ? ` ${round + 1}/${rounds.length}` : ''}`),
            tool: 'settle_suggestions',
            // Everything it judges by is in the task: one request, whatever the role is set to.
            plain: true,
            what: L(lang, '每条建议的结论', 'a verdict on every suggestion'),
            system: architectSystem(lang),
            prompt: settleTask({ lang, language: manifest.language, title: manifest.title, suggestions: lines.join('\n'), known, threads }),
            temperature: 0.1,
            validate: raw => asRecord(raw),
          }), task.signal !== undefined ? { signal: task.signal } : {}, runtime)
          const said = new Map<number, Record<string, unknown>>()
          for (const raw of asArray(value.verdicts)) {
            const item = asRecord(raw)
            const n = Math.round(Number(item.n))
            if (Number.isFinite(n) && n >= 1 && n <= batch.length) said.set(n - 1, item)
          }
          for (const [at, suggestion] of batch.entries()) {
            const verdict = said.get(at)
            // Nothing said of one: it waits, as it did.
            if (verdict === undefined) continue
            result.looked += 1
            const what = asText(verdict.verdict)
            const why = asText(verdict.why)
            const reason = why !== undefined ? { why } : {}
            if (what === 'merge' && suggestion.kind === 'new-world') {
              const into = world.find(entry => sameName(entry.name, asText(verdict.into) ?? '') || (entry.aliases ?? []).some(alias => sameName(alias, asText(verdict.into) ?? '')))
              if (into !== undefined) {
                const name = String(suggestion.payload.name ?? suggestion.title)
                if (!sameName(into.name, name)) await project.saveWorld({ id: into.id, aliases: [...new Set([...(into.aliases ?? []), name])] })
                await project.takeSuggestion(suggestion.id)
                result.merged.push({ name, into: into.name })
                kept(suggestion, 'merged', { ...reason, into: into.name, target: { type: 'world', id: into.id } })
                continue
              }
            }
            if (what === 'merge' && suggestion.kind === 'new-thread') {
              // The same matter as a thread there is: nothing new to write down.
              await project.takeSuggestion(suggestion.id)
              const into = asText(verdict.into)
              result.merged.push({ name: suggestion.title, into: into ?? '' })
              kept(suggestion, 'merged', { ...reason, ...(into !== undefined ? { into } : {}) })
              continue
            }
            if (what === 'enter' || (what === 'merge' && suggestion.kind === 'thread-status')) {
              // Entered as proposed — with the kind and the line the planner put it under, where it said so.
              if (suggestion.kind === 'new-world') {
                const category = asText(verdict.category) as WorldCategory | undefined
                const summary = asText(verdict.summary)
                const taken = await project.takeSuggestion(suggestion.id)
                if (taken === undefined) continue
                const entry = await project.saveWorld({ ...(taken.payload as Partial<WorldEntry> & { name: string }), ...(category !== undefined && CATEGORIES.includes(category) ? { category } : {}), ...(summary !== undefined ? { summary } : {}) })
                result.entered.push(entry.name)
                kept(suggestion, 'entered', { ...reason, target: { type: 'world', id: entry.id } })
              } else {
                await acceptSuggestion(runtime, suggestion.id)
                result.entered.push(suggestion.title)
                kept(suggestion, 'entered', reason)
              }
              continue
            }
            // Not worth an entry: off the list of what waits, and on record — the author enters it by a press, if they see it otherwise.
            await project.takeSuggestion(suggestion.id)
            result.skipped += 1
            kept(suggestion, 'skipped', reason)
          }
        } catch (error) {
          if (task.signal?.aborted === true) throw error
          result.failed.push({ step: `settle ${round + 1}/${rounds.length}`, error: error instanceof Error ? error.message : String(error) })
        }
      })
    } finally {
      restore?.()
    }
  }
  if (record.length > 0) {
    await project.noteSettled(record)
    await project.addActivity({
      by: 'crew',
      role: 'architect',
      tool: 'settle',
      summary: clip(L(lang,
        `审定了 ${result.looked} 条设定建议：收进 ${result.entered.length} 条${result.entered.length > 0 ? `（${result.entered.slice(0, 8).join('、')}${result.entered.length > 8 ? '…' : ''}）` : ''}，并入 ${result.merged.length} 条，没收 ${result.skipped} 条。`,
        `Settled ${result.looked} suggestion(s): ${result.entered.length} entered${result.entered.length > 0 ? ` (${result.entered.slice(0, 8).join(', ')}${result.entered.length > 8 ? '…' : ''})` : ''}, ${result.merged.length} folded in, ${result.skipped} left out.`), 400),
    }).catch((error: unknown) => { core.log('could not put the settling of suggestions on the book\'s record', error) })
  }
  task.job?.result({ settled: { looked: result.looked, entered: result.entered.length, merged: result.merged.length, skipped: result.skipped } })
  return result
}

/**
 * The author says otherwise of one that was settled: what entered is taken back (a card or an entry goes where removed
 * ones go, and comes back from there; a name stops being another's), and what was left out is entered after all.
 */
export async function overrule(runtime: ProjectRuntime, id: string, to: 'undo' | 'enter'): Promise<SettledSuggestion> {
  const { project } = runtime
  const item = (await project.settled()).find(candidate => candidate.id === id)
  if (item === undefined) throw new ProjectError('novel/not-found', `nothing was settled under "${id}"`)
  const payload = item.payload
  const name = String(payload.name ?? payload.title ?? item.title)
  if (to === 'enter') {
    if (item.verdict === 'entered' || item.verdict === 'merged') return item
    let target: SettledSuggestion['target']
    switch (item.kind) {
      case 'new-world': target = { type: 'world', id: (await project.saveWorld(payload as Partial<WorldEntry> & { name: string })).id }; break
      case 'new-character': target = { type: 'character', id: (await project.saveCharacter(payload as { name: string })).id }; break
      case 'alias': await settleWalkOn(project, { name, action: 'alias', target: String(payload.target) }); target = { type: 'character', id: String(payload.target) }; break
      case 'new-thread': await project.saveThread({ title: String(payload.title), ...(typeof payload.description === 'string' ? { description: payload.description } : {}) }); break
      case 'thread-status': await project.saveThread({ id: String(payload.thread), status: payload.status as 'open' | 'paid' | 'dropped' }); break
      default: break
    }
    return (await project.resettle(id, 'entered', target))!
  }
  if (item.verdict !== 'entered' && item.verdict !== 'merged') return item
  if (item.verdict === 'merged' && item.target !== undefined) {
    // The name stops being another name of what it was folded into.
    if (item.target.type === 'world') {
      const entry = await project.findWorld(item.target.id)
      if (entry !== undefined) await project.saveWorld({ id: entry.id, aliases: (entry.aliases ?? []).filter(alias => !sameName(alias, name)) })
    } else {
      const card = await project.findCharacter(item.target.id)
      if (card !== undefined) await project.saveCharacter({ id: card.id, aliases: (card.aliases ?? []).filter(alias => !sameName(alias, name)) })
    }
    return (await project.resettle(id, 'undone'))!
  }
  switch (item.kind) {
    case 'new-world': if (item.target !== undefined) await project.deleteWorld(item.target.id); break
    case 'new-character': if (item.target !== undefined) await project.deleteCharacter(item.target.id); break
    case 'new-thread': {
      const thread = (await project.outline()).threads.find(candidate => sameName(candidate.title, String(payload.title)))
      if (thread !== undefined) await project.deleteThread(thread.id)
      break
    }
    // A thread a digest found paid off or dropped was open before it.
    case 'thread-status': await project.saveThread({ id: String(payload.thread), status: 'open' }); break
    default: break
  }
  return (await project.resettle(id, 'undone'))!
}

/**
 * Whether suggestions are settled by the planner as they come, or wait for the author one by one.
 * @param book - the book they are for, for its own switch (`ProjectManifest.settleSuggestions`).
 */
export const settlesItself = (core: NovelCore, book?: AutoSaid): boolean => autoOf(core.currentSettings(), book).settleSuggestions

const pending = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Settle what the digests proposed once things are quiet: after the chapters of a batch are digested and the names
 * without a card were looked through — one settling for all of it, not one per chapter.
 */
export function scheduleSettle(core: NovelCore, runtime: ProjectRuntime, task: Pick<TaskContext, 'origin' | 'agentRoute'>, wait = 7000): void {
  const root = runtime.project.root
  const before = pending.get(root)
  if (before !== undefined) clearTimeout(before)
  const timer = setTimeout(() => {
    pending.delete(root)
    void (async () => {
      if (!(await core.autoFor(runtime)).settleSuggestions) return
      const running = core.jobs.list(root).filter(job => job.status === 'running')
      if (running.some(job => job.kind === 'bible' && job.title === 'settle suggestions')) return
      // While chapters are still being digested, a book taken in, or the names looked through, the list is not yet what it will be.
      if (running.some(job => job.kind === 'digest' || job.kind === 'import' || job.kind === 'batch' || (job.kind === 'bible' && job.title === 'sift cast'))) {
        scheduleSettle(core, runtime, task, 6000)
        return
      }
      const waiting = await runtime.project.suggestions()
      if (!waiting.some(item => JUDGED.includes(item.kind) || item.kind === 'alias' || (item.kind === 'new-character' && item.sifted === true))) return
      core.jobs.start({ kind: 'bible', title: 'settle suggestions', project: root, origin: task.origin }, async (job) => {
        await settleSuggestions(core, runtime, { origin: task.origin, signal: job.signal, job, ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) })
      })
    })().catch((error: unknown) => { core.log('could not start settling the suggestions', error) })
  }, wait)
  timer.unref?.()
  pending.set(root, timer)
}

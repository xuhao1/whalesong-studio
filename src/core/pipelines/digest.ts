// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Digest: turn a written chapter into machine memory — a summary, hard facts,
 * where each character ended up, new names worth a bible entry and what
 * happened to the open threads. This is what lets a book keep its own
 * continuity past the point where it fits in a prompt, and what drives the
 * ensemble-cast lifecycle (first/last appearance, who has been away too long).
 */
import type {
  ChapterMemory, CharacterMoment, EntityCandidate, FactKind, MemoryFact, Suggestion, ThreadTouch,
} from '../../shared/types'
import { hashText, sameName } from '../../shared/text'
import type { ArcSummary } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText, completeJson } from '../llm'
import type { LocatedChapter } from '../project'
import { ProjectError } from '../project'
import { arcTask, digestSystem, digestTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { mapLimit } from '../util/async'

const FACT_KINDS: FactKind[] = ['state', 'relationship', 'knowledge', 'item', 'world', 'event']
const ENTITY_KINDS: EntityCandidate['kind'][] = ['character', 'location', 'item', 'faction', 'term']

function chapterLabel(chapter: LocatedChapter, zh: boolean): string {
  return zh ? `第${chapter.index}章《${chapter.plan.title}》` : `chapter ${chapter.index}, "${chapter.plan.title}"`
}

/** Digest one chapter. Returns the stored memory unchanged when the text has not changed. */
export async function digestChapter(core: NovelCore, runtime: ProjectRuntime, ref: string, task: TaskContext, options: { force?: boolean } = {}): Promise<ChapterMemory | undefined> {
  const { project } = runtime
  const chapter = await project.findChapter(ref)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
  const text = await project.chapterText(chapter.plan.id)
  if (text.length === 0) return undefined
  const textHash = hashText(text)
  const existing = await project.memory(chapter.plan.id)
  if (existing !== undefined && existing.textHash === textHash && options.force !== true) return existing

  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const [characters, world, outline] = await Promise.all([project.characters(), project.world(), project.outline()])
  const route = await core.route('analyst', runtime, task)
  const { value } = await completeJson(core.llm, {
    route,
    system: digestSystem(lang),
    prompt: digestTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      chapterLabel: chapterLabel(chapter, lang === 'zh'),
      text,
      knownCharacters: characters.map(card => `${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? ` | ${card.aliases.join('/')}` : ''}`).join('\n'),
      knownWorld: world.map(entry => entry.name).join(lang === 'zh' ? '、' : ', '),
      openThreads: outline.threads.filter(thread => thread.status === 'open').map(thread => `- ${thread.title}`).join('\n'),
    }),
    temperature: 0.1,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.summary) === undefined) throw new Error('"summary" is missing')
      return record
    },
  })

  const resolveCharacter = (name: string): string | undefined => characters.find(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)?.id
  const moments: CharacterMoment[] = []
  for (const raw of asArray(value.characters)) {
    const item = asRecord(raw)
    const name = asText(item.name)
    if (name === undefined) continue
    const lifecycle = asText(item.lifecycle)
    const stateAfter = asText(item.stateAfter)
    const role = asText(item.role)
    const location = asText(item.location)
    const emotion = asText(item.emotion)
    const quote = asText(item.quote)
    const learned = asList(item.learned)
    moments.push({
      character: resolveCharacter(name) ?? name,
      name,
      ...(role !== undefined ? { role } : {}),
      ...(stateAfter !== undefined ? { stateAfter } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(emotion !== undefined ? { emotion } : {}),
      ...(learned.length > 0 ? { learned } : {}),
      ...(quote !== undefined ? { quote: quote.replace(/^["“「『]|["”」』]$/g, '') } : {}),
      ...(lifecycle === 'enter' || lifecycle === 'exit' || lifecycle === 'death' || lifecycle === 'return' ? { lifecycle } : {}),
    })
  }
  const facts: MemoryFact[] = []
  for (const raw of asArray(value.facts)) {
    const item = asRecord(raw)
    const subject = asText(item.subject)
    const statement = asText(item.statement)
    if (subject === undefined || statement === undefined) continue
    const kind = asText(item.kind) as FactKind | undefined
    facts.push({ subject, statement, kind: kind !== undefined && FACT_KINDS.includes(kind) ? kind : 'event' })
  }
  const newEntities: EntityCandidate[] = []
  for (const raw of asArray(value.newEntities)) {
    const item = asRecord(raw)
    const name = asText(item.name)
    const kind = asText(item.kind) as EntityCandidate['kind'] | undefined
    if (name === undefined || kind === undefined || !ENTITY_KINDS.includes(kind)) continue
    newEntities.push({ name, kind, description: asText(item.description) ?? '' })
  }
  const threads: ThreadTouch[] = []
  for (const raw of asArray(value.threads)) {
    const item = asRecord(raw)
    const title = asText(item.title)
    const action = asText(item.action)
    if (title === undefined || (action !== 'plant' && action !== 'advance' && action !== 'payoff')) continue
    const match = outline.threads.find(thread => sameName(thread.title, title) || thread.title.includes(title) || title.includes(thread.title))
    const note = asText(item.note)
    threads.push({ title: match?.title ?? title, action, ...(note !== undefined ? { note } : {}), ...(match !== undefined ? { threadId: match.id } : {}) })
  }
  const storyTime = asText(value.storyTime)
  const openQuestions = asList(value.openQuestions)
  const locations = asList(value.locations)
  const summary = asText(value.summary)!
  const memory: ChapterMemory = {
    schema: 1,
    chapterId: chapter.plan.id,
    textHash,
    updatedAt: new Date().toISOString(),
    brief: asText(value.brief) ?? summary.slice(0, 60),
    summary,
    ...(storyTime !== undefined ? { storyTime } : {}),
    ...(locations.length > 0 ? { locations } : {}),
    facts,
    characters: moments,
    newEntities,
    threads,
    ...(openQuestions.length > 0 ? { openQuestions } : {}),
  }
  await project.saveMemory(memory)
  await applyMemory(runtime, chapter, memory, lang === 'zh')
  return memory
}

/** Fold a fresh memory into the bible: lifecycle fields, thread positions and suggestions. */
async function applyMemory(runtime: ProjectRuntime, chapter: LocatedChapter, memory: ChapterMemory, zh: boolean): Promise<void> {
  const { project } = runtime
  const characters = await project.characters()
  const located = await project.chapters()
  const indexOf = (id: string | undefined): number => located.find(candidate => candidate.plan.id === id)?.index ?? 0
  const suggestions: Omit<Suggestion, 'id' | 'createdAt'>[] = []

  for (const moment of memory.characters) {
    const card = characters.find(candidate => candidate.id === moment.character)
    if (card === undefined) continue
    const patch: Record<string, unknown> = {}
    if (card.firstAppearance === undefined || indexOf(card.firstAppearance) > chapter.index || indexOf(card.firstAppearance) === 0) patch.firstAppearance = chapter.plan.id
    if (card.lastAppearance === undefined || indexOf(card.lastAppearance) <= chapter.index) patch.lastAppearance = chapter.plan.id
    if (card.status === 'planned' || ((card.status === 'offstage' || card.status === 'retired') && moment.lifecycle !== 'exit' && moment.lifecycle !== 'death')) patch.status = 'active'
    if (Object.keys(patch).length > 0) await project.saveCharacter({ id: card.id, ...patch })
    // Leaving the stage or dying changes the cast for good; a human or the orchestrator confirms it.
    if (moment.lifecycle === 'death' && card.status !== 'dead') {
      suggestions.push({
        kind: 'character-status',
        title: zh ? `${card.name}：标记为已死亡？` : `${card.name}: mark as dead?`,
        detail: moment.stateAfter ?? moment.role ?? '',
        chapterId: chapter.plan.id,
        payload: { character: card.id, status: 'dead' },
      })
    } else if (moment.lifecycle === 'exit' && card.status !== 'offstage' && card.status !== 'retired' && card.status !== 'dead') {
      suggestions.push({
        kind: 'character-status',
        title: zh ? `${card.name}：标记为暂离？` : `${card.name}: mark as offstage?`,
        detail: moment.stateAfter ?? moment.role ?? '',
        chapterId: chapter.plan.id,
        payload: { character: card.id, status: 'offstage' },
      })
    }
  }

  const world = await project.world()
  for (const entity of memory.newEntities) {
    if (entity.kind === 'character') {
      if (characters.some(card => sameName(card.name, entity.name) || card.aliases?.some(alias => sameName(alias, entity.name)) === true)) continue
      suggestions.push({
        kind: 'new-character',
        title: zh ? `新人物：${entity.name}` : `New character: ${entity.name}`,
        detail: entity.description,
        chapterId: chapter.plan.id,
        payload: { name: entity.name, tagline: entity.description, status: 'active', role: 'minor', firstAppearance: chapter.plan.id, lastAppearance: chapter.plan.id },
      })
    } else {
      if (world.some(entry => sameName(entry.name, entity.name) || entry.aliases?.some(alias => sameName(alias, entity.name)) === true)) continue
      const category = entity.kind === 'location' ? 'location' : entity.kind === 'item' ? 'item' : entity.kind === 'faction' ? 'faction' : 'term'
      suggestions.push({
        kind: 'new-world',
        title: zh ? `新设定：${entity.name}` : `New world entry: ${entity.name}`,
        detail: entity.description,
        chapterId: chapter.plan.id,
        payload: { name: entity.name, category, summary: entity.description, importance: 3 },
      })
    }
  }

  const planted = memory.threads.filter(touch => touch.threadId === undefined && touch.action === 'plant')
  const touched = memory.threads.filter(touch => touch.threadId !== undefined)
  if (planted.length > 0 || touched.length > 0) {
    await project.updateOutline((draft) => {
      for (const touch of touched) {
        const thread = draft.threads.find(candidate => candidate.id === touch.threadId)
        if (thread === undefined) continue
        const key = touch.action === 'plant' ? 'planted' : touch.action === 'advance' ? 'advanced' : 'paid'
        const list = thread[key] ?? []
        if (!list.includes(chapter.plan.id)) thread[key] = [...list, chapter.plan.id]
      }
      for (const touch of planted) {
        if (draft.threads.some(thread => sameName(thread.title, touch.title))) continue
        draft.threads.push({
          id: `th_${hashText(touch.title).slice(0, 6)}`,
          title: touch.title,
          kind: 'foreshadow',
          status: 'open',
          ...(touch.note !== undefined ? { description: touch.note } : {}),
          planted: [chapter.plan.id],
          auto: true,
        })
      }
    })
  }
  for (const touch of touched.filter(candidate => candidate.action === 'payoff')) {
    suggestions.push({
      kind: 'thread-status',
      title: zh ? `线索已回收？${touch.title}` : `Thread paid off? ${touch.title}`,
      detail: touch.note ?? '',
      chapterId: chapter.plan.id,
      payload: { thread: touch.threadId!, status: 'paid' },
    })
  }
  await project.addSuggestions(suggestions)
}

/**
 * Digest every chapter whose memory is missing or stale.
 * @returns ids of the chapters digested in this call.
 */
export async function digestPending(core: NovelCore, runtime: ProjectRuntime, task: TaskContext, options: { chapters?: string[]; force?: boolean; concurrency?: number } = {}): Promise<{ digested: string[]; failed: { chapter: string; error: string }[] }> {
  const { project } = runtime
  const infos = await project.chapterInfos()
  let targets = infos.filter(info => info.hasText && (options.force === true || !info.digested))
  if (options.chapters !== undefined) {
    const wanted = new Set<string>()
    for (const ref of options.chapters) {
      const chapter = await project.findChapter(ref)
      if (chapter !== undefined) wanted.add(chapter.plan.id)
    }
    targets = infos.filter(info => info.hasText && wanted.has(info.id) && (options.force === true || !info.digested))
  }
  const digested: string[] = []
  const failed: { chapter: string; error: string }[] = []
  let done = 0
  task.job?.progress(0, targets.length)
  await mapLimit(targets, options.concurrency ?? 3, async (info) => {
    try {
      await digestChapter(core, runtime, info.id, task, options.force === true ? { force: true } : {})
      digested.push(info.id)
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push({ chapter: info.id, error: error instanceof Error ? error.message : String(error) })
    }
    done += 1
    task.job?.progress(done, targets.length, info.title)
  }, task.signal)
  if (digested.length > 0) await updateArcs(core, runtime, task)
  return { digested: digested.sort(), failed }
}

const ARC_SIZE = 10
const ARC_KEEP_RECENT = 6

/**
 * Keep arc summaries current: once enough chapters lie behind the most recent
 * ones, each block of ten is compressed into one synopsis, so the "story so
 * far" stays a few thousand tokens no matter how long the book gets.
 */
export async function updateArcs(core: NovelCore, runtime: ProjectRuntime, task: TaskContext): Promise<void> {
  const { project } = runtime
  const memories = await project.memories()
  // Arcs only cover an unbroken run of digested chapters from the start.
  const run: typeof memories = []
  for (const entry of memories) {
    if (entry.chapter.index !== run.length + 1) break
    run.push(entry)
  }
  const blocks = Math.floor(Math.max(0, run.length - ARC_KEEP_RECENT) / ARC_SIZE)
  const existing = (await project.readState<ArcSummary[]>('memory', 'arcs.json')) ?? []
  if (blocks === 0) {
    if (existing.length > 0) await project.writeState(['memory', 'arcs.json'], [])
    return
  }
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const next: ArcSummary[] = []
  let changed = existing.length !== blocks
  for (let block = 0; block < blocks; block++) {
    const slice = run.slice(block * ARC_SIZE, (block + 1) * ARC_SIZE)
    const summaries = slice.map(entry => `${L(lang, `第${entry.chapter.index}章`, `Chapter ${entry.chapter.index}`)} ${entry.chapter.plan.title}\n${entry.memory.summary}`).join('\n\n')
    const hash = hashText(summaries)
    const previous = existing.find(arc => arc.fromIndex === slice[0]!.chapter.index && arc.hash === hash)
    if (previous !== undefined) {
      next.push(previous)
      continue
    }
    const route = await core.route('analyst', runtime, task)
    const response = await core.llm.complete({
      route,
      prompt: arcTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        range: L(lang, `第 ${slice[0]!.chapter.index}–${slice.at(-1)!.chapter.index} 章`, `chapters ${slice[0]!.chapter.index}–${slice.at(-1)!.chapter.index}`),
        summaries,
      }),
      temperature: 0.2,
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
    })
    next.push({
      from: slice[0]!.chapter.plan.id,
      to: slice.at(-1)!.chapter.plan.id,
      fromIndex: slice[0]!.chapter.index,
      toIndex: slice.at(-1)!.chapter.index,
      summary: response.text.trim(),
      hash,
    })
    changed = true
  }
  if (changed) await project.writeState(['memory', 'arcs.json'], next)
}

/** Start a background digest for one chapter when auto-digest is on and none is already running. */
export function scheduleDigest(core: NovelCore, runtime: ProjectRuntime, chapterId: string, task: Pick<TaskContext, 'origin' | 'agentRoute'>): void {
  if (!core.currentSettings().autoDigest) return
  const root = runtime.project.root
  const busy = core.jobs.list(root).some(job => job.kind === 'digest' && job.status === 'running' && job.target === chapterId)
  if (busy) return
  core.jobs.start({ kind: 'digest', title: `digest ${chapterId}`, project: root, target: chapterId, origin: task.origin }, async (job) => {
    const inner: TaskContext = { origin: task.origin, signal: job.signal, job, ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) }
    await digestChapter(core, runtime, chapterId, inner)
    await updateArcs(core, runtime, inner)
  })
}

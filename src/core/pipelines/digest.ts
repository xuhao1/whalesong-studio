// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Digest: turn a written chapter into machine memory — a summary, hard facts,
 * where each character ended up, new names worth a bible entry and what
 * happened to the open threads. This is what lets a book keep its own
 * continuity past the point where it fits in a prompt, and what drives the
 * ensemble-cast lifecycle (first/last appearance, who has been away too long).
 */
import type {
  ChapterMemory, CharacterCard, CharacterMoment, EntityCandidate, FactKind, MemoryFact, Outline, PlanBlank, SceneNote, Suggestion, ThreadTouch,
} from '../../shared/types'
import { MAIN_LINE } from '../../shared/types'
import { clip, hashText, sameName } from '../../shared/text'
import type { ArcSummary } from '../context'
import { callsFor } from '../calls'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import type { LocatedChapter, WhoseMoment } from '../project'
import { ProjectError, selfNamed } from '../project'
import { arcTask, digestSystem, digestTask } from '../prompts'
import { planBlanks, planFromText } from '../plans'
import { L, promptLanguage } from '../render'
import { mapLimit } from '../util/async'
import { scheduleSift } from './cast'
import { keepNotedScenes } from './scenes'
import { scheduleSettle } from './settle'
import { schedulePlanFollow } from './follow'

const FACT_KINDS: FactKind[] = ['state', 'relationship', 'knowledge', 'item', 'world', 'event']
const ENTITY_KINDS: EntityCandidate['kind'][] = ['character', 'location', 'item', 'faction', 'term']

/** What a line of the plot is called on the page: its title, "the main line" for the main one. */
function lineName(outline: Pick<Outline, 'lines'>, line: string | undefined, zh: boolean): string {
  if (line === undefined || line === MAIN_LINE) return zh ? '主线' : 'the main line'
  return (outline.lines ?? []).find(candidate => candidate.id === line)?.title ?? line
}

function chapterLabel(chapter: LocatedChapter, zh: boolean): string {
  return zh ? `第${chapter.index}章《${chapter.plan.title}》` : `chapter ${chapter.index}, "${chapter.plan.title}"`
}

/** Digest one chapter. Returns the stored memory unchanged when the text has not changed. */
export async function digestChapter(core: NovelCore, runtime: ProjectRuntime, ref: string, task: TaskContext, options: { force?: boolean } = {}): Promise<ChapterMemory | undefined> {
  // The calls it makes are on record as this chapter's, whoever digests it: a job of its own, or one that goes through many.
  return await callsFor({ target: ref, step: 'digest' }, async () => await digestOne(core, runtime, ref, task, options))
}

async function digestOne(core: NovelCore, runtime: ProjectRuntime, ref: string, task: TaskContext, options: { force?: boolean }): Promise<ChapterMemory | undefined> {
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
  // Who a name is goes by the story the chapter is of: the people on file for this chapter are that story's (and
  // whoever no story has yet). Somebody of another story whose name the text spells is asked about — the same person
  // come over, or a namesake — and a narrator's "我" is never anybody else's.
  const { resolve, story } = await project.castResolver()
  const mine = characters.filter(card => [card.name, ...(card.aliases ?? [])].some(name => resolve(name, chapter.plan.id).id === card.id))
  const namesakes = characters.filter(card => !mine.includes(card) && [card.name, ...(card.aliases ?? [])].some(name => name.trim().length >= 2 && text.includes(name) && resolve(name, chapter.plan.id).elsewhere?.some(other => other.id === card.id) === true))
  const lineTitles = (card: CharacterCard, seenOn: Record<string, string[]>): string => (seenOn[card.id] ?? []).map(id => lineName(outline, id, lang === 'zh')).join(lang === 'zh' ? '、' : ', ')
  const seenOn = namesakes.length > 0 ? (await project.seenOn()).people : {}
  const { value } = await assign(core, runtime, task, {
    role: 'analyst',
    label: `${chapterLabel(chapter, lang === 'zh')} · ${L(lang, '收录记忆', 'memory')}`,
    line: chapter.line ?? MAIN_LINE,
    tool: 'record_memory',
    // The material is all in the task: a few looks at the book at most, then the result.
    // All of it is in the task: asked in one request, whatever the role is set to.
    plain: true,
    maxSteps: 12,
    what: L(lang, '这一章的场记：摘要、人物状态、事实、线索', 'the continuity notes of this chapter: summary, character states, facts, threads'),
    system: digestSystem(lang),
    prompt: digestTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      chapterLabel: chapterLabel(chapter, lang === 'zh'),
      text,
      knownCharacters: mine.map(card => `${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? ` | ${card.aliases.join('/')}` : ''}`).join('\n'),
      ...(namesakes.length > 0 ? { namesakes: namesakes.map(card => `- ${card.name}${lang === 'zh' ? '｜' : ' | '}${lineTitles(card, seenOn) || L(lang, '别的故事线', 'another line')}${card.tagline !== undefined ? `${lang === 'zh' ? '｜' : ' | '}${card.tagline}` : ''}`).join('\n') } : {}),
      knownWorld: world.map(entry => entry.name).join(lang === 'zh' ? '、' : ', '),
      openThreads: outline.threads.filter(thread => thread.status === 'open').map(thread => `- ${thread.title}`).join('\n'),
      // A book of several stories: the digest says of each new thing whether it is this story's or the world's.
      ...((outline.lines ?? []).length > 0 ? { line: lineName(outline, chapter.line, lang === 'zh') } : {}),
    }),
    temperature: 0.1,
    validate: (raw) => {
      const record = asRecord(raw)
      if (asText(record.summary) === undefined) throw new Error('"summary" is missing')
      return record
    },
  })

  // Of the namesakes asked about, those the digest said are the same person: they have come over into this story.
  const cameOver = new Set(asArray(value.namesakes).map(asRecord).filter(item => item.same === true).map(item => asText(item.name)).filter((name): name is string => name !== undefined))
  /** The card a name is, and who says so: the chapter's own story, or the digest, asked of somebody of another. */
  const settle = (name: string): { id: string; by: NonNullable<CharacterMoment['by']> } | undefined => {
    const who = resolve(name, chapter.plan.id)
    if (who.id !== undefined) return { id: who.id, by: 'story' }
    const over = who.elsewhere?.find(card => [card.name, ...(card.aliases ?? [])].some(known => [...cameOver].some(said => sameName(said, known))))?.id
    return over !== undefined ? { id: over, by: 'over' } : undefined
  }
  const resolveCharacter = (name: string): string | undefined => settle(name)?.id
  /**
   * The name somebody is kept under. One who is nobody on file in this story, and whose name another story's person
   * already bears — a namesake the digest told apart, or a narrator's "我", which is a different person in every
   * story — is kept under the name with their story after it ("我（城南的铺子）"): the card made for them is then a
   * card of their own, and nothing that goes by names takes the two for one. In a story beside the main one a
   * narrator is kept so from the first, whether or not the main story has its "我" on file yet.
   */
  const home = story(chapter.plan.id)
  const homeTitle = lineName(outline, home, lang === 'zh')
  const renamed = new Map<string, string>()
  const keptAs = (name: string): string => {
    if (resolveCharacter(name) !== undefined) return name
    const borne = characters.some(card => sameName(card.name, name) || card.aliases?.some(alias => sameName(alias, name)) === true)
    const apart = selfNamed(name) ? home !== MAIN_LINE || borne : resolve(name, chapter.plan.id).elsewhere !== undefined
    if (!apart) return name
    const kept = lang === 'zh' ? `${name}（${homeTitle}）` : `${name} (${homeTitle})`
    renamed.set(name, kept)
    return kept
  }
  const moments: CharacterMoment[] = []
  for (const raw of asArray(value.characters)) {
    const item = asRecord(raw)
    const said = asText(item.name)
    if (said === undefined) continue
    const name = keptAs(said)
    const lifecycle = asText(item.lifecycle)
    const stateAfter = asText(item.stateAfter)
    const role = asText(item.role)
    const location = asText(item.location)
    const emotion = asText(item.emotion)
    const quote = asText(item.quote)
    const seen = asText(item.seen)
    const manner = asText(item.manner)
    const learned = asList(item.learned)
    const settled = settle(name)
    moments.push({
      character: settled?.id ?? name,
      name,
      ...(settled !== undefined ? { by: settled.by } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(stateAfter !== undefined ? { stateAfter } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(emotion !== undefined ? { emotion } : {}),
      ...(learned.length > 0 ? { learned } : {}),
      ...(quote !== undefined ? { quote: quote.replace(/^["“「『]|["”」』]$/g, '') } : {}),
      ...(seen !== undefined ? { seen: clip(seen, 240, '…') } : {}),
      ...(manner !== undefined ? { manner: clip(manner, 160, '…') } : {}),
      ...(lifecycle === 'enter' || lifecycle === 'exit' || lifecycle === 'death' || lifecycle === 'return' ? { lifecycle } : {}),
    })
  }
  // Moments somebody would be remembered by, noted as the chapter was read: what their signature scenes are put
  // together from. Whose each is goes as for the notes above.
  const scenes: SceneNote[] = []
  for (const raw of asArray(value.scenes)) {
    const item = asRecord(raw)
    const said = asText(item.name)
    const text = asText(item.picture) ?? asText(item.text)
    if (said === undefined || text === undefined || text.length < 8) continue
    const name = keptAs(said)
    const settled = settle(name)
    const weight = Math.round(Number(item.weight))
    scenes.push({
      character: settled?.id ?? name,
      name,
      ...(settled !== undefined ? { by: settled.by } : {}),
      title: clip(asText(item.title) ?? '', 16, ''),
      text: clip(text, 400, '…'),
      weight: weight === 3 || weight === 1 ? weight : 2,
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
    const scope = asText(item.scope)
    // A person among them goes by the name they are kept under above.
    const looks = kind === 'location' || kind === 'item' || kind === 'faction' ? asText(item.looks) : undefined
    newEntities.push({ name: kind === 'character' ? renamed.get(name) ?? keptAs(name) : name, kind, description: asText(item.description) ?? '', ...(looks !== undefined ? { looks: clip(looks, 240, '…') } : {}), ...(scope === 'line' || scope === 'world' ? { scope } : {}) })
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
    ...(scenes.length > 0 ? { scenes } : {}),
    newEntities,
    threads,
    ...(openQuestions.length > 0 ? { openQuestions } : {}),
  }
  // Read anew: what the reading before this one left in the book — its marks on the threads, the blanks of the plan it
  // filled, what it suggested — is taken back first, so that nothing of a text that is gone stays behind. (A thread
  // this reading speaks of stays, whoever proposed it.)
  if (existing !== undefined) {
    const spoken = new Set(threads.flatMap(touch => (touch.threadId !== undefined ? [touch.threadId] : [])))
    await takeBack(runtime, (await project.findChapter(chapter.plan.id)) ?? chapter, existing, { keep: spoken }).catch((error: unknown) => { core.log(`could not take back the earlier digest of ${chapter.plan.id}`, error) })
  }
  await project.saveMemory(memory)
  await applyMemory(runtime, chapter, memory, lang === 'zh')
  // Whoever has a moment noted here gets it among their signature scenes, where nobody has taken that list in hand.
  await keepNotedScenes(runtime, scenes.filter(note => note.by !== undefined).map(note => note.character)).catch((error: unknown) => { core.log('could not bring the signature scenes up to date', error) })
  // What the plan leaves empty is filled from what the chapter turned out to be.
  await fillPlans(runtime, [chapter.plan.id]).catch(() => {})
  // A chapter digested before was changed since (or is read again): its plan may say what was meant rather than
  // what is there now, so it is read against the text. A first digest leaves the plan be — it was what was written by.
  if (existing !== undefined) schedulePlanFollow(core, runtime, chapter.plan.id, task)
  // Whoever this chapter names that has no card is on the list of walk-ons by now: once the digests have settled,
  // the planner looks through that list and says who is worth a card.
  scheduleSift(core, runtime, task)
  scheduleSettle(core, runtime, task)
  return memory
}

// ───────────────────────────── a plan's blanks ─────────────────────────────

export { planBlanks } from '../plans'

/**
 * Fill the blanks of chapter plans from their digests (see {@link planBlanks}).
 * @param only - chapter ids to look at; left out: every digested chapter of the main line.
 * @param dry - count what would be filled, and write nothing.
 * @returns how many chapters had (or would have) something filled, and how many fields in all.
 */
export async function fillPlans(runtime: ProjectRuntime, only?: readonly string[], dry = false): Promise<{ chapters: number; fields: number }> {
  const { project } = runtime
  const [characters, outline, manifest] = await Promise.all([project.characters(), project.outline(), project.manifest()])
  const zh = promptLanguage(manifest.language) === 'zh'
  const wanted = only !== undefined ? new Set(only) : undefined
  const located = wanted !== undefined ? (await Promise.all([...wanted].map(async id => await project.findChapter(id)))).filter((chapter): chapter is LocatedChapter => chapter !== undefined) : undefined
  let chapters = 0
  let fields = 0
  const { whose } = await project.castResolver()
  for (const { chapter, memory } of await project.memories(located)) {
    const patch = planBlanks(chapter.plan, memory, characters, outline, zh, whose)
    const count = Object.keys(patch).length
    if (count === 0) continue
    // What is filled is marked as read off the chapter: it says what the text is, and is not what was meant for it.
    if (!dry) await project.updateChapter(chapter.plan.id, { ...patch, fromText: [...new Set([...(chapter.plan.fromText ?? []), ...(Object.keys(patch) as PlanBlank[])])] })
    chapters += 1
    fields += count
  }
  return { chapters, fields }
}

/**
 * Fold a fresh memory into the bible: where each character is first and last
 * seen, thread positions and suggestions. What happens on another line of the plot is that line's: who
 * dies there is not dead in the book, and a thread paid off there is still
 * open on the main line — so of such a chapter only the new people and things
 * it names are put forward. A line made the main one has its chapters folded
 * in then ({@link foldIn}).
 */
async function applyMemory(runtime: ProjectRuntime, chapter: LocatedChapter, memory: ChapterMemory, zh: boolean): Promise<void> {
  const { project } = runtime
  const characters = await project.characters()
  const located = await project.chapters()
  const indexOf = (id: string | undefined): number => located.find(candidate => candidate.plan.id === id)?.index ?? 0
  const suggestions: Omit<Suggestion, 'id' | 'createdAt'>[] = []
  const main = chapter.line === undefined

  for (const moment of main ? memory.characters : []) {
    // (Settled just now, as the chapter was read: a bare name that happens to be somebody's id is not theirs.)
    const card = moment.by !== undefined ? characters.find(candidate => candidate.id === moment.character) : undefined
    if (card === undefined) continue
    const patch: Record<string, unknown> = {}
    if (card.firstAppearance === undefined || indexOf(card.firstAppearance) > chapter.index || indexOf(card.firstAppearance) === 0) patch.firstAppearance = chapter.plan.id
    if (card.lastAppearance === undefined || indexOf(card.lastAppearance) <= chapter.index) patch.lastAppearance = chapter.plan.id
    // That somebody comes on, leaves or dies here is in the digest itself, and is read from there along whichever line
    // is looked at (`Project.lives`): nothing is written on the card about it, and nobody is asked to confirm a label.
    if (Object.keys(patch).length > 0) await project.saveCharacter({ id: card.id, ...patch })
  }

  const world = await project.world()
  const outline = await project.outline()
  // Whose a new thing is, in a book of several stories. The digest says so of each as it reads the chapter (`scope`);
  // where it did not — a digest from before, a model that left it out — a thing found beside the main line is that
  // line's and one found on the main line the world's. The lines it is filed under are those that read this chapter:
  // its own, and whichever part from it later on. When that is every line there is, it is the world's after all.
  const several = (outline.lines ?? []).length > 0
  const readers = several ? await project.linesReading(chapter.plan.id) : undefined
  const names = (readers?.lines ?? []).map(id => zh ? `“${lineName(outline, id, true)}”` : `"${lineName(outline, id, false)}"`).join(zh ? '、' : ', ')
  for (const entity of memory.newEntities) {
    if (entity.kind === 'character') {
      // A name is not proposed for a card because a chapter met it: a digest names everybody, the doorman as much as
      // the rival. They are all on the list of walk-ons (read off the digests), and who among them is worth a card is
      // the planner's to say once it sees them side by side (`siftCast`).
      continue
    } else {
      if (world.some(entry => sameName(entry.name, entity.name) || entry.aliases?.some(alias => sameName(alias, entity.name)) === true)) continue
      const category = entity.kind === 'location' ? 'location' : entity.kind === 'item' ? 'item' : entity.kind === 'faction' ? 'faction' : 'term'
      const own = readers !== undefined && !readers.every && (entity.scope !== undefined ? entity.scope === 'line' : !main)
      const said = entity.scope !== undefined
      const note = own ? (zh ? `（${said ? '场记：只属于' : '发现于'}${names}，采纳后归到${readers!.lines.length > 1 ? '这几条线' : '这条线'}）` : ` (${said ? 'continuity: of' : 'found on'} ${names} alone; filed there when accepted)`)
        : several && entity.scope === 'world' ? (zh ? '（场记：几条线共用的）' : ' (continuity: of the world the lines share)') : ''
      suggestions.push({
        kind: 'new-world',
        title: zh ? `新设定：${entity.name}` : `New world entry: ${entity.name}`,
        detail: `${entity.description}${note}`,
        chapterId: chapter.plan.id,
        payload: { name: entity.name, category, summary: entity.description, importance: 3, ...(own ? { lines: readers!.lines } : {}) },
      })
    }
  }

  const planted = main ? memory.threads.filter(touch => touch.threadId === undefined && touch.action === 'plant') : []
  const touched = main ? memory.threads.filter(touch => touch.threadId !== undefined) : []
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

// ───────────────────────────── a digest taken back ─────────────────────────────

export interface TakenBack {
  /** The fields of the chapter's plan that were read off it, emptied again. */
  fields: PlanBlank[]
  /** Threads the chapter's marks were taken off; `gone`: those among them that only this chapter's digest had proposed. */
  threads: number
  gone: number
  /** Suggestions that waited on this chapter's word, dropped. */
  suggestions: number
}

/**
 * Take back what a chapter's digest left in the book beside the digest itself: the blanks of the plan it filled, its
 * marks on the threads (planted, advanced, paid off here) with the threads that only it proposed and nobody confirmed,
 * the suggestions that still wait, and where its people were first and last seen.
 * @param how.keep - threads that stay whatever proposed them (the reading that follows speaks of them).
 */
async function takeBack(runtime: ProjectRuntime, chapter: LocatedChapter, memory: ChapterMemory, how: { keep?: ReadonlySet<string> } = {}): Promise<TakenBack> {
  const { project } = runtime
  const id = chapter.plan.id
  const zh = promptLanguage((await project.manifest()).language) === 'zh'
  const [characters, outline] = await Promise.all([project.characters(), project.outline()])
  const { whose } = await project.castResolver()

  const fields = planFromText(chapter.plan, memory, characters, outline, zh, whose)
  if (fields.length > 0) await project.updateChapter(id, { ...Object.fromEntries(fields.map(field => [field, null])), fromText: null } as unknown as Partial<LocatedChapter['plan']>)

  let threads = 0
  const gone = new Set<string>()
  const marks = { plant: 'planted', advance: 'advanced', payoff: 'paid' } as const
  if (memory.threads.length > 0) {
    await project.updateOutline((draft) => {
      const touched = new Set<string>()
      for (const touch of memory.threads) {
        const thread = draft.threads.find(candidate => candidate.id === touch.threadId) ?? (touch.threadId === undefined ? draft.threads.find(candidate => sameName(candidate.title, touch.title)) : undefined)
        const mark = marks[touch.action]
        if (thread === undefined || thread[mark]?.includes(id) !== true) continue
        const left = thread[mark]!.filter(other => other !== id)
        if (left.length > 0) thread[mark] = left
        else delete thread[mark]
        touched.add(thread.id)
      }
      threads = touched.size
      // One that only this chapter's digest proposed, and nobody confirmed: without the chapter there is no such thread.
      for (const thread of draft.threads) {
        if (touched.has(thread.id) && thread.auto === true && how.keep?.has(thread.id) !== true && thread.planted === undefined && thread.advanced === undefined && thread.paid === undefined) gone.add(thread.id)
      }
      if (gone.size > 0) draft.threads = draft.threads.filter(thread => !gone.has(thread.id))
    })
  }

  let suggestions = 0
  if ((await project.suggestions()).some(item => item.chapterId === id)) {
    await project.updateState<Suggestion[]>(['suggestions.json'], [], current => current.filter((item) => {
      if (item.chapterId !== id) return true
      suggestions += 1
      return false
    }))
  }

  // Where its people were first and last seen is read off the digests that are left.
  const seenHere = characters.filter(card => card.firstAppearance === id || card.lastAppearance === id)
  if (seenHere.length > 0) {
    const others = (await project.memories()).filter(entry => entry.chapter.plan.id !== id)
    for (const card of seenHere) {
      const seen = others.filter(entry => entry.memory.characters.some(moment => moment.by !== undefined && moment.character === card.id)).map(entry => entry.chapter.plan.id)
      await project.saveCharacter({
        id: card.id,
        ...(card.firstAppearance === id ? { firstAppearance: seen[0] ?? null } : {}),
        ...(card.lastAppearance === id ? { lastAppearance: seen.at(-1) ?? null } : {}),
      } as unknown as Parameters<typeof project.saveCharacter>[0])
    }
  }
  return { fields, threads, gone: gone.size, suggestions }
}

export interface Forgotten extends TakenBack {
  chapterId: string
  /** False when the chapter had no memory: nothing was done. */
  forgot: boolean
}

/**
 * Clear a chapter's memory: its digest goes, and with it what the digest left in the book — the blanks of the plan it
 * filled, its marks on the threads, what it suggested. The chapter stands as one never digested; its text is not
 * touched, and a digest brings the memory back.
 * @throws ProjectError `novel/busy` while the chapter is being digested.
 */
export async function forgetChapter(core: NovelCore, runtime: ProjectRuntime, ref: string): Promise<Forgotten> {
  const { project } = runtime
  const chapter = await project.findChapter(ref)
  if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
  const id = chapter.plan.id
  if (core.jobs.list(project.root).some(job => job.status === 'running' && job.kind === 'digest' && job.target === id)) throw new ProjectError('novel/busy', `chapter ${chapter.index} is being digested right now — stop that first, or wait for it`)
  const memory = await project.memory(id)
  if (memory === undefined) return { chapterId: id, forgot: false, fields: [], threads: 0, gone: 0, suggestions: 0 }
  const back = await takeBack(runtime, chapter, memory)
  await project.removeState('memory', `${id}.json`)
  // A stretch summed up with this chapter in it — or after it: the run of digested chapters ends before it now.
  if (chapter.line === undefined) {
    const arcs = (await project.readState<ArcSummary[]>('memory', 'arcs.json')) ?? []
    const kept = arcs.filter(arc => arc.toIndex < chapter.index)
    if (kept.length !== arcs.length) await project.writeState(['memory', 'arcs.json'], kept)
  }
  return { chapterId: id, forgot: true, ...back }
}

/**
 * Fold the memories these chapters already have into the bible, without
 * asking a model again — for chapters that have just become part of the main line.
 */
export async function foldIn(runtime: ProjectRuntime, chapterIds: readonly string[]): Promise<number> {
  const { project } = runtime
  const zh = promptLanguage((await project.manifest()).language) === 'zh'
  let folded = 0
  for (const id of chapterIds) {
    const chapter = await project.findChapter(id)
    const memory = chapter !== undefined ? await project.memory(id) : undefined
    if (chapter === undefined || memory === undefined) continue
    await applyMemory(runtime, chapter, memory, zh)
    folded += 1
  }
  return folded
}

/**
 * Digest every chapter whose memory is missing or stale.
 * @returns ids of the chapters digested in this call.
 */
export async function digestPending(core: NovelCore, runtime: ProjectRuntime, task: TaskContext, options: { chapters?: string[]; force?: boolean; concurrency?: number } = {}): Promise<{ digested: string[]; failed: { chapter: string; error: string }[] }> {
  const { project } = runtime
  // Every line of the plot, not the main one alone: what a line makes of the world is read off the digests of its own chapters.
  const infos = await project.chapterInfos()
  for (const line of (await project.outline()).lines ?? []) {
    for (const info of await project.chapterInfos(line.id)) if (!infos.some(known => known.id === info.id)) infos.push(info)
  }
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
  await mapLimit(targets, options.concurrency ?? await core.parallelFor('text', runtime), async (info) => {
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

/**
 * Start a background digest for one chapter when auto-digest is on — for this book: its own switch where it has one,
 * else the Studio's — and none is already running. Waited for only as far as the start: the digest itself runs on.
 */
export async function scheduleDigest(core: NovelCore, runtime: ProjectRuntime, chapterId: string, task: Pick<TaskContext, 'origin' | 'agentRoute'>): Promise<void> {
  try {
    if (!(await core.autoFor(runtime)).autoDigest) return
    const root = runtime.project.root
    const busy = core.jobs.list(root).some(job => job.kind === 'digest' && job.status === 'running' && job.target === chapterId)
    if (busy) return
    core.jobs.start({ kind: 'digest', title: `digest ${chapterId}`, project: root, target: chapterId, origin: task.origin }, async (job) => {
      const inner: TaskContext = { origin: task.origin, signal: job.signal, job, ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) }
      await digestChapter(core, runtime, chapterId, inner)
      await updateArcs(core, runtime, inner)
    })
  } catch (error) {
    // (Not starting a digest is no reason for what changed the text to fail.)
    core.log('could not start digesting a chapter', error)
  }
}

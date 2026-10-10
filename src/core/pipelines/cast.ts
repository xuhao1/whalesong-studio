// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The cast of a book, made from what its chapters say.
 *
 * Every name the chapter digests found is counted; the same person under
 * several names is made one; and each gets a card as full as their part is
 * large: whoever comes back again and again a whole card, whoever comes back
 * once a line, and whoever passes through a single chapter is left a walk-on
 * — on the page, in the walk-ons list, and out of the way.
 *
 * A long book has hundreds of names, so the planner is asked in rounds, the
 * most present first, and each round is told who is known already: a name that
 * turns out to be somebody's other name becomes an alias, not a second card.
 *
 * An import runs this after its digests. It can be run on any book again: it
 * adds who is missing, fills what is empty and folds together only cards that
 * nobody has worked on.
 */
import { mapLimit, serializer } from '../util/async'
import type { CharacterCard, Suggestion, WalkOn, WalkOnVerdict } from '../../shared/types'
import { clip, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { assign } from '../crew'
import { asArray, asList, asRecord, asText } from '../llm'
import { architectSystem, castAliasTask, castRoundTask, castSiftTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { fillPlans } from './digest'
import { scheduleSettle } from './settle'
import { pickText } from './plot'
import { foldName, listWalkOns, noteVerdicts } from '../walkons'

export interface CastResult {
  /** Cards made for people who had none. */
  made: number
  /** Cards that were there, thin, and are filled in now. */
  filled: number
  /** Names that turned out to be another name of somebody: aliases now. */
  merged: number
  /** People seen in the text who are left as walk-ons. */
  walkOns: number
  rounds: number
  failed: { step: string; error: string }[]
}

const ROLES: CharacterCard['role'][] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']
/**
 * How many people one request is asked to write whole cards for, and how many a line each.
 * Not a ceiling on the cast — there are as many rounds as it takes — but the size of one hand-in: the first live run asked
 * for fourteen whole cards at once, and the planner's first answer came back too long to be read as JSON.
 */
const FULL_ROUND = 8
const LIGHT_ROUND = 40
/** The fields a person, not a machine, fills in: a card that has none of them is as the Studio made it. */
const WORKED_ON: (keyof CharacterCard)[] = ['appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice', 'persona', 'visual', 'voiceProfile', 'relationships', 'notes']

const clean = (name: string): string => name.trim().replace(/^["'“”‘’「」『』《》\s]+|["'“”‘’「」『』《》\s]+$/gu, '')
const fold = (name: string): string => clean(name).toLowerCase().replace(/[\s·・.．-]+/gu, '')

/** A card nobody has worked on: made from a suggestion, or by an earlier pass that had only a line to give. */
export function isThinCard(card: CharacterCard): boolean {
  return WORKED_ON.every((field) => {
    const value = card[field]
    return value === undefined || (typeof value === 'string' && value.trim().length === 0) || (Array.isArray(value) && value.length === 0)
  })
}

interface Sighting {
  name: string
  /** Chapters they act in, in reading order. */
  chapters: string[]
  first: number
  last: number
  notes: string[]
  quotes: string[]
  /** How the chapters say they look, and how they show themselves to be: what a card is written from. */
  looks: string[]
  manners: string[]
  /** The card that already stands for this name, when it is a thin one to be filled. */
  card?: CharacterCard
}

/**
 * Who the chapters name that the bible does not know, and how much each is on the page.
 * @returns `open`: names to be given a card or made an alias, most present first; `known`: how often each card's person is seen.
 */
export async function castSightings(runtime: ProjectRuntime): Promise<{ open: Sighting[]; known: Map<string, number>; chapters: number }> {
  const { project } = runtime
  const [cards, memories] = await Promise.all([project.characters(), project.memories()])
  const lang = promptLanguage((await project.manifest()).language)
  const byName = new Map<string, CharacterCard>()
  for (const card of cards) {
    byName.set(fold(card.id), card)
    byName.set(fold(card.name), card)
    for (const alias of card.aliases ?? []) byName.set(fold(alias), card)
  }
  const open = new Map<string, Sighting>()
  const known = new Map<string, number>()
  const seen = (raw: string, chapter: { id: string; index: number } | undefined, note?: string, quote?: string, looks?: string, manner?: string): void => {
    const name = clean(raw)
    const key = fold(name)
    if (key.length === 0 || name.length > 24) return
    const card = byName.get(key)
    // A card somebody worked on is who it is: only how often they are seen is of interest.
    if (card !== undefined && !isThinCard(card)) {
      if (chapter !== undefined) known.set(card.id, (known.get(card.id) ?? 0) + 1)
      return
    }
    const at = card !== undefined ? fold(card.name) : key
    let entry = open.get(at)
    if (entry === undefined) {
      entry = { name: card?.name ?? name, chapters: [], first: chapter?.index ?? 0, last: chapter?.index ?? 0, notes: [], quotes: [], looks: [], manners: [], ...(card !== undefined ? { card } : {}) }
      open.set(at, entry)
    }
    if (chapter !== undefined && !entry.chapters.includes(chapter.id)) {
      entry.chapters.push(chapter.id)
      if (entry.first === 0) entry.first = chapter.index
      entry.last = chapter.index
    }
    const text = note?.trim()
    if (text !== undefined && text.length > 0 && entry.notes.length < 5) entry.notes.push(chapter !== undefined ? `${L(lang, `第${chapter.index}章`, `ch.${chapter.index}`)}: ${clip(text, 110)}` : clip(text, 110))
    if (quote !== undefined && quote.trim().length > 0 && entry.quotes.length < 2) entry.quotes.push(clip(quote.trim(), 60))
    // What the chapters say of how they look and how they are: the first few, each by its chapter — a card is written from these.
    if (looks !== undefined && looks.trim().length > 0 && entry.looks.length < 4) entry.looks.push(chapter !== undefined ? `${L(lang, `第${chapter.index}章`, `ch.${chapter.index}`)}: ${clip(looks.trim(), 160)}` : clip(looks.trim(), 160))
    if (manner !== undefined && manner.trim().length > 0 && entry.manners.length < 4) entry.manners.push(clip(manner.trim(), 100))
  }
  for (const { chapter, memory } of memories) {
    const here = { id: chapter.plan.id, index: chapter.index }
    for (const moment of memory.characters) seen(moment.name, here, [moment.role, moment.stateAfter].filter(Boolean).join(' → '), moment.quote, moment.seen, moment.manner)
    // Named as new but not acting: worth a note, not a chapter to their count.
    for (const entity of memory.newEntities) if (entity.kind === 'character') seen(entity.name, undefined, entity.description)
  }
  const ranked = [...open.values()].sort((left, right) => right.chapters.length - left.chapters.length || left.first - right.first)
  return { open: ranked, known, chapters: memories.length }
}

/**
 * Give the people of the book their cards.
 * @param onRound - told before each request to the planner: which round of how many, and who it is about.
 * @param options.only - write whole cards for these people alone, however seldom the digests saw them: those the
 * planner found worth a card when it looked through the names, whose cards are a line so far.
 */
export async function mergeCast(core: NovelCore, runtime: ProjectRuntime, task: TaskContext, onRound?: (done: number, total: number, label: string) => void, options: { only?: readonly string[] } = {}): Promise<CastResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const result: CastResult = { made: 0, filled: 0, merged: 0, walkOns: 0, rounds: 0, failed: [] }
  const { open, chapters } = await castSightings(runtime)
  if (open.length === 0) return result

  // How large a part earns what: in a long book coming back three times is a part and twice a face; a short one has no room for such distinctions.
  const long = chapters > 12
  // A short book's few most present people are its cast, however seldom the digests saw them.
  const only = options.only
  const whole = only !== undefined
    ? open.filter(entry => only.some(name => sameName(name, entry.name)))
    : open.filter((entry, rank) => entry.chapters.length >= (long ? 3 : 2) || (!long && rank < 8 && entry.chapters.length >= 1))
  const wholeNames = new Set(whole.map(entry => entry.name))
  // A line for whoever came back once and has no card. A thin card whose person has not grown is left as it is: asking about it again would say the same again.
  const lined = only !== undefined ? [] : open.filter(entry => !wholeNames.has(entry.name) && entry.card === undefined && entry.chapters.length === 2)
  result.walkOns = only !== undefined ? 0 : open.filter(entry => entry.card === undefined && !wholeNames.has(entry.name)).length - lined.length
  if (whole.length === 0 && lined.length === 0) return result

  const rounds: { full: boolean; people: Sighting[] }[] = []
  for (let at = 0; at < whole.length; at += FULL_ROUND) rounds.push({ full: true, people: whole.slice(at, at + FULL_ROUND) })
  for (let at = 0; at < lined.length; at += LIGHT_ROUND) rounds.push({ full: false, people: lined.slice(at, at + LIGHT_ROUND) })

  const base = { lang, language: manifest.language, title: manifest.title }
  // Everything a round is asked is in its task — what the digests noted of each of these people — so a round is one
  // request, and rounds go out side by side: nobody reads the book again for a card. In two waves: those the book is
  // carried by first, then everybody else, who are then told who the leads are (a name of the page is often another
  // name of one of them). Cards are written one round at a time all the same (`inTurn`).
  let started = 0
  const inTurn = serializer()
  const numbered = [...rounds.entries()]
  for (const wave of [numbered.filter(([, round]) => round.full), numbered.filter(([, round]) => !round.full)]) {
  if (wave.length === 0) continue
  await mapLimit(wave, Math.max(1, core.parallel('text')), async ([at, round]) => {
    task.signal?.throwIfAborted()
    const names = round.people.slice(0, 3).map(entry => entry.name).join(lang === 'zh' ? '、' : ', ')
    onRound?.(started++, rounds.length, L(lang, `${names}${round.people.length > 3 ? ` 等 ${round.people.length} 人` : ''}`, `${names}${round.people.length > 3 ? ` and ${round.people.length - 3} more` : ''}`))
    try {
      const cards = await project.characters()
      // Who is known already, so that another name of theirs is recognized: everyone but the ones this round is about.
      const asked = new Set(round.people.map(entry => fold(entry.name)))
      const known = cards
        .filter(card => !asked.has(fold(card.name)))
        .map(card => `${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? `（${card.aliases.join(lang === 'zh' ? '、' : ', ')}）` : ''}${card.tagline !== undefined ? ` — ${clip(card.tagline, 40)}` : ''}`)
      const sightings = round.people.map(entry => `- ${entry.name} (${L(lang, `出场 ${entry.chapters.length} 章${entry.first > 0 ? `，第${entry.first}–${entry.last}章` : ''}`, `${entry.chapters.length} chapters${entry.first > 0 ? `, ch.${entry.first}–${entry.last}` : ''}`)})${entry.notes.length > 0 ? `\n  ${entry.notes.join('\n  ')}` : ''}${entry.looks.length > 0 ? `\n  ${L(lang, '样子', 'looks')}: ${entry.looks.join(L(lang, '；', '; '))}` : ''}${entry.manners.length > 0 ? `\n  ${L(lang, '为人', 'manner')}: ${entry.manners.join(L(lang, '；', '; '))}` : ''}${entry.quotes.length > 0 ? `\n  ${L(lang, '台词', 'lines')}: ${entry.quotes.map(quote => `"${quote}"`).join(' ')}` : ''}`)
      const { value } = await core.through('text', async () => await assign(core, runtime, task, {
        role: 'architect',
        label: L(lang, `整理人物表 ${at + 1}/${rounds.length}`, `The cast ${at + 1}/${rounds.length}`),
        tool: 'submit_cast',
        // All of it is in the task: asked in one request, whatever the role is set to.
        plain: true,
        what: L(lang, '这一批人物的人物卡', 'the cards of these characters'),
        system: architectSystem(lang),
        prompt: castRoundTask({ ...base, sightings: sightings.join('\n'), known: clip(known.join('\n'), 12_000), full: round.full }),
        temperature: 0.2,
        validate: raw => asRecord(raw),
      }), task.signal !== undefined ? { signal: task.signal } : {})
      await inTurn(async () => {
      result.rounds += 1
      const items = asArray(value.characters).map(asRecord).map((item) => {
        const name = asText(item.name) ?? asText(item.listed)
        const listed = asText(item.listed) ?? name
        // By the name it was listed under; a planner that left that out is matched by the name it chose, or by an alias.
        const sighting = listed === undefined ? undefined
          : round.people.find(entry => sameName(entry.name, listed))
            ?? (name !== undefined ? round.people.find(entry => sameName(entry.name, name)) : undefined)
            ?? round.people.find(entry => asList(item.aliases).some(alias => sameName(alias, entry.name)))
        const sameAs = asText(item.same_as)
        return { item, name, sighting, sameAs: sameAs !== undefined && sighting !== undefined && !sameName(sameAs, sighting.name) ? sameAs : undefined }
      })
      // Somebody the round was not asked about is the planner's own idea, and nothing the chapters gave a reason for.
      const answered = items.filter((entry): entry is typeof entry & { name: string; sighting: Sighting } => entry.name !== undefined && entry.sighting !== undefined)
      // Cards first, other names after: a name can only become the alias of somebody who has a card by then.
      for (const { item, name, sighting } of answered.filter(entry => entry.sameAs === undefined)) {
        const role = asText(item.role) as CharacterCard['role'] | undefined
        const aliases = asList(item.aliases).filter(alias => !sameName(alias, name) && !sameName(alias, sighting.name))
        const relationships = asArray(item.relationships).map(asRecord).map((relation) => {
          const other = asText(relation.target)
          const kind = asText(relation.kind)
          const note = asText(relation.note)
          return other !== undefined && kind !== undefined ? { target: other, kind, ...(note !== undefined ? { note } : {}) } : undefined
        }).filter((relation): relation is NonNullable<typeof relation> => relation !== undefined)
        const texts = pickText(item, round.full ? ['gender', 'age', 'tagline', 'appearance', 'personality', 'background', 'motivation', 'arc', 'voice'] : ['gender', 'tagline'])
        // The proper name leads the card; the name the chapters use stays beside it, so that their digests still find it.
        const other = sameName(name, sighting.name) ? [] : [sighting.name]
        const before = sighting.card ?? (await project.findCharacter(name))
        // Somebody's card that was worked on, found under the proper name: theirs to keep as it is — this name joins it.
        if (before !== undefined && !isThinCard(before)) {
          if (other.length > 0) await project.saveCharacter({ id: before.id, aliases: [...new Set([...(before.aliases ?? []), ...other])] })
          result.merged += 1
          continue
        }
        await project.saveCharacter({
          ...(before !== undefined ? { id: before.id } : {}),
          name,
          role: role !== undefined && ROLES.includes(role) ? role : round.full ? 'supporting' : 'minor',
          ...(aliases.length + other.length + (before?.aliases?.length ?? 0) > 0 ? { aliases: [...new Set([...(before?.aliases ?? []), ...other, ...aliases])].filter(alias => !sameName(alias, name)) } : {}),
          ...(relationships.length > 0 ? { relationships } : {}),
          ...texts,
          ...(sighting.chapters.length > 0 ? { firstAppearance: sighting.chapters[0]!, lastAppearance: sighting.chapters.at(-1)! } : {}),
        } as Partial<CharacterCard> & { name: string })
        if (before !== undefined) result.filled += 1
        else result.made += 1
      }
      for (const { sighting, sameAs } of answered.filter(entry => entry.sameAs !== undefined)) {
        const target = await project.findCharacter(sameAs!)
        // Said to be somebody the book has no card for: left as it was, a walk-on to settle by hand.
        if (target === undefined || target.id === sighting.card?.id) continue
        const aliases = [...new Set([...(target.aliases ?? []), sighting.name, ...(sighting.card?.aliases ?? [])])].filter(alias => !sameName(alias, target.name))
        await project.saveCharacter({ id: target.id, aliases })
        // The thin card under this name, if there is one, goes: nobody worked on it, and the person has a card.
        if (sighting.card !== undefined) await project.deleteCharacter(sighting.card.id)
        result.merged += 1
      }
      })
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      result.failed.push({ step: `cast ${at + 1}/${rounds.length}`, error: error instanceof Error ? error.message : String(error) })
    }
  }, task.signal)
  }
  // With every card made, each name is seen beside every other: what a batch could not know — that two of its names, or a name of it and one of another batch, are one person — shows now.
  task.signal?.throwIfAborted()
  onRound?.(rounds.length, rounds.length + 1, L(lang, '认别名', 'other names of the same person'))
  // (Asked about a few people by name, the list was looked through for other names when they were found.)
  if (only === undefined) {
    try {
      result.merged += await foldAliases(core, runtime, task)
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      result.failed.push({ step: 'cast aliases', error: error instanceof Error ? error.message : String(error) })
    }
  }
  onRound?.(rounds.length + 1, rounds.length + 1, '')
  await relinkMemories(runtime)
  // Chapters whose plan names nobody can name those who now have a card.
  await fillPlans(runtime).catch(() => {})
  await project.pruneSuggestions()
  return result
}

/** How many names one request is asked to look through for people listed twice. */
const ALIAS_ROUND = 400

/**
 * Fold together the cards that are one person under two names. Only a card
 * nobody worked on is ever given up: where both were worked on they both stay.
 * @returns how many cards became aliases.
 */
export async function foldAliases(core: NovelCore, runtime: ProjectRuntime, task: TaskContext): Promise<number> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const all = await project.characters()
  // One person listed twice is found among the thin cards: nothing to look for where there are none.
  if (all.length < 2 || !all.some(isThinCard)) return 0
  let merged = 0
  for (let at = 0; at < all.length; at += ALIAS_ROUND) {
    const lines = all.slice(at, at + ALIAS_ROUND).map(card => `- ${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? `（${card.aliases.join(lang === 'zh' ? '、' : ', ')}）` : ''}${card.tagline !== undefined ? ` — ${clip(card.tagline, 50)}` : ''}`)
    const { value } = await assign(core, runtime, task, {
      role: 'architect',
      label: L(lang, '整理人物表 · 认别名', 'The cast · other names'),
      tool: 'submit_aliases',
      what: L(lang, '人物表里指同一个人的名字', 'the names on the cast list that are one person'),
      system: architectSystem(lang),
      prompt: castAliasTask({ lang, language: manifest.language, title: manifest.title, cast: lines.join('\n') }),
      temperature: 0.1,
      validate: raw => asRecord(raw),
    })
    for (const raw of asArray(value.same)) {
      const group = asRecord(raw)
      const keepName = asText(group.keep)
      if (keepName === undefined) continue
      for (const otherName of asList(group.others)) {
        // Read anew each time: a merge before this one may have changed who is who.
        let keep = await project.findCharacter(keepName)
        let other = await project.findCharacter(otherName)
        if (keep === undefined || other === undefined || keep.id === other.id) continue
        // The card somebody worked on is the one that stays, whichever name the planner preferred.
        if (!isThinCard(other) && isThinCard(keep)) [keep, other] = [other, keep]
        if (!isThinCard(other)) continue
        const aliases = [...new Set([...(keep.aliases ?? []), other.name, ...(other.aliases ?? [])])].filter(alias => !sameName(alias, keep!.name))
        await project.saveCharacter({ id: keep.id, aliases })
        await project.deleteCharacter(other.id)
        merged += 1
      }
    }
  }
  return merged
}

/**
 * Point chapter memories at character cards created after the memories were
 * written, and give every card its first and last appearance.
 */
export async function relinkMemories(runtime: ProjectRuntime): Promise<void> {
  const { project } = runtime
  const characters = await project.characters()
  const ids = new Set(characters.map(card => card.id))
  // Whose a note is goes by the story its chapter is of: a world may hold several stories, each with somebody of the
  // same name — or with a narrator who is "我" in each. On every line: a card made from a line beside the main one is
  // found in that line's chapters.
  const { whose } = await project.castResolver()
  const first = new Map<string, string>()
  const last = new Map<string, string>()
  const outline = await project.outline()
  const chapters = [...await project.chapters(), ...(await Promise.all((outline.lines ?? []).map(async line => (await project.chapters(line.id)).filter(chapter => chapter.line === line.id)))).flat()]
  for (const { chapter, memory } of await project.memories(chapters)) {
    let changed = false
    const moments = memory.characters.map((moment) => {
      const card = whose(moment, chapter.plan.id)
      if (card === undefined || !ids.has(card)) return moment
      if (!first.has(card)) first.set(card, chapter.plan.id)
      last.set(card, chapter.plan.id)
      if (moment.character === card && moment.by !== undefined) return moment
      changed = true
      return { ...moment, character: card, by: moment.by ?? 'story' as const }
    })
    if (changed) await project.saveMemory({ ...memory, characters: moments })
  }
  for (const card of characters) {
    const firstAppearance = first.get(card.id)
    const lastAppearance = last.get(card.id)
    if (firstAppearance === undefined || lastAppearance === undefined) continue
    if (card.firstAppearance !== firstAppearance || card.lastAppearance !== lastAppearance) await project.saveCharacter({ id: card.id, firstAppearance, lastAppearance })
  }
}

// ───────────────────────────── who is worth a card ─────────────────────────────

export interface SiftResult {
  /** Names the planner looked at. */
  looked: number
  /** Names it found worth a card: each waits among the suggestions, with its reason. */
  cards: string[]
  /** Names that are somebody's other name: each waits as a suggestion to fold it into that card. */
  aliases: { name: string; of: string }[]
  /** Names left as walk-ons: in the list of walk-ons, each with why. */
  walkOns: number
  failed: { step: string; error: string }[]
}

/** How many names one request is asked about. */
const SIFT_ROUND = 60

/**
 * The names without a card the planner has yet to say something of: those it never looked at, and those seen in more
 * chapters since it did — a walk-on who keeps coming back is asked about again.
 * @param all - everybody on the list, whatever was said of them before.
 */
export async function siftDue(runtime: ProjectRuntime, all = false): Promise<WalkOn[]> {
  const list = await listWalkOns(runtime.project)
  return all ? list : list.filter(entry => entry.verdict === undefined || entry.chapters.length > entry.verdict.seen)
}

/**
 * Have the planner look through the names the page uses for people who have no card, and say of each what it is:
 * worth a card, another name of somebody, or a walk-on. A digest names everybody a chapter meets, and none of them
 * is proposed for a card by that alone — a long book would bury its cast under doormen. What the planner finds worth
 * a card waits among the suggestions with its reason; another name waits as a suggestion to fold it in; a walk-on
 * stays in the list of walk-ons, where what the planner said of them is kept beside the name and a card is one click
 * away. Nothing is made or folded here: the cast is the author's.
 * @param params.all - look at every name again, also those already judged or proposed (the backlog of an older version).
 * @param params.direction - what the author asks of the pass; it guides the planner.
 */
export async function siftCast(core: NovelCore, runtime: ProjectRuntime, params: { all?: boolean; direction?: string }, task: TaskContext): Promise<SiftResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const outline = await project.outline()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const result: SiftResult = { looked: 0, cards: [], aliases: [], walkOns: 0, failed: [] }
  // Two stories may each have somebody without a card by the same name; the planner answers by name, so one of them
  // is asked about at a time — the other at the next pass, which follows by itself while names are due.
  const asked = new Set<string>()
  const due = (await siftDue(runtime, params.all === true)).filter((entry) => {
    const key = foldName(entry.name)
    if (asked.has(key)) return false
    asked.add(key)
    return true
  })
  if (due.length === 0) return result
  const storyTitle = (id: string): string => (outline.lines ?? []).find(line => line.id === id)?.title ?? id
  const located = await project.chapters()
  const indexOf = new Map(located.map(chapter => [chapter.plan.id, chapter.index]))
  const rounds: WalkOn[][] = []
  for (let at = 0; at < due.length; at += SIFT_ROUND) rounds.push(due.slice(at, at + SIFT_ROUND))
  const now = new Date().toISOString()
  for (const [at, round] of rounds.entries()) {
    task.signal?.throwIfAborted()
    task.job?.progress(at, rounds.length, L(lang, `策划在看 ${round.slice(0, 3).map(entry => entry.name).join('、')}${round.length > 3 ? ` 等 ${round.length} 个名字` : ''}`, `the planner is looking at ${round.slice(0, 3).map(entry => entry.name).join(', ')}${round.length > 3 ? ` and ${round.length - 3} more` : ''}`))
    try {
      const cards = await project.characters()
      const known = cards.map(card => `${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? `（${card.aliases.join(zh ? '、' : ', ')}）` : ''}${card.tagline !== undefined ? ` — ${clip(card.tagline, 40)}` : ''}`)
      const names = round.map((entry) => {
        const where = entry.chapters.map(id => indexOf.get(id)).filter((index): index is number => index !== undefined)
        const near = entry.near !== undefined ? cards.find(card => card.id === entry.near)?.name : undefined
        // Somebody on file by this very name is of another story: said, so that the two are not taken for one.
        const namesake = cards.some(card => sameName(card.name, entry.name) || card.aliases?.some(alias => sameName(alias, entry.name)) === true)
        return `- ${entry.name}（${[
          entry.story !== undefined ? L(lang, `在「${storyTitle(entry.story)}」这条故事线上`, `on the line "${storyTitle(entry.story)}"`) : undefined,
          namesake ? L(lang, '已建档的同名人物是别的故事线上的另一个人', 'the character on file by this name is somebody else, of another line') : undefined,
          where.length > 0 ? L(lang, `出现在 ${where.length} 章：第 ${where.join('、')} 章`, `in ${where.length} chapter(s): ${where.join(', ')}`) : L(lang, '只被提到', 'only mentioned'),
          entry.lines > 0 ? L(lang, `有声脚本里 ${entry.lines} 句台词`, `${entry.lines} spoken line(s) in the audio scripts`) : undefined,
          near !== undefined ? L(lang, `名字和「${near}」相近`, `the name is close to "${near}"`) : undefined,
        ].filter(Boolean).join(zh ? '；' : '; ')}）${entry.note !== undefined ? `${zh ? '：' : ': '}${clip(entry.note, 160)}` : ''}`
      })
      const { value } = await assign(core, runtime, task, {
        role: 'architect',
        label: rounds.length > 1 ? L(lang, `筛新名字 ${at + 1}/${rounds.length}`, `New names ${at + 1}/${rounds.length}`) : L(lang, '筛新名字', 'New names'),
        tool: 'submit_sift',
        what: L(lang, '这一批名字各自该怎么办：建卡、是别名、还是留作龙套', 'what each of these names is: worth a card, another name of somebody, or a walk-on'),
        system: architectSystem(lang),
        prompt: castSiftTask({ lang, language: manifest.language, title: manifest.title, names: names.join('\n'), known: clip(known.join('\n'), 12_000), ...(params.direction !== undefined ? { direction: params.direction } : {}) }),
        temperature: 0.2,
        validate: (raw) => {
          const record = asRecord(raw)
          if (asArray(record.people).length === 0) throw new Error('"people" is empty')
          return record
        },
      })
      // One answer a name; a name the round was not asked about is nobody the chapters gave a reason for.
      const answers = new Map<string, { entry: WalkOn; is: WalkOnVerdict['is']; why?: string; role?: CharacterCard['role']; tagline?: string; same?: string }>()
      for (const raw of asArray(value.people)) {
        const item = asRecord(raw)
        const name = asText(item.name)
        const entry = name !== undefined ? round.find(candidate => foldName(candidate.name) === foldName(name)) : undefined
        const is = asText(item.is)
        if (entry === undefined || answers.has(foldName(entry.name)) || (is !== 'card' && is !== 'alias' && is !== 'walkon')) continue
        const why = asText(item.why)
        const role = asText(item.role) as CharacterCard['role'] | undefined
        const tagline = asText(item.tagline)
        const same = asText(item.same_as)
        answers.set(foldName(entry.name), { entry, is, ...(why !== undefined ? { why } : {}), ...(role !== undefined && ROLES.includes(role) ? { role } : {}), ...(tagline !== undefined ? { tagline } : {}), ...(same !== undefined ? { same } : {}) })
      }
      // Another name of somebody: of a card — then that is proposed —, of a name this round found worth a card — then
      // it goes onto that card with it —, or of nobody the book knows: then they are a walk-on, and the list says why.
      const extra = new Map<string, string[]>()
      const verdicts: (WalkOnVerdict & { name: string })[] = []
      const suggestions: Omit<Suggestion, 'id' | 'createdAt'>[] = []
      const stale: string[] = []
      const verdict = (entry: WalkOn, is: WalkOnVerdict['is'], why?: string, same?: string): void => {
        verdicts.push({ name: entry.name, is, ...(why !== undefined ? { why } : {}), ...(same !== undefined ? { same } : {}), at: now, seen: entry.chapters.length, ...(entry.story !== undefined ? { story: entry.story } : {}) })
      }
      for (const answer of answers.values()) {
        if (answer.is !== 'alias') continue
        const { entry, why, same } = answer
        // "Another name of" the card that bears this very name: that card is the namesake of another story — who a
        // name is was settled before it came here. They are somebody of their own, worth a card.
        if (same !== undefined && sameName(same, entry.name)) {
          answer.is = 'card'
          continue
        }
        if (entry.suggestion !== undefined) stale.push(entry.suggestion)
        const target = same !== undefined ? cards.find(card => sameName(card.name, same) || card.aliases?.some(alias => sameName(alias, same)) === true) : undefined
        const fellow = same !== undefined && target === undefined ? [...answers.values()].find(other => other.is === 'card' && foldName(other.entry.name) === foldName(same)) : undefined
        if (target !== undefined) {
          suggestions.push({
            kind: 'alias',
            title: L(lang, `别名：「${entry.name}」就是${target.name}？`, `Another name: is "${entry.name}" ${target.name}?`),
            detail: why ?? entry.note ?? '',
            ...(entry.chapters[0] !== undefined ? { chapterId: entry.chapters[0] } : {}),
            payload: { name: entry.name, target: target.id, targetName: target.name },
            sifted: true,
          })
          verdict(entry, 'alias', why, target.name)
          result.aliases.push({ name: entry.name, of: target.name })
        } else if (fellow !== undefined) {
          extra.set(foldName(fellow.entry.name), [...(extra.get(foldName(fellow.entry.name)) ?? []), entry.name])
          verdict(entry, 'alias', why, fellow.entry.name)
          result.aliases.push({ name: entry.name, of: fellow.entry.name })
        } else {
          verdict(entry, 'walkon', [why, same !== undefined ? L(lang, `（策划认为是「${same}」的另一个称呼，但书里没有这个人的卡）`, `(the planner takes them for "${same}" under another name, and the book has no card of that name)`) : undefined].filter(Boolean).join(' '))
          result.walkOns += 1
        }
      }
      for (const answer of answers.values()) {
        const { entry, why } = answer
        if (answer.is === 'walkon') {
          // Proposed before by a digest of an older version: no longer.
          if (entry.suggestion !== undefined) stale.push(entry.suggestion)
          verdict(entry, 'walkon', why)
          result.walkOns += 1
        } else if (answer.is === 'card') {
          if (entry.suggestion !== undefined) stale.push(entry.suggestion)
          const others = extra.get(foldName(entry.name)) ?? []
          suggestions.push({
            kind: 'new-character',
            title: L(lang, `新人物：${entry.name}`, `New character: ${entry.name}`),
            detail: why ?? entry.note ?? '',
            ...(entry.chapters[0] !== undefined ? { chapterId: entry.chapters[0] } : {}),
            payload: {
              name: entry.name,
              role: answer.role ?? 'minor',
              ...(answer.tagline !== undefined || entry.note !== undefined ? { tagline: answer.tagline ?? entry.note } : {}),
              ...(others.length > 0 ? { aliases: others } : {}),
              ...(entry.chapters[0] !== undefined ? { firstAppearance: entry.chapters[0], lastAppearance: entry.chapters.at(-1) } : {}),
            },
            sifted: true,
          })
          verdict(entry, 'card', why)
          result.cards.push(entry.name)
        }
      }
      for (const id of stale) await project.takeSuggestion(id)
      await project.addSuggestions(suggestions)
      await noteVerdicts(project, verdicts)
      result.looked += answers.size
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      result.failed.push({ step: `sift ${at + 1}/${rounds.length}`, error: error instanceof Error ? error.message : String(error) })
    }
  }
  task.job?.progress(rounds.length, rounds.length)
  // Whom it found worth a card, and whose name is another's, are settled like the rest of what the digests proposed.
  if (result.cards.length + result.aliases.length > 0) scheduleSettle(core, runtime, task, 1500)
  if (result.looked > 0) {
    await project.addActivity({
      by: 'crew',
      role: 'architect',
      tool: 'sift',
      summary: L(lang,
        `策划看了 ${result.looked} 个还没有人物卡的名字：${result.cards.length} 个建议建卡${result.cards.length > 0 ? `（${clip(result.cards.join('、'), 80)}）` : ''}，${result.aliases.length} 个是别名，${result.walkOns} 个留作龙套`,
        `The planner looked at ${result.looked} name(s) without a card: ${result.cards.length} proposed for a card${result.cards.length > 0 ? ` (${clip(result.cards.join(', '), 100)})` : ''}, ${result.aliases.length} another name of somebody, ${result.walkOns} left as walk-ons`),
    }).catch(() => {})
    project.touch()
  }
  task.job?.result({ looked: result.looked, cards: result.cards.length, aliases: result.aliases.length, walkOns: result.walkOns })
  return result
}

const pendingSifts = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Have the names without a card looked through once digests have settled — in the background, a moment after the last
 * of them, so that a batch of chapters is one look, and not while a book is still being taken in. Nothing is asked
 * where no name is new and nobody has been seen in more chapters since they were looked at.
 */
export function scheduleSift(core: NovelCore, runtime: ProjectRuntime, task: Pick<TaskContext, 'origin' | 'agentRoute'>, wait = 4000): void {
  if (core.currentSettings().siftCast === false) return
  const root = runtime.project.root
  const before = pendingSifts.get(root)
  if (before !== undefined) clearTimeout(before)
  const timer = setTimeout(() => {
    pendingSifts.delete(root)
    void (async () => {
      const running = core.jobs.list(root).filter(job => job.status === 'running')
      // Its own pass is on its way already; and while chapters are still being digested, or a book taken in, the list is not yet what it will be.
      if (running.some(job => job.kind === 'bible' && job.title === 'sift cast')) return
      if (running.some(job => job.kind === 'digest' || job.kind === 'import' || job.kind === 'batch')) {
        scheduleSift(core, runtime, task, 6000)
        return
      }
      if ((await siftDue(runtime)).length === 0) return
      core.jobs.start({ kind: 'bible', title: 'sift cast', project: root, origin: task.origin }, async (job) => {
        await siftCast(core, runtime, {}, { origin: task.origin, signal: job.signal, job, ...(task.agentRoute !== undefined ? { agentRoute: task.agentRoute } : {}) })
      })
    })().catch((error: unknown) => { core.log('could not start looking through the names without a card', error) })
  }, wait)
  timer.unref?.()
  pendingSifts.set(root, timer)
}

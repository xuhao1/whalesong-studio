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
import type { CharacterCard } from '../../shared/types'
import { clip, sameName } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { assign } from '../crew'
import { asArray, asList, asRecord, asText } from '../llm'
import { architectSystem, castAliasTask, castRoundTask } from '../prompts'
import { L, promptLanguage } from '../render'
import { fillPlans } from './digest'
import { pickText } from './plot'

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
  const seen = (raw: string, chapter: { id: string; index: number } | undefined, note?: string, quote?: string): void => {
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
      entry = { name: card?.name ?? name, chapters: [], first: chapter?.index ?? 0, last: chapter?.index ?? 0, notes: [], quotes: [], ...(card !== undefined ? { card } : {}) }
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
  }
  for (const { chapter, memory } of memories) {
    const here = { id: chapter.plan.id, index: chapter.index }
    for (const moment of memory.characters) seen(moment.name, here, [moment.role, moment.stateAfter].filter(Boolean).join(' → '), moment.quote)
    // Named as new but not acting: worth a note, not a chapter to their count.
    for (const entity of memory.newEntities) if (entity.kind === 'character') seen(entity.name, undefined, entity.description)
  }
  const ranked = [...open.values()].sort((left, right) => right.chapters.length - left.chapters.length || left.first - right.first)
  return { open: ranked, known, chapters: memories.length }
}

/**
 * Give the people of the book their cards.
 * @param onRound - told before each request to the planner: which round of how many, and who it is about.
 */
export async function mergeCast(core: NovelCore, runtime: ProjectRuntime, task: TaskContext, onRound?: (done: number, total: number, label: string) => void): Promise<CastResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const result: CastResult = { made: 0, filled: 0, merged: 0, walkOns: 0, rounds: 0, failed: [] }
  const { open, chapters } = await castSightings(runtime)
  if (open.length === 0) return result

  // How large a part earns what: in a long book coming back three times is a part and twice a face; a short one has no room for such distinctions.
  const long = chapters > 12
  // A short book's few most present people are its cast, however seldom the digests saw them.
  const whole = open.filter((entry, rank) => entry.chapters.length >= (long ? 3 : 2) || (!long && rank < 8 && entry.chapters.length >= 1))
  const wholeNames = new Set(whole.map(entry => entry.name))
  // A line for whoever came back once and has no card. A thin card whose person has not grown is left as it is: asking about it again would say the same again.
  const lined = open.filter(entry => !wholeNames.has(entry.name) && entry.card === undefined && entry.chapters.length === 2)
  result.walkOns = open.filter(entry => entry.card === undefined && !wholeNames.has(entry.name)).length - lined.length

  const rounds: { full: boolean; people: Sighting[] }[] = []
  for (let at = 0; at < whole.length; at += FULL_ROUND) rounds.push({ full: true, people: whole.slice(at, at + FULL_ROUND) })
  for (let at = 0; at < lined.length; at += LIGHT_ROUND) rounds.push({ full: false, people: lined.slice(at, at + LIGHT_ROUND) })

  const base = { lang, language: manifest.language, title: manifest.title }
  for (const [at, round] of rounds.entries()) {
    task.signal?.throwIfAborted()
    const names = round.people.slice(0, 3).map(entry => entry.name).join(lang === 'zh' ? '、' : ', ')
    onRound?.(at, rounds.length, L(lang, `${names}${round.people.length > 3 ? ` 等 ${round.people.length} 人` : ''}`, `${names}${round.people.length > 3 ? ` and ${round.people.length - 3} more` : ''}`))
    try {
      const cards = await project.characters()
      // Who is known already, so that another name of theirs is recognized: everyone but the ones this round is about.
      const asked = new Set(round.people.map(entry => fold(entry.name)))
      const known = cards
        .filter(card => !asked.has(fold(card.name)))
        .map(card => `${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? `（${card.aliases.join(lang === 'zh' ? '、' : ', ')}）` : ''}${card.tagline !== undefined ? ` — ${clip(card.tagline, 40)}` : ''}`)
      const sightings = round.people.map(entry => `- ${entry.name} (${L(lang, `出场 ${entry.chapters.length} 章${entry.first > 0 ? `，第${entry.first}–${entry.last}章` : ''}`, `${entry.chapters.length} chapters${entry.first > 0 ? `, ch.${entry.first}–${entry.last}` : ''}`)})${entry.notes.length > 0 ? `\n  ${entry.notes.join('\n  ')}` : ''}${entry.quotes.length > 0 ? `\n  ${L(lang, '台词', 'lines')}: ${entry.quotes.map(quote => `"${quote}"`).join(' ')}` : ''}`)
      const { value } = await assign(core, runtime, task, {
        role: 'architect',
        label: L(lang, `整理人物表 ${at + 1}/${rounds.length}`, `The cast ${at + 1}/${rounds.length}`),
        tool: 'submit_cast',
        what: L(lang, '这一批人物的人物卡', 'the cards of these characters'),
        system: architectSystem(lang),
        prompt: castRoundTask({ ...base, sightings: sightings.join('\n'), known: clip(known.join('\n'), 12_000), full: round.full }),
        temperature: 0.2,
        validate: raw => asRecord(raw),
      })
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
        const texts = pickText(item, round.full ? ['gender', 'age', 'tagline', 'appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice'] : ['gender', 'tagline'])
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
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      result.failed.push({ step: `cast ${at + 1}/${rounds.length}`, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // With every card made, each name is seen beside every other: what a batch could not know — that two of its names, or a name of it and one of another batch, are one person — shows now.
  task.signal?.throwIfAborted()
  onRound?.(rounds.length, rounds.length + 1, L(lang, '认别名', 'other names of the same person'))
  try {
    result.merged += await foldAliases(core, runtime, task)
  } catch (error) {
    if (task.signal?.aborted === true) throw error
    result.failed.push({ step: 'cast aliases', error: error instanceof Error ? error.message : String(error) })
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
    if (card.firstAppearance !== firstAppearance || card.lastAppearance !== lastAppearance) await project.saveCharacter({ id: card.id, firstAppearance, lastAppearance })
  }
}

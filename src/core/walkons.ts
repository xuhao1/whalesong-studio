// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Walk-ons: the people the page names who have no character card — the
 * auctioneer, the clerk, "the tall recruit". A long book collects dozens of
 * them, and a card each would bury the leads. They are gathered here from what
 * the Studio already knows (chapter memories, pending suggestions, the audio
 * scripts and the voice sheet), and settled one by one: given a card when they
 * start to matter, folded into an existing character when the name turns out
 * to be an alias, or left alone.
 */
import type { CharacterCard, CharacterRole, WalkOn, WalkOnVerdict } from '../shared/types'
import { ProjectError, type Project } from './project'

interface WalkOnFile {
  schema: 1
  /** Names the author does not want listed. */
  ignored: string[]
  /** What the planner made of each name it looked at, by the name folded; `name`: as the page writes it. */
  sifted?: Record<string, WalkOnVerdict & { name?: string }>
}

const FILE = 'walkons.json'

const clean = (name: string): string => name.trim().replace(/^["'“”‘’「」『』《》\s]+|["'“”‘’「」『』《》\s]+$/gu, '')
const fold = (name: string): string => clean(name).toLowerCase().replace(/[\s·・.．-]+/gu, '')

/** Names that are a role in the telling rather than a person. */
const NOT_A_PERSON = new Set(['旁白', '叙述者', '叙述', 'narrator', 'narration', '众人', '所有人', 'all', 'everyone', '画外音', '系统', '未知', 'unknown', '?', '？'])

async function ignoredNames(project: Project): Promise<string[]> {
  return (await project.readState<WalkOnFile>(FILE))?.ignored ?? []
}

/** Everyone on the page without a card, most present first. */
export async function listWalkOns(project: Project, options: { ignored?: boolean } = {}): Promise<WalkOn[]> {
  const [cards, memories, suggestions, cast, ignored, chapters, sifted] = await Promise.all([
    project.characters(), project.memories(), project.suggestions(), project.voiceCast(), ignoredNames(project), project.chapters(),
    project.readState<WalkOnFile>(FILE).then(file => file?.sifted ?? {}),
  ])
  const carded = new Map<string, CharacterCard>()
  for (const card of cards) {
    carded.set(fold(card.name), card)
    for (const alias of card.aliases ?? []) carded.set(fold(alias), card)
  }
  const cardIds = new Set(cards.map(card => card.id))
  const order = new Map(chapters.map(chapter => [chapter.plan.id, chapter.index]))
  const hidden = new Set(ignored.map(fold))
  const found = new Map<string, WalkOn>()
  const see = (raw: string | undefined, chapter?: string, note?: string): WalkOn | undefined => {
    if (raw === undefined) return undefined
    const name = clean(raw)
    const key = fold(name)
    if (key.length === 0 || name.length > 24 || NOT_A_PERSON.has(key) || carded.has(key)) return undefined
    let entry = found.get(key)
    if (entry === undefined) {
      entry = { name, chapters: [], lines: 0 }
      found.set(key, entry)
    }
    if (chapter !== undefined && order.has(chapter) && !entry.chapters.includes(chapter)) entry.chapters.push(chapter)
    const text = note?.trim()
    if (text !== undefined && text.length > 0 && (entry.note === undefined || text.length > entry.note.length)) entry.note = text.slice(0, 200)
    return entry
  }
  for (const { chapter, memory } of memories) {
    for (const entity of memory.newEntities) if (entity.kind === 'character') see(entity.name, chapter.plan.id, entity.description)
    for (const moment of memory.characters) if (!cardIds.has(moment.character)) see(moment.name, chapter.plan.id, moment.role)
  }
  for (const suggestion of suggestions) {
    if (suggestion.kind !== 'new-character') continue
    const named = typeof suggestion.payload.name === 'string' ? suggestion.payload.name : suggestion.title
    const entry = see(named, suggestion.chapterId, typeof suggestion.payload.tagline === 'string' ? suggestion.payload.tagline : suggestion.detail)
    if (entry !== undefined) entry.suggestion = suggestion.id
  }
  for (const chapter of chapters) {
    const script = await project.audioScript(chapter.plan.id)
    if (script === undefined) continue
    for (const line of script.lines) {
      if (line.kind === 'narration' || (line.speaker !== undefined && cardIds.has(line.speaker))) continue
      const entry = see(line.speakerName ?? line.speaker, chapter.plan.id)
      if (entry !== undefined) entry.lines += 1
    }
  }
  for (const [name, voice] of Object.entries(cast?.extras ?? {})) {
    const entry = see(name)
    if (entry !== undefined) entry.voice = voice
  }
  // A name the planner left a walk-on stays on the list although nothing else names it any more — the suggestion an
  // older version made for it was its only trace: what was looked at is not made to vanish.
  for (const verdict of Object.values(sifted)) if (verdict.is === 'walkon' && verdict.name !== undefined) see(verdict.name)
  const list: WalkOn[] = []
  for (const [key, entry] of found) {
    entry.chapters.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    // A name that sits inside a card's name is likely that character under another name; so is one that only adds a
    // little to it ("老周" → "老周头"). "沈蘅的妹妹" is someone else: a relation of the character, named by them.
    const near = cards.find((card) => {
      const known = fold(card.name)
      if (known.length < 2 || key.length < 2) return false
      if (known.includes(key)) return true
      const at = key.indexOf(known)
      return at >= 0 && key.length - known.length <= 2 && key[at + known.length] !== '的'
    })
    if (near !== undefined) entry.near = near.id
    const said = sifted[key]
    if (said !== undefined) {
      const { name: _written, ...verdict } = said
      entry.verdict = verdict
    }
    if (hidden.has(key)) {
      if (options.ignored !== true) continue
      entry.ignored = true
    }
    list.push(entry)
  }
  return list.sort((left, right) => Number(left.ignored === true) - Number(right.ignored === true) || right.chapters.length - left.chapters.length || right.lines - left.lines || left.name.localeCompare(right.name))
}

/** Keep what the planner said of the names it looked at; a name it has a verdict on is not asked about again until they are seen in more chapters. */
export async function noteVerdicts(project: Project, verdicts: readonly (WalkOnVerdict & { name: string })[]): Promise<void> {
  if (verdicts.length === 0) return
  await project.updateState<WalkOnFile>([FILE], { schema: 1, ignored: [] }, (current) => {
    const sifted = { ...(current.sifted ?? {}) }
    for (const verdict of verdicts) sifted[fold(verdict.name)] = verdict
    return { ...current, sifted }
  })
}

/** The name as the lists compare it: without quotes, spaces and case. */
export const foldName = (name: string): string => fold(name)

export interface SettleInput {
  name: string
  /**
   * card: give them a character card. alias: they are an existing character
   * under another name. ignore / restore: take them off the list, or put them back.
   */
  action: 'card' | 'alias' | 'ignore' | 'restore'
  /** alias: the character they are. */
  target?: string
  /** card: how large a part. Default: minor. */
  role?: CharacterRole
}

/** Hand a walk-on's lines in every audio script to a card, so their voice follows the card from now on. */
async function relabel(project: Project, name: string, card: CharacterCard): Promise<number> {
  const key = fold(name)
  let moved = 0
  for (const chapter of await project.chapters()) {
    const script = await project.audioScript(chapter.plan.id)
    if (script === undefined) continue
    let changed = false
    for (const line of script.lines) {
      if (line.kind === 'narration' || line.speaker !== undefined || line.speakerName === undefined || fold(line.speakerName) !== key) continue
      line.speaker = card.id
      changed = true
      moved += 1
    }
    if (changed) await project.saveAudioScript(script, false)
  }
  return moved
}

export async function settleWalkOn(project: Project, input: SettleInput): Promise<{ card?: CharacterCard; lines: number }> {
  const name = clean(input.name)
  if (name.length === 0) throw new ProjectError('novel/invalid', 'name the walk-on to settle')
  const key = fold(name)
  if (input.action === 'ignore' || input.action === 'restore') {
    await project.updateState<WalkOnFile>([FILE], { schema: 1, ignored: [] }, (current) => {
      const rest = current.ignored.filter(item => fold(item) !== key)
      return { ...current, schema: 1, ignored: input.action === 'ignore' ? [...rest, name] : rest }
    })
    return { lines: 0 }
  }
  const entry = (await listWalkOns(project, { ignored: true })).find(item => fold(item.name) === key)
  const suggestion = entry?.suggestion !== undefined ? await project.takeSuggestion(entry.suggestion) : undefined
  const cast = await project.voiceCast()
  const voice = cast !== undefined ? Object.entries(cast.extras).find(([extra]) => fold(extra) === key) : undefined
  let card: CharacterCard
  if (input.action === 'alias') {
    const target = input.target !== undefined ? await project.findCharacter(input.target) : undefined
    if (target === undefined) throw new ProjectError('novel/not-found', `no character "${input.target ?? ''}" to fold "${name}" into`)
    card = await project.saveCharacter({ id: target.id, aliases: [...new Set([...(target.aliases ?? []), name])] })
    // The character already has a voice; the stand-in voice of the alias is dropped.
    if (cast !== undefined && voice !== undefined) {
      await project.updateVoiceCast(cast, (current) => {
        const { [voice[0]]: _dropped, ...extras } = current.extras
        return { ...current, extras }
      })
    }
  } else {
    const payload = suggestion?.kind === 'new-character' ? suggestion.payload as Partial<CharacterCard> : {}
    const first = entry?.chapters[0]
    const last = entry?.chapters.at(-1)
    card = await project.saveCharacter({
      ...payload,
      name,
      role: input.role ?? (payload.role === 'cameo' ? 'cameo' : 'minor'),
      ...(payload.tagline === undefined && entry?.note !== undefined ? { tagline: entry.note } : {}),
      ...(first !== undefined ? { firstAppearance: first } : {}),
      ...(last !== undefined ? { lastAppearance: last } : {}),
    })
    // They keep the voice the audio drama already gave them.
    if (cast !== undefined && voice !== undefined) {
      const id = card.id
      await project.updateVoiceCast(cast, (current) => {
        const { [voice[0]]: kept, ...extras } = current.extras
        return { ...current, extras, characters: kept !== undefined ? { ...current.characters, [id]: kept } : current.characters }
      })
    }
  }
  const lines = await relabel(project, name, card)
  project.touch()
  return { card, lines }
}

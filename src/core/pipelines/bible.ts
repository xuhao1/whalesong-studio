// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Story-bible assistance: fleshing out a character or a world entry in
 * agreement with what is already written, learning a style from a sample,
 * and applying the suggestions digest leaves behind.
 */
import { WORLD_EVENT_KINDS, type CharacterCard, type CharacterPersona, type StyleProfile, type Suggestion, type WorldCategory, type WorldEntry, type WorldEvent, type WorldTidy } from '../../shared/types'
import { clip } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText } from '../llm'
import { assign } from '../crew'
import { ProjectError } from '../project'
import { settleWalkOn } from '../walkons'
import { characterLifeTask, expandCharacterTask, expandWorldTask, styleExtractTask, styleSampleTask, tiesTask, worldTidyTask } from '../prompts'
import { TIE_ENDS, TIE_KINDS, type Tie, type TieKind } from '../../shared/ties'
import { groupOf } from '../../shared/world'
import { L, promptLanguage, renderCharacter, renderStyle, renderWorld } from '../render'
import { pickText } from './plot'

const POVS: NonNullable<StyleProfile['pov']>[] = ['first', 'third-limited', 'third-omniscient', 'second', 'multi']

export interface TiesResult {
  /** Ties written down that were not there, and ties whose chapters or note changed. */
  added: number
  changed: number
  removed: number
  total: number
  /** Ties the planner named that could not be written down, each with why: a name nothing answers to, a thing in itself. */
  skipped: string[]
  /** Entries the ties needed and the bible lacked: made by this pass, by name. */
  created: string[]
  /** Things that happen to a place, a house or a thing — built, changed, in decline, gone — written down on its entry. */
  events: number
}

/**
 * Have the planner work out how the things of the book's world stand to each
 * other — what is in what, who belongs where, lives where, holds what, from
 * which chapter to which — from the bible and from what the chapter digests
 * noted, and write the ties down. Ties already there are kept unless the
 * planner says they are wrong.
 * @throws ProjectError `novel/empty` when the bible has neither places, houses nor things to tie.
 */
const WORLD_CATEGORIES: readonly WorldCategory[] = ['setting', 'location', 'faction', 'system', 'item', 'history', 'culture', 'rule', 'term', 'other']

/**
 * Have the planner look over the bible's entries for the same thing written
 * down more than once, and for entries filed under the wrong kind. Nothing is
 * changed: what it finds is a proposal for the author to go by (`mergeWorld`,
 * a new category), each with a line of grounds.
 * @throws ProjectError `novel/empty` when there are fewer than two entries to compare.
 */
export async function tidyWorld(core: NovelCore, runtime: ProjectRuntime, task: TaskContext): Promise<WorldTidy> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const world = await project.world()
  if (world.length < 2) throw new ProjectError('novel/empty', 'the bible has fewer than two entries: there is nothing to compare')
  const seen = new Map((await project.worldPresence()).presence.map(item => [item.entry, item.chapters.length]))
  const entries = world.map(entry => `- ${entry.name}${entry.aliases !== undefined && entry.aliases.length > 0 ? `（${entry.aliases.join('、')}）` : ''}｜${entry.category}｜${seen.get(entry.id) ?? 0}｜${clip(entry.summary ?? entry.body ?? '', 90, '…')}`).join('\n')
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, '整理设定：找重复的条目和放错类别的', 'Tidying the bible: doubles and entries filed wrongly'),
    tool: 'propose_tidy',
    what: L(lang, '哪些条目是同一样东西、哪些类别放错了', 'which entries are one thing, and which are filed under the wrong kind'),
    prompt: worldTidyTask({ lang, language: manifest.language, title: manifest.title, entries, count: world.length }),
    temperature: 0.1,
    validate: (raw) => {
      const record = asRecord(raw)
      if (!Array.isArray(record.same) && !Array.isArray(record.kinds)) throw new Error('"same" and "kinds" must be lists (either may be empty)')
      return record
    },
  })
  const find = (name: unknown): WorldEntry | undefined => {
    const text = asText(name)
    if (text === undefined) return undefined
    const plain = text.replace(/[（(].*$/u, '').trim()
    return world.find(entry => entry.name === plain) ?? world.find(entry => entry.id === plain) ?? world.find(entry => entry.aliases?.includes(plain) === true)
  }
  const taken = new Set<string>()
  const same: WorldTidy['same'] = []
  for (const item of asArray(value.same).map(asRecord)) {
    const keep = find(item.keep)
    if (keep === undefined || taken.has(keep.id)) continue
    const others = asArray(item.others).map(find).filter((entry): entry is WorldEntry => entry !== undefined && entry.id !== keep.id && !taken.has(entry.id))
    const unique = others.filter((entry, index) => others.findIndex(other => other.id === entry.id) === index)
    if (unique.length === 0) continue
    taken.add(keep.id)
    for (const other of unique) taken.add(other.id)
    const why = asText(item.why)
    same.push({ keep: { id: keep.id, name: keep.name }, others: unique.map(other => ({ id: other.id, name: other.name })), ...(why !== undefined ? { why: clip(why, 200, '…') } : {}) })
  }
  const kinds: WorldTidy['kinds'] = []
  for (const item of asArray(value.kinds).map(asRecord)) {
    const entry = find(item.name)
    const category = asText(item.category) as WorldCategory | undefined
    if (entry === undefined || category === undefined || !WORLD_CATEGORIES.includes(category) || category === entry.category || kinds.some(other => other.id === entry.id)) continue
    const why = asText(item.why)
    kinds.push({ id: entry.id, name: entry.name, from: entry.category, to: category, ...(why !== undefined ? { why: clip(why, 200, '…') } : {}) })
  }
  return { same, kinds, entries: world.length }
}

export async function deriveTies(core: NovelCore, runtime: ProjectRuntime, params: { direction?: string }, task: TaskContext): Promise<TiesResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const world = await project.world()
  const entries = world.filter(entry => groupOf(entry.category) !== 'ideas')
  if (entries.length === 0) throw new ProjectError('novel/empty', 'the bible has no places, houses or things yet: there is nothing to tie')
  const characters = await project.characters()
  // Those with a part: a tie is worth writing down for somebody the story comes back to.
  const people = characters.filter(card => card.role !== 'cameo' && card.role !== 'minor')
  const path = await project.chapters()
  const none = L(lang, '（无）', '(none)')
  const listed = (group: 'places' | 'factions' | 'items'): string => entries.filter(entry => groupOf(entry.category) === group).map(entry => `- ${entry.name}${entry.aliases !== undefined && entry.aliases.length > 0 ? `（${entry.aliases.join('、')}）` : ''}${entry.summary !== undefined ? `：${clip(entry.summary, 80, '…')}` : ''}`).join('\n') || none
  const record = (await project.memories(path)).map(({ chapter, memory }) => {
    const where = memory.characters.filter(moment => moment.location !== undefined && moment.location.length > 0).map(moment => `${moment.name}@${moment.location}`)
    const things = memory.facts.filter(fact => fact.kind === 'item' || fact.kind === 'world').map(fact => `${fact.subject}：${fact.statement}`)
    const parts = [
      memory.locations !== undefined && memory.locations.length > 0 ? L(lang, `地点：${memory.locations.join('、')}`, `places: ${memory.locations.join(', ')}`) : undefined,
      where.length > 0 ? L(lang, `谁在哪：${where.join('、')}`, `who was where: ${where.join(', ')}`) : undefined,
      things.length > 0 ? L(lang, `物与世界：${things.join('；')}`, `things and world: ${things.join('; ')}`) : undefined,
    ].filter((part): part is string => part !== undefined)
    return parts.length > 0 ? L(lang, `第 ${chapter.index} 章《${chapter.plan.title}》 ${parts.join(' ｜ ')}`, `Chapter ${chapter.index}, "${chapter.plan.title}": ${parts.join(' | ')}`) : undefined
  }).filter((line): line is string => line !== undefined).join('\n') || none
  const before = await project.ties()
  const nameOf = (end: Tie['from']): string => (end.type === 'character' ? characters.find(card => card.id === end.id)?.name : world.find(entry => entry.id === end.id)?.name) ?? end.id
  const indexOf = new Map(path.map(chapter => [chapter.plan.id, chapter.index]))
  const known = before.map(tie => `- ${tie.kind}: ${nameOf(tie.from)} → ${nameOf(tie.to)}${tie.since !== undefined ? ` since ${indexOf.get(tie.since) ?? '?'}` : ''}${tie.until !== undefined ? ` until ${indexOf.get(tie.until) ?? '?'}` : ''}`).join('\n') || none
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, '理清关系：地点、家族、物品与人', 'Ties: places, houses, things and people'),
    tool: 'propose_ties',
    what: L(lang, '关系表：谁在哪里面、谁属于谁、谁住在哪、谁持有什么', 'the table of ties: what is in what, who belongs where, lives where, holds what'),
    prompt: tiesTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      places: listed('places'),
      houses: listed('factions'),
      things: listed('items'),
      people: people.map(card => `- ${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? `（${card.aliases.join('、')}）` : ''}${card.tagline !== undefined ? `：${clip(card.tagline, 60, '…')}` : ''}`).join('\n') || none,
      record,
      known,
      chapters: path.length,
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    temperature: 0.2,
    validate: (raw) => {
      const record = asRecord(raw)
      if (!Array.isArray(record.ties)) throw new Error('"ties" must be a list (it may be empty)')
      return record
    },
  })
  const chapterAt = (raw: unknown): string | undefined => {
    const index = Number(raw)
    return Number.isInteger(index) && index >= 1 ? path.find(chapter => chapter.index === index)?.plan.id : undefined
  }
  const end = (kind: TieKind, side: 'from' | 'to', name: string): Tie['from'] => ({ type: TIE_ENDS[kind][side], id: name })
  const result: TiesResult = { added: 0, changed: 0, removed: 0, total: 0, skipped: [], created: [], events: 0 }
  // What the planner said of entries the bible lacks: a category and a line, by name. It may say less than it uses.
  const bare = (name: string): string => name.replace(/[（(].*$/u, '').trim()
  const said = new Map<string, { category?: string; summary?: string }>()
  for (const raw of asArray(value.missing).slice(0, 80)) {
    const item = typeof raw === 'string' ? { name: raw } : asRecord(raw)
    const name = asText(item.name)
    if (name === undefined) continue
    const category = asText(item.category)
    const summary = asText(item.summary)
    said.set(bare(name), { ...(category !== undefined ? { category } : {}), ...(summary !== undefined ? { summary } : {}) })
  }
  /**
   * An end of a tie that names a place, a house or a thing the bible lacks —
   * a city, a house itself — is made an entry, so that the tie can be written
   * down: what kind of thing it is follows from the tie that names it.
   */
  const ensure = async (name: string, kind: TieKind, side: 'from' | 'to', other: string): Promise<void> => {
    if (TIE_ENDS[kind][side] !== 'world' || await project.findWorld(name) !== undefined) return
    const plain = bare(name)
    if (plain.length === 0 || plain.length > 24 || plain !== name || result.created.length >= 40) return
    const told = said.get(plain)
    const across = TIE_ENDS[kind][side === 'from' ? 'to' : 'from'] === 'world' ? (await project.findWorld(other))?.category : undefined
    const category = told?.category === 'location' || told?.category === 'faction' || told?.category === 'item' ? told.category
      : kind === 'holds' ? 'item'
        : kind === 'member' || (kind === 'seat' && side === 'from') ? 'faction'
          // A thing inside a house is a branch of it; inside a place, a place.
          : kind === 'within' && across === 'faction' ? 'faction' : 'location'
    // A detail by default: it is there to be walked to, not to travel with every request to a model.
    await project.saveWorld({ name: plain, category, importance: 3, ...(told?.summary !== undefined ? { summary: clip(told.summary, 200, '…') } : {}) })
    result.created.push(plain)
  }
  // What the planner calls wrong is taken out first: a tie it then states anew is written fresh.
  for (const item of asArray(value.wrong).map(asRecord)) {
    const kind = asText(item.kind) as TieKind | undefined
    const from = asText(item.from)
    const to = asText(item.to)
    if (kind === undefined || !(TIE_KINDS as readonly string[]).includes(kind) || from === undefined || to === undefined) continue
    const found = before.find(tie => tie.kind === kind && nameOf(tie.from) === from && nameOf(tie.to) === to)
    if (found !== undefined && await project.removeTie(found.id)) result.removed += 1
  }
  for (const item of asArray(value.ties).map(asRecord)) {
    const kind = asText(item.kind) as TieKind | undefined
    const from = asText(item.from)
    const to = asText(item.to)
    if (kind === undefined || !(TIE_KINDS as readonly string[]).includes(kind) || from === undefined || to === undefined) continue
    const since = chapterAt(item.since)
    const until = chapterAt(item.until)
    const note = asText(item.note)
    try {
      // The larger end first: what a thing is in is known before the thing in it asks what kind it is.
      await ensure(to, kind, 'to', from)
      await ensure(from, kind, 'from', to)
      const had = (await project.ties()).length
      await project.saveTie({ kind, from: end(kind, 'from', from), to: end(kind, 'to', to), ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(note !== undefined ? { note } : {}) })
      if ((await project.ties()).length > had) result.added += 1
      else result.changed += 1
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error
      result.skipped.push(`${kind}: ${from} → ${to} (${error.message})`)
    }
  }
  // What happens to a place, a house or a thing itself, chapter by chapter: its course, beside the ties it is an end of.
  for (const item of asArray(value.events).map(asRecord)) {
    const name = asText(item.name)
    const kind = asText(item.kind) as WorldEvent['kind'] | undefined
    const what = asText(item.what)
    const chapter = chapterAt(item.chapter)
    if (name === undefined || what === undefined || chapter === undefined || kind === undefined || !WORLD_EVENT_KINDS.includes(kind)) continue
    const entry = await project.findWorld(bare(name))
    if (entry === undefined || groupOf(entry.category) === 'ideas') continue
    const course = entry.events ?? []
    // Said before of the same chapter: once is enough.
    if (course.some(event => event.chapter === chapter && event.kind === kind)) continue
    await project.saveWorld({ id: entry.id, events: [...course, { chapter, kind, what: clip(what, 120, '…') }] })
    result.events += 1
  }
  result.total = (await project.ties()).length
  if (result.added + result.changed + result.removed + result.created.length + result.events > 0) {
    await project.addActivity({ by: 'crew', role: 'architect', tool: 'ties', summary: L(lang, `策划理清了关系：新增 ${result.added} 条，改了 ${result.changed} 条，去掉 ${result.removed} 条（现在共 ${result.total} 条）${result.created.length > 0 ? `；为此新建了条目：${result.created.join('、')}` : ''}`, `The planner worked out the ties: ${result.added} added, ${result.changed} changed, ${result.removed} removed (${result.total} in all)${result.created.length > 0 ? `; entries made for them: ${result.created.join(', ')}` : ''}`) })
  }
  return result
}

/**
 * Have continuity tell somebody's life on the page in a paragraph, from what
 * the chapter digests noted of them along one line of the plot, and keep it
 * on their card.
 * @throws ProjectError `novel/empty` when no digest names them: there is nothing to tell yet.
 */
export async function writeLife(core: NovelCore, runtime: ProjectRuntime, params: { character: string; line?: string }, task: TaskContext): Promise<{ card: CharacterCard; life: string; chapters: number }> {
  const { project } = runtime
  const card = await project.findCharacter(params.character)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const { chapters, lives } = await project.lives(params.line)
  const life = lives[card.id]
  if (life === undefined || life.events.length === 0) throw new ProjectError('novel/empty', `no digested chapter names ${card.name} yet — digest the chapters they are in first`)
  const titles = new Map(chapters.map(chapter => [chapter.id, chapter.title]))
  const mark: Record<string, [string, string]> = { enter: ['登场', 'comes on'], return: ['回归', 'returns'], exit: ['离开', 'leaves'], death: ['死亡', 'dies'], seen: ['', ''] }
  const record = life.events.map((event) => {
    const note = L(lang, ...mark[event.kind]!)
    return [
      L(lang, `第 ${event.index} 章《${titles.get(event.chapter) ?? ''}》${note.length > 0 ? `【${note}】` : ''}`, `Chapter ${event.index}, "${titles.get(event.chapter) ?? ''}"${note.length > 0 ? ` [${note}]` : ''}`),
      event.what !== undefined ? L(lang, `  做了什么：${event.what}`, `  what: ${event.what}`) : undefined,
      event.state !== undefined ? L(lang, `  章末状态：${event.state}`, `  at its end: ${event.state}`) : undefined,
      event.where !== undefined ? L(lang, `  地点：${event.where}`, `  where: ${event.where}`) : undefined,
    ].filter((line): line is string => line !== undefined).join('\n')
  }).join('\n')
  const { value } = await assign(core, runtime, task, {
    role: 'analyst',
    label: L(lang, `履历 · ${card.name}`, `Life · ${card.name}`),
    tool: 'write_life',
    // Everything it is to go by is in the task; a look or two at the text to check a chapter, then the paragraph.
    // All of it is in the task: asked in one request, whatever the role is set to.
    plain: true,
    maxSteps: 8,
    what: L(lang, '这个人物在书里的履历：一段话', 'this character\'s life in the book: one paragraph'),
    prompt: characterLifeTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      name: card.name,
      card: renderCharacter({ ...card, life: undefined, secrets: undefined, notes: undefined } as CharacterCard, lang),
      record,
      chapters: chapters.length,
    }),
    temperature: 0.2,
    validate: (raw) => {
      const text = asText(asRecord(raw).life)
      if (text === undefined || text.length < 20) throw new Error('"life" is empty: write the paragraph')
      return { life: text }
    },
  })
  const saved = await project.saveCharacter({ id: card.id, life: value.life })
  return { card: saved, life: value.life, chapters: life.events.length }
}

export async function expandCharacter(core: NovelCore, runtime: ProjectRuntime, params: { character: string; direction?: string; apply?: boolean }, task: TaskContext): Promise<{ card: CharacterCard; changes: Partial<CharacterCard>; applied: boolean }> {
  const { project } = runtime
  const card = await project.findCharacter(params.character)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('architect', runtime, task)
  const pack = await core.pack(runtime, route, {
    purpose: 'derive',
    brief: `${card.name} ${params.direction ?? ''}`,
    characters: [card.id],
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const characters = await project.characters()
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, `充实人物 · ${card.name}`, `Character · ${card.name}`),
    tool: 'propose_character',
    what: L(lang, '充实后的人物卡字段', 'the fields of the fuller character card'),
    prompt: expandCharacterTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: pack.text,
      card: renderCharacter(card, lang, { resolveName: ref => characters.find(other => other.id === ref)?.name ?? ref }),
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    validate: raw => asRecord(raw),
  })
  const changes: Partial<CharacterCard> = pickText(value, ['tagline', 'gender', 'age', 'appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice', 'abilities', 'secrets'])
  const personaRaw = asRecord(value.persona)
  const persona: CharacterPersona = {}
  const traits = asArray(personaRaw.traits).map((raw) => {
    const item = typeof raw === 'string' ? { name: raw } : asRecord(raw)
    const name = asText(item.name)
    const level = Number(item.level)
    return name === undefined ? undefined : { name, ...(Number.isFinite(level) && level >= 1 && level <= 5 ? { level: Math.round(level) } : {}) }
  }).filter((trait): trait is { name: string; level?: number } => trait !== undefined)
  if (traits.length > 0) persona.traits = traits
  const values = asList(personaRaw.values)
  if (values.length > 0) persona.values = values
  const speech = asList(personaRaw.speech)
  if (speech.length > 0) persona.speech = speech
  const taboos = asList(personaRaw.taboos)
  if (taboos.length > 0) persona.taboos = taboos
  const underPressure = asText(personaRaw.underPressure)
  if (underPressure !== undefined) persona.underPressure = underPressure
  if (Object.keys(persona).length > 0) changes.persona = { ...card.persona, ...persona }
  const relationships = asArray(value.relationships).map(asRecord).map((item) => {
    const target = asText(item.target)
    const kind = asText(item.kind)
    if (target === undefined || kind === undefined) return undefined
    const resolved = characters.find(other => other.name === target || other.aliases?.includes(target) === true)?.id ?? target
    const note = asText(item.note)
    return { target: resolved, kind, ...(note !== undefined ? { note } : {}) }
  }).filter((item): item is NonNullable<typeof item> => item !== undefined)
  if (relationships.length > 0) {
    const merged = [...(card.relationships ?? [])]
    for (const relation of relationships) if (!merged.some(existing => existing.target === relation.target)) merged.push(relation)
    changes.relationships = merged
  }
  const visualPrompt = asText(value.visualPrompt)
  if (visualPrompt !== undefined) changes.visual = { ...card.visual, prompt: visualPrompt }
  const voiceDesign = asText(value.voiceDesign)
  if (voiceDesign !== undefined) changes.voiceProfile = { ...card.voiceProfile, designPrompt: voiceDesign }
  const applied = params.apply !== false
  const next = applied ? await project.saveCharacter({ id: card.id, ...changes }) : { ...card, ...changes }
  return { card: next, changes, applied }
}

export async function expandWorld(core: NovelCore, runtime: ProjectRuntime, params: { entry: string; direction?: string; apply?: boolean }, task: TaskContext): Promise<{ entry: WorldEntry; changes: Partial<WorldEntry>; applied: boolean }> {
  const { project } = runtime
  const entry = await project.findWorld(params.entry)
  if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${params.entry}"`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route('architect', runtime, task)
  const pack = await core.pack(runtime, route, { purpose: 'derive', brief: `${entry.name} ${entry.summary ?? ''} ${params.direction ?? ''}`, ...(task.signal !== undefined ? { signal: task.signal } : {}) })
  const { value } = await assign(core, runtime, task, {
    role: 'architect',
    label: L(lang, `充实设定 · ${entry.name}`, `World · ${entry.name}`),
    tool: 'propose_world_entry',
    what: L(lang, '充实后的设定条目', 'the fuller world entry'),
    prompt: expandWorldTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: pack.text,
      entry: renderWorld(entry, lang),
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    validate: raw => asRecord(raw),
  })
  const changes: Partial<WorldEntry> = pickText(value, ['summary', 'body', 'visualPrompt'])
  const aliases = asList(value.aliases)
  if (aliases.length > 0) changes.aliases = [...new Set([...(entry.aliases ?? []), ...aliases])]
  const tags = asList(value.tags)
  if (tags.length > 0) changes.tags = [...new Set([...(entry.tags ?? []), ...tags])]
  const applied = params.apply !== false
  const next = applied ? await project.saveWorld({ id: entry.id, ...changes }) : { ...entry, ...changes }
  return { entry: next, changes, applied }
}

/** Learn a style profile from a sample passage. */
export async function extractStyle(core: NovelCore, runtime: ProjectRuntime, params: { sample: string; name?: string; id?: string; activate?: boolean }, task: TaskContext): Promise<StyleProfile> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  if (params.sample.trim().length < 80) throw new ProjectError('novel/invalid', 'the sample is too short to learn a style from — give at least a few paragraphs')
  const { value } = await assign(core, runtime, task, {
    role: 'analyst',
    label: L(lang, '提炼文风', 'Learning a style'),
    tool: 'record_style',
    // The material is all in the task: a few looks at the book at most, then the result.
    // All of it is in the task: asked in one request, whatever the role is set to.
    plain: true,
    maxSteps: 8,
    what: L(lang, '从样章里提炼出的文风档案', 'the style profile learned from the sample'),
    prompt: styleExtractTask({ lang, sample: clip(params.sample, 6000), ...(params.name !== undefined ? { name: params.name } : {}) }),
    temperature: 0.3,
    validate: raw => asRecord(raw),
  })
  const pov = asText(value.pov) as StyleProfile['pov']
  const tense = asText(value.tense)
  const rules = asList(value.rules)
  const avoid = asList(value.avoid)
  const exemplars = asList(value.exemplars).map(text => ({ text }))
  const style = await project.saveStyle({
    ...(params.id !== undefined ? { id: params.id } : {}),
    name: params.name ?? asText(value.name) ?? (lang === 'zh' ? '提炼的文风' : 'Extracted style'),
    ...(pov !== undefined && POVS.includes(pov) ? { pov } : {}),
    ...(tense === 'past' || tense === 'present' ? { tense } : {}),
    ...pickText(value, ['tone', 'diction', 'rhythm', 'imagery', 'dialogue', 'pacing']),
    ...(rules.length > 0 ? { rules } : {}),
    ...(avoid.length > 0 ? { avoid } : {}),
    ...(exemplars.length > 0 ? { exemplars } : {}),
  })
  if (params.activate === true) await project.updateManifest({ activeStyle: style.id })
  return style
}

/** Write a short passage in a style so the author can hear it before committing. */
export async function styleSample(core: NovelCore, runtime: ProjectRuntime, params: { style?: string; scene?: string; draft?: StyleProfile }, task: TaskContext): Promise<string> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const style = params.draft ?? (params.style !== undefined ? await project.findStyle(params.style) : await project.activeStyle())
  const route = await core.route('writer', runtime, task)
  const response = await core.llm.complete({
    route,
    prompt: styleSampleTask({ lang, language: manifest.language, title: manifest.title, style: renderStyle(style, lang), ...(params.scene !== undefined ? { scene: params.scene } : {}) }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
  })
  return response.text.trim()
}

/** Accept a suggestion left by digest: create the entry or change the status it proposes. */
export async function acceptSuggestion(runtime: ProjectRuntime, id: string): Promise<Suggestion> {
  const { project } = runtime
  const suggestion = await project.takeSuggestion(id)
  if (suggestion === undefined) throw new ProjectError('novel/not-found', `no suggestion "${id}"`)
  const payload = suggestion.payload
  switch (suggestion.kind) {
    case 'new-character':
      await project.saveCharacter(payload as Partial<CharacterCard> & { name: string })
      break
    case 'alias':
      // A name of the page that is somebody's other name: onto their card, and their lines in the audio scripts with it.
      await settleWalkOn(project, { name: String(payload.name), action: 'alias', target: String(payload.target) })
      break
    case 'new-world':
      await project.saveWorld(payload as Partial<WorldEntry> & { name: string })
      break
    case 'thread-status':
      await project.saveThread({ id: String(payload.thread), status: payload.status as 'open' | 'paid' | 'dropped' })
      break
    case 'new-thread':
      await project.saveThread({ title: String(payload.title), ...(typeof payload.description === 'string' ? { description: payload.description } : {}) })
      break
    case 'bible-edit': {
      // One field of one card, as the planner found it should read while tracing a problem through the book.
      const field = String(payload.field)
      const value = String(payload.value)
      if (payload.target === 'world') await project.saveWorld({ id: String(payload.id), [field]: value } as Partial<WorldEntry> & { id: string })
      else await project.saveCharacter({ id: String(payload.id), [field]: value } as Partial<CharacterCard> & { id: string })
      break
    }
    default:
      break
  }
  return suggestion
}

export async function dismissSuggestion(runtime: ProjectRuntime, id: string): Promise<boolean> {
  return (await runtime.project.takeSuggestion(id)) !== undefined
}

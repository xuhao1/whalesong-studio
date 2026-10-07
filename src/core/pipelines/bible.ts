// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Story-bible assistance: fleshing out a character or a world entry in
 * agreement with what is already written, learning a style from a sample,
 * and applying the suggestions digest leaves behind.
 */
import type { CharacterCard, CharacterPersona, StyleProfile, Suggestion, WorldEntry } from '../../shared/types'
import { clip } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asList, asRecord, asText, completeJson } from '../llm'
import { ProjectError } from '../project'
import { expandCharacterTask, expandWorldTask, styleExtractTask, styleSampleTask } from '../prompts'
import { promptLanguage, renderCharacter, renderStyle, renderWorld } from '../render'
import { pickText } from './plot'

const POVS: NonNullable<StyleProfile['pov']>[] = ['first', 'third-limited', 'third-omniscient', 'second', 'multi']

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
  const { value } = await completeJson(core.llm, {
    route,
    prompt: expandCharacterTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: pack.text,
      card: renderCharacter(card, lang, { resolveName: ref => characters.find(other => other.id === ref)?.name ?? ref }),
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
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
  const { value } = await completeJson(core.llm, {
    route,
    prompt: expandWorldTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      context: pack.text,
      entry: renderWorld(entry, lang),
      ...(params.direction !== undefined ? { direction: params.direction } : {}),
    }),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    onText: (_delta, total) => { task.job?.rewrite(total) },
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
  const route = await core.route('analyst', runtime, task)
  const { value } = await completeJson(core.llm, {
    route,
    prompt: styleExtractTask({ lang, sample: clip(params.sample, 6000), ...(params.name !== undefined ? { name: params.name } : {}) }),
    temperature: 0.3,
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
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
    case 'new-world':
      await project.saveWorld(payload as Partial<WorldEntry> & { name: string })
      break
    case 'character-status':
      await project.saveCharacter({ id: String(payload.character), status: payload.status as CharacterCard['status'] })
      break
    case 'thread-status':
      await project.saveThread({ id: String(payload.thread), status: payload.status as 'open' | 'paid' | 'dropped' })
      break
    case 'new-thread':
      await project.saveThread({ title: String(payload.title), ...(typeof payload.description === 'string' ? { description: payload.description } : {}) })
      break
    default:
      break
  }
  return suggestion
}

export async function dismissSuggestion(runtime: ProjectRuntime, id: string): Promise<boolean> {
  return (await runtime.project.takeSuggestion(id)) !== undefined
}

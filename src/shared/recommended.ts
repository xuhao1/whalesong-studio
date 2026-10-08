// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the Studio recommends, as data. Models move faster than releases of
 * code read well: which image model a service is best used with, which models
 * are worth offering beside it, how large the window of a model family is —
 * all of it ages by the month. So none of it is written into the code. It is
 * `recommended.json`, a file that ships with the plugin, carries an issue
 * number and a date, and is replaced with every update.
 *
 * An author chooses whether to follow it (see the Host's `followRecommended`):
 * following, a setting that still is what an earlier issue recommended moves
 * to what the new issue recommends, and the Studio says what moved; a setting
 * the author chose for themselves is never touched.
 *
 * The copy read at build time is the floor: a Host that cannot find the file,
 * and a Studio whose Host does not send it, use that.
 */
import builtin from '../../recommended.json'

export interface RecommendedSlot {
  /** The kind of endpoint the model is reached through, in the Studio's own terms (`openai`, `dashscope`, `openrouter`, `qwen-audiogen`…). */
  provider: string
  model: string
  /** Pictures: the size the model is best asked for. */
  size?: string
  /** Speech: the narrator's voice, where the service names its voices. */
  narratorVoice?: string
  /** Models worth offering beside the model field, best first. */
  suggestions?: string[]
  /** The model's name as people say it, where its id reads badly. */
  label?: string
}

/** What a kind of endpoint is used with when a slot names no model of its own. */
export interface RecommendedProvider {
  model: string
  /** Speech: the model that speaks in voices designed for a character. */
  designedVoiceModel?: string
  narratorVoice?: string
  suggestions?: string[]
}

/** The parts of the Studio a kind of endpoint can serve. */
export type ProviderPart = 'image' | 'tts' | 'sound'

export interface RecommendedService {
  embedding?: RecommendedSlot
  image?: RecommendedSlot
  tts?: RecommendedSlot
}

/** A model family, told by its name, and a number of tokens that goes with it. */
export interface ModelFigure {
  /** A regular expression over the model's id, matched without regard to case. */
  match: string
  tokens: number
}

export interface Recommended {
  schema: 1
  /** Counts up with every issue. */
  version: number
  /** The day of the issue, `YYYY-MM-DD`. */
  date: string
  /** What this issue changed, for the author. */
  notes?: { zh?: string; en?: string }
  services: Record<string, RecommendedService>
  /** By part, then by kind of endpoint: the model used when a slot names none, and what is offered beside the field. */
  providers?: Partial<Record<ProviderPart, Record<string, RecommendedProvider>>>
  /** Models a service serves without listing them, by service, then by part. */
  unlisted?: Record<string, Partial<Record<'embedding' | 'image' | 'tts', string[]>>>
  /** Context windows of model families, for endpoints that publish none. */
  windows?: ModelFigure[]
  /** The most a model family writes in one reply, where its maker documents it. */
  maxOutput?: ModelFigure[]
}

const isSlot = (value: unknown): value is RecommendedSlot => typeof value === 'object' && value !== null && typeof (value as RecommendedSlot).model === 'string' && typeof (value as RecommendedSlot).provider === 'string'
const isProvider = (value: unknown): value is RecommendedProvider => typeof value === 'object' && value !== null && typeof (value as RecommendedProvider).model === 'string'
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [])
const isFigure = (value: unknown): value is ModelFigure => {
  if (typeof value !== 'object' || value === null) return false
  const figure = value as ModelFigure
  if (typeof figure.match !== 'string' || typeof figure.tokens !== 'number' || !(figure.tokens > 0)) return false
  try {
    void new RegExp(figure.match, 'i')
    return true
  } catch {
    return false
  }
}

/**
 * Read an issue of the recommendations, leaving out whatever in it is not
 * understood: one malformed entry does not cost the rest.
 * @returns undefined when it is no issue at all (no version, no services).
 */
export function parseRecommended(raw: unknown): Recommended | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Partial<Recommended>
  if (typeof record.version !== 'number' || !(record.version >= 1) || typeof record.services !== 'object' || record.services === null) return undefined
  const services: Record<string, RecommendedService> = {}
  for (const [id, service] of Object.entries(record.services)) {
    if (typeof service !== 'object' || service === null) continue
    const slots: RecommendedService = {}
    for (const part of ['embedding', 'image', 'tts'] as const) if (isSlot((service as RecommendedService)[part])) slots[part] = (service as RecommendedService)[part]!
    services[id] = slots
  }
  const providers: NonNullable<Recommended['providers']> = {}
  if (typeof record.providers === 'object' && record.providers !== null) {
    for (const part of ['image', 'tts', 'sound'] as const) {
      const kinds = (record.providers as Record<string, unknown>)[part]
      if (typeof kinds !== 'object' || kinds === null) continue
      providers[part] = Object.fromEntries(Object.entries(kinds).filter((entry): entry is [string, RecommendedProvider] => isProvider(entry[1])))
    }
  }
  const unlisted: NonNullable<Recommended['unlisted']> = {}
  if (typeof record.unlisted === 'object' && record.unlisted !== null) {
    for (const [id, parts] of Object.entries(record.unlisted)) {
      if (typeof parts !== 'object' || parts === null) continue
      unlisted[id] = Object.fromEntries(Object.entries(parts).map(([part, models]) => [part, strings(models)]))
    }
  }
  return {
    schema: 1,
    version: Math.floor(record.version),
    date: typeof record.date === 'string' ? record.date : '',
    ...(typeof record.notes === 'object' && record.notes !== null ? { notes: record.notes } : {}),
    services,
    providers,
    unlisted,
    ...(Array.isArray(record.windows) ? { windows: record.windows.filter(isFigure) } : {}),
    ...(Array.isArray(record.maxOutput) ? { maxOutput: record.maxOutput.filter(isFigure) } : {}),
  }
}

/** The issue this build of the plugin was made with. */
export const BUILTIN_RECOMMENDED: Recommended = parseRecommended(builtin)!

let active: Recommended = BUILTIN_RECOMMENDED
let figures: { of: Recommended; windows: [RegExp, number][]; maxOutput: [RegExp, number][] } | undefined

/** The issue in force: the file beside the plugin where the Host read it, the Host's where the Studio was sent it, else the built-in one. */
export function recommended(): Recommended {
  return active
}

/** Put an issue in force. An older one than the built-in is not taken: the plugin was made knowing better. */
export function setRecommended(next: Recommended | undefined): Recommended {
  if (next !== undefined && next.version >= BUILTIN_RECOMMENDED.version) active = next
  return active
}

function compiled(): NonNullable<typeof figures> {
  if (figures === undefined || figures.of !== active) {
    const table = (list: ModelFigure[] | undefined): [RegExp, number][] => (list ?? []).map(figure => [new RegExp(figure.match, 'i'), figure.tokens])
    figures = { of: active, windows: table(active.windows), maxOutput: table(active.maxOutput) }
  }
  return figures
}

/**
 * What a kind of endpoint is used with when a slot names no model. An issue
 * that leaves a kind out falls back on the one this build was made with, which
 * names every kind the code can ask for (a test holds it to that).
 */
export function providerDefault(part: ProviderPart, provider: string): RecommendedProvider {
  return active.providers?.[part]?.[provider] ?? BUILTIN_RECOMMENDED.providers?.[part]?.[provider] ?? { model: '' }
}

/** Models a service serves without listing them. */
export function unlistedModels(service: string, part: 'embedding' | 'image' | 'tts'): string[] {
  return active.unlisted?.[service]?.[part] ?? []
}

/** The context window of a model family the recommendations know, for an endpoint that publishes none. */
export function knownWindow(model: string): number | undefined {
  return compiled().windows.find(([pattern]) => pattern.test(model))?.[1]
}

/** The most a model family writes in one reply, where the recommendations know it. */
export function knownOutput(model: string): number | undefined {
  return compiled().maxOutput.find(([pattern]) => pattern.test(model))?.[1]
}

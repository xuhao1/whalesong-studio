// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Keeping an author's settings in step with the recommendations that ship
 * with the plugin (`recommended.json`) — for as far as the author wants that.
 *
 * Only what was a recommendation moves: a model that is what an issue
 * recommended is replaced by what a later issue recommends; a model the
 * author chose instead is theirs and stays. What moved is said, and can be
 * taken back; an author who does not follow is told what an issue would
 * change, and nothing is changed.
 *
 *   loadRecommended     put the issue beside the plugin in force
 *   followRecommended   bring the settings up against it (when the Host half is put up)
 *   noteAdopted         keep track of which settings are a recommendation (after any change of settings)
 *   settleRecommended   what the author does about a notice
 *   recommendedView     the issue and where the settings stand, for the Studio
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findPackageRoot } from '../core/crew'
import type { DeepPartial, SettingsStore } from '../core/settings'
import { BUILTIN_RECOMMENDED, parseRecommended, recommended, setRecommended, type Recommended, type RecommendedSlot } from '../shared/recommended'
import type { RecommendedView } from '../shared/rpc'
import { serviceOf } from '../shared/services'
import type { NovelSettings, RecommendedChange, RecommendedState } from '../shared/types'

/** Put the issue beside the plugin in force; a file that is missing, broken or older than the built-in issue leaves that one. */
export async function loadRecommended(log: (message: string, error?: unknown) => void): Promise<Recommended> {
  const root = await findPackageRoot()
  if (root === undefined) return setRecommended(BUILTIN_RECOMMENDED)
  try {
    const issue = parseRecommended(JSON.parse(await readFile(join(root, 'recommended.json'), 'utf8')))
    if (issue === undefined) log('recommended.json beside the plugin is not an issue of the recommendations; the built-in one is used')
    return setRecommended(issue ?? BUILTIN_RECOMMENDED)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log('recommended.json beside the plugin could not be read; the built-in recommendations are used', error)
    return setRecommended(BUILTIN_RECOMMENDED)
  }
}

const PARTS = ['image', 'tts', 'embedding'] as const
type Part = typeof PARTS[number]

/** What an issue recommends for the service a slot of the settings points at. */
function slotFor(settings: NovelSettings, part: Part, table: Recommended): RecommendedSlot | undefined {
  const base = settings[part].baseURL
  return base !== undefined && base.length > 0 ? table.services[serviceOf(base)]?.[part] : undefined
}

/**
 * What follows the recommendations: the model of each part — and, with the
 * speech model, the narrator's voice, which is one of that model's voices and
 * means nothing to another.
 */
type Field = 'model' | 'narratorVoice'
const FIELDS: Record<Part, Field[]> = { image: ['model'], tts: ['model', 'narratorVoice'], embedding: ['model'] }

function valueAt(settings: NovelSettings, key: string): string | undefined {
  const [part, field] = key.split('.') as [Part, Field]
  return (settings[part] as Partial<Record<Field, string>> | undefined)?.[field]
}

/** What of the settings is, right now, what the issue recommends: the values a later issue may move. */
export function adoptedNow(settings: NovelSettings, table: Recommended = recommended()): Record<string, string> {
  const adopted: Record<string, string> = {}
  for (const part of PARTS) {
    const slot = slotFor(settings, part, table)
    if (slot === undefined) continue
    for (const field of FIELDS[part]) {
      const value = valueAt(settings, `${part}.${field}`)
      if (value !== undefined && value === slot[field]) adopted[`${part}.${field}`] = value
    }
  }
  return adopted
}

/** What an issue would move: settings that still are what an earlier issue recommended, where this one recommends otherwise. */
export function recommendedChanges(settings: NovelSettings, adopted: Record<string, string>, table: Recommended = recommended()): RecommendedChange[] {
  const changes: RecommendedChange[] = []
  for (const part of PARTS) {
    const slot = slotFor(settings, part, table)
    if (slot === undefined) continue
    const moves = (field: Field): RecommendedChange | undefined => {
      const key = `${part}.${field}`
      const value = valueAt(settings, key)
      const now = slot[field]
      return value !== undefined && now !== undefined && adopted[key] === value && now !== value ? { key, from: value, to: now } : undefined
    }
    const model = moves('model')
    if (model === undefined) continue
    changes.push(model)
    // A voice goes with its model: it moves when the model does, never on its own — the narrator of a book does not change voice for nothing.
    const voice = FIELDS[part].includes('narratorVoice') ? moves('narratorVoice') : undefined
    if (voice !== undefined) changes.push(voice)
  }
  return changes
}

const patchOf = (changes: readonly RecommendedChange[], side: 'from' | 'to'): DeepPartial<NovelSettings> => {
  const patch: Record<string, Record<string, string>> = {}
  for (const change of changes) {
    const [part, field] = change.key.split('.') as [string, string]
    patch[part] = { ...patch[part], [field]: change[side] }
  }
  return patch as DeepPartial<NovelSettings>
}

const note = async (store: SettingsStore, state: { [K in keyof RecommendedState]?: RecommendedState[K] | null }): Promise<NovelSettings> =>
  await store.update({ recommended: state } as DeepPartial<NovelSettings>)

const without = (adopted: Record<string, string> | undefined, changes: readonly RecommendedChange[]): Record<string, string> =>
  Object.fromEntries(Object.entries(adopted ?? {}).filter(([key]) => !changes.some(change => change.key === key)))

/**
 * Bring the settings up against the issue in force. Run when the Host half is
 * put up: an update of the plugin is when an issue changes.
 */
export async function followRecommended(store: SettingsStore): Promise<void> {
  const table = recommended()
  const settings = await store.get()
  const state = settings.recommended ?? {}
  // Settings from before issues were kept track of: what of them is a recommendation now is noted, so that a later issue can move it.
  if (state.version === undefined) {
    await note(store, { version: table.version, adopted: { ...state.adopted, ...adoptedNow(settings, table) } })
    return
  }
  if (table.version <= state.version) return
  const changes = recommendedChanges(settings, state.adopted ?? {}, table)
  if (changes.length === 0) {
    await note(store, { version: table.version, adopted: { ...state.adopted, ...adoptedNow(settings, table) } })
    return
  }
  if (state.follow === false) {
    // Told, not done: the author keeps what they have, and can take the issue up from the notice.
    await note(store, { version: table.version, notice: { version: table.version, date: table.date, changes, pending: true } })
    return
  }
  const moved = await store.update(patchOf(changes, 'to'))
  await note(store, { version: table.version, adopted: { ...state.adopted, ...adoptedNow(moved, table) }, notice: { version: table.version, date: table.date, changes } })
}

/**
 * After any change of settings: a value that now is what the issue in force
 * recommends is one a later issue may move. Nothing is written when nothing of
 * that changed, so this can listen to the settings it writes to.
 */
export async function noteAdopted(store: SettingsStore): Promise<void> {
  const settings = await store.get()
  // Not before the settings have been brought up against an issue for the first time: that is `followRecommended`'s to do.
  if (settings.recommended?.version === undefined) return
  const known = settings.recommended.adopted ?? {}
  const now = adoptedNow(settings)
  if (Object.entries(now).every(([key, value]) => known[key] === value)) return
  await note(store, { adopted: { ...known, ...now } })
}

/**
 * What the author does about a notice.
 *   adopt    take up what an issue would change (they were not following)
 *   keep     leave those settings as they are — they are the author's own from now on, and no issue asks about them again
 *   revert   take back what an issue changed; those settings, too, are the author's own from now on
 *   dismiss  it has been read
 */
export async function settleRecommended(store: SettingsStore, action: 'adopt' | 'keep' | 'revert' | 'dismiss'): Promise<NovelSettings> {
  const settings = await store.get()
  const state = settings.recommended
  const notice = state?.notice
  if (state === undefined || notice === undefined) return settings
  if (action === 'adopt' && notice.pending === true) {
    // Only what is still as it was when the notice was written: a setting changed since is not overwritten by it.
    const still = notice.changes.filter(change => valueAt(settings, change.key) === change.from)
    const moved = await store.update(patchOf(still, 'to'))
    return await note(store, { adopted: { ...state.adopted, ...adoptedNow(moved) }, notice: null })
  }
  if (action === 'revert' && notice.pending !== true) {
    const still = notice.changes.filter(change => valueAt(settings, change.key) === change.to)
    await store.update(patchOf(still, 'from'))
    return await note(store, { adopted: without(state.adopted, notice.changes), notice: null })
  }
  if (action === 'keep' && notice.pending === true) return await note(store, { adopted: without(state.adopted, notice.changes), notice: null })
  return await note(store, { notice: null })
}

/** The issue in force and where the settings stand against it, as the Studio shows it. */
export function recommendedView(settings: NovelSettings): RecommendedView {
  const table = recommended()
  const state = settings.recommended ?? {}
  return {
    version: table.version,
    date: table.date,
    ...(table.notes !== undefined ? { notes: table.notes } : {}),
    follow: state.follow !== false,
    ...(state.notice !== undefined ? { notice: state.notice } : {}),
    table,
  }
}

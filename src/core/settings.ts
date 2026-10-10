// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * User-level settings: which models play which role, how context is packed and
 * which media endpoints are used. Stored once per Harness home
 * (`$DSH_HOME/novel-writer/settings.json`) so every project shares them;
 * a project may override the text model routing in its manifest.
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { NovelSettings } from '../shared/types'
import { KeyedMutex } from './util/async'
import { readJson, writeJson } from './util/fs'

/**
 * Which round of defaults a settings file has been brought up to. A file from
 * before a round is migrated when it is read, and says so once it is saved —
 * so a value the author sets afterwards is never taken for an old default.
 */
export const SETTINGS_REVISION = 2

export const DEFAULT_SETTINGS: NovelSettings = {
  schema: 1,
  models: {},
  // Current models hold a million tokens; the budget is cut to what a smaller window leaves room for at call time.
  // No budget of the author's own: the manuscript gets half of whatever window the model has.
  context: { strategy: 'auto', tailChars: 3000 },
  image: { provider: 'none', size: '1024x1024' },
  tts: { provider: 'none' },
  // Effects, music and generated ambience ride on the speech setup wherever its model can make them.
  sound: { provider: 'auto' },
  embedding: { provider: 'none' },
  // Every role of the crew is an agent with its own tools until the author says otherwise.
  crew: {},
  autoDigest: true,
  reviewAgentRevisions: false,
  // Reading on other devices is something the author switches on, book by book.
  share: { enabled: false },
  revision: SETTINGS_REVISION,
}

/** Resolve the Harness home the same way the launcher does: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured)
  return join(homedir(), '.dsh')
}

/** Overlay `patch` on `base` one section deep; `undefined` keeps, `null` resets a section to its default. */
export function mergeSettings(base: NovelSettings, patch: DeepPartial<NovelSettings>, defaults: NovelSettings = DEFAULT_SETTINGS): NovelSettings {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === 'schema') continue
    const fallback = (defaults as unknown as Record<string, unknown>)[key]
    if (value === null) {
      next[key] = structuredClone(fallback)
    } else if (typeof value === 'object' && !Array.isArray(value) && typeof next[key] === 'object' && next[key] !== null) {
      const section: Record<string, unknown> = { ...(next[key] as Record<string, unknown>) }
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        if (fieldValue === undefined) continue
        if (fieldValue === null || fieldValue === '') delete section[field]
        else section[field] = fieldValue
      }
      next[key] = section
    } else {
      next[key] = value
    }
  }
  return { ...(next as unknown as NovelSettings), schema: 1 }
}

/** The context budgets settings files were saved with while there was a fixed default; nobody chose them. */
const LEGACY_BUDGETS = [48_000, 500_000]
/** The numbers of parallel speech requests the old default and the one-click setups wrote; nobody chose them either. */
const LEGACY_SPEECH = [2, 3]

/**
 * Bring a saved file forward: values that were only ever an old default follow
 * the new one. Done once — a file that carries the current revision is taken
 * at its word.
 */
function migrate(saved: DeepPartial<NovelSettings>): DeepPartial<NovelSettings> {
  if (typeof saved.revision === 'number' && saved.revision >= SETTINGS_REVISION) return saved
  let next: DeepPartial<NovelSettings> = { ...saved, revision: SETTINGS_REVISION }
  const context = saved.context
  if (context !== undefined && context !== null && typeof context.budgetTokens === 'number' && LEGACY_BUDGETS.includes(context.budgetTokens)) {
    const { budgetTokens: _old, ...rest } = context
    next = { ...next, context: rest }
  }
  const tts = saved.tts
  if (tts !== undefined && tts !== null && typeof tts.concurrency === 'number' && LEGACY_SPEECH.includes(tts.concurrency)) {
    const { concurrency: _old, ...rest } = tts
    next = { ...next, tts: rest }
  }
  return next
}

/** Any part of the settings; an optional section may be patched field by field like the others. */
export type DeepPartial<T> = { [K in keyof T]?: NonNullable<T[K]> extends object ? DeepPartial<NonNullable<T[K]>> | null : T[K] | null }

export class SettingsStore {
  private current: NovelSettings | undefined
  private readonly mutex = new KeyedMutex()
  private readonly listeners = new Set<() => void>()

  /**
   * @param defaults - deployment defaults from the plugin's Cordis config; the
   *   user's saved values overlay them.
   * @param file - override of the settings file location (tests).
   */
  constructor(private readonly defaults: NovelSettings = DEFAULT_SETTINGS, private readonly file = join(resolveDshHome(), 'novel-writer', 'settings.json')) {}

  /** The folder the settings are kept in: where the Studio keeps what is its own and no one book's. */
  get folder(): string {
    return dirname(this.file)
  }

  async get(): Promise<NovelSettings> {
    if (this.current !== undefined) return this.current
    let saved: DeepPartial<NovelSettings> | undefined
    try {
      saved = await readJson<DeepPartial<NovelSettings>>(this.file)
    } catch {
      // A hand-broken settings file must not take the plugin down; defaults apply until it is saved again.
      saved = undefined
    }
    this.current = saved === undefined ? structuredClone(this.defaults) : mergeSettings(structuredClone(this.defaults), migrate(saved), this.defaults)
    return this.current
  }

  async update(patch: DeepPartial<NovelSettings>): Promise<NovelSettings> {
    return await this.mutex.run('settings', async () => {
      const next = mergeSettings(await this.get(), patch, this.defaults)
      await writeJson(this.file, next)
      this.current = next
      for (const listener of [...this.listeners]) listener()
      return next
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

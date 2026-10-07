// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * User-level settings: which models play which role, how context is packed and
 * which media endpoints are used. Stored once per Harness home
 * (`$DSH_HOME/novel-writer/settings.json`) so every project shares them;
 * a project may override the text model routing in its manifest.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { NovelSettings } from '../shared/types'
import { KeyedMutex } from './util/async'
import { readJson, writeJson } from './util/fs'

export const DEFAULT_SETTINGS: NovelSettings = {
  schema: 1,
  models: {},
  // Current models hold a million tokens; the budget is cut to what a smaller window leaves room for at call time.
  context: { strategy: 'auto', budgetTokens: 500_000, tailChars: 3000 },
  image: { provider: 'none', size: '1024x1024' },
  tts: { provider: 'none', concurrency: 3 },
  // Effects, music and generated ambience ride on the speech setup wherever its model can make them.
  sound: { provider: 'auto' },
  embedding: { provider: 'none' },
  autoDigest: true,
  reviewAgentRevisions: false,
  // Reading on other devices is something the author switches on, book by book.
  share: { enabled: false },
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

/** The context budget every settings file was saved with before the default grew; nobody chose it. */
const LEGACY_BUDGET = 48_000

/** Bring a saved file forward: values that were only ever the old default follow the new one. */
function migrate(saved: DeepPartial<NovelSettings>): DeepPartial<NovelSettings> {
  const context = saved.context
  if (context === undefined || context === null || context.budgetTokens !== LEGACY_BUDGET) return saved
  const { budgetTokens: _old, ...rest } = context
  return { ...saved, context: rest }
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

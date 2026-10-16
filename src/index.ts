// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * whalesong-studio — Host half, as DSH loads it.
 *
 * This file is only the door (see `host/door.ts`): it puts up the Host half
 * proper, `host.js` beside it — the `novel` service (project store, model
 * routing, pipelines, jobs) and, when the Web transport is present, the routes
 * the Studio talks to — and can put up a newer one in its place while DSH
 * runs. Keep it small: what is in this file changes only when DSH restarts.
 *
 * The agent-facing tools live in the `whalesong-studio/agent` entry, which a
 * preset mounts per session; the browser half is `whalesong-studio/client`.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { openDoor } from './host/door'
import type { NovelServiceConfig } from './host/service'

export const name = 'novel-writer'

/** Services the studio engine cannot work without. */
export const inject = ['llm', 'credentials']

export type Config = NovelServiceConfig

/**
 * `settings` holds deployment defaults in the shape of the Studio's settings
 * (models, context, image, tts, embedding, …); what a user saves in the Studio
 * overlays them. See docs/configuration.md.
 */
export const Config = Schema.object({
  settings: Schema.dict(Schema.any()).default({}),
}) as unknown as Schema<Config>

export function apply(ctx: Context, config: Config): void {
  openDoor(ctx, config, {
    file: new URL('./host.js', import.meta.url),
    inject: [...inject],
    log: (message, error) => {
      const text = `[novel] ${message}${error !== undefined ? `: ${error instanceof Error ? error.stack ?? error.message : String(error)}` : ''}`
      try {
        ctx.logger.warn(text)
      } catch {
        console.warn(text)
      }
    },
  })
}

export type { NovelServiceConfig }

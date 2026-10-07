// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * dsh-novel-writer — Host half.
 *
 * Mounts the `novel` service (project store, model routing, pipelines, jobs)
 * and, when the Web transport is present, the routes the Studio talks to.
 * The agent-facing tools live in the `dsh-novel-writer/agent` entry, which a
 * preset mounts per session; the browser half is `dsh-novel-writer/client`.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mountRoutes } from './host/routes'
import { NovelService, type NovelServiceConfig } from './host/service'

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
  const service = new NovelService(ctx, config)
  // Headless and ACP compositions have no browser transport; the service still serves the agent tools there.
  ctx.inject(['connection'], (inner) => {
    try {
      mountRoutes(inner, service)
    } catch (error) {
      service.log('could not mount the Studio routes', error)
      throw error
    }
  })
}

export { NovelService }
export type { NovelServiceConfig }

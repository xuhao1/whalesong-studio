// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Host half proper: what the door (`door.ts`) puts up, and can put up
 * anew. Everything it registers with DSH it registers on the context it is
 * given, so that taking that context down takes all of it away.
 */
import type { Context } from '@deepseek-ai/cordis'
import { forgetPackageFiles } from '../core/crew'
import type { HostControl } from './door'
import { mountRoutes } from './routes'
import { NovelService, type NovelServiceConfig } from './service'

export function apply(ctx: Context, config: NovelServiceConfig, control?: HostControl): void {
  // What an earlier Host half read from the package — skills, the place itself — may have been replaced since.
  forgetPackageFiles()
  const service = new NovelService(ctx, config, control)
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

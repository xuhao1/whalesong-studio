// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * whalesong-studio/agent — the entry a preset names to give its sessions the
 * novel_* tools, the showrunner instructions and the project digest.
 *
 * It holds none of that itself. A Harness reads this file when the first
 * session that wants it starts — which can be long after it loaded the Host
 * half, and after the plugin was updated on disk in between. Tools from one
 * build calling into a service from another fail in ways nobody can read, so
 * the agent half lives in the Host half (`src/agent/mount.ts`) and this entry
 * only asks the Host half that is running to mount its own.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '../host/service'

export const name = 'novel-writer-agent'

export const inject = ['tools', 'systemPrompt', 'novel']

export function apply(ctx: Context): void {
  const novel = ctx.novel as { mountAgent?: (ctx: Context) => void }
  if (typeof novel.mountAgent === 'function') {
    novel.mountAgent(ctx)
    return
  }
  // A Host half from before it carried the agent half: this session has no tools until DSH is restarted, and its model can at least say so.
  ctx.systemPrompt.context({
    name: 'novel:restart-needed',
    order: 200,
    text: '[Whalesong Studio] The Whalesong Studio plugin was updated on disk while DSH was running, and the part of it that is running is older than the update. The novel_* tools are not available in this conversation until DSH is restarted. Tell the author exactly that — restart DSH, then come back to this conversation — and do not try to work on the book by other means.',
  })
}

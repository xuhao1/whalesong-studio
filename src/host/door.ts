// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The door the Host half comes in by — and can be changed through.
 *
 * DSH loads a plugin's entry once and keeps what it loaded until DSH restarts.
 * A plugin that is updated while DSH runs is therefore half new: its Studio is
 * swapped in the window at once, its Host half stays as it was. The author
 * used to be told to restart DSH.
 *
 * So the entry DSH loads is only this door. The Host half proper — the `novel`
 * service, its pipelines and jobs, the routes the Studio talks to, the agent's
 * tools — is another file beside it, put up from here as a plugin of this one,
 * in Cordis's own terms. Taking it down again and putting up the file that
 * lies there now is then an ordinary unload and load: every route, tool and
 * service it registered goes with it and comes back from the new code, and
 * neither DSH nor its conversations go anywhere.
 *
 * A file loaded twice is loaded under two names: its stamp (when it was
 * written, how large it is) rides on the address it is imported by.
 */
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'

/** What the door hands the Host half it puts up. */
export interface HostControl {
  /** Which door this is. A Host half that needs more of its door than an older one offers can tell. */
  version: number
  /** The stamp of the file this Host half was loaded from. */
  stamp: string
  /** Take this Host half down and put up the one that is on disk now. Rejects — with the running one untouched — when that one cannot be loaded. */
  reload(): Promise<void>
}

/** What a Host half is, as far as its door is concerned. */
export interface HostModule<Config> {
  apply(ctx: Context, config: Config, control: HostControl): void
}

export const DOOR_VERSION = 1

export interface Door {
  /** Settles when the first Host half is up — or could not be loaded, which is logged and thrown here. */
  ready: Promise<void>
  reload(): Promise<void>
}

/**
 * @param file - where the Host half lies.
 * @param inject - the services it cannot work without: the same the door itself waits for.
 * @param log - where a failure is said; a failed load is never thrown into DSH, which would take it for a crash.
 */
export function openDoor<Config>(ctx: Context, config: Config, options: { file: URL; inject: string[]; log: (message: string, error?: unknown) => void }): Door {
  let fiber: Fiber | undefined
  let turning: Promise<void> | undefined
  const stampOf = async (): Promise<string> => {
    const info = await stat(fileURLToPath(options.file))
    return `${Math.round(info.mtimeMs).toString(36)}-${info.size.toString(36)}`
  }
  const load = async (): Promise<{ module: HostModule<Config>; stamp: string }> => {
    const stamp = await stampOf()
    const module = await import(`${options.file.href}?build=${stamp}`) as HostModule<Config>
    if (typeof module.apply !== 'function') throw new Error(`${fileURLToPath(options.file)} is not a Host half: it exports no apply()`)
    return { module, stamp }
  }
  const control = (stamp: string): HostControl => ({ version: DOOR_VERSION, stamp, reload })
  const put = ({ module, stamp }: { module: HostModule<Config>; stamp: string }): void => {
    fiber = ctx.plugin({
      name: 'novel-writer-host',
      inject: options.inject,
      apply: (inner: Context) => { module.apply(inner, config, control(stamp)) },
    })
  }
  function reload(): Promise<void> {
    // One change at a time: a second request while one is under way waits for that one.
    turning ??= (async () => {
      try {
        // The new one first: if it cannot be loaded, the one that runs stays.
        const next = await load()
        await fiber?.dispose()
        fiber = undefined
        put(next)
      } finally {
        turning = undefined
      }
    })()
    return turning
  }
  const ready = load().then(put)
  ready.catch((error: unknown) => { options.log('the Host half could not be loaded', error) })
  return { ready, reload }
}

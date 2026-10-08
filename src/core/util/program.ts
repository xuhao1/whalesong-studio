// SPDX-License-Identifier: LGPL-3.0-or-later
/** The programs of the computer the Studio runs on: where one is, when it is there at all. */
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

const found = new Map<string, Promise<string | undefined>>()

/** Where a program is, by the PATH this process has and the places package managers put things. */
export function findProgram(name: string): Promise<string | undefined> {
  let pending = found.get(name)
  if (pending === undefined) {
    pending = (async () => {
      const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'].filter(dir => dir.length > 0)
      const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
      for (const dir of dirs) {
        for (const file of names) {
          const path = join(dir, file)
          try {
            await access(path, constants.X_OK)
            return path
          } catch {
            // not here
          }
        }
      }
      return undefined
    })()
    found.set(name, pending)
    // A program installed a minute from now should be found then.
    void pending.then((path) => { if (path === undefined) found.delete(name) })
  }
  return pending
}

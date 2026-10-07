// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Taking things away without destroying them. What the author removes goes to
 * the system trash, where they can get it back the way they get anything back;
 * where the trash cannot be reached it goes to a holding folder of the
 * Studio's own, and the author is told where that is. Nothing is ever unlinked.
 */
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { exists } from './fs'

export interface Trashed {
  /** `trash`: the system trash. `holding`: a folder of the Studio's own. `beside`: it could be moved nowhere and still sits next to where it was. */
  where: 'trash' | 'holding' | 'beside'
  /** Where it is now. */
  path: string
}

/** The system trash of this platform, when it is a folder things can simply be moved into. */
export function systemTrash(): { files: string; info?: string } | undefined {
  if (process.platform === 'darwin') return { files: join(homedir(), '.Trash') }
  if (process.platform === 'linux') {
    const data = process.env.XDG_DATA_HOME !== undefined && process.env.XDG_DATA_HOME.length > 0 ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share')
    return { files: join(data, 'Trash', 'files'), info: join(data, 'Trash', 'info') }
  }
  return undefined
}

/** A name nothing in `dir` has yet, starting from `name`. */
async function free(dir: string, name: string): Promise<string> {
  let candidate = join(dir, name)
  for (let n = 2; await exists(candidate).catch(() => false); n++) candidate = join(dir, `${name} ${n}`)
  return candidate
}

/** Move across volumes: copy everything, then take the original away. */
async function carry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Move a folder out of the way, to somewhere it can be brought back from.
 * @param trash - the trash to use (`null`: there is none); the platform's own by default.
 * @param holding - where it goes when the trash cannot take it.
 */
export async function moveToTrash(folder: string, options: { holding: string; trash?: { files: string; info?: string } | null }): Promise<Trashed> {
  const trash = options.trash === undefined ? systemTrash() : options.trash ?? undefined
  const name = basename(folder)
  if (trash !== undefined) {
    try {
      if (trash.info !== undefined) {
        await mkdir(trash.files, { recursive: true })
        await mkdir(trash.info, { recursive: true })
      }
      const target = await free(trash.files, name)
      await carry(folder, target)
      // The freedesktop trash keeps a note of where each thing came from, which is what "restore" reads.
      if (trash.info !== undefined) {
        await writeFile(join(trash.info, `${basename(target)}.trashinfo`), `[Trash Info]\nPath=${encodeURI(folder)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`).catch(() => {})
      }
      return { where: 'trash', path: target }
    } catch {
      // The trash would not take it (no permission, no such folder): the holding folder will.
    }
  }
  try {
    await mkdir(options.holding, { recursive: true })
    const target = await free(options.holding, name)
    await carry(folder, target)
    return { where: 'holding', path: target }
  } catch {
    return { where: 'beside', path: folder }
  }
}

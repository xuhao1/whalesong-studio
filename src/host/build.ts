// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Which build of the plugin this Host half is, and which one lies beside it on
 * disk now. A Harness swaps the Studio in an open window when its bundle is
 * replaced; the Host half runs on as it was put up. In between the Studio is
 * newer than its Host — and has to know, to say so and to offer the change.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findPackageRoot } from '../core/crew'

interface BuildNote {
  id?: string
}

async function read(): Promise<string | undefined> {
  const root = await findPackageRoot()
  if (root === undefined) return undefined
  try {
    const note = JSON.parse(await readFile(join(root, 'lib', 'build.json'), 'utf8')) as BuildNote
    return typeof note.id === 'string' && note.id.length > 0 ? note.id : undefined
  } catch {
    // A build from before builds were named, or a copy that never had the note.
    return undefined
  }
}

export interface BuildState {
  running?: string
  installed?: string
  /** The files were replaced by another build since this Host half was put up. */
  stale: boolean
}

/**
 * One per Host half, made as it is put up — not a value of this module: code
 * that is the same in two builds is loaded once, and a note kept here would go
 * on naming the first of them after the second took its place.
 */
export class BuildWatch {
  /** Read as this Host half is put up: the build that runs. */
  private readonly running = read()

  async state(): Promise<BuildState> {
    const [mine, installed] = await Promise.all([this.running, read()])
    return {
      ...(mine !== undefined ? { running: mine } : {}),
      ...(installed !== undefined ? { installed } : {}),
      // A copy without a note says nothing either way.
      stale: mine !== undefined && installed !== undefined && mine !== installed,
    }
  }
}

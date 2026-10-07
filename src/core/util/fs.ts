// SPDX-License-Identifier: LGPL-3.0-or-later
/** Small filesystem helpers: atomic writes, tolerant reads, contained paths. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** Write through a sibling temp file and rename, so readers never see a torn file. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path))
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, data)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readText(path)
  if (text === undefined || text.trim().length === 0) return undefined
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** Modification time in milliseconds, or 0 when the path is absent. */
export async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
}

/** Names of the entries in a directory, or an empty list when it is absent. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Resolve a project-relative path and refuse anything that escapes the root.
 * @throws when the result would leave `root`.
 */
export function containedPath(root: string, path: string): string {
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, target)
  if (rel === '' ) return target
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes the project: ${path}`)
  return target
}

/** Project-relative POSIX path for storage and URLs. */
export function relativePosix(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

/** A path a person can find a folder by: relative inside the workspace (`.` for the workspace itself), absolute outside it. */
export function displayPath(workspace: string, root: string): string {
  const inside = relative(workspace, root)
  return inside.length === 0 ? '.' : inside.startsWith('..') || isAbsolute(inside) ? root : inside
}

export function sha1(data: string | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex')
}

export { join as joinPath }

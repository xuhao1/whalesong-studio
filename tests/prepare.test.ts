// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const made: string[] = []

/**
 * A checkout of its own: the real `prepare`, beside a build that only says it ran.
 * (The script works out where it is from its own path, so the copy never looks at this checkout's `lib/`.)
 */
function checkout(built: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'novel-prepare-'))
  made.push(dir)
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(here('../scripts/prepare.mjs'), join(dir, 'scripts', 'prepare.mjs'))
  writeFileSync(join(dir, 'scripts', 'build.mjs'), [
    `import { mkdirSync, writeFileSync } from 'node:fs'`,
    `mkdirSync('lib', { recursive: true })`,
    `writeFileSync('lib/build.json', JSON.stringify({ id: 'built-just-now', args: process.argv.slice(2) }))`,
  ].join('\n'))
  if (built) {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'lib', 'build.json'), JSON.stringify({ id: 'the-release' }))
  }
  return dir
}

const prepare = (dir: string) => spawnSync(process.execPath, [join(dir, 'scripts', 'prepare.mjs')], { cwd: dir, encoding: 'utf8' })
const build = (dir: string) => JSON.parse(readFileSync(join(dir, 'lib', 'build.json'), 'utf8')) as { id: string; args?: string[] }

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

describe('what npm runs on install, pack and publish', () => {
  it('is the script that looks before it builds', () => {
    const pkg = JSON.parse(readFileSync(here('../package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.prepare).toBe('node scripts/prepare.mjs')
    // The lifecycle scripts npm would run around it: none that could build in its place.
    for (const name of ['prepack', 'postpack', 'prepublishOnly', 'prepublish', 'preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts[name], name).toBeUndefined()
    }
  })

  it('leaves a build that is there alone', () => {
    const dir = checkout(true)
    const ran = prepare(dir)
    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('left as it is')
    expect(build(dir)).toEqual({ id: 'the-release' })
  })

  it('makes one where there is none — a release build, into lib/', () => {
    const dir = checkout(false)
    const ran = prepare(dir)
    expect(ran.status).toBe(0)
    expect(build(dir)).toEqual({ id: 'built-just-now', args: [] })
  })

  it('fails when the build fails', () => {
    const dir = checkout(false)
    writeFileSync(join(dir, 'scripts', 'build.mjs'), `process.exit(3)`)
    expect(prepare(dir).status).toBe(3)
  })
})

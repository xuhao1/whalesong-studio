#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What npm runs by itself on `npm install`, `npm pack` and `npm publish`.
 *
 * A checkout with no build needs one — `lib/` is not in the repository, and a
 * fresh clone has to run. A checkout that has a build is left alone: `lib/` is
 * what an installed copy runs, also a copy that is running right now when a
 * profile links this checkout, and only a release (`npm run release`) replaces
 * it. While `prepare` was the build itself, any of those three commands put the
 * working tree, half-finished or not, into the Studio its author was using:
 * listing the package's files with `npm pack --dry-run` did so on 2026-10-13.
 *
 *   lib/build.json is there (the file a build writes last)  -> nothing is done
 *   it is not                                               -> a build is made
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (existsSync(resolve(root, 'lib', 'build.json'))) {
  console.log('prepare: lib/ holds a build and is left as it is — `npm run release` is what replaces it')
} else {
  const built = spawnSync(process.execPath, [resolve(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' })
  process.exit(built.status ?? 1)
}

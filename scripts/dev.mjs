#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Development launcher: boots DeepSeek Harness Web with this checkout mounted
 * as a bundle, inside an isolated Harness home so nothing touches `~/.dsh`.
 *
 * What it mounts is the stage (`.dev/stage`): the package with a `lib/` of its
 * own, built by `npm run check` or `node scripts/build.mjs --stage`. The
 * checkout's own `lib/` is the released build — a profile that links this
 * checkout may be running it — and is left alone.
 *
 *   npm run dev                         # http://127.0.0.1:3199
 *   npm run dev -- --port 4000          # another port
 *   npm run dev -- --workspace ~/novel  # serve a specific workspace directory
 *   npm run dev -- --home ~/.dsh        # use your real Harness home (shares models/credentials)
 *
 * The isolated home lives in `.dev/home`. Configure model routes for it in
 * `.dev/home/profiles/web/cordis.patch.yml` (see CONTRIBUTING.md), or pass
 * `--home` to reuse a home that already has them.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0 || index + 1 >= process.argv.length) return fallback
  return process.argv[index + 1]
}
const expand = path => (path.startsWith('~') ? resolve(homedir(), path.slice(2)) : resolve(path))

const home = expand(option('home', resolve(root, '.dev/home')))
const workspace = expand(option('workspace', resolve(root, '.dev/workspace')))
const port = option('port', '3199')
const profile = option('profile', 'web')
const dsh = resolve(root, 'node_modules/.bin/dsh')

if (!existsSync(dsh)) {
  console.error('[dev] node_modules/.bin/dsh is missing — run `npm install` first.')
  process.exit(1)
}
const stage = resolve(root, '.dev/stage')
if (!existsSync(resolve(stage, 'lib/index.js'))) {
  console.log('[dev] the stage is not built yet — building once…')
  const built = spawnSync(process.execPath, [resolve(root, 'scripts/build.mjs'), '--stage'], { stdio: 'inherit' })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
const env = { ...process.env, DSH_HOME: home }
const profileDir = resolve(home, 'profiles', profile)

// Let the launcher initialize the shipped profile template before we touch its manifest.
if (!existsSync(resolve(profileDir, 'package.json'))) {
  const init = spawnSync(dsh, [profile, '--dump-config'], { env, cwd: workspace, encoding: 'utf8' })
  if (init.status !== 0) {
    console.error(init.stderr)
    process.exit(init.status ?? 1)
  }
}

// Mirror what `dsh plugin add <checkout>` records: a linked dependency plus a bundle entry.
const manifestPath = resolve(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = { ...manifest.dependencies, [pkg.name]: `link:${stage}` }
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(pkg.name)) bundles.push(pkg.name)
manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const link = resolve(profileDir, 'node_modules', pkg.name)
mkdirSync(dirname(link), { recursive: true })
let linked
try {
  linked = readlinkSync(link)
} catch { /* absent, or not a link */ }
if (linked !== stage) {
  rmSync(link, { recursive: true, force: true })
  symlinkSync(stage, link, 'dir')
}

console.log(`[dev] home      ${home}`)
console.log(`[dev] profile   ${profile}`)
console.log(`[dev] workspace ${workspace}`)
const child = spawn(dsh, [profile, '--no-open', '--port', port], { env, cwd: workspace, stdio: 'inherit' })
const forward = signal => { if (!child.killed) child.kill(signal) }
process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))
child.on('exit', (code, signal) => { process.exit(code ?? (signal ? 1 : 0)) })

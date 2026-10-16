#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Push `main` to GitHub, with the version tags of its releases: the step that
 * follows a release and its commit.
 *
 * Nobody looks a push over once it happens by itself, so it looks itself over
 * first. It only ever moves `origin/main` forward — never a force, never
 * another branch — and it sends nothing that reads like a credential, nothing
 * that is one of the credentials this machine holds for development, and no
 * file from a place that is not the repository's to carry. What it finds it
 * names by commit and file; the text itself is never printed.
 *
 * A version tag (`v1.2.3`) goes along once it points at a commit `main` has;
 * one the remote has already stays where it is there — a tag of the same name
 * on another commit stops the push, it is never moved.
 *
 *   npm run push             # look over what would go out, then push it
 *   npm run push -- --dry    # look it over only
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What a credential looks like, whoever issued it. */
const SHAPES = [
  ['an API key (sk-…)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['a signed token (JWT)', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ['a bearer token', /\bBearer [A-Za-z0-9._-]{24,}/],
]

/** A version tag: `v` and a semantic version. */
const VERSION_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Where nothing the repository carries may come from. */
const NOT_OURS = [/^\.dev\//, /^lib\//, /^node_modules\//, /^\.claude\//, /(^|\/)\.credentials/, /(^|\/)\.env(\.|$)/]

/**
 * The lines a run of commits adds, each with the commit and the file it is in.
 * @param log - `git log -p --format=commit:%H` of the commits.
 */
export function addedLines(log) {
  const lines = []
  let commit = ''
  let file = ''
  for (const line of log.split('\n')) {
    if (line.startsWith('commit:')) commit = line.slice(7, 14)
    else if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '')
    else if (line.startsWith('+') && !line.startsWith('+++')) lines.push({ commit, file, text: line.slice(1) })
  }
  return lines
}

/** What among the added lines reads like a credential: by what it looks like, in which commit and file — not the text. */
export function keyShaped(lines) {
  const found = []
  for (const line of lines) {
    for (const [what, shape] of SHAPES) if (shape.test(line.text)) found.push({ what, commit: line.commit, file: line.file })
  }
  return found
}

/** Which of the credentials held here are among the added lines: by the name they are held under — not the value. */
export function heldIn(lines, held) {
  const found = []
  for (const secret of held) {
    const line = lines.find(candidate => candidate.text.includes(secret.value))
    if (line !== undefined) found.push({ what: secret.name, commit: line.commit, file: line.file })
  }
  return found
}

/**
 * The credentials this machine holds for development: what the environment names as one, what the dev home's
 * credential store keeps, and the tokens the dev instance has printed into its log.
 */
export function heldHere(env, read) {
  const held = []
  const keep = (name, value) => { if (typeof value === 'string' && value.trim().length >= 16) held.push({ name, value: value.trim() }) }
  for (const [name, value] of Object.entries(env)) if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|QWEN_DSH/i.test(name)) keep(`$${name}`, value)
  for (const line of (read('.dev/home/.credentials.yaml') ?? '').split('\n')) {
    const entry = /^\s*([\w.-]+)\s*:\s*["']?([^"'\s#]+)["']?\s*$/.exec(line)
    if (entry !== null) keep(`the dev credential "${entry[1]}"`, entry[2])
  }
  for (const token of new Set((read('.dev/logs/web.log') ?? '').match(/token=([A-Za-z0-9._-]{16,})/g) ?? [])) keep('the dev instance\'s token', token.slice(6))
  return held
}

/**
 * Which version tags go out: those here that point at a commit `main` has and that the remote has not got yet.
 * @param here - this checkout's tags: name → the commit each points at
 * @param there - the remote's tags: name → the commit each points at
 * @param onMain - whether a commit is on `main` as it stands on the remote
 * @returns the tags to push; those the remote has on another commit (never moved); those on no commit of `main`
 */
export function tagsToPush(here, there, onMain) {
  const push = []
  const clash = []
  const off = []
  for (const [name, commit] of here) {
    if (!VERSION_TAG.test(name)) continue
    const remote = there.get(name)
    if (remote === commit) continue
    if (remote !== undefined) clash.push(name)
    else if (onMain(commit)) push.push(name)
    else off.push(name)
  }
  return { push, clash, off }
}

/** Tags by the commit they point at, from `git ls-remote --tags` (an annotated tag's `^{}` line is its commit). */
export function remoteTags(listing) {
  const tags = new Map()
  for (const line of listing.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (sha === undefined || ref === undefined || !ref.startsWith('refs/tags/')) continue
    const peeled = ref.endsWith('^{}')
    const name = ref.slice('refs/tags/'.length, peeled ? -3 : undefined)
    if (peeled || !tags.has(name)) tags.set(name, sha)
  }
  return tags
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
}

function refuse(message) {
  console.error(`[push] not pushed — ${message}`)
  process.exit(1)
}

function main() {
  const dry = process.argv.includes('--dry')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
  if (branch !== 'main') refuse(`this checkout is on "${branch}"; releases are pushed from main`)
  git('fetch', 'origin', 'main')
  try {
    git('merge-base', '--is-ancestor', 'origin/main', 'HEAD')
  } catch {
    refuse('origin/main has commits this checkout does not: it would not be a fast-forward. Bring them in first (git pull --rebase); nothing is ever forced')
  }
  const commits = git('log', '--oneline', 'origin/main..HEAD').trim().split('\n').filter(line => line.length > 0)
  if (commits.length === 0) {
    console.log('[push] origin/main already has every commit')
    pushTags(dry)
    return
  }
  console.log(`[push] ${commits.length} commit(s) to go out:`)
  for (const commit of commits) console.log(`         ${commit}`)

  const files = git('diff', '--name-only', 'origin/main..HEAD').trim().split('\n').filter(line => line.length > 0)
  const stray = files.filter(file => NOT_OURS.some(place => place.test(file)))
  if (stray.length > 0) refuse(`these are not the repository's to carry: ${stray.slice(0, 8).join(', ')}`)

  const lines = addedLines(git('log', '-p', '--no-color', '--format=commit:%H', 'origin/main..HEAD'))
  const read = (path) => (existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : undefined)
  const held = heldHere(process.env, read)
  const found = [...keyShaped(lines), ...heldIn(lines, held)]
  if (found.length > 0) {
    for (const item of found.slice(0, 20)) console.error(`[push]   ${item.what} — commit ${item.commit}, ${item.file}`)
    refuse(`${found.length} line(s) read like a credential. Take them out of the commits (the history, not only the files) before anything goes out`)
  }
  console.log(`[push] looked over ${lines.length} added line(s) in ${files.length} file(s): nothing that reads like a credential, none of the ${held.length} held here`)
  if (dry) {
    console.log('[push] --dry: nothing was pushed')
    pushTags(dry)
    return
  }
  git('push', 'origin', 'HEAD:main')
  const there = git('ls-remote', 'origin', 'refs/heads/main').slice(0, 40)
  const here = git('rev-parse', 'HEAD').trim()
  if (there !== here) refuse(`the push went through, but origin/main reads ${there.slice(0, 7)} and this checkout ${here.slice(0, 7)}`)
  console.log(`[push] origin/main is at ${here.slice(0, 7)}`)
  pushTags(dry)
}

/** The version tags that go along with `main`: pushed one by one, never forced. */
function pushTags(dry) {
  const main = git('ls-remote', 'origin', 'refs/heads/main').slice(0, 40)
  const here = new Map()
  for (const line of git('for-each-ref', '--format=%(refname:short) %(objectname) %(*objectname)', 'refs/tags').trim().split('\n')) {
    const [name, object, peeled] = line.trim().split(/\s+/)
    if (name !== undefined && object !== undefined) here.set(name, peeled !== undefined && peeled.length > 0 ? peeled : object)
  }
  const onMain = (commit) => {
    try {
      git('merge-base', '--is-ancestor', commit, main)
      return true
    } catch {
      return false
    }
  }
  const { push, clash, off } = tagsToPush(here, remoteTags(git('ls-remote', '--tags', 'origin')), onMain)
  for (const name of off) console.log(`[push] tag ${name} is on no commit of main as pushed: it stays here`)
  if (clash.length > 0) refuse(`the remote has ${clash.join(', ')} on another commit; a version tag is never moved`)
  if (push.length === 0) return
  const said = push.flatMap(name => keyShaped([{ commit: name, file: 'tag message', text: git('tag', '-l', '--format=%(contents)', name) }]))
  if (said.length > 0) refuse(`the message of ${said.map(item => item.commit).join(', ')} reads like a credential`)
  if (dry) {
    console.log(`[push] --dry: would push ${push.join(', ')}`)
    return
  }
  for (const name of push) git('push', 'origin', `refs/tags/${name}:refs/tags/${name}`)
  const after = remoteTags(git('ls-remote', '--tags', 'origin'))
  const missing = push.filter(name => after.get(name) !== here.get(name))
  if (missing.length > 0) refuse(`the push went through, but the remote does not show ${missing.join(', ')} where they are here`)
  console.log(`[push] tag(s) ${push.join(', ')} pushed`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * No rule of the Studio's or the reader's stylesheets colours with a variable nobody defines.
 *
 * `var(--nv-accent)` with no `--nv-accent` anywhere is not an error to a browser:
 * the declaration is dropped when it is computed, and the thing it was to mark —
 * the chosen chip, the ticked row — shows nothing. It builds, and nothing says so
 * until somebody looks at that one control and wonders why it never lights. So
 * the sheets are read here: a variable used without a fallback has to be set
 * somewhere, in a sheet or from the code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function files(dir: string, match: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path, match)
    return match.test(name) ? [path] : []
  })
}

/** The custom properties a text sets: `--nv-x: …` in a sheet, `'--nv-x': …` in a style object, `setProperty('--nv-x', …)`. */
function defined(text: string): string[] {
  return [
    ...[...text.matchAll(/(--nv-[a-z0-9-]+)\s*['"]?\s*:/g)].map(match => match[1]!),
    ...[...text.matchAll(/setProperty\(\s*['"](--nv-[a-z0-9-]+)/g)].map(match => match[1]!),
  ]
}

/** The custom properties a sheet reads with nothing to fall back on, each with the line it is read on. */
function bare(text: string): { name: string; line: number }[] {
  return [...text.matchAll(/var\(\s*(--nv-[a-z0-9-]+)\s*\)/g)].map(match => ({ name: match[1]!, line: text.slice(0, match.index).split('\n').length }))
}

describe('the stylesheets', () => {
  it('tells a variable that is set from one that is not', () => {
    const sheet = ':root { --nv-brand: #4d6bfe; }\n.a { color: var(--nv-brand); }\n.b { color: var(--nv-accent); }\n.c { color: var(--nv-accent-contrast, #fff); }'
    const known = new Set(defined(sheet))
    expect(bare(sheet).filter(use => !known.has(use.name))).toEqual([{ name: '--nv-accent', line: 3 }])
  })

  it('read no variable that nothing sets', () => {
    const sheets = files(join(ROOT, 'src'), /\.css$/)
    const sources = files(join(ROOT, 'src'), /\.tsx?$/)
    const known = new Set([...sheets, ...sources].flatMap(path => defined(readFileSync(path, 'utf8'))))
    const lost = sheets.flatMap(path => bare(readFileSync(path, 'utf8')).filter(use => !known.has(use.name)).map(use => `${relative(ROOT, path)}:${use.line} ${use.name}`))
    expect(sheets.length).toBeGreaterThan(0)
    expect(lost).toEqual([])
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A call's parameters reach the work they are for.
 *
 * The table of calls (`src/shared/rpc.ts`) says what each call takes; the Host
 * (`src/host/rpc.ts`) picks them out of what the page sent, by name. One left
 * out there is not an error anywhere: the types still hold, the pipeline's own
 * tests pass, and the page sends something the Host drops — "compare this
 * picture" arrived as "redraw this picture, with nothing said". So the two are
 * read side by side here: a handler that picks its parameters out by name
 * names every one the table has for it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

/** What each call takes, by name, as the table writes it. */
function tabled(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const found of source.matchAll(/^ {2}'([a-zA-Z]+\.[a-zA-Z.]+)': \{ params: /gm)) {
    const start = found.index + found[0].length
    // Parameters given as a named type are not read here.
    if (source[start] !== '{') continue
    let depth = 0
    let end = start
    for (; end < source.length; end++) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}' && --depth === 0) break
    }
    const body = source.slice(start + 1, end).replace(/\/\*\*[\s\S]*?\*\//g, '')
    const names: string[] = []
    let nested = 0
    let part = ''
    const close = (): void => {
      const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(part)?.[1]
      if (name !== undefined) names.push(name)
      part = ''
    }
    for (const char of body) {
      if ('{[(<'.includes(char)) nested += 1
      else if ('}])>'.includes(char)) nested -= 1
      if ((char === ';' || char === ',') && nested === 0) close()
      else part += char
    }
    close()
    out.set(found[1]!, names)
  }
  return out
}

/** What each handler picks out by name; one that takes the rest (`...params`) or the whole of it is left out. */
function picked(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const found of source.matchAll(/^ {4}'([a-zA-Z]+\.[a-zA-Z.]+)': async \(\{([^)]*)\}\) =>/gm)) {
    if (found[2]!.includes('...')) continue
    out.set(found[1]!, new Set(found[2]!.split(',').map(part => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1]).filter((name): name is string => name !== undefined)))
  }
  return out
}

describe('the Host takes what a call is given', () => {
  it('reads the table and the handlers', async () => {
    const table = tabled(await readFile(join(ROOT, 'src/shared/rpc.ts'), 'utf8'))
    const handlers = picked(await readFile(join(ROOT, 'src/host/rpc.ts'), 'utf8'))
    // Enough of both is read for the comparison to mean something.
    expect(table.size).toBeGreaterThan(150)
    expect(handlers.size).toBeGreaterThan(140)
    expect(table.get('image.redraw')).toEqual(['root', 'picture', 'subject', 'change', 'prompt', 'avoid', 'references', 'trials'])
  })

  it('names in each handler every parameter the table has for the call', async () => {
    const table = tabled(await readFile(join(ROOT, 'src/shared/rpc.ts'), 'utf8'))
    const handlers = picked(await readFile(join(ROOT, 'src/host/rpc.ts'), 'utf8'))
    const dropped: string[] = []
    for (const [call, names] of handlers) {
      const lacking = (table.get(call) ?? []).filter(name => !names.has(name))
      if (lacking.length > 0) dropped.push(`${call}: ${lacking.join(', ')}`)
    }
    expect(dropped).toEqual([])
  })

  it('would have caught a comparison whose services never reached the redraw', () => {
    const table = tabled('  \'image.redraw\': { params: { root: string; picture: string; subject?: string; /** Several. */ trials?: { label: string; image: object }[] }; result: JobStarted }\n')
    const handlers = picked('    \'image.redraw\': async ({ root, picture, subject }) => {\n')
    expect((table.get('image.redraw') ?? []).filter(name => !handlers.get('image.redraw')!.has(name))).toEqual(['trials'])
  })
})

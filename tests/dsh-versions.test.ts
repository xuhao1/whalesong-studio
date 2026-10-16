// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/** The `{{variable}}`s a prompt template of the bundle names. */
function variablesIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const match of value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.add(match[1]!)
  else if (Array.isArray(value)) for (const item of value) variablesIn(item, found)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) variablesIn(item, found)
  return found
}

describe('the bundle on DSH 0.2.0 and 0.2.1', () => {
  it('names no prompt variable that DSH 0.2.1 lacks', async () => {
    // DSH 0.2.1 took `{{cwd}}` away (a session's directory is its working-directory service's to say): a prompt that
    // still names it fails every turn before the request. `{{provider}}` and `{{model}}` are in both.
    const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as unknown
    expect([...variablesIn(patch)].filter(name => name !== 'provider' && name !== 'model')).toEqual([])
  })
})

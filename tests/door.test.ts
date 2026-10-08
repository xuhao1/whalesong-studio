// SPDX-License-Identifier: LGPL-3.0-or-later
/** The door the Host half comes in by: put up from a file, and replaced by the file that lies there later — DSH staying up. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOOR_VERSION, openDoor } from '../src/host/door'

/** A Host half that says when it goes up and when it comes down, and provides a service others may wait for. */
const half = (version: number): string => `
export function apply(ctx, config, control) {
  const seen = globalThis.__novelDoorTest
  seen.push(['up', ${version}, config.tag, control.version, typeof control.reload])
  ctx.effect(() => () => { seen.push(['down', ${version}]) })
}
// ${'padding '.repeat(version)}
`

describe('the door of the Host half', () => {
  let dir: string
  let ctx: Context
  let seen: unknown[][]
  const said: string[] = []
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'novel-door-'))
    seen = []
    said.length = 0
    ;(globalThis as { __novelDoorTest?: unknown[][] }).__novelDoorTest = seen
    ctx = new Context()
  })
  afterEach(async () => {
    await ctx.fiber.dispose().catch(() => {})
    await rm(dir, { recursive: true, force: true })
    delete (globalThis as { __novelDoorTest?: unknown[][] }).__novelDoorTest
  })

  it('puts up the half that lies there, then the newer one in its place — and keeps the one that runs when the new one is no good', async () => {
    const file = join(dir, 'host.mjs')
    await writeFile(file, half(1))
    const door = openDoor(ctx, { tag: 'book' }, { file: pathToFileURL(file), inject: [], log: (message) => { said.push(message) } })
    await door.ready
    expect(seen).toEqual([['up', 1, 'book', DOOR_VERSION, 'function']])

    // A newer build is put in its place on disk; the one that runs is taken down, the new one put up.
    await writeFile(file, half(2))
    await door.reload()
    expect(seen).toEqual([['up', 1, 'book', DOOR_VERSION, 'function'], ['down', 1], ['up', 2, 'book', DOOR_VERSION, 'function']])

    // Two requests at once are one change.
    await writeFile(file, half(3))
    await Promise.all([door.reload(), door.reload()])
    expect(seen.slice(3)).toEqual([['down', 2], ['up', 3, 'book', DOOR_VERSION, 'function']])

    // What lies there now is not a Host half: the one that runs stays up, and the request says why.
    await writeFile(file, 'export const nothing = true\n')
    await expect(door.reload()).rejects.toThrow(/not a Host half/)
    expect(seen).toHaveLength(5)
    // …and a good one after it goes up as before.
    await writeFile(file, half(4))
    await door.reload()
    expect(seen.slice(5)).toEqual([['down', 3], ['up', 4, 'book', DOOR_VERSION, 'function']])
    expect(said).toEqual([])
  })

  it('says so, and throws nothing into DSH, when there is no Host half to put up', async () => {
    const door = openDoor(ctx, {}, { file: pathToFileURL(join(dir, 'missing.mjs')), inject: [], log: (message) => { said.push(message) } })
    await expect(door.ready).rejects.toThrow()
    expect(said).toEqual(['the Host half could not be loaded'])
    expect(seen).toEqual([])
  })
})

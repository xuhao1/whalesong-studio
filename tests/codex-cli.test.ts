// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures through the Codex CLI. A run that ends without a picture says why
 * in the agent's own words — one picture not drawn says nothing of the plan.
 * The CLI is stood in for by a script of the same name on `PATH` that speaks
 * the CLI's `--json` events and files (or does not file) a picture under
 * `$CODEX_HOME/generated_images/<thread>`.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCodexBridge, noImage } from '../src/host/codex'
import { PIXEL } from './support/harness'

describe('what a run without a picture says', () => {
  it('passes on what the agent said', () => {
    expect(noImage('I can’t help create that image.').message).toBe('Codex drew no picture this time; it said: “I can’t help create that image.”')
  })
  it('does not blame the plan for a run that said it was done', () => {
    expect(noImage('DONE').message).toBe('Codex said it was done, but no picture was filed under its home')
  })
  it('names the plan only when nothing was said', () => {
    expect(noImage('  ').message).toMatch(/said nothing of why — if none has ever come of it, the ChatGPT plan may not include image generation/)
  })
  it('keeps a long reply short', () => {
    expect(noImage('x'.repeat(500)).message).toContain(`${'x'.repeat(300)}…”`)
  })
})

describe('the CLI bridge', () => {
  let dir: string
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, FAKE_SAY: process.env.FAKE_SAY, FAKE_DRAW: process.env.FAKE_DRAW }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-cli-test-'))
    await mkdir(join(dir, 'bin'))
    await mkdir(join(dir, 'home'))
    await writeFile(join(dir, 'pixel.png'), PIXEL)
    const script = `#!/usr/bin/env node
const { mkdirSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')
process.stdin.resume()
process.stdin.on('end', () => {
  const id = 'thread-' + process.pid
  console.log('Reading prompt from stdin...')
  console.log(JSON.stringify({ type: 'thread.started', thread_id: id }))
  if (process.env.FAKE_DRAW === '1') {
    const out = join(process.env.CODEX_HOME, 'generated_images', id)
    mkdirSync(out, { recursive: true })
    copyFileSync(${JSON.stringify(join(dir, 'pixel.png'))}, join(out, 'ig_1.png'))
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: process.env.FAKE_SAY } }))
  console.log(JSON.stringify({ type: 'turn.completed' }))
})
`
    await writeFile(join(dir, 'bin', 'codex'), script)
    await chmod(join(dir, 'bin', 'codex'), 0o755)
    process.env.PATH = `${join(dir, 'bin')}${delimiter}${saved.PATH ?? ''}`
    process.env.CODEX_HOME = join(dir, 'home')
  })

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  const bridge = createCodexBridge({} as Context)

  it('says what Codex said when it drew nothing', async () => {
    process.env.FAKE_DRAW = '0'
    process.env.FAKE_SAY = 'I can’t create that image because it shows a real person.'
    await expect(bridge('a portrait', { bridge: 'cli' })).rejects.toThrow('Codex drew no picture this time; it said: “I can’t create that image because it shows a real person.”')
  })

  it('hands back the picture it filed', async () => {
    process.env.FAKE_DRAW = '1'
    process.env.FAKE_SAY = 'DONE'
    const drawn = await bridge('a portrait', { bridge: 'cli' })
    expect(drawn.mime).toBe('image/png')
    expect(Buffer.from(drawn.data).equals(Buffer.from(PIXEL))).toBe(true)
  })
})

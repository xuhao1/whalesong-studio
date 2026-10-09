// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

interface Line { commit: string; file: string; text: string }
interface Found { what: string; commit: string; file: string }
interface Push {
  addedLines: (log: string) => Line[]
  keyShaped: (lines: Line[]) => Found[]
  heldIn: (lines: Line[], held: { name: string; value: string }[]) => Found[]
  heldHere: (env: Record<string, string | undefined>, read: (path: string) => string | undefined) => { name: string; value: string }[]
}

// (A script, not a module of the plugin: loaded by where it is.)
const push = await import(new URL('../scripts/push.mjs', import.meta.url).href) as Push

// Put together here so that this file itself holds nothing that reads like a credential.
const apiKey = `sk-${'a1B2'.repeat(6)}`
const held = `${'q7'.repeat(12)}-held`

describe('the push that follows a release', () => {
  const log = [
    'commit:1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1,2 @@',
    ' const kept = 1',
    `+const key = '${apiKey}'`,
    '-const gone = "removed lines are not what goes out"',
    'commit:2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '+++ b/docs/notes.md',
    `+the token is ${held}`,
    '+an ordinary sentence about keys, tokens and the word Bearer',
  ].join('\n')

  it('reads the lines a run of commits adds, each with its commit and file', () => {
    const lines = push.addedLines(log)
    expect(lines.map(line => [line.commit, line.file])).toEqual([['1111111', 'src/a.ts'], ['2222222', 'docs/notes.md'], ['2222222', 'docs/notes.md']])
  })

  it('names what reads like a credential by commit and file, never by its text', () => {
    const found = push.keyShaped(push.addedLines(log))
    expect(found).toEqual([{ what: 'an API key (sk-…)', commit: '1111111', file: 'src/a.ts' }])
    expect(JSON.stringify(found)).not.toContain(apiKey)
    // A key that was added and taken out again later is still in the history that goes out: every commit is read.
    expect(push.keyShaped(push.addedLines(`commit:3333333\n+++ b/x\n+${`ghp_${'Z9'.repeat(18)}`}\ncommit:4444444\n+++ b/x\n-gone`))).toHaveLength(1)
  })

  it('finds a credential held on this machine by its value, and says only the name it is held under', () => {
    const here = push.heldHere(
      { QWEN_DSH_NOVEL: held, SOME_API_KEY: 'short', HOME: '/Users/somebody/a-long-path-that-is-no-secret', OPENROUTER_API_KEY: undefined },
      path => (path === '.dev/home/.credentials.yaml' ? `QWEN_TOKEN_PLAN_CN_API_KEY: "${'m3'.repeat(10)}"\n# a comment\nempty:\n` : path === '.dev/logs/web.log' ? `open http://127.0.0.1:3199/?token=${'t0k'.repeat(8)} to begin` : undefined),
    )
    // Only what is named as a credential, and long enough to be one.
    expect(here.map(secret => secret.name)).toEqual(['$QWEN_DSH_NOVEL', 'the dev credential "QWEN_TOKEN_PLAN_CN_API_KEY"', 'the dev instance\'s token'])
    const found = push.heldIn(push.addedLines(log), here)
    expect(found).toEqual([{ what: '$QWEN_DSH_NOVEL', commit: '2222222', file: 'docs/notes.md' }])
    expect(JSON.stringify(found)).not.toContain(held)
    expect(push.heldIn(push.addedLines('commit:5555555\n+++ b/a\n+nothing of the kind'), here)).toEqual([])
  })
})

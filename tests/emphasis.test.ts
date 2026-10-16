// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Emphasis in the reader. Found publishing *Alice*: Project Gutenberg's text
 * marks italics `_like this_`, and the reader showed the underscores.
 */
import { describe, expect, it } from 'vitest'
import { EMPHASIS } from '../src/shared/text'

const found = (text: string): string[] => [...text.matchAll(EMPHASIS)].map(match => (match[1] !== undefined ? `strong:${match[1]}` : `em:${match[3]}`))

describe('Markdown emphasis in prose', () => {
  it('sets off what the book marks', () => {
    expect(found('“Who are _you?_” said the Caterpillar.')).toEqual(['em:you?'])
    expect(found('“I—I hardly know, sir, just at present—at least I know who I _was_ when I got up this morning.')).toEqual(['em:was'])
    expect(found('She *did* say it, and **loudly**.')).toEqual(['em:did', 'strong:loudly'])
    expect(found('_Off with her head!_ the Queen shouted.')).toEqual(['em:Off with her head!'])
  })

  it('leaves alone what only looks like it', () => {
    expect(found('a file called snake_case_name.txt')).toEqual([])
    expect(found('2*3*4 is twenty-four')).toEqual([])
    expect(found('a lone _ underscore and a lone * star')).toEqual([])
    expect(found('宝玉笑道：“这个妹妹我曾见过的。”')).toEqual([])
  })
})

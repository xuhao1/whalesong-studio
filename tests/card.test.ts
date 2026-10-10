// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { detailsOf, foldDetails } from '../src/shared/card'
import type { CharacterCard } from '../src/shared/types'

describe('a card kept short', () => {
  it('writes the finer points into what the card keeps, and hands them back empty', () => {
    const card = {
      personality: '敏而多思',
      background: '姑苏林家的独女',
      voice: '话里带刺',
      flaw: '多疑',
      abilities: '诗才',
      secrets: '还泪而来',
      persona: { traits: [{ name: '敏感', level: 5 }, { name: '孤高', level: 4 }], values: ['真情'], speech: ['好用反语'], taboos: ['不肯低头'], underPressure: '以泪洗面' },
    }
    expect(detailsOf(card)).toEqual(['flaw', 'abilities', 'secrets', 'traits', 'values', 'speech', 'taboos', 'underPressure'])
    const folded = foldDetails(card, true)
    // Nothing said of them is dropped: it is said in three places instead of eleven.
    expect(folded.personality).toBe('敏而多思\n特质：敏感、孤高\n看重：真情\n绝不会：不肯低头\n压力之下：以泪洗面\n弱点：多疑')
    expect(folded.background).toBe('姑苏林家的独女\n能力：诗才\n秘密：还泪而来')
    expect(folded.voice).toBe('话里带刺\n说话习惯：好用反语')
    // Emptied, so that saving the card clears them.
    expect(detailsOf(folded)).toEqual([])
    expect(folded.flaw).toBe('')
    expect(folded.persona).toMatchObject({ traits: [], values: [], speech: [], taboos: [], underPressure: '' })
  })

  it('leaves a card with no finer points as it is, and writes into a field that was empty', () => {
    const plain: Partial<CharacterCard> = { personality: '痴' }
    expect(foldDetails(plain, true)).toBe(plain)
    const folded = foldDetails<Partial<CharacterCard>>({ flaw: 'proud', abilities: 'rides well' }, false)
    expect(folded.personality).toBe('Flaw: proud')
    expect(folded.background).toBe('Can do: rides well')
    expect(folded.voice).toBeUndefined()
  })
})

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A character's card, kept short. What a card says of somebody is three
 * things written out — how they are, where they come from, how they speak —
 * beside what they want and how they change. The finer points a card once kept
 * apart (a flaw, abilities, secrets, traits with a number, values, verbal
 * habits, lines they would not cross, how they are under pressure) are a
 * sentence each of those three: this is where they are folded into them.
 */
import type { CharacterCard } from './types'

/** The finer points of a card that hold something, by what they are called. */
export function detailsOf(card: Pick<CharacterCard, 'flaw' | 'abilities' | 'secrets' | 'persona'>): string[] {
  const has = (text: string | undefined): boolean => text !== undefined && text.trim().length > 0
  const persona = card.persona ?? {}
  return [
    ...(has(card.flaw) ? ['flaw'] : []),
    ...(has(card.abilities) ? ['abilities'] : []),
    ...(has(card.secrets) ? ['secrets'] : []),
    ...((persona.traits?.length ?? 0) > 0 ? ['traits'] : []),
    ...((persona.values?.length ?? 0) > 0 ? ['values'] : []),
    ...((persona.speech?.length ?? 0) > 0 ? ['speech'] : []),
    ...((persona.taboos?.length ?? 0) > 0 ? ['taboos'] : []),
    ...(has(persona.underPressure) ? ['underPressure'] : []),
  ]
}

/**
 * The card with its finer points written into what it keeps: how they are takes the traits, what they hold dear,
 * what they would never do, how they are under pressure and their flaw; where they come from takes what they can
 * do and what they hide; how they speak takes their verbal habits. Nothing said of them is dropped — it is said in
 * fewer places. The points themselves come back empty.
 * @param zh - whether the card is written in Chinese: the words the points are introduced by.
 */
export function foldDetails<T extends Pick<CharacterCard, 'personality' | 'background' | 'voice' | 'flaw' | 'abilities' | 'secrets' | 'persona'>>(card: T, zh: boolean): T {
  if (detailsOf(card).length === 0) return card
  const persona = card.persona ?? {}
  const colon = zh ? '：' : ': '
  const list = (items: readonly string[]): string => items.map(item => item.trim()).filter(item => item.length > 0).join(zh ? '、' : ', ')
  const point = (label: [string, string], text: string | undefined): string | undefined => (text !== undefined && text.trim().length > 0 ? `${zh ? label[0] : label[1]}${colon}${text.trim()}` : undefined)
  const add = (text: string | undefined, points: (string | undefined)[]): string | undefined => {
    const more = points.filter((item): item is string => item !== undefined)
    const base = text?.trim() ?? ''
    return more.length === 0 ? text : [base, ...more].filter(item => item.length > 0).join('\n')
  }
  const personality = add(card.personality, [
    point(['特质', 'Traits'], list((persona.traits ?? []).map(trait => trait.name))),
    point(['看重', 'Holds dear'], list(persona.values ?? [])),
    point(['绝不会', 'Would never'], list(persona.taboos ?? [])),
    point(['压力之下', 'Under pressure'], persona.underPressure),
    point(['弱点', 'Flaw'], card.flaw),
  ])
  const background = add(card.background, [point(['能力', 'Can do'], card.abilities), point(['秘密', 'Hides'], card.secrets)])
  const voice = add(card.voice, [point(['说话习惯', 'Habits of speech'], list(persona.speech ?? []))])
  // Emptied rather than taken away: saved as a patch, an empty field clears what the card had (`mergeCard`).
  return {
    ...card,
    ...(personality !== undefined ? { personality } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(voice !== undefined ? { voice } : {}),
    flaw: '',
    abilities: '',
    secrets: '',
    persona: { traits: [], values: [], speech: [], taboos: [], underPressure: '' },
  }
}

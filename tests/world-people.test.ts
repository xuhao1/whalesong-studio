// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Somebody with a character card is a person, not an entry of the world.
 * Found importing *Alice's Adventures in Wonderland*: the world pass filed six
 * people who already had cards (the Hatter, the March Hare, the Queen of
 * Hearts…) as "terms" under the same ids, because the digests wrote facts of
 * the world about them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { digestChapter } from '../src/core/pipelines/digest'
import { analyzeBook } from '../src/core/pipelines/import'
import { settleSuggestions } from '../src/core/pipelines/settle'
import { createTestBed, type TestBed } from './support/harness'

describe('people are not filed in the world', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed() })
  afterEach(async () => { await bed.cleanup() })

  it('leaves a person with a card out of the world an analysis collects', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: 'Hatter', aliases: ['the Hatter'], role: 'supporting' })
    const { id } = await project.addChapter({ title: 'A Mad Tea-Party' })
    await project.saveChapterText(id, 'There was a table set out under a tree in front of the house, and the March Hare and the Hatter were having tea at it.')
    bed.llm.responder = () => JSON.stringify({
      brief: 'Tea with the Hatter.',
      summary: 'Alice joins a tea-party that never ends.',
      characters: [],
      facts: [
        { subject: 'the Hatter', statement: 'lives in one direction from the wood, and is mad', kind: 'world' },
        { subject: 'Tea-table', statement: 'a large table set out under a tree, laid for many', kind: 'world' },
      ],
      newEntities: [{ name: 'Hatter', kind: 'term', description: 'a mad character' }],
      threads: [],
    })
    await digestChapter(bed.core, bed.runtime, id, { origin: 'user' })

    let sightings = ''
    bed.llm.responder = (request) => {
      if (request.prompt.includes('地点、组织、物品') || request.prompt.includes('places, houses, things')) {
        sightings = request.prompt
        // A planner that names him all the same.
        return JSON.stringify({ entries: [{ name: 'Hatter', category: 'term', summary: 'A mad character.' }, { name: 'Tea-table', category: 'item', summary: 'The table of the tea-party.' }] })
      }
      return JSON.stringify({ entries: [] })
    }
    await analyzeBook(bed.core, bed.runtime, { steps: ['world'] }, { origin: 'user' })
    expect(sightings).toContain('Tea-table')
    expect(sightings).not.toMatch(/^- (the )?Hatter /m)
    const world = await project.world()
    expect(world.map(entry => entry.name)).toEqual(['Tea-table'])
    expect((await project.state()).peopleInWorld).toBeUndefined()
  })

  it('settles a "new entry" named after a person by leaving it out, without asking the planner', async () => {
    const { project } = bed.runtime
    await project.saveCharacter({ name: 'Queen of Hearts', role: 'antagonist' })
    await project.addSuggestions([{ kind: 'new-world', title: 'New entry: Queen of Hearts', detail: 'orders executions', payload: { name: 'Queen of Hearts', category: 'term' } }])
    let asked = 0
    bed.llm.responder = () => { asked += 1; return JSON.stringify({ verdicts: [] }) }
    const result = await settleSuggestions(bed.core, bed.runtime, { origin: 'user' })
    expect(asked).toBe(0)
    expect(result.skipped).toBe(1)
    expect(await project.world()).toEqual([])
    expect(await project.suggestions()).toEqual([])
  })

  it('takes a title for its person, but leaves a thing that shares a name with somebody\'s byname', async () => {
    const { project } = bed.runtime
    const baoyu = await project.saveCharacter({ name: '贾宝玉', aliases: ['怡红公子', '宝二爷'] })
    await project.saveCharacter({ name: '石头', aliases: ['通灵宝玉'] })
    const title = await project.saveWorld({ name: '怡红公子', category: 'term', summary: '宝玉在诗社里的别号' })
    await project.saveWorld({ name: '通灵宝玉', category: 'item', summary: '宝玉衔来的玉' })
    expect((await project.state()).peopleInWorld).toEqual([{ id: title.id, name: '怡红公子', card: baoyu.id }])
  })

  it('names the entries a book already has of its people, for the author to take out', async () => {
    const { project } = bed.runtime
    const card = await project.saveCharacter({ name: 'Cheshire Cat', role: 'supporting' })
    const entry = await project.saveWorld({ name: 'Cheshire Cat', category: 'term', summary: 'A grinning cat.' })
    await project.saveWorld({ name: 'Croquet-ground', category: 'location' })
    expect((await project.state()).peopleInWorld).toEqual([{ id: entry.id, name: 'Cheshire Cat', card: card.id }])
    await project.deleteWorld(entry.id)
    expect((await project.state()).peopleInWorld).toBeUndefined()
    expect((await project.world()).map(item => item.name)).toEqual(['Croquet-ground'])
  })
})

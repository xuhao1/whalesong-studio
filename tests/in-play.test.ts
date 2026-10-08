// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { bookInPlay, type InPlayClues } from '../src/host/in-play'

// A shelf laid out as an author's really is: a folder that is a book of its own, with two more books inside it —
// and, beside it, a plain folder that holds two books and is none.
const OUTER = '/shelf/novel_writer'
const INNER = '/shelf/novel_writer/红楼梦'
const SECOND = '/shelf/novel_writer/宋时归'
const PLAIN = '/shelf/workspace'
const LEFT = '/shelf/workspace/left'
const RIGHT = '/shelf/workspace/right'
const BOOKS = [OUTER, INNER, SECOND, LEFT, RIGHT]

interface Talk {
  folder?: string
  /** The book it was put on by name. */
  named?: string
  held?: string[]
  /** It works for another conversation: that one, or `true` where it has none to name. */
  child?: string | true
}

/** What a Host would know of these conversations. A book in `locked` is sealed, and refuses to open. */
function clues(talks: Record<string, Talk>, locked: string[] = []): InPlayClues<string> {
  const at = async (root: string): Promise<string | undefined> => {
    if (locked.includes(root)) throw new Error(`locked: ${root}`)
    return BOOKS.includes(root) ? root : undefined
  }
  return {
    named: async id => talks[id]?.named,
    held: async id => [...(talks[id]?.held ?? [])],
    worksFor: async (id) => {
      const child = talks[id]?.child
      return child === undefined ? undefined : child === true ? {} : { parent: child }
    },
    folder: async id => talks[id]?.folder,
    at,
    inFolder: async (folder) => {
      const direct = await at(folder)
      if (direct !== undefined) return direct
      const inside = BOOKS.filter(book => book.startsWith(`${folder}/`))
      return inside.length === 1 ? await at(inside[0]!) : undefined
    },
  }
}

describe('the book a conversation is on', () => {
  it('for a conversation of the author\'s own: the one it was put on, else the one its folder is, else the one it holds', async () => {
    const known = clues({
      named: { folder: OUTER, named: INNER, held: [OUTER, SECOND, INNER] },
      unnamed: { folder: OUTER, held: [INNER] },
      gone: { folder: OUTER, named: '/shelf/removed' },
      plain: { folder: PLAIN, held: [RIGHT] },
      undecided: { folder: PLAIN, held: [LEFT, RIGHT] },
      nowhere: {},
    })
    expect(await bookInPlay('named', known)).toBe(INNER)
    // What it once pointed a tool at does not move it off the book its folder is.
    expect(await bookInPlay('unnamed', known)).toBe(OUTER)
    // A book that is no longer there is not stood on.
    expect(await bookInPlay('gone', known)).toBe(OUTER)
    expect(await bookInPlay('plain', known)).toBe(RIGHT)
    expect(await bookInPlay('undecided', known)).toBeUndefined()
    expect(await bookInPlay('nowhere', known)).toBeUndefined()
    // The folder the caller already knows is the one gone by.
    expect(await bookInPlay('nowhere', known, OUTER)).toBe(OUTER)
  })

  it('for a role\'s run: the book it works on — whatever book the folder it was handed happens to be', async () => {
    // The conversation is on the inner book by name; the run it started is a new conversation in the same folder,
    // put on nothing — and that folder is a book too.
    const known = clues({
      showrunner: { folder: OUTER, named: INNER },
      run: { folder: OUTER, held: [INNER], child: 'showrunner' },
      // Started for another book than the conversation is on: a tool was pointed there.
      elsewhere: { folder: OUTER, held: [SECOND], child: 'showrunner' },
      // One nobody's conversation asked for, in the book's own folder.
      alone: { folder: INNER, held: [INNER], child: true },
    })
    expect(await bookInPlay('run', known)).toBe(INNER)
    expect(await bookInPlay('elsewhere', known)).toBe(SECOND)
    expect(await bookInPlay('alone', known)).toBe(INNER)
  })

  it('for a child that holds nothing: the book of the conversation it works for', async () => {
    const known = clues({
      showrunner: { folder: OUTER, named: INNER },
      helper: { folder: OUTER, child: 'showrunner' },
      deeper: { folder: OUTER, child: 'helper' },
      // Its parent is on no book: the folder is all there is to go by.
      orphan: { folder: OUTER, child: 'stranger' },
      stranger: {},
      adrift: { folder: PLAIN, child: true },
    })
    expect(await bookInPlay('helper', known)).toBe(INNER)
    expect(await bookInPlay('deeper', known)).toBe(INNER)
    expect(await bookInPlay('orphan', known)).toBe(OUTER)
    expect(await bookInPlay('adrift', known)).toBeUndefined()
  })

  it('a child put on a book by name is on that one, and a run keeps its book when its parent moves on', async () => {
    const talks: Record<string, Talk> = {
      showrunner: { folder: OUTER, named: INNER },
      run: { folder: OUTER, held: [INNER], child: 'showrunner' },
      moved: { folder: OUTER, named: SECOND, held: [INNER], child: 'showrunner' },
    }
    const known = clues(talks)
    expect(await bookInPlay('moved', known)).toBe(SECOND)
    talks.showrunner!.named = SECOND
    expect(await bookInPlay('run', known)).toBe(INNER)
  })

  it('children that name each other do not send the search in circles', async () => {
    const known = clues({
      one: { folder: OUTER, child: 'two' },
      two: { folder: PLAIN, child: 'one' },
    })
    expect(await bookInPlay('one', known)).toBe(OUTER)
    expect(await bookInPlay('two', known)).toBe(OUTER)
  })

  it('a book that is sealed and locked: the refusal is passed on, and the same search finds which book it was', async () => {
    const talks: Record<string, Talk> = {
      showrunner: { folder: OUTER, named: INNER },
      run: { folder: OUTER, held: [INNER], child: 'showrunner' },
      helper: { folder: OUTER, child: 'showrunner' },
    }
    const known = clues(talks, [INNER])
    await expect(bookInPlay('run', known)).rejects.toThrow('locked')
    await expect(bookInPlay('helper', known)).rejects.toThrow('locked')
    // By what a sealed book shows of itself while it is locked — its stub — and nothing else.
    const byStub: InPlayClues<string> = {
      ...known,
      at: async root => (root === INNER ? root : undefined),
      inFolder: async folder => (folder === INNER ? folder : undefined),
    }
    expect(await bookInPlay('run', byStub)).toBe(INNER)
    expect(await bookInPlay('helper', byStub)).toBe(INNER)
    expect(await bookInPlay('showrunner', byStub)).toBe(INNER)
  })
})

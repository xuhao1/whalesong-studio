// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Which book a conversation is on: the one book it, and the Studio beside
 * it, are about.
 *
 * In the order it is looked for:
 *
 *   1. the book the conversation was put on by name — by the author in the
 *      Studio, or by its own model through a tool;
 *   2. for a conversation that works for another one — a role's run, a
 *      subagent — the book that work is about: the first one it came to hold
 *      (a role's run holds the book its task names before it has said a word),
 *      else the book of the conversation it works for;
 *   3. the book its folder is, or the only one in that folder;
 *   4. the one book it holds something of.
 *
 * The second stands before the third because a folder says nothing of what a
 * child was asked to do. A child is handed its parent's folder, and a folder
 * can be a book of its own with other books inside it: the scribe who records
 * a chapter of an inner book is not at work on the outer one, and the Studio
 * put beside that run must not show the outer one either.
 */

/** What is known of conversations, asked for only as far as it is needed. */
export interface InPlayClues<Book> {
  /** Root of the book a conversation was put on by name. */
  named(sessionId: string): Promise<string | undefined>
  /** Roots of the books it holds something of, in the order it came to hold them. */
  held(sessionId: string): Promise<string[]>
  /** For a conversation that works for another one: that one, where it has one. Nothing for a conversation of the author's own. */
  worksFor(sessionId: string): Promise<{ parent?: string } | undefined>
  /** The folder a conversation was started in. */
  folder(sessionId: string): Promise<string | undefined>
  /** The book at a root; nothing where there is none. May refuse — a sealed book that is locked — and the refusal is the caller's to hear. */
  at(root: string): Promise<Book | undefined>
  /** The book a folder is, or the only one in it. */
  inFolder(folder: string): Promise<Book | undefined>
}

/** How many conversations up a chain of children the book is looked for: more than DSH lets agents delegate. */
const UP = 8

/**
 * @param folder - the conversation's folder, where the caller knows it already.
 * @throws whatever `at` and `inFolder` refuse with.
 */
export async function bookInPlay<Book>(sessionId: string, clues: InPlayClues<Book>, folder?: string): Promise<Book | undefined> {
  return await look(sessionId, clues, folder, new Set())
}

async function look<Book>(sessionId: string, clues: InPlayClues<Book>, folder: string | undefined, seen: Set<string>): Promise<Book | undefined> {
  seen.add(sessionId)
  const named = await clues.named(sessionId)
  if (named !== undefined) {
    const book = await clues.at(named)
    if (book !== undefined) return book
  }
  const held = await clues.held(sessionId)
  const lead = await clues.worksFor(sessionId)
  if (lead !== undefined) {
    if (held.length > 0) {
      const book = await clues.at(held[0]!)
      if (book !== undefined) return book
    }
    if (lead.parent !== undefined && !seen.has(lead.parent) && seen.size < UP) {
      const book = await look(lead.parent, clues, undefined, seen)
      if (book !== undefined) return book
    }
  }
  const cwd = folder ?? await clues.folder(sessionId)
  const here = cwd !== undefined ? await clues.inFolder(cwd) : undefined
  if (here !== undefined) return here
  return held.length === 1 ? await clues.at(held[0]!) : undefined
}

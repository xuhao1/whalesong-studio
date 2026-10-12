// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Jottings: the author's loose notes, kept with the book.
 *
 * A turn the plot might take, a rule of the world not settled yet, a line to
 * use some day — things too unfinished for the outline or the bible, and too
 * good to lose. They are kept in one file of the book (`jottings/index.json`,
 * sealed with it), written on a page of their own or jotted from anywhere.
 *
 * Whoever works on the book finds them: they are a source of the book's
 * search, a kind the crew's read tool lists, and the ones that bear on a
 * chapter go along when it is planned or written — always named for what they
 * are, ideas and not canon. The author keeps one of them, or all, from being
 * found: such a jotting is in no index and in no list an agent reads.
 */
import type { Project } from './project'
import { ProjectError } from './project'
import { L } from './render'
import { clip, newId } from '../shared/text'
import { JOTTING_KINDS, type Jotting, type JottingKind, type JottingsView, type PromptLanguage } from '../shared/types'

/** Where a book keeps its jottings. */
export const JOTTINGS_FILE = 'jottings/index.json'
/** How many of the ones taken away are kept to be put back. */
const REMOVED_KEPT = 60

interface JottingsFile {
  schema: 1
  /** `false`: none of them is found by the agents. */
  search?: boolean
  items: Jotting[]
  removed?: (Jotting & { removedAt: string })[]
}

const isKind = (value: unknown): value is JottingKind => (JOTTING_KINDS as readonly unknown[]).includes(value)

function clean(raw: unknown): Jotting | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const item = raw as Partial<Jotting>
  if (typeof item.id !== 'string' || typeof item.text !== 'string' || item.text.trim().length === 0) return undefined
  const at = typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString()
  return {
    id: item.id,
    ...(typeof item.title === 'string' && item.title.trim().length > 0 ? { title: item.title.trim() } : {}),
    text: item.text,
    kind: isKind(item.kind) ? item.kind : 'other',
    ...(item.hidden === true ? { hidden: true } : {}),
    createdAt: at,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : at,
  }
}

async function readFile(project: Project): Promise<JottingsFile> {
  try {
    const stored = JSON.parse((await project.readFile(JOTTINGS_FILE)).toString('utf8')) as Partial<JottingsFile>
    const items = (Array.isArray(stored.items) ? stored.items : []).map(clean).filter((item): item is Jotting => item !== undefined)
    const removed = (Array.isArray(stored.removed) ? stored.removed : [])
      .map(raw => { const item = clean(raw); return item !== undefined ? { ...item, removedAt: typeof raw?.removedAt === 'string' ? raw.removedAt : item.updatedAt } : undefined })
      .filter((item): item is Jotting & { removedAt: string } => item !== undefined)
    return { schema: 1, ...(stored.search === false ? { search: false } : {}), items, ...(removed.length > 0 ? { removed } : {}) }
  } catch {
    return { schema: 1, items: [] }
  }
}

async function writeFile(project: Project, file: JottingsFile): Promise<void> {
  await project.writeFile(JOTTINGS_FILE, `${JSON.stringify(file, null, 2)}\n`)
}

const viewOf = (file: JottingsFile): JottingsView => ({
  // The latest first: what was just written is what the author looks for.
  items: [...file.items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  search: file.search !== false,
  removed: [...(file.removed ?? [])].sort((left, right) => right.removedAt.localeCompare(left.removedAt)),
})

/** What a jotting is known by: its title, else its first line. */
export function jottingName(item: Pick<Jotting, 'title' | 'text'>): string {
  return item.title ?? clip(item.text.split('\n').find(line => line.trim().length > 0)?.trim() ?? '', 40)
}

/** The jottings of a book, as the author sees them: every one, found or not. */
export async function jottingsView(project: Project): Promise<JottingsView> {
  return viewOf(await readFile(project))
}

/** How many jottings the book keeps. */
export async function jottingCount(project: Project): Promise<number> {
  return (await readFile(project)).items.length
}

/**
 * The jottings an agent may find and read: none where the author keeps them all from being found, else every one
 * that is not kept back by itself.
 */
export async function foundJottings(project: Project): Promise<Jotting[]> {
  const file = await readFile(project)
  if (file.search === false) return []
  return viewOf(file).items.filter(item => item.hidden !== true)
}

export interface JottingInput {
  /** Which one is changed; a new one where left out. */
  id?: string
  title?: string
  text?: string
  kind?: JottingKind
  /** `true`: kept from the agents; `false`: found again. */
  hidden?: boolean
}

/**
 * Write a jotting down, or change one: only what is given changes.
 * @throws ProjectError `novel/invalid` for a new one with no text, `novel/not-found` for an id the book has not.
 */
export async function saveJotting(project: Project, input: JottingInput): Promise<Jotting> {
  const file = await readFile(project)
  const now = new Date().toISOString()
  if (input.id === undefined) {
    const text = input.text?.trim() ?? ''
    if (text.length === 0) throw new ProjectError('novel/invalid', 'a jotting needs some text')
    const made: Jotting = {
      id: newId('jt'),
      ...(input.title !== undefined && input.title.trim().length > 0 ? { title: input.title.trim() } : {}),
      text,
      kind: isKind(input.kind) ? input.kind : 'other',
      ...(input.hidden === true ? { hidden: true } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await writeFile(project, { ...file, items: [...file.items, made] })
    return made
  }
  const at = file.items.findIndex(item => item.id === input.id)
  if (at < 0) throw new ProjectError('novel/not-found', `the book has no jotting "${input.id}"`)
  const before = file.items[at]!
  const text = input.text !== undefined ? input.text.trim() : before.text
  if (text.length === 0) throw new ProjectError('novel/invalid', 'a jotting needs some text — take it away instead of emptying it')
  const title = input.title !== undefined ? input.title.trim() : before.title
  const hidden = input.hidden !== undefined ? input.hidden : before.hidden === true
  const changed = text !== before.text || (title ?? '') !== (before.title ?? '') || (isKind(input.kind) && input.kind !== before.kind)
  const after: Jotting = {
    id: before.id,
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    text,
    kind: isKind(input.kind) ? input.kind : before.kind,
    ...(hidden ? { hidden: true } : {}),
    createdAt: before.createdAt,
    // (Kept from the agents or let be found again: the note itself is as old as it was.)
    updatedAt: changed ? now : before.updatedAt,
  }
  await writeFile(project, { ...file, items: file.items.map((item, index) => index === at ? after : item) })
  return after
}

/** Take a jotting away. It is kept among the ones taken away lately, to be put back. */
export async function removeJotting(project: Project, id: string): Promise<void> {
  const file = await readFile(project)
  const gone = file.items.find(item => item.id === id)
  if (gone === undefined) throw new ProjectError('novel/not-found', `the book has no jotting "${id}"`)
  const removed = [{ ...gone, removedAt: new Date().toISOString() }, ...(file.removed ?? [])].slice(0, REMOVED_KEPT)
  await writeFile(project, { ...file, items: file.items.filter(item => item.id !== id), removed })
}

/** Put back a jotting that was taken away. */
export async function restoreJotting(project: Project, id: string): Promise<Jotting> {
  const file = await readFile(project)
  const back = (file.removed ?? []).find(item => item.id === id)
  if (back === undefined) throw new ProjectError('novel/not-found', `no jotting "${id}" among the ones taken away`)
  const { removedAt: _removedAt, ...item } = back
  const removed = (file.removed ?? []).filter(other => other.id !== id)
  const { removed: _old, ...rest } = file
  await writeFile(project, { ...rest, items: [...file.items, item], ...(removed.length > 0 ? { removed } : {}) })
  return item
}

/** Let the agents find the book's jottings, or keep all of them from being found. */
export async function setJottingsSearch(project: Project, on: boolean): Promise<void> {
  const file = await readFile(project)
  const { search: _search, ...rest } = file
  await writeFile(project, { ...rest, ...(on ? {} : { search: false }) })
}

/** One jotting an agent asks for, by id or by what it is known by. */
export async function findJotting(project: Project, ref: string): Promise<Jotting | undefined> {
  const wanted = ref.trim()
  const found = await foundJottings(project)
  return found.find(item => item.id === wanted) ?? found.find(item => jottingName(item) === wanted) ?? found.find(item => item.title !== undefined && item.title.includes(wanted))
}

const KIND_WORD: Record<JottingKind, [string, string]> = { plot: ['剧情 / 大纲', 'plot'], setting: ['设定', 'setting'], other: ['其他', 'other'] }

/** A jotting's kind in words. */
export function jottingKindWord(kind: JottingKind, lang: PromptLanguage): string {
  return L(lang, ...KIND_WORD[kind])
}

/**
 * What a role working on the book as an agent is told of its jottings — that there are some, what they are, how to
 * read them. Nothing where there is none to find.
 */
export async function jottingsBrief(project: Project, lang: PromptLanguage, read = 'book_read', search = 'book_search'): Promise<string> {
  const found = await foundJottings(project)
  if (found.length === 0) return ''
  return L(lang,
    `## 作者的随笔\n这本书里有 ${found.length} 条作者的随笔：没想好的剧情、没定下来的设定、随手记下的想法。${read} what=jottings 列出它们，带 ref 读一条；${search} 也找得到（来源写着 jotting）。手上的活和它们沾边时去看——作者记下来，是想让它们被用上。但它们不是定论：和设定集、已经写下的正文对不上时，以设定和正文为准；照哪一条随笔做了什么，交回时说一句（是哪一条）。`,
    `## The author's jottings\nThis book keeps ${found.length} jotting(s) of the author's: turns of the plot not thought through, settings not settled, ideas noted in passing. ${read} what=jottings lists them, and with a ref reads one; ${search} finds them too (source "jotting"). Look at them where the work at hand touches them — the author wrote them down to have them used. But they are not canon: where one is at odds with the bible or with text already written, the bible and the text hold; and where you went by one, say which when you hand in.`)
}

/** The jottings that bear on a piece of work, as a part of what it is given to read. */
export function renderJottings(items: readonly Pick<Jotting, 'title' | 'text' | 'kind'>[], lang: PromptLanguage): string {
  return items.map(item => `〔${jottingKindWord(item.kind, lang)}${item.title !== undefined ? ` · ${item.title}` : ''}〕\n${item.text.trim()}`).join('\n\n')
}

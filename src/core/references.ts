// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The books a book goes by.
 *
 * An author writes with other books at hand: one for its world, one for the
 * way it is written, one of their own that this story shares a setting with.
 * A book keeps a list of them — its references — and says of each, in its
 * author's own words, what to take from it.
 *
 * Two kinds. A book that stands on the shelf is consulted as it is organised
 * there: its bible, its outline and digests, its style, its text. A
 * manuscript taken in for this book alone is kept among its files and
 * consulted as plain text, cut into parts where it has headings — nobody
 * reads it into cards (for that it is imported as a book of the shelf).
 *
 * Nothing of a reference is put into a task as it stands. Whoever works on
 * the book as an agent is told which references there are and what the author
 * wants of each, and reads in them with two tools of its own — within what
 * the author opened of each. The writer, who has no tools, is handed what the
 * planner found for the chapter it writes: notes kept on that chapter's plan,
 * where the author reads and corrects them.
 */
import type { NovelCore, ProjectRuntime } from './core'
import { ProjectError } from './project'
import { readBook, searchBook, type ReadKind } from './reading'
import { L } from './render'
import { argInt, argList, argText, type RoleTool } from './roles'
import { clip, countWords, newId, sameName } from '../shared/text'
import { REFERENCE_ASPECTS, type BookReference, type PromptLanguage, type ReferenceAspect, type ReferenceFirst, type ReferenceInfo, type ReferenceShelf, type SearchSource } from '../shared/types'

/** Where a book keeps the list of its references, and the manuscripts taken in for it. */
const INDEX = 'references/index.json'

interface IndexFile {
  schema: 1
  items: BookReference[]
  /** How the book goes by its references at large, in the author's words: said to everybody who works with them. */
  guide?: string
  /** `false`: no notes are taken in the references before a chapter is written. */
  beforeWriting?: boolean
  /** `false`: the planner is not held to look in them before it derives. */
  beforeDeriving?: boolean
  /** `false`: the reviewer is not held to look in them before it reviews. */
  beforeReviewing?: boolean
}

/** Where each kind of work that looks first is kept in the list's file. */
const FIRST_KEY = { write: 'beforeWriting', derive: 'beforeDeriving', review: 'beforeReviewing' } as const satisfies Record<ReferenceFirst, keyof IndexFile>

/** One part of a manuscript kept as a reference: a chapter of it, or a stretch of its text. */
interface TextPart { title: string; start: number; end: number }

async function readIndex(runtime: ProjectRuntime): Promise<IndexFile> {
  try {
    const stored = JSON.parse((await runtime.project.readFile(INDEX)).toString('utf8')) as Partial<IndexFile>
    return {
      schema: 1,
      items: Array.isArray(stored.items) ? stored.items.filter(item => typeof item?.id === 'string' && (item.kind === 'book' || item.kind === 'text')) : [],
      ...(typeof stored.guide === 'string' && stored.guide.trim().length > 0 ? { guide: stored.guide.trim() } : {}),
      ...(stored.beforeWriting === false ? { beforeWriting: false } : {}),
      ...(stored.beforeDeriving === false ? { beforeDeriving: false } : {}),
      ...(stored.beforeReviewing === false ? { beforeReviewing: false } : {}),
    }
  } catch {
    return { schema: 1, items: [] }
  }
}

async function writeIndex(runtime: ProjectRuntime, index: IndexFile): Promise<void> {
  await runtime.project.writeFile(INDEX, `${JSON.stringify(index, null, 2)}\n`)
}

/** The references of a book as its list has them. */
export async function referenceList(runtime: ProjectRuntime): Promise<BookReference[]> {
  return (await readIndex(runtime)).items
}

/** Those of them that are consulted now. */
export async function activeReferences(runtime: ProjectRuntime): Promise<BookReference[]> {
  return (await readIndex(runtime)).items.filter(item => item.off !== true)
}

/**
 * Whether a kind of work looks in the references before anything else: yes, where the book has any that are
 * consulted — unless the author turned it off for that kind. Before a chapter is written that is the planner taking
 * notes for the writer; a derivation and a review are held to it themselves.
 */
export async function looksFirst(runtime: ProjectRuntime, kind: ReferenceFirst): Promise<boolean> {
  const index = await readIndex(runtime)
  return index[FIRST_KEY[kind]] !== false && index.items.some(item => item.off !== true)
}

/** Whether notes are taken in the references before a chapter is written. */
export const consultsBeforeWriting = async (runtime: ProjectRuntime): Promise<boolean> => await looksFirst(runtime, 'write')

/** What the author says of how the book goes by its references at large. */
export async function referenceGuide(runtime: ProjectRuntime): Promise<string | undefined> {
  return (await readIndex(runtime)).guide
}

/** The book of the shelf a reference names, open; why not, where it cannot be read. */
async function shelfBook(core: NovelCore, reference: BookReference): Promise<{ runtime: ProjectRuntime } | { state: 'locked' | 'missing' }> {
  try {
    const found = (reference.book !== undefined ? await core.runtimeById(reference.book) : undefined) ?? (reference.root !== undefined ? await core.tryRuntime(reference.root) : undefined)
    return found !== undefined ? { runtime: found } : { state: 'missing' }
  } catch (error) {
    return { state: error instanceof ProjectError && error.code === 'novel/locked' ? 'locked' : 'missing' }
  }
}

/** A reference as it is found now: what it is called, whether it can be read, what there is of it. */
async function inform(core: NovelCore, runtime: ProjectRuntime, reference: BookReference, lang: PromptLanguage): Promise<ReferenceInfo> {
  if (reference.kind === 'text') {
    const there = reference.file !== undefined && await runtime.project.has(reference.file)
    return { ...reference, name: reference.title ?? L(lang, '一份书稿', 'a manuscript'), state: there ? 'ready' : 'missing' }
  }
  const book = await shelfBook(core, reference)
  if (!('runtime' in book)) return { ...reference, name: reference.title ?? L(lang, book.state === 'locked' ? '一本上了锁的书' : '一本找不到的书', book.state === 'locked' ? 'a locked book' : 'a book that is not there'), state: book.state }
  const { project } = book.runtime
  const [manifest, chapters, characters, world, styles] = await Promise.all([project.manifest(), project.chapterInfos(), project.characters(), project.world(), project.styles()])
  const written = chapters.filter(chapter => chapter.hasText)
  return {
    ...reference,
    name: manifest.title,
    state: 'ready',
    has: { chapters: written.length, words: written.reduce((sum, chapter) => sum + chapter.words, 0), characters: characters.length, world: world.length, styles: styles.length },
  }
}

/** The references of a book, each as it is found now, and how they are used. */
export async function referenceShelf(core: NovelCore, runtime: ProjectRuntime): Promise<ReferenceShelf> {
  const index = await readIndex(runtime)
  const lang: PromptLanguage = /^zh/i.test((await runtime.project.manifest()).language) ? 'zh' : 'en'
  return {
    references: await Promise.all(index.items.map(item => inform(core, runtime, item, lang))),
    ...(index.guide !== undefined ? { guide: index.guide } : {}),
    beforeWriting: index.beforeWriting !== false,
    beforeDeriving: index.beforeDeriving !== false,
    beforeReviewing: index.beforeReviewing !== false,
  }
}

const scopeOf = (value: unknown): ReferenceAspect[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const picked = REFERENCE_ASPECTS.filter(aspect => value.includes(aspect))
  // All of it is what a reference is open to when nothing is said: no list is kept for that.
  return picked.length > 0 && picked.length < REFERENCE_ASPECTS.length ? picked : undefined
}

/**
 * Take a book of the shelf as a reference.
 * @throws ProjectError `novel/invalid` for the book itself, or one that is a reference already; `novel/not-found` where no book stands there.
 */
export async function addBookReference(core: NovelCore, runtime: ProjectRuntime, input: { root: string; note?: string; scope?: ReferenceAspect[] }): Promise<BookReference> {
  const other = await core.tryRuntime(input.root)
  if (other === undefined) throw new ProjectError('novel/not-found', `no book stands at ${input.root}`)
  if (other.project.root === runtime.project.root) throw new ProjectError('novel/invalid', 'a book is not its own reference')
  const manifest = await other.project.manifest()
  const index = await readIndex(runtime)
  if (index.items.some(item => item.kind === 'book' && (item.book === manifest.id || item.root === other.project.root))) throw new ProjectError('novel/invalid', `"${manifest.title}" is a reference of this book already`)
  const scope = scopeOf(input.scope)
  const note = input.note?.trim()
  const reference: BookReference = {
    id: newId('ref'),
    kind: 'book',
    // A sealed book is named nowhere outside itself: its name is read off it while it is open.
    ...(other.project.sealed ? {} : { title: manifest.title }),
    ...(manifest.author !== undefined && !other.project.sealed ? { author: manifest.author } : {}),
    root: other.project.root,
    book: manifest.id,
    ...(note !== undefined && note.length > 0 ? { note } : {}),
    ...(scope !== undefined ? { scope } : {}),
    addedAt: new Date().toISOString(),
  }
  await writeIndex(runtime, { ...index, items: [...index.items, reference] })
  return reference
}

/** The parts a manuscript reads in: its chapters where it has headings, stretches of its text where it has none. */
async function partsOf(text: string): Promise<TextPart[]> {
  // (Asked for when it is needed: the module that cuts manuscripts hands work to the crew, which reads references.)
  const { splitChapters } = await import('./pipelines/structure')
  const cut = splitChapters(text, { chunkChars: 6000 })
  const parts: TextPart[] = []
  let from = 0
  for (const chapter of cut) {
    // Where the part begins in the text as it is kept: found by its opening words, from where the one before ended.
    const head = chapter.text.slice(0, 40)
    const at = head.length > 0 ? text.indexOf(head, from) : -1
    const start = at >= 0 ? at : from
    if (parts.length > 0) parts[parts.length - 1]!.end = start
    parts.push({ title: chapter.title, start, end: text.length })
    from = start + Math.max(1, head.length)
  }
  return parts.length > 0 ? parts : [{ title: '1', start: 0, end: text.length }]
}

/**
 * Take a manuscript in as a reference of this book alone: kept among its files as plain text.
 * @throws ProjectError `novel/invalid` where there is no text.
 */
export async function addTextReference(runtime: ProjectRuntime, input: { text: string; title?: string; author?: string; note?: string }): Promise<BookReference> {
  const text = input.text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').trim()
  if (text.length === 0) throw new ProjectError('novel/invalid', 'there is no text in it')
  const id = newId('ref')
  const file = `references/${id}.txt`
  await runtime.project.writeFile(file, text)
  const note = input.note?.trim()
  const title = input.title?.trim()
  const reference: BookReference = {
    id,
    kind: 'text',
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    ...(input.author !== undefined && input.author.trim().length > 0 ? { author: input.author.trim() } : {}),
    file,
    chars: text.length,
    parts: (await partsOf(text)).length,
    ...(note !== undefined && note.length > 0 ? { note } : {}),
    addedAt: new Date().toISOString(),
  }
  const index = await readIndex(runtime)
  await writeIndex(runtime, { ...index, items: [...index.items, reference] })
  return reference
}

/** Change what the author says of a reference: how to go by it, what of it is open, whether it is consulted, what it is called. */
export async function updateReference(runtime: ProjectRuntime, id: string, change: { note?: string; scope?: ReferenceAspect[] | null; off?: boolean; title?: string }): Promise<BookReference> {
  const index = await readIndex(runtime)
  const at = index.items.findIndex(item => item.id === id)
  if (at < 0) throw new ProjectError('novel/not-found', `this book has no reference "${id}"`)
  const next: BookReference = { ...index.items[at]! }
  if (change.note !== undefined) {
    if (change.note.trim().length > 0) next.note = change.note.trim()
    else delete next.note
  }
  if (change.scope !== undefined) {
    const scope = change.scope === null ? undefined : scopeOf(change.scope)
    if (scope !== undefined) next.scope = scope
    else delete next.scope
  }
  if (change.off !== undefined) {
    if (change.off) next.off = true
    else delete next.off
  }
  if (change.title !== undefined && next.kind === 'text') {
    if (change.title.trim().length > 0) next.title = change.title.trim()
    else delete next.title
  }
  const items = [...index.items]
  items[at] = next
  await writeIndex(runtime, { ...index, items })
  return next
}

/** Take a reference off the list. A manuscript taken in for this book goes with it; a book of the shelf is not touched. */
export async function removeReference(runtime: ProjectRuntime, id: string): Promise<BookReference> {
  const index = await readIndex(runtime)
  const found = index.items.find(item => item.id === id)
  if (found === undefined) throw new ProjectError('novel/not-found', `this book has no reference "${id}"`)
  await writeIndex(runtime, { ...index, items: index.items.filter(item => item.id !== id) })
  if (found.kind === 'text' && found.file !== undefined) await runtime.project.removeReferenceFile(found.file).catch(() => undefined)
  return found
}

/**
 * How the references are used at large: which kinds of work look in them first, and what the author says of them all.
 * What is left out stays as it is; an empty `guide` takes it off.
 */
export async function setReferenceUse(runtime: ProjectRuntime, change: { first?: Partial<Record<ReferenceFirst, boolean>>; guide?: string }): Promise<void> {
  const next: IndexFile = { ...await readIndex(runtime) }
  for (const kind of Object.keys(FIRST_KEY) as ReferenceFirst[]) {
    const on = change.first?.[kind]
    if (on === undefined) continue
    // Looking first is how things are when nothing is said: only "not" is kept.
    if (on) delete next[FIRST_KEY[kind]]
    else next[FIRST_KEY[kind]] = false
  }
  if (change.guide !== undefined) {
    if (change.guide.trim().length > 0) next.guide = change.guide.trim()
    else delete next.guide
  }
  await writeIndex(runtime, next)
}

/** Whether notes are taken in the references before a chapter is written. */
export const setConsultBeforeWriting = async (runtime: ProjectRuntime, on: boolean): Promise<void> => { await setReferenceUse(runtime, { first: { write: on } }) }

// ───────────────────────────── reading in them ─────────────────────────────

/** What of a book each kind of reading belongs to. */
const ASPECT_OF: Partial<Record<ReadKind, ReferenceAspect>> = { chapter: 'text', outline: 'plot', memory: 'plot', threads: 'plot', character: 'characters', world: 'world', style: 'style' }
// (A book's jottings are its author's loose notes: no part of what a reference opens, so never searched from another book.)
const SOURCE_ASPECT: Record<Exclude<SearchSource, 'jotting'>, ReferenceAspect> = { manuscript: 'text', character: 'characters', world: 'world', memory: 'plot', outline: 'plot' }
/** What each kind of reading is called, for a line of what somebody read. */
const READ_WORD: Record<string, [string, string]> = { outline: ['大纲', 'outline'], chapter: ['正文', 'text'], memory: ['章节记载', 'chapter digest'], threads: ['线索', 'threads'], character: ['人物', 'people'], world: ['设定', 'world'], style: ['文风', 'style'], review: ['审校', 'review'], versions: ['版本', 'versions'] }
const ASPECT_WORD: Record<ReferenceAspect, [string, string]> = { world: ['世界观与设定', 'its world and settings'], characters: ['人物', 'its people'], style: ['文风', 'its style'], plot: ['剧情（大纲、各章摘要、线索）', 'its plot (outline, chapter digests, threads)'], text: ['正文', 'its text'] }

const openTo = (reference: BookReference, aspect: ReferenceAspect): boolean => reference.scope === undefined || reference.scope.includes(aspect)

/** What of a reference is open, said in words. */
function scopeWords(reference: BookReference, lang: PromptLanguage): string {
  if (reference.kind === 'text') return L(lang, '全文（纯文字）', 'its whole text (plain text)')
  if (reference.scope === undefined) return L(lang, '全部：世界观与设定、人物、文风、剧情、正文', 'all of it: world and settings, people, style, plot, text')
  return reference.scope.map(aspect => L(lang, ...ASPECT_WORD[aspect])).join(L(lang, '、', ', '))
}

/** The text of a manuscript kept as a reference, and its parts — read once for as long as the file is what it was. */
const texts = new Map<string, { size: number; text: string; parts: TextPart[] }>()

async function textOf(runtime: ProjectRuntime, reference: BookReference): Promise<{ text: string; parts: TextPart[] }> {
  if (reference.file === undefined) throw new Error('this reference has no text')
  const key = `${runtime.project.root}\n${reference.file}`
  const info = await runtime.project.fileInfo(reference.file)
  if (info === undefined || info.size === 0) throw new Error(`the text of "${reference.title ?? reference.id}" is no longer among the book's files — the author takes it in again under References`)
  const held = texts.get(key)
  if (held !== undefined && held.size === info.size) return held
  const text = (await runtime.project.readFile(reference.file)).toString('utf8')
  const read = { size: info.size, text, parts: await partsOf(text) }
  if (texts.size >= 8) texts.delete(texts.keys().next().value!)
  texts.set(key, read)
  return read
}

/** Find words in a manuscript: the parts that have most of them, each with the lines around its first find. */
function findInText(text: string, parts: readonly TextPart[], query: string, limit: number): { part: number; title: string; offset: number; snippet: string; score: number }[] {
  const whole = query.trim()
  const terms = [...new Set([whole, ...whole.split(/[\s,，、;；。.!?！？]+/u)].map(term => term.trim()).filter(term => [...term].length >= 2 || /^[一-鿿]$/u.test(term)))]
  if (terms.length === 0) return []
  const hits: { part: number; title: string; offset: number; snippet: string; score: number }[] = []
  parts.forEach((part, at) => {
    const body = text.slice(part.start, part.end)
    let score = 0
    let first = -1
    for (const term of terms) {
      let from = 0
      let count = 0
      for (;;) {
        const found = body.indexOf(term, from)
        if (found < 0 || count >= 8) break
        if (first < 0 || (term === whole && count === 0)) first = found
        count += 1
        from = found + term.length
      }
      // The whole of what was asked for, found as it stands, counts for more than its words apart.
      score += count * [...term].length * (term === whole && terms.length > 1 ? 3 : 1)
    }
    if (score > 0 && first >= 0) {
      const from = Math.max(0, first - 160)
      hits.push({ part: at + 1, title: part.title, offset: first, snippet: `${from > 0 ? '…' : ''}${body.slice(from, first + 340).trim()}${first + 340 < body.length ? '…' : ''}`, score })
    }
  })
  return hits.sort((left, right) => right.score - left.score || left.part - right.part).slice(0, limit)
}

/** The reference a tool call names: by its id, by what it is called, or — where the book has one only — by nothing. */
function pick(references: readonly ReferenceInfo[], named: string | undefined): ReferenceInfo {
  const wanted = named?.trim().replace(/^[《「『“"]+|[》」』”"]+$/gu, '') ?? ''
  if (wanted.length === 0) {
    if (references.length === 1) return references[0]!
    throw new Error(`say which reference with \`book\`: ${references.map(item => `${item.name} [${item.id}]`).join('; ')}`)
  }
  const found = references.find(item => item.id === wanted) ?? references.find(item => sameName(item.name, wanted)) ?? references.find(item => item.name.includes(wanted) || wanted.includes(item.name))
  if (found === undefined) throw new Error(`this book has no reference "${named}" — its references: ${references.map(item => `${item.name} [${item.id}]`).join('; ')}`)
  return found
}

/** The references that are consulted now, as they are found. */
async function consulted(core: NovelCore, runtime: ProjectRuntime, lang: PromptLanguage): Promise<ReferenceInfo[]> {
  return await Promise.all((await activeReferences(runtime)).map(item => inform(core, runtime, item, lang)))
}

/** One line of a list of references: which, what it is, what of it is open, what the author wants of it. */
function line(reference: ReferenceInfo, lang: PromptLanguage): string {
  const what = reference.kind === 'book'
    ? L(lang, `书架上的书${reference.has !== undefined ? `，${reference.has.chapters} 章 ${reference.has.words} 字，${reference.has.characters} 张人物卡，${reference.has.world} 条设定` : ''}`, `a book of the shelf${reference.has !== undefined ? `, ${reference.has.chapters} chapters of ${reference.has.words} words, ${reference.has.characters} character cards, ${reference.has.world} world entries` : ''}`)
    : L(lang, `导入的书稿，纯文字，${reference.chars ?? 0} 字，${reference.parts ?? 1} 段`, `a manuscript taken in as plain text, ${reference.chars ?? 0} characters in ${reference.parts ?? 1} parts`)
  const state = reference.state === 'ready' ? '' : L(lang, reference.state === 'locked' ? '（现在上着锁，读不了）' : '（现在找不到，读不了）', reference.state === 'locked' ? ' (locked now: it cannot be read)' : ' (not found now: it cannot be read)')
  return `- 《${reference.name}》 [${reference.id}]${reference.author !== undefined ? ` ${reference.author}` : ''} — ${what}${state}\n  ${L(lang, '可以查', 'Open')}${L(lang, '：', ': ')}${scopeWords(reference, lang)}\n  ${L(lang, '作者要怎么参考', 'How the author wants it used')}${L(lang, '：', ': ')}${reference.note ?? L(lang, '（没有另说：按这件活用得上的来）', '(nothing said: as this piece of work has use for it)')}`
}

/**
 * The references that are consulted now, as a task lists them — one after another, with what of each is open and
 * what the author wants of it — and what the author says of them all. Nothing, where the book has none.
 */
export async function referenceListing(core: NovelCore, runtime: ProjectRuntime, lang: PromptLanguage): Promise<{ lines: string; guide?: string } | undefined> {
  const references = await consulted(core, runtime, lang)
  if (references.length === 0) return undefined
  const guide = await referenceGuide(runtime)
  return { lines: references.map(reference => line(reference, lang)).join('\n'), ...(guide !== undefined ? { guide } : {}) }
}

/** What the author says of the references at large, as a task has it: it holds for every one of them. */
export function guideWords(guide: string, lang: PromptLanguage): string {
  return L(lang, `作者对参考文献的总要求（对每一本都算数；某一本下面另写了“怎么参考”的，两句都照，对不上时那一本照它自己那一句）：\n${guide}`, `What the author asks of the references at large (it holds for every one of them; where one has its own "how to go by it" below, both hold, and its own wins where they are at odds):\n${guide}`)
}

/**
 * What whoever works on the book as an agent is told of its references: which there are, what the author wants of
 * them all and of each, and that they are read with tools — nothing of them is in the task. Nothing, where the book
 * has none.
 * @param how.first - this piece of work looks in them before anything else: the author has it so, and what is handed
 *   in is not taken until it has.
 */
export async function referenceBrief(core: NovelCore, runtime: ProjectRuntime, lang: PromptLanguage, how: { first?: boolean } = {}): Promise<string | undefined> {
  const listing = await referenceListing(core, runtime, lang)
  if (listing === undefined) return undefined
  const when = how.first === true
    ? L(lang, '这件活动手之前先到参考文献里查——作者是这样定的：先读、先找这件活用得上的（要守的设定和规矩、要学的写法、要对的出处），再做；交回的时候会看你查过没有。', 'Before this piece of work is begun, look in the references — the author has it so: read and find what the work can use (settings and rules to keep to, ways of writing to learn, sources to check), then do it; what you hand in is not taken until you have looked.')
    : L(lang, '这件活和它们沾边时（定设定、推演、写法、核对出处）先去查，再动手；', 'Where this piece of work touches them (a setting to fix, a plot to derive, a way of writing, a source to check), look first, then work;')
  const guide = listing.guide !== undefined ? `\n${guideWords(listing.guide, lang)}\n` : ''
  return L(lang, `## 这本书的参考文献
作者给这本书指定了参考：别的书的世界观、设定、文风、剧情或文字。它们的内容不在任务里——用 reference_read / reference_search 去读、去找；每一本只在作者开放的范围里查，照作者的要求来用。${when}用了哪一本的什么，在交回的结果里说一句。参考是用来学和对照的：除非作者那样说，不整段照搬它的文字，也不把它的人物和情节原样搬进这本书。
${guide}${listing.lines}`, `## The references of this book
The author gave this book references: other books whose world, settings, style, plot or wording it goes by. What they hold is not in the task — read it with reference_read and find in it with reference_search; each is open only as far as the author opened it, and is used the way the author asks. ${when} Say in what you hand in what you took from which. A reference is to learn from and to hold against: unless the author says so, its wording is not copied out at length, and its people and events are not carried into this book as they stand.
${guide}${listing.lines}`)
}

/**
 * The tools an agent reads the book's references with. None, where the book has none that are consulted.
 * @param names - what the tools are called for whoever gets them: the crew and the showrunner name theirs apart.
 */
export async function referenceTools(core: NovelCore, runtime: ProjectRuntime, signal?: AbortSignal, names: { read: string; search: string } = { read: 'reference_read', search: 'reference_search' }, /** Told of everything read or searched in a reference, in a few words: the list of them alone is no look. */ onLook?: (what: string) => void): Promise<RoleTool[]> {
  if ((await activeReferences(runtime)).length === 0) return []
  const lang: PromptLanguage = /^zh/i.test((await runtime.project.manifest()).language) ? 'zh' : 'en'
  const looked = <T>(what: string, result: T): T => {
    onLook?.(what)
    return result
  }
  const ready = async (named: string | undefined): Promise<{ reference: ReferenceInfo; other?: ProjectRuntime }> => {
    const reference = pick(await consulted(core, runtime, lang), named)
    if (reference.state === 'locked') throw new Error(`"${reference.name}" is locked: it cannot be read until its author unlocks it in Whalesong Studio — say so in your result, and work without it`)
    if (reference.state === 'missing') throw new Error(`"${reference.name}" is not where it was: it cannot be read — say so in your result, and work without it`)
    if (reference.kind === 'text') return { reference }
    const book = await shelfBook(core, reference)
    if (!('runtime' in book)) throw new Error(`"${reference.name}" cannot be read right now`)
    return { reference, other: book.runtime }
  }
  const closed = (reference: ReferenceInfo, aspect: ReferenceAspect): Error => new Error(`the author did not open ${ASPECT_WORD[aspect][1]} of "${reference.name}" to this book — open: ${scopeWords(reference, 'en')}`)
  return [
    {
      name: names.read,
      description: `Read in one of this book's references — another book the author has it go by. Without \`book\`: the list of them, what of each is open and what the author wants of it. A book of the shelf is read as its own book is: what=outline (its whole outline, or one chapter's plan with \`ref\`), chapter (its text, paged), memory (a chapter's digest), threads, character and world (the list, or one with \`ref\`), style. A manuscript taken in as plain text: what=contents (its parts, by number) and what=part with \`ref\` = a part's number (paged with offset / limit). What the author did not open of a reference is refused.`,
      parameters: {
        book: { type: 'string', description: 'Which reference: its id or its title. May be left out where the book has one only.' },
        what: { type: 'string', enum: ['outline', 'chapter', 'memory', 'threads', 'character', 'world', 'style', 'contents', 'part'], description: 'What to read of it. Left out with `book` left out: the list of references.' },
        ref: { type: 'string', description: 'Which one: a chapter (number, title or id), a character, a world entry, a style — or a part\'s number, for a manuscript.' },
        offset: { type: 'integer', description: 'For text: character offset to start from (default 0).' },
        limit: { type: 'integer', description: 'For text: most characters to return (default 6000, at most 40000).' },
      },
      async run(args) {
        const what = argText(args.what)
        if (what === undefined && argText(args.book) === undefined) {
          const all = await consulted(core, runtime, lang)
          return all.map(reference => line(reference, lang)).join('\n')
        }
        const { reference, other } = await ready(argText(args.book))
        if (other === undefined) {
          const { text, parts } = await textOf(runtime, reference)
          if (what === undefined || what === 'contents' || what === 'outline') {
            return looked(L(lang, `《${reference.name}》的目录`, `"${reference.name}": its contents`), `"${reference.name}" — ${text.length} characters in ${parts.length} part(s). Read one with what=part ref=<number>.\n${parts.map((part, at) => `${at + 1}. ${part.title} (${part.end - part.start})`).join('\n')}`)
          }
          if (what !== 'part' && what !== 'chapter') throw new Error(`"${reference.name}" is a manuscript kept as plain text: it has what=contents and what=part (and reference_search), no cards and no outline`)
          const wanted = argText(args.ref)
          const number = wanted !== undefined ? Number.parseInt(wanted.replace(/[^\d]/g, ''), 10) : Number.NaN
          const part = Number.isFinite(number) ? parts[number - 1] : parts.find(item => wanted !== undefined && (sameName(item.title, wanted) || item.title.includes(wanted)))
          if (part === undefined) throw new Error(`no part "${wanted ?? ''}" — what=contents lists the ${parts.length} part(s) by number`)
          const body = text.slice(part.start, part.end)
          const offset = Math.max(0, argInt(args.offset) ?? 0)
          const limit = Math.max(200, Math.min(40_000, argInt(args.limit) ?? 6000))
          const slice = body.slice(offset, offset + limit)
          return looked(L(lang, `《${reference.name}》第 ${parts.indexOf(part) + 1} 段`, `"${reference.name}": part ${parts.indexOf(part) + 1}`), `"${reference.name}", part ${parts.indexOf(part) + 1} "${part.title}", characters ${offset}–${offset + slice.length} of ${body.length}${offset + limit < body.length ? ` (continue with offset=${offset + slice.length})` : ''}:\n\n${slice}`)
        }
        const kind = (what ?? 'outline') as ReadKind
        const aspect = ASPECT_OF[kind]
        if (aspect === undefined) throw new Error('`what` is one of outline, chapter, memory, threads, character, world, style')
        if (!openTo(reference, aspect)) throw closed(reference, aspect)
        try {
          const read = `[${reference.name}]\n${(await readBook(other, { what: kind, ref: argText(args.ref), offset: argInt(args.offset), limit: argInt(args.limit) }, { read: names.read })).text}`
          const which = argText(args.ref)
          return looked(`${L(lang, `《${reference.name}》的`, `"${reference.name}": its `)}${L(lang, ...(READ_WORD[kind] ?? [kind, kind]))}${which !== undefined ? L(lang, `（${which}）`, ` (${which})`) : ''}`, read)
        } catch (error) {
          if (error instanceof ProjectError) throw new Error(error.message)
          throw error
        }
      },
    },
    {
      name: names.search,
      description: 'Search this book\'s references by keywords — or, in a book of the shelf, by meaning as well: its text, its character cards, its world entries, its chapter digests and outline, as far as the author opened it. `book` keeps the search to one reference; without it, every reference is searched.',
      parameters: {
        query: { type: 'string', required: true },
        book: { type: 'string', description: 'One reference, by id or title. Left out: all of them.' },
        limit: { type: 'integer', description: 'Most hits from each reference (default 6).' },
      },
      async run(args) {
        const query = argText(args.query)
        if (query === undefined) throw new Error('`query` is required')
        const limit = Math.max(1, Math.min(20, argInt(args.limit) ?? 6))
        const all = await consulted(core, runtime, lang)
        const among = argText(args.book) !== undefined ? [pick(all, argText(args.book))] : all
        const found: string[] = []
        let searched = 0
        for (const reference of among) {
          if (reference.state !== 'ready') {
            found.push(`[${reference.name}] cannot be read right now (${reference.state}).`)
            continue
          }
          if (reference.kind === 'text') {
            const { text, parts } = await textOf(runtime, reference)
            const hits = findInText(text, parts, query, limit)
            found.push(hits.length > 0
              ? hits.map(hit => `〔${reference.name} · part ${hit.part} "${hit.title}" @${hit.offset}〕\n${hit.snippet}`).join('\n\n')
              : `[${reference.name}] nothing matches "${query}" word for word — a plain text is searched by its words: try the words it would use.`)
            searched += 1
            continue
          }
          const book = await shelfBook(core, reference)
          if (!('runtime' in book)) continue
          const sources = (Object.keys(SOURCE_ASPECT) as (keyof typeof SOURCE_ASPECT)[]).filter(source => openTo(reference, SOURCE_ASPECT[source]))
          if (sources.length === 0) continue
          const hits = await searchBook(book.runtime, { query, sources, limit }, signal)
          found.push(`[${reference.name}]\n${hits.text}`)
          searched += 1
        }
        // Looked, where at least one of them could be searched.
        if (searched > 0) onLook?.(L(lang, `在${among.length === 1 ? `《${among[0]!.name}》` : '各本参考'}里搜“${clip(query, 24, '…')}”`, `searched ${among.length === 1 ? `"${among[0]!.name}"` : 'the references'} for "${clip(query, 40, '…')}"`))
        return found.join('\n\n')
      },
    },
  ]
}

/** How long a manuscript is, counted as a book's text is. For what the page says of it. */
export const wordsOf = (text: string): number => countWords(text)

/** What a reference is, in a few words, for a line of a result. */
export const referenceWord = (reference: BookReference): string => `${reference.title ?? reference.id} (${reference.kind === 'book' ? 'a book of the shelf' : `plain text, ${reference.chars ?? 0} characters`})${reference.note !== undefined ? ` — ${clip(reference.note, 120, '…')}` : ''}`

/** A list handed to a tool as an array or as words apart. */
export const aspectsOf = (value: unknown): ReferenceAspect[] | undefined => {
  const list = argList(typeof value === 'string' ? value.split(/[,，\s]+/) : value).filter((item): item is string => typeof item === 'string')
  return list.length > 0 ? REFERENCE_ASPECTS.filter(aspect => list.includes(aspect)) : undefined
}

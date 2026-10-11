// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Translation: a book's chapters from one language into another, by a model,
 * so that the whole of it says one thing one way.
 *
 * What makes a long translation hold together is not the model's memory but a
 * glossary: how every name and every word of the book's own is to be written
 * in the other language. It is settled first — off the bible's cards where
 * the book has them (who somebody is decides how their name and their forms
 * of address come out), out of the text where it has none yet (an import) —,
 * the terms a chapter uses go along with that chapter and say who and what
 * they are, a translation that meets a name without a rendering settles one
 * and hands it back, and when the work is done the cards learn the names they
 * now go by, so that everything that tells people by name (the digests, the
 * marks in the text, the context of the next chapter) still tells them.
 *
 * A chapter's translation takes the place of its text; what it was translated
 * from is kept as a version of the chapter, and noted as its original.
 */
import type { CharacterCard, GlossaryTerm, ModelRoute, WorldEntry } from '../../shared/types'
import { GLOSSARY_KINDS } from '../../shared/types'
import { keptPictures } from '../../shared/embedded'
import { clip, clipTail, countWords } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { assign } from '../crew'
import { asArray, asRecord, asText } from '../llm'
import { ProjectError, type LocatedChapter } from '../project'
import { termsSystem, termsTask, translateTask, translatorSystem } from '../prompts'
import { L, languageName, promptLanguage } from '../render'
import { errorMessage, mapLimit } from '../util/async'

/** Names handed to the analyst at a time when renderings are settled off the bible. */
const NAMES_AT_ONCE = 60
/** How much of the text is read at a time when the names are found in it. */
const SCAN_CHARS = 14_000

/** Mostly written in characters that stand for a word or a syllable each: such a text says more in a character. */
const dense = (text: string): boolean => (text.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length ?? 0) > text.length * 0.3

/** A text in stretches of whole paragraphs, none longer than a model translates in one reply. */
export function stretches(text: string, size = dense(text) ? 4500 : 11_000): string[] {
  const out: string[] = []
  let current = ''
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current.length > 0 && current.length + paragraph.length + 2 > size) {
      out.push(current)
      current = ''
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph
  }
  if (current.trim().length > 0) out.push(current)
  return out
}

const KINDS: readonly string[] = GLOSSARY_KINDS

/**
 * Terms as a model gave them: those that are terms, each once. A single character is no term — a model reading a
 * signboard half hidden in the fog hands in the one character it shows — unless it is a name the book has on a card.
 */
function termsOf(raw: unknown, names?: ReadonlyMap<string, string>): GlossaryTerm[] {
  const seen = new Set<string>()
  const out: GlossaryTerm[] = []
  for (const item of asArray(raw).map(asRecord)) {
    const [source, target] = [asText(item.source)?.trim(), asText(item.target)?.trim()]
    if (source === undefined || target === undefined || source.length === 0 || target.length === 0 || source.length > 80 || target.length > 120 || seen.has(source.toLowerCase())) continue
    if ([...source].length < 2 && names?.has(source) !== true) continue
    seen.add(source.toLowerCase())
    const [kind, note] = [asText(item.kind), asText(item.note)?.trim()]
    out.push({ source, target, ...(kind !== undefined && KINDS.includes(kind) ? { kind: kind as NonNullable<GlossaryTerm['kind']> } : {}), ...(note !== undefined && note.length > 0 ? { note: clip(note, 80) } : {}) })
  }
  return out
}

/**
 * What a translator's reply holds: the title where one was asked for, the translation, and the names it settled.
 * A reply is prose first and last — whatever of the rest is missing or broken is left out, not the translation.
 */
export function readTranslation(reply: string, titled: boolean): { title?: string; text: string; terms: GlossaryTerm[] } {
  const [prose, ...rest] = reply.split(/^\s*={3,}\s*TERMS\s*={3,}\s*$/mi)
  let terms: GlossaryTerm[] = []
  const listed = rest.join('\n')
  const [open, close] = [listed.indexOf('['), listed.lastIndexOf(']')]
  if (open >= 0 && close > open) {
    try { terms = termsOf(JSON.parse(listed.slice(open, close + 1))) } catch { /* the translation stands without them */ }
  }
  let text = (prose ?? '').replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n```\s*$/, '').trim()
  let title: string | undefined
  if (titled) {
    const first = /^#{1,3}\s+(.+?)\s*(?:\n|$)/.exec(text)
    if (first !== null) {
      title = first[1]!.trim()
      text = text.slice(first[0].length).trim()
    }
  }
  return { ...(title !== undefined && title.length > 0 ? { title } : {}), text, terms }
}

/**
 * A translation with its pictures where the original has them: a picture's line is a path into the book's files, and
 * a path a translator "translated" shows nothing. Each picture of the translation gets the path of the one at its
 * place in the original (what is said under it stays as translated); one the translator left out goes back in, as far
 * down the text as it stood ({@link keptPictures}).
 */
export function samePictures(original: string, translated: string): string {
  return keptPictures(original, translated, { captions: 'theirs' }).text
}

/** Whether a text has a word in it: a name in letters as a whole word whatever its case, anything else as it stands. */
function has(text: string, lower: string, word: string): boolean {
  if (!/^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\d\s'’.-]+$/u.test(word)) return text.includes(word)
  const at = lower.indexOf(word.toLowerCase())
  if (at < 0) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(lower)
}

/** A term as a translator reads it: the word, its rendering, and what it is. */
const termLine = (term: GlossaryTerm): string => `- ${term.source} → ${term.target}${term.note !== undefined ? `（${term.note}）` : ''}`

/** Who or what a card is, in the few words a translator needs. */
function about(lang: 'zh' | 'en', of: CharacterCard | WorldEntry, kind: 'person' | WorldEntry['category']): string {
  const zh = lang === 'zh'
  if (kind === 'person') {
    const card = of as CharacterCard
    return [card.gender, card.age, card.tagline].filter((part): part is string => part !== undefined && part.trim().length > 0).map(part => clip(part.trim(), 40)).join(zh ? '；' : '; ')
  }
  return clip((of as WorldEntry).summary?.trim() ?? '', 50)
}

/** What kind of term an entry of the bible is. */
const kindOf = (category: WorldEntry['category']): NonNullable<GlossaryTerm['kind']> => (category === 'location' || category === 'setting' ? 'place' : category === 'faction' ? 'house' : category === 'item' ? 'thing' : 'term')

export interface SettleParams {
  /** The language the names are settled for. */
  to: string
  /** The language the book is in; left out, the book's own. */
  from?: string
  /** Find names in the text too — these chapters', or every chapter's with `true`. What a book without cards needs. */
  scan?: string[] | boolean
  direction?: string
}

export interface SettleResult {
  added: GlossaryTerm[]
  total: number
  /** Passes that came back with nothing usable: the names they were about are settled by whichever translation meets them. */
  failed: string[]
}

/**
 * Settle how the book's names are written in a language: every person and entry of the bible that has no rendering
 * yet (with every other name they go by), and — where asked — whatever proper names the text itself has. What is
 * settled stands: a pass adds, and writes over nothing.
 */
export async function settleTerms(core: NovelCore, runtime: ProjectRuntime, params: SettleParams, task: TaskContext): Promise<SettleResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(params.to)
  const from = params.from ?? manifest.language
  const system = termsSystem({ lang, title: manifest.title, ...(from !== params.to ? { from } : {}), to: params.to })
  const added: GlossaryTerm[] = []
  const failed: string[] = []
  const known = async (): Promise<Set<string>> => new Set((await project.glossary(params.to)).map(term => term.source.toLowerCase()))
  const settled = async (): Promise<string> => clip((await project.glossary(params.to)).map(term => `${term.source} → ${term.target}`).join('\n'), 6000)
  /** Take what a pass settled: only what is new, each tied to the card it names where it is one's name. */
  const take = async (terms: GlossaryTerm[], cards?: Map<string, string>): Promise<void> => {
    const fresh: GlossaryTerm[] = []
    await project.updateGlossary(params.to, (current) => {
      const have = new Set(current.map(term => term.source.toLowerCase()))
      for (const term of terms) {
        if (have.has(term.source.toLowerCase())) continue
        have.add(term.source.toLowerCase())
        const of = cards?.get(term.source)
        fresh.push({ ...term, ...(of !== undefined ? { of } : {}) })
      }
      return [...current, ...fresh]
    })
    added.push(...fresh)
  }
  const ask = async (label: string, prompt: string, names?: ReadonlyMap<string, string>): Promise<GlossaryTerm[]> => {
    const { value } = await assign(core, runtime, task, {
      role: 'analyst',
      label,
      tool: 'record_terms',
      // The names and what they are — or the text to find them in — are in the task.
      plain: true,
      what: L(lang, '译名表：每个名字的译法', 'the glossary: a rendering for every name'),
      system,
      prompt,
      temperature: 0.1,
      validate: raw => ({ terms: termsOf(asRecord(raw).terms, names) }),
    })
    return value.terms
  }

  // ── off the bible: who somebody is decides how their names come out ──
  const [characters, world] = await Promise.all([project.characters(), project.world()])
  const have = await known()
  const cards = new Map<string, string>()
  const lines: string[] = []
  const also = L(lang, '又叫', 'also')
  for (const card of characters) {
    const names = [card.name, ...(card.aliases ?? [])].filter(name => name.trim().length > 0)
    for (const name of names) cards.set(name, `character:${card.id}`)
    if (names.every(name => have.has(name.toLowerCase()))) continue
    lines.push(`- ${card.name}${lang === 'zh' ? '｜人物' : ' | person'}${about(lang, card, 'person').length > 0 ? `${lang === 'zh' ? '｜' : ' | '}${about(lang, card, 'person')}` : ''}${names.length > 1 ? `${lang === 'zh' ? '｜' : ' | '}${also}: ${names.slice(1).join(' / ')}` : ''}`)
  }
  for (const entry of world) {
    const names = [entry.name, ...(entry.aliases ?? [])].filter(name => name.trim().length > 0)
    for (const name of names) if (!cards.has(name)) cards.set(name, `world:${entry.id}`)
    if (names.every(name => have.has(name.toLowerCase()))) continue
    lines.push(`- ${entry.name}${lang === 'zh' ? '｜' : ' | '}${kindOf(entry.category)}${about(lang, entry, entry.category).length > 0 ? `${lang === 'zh' ? '｜' : ' | '}${about(lang, entry, entry.category)}` : ''}${names.length > 1 ? `${lang === 'zh' ? '｜' : ' | '}${also}: ${names.slice(1).join(' / ')}` : ''}`)
  }
  const scanned = params.scan === true ? (await project.chapters()).map(chapter => chapter.plan.id) : Array.isArray(params.scan) ? params.scan : []
  const groups = Math.ceil(lines.length / NAMES_AT_ONCE)
  // One group after another: a family's name settled in the first is in front of whoever settles the second.
  for (let at = 0; at < groups; at++) {
    task.signal?.throwIfAborted()
    task.job?.progress(at, groups + (scanned.length > 0 ? 1 : 0), L(lang, `定译名：设定里的名字 ${Math.min(lines.length, (at + 1) * NAMES_AT_ONCE)}/${lines.length}`, `settling names off the bible ${Math.min(lines.length, (at + 1) * NAMES_AT_ONCE)}/${lines.length}`))
    try {
      await take(await ask(L(lang, '定译名', 'settling names'), termsTask({ lang, settled: await settled(), names: lines.slice(at * NAMES_AT_ONCE, (at + 1) * NAMES_AT_ONCE).join('\n'), ...(params.direction !== undefined ? { direction: params.direction } : {}) }), cards), cards)
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      failed.push(errorMessage(error))
    }
  }

  // ── out of the text: what has no card ──
  if (scanned.length > 0) {
    const pieces: string[] = []
    let current = ''
    for (const id of scanned) {
      for (const stretch of stretches(await project.chapterText(id), SCAN_CHARS)) {
        if (current.length > 0 && current.length + stretch.length > SCAN_CHARS) {
          pieces.push(current)
          current = ''
        }
        current = current.length > 0 ? `${current}\n\n${stretch}` : stretch
      }
    }
    if (current.trim().length > 0) pieces.push(current)
    let done = 0
    // In the book's order, a few at a time: of two renderings of one name, the one from earlier in the book stands.
    const found = await mapLimit(pieces, 4, async (piece) => {
      try {
        return await ask(L(lang, '从正文里找专名', 'finding names in the text'), termsTask({ lang, settled: await settled(), text: piece, ...(params.direction !== undefined ? { direction: params.direction } : {}) }))
      } catch (error) {
        if (task.signal?.aborted === true) throw error
        failed.push(errorMessage(error))
        return []
      } finally {
        task.job?.progress(groups + (++done) / pieces.length, groups + 1, L(lang, `定译名：读正文 ${done}/${pieces.length}`, `settling names: reading the text ${done}/${pieces.length}`))
      }
    }, task.signal)
    for (const terms of found) await take(terms, cards)
  }
  return { added, total: (await project.glossary(params.to)).length, failed }
}

export interface TranslateParams {
  /** The chapters to translate, by id or number. Left out: every chapter of `line` that has text. */
  chapters?: string[]
  /** The line of the plot whose chapters are meant; left out, the main one. */
  line?: string
  to: string
  /** The language the text is in. Left out: what each chapter is in — the book's language, or what it was last translated into; `auto` lets the translator tell. */
  from?: string
  /** Settle the names first. Default: yes where the glossary has nothing for this language yet. */
  settle?: boolean
  /** Find names in the text when settling (a book without cards). Default: where the book has no cards. */
  scan?: boolean
  /** What the author asks of the translation. */
  direction?: string
}

export interface TranslateResult {
  translated: { chapter: string; title: string; words: number }[]
  /** Chapters left as they are, and why: nothing written in them, in the language asked for already. */
  skipped: { chapter: string; why: 'empty' | 'same' }[]
  failed: { chapter: string; error: string }[]
  terms: { added: number; total: number }
  /** Cards and entries that learned the name they go by in the translation. */
  named: number
  /** The book's language, where the translation made it another: every chapter with text is in it now. */
  language?: string
}

interface Translated {
  title: string
  text: string
  terms: GlossaryTerm[]
}

/** Translate one text — a chapter's — stretch by stretch. */
async function translateText(core: NovelCore, route: ModelRoute, task: TaskContext, work: {
  lang: 'zh' | 'en'
  system: string
  title: string
  text: string
  /** The glossary, with what each term is. */
  terms: GlossaryTerm[]
  /** How the chapter before ends in translation. */
  before?: string
  onText?: (soFar: string) => void
}): Promise<Translated> {
  const parts = stretches(work.text)
  const out: string[] = []
  const coined: GlossaryTerm[] = []
  let title = work.title
  const lowered = (text: string): string => text.toLowerCase()
  const one = async (text: string, first: boolean, part: string | undefined, depth: number): Promise<void> => {
    const lower = lowered(text)
    const using = [...work.terms, ...coined].filter(term => has(text, lower, term.source) || (first && has(work.title, lowered(work.title), term.source)))
    const before = out.length > 0 ? clipTail(out.at(-1)!, 500) : work.before
    const sofar = out.join('\n\n')
    const response = await core.llm.complete({
      route,
      system: work.system,
      prompt: translateTask({ lang: work.lang, ...(first ? { title: work.title } : {}), text, terms: using.map(termLine).join('\n'), ...(before !== undefined ? { before } : {}), ...(part !== undefined ? { part } : {}) }),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(work.onText !== undefined ? { onText: (_delta: string, total: string) => { work.onText!(sofar.length > 0 ? `${sofar}\n\n${total}` : total) } } : {}),
    })
    // The reply ran out of room before the stretch did: in two halves, each fits.
    if (response.finish === 'max-tokens' && depth < 3) {
      const paragraphs = text.split(/\n{2,}/)
      if (paragraphs.length > 1) {
        const half = Math.ceil(paragraphs.length / 2)
        await one(paragraphs.slice(0, half).join('\n\n'), first, part, depth + 1)
        await one(paragraphs.slice(half).join('\n\n'), false, part, depth + 1)
        return
      }
    }
    const read = readTranslation(response.text, first)
    if (read.text.length === 0) throw new ProjectError('novel/empty', L(work.lang, '译者的回复里没有译文。请再试一次。', 'the translator\'s reply held no translation — try again'))
    if (first && read.title !== undefined) title = read.title
    out.push(read.text)
    for (const term of read.terms) if (![...work.terms, ...coined].some(other => other.source.toLowerCase() === term.source.toLowerCase())) coined.push(term)
  }
  for (let at = 0; at < parts.length; at++) {
    task.signal?.throwIfAborted()
    await one(parts[at]!, at === 0, parts.length > 1 ? `${at + 1}/${parts.length}` : undefined, 0)
  }
  return { title, text: out.join('\n\n'), terms: coined }
}

/**
 * Translate chapters of the book into a language: the names first (where none are settled), then every chapter by
 * the glossary — several at a time, each with the terms it uses and what they are —, and then the cards learn their
 * names. A chapter's translation takes the place of its text; the text it was made from is kept as a version.
 * One chapter that fails does not stop the others.
 */
export async function translateChapters(core: NovelCore, runtime: ProjectRuntime, params: TranslateParams, task: TaskContext): Promise<TranslateResult> {
  const { project } = runtime
  const manifest = await project.manifest()
  const to = params.to.trim()
  if (to.length === 0) throw new ProjectError('novel/invalid', 'a translation needs the language to translate into (`to`)')
  const lang = promptLanguage(to)
  const all = await project.chapters(params.line)
  let chosen: LocatedChapter[]
  if (params.chapters !== undefined && params.chapters.length > 0) {
    chosen = []
    for (const ref of params.chapters) {
      const located = await project.findChapter(ref)
      if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
      if (!chosen.some(other => other.plan.id === located.plan.id)) chosen.push(located)
    }
  } else chosen = all
  const noted = await project.translations()
  /** The language a chapter is in now. */
  const inNow = (id: string): string => noted[id]?.to ?? manifest.language
  const skipped: TranslateResult['skipped'] = []
  const todo: { chapter: LocatedChapter; text: string; from?: string }[] = []
  for (const chapter of chosen) {
    const text = await project.chapterText(chapter.plan.id)
    if (text.trim().length === 0) { skipped.push({ chapter: chapter.plan.id, why: 'empty' }); continue }
    const from = params.from === 'auto' ? undefined : params.from ?? inNow(chapter.plan.id)
    if (from === to) { skipped.push({ chapter: chapter.plan.id, why: 'same' }); continue }
    todo.push({ chapter, text, ...(from !== undefined ? { from } : {}) })
  }
  const result: TranslateResult = { translated: [], skipped, failed: [], terms: { added: 0, total: (await project.glossary(to)).length }, named: 0 }
  if (todo.length === 0) return result
  task.job?.result({ chapterIds: todo.map(item => item.chapter.plan.id) })

  // ── 1. the names ──
  const from = todo[0]!.from
  const bare = (await project.characters()).length + (await project.world()).length === 0
  if (params.settle ?? result.terms.total === 0) {
    const settled = await settleTerms(core, runtime, { to, ...(from !== undefined ? { from } : {}), ...((params.scan ?? bare) ? { scan: todo.map(item => item.chapter.plan.id) } : {}), ...(params.direction !== undefined ? { direction: params.direction } : {}) }, task)
    result.terms.added += settled.added.length
    for (const error of settled.failed) task.job?.write(`${L(lang, '定译名时有一遍没成', 'a pass over the names failed')}: ${error}\n`)
  }

  // ── 2. the chapters ──
  const route = await core.route('writer', runtime, task)
  const system = translatorSystem({ lang, title: manifest.title, ...(from !== undefined ? { from } : {}), to, ...(params.direction !== undefined ? { direction: params.direction } : {}) })
  const [characters, world] = await Promise.all([project.characters(), project.world()])
  /** A term with what it is: the glossary's own note, else what the card it names says of itself. */
  const told = (term: GlossaryTerm): GlossaryTerm => {
    if (term.note !== undefined || term.of === undefined) return term
    const [kind, id] = [term.of.slice(0, term.of.indexOf(':')), term.of.slice(term.of.indexOf(':') + 1)]
    const card = kind === 'character' ? characters.find(item => item.id === id) : undefined
    const entry = kind === 'world' ? world.find(item => item.id === id) : undefined
    const note = card !== undefined ? about(lang, card, 'person') : entry !== undefined ? about(lang, entry, entry.category) : ''
    return note.length > 0 ? { ...term, note } : term
  }
  let done = 0
  const single = todo.length === 1
  task.job?.progress(0, todo.length, L(lang, `翻译成${languageName(to)}`, `translating into ${languageName(to)}`))
  // All of them at the gate at once: how many are with the model at a time is the gate's to say (the text concurrency of the settings).
  await mapLimit(todo, 256, async ({ chapter, text }) => {
    const id = chapter.plan.id
    try {
      await core.through('text', async () => {
        const glossary = (await project.glossary(to)).map(told)
        // The chapter before it on its line, where that is in the language already: its last words give the voice to go on in.
        const at = all.findIndex(other => other.plan.id === id)
        const previous = at > 0 ? all[at - 1]! : undefined
        const before = previous !== undefined && ((await project.translations())[previous.plan.id]?.to ?? manifest.language) === to ? clipTail(await project.chapterText(previous.plan.id), 500) : undefined
        const made = await translateText(core, route, task, {
          lang, system, title: chapter.plan.title, text, terms: glossary,
          ...(before !== undefined && before.trim().length > 0 ? { before } : {}),
          ...(single ? { onText: (soFar: string) => { task.job?.rewrite(soFar) } } : {}),
        })
        // What it was translated from is the version taken now: the chapter's original, to go back to or to read beside.
        const version = await project.snapshot(id, 'before-translate', text)
        await project.saveChapterText(id, samePictures(text, made.text), { snapshot: false })
        if (made.title !== chapter.plan.title) await project.updateChapter(id, { title: made.title })
        // Translated a second time (into a third language), the original is still the first text it had, under its first title.
        await project.noteTranslation(id, {
          ...(noted[id]?.from !== undefined ? { from: noted[id].from } : inNow(id) !== to && params.from !== 'auto' ? { from: params.from ?? inNow(id) } : {}),
          to,
          at: new Date().toISOString(),
          ...(noted[id]?.version !== undefined ? { version: noted[id].version } : version !== undefined ? { version } : {}),
          title: noted[id]?.title ?? chapter.plan.title,
        })
        if (made.terms.length > 0) {
          const before = (await project.glossary(to)).length
          const after = await project.updateGlossary(to, current => [...current, ...made.terms])
          result.terms.added += after.length - before
        }
        result.translated.push({ chapter: id, title: made.title, words: countWords(made.text) })
      }, { ...(task.signal !== undefined ? { signal: task.signal } : {}), retry: false }, runtime)
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      result.failed.push({ chapter: id, error: errorMessage(error) })
      task.job?.write(`${chapter.index}. ${chapter.plan.title}: ${errorMessage(error)}\n`)
    } finally {
      task.job?.progress(++done, todo.length, L(lang, `翻译成${languageName(to)} ${done}/${todo.length}`, `translating into ${languageName(to)} ${done}/${todo.length}`))
    }
  }, task.signal)
  // In the book's order, however they came back.
  const order = new Map(todo.map((item, index) => [item.chapter.plan.id, index]))
  result.translated.sort((left, right) => order.get(left.chapter)! - order.get(right.chapter)!)

  // ── 3. the cards learn their names ──
  if (result.translated.length > 0) result.named = await learnNames(runtime, to)
  result.terms.total = (await project.glossary(to)).length

  // Every chapter of the book that has text is in the language now: it is the book's.
  if (manifest.language !== to) {
    const after = await project.translations()
    const lines = [undefined, ...((await project.outline()).lines ?? []).map(line => line.id)]
    let whole = true
    for (const line of lines) {
      for (const info of await project.chapterInfos(line)) if (info.hasText && after[info.id]?.to !== to) whole = false
    }
    if (whole) {
      await project.updateManifest({ language: to, ...(manifest.translatedFrom === undefined ? { translatedFrom: manifest.language } : {}) })
      result.language = to
    }
  }
  return result
}

/**
 * Give every card and entry the name the glossary has for it as another name it goes by: a translated chapter writes
 * that name, and whatever tells people and places by their names — the digests, the marks in the text, the context
 * the next chapter is written with — goes by a card's names.
 * @returns how many cards and entries learned one.
 */
export async function learnNames(runtime: ProjectRuntime, to: string): Promise<number> {
  const { project } = runtime
  const glossary = await project.glossary(to)
  const learned = new Map<string, Set<string>>()
  for (const term of glossary) {
    if (term.of === undefined) continue
    const names = learned.get(term.of) ?? new Set<string>()
    names.add(term.target)
    learned.set(term.of, names)
  }
  let count = 0
  for (const [of, names] of learned) {
    const [kind, id] = [of.slice(0, of.indexOf(':')), of.slice(of.indexOf(':') + 1)]
    const card = kind === 'character' ? (await project.characters()).find(item => item.id === id) : (await project.world()).find(item => item.id === id)
    if (card === undefined) continue
    const have = new Set([card.name, ...(card.aliases ?? [])].map(name => name.toLowerCase()))
    const fresh = [...names].filter(name => !have.has(name.toLowerCase()))
    if (fresh.length === 0) continue
    const aliases = [...(card.aliases ?? []), ...fresh]
    if (kind === 'character') await project.saveCharacter({ id, aliases })
    else await project.saveWorld({ id, aliases })
    count += 1
  }
  return count
}

/**
 * Put a chapter's original back: the text it was translated from takes the place of the translation (which is kept
 * as a version in turn).
 * @throws ProjectError `novel/not-found` for a chapter that is no translation, or whose original is no longer kept.
 */
export async function untranslateChapter(runtime: ProjectRuntime, ref: string): Promise<{ chapter: string }> {
  const { project } = runtime
  const located = await project.findChapter(ref)
  if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
  const note = (await project.translations())[located.plan.id]
  if (note?.version === undefined) throw new ProjectError('novel/not-found', `chapter "${ref}" has no original on record: it is not a translation made here`)
  const ok = await project.restoreVersion(located.plan.id, note.version)
  if (!ok) throw new ProjectError('novel/not-found', 'the version that held the original is no longer kept')
  if (note.title !== undefined && note.title !== located.plan.title) await project.updateChapter(located.plan.id, { title: note.title })
  await project.noteTranslation(located.plan.id)
  return { chapter: located.plan.id }
}

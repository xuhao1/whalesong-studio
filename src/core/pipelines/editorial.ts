// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What an editorial pass is handed — a review of a chapter, a revision settled — laid out in four layers, the
 * steadiest first.
 *
 * A pass used to start from the story so far word for word: as much of the earlier text as half the model's window
 * holds, for every step of an agent that had tools to read it with anyway. On a long book that was hundreds of
 * thousands of tokens a step; the window of text slid forward chapter by chapter, so nothing of it was the head of
 * the next chapter's request; and whoever settled the changes afterwards read the same chapter again from another
 * pack of its own.
 *
 * Here every pass of a book starts the same way, and reads the rest:
 *
 *  1. **the book's base** — what the book is, how it is written and what the author added for whoever writes it, the
 *     author's standing notes, everybody and everything of the bible by name with a line each, the outline, the
 *     threads still open. It changes when the bible or the outline does, and is the head of every pass of the book.
 *  2. **the story so far, in outline** — a summary a chapter, in order: only ever added to at its end, so the head
 *     of one chapter's request is the head of the next one's. A map of where things were told, not the telling:
 *     what is concluded from it is checked against the text it points at.
 *  3. **the chapter in hand** — its plan, where its people stood before it, how the chapter before ends, and its
 *     text word for word. It changes when the chapter does: the passes of one chapter share it.
 *  4. **this piece of work** — what the author said, what is already on file, what to hand in. Said last, because
 *     it is the only part that is never the same twice.
 *
 * The tools are for evidence: the sentence of an earlier chapter a claim rests on is fetched and quoted, and what is
 * quoted is looked for where it is said to stand ({@link checkEvidence}).
 */
import { belongsTo, MAIN_LINE, type CharacterCard, type CharacterMoment, type PromptLanguage, type WorldEntry } from '../../shared/types'
import { clip, clipTail, fuzzyFind } from '../../shared/text'
import type { ProjectRuntime } from '../core'
import type { LocatedChapter } from '../project'
import { L, renderPlan } from '../render'

/** People and entries named one by one in the base; beyond these, the rest are counted and found by name. */
const CAST_NAMED = 400
const WORLD_NAMED = 300
const THREADS_NAMED = 80
/** How much of the chapter before goes with the one in hand: how it ends. */
const BEFORE_TAIL = 700

const one = (text: string | undefined, most: number): string => (text === undefined ? '' : clip(text.replace(/\s+/g, ' ').trim(), most))

/**
 * Layer 1 — the book's base: the same for every pass of the book on this line of the plot, whichever chapter it is
 * about, until the bible or the outline changes.
 */
export async function bookBase(runtime: ProjectRuntime, lang: PromptLanguage, line?: string): Promise<string> {
  const { project } = runtime
  const manifest = await project.manifest()
  const scope = await project.lineScope(line)
  const style = await project.activeStyle()
  const parts: string[] = []
  const about = [
    manifest.genre !== undefined ? `${L(lang, '类型', 'Genre')}${L(lang, '：', ': ')}${manifest.genre}` : undefined,
    // (A line that is a story of its own from the first page is not told by what the book says its story is: that is the main line's.)
    manifest.logline !== undefined && !scope.apart ? `${L(lang, '一句话', 'Logline')}${L(lang, '：', ': ')}${manifest.logline}` : undefined,
    manifest.premise !== undefined && !scope.apart ? `${L(lang, '故事', 'Premise')}${L(lang, '：', ': ')}${one(manifest.premise, 900)}` : undefined,
    scope.title !== undefined ? `${L(lang, '这条线', 'This line of the plot')}${L(lang, '：', ': ')}${scope.title}${scope.premise !== undefined ? ` — ${one(scope.premise, 300)}` : ''}` : undefined,
  ].filter((part): part is string => part !== undefined)
  parts.push(`# ${L(lang, `《${manifest.title.replace(/^[《「『“"]+|[》」』”"]+$/gu, '')}》`, `"${manifest.title}"`)}${about.length > 0 ? `\n${about.join('\n')}` : ''}`)
  if (manifest.notes !== undefined && manifest.notes.trim().length > 0) parts.push(`## ${L(lang, '作者的总备注（每一步都照它）', 'The author\'s standing notes (every pass goes by them)')}\n${manifest.notes.trim()}`)
  if (style !== undefined) {
    const said = [
      style.pov !== undefined ? `${L(lang, '视角', 'point of view')}${L(lang, '：', ': ')}${style.pov}` : undefined,
      style.register, style.tone, style.diction, style.rhythm, style.imagery, style.dialogue, style.pacing,
      ...(style.rules ?? []).map(rule => `${L(lang, '必须', 'always')}${L(lang, '：', ': ')}${rule}`),
      ...(style.avoid ?? []).map(item => `${L(lang, '避免', 'never')}${L(lang, '：', ': ')}${item}`),
      style.body,
    ].filter((part): part is string => part !== undefined && part.trim().length > 0)
    const extra = style.system?.trim()
    parts.push(`## ${L(lang, `设定的文风：${style.name}`, `The style set for it: ${style.name}`)}\n${said.map(item => `- ${item.trim()}`).join('\n')}${extra !== undefined && extra.length > 0 ? `\n\n${L(lang, '作者给写手另加的要求（写这本书的每一位都被这样要求）：', 'What the author added for whoever writes the book (every writer of it is told so):')}\n${extra}` : ''}`)
  }
  // Everybody and everything of the bible by name: what there is to look up, so that nothing is taken for unknown
  // that has a card, and no name is made up that has none.
  const cards = (await project.characters()).filter(card => scope.has(card))
  const rank: Record<string, number> = { protagonist: 0, antagonist: 1, deuteragonist: 1, supporting: 2, minor: 3, cameo: 4 }
  const cast = [...cards].sort((left, right) => (rank[left.role] ?? 3) - (rank[right.role] ?? 3))
  if (cast.length > 0) {
    const lines = cast.slice(0, CAST_NAMED).map((card: CharacterCard) => `- ${card.name}${card.aliases !== undefined && card.aliases.length > 0 ? `（${card.aliases.slice(0, 4).join(L(lang, '、', ', '))}）` : ''}${card.tagline !== undefined ? ` · ${one(card.tagline, 50)}` : ''}`)
    parts.push(`## ${L(lang, `人物（${cast.length} 人，各一行；要看整张卡用 book_read what=character）`, `People (${cast.length}, a line each; a whole card with book_read what=character)`)}\n${lines.join('\n')}${cast.length > CAST_NAMED ? `\n${L(lang, `……另有 ${cast.length - CAST_NAMED} 人，按名字查得到`, `… and ${cast.length - CAST_NAMED} more, found by name`)}` : ''}`)
  }
  const world = (await project.world()).filter(entry => scope.knows(entry)).sort((left, right) => right.importance - left.importance)
  if (world.length > 0) {
    const lines = world.slice(0, WORLD_NAMED).map((entry: WorldEntry) => `- ${entry.name}${entry.aliases !== undefined && entry.aliases.length > 0 ? `（${entry.aliases.slice(0, 3).join(L(lang, '、', ', '))}）` : ''} · ${entry.category}${entry.summary !== undefined ? ` · ${one(entry.summary, 60)}` : ''}`)
    parts.push(`## ${L(lang, `设定（${world.length} 条，各一行；要看全文用 book_read what=world）`, `The world (${world.length} entries, a line each; one in full with book_read what=world)`)}\n${lines.join('\n')}${world.length > WORLD_NAMED ? `\n${L(lang, `……另有 ${world.length - WORLD_NAMED} 条，按名字查得到`, `… and ${world.length - WORLD_NAMED} more, found by name`)}` : ''}`)
  }
  if (scope.path.length > 0) {
    const lines = scope.path.map(chapter => `${chapter.index}. ${L(lang, `《${chapter.plan.title}》`, `"${chapter.plan.title}"`)}${chapter.plan.synopsis !== undefined ? ` ${one(chapter.plan.synopsis, 70)}` : ''}`)
    parts.push(`## ${L(lang, '全书章纲（作者的安排；写出来是什么样看下面的前情）', 'The outline (the author\'s plan; what was written is under the story so far)')}\n${lines.join('\n')}`)
  }
  const open = scope.threads.filter(entry => entry.open).slice(0, THREADS_NAMED)
  if (open.length > 0) {
    const at = (id: string): string => `#${scope.path.find(chapter => chapter.plan.id === id)?.index ?? '?'}`
    parts.push(`## ${L(lang, '还没收的线索', 'Threads still open')}\n${open.map(({ thread }) => `- ${thread.title}${thread.description !== undefined ? ` · ${one(thread.description, 70)}` : ''}${thread.planted !== undefined && thread.planted.length > 0 ? ` (${L(lang, '埋于', 'planted')} ${thread.planted.map(at).join(' ')})` : ''}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * Layer 2 — the story so far, in outline: a summary a chapter, in order, of the chapters before `upTo` on its line
 * (of every chapter where none is named). Each chapter's line is the same whichever chapter is in hand, so what
 * stands before one chapter is the head of what stands before the next.
 * @returns the block, and how many of its chapters had no memory to tell them by (told by their plans instead).
 */
export async function storyLedger(runtime: ProjectRuntime, lang: PromptLanguage, upTo?: LocatedChapter, line?: string): Promise<{ text: string; chapters: number; unread: number }> {
  const { project } = runtime
  const path = upTo !== undefined ? await project.pathOf(upTo.plan.id) : (await project.lineScope(line)).path
  const before = upTo !== undefined ? path.filter(chapter => chapter.index < upTo.index) : path
  const memories = new Map((await project.memories(path)).map(entry => [entry.chapter.plan.id, entry.memory]))
  const lines: string[] = []
  let unread = 0
  for (const chapter of before) {
    const memory = memories.get(chapter.plan.id)
    const head = L(lang, `第${chapter.index}章《${chapter.plan.title}》`, `Ch. ${chapter.index} "${chapter.plan.title}"`)
    if (memory !== undefined) lines.push(`${head}${memory.storyTime !== undefined ? `（${memory.storyTime}）` : ''}  ${memory.summary.replace(/\s+/g, ' ').trim()}`)
    else if ((await project.chapterText(chapter.plan.id)).length > 0) {
      unread += 1
      lines.push(`${head}  ${L(lang, '（写了，还没收录：这里只有章纲）', '(written, not digested: its plan only)')}${one(chapter.plan.synopsis, 200)}`)
    }
  }
  if (lines.length === 0) return { text: '', chapters: 0, unread }
  const head = L(lang,
    '前情（按章，各章写了什么；这是梗概，用来知道事情写在哪——要说它和哪里对不上，回到那一章的原文去核对）',
    'The story so far (chapter by chapter, what each tells; an outline, for knowing where a thing was told — before saying something is at odds with it, check it in that chapter\'s own text)')
  return { text: `## ${head}\n${lines.join('\n')}`, chapters: lines.length, unread }
}

/** Where each of some people stood before a chapter: what the latest chapter that has them says of them at its end. */
async function standings(runtime: ProjectRuntime, chapter: LocatedChapter, lang: PromptLanguage, text: string): Promise<string> {
  const { project } = runtime
  const path = (await project.pathOf(chapter.plan.id)).filter(candidate => candidate.index < chapter.index)
  if (path.length === 0) return ''
  const cards = await project.characters()
  // Whoever the chapter's plan casts, and whoever its text names.
  const planned = new Set([...(chapter.plan.characters ?? []), ...((chapter.plan.beats ?? []).flatMap(beat => beat.characters ?? []))])
  const here = cards.filter(card => planned.has(card.id) || planned.has(card.name) || text.includes(card.name) || (card.aliases ?? []).some(alias => alias.length > 1 && text.includes(alias)))
  if (here.length === 0) return ''
  const memories = await project.memories(path)
  const lines: string[] = []
  for (const card of here.slice(0, 24)) {
    let last: { index: number; moment: CharacterMoment } | undefined
    for (const { chapter: told, memory } of memories) {
      const moment = memory.characters.find(candidate => candidate.character === card.id || candidate.name === card.name)
      if (moment !== undefined && (last === undefined || told.index > last.index)) last = { index: told.index, moment }
    }
    if (last === undefined) continue
    const said = [last.moment.stateAfter, last.moment.location !== undefined ? `${L(lang, '在', 'at')} ${last.moment.location}` : undefined, last.moment.learned !== undefined && last.moment.learned.length > 0 ? `${L(lang, '已知', 'knows')}${L(lang, '：', ': ')}${last.moment.learned.slice(0, 3).join(L(lang, '；', '; '))}` : undefined].filter((part): part is string => part !== undefined && part.trim().length > 0)
    if (said.length > 0) lines.push(`- ${card.name}（${L(lang, `第 ${last.index} 章末`, `end of ch. ${last.index}`)}）${one(said.join(L(lang, '；', '; ')), 220)}`)
  }
  return lines.length > 0 ? `### ${L(lang, '出场人物在这一章之前的状态（各取最近一次；出处是那一章的记忆）', 'Where its people stood before it (the latest for each; from that chapter\'s memory)')}\n${lines.join('\n')}` : ''
}

/**
 * Layer 3 — the chapter in hand: its plan, where its people stood, how the chapter before ends, and its own text.
 * @param text - the chapter as the pass goes by it, where that is not how the manuscript has it.
 */
export async function chapterInHand(runtime: ProjectRuntime, chapter: LocatedChapter, lang: PromptLanguage, text?: string): Promise<string> {
  const { project } = runtime
  const own = text ?? await project.chapterText(chapter.plan.id)
  const cards = await project.characters()
  const nameOf = (ref: string): string => cards.find(card => card.id === ref)?.name ?? ref
  const path = await project.pathOf(chapter.plan.id)
  const previous = path.filter(candidate => candidate.index < chapter.index).at(-1)
  const tail = previous !== undefined ? clipTail((await project.chapterText(previous.plan.id)).trim(), BEFORE_TAIL) : ''
  const stood = await standings(runtime, chapter, lang, own)
  return [
    `## ${L(lang, `手上这一章：第 ${chapter.index} 章《${chapter.plan.title}》`, `The chapter in hand: chapter ${chapter.index}, "${chapter.plan.title}"`)}`,
    `### ${L(lang, '章纲（作者对这一章的安排）', 'Its plan (what the author set for it)')}\n${renderPlan(chapter.plan, chapter.index, lang, nameOf)}`,
    stood,
    tail.length > 0 ? `### ${L(lang, `上一章（第 ${previous!.index} 章）结尾`, `How the chapter before (${previous!.index}) ends`)}\n${tail}` : '',
    `### ${L(lang, '本章正文', 'Its text')}\n${own}`,
  ].filter(part => part.length > 0).join('\n\n')
}

// ───────────────────────────── evidence ─────────────────────────────

/** Where something a chapter is held against stands, as whoever found it hands it in. */
export interface Evidence {
  /** `chapter`: an earlier (or later) chapter's text; `here`: this chapter's own; `character` / `world`: a card or an entry of the bible; `plan`: the chapter's plan; `style`: the style set; `reference`: one of the books this one goes by. */
  kind: 'chapter' | 'here' | 'character' | 'world' | 'plan' | 'style' | 'reference'
  /** Which: the chapter's number, the card's or the entry's name. */
  ref?: string
  /** The words it rests on, copied from there. */
  quote: string
}

export const EVIDENCE_KINDS: readonly Evidence['kind'][] = ['chapter', 'here', 'character', 'world', 'plan', 'style', 'reference']

/**
 * Look for what was quoted where it is said to stand. A claim that a chapter is at odds with something rests on the
 * words of that thing: words that are not there are a claim made from memory.
 * @returns nothing where the words are there (or cannot be checked: a reference is not opened here); else what is wrong, to be said to whoever handed it in.
 */
export async function checkEvidence(runtime: ProjectRuntime, chapter: LocatedChapter, text: string, evidence: Evidence, lang: PromptLanguage): Promise<string | undefined> {
  const { project } = runtime
  const quote = evidence.quote.trim()
  if (quote.length < 2) return L(lang, 'against.quote 是空的：抄出它对不上的那句原话', 'against.quote is empty: copy the words it is at odds with')
  const has = (source: string): boolean => fuzzyFind(source, quote) !== undefined || source.replace(/\s+/g, '').includes(quote.replace(/\s+/g, ''))
  switch (evidence.kind) {
    case 'here':
      return has(text) ? undefined : L(lang, `本章正文里没有这句话：“${clip(quote, 50)}”——从正文逐字照抄`, `this chapter does not have these words: "${clip(quote, 60)}" — copy them from its text`)
    case 'chapter': {
      const found = evidence.ref !== undefined ? await project.findChapter(evidence.ref.replace(/[^\d]/g, '').length > 0 ? evidence.ref.replace(/[^\d]/g, '') : evidence.ref, chapter.line) : undefined
      if (found === undefined) return L(lang, `against.ref 要写第几章（数字）：“${evidence.ref ?? ''}”找不到`, `against.ref is the chapter's number: "${evidence.ref ?? ''}" is not one`)
      const source = await project.chapterText(found.plan.id)
      return has(source) ? undefined : L(lang, `第 ${found.index} 章的正文里没有这句话：“${clip(quote, 50)}”——用 book_read 读那一章，照原文抄；那一章其实没这么写，这条就不成立`, `chapter ${found.index} does not have these words: "${clip(quote, 60)}" — read it with book_read and copy what it says; where it says no such thing, there is no issue`)
    }
    case 'character': {
      const card = evidence.ref !== undefined ? await project.findCharacter(evidence.ref) : undefined
      if (card === undefined) return L(lang, `没有“${evidence.ref ?? ''}”这张人物卡：against.ref 写卡上的名字`, `no character card "${evidence.ref ?? ''}": against.ref is the name on the card`)
      return has(JSON.stringify(card)) || has(Object.values(card).filter(value => typeof value === 'string').join('\n')) ? undefined : L(lang, `人物卡“${card.name}”上没有这句话：“${clip(quote, 50)}”——用 book_read what=character 读它，照卡上的抄`, `the card "${card.name}" does not have these words: "${clip(quote, 60)}" — read it with book_read what=character and copy what it says`)
    }
    case 'world': {
      const entry = evidence.ref !== undefined ? await project.findWorld(evidence.ref) : undefined
      if (entry === undefined) return L(lang, `没有“${evidence.ref ?? ''}”这条设定：against.ref 写条目的名字`, `no world entry "${evidence.ref ?? ''}": against.ref is the entry's name`)
      return has(Object.values(entry).filter(value => typeof value === 'string').join('\n')) ? undefined : L(lang, `设定“${entry.name}”里没有这句话：“${clip(quote, 50)}”——用 book_read what=world 读它，照条目抄`, `the entry "${entry.name}" does not have these words: "${clip(quote, 60)}" — read it with book_read what=world and copy what it says`)
    }
    case 'plan': {
      const plan = JSON.stringify(chapter.plan)
      return has(plan) || has(renderPlan(chapter.plan, chapter.index, lang)) ? undefined : L(lang, `这一章的章纲里没有这句话：“${clip(quote, 50)}”`, `this chapter's plan does not have these words: "${clip(quote, 60)}"`)
    }
    case 'style': {
      const style = await project.activeStyle()
      return style !== undefined && has(JSON.stringify(style)) ? undefined : L(lang, `设定的文风里没有这句话：“${clip(quote, 50)}”`, `the style set does not have these words: "${clip(quote, 60)}"`)
    }
    default:
      // A book this one goes by is read with its own tools, and not opened here: taken at its word.
      return undefined
  }
}

/** A chapter's place on its line, for a block that names several. */
export const placed = (chapter: LocatedChapter): { id: string; index: number; title: string } => ({ id: chapter.plan.id, index: chapter.index, title: chapter.plan.title })

/** The line a chapter is read on, as the book's tools name it. */
export const lineOfChapter = (chapter: LocatedChapter): string => chapter.line ?? MAIN_LINE

/** Whether a card or an entry is one of a line's (re-exported for the passes that build their own lists). */
export const ofLine = belongsTo

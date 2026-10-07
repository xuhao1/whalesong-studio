// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Context packing: decides what a model gets to read before it writes.
 *
 * Two strategies share one budget:
 *   full       everything written so far travels verbatim — the right call
 *              while the manuscript fits the model's window;
 *   retrieval  layered memory instead: arc summaries → chapter summaries →
 *              passages retrieved for this task → the verbatim tail.
 *
 * Either way the stable material (bible) comes first and the volatile
 * material (tail, task) last, so provider-side prefix caches keep hitting
 * while a book is being drafted chapter after chapter.
 */
import type { CharacterCard, ChapterMemory, ContextStrategy, PromptLanguage, WorldEntry } from '../shared/types'
import { clip, clipTail, estimateTokens, sameName } from '../shared/text'
import type { LocatedChapter, Project } from './project'
import {
  L, promptLanguage, renderCharacter, renderManifest, renderMoment, renderPlan, renderThread, renderWorld,
} from './render'
import type { RetrievalIndex } from './retrieval'

export interface ArcSummary {
  /** First and last chapter ids covered. */
  from: string
  to: string
  fromIndex: number
  toIndex: number
  summary: string
  /** Hash of the chapter summaries it was written from. */
  hash: string
}

export interface PackOptions {
  purpose: 'draft' | 'continue' | 'revise' | 'review' | 'derive' | 'play' | 'stage'
  /** Chapter the task is about; canon is everything before it. */
  chapter?: LocatedChapter
  /**
   * Without a focus chapter: treat only chapters up to this 1-based position
   * as known canon (an interlude branching off mid-book).
   */
  canonThrough?: number
  /** The task brief; also steers retrieval and cast detection. */
  brief?: string
  /** Extra text that steers retrieval and cast detection (a selected passage). */
  focus?: string
  /** Characters to include regardless of detection (ids or names). */
  characters?: string[]
  budgetTokens: number
  strategy: Exclude<ContextStrategy, 'auto'>
  /** Characters of preceding text always included verbatim. */
  tailChars: number
  /** Include the focus chapter's own text (continue, revise, review). */
  includeChapterText?: boolean
  signal?: AbortSignal
}

export interface ContextPack {
  text: string
  tokens: number
  strategy: Exclude<ContextStrategy, 'auto'>
  language: PromptLanguage
  cast: CharacterCard[]
  included: { fullChapters: number; summaries: number; passages: number; worldEntries: number }
}

interface Section {
  title: string
  body: string
}

const ROLE_RANK: Record<CharacterCard['role'], number> = { protagonist: 0, deuteragonist: 1, antagonist: 2, supporting: 3, minor: 4, cameo: 5 }

/** Characters whose name or alias occurs in the text. */
export function detectCharacters(text: string, characters: CharacterCard[]): CharacterCard[] {
  if (text.length === 0) return []
  const folded = text.normalize('NFKC')
  return characters.filter((card) => {
    const names = [card.name, ...(card.aliases ?? [])].filter(name => name.trim().length >= 2 || /[一-鿿]/.test(name))
    return names.some(name => name.length > 0 && folded.includes(name.normalize('NFKC')))
  })
}

/** What a model is taken to hold when neither the endpoint nor the author says: enough for any current model, small enough to be safe. */
export const ASSUMED_CONTEXT_WINDOW = 200_000
/** The share of a window given to background; the rest is for the instructions and the reply. */
const WINDOW_SHARE = 0.7

/**
 * Decide between sending the whole manuscript and packing by relevance, and
 * how many tokens the background may take: the budget the author set, never
 * more than the model's window leaves room for.
 */
export async function chooseStrategy(
  project: Project,
  preference: ContextStrategy,
  budgetTokens: number,
  contextWindow: number | undefined,
  upToIndex: number | undefined,
): Promise<{ strategy: Exclude<ContextStrategy, 'auto'>; budgetTokens: number }> {
  const ceiling = Math.max(4000, Math.floor((contextWindow ?? ASSUMED_CONTEXT_WINDOW) * WINDOW_SHARE))
  const limit = Math.min(budgetTokens, ceiling)
  if (preference === 'retrieval') return { strategy: 'retrieval', budgetTokens: limit }
  let manuscript = 0
  for (const chapter of await project.chapters()) {
    if (upToIndex !== undefined && chapter.index >= upToIndex) break
    manuscript += estimateTokens(await project.chapterText(chapter.plan.id))
  }
  // The bible, the outline and the chapter's own plan travel with the manuscript.
  const whole = manuscript + 16_000
  // "Full" may go past the budget, up to what the window holds; the packer falls back when even that is not enough.
  if (preference === 'full') return { strategy: 'full', budgetTokens: Math.max(limit, Math.min(ceiling, whole)) }
  if (manuscript > 0 && whole <= limit) return { strategy: 'full', budgetTokens: limit }
  return { strategy: 'retrieval', budgetTokens: limit }
}

export async function packContext(project: Project, index: RetrievalIndex, options: PackOptions): Promise<ContextPack> {
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const [characters, world, outline, located] = await Promise.all([project.characters(), project.world(), project.outline(), project.chapters()])
  const current = options.chapter
  const limit = current !== undefined ? current.index : options.canonThrough !== undefined ? options.canonThrough + 1 : undefined
  const before = limit === undefined ? located : located.filter(chapter => chapter.index < limit)
  const chapterLabel = (id: string): string => {
    const chapter = located.find(candidate => candidate.plan.id === id)
    return chapter === undefined ? id : L(lang, `第${chapter.index}章`, `ch. ${chapter.index}`)
  }
  const nameOf = (ref: string): string => characters.find(card => card.id === ref)?.name ?? ref

  let budget = options.budgetTokens
  const sections: Record<string, Section | undefined> = {}
  const take = (key: string, title: string, body: string, cap?: number): number => {
    const trimmed = body.trim()
    if (trimmed.length === 0 || budget <= 0) return 0
    const allowed = Math.min(budget, cap ?? budget)
    let text = trimmed
    let tokens = estimateTokens(text)
    if (tokens > allowed) {
      // Token estimates are per character class; scale the cut and re-measure.
      text = clip(trimmed, Math.max(80, Math.floor(trimmed.length * allowed / tokens)))
      tokens = estimateTokens(text)
    }
    sections[key] = { title, body: text }
    budget -= tokens
    return tokens
  }

  // ── the task's own material comes out of the budget first ──
  take('project', L(lang, '作品', 'The book'), renderManifest(manifest, lang))

  const planText = current !== undefined ? renderPlan(current.plan, current.index, lang, nameOf) : ''
  if (current !== undefined) take('plan', L(lang, '本章章纲', 'This chapter\'s outline'), planText)

  const currentText = current !== undefined && options.includeChapterText === true ? await project.chapterText(current.plan.id) : ''
  const previous = before.at(-1)
  const previousText = previous !== undefined ? await project.chapterText(previous.plan.id) : ''

  // ── cast ──
  const signals = [options.brief, options.focus, planText, clipTail(currentText, 4000, ''), options.strategy === 'retrieval' ? clipTail(previousText, 1500, '') : ''].filter(Boolean).join('\n')
  const cast = new Map<string, CharacterCard>()
  const addCast = (ref: string | undefined): void => {
    if (ref === undefined) return
    const card = characters.find(candidate => candidate.id === ref) ?? characters.find(candidate => sameName(candidate.name, ref) || candidate.aliases?.some(alias => sameName(alias, ref)) === true)
    if (card !== undefined) cast.set(card.id, card)
  }
  for (const ref of options.characters ?? []) addCast(ref)
  if (current !== undefined) {
    addCast(current.plan.pov)
    for (const ref of current.plan.characters ?? []) addCast(ref)
    for (const beat of current.plan.beats ?? []) for (const ref of beat.characters ?? []) addCast(ref)
  }
  for (const card of detectCharacters(signals, characters)) cast.set(card.id, card)
  // A book with no declared cast for the task still needs its leads in view.
  if (cast.size === 0) for (const card of characters.filter(candidate => candidate.role === 'protagonist' || candidate.role === 'deuteragonist').slice(0, 4)) cast.set(card.id, card)
  const castList = [...cast.values()].sort((left, right) => ROLE_RANK[left.role] - ROLE_RANK[right.role])

  // ── stable material: world core, cast ──
  const core = world.filter(entry => entry.importance === 1)
  const coreTokens = take('world', L(lang, '世界观核心设定', 'World: core canon'), core.map(entry => renderWorld(entry, lang)).join('\n\n'), Math.floor(options.budgetTokens * 0.18))

  const memories = await project.memories()
  const priorMemories = memories.filter(entry => limit === undefined || entry.chapter.index < limit)
  const latestMoment = (card: CharacterCard): { text: string } | undefined => {
    for (let i = priorMemories.length - 1; i >= 0; i--) {
      const entry = priorMemories[i]!
      const moment = entry.memory.characters.find(candidate => candidate.character === card.id || sameName(candidate.name, card.name))
      if (moment !== undefined) return { text: renderMoment(moment, chapterLabel(entry.chapter.plan.id), lang) }
    }
    return undefined
  }
  const quotesOf = (card: CharacterCard): string[] => {
    const quotes: string[] = []
    for (let i = priorMemories.length - 1; i >= 0 && quotes.length < 2; i--) {
      const moment = priorMemories[i]!.memory.characters.find(candidate => candidate.character === card.id || sameName(candidate.name, card.name))
      if (moment?.quote !== undefined && moment.quote.length > 0) quotes.push(moment.quote)
    }
    return quotes
  }
  const castCap = Math.floor(options.budgetTokens * 0.28)
  let castTokens = 0
  const castBlocks: string[] = []
  for (const card of castList) {
    const moment = latestMoment(card)
    const quotes = quotesOf(card)
    const full = [
      renderCharacter(card, lang, { resolveName: nameOf }),
      moment !== undefined ? `${L(lang, '当前状态', 'Current state')}${lang === 'zh' ? '：' : ': '}${moment.text}` : undefined,
      quotes.length > 0 ? `${L(lang, '原文台词参考', 'Lines from the text')}${lang === 'zh' ? '：' : ': '}${quotes.map(quote => `"${quote}"`).join(' ')}` : undefined,
    ].filter(Boolean).join('\n')
    const cost = estimateTokens(full)
    if (castTokens + cost <= castCap || castBlocks.length < 2) {
      castBlocks.push(full)
      castTokens += cost
    } else {
      const brief = renderCharacter(card, lang, { brief: true })
      castBlocks.push(brief)
      castTokens += estimateTokens(brief)
    }
  }
  take('cast', L(lang, '本场相关人物', 'Characters in play'), castBlocks.join('\n\n'))

  const others = characters.filter(card => !cast.has(card.id) && card.status !== 'dead' && (card.status === 'active' || card.status === 'offstage' || card.role === 'protagonist'))
  // The dead are named even when the scene has nothing to do with them: the cheapest guard against a resurrection.
  const dead = characters.filter(card => !cast.has(card.id) && card.status === 'dead')
  if (others.length > 0 || dead.length > 0) {
    take('ensemble', L(lang, '其他人物一览（未必出场）', 'Other characters (not necessarily present)'),
      [
        ...others.sort((left, right) => ROLE_RANK[left.role] - ROLE_RANK[right.role]).slice(0, 40).map(card => renderCharacter(card, lang, { brief: true })),
        ...(dead.length > 0 ? [`${L(lang, '已死亡（可以被提起，不能再以活人身份出场）：', 'Dead (may be mentioned, must not appear alive): ')}${dead.map(card => card.name).join(lang === 'zh' ? '、' : ', ')}`] : []),
      ].join('\n'),
      Math.floor(options.budgetTokens * 0.05))
  }

  // ── the story so far ──
  let fullChapters = 0
  let summaries = 0
  let passages = 0
  let strategy = options.strategy
  if (strategy === 'full') {
    const parts: string[] = []
    let cost = 0
    for (const chapter of before) {
      const text = await project.chapterText(chapter.plan.id)
      if (text.length === 0) continue
      const block = `${L(lang, `第${chapter.index}章`, `Chapter ${chapter.index}`)} ${chapter.plan.title}\n\n${text}`
      cost += estimateTokens(block)
      parts.push(block)
    }
    // Keep room for the tail and the reply; fall back to layered memory when the book outgrew the budget.
    if (cost <= budget - 2000) {
      fullChapters = parts.length
      take('story', L(lang, '前文全文', 'Everything written so far'), parts.join('\n\n———\n\n'))
    } else {
      strategy = 'retrieval'
    }
  }
  if (strategy === 'retrieval') {
    const arcs = (await project.readState<ArcSummary[]>('memory', 'arcs.json')) ?? []
    const usableArcs = arcs.filter(arc => limit === undefined || arc.toIndex < limit)
    const coveredTo = usableArcs.reduce((max, arc) => Math.max(max, arc.toIndex), 0)
    const lines: string[] = []
    for (const arc of usableArcs) lines.push(`${L(lang, `第${arc.fromIndex}–${arc.toIndex}章`, `Chapters ${arc.fromIndex}–${arc.toIndex}`)}  ${arc.summary}`)
    const recent = priorMemories.filter(entry => entry.chapter.index > coveredTo)
    const storyCap = Math.floor(options.budgetTokens * 0.24)
    // The closest chapters keep their full summaries; older ones shrink to one line when space is short.
    const fullFrom = Math.max(0, recent.length - 6)
    const recentLines = recent.map((entry, at) => renderSummary(entry.memory, `${L(lang, `第${entry.chapter.index}章`, `Ch. ${entry.chapter.index}`)}《${entry.chapter.plan.title}》`, at >= fullFrom))
    let story = [...lines, ...recentLines].join('\n')
    if (estimateTokens(story) > storyCap) {
      const briefLines = recent.map((entry, at) => renderSummary(entry.memory, L(lang, `第${entry.chapter.index}章`, `Ch. ${entry.chapter.index}`), at >= recent.length - 3))
      story = [...lines, ...briefLines].join('\n')
    }
    summaries = usableArcs.length + recent.length
    take('story', L(lang, '前情提要', 'The story so far'), story, storyCap)
  }

  // ── threads the reader is waiting on ──
  const openThreads = outline.threads.filter(thread => thread.status === 'open')
  if (openThreads.length > 0) {
    const mine = new Set(current?.plan.threads ?? [])
    const ordered = [...openThreads.filter(thread => mine.has(thread.id)), ...openThreads.filter(thread => !mine.has(thread.id))]
    take('threads', L(lang, '尚未回收的线索与伏笔', 'Open threads'), ordered.slice(0, 30).map(thread => `${mine.has(thread.id) ? L(lang, '★本章涉及 ', '★ in this chapter ') : ''}${renderThread(thread, lang, chapterLabel)}`).join('\n'), Math.floor(options.budgetTokens * 0.06))
  }

  // ── retrieved material ──
  const query = [options.brief, options.focus, current?.plan.synopsis, current?.plan.beats?.map(beat => beat.summary).join(' '), castList.map(card => card.name).join(' ')].filter(Boolean).join('\n').slice(0, 1500)
  let worldEntries = core.length > 0 && coreTokens > 0 ? core.length : 0
  if (query.trim().length > 0) {
    const named = world.filter(entry => entry.importance !== 1 && [entry.name, ...(entry.aliases ?? [])].some(name => name.length > 1 && query.includes(name)))
    const hits = await index.search(query, { sources: ['world'], limit: 6, ...(options.signal !== undefined ? { signal: options.signal } : {}) })
    const picked = new Map<string, WorldEntry>()
    for (const entry of named) picked.set(entry.id, entry)
    for (const hit of hits) {
      const entry = world.find(candidate => candidate.id === hit.ref)
      if (entry !== undefined && entry.importance !== 1 && hit.score > 0.35) picked.set(entry.id, entry)
    }
    if (picked.size > 0) {
      worldEntries += picked.size
      take('lore', L(lang, '与本章相关的设定', 'World: relevant to this chapter'), [...picked.values()].slice(0, 8).map(entry => renderWorld(entry, lang)).join('\n\n'), Math.floor(options.budgetTokens * 0.1))
    }
    if (strategy === 'retrieval' && before.length > 0) {
      const cap = Math.floor(options.budgetTokens * 0.16)
      const found = await index.search(query, {
        sources: ['manuscript'],
        limit: Math.max(3, Math.min(12, Math.floor(cap / 450))),
        ...(limit !== undefined ? { beforeChapter: limit } : {}),
        // The previous chapter's ending already travels verbatim.
        ...(previous !== undefined && previousText.length <= options.tailChars ? { excludeChapters: [previous.plan.id] } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      const ordered = found.sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true }) || (left.offset ?? 0) - (right.offset ?? 0))
      passages = ordered.length
      take('passages', L(lang, '可能相关的前文片段（按章节顺序）', 'Possibly relevant earlier passages (in order)'), ordered.map(hit => `〔${hit.title}〕\n${hit.text}`).join('\n\n'), cap)
    }
  }

  // ── where the story goes next, so the writer does not pre-empt it ──
  if (current !== undefined && (options.purpose === 'draft' || options.purpose === 'continue')) {
    const next = located.find(chapter => chapter.index === current.index + 1)
    if (next?.plan.synopsis !== undefined) {
      take('next', L(lang, '下一章预告（只用于把握收束，不要提前写）', 'Next chapter (for landing this one only — do not write it)'), `${next.plan.title}${lang === 'zh' ? '：' : ': '}${next.plan.synopsis}`, 400)
    }
  }

  // ── verbatim neighbourhood ──
  if (strategy === 'retrieval' && previousText.length > 0) {
    take('tail', L(lang, `上一章《${previous!.plan.title}》结尾原文`, `End of the previous chapter, "${previous!.plan.title}"`), clipTail(previousText, options.tailChars))
  }
  if (currentText.length > 0) {
    const room = Math.max(1000, budget - 200)
    const body = estimateTokens(currentText) <= room ? currentText : clipTail(currentText, Math.max(options.tailChars, Math.floor(currentText.length * room / estimateTokens(currentText))))
    take('current', L(lang, '本章已有正文', 'This chapter so far'), body)
  }

  const order = ['project', 'world', 'ensemble', 'cast', 'story', 'threads', 'lore', 'passages', 'next', 'tail', 'current', 'plan']
  const text = order.map(key => sections[key]).filter((section): section is Section => section !== undefined).map(section => `## ${section.title}\n\n${section.body}`).join('\n\n')
  return {
    text,
    tokens: estimateTokens(text),
    strategy,
    language: lang,
    cast: castList,
    included: { fullChapters, summaries, passages, worldEntries },
  }
}

function renderSummary(memory: ChapterMemory, label: string, full: boolean): string {
  return `${label}  ${full ? memory.summary : memory.brief}`
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Finding the chapters of a manuscript.
 *
 * A manuscript comes in every state: clean headings on lines of their own, or
 * a web page turned into text with each heading glued to the navigation links
 * before it; one level of chapters or volumes above them; a table of contents
 * that repeats every heading; no headings at all. Rules get the clean ones
 * right and the rest badly wrong — a classic in 120 chapters came out as 210
 * numbered pieces.
 *
 * So the structure is found by an editor who can look: an agent with a few
 * tools over the text. It reads the opening, searches for what the headings
 * look like, removes what does not belong to the book, splits, reads the
 * report of what came out — gaps in the numbering, pieces far too short or
 * too long — goes back to the text where something is off, corrects, and
 * commits. It never rewrites prose: it only decides where to cut and what
 * each piece is called.
 *
 * The tools work on a {@link Manuscript}; the agent runs through
 * {@link RoleRunner} (`core.roles`). Where no agent can run — a role on an
 * endpoint the Studio calls itself, a Harness without an agent loop — the old
 * rules stand in, and the result says so.
 */
import { runInNewContext } from 'node:vm'
import { clip, countWords, fuzzyFind, normalizeProse } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { CREW, crewName, crewPlan, crewRules } from '../crew'
import { LlmCallError } from '../llm'
import { argInt, argList, argText, type RoleTool } from '../roles'
import { L, promptLanguage } from '../render'
import { isAbort } from '../util/async'

export interface SplitChapter {
  title: string
  text: string
  /** Title of the volume this chapter opens, when a volume heading precedes it. */
  volume?: string
}

const CN_NUM = '0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾'
const CHAPTER_HEADING = new RegExp(`^\\s*(?:#{1,4}\\s*)?(?:(?:第\\s*[${CN_NUM}]+\\s*[章回节集话]|(?:chapter|chap\\.?)\\s+(?:\\d+|[ivxlcdm]+|[a-z-]+))(?:[\\s:：.、·—-]+.{0,40})?|(?:序章|序幕|楔子|引子|序言|前言|尾声|终章|后记|番外(?:[\\s:：·—-]*.{0,30})?|prologue|epilogue|interlude)(?:[\\s:：.-]+.{0,40})?)\\s*$`, 'i')
const VOLUME_HEADING = new RegExp(`^\\s*(?:#{1,3}\\s*)?(?:第\\s*[${CN_NUM}]+\\s*[卷部篇册]|(?:volume|book|part)\\s+(?:\\d+|[ivxlcdm]+|[a-z-]+))(?:[\\s:：.、·—-]+.{0,40})?\\s*$`, 'i')
const MARKDOWN_HEADING = /^\s*#{1,3}\s+(.{1,60})\s*$/

/** How a piece cut by size is named, and recognized again. */
const sectionTitle = (index: number, zh: boolean): string => (zh ? `第${index}节` : `Part ${index}`)

/**
 * Cut a manuscript into chapters by rule: headings that stand on a line of
 * their own, or — when there are none — pieces of a set size. What the agent
 * replaces where it can run, and what stands in where it cannot.
 */
export function splitChapters(source: string, options: { chunkChars?: number; zh?: boolean } = {}): SplitChapter[] {
  const text = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  const lines = text.split('\n')
  const zh = options.zh ?? /[一-鿿]/.test(text.slice(0, 2000))
  let headings = lines.map((line, index) => ({ index, line })).filter(({ line }) => line.length <= 80 && (CHAPTER_HEADING.test(line) || VOLUME_HEADING.test(line)))
  // Markdown documents often title chapters with plain headings.
  if (headings.filter(heading => !VOLUME_HEADING.test(heading.line)).length < 2) {
    const markdown = lines.map((line, index) => ({ index, line })).filter(({ line }) => MARKDOWN_HEADING.test(line))
    if (markdown.length >= 2) headings = markdown
  }
  const chapters: SplitChapter[] = []
  const clean = (line: string): string => line.replace(/^\s*#{1,4}\s*/, '').trim()
  if (headings.filter(heading => !VOLUME_HEADING.test(heading.line)).length >= 2) {
    let volume: string | undefined
    const preface = normalizeProse(lines.slice(0, headings[0]!.index).join('\n'))
    if (countWords(preface) > 200) chapters.push({ title: zh ? '序' : 'Preface', text: preface })
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i]!
      const end = i + 1 < headings.length ? headings[i + 1]!.index : lines.length
      const body = normalizeProse(lines.slice(heading.index + 1, end).join('\n'))
      if (VOLUME_HEADING.test(heading.line) && !CHAPTER_HEADING.test(heading.line)) {
        volume = clean(heading.line)
        // Text directly under a volume heading (an epigraph, an intro) stays with the volume's first chapter.
        if (countWords(body) > 200) chapters.push({ title: volume, text: body, volume })
        continue
      }
      if (body.length === 0) continue
      chapters.push({ title: clean(heading.line), text: body, ...(volume !== undefined ? { volume } : {}) })
      volume = undefined
    }
    if (chapters.length > 0) return chapters
  }
  return bySize(text, options.chunkChars ?? (zh ? 3200 : 9000), zh)
}

/** No usable headings: cut on paragraph boundaries near a size. */
function bySize(text: string, size: number, zh: boolean): SplitChapter[] {
  const chapters: SplitChapter[] = []
  const paragraphs = normalizeProse(text).split('\n').filter(line => line.trim().length > 0)
  let current: string[] = []
  let length = 0
  for (const paragraph of paragraphs) {
    if (length + paragraph.length > size && current.length > 0) {
      chapters.push({ title: sectionTitle(chapters.length + 1, zh), text: current.join('\n\n') })
      current = []
      length = 0
    }
    current.push(paragraph)
    length += paragraph.length
  }
  if (current.length > 0) chapters.push({ title: sectionTitle(chapters.length + 1, zh), text: current.join('\n\n') })
  return chapters
}

// ───────────────────────────── numbers in titles ─────────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9 }
const CN_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 千: 1000, 万: 10000 }

/** Read a number written in Arabic, full-width, Chinese or Roman numerals; undefined when it is none of them. */
export function readNumber(raw: string): number | undefined {
  const text = raw.trim().replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
  if (/^\d+$/.test(text)) return Number(text)
  if (/^[ivxlcdm]+$/i.test(text)) {
    const value: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
    let total = 0
    const lower = text.toLowerCase()
    for (let i = 0; i < lower.length; i++) {
      const now = value[lower[i]!]!
      const next = value[lower[i + 1] ?? ''] ?? 0
      total += now < next ? -now : now
    }
    return total > 0 ? total : undefined
  }
  if (!/^[零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾]+$/.test(text)) return undefined
  // Written digit by digit: 一二〇.
  if (!/[十百千万拾]/.test(text)) return Number([...text].map(char => CN_DIGIT[char]).join(''))
  let total = 0
  let section = 0
  let digit = 0
  for (const char of text) {
    if (char in CN_DIGIT) {
      digit = CN_DIGIT[char]!
    } else {
      const unit = CN_UNIT[char]!
      if (unit === 10000) {
        total += (section + digit) * unit
        section = 0
      } else {
        // 十五 is fifteen: a unit with nothing before it counts once.
        section += (digit === 0 && section === 0 ? 1 : digit) * unit
      }
      digit = 0
    }
  }
  return total + section + digit
}

/** The number a chapter title counts itself by: 第十二回 → 12, Chapter IV → 4. */
export function titleNumber(title: string): number | undefined {
  const cn = new RegExp(`第\\s*([${CN_NUM}]+)\\s*[章回节集话卷部篇册折]`).exec(title)
  if (cn !== null) return readNumber(cn[1]!)
  const en = /\b(?:chapter|chap\.?|part|book|volume)\s+(\d+|[ivxlcdm]+)\b/i.exec(title)
  if (en !== null) return readNumber(en[1]!)
  const lead = /^\s*(\d{1,4})[\s.、:：)]/.exec(title)
  return lead !== null ? Number(lead[1]) : undefined
}

// ───────────────────────────── the manuscript on the editor's desk ─────────────────────────────

interface Mark {
  /** Where the chapter begins in the text. */
  at: number
  /** Characters of heading at its start that are the title, not prose. */
  skip: number
  title: string
}

interface Found {
  index: number
  match: string
  group?: string
}

const oneLine = (text: string): string => text.replace(/\n/g, '⏎').replace(/[ \t]+/g, ' ')
const tidyTitle = (raw: string): string => raw.replace(/^\s*#{1,4}\s*/, '').replace(/[\s　]+/g, ' ').trim()

/**
 * Whether a "title" reads like a sentence of prose: what a loose heading
 * pattern catches when the text merely mentions a chapter ("as told in
 * Chapter 4, …"). A hint for the editor, never a verdict.
 */
function proseLike(title: string, zh: boolean): boolean {
  if (zh) return title.length > 44 || (title.length > 18 && /[，。；．]/.test(title))
  return title.length > 110 || (title.length > 60 && /[,;] | \w+\. \w/.test(title))
}

/**
 * Run a pattern the model wrote over the whole text. In a context of its own
 * with a time limit: a pattern that backtracks without end must cost a tool
 * call, not the process.
 */
function matchAll(pattern: string, text: string, cap: number): Found[] {
  let source = pattern.trim()
  // Written the way a regex literal is: /…/flags.
  const literal = /^\/(.+)\/[a-z]*$/s.exec(source)
  if (literal !== null) source = literal[1]!
  if (source.length === 0) throw new Error('the pattern is empty')
  let flags = 'gmu'
  try {
    new RegExp(source, flags)
  } catch {
    flags = 'gm'
    try {
      new RegExp(source, flags)
    } catch (error) {
      throw new Error(`not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const script = 'const re = new RegExp(source, flags); const out = []; let m; while ((m = re.exec(text)) !== null) { out.push([m.index, m[0], m[1] === undefined ? null : m[1]]); if (m[0].length === 0) re.lastIndex += 1; if (out.length >= cap) break } out'
  let raw: [number, string, string | null][]
  try {
    raw = runInNewContext(script, { source, flags, text, cap }, { timeout: 3000 }) as [number, string, string | null][]
  } catch (error) {
    // Thrown in the other context: an Error there is not an Error here.
    const message = String((error as { message?: unknown } | null)?.message ?? error)
    if (/timed out/i.test(message)) throw new Error('this pattern takes too long on a text this size (it backtracks without end) — write a simpler one')
    throw new Error(`the pattern could not be run: ${message}`)
  }
  return Array.from(raw, ([index, match, group]) => ({ index, match, ...(group !== null ? { group } : {}) }))
}

/** The text of a manuscript and the plan for cutting it, as the editor's tools see and change them. */
export class Manuscript {
  text: string
  private marks: Mark[] = []
  private volumes = new Map<number, string>()
  private front: 'keep' | 'drop' = 'keep'
  private sized = false
  /** What was removed as not part of the book. */
  readonly cleaned: { pattern: string; count: number; chars: number }[] = []
  /** The most plausible plan there has been, in case the editor never commits one. */
  private best: { marks: Mark[]; volumes: Map<number, string>; front: 'keep' | 'drop'; sized: boolean; issues: number; chapters: number } | undefined
  /** What the last report found wrong with the plan as it stands. */
  private open = 0
  /** Set by `finish`: the plan is the editor's answer. */
  finished = false
  note = ''
  title: string | undefined
  author: string | undefined

  constructor(source: string, private readonly zh: boolean) {
    this.text = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  }

  private t(zh: string, en: string): string {
    return this.zh ? zh : en
  }

  /** Characters as the author counts them: without the whitespace. */
  private size(from: number, to: number): number {
    return this.text.slice(from, to).replace(/\s+/g, '').length
  }

  private bodyOf(index: number): { from: number; to: number } {
    const mark = this.marks[index]!
    return { from: mark.at + mark.skip, to: index + 1 < this.marks.length ? this.marks[index + 1]!.at : this.text.length }
  }

  private frontChars(): number {
    return this.marks.length > 0 ? this.size(0, this.marks[0]!.at) : 0
  }

  // ── tools ──

  look(args: { at?: number; find?: string; chars?: number }): string {
    const chars = Math.min(4000, Math.max(200, args.chars ?? 1200))
    let start = Math.min(Math.max(0, args.at ?? 0), Math.max(0, this.text.length - 1))
    let where = ''
    if (args.find !== undefined) {
      const hit = fuzzyFind(this.text, args.find)
      if (hit === undefined) throw new Error(this.t(`原文里找不到这段文字：“${clip(args.find, 40)}”。它必须和原文一字不差（可以先用 search 找）。`, `this text is not in the manuscript: "${clip(args.find, 40)}". It must be as written there (use search to find it first).`))
      where = this.t(`这段文字在位置 ${hit.start}。`, `It is at offset ${hit.start}. `)
      start = Math.max(0, hit.start - Math.floor(chars / 4))
    }
    const end = Math.min(this.text.length, start + chars)
    return `${where}${this.t(`【位置 ${start}–${end}，全文共 ${this.text.length} 字符】`, `[offsets ${start}–${end} of ${this.text.length} characters]`)}\n${this.text.slice(start, end)}`
  }

  search(args: { pattern: string; limit?: number }): string {
    const found = matchAll(args.pattern, this.text, 20_000)
    if (found.length === 0) return this.t('没有匹配。标题也许不在行首，或者写法不同——用 look 看看原文里它到底长什么样。', 'No match. The headings may not start a line, or be written differently — look at the text to see what they really are.')
    const limit = Math.min(80, Math.max(5, args.limit ?? 30))
    const gaps = found.slice(1).map((hit, i) => hit.index - found[i]!.index).sort((left, right) => left - right)
    const spacing = gaps.length > 0
      ? this.t(`相邻两处相隔：最近 ${gaps[0]} 字符，中位 ${gaps[gaps.length >> 1]}，最远 ${gaps.at(-1)}。`, `Distance between neighbours: min ${gaps[0]}, median ${gaps[gaps.length >> 1]}, max ${gaps.at(-1)} characters.`)
      : ''
    const show = found.length <= limit ? found.map((hit, i) => ({ hit, i })) : [...found.slice(0, limit - 6).map((hit, i) => ({ hit, i })), ...found.slice(-6).map((hit, i) => ({ hit, i: found.length - 6 + i }))]
    const lines = show.map(({ hit, i }) => {
      const before = oneLine(this.text.slice(Math.max(0, hit.index - 24), hit.index))
      const after = oneLine(this.text.slice(hit.index + hit.match.length, hit.index + hit.match.length + 24))
      return `${i + 1}. @${hit.index}  …${before}⟦${oneLine(clip(hit.match, 90))}⟧${after}…`
    })
    if (found.length > limit) lines.splice(limit - 6, 0, this.t(`   …（中间 ${found.length - limit} 处略）`, `   … (${found.length - limit} more in between)`))
    return `${this.t(`共 ${found.length}${found.length >= 20_000 ? '+' : ''} 处。`, `${found.length}${found.length >= 20_000 ? '+' : ''} matches. `)}${spacing}\n${this.t('（⟦ ⟧ 里是匹配到的文字，两边是它前后的原文，⏎ 表示换行）', '(⟦ ⟧ holds what matched, with the text on either side; ⏎ is a line break)')}\n${lines.join('\n')}`
  }

  clean(args: { pattern: string }): string {
    const found = matchAll(args.pattern, this.text, 200_000).filter(hit => hit.match.length > 0)
    if (found.length === 0) throw new Error(this.t('这个模式什么也没匹配到。', 'the pattern matched nothing'))
    const chars = found.reduce((sum, hit) => sum + hit.match.length, 0)
    if (chars > this.text.length * 0.2) throw new Error(this.t(`这个模式会删掉全文的 ${Math.round(chars / this.text.length * 100)}%——杂质不会有这么多，它把正文也匹配进去了。写得更具体些。`, `this pattern would delete ${Math.round(chars / this.text.length * 100)}% of the text — junk is never that much; it matches prose too. Make it more specific.`))
    const samples = [...new Set(found.map(hit => oneLine(clip(hit.match, 50))))].slice(0, 4)
    let out = ''
    let from = 0
    for (const hit of found) {
      if (hit.index < from) continue
      out += this.text.slice(from, hit.index)
      from = hit.index + hit.match.length
    }
    this.text = out + this.text.slice(from)
    this.cleaned.push({ pattern: args.pattern, count: found.length, chars })
    const had = this.marks.length > 0
    this.marks = []
    this.volumes.clear()
    this.sized = false
    this.best = undefined
    return this.t(
      `删掉了 ${found.length} 处，共 ${chars} 字符（例：${samples.map(sample => `“${sample}”`).join('、')}）。全文现在 ${this.text.length} 字符。${had ? '位置都变了，之前的切分已作废，请重新 split。' : ''}`,
      `Removed ${found.length} matches, ${chars} characters in all (e.g. ${samples.map(sample => `"${sample}"`).join(', ')}). The text is now ${this.text.length} characters.${had ? ' Offsets have moved and the earlier split is void — split again.' : ''}`,
    )
  }

  split(args: { pattern: string }): string {
    const found = matchAll(args.pattern, this.text, 20_000).filter(hit => hit.match.trim().length > 0)
    if (found.length < 2) throw new Error(this.t(`这个模式只匹配到 ${found.length} 处，切不成章。先用 search 确认标题的写法。`, `the pattern matches ${found.length} time(s) — not enough to cut chapters by. Confirm with search what the headings look like.`))
    if (found.length > 5000) throw new Error(this.t(`匹配到 ${found.length} 处，太多了——它匹配的不是章节标题。`, `${found.length} matches is far too many — this is not matching chapter headings`))
    this.marks = found.map(hit => ({ at: hit.index, skip: hit.match.length, title: tidyTitle(hit.group ?? hit.match) }))
    this.volumes.clear()
    this.sized = false
    this.front = 'keep'
    return this.report()
  }

  amend(args: { add?: unknown[]; drop?: unknown[]; rename?: unknown[]; volumes?: unknown[]; front?: string; restore?: boolean }): string {
    if (args.restore === true) {
      if (this.best === undefined) throw new Error(this.t('没有可以回到的版本。', 'there is no earlier split to go back to'))
      this.marks = this.best.marks.map(mark => ({ ...mark }))
      this.volumes = new Map(this.best.volumes)
      this.front = this.best.front
      this.sized = this.best.sized
      return `${this.t('已回到最稳妥的那一版。', 'Back at the soundest split.')}\n${this.report()}`
    }
    if (this.marks.length === 0) throw new Error(this.t('还没有切分结果可以修正，先 split。', 'there is no split to amend yet — split first'))
    const number = (value: unknown, what: string): number => {
      const n = argInt(value)
      if (n === undefined || n < 1 || n > this.marks.length) throw new Error(this.t(`${what} 要填切分结果里的章序号（1–${this.marks.length}）。`, `${what} must be a chapter number from the split (1–${this.marks.length})`))
      return n
    }
    // Chapters are named by their numbers in the report the model just read; resolve all of them before anything moves.
    const drops = new Set(argList(args.drop).map(value => this.marks[number(value, 'drop') - 1]!))
    const renames = argList(args.rename).map((raw) => {
      const item = raw as { chapter?: unknown; title?: unknown }
      const title = argText(item.title)
      if (title === undefined) throw new Error(this.t('rename 的每一项要有 chapter 和 title。', 'every rename needs a chapter and a title'))
      return { mark: this.marks[number(item.chapter, 'rename.chapter') - 1]!, title: tidyTitle(title) }
    })
    const volumes = argList(args.volumes).map((raw) => {
      const item = raw as { chapter?: unknown; title?: unknown }
      return { mark: this.marks[number(item.chapter, 'volumes.chapter') - 1]!, title: argText(item.title) }
    })
    const named = new Map<Mark, string>([...this.volumes].map(([at, title]) => [this.marks.find(mark => mark.at === at)!, title]))
    const added: Mark[] = []
    for (const raw of argList(args.add)) {
      const item = raw as { quote?: unknown; title?: unknown; keep?: unknown }
      const quote = argText(item.quote)
      if (quote === undefined) throw new Error(this.t('add 的每一项要有 quote：这一章开头处的原文（它的标题，或正文的头几个字）。', 'every add needs a quote: the text the chapter begins with (its heading, or its first words)'))
      const hit = fuzzyFind(this.text, quote)
      if (hit === undefined) throw new Error(this.t(`原文里找不到“${clip(quote, 40)}”。quote 必须和原文一字不差——先用 look 或 search 找到它。`, `"${clip(quote, 40)}" is not in the text. A quote must be as written there — find it with look or search first.`))
      const keep = item.keep === true || item.keep === 'true'
      const title = argText(item.title)
      if (keep && title === undefined) throw new Error(this.t('keep 为 true 时这段文字留在正文里，所以必须另外给出 title。', 'with keep the quote stays in the prose, so a title must be given'))
      if (this.marks.some(mark => mark.at === hit.start) || added.some(mark => mark.at === hit.start)) throw new Error(this.t(`位置 ${hit.start} 已经是一章的开头了。`, `offset ${hit.start} already begins a chapter`))
      added.push({ at: hit.start, skip: keep ? 0 : hit.end - hit.start, title: tidyTitle(title ?? quote) })
    }
    for (const { mark, title } of renames) this.retitle(mark, title)
    for (const { mark, title } of volumes) {
      if (title === undefined) named.delete(mark)
      else named.set(mark, tidyTitle(title))
    }
    this.marks = [...this.marks.filter(mark => !drops.has(mark)), ...added].sort((left, right) => left.at - right.at)
    this.volumes = new Map([...named].filter(([mark]) => this.marks.includes(mark)).map(([mark, title]) => [mark.at, title]))
    if (args.front === 'drop' || args.front === 'keep') this.front = args.front
    if (this.marks.length === 0) throw new Error(this.t('这样改完一章也不剩了。', 'that would leave no chapters at all'))
    return this.report()
  }

  list(args: { from?: number; count?: number }): string {
    if (this.marks.length === 0) throw new Error(this.t('还没有切分结果。', 'there is no split yet'))
    const from = Math.min(this.marks.length, Math.max(1, args.from ?? 1))
    const count = Math.min(80, Math.max(1, args.count ?? 40))
    return this.marks.slice(from - 1, from - 1 + count).map((mark, i) => this.line(from - 1 + i, true)).join('\n')
  }

  sections(args: { chars?: number }): string {
    const size = Math.min(20_000, Math.max(800, args.chars ?? (this.zh ? 3200 : 9000)))
    this.marks = []
    this.volumes.clear()
    let at = 0
    let length = 0
    let begin = 0
    // Paragraph by paragraph, a new piece begins once the one in hand is long enough.
    for (const paragraph of this.text.split('\n')) {
      const solid = paragraph.replace(/\s+/g, '').length
      if (length + solid > size && length > 0) {
        this.marks.push({ at: begin, skip: 0, title: sectionTitle(this.marks.length + 1, this.zh) })
        begin = at
        length = 0
      }
      length += solid
      at += paragraph.length + 1
    }
    if (length > 0) this.marks.push({ at: begin, skip: 0, title: sectionTitle(this.marks.length + 1, this.zh) })
    this.sized = true
    this.front = 'drop'
    return `${this.t('全书没有章节标记，已按篇幅在段落之间切开。', 'The book has no chapter marks; it was cut between paragraphs by length.')}\n${this.report()}`
  }

  finish(args: { note?: string; title?: string; author?: string; sure?: boolean }): string {
    if (this.marks.length === 0) throw new Error(this.t('还没有切分结果，不能提交。', 'there is nothing to commit yet'))
    const { drops, glued } = this.diagnose()
    if ((drops.length > 0 || glued.length > 0) && args.sure !== true) {
      throw new Error(this.t(
        `切分结果里还有没处理的地方：${this.proposal(drops, glued)}。照做（amend），或者核实过它们本来就对，带上 sure:true 再提交。`,
        `The split still has unsettled places: ${this.proposal(drops, glued)}. Do that (amend), or — if you have checked that they are right as they are — commit again with sure:true.`,
      ))
    }
    // Brought up to date: the plan may have changed since the last report was read.
    this.report()
    if (this.best !== undefined && this.open > this.best.issues && args.sure !== true) {
      throw new Error(this.t(
        `现在这一版有 ${this.open} 处异常，而你之前有过更稳妥的一版（${this.best.chapters} 章，${this.best.issues} 处异常）。用 amend 的 restore:true 回到那一版再提交；如果确认现在这版才对，带上 sure:true 提交。`,
        `The split as it stands has ${this.open} things wrong with it, and there was a sounder one before (${this.best.chapters} chapters, ${this.best.issues} wrong). Go back to that with amend restore:true and commit; or, if this one is the right one, commit with sure:true.`,
      ))
    }
    const made = this.chapters()
    if (made.length === 0) throw new Error(this.t('切出来的每一章都是空的。', 'every chapter of this split is empty'))
    this.finished = true
    this.note = (args.note ?? '').trim()
    this.title = args.title?.trim() || undefined
    this.author = args.author?.trim() || undefined
    return this.t(`已提交：${made.length} 章。到此为止，不需要再调用工具。`, `Committed: ${made.length} chapters. That is all — no more tool calls are needed.`)
  }

  // ── what the editor reads after every change ──

  private line(index: number, opening = false): string {
    const mark = this.marks[index]!
    const body = this.bodyOf(index)
    const volume = this.volumes.get(mark.at)
    const first = opening ? `  ${this.t('开头', 'opens')}: “${oneLine(clip(this.text.slice(body.from, body.to).trim(), 28))}”` : ''
    return `${index + 1}. ${volume !== undefined ? `〔${volume}〕` : ''}《${mark.title}》 ${this.size(body.from, body.to)} ${this.t('字', 'chars')}  @${mark.at}${first}`
  }

  /** The split as it stands, and everything in it an editor should check before trusting it. */
  report(): string {
    const count = this.marks.length
    const sizes = this.marks.map((_, i) => { const body = this.bodyOf(i); return this.size(body.from, body.to) })
    const sorted = [...sizes].sort((left, right) => left - right)
    const median = sorted[count >> 1]!
    const shortest = sizes.indexOf(sorted[0]!)
    const longest = sizes.indexOf(sorted.at(-1)!)
    const out: string[] = []
    out.push(this.t(
      `共 ${count} 章。篇幅：最短 ${sorted[0]} 字（第 ${shortest + 1} 章），中位 ${median} 字，最长 ${sorted.at(-1)} 字（第 ${longest + 1} 章）。`,
      `${count} chapters. Length: shortest ${sorted[0]} characters (no. ${shortest + 1}), median ${median}, longest ${sorted.at(-1)} (no. ${longest + 1}).`,
    ))
    const front = this.frontChars()
    if (front > 0) {
      const opening = oneLine(clip(this.text.slice(0, this.marks[0]!.at).trim(), 60))
      out.push(this.front === 'drop' || front <= 200
        ? this.t(`第一个标题之前有 ${front} 字（“${opening}”），不会导入。`, `${front} characters come before the first heading ("${opening}"); they will not be imported.`)
        : this.t(`第一个标题之前有 ${front} 字（“${opening}”），会单独成为一章《卷首》。如果那是目录、版权页之类，用 amend 的 front:"drop" 去掉。`, `${front} characters come before the first heading ("${opening}"); they become a chapter of their own, "Front matter". If that is a table of contents or a copyright page, drop it with amend front:"drop".`))
    }
    const head = Math.min(count, 6)
    out.push(this.t('开头几章：', 'First chapters:'))
    for (let i = 0; i < head; i++) out.push(`  ${this.line(i)}`)
    if (count > head) {
      out.push(this.t('最后几章：', 'Last chapters:'))
      for (let i = Math.max(head, count - 3); i < count; i++) out.push(`  ${this.line(i)}`)
    }
    const issues: string[] = []
    const { drops, glued } = this.diagnose()
    const dropped = new Set(drops)
    // Numbering: what the titles count, and where the count breaks — read as if the likely false cuts were gone already.
    const numbers = this.marks.map(mark => titleNumber(mark.title))
    const numbered = numbers.filter(value => value !== undefined).length
    if (numbered >= Math.max(3, count / 2)) {
      let previous: { index: number; value: number } | undefined
      for (let i = 0; i < count; i++) {
        if (dropped.has(i)) continue
        const value = numbers[i]
        if (value === undefined) {
          if (!this.sized) issues.push(this.t(`第 ${i + 1} 章《${clip(this.marks[i]!.title, 30)}》的标题里没有编号——它是序、楔子一类，还是误切？`, `no. ${i + 1} "${clip(this.marks[i]!.title, 30)}" has no number in its title — a prologue or the like, or a false cut?`))
          continue
        }
        if (previous !== undefined) {
          if (value === previous.value) issues.push(this.t(`编号重复：第 ${previous.index + 1} 章和第 ${i + 1} 章都是 ${value}（《${clip(this.marks[i]!.title, 24)}》）。可能是目录和正文各出现一次，或正文里提到了这个标题。`, `duplicate number: no. ${previous.index + 1} and no. ${i + 1} are both ${value} ("${clip(this.marks[i]!.title, 24)}") — perhaps once in a table of contents and once in the text, or a mention of the heading in prose.`))
          else if (value > previous.value + 1) issues.push(this.t(`编号缺口：第 ${previous.index + 1} 章是 ${previous.value}，下一章（第 ${i + 1} 章）直接是 ${value}，中间缺 ${value - previous.value - 1} 章。第 ${previous.index + 1} 章有 ${sizes[previous.index]} 字（中位 ${median}）——缺的章多半就在它里面，标题写法不同。`, `gap in the numbering: no. ${previous.index + 1} is ${previous.value} and the next (no. ${i + 1}) is ${value}; ${value - previous.value - 1} missing. No. ${previous.index + 1} runs to ${sizes[previous.index]} characters (median ${median}) — the missing ones are most likely inside it, under headings written differently.`))
          else if (value < previous.value) issues.push(this.t(`编号回退：第 ${i + 1} 章是 ${value}，它前面是 ${previous.value}。是新的一卷重新编号，还是目录？`, `the numbering goes back: no. ${i + 1} is ${value} after ${previous.value} — a new volume counting afresh, or a table of contents?`))
        }
        previous = { index: i, value }
      }
    }
    if (!this.sized) {
      // A chapter is not short when the piece after it is a false cut that took its text.
      const tiny = sizes.map((size, i) => ({ size, i })).filter(({ size, i }) => size < Math.max(120, median * 0.08) && !dropped.has(i) && !dropped.has(i + 1))
      for (const { size, i } of tiny.slice(0, 12)) issues.push(this.t(`过短：第 ${i + 1} 章《${clip(this.marks[i]!.title, 24)}》只有 ${size} 字——目录里的一行，还是正文里提到了标题？`, `too short: no. ${i + 1} "${clip(this.marks[i]!.title, 24)}" is ${size} characters — a line of a table of contents, or a heading mentioned in prose?`))
      if (tiny.length > 12) issues.push(this.t(`……另有 ${tiny.length - 12} 章过短。`, `… and ${tiny.length - 12} more too short.`))
      const huge = sizes.map((size, i) => ({ size, i })).filter(({ size }) => size > median * 2.6 && size > 4000)
      for (const { size, i } of huge.slice(0, 12)) issues.push(this.t(`过长：第 ${i + 1} 章《${clip(this.marks[i]!.title, 24)}》有 ${size} 字，是中位数的 ${(size / median).toFixed(1)} 倍——里面可能还有没切开的章。`, `too long: no. ${i + 1} "${clip(this.marks[i]!.title, 24)}" is ${size} characters, ${(size / median).toFixed(1)} times the median — there may be uncut chapters inside.`))
    }
    if (drops.length > 0) {
      out.push(`${this.t('疑似误切——“标题”读起来是正文里的一句话，编号也接不上前后：多半是正文提到了章回，而不是一章的开头。', 'Likely false cuts — the "title" reads like a sentence of prose and its number does not follow on: the text mentions a chapter there, most likely, rather than beginning one.')}\n${drops.slice(0, 30).map(i => `  - ${this.t(`第 ${i + 1} 章`, `no. ${i + 1}`)}《${clip(this.marks[i]!.title, 40)}》`).join('\n')}${drops.length > 30 ? '\n  ……' : ''}`)
    }
    if (glued.length > 0) {
      out.push(`${this.t('标题后面粘着正文——编号接得上，是真的一章，但标题和正文在同一行，正则把正文的开头也当成了标题：', 'Headings with prose stuck to them — the number follows on, so the chapter is real, but its heading and its prose share a line and the pattern took the start of the prose for part of the title:')}\n${glued.slice(0, 30).map(({ index, title }) => `  - ${this.t(`第 ${index + 1} 章`, `no. ${index + 1}`)}《${clip(this.marks[index]!.title, 44)}》 → 《${title}》`).join('\n')}${glued.length > 30 ? '\n  ……' : ''}`)
    }
    if (drops.length > 0 || glued.length > 0) out.push(this.t(`  → 抽查一两处（look），没问题就一次改好：${this.proposal(drops, glued)}。不要为了它们去改正则重切。`, `  → check one or two (look), then put them right in one go: ${this.proposal(drops, glued)}. Do not rewrite the pattern and split again for their sake.`))
    out.push(issues.length > 0
      ? `${this.t('需要核实（用 look 看原文，再用 amend 修正；确认无误的可以不管）：', 'To check (look at the text, then amend; leave what is right as it is):')}\n${issues.slice(0, 40).map(issue => `  - ${issue}`).join('\n')}`
      : drops.length > 0 || glued.length > 0
        ? this.t('除此之外，编号和篇幅没有异常。', 'Beyond those, nothing odd in the numbering or the lengths.')
        : this.t('没有发现编号或篇幅上的异常。结构可以提交了（finish）。', 'Nothing odd in the numbering or the lengths. The structure can be committed (finish).'))
    // Remembered when it is the soundest plan so far: an editor that runs out of steps still leaves its best work behind.
    const plausible = count >= 2 && median >= 100 && median <= 60_000
    // What the diagnosis proposes can be applied without anyone looking; only what would be left after it counts against a plan.
    const found = issues.length
    this.open = found
    if (plausible && (this.best === undefined || found <= this.best.issues)) this.best = { marks: this.marks.map(mark => ({ ...mark })), volumes: new Map(this.volumes), front: this.front, sized: this.sized, issues: found, chapters: count }
    return out.join('\n')
  }

  /**
   * What a loose heading pattern gets wrong, told apart by the numbering.
   * A "title" that reads like prose is one of two things: a place where the
   * text only mentions a chapter — its number then repeats or jumps — or a
   * real heading with the first sentence of its chapter on the same line —
   * its number then follows on.
   * @returns `drops`: chapters that are likely mentions; `glued`: real chapters and what their titles likely are.
   */
  private diagnose(): { drops: number[]; glued: { index: number; title: string }[] } {
    const drops: number[] = []
    const glued: { index: number; title: string }[] = []
    if (this.sized || this.marks.length < 3) return { drops, glued }
    const prose = this.marks.map(mark => proseLike(mark.title, this.zh))
    if (!prose.includes(true)) return { drops, glued }
    const numbers = this.marks.map(mark => titleNumber(mark.title))
    // How many words a heading of this book has, going by the ones that read like headings.
    const words = this.marks.filter((_, i) => !prose[i]).map(mark => mark.title.split(' ').length).sort((left, right) => left - right)
    const usual = words.length > 0 ? words[words.length >> 1]! : 0
    let previous: number | undefined
    for (let i = 0; i < this.marks.length; i++) {
      const value = numbers[i]
      if (!prose[i]) {
        if (value !== undefined) previous = value
        continue
      }
      // The next heading that reads like one says whether this one was a step on the way to it.
      let next: number | undefined
      for (let j = i + 1; j < this.marks.length && next === undefined; j++) if (!prose[j]) next = numbers[j]
      const follows = value !== undefined && (previous === undefined ? (next === undefined || value < next) : value === previous + 1) && (next === undefined || value < next)
      if (!follows) {
        drops.push(i)
        continue
      }
      previous = value
      const parts = this.marks[i]!.title.split(' ')
      // Only where the book's headings have a shape to go by; otherwise the editor must look.
      if (usual >= 2 && parts.length > usual) glued.push({ index: i, title: parts.slice(0, usual).join(' ') })
    }
    return { drops, glued }
  }

  /** The amend call that settles a diagnosis, as the model can copy it. */
  private proposal(drops: number[], glued: { index: number; title: string }[]): string {
    const parts: string[] = []
    if (drops.length > 0) parts.push(`drop:[${drops.map(i => i + 1).join(',')}]`)
    if (glued.length > 0) parts.push(`rename:[${glued.map(({ index, title }) => `{chapter:${index + 1},title:"${title}"}`).join(',')}]`)
    return `amend ${parts.join(' ')}`
  }

  /** Give a chapter the title it should have; where that is the start of what was taken for its heading, the rest goes back into the prose. */
  private retitle(mark: Mark, title: string): void {
    const span = this.text.slice(mark.at, mark.at + mark.skip)
    for (let length = 1; length <= span.length; length++) {
      if (tidyTitle(span.slice(0, length)) === title && (length === span.length || /[\s　]/.test(span[length]!))) {
        mark.skip = length
        break
      }
    }
    mark.title = title
  }

  /**
   * Take up the soundest plan there was, for an editor that stopped without
   * committing: what the diagnosis proposes is applied, since nobody is left
   * to check it.
   * @returns what was done, or undefined when there never was a usable plan.
   */
  settle(): { chapters: number; dropped: number; retitled: number } | undefined {
    if (this.best === undefined) return undefined
    this.marks = this.best.marks.map(mark => ({ ...mark }))
    this.volumes = new Map(this.best.volumes)
    this.front = this.best.front
    this.sized = this.best.sized
    const { drops, glued } = this.diagnose()
    for (const { index, title } of glued) this.retitle(this.marks[index]!, title)
    const gone = new Set(drops.map(i => this.marks[i]!))
    this.marks = this.marks.filter(mark => !gone.has(mark))
    if (this.marks.length === 0) return undefined
    return { chapters: this.chapters().length, dropped: drops.length, retitled: glued.length }
  }

  /** The chapters the plan makes. */
  chapters(): SplitChapter[] {
    const out: SplitChapter[] = []
    if (this.marks.length === 0) return out
    if (this.front === 'keep' && this.frontChars() > 200) out.push({ title: this.t('卷首', 'Front matter'), text: normalizeProse(this.text.slice(0, this.marks[0]!.at)) })
    let volume: string | undefined
    for (let i = 0; i < this.marks.length; i++) {
      const mark = this.marks[i]!
      volume = this.volumes.get(mark.at) ?? volume
      const body = this.bodyOf(i)
      const text = normalizeProse(this.text.slice(body.from, body.to))
      // A heading with nothing under it is a line of a table of contents.
      if (text.length === 0) continue
      out.push({ title: mark.title, text, ...(volume !== undefined ? { volume } : {}) })
      volume = undefined
    }
    return out
  }

  get bySize(): boolean {
    return this.sized
  }

  // ── the tools as an agent is given them ──

  tools(): RoleTool[] {
    const t = (zh: string, en: string): string => this.t(zh, en)
    return [
      {
        name: 'look',
        description: t('看原文：从某个位置起的一段，或某段文字所在的地方。', 'Read the text: a stretch from an offset, or the place where a piece of text is.'),
        parameters: {
          at: { type: 'integer', description: t('从第几个字符开始，默认 0（全书开头）。', 'Offset to start from; 0, the beginning of the book, by default.') },
          find: { type: 'string', description: t('要找的原文（一字不差）；给了它就显示它所在的地方。', 'Text to find, as written; when given, the place it is at is shown.') },
          chars: { type: 'integer', description: t('看多少字符，默认 1200，最多 4000。', 'How many characters to show; 1200 by default, 4000 at most.') },
        },
        run: args => this.look({ ...(argInt(args.at) !== undefined ? { at: argInt(args.at)! } : {}), ...(argText(args.find) !== undefined ? { find: argText(args.find)! } : {}), ...(argInt(args.chars) !== undefined ? { chars: argInt(args.chars)! } : {}) }),
      },
      {
        name: 'search',
        description: t('用正则表达式在全文里找：告诉你出现多少次、分布如何，并列出若干处及其前后文。用来弄清章节标题的写法。', 'Search the whole text with a regular expression: how often it occurs, how the matches are spread, and a number of them in context. For working out how the chapter headings are written.'),
        parameters: {
          pattern: { type: 'string', required: true, description: t('JavaScript 正则表达式（多行模式，^ $ 匹配行首行尾）。', 'A JavaScript regular expression (multiline: ^ and $ match at line ends).') },
          limit: { type: 'integer', description: t('列出多少处，默认 30。', 'How many matches to list; 30 by default.') },
        },
        run: args => this.search({ pattern: argText(args.pattern) ?? '', ...(argInt(args.limit) !== undefined ? { limit: argInt(args.limit)! } : {}) }),
      },
      {
        name: 'clean',
        description: t('删掉不属于这本书的杂质：网站导航、广告、页眉页脚、页码。匹配到的文字全部删除。只删杂质，不要删正文。', 'Delete what is not part of the book: site navigation, advertisements, running heads, page numbers. Everything the pattern matches is removed. Junk only — never prose.'),
        parameters: { pattern: { type: 'string', required: true, description: t('匹配杂质的正则表达式。', 'A regular expression matching the junk.') } },
        run: args => this.clean({ pattern: argText(args.pattern) ?? '' }),
      },
      {
        name: 'split',
        description: t('用章节标题的正则把全文切成章：每一处匹配是一章的开头，匹配到的文字是这一章的标题（正则里有括号分组时，用第一个分组作标题）。返回切分结果和需要核实的地方。可以反复调用，每次都重新切。', 'Cut the text into chapters by a regular expression for their headings: every match begins a chapter and is its title (the first capture group, when the pattern has one). Returns the split and what in it should be checked. Call it again to cut afresh.'),
        parameters: { pattern: { type: 'string', required: true, description: t('匹配整条章节标题的正则表达式（要把标题文字全部匹配进去，这样它才不会留在正文里）。', 'A regular expression matching a whole chapter heading (all of it, so that none of it stays in the prose).') } },
        run: args => this.split({ pattern: argText(args.pattern) ?? '' }),
      },
      {
        name: 'amend',
        closing: true,
        description: t('对切分结果做个别修正：补上漏掉的章、去掉误切的、改标题、标出卷、决定第一个标题之前的文字要不要。返回修正后的结果。', 'Correct the split in places: add a chapter that was missed, drop a false one, change a title, mark where a volume opens, decide whether the text before the first heading is kept. Returns the corrected split.'),
        parameters: {
          add: {
            type: 'array',
            description: t('要补上的章。', 'Chapters to add.'),
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                quote: { type: 'string', required: true, description: t('这一章开头处的原文，一字不差：通常是它的标题。', 'The text the chapter begins with, as written: usually its heading.') },
                title: { type: 'string', description: t('这一章的标题；不给就用 quote。', 'The chapter\'s title; the quote when left out.') },
                keep: { type: 'boolean', description: t('true 表示 quote 是正文的头几个字、要留在正文里（这时必须给 title）。默认 false：quote 是标题，从正文里去掉。', 'true when the quote is the first words of the prose and stays in it (a title is then required). Default false: the quote is the heading and is taken out of the prose.') },
              },
            },
          },
          drop: { type: 'array', items: { type: 'integer' }, description: t('要去掉的章序号（误切的）：它会并回上一章。', 'Numbers of chapters to drop (false cuts): each is joined to the chapter before it.') },
          rename: {
            type: 'array',
            description: t('要改的标题。', 'Titles to change.'),
            items: { type: 'object', additionalProperties: false, properties: { chapter: { type: 'integer', required: true }, title: { type: 'string', required: true } } },
          },
          volumes: {
            type: 'array',
            description: t('卷：从哪一章开始是哪一卷。', 'Volumes: which chapter opens which volume.'),
            items: { type: 'object', additionalProperties: false, properties: { chapter: { type: 'integer', required: true }, title: { type: 'string', description: t('卷名；留空表示取消。', 'The volume\'s title; empty to unmark.') } } },
          },
          front: { type: 'string', enum: ['keep', 'drop'], description: t('第一个标题之前的文字：keep 作为《卷首》一章导入，drop 不要。', 'The text before the first heading: keep imports it as a chapter, drop leaves it out.') },
          restore: { type: 'boolean', description: t('true：放弃后来的改动，回到异常最少的那一版切分。', 'true: give up later changes and go back to the split that had the least wrong with it.') },
        },
        run: args => this.amend({
          ...(args.restore === true || args.restore === 'true' ? { restore: true } : {}),
          add: argList(args.add),
          drop: argList(args.drop),
          rename: argList(args.rename),
          volumes: argList(args.volumes),
          ...(argText(args.front) !== undefined ? { front: argText(args.front)! } : {}),
        }),
      },
      {
        name: 'list',
        description: t('列出切分结果里的一段：序号、标题、字数和每章开头的几个字。', 'List a stretch of the split: number, title, length and the first words of each chapter.'),
        parameters: {
          from: { type: 'integer', description: t('从第几章开始，默认 1。', 'First chapter to list; 1 by default.') },
          count: { type: 'integer', description: t('列多少章，默认 40，最多 80。', 'How many; 40 by default, 80 at most.') },
        },
        run: args => this.list({ ...(argInt(args.from) !== undefined ? { from: argInt(args.from)! } : {}), ...(argInt(args.count) !== undefined ? { count: argInt(args.count)! } : {}) }),
      },
      {
        name: 'sections',
        description: t('只在确认全书没有任何章节标记时使用：按篇幅在段落之间切成小节。', 'Only when the book truly has no chapter marks at all: cut it between paragraphs into pieces by length.'),
        parameters: { chars: { type: 'integer', description: t('每节大约多少字。', 'About how many characters a piece.') } },
        run: args => this.sections({ ...(argInt(args.chars) !== undefined ? { chars: argInt(args.chars)! } : {}) }),
      },
      {
        name: 'finish',
        closing: true,
        description: t('结构确认无误后提交。提交后任务结束。', 'Commit the structure once it is right. The task ends with it.'),
        parameters: {
          note: { type: 'string', required: true, description: t('一两句话告诉作者：这本书的结构是什么样、你是怎么切的、删了什么、有没有拿不准的地方。', 'A sentence or two for the author: what the structure of the book is, how you cut it, what you removed, anything you are unsure of.') },
          title: { type: 'string', description: t('书名，如果原文里写了。', 'The book\'s title, if the text gives it.') },
          author: { type: 'string', description: t('作者，如果原文里写了。', 'The author, if the text names one.') },
          sure: { type: 'boolean', description: t('报告里还有“疑似误切”、而你核实过它们确实是章节时，填 true。', 'true when the report still lists likely false cuts and you have checked that they are chapters.') },
        },
        run: args => this.finish({ ...(argText(args.note) !== undefined ? { note: argText(args.note)! } : {}), ...(argText(args.title) !== undefined ? { title: argText(args.title)! } : {}), ...(argText(args.author) !== undefined ? { author: argText(args.author)! } : {}), ...(args.sure === true || args.sure === 'true' ? { sure: true } : {}) }),
      },
    ]
  }
}

// ───────────────────────────── the editor ─────────────────────────────

/** How a manuscript is taken in: the continuity keeper's craft for this one kind of work. */
const editorCraft = (zh: boolean): string => (zh
  ? `## 收录一份书稿
作者交来一份要导入的书稿——它可能是从网页、电子书或旧文档转出来的：章节标题的写法千差万别，还可能夹着网站导航、广告、页码之类不属于这本书的东西。这一次你的任务是找出这本书真实的章节结构，把它切成一章一章。这本书此刻还是空的，book_read / book_search 查不到东西；书稿只能通过下面这些工具看。

你看不到全文，只能通过工具查看和操作它：look 看原文，search 用正则查找，clean 删杂质，split 按标题切分，amend 做个别修正，list 查看结果，finish 提交。（sections 只在全书确实没有任何章节标记时才用。）

做法：
1. 先 look 开头，再看中间和靠后的地方各一处，弄清章节标题到底长什么样。标题不一定独占一行——来源混乱的文本里，它可能粘在上一段末尾，或夹在导航文字后面。
2. 用 search 验证判断：出现的次数像不像章数，间隔是否均匀，编号是否连续。
3. 有杂质先 clean，再 split。split 的正则要把整条标题都匹配进去（包括回目、章名），否则标题的后半截会留在正文里。标题在行中间也没关系，正则不必以行首开头。
4. 先用宽松一点的正则切出来——宁可多切几处。然后认真读 split 返回的报告：“疑似误切”的用 amend 的 drop 一次去掉；编号缺口、重复、过短、过长，回到原文（look）核实后用 amend 修正。缺的那一章几乎总是在——只是标题写法不同，比如丢了“第几回”只剩回目，用 amend 的 add 补上。不要为了个别误切或漏切去反复改正则重切；章数和编号大体对上之后，就不要再探索别的写法了。
5. 标题保留书里的原貌（如“第一回 甄士隐梦幻识通灵 贾雨村风尘怀闺秀”），只去掉杂质和多余的空白。
6. 书里有卷、部、篇这一层就用 amend 的 volumes 标出来；没有就不要硬分。
7. 目录不是正文：开头如果有一段目录，不要让它变成一堆空章（通常 front:"drop" 即可；目录里的标题如果被切成了章，用 drop 去掉）。
8. 你只决定从哪里切、每一章叫什么。不要改写、删节或总结正文。
9. 报告里没有异常了，就调用 finish，用一两句话告诉作者你是怎么处理的；不要反复核对已经没有问题的地方。提交之后不要再做任何事。`
  : `## Taking in a manuscript
The author hands you a book to import — possibly turned into text from a web page, an e-book or an old document: chapter headings written in any of a hundred ways, and among them things that are not part of the book at all, such as site navigation, advertisements, page numbers. This time your task is to find the book's real chapter structure and cut it into its chapters. The book itself is still empty — book_read and book_search find nothing; the manuscript is seen only through the tools below.

You cannot see the whole text; you look at it and work on it through tools: look reads the text, search finds by regular expression, clean removes junk, split cuts by headings, amend corrects in places, list shows the result, finish commits. (sections is only for a book that truly has no chapter marks at all.)

How to work:
1. Look at the opening, then at a place in the middle and one near the end, until you know what the chapter headings really look like. A heading need not stand on a line of its own — in a messy source it may be glued to the end of the paragraph before it, or follow navigation text.
2. Check with search: do the matches number like chapters, are they evenly spaced, do the numbers run on?
3. Clean junk first, then split. The split pattern must match the whole heading (its name as well as its number), or the rest of it stays in the prose. A heading in the middle of a line is fine: the pattern need not start at a line start.
4. Split with a pattern on the loose side first — rather a few cuts too many. Then read the report split returns with care: drop the "likely false cuts" in one go with amend drop; for a gap in the numbering, a duplicate, a chapter far too short or too long, go back to the text (look), then amend. A missing chapter is almost always there — under a heading written differently; add it with amend add. Do not rewrite the pattern and split again for the sake of a few false or missed cuts; once the count and the numbering are about right, stop exploring other ways the headings might be written.
5. Titles stay as the book has them; only junk and extra spaces go.
6. If the book has volumes, parts or books above its chapters, mark them with amend volumes; if it has none, add none.
7. A table of contents is not prose: do not let one become a row of empty chapters (front:"drop" usually does it; drop any headings of it that were cut as chapters).
8. You decide only where to cut and what each chapter is called. Never rewrite, shorten or summarize the prose.
9. Once the report shows nothing wrong, call finish and tell the author in a sentence or two what you did; do not keep checking what is already right. After that, do nothing more.`)

export interface Structure {
  chapters: SplitChapter[]
  /** Who found it: the editor agent, or the rules standing in for it. */
  by: 'agent' | 'rules'
  /** True when the pieces were cut by length because no chapter marks were found. */
  bySize: boolean
  /** What the editor says about the book's structure, or why the rules were used. */
  note?: string
  title?: string
  author?: string
  /** Tool calls the editor made. */
  steps?: number
}

/** A compact account of one tool call for whoever watches the job. */
function stepLine(tool: string, args: Record<string, unknown>, ok: boolean, result: string): string {
  const main = argText(args.pattern) ?? argText(args.find) ?? (args.at !== undefined ? `@${String(args.at)}` : undefined) ?? argText(args.note)
  const brief = oneLine(result.split('\n')[0] ?? '')
  return `› ${tool}${main !== undefined ? ` ${clip(oneLine(main), 60)}` : ''} — ${ok ? '' : '✗ '}${clip(brief, 110)}\n`
}

/**
 * Find the chapters of a manuscript: by the editor agent where one can run,
 * by rule where it cannot. Never throws for the agent's sake — an import must
 * not fail because its best way of being done is unavailable; it says which
 * way it was done.
 */
export async function findStructure(core: NovelCore, runtime: ProjectRuntime, source: string, task: TaskContext): Promise<Structure> {
  const manifest = await runtime.project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const byRule = (note: string): Structure => {
    const chapters = splitChapters(source, { zh })
    const sized = chapters.length > 0 && chapters.every((chapter, i) => chapter.title === sectionTitle(i + 1, zh))
    return { chapters, by: 'rules', bySize: sized, note }
  }
  const route = await core.route('analyst', runtime, task)
  const roles = core.roles
  const plan = crewPlan(core, 'analyst', manifest)
  const name = crewName('analyst', lang)
  if (plan.mode === 'call') {
    return byRule(L(lang, `${name}被设成了“普通调用”，而找章节要一边看一边试，只有作为 agent 才做得了；所以这次按规则切分。在“设置 → 班底”里把${name}改回 agent 再导入，章节会由它来找。`, `${name} is set to plain calls, and finding chapters takes looking and trying, which only an agent can do; so this import was cut by rule. Set ${name} back to agent in Settings → Crew and import again to have it find the chapters.`))
  }
  if (roles === undefined || !roles.can(route)) {
    return byRule(L(lang, `${name}要作为 agent 来找章节，需要一个 DSH「设置 → 模型」里的模型；当前的 ${route.model} 是旧的直连接口，所以这次按规则切分。`, `${name} finds the chapters as an agent and needs a model from DSH's Settings → Models; ${route.model} is a directly called endpoint of the old kind, so this import was cut by rule.`))
  }
  const draft = new Manuscript(source, zh)
  const lines = draft.text.split('\n')
  const standard = lines.filter(line => line.length <= 80 && CHAPTER_HEADING.test(line)).length
  const prompt = L(
    lang,
    `要导入的书稿：作者把这本书叫作《${manifest.title.replace(/^[《「『“"]+|[》」』”"]+$/gu, '')}》。全文 ${draft.text.length} 字符，${lines.length} 行。\n按最常见的写法（独占一行的“第X章/回/节”或 Chapter N）能找到 ${standard} 处标题${standard < 2 ? '——几乎没有，说明这份书稿的标题不是这种写法，或者不在行首' : ''}。\n\n请找出它的章节结构并提交。`,
    `The manuscript to import: the author calls the book "${manifest.title}". It is ${draft.text.length} characters in ${lines.length} lines.\nThe most common form of heading (a line of its own reading "Chapter N" or the like) occurs ${standard} time(s)${standard < 2 ? ' — hardly at all, so this manuscript writes its headings another way, or not at the start of a line' : ''}.\n\nFind its chapter structure and commit it.`,
  )
  const label = L(lang, `整理《${manifest.title.replace(/^[《「『“"]+|[》」』”"]+$/gu, '')}》的章节`, `Finding the chapters of "${manifest.title}"`)
  try {
    const outcome = await roles.run({
      role: 'analyst',
      label: `${name} · ${label}`,
      persona: CREW.analyst.persona[zh ? 0 : 1],
      rules: `${crewRules('analyst', lang, manifest)}\n\n${editorCraft(zh)}`,
      prompt,
      tools: draft.tools(),
      inherit: plan.inherit,
      route,
      maxSteps: Math.max(60, plan.steps),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.caller !== undefined ? { parent: task.caller } : {}),
      cwd: runtime.project.root,
      onStep: (step) => { task.job?.write(stepLine(step.tool, step.args, step.ok, step.result)) },
      unfinished: () => draft.finished ? undefined : L(lang, '章节结构还没有提交：报告里没有异常就调用 finish；还有要改的，改完再 finish。', 'The chapter structure has not been committed: call finish if the report shows nothing wrong; correct what is left first if it does.'),
    })
    task.job?.crew({ role: 'analyst', label, by: 'agent', steps: outcome.steps, ...(outcome.session !== undefined ? { session: outcome.session } : {}), ...(outcome.parent !== undefined ? { parent: outcome.parent } : {}) })
    task.signal?.throwIfAborted()
    if (draft.finished) {
      return {
        chapters: draft.chapters(),
        by: 'agent',
        bySize: draft.bySize,
        ...(draft.note.length > 0 ? { note: draft.note } : {}),
        ...(draft.title !== undefined ? { title: draft.title } : {}),
        ...(draft.author !== undefined ? { author: draft.author } : {}),
        steps: outcome.steps,
      }
    }
    core.log(`the importer agent stopped (${outcome.stop}) after ${outcome.steps} steps without committing a structure`)
    const settled = draft.settle()
    if (settled !== undefined) {
      return {
        chapters: draft.chapters(),
        by: 'agent',
        bySize: draft.bySize,
        note: L(lang, `${name}没有在限定的步数内提交（${outcome.steps} 步）。这里用的是它切出的最稳妥的一版：${settled.chapters} 章${settled.dropped > 0 ? `，自动去掉了 ${settled.dropped} 处读起来像正文的“标题”` : ''}${settled.retitled > 0 ? `，修正了 ${settled.retitled} 处粘着正文的标题` : ''}。请在大纲里核对一下。`, `${name} did not commit within its steps (${outcome.steps}). This is the soundest split it made: ${settled.chapters} chapters${settled.dropped > 0 ? `, with ${settled.dropped} "titles" that read like prose dropped automatically` : ''}${settled.retitled > 0 ? ` and ${settled.retitled} headings freed of the prose stuck to them` : ''}. Please check it in the outline.`),
        steps: outcome.steps,
      }
    }
    return byRule(L(lang, `${name}没有提交结果（${outcome.stop}，${outcome.steps} 步）${outcome.text.length > 0 ? `，它最后说：“${clip(outcome.text, 160)}”` : ''}。这次按规则切分。`, `${name} did not commit a structure (${outcome.stop}, ${outcome.steps} steps)${outcome.text.length > 0 ? `; its last words: "${clip(outcome.text, 160)}"` : ''}. This import was cut by rule.`))
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    core.log('the importer agent failed', error)
    const why = error instanceof LlmCallError || error instanceof Error ? error.message : String(error)
    return byRule(L(lang, `${name}没能运行（${clip(why, 200)}）。这次按规则切分。`, `${name} could not run (${clip(why, 200)}). This import was cut by rule.`))
  }
}

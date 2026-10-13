// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The material of a piece of writing, prepared before the writer is asked.
 *
 * The writer writes in one request and has no tools: of the book it knows
 * what it is handed. Packed by rule — the nearest chapters word for word,
 * whoever is named nearby, what a search turns up — that is a great deal
 * that has nothing to do with the piece, and not always what it turns on.
 * So where the author asks for a piece of writing — a chapter, a chapter
 * gone on with, a passage rewritten, a chapter written over — the planner
 * looks first: it is told the work, shown what the book has, reads in it as
 * far as the piece needs (a line small enough is put before it whole, and it
 * answers in one request), and hands in the material — what is asked of the
 * writer, where the story stands, what must hold, the form and the voice, in
 * its own words; and by name whose cards go along, which of the world, which
 * threads, which chapters whole or in outline, which stretches of text.
 *
 * The Studio puts that together (`packContext` with `chosen`) with what the
 * work stands on whoever prepares it: the book, the world's core, the
 * chapter's plan and what it was planned with, where the piece has to join,
 * the text that is worked on. The writer reads that, and writes.
 *
 * Where the planner cannot be asked, or what it hands in will not do, the
 * material is packed by rule as it always was — and the result says so.
 */
import { MAIN_LINE, PLANNER_WHOLE_DEFAULT, type CharacterCard, type MaterialKept, type MaterialUsed, type PlotThread, type WorldEntry } from '../../shared/types'
import { clip, countWords, estimateTokens, fuzzyFind, hashText, proseOnly, sameName } from '../../shared/text'
import { groupOf } from '../../shared/world'
import type { ChosenMaterial, ContextPack } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { assign } from '../crew'
import { derivationRecords, renderIntent, type IntentChapter } from '../derivations'
import { foundJottings, renderJottings } from '../jottings'
import { asArray, asRecord, asText } from '../llm'
import type { LocatedChapter } from '../project'
import { chapterAsMeant } from '../plans'
import { materialTask } from '../prompts'
import { L, promptLanguage, renderCharacter, renderPlan, renderWorld, roleLabel } from '../render'
import { errorMessage, isAbort } from '../util/async'

export type MaterialWork = MaterialKept['work']

export interface MaterialAsk {
  work: MaterialWork
  chapter: LocatedChapter
  /** What the author (or the showrunner) asks of this piece. */
  instruction?: string
  /** The chapter as the work has it, where it has text: what a passage is rewritten in, a chapter gone on from or written over. */
  text?: string
  /** `passage`: where the passage stands in `text`. */
  range?: { start: number; end: number }
  /** The reference notes kept on the chapter's plan, where they go to the writer. */
  notes?: string
  /** About how many tokens what is chosen may come to. */
  budget: number
  /** Who prepares it, said outright. Left out: as the settings say (`materialBy`). */
  by?: 'planner' | 'rules'
}

export interface Prepared {
  /** What the planner chose; absent where the material is packed by rule. */
  chosen?: ChosenMaterial
  /** Who prepared it and what went along, short of its size (known once it is packed). */
  used: Omit<MaterialUsed, 'tokens'>
}

/**
 * The task as those see it who work beside the writer, in a job whose text is the piece being written: the planner
 * preparing its material or reading the references for it, the scribe digesting it afterwards. What they do and say
 * is no part of that text — an agent's steps are written into its job's text, and a call's reply rewrites it, which
 * put a planner's `book_read chapter …` lines, or a digest's JSON, where the chapter was being shown. A step of
 * theirs is said where the job's progress is; nothing of it is written where the piece is.
 */
export function beside(task: TaskContext): TaskContext {
  const job = task.job
  if (job === undefined) return task
  let restore: (() => void) | undefined
  return {
    ...task,
    job: {
      ...job,
      rewrite: () => {},
      write: (delta) => {
        const said = delta.replace(/\s+/g, ' ').trim()
        if (said.length === 0) return
        restore?.()
        restore = job.note(clip(said, 90))
      },
    },
  }
}

/** A book as far as it says how it is written. */
type OwnWay = { materialBy?: 'planner' | 'rules' | 'agent' | undefined }

/**
 * How a chapter is written or gone on with: by the writer in one request, from what the Studio packed by rule
 * (`rules`) or the planner prepared (`planner`) — or by the writer as an agent, reading for itself (`agent`). Said
 * outright for the piece; else as the book has it; else as the Studio's settings say; and where nobody said, packed
 * by rule.
 * @param book - the book the piece is of, for its own way (`ProjectManifest.materialBy`).
 */
export function writingBy(core: NovelCore, explicit?: 'planner' | 'rules' | 'agent', book?: OwnWay): 'planner' | 'rules' | 'agent' {
  const way = explicit ?? book?.materialBy ?? core.currentSettings().materialBy
  return way === 'planner' || way === 'agent' ? way : 'rules'
}

/**
 * Who prepares the material of a piece of writing the author asks for ({@link writingBy}). (Where the writer is to
 * write as an agent — which it does for a chapter — the pieces that are written in one request all the same have
 * their material from the planner.)
 */
export function materialBy(core: NovelCore, explicit?: 'planner' | 'rules' | 'agent', book?: OwnWay): 'planner' | 'rules' {
  return writingBy(core, explicit, book) === 'rules' ? 'rules' : 'planner'
}

const ROLE_RANK: Record<CharacterCard['role'], number> = { protagonist: 0, deuteragonist: 1, antagonist: 2, supporting: 3, minor: 4, cameo: 5 }

/** A stretch of text chosen word for word is no chapter: longer than this, the chapter is taken whole or the stretch cut down. */
const EXCERPT_MOST = 6000
/** Tool calls the planner may make before it is told to hand in: for a passage, for a chapter. */
const STEPS = { passage: 10, chapter: 24 }
/** How many chapters, people and entries the planner is shown by name at most; the rest it finds with its tools. */
const LISTED = { chapters: 140, people: 40, names: 260, threads: 40 }

/** Pieces being prepared right now: several writers at one piece (a comparison) wait for the one preparing. */
const underway = new Map<string, Promise<Prepared>>()

/** Chapter numbers out of what a model wrote for a list of them: numbers, numbers as text, and ranges ("3-7"). */
function numbersOf(raw: unknown): number[] {
  const out: number[] = []
  for (const item of asArray(raw)) {
    if (typeof item === 'number' && Number.isFinite(item)) out.push(Math.trunc(item))
    else if (typeof item === 'string') {
      const range = /^\D*(\d+)\s*[-–—~至到]\s*(\d+)\D*$/.exec(item.trim())
      const single = /(\d+)/.exec(item)
      if (range !== null) for (let at = Number(range[1]); at <= Number(range[2]) && out.length < 2000; at++) out.push(at)
      else if (single !== null) out.push(Number(single[1]))
    }
  }
  return [...new Set(out)]
}

function namesOf(raw: unknown): string[] {
  return [...new Set(asArray(raw).map(item => (typeof item === 'string' ? item : typeof item === 'object' && item !== null ? asText((item as Record<string, unknown>).name) ?? asText((item as Record<string, unknown>).title) ?? '' : '')).map(name => name.trim().replace(/^[《「『“"]+|[》」』”"]+$/gu, '')).filter(name => name.length > 0))]
}

/**
 * Have the planner prepare the material of one piece of writing.
 * @returns what it chose, for `core.pack` to put together (`chosen`) — or, with `used.by === 'rules'`, nothing: the
 *   material is then packed by rule, because the author has it so, or because the planner could not be asked
 *   (`used.why` says which).
 */
export async function prepareMaterial(core: NovelCore, runtime: ProjectRuntime, ask: MaterialAsk, task: TaskContext): Promise<Prepared> {
  if (materialBy(core, ask.by, await runtime.project.manifest()) === 'rules') return { used: { by: 'rules' } }
  const key = [runtime.project.root, ask.chapter.plan.id, ask.work, hashText(`${ask.instruction ?? ''}\n${ask.range?.start ?? ''}:${ask.range?.end ?? ''}\n${ask.text ?? ''}`)].join('\n')
  const running = underway.get(key)
  if (running !== undefined) return await running
  const work = (async (): Promise<Prepared> => {
    try {
      return await prepare(core, runtime, ask, task)
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      // The piece is written all the same: by what the rules pack, and the result says why.
      core.log(`the planner could not prepare the material for ${ask.chapter.plan.id} (${ask.work}); packing it by rule`, error)
      return { used: { by: 'rules', why: clip(errorMessage(error), 240) } }
    }
  })()
  underway.set(key, work)
  try {
    return await work
  } finally {
    if (underway.get(key) === work) underway.delete(key)
  }
}

async function prepare(core: NovelCore, runtime: ProjectRuntime, ask: MaterialAsk, task: TaskContext): Promise<Prepared> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // A chapter drafted — for the first time, or over what it has — is prepared for as one never written: the planner is
  // shown its plan as it was meant, no text and no memory of it, and the threads without the marks its last draft left.
  const anew = ask.work === 'draft'
  const current = anew ? await chapterAsMeant(project, ask.chapter) : ask.chapter
  const scope = await project.lineScope(await project.lineOf(current.plan.id), anew ? current.plan : undefined)
  const path = scope.path
  const [everyone, everything] = await Promise.all([project.characters(), project.world()])
  const people = everyone.filter(card => scope.has(card)).sort((left, right) => ROLE_RANK[left.role] - ROLE_RANK[right.role])
  const world = everything.filter(entry => scope.knows(entry))
  const memories = new Map((await project.memories(path)).map(entry => [entry.chapter.plan.id, entry.memory]))
  // Every chapter of the line as the book has it, prose only: what is listed by its size, and what copied words are found in.
  const texts = new Map<string, string>()
  for (const chapter of path) texts.set(chapter.plan.id, proseOnly(await project.chapterText(chapter.plan.id)))
  if (anew) {
    texts.set(current.plan.id, '')
    memories.delete(current.plan.id)
  }
  const nameOf = (ref: string): string => everyone.find(card => card.id === ref)?.name ?? ref
  const numbered = (chapter: LocatedChapter): string => L(lang, `第 ${chapter.index} 章`, `chapter ${chapter.index}`)

  // ── what the book has, by name and size ──
  const at = path.findIndex(chapter => chapter.plan.id === current.plan.id)
  const near = path.length > LISTED.chapters ? path.filter((_, position) => position >= at - 90 && position <= at + (LISTED.chapters - 91)) : path
  const chapterLines = near.map((chapter) => {
    const text = texts.get(chapter.plan.id) ?? ''
    const told = clip((memories.get(chapter.plan.id)?.brief ?? chapter.plan.synopsis ?? '').replace(/\s+/g, ' ').trim(), 48)
    const here = chapter.plan.id === current.plan.id ? L(lang, ' ← 这一章', ' ← this chapter') : ''
    const size = text.length > 0 ? L(lang, `${countWords(text)} 字`, `${countWords(text)} words`) : L(lang, '未写', 'not written')
    return `${chapter.index}. 《${chapter.plan.title}》 ${size}${here}${told.length > 0 ? ` — ${told}` : ''}`
  })
  if (near.length < path.length) chapterLines.push(L(lang, `（这条线一共 ${path.length} 章，这里列的是这一章前后的 ${near.length} 章；别的用 book_read what=outline 看）`, `(The line has ${path.length} chapters; the ${near.length} around this one are listed. The others: book_read what=outline.)`))
  const peopleLines = [
    ...people.slice(0, LISTED.people).map(card => `${card.name}（${roleLabel(card.role, lang)}）${card.tagline !== undefined && card.tagline.trim().length > 0 ? `${L(lang, '：', ': ')}${clip(card.tagline.trim(), 44)}` : ''}`),
    ...(people.length > LISTED.people ? [`${L(lang, '还有：', 'Also: ')}${people.slice(LISTED.people, LISTED.people + LISTED.names).map(card => card.name).join(L(lang, '、', ', '))}`] : []),
  ]
  const groupWord: Record<ReturnType<typeof groupOf>, [string, string]> = { places: ['地点', 'Places'], factions: ['家族与组织', 'Houses and organisations'], items: ['物品', 'Things'], ideas: ['世界观与名词', 'Ideas and terms'] }
  const outer = world.filter(entry => entry.importance !== 1)
  const worldLines = (['places', 'factions', 'items', 'ideas'] as const).flatMap((group) => {
    const names = outer.filter(entry => groupOf(entry.category) === group).slice(0, LISTED.names).map(entry => entry.name)
    return names.length > 0 ? [`${L(lang, ...groupWord[group])}${L(lang, '：', ': ')}${names.join(L(lang, '、', ', '))}`] : []
  })
  const core1 = world.filter(entry => entry.importance === 1)
  if (core1.length > 0) worldLines.push(L(lang, `（核心设定 ${core1.map(entry => entry.name).join('、')} 会自动带上，不用选）`, `(The core entries — ${core1.map(entry => entry.name).join(', ')} — go along by themselves: not to be chosen.)`))
  const mine = new Set(current.plan.threads ?? [])
  const open = scope.threads.filter(entry => entry.open || mine.has(entry.thread.id)).map(entry => entry.thread)
  const threadLines = [...open.filter(thread => mine.has(thread.id)), ...open.filter(thread => !mine.has(thread.id))].slice(0, LISTED.threads)
    .map(thread => `${mine.has(thread.id) ? L(lang, '★本章涉及 ', '★ in this chapter ') : ''}${thread.title}${thread.description !== undefined && thread.description.trim().length > 0 ? ` — ${clip(thread.description.replace(/\s+/g, ' ').trim(), 36)}` : ''}`)
  const none = L(lang, '（没有）', '(none)')

  // ── a small line lies before the planner whole ──
  // Its text, its cards, its world: where all of that is little, there is nothing to look up — the planner reads it in
  // the one request it answers, instead of fetching it piece by piece over a dozen.
  const cardText = new Map(people.map(card => [card.id, renderCharacter(card, lang, { resolveName: nameOf })]))
  const entryText = new Map(world.map(entry => [entry.id, renderWorld(entry, lang)]))
  const others = path.filter(chapter => chapter.plan.id !== current.plan.id && (texts.get(chapter.plan.id) ?? '').length > 0)
  const jottings = await foundJottings(project).catch(() => [])
  const lineSize = others.reduce((sum, chapter) => sum + estimateTokens(texts.get(chapter.plan.id) ?? ''), 0)
    + people.reduce((sum, card) => sum + estimateTokens(cardText.get(card.id) ?? ''), 0)
    + outer.reduce((sum, entry) => sum + estimateTokens(entryText.get(entry.id) ?? ''), 0)
    + open.reduce((sum, thread) => sum + estimateTokens(`${thread.title}${thread.description ?? ''}`), 0)
    + jottings.reduce((sum, item) => sum + estimateTokens(item.text), 0)
  const most = (await core.settingsOf(runtime)).context.plannerWholeTokens ?? PLANNER_WHOLE_DEFAULT
  const seesAll = most > 0 && lineSize <= most
  const laid = !seesAll ? undefined : {
    texts: others.map(chapter => `【${numbered(chapter)}《${chapter.plan.title}》】\n${texts.get(chapter.plan.id) ?? ''}`).join('\n\n') || none,
    people: people.map(card => cardText.get(card.id) ?? '').join('\n\n') || none,
    world: [...outer.map(entry => entryText.get(entry.id) ?? ''), ...(core1.length > 0 ? [worldLines.at(-1)!] : [])].join('\n\n') || none,
    threads: [...open.filter(thread => mine.has(thread.id)), ...open.filter(thread => !mine.has(thread.id))]
      .map(thread => `${mine.has(thread.id) ? L(lang, '★本章涉及 ', '★ in this chapter ') : ''}${thread.title}${thread.description !== undefined && thread.description.trim().length > 0 ? ` — ${thread.description.replace(/\s+/g, ' ').trim()}` : ''}`).join('\n') || none,
    ...(jottings.length > 0 ? { jottings: renderJottings(jottings, lang) } : {}),
  }

  // ── the work ──
  const title = current.plan.title
  const whole = ask.text ?? ''
  const passage = ask.work === 'passage' && ask.range !== undefined ? whole.slice(ask.range.start, ask.range.end) : undefined
  const workWord = ask.work === 'draft' ? L(lang, `写${numbered(current)}《${title}》的正文，从第一句写起。`, `The text of ${numbered(current)}, "${title}", from its first sentence.`)
    : ask.work === 'continue' ? L(lang, `接着${numbered(current)}《${title}》已有的正文往下写（已有的在下面）。`, `${numbered(current)}, "${title}", gone on with from where its text stops (what it has is below).`)
      : ask.work === 'passage' ? L(lang, `改写${numbered(current)}《${title}》里的一段（下面 <<< >>> 之间的那一段），改好的原样替换它。`, `A passage of ${numbered(current)}, "${title}", rewritten (the one between <<< and >>> below): what comes back takes its place as it is.`)
        : L(lang, `把${numbered(current)}《${title}》整章重写（现有正文在下面）。`, `${numbered(current)}, "${title}", written over whole (as it stands, below).`)
  const records = await derivationRecords(project)
  const told: IntentChapter[] = path.map(chapter => ({ id: chapter.plan.id, index: chapter.index, title: chapter.plan.title, written: chapter.plan.id !== current.plan.id && (texts.get(chapter.plan.id) ?? '').length > 0 }))
  const intent = renderIntent(records.filter(record => record.chapters.includes(current.plan.id)), current.plan.id, told, lang, true)?.text
  // The chapter is shown whole where it is not too long to read at every step; a long one is read with the tool.
  const shown = whole.length > 0 && estimateTokens(whole) <= 14_000
  const around = passage !== undefined && ask.range !== undefined
    ? `${shown ? '' : `${clip(whole.slice(Math.max(0, ask.range.start - 1500), ask.range.start), 1500, '')}\n`}<<<\n${passage}\n>>>${shown ? '' : `\n${clip(whole.slice(ask.range.end), 800)}`}`
    : undefined
  const previous = [...path.slice(0, Math.max(0, at))].reverse().find(chapter => (texts.get(chapter.plan.id) ?? '').length > 0)
  const given = [
    L(lang, '本章章纲和当初定下的思路', 'the chapter\'s outline and the thinking it was planned with'),
    L(lang, '作品信息、标了“核心”的设定', 'the book\'s particulars and the core entries of the world'),
    L(lang, '全书文风', 'the book\'s style'),
    ...(ask.work === 'passage' ? [L(lang, '要改的那一段，和它前面约四千字、后面约两千字的原文', 'the passage, with some four thousand characters before it and two thousand after')] : []),
    ...(ask.work === 'continue' || ask.work === 'chapter' ? [L(lang, '这一章现在的正文（整章）', 'the chapter as it stands, whole')] : []),
    ...(ask.work !== 'passage' && previous !== undefined ? [L(lang, `上一章《${previous.plan.title}》结尾的原文（你把那一章整章带上的话就不重复）`, `the end of the chapter before, "${previous.plan.title}", word for word (not twice, where you take that chapter whole)`)] : []),
    L(lang, '到这一章为止已经死去、离开的人的名单', 'who is dead or gone from the story by this chapter'),
    ...(ask.notes !== undefined && ask.notes.trim().length > 0 ? [L(lang, '参考摘记', 'the notes from the references')] : []),
    L(lang, '作者给的参考图', 'the pictures the author gave'),
  ].join(L(lang, '；', '; '))

  // ── what is handed in, checked ──
  const cardCost = new Map(people.map(card => [card.id, estimateTokens(renderCharacter(card, lang, { resolveName: nameOf })) + 120]))
  const entryCost = new Map(world.map(entry => [entry.id, estimateTokens(renderWorld(entry, lang))]))
  interface Settled { chosen: ChosenMaterial; names: { people: string[]; world: string[]; threads: string[] }; chapters: number[]; note?: string }
  const settle = (raw: unknown): Settled => {
    const record = asRecord(raw)
    const wrong: string[] = []
    const words = {
      task: (asText(record.task) ?? '').trim(),
      situation: (asText(record.situation) ?? '').trim(),
      keep: asArray(record.keep).map(item => (typeof item === 'string' ? item.trim() : '')).filter(item => item.length > 0),
      form: (asText(record.form) ?? asText(record.format) ?? '').trim(),
      voice: (asText(record.voice) ?? asText(record.style) ?? '').trim(),
    }
    if (words.task.length === 0) wrong.push(L(lang, '"task" 是空的：写上这一次要写手写出什么、做到什么', '"task" is empty: say what the writer is to write this time, and what it has to do'))
    const find = <T extends { id: string; name: string; aliases?: string[] | undefined }>(list: readonly T[], name: string): T | undefined =>
      list.find(item => item.id === name || sameName(item.name, name)) ?? list.find(item => (item.aliases ?? []).some(alias => sameName(alias, name)))
    const cards: CharacterCard[] = []
    for (const name of namesOf(record.people)) {
      // (Somebody of another line of the plot may be wanted here: the planner named them.)
      const card = find(people, name) ?? find(everyone, name)
      if (card === undefined) wrong.push(L(lang, `people 里的「${name}」没有人物卡：名字照清单写；没有卡的人写进 situation`, `people: nobody has a card under "${name}" — write names as listed; somebody without a card goes into "situation"`))
      else if (!cards.includes(card)) cards.push(card)
    }
    const entries: WorldEntry[] = []
    for (const name of namesOf(record.world)) {
      const entry = find(world, name) ?? find(everything, name)
      if (entry === undefined) wrong.push(L(lang, `world 里的「${name}」不是设定里的条目：名字照清单写；没有条目的东西写进 situation`, `world: no entry is called "${name}" — write names as listed; what has no entry goes into "situation"`))
      else if (!entries.includes(entry)) entries.push(entry)
    }
    const threads: PlotThread[] = []
    for (const name of namesOf(record.threads)) {
      const all = scope.threads.map(entry => entry.thread)
      const thread = all.find(item => item.id === name || sameName(item.title, name)) ?? all.find(item => item.title.includes(name) || name.includes(item.title))
      if (thread === undefined) wrong.push(L(lang, `threads 里的「${name}」不是这条线上的线索：标题照清单写`, `threads: this line has no thread called "${name}" — write titles as listed`))
      else if (!threads.includes(thread)) threads.push(thread)
    }
    const byNumber = (number: number): LocatedChapter | undefined => path.find(chapter => chapter.index === number)
    const taken: LocatedChapter[] = []
    for (const number of numbersOf(record.chapters)) {
      const chapter = byNumber(number)
      if (chapter === undefined) wrong.push(L(lang, `chapters 里的 ${number}：这条线上没有第 ${number} 章`, `chapters: this line has no chapter ${number}`))
      // (The chapter in hand goes by itself where the work is on it; of a passage's chapter the planner may want the whole.)
      else if (chapter.plan.id === current.plan.id && ask.work !== 'passage') continue
      else if ((texts.get(chapter.plan.id) ?? '').length === 0) wrong.push(L(lang, `chapters 里的 ${number}：第 ${number} 章还没有正文（要它的章纲，放进 summaries）`, `chapters: chapter ${number} has no text yet (for its outline, put it under "summaries")`))
      else if (!taken.includes(chapter)) taken.push(chapter)
    }
    const outlined = numbersOf(record.summaries).map(byNumber).filter((chapter): chapter is LocatedChapter => chapter !== undefined && chapter.plan.id !== current.plan.id && !taken.includes(chapter))
    const excerpts: ChosenMaterial['excerpts'] = []
    for (const item of asArray(record.excerpts)) {
      const entry = asRecord(item)
      const number = numbersOf([entry.chapter])[0]
      const chapter = number !== undefined ? byNumber(number) : undefined
      const from = (asText(entry.from) ?? '').trim()
      const to = (asText(entry.to) ?? '').trim()
      if (chapter === undefined) { wrong.push(L(lang, `excerpts 里有一段没说清是第几章（chapter 写这条线上的章号）`, 'excerpts: one stretch does not say which chapter it is of ("chapter" takes its number on this line)')); continue }
      // Taken whole already: the stretch is in it.
      if (taken.includes(chapter)) continue
      const text = texts.get(chapter.plan.id) ?? ''
      const start = from.length > 0 ? fuzzyFind(text, from) : undefined
      if (start === undefined) { wrong.push(L(lang, `excerpts：第 ${chapter.index} 章里找不到开头「${clip(from, 30)}」——from 要从那一章的正文里逐字照抄（book_read 看原文）`, `excerpts: chapter ${chapter.index} does not have the opening "${clip(from, 30)}" — "from" is copied word for word from that chapter's text (book_read shows it)`)); continue }
      const rest = text.slice(start.end)
      const end = to.length > 0 ? fuzzyFind(rest, to) : undefined
      if (to.length > 0 && end === undefined) { wrong.push(L(lang, `excerpts：第 ${chapter.index} 章里，「${clip(from, 16)}」之后找不到结尾「${clip(to, 30)}」——to 逐字照抄，并且在 from 之后`, `excerpts: in chapter ${chapter.index}, the closing "${clip(to, 30)}" is not found after "${clip(from, 16)}" — "to" is copied word for word, and stands after "from"`)); continue }
      // (No closing given: the paragraph the opening stands in.)
      const stop = end !== undefined ? start.end + end.end : (() => { const next = text.indexOf('\n', start.end); return next < 0 ? text.length : next })()
      const stretch = text.slice(start.start, stop)
      if (stretch.length > EXCERPT_MOST) { wrong.push(L(lang, `excerpts：第 ${chapter.index} 章「${clip(from, 16)}」这一段有 ${stretch.length} 字，太长——缩到要对着看的那几段，或者把这一章放进 chapters 整章带`, `excerpts: the stretch of chapter ${chapter.index} from "${clip(from, 16)}" is ${stretch.length} characters, too long — cut it to the paragraphs that matter, or take the chapter whole under "chapters"`)); continue }
      const why = (asText(entry.why) ?? '').trim()
      excerpts.push({ chapter: chapter.plan.id, text: stretch, ...(why.length > 0 ? { why } : {}) })
    }
    if (wrong.length > 0) throw new Error(wrong.join('\n'))
    // Held to a size: what is chosen is counted — the planner's own words are small beside it.
    const sizes = {
      chapters: taken.reduce((sum, chapter) => sum + estimateTokens(texts.get(chapter.plan.id) ?? ''), 0),
      excerpts: excerpts.reduce((sum, item) => sum + estimateTokens(item.text), 0),
      people: cards.reduce((sum, card) => sum + (cardCost.get(card.id) ?? 400), 0),
      world: entries.filter(entry => entry.importance !== 1).reduce((sum, entry) => sum + (entryCost.get(entry.id) ?? 200), 0),
      summaries: outlined.reduce((sum, chapter) => sum + estimateTokens(memories.get(chapter.plan.id)?.summary ?? chapter.plan.synopsis ?? ''), 0),
    }
    const total = sizes.chapters + sizes.excerpts + sizes.people + sizes.world + sizes.summaries
    if (total > ask.budget) {
      throw new Error(L(lang,
        `带的东西约 ${total} 个 token，超过了 ${ask.budget}：整章原文 ${sizes.chapters}（${taken.map(chapter => chapter.index).join('、') || '无'}），片段 ${sizes.excerpts}，人物卡 ${sizes.people}，设定 ${sizes.world}，梗概 ${sizes.summaries}。少带些原文：整章改成 summaries 或只取 excerpts，别的在 situation 里用你自己的话交代。`,
        `What is chosen comes to about ${total} tokens, more than ${ask.budget}: whole chapters ${sizes.chapters} (${taken.map(chapter => chapter.index).join(', ') || 'none'}), stretches ${sizes.excerpts}, cards ${sizes.people}, the world ${sizes.world}, outlines ${sizes.summaries}. Take less text word for word: a chapter as a summary or as an excerpt, and the rest in your own words under "situation".`))
    }
    const note = (asText(record.note) ?? '').trim()
    return {
      chosen: {
        chapters: taken.map(chapter => chapter.plan.id),
        summaries: outlined.map(chapter => chapter.plan.id),
        excerpts,
        people: cards.map(card => card.id),
        world: entries.map(entry => entry.id),
        threads: threads.map(thread => thread.id),
        words: {
          task: words.task,
          ...(words.situation.length > 0 ? { situation: words.situation } : {}),
          ...(words.keep.length > 0 ? { keep: words.keep } : {}),
          ...(words.form.length > 0 ? { form: words.form } : {}),
          ...(words.voice.length > 0 ? { voice: words.voice } : {}),
        },
      },
      names: { people: cards.map(card => card.name), world: entries.map(entry => entry.name), threads: threads.map(thread => thread.title) },
      chapters: taken.map(chapter => chapter.index),
      ...(note.length > 0 ? { note } : {}),
    }
  }

  const label = ask.work === 'passage' ? L(lang, `为改写第 ${current.index} 章的一段备料`, `Preparing a passage of chapter ${current.index} for rewriting`)
    : ask.work === 'chapter' ? L(lang, `为重写第 ${current.index} 章备料`, `Preparing chapter ${current.index} to be written over`)
      : L(lang, `为写第 ${current.index} 章备料`, `Preparing chapter ${current.index} for writing`)
  // (Its steps are no part of the piece being written: see `beside`.)
  const { value, run } = await assign<Settled>(core, runtime, beside(task), {
    role: 'architect',
    label,
    tool: 'writing_material',
    what: L(lang, '给写手的材料', 'the material for the writer'),
    line: current.line ?? MAIN_LINE,
    // What its reading tool shows of the chapter in hand is the chapter as the work has it.
    // (A chapter drafted is read as empty: nothing of its last draft, nor of that draft's memory, is there to be found.)
    ...(whole.length > 0 ? { texts: new Map([[current.plan.id, whole]]) } : anew ? { texts: new Map([[current.plan.id, '']]) } : {}),
    prompt: materialTask({
      lang,
      language: manifest.language,
      title: manifest.title,
      work: workWord,
      ...(ask.instruction !== undefined && ask.instruction.trim().length > 0 ? { instruction: ask.instruction.trim() } : {}),
      plan: renderPlan(current.plan, current.index, lang, nameOf),
      ...(intent !== undefined ? { intent } : {}),
      ...(around !== undefined ? { passage: around } : {}),
      ...(whole.length > 0 ? (shown ? { text: whole } : { text: L(lang, `（这一章现有 ${countWords(proseOnly(whole))} 字，太长，没有放在这里：用 book_read what=chapter ref=${current.index} 分段读）`, `(The chapter runs to ${countWords(proseOnly(whole))} words — too long to put here: read it in pages with book_read what=chapter ref=${current.index}.)`) }) : {}),
      ...(ask.notes !== undefined && ask.notes.trim().length > 0 ? { notes: ask.notes.trim() } : {}),
      chapters: chapterLines.join('\n') || none,
      people: laid?.people ?? (peopleLines.join('\n') || none),
      world: laid?.world ?? (worldLines.join('\n') || none),
      threads: laid?.threads ?? (threadLines.join('\n') || none),
      given,
      budget: ask.budget,
      ...(laid !== undefined ? { whole: { texts: laid.texts, ...(laid.jottings !== undefined ? { jottings: laid.jottings } : {}) } } : {}),
    }),
    temperature: 0.3,
    // Everything it could look up is in its task: one request, whatever the planner is set to work as.
    ...(seesAll ? { plain: true } : {}),
    // A look, not a study: a passage is prepared in a few steps, a chapter in some more.
    maxSteps: ask.work === 'passage' ? STEPS.passage : STEPS.chapter,
    validate: settle,
  })
  const { chosen, names, chapters, note } = value
  return {
    chosen,
    used: {
      by: 'planner',
      how: run.by,
      ...(seesAll ? { whole: true } : {}),
      ...(run.steps !== undefined ? { steps: run.steps } : {}),
      ...(chapters.length > 0 ? { chapters } : {}),
      ...(chosen.summaries.length > 0 ? { summaries: chosen.summaries.length } : {}),
      ...(chosen.excerpts.length > 0 ? { excerpts: chosen.excerpts.length } : {}),
      ...(names.people.length > 0 ? { people: names.people } : {}),
      ...(names.world.length > 0 ? { world: names.world } : {}),
      ...(names.threads.length > 0 ? { threads: names.threads } : {}),
      ...(note !== undefined ? { note } : {}),
    },
  }
}

/** What went to the writer, once it is packed: who prepared it, what went along, how large it came out. */
export function materialUsed(prepared: Prepared, pack: ContextPack): MaterialUsed {
  return { ...prepared.used, tokens: pack.tokens }
}

/**
 * Keep the material of the piece of writing just done on a chapter, for the author to read: everything the writer was
 * handed, and who put it together. One for a chapter — the latest.
 */
export async function keepMaterial(runtime: ProjectRuntime, kept: Omit<MaterialKept, 'at'>): Promise<void> {
  // (Not a change to the book: nobody's page is told to load anew for it.)
  await runtime.project.writeState(['material', `${kept.chapter}.json`], { ...kept, at: new Date().toISOString() } satisfies MaterialKept, false)
}

/**
 * The material of the latest piece of writing done on a chapter, where any was kept.
 * @param version - one of the chapter's versions instead: what the writer of that draft was handed (kept with drafts written to be compared).
 */
export async function keptMaterial(runtime: ProjectRuntime, chapterRef: string, version?: string): Promise<MaterialKept | undefined> {
  const chapter = await runtime.project.findChapter(chapterRef)
  if (chapter === undefined) return undefined
  return version !== undefined ? await runtime.project.versionMaterial(chapter.plan.id, version) : await runtime.project.readState<MaterialKept>('material', `${chapter.plan.id}.json`)
}

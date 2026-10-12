// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The records of a book's derivations.
 *
 * A stretch of the story is planned from a direction the author gives — which
 * way it goes, in which key: glad, dark — and the planner says of what it hands
 * in why it went that way. The outline that comes of it is edited, moved, read
 * off the text again; what was said when it was made would be gone with the
 * form that asked for it. So it is kept: one record a derivation, in one file
 * of the book (`derivations/index.json`, sealed with it) — what was given to go
 * by, every hand-in with what was said of it, and which chapters came of it.
 *
 * The author reads them on a page. Whoever lays out the beats of a chapter, or
 * writes it, is handed the ones its chapter came of, and told which chapters
 * that thinking covers and where the one in hand stands among them.
 */
import type { Project } from './project'
import { ProjectError } from './project'
import { L } from './render'
import { KeyedMutex } from './util/async'
import { clip, newId } from '../shared/text'
import { DERIVATION_KINDS, type DerivationCover, type DerivationKind, type DerivationRecord, type DerivationsView, type DerivationTurn, type DerivationView, type PromptLanguage } from '../shared/types'

/** Where a book keeps the records of its derivations. */
export const DERIVATIONS_FILE = 'derivations/index.json'
/** How many of the ones taken away are kept to be put back. */
const REMOVED_KEPT = 60

interface DerivationsFile {
  schema: 1
  items: DerivationRecord[]
  removed?: (DerivationRecord & { removedAt: string })[]
}

/** Several derivations may end at once (a batch lays out many chapters' beats): each writes the file in its turn. */
const turnOf = new KeyedMutex()

const isKind = (value: unknown): value is DerivationKind => (DERIVATION_KINDS as readonly unknown[]).includes(value)

function clean(raw: unknown): DerivationRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const item = raw as Partial<DerivationRecord>
  if (typeof item.id !== 'string' || !isKind(item.kind)) return undefined
  const at = typeof item.at === 'string' ? item.at : new Date(0).toISOString()
  return {
    ...item,
    id: item.id,
    at,
    changed: typeof item.changed === 'string' ? item.changed : at,
    kind: item.kind,
    by: item.by === 'showrunner' ? 'showrunner' : 'author',
    turns: Array.isArray(item.turns) ? item.turns.filter(turn => typeof turn === 'object' && turn !== null) : [],
    chapters: Array.isArray(item.chapters) ? item.chapters.filter((id): id is string => typeof id === 'string') : [],
  }
}

async function readFile(project: Project): Promise<DerivationsFile> {
  try {
    const stored = JSON.parse((await project.readFile(DERIVATIONS_FILE)).toString('utf8')) as Partial<DerivationsFile>
    const items = (Array.isArray(stored.items) ? stored.items : []).map(clean).filter((item): item is DerivationRecord => item !== undefined)
    const removed = (Array.isArray(stored.removed) ? stored.removed : [])
      .map((raw) => { const item = clean(raw); return item !== undefined ? { ...item, removedAt: typeof raw?.removedAt === 'string' ? raw.removedAt : item.changed } : undefined })
      .filter((item): item is DerivationRecord & { removedAt: string } => item !== undefined)
    return { schema: 1, items, ...(removed.length > 0 ? { removed } : {}) }
  } catch {
    return { schema: 1, items: [] }
  }
}

async function change<T>(project: Project, work: (file: DerivationsFile) => { file?: DerivationsFile; value: T }): Promise<T> {
  return await turnOf.run(project.root, async () => {
    const done = work(await readFile(project))
    if (done.file !== undefined) await project.writeFile(DERIVATIONS_FILE, `${JSON.stringify(done.file, null, 2)}\n`)
    return done.value
  })
}

/** Who asked for a piece of work: the author on a page, or the showrunner in the conversation. */
export const askedBy = (task: { origin: 'agent' | 'user' }): DerivationRecord['by'] => task.origin === 'agent' ? 'showrunner' : 'author'

/** Every record the book keeps, in the order they were made. */
export async function derivationRecords(project: Project): Promise<DerivationRecord[]> {
  return (await readFile(project)).items
}

export type DerivationInput = Omit<DerivationRecord, 'id' | 'at' | 'changed' | 'turns' | 'chapters'> & { turns?: DerivationTurn[]; chapters?: string[] }

/** Keep the record of a derivation just made. */
export async function logDerivation(project: Project, input: DerivationInput): Promise<DerivationRecord> {
  const now = new Date().toISOString()
  const direction = input.direction?.trim()
  const { direction: _direction, ...rest } = input
  const made: DerivationRecord = {
    ...rest,
    id: newId('dv'),
    at: now,
    changed: now,
    ...(direction !== undefined && direction.length > 0 ? { direction } : {}),
    turns: input.turns ?? [],
    chapters: input.chapters ?? [],
  }
  return await change(project, file => ({ file: { ...file, items: [...file.items, made] }, value: made }))
}

/**
 * Change a record that is kept: what `to` hands back takes its place. Nothing where the book keeps none by that id —
 * a record the author took away meanwhile is not made again by the work it was of.
 */
export async function amendDerivation(project: Project, id: string, to: (record: DerivationRecord) => DerivationRecord): Promise<DerivationRecord | undefined> {
  return await change(project, (file) => {
    const before = file.items.find(item => item.id === id)
    if (before === undefined) return { value: undefined }
    const after = { ...to(before), id: before.id, at: before.at, changed: new Date().toISOString() }
    return { file: { ...file, items: file.items.map(item => item.id === id ? after : item) }, value: after }
  })
}

/**
 * What became of chapters derived to be looked at: added to the outline (`entered`: their ids, in order), or let go.
 */
export async function settleDerivation(project: Project, id: string, entered?: readonly string[]): Promise<DerivationRecord | undefined> {
  const ids = (entered ?? []).filter(chapter => typeof chapter === 'string' && chapter.length > 0)
  return await amendDerivation(project, id, record => record.state !== 'waiting' ? record : ids.length > 0 ? { ...record, state: 'entered', chapters: [...ids] } : { ...record, state: 'discarded' })
}

/**
 * What the author writes down themself of a stretch of chapters — which way they go, in which key: a record like one
 * a derivation leaves, for chapters that have none (planned before records were kept, or by hand).
 * @throws ProjectError `novel/invalid` with no text or no chapter.
 */
export async function noteDerivation(project: Project, input: { chapters: readonly string[]; text: string; line?: string }): Promise<DerivationRecord> {
  const text = input.text.trim()
  if (text.length === 0) throw new ProjectError('novel/invalid', 'say what these chapters were meant to be')
  const chapters = [...new Set(input.chapters.filter(id => typeof id === 'string' && id.length > 0))]
  if (chapters.length === 0) throw new ProjectError('novel/invalid', 'name the chapters this is the thinking behind')
  return await logDerivation(project, { kind: 'note', by: 'author', direction: text, chapters, ...(input.line !== undefined ? { line: input.line } : {}) })
}

/**
 * What the author may change of a record afterwards: what they add to it, whether it goes along with its chapters —
 * and, of one they wrote themself, its text and its chapters.
 * @throws ProjectError `novel/not-found` for an id the book has not.
 */
export async function updateDerivation(project: Project, id: string, input: { note?: string; carry?: boolean; text?: string; chapters?: readonly string[] }): Promise<DerivationRecord> {
  const after = await amendDerivation(project, id, (record) => {
    const { note: _note, carry: _carry, ...rest } = record
    const note = input.note !== undefined ? input.note.trim() : record.note
    const carry = input.carry !== undefined ? input.carry : record.carry !== false
    const own = record.kind === 'note'
    const text = own && input.text !== undefined && input.text.trim().length > 0 ? input.text.trim() : record.direction
    const chapters = own && input.chapters !== undefined && input.chapters.length > 0 ? [...new Set(input.chapters)] : record.chapters
    const { direction: _direction, ...bare } = rest
    return { ...bare, ...(text !== undefined ? { direction: text } : {}), chapters, ...(note !== undefined && note.length > 0 ? { note } : {}), ...(carry ? {} : { carry: false }) }
  })
  if (after === undefined) throw new ProjectError('novel/not-found', `the book keeps no derivation record "${id}"`)
  return after
}

/** Take a record away. It is kept among the ones taken away lately, to be put back. */
export async function removeDerivation(project: Project, id: string): Promise<void> {
  await change(project, (file) => {
    const gone = file.items.find(item => item.id === id)
    if (gone === undefined) throw new ProjectError('novel/not-found', `the book keeps no derivation record "${id}"`)
    const removed = [{ ...gone, removedAt: new Date().toISOString() }, ...(file.removed ?? [])].slice(0, REMOVED_KEPT)
    return { file: { ...file, items: file.items.filter(item => item.id !== id), removed }, value: undefined }
  })
}

/** Put back a record that was taken away: where it stood, by when it was made. */
export async function restoreDerivation(project: Project, id: string): Promise<DerivationRecord> {
  return await change(project, (file) => {
    const back = (file.removed ?? []).find(item => item.id === id)
    if (back === undefined) throw new ProjectError('novel/not-found', `no derivation record "${id}" among the ones taken away`)
    const { removedAt: _removedAt, ...item } = back
    const removed = (file.removed ?? []).filter(other => other.id !== id)
    const { removed: _old, ...rest } = file
    const items = [...file.items, item].sort((left, right) => left.at.localeCompare(right.at))
    return { file: { ...rest, items, ...(removed.length > 0 ? { removed } : {}) }, value: item }
  })
}

/** The book's records as a page shows them: the latest first, each with where its chapters stand now. */
export async function derivationsView(project: Project): Promise<DerivationsView> {
  const file = await readFile(project)
  if (file.items.length === 0 && (file.removed ?? []).length === 0) return { items: [], removed: [] }
  // Every chapter the outline has, by its id: on the main line, then on the others (one shared with the main line is the main line's).
  const known = new Map<string, DerivationCover>()
  for (const info of await project.chapterInfos()) known.set(info.id, { id: info.id, index: info.index, title: info.title, written: info.hasText })
  for (const line of (await project.outline()).lines ?? []) {
    for (const info of await project.chapterInfos(line.id)) if (!known.has(info.id)) known.set(info.id, { id: info.id, index: info.index, title: info.title, written: info.hasText, line: line.id })
  }
  const items: DerivationView[] = file.items.map((record) => {
    const covers = record.chapters.map(id => known.get(id)).filter((cover): cover is DerivationCover => cover !== undefined)
    return { ...record, covers, lost: record.chapters.length - covers.length }
  })
  return {
    items: items.sort((left, right) => right.at.localeCompare(left.at)),
    removed: [...(file.removed ?? [])].sort((left, right) => right.removedAt.localeCompare(left.removedAt)),
  }
}

// ── what is handed to whoever plans or writes ──

/** A chapter of the line being worked on, as the thinking behind it is told by. */
export interface IntentChapter { id: string; index: number; title: string; written: boolean }

const KIND_WORD: Record<DerivationKind, [string, string]> = {
  chapters: ['推演章节', 'chapters derived'],
  beats: ['推演节拍', 'beats laid out'],
  beat: ['加 / 改节拍', 'a beat by a sentence'],
  whatif: ['假设推演', 'what-if'],
  foundation: ['新书起头', "the book's foundation"],
  note: ['作者自己记的', "the author's own note"],
}

/** A record's kind in words. */
export function derivationKindWord(kind: DerivationKind, lang: PromptLanguage): string {
  return L(lang, ...KIND_WORD[kind])
}

/** The kinds that are the thinking behind a stretch of chapters. */
const OF_A_STRETCH: readonly DerivationKind[] = ['chapters', 'foundation', 'note']

/** A record that stands — neither still looked at nor let go — and is not kept back by the author. */
const carried = (record: DerivationRecord): boolean => record.carry !== false && record.state !== 'waiting' && record.state !== 'discarded'

/** "Chapters 6–10", "chapters 6, 7 and 9", "chapter 7": the chapters by their place on the line. */
function span(indexes: readonly number[], lang: PromptLanguage): string {
  const sorted = [...indexes].sort((left, right) => left - right)
  if (sorted.length === 0) return ''
  if (sorted.length === 1) return L(lang, `第 ${sorted[0]} 章`, `chapter ${sorted[0]}`)
  const run = sorted.every((index, at) => at === 0 || index === sorted[at - 1]! + 1)
  return run
    ? L(lang, `第 ${sorted[0]}–${sorted.at(-1)} 章`, `chapters ${sorted[0]}–${sorted.at(-1)}`)
    : L(lang, `第 ${sorted.join('、')} 章`, `chapters ${sorted.join(', ')}`)
}

const day = (iso: string): string => iso.slice(0, 10)

/** What a record says, in the words it was said in: the direction, each word of the author's that followed, what the planner said last, what the author added. */
function said(record: DerivationRecord, lang: PromptLanguage, most?: number): string[] {
  const cut = (text: string): string => most !== undefined ? clip(text.trim(), most) : text.trim()
  const words = record.turns.map(turn => turn.feedback?.trim() ?? '').filter(word => word.length > 0)
  const rationale = [...record.turns].reverse().find(turn => (turn.rationale ?? '').trim().length > 0)?.rationale
  const own = record.kind === 'note'
  return [
    record.direction !== undefined ? `${own ? L(lang, '作者写的：', 'The author wrote:') : record.kind === 'foundation' ? L(lang, '作者起头时写下的想法：', 'The idea the author began with:') : L(lang, '作者给的方向：', 'The direction the author gave:')}\n${cut(record.direction)}` : undefined,
    words.length > 0 ? `${L(lang, '作者看过之后要改的：', 'What the author then wanted changed:')}\n${words.map((word, at) => `${at + 1}. ${cut(word)}`).join('\n')}` : undefined,
    rationale !== undefined ? `${L(lang, '策划当时的说明（写给作者看的；里面提到而没有采用的别的走法不算数）：', 'What the planner said of it then (written for the author; ways it names and did not take do not count):')}\n${cut(rationale)}` : undefined,
    record.note !== undefined ? `${L(lang, '作者后来补的：', 'What the author added later:')}\n${cut(record.note)}` : undefined,
  ].filter((part): part is string => part !== undefined)
}

/**
 * The thinking behind one chapter, as whoever lays out its beats or writes it is given it: each record its chapter
 * came of — which chapters of this line that thinking covers, where the one in hand stands among them, and what was
 * said. `withBeats`: also what the author said when its beats were laid out or touched (for whoever writes; whoever
 * lays the beats out anew is given the author's word of the moment instead).
 * @returns the text and how many records it tells of; nothing where no record covers the chapter.
 */
export function renderIntent(records: readonly DerivationRecord[], chapterId: string, path: readonly IntentChapter[], lang: PromptLanguage, withBeats: boolean): { text: string; records: number } | undefined {
  const here = path.find(chapter => chapter.id === chapterId)
  if (here === undefined) return undefined
  const onPath = new Map(path.map(chapter => [chapter.id, chapter]))
  const mine = records.filter(record => carried(record) && record.chapters.includes(chapterId))
  const blocks: string[] = []
  let told = 0
  for (const record of mine.filter(candidate => OF_A_STRETCH.includes(candidate.kind))) {
    const parts = said(record, lang)
    if (parts.length === 0) continue
    const covers = record.chapters.map(id => onPath.get(id)).filter((chapter): chapter is IntentChapter => chapter !== undefined).sort((left, right) => left.index - right.index)
    const place = covers.findIndex(chapter => chapter.id === chapterId) + 1
    const head = `〔${derivationKindWord(record.kind, lang)} · ${day(record.at)}〕`
    const where = covers.length <= 1
      ? L(lang, `这一段思路只管这一章（第 ${here.index} 章）。`, `This thinking is of this chapter alone (chapter ${here.index}).`)
      : [
          L(lang, `这一段思路管${span(covers.map(chapter => chapter.index), lang)}，共 ${covers.length} 章。现在这一章是第 ${here.index} 章——这一段里的第 ${place} 章：`, `This thinking covers ${span(covers.map(chapter => chapter.index), lang)}, ${covers.length} chapters. The chapter in hand is chapter ${here.index} — number ${place} of them:`),
          ...covers.map((chapter, at) => `${at + 1}. ${L(lang, `第 ${chapter.index} 章《${chapter.title}》`, `chapter ${chapter.index}, "${chapter.title}"`)}${chapter.id === chapterId ? L(lang, ' ← 现在这一章', ' ← the chapter in hand') : chapter.written ? L(lang, '（已写）', ' (written)') : L(lang, '（还没写）', ' (not written yet)')}`),
        ].join('\n')
    blocks.push([`${head}${where}`, ...parts].join('\n\n'))
    told += 1
  }
  if (withBeats) {
    // What was said when this chapter's beats were laid out: the last time holds, and what was said of single beats since.
    const laid = mine.filter(record => record.kind === 'beats')
    const last = laid.at(-1)
    const lastSaid = [...laid].reverse().find(record => record.direction !== undefined || record.note !== undefined)
    if (lastSaid !== undefined && lastSaid === last) {
      blocks.push([
        `〔${L(lang, '排这一章的节拍时', "when this chapter's beats were laid out")} · ${day(lastSaid.at)}〕`,
        ...(lastSaid.direction !== undefined ? [`${L(lang, '作者给的方向：', 'The direction the author gave:')}\n${lastSaid.direction}`] : []),
        ...(lastSaid.note !== undefined ? [`${L(lang, '作者后来补的：', 'What the author added later:')}\n${lastSaid.note}`] : []),
      ].join('\n\n'))
      told += 1
    }
    const since = mine.filter(record => record.kind === 'beat' && record.direction !== undefined && (last === undefined || record.at > last.at)).slice(-6)
    if (since.length > 0) {
      blocks.push(`〔${L(lang, '作者加、改这一章的节拍时说的话', "what the author said when adding to or changing this chapter's beats")}〕\n${since.map((record, at) => `${at + 1}. ${record.direction!}`).join('\n')}`)
      told += since.length
    }
  }
  if (blocks.length === 0) return undefined
  // What holds where: an outline says what happens and is edited after it was derived; the key a stretch is told in
  // is said here and nowhere else — so the outline holds for the events, and this for the key.
  const lead = L(lang,
    '本章发生什么，照它自己的章纲。这一段的基调——轻还是重、亮还是暗、要读者笑还是要读者怕——照下面定的来；它和全书文风里写的气氛、和节拍上标的情绪不一样时，这几章照这里的。章纲后来改过、事情和下面说的对不上时，事情以章纲为准。',
    "What happens in this chapter is its own outline's to say. The key this stretch is told in — light or heavy, bright or dark, to be laughed at or feared — is as set below; where that differs from the mood the book's style names, or from the emotion marked on a beat, these chapters go by this. Where the outline was changed since and the events differ from what is said below, the outline holds for the events.")
  return { text: `${lead}\n\n${blocks.join('\n\n———\n\n')}`, records: told }
}

/** The title the thinking behind a chapter goes under, in what a role is given to read. */
export function intentTitle(lang: PromptLanguage): string {
  return L(lang,
    '这几章当初定下的思路（推演时作者给的方向和策划的说明：这一段要讲什么、是什么基调）',
    'The thinking these chapters were planned with (the direction the author gave and what the planner said of it: what this stretch tells, and in which key)')
}

/**
 * The thinking a line of the plot was planned with so far, for whoever plans what comes next on it: its latest
 * stretches, the earliest of them first.
 */
export function renderLineIntents(records: readonly DerivationRecord[], path: readonly IntentChapter[], lang: PromptLanguage, most = 3): { text: string; records: number } | undefined {
  const onPath = new Map(path.map(chapter => [chapter.id, chapter]))
  const stretches = records
    .filter(record => carried(record) && OF_A_STRETCH.includes(record.kind))
    .map(record => ({ record, covers: record.chapters.map(id => onPath.get(id)).filter((chapter): chapter is IntentChapter => chapter !== undefined).sort((left, right) => left.index - right.index) }))
    .filter(entry => entry.covers.length > 0)
    .map(entry => ({ ...entry, parts: said(entry.record, lang, 700) }))
    .filter(entry => entry.parts.length > 0)
    // By where they end on the line: the stretches nearest to what is planned now.
    .sort((left, right) => left.covers.at(-1)!.index - right.covers.at(-1)!.index || left.record.at.localeCompare(right.record.at))
    .slice(-most)
  if (stretches.length === 0) return undefined
  return {
    text: stretches.map(entry => [`〔${derivationKindWord(entry.record.kind, lang)} · ${day(entry.record.at)}〕${span(entry.covers.map(chapter => chapter.index), lang)}`, ...entry.parts].join('\n\n')).join('\n\n———\n\n'),
    records: stretches.length,
  }
}

/** The title the thinking a line was planned with goes under. */
export function lineIntentsTitle(lang: PromptLanguage): string {
  return L(lang,
    '这条线此前几次推演时定下的思路（最近的在后：前面的基调和打算。这一次以作者这次给的方向为准）',
    "The thinking this line was planned with before (the latest last: the key and the intent of what came before. This time, what the author gives now holds)")
}

/** A record told in a line, for a list an agent reads. */
export function derivationLine(record: DerivationView, lang: PromptLanguage): string {
  const where = record.covers.length > 0 ? span(record.covers.map(cover => cover.index), lang) : record.state === 'waiting' ? L(lang, '待看，还没进大纲', 'waiting to be looked at') : record.state === 'discarded' ? L(lang, '放弃了', 'let go') : record.kind === 'whatif' ? '' : L(lang, '它的章节已不在大纲里', 'its chapters are no longer in the outline')
  const asked = record.direction !== undefined ? clip(record.direction.replace(/\s+/g, ' '), 120) : L(lang, '（没有给方向）', '(no direction given)')
  return `- [${record.id}; ${record.kind}; ${day(record.at)}${record.by === 'showrunner' ? '; showrunner' : ''}${record.carry === false ? '; kept back' : ''}] ${where}${where.length > 0 ? ' — ' : ''}${asked}`
}

/** A record told whole, for an agent that asks for it: what was given, every hand-in with what was said of it. */
export function derivationWhole(record: DerivationView, lang: PromptLanguage, nameOf: (ref: string) => string = ref => ref): string {
  const comma = lang === 'zh' ? '、' : ', '
  const turns = record.turns.map((turn, at) => [
    `### ${L(lang, `第 ${at + 1} 次交回`, `Hand-in ${at + 1}`)} · ${turn.at.slice(0, 16).replace('T', ' ')}`,
    ...(turn.feedback !== undefined ? [`${L(lang, '作者对上一版说：', 'What the author said of the one before: ')}${turn.feedback}`] : []),
    ...(turn.rationale !== undefined ? [`${L(lang, '策划的说明：', 'The planner: ')}${turn.rationale}`] : []),
    ...(turn.chapters ?? []).map((chapter, index) => [
      `${index + 1}. ${chapter.title}${chapter.synopsis !== undefined ? `${lang === 'zh' ? '：' : ': '}${chapter.synopsis}` : ''}`,
      ...(chapter.purpose !== undefined ? [`   ${L(lang, '作用：', 'Purpose: ')}${chapter.purpose}`] : []),
      ...(chapter.characters.length > 0 ? [`   ${L(lang, '出场：', 'Cast: ')}${chapter.characters.map(nameOf).join(comma)}`] : []),
      ...chapter.beats.map((beat, no) => `   ${no + 1}) ${beat.summary}`),
    ].join('\n')),
    ...((turn.beats ?? []).length > 0 ? [(turn.beats ?? []).map((beat, no) => `${no + 1}) ${beat.summary}`).join('\n')] : []),
    ...(turn.branches ?? []).map((branch, index) => `${index + 1}. ${branch.title}${lang === 'zh' ? '：' : ': '}${branch.development}`),
    ...(turn.recommendation !== undefined ? [`${L(lang, '策划的建议：', 'Recommended: ')}${turn.recommendation}`] : []),
  ].join('\n'))
  return [
    `${L(lang, '推演记录', 'Derivation record')} [${record.id}] · ${derivationKindWord(record.kind, lang)} · ${record.at.slice(0, 16).replace('T', ' ')} · ${record.by === 'showrunner' ? L(lang, '总编经手', 'asked by the showrunner') : L(lang, '作者在页面上发起', 'asked by the author on a page')}`,
    record.covers.length > 0 ? `${L(lang, '现在在大纲里：', 'In the outline now: ')}${record.covers.map(cover => L(lang, `第 ${cover.index} 章《${cover.title}》${cover.written ? '（已写）' : ''}`, `ch. ${cover.index} "${cover.title}"${cover.written ? ' (written)' : ''}`)).join(comma)}` : record.state === 'waiting' ? L(lang, '还在等作者看，没有进大纲。', 'Waiting to be looked at; not in the outline.') : record.state === 'discarded' ? L(lang, '作者放弃了这一版。', 'The author let it go.') : undefined,
    record.lost > 0 ? L(lang, `另有 ${record.lost} 章已不在大纲里。`, `${record.lost} more chapter(s) of it are no longer in the outline.`) : undefined,
    record.direction !== undefined ? `## ${L(lang, '作者给的', 'What the author gave')}\n${record.direction}` : L(lang, '（作者没有给方向）', '(the author gave no direction)'),
    record.note !== undefined ? `## ${L(lang, '作者后来补的', 'What the author added later')}\n${record.note}` : undefined,
    record.carry === false ? L(lang, '（作者设成了：排节拍、写作时不带这一条）', '(the author keeps it from going along when its chapters are planned or written)') : undefined,
    ...turns,
  ].filter((part): part is string => part !== undefined).join('\n\n')
}

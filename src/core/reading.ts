// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Reading a book the way a model reads it: one thing at a time, in full, as
 * text. The showrunner reads through `novel_read` and `novel_search`; every
 * role of the crew reads through tools of its own that end up here — one
 * account of the book for everyone who works on it.
 */
import type { ProjectRuntime } from './core'
import { ProjectError, type LineScope, type Project } from './project'
import { L, promptLanguage, renderCharacter, renderPlan, renderStyle, renderThread, renderWorld, roleLabel } from './render'
import { lifeLine } from '../shared/life'
import { clip } from '../shared/text'
import { MAIN_LINE, type SearchSource } from '../shared/types'

export const READ_KINDS = ['chapter', 'outline', 'character', 'world', 'style', 'memory', 'threads', 'review', 'versions'] as const
export type ReadKind = typeof READ_KINDS[number]

export const SEARCH_SOURCES: SearchSource[] = ['manuscript', 'character', 'world', 'memory', 'outline']

/**
 * The line of the plot a reader is kept to. A role whose work is on one line reads that line: its chapters, numbered
 * along it, its people, its threads — and nothing of the book's other lines, which are other stories as far as that
 * work goes.
 */
export interface ReadScope {
  /** The line's id; `main` for the main one. */
  line: string
}

export interface ReadRequest {
  what: ReadKind
  ref?: string | undefined
  /** The line of the plot to read along, by id or name, where the reader is kept to none: chapter numbers count along it. Left out: the main line, and the whole book where a list is asked for. */
  line?: string | undefined
  /** For chapter text: character offset to start from. */
  offset?: number | undefined
  /** For chapter text: most characters to return. */
  limit?: number | undefined
}

export interface Reading {
  text: string
  /** The thing itself, for callers that take structure. */
  data?: unknown
}

function flat(text: string | undefined, max: number): string {
  if (text === undefined) return ''
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** The line a reader reads along: the one it is kept to, else the one it asked for. */
async function scopeOf(project: Project, asked: string | undefined, kept: ReadScope | undefined): Promise<LineScope | undefined> {
  if (kept !== undefined) return await project.lineScope(kept.line)
  const wanted = asked?.trim()
  if (wanted === undefined || wanted.length === 0) return undefined
  if (wanted === MAIN_LINE || /^(main|主线)$/i.test(wanted)) return await project.lineScope()
  const line = await project.findLine(wanted)
  if (line === undefined) throw new ProjectError('novel/not-found', `no line of the plot matches "${asked}" — the outline lists the lines`)
  return await project.lineScope(line.id)
}

const lineName = (scope: LineScope): string => scope.title !== undefined ? `the line "${scope.title}"` : 'the main line'

/**
 * @param tools - what the reader should be pointed at where something is missing: the names differ between the showrunner and the crew.
 * @param kept - the line of the plot this reader is kept to (a role at work on one line); the showrunner is kept to none.
 * @param texts - chapters to be read otherwise than the book has them, by id: the text a piece of work goes by where
 *   that is not the saved one (a mending that goes on from changes still waiting reads the chapter with them laid in).
 * @throws ProjectError `novel/not-found` or `novel/invalid`, in words the model can act on.
 */
export async function readBook(runtime: ProjectRuntime, request: ReadRequest, tools: { read: string; digest?: string; review?: string } = { read: 'novel_read', digest: 'novel_digest', review: 'novel_review' }, kept?: ReadScope, texts?: ReadonlyMap<string, string>): Promise<Reading> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const scope = await scopeOf(project, request.line, kept)
  const everyone = await project.characters()
  const characters = scope !== undefined ? everyone.filter(card => scope.has(card)) : everyone
  const nameOf = (ref: string): string => everyone.find(card => card.id === ref)?.name ?? ref
  const given = request.ref !== undefined && request.ref.trim().length > 0 ? request.ref.trim() : undefined
  const needRef = (): string => {
    if (given === undefined) throw new ProjectError('novel/invalid', `${tools.read} what=${request.what} needs \`ref\``)
    return given
  }
  const chapterOf = async () => {
    const chapter = await project.findChapter(needRef(), scope?.line)
    if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${request.ref}"${scope !== undefined ? ` on ${lineName(scope)}` : ''} — ${tools.read} what=outline lists the chapters`)
    // An id finds its chapter on whichever line it is: a reader kept to one line is told so, and reads its own.
    if (kept !== undefined && scope !== undefined && !scope.reads(chapter.plan.id)) throw new ProjectError('novel/not-found', `"${request.ref}" is a chapter of another line of the plot. This work is on ${lineName(scope)}, and reads that line only — ${tools.read} what=outline lists its chapters`)
    return chapter
  }
  const alongLine = scope !== undefined && scope.line !== MAIN_LINE ? scope.line : undefined
  switch (request.what) {
    case 'chapter': {
      const chapter = await chapterOf()
      const other = texts?.get(chapter.plan.id)
      const text = other ?? await project.chapterText(chapter.plan.id)
      if (text.length === 0) return { text: `Chapter ${chapter.index} "${chapter.plan.title}" (${chapter.plan.id}) has no text yet.` }
      const offset = Math.max(0, request.offset ?? 0)
      const limit = Math.max(200, Math.min(40_000, request.limit ?? 6000))
      const slice = text.slice(offset, offset + limit)
      const more = offset + limit < text.length
      return {
        text: `Chapter ${chapter.index} "${chapter.plan.title}" (${chapter.plan.id})${other !== undefined ? ', as this work goes by it — with the changes that still wait for it laid in' : ''}, characters ${offset}–${offset + slice.length} of ${text.length}${more ? ` (continue with offset=${offset + slice.length})` : ''}:\n\n${slice}`,
        data: { chapterId: chapter.plan.id, length: text.length, offset, more },
      }
    }
    case 'outline': {
      if (given !== undefined) {
        const chapter = await chapterOf()
        return { text: `${renderPlan(chapter.plan, chapter.index, lang, nameOf)}\n\n[${chapter.plan.id}; status ${chapter.plan.status}; volume ${chapter.volume.title}]`, data: chapter.plan }
      }
      const outline = await project.outline()
      const parts: string[] = []
      const entry = (index: number, plan: { id: string; title: string; status: string; synopsis?: string }): string => `${index}. ${plan.title} [${plan.id}; ${plan.status}]${plan.synopsis !== undefined ? `\n   ${flat(plan.synopsis, 300)}` : ''}`
      const mainLine = (): void => {
        let index = 0
        for (const volume of outline.volumes) {
          parts.push(`## ${volume.title} (${volume.id})${volume.synopsis !== undefined ? `\n${volume.synopsis}` : ''}${volume.goal !== undefined ? `\n${L(lang, '目标', 'Goal')}: ${volume.goal}` : ''}`)
          for (const plan of volume.chapters) parts.push(entry(++index, plan))
        }
      }
      // A line beside the main one: what is read on it, numbered along it — what it shares with the line it parts from, then its own.
      const otherLine = async (id: string, whole: boolean): Promise<void> => {
        const line = (outline.lines ?? []).find(candidate => candidate.id === id)
        if (line === undefined) return
        const path = await project.chapters(line.id)
        const own = path.filter(chapter => chapter.line === line.id)
        const fork = line.from !== undefined ? path.find(chapter => chapter.plan.id === line.from) : undefined
        parts.push(`## ${L(lang, `剧情线「${line.title}」`, `Line "${line.title}"`)} (${line.id})${line.shelved === true ? L(lang, '（搁置）', ' (put aside)') : ''} — ${fork !== undefined ? L(lang, `在第 ${fork.index} 章《${fork.plan.title}》之后分出`, `leaves after chapter ${fork.index}, "${fork.plan.title}"`) : L(lang, '从故事开头就是独立的一条线', 'a line of its own from the first page')}${line.premise !== undefined ? `\n${line.premise}` : ''}${line.choice !== undefined ? `\n${L(lang, '分开处的抉择', 'What is decided where it parts')}: ${line.choice}` : ''}`)
        for (const chapter of whole ? path : own) parts.push(entry(chapter.index, chapter.plan))
        if (own.length === 0) parts.push(L(lang, '（这条线还没有自己的章节）', '(no chapters of its own yet)'))
      }
      if (scope === undefined) {
        mainLine()
        // The whole book: every line, each numbered along itself; only a line's own chapters are listed under it.
        for (const line of outline.lines ?? []) await otherLine(line.id, false)
        if ((outline.lines ?? []).length > 0) parts.push(L(lang, `（每条线各自编号；按章号读别的线上的章节时，用 ${tools.read} 的 line 参数，或直接用章节 id。）`, `(Each line counts its own chapters; to read a chapter of another line by number, give ${tools.read} its \`line\`, or use the chapter's id.)`))
      } else {
        if (scope.line === MAIN_LINE) mainLine()
        else await otherLine(scope.line, true)
        if (kept !== undefined && scope.others > 0) parts.push(L(lang, `（这本书还有 ${scope.others} 条别的剧情线。这件活在${scope.title !== undefined ? `「${scope.title}」` : '主线'}上：章号沿这条线数，别的线不在这件活的范围里。）`, `(The book has ${scope.others} other line(s) of the plot. This work is on ${lineName(scope)}: chapter numbers count along it, and the other lines are no part of it.)`))
      }
      return { text: parts.length > 0 ? parts.join('\n') : 'The outline is empty.', data: outline }
    }
    case 'character': {
      if (given === undefined) {
        // The cast at a glance: who there is to ask about.
        if (characters.length === 0) return { text: 'No characters on file yet.', data: [] }
        // Where each of them is in the book is their life along the line read, as the digests tell it — not a label.
        const told = (await project.lives(alongLine)).lives
        const life = (id: string): string => lifeLine(told[id], lang === 'zh') ?? L(lang, '正文里还没有出场', 'not on the page yet')
        return {
          text: characters.map(card => `- ${card.name} [${card.id}; ${roleLabel(card.role, lang)}; ${life(card.id)}]${card.tagline !== undefined ? ` — ${flat(card.tagline, 120)}` : ''}`).join('\n'),
          data: characters.map(card => ({ id: card.id, name: card.name, role: card.role, ...(told[card.id]?.first !== undefined ? { first: told[card.id]!.first, last: told[card.id]!.last } : {}), ...(told[card.id]?.death !== undefined ? { death: told[card.id]!.death } : {}), ...(told[card.id]?.exit !== undefined ? { exit: told[card.id]!.exit } : {}) })),
        }
      }
      const card = await project.findCharacter(given)
      if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${request.ref}" — ${tools.read} what=character without \`ref\` lists the cast`)
      // Along the line read: what happened to them on another line is not said here.
      const told = (await project.lives(alongLine)).lives[card.id]
      const life = lifeLine(told, lang === 'zh')
      const presence = alongLine === undefined ? (await project.presence()).find(entry => entry.character === card.id) : undefined
      const seen = presence !== undefined
        ? `; appears in ${presence.chapters.length} chapters${presence.chapters.length > 0 ? `, last ${presence.absentFor} chapters ago` : ''}`
        : alongLine !== undefined ? `; appears in ${told?.events.filter(event => event.index >= 1).length ?? 0} chapters of this line` : ''
      const where = alongLine !== undefined && scope?.title !== undefined ? L(lang, `履历（剧情线「${scope.title}」）`, `Life on the page (the line "${scope.title}")`) : L(lang, '履历（主线）', 'Life on the page (main line)')
      return {
        text: `${renderCharacter(card, lang, { resolveName: nameOf })}${life !== undefined ? `\n${where}${lang === 'zh' ? '：' : ': '}${life}` : ''}${card.life !== undefined && (scope === undefined || scope.has(card)) ? `\n${card.life}` : ''}\n\n[id ${card.id}${seen}${card.voiceProfile?.voice !== undefined ? `; voice ${card.voiceProfile.voice}` : ''}${card.visual?.portrait !== undefined ? '; has portrait' : ''}]`,
        data: card,
      }
    }
    case 'world': {
      if (given === undefined) {
        const world = (await project.world()).filter(entry => scope === undefined || scope.knows(entry))
        if (world.length === 0) return { text: 'No world entries on file yet.', data: [] }
        return {
          text: world.map(entry => `- ${entry.name} [${entry.id}; ${entry.category}]${entry.summary !== undefined ? ` — ${flat(entry.summary, 120)}` : ''}`).join('\n'),
          data: world.map(entry => ({ id: entry.id, name: entry.name, category: entry.category })),
        }
      }
      const entry = await project.findWorld(given)
      if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${request.ref}" — ${tools.read} what=world without \`ref\` lists them`)
      return { text: `${renderWorld(entry, lang)}\n\n[id ${entry.id}; ${entry.category}; importance ${entry.importance}]`, data: entry }
    }
    case 'style': {
      const style = given !== undefined ? await project.findStyle(given) : await project.activeStyle()
      if (style === undefined) throw new ProjectError('novel/not-found', `no style matches "${request.ref ?? ''}"`)
      const all = await project.styles()
      return { text: `${renderStyle(style, lang)}\n\n[id ${style.id}${style.id === manifest.activeStyle ? '; active' : ''}; all styles: ${all.map(item => item.id).join(', ')}]`, data: style }
    }
    case 'memory': {
      const chapter = await chapterOf()
      const memory = await project.memory(chapter.plan.id)
      if (memory === undefined) return { text: `Chapter ${chapter.index} has no memory yet${tools.digest !== undefined ? ` — run ${tools.digest}` : ''}.` }
      const lines = [
        `Chapter ${chapter.index} "${chapter.plan.title}" — ${memory.summary}`,
        memory.storyTime !== undefined ? `Story time: ${memory.storyTime}` : '',
        memory.characters.length > 0 ? `Characters:\n${memory.characters.map(moment => `- ${moment.name}: ${[moment.role, moment.stateAfter].filter(Boolean).join(' → ')}`).join('\n')}` : '',
        memory.facts.length > 0 ? `Facts:\n${memory.facts.map(fact => `- [${fact.kind}] ${fact.subject}: ${fact.statement}`).join('\n')}` : '',
        memory.threads.length > 0 ? `Threads:\n${memory.threads.map(touch => `- ${touch.action}: ${touch.title}${touch.note !== undefined ? ` — ${touch.note}` : ''}`).join('\n')}` : '',
        memory.openQuestions !== undefined && memory.openQuestions.length > 0 ? `Open questions: ${memory.openQuestions.join(' / ')}` : '',
      ]
      return { text: lines.filter(line => line.length > 0).join('\n\n'), data: memory }
    }
    case 'threads': {
      const outline = await project.outline()
      if (scope !== undefined) {
        // The line's own threads, as they stand at its end; the chapters named are its own.
        const label = (id: string): string => `#${scope.path.find(candidate => candidate.plan.id === id)?.index ?? '?'}`
        if (scope.threads.length === 0) return { text: `No plot threads on ${lineName(scope)} yet.`, data: [] }
        return {
          text: scope.threads.map(({ thread, open }) => {
            const here = { ...thread, ...(thread.planted !== undefined ? { planted: thread.planted.filter(id => scope.reads(id)) } : {}), ...(thread.advanced !== undefined ? { advanced: thread.advanced.filter(id => scope.reads(id)) } : {}) }
            return `${renderThread(here, lang, label)} [${thread.id}; ${thread.status === 'dropped' ? 'dropped' : open ? 'open' : 'paid'}${thread.auto === true ? '; unconfirmed' : ''}]`
          }).join('\n'),
          data: scope.threads.map(entry => entry.thread),
        }
      }
      const located = await project.chapters()
      const label = (id: string): string => {
        const chapter = located.find(candidate => candidate.plan.id === id)
        return chapter === undefined ? id : `#${chapter.index}`
      }
      if (outline.threads.length === 0) return { text: 'No plot threads recorded yet.' }
      return { text: outline.threads.map(thread => `${renderThread(thread, lang, label)} [${thread.id}; ${thread.status}${thread.auto === true ? '; unconfirmed' : ''}]`).join('\n'), data: outline.threads }
    }
    case 'review': {
      const chapter = await chapterOf()
      const review = await project.review(chapter.plan.id)
      if (review === undefined) return { text: `Chapter ${chapter.index} has not been reviewed${tools.review !== undefined ? ` — run ${tools.review}` : ''}.` }
      return {
        text: `${review.verdict}\n\n${review.issues.map(issue => `- [${issue.severity}/${issue.type}${issue.resolved === true ? '/resolved' : ''}] ${issue.quote !== undefined ? `"${clip(issue.quote, 60)}" — ` : ''}${issue.explanation}${issue.suggestion !== undefined ? ` → ${issue.suggestion}` : ''}`).join('\n')}`,
        data: review,
      }
    }
    case 'versions': {
      const chapter = await chapterOf()
      const versions = await project.versions(chapter.plan.id)
      if (versions.length === 0) return { text: `Chapter ${chapter.index} has no earlier versions.` }
      return { text: versions.map(version => `- ${version.id} — ${version.reason}, ${version.words} words`).join('\n'), data: versions }
    }
    default:
      throw new ProjectError('novel/invalid', `unknown \`what\`: ${String(request.what)} — one of ${READ_KINDS.join(', ')}`)
  }
}

export interface SearchRequest {
  query: string
  sources?: string[] | undefined
  limit?: number | undefined
  /** The line of the plot to search, by id or name, where the reader is kept to none. Left out: the whole book. */
  line?: string | undefined
}

/** @param kept - the line of the plot this reader is kept to: what is found is that line's — its chapters, its people — and the world. */
export async function searchBook(runtime: ProjectRuntime, request: SearchRequest, signal?: AbortSignal, kept?: ReadScope): Promise<Reading> {
  const sources = (request.sources ?? []).filter((source): source is SearchSource => (SEARCH_SOURCES as string[]).includes(source))
  const scope = await scopeOf(runtime.project, request.line, kept)
  let within: ((source: SearchSource, ref: string) => boolean) | undefined
  if (scope !== undefined) {
    const [cards, world] = await Promise.all([runtime.project.characters(), runtime.project.world()])
    const people = new Set(cards.filter(card => scope.has(card)).map(card => card.id))
    const known = new Set(world.filter(entry => scope.knows(entry)).map(entry => entry.id))
    within = (source, ref) => source === 'character' ? people.has(ref) : source === 'world' ? known.has(ref) : scope.reads(ref)
  }
  const hits = await runtime.index.search(request.query, {
    limit: Math.max(1, Math.min(30, request.limit ?? 8)),
    ...(sources.length > 0 ? { sources } : {}),
    ...(within !== undefined ? { within } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (hits.length === 0) return { text: `Nothing ${scope !== undefined ? `on ${lineName(scope)}` : 'in the project'} matches "${request.query}".`, data: [] }
  return {
    text: hits.map(hit => `〔${hit.source} · ${hit.title} · ${hit.ref}${hit.offset !== undefined ? ` @${hit.offset}` : ''} · ${hit.score}〕\n${clip(hit.text, 500)}`).join('\n\n'),
    data: hits,
  }
}

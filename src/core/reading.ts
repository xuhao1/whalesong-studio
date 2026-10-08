// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Reading a book the way a model reads it: one thing at a time, in full, as
 * text. The showrunner reads through `novel_read` and `novel_search`; every
 * role of the crew reads through tools of its own that end up here — one
 * account of the book for everyone who works on it.
 */
import type { ProjectRuntime } from './core'
import { ProjectError } from './project'
import { L, promptLanguage, renderCharacter, renderPlan, renderStyle, renderThread, renderWorld, roleLabel, statusLabel } from './render'
import { clip } from '../shared/text'
import type { SearchSource } from '../shared/types'

export const READ_KINDS = ['chapter', 'outline', 'character', 'world', 'style', 'memory', 'threads', 'review', 'versions'] as const
export type ReadKind = typeof READ_KINDS[number]

export const SEARCH_SOURCES: SearchSource[] = ['manuscript', 'character', 'world', 'memory', 'outline']

export interface ReadRequest {
  what: ReadKind
  ref?: string | undefined
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

/**
 * @param tools - what the reader should be pointed at where something is missing: the names differ between the showrunner and the crew.
 * @throws ProjectError `novel/not-found` or `novel/invalid`, in words the model can act on.
 */
export async function readBook(runtime: ProjectRuntime, request: ReadRequest, tools: { read: string; digest?: string; review?: string } = { read: 'novel_read', digest: 'novel_digest', review: 'novel_review' }): Promise<Reading> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const characters = await project.characters()
  const nameOf = (ref: string): string => characters.find(card => card.id === ref)?.name ?? ref
  const given = request.ref !== undefined && request.ref.trim().length > 0 ? request.ref.trim() : undefined
  const needRef = (): string => {
    if (given === undefined) throw new ProjectError('novel/invalid', `${tools.read} what=${request.what} needs \`ref\``)
    return given
  }
  const chapterOf = async () => {
    const chapter = await project.findChapter(needRef())
    if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${request.ref}" — ${tools.read} what=outline lists the chapters`)
    return chapter
  }
  switch (request.what) {
    case 'chapter': {
      const chapter = await chapterOf()
      const text = await project.chapterText(chapter.plan.id)
      if (text.length === 0) return { text: `Chapter ${chapter.index} "${chapter.plan.title}" (${chapter.plan.id}) has no text yet.` }
      const offset = Math.max(0, request.offset ?? 0)
      const limit = Math.max(200, Math.min(40_000, request.limit ?? 6000))
      const slice = text.slice(offset, offset + limit)
      const more = offset + limit < text.length
      return {
        text: `Chapter ${chapter.index} "${chapter.plan.title}" (${chapter.plan.id}), characters ${offset}–${offset + slice.length} of ${text.length}${more ? ` (continue with offset=${offset + slice.length})` : ''}:\n\n${slice}`,
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
      let index = 0
      for (const volume of outline.volumes) {
        parts.push(`## ${volume.title} (${volume.id})${volume.synopsis !== undefined ? `\n${volume.synopsis}` : ''}${volume.goal !== undefined ? `\n${L(lang, '目标', 'Goal')}: ${volume.goal}` : ''}`)
        for (const plan of volume.chapters) parts.push(`${++index}. ${plan.title} [${plan.id}; ${plan.status}]${plan.synopsis !== undefined ? `\n   ${flat(plan.synopsis, 300)}` : ''}`)
      }
      return { text: parts.length > 0 ? parts.join('\n') : 'The outline is empty.', data: outline }
    }
    case 'character': {
      if (given === undefined) {
        // The cast at a glance: who there is to ask about.
        if (characters.length === 0) return { text: 'No characters on file yet.', data: [] }
        return {
          text: characters.map(card => `- ${card.name} [${card.id}; ${roleLabel(card.role, lang)}; ${statusLabel(card.status, lang)}]${card.tagline !== undefined ? ` — ${flat(card.tagline, 120)}` : ''}`).join('\n'),
          data: characters.map(card => ({ id: card.id, name: card.name, role: card.role, status: card.status })),
        }
      }
      const card = await project.findCharacter(given)
      if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${request.ref}" — ${tools.read} what=character without \`ref\` lists the cast`)
      const presence = (await project.presence()).find(entry => entry.character === card.id)
      return {
        text: `${renderCharacter(card, lang, { resolveName: nameOf })}\n\n[id ${card.id}${presence !== undefined ? `; appears in ${presence.chapters.length} chapters${presence.chapters.length > 0 ? `, last ${presence.absentFor} chapters ago` : ''}` : ''}${card.voiceProfile?.voice !== undefined ? `; voice ${card.voiceProfile.voice}` : ''}${card.visual?.portrait !== undefined ? '; has portrait' : ''}]`,
        data: card,
      }
    }
    case 'world': {
      if (given === undefined) {
        const world = await project.world()
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
}

export async function searchBook(runtime: ProjectRuntime, request: SearchRequest, signal?: AbortSignal): Promise<Reading> {
  const sources = (request.sources ?? []).filter((source): source is SearchSource => (SEARCH_SOURCES as string[]).includes(source))
  const hits = await runtime.index.search(request.query, {
    limit: Math.max(1, Math.min(30, request.limit ?? 8)),
    ...(sources.length > 0 ? { sources } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (hits.length === 0) return { text: `Nothing in the project matches "${request.query}".`, data: [] }
  return {
    text: hits.map(hit => `〔${hit.source} · ${hit.title} · ${hit.ref}${hit.offset !== undefined ? ` @${hit.offset}` : ''} · ${hit.score}〕\n${clip(hit.text, 500)}`).join('\n\n'),
    data: hits,
  }
}

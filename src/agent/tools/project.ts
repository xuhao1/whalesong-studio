// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools for orienting in a project: status, creation, reading, search, mode, export. */
import { isAbsolute, join, resolve } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { exportBook, type ExportFormat } from '../../core/pipelines/export'
import { buildFoundation } from '../../core/pipelines/plot'
import { ProjectError } from '../../core/project'
import { READ_KINDS, readBook, searchBook, SEARCH_SOURCES } from '../../core/reading'
import { L, promptLanguage } from '../../core/render'
import type { NovelService } from '../../host/service'
import { WORK_MODES, type WorkMode } from '../../shared/types'
import { modeLabel, renderStatus } from '../status'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

export function projectTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_status',
      description: 'Show where the book in play stands: premise, outline with per-chapter status and length, cast with where each of them is in the book (chapters on the page; a death or a leaving with its chapter), open plot threads, pending proposals and suggestions, the recommended next step, and the other books in reach. Call it first in a session and whenever you need to re-orient. Pass `project` to move this session — and the Studio beside the conversation — onto another book.',
      book: false,
      parameters: {
        project: { type: 'string', description: 'A book to move this session onto: its title or its path. The Studio follows, and later calls act on it.' },
        detail: { type: 'string', enum: ['brief', 'full'], description: 'full lists every chapter and character; default brief.' },
      },
      async run(args, env) {
        if (args.project !== undefined && args.project.trim().length > 0) await env.switchTo(await env.service.resolveBook(args.project, env.workspace))
        // Status reports the book in play as it is now, and from here on the model knows it.
        const runtime = await env.service.projectOfAgent(env.agent)
        env.service.markShown(env.agent.id, runtime?.project.root)
        const books = await env.service.booksInReach(env.workspace)
        if (runtime === undefined) {
          if (books.length > 0) {
            return { text: `No book is in play in this session yet, and ${books.length === 1 ? 'one is' : `${books.length} are`} in reach. Call novel_status again with \`project\` set to one of:\n${books.map(ref => `- "${ref.title}" — ${ref.relative}`).join('\n')}\nOr create a new one with novel_init.`, data: toJson({ projects: books }) }
          }
          return { text: `No novel project in ${env.workspace} yet. Agree on a title and premise with the author, then create it with novel_init (pass \`idea\` to have the premise, cast, world and opening outline drafted for you). To bring in an existing manuscript, create the project and then call novel_import.`, data: toJson({ project: null }) }
        }
        const state = await env.service.sessions.get(env.agent.id)
        const { text, state: project } = await renderStatus(runtime, state.mode, env.where(runtime), env.core.jobs.list(runtime.project.root), args.detail ?? 'brief', (await env.core.autoFor(runtime)).autoDigest)
        const others = books.filter(ref => ref.root !== runtime.project.root)
        const shelf = others.length > 0
          ? `\n\n## Other books in reach\n${others.slice(0, 12).map(ref => `- "${ref.title}" — ${ref.relative}`).join('\n')}\nPass \`book\` to a tool to touch one of them once; pass \`project\` here to move the session onto it.`
          : ''
        return { text: `${text}${shelf}`, data: toJson({ root: runtime.project.root, mode: state.mode, stats: project.stats, chapters: project.chapters, others }) }
      },
    }),

    novelTool(service, {
      name: 'novel_init',
      description: 'Create a new novel project in the session workspace (in the workspace itself when it is empty, otherwise in a new subdirectory named after the title) and move this session onto it. Pass `idea` to also draft the foundation — premise, main cast, core world entries, volumes, opening chapter outlines and a style — which the author can then reshape.',
      mutating: true,
      book: false,
      parameters: {
        title: { type: 'string', required: true, description: 'Working title.' },
        language: { type: 'string', description: 'Manuscript language tag such as zh, en, ja. Default: zh.' },
        genre: { type: 'string' },
        logline: { type: 'string', description: 'One-sentence hook.' },
        premise: { type: 'string', description: 'The core idea, stakes and promise of the story.' },
        author: { type: 'string' },
        idea: { type: 'string', description: 'A free-form idea to develop into a starting bible and outline.' },
      },
      async run(args, env) {
        const root = await env.core.suggestRoot(env.workspace, args.title)
        const runtime = await env.core.create(root, {
          title: args.title,
          ...(args.language !== undefined ? { language: args.language } : {}),
          ...(args.genre !== undefined ? { genre: args.genre } : {}),
          ...(args.logline !== undefined ? { logline: args.logline } : {}),
          ...(args.premise !== undefined ? { premise: args.premise } : {}),
          ...(args.author !== undefined ? { author: args.author } : {}),
        })
        await env.switchTo(runtime)
        let foundation = ''
        if (args.idea !== undefined && args.idea.trim().length > 0) {
          const idea = args.idea
          const result = await env.job('derive', 'foundation', undefined, async task => await buildFoundation(env.core, runtime, { idea, keepTitle: true }, task))
          foundation = `\nFoundation drafted: ${result.characters} characters, ${result.worldEntries} world entries, ${result.volumes} volumes, ${result.chapters} opening chapters. Review it with the author (novel_status, novel_read) before writing.`
        }
        return { text: `Created the project "${(await runtime.project.manifest()).title}" at ${env.where(runtime)}.${foundation}`, data: toJson({ root }) }
      },
    }),

    novelTool(service, {
      name: 'novel_read',
      description: 'Read one thing from the project in full: a chapter\'s text (paged), a chapter\'s outline, a character card, a world entry, a style profile, a chapter\'s memory (summary, facts, character states), the open threads, a chapter\'s review, a chapter\'s version list, the author\'s jottings (what=jottings: loose notes — ideas, never canon — listed, or one whole by `ref`; one the author keeps from agents is not there), or the records of how the outline was derived (what=derivations: for every derivation of chapters or beats, every what-if and the book\'s foundation — what the author gave it to go by, each hand-in and what the planner said of it, which chapters came of it; listed, one whole by its id, or the ones a chapter came of with `ref`=that chapter. Read these before answering why a stretch was planned as it was, or what it was meant to be). `ref` accepts ids, names, and chapter numbers ("3", "第3章", "latest"). A book may hold several lines of the plot — stories of their own in one world, or ways one story parts: every line counts its own chapters. A chapter number counts along the main line unless `line` names another; the whole outline lists every line.',
      parameters: {
        what: { type: 'string', required: true, enum: READ_KINDS },
        ref: { type: 'string', description: 'Which one. Not needed for threads; optional for style (default: the active style), outline (default: the whole outline), and character and world (default: the list of them).' },
        offset: { type: 'integer', description: 'For chapter text: character offset to start from (default 0).' },
        limit: { type: 'integer', description: 'For chapter text: maximum characters to return (default 6000).' },
        line: { type: 'string', description: 'A line of the plot, by id or name ("main" for the main one): chapter numbers count along it, and the outline, the cast, the threads and a character\'s life are that line\'s alone. Leave out to count along the main line and to list the whole book.' },
      },
      async run(args, env) {
        const reading = await readBook(await env.project(), { what: args.what, ref: args.ref, offset: args.offset, limit: args.limit, line: args.line })
        return { text: reading.text, ...(reading.data !== undefined ? { data: toJson(reading.data) } : {}) }
      },
    }),

    novelTool(service, {
      name: 'novel_search',
      description: 'Search everything the project knows — manuscript passages, character cards, world entries, chapter memories and outlines, and the author\'s jottings (source `jotting`: ideas, not canon) — by keywords or by meaning. Use it to check canon before deciding plot or giving the writer a brief ("where did she get the scar", "every scene in the tavern").',
      parameters: {
        query: { type: 'string', required: true },
        sources: listParameter('Restrict to some sources. Default: all.', { enum: SEARCH_SOURCES }),
        limit: { type: 'integer', description: 'Maximum hits (default 8).' },
        line: { type: 'string', description: 'Search one line of the plot only, by id or name ("main" for the main one): its chapters, its people, and the world. Leave out to search the whole book — every line.' },
      },
      async run(args, env) {
        const found = await searchBook(await env.project(), { query: args.query, sources: listOf(args.sources), limit: args.limit, line: args.line }, env.signal)
        return { text: found.text, ...(found.data !== undefined ? { data: toJson(found.data) } : {}) }
      },
    }),

    novelTool(service, {
      name: 'novel_mode',
      description: `Switch this session's working mode when the author asks to change what you are doing together. Modes: ${WORK_MODES.join(', ')}. The mode changes what you focus on and what you may touch; the canon stays the same.`,
      book: false,
      parameters: {
        mode: { type: 'string', required: true, enum: WORK_MODES },
      },
      async run(args, env) {
        const state = await env.service.bind(env.agent.id, { mode: args.mode as WorkMode })
        return { text: `Mode is now "${state.mode}" (${modeLabel(state.mode, true)}).`, data: toJson(state) }
      },
    }),

    novelTool(service, {
      name: 'novel_export',
      description: 'Compile the manuscript into one file in the project\'s export/ folder: markdown, text, html (self-contained, illustrations embedded) or epub.',
      mutating: true,
      parameters: {
        format: { type: 'string', required: true, enum: ['markdown', 'text', 'html', 'epub'] },
        chapters: listParameter('Only these chapters. Default: every chapter with text.'),
      },
      async run(args, env) {
        const runtime = await env.project()
        const result = await exportBook(runtime, { format: args.format as ExportFormat, ...((listOf(args.chapters)?.length ?? 0) > 0 ? { chapters: listOf(args.chapters)! } : {}) })
        return { text: `Exported ${result.chapters} chapters to ${join(env.where(runtime), result.path)} (${Math.round(result.bytes / 1024)} KB).`, data: toJson(result) }
      },
    }),
  ]
}

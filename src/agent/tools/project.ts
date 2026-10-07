// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools for orienting in a project: status, creation, reading, search, mode, export. */
import { isAbsolute, join, resolve } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { exportBook, type ExportFormat } from '../../core/pipelines/export'
import { buildFoundation } from '../../core/pipelines/plot'
import { ProjectError } from '../../core/project'
import { L, promptLanguage, renderCharacter, renderPlan, renderStyle, renderThread, renderWorld } from '../../core/render'
import type { NovelService } from '../../host/service'
import { clip } from '../../shared/text'
import { WORK_MODES, type SearchSource, type WorkMode } from '../../shared/types'
import { modeLabel, renderStatus } from '../status'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

const SOURCES: SearchSource[] = ['manuscript', 'character', 'world', 'memory', 'outline']

export function projectTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_status',
      description: 'Show where the book in play stands: premise, outline with per-chapter status and length, cast with lifecycle, open plot threads, pending proposals and suggestions, the recommended next step, and the other books in reach. Call it first in a session and whenever you need to re-orient. Pass `project` to move this session — and the Studio beside the conversation — onto another book.',
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
        const { text, state: project } = await renderStatus(runtime, state.mode, env.where(runtime), env.core.jobs.list(runtime.project.root), args.detail ?? 'brief')
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
      description: 'Read one thing from the project in full: a chapter\'s text (paged), a chapter\'s outline, a character card, a world entry, a style profile, a chapter\'s memory (summary, facts, character states), the open threads, a chapter\'s review, or a chapter\'s version list. `ref` accepts ids, names, and chapter numbers ("3", "第3章", "latest").',
      parameters: {
        what: { type: 'string', required: true, enum: ['chapter', 'outline', 'character', 'world', 'style', 'memory', 'threads', 'review', 'versions'] },
        ref: { type: 'string', description: 'Which one. Not needed for threads; optional for style (default: the active style) and outline (default: the whole outline).' },
        offset: { type: 'integer', description: 'For chapter text: character offset to start from (default 0).' },
        limit: { type: 'integer', description: 'For chapter text: maximum characters to return (default 6000).' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        const manifest = await project.manifest()
        const lang = promptLanguage(manifest.language)
        const characters = await project.characters()
        const nameOf = (ref: string): string => characters.find(card => card.id === ref)?.name ?? ref
        const needRef = (): string => {
          if (args.ref === undefined || args.ref.trim().length === 0) throw new ProjectError('novel/invalid', `novel_read what=${args.what} needs \`ref\``)
          return args.ref
        }
        const chapterOf = async () => {
          const chapter = await project.findChapter(needRef())
          if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${args.ref}"`)
          return chapter
        }
        switch (args.what) {
          case 'chapter': {
            const chapter = await chapterOf()
            const text = await project.chapterText(chapter.plan.id)
            if (text.length === 0) return { text: `Chapter ${chapter.index} "${chapter.plan.title}" (${chapter.plan.id}) has no text yet.` }
            const offset = Math.max(0, args.offset ?? 0)
            const limit = Math.max(200, Math.min(40_000, args.limit ?? 6000))
            const slice = text.slice(offset, offset + limit)
            const more = offset + limit < text.length
            return {
              text: `Chapter ${chapter.index} "${chapter.plan.title}" (${chapter.plan.id}), characters ${offset}–${offset + slice.length} of ${text.length}${more ? ` (continue with offset=${offset + slice.length})` : ''}:\n\n${slice}`,
              data: toJson({ chapterId: chapter.plan.id, length: text.length, offset, more }),
            }
          }
          case 'outline': {
            if (args.ref !== undefined && args.ref.trim().length > 0) {
              const chapter = await chapterOf()
              return { text: `${renderPlan(chapter.plan, chapter.index, lang, nameOf)}\n\n[${chapter.plan.id}; status ${chapter.plan.status}; volume ${chapter.volume.title}]`, data: toJson(chapter.plan) }
            }
            const outline = await project.outline()
            const parts: string[] = []
            let index = 0
            for (const volume of outline.volumes) {
              parts.push(`## ${volume.title} (${volume.id})${volume.synopsis !== undefined ? `\n${volume.synopsis}` : ''}${volume.goal !== undefined ? `\n${L(lang, '目标', 'Goal')}: ${volume.goal}` : ''}`)
              for (const plan of volume.chapters) parts.push(`${++index}. ${plan.title} [${plan.id}; ${plan.status}]${plan.synopsis !== undefined ? `\n   ${brief(plan.synopsis, 300)}` : ''}`)
            }
            return { text: parts.join('\n'), data: toJson(outline) }
          }
          case 'character': {
            const card = await project.findCharacter(needRef())
            if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${args.ref}" — novel_status lists the cast`)
            const presence = (await project.presence()).find(entry => entry.character === card.id)
            return {
              text: `${renderCharacter(card, lang, { resolveName: nameOf })}\n\n[id ${card.id}${presence !== undefined ? `; appears in ${presence.chapters.length} chapters${presence.chapters.length > 0 ? `, last ${presence.absentFor} chapters ago` : ''}` : ''}${card.voiceProfile?.voice !== undefined ? `; voice ${card.voiceProfile.voice}` : ''}${card.visual?.portrait !== undefined ? '; has portrait' : ''}]`,
              data: toJson(card),
            }
          }
          case 'world': {
            const entry = await project.findWorld(needRef())
            if (entry === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${args.ref}"`)
            return { text: `${renderWorld(entry, lang)}\n\n[id ${entry.id}; ${entry.category}; importance ${entry.importance}]`, data: toJson(entry) }
          }
          case 'style': {
            const style = args.ref !== undefined && args.ref.trim().length > 0 ? await project.findStyle(args.ref) : await project.activeStyle()
            if (style === undefined) throw new ProjectError('novel/not-found', `no style matches "${args.ref ?? ''}"`)
            const all = await project.styles()
            return { text: `${renderStyle(style, lang)}\n\n[id ${style.id}${style.id === manifest.activeStyle ? '; active' : ''}; all styles: ${all.map(item => item.id).join(', ')}]`, data: toJson(style) }
          }
          case 'memory': {
            const chapter = await chapterOf()
            const memory = await project.memory(chapter.plan.id)
            if (memory === undefined) return { text: `Chapter ${chapter.index} has no memory yet — run novel_digest.` }
            const lines = [
              `Chapter ${chapter.index} "${chapter.plan.title}" — ${memory.summary}`,
              memory.storyTime !== undefined ? `Story time: ${memory.storyTime}` : '',
              memory.characters.length > 0 ? `Characters:\n${memory.characters.map(moment => `- ${moment.name}: ${[moment.role, moment.stateAfter].filter(Boolean).join(' → ')}`).join('\n')}` : '',
              memory.facts.length > 0 ? `Facts:\n${memory.facts.map(fact => `- [${fact.kind}] ${fact.subject}: ${fact.statement}`).join('\n')}` : '',
              memory.threads.length > 0 ? `Threads:\n${memory.threads.map(touch => `- ${touch.action}: ${touch.title}${touch.note !== undefined ? ` — ${touch.note}` : ''}`).join('\n')}` : '',
              memory.openQuestions !== undefined && memory.openQuestions.length > 0 ? `Open questions: ${memory.openQuestions.join(' / ')}` : '',
            ]
            return { text: lines.filter(line => line.length > 0).join('\n\n'), data: toJson(memory) }
          }
          case 'threads': {
            const outline = await project.outline()
            const located = await project.chapters()
            const label = (id: string): string => {
              const chapter = located.find(candidate => candidate.plan.id === id)
              return chapter === undefined ? id : `#${chapter.index}`
            }
            if (outline.threads.length === 0) return { text: 'No plot threads recorded yet.' }
            return { text: outline.threads.map(thread => `${renderThread(thread, lang, label)} [${thread.id}; ${thread.status}${thread.auto === true ? '; unconfirmed' : ''}]`).join('\n'), data: toJson(outline.threads) }
          }
          case 'review': {
            const chapter = await chapterOf()
            const review = await project.review(chapter.plan.id)
            if (review === undefined) return { text: `Chapter ${chapter.index} has not been reviewed — run novel_review.` }
            return {
              text: `${review.verdict}\n\n${review.issues.map(issue => `- [${issue.severity}/${issue.type}${issue.resolved === true ? '/resolved' : ''}] ${issue.quote !== undefined ? `"${clip(issue.quote, 60)}" — ` : ''}${issue.explanation}${issue.suggestion !== undefined ? ` → ${issue.suggestion}` : ''}`).join('\n')}`,
              data: toJson(review),
            }
          }
          case 'versions': {
            const chapter = await chapterOf()
            const versions = await project.versions(chapter.plan.id)
            if (versions.length === 0) return { text: `Chapter ${chapter.index} has no earlier versions.` }
            return { text: versions.map(version => `- ${version.id} — ${version.reason}, ${version.words} words`).join('\n'), data: toJson(versions) }
          }
          default:
            throw new ProjectError('novel/invalid', `unknown \`what\`: ${String(args.what)}`)
        }
      },
    }),

    novelTool(service, {
      name: 'novel_search',
      description: 'Search everything the project knows — manuscript passages, character cards, world entries, chapter memories and outlines — by keywords or by meaning. Use it to check canon before deciding plot or giving the writer a brief ("where did she get the scar", "every scene in the tavern").',
      parameters: {
        query: { type: 'string', required: true },
        sources: listParameter('Restrict to some sources. Default: all.', { enum: SOURCES }),
        limit: { type: 'integer', description: 'Maximum hits (default 8).' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const hits = await runtime.index.search(args.query, {
          limit: Math.max(1, Math.min(30, args.limit ?? 8)),
          ...((listOf(args.sources)?.length ?? 0) > 0 ? { sources: listOf(args.sources)!.filter((source): source is SearchSource => (SOURCES as string[]).includes(source)) } : {}),
          signal: env.signal,
        })
        if (hits.length === 0) return { text: `Nothing in the project matches "${args.query}".`, data: [] }
        return {
          text: hits.map(hit => `〔${hit.source} · ${hit.title} · ${hit.ref}${hit.offset !== undefined ? ` @${hit.offset}` : ''} · ${hit.score}〕\n${clip(hit.text, 500)}`).join('\n\n'),
          data: toJson(hits),
        }
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

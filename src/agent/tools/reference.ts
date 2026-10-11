// SPDX-License-Identifier: LGPL-3.0-or-later
/** The showrunner's way with the books a book goes by: its list of references, reading in them, notes for a chapter. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { consultReferences } from '../../core/pipelines/consult'
import { ProjectError } from '../../core/project'
import { addBookReference, aspectsOf, referenceShelf, referenceTools, referenceWord, removeReference, setReferenceUse, updateReference } from '../../core/references'
import type { NovelService } from '../../host/service'
import type { ReferenceInfo } from '../../shared/types'
import { brief, novelTool, toJson } from './shared'

/** One reference, as the showrunner reads it in a list. */
function line(reference: ReferenceInfo): string {
  const what = reference.kind === 'book'
    ? `a book of the shelf${reference.has !== undefined ? ` — ${reference.has.chapters} chapters, ${reference.has.characters} character cards, ${reference.has.world} world entries` : ''}`
    : `a manuscript kept as plain text — ${reference.chars ?? 0} characters in ${reference.parts ?? 1} part(s)`
  const open = reference.kind === 'text' ? 'its text' : reference.scope === undefined ? 'all of it (world, characters, style, plot, text)' : reference.scope.join(', ')
  return `- "${reference.name}" [${reference.id}] — ${what}${reference.state !== 'ready' ? ` — ${reference.state.toUpperCase()}: it cannot be read now` : ''}${reference.off === true ? ' — set aside: not consulted' : ''}\n  open: ${open}\n  how the author wants it used: ${reference.note ?? '(nothing said)'}`
}

export function referenceTools_(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_reference',
      description: [
        'The books this book goes by — its references: other books whose world, settings, style, plot or wording the author has it draw on. Two kinds: a book that stands on the shelf (consulted as it is organised there: its bible, outline and digests, style, text) and a manuscript the author took in for this book alone (plain text: read and searched, no cards). Nothing of a reference is put into any task whole: the crew reads in them with tools of its own, as far as the author opened each, and the writer is handed the notes the planner took for the chapter it writes (kept on that chapter\'s plan as referenceNotes).',
        '- action=list (default): the references, what the author asks of them at large, what of each is open, how the author wants each used, and which kinds of work look in them first.',
        '- action=read: read in one. `book` = its id or title; `what` = outline | chapter | memory | threads | character | world | style for a shelf book (with `ref`, as novel_read takes it), contents | part for a manuscript (`ref` = a part\'s number); `offset` / `limit` page through text. What the author did not open is refused.',
        '- action=search: find by keywords (in a shelf book by meaning as well): `query`, and `book` to keep to one.',
        '- action=add: take a book of the shelf as a reference — `book` = its title or path, `note` = how to go by it in the author\'s words, `scope` = what of it is open (world, characters, style, plot, text; left out: all). Only on the author\'s word: which books a book goes by is theirs to say. A manuscript is taken in by the author on the Bible → References page (a file is theirs to choose).',
        '- action=update: `book` and any of `note` (how to go by it — write down what the author said, in their words), `scope` (or all=true to open all of it), `off` (true: set aside, kept on the list; false: consulted again).',
        '- action=remove: take one off the list (a manuscript taken in for this book is deleted with it; a book of the shelf is not touched).',
        '- action=consult: have the planner read the references for one chapter (`chapter`) and keep its notes on that chapter\'s plan — what the writer is handed when it writes it. `direction` says what to look for. One planner run, as an agent. Chapters are consulted by themselves before they are written unless the author turned that off (action=settings before_writing=false).',
        '- action=settings: how the references are used at large. `guide` = what the author asks of them all, in their words — which book for the world, which for the way of writing, whether people or events may be borrowed: it is said to everybody who works with the references at hand (the planner, the reviewer, the director, and the planner\'s notes for the writer), above what is said of each (empty string: none). `before_writing`, `before_deriving`, `before_reviewing` (true|false): the kinds of work that look in the references first — the planner takes notes before a chapter is written; a derivation (chapters, beats, what-if) and a review are held to read in them before they hand anything in, and their results say what was read. All three are on unless the author turned one off.',
        'When the author says how a book should be used ("only its style", "the same world, other people"), put it on that reference with action=update; when they say how the references are to be used altogether ("the world from A, the style from B, nobody\'s characters"), put it in the guide with action=settings — either holds for every later piece of work — rather than repeating it in each task.',
      ].join('\n'),
      mutating: args => ['add', 'update', 'remove', 'consult', 'settings'].includes(String(args.action)),
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'search', 'add', 'update', 'remove', 'consult', 'settings'], description: 'Default: list.' },
        book: { type: 'string', description: 'A reference: its id or title. For action=add: the title or path of a book of the shelf.' },
        what: { type: 'string', description: 'read: outline | chapter | memory | threads | character | world | style | contents | part.' },
        ref: { type: 'string', description: 'read: which chapter, character, entry or style — or a part\'s number.' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
        query: { type: 'string', description: 'search: what to find.' },
        note: { type: 'string', description: 'add, update: how the author wants the reference used, in their words.' },
        scope: { type: 'array', items: { type: 'string', enum: ['world', 'characters', 'style', 'plot', 'text'] }, description: 'add, update: what of a shelf book is open.' },
        all: { type: 'boolean', description: 'update: open all of it again.' },
        off: { type: 'boolean', description: 'update: true sets it aside, false has it consulted again.' },
        chapter: { type: 'string', description: 'consult: the chapter (number, title or id).' },
        direction: { type: 'string', description: 'consult: what to look for, where the author said.' },
        before_writing: { type: 'boolean', description: 'settings: whether the planner reads the references before a chapter is written.' },
        before_deriving: { type: 'boolean', description: 'settings: whether the planner is held to read in the references before it derives chapters, beats or a what-if.' },
        before_reviewing: { type: 'boolean', description: 'settings: whether the reviewer is held to read in the references before it reviews a chapter.' },
        guide: { type: 'string', description: 'settings: what the author asks of the references at large, in their words. An empty string takes it off.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const action = args.action ?? 'list'
        const listed = async (lead: string): Promise<{ text: string; data: ReturnType<typeof toJson> }> => {
          const shelf = await referenceShelf(env.core, runtime)
          return {
            text: `${lead}${shelf.references.length > 0 ? `\n${shelf.guide !== undefined ? `What the author asks of them at large: ${shelf.guide}\n` : 'The author has said nothing of them at large (action=settings guide=…).\n'}${shelf.references.map(line).join('\n')}\nBefore a chapter is written the planner ${shelf.beforeWriting ? 'reads the references for it and leaves notes on its plan' : 'does NOT read the references (the author turned that off): notes are taken with action=consult, or written by the author'}. A derivation ${shelf.beforeDeriving ? 'looks in them first' : 'is not held to look in them (turned off)'}; a review ${shelf.beforeReviewing ? 'looks in them first and holds the chapter against them' : 'is not held to look in them (turned off)'}.` : '\nThis book has no references. The author adds them on the Bible → References page, or names a book of the shelf for you to add (action=add).'}`,
            data: toJson(shelf),
          }
        }
        if (action === 'list') return { ...(await listed('The references of this book:')), record: false }
        if (action === 'read' || action === 'search') {
          const tools = await referenceTools(env.core, runtime, env.signal, { read: 'novel_reference action=read', search: 'novel_reference action=search' })
          if (tools.length === 0) return { text: 'This book has no reference that is consulted now (action=list shows what there is).', record: false }
          const tool = tools[action === 'read' ? 0 : 1]!
          try {
            return { text: await tool.run({ ...(args.book !== undefined ? { book: args.book } : {}), ...(args.what !== undefined ? { what: args.what } : {}), ...(args.ref !== undefined ? { ref: args.ref } : {}), ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(args.query !== undefined ? { query: args.query } : {}) }), record: false }
          } catch (error) {
            throw new ProjectError('novel/invalid', error instanceof Error ? error.message : String(error))
          }
        }
        if (action === 'add') {
          if (args.book === undefined || args.book.trim().length === 0) throw new ProjectError('novel/invalid', 'action=add takes a book of the shelf: `book` = its title or path (novel_status lists the books in reach)')
          const other = await env.service.resolveBook(args.book, env.workspace)
          const scope = aspectsOf(args.scope)
          const added = await addBookReference(env.core, runtime, { root: other.project.root, ...(args.note !== undefined ? { note: args.note } : {}), ...(scope !== undefined ? { scope } : {}) })
          return { ...(await listed(`Added as a reference: ${referenceWord({ ...added, title: (await other.project.manifest()).title })}.`)), record: { summary: [`把一本书加进了参考文献`, 'Added a book to the references'] } }
        }
        const which = async (): Promise<ReferenceInfo> => {
          const shelf = await referenceShelf(env.core, runtime)
          const wanted = (args.book ?? '').trim().replace(/^[《「『“"]+|[》」』”"]+$/gu, '')
          const found = shelf.references.find(item => item.id === wanted) ?? shelf.references.find(item => item.name === wanted) ?? (wanted.length > 0 ? shelf.references.find(item => item.name.includes(wanted)) : shelf.references.length === 1 ? shelf.references[0] : undefined)
          if (found === undefined) throw new ProjectError('novel/not-found', `this book has no reference "${args.book ?? ''}" — action=list shows them`)
          return found
        }
        if (action === 'update') {
          const reference = await which()
          const scope = args.all === true ? null : aspectsOf(args.scope)
          await updateReference(runtime, reference.id, { ...(args.note !== undefined ? { note: args.note } : {}), ...(scope !== undefined ? { scope } : {}), ...(typeof args.off === 'boolean' ? { off: args.off } : {}) })
          return { ...(await listed(`Changed what is said of "${reference.name}".`)), record: { summary: [`改了《${reference.name}》怎么参考`, `Changed how "${reference.name}" is used`] } }
        }
        if (action === 'remove') {
          const reference = await which()
          await removeReference(runtime, reference.id)
          return { ...(await listed(`"${reference.name}" is off the references${reference.kind === 'text' ? ', and the manuscript taken in for it is deleted' : ' (the book on the shelf is as it was)'}.`)), record: { summary: [`把《${reference.name}》从参考文献里去掉了`, `Took "${reference.name}" off the references`] } }
        }
        if (action === 'settings') {
          const first = { ...(typeof args.before_writing === 'boolean' ? { write: args.before_writing } : {}), ...(typeof args.before_deriving === 'boolean' ? { derive: args.before_deriving } : {}), ...(typeof args.before_reviewing === 'boolean' ? { review: args.before_reviewing } : {}) }
          if (Object.keys(first).length === 0 && args.guide === undefined) throw new ProjectError('novel/invalid', 'action=settings takes `guide` (what the author asks of the references at large) and/or before_writing, before_deriving, before_reviewing = true|false')
          await setReferenceUse(runtime, { first, ...(args.guide !== undefined ? { guide: args.guide } : {}) })
          return { ...(await listed('How the references are used now:')), record: { summary: [args.guide !== undefined ? '改了对参考文献的总要求' : '改了哪些活先查参考文献', args.guide !== undefined ? 'Changed what is asked of the references at large' : 'Changed which work looks in the references first'] } }
        }
        if (action === 'consult') {
          if (args.chapter === undefined || args.chapter.trim().length === 0) throw new ProjectError('novel/invalid', 'action=consult takes `chapter`')
          const result = await env.job('derive', 'read the references for a chapter', args.chapter, async task => await consultReferences(env.core, runtime, { chapter: args.chapter!, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return {
            text: result.notes.length > 0
              ? `The planner read the references for chapter ${result.index} "${result.title}" and left these notes on its plan (referenceNotes) — the writer is handed them when it writes the chapter:\n${brief(result.notes, 1600)}${result.used.length > 0 ? `\nRead: ${result.used.join('; ')}` : ''}${result.why !== undefined ? `\nIts account: ${result.why}` : ''}\nTell the author what was taken from which book; the notes are theirs to change on the chapter's plan.`
              : `The planner read the references for chapter ${result.index} "${result.title}" and found nothing of use to it${result.why !== undefined ? `: ${result.why}` : ''}. The chapter's notes are empty, so it is written without any. Tell the author.`,
            data: toJson(result),
            record: { summary: [`策划为第 ${result.index} 章查了参考文献`, `The planner read the references for chapter ${result.index}`], chapter: result.chapterId },
          }
        }
        throw new ProjectError('novel/invalid', `unknown action "${String(action)}"`)
      },
    }),
  ]
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools that produce and change prose: write, revise, digest, review, import. */
import { readFile } from 'node:fs/promises'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { digestPending } from '../../core/pipelines/digest'
import { correctMemory, editChapter, type EditAction, type MemoryPatch } from '../../core/pipelines/edit'
import { importManuscript, readBookFile } from '../../core/pipelines/import'
import { reviewChapter } from '../../core/pipelines/review'
import { acceptProposal, rejectProposal, reviseBook, reviseChapter, reviseSpan } from '../../core/pipelines/revise'
import { writeChapter } from '../../core/pipelines/write'
import { ProjectError } from '../../core/project'
import { containedPath } from '../../core/util/fs'
import type { NovelService } from '../../host/service'
import { clip } from '../../shared/text'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

export function manuscriptTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_write',
      description: [
        'Have the writer model draft prose for one chapter and save it. You do not write the prose yourself: you decide what the chapter must do and say so in `brief`; the writer receives the bible, the relevant characters with their current state, the story so far, retrieved earlier passages, the open threads, this chapter\'s outline and the active style.',
        '- `chapter`: id, number or title; omit (or "next") for the first outlined chapter without text.',
        '- `mode`: draft (default) writes the chapter from the top, replacing existing text after a snapshot; continue appends to what is there.',
        '- `brief`: what this pass must achieve that the outline does not already say — emphasis, tone, what to hold back, how to end. Keep it short; do not restate the outline.',
        'The result gives length, the opening and closing lines and the cast used; read the chapter (novel_read) only when you need to check something specific. Make sure the chapter has beats first (novel_derive kind=beats).',
      ].join('\n'),
      mutating: true,
      parameters: {
        chapter: { type: 'string', description: 'Chapter id, number or title. Default: next unwritten chapter.' },
        brief: { type: 'string', description: 'Direction for this pass.' },
        mode: { type: 'string', enum: ['draft', 'continue'] },
        words: { type: 'integer', description: 'Target length of this pass. Default: the chapter\'s or the project\'s chapter length.' },
        style: { type: 'string', description: 'Style profile to use instead of the active one.' },
        characters: listParameter('Characters to keep in view besides those the outline names.'),
      },
      async run(args, env) {
        const runtime = await env.project()
        const result = await env.job('write', 'write', args.chapter, async task => await writeChapter(env.core, runtime, {
          ...(args.chapter !== undefined ? { chapter: args.chapter } : {}),
          ...(args.brief !== undefined ? { brief: args.brief } : {}),
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.words !== undefined ? { words: args.words } : {}),
          ...(args.style !== undefined ? { style: args.style } : {}),
          ...(listOf(args.characters) !== undefined ? { characters: listOf(args.characters)! } : {}),
        }, task))
        const lines = [
          `${result.mode === 'continue' ? 'Continued' : 'Drafted'} chapter ${result.index} "${result.title}" (${result.chapterId}): ${result.wordsWritten} words written, ${result.wordsTotal} in the chapter now.`,
          `Writer: ${result.model}; context: ${result.strategy}, ~${result.contextTokens} tokens; cast in view: ${result.cast.join(', ') || 'none'}.${result.continued ? ' The model hit its output limit and the chapter was completed by continuation.' : ''}`,
          result.digested ? 'Memory digested: summary, facts and character states are up to date.' : 'Not digested yet — run novel_digest before writing later chapters.',
          `Opens: ${result.preview.head}${result.preview.tail.length > 0 ? `\n…\nCloses: ${result.preview.tail}` : ''}`,
        ]
        const { preview: _preview, ...data } = result
        return { text: lines.join('\n'), data: toJson(data) }
      },
    }),

    novelTool(service, {
      name: 'novel_revise',
      description: [
        'Have the writer model revise existing prose.',
        '- scope=passage: rewrite one passage in place. Quote it exactly in `quote` (copy it from novel_read) and say what to change in `instruction`.',
        '- scope=chapter: rewrite one whole chapter to `instruction`.',
        '- scope=book: apply one instruction across the book ("rename the city to …", "make her colder until chapter 8"). Triage decides which chapters it touches (or pass `chapters`); each becomes a proposal for the author to review unless apply=true.',
        '- scope=accept / scope=reject: settle a pending proposal by `proposal` id.',
        'Every applied change snapshots the previous text first. Passage and chapter revisions apply directly unless the author turned on review of agent revisions; pass apply=false to always leave a proposal.',
      ].join('\n'),
      mutating: args => args.scope !== 'reject',
      parameters: {
        scope: { type: 'string', required: true, enum: ['passage', 'chapter', 'book', 'accept', 'reject'] },
        chapter: { type: 'string', description: 'passage/chapter: which chapter.' },
        quote: { type: 'string', description: 'passage: the exact text to rewrite.' },
        instruction: { type: 'string', description: 'What to change and why.' },
        chapters: listParameter('book: restrict to these chapters.'),
        proposal: { type: 'string', description: 'accept/reject: the proposal id.' },
        apply: { type: 'boolean', description: 'Apply immediately (true) or leave a proposal (false).' },
      },
      async run(args, env) {
        const runtime = await env.project()
        if (args.scope === 'accept' || args.scope === 'reject') {
          if (args.proposal === undefined) throw new ProjectError('novel/invalid', 'pass the proposal id in `proposal`')
          if (args.scope === 'accept') {
            const proposal = await acceptProposal(env.core, runtime, args.proposal, env.task)
            return { text: `Applied proposal ${proposal.id} to ${proposal.chapterId}.` }
          }
          const rejected = await rejectProposal(runtime, args.proposal)
          return { text: rejected !== undefined ? `Rejected proposal ${args.proposal}.` : `No proposal "${args.proposal}".` }
        }
        if (args.instruction === undefined || args.instruction.trim().length === 0) throw new ProjectError('novel/invalid', '`instruction` is required')
        const instruction = args.instruction
        if (args.scope === 'book') {
          const result = await env.job('revise', 'revise book', undefined, async task => await reviseBook(env.core, runtime, {
            instruction,
            ...((listOf(args.chapters)?.length ?? 0) > 0 ? { chapters: listOf(args.chapters)! } : {}),
            ...(args.apply !== undefined ? { apply: args.apply } : {}),
          }, task))
          const lines = result.results.map(item => `- chapter ${item.index} "${item.title}": ${item.wordsBefore} → ${item.wordsAfter} words${item.applied ? ', applied' : `, proposal ${item.proposalId ?? ''}`} — ${brief(item.reason, 120)}`)
          return {
            text: `${result.results.length} chapters rewritten, ${result.untouched} judged untouched${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}.${result.note !== undefined ? `\n${result.note}` : ''}\n${lines.join('\n')}${result.failed.map(item => `\n✗ ${item.chapterId}: ${item.error}`).join('')}${result.results.some(item => !item.applied) ? '\nThe proposals wait for the author in Novel Studio → Review (or settle them with scope=accept/reject).' : ''}`,
            data: toJson(result),
          }
        }
        if (args.chapter === undefined) throw new ProjectError('novel/invalid', `scope=${args.scope} needs \`chapter\``)
        const chapter = args.chapter
        if (args.scope === 'passage') {
          if (args.quote === undefined || args.quote.trim().length === 0) throw new ProjectError('novel/invalid', 'scope=passage needs the exact passage in `quote`')
          const quote = args.quote
          const result = await env.job('revise', 'revise passage', chapter, async task => await reviseSpan(env.core, runtime, { chapter, quote, instruction, ...(args.apply !== undefined ? { apply: args.apply } : {}) }, task))
          return {
            text: `${result.applied ? 'Revised' : `Proposed (${result.proposalId})`} a passage in chapter ${result.index} "${result.title}": ${result.wordsBefore} → ${result.wordsAfter} words.\n\nNow reads:\n${clip(result.after, 1200)}`,
            data: toJson({ ...result, before: undefined }),
          }
        }
        const result = await env.job('revise', 'revise chapter', chapter, async task => await reviseChapter(env.core, runtime, { chapter, instruction, ...(args.apply !== undefined ? { apply: args.apply } : {}) }, task))
        return {
          text: `${result.applied ? 'Rewrote' : `Proposed (${result.proposalId}) a rewrite of`} chapter ${result.index} "${result.title}": ${result.wordsBefore} → ${result.wordsAfter} words.\nOpens: ${result.after.slice(0, 200)}`,
          data: toJson({ ...result, before: undefined, after: undefined }),
        }
      },
    }),

    novelTool(service, {
      name: 'novel_edit',
      description: [
        'Change the text of a chapter yourself, exactly — no writer model involved. For what is not writing: words the author dictated or pasted, a name, a slip of fact, a typo, a sentence the author wants gone, a paragraph of their own to put in. Prose that has to be *written* still goes to the writer (novel_write, novel_revise) — unless the author asks you, in so many words, to write it yourself.',
        '- action=replace: put `text` in place of `find`. Copy `find` exactly from the chapter (novel_read); it must occur once, or pass all=true to change every occurrence (a name, a term).',
        '- action=insert: put `text` before or after the passage `find` (`where`, default after).',
        '- action=append: add `text` to the end of the chapter.',
        '- action=delete: remove the passage `find` (all=true for every occurrence).',
        '- action=set: make `text` the whole chapter — the author\'s own draft going in, or a chapter of theirs replacing what is there.',
        'Every change keeps the text as it was as a version the author can restore, is put on the book\'s record, and has the chapter\'s memory digested again, so later chapters are written from what the page now says. The result names the characters the changed text mentions and how many later chapters already exist: check that the change agrees with their cards and with what follows (novel_search, novel_review), and say so to the author. When the author has agent changes wait for review, the change is left as a proposal instead.',
      ].join('\n'),
      mutating: true,
      parameters: {
        action: { type: 'string', required: true, enum: ['replace', 'insert', 'append', 'delete', 'set'] },
        chapter: { type: 'string', required: true, description: 'Chapter id, number or title.' },
        find: { type: 'string', description: 'replace/delete: the exact passage. insert: the passage the text goes next to.' },
        text: { type: 'string', description: 'The new text.' },
        where: { type: 'string', enum: ['before', 'after'], description: 'insert: which side of `find`.' },
        all: { type: 'boolean', description: 'replace/delete: every occurrence.' },
        reason: { type: 'string', description: 'Why, in a few words — kept with the version and on the record.' },
        apply: { type: 'boolean', description: 'false leaves a proposal for the author instead of changing the text.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const result = await editChapter(env.core, runtime, {
          chapter: args.chapter,
          action: args.action as EditAction,
          ...(args.find !== undefined ? { find: args.find } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.where !== undefined ? { where: args.where } : {}),
          ...(args.all !== undefined ? { all: args.all } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.apply !== undefined ? { apply: args.apply } : {}),
        }, env.task)
        const where = `chapter ${result.index} "${result.title}"`
        const what = result.action === 'set' ? 'set the whole text of' : result.action === 'append' ? 'appended to' : result.action === 'insert' ? 'inserted into' : result.action === 'delete' ? `removed ${result.changes > 1 ? `${result.changes} passages` : 'a passage'} from` : `changed ${result.changes > 1 ? `${result.changes} places` : 'a passage'} in`
        if (!result.applied) {
          return {
            text: `Proposed (${result.proposalId}): ${what} ${where}, ${result.wordsBefore} → ${result.wordsAfter} words. The author has agent changes wait for review: it is in Novel Studio → Review, or settle it with novel_revise scope=accept/reject.`,
            data: toJson(result),
            record: { summary: [`对第 ${result.index} 章《${result.title}》提了一处直接改动（等你确认）${args.reason !== undefined ? `——${brief(args.reason, 80)}` : ''}`, `Proposed a direct change to ${where}${args.reason !== undefined ? ` — ${brief(args.reason, 80)}` : ''}`], chapter: result.chapterId },
          }
        }
        const lines = [
          `Done: ${what} ${where}, ${result.wordsBefore} → ${result.wordsAfter} words.${result.version !== undefined ? ` The text as it was is version ${result.version} (novel_manage action=restore_version undoes this).` : ''}`,
          result.action !== 'set' && result.before.length > 0 ? `Was: ${result.before}` : undefined,
          result.after.length > 0 ? `Now: ${result.after}` : undefined,
          result.memory === 'digesting' ? 'Memory: the chapter is being digested again; summary, facts and character states will follow the new text.' : 'Memory: auto-digest is off, so the chapter\'s memory is stale — run novel_digest before anything is written after it.',
          result.characters.length > 0 ? `Mentions ${result.characters.join(', ')}: make sure the change agrees with their cards (novel_read what=character).` : undefined,
          result.laterChapters > 0 ? `${result.laterChapters} later chapter(s) are already written and may rest on what changed — check them (novel_search, novel_review) and tell the author what you found.` : undefined,
        ].filter((line): line is string => line !== undefined)
        return {
          text: lines.join('\n'),
          data: toJson(result),
          record: {
            summary: [
              `亲手${result.action === 'set' ? '换了整章正文' : result.action === 'append' ? '在章末加了一段' : result.action === 'insert' ? '插入了一段' : result.action === 'delete' ? `删了${result.changes > 1 ? ` ${result.changes} 处` : '一处'}` : `改了${result.changes > 1 ? ` ${result.changes} 处` : '一处'}`}：第 ${result.index} 章《${result.title}》（${result.wordsBefore} → ${result.wordsAfter} 字）${args.reason !== undefined ? `——${brief(args.reason, 80)}` : ''}`,
              `${what.charAt(0).toUpperCase()}${what.slice(1)} ${where} by hand (${result.wordsBefore} → ${result.wordsAfter} words)${args.reason !== undefined ? ` — ${brief(args.reason, 80)}` : ''}`,
            ],
            chapter: result.chapterId,
            ...(result.version !== undefined ? { version: result.version } : {}),
          },
        }
      },
    }),

    novelTool(service, {
      name: 'novel_memory',
      description: [
        'Put right what the book remembers of a chapter. Memory is what every later chapter is written from — the summary, the hard facts, where each character stands at chapter end; the digest reads like a careful reader and is sometimes wrong, or the author tells you what really happened. Correct it here rather than digesting again, which would only repeat the reading.',
        '`fields` (only what changes): brief, summary, storyTime, locations [..], addFacts [{subject, statement, kind: state|relationship|knowledge|item|world|event}], removeFacts [text a wrong fact contains], characters [{name, stateAfter, location, emotion, learned [..], role}], openQuestions [..].',
        'Read the memory first (novel_read what=memory). A correction holds until the chapter\'s text changes and it is digested again — if the text itself is wrong, change the text (novel_edit, novel_revise) instead.',
      ].join('\n'),
      mutating: true,
      parameters: {
        chapter: { type: 'string', required: true, description: 'Chapter id, number or title.' },
        fields: { type: 'object', required: true, additionalProperties: true, description: 'What to correct.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { memory, changed } = await correctMemory(runtime, args.chapter, args.fields as MemoryPatch)
        const located = await runtime.project.findChapter(memory.chapterId)
        return {
          text: `Corrected the memory of chapter ${located?.index ?? '?'} "${located?.plan.title ?? memory.chapterId}": ${changed.join(', ')}. It now holds ${memory.facts.length} facts and the state of ${memory.characters.length} characters; later chapters are written from this.`,
          data: toJson({ chapterId: memory.chapterId, changed }),
          record: { summary: [`修正了第 ${located?.index ?? '?'} 章的记忆：${changed.join('、')}`, `Corrected the memory of chapter ${located?.index ?? '?'}: ${changed.join(', ')}`], chapter: memory.chapterId },
        }
      },
    }),

    novelTool(service, {
      name: 'novel_digest',
      description: 'Bring the project\'s memory up to date: for every chapter whose text changed since it was last digested, extract the summary, hard facts, each character\'s state at chapter end, new names worth a bible entry and thread movements. Keeps the cast lifecycle (first/last appearance) and the story-so-far current. Runs automatically after novel_write when auto-digest is on; call it after manual edits or imports, or with force=true to redo chapters.',
      parameters: {
        chapters: listParameter('Only these chapters. Default: all stale ones.'),
        force: { type: 'boolean', description: 'Redo even when the text has not changed.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const chapters = listOf(args.chapters) ?? []
        const result = await env.job('digest', 'digest', chapters[0], async task => await digestPending(env.core, runtime, task, {
          ...(chapters.length > 0 ? { chapters } : {}),
          ...(args.force !== undefined ? { force: args.force } : {}),
        }))
        const state = await runtime.project.state()
        return {
          text: `Digested ${result.digested.length} chapters${result.digested.length > 0 ? ` (${result.digested.join(', ')})` : ''}${result.failed.length > 0 ? `; ${result.failed.length} failed: ${result.failed.map(item => `${item.chapter} — ${item.error}`).join('; ')}` : ''}. ${state.stats.pendingSuggestions} bible suggestions are waiting${state.stats.pendingSuggestions > 0 ? ' (see novel_status)' : ''}.`,
          data: toJson(result),
        }
      },
    }),

    novelTool(service, {
      name: 'novel_review',
      description: 'Have the analyst model read one chapter as a senior editor: continuity against earlier facts and the timeline, character consistency (personality, motive, voice, what they know), world rules, logic, style and pacing. Returns a verdict and a list of issues anchored to exact quotes, each with a suggested fix — which you can turn into novel_revise scope=passage calls.',
      parameters: {
        chapter: { type: 'string', required: true },
        focus: { type: 'string', description: 'What to look at in particular.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const chapter = args.chapter
        const review = await env.job('review', 'review', chapter, async task => await reviewChapter(env.core, runtime, { chapter, ...(args.focus !== undefined ? { focus: args.focus } : {}) }, task))
        if (review.issues.length === 0) return { text: `Chapter ${review.index} "${review.title}": ${review.verdict}\nNo issues found.`, data: toJson(review) }
        return {
          text: `Chapter ${review.index} "${review.title}": ${review.verdict}\n\n${review.issues.map((issue, index) => `${index + 1}. [${issue.severity}/${issue.type}] ${issue.quote !== undefined ? `"${clip(issue.quote, 80)}" — ` : ''}${issue.explanation}${issue.suggestion !== undefined ? `\n   Fix: ${issue.suggestion}` : ''}`).join('\n')}`,
          data: toJson(review),
        }
      },
    }),

    novelTool(service, {
      name: 'novel_import',
      description: 'Import an existing book into the project in one pass, so it can be continued, revised or staged: an editor agent reads the text and finds its real chapters and volumes (headings written any way, a table of contents, site navigation left by a web page — it sorts them out and reports what it did), then the Studio digests every chapter, merges the cast into character cards, collects the world entries, writes chapter synopses, a logline and a premise, and learns the style from the text. Give `path` (a .txt, .md, .epub or .docx file inside the workspace; UTF-8, UTF-16 and GB18030 are detected) or the text itself. Large books take several minutes.',
      mutating: true,
      parameters: {
        path: { type: 'string', description: 'File inside the session workspace.' },
        text: { type: 'string', description: 'The manuscript text, when it is not in a file.' },
        analyze: { type: 'boolean', description: 'false only splits into chapters and skips the analysis passes (default true).' },
      },
      async run(args, env) {
        const runtime = await env.project()
        let text = args.text ?? ''
        if (args.path !== undefined && args.path.trim().length > 0) {
          let file: string
          try {
            file = containedPath(env.workspace, args.path)
          } catch {
            throw new ProjectError('novel/invalid', 'the file must be inside the session workspace — copy it there first')
          }
          try {
            const book = readBookFile(file, await readFile(file))
            text = book.text
            // A book that names itself is a better title than whatever the project was created with.
            if (book.title !== undefined || book.author !== undefined) {
              const manifest = await runtime.project.manifest()
              const stats = (await runtime.project.state()).stats
              if (stats.chapters === 0) {
                await runtime.project.updateManifest({
                  ...(book.title !== undefined ? { title: book.title } : {}),
                  ...(book.author !== undefined && manifest.author === undefined ? { author: book.author } : {}),
                })
              }
            }
          } catch (error) {
            throw new ProjectError('novel/not-found', `could not read ${args.path}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (text.trim().length === 0) throw new ProjectError('novel/invalid', 'give `path` or `text`')
        const result = await env.job('import', 'import', undefined, async task => await importManuscript(env.core, runtime, { text, ...(args.analyze !== undefined ? { analyze: args.analyze } : {}) }, task))
        return {
          text: `Imported ${result.chapters} chapters (${result.words} words) in ${result.volumes} volume(s): ${result.digested} digested, ${result.characters} character cards, ${result.worldEntries} world entries${result.style !== undefined ? `, style "${result.style}" learned` : ''}.${result.failed.length > 0 ? `\nSteps that failed and can be redone: ${result.failed.map(item => `${item.step} (${item.error})`).join('; ')}` : ''}\n${result.structure.by === 'agent' ? `The chapters were found by the editor agent in ${result.structure.steps ?? 0} steps${result.structure.bySize ? ' — it found no chapter marks and cut the text by length' : ''}.` : 'The chapters were cut by rule, not by the editor agent.'}${result.structure.note !== undefined ? ` Its account, for the author: ${result.structure.note}` : ''}\nReview the cast and outline with the author (novel_status detail=full).`,
          data: toJson(result),
          // The import puts its own entry on the book's record, with the editor's account of how the book was cut.
          record: false,
        }
      },
    }),
  ]
}

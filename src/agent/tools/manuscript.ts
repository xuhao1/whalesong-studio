// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools that produce and change prose: write, revise, digest, review, import. */
import { readFile } from 'node:fs/promises'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { digestPending } from '../../core/pipelines/digest'
import { correctMemory, editChapter, type EditAction, type MemoryPatch } from '../../core/pipelines/edit'
import { analyzeBook, importManuscript, readBookFile, importLine, rereadBook } from '../../core/pipelines/import'
import { reviewChapter } from '../../core/pipelines/review'
import { acceptProposal, rejectProposal, fixIssues, mendInTurn, reviseBook, reviseChapter, reviseSpan } from '../../core/pipelines/revise'
import { writeChapter } from '../../core/pipelines/write'
import { cleanGuides } from '../../core/pipelines/guides'
import { settleTerms, translateChapters, untranslateChapter } from '../../core/pipelines/translate'
import { ProjectError } from '../../core/project'
import { containedPath } from '../../core/util/fs'
import type { NovelService } from '../../host/service'
import { clip } from '../../shared/text'
import { ANALYZE_STEPS, GLOSSARY_KINDS } from '../../shared/types'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

export function manuscriptTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_write',
      description: [
        'Have the writer model draft prose for one chapter and save it. You do not write the prose yourself: you decide what the chapter must do and say so in `brief`; the writer receives the bible, the relevant characters with their current state, the story so far, retrieved earlier passages, the open threads, this chapter\'s outline and the active style.',
        '- `chapter`: id, number or title; omit (or "next") for the first outlined chapter without text — on the main line, or on the line of the plot named in `line` when the story has more than one way on (novel_status lists the lines). When several lines could be gone on with and the author has not said which, ask.',
        '- `mode`: draft (default) writes the chapter from the top, replacing existing text after a snapshot; continue appends to what is there.',
        '- `brief`: what this pass must achieve that the outline does not already say — emphasis, tone, what to hold back, how to end. Keep it short; do not restate the outline.',
        '- `words`: a length recommended for this pass. Leave it out unless the author named one: the chapter\'s own recommendation applies (novel_outline targetWords), else the book\'s (novel_settings action=book fields.chapterBudget), and where nobody set any the writer judges the length from what the chapter has to do.',
        'The writer reads the story so far in two layers: as many whole chapters up to this one as half its context window holds, word for word, and the chapters before those as an outline; a chapter that already has chapters after it (one written again) is given what follows too, and must lead into it.',
        '- `pictures`: pictures of the book (project-relative paths, as novel_manage lists them) the author gave to write this pass by — a moment, a face, a place, a mood. A writer whose model takes pictures looks at them itself; otherwise the model set up to look at pictures (novel_settings: vision) says in words what they show, and without one the call fails and says so. Pictures kept on the chapter\'s plan (novel_outline update-chapter guides) are used without being named here. Only pictures the author pointed at: do not pick some yourself.',
        'The result gives length, the opening and closing lines and the cast used; read the chapter (novel_read) only when you need to check something specific. Make sure the chapter has beats first (novel_derive kind=beats). To write a run of chapters in one go, use novel_batch.',
      ].join('\n'),
      mutating: true,
      parameters: {
        chapter: { type: 'string', description: 'Chapter id, number or title. Default: next unwritten chapter.' },
        brief: { type: 'string', description: 'Direction for this pass.' },
        mode: { type: 'string', enum: ['draft', 'continue'] },
        words: { type: 'integer', description: 'A recommended length for this pass. Leave out to use the chapter\'s or the book\'s, or — where none is set — to let the writer judge.' },
        line: { type: 'string', description: 'With `chapter` left out: the line of the plot to go on with (its id or name). Default: the main line.' },
        style: { type: 'string', description: 'Style profile to use instead of the active one.' },
        characters: listParameter('Characters to keep in view besides those the outline names.'),
        pictures: listParameter('Pictures the author gave to write this pass by: project-relative paths of the book\'s own pictures.'),
      },
      async run(args, env) {
        const runtime = await env.project()
        const result = await env.job('write', 'write', args.chapter, async task => await writeChapter(env.core, runtime, {
          ...(args.chapter !== undefined ? { chapter: args.chapter } : {}),
          ...(args.brief !== undefined ? { brief: args.brief } : {}),
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.words !== undefined ? { words: args.words } : {}),
          ...(args.line !== undefined && args.line.trim().length > 0 ? { line: args.line.trim() } : {}),
          ...(args.style !== undefined ? { style: args.style } : {}),
          ...(listOf(args.characters) !== undefined ? { characters: listOf(args.characters)! } : {}),
          ...(listOf(args.pictures) !== undefined ? { guides: cleanGuides(listOf(args.pictures)!) } : {}),
        }, task))
        const story = result.strategy === 'full' ? 'everything before it word for word' : result.strategy === 'window' ? `chapters ${result.window?.from}–${result.window?.to} word for word, the ones before as an outline` : 'no chapter whole: an outline, looked-up passages and the end of the chapter before'
        const lines = [
          `${result.mode === 'continue' ? 'Continued' : 'Drafted'} chapter ${result.index} "${result.title}" (${result.chapterId}): ${result.wordsWritten} words written, ${result.wordsTotal} in the chapter now.`,
          `Writer: ${result.model}; length: ${result.budget !== undefined ? `about ${result.budget} recommended` : 'left to the writer'}; story so far: ${story}${result.following !== undefined ? `, plus the ${result.following} chapter(s) after it` : ''} (~${result.contextTokens} tokens${result.cachedTokens !== undefined ? `, ${result.cachedTokens} read from the provider's cache` : ''}); cast in view: ${result.cast.join(', ') || 'none'}.${result.continued ? ' The model hit its output limit and the chapter was completed by continuation.' : ''}`,
          ...(result.pictures !== undefined ? [`Pictures: ${result.pictures.count} given — ${result.pictures.by === 'vision' ? `put into words for the writer by ${result.pictures.model ?? 'the picture model'}` : result.pictures.unsure === true ? 'sent to the writer\'s model, which does not say whether it takes pictures: tell the author, and that a model to look at pictures can be set (novel_settings: vision)' : 'looked at by the writer\'s own model'}.`] : []),
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
        '- scope=issues: mend what reviews found, together — also across chapters. Name them in `issues` as `<chapter>:<issue id>` (ids are in a chapter\'s review: novel_review, novel_read what=review), or pass `severity` (high | medium | low) to take every open issue that grave or graver, in `chapters` if given. `instruction` is what the author says of the whole batch (optional); what they said of single issues is kept with those and goes along. One planner reads them side by side and settles which chapters change and how — also chapters nobody named, where they tell of the same facts — and each chapter is rewritten once, so one fact is mended one way throughout. Every change waits as a proposal; changes to the bible wait as suggestions.',
        '- scope=accept / scope=reject: settle a pending proposal by `proposal` id. Rejecting one that was made on top of earlier waiting changes brings those back to wait by themselves.',
        'book / issues, `order`: mendings do not lock each other out. `queue` (the default) waits for the mendings already under way and goes on from the changes they leave waiting — a chapter with a change waiting is rewritten as it would read with that accepted, and the new proposal stands for the earlier ones (one to accept); use it when what is mended hangs together. `apart` starts at once on the text as it stands — for mendings that have nothing to do with each other (another line of the plot, a far part of the story), which are quicker side by side.',
        'Every applied change snapshots the previous text first. Passage and chapter revisions apply directly unless the author turned on review of agent revisions; pass apply=false to always leave a proposal.',
      ].join('\n'),
      mutating: args => args.scope !== 'reject',
      parameters: {
        scope: { type: 'string', required: true, enum: ['passage', 'chapter', 'book', 'issues', 'accept', 'reject'] },
        issues: listParameter('issues: which review issues, each as `<chapter>:<issue id>`.'),
        severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'issues: instead of naming them, every open issue this grave or graver.' },
        chapter: { type: 'string', description: 'passage/chapter: which chapter.' },
        quote: { type: 'string', description: 'passage: the exact text to rewrite.' },
        instruction: { type: 'string', description: 'What to change and why.' },
        chapters: listParameter('book: restrict to these chapters.'),
        proposal: { type: 'string', description: 'accept/reject: the proposal id.' },
        apply: { type: 'boolean', description: 'Apply immediately (true) or leave a proposal (false).' },
        order: { type: 'string', enum: ['queue', 'apart'], description: 'book/issues: after the mendings under way and on top of their changes (queue, default), or at once by itself (apart).' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const order = args.order === 'apart' ? 'apart' as const : 'queue' as const
        if (args.scope === 'accept' || args.scope === 'reject') {
          if (args.proposal === undefined) throw new ProjectError('novel/invalid', 'pass the proposal id in `proposal`')
          if (args.scope === 'accept') {
            const proposal = await acceptProposal(env.core, runtime, args.proposal, env.task)
            return { text: `Applied proposal ${proposal.id} to ${proposal.chapterId}.` }
          }
          const rejected = await rejectProposal(runtime, args.proposal)
          return { text: rejected !== undefined ? `Rejected proposal ${args.proposal}.` : `No proposal "${args.proposal}".` }
        }
        if (args.scope === 'issues') {
          const named = (listOf(args.issues) ?? []).map((item) => {
            const at = item.lastIndexOf(':')
            if (at <= 0) throw new ProjectError('novel/invalid', `"${item}" does not name an issue: write <chapter>:<issue id>`)
            return { chapter: item.slice(0, at).trim(), issue: item.slice(at + 1).trim() }
          })
          if (named.length === 0 && args.severity === undefined) throw new ProjectError('novel/invalid', 'scope=issues needs `issues` (each <chapter>:<issue id>) or `severity`')
          const severity = args.severity === 'low' || args.severity === 'medium' ? args.severity : 'high'
          const result = await env.job('revise', 'revise book', undefined, async task => await mendInTurn(runtime, order, task, async onto => await fixIssues(env.core, runtime, {
            ...(named.length > 0 ? { issues: named } : { atLeast: severity, ...((listOf(args.chapters)?.length ?? 0) > 0 ? { chapters: listOf(args.chapters)! } : {}) }),
            ...(args.instruction !== undefined && args.instruction.trim().length > 0 ? { note: args.instruction.trim() } : {}),
            ...(onto ? { onto: true } : {}),
          }, task)))
          if (result.book === undefined) return { text: 'No open issue matches: nothing was handed over. Review the chapters first (novel_review), or name the issues.', record: false }
          const lines = result.book.results.map(item => `- chapter ${item.index} "${item.title}": ${item.wordsBefore} → ${item.wordsAfter} words, proposal ${item.proposalId ?? ''} — ${brief(item.reason, 120)}`)
          return {
            text: `${result.issues} issue(s) in ${result.chapters} chapter(s) were read together; ${result.book.results.length} chapter(s) rewritten${result.book.failed.length > 0 ? `, ${result.book.failed.length} failed` : ''}.${result.book.note !== undefined ? `\n${result.book.note}` : ''}\n${lines.join('\n')}${result.book.failed.map(item => `\n✗ ${item.chapterId}: ${item.error}`).join('')}${(result.book.bible?.length ?? 0) > 0 ? `\nChanges to the bible wait among the suggestions: ${result.book.bible!.map(item => `${item.name} · ${item.field}`).join(', ')}.` : ''}\nThe proposals wait for the author in Novel Studio → Review; the issues stay open, marked as handed over, until the author settles them. Tell the author which chapters changed and why.`,
            data: toJson(result),
          }
        }
        if (args.instruction === undefined || args.instruction.trim().length === 0) throw new ProjectError('novel/invalid', '`instruction` is required')
        const instruction = args.instruction
        if (args.scope === 'book') {
          const result = await env.job('revise', 'revise book', undefined, async task => await mendInTurn(runtime, order, task, async onto => await reviseBook(env.core, runtime, {
            instruction,
            ...((listOf(args.chapters)?.length ?? 0) > 0 ? { chapters: listOf(args.chapters)! } : {}),
            ...(args.apply !== undefined ? { apply: args.apply } : {}),
            ...(onto ? { onto: true } : {}),
          }, task)))
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
      name: 'novel_translate',
      description: [
        'Translate the book\'s chapters into another language with the writer model, so that the whole of it says one thing one way. What keeps a long translation consistent is the glossary: how every name and every word of the book\'s own is written in the other language. It is settled before anything is translated (off the cards — who somebody is decides how their name and their forms of address come out — and out of the text where the book has no cards), the terms a chapter uses go along with that chapter, a translation that meets a name without a rendering settles one and adds it, and afterwards the cards take the translated names as other names they go by.',
        '- action=chapters (default): translate `chapters` (ids or numbers; left out: every chapter of `line` that has text) into `to` (a language tag: en, zh, ja, ko, fr, de, es, ru…). A chapter\'s translation takes the place of its text; the text it was made from is kept as a version of the chapter and can be put back (action=original). Chapters already in `to`, and empty ones, are left alone. `from`: what the text is in — left out, what each chapter is in now; "auto" lets the translator tell. `direction`: what the author asks of the translation (spelling, register, how to treat honorifics). When every chapter with text is in `to`, that becomes the book\'s language. Say afterwards what was translated, what failed, and how many terms the glossary has.',
        '- action=terms: the glossary of `to` as it stands. With `settle=true`: first settle a rendering for every person and entry of the bible that has none (and, with `scan=true`, for the proper names found in the text) — what is settled already is never written over. Show the author the renderings of the people who matter before a long translation: a name is cheap to change now and dear after.',
        '- action=set_terms: set or correct renderings by hand — `terms` [{source, target, kind: person|place|house|thing|term, note: what it is, for the translator}]; a term with an empty `target` is taken out. These are the author\'s, and no later pass writes over them. Chapters translated before a rendering changed keep the old one until they are translated again from their original.',
        '- action=original: put the original of `chapters` back as their text (the translation is then a version in its turn).',
      ].join('\n'),
      mutating: args => !(args.action === 'terms' && args.settle !== true),
      parameters: {
        action: { type: 'string', enum: ['chapters', 'terms', 'set_terms', 'original'], description: 'chapters (default); terms to read or settle the glossary; set_terms to correct it; original to put a chapter\'s original back.' },
        to: { type: 'string', description: 'The language translated into, as a tag (en, zh, ja…). Required but for action=original.' },
        from: { type: 'string', description: 'chapters: what the text is in; "auto" lets the translator tell. Left out: what each chapter is in now.' },
        chapters: listParameter('chapters, original: which chapters. chapters without it: every chapter of the line that has text.'),
        line: { type: 'string', description: 'chapters: the line of the plot meant (left out: the main one).' },
        direction: { type: 'string', description: 'What the author asks of the translation, or of the renderings.' },
        settle: { type: 'boolean', description: 'terms: settle what has no rendering yet. chapters: false translates by the glossary as it is (default: the names are settled first where there are none).' },
        scan: { type: 'boolean', description: 'terms with settle: also read the text for proper names that have no card.' },
        terms: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'set_terms: [{source, target, kind, note}].' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        const action = args.action ?? 'chapters'
        if (action === 'original') {
          const refs = listOf(args.chapters) ?? []
          if (refs.length === 0) throw new ProjectError('novel/invalid', 'action=original needs `chapters`')
          const back: string[] = []
          for (const ref of refs) back.push((await untranslateChapter(runtime, ref)).chapter)
          return { text: `The original is the text again of: ${back.join(', ')}. The translation of each is kept among its versions.`, data: toJson({ chapters: back }) }
        }
        const to = args.to?.trim() ?? ''
        if (to.length === 0) throw new ProjectError('novel/invalid', `action=${action} needs \`to\`: the language, as a tag (en, zh, ja…)`)
        const listed = (terms: { source: string; target: string; kind?: string; note?: string; by?: string }[]): string => terms.map(term => `- ${term.source} → ${term.target}${term.kind !== undefined ? ` [${term.kind}]` : ''}${term.note !== undefined ? ` — ${term.note}` : ''}${term.by === 'author' ? ' (the author\'s)' : ''}`).join('\n')
        if (action === 'terms') {
          let settled: Awaited<ReturnType<typeof settleTerms>> | undefined
          if (args.settle === true) {
            settled = await env.job('bible', 'settle terms', undefined, async task => await settleTerms(env.core, runtime, { to, ...(args.from !== undefined && args.from !== 'auto' ? { from: args.from } : {}), ...(args.scan === true ? { scan: true } : {}), ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          }
          const glossary = await project.glossary(to)
          if (glossary.length === 0) return { text: `No names are settled for ${to} yet. action=terms settle=true settles them off the bible (scan=true reads the text too); a translation settles them first by itself.`, record: false }
          return {
            text: `${settled !== undefined ? `Settled ${settled.added.length} more${settled.failed.length > 0 ? ` (${settled.failed.length} pass(es) came back with nothing usable: ${clip(settled.failed.join('; '), 300)})` : ''}. ` : ''}The glossary for ${to}, ${glossary.length} term(s):\n${listed(glossary)}`,
            data: toJson(glossary),
            ...(settled === undefined ? { record: false as const } : { record: { summary: [`定译名（${to}）：新定 ${settled.added.length} 条，共 ${glossary.length} 条`, `Settled names for ${to}: ${settled.added.length} more, ${glossary.length} in all`] as [string, string] } }),
          }
        }
        if (action === 'set_terms') {
          const given = (Array.isArray(args.terms) ? args.terms as unknown[] : []).filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).source === 'string')
          if (given.length === 0) throw new ProjectError('novel/invalid', 'action=set_terms needs `terms`: [{source, target, kind, note}]')
          const after = await project.updateGlossary(to, (current) => {
            const next = [...current]
            for (const item of given) {
              const source = String(item.source).trim()
              const at = next.findIndex(term => term.source.toLowerCase() === source.toLowerCase())
              const target = typeof item.target === 'string' ? item.target.trim() : ''
              if (target.length === 0) { if (at >= 0) next.splice(at, 1); continue }
              const kind = GLOSSARY_KINDS.find(kind => kind === item.kind)
              const note = typeof item.note === 'string' && item.note.trim().length > 0 ? item.note.trim() : undefined
              const term = { ...(at >= 0 ? next[at]! : {}), source, target, ...(kind !== undefined ? { kind } : {}), ...(note !== undefined ? { note } : {}), by: 'author' as const }
              if (at >= 0) next[at] = term
              else next.push(term)
            }
            return next
          })
          return { text: `The glossary for ${to} has ${after.length} term(s) now. What you set:\n${listed(after.filter(term => given.some(item => String(item.source).trim().toLowerCase() === term.source.toLowerCase())))}\nChapters translated before this keep the renderings they were translated with.`, data: toJson(after) }
        }
        const refs = listOf(args.chapters) ?? []
        const result = await env.job('write', 'translate', refs.length === 1 ? refs[0] : undefined, async task => await translateChapters(env.core, runtime, {
          to,
          ...(refs.length > 0 ? { chapters: refs } : {}),
          ...(args.line !== undefined ? { line: args.line } : {}),
          ...(args.from !== undefined ? { from: args.from } : {}),
          ...(args.settle !== undefined ? { settle: args.settle } : {}),
          ...(args.direction !== undefined ? { direction: args.direction } : {}),
        }, task))
        const same = result.skipped.filter(item => item.why === 'same').length
        return {
          text: `Translated ${result.translated.length} chapter(s) into ${to}${result.translated.length > 0 ? `: ${clip(result.translated.map(item => `"${item.title}"`).join(', '), 400)}` : ''}.${same > 0 ? ` ${same} were in ${to} already.` : ''}${result.skipped.length - same > 0 ? ` ${result.skipped.length - same} have no text.` : ''}${result.failed.length > 0 ? ` ${result.failed.length} failed and are as they were: ${clip(result.failed.map(item => `${item.chapter} — ${item.error}`).join('; '), 400)}.` : ''} The glossary has ${result.terms.total} term(s)${result.terms.added > 0 ? ` (${result.terms.added} settled now)` : ''}; ${result.named} card(s) took the name they go by in the translation.${result.language !== undefined ? ` Every chapter with text is in ${result.language} now: it is the book's language.` : ''} Each chapter's original is kept among its versions (action=original puts it back). The digests of these chapters were made of the original: have them digested again (novel_digest force=true) before more is written after them.`,
          data: toJson(result),
          record: { summary: [`翻译成 ${to}：${result.translated.length} 章${result.failed.length > 0 ? `，${result.failed.length} 章没成` : ''}`, `Translated into ${to}: ${result.translated.length} chapter(s)${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}`] },
        }
      },
    }),

    novelTool(service, {
      name: 'novel_import',
      description: [
        'Import an existing book into the project, so it can be continued, revised or staged: an editor agent reads the text and finds its real chapters and volumes (headings written any way, a table of contents, site navigation left by a web page — it sorts them out and reports what it did), then the book is analysed — every chapter digested, the people the chapters name given their cards (the leads whole cards, those who come back a line, other names of the same person folded together, whoever passes once left a walk-on), the world entries collected, chapter synopses, a logline and a premise written, the style learned from the text. Give `path` (a .txt, .md, .epub or .docx file inside the workspace; UTF-8, UTF-16 and GB18030 are detected) or the text itself. A long book takes a long time.',
        '- action=line: import a manuscript (`path` or `text`) as another line of this book\'s plot, named `title` — for stories that are different from the first chapter on and share the world (a series set in one world). The line begins where the story begins and joins nothing; its chapters are digested, and what they share with the book is recognised by name.',
        '- action=analyze: run the analysis on the book as it stands, without importing anything. Without `steps` it goes on where an analysis that was cut short stopped (novel_status says when one was); with `steps` (digest, cast, world, ties, outline, style, art) it runs those passes again — each adds to what is there and leaves alone what the author worked on. Use it when chapters were digested since the cast was made, when a lead has no card, when an import ended early.',
      ].join('\n'),
      mutating: true,
      parameters: {
        action: { type: 'string', enum: ['import', 'analyze', 'line', 'reread'], description: 'import (default); reread to read the book again from nothing but its text — everything read off it (digests, cards, entries, ties, threads, suggestions, what reviews found, what the outlines took from the chapters) is cleared first and the book is taken in anew; pictures come back onto the card or entry of the same name, the text and what was made for the eye and the ear stay. Only when the author asked for exactly this; analyze for the analysis alone on a book that has its chapters; line to import a manuscript as another line of this book\'s plot — a story different from its first chapter, in the same world (same bible, same people where they are the same).' },
        title: { type: 'string', description: 'line: what the line is called (left out: the manuscript\'s own title).' },
        premise: { type: 'string', description: 'line: what the line tells, in a sentence.' },
        path: { type: 'string', description: 'File inside the session workspace.' },
        text: { type: 'string', description: 'The manuscript text, when it is not in a file.' },
        analyze: { type: 'boolean', description: 'import: false only splits into chapters and skips the analysis passes (default true).' },
        translate_from: { type: 'string', description: 'import: the manuscript is in another language than the book is to be in — the language it is in (a tag: en, ja, zh…), or "auto" to let the translator tell. It is then translated into the book\'s language as it comes in: the names settled out of the text first (the glossary), each chapter translated by them, its original kept as a version; everything after — digests, cards, outline — is read off the translation.' },
        steps: listParameter('analyze: the passes to run, out of digest, cast, growth (how the people of the book change along it: ages, the points where they turn), world, ties (how people, places, houses and things stand to each other, and the course of the places), outline, style, art. Leave out to finish what an analysis left undone.'),
      },
      async run(args, env) {
        const runtime = await env.project()
        if (args.action === 'reread') {
          const result = await env.job('import', 'reread', undefined, async task => await rereadBook(env.core, runtime, {}, task))
          const now = await runtime.project.state()
          return {
            text: `Read again from the text alone. Cleared: ${result.cleared.characters} card(s), ${result.cleared.world} entr(ies), ${result.cleared.ties} tie(s), ${result.cleared.threads} thread(s), the digests of ${result.cleared.digests} chapter(s). Now: ${now.characters.length} card(s), ${now.world.length} entr(ies). Pictures went back onto ${result.pictures.people} card(s) and ${result.pictures.things} entr(ies)${result.without.length > 0 ? `; no card or entry bears these names now, their pictures are in the gallery: ${result.without.slice(0, 20).join(', ')}` : ''}.${result.analysis.failed.length > 0 ? ` Not done: ${result.analysis.failed.map(item => `${item.step} (${item.error})`).join('; ')}.` : ''} A cleared card or entry can be had back from the removed ones (novel_manage action=history).`,
            data: toJson(result),
            record: { summary: [`纯净重新收录：现在 ${now.characters.length} 张人物卡、${now.world.length} 条设定`, `Read again from the text alone: ${now.characters.length} cards, ${now.world.length} entries`] },
          }
        }
        if (args.action === 'analyze') {
          const steps = ANALYZE_STEPS.filter(step => listOf(args.steps)?.includes(step) === true)
          const result = await env.job('import', 'analyze', undefined, async task => await analyzeBook(env.core, runtime, steps.length > 0 ? { steps } : {}, task))
          const state = await runtime.project.state()
          return {
            text: `Analysed (${result.steps.join(', ') || 'nothing was left to do'}): ${result.digested} chapters digested, ${result.characters} character cards made or filled in, ${result.merged} names folded into somebody's card as aliases, ${result.walkOns} people of one chapter left as walk-ons, ${result.worldEntries} world entries${result.ties !== undefined ? `, ${result.ties.added} ties written down between people, places, houses and things (${result.ties.total} in all) and ${result.ties.events} things noted that happen to them` : ''}${result.style !== undefined ? `, style "${result.style}" learned` : ''}.${result.failed.length > 0 ? `\nDid not come about, and can be run again: ${result.failed.map(item => `${item.step} (${item.error})`).join('; ')}` : ''}${state.analysis !== undefined ? `\nStill to do: ${state.analysis.pending.join(', ')}.` : ''}${state.uncarded !== undefined ? `\nStill without a card though they come back: ${state.uncarded.names.join(', ')}${state.uncarded.count > state.uncarded.names.length ? ` and ${state.uncarded.count - state.uncarded.names.length} more` : ''}.` : ''}`,
            data: toJson(result),
            record: { summary: [`分析全书（${result.steps.join('、')}）：人物卡 ${result.characters} 张，并为别名 ${result.merged} 个，设定 ${result.worldEntries} 条`, `Read the book (${result.steps.join(', ')}): ${result.characters} cards, ${result.merged} aliases, ${result.worldEntries} world entries`] },
          }
        }
        if (args.action === 'line') {
          let manuscript = args.text ?? ''
          let named = args.title?.trim() ?? ''
          if (args.path !== undefined && args.path.trim().length > 0) {
            let file: string
            try {
              file = containedPath(env.workspace, args.path)
            } catch {
              throw new ProjectError('novel/invalid', 'the file must be inside the session workspace — copy it there first')
            }
            const book = readBookFile(file, await readFile(file))
            manuscript = book.text
            if (named.length === 0) named = book.title ?? args.path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
          }
          if (manuscript.trim().length === 0) throw new ProjectError('novel/invalid', 'action=line needs the manuscript: `path` or `text`')
          if (named.length === 0) throw new ProjectError('novel/invalid', 'action=line needs a `title` for the line')
          const result = await env.job('import', 'import line', undefined, async task => await importLine(env.core, runtime, { text: manuscript, title: named, ...(args.premise !== undefined ? { premise: args.premise } : {}) }, task))
          return {
            text: `Imported "${result.line.title}" as another line of the plot (${result.line.id}): ${result.chapters} chapters, ${result.words} words, beginning where the story begins and joining nothing. ${result.digested} of them digested${result.failed.length > 0 ? `, ${result.failed.length} could not be (${result.failed.slice(0, 3).map(item => `${item.chapter}: ${brief(item.error, 80)}`).join('; ')})` : ''}. People and places it shares with the book were recognised by name; whoever and whatever is new waits among the suggestions (novel_status). Lives, stages and signature scenes are read along a line: pass the line where a tool takes one. Tell the author what came in.`,
            data: toJson(result),
            record: { summary: [`导入了另一条故事线「${result.line.title}」：${result.chapters} 章`, `Imported another story line, "${result.line.title}": ${result.chapters} chapters`] },
          }
        }
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
        const into = (await runtime.project.manifest()).language
        const written = args.translate_from?.trim()
        const translate = written !== undefined && written.length > 0 && written !== into ? { to: into, ...(written !== 'auto' ? { from: written } : {}) } : undefined
        const result = await env.job('import', 'import', undefined, async task => await importManuscript(env.core, runtime, { text, ...(args.analyze !== undefined ? { analyze: args.analyze } : {}), ...(translate !== undefined ? { translate } : {}) }, task))
        return {
          text: `Imported ${result.chapters} chapters (${result.words} words) in ${result.volumes} volume(s)${result.translated !== undefined ? `, translated into ${result.translated.to} as they came in (${result.translated.chapters} chapters by a glossary of ${result.translated.terms} terms${result.translated.failed > 0 ? `; ${result.translated.failed} could not be translated and are still in the original — novel_translate does them again` : ''}; each chapter's original is a version of it)` : ''}: ${result.digested} digested, ${result.characters} character cards, ${result.worldEntries} world entries${result.style !== undefined ? `, style "${result.style}" learned` : ''}.${result.failed.length > 0 ? `\nSteps that failed and can be redone: ${result.failed.map(item => `${item.step} (${item.error})`).join('; ')}` : ''}\n${result.structure.by === 'agent' ? `The chapters were found by the editor agent in ${result.structure.steps ?? 0} steps${result.structure.bySize ? ' — it found no chapter marks and cut the text by length' : ''}.` : 'The chapters were cut by rule, not by the editor agent.'}${result.structure.note !== undefined ? ` Its account, for the author: ${result.structure.note}` : ''}\nReview the cast and outline with the author (novel_status detail=full).`,
          data: toJson(result),
          // The import puts its own entry on the book's record, with the editor's account of how the book was cut.
          record: false,
        }
      },
    }),
  ]
}

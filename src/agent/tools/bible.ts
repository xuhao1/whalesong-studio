// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools for the story bible and the outline. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { acceptSuggestion, dismissSuggestion, expandCharacter, expandWorld, extractStyle } from '../../core/pipelines/bible'
import { applyOutlineOps, type OutlineOp } from '../../core/pipelines/outline'
import { buildFoundation, deriveBeats, deriveChapters, whatIf } from '../../core/pipelines/plot'
import { ProjectError, upsertLooks } from '../../core/project'
import { deriveVisual } from '../../core/pipelines/illustrate'
import { promptLanguage, renderCharacter, renderWorld } from '../../core/render'
import type { NovelService } from '../../host/service'
import type { CharacterCard, StyleProfile, WorldEntry } from '../../shared/types'
import { brief, novelTool, toJson } from './shared'

const CHARACTER_FIELDS = 'name, aliases[], role (protagonist|deuteragonist|antagonist|supporting|minor|cameo), status (planned|active|offstage|retired|dead), tagline, gender, age, appearance, personality, background, motivation, flaw, arc, voice, abilities, secrets, persona {traits[{name,level 1-5}], values[], speech[], taboos[], underPressure}, relationships[{target, kind, note}], tags[], visual {prompt (the visual anchor: concrete, drawable phrases for an image model — build, face, hair, clothing, signature items; English works best), negative (what must not be drawn on them), looks[{name, prompt (what the outfit changes), when (when it is worn)}] — looks are added or updated by name and the others stay; {name, remove: true} takes one away; their design sheets are drawn with novel_illustrate kind=sheet look=…}, voiceProfile {voice, instructions, designPrompt}, notes'
const WORLD_FIELDS = 'name, aliases[], category (setting|location|faction|system|item|history|culture|rule|term|other), importance (1 core canon always in context | 2 normal | 3 detail), summary, body (Markdown), related[], tags[], visualPrompt'
const STYLE_FIELDS = 'name, pov (first|third-limited|third-omniscient|second|multi), tense (past|present), tone, diction, rhythm, imagery, dialogue, pacing, rules[], avoid[], exemplars[{label,text}], body'

export function bibleTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_bible',
      description: [
        'Maintain the story bible: characters, world entries and style profiles.',
        '- action=save creates or updates one entry: pass only the fields that change; an empty string clears a field. `ref` names the entry to update (id, name or alias); omit it to create.',
        '- action=delete removes an entry.',
        '- action=expand lets the architect model flesh out a character or world entry in agreement with the written text (`direction` steers it).',
        '- action=derive_visual (kind=character) distills the prose appearance of a character into a visual anchor and a negative list for image generation, and stores both on the card (`direction` steers it). Do this — or write fields.visual yourself — before drawing someone: an image model handed the prose of a card invents what the prose leaves open.',
        '- action=learn_style (kind=style) distills a style profile from a sample passage in fields.sample.',
        '- action=accept_suggestion / dismiss_suggestion settle a suggestion that digest left (ids are listed by novel_status).',
        `Character fields: ${CHARACTER_FIELDS}.`,
        `World fields: ${WORLD_FIELDS}.`,
        `Style fields: ${STYLE_FIELDS}. Pass activate=true to make a style the one the writer uses.`,
        'Changing a character or the world after chapters are written can contradict them: search the manuscript (novel_search) and plan the follow-up revisions with the author.',
      ].join('\n'),
      mutating: true,
      parameters: {
        action: { type: 'string', required: true, enum: ['save', 'delete', 'expand', 'derive_visual', 'learn_style', 'accept_suggestion', 'dismiss_suggestion'] },
        kind: { type: 'string', enum: ['character', 'world', 'style'], description: 'Required except for the suggestion actions.' },
        ref: { type: 'string', description: 'Entry id or name; the suggestion id for the suggestion actions.' },
        fields: { type: 'object', additionalProperties: true, description: 'Fields to set (save), or {sample, name} for learn_style.' },
        direction: { type: 'string', description: 'For expand: what to develop or change.' },
        activate: { type: 'boolean', description: 'For styles: make it the active style.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        const lang = promptLanguage((await project.manifest()).language)
        const fields = (args.fields ?? {}) as Record<string, unknown>
        if (args.action === 'accept_suggestion' || args.action === 'dismiss_suggestion') {
          if (args.ref === undefined) throw new ProjectError('novel/invalid', 'pass the suggestion id in `ref`')
          if (args.action === 'accept_suggestion') {
            const suggestion = await acceptSuggestion(runtime, args.ref)
            return { text: `Accepted: ${suggestion.title}` }
          }
          const dismissed = await dismissSuggestion(runtime, args.ref)
          return { text: dismissed ? 'Dismissed.' : `No suggestion "${args.ref}".` }
        }
        if (args.kind === undefined) throw new ProjectError('novel/invalid', '`kind` is required: character, world or style')

        if (args.action === 'save') {
          // `ref` selects the entry; a new entry takes its name from fields.name.
          if (args.kind === 'character') {
            const existing = args.ref !== undefined ? await project.findCharacter(args.ref) : undefined
            if (args.ref !== undefined && existing === undefined && fields.name === undefined) fields.name = args.ref
            // A model names the looks it means, not the whole wardrobe: add or update those and keep the rest, with the sheets drawn for them.
            const target = existing ?? (typeof fields.name === 'string' ? await project.findCharacter(fields.name) : undefined)
            const visual = fields.visual
            if (visual !== null && typeof visual === 'object' && !Array.isArray(visual) && Array.isArray((visual as { looks?: unknown }).looks)) {
              fields.visual = { ...visual, looks: upsertLooks(target?.visual?.looks ?? [], (visual as { looks: unknown }).looks) }
            }
            const card = await project.saveCharacter({ ...(fields as Partial<CharacterCard>), ...(existing !== undefined ? { id: existing.id } : {}) })
            return { text: `${existing !== undefined ? 'Updated' : 'Created'} character "${card.name}" (${card.id}).\n\n${renderCharacter(card, lang)}`, data: toJson(card) }
          }
          if (args.kind === 'world') {
            const existing = args.ref !== undefined ? await project.findWorld(args.ref) : undefined
            if (args.ref !== undefined && existing === undefined && fields.name === undefined) fields.name = args.ref
            const entry = await project.saveWorld({ ...(fields as Partial<WorldEntry>), ...(existing !== undefined ? { id: existing.id } : {}) })
            return { text: `${existing !== undefined ? 'Updated' : 'Created'} world entry "${entry.name}" (${entry.id}).\n\n${brief(renderWorld(entry, lang), 600)}`, data: toJson(entry) }
          }
          const existing = args.ref !== undefined ? await project.findStyle(args.ref) : undefined
          if (args.ref !== undefined && existing === undefined && fields.name === undefined) fields.name = args.ref
          const style = await project.saveStyle({ ...(fields as Partial<StyleProfile>), ...(existing !== undefined ? { id: existing.id } : {}) })
          if (args.activate === true) await project.updateManifest({ activeStyle: style.id })
          return { text: `${existing !== undefined ? 'Updated' : 'Created'} style "${style.name}" (${style.id})${args.activate === true ? ' and made it the active style' : ''}.`, data: toJson(style) }
        }

        if (args.action === 'delete') {
          if (args.ref === undefined) throw new ProjectError('novel/invalid', '`ref` names the entry to delete')
          const removed = args.kind === 'character' ? await project.deleteCharacter(args.ref) : args.kind === 'world' ? await project.deleteWorld(args.ref) : await project.deleteStyle(args.ref)
          return { text: removed ? `Deleted ${args.kind} "${args.ref}".` : `No ${args.kind} matches "${args.ref}".` }
        }

        if (args.action === 'learn_style') {
          const sample = typeof fields.sample === 'string' ? fields.sample : ''
          const style = await env.job('bible', 'extract style', undefined, async task => await extractStyle(env.core, runtime, {
            sample,
            ...(typeof fields.name === 'string' ? { name: fields.name } : {}),
            ...(args.activate !== undefined ? { activate: args.activate } : {}),
          }, task))
          return { text: `Learned style "${style.name}" (${style.id})${args.activate === true ? ', now active' : ''}: ${[style.tone, style.rhythm].filter(Boolean).join('; ')}`, data: toJson(style) }
        }

        if (args.action === 'derive_visual') {
          if (args.kind !== 'character' || args.ref === undefined) throw new ProjectError('novel/invalid', 'derive_visual works on a character: pass kind=character and `ref`')
          const character = args.ref
          const result = await env.job('bible', `visual anchor ${character}`, character, async task => await deriveVisual(env.core, runtime, { character, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return { text: `Visual anchor of ${result.card.name}: ${result.prompt}${result.negative !== undefined ? `\nNever drawn on them: ${result.negative}` : ''}\nIt is restated in every picture that shows them. Draw their design sheet next (novel_illustrate kind=sheet).`, data: toJson({ prompt: result.prompt, negative: result.negative ?? null }) }
        }

        // expand
        if (args.ref === undefined) throw new ProjectError('novel/invalid', '`ref` names the entry to expand')
        const ref = args.ref
        if (args.kind === 'character') {
          const result = await env.job('bible', `expand ${ref}`, ref, async task => await expandCharacter(env.core, runtime, { character: ref, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return { text: `Expanded "${result.card.name}": filled ${Object.keys(result.changes).join(', ') || 'nothing new'}.\n\n${renderCharacter(result.card, lang)}`, data: toJson(result.card) }
        }
        if (args.kind === 'world') {
          const result = await env.job('bible', `expand ${ref}`, ref, async task => await expandWorld(env.core, runtime, { entry: ref, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return { text: `Expanded "${result.entry.name}".\n\n${brief(renderWorld(result.entry, lang), 900)}`, data: toJson(result.entry) }
        }
        throw new ProjectError('novel/invalid', 'expand works on characters and world entries; use learn_style for styles')
      },
    }),

    novelTool(service, {
      name: 'novel_outline',
      description: [
        'Edit the outline with a list of operations applied in order (each reports its own success):',
        '- {op:"add-chapter", title, volume?, before?, after?, synopsis?, purpose?, pov?, location?, time?, characters?[], threads?[], beats?[], targetWords?, notes?}',
        '- {op:"update-chapter", chapter, title?, …same fields…, status? (idea|outlined|drafted|revised|final)} — an empty string or empty array clears a field',
        '- {op:"move-chapter", chapter, volume?, before?, after?}   - {op:"remove-chapter", chapter}',
        '- {op:"add-volume", title, synopsis?, goal?, before?}   - {op:"update-volume", volume, title?, synopsis?, goal?}   - {op:"move-volume", volume, before?}   - {op:"remove-volume", volume}',
        '- {op:"save-thread", thread?, title?, kind? (foreshadow|mystery|subplot|promise|motif), status? (open|paid|dropped), description?}   - {op:"remove-thread", thread}',
        'Chapters are referenced by id, number or title; characters and threads by id or name. `beats` are strings or {summary, characters?, location?, conflict?, outcome?, emotion?}.',
        'Use it to record decisions the author made; use novel_derive when you want the architect model to propose plot.',
      ].join('\n'),
      mutating: true,
      parameters: {
        ops: { required: true, description: 'Operations, applied in order: an array of objects (a JSON string holding that array works too).', oneOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'string' }] },
      },
      async run(args, env) {
        const runtime = await env.project()
        let ops: unknown = args.ops
        if (typeof ops === 'string') {
          try {
            ops = JSON.parse(ops)
          } catch {
            throw new ProjectError('novel/invalid', '`ops` must be an array of operations, or a JSON string holding one')
          }
        }
        if (!Array.isArray(ops)) throw new ProjectError('novel/invalid', '`ops` must be an array of operations')
        const results = await applyOutlineOps(runtime, ops as OutlineOp[])
        const failed = results.filter(result => !result.ok).length
        return {
          text: `${results.length - failed} of ${results.length} operations applied.\n${results.map(result => `${result.ok ? '✓' : '✗'} ${result.op}: ${result.message}`).join('\n')}`,
          data: toJson(results),
        }
      },
    }),

    novelTool(service, {
      name: 'novel_derive',
      description: [
        'Ask the architect model to develop plot from where the story stands. It reads the bible, the story so far and the open threads.',
        '- kind=chapters: outline the next `count` chapters (default 5) of a volume, following `direction` if given. They are added to the outline unless apply=false.',
        '- kind=beats: break one chapter\'s outline into scene beats (`chapter` required). Do this before novel_write when a chapter only has a synopsis.',
        '- kind=what_if: explore alternative directions for a question in `direction` ("what if she refuses the deal?"). Nothing is changed; bring the branches to the author.',
        '- kind=foundation: develop a raw idea in `direction` into premise, cast, world, volumes and opening chapters (for a project that is still empty).',
      ].join('\n'),
      mutating: args => args.kind !== 'what_if' && args.apply !== false,
      parameters: {
        kind: { type: 'string', required: true, enum: ['chapters', 'beats', 'what_if', 'foundation'] },
        direction: { type: 'string', description: 'Steering from the author, the what-if question, or the idea.' },
        count: { type: 'integer', description: 'chapters: how many (1-12, default 5); what_if: how many branches (2-5, default 3).' },
        chapter: { type: 'string', description: 'beats: which chapter.' },
        volume: { type: 'string', description: 'chapters: which volume to extend (default: the last).' },
        apply: { type: 'boolean', description: 'chapters/beats: write the result into the outline (default true).' },
      },
      async run(args, env) {
        const runtime = await env.project()
        if (args.kind === 'chapters') {
          const result = await env.job('derive', 'derive chapters', undefined, async task => await deriveChapters(env.core, runtime, {
            ...(args.count !== undefined ? { count: args.count } : {}),
            ...(args.direction !== undefined ? { direction: args.direction } : {}),
            ...(args.volume !== undefined ? { volume: args.volume } : {}),
            ...(args.apply !== undefined ? { apply: args.apply } : {}),
          }, task))
          const lines = result.chapters.map((chapter, index) => {
            const added = result.added[index]
            return `${added !== undefined ? `${added.index}. ` : '- '}${chapter.title}${added !== undefined ? ` (${added.id})` : ''}\n   ${brief(chapter.synopsis, 260)}${chapter.beats.length > 0 ? `\n   beats: ${chapter.beats.map(beat => brief(beat.summary, 60)).join(' → ')}` : ''}`
          })
          return {
            text: `${result.added.length > 0 ? `Added ${result.added.length} chapters to the outline` : `Derived ${result.chapters.length} chapters (not applied)`}:\n${lines.join('\n')}${result.rationale !== undefined ? `\n\nRationale: ${result.rationale}` : ''}`,
            data: toJson(result),
          }
        }
        if (args.kind === 'beats') {
          if (args.chapter === undefined) throw new ProjectError('novel/invalid', 'kind=beats needs `chapter`')
          const chapter = args.chapter
          const result = await env.job('derive', 'derive beats', chapter, async task => await deriveBeats(env.core, runtime, {
            chapter,
            ...(args.direction !== undefined ? { direction: args.direction } : {}),
            ...(args.apply !== undefined ? { apply: args.apply } : {}),
          }, task))
          return {
            text: `Beats for chapter ${result.index} "${result.title}"${result.applied ? ' (saved to the outline)' : ' (not applied)'}:\n${result.beats.map((beat, index) => `${index + 1}. ${beat.summary}`).join('\n')}`,
            data: toJson(result),
          }
        }
        if (args.kind === 'what_if') {
          if (args.direction === undefined || args.direction.trim().length === 0) throw new ProjectError('novel/invalid', 'kind=what_if needs the question in `direction`')
          const question = args.direction
          const result = await env.job('derive', 'what-if', undefined, async task => await whatIf(env.core, runtime, { question, ...(args.count !== undefined ? { branches: args.count } : {}) }, task))
          return {
            text: `${result.branches.map((branch, index) => `### ${index + 1}. ${branch.title}\n${branch.development}${branch.consequences.length > 0 ? `\nConsequences: ${branch.consequences.join('; ')}` : ''}${branch.risks !== undefined ? `\nRisks: ${branch.risks}` : ''}${branch.payoff !== undefined ? `\nPayoff: ${branch.payoff}` : ''}`).join('\n\n')}${result.recommendation !== undefined ? `\n\nRecommendation: ${result.recommendation}` : ''}`,
            data: toJson(result),
          }
        }
        if (args.direction === undefined || args.direction.trim().length === 0) throw new ProjectError('novel/invalid', 'kind=foundation needs the idea in `direction`')
        const idea = args.direction
        const result = await env.job('derive', 'foundation', undefined, async task => await buildFoundation(env.core, runtime, { idea }, task))
        return { text: `Foundation written for "${result.title}": ${result.characters} characters, ${result.worldEntries} world entries, ${result.volumes} volumes, ${result.chapters} opening chapters. Walk the author through it (novel_status detail=full) before drafting.`, data: toJson(result) }
      },
    }),
  ]
}

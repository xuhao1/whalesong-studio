// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools for the story bible and the outline. */
import { deriveGrowth } from '../../core/pipelines/growth'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { acceptSuggestion, deriveTies, dismissSuggestion, expandCharacter, expandWorld, extractStyle, tidyWorld } from '../../core/pipelines/bible'
import { applyOutlineOps, type OutlineOp } from '../../core/pipelines/outline'
import { buildFoundation, deriveBeats, deriveChapters, derivedPlan, deriveToLook, enterDerivedPlan, planOfText, settleDerivedPlan, touchBeats, whatIf } from '../../core/pipelines/plot'
import { cleanGuides } from '../../core/pipelines/guides'
import { ProjectError, upsertLooks } from '../../core/project'
import { deriveLook, deriveScenes, deriveVisual } from '../../core/pipelines/illustrate'
import { L, promptLanguage, renderCharacter, renderWorld } from '../../core/render'
import { lifeLine } from '../../shared/life'
import type { NovelService } from '../../host/service'
import { TIE_ENDS, TIE_KINDS, type Tie, type TieEnd, type TieKind } from '../../shared/ties'
import { WORLD_EVENT_KINDS, withTurnPictures, type CharacterCard, type DerivedChapter, type StyleProfile, type WorldEntry, type WorldEvent } from '../../shared/types'
import { groupOf } from '../../shared/world'
import { brief, listOf, listParameter, novelTool, picturesSaid, referencesSaid, toJson } from './shared'

const CHARACTER_FIELDS = 'name, aliases[], role (protagonist|deuteragonist|antagonist|supporting|minor|cameo), tagline, gender, age, appearance (how they look, one paragraph in the language of the book: the age they seem, build, face, hair, usual clothing, what they carry — the writer writes them by it and every picture of them is drawn by it; there is no separate text for image models), personality, background, motivation, flaw, arc, voice, abilities, secrets, persona {traits[{name,level 1-5}], values[], speech[], taboos[], underPressure}, relationships[{target, kind, note}], tags[], visual {negative (what must not be drawn on them), looks[{name, prompt (what the outfit changes), when (when it is worn)}] — looks are added or updated by name and the others stay; {name, remove: true} takes one away; their design sheets are drawn with novel_illustrate kind=sheet look=…; face (the portrait the author chose to stand for them: a path among visual.portraits — "" lets go of the choice) and mainSheet (the design sheet the author chose as the main one: a path among visual.sheets, where every sheet kept of them is listed — "" lets go of it; which sheet belongs to a stretch of their life is said on the stage, stages[].visual.sheet). Choose either only when the author says which}, voiceProfile {voice, instructions, designPrompt}, life (what they go through in the book, in a paragraph), notes. A card has no status: where somebody comes on, is away, leaves or dies is read off the chapter digests, along each line of the plot'
const WORLD_FIELDS = 'name, aliases[], category (setting|location|faction|system|item|history|culture|rule|term|other — location, faction and item are a place, a house or organization, a thing, each with a page of its own; everything else is an idea of the world), importance (1 core canon always in context | 2 normal | 3 detail — how its text travels with requests, not how much it matters), weight (core|major|minor|once — how much of the story it carries; leave it out and it is counted from the chapters that name it), summary, body (Markdown), related[], tags[], visualPrompt (how it looks, for its design art), visualMain (the design picture the author chose as the main one: a path among visualImages, where every design picture kept of it is listed — a picture drawn again joins them and takes none away; "" lets go of the choice. Choose only when the author says which), events[{chapter (id or number), kind (begin|change|decline|end), what}] — its course over the story: built, changed hands, fallen to ruin, destroyed; the list given replaces the one there (a turn kept keeps the picture drawn of it — novel_illustrate with event draws one)'
/** How a tie reads between its two ends, for the book's record. */
const TIE_WORDS: Record<TieKind, [string, string]> = {
  within: ['位于', 'is in'],
  seat: ['坐落在', 'has its seat at'],
  member: ['属于', 'belongs to'],
  resides: ['住在', 'lives at'],
  holds: ['持有', 'holds'],
}

const STYLE_FIELDS = 'name, pov (first|third-limited|third-omniscient|second|multi), tense (past|present), register (the kind of language: classical, the vernacular of the old novels, modern prose… with its markers), tone, diction, rhythm, imagery, dialogue, pacing, rules[], avoid[], exemplars[{label,text}], body'

export function bibleTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_bible',
      description: [
        'Maintain the story bible: characters, world entries and style profiles.',
        '- action=save creates or updates one entry: pass only the fields that change; an empty string clears a field. `ref` names the entry to update (id, name or alias); omit it to create.',
        '- action=delete removes an entry.',
        '- action=merge (kind=world) makes several entries one — the same place, house or thing written down under different names: `ref` is the entry that stays, `fields.fold` lists the others (ids or names). Their names become its other names, their text is kept under their name in its own, and every tie, scene mark and picture that was theirs is its.',
        '- action=ties lists how the things of the world stand to each other — what is in what, where a house has its seat, who belongs to which house, lives where, holds what, each with the chapters it holds for — all of them, or those that name `ref`.',
        '- action=tie writes one down (or says one again, to set its chapters or note): fields {kind: within (a place in a place, a branch in a house) | seat (a house at a place) | member (a character of a house) | resides (a character at a place) | holds (a character holds a thing), from, to (names or ids), since, until (chapter ids or numbers; left out: from the start, for good), note}. action=untie takes one away: `ref` is its id, or fields {kind, from, to}.',
        '- action=derive_ties has the planner work the ties and the course of places and things out from the bible and the digests (`direction` steers it); ties that are there stay unless it finds them wrong. action=tidy (kind=world) has the planner look over the entries for the same thing written down twice and for entries in the wrong category: it proposes, nothing is changed — act on what you agree with by merge and save, after telling the author.',
        '- action=pin (kind=world) puts the mark of something that stands in a place onto that place\'s picture, as the viewer shows it: `ref` is the place (or house) whose picture it is, fields {mark: the place, house or character marked, x, y} with x and y from 0 (left, top) to 1 (right, bottom); fields {mark, clear: true} lets that mark be laid out by itself again, fields {clear: true} all of them. Marks are laid out by themselves until pinned.',
        '- action=mark_life (kind=character) writes down something of a character\'s life the digests do not have, or have wrong: `ref` is the character, fields {chapter (id or number; left out: before the story begins — only for somebody dead or gone before the first page), kind: enter | return | exit (leaves the story for good) | death, what (a few words), line (the plot line a chapter number counts along; left out: the main one)}. It holds over what the digest of that chapter says, on every line that chapter is read on; one mark a chapter. fields {chapter, clear: true} takes a mark back. Use it for what the author tells you, not for what a digest would find by itself — digest the chapter for that.',
        '- action=expand lets the architect model flesh out a character or world entry in agreement with the written text (`direction` steers it).',
        '- action=derive_visual (kind=world) has the director write down how a place or a thing looks, from what the book says of it, and keeps it on the entry (visualPrompt): its design art is drawn from that, and it is done by itself the first time such art is drawn (`direction` steers it). It is written with the book\'s art direction in hand: where that fixes a period or a form (buildings and objects of which dynasty or fashion), the look is written in that form, also where the text has another.',
        '- action=derive_visual (kind=character) has the director write down how a character looks — `appearance`, one paragraph in the book\'s language — and what must not be drawn on them (visual.negative), and keeps both on the card (`direction` steers it). There is one text of how somebody looks: the writer writes them by it and every picture of them is drawn by it; there is no separate "visual anchor" for image models (a card of an earlier version that still has one, visual.prompt, has it folded into the appearance by this action — pictures go by it until then). Where a card says nothing of looks, a picture has the director write the appearance first. It is written with the book\'s art direction in hand: where that fixes a period or a form of dress (hair and clothing of which dynasty or fashion), the appearance is written in that form, over what the source text says — the art direction itself comes last in a prompt and cannot overrule a description that says otherwise. An appearance already written does not follow a changed art direction by itself: after changing fields.artStyle, have the appearances (and the looks of places and things) it touches written again, then draw the sheets again.',
        '- A book may hold several lines of the plot in one world. `fields.lines` on a character or a world entry names the lines it belongs to (ids as novel_status lists them; `main` for the main line): left out, a person belongs to the lines whose chapters have them (every line while none does) and a world entry to every line — the world the lines share; named, it is kept to those lines and out of what the writer of any other line is told. A digest says of each new thing whether it is of the story it was found in alone or of the world: its suggestion says so, and accepted, a thing of one story is filed under the lines that read that chapter. Set `lines` (or action=file for a batch) when the author says somebody or something is of one story only.',
        '- action=derive_growth (`ref` = character) has the planner read how that character changes along the book and keeps it on the card as stages (fields.stages: id, title, from = the chapter it begins with, age, what turned, appearance and persona where they differ, visual): how old they are as they enter, and each point where they turn — years older, another station, another look. `direction` guides it. A card\'s `age` and `appearance` say how they are in general; a stage says how they are from a chapter on — the writer is told the one that holds at its chapter, and pictures of a chapter show them so.',
        '- action=derive_scene (`ref` = character) has the director find, in the book, the moments that character is remembered by — their signature scenes (for Lin Daiyu, burying the flowers first) — and keeps them on the card (fields.visual.scenes: id, title, chapter, text, why), the most their own first, each written as a picture in the book\'s language. `direction` guides it (a moment the author wants in, a kind they want left out). A portrait shows one of them: the first, the one fields.visual.sceneAt names, or the one novel_illustrate is given. What a book\'s pictures may show is the author\'s to say (the book\'s avoid list, or what they ask): rule no kind of moment out on your own.',
        '- action=learn_style (kind=style) distills a style profile from a sample passage in fields.sample.',
        '- action=file files a batch under lines of the plot at once: fields = { lines: [line ids, `main` for the main line], characters: [ids or names], world: [ids or names] }. Those lines and no other; `lines: []` takes the filing back. Or fields = { by_text: true, … }: each under the lines it is found on (an entry where the text names it, a person where the chapters have them) — what is on every line or on none is left unfiled, and the result lists it. Filing an entry keeps it from the other lines\' writers: tell the author what moved.',
        '- action=accept_suggestion / dismiss_suggestion settle a suggestion that digest left (ids are listed by novel_status).',
        `Character fields: ${CHARACTER_FIELDS}.`,
        `World fields: ${WORLD_FIELDS}.`,
        `Style fields: ${STYLE_FIELDS}. Pass activate=true to make a style the one the writer uses.`,
        'Changing a character or the world after chapters are written can contradict them: search the manuscript (novel_search) and plan the follow-up revisions with the author.',
      ].join('\n'),
      mutating: true,
      parameters: {
        action: { type: 'string', required: true, enum: ['save', 'delete', 'merge', 'file', 'ties', 'tie', 'untie', 'derive_ties', 'tidy', 'pin', 'mark_life', 'expand', 'derive_visual', 'derive_scene', 'derive_growth', 'learn_style', 'accept_suggestion', 'dismiss_suggestion'] },
        kind: { type: 'string', enum: ['character', 'world', 'style'], description: 'Required except for the suggestion actions and the actions on ties (ties, tie, untie, derive_ties).' },
        ref: { type: 'string', description: 'Entry id or name; the suggestion id for the suggestion actions.' },
        fields: { type: 'object', additionalProperties: true, description: 'Fields to set (save), or {sample, name} for learn_style.' },
        direction: { type: 'string', description: 'For expand and derive_ties: what to develop, change or look at. For derive_scene: what the author wants of the list.' },
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
        // ── how the things of the world stand to each other ──
        const named = async (end: TieEnd): Promise<string> => (end.type === 'character' ? (await project.findCharacter(end.id))?.name : (await project.findWorld(end.id))?.name) ?? end.id
        const chapterOf = async (value: unknown): Promise<string | undefined> => {
          const ref = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
          if (ref.length === 0) return undefined
          const found = await project.findChapter(ref)
          if (found === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${ref}"`)
          return found.plan.id
        }
        const said = async (tie: Tie): Promise<string> => {
          const index = async (id: string | undefined): Promise<number | undefined> => (id !== undefined ? (await project.findChapter(id))?.index : undefined)
          const [since, until] = [await index(tie.since), await index(tie.until)]
          const span = since !== undefined && until !== undefined ? ` (ch. ${since}–${until})` : since !== undefined ? ` (from ch. ${since})` : until !== undefined ? ` (until ch. ${until})` : ''
          return `${await named(tie.from)} —${tie.kind}→ ${await named(tie.to)}${span}${tie.note !== undefined ? ` — ${tie.note}` : ''} [${tie.id}]`
        }
        const endsOf = (kind: string): { from: TieEnd['type']; to: TieEnd['type'] } => {
          if (!(TIE_KINDS as readonly string[]).includes(kind)) throw new ProjectError('novel/invalid', `fields.kind is one of ${TIE_KINDS.join(', ')}`)
          return TIE_ENDS[kind as TieKind]
        }
        if (args.action === 'ties') {
          const all = await project.ties()
          const about = args.ref !== undefined ? (await project.findCharacter(args.ref))?.id ?? (await project.findWorld(args.ref))?.id : undefined
          if (args.ref !== undefined && about === undefined) throw new ProjectError('novel/not-found', `nobody and nothing matches "${args.ref}"`)
          const listed = about !== undefined ? all.filter(tie => tie.from.id === about || tie.to.id === about) : all
          // Looking is no change: it stays off the book's record.
          if (listed.length === 0) return { text: about !== undefined ? `Nothing is written down of how "${args.ref}" stands to anything.` : 'No ties are written down yet. action=derive_ties has the planner work them out; action=tie writes one.', record: false }
          const lines = await Promise.all(listed.map(said))
          return { text: `${listed.length} ties${about !== undefined ? ` name "${args.ref}"` : ''}:\n${lines.join('\n')}`, data: toJson(listed), record: false }
        }
        if (args.action === 'tie') {
          const kind = typeof fields.kind === 'string' ? fields.kind : ''
          const ends = endsOf(kind)
          if (typeof fields.from !== 'string' || typeof fields.to !== 'string') throw new ProjectError('novel/invalid', 'fields.from and fields.to name what the tie connects')
          const [since, until] = [await chapterOf(fields.since), await chapterOf(fields.until)]
          const tie = await project.saveTie({ kind: kind as TieKind, from: { type: ends.from, id: fields.from }, to: { type: ends.to, id: fields.to }, ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(typeof fields.note === 'string' ? { note: fields.note } : {}) })
          const [who, where] = [await named(tie.from), await named(tie.to)]
          return { text: `Written down: ${await said(tie)}`, data: toJson(tie), record: { summary: [`记下关系：${who} ${TIE_WORDS[tie.kind][0]} ${where}`, `Wrote down a tie: ${who} ${TIE_WORDS[tie.kind][1]} ${where}`] } }
        }
        if (args.action === 'untie') {
          let id = args.ref
          if (id === undefined) {
            const kind = typeof fields.kind === 'string' ? fields.kind : ''
            const ends = endsOf(kind)
            const resolve = async (type: TieEnd['type'], ref: unknown): Promise<string | undefined> => (typeof ref !== 'string' ? undefined : type === 'character' ? (await project.findCharacter(ref))?.id : (await project.findWorld(ref))?.id)
            const [from, to] = [await resolve(ends.from, fields.from), await resolve(ends.to, fields.to)]
            id = (await project.ties()).find(tie => tie.kind === kind && tie.from.id === from && tie.to.id === to)?.id
            if (id === undefined) return { text: 'No such tie is written down.', record: false }
          }
          const gone = (await project.ties()).find(tie => tie.id === id)
          const removed = await project.removeTie(id)
          if (!removed || gone === undefined) return { text: `No tie "${id}".`, record: false }
          const [who, where] = [await named(gone.from), await named(gone.to)]
          return { text: `Taken away: ${who} —${gone.kind}→ ${where} (${id}).`, record: { summary: [`去掉关系：${who} ${TIE_WORDS[gone.kind][0]} ${where}`, `Took a tie away: ${who} ${TIE_WORDS[gone.kind][1]} ${where}`] } }
        }
        if (args.action === 'derive_ties') {
          const done = await env.job('bible', 'ties', undefined, async task => await deriveTies(env.core, runtime, typeof args.direction === 'string' && args.direction.trim().length > 0 ? { direction: args.direction.trim() } : {}, task))
          return {
            text: `The planner worked the ties out: ${done.added} written down, ${done.changed} changed, ${done.removed} taken away, ${done.total} in all; ${done.events} things noted that happen to a place, a house or a thing.${done.created.length > 0 ? ` Entries the ties needed and the bible lacked were made: ${done.created.join(', ')}.` : ''}${done.skipped.length > 0 ? ` Could not be written down: ${done.skipped.slice(0, 6).join('; ')}${done.skipped.length > 6 ? '…' : ''}.` : ''} Look them over with action=ties — the planner is not always right about what is in what.`,
            data: toJson(done),
          }
        }
        if (args.action === 'tidy') {
          const found = await env.job('bible', 'tidy world', undefined, async task => await tidyWorld(env.core, runtime, task))
          const same = found.same.map(item => `- the same thing: keep "${item.keep.name}", fold in ${item.others.map(other => `"${other.name}"`).join(', ')}${item.why !== undefined ? ` — ${item.why}` : ''}`)
          const kinds = found.kinds.map(item => `- "${item.name}": ${item.from} → ${item.to}${item.why !== undefined ? ` — ${item.why}` : ''}`)
          return {
            text: same.length + kinds.length === 0
              ? `The planner looked over ${found.entries} entries and proposes nothing.`
              : `The planner looked over ${found.entries} entries and proposes (nothing is changed yet — it is not always right; tell the author, then merge with action=merge and move with action=save fields.category):\n${[...same, ...kinds].join('\n')}`,
            data: toJson(found),
            // A proposal changes nothing.
            record: false,
          }
        }
        if (args.kind === undefined) throw new ProjectError('novel/invalid', '`kind` is required: character, world or style')

        if (args.action === 'pin') {
          if (args.kind !== 'world' || args.ref === undefined) throw new ProjectError('novel/invalid', 'pin is for a place or a house (kind=world): `ref` names the one whose picture it is')
          const place = await project.findWorld(args.ref)
          if (place === undefined) throw new ProjectError('novel/not-found', `no world entry matches "${args.ref}"`)
          if (fields.mark === undefined) {
            if (fields.clear !== true) throw new ProjectError('novel/invalid', 'fields.mark names what is marked; fields {clear: true} alone lets every mark of the picture go')
            await project.saveWorld({ id: place.id, spots: null } as never)
            return { text: `Every mark on the picture of "${place.name}" is laid out by itself again.`, record: { summary: [`《${place.name}》画面上的按钮全部恢复自动排布`, `Let every mark on the picture of "${place.name}" be laid out by itself`] } }
          }
          const mark = typeof fields.mark === 'string' ? fields.mark : ''
          const who = await project.findCharacter(mark)
          const what = who === undefined ? await project.findWorld(mark) : undefined
          if (who === undefined && what === undefined) throw new ProjectError('novel/not-found', `nobody and nothing matches "${mark}"`)
          const key = who !== undefined ? `character:${who.id}` : `world:${what!.id}`
          const name = who?.name ?? what!.name
          if (fields.clear === true) {
            await project.saveWorld({ id: place.id, spots: { [key]: null } } as never)
            return { text: `The mark of "${name}" on the picture of "${place.name}" is laid out by itself again.`, record: { summary: [`《${place.name}》画面上「${name}」的按钮恢复自动排布`, `Let the mark of "${name}" on the picture of "${place.name}" be laid out by itself`] } }
          }
          const fraction = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 1000) / 1000 : undefined)
          const [x, y] = [fraction(fields.x), fraction(fields.y)]
          if (x === undefined || y === undefined) throw new ProjectError('novel/invalid', 'fields.x and fields.y say where on the picture, each from 0 (left, top) to 1 (right, bottom)')
          const stands = (await project.ties()).some(tie => tie.to.id === place.id && tie.from.id === (who?.id ?? what!.id))
          await project.saveWorld({ id: place.id, spots: { [key]: { x, y } } } as never)
          return { record: { summary: [`在《${place.name}》的画面上摆了「${name}」的位置`, `Pinned the mark of "${name}" on the picture of "${place.name}"`] }, text: `Pinned the mark of "${name}" at ${x}, ${y} of the picture of "${place.name}".${place.visualImage === undefined ? ' The place has no design art yet: the mark shows once it has (novel_illustrate kind=scene).' : ''}${stands ? '' : ` Nothing says "${name}" stands in "${place.name}" — a mark shows only for what is tied to the place (action=tie).`}` }
        }

        if (args.action === 'mark_life') {
          if (args.ref === undefined) throw new ProjectError('novel/invalid', 'action=mark_life needs `ref`: the character')
          const kind = fields.kind === 'enter' || fields.kind === 'return' || fields.kind === 'exit' || fields.kind === 'death' ? fields.kind : undefined
          if (kind === undefined && fields.clear !== true) throw new ProjectError('novel/invalid', 'fields.kind is enter, return, exit or death — or fields.clear: true takes the mark of that chapter back')
          const chapter = typeof fields.chapter === 'string' || typeof fields.chapter === 'number' ? fields.chapter : undefined
          const line = typeof fields.line === 'string' && fields.line.trim().length > 0 ? fields.line.trim() : undefined
          const card = await project.markLife(args.ref, {
            ...(chapter !== undefined && String(chapter).trim().length > 0 && String(chapter).trim() !== 'before' ? { chapter } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(typeof fields.what === 'string' ? { what: fields.what } : {}),
            ...(line !== undefined ? { line } : {}),
          })
          // Their life as it reads now, along the line the mark was counted on.
          const now = lifeLine((await project.lives(line)).lives[card.id], lang === 'zh') ?? L(lang, '正文里还没有出场', 'not on the page yet')
          const where = chapter !== undefined && String(chapter).trim() !== 'before' ? `chapter ${chapter}` : 'before the story begins'
          return {
            text: kind !== undefined ? `Written down for ${card.name}, ${where}: ${kind}. Their life now reads: ${now}` : `The mark for ${card.name}, ${where}, is taken back. Their life now reads: ${now}`,
            data: toJson(card.lifeMarks ?? []),
            record: { summary: kind !== undefined ? [`在「${card.name}」的履历里记了一笔`, `Wrote a mark into the life of ${card.name}`] : [`从「${card.name}」的履历里去掉了一笔`, `Took a mark out of the life of ${card.name}`] },
          }
        }
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
            // A card changed after its character is on the page can contradict the page: say how much page there is.
            const canon = ['name', 'aliases', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'relationships', 'status', 'voice', 'persona'].filter(key => fields[key] !== undefined)
            const seen = existing !== undefined && canon.length > 0 ? (await project.presence()).find(entry => entry.character === card.id)?.chapters ?? [] : []
            const impact = seen.length > 0 ? `\n\nOn the page already: ${card.name} appears in ${seen.length} written chapter(s) (${seen.slice(0, 8).join(', ')}${seen.length > 8 ? ', …' : ''}), and you changed ${canon.join(', ')}. The text may now disagree with the card — search it (novel_search), tell the author what you find, and fix it by novel_edit (a word, a fact) or novel_revise (a scene).` : ''
            return { text: `${existing !== undefined ? 'Updated' : 'Created'} character "${card.name}" (${card.id}).${impact}\n\n${renderCharacter(card, lang)}`, data: toJson(card) }
          }
          if (args.kind === 'world') {
            const existing = args.ref !== undefined ? await project.findWorld(args.ref) : undefined
            if (args.ref !== undefined && existing === undefined && fields.name === undefined) fields.name = args.ref
            // Its course is told by the book's own chapters: a number or a title is put right, a chapter nobody has is said.
            if (Array.isArray(fields.events)) {
              const course: WorldEvent[] = []
              for (const item of fields.events as Record<string, unknown>[]) {
                const kind = WORLD_EVENT_KINDS.find(candidate => candidate === item?.kind)
                const what = typeof item?.what === 'string' ? item.what.trim() : ''
                if (kind === undefined || what.length === 0) throw new ProjectError('novel/invalid', `each of fields.events is {chapter, kind (${WORLD_EVENT_KINDS.join('|')}), what}`)
                const chapter = await chapterOf(item.chapter)
                if (chapter === undefined) throw new ProjectError('novel/invalid', 'each of fields.events names the chapter it happens in')
                course.push({ chapter, kind, what })
              }
              // The list replaces the words; a turn kept keeps the picture drawn of it — nobody means to throw a picture away by rewording.
              fields.events = withTurnPictures(course, existing?.events)
            }
            const entry = await project.saveWorld({ ...(fields as Partial<WorldEntry>), ...(existing !== undefined ? { id: existing.id } : {}) })
            return { text: `${existing !== undefined ? 'Updated' : 'Created'} world entry "${entry.name}" (${entry.id}).\n\n${brief(renderWorld(entry, lang), 600)}`, data: toJson(entry) }
          }
          const existing = args.ref !== undefined ? await project.findStyle(args.ref) : undefined
          if (args.ref !== undefined && existing === undefined && fields.name === undefined) fields.name = args.ref
          const style = await project.saveStyle({ ...(fields as Partial<StyleProfile>), ...(existing !== undefined ? { id: existing.id } : {}) })
          if (args.activate === true) await project.updateManifest({ activeStyle: style.id })
          return { text: `${existing !== undefined ? 'Updated' : 'Created'} style "${style.name}" (${style.id})${args.activate === true ? ' and made it the active style' : ''}.`, data: toJson(style) }
        }

        if (args.action === 'file') {
          // A batch under lines of the plot at once: what the author would otherwise tick card by card.
          const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [])
          const filed = await project.assignLines({ lines: list(fields.lines), ...(fields.by_text === true ? { byText: true } : {}), characters: list(fields.characters), world: list(fields.world) })
          const count = filed.characters.length + filed.world.length
          if (count === 0 && (filed.left ?? []).length === 0) return { text: 'Nothing was filed: name the cards under fields.characters and the entries under fields.world (ids or names).', record: false }
          return { text: `${fields.by_text === true ? 'Filed by where the text has them' : filed.lines.length > 0 ? `Filed under ${filed.lines.join(', ')} and no other line` : 'No longer filed under any line'}: ${[...filed.characters, ...filed.world].join(', ') || 'nothing'}.${(filed.left ?? []).length > 0 ? ` Left as they were (on every line, or on none yet): ${filed.left!.join(', ')}.` : ''}`, data: toJson(filed) }
        }

        if (args.action === 'merge') {
          if (args.kind !== 'world') throw new ProjectError('novel/invalid', 'merge is for world entries (kind=world); the cast is merged from the overview page')
          if (args.ref === undefined) throw new ProjectError('novel/invalid', '`ref` names the entry that stays')
          const fold = Array.isArray(fields.fold) ? fields.fold.filter((item): item is string => typeof item === 'string') : typeof fields.fold === 'string' ? [fields.fold] : []
          const merged = await project.mergeWorld(args.ref, fold)
          return { text: `Folded ${merged.folded.map(name => `"${name}"`).join(', ')} into "${merged.entry.name}" (${merged.entry.id}); ${merged.ties} ties now name it.`, data: toJson(merged.entry) }
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

        if (args.action === 'derive_growth') {
          if (args.ref === undefined) throw new ProjectError('novel/invalid', 'derive_growth finds the stretches of a character\'s life: `ref` names the character')
          const character = args.ref
          const result = await env.job('bible', `growth ${character}`, character, async task => await deriveGrowth(env.core, runtime, { character, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return result.stages.length > 0
            ? { text: `The stretches of ${result.card.name}'s life in the book, as the planner read them:\n${result.stages.map((stage, at) => `${at + 1}. [${stage.id}] ${stage.title}${stage.age !== undefined ? ` — ${stage.age}` : ''}${stage.from !== undefined ? ` — from ${stage.from}` : ' — as they enter'}${stage.what !== undefined ? `: ${stage.what}` : ''}${stage.appearance !== undefined ? `\n   look: ${stage.appearance}` : ''}${stage.persona !== undefined ? `\n   who: ${stage.persona}` : ''}`).join('\n')}\nThey are kept on the card (stages); the author can rewrite them there. The writer is told which one holds at the chapter being written, and pictures of a chapter show them as that stretch has them; a stretch that looks different wants its own design sheet (novel_illustrate kind=sheet stage=<id>). Tell the author what was found.`, data: toJson({ stages: result.stages }), record: { summary: [`策划理出了「${result.card.name}」的 ${result.stages.length} 个时期`, `The planner found ${result.stages.length} stretch(es) of ${result.card.name}'s life`] } }
            : { text: `The planner found nothing to say of how ${result.card.name} changes through the book; the card is as it was.`, record: false }
        }
        if (args.action === 'derive_scene') {
          if (args.ref === undefined) throw new ProjectError('novel/invalid', 'derive_scene finds the moments a character is remembered by: `ref` names the character')
          const character = args.ref
          const result = await env.job('bible', `signature scenes ${character}`, character, async task => await deriveScenes(env.core, runtime, { character, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return result.scenes.length > 0
            ? { text: `The moments ${result.card.name} is remembered by, as the director found them in the book, the most their own first:\n${result.scenes.map((scene, at) => `${at + 1}. [${scene.id}] ${scene.title}: ${scene.text}${scene.why !== undefined ? ` (${scene.why})` : ''}`).join('\n')}\nThey are kept on the card (visual.scenes); the author can rewrite, reorder, add and remove them there. A portrait asked for nothing shows the first (or the one visual.sceneAt names); novel_illustrate kind=portrait scene=<id> draws another. Tell the author which moments they are.`, data: toJson({ scenes: result.scenes }), record: { summary: [`导演给「${result.card.name}」找了 ${result.scenes.length} 个名场面`, `The director found ${result.scenes.length} signature scene(s) of ${result.card.name}`] } }
            : { text: `The director found no moment in the book yet that stands for ${result.card.name}${result.why !== undefined ? `: ${result.why}` : ''}. The card is as it was; a portrait of them is plain (facing the viewer, plain ground) until there is one — or write the scenes yourself (fields.visual.scenes).`, data: toJson({ scenes: [], why: result.why ?? null }), record: false }
        }
        if (args.action === 'derive_visual' && args.kind === 'world') {
          if (args.ref === undefined) throw new ProjectError('novel/invalid', '`ref` names the place or the thing')
          const ref = args.ref
          const result = await env.job('bible', `look ${ref}`, ref, async task => await deriveLook(env.core, runtime, { entry: ref, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return { text: `How "${result.entry.name}" looks, as the director wrote it down from the book: ${result.look}\nIt is what its design art is drawn from (novel_illustrate kind=${groupOf(result.entry.category) === 'items' ? 'item' : 'location'}) and what every picture that shows it carries along; the author can change it on the entry's page.`, data: toJson(result.entry), record: { summary: [`导演写下了「${result.entry.name}」的样子`, `The director wrote down how "${result.entry.name}" looks`] } }
        }
        if (args.action === 'derive_visual') {
          if (args.kind !== 'character' || args.ref === undefined) throw new ProjectError('novel/invalid', 'derive_visual works on a character or on a place or thing of the world: pass kind and `ref`')
          const character = args.ref
          const result = await env.job('bible', `appearance ${character}`, character, async task => await deriveVisual(env.core, runtime, { character, ...(args.direction !== undefined ? { direction: args.direction } : {}) }, task))
          return { text: `How ${result.card.name} looks, as the director wrote it down (it is their appearance now, on the card): ${result.appearance}${result.negative !== undefined ? `\nNever drawn on them: ${result.negative}` : ''}\nThe writer writes them by it and every picture of them is drawn by it; it was written in the form the book's art direction fixes, where it fixes one. Draw their design sheet next (novel_illustrate kind=sheet) — again, if they have one: pictures follow the sheet, and the sheet follows these words.`, data: toJson({ appearance: result.appearance, negative: result.negative ?? null }) }
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
        '- {op:"add-chapter", title, volume?, before?, after?, line?, synopsis?, purpose?, pov?, location?, time?, characters?[], threads?[], beats?[], targetWords?, notes?} — targetWords is a length recommended for the chapter: set it only when the author names one (0 takes it away); without one the writer judges',
        '- {op:"update-chapter", chapter, title?, …same fields…, status? (idea|outlined|drafted|revised|final)} — an empty string or empty array clears a field',
        '- {op:"move-chapters", chapters:[…], line?, volume?, before?, after?, title?, from?}: move a run of chapters, in their order, to another place in the plot — elsewhere on their line, onto another line (`line`: its id or title, `main` for the main one), or onto a line opened for them (`line:"new"` with its `title`, and `from`: the chapter it leaves after — left out, it is a story of its own from the first page). This is how a side story that sits among the main line\'s chapters is parted from it, and how the plot is re-wired: lines that leave after a moved chapter, or arrive at one, follow it. Refused, with nothing moved, where it would tie a line into a knot (a line leaving after one of its own chapters). Where a line leaves is changed with update-line `from` (null: nowhere — a story of its own).',
        '- {op:"move-chapter", chapter, volume?, before?, after?, line?}   - {op:"remove-chapter", chapter}   - {op:"restore-chapter", chapter} (a removed chapter is kept, with its text and what was made from it, and comes back where it stood)',
        '- Lines of the plot — other ways the story goes, beside the main line (the volumes): {op:"add-line", title, from? (the chapter it leaves after), choice? (what is decided there to go this way), premise?}   - {op:"update-line", line, title?, premise?, choice?, shelved? (put aside / taken up again), from?, into? (the chapter of another line it arrives at — from there the two are one story; null: nowhere)}   - {op:"promote-line", line} makes it the main line: what the main line had in its place is kept as a line   - {op:"remove-line", line} removes it with its chapters. A chapter is added to a line with add-chapter line=…; a line is named by its id or its title.',
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
        '- kind=chapters: outline the next `count` chapters (default 5; any number the author asks for — they are derived ten at a time, each round from where the last left off) following `direction` if given. They are added to the outline unless apply=false. Where they go: at the end of the main line by default; `line` names another line of the plot; `after` the chapter they follow. `mode` says what becomes of what is there after that chapter already — append (default) adds; replace puts the new chapters in its place (chapters that are written are never thrown away: they are kept as a line put aside); branch leaves it as it is and opens a new line for the new chapters (`title` names it, `choice` says what is decided to go that way). When the author wants the story to go differently from some chapter on, ask which they mean — replace, or a line of its own — unless they said.',
        '  With apply=false the chapters are not added: the plan waits with the book to be looked at — one plan at a time, and the Outline page of the Studio shows the same one. Then, as the author decides: `waiting=add` puts it into the outline as it stands, `waiting=discard` drops it, `waiting=show` reads it again. When the author has something to say of the plan that waits — whoever derived it, you or they on the page — pass their words as `feedback`: the planner that derived it adjusts that plan, in the conversation it derived it in with all it read there while it is still at hand (about half an hour; after that a planner is handed the plan and the words), changing what they spoke of and handing the rest back as it was; the adjusted plan waits in its place and the result says which planner it was. Do not derive anew to change a plan that waits. With `feedback` the plan stays what it was derived for (its line, volume and direction); `count` and the rest are not used.',
        '  `pictures`: pictures of the book the author gave to steer these chapters by (project-relative paths). The planner looks at them — or is told what they show by the model set up to look at pictures (novel_settings: vision); with neither, it goes by what each picture is called, and the result says so — and works them in; the chapter that goes by a picture keeps it on its plan (`guides`), where whoever writes it finds it. Only pictures the author pointed at.',
        '- kind=beats: break one chapter\'s outline into scene beats (`chapter` required). Do this before novel_write when a chapter only has a synopsis.',
        '  With from_text=true, for a chapter that is written: its beats are read off its text as it now stands, in place of the ones planned. Only the beats change, and they are read anew — a beat a scene, from the first to the last; the plan as it was stays in its history. `direction` is not used.',
        '- kind=beat: one beat, not all of them. `chapter` and, in `direction`, what the author says. With `beats` (their numbers in the chapter, or ids): those beats are changed by the sentence and no other is touched (one that goes into another, or goes, is taken out). Without `beats`: one beat is added, made from the sentence — `after` = the number of the beat it follows, `start` or `end`; left out, the planner puts it where it belongs. This is the way when the author wants one thing of a chapter\'s beats different ("add a beat where she finds the letter", "in beat 3 he refuses instead"): kind=beats lays every beat out anew and loses the ones they were content with.',
        '- kind=plan: for a chapter that is written (`chapter` required), set its plan by its text — synopsis, what the chapter is for, place, time, point of view, cast and beats, all read off the text anew — after the text was written differently from its plan or edited by the author. Whoever works from the plan afterwards (a writer rewriting the chapter, the director, the planner deriving what follows) then reads what was written. What the text does not say of place or time stays as planned; the notes for the writer and the threads are not touched; the plan as it was stays in its history. The Studio does this by itself once a chapter that was digested before is changed — a revision accepted, the chapter rewritten or edited — unless the author switched that off (novel_settings: planFollowsText); ask for it here when a plan is behind all the same.',
        '- kind=what_if: explore alternative directions for a question in `direction` ("what if she refuses the deal?"). Nothing is changed; bring the branches to the author.',
        '- kind=foundation: develop a raw idea in `direction` into premise, cast, world, volumes and opening chapters (for a project that is still empty).',
      ].join('\n'),
      mutating: args => args.kind !== 'what_if' && args.apply !== false && args.feedback === undefined && args.waiting !== 'show' && args.waiting !== 'discard',
      parameters: {
        kind: { type: 'string', required: true, enum: ['chapters', 'beats', 'beat', 'plan', 'what_if', 'foundation'] },
        direction: { type: 'string', description: 'Steering from the author, the what-if question, or the idea.' },
        count: { type: 'integer', description: 'chapters: how many (default 5); what_if: how many branches (2-5, default 3).' },
        line: { type: 'string', description: 'chapters: the line of the plot to go on with (id or name). Default: the main line.' },
        after: { type: 'string', description: 'chapters: the chapter the new ones follow. Default: the end of the line — for replace and branch, the last chapter that is written. beat (adding one): the number of the beat it follows, `start` or `end`; left out: where it belongs.' },
        beats: listParameter('beat: the beats to change, by their numbers in the chapter (or ids). Left out: a beat is added.'),
        mode: { type: 'string', enum: ['append', 'replace', 'branch'], description: 'chapters: what becomes of what follows `after` already.' },
        title: { type: 'string', description: 'chapters, mode=branch: the new line\'s name.' },
        choice: { type: 'string', description: 'chapters, mode=branch: what is decided, where the lines part, to go this way.' },
        chapter: { type: 'string', description: 'beats, beat, plan: which chapter.' },
        from_text: { type: 'boolean', description: 'beats: read them off the chapter\'s text as written (the chapter has to have text) instead of deriving them from its plan.' },
        volume: { type: 'string', description: 'chapters: which volume to extend (default: the last).' },
        apply: { type: 'boolean', description: 'chapters/beats/plan: write the result into the outline (default true). chapters with apply=false: the plan waits with the book to be looked at.' },
        feedback: { type: 'string', description: 'chapters: what the author says of the plan that waits — it is adjusted by the planner that derived it, and waits again.' },
        waiting: { type: 'string', enum: ['show', 'add', 'discard'], description: 'chapters: the plan that waits to be looked at — read it, add it to the outline as it stands, or drop it.' },
        pictures: listParameter('chapters, what_if: pictures the author gave to steer by — project-relative paths of the book\'s own pictures.'),
      },
      async run(args, env) {
        const runtime = await env.project()
        if (args.kind === 'chapters') {
          const said = args.feedback?.trim() ?? ''
          /** A plan that waits, a chapter to a few lines. */
          const laid = (chapters: readonly DerivedChapter[]): string => chapters.map((chapter, index) => `${index + 1}. ${chapter.title}\n   ${brief(chapter.synopsis, 260)}${chapter.beats.length > 0 ? `\n   beats: ${chapter.beats.map(beat => brief(beat.summary, 60)).join(' → ')}` : ''}${chapter.guides !== undefined ? `\n   goes by: ${chapter.guides.map(guide => guide.path).join(', ')}` : ''}`).join('\n')
          const then = 'It is not in the outline. `waiting=add` adds it as it stands, `waiting=discard` drops it, `feedback` has its planner adjust it by what the author says.'
          if (args.waiting !== undefined && said.length === 0) {
            const plan = await derivedPlan(runtime)
            if (plan === undefined) return { text: 'No derived plan is waiting to be looked at. kind=chapters with apply=false derives one.', data: toJson({ waiting: null }) }
            if (args.waiting === 'show') {
              return {
                text: `The plan that waits (${plan.chapters.length} chapter(s), derived ${plan.at}${plan.direction !== undefined ? `, direction: ${brief(plan.direction, 200)}` : ''}${plan.feedback !== undefined ? `; adjusted ${plan.feedback.length} time(s) by: ${plan.feedback.map(word => brief(word, 120)).join(' / ')}` : ''}):\n${laid(plan.chapters)}${plan.rationale !== undefined ? `\n\nRationale: ${plan.rationale}` : ''}\n\n${then}`,
                data: toJson(plan),
              }
            }
            if (args.waiting === 'discard') {
              await settleDerivedPlan(env.core, runtime)
              return { text: `Dropped the plan that waited (${plan.chapters.length} chapter(s)). Nothing waits now; the outline is as it was.`, data: toJson({ discarded: plan.chapters.length }) }
            }
            const entered = (await enterDerivedPlan(env.core, runtime))!
            return {
              text: `Added the plan that waited to the outline${entered.line !== undefined ? ` on the line "${entered.line.title}" (${entered.line.id})` : ''}:\n${entered.added.map(chapter => `${chapter.index}. ${chapter.title} (${chapter.id})`).join('\n')}`,
              data: toJson(entered),
            }
          }
          if (said.length > 0 || args.apply === false) {
            // Looked at before it is added: it waits with the book, and its planner is kept to go on from it.
            const result = await env.job('derive', 'derive chapters preview', undefined, async (task, job) => await deriveToLook(env.core, runtime, {
              ...(args.count !== undefined ? { count: args.count } : {}),
              ...(args.direction !== undefined ? { direction: args.direction } : {}),
              ...(args.volume !== undefined ? { volume: args.volume } : {}),
              ...(args.line !== undefined && args.line.trim().length > 0 ? { line: args.line.trim() } : {}),
              ...(args.after !== undefined && args.after.trim().length > 0 ? { after: args.after.trim() } : {}),
              ...(args.mode !== undefined ? { mode: args.mode } : {}),
              ...(listOf(args.pictures) !== undefined ? { guides: cleanGuides(listOf(args.pictures)!) } : {}),
              ...(said.length > 0 ? { feedback: said } : {}),
              job: job.id,
            }, task))
            const by = said.length === 0 ? '' : result.resumed === true
              ? ' — by the planner that derived it, going on in its own conversation'
              : ' — the planner that derived it was no longer at hand, so another was handed the plan and the author\'s words'
            return {
              text: `${said.length > 0 ? `The plan that waits, adjusted by what the author said${by}` : `Derived ${result.chapters.length} chapters to be looked at`}:\n${laid(result.chapters)}${result.rationale !== undefined ? `\n\nRationale: ${result.rationale}` : ''}${result.pictures !== undefined ? `\n\n${picturesSaid(result.pictures, 'planner')!}` : ''}${result.referenced !== undefined ? `\n\n${referencesSaid(result.referenced, 'planner')!}` : ''}\n\n${then}`,
              data: toJson(result),
            }
          }
          const result = await env.job('derive', 'derive chapters', undefined, async task => await deriveChapters(env.core, runtime, {
            ...(args.count !== undefined ? { count: args.count } : {}),
            ...(args.direction !== undefined ? { direction: args.direction } : {}),
            ...(args.volume !== undefined ? { volume: args.volume } : {}),
            ...(args.apply !== undefined ? { apply: args.apply } : {}),
            ...(args.line !== undefined && args.line.trim().length > 0 ? { line: args.line.trim() } : {}),
            ...(args.after !== undefined && args.after.trim().length > 0 ? { after: args.after.trim() } : {}),
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.title !== undefined && args.title.trim().length > 0 ? { title: args.title.trim() } : {}),
            ...(args.choice !== undefined && args.choice.trim().length > 0 ? { choice: args.choice.trim() } : {}),
            ...(listOf(args.pictures) !== undefined ? { guides: cleanGuides(listOf(args.pictures)!) } : {}),
          }, task))
          const where = result.line !== undefined ? ` ${result.line.created ? 'on a new line of the plot' : 'on the line'} "${result.line.title}" (${result.line.id})` : ''
          const replaced = result.replaced !== undefined && result.replaced.chapters > 0 ? `\nThey take the place of ${result.replaced.chapters} chapter(s)${result.replaced.kept !== undefined ? `, which had text and are kept as the line "${result.replaced.kept.title}" (${result.replaced.kept.id}), put aside — tell the author where they went` : ' that were not written and are gone'}.` : ''
          const lines = result.chapters.map((chapter, index) => {
            const added = result.added[index]
            return `${added !== undefined ? `${added.index}. ` : '- '}${chapter.title}${added !== undefined ? ` (${added.id})` : ''}\n   ${brief(chapter.synopsis, 260)}${chapter.beats.length > 0 ? `\n   beats: ${chapter.beats.map(beat => brief(beat.summary, 60)).join(' → ')}` : ''}${chapter.guides !== undefined ? `\n   goes by: ${chapter.guides.map(guide => guide.path).join(', ')}` : ''}`
          })
          return {
            text: `${result.added.length > 0 ? `Added ${result.added.length} chapters to the outline${where}` : `Derived ${result.chapters.length} chapters (not applied)`}:${replaced}\n${lines.join('\n')}${result.rationale !== undefined ? `\n\nRationale: ${result.rationale}` : ''}${result.pictures !== undefined ? `\n\n${picturesSaid(result.pictures, 'planner')!}` : ''}${result.referenced !== undefined ? `\n\n${referencesSaid(result.referenced, 'planner')!}` : ''}`,
            data: toJson(result),
          }
        }
        if (args.kind === 'beats') {
          if (args.chapter === undefined) throw new ProjectError('novel/invalid', 'kind=beats needs `chapter`')
          const chapter = args.chapter
          if (args.from_text === true) {
            const read = await env.job('derive', 'beats of text', chapter, async task => await planOfText(env.core, runtime, { chapter, what: 'beats', ...(args.apply !== undefined ? { apply: args.apply } : {}) }, task))
            return {
              text: `Beats of chapter ${read.index} "${read.title}" as its text has them${read.applied ? ` (saved to the outline — read anew off the text: ${read.beats.length} now, the ${read.was} there were are in the plan's history)` : ' (not applied)'}:\n${read.beats.map((beat, index) => `${index + 1}. ${beat.summary}`).join('\n')}`,
              data: toJson(read),
            }
          }
          const result = await env.job('derive', 'derive beats', chapter, async task => await deriveBeats(env.core, runtime, {
            chapter,
            ...(args.direction !== undefined ? { direction: args.direction } : {}),
            ...(args.apply !== undefined ? { apply: args.apply } : {}),
          }, task))
          return {
            text: `Beats for chapter ${result.index} "${result.title}"${result.applied ? ' (saved to the outline)' : ' (not applied)'}:\n${result.beats.map((beat, index) => `${index + 1}. ${beat.summary}`).join('\n')}${result.referenced !== undefined ? `\n\n${referencesSaid(result.referenced, 'planner')!}` : ''}`,
            data: toJson(result),
          }
        }
        if (args.kind === 'beat') {
          if (args.chapter === undefined) throw new ProjectError('novel/invalid', 'kind=beat needs `chapter`')
          if (args.direction === undefined || args.direction.trim().length === 0) throw new ProjectError('novel/invalid', 'kind=beat needs what the author says in `direction`')
          const chapter = args.chapter
          const ask = args.direction
          const chosen = listOf(args.beats) ?? []
          const done = await env.job('derive', 'derive beat', chapter, async task => await touchBeats(env.core, runtime, { chapter, ask, ...(chosen.length > 0 ? { beats: chosen } : {}), ...(args.after !== undefined ? { after: args.after } : {}) }, task))
          const said = done.why !== undefined ? `\nThe planner: ${done.why}` : ''
          return {
            text: done.added !== undefined
              ? `Added a beat to chapter ${done.index} "${done.title}" — it is beat ${done.at} of ${done.beats} now, and no other beat was touched (the plan as it was is in its history):\n${done.at}. ${done.added.summary}${said}`
              : `Changed ${done.changed?.length ?? 0} beat(s) of chapter ${done.index} "${done.title}"${(done.removed?.length ?? 0) > 0 ? `, and took ${done.removed!.length} out` : ''}; the others stand as they stood (the plan as it was is in its history):\n${(done.changed ?? []).map(beat => `- ${beat.summary}`).join('\n')}${said}`,
            data: toJson(done),
          }
        }
        if (args.kind === 'plan') {
          if (args.chapter === undefined) throw new ProjectError('novel/invalid', 'kind=plan needs `chapter`')
          const chapter = args.chapter
          const read = await env.job('derive', 'plan of text', chapter, async task => await planOfText(env.core, runtime, { chapter, what: 'plan', ...(args.apply !== undefined ? { apply: args.apply } : {}) }, task))
          const moved = (read.changed ?? []).length > 0 ? `changed by the text: ${read.changed!.join(', ')}; the beats read anew (${read.beats.length} now, ${read.was} before)` : `synopsis, purpose, place, time, point of view and cast read as they did; the beats read anew (${read.beats.length} now, ${read.was} before)`
          return {
            text: `The plan of chapter ${read.index} "${read.title}" as its text has it${read.applied ? ` (saved to the outline — ${moved}; the plan as it was is in its history)` : ' (not applied)'}:\n${read.synopsis ?? ''}\n${read.beats.map((beat, index) => `${index + 1}. ${beat.summary}`).join('\n')}`,
            data: toJson(read),
          }
        }
        if (args.kind === 'what_if') {
          if (args.direction === undefined || args.direction.trim().length === 0) throw new ProjectError('novel/invalid', 'kind=what_if needs the question in `direction`')
          const question = args.direction
          const result = await env.job('derive', 'what-if', undefined, async task => await whatIf(env.core, runtime, { question, ...(args.count !== undefined ? { branches: args.count } : {}), ...(listOf(args.pictures) !== undefined ? { guides: cleanGuides(listOf(args.pictures)!) } : {}) }, task))
          return {
            text: `${result.branches.map((branch, index) => `### ${index + 1}. ${branch.title}\n${branch.development}${branch.consequences.length > 0 ? `\nConsequences: ${branch.consequences.join('; ')}` : ''}${branch.risks !== undefined ? `\nRisks: ${branch.risks}` : ''}${branch.payoff !== undefined ? `\nPayoff: ${branch.payoff}` : ''}`).join('\n\n')}${result.recommendation !== undefined ? `\n\nRecommendation: ${result.recommendation}` : ''}${result.pictures !== undefined ? `\n\n${picturesSaid(result.pictures, 'planner')!}` : ''}${result.referenced !== undefined ? `\n\n${referencesSaid(result.referenced, 'planner')!}` : ''}`,
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

// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools for the stage: illustrations, audio drama, motion comic, interludes. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { stockVoices } from '../../core/media/voices'
import { buildAudioScript, designCharacterVoice, exportChapterAudio, previewVoices, synthesizeChapter } from '../../core/pipelines/audio'
import { buildStoryboard, renderPanels } from '../../core/pipelines/comic'
import { illustrate, type IllustrateParams } from '../../core/pipelines/illustrate'
import { novelizePlay, playTurn, setPlayOutcome, startPlay } from '../../core/pipelines/play'
import { ProjectError } from '../../core/project'
import type { NovelService } from '../../host/service'
import type { PlayTurn, StoryboardDensity } from '../../shared/types'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

function renderTurn(turn: PlayTurn): string {
  const parts: string[] = []
  if (turn.narration !== undefined) parts.push(turn.narration)
  for (const line of turn.lines) parts.push(`${line.speaker}${line.action !== undefined ? ` (${line.action})` : ''}: ${line.text}`)
  if (turn.choices.length > 0) parts.push(`Choices:\n${turn.choices.map((choice, index) => `${index + 1}. ${choice}`).join('\n')}`)
  if (turn.ended === true) parts.push('(the scene has ended)')
  return parts.join('\n')
}

export function stageTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_illustrate',
      description: [
        'Generate an image with the configured image model and store it in the project.',
        '- kind=sheet: a character\'s design sheet — the same person from the front, the side and the back (`target` = character). It is the reference image every later picture of them is drawn against, so make it first. With `look` it draws one of their looks (outfits) instead, derived from the main sheet so it stays the same person; a look that does not exist yet is created from `prompt` (what the outfit is).',
        '- kind=portrait: a bust portrait (`target` = character), used for avatars and the interlude stage.',
        '- kind=scene: an illustration for a chapter (`target` = chapter). Quote the passage to illustrate in `quote`; insert=true embeds the picture in the chapter after that passage. The characters present are found in the passage; their sheets and the place\'s reference art go along as reference images. `looks` says what someone wears ({"name": "look"}) when the passage does not make it obvious.',
        '- kind=location: reference art for a world entry (`target` = entry); scenes set there are drawn against it.   - kind=cover: a cover for the book.   - kind=custom: `prompt` is the whole picture; `characters` lists who is in it so their sheets go along; raw=true sends the prompt exactly as written.',
        '`prompt` adds direction for the other kinds. Every picture gets the book\'s art direction and its avoid list (see novel_settings action=show; change them with action=book fields.artStyle / fields.artAvoid), each character\'s visual anchor (novel_bible fields.visual, or action=derive_visual) and what their card says must not be drawn; `avoid` adds more for this one picture. The result says what the prompt was assembled from.',
        'An image model draws the commonest real-world version of a loaded word: write what a thing looks like in this story (material, shape, wear), not what it is called.',
      ].join('\n'),
      mutating: true,
      parameters: {
        kind: { type: 'string', required: true, enum: ['sheet', 'portrait', 'scene', 'location', 'cover', 'custom'] },
        target: { type: 'string', description: 'Character, chapter or world entry.' },
        quote: { type: 'string', description: 'scene: the passage to illustrate.' },
        prompt: { type: 'string', description: 'Extra direction; the full prompt for kind=custom; what the outfit is for a new look.' },
        look: { type: 'string', description: 'sheet: name of the look (outfit) to draw, e.g. "丧服".' },
        looks: { type: 'object', additionalProperties: true, description: 'scene/cover/custom: what each character wears — {"character": "look name"}.' },
        characters: listParameter('custom: characters shown in the picture; their looks and design sheets go along.'),
        avoid: listParameter('Things that must not appear in this picture, on top of the book\'s list.'),
        raw: { type: 'boolean', description: 'custom: send `prompt` exactly as written — no art direction, no avoid list.' },
        size: { type: 'string', description: 'WIDTHxHEIGHT, e.g. 1280x720.' },
        insert: { type: 'boolean', description: 'scene: embed the image in the chapter text.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const params: IllustrateParams = {
          kind: args.kind as IllustrateParams['kind'],
          ...(args.target !== undefined ? { target: args.target } : {}),
          ...(args.quote !== undefined ? { quote: args.quote } : {}),
          ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
          ...(args.look !== undefined ? { look: args.look } : {}),
          ...(args.looks !== undefined ? { looks: Object.fromEntries(Object.entries(args.looks as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
          ...(listOf(args.characters) !== undefined ? { characters: listOf(args.characters)! } : {}),
          ...(listOf(args.avoid) !== undefined ? { avoid: listOf(args.avoid)! } : {}),
          ...(args.raw !== undefined ? { raw: args.raw } : {}),
          ...(args.size !== undefined ? { size: args.size } : {}),
          ...(args.insert !== undefined ? { insert: args.insert } : {}),
        }
        const result = await env.job('illustrate', `illustrate ${args.kind}`, args.target, async task => await illustrate(env.core, runtime, params, task))
        const parts = result.parts
        const lines = [
          `Image saved to ${result.path}${result.inserted ? ' and embedded in the chapter' : ''}.`,
          `Picture: ${brief(parts?.subject ?? result.prompt, 400)}`,
          parts?.style !== undefined ? `Art direction (${parts.styleSource === 'book' ? 'the book\'s own' : parts.styleSource === 'studio' ? 'the Studio-wide one' : 'the built-in starting point'}): ${parts.style}` : 'Art direction: none (sent as written).',
          `Kept out: ${parts?.avoid !== undefined && parts.avoid.length > 0 ? parts.avoid.join(', ') : 'nothing — the book has no avoid list (novel_settings action=book fields.artAvoid)'}`,
          `Reference images sent: ${parts?.references !== undefined && parts.references.length > 0 ? parts.references.map(reference => reference.label).join(', ') : 'none'}`,
          ...(result.pinnedStyle !== undefined ? ['This book had no art direction of its own, so the one above was written into it (novel.json → artStyle). Tell the author, and change it with novel_settings action=book fields.artStyle if it is not the look they want.'] : []),
        ]
        return { text: lines.join('\n'), data: toJson(result) }
      },
    }),

    novelTool(service, {
      name: 'novel_audio',
      description: [
        'Produce the audio drama of a chapter with the configured speech model.',
        '- action=script: cut the chapter into narration, dialogue and inner-voice lines with delivery direction and ambience cues (no audio yet). A passage the director model could not deliver is cut by rule instead and has no speakers: the result says so and why — fix the cause and run it again with force=true.',
        '- action=synthesize: render every line that has no current audio (builds the script first if needed). Every speaker keeps one voice across the book — the voice on their card, else one cast once and kept in the book\'s voice sheet (action=cast shows it), strangers without a card included. Each take is checked by measurement: a line that comes back cut short, silent, or plainly not in the speaker\'s voice is spoken again (the speech settings say how many times), every kept line is brought to one level, and lines rendered earlier that fail the check are spoken again too. The result counts what was retaken and what still stands out.',
        '- action=cast: the book\'s voice sheet — who speaks with which voice.',
        '- action=export: join the rendered lines into one WAV file.',
        '- action=design_voice: create a voice of their own for `character` from their persona (`prompt` overrides the description); needs a provider with voice design.',
        '- action=set_voice: assign `voice` (a provider voice id) and optional delivery `prompt` to `character`.',
        '- action=voices: list the stock voices of the configured provider.',
        'The author listens in Novel Studio → Read, in its listening mode (novel_show view=listen), where ambience is mixed in live.',
      ].join('\n'),
      mutating: args => args.action !== 'voices' && args.action !== 'cast',
      parameters: {
        action: { type: 'string', required: true, enum: ['script', 'synthesize', 'cast', 'export', 'design_voice', 'set_voice', 'voices'] },
        chapter: { type: 'string', description: 'script/synthesize/export: which chapter.' },
        character: { type: 'string', description: 'design_voice/set_voice: which character.' },
        voice: { type: 'string', description: 'set_voice: provider voice id.' },
        prompt: { type: 'string', description: 'design_voice: voice description; set_voice: baseline delivery instructions.' },
        force: { type: 'boolean', description: 'script/synthesize: redo even when current.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        if (args.action === 'voices') {
          const settings = (await env.core.settings.get()).tts
          const voices = stockVoices(settings.provider)
          if (voices.length === 0) return { text: 'No speech provider is configured (Novel Studio → Settings).' }
          return { text: `Stock voices of ${settings.provider}:\n${voices.map(voice => `- ${voice.id}: ${voice.gender}, ${voice.age}${voice.accent !== undefined ? `, ${voice.accent}` : ''} — ${voice.note}`).join('\n')}`, data: toJson(voices) }
        }
        if (args.action === 'cast') {
          const settings = (await env.core.settings.get()).tts
          if (settings.provider === 'none') return { text: 'No speech provider is configured (Novel Studio → Settings), so nobody has a voice yet.' }
          const sheet = await project.voiceCast()
          const characters = await project.characters()
          const voices = await previewVoices(project, settings)
          const rows = characters.filter(card => voices.characters[card.id] !== undefined).map((card) => {
            const own = card.voiceProfile?.voice !== undefined && (card.voiceProfile.provider === undefined || card.voiceProfile.provider === settings.provider)
            const source = own
              ? `set on their card${card.voiceProfile!.sample !== undefined ? ', a voice designed for them' : ''}`
              : sheet?.characters[card.id] !== undefined ? 'cast, and kept for the book' : card.voice !== undefined ? 'from how their card says they speak' : 'what they will be cast with when they first speak'
            return `- ${card.name}: ${voices.characters[card.id]} (${source})`
          })
          const extras = Object.entries(sheet?.extras ?? {}).map(([name, voice]) => `- ${name}: ${voice} (no character card; cast by name, kept for the book)`)
          return {
            text: [`Voices of this book (${settings.provider}${settings.model !== undefined ? ` / ${settings.model}` : ''}):`, ...rows, ...extras, 'Change a character\'s voice with action=set_voice or action=design_voice (or by rewriting how their card says they speak, where voices are descriptions); a stranger gets a voice the author can set once they have a character card.'].join('\n'),
            data: toJson({ characters: voices.characters, extras: sheet?.extras ?? {} }),
          }
        }
        if (args.action === 'design_voice' || args.action === 'set_voice') {
          if (args.character === undefined) throw new ProjectError('novel/invalid', `action=${args.action} needs \`character\``)
          const character = args.character
          if (args.action === 'set_voice') {
            const card = await project.findCharacter(character)
            if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${character}"`)
            if (args.voice === undefined || args.voice.trim().length === 0) throw new ProjectError('novel/invalid', 'action=set_voice needs `voice`')
            const provider = (await env.core.settings.get()).tts.provider
            await project.saveCharacter({ id: card.id, voiceProfile: { ...card.voiceProfile, provider, voice: args.voice.trim(), ...(args.prompt !== undefined ? { instructions: args.prompt } : {}) } })
            return { text: `${card.name} now speaks with voice "${args.voice.trim()}".` }
          }
          const result = await env.job('audio', 'design voice', character, async task => await designCharacterVoice(env.core, runtime, { character, ...(args.prompt !== undefined ? { prompt: args.prompt } : {}) }, task))
          return { text: `Designed voice "${result.voice}" for ${result.character}${result.sample !== undefined ? `; audition sample at ${result.sample}` : ''}.`, data: toJson(result) }
        }
        if (args.chapter === undefined) throw new ProjectError('novel/invalid', `action=${args.action} needs \`chapter\``)
        const chapter = args.chapter
        if (args.action === 'script') {
          const script = await env.job('audio', 'audio script', chapter, async task => await buildAudioScript(env.core, runtime, { chapter, ...(args.force !== undefined ? { force: args.force } : {}) }, task))
          const speakers = [...new Set(script.lines.filter(line => line.speakerName !== undefined).map(line => line.speakerName!))]
          const degraded = script.degraded !== undefined
            ? `\nWARNING: ${script.degraded.blocks} of ${script.degraded.of} passages could not be directed by the analyst model and were cut by rule instead — their dialogue has no speakers and will be read in the narrator's voice. Reason: ${script.degraded.reason}\nTell the author; once the cause is dealt with, run action=script again with force=true.`
            : ''
          return {
            text: `Script for ${script.chapterId}: ${script.lines.length} lines (${script.lines.filter(line => line.kind === 'dialogue').length} dialogue), ${script.cues.length} ambience cues (${[...new Set(script.cues.map(cue => cue.ambience))].join(', ')}). Speakers: ${speakers.join(', ') || 'narrator only'}.${degraded}`,
            data: toJson({ chapterId: script.chapterId, lines: script.lines.length, speakers, ...(script.degraded !== undefined ? { degraded: script.degraded } : {}) }),
          }
        }
        if (args.action === 'synthesize') {
          const result = await env.job('audio', 'synthesize', chapter, async task => await synthesizeChapter(env.core, runtime, { chapter, ...(args.force !== undefined ? { force: args.force } : {}) }, task))
          const checked = [
            result.rechecked > 0 ? `${result.rechecked} lines rendered earlier did not pass the listening check and were spoken again` : undefined,
            result.retaken > 0 ? `${result.retaken} lines needed more than one take` : undefined,
            result.leveled > 0 ? `${result.leveled} earlier lines were brought to the common level` : undefined,
            result.flagged > 0 ? `${result.flagged} lines still stand out after their retakes (cut short, or not quite in the speaker's voice) — they are marked in the Studio, where the author can have any of them spoken again` : undefined,
          ].filter((part): part is string => part !== undefined)
          return {
            text: `Audio for ${result.chapterId}: ${result.rendered} lines rendered, ${result.cached} already current, ${result.failed} failed; ${Math.round(result.duration)} seconds in total.${checked.length > 0 ? ` ${checked.join('; ')}.` : ''} The author can listen in Novel Studio → Read, in its listening mode.`,
            data: toJson(result),
          }
        }
        const result = await exportChapterAudio(runtime, chapter)
        return { text: `Exported ${Math.round(result.duration)} seconds of audio to ${result.path}${result.missing > 0 ? ` (${result.missing} lines had no audio and were skipped)` : ''}.`, data: toJson(result) }
      },
    }),

    novelTool(service, {
      name: 'novel_comic',
      description: [
        'Turn a chapter into a motion comic.',
        '- action=storyboard: arrange the chapter\'s audio script into panels with image prompts (building the script first if needed). How finely it is cut is the author\'s call: `density` = sparse (a picture every 25 seconds or so), balanced (every 13), dense (every 6-7) or auto (the director decides where the picture should change); `max_panels` is a ceiling that holds whatever the density. Left out, both come from the book (novel_settings action=book fields.storyboard = {"density": …, "maxPanels": …}), else balanced with no ceiling. Every panel is a picture to draw, so say how many came out before rendering. A board that exists is kept unless force=true.',
        '- action=render: draw the panels that have no picture yet.',
        'The player in Novel Studio → Stage shows each panel while its lines are spoken.',
      ].join('\n'),
      mutating: true,
      parameters: {
        action: { type: 'string', required: true, enum: ['storyboard', 'render'] },
        chapter: { type: 'string', required: true },
        density: { type: 'string', enum: ['auto', 'sparse', 'balanced', 'dense'], description: 'storyboard: how finely to cut.' },
        max_panels: { type: 'integer', description: 'storyboard: the most panels the chapter may have.' },
        force: { type: 'boolean', description: 'Redo even when current.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const chapter = args.chapter
        if (args.action === 'storyboard') {
          const board = await env.job('comic', 'storyboard', chapter, async task => await buildStoryboard(env.core, runtime, {
            chapter,
            ...(args.density !== undefined ? { density: args.density as StoryboardDensity } : {}),
            ...(args.max_panels !== undefined ? { maxPanels: args.max_panels } : {}),
            ...(args.force !== undefined ? { force: args.force } : {}),
          }, task))
          const cut = `${board.density ?? 'balanced'}${board.maxPanels !== undefined ? `, at most ${board.maxPanels}` : ''}`
          return {
            text: `Storyboard for ${board.chapterId}: ${board.panels.length} panels (cut: ${cut}); ${board.panels.filter(panel => panel.image !== undefined).length} already have a picture.${board.note !== undefined ? `\nNote: ${board.note}` : ''}\n${board.panels.map((panel, index) => `${index + 1}. [${panel.camera}] ${brief(panel.description, 100)}`).join('\n')}`,
            data: toJson({ chapterId: board.chapterId, panels: board.panels.length, density: board.density ?? 'balanced', ...(board.maxPanels !== undefined ? { maxPanels: board.maxPanels } : {}) }),
          }
        }
        const result = await env.job('comic', 'draw panels', chapter, async task => await renderPanels(env.core, runtime, { chapter, ...(args.force !== undefined ? { force: args.force } : {}) }, task))
        return { text: `Panels for ${result.chapterId}: ${result.rendered} drawn, ${result.failed} failed, ${result.panels} in total.`, data: toJson(result) }
      },
    }),

    novelTool(service, {
      name: 'novel_play',
      description: [
        'Interludes: a playable scene branched off the canon, where the author steps into a character (or directs) and a director model plays everyone else. Nothing in the manuscript changes until the scene is novelized.',
        '- action=start: set up a scene — `situation` (required), `cast` (characters present), `player` (the character the author plays; omit to let them direct), `anchor` (chapter it branches from; default the latest written), `location`, `tone`. The author then plays it in Novel Studio → Stage, with portraits, voices and ambience.',
        '- action=turn: play one turn here in the chat on the author\'s behalf (`session`, `text` = what they say or do).',
        '- action=list / action=read (`session`): see interludes and their logs.',
        '- action=novelize (`session`, optional `title`): rewrite the scene as a chapter and add it after its anchor.   - action=discard (`session`).',
      ].join('\n'),
      mutating: args => args.action === 'start' || args.action === 'novelize' || args.action === 'turn',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'turn', 'list', 'read', 'novelize', 'discard'] },
        session: { type: 'string', description: 'Interlude id.' },
        situation: { type: 'string', description: 'start: where things stand as the scene opens.' },
        cast: listParameter('start: characters present.'),
        player: { type: 'string', description: 'start: character the author plays.' },
        anchor: { type: 'string', description: 'start: chapter the scene branches from.' },
        location: { type: 'string' },
        tone: { type: 'string' },
        title: { type: 'string' },
        text: { type: 'string', description: 'turn: the player\'s words or action.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        if (args.action === 'list') {
          const sessions = await project.playSessions()
          if (sessions.length === 0) return { text: 'No interludes yet.' }
          return { text: sessions.map(session => `- ${session.id}: "${session.title}" — ${session.turns.length} turns, ${session.outcome ?? 'open'}`).join('\n'), data: toJson(sessions.map(session => ({ id: session.id, title: session.title, turns: session.turns.length, outcome: session.outcome ?? 'open' }))) }
        }
        if (args.action === 'start') {
          if (args.situation === undefined || args.situation.trim().length === 0) throw new ProjectError('novel/invalid', 'action=start needs `situation`')
          const session = await startPlay(env.core, runtime, {
            situation: args.situation,
            cast: listOf(args.cast) ?? [],
            ...(args.player !== undefined ? { player: args.player } : {}),
            ...(args.anchor !== undefined ? { anchor: args.anchor } : {}),
            ...(args.location !== undefined ? { location: args.location } : {}),
            ...(args.tone !== undefined ? { tone: args.tone } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}),
          }, env.task)
          return { text: `Interlude "${session.title}" (${session.id}) is ready in Novel Studio → Stage → Interludes. Opening:\n\n${renderTurn(session.turns[0]!)}`, data: toJson({ id: session.id }) }
        }
        if (args.session === undefined) throw new ProjectError('novel/invalid', `action=${args.action} needs \`session\``)
        const id = args.session
        if (args.action === 'turn') {
          if (args.text === undefined || args.text.trim().length === 0) throw new ProjectError('novel/invalid', 'action=turn needs `text`')
          const { turn } = await playTurn(env.core, runtime, { session: id, text: args.text }, env.task)
          return { text: renderTurn(turn), data: toJson(turn) }
        }
        if (args.action === 'read') {
          const session = await project.playSession(id)
          if (session === undefined) throw new ProjectError('novel/not-found', `no interlude "${id}"`)
          return { text: `"${session.title}" — ${session.situation}\n\n${session.turns.map(turn => `${turn.input !== undefined ? `▶ ${turn.input.text}\n` : ''}${renderTurn(turn)}`).join('\n\n')}`, data: toJson({ id: session.id, turns: session.turns.length }) }
        }
        if (args.action === 'discard') {
          await setPlayOutcome(runtime, id, 'discarded')
          return { text: `Interlude ${id} marked as discarded; the canon is untouched.` }
        }
        const result = await env.job('play', 'novelize', id, async task => await novelizePlay(env.core, runtime, { session: id, ...(args.title !== undefined ? { title: args.title } : {}) }, task))
        return { text: `Novelized the interlude as chapter "${result.title}" (${result.chapterId}), ${result.words} words. Check where it sits in the outline (novel_status).`, data: toJson(result) }
      },
    }),
  ]
}

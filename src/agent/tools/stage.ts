// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools for the stage: illustrations, audio drama, motion comic, interludes. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { stockVoices } from '../../core/media/voices'
import { buildAudioScript, designCharacterVoice, exportChapterAudio, isSkipped, previewVoices, reshapeAudioScript, synthesizeChapter } from '../../core/pipelines/audio'
import { renderSound } from '../../core/pipelines/sound'
import { buildStoryboard, renderPanels, sheetsAhead } from '../../core/pipelines/comic'
import { illustrate, type IllustrateParams } from '../../core/pipelines/illustrate'
import { novelizePlay, playTurn, setPlayOutcome, startPlay } from '../../core/pipelines/play'
import { ProjectError } from '../../core/project'
import type { NovelService } from '../../host/service'
import type { IllustrationParts, PlayTurn, StoryboardDensity } from '../../shared/types'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

/**
 * Said with a picture once it is drawn: reference pictures the image service did not take. It is said after, never
 * before — what a service takes changes, and is shown by drawing.
 */
function leftBehind(parts: IllustrationParts | undefined): string[] {
  const left = parts?.left ?? []
  if (left.length === 0) return []
  const names = left.map(reference => reference.label).join(', ')
  const sent = parts?.references?.length ?? 0
  if (sent > 0) return [`The image service takes ${sent} reference picture${sent === 1 ? '' : 's'} with a prompt, so these stayed behind: ${names}. Whoever they show was drawn from the words alone. Tell the author.`]
  if (parts?.leftWhy !== undefined) return [`The image service was sent the reference picture${left.length === 1 ? '' : 's'} (${names}) and would not take ${left.length === 1 ? 'it' : 'them'} — it answered: ${brief(parts.leftWhy, 200)}. The picture was then drawn from the words alone. Tell the author.`]
  return [`The image service takes no reference pictures: ${names} did not go along, and the picture was drawn from the words alone. Tell the author.`]
}

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
        '- kind=sheet: a character\'s design sheet — the same person from the front, the side and the back (`target` = character). It is the reference image every later picture of them is drawn against, so make it first. The sheet itself is drawn from the words alone — the visual anchor, the art direction, what is asked of this one — and never against an older picture of the person: drawn again it is a new picture, not the old one touched up. So when a sheet shows something the author does not want (a hairstyle, a costume of the wrong period), the anchor says it or the model added it: read novel_manage action=show_image for that picture, change the anchor (novel_bible fields.visual.prompt, or `notes` here), draw the sheet again, then the portrait — which is drawn against the sheet and keeps the old look until it is drawn again. With `look` it draws one of their looks (outfits) instead, derived from the main sheet so it stays the same person; a look that does not exist yet is created from `prompt` (what the outfit is).',
        '- kind=portrait: a portrait (`target` = character), their face in the Studio\'s lists and on the interlude stage. It shows them in their signature scene — the moment of the book a reader remembers them by. With no `prompt` and no `notes` that is one of the scenes kept on their card (visual.scenes — `scene` names which; the first otherwise); where none are kept the director finds them in the book first (one director run; it reads the text) and keeps them there (novel_bible action=derive_scene looks the list over, fields.visual.scenes writes it). `prompt` and what `notes` says of the picture do not replace the scene — they guide the director, who picks and writes the moment for this one portrait by them ("brighter", "the night of the fire", "no blood"; one director run) while the card keeps what it had. Which moments are fit to show is the author\'s to say — through the book\'s avoid list and through what they ask; nothing is ruled out by kind, a martyr\'s portrait may be the martyrdom. The result says which moment it is and why: tell the author. plain=true draws the plain one instead — facing the viewer on a plain ground; so does a book with nothing written yet. The sheet comes first by itself: somebody who has no design sheet gets one drawn before their portrait, and whoever comes back in the book (a part that carries it, or in two chapters or more) gets one before the first scene, panel or cover that shows them — one more image call each, named in the result. The author is asked first: unless they already said to go ahead, call with sheet_first=ask, tell them whose sheets would be drawn ("this will first draw N design sheets: …"), and draw with sheet_first=draw — or skip — on their answer. The author can turn the whole thing off (novel_settings image.sheetFirst=false).',
        '- kind=scene: an illustration for a chapter (`target` = chapter). Quote the passage to illustrate in `quote`; insert=true embeds the picture in the chapter after that passage. The characters present are found in the passage; their sheets and the place\'s reference art go along as reference images. `looks` says what someone wears ({"name": "look"}) when the passage does not make it obvious.',
        '- kind=location / kind=item with `event`: the place or the thing as it is from one turn of its course on — just built, changed, in ruins, gone. The director writes what is there to be seen once it has happened (from its usual look and that chapter), and that is drawn without people: a change or a decline against its design art, a beginning or an end from the words alone. Kept with that turn; the viewer shows it when the story is looked at from that chapter on.',
        '- kind=location: reference art for a world entry (`target` = entry); scenes set there are drawn against it.   - kind=item: design art of a key object (`target` = a world entry that is a thing): the object alone, whole, on a plain ground; pictures that show it are drawn against it.   - kind=cover: a cover for the book.   - kind=custom: `prompt` is the whole picture; `characters` lists who is in it — how each looks (their visual anchor) is written into the prompt after yours and their sheets go along, so do not describe them again; raw=true sends the prompt exactly as written, without them.',
        '`prompt` adds direction for the other kinds. Every picture gets the book\'s art direction and its avoid list (see novel_settings action=show; change them with action=book fields.artStyle / fields.artAvoid), each character\'s visual anchor (novel_bible fields.visual, or action=derive_visual) and what their card says must not be drawn; `avoid` adds more for this one picture. The result says what the prompt was assembled from; the whole record of a picture — every part, the references, the words as sent — is kept with it (novel_manage action=show_image), and the author sees it by opening the picture large in the Studio.',
        'An image model draws the commonest real-world version of a loaded word: write what a thing looks like in this story (material, shape, wear), not what it is called.',
      ].join('\n'),
      mutating: true,
      parameters: {
        kind: { type: 'string', required: true, enum: ['sheet', 'portrait', 'scene', 'location', 'item', 'cover', 'custom'] },
        target: { type: 'string', description: 'Character, chapter or world entry.' },
        quote: { type: 'string', description: 'scene: the passage to illustrate.' },
        prompt: { type: 'string', description: 'Extra direction; the full prompt for kind=custom; what the outfit is for a new look.' },
        notes: { type: 'string', description: 'portrait, sheet: what the author said they want, as they said it, mixed as it came. The director sorts it: what is of the person (a scar, the grey robe they always wear) is worked into their visual anchor and appearance and holds for every later picture; what is of this one picture (a snowy night, looking back) directs this picture only and is kept nowhere. The result says how it was sorted — pass that on. Use `prompt` instead for a direction you know is for this picture only.' },
        sheet_first: { type: 'string', enum: ['ask', 'draw', 'skip'], description: 'What to do where somebody to be drawn has no design sheet. ask: draw nothing — say whose sheets this would draw first, so that you can put it to the author ("this will first draw N design sheets"). draw: draw them first, then the picture — the default; use it once the author has agreed, or where nobody lacks a sheet. skip: this once, draw from what there is.' },
        plain: { type: 'boolean', description: 'portrait: draw the plain one — facing the viewer on a plain ground — not their signature scene.' },
        scene: { type: 'string', description: 'portrait: which of their signature scenes to draw — an id from the card\'s visual.scenes (novel_read what=character shows them). Left out: the one the card marks, else the first.' },
        stage: { type: 'string', description: 'portrait, sheet: which stretch of their life to draw — a stage id or title from the card (novel_bible action=derive_growth finds them). A stretch that looks different gets its own design sheet, drawn against the main one so that it stays the same person; a portrait of one of their signature scenes shows the stretch that scene falls in by itself.' },
        look: { type: 'string', description: 'sheet: name of the look (outfit) to draw, e.g. "丧服".' },
        from: { type: 'string', enum: ['portrait', 'sheet', 'words'], description: 'What this one picture of a person is drawn against, whatever the author\'s setting (image.lead) has. For kind=sheet (the main one, or a stretch\'s): portrait — their portrait: the same person turned three ways, when the author likes the portrait and wants the sheet to match it; words — the words alone. For kind=portrait: sheet — their design sheet (drawn first where they have none); words — the words alone: no sheet is drawn first and theirs does not go along. Left out: by the setting.' },
        looks: { type: 'object', additionalProperties: true, description: 'scene/cover/custom: what each character wears — {"character": "look name"}.' },
        characters: listParameter('custom: characters shown in the picture; their looks and design sheets go along.'),
        avoid: listParameter('Things that must not appear in this picture, on top of the book\'s list.'),
        raw: { type: 'boolean', description: 'custom: send `prompt` exactly as written — no art direction, no avoid list.' },
        size: { type: 'string', description: 'WIDTHxHEIGHT, e.g. 1280x720.' },
        insert: { type: 'boolean', description: 'scene: embed the image in the chapter text.' },
        event: { type: 'string', description: 'location/item: draw it as it is from one turn of its course on (built, changed, in ruins) — the chapter of that turn (id or number), or `<chapter>:<kind>` where a chapter has several. The picture is kept with the turn and shown in the viewer when the story is looked at from that chapter; the design art stays. The turn must be on the entry first (novel_bible action=save kind=world fields.events).' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const params: IllustrateParams = {
          kind: args.kind as IllustrateParams['kind'],
          ...(args.target !== undefined ? { target: args.target } : {}),
          ...(args.quote !== undefined ? { quote: args.quote } : {}),
          ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
          ...(args.look !== undefined ? { look: args.look } : {}),
          ...(args.from === 'portrait' || args.from === 'sheet' || args.from === 'words' ? { from: args.from } : {}),
          ...(typeof args.notes === 'string' && args.notes.trim().length > 0 ? { notes: args.notes.trim() } : {}),
          ...(args.looks !== undefined ? { looks: Object.fromEntries(Object.entries(args.looks as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
          ...(listOf(args.characters) !== undefined ? { characters: listOf(args.characters)! } : {}),
          ...(listOf(args.avoid) !== undefined ? { avoid: listOf(args.avoid)! } : {}),
          ...(args.raw !== undefined ? { raw: args.raw } : {}),
          ...(args.size !== undefined ? { size: args.size } : {}),
          ...(args.insert !== undefined ? { insert: args.insert } : {}),
          ...(typeof args.event === 'string' && args.event.trim().length > 0 ? { event: args.event.trim() } : {}),
          ...(args.plain === true ? { plain: true } : {}),
          ...(args.scene !== undefined && args.scene.length > 0 ? { scene: args.scene } : {}),
          ...(args.stage !== undefined && args.stage.length > 0 ? { stage: args.stage } : {}),
        }
        if (args.sheet_first === 'ask') {
          // Nothing is drawn: who would get a sheet first is worked out, for the author to be asked.
          const ahead = params.kind === 'portrait' || params.kind === 'scene' || params.kind === 'cover' || params.kind === 'custom'
            ? await sheetsAhead(env.core, runtime, [{ kind: params.kind, ...(params.target !== undefined ? { target: params.target } : {}), ...(params.quote !== undefined ? { quote: params.quote } : {}), ...(params.characters !== undefined ? { characters: params.characters } : {}), ...(params.kind === 'portrait' && (params.from === 'sheet' || params.from === 'words') ? { from: params.from } : {}) }])
            : { people: [], unknown: 0 } as Awaited<ReturnType<typeof sheetsAhead>>
          return {
            text: ahead.people.length > 0
              ? `Nothing drawn yet. This picture would first draw ${ahead.people.length} design sheet${ahead.people.length === 1 ? '' : 's'} — of ${ahead.people.map(person => person.name).join(', ')} — because ${params.kind === 'portrait' ? 'they have none' : 'they come back in the book and have none'}: ${ahead.people.length} more image call${ahead.people.length === 1 ? '' : 's'}. Ask the author; then call again with sheet_first=draw, or sheet_first=skip to draw from what there is.`
              : 'Nothing drawn yet. No design sheet would be drawn first for this picture: call again with sheet_first=draw.',
            data: toJson(ahead),
            record: false,
          }
        }
        if (args.sheet_first === 'skip') params.sheetFirst = false
        const result = await env.job('illustrate', `illustrate ${args.kind}`, args.target, async task => await illustrate(env.core, runtime, params, task))
        const parts = result.parts
        const lines = [
          `Image saved to ${result.path}${result.inserted ? ' and embedded in the chapter' : ''}.`,
          `Picture: ${brief(parts?.subject ?? result.prompt, 400)}`,
          parts?.style !== undefined ? `Art direction (${parts.styleSource === 'book' ? 'the book\'s own' : parts.styleSource === 'studio' ? 'the Studio-wide one' : 'the built-in starting point'}): ${parts.style}` : 'Art direction: none (sent as written).',
          `Kept out: ${parts?.avoid !== undefined && parts.avoid.length > 0 ? parts.avoid.join(', ') : 'nothing — the book has no avoid list (novel_settings action=book fields.artAvoid)'}`,
          `Reference images sent: ${parts?.references !== undefined && parts.references.length > 0 ? parts.references.map(reference => reference.label).join(', ') : 'none'}`,
          ...leftBehind(parts),
          ...(result.sorted !== undefined ? [result.sorted.unsorted === true
            ? 'The notes could not be sorted (no model answered): all of them directed this picture, and nothing went into the character\'s look.'
            : `The notes were sorted — into how they look from now on: ${result.sorted.kept.length > 0 ? result.sorted.kept.join('; ') : 'nothing'}. For this picture only: ${result.sorted.once.length > 0 ? result.sorted.once.join('; ') : 'nothing'}.${result.sorted.unused.length > 0 ? ` No place in this picture: ${result.sorted.unused.join('; ')}.` : ''} Tell the author.`] : []),
          // Which moment of the book a portrait asked for nothing shows — the director's pick, or what the card had.
          ...(result.scene !== undefined ? ['none' in result.scene
            ? `The director was asked for the moment of the book this portrait should show and found none: ${result.scene.none}. The portrait is plain. Tell the author.`
            : `The portrait shows ${result.scene.asked !== undefined ? `a moment the director settled for this picture alone, guided by what was asked ("${brief(result.scene.asked, 120)}"); the scenes kept on their card are unchanged` : result.scene.found !== undefined ? `the first of the ${result.scene.found} signature scene(s) the director just found in the book for them and kept on their card (visual.scenes)` : 'one of their signature scenes, as kept on their card (visual.scenes)'}: ${result.scene.title !== undefined && result.scene.title.length > 0 ? `${result.scene.title} — ` : ''}${result.scene.text}${result.scene.why !== undefined ? ` (the director: ${result.scene.why})` : ''} Tell the author which moment it is; another of the kept ones is drawn with scene=<id>, the list is looked over with novel_bible action=derive_scene, something asked of the next portrait guides its moment (\`prompt\`), and plain=true draws a plain one.`] : []),
          // Never done behind the author's back: a sheet drawn for this picture is said with it.
          ...(result.sheets !== undefined ? [`Drawn first, because they had none: the design sheet of ${result.sheets.join(', ')} — one more image call each. Every later picture of them is held against it. Tell the author.`] : []),
          ...(result.sheetsFailed !== undefined ? [`Could not be drawn first: the design sheet of ${result.sheetsFailed.map(item => `${item.name} (${brief(item.error, 120)})`).join(', ')} — this picture was made from what there is of them.`] : []),
          ...(result.pinnedStyle !== undefined ? ['This book had no art direction of its own, so the one above was written into it (novel.json → artStyle). Tell the author, and change it with novel_settings action=book fields.artStyle if it is not the look they want.'] : []),
        ]
        return { text: lines.join('\n'), data: toJson(result) }
      },
    }),

    novelTool(service, {
      name: 'novel_audio',
      description: [
        'Produce the audio drama of a chapter with the configured speech model.',
        '- action=script: cut the chapter into narration, dialogue and inner-voice lines with delivery direction, and design its sound (no audio yet). Narration that follows narration is spoken in one take, so the narrator sounds like one person telling a story; a "he said" stranded between two spoken lines is marked as a tag and left unspoken unless the author has every word read. Sound cues say what is heard — the bed of each scene, spot effects, music — each with a caption the reader sees beside the text. A passage the director model could not deliver is cut by rule instead and has no speakers: the result says so and why — fix the cause and run it again with force=true.',
        '- action=reshape: bring a script made before narration was spoken in whole takes into that shape without calling a model: dialogue keeps its recordings, joined narration is voiced again at the next synthesize.',
        '- action=sound: generate the clips of the sound cues with the sound model — every effect and piece of music, and the beds unless the author keeps to browser-synthesized ones (`kinds` narrows it; `cues` names single ones). Needs a sound model: it follows the speech setup when that is Bailian audio generation. Without one the cues are still captions, and beds are synthesized by the player.',
        '- action=synthesize: render every line that has no current audio (builds the script first if needed). Every speaker keeps one voice across the book — the voice on their card, else one cast once and kept in the book\'s voice sheet (action=cast shows it), strangers without a card included. Each take is checked by measurement: a line that comes back cut short, silent, or plainly not in the speaker\'s voice is spoken again (the speech settings say how many times), every kept line is brought to one level, and lines rendered earlier that fail the check are spoken again too. The result counts what was retaken and what still stands out.',
        '- action=cast: the book\'s voice sheet — who speaks with which voice.',
        '- action=export: join the rendered lines into one WAV file.',
        '- action=design_voice: create a voice of their own for `character` from their persona (`prompt` overrides the description); needs a provider with voice design.',
        '- action=set_voice: assign `voice` (a provider voice id) and optional delivery `prompt` to `character`.',
        '- action=voices: list the stock voices of the configured provider.',
        'The author listens in Novel Studio → Read, in its listening mode (novel_show view=listen), where the sound is laid under the voices. Single lines and cues are changed with novel_manage (edit_line, edit_cue, add_cue).',
      ].join('\n'),
      mutating: args => args.action !== 'voices' && args.action !== 'cast',
      parameters: {
        action: { type: 'string', required: true, enum: ['script', 'reshape', 'synthesize', 'sound', 'cast', 'export', 'design_voice', 'set_voice', 'voices'] },
        chapter: { type: 'string', description: 'script/reshape/synthesize/sound/export: which chapter.' },
        kinds: listParameter('sound: which kinds of cue to make. Default: all the book generates.', { enum: ['bed', 'effect', 'music'] as const }),
        cues: listParameter('sound: ids of single cues to make (again).'),
        character: { type: 'string', description: 'design_voice/set_voice: which character.' },
        voice: { type: 'string', description: 'set_voice: provider voice id.' },
        prompt: { type: 'string', description: 'design_voice: voice description; set_voice: baseline delivery instructions.' },
        force: { type: 'boolean', description: 'script/synthesize/sound: redo even when current.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        if (args.action === 'reshape') {
          if (args.chapter === undefined) throw new ProjectError('novel/invalid', 'action=reshape needs `chapter`')
          const result = await reshapeAudioScript(runtime, args.chapter)
          return { text: `Reshaped the script of ${result.script.chapterId}: ${result.before} lines → ${result.after}; ${result.kept} recordings kept. Joined narration has no audio now — run action=synthesize to voice it.`, data: toJson({ before: result.before, after: result.after, kept: result.kept }) }
        }
        if (args.action === 'sound') {
          if (args.chapter === undefined) throw new ProjectError('novel/invalid', 'action=sound needs `chapter`')
          const chapter = args.chapter
          const kinds = listOf(args.kinds)?.filter((kind): kind is 'bed' | 'effect' | 'music' => kind === 'bed' || kind === 'effect' || kind === 'music')
          const cues = listOf(args.cues)
          const result = await env.job('audio', 'sound', chapter, async task => await renderSound(env.core, runtime, { chapter, ...(kinds !== undefined && kinds.length > 0 ? { kinds } : {}), ...(cues !== undefined && cues.length > 0 ? { cues } : {}), ...(args.force !== undefined ? { force: args.force } : {}) }, task))
          return {
            text: `Sound for ${result.chapterId} (${result.model}): ${result.rendered} clips made (${result.seconds}s), ${result.kept} already current${result.skipped > 0 ? `, ${result.skipped} cues have no description to make a sound from` : ''}${result.failed.length > 0 ? `, ${result.failed.length} failed (${result.failed.slice(0, 3).map(item => `${item.cue}: ${brief(item.error, 80)}`).join('; ')})` : ''}. Sound models are still uneven: the author can hear each cue in the script view and have any one made again after rewording it.`,
            data: toJson(result),
          }
        }
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
          const settings = await env.core.settings.get()
          const unspoken = script.lines.filter(line => isSkipped(line, settings.tts)).length
          const count = (kind: string): number => script.cues.filter(cue => (cue.kind ?? 'bed') === kind).length
          return {
            text: `Script for ${script.chapterId}: ${script.lines.length} lines (${script.lines.filter(line => line.kind === 'dialogue').length} dialogue, ${script.lines.filter(line => line.kind === 'narration').length} narration takes${unspoken > 0 ? `, ${unspoken} speech tags left unspoken` : ''}). Sound design: ${count('bed')} beds, ${count('effect')} effects, ${count('music')} music cues — shown to the reader as notes beside the text; action=sound makes them audible. Speakers: ${speakers.join(', ') || 'narrator only'}.${degraded}`,
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
        const result = await exportChapterAudio(runtime, chapter, (await env.core.settings.get()).tts)
        return { text: `Exported ${Math.round(result.duration)} seconds of audio to ${result.path}${result.missing > 0 ? ` (${result.missing} lines had no audio and were skipped)` : ''}.`, data: toJson(result) }
      },
    }),

    novelTool(service, {
      name: 'novel_comic',
      description: [
        'Turn a chapter into a motion comic.',
        '- action=storyboard: arrange the chapter\'s audio script into panels with image prompts (building the script first if needed). How finely it is cut is the author\'s call: `density` = sparse (a picture every 25 seconds or so), balanced (every 13), dense (every 6-7) or auto (the director decides where the picture should change); `max_panels` is a ceiling that holds whatever the density. Left out, both come from the book (novel_settings action=book fields.storyboard = {"density": …, "maxPanels": …}), else balanced with no ceiling. Every panel is a picture to draw, so say how many came out before rendering. A board that exists is kept unless force=true.',
        '- action=render: draw the panels that have no picture yet. Whoever is in them, comes back in the book and has no design sheet gets one drawn first (one more image call each): the author is asked first — unless they already said to go ahead, call with sheet_first=ask, tell them whose ("this will first draw N design sheets: …"), and render on their answer with sheet_first=draw or skip.',
        'The player in Novel Studio → Stage shows each panel while its lines are spoken.',
      ].join('\n'),
      mutating: true,
      parameters: {
        action: { type: 'string', required: true, enum: ['storyboard', 'render'] },
        chapter: { type: 'string', required: true },
        density: { type: 'string', enum: ['auto', 'sparse', 'balanced', 'dense'], description: 'storyboard: how finely to cut.' },
        max_panels: { type: 'integer', description: 'storyboard: the most panels the chapter may have.' },
        force: { type: 'boolean', description: 'Redo even when current.' },
        sheet_first: { type: 'string', enum: ['ask', 'draw', 'skip'], description: 'What to do where somebody to be drawn has no design sheet. ask: draw nothing — render: say whose sheets the panels would draw first, so that you can put it to the author ("this will first draw N design sheets"). draw: draw them first, then the panels — the default; use it once the author has agreed, or where nobody lacks a sheet. skip: this once, draw from what there is.' },
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
        if (args.sheet_first === 'ask') {
          const ahead = await sheetsAhead(env.core, runtime, [{ kind: 'panels', chapter, ...(args.force === true ? { force: true } : {}) }])
          return {
            text: ahead.unknown > 0 ? 'Nothing drawn yet. This chapter has no storyboard yet (action=storyboard): who is in its panels, and so whose design sheets they would draw first, is not known before it.'
              : ahead.people.length > 0 ? `Nothing drawn yet. The panels would first draw ${ahead.people.length} design sheet${ahead.people.length === 1 ? '' : 's'} — of ${ahead.people.map(person => person.name).join(', ')} — because they come back in the book and have none: ${ahead.people.length} more image call${ahead.people.length === 1 ? '' : 's'}. Ask the author; then render with sheet_first=draw, or sheet_first=skip to draw from what there is.`
                : 'Nothing drawn yet. No design sheet would be drawn first for these panels: render with sheet_first=draw.',
            data: toJson(ahead),
            record: false,
          }
        }
        const result = await env.job('comic', 'draw panels', chapter, async task => await renderPanels(env.core, runtime, { chapter, ...(args.force !== undefined ? { force: args.force } : {}), ...(args.sheet_first === 'skip' ? { sheetFirst: false } : {}) }, task))
        return { text: `Panels for ${result.chapterId}: ${result.rendered} drawn, ${result.failed} failed, ${result.panels} in total.${result.sheets !== undefined ? ` Drawn first, because they come back in the book and had none: the design sheet of ${result.sheets.join(', ')} — tell the author.` : ''}${result.unheld !== undefined ? ` ${result.unheld} of the panels went without reference pictures they were to be held against — the image service did not take them: who they show came from the words alone. Tell the author.` : ''}`, data: toJson(result) }
      },
    }),

    novelTool(service, {
      name: 'novel_play',
      description: [
        'Interludes: a playable scene branched off the canon, where the author steps into a character (or directs) and a director model plays everyone else. Nothing in the manuscript changes until the scene is novelized.',
        '- action=start: set up a scene — `situation` (required), `cast` (characters present), `player` (the character the author plays; omit to let them direct), `anchor` (chapter it branches from; default the latest written), `location`, `tone`. The author then plays it in Novel Studio → Stage, with portraits, voices and ambience.',
        '- action=turn: play one turn here in the chat on the author\'s behalf (`session`, `text` = what they say or do).',
        '- action=list / action=read (`session`): see interludes and their logs.',
        '- action=novelize (`session`, optional `title`): rewrite the scene as a chapter and add it after its anchor — or, with as=line, as the first chapter of a line of the plot of its own that leaves after the anchor (`choice`: what is decided to go that way; the player\'s first move when left out): what was played is then another way the story goes, beside what is written, and can be gone on with (novel_derive line=…), joined to another line or made the main one (novel_outline).   - action=discard (`session`).',
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
        as: { type: 'string', enum: ['chapter', 'line'], description: 'novelize: a chapter after the anchor (default), or a line of the plot of its own.' },
        choice: { type: 'string', description: 'novelize as=line: what is decided to go this way.' },
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
        const result = await env.job('play', 'novelize', id, async task => await novelizePlay(env.core, runtime, { session: id, ...(args.title !== undefined ? { title: args.title } : {}), ...(args.as === 'line' ? { as: 'line' as const } : {}), ...(args.choice !== undefined ? { choice: args.choice } : {}) }, task))
        return { text: `Novelized the interlude as chapter "${result.title}" (${result.chapterId}), ${result.words} words${result.line !== undefined ? `, the first chapter of the new line of the plot "${result.line.title}" (${result.line.id})` : ''}. Check where it sits in the outline (novel_status).`, data: toJson(result) }
      },
    }),
  ]
}

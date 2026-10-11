// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Tools that make the whole Studio reachable from the conversation: its
 * settings, its screens, and the small hand edits the screens offer. With
 * these, nothing the Studio can do needs a click — the screens stay for
 * reading, checking and fine-tuning.
 */
import { audition, clearAudioScript, isSkipped, removeAudioLine, updateAudioLine } from '../../core/pipelines/audio'
import { soundSetup } from '../../core/media/sound'
import { addCue, updateCue } from '../../core/pipelines/sound'
import { listWalkOns, settleWalkOn } from '../../core/walkons'
import { siftCast } from '../../core/pipelines/cast'
import { overrule, settleSuggestions, settlesItself } from '../../core/pipelines/settle'
import { artDirectionOf, pictureWhole } from '../../core/pipelines/illustrate'
import { cleanGuides, guidePictures } from '../../core/pipelines/guides'
import { clearComicBoard, removeComicPanel, updateComicPanel } from '../../core/pipelines/comic'
import { rewindPlay, setPlayOutcome } from '../../core/pipelines/play'
import { clearReview, resolveIssue } from '../../core/pipelines/review'
import { findPicturePress, findSoundPress } from '../../core/media/press'
import { publishSite, siteChaptersUpTo, siteFolder } from '../../core/pipelines/site'
import { ProjectError } from '../../core/project'
import { readStub } from '../../core/util/vault'
import type { DeepPartial } from '../../core/settings'
import { describeRow, rangeStart, summarize, type UsageRange } from '../../core/usage'
import type { NovelService } from '../../host/service'
import { hostOf, PROJECT_HOMEPAGE, SERVICES, type ServiceId, type SetupPart } from '../../shared/services'
import { FFMPEG_INSTALL } from '../../shared/text'
import type { AmbiencePreset, CameraMove, HistoryKind, IllustrationInfo, IllustrationPiece, ModelRoute, NovelSettings, ProjectManifest, SoundKind, TextRole } from '../../shared/types'
import { changedFields, HISTORY_KINDS, sayValue } from '../../shared/history'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

/** What a history is kept of, as the showrunner names it. */

/** What each part of a picture's subject is, said for the showrunner. */
const PIECE_NAMES: Record<IllustrationPiece['of'], string> = {
  use: 'what the picture is for',
  picture: 'the picture, in the author\'s words',
  frame: 'how it is framed',
  look: 'how it looks',
  outfit: 'the outfit worn (in a portrait of a moment: what they wear in that moment, as the director read it off the text around it)',
  setting: 'what is around them in the moment, as the director read it off the text',
  expression: 'expression',
  ask: 'asked of this one picture',
  composed: 'composed by the director',
  scene: 'the moment of the book the portrait shows (one of the signature scenes the card keeps under visual.scenes)',
  change: 'what to change in the picture that went along',
  place: 'how the place it is set in looks, as the bible has it',
  thing: 'how a thing it shows looks, as the bible has it',
}

/** Everything on record of how one picture was made, in the order its prompt was sent. */
export function pictureRecord(image: IllustrationInfo): string {
  const parts = image.parts
  const references = parts?.references ?? []
  const made = [image.model, image.provider !== undefined ? `through ${image.provider}` : undefined, image.size !== undefined ? `asked for ${image.size}` : undefined].filter((part): part is string => part !== undefined)
  const wire = [
    image.sent !== undefined ? 'What the image model was sent, word for word:' : 'The prompt as the Studio put it together (drawn before the words as sent were kept; things to keep out were attached separately):',
    '<<<',
    image.sent?.prompt ?? image.prompt,
    '>>>',
    ...(image.sent?.negative !== undefined ? [`Negative prompt, in a field of its own: ${image.sent.negative}`] : []),
    ...(image.sent?.size !== undefined ? [`Size sent to the service: ${image.sent.size}`] : []),
    ...(image.sent?.seed !== undefined ? [`Seed it was drawn from: ${image.sent.seed}`] : []),
    ...(image.sent?.compact?.asked === true ? [image.sent.compact.failed === true ? 'What the author asked of this one could not be worked into the prompt by the director: it went as a line of its own, in their words.' : 'What the author asked of this one was worked into the prompt by the director (the parts it speaks of were changed; it is no line of its own).'] : []),
    ...(image.sent?.compact?.replaced !== undefined && image.sent.compact.replaced.length > 0 ? [`Left to a reference picture the author gave, and taken out of the words for that: ${image.sent.compact.replaced.map(words => `"${words}"`).join(', ')}`] : []),
    ...(image.sent?.compact !== undefined ? [image.sent.compact.failed === true ? (image.sent.compact.limit !== undefined ? `The prompt came to about ${image.sent.compact.from} tokens and the model reads ${image.sent.compact.limit}; it could not be fitted and went as it was — the model did not read its end.` : 'The director could not write the prompt out from the brief; the brief went as the Studio laid it out.') : `The director wrote the prompt that was sent from the Studio's brief${image.sent.compact.limit !== undefined ? ` (the model reads ${image.sent.compact.limit} tokens)` : ''}: about ${image.sent.compact.from} tokens → about ${image.sent.compact.tokens ?? image.sent.compact.from}. The brief as the Studio laid it out and the prompt that was sent differ for that reason.`] : []),
  ]
  // Another picture, changed in one thing: that picture and the change are all that went.
  if (parts?.base !== undefined) {
    const base = parts.base
    return [
      `Picture ${image.id}: ${image.kind}${image.target !== undefined ? ` of ${image.target}` : ''} — ${image.path}`,
      `Drawn ${image.createdAt}${made.length > 0 ? `, ${made.join(', ')}` : ''}.`,
      `It is another picture changed in one thing. That picture — ${references[0] !== undefined ? references[0].path : '(not on record)'} — went to the image model with what to change in it, and with nothing else: no description, no art direction, nothing to keep out. To see what the picture it came from was made of, look at that one's record (action=show_image id=<its path>).`,
      `- what to change: ${parts.subject}`,
      ...wire,
      'What it shows in words — none of this was sent; it is what the picture is drawn from when it is drawn again from words (novel_illustrate redraw=… subject=…):',
      `- subject: ${base.subject}`,
      base.style !== undefined ? `- art direction: ${base.style}` : '- art direction: none',
      `- kept out: ${base.avoid !== undefined && base.avoid.length > 0 ? base.avoid.join(', ') : 'nothing'}`,
      ...(base.references !== undefined && base.references.length > 0 ? [`- held against: ${base.references.map(reference => `${reference.label} — ${reference.path}`).join('; ')}`] : []),
    ].join('\n')
  }
  const lines = [
    `Picture ${image.id}: ${image.kind}${image.target !== undefined ? ` of ${image.target}` : ''} — ${image.path}`,
    `Drawn ${image.createdAt}${made.length > 0 ? `, ${made.join(', ')}` : ''}.`,
    'Its prompt was put together from, in the order sent:',
    ...(parts?.pieces !== undefined && parts.pieces.length > 0
      ? parts.pieces.map(piece => `- ${piece.of === 'scene' && piece.from === 'asked' ? `the moment the director picked for this portrait alone, guided by what the author asked ("${piece.asked ?? ''}" — not itself in the prompt)` : PIECE_NAMES[piece.of]}${piece.of === 'look' ? (piece.from === 'anchor' ? ' (the look written for pictures: on an entry, or the phrases an older card kept beside the appearance)' : ' (the appearance on the card / what the entry says of itself)') : ''}: ${piece.text}`)
      : [`- subject: ${parts?.subject ?? '(not recorded apart from the whole prompt below)'}`]),
    ...(parts?.clipped === true ? ['- (the subject was too long and was cut to leave room for the lines after it)'] : []),
    ...(parts?.referenceNote !== undefined ? [`- what the references are for: ${parts.referenceNote}`] : []),
    parts?.style !== undefined ? `- art direction (${parts.styleSource === 'book' ? 'the book\'s own' : parts.styleSource === 'studio' ? 'the Studio-wide one' : 'the built-in starting point'}): ${parts.style}` : '- art direction: none (sent as written)',
    `- kept out: ${parts?.avoid !== undefined && parts.avoid.length > 0 ? parts.avoid.join(', ') : 'nothing'}`,
    references.length > 0
      ? `Reference pictures that went with it: ${references.map((reference, index) => `#${index + 1} ${reference.label} — ${reference.path}${reference.front === true ? ' (a design sheet: only its front view was sent — handed all three figures, an image model draws three people)' : ''}`).join('; ')}. A picture drawn against a reference takes after it: look at that one's record too (action=show_image id=<its path>).`
      : parts?.referenceNote !== undefined
        ? 'The prompt speaks of reference pictures, but none went: this way to the image model takes no pictures.'
        : 'No reference picture went with it: it was drawn from the words alone.',
    ...wire,
  ]
  return lines.join('\n')
}

const ROLES: TextRole[] = ['writer', 'analyst', 'architect', 'director', 'producer']
const VIEWS = ['home', 'bible', 'outline', 'write', 'read', 'listen', 'cast', 'review', 'stage', 'settings', 'setup', 'usage'] as const
const STAGE_TABS = ['production', 'comic', 'play', 'gallery', 'audio'] as const
const BOOK_FIELDS = ['title', 'author', 'language', 'genre', 'logline', 'premise', 'themes', 'targetWords', 'chapterBudget', 'chapterWords', 'artStyle', 'artAvoid', 'storyboard', 'cover', 'notes', 'activeStyle', 'models', 'crew', 'image', 'tts', 'sound', 'embedding', 'vision', 'context', 'parallel'] as const
const SECTIONS = ['models', 'crew', 'context', 'embedding', 'vision', 'image', 'tts', 'sound', 'textConcurrency', 'autoDigest', 'reviewAgentRevisions', 'prices'] as const
/** A key must never travel through the conversation; these names are refused wherever they appear. */
const SECRET_FIELD = /^(api[-_]?key|key|secret|token|password|authorization)$/i

function describeRoute(route: ModelRoute | undefined): string {
  if (route === undefined) return 'follows the chat model'
  const where = route.baseURL !== undefined ? `${hostOf(route.baseURL) ?? route.baseURL}` : `Harness provider "${route.provider}"`
  const extras = [route.reasoningEffort !== undefined ? `reasoning ${route.reasoningEffort}` : undefined, route.temperature !== undefined ? `temperature ${route.temperature}` : undefined, route.maxTokens !== undefined ? `replies capped at ${route.maxTokens} tokens` : undefined].filter(Boolean)
  return `${route.model} via ${where}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`
}

/** The model that looks at pictures is one of DSH's, like every text model: a provider of DSH's and a model of it. */
function checkVision(value: unknown): void {
  if (value === undefined || value === null) return
  const route = value as Partial<ModelRoute>
  if (route.baseURL !== undefined) throw new ProjectError('novel/invalid', '`vision` cannot take a `baseURL`: it is a model configured in DSH (its Settings → Models), sent pictures the way DSH sends them')
  if (typeof route.provider !== 'string' || route.provider.length === 0 || typeof route.model !== 'string' || route.model.length === 0) throw new ProjectError('novel/invalid', '`vision` needs a `provider` and a `model` configured in DSH — one that takes pictures')
}

/** Refuse anything that looks like a secret, at any depth. */
function assertNoSecrets(value: unknown, path = 'patch'): void {
  if (value === null || typeof value !== 'object') return
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) throw new ProjectError('novel/invalid', `"${path}.${key}" looks like a secret. Keys are never set through the conversation: open the settings with novel_show view=settings and let the author paste the key there.`)
    assertNoSecrets(inner, `${path}.${key}`)
  }
}

export function studioTools(service: NovelService) {
  return [
    novelTool(service, {
      name: 'novel_settings',
      description: [
        'Read and change how Novel Studio is set up — everything its Settings screen does, except typing keys.',
        '- action=show: which model plays each role (the writer, and the crew: analyst = continuity, architect = planner, director, producer = post-production), how each role of the crew is set to work, whether embeddings, images and speech are configured and have a key, what a ChatGPT subscription can do here, and — with a book open — the art direction and avoid list its pictures get and where each comes from.',
        '- action=setup: one-click setup for `service` (bailian, openrouter, openai, or codex for images from a ChatGPT subscription). It fills `parts` (embedding, image, tts; default all the service offers) with recommended models — text models are not set up here: every text role runs on a model of DSH\'s (its own Settings → Models) — using the key already saved for that service or found in its usual environment variable. `origin` overrides the service address (a Bailian workspace domain, a proxy).',
        '- action=studio: apply `patch` to the settings. Sections: models.{writer|analyst|architect|director|producer} = {provider, model, reasoningEffort?, temperature?, maxTokens?} — `provider` and `model` name a model configured in DSH (its Settings → Models); set a role to null to follow the chat model. crew.{analyst|architect|director|producer} = {mode: agent|call, tools: own|all, steps} — how a role of the crew works: as an agent with tools (the default) or by plain calls; with its own tools or with everything the conversation has; and how many tool calls a run may make (null resets a role). The Studio sets no output limit of its own: a reply runs as long as the model allows, and maxTokens is only a cap the author may add — a model that reasons spends its reasoning out of it, so a low cap cuts chapters, scripts and storyboards off; set it to null to remove it. context {strategy: auto (the nearest chapters word for word, the ones before as an outline) | full (as many chapters word for word as the window can hold at all) | retrieval (no chapter whole: outline, looked-up passages and the end of the chapter before — cheapest), budgetTokens: how many tokens of the manuscript\'s own text travel word for word — null for the default, half of the model\'s context window, spent in whole chapters, tailChars}; how many requests go out at once, over everything the Studio is doing (default 8, at most 256; a gate slows down by itself when its service answers "too fast" and makes the request again): textConcurrency (pieces of text work — a role\'s run on a script passage, a digest, a review), tts.concurrency (lines spoken), image.concurrency (pictures drawn), sound.concurrency (sounds made, when sound has an endpoint of its own); vision = {provider, model} — one of DSH\'s models that takes pictures: where the author gives pictures to steer a plan or a chapter and the model doing the work takes none, this one says in words what each shows (null: none); embedding / image / tts {provider, baseURL, model, …; image.lead says which picture of a person the others are held against — sheet (default: the design sheet is drawn from the words alone, a portrait and every other picture against it, and whoever lacks one gets it first; the result names it), portrait (a portrait is drawn from the words alone, the sheet against the portrait — after it where there is none — and other pictures against the sheet), none (nothing is drawn for the sake of another picture); tts.retakes = how many more times a line is spoken when a take fails the listening check, 0-4; tts.speechTags = drop (a "he said" between two spoken lines is left unspoken, as in an audio drama) | read (every word is read, as in an audiobook)}; sound {provider: auto (follow the speech setup) | qwen-audiogen | none, model, effects, music (whether the director places them), beds: generate | browser}; autoDigest; reviewAgentRevisions; prices {"<model id>": {input, output, image, minute, chars10k, currency} | null}.',
        '- action=book: change the book\'s own information with `fields` (title, author, language, genre, logline, premise, themes[], targetWords, chapterBudget, artStyle, artAvoid[], storyboard, cover, notes, activeStyle). chapterBudget is a length the book recommends for a chapter that names none of its own — set it only when the author names one; 0 takes it away, and then whoever writes a chapter judges its length. artStyle is the art direction added to every picture of the book — how to paint, and, where the author wants one, the period and its forms ("dress and buildings of the Ming"): the director writes every appearance and every look of a place or a thing in that form from then on, over what the source text says. Looks already written do not change by themselves: after changing a period or a form, derive the anchors and looks it touches again (novel_bible action=derive_visual) and draw their sheets again — and tell the author which ones. artAvoid lists what no picture of it may show (objects, motifs, lettering, architectural or religious styles the setting does not have). storyboard = {density: auto|sparse|balanced|dense, maxPanels} says how finely its motion comics are cut. cover is the project-relative path of the picture shown as its cover (any illustration; the latest drawn cover when unset). models and crew are this book\'s own settings, in the shape action=studio takes them (models.{role} = {provider, model, …} of DSH; crew.{role} = {mode, tools, steps}): a role named there is set so for this book only, whatever the Studio-wide settings say; send {} to go back to the Studio-wide ones. image, tts and sound are this book\'s own services, in the shape action=studio takes those sections: image with a `provider` is the whole image service of this book (address, model, sizes — nothing of the Studio-wide service is mixed in), image without one only this book\'s ways of drawing (lead, sheet, portraits, looks, panelThings); tts is its whole speech setup; null takes one off the book again. vision = {provider, model} is this book\'s own model for looking at pictures (see action=studio); embedding is this book\'s own semantic retrieval, whole (provider, baseURL, model); context holds the budgets it has its own way with (strategy, budgetTokens, tailChars, sideTokens, playTokens — only what is named); parallel = {text?, speech?, image?, sound?} is how many requests of a kind go out at once for this book, counted for it alone; null takes any of the three off the book. Keys are never part of them: the key saved for the address is used.',
        '- action=usage: what the Studio\'s model calls have used — tokens per role and model, pictures, minutes of speech — for the book in play and for all books, over `range` (today, 7d, 30d, all), with the cost for every model the author has priced. To price a model, action=studio with patch {prices: {"<model id>": {input, output (per million tokens), image (per picture), minute (per minute of speech), chars10k (per 10,000 characters), currency}}}. Your own turns in this conversation are counted by the Harness, not here.',
        'Keys are never passed here. When a key is missing, call novel_show view=settings and ask the author to paste it in the open screen.',
      ].join('\n'),
      mutating: args => args.action !== 'show' && args.action !== 'usage',
      parameters: {
        action: { type: 'string', required: true, enum: ['show', 'setup', 'studio', 'book', 'usage'] },
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: 'usage: the period. Default: 30d.' },
        service: { type: 'string', enum: ['bailian', 'openrouter', 'openai', 'codex'], description: 'setup: which service.' },
        parts: listParameter('setup: which slots to fill. Default: all.', { enum: ['embedding', 'image', 'tts'] as const }),
        origin: { type: 'string', description: 'setup: address of the service when it is not the public one.' },
        patch: { type: 'object', additionalProperties: true, description: 'studio: settings to change.' },
        fields: { type: 'object', additionalProperties: true, description: 'book: fields to set.' },
      },
      async run(args, env) {
        const { core } = env
        if (args.action === 'usage') {
          const range: UsageRange = args.range === 'today' || args.range === '7d' || args.range === 'all' ? args.range : '30d'
          const since = rangeStart(range)
          const events = await core.usage.read(since)
          const prices = (await core.settings.get()).prices ?? {}
          const all = summarize(events, prices, { since })
          const runtime = await service.projectOfAgent(env.agent).catch(() => undefined)
          const own = runtime !== undefined ? summarize(events.filter(event => event.book === runtime.project.root), prices, { since }) : undefined
          const begun = await core.usage.begun()
          const lines = [`Usage of the Studio's model calls, ${range === 'all' ? 'all time' : range === 'today' ? 'today' : `last ${range === '7d' ? 7 : 30} days`} (the conversation's own turns are counted by the Harness, not here).${begun !== undefined ? ` Counting began on ${begun.slice(0, 10)}: calls made before that day were never recorded, so their absence here does not mean they were free.` : ' Nothing has been recorded yet.'}`]
          if (own !== undefined) {
            lines.push('', `## This book — ${describeRow({ ...own.total, label: `"${(await runtime!.project.manifest()).title}"` })}`)
            for (const row of own.byRole) lines.push(`- ${describeRow(row)}`)
          }
          lines.push('', `## All books — ${describeRow({ ...all.total, label: 'everything' })}`, 'By model:')
          for (const row of all.byModel.slice(0, 20)) lines.push(`- ${describeRow(row)}`)
          if (all.byBook.length > 1) {
            lines.push('By book:')
            for (const row of all.byBook.slice(0, 12)) lines.push(`- ${describeRow({ ...row, label: row.label.length > 0 ? row.label : '(no book)' })}`)
          }
          if (all.unpriced.length > 0) lines.push('', `No price is set for: ${all.unpriced.join(', ')}. The author can enter what they pay under Usage in the Studio, or tell you the prices to save (action=studio, patch.prices).`)
          return { text: lines.join('\n'), data: toJson({ all: all.total, book: own?.total ?? null, unpriced: all.unpriced }) }
        }
        if (args.action === 'book') {
          const runtime = await env.project()
          const fields = (args.fields ?? {}) as Record<string, unknown>
          const patch: Record<string, unknown> = {}
          for (const key of BOOK_FIELDS) if (fields[key] !== undefined) patch[key] = fields[key]
          // A book travels; a key does not travel with it.
          assertNoSecrets({ image: fields.image, tts: fields.tts, sound: fields.sound, embedding: fields.embedding } as Record<string, unknown>)
          // A book's own models are DSH's too.
          for (const [role, route] of Object.entries((patch.models ?? {}) as Record<string, unknown>)) {
            if (!ROLES.includes(role as TextRole)) throw new ProjectError('novel/invalid', `"${role}" is not a role; roles are ${ROLES.join(', ')}`)
            const candidate = (route ?? {}) as Partial<ModelRoute>
            if (candidate.baseURL !== undefined) throw new ProjectError('novel/invalid', `models.${role} cannot take a \`baseURL\`: text roles run on models configured in DSH`)
            if (typeof candidate.provider !== 'string' || candidate.provider.length === 0 || typeof candidate.model !== 'string' || candidate.model.length === 0) throw new ProjectError('novel/invalid', `models.${role} needs a \`provider\` and a \`model\` configured in DSH`)
          }
          checkVision(patch.vision)
          const unknown = Object.keys(fields).filter(key => !(BOOK_FIELDS as readonly string[]).includes(key))
          if (Object.keys(patch).length === 0) throw new ProjectError('novel/invalid', `action=book needs \`fields\` with any of: ${BOOK_FIELDS.join(', ')}`)
          const manifest = await runtime.project.updateManifest(patch as Partial<ProjectManifest>)
          return { text: `Updated ${Object.keys(patch).join(', ')} of "${manifest.title}".${unknown.length > 0 ? ` Ignored unknown fields: ${unknown.join(', ')}.` : ''}`, data: toJson(patch) }
        }
        if (args.action === 'studio') {
          const patch = (args.patch ?? {}) as Record<string, unknown>
          assertNoSecrets(patch)
          const clean: Record<string, unknown> = {}
          for (const key of SECTIONS) if (patch[key] !== undefined) clean[key] = patch[key]
          if (Object.keys(clean).length === 0) throw new ProjectError('novel/invalid', `action=studio needs \`patch\` with any of: ${SECTIONS.join(', ')}`)
          const models = clean.models
          if (models !== undefined && models !== null && typeof models === 'object') {
            for (const [role, route] of Object.entries(models as Record<string, unknown>)) {
              if (!ROLES.includes(role as TextRole)) throw new ProjectError('novel/invalid', `"${role}" is not a role; roles are ${ROLES.join(', ')}`)
              if (route === null) continue
              const candidate = route as Partial<ModelRoute>
              if (typeof candidate.model !== 'string' || candidate.model.length === 0) throw new ProjectError('novel/invalid', `models.${role} needs a \`model\``)
              // Text models are DSH's: a role names one of its providers, never an endpoint of its own.
              if (candidate.baseURL !== undefined) throw new ProjectError('novel/invalid', `models.${role} cannot take a \`baseURL\`: text roles run on models configured in DSH (its Settings → Models). The author connects the vendor there; then name its \`provider\` and \`model\` here.`)
              if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) throw new ProjectError('novel/invalid', `models.${role} needs a \`provider\`: the id of a provider configured in DSH`)
            }
          }
          checkVision(clean.vision)
          await core.settings.update(clean as DeepPartial<NovelSettings>)
          return { text: `Settings updated: ${Object.keys(clean).join(', ')}. ${await summary(service)}` }
        }
        if (args.action === 'setup') {
          if (args.service === undefined) throw new ProjectError('novel/invalid', 'action=setup needs `service`')
          const target = args.service as ServiceId | 'codex'
          const chosen = (listOf(args.parts) ?? []).filter((part): part is SetupPart => ['embedding', 'image', 'tts'].includes(part))
          const parts: SetupPart[] = chosen.length > 0 ? chosen : target === 'codex' ? ['image'] : ['embedding', 'image', 'tts']
          const { check } = await service.applySetup({ service: target, parts, ...(args.origin !== undefined ? { origin: args.origin } : {}) })
          if (!check.ok) {
            const name = target === 'codex' ? 'a ChatGPT subscription' : SERVICES[target].name[1]
            return { text: `Could not set up ${name}: ${check.message ?? 'the key did not work'}. ${target === 'codex' ? 'The author signs in under Harness Settings → Models → Openai-Codex (Codex Connect), or runs `codex login`.' : `Nothing was changed. Call novel_show view=settings so the author can paste the ${name} key, then try again.`}` }
          }
          return { text: `Set up ${target === 'codex' ? 'images through the ChatGPT subscription' : `${SERVICES[target].name[1]} for ${parts.join(', ')}`}. ${await summary(service)}` }
        }
        // The look of the book's pictures belongs to the picture of how things are set up.
        let art = ''
        try {
          const runtime = await service.projectOfAgent(env.agent)
          if (runtime !== undefined) {
            const direction = await artDirectionOf(core, runtime)
            const origin = direction.source === 'book' ? 'set on this book' : direction.source === 'studio' ? 'the Studio-wide direction; the first picture writes it into the book' : 'the built-in starting point; the first picture writes it into the book'
            art = `\nArt direction of this book (${origin}): ${direction.style}\nNever drawn in this book: ${direction.avoid.length > 0 ? direction.avoid.join(', ') : 'nothing listed'}\nChange them with action=book fields.artStyle / fields.artAvoid.`
          }
        } catch {
          // No book in this session: the settings are still worth showing.
        }
        return { text: `${await summary(service, true)}${art}`, data: toJson({ ready: await readiness(service) }) }
      },
    }),

    novelTool(service, {
      name: 'novel_look',
      description: [
        'Look at pictures of the book: the pictures themselves come back with the result, for you to see — portraits, design sheets, design art of places and things, illustrations, storyboard panels, the cover, pictures the author brought in.',
        'Where your model takes no pictures, the model set up to look at pictures (novel_settings: vision) tells you in words what each shows instead.',
        'Use it when the author points at a picture — a reference pasted from the Studio such as 〔图：立绘 · 沈蘅｜assets/images/….png〕, "this portrait", "the cover", "the picture in chapter 3" — and before judging, comparing or changing a picture: do not guess at what a picture shows from its prompt.',
        'It reads through the Studio, so it works for a sealed book that is unlocked, where the file on disk is ciphertext and read_image cannot open it. A picture looked at is kept by DSH with this conversation, like any picture attached to it.',
        '`pictures`: ids or project-relative paths (novel_manage action=list_images lists them; a card or an entry names its own), up to 6 a call. `of`: instead of naming pictures, whose to look at — a character (their portrait and design sheet in use), a place, a faction or a thing (its design art in use), or "cover".',
        'Looking changes nothing. How a picture was made — its prompt, its references — is novel_manage action=show_image; to draw it again or change it, novel_illustrate redraw=<path>.',
      ].join('\n'),
      parameters: {
        pictures: listParameter('The pictures: ids or project-relative paths, up to 6.'),
        of: { type: 'string', description: 'Whose pictures: a character, a place, a faction or a thing by name or id — or "cover".' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        const records = await project.pictures().catch(() => [] as IllustrationInfo[])
        const asked = (listOf(args.pictures) ?? []).map(item => item.trim()).filter(item => item.length > 0)
        const paths: string[] = []
        const missing: string[] = []
        for (const item of asked) {
          // By id, by path as recorded, or by a path of the book that has no record (a picture brought in by hand).
          const path = cleanGuides([records.find(record => record.id === item || record.path === item)?.path ?? item.replace(/^\.?\//, '')])[0]?.path
          if (path !== undefined && await project.has(path)) paths.push(path)
          else missing.push(item)
        }
        const whose = args.of?.trim() ?? ''
        if (whose.length > 0) {
          if (/^(cover|封面)$/i.test(whose)) {
            const cover = await project.cover()
            const path = cover !== undefined ? cleanGuides([cover])[0]?.path : undefined
            if (path === undefined) throw new ProjectError('novel/not-found', 'the book has no cover yet')
            paths.push(path)
          } else {
            const card = await project.findCharacter(whose)
            const entry = card === undefined ? await project.findWorld(whose) : undefined
            if (card === undefined && entry === undefined) throw new ProjectError('novel/not-found', `nobody and nothing in the bible is called "${whose}"`)
            const theirs = card !== undefined ? [card.visual?.portrait, card.visual?.sheet] : [entry!.visualImage]
            const there = cleanGuides(theirs.filter((path): path is string => path !== undefined && path.length > 0)).map(guide => guide.path)
            if (there.length === 0) throw new ProjectError('novel/not-found', `"${card?.name ?? entry!.name}" has no picture yet`)
            paths.push(...there)
          }
        }
        const wanted = [...new Set(paths)]
        if (wanted.length === 0) throw new ProjectError('novel/not-found', missing.length > 0 ? `no picture of the book has the id or the path ${missing.map(item => `"${item}"`).join(', ')} — novel_manage action=list_images lists them` : 'name the pictures to look at (`pictures`), or whose (`of`)')
        const shown = wanted.slice(0, 6)
        const looked = (await guidePictures(env.core, runtime, env.task.agentRoute, shown.map(path => ({ path })), 'look', env.task))!
        const images = looked.images.length > 0 ? await service.pictureBlocks(looked.images) : []
        const notes = [
          ...(looked.by === 'vision' ? [`You were told of them by ${looked.model ?? 'the model set up to look at pictures'}: your own model takes no pictures.`] : []),
          ...(looked.by === 'titles' ? ['Nobody looked: your model takes no pictures and no model is set up to look at them (novel_settings: vision). What you have above is only what the book records of each — say so to the author rather than describing a picture you have not seen.'] : []),
          ...(wanted.length > shown.length ? [`${wanted.length - shown.length} more were asked for — six a call: ${wanted.slice(6).join(', ')}`] : []),
          ...(missing.length > 0 ? [`Not pictures of this book: ${missing.join(', ')}`] : []),
        ]
        return {
          text: `${looked.text}${notes.length > 0 ? `\n\n${notes.join('\n')}` : ''}`,
          data: toJson({ pictures: shown, by: looked.by }),
          ...(images.length > 0 ? { images } : {}),
          record: false,
        }
      },
    }),

    novelTool(service, {
      name: 'novel_show',
      description: 'Show something in Novel Studio next to the conversation: a screen (`view`: home 总览, cast 人物 — every character\'s card (looks, voice, relationships) with the table of each life, chapter by chapter along a line of the plot, the relationship graph and the walk-ons, bible 设定 — the world, the prose style and the art direction, outline 大纲, write 写作, read 观看 — the chapter as a reader meets it (the same screen holds the album of the book\'s people and its world), listen 听 — the same reader in its listening mode, where the audio drama plays and is produced, review 审校, stage 演出, settings 设置 — models, keys and services, setup 配置向导, usage 用量与成本), optionally at a `chapter`, and for the stage a `tab` (comic 有声漫, play 幕间, gallery 插图). Use it when the author asks to see, open or check something, when a key has to be pasted (view=settings), and after work the author will want to look at. It changes nothing in the project. The Studio always shows the book in play, so naming another `book` moves the session onto it.',
      book: 'switch',
      parameters: {
        view: { type: 'string', required: true, enum: [...VIEWS] },
        chapter: { type: 'string', description: 'Chapter id, number or title to open the screen at.' },
        tab: { type: 'string', enum: [...STAGE_TABS], description: 'stage: which tab — production is where every chapter\'s stage production stands, with one button for what is missing.' },
      },
      async run(args, env) {
        let chapterId: string | undefined
        let title: string | undefined
        if (args.chapter !== undefined && args.chapter.trim().length > 0) {
          const runtime = await env.project()
          const located = await runtime.project.findChapter(args.chapter)
          if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${args.chapter}"`)
          chapterId = located.plan.id
          title = located.plan.title
        }
        // The audio drama is the reader's listening mode; the stage's old audio tab leads there too.
        const listening = args.view === 'listen' || (args.view === 'stage' && args.tab === 'audio')
        const view = listening ? 'read' : args.view
        const tab = listening ? undefined : args.tab
        // The Studio's tool row reads `data` and performs the navigation in the author's window.
        return {
          text: `Opened Novel Studio at ${listening ? 'the reader, listening' : view}${tab !== undefined ? ` → ${tab}` : ''}${title !== undefined ? `, chapter "${title}"` : ''}.`,
          data: toJson({ view, ...(chapterId !== undefined ? { chapter: chapterId } : {}), ...(tab !== undefined ? { tab } : {}), ...(view === 'read' ? { mode: listening ? 'listen' : 'read' } : {}) }),
        }
      },
    }),

    novelTool(service, {
      name: 'novel_share',
      description: [
        'A book on another device: let the author read a book on a phone or tablet on the same network — listen to its audio drama, watch its motion comic — and, when they want that, change it from there.',
        '- action=status: whether it is on, which books are shared and how, and the addresses to open.',
        '- action=on: share the book in play (or `book`) and start the reader; the author is asked to confirm. `mode`=read (default) lets a device read, listen and watch, and change nothing. `mode`=edit also lets it edit the chapters\' text (a version is kept before each save, and the change goes on the book\'s record) and play the book\'s interludes, which calls the models set up on this computer. Give the author the address — it carries a secret token, so whoever has it can do what the mode allows with the shared books, and nothing else: settings, keys and other books stay out of reach. A sealed book asks every device for its password once. Their computer may ask once whether to allow incoming connections.',
        '- action=off: stop sharing this book (`all`=true: switch the reader off altogether).',
        '- action=renew: replace the address, so links given out earlier stop working.',
        '- action=publish: write the book out as a site of its own — a folder any static host serves (the same reader, the chapters, voices, motion comic, pictures, and the album of the people and the world as a reader is given it), needing neither DSH nor this computer. `out` names the folder (default: one beside the book, `<title>-site`; never inside the book\'s own); `upto` publishes the written chapters of the main line as far as that chapter (its id, number or title) and cuts the album there; listen=false, watch=false, album=false leave a part out; video=false leaves the finished videos of the chapters out (the largest files by far — the motion comic still plays); lines=false publishes the main line only (by default the other lines of the plot that are not put aside go along, for a reader to choose between — except with `upto`, which is a part of the main line). Voices and sound lie in the book uncompressed (WAV) and go out as AAC, a quarter the size and sounding the same, when this computer has ffmpeg (the result says when it has not, and they went out as WAV); press=false keeps them as WAV. Pictures the same way: the PNGs of the book go out as JPEG that looks the same, a fifth to a tenth the size (one that is see-through somewhere stays PNG); jpeg=false keeps them as they are — for an author who asks for pictures without loss. Published again into the same folder, only what changed is written, and only sound and pictures that changed are compressed again. A sealed book is not published from the conversation: what is published lies in the open, and that is the author\'s to confirm in the Studio (the phone button of the viewer → Publish as a site).',
        '`port` moves the reader to another port (default 4319) when the usual one is taken.',
      ].join('\n'),
      mutating: args => args.action !== 'status',
      parameters: {
        action: { type: 'string', required: true, enum: ['status', 'on', 'off', 'renew', 'publish'] },
        mode: { type: 'string', enum: ['read', 'edit'], description: 'on: what a device may do with the book. Default: read.' },
        all: { type: 'boolean', description: 'off: switch the reader off for every book.' },
        port: { type: 'integer', description: 'Port to listen on, 1024-65535.' },
        out: { type: 'string', description: 'publish: the folder to write the site into.' },
        upto: { type: 'string', description: 'publish: the last chapter to publish (id, number or title); everything written when left out.' },
        listen: { type: 'boolean', description: 'publish: false leaves the audio drama out.' },
        watch: { type: 'boolean', description: 'publish: false leaves the motion comic out.' },
        album: { type: 'boolean', description: 'publish: false leaves the album of the people and the world out.' },
        video: { type: 'boolean', description: 'publish: false leaves the finished videos (MP4) out.' },
        lines: { type: 'boolean', description: 'publish: false publishes the main line only.' },
        press: { type: 'boolean', description: 'publish: false publishes voices and sound uncompressed (WAV), as they lie in the book; by default they go out as AAC.' },
        jpeg: { type: 'boolean', description: 'publish: false publishes pictures as they lie in the book (PNG, megabytes each); by default PNG pictures go out as JPEG that looks the same, a fifth to a tenth the size. Only when the author asks for pictures without loss.' },
      },
      async run(args, env) {
        if (args.action === 'publish') {
          const runtime = await env.project()
          const manifest = await runtime.project.manifest()
          if (await readStub(runtime.project.root) !== undefined) throw new ProjectError('novel/invalid', 'this book is sealed, and a published site lies in the open: the author publishes it from the Studio (the phone button of the viewer → Publish as a site), where they confirm that')
          const reader = await service.share.readerScript()
          if (reader === undefined) throw new ProjectError('novel/unsupported', 'the reader\'s script (lib/reader.js) is missing from this installation')
          const chapters = typeof args.upto === 'string' && args.upto.trim().length > 0 ? await siteChaptersUpTo(runtime, args.upto) : undefined
          const press = args.press === false ? undefined : await findSoundPress()
          const pictures = args.jpeg === false ? undefined : await findPicturePress()
          const done = await env.job('export', 'publish site', undefined, async task => await publishSite(env.core, runtime, {
            out: siteFolder(runtime.project.root, manifest.title, args.out),
            reader,
            ...(press !== undefined ? { press } : {}),
            ...(pictures !== undefined ? { pictures } : {}),
            ...(chapters !== undefined ? { chapters } : {}),
            ...(args.listen === false ? { listen: false } : {}),
            ...(args.watch === false ? { watch: false } : {}),
            ...(args.album === false ? { album: false } : {}),
            ...(args.video === false ? { video: false } : {}),
            ...(args.lines === false ? { lines: false } : {}),
            credit: { name: manifest.language.toLowerCase().startsWith('zh') ? '小说工坊' : 'Novel Studio', url: PROJECT_HOMEPAGE },
          }, task))
          const megabytes = (done.bytes / 1024 / 1024).toFixed(1)
          const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
          const sound = done.sound !== undefined
            ? ` Voices and sound: ${done.sound.files} files went out as AAC, ${mb(done.sound.from)} → ${mb(done.sound.to)}.${done.sound.failed.length > 0 ? ` ${done.sound.failed.length} could not be compressed and went out as WAV (${done.sound.reason ?? 'no reason given'}): ${done.sound.failed.slice(0, 3).join(', ')}${done.sound.failed.length > 3 ? '…' : ''}.` : ''}`
            : args.press !== false && press === undefined ? ` Voices and sound went out uncompressed (WAV): compressing them needs ffmpeg, which is not on this computer (${FFMPEG_INSTALL[1]}).` : ''
          const shrunk = done.pictures !== undefined
            ? ` Pictures: ${done.pictures.files} went out as JPEG, ${mb(done.pictures.from)} → ${mb(done.pictures.to)}.${(done.pictures.kept ?? 0) > 0 ? ` ${done.pictures.kept} are see-through somewhere, which a JPEG cannot be, and went out as PNG.` : ''}${done.pictures.failed.length > 0 ? ` ${done.pictures.failed.length} could not be made JPEG and went out as PNG (${done.pictures.reason ?? 'no reason given'}): ${done.pictures.failed.slice(0, 3).join(', ')}${done.pictures.failed.length > 3 ? '…' : ''}.` : ''}`
            : args.jpeg !== false && pictures === undefined ? ` Pictures went out as they lie in the book (PNG): making them JPEG needs ffmpeg, which is not on this computer (${FFMPEG_INSTALL[1]}).` : ''
          return {
            text: `Published "${manifest.title}" as a site: ${done.chapters} chapters${done.sides > 0 ? `, ${done.sides} side stories` : ''}${(done.videos ?? 0) > 0 ? `, ${done.videos} finished videos` : ''}${done.lines !== undefined ? `, ${done.lines.lines} other lines of the plot (${done.lines.chapters} chapters of their own)` : ''}${done.album !== undefined ? `, an album of ${done.album.people} people and ${done.album.places + done.album.factions + done.album.items + done.album.ideas} entries` : ''}, ${done.files} files, ${megabytes} MB in all (${done.written} written this time${done.removed > 0 ? `, ${done.removed} left from last time removed` : ''}) in ${done.dir}.${done.missing.length > 0 ? ` ${done.missing.length} pictures or sounds the book names are not on disk and were left out.` : ''}${sound}${shrunk} The folder goes onto any static host as it is; to look at it first, serve it locally (\`npx serve\`, \`python3 -m http.server\`) — index.html opened from disk cannot read the data beside it.`,
            data: toJson(done),
          }
        }
        const describe = async (status: Awaited<ReturnType<typeof service.share.status>>): Promise<string> => {
          if (!status.enabled || status.books.length === 0) return 'Reading on other devices is off.'
          const shared = status.books.map(book => `"${book.title}" (${book.mode === 'edit' ? 'read and change' : 'read only'}${book.sealed === true ? ', sealed: asks each device for its password once' : ''})`).join(', ')
          if (!status.running) return `Reading on other devices is switched on for ${shared}, but the reader is not listening: ${status.error ?? 'unknown reason'}.`
          return [`Reading on other devices is on for ${shared}${status.instead !== undefined ? ` (port ${status.instead} was taken by another program, so it listens on ${status.port})` : ''}. On a phone or tablet on the same network, open:`, ...status.urls.map(url => `- ${url}`), 'The address carries a secret token: whoever has it can read these books. action=renew replaces it.'].join('\n')
        }
        if (args.action === 'status') {
          const status = await service.share.status()
          return { text: await describe(status), data: toJson(status) }
        }
        if (args.action === 'renew') {
          const status = await service.updateShare({ renew: true })
          return { text: `The address was replaced; earlier links no longer work.\n${await describe(status)}`, data: toJson(status) }
        }
        if (args.action === 'off' && args.all === true) {
          const status = await service.updateShare({ enabled: false })
          return { text: await describe(status), data: toJson(status) }
        }
        const runtime = await env.project()
        const status = await service.updateShare({
          ...(args.action === 'on' ? { enabled: true } : {}),
          book: { root: runtime.project.root, shared: args.action === 'on', ...(args.action === 'on' ? { mode: args.mode === 'edit' ? 'edit' as const : 'read' as const } : {}) },
          ...(args.port !== undefined ? { port: args.port } : {}),
        })
        return { text: await describe(status), data: toJson(status) }
      },
    }),

    novelTool(service, {
      name: 'novel_manage',
      description: [
        'The small hand edits Novel Studio offers on its screens, for when the author asks for one in the conversation.',
        '- action=find: exact text search across the manuscript (`query`); novel_search is for meaning.',
        '- action=restore_version: put back an earlier version of `chapter` (`version` id from novel_read what=versions).',
        '- action=resolve_issue: mark review `issue` of `chapter` as dealt with (or reopen it with resolved=false). action=delete_review: throw the whole review of `chapter` away.',
        '- action=edit_line: change line `id` of the audio script of `chapter` — `fields` {text, kind: narration|dialogue|thought, speaker (character id, "" for the narrator), direction, voiced (false leaves the line unspoken, true has a speech tag spoken after all)}.',
        '- action=edit_cue / add_cue / delete_cue: the sound cues of the audio script of `chapter` — `id` is the cue (edit, delete), `fields` {kind: bed|effect|music, at (line id), caption (what the reader sees), prompt (what the sound model is asked for), ambience (the browser\'s stand-in bed), intensity 0-1}. A changed cue keeps its old clip until sound is made again (novel_audio action=sound cues=[id]).',
        '- action=walkons: the people the page names who have no character card — where each turns up, the voice the audio drama gave them, whether they look like an existing character under another name, and what the planner said of them when it last looked through the list.',
        '- action=sift_walkons: have the planner look through those names and say of each whether it is worth a card (then it waits among the suggestions, with the reason), another name of somebody (a suggestion to fold it in), or a walk-on (left on the list, with why). A digest proposes nobody for a card by itself; this pass runs by itself after chapters were digested, on the names not looked at yet. `fields` {all: true — look at every name again, also those already judged or proposed; direction — what the author asks of the pass}. Nothing is made or folded by it: the author accepts.',
        '- action=settled: what became of the suggestions for the bible. They do not wait for the author one by one (unless the author turned that off in Settings): after chapters are digested the planner looks them over and enters what is worth entering — a place, thing, house or term, a thread, somebody worth a card — folds another name into what is there, and leaves the rest out, each with its reason. This lists what was entered, folded in and left out. `fields` {run: true — have the planner settle what waits, now}. `id` with `fields` {to: "undo" (take back what entered: the card or entry goes among the removed ones) | "enter" (enter what was left out)}: say otherwise of one of them. Tell the author what entered; a change to what somebody already wrote is never settled this way — that waits for them.',
        '- action=settle_walkon: settle one of them by `name` — `fields` {as: "card" (give them a card; role: minor|cameo), "alias" (they are character `of` under another name), "ignore" (not worth tracking), "restore"}. A new card keeps the voice they already had, and their lines in the audio scripts go to it.',
        '- action=delete_line: take line `id` out of the audio script of `chapter` (sound cues that began at it move to the next line; a storyboard panel that showed only it goes too). action=delete_script: throw the whole audio script of `chapter` away — the takes already spoken stay on disk and are reused if the same lines come back.',
        '- action=edit_panel: change panel `id` of the storyboard of `chapter` — `fields` {prompt, description, camera}. action=delete_panel: take panel `id` out (its lines go to the panel before it). action=delete_storyboard: throw the whole storyboard of `chapter` away — its pictures stay in the gallery (delete_image removes one).',
        '- action=audition: speak `text` so the author can hear a voice — `voice` (a voice id or description), or `character` to hear that character as their lines will sound; neither = the narrator (`direction` optional).',
        '- action=list_images / delete_image (`id`). action=show_image (`id`: a picture\'s id or its path): everything on record of how that picture was made — the parts its prompt was put together from, in the order sent (what kind of picture, the appearance or look restated, what was asked of this one, what the references are for, the art direction, what was kept out), which pictures went along as references, and the words the image model was sent. When the author asks why a picture came out as it did, read this before anything else: the answer is a word in the anchor, a reference picture, the art direction — or none of them.',
        '- action=history: how a card, an entry of the bible, a style, a chapter\'s plan, a thread, the book\'s own info, a volume, a line of the plot, the table of ties, a chapter\'s audio script or its storyboard was before it was changed — `fields` {kind: character|world|style|plan|thread|book|volume|line|ties|script|board, of: its name or id (a chapter for plan, script and board; nothing for book and ties)}. A version is kept each time what the thing says is about to change, named by when and by what changed it (the author, you, a job, a restore, its deletion). With `version`: the fields in which that version and the thing as it is now differ, both sides. Without `fields`: the cards and entries that were deleted and can be had back. Pictures are no part of a version — a picture stays until somebody deletes it. (A chapter\'s text has versions of its own: novel_read what=versions.)',
        '- action=restore_history: put `version` of that thing back — `fields` {kind, of, only: [field paths, as action=history names them — "tagline", "visual.prompt"]}; without `only`, the whole version. A card that was deleted comes back as it last was. What the thing was until then is itself kept as a version, so this can be undone; its pictures stay as they are now. Say what you put back.',
        '- action=rewind_interlude / keep_interlude (as a side story) / delete_interlude (`session`).',
        '- action=lock_book: lock the book in play (or `book`) when it is sealed — its key is forgotten, and it cannot be read by anyone, you included, until the author unlocks it in the Studio. You cannot unlock a book, seal one or take a seal off: those are done by the author on the Studio\'s screens, where the password is typed.',
        '- action=delete_book: take the book in play (or `book`) off the shelf. Its own files — manuscript, bible, outline, pictures, audio — are moved to the system trash, where the author can put them back; anything else in its folder stays. Only when the author asked for exactly this; they are asked to confirm.',
      ].join('\n'),
      mutating: args => args.action !== 'find' && args.action !== 'list_images' && args.action !== 'show_image' && args.action !== 'walkons' && args.action !== 'history' && !(args.action === 'settled' && args.id === undefined && (args.fields as { run?: unknown } | undefined)?.run !== true),
      parameters: {
        action: { type: 'string', required: true, enum: ['find', 'restore_version', 'resolve_issue', 'delete_review', 'edit_line', 'delete_line', 'delete_script', 'edit_cue', 'add_cue', 'delete_cue', 'edit_panel', 'delete_panel', 'delete_storyboard', 'walkons', 'sift_walkons', 'settled', 'settle_walkon', 'audition', 'list_images', 'show_image', 'delete_image', 'history', 'restore_history', 'rewind_interlude', 'keep_interlude', 'delete_interlude', 'lock_book', 'delete_book'] },
        chapter: { type: 'string' },
        id: { type: 'string', description: 'Line, cue, panel or image id (show_image also takes the picture\'s path).' },
        name: { type: 'string', description: 'settle_walkon: the name as the page writes it.' },
        version: { type: 'string' },
        issue: { type: 'string' },
        resolved: { type: 'boolean' },
        session: { type: 'string', description: 'Interlude id.' },
        query: { type: 'string' },
        text: { type: 'string' },
        voice: { type: 'string' },
        character: { type: 'string', description: 'audition: hear this character\'s voice.' },
        direction: { type: 'string' },
        fields: { type: 'object', additionalProperties: true },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        const need = <T>(value: T | undefined, name: string): T => {
          if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) throw new ProjectError('novel/invalid', `action=${args.action} needs \`${name}\``)
          return value
        }
        const fields = (args.fields ?? {}) as Record<string, unknown>
        const text = (name: string): string | undefined => (typeof fields[name] === 'string' ? fields[name] as string : undefined)
        switch (args.action) {
          case 'find': {
            const needle = need(args.query, 'query').trim()
            const folded = needle.toLowerCase()
            const hits: string[] = []
            let total = 0
            for (const chapter of await project.chapters()) {
              const body = await project.chapterText(chapter.plan.id)
              const haystack = body.toLowerCase()
              for (let at = haystack.indexOf(folded); at >= 0; at = haystack.indexOf(folded, at + folded.length)) {
                total += 1
                if (hits.length < 30) hits.push(`${chapter.index}. ${chapter.plan.title} @${at}: …${body.slice(Math.max(0, at - 24), at + needle.length + 40).replace(/\n/g, ' ')}…`)
              }
            }
            return { text: total === 0 ? `"${needle}" does not occur in the manuscript.` : `"${needle}" occurs ${total} time(s)${total > hits.length ? `; the first ${hits.length}` : ''}:\n${hits.join('\n')}`, data: toJson({ total }) }
          }
          case 'restore_version': {
            const located = await project.findChapter(need(args.chapter, 'chapter'))
            if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${args.chapter}"`)
            const ok = await project.restoreVersion(located.plan.id, need(args.version, 'version'))
            if (!ok) throw new ProjectError('novel/not-found', `"${located.plan.title}" has no version "${args.version}"`)
            return { text: `Restored "${located.plan.title}" to version ${args.version}. The text in place was kept as a new version. Digest the chapter again (novel_digest).` }
          }
          case 'resolve_issue': {
            const resolved = args.resolved !== false
            const done = await resolveIssue(runtime, need(args.chapter, 'chapter'), need(args.issue, 'issue'), resolved)
            if (done === undefined) throw new ProjectError('novel/not-found', `no such review issue`)
            return { text: `Issue ${args.issue} ${resolved ? 'marked as dealt with' : 'reopened'}.` }
          }
          case 'delete_review': {
            const done = await clearReview(runtime, need(args.chapter, 'chapter'))
            return { text: done.removed ? `The review of ${done.chapterId} is gone; review it again with novel_review.` : `${done.chapterId} had no review.` }
          }
          case 'delete_line': {
            const done = await removeAudioLine(runtime, need(args.chapter, 'chapter'), need(args.id, 'id'))
            return { text: `Line ${args.id} is out of the script (${done.script.lines.length} lines left)${done.panels > 0 ? `; ${done.panels} storyboard panel(s) that showed only it went with it` : ''}.` }
          }
          case 'delete_script': {
            const done = await clearAudioScript(runtime, need(args.chapter, 'chapter'))
            return { text: done.removed ? `The audio script of ${done.chapterId} is gone. Takes already spoken are still on disk; direct the chapter again with novel_audio action=script.` : `${done.chapterId} had no audio script.` }
          }
          case 'delete_panel': {
            const board = await removeComicPanel(runtime, need(args.chapter, 'chapter'), need(args.id, 'id'))
            return { text: `Panel ${args.id} is out of the storyboard (${board.panels.length} panels left); its lines went to a neighbouring panel, and its picture is still in the gallery.` }
          }
          case 'delete_storyboard': {
            const done = await clearComicBoard(runtime, need(args.chapter, 'chapter'))
            return { text: done.removed ? `The storyboard of ${done.chapterId} is gone; the pictures drawn for it are still in the gallery. Cut it again with novel_comic action=storyboard.` : `${done.chapterId} had no storyboard.` }
          }
          case 'edit_line': {
            const kind = text('kind')
            if (kind !== undefined && !['narration', 'dialogue', 'thought'].includes(kind)) throw new ProjectError('novel/invalid', 'kind is narration, dialogue or thought')
            const script = await updateAudioLine(runtime, need(args.chapter, 'chapter'), need(args.id, 'id'), {
              ...(text('text') !== undefined ? { text: text('text')! } : {}),
              ...(kind !== undefined ? { kind: kind as 'narration' | 'dialogue' | 'thought' } : {}),
              ...(text('speaker') !== undefined ? { speaker: text('speaker')! } : {}),
              ...(text('direction') !== undefined ? { direction: text('direction')! } : {}),
              ...(typeof fields.voiced === 'boolean' ? { voiced: fields.voiced } : fields.voiced === null ? { voiced: null } : {}),
            })
            const line = script.lines.find(entry => entry.id === args.id)
            const silent = line !== undefined && isSkipped(line, (await env.core.settingsOf(runtime)).tts)
            return { text: `Line ${args.id} is now: [${line?.speakerName ?? 'narrator'}] ${brief(line?.text, 120)}${silent ? ' — left unspoken' : ''}.${silent ? '' : ' Synthesize the chapter again to hear it.'}` }
          }
          case 'edit_cue':
          case 'delete_cue': {
            const chapter = need(args.chapter, 'chapter')
            const cue = need(args.id, 'id')
            if (args.action === 'delete_cue') {
              await updateCue(runtime, { chapter, cue, remove: true })
              return { text: `Sound cue ${cue} removed.` }
            }
            const sound = text('kind')
            if (sound !== undefined && !['bed', 'effect', 'music'].includes(sound)) throw new ProjectError('novel/invalid', 'kind is bed, effect or music')
            const script = await updateCue(runtime, { chapter, cue, patch: {
              ...(sound !== undefined ? { kind: sound as SoundKind } : {}),
              ...(text('at') !== undefined ? { at: text('at')! } : {}),
              ...(text('caption') !== undefined ? { caption: text('caption')! } : {}),
              ...(text('prompt') !== undefined ? { prompt: text('prompt')! } : {}),
              ...(text('ambience') !== undefined ? { ambience: text('ambience') as AmbiencePreset } : {}),
              ...(typeof fields.intensity === 'number' ? { intensity: fields.intensity } : {}),
            } })
            const now = script.cues.find(entry => entry.id === cue)
            return { text: `Sound cue ${cue} is now: ${now?.kind ?? 'bed'} at ${now?.at} — ${now?.caption ?? now?.prompt ?? now?.ambience}.${now?.audio !== undefined ? ' Its clip is the old one until sound is made again (novel_audio action=sound cues=[…]).' : ''}` }
          }
          case 'add_cue': {
            const sound = text('kind') ?? 'effect'
            if (!['bed', 'effect', 'music'].includes(sound)) throw new ProjectError('novel/invalid', 'kind is bed, effect or music')
            const added = await addCue(runtime, {
              chapter: need(args.chapter, 'chapter'),
              at: need(text('at'), 'fields.at'),
              kind: sound as SoundKind,
              ...(text('caption') !== undefined ? { caption: text('caption')! } : {}),
              ...(text('prompt') !== undefined ? { prompt: text('prompt')! } : {}),
              ...(text('ambience') !== undefined ? { ambience: text('ambience') as AmbiencePreset } : {}),
              ...(typeof fields.intensity === 'number' ? { intensity: fields.intensity } : {}),
            })
            return { text: `Added sound cue ${added.cue.id}: ${added.cue.kind} at ${added.cue.at} — ${added.cue.caption ?? added.cue.prompt ?? added.cue.ambience}. It is a note beside the text now; novel_audio action=sound cues=["${added.cue.id}"] makes it audible.`, data: toJson(added.cue) }
          }
          case 'walkons': {
            const list = await listWalkOns(project, { ignored: true })
            const shown = list.filter(item => item.ignored !== true)
            if (shown.length === 0) return { text: `Nobody on the page is without a card${list.length > 0 ? ` (${list.length} names were taken off the list by the author)` : ''}.` }
            const cards = await project.characters()
            const lines = shown.slice(0, 60).map((item) => {
              const near = item.near !== undefined ? cards.find(card => card.id === item.near)?.name : undefined
              return `- ${item.name}: ${item.chapters.length} chapter(s)${item.lines > 0 ? `, ${item.lines} spoken lines` : ''}${item.voice !== undefined ? `, voice "${brief(item.voice, 40)}"` : ''}${near !== undefined ? ` — may be ${near} under another name` : ''}${item.suggestion !== undefined ? ' — a card is suggested' : ''}${item.verdict !== undefined ? ` — the planner: ${item.verdict.is === 'walkon' ? 'a walk-on' : item.verdict.is === 'alias' ? `another name of ${item.verdict.same ?? 'somebody'}` : 'worth a card'}${item.verdict.why !== undefined ? ` (${brief(item.verdict.why, 80)})` : ''}` : ' — not looked at by the planner yet'}${item.note !== undefined ? ` — ${brief(item.note, 80)}` : ''}`
            })
            return { text: `${shown.length} people on the page have no card${shown.length > lines.length ? ` (the ${lines.length} most present are listed)` : ''}:\n${lines.join('\n')}\nNot every passer-by needs one: give a card to those the story will come back to, fold other names of an existing character into their aliases (action=settle_walkon), and leave the rest.`, data: toJson(shown) }
          }
          case 'sift_walkons': {
            const runtime = await env.project()
            const done = await env.job('bible', 'sift cast', undefined, async task => await siftCast(env.core, runtime, { ...(fields.all === true ? { all: true } : {}), ...(text('direction') !== undefined ? { direction: text('direction')! } : {}) }, task))
            if (done.looked === 0 && done.failed.length === 0) return { text: 'No name without a card is new since the planner last looked (fields.all=true looks at every one again).' }
            return {
              text: [
                `The planner looked at ${done.looked} name(s) without a card.`,
                done.cards.length > 0 ? `Worth a card (${done.cards.length}; each waits among the suggestions with the reason — tell the author, they accept): ${done.cards.join(', ')}.` : 'None of them is worth a card yet.',
                done.aliases.length > 0 ? `Another name of somebody (${done.aliases.length}; each waits as a suggestion to fold it in): ${done.aliases.map(item => `${item.name} → ${item.of}`).join(', ')}.` : '',
                `${done.walkOns} left as walk-ons — they stay on the list (action=walkons) with what the planner said of each, and are looked at again when they turn up in more chapters.`,
                done.failed.length > 0 ? `Not done: ${done.failed.map(item => `${item.step} (${item.error})`).join('; ')}.` : '',
              ].filter(line => line.length > 0).join('\n'),
              data: toJson(done),
            }
          }
          case 'settled': {
            const runtime = await env.project()
            if (typeof args.id === 'string' && args.id.length > 0) {
              const item = await overrule(runtime, args.id, fields.to === 'enter' ? 'enter' : 'undo')
              return { text: `"${item.title}" is now ${item.verdict === 'entered' ? 'in the bible' : item.verdict === 'undone' ? 'taken back out of it (a card or an entry is among the removed ones)' : item.verdict}.`, record: { summary: [`${item.verdict === 'entered' ? '收进' : '撤回'}设定建议：${item.title}`, `${item.verdict === 'entered' ? 'Entered' : 'Took back'} a suggestion: ${item.title}`] } }
            }
            let ran = ''
            if (fields.run === true) {
              const done = await env.job('bible', 'settle suggestions', undefined, async task => await settleSuggestions(env.core, runtime, task))
              ran = `The planner settled ${done.looked} suggestion(s): ${done.entered.length} entered${done.entered.length > 0 ? ` (${done.entered.slice(0, 20).join(', ')})` : ''}, ${done.merged.length} folded in${done.merged.length > 0 ? ` (${done.merged.slice(0, 12).map(item => `${item.name} → ${item.into}`).join(', ')})` : ''}, ${done.skipped} left out.${done.failed.length > 0 ? ` Not done: ${done.failed.map(item => `${item.step} (${item.error})`).join('; ')}.` : ''}\n`
            }
            const items = await project.settled()
            const waiting = (await project.suggestions()).length
            if (items.length === 0) return { text: `${ran}Nothing has been settled of the suggestions yet${waiting > 0 ? ` (${waiting} wait${settlesItself(env.core) ? '; fields.run=true settles them now' : ' for the author: settling by the planner is off in Settings'})` : ''}.` }
            const line = (item: (typeof items)[number]): string => `- [${item.id}] ${item.kind} "${item.title}"${item.verdict === 'merged' ? ` → folded into "${item.into ?? ''}"` : ''}${item.why !== undefined ? ` — ${brief(item.why, 120)}` : ''}`
            const of = (verdicts: string[]): string => items.filter(item => verdicts.includes(item.verdict)).slice(0, 40).map(line).join('\n') || '(none)'
            return { text: `${ran}Entered by the planner:\n${of(['entered', 'merged'])}\nLeft out:\n${of(['skipped', 'undone'])}${waiting > 0 ? `\n${waiting} suggestion(s) still wait.` : ''}`, data: toJson({ settled: items.slice(0, 120) }) }
          }
          case 'settle_walkon': {
            const how = text('as') ?? 'card'
            if (!['card', 'alias', 'ignore', 'restore'].includes(how)) throw new ProjectError('novel/invalid', 'fields.as is card, alias, ignore or restore')
            const role = text('role')
            const settled = await settleWalkOn(project, {
              name: need(args.name ?? text('name'), 'name'),
              action: how as 'card' | 'alias' | 'ignore' | 'restore',
              ...(text('of') !== undefined ? { target: text('of')! } : {}),
              ...(role === 'minor' || role === 'cameo' || role === 'supporting' ? { role } : {}),
            })
            if (how === 'ignore' || how === 'restore') return { text: how === 'ignore' ? `"${args.name ?? text('name')}" is off the list of people without a card.` : `"${args.name ?? text('name')}" is back on the list.` }
            return {
              text: how === 'alias'
                ? `"${args.name ?? text('name')}" is now an alias of ${settled.card?.name}${settled.lines > 0 ? `; ${settled.lines} lines in the audio scripts now belong to that character and will be voiced as them at the next synthesize` : ''}.`
                : `${settled.card?.name} has a card now (${settled.card?.id}, ${settled.card?.role})${settled.lines > 0 ? `; ${settled.lines} lines in the audio scripts belong to it and keep the voice they had` : ''}. Fill it in with novel_bible when they start to matter.`,
              ...(settled.card !== undefined ? { data: toJson(settled.card) } : {}),
            }
          }
          case 'edit_panel': {
            const board = await updateComicPanel(runtime, need(args.chapter, 'chapter'), need(args.id, 'id'), {
              ...(text('prompt') !== undefined ? { prompt: text('prompt')! } : {}),
              ...(text('description') !== undefined ? { description: text('description')! } : {}),
              ...(text('camera') !== undefined ? { camera: text('camera') as CameraMove } : {}),
            })
            const panel = board.panels.find(entry => entry.id === args.id)
            return { text: `Panel ${args.id} updated${panel?.image === undefined ? '; it has no picture now — draw it with novel_comic action=render' : ''}.` }
          }
          case 'audition': {
            const sample = await audition(env.core, runtime, { text: need(args.text, 'text'), ...(args.voice !== undefined ? { voice: args.voice } : {}), ...(args.character !== undefined ? { character: args.character } : {}), ...(args.direction !== undefined ? { direction: args.direction } : {}) }, env.task)
            return { text: `Audition sample (${sample.duration}s) saved at ${sample.path}; the author can play it from the character's card in Novel Studio → Bible.`, data: toJson(sample) }
          }
          case 'lock_book': {
            const lock = await env.core.lockOf(project.root)
            if (!lock.sealed) return { text: 'This book is not sealed, so there is nothing to lock. Sealing a book — encrypting all of its files — is done by the author in Novel Studio (the book menu → Seal and lock), where they choose its password.', record: false }
            const title = (await project.manifest()).title
            await env.core.lockBook(project.root)
            return { text: `"${title}" is locked. Nothing of it can be read until the author unlocks it in Novel Studio; do not rely on what you remember of it.`, record: false }
          }
          case 'delete_book': {
            const removed = await service.deleteBook(project.root)
            const where = removed.where === 'trash' ? 'the system trash' : removed.where === 'holding' ? 'a holding folder of the Studio (the system trash could not be reached)' : 'a folder beside where the book was (it could be moved nowhere else)'
            return {
              text: `"${removed.title}" is off the shelf. Its files are in ${where}: ${removed.path}. Nothing was erased — moving that folder's contents back restores the book.${removed.left.length > 0 ? ` Left in place, because they were not the book's: ${removed.left.slice(0, 12).join(', ')}.` : ''} This conversation is on no book now.`,
              data: toJson(removed),
            }
          }
          case 'list_images': {
            const images = await project.illustrations()
            if (images.length === 0) return { text: 'No illustrations yet.' }
            return { text: `${images.map(image => `- ${image.id}: ${image.kind}${image.target !== undefined ? ` of ${image.target}` : ''} — ${image.path}`).join('\n')}\nHow one of them was made — its prompt, its references: action=show_image id=<id>.`, data: toJson(images.map(image => ({ id: image.id, kind: image.kind, path: image.path }))) }
          }
          case 'show_image': {
            const wanted = need(args.id, 'id').trim()
            const image = (await project.illustrations()).find(item => item.id === wanted || item.path === wanted)
            if (image === undefined) throw new ProjectError('novel/not-found', `no picture has the id or the path "${wanted}" — action=list_images lists them`)
            // …and what it is drawn again by, where the author wants a word of the prompt itself changed.
            const whole = await pictureWhole(env.core, runtime, image.id).catch(() => undefined)
            const again = whole === undefined ? '' : whole.changed === true ? [
              '',
              // Made of a picture and a sentence: drawn again by its prompt, that picture is changed again.
              `Its prompt is the sentence that changed ${whole.references[0]?.path ?? 'the picture it came from'} — to have that picture changed again by other words, hand the sentence back rewritten (novel_illustrate redraw=<this picture> whole=<the sentence>); the picture it came from goes with it and nothing else, and the result takes this picture's place:`,
              '<<<',
              whole.prompt,
              '>>>',
            ].join('\n') : [
              '',
              'The whole prompt — to draw it again with a word of it changed, hand this back rewritten (novel_illustrate redraw=<this picture> whole=<the prompt> avoid=[what is kept out, all of it]); it goes as it stands, with the reference pictures above:',
              '<<<',
              whole.prompt,
              '>>>',
              `Kept out: ${whole.avoid.length > 0 ? whole.avoid.join(', ') : 'nothing'}`,
            ].join('\n')
            return { text: `${pictureRecord(image)}${again}`, data: toJson(image), record: false }
          }
          case 'history':
          case 'restore_history': {
            const removed = await project.removedCards()
            if (args.action === 'history' && fields.kind === undefined) {
              if (removed.length === 0) return { text: 'Nothing that was deleted is waiting to be had back. To see the versions of something: fields {kind, of}.', record: false }
              return { text: `Deleted, and to be had back as they last were (action=restore_history fields={kind, of} version=<version>):\n${removed.map(item => `- ${item.kind} "${item.name}" (${item.id}), deleted ${item.at} — version ${item.version}`).join('\n')}`, data: toJson(removed), record: false }
            }
            const kind = HISTORY_KINDS.find(item => item === fields.kind)
            if (kind === undefined) throw new ProjectError('novel/invalid', `fields.kind is one of: ${HISTORY_KINDS.join(', ')}`)
            const of = text('of')?.trim() ?? ''
            if (kind !== 'book' && kind !== 'ties' && of.length === 0) throw new ProjectError('novel/invalid', 'fields.of: the name or the id of the thing (for script and board: the chapter)')
            // The thing by the name the author knows it by — one that is gone, by the name it had.
            const gone = removed.find(item => item.kind === kind && (item.id === of || item.name === of))?.id
            const outlined = await project.outline()
            const id = kind === 'book' ? 'novel'
              : kind === 'ties' ? 'all'
              : kind === 'script' || kind === 'board' ? (await project.findChapter(of))?.plan.id ?? of
              : kind === 'volume' ? outlined.volumes.find(volume => volume.id === of || volume.title === of)?.id ?? of
              : kind === 'line' ? (outlined.lines ?? []).find(line => line.id === of || line.title === of)?.id ?? of
              : kind === 'character' ? (await project.findCharacter(of))?.id ?? gone ?? of
                : kind === 'world' ? (await project.findWorld(of))?.id ?? gone ?? of
                  : kind === 'style' ? (await project.findStyle(of))?.id ?? gone ?? of
                    : kind === 'plan' ? (await project.findChapter(of))?.plan.id ?? of
                      : (await project.outline()).threads.find(thread => thread.id === of || thread.title === of)?.id ?? of
            const versions = await project.history(kind, id)
            if (versions.length === 0) return { text: `No version is kept of ${kind} "${of || id}": nothing it says was changed since versions began to be kept (or no such thing is known — check the name).`, record: false }
            if (args.action === 'history' && args.version === undefined) {
              return { text: `Versions of ${kind} "${of || id}", the latest first — each is the thing as it was until then, named by what changed it after:\n${versions.map(item => `- ${item.id} — ${item.at}, before ${item.why === 'edit' ? 'an edit by the author' : item.why === 'agent' ? 'a change you made' : item.why === 'restore' ? 'a version was put back' : item.why === 'removed' ? 'it was deleted' : `the job "${item.why.replace(/^job-/, '').replace(/-/g, ' ')}" changed it`}`).join('\n')}\nWhat one of them differs in from now: the same call with version=<id>.`, data: toJson(versions), record: false }
            }
            const version = need(args.version, 'version')
            const was = await project.historyOf(kind, id, version)
            if (was === undefined) throw new ProjectError('novel/not-found', `no version "${version}" of ${kind} "${of || id}" — action=history lists them`)
            const now = await project.current(kind, id)
            if (args.action === 'history') {
              const differing = changedFields(kind, was, now)
              if (differing.length === 0) return { text: 'That version says what the thing says now.', record: false }
              const clipped = (value: unknown): string => { const said = sayValue(value).replace(/\n+/g, ' / '); return said.length > 600 ? `${said.slice(0, 600)}…` : said.length > 0 ? said : '(nothing)' }
              return { text: `${now === undefined ? 'The thing is no longer in the book; the version says:' : 'Fields in which the version and the thing as it is now differ:'}\n${differing.map(field => `- ${field.path}\n  then: ${clipped(field.was)}${now === undefined ? '' : `\n  now: ${clipped(field.now)}`}`).join('\n')}\nTo put it back: action=restore_history (the whole version, or fields.only=[paths]).`, data: toJson(differing), record: false }
            }
            const only = Array.isArray(fields.only) ? fields.only.filter((item): item is string => typeof item === 'string' && item.length > 0) : undefined
            await project.restoreHistory(kind, id, version, only)
            return { text: `${only !== undefined && only.length > 0 ? `Put back in ${kind} "${of || id}": ${only.join(', ')}` : now === undefined ? `${kind} "${of || id}" is back in the book as it last was` : `${kind} "${of || id}" is as that version had it`}. Its pictures are those it has now; what it was until this moment is kept as a version too. Tell the author what was put back.` }
          }
          case 'delete_image': {
            const released = await project.removeIllustration(need(args.id, 'id'))
            return { text: `Illustration ${args.id} removed.${released.length > 0 ? ` It was the picture of ${released.join(', ')}: taken off there too, so nothing points at a file that is gone.` : ''} Where chapter text shows it, the text is as it was.` }
          }
          case 'rewind_interlude': {
            const session = await rewindPlay(runtime, need(args.session, 'session'))
            return { text: `Took back the last turn of "${session.title}"; ${session.turns.length} turn(s) remain.` }
          }
          case 'keep_interlude':
            await setPlayOutcome(runtime, need(args.session, 'session'), 'side-story')
            return { text: `Interlude ${args.session} is kept as a side story; the main manuscript is untouched.` }
          default:
            await project.deletePlaySession(need(args.session, 'session'))
            return { text: `Interlude ${args.session} deleted.` }
        }
      },
    }),
  ]
}

async function readiness(service: NovelService): Promise<{ embedding: boolean; image: boolean; tts: boolean; sound: boolean }> {
  const settings = await service.core.settings.get()
  return service.mediaReady(settings, await service.keyStates(settings), await service.codex())
}

async function summary(service: NovelService, full = false): Promise<string> {
  const settings = await service.core.settings.get()
  const ready = await readiness(service)
  const codex = await service.codex()
  const fallback = service.core.llm.defaultRoute()
  const lines = [
    'Roles:',
    ...ROLES.map(role => `- ${role}: ${describeRoute(settings.models[role])}`),
    `Chat model the unset roles follow: ${fallback !== undefined ? `${fallback.model} (${fallback.provider})` : 'none configured in the Harness'}.`,
    `Semantic retrieval: ${settings.embedding.provider === 'none' ? 'off (keyword search only)' : `${settings.embedding.model ?? '?'} at ${hostOf(settings.embedding.baseURL) ?? '?'} — ${ready.embedding ? 'ready' : 'no key'}`}.`,
    `Images: ${settings.image.provider === 'none' ? 'off' : settings.image.provider === 'codex' ? `ChatGPT subscription — ${ready.image ? 'ready' : 'not signed in'}` : `${settings.image.model ?? '?'} (${settings.image.provider}) — ${ready.image ? 'ready' : 'no key'}`}.`,
    `Speech: ${settings.tts.provider === 'none' ? 'off' : `${settings.tts.model ?? '?'} (${settings.tts.provider}) — ${ready.tts ? 'ready' : 'no key'}`}.`,
    `Sound (effects, music, generated ambience): ${ready.sound ? `${soundSetup(settings)?.model ?? '?'}${soundSetup(settings)?.shared === true ? ', the speech setup' : ''} — ready` : settings.sound?.provider === 'none' ? 'off (captions and browser-synthesized beds only)' : 'no sound model — it follows the speech setup when that is Bailian audio generation; cues stay captions and beds are synthesized by the player'}.`,
  ]
  if (full) {
    lines.push(
      `Context: strategy ${settings.context.strategy}; of the manuscript's own text, ${settings.context.budgetTokens !== undefined ? `${settings.context.budgetTokens} tokens` : 'half of the model\'s context window'} travel word for word, in whole chapters; the chapters before those travel as an outline.`,
      `At once, over everything: ${service.core.parallel('text')} pieces of text work, ${service.core.parallel('speech')} lines spoken, ${service.core.parallel('image')} pictures drawn, ${service.core.parallel('sound')} sounds made${service.core.gate('sound') === service.core.gate('speech') ? ' (sound rides on the speech setup and shares its number)' : ''}.`,
      `Output: the Studio caps no reply itself — each runs as long as its model allows${ROLES.some(role => settings.models[role]?.maxTokens !== undefined) ? `, except where a role sets a cap (${ROLES.filter(role => settings.models[role]?.maxTokens !== undefined).map(role => `${role}: ${settings.models[role]!.maxTokens}`).join(', ')}); a reasoning model spends its reasoning out of that cap` : ''}.`,
      `Speech takes: a line that fails the listening check is spoken up to ${settings.tts.retakes ?? 2} more time(s). Speech tags between spoken lines are ${settings.tts.speechTags === 'read' ? 'read aloud' : 'left unspoken'}.`,
      `Raw file tools on a book's own files (manuscript, bible, outline, records): ${settings.agentFiles === 'allow' ? 'let through, and reconciled afterwards' : settings.agentFiles === 'ask' ? 'the author is asked each time' : 'refused, with the novel_* tool to use instead'} — the author's setting, not yours to change.`,
      `Automatic digest after writing: ${settings.autoDigest ? 'on' : 'off'}. Agent revisions wait for review: ${settings.reviewAgentRevisions ? 'yes' : 'no'}.`,
      `ChatGPT subscription: Codex Connect ${codex.connect ? (codex.connectSignedIn ? 'signed in' : 'installed, not signed in') : 'not installed'}; Codex CLI ${codex.cli ? (codex.cliSignedIn ? 'signed in' : 'installed, not signed in') : 'not installed'}. It can draw images; it offers no embeddings and no speech.`,
      'One-click setups: bailian (text, embeddings, images, speech), openrouter (text, embeddings, GPT Image, speech), openai, codex (images).',
      'Pictures can also come from a model on the author\'s machine: image.provider = comfyui (image.baseURL, image.workflow and image.editWorkflow — paths of workflows exported in API format — image.model; with no workflow, a model that is a diffusion model alone also needs image.textEncoder, image.vae and image.encoderType — the author picks all of these from the server\'s own lists under Settings → Images → Connect, where the server\'s last run can be taken as the workflow in one click) or diffusers (image.model, image.python, image.device); no key. Set them with action=update when the author asks; a ComfyUI server has to be running, and the Python has to have diffusers.',
      'Or from a server of the author\'s own that speaks OpenAI\'s images dialect: image.provider = openai with image.baseURL (http://<host>:<port>/v1) and image.model as that server names it; any model id and any address are taken. An address on this machine or a private network counts as such a server by itself (image.local = true / false says so outright where the address misleads): one picture at a time whatever the number set; each at the largest of its shape the server\'s own model list says the model draws (GET /models, a row\'s limits), or at the nearest of image.sizes where the author lists some (768x768, 768x512, 512x768 where the server says nothing); the prompt cut to the length the server says it reads; sent a model, a prompt, a size — and a seed where the server draws from one, so that a picture drawn again is another picture — and nothing else; reference pictures go to its edits endpoint (POST /images/edits, as OpenAI\'s images.edit() sends them: a form with the pictures as files), as many as its model list says the model takes (reference_images.max_count; none where capabilities.image_edit is false) — where the list says nothing they are sent, and a server that will not have them gets the picture asked for again from the words alone, which the record of the picture then says; and waited for as long as it says when busy. An image model that reads only so many tokens of a prompt (image.promptTokens; where unset, what such a server says of its model) gets a prompt the director rewrote to fit — the same picture in fewer words — instead of one cut off at the limit. The record of a picture says when that was done. Its key, where it wants one, is the author\'s to paste in Settings → Images.',
      'How a prompt is put together, whatever the service: the Studio lays every picture out as one brief — a line a part, each under its name, always in this order: what it is for, the picture, its framing, the people, the place, the objects, what was asked of this one, the art direction, the reference pictures (each by its number: 图1 / Image 1), what must not appear. image.promptWrite says who writes the prompt that is sent: fit (default) — the brief itself, and the director only where it comes to more than the model reads; always — the director writes every brief out in one plain call (one language, each thing said once); never — the brief as it is, whatever its length. image.promptLang = en has prompts in English, for a model that reads nothing else (with promptWrite = always the director translates all of it). image.looks says whether somebody\'s standing look is written out beside a picture of them that goes along: pictured (default) — no, their line points to the picture, and what they wear in this picture is the picture\'s own words to say; always — written out every time. image.portraits says what a portrait asked for with nothing said of it comes to: both (default — a plain likeness and their signature scene, one of each), scene, or plain.',
    )
  }
  return lines.join('\n')
}

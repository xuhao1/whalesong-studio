// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Tools that make the whole Studio reachable from the conversation: its
 * settings, its screens, and the small hand edits the screens offer. With
 * these, nothing the Studio can do needs a click — the screens stay for
 * reading, checking and fine-tuning.
 */
import { audition, updateAudioLine } from '../../core/pipelines/audio'
import { artDirectionOf } from '../../core/pipelines/illustrate'
import { updateComicPanel } from '../../core/pipelines/comic'
import { rewindPlay, setPlayOutcome } from '../../core/pipelines/play'
import { resolveIssue } from '../../core/pipelines/review'
import { ProjectError } from '../../core/project'
import type { DeepPartial } from '../../core/settings'
import { describeRow, rangeStart, summarize, type UsageRange } from '../../core/usage'
import type { NovelService } from '../../host/service'
import { hostOf, SERVICES, type ServiceId, type SetupPart } from '../../shared/services'
import type { CameraMove, ModelRoute, NovelSettings, ProjectManifest, TextRole } from '../../shared/types'
import { brief, listOf, listParameter, novelTool, toJson } from './shared'

const ROLES: TextRole[] = ['writer', 'analyst', 'architect', 'director']
const VIEWS = ['home', 'bible', 'outline', 'write', 'read', 'listen', 'cast', 'review', 'stage', 'settings', 'setup', 'usage'] as const
const STAGE_TABS = ['comic', 'play', 'gallery', 'audio'] as const
const BOOK_FIELDS = ['title', 'author', 'language', 'genre', 'logline', 'premise', 'themes', 'targetWords', 'chapterWords', 'artStyle', 'artAvoid', 'storyboard', 'cover', 'notes', 'activeStyle'] as const
const SECTIONS = ['models', 'context', 'embedding', 'image', 'tts', 'autoDigest', 'reviewAgentRevisions', 'prices'] as const
/** A key must never travel through the conversation; these names are refused wherever they appear. */
const SECRET_FIELD = /^(api[-_]?key|key|secret|token|password|authorization)$/i

function describeRoute(route: ModelRoute | undefined): string {
  if (route === undefined) return 'follows the chat model'
  const where = route.baseURL !== undefined ? `${hostOf(route.baseURL) ?? route.baseURL}` : `Harness provider "${route.provider}"`
  const extras = [route.reasoningEffort !== undefined ? `reasoning ${route.reasoningEffort}` : undefined, route.temperature !== undefined ? `temperature ${route.temperature}` : undefined, route.maxTokens !== undefined ? `replies capped at ${route.maxTokens} tokens` : undefined].filter(Boolean)
  return `${route.model} via ${where}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`
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
        '- action=show: which model plays each role (writer, analyst, architect, director), whether embeddings, images and speech are configured and have a key, what a ChatGPT subscription can do here, and — with a book open — the art direction and avoid list its pictures get and where each comes from.',
        '- action=setup: one-click setup for `service` (bailian, openrouter, openai, or codex for images from a ChatGPT subscription). It fills `parts` (text, embedding, image, tts; default all the service offers) with recommended models, using the key already saved for that service or found in its usual environment variable. `origin` overrides the service address (a Bailian workspace domain, a proxy).',
        '- action=studio: apply `patch` to the settings. Sections: models.{writer|analyst|architect|director} = {provider, model, baseURL?, reasoningEffort?, temperature?, maxTokens?, apiKeyRef?} (omit baseURL to use a model configured in the Harness; set a role to null to follow the chat model). The Studio sets no output limit of its own: a reply runs as long as the model allows, and maxTokens is only a cap the author may add — a model that reasons spends its reasoning out of it, so a low cap cuts chapters, scripts and storyboards off; set it to null to remove it. context {strategy: auto|retrieval|full, budgetTokens, tailChars}; embedding / image / tts {provider, baseURL, model, …; tts.retakes = how many more times a line is spoken when a take fails the listening check, 0-4}; autoDigest; reviewAgentRevisions; prices {"<model id>": {input, output, image, minute, chars10k, currency} | null}.',
        '- action=book: change the book\'s own information with `fields` (title, author, language, genre, logline, premise, themes[], targetWords, chapterWords, artStyle, artAvoid[], storyboard, cover, notes, activeStyle). artStyle is the art direction added to every picture of the book; artAvoid lists what no picture of it may show (objects, motifs, lettering, architectural or religious styles the setting does not have). storyboard = {density: auto|sparse|balanced|dense, maxPanels} says how finely its motion comics are cut. cover is the project-relative path of the picture shown as its cover (any illustration; the latest drawn cover when unset).',
        '- action=usage: what the Studio\'s model calls have used — tokens per role and model, pictures, minutes of speech — for the book in play and for all books, over `range` (today, 7d, 30d, all), with the cost for every model the author has priced. To price a model, action=studio with patch {prices: {"<model id>": {input, output (per million tokens), image (per picture), minute (per minute of speech), chars10k (per 10,000 characters), currency}}}. Your own turns in this conversation are counted by the Harness, not here.',
        'Keys are never passed here. When a key is missing, call novel_show view=settings and ask the author to paste it in the open screen.',
      ].join('\n'),
      mutating: args => args.action !== 'show' && args.action !== 'usage',
      parameters: {
        action: { type: 'string', required: true, enum: ['show', 'setup', 'studio', 'book', 'usage'] },
        range: { type: 'string', enum: ['today', '7d', '30d', 'all'], description: 'usage: the period. Default: 30d.' },
        service: { type: 'string', enum: ['bailian', 'openrouter', 'openai', 'codex'], description: 'setup: which service.' },
        parts: listParameter('setup: which slots to fill. Default: all.', { enum: ['text', 'embedding', 'image', 'tts'] as const }),
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
              // A direct endpoint is labelled by its host when no label was given.
              if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) {
                if (typeof candidate.baseURL !== 'string') throw new ProjectError('novel/invalid', `models.${role} needs a \`provider\` (a Harness provider id) or a \`baseURL\``)
                candidate.provider = hostOf(candidate.baseURL) ?? 'custom'
              }
            }
          }
          await core.settings.update(clean as DeepPartial<NovelSettings>)
          return { text: `Settings updated: ${Object.keys(clean).join(', ')}. ${await summary(service)}` }
        }
        if (args.action === 'setup') {
          if (args.service === undefined) throw new ProjectError('novel/invalid', 'action=setup needs `service`')
          const target = args.service as ServiceId | 'codex'
          const chosen = (listOf(args.parts) ?? []).filter((part): part is SetupPart => ['text', 'embedding', 'image', 'tts'].includes(part))
          const parts: SetupPart[] = chosen.length > 0 ? chosen : target === 'codex' ? ['image'] : ['text', 'embedding', 'image', 'tts']
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
      name: 'novel_show',
      description: 'Show something in Novel Studio next to the conversation: a screen (`view`: home 总览, bible 设定 — characters, world and style, outline 大纲, write 写作, read 阅读 — the chapter as a reader meets it, listen 听 — the same reader in its listening mode, where the audio drama plays and is produced, cast 群像, review 审校, stage 演出, settings 设置 — models, keys and services, setup 配置向导, usage 用量与成本), optionally at a `chapter`, and for the stage a `tab` (comic 有声漫, play 幕间, gallery 插图). Use it when the author asks to see, open or check something, when a key has to be pasted (view=settings), and after work the author will want to look at. It changes nothing in the project. The Studio always shows the book in play, so naming another `book` moves the session onto it.',
      book: 'switch',
      parameters: {
        view: { type: 'string', required: true, enum: [...VIEWS] },
        chapter: { type: 'string', description: 'Chapter id, number or title to open the screen at.' },
        tab: { type: 'string', enum: [...STAGE_TABS], description: 'stage: which tab.' },
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
        'Reading on another device: let the author read (and listen to) a book on a phone or tablet on the same network.',
        '- action=status: whether it is on, which books are shared, and the addresses to open.',
        '- action=on: share the book in play (or `book`) and start the reader; the author is asked to confirm. Give them the address — it carries a secret token, so whoever has it can read the shared books, and nothing else: the reader cannot write, and the Harness itself stays on this machine. Their computer may ask once whether to allow incoming connections.',
        '- action=off: stop sharing this book (`all`=true: switch the reader off altogether).',
        '- action=renew: replace the address, so links given out earlier stop working.',
        '`port` moves the reader to another port (default 4319) when the usual one is taken.',
      ].join('\n'),
      mutating: args => args.action !== 'status',
      parameters: {
        action: { type: 'string', required: true, enum: ['status', 'on', 'off', 'renew'] },
        all: { type: 'boolean', description: 'off: switch the reader off for every book.' },
        port: { type: 'integer', description: 'Port to listen on, 1024-65535.' },
      },
      async run(args, env) {
        const describe = async (status: Awaited<ReturnType<typeof service.share.status>>): Promise<string> => {
          if (!status.enabled || status.books.length === 0) return 'Reading on other devices is off.'
          const shared = status.books.map(book => `"${book.title}"`).join(', ')
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
          book: { root: runtime.project.root, shared: args.action === 'on' },
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
        '- action=resolve_issue: mark review `issue` of `chapter` as dealt with (or reopen it with resolved=false).',
        '- action=edit_line: change line `id` of the audio script of `chapter` — `fields` {text, kind: narration|dialogue|thought, speaker (character id, "" for the narrator), direction}.',
        '- action=edit_panel: change panel `id` of the storyboard of `chapter` — `fields` {prompt, description, camera}.',
        '- action=audition: speak `text` so the author can hear a voice — `voice` (a voice id or description), or `character` to hear that character as their lines will sound; neither = the narrator (`direction` optional).',
        '- action=list_images / delete_image (`id`).',
        '- action=rewind_interlude / keep_interlude (as a side story) / delete_interlude (`session`).',
        '- action=delete_book: take the book in play (or `book`) off the shelf. Its own files — manuscript, bible, outline, pictures, audio — are moved to the system trash, where the author can put them back; anything else in its folder stays. Only when the author asked for exactly this; they are asked to confirm.',
      ].join('\n'),
      mutating: args => args.action !== 'find' && args.action !== 'list_images',
      parameters: {
        action: { type: 'string', required: true, enum: ['find', 'restore_version', 'resolve_issue', 'edit_line', 'edit_panel', 'audition', 'list_images', 'delete_image', 'rewind_interlude', 'keep_interlude', 'delete_interlude', 'delete_book'] },
        chapter: { type: 'string' },
        id: { type: 'string', description: 'Line, panel or image id.' },
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
          case 'edit_line': {
            const kind = text('kind')
            if (kind !== undefined && !['narration', 'dialogue', 'thought'].includes(kind)) throw new ProjectError('novel/invalid', 'kind is narration, dialogue or thought')
            const script = await updateAudioLine(runtime, need(args.chapter, 'chapter'), need(args.id, 'id'), {
              ...(text('text') !== undefined ? { text: text('text')! } : {}),
              ...(kind !== undefined ? { kind: kind as 'narration' | 'dialogue' | 'thought' } : {}),
              ...(text('speaker') !== undefined ? { speaker: text('speaker')! } : {}),
              ...(text('direction') !== undefined ? { direction: text('direction')! } : {}),
            })
            const line = script.lines.find(entry => entry.id === args.id)
            return { text: `Line ${args.id} is now: [${line?.speakerName ?? 'narrator'}] ${brief(line?.text, 120)}. Synthesize the chapter again to hear it.` }
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
            return { text: images.map(image => `- ${image.id}: ${image.kind}${image.target !== undefined ? ` of ${image.target}` : ''} — ${image.path}`).join('\n'), data: toJson(images.map(image => ({ id: image.id, kind: image.kind, path: image.path }))) }
          }
          case 'delete_image':
            await project.removeIllustration(need(args.id, 'id'))
            return { text: `Illustration ${args.id} removed.` }
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

async function readiness(service: NovelService): Promise<{ embedding: boolean; image: boolean; tts: boolean }> {
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
  ]
  if (full) {
    lines.push(
      `Context: strategy ${settings.context.strategy}, budget ${settings.context.budgetTokens} tokens, ${settings.context.tailChars} characters of preceding text.`,
      `Output: the Studio caps no reply itself — each runs as long as its model allows${ROLES.some(role => settings.models[role]?.maxTokens !== undefined) ? `, except where a role sets a cap (${ROLES.filter(role => settings.models[role]?.maxTokens !== undefined).map(role => `${role}: ${settings.models[role]!.maxTokens}`).join(', ')}); a reasoning model spends its reasoning out of that cap` : ''}.`,
      `Speech takes: a line that fails the listening check is spoken up to ${settings.tts.retakes ?? 2} more time(s).`,
      `Automatic digest after writing: ${settings.autoDigest ? 'on' : 'off'}. Agent revisions wait for review: ${settings.reviewAgentRevisions ? 'yes' : 'no'}.`,
      `ChatGPT subscription: Codex Connect ${codex.connect ? (codex.connectSignedIn ? 'signed in' : 'installed, not signed in') : 'not installed'}; Codex CLI ${codex.cli ? (codex.cliSignedIn ? 'signed in' : 'installed, not signed in') : 'not installed'}. It can draw images; it offers no embeddings and no speech.`,
      'One-click setups: bailian (text, embeddings, images, speech), openrouter (text, embeddings, GPT Image, speech), openai, codex (images).',
    )
  }
  return lines.join('\n')
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/** One tool for doing the same work to many chapters, characters or places in one go. */
import { groupOf, worldWeight } from '../../shared/world'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { artPlan, batchFailures, batchSummary, runBatch, stageOverview, stagePlan, stageReadiness, stepName, textPlan } from '../../core/pipelines/batch'
import { ProjectError } from '../../core/project'
import { promptLanguage } from '../../core/render'
import type { NovelService } from '../../host/service'
import { STAGE_STEPS, TEXT_STEPS, type CharacterCard, type CharacterRole, type StageStep, type StoryboardDensity, type TextStep } from '../../shared/types'
import { listOf, listParameter, novelTool, toJson } from './shared'

const ROLES: readonly CharacterRole[] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']
const MAIN_ROLES: readonly CharacterRole[] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting']
/** From how many cards on "everyone" is no longer what a batch means by itself; the Studio's own picker starts the same way. */
const LARGE_CAST = 24

export function batchTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_batch',
      description: [
        'Do the same work to many chapters, characters or places in one go, as one job the author can watch and stop. Whatever can run side by side does; every step first looks whether there is anything left to do, so a batch run again does what was left; a step that fails is the only thing that fails, and the result says which.',
        '- what=stage: put chapters on stage — `steps` out of script, voice, sound, storyboard, panels, video (default: all that can be done with what is set up, without the video). A chapter\'s voices, sounds and storyboard are made side by side once its script stands. `chapters` names them (default: every chapter that has text); `density` / `max_panels` say how finely storyboards are cut; `direction` is what the author wants of the videos.',
        '- what=text: work on the text of a run of chapters — `steps` out of beats, write, digest, review. With write, the chapters are written one after the other, each knowing the text of the one before and what was learned from it — the default, and the surer way to chapters that agree. `order=together` writes them side by side instead, as many at once as the settings allow: faster, and each chapter is then written from its own outline, the outlines of the chapters before it that are written beside it, and the text there was before the batch — so the chapters need outlines worth the name (derive beats first), and a review afterwards is worth its while. Use it when the author asks for speed, not by yourself. (Give `chapters`, or `count` for that many from the first one that has no text; `line` for a line of the plot other than the main one; `brief` and `words` apply to every chapter written — leave `words` out unless the author named a length). Without write, the steps run side by side over the chapters: beats for every chapter that has none, memory for every chapter not yet digested, a review of each. `order=iterate` writes in order and then in rounds: every chapter is reviewed, the planner mends what the reviews found across the chapters in one go, what changed is digested and reviewed again — `rounds` times at most, for issues `at_least` this grave; what a round changes goes into the text (each draft replaced is a version). It costs several times what writing once does: use it when the author asks for it.',
        '- what=art: pictures and voices for the book — `sheets` and `portraits` (characters), `voices` (characters who get a voice designed for them), `places` (world entries that are places), `items` (world entries that are things: the object alone), `scenes` (chapters, one illustration each; insert=true puts it at the head of the chapter), cover=true. Sheets, places and things are drawn first, so portraits, scenes and the cover are drawn against them. Use "all" in a list for everyone or everything that has none yet. "all" characters means those whose part has the weight `roles` names: by default everybody in a small cast, and in a large one (more than 24 cards) the main parts only — protagonist, deuteragonist, antagonist, supporting. A book with hundreds of walk-ons does not need hundreds of design sheets; widen `roles` only when the author asks for the small parts too.',
        '- action=status (what=stage): where each chapter\'s production stands — script, voices, sound, storyboard, pictures, video — and what cannot run for lack of a model.',
        'How many requests go out at once is the author\'s setting (novel_settings: textConcurrency, tts.concurrency, image.concurrency), not a parameter here. A batch spends what its steps spend, times the chapters: say what it will do and get the author\'s go-ahead before a large one — writing chapters, drawing every panel, cutting videos.',
      ].join('\n'),
      mutating: args => args.action !== 'status',
      parameters: {
        what: { type: 'string', required: true, enum: ['stage', 'text', 'art'] },
        action: { type: 'string', enum: ['run', 'status'], description: 'run (default), or status for what=stage.' },
        steps: listParameter('stage: script, voice, sound, storyboard, panels, video. text: beats, write, digest, review.'),
        chapters: listParameter('stage/text: chapters by id, number or title. Default: stage — every chapter with text; text — see `count`.'),
        count: { type: 'integer', description: 'text: how many chapters, from the first one the steps have something to do for.' },
        line: { type: 'string', description: 'stage/text: a line of the plot other than the main one (id or name).' },
        brief: { type: 'string', description: 'text + write: what every chapter written should keep to.' },
        words: { type: 'integer', description: 'text + write: a length recommended for every chapter written. Leave out to use each chapter\'s own or the book\'s, or to let the writer judge.' },
        redo: { type: 'boolean', description: 'text: write chapters that have text again, derive beats where there are some. stage/art: make again what is there (force).' },
        order: { type: 'string', enum: ['sequence', 'together', 'iterate'], description: 'text, with write: sequence (default) — one chapter after the other; together — side by side; iterate — in order, then in rounds of review and mending (see `rounds`, `at_least`).' },
        rounds: { type: 'number', description: 'text, order=iterate: how many rounds at most (default 2, at most 5).' },
        at_least: { type: 'string', enum: ['high', 'medium', 'low'], description: 'text, order=iterate: issues this grave or graver are worth a round (default medium).' },
        focus: { type: 'string', description: 'text + review: what the reviews should look at.' },
        density: { type: 'string', enum: ['auto', 'sparse', 'balanced', 'dense'], description: 'stage: how finely storyboards are cut.' },
        max_panels: { type: 'integer', description: 'stage: the most panels a chapter may have.' },
        direction: { type: 'string', description: 'stage + video: what the author wants of the cuts.' },
        subtitles: { type: 'boolean', description: 'stage + video: false for cuts without subtitles. Default: with them.' },
        sheets: listParameter('art: characters to draw a design sheet for; "all" for everyone without one.'),
        portraits: listParameter('art: characters to draw a portrait of; "all" for everyone without one.'),
        voices: listParameter('art: characters to design a voice for; "all" for everyone without one.'),
        roles: listParameter('art: which parts "all" stands for in sheets / portraits / voices — out of protagonist, deuteragonist, antagonist, supporting, minor, cameo; "main" for the first four, "everyone" for all six.'),
        places: listParameter('art: world entries to draw reference art for; "all" for every place of weight (core or major: named in three chapters or more, or set so by the author) that has none — name a lesser place to draw it anyway.'),
        items: listParameter('art: world entries that are things, to draw design art for; "all" for every thing of weight (core or major: named in three chapters or more, or set so by the author) that has none — name a lesser thing to draw it anyway.'),
        scenes: listParameter('art: chapters to illustrate; "all" for every written chapter without an illustration.'),
        cover: { type: 'boolean', description: 'art: draw a cover.' },
        insert: { type: 'boolean', description: 'art + scenes: put each picture at the head of its chapter.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const { project } = runtime
        const lang = promptLanguage((await project.manifest()).language)
        const line = args.line !== undefined && args.line.trim().length > 0 ? args.line.trim() : undefined
        if (args.action === 'status') {
          if (args.what !== 'stage') throw new ProjectError('novel/invalid', 'action=status is for what=stage; novel_status says where the text stands')
          const [chapters, missing] = await Promise.all([stageOverview(env.core, runtime, line), stageReadiness(env.core, runtime, env.task)])
          const rows = chapters.map(chapter => `${chapter.index}. ${chapter.title} [${chapter.id}] — script: ${chapter.script !== undefined ? `${chapter.script.lines} lines${chapter.script.stale ? ', stale' : ''}; voices ${chapter.script.voiced}/${chapter.script.spoken}` : 'none'}; sound: ${chapter.sound !== undefined ? `${chapter.sound.made}/${chapter.sound.wanted}` : 'none asked for'}; storyboard: ${chapter.board !== undefined ? `${chapter.board.panels} panels${chapter.board.stale ? ', stale' : ''}, ${chapter.board.drawn} drawn` : 'none'}; video: ${chapter.video !== undefined ? `${Math.round(chapter.video.duration)} s` : 'none'}`)
          const lacking = Object.entries(missing).map(([step, why]) => `- ${step}: ${why}`)
          return { text: `${rows.length > 0 ? rows.join('\n') : 'No chapter has text yet.'}${lacking.length > 0 ? `\nCannot run right now:\n${lacking.join('\n')}` : ''}`, data: toJson({ chapters, missing }) }
        }
        const chapters = listOf(args.chapters)
        /** Set when "all" characters stood for some parts only: said in the result, so nobody takes the rest for done. */
        let narrowed: { roles: readonly CharacterRole[]; of: number; within: number } | undefined
        const everyone = (list: string[] | undefined, all: () => Promise<string[]>): Promise<string[] | undefined> | undefined => list === undefined ? undefined : list.some(item => /^(all|全部|所有)$/i.test(item)) ? all() : Promise.resolve(list)
        const plan = args.what === 'stage'
          ? await stagePlan(env.core, runtime, {
              ...(chapters !== undefined && chapters.length > 0 ? { chapters } : {}),
              ...(line !== undefined ? { line } : {}),
              ...(listOf(args.steps) !== undefined ? { steps: listOf(args.steps)!.filter((step): step is StageStep => (STAGE_STEPS as readonly string[]).includes(step)) } : {}),
              ...(args.redo === true ? { force: true } : {}),
              ...(args.density !== undefined ? { density: args.density as StoryboardDensity } : {}),
              ...(args.max_panels !== undefined && args.max_panels > 0 ? { maxPanels: args.max_panels } : {}),
              ...(args.direction !== undefined && args.direction.trim().length > 0 ? { direction: args.direction.trim() } : {}),
              ...(args.subtitles === false ? { subtitles: false } : {}),
            }, env.task)
          : args.what === 'text'
            ? await textPlan(env.core, runtime, {
                steps: (listOf(args.steps) ?? []).filter((step): step is TextStep => (TEXT_STEPS as readonly string[]).includes(step)),
                ...(chapters !== undefined && chapters.length > 0 ? { chapters } : {}),
                ...(args.count !== undefined && args.count > 0 ? { count: args.count } : {}),
                ...(line !== undefined ? { line } : {}),
                ...(args.brief !== undefined && args.brief.trim().length > 0 ? { brief: args.brief.trim() } : {}),
                ...(args.words !== undefined && args.words > 0 ? { words: args.words } : {}),
                ...(args.redo === true ? { redo: true } : {}),
                ...(args.focus !== undefined && args.focus.trim().length > 0 ? { focus: args.focus.trim() } : {}),
                ...(args.order === 'together' ? { order: 'together' as const } : {}),
                ...(args.order === 'iterate' ? { order: 'iterate' as const, ...(typeof args.rounds === 'number' && args.rounds > 0 ? { rounds: args.rounds } : {}), ...(args.at_least === 'high' || args.at_least === 'medium' || args.at_least === 'low' ? { atLeast: args.at_least } : {}) } : {}),
              })
            : await (async () => {
                const characters = await project.characters()
                const world = await project.world()
                const pictures = await project.illustrations()
                const infos = await project.chapterInfos()
                // "All" of a large cast is its main parts, unless the call says which parts it means.
                const named = listOf(args.roles) ?? []
                const roles: readonly CharacterRole[] = named.some(item => /^(everyone|all|全部|所有)$/i.test(item)) ? ROLES
                  : named.length > 0 ? ROLES.filter(role => named.includes(role) || (MAIN_ROLES.includes(role) && named.some(item => /^(main|leads?|主要)$/i.test(item))))
                    : characters.length > LARGE_CAST ? MAIN_ROLES : ROLES
                const inScope = (card: CharacterCard): boolean => roles.includes(card.role)
                narrowed = roles.length < ROLES.length ? { roles, of: characters.length, within: characters.filter(inScope).length } : undefined
                const [sheets, portraits, voices, places, items, scenes] = await Promise.all([
                  everyone(listOf(args.sheets), async () => characters.filter(card => inScope(card) && card.visual?.sheet === undefined).map(card => card.id)),
                  everyone(listOf(args.portraits), async () => characters.filter(card => inScope(card) && card.visual?.portrait === undefined).map(card => card.id)),
                  everyone(listOf(args.voices), async () => characters.filter(card => inScope(card) && card.voiceProfile?.voice === undefined).map(card => card.id)),
                  // "All" places is those the story lives in or comes back to: an inn passed once needs no design art.
                  everyone(listOf(args.places), async () => {
                    const { presence, written } = await project.worldPresence()
                    const seen = new Map(presence.map(item => [item.entry, item.chapters.length]))
                    return world.filter(entry => entry.category === 'location' && entry.visualImage === undefined && ['core', 'major'].includes(worldWeight(entry, seen.get(entry.id) ?? 0, written))).map(entry => entry.id)
                  }),
                  everyone(listOf(args.items), async () => {
                    const { presence, written } = await project.worldPresence()
                    const seen = new Map(presence.map(item => [item.entry, item.chapters.length]))
                    return world.filter(entry => groupOf(entry.category) === 'items' && entry.visualImage === undefined && ['core', 'major'].includes(worldWeight(entry, seen.get(entry.id) ?? 0, written))).map(entry => entry.id)
                  }),
                  everyone(listOf(args.scenes), async () => infos.filter(info => info.hasText && !pictures.some(picture => picture.kind === 'scene' && picture.target === info.id)).map(info => info.id)),
                ])
                return await artPlan(env.core, runtime, {
                  ...(sheets !== undefined && sheets.length > 0 ? { sheets } : {}),
                  ...(portraits !== undefined && portraits.length > 0 ? { portraits } : {}),
                  ...(voices !== undefined && voices.length > 0 ? { voices } : {}),
                  ...(places !== undefined && places.length > 0 ? { places } : {}),
                  ...(items !== undefined && items.length > 0 ? { items } : {}),
                  ...(scenes !== undefined && scenes.length > 0 ? { scenes } : {}),
                  ...(args.cover === true ? { cover: true } : {}),
                  ...(args.insert === true ? { insert: true } : {}),
                  ...(args.redo === true ? { force: true } : {}),
                })
              })()
        const result = await env.job('batch', `${args.what} batch`, undefined, async task => await runBatch(plan, task, lang))
        const failures = result.failed.length > 0 ? `\nDid not come about:\n${batchFailures(result, 'en')}\nRun the same batch again to try only these; tell the author what failed and why.` : ''
        const names = plan.columns.map(op => stepName(op, 'en')).join(', ')
        return {
          text: `Batch over ${plan.rows.length} ${plan.what === 'art' ? 'characters, places and chapters' : 'chapters'} (${names}): ${batchSummary(result, 'en')}.${failures}${narrowed !== undefined && [args.sheets, args.portraits, args.voices].some(list => listOf(list)?.some(item => /^(all|全部|所有)$/i.test(item)) === true) ? `\n"All" characters stood for the ${narrowed.roles.join(', ')} parts here: ${narrowed.within} of the book's ${narrowed.of} characters. The others were left alone — pass \`roles\` to include them.` : ''}`,
          data: toJson({ done: result.done, skipped: result.skipped, failed: result.failed }),
          record: { summary: [`批量${plan.what === 'stage' ? '制作' : plan.what === 'text' ? '处理正文' : '绘制'}：${plan.columns.map(op => stepName(op, 'zh')).join('、')}，${plan.rows.length} 项，${batchSummary(result, 'zh')}`, `Batch (${names}) over ${plan.rows.length}: ${batchSummary(result, 'en')}`] },
        }
      },
    }),
  ]
}

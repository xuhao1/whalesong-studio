// SPDX-License-Identifier: LGPL-3.0-or-later
/** Tools for working with the crew: handing a role a task in words, and having a chapter's video cut. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CREW, crewPlan, delegate } from '../../core/crew'
import { chapterVideoWithSubtitles, produceVideo, removeVideo, videoReadiness } from '../../core/pipelines/video'
import { ProjectError } from '../../core/project'
import type { NovelService } from '../../host/service'
import { FFMPEG_INSTALL } from '../../shared/text'
import { CREW_ROLES, MAIN_LINE, type CrewRole } from '../../shared/types'
import { novelTool, toJson } from './shared'

export function crewTools(service: NovelService): ToolDefinition[] {
  return [
    novelTool(service, {
      name: 'novel_crew',
      description: [
        'Hand a task, in words, to one of the crew — the agents that work beside you, each with tools and a model of its own:',
        ...CREW_ROLES.map(role => `- ${role} (${CREW[role].name[0]}): ${CREW[role].does[1]}.`),
        'Use it for work that takes looking things up and judging: "check whether the timeline of volume two holds together", "research how nineteenth-century telegraph offices ran and propose three scenes that use it", "find what is trending around this theme and suggest two beats that could carry it without breaking the world" (the architect can search the web), "read chapters 4-6 as a director and say which scenes would stage best".',
        'The role reads the book itself; it sees nothing of this conversation, so the task must stand on its own: what is wanted, about which chapters or characters, in what form. It reports back in words — it does not change the book. Apply what you take from its report with your own tools, after the author agrees to anything that shapes the story.',
        'Work that has a tool of its own goes through that tool, which uses the same crew: digests and reviews (novel_digest, novel_review), outlines and beats (novel_derive), scripts and storyboards (novel_audio, novel_comic), a video (novel_video). action=list shows who is on the crew and how each is set to work.',
        'Every run is a child agent of this conversation: the author can open it from the conversation\'s header and read each step.',
      ].join('\n'),
      mutating: false,
      parameters: {
        action: { type: 'string', enum: ['ask', 'list'], description: 'ask (default): give a role a task. list: who is on the crew.' },
        role: { type: 'string', enum: CREW_ROLES, description: 'ask: who gets the task.' },
        task: { type: 'string', description: 'ask: the task, complete in itself.' },
        line: { type: 'string', description: 'ask: the line of the plot the task is on, by id or name ("main" for the main one), in a book that has more than one. The role then reads that line alone — its chapters, numbered along it, its people, its threads — and the world. Leave out only when the task is about the whole book, or the author wants one line held against another: then the role may read every line.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        if (args.action === 'list') {
          const lines: string[] = []
          const data: Record<string, unknown>[] = []
          const manifest = await runtime.project.manifest()
          for (const role of CREW_ROLES) {
            const plan = crewPlan(env.core, role, manifest)
            const route = await env.core.route(role, runtime, env.task).catch(() => undefined)
            const able = route !== undefined && env.core.roles?.can(route) === true
            const how = plan.mode === 'call' ? 'set to plain calls (no tools)' : able ? `agent; tools: ${plan.open ? 'its own and everything this conversation has' : `its own${CREW[role].tools.length > 0 ? ` + ${CREW[role].tools.join(', ')} where present` : ''}`}` : 'cannot run as an agent: its model is a directly called endpoint — choose a DSH model for it in Novel Studio → Settings'
            lines.push(`- ${role} (${CREW[role].name[0]} / ${CREW[role].name[1]}) — ${CREW[role].does[1]}. Model: ${route?.model ?? 'none'}. ${how}.`)
            data.push({ role, model: route?.model ?? null, mode: plan.mode, agent: able, tools: plan.open ? 'all' : 'own' })
          }
          return { text: `${lines.join('\n')}\nThe writer is not on this list: it writes, and is briefed through novel_write / novel_revise.`, data: toJson(data) }
        }
        const role = args.role as CrewRole | undefined
        if (role === undefined || !CREW_ROLES.includes(role)) throw new ProjectError('novel/invalid', `\`role\` is one of ${CREW_ROLES.join(', ')}`)
        if (args.task === undefined || args.task.trim().length < 8) throw new ProjectError('novel/invalid', 'give the role a `task` that stands on its own: what is wanted, about what, in what form')
        const text = args.task.trim()
        // The job is named by who works; what on is the task's own opening words.
        // The line the task is on, where the showrunner says: what the role reads is that line's.
        const wanted = args.line?.trim()
        const on = wanted === undefined || wanted.length === 0 ? undefined : wanted === MAIN_LINE || /^(main|主线)$/i.test(wanted) ? MAIN_LINE : (await runtime.project.findLine(wanted))?.id
        if (wanted !== undefined && wanted.length > 0 && on === undefined) throw new ProjectError('novel/not-found', `no line of the plot matches "${wanted}" — novel_read what=outline lists the lines`)
        const done = await env.job('crew', `crew ${role}`, text.replace(/\s+/g, ' ').slice(0, 48), async task => await delegate(env.core, runtime, task, { role, task: text, ...(on !== undefined ? { line: on } : {}) }))
        const how = `[${CREW[role].name[1]} agent, ${done.run.steps ?? 0} tool calls${done.stop !== 'completed' ? `, ended: ${done.stop}` : ''}; the run is listed under this conversation]`
        if (done.report.length === 0) return { text: `${how}\nThe ${role} reported nothing${done.stop !== 'completed' ? ` (${done.stop})` : ''}. Its steps are on record in the run; ask again with a narrower task, or do the work with your own tools.` }
        return { text: `${how}\n\n${done.report}`, data: toJson({ role, steps: done.run.steps ?? 0, stop: done.stop, ...(done.run.session !== undefined ? { session: done.run.session } : {}) }) }
      },
    }),

    novelTool(service, {
      name: 'novel_video',
      description: [
        'A chapter as a video file, cut by the crew\'s post-production agent.',
        'What the earlier stages made is its material: the chapter\'s audio script with a voice for every line (novel_audio), its sound cues, and its storyboard with a picture for every panel (novel_comic). Post-production gets that material on one timeline and a shell: it writes its own ffmpeg script, runs it, checks the result and hands in an MP4 — and may call in an outside coding agent (Claude Code, Codex) when the author has installed one in DSH. It takes minutes.',
        '- action=status: what there is to cut from, whether a video exists already, and whether this computer can make one (ffmpeg, a model that can run as an agent).',
        '- action=produce: have it cut. `direction` carries what the author wants of it (pace, a title card, the look). The cut carries the lines as subtitles — a track in the file, and drawn into the picture where this computer\'s ffmpeg can; `subtitles=false` when the author wants none. A chapter that lacks voice or pictures is refused with what to make first.',
        '- action=delete: delete the chapter\'s video file; what it was cut from is untouched.',
        'The video plays in Novel Studio → Stage beside the motion comic. This spends tokens of post-production\'s model for as many steps as the cut takes: do it when the author asks.',
      ].join('\n'),
      mutating: args => args.action === 'produce' || args.action === 'delete',
      parameters: {
        action: { type: 'string', required: true, enum: ['status', 'produce', 'delete'] },
        chapter: { type: 'string', required: true },
        direction: { type: 'string', description: 'produce: what the author wants of this cut.' },
        subtitles: { type: 'boolean', description: 'produce: false for a cut without subtitles. Default: with them.' },
      },
      async run(args, env) {
        const runtime = await env.project()
        const chapter = await runtime.project.findChapter(args.chapter)
        if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${args.chapter}"`)
        if (args.action === 'status') {
          const [ready, existing] = await Promise.all([videoReadiness(env.core, runtime, chapter.plan.id, env.task), chapterVideoWithSubtitles(runtime, chapter.plan.id)])
          const lines = [
            existing !== undefined ? `Chapter ${chapter.index} has a video: ${existing.path}, ${existing.duration.toFixed(0)} s, ${existing.width}×${existing.height}, made ${existing.createdAt}.${existing.note !== undefined ? ` Post-production's note: ${existing.note}` : ''}` : `Chapter ${chapter.index} has no video yet.`,
            ready.counts !== undefined ? `Material: ${ready.counts.spoken} voiced lines (${ready.counts.seconds.toFixed(0)} s)${ready.counts.silent > 0 ? `, ${ready.counts.silent} lines without a voice` : ''}; ${ready.counts.drawn} panels drawn${ready.counts.undrawn > 0 ? `, ${ready.counts.undrawn} not drawn` : ''}; ${ready.counts.clips} sound clips.` : `Cannot be cut yet: ${ready.blocked ?? 'no material'}`,
            ready.ffmpeg ? '' : `ffmpeg / ffprobe are not on this computer — the author installs them (${FFMPEG_INSTALL[1]}).`,
            ready.agent ? `Post-production runs on ${ready.model ?? 'the conversation\'s model'}.` : `Post-production cannot run as an agent: ${ready.model ?? 'its model'} is a directly called endpoint — the author chooses a DSH model for it in Novel Studio → Settings.`,
          ]
          return { text: lines.filter(line => line.length > 0).join('\n'), data: toJson({ ...ready, video: existing ?? null }) }
        }
        if (args.action === 'delete') {
          const done = await removeVideo(runtime, chapter.plan.id)
          return { text: done.removed ? `The video of chapter ${chapter.index} is deleted. Its voice, sound and pictures are untouched.` : `Chapter ${chapter.index} had no video.`, record: { summary: [`删除了第 ${chapter.index} 章的视频`, `Deleted the video of chapter ${chapter.index}`], chapter: chapter.plan.id } }
        }
        const result = await env.job('video', 'video', chapter.plan.id, async task => await produceVideo(env.core, runtime, { chapter: chapter.plan.id, ...(args.subtitles === false ? { subtitles: false } : {}), ...(args.direction !== undefined && args.direction.trim().length > 0 ? { direction: args.direction.trim() } : {}) }, task))
        return {
          text: `Video of chapter ${chapter.index} is in: ${result.video.path} — ${result.video.duration.toFixed(0)} s, ${result.video.width}×${result.video.height}, ${(result.video.size / 1_048_576).toFixed(1)} MB (${result.steps ?? 0} tool calls by post-production).\nIts note: ${result.report || '(none)'}\nIt plays in Novel Studio → Stage (novel_show view=stage).`,
          data: toJson(result.video),
          record: { summary: [`让后期剪出了第 ${chapter.index} 章的视频`, `Had post-production cut the video of chapter ${chapter.index}`], chapter: chapter.plan.id },
        }
      },
    }),
  ]
}

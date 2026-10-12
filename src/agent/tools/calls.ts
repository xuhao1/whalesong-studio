// SPDX-License-Identifier: LGPL-3.0-or-later
/** The showrunner's way to the record of calls: what the Studio sent to a text model for the book, and what the model said. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ProjectError } from '../../core/project'
import type { NovelService } from '../../host/service'
import type { CallRow } from '../../shared/types'
import { novelTool, toJson } from './shared'

const PARTS = ['system', 'stable', 'prompt', 'reply'] as const

/** One call, as the showrunner reads it in a list. */
function line(call: CallRow): string {
  const work = [call.kind === 'batch' ? 'batch' : call.title, call.step].filter((part, at, all) => part !== undefined && all.indexOf(part) === at).join(' / ') || 'outside any job'
  const used = call.input !== undefined ? `${call.input} tokens in${call.cached !== undefined && call.cached > 0 ? ` (${call.cached} cached)` : ''}, ${call.output ?? 0} out` : `${call.sent} characters sent, ${call.got} back`
  const ended = call.stopped === true ? 'STOPPED' : call.error !== undefined ? `FAILED: ${call.error}` : call.finish ?? ''
  return `- [${call.id}] ${call.at} — ${work}${call.chapter !== undefined ? ` — chapter ${call.chapter}` : call.target !== undefined ? ` — ${call.target}` : ''} — ${call.role}: ${call.provider}/${call.model}${call.effort !== undefined ? `, reasoning ${call.effort}` : ''}${call.temperature !== undefined ? `, temperature ${call.temperature}` : ''} — ${used}, ${(call.ms / 1000).toFixed(1)} s — ${ended}`
}

export function callTools(service: NovelService): ToolDefinition[] {
  return [novelTool(service, {
    name: 'novel_calls',
    description: [
      'The record of calls: every call the Studio made to a text model for the book — a chapter written, continued or rewritten by the writer, a digest, a review, a plan — kept with the model and how it was set (reasoning level, temperature, output limit), how much it used, how it ended, and all that was sent and said. Read it when the author asks what a piece was written from, why it came out as it did, or why two drafts of one chapter are unlike each other: compare what each call was sent and how each was set before guessing. (The same request answered twice at the writer\'s temperature is two different texts: where two calls were sent the same thing, say that.)',
      '- action=list (default): the calls on record, the latest first — `chapter` for one chapter\'s only, `limit` for how many (default 20).',
      '- action=read: one call by `id` — `part` = prompt (default: this call\'s own material and what was asked last) | stable (what opened the request and stays the same over a run of calls: the book and the story so far) | system (the rules of the role, and for the writer the book\'s style) | reply (what the model said, before the Studio touched it). A part can be long: it comes `max` characters at a time (default 8000) from `from`.',
      'What a role of the crew works out step by step as an agent is not in this record — that run is a conversation of its own (the author opens it from Jobs). The author reads the record on the writing page under Calls, and for the whole book from Jobs and Usage; how much of it a book keeps is their setting (callsMb).',
    ].join('\n'),
    mutating: false,
    parameters: {
      action: { type: 'string', enum: ['list', 'read'], description: 'Default: list.' },
      chapter: { type: 'string', description: 'list: only the calls made for this chapter — its id, number or title.' },
      limit: { type: 'integer', description: 'list: how many, the latest first. Default 20.' },
      id: { type: 'string', description: 'read: which call (ids are in the list).' },
      part: { type: 'string', enum: PARTS, description: 'read: which part of the call. Default: prompt.' },
      from: { type: 'integer', description: 'read: the character to start at. Default 0.' },
      max: { type: 'integer', description: 'read: characters at most. Default 8000.' },
    },
    async run(args, env) {
      const { project } = await env.project()
      const calls = env.core.calls
      if ((args.action ?? 'list') === 'list') {
        const of = args.chapter !== undefined && args.chapter.trim().length > 0 ? await project.findChapter(args.chapter.trim()) : undefined
        if (args.chapter !== undefined && args.chapter.trim().length > 0 && of === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${args.chapter}"`)
        const listed = await calls.list(project, { ...(of !== undefined ? { chapter: of.plan.id } : {}), limit: args.limit !== undefined && args.limit > 0 ? args.limit : 20 })
        const kept = calls.megabytes()
        return {
          text: listed.calls.length === 0
            ? `No call is on record${of !== undefined ? ` for chapter ${of.index}` : ''}${kept <= 0 ? ' — the author keeps none (callsMb is 0)' : listed.total > 0 ? ` (${listed.total} for the book)` : ' yet'}.`
            : `Calls on record${of !== undefined ? ` for chapter ${of.index} "${of.plan.title}"` : ''}, the latest first (${listed.calls.length} of ${listed.total} for the book; ${(listed.bytes / 1024 / 1024).toFixed(1)} MB of ${kept} kept):\n${listed.calls.map(line).join('\n')}\nnovel_calls action=read id=<id> reads what one was sent (part=prompt | stable | system) and what it said (part=reply).`,
          data: toJson(listed.calls),
          record: false,
        }
      }
      if (args.id === undefined || args.id.trim().length === 0) throw new ProjectError('novel/invalid', 'read: `id` names the call (novel_calls action=list gives the ids)')
      const call = await calls.read(project, args.id.trim())
      if (call === undefined) throw new ProjectError('novel/not-found', `no call "${args.id}" is on record (the oldest go when the record is full)`)
      const part = PARTS.find(name => name === args.part) ?? 'prompt'
      const whole = call[part] ?? ''
      const from = Math.max(0, Math.min(whole.length, Math.round(args.from ?? 0)))
      const max = Math.max(200, Math.round(args.max ?? 8000))
      const shown = whole.slice(from, from + max)
      const sizes = PARTS.map(name => `${name} ${(call[name] ?? '').length}`).join(', ')
      return {
        text: [
          line(call),
          `Parts, in characters: ${sizes}.`,
          whole.length === 0
            ? `This call has no ${part}.`
            : `${part}, characters ${from}–${from + shown.length} of ${whole.length}${from + shown.length < whole.length ? ` (go on with from=${from + shown.length})` : ''}:\n\n${shown}`,
        ].join('\n'),
        record: false,
      }
    },
  })]
}

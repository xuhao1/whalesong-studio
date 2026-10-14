// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The agent-plane half: what a preset mounts for the sessions that use it.
 *
 * It gives the session's model the novel_* tools, the showrunner instructions,
 * a live project digest, the `/novel` command, and a gate that asks before
 * writing in a read-only session. Everything is registered through `ctx`, so
 * it leaves with the preset.
 *
 * This is built into the Host half and reached through the `novel` service
 * (see `src/agent/index.ts`, the entry a preset names): the two halves a
 * session works with are then always of one build.
 */
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { digestPending } from '../core/pipelines/digest'
import { exportBook, type ExportFormat } from '../core/pipelines/export'
import { managedKind } from '../core/reconcile'
import { promptLanguage } from '../core/render'
import { ProjectError } from '../core/project'
import { PROJECT_CONTEXT, SHOWRUNNER_SECTION } from '../core/roles'
import { errorMessage } from '../core/util/async'
import { displayPath } from '../core/util/fs'
import type {} from '../host/service'
import { WORK_MODES, type WorkMode } from '../shared/types'
import { focusLines, lockedContext, modeRules, movedContext, noProjectContext, ORCHESTRATOR_SECTION } from './prompt'
import { modeLabel, renderDigest, renderStatus } from './status'
import { bibleTools } from './tools/bible'
import { batchTools } from './tools/batch'
import { callTools } from './tools/calls'
import { crewTools } from './tools/crew'
import { manuscriptTools } from './tools/manuscript'
import { projectTools } from './tools/project'
import { referenceTools_ } from './tools/reference'
import { MUTATING } from './tools/shared'
import { stageTools } from './tools/stage'
import { studioTools } from './tools/studio'

/** Position of the showrunner section: right after the persona, before tool guidance. */
const SECTION_ORDER = 100
/** Position of the project digest among runtime contexts. */
const CONTEXT_ORDER = 200

export function mountAgent(ctx: Context): void {
  const novel = ctx.novel

  for (const tool of [...projectTools(novel), ...referenceTools_(novel), ...bibleTools(novel), ...manuscriptTools(novel), ...stageTools(novel), ...crewTools(novel), ...batchTools(novel), ...studioTools(novel), ...callTools(novel)]) {
    ctx.tools.register(tool)
  }

  // A role of the crew is composed under this same preset and puts its own rules in this section's place.
  ctx.systemPrompt.section({ name: SHOWRUNNER_SECTION, order: SECTION_ORDER, text: ORCHESTRATOR_SECTION, interpolate: false })

  // ── project digest as dynamic context ──
  // Prompt assembly is synchronous, project state is not: digests are kept
  // per session and refreshed whenever the project, the mode or the binding moves.
  // A digest remembers which binding it was read for, so a change of book can never pass the old book's digest off as the new one's.
  const digests = new Map<string, { text: string; root?: string; bound?: string }>()
  const agents = new Map<string, Agent>()
  const roots = new Map<string, string>()
  const watches = new Map<string, () => void>()
  const timers = new Map<string, NodeJS.Timeout>()
  let disposed = false

  const refresh = async (agent: Agent): Promise<void> => {
    try {
      const state = await novel.sessions.get(agent.id)
      const workspace = novel.workspaceOfAgent(agent)
      const runtime = await novel.projectOfAgent(agent)
      if (disposed || !agents.has(agent.id)) return
      const bound = state.project !== undefined ? { bound: state.project } : {}
      const near = await novel.booksNear(agent.id, workspace)
      if (disposed || !agents.has(agent.id)) return
      if (runtime === undefined) {
        // The book this session was on may be gone for good: its watch goes with it, so a book made there later is watched afresh.
        const before = roots.get(agent.id)
        if (before !== undefined && await novel.core.tryRuntime(before).catch(() => undefined) === undefined) {
          watches.get(before)?.()
          watches.delete(before)
        }
        roots.delete(agent.id)
        digests.set(agent.id, { text: noProjectContext(workspace, state.mode, near), ...bound })
        return
      }
      const root = runtime.project.root
      roots.set(agent.id, root)
      if (!watches.has(root)) {
        watches.set(root, runtime.project.onChange(() => {
          // A chapter save is a burst of writes; one refresh after it settles is enough.
          const pending = timers.get(root)
          if (pending !== undefined) clearTimeout(pending)
          timers.set(root, setTimeout(() => {
            timers.delete(root)
            for (const [id, bound] of roots) {
              const live = agents.get(id)
              if (bound === root && live !== undefined) void refresh(live)
            }
          }, 800))
        }))
      }
      const project = await runtime.project.state()
      if (disposed || !agents.has(agent.id)) return
      const zh = promptLanguage(project.manifest.language) === 'zh'
      const path = displayPath(workspace, root)
      const from = state.switched !== undefined && state.switched.from !== root
        ? { ...state.switched, from: near.find(book => book.root === state.switched!.from)?.title ?? basename(state.switched.from) }
        : undefined
      const focus = focusLines({ title: project.manifest.title, path, zh, switched: from, others: near.filter(book => book.root !== root) })
      digests.set(agent.id, { text: `${focus}\n${renderDigest(project, state.mode, path, (await novel.core.autoFor(runtime)).autoDigest)}\n${modeRules(state.mode, zh)}`, root, ...bound })
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'novel/locked') {
        // The book in play is sealed and locked: whatever was known of it a moment ago is no longer the model's to use.
        const bound = novel.sessions.peek(agent.id)?.project
        const workspace = novel.workspaceOfAgent(agent)
        const locked = await novel.bookOfSession(agent.id, workspace).catch(() => undefined)
        const others = (await novel.booksNear(agent.id, workspace).catch(() => [])).filter(book => book.root !== locked)
        if (!disposed && agents.has(agent.id)) digests.set(agent.id, { text: lockedContext(error.message, others), ...(bound !== undefined ? { bound } : {}) })
        return
      }
      novel.log(`could not refresh the project digest for ${agent.id}`, error)
    }
  }

  ctx.systemPrompt.context({
    name: PROJECT_CONTEXT,
    order: CONTEXT_ORDER,
    // Assembled once for every step, just before the request: what this returns is what the model knows from here on.
    text: (context) => {
      const agent = context.scope as Agent | undefined
      if (agent === undefined || typeof agent.id !== 'string') return ''
      const digest = digests.get(agent.id)
      const bound = novel.sessions.peek(agent.id)?.project
      if (digest !== undefined && bound !== undefined && digest.bound !== bound) {
        // The author changed book a moment ago and the new digest is not read yet.
        novel.markShown(agent.id, bound)
        return movedContext(displayPath(novel.workspaceOfAgent(agent), bound))
      }
      novel.markShown(agent.id, digest?.root)
      return digest?.text ?? ''
    },
  })

  ctx.on('agent/created', async ({ agent }) => {
    // A role's run is no conversation of the author's: it is on the book its task names, and has its own prompt.
    if (novel.crew.isRole(agent.id)) return undefined
    agents.set(agent.id, agent)
    // Awaited so the first request already carries the digest.
    await refresh(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    agents.delete(agent.id)
    digests.delete(agent.id)
    roots.delete(agent.id)
    novel.forgetSession(agent.id)
  })
  ctx.effect(() => novel.sessions.onChange((sessionId) => {
    const agent = agents.get(sessionId)
    if (agent !== undefined) void refresh(agent)
  }), 'novel: session state watch')
  // A book locked or unlocked is news for every conversation on it: what the model may know changes at once.
  ctx.effect(() => novel.core.onLock((root) => {
    // The old runtime is gone with the lock; its watch would never fire again.
    watches.get(root)?.()
    watches.delete(root)
    for (const [id, agent] of agents) if (roots.get(id) === root || novel.sessions.peek(id)?.project === root) void refresh(agent)
  }), 'novel: lock watch')
  ctx.effect(() => () => {
    disposed = true
    for (const stop of watches.values()) stop()
    for (const timer of timers.values()) clearTimeout(timer)
    watches.clear()
    timers.clear()
  }, 'novel: project watches')

  // ── a book's own files are changed through the Studio, not around it ──
  /**
   * The book file a raw tool call is about to change, if it is one: the
   * manuscript, the bible, the outline, the Studio's records. Reading is never
   * stopped; neither is anything outside a book.
   */
  const rawTarget = async (exec: { name: string; arguments: unknown; agent?: Agent | undefined }): Promise<{ title: string; file: string; kind: NonNullable<ReturnType<typeof managedKind>> } | undefined> => {
    if (exec.agent === undefined) return undefined
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const workspace = novel.workspaceOfAgent(exec.agent)
    const books = [...await novel.booksNear(exec.agent.id, workspace)]
    const inPlay = await novel.projectOfAgent(exec.agent).catch(() => undefined)
    if (inPlay !== undefined && !books.some(book => book.root === inPlay.project.root)) books.push({ root: inPlay.project.root, title: (await inPlay.project.manifest()).title, relative: '.' })
    if (books.length === 0) return undefined
    const inBook = (path: string): { title: string; file: string; kind: NonNullable<ReturnType<typeof managedKind>> } | undefined => {
      const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path)
      for (const book of books) {
        const inside = relative(book.root, absolute)
        if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) continue
        const kind = managedKind(inside)
        if (kind !== undefined) return { title: book.title, file: inside.split(sep).join('/'), kind }
      }
      return undefined
    }
    if (exec.name === 'write' || exec.name === 'edit') return typeof args.file_path === 'string' ? inBook(args.file_path) : undefined
    if (exec.name === 'str_replace_editor') return typeof args.path === 'string' && args.command !== 'view' ? inBook(args.path) : undefined
    if (exec.name === 'bash' && typeof args.command === 'string') {
      // A shell line is not parsed, only looked at: something that writes, aimed at a path of a book.
      const command = args.command
      const managed = String.raw`(?:manuscript/|bible/|\.novel/|outline\.json|novel\.json)`
      const writes = new RegExp(String.raw`>>?\s*["']?[^\s"';|&]*${managed}|\b(?:sed|perl)\s+-[a-zA-Z]*i[^|;&]*${managed}|\b(?:tee|mv|rm|truncate)\b[^|;&]*${managed}`)
      const hit = writes.exec(command)
      if (hit === null) return undefined
      const named = new RegExp(String.raw`[^\s"';|&>]*${managed}[^\s"';|&]*`).exec(hit[0])?.[0]
      // A path written relative to a book's own folder is that book's.
      return named !== undefined ? inBook(named) ?? books.map(book => inBook(resolve(book.root, named))).find(found => found !== undefined) : undefined
    }
    return undefined
  }
  const INSTEAD: Record<NonNullable<ReturnType<typeof managedKind>>, string> = {
    chapter: 'novel_edit (an exact change: replace, insert, append, delete, set) — or novel_write / novel_revise when prose has to be written',
    bible: 'novel_bible action=save (characters, world entries, styles)',
    outline: 'novel_outline (volumes, chapters, beats, threads)',
    manifest: 'novel_settings action=book',
    state: 'the tool that owns that record — novel_memory for what the book remembers, novel_digest, novel_audio and novel_manage for scripts, novel_comic for storyboards',
  }

  // ── ask before writing in a read-only session ──
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'str_replace_editor' || exec.name === 'bash') {
      const policy = novel.core.currentSettings().agentFiles ?? 'guide'
      const target = policy === 'allow' ? undefined : await rawTarget(exec).catch(() => undefined)
      if (target !== undefined) {
        const why = `${target.file} belongs to the book "${target.title}". Novel Studio keeps a version of what its text was, the memory digested from it, the search index and the book's record in step with every change made through its tools; a change made around them leaves all of that describing a book that no longer exists.`
        if (policy === 'ask') {
          return {
            kind: 'ask',
            reason: `${why} Prefer ${INSTEAD[target.kind]}.`,
            displayReason: {
              en: `The showrunner wants to change ${target.file} of "${target.title}" with a raw file tool instead of Novel Studio's own. No version of the text is kept that way, and memory is only caught up afterwards.`,
              zh: `总编想绕过小说工坊，直接用文件工具改《${target.title}》的 ${target.file}。这样改不会留下改动前的版本，记忆也只能事后补收录。`,
            },
          }
        }
        return { kind: 'deny', reason: `${why} Make this change with ${INSTEAD[target.kind]} instead. Reading these files with file tools is fine.` }
      }
      return await next()
    }
    const mutates = MUTATING.get(exec.name)
    if (mutates === undefined || exec.agent === undefined) return await next()
    let writes = true
    try {
      writes = mutates(exec.arguments)
    } catch {
      writes = true
    }
    if (writes && novel.isReadOnly(exec.agent)) {
      return {
        kind: 'ask',
        reason: `${exec.name} changes the novel project, and this session is read-only.`,
        displayReason: { en: `${exec.name} wants to change the novel project in a read-only session.`, zh: `${exec.name} 要修改小说项目，但当前会话是只读权限。` },
      }
    }
    // Some things are never done on the model's say-so alone, whatever the session allows.
    const action = (exec.arguments as { action?: unknown } | undefined)?.action
    if (exec.name === 'novel_manage' && action === 'delete_book') {
      const title = await novel.requireProject(exec.agent, typeof (exec.arguments as { book?: unknown }).book === 'string' ? (exec.arguments as { book: string }).book : undefined)
        .then(async runtime => (await runtime.project.manifest()).title, () => undefined)
      if (title !== undefined) {
        return {
          kind: 'ask',
          reason: `novel_manage wants to remove the book "${title}" (its files go to the trash).`,
          displayReason: { en: `Remove the book "${title}"? Its files go to the trash and can be put back from there.`, zh: `要删除《${title}》吗？它的文件会移到废纸篓，可以从那里找回。` },
        }
      }
    }
    if (exec.name === 'novel_share' && action === 'on') {
      const edit = (exec.arguments as { mode?: unknown }).mode === 'edit'
      return {
        kind: 'ask',
        reason: `novel_share wants to open a book to other devices on the local network${edit ? ', and let them change it' : ''}.`,
        displayReason: edit
          ? { en: 'Open this book to other devices on the same network, and let them change it? Anyone there who has the link can edit its text and play its interludes — which uses the models set up here.', zh: '要把这本书开放给同一网络下的其他设备，并且允许在那边修改吗？拿到链接的人可以改正文、玩幕间——幕间会调用这里配置的模型。' }
          : { en: 'Open this book to other devices on the same network? Anyone there who has the link can read it.', zh: '要把这本书开放给同一网络下的其他设备阅读吗？拿到链接的人都能读到它。' },
      }
    }
    // Reaching out of the session's workspace to change another book is the model's own idea, not the author's click: ask.
    const named = (exec.arguments as { book?: unknown } | undefined)?.book
    if (writes && typeof named === 'string' && named.trim().length > 0) {
      try {
        const workspace = novel.workspaceOfAgent(exec.agent)
        const target = await novel.resolveBook(named, workspace)
        const root = target.project.root
        const inPlay = (await novel.projectOfAgent(exec.agent))?.project.root
        if (root !== inPlay && displayPath(workspace, root) === root) {
          const title = (await target.project.manifest()).title
          return {
            kind: 'ask',
            reason: `${exec.name} changes "${title}", a book outside this conversation's workspace (${root}).`,
            displayReason: { en: `${exec.name} wants to change "${title}", a book outside this conversation's workspace.`, zh: `${exec.name} 要修改《${title}》——它不在这场对话的工作区里。` },
          }
        }
      } catch {
        // An unknown book is reported by the tool itself, in words the model can act on.
      }
    }
    return await next()
  })

  // ── /novel for humans ──
  ctx.inject(['commands'], (inner) => {
    inner.commands.register({
      name: 'novel',
      description: 'Novel Studio: status · mode <name> · digest · export <markdown|text|html|epub>',
      input: { hint: 'status | mode draft | digest | export epub' },
      handler: async (invocation) => {
        const agent = invocation.agent
        const [command = 'status', ...rest] = invocation.rawInput.trim().split(/\s+/).filter(part => part.length > 0)
        try {
          const state = await novel.sessions.get(agent.id)
          if (command === 'mode') {
            const wanted = rest[0] as WorkMode | undefined
            if (wanted === undefined) return { kind: 'success', text: `Mode: ${state.mode}. Available: ${WORK_MODES.join(', ')}` }
            if (!WORK_MODES.includes(wanted)) return { kind: 'error', text: `Unknown mode "${wanted}". Available: ${WORK_MODES.join(', ')}` }
            await novel.bind(agent.id, { mode: wanted })
            return { kind: 'success', text: `Mode → ${wanted} (${modeLabel(wanted, true)})` }
          }
          if (command === 'help') {
            return { kind: 'success', text: '/novel status — where the project stands\n/novel mode <ideate|bible|outline|draft|revise|review|stage|play>\n/novel digest — refresh memory for changed chapters\n/novel export <markdown|text|html|epub>' }
          }
          const runtime = await novel.projectOfAgent(agent)
          if (runtime === undefined) return { kind: 'success', text: `No novel project in ${novel.workspaceOfAgent(agent)} yet. Ask the agent to start one, or create it in Novel Studio.` }
          const where = displayPath(novel.workspaceOfAgent(agent), runtime.project.root)
          if (command === 'digest') {
            const started = novel.core.jobs.start({ kind: 'digest', title: 'digest', project: runtime.project.root, origin: 'user', signal: invocation.signal }, async job => await digestPending(novel.core, runtime, { origin: 'user', signal: job.signal, job }))
            const result = await started.done
            return { kind: 'success', text: `Digested ${result.digested.length} chapters${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}.` }
          }
          if (command === 'export') {
            const format = (rest[0] ?? 'markdown') as ExportFormat
            if (!['markdown', 'text', 'html', 'epub'].includes(format)) return { kind: 'error', text: 'Formats: markdown, text, html, epub' }
            const result = await exportBook(runtime, { format })
            return { kind: 'success', text: `Exported ${result.chapters} chapters → ${where}/${result.path}` }
          }
          if (command !== 'status') return { kind: 'error', text: `Unknown subcommand "${command}". Try /novel help` }
          const { text } = await renderStatus(runtime, state.mode, where, novel.core.jobs.list(runtime.project.root), 'brief', (await novel.core.autoFor(runtime)).autoDigest)
          return { kind: 'success', text }
        } catch (error) {
          return { kind: 'error', text: errorMessage(error) }
        }
      },
    })
  })
}

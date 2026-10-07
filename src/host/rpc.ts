// SPDX-License-Identifier: LGPL-3.0-or-later
/** Handlers of the Studio's RPC contract (see shared/rpc.ts). */
import { join } from 'node:path'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core/core'
import type { JobContext } from '../core/jobs'
import { stockVoices } from '../core/media/voices'
import {
  audition, buildAudioScript, designCharacterVoice, exportChapterAudio, playable, previewVoices, reshapeAudioScript, soundPlan, synthesizeChapter, updateAudioLine,
} from '../core/pipelines/audio'
import { addCue, renderSound, updateCue } from '../core/pipelines/sound'
import { soundSetup } from '../core/media/sound'
import { acceptSuggestion, dismissSuggestion, expandCharacter, expandWorld, extractStyle, styleSample } from '../core/pipelines/bible'
import { buildStoryboard, renderPanels, updateComicPanel } from '../core/pipelines/comic'
import { digestPending } from '../core/pipelines/digest'
import { exportBook, missingImages } from '../core/pipelines/export'
import { deriveVisual, illustrate } from '../core/pipelines/illustrate'
import { importManuscript, readBookFile } from '../core/pipelines/import'
import { applyOutlineOps, type OutlineOp } from '../core/pipelines/outline'
import {
  ensurePortrait, novelizePlay, paintPlayScene, playTurn, rewindPlay, setPlayOutcome, startPlay, voicePlayLine,
} from '../core/pipelines/play'
import { buildFoundation, deriveBeats, deriveChapters, whatIf } from '../core/pipelines/plot'
import { resolveIssue, reviewChapter } from '../core/pipelines/review'
import { acceptProposal, rejectProposal, reviseBook, reviseChapter, reviseSpan } from '../core/pipelines/revise'
import { writeChapter } from '../core/pipelines/write'
import { ProjectError } from '../core/project'
import { listWalkOns, settleWalkOn } from '../core/walkons'
import { checkPassword, readStub, VaultError } from '../core/util/vault'
import type { DeepPartial } from '../core/settings'
import { rangeStart, summarize, type UsageRange } from '../core/usage'
import { sleep } from '../core/util/async'
import type { FindMatch, ModelKind, NovelRpc, RpcMethod, RpcParams, RpcResult, SettingsView } from '../shared/rpc'
import type { SetupPart } from '../shared/services'
import { hashText, proseOnly } from '../shared/text'
import { STORYBOARD_DENSITIES, type JobKind, type NovelSettings, type WorkMode } from '../shared/types'
import type { NovelService } from './service'

type Handlers = { [M in RpcMethod]: (params: RpcParams<M>, signal: AbortSignal) => Promise<RpcResult<M>> }

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ProjectError('novel/bad-request', `"${name}" is required`)
  return value
}

export function createHandlers(service: NovelService): Handlers {
  const core: NovelCore = service.core
  const open = async (root: unknown): Promise<ProjectRuntime> => await core.runtime(requireString(root, 'root'))

  /** Run a pipeline as a user-started job and answer with its id at once. */
  const job = (runtime: ProjectRuntime, kind: JobKind, title: string, target: string | undefined, task: (context: TaskContext, job: JobContext) => Promise<unknown>): { jobId: string } => {
    const started = core.jobs.start({ kind, title, project: runtime.project.root, origin: 'user', ...(target !== undefined ? { target } : {}) }, async (context) => {
      const result = await task({ origin: 'user', signal: context.signal, job: context }, context)
      // Results small enough for a poll response travel with the job; the Studio reads them from there.
      if (result !== undefined && result !== null && typeof result === 'object') context.result({ output: result as Record<string, unknown> })
      return result
    })
    return { jobId: started.id }
  }

  const settingsView = async (): Promise<SettingsView> => {
    const settings = await core.settings.get()
    let models: SettingsView['models'] = []
    let providers: SettingsView['providers'] = []
    try {
      if (core.llm.catalog !== undefined) ({ models, providers } = await core.llm.catalog())
      else models = await core.llm.listModels()
    } catch (error) {
      service.log('could not list models', error)
    }
    if (providers.length === 0) {
      // A backend that only lists models still has providers: the ones its models name.
      const seen = new Map<string, { id: string; name: string; models: number }>()
      for (const model of models) {
        const entry = seen.get(model.provider) ?? { id: model.provider, name: model.providerName, models: 0 }
        entry.models += 1
        seen.set(model.provider, entry)
      }
      providers = [...seen.values()]
    }
    const defaultRoute = core.llm.defaultRoute()
    const [keys, codex] = await Promise.all([service.keyStates(settings), service.codex()])
    const roles = Object.values(settings.models).filter((route): route is NonNullable<typeof route> => route !== undefined)
    const direct = roles.filter(route => route.baseURL !== undefined)
    const ready = {
      // A role either names an endpoint that has a key, or rides on a model the Harness provides.
      text: direct.every(route => service.hasKey(keys, route.baseURL, route.apiKeyRef)) && (direct.length === roles.length && roles.length === 4 ? true : models.length > 0 || defaultRoute !== undefined || direct.length > 0),
      ...service.mediaReady(settings, keys, codex),
    }
    const untouched = roles.length === 0 && settings.image.provider === 'none' && settings.tts.provider === 'none' && settings.embedding.provider === 'none'
    return {
      settings,
      models,
      providers,
      ...(defaultRoute !== undefined ? { defaultRoute } : {}),
      voices: stockVoices(settings.tts.provider, settings.tts.model),
      keys,
      codex,
      ready,
      setupNeeded: untouched && settings.setup?.done !== true,
      version: __NOVEL_VERSION__,
    }
  }

  const handlers: Handlers = {
    // ── workspace & project ──
    'workspace.info': async ({ sessionId }) => {
      const workspaces = await service.workspaces()
      const home = service.workspaceHome()
      if (sessionId === undefined) return { workspaces, home }
      const current = await service.workspaceOfSession(sessionId)
      const state = await service.sessions.get(sessionId)
      if (current !== undefined && !workspaces.some(workspace => workspace.path === current)) {
        workspaces.unshift({ title: current.split(/[\\/]/).filter(Boolean).at(-1) ?? current, path: current, projects: await core.discover(current) })
      }
      const active = await service.projectOfSession(sessionId, current)
      return { workspaces, home, ...(current !== undefined ? { current } : {}), ...(active !== undefined ? { active: active.project.root } : {}), mode: state.mode }
    },
    'workspace.create': async ({ name, path }) => await service.createWorkspace({ ...(name !== undefined ? { name } : {}), ...(path !== undefined ? { path } : {}) }),
    'project.create': async (params) => {
      const workspace = requireString(params.workspace, 'workspace')
      const title = requireString(params.title, 'title')
      const root = await core.suggestRoot(workspace, title)
      const runtime = await core.create(root, {
        title,
        ...(params.language !== undefined ? { language: params.language } : {}),
        ...(params.genre !== undefined ? { genre: params.genre } : {}),
        ...(params.logline !== undefined ? { logline: params.logline } : {}),
        ...(params.premise !== undefined ? { premise: params.premise } : {}),
        ...(params.author !== undefined ? { author: params.author } : {}),
      })
      if (params.sessionId !== undefined) await service.bind(params.sessionId, { project: root })
      if (params.idea !== undefined && params.idea.trim().length > 0) {
        const idea = params.idea
        return { root, ...job(runtime, 'derive', 'foundation', undefined, async task => await buildFoundation(core, runtime, { idea, keepTitle: params.untitled !== true }, task)) }
      }
      return { root }
    },
    'project.state': async ({ root }) => await (await open(root)).project.state(),
    'project.update': async ({ root, patch }) => await (await open(root)).project.updateManifest(patch),
    'project.delete': async ({ root }) => await service.deleteBook(requireString(root, 'root')),
    // ── sealed books ──
    'lock.get': async ({ root }) => await service.lockView(requireString(root, 'root')),
    'lock.seal': async ({ root, password, label, device }) => {
      const runtime = await open(root)
      const secret = requireString(password, 'password')
      try {
        checkPassword(secret)
      } catch (error) {
        throw new ProjectError('novel/invalid', error instanceof Error ? error.message : String(error))
      }
      return job(runtime, 'seal', 'seal', undefined, async (task) => {
        const sealed = await core.sealBook(runtime.project.root, { password: secret, ...(label !== undefined && label.trim().length > 0 ? { label } : {}) }, (done) => { task.job?.progress(done, 0) })
        // This computer's own unlock is added once the book is under its seal; failing here leaves a book that opens with its password.
        let deviceOn = false
        if (device === true) deviceOn = await service.setDeviceUnlock(runtime.project.root, true).then(() => true, (error: unknown) => { service.log('this computer\'s unlock could not be set up for a sealed book', error); return false })
        return { files: sealed.files, deviceOn }
      })
    },
    'lock.unseal': async ({ root }) => {
      const runtime = await open(root)
      return job(runtime, 'seal', 'unseal', undefined, async (task) => {
        const stub = await readStub(runtime.project.root)
        const result = await core.unsealBook(runtime.project.root, (done) => { task.job?.progress(done, 0) })
        // A plain book needs no keeper: what this computer held for it goes.
        if (result.left === 0 && stub !== undefined) await service.device?.remove(stub.id).catch(() => {})
        return result
      })
    },
    'lock.open': async ({ root, password, device }, signal) => {
      await service.unlockBook(requireString(root, 'root'), { ...(password !== undefined ? { password } : {}), ...(device !== undefined ? { device } : {}) }, signal)
      return await service.lockView(root)
    },
    'lock.close': async ({ root }) => {
      await core.lockBook(requireString(root, 'root'))
      return await service.lockView(root)
    },
    'lock.change': async ({ root, password, label, device, forget }) => {
      try {
        if (password !== undefined && password.length > 0) await core.rekeyBook(root, { password })
        if (label !== undefined && label.trim().length > 0) await core.rekeyBook(root, { label })
        if (device !== undefined) await service.setDeviceUnlock(root, device)
        if (forget !== undefined) await core.rekeyBook(root, { remove: forget })
      } catch (error) {
        if (error instanceof VaultError) throw new ProjectError('novel/invalid', error.message)
        throw error
      }
      return await service.lockView(root)
    },
    'session.bind': async ({ sessionId, project, mode }) => await service.bind(requireString(sessionId, 'sessionId'), {
      ...(project !== undefined ? { project } : {}),
      ...(mode !== undefined ? { mode } : {}),
    }),
    'events.wait': async ({ root, revision, tick, timeoutMs, sessionId, active }, signal) => {
      const runtime = root !== undefined ? await core.tryRuntime(root) : undefined
      // The book in play can change behind the Studio's back — the showrunner moves the session — and the Studio follows.
      const inPlay = async (): Promise<{ active?: string; mode?: WorkMode }> => {
        if (sessionId === undefined) return {}
        const [book, state] = await Promise.all([service.projectOfSession(sessionId), service.sessions.get(sessionId)])
        return { ...(book !== undefined ? { active: book.project.root } : {}), mode: state.mode }
      }
      const snapshot = async (): Promise<{ revision: number; tick: number; active?: string; mode?: WorkMode }> => ({ revision: runtime?.project.revision ?? 0, tick: core.jobs.tick, ...await inPlay() })
      const now = await snapshot()
      if (now.revision !== revision || now.tick !== tick || (sessionId !== undefined && now.active !== active)) return now
      await new Promise<void>((resolve) => {
        const done = (): void => {
          offProject?.()
          offJobs()
          offSession()
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          resolve()
        }
        const offProject = runtime?.project.onChange(done)
        const offJobs = core.jobs.onChange(done)
        const offSession = sessionId !== undefined ? service.sessions.onChange((changed) => { if (changed === sessionId) done() }) : () => {}
        const timer = setTimeout(done, Math.max(1000, Math.min(30_000, timeoutMs ?? 25_000)))
        signal.addEventListener('abort', done, { once: true })
      })
      // Bursts of writes (a save plus its outline update) settle into one wake-up.
      await sleep(40).catch(() => {})
      return await snapshot()
    },

    // ── bible ──
    'character.save': async ({ root, card }) => await (await open(root)).project.saveCharacter(card),
    'character.delete': async ({ root, id }) => ({ deleted: await (await open(root)).project.deleteCharacter(id) }),
    'character.expand': async ({ root, id, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `expand ${id}`, id, async task => await expandCharacter(core, runtime, { character: id, ...(direction !== undefined ? { direction } : {}) }, task))
    },
    'character.visual': async ({ root, id, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `visual anchor ${id}`, id, async task => await deriveVisual(core, runtime, { character: id, ...(direction !== undefined && direction.length > 0 ? { direction } : {}) }, task))
    },
    'world.save': async ({ root, entry }) => await (await open(root)).project.saveWorld(entry),
    'world.delete': async ({ root, id }) => ({ deleted: await (await open(root)).project.deleteWorld(id) }),
    'world.expand': async ({ root, id, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `expand ${id}`, id, async task => await expandWorld(core, runtime, { entry: id, ...(direction !== undefined ? { direction } : {}) }, task))
    },
    'style.save': async ({ root, style, activate }) => {
      const runtime = await open(root)
      const saved = await runtime.project.saveStyle(style)
      if (activate === true) await runtime.project.updateManifest({ activeStyle: saved.id })
      return saved
    },
    'style.delete': async ({ root, id }) => ({ deleted: await (await open(root)).project.deleteStyle(id) }),
    'style.extract': async ({ root, sample, name, activate }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'extract style', undefined, async task => await extractStyle(core, runtime, { sample, ...(name !== undefined ? { name } : {}), ...(activate !== undefined ? { activate } : {}) }, task))
    },
    'style.sample': async ({ root, style, draft, scene }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'style sample', undefined, async task => ({ text: await styleSample(core, runtime, { ...(style !== undefined ? { style } : {}), ...(draft !== undefined ? { draft } : {}), ...(scene !== undefined ? { scene } : {}) }, task) }))
    },
    'cast.walkons': async ({ root, ignored }) => ({ walkons: await listWalkOns((await open(root)).project, { ignored: ignored === true }) }),
    'cast.settle': async ({ root, name, action, target, role }) => {
      const { project } = await open(root)
      const settled = await settleWalkOn(project, { name: requireString(name, 'name'), action, ...(target !== undefined ? { target } : {}), ...(role !== undefined ? { role } : {}) })
      return { walkons: await listWalkOns(project, { ignored: true }), lines: settled.lines, ...(settled.card !== undefined ? { card: settled.card } : {}) }
    },
    'suggestion.accept': async ({ root, id }) => {
      await acceptSuggestion(await open(root), id)
      return { ok: true }
    },
    'suggestion.dismiss': async ({ root, id }) => ({ ok: await dismissSuggestion(await open(root), id) }),

    // ── outline ──
    'outline.apply': async ({ root, ops }) => ({ results: await applyOutlineOps(await open(root), ops as unknown as OutlineOp[]) }),

    // ── manuscript ──
    'chapter.read': async ({ root, id }) => {
      const { project } = await open(root)
      const chapter = await project.findChapter(id)
      if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${id}"`)
      const text = await project.chapterText(chapter.plan.id)
      const [memory, review, versions, missing] = await Promise.all([
        project.memory(chapter.plan.id), project.review(chapter.plan.id), project.versions(chapter.plan.id), missingImages(project, text),
      ])
      return {
        plan: chapter.plan,
        index: chapter.index,
        volumeId: chapter.volume.id,
        text,
        ...(memory !== undefined ? { memory } : {}),
        ...(review !== undefined ? { review } : {}),
        versions,
        missingImages: missing,
      }
    },
    'chapter.save': async ({ root, id, text, reason }) => {
      const { project } = await open(root)
      const why = reason ?? 'edit'
      // The editor autosaves every few seconds; one restore point per sitting is enough.
      return await project.saveChapterText(id, text, { reason: why, snapshot: why !== 'edit' || await project.editSnapshotDue(id) })
    },
    'chapter.version': async ({ root, id, version }) => {
      const text = await (await open(root)).project.versionText(id, version)
      if (text === undefined) throw new ProjectError('novel/not-found', 'no such version')
      return { text }
    },
    'chapter.restore': async ({ root, id, version }) => ({ ok: await (await open(root)).project.restoreVersion(id, version) }),
    'search': async ({ root, query, sources, limit }, signal) => {
      const runtime = await open(root)
      const hits = await runtime.index.search(query, { limit: limit ?? 12, ...(sources !== undefined ? { sources } : {}), signal })
      return {
        hits,
        embedded: runtime.index.embedded,
        indexed: runtime.index.size,
        ...(runtime.index.embeddingError !== undefined ? { embeddingError: runtime.index.embeddingError } : {}),
      }
    },
    'find': async ({ root, query, limit }) => {
      const { project } = await open(root)
      const needle = query.trim()
      const matches: FindMatch[] = []
      let total = 0
      if (needle.length === 0) return { matches, total }
      const cap = limit ?? 200
      const folded = needle.toLowerCase()
      for (const chapter of await project.chapters()) {
        const text = await project.chapterText(chapter.plan.id)
        const haystack = text.toLowerCase()
        for (let at = haystack.indexOf(folded); at >= 0; at = haystack.indexOf(folded, at + folded.length)) {
          total += 1
          if (matches.length >= cap) continue
          const start = Math.max(0, at - 24)
          matches.push({
            chapterId: chapter.plan.id,
            title: chapter.plan.title,
            index: chapter.index,
            offset: at,
            // One space per newline keeps `at` pointing at the match.
            snippet: text.slice(start, Math.min(text.length, at + needle.length + 40)).replace(/\n/g, ' '),
            at: at - start,
            length: needle.length,
          })
        }
      }
      return { matches, total }
    },

    // ── model work ──
    'ai.write': async ({ root, chapter, brief, mode, words, style }) => {
      const runtime = await open(root)
      return job(runtime, 'write', 'write', chapter, async task => await writeChapter(core, runtime, {
        ...(chapter !== undefined ? { chapter } : {}),
        ...(brief !== undefined ? { brief } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(words !== undefined ? { words } : {}),
        ...(style !== undefined ? { style } : {}),
      }, task))
    },
    'ai.reviseSpan': async ({ root, chapter, start, end, quote, instruction }) => {
      const runtime = await open(root)
      return job(runtime, 'revise', 'revise passage', chapter, async (task) => {
        const { before: _before, ...rest } = await reviseSpan(core, runtime, { chapter, start, end, ...(quote !== undefined ? { quote } : {}), instruction: requireString(instruction, 'instruction'), apply: false }, task)
        return rest
      })
    },
    'ai.reviseChapter': async ({ root, chapter, instruction }) => {
      const runtime = await open(root)
      return job(runtime, 'revise', 'revise chapter', chapter, async (task) => {
        const { before: _before, after: _after, ...rest } = await reviseChapter(core, runtime, { chapter, instruction: requireString(instruction, 'instruction'), apply: false }, task)
        return rest
      })
    },
    'ai.reviseBook': async ({ root, instruction, chapters }) => {
      const runtime = await open(root)
      return job(runtime, 'revise', 'revise book', undefined, async task => await reviseBook(core, runtime, { instruction: requireString(instruction, 'instruction'), ...(chapters !== undefined ? { chapters } : {}) }, task))
    },
    'ai.digest': async ({ root, chapters, force }) => {
      const runtime = await open(root)
      return job(runtime, 'digest', 'digest', chapters?.[0], async task => await digestPending(core, runtime, task, { ...(chapters !== undefined ? { chapters } : {}), ...(force !== undefined ? { force } : {}) }))
    },
    'ai.review': async ({ root, chapter, focus }) => {
      const runtime = await open(root)
      return job(runtime, 'review', 'review', chapter, async (task) => {
        const review = await reviewChapter(core, runtime, { chapter, ...(focus !== undefined ? { focus } : {}) }, task)
        return { chapterId: review.chapterId, issues: review.issues.length, verdict: review.verdict }
      })
    },
    'ai.deriveChapters': async ({ root, count, direction, volume, apply }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'derive chapters', undefined, async task => await deriveChapters(core, runtime, {
        ...(count !== undefined ? { count } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(volume !== undefined ? { volume } : {}),
        ...(apply !== undefined ? { apply } : {}),
      }, task))
    },
    'ai.deriveBeats': async ({ root, chapter, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'derive beats', chapter, async task => await deriveBeats(core, runtime, { chapter, ...(direction !== undefined ? { direction } : {}) }, task))
    },
    'ai.whatIf': async ({ root, question, branches }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'what-if', undefined, async task => await whatIf(core, runtime, { question: requireString(question, 'question'), ...(branches !== undefined ? { branches } : {}) }, task))
    },
    'ai.import': async ({ root, text, file, analyze }) => {
      const runtime = await open(root)
      let manuscript = typeof text === 'string' ? text : ''
      if (file !== undefined) {
        let book: ReturnType<typeof readBookFile>
        try {
          book = readBookFile(requireString(file.name, 'file.name'), Buffer.from(requireString(file.data, 'file.data'), 'base64'))
        } catch (error) {
          throw new ProjectError('novel/invalid', error instanceof Error ? error.message : String(error))
        }
        manuscript = book.text
        // A file that names its book and author knows better than the name it was saved under.
        const manifest = await runtime.project.manifest()
        const stem = file.name.replace(/\.[^.]+$/, '')
        await runtime.project.updateManifest({
          ...(book.title !== undefined && (manifest.title === stem || manifest.title.length === 0) ? { title: book.title } : {}),
          ...(book.author !== undefined && manifest.author === undefined ? { author: book.author } : {}),
        })
      }
      if (manuscript.trim().length === 0) throw new ProjectError('novel/bad-request', 'there is no text to import')
      return job(runtime, 'import', 'import', undefined, async task => await importManuscript(core, runtime, { text: manuscript, ...(analyze !== undefined ? { analyze } : {}) }, task))
    },
    'ai.foundation': async ({ root, idea }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'foundation', undefined, async task => await buildFoundation(core, runtime, { idea: requireString(idea, 'idea') }, task))
    },
    'ai.index': async ({ root }) => {
      const runtime = await open(root)
      return job(runtime, 'index', 'index', undefined, async (task, context) => ({
        embedded: await runtime.index.embedPending({ signal: context.signal, onProgress: (done, total) => { context.progress(done, total) } }),
        indexed: runtime.index.size,
        ...(task.origin === 'user' ? {} : {}),
      }))
    },
    'proposal.accept': async ({ root, id }) => await acceptProposal(core, await open(root), id, { origin: 'user' }),
    'proposal.reject': async ({ root, id }) => ({ ok: (await rejectProposal(await open(root), id)) !== undefined }),
    'review.resolve': async ({ root, chapter, issue, resolved }) => ({ ok: (await resolveIssue(await open(root), chapter, issue, resolved)) !== undefined }),

    // ── jobs ──
    'jobs.list': async ({ root }) => ({ jobs: core.jobs.list(root) }),
    'jobs.read': async ({ id, cursor, thoughtCursor, waitMs }, signal) => {
      const read = (): RpcResult<'jobs.read'> => {
        const state = core.jobs.read(id, cursor ?? 0, thoughtCursor)
        if (state === undefined) throw new ProjectError('novel/not-found', `no job "${id}"`)
        return state
      }
      // Something new for this reader: more text, more thought (when it follows the thought), or the end.
      const fresh = (state: RpcResult<'jobs.read'>): boolean => state.text.length > 0 || (state.thought?.length ?? 0) > 0 || state.info.status !== 'running'
      let state = read()
      // Long-poll: hold the request until there is more to read or the job settles.
      if (waitMs !== undefined && waitMs > 0 && !fresh(state)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            off()
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolve()
          }
          const off = core.jobs.onChange(() => {
            const next = core.jobs.read(id, cursor ?? 0, thoughtCursor)
            if (next === undefined || fresh(next)) done()
          })
          const timer = setTimeout(done, Math.min(20_000, waitMs))
          signal.addEventListener('abort', done, { once: true })
        })
        state = read()
      }
      return state
    },
    'jobs.cancel': async ({ id }) => ({ cancelled: core.jobs.cancel(id) }),

    // ── illustration ──
    'image.create': async ({ root, ...params }) => {
      const runtime = await open(root)
      return job(runtime, 'illustrate', `illustrate ${params.kind}`, params.target, async task => await illustrate(core, runtime, params, task))
    },
    'image.list': async ({ root }) => ({ images: (await (await open(root)).project.illustrations()).reverse() }),
    'image.delete': async ({ root, id }) => {
      await (await open(root)).project.removeIllustration(id)
      return { ok: true }
    },

    // ── audio drama ──
    'audio.script': async ({ root, chapter }) => {
      const { project } = await open(root)
      const located = await project.findChapter(chapter)
      if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapter}"`)
      const script = await project.audioScript(located.plan.id)
      const stale = script !== undefined && script.textHash !== hashText(proseOnly(await project.chapterText(located.plan.id)))
      const settings = await core.settings.get()
      // Who sounds like whom in this chapter: what was cast, and what will be for those who have not spoken yet.
      const cast = script !== undefined ? await previewVoices(project, settings.tts, script.lines).catch(() => undefined) : undefined
      const sound = soundSetup(settings)
      return {
        // Handed over as it will play: lines left unspoken say so.
        ...(script !== undefined ? { script: playable(script, settings.tts) } : {}),
        stale,
        ...(cast !== undefined ? { cast } : {}),
        ...(sound !== undefined ? { sound: { model: sound.model, shared: sound.shared, beds: soundPlan(settings).beds } } : {}),
      }
    },
    'audio.build': async ({ root, chapter, force }) => {
      const runtime = await open(root)
      return job(runtime, 'audio', 'audio script', chapter, async (task) => {
        const script = await buildAudioScript(core, runtime, { chapter, ...(force !== undefined ? { force } : {}) }, task)
        return { chapterId: script.chapterId, lines: script.lines.length }
      })
    },
    'audio.synthesize': async ({ root, chapter, lines, force }) => {
      const runtime = await open(root)
      return job(runtime, 'audio', 'synthesize', chapter, async task => await synthesizeChapter(core, runtime, { chapter, ...(lines !== undefined ? { lines } : {}), ...(force !== undefined ? { force } : {}) }, task))
    },
    'audio.updateLine': async ({ root, chapter, line, patch }) => playable(await updateAudioLine(await open(root), chapter, line, patch), (await core.settings.get()).tts),
    'audio.reshape': async ({ root, chapter }) => {
      const result = await reshapeAudioScript(await open(root), chapter)
      return { ...result, script: playable(result.script, (await core.settings.get()).tts) }
    },
    'audio.sound': async ({ root, chapter, cues, kinds, force }) => {
      const runtime = await open(root)
      return job(runtime, 'audio', 'sound', chapter, async task => await renderSound(core, runtime, { chapter, ...(cues !== undefined ? { cues } : {}), ...(kinds !== undefined ? { kinds } : {}), ...(force !== undefined ? { force } : {}) }, task))
    },
    'audio.updateCue': async ({ root, chapter, cue, patch, remove, dropClip }) => playable(await updateCue(await open(root), { chapter, cue, ...(patch !== undefined ? { patch } : {}), ...(remove !== undefined ? { remove } : {}), ...(dropClip !== undefined ? { dropClip } : {}) }), (await core.settings.get()).tts),
    'audio.addCue': async ({ root, chapter, at, kind, caption, prompt, ambience, intensity }) => playable((await addCue(await open(root), { chapter, at, kind, ...(caption !== undefined ? { caption } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(ambience !== undefined ? { ambience } : {}), ...(intensity !== undefined ? { intensity } : {}) })).script, (await core.settings.get()).tts),
    'audio.export': async ({ root, chapter }) => await exportChapterAudio(await open(root), chapter, (await core.settings.get()).tts),
    'voice.audition': async ({ root, voice, character, text, direction }) => {
      const runtime = await open(root)
      const sample = requireString(text, 'text')
      return job(runtime, 'audio', 'audition', typeof character === 'string' && character.length > 0 ? character : undefined, async task => await audition(core, runtime, {
        text: sample,
        ...(voice !== undefined && voice.length > 0 ? { voice } : {}),
        ...(typeof character === 'string' && character.length > 0 ? { character } : {}),
        ...(direction !== undefined && direction.length > 0 ? { direction } : {}),
      }, task))
    },
    'voice.design': async ({ root, character, prompt }) => {
      const runtime = await open(root)
      return job(runtime, 'audio', 'design voice', character, async task => await designCharacterVoice(core, runtime, { character, ...(prompt !== undefined && prompt.length > 0 ? { prompt } : {}) }, task))
    },

    // ── motion comic ──
    'comic.board': async ({ root, chapter }) => {
      const { project } = await open(root)
      const located = await project.findChapter(chapter)
      if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapter}"`)
      const board = await project.comicBoard(located.plan.id)
      const stale = board !== undefined && board.textHash !== hashText(proseOnly(await project.chapterText(located.plan.id)))
      return { ...(board !== undefined ? { board } : {}), stale }
    },
    'comic.build': async ({ root, chapter, force, density, maxPanels }) => {
      const runtime = await open(root)
      return job(runtime, 'comic', 'storyboard', chapter, async (task) => {
        const board = await buildStoryboard(core, runtime, {
          chapter,
          ...(force !== undefined ? { force } : {}),
          ...(density !== undefined && STORYBOARD_DENSITIES.includes(density) ? { density } : {}),
          ...(typeof maxPanels === 'number' && maxPanels > 0 ? { maxPanels } : {}),
        }, task)
        return { chapterId: board.chapterId, panels: board.panels.length, ...(board.note !== undefined ? { note: board.note } : {}) }
      })
    },
    'comic.render': async ({ root, chapter, panels, force }) => {
      const runtime = await open(root)
      return job(runtime, 'comic', 'draw panels', chapter, async task => await renderPanels(core, runtime, { chapter, ...(panels !== undefined ? { panels } : {}), ...(force !== undefined ? { force } : {}) }, task))
    },
    'comic.updatePanel': async ({ root, chapter, panel, patch }) => await updateComicPanel(await open(root), chapter, panel, patch),

    // ── interlude ──
    'play.list': async ({ root }) => ({
      sessions: (await (await open(root)).project.playSessions()).map(session => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        cast: session.cast,
        ...(session.outcome !== undefined ? { outcome: session.outcome } : {}),
        ...(session.player !== undefined ? { player: session.player } : {}),
        ...(session.anchorChapter !== undefined ? { anchorChapter: session.anchorChapter } : {}),
      })),
    }),
    'play.get': async ({ root, id }) => {
      const session = await (await open(root)).project.playSession(id)
      if (session === undefined) throw new ProjectError('novel/not-found', `no interlude "${id}"`)
      return session
    },
    'play.start': async ({ root, ...params }, signal) => await startPlay(core, await open(root), params, { origin: 'user', signal }),
    'play.turn': async ({ root, id, kind, text }, signal) => await playTurn(core, await open(root), { session: id, text, ...(kind !== undefined ? { kind } : {}) }, { origin: 'user', signal }),
    'play.rewind': async ({ root, id }) => await rewindPlay(await open(root), id),
    'play.outcome': async ({ root, id, outcome }) => await setPlayOutcome(await open(root), id, outcome),
    'play.delete': async ({ root, id }) => {
      await (await open(root)).project.deletePlaySession(id)
      return { ok: true }
    },
    'play.voice': async ({ root, id, turn, line }, signal) => await voicePlayLine(core, await open(root), { session: id, turn, line }, { origin: 'user', signal }),
    'play.scene': async ({ root, id, turn }, signal) => await paintPlayScene(core, await open(root), { session: id, turn }, { origin: 'user', signal }),
    'play.portrait': async ({ root, character }, signal) => await ensurePortrait(core, await open(root), character, { origin: 'user', signal }),
    'play.novelize': async ({ root, id, title }) => {
      const runtime = await open(root)
      return job(runtime, 'play', 'novelize', id, async task => await novelizePlay(core, runtime, { session: id, ...(title !== undefined ? { title } : {}) }, task))
    },

    // ── export ──
    'export.book': async ({ root, format }) => {
      const runtime = await open(root)
      const result = await exportBook(runtime, { format })
      return { path: result.path, chapters: result.chapters, bytes: result.bytes, absolute: join(runtime.project.root, result.path) }
    },

    // ── reading on other devices ──
    'share.status': async () => await service.share.status(),
    'share.update': async ({ enabled, book, port, renew }) => await service.updateShare({
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(book !== undefined && typeof book.root === 'string' ? { book: { root: book.root, shared: book.shared === true, ...(book.mode === 'edit' || book.mode === 'read' ? { mode: book.mode } : {}) } } : {}),
      ...(typeof port === 'number' ? { port } : {}),
      ...(renew === true ? { renew: true } : {}),
    }),

    // ── settings ──
    'settings.get': async () => await settingsView(),
    'settings.update': async ({ patch, keys }) => {
      // Keys first: a setting that points at an endpoint should find its key the moment it is saved.
      for (const [url, value] of Object.entries(keys ?? {})) {
        if (typeof value !== 'string') continue
        if (value.trim().length === 0) await service.keys.clear(url)
        else await service.keys.save(url, value)
      }
      await core.settings.update(patch as DeepPartial<NovelSettings>)
      return await settingsView()
    },
    'key.state': async ({ endpoints }) => ({
      states: await Promise.all((Array.isArray(endpoints) ? endpoints : []).slice(0, 24).map(async endpoint => await service.keys.describe(requireString(endpoint.url, 'url'), endpoint.ref))),
    }),
    'usage.summary': async ({ root, range }) => {
      const wanted: UsageRange = range === 'today' || range === '7d' || range === '30d' ? range : 'all'
      const since = rangeStart(wanted)
      const book = root !== undefined ? (await open(root)).project.root : undefined
      const events = (await core.usage.read(since)).filter(event => book === undefined || event.book === book)
      const prices = (await core.settings.get()).prices ?? {}
      const begun = await core.usage.begun()
      return { summary: summarize(events, prices, { since }), prices, ...(begun !== undefined ? { begun } : {}) }
    },
    'endpoint.models': async ({ url, kind, key, ref }, signal) => ({
      models: await service.endpointModels(requireString(url, 'url'), (['text', 'embedding', 'image', 'speech'] as ModelKind[]).includes(kind) ? kind : 'text', key, ref, signal),
    }),
    'endpoint.check': async ({ url, key, ref }, signal) => await service.checkEndpoint(requireString(url, 'url'), key, ref, signal),
    'setup.apply': async ({ service: target, key, origin, parts }) => {
      const wanted = (Array.isArray(parts) ? parts : []).filter((part): part is SetupPart => ['text', 'embedding', 'image', 'tts'].includes(part))
      const { check } = await service.applySetup({ service: target, parts: wanted, ...(key !== undefined ? { key } : {}), ...(origin !== undefined ? { origin } : {}) })
      return { view: await settingsView(), check }
    },
    'setup.dismiss': async () => {
      await core.settings.update({ setup: { done: true, at: new Date().toISOString() } } as DeepPartial<NovelSettings>)
      return await settingsView()
    },
    'model.info': async ({ provider, model, baseURL }) => {
      const route = { provider: requireString(provider, 'provider'), model: requireString(model, 'model'), ...(typeof baseURL === 'string' && baseURL.length > 0 ? { baseURL } : {}) }
      const [contextWindow, reasoning, output] = await Promise.all([
        core.llm.contextWindow(route).catch(() => undefined),
        core.llm.reasoning?.(route).catch(() => undefined),
        core.llm.outputCap?.(route).catch(() => undefined),
      ])
      return {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(output?.cap !== undefined ? { outputCap: output.cap } : {}),
        ...(output?.most !== undefined ? { maxOutput: output.most } : {}),
        efforts: reasoning?.efforts ?? [],
        ...(reasoning?.defaultEffort !== undefined ? { defaultEffort: reasoning.defaultEffort } : {}),
      }
    },
  }
  return handlers
}

export type { NovelRpc }

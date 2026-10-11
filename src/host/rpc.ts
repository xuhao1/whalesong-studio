// SPDX-License-Identifier: LGPL-3.0-or-later
/** Handlers of the Studio's RPC contract (see shared/rpc.ts). */
import { deriveGrowth } from '../core/pipelines/growth'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { HISTORY_KINDS } from '../shared/history'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core/core'
import type { JobContext } from '../core/jobs'
import { stockVoices } from '../core/media/voices'
import {
  audition, buildAudioScript, clearAudioScript, designCharacterVoice, exportChapterAudio, playable, previewVoices, removeAudioLine, reshapeAudioScript, soundPlan, synthesizeChapter, updateAudioLine,
} from '../core/pipelines/audio'
import { addCue, renderSound, updateCue } from '../core/pipelines/sound'
import { soundSetup } from '../core/media/sound'
import { acceptSuggestion, dismissSuggestion, expandCharacter, expandWorld, extractStyle, styleSample, writeLife, deriveTies, tidyWorld } from '../core/pipelines/bible'
import { artPlan, runBatch, stageOverview, stagePlan, stageReadiness, textPlan, type BatchPlan } from '../core/pipelines/batch'
import { buildStoryboard, clearComicBoard, removeComicPanel, renderPanels, sheetsAhead, updateComicPanel } from '../core/pipelines/comic'
import { chapterVideoWithSubtitles, chapterVideo, findProgram, produceVideo, removeVideo, videoReadiness } from '../core/pipelines/video'
import { CREW } from '../core/crew'
import { contextBudgets } from '../core/context'
import { resolveRoute } from '../core/llm'
import { L, promptLanguage } from '../core/render'
import { digestPending, fillPlans } from '../core/pipelines/digest'
import { exportBook, missingImages } from '../core/pipelines/export'
import { findPicturePress, findSoundPress } from '../core/media/press'
import { publishSite, siteChaptersUpTo, siteDefaults, siteFolder } from '../core/pipelines/site'
import { listChapters, listLines, listSides, readAlbum, readPosition, readSide, savePosition } from '../core/reader'
import { albumCounts, albumEmpty } from '../shared/album'
import { sceneOfPicture, scenesOf } from '../shared/art'
import { deriveArtDirection, deriveLook, deriveScenes, deriveVisual, hangPicture, illustrate, importPicture, pictureWhole, redrawPicture } from '../core/pipelines/illustrate'
import { analyzeBook, importManuscript, readBookFile, importLine, rereadBook } from '../core/pipelines/import'
import { applyOutlineOps, type OutlineOp } from '../core/pipelines/outline'
import {
  ensurePortrait, novelizePlay, paintPlayScene, playTurn, rewindPlay, setPlayOutcome, startPlay, voicePlayLine,
} from '../core/pipelines/play'
import { buildFoundation, deriveBeats, deriveChapters, whatIf } from '../core/pipelines/plot'
import { clearReview, listReviews, noteIssue, recheckIssues, resolveIssue, reviewChapter } from '../core/pipelines/review'
import { fixIssue, fixIssues, acceptProposal, rejectProposal, reviseBook, reviseChapter, reviseSpan, mendInTurn } from '../core/pipelines/revise'
import { writeChapter } from '../core/pipelines/write'
import { imageSetups, speechSetups, trialDerive, trialSpeak, trialWrite } from '../core/pipelines/trial'
import { cleanGuides } from '../core/pipelines/guides'
import { consultReferences } from '../core/pipelines/consult'
import { addBookReference, addTextReference, referenceShelf, removeReference, setReferenceUse, updateReference } from '../core/references'
import { ProjectError } from '../core/project'
import { cardWalkOns, siftCast } from '../core/pipelines/cast'
import { overrule, settleSuggestions, settlesItself } from '../core/pipelines/settle'
import { loopbackPort, signInOf } from './remote'
import { comfyCatalog, comfyLastWorkflow, comfyTakeWorkflow, WORKFLOW_NOTE } from '../core/media/local'
import { listWalkOns, settleWalkOn } from '../core/walkons'
import { checkPassword, readStub, VaultError } from '../core/util/vault'
import type { DeepPartial } from '../core/settings'
import { rangeStart, summarize, type UsageRange } from '../core/usage'
import { sleep } from '../core/util/async'
import type { BookSettingsView, CodexStatus, ContextView, CrewView, FindMatch, ModelKind, NovelRpc, RpcMethod, RpcParams, RpcResult, SettingsView, SitePlan } from '../shared/rpc'
import { speechSetupName, switchTts, ttsService, ttsWays, withBook } from '../shared/images'
import { PROJECT_HOMEPAGE, type SetupPart } from '../shared/services'
import { hashText, proseOnly } from '../shared/text'
import { ANALYZE_STEPS, CREW_ROLES, GLOSSARY_KINDS, MAIN_LINE, STAGE_STEPS, STORYBOARD_DENSITIES, TEXT_STEPS, type GlossaryTerm, type JobKind, type NovelSettings, type ProjectManifest, type StageStep, type TextRole, type TextStep, type WorkMode, type HistoryKind } from '../shared/types'
import { settleTerms, translateChapters, untranslateChapter } from '../core/pipelines/translate'
import { recommendedView, settleRecommended } from './recommended'
import type { NovelService } from './service'

type Handlers = { [M in RpcMethod]: (params: RpcParams<M>, signal: AbortSignal) => Promise<RpcResult<M>> }

/** What a request says about where it came from; set by the route for the time a handler runs. */
export const calling = new AsyncLocalStorage<{ session?: string; /** Where the request reached DSH, and the sign-in it carried. */ web?: { host: string; cookie: string } }>()

/** What a history is kept of, as a request names it. */
function historyKind(value: unknown): HistoryKind {
  const kind = HISTORY_KINDS.find(item => item === value)
  if (kind !== undefined) return kind
  throw new ProjectError('novel/invalid', `a history is kept of: ${HISTORY_KINDS.join(', ')}`)
}

/** Work on the private shelf, with what goes wrong said as a request can say it: a wrong or a weak password is no crash. */
async function shelfWork(work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (error instanceof VaultError) throw new ProjectError(error.code === 'wrong-key' ? 'novel/wrong-key' : 'novel/invalid', error.message)
    if (error instanceof ProjectError) throw error
    throw new ProjectError('novel/invalid', error instanceof Error ? error.message : String(error))
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ProjectError('novel/bad-request', `"${name}" is required`)
  return value
}

export function createHandlers(service: NovelService): Handlers {
  const core: NovelCore = service.core
  const open = async (root: unknown): Promise<ProjectRuntime> => await core.runtime(requireString(root, 'root'))
  /** The speech settings as they hold for a book: its own where it has them. */
  const ttsOf = async (root: unknown): Promise<NovelSettings['tts']> => (await core.settingsOf(await open(root))).tts

  /**
   * The author's own task. Started in the Studio beside a conversation, it is
   * that conversation's: the role agents it starts become its children, and a
   * role with no model of its own rides on the conversation's.
   */
  const userTask = async (session: string | undefined, rest: Pick<TaskContext, 'signal' | 'job'>): Promise<TaskContext> => {
    const agent = session !== undefined ? await service.agentOfSession(session) : undefined
    const route = agent !== undefined ? service.routeOf(agent) : undefined
    return { origin: 'user', ...rest, ...(agent !== undefined ? { caller: agent } : {}), ...(route !== undefined ? { agentRoute: route } : {}) }
  }

  /** Run a pipeline as a user-started job and answer with its id at once. */
  const job = (runtime: ProjectRuntime, kind: JobKind, title: string, target: string | undefined, task: (context: TaskContext, job: JobContext) => Promise<unknown>): { jobId: string } => {
    // Read now: by the time the job runs, the request that started it is over.
    const session = calling.getStore()?.session
    const started = core.jobs.start({ kind, title, project: runtime.project.root, origin: 'user', ...(target !== undefined ? { target } : {}) }, async (context) => {
      const result = await task(await userTask(session, { signal: context.signal, job: context }), context)
      // Results small enough for a poll response travel with the job; the Studio reads them from there.
      if (result !== undefined && result !== null && typeof result === 'object') context.result({ output: result as Record<string, unknown> })
      return result
    })
    return { jobId: started.id }
  }

  /** The crew role by role: the model each would run on — for a book, the one the book gives it — and whether that model can drive an agent. */
  const crewRoles = (settings: NovelSettings, manifest?: ProjectManifest): CrewView['roles'] => CREW_ROLES.map((role) => {
    let route: ReturnType<typeof resolveRoute> | undefined
    try {
      route = resolveRoute(role, settings, core.llm, manifest !== undefined ? { manifest } : {})
    } catch {
      route = undefined
    }
    return {
      role,
      ...(route !== undefined ? { model: route.model, provider: route.provider } : {}),
      agent: route !== undefined && core.roles?.can(route) === true,
      direct: route?.baseURL !== undefined,
      own: [...CREW[role].tools],
      steps: CREW[role].steps,
    }
  })

  const crewView = async (settings: NovelSettings): Promise<CrewView> => {
    const [ffmpeg, ffprobe] = await Promise.all([findProgram('ffmpeg'), findProgram('ffprobe')])
    return {
      loop: core.roles !== undefined,
      subagents: service.subagentsMounted(),
      roles: crewRoles(settings),
      help: service.outsideHelp(),
      helpers: await service.helpView(),
      ffmpeg: ffmpeg !== undefined && ffprobe !== undefined,
    }
  }

  /** A batch as a job: what it is of is its title, and every step's state travels as the job's result. */
  const batch = async (runtime: ProjectRuntime, title: string, plan: (task: Pick<TaskContext, 'agentRoute'>) => Promise<BatchPlan>): Promise<{ jobId: string }> => {
    const lang = promptLanguage((await runtime.project.manifest()).language)
    // Laid out before the job starts: what cannot be done at all is said at once, not found in a job that failed.
    const session = calling.getStore()?.session
    const laid = await plan(await userTask(session, {}))
    return job(runtime, 'batch', title, undefined, async (task) => {
      const result = await runBatch(laid, task, lang)
      return { done: result.done, skipped: result.skipped, failed: result.failed }
    })
  }

  const contextView = async (settings: NovelSettings, manifest?: ProjectManifest): Promise<ContextView[]> => {
    const rows: ContextView[] = []
    for (const role of ['writer', 'architect', 'analyst', 'director'] as TextRole[]) {
      let route: ReturnType<typeof resolveRoute> | undefined
      try {
        route = resolveRoute(role, settings, core.llm, manifest !== undefined ? { manifest } : {})
      } catch {
        route = undefined
      }
      const window = route !== undefined ? await core.windowOf(route) : undefined
      // A book with budgets of its own is shown with them.
      const context = withBook(settings, manifest).context
      const budgets = contextBudgets(context.strategy, context.budgetTokens, window, context.sideTokens)
      rows.push({ role, ...(route !== undefined ? { model: route.model } : {}), ...(window !== undefined ? { window } : {}), textBudget: budgets.textBudget, sideBudget: budgets.sideBudget })
    }
    return rows
  }

  /** The settings as they stand for one book: what its own services can do, what its crew runs on, and which of its models DSH no longer lists. */
  const bookSettingsView = async (root: string, settings: NovelSettings, models: SettingsView['models'], providers: SettingsView['providers'], codex: CodexStatus): Promise<BookSettingsView | undefined> => {
    let manifest: ProjectManifest
    try {
      // A book that is locked says nothing of itself; the page then shows the Studio's own.
      manifest = await (await core.runtime(root)).project.manifest()
    } catch {
      return undefined
    }
    const held = withBook(settings, manifest)
    const ready = service.mediaReady(held, await service.keyStates(held), codex)
    const unlisted: BookSettingsView['unlisted'] = []
    for (const [role, route] of Object.entries(manifest.models ?? {})) {
      // A directly called endpoint of the old kind is nothing DSH would list.
      if (route === undefined || route.baseURL !== undefined || route.provider.length === 0) continue
      const provider = providers.find(candidate => candidate.id === route.provider)
      const listed = models.some(model => model.provider === route.provider && model.id === route.model)
      // A provider that cannot list its models right now is not one that has dropped this model.
      if (provider === undefined || (!listed && provider.error === undefined && provider.models > 0)) unlisted.push({ role: role as TextRole, provider: route.provider, model: route.model, noProvider: provider === undefined })
    }
    return { root, ready: { image: ready.image, tts: ready.tts, sound: ready.sound, embedding: ready.embedding }, roles: crewRoles(settings, manifest), context: await contextView(settings, manifest), voices: stockVoices(held.tts.provider, held.tts.model), unlisted }
  }

  const settingsView = async (root?: string): Promise<SettingsView> => {
    await service.recommendations
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
      crew: await crewView(settings),
      context: await contextView(settings),
      version: __NOVEL_VERSION__,
      recommended: recommendedView(settings),
      build: await service.buildState(),
      ...await (async () => {
        const book = typeof root === 'string' && root.length > 0 ? await bookSettingsView(root, settings, models, providers, codex) : undefined
        return book !== undefined ? { book } : {}
      })(),
    }
  }

  /** Said with every look the Studio takes: its Host half is no longer the installed build — and whether it can change that itself. */
  const staleNote = async (): Promise<{ stale?: true; reloadable?: true }> => {
    const build = await service.buildState()
    return build.stale ? { stale: true, ...(build.reloadable ? { reloadable: true } : {}) } : {}
  }

  const handlers: Handlers = {
    // ── workspace & project ──
    'workspace.info': async ({ sessionId }) => {
      const workspaces = await service.workspaces()
      const home = service.workspaceHome()
      const shelf = await service.shelfView()
      if (sessionId === undefined) return { workspaces, home, shelf, ...await staleNote() }
      const current = await service.workspaceOfSession(sessionId)
      const state = await service.sessions.get(sessionId)
      if (current !== undefined && !workspaces.some(workspace => workspace.path === current)) {
        workspaces.unshift({ title: current.split(/[\\/]/).filter(Boolean).at(-1) ?? current, path: current, projects: await core.discover(current) })
      }
      // Found without opening it: a book in play that is locked is shown by its lock, not as a failure.
      const active = await service.bookOfSession(sessionId, current)
      return { workspaces, home, shelf, ...(current !== undefined ? { current } : {}), ...(active !== undefined ? { active } : {}), mode: state.mode, ...await staleNote() }
    },
    'workspace.create': async ({ name, path }) => await service.createWorkspace({ ...(name !== undefined ? { name } : {}), ...(path !== undefined ? { path } : {}) }),
    'project.create': async (params) => {
      const workspace = requireString(params.workspace, 'workspace')
      const title = requireString(params.title, 'title')
      // A password that will not do is refused before anything is made.
      const seal = params.seal
      if (seal !== undefined) {
        try {
          checkPassword(requireString(seal.password, 'seal.password'))
        } catch (error) {
          throw new ProjectError('novel/invalid', error instanceof Error ? error.message : String(error))
        }
      }
      const root = await core.suggestRoot(workspace, title)
      let runtime = await core.create(root, {
        title,
        ...(params.language !== undefined ? { language: params.language } : {}),
        ...(params.genre !== undefined ? { genre: params.genre } : {}),
        ...(params.logline !== undefined ? { logline: params.logline } : {}),
        ...(params.premise !== undefined ? { premise: params.premise } : {}),
        ...(params.author !== undefined ? { author: params.author } : {}),
      })
      if (seal !== undefined) {
        // Sealed while it holds nothing but its first empty files: what is drafted or imported next is written as ciphertext.
        await core.sealBook(root, { password: seal.password, ...(seal.label !== undefined && seal.label.trim().length > 0 ? { label: seal.label.trim() } : {}) })
        runtime = await core.runtime(root)
      }
      if (params.sessionId !== undefined) await service.bind(params.sessionId, { project: root })
      if (params.idea !== undefined && params.idea.trim().length > 0) {
        const idea = params.idea
        const sealed = runtime
        return { root, ...(seal !== undefined ? { sealed: true } : {}), ...job(sealed, 'derive', 'foundation', undefined, async task => await buildFoundation(core, sealed, { idea, keepTitle: params.untitled !== true }, task)) }
      }
      return { root, ...(seal !== undefined ? { sealed: true } : {}) }
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
      // The conversations about the book come back out from under its seal with it.
      await service.sessionSeal.sync(root).catch((error: unknown) => { service.log('could not put the conversations of an unlocked book back', error) })
      return await service.lockView(root)
    },
    'lock.close': async ({ root }) => {
      await core.lockBook(requireString(root, 'root'))
      await service.sessionSeal.sync(root).catch((error: unknown) => { service.log('could not seal the conversations of a locked book', error) })
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
    'shelf.get': async () => await service.shelfView(),
    'shelf.setup': async ({ password }) => {
      const secret = requireString(password, 'password')
      await shelfWork(async () => { await core.setupShelf(secret, await core.shelved((await service.workspaces()).map(workspace => workspace.path))) })
      return await service.shelfView()
    },
    'shelf.open': async ({ password, device }, signal) => {
      // Opened the way a sealed book is: with its password, or by this computer's own unlock.
      await service.unlockShelf({ ...(typeof password === 'string' ? { password } : {}), ...(device === true ? { device } : {}) }, signal)
      return await service.shelfView()
    },
    'shelf.device': async ({ on }) => {
      await shelfWork(async () => { await service.setShelfDeviceUnlock(on === true) })
      return await service.shelfView()
    },
    'shelf.close': async () => {
      await core.closeShelf()
      return await service.shelfView()
    },
    'shelf.change': async ({ password, next }) => {
      const [was, now] = [requireString(password, 'password'), requireString(next, 'next')]
      await shelfWork(async () => { await core.rekeyShelf(was, now, await core.shelved((await service.workspaces()).map(workspace => workspace.path))) })
      return await service.shelfView()
    },
    'shelf.add': async ({ root, own }) => {
      const runtime = await open(root)
      const how = typeof own === 'string' && own.length > 0 ? { own } : own === true ? { own: true as const } : {}
      if (typeof how.own === 'string') await shelfWork(async () => { checkPassword(how.own as string) })
      return job(runtime, 'seal', 'shelve', undefined, async (task) => {
        const done = await core.shelveBook(runtime.project.root, how, (count) => { task.job?.progress(count, 0) })
        return { files: done.files }
      })
    },
    'shelf.remove': async ({ root, password }) => {
      await shelfWork(async () => { await core.unshelveBook(requireString(root, 'root'), password) })
      return await service.shelfView()
    },
    'conversation.open': async ({ root, workspace, create }) => {
      if (root === undefined && workspace === undefined) throw new ProjectError('novel/invalid', 'name a book (`root`) or a folder (`workspace`)')
      return await service.conversationFor({ ...(root !== undefined ? { root } : {}), ...(workspace !== undefined ? { workspace } : {}) }, create === true) ?? {}
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
        // Found without opening it: a book in play that is locked is still where the session is.
        const [book, state] = await Promise.all([service.bookOfSession(sessionId), service.sessions.get(sessionId)])
        return { ...(book !== undefined ? { active: book } : {}), mode: state.mode }
      }
      const snapshot = async (): Promise<{ revision: number; tick: number; active?: string; mode?: WorkMode; stale?: boolean; reloadable?: boolean }> => ({ revision: runtime?.project.revision ?? 0, tick: core.jobs.tick, ...await inPlay(), ...await staleNote() })
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
    'character.scenePicture': async ({ root, id, scene, path }) => await (await open(root)).project.setScenePicture(requireString(id, 'id'), requireString(scene, 'scene'), requireString(path, 'path')),
    'character.delete': async ({ root, id }) => ({ deleted: await (await open(root)).project.deleteCharacter(id) }),
    'character.mark': async ({ root, id, chapter, kind, what }) => await (await open(root)).project.markLife(requireString(id, 'id'), {
      ...(typeof chapter === 'string' && chapter.length > 0 ? { chapter } : {}),
      ...(kind === 'enter' || kind === 'return' || kind === 'exit' || kind === 'death' ? { kind } : {}),
      ...(typeof what === 'string' ? { what } : {}),
    }),
    'character.expand': async ({ root, id, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `expand ${id}`, id, async task => await expandCharacter(core, runtime, { character: id, ...(direction !== undefined ? { direction } : {}) }, task))
    },
    'tie.save': async ({ root, tie }) => await (await open(root)).project.saveTie(tie),
    'tie.remove': async ({ root, id }) => ({ removed: await (await open(root)).project.removeTie(requireString(id, 'id')) }),
    'ai.ties': async ({ root, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'ties', undefined, async task => await deriveTies(core, runtime, typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}, task))
    },
    'line.world': async ({ root, line }) => await (await open(root)).project.lineWorld(typeof line === 'string' && line.length > 0 ? line : undefined),
    'cast.lives': async ({ root, line }) => await (await open(root)).project.lives(typeof line === 'string' && line.length > 0 ? line : undefined),
    'ai.characterLife': async ({ root, id, line }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `life ${id}`, id, async task => await writeLife(core, runtime, { character: requireString(id, 'id'), ...(typeof line === 'string' && line.length > 0 ? { line } : {}) }, task))
    },
    'character.visual': async ({ root, id, direction, stage }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `appearance ${id}`, id, async task => await deriveVisual(core, runtime, { character: id, ...(direction !== undefined && direction.length > 0 ? { direction } : {}), ...(typeof stage === 'string' && stage.length > 0 ? { stage } : {}) }, task))
    },
    'character.scene': async ({ root, id, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `signature scenes ${id}`, id, async task => await deriveScenes(core, runtime, { character: id, ...(direction !== undefined && direction.length > 0 ? { direction } : {}) }, task))
    },
    'character.growth': async ({ root, id, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `growth ${id}`, id, async task => await deriveGrowth(core, runtime, { character: id, ...(direction !== undefined && direction.length > 0 ? { direction } : {}) }, task))
    },
    'world.save': async ({ root, entry }) => {
      const { project } = await open(root)
      const saved = await project.saveWorld(entry)
      // A picture chosen as the main one that was drawn to compare and still waited to be taken: it is taken.
      if (typeof entry.visualMain === 'string' && entry.visualMain.trim().length > 0 && saved.visualMain === entry.visualMain.trim()) await project.tookTrial(saved.visualMain)
      return saved
    },
    'world.merge': async ({ root, keep, fold }) => {
      const runtime = await open(root)
      return await runtime.project.mergeWorld(requireString(keep, 'keep'), Array.isArray(fold) ? fold.filter((item): item is string => typeof item === 'string') : [])
    },
    'ai.worldTidy': async ({ root }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'tidy world', undefined, async task => await tidyWorld(core, runtime, task))
    },
    'graph.place': async ({ root, id, at }) => ({ graph: await (await open(root)).project.placeInGraph(id, at) }),
    'world.pin': async ({ root, id, key, at }) => {
      const fraction = (value: unknown): number => Math.min(1, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0.5))
      if (key !== undefined && !/^(world|character):.{1,120}$/.test(key)) throw new ProjectError('novel/invalid', 'a mark is named by world:<id> or character:<id>')
      // A patch that names one mark changes that one; `null` lets a mark — or all of them — go.
      const spots = key === undefined ? null : { [key]: at !== undefined ? { x: fraction(at.x), y: fraction(at.y) } : null }
      return await (await open(root)).project.saveWorld({ id, spots } as never)
    },
    'ai.worldLook': async ({ root, id, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', `look ${id}`, id, async task => await deriveLook(core, runtime, { entry: requireString(id, 'id'), ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, task))
    },
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
    'image.comfy': async ({ baseURL }) => await comfyCatalog(typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL : core.currentSettings().image.baseURL),
    'image.comfyAdopt': async ({ baseURL }) => {
      const last = await comfyLastWorkflow(typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL : core.currentSettings().image.baseURL)
      if (last === undefined) throw new ProjectError('novel/not-found', 'the ComfyUI server has no run in its history that made a picture from a text — run the workflow once in ComfyUI, or export it in API format and name the file')
      return { workflow: JSON.stringify({ ...last.workflow, [WORKFLOW_NOTE]: { from: 'the server\'s last run' } }), ...(last.model !== undefined ? { model: last.model } : {}), nodes: last.nodes, images: last.images }
    },
    'image.comfyTake': async ({ baseURL, path }) => {
      const taken = await comfyTakeWorkflow(typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL : core.currentSettings().image.baseURL, requireString(path, 'path'))
      return { workflow: JSON.stringify({ ...taken.workflow, [WORKFLOW_NOTE]: { from: path } }), ...(taken.model !== undefined ? { model: taken.model } : {}), nodes: taken.nodes, images: taken.images }
    },
    'cast.sift': async ({ root, all, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'sift cast', undefined, async task => await siftCast(core, runtime, { ...(all === true ? { all: true } : {}), ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, task))
    },
    'cast.card': async ({ root, people, role }) => {
      const runtime = await open(root)
      const wanted = (Array.isArray(people) ? people : []).filter(item => item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name.trim().length > 0).map(item => ({ name: item.name, ...(typeof item.story === 'string' ? { story: item.story } : {}) }))
      if (wanted.length === 0) throw new ProjectError('novel/invalid', 'name whom to give a card')
      return job(runtime, 'bible', 'card walk-ons', undefined, async task => await cardWalkOns(core, runtime, { people: wanted, ...(role !== undefined ? { role } : {}) }, task))
    },
    'cast.settle': async ({ root, name, story, action, target, role }) => {
      const { project } = await open(root)
      const settled = await settleWalkOn(project, { name: requireString(name, 'name'), action, ...(typeof story === 'string' ? { story } : {}), ...(target !== undefined ? { target } : {}), ...(role !== undefined ? { role } : {}) })
      return { walkons: await listWalkOns(project, { ignored: true }), lines: settled.lines, ...(settled.card !== undefined ? { card: settled.card } : {}) }
    },
    'suggestion.accept': async ({ root, id }) => {
      await acceptSuggestion(await open(root), id)
      return { ok: true }
    },
    'suggestion.dismiss': async ({ root, id }) => ({ ok: await dismissSuggestion(await open(root), id) }),
    'import.reread': async ({ root, plans, reviews, style }) => {
      const runtime = await open(root)
      return job(runtime, 'import', 'reread', undefined, async task => await rereadBook(core, runtime, { ...(plans === false ? { plans: false } : {}), ...(reviews === false ? { reviews: false } : {}), ...(style === false ? { style: false } : {}) }, task))
    },
    'suggestion.settled': async ({ root }) => ({ items: await (await open(root)).project.settled(), auto: settlesItself(core) }),
    'suggestion.settle': async ({ root }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'settle suggestions', undefined, async task => await settleSuggestions(core, runtime, task))
    },
    'suggestion.overrule': async ({ root, id, to }) => {
      const runtime = await open(root)
      const item = await overrule(runtime, id, to === 'enter' ? 'enter' : 'undo')
      return { item }
    },

    // ── outline ──
    'outline.apply': async ({ root, ops }) => ({ results: await applyOutlineOps(await open(root), ops as unknown as OutlineOp[]) }),
    'outline.fill': async ({ root, dry }) => {
      const runtime = await open(root)
      const filled = await fillPlans(runtime, undefined, dry === true)
      if (dry !== true && filled.chapters > 0) {
        const zh = promptLanguage((await runtime.project.manifest()).language) === 'zh'
        await runtime.project.addActivity({ by: 'editor', tool: 'outline', summary: zh ? `按收录结果补全了 ${filled.chapters} 章章纲里空着的 ${filled.fields} 项` : `Filled ${filled.fields} empty fields of ${filled.chapters} chapter plans from their digests` })
      }
      return filled
    },

    // ── manuscript ──
    'chapter.read': async ({ root, id }) => {
      const { project } = await open(root)
      const chapter = await project.findChapter(id)
      if (chapter === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${id}"`)
      const text = await project.chapterText(chapter.plan.id)
      const [memory, review, versions, missing, figures] = await Promise.all([
        project.memory(chapter.plan.id), project.review(chapter.plan.id), project.versions(chapter.plan.id), missingImages(project, text), project.chapterFigures(chapter.plan.id, text),
      ])
      return {
        ...(figures.length > 0 ? { figures } : {}),
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
    'ai.write': async ({ root, chapter, brief, mode, words, style, line, guides }) => {
      const runtime = await open(root)
      return job(runtime, 'write', 'write', chapter, async task => await writeChapter(core, runtime, {
        ...(chapter !== undefined ? { chapter } : {}),
        ...(typeof line === 'string' && line.length > 0 ? { line } : {}),
        ...(brief !== undefined ? { brief } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(words !== undefined ? { words } : {}),
        ...(style !== undefined ? { style } : {}),
        ...(Array.isArray(guides) ? { guides: cleanGuides(guides) } : {}),
      }, task))
    },
    'guide.add': async ({ root, mediaType, data }) => {
      const { project } = await open(root)
      const ending = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[String(mediaType)]
      if (ending === undefined) throw new ProjectError('novel/invalid', 'a picture to steer by is a PNG, JPEG, WebP or GIF')
      const bytes = Buffer.from(requireString(data, 'data'), 'base64')
      // Told by its first bytes, whatever it was called.
      const head = bytes.subarray(0, 12)
      const real = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'png' : head[0] === 0xff && head[1] === 0xd8 ? 'jpg' : head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp' : head.subarray(0, 3).toString('latin1') === 'GIF' ? 'gif' : undefined
      if (real === undefined || bytes.length < 64) throw new ProjectError('novel/invalid', 'that is not a picture the Studio can read (PNG, JPEG, WebP, GIF)')
      if (bytes.length > 24 * 1024 * 1024) throw new ProjectError('novel/invalid', 'that picture is larger than 24 MB: bring in a smaller copy')
      // Named by what it is: the same picture brought in twice is one file.
      return { path: await project.writeAsset(`guides/${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${real}`, bytes) }
    },
    'references.list': async ({ root }) => await referenceShelf(core, await open(root)),
    'references.add': async ({ root, book, text, file, title, note, scope }) => {
      const runtime = await open(root)
      const said = typeof note === 'string' && note.trim().length > 0 ? { note } : {}
      if (typeof book === 'string' && book.trim().length > 0) {
        await addBookReference(core, runtime, { root: book, ...said, ...(Array.isArray(scope) ? { scope } : {}) })
        return await referenceShelf(core, runtime)
      }
      let manuscript = typeof text === 'string' ? text : ''
      let named = typeof title === 'string' ? title.trim() : ''
      let author: string | undefined
      if (file !== undefined) {
        try {
          const read = readBookFile(requireString(file.name, 'file.name'), Buffer.from(requireString(file.data, 'file.data'), 'base64'))
          manuscript = read.text
          author = read.author
          // A manuscript nobody named is called what its file calls itself.
          if (named.length === 0) named = read.title ?? file.name.replace(/\.[^.]+$/, '')
        } catch (error) {
          throw new ProjectError('novel/invalid', error instanceof Error ? error.message : String(error))
        }
      }
      if (manuscript.trim().length === 0) throw new ProjectError('novel/bad-request', 'name a book of the shelf, or give a manuscript')
      await addTextReference(runtime, { text: manuscript, ...(named.length > 0 ? { title: named } : {}), ...(author !== undefined ? { author } : {}), ...said })
      return await referenceShelf(core, runtime)
    },
    'references.update': async ({ root, id, note, scope, off, title }) => {
      const runtime = await open(root)
      await updateReference(runtime, requireString(id, 'id'), { ...(typeof note === 'string' ? { note } : {}), ...(scope === null || Array.isArray(scope) ? { scope } : {}), ...(typeof off === 'boolean' ? { off } : {}), ...(typeof title === 'string' ? { title } : {}) })
      return await referenceShelf(core, runtime)
    },
    'references.remove': async ({ root, id }) => {
      const runtime = await open(root)
      await removeReference(runtime, requireString(id, 'id'))
      return await referenceShelf(core, runtime)
    },
    'references.settings': async ({ root, beforeWriting, beforeDeriving, beforeReviewing, guide }) => {
      const runtime = await open(root)
      await setReferenceUse(runtime, {
        first: { ...(typeof beforeWriting === 'boolean' ? { write: beforeWriting } : {}), ...(typeof beforeDeriving === 'boolean' ? { derive: beforeDeriving } : {}), ...(typeof beforeReviewing === 'boolean' ? { review: beforeReviewing } : {}) },
        ...(typeof guide === 'string' ? { guide } : {}),
      })
      return await referenceShelf(core, runtime)
    },
    'references.consult': async ({ root, chapter, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'read the references for a chapter', requireString(chapter, 'chapter'), async task => await consultReferences(core, runtime, { chapter: requireString(chapter, 'chapter'), ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction } : {}) }, task))
    },
    'ai.reviseSpan': async ({ root, chapter, start, end, quote, instruction, guides }) => {
      const runtime = await open(root)
      return job(runtime, 'revise', 'revise passage', chapter, async (task) => {
        const { before: _before, ...rest } = await reviseSpan(core, runtime, { chapter, start, end, ...(quote !== undefined ? { quote } : {}), instruction: requireString(instruction, 'instruction'), apply: false, ...(Array.isArray(guides) ? { guides: cleanGuides(guides) } : {}) }, task)
        return rest
      })
    },
    'ai.reviseChapter': async ({ root, chapter, instruction, guides }) => {
      const runtime = await open(root)
      return job(runtime, 'revise', 'revise chapter', chapter, async (task) => {
        const { before: _before, after: _after, ...rest } = await reviseChapter(core, runtime, { chapter, instruction: requireString(instruction, 'instruction'), apply: false, ...(Array.isArray(guides) && guides.length > 0 ? { guides: cleanGuides(guides) } : {}) }, task)
        return rest
      })
    },
    'ai.fixIssue': async ({ root, chapter, issue, note, scope, order }) => {
      const runtime = await open(root)
      const located = await runtime.project.findChapter(requireString(chapter, 'chapter'))
      if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapter}"`)
      const wide = scope === 'book'
      // Named as the kind of revision it is, so that it reads as one wherever jobs are listed.
      return job(runtime, 'revise', wide ? 'revise book' : 'revise passage', wide ? undefined : located.plan.id, async task => await mendInTurn(runtime, order === 'queue' ? 'queue' : 'apart', task, async onto => await fixIssue(core, runtime, {
        chapter: located.plan.id,
        issue: requireString(issue, 'issue'),
        scope: wide ? 'book' : 'passage',
        ...(typeof note === 'string' && note.trim().length > 0 ? { note: note.trim() } : {}),
        ...(onto ? { onto: true } : {}),
      }, task)))
    },
    'ai.fixIssues': async ({ root, issues, atLeast, chapters, note, order }) => {
      const runtime = await open(root)
      const named = Array.isArray(issues) ? issues.filter(item => typeof item?.chapter === 'string' && typeof item?.issue === 'string').map(item => ({ chapter: item.chapter, issue: item.issue, ...(typeof item.note === 'string' && item.note.trim().length > 0 ? { note: item.note.trim() } : {}) })) : []
      if (named.length === 0 && atLeast === undefined) throw new ProjectError('novel/invalid', 'name the issues to mend, or the severity to mend from')
      return job(runtime, 'revise', 'revise book', undefined, async task => await mendInTurn(runtime, order === 'queue' ? 'queue' : 'apart', task, async onto => await fixIssues(core, runtime, {
        ...(onto ? { onto: true } : {}),
        ...(named.length > 0 ? { issues: named } : { atLeast: atLeast === 'low' || atLeast === 'medium' ? atLeast : 'high', ...(Array.isArray(chapters) && chapters.length > 0 ? { chapters: chapters.filter((item): item is string => typeof item === 'string') } : {}) }),
        ...(typeof note === 'string' && note.trim().length > 0 ? { note: note.trim() } : {}),
      }, task)))
    },
    'ai.reviseBook': async ({ root, instruction, chapters, line, order, guides }) => {
      const runtime = await open(root)
      return job(runtime, 'revise', 'revise book', undefined, async task => await mendInTurn(runtime, order === 'queue' ? 'queue' : 'apart', task, async onto => await reviseBook(core, runtime, { instruction: requireString(instruction, 'instruction'), ...(Array.isArray(guides) && guides.length > 0 ? { guides: cleanGuides(guides) } : {}), ...(chapters !== undefined ? { chapters } : {}), ...(line !== undefined ? { line } : {}), ...(onto ? { onto: true } : {}) }, task)))
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
    'ai.deriveChapters': async ({ root, count, direction, volume, apply, line, after, mode, title, choice, guides }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'derive chapters', undefined, async task => await deriveChapters(core, runtime, {
        ...(count !== undefined ? { count } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(volume !== undefined ? { volume } : {}),
        ...(apply !== undefined ? { apply } : {}),
        ...(typeof line === 'string' && line.length > 0 ? { line } : {}),
        ...(typeof after === 'string' && after.length > 0 ? { after } : {}),
        ...(mode === 'append' || mode === 'replace' || mode === 'branch' ? { mode } : {}),
        ...(typeof title === 'string' && title.trim().length > 0 ? { title } : {}),
        ...(typeof choice === 'string' && choice.trim().length > 0 ? { choice } : {}),
        ...(Array.isArray(guides) ? { guides: cleanGuides(guides) } : {}),
      }, task))
    },
    'ai.deriveBeats': async ({ root, chapter, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'derive beats', chapter, async task => await deriveBeats(core, runtime, { chapter, ...(direction !== undefined ? { direction } : {}) }, task))
    },
    'ai.whatIf': async ({ root, question, branches, guides }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'what-if', undefined, async task => await whatIf(core, runtime, { question: requireString(question, 'question'), ...(branches !== undefined ? { branches } : {}), ...(Array.isArray(guides) ? { guides: cleanGuides(guides) } : {}) }, task))
    },
    'ai.analyze': async ({ root, steps }) => {
      const runtime = await open(root)
      const wanted = Array.isArray(steps) ? ANALYZE_STEPS.filter(step => steps.includes(step)) : []
      return job(runtime, 'import', 'analyze', undefined, async task => await analyzeBook(core, runtime, wanted.length > 0 ? { steps: wanted } : {}, task))
    },
    'ai.artDirection': async ({ root, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'art direction', undefined, async task => await deriveArtDirection(core, runtime, typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}, task))
    },
    'lines.seen': async ({ root }) => await (await open(root)).project.seenOn(),
    'lines.assign': async ({ root, lines, byText, characters, world }) => await (await open(root)).project.assignLines({ lines: Array.isArray(lines) ? lines.map(String) : [], ...(byText === true ? { byText: true } : {}), ...(Array.isArray(characters) ? { characters: characters.map(String) } : {}), ...(Array.isArray(world) ? { world: world.map(String) } : {}) }),
    'world.presence': async ({ root, line }) => await (await open(root)).project.worldPresence(typeof line === 'string' ? line : undefined),
    'line.import': async ({ root, title, premise, text, file, digest }) => {
      const runtime = await open(root)
      let manuscript = typeof text === 'string' ? text : ''
      let named = typeof title === 'string' ? title.trim() : ''
      if (file !== undefined) {
        try {
          const book = readBookFile(requireString(file.name, 'file.name'), Buffer.from(requireString(file.data, 'file.data'), 'base64'))
          manuscript = book.text
          // A line nobody named is called what its file calls itself.
          if (named.length === 0) named = book.title ?? file.name.replace(/\.[^.]+$/, '')
        } catch (error) {
          throw new ProjectError('novel/invalid', error instanceof Error ? error.message : String(error))
        }
      }
      if (manuscript.trim().length === 0) throw new ProjectError('novel/bad-request', 'there is no text to import')
      if (named.length === 0) throw new ProjectError('novel/bad-request', 'the line needs a name')
      return job(runtime, 'import', 'import line', undefined, async task => await importLine(core, runtime, { text: manuscript, title: named, ...(typeof premise === 'string' && premise.trim().length > 0 ? { premise } : {}), ...(digest === false ? { digest: false } : {}) }, task))
    },
    'ai.import': async ({ root, text, file, analyze, translate }) => {
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
      const into = translate !== undefined && typeof translate.to === 'string' && translate.to.trim().length > 0
        ? { to: translate.to.trim(), ...(typeof translate.from === 'string' && translate.from.trim().length > 0 ? { from: translate.from.trim() } : {}), ...(typeof translate.direction === 'string' && translate.direction.trim().length > 0 ? { direction: translate.direction.trim() } : {}) }
        : undefined
      return job(runtime, 'import', 'import', undefined, async task => await importManuscript(core, runtime, { text: manuscript, ...(analyze !== undefined ? { analyze } : {}), ...(into !== undefined ? { translate: into } : {}) }, task))
    },
    'ai.translate': async ({ root, to, chapters, line, from, settle, direction }) => {
      const runtime = await open(root)
      const picked = Array.isArray(chapters) ? chapters.filter((item): item is string => typeof item === 'string' && item.length > 0) : undefined
      return job(runtime, 'write', 'translate', picked?.length === 1 ? picked[0] : undefined, async task => await translateChapters(core, runtime, {
        to: requireString(to, 'to').trim(),
        ...(picked !== undefined && picked.length > 0 ? { chapters: picked } : {}),
        ...(typeof line === 'string' && line.length > 0 ? { line } : {}),
        ...(typeof from === 'string' && from.trim().length > 0 ? { from: from.trim() } : {}),
        ...(typeof settle === 'boolean' ? { settle } : {}),
        ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}),
      }, task))
    },
    'ai.settleTerms': async ({ root, to, from, scan, direction }) => {
      const runtime = await open(root)
      return job(runtime, 'bible', 'settle terms', undefined, async task => await settleTerms(core, runtime, {
        to: requireString(to, 'to').trim(),
        ...(typeof from === 'string' && from.trim().length > 0 ? { from: from.trim() } : {}),
        ...(scan === true ? { scan: true } : {}),
        ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}),
      }, task))
    },
    'glossary.read': async ({ root }) => {
      const { project } = await open(root)
      return { glossaries: await project.glossaries(), translations: await project.translations() }
    },
    'glossary.save': async ({ root, to, terms }) => {
      const { project } = await open(root)
      const given = (Array.isArray(terms) ? terms : []).filter((term): term is GlossaryTerm => term !== null && typeof term === 'object' && typeof term.source === 'string' && typeof term.target === 'string')
      // What the author changed or added is theirs: marked, so that no later pass over the names writes over it.
      const saved = await project.updateGlossary(requireString(to, 'to').trim(), (current) => {
        const was = new Map(current.map(term => [term.source.trim().toLowerCase(), term]))
        return given.map((term) => {
          const old = was.get(term.source.trim().toLowerCase())
          const kind = GLOSSARY_KINDS.find(item => item === term.kind)
          const note = typeof term.note === 'string' && term.note.trim().length > 0 ? term.note.trim() : undefined
          const same = old !== undefined && old.target === term.target.trim() && (old.note ?? '') === (note ?? '') && old.kind === kind
          return {
            source: term.source, target: term.target,
            ...(kind !== undefined ? { kind } : {}),
            ...(note !== undefined ? { note } : {}),
            ...(old?.of !== undefined ? { of: old.of } : {}),
            ...(same ? (old.by !== undefined ? { by: old.by } : {}) : { by: 'author' as const }),
          }
        })
      })
      return { terms: saved }
    },
    'chapter.untranslate': async ({ root, id }) => {
      await untranslateChapter(await open(root), requireString(id, 'id'))
      return { ok: true }
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
    'review.note': async ({ root, chapter, issue, note }) => ({ ok: (await noteIssue(await open(root), requireString(chapter, 'chapter'), requireString(issue, 'issue'), typeof note === 'string' ? note : '')) !== undefined }),
    'review.list': async ({ root }) => ({ reviews: await listReviews(await open(root)) }),
    'review.recheck': async ({ root, chapters }) => {
      const runtime = await open(root)
      const lang = promptLanguage((await runtime.project.manifest()).language)
      // Every chapter that has something open, unless some are named: read against the text as it stands.
      const named = Array.isArray(chapters) ? chapters.filter((item): item is string => typeof item === 'string') : []
      const due = named.length > 0 ? named : (await listReviews(runtime)).filter(review => review.issues.some(issue => issue.resolved !== true)).map(review => review.chapterId)
      return job(runtime, 'review', 'recheck issues', undefined, async task => await recheckIssues(core, runtime, { chapters: due, changes: L(lang, '（作者让你对照现在的正文重新核对：这些意见提出之后，正文可能已经因为修订改过。）', '(The author asks for these to be read against the text as it stands: it may have been revised since they were raised.)') }, task))
    },
    'review.clear': async ({ root, chapter }) => ({ removed: (await clearReview(await open(root), requireString(chapter, 'chapter'))).removed }),

    // ── batches ──
    'batch.overview': async ({ root, line }) => {
      const runtime = await open(root)
      const session = calling.getStore()?.session
      const [chapters, missing] = await Promise.all([stageOverview(core, runtime, typeof line === 'string' && line.length > 0 ? line : undefined), stageReadiness(core, runtime, await userTask(session, {}))])
      return { chapters, missing }
    },
    'batch.stage': async ({ root, chapters, line, steps, force, density, maxPanels, direction, subtitles, sheetFirst, trials, trialBatch }) => {
      const runtime = await open(root)
      const wanted = Array.isArray(steps) ? steps.filter((step): step is StageStep => STAGE_STEPS.includes(step)) : undefined
      return await batch(runtime, 'stage batch', async task => await stagePlan(core, runtime, {
        ...(Array.isArray(chapters) && chapters.length > 0 ? { chapters } : {}),
        ...(typeof line === 'string' && line.length > 0 ? { line } : {}),
        ...(wanted !== undefined && wanted.length > 0 ? { steps: wanted } : {}),
        ...(force === true ? { force: true } : {}),
        ...(density !== undefined && STORYBOARD_DENSITIES.includes(density) ? { density } : {}),
        ...(typeof maxPanels === 'number' && maxPanels > 0 ? { maxPanels } : {}),
        ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}),
        ...(subtitles === false ? { subtitles: false } : {}),
        ...(sheetFirst === false ? { sheetFirst: false } : {}),
        ...(Array.isArray(trials) && trials.length > 0 ? { trials, ...(typeof trialBatch === 'string' && trialBatch.length > 0 ? { trialBatch } : {}) } : {}),
      }, task))
    },
    'batch.text': async ({ root, chapters, count, line, steps, brief, words, redo, focus, order, rounds, atLeast }) => {
      const runtime = await open(root)
      const wanted = (Array.isArray(steps) ? steps : []).filter((step): step is TextStep => TEXT_STEPS.includes(step))
      return await batch(runtime, 'text batch', async () => await textPlan(core, runtime, {
        steps: wanted,
        ...(order === 'together' ? { order: 'together' as const } : {}),
        ...(order === 'iterate' ? { order: 'iterate' as const, ...(typeof rounds === 'number' && rounds > 0 ? { rounds } : {}), ...(atLeast === 'high' || atLeast === 'medium' || atLeast === 'low' ? { atLeast } : {}) } : {}),
        ...(Array.isArray(chapters) && chapters.length > 0 ? { chapters } : {}),
        ...(typeof count === 'number' && count > 0 ? { count } : {}),
        ...(typeof line === 'string' && line.length > 0 ? { line } : {}),
        ...(typeof brief === 'string' && brief.trim().length > 0 ? { brief: brief.trim() } : {}),
        ...(typeof words === 'number' && words > 0 ? { words } : {}),
        ...(redo === true ? { redo: true } : {}),
        ...(typeof focus === 'string' && focus.trim().length > 0 ? { focus: focus.trim() } : {}),
      }))
    },
    'batch.art': async ({ root, sheets, portraits, voices, places, items, scenes, cover, insert, force, sheetFirst, trials, trialBatch }) => {
      const runtime = await open(root)
      const list = (value: unknown): string[] | undefined => Array.isArray(value) && value.length > 0 ? value.filter((item): item is string => typeof item === 'string') : undefined
      return await batch(runtime, 'art batch', async () => await artPlan(core, runtime, {
        ...(list(sheets) !== undefined ? { sheets: list(sheets)! } : {}),
        ...(list(portraits) !== undefined ? { portraits: list(portraits)! } : {}),
        ...(list(voices) !== undefined ? { voices: list(voices)! } : {}),
        ...(list(places) !== undefined ? { places: list(places)! } : {}),
        ...(list(items) !== undefined ? { items: list(items)! } : {}),
        ...(list(scenes) !== undefined ? { scenes: list(scenes)! } : {}),
        ...(cover === true ? { cover: true } : {}),
        ...(insert === true ? { insert: true } : {}),
        ...(force === true ? { force: true } : {}),
        ...(sheetFirst === false ? { sheetFirst: false } : {}),
        ...(Array.isArray(trials) && trials.length > 0 ? { trials, ...(typeof trialBatch === 'string' && trialBatch.length > 0 ? { trialBatch } : {}) } : {}),
      }))
    },

    // ── jobs ──
    'jobs.list': async ({ root }) => {
      const gates = core.gateStates()
      return { jobs: core.jobs.list(root), ...(Object.keys(gates).length > 0 ? { gates } : {}) }
    },
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
      // A picture of one turn of a place's course says so: the page that asked marks that turn as being drawn.
      return job(runtime, 'illustrate', `illustrate ${params.kind}${params.event !== undefined ? ` at ${params.event}` : ''}`, params.target, async task => await illustrate(core, runtime, params, task))
    },
    'image.import': async ({ root, kind, target, mediaType, data, look, stage, scene, front }) => {
      if (kind !== 'portrait' && kind !== 'sheet') throw new ProjectError('novel/invalid', 'a picture is brought in as a portrait or as a design sheet')
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mediaType))) throw new ProjectError('novel/invalid', 'a picture brought in is a PNG, JPEG or WebP')
      const taken = await importPicture(await open(root), {
        kind,
        target: requireString(target, 'target'),
        data: Buffer.from(requireString(data, 'data'), 'base64'),
        ...(typeof look === 'string' && look.length > 0 ? { look } : {}),
        ...(typeof stage === 'string' && stage.length > 0 ? { stage } : {}),
        ...(typeof scene === 'string' && scene.length > 0 ? { scene } : {}),
        ...(typeof front === 'boolean' ? { front } : {}),
      })
      return { path: taken.info.path, held: taken.held, ...(taken.spare === true ? { spare: true } : {}) }
    },
    'image.whole': async ({ root, picture, fromWords }) => {
      const { held: _held, ...whole } = await pictureWhole(core, await open(root), picture, { fromWords: fromWords === true })
      return whole
    },
    'image.redraw': async ({ root, picture, subject, change, prompt, avoid, references, fromWords, trials }) => {
      const runtime = await open(root)
      const record = (await runtime.project.pictures()).find(item => item.id === picture || item.path === picture)
      // Drawn as it is by several services, to compare them — or drawn anew from words rewritten or one thing changed.
      const tried = Array.isArray(trials) && trials.length > 0 ? trials : undefined
      // Named as the drawing of a picture of its kind is: the page that shows whose it is says that it is being drawn.
      return job(runtime, 'illustrate', `illustrate ${record?.kind ?? 'picture'}`, record?.target, async task => await redrawPicture(core, runtime, { picture, ...(subject !== undefined ? { subject } : {}), ...(change !== undefined ? { change } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(fromWords === true ? { fromWords: true } : {}), ...(Array.isArray(avoid) ? { avoid: avoid.filter((item): item is string => typeof item === 'string') } : {}), ...(Array.isArray(references) ? { references: references.filter(item => item !== null && typeof item === 'object' && typeof item.path === 'string').map(item => ({ path: item.path, ...(typeof item.label === 'string' ? { label: item.label } : {}), ...(typeof item.note === 'string' ? { note: item.note } : {}) })) } : {}), ...(tried !== undefined ? { trials: tried } : {}) }, task))
    },
    // ── the same piece of work by several services or models, to be compared ──
    'trial.setups': async ({ root }) => {
      const runtime = await open(root)
      const settings = await core.settings.get()
      const codex = await service.codex()
      const image = []
      for (const setup of imageSetups(settings, await runtime.project.manifest())) {
        // Whether it can draw right now: its key is at hand (or it needs none).
        const tried = { ...settings, image: { ...setup.image, provider: setup.image.provider ?? 'none' } as NovelSettings['image'] }
        image.push({ ...setup, ready: service.mediaReady(tried, await service.keyStates(tried), codex).image })
      }
      const speech = []
      for (const setup of speechSetups(settings, await runtime.project.manifest())) {
        const tried = { ...settings, tts: { ...setup.tts, provider: setup.tts.provider ?? 'none' } as NovelSettings['tts'] }
        speech.push({ ...setup, ready: service.mediaReady(tried, await service.keyStates(tried), codex).tts })
      }
      return { image, speech }
    },
    'trial.speak': async ({ root, text, character, direction, with: setups }) => {
      const runtime = await open(root)
      return job(runtime, 'audio', 'trial speak', typeof character === 'string' && character.length > 0 ? character : undefined, async task => await trialSpeak(core, runtime, {
        text: requireString(text, 'text'),
        ...(typeof character === 'string' && character.length > 0 ? { character } : {}),
        ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}),
        with: Array.isArray(setups) ? setups : [],
      }, task))
    },
    'trial.takeSpeech': async ({ root, tts, for: scope, character, voice }) => {
      const { project } = await open(root)
      const tried = ttsService((tts ?? {}) as Partial<NovelSettings['tts']>)
      if (tried.provider === undefined || tried.provider === 'none') throw new ProjectError('novel/invalid', 'name the speech setup to speak with')
      // A key never travels with a setup: the one saved for its address is used.
      delete (tried as Record<string, unknown>).apiKey
      const settings = await core.settings.get()
      if (scope === 'studio') {
        // The one left is remembered as it was set up, like any setup the author moves on from.
        const next: Record<string, unknown> = { ...switchTts(settings.tts, tried.provider, tried), ...tried }
        // What the setup left has and this one has not is named as nothing, so that it goes.
        await core.settings.update({ tts: Object.fromEntries([...new Set([...Object.keys(settings.tts), ...Object.keys(next)])].map(key => [key, next[key] ?? null])) } as never)
      } else {
        // The book's own from here on: this service, with the ways of reading that held for the book.
        const held = withBook(settings, await project.manifest()).tts
        await project.updateManifest({ tts: { ...ttsWays(held), ...tried } as NovelSettings['tts'] })
      }
      const named = typeof voice === 'string' ? voice.trim() : ''
      if (named.length > 0 && typeof character === 'string' && character.length > 0) {
        const card = await project.findCharacter(character)
        if (card !== undefined) await project.saveCharacter({ id: card.id, voiceProfile: { ...card.voiceProfile, provider: tried.provider, voice: named } })
      }
      return { ok: true, label: speechSetupName(tried as NovelSettings['tts']) }
    },
    'trial.adopt': async ({ root, path, instead, others }) => {
      const { project } = await open(root)
      const taken = requireString(path, 'path')
      const record = (await project.pictures()).find(item => item.path === taken)
      if (record === undefined) throw new ProjectError('novel/not-found', `no picture on record at "${taken}"`)
      let replaced: string[] = []
      // (One that waits to take a picture's place says so itself — and says whose, as that stands now: another of the
      // same comparison may have been taken since the dialog that asks was opened.)
      if (record.trial?.hang?.as !== 'instead' && typeof instead === 'string' && instead.length > 0 && instead !== taken) {
        // In the place of the picture it was tried against, wherever that one hung; the one replaced stays in the gallery.
        replaced = await project.replacePicture(instead, taken)
      }
      // Drawn anew to be compared, it says itself where it goes: where one drawn the usual way would have been put.
      if (replaced.length === 0 && record.trial?.hang !== undefined) replaced = await hangPicture(await open(root), record)
      else if (replaced.length === 0 && record.kind === 'portrait' && record.target !== undefined) {
        const card = await project.findCharacter(record.target)
        if (card !== undefined) {
          // Of a moment of theirs, it is that moment's picture from here on — the moment its record says it is of,
          // by name before number (a chapter digested again numbers its moments anew).
          const of = sceneOfPicture(scenesOf(card), taken, record)
          const scenes = of !== undefined && of.id !== 'kept' ? scenesOf(card).map(scene => (scene.id === of.id ? { ...scene, portrait: taken } : scene)) : undefined
          await project.saveCharacter({ id: card.id, visual: { portrait: taken, ...(scenes !== undefined ? { scenes } : {}) } })
          replaced = [card.name]
        }
      }
      // Taken, it is a picture like any other: it stands in the text where the others of its kind would.
      await project.tookTrial(taken)
      await project.holdFigure(taken, false)
      let removed = 0
      for (const other of Array.isArray(others) ? others : []) {
        if (typeof other !== 'string' || other === taken) continue
        try {
          await project.removePicture({ path: other })
          removed += 1
        } catch (error) {
          service.log(`could not delete ${other}`, error)
        }
      }
      return { ok: true, replaced, removed }
    },
    'trial.adoptRound': async ({ root, round, label, others }) => {
      const runtime = await open(root)
      const { project } = runtime
      const wanted = requireString(round, 'round')
      const by = requireString(label, 'label')
      // What still waits of the round: taken one by one before, a picture is no longer the round's to give.
      const waiting = (await project.pictures()).filter(item => item.trial?.batch === wanted && item.trial.hang !== undefined)
      let taken = 0
      let removed = 0
      for (const record of waiting.filter(item => item.trial!.label === by)) {
        await hangPicture(runtime, record)
        taken += 1
        if (others !== true) continue
        // What the other services drew of the same thing goes.
        for (const other of waiting.filter(item => item.trial!.id === record.trial!.id && item.path !== record.path)) {
          try {
            await project.removePicture({ path: other.path })
            removed += 1
          } catch (error) {
            service.log(`could not delete ${other.path}`, error)
          }
        }
      }
      return { taken, removed }
    },
    'trial.write': async ({ root, chapter, brief, mode, words, line, guides, with: routes }) => {
      const runtime = await open(root)
      return job(runtime, 'write', 'trial write', chapter, async task => await trialWrite(core, runtime, {
        ...(chapter !== undefined ? { chapter } : {}),
        ...(typeof line === 'string' && line.length > 0 ? { line } : {}),
        ...(brief !== undefined ? { brief } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(words !== undefined ? { words } : {}),
        ...(Array.isArray(guides) ? { guides: cleanGuides(guides) } : {}),
        with: Array.isArray(routes) ? routes : [],
      }, task))
    },
    'trial.draft': async ({ root, chapter, version }) => {
      const text = await (await open(root)).project.versionText(requireString(chapter, 'chapter'), requireString(version, 'version'))
      if (text === undefined) throw new ProjectError('novel/not-found', 'no such draft')
      return { text }
    },
    'trial.derive': async ({ root, count, direction, volume, guides, with: routes }) => {
      const runtime = await open(root)
      return job(runtime, 'derive', 'trial derive', undefined, async task => await trialDerive(core, runtime, {
        ...(count !== undefined ? { count } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(volume !== undefined ? { volume } : {}),
        ...(Array.isArray(guides) ? { guides: cleanGuides(guides) } : {}),
        with: Array.isArray(routes) ? routes : [],
      }, task))
    },
    'image.sheetsFirst': async ({ root, asks }) => await sheetsAhead(core, await open(root), Array.isArray(asks) ? asks : []),
    // Every picture of the book, the newest first: those on record and the panels of its storyboards alike.
    'image.list': async ({ root }) => ({ images: (await (await open(root)).project.pictures()).reverse() }),
    'figures.list': async ({ root, chapter, character }) => {
      const { project } = await open(root)
      const at = typeof chapter === 'string' ? (await project.findChapter(chapter))?.plan.id : undefined
      const whose = typeof character === 'string' ? (await project.findCharacter(character))?.id : undefined
      // Without what the text is searched for: that is the Host's own business.
      return { portraits: (await project.portraitPlaces()).filter(place => (at === undefined || place.chapter === at) && (whose === undefined || place.character === whose)).map(({ told: _told, ...place }) => place) }
    },
    'figures.show': async ({ root, path, show }) => {
      await (await open(root)).project.showFigure(requireString(path, 'path'), show !== false)
      return { ok: true }
    },
    // ── history: how a thing was before it was changed ──
    'history.list': async ({ root, kind, id }) => ({ versions: await (await open(root)).project.history(historyKind(kind), requireString(id, 'id')) }),
    'history.read': async ({ root, kind, id, version }) => {
      const { project } = await open(root)
      const which = historyKind(kind)
      const was = await project.historyOf(which, requireString(id, 'id'), requireString(version, 'version'))
      if (was === undefined) throw new ProjectError('novel/not-found', `no version "${version}" of ${which} "${id}"`)
      const now = await project.current(which, id)
      return { was, ...(now !== undefined ? { now } : {}) }
    },
    'history.restore': async ({ root, kind, id, version, fields }) => {
      const { project } = await open(root)
      await project.restoreHistory(historyKind(kind), requireString(id, 'id'), requireString(version, 'version'), Array.isArray(fields) ? fields.filter((field): field is string => typeof field === 'string' && field.length > 0) : undefined)
      return { ok: true }
    },
    'history.removed': async ({ root }) => ({ removed: await (await open(root)).project.removedCards() }),
    'history.forget': async ({ root, kind, id }) => {
      await (await open(root)).project.forgetRemoved(historyKind(kind), requireString(id, 'id'))
      return { ok: true }
    },
    'image.place': async ({ root, picture, chapter, after, quote, alt }) => {
      const runtime = await open(root)
      const placed = await runtime.project.placePicture(requireString(chapter, 'chapter'), requireString(picture, 'picture'), {
        ...(typeof after === 'number' ? { after } : {}),
        ...(typeof quote === 'string' && quote.trim().length > 0 ? { quote } : {}),
        ...(typeof alt === 'string' ? { alt } : {}),
      })
      return placed
    },
    'image.delete': async ({ root, id, path, paths }) => {
      const { project } = await open(root)
      if (Array.isArray(paths)) {
        // Several at once: one that will not go (not a picture of the book's) does not keep the others.
        const released: string[] = []
        let removed = 0
        for (const each of paths) {
          if (typeof each !== 'string') continue
          try {
            released.push(...await project.removePicture({ path: each }))
            removed += 1
          } catch (error) {
            service.log(`could not delete ${each}`, error)
          }
        }
        return { ok: true, released, removed }
      }
      const released = await project.removePicture({ ...(id !== undefined ? { id } : {}), ...(path !== undefined ? { path } : {}) })
      return { ok: true, released }
    },

    // ── audio drama ──
    'audio.script': async ({ root, chapter }) => {
      const { project } = await open(root)
      const located = await project.findChapter(chapter)
      if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapter}"`)
      const script = await project.audioScript(located.plan.id)
      const stale = script !== undefined && script.textHash !== hashText(proseOnly(await project.chapterText(located.plan.id)))
      const settings = await core.settingsOf(await open(root))
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
    'audio.updateLine': async ({ root, chapter, line, patch }) => playable(await updateAudioLine(await open(root), chapter, line, patch), await ttsOf(root)),
    'audio.removeLine': async ({ root, chapter, line }) => {
      const result = await removeAudioLine(await open(root), requireString(chapter, 'chapter'), requireString(line, 'line'))
      return { script: playable(result.script, await ttsOf(root)), panels: result.panels }
    },
    'audio.clear': async ({ root, chapter }) => ({ removed: (await clearAudioScript(await open(root), requireString(chapter, 'chapter'))).removed }),
    'audio.reshape': async ({ root, chapter }) => {
      const result = await reshapeAudioScript(await open(root), chapter)
      return { ...result, script: playable(result.script, await ttsOf(root)) }
    },
    'audio.sound': async ({ root, chapter, cues, kinds, force }) => {
      const runtime = await open(root)
      return job(runtime, 'audio', 'sound', chapter, async task => await renderSound(core, runtime, { chapter, ...(cues !== undefined ? { cues } : {}), ...(kinds !== undefined ? { kinds } : {}), ...(force !== undefined ? { force } : {}) }, task))
    },
    'audio.updateCue': async ({ root, chapter, cue, patch, remove, dropClip }) => playable(await updateCue(await open(root), { chapter, cue, ...(patch !== undefined ? { patch } : {}), ...(remove !== undefined ? { remove } : {}), ...(dropClip !== undefined ? { dropClip } : {}) }), await ttsOf(root)),
    'audio.addCue': async ({ root, chapter, at, kind, caption, prompt, ambience, intensity }) => playable((await addCue(await open(root), { chapter, at, kind, ...(caption !== undefined ? { caption } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(ambience !== undefined ? { ambience } : {}), ...(intensity !== undefined ? { intensity } : {}) })).script, await ttsOf(root)),
    'audio.export': async ({ root, chapter }) => await exportChapterAudio(await open(root), chapter, await ttsOf(root)),
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
    'comic.render': async ({ root, chapter, panels, force, sheetFirst, things, trials, trialBatch }) => {
      const runtime = await open(root)
      return job(runtime, 'comic', 'draw panels', chapter, async task => await renderPanels(core, runtime, { chapter, ...(panels !== undefined ? { panels } : {}), ...(force !== undefined ? { force } : {}), ...(sheetFirst === false ? { sheetFirst: false } : {}), ...(typeof things === 'boolean' ? { things } : {}), ...(Array.isArray(trials) && trials.length > 0 ? { trials, ...(typeof trialBatch === 'string' && trialBatch.length > 0 ? { trialBatch } : {}) } : {}) }, task))
    },
    'comic.updatePanel': async ({ root, chapter, panel, patch }) => await updateComicPanel(await open(root), chapter, panel, patch),
    'comic.removePanel': async ({ root, chapter, panel }) => await removeComicPanel(await open(root), requireString(chapter, 'chapter'), requireString(panel, 'panel')),
    'comic.clear': async ({ root, chapter }) => ({ removed: (await clearComicBoard(await open(root), requireString(chapter, 'chapter'))).removed }),

    // ── video ──
    'video.status': async ({ root, chapter }) => {
      const runtime = await open(root)
      const located = await runtime.project.findChapter(chapter)
      if (located === undefined) throw new ProjectError('novel/not-found', `no chapter matches "${chapter}"`)
      const session = calling.getStore()?.session
      const agent = session !== undefined ? await service.agentOfSession(session) : undefined
      const route = agent !== undefined ? service.routeOf(agent) : undefined
      const [video, ready] = await Promise.all([chapterVideoWithSubtitles(runtime, located.plan.id), videoReadiness(core, runtime, located.plan.id, route !== undefined ? { agentRoute: route } : {})])
      return { ...(video !== undefined ? { video } : {}), ready }
    },
    'video.remove': async ({ root, chapter }) => ({ removed: (await removeVideo(await open(root), requireString(chapter, 'chapter'))).removed }),
    'video.produce': async ({ root, chapter, direction, subtitles }) => {
      const runtime = await open(root)
      return job(runtime, 'video', 'video', chapter, async task => await produceVideo(core, runtime, { chapter, ...(subtitles === false ? { subtitles: false } : {}), ...(typeof direction === 'string' && direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, task))
    },

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
    'play.novelize': async ({ root, id, title, as, choice }) => {
      const runtime = await open(root)
      return job(runtime, 'play', 'novelize', id, async task => await novelizePlay(core, runtime, { session: id, ...(title !== undefined ? { title } : {}), ...(as === 'line' ? { as: 'line' as const } : {}), ...(typeof choice === 'string' && choice.trim().length > 0 ? { choice } : {}) }, task))
    },

    // ── export ──
    'export.book': async ({ root, format }) => {
      const runtime = await open(root)
      const result = await exportBook(runtime, { format })
      return { path: result.path, chapters: result.chapters, bytes: result.bytes, absolute: join(runtime.project.root, result.path) }
    },

    'site.plan': async ({ root, out }) => {
      const runtime = await open(root)
      const manifest = await runtime.project.manifest()
      const target = siteFolder(runtime.project.root, manifest.title, out)
      const chapters = await listChapters(runtime)
      let previous: SitePlan['previous']
      let occupied = false
      try {
        const record = JSON.parse(await readFile(join(target, 'site.json'), 'utf8')) as { book?: string; publishedAt?: string; files?: Record<string, string> }
        previous = { publishedAt: record.publishedAt ?? '', files: Object.keys(record.files ?? {}).length, sameBook: record.book === manifest.id }
      } catch {
        // Nothing was published there; a folder with other things in it is said, so that nobody publishes into their documents by mistake.
        occupied = (await readdir(target).catch(() => [] as string[])).some(name => !name.startsWith('.'))
      }
      const album = albumCounts(await readAlbum(runtime))
      // What the finished videos weigh is on their records: nothing is opened to say it.
      const films = (await Promise.all(chapters.filter(chapter => chapter.video === true).map(chapter => chapterVideo(runtime, chapter.id)))).filter(video => video !== undefined)
      return {
        out: target,
        ...(films.length > 0 ? { videos: { chapters: films.length, bytes: films.reduce((sum, video) => sum + video.size, 0) } } : {}),
        ...await listLines(runtime, chapters).then(ways => (ways !== undefined ? { lines: { titles: ways.lines.filter(line => line.id !== MAIN_LINE).map(line => line.title), chapters: ways.chapters.length } } : {})),
        sealed: await readStub(runtime.project.root) !== undefined,
        chapters: chapters.length,
        voiced: chapters.filter(chapter => chapter.voiced > 0).length,
        drawn: chapters.filter(chapter => chapter.drawn > 0).length,
        ...(albumEmpty(album) ? {} : { album }),
        ...await listSides(runtime).then(kept => (kept.length > 0 ? { sides: kept.length } : {})),
        ...(previous !== undefined ? { previous } : {}),
        ...(occupied ? { occupied: true } : {}),
        press: await findSoundPress() !== undefined,
        jpeg: await findPicturePress() !== undefined,
      }
    },
    // The author's own viewer: the same album a reader is given, with what the text has not come to yet.
    'reader.position': async ({ root, chapter }) => {
      const runtime = await open(root)
      const position = typeof chapter === 'string' && chapter.length > 0 ? await savePosition(runtime, chapter, 'Studio').catch(() => undefined) : await readPosition(runtime)
      return position !== undefined ? { position } : {}
    },
    'reader.album': async ({ root, line }) => await readAlbum(await open(root), { all: true, ...(line !== undefined ? { line } : {}) }),
    'reader.sides': async ({ root, id }) => {
      const runtime = await open(root)
      const play = typeof id === 'string' && id.length > 0 ? await readSide(runtime, id) : undefined
      return { sides: await listSides(runtime), ...(play !== undefined ? { play } : {}) }
    },
    'site.publish': async ({ root, out, chapters, upto, listen, watch, album, sides, video, lines, defaults, press, jpeg, sealedOk }) => {
      const runtime = await open(root)
      const manifest = await runtime.project.manifest()
      // A sealed book lies on disk as ciphertext and nothing else; a site of it is the book in the open. Only on the author's word.
      if (await readStub(runtime.project.root) !== undefined && sealedOk !== true) throw new ProjectError('novel/invalid', 'this book is sealed: a published site is not. Confirm that it may be written in the open.')
      const reader = await service.share.readerScript()
      if (reader === undefined) throw new ProjectError('novel/unsupported', 'the reader\'s script (lib/reader.js) is missing from this installation')
      const target = siteFolder(runtime.project.root, manifest.title, out)
      // A part at a time: up to one chapter of the main line, or the chapters named.
      const part = typeof upto === 'string' && upto.trim().length > 0 ? await siteChaptersUpTo(runtime, upto) : Array.isArray(chapters) && chapters.length > 0 ? chapters.filter((id): id is string => typeof id === 'string') : undefined
      const opening = siteDefaults(defaults)
      // Sound goes out compressed unless the author keeps it as it is; where no ffmpeg is installed it cannot, and the result says so.
      const soundPress = press === false ? undefined : await findSoundPress()
      // Pictures the same way: as JPEG unless the author keeps them as they are.
      const picturePress = jpeg === false ? undefined : await findPicturePress()
      return job(runtime, 'export', 'publish site', undefined, async task => ({ ...await publishSite(core, runtime, {
        out: target,
        reader,
        ...(soundPress !== undefined ? { press: soundPress } : {}),
        ...(picturePress !== undefined ? { pictures: picturePress } : {}),
        ...(part !== undefined ? { chapters: part } : {}),
        ...(opening !== undefined ? { defaults: opening } : {}),
        ...(listen === false ? { listen: false } : {}),
        ...(watch === false ? { watch: false } : {}),
        ...(album === false ? { album: false } : {}),
        ...(sides === false ? { sides: false } : {}),
        ...(video === false ? { video: false } : {}),
        ...(lines === false ? { lines: false } : {}),
        // The site says what it was made with, in the book's own language.
        credit: { name: manifest.language.toLowerCase().startsWith('zh') ? '小说工坊' : 'Novel Studio', url: PROJECT_HOMEPAGE },
      }, task), ...(press !== false && soundPress === undefined ? { unpressed: true } : {}), ...(jpeg !== false && picturePress === undefined ? { unshrunk: true } : {}) }))
    },

    // ── reading on other devices ──
    'share.status': async () => await service.share.status(),

    // ── the Studio worked from a phone ──
    'remote.status': async () => service.remote.status(loopbackPort(calling.getStore()?.web?.host) !== undefined),
    'remote.open': async () => {
      const web = calling.getStore()?.web
      const port = loopbackPort(web?.host)
      // The desktop app shows its pages without a web server: there is nothing to hand a phone on to.
      if (port === undefined) throw new ProjectError('novel/invalid', 'DSH is not serving a web page here: start it as `dsh web` on this computer, open the Studio in that page, and open the door from there')
      await service.remote.open({ port, cookie: signInOf(web?.cookie) })
      return service.remote.status(true)
    },
    'remote.close': async () => {
      await service.remote.close()
      return service.remote.status(loopbackPort(calling.getStore()?.web?.host) !== undefined)
    },
    'share.update': async ({ enabled, book, port, renew }) => await service.updateShare({
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(book !== undefined && typeof book.root === 'string' ? { book: { root: book.root, shared: book.shared === true, ...(book.mode === 'edit' || book.mode === 'read' ? { mode: book.mode } : {}) } } : {}),
      ...(typeof port === 'number' ? { port } : {}),
      ...(renew === true ? { renew: true } : {}),
    }),

    // ── this Host half ──
    'host.reload': async () => service.reload(),

    // ── outside help: official DSH plugins, installed through DSH's own plugin manager ──
    'help.install': async ({ id }) => {
      // Of no book: the Studio's settings follow it by its id.
      const started = core.jobs.start({ kind: 'install', title: `install ${id}`, project: '', origin: 'user', target: id }, async (context) => {
        const result = await service.installHelp(id, context.signal)
        context.result({ output: result })
        return result
      })
      return { jobId: started.id }
    },
    'help.remove': async ({ id }) => {
      const message = await service.removeHelp(id)
      return { ...await service.helpView(), ...(message !== undefined ? { message } : {}) }
    },

    // ── settings ──
    'settings.get': async ({ root }) => await settingsView(typeof root === 'string' ? root : undefined),
    'settings.update': async ({ patch, keys, root }) => {
      // Keys first: a setting that points at an endpoint should find its key the moment it is saved.
      for (const [url, value] of Object.entries(keys ?? {})) {
        if (typeof value !== 'string') continue
        if (value.trim().length === 0) await service.keys.clear(url)
        else await service.keys.save(url, value)
      }
      await core.settings.update(patch as DeepPartial<NovelSettings>)
      return await settingsView(typeof root === 'string' ? root : undefined)
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
      const wanted = (Array.isArray(parts) ? parts : []).filter((part): part is SetupPart => ['embedding', 'image', 'tts'].includes(part))
      const { check } = await service.applySetup({ service: target, parts: wanted, ...(key !== undefined ? { key } : {}), ...(origin !== undefined ? { origin } : {}) })
      return { view: await settingsView(), check }
    },
    'recommended.settle': async ({ action }) => {
      await settleRecommended(core.settings, action === 'adopt' || action === 'keep' || action === 'revert' ? action : 'dismiss')
      return await settingsView()
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

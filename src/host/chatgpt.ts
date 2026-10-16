// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A ChatGPT subscription in one step, on DSH's own sign-in.
 *
 * DSH's model adapter (`dsh-llm-pi-ai`) can sign in to ChatGPT for its
 * `openai-codex` route: it registers the sign-in as an authorization flow whose
 * grant it keeps in DSH's credential store (`llm-pi-ai/openai-codex`) and
 * refreshes itself. No page of DSH starts that flow. The Studio's guide page
 * does: it runs an attempt through DSH's authorization seam — DSH's flow, DSH's
 * store; the Studio only passes on the page to open and the code to paste —
 * then adds the route to DSH's model settings, where an empty profile is all a
 * signed-in catalog route needs, and hands the roles its models.
 *
 * Codex Connect, where installed, owns the same route with a sign-in of its
 * own: the Studio then uses that and starts nothing. Any other plugin that
 * serves the route is taken as it is.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { ProjectError } from '../core/project'
import type { DeepPartial } from '../core/settings'
import { CREW_ROLES, type ModelRoute, type NovelSettings } from '../shared/types'
import { errorMessage, sleep } from '../core/util/async'
import type { RecommendedModel } from '../shared/recommended'
import type { ChatGPTAttempt, ChatGPTChoice, ChatGPTRoute } from '../shared/rpc'

/** DSH's route for a ChatGPT subscription, as pi-ai and Codex Connect both name it. */
export const CHATGPT_PROVIDER = 'openai-codex'
/** The credential record DSH's own sign-in writes (`<scope>/<id>`). */
export const CHATGPT_RECORD = 'llm-pi-ai/openai-codex'
/** The entry id of DSH's default model in the base bundle. */
const DEFAULT_MODEL_NS = 'agent-default-model'
/** How long a long poll of the sign-in waits for something to change. */
const POLL_MS = 20_000

// ── The parts of DSH used here, as far as they are used: each optional, looked up when needed. ──

interface AuthorizationNotice { message: string; url?: string; code?: string }
type AuthorizationPrompt = { signal?: AbortSignal } & (
  | { kind: 'text' | 'secret'; message: string; placeholder?: string }
  | { kind: 'select'; message: string; options: readonly { id: string; label: string }[] })
export interface AuthorizationLike {
  describe(key: string): { inFlight: boolean; methods?: readonly { id: string }[] } | undefined
  begin(request: { key: string; method?: string; interaction: { notify(notice: AuthorizationNotice): void; prompt(prompt: AuthorizationPrompt): Promise<string> }; signal?: AbortSignal }): Promise<{ status: 'authorized' | 'cancelled' }>
  cancel(key: string): void
}
export interface CredentialsLike {
  describeRecord(key: string): Promise<{ configured: boolean }>
  deleteRecord?(key: string): Promise<void>
}
export interface SettingsFormsLike {
  readonly writable: boolean
  describe(): readonly { ns: string; value: unknown; revision: number }[]
  mutate(ns: string, ops: readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[], expectedRevision?: number): Promise<void>
}
export interface LlmLike {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider?: string): Promise<readonly { id: string; name?: string; provider?: string }[]> | readonly { id: string; name?: string; provider?: string }[]
  listConfigurableProviders?(): readonly { provider: string; settingsNs: string; settingsPath: readonly string[] }[]
}

/** What this module reaches of DSH. Tests hand in their own. */
export interface ChatGPTPorts {
  authorization(): AuthorizationLike | undefined
  credentials(): CredentialsLike | undefined
  forms(): SettingsFormsLike | undefined
  llm(): LlmLike | undefined
  /** Codex Connect is installed, and whether its own sign-in is stored. */
  connect(): Promise<{ signedIn: boolean } | undefined>
}

/** Where the route stands and who could sign in to it. */
export interface ChatGPTState {
  route: ChatGPTRoute
  /** DSH's own sign-in can be started for the route as it is. */
  canSignIn: boolean
  signedIn: boolean
  /** The route is not there, and DSH's settings take it from here. */
  canAddRoute: boolean
  models: { id: string; name: string }[]
}

const at = (value: unknown, path: readonly string[]): unknown => {
  let here = value
  for (const key of path) {
    if (typeof here !== 'object' || here === null) return undefined
    here = (here as Record<string, unknown>)[key]
  }
  return here
}

export class ChatGPTSetup {
  constructor(private readonly ports: ChatGPTPorts, private readonly log: (message: string, error?: unknown) => void = () => {}) {}

  /** The configurable-provider entry for the route: which section of DSH's settings holds its profile. */
  private entry(): { settingsNs: string; settingsPath: readonly string[] } | undefined {
    try {
      return this.ports.llm()?.listConfigurableProviders?.().find(entry => entry.provider === CHATGPT_PROVIDER)
    } catch {
      return undefined
    }
  }

  /** Whether DSH's own adapter holds a profile for the route (its settings say so). */
  private ownProfile(): boolean {
    const entry = this.entry()
    const forms = this.ports.forms()
    if (entry === undefined || forms === undefined) return false
    const section = forms.describe().find(item => item.ns === entry.settingsNs)
    return section !== undefined && at(section.value, entry.settingsPath) !== undefined
  }

  async state(): Promise<ChatGPTState> {
    const llm = this.ports.llm()
    const registered = llm?.listProviders().some(provider => provider.id === CHATGPT_PROVIDER) === true
    const connect = await this.ports.connect()
    // Codex Connect registers the route whenever it is installed; a profile of DSH's own then cannot take it.
    const route: ChatGPTRoute = !registered ? 'none' : connect !== undefined ? 'connect' : this.ownProfile() ? 'dsh' : 'other'
    const flow = this.ports.authorization()?.describe(CHATGPT_RECORD)
    const forms = this.ports.forms()
    let signedIn: boolean
    if (route === 'connect') signedIn = connect?.signedIn === true
    // A route some other plugin serves keeps its sign-in to itself: taken as working.
    else if (route === 'other') signedIn = true
    else signedIn = (await this.ports.credentials()?.describeRecord(CHATGPT_RECORD).catch(() => undefined))?.configured === true
    let models: { id: string; name: string }[] = []
    if (registered) {
      try {
        models = (await llm!.listModels(CHATGPT_PROVIDER)).filter(model => model.provider === undefined || model.provider === CHATGPT_PROVIDER).map(model => ({ id: model.id, name: model.name ?? model.id }))
      } catch (error) {
        this.log('could not list the ChatGPT models', error)
      }
    }
    return {
      route,
      canSignIn: flow !== undefined && (route === 'none' || route === 'dsh'),
      signedIn,
      canAddRoute: route === 'none' && this.entry() !== undefined && forms?.writable === true,
      models,
    }
  }

  /**
   * Add the route to DSH's model settings — a profile with nothing but its name ("ChatGPT", what DSH's model pickers
   * then show): the catalog says the rest, the stored sign-in authenticates it — and wait until DSH serves it.
   */
  async addRoute(): Promise<void> {
    const llm = this.ports.llm()
    if (llm?.listProviders().some(provider => provider.id === CHATGPT_PROVIDER) === true) return
    const entry = this.entry()
    const forms = this.ports.forms()
    if (entry === undefined || forms === undefined) throw new ProjectError('novel/unsupported', 'this DSH has no ChatGPT route to add (its model adapter does not offer openai-codex)')
    if (!forms.writable) throw new ProjectError('novel/unsupported', 'DSH\'s settings cannot be written here')
    const section = forms.describe().find(item => item.ns === entry.settingsNs)
    await forms.mutate(entry.settingsNs, [{ op: 'set', path: [...entry.settingsPath], value: { displayName: 'ChatGPT' } }], section?.revision)
    for (let waited = 0; waited < 5000; waited += 100) {
      if (llm?.listProviders().some(provider => provider.id === CHATGPT_PROVIDER) === true) return
      await sleep(100)
    }
    throw new ProjectError('novel/unsupported', 'DSH took the ChatGPT route into its settings but does not serve it yet — restart DSH and try again')
  }

  /**
   * Declare models newer than DSH's catalog for the route in the route's profile, where the route is DSH's own and
   * lacks them: DSH's model adapter serves a `models` entry its installed catalog does not describe (the route's
   * protocol and address come from the catalog). A `models` list replaces the catalog, so the models the route has are
   * listed with them, each by its id alone — the catalog still describes those. A catalog that has a model already is
   * left as it is.
   * @returns the ids declared.
   */
  async declareModels(newer: readonly RecommendedModel[]): Promise<string[]> {
    const llm = this.ports.llm()
    const state = await this.state()
    if (state.route !== 'dsh' || llm === undefined) return []
    // A route just added is listed before its models are: a list made then would replace the catalog with the new
    // models alone. Wait for the catalog, and write nothing without it.
    let offered = state.models.map(model => model.id)
    for (let waited = 0; offered.length === 0 && waited < 5000; waited += 100) {
      await sleep(100)
      offered = (await llm.listModels(CHATGPT_PROVIDER)).map(model => model.id)
    }
    if (offered.length === 0) return []
    const missing = newer.filter(model => !offered.includes(model.id))
    if (missing.length === 0) return []
    const entry = this.entry()
    const forms = this.ports.forms()
    if (entry === undefined || forms === undefined || !forms.writable) return []
    const section = forms.describe().find(item => item.ns === entry.settingsNs)
    // DSH's settings read back with their defaults: an empty list is the catalog, as the adapter takes it.
    const listed = at(section?.value, [...entry.settingsPath, 'models'])
    const models = Array.isArray(listed) && listed.length > 0 ? [...listed, ...missing] : [...offered.map(id => ({ id })), ...missing]
    await forms.mutate(entry.settingsNs, [{ op: 'set', path: [...entry.settingsPath, 'models'], value: models }], section?.revision)
    const ids = missing.map(model => model.id)
    for (let waited = 0; waited < 5000; waited += 100) {
      const now = (await llm.listModels(CHATGPT_PROVIDER)).map(model => model.id)
      if (ids.every(id => now.includes(id))) return ids
      await sleep(100)
    }
    throw new ProjectError('novel/unsupported', `DSH took ${ids.join(', ')} into the ChatGPT route's settings but does not list it yet — restart DSH and try again`)
  }

  /**
   * Forget DSH's own ChatGPT sign-in: its record goes from DSH's credential store, as signing out of it would, and
   * nothing else — the route, the roles and the pictures stay as they are, and a request on them asks for a sign-in
   * again. OpenAI is not told (the seam has no revoke); the sign-in can be ended there under the account's devices.
   */
  async signOut(): Promise<void> {
    const state = await this.state()
    if (state.route === 'connect' || state.route === 'other') throw new ProjectError('novel/unsupported', 'this ChatGPT sign-in is not DSH\'s own — sign out where it was made')
    const credentials = this.ports.credentials()
    if (credentials?.deleteRecord === undefined) throw new ProjectError('novel/unsupported', 'this DSH cannot delete a stored credential')
    await credentials.deleteRecord(CHATGPT_RECORD)
  }

  /** Make a model of the route DSH's default for new conversations. */
  async setDefaultModel(model: string): Promise<void> {
    const forms = this.ports.forms()
    if (forms === undefined || !forms.writable) throw new ProjectError('novel/unsupported', 'DSH\'s settings cannot be written here')
    const section = forms.describe().find(item => item.ns === DEFAULT_MODEL_NS)
    if (section === undefined) throw new ProjectError('novel/unsupported', 'this DSH has no default model to set')
    await forms.mutate(DEFAULT_MODEL_NS, [
      { op: 'set', path: ['provider'], value: CHATGPT_PROVIDER },
      { op: 'set', path: ['model'], value: model },
      // An effort of the model before is no word of this one's.
      { op: 'unset', path: ['reasoningEffort'] },
    ], section.revision)
  }
}

/**
 * What the one-click changes in the Studio's settings. A role's route is replaced whole — nothing of the route before
 * stays, no temperature, cap or effort of another model — and the picture service, where it is taken, likewise.
 */
export function chatgptPatch(writer: string, crew: string, images: boolean): DeepPartial<NovelSettings> {
  const route = (model: string): ModelRoute => ({ provider: CHATGPT_PROVIDER, model })
  return {
    models: { writer: route(writer), ...Object.fromEntries(CREW_ROLES.map(role => [role, route(crew)])) },
    ...(images ? { image: { provider: 'codex', size: '1536x1024', baseURL: null, model: null, apiKeyRef: null, bridge: null, quality: null } } : {}),
  } as DeepPartial<NovelSettings>
}

/** One attempt to sign in, as the page sees it, and what it waits on. */
interface Running {
  view: ChatGPTAttempt
  controller: AbortController
  answer?: ((text: string) => void) | undefined
  waiters: Set<() => void>
}

/**
 * The sign-in, one attempt at a time. DSH's flow asks three things of whoever
 * started it: which way to sign in (answered here: in the browser, or with a
 * code on another device), to open a page (passed on), and — while the browser
 * has not come back — to paste the code or the address it landed on (passed on,
 * withdrawn by the flow once the browser comes back).
 */
export class ChatGPTSignIn {
  private running: Running | undefined

  constructor(
    private readonly ports: Pick<ChatGPTPorts, 'authorization'>,
    /** What to do once signed in: the one-click's own setup. Its failure is told, not thrown. */
    private readonly onAuthorized: (choice: ChatGPTChoice) => Promise<ChatGPTAttempt['applied']>,
    private readonly log: (message: string, error?: unknown) => void = () => {},
  ) {}

  current(): ChatGPTAttempt | undefined {
    return this.running?.view
  }

  private update(running: Running, change: Partial<ChatGPTAttempt>): void {
    running.view = { ...running.view, ...change, revision: running.view.revision + 1 }
    for (const wake of [...running.waiters]) wake()
  }

  begin(choice: ChatGPTChoice, device = false): ChatGPTAttempt {
    const authorization = this.ports.authorization()
    const flow = authorization?.describe(CHATGPT_RECORD)
    if (authorization === undefined || flow === undefined) throw new ProjectError('novel/unsupported', 'this DSH cannot sign in to ChatGPT by itself (its model adapter registers no ChatGPT sign-in)')
    if (this.running?.view.state === 'running') return this.running.view
    if (flow.inFlight) throw new ProjectError('novel/busy', 'a ChatGPT sign-in is already under way in DSH — finish or cancel it there first')
    const running: Running = { view: { id: randomUUID(), state: 'running', revision: 1 }, controller: new AbortController(), waiters: new Set() }
    this.running = running
    const way = device ? 'device_code' : 'browser'
    const interaction = {
      notify: (notice: AuthorizationNotice): void => {
        this.update(running, { ...(notice.message.length > 0 ? { message: notice.message } : {}), ...(notice.url !== undefined ? { url: notice.url } : {}), ...(notice.code !== undefined ? { code: notice.code } : {}) })
      },
      prompt: (prompt: AuthorizationPrompt): Promise<string> => {
        // The way to sign in was chosen with the button that started it.
        if (prompt.kind === 'select') return Promise.resolve(prompt.options.find(option => option.id === way)?.id ?? prompt.options[0]?.id ?? '')
        return new Promise<string>((resolveAnswer, rejectAnswer) => {
          // Withdrawn by the flow (the browser came back), or by the attempt being cancelled: a flow that waits on the
          // question after a cancel — pi-ai's does, before it closes its callback server — would otherwise hang there
          // and keep the port, and the next sign-in in the browser could not come back.
          const signals = [prompt.signal, running.controller.signal].filter((signal): signal is AbortSignal => signal !== undefined)
          const cleanup = (): void => {
            for (const signal of signals) signal.removeEventListener('abort', withdraw)
            if (running.answer === done) running.answer = undefined
          }
          const withdraw = (): void => {
            cleanup()
            if (running.view.ask !== undefined) this.update(running, { ask: undefined })
            rejectAnswer(Object.assign(new Error('the question was withdrawn'), { name: 'AbortError' }))
          }
          const done = (text: string): void => {
            cleanup()
            this.update(running, { ask: undefined })
            resolveAnswer(text)
          }
          if (signals.some(signal => signal.aborted)) {
            withdraw()
            return
          }
          for (const signal of signals) signal.addEventListener('abort', withdraw, { once: true })
          running.answer = done
          this.update(running, { ask: { message: prompt.message, ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}) } })
        })
      },
    }
    void authorization.begin({ key: CHATGPT_RECORD, method: 'oauth', interaction, signal: running.controller.signal })
      .then(async (outcome) => {
        if (outcome.status !== 'authorized') {
          this.update(running, { state: 'cancelled', ask: undefined })
          return
        }
        this.update(running, { state: 'authorized', ask: undefined })
        try {
          const applied = await this.onAuthorized(choice)
          if (applied !== undefined) this.update(running, { applied })
        } catch (error) {
          this.log('signed in to ChatGPT, but could not set the Studio up for it', error)
          this.update(running, { applied: { conversation: false, images: false, check: { ok: false, message: errorMessage(error) } } })
        }
      })
      .catch((error: unknown) => {
        this.update(running, running.controller.signal.aborted ? { state: 'cancelled', ask: undefined } : { state: 'failed', ask: undefined, error: errorMessage(error) })
      })
    return running.view
  }

  /**
   * The attempt once it has moved past `since`, or as it is after a while of nothing. An attempt that is over can
   * still move once: what the one-click set comes after the sign-in.
   */
  async wait(id: string, since: number, signal?: AbortSignal): Promise<ChatGPTAttempt | undefined> {
    const running = this.running
    if (running === undefined || running.view.id !== id) return running?.view
    if (running.view.revision > since) return running.view
    await new Promise<void>((resolveWait) => {
      const wake = (): void => {
        clearTimeout(timer)
        running.waiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolveWait()
      }
      const timer = setTimeout(wake, POLL_MS)
      running.waiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
    return running.view
  }

  /** The code, or the address the browser landed on, for a flow that asked for one. */
  answer(id: string, text: string): ChatGPTAttempt {
    const running = this.running
    if (running === undefined || running.view.id !== id || running.view.state !== 'running') throw new ProjectError('novel/invalid', 'that sign-in is over')
    if (running.answer === undefined) throw new ProjectError('novel/invalid', 'the sign-in is not waiting for a code right now')
    if (text.trim().length === 0) throw new ProjectError('novel/invalid', 'paste the code, or the whole address the browser landed on')
    running.answer(text.trim())
    return running.view
  }

  cancel(id: string): ChatGPTAttempt | undefined {
    const running = this.running
    if (running === undefined || running.view.id !== id) return running?.view
    if (running.view.state === 'running') {
      running.controller.abort()
      try {
        this.ports.authorization()?.cancel(CHATGPT_RECORD)
      } catch (error) {
        this.log('could not withdraw the ChatGPT sign-in', error)
      }
    }
    return running.view
  }

  dispose(): void {
    if (this.running?.view.state === 'running') this.cancel(this.running.view.id)
  }
}

/** The ports of a live DSH. */
export function chatgptPorts(ctx: Context, connect: () => Promise<{ signedIn: boolean } | undefined>): ChatGPTPorts {
  // Each is optional and owned by DSH: looked up by name when needed, never injected.
  const get = <T>(name: string): T | undefined => {
    try {
      return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined
    } catch {
      return undefined
    }
  }
  return {
    authorization: () => get<AuthorizationLike>('authorization'),
    credentials: () => get<CredentialsLike>('credentials'),
    forms: () => get<SettingsFormsLike>('settings'),
    llm: () => get<LlmLike>('llm'),
    connect,
  }
}

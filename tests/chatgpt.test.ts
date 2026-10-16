// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A ChatGPT subscription in one step, on DSH's own sign-in. DSH is stood in
 * for by fakes of the parts the Studio uses: the authorization seam with the
 * flow `dsh-llm-pi-ai` registers (it asks which way to sign in, says which page
 * to open, and asks for a pasted code while the browser has not come back), the
 * credential store, the settings forms, and the model registry.
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { CHATGPT_RECORD, chatgptPatch, ChatGPTSetup, ChatGPTSignIn, type AuthorizationLike, type ChatGPTPorts, type LlmLike, type SettingsFormsLike } from '../src/host/chatgpt'
import { dshGrant, viaDsh } from '../src/host/codex'
import { codexReady } from '../src/host/service'
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings'
import { textPicks } from '../src/shared/recommended'
import type { ChatGPTAttempt } from '../src/shared/rpc'

const MODELS = [{ id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' }, { id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'gpt-6-sol', name: 'GPT-6 Sol' }]

/** A DSH whose pi-ai adapter can serve `openai-codex` once its settings hold a profile for it. */
function fakeDsh(options: { profile?: boolean; connect?: { signedIn: boolean }; signedIn?: boolean; flow?: boolean; writable?: boolean } = {}) {
  const sections: Record<string, { value: Record<string, unknown>; revision: number }> = {
    'llm-pi-ai': { value: { providers: { bailian: {}, ...(options.profile === true ? { 'openai-codex': {} } : {}) } }, revision: 3 },
    'agent-default-model': { value: { provider: 'bailian', model: 'qwen3.8-flash', reasoningEffort: 'high' }, revision: 7 },
  }
  const mutations: { ns: string; ops: unknown; revision: number | undefined }[] = []
  const forms: SettingsFormsLike = {
    writable: options.writable ?? true,
    describe: () => Object.entries(sections).map(([ns, section]) => ({ ns, value: structuredClone(section.value), revision: section.revision })),
    mutate: async (ns, ops, revision) => {
      mutations.push({ ns, ops: structuredClone(ops), revision })
      const section = sections[ns]!
      for (const op of ops) {
        let here = section.value as Record<string, unknown>
        for (const key of op.path.slice(0, -1)) here = (here[key] ??= {}) as Record<string, unknown>
        const last = op.path[op.path.length - 1]!
        if (op.op === 'set') here[last] = op.value
        else delete here[last]
      }
      section.revision += 1
    },
  }
  const served = (): boolean => options.connect !== undefined || (sections['llm-pi-ai']!.value.providers as Record<string, unknown>)['openai-codex'] !== undefined
  const llm: LlmLike = {
    listProviders: () => [{ id: 'bailian', name: 'Bailian' }, ...(served() ? [{ id: 'openai-codex', name: 'OpenAI Codex' }] : [])],
    listModels: async provider => (provider === 'openai-codex' && served() ? MODELS.map(model => ({ ...model, provider: 'openai-codex' })) : []),
    listConfigurableProviders: () => [{ provider: 'bailian', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bailian'] }, { provider: 'openai-codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'] }],
  }
  let stored = options.signedIn === true
  const authorization = fakeAuthorization(() => { stored = true })
  const ports: ChatGPTPorts = {
    authorization: () => (options.flow === false ? undefined : authorization.service),
    credentials: () => ({ describeRecord: async key => ({ configured: key === CHATGPT_RECORD && stored }), deleteRecord: async (key) => { if (key === CHATGPT_RECORD) stored = false } }),
    forms: () => forms,
    llm: () => llm,
    connect: async () => options.connect,
  }
  return { ports, forms, sections, mutations, authorization }
}

/** The flow `dsh-llm-pi-ai` registers for ChatGPT, as the seam runs it: what it asks and says, in the order it does. */
function fakeAuthorization(commit: () => void) {
  const calls: { method?: string | undefined }[] = []
  let inFlight = false
  let cancelled: (() => void) | undefined
  let answered: string | undefined
  const service: AuthorizationLike = {
    describe: key => (key === CHATGPT_RECORD ? { inFlight } : undefined),
    cancel: () => { cancelled?.() },
    begin: async ({ method, interaction, signal }) => {
      calls.push({ method })
      inFlight = true
      try {
        const way = await interaction.prompt({ kind: 'select', message: 'Select OpenAI Codex login method:', options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'device_code', label: 'Device code login (headless)' }] })
        if (way === 'device_code') interaction.notify({ message: 'Enter this code on the verification page to finish signing in.', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' })
        else interaction.notify({ message: 'A browser window should open. Complete login to finish.', url: 'https://auth.openai.com/oauth/authorize?state=s' })
        const withdraw = new AbortController()
        // The browser coming back withdraws the question; so does the attempt being cancelled.
        const outcome = await new Promise<'authorized' | 'cancelled'>((resolve) => {
          cancelled = () => { withdraw.abort(); resolve('cancelled') }
          signal?.addEventListener('abort', () => { withdraw.abort(); resolve('cancelled') }, { once: true })
          interaction.prompt({ kind: 'text', message: 'Paste the authorization code / redirect URL here:', placeholder: 'http://localhost:1455/auth/callback', signal: withdraw.signal })
            .then((text) => { answered = text; resolve('authorized') }, () => {})
          browser = () => { withdraw.abort(); resolve('authorized') }
        })
        if (outcome === 'authorized') commit()
        return { status: outcome }
      } finally {
        inFlight = false
      }
    },
  }
  let browser: () => void = () => {}
  return {
    service,
    calls,
    answered: () => answered,
    /** The browser came back to the local callback. */
    comeBack: () => { browser() },
  }
}

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('where the ChatGPT route stands', () => {
  it('offers DSH\'s own sign-in, and adding the route, where nothing serves it yet', async () => {
    const dsh = fakeDsh()
    const state = await new ChatGPTSetup(dsh.ports).state()
    expect(state).toMatchObject({ route: 'none', canSignIn: true, signedIn: false, canAddRoute: true, models: [] })
  })

  it('tells a route DSH\'s own adapter serves, and lists its models', async () => {
    const dsh = fakeDsh({ profile: true, signedIn: true })
    const state = await new ChatGPTSetup(dsh.ports).state()
    expect(state).toMatchObject({ route: 'dsh', canSignIn: true, signedIn: true, canAddRoute: false })
    expect(state.models.map(model => model.id)).toEqual(['gpt-5.3-codex-spark', 'gpt-6-luna', 'gpt-6-sol'])
  })

  it('leaves Codex Connect\'s route and sign-in to it', async () => {
    const dsh = fakeDsh({ connect: { signedIn: false }, signedIn: true })
    const state = await new ChatGPTSetup(dsh.ports).state()
    expect(state).toMatchObject({ route: 'connect', canSignIn: false, signedIn: false })
  })

  it('cannot add the route where DSH\'s settings cannot be written', async () => {
    const state = await new ChatGPTSetup(fakeDsh({ writable: false }).ports).state()
    expect(state.canAddRoute).toBe(false)
  })

  it('adds the route, named and nothing else, where DSH\'s settings keep it, and waits until it is served', async () => {
    const dsh = fakeDsh({ signedIn: true })
    await new ChatGPTSetup(dsh.ports).addRoute()
    expect(dsh.mutations).toEqual([{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'openai-codex'], value: { displayName: 'ChatGPT' } }], revision: 3 }])
    expect((dsh.sections['llm-pi-ai']!.value.providers as Record<string, unknown>)['bailian']).toEqual({})
  })

  it('signs DSH out of its own ChatGPT sign-in, and leaves Codex Connect\'s alone', async () => {
    const dsh = fakeDsh({ profile: true, signedIn: true })
    const setup = new ChatGPTSetup(dsh.ports)
    await setup.signOut()
    expect((await setup.state()).signedIn).toBe(false)
    await expect(new ChatGPTSetup(fakeDsh({ connect: { signedIn: true } }).ports).signOut()).rejects.toThrow(/not DSH's own/)
  })

  it('makes a model of the route DSH\'s default, without the effort of the model before', async () => {
    const dsh = fakeDsh({ profile: true, signedIn: true })
    await new ChatGPTSetup(dsh.ports).setDefaultModel('gpt-6-sol')
    expect(dsh.sections['agent-default-model']!.value).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' })
    expect(dsh.mutations[0]!.revision).toBe(7)
  })
})

describe('signing in through DSH', () => {
  const start = (applied = vi.fn(async () => ({ writer: 'gpt-6-sol', crew: 'gpt-6-luna', conversation: true, images: true, check: { ok: true } }))) => {
    const dsh = fakeDsh()
    const signIn = new ChatGPTSignIn(dsh.ports, applied)
    return { dsh, signIn, applied }
  }

  it('signs in in the browser, passes the page on, and sets up once signed in', async () => {
    const { dsh, signIn, applied } = start()
    const first = signIn.begin({ writer: 'gpt-6-sol' })
    expect(first.state).toBe('running')
    await settle()
    const shown = signIn.current()!
    expect(shown.url).toBe('https://auth.openai.com/oauth/authorize?state=s')
    expect(shown.ask?.placeholder).toBe('http://localhost:1455/auth/callback')
    expect(dsh.authorization.calls).toEqual([{ method: 'oauth' }])
    dsh.authorization.comeBack()
    await settle()
    await settle()
    const done = signIn.current()!
    expect(done.state).toBe('authorized')
    // The browser came back: the question for a pasted code is gone.
    expect(done.ask).toBeUndefined()
    expect(applied).toHaveBeenCalledWith({ writer: 'gpt-6-sol' })
    expect(done.applied?.writer).toBe('gpt-6-sol')
  })

  it('takes a pasted address where the browser could not come back', async () => {
    const { dsh, signIn } = start()
    const { id } = signIn.begin({})
    await settle()
    signIn.answer(id, '  http://localhost:1455/auth/callback?code=c&state=s  ')
    await settle()
    expect(dsh.authorization.answered()).toBe('http://localhost:1455/auth/callback?code=c&state=s')
    expect(signIn.current()!.state).toBe('authorized')
  })

  it('signs in with a code on another device when asked', async () => {
    const { signIn } = start()
    signIn.begin({}, true)
    await settle()
    expect(signIn.current()).toMatchObject({ code: 'ABCD-1234', url: 'https://auth.openai.com/codex/device' })
  })

  it('is cancelled from the page', async () => {
    const { signIn, applied } = start()
    const { id } = signIn.begin({})
    await settle()
    signIn.cancel(id)
    await settle()
    expect(signIn.current()!.state).toBe('cancelled')
    expect(applied).not.toHaveBeenCalled()
  })

  it('withdraws the question on cancel, so a flow that waits on it can close its callback server', async () => {
    // pi-ai's browser sign-in, on a cancel, stops waiting for the browser and then waits for the pasted code before it
    // closes the server it listens on: a question nobody withdraws keeps that port for good.
    let closed = false
    const flow: AuthorizationLike = {
      describe: () => ({ inFlight: false }),
      cancel: () => {},
      begin: async ({ interaction, signal }) => {
        try {
          await interaction.prompt({ kind: 'select', message: 'way', options: [{ id: 'browser', label: 'Browser' }] })
          interaction.notify({ message: 'open', url: 'https://auth.openai.com/oauth/authorize' })
          const manual = interaction.prompt({ kind: 'text', message: 'paste', signal: new AbortController().signal }).then(() => undefined, () => undefined)
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => { resolve() }, { once: true }))
          await manual
          return { status: 'cancelled' }
        } finally {
          closed = true
        }
      },
    }
    const signIn = new ChatGPTSignIn({ authorization: () => flow }, async () => undefined)
    const { id } = signIn.begin({})
    await settle()
    expect(signIn.current()!.ask).toBeDefined()
    signIn.cancel(id)
    await settle()
    await settle()
    expect(closed).toBe(true)
    expect(signIn.current()).toMatchObject({ state: 'cancelled' })
    expect(signIn.current()!.ask).toBeUndefined()
  })

  it('says why a sign-in failed', async () => {
    const dsh = fakeDsh()
    const failing: AuthorizationLike = { ...dsh.authorization.service, begin: async () => { throw new Error('OpenAI Codex token exchange failed (400): invalid_grant') } }
    const signIn = new ChatGPTSignIn({ authorization: () => failing }, async () => undefined)
    signIn.begin({})
    await settle()
    expect(signIn.current()).toMatchObject({ state: 'failed', error: 'OpenAI Codex token exchange failed (400): invalid_grant' })
  })

  it('tells when signing in worked but setting up did not', async () => {
    const { dsh, signIn } = start(vi.fn(async () => { throw new Error('DSH took the ChatGPT route into its settings but does not serve it yet') }))
    signIn.begin({})
    await settle()
    dsh.authorization.comeBack()
    await settle()
    await settle()
    expect(signIn.current()).toMatchObject({ state: 'authorized', applied: { check: { ok: false, message: 'DSH took the ChatGPT route into its settings but does not serve it yet' } } })
  })

  it('answers a long poll as soon as the attempt moves, and again for what the one-click set', async () => {
    let finish: (() => void) | undefined
    const { dsh, signIn } = start(vi.fn(() => new Promise<ChatGPTAttempt['applied']>((resolve) => { finish = () => { resolve({ conversation: false, images: false, check: { ok: true } }) } })))
    const { id } = signIn.begin({})
    await settle()
    let seen = signIn.current()!
    const next = signIn.wait(id, seen.revision)
    dsh.authorization.comeBack()
    // The first move is the question for a pasted code being withdrawn; the sign-in being over comes after.
    seen = (await next)!
    expect(seen.revision).toBeGreaterThan(1)
    while (seen.state === 'running') seen = (await signIn.wait(id, seen.revision))!
    expect(seen.state).toBe('authorized')
    const later = signIn.wait(id, signIn.current()!.revision)
    finish!()
    expect((await later)?.applied?.check.ok).toBe(true)
  })

  it('refuses a sign-in where DSH has none to offer', () => {
    const signIn = new ChatGPTSignIn({ authorization: () => undefined }, async () => undefined)
    expect(() => signIn.begin({})).toThrow(/cannot sign in to ChatGPT by itself/)
  })
})

describe('pictures on DSH\'s own sign-in', () => {
  const grant = (expiresIn: number) => ({ kind: 'grant', payload: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: Date.now() + expiresIn, accountId: 'acct-1' } })
  const store = (initial: { kind: string; payload?: unknown } | undefined) => {
    let record = initial
    return {
      record: () => record,
      describeRecord: async () => ({ configured: record !== undefined }),
      readRecord: async () => record,
      modifyRecord: async (_key: string, mutate: (current: typeof record) => Promise<typeof record>) => { record = await mutate(record); return record },
    }
  }

  it('uses a grant that has time left as it is', async () => {
    const fetcher = vi.fn()
    const kept = await dshGrant(store(grant(60 * 60_000)), fetcher as unknown as typeof fetch)
    expect(kept.access).toBe('old-access')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('renews a grant about to end, in the store, keeping its account', async () => {
    const records = store(grant(60_000))
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://auth.openai.com/oauth/token')
      expect(String(init.body)).toContain('grant_type=refresh_token')
      expect(String(init.body)).toContain('refresh_token=old-refresh')
      return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 })
    })
    const renewed = await dshGrant(records, fetcher as unknown as typeof fetch)
    expect(renewed).toMatchObject({ access: 'new-access', refresh: 'new-refresh', accountId: 'acct-1', type: 'oauth' })
    expect(records.record()).toMatchObject({ kind: 'grant', payload: { access: 'new-access', refresh: 'new-refresh', accountId: 'acct-1' } })
  })

  it('says to sign in again when the grant cannot be renewed', async () => {
    const fetcher = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }))
    await expect(dshGrant(store(grant(0)), fetcher as unknown as typeof fetch)).rejects.toThrow(/sign in again/)
  })

  it('says to sign in where nothing is stored', async () => {
    await expect(dshGrant(store(undefined))).rejects.toThrow(/not signed in/)
  })

  const ctxWith = (records: ReturnType<typeof store>): Context => ({ get: (name: string) => (name === 'credentials' ? records : undefined) }) as unknown as Context

  it('asks the image endpoint with the sign-in, and its edits endpoint for a picture with references', async () => {
    const records = store(grant(60 * 60_000))
    const sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const plain = await viaDsh(ctxWith(records), 'a lighthouse', [], undefined, fetcher as unknown as typeof fetch)
    expect(plain.referencesUsed).toBe(0)
    const held = await viaDsh(ctxWith(records), 'the keeper', [{ data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) } as never], undefined, fetcher as unknown as typeof fetch)
    expect(held.referencesUsed).toBe(1)
    expect(sent[0]!.url).toBe('https://chatgpt.com/backend-api/codex/images/generations')
    expect(sent[0]!.body).toEqual({ model: 'gpt-image-2', prompt: 'a lighthouse' })
    expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer old-access', 'chatgpt-account-id': 'acct-1' })
    expect(sent[1]!.url).toBe('https://chatgpt.com/backend-api/codex/images/edits')
    expect((sent[1]!.body.images as { image_url: string }[])[0]!.image_url.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('says to sign in again when ChatGPT refuses the sign-in', async () => {
    const fetcher = vi.fn(async () => new Response('{"detail":"token expired"}', { status: 401 }))
    await expect(viaDsh(ctxWith(store(grant(60 * 60_000))), 'x', [], undefined, fetcher as unknown as typeof fetch)).rejects.toThrow(/token expired — sign in again/)
  })

  it('counts DSH\'s own sign-in as a way to draw', () => {
    const status = { connect: false, connectSignedIn: false, cli: false, cliSignedIn: false, dsh: true, dshSignedIn: true }
    expect(codexReady(status, undefined)).toBe(true)
    expect(codexReady(status, 'dsh')).toBe(true)
    expect(codexReady(status, 'cli')).toBe(false)
  })
})

describe('which models the one-click picks', () => {
  it('takes the first recommended the route offers', () => {
    expect(textPicks('openai-codex', MODELS.map(model => model.id))).toEqual({ writer: 'gpt-6-sol', crew: 'gpt-6-sol' })
  })
  it('falls back down the list', () => {
    expect(textPicks('openai-codex', ['gpt-5.5', 'gpt-5.6-sol'])).toEqual({ writer: 'gpt-5.6-sol', crew: 'gpt-5.6-sol' })
    expect(textPicks('openai-codex', ['gpt-5.5', 'gpt-5.6-luna'])).toEqual({ writer: 'gpt-5.5', crew: 'gpt-5.5' })
  })
  it('names the recommended ones while the route lists nothing yet', () => {
    expect(textPicks('openai-codex', [])).toEqual({ writer: 'gpt-6-sol', crew: 'gpt-6-sol' })
  })
})

describe('what the one-click changes in the Studio', () => {
  it('replaces each role\'s route whole, keeping nothing of the model before', () => {
    const before = mergeSettings(structuredClone(DEFAULT_SETTINGS), {
      models: { writer: { provider: 'bailian', model: 'qwen3.8-max', temperature: 0.9, maxTokens: 8000, reasoningEffort: 'high' }, analyst: { provider: 'custom', model: 'x', baseURL: 'http://127.0.0.1:9/v1' } },
      image: { provider: 'dashscope', model: 'qwen-image-3.0', size: '1280x720', bridge: 'cli' },
    })
    const after = mergeSettings(before, chatgptPatch('gpt-6-sol', 'gpt-6-luna', true))
    expect(after.models.writer).toEqual({ provider: 'openai-codex', model: 'gpt-6-sol' })
    for (const role of ['analyst', 'architect', 'director', 'producer'] as const) expect(after.models[role]).toEqual({ provider: 'openai-codex', model: 'gpt-6-luna' })
    expect(after.image.provider).toBe('codex')
    expect(after.image).not.toHaveProperty('model')
    expect(after.image).not.toHaveProperty('bridge')
    // Nothing is left as null: a null in a route would be read as an address.
    expect(JSON.stringify(after.models)).not.toContain('null')
  })

  it('leaves the pictures where they are not asked for', () => {
    const before = mergeSettings(structuredClone(DEFAULT_SETTINGS), { image: { provider: 'dashscope', model: 'qwen-image-3.0' } })
    expect(mergeSettings(before, chatgptPatch('gpt-6-sol', 'gpt-6-luna', false)).image).toMatchObject({ provider: 'dashscope', model: 'qwen-image-3.0' })
  })
})

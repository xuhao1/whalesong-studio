// SPDX-License-Identifier: LGPL-3.0-or-later
/** Test doubles: a scripted LLM backend and a throwaway project directory. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovelCore, type ProjectRuntime } from '../../src/core/core'
import { DEFAULT_RETRY, type LlmBackend, type LlmRequest, type LlmResponse, type RetryPolicy } from '../../src/core/llm'
import type { RoleOutcome, RoleRunner, RoleTask } from '../../src/core/roles'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/core/settings'
import { UsageStore } from '../../src/core/usage'
import type { NovelSettings } from '../../src/shared/types'
import { namedKeySource } from '../../src/core/media/http'
import type { ImageBridges, ImageReference } from '../../src/core/media/image'

export type Responder = (request: LlmRequest) => string | LlmResponse | Promise<string | LlmResponse>

/** An LLM backend whose replies come from a function; every request is recorded. */
export class FakeLlm implements LlmBackend {
  readonly requests: LlmRequest[] = []
  constructor(public responder: Responder = () => 'ok') {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request)
    const reply = await this.responder(request)
    const response = typeof reply === 'string' ? { text: reply, finish: 'stop' } : reply
    request.onText?.(response.text, response.text)
    return response
  }

  async listModels() {
    return [{ provider: 'fake', providerName: 'Fake', id: 'fake-model', name: 'Fake model' }]
  }

  async contextWindow(): Promise<number | undefined> {
    return 128_000
  }

  defaultRoute() {
    return { provider: 'fake', model: 'fake-model' }
  }

  /** Which models take pictures, by id: `true`, `false`; one not listed says nothing of it. */
  sight: Record<string, boolean> = {}

  async sees(route: { model: string }): Promise<boolean | undefined> {
    return this.sight[route.model]
  }

  /** The default policy, without the waiting. */
  retryPolicy(): RetryPolicy {
    return { ...DEFAULT_RETRY, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }
}

/**
 * A role runner whose agent is a script: it gets the task and a way to call the
 * task's tools, and plays the part of the model. Off by default, the way a
 * Harness without an agent loop is.
 */
export class FakeRoles implements RoleRunner {
  readonly tasks: RoleTask[] = []
  enabled = false
  /** Agents kept after their run (`RoleTask.keep`), by key; and the keys let go since. */
  readonly kept = new Set<string>()
  readonly released: string[] = []
  script: (task: RoleTask, call: (tool: string, args?: Record<string, unknown>) => Promise<string>) => Promise<string | void> = async () => {}

  can(): boolean {
    return this.enabled
  }

  has(key: string): boolean {
    return this.kept.has(key)
  }

  release(key: string): void {
    if (this.kept.delete(key)) this.released.push(key)
  }

  async run(task: RoleTask): Promise<RoleOutcome> {
    this.tasks.push(task)
    // Going on with an agent that was kept: there has to be one.
    if (task.resume !== undefined && !this.kept.delete(task.resume)) throw new Error('KEPT_GONE')
    let steps = 0
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      steps += 1
      const tool = task.tools.find(candidate => candidate.name === name)
      if (tool === undefined) throw new Error(`the task has no tool "${name}"`)
      try {
        const result = await tool.run(args)
        task.onStep?.({ tool: name, args, ok: true, result })
        return result
      } catch (error) {
        // What a model reads when a tool fails.
        const message = error instanceof Error ? error.message : String(error)
        task.onStep?.({ tool: name, args, ok: false, result: message })
        return `ERROR: ${message}`
      }
    }
    const text = await this.script(task, call)
    if (task.keep !== undefined) this.kept.add(task.keep)
    return { text: text ?? '', stop: 'completed', steps, ...(task.resume !== undefined ? { resumed: true as const } : {}) }
  }
}

export interface TestBed {
  dir: string
  llm: FakeLlm
  roles: FakeRoles
  core: NovelCore
  runtime: ProjectRuntime
  cleanup(): Promise<void>
}

export async function createTestBed(options: { settings?: Partial<NovelSettings>; language?: string; title?: string; bridges?: ImageBridges; /** A key every hosted service is given, for tests that stand a server in for one: made up, and sent nowhere but to that server. */ key?: string } = {}): Promise<TestBed> {
  const dir = await mkdtemp(join(tmpdir(), 'novel-test-'))
  const llm = new FakeLlm()
  const roles = new FakeRoles()
  // (Mending by places is tested with the writer rewriting each place unless a test says otherwise; what holds where nothing is set is tested by name.)
  const settings = new SettingsStore({ ...DEFAULT_SETTINGS, autoDigest: false, siftCast: false, settleSuggestions: false, mendBy: 'writer', ...options.settings }, join(dir, 'settings.json'))
  // The ledger of a test goes where the test's book goes, never into the real Harness home.
  const usage = new UsageStore(join(dir, 'usage'))
  // Whatever a test takes off the shelf goes to a trash of its own, never to the real one.
  await mkdir(join(dir, 'trash'))
  const core = new NovelCore({ llm, roles, credentials: namedKeySource(() => options.key), settings, usage, trash: { files: join(dir, 'trash') }, holding: join(dir, 'holding'), ...(options.bridges !== undefined ? { bridges: options.bridges } : {}) })
  await core.ready()
  const runtime = await core.create(join(dir, 'book'), { title: options.title ?? '测试之书', language: options.language ?? 'zh' })
  return {
    dir,
    llm,
    roles,
    core,
    runtime,
    async cleanup() {
      core.dispose()
      // The ledger writes behind the calls it counts; let it finish before its folder goes.
      await usage.settled().catch(() => {})
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

/** A one-pixel PNG: enough of a picture for everything short of looking at it. */
export const PIXEL = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

/** An image model that draws nothing and remembers everything it was asked for. */
export class FakeImages {
  readonly calls: { prompt: string; references: ImageReference[]; change?: boolean }[] = []
  readonly bridges: ImageBridges = {
    codex: async (prompt, options) => {
      this.calls.push({ prompt, references: options.references ?? [], ...(options.change === true ? { change: true } : {}) })
      return { data: PIXEL, mime: 'image/png' }
    },
  }
}

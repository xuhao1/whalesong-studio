// SPDX-License-Identifier: LGPL-3.0-or-later
/** Test doubles: a scripted LLM backend and a throwaway project directory. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovelCore, type ProjectRuntime } from '../../src/core/core'
import { DEFAULT_RETRY, type LlmBackend, type LlmRequest, type LlmResponse, type RetryPolicy } from '../../src/core/llm'
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

  /** The default policy, without the waiting. */
  retryPolicy(): RetryPolicy {
    return { ...DEFAULT_RETRY, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }
}

export interface TestBed {
  dir: string
  llm: FakeLlm
  core: NovelCore
  runtime: ProjectRuntime
  cleanup(): Promise<void>
}

export async function createTestBed(options: { settings?: Partial<NovelSettings>; language?: string; title?: string; bridges?: ImageBridges } = {}): Promise<TestBed> {
  const dir = await mkdtemp(join(tmpdir(), 'novel-test-'))
  const llm = new FakeLlm()
  const settings = new SettingsStore({ ...DEFAULT_SETTINGS, autoDigest: false, ...options.settings }, join(dir, 'settings.json'))
  // The ledger of a test goes where the test's book goes, never into the real Harness home.
  const usage = new UsageStore(join(dir, 'usage'))
  // Whatever a test takes off the shelf goes to a trash of its own, never to the real one.
  await mkdir(join(dir, 'trash'))
  const core = new NovelCore({ llm, credentials: namedKeySource(() => undefined), settings, usage, trash: { files: join(dir, 'trash') }, holding: join(dir, 'holding'), ...(options.bridges !== undefined ? { bridges: options.bridges } : {}) })
  await core.ready()
  const runtime = await core.create(join(dir, 'book'), { title: options.title ?? '测试之书', language: options.language ?? 'zh' })
  return {
    dir,
    llm,
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
  readonly calls: { prompt: string; references: ImageReference[] }[] = []
  readonly bridges: ImageBridges = {
    codex: async (prompt, options) => {
      this.calls.push({ prompt, references: options.references ?? [] })
      return { data: PIXEL, mime: 'image/png' }
    },
  }
}

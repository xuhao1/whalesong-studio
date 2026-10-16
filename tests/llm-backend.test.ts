// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LlmCallError } from '../src/core/llm'
import { createHarnessLlm } from '../src/host/llm-backend'

/** A DSH whose model refuses a temperature the way ChatGPT's GPT-6.1 Sol does, and records what it was sent. */
function refusingDsh(refuses: (options: Record<string, unknown>) => string | undefined): { ctx: Context; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const ctx = {
    llm: {
      async* stream(options: Record<string, unknown>) {
        sent.push(options)
        const refusal = refuses(options)
        if (refusal !== undefined) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: refusal, code: 'PROVIDER' } } }
          return
        }
        yield { type: 'text-delta', text: '好的。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      listProviders: () => [],
    },
    get: () => undefined,
  } as unknown as Context
  return { ctx, sent }
}

const CHATGPT = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
const REFUSAL = '{"detail":"Unsupported parameter: temperature"}\n[Codex diagnostics: {"httpStatus":400}]'

describe('the DSH backend', () => {
  it('asks again without a temperature where the model refuses one, and sends it none after that', async () => {
    const { ctx, sent } = refusingDsh(options => options.temperature !== undefined && options.provider === 'openai-codex' ? REFUSAL : undefined)
    const llm = createHarnessLlm(ctx)
    const first = await llm.complete({ route: CHATGPT, prompt: '收录这一章', temperature: 0.1 })
    expect(first).toMatchObject({ text: '好的。', unsent: ['temperature'] })
    expect(sent.map(options => options.temperature)).toEqual([0.1, undefined])
    // The next call on the route goes without one at once; the record says what went.
    const second = await llm.complete({ route: { ...CHATGPT, temperature: 0.85 }, prompt: '写下一章' })
    expect(second).toMatchObject({ text: '好的。', unsent: ['temperature'] })
    expect(sent.map(options => options.temperature)).toEqual([0.1, undefined, undefined])
    // A call that asks for no temperature has nothing unsent.
    expect((await llm.complete({ route: CHATGPT, prompt: '再看一眼' })).unsent).toBeUndefined()
    // Another model is sent its temperature as before.
    const other = await llm.complete({ route: { provider: 'openrouter', model: 'google/gemini-4-argon' }, prompt: '写', temperature: 0.85 })
    expect(other.unsent).toBeUndefined()
    expect(sent.at(-1)!.temperature).toBe(0.85)
  })

  it('says any other failure as it was, and does not ask twice for it', async () => {
    const { ctx, sent } = refusingDsh(() => 'Rate limit reached')
    const llm = createHarnessLlm(ctx)
    const failure = await llm.complete({ route: CHATGPT, prompt: '收录这一章', temperature: 0.1 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmCallError)
    expect((failure as LlmCallError).message).toBe('openai-codex/gpt-6.1-sol: Rate limit reached')
    expect(sent).toHaveLength(1)
  })
})

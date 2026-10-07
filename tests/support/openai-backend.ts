// SPDX-License-Identifier: LGPL-3.0-or-later
/** A minimal OpenAI-compatible LLM backend for live tests and prompt work outside the Harness. */
import type { LlmBackend, LlmRequest, LlmResponse } from '../../src/core/llm'
import type { ModelRoute } from '../../src/shared/types'

export function createOpenAiBackend(options: { baseURL: string; apiKey: string; model: string; contextWindow?: number }): LlmBackend {
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const temperature = request.temperature ?? request.route.temperature
      const response = await fetch(`${options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: request.route.model,
          stream: true,
          messages: [
            ...(request.system !== undefined ? [{ role: 'system', content: request.system }] : []),
            { role: 'user', content: request.prompt },
          ],
          ...(temperature !== undefined ? { temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        }),
        signal: request.signal ?? null,
      })
      if (!response.ok || response.body === null) throw new Error(`model endpoint answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const decoder = new TextDecoder()
      let buffer = ''
      let text = ''
      let finish = 'stop'
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const event = JSON.parse(data) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[] }
            const choice = event.choices?.[0]
            const delta = choice?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) {
              text += delta
              request.onText?.(delta, text)
            }
            if (choice?.finish_reason === 'length') finish = 'max-tokens'
          } catch {
            // keep-alive or partial frame
          }
        }
      }
      return { text, finish }
    },
    async listModels() {
      return [{ provider: 'live', providerName: 'Live', id: options.model, name: options.model }]
    },
    async contextWindow(_route: ModelRoute) {
      return options.contextWindow ?? 128_000
    },
    defaultRoute() {
      return { provider: 'live', model: options.model }
    },
  }
}

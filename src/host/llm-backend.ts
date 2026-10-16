// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Adapts the Harness LLM seam (`ctx.llm`) to the core's LlmBackend. Every
 * provider route configured in Settings → Models is reachable, credentials and
 * retries included, because calls go through the same runtime the agent uses.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { currentJob } from '../core/jobs'
import { LlmCallError, type LlmBackend, type LlmRequest, type LlmResponse, type ModelDescriptor, type ProviderListing, type RetryPolicy } from '../core/llm'
import { knownMaxOutput } from '../core/media/discovery'
import type { ModelRoute } from '../shared/types'
import { imageBlocks } from './pictures'

/** An endpoint's word that it does not take a temperature: ChatGPT's (`Unsupported parameter: temperature`), and the like. */
const REFUSES_TEMPERATURE = /temperature/i

export function createHarnessLlm(ctx: Context): LlmBackend {
  /** Routes (`provider/model`) that refused a temperature: they are not sent one again. */
  const noTemperature = new Set<string>()
  /**
   * Every provider with an adapter — keys in Settings → Models and sign-in
   * plugins alike — and what each lists. A provider that cannot list right now
   * (signed out, offline) is still a provider the author may pick: it is
   * returned with the reason instead of being left out.
   */
  const catalog = async (): Promise<{ providers: ProviderListing[]; models: ModelDescriptor[] }> => {
    const providers: ProviderListing[] = []
    const models: ModelDescriptor[] = []
    for (const provider of ctx.llm.listProviders()) {
      try {
        const listed = await ctx.llm.listModels(provider.id)
        for (const model of listed) {
          models.push({
            provider: provider.id,
            providerName: provider.name,
            id: model.id,
            name: model.name,
            ...(model.description !== undefined ? { description: model.description } : {}),
            // Said outright either way where the provider says; left out where it does not.
            ...(model.inputModalities !== undefined ? { sees: model.inputModalities.includes('image') } : {}),
          })
        }
        providers.push({ id: provider.id, name: provider.name, models: listed.length })
      } catch (error) {
        providers.push({ id: provider.id, name: provider.name, models: 0, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { providers, models }
  }
  /**
   * One call as it goes to DSH. `undefined`: the model refused the temperature it was sent, before it said anything —
   * the call may go again without one.
   */
  const send = async (request: LlmRequest, pictures: Awaited<ReturnType<typeof imageBlocks>>, temperature: number | undefined): Promise<LlmResponse | undefined> => {
    const { route } = request
    const maxTokens = request.maxTokens ?? route.maxTokens
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      // The part that stays the same from call to call goes ahead as a block of its own: a cache keeps a prefix, and this is where it ends. Pictures come after it, with the words that speak of them.
      messages: [{ role: 'user', content: [...(request.stable !== undefined && request.stable.length > 0 ? [{ type: 'text' as const, text: request.stable }] : []), ...pictures, { type: 'text' as const, text: request.prompt }] as never }],
      ...(request.system !== undefined && request.system.length > 0 ? { system: request.system } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(route.reasoningEffort !== undefined && route.reasoningEffort.length > 0 ? { reasoningEffort: route.reasoningEffort as NonNullable<GenerateOptions['reasoningEffort']> } : {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    }
    let text = ''
    let thought = 0
    let finish = 'stop'
    let usage: LlmResponse['usage']
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        request.onText?.(chunk.text, text)
      } else if (chunk.type === 'reasoning-delta') {
        // Reasoning models can think for a long while before the first word; let whoever watches the job know.
        thought += chunk.text.length
        currentJob()?.think(chunk.text)
      } else if (chunk.type === 'usage') {
        usage = { inputTokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0), outputTokens: chunk.usage.outputTokens, ...(chunk.usage.cacheReadTokens !== undefined && chunk.usage.cacheReadTokens > 0 ? { cachedTokens: chunk.usage.cacheReadTokens } : {}) }
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason.kind === 'aborted') {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
        if (reason.kind === 'error') {
          if (temperature !== undefined && text.length === 0 && thought === 0 && REFUSES_TEMPERATURE.test(reason.failure.message)) return undefined
          throw new LlmCallError(`${route.provider}/${route.model}: ${reason.failure.message}`, reason.failure.code, reason.failure.providerRetryAfterMs !== undefined ? { retryAfterMs: reason.failure.providerRetryAfterMs } : undefined)
        }
        finish = reason.kind
      }
    }
    return { text, finish, ...(usage !== undefined ? { usage } : {}), ...(thought > 0 ? { thought } : {}) }
  }

  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const { route } = request
      const routeKey = `${route.provider}/${route.model}`
      const asked = request.temperature ?? route.temperature
      // Pictures go the way DSH sends them: kept by its attachment service, carried as references.
      const pictures = await imageBlocks(ctx, request.images)
      // A model that refuses a temperature (ChatGPT's GPT-6.1 Sol) gets the call again without one — and is not sent one after that.
      let response = await send(request, pictures, noTemperature.has(routeKey) ? undefined : asked)
      if (response === undefined) {
        noTemperature.add(routeKey)
        response = (await send(request, pictures, undefined))!
      }
      return asked !== undefined && noTemperature.has(routeKey) ? { ...response, unsent: ['temperature'] } : response
    },

    async listModels(): Promise<ModelDescriptor[]> {
      return (await catalog()).models
    },

    catalog,

    async contextWindow(route: ModelRoute): Promise<number | undefined> {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
      return info.context?.contextWindow
    },

    async sees(route: ModelRoute): Promise<boolean | undefined> {
      // What the provider's adapter says the model takes; a model it says nothing of is not known either way.
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
      return info.inputModalities !== undefined ? info.inputModalities.includes('image') : undefined
    },

    async reasoning(route: ModelRoute) {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
      return {
        efforts: (info.reasoning?.efforts ?? []).map(effort => ({ id: String(effort.id), name: effort.name, ...(effort.description !== undefined ? { description: effort.description } : {}) })),
        ...(info.reasoning?.defaultEffort !== undefined ? { defaultEffort: String(info.reasoning.defaultEffort) } : {}),
      }
    },

    async outputCap(route: ModelRoute) {
      if (route.maxTokens !== undefined && route.maxTokens > 0) return { cap: route.maxTokens, source: 'role' as const }
      // What the Harness sends when a request names no limit: the adapter's own figure for the model.
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
      const most = knownMaxOutput(route.model)
      return { ...(info.defaultMaxTokens !== undefined ? { cap: info.defaultMaxTokens } : {}), ...(most !== undefined ? { most } : {}), source: 'model' as const }
    },

    /**
     * The policy the provider was registered with. The Harness runs it for its
     * agent's turns only (`dsh-llm-retry`, on the agent loop); a call made
     * through `ctx.llm.stream` gets no second try unless the caller makes one.
     */
    retryPolicy(route: ModelRoute): RetryPolicy | undefined {
      try {
        // Absent on a Harness older than the policy itself.
        const policy = (ctx.llm as Partial<typeof ctx.llm>).providerRetryPolicy?.(route.provider)
        if (policy === undefined) return undefined
        const backoff = { initialDelayMs: policy.initialDelayMs, maxDelayMs: policy.maxDelayMs, jitterRatio: policy.jitterRatio }
        return policy.mode === 'always'
          ? { maxRetries: Number.POSITIVE_INFINITY, codes: 'all', ...backoff }
          : { maxRetries: policy.maxRetries, codes: policy.retryableCodes, ...backoff }
      } catch {
        return undefined
      }
    },

    defaultRoute(): ModelRoute | undefined {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      if (selection === undefined) return undefined
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    },
  }
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/** Embedding provider for the vector half of retrieval: any OpenAI-compatible `/embeddings` endpoint. */
import type { EmbeddingSettings } from '../../shared/types'
import type { Embedder } from '../retrieval'
import { postJson, ProviderError, requireKey, trimBase, type KeySource } from './http'

interface EmbeddingReply {
  data?: { index?: number; embedding?: number[] }[]
}

/** @returns an embedder for the current settings, or undefined when embeddings are switched off. */
export function createEmbedder(settings: EmbeddingSettings, keys: KeySource): Embedder | undefined {
  if (settings.provider !== 'openai') return undefined
  const base = settings.baseURL?.trim()
  const model = settings.model?.trim()
  if (base === undefined || base.length === 0 || model === undefined || model.length === 0) return undefined
  return {
    space: `${trimBase(base)}|${model}|${settings.dimensions ?? ''}`,
    async embed(texts, signal) {
      const apiKey = await requireKey(keys, { ref: settings.apiKeyRef, endpoint: base }, 'Embeddings')
      const reply = await postJson<EmbeddingReply>(`${trimBase(base)}/embeddings`, {
        model,
        input: texts,
        ...(settings.dimensions !== undefined ? { dimensions: settings.dimensions } : {}),
      }, { apiKey, ...(signal !== undefined ? { signal } : {}), timeoutMs: 60_000 })
      const rows = reply.data ?? []
      if (rows.length !== texts.length) throw new ProviderError(`embedding endpoint returned ${rows.length} vectors for ${texts.length} inputs`)
      const ordered = [...rows].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      return ordered.map((row) => {
        if (!Array.isArray(row.embedding)) throw new ProviderError('embedding endpoint returned a row without a vector')
        return row.embedding
      })
    },
  }
}

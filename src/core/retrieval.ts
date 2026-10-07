// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Retrieval over everything a project knows: manuscript passages, character
 * cards, world entries, chapter memories and the outline.
 *
 * Ranking is hybrid. The lexical half is BM25 over CJK bigrams and Latin
 * words, which needs no model and works offline. When an embedding endpoint is
 * configured, a vector half joins by reciprocal-rank fusion so paraphrases and
 * "the scene where…" questions land too. Embeddings are cached on disk per
 * chunk hash, so only new or changed text is ever embedded.
 */
import type { CharacterCard, SearchHit, SearchSource, WorldEntry } from '../shared/types'
import { hashText, isCjk } from '../shared/text'
import type { Project } from './project'
import { errorMessage } from './util/async'
import { readJson, writeAtomic, writeJson } from './util/fs'

/** Turns text into vectors; absent when no embedding endpoint is configured. */
export interface Embedder {
  /** Identifies the vector space; a change invalidates the cache. */
  readonly space: string
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>
}

interface IndexedDoc {
  key: string
  source: SearchSource
  ref: string
  title: string
  text: string
  offset?: number
  /** 1-based chapter position for chapter-bound docs. */
  chapterIndex?: number
  hash: string
  terms: Map<string, number>
  length: number
}

export interface SearchOptions {
  limit?: number
  sources?: SearchSource[]
  /** Only chapter-bound content from chapters before this 1-based position. */
  beforeChapter?: number
  /** Skip content bound to these chapters. */
  excludeChapters?: string[]
  signal?: AbortSignal
}

const CHUNK_CJK = 520
const CHUNK_LATIN = 1100

/** Tokens for lexical ranking: overlapping CJK bigrams (plus lone characters) and lowercased Latin words. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let latin = ''
  let previousCjk = ''
  const flush = (): void => {
    if (latin.length > 1) tokens.push(latin.toLowerCase())
    latin = ''
  }
  for (const char of text.normalize('NFKC')) {
    if (isCjk(char)) {
      flush()
      if (previousCjk.length > 0) tokens.push(previousCjk + char)
      else tokens.push(char)
      previousCjk = char
    } else if (/[\p{L}\p{N}]/u.test(char)) {
      latin += char
      previousCjk = ''
    } else {
      flush()
      previousCjk = ''
    }
  }
  flush()
  return tokens
}

/** Split prose into overlapping passages on paragraph boundaries. */
export function chunkProse(text: string): { text: string; offset: number }[] {
  const size = /[一-鿿]/.test(text.slice(0, 400)) ? CHUNK_CJK : CHUNK_LATIN
  const chunks: { text: string; offset: number }[] = []
  const parts: { text: string; offset: number }[] = []
  const pattern = /[^\n]+/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const line = match[0]
    if (line.trim().length === 0) continue
    // A paragraph longer than a chunk is cut on sentence ends.
    if (line.length > size * 1.5) {
      let start = 0
      while (start < line.length) {
        let end = Math.min(line.length, start + size)
        if (end < line.length) {
          const window = line.slice(start, end)
          const cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('. '), window.lastIndexOf('”'))
          if (cut > size * 0.5) end = start + cut + 1
        }
        parts.push({ text: line.slice(start, end), offset: match.index + start })
        start = end
      }
    } else {
      parts.push({ text: line, offset: match.index })
    }
  }
  let current: { text: string; offset: number }[] = []
  let length = 0
  for (const part of parts) {
    if (length + part.text.length > size && current.length > 0) {
      chunks.push({ text: current.map(item => item.text).join('\n'), offset: current[0]!.offset })
      // One paragraph of overlap keeps a scene from being cut in half between chunks.
      const overlap = current.at(-1)!
      current = overlap.text.length < size * 0.5 ? [overlap] : []
      length = current.reduce((sum, item) => sum + item.text.length, 0)
    }
    current.push(part)
    length += part.text.length
  }
  if (current.length > 0) chunks.push({ text: current.map(item => item.text).join('\n'), offset: current[0]!.offset })
  return chunks
}

/** Render a character card as searchable text. */
export function characterText(card: CharacterCard): string {
  const persona = card.persona
  return [
    card.name, card.aliases?.join(' '), card.tagline, card.role, card.gender, card.age, card.appearance, card.personality,
    card.background, card.motivation, card.flaw, card.arc, card.voice, card.abilities, card.secrets,
    persona?.traits?.map(trait => trait.name).join(' '), persona?.values?.join(' '), persona?.speech?.join(' '),
    card.relationships?.map(relation => `${relation.kind} ${relation.target} ${relation.note ?? ''}`).join(' '),
    card.notes,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n')
}

export function worldText(entry: WorldEntry): string {
  return [entry.name, entry.aliases?.join(' '), entry.summary, entry.body].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n')
}

function toDoc(key: string, source: SearchSource, ref: string, title: string, text: string, extra: { offset?: number; chapterIndex?: number } = {}): IndexedDoc {
  const terms = new Map<string, number>()
  const tokens = tokenize(`${title}\n${text}`)
  for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1)
  return { key, source, ref, title, text, ...extra, hash: hashText(`${title}\n${text}`), terms, length: tokens.length }
}

interface VectorCache {
  space: string
  dims: number
  keys: string[]
}

export class RetrievalIndex {
  private docs = new Map<string, IndexedDoc>()
  private builtAt = -1
  private building: Promise<void> | undefined
  private vectors = new Map<string, Float32Array>()
  private vectorSpace: string | undefined
  private vectorsLoaded = false
  /** Why the vector half is off right now, shown in the UI. */
  embeddingError: string | undefined

  constructor(private readonly project: Project, private readonly embedder: () => Embedder | undefined) {}

  /** Number of indexed passages (after the last refresh). */
  get size(): number {
    return this.docs.size
  }

  get embedded(): number {
    let count = 0
    for (const doc of this.docs.values()) if (this.vectors.has(doc.hash)) count++
    return count
  }

  /** Bring the lexical index up to date with the project; unchanged passages are reused. */
  async refresh(): Promise<void> {
    if (this.builtAt === this.project.revision) return
    this.building ??= this.build().finally(() => { this.building = undefined })
    await this.building
  }

  private async build(): Promise<void> {
    const revision = this.project.revision
    const next = new Map<string, IndexedDoc>()
    const reuse = (doc: IndexedDoc): void => {
      const previous = this.docs.get(doc.key)
      next.set(doc.key, previous !== undefined && previous.hash === doc.hash ? previous : doc)
    }
    const add = (key: string, source: SearchSource, ref: string, title: string, text: string, extra: { offset?: number; chapterIndex?: number } = {}): void => {
      if (text.trim().length === 0) return
      const previous = this.docs.get(key)
      const hash = hashText(`${title}\n${text}`)
      if (previous !== undefined && previous.hash === hash) {
        next.set(key, { ...previous, ...extra })
        return
      }
      reuse(toDoc(key, source, ref, title, text, extra))
    }

    for (const chapter of await this.project.chapters()) {
      const label = `${chapter.index}. ${chapter.plan.title}`
      const text = await this.project.chapterText(chapter.plan.id)
      for (const chunk of chunkProse(text)) {
        add(`m:${chapter.plan.id}:${chunk.offset}`, 'manuscript', chapter.plan.id, label, chunk.text, { offset: chunk.offset, chapterIndex: chapter.index })
      }
      const plan = chapter.plan
      const outlineText = [plan.synopsis, plan.purpose, plan.beats?.map(beat => beat.summary).join('\n')].filter(Boolean).join('\n')
      add(`o:${plan.id}`, 'outline', plan.id, label, outlineText, { chapterIndex: chapter.index })
      const memory = await this.project.memory(plan.id)
      if (memory !== undefined) {
        const memoryText = [memory.summary, ...memory.facts.map(fact => `${fact.subject}：${fact.statement}`), ...memory.characters.map(moment => `${moment.name}：${[moment.role, moment.stateAfter].filter(Boolean).join('；')}`)].join('\n')
        add(`y:${plan.id}`, 'memory', plan.id, label, memoryText, { chapterIndex: chapter.index })
      }
    }
    for (const card of await this.project.characters()) add(`c:${card.id}`, 'character', card.id, card.name, characterText(card))
    for (const entry of await this.project.world()) {
      const body = worldText(entry)
      if (body.length <= CHUNK_LATIN) add(`w:${entry.id}`, 'world', entry.id, entry.name, body)
      else for (const chunk of chunkProse(body)) add(`w:${entry.id}:${chunk.offset}`, 'world', entry.id, entry.name, chunk.text)
    }
    this.docs = next
    this.builtAt = revision
  }

  // ───────────── vectors ─────────────

  private async loadVectors(space: string): Promise<void> {
    if (this.vectorsLoaded && this.vectorSpace === space) return
    this.vectors = new Map()
    this.vectorSpace = space
    this.vectorsLoaded = true
    try {
      const meta = await this.project.files.readJson<VectorCache>(this.project.statePath('index', 'vectors.json'))
      if (meta === undefined || meta.space !== space || meta.dims <= 0) return
      const buffer = await this.project.files.readBytes(this.project.statePath('index', 'vectors.f32'))
      if (buffer === undefined) return
      // Copied first: bytes that came through a cipher sit wherever they were put, not on a four-byte boundary.
      const aligned = new Uint8Array(buffer)
      const all = new Float32Array(aligned.buffer, 0, Math.floor(aligned.byteLength / 4))
      if (all.length < meta.keys.length * meta.dims) return
      meta.keys.forEach((key, index) => {
        this.vectors.set(key, all.slice(index * meta.dims, (index + 1) * meta.dims))
      })
    } catch {
      // A missing or corrupt cache only costs re-embedding.
      this.vectors = new Map()
    }
  }

  private async saveVectors(space: string): Promise<void> {
    const live = new Set([...this.docs.values()].map(doc => doc.hash))
    const keys = [...this.vectors.keys()].filter(key => live.has(key))
    const dims = keys.length > 0 ? this.vectors.get(keys[0]!)!.length : 0
    const all = new Float32Array(keys.length * dims)
    keys.forEach((key, index) => all.set(this.vectors.get(key)!, index * dims))
    await this.project.files.writeAtomic(this.project.statePath('index', 'vectors.f32'), new Uint8Array(all.buffer))
    await this.project.files.writeJson(this.project.statePath('index', 'vectors.json'), { space, dims, keys } satisfies VectorCache)
  }

  /**
   * Embed every passage that has no vector yet.
   * @returns how many passages were embedded in this call.
   */
  async embedPending(options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; batchSize?: number } = {}): Promise<number> {
    const embedder = this.embedder()
    if (embedder === undefined) return 0
    await this.refresh()
    await this.loadVectors(embedder.space)
    const pending = [...this.docs.values()].filter(doc => !this.vectors.has(doc.hash))
    const batchSize = options.batchSize ?? 10
    let done = 0
    try {
      for (let start = 0; start < pending.length; start += batchSize) {
        options.signal?.throwIfAborted()
        const batch = pending.slice(start, start + batchSize)
        const vectors = await embedder.embed(batch.map(doc => `${doc.title}\n${doc.text}`.slice(0, 6000)), options.signal)
        batch.forEach((doc, index) => {
          const vector = vectors[index]
          if (vector !== undefined) this.vectors.set(doc.hash, normalize(vector))
        })
        done += batch.length
        options.onProgress?.(done, pending.length)
      }
      this.embeddingError = undefined
    } catch (error) {
      this.embeddingError = errorMessage(error)
      throw error
    } finally {
      if (done > 0) await this.saveVectors(embedder.space)
    }
    return done
  }

  // ───────────── search ─────────────

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? 8
    await this.refresh()
    const pool = [...this.docs.values()].filter((doc) => {
      if (options.sources !== undefined && !options.sources.includes(doc.source)) return false
      if (options.beforeChapter !== undefined && doc.chapterIndex !== undefined && doc.chapterIndex >= options.beforeChapter) return false
      if (options.excludeChapters !== undefined && doc.chapterIndex !== undefined && options.excludeChapters.includes(doc.ref)) return false
      return true
    })
    if (pool.length === 0 || query.trim().length === 0) return []

    const lexical = this.rankLexical(query, pool)
    let vector: { doc: IndexedDoc; score: number }[] = []
    const embedder = this.embedder()
    if (embedder !== undefined) {
      try {
        await this.loadVectors(embedder.space)
        if (pool.some(doc => this.vectors.has(doc.hash))) {
          const [queryVector] = await embedder.embed([query.slice(0, 2000)], options.signal)
          if (queryVector !== undefined) vector = this.rankVector(normalize(queryVector), pool)
          this.embeddingError = undefined
        }
      } catch (error) {
        // Lexical results still answer the query when the endpoint is down.
        this.embeddingError = errorMessage(error)
      }
    }

    const fused = new Map<string, { doc: IndexedDoc; score: number }>()
    const fuse = (ranked: { doc: IndexedDoc; score: number }[], weight: number): void => {
      ranked.slice(0, limit * 6).forEach((entry, rank) => {
        const current = fused.get(entry.doc.key) ?? { doc: entry.doc, score: 0 }
        current.score += weight / (60 + rank)
        fused.set(entry.doc.key, current)
      })
    }
    fuse(lexical, 1)
    fuse(vector, 1)
    const top = [...fused.values()].sort((left, right) => right.score - left.score).slice(0, limit)
    const best = top[0]?.score ?? 1
    return top.map(({ doc, score }) => ({
      source: doc.source,
      ref: doc.ref,
      title: doc.title,
      text: doc.text,
      score: Number((score / best).toFixed(3)),
      ...(doc.offset !== undefined ? { offset: doc.offset } : {}),
    }))
  }

  private rankLexical(query: string, pool: IndexedDoc[]): { doc: IndexedDoc; score: number }[] {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return []
    const count = pool.length
    const average = pool.reduce((sum, doc) => sum + doc.length, 0) / count || 1
    const df = new Map<string, number>()
    for (const term of terms) {
      let hits = 0
      for (const doc of pool) if (doc.terms.has(term)) hits++
      df.set(term, hits)
    }
    const phrase = query.trim().normalize('NFKC').toLowerCase()
    const scored: { doc: IndexedDoc; score: number }[] = []
    for (const doc of pool) {
      let score = 0
      for (const term of terms) {
        const tf = doc.terms.get(term)
        if (tf === undefined) continue
        const idf = Math.log(1 + (count - df.get(term)! + 0.5) / (df.get(term)! + 0.5))
        score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / average))
      }
      if (score <= 0) continue
      // An exact phrase (a name, a quoted line) outranks scattered term matches.
      if (phrase.length >= 2 && phrase.length <= 40 && `${doc.title}\n${doc.text}`.normalize('NFKC').toLowerCase().includes(phrase)) score *= 1.6
      scored.push({ doc, score })
    }
    return scored.sort((left, right) => right.score - left.score)
  }

  private rankVector(query: Float32Array, pool: IndexedDoc[]): { doc: IndexedDoc; score: number }[] {
    const scored: { doc: IndexedDoc; score: number }[] = []
    for (const doc of pool) {
      const vector = this.vectors.get(doc.hash)
      if (vector === undefined || vector.length !== query.length) continue
      let dot = 0
      for (let i = 0; i < vector.length; i++) dot += vector[i]! * query[i]!
      scored.push({ doc, score: dot })
    }
    return scored.sort((left, right) => right.score - left.score)
  }
}

function normalize(vector: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(vector)
  let norm = 0
  for (const value of out) norm += value * value
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm
  return out
}

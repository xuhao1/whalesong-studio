// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The usage ledger: one line for every call the Studio makes to a model —
 * tokens of text, pictures drawn, seconds spoken — so what a book costs can be
 * looked at instead of guessed.
 *
 * The ledger counts; it does not know prices. Money appears when the author
 * says what a model costs them (`settings.prices`), and only for the models
 * they priced. Calls of the conversation's own showrunner are not here: the
 * Harness runs that loop and keeps its own count.
 *
 * Kept as JSON lines, one file per month, under the Harness home.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { estimateTokens } from '../shared/text'
import type { PriceEntry, TextRole, UsageAmount, UsageEvent, UsageKind, UsageRow, UsageSummary } from '../shared/types'
import { currentJob } from './jobs'
import type { LlmBackend } from './llm'
import type { ImageProvider } from './media/image'
import type { TtsProvider } from './media/tts'
import { durationOf } from './media/wav'
import type { Embedder } from './retrieval'
import { resolveDshHome } from './settings'
import { hostOf } from '../shared/services'

export class UsageStore {
  private queue: Promise<void> = Promise.resolve()
  private made = false

  constructor(private readonly dir = join(resolveDshHome(), 'novel-writer', 'usage'), private readonly log?: (message: string, error?: unknown) => void) {}

  /**
   * Add a call to the ledger. Never throws and never makes the caller wait:
   * losing a line of bookkeeping must not cost the author a chapter.
   */
  record(event: Omit<UsageEvent, 'at'> & { at?: string }): void {
    const job = currentJob()
    const line: UsageEvent = {
      at: new Date().toISOString(),
      // A call made inside a job is for that job's book, unless it says otherwise.
      ...(job !== undefined ? { task: job.kind, book: job.project, origin: job.origin } : {}),
      ...event,
    }
    this.queue = this.queue.then(async () => {
      if (!this.made) {
        await mkdir(this.dir, { recursive: true })
        this.made = true
      }
      await appendFile(join(this.dir, `${line.at.slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`, 'utf8')
    }).catch((error: unknown) => { this.log?.('could not write the usage ledger', error) })
  }

  /** Everything written so far has reached the disk (tests, and a summary asked for right after a call). */
  async settled(): Promise<void> {
    await this.queue
  }

  /** When the first call on record was made: usage before that was never counted, which is not the same as none. */
  async begun(): Promise<string | undefined> {
    await this.queue
    try {
      const first = (await readdir(this.dir)).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort()[0]
      if (first === undefined) return undefined
      const line = (await readFile(join(this.dir, first), 'utf8')).split('\n').find(text => text.length > 0)
      return line !== undefined ? (JSON.parse(line) as UsageEvent).at : undefined
    } catch {
      return undefined
    }
  }

  /** Calls since a moment (milliseconds), oldest first. */
  async read(since = 0): Promise<UsageEvent[]> {
    await this.queue
    let names: string[]
    try {
      names = (await readdir(this.dir)).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort()
    } catch {
      return []
    }
    const from = since > 0 ? new Date(since).toISOString().slice(0, 7) : ''
    const events: UsageEvent[] = []
    for (const name of names) {
      if (name.slice(0, 7) < from) continue
      let text: string
      try {
        text = await readFile(join(this.dir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        try {
          const event = JSON.parse(line) as UsageEvent
          if (typeof event.at === 'string' && Date.parse(event.at) >= since) events.push(event)
        } catch {
          // A line cut short by a crash is one call uncounted, not a ledger unread.
        }
      }
    }
    return events
  }
}

// ───────────────────────────── counting ─────────────────────────────

/** What one call costs at a price; `undefined` when the price says nothing about what the call used. */
export function costOf(event: UsageEvent, price: PriceEntry | undefined): number | undefined {
  if (price === undefined) return undefined
  let cost = 0
  let priced = false
  const add = (amount: number | undefined, unit: number | undefined): void => {
    if (amount === undefined || amount === 0) return
    if (unit === undefined) return
    priced = true
    cost += amount * unit
  }
  // What the provider had cached is billed at its own, lower price where the author gave one.
  const cached = price.cached !== undefined ? Math.min(event.cached ?? 0, event.input ?? 0) : 0
  add(((event.input ?? 0) - cached) / 1_000_000, price.input)
  add(cached / 1_000_000, price.cached)
  add((event.output ?? 0) / 1_000_000, price.output)
  add(event.images, price.image)
  add((event.seconds ?? 0) / 60, price.minute)
  // A model billed by the character is billed for what was read to it, spoken or embedded.
  add((event.chars ?? 0) / 10_000, price.chars10k)
  return priced ? cost : undefined
}

function emptyRow(key: string, label: string, kind?: UsageKind): UsageRow {
  return { key, label, ...(kind !== undefined ? { kind } : {}), calls: 0, input: 0, output: 0, cached: 0, images: 0, seconds: 0, chars: 0, estimated: false, cost: [], unpriced: false }
}

function addTo(row: UsageRow, event: UsageEvent, cost: number | undefined, currency: string): void {
  row.calls += 1
  row.input += event.input ?? 0
  row.output += event.output ?? 0
  row.cached = (row.cached ?? 0) + (event.cached ?? 0)
  row.images += event.images ?? 0
  row.seconds += event.seconds ?? 0
  row.chars += event.chars ?? 0
  if (event.estimated === true) row.estimated = true
  if (cost === undefined) {
    row.unpriced = true
    return
  }
  const held = row.cost.find(amount => amount.currency === currency)
  if (held !== undefined) held.amount += cost
  else row.cost.push({ currency, amount: cost })
}

const ROLE_ORDER: string[] = ['writer', 'architect', 'analyst', 'director', 'image', 'speech', 'embedding']

/**
 * Add a ledger up: in total, by model, by role, by book and by day.
 * @param prices - what the author pays per model id; models without an entry are counted and reported as unpriced.
 */
export function summarize(events: readonly UsageEvent[], prices: Record<string, PriceEntry> = {}, range: { since?: number; until?: number } = {}): UsageSummary {
  const total = emptyRow('total', 'total')
  const byModel = new Map<string, UsageRow>()
  const byRole = new Map<string, UsageRow>()
  const byBook = new Map<string, UsageRow>()
  const byDay = new Map<string, UsageRow>()
  const unpriced = new Set<string>()
  const row = (map: Map<string, UsageRow>, key: string, label: string, kind?: UsageKind): UsageRow => {
    let held = map.get(key)
    if (held === undefined) {
      held = emptyRow(key, label, kind)
      map.set(key, held)
    }
    return held
  }
  for (const event of events) {
    const price = prices[event.model]
    const cost = costOf(event, price)
    const currency = price?.currency?.trim() || '¥'
    if (cost === undefined) unpriced.add(event.model)
    addTo(total, event, cost, currency)
    addTo(row(byModel, `${event.kind}:${event.model}`, event.model, event.kind), event, cost, currency)
    const role = event.kind === 'text' ? event.role ?? 'other' : event.kind
    addTo(row(byRole, role, role, event.kind), event, cost, currency)
    addTo(row(byBook, event.book ?? '', event.bookTitle ?? event.book ?? ''), event, cost, currency)
    // Days are the author's days, not UTC's.
    const at = new Date(event.at)
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    addTo(row(byDay, day, day), event, cost, currency)
  }
  // A book is known by its latest title.
  for (const event of events) if (event.book !== undefined && event.bookTitle !== undefined) byBook.get(event.book)!.label = event.bookTitle
  const heavy = (left: UsageRow, right: UsageRow): number => (right.input + right.output) - (left.input + left.output) || right.images - left.images || right.seconds - left.seconds || right.calls - left.calls
  const first = events[0]?.at
  return {
    since: new Date(range.since !== undefined && range.since > 0 ? range.since : first !== undefined ? Date.parse(first) : Date.now()).toISOString(),
    until: new Date(range.until ?? Date.now()).toISOString(),
    total,
    byModel: [...byModel.values()].sort(heavy),
    byRole: [...byRole.values()].sort((left, right) => (ROLE_ORDER.indexOf(left.key) + 99) % 99 - (ROLE_ORDER.indexOf(right.key) + 99) % 99),
    byBook: [...byBook.values()].sort(heavy),
    byDay: [...byDay.values()].sort((left, right) => left.key.localeCompare(right.key)),
    unpriced: [...unpriced].sort(),
  }
}

// ───────────────────────────── metering ─────────────────────────────

type Record_ = (event: Omit<UsageEvent, 'at'>) => void

/** Count every text call that goes through a backend. */
export function meterLlm(llm: LlmBackend, record: Record_): LlmBackend {
  return {
    ...llm,
    listModels: llm.listModels.bind(llm),
    contextWindow: llm.contextWindow.bind(llm),
    defaultRoute: llm.defaultRoute.bind(llm),
    ...(llm.reasoning !== undefined ? { reasoning: llm.reasoning.bind(llm) } : {}),
    ...(llm.catalog !== undefined ? { catalog: llm.catalog.bind(llm) } : {}),
    ...(llm.sees !== undefined ? { sees: llm.sees.bind(llm) } : {}),
    async complete(request) {
      const response = await llm.complete(request)
      const { route } = request
      const tag = route.for
      record({
        kind: 'text',
        model: route.model,
        via: route.baseURL !== undefined ? hostOf(route.baseURL) ?? route.baseURL : route.provider,
        ...(tag !== undefined ? { role: tag.role, ...(tag.book !== undefined ? { book: tag.book } : {}), ...(tag.title !== undefined ? { bookTitle: tag.title } : {}) } : {}),
        ...(response.usage !== undefined
          ? { input: response.usage.inputTokens, output: response.usage.outputTokens, ...(response.usage.cachedTokens !== undefined ? { cached: response.usage.cachedTokens } : {}) }
          // An endpoint that does not say what it counted is counted by the length of what was sent and said.
          : { input: estimateTokens(`${request.system ?? ''}${request.stable ?? ''}${request.prompt}`), output: estimateTokens(response.text), estimated: true }),
      })
      return response
    },
  }
}

/** Count every picture an image provider draws. */
export function meterImages(provider: ImageProvider, record: Record_, book?: { root: string; title: string }): ImageProvider {
  return {
    kind: provider.kind,
    model: provider.model,
    async generate(request) {
      const result = await provider.generate(request)
      record({ kind: 'image', model: provider.model, via: provider.kind, images: 1, ...(book !== undefined ? { book: book.root, bookTitle: book.title } : {}) })
      return result
    },
    ...(provider.prompting !== undefined ? { prompting: async signal => await provider.prompting!(signal) } : {}),
  }
}

/** Count every line a speech provider speaks, and the reference clips it makes. */
export function meterSpeech(provider: TtsProvider, model: string, record: Record_, book?: { root: string; title: string }): TtsProvider {
  const tag = book !== undefined ? { book: book.root, bookTitle: book.title } : {}
  const metered: TtsProvider = Object.create(provider) as TtsProvider
  metered.synthesize = async (request) => {
    const audio = await provider.synthesize(request)
    record({ kind: 'speech', model, via: provider.kind, chars: request.text.length, seconds: Number(durationOf(audio).toFixed(2)), ...tag })
    return audio
  }
  if (provider.anchor !== undefined) {
    const anchor = provider.anchor.bind(provider)
    metered.anchor = async (voice, options) => {
      const audio = await anchor(voice, options)
      record({ kind: 'speech', model, via: provider.kind, chars: 0, seconds: Number(durationOf(audio).toFixed(2)), ...tag })
      return audio
    }
  }
  return metered
}

/** Count what is sent to be embedded. */
export function meterEmbedder(embedder: Embedder, model: string, via: string, record: Record_): Embedder {
  return {
    space: embedder.space,
    async embed(texts, signal) {
      const vectors = await embedder.embed(texts, signal)
      const chars = texts.reduce((sum, text) => sum + text.length, 0)
      record({ kind: 'embedding', model, via, input: texts.reduce((sum, text) => sum + estimateTokens(text), 0), output: 0, chars, estimated: true })
      return vectors
    },
  }
}

/** Sum of amounts by currency, as one line of text. */
export function formatCost(cost: readonly UsageAmount[]): string {
  return cost.filter(amount => amount.amount > 0).map(amount => `${amount.currency}${amount.amount < 1 ? amount.amount.toFixed(3) : amount.amount.toFixed(2)}`).join(' + ')
}

export type UsageRange = 'today' | '7d' | '30d' | 'all'

/** The moment a range starts, in milliseconds; 0 for everything. */
export function rangeStart(range: UsageRange, now = Date.now()): number {
  if (range === 'all') return 0
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (range === 'today') return start.getTime()
  return start.getTime() - (range === '7d' ? 6 : 29) * 86_400_000
}

const compact = (value: number): string => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 10_000 ? `${Math.round(value / 1000)}k` : String(Math.round(value))

/** One row of a summary as a line of text. */
export function describeRow(row: UsageRow): string {
  const parts = [
    row.input + row.output > 0 ? `${row.estimated ? '≈' : ''}${compact(row.input)} in / ${compact(row.output)} out tokens` : '',
    row.images > 0 ? `${row.images} pictures` : '',
    row.seconds > 0 ? `${(row.seconds / 60).toFixed(1)} min of speech (${compact(row.chars)} chars)` : '',
  ].filter(part => part.length > 0)
  const cost = formatCost(row.cost)
  return `${row.label}: ${row.calls} calls${parts.length > 0 ? `, ${parts.join(', ')}` : ''}${cost.length > 0 ? ` — ${cost}${row.unpriced ? ' (+ unpriced usage)' : ''}` : row.unpriced ? ' — no price set' : ''}`
}

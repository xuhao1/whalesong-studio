// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A gate for one kind of request — lines spoken, pictures drawn, sounds made,
 * pieces of text work: so many at once, over everything the Studio is doing,
 * whichever job asks.
 *
 * The number is the author's. When the service answers "too fast" the gate
 * slows down by itself — fewer at once, a pause — and the request is made
 * again instead of being lost; as requests go through, it climbs back to the
 * author's number. So a high number is safe to set: the service's own limit
 * is found by running into it, not by guessing.
 */
import type { GateKind, GateState } from '../../shared/types'
import { abortReason, isAbort, sleep } from './async'

export type { GateKind, GateState }

/** What a failed request means for the ones after it. */
export type Verdict =
  /** The service is pushing back: slow down, wait, ask again. */
  | { kind: 'throttle'; retryAfterMs?: number }
  /** Something gave way in passing: ask again, at the same pace. */
  | { kind: 'transient' }
  /** Asking again would not help. */
  | { kind: 'fatal' }

export interface GateOptions {
  signal?: AbortSignal
  /** Queued behind whatever the author is waiting on: the work of a batch. */
  background?: boolean
  /** Called each time the request is let through — the first time and on every attempt after it. */
  onStart?: () => void
  /**
   * `false`: a request the service refused is not made again here — whoever
   * made it has a way of its own to ask again — but the gate still slows down.
   */
  retry?: boolean
}

/** How often a request is made again after the service pushed back, and after something gave way in passing. */
const THROTTLE_RETRIES = 7
const TRANSIENT_RETRIES = 2
const FIRST_PAUSE_MS = 1500
const LONGEST_PAUSE_MS = 30_000

const BILLING = /insufficient|arrear|balance|billing|payment|overdue|free.?tier/i
const THROTTLE_CODE = /thrott|rate.?limit|too.?many|limit_requests|overload|busy|concurren/i
const THROTTLE_TEXT = /rate.?limit|too many requests|thrott|overloaded|限流|请求过于频繁|请求过快|并发数?超|稍后重试/i
const TRANSIENT_TEXT = /fetch failed|econnreset|econnrefused|etimedout|eai_again|epipe|socket hang up|network|timed out|due to timeout|closed before|connection failed|terminated/i

/**
 * Read a failure the way providers report them: an HTTP status, a code of the
 * provider's own, or only words.
 */
export function verdictOf(error: unknown): Verdict {
  if (isAbort(error) || !(error instanceof Error)) return { kind: 'fatal' }
  const status = (error as { status?: unknown }).status
  const code = (error as { code?: unknown }).code
  const after = (error as { retryAfterMs?: unknown }).retryAfterMs
  const text = `${typeof code === 'string' ? code : ''} ${error.message}`
  // An account without credit is refused with the same status as one that asks too fast; waiting does not pay the bill.
  if (BILLING.test(text)) return { kind: 'fatal' }
  const wait = typeof after === 'number' && Number.isFinite(after) && after > 0 ? { retryAfterMs: after } : {}
  if (status === 429 || status === 503 || status === 529) return { kind: 'throttle', ...wait }
  if (typeof code === 'string' && THROTTLE_CODE.test(code)) return { kind: 'throttle', ...wait }
  if (typeof status === 'number') return status === 408 || status === 500 || status === 502 || status === 504 ? { kind: 'transient' } : { kind: 'fatal' }
  if (THROTTLE_TEXT.test(error.message)) return { kind: 'throttle', ...wait }
  return TRANSIENT_TEXT.test(error.message) ? { kind: 'transient' } : { kind: 'fatal' }
}

interface Waiter {
  grant: () => void
  refuse: (error: Error) => void
  signal?: AbortSignal | undefined
  onAbort?: () => void
}

export class Gate {
  private ceilingValue: number
  private limit: number
  private active = 0
  /** Work the author waits on, then the work of batches. */
  private readonly front: Waiter[] = []
  private readonly back: Waiter[] = []
  private pausedUntil = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Pushes back in a row, with no request getting through in between. */
  private strikes = 0
  /** Requests that went through since the limit last moved. */
  private credit = 0
  /** When the limit was last cut: a refusal of a request sent before that is old news. */
  private cutAt = 0
  private throttled = 0
  private readonly listeners = new Set<() => void>()

  private readonly judge: (error: unknown) => Verdict
  private readonly now: () => number
  private readonly pauseFor: (strikes: number, retryAfterMs: number | undefined) => number

  /**
   * @param options.judge - how a failure is read; {@link verdictOf} by default.
   * @param options.pause - how long the gate stays shut after the service pushed back, in milliseconds.
   */
  constructor(readonly name: string, ceiling: number, options: { judge?: (error: unknown) => Verdict; now?: () => number; pause?: (strikes: number, retryAfterMs: number | undefined) => number } = {}) {
    this.ceilingValue = Math.max(1, Math.round(ceiling))
    this.limit = this.ceilingValue
    this.judge = options.judge ?? verdictOf
    this.now = options.now ?? Date.now
    // What the service asked for, when it said; else longer each time it pushes back again, and never quite the same for everybody.
    this.pauseFor = options.pause ?? ((strikes, retryAfterMs) => retryAfterMs !== undefined
      ? Math.min(60_000, Math.max(500, retryAfterMs))
      : Math.min(LONGEST_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(6, strikes - 1)) * (0.85 + Math.random() * 0.3))
  }

  get ceiling(): number {
    return this.ceilingValue
  }

  /** The author changed the number. A gate that is being pushed back keeps its slower pace and climbs from there. */
  setCeiling(ceiling: number): void {
    const next = Math.max(1, Math.round(ceiling))
    if (next === this.ceilingValue) return
    const pushedBack = this.limit < this.ceilingValue
    this.ceilingValue = next
    this.limit = pushedBack ? Math.min(this.limit, next) : next
    this.changed()
    this.pump()
  }

  state(): GateState {
    return {
      ceiling: this.ceilingValue,
      limit: this.limit,
      active: this.active,
      waiting: this.front.length + this.back.length,
      pausedMs: Math.max(0, this.pausedUntil - this.now()),
      throttled: this.throttled,
    }
  }

  /** Be told when the gate changes its pace (not on every request). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // an observer must never stop the gate
      }
    }
  }

  /**
   * Make a request through the gate. It waits its turn, is made again when the
   * service pushes back or something gives way in passing, and fails with the
   * last error when asking again has not helped.
   * @param task - the request; `attempt` counts from 0.
   */
  async run<T>(task: (attempt: number) => Promise<T>, options: GateOptions = {}): Promise<T> {
    let throttles = 0
    let transients = 0
    for (let attempt = 0; ; attempt++) {
      // A request that is being made again has waited already.
      await this.enter(options, attempt > 0)
      const sentAt = this.now()
      let failure: unknown
      let value: T | undefined
      let ok = false
      try {
        options.onStart?.()
        value = await task(attempt)
        ok = true
      } catch (error) {
        failure = error
      }
      this.active -= 1
      if (ok) {
        this.passed()
        this.pump()
        return value as T
      }
      if (options.signal?.aborted === true || isAbort(failure)) {
        this.pump()
        throw failure
      }
      const verdict = this.judge(failure)
      if (verdict.kind === 'throttle') {
        this.pushedBack(sentAt, verdict.retryAfterMs)
        this.pump()
        if (options.retry !== false && throttles < THROTTLE_RETRIES) {
          throttles += 1
          continue
        }
        throw failure
      }
      this.pump()
      if (options.retry !== false && verdict.kind === 'transient' && transients < TRANSIENT_RETRIES) {
        transients += 1
        await sleep(Math.min(400 * 2 ** transients, this.pauseFor(1, undefined)), options.signal)
        continue
      }
      throw failure
    }
  }

  private enter(options: GateOptions, again: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const signal = options.signal
      if (signal?.aborted === true) {
        reject(abortReason(signal))
        return
      }
      const queue = options.background === true ? this.back : this.front
      const waiter: Waiter = {
        grant: () => {
          if (waiter.onAbort !== undefined) signal?.removeEventListener('abort', waiter.onAbort)
          resolve()
        },
        refuse: reject,
        signal,
      }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const at = queue.indexOf(waiter)
          if (at >= 0) queue.splice(at, 1)
          reject(abortReason(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      if (again) queue.unshift(waiter)
      else queue.push(waiter)
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.limit) {
      const wait = this.pausedUntil - this.now()
      if (wait > 0) {
        if (this.timer === undefined && this.front.length + this.back.length > 0) {
          this.timer = setTimeout(() => {
            this.timer = undefined
            this.changed()
            this.pump()
          }, wait + 5)
          // A pause must not keep a process alive that has nothing else to do.
          this.timer.unref?.()
        }
        return
      }
      const next = this.front.shift() ?? this.back.shift()
      if (next === undefined) return
      this.active += 1
      next.grant()
    }
  }

  private passed(): void {
    this.strikes = 0
    if (this.limit >= this.ceilingValue) {
      if (this.throttled !== 0) {
        this.throttled = 0
        this.changed()
      }
      return
    }
    // Back up one step for every round that went through whole.
    this.credit += 1
    if (this.credit < this.limit) return
    this.credit = 0
    this.limit += 1
    if (this.limit >= this.ceilingValue) this.throttled = 0
    this.changed()
  }

  private pushedBack(sentAt: number, retryAfterMs: number | undefined): void {
    this.throttled += 1
    this.credit = 0
    // Requests sent together are refused together: that is one piece of news. The pace is cut once for all of them, and the pause is one pause.
    const news = sentAt >= this.cutAt
    if (news) {
      this.strikes += 1
      this.limit = Math.max(1, Math.ceil(this.limit / 2))
      this.cutAt = this.now()
    }
    if (news || retryAfterMs !== undefined) this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.pauseFor(Math.max(1, this.strikes), retryAfterMs))
    this.changed()
  }
}


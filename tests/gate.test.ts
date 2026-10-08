// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { ProviderError } from '../src/core/media/http'
import { Gate, verdictOf } from '../src/core/util/gate'
import { PARALLEL_DEFAULT, PARALLEL_MAX, parallelOf } from '../src/shared/types'

const tick = (ms = 2): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
/** A gate that pauses for a moment instead of seconds. */
const quick = (ceiling: number): Gate => new Gate('test', ceiling, { pause: () => 4 })

describe('how many at once', () => {
  it('reads a number of parallel requests: eight by default, 256 at most', () => {
    expect(PARALLEL_DEFAULT).toBe(8)
    expect(PARALLEL_MAX).toBe(256)
    expect(parallelOf(undefined)).toBe(8)
    expect(parallelOf(64)).toBe(64)
    expect(parallelOf(1000)).toBe(256)
    expect(parallelOf(0)).toBe(8)
    expect(parallelOf('32')).toBe(32)
  })

  it('never lets more through than its number, whoever asks', async () => {
    const gate = quick(3)
    let inside = 0
    let most = 0
    const work = async (): Promise<void> => {
      inside += 1
      most = Math.max(most, inside)
      await tick(3)
      inside -= 1
    }
    await Promise.all(Array.from({ length: 20 }, () => gate.run(work)))
    expect(most).toBe(3)
    expect(gate.state()).toMatchObject({ active: 0, waiting: 0, limit: 3, ceiling: 3 })
  })

  it('makes a refused request again, slows down, and climbs back by itself', async () => {
    const gate = quick(8)
    let refusals = 2
    let calls = 0
    const changes: number[] = []
    gate.onChange(() => { changes.push(gate.state().limit) })
    const value = await gate.run(async () => {
      calls += 1
      if (refusals-- > 0) throw new ProviderError('dashscope answered 429: Requests rate limit exceeded', 429, 'Throttling.RateQuota')
      return 'spoken'
    })
    // Nothing was lost: the line came through on its third try.
    expect(value).toBe('spoken')
    expect(calls).toBe(3)
    // Twice refused, twice halved.
    expect(gate.state().limit).toBe(2)
    expect(gate.state().throttled).toBe(2)
    // Requests that go through bring the number back up, one step for every round.
    for (let round = 0; round < 60; round++) await gate.run(async () => 'ok')
    expect(gate.state()).toMatchObject({ limit: 8, throttled: 0 })
    expect(changes).toContain(4)
  })

  it('cuts the pace once for requests that were refused together', async () => {
    const gate = quick(8)
    const failed = new Set<number>()
    await Promise.all(Array.from({ length: 8 }, (_unused, index) => gate.run(async () => {
      await tick(2)
      if (!failed.has(index)) {
        failed.add(index)
        throw new ProviderError('too many requests', 429)
      }
    })))
    // Eight refusals of one burst are one piece of news, not eight: 8 → 4, and whatever the retries then ran into.
    expect(gate.state().limit).toBeGreaterThanOrEqual(2)
    expect(failed.size).toBe(8)
  })

  it('gives up on a request the service keeps refusing, and says why', async () => {
    const gate = quick(4)
    let calls = 0
    await expect(gate.run(async () => {
      calls += 1
      throw new ProviderError('answered 429', 429)
    })).rejects.toThrow('429')
    expect(calls).toBe(8)
    expect(gate.state().limit).toBe(1)
  })

  it('does not ask again where whoever asked does so itself, but still slows down', async () => {
    const gate = quick(8)
    let calls = 0
    await expect(gate.run(async () => {
      calls += 1
      throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMIT' })
    }, { retry: false })).rejects.toThrow('rate limited')
    expect(calls).toBe(1)
    expect(gate.state().limit).toBe(4)
  })

  it('asks again when something gave way in passing, and not when asking again cannot help', async () => {
    const gate = quick(4)
    let calls = 0
    expect(await gate.run(async () => {
      if (++calls < 3) throw new ProviderError('request to host failed: fetch failed')
      return calls
    })).toBe(3)
    // The pace is not cut for that.
    expect(gate.state().limit).toBe(4)
    let refused = 0
    await expect(gate.run(async () => {
      refused += 1
      throw new ProviderError('answered 401: invalid api key', 401)
    })).rejects.toThrow('401')
    expect(refused).toBe(1)
  })

  it('lets work the author asked for go before the work of a batch', async () => {
    const gate = quick(1)
    const order: string[] = []
    let release!: () => void
    const held = gate.run(() => new Promise<void>((resolve) => { release = resolve }))
    const batch = [1, 2, 3].map(index => gate.run(async () => { order.push(`batch ${index}`) }, { background: true }))
    const mine = gate.run(async () => { order.push('by hand') })
    await tick()
    expect(gate.state().waiting).toBe(4)
    release()
    await Promise.all([held, mine, ...batch])
    expect(order).toEqual(['by hand', 'batch 1', 'batch 2', 'batch 3'])
  })

  it('lets go of a request that was cancelled while it waited', async () => {
    const gate = quick(1)
    let release!: () => void
    const held = gate.run(() => new Promise<void>((resolve) => { release = resolve }))
    const controller = new AbortController()
    let ran = false
    const waiting = gate.run(async () => { ran = true }, { signal: controller.signal })
    controller.abort(new Error('aborted'))
    await expect(waiting).rejects.toThrow('aborted')
    release()
    await held
    expect(ran).toBe(false)
    expect(gate.state()).toMatchObject({ active: 0, waiting: 0 })
  })

  it('follows the author\'s number when it changes', async () => {
    const gate = quick(2)
    let inside = 0
    let most = 0
    const work = async (): Promise<void> => {
      inside += 1
      most = Math.max(most, inside)
      await tick(4)
      inside -= 1
    }
    const first = Array.from({ length: 4 }, () => gate.run(work))
    gate.setCeiling(64)
    const more = Array.from({ length: 40 }, () => gate.run(work))
    await Promise.all([...first, ...more])
    expect(most).toBeGreaterThan(8)
    expect(gate.state().ceiling).toBe(64)
  })

  it('tells "too fast" from "gave way" from "no use asking again"', () => {
    expect(verdictOf(new ProviderError('answered 429', 429))).toEqual({ kind: 'throttle' })
    expect(verdictOf(new ProviderError('x', undefined, 'Throttling.RateQuota'))).toEqual({ kind: 'throttle' })
    expect(verdictOf(Object.assign(new Error('rate'), { code: 'RATE_LIMIT', retryAfterMs: 3000 }))).toEqual({ kind: 'throttle', retryAfterMs: 3000 })
    expect(verdictOf(new ProviderError('realtime speech failed: Too many requests'))).toEqual({ kind: 'throttle' })
    expect(verdictOf(new ProviderError('服务限流，请稍后重试'))).toEqual({ kind: 'throttle' })
    expect(verdictOf(new ProviderError('answered 503', 503))).toEqual({ kind: 'throttle' })
    // An account without credit is refused with the same status; waiting does not pay the bill.
    expect(verdictOf(new ProviderError('answered 429: You exceeded your current quota', 429, 'insufficient_quota'))).toEqual({ kind: 'fatal' })
    expect(verdictOf(new ProviderError('Arrearage', 400, 'Arrearage'))).toEqual({ kind: 'fatal' })
    expect(verdictOf(new ProviderError('answered 502', 502))).toEqual({ kind: 'transient' })
    expect(verdictOf(new ProviderError('request to host failed: fetch failed'))).toEqual({ kind: 'transient' })
    expect(verdictOf(new ProviderError('the realtime model timed out'))).toEqual({ kind: 'transient' })
    expect(verdictOf(new ProviderError('answered 400: bad voice', 400))).toEqual({ kind: 'fatal' })
    expect(verdictOf(new ProviderError('the sound model answered with silence'))).toEqual({ kind: 'fatal' })
    expect(verdictOf(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toEqual({ kind: 'fatal' })
  })
})

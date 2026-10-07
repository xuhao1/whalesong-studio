// SPDX-License-Identifier: LGPL-3.0-or-later
/** Concurrency primitives used by the store and the pipelines. */

/** Serializes async sections per key, so read-modify-write on one file never interleaves. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    try {
      await previous
      return await task()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

/**
 * Map over items with bounded parallelism, preserving order. Stops scheduling
 * new work once the signal aborts and rejects with the abort reason.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failure: unknown
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed) {
      signal?.throwIfAborted()
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await task(items[index]!, index)
      } catch (error) {
        failed = true
        failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (failed) throw failure
  return results
}

/** Returns a runner that executes async tasks strictly one after another, in call order. */
export function serializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Resolve after `ms`, or reject early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('aborted')
}

export function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.message === 'aborted' || (error as { code?: string }).code === 'ABORT_ERR'
}

/** Combine several optional signals into one; undefined when none is given. */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

/** Human-readable message of any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

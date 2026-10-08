// SPDX-License-Identifier: LGPL-3.0-or-later
/** Typed client for the Studio's RPC contract, carried by the Harness Connection. */
import { MEDIA_PATH, RPC_ENDPOINT, type RpcMethod, type RpcParams, type RpcResult } from '../shared/rpc'

/** The slice of the Harness Connection service this client uses. */
export interface ConnectionLike {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }>
  }
}

export class RpcError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface NovelApi {
  /** @param session - the conversation the calling Studio sits beside: work the call starts belongs to it. */
  call<M extends RpcMethod>(method: M, params: RpcParams<M>, signal?: AbortSignal, session?: string): Promise<RpcResult<M>>
  /** URL of a generated image, audio file or export of a project. */
  media(projectId: string, path: string, options?: { download?: boolean; version?: string | number }): string
}

/** What the Studio is told when its Host turns out to be older than itself. */
export interface ApiOptions {
  /** A call the Studio knows and its Host does not: the Host was loaded from an earlier build. */
  onOlderHost?(method: string): void
  /** The words for it, in the author's language. */
  olderHostMessage?(): string
}

export function createApi(connection: ConnectionLike, options: ApiOptions = {}): NovelApi {
  return {
    async call(method, params, signal, session) {
      let result: Awaited<ReturnType<ConnectionLike['rpc']['call']>>
      try {
        result = await connection.rpc.call('/api', RPC_ENDPOINT, { method, params, ...(session !== undefined ? { session } : {}) }, signal)
      } catch (error) {
        if (signal?.aborted === true) throw new RpcError('novel/cancelled', 'cancelled')
        throw new RpcError('novel/transport', error instanceof Error ? error.message : String(error))
      }
      if (!result.ok) {
        if (result.error.code === 'novel/unknown-method') {
          try {
            options.onOlderHost?.(method)
          } catch {
            // an observer must not change what the caller is told
          }
          throw new RpcError(result.error.code, options.olderHostMessage?.() ?? result.error.message, { ...result.error.details, method })
        }
        throw new RpcError(result.error.code, result.error.message, result.error.details)
      }
      return result.value as RpcResult<typeof method>
    },
    media(projectId, path, options = {}) {
      const query = new URLSearchParams({ project: projectId, path })
      if (options.download === true) query.set('download', '1')
      if (options.version !== undefined) query.set('v', String(options.version))
      return `${MEDIA_PATH}?${query.toString()}`
    },
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof RpcError && error.code === 'novel/cancelled'
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

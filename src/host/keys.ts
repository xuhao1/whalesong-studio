// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Where the Studio keeps API keys: in the Harness credential store, one record
 * per endpoint host under this plugin's scope (`novel-writer/key-<host>`).
 *
 * A key typed into the Studio is stored once and serves every model slot that
 * talks to the same host; it is never written to the settings file, never sent
 * back to the browser, and never used for a host it was not entered for.
 * Power users can instead point a slot at an environment variable by name, and
 * the usual variables (`OPENROUTER_API_KEY`, `DASHSCOPE_API_KEY`, …) are picked
 * up without any configuration.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type { KeySource } from '../core/media/http'
import { ProjectError } from '../core/project'
import type { KeyState } from '../shared/rpc'
import { conventionalEnv, hostOf, keySlot } from '../shared/services'

/** Record scope: the registered name of the Host plugin, as the credential seam asks. */
const SCOPE = 'novel-writer'
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

type CredentialRef = Parameters<Context['credentials']['resolve']>[0]
type CredentialKey = Parameters<Context['credentials']['readRecord']>[0]

export class KeyStore implements KeySource {
  constructor(private readonly ctx: Context, private readonly log: (message: string, error?: unknown) => void) {}

  /** A record key is a plain `<scope>/<id>` string behind its brand. */
  private recordKey(url: string): CredentialKey | undefined {
    const slot = keySlot(url)
    return slot !== undefined ? `${SCOPE}/${slot}` as unknown as CredentialKey : undefined
  }

  async named(ref: string): Promise<string | undefined> {
    const name = ref.trim()
    if (!NAME.test(name)) return undefined
    try {
      const resolved = await this.ctx.credentials.resolve(name as CredentialRef)
      if (resolved?.value !== undefined && resolved.value.length > 0) return resolved.value
    } catch (error) {
      this.log(`credential "${name}" could not be resolved`, error)
    }
    // The Harness layers the environment first already; this covers credential providers without that layer.
    const ambient = process.env[name]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  private async saved(url: string): Promise<string | undefined> {
    const key = this.recordKey(url)
    if (key === undefined) return undefined
    try {
      const record = await this.ctx.credentials.readRecord(key)
      if (record?.kind === 'api-key' && record.key !== undefined && record.key.length > 0) return record.key
    } catch (error) {
      this.log(`the key saved for ${hostOf(url) ?? url} could not be read`, error)
    }
    return undefined
  }

  private async conventional(url: string): Promise<{ name: string; value: string } | undefined> {
    for (const name of conventionalEnv(url)) {
      const value = await this.named(name)
      if (value !== undefined) return { name, value }
    }
    return undefined
  }

  async forEndpoint(url: string): Promise<string | undefined> {
    return await this.saved(url) ?? (await this.conventional(url))?.value
  }

  /**
   * Store the key for an endpoint's host.
   * @throws ProjectError `novel/invalid` when the address is not a URL or the key is blank.
   */
  async save(url: string, value: string): Promise<void> {
    const key = this.recordKey(url)
    if (key === undefined) throw new ProjectError('novel/invalid', `"${url}" is not an endpoint address`)
    const secret = value.trim()
    if (secret.length === 0) throw new ProjectError('novel/invalid', 'the key is empty')
    if (/\s/.test(secret)) throw new ProjectError('novel/invalid', 'a key has no spaces or line breaks in it — check what was pasted')
    await this.ctx.credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: secret }))
  }

  /** Forget the key saved for an endpoint's host; an environment variable keeps working. */
  async clear(url: string): Promise<void> {
    const key = this.recordKey(url)
    if (key !== undefined) await this.ctx.credentials.deleteRecord(key)
  }

  /** Whether a key will be found for an endpoint, and where from — never the key. */
  async describe(url: string, ref?: string): Promise<KeyState> {
    const host = hostOf(url) ?? url
    const name = ref?.trim()
    if (name !== undefined && name.length > 0) {
      const found = await this.named(name)
      return { host, configured: found !== undefined, source: 'named', name }
    }
    if (await this.saved(url) !== undefined) return { host, configured: true, source: 'saved' }
    const ambient = await this.conventional(url)
    if (ambient !== undefined) return { host, configured: true, source: 'env', name: ambient.name }
    return { host, configured: false }
  }
}

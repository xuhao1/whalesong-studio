// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Unlocking a sealed book the way this computer is unlocked: a fingerprint, a
 * face, or the computer's own password.
 *
 * Two things are needed for that, and both are the operating system's:
 *
 *   presence   a prompt only the system can show and only the owner can pass
 *              — Touch ID on a Mac (falling back to the Mac's password),
 *              Windows Hello on Windows;
 *   a keeper   the account's own credential store, which holds a secret that
 *              unwraps the book's key and gives it only to this account — the
 *              login keychain on a Mac, DPAPI on Windows.
 *
 * The Studio asks for presence first and fetches the secret only after a yes.
 * The secret is useless without the book's `novel.json`, and the book is
 * useless without the secret or its password.
 *
 * macOS is exercised by tests of what can be tested without a finger (the
 * check, the keychain round trip). Windows is written from the platform's
 * documentation and has not been run; where it does not work the book still
 * opens with its password.
 */
import { spawn } from 'node:child_process'
import { access, constants, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '../core/settings'

export interface DeviceInfo {
  /** The owner can be asked to prove presence here, and a secret can be kept. */
  available: boolean
  /** A fingerprint or face reader is set up; otherwise presence is the computer's password. */
  biometrics: boolean
  /** What to call it: "Touch ID", "Windows Hello", "the computer's password". */
  method: 'touch-id' | 'windows-hello' | 'password' | 'none'
  /** This computer's name, to tell its slot from another computer's. */
  host: string
}

export interface DeviceAuth {
  info(): Promise<DeviceInfo>
  /** Show the system's prompt. @returns whether the owner confirmed. */
  confirm(reason: string, signal?: AbortSignal): Promise<boolean>
  store(id: string, secret: Buffer): Promise<void>
  load(id: string): Promise<Buffer | undefined>
  remove(id: string): Promise<void>
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

/** Run a program with nothing of ours on its command line but what is passed here; `input` goes to its stdin. */
function run(command: string, args: string[], options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Ran> {
  return new Promise((done) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', kill)
      done({ code, stdout, stderr })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      done({ code: null, stdout: '', stderr: 'could not start' })
      return
    }
    const kill = (): void => {
      child.kill()
      finish(null)
    }
    const timer = setTimeout(kill, options.timeoutMs ?? 20_000)
    options.signal?.addEventListener('abort', kill, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-65536) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096) })
    child.on('error', () => { finish(null) })
    child.on('close', (code) => { finish(code) })
    child.stdin?.on('error', () => { /* the program reports its own failure */ })
    child.stdin?.end(options.input ?? '')
  })
}

/** Without spaces, so it needs no quoting anywhere it is passed. */
const SERVICE = 'novel-studio-book-key'
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)

// ───────────────────────────── macOS ─────────────────────────────

/** The owner-check helper built with the plugin; it answers yes or no and holds no secret. */
async function macHelper(): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'novel-auth'), join(here, '..', 'novel-auth'), join(here, '..', '..', 'lib', 'novel-auth')]) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here; try the next place.
    }
  }
  return undefined
}

class MacAuth implements DeviceAuth {
  async info(): Promise<DeviceInfo> {
    const helper = await macHelper()
    const host = hostname()
    if (helper === undefined) return { available: false, biometrics: false, method: 'none', host }
    const checked = await run(helper, ['check'], { timeoutMs: 8000 })
    try {
      const answer = JSON.parse(checked.stdout.trim()) as { ok?: boolean; biometrics?: boolean }
      const available = checked.code === 0 && answer.ok === true
      return { available, biometrics: available && answer.biometrics === true, method: !available ? 'none' : answer.biometrics === true ? 'touch-id' : 'password', host }
    } catch {
      return { available: false, biometrics: false, method: 'none', host }
    }
  }

  async confirm(reason: string, signal?: AbortSignal): Promise<boolean> {
    const helper = await macHelper()
    if (helper === undefined) return false
    // The prompt waits for a person; two minutes is long enough to find the sensor, short enough not to hang forever.
    const answer = await run(helper, ['confirm', reason], { timeoutMs: 120_000, ...(signal !== undefined ? { signal } : {}) })
    return answer.code === 0
  }

  async store(id: string, secret: Buffer): Promise<void> {
    // Through the tool's own prompt, so the secret is never on a command line where another process could read it.
    const line = `add-generic-password -U -a ${safeId(id)} -s ${SERVICE} -l Novel-Studio-sealed-book -w ${secret.toString('base64')}\n`
    const done = await run('/usr/bin/security', ['-i'], { input: line })
    if (done.code !== 0 || (await this.load(id)) === undefined) throw new Error(`the login keychain would not keep the key${done.stderr.trim().length > 0 ? `: ${done.stderr.trim().slice(0, 200)}` : ''}`)
  }

  async load(id: string): Promise<Buffer | undefined> {
    const found = await run('/usr/bin/security', ['find-generic-password', '-a', safeId(id), '-s', SERVICE, '-w'])
    if (found.code !== 0) return undefined
    const secret = Buffer.from(found.stdout.trim(), 'base64')
    return secret.length === 32 ? secret : undefined
  }

  async remove(id: string): Promise<void> {
    await run('/usr/bin/security', ['delete-generic-password', '-a', safeId(id), '-s', SERVICE])
  }
}

// ───────────────────────────── Windows ─────────────────────────────

const WINRT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($operation, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait(-1) | Out-Null; $task.Result }
`

class WindowsAuth implements DeviceAuth {
  private file(id: string): string {
    return join(resolveDshHome(), 'novel-writer', 'keys', `${safeId(id)}.bin`)
  }

  private shell(script: string, options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Ran> {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { ...options, input: `${script}\n${options.input ?? ''}` })
  }

  async info(): Promise<DeviceInfo> {
    const host = hostname()
    const checked = await this.shell(`${WINRT}\n$state = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])\nWrite-Output "state=$state"`, { timeoutMs: 15_000 })
    const available = checked.code === 0 && /state=Available/.test(checked.stdout)
    return { available, biometrics: available, method: available ? 'windows-hello' : 'none', host }
  }

  async confirm(reason: string, signal?: AbortSignal): Promise<boolean> {
    // The reason travels as base64 so nothing in it can be taken for script.
    const encoded = Buffer.from(reason, 'utf8').toString('base64')
    const asked = await this.shell(`${WINRT}\n$reason = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\n$result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($reason)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])\nif ($result -eq 'Verified') { exit 0 } else { exit 1 }`, { timeoutMs: 120_000, ...(signal !== undefined ? { signal } : {}) })
    return asked.code === 0
  }

  async store(id: string, secret: Buffer): Promise<void> {
    const file = this.file(id)
    await mkdir(dirname(file), { recursive: true })
    // Sealed by Windows to this account (DPAPI): the file opens for nobody else and on no other machine.
    const sealed = await this.shell(`Add-Type -AssemblyName System.Security\n$plain = [Convert]::FromBase64String('${secret.toString('base64')}')\n$sealed = [Security.Cryptography.ProtectedData]::Protect($plain, $null, 'CurrentUser')\nWrite-Output ([Convert]::ToBase64String($sealed))`)
    const data = Buffer.from(sealed.stdout.trim(), 'base64')
    if (sealed.code !== 0 || data.length === 0) throw new Error('Windows would not seal the key to this account')
    await writeFile(file, data)
  }

  async load(id: string): Promise<Buffer | undefined> {
    let sealed: Buffer
    try {
      sealed = await readFile(this.file(id))
    } catch {
      return undefined
    }
    const opened = await this.shell(`Add-Type -AssemblyName System.Security\n$sealed = [Convert]::FromBase64String('${sealed.toString('base64')}')\n$plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'CurrentUser')\nWrite-Output ([Convert]::ToBase64String($plain))`)
    const secret = Buffer.from(opened.stdout.trim(), 'base64')
    return opened.code === 0 && secret.length === 32 ? secret : undefined
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true })
  }
}

/** What this platform offers; undefined where the Studio knows no way to ask (a book then opens with its password only). */
export function createDeviceAuth(): DeviceAuth | undefined {
  if (process.platform === 'darwin') return new MacAuth()
  if (process.platform === 'win32') return new WindowsAuth()
  return undefined
}

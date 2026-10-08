// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Sound made smaller for the way out of the book.
 *
 * In the book a voice is kept as it was made — uncompressed, so that it can
 * be cut, joined and mixed again without loss. Sent to a reader over the
 * internet that is four times the bytes for nothing a listener hears. A press
 * turns one WAV file into AAC in an MP4 file (`.m4a`): the one compressed
 * format every browser on every phone, tablet and computer plays.
 *
 * The rate is generous on purpose — four bits for each sample of each
 * channel, 96 kbit/s for a voice at 24 kHz — which is where the result stops
 * being told from the original: the measure here is "sounds the same", not
 * "as small as it goes".
 *
 * The work is ffmpeg's, on whichever system it is installed; there is no
 * press where it is not, and whoever asks is told so.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProgram } from '../util/program'
import { wavFormat } from './wav'

export interface SoundPress {
  /** What a pressed file is: the end of its name. */
  ext: string
  /** The encoding, by name: a file pressed under another name is pressed again. */
  key: string
  /**
   * One WAV file as a smaller one that sounds the same.
   * @throws when the bytes are no sound the press can read, or the work does not finish.
   */
  press(wav: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>
}

/** Bits a second for sound of this shape: four for each sample of each channel, within what AAC is good at. */
export function pressRate(format: { sampleRate: number; channels: number }): number {
  const channels = Math.min(2, Math.max(1, format.channels))
  const each = Math.min(128_000, Math.max(48_000, format.sampleRate * 4))
  return Math.round((each * channels) / 8000) * 8000
}

/** The press of this computer: ffmpeg's AAC encoder; nothing when ffmpeg is not installed. */
export async function findSoundPress(): Promise<SoundPress | undefined> {
  const ffmpeg = await findProgram('ffmpeg')
  if (ffmpeg === undefined) return undefined
  return {
    ext: 'm4a',
    key: 'aac-lc/4-bits-a-sample/1',
    async press(wav, signal) {
      const format = wavFormat(wav)
      if (format === undefined) throw new Error('not a WAV file')
      // An MP4 file is finished by going back to its start, which a pipe cannot do: written to a file of its own, read back, and gone.
      const scratch = await mkdtemp(join(tmpdir(), 'novel-press-'))
      const file = join(scratch, 'sound.m4a')
      try {
        await encode(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-f', 'wav', '-i', 'pipe:0',
          '-vn', '-map_metadata', '-1',
          '-c:a', 'aac', '-b:a', String(pressRate(format)),
          // The same sound gives the same bytes, whenever it is pressed; the index first, so that it plays while it loads.
          '-fflags', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart',
          '-f', 'ipod', file,
        ], wav, { timeoutMs: Math.max(60_000, Math.round(wav.byteLength / 512)), ...(signal !== undefined ? { signal } : {}) })
        const pressed = await readFile(file)
        if (pressed.byteLength < 16 || pressed.subarray(4, 8).toString('latin1') !== 'ftyp') throw new Error('ffmpeg wrote no sound file')
        return new Uint8Array(pressed.buffer, pressed.byteOffset, pressed.byteLength)
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}

/** Run ffmpeg over bytes handed to it; an answer other than "done" is an error, with what it said. */
function encode(program: string, args: string[], input: Uint8Array, options: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'ignore', 'pipe'], ...(options.signal !== undefined ? { signal: options.signal } : {}) })
    let said = ''
    let late = false
    const timer = setTimeout(() => {
      late = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stderr.on('data', (chunk: Buffer) => { if (said.length < 2000) said += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (late) reject(new Error('ffmpeg did not finish in time'))
      else if (code === 0) resolvePromise()
      else reject(new Error(`ffmpeg: ${said.trim().split('\n').at(-1) ?? `exit ${code}`}`))
    })
    // ffmpeg may stop reading before everything is written (a file it cannot read): that is its answer, not a failure of the pipe.
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

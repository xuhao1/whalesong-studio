// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Plays an audio script line by line: the synthesized voice of each line in
 * order, and under it the sound the script's cues call for — the bed of the
 * scene, music, an effect where a line begins. Lines without audio are held
 * for their reading time, so a script (and a motion comic) can be previewed
 * before any speech is synthesized; lines left unspoken are passed over.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AmbiencePreset, AudioCue, AudioLine } from '../../shared/types'
import { Ambience } from './ambience'

export interface PlayerState {
  status: 'idle' | 'playing' | 'paused'
  /** Index of the line being played; -1 when idle. */
  index: number
  ambience: AmbiencePreset
  /** Ids of the sound cues in force at the line being played: the bed and the music under it, the effects on it. */
  sounding?: string[]
}

export interface PlayerOptions {
  rate: number
  voiceVolume: number
  ambienceVolume: number
  ambienceOn: boolean
}

type MediaUrl = (path: string, version?: string | number) => string

export class LinePlayer {
  private readonly audio = new Audio()
  private readonly ambience = new Ambience()
  private readonly listeners = new Set<() => void>()
  private state: PlayerState = { status: 'idle', index: -1, ambience: 'none' }
  private lines: AudioLine[] = []
  private cues: AudioCue[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private holdUntil = 0
  private holdLeft = 0
  /** How long the silent line on screen is held in all, for knowing how far through it we are. */
  private holdTotal = 0
  /** Called when the last line has played out — not when playback is stopped. */
  onEnd: (() => void) | undefined
  /** True while a silent line is being held; stray media events are ignored then. */
  private holding = false
  private url: MediaUrl = path => path
  options: PlayerOptions = { rate: 1, voiceVolume: 1, ambienceVolume: 0.5, ambienceOn: true }

  constructor() {
    this.audio.preload = 'auto'
    this.audio.addEventListener('ended', this.onAudioEnd)
    this.audio.addEventListener('error', this.onAudioEnd)
  }

  private readonly onAudioEnd = (): void => {
    if (!this.holding) this.advance()
  }

  getSnapshot = (): PlayerState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** Replace the script; a playing position follows its line by id. */
  load(lines: AudioLine[], cues: AudioCue[], url: MediaUrl): void {
    const current = this.lines[this.state.index]?.id
    this.lines = lines
    this.cues = cues
    this.url = url
    if (this.state.index >= 0) {
      const index = current !== undefined ? lines.findIndex(line => line.id === current) : -1
      if (index < 0) this.stop()
      else if (index !== this.state.index) this.set({ index })
      // A clip that was generated while the scene plays comes in under it.
      if (index >= 0 && this.state.status === 'playing') this.set({ sounding: this.sound(index, false) })
    }
  }

  configure(options: Partial<PlayerOptions>): void {
    const was = this.options.ambienceOn
    this.options = { ...this.options, ...options }
    this.audio.playbackRate = this.options.rate
    this.audio.volume = this.options.voiceVolume
    this.ambience.setVolume(this.options.ambienceOn ? this.options.ambienceVolume : 0)
    // Switched on in the middle of a line: the scene's sound comes in at once, without replaying its effects.
    if (was !== this.options.ambienceOn && this.state.status === 'playing' && this.state.index >= 0) this.sound(this.state.index, false)
  }

  /** The cue of a kind in force at a line: the latest one at or before it. */
  private cueAt(index: number, kind: 'bed' | 'music' = 'bed'): AudioCue | undefined {
    const position = new Map(this.lines.map((line, at) => [line.id, at]))
    let best: AudioCue | undefined
    let bestAt = -1
    for (const cue of this.cues) {
      if ((cue.kind ?? 'bed') !== kind) continue
      const at = position.get(cue.at)
      if (at !== undefined && at <= index && at >= bestAt) {
        best = cue
        bestAt = at
      }
    }
    return best
  }

  /** The nearest line that is spoken, from `index` on in a direction; -1 when there is none. */
  private spoken(index: number, direction: 1 | -1 = 1): number {
    let at = index
    while (at >= 0 && at < this.lines.length && this.lines[at]!.skip === true) at += direction
    return at >= 0 && at < this.lines.length ? at : -1
  }

  play(index = 0): void {
    if (this.lines.length === 0) return
    this.clearTimer()
    const from = Math.max(0, Math.min(this.lines.length - 1, index))
    const at = this.spoken(from)
    this.start(at >= 0 ? at : this.spoken(from, -1))
  }

  /** Put under the line the sound its cues call for. */
  private sound(index: number, entering: boolean): string[] {
    const line = this.lines[index]!
    const bed = this.cueAt(index, 'bed')
    const music = this.cueAt(index, 'music')
    const effects = this.cues.filter(cue => cue.kind === 'effect' && cue.at === line.id)
    this.ambience.suspend(false)
    if (!this.options.ambienceOn) {
      this.ambience.stop()
    } else {
      // A generated bed plays when there is one; until then, and without a sound model, the synthesized one does.
      if (bed?.audio !== undefined) {
        this.ambience.set('none')
        this.ambience.loop('bed', this.url(bed.audio, bed.renderKey), 0.6 + (bed.intensity ?? 0.6) * 0.7)
      } else {
        this.ambience.loop('bed', undefined)
        this.ambience.set(bed?.ambience ?? 'none', bed?.intensity ?? 0.6)
      }
      this.ambience.loop('music', music?.audio !== undefined && music.ambience === 'none' ? this.url(music.audio, music.renderKey) : undefined)
      if (entering) for (const effect of effects) if (effect.audio !== undefined) this.ambience.shot(this.url(effect.audio, effect.renderKey))
    }
    return [bed, music, ...effects].flatMap(cue => (cue?.id !== undefined ? [cue.id] : []))
  }

  private start(index: number): void {
    const line = this.lines[index]
    if (line === undefined) {
      this.stop()
      return
    }
    const sounding = this.sound(index, true)
    this.set({ status: 'playing', index, ambience: this.cueAt(index)?.ambience ?? 'none', sounding })
    if (line.audio !== undefined) {
      this.holding = false
      this.audio.src = this.url(line.audio, line.renderKey)
      this.audio.playbackRate = this.options.rate
      this.audio.volume = this.options.voiceVolume
      void this.audio.play().catch(() => { this.hold(line) })
    } else {
      this.hold(line)
    }
  }

  /** Keep a silent line on screen for about as long as it takes to read. */
  private hold(line: AudioLine, left?: number): void {
    const duration = left ?? Math.max(1200, line.text.length * (/[㐀-鿿]/.test(line.text) ? 190 : 62)) / this.options.rate
    if (left === undefined) this.holdTotal = duration
    this.holding = true
    this.holdUntil = Date.now() + duration
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.holding = false
      this.advance()
    }, duration)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private readonly advance = (): void => {
    if (this.state.status !== 'playing') return
    this.clearTimer()
    const next = this.spoken(this.state.index + 1)
    if (next < 0) {
      this.stop()
      this.onEnd?.()
      return
    }
    // A breath between lines keeps speakers from stepping on each other.
    const changed = this.lines[next]!.speaker !== this.lines[this.state.index]?.speaker
    this.timer = setTimeout(() => { if (this.state.status === 'playing') this.start(next) }, (changed ? 320 : 140) / this.options.rate)
  }

  pause(): void {
    if (this.state.status !== 'playing') return
    this.holdLeft = this.timer !== undefined ? Math.max(0, this.holdUntil - Date.now()) : 0
    this.clearTimer()
    this.audio.pause()
    this.ambience.suspend(true)
    this.set({ status: 'paused' })
  }

  resume(): void {
    if (this.state.status !== 'paused') return
    const line = this.lines[this.state.index]
    if (line === undefined) {
      this.stop()
      return
    }
    this.ambience.suspend(false)
    this.set({ status: 'playing' })
    if (!this.holding && line.audio !== undefined && !this.audio.ended) void this.audio.play().catch(() => { this.hold(line) })
    else this.hold(line, Math.max(200, this.holdLeft))
  }

  /** How far through the line on screen playback is, from 0 to 1. A picture that changes mid-line goes by this. */
  fraction(): number {
    if (this.state.index < 0) return 0
    if (this.holding) {
      if (this.holdTotal <= 0) return 0
      const left = this.state.status === 'paused' ? this.holdLeft : Math.max(0, this.holdUntil - Date.now())
      return Math.max(0, Math.min(1, 1 - left / this.holdTotal))
    }
    const duration = this.audio.duration
    return Number.isFinite(duration) && duration > 0 ? Math.max(0, Math.min(1, this.audio.currentTime / duration)) : 0
  }

  toggle(): void {
    if (this.state.status === 'playing') this.pause()
    else if (this.state.status === 'paused') this.resume()
    else this.play(0)
  }

  step(delta: number): void {
    const index = this.spoken(this.state.index < 0 ? 0 : this.state.index + delta, delta < 0 ? -1 : 1)
    if (index < 0) return
    this.audio.pause()
    this.clearTimer()
    this.start(index)
  }

  stop(): void {
    this.clearTimer()
    this.holding = false
    this.audio.pause()
    this.ambience.suspend(false)
    this.ambience.stop()
    this.set({ status: 'idle', index: -1, ambience: 'none', sounding: [] })
  }

  dispose(): void {
    this.clearTimer()
    this.audio.pause()
    this.audio.removeEventListener('ended', this.onAudioEnd)
    this.audio.removeEventListener('error', this.onAudioEnd)
    this.ambience.dispose()
    this.listeners.clear()
    this.onEnd = undefined
  }
}

/** A player bound to a component's lifetime. */
export function useLinePlayer(lines: AudioLine[], cues: AudioCue[], url: MediaUrl, options: PlayerOptions, onEnd?: () => void): { player: LinePlayer; state: PlayerState } {
  const player = useMemo(() => new LinePlayer(), [])
  useEffect(() => () => { player.dispose() }, [player])
  // The newest callback is the one called, without re-creating the player for it.
  useEffect(() => {
    player.onEnd = onEnd
  })
  useEffect(() => { player.load(lines, cues, url) }, [player, lines, cues, url])
  useEffect(() => { player.configure(options) }, [player, options.rate, options.voiceVolume, options.ambienceVolume, options.ambienceOn])
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot)
  return { player, state }
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Procedural ambience: every preset is synthesized in the browser with the Web
 * Audio API — filtered noise, slow modulation and a few scheduled one-shots —
 * so the audio drama, the motion comic and the interludes have a sound bed
 * without shipping or generating a single sample.
 */
import type { AmbiencePreset } from '../../shared/types'

type NoiseKind = 'white' | 'pink' | 'brown'
type Stop = () => void

const buffers = new WeakMap<BaseAudioContext, Record<NoiseKind, AudioBuffer>>()

function noiseBuffers(context: BaseAudioContext): Record<NoiseKind, AudioBuffer> {
  const cached = buffers.get(context)
  if (cached !== undefined) return cached
  const length = context.sampleRate * 4
  const make = (fill: (data: Float32Array) => void): AudioBuffer => {
    const buffer = context.createBuffer(1, length, context.sampleRate)
    fill(buffer.getChannelData(0))
    return buffer
  }
  const made: Record<NoiseKind, AudioBuffer> = {
    white: make((data) => { for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1 }),
    // Paul Kellet's economy pink filter.
    pink: make((data) => {
      let b0 = 0
      let b1 = 0
      let b2 = 0
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1
        b0 = 0.99765 * b0 + white * 0.0990460
        b1 = 0.96300 * b1 + white * 0.2965164
        b2 = 0.57000 * b2 + white * 1.0526913
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22
      }
    }),
    brown: make((data) => {
      let last = 0
      for (let i = 0; i < data.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
        data[i] = last * 3.5
      }
    }),
  }
  buffers.set(context, made)
  return made
}

/** The small toolkit a preset is built from. Everything it creates dies with `stop`. */
function createKit(context: AudioContext, out: AudioNode) {
  const sources: AudioScheduledSourceNode[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let alive = true
  const noises = noiseBuffers(context)
  const gain = (value: number): GainNode => {
    const node = context.createGain()
    node.gain.value = value
    return node
  }
  const filter = (type: BiquadFilterType, frequency: number, q = 0.7): BiquadFilterNode => {
    const node = context.createBiquadFilter()
    node.type = type
    node.frequency.value = frequency
    node.Q.value = q
    return node
  }
  const chain = (first: AudioNode, ...rest: AudioNode[]): AudioNode => {
    let node = first
    for (const next of rest) {
      node.connect(next)
      node = next
    }
    return node
  }
  const noise = (kind: NoiseKind): AudioBufferSourceNode => {
    const node = context.createBufferSource()
    node.buffer = noises[kind]
    node.loop = true
    // Looping layers start at different points so they never phase-lock.
    node.start(0, Math.random() * 3)
    sources.push(node)
    return node
  }
  const tone = (type: OscillatorType, frequency: number): OscillatorNode => {
    const node = context.createOscillator()
    node.type = type
    node.frequency.value = frequency
    node.start()
    sources.push(node)
    return node
  }
  /** Modulate a parameter around its value. */
  const lfo = (rate: number, depth: number, target: AudioParam): void => {
    chain(tone('sine', rate), gain(depth)).connect(target)
  }
  /** A steady filtered-noise layer, optionally breathing. */
  const bed = (kind: NoiseKind, filters: BiquadFilterNode[], level: number, breathe?: { rate: number; depth: number }, to: AudioNode = out): GainNode => {
    const volume = gain(level)
    chain(noise(kind), ...filters, volume, to)
    if (breathe !== undefined) lfo(breathe.rate, level * breathe.depth, volume.gain)
    return volume
  }
  /** Call `fire` at random intervals for as long as the preset lives. */
  const every = (minMs: number, maxMs: number, fire: (time: number) => void): void => {
    const schedule = (delay: number): void => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!alive) return
        fire(context.currentTime + 0.02)
        schedule(minMs + Math.random() * (maxMs - minMs))
      }, delay)
      timers.add(timer)
    }
    schedule(Math.random() * maxMs)
  }
  /** One short burst of filtered noise with an attack-decay envelope. */
  const burst = (time: number, options: { kind?: NoiseKind; type: BiquadFilterType; frequency: number; q?: number; peak: number; attack?: number; decay: number; to?: AudioNode }): void => {
    const source = context.createBufferSource()
    source.buffer = noises[options.kind ?? 'white']
    source.loop = true
    const envelope = gain(0)
    const attack = options.attack ?? 0.004
    envelope.gain.setValueAtTime(0, time)
    envelope.gain.linearRampToValueAtTime(options.peak, time + attack)
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + attack + options.decay)
    chain(source, filter(options.type, options.frequency, options.q ?? 0.8), envelope, options.to ?? out)
    source.start(time, Math.random() * 3)
    source.stop(time + attack + options.decay + 0.05)
  }
  /** One short pitched note, optionally gliding. */
  const ping = (time: number, options: { type?: OscillatorType; from: number; to?: number; peak: number; attack?: number; decay: number; out?: AudioNode }): void => {
    const source = context.createOscillator()
    source.type = options.type ?? 'sine'
    source.frequency.setValueAtTime(options.from, time)
    if (options.to !== undefined) source.frequency.exponentialRampToValueAtTime(options.to, time + options.decay)
    const envelope = gain(0)
    const attack = options.attack ?? 0.005
    envelope.gain.setValueAtTime(0, time)
    envelope.gain.linearRampToValueAtTime(options.peak, time + attack)
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + attack + options.decay)
    chain(source, envelope, options.out ?? out)
    source.start(time)
    source.stop(time + attack + options.decay + 0.05)
  }
  /** A feedback delay for spaces that answer back. */
  const echo = (delaySeconds: number, feedback: number, level: number): AudioNode => {
    const input = gain(1)
    const delay = context.createDelay(2)
    delay.delayTime.value = delaySeconds
    const loop = gain(feedback)
    input.connect(out)
    chain(input, delay, loop, delay)
    chain(delay, gain(level), out)
    return input
  }
  const stop: Stop = () => {
    alive = false
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const source of sources) {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    }
  }
  return { context, out, gain, filter, chain, noise, tone, lfo, bed, every, burst, ping, echo, stop }
}

type Kit = ReturnType<typeof createKit>

const rand = (min: number, max: number): number => min + Math.random() * (max - min)

function rain(kit: Kit, level = 1): void {
  kit.bed('pink', [kit.filter('highpass', 500), kit.filter('lowpass', 9000)], 0.5 * level)
  kit.bed('white', [kit.filter('bandpass', 2600, 0.5)], 0.12 * level, { rate: 0.11, depth: 0.5 })
  kit.bed('brown', [kit.filter('lowpass', 400)], 0.25 * level)
}

function wind(kit: Kit, level = 1, centre = 520): void {
  const sweep = kit.filter('bandpass', centre, 0.9)
  kit.lfo(0.07, centre * 0.45, sweep.frequency)
  kit.lfo(0.031, centre * 0.2, sweep.frequency)
  kit.bed('pink', [sweep], 0.75 * level, { rate: 0.09, depth: 0.55 })
  kit.bed('brown', [kit.filter('lowpass', 220)], 0.3 * level, { rate: 0.05, depth: 0.5 })
}

function crackle(kit: Kit, level = 1): void {
  kit.bed('brown', [kit.filter('lowpass', 480)], 0.32 * level, { rate: 0.6, depth: 0.25 })
  kit.every(30, 240, (time) => { kit.burst(time, { type: 'highpass', frequency: rand(1200, 4200), peak: rand(0.05, 0.4) * level, decay: rand(0.006, 0.035) }) })
  kit.every(900, 3200, (time) => { kit.burst(time, { kind: 'brown', type: 'bandpass', frequency: rand(250, 600), peak: 0.5 * level, decay: 0.12 }) })
}

function murmur(kit: Kit, level = 1): void {
  // Three formant-ish bands, each pulsing at a syllable rate of its own, read as distant voices.
  for (const [frequency, rate] of [[420, 2.7], [950, 3.9], [1900, 5.3]] as const) {
    kit.bed('pink', [kit.filter('bandpass', frequency, 1.4)], 0.42 * level, { rate: rate * rand(0.9, 1.1), depth: 0.7 })
  }
  kit.bed('brown', [kit.filter('lowpass', 300)], 0.22 * level)
}

const PRESETS: Record<Exclude<AmbiencePreset, 'none'>, (kit: Kit) => void> = {
  rain: (kit) => { rain(kit) },
  storm: (kit) => {
    rain(kit, 1.25)
    wind(kit, 0.5, 420)
    kit.every(7000, 21000, (time) => {
      kit.burst(time, { kind: 'brown', type: 'lowpass', frequency: rand(90, 190), peak: rand(0.9, 1.6), attack: 0.08, decay: rand(2.5, 5) })
      kit.burst(time + 0.12, { kind: 'pink', type: 'bandpass', frequency: 900, q: 0.4, peak: 0.25, attack: 0.01, decay: 0.5 })
    })
  },
  wind: (kit) => { wind(kit) },
  night: (kit) => {
    kit.bed('brown', [kit.filter('lowpass', 260)], 0.16, { rate: 0.05, depth: 0.5 })
    // Crickets: short trains of pulses on a high, slightly drifting pitch.
    for (const base of [4300, 4850, 3650]) {
      kit.every(500, 1500, (time) => {
        const pulses = 2 + Math.floor(Math.random() * 3)
        for (let i = 0; i < pulses; i++) kit.ping(time + i * 0.055, { from: base * rand(0.985, 1.015), peak: rand(0.015, 0.05), attack: 0.004, decay: 0.03 })
      })
    }
  },
  forest: (kit) => {
    kit.bed('pink', [kit.filter('highpass', 1400), kit.filter('lowpass', 6500)], 0.2, { rate: 0.08, depth: 0.7 })
    kit.bed('brown', [kit.filter('lowpass', 300)], 0.12)
    kit.every(1400, 5200, (time) => {
      const notes = 1 + Math.floor(Math.random() * 4)
      const pitch = rand(1900, 3400)
      for (let i = 0; i < notes; i++) kit.ping(time + i * rand(0.09, 0.16), { from: pitch * rand(0.9, 1.1), to: pitch * rand(1.15, 1.5), peak: rand(0.02, 0.07), decay: rand(0.06, 0.14) })
    })
  },
  sea: (kit) => {
    const swell = kit.bed('brown', [kit.filter('lowpass', 900)], 0.55)
    kit.lfo(0.085, 0.42, swell.gain)
    const wash = kit.bed('pink', [kit.filter('highpass', 900), kit.filter('lowpass', 5200)], 0.22)
    kit.lfo(0.085, 0.2, wash.gain)
    kit.lfo(0.037, 0.06, wash.gain)
  },
  river: (kit) => {
    kit.bed('white', [kit.filter('bandpass', 1300, 0.6)], 0.2, { rate: 0.9, depth: 0.25 })
    kit.bed('white', [kit.filter('bandpass', 3100, 0.8)], 0.1, { rate: 1.7, depth: 0.35 })
    kit.bed('brown', [kit.filter('lowpass', 500)], 0.2, { rate: 0.2, depth: 0.3 })
    kit.every(120, 600, (time) => { kit.ping(time, { from: rand(700, 1500), to: rand(1600, 2600), peak: rand(0.006, 0.02), decay: rand(0.03, 0.08) }) })
  },
  fire: (kit) => { crackle(kit) },
  city: (kit) => {
    kit.bed('brown', [kit.filter('lowpass', 230)], 0.5, { rate: 0.06, depth: 0.35 })
    kit.bed('pink', [kit.filter('bandpass', 780, 0.5)], 0.1, { rate: 0.13, depth: 0.6 })
    kit.every(9000, 26000, (time) => {
      const pitch = rand(360, 470)
      kit.ping(time, { type: 'triangle', from: pitch, peak: 0.03, attack: 0.03, decay: 0.45 })
      kit.ping(time, { type: 'triangle', from: pitch * 1.26, peak: 0.022, attack: 0.03, decay: 0.45 })
    })
    // A car passing: a band of noise that rises and falls.
    kit.every(5000, 14000, (time) => { kit.burst(time, { kind: 'pink', type: 'bandpass', frequency: rand(500, 1100), q: 0.6, peak: 0.16, attack: rand(0.8, 1.6), decay: rand(1.5, 3) }) })
  },
  crowd: (kit) => { murmur(kit) },
  tavern: (kit) => {
    murmur(kit, 1.1)
    crackle(kit, 0.35)
    kit.every(1800, 6000, (time) => { kit.ping(time, { from: rand(2400, 4200), peak: rand(0.02, 0.05), decay: rand(0.12, 0.3) }) })
    kit.every(4000, 11000, (time) => { kit.burst(time, { kind: 'brown', type: 'lowpass', frequency: 260, peak: 0.35, decay: 0.12 }) })
  },
  battle: (kit) => {
    kit.bed('brown', [kit.filter('lowpass', 170)], 0.6, { rate: 0.4, depth: 0.5 })
    kit.bed('pink', [kit.filter('bandpass', 700, 0.6)], 0.14, { rate: 0.23, depth: 0.7 })
    kit.every(350, 1700, (time) => { kit.burst(time, { type: 'bandpass', frequency: rand(2400, 4600), q: 9, peak: rand(0.1, 0.32), decay: rand(0.08, 0.25) }) })
    kit.every(900, 3200, (time) => { kit.ping(time, { from: rand(58, 80), to: 38, peak: rand(0.35, 0.7), decay: rand(0.3, 0.6) }) })
  },
  cave: (kit) => {
    kit.bed('brown', [kit.filter('lowpass', 190)], 0.2, { rate: 0.04, depth: 0.5 })
    const space = kit.echo(0.34, 0.46, 0.5)
    kit.every(1300, 5200, (time) => { kit.ping(time, { from: rand(950, 1700), to: rand(500, 800), peak: rand(0.05, 0.13), decay: rand(0.12, 0.3), out: space }) })
  },
  snow: (kit) => {
    wind(kit, 0.32, 640)
    kit.bed('pink', [kit.filter('lowpass', 800)], 0.07, { rate: 0.05, depth: 0.6 })
  },
  train: (kit) => {
    kit.bed('brown', [kit.filter('lowpass', 320)], 0.5, { rate: 1.1, depth: 0.12 })
    kit.bed('pink', [kit.filter('bandpass', 1500, 0.5)], 0.06)
    const clack = (time: number): void => {
      for (const offset of [0, 0.17]) kit.burst(time + offset, { kind: 'brown', type: 'lowpass', frequency: 420, peak: 0.75, decay: 0.07 })
    }
    kit.every(840, 900, clack)
  },
  spaceship: (kit) => {
    const low = kit.filter('lowpass', 210)
    const drone = kit.gain(0.22)
    kit.chain(low, drone, kit.out)
    kit.tone('sawtooth', 55).connect(low)
    kit.tone('sawtooth', 55.6).connect(low)
    kit.chain(kit.tone('sine', 110), kit.gain(0.06), kit.out)
    kit.lfo(0.05, 0.05, drone.gain)
    kit.bed('pink', [kit.filter('bandpass', 2200, 0.4)], 0.035, { rate: 0.07, depth: 0.5 })
    kit.every(6000, 16000, (time) => { kit.ping(time, { from: rand(1300, 1900), peak: 0.012, attack: 0.01, decay: 0.18 }) })
  },
  tension: (kit) => {
    const drone = kit.gain(0.2)
    drone.connect(kit.out)
    kit.tone('sine', 49).connect(drone)
    kit.tone('sine', 51.9).connect(drone)
    kit.chain(kit.tone('triangle', 98.6), kit.gain(0.25), drone)
    kit.lfo(0.06, 0.09, drone.gain)
    const shimmer = kit.gain(0.012)
    kit.chain(kit.tone('sine', 2093), shimmer, kit.out)
    kit.lfo(5.5, 0.008, shimmer.gain)
    kit.bed('brown', [kit.filter('lowpass', 140)], 0.2, { rate: 0.09, depth: 0.7 })
  },
  serene: (kit) => {
    const warm = kit.filter('lowpass', 1400)
    const pad = kit.gain(0.9)
    kit.chain(warm, pad, kit.out)
    // An open major chord whose voices swell independently.
    for (const [frequency, rate] of [[220, 0.07], [277.18, 0.053], [329.63, 0.061], [440, 0.043]] as const) {
      const voice = kit.gain(0.035)
      kit.chain(kit.tone('sine', frequency), voice, warm)
      kit.chain(kit.tone('sine', frequency * 1.003), kit.gain(0.6), voice)
      kit.lfo(rate, 0.025, voice.gain)
    }
    kit.bed('pink', [kit.filter('lowpass', 700)], 0.03)
  },
}

interface Scene {
  preset: AmbiencePreset
  gain: GainNode
  stop: Stop
}

/** A generated clip looping on a channel. */
interface Loop {
  url: string
  gain: GainNode
  source?: AudioBufferSourceNode
  dead: boolean
}

export type LoopChannel = 'bed' | 'music'

/**
 * Everything under the voice. A synthesized bed (`set`) crossfades from
 * whatever was playing; generated clips loop on a channel of their own (`loop`)
 * or are heard once (`shot`). All of it shares one output, one volume.
 */
export class Ambience {
  private context: AudioContext | undefined
  private master: GainNode | undefined
  private scene: Scene | undefined
  private volume = 0.5
  private intensity = 0.6
  private readonly loops = new Map<LoopChannel, Loop>()
  private readonly clips = new Map<string, Promise<AudioBuffer | undefined>>()

  /** Must be called from a user gesture the first time (browser autoplay rules). */
  private ensure(): AudioContext | undefined {
    if (this.context === undefined) {
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Constructor === undefined) return undefined
      this.context = new Constructor()
      this.master = this.context.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => {})
    return this.context
  }

  get current(): AmbiencePreset {
    return this.scene?.preset ?? 'none'
  }

  set(preset: AmbiencePreset, intensity = 0.6): void {
    if (this.scene?.preset === preset && Math.abs(this.intensity - intensity) < 0.05) return
    if (preset === 'none' && this.scene === undefined) return
    const context = this.ensure()
    if (context === undefined || this.master === undefined) return
    this.intensity = intensity
    const now = context.currentTime
    const previous = this.scene
    if (previous !== undefined) {
      previous.gain.gain.cancelScheduledValues(now)
      previous.gain.gain.setTargetAtTime(0, now, 0.5)
      setTimeout(() => {
        previous.stop()
        previous.gain.disconnect()
      }, 2600)
      this.scene = undefined
    }
    if (preset === 'none') return
    const gain = context.createGain()
    gain.gain.value = 0
    gain.connect(this.master)
    const kit = createKit(context, gain)
    PRESETS[preset](kit)
    gain.gain.setTargetAtTime(Math.max(0.05, Math.min(1, intensity)) * 0.9, now, 0.7)
    this.scene = { preset, gain, stop: kit.stop }
  }

  /** A clip, fetched and decoded once. A clip that cannot be had is simply not heard. */
  private clip(context: AudioContext, url: string): Promise<AudioBuffer | undefined> {
    let held = this.clips.get(url)
    if (held === undefined) {
      held = (async () => {
        try {
          const response = await fetch(url, { credentials: 'same-origin' })
          if (!response.ok) return undefined
          return await context.decodeAudioData(await response.arrayBuffer())
        } catch {
          return undefined
        }
      })()
      this.clips.set(url, held)
      if (this.clips.size > 24) this.clips.delete(this.clips.keys().next().value!)
    }
    return held
  }

  /**
   * Loop a generated clip on a channel, crossfading from whatever was on it;
   * `undefined` fades the channel out. Asking for the clip already playing changes nothing.
   */
  loop(channel: LoopChannel, url: string | undefined, level = 1): void {
    const playing = this.loops.get(channel)
    if (playing?.url === url) return
    if (url === undefined && playing === undefined) return
    const context = this.ensure()
    if (context === undefined || this.master === undefined) return
    const now = context.currentTime
    if (playing !== undefined) {
      playing.dead = true
      playing.gain.gain.cancelScheduledValues(now)
      playing.gain.gain.setTargetAtTime(0, now, 0.5)
      setTimeout(() => {
        try { playing.source?.stop() } catch { /* never started */ }
        playing.gain.disconnect()
      }, 2600)
      this.loops.delete(channel)
    }
    if (url === undefined) return
    const gain = context.createGain()
    gain.gain.value = 0
    gain.connect(this.master)
    const entry: Loop = { url, gain, dead: false }
    this.loops.set(channel, entry)
    void this.clip(context, url).then((buffer) => {
      if (buffer === undefined || entry.dead || this.context !== context) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.connect(gain)
      source.start()
      entry.source = source
      // The clips are leveled where they are made; this only brings them in gently.
      gain.gain.setTargetAtTime(Math.max(0, Math.min(1.5, level)), context.currentTime, 0.8)
    })
  }

  /** Let a clip be heard once: a door, a gavel. */
  shot(url: string, level = 1): void {
    const context = this.ensure()
    if (context === undefined || this.master === undefined) return
    const master = this.master
    void this.clip(context, url).then((buffer) => {
      if (buffer === undefined || this.context !== context) return
      const gain = context.createGain()
      gain.gain.value = Math.max(0, Math.min(1.5, level))
      gain.connect(master)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(gain)
      source.onended = () => { gain.disconnect() }
      source.start()
    })
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.master !== undefined && this.context !== undefined) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.1)
  }

  /** Fade everything out; the channels can be used again. */
  stop(): void {
    this.set('none')
    this.loop('bed', undefined)
    this.loop('music', undefined)
  }

  /** Hold or release the sound while the voice track is paused. */
  suspend(paused: boolean): void {
    if (this.context === undefined) return
    if (paused && this.context.state === 'running') void this.context.suspend().catch(() => {})
    if (!paused && this.context.state === 'suspended') void this.context.resume().catch(() => {})
  }

  dispose(): void {
    this.scene?.stop()
    this.scene = undefined
    for (const loop of this.loops.values()) {
      loop.dead = true
      try { loop.source?.stop() } catch { /* never started */ }
    }
    this.loops.clear()
    this.clips.clear()
    void this.context?.close().catch(() => {})
    this.context = undefined
    this.master = undefined
  }
}

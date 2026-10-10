// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The sound of a chapter that is not speech. The script's cues say what is
 * heard and where — the bed under a scene, a spot effect, music; this turns
 * them into clips with a sound model, and lets the author change, add and
 * remove them. A cue without a clip is still a caption beside the text, and a
 * bed without one is synthesized by the player.
 */
import { hashText } from '../../shared/text'
import type { AudioCue, AudioScript, SoundKind } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { ProviderError } from '../media/http'
import { finished, type SoundProvider } from '../media/sound'
import { durationOf, encodeWav, trimSilence } from '../media/wav'
import { ProjectError } from '../project'
import { L, promptLanguage } from '../render'
import { errorMessage, mapLimit } from '../util/async'
import { AMBIENCE, changeScript, soundPlan } from './audio'

/** How long a clip of each kind is asked to be, in seconds. Beds and music loop. */
export const SOUND_SECONDS: Record<SoundKind, number> = { bed: 18, effect: 3, music: 24 }
/** Where each kind sits under a voice leveled to -20 dBFS. */
const SOUND_LEVEL: Record<SoundKind, number> = { bed: -34, effect: -24, music: -32 }

export async function requireSound(core: NovelCore, runtime?: ProjectRuntime): Promise<SoundProvider> {
  const provider = await core.soundProvider(runtime)
  if (provider === undefined) throw new ProviderError('no sound model is set up — sound follows the speech setup when that is Bailian audio generation, or can be given an endpoint of its own in Novel Studio → Settings', undefined, 'NOT_CONFIGURED')
  return provider
}

const kindOf = (cue: AudioCue): SoundKind => cue.kind ?? 'bed'

/** Scripts written before cues had ids get them on first use. */
function withIds(script: AudioScript): AudioScript {
  if (script.cues.every(cue => cue.id !== undefined)) return script
  const taken = new Set(script.cues.map(cue => cue.id).filter((id): id is string => id !== undefined))
  let next = 0
  return {
    ...script,
    cues: script.cues.map((cue) => {
      if (cue.id !== undefined) return cue
      while (taken.has(`c${next}`)) next += 1
      taken.add(`c${next}`)
      return { ...cue, id: `c${next}` }
    }),
  }
}

async function scriptOf(runtime: ProjectRuntime, chapterRef: string): Promise<AudioScript> {
  const located = await runtime.project.findChapter(chapterRef)
  const script = located !== undefined ? await runtime.project.audioScript(located.plan.id) : undefined
  if (script === undefined) throw new ProjectError('novel/not-found', 'this chapter has no audio script yet — direct the script first')
  return withIds(script)
}

/** What the sound model is asked for: the cue's own description, else its caption, else the name of its bed. */
export function describeCue(cue: AudioCue, zh: boolean): string | undefined {
  const text = cue.prompt ?? cue.caption ?? cue.note
  if (text !== undefined && text.trim().length > 0) return text.trim()
  return kindOf(cue) === 'bed' && cue.ambience !== 'none' ? AMBIENCE[cue.ambience][zh ? 0 : 1] : undefined
}

export interface SoundResult {
  chapterId: string
  rendered: number
  /** Cues that already had a current clip. */
  kept: number
  /** Cues with nothing to make a sound from. */
  skipped: number
  failed: { cue: string; error: string }[]
  seconds: number
  model: string
}

/**
 * Generate the clips of a chapter's cues. By default: every effect and piece
 * of music, and every bed unless the book keeps to synthesized beds. Clips
 * are cached by what they were made from, so a second run only makes what
 * changed.
 */
export async function renderSound(core: NovelCore, runtime: ProjectRuntime, params: { chapter: string; cues?: string[]; kinds?: SoundKind[]; force?: boolean }, task: TaskContext): Promise<SoundResult> {
  const { project } = runtime
  const provider = await requireSound(core, runtime)
  let script = await scriptOf(runtime, params.chapter)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const plan = soundPlan(await core.settingsOf(runtime))
  const kinds = new Set<SoundKind>(params.kinds ?? ['effect', 'music', ...(plan.beds === 'generate' ? ['bed' as const] : [])])
  const named = params.cues !== undefined && params.cues.length > 0 ? new Set(params.cues) : undefined
  const wanted = script.cues.filter(cue => (named !== undefined ? named.has(cue.id!) : kinds.has(kindOf(cue))))
  const todo: { id: string; kind: SoundKind; prompt: string; seconds: number; renderKey: string }[] = []
  let kept = 0
  let skipped = 0
  for (const cue of wanted) {
    const kind = kindOf(cue)
    const prompt = describeCue(cue, lang === 'zh')
    if (prompt === undefined) {
      skipped += 1
      continue
    }
    const seconds = SOUND_SECONDS[kind]
    const renderKey = hashText([provider.kind, provider.model, kind, prompt, seconds].join('|'))
    if (params.force !== true && cue.audio !== undefined && cue.renderKey === renderKey && await project.has(cue.audio)) kept += 1
    else todo.push({ id: cue.id!, kind, prompt, seconds, renderKey })
  }
  const failed: SoundResult['failed'] = []
  let done = 0
  let total = 0
  const label = (): string => L(lang, `生成声音 ${done}/${todo.length}`, `making sounds ${done}/${todo.length}`)
  task.job?.progress(0, todo.length, label())
  await mapLimit(todo, core.parallel('sound'), async (item) => {
    let patch: Partial<AudioCue>
    try {
      const raw = await provider.generate({ kind: item.kind, prompt: item.prompt, seconds: item.seconds, language: manifest.language, ...(task.signal !== undefined ? { signal: task.signal } : {}) })
      // An effect starts where its sound starts; a loop keeps its length and is eased at both ends.
      const audio = finished(item.kind === 'effect' ? trimSilence(raw, 160, 0.03) : raw, { level: SOUND_LEVEL[item.kind], fadeSeconds: item.kind === 'effect' ? 0.02 : 0.6 })
      if (audio.pcm.length < audio.sampleRate * 0.15) throw new ProviderError('the sound model answered with silence')
      const path = await project.writeAsset(`audio/${script.chapterId}/cue-${item.id}-${item.renderKey.slice(0, 8)}.wav`, encodeWav(audio))
      const seconds = Number(durationOf(audio).toFixed(2))
      total += seconds
      patch = { audio: path, duration: seconds, renderKey: item.renderKey }
    } catch (error) {
      if (task.signal?.aborted === true) throw error
      patch = { error: errorMessage(error) }
      failed.push({ cue: item.id, error: errorMessage(error) })
    }
    // Onto the script as it stands now: lines may have been voiced, or another cue saved, meanwhile.
    const saved = await changeScript(project, script.chapterId, (stored) => {
      const current = withIds(stored)
      return {
        ...current,
        cues: current.cues.map((cue) => {
          if (cue.id !== item.id) return cue
          const { error: _error, ...rest } = cue
          return { ...rest, ...patch }
        }),
      }
    })
    if (saved !== undefined) script = saved
    done += 1
    task.job?.progress(done, todo.length, label())
  }, task.signal)
  const result: SoundResult = { chapterId: script.chapterId, rendered: todo.length - failed.length, kept, skipped, failed, seconds: Number(total.toFixed(1)), model: provider.model }
  task.job?.result({ output: { ...result } })
  return result
}

export type CuePatch = Partial<Pick<AudioCue, 'kind' | 'at' | 'caption' | 'prompt' | 'ambience' | 'intensity'>>

/** Change one cue, or take it out. A changed description leaves the old clip in place until sound is generated again. */
export async function updateCue(runtime: ProjectRuntime, params: { chapter: string; cue: string; patch?: CuePatch; remove?: boolean; dropClip?: boolean }): Promise<AudioScript> {
  const script = await scriptOf(runtime, params.chapter)
  if (!script.cues.some(cue => cue.id === params.cue)) throw new ProjectError('novel/not-found', `the script has no sound cue "${params.cue}"`)
  if (params.patch?.at !== undefined && !script.lines.some(line => line.id === params.patch!.at)) throw new ProjectError('novel/not-found', `the script has no line "${params.patch.at}"`)
  const cues = params.remove === true
    ? script.cues.filter(cue => cue.id !== params.cue)
    : script.cues.map((cue) => {
        if (cue.id !== params.cue) return cue
        const merged: AudioCue = { ...cue, ...params.patch }
        if (merged.caption !== undefined && merged.caption.trim().length === 0) delete merged.caption
        if (merged.prompt !== undefined && merged.prompt.trim().length === 0) delete merged.prompt
        if (merged.intensity !== undefined) merged.intensity = Math.max(0, Math.min(1, merged.intensity))
        if (params.dropClip === true) {
          delete merged.audio
          delete merged.duration
          delete merged.renderKey
          delete merged.error
        }
        return merged
      })
  const next: AudioScript = { ...script, updatedAt: new Date().toISOString(), cues }
  await runtime.project.saveAudioScript(next)
  return next
}

/** Place a new cue by hand. */
export async function addCue(runtime: ProjectRuntime, params: { chapter: string; at: string; kind: SoundKind; caption?: string; prompt?: string; ambience?: AudioCue['ambience']; intensity?: number }): Promise<{ script: AudioScript; cue: AudioCue }> {
  const script = await scriptOf(runtime, params.chapter)
  const index = script.lines.findIndex(line => line.id === params.at)
  if (index < 0) throw new ProjectError('novel/not-found', `the script has no line "${params.at}"`)
  if (params.kind !== 'bed' && (params.caption ?? params.prompt ?? '').trim().length === 0) throw new ProjectError('novel/invalid', 'say what the sound is: give `caption` (what the reader sees) or `prompt` (what the sound model is asked for)')
  let n = script.cues.length
  while (script.cues.some(cue => cue.id === `c${n}`)) n += 1
  const cue: AudioCue = {
    id: `c${n}`,
    at: params.at,
    kind: params.kind,
    ambience: params.kind === 'bed' ? params.ambience ?? 'none' : 'none',
    ...(params.intensity !== undefined ? { intensity: Math.max(0, Math.min(1, params.intensity)) } : {}),
    ...(params.caption !== undefined && params.caption.trim().length > 0 ? { caption: params.caption.trim() } : {}),
    ...(params.prompt !== undefined && params.prompt.trim().length > 0 ? { prompt: params.prompt.trim() } : {}),
  }
  // Kept in the order they are heard.
  const order = new Map(script.lines.map((line, at) => [line.id, at]))
  const cues = [...script.cues, cue].sort((left, right) => (order.get(left.at) ?? 0) - (order.get(right.at) ?? 0))
  const next: AudioScript = { ...script, updatedAt: new Date().toISOString(), cues }
  await runtime.project.saveAudioScript(next)
  return { script: next, cue }
}

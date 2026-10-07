// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The motion comic's screen: the panel that belongs to the line being spoken,
 * moving the way its camera says, with the line as a subtitle and the
 * transport under it. The Studio's stage and the reader served to phones show
 * a chapter's comic through this same screen.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { subtitleOf } from '../../shared/reader'
import type { AudioCue, AudioLine, ComicPanel } from '../../shared/types'
import { Icon } from '../icons'
import type { LinePlayer, PlayerOptions, PlayerState } from '../stage/player'
import { cueCaption, type Translate } from './parts'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

/** How long a line takes: as voiced, or at reading pace while it has no voice. Lines left unspoken take none. */
export const secondsOf = (line: AudioLine | undefined): number => (line?.skip === true ? 0 : line?.duration ?? Math.max(1.2, (line?.text.length ?? 10) * 0.19))

export type TheaterPanel = Pick<ComicPanel, 'id' | 'lines' | 'begin' | 'end' | 'description' | 'camera' | 'image'>

export interface Placed<P extends TheaterPanel = TheaterPanel> {
  panel: P
  /** Where the panel comes on and goes off, as line index plus the fraction of that line. */
  from: number
  to: number
  seconds: number
}

/** Put every panel on the script's line: a panel may begin and end inside a long line. */
export function place<P extends TheaterPanel>(panels: readonly P[], lines: readonly AudioLine[]): Placed<P>[] {
  const indexOf = new Map(lines.map((line, index) => [line.id, index]))
  const placed: Placed<P>[] = []
  for (const panel of panels) {
    const first = indexOf.get(panel.lines[0] ?? '')
    const last = indexOf.get(panel.lines.at(-1) ?? '')
    if (first === undefined || last === undefined) continue
    const from = first + (panel.begin ?? 0)
    const to = last + (panel.end ?? 1)
    let seconds = 0
    for (let index = first; index <= last; index++) {
      const start = index === first ? panel.begin ?? 0 : 0
      const end = index === last ? panel.end ?? 1 : 1
      seconds += secondsOf(lines[index]) * Math.max(0, end - start)
    }
    placed.push({ panel, from, to, seconds })
  }
  return placed
}

/** How far through the line on screen playback is: a picture, and a subtitle, may change in the middle of a long line. */
export function usePlayerFraction(player: LinePlayer, state: PlayerState): number {
  const [fraction, setFraction] = useState(0)
  useEffect(() => {
    setFraction(0)
    if (state.status !== 'playing') return
    const timer = setInterval(() => { setFraction(player.fraction()) }, 160)
    return () => { clearInterval(timer) }
  }, [player, state.index, state.status])
  return fraction
}

/** The panel on screen at the line being played, following the picture through a long line. */
export function useCurrentPanel<P extends TheaterPanel>(placed: Placed<P>[], player: LinePlayer, state: PlayerState): Placed<P> | undefined {
  const fraction = usePlayerFraction(player, state)
  return useMemo(() => {
    if (placed.length === 0) return undefined
    if (state.index < 0) return placed[0]
    const at = state.index + Math.min(0.999, fraction)
    let found = placed[0]
    for (const item of placed) if (item.from <= at + 1e-6) found = item
    return found
  }, [placed, state.index, fraction])
}

export interface TheaterProps {
  t: Translate
  player: LinePlayer
  state: PlayerState
  lines: readonly AudioLine[]
  cues: readonly AudioCue[]
  current: Placed | undefined
  /** Turn a project-relative media path into something an `<img>` can load. */
  media: (path: string) => string
  options: PlayerOptions
  /** Name of the speaker of a line, when the host knows a better one than the script's. */
  speakerOf?: (line: AudioLine) => string | undefined
  /** Controls at the end of the bar. */
  children?: ReactNode
}

export function Theater({ t, player, state, lines, cues, current, media, options, speakerOf, children }: TheaterProps) {
  const stage = useRef<HTMLDivElement>(null)
  const fraction = usePlayerFraction(player, state)
  const line = state.index >= 0 ? lines[state.index] : undefined
  const panelSeconds = Math.max(4, (current?.seconds ?? 8) / options.rate + 1)
  const speaker = line !== undefined && line.kind !== 'narration' ? speakerOf?.(line) ?? line.speakerName : undefined
  const spoken = lines.filter(item => item.skip !== true).length
  const under = cues.filter(cue => cue.kind !== 'effect' && cue.id !== undefined && (state.sounding ?? []).includes(cue.id))
  const bed = under.find(cue => (cue.kind ?? 'bed') === 'bed')
  const caption = options.ambienceOn && bed !== undefined ? cueCaption(bed, t) : undefined

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (document.fullscreenElement !== stage.current) return
      if (event.key === ' ') {
        event.preventDefault()
        player.toggle()
      }
      if (event.key === 'ArrowRight') player.step(1)
      if (event.key === 'ArrowLeft') player.step(-1)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [player])

  const fullscreen = (): void => {
    const element = stage.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null
    if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => {})
    else if (element?.requestFullscreen !== undefined) void element.requestFullscreen().catch(() => {})
    // Phones that only let a video go full screen still give the page its whole width.
    else element?.webkitRequestFullscreen?.()
  }

  return (
    <div className={cx('nv-theater', state.status !== 'idle' && 'is-playing')} ref={stage}>
      <div className="nv-theater-screen" onClick={() => { player.toggle() }}>
        {current?.panel.image !== undefined
          ? <img key={`${current.panel.id}-${state.status === 'idle' ? 'idle' : 'run'}`} className={cx('nv-theater-image', state.status !== 'idle' && `is-${current.panel.camera}`)} style={{ animationDuration: `${panelSeconds}s`, animationPlayState: state.status === 'paused' ? 'paused' : 'running' }} src={media(current.panel.image)} alt={current.panel.description} />
          : <div className="nv-theater-placeholder"><p>{current?.panel.description}</p><span className="nv-muted nv-small">{t('这一格还没有画', 'This panel is not drawn yet')}</span></div>}
        {caption !== undefined && state.status !== 'idle' ? <div className="nv-theater-caption">≋ {caption}</div> : null}
        {line !== undefined ? (
          <div className={cx('nv-subtitle', `is-${line.kind}`)}>
            {speaker !== undefined ? <span className="nv-subtitle-speaker">{speaker}</span> : null}
            <span>{subtitleOf(line.text, fraction)}</span>
          </div>
        ) : state.status === 'idle' ? <div className="nv-theater-start"><span className="nv-theater-play">▶</span></div> : null}
      </div>
      <div className="nv-theater-bar">
        <button type="button" className="nv-btn nv-btn-primary nv-btn-sm nv-btn-icon" onClick={() => { player.toggle() }} title={state.status === 'playing' ? t('暂停', 'Pause') : t('播放', 'Play')}><Icon name={state.status === 'playing' ? 'pause' : 'play'} size={15} /></button>
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" disabled={state.index <= 0} onClick={() => { player.step(-1) }} title={t('上一句', 'Previous line')}><Icon name="chevronLeft" size={15} /></button>
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" disabled={state.index < 0 || state.index >= lines.length - 1} onClick={() => { player.step(1) }} title={t('下一句', 'Next line')}><Icon name="chevronRight" size={15} /></button>
        <div className="nv-theater-progress"><div style={{ width: `${spoken > 0 ? ((lines.slice(0, state.index + 1).filter(item => item.skip !== true).length) / spoken) * 100 : 0}%` }} /></div>
        {children}
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" onClick={fullscreen} title={t('全屏', 'Fullscreen')}><Icon name="maximize" size={15} /></button>
      </div>
    </div>
  )
}

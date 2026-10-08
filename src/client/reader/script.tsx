// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter as its script: who says what, how, and over which sound, a line
 * each — to be followed while it is listened to. Any line starts the voice
 * from there; the one being spoken is marked, and the mark under it runs at
 * the pace of the voice.
 *
 * This is the script as a reader has it. The Studio's own table of takes,
 * with the tools to change a line or a sound, is another thing
 * (`stage/Audio.tsx`) and comes when the author asks to produce.
 *
 *   ScriptPage     the page
 *   chapterFigures where the chapter's pictures stand among the script's lines
 */
import type { ReactNode, RefObject } from 'react'
import { alignScript, blocksOf } from '../../shared/reader'
import type { AudioCue, AudioLine } from '../../shared/types'
import { Icon } from '../icons'
import type { LinePlayer, PlayerState } from '../stage/player'
import { cueCaption, formatDuration, type Translate } from './parts'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

const SOUND_KIND: Record<NonNullable<AudioCue['kind']>, [string, string]> = {
  bed: ['环境声', 'Ambience'],
  effect: ['音效', 'Effect'],
  music: ['配乐', 'Music'],
}
const SOUND_MARK: Record<NonNullable<AudioCue['kind']>, string> = { bed: '≋', effect: '◦', music: '♪' }

export interface Figures {
  /** Pictures that stand before a line, by the line's id. */
  before: ReadonlyMap<string, { path: string; alt: string }[]>
  /** Pictures after the last line. */
  after: { path: string; alt: string }[]
}

/**
 * The pictures of a chapter, each before the script line that follows it in
 * the text — so that the script has them where the prose does.
 */
export function chapterFigures(text: string | undefined, lines: readonly Pick<AudioLine, 'id' | 'text'>[]): Figures {
  const before = new Map<string, { path: string; alt: string }[]>()
  const after: { path: string; alt: string }[] = []
  if (text === undefined || lines.length === 0) return { before, after }
  const images = blocksOf(text).filter((block): block is Extract<ReturnType<typeof blocksOf>[number], { kind: 'image' }> => block.kind === 'image')
  if (images.length === 0) return { before, after }
  const ranges = alignScript(text, lines)
  for (const image of images) {
    const next = lines.find(line => (ranges.get(line.id)?.start ?? -1) >= image.offset)
    if (next === undefined) after.push({ path: image.path, alt: image.alt })
    else before.set(next.id, [...(before.get(next.id) ?? []), { path: image.path, alt: image.alt }])
  }
  return { before, after }
}

export interface ScriptPageProps {
  t: Translate
  lines: readonly AudioLine[]
  cues: readonly AudioCue[]
  state: PlayerState
  player: LinePlayer
  /** How long the line being spoken takes as it is played, and whether the voice is held. */
  pace?: { seconds: number; paused: boolean } | undefined
  figures?: Figures | undefined
  media: (path: string) => string
  /** The name a line's speaker goes by; the name written in the script when left out. */
  speakerOf?: ((line: AudioLine) => string | undefined) | undefined
  scroller: RefObject<HTMLDivElement | null>
  /** The reader's type: the script is set in it, a little smaller than the prose. */
  prefs?: { size: number; serif: boolean } | undefined
  /** Above the lines: the chapter's title. */
  header?: ReactNode
  /** After the lines: the way to the next chapter. */
  footer?: ReactNode
}

export function ScriptPage({ t, lines, cues, state, player, pace, figures, media, speakerOf, scroller, prefs, header, footer }: ScriptPageProps) {
  const cuesAt = new Map<string, AudioCue[]>()
  for (const cue of cues) cuesAt.set(cue.at, [...(cuesAt.get(cue.at) ?? []), cue])
  const live = new Set(state.sounding ?? [])
  const figure = (picture: { path: string; alt: string }): ReactNode => (
    <figure key={picture.path} className="nv-figure nv-line-figure">
      <img loading="lazy" src={media(picture.path)} alt={picture.alt} />
      {picture.alt.length > 0 ? <figcaption>{picture.alt}</figcaption> : null}
    </figure>
  )
  return (
    <div className="nv-reader-scroll" ref={scroller as RefObject<HTMLDivElement>}>
      <div className={cx('nv-script-wrap nv-script-page', prefs?.serif === true && 'is-serif')} style={prefs !== undefined ? { fontSize: Math.max(13, prefs.size - 2) } : undefined}>
        {header}
        <ol className="nv-script">
          {lines.map((line, index) => {
            const current = index === state.index
            const skipped = line.skip === true
            const speaker = line.kind === 'narration' ? t('旁白', 'Narrator') : speakerOf?.(line) ?? line.speakerName ?? t('未指定', 'unassigned')
            return (
              <li
                key={line.id}
                data-script-line={line.id}
                className={cx('nv-line', `is-${line.kind}`, current && 'is-current', current && pace?.paused === true && 'is-held', skipped && 'is-skipped')}
                style={current && pace !== undefined ? { ['--nv-say' as string]: `${pace.seconds.toFixed(2)}s` } : undefined}
              >
                {(figures?.before.get(line.id) ?? []).map(figure)}
                {(cuesAt.get(line.id) ?? []).map((cue) => {
                  const kind = cue.kind ?? 'bed'
                  const caption = cueCaption(cue, t)
                  if (caption === undefined) return null
                  return (
                    <div key={cue.id ?? `${cue.at}-${kind}`} className={cx('nv-cue', `is-${kind}`, cue.id !== undefined && live.has(cue.id) && 'is-sounding')}>
                      <span className="nv-cue-mark" aria-hidden="true">{SOUND_MARK[kind]}</span>
                      <span className="nv-cue-kind">{t(...SOUND_KIND[kind])}</span>
                      <span className="nv-cue-text">{caption}</span>
                    </div>
                  )
                })}
                <div className="nv-line-row">
                  <button type="button" className="nv-line-play" disabled={skipped} onClick={() => { if (current && state.status === 'playing') player.pause(); else player.play(index) }} title={skipped ? t('这一行不念', 'This line is not spoken') : t('从这一句开始听', 'Listen from this line')} aria-label={t('从这一句开始听', 'Listen from this line')}>
                    <Icon name={current && state.status === 'playing' ? 'pause' : 'play'} size={12} />
                  </button>
                  <div className="nv-line-body">
                    <div className="nv-line-meta">
                      <span className="nv-line-speaker">{speaker}{line.kind === 'thought' ? t('（心声）', ' (thought)') : ''}</span>
                      {line.direction !== undefined ? <span className="nv-line-direction">{line.direction}</span> : null}
                      {line.audio !== undefined && line.duration !== undefined ? <span className="nv-muted nv-small">{formatDuration(line.duration)}</span> : null}
                    </div>
                    <p>{line.text}</p>
                  </div>
                </div>
              </li>
            )
          })}
          {(figures?.after ?? []).length > 0 ? <li className="nv-line">{figures!.after.map(figure)}</li> : null}
        </ol>
        {footer !== undefined ? <footer className="nv-reader-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

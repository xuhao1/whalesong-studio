// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter being listened to and watched, whatever page shows it.
 *
 * The Studio's viewer and the reader on other devices each lay a chapter out
 * with their own things around it — notes and a production desk here, a way
 * to edit and the lock screen's buttons there — but what plays, and how the
 * page behaves while it plays, is one thing and is said once, here:
 *
 *   - the player of the chapter's script, and the picture that goes with the
 *     line being spoken;
 *   - pressing play over the prose turns the page to the script, unless the
 *     reader would rather stay;
 *   - in the script the line being spoken stays in sight;
 *   - a chapter that ran out goes on to the next, which starts by itself
 *     once it has arrived.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { AudioCue, AudioLine } from '../../shared/types'
import { useLinePlayer, type LinePlayer, type PlayerOptions, type PlayerState } from '../stage/player'
import { chapterFigures, type Figures } from './script'
import { secondsOf, useCurrentPanel, type Placed, type TheaterPanel } from './theater'

export interface ChapterPlaybackInput<P extends TheaterPanel> {
  /** The chapter shown, by id. */
  chapter: string | undefined
  /** Its prose and its script, as far as they have arrived; its storyboard laid along the script (`place`). */
  text: string | undefined
  lines: AudioLine[]
  cues: AudioCue[]
  placed: Placed<P>[]
  /** Whether it has a script at all: without one there is nothing to turn the page to. */
  scripted: boolean
  /** Whether what is loaded is this chapter's: a chapter gone on to starts playing once it is. */
  arrived: boolean
  /** The URL of one of the book's own files; the same function from render to render. */
  media: (path: string, version?: string | number) => string
  options: PlayerOptions
  /** The face the chapter is shown under. */
  mode: 'read' | 'listen' | 'watch'
  /** Whether pressing play over the prose turns the page to the script. */
  follow: boolean
  toScript: () => void
  /** Go to the chapter after this one, when it has run out; absent where there is none, or the listener would rather not go on. */
  onward: (() => void) | undefined
  /** What the page scrolls in. */
  scroller: RefObject<HTMLElement | null>
}

export interface ChapterPlayback<P extends TheaterPanel> {
  player: LinePlayer
  state: PlayerState
  /** The picture that goes with the line being spoken. */
  current: Placed<P> | undefined
  /** The player has been started on this chapter: from then on the prose shows which line is spoken, and a line can be pressed to hear from there. */
  engaged: boolean
  /** How long the line being spoken takes at the speed it is played: what the mark that runs through it goes by. */
  pace: { seconds: number; paused: boolean }
  /** The pictures of the chapter, each before the script line that follows it in the text — so that the script has them where the prose does. */
  figures: Figures
}

export function useChapterPlayback<P extends TheaterPanel>(input: ChapterPlaybackInput<P>): ChapterPlayback<P> {
  const { chapter, text, lines, cues, placed, scripted, arrived, media, options, mode, follow, toScript, onward, scroller } = input
  // A chapter that ran out, and the one gone on to from it.
  const carry = useRef<{ from: string | undefined; to?: string | undefined } | undefined>(undefined)
  const { player, state } = useLinePlayer(lines, cues, media, options, () => {
    if (onward === undefined) return
    carry.current = { from: chapter }
    onward()
  })
  const current = useCurrentPanel(placed, player, state)
  const engaged = state.index >= 0
  const pace = useMemo(() => ({ seconds: secondsOf(lines[state.index]) / Math.max(0.25, options.rate), paused: state.status === 'paused' }), [lines, state.index, state.status, options.rate])
  const figures = useMemo(() => chapterFigures(text, lines), [text, lines])

  // Pressing play over the prose turns the page to the script — unless the reader would rather stay.
  const wasIdle = useRef(true)
  useEffect(() => {
    const starting = wasIdle.current && state.status === 'playing'
    wasIdle.current = state.status === 'idle'
    if (starting && mode === 'read' && follow && scripted) toScript()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status])

  // In the script the line being spoken stays in sight.
  useEffect(() => {
    if (mode !== 'listen' || state.index < 0) return
    scroller.current?.querySelector(`[data-script-line="${lines[state.index]?.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.index, mode, lines])

  // The chapter that follows one that ran out starts by itself, once it has arrived. It is that chapter and no other:
  // one with nothing to play, left for a third, does not make the third start by itself.
  useEffect(() => {
    const going = carry.current
    if (going === undefined || chapter === going.from) return
    if (going.to === undefined) going.to = chapter
    else if (going.to !== chapter) {
      carry.current = undefined
      return
    }
    if (!arrived) return
    carry.current = undefined
    if (lines.some(line => line.audio !== undefined)) player.play(0)
  }, [chapter, arrived, lines, player])

  return { player, state, current, engaged, pace, figures }
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Side stories: interludes the author kept, read as what they are — a scene
 * that happened beside the book. An interlude is played with the models on
 * the author's computer; kept as a side story it is a finished text, and that
 * is what a reader is given: the list of them, and each as a transcript.
 *
 *   SideList        the side stories of a book, each a way in
 *   PlayTranscript  one interlude as it went: the situation, and turn by turn
 *                   what was said and done — shared by the page where it is
 *                   played and the page where it is only read
 */
import type { ReactNode } from 'react'
import type { PlayTurn } from '../../shared/types'
import { Icon } from '../icons'
import type { Translate } from './parts'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

/** A side story as a list shows it. */
export interface SideRef {
  id: string
  title: string
  turns: number
  /** Where the scene opens, in a line. */
  situation?: string
}

/** An interlude as it is read. */
export interface SidePlay {
  id: string
  title: string
  situation: string
  location?: string
  turns: PlayTurn[]
}

export function SideList({ t, sides, onOpen }: { t: Translate; sides: SideRef[]; onOpen: (id: string) => void }) {
  return (
    <div className="nv-sides">
      <header className="nv-explore-top">
        <div>
          <h2>{t('番外', 'Side stories')}</h2>
          <p className="nv-muted">{t('从正文岔出去的几场戏：没有写进正文，作者把它们留了下来。', 'Scenes that branch off the book: not part of its text, and kept by the author.')}</p>
        </div>
      </header>
      <ol className="nv-sides-list">
        {sides.map(side => (
          <li key={side.id}>
            <button type="button" className="nv-side" onClick={() => { onOpen(side.id) }}>
              <span className="nv-side-mark" aria-hidden="true"><Icon name="gamepad" size={15} /></span>
              <span className="nv-side-words">
                <strong>{side.title}</strong>
                {side.situation !== undefined ? <span>{side.situation}</span> : null}
              </span>
              <span className="nv-side-turns">{t(`${side.turns} 回合`, `${side.turns} turns`)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * An interlude as it went. Whoever plays it puts what is still being answered
 * after the turns (`children`); whoever only reads it has nothing to add.
 * @param media - the URL of one of the book's own files: the picture a scene is set before.
 */
export function PlayTranscript({ t, play, media, children }: { t: Translate; play: SidePlay; media: (path: string) => string; children?: ReactNode }) {
  const background = [...play.turns].reverse().find(turn => turn.scene?.background !== undefined)?.scene?.background
  const over = play.turns.at(-1)?.ended === true
  return (
    <div className="nr-play-scroll" style={background !== undefined ? { backgroundImage: `linear-gradient(color-mix(in srgb, var(--nv-bg) 86%, transparent), color-mix(in srgb, var(--nv-bg) 94%, transparent)), url("${media(background)}")` } : undefined}>
      <p className="nr-play-situation">{play.situation}</p>
      {play.turns.map(turn => (
        <div key={turn.id} className="nr-play-turn">
          {turn.input !== undefined ? <p className={cx('nr-play-input', `is-${turn.input.kind}`)}>{turn.input.kind === 'do' ? t('（你）', '(you) ') : turn.input.kind === 'direct' ? t('（指挥）', '(direction) ') : ''}{turn.input.text}</p> : null}
          {turn.scene?.location !== undefined || turn.scene?.time !== undefined ? <p className="nr-play-scene">{[turn.scene.location, turn.scene.time, turn.scene.mood].filter(Boolean).join(' · ')}</p> : null}
          {turn.narration !== undefined && turn.narration.length > 0 ? turn.narration.split('\n').filter(paragraph => paragraph.trim().length > 0).map((paragraph, index) => <p key={index} className="nr-play-narration">{paragraph}</p>) : null}
          {turn.lines.map((line, index) => (
            <p key={index} className="nr-play-line">
              <span className="nr-play-speaker">{line.speaker}</span>
              {line.action !== undefined && line.action.length > 0 ? <span className="nr-play-action">（{line.action}）</span> : null}
              <span>{line.text}</span>
            </p>
          ))}
        </div>
      ))}
      {children}
      {over ? <p className="nr-play-over">{t('—— 这场戏落幕了 ——', '— the scene has ended —')}</p> : null}
    </div>
  )
}

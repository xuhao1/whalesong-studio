// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The reader's parts: one chapter shown two ways — to be read, or to be
 * listened to with the line being spoken marked in the prose. The Studio's
 * reader and the one served to phones are both assembled from these, so what
 * the author sees beside the conversation is what a reader gets on the sofa.
 *
 * Nothing here talks to the Studio's controller: whoever uses a part hands it
 * the text, the script and a way to turn a media path into a URL.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { alignScript, blocksOf, segmentsOf, type Block } from '../../shared/reader'
import { countWords, proseOnly } from '../../shared/text'
import type { AudioLine } from '../../shared/types'
import { Icon } from '../icons'
import { AMBIENCE } from '../labels'
import type { LinePlayer, PlayerOptions, PlayerState } from '../stage/player'

export type Translate = (zh: string, en: string) => string
export type ReadMode = 'read' | 'listen'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

// ───────────────────────────── preferences ─────────────────────────────

export interface ReaderPrefs {
  size: number
  theme: 'auto' | 'paper' | 'night'
  serif: boolean
}

const PREFS_KEY = 'novel-studio:reader'
const DEFAULT_PREFS: ReaderPrefs = { size: 18, theme: 'auto', serif: true }

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback
  } catch {
    // Private windows and blocked storage fall back to defaults.
    return fallback
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Kept for this visit only.
  }
}

/** Type size, paper and typeface, remembered on this device. */
export function useReaderPrefs(): [ReaderPrefs, (patch: Partial<ReaderPrefs>) => void] {
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => stored(PREFS_KEY, DEFAULT_PREFS))
  const update = (patch: Partial<ReaderPrefs>): void => {
    setPrefs((previous) => {
      const next = { ...previous, ...patch }
      store(PREFS_KEY, next)
      return next
    })
  }
  return [prefs, update]
}

/** Player preferences survive between chapters and visits. */
export function usePlayerOptions(): [PlayerOptions, (patch: Partial<PlayerOptions>) => void] {
  const [options, setOptions] = useState<PlayerOptions>(() => stored('novel-studio:player', { rate: 1, voiceVolume: 1, ambienceVolume: 0.45, ambienceOn: true }))
  const update = (patch: Partial<PlayerOptions>): void => {
    setOptions((previous) => {
      const next = { ...previous, ...patch }
      store('novel-studio:player', next)
      return next
    })
  }
  return [options, update]
}

export function PrefsControls({ prefs, update, t }: { prefs: ReaderPrefs; update: (patch: Partial<ReaderPrefs>) => void; t: Translate }) {
  return (
    <>
      <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { update({ size: Math.max(14, prefs.size - 1) }) }} title={t('缩小字号', 'Smaller text')}><span>A−</span></button>
      <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { update({ size: Math.min(30, prefs.size + 1) }) }} title={t('放大字号', 'Larger text')}><span>A+</span></button>
      <button type="button" className={cx('nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon', prefs.serif && 'is-active')} onClick={() => { update({ serif: !prefs.serif }) }} title={t('衬线 / 无衬线', 'Serif / sans')}><Icon name="type" size={14} /></button>
      <select className="nv-input nv-select" value={prefs.theme} onChange={(event) => { update({ theme: event.target.value as ReaderPrefs['theme'] }) }} aria-label={t('纸张', 'Paper')}>
        <option value="auto">{t('跟随主题', 'App theme')}</option>
        <option value="paper">{t('纸张', 'Paper')}</option>
        <option value="night">{t('夜间', 'Night')}</option>
      </select>
    </>
  )
}

/** The switch between reading the chapter and listening to it. */
export function ModeSwitch({ mode, onChange, t }: { mode: ReadMode; onChange: (mode: ReadMode) => void; t: Translate }) {
  return (
    <div className="nv-modes" role="tablist" aria-label={t('阅读方式', 'How to take in the chapter')}>
      <button type="button" role="tab" aria-selected={mode === 'read'} className={cx('nv-mode', mode === 'read' && 'is-active')} onClick={() => { onChange('read') }}>
        <Icon name="eye" size={14} />
        <span>{t('看', 'Read')}</span>
      </button>
      <button type="button" role="tab" aria-selected={mode === 'listen'} className={cx('nv-mode', mode === 'listen' && 'is-active')} onClick={() => { onChange('listen') }}>
        <Icon name="headphones" size={14} />
        <span>{t('听', 'Listen')}</span>
      </button>
    </div>
  )
}

// ───────────────────────────── the page ─────────────────────────────

export interface ReaderPageProps {
  t: Translate
  bookTitle: string
  chapter: { index: number; title: string }
  /** The chapter's text; `undefined` while it is being fetched. */
  text: string | undefined
  prefs: ReaderPrefs
  /** Turn a project-relative media path into something an `<img>` can load. */
  media: (path: string) => string
  /** Listening: the script whose lines are marked in the prose. */
  lines?: readonly AudioLine[] | undefined
  /** Listening: index of the line being spoken, -1 when nothing plays. */
  active?: number | undefined
  /** Listening: a line of the prose was pressed. */
  onLine?: ((index: number) => void) | undefined
  /** Offset of a paragraph to flash (a search hit). */
  flash?: number | undefined
  scroller: RefObject<HTMLDivElement | null>
  /** What follows the text: the way to the next chapter. */
  footer?: ReactNode
  /** Laid over the page: the tools for a selection. */
  children?: ReactNode
  onSelect?: (() => void) | undefined
}

/** One chapter on the page. In listening mode every sentence of the prose can be pressed, and the one being spoken is lit. */
export function ReaderPage({ t, bookTitle, chapter, text, prefs, media, lines, active, onLine, flash, scroller, footer, children, onSelect }: ReaderPageProps) {
  const blocks = useMemo<Block[]>(() => (text !== undefined ? blocksOf(text) : []), [text])
  const ranges = useMemo(() => {
    if (text === undefined || lines === undefined || lines.length === 0) return []
    const found = alignScript(text, lines)
    return lines.flatMap((line, index) => {
      const range = found.get(line.id)
      return range !== undefined ? [{ id: line.id, index, start: range.start, end: range.end }] : []
    }).sort((left, right) => left.start - right.start)
  }, [text, lines])
  const indexOf = useMemo(() => new Map(ranges.map(range => [range.id, range.index])), [ranges])
  const activeId = active !== undefined && active >= 0 ? lines?.[active]?.id : undefined
  const voiced = useMemo(() => new Set((lines ?? []).filter(line => line.audio !== undefined).map(line => line.id)), [lines])
  // Lines without a voice are only worth telling apart once some have one.
  const partly = voiced.size > 0 && voiced.size < (lines?.length ?? 0)
  // The line being spoken stays in view; the reader's own scrolling is left alone otherwise.
  useEffect(() => {
    if (activeId === undefined) return
    const element = scroller.current?.querySelector<HTMLElement>(`[data-line="${activeId}"]`)
    if (element === null || element === undefined) return
    const box = scroller.current!.getBoundingClientRect()
    const at = element.getBoundingClientRect()
    if (at.top < box.top + box.height * 0.18 || at.bottom > box.top + box.height * 0.72) {
      scroller.current!.scrollBy({ top: at.top - box.top - box.height * 0.35, behavior: 'smooth' })
    }
  }, [activeId, scroller])
  const listening = lines !== undefined && onLine !== undefined
  return (
    <div className="nv-reader-scroll" ref={scroller as RefObject<HTMLDivElement>} onMouseUp={onSelect} onKeyUp={onSelect}>
      <article className={cx('nv-reader-page', prefs.serif && 'is-serif', listening && 'is-listening')} style={{ fontSize: prefs.size }}>
        <header className="nv-reader-head">
          <span className="nv-reader-kicker">{bookTitle} · {t(`第 ${chapter.index} 章`, `Chapter ${chapter.index}`)}</span>
          <h1>{chapter.title}</h1>
        </header>
        {text === undefined ? <div className="nv-center"><span className="nv-spinner" style={{ width: 18, height: 18 }} aria-hidden="true" /></div> : blocks.map((block) => {
          if (block.kind === 'image') {
            return (
              <figure key={block.offset} data-offset={block.offset} className="nv-figure">
                <img alt={block.alt} loading="lazy" src={media(block.path)} />
                {block.alt.length > 0 ? <figcaption>{block.alt}</figcaption> : null}
              </figure>
            )
          }
          if (block.kind === 'break') return <div key={block.offset} data-offset={block.offset} className="nv-scene-break" aria-hidden="true">＊　＊　＊</div>
          if (block.kind === 'heading') return <h3 key={block.offset} data-offset={block.offset}>{block.text}</h3>
          if (!listening || ranges.length === 0) return <p key={block.offset} data-offset={block.offset} className={cx(flash === block.offset && 'is-flash')}>{block.text}</p>
          return (
            <p key={block.offset} data-offset={block.offset} className={cx(flash === block.offset && 'is-flash')}>
              {segmentsOf(block, ranges).map((segment, at) => segment.line === undefined
                ? <span key={at}>{segment.text}</span>
                : (
                    <span
                      key={at}
                      data-line={segment.line}
                      className={cx('nv-said', segment.line === activeId && 'is-speaking', partly && !voiced.has(segment.line) && 'is-unvoiced')}
                      onClick={() => {
                        // A selection is being made, not a line chosen.
                        if ((window.getSelection()?.toString().length ?? 0) > 0) return
                        const index = indexOf.get(segment.line!)
                        if (index !== undefined) onLine(index)
                      }}
                    >{segment.text}</span>
                  ))}
            </p>
          )
        })}
        {text !== undefined ? (
          <footer className="nv-reader-foot">
            <span className="nv-muted nv-small">{countWords(proseOnly(text))}{t(' 字', ' words')}</span>
            {footer}
          </footer>
        ) : null}
      </article>
      {children}
    </div>
  )
}

// ───────────────────────────── listening ─────────────────────────────

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** Where each line starts on the chapter's clock, counting the lines without a voice at reading pace. */
function timeline(lines: readonly AudioLine[]): { starts: number[]; total: number } {
  const starts: number[] = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.duration ?? Math.max(1.2, line.text.length * 0.19)
  }
  return { starts, total: at }
}

export interface ListenBarProps {
  t: Translate
  player: LinePlayer
  state: PlayerState
  lines: readonly AudioLine[]
  options: PlayerOptions
  update: (patch: Partial<PlayerOptions>) => void
  /** Go on to the next chapter when this one ends. */
  autoNext?: boolean | undefined
  onAutoNext?: ((value: boolean) => void) | undefined
  /** Extra controls at the end of the bar. */
  children?: ReactNode
}

/**
 * The transport: play and pause, a line back and forward, where the chapter
 * is, how fast it is read and how loud the ambience is. It sits under the
 * page, where a thumb reaches it.
 */
export function ListenBar({ t, player, state, lines, options, update, autoNext, onAutoNext, children }: ListenBarProps) {
  const clock = useMemo(() => timeline(lines), [lines])
  const voiced = lines.filter(line => line.audio !== undefined).length
  const [more, setMore] = useState(false)
  const at = state.index >= 0 ? clock.starts[state.index] ?? 0 : 0
  const playing = state.status === 'playing'
  const bar = useRef<HTMLDivElement>(null)
  const seek = (clientX: number): void => {
    const box = bar.current?.getBoundingClientRect()
    if (box === undefined || box.width === 0 || lines.length === 0) return
    const wanted = Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * clock.total
    let index = 0
    for (let candidate = 0; candidate < clock.starts.length; candidate++) if (clock.starts[candidate]! <= wanted) index = candidate
    player.play(index)
  }
  return (
    <div className="nv-listenbar">
      <div className="nv-listen-progress" ref={bar} onClick={(event) => { seek(event.clientX) }} role="slider" aria-label={t('播放进度', 'Position')} aria-valuemin={0} aria-valuemax={lines.length} aria-valuenow={Math.max(0, state.index + 1)} tabIndex={-1}>
        <div style={{ width: `${clock.total > 0 && state.index >= 0 ? (at / clock.total) * 100 : 0}%` }} />
      </div>
      <div className="nv-listen-row">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" disabled={state.index <= 0} onClick={() => { player.step(-1) }} title={t('上一句', 'Previous line')}><Icon name="chevronLeft" size={16} /></button>
        <button type="button" className="nv-btn nv-btn-primary nv-listen-play" disabled={lines.length === 0} onClick={() => { player.toggle() }} title={playing ? t('暂停', 'Pause') : t('播放', 'Play')}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" disabled={state.index < 0 || state.index >= lines.length - 1} onClick={() => { player.step(1) }} title={t('下一句', 'Next line')}><Icon name="chevronRight" size={16} /></button>
        <span className="nv-listen-time">
          {state.index >= 0 ? `${formatDuration(at)} / ${formatDuration(clock.total)}` : formatDuration(clock.total)}
        </span>
        {state.ambience !== 'none' ? <span className="nv-chip nv-chip-violet nv-listen-ambience">♪ {t(...AMBIENCE[state.ambience])}</span> : null}
        {voiced < lines.length ? <span className="nv-muted nv-small nv-listen-note">{voiced === 0 ? t('还没有配音：按阅读速度逐句显示', 'Not voiced yet: lines are shown at reading pace') : t(`${lines.length - voiced} 句还没有配音，到那里会静默显示`, `${lines.length - voiced} lines are not voiced yet and pass in silence`)}</span> : null}
        <span className="nv-spacer" />
        {children}
        <button type="button" className={cx('nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon', more && 'is-active')} onClick={() => { setMore(value => !value) }} title={t('语速、环境音、连播', 'Speed, ambience, continuous play')} aria-expanded={more}><Icon name="settings" size={15} /></button>
      </div>
      {more ? (
        <div className="nv-listen-more">
          <label className="nv-listen-option">
            <span>{t('语速', 'Speed')}</span>
            <select className="nv-input nv-select" value={String(options.rate)} onChange={(event) => { update({ rate: Number(event.target.value) }) }}>
              {['0.8', '1', '1.15', '1.3', '1.5', '1.8'].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
            </select>
          </label>
          <label className="nv-listen-option" title={t('环境音由浏览器实时合成', 'Ambience is synthesized live in the browser')}>
            <input type="checkbox" checked={options.ambienceOn} onChange={(event) => { update({ ambienceOn: event.target.checked }) }} />
            <span>{t('环境音', 'Ambience')}</span>
            <input className="nv-range" type="range" min={0} max={1} step={0.05} value={options.ambienceVolume} disabled={!options.ambienceOn} onChange={(event) => { update({ ambienceVolume: Number(event.target.value) }) }} aria-label={t('环境音音量', 'Ambience volume')} />
          </label>
          {onAutoNext !== undefined ? (
            <label className="nv-listen-option">
              <input type="checkbox" checked={autoNext === true} onChange={(event) => { onAutoNext(event.target.checked) }} />
              <span>{t('一章听完接着听下一章', 'Go on to the next chapter')}</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

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
import type { AudioCue, AudioLine } from '../../shared/types'
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
  /** Show what is heard beside the text — the room, a door, the music — for the eye as well as the ear. */
  notes: boolean
  /** Pressing play over the prose turns the page to the script, where who says what is laid out line by line. Left out: it does. */
  follow?: boolean
}

const PREFS_KEY = 'novel-studio:reader'
const PLAYER_KEY = 'novel-studio:player'
const DEFAULT_PREFS: ReaderPrefs = { size: 18, theme: 'auto', serif: true, notes: true }
const DEFAULT_OPTIONS: PlayerOptions = { rate: 1, voiceVolume: 1, ambienceVolume: 0.45, ambienceOn: true }

/** What this page opens with before whoever reads has set anything: a published site's are its author's own settings. */
let opening: { prefs: Partial<ReaderPrefs>; options: Partial<PlayerOptions> } = { prefs: {}, options: {} }

/** Have the reader open the way a site's author reads; what a visitor then sets is theirs and stays. */
export function setReaderDefaults(defaults: { prefs?: Partial<ReaderPrefs>; options?: Partial<PlayerOptions> } | undefined): void {
  opening = { prefs: defaults?.prefs ?? {}, options: defaults?.options ?? {} }
}

/** How this device reads right now: what a site published from here opens with for others. */
export function readerSettings(): { prefs: ReaderPrefs; options: PlayerOptions } {
  return { prefs: stored(PREFS_KEY, DEFAULT_PREFS), options: stored(PLAYER_KEY, DEFAULT_OPTIONS) }
}

/** What a sound cue says to a reader: its caption, or for a plain bed the name of its preset. */
export function cueCaption(cue: AudioCue, t: Translate): string | undefined {
  const text = (cue.caption ?? cue.note)?.trim()
  if (text !== undefined && text.length > 0) return text
  return (cue.kind ?? 'bed') === 'bed' && cue.ambience !== 'none' ? t(...AMBIENCE[cue.ambience]) : undefined
}

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
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => stored(PREFS_KEY, { ...DEFAULT_PREFS, ...opening.prefs }))
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
  const [options, setOptions] = useState<PlayerOptions>(() => stored(PLAYER_KEY, { ...DEFAULT_OPTIONS, ...opening.options }))
  const update = (patch: Partial<PlayerOptions>): void => {
    setOptions((previous) => {
      const next = { ...previous, ...patch }
      store(PLAYER_KEY, next)
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
      <button type="button" className={cx('nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon', prefs.notes && 'is-active')} onClick={() => { update({ notes: !prefs.notes }) }} title={t('声音注释：在正文旁边标出这里听得到什么（环境、音效、配乐）', 'Sound notes: mark beside the text what is heard here (the room, effects, music)')} aria-pressed={prefs.notes}><Icon name="volume" size={14} /></button>
      <select className="nv-input nv-select" value={prefs.theme} onChange={(event) => { update({ theme: event.target.value as ReaderPrefs['theme'] }) }} aria-label={t('纸张', 'Paper')}>
        <option value="auto">{t('跟随主题', 'App theme')}</option>
        <option value="paper">{t('纸张', 'Paper')}</option>
        <option value="night">{t('夜间', 'Night')}</option>
      </select>
    </>
  )
}

/**
 * How a chapter is read and heard, in one panel — the same wherever the
 * reader is: in the Studio, on a phone, on a published site, and on the
 * Studio's settings page. What is set here belongs to whoever is reading and
 * to the device they read on, and is kept there.
 *
 * What is reached for often is in sight: the size of the type, the paper, the
 * typeface, the speed of the voice. The rest is one press further.
 * @param extra - options of the host's own (the Studio's notes of a review), shown with the rest.
 */
export function ReaderSettings({ prefs, update, options, updateOptions, t, extra, onClose }: {
  prefs: ReaderPrefs
  update: (patch: Partial<ReaderPrefs>) => void
  options: PlayerOptions
  updateOptions: (patch: Partial<PlayerOptions>) => void
  t: Translate
  extra?: ReactNode
  /** Given, the panel is laid over the page and can be put away; left out, it stands where it is put. */
  onClose?: (() => void) | undefined
}) {
  const [more, setMore] = useState(false)
  const panel = (
    <div className={cx('nv-reader-settings', onClose !== undefined && 'is-floating')} role="dialog" aria-label={t('阅读设置', 'Reading settings')}>
      <div className="nv-reader-settings-row">
        <span className="nv-reader-settings-label">{t('字号', 'Type size')}</span>
        <div className="nv-reader-settings-size">
          <button type="button" className="nv-btn nv-btn-outline nv-btn-sm" onClick={() => { update({ size: Math.max(14, prefs.size - 1) }) }} aria-label={t('缩小字号', 'Smaller text')}><span>A−</span></button>
          <span className="nv-reader-settings-value">{prefs.size}</span>
          <button type="button" className="nv-btn nv-btn-outline nv-btn-sm" onClick={() => { update({ size: Math.min(30, prefs.size + 1) }) }} aria-label={t('放大字号', 'Larger text')}><span>A+</span></button>
        </div>
      </div>
      <div className="nv-reader-settings-row">
        <span className="nv-reader-settings-label">{t('纸张', 'Paper')}</span>
        <div className="nv-seg" role="group">
          {([['auto', '跟随主题', 'App theme'], ['paper', '纸张', 'Paper'], ['night', '夜间', 'Night']] as const).map(([value, zh, en]) => (
            <button key={value} type="button" className={cx(prefs.theme === value && 'is-active')} onClick={() => { update({ theme: value }) }}>{t(zh, en)}</button>
          ))}
        </div>
      </div>
      <div className="nv-reader-settings-row">
        <span className="nv-reader-settings-label">{t('字体', 'Typeface')}</span>
        <div className="nv-seg" role="group">
          <button type="button" className={cx(prefs.serif && 'is-active')} onClick={() => { update({ serif: true }) }}>{t('宋体 / 衬线', 'Serif')}</button>
          <button type="button" className={cx(!prefs.serif && 'is-active')} onClick={() => { update({ serif: false }) }}>{t('黑体 / 无衬线', 'Sans')}</button>
        </div>
      </div>
      <div className="nv-reader-settings-row">
        <span className="nv-reader-settings-label">{t('语速', 'Speed')}</span>
        <div className="nv-seg" role="group">
          {[0.8, 1, 1.15, 1.3, 1.5, 1.8].map(rate => (
            <button key={rate} type="button" className={cx(options.rate === rate && 'is-active')} onClick={() => { updateOptions({ rate }) }}>{rate}×</button>
          ))}
        </div>
      </div>
      <button type="button" className="nv-link nv-reader-settings-more" aria-expanded={more} onClick={() => { setMore(value => !value) }}>
        <Icon name={more ? 'chevronUp' : 'chevronDown'} size={12} />
        <span>{more ? t('收起', 'Less') : t('更多：播放、声音、注记', 'More: playback, sound, notes')}</span>
      </button>
      {more ? (
        <div className="nv-reader-settings-list">
          <label className="nv-check" title={t('在"文字"版面按播放时，自动翻到"脚本"版面；关掉就留在正文里听，正在念的那一句会标出来', 'Pressing play over the prose turns to the script; switched off, the prose stays and the line being spoken is marked in it')}>
            <input type="checkbox" checked={prefs.follow !== false} onChange={(event) => { update({ follow: event.target.checked }) }} />
            <span>{t('按播放时翻到脚本版面', 'Turn to the script on play')}</span>
          </label>
          <label className="nv-check">
            <input type="checkbox" checked={options.autoNext !== false} onChange={(event) => { updateOptions({ autoNext: event.target.checked }) }} />
            <span>{t('一章听完接着听下一章', 'Go on to the next chapter')}</span>
          </label>
          <label className="nv-check" title={t('在正文旁边标出这里听得到什么：环境、音效、配乐', 'Beside the text, what is heard there: the room, an effect, the music')}>
            <input type="checkbox" checked={prefs.notes} onChange={(event) => { update({ notes: event.target.checked }) }} />
            <span>{t('正文旁显示声音注记', 'Sound notes beside the text')}</span>
          </label>
          <label className="nv-check" title={t('人声之下的一切：环境声、音效、配乐', 'Everything under the voice: ambience, effects, music')}>
            <input type="checkbox" checked={options.ambienceOn} onChange={(event) => { updateOptions({ ambienceOn: event.target.checked }) }} />
            <span>{t('环境声、音效与配乐', 'Ambience, effects and music')}</span>
            <input className="nv-range" type="range" min={0} max={1} step={0.05} value={options.ambienceVolume} disabled={!options.ambienceOn} onChange={(event) => { updateOptions({ ambienceVolume: Number(event.target.value) }) }} aria-label={t('环境与音效音量', 'Sound volume')} />
          </label>
          {extra}
        </div>
      ) : null}
      <p className="nv-muted nv-small nv-reader-settings-foot">{t('这些只记在这台设备上：换一台设备、换一个人读，各是各的。', 'Kept on this device only: another device, another reader, has its own.')}</p>
    </div>
  )
  if (onClose === undefined) return panel
  return (
    <div className="nv-reader-settings-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      {panel}
    </div>
  )
}

/**
 * The switch between the two faces of a chapter — and, where a host adds one,
 * a further way of taking it in. On a phone they are reading and listening;
 * where the script has a page of its own (`pages`), they are the prose and the
 * script, and listening is the play button under either.
 */
export function ModeSwitch({ mode, onChange, t, extra, pages }: { mode: ReadMode | undefined; onChange: (mode: ReadMode) => void; t: Translate; extra?: ReactNode; pages?: boolean }) {
  return (
    <div className="nv-modes" role="tablist" aria-label={t('阅读方式', 'How to take in the chapter')}>
      <button type="button" role="tab" aria-selected={mode === 'read'} className={cx('nv-mode', mode === 'read' && 'is-active')} onClick={() => { onChange('read') }} title={pages === true ? t('文字：这一章的正文', 'Prose: the text of the chapter') : undefined}>
        <Icon name="book" size={14} />
        <span>{pages === true ? t('文字', 'Prose') : t('读', 'Read')}</span>
      </button>
      <button type="button" role="tab" aria-selected={mode === 'listen'} className={cx('nv-mode', mode === 'listen' && 'is-active')} onClick={() => { onChange('listen') }} title={pages === true ? t('脚本：谁说了什么、怎么说、底下是什么声音，一句一行', 'Script: who says what, how, and over which sound, a line each') : undefined}>
        <Icon name={pages === true ? 'list' : 'headphones'} size={14} />
        <span>{pages === true ? t('脚本', 'Script') : t('听', 'Listen')}</span>
      </button>
      {extra}
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
  /**
   * The chapter's sound, for the notes beside the text: where the script's
   * lines sit, and the cues placed on them. Shown when the reader's
   * preferences ask for notes, whether the chapter is being read or heard.
   */
  sound?: { lines: readonly AudioLine[]; cues: readonly AudioCue[] } | undefined
  /** Ids of the cues being heard right now. */
  sounding?: readonly string[] | undefined
  /** Listening: how long the line being spoken takes at the speed it is played, and whether the voice is held — what the mark that runs through the line goes by. */
  pace?: { seconds: number; paused: boolean } | undefined
  /** Offset of a paragraph to flash (a search hit). */
  flash?: number | undefined
  scroller: RefObject<HTMLDivElement | null>
  /** What follows the text: the way to the next chapter. */
  footer?: ReactNode
  /** Laid over the page: the tools for a selection. */
  children?: ReactNode
  onSelect?: (() => void) | undefined
  /**
   * Places in the text that carry a note — what a review found — in reading
   * order, none overlapping. Marked while the chapter is read (a chapter that
   * is being listened to marks its spoken lines instead), each to be pressed.
   */
  marks?: readonly { id: string; start: number; end: number; tone: 'red' | 'amber' | 'blue' }[] | undefined
  /** The mark whose note is open. */
  openMark?: string | undefined
  /** A mark was pressed; `at` is where it sits on the scrolled page. */
  onMark?: ((id: string, at: { top: number; bottom: number; left: number }) => void) | undefined
}

/** One chapter on the page. In listening mode every sentence of the prose can be pressed, and the one being spoken is lit. */
export function ReaderPage({ t, bookTitle, chapter, text, prefs, media, lines, active, onLine, sound, sounding, pace, flash, scroller, footer, children, onSelect, marks, openMark, onMark }: ReaderPageProps) {
  const blocks = useMemo<Block[]>(() => (text !== undefined ? blocksOf(text) : []), [text])
  const ranges = useMemo(() => {
    if (text === undefined || lines === undefined || lines.length === 0) return []
    const found = alignScript(text, lines)
    return lines.flatMap((line, index) => {
      const range = found.get(line.id)
      return range !== undefined ? [{ id: line.id, index, start: range.start, end: range.end }] : []
    }).sort((left, right) => left.start - right.start)
  }, [text, lines])
  // Each note sits at the paragraph in which its sound begins.
  const notes = useMemo(() => {
    const placed = new Map<number, { cue: AudioCue; caption: string }[]>()
    if (text === undefined || sound === undefined || !prefs.notes || sound.cues.length === 0) return placed
    const found = alignScript(text, sound.lines)
    const paragraphs = blocks.filter(block => block.kind === 'paragraph')
    for (const cue of sound.cues) {
      const caption = cueCaption(cue, t)
      const range = found.get(cue.at)
      if (caption === undefined || range === undefined) continue
      const block = [...paragraphs].reverse().find(candidate => candidate.offset <= range.start) ?? paragraphs[0]
      if (block === undefined) continue
      placed.set(block.offset, [...(placed.get(block.offset) ?? []), { cue, caption }])
    }
    return placed
  }, [text, sound, prefs.notes, blocks, t])
  const live = useMemo(() => new Set(sounding ?? []), [sounding])
  const noteRow = (offset: number): ReactNode => {
    const here = notes.get(offset)
    if (here === undefined) return null
    return (
      <div key={`notes-${offset}`} className="nv-sound-notes" aria-label={t('这里听得到', 'Heard here')}>
        {here.map(({ cue, caption }, at) => {
          const kind = cue.kind ?? 'bed'
          return (
            <span key={cue.id ?? at} className={cx('nv-sound-note', `is-${kind}`, cue.id !== undefined && live.has(cue.id) && 'is-sounding')} title={kind === 'bed' ? t('环境声', 'Ambience') : kind === 'music' ? t('配乐', 'Music') : t('音效', 'Sound effect')}>
              <span className="nv-sound-mark" aria-hidden="true">{kind === 'music' ? '♪' : kind === 'effect' ? '◦' : '≋'}</span>
              {caption}
            </span>
          )
        })}
      </div>
    )
  }
  const indexOf = useMemo(() => new Map(ranges.map(range => [range.id, range.index])), [ranges])
  const activeId = active !== undefined && active >= 0 ? lines?.[active]?.id : undefined
  const voiced = useMemo(() => new Set((lines ?? []).filter(line => line.audio !== undefined).map(line => line.id)), [lines])
  const skipped = useMemo(() => new Set((lines ?? []).filter(line => line.skip === true).map(line => line.id)), [lines])
  // Lines without a voice are only worth telling apart once some have one.
  const partly = voiced.size > 0 && voiced.size + skipped.size < (lines?.length ?? 0)
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
          if (!listening || ranges.length === 0) {
            const noted = !listening && marks !== undefined && marks.length > 0 ? segmentsOf(block, marks) : undefined
            if (noted === undefined || !noted.some(segment => segment.line !== undefined)) return [noteRow(block.offset), <p key={block.offset} data-offset={block.offset} className={cx(flash === block.offset && 'is-flash')}>{block.text}</p>]
            return [noteRow(block.offset), (
              <p key={block.offset} data-offset={block.offset} className={cx(flash === block.offset && 'is-flash')}>
                {noted.map((segment, at) => segment.line === undefined
                  ? <span key={at}>{segment.text}</span>
                  : (
                      <mark
                        key={at}
                        data-mark={segment.line}
                        className={cx('nv-mark', `is-${marks!.find(mark => mark.id === segment.line)?.tone ?? 'blue'}`, segment.line === openMark && 'is-open')}
                        title={t('这里有一条审校意见，点开看', 'A review note sits here — press to read it')}
                        onClick={(event) => {
                          // A selection is being made, not a note opened.
                          if ((window.getSelection()?.toString().length ?? 0) > 0) return
                          const host = scroller.current
                          if (host === null) return
                          const box = event.currentTarget.getBoundingClientRect()
                          const frame = host.getBoundingClientRect()
                          onMark?.(segment.line!, { top: box.top - frame.top + host.scrollTop, bottom: box.bottom - frame.top + host.scrollTop, left: box.left - frame.left })
                        }}
                      >{segment.text}</mark>
                    ))}
              </p>
            )]
          }
          return [noteRow(block.offset), (
            <p key={block.offset} data-offset={block.offset} className={cx(flash === block.offset && 'is-flash')}>
              {segmentsOf(block, ranges).map((segment, at) => segment.line === undefined
                ? <span key={at}>{segment.text}</span>
                : (
                    <span
                      key={at}
                      data-line={segment.line}
                      className={cx('nv-said', segment.line === activeId && 'is-speaking', segment.line === activeId && pace?.paused === true && 'is-held', skipped.has(segment.line) ? 'is-skipped' : partly && !voiced.has(segment.line) && 'is-unvoiced')}
                      style={segment.line === activeId && pace !== undefined ? { ['--nv-say' as string]: `${pace.seconds.toFixed(2)}s` } : undefined}
                      title={skipped.has(segment.line) ? t('有声版里这几个字不念', 'Left unspoken in the audio version') : undefined}
                      onClick={() => {
                        // A selection is being made, not a line chosen.
                        if ((window.getSelection()?.toString().length ?? 0) > 0) return
                        const index = indexOf.get(segment.line!)
                        if (index !== undefined) onLine(index)
                      }}
                    >{segment.text}</span>
                  ))}
            </p>
          )]
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
    if (line.skip !== true) at += line.duration ?? Math.max(1.2, line.text.length * 0.19)
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
  /** The script's sound cues, so the bar can say what is heard under the line. */
  cues?: readonly AudioCue[] | undefined
  /** Extra controls at the end of the bar. */
  children?: ReactNode
  /** Options of the host's own, shown with the bar's. */
  more?: ReactNode
  /** The reader's settings have a panel of their own: the bar's button opens that instead of options of its own. */
  onSettings?: (() => void) | undefined
}

/**
 * The transport: play and pause, a line back and forward, where the chapter
 * is, how fast it is read and how loud the ambience is. It sits under the
 * page, where a thumb reaches it.
 */
export function ListenBar({ t, player, state, lines, options, update, autoNext, onAutoNext, cues, children, more: extra, onSettings }: ListenBarProps) {
  const clock = useMemo(() => timeline(lines), [lines])
  const spoken = lines.filter(line => line.skip !== true)
  const voiced = spoken.filter(line => line.audio !== undefined).length
  const [more, setMore] = useState(false)
  // What sits under the line right now, in the words of its cue.
  const under = (cues ?? []).filter(cue => cue.kind !== 'effect' && cue.id !== undefined && (state.sounding ?? []).includes(cue.id))
  const bed = under.find(cue => (cue.kind ?? 'bed') === 'bed')
  const music = under.find(cue => cue.kind === 'music')
  const bedCaption = bed !== undefined ? cueCaption(bed, t) : state.ambience !== 'none' ? t(...AMBIENCE[state.ambience]) : undefined
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
        {options.ambienceOn && bedCaption !== undefined ? <span className="nv-chip nv-chip-violet nv-listen-ambience" title={bed?.audio !== undefined ? t('声音模型生成的环境声', 'Ambience made by the sound model') : t('浏览器合成的环境声', 'Ambience synthesized in the browser')}>≋ {bedCaption}</span> : null}
        {options.ambienceOn && music?.audio !== undefined ? <span className="nv-chip nv-chip-violet nv-listen-ambience">♪ {cueCaption(music, t) ?? t('配乐', 'music')}</span> : null}
        {voiced < spoken.length ? <span className="nv-muted nv-small nv-listen-note">{voiced === 0 ? t('还没有配音：按阅读速度逐句显示', 'Not voiced yet: lines are shown at reading pace') : t(`${spoken.length - voiced} 句还没有配音，到那里会静默显示`, `${spoken.length - voiced} lines are not voiced yet and pass in silence`)}</span> : null}
        <span className="nv-spacer" />
        {children}
        <button type="button" className={cx('nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon', more && 'is-active')} onClick={() => { if (onSettings !== undefined) onSettings(); else setMore(value => !value) }} title={t('语速、环境与音效、连播', 'Speed, sound, continuous play')} aria-expanded={more}><Icon name="settings" size={15} /></button>
      </div>
      {more && onSettings === undefined ? (
        <div className="nv-listen-more">
          <label className="nv-listen-option">
            <span>{t('语速', 'Speed')}</span>
            <select className="nv-input nv-select" value={String(options.rate)} onChange={(event) => { update({ rate: Number(event.target.value) }) }}>
              {['0.8', '1', '1.15', '1.3', '1.5', '1.8'].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
            </select>
          </label>
          <label className="nv-listen-option" title={t('人声之下的一切：环境声、音效、配乐', 'Everything under the voice: ambience, effects, music')}>
            <input type="checkbox" checked={options.ambienceOn} onChange={(event) => { update({ ambienceOn: event.target.checked }) }} />
            <span>{t('环境与音效', 'Sound')}</span>
            <input className="nv-range" type="range" min={0} max={1} step={0.05} value={options.ambienceVolume} disabled={!options.ambienceOn} onChange={(event) => { update({ ambienceVolume: Number(event.target.value) }) }} aria-label={t('环境音音量', 'Ambience volume')} />
          </label>
          {onAutoNext !== undefined ? (
            <label className="nv-listen-option">
              <input type="checkbox" checked={autoNext === true} onChange={(event) => { onAutoNext(event.target.checked) }} />
              <span>{t('一章听完接着听下一章', 'Go on to the next chapter')}</span>
            </label>
          ) : null}
          {extra}
        </div>
      ) : null}
    </div>
  )
}

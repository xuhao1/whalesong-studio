// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The reader served to other devices: the shelf of shared books, a book's
 * chapters, and a chapter to read or to listen to. It is the same page the
 * author has in the Studio, assembled from the same parts — without anything
 * that could change a book, because the server it talks to has nothing of the
 * kind to offer.
 *
 * Everything is addressed relative to the page, whose own address carries the
 * token; where the reader was is remembered on the device.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../client/icons'
import { ListenBar, ModeSwitch, PrefsControls, ReaderPage, usePlayerOptions, useReaderPrefs, type ReadMode, type Translate } from '../client/reader/parts'
import { useLinePlayer } from '../client/stage/player'
import studioStyles from '../client/styles.css'
import type { AudioCue, AudioLine } from '../shared/types'
import ownStyles from './reader.css'

interface Book {
  id: string
  title: string
  author?: string
  language: string
  logline?: string
  cover?: string
  words: number
  chapters: number
}

interface ChapterRef {
  id: string
  index: number
  title: string
  words: number
  lines: number
  voiced: number
}

interface ChapterData {
  id: string
  index: number
  title: string
  text: string
  script?: { lines: AudioLine[]; cues: AudioCue[] }
  stale: boolean
}

interface Place {
  book?: string
  chapter?: string
}

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { ...(signal !== undefined ? { signal } : {}), cache: 'no-store' })
  if (!response.ok) throw new Error(response.status === 404 ? 'gone' : `HTTP ${response.status}`)
  return await response.json() as T
}

const media = (book: string, path: string, version?: string | number): string =>
  `media/${encodeURIComponent(book)}/${path.split('/').map(encodeURIComponent).join('/')}${version !== undefined ? `?v=${encodeURIComponent(String(version))}` : ''}`

function readPlace(): Place {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(part => decodeURIComponent(part))
  if (parts[0] !== 'book' || parts[1] === undefined || parts[1].length === 0) return {}
  return { book: parts[1], ...(parts[2] !== undefined && parts[2].length > 0 ? { chapter: parts[2] } : {}) }
}

function go(place: Place): void {
  location.hash = place.book === undefined ? '#/' : `#/book/${encodeURIComponent(place.book)}${place.chapter !== undefined ? `/${encodeURIComponent(place.chapter)}` : ''}`
}

/** Where the reader left each book, kept on this device. */
function remembered(book: string): { chapter?: string } {
  try {
    return JSON.parse(localStorage.getItem(`novel-reader:at:${book}`) ?? '{}') as { chapter?: string }
  } catch {
    return {}
  }
}

function remember(book: string, chapter: string): void {
  try {
    localStorage.setItem(`novel-reader:at:${book}`, JSON.stringify({ chapter }))
  } catch {
    // Not remembered on this device; nothing is lost but the bookmark.
  }
}

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): { data: T | undefined; error: string | undefined; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined }>({ data: undefined, error: undefined })
  const [nonce, setNonce] = useState(0)
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    const abort = new AbortController()
    setState({ data: undefined, error: undefined })
    loader.current(abort.signal).then(
      (data) => { if (!abort.signal.aborted) setState({ data, error: undefined }) },
      (error: unknown) => { if (!abort.signal.aborted) setState({ data: undefined, error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { abort.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])
  return { ...state, reload: useCallback(() => { setNonce(value => value + 1) }, []) }
}

function Problem({ error, t, onRetry }: { error: string; t: Translate; onRetry: () => void }) {
  return (
    <div className="nv-empty">
      <Icon name="alert" size={28} className="nv-empty-icon" />
      <div className="nv-empty-title">{error === 'gone' ? t('这里读不到了', 'Nothing to read here any more') : t('连不上', 'Cannot connect')}</div>
      <div className="nv-empty-body">
        <p>{error === 'gone'
          ? t('这本书可能已经不再分享，或者链接换过了。向作者要一个新的链接。', 'The book may no longer be shared, or the link was replaced. Ask the author for a new one.')
          : t('请确认这台设备和作者的电脑连着同一个网络，而且那边的 Harness 开着。', 'Make sure this device is on the same network as the author\'s computer, and that the Harness is running there.')}</p>
        <button type="button" className="nv-btn nv-btn-outline" onClick={onRetry}><Icon name="refresh" size={15} /><span>{t('再试一次', 'Try again')}</span></button>
      </div>
    </div>
  )
}

function Shelf({ t }: { t: Translate }) {
  const books = useLoad(signal => get<{ books: Book[] }>('api/books', signal), [])
  if (books.error !== undefined) return <Problem error={books.error} t={t} onRetry={books.reload} />
  if (books.data === undefined) return <div className="nv-center"><span className="nv-spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /></div>
  return (
    <div className="nr-shelf">
      <h1>{t('书架', 'Bookshelf')}</h1>
      {books.data.books.length === 0 ? <p className="nv-muted">{t('现在没有分享出来的书。', 'No book is shared right now.')}</p> : (
        <div className="nv-shelf">
          {books.data.books.map(book => (
            <div key={book.id} className="nv-shelf-item">
              <button type="button" className="nv-shelf-open" onClick={() => { go({ book: book.id }) }}>
                <span className="nv-shelf-cover">
                  {book.cover !== undefined
                    ? <img alt="" loading="lazy" src={media(book.id, book.cover)} />
                    : <span className="nv-shelf-blank"><Icon name="book" size={22} /><em>{book.title.slice(0, 8)}</em></span>}
                </span>
                <span className="nv-shelf-title">{book.title}</span>
                <span className="nv-shelf-meta">{book.author !== undefined ? `${book.author} · ` : ''}{t(`${book.chapters} 章`, `${book.chapters} chapters`)}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BookScreen({ id, chapterId, t }: { id: string; chapterId: string | undefined; t: Translate }) {
  const detail = useLoad(signal => get<{ book: Book; chapters: ChapterRef[] }>(`api/books/${encodeURIComponent(id)}`, signal), [id])
  const chapters = useMemo(() => detail.data?.chapters ?? [], [detail.data])
  if (detail.error !== undefined) return <Problem error={detail.error} t={t} onRetry={detail.reload} />
  if (detail.data === undefined) return <div className="nv-center"><span className="nv-spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /></div>
  const chapter = chapters.find(candidate => candidate.id === chapterId)
  if (chapter === undefined) return <Contents book={detail.data.book} chapters={chapters} t={t} />
  return <Chapter book={detail.data.book} chapters={chapters} chapter={chapter} t={t} />
}

function Contents({ book, chapters, t }: { book: Book; chapters: ChapterRef[]; t: Translate }) {
  const last = remembered(book.id).chapter
  const resume = chapters.find(chapter => chapter.id === last)
  return (
    <div className="nr-contents">
      <header className="nr-topbar">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { go({}) }}><Icon name="chevronLeft" size={15} /><span>{t('书架', 'Shelf')}</span></button>
      </header>
      <div className="nr-book">
        <div className="nr-book-head">
          {book.cover !== undefined ? <img className="nr-book-cover" alt="" src={media(book.id, book.cover)} /> : null}
          <div className="nr-book-text">
            <h1>{book.title}</h1>
            {book.author !== undefined ? <p className="nv-muted">{book.author}</p> : null}
            {book.logline !== undefined ? <p className="nr-book-logline">{book.logline}</p> : null}
            <p className="nv-muted nv-small">{t(`${book.chapters} 章 · ${book.words.toLocaleString()} 字`, `${book.chapters} chapters · ${book.words.toLocaleString()} words`)}</p>
            {chapters.length > 0 ? (
              <button type="button" className="nv-btn nv-btn-primary" onClick={() => { go({ book: book.id, chapter: (resume ?? chapters[0]!).id }) }}>
                <Icon name="eye" size={15} />
                <span>{resume !== undefined ? t(`接着读：第 ${resume.index} 章`, `Continue: chapter ${resume.index}`) : t('开始读', 'Start reading')}</span>
              </button>
            ) : null}
          </div>
        </div>
        <ol className="nr-chapters">
          {chapters.map(chapter => (
            <li key={chapter.id}>
              <button type="button" className={cx('nr-chapter', chapter.id === last && 'is-last')} onClick={() => { go({ book: book.id, chapter: chapter.id }) }}>
                <span className="nr-chapter-index">{chapter.index}</span>
                <span className="nr-chapter-title">{chapter.title}</span>
                {chapter.voiced > 0 ? <span className="nr-chapter-audio" title={t('有配音', 'Has a voice')}><Icon name="headphones" size={13} /></span> : null}
                <span className="nr-chapter-words">{chapter.words.toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ol>
        {chapters.length === 0 ? <p className="nv-muted">{t('这本书还没有写好的章节。', 'This book has no finished chapter yet.')}</p> : null}
      </div>
    </div>
  )
}

function Chapter({ book, chapters, chapter, t }: { book: Book; chapters: ChapterRef[]; chapter: ChapterRef; t: Translate }) {
  const data = useLoad(signal => get<ChapterData>(`api/books/${encodeURIComponent(book.id)}/chapters/${encodeURIComponent(chapter.id)}`, signal), [book.id, chapter.id])
  const [prefs, updatePrefs] = useReaderPrefs()
  const [options, updateOptions] = usePlayerOptions()
  const [mode, setMode] = useState<ReadMode>(() => {
    try {
      return localStorage.getItem('novel-reader:mode') === 'listen' ? 'listen' : 'read'
    } catch {
      return 'read'
    }
  })
  const [autoNext, setAutoNext] = useState(true)
  const [typing, setTyping] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const carryOn = useRef(false)
  const position = chapters.findIndex(candidate => candidate.id === chapter.id)
  const next = chapters[position + 1]
  const previous = chapters[position - 1]
  const script = data.data?.script
  const lines = useMemo(() => script?.lines ?? [], [script])
  const cues = useMemo(() => script?.cues ?? [], [script])
  const url = useCallback((path: string, version?: string | number) => media(book.id, path, version), [book.id])
  const listening = mode === 'listen'
  const { player, state } = useLinePlayer(lines, cues, url, options, () => {
    if (!autoNext || next === undefined) return
    carryOn.current = true
    go({ book: book.id, chapter: next.id })
  })

  useEffect(() => { remember(book.id, chapter.id) }, [book.id, chapter.id])
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [chapter.id])
  useEffect(() => {
    document.title = `${chapter.title} · ${book.title}`
  }, [chapter.title, book.title])
  useEffect(() => {
    if (!listening) {
      carryOn.current = false
      player.stop()
    }
  }, [listening, player])
  // The chapter that follows one that ran out starts by itself, once it has arrived.
  useEffect(() => {
    if (!carryOn.current || !listening || data.data === undefined || data.data.id !== chapter.id) return
    carryOn.current = false
    if (lines.some(line => line.audio !== undefined)) player.play(0)
  }, [data.data, listening, chapter.id, lines, player])
  // The lock screen and the headphones' buttons drive the same player.
  useEffect(() => {
    const session = navigator.mediaSession as MediaSession | undefined
    if (session === undefined || !listening || typeof MediaMetadata === 'undefined') return
    session.metadata = new MediaMetadata({ title: chapter.title, artist: book.author ?? book.title, album: book.title, ...(book.cover !== undefined ? { artwork: [{ src: new URL(media(book.id, book.cover), document.baseURI).href }] } : {}) })
    const set = (action: MediaSessionAction, handler: (() => void) | null): void => {
      try {
        session.setActionHandler(action, handler)
      } catch {
        // This browser does not offer that control.
      }
    }
    set('play', () => { player.toggle() })
    set('pause', () => { player.pause() })
    set('nexttrack', () => { player.step(1) })
    set('previoustrack', () => { player.step(-1) })
    return () => {
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) set(action, null)
    }
  }, [listening, player, chapter.title, book])
  useEffect(() => {
    if (navigator.mediaSession !== undefined) navigator.mediaSession.playbackState = state.status === 'playing' ? 'playing' : state.status === 'paused' ? 'paused' : 'none'
  }, [state.status])

  const chooseMode = (value: ReadMode): void => {
    setMode(value)
    try {
      localStorage.setItem('novel-reader:mode', value)
    } catch {
      // Kept for this visit only.
    }
  }
  const voiced = lines.filter(line => line.audio !== undefined).length

  return (
    <div className={cx('nv-reader', `is-${prefs.theme}`, listening && 'is-listen')}>
      <header className="nv-reader-bar nr-bar">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" onClick={() => { go({ book: book.id }) }} title={t('目录', 'Contents')} aria-label={t('目录', 'Contents')}><Icon name="list" size={16} /></button>
        <span className="nr-bar-title">{book.title}</span>
        <ModeSwitch mode={mode} onChange={chooseMode} t={t} />
        <button type="button" className={cx('nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon', typing && 'is-active')} onClick={() => { setTyping(value => !value) }} title={t('字号与纸张', 'Type and paper')} aria-expanded={typing}><Icon name="type" size={15} /></button>
      </header>
      {typing ? <div className="nv-reader-bar nr-typing"><PrefsControls prefs={prefs} update={updatePrefs} t={t} /></div> : null}
      {data.error !== undefined ? <Problem error={data.error} t={t} onRetry={data.reload} /> : (
        <ReaderPage
          t={t}
          bookTitle={book.title}
          chapter={chapter}
          text={data.data?.text}
          prefs={prefs}
          media={path => url(path)}
          lines={listening && script !== undefined ? lines : undefined}
          active={listening ? state.index : undefined}
          onLine={listening && script !== undefined ? (index) => { player.play(index) } : undefined}
          scroller={scroller}
          footer={(
            <div className="nr-turn">
              {previous !== undefined ? <button type="button" className="nv-btn nv-btn-outline" onClick={() => { go({ book: book.id, chapter: previous.id }) }}><Icon name="chevronLeft" size={15} /><span>{t('上一章', 'Previous')}</span></button> : null}
              {next !== undefined
                ? <button type="button" className="nv-btn nv-btn-primary" onClick={() => { go({ book: book.id, chapter: next.id }) }}><span>{t('下一章：', 'Next: ')}{next.title}</span><Icon name="chevronRight" size={15} /></button>
                : <span className="nv-muted">{t('—— 已读到最新一章 ——', '— you have reached the latest chapter —')}</span>}
            </div>
          )}
        />
      )}
      {listening && data.data !== undefined ? (
        script !== undefined && voiced > 0
          ? <ListenBar t={t} player={player} state={state} lines={lines} options={options} update={updateOptions} autoNext={autoNext} onAutoNext={setAutoNext} />
          : <div className="nr-novoice"><Icon name="headphones" size={15} /><span>{t('这一章还没有做成有声版，先看着读吧。', 'This chapter has no audio version yet; it can be read meanwhile.')}</span></div>
      ) : null}
    </div>
  )
}

function App() {
  const [place, setPlace] = useState<Place>(readPlace)
  useEffect(() => {
    const onHash = (): void => { setPlace(readPlace()) }
    window.addEventListener('hashchange', onHash)
    return () => { window.removeEventListener('hashchange', onHash) }
  }, [])
  const zh = (navigator.language ?? 'zh').toLowerCase().startsWith('zh')
  const t: Translate = useMemo(() => (zhText, enText) => (zh ? zhText : enText), [zh])
  return (
    <div className="nv-root nv-standalone" data-novel-studio="">
      {place.book === undefined ? <Shelf t={t} /> : <BookScreen key={place.book} id={place.book} chapterId={place.chapter} t={t} />}
    </div>
  )
}

const style = document.createElement('style')
style.textContent = `${studioStyles}\n${ownStyles}`
document.head.appendChild(style)
const mount = document.getElementById('app')
if (mount !== null) createRoot(mount).render(<App />)

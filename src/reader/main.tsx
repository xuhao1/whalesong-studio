// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The reader served to other devices — and written out with a published site:
 * the shelf of shared books, a book's chapters, and a chapter with its three
 * faces (the prose, the script, the motion comic) and one player under the
 * first two. It is the same page the author has in the Studio, assembled from
 * the same parts.
 *
 * What it can change is what the author allowed for the book: nothing, unless
 * the book was made changeable from other devices — then its text can be
 * edited here and its interludes played. A sealed book asks this device for
 * its password once.
 *
 * Everything is addressed relative to the page, whose own address carries the
 * token; where the reader was is remembered on the device.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../client/icons'
import { AlbumView, ViewerTabs, type ViewerHalf } from '../client/reader/album'
import { PlayTranscript, SideList, type SidePlay, type SideRef } from '../client/reader/sides'
import { ListenBar, ModeSwitch, ReaderPage, ReaderSettings, setReaderDefaults, usePlayerOptions, useReaderPrefs, type ReadMode, type Translate } from '../client/reader/parts'
import { chapterFigures, ScriptPage } from '../client/reader/script'
import { Film, place, secondsOf, Theater, useCurrentPanel, WatchChoice, type ChapterFilm, type TheaterPanel } from '../client/reader/theater'
import { useLinePlayer } from '../client/stage/player'
import studioStyles from '../client/styles.css'
import { albumEmpty, type Album, type AlbumAt, type AlbumCounts } from '../shared/album'
import { readAlong, type ReaderLine, type ReaderWay } from '../shared/reader'
import type { AudioCue, AudioLine, PlayTurn } from '../shared/types'
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
  /** read: nothing can be changed from here. edit: the text can be edited and interludes played. */
  mode?: 'read' | 'edit'
  /** Sealed, and this device has not shown the password yet. */
  locked?: boolean
}

interface ChapterRef {
  id: string
  index: number
  title: string
  words: number
  lines: number
  voiced: number
  panels?: number
  drawn?: number
  /** It has a finished video. */
  video?: boolean
  /** The line of the plot it belongs to, when that is not the main one. */
  line?: string
}

type Line = ReaderLine
type Way = ReaderWay<ChapterRef>

const MAIN = 'main'

interface ChapterData {
  id: string
  index: number
  title: string
  text: string
  script?: { lines: AudioLine[]; cues: AudioCue[] }
  board?: { panels: TheaterPanel[] }
  /** Its finished video; absent from a Host or a site that carries none. */
  video?: { path: string; subtitles?: string; burned?: boolean; version: string }
  stale: boolean
}

interface Play {
  id: string
  title: string
  player?: string
  cast: string[]
  situation: string
  location?: string
  turns: PlayTurn[]
  outcome?: string
}

interface PlayRef {
  id: string
  title: string
  updatedAt: string
  turns: number
  ended: boolean
}

interface CastMember {
  id: string
  name: string
  role: string
  tagline?: string
  portrait?: string
}

/** Where the page is: the shelf, a book, a chapter of it, its people or its world, its interludes or one of them. */
interface Place {
  book?: string
  chapter?: string
  play?: string | true
  album?: AlbumAt
  /** The side stories — interludes the author kept — or one of them. */
  side?: string | true
}

type ViewMode = ReadMode | 'watch'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

async function answer<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json() as T
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string }
  throw new ApiError(response.status, body.error ?? (response.status === 404 ? 'gone' : `http-${response.status}`), body.message ?? (response.status === 404 ? 'gone' : `HTTP ${response.status}`))
}

/**
 * The page was published as a site of its own (`core/pipelines/site.ts`): there
 * is no server to ask, and what it would answer lies beside the page as files.
 */
const SITE = document.querySelector('meta[name="novel-site"]')?.getAttribute('content') === 'static'
/** A site of one book: the book is the site, and there is no shelf to go back to. */
const SOLE = SITE && document.querySelector('meta[name="novel-books"]')?.getAttribute('content') === '1'

/** Where on a site the answer to a request is kept. */
function siteFile(path: string): string {
  const parts = path.split('/')
  if (parts[0] !== 'api' || parts[1] !== 'books') return path
  if (parts.length === 2) return 'data/books.json'
  if (parts.length === 3) return `data/${parts[2]}/book.json`
  return `data/${parts.slice(2).join('/')}.json`
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  // A site's files change only when it is published again: the host's own caching serves them.
  if (SITE) return await answer<T>(await fetch(siteFile(path), signal !== undefined ? { signal } : {}))
  return await answer<T>(await fetch(path, { ...(signal !== undefined ? { signal } : {}), cache: 'no-store', credentials: 'same-origin' }))
}

/** With what, and by whom, a published site says it was made. */
function siteCredit(): { name: string; url: string } | undefined {
  const [name, url] = (document.querySelector('meta[name="novel-credit"]')?.getAttribute('content') ?? '').split('|')
  return name !== undefined && name.length > 0 && url !== undefined && /^https?:\/\//.test(url) ? { name, url } : undefined
}

/** Change something on a book the author made changeable. */
async function send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  return await answer<T>(await fetch(path, { method, cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-novel-reader': '1' }, body: JSON.stringify(body) }))
}

const media = (book: string, path: string, version?: string | number): string =>
  `media/${encodeURIComponent(book)}/${path.split('/').map(encodeURIComponent).join('/')}${version !== undefined ? `?v=${encodeURIComponent(String(version))}` : ''}`

function readPlace(): Place {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(part => decodeURIComponent(part))
  if (parts[0] !== 'book' || parts[1] === undefined || parts[1].length === 0) return {}
  if (parts[2] === 'play') return { book: parts[1], play: parts[3] !== undefined && parts[3].length > 0 ? parts[3] : true }
  if (parts[2] === 'sides') return { book: parts[1], side: parts[3] !== undefined && parts[3].length > 0 ? parts[3] : true }
  if (parts[2] === 'people' || parts[2] === 'world') {
    const id = parts[3] !== undefined && parts[3].length > 0 ? parts[3] : undefined
    return { book: parts[1], album: { section: parts[2], ...(id !== undefined ? { end: { type: parts[2] === 'people' ? 'character' : 'world', id } } : {}) } }
  }
  return { book: parts[1], ...(parts[2] !== undefined && parts[2].length > 0 ? { chapter: parts[2] } : {}) }
}

function go(place: Place): void {
  const book = place.book !== undefined ? `#/book/${encodeURIComponent(place.book)}` : '#/'
  location.hash = place.book === undefined ? book
    : place.play !== undefined ? `${book}/play${typeof place.play === 'string' ? `/${encodeURIComponent(place.play)}` : ''}`
    : place.side !== undefined ? `${book}/sides${typeof place.side === 'string' ? `/${encodeURIComponent(place.side)}` : ''}`
      : place.album !== undefined ? `${book}/${place.album.end?.type === 'character' ? 'people' : place.album.end?.type === 'world' ? 'world' : place.album.section}${place.album.end !== undefined ? `/${encodeURIComponent(place.album.end.id)}` : ''}`
        : `${book}${place.chapter !== undefined ? `/${encodeURIComponent(place.chapter)}` : ''}`
}

/** Where the reader left each book, kept on this device — and when, so that a later place left on another device is told from it. */
function remembered(book: string): { chapter?: string; at?: string } {
  try {
    return JSON.parse(localStorage.getItem(`novel-reader:at:${book}`) ?? '{}') as { chapter?: string; at?: string }
  } catch {
    return {}
  }
}

function remember(book: string, chapter: string): void {
  try {
    localStorage.setItem(`novel-reader:at:${book}`, JSON.stringify({ chapter, at: new Date().toISOString() }))
  } catch {
    // Not remembered on this device; nothing is lost but the bookmark.
  }
  // Left with the book too, where there is somebody to leave it with: the next device picks the book up here.
  // (A site is files: its reader keeps its place on the device alone. A Host from before this was kept answers "not found", which is no harm.)
  if (!SITE) void send('POST', `api/books/${encodeURIComponent(book)}/position`, { chapter }).catch(() => {})
}

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): { data: T | undefined; error: string | undefined; reload: () => void; set: (data: T) => void } {
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined }>({ data: undefined, error: undefined })
  const [nonce, setNonce] = useState(0)
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    const abort = new AbortController()
    setState({ data: undefined, error: undefined })
    loader.current(abort.signal).then(
      (data) => { if (!abort.signal.aborted) setState({ data, error: undefined }) },
      // A failure is known by what kind it is — gone, locked — rather than by its wording.
      (error: unknown) => { if (!abort.signal.aborted) setState({ data: undefined, error: error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error) }) },
    )
    return () => { abort.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])
  return { ...state, reload: useCallback(() => { setNonce(value => value + 1) }, []), set: useCallback((data: T) => { setState({ data, error: undefined }) }, []) }
}

/** A sealed book before this device was let in: its password is asked for, once. */
function Unlock({ id, title, t, onOpen }: { id: string; title?: string; t: Translate; onOpen: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState<string | undefined>()
  const submit = (): void => {
    if (password.length === 0 || busy) return
    setBusy(true)
    setWrong(undefined)
    send('POST', `api/books/${encodeURIComponent(id)}/unlock`, { password }).then(() => { onOpen() }, (error: unknown) => {
      setWrong(error instanceof ApiError && error.code === 'wrong-password' ? t('密码不对。', 'That is not the password.')
        : error instanceof ApiError && error.code === 'wait' ? t('错得太多了，等一会儿再试。', 'Too many wrong tries; wait a while.')
          : t('没能连上作者的电脑。', 'Could not reach the author\'s computer.'))
    }).finally(() => { setBusy(false) })
  }
  return (
    <div className="nr-lock">
      <span className="nv-lock-icon"><Icon name="lock" size={28} /></span>
      <h1>{title ?? t('一本加密的书', 'A sealed book')}</h1>
      <p className="nv-muted">{t('这本书加了密。在这台设备上第一次打开要输入它的密码，之后会记住这台设备。', 'This book is sealed. The first time on this device its password is asked for; the device is remembered afterwards.')}</p>
      <form className="nv-lock-form" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <input className="nv-input" type="password" autoComplete="off" autoFocus value={password} placeholder={t('这本书的密码', 'The book\'s password')} onChange={(event) => { setPassword(event.target.value); setWrong(undefined) }} />
        <button type="submit" className="nv-btn nv-btn-primary" disabled={password.length === 0 || busy}>{busy ? <span className="nv-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> : <Icon name="unlock" size={15} />}<span>{t('解锁', 'Unlock')}</span></button>
      </form>
      {wrong !== undefined ? <p className="nv-note is-warn">{wrong}</p> : null}
      <p className="nv-muted nv-small">{t('这里和作者的电脑之间走的是同一个 Wi-Fi 里的普通连接，密码不加密传输——只在信得过的网络里输入。', 'The connection to the author\'s computer is an ordinary one inside the same Wi-Fi, and the password travels unencrypted — type it only on a network you trust.')}</p>
      <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { go({}) }}><Icon name="chevronLeft" size={15} /><span>{t('书架', 'Shelf')}</span></button>
    </div>
  )
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

/** Names of the books the shelf showed, so a locked one can be called by its name before it is opened. */
const shelfTitles = new Map<string, string>()

function Shelf({ t }: { t: Translate }) {
  const books = useLoad(signal => get<{ books: Book[] }>('api/books', signal), [])
  for (const book of books.data?.books ?? []) shelfTitles.set(book.id, book.title)
  // A site of one book is that book: its contents are the front page.
  const only = SOLE && books.data?.books.length === 1 ? books.data.books[0]!.id : undefined
  useEffect(() => { if (only !== undefined) go({ book: only }) }, [only])
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
                  {book.locked === true
                    ? <span className="nv-shelf-blank is-locked"><Icon name="lock" size={22} /><em>{t('已上锁', 'Locked')}</em></span>
                    : book.cover !== undefined
                      ? <img alt="" loading="lazy" src={media(book.id, book.cover)} />
                      : <span className="nv-shelf-blank"><Icon name="book" size={22} /><em>{book.title.slice(0, 8)}</em></span>}
                </span>
                <span className="nv-shelf-title">{book.title}</span>
                <span className="nv-shelf-meta">{book.locked === true ? t('输入密码后可读', 'Opens with its password') : `${book.author !== undefined ? `${book.author} · ` : ''}${t(`${book.chapters} 章`, `${book.chapters} chapters`)}${book.mode === 'edit' ? t(' · 可编辑', ' · editable') : ''}`}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The line of the plot a book is read along on this device, where it goes more than one way. */
function useLine(book: string): [string, (line: string) => void] {
  const key = `novel-reader:line:${book}`
  const [line, setLine] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? MAIN
    } catch {
      return MAIN
    }
  })
  const choose = useCallback((next: string): void => {
    setLine(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      // Chosen for this visit only.
    }
  }, [key])
  return [line, choose]
}

function BookScreen({ id, place, t }: { id: string; place: Place; t: Translate }) {
  const detail = useLoad(signal => get<{ book: Book; chapters: ChapterRef[]; lines?: Line[]; album?: AlbumCounts; sides?: number; position?: { chapter: string; at: string; by: string } }>(`api/books/${encodeURIComponent(id)}`, signal), [id])
  const every = useMemo(() => detail.data?.chapters ?? [], [detail.data])
  const [chosen, chooseLine] = useLine(id)
  // Along the line being read: a book that goes one way has only that one.
  const { line, chapters, ways } = useMemo(() => readAlong(every, detail.data?.lines, chosen, place.chapter), [every, detail.data, chosen, place.chapter])
  // Sealed, and this device has not been let in: the password first.
  if (detail.error === 'locked') return <Unlock id={id} title={shelfTitles.get(id)} t={t} onOpen={detail.reload} />
  if (detail.error !== undefined) return <Problem error={detail.error} t={t} onRetry={detail.reload} />
  if (detail.data === undefined) return <div className="nv-center"><span className="nv-spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /></div>
  const { book } = detail.data
  if (place.play !== undefined && book.mode === 'edit') {
    return typeof place.play === 'string'
      ? <PlayScreen key={place.play} book={book} playId={place.play} t={t} />
      : <PlayList book={book} chapters={chapters} t={t} />
  }
  const sides = detail.data.sides ?? 0
  // The people and the world: where the book has any, and whoever serves it gives them.
  if (place.album !== undefined && !albumEmpty(detail.data.album)) return <AlbumScreen book={book} chapters={every} counts={detail.data.album} sides={sides} at={place.album} lines={detail.data.lines} line={line?.id ?? MAIN} onLine={chooseLine} t={t} />
  // The side stories the author kept: to be read, by whoever reads the book.
  if (place.side !== undefined && sides > 0) return <SidesScreen key={String(place.side)} book={book} counts={detail.data.album} sides={sides} side={typeof place.side === 'string' ? place.side : undefined} t={t} />
  const chapter = chapters.find(candidate => candidate.id === place.chapter)
  if (chapter === undefined) {
    // Read further on another device since this one was last at the book: that is where reading goes on.
    const mine = remembered(id)
    const left = detail.data.position
    const there = left !== undefined && left.chapter !== mine.chapter && (mine.at === undefined || left.at > mine.at) ? every.find(candidate => candidate.id === left.chapter) : undefined
    return <Contents book={book} chapters={chapters} counts={detail.data.album} sides={sides} lines={detail.data.lines} line={line} onLine={chooseLine} elsewhere={there !== undefined ? { chapter: there, by: left!.by } : undefined} t={t} />
  }
  return <Chapter book={book} chapters={chapters} chapter={chapter} ways={ways} onLine={chooseLine} t={t} />
}

/** The halves of a book to change between, as this page goes to them. */
function BookTabs({ book, value, counts, sides, t }: { book: Book; value: ViewerHalf; counts: AlbumCounts | undefined; sides: number; t: Translate }) {
  return <ViewerTabs t={t} value={value} counts={counts} sides={sides} onChange={(next) => { go(next === 'text' ? { book: book.id } : next === 'sides' ? { book: book.id, side: true } : { book: book.id, album: { section: next } }) }} />
}

/** The side stories of a book, and one of them as it is read. */
function SidesScreen({ book, counts, sides, side, t }: { book: Book; counts: AlbumCounts | undefined; sides: number; side: string | undefined; t: Translate }) {
  const base = `api/books/${encodeURIComponent(book.id)}/sides`
  const list = useLoad(signal => (side === undefined ? get<{ sides: SideRef[] }>(base, signal) : Promise.resolve(undefined)), [book.id, side])
  const one = useLoad(signal => (side !== undefined ? get<{ play: SidePlay }>(`${base}/${encodeURIComponent(side)}`, signal) : Promise.resolve(undefined)), [book.id, side])
  const url = useCallback((path: string) => media(book.id, path), [book.id])
  const title = one.data?.play.title
  useEffect(() => {
    document.title = `${title ?? t('番外', 'Side stories')} · ${book.title}`
  }, [title, book.title, t])
  const failed = list.error ?? one.error
  return (
    <div className="nr-contents">
      <header className="nr-topbar nr-album-bar">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { go(side !== undefined ? { book: book.id, side: true } : { book: book.id }) }}><Icon name="chevronLeft" size={15} /><span className="nr-album-back">{side !== undefined ? t('番外', 'Side stories') : book.title}</span></button>
        <span className="nv-spacer" />
        <BookTabs book={book} value="sides" counts={counts} sides={sides} t={t} />
      </header>
      {failed !== undefined ? <Problem error={failed} t={t} onRetry={side !== undefined ? one.reload : list.reload} />
        : side !== undefined
          ? one.data === undefined ? <div className="nv-center"><span className="nv-spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /></div> : (
            <>
              <h1 className="nr-side-title">{one.data.play.title}</h1>
              <PlayTranscript t={t} play={one.data.play} media={url} />
            </>
          )
          : <div className="nr-book">{list.data === undefined ? <div className="nv-center"><span className="nv-spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /></div> : <SideList t={t} sides={list.data.sides} onOpen={(id) => { go({ book: book.id, side: id }) }} />}</div>}
    </div>
  )
}

/** The book's people and its world: the album, with the way back to the text. */
function AlbumScreen({ book, chapters, counts, sides, at, lines, line, onLine, t }: { book: Book; chapters: ChapterRef[]; counts: AlbumCounts | undefined; sides: number; at: AlbumAt; lines: Line[] | undefined; line: string; onLine: (line: string) => void; t: Translate }) {
  // Of the line being read, where the book goes more than one way: who is met and what has happened are as that line has them.
  const album = useLoad(async (signal) => {
    const base = `api/books/${encodeURIComponent(book.id)}/album`
    if (line !== MAIN) {
      try {
        return await get<Album>(`${base}/${encodeURIComponent(line)}`, signal)
      } catch (error) {
        // Whoever serves the book may know the main line's album only (a Host from before lines had their own): that one, then.
        if (signal.aborted) throw error
      }
    }
    return await get<Album>(base, signal)
  }, [book.id, line])
  const url = useCallback((path: string) => media(book.id, path), [book.id])
  const section = at.end?.type === 'character' ? 'people' : at.end?.type === 'world' ? 'world' : at.section
  useEffect(() => {
    document.title = `${section === 'people' ? t('人物', 'People') : t('世界', 'World')} · ${book.title}`
  }, [section, book.title, t])
  return (
    <div className="nr-contents">
      <header className="nr-topbar nr-album-bar">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { go({ book: book.id }) }}><Icon name="chevronLeft" size={15} /><span className="nr-album-back">{book.title}</span></button>
        <span className="nv-spacer" />
        <BookTabs book={book} value={section} counts={counts} sides={sides} t={t} />
      </header>
      <div className="nr-book nr-album">
        {album.error !== undefined ? <Problem error={album.error} t={t} onRetry={album.reload} />
          : album.data === undefined ? <div className="nv-center"><span className="nv-spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /></div>
            : (
              <AlbumView
                t={t}
                album={album.data}
                media={url}
                at={at}
                go={(next) => { go({ book: book.id, album: next }) }}
                onRead={(chapter) => { if (chapters.some(candidate => candidate.id === chapter)) go({ book: book.id, chapter }) }}
                readTo={album.data.chapters.find(chapter => chapter.id === remembered(book.id).chapter)?.index}
                ways={lines}
                onWay={onLine}
              />
            )}
      </div>
    </div>
  )
}

function Contents({ book, chapters, counts, sides, lines, line, onLine, elsewhere, t }: { book: Book; chapters: ChapterRef[]; counts: AlbumCounts | undefined; sides: number; lines?: Line[] | undefined; line?: Line | undefined; onLine: (line: string) => void; /** Where the book was read on another device, later than on this one. */ elsewhere?: { chapter: ChapterRef; by: string } | undefined; t: Translate }) {
  const last = remembered(book.id).chapter
  const resume = chapters.find(chapter => chapter.id === last)
  const credit = useMemo(siteCredit, [])
  return (
    <div className="nr-contents">
      {SOLE ? null : (
        <header className="nr-topbar">
          <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { go({}) }}><Icon name="chevronLeft" size={15} /><span>{t('书架', 'Shelf')}</span></button>
        </header>
      )}
      <div className="nr-book nr-book-contents">
        <div className="nr-book-head">
          {book.cover !== undefined ? <img className="nr-book-cover" alt="" src={media(book.id, book.cover)} /> : null}
          <div className="nr-book-text">
            <h1>{book.title}</h1>
            {book.author !== undefined ? <p className="nv-muted">{book.author}</p> : null}
            {book.logline !== undefined ? <p className="nr-book-logline">{book.logline}</p> : null}
            <p className="nv-muted nv-small">{t(`${book.chapters} 章 · ${book.words.toLocaleString()} 字`, `${book.chapters} chapters · ${book.words.toLocaleString()} words`)}</p>
            <div className="nr-book-actions">
              {elsewhere !== undefined ? (
                <button type="button" className="nv-btn nv-btn-primary" onClick={() => { go({ book: book.id, chapter: elsewhere.chapter.id }) }} title={elsewhere.chapter.title}>
                  <Icon name="eye" size={15} />
                  <span>{t(`接着读：第 ${elsewhere.chapter.index} 章`, `Continue: chapter ${elsewhere.chapter.index}`)}</span>
                </button>
              ) : null}
              {chapters.length > 0 ? (
                <button type="button" className={cx('nv-btn', elsewhere !== undefined ? 'nv-btn-outline' : 'nv-btn-primary')} onClick={() => { go({ book: book.id, chapter: (resume ?? chapters[0]!).id }) }}>
                  {elsewhere !== undefined ? null : <Icon name="eye" size={15} />}
                  <span>{resume !== undefined ? (elsewhere !== undefined ? t(`这台设备上次：第 ${resume.index} 章`, `On this device: chapter ${resume.index}`) : t(`接着读：第 ${resume.index} 章`, `Continue: chapter ${resume.index}`)) : elsewhere !== undefined ? t('从头读', 'From the start') : t('开始读', 'Start reading')}</span>
                </button>
              ) : null}
              {book.mode === 'edit' ? (
                <button type="button" className="nv-btn nv-btn-outline" onClick={() => { go({ book: book.id, play: true }) }}>
                  <Icon name="gamepad" size={15} />
                  <span>{t('幕间', 'Interludes')}</span>
                </button>
              ) : null}
            </div>
            {elsewhere !== undefined ? <p className="nv-muted nv-small">{t(`在${elsewhere.by === 'Studio' ? '电脑上的工坊里' : `另一台设备（${elsewhere.by}）上`}读到了第 ${elsewhere.chapter.index} 章《${elsewhere.chapter.title}》。`, `Read as far as chapter ${elsewhere.chapter.index}, "${elsewhere.chapter.title}", ${elsewhere.by === 'Studio' ? 'in the Studio on the computer' : `on another device (${elsewhere.by})`}.`)}</p> : null}
            {book.mode === 'edit' ? <p className="nv-muted nv-small">{t('作者允许在这台设备上改这本书：可以编辑正文，也可以玩幕间。', 'The author lets this device change the book: the text can be edited and interludes played.')}</p> : null}
          </div>
        </div>
        {albumEmpty(counts) && sides === 0 ? null : <div className="nr-book-tabs"><BookTabs book={book} value="text" counts={counts} sides={sides} t={t} /></div>}
        {lines !== undefined && line !== undefined ? (
          <div className="nr-lines">
            <p className="nv-muted nv-small">{t('这个故事不止一种走法。选一条线读：', 'This story goes more than one way. Choose a line to read: ')}</p>
            <div className="nr-lines-row" role="radiogroup" aria-label={t('剧情线', 'Line of the plot')}>
              {lines.map((item) => {
                const from = item.from !== undefined ? chapters.find(chapter => chapter.id === item.from) ?? undefined : undefined
                return (
                  <button key={item.id} type="button" role="radio" aria-checked={item.id === line.id} className={cx('nr-line', item.id === line.id && 'is-active')} onClick={() => { onLine(item.id) }}>
                    <strong>{item.id === MAIN ? t('主线', 'The main line') : item.title}</strong>
                    <span>{item.id === MAIN ? t(`${item.path.length} 章`, `${item.path.length} chapters`) : t(`${item.from !== undefined ? '从中途分出' : '另一种开头'} · 自己的 ${item.own} 章`, `${item.from !== undefined ? 'parts on the way' : 'another beginning'} · ${item.own} chapters of its own`)}{from !== undefined && item.id === line.id ? t(`（第 ${from.index} 章之后）`, ` (after chapter ${from.index})`) : ''}</span>
                  </button>
                )
              })}
            </div>
            {line.premise !== undefined ? <p className="nr-line-premise">{line.premise}</p> : null}
          </div>
        ) : null}
        <ol className="nr-chapters">
          {chapters.map(chapter => (
            <li key={chapter.id}>
              <button type="button" className={cx('nr-chapter', chapter.id === last && 'is-last', chapter.line !== undefined && 'is-branch')} onClick={() => { go({ book: book.id, chapter: chapter.id }) }}>
                <span className="nr-chapter-index">{chapter.index}</span>
                <span className="nr-chapter-title">{chapter.line !== undefined ? <Icon name="branch" size={12} /> : null}{chapter.title}</span>
                {(chapter.drawn ?? 0) > 0 || chapter.video === true ? <span className="nr-chapter-audio" title={chapter.video === true ? t('有成片视频', 'Has a finished video') : t('有有声漫', 'Has a motion comic')}><Icon name="film" size={13} /></span> : null}
                {chapter.voiced > 0 ? <span className="nr-chapter-audio" title={t('有配音', 'Has a voice')}><Icon name="headphones" size={13} /></span> : null}
                <span className="nr-chapter-words">{chapter.words.toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ol>
        {chapters.length === 0 ? <p className="nv-muted">{t('这本书还没有写好的章节。', 'This book has no finished chapter yet.')}</p> : null}
        {credit !== undefined ? <p className="nr-credit">{t('用 ', 'Made with ')}<a href={credit.url} target="_blank" rel="noreferrer">{credit.name}</a>{t(' 制作', '')}</p> : null}
      </div>
    </div>
  )
}

function Chapter({ book, chapters, chapter, ways, onLine, t }: { book: Book; chapters: ChapterRef[]; chapter: ChapterRef; ways: Way[]; onLine: (line: string) => void; t: Translate }) {
  const data = useLoad(signal => get<ChapterData>(`api/books/${encodeURIComponent(book.id)}/chapters/${encodeURIComponent(chapter.id)}`, signal), [book.id, chapter.id])
  const [prefs, updatePrefs] = useReaderPrefs()
  const [options, updateOptions] = usePlayerOptions()
  const [wanted, setWanted] = useState<ViewMode>(() => {
    try {
      const kept = localStorage.getItem('novel-reader:mode')
      return kept === 'listen' || kept === 'watch' ? kept : 'read'
    } catch {
      return 'read'
    }
  })
  const autoNext = options.autoNext !== false
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const scroller = useRef<HTMLDivElement>(null)
  const carryOn = useRef(false)
  const position = chapters.findIndex(candidate => candidate.id === chapter.id)
  const next = chapters[position + 1]
  const previous = chapters[position - 1]
  const script = data.data?.script
  const lines = useMemo(() => script?.lines ?? [], [script])
  const cues = useMemo(() => script?.cues ?? [], [script])
  const panels = useMemo(() => data.data?.board?.panels ?? [], [data.data])
  const placed = useMemo(() => place(panels, lines), [panels, lines])
  const url = useCallback((path: string, version?: string | number) => media(book.id, path, version), [book.id])
  // What there is to watch: the video post-production cut, the comic the page plays, or both — then the one the watcher last chose.
  const video = data.data?.video
  const film: ChapterFilm | undefined = useMemo(() => (video !== undefined ? { src: url(video.path, video.version), ...(video.subtitles !== undefined ? { subtitles: url(video.subtitles, video.version) } : {}), ...(video.burned === true ? { burned: true } : {}), language: book.language.slice(0, 2) } : undefined), [video, url, book.language])
  const filming = film !== undefined && (options.film !== false || placed.length === 0)
  // A chapter with nothing to watch is read instead, one without a script has only its prose; the wish is kept for the next one.
  const mode: ViewMode = data.data === undefined ? wanted
    : wanted === 'watch' && placed.length === 0 && film === undefined ? 'read'
      : wanted === 'listen' && script === undefined ? 'read' : wanted
  const { player, state } = useLinePlayer(lines, cues, url, options, () => {
    if (!autoNext || next === undefined) return
    carryOn.current = true
    go({ book: book.id, chapter: next.id })
  })
  const current = useCurrentPanel(placed, player, state)
  // The player has been started on this chapter: from then on the prose shows which line is spoken, and a line can be pressed to hear from there.
  const engaged = state.index >= 0
  const pace = useMemo(() => ({ seconds: secondsOf(lines[state.index]) / Math.max(0.25, options.rate), paused: state.status === 'paused' }), [lines, state.index, state.status, options.rate])
  const figures = useMemo(() => chapterFigures(data.data?.text, lines), [data.data, lines])
  // Pressing play over the prose turns the page to the script — unless the reader would rather stay.
  const wasIdle = useRef(true)
  useEffect(() => {
    const starting = wasIdle.current && state.status === 'playing'
    wasIdle.current = state.status === 'idle'
    if (starting && mode === 'read' && prefs.follow !== false && script !== undefined) chooseMode('listen')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status])
  // In the script the line being spoken stays in sight.
  useEffect(() => {
    if (mode !== 'listen' || state.index < 0) return
    scroller.current?.querySelector(`[data-script-line="${lines[state.index]?.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [state.index, mode, lines])

  useEffect(() => { remember(book.id, chapter.id) }, [book.id, chapter.id])
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    setDraft(undefined)
    setNotice(undefined)
  }, [chapter.id])
  useEffect(() => {
    document.title = `${chapter.title} · ${book.title}`
  }, [chapter.title, book.title])
  // The chapter that follows one that ran out starts by itself, once it has arrived.
  useEffect(() => {
    if (!carryOn.current || data.data === undefined || data.data.id !== chapter.id) return
    carryOn.current = false
    if (lines.some(line => line.audio !== undefined)) player.play(0)
  }, [data.data, chapter.id, lines, player])
  // The lock screen and the headphones' buttons drive the same player.
  useEffect(() => {
    const session = navigator.mediaSession as MediaSession | undefined
    if (session === undefined || !engaged || typeof MediaMetadata === 'undefined') return
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
  }, [engaged, player, chapter.title, book])
  useEffect(() => {
    if (navigator.mediaSession !== undefined) navigator.mediaSession.playbackState = state.status === 'playing' ? 'playing' : state.status === 'paused' ? 'paused' : 'none'
  }, [state.status])

  const chooseMode = (value: ViewMode): void => {
    setWanted(value)
    try {
      localStorage.setItem('novel-reader:mode', value)
    } catch {
      // Kept for this visit only.
    }
  }
  const save = (): void => {
    if (draft === undefined || saving) return
    setSaving(true)
    setNotice(undefined)
    send<{ words: number; changed: boolean }>('PUT', `api/books/${encodeURIComponent(book.id)}/chapters/${encodeURIComponent(chapter.id)}`, { text: draft }).then((saved) => {
      setDraft(undefined)
      setNotice(saved.changed ? t(`已保存，现在 ${saved.words} 字。改动前的样子在作者那边存了一个版本。`, `Saved, ${saved.words} words now. A version of the text as it was is kept on the author's side.`) : t('没有改动。', 'Nothing changed.'))
      data.reload()
    }, (error: unknown) => {
      setNotice(error instanceof ApiError && error.code === 'read-only' ? t('作者已经把这本书改回只读了。', 'The author has made this book read-only again.') : t('没能保存：连不上作者的电脑。你的改动还在这里，稍后再试。', 'Could not save: the author\'s computer cannot be reached. Your changes are still here; try again later.'))
    }).finally(() => { setSaving(false) })
  }
  const voiced = lines.filter(line => line.audio !== undefined).length
  const editing = draft !== undefined
  const turn = (
    <div className="nr-turn">
      {previous !== undefined ? <button type="button" className="nv-btn nv-btn-outline" onClick={() => { go({ book: book.id, chapter: previous.id }) }}><Icon name="chevronLeft" size={15} /><span>{t('上一章', 'Previous')}</span></button> : null}
      {next !== undefined
        ? <button type="button" className="nv-btn nv-btn-primary" onClick={() => { go({ book: book.id, chapter: next.id }) }}><span>{t('下一章：', 'Next: ')}{next.title}</span><Icon name="chevronRight" size={15} /></button>
        : <span className="nv-muted">{t('—— 已读到最新一章 ——', '— you have reached the latest chapter —')}</span>}
      {ways.length > 0 ? (
        <div className="nr-ways">
          <span className="nv-muted nv-small">{t('故事在这里分开，也可以这样走：', 'The story parts here. It also goes: ')}</span>
          {ways.map(way => (
            <button key={way.line.id} type="button" className="nv-btn nv-btn-outline nr-way" onClick={() => { onLine(way.line.id); go({ book: book.id, chapter: way.next.id }) }}>
              <Icon name="branch" size={14} />
              <span>
                <strong>{way.line.id === MAIN ? t('主线', 'The main line') : way.line.title}</strong>
                {way.leaves && way.line.choice !== undefined ? <em>{way.line.choice}</em> : null}
                <small>{t('接着读：', 'Goes on with: ')}{way.next.title}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <div className={cx('nv-reader', `is-${prefs.theme}`, (mode === 'listen' || engaged) && mode !== 'watch' && 'is-listen')}>
      <header className="nv-reader-bar nr-bar">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" onClick={() => { go({ book: book.id }) }} title={t('目录', 'Contents')} aria-label={t('目录', 'Contents')}><Icon name="list" size={16} /></button>
        <span className="nr-bar-title">{book.title}</span>
        {editing ? null : (
          <ModeSwitch
            mode={mode === 'watch' ? undefined : mode}
            onChange={chooseMode}
            t={t}
            pages
            extra={placed.length > 0 || film !== undefined ? (
              <button type="button" role="tab" aria-selected={mode === 'watch'} className={cx('nv-mode', mode === 'watch' && 'is-active')} onClick={() => { chooseMode('watch') }}>
                <Icon name="film" size={14} />
                <span>{t('看', 'Watch')}</span>
              </button>
            ) : undefined}
          />
        )}
        {book.mode === 'edit' && !editing && data.data !== undefined ? <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" onClick={() => { player.stop(); chooseMode('read'); setDraft(data.data!.text) }} title={t('编辑这一章', 'Edit this chapter')} aria-label={t('编辑这一章', 'Edit this chapter')}><Icon name="pen" size={15} /></button> : null}
        {editing ? null : <button type="button" className={cx('nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon', typing && 'is-active')} onClick={() => { setTyping(value => !value) }} title={t('阅读设置：字号、纸张、字体、语速、播放与声音', 'Reading settings: type, paper, typeface, speed, playback and sound')} aria-expanded={typing}><Icon name="type" size={15} /></button>}
      </header>
      {typing && !editing ? <ReaderSettings prefs={prefs} update={updatePrefs} options={options} updateOptions={updateOptions} t={t} onClose={() => { setTyping(false) }} /> : null}
      {notice !== undefined ? <p className="nr-notice" onClick={() => { setNotice(undefined) }}>{notice}</p> : null}
      {data.error !== undefined ? <Problem error={data.error} t={t} onRetry={data.reload} /> : editing ? (
        <div className="nr-edit">
          <div className="nr-edit-bar">
            <strong>{t(`编辑：第 ${chapter.index} 章`, `Editing chapter ${chapter.index}`)}</strong>
            <span className="nv-spacer" />
            <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" disabled={saving} onClick={() => { setDraft(undefined) }}>{t('放弃', 'Discard')}</button>
            <button type="button" className="nv-btn nv-btn-primary nv-btn-sm" disabled={saving || draft === data.data?.text} onClick={save}>{saving ? <span className="nv-spinner" style={{ width: 13, height: 13 }} aria-hidden="true" /> : <Icon name="check" size={14} />}<span>{saving ? t('正在保存…', 'Saving…') : t('保存', 'Save')}</span></button>
          </div>
          <textarea className={cx('nr-edit-text', prefs.serif && 'is-serif')} style={{ fontSize: prefs.size }} value={draft} spellCheck={false} onChange={(event) => { setDraft(event.target.value) }} />
        </div>
      ) : mode === 'watch' ? (
        <div className="nv-reader-scroll nr-watch" ref={scroller}>
          {filming ? <Film t={t} film={film} onPlay={() => { player.pause() }} /> : <Theater t={t} player={player} state={state} lines={lines} cues={cues} current={current} media={path => url(path)} options={options} />}
          <div className="nr-watch-head">
            <h1 className="nr-watch-title">{chapter.title}</h1>
            {film !== undefined && placed.length > 0 ? <WatchChoice t={t} film={filming} onChange={(value) => { player.pause(); updateOptions({ film: value }) }} /> : null}
          </div>
          {!filming && voiced === 0 ? <p className="nv-muted nv-small">{t('这一章还没有配音：画面会按阅读速度配着字幕走。', 'This chapter has no voice yet: the panels pass at reading pace, with subtitles.')}</p> : null}
          {turn}
        </div>
      ) : mode === 'listen' && script !== undefined ? (
        <ScriptPage
          t={t}
          lines={lines}
          cues={cues}
          state={state}
          player={player}
          pace={pace}
          figures={figures}
          media={path => url(path)}
          scroller={scroller}
          prefs={prefs}
          header={<header className="nv-reader-head"><span className="nv-reader-kicker">{book.title} · {t(`第 ${chapter.index} 章`, `Chapter ${chapter.index}`)}</span><h1>{chapter.title}</h1></header>}
          footer={turn}
        />
      ) : (
        <ReaderPage
          t={t}
          bookTitle={book.title}
          chapter={chapter}
          text={data.data?.text}
          prefs={prefs}
          media={path => url(path)}
          lines={engaged && script !== undefined ? lines : undefined}
          active={engaged ? state.index : undefined}
          onLine={engaged && script !== undefined ? (index) => { player.play(index) } : undefined}
          sound={script !== undefined ? { lines, cues } : undefined}
          sounding={engaged ? state.sounding : undefined}
          pace={engaged ? pace : undefined}
          scroller={scroller}
          footer={turn}
        />
      )}
      {mode !== 'watch' && !editing && script !== undefined ? (
        <ListenBar
          t={t}
          player={player}
          state={state}
          lines={lines}
          cues={cues}
          options={options}
          update={updateOptions}
          onSettings={() => { setTyping(value => !value) }}
        />
      ) : null}
    </div>
  )
}

// ───────────────────────────── interludes ─────────────────────────────

const failure = (error: unknown, t: Translate): string => (error instanceof ApiError
  ? error.code === 'read-only' ? t('作者已经把这本书改回只读了。', 'The author has made this book read-only again.')
    : error.status >= 500 || error.status === 422 ? error.message
      : error.message
  : t('连不上作者的电脑。', 'The author\'s computer cannot be reached.'))

/** The interludes of a book, and the form that starts a new one. */
function PlayList({ book, chapters, t }: { book: Book; chapters: ChapterRef[]; t: Translate }) {
  const base = `api/books/${encodeURIComponent(book.id)}`
  const plays = useLoad(signal => get<{ plays: PlayRef[] }>(`${base}/plays`, signal), [book.id])
  const cast = useLoad(signal => get<{ cast: CastMember[] }>(`${base}/cast`, signal), [book.id])
  const [situation, setSituation] = useState('')
  const [player, setPlayer] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [anchor, setAnchor] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const members = cast.data?.cast ?? []
  const start = (): void => {
    if (situation.trim().length === 0 || starting) return
    setStarting(true)
    setError(undefined)
    send<{ play: Play }>('POST', `${base}/plays`, { situation, cast: [...new Set([...chosen, ...(player.length > 0 ? [player] : [])])], ...(player.length > 0 ? { player } : {}), ...(anchor.length > 0 ? { anchor } : {}) })
      .then((made) => { go({ book: book.id, play: made.play.id }) }, (failed: unknown) => { setError(failure(failed, t)) })
      .finally(() => { setStarting(false) })
  }
  return (
    <div className="nr-contents">
      <header className="nr-topbar">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" onClick={() => { go({ book: book.id }) }}><Icon name="chevronLeft" size={15} /><span>{book.title}</span></button>
      </header>
      <div className="nr-book">
        <h1 className="nr-section-title">{t('幕间', 'Interludes')}</h1>
        <p className="nv-muted nv-small">{t('幕间是从正文岔出去的一场戏：你扮演一个人物，或者站在场外指挥，导演模型让其他人物按各自的性格回应。它不改动正文。每一回合都会调用作者电脑上配置的模型。', 'An interlude is a scene branched off the story: you play a character, or direct from outside, and the director model has the others answer in character. It never changes the manuscript. Every turn calls the models set up on the author\'s computer.')}</p>
        {plays.error !== undefined ? <Problem error={plays.error} t={t} onRetry={plays.reload} /> : plays.data === undefined ? <div className="nv-center"><span className="nv-spinner" style={{ width: 18, height: 18 }} aria-hidden="true" /></div> : plays.data.plays.length > 0 ? (
          <ol className="nr-chapters">
            {plays.data.plays.map(item => (
              <li key={item.id}>
                <button type="button" className="nr-chapter" onClick={() => { go({ book: book.id, play: item.id }) }}>
                  <span className="nr-chapter-index"><Icon name="gamepad" size={14} /></span>
                  <span className="nr-chapter-title">{item.title}</span>
                  <span className="nr-chapter-words">{item.ended ? t('已落幕', 'ended') : t(`${item.turns} 回合`, `${item.turns} turns`)}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : <p className="nv-muted">{t('还没有幕间。在下面开一场。', 'No interlude yet. Start one below.')}</p>}
        <section className="nr-card">
          <h2>{t('开一场新的', 'Start a new one')}</h2>
          <label className="nr-field">
            <span>{t('开场情境', 'Where things stand as it opens')}</span>
            <textarea className="nv-input nr-area" rows={4} value={situation} placeholder={t('例：拍卖结束的那天夜里，白页在清剿舰的货舱里遇到了伊瑟。', 'e.g. The night after the auction, she meets Iser in the hold of the ship.')} onChange={(event) => { setSituation(event.target.value) }} />
          </label>
          <label className="nr-field">
            <span>{t('你扮演', 'You play')}</span>
            <select className="nv-input nv-select" value={player} onChange={(event) => { setPlayer(event.target.value) }}>
              <option value="">{t('不扮演谁——在场外指挥', 'Nobody — direct from outside')}</option>
              {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </label>
          {members.length > 0 ? (
            <div className="nr-field">
              <span>{t('在场的人物', 'Who is in the scene')}</span>
              <div className="nr-picks">
                {members.filter(member => member.id !== player).map(member => (
                  <button key={member.id} type="button" className={cx('nv-chip nr-pick', chosen.includes(member.id) && 'is-active')} aria-pressed={chosen.includes(member.id)} onClick={() => { setChosen(previous => (previous.includes(member.id) ? previous.filter(id => id !== member.id) : [...previous, member.id])) }}>{member.name}</button>
                ))}
              </div>
            </div>
          ) : null}
          {chapters.length > 0 ? (
            <label className="nr-field">
              <span>{t('从哪一章之后岔出去', 'Branching off after')}</span>
              <select className="nv-input nv-select" value={anchor} onChange={(event) => { setAnchor(event.target.value) }}>
                <option value="">{t('最新写好的一章', 'The latest written chapter')}</option>
                {chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{`${chapter.index}. ${chapter.title}`}</option>)}
              </select>
            </label>
          ) : null}
          {error !== undefined ? <p className="nv-note is-warn">{error}</p> : null}
          <button type="button" className="nv-btn nv-btn-primary" disabled={situation.trim().length === 0 || starting} onClick={start}>
            {starting ? <span className="nv-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> : <Icon name="play" size={15} />}
            <span>{starting ? t('导演正在搭这场戏…', 'The director is setting the scene…') : t('开场', 'Begin')}</span>
          </button>
        </section>
      </div>
    </div>
  )
}

/** One interlude, played: what has happened so far, and what you say or do next. */
function PlayScreen({ book, playId, t }: { book: Book; playId: string; t: Translate }) {
  const base = `api/books/${encodeURIComponent(book.id)}/plays/${encodeURIComponent(playId)}`
  const loaded = useLoad(signal => get<{ play: Play }>(base, signal), [book.id, playId])
  const [kind, setKind] = useState<'say' | 'do'>('say')
  const [text, setText] = useState('')
  const [waiting, setWaiting] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const end = useRef<HTMLDivElement>(null)
  const play = loaded.data?.play
  const turns = play?.turns.length ?? 0
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [turns, waiting])
  useEffect(() => {
    if (play !== undefined) document.title = `${play.title} · ${book.title}`
  }, [play?.title, book.title])
  if (loaded.error !== undefined) return <Problem error={loaded.error} t={t} onRetry={loaded.reload} />
  if (play === undefined) return <div className="nv-center"><span className="nv-spinner" style={{ width: 20, height: 20 }} aria-hidden="true" /></div>
  const last = play.turns.at(-1)
  const over = last?.ended === true
  const act = (input: { kind: 'say' | 'do' | 'choice' | 'direct'; text: string }): void => {
    if (input.text.trim().length === 0 || waiting !== undefined) return
    setWaiting(input.text.trim())
    setError(undefined)
    send<{ play: Play }>('POST', `${base}/turns`, input).then((next) => {
      loaded.set(next)
      setText('')
    }, (failed: unknown) => { setError(failure(failed, t)) }).finally(() => { setWaiting(undefined) })
  }
  const rewind = (): void => {
    if (waiting !== undefined) return
    setError(undefined)
    send<{ play: Play }>('POST', `${base}/rewind`, {}).then((next) => { loaded.set(next) }, (failed: unknown) => { setError(failure(failed, t)) })
  }
  return (
    <div className="nr-play">
      <header className="nv-reader-bar nr-bar">
        <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon" onClick={() => { go({ book: book.id, play: true }) }} title={t('幕间列表', 'Interludes')} aria-label={t('幕间列表', 'Interludes')}><Icon name="chevronLeft" size={16} /></button>
        <span className="nr-bar-title">{play.title}</span>
        {play.turns.length > 1 ? <button type="button" className="nv-btn nv-btn-ghost nv-btn-sm" disabled={waiting !== undefined} onClick={rewind} title={t('撤回上一回合', 'Take the last turn back')}><Icon name="undo" size={14} /><span>{t('撤回', 'Undo')}</span></button> : null}
      </header>
      {/* As it went so far — the same transcript a side story is read as — and after it what is still being answered. */}
      <PlayTranscript t={t} play={play} media={path => media(book.id, path)}>
        {waiting !== undefined ? (
          <div className="nr-play-turn">
            <p className="nr-play-input">{waiting}</p>
            <p className="nv-muted nr-play-wait"><span className="nv-spinner" style={{ width: 13, height: 13 }} aria-hidden="true" /> {t('导演正在让他们回应…', 'The director is having them answer…')}</p>
          </div>
        ) : null}
        {error !== undefined ? <p className="nv-note is-warn">{error}</p> : null}
        <div ref={end} />
      </PlayTranscript>
      {over ? null : (
        <div className="nr-play-controls">
          {waiting === undefined && last !== undefined && last.choices.length > 0 ? (
            <div className="nr-play-choices">
              {last.choices.map((choice, index) => <button key={index} type="button" className="nv-btn nv-btn-outline nr-play-choice" onClick={() => { act({ kind: 'choice', text: choice }) }}>{choice}</button>)}
            </div>
          ) : null}
          <form className="nr-play-form" onSubmit={(event) => { event.preventDefault(); act({ kind: play.player === undefined ? 'direct' : kind, text }) }}>
            {play.player !== undefined ? (
              <div className="nv-modes nv-modes-sm" role="tablist">
                <button type="button" role="tab" aria-selected={kind === 'say'} className={cx('nv-mode', kind === 'say' && 'is-active')} onClick={() => { setKind('say') }}>{t('说', 'Say')}</button>
                <button type="button" role="tab" aria-selected={kind === 'do'} className={cx('nv-mode', kind === 'do' && 'is-active')} onClick={() => { setKind('do') }}>{t('做', 'Do')}</button>
              </div>
            ) : null}
            <input className="nv-input" value={text} disabled={waiting !== undefined} placeholder={play.player === undefined ? t('告诉导演接下来发生什么', 'Tell the director what happens next') : kind === 'say' ? t('你说……', 'You say…') : t('你做……', 'You do…')} onChange={(event) => { setText(event.target.value) }} />
            <button type="submit" className="nv-btn nv-btn-primary nv-btn-icon" disabled={text.trim().length === 0 || waiting !== undefined} aria-label={t('发送', 'Send')}><Icon name="send" size={15} /></button>
          </form>
        </div>
      )}
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
      {place.book === undefined ? <Shelf t={t} /> : <BookScreen key={place.book} id={place.book} place={place} t={t} />}
    </div>
  )
}

// A published site opens the way its author reads, until whoever visits sets something of their own.
try {
  const written = document.querySelector('meta[name="novel-defaults"]')?.getAttribute('content')
  if (written !== null && written !== undefined && written.length > 0) setReaderDefaults(JSON.parse(written) as Parameters<typeof setReaderDefaults>[0])
} catch {
  // Not readable: the reader's own defaults, as everywhere else.
}

const style = document.createElement('style')
style.textContent = `${studioStyles}\n${ownStyles}`
document.head.appendChild(style)
const mount = document.getElementById('app')
if (mount !== null) createRoot(mount).render(<App />)

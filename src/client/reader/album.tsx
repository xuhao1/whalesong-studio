// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The album: the people and the world of a book, to be looked at and walked
 * through. It is the part of the viewer that is not the text — what a printed
 * collection of settings would be, except that one steps from a city into a
 * house in it, from the house to its people, from somebody to where they live,
 * and a slider says at which chapter of the story all of it is seen.
 *
 *   AlbumView   all of it: the people, somebody's page, the world, the page
 *               of a place, a house, a thing or an idea — a place's picture a
 *               scene, with what stands in the place marked on it to step into
 *   ViewerTabs  the halves of the viewer — the text, the people, the world
 *
 * Like the rest of the viewer it knows nothing of the Studio: it is handed the
 * album (`shared/album.ts`), a way to turn a path of the book's files into a
 * URL, where it stands and how to go elsewhere. The author's Studio adds its
 * own through two openings — a way to the page where a thing is edited, and
 * tools on the first page of the world.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { albumEmpty, entryImageAt, entryStateAt, standingAt, worldFront, type Album, type AlbumAt, type AlbumCounts, type AlbumEntry, type AlbumEvent, type AlbumPerson, type EntryState } from '../../shared/album'
import { lifeLine, type LifeEvent, type LifeStanding } from '../../shared/life'
import { layoutSpots, spotKey, type ScenePoint } from '../../shared/scene'
import { neighbours, STANDINGS, tiesAt, trail, type Standing, type Tie, type TieEnd } from '../../shared/ties'
import { MAIN_LINE, type CharacterRole } from '../../shared/types'
import type { WorldGroup } from '../../shared/world'
import { Icon, type IconName } from '../icons'
import { AroundGraph, bondsOf } from './around'
import type { Translate } from './parts'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

export const STANDING_LABELS: Record<Standing, [string, string]> = {
  parent: ['在这里面', 'Is in'],
  children: ['这里有', 'In it'],
  seat: ['坐落在', 'Has its seat at'],
  seated: ['坐落在这里的', 'Seated here'],
  houses: ['属于', 'Belongs to'],
  members: ['这里的人', 'Its people'],
  homes: ['住在', 'Lives at'],
  residents: ['住在这里的人', 'Who lives here'],
  things: ['持有', 'Holds'],
  holders: ['在谁手里', 'Held by'],
}

const GROUP_ICON: Record<WorldGroup, IconName> = { places: 'home', factions: 'users', items: 'star', ideas: 'globe' }

const ROLE_NAME: Record<CharacterRole, [string, string]> = {
  protagonist: ['主角', 'Lead'],
  deuteragonist: ['第二主角', 'Second lead'],
  antagonist: ['反派', 'Antagonist'],
  supporting: ['配角', 'Supporting'],
  minor: ['次要人物', 'Minor'],
  cameo: ['龙套', 'Walk-on'],
}

/** The parts the people are laid out by: the leads large, the long tail small. */
const CASTS: { key: string; roles: CharacterRole[]; label: [string, string] }[] = [
  { key: 'leads', roles: ['protagonist', 'deuteragonist'], label: ['主角', 'The leads'] },
  { key: 'against', roles: ['antagonist'], label: ['反派', 'Against them'] },
  { key: 'supporting', roles: ['supporting'], label: ['配角', 'Supporting parts'] },
  { key: 'rest', roles: ['minor', 'cameo'], label: ['次要人物与龙套', 'Minor parts and walk-ons'] },
]

const LIFE_LABEL: Record<LifeStanding, [string, string]> = {
  planned: ['还没登场', 'not on yet'],
  active: ['在场', 'present'],
  offstage: ['暂离', 'away'],
  retired: ['已离开', 'gone'],
  dead: ['已故', 'dead'],
}

/** How a place, a house or a thing stands, where that is worth saying: being there is not. */
const ENTRY_STATE: Record<Exclude<EntryState, 'there'>, [string, string]> = {
  before: ['那时还没有', 'not there yet'],
  declined: ['已衰败', 'in decline'],
  gone: ['已不在了', 'no more'],
}

/** The kinds of thing the first page of the world lays out by weight. */
const KIND_LABEL: Record<'places' | 'factions' | 'items', [string, string]> = {
  places: ['地方', 'Places'],
  factions: ['家族与组织', 'Houses'],
  items: ['物品', 'Things'],
}

/** How much of the story a thing carries, as the first page of the world heads its rows. */
const WEIGHT_LABEL: Record<'core' | 'major' | 'minor', [string, string]> = {
  core: ['核心', 'At the heart of the story'],
  major: ['重要', 'Important'],
  minor: ['次要与路过', 'Minor, and passed by'],
}

/** What the fold over the long tail of a kind says is behind it. */
const REST_LABEL: Record<'places' | 'factions' | 'items', [string, string]> = {
  places: ['个次要的、只路过的地方', 'places of less weight'],
  factions: ['个次要的家族与组织', 'houses of less weight'],
  items: ['件次要的物品', 'things of less weight'],
}

const COURSE_LABEL: Record<AlbumEvent['kind'], [string, string]> = {
  begin: ['开始', 'begins'],
  change: ['变动', 'changes'],
  decline: ['衰败', 'declines'],
  end: ['终结', 'ends'],
}

const EVENT_LABEL: Record<LifeEvent['kind'], [string, string]> = {
  enter: ['登场', 'comes on'],
  seen: ['在场', 'is there'],
  return: ['回来', 'returns'],
  exit: ['离开', 'leaves'],
  death: ['死亡', 'dies'],
}

export interface AlbumProps {
  t: Translate
  album: Album
  /** The URL of one of the book's own files. */
  media: (path: string) => string
  at: AlbumAt
  go: (at: AlbumAt) => void
  /**
   * Open a chapter to be read: from a line of somebody's life, from where a place is named.
   * `names`: what the page come from is called — the chapter opens where it first has one of them.
   */
  onRead?: ((chapter: string, names?: readonly string[]) => void) | undefined
  /** Come here from somewhere to go back to — the place in the text where a name was pressed: said first on every page. */
  back?: { label: string; go: () => void } | undefined
  /** The author's: the way to the page where a thing is edited. */
  onEdit?: ((end: TieEnd) => void) | undefined
  /** The author's: tools on the first page of the world. */
  worldTools?: ReactNode
  /**
   * The author's: put the mark of something at a spot of a place's picture, let
   * it be laid out by itself again (no `at`), or let every mark of the picture go (no `key`).
   * Given, a scene can be arranged; left out, it is as it was arranged.
   */
  onPin?: ((entry: string, key: string | undefined, at: ScenePoint | undefined) => void) | undefined
  /**
   * A reader's: the chapter they last read, by its place in reading order. Given, the slider offers
   * "as far as I have read" — the people and the world with nothing of what comes after.
   */
  readTo?: number | undefined
  /**
   * The ways through the story the album can be of, where the book goes more than one way: the main line first.
   * Given with `onWay`, the bar that tells the time also tells whose world this is, and changes it — who is met,
   * who has died, what has been built are as that line has them.
   */
  ways?: readonly { id: string; title: string }[] | undefined
  onWay?: ((line: string) => void) | undefined
}

/** The halves of the viewer: the text, the people, the world, and the side stories the author kept. */
export type ViewerHalf = 'text' | 'people' | 'world' | 'sides'

/**
 * The halves of the viewer, to change between. A half with nothing in it is
 * not offered, and where there is only the text there is nothing to change between.
 */
export function ViewerTabs({ t, value, onChange, counts, sides }: { t: Translate; value: ViewerHalf; onChange: (value: ViewerHalf) => void; counts: AlbumCounts | undefined; sides?: number | undefined }) {
  const kept = sides ?? 0
  if (albumEmpty(counts) && kept === 0) return null
  const world = counts !== undefined ? counts.places + counts.factions + counts.items + counts.ideas : 0
  const tabs: { value: ViewerHalf; icon: IconName; label: string }[] = [
    { value: 'text', icon: 'book', label: t('正文', 'Text') },
    ...((counts?.people ?? 0) > 0 ? [{ value: 'people' as const, icon: 'users' as IconName, label: t('人物', 'People') }] : []),
    ...(world > 0 ? [{ value: 'world' as const, icon: 'globe' as IconName, label: t('世界', 'World') }] : []),
    ...(kept > 0 ? [{ value: 'sides' as const, icon: 'gamepad' as IconName, label: t('番外', 'Side stories') }] : []),
  ]
  return (
    <div className="nv-album-tabs" role="tablist">
      {tabs.map(tab => (
        <button key={tab.value} type="button" role="tab" aria-selected={tab.value === value} className={cx(tab.value === value && 'is-active')} onClick={() => { onChange(tab.value) }}>
          <Icon name={tab.icon} size={13} />
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  )
}

/** What was written of something, laid out: paragraphs, the odd heading, lists. Not a Markdown engine — the few marks a note has. */
function Prose({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let list: string[] = []
  const plain = (line: string): string => line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2').replace(/`([^`]+)`/g, '$1')
  const flush = (): void => {
    if (list.length === 0) return
    blocks.push(<ul key={blocks.length}>{list.map((item, index) => <li key={index}>{plain(item)}</li>)}</ul>)
    list = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) {
      flush()
      continue
    }
    const item = /^[-*•]\s+(.*)$/.exec(line)
    if (item !== null) {
      list.push(item[1]!)
      continue
    }
    flush()
    const head = /^#{1,6}\s+(.*)$/.exec(line)
    blocks.push(head !== null ? <h4 key={blocks.length}>{plain(head[1]!)}</h4> : <p key={blocks.length}>{plain(line)}</p>)
  }
  flush()
  return <div className="nv-album-prose">{blocks}</div>
}

/** Somebody's picture: the bust, else the front view of their design sheet, else the first character of their name. */
function Face({ person, media, className }: { person: AlbumPerson; media: (path: string) => string; className?: string }) {
  if (person.portrait !== undefined) return <img className={cx('nv-photo', className)} alt={person.name} loading="lazy" src={media(person.portrait)} />
  if (person.sheet !== undefined && person.sheetFront === true) return <img className={cx('nv-photo', className)} alt={person.name} loading="lazy" src={media(person.sheet)} />
  // A sheet shows the same person three times; its left third is the front view.
  if (person.sheet !== undefined) return <span className={cx('nv-photo is-sheet', className)} role="img" aria-label={person.name} style={{ backgroundImage: `url("${media(person.sheet)}")` }} />
  return <span className={cx('nv-photo is-empty', className)} aria-hidden="true">{person.name.slice(0, 1)}</span>
}

/**
 * The album of a book.
 * @param at - where it stands: one of its two halves, or the page of one thing.
 * @param go - how it goes elsewhere; whoever shows the album keeps where it is.
 */
export function AlbumView({ t, album, media, at, go, onRead, onEdit, worldTools, onPin, readTo, ways, onWay, back }: AlbumProps) {
  const [moment, setMoment] = useState<number | undefined>()
  // Another way through the story counts its chapters by itself: a chapter looked at on one is not that chapter on another.
  const along = album.line?.id ?? MAIN_LINE
  useEffect(() => { setMoment(undefined) }, [along])
  const [zoom, setZoom] = useState<string | undefined>()
  const [more, setMore] = useState<Record<string, boolean>>({})
  const top = useRef<HTMLDivElement>(null)
  const people = useMemo(() => new Map(album.people.map(person => [person.id, person])), [album.people])
  const entries = useMemo(() => new Map(album.world.map(entry => [entry.id, entry])), [album.world])
  const order = useMemo(() => new Map(album.chapters.map(chapter => [chapter.id, chapter.index])), [album.chapters])
  const byIndex = useMemo(() => new Map(album.chapters.map(chapter => [chapter.index, chapter])), [album.chapters])
  const ties = useMemo(() => tiesAt(album.ties, moment, chapter => order.get(chapter)), [album.ties, moment, order])
  const first = album.chapters[0]?.index ?? 1
  const last = album.chapters.at(-1)?.index ?? 0
  // Another page of the album starts at its top.
  const key = `${at.section}:${at.end?.type ?? ''}:${at.end?.id ?? ''}`
  useEffect(() => { top.current?.scrollIntoView({ block: 'start' }) }, [key])

  const nameOf = (end: TieEnd): string => (end.type === 'character' ? people.get(end.id)?.name : entries.get(end.id)?.name) ?? end.id
  const pictured = (end: TieEnd): boolean => {
    const person = end.type === 'character' ? people.get(end.id) : undefined
    const thing = entries.get(end.id)
    return person !== undefined ? (person.portrait ?? person.sheet) !== undefined : thing !== undefined && imageOf(thing) !== undefined
  }
  const standing = (person: AlbumPerson): LifeStanding | undefined => standingAt(album, person.id, moment)
  /** How a place, a house or a thing stands at the chapter looked at; unsaid when the story is looked at whenever. */
  const stateOf = (item: AlbumEntry): EntryState => (moment !== undefined ? entryStateAt(item, moment) : 'there')
  /** The picture of a place, a house or a thing as the story stands at the chapter looked at. */
  const imageOf = (item: AlbumEntry): string | undefined => entryImageAt(item, moment)
  /** Whether something is there to be met at the chapter looked at: a place not built yet is not. */
  const there = (end: TieEnd): boolean => {
    const item = end.type === 'world' ? entries.get(end.id) : undefined
    return item === undefined || stateOf(item) !== 'before'
  }
  const span = (tie: Tie): string => {
    const since = tie.since !== undefined ? order.get(tie.since) : undefined
    const until = tie.until !== undefined ? order.get(tie.until) : undefined
    if (since !== undefined && until !== undefined) return t(`第 ${since}–${until} 章`, `ch. ${since}–${until}`)
    if (since !== undefined) return t(`第 ${since} 章起`, `from ch. ${since}`)
    if (until !== undefined) return t(`到第 ${until} 章`, `until ch. ${until}`)
    return ''
  }
  const open = (end: TieEnd): void => { go({ section: end.type === 'character' ? 'people' : 'world', end }) }

  /** Something to step over to: with its picture when it has one, a line with its name when it has none — a wall of grey boxes shows nothing. */
  const tile = (end: TieEnd, tie?: Tie, note?: string): ReactNode => {
    const person = end.type === 'character' ? people.get(end.id) : undefined
    const entry = end.type === 'world' ? entries.get(end.id) : undefined
    if (person === undefined && entry === undefined) return null
    const how = person !== undefined ? standing(person) : undefined
    const state = entry !== undefined ? stateOf(entry) : 'there'
    const meta = [
      note ?? (person !== undefined ? (how !== undefined ? t(...LIFE_LABEL[how]) : person.tagline ?? '') : state !== 'there' ? t(...ENTRY_STATE[state]) : entry!.summary ?? ''),
      tie !== undefined ? span(tie) : '',
    ].filter(part => part.length > 0).join(' · ')
    const classes = cx('nv-explore-tile', person !== undefined && 'is-person', how !== undefined && `is-${how}`, state === 'gone' && 'is-gone', state === 'declined' && 'is-declined')
    const id = `${end.type}:${end.id}:${tie?.id ?? note ?? ''}`
    if (!pictured(end)) {
      return (
        <button key={id} type="button" className={cx(classes, 'is-plain')} onClick={() => { open(end) }} title={tie?.note}>
          <span className="nv-explore-tile-mark" aria-hidden="true">{person !== undefined ? person.name.slice(0, 1) : <Icon name={GROUP_ICON[entry!.group]} size={15} />}</span>
          <span className="nv-explore-tile-words">
            <span className="nv-explore-tile-name">{nameOf(end)}</span>
            {meta.length > 0 ? <span className="nv-explore-tile-meta">{meta}</span> : null}
          </span>
        </button>
      )
    }
    return (
      <button key={id} type="button" className={classes} onClick={() => { open(end) }} title={tie?.note}>
        {person !== undefined ? <Face person={person} media={media} className="nv-explore-tile-art" /> : <img className="nv-explore-tile-art" alt="" loading="lazy" src={media(imageOf(entry!)!)} />}
        <span className="nv-explore-tile-name">{nameOf(end)}</span>
        {meta.length > 0 ? <span className="nv-explore-tile-meta">{meta}</span> : null}
      </button>
    )
  }
  /** Things laid out for stepping into: those there is a picture of in a row of their own, large; the rest as lines under them. */
  const rows = (all: { end: TieEnd; tie?: Tie; note?: string }[]): ReactNode => {
    const items = all.filter(item => there(item.end))
    const drawn = items.filter(item => pictured(item.end))
    const plain = items.filter(item => !pictured(item.end))
    return (
      <>
        {drawn.length > 0 ? <div className="nv-explore-grid is-drawn">{drawn.map(item => tile(item.end, item.tie, item.note))}</div> : null}
        {plain.length > 0 ? <div className="nv-explore-grid">{plain.map(item => tile(item.end, item.tie, item.note))}</div> : null}
      </>
    )
  }
  const worldRows = (list: readonly AlbumEntry[]): ReactNode => rows(list.map(entry => ({ end: { type: 'world' as const, id: entry.id } })))

  const way = ways !== undefined && ways.length > 1 && onWay !== undefined ? (
    <label className="nv-album-way" title={t('选一条线，按这条线看人物和世界', 'Choose a line to see the people and the world along it')}>
      <Icon name="branch" size={13} />
      <select value={along} onChange={(event) => { onWay(event.target.value) }} aria-label={t('看哪一条线上的人物和世界', 'The line whose people and world are shown')}>
        {ways.map(item => <option key={item.id} value={item.id}>{item.id === MAIN_LINE ? t('★ 主线', '★ Main line') : item.title}</option>)}
      </select>
    </label>
  ) : null
  const time = last > first || way !== null ? (
    <div className="nv-explore-time">
      {way}
      {last > first ? <div className="nv-seg" role="group">
        <button type="button" className={cx(moment === undefined && 'is-active')} onClick={() => { setMoment(undefined) }}>{t('不分时间', 'Whenever')}</button>
        <button type="button" className={cx(moment !== undefined && 'is-active')} onClick={() => { setMoment(moment ?? last) }}>{t('故事进行到…', 'As the story stood at…')}</button>
        {readTo !== undefined && readTo >= first && readTo < last ? <button type="button" className={cx(moment === readTo && 'is-mine')} onClick={() => { setMoment(readTo) }} title={t('只看到我读到的地方：之后才登场的人、才发生的事都不显示', 'Only as far as I have read: nobody who comes on later, nothing that happens later')}>{t(`我读到的第 ${readTo} 章`, `Where I am: ch. ${readTo}`)}</button> : null}
      </div> : null}
      {moment !== undefined && last > first ? (
        <>
          <input className="nv-range" type="range" min={first} max={last} step={1} value={moment} onChange={(event) => { setMoment(Number(event.target.value)) }} aria-label={t('故事进行到第几章', 'How far the story has come')} />
          <strong>{t(`第 ${moment} 章`, `Chapter ${moment}`)}</strong>
          <span className="nv-muted nv-small">{byIndex.get(moment)?.title ?? ''}</span>
        </>
      ) : null}
    </div>
  ) : null

  const lightbox = zoom !== undefined ? (
    <button type="button" className="nv-album-zoom" onClick={() => { setZoom(undefined) }} aria-label={t('关上大图', 'Close the picture')}>
      <img alt="" src={media(zoom)} />
    </button>
  ) : null
  const backLink = back !== undefined ? <button type="button" className="nv-btn nv-btn-sm nv-btn-outline nv-album-back" onClick={back.go}><Icon name="chevronLeft" size={13} /><span>{back.label}</span></button> : null
  const chapterChip = (index: number, names?: readonly string[]): ReactNode => {
    const chapter = byIndex.get(index)
    return chapter !== undefined && onRead !== undefined
      ? <button key={index} type="button" className="nv-album-chapter" onClick={() => { onRead(chapter.id, names) }} title={names !== undefined ? t(`${chapter.title}——去读写到它的地方`, `${chapter.title} — to where it is named`) : chapter.title}>{index}</button>
      : <span key={index} className="nv-album-chapter is-still">{index}</span>
  }

  // What a kind of thing has to show at the chapter looked at: a place nothing has come to yet is not there.
  const tied = new Set(ties.flatMap(tie => [tie.from, tie.to]).filter(end => end.type === 'world').map(end => end.id))
  const seenBy = (candidate: AlbumEntry): boolean => moment === undefined || candidate.group === 'ideas' || ((candidate.chapters.some(index => index <= moment) || tied.has(candidate.id)) && stateOf(candidate) !== 'before')
  const of = (group: WorldGroup): AlbumEntry[] => album.world.filter(candidate => candidate.group === group && seenBy(candidate))

  // An album is leafed through: from a page to the one before and the one after it, in the order its kind is laid out by.
  const person = at.end?.type === 'character' ? people.get(at.end.id) : undefined
  const entry = at.end?.type === 'world' ? entries.get(at.end.id) : undefined
  // …which is the order of the first pages: part by part or weight by weight, and within each, whoever has a picture first.
  const drawnFirst = <T,>(list: readonly T[], drawn: (item: T) => boolean): T[] => [...list.filter(drawn), ...list.filter(item => !drawn(item))]
  const leaves: TieEnd[] = person !== undefined
    ? CASTS.flatMap(cast => drawnFirst(album.people.filter(candidate => cast.roles.includes(candidate.role) && (moment === undefined || standing(candidate) !== 'planned' || candidate.id === person.id)), candidate => (candidate.portrait ?? candidate.sheet) !== undefined)).map(candidate => ({ type: 'character' as const, id: candidate.id }))
    : entry !== undefined
      ? (() => {
          const kind = album.world.filter(candidate => candidate.group === entry.group && (seenBy(candidate) || candidate.id === entry.id))
          const front = worldFront(kind, ties)
          const tiers = entry.group === 'ideas' ? [kind] : [...front.heavy.map(tier => tier.list), front.rest]
          return tiers.flatMap(tier => drawnFirst(tier, candidate => candidate.image !== undefined)).map(candidate => ({ type: 'world' as const, id: candidate.id }))
        })()
      : []
  const leaf = leaves.findIndex(end => end.id === at.end?.id)
  const before = leaf > 0 ? leaves[leaf - 1] : undefined
  const after = leaf >= 0 ? leaves[leaf + 1] : undefined
  const turn = useRef<{ before?: TieEnd | undefined; after?: TieEnd | undefined; open: (end: TieEnd) => void }>({ open })
  turn.current = { before, after, open }
  useEffect(() => {
    // The arrow keys turn the page — unless they are being used for something: typing, a slider, a dialog, a picture opened large.
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target !== undefined && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="dialog"]') !== null)) return
      const to = event.key === 'ArrowLeft' ? turn.current.before : event.key === 'ArrowRight' ? turn.current.after : undefined
      if (to === undefined || top.current === null || top.current.offsetParent === null) return
      event.preventDefault()
      turn.current.open(to)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pager = before !== undefined || after !== undefined ? (
    <nav className="nv-album-pager" aria-label={t('翻页', 'Turn the page')}>
      {before !== undefined ? (
        <button type="button" className="nv-album-turn is-before" onClick={() => { open(before) }}>
          <Icon name="chevronLeft" size={16} />
          <span><small>{t('上一页', 'Before')}</small><strong>{nameOf(before)}</strong></span>
        </button>
      ) : <span />}
      <span className="nv-album-pager-at">{leaf + 1} / {leaves.length}</span>
      {after !== undefined ? (
        <button type="button" className="nv-album-turn is-after" onClick={() => { open(after) }}>
          <span><small>{t('下一页', 'After')}</small><strong>{nameOf(after)}</strong></span>
          <Icon name="chevronRight" size={16} />
        </button>
      ) : <span />}
    </nav>
  ) : null

  // ── somebody's page ──
  if (person !== undefined) {
    return <PersonPage key={person.id} person={person} t={t} album={album} media={media} moment={moment} time={time} rows={rows} ties={ties} go={go} setZoom={setZoom} lightbox={lightbox} top={top} onEdit={onEdit} onRead={onRead} byIndex={byIndex} first={first} last={last} people={people} pager={pager} backLink={backLink} />
  }

  // ── the page of a place, a house, a thing, an idea ──
  if (entry !== undefined) {
    const end: TieEnd = { type: 'world', id: entry.id }
    const around = neighbours(ties, end)
    const up = trail(entry.id, ties)
    const named = moment !== undefined ? entry.chapters.filter(index => index <= moment) : entry.chapters
    const related = (entry.related ?? []).map(id => entries.get(id)).filter((other): other is AlbumEntry => other !== undefined)
    const shownChapters = more.chapters === true ? named : named.slice(0, 24)
    // What stands in the place is marked on its picture: the places in it and the houses seated there first, then whoever lives there or belongs to it.
    const marks: TieEnd[] = []
    // As the story stands at the chapter looked at: a place in ruins by then is shown in ruins, where a picture of that was drawn.
    const picture = imageOf(entry)
    if (picture !== undefined && (entry.group === 'places' || entry.group === 'factions')) {
      for (const how of ['children', 'seated', 'residents', 'members'] as const) {
        for (const item of around[how] ?? []) if (there(item.end) && !marks.some(mark => mark.type === item.end.type && mark.id === item.end.id)) marks.push(item.end)
      }
    }
    const scene = marks.length > 0
    // Marks pinned by hand were put on its usual picture, and a picture of a change or a decline is that sight altered.
    // One of its beginning or of its end is another sight: there the marks are laid out afresh, and nothing is pinned.
    const turned = picture !== entry.image ? (entry.events ?? []).find(event => event.image === picture) : undefined
    const same = turned === undefined || turned.kind === 'change' || turned.kind === 'decline'
    const { spots: _pinned, ...unpinned } = entry
    const state = entryStateAt(entry, moment)
    const course = (entry.events ?? []).filter(event => moment === undefined || event.index <= moment)
    const plate = (
      <div className="nv-explore-hero-text">
        <h2>{entry.name}{state !== 'there' ? <span className={cx('nv-chip', state === 'gone' ? 'nv-chip-red' : state === 'declined' ? 'nv-chip-amber' : 'nv-chip-neutral')}>{t(...ENTRY_STATE[state])}</span> : null}</h2>
        {entry.aliases !== undefined ? <p className="nv-small nv-album-also">{t('又作 ', 'Also ')}{entry.aliases.join(t('、', ', '))}</p> : null}
        {entry.summary !== undefined ? <p>{entry.summary}</p> : null}
        {onEdit !== undefined ? <button type="button" className="nv-btn nv-btn-sm nv-btn-outline nv-album-edit" onClick={() => { onEdit(end) }}><Icon name="pen" size={13} /><span>{t('编辑', 'Edit')}</span></button> : null}
      </div>
    )
    return (
      <div key={key} className="nv-explore nv-album is-page" ref={top}>
        <nav className="nv-explore-trail">
          {backLink}
          <button type="button" className="nv-link" onClick={() => { go({ section: 'world' }) }}>{t('这个世界', 'This world')}</button>
          {up.map(id => <span key={id}><Icon name="chevronRight" size={11} /><button type="button" className="nv-link" onClick={() => { open({ type: 'world', id }) }}>{nameOf({ type: 'world', id })}</button></span>)}
          <span><Icon name="chevronRight" size={11} /><strong>{entry.name}</strong></span>
        </nav>
        {scene ? (
          <Scene
            key={entry.id}
            t={t}
            entry={same ? entry : unpinned}
            src={media(picture!)}
            marks={marks.map((mark) => {
              const who = mark.type === 'character' ? people.get(mark.id) : undefined
              const how = who !== undefined ? standing(who) : undefined
              return { end: mark, name: nameOf(mark), ...(who !== undefined ? { face: <Face person={who} media={media} className="nv-scene-spot-face" /> } : {}), ...(how !== undefined ? { how } : {}) }
            })}
            open={open}
            onZoom={() => { setZoom(picture) }}
            onPin={same ? onPin : undefined}
          >
            {plate}
          </Scene>
        ) : (
          <section className={cx('nv-explore-hero', picture === undefined && 'is-bare', entry.group === 'items' && 'is-thing')}>
            {picture !== undefined ? <button type="button" className="nv-album-hero-open" onClick={() => { setZoom(picture) }} title={t('看大图', 'See it large')}><img className="nv-explore-hero-art" alt="" src={media(picture)} /></button> : null}
            {plate}
          </section>
        )}
        {entry.body !== undefined ? <Prose text={entry.body} /> : null}
        {named.length > 0 ? (
          <p className="nv-album-named">
            <span className="nv-muted">{t(`正文里 ${named.length} 章写到它：`, `Named in ${named.length} chapters: `)}</span>
            {shownChapters.map(index => chapterChip(index, [entry.name, ...(entry.aliases ?? [])]))}
            {named.length > shownChapters.length ? <button type="button" className="nv-link nv-small" onClick={() => { setMore({ ...more, chapters: true }) }}>{t(`…另 ${named.length - shownChapters.length} 章`, `…${named.length - shownChapters.length} more`)}</button> : null}
          </p>
        ) : null}
        {course.length > 0 ? (
          <section className="nv-album-life">
            <h3>{t('它的轨迹', 'Its course')}</h3>
            <ol className="nv-album-events">
              {course.map((event) => {
                const chapter = byIndex.get(event.index)
                return (
                  <li key={`${event.chapter}:${event.kind}`} className={`is-course-${event.kind}`}>
                    {chapter !== undefined && onRead !== undefined
                      ? <button type="button" className="nv-album-event-at" onClick={() => { onRead(chapter.id) }} title={chapter.title}>{t(`第 ${event.index} 章`, `Ch. ${event.index}`)}</button>
                      : <span className="nv-album-event-at">{t(`第 ${event.index} 章`, `Ch. ${event.index}`)}</span>}
                    <span className="nv-album-event-kind">{t(...COURSE_LABEL[event.kind])}</span>
                    <span className="nv-album-event-what">
                      {event.what}
                      {event.image !== undefined ? <button type="button" className="nv-album-event-art" onClick={() => { setZoom(event.image) }} title={t('它这时的样子', 'How it looks then')}><img alt="" loading="lazy" src={media(event.image)} /></button> : null}
                    </span>
                  </li>
                )
              })}
            </ol>
          </section>
        ) : null}
        {entry.group !== 'ideas' ? time : null}
        {STANDINGS.filter(how => (around[how]?.some(item => there(item.end)) ?? false) && !(how === 'parent' && up.length > 0)).map(how => (
          // What a place is in is the way that led here: said above, not again below.
          <div key={how}>
            <h3>{t(...STANDING_LABELS[how])}<span className="nv-muted"> {around[how]!.filter(item => there(item.end)).length}</span></h3>
            {rows(around[how]!)}
          </div>
        ))}
        {related.length > 0 ? <div><h3>{t('相关', 'Goes with')}</h3>{worldRows(related)}</div> : null}
        {entry.group !== 'ideas' && STANDINGS.every(how => (around[how]?.length ?? 0) === 0) ? <p className="nv-muted">{moment !== undefined ? t('故事进行到这一章时，它周围还没有什么。', 'At this chapter of the story, nothing stands around it yet.') : t('它周围还没有记下什么。', 'Nothing is written down around it yet.')}</p> : null}
        {pager}
        {lightbox}
      </div>
    )
  }

  // ── the people ──
  if (at.section === 'people') {
    // At a chapter of the story, whoever has not come on yet is not there to be met.
    const there = album.people.filter(candidate => moment === undefined || standing(candidate) !== 'planned')
    return (
      <div key={key} className="nv-explore nv-album" ref={top}>
        {backLink !== null ? <nav className="nv-explore-trail">{backLink}</nav> : null}
        <header className="nv-explore-top">
          <div>
            <h2>{t('人物', 'People')}</h2>
            <p className="nv-muted">{album.people.length === 0 ? t('这本书还没有人物。', 'This book has nobody in it yet.') : moment !== undefined ? t(`故事进行到第 ${moment} 章时，登场过的有 ${there.length} 位。`, `By chapter ${moment}, ${there.length} have come on.`) : t(`${album.people.length} 位。`, `${album.people.length} people.`)}</p>
          </div>
        </header>
        {time}
        {CASTS.map((cast) => {
          const list = there.filter(candidate => cast.roles.includes(candidate.role))
          if (list.length === 0) return null
          const drawn = list.filter(candidate => pictured({ type: 'character', id: candidate.id }))
          const plain = list.filter(candidate => !pictured({ type: 'character', id: candidate.id }))
          // The long tail without a picture is a wall of names: folded until asked for.
          const folded = cast.key === 'rest' && plain.length > 18 && more[cast.key] !== true
          return (
            <section key={cast.key}>
              <h3>{t(...cast.label)}<span className="nv-muted"> {list.length}</span></h3>
              {drawn.length > 0 ? (
                <div className={cx('nv-album-cast', cast.key === 'leads' && 'is-leads')}>
                  {drawn.map((candidate) => {
                    const how = standing(candidate)
                    return (
                      <button key={candidate.id} type="button" className={cx('nv-album-card', how !== undefined && `is-${how}`)} onClick={() => { open({ type: 'character', id: candidate.id }) }}>
                        <Face person={candidate} media={media} className="nv-album-card-art" />
                        <span className="nv-album-card-plate">
                          <strong>{candidate.name}</strong>
                          <em>{how !== undefined && how !== 'active' ? t(...LIFE_LABEL[how]) : candidate.tagline ?? t(...ROLE_NAME[candidate.role])}</em>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
              {plain.length > 0 && !folded ? <div className="nv-explore-grid">{plain.map(candidate => tile({ type: 'character', id: candidate.id }))}</div> : null}
              {folded ? <button type="button" className="nv-link nv-small" onClick={() => { setMore({ ...more, [cast.key]: true }) }}>{t(`还有 ${plain.length} 位没有画像的`, `${plain.length} more without a picture`)}</button> : null}
            </section>
          )
        })}
        {lightbox}
      </div>
    )
  }

  // ── the world ──
  // Laid out by how much of the story a thing carries, wherever it lies: the garden half the book happens in is met on the first
  // page, though on the map it is a part of a house that is a part of a city. What is in what is told on each thing's own page.
  /** Something on the first page, with where it lies said on it: what a place is in, where a house has its seat. */
  const placed = (candidate: AlbumEntry): { end: TieEnd; note: string } => {
    const end: TieEnd = { type: 'world', id: candidate.id }
    const around = neighbours(ties, end)
    const lies = (around.parent ?? around.seat)?.find(item => there(item.end))
    const state = stateOf(candidate)
    const note = [
      lies !== undefined ? t(`在${nameOf(lies.end)}`, `in ${nameOf(lies.end)}`) : '',
      state !== 'there' ? t(...ENTRY_STATE[state]) : candidate.summary ?? '',
    ].filter(part => part.length > 0).join(' · ')
    return { end, note }
  }
  const tiers = (group: 'places' | 'factions' | 'items'): ReactNode => {
    const all = of(group)
    if (all.length === 0) return null
    const { heavy, rest, outermost: outer } = worldFront(all, ties)
    // The long tail is a wall of names: behind a fold, where there is something above it to look at first.
    // What somebody drew a picture of is never part of that wall.
    const drawn = rest.filter(candidate => candidate.image !== undefined)
    const plain = rest.filter(candidate => candidate.image === undefined)
    const foldable = heavy.length + drawn.length > 0 && plain.length > 12
    const folded = foldable && more[group] !== true
    const shown = folded ? drawn : rest
    // The other way in: from the outermost, a step at a time — where that is not already everything there is.
    const outermost = group === 'items' ? [] : outer
    return (
      <section key={group} className="nv-album-kind">
        <h3>{t(...KIND_LABEL[group])}<span className="nv-muted"> {all.length}</span></h3>
        {outermost.length > 0 && all.length > outermost.length ? (
          <p className="nv-album-outer">
            <span className="nv-muted">{t('从最外面一层层走进去：', 'From the outside in: ')}</span>
            {outermost.map(candidate => <button key={candidate.id} type="button" className="nv-link" onClick={() => { open({ type: 'world', id: candidate.id }) }}>{candidate.name}</button>)}
          </p>
        ) : null}
        {heavy.map(tier => (
          <div key={tier.weight} className={cx('nv-album-tier', `is-${tier.weight}`)}>
            {heavy.length + (rest.length > 0 ? 1 : 0) > 1 ? <h4>{t(...WEIGHT_LABEL[tier.weight])}<span> {tier.list.length}</span></h4> : null}
            {rows(tier.list.map(placed))}
          </div>
        ))}
        {shown.length > 0 ? (
          <div className="nv-album-tier is-rest">
            {heavy.length > 0 ? <h4>{t(...WEIGHT_LABEL.minor)}<span> {rest.length}</span></h4> : null}
            {rows(shown.map(placed))}
          </div>
        ) : null}
        {foldable ? <button type="button" className="nv-link nv-small nv-album-fold" onClick={() => { setMore({ ...more, [group]: folded }) }}>{folded ? t(`还有 ${plain.length} ${REST_LABEL[group][0]}`, `${plain.length} more ${REST_LABEL[group][1]}`) : t('收起', 'Fold')}</button> : null}
      </section>
    )
  }
  const ideas = of('ideas')
  const nothing = album.world.length === 0
  return (
    <div key={key} className="nv-explore nv-album" ref={top}>
      {backLink !== null ? <nav className="nv-explore-trail">{backLink}</nav> : null}
      <header className="nv-explore-top">
        <div>
          <h2>{t('这个世界', 'This world')}</h2>
          <p className="nv-muted">{nothing ? t('这本书的设定里还没有地点、家族、物品和世界观。', 'The book\'s bible has no places, houses, things or ideas yet.') : album.ties.length > 0 ? t('最要紧的排在前面。', 'What matters most comes first.') : t('地点、家族、物品和世界观，最要紧的排在前面。', 'Places, houses, things and ideas, what matters most first.')}</p>
        </div>
        {worldTools}
      </header>
      {time}
      {tiers('places')}
      {tiers('factions')}
      {tiers('items')}
      {ideas.length > 0 ? (
        <section>
          <h3>{t('世界观', 'Ideas of the world')}<span className="nv-muted"> {ideas.length}</span></h3>
          <div className="nv-album-ideas">
            {ideas.map(idea => (
              <button key={idea.id} type="button" className="nv-album-idea" onClick={() => { open({ type: 'world', id: idea.id }) }}>
                <strong>{idea.name}</strong>
                {idea.summary !== undefined ? <span>{idea.summary}</span> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {lightbox}
    </div>
  )
}

/** Something marked on a place's picture. */
interface SceneMark {
  end: TieEnd
  name: string
  /** Somebody's picture; a place or a house has a pin. */
  face?: ReactNode
  how?: LifeStanding
}

/**
 * A place's picture as a scene: what stands in the place is marked on it, each
 * mark a way in. The picture keeps its own shape at a height that shows it, and
 * is moved sideways where the page is narrower than it — the marks stay where
 * they are on it. The author may arrange the marks: drag one to where the thing
 * is in the picture and it is pinned there, for every reader; pressed twice, it
 * goes back to being laid out by itself.
 */
function Scene({ t, entry, src, marks, open, onZoom, onPin, children }: {
  t: Translate
  entry: AlbumEntry
  src: string
  marks: SceneMark[]
  open: (end: TieEnd) => void
  onZoom: () => void
  onPin: AlbumProps['onPin']
  children: ReactNode
}) {
  const pan = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(16 / 9)
  const [arranging, setArranging] = useState(false)
  // Where a mark is while it is dragged, and where it was dropped until the place comes back saying so.
  const [moved, setMoved] = useState<Record<string, ScenePoint>>({})
  const dragging = useRef<string | undefined>(undefined)
  useEffect(() => { setMoved({}) }, [entry.spots])
  const spots = useMemo(() => layoutSpots(marks.map(mark => spotKey(mark.end)), { ...entry.spots, ...moved }), [marks, entry.spots, moved])
  const byKey = useMemo(() => new Map(marks.map(mark => [spotKey(mark.end), mark])), [marks])
  // A picture wider than the page opens on its middle.
  useEffect(() => {
    const element = pan.current
    if (element !== null) element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2
  }, [ratio, entry.id])
  const point = (event: ReactPointerEvent): ScenePoint | undefined => {
    const box = stage.current?.getBoundingClientRect()
    if (box === undefined || box.width === 0 || box.height === 0) return undefined
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) }
  }
  const pinned = spots.filter(spot => spot.pinned).length
  return (
    <section className={cx('nv-explore-hero is-scene', arranging && 'is-arranging')}>
      <div className="nv-scene-pan" ref={pan}>
        <div className="nv-scene-stage" ref={stage} style={{ ['--ratio' as string]: String(ratio) }}>
          <img className="nv-scene-art" alt="" src={src} draggable={false} onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth > 0 && image.naturalHeight > 0) setRatio(image.naturalWidth / image.naturalHeight) }} onClick={() => { if (!arranging) onZoom() }} />
          {spots.map((spot) => {
            const mark = byKey.get(spot.key)
            if (mark === undefined) return null
            return (
              <button
                key={spot.key}
                type="button"
                className={cx('nv-scene-spot', mark.face !== undefined && 'is-person', spot.pinned && 'is-pinned', mark.how !== undefined && `is-${mark.how}`)}
                style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
                title={arranging ? t('拖到画面上它所在的位置；双击让它回到自动排布', 'Drag it to where it is in the picture; press twice to have it laid out by itself again') : mark.name}
                onClick={() => { if (!arranging) open(mark.end) }}
                onDoubleClick={() => { if (arranging && spot.pinned) onPin?.(entry.id, spot.key, undefined) }}
                onPointerDown={(event) => {
                  if (!arranging) return
                  dragging.current = spot.key
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId)
                  } catch {
                    // A pointer that cannot be held is followed while it stays over the mark.
                  }
                }}
                onPointerMove={(event) => {
                  if (dragging.current !== spot.key) return
                  const at = point(event)
                  if (at !== undefined) setMoved(previous => ({ ...previous, [spot.key]: at }))
                }}
                onPointerUp={(event) => {
                  if (dragging.current !== spot.key) return
                  dragging.current = undefined
                  const at = point(event)
                  // A press that went nowhere is not a move.
                  if (at !== undefined && moved[spot.key] !== undefined) onPin?.(entry.id, spot.key, at)
                }}
              >
                {mark.face ?? <span className="nv-scene-spot-pin" aria-hidden="true" />}
                <span className="nv-scene-spot-name">{mark.name}</span>
              </button>
            )
          })}
        </div>
      </div>
      {onPin !== undefined ? (
        <div className="nv-scene-tools">
          {arranging ? <span className="nv-scene-hint">{t('把按钮拖到画面上钉住；双击复位。', 'Drag a button onto the picture to pin it; double-click to release.')}</span> : null}
          {arranging && pinned > 0 ? <button type="button" className="nv-btn nv-btn-sm nv-scene-tool" onClick={() => { onPin(entry.id, undefined, undefined) }}>{t(`全部复位（${pinned}）`, `Let all go (${pinned})`)}</button> : null}
          <button type="button" className={cx('nv-btn nv-btn-sm nv-scene-tool', arranging && 'is-active')} onClick={() => { setArranging(!arranging) }} title={t('摆位置：把画面上的按钮拖到它们在画里的位置', 'Arrange: drag the marks to where the things are in the picture')}>
            <Icon name={arranging ? 'check' : 'pen'} size={12} />
            <span>{arranging ? t('摆好了', 'Done') : t('摆位置', 'Arrange')}</span>
          </button>
        </div>
      ) : null}
      {children}
    </section>
  )
}

interface PersonPageProps {
  person: AlbumPerson
  t: Translate
  album: Album
  media: (path: string) => string
  moment: number | undefined
  time: ReactNode
  rows: (items: { end: TieEnd; tie?: Tie; note?: string }[]) => ReactNode
  ties: Tie[]
  go: (at: AlbumAt) => void
  setZoom: (path: string | undefined) => void
  lightbox: ReactNode
  top: RefObject<HTMLDivElement>
  onEdit: ((end: TieEnd) => void) | undefined
  onRead: ((chapter: string, names?: readonly string[]) => void) | undefined
  byIndex: Map<number, { id: string; index: number; title: string }>
  first: number
  last: number
  people: Map<string, AlbumPerson>
  /** The way to the page before and the page after. */
  pager: ReactNode
  /** The way back to where this page was come to from. */
  backLink: ReactNode
}

/** Somebody's page: their picture large, who they are, what they go through, and who and what stands around them. */
function PersonPage({ person, t, album, media, moment, time, rows, ties, go, setZoom, lightbox, top, onEdit, onRead, byIndex, first, last, people, pager, backLink }: PersonPageProps) {
  const pictures = useMemo(() => [
    ...(person.portrait !== undefined ? [{ key: 'portrait', label: t('立绘', 'Portrait'), path: person.portrait, sheet: false }] : []),
    ...(person.sheet !== undefined ? [{ key: 'sheet', label: t('人设图', 'Design sheet'), path: person.sheet, sheet: person.sheetFront !== true }] : []),
    ...(person.looks ?? []).map((look, index) => ({ key: `look-${index}`, label: look.name, path: look.sheet, sheet: true })),
  ], [person, t])
  const [shown, setShown] = useState(0)
  const [all, setAll] = useState(false)
  const picture = pictures[Math.min(shown, pictures.length - 1)]
  const end: TieEnd = { type: 'character', id: person.id }
  const around = neighbours(ties, end)
  const life = album.lives[person.id]
  const how = standingAt(album, person.id, moment)
  const events = (life?.events ?? []).filter(event => moment === undefined || event.index <= moment)
  // An ordinary chapter they are in says little by itself: the turns of a life first, the rest when asked.
  const turns = events.filter(event => event.kind !== 'seen' || event.state !== undefined || event.what !== undefined)
  const listed = all ? turns : turns.length > 10 ? [...turns.slice(0, 6), ...turns.slice(-3)] : turns
  const span = Math.max(1, last - first + 1)
  const relations = (person.relationships ?? []).filter(other => other.id === undefined || people.has(other.id))
  // Theirs as a picture: what their own page says of others, and what the others' pages say of them.
  const bonds = useMemo(() => bondsOf(person.id, album.people), [person.id, album.people])
  const faces = useMemo(() => album.people.map(other => ({ id: other.id, name: other.name, role: other.role, face: other.portrait ?? other.sheet, sheet: other.portrait === undefined && other.sheet !== undefined && other.sheetFront !== true })), [album.people])
  const called = [person.name, ...(person.aliases ?? [])]
  const facts = [person.gender, person.age].filter((fact): fact is string => fact !== undefined)
  const sections: { label: [string, string]; text: string | undefined }[] = [
    { label: ['外貌', 'How they look'], text: person.appearance },
    { label: ['性格', 'How they are'], text: person.personality },
    { label: ['来历', 'Where they come from'], text: person.background },
    { label: ['能力', 'What they can do'], text: person.abilities },
  ]
  return (
    <div className="nv-explore nv-album is-page" ref={top}>
      <nav className="nv-explore-trail">
        {backLink}
        <button type="button" className="nv-link" onClick={() => { go({ section: 'people' }) }}>{t('人物', 'People')}</button>
        <span><Icon name="chevronRight" size={11} /><strong>{person.name}</strong></span>
      </nav>
      <section className={cx('nv-album-person', picture === undefined && 'is-bare')}>
        {picture !== undefined ? (
          <div className="nv-album-person-art">
            <button type="button" className={cx('nv-album-person-open', picture.sheet && 'is-sheet')} onClick={() => { setZoom(picture.path) }} title={t('看大图', 'See it large')}>
              <img alt={person.name} src={media(picture.path)} />
            </button>
            {pictures.length > 1 ? (
              <div className="nv-seg nv-album-person-pick" role="tablist">
                {pictures.map((item, index) => <button key={item.key} type="button" role="tab" aria-selected={index === shown} className={cx(index === shown && 'is-active')} onClick={() => { setShown(index) }}>{item.label}</button>)}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="nv-album-person-text">
          <h2>{person.name}</h2>
          {person.aliases !== undefined ? <p className="nv-small nv-album-also">{t('又作 ', 'Also ')}{person.aliases.join(t('、', ', '))}</p> : null}
          <p className="nv-album-chips">
            <span className="nv-chip nv-chip-blue">{t(...ROLE_NAME[person.role])}</span>
            {how !== undefined ? <span className={cx('nv-chip', how === 'dead' ? 'nv-chip-red' : how === 'active' ? 'nv-chip-green' : 'nv-chip-neutral')}>{t(...LIFE_LABEL[how])}</span> : null}
            {facts.map(fact => <span key={fact} className="nv-chip">{fact}</span>)}
          </p>
          {person.tagline !== undefined ? <p className="nv-album-tagline">{person.tagline}</p> : null}
          {sections.filter(section => section.text !== undefined).map(section => (
            <div key={section.label[0]} className="nv-album-fact">
              <h4>{t(...section.label)}</h4>
              <Prose text={section.text!} />
            </div>
          ))}
          {onEdit !== undefined ? <button type="button" className="nv-btn nv-btn-sm nv-btn-outline nv-album-edit" onClick={() => { onEdit(end) }}><Icon name="pen" size={13} /><span>{t('编辑', 'Edit')}</span></button> : null}
        </div>
      </section>
      {time}
      {bonds.length > 0 ? (
        <section className="nv-album-around">
          <h3>{t('身边的人', 'Theirs')}<span className="nv-muted"> {new Set(bonds.map(bond => bond.with)).size}</span></h3>
          <AroundGraph t={t} person={faces.find(face => face.id === person.id) ?? { id: person.id, name: person.name }} others={faces} bonds={bonds} media={media} onOpen={(id) => { go({ section: 'people', end: { type: 'character', id } }) }} />
        </section>
      ) : null}
      {life !== undefined && life.first !== undefined ? (
        <section className="nv-album-life">
          <h3>{t('这一路', 'What they go through')}</h3>
          {person.life !== undefined && moment === undefined ? <Prose text={person.life} /> : null}
          <div className="nv-album-track" role="img" aria-label={t(`第 ${life.first} 章登场，最后一次在第 ${life.last} 章`, `Comes on in chapter ${life.first}, last seen in chapter ${life.last}`)}>
            {life.spans.filter(stretch => moment === undefined || stretch.from <= moment).map(stretch => (
              <span key={stretch.from} className="nv-album-track-span" style={{ left: `${((stretch.from - first) / span) * 100}%`, width: `${((Math.min(stretch.to, moment ?? stretch.to) - stretch.from + 1) / span) * 100}%` }} />
            ))}
            {life.death !== undefined && life.death >= 1 && (moment === undefined || life.death <= moment) ? <span className="nv-album-track-end" style={{ left: `${((life.death - first + 0.5) / span) * 100}%` }} title={t(`第 ${life.death} 章死亡`, `Dies in chapter ${life.death}`)} /> : null}
            {moment !== undefined ? <span className="nv-album-track-now" style={{ left: `${((moment - first + 0.5) / span) * 100}%` }} /> : null}
          </div>
          <p className="nv-muted nv-small">{t(`${lifeLine(life, true) ?? ''}；一共 ${life.events.filter(event => event.index >= 1).length} 章有他。`, `${lifeLine(life, false) ?? ''}; in ${life.events.filter(event => event.index >= 1).length} chapters in all.`)}</p>
          {listed.length > 0 ? (
            <ol className="nv-album-events">
              {listed.flatMap((event, index) => {
                const chapter = byIndex.get(event.index)
                const row = (
                  <li key={`${event.index}:${event.chapter}`} className={`is-${event.kind}`}>
                    {chapter !== undefined && onRead !== undefined
                      ? <button type="button" className="nv-album-event-at" onClick={() => { onRead(chapter.id, called) }} title={chapter.title}>{t(`第 ${event.index} 章`, `Ch. ${event.index}`)}</button>
                      : <span className="nv-album-event-at">{event.index < 1 ? t('开始之前', 'Before') : t(`第 ${event.index} 章`, `Ch. ${event.index}`)}</span>}
                    <span className="nv-album-event-kind">{t(...EVENT_LABEL[event.kind])}</span>
                    <span className="nv-album-event-what">{[event.what, event.state].filter(Boolean).join(t('——', ' — '))}{event.where !== undefined ? <em> · {event.where}</em> : null}</span>
                  </li>
                )
                // Between the first turns and the last: the chapters left out, as a break in the list.
                return !all && turns.length > 10 && index === 6 ? [<li key="gap" className="is-gap" aria-hidden="true" />, row] : [row]
              })}
            </ol>
          ) : null}
          {turns.length > 10 ? <button type="button" className="nv-link nv-small" onClick={() => { setAll(!all) }}>{all ? t('收起', 'Fold') : t(`展开全部 ${turns.length} 条`, `All ${turns.length}`)}</button> : null}
        </section>
      ) : person.life !== undefined ? <section className="nv-album-life"><h3>{t('这一路', 'What they go through')}</h3><Prose text={person.life} /></section> : null}
      {relations.length > 0 ? (
        <div>
          <h3>{t('和谁是什么关系', 'Who they are to others')}<span className="nv-muted"> {relations.length}</span></h3>
          {rows(relations.filter(other => other.id !== undefined).map(other => ({ end: { type: 'character' as const, id: other.id! }, note: other.kind })))}
          {relations.some(other => other.id === undefined) ? <p className="nv-album-chips">{relations.filter(other => other.id === undefined).map(other => <span key={`${other.name}:${other.kind}`} className="nv-chip">{other.name} · {other.kind}</span>)}</p> : null}
        </div>
      ) : null}
      {STANDINGS.filter(standing => (around[standing]?.length ?? 0) > 0).map(standing => (
        <div key={standing}>
          <h3>{t(...STANDING_LABELS[standing])}<span className="nv-muted"> {around[standing]!.length}</span></h3>
          {rows(around[standing]!)}
        </div>
      ))}
      {pager}
      {lightbox}
    </div>
  )
}

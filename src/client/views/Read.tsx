// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The reader: a chapter as a reader meets it. It has three faces — the prose,
 * the script (who says what, how, over which sound, a line each) and the
 * motion comic — and one play button under the first two: the chapter is
 * listened to whichever of them is open, the line being spoken marked where
 * it stands, the page following it. Whichever face, it is the same chapter at
 * the same place.
 *
 * The author additionally gets the tools for a selected passage, the notes of
 * a review on the page, and — one press away, not in the way — the production
 * desk of the audio version.
 *
 * The same page (without the author's tools) is what other devices are served.
 *
 * Beside the text the viewer has the book's people and its world — the album
 * (`reader/album.tsx`), the same one other devices and a published site show.
 * From any page of it one press leads to where that thing is edited, and from
 * there one press leads back.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { albumEmpty, type AlbumAt, type AlbumCounts } from '../../shared/album'
import { fuzzyFind } from '../../shared/text'
import { MAIN_LINE, ofLine } from '../../shared/types'
import { blocksOf } from '../../shared/reader'
import { groupOf } from '../../shared/world'
import { AlbumView, ViewerTabs } from '../reader/album'
import { PlayTranscript, SideList, type SideRef } from '../reader/sides'
import { ChapterPortraits } from '../Figures'
import { ListenBar, ModeSwitch, ReaderPage, ReaderSettings, usePlayerOptions, useReaderPrefs, type ReaderPerson, type ReaderThing } from '../reader/parts'
import { useChapterPlayback } from '../reader/playback'
import { ScriptPage } from '../reader/script'
import { Film, place, Theater, WatchChoice, type ChapterFilm } from '../reader/theater'
import { chapterJob } from '../Batch'
import { Icon } from '../icons'
import { sheetsDrawn } from '../labels'
import { useSheetsAsk } from '../SheetsAsk'
import { IssueCard, IssueList, issueMarks } from '../Issues'
import { AudioDesk, ScriptTable, type ScriptView } from '../stage/Audio'
import {
  Button, cx, Empty, OverlayRootProvider, Select, Spinner, useBookLine, useLoad, useMediaUrl, useOverlayRoot, useProject, useQuote, useSnapshot, useStudio, useT, useLineView, waysOn,
} from '../ui'
import { FullButton, FullFrame, useFull } from '../reader/full'
import type { ViewerAt } from '../store'
import { ShareDialog } from './Share'
import { DERIVE_TIES_HINT, TiesReport, useDeriveTies } from '../Ties'

/**
 * The viewer, in the frame that can take the whole screen: whichever half is shown — the text, the people, the world,
 * the side stories — it is the same frame, so changing between them stays in full screen.
 */
export function ReadView() {
  const outer = useOverlayRoot()
  return (
    <FullFrame provide={(within, children) => <OverlayRootProvider value={within ?? outer}>{children}</OverlayRootProvider>}>
      <Viewer />
    </FullFrame>
  )
}

/** The viewer: the text of the book, or the album of its people and its world. */
function Viewer() {
  const { project } = useProject()
  const at = useSnapshot(snapshot => snapshot.album)
  // How much there is to look at besides the text: what the viewer offers to change to.
  const counts = useMemo<AlbumCounts>(() => {
    const of = (group: ReturnType<typeof groupOf>): number => project.world.filter(entry => groupOf(entry.category) === group).length
    return { people: project.characters.length, places: of('places'), factions: of('factions'), items: of('items'), ideas: of('ideas') }
  }, [project.characters, project.world])
  const world = counts.places + counts.factions + counts.items + counts.ideas
  // The interludes kept as side stories: how many there are decides whether the viewer offers them. An older Host says nothing of them.
  const { controller } = useStudio()
  const { root } = useProject()
  const kept = useLoad(async signal => await controller.api.call('reader.sides', { root }, signal).catch(() => undefined), [root, project.revision])
  const sides = kept.data?.sides.length ?? 0
  // A half with nothing in it is not somewhere to be: the text, then.
  const section = at.end?.type === 'character' ? 'people' : at.end?.type === 'world' ? 'world' : at.section
  if (section === 'sides' && sides > 0) return <SidesPage counts={counts} sides={kept.data!.sides} side={at.side} />
  if (section === 'text' || section === 'sides' || (section === 'people' && counts.people === 0) || (section === 'world' && world === 0)) return <ChapterReader counts={counts} sides={sides} />
  return <AlbumPage at={{ section, ...(at.end !== undefined ? { end: at.end } : {}) }} back={at.back} counts={counts} sides={sides} />
}

/** The side stories in the Studio's viewer: as a reader has them, with the way to where they are played and kept. */
function SidesPage({ counts, sides, side }: { counts: AlbumCounts; sides: SideRef[]; side: string | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const mediaUrl = useMediaUrl()
  const one = useLoad(async signal => (side !== undefined ? await controller.api.call('reader.sides', { root, id: side }, signal) : undefined), [root, side])
  const [sharing, setSharing] = useState(false)
  return (
    <div className="nv-reader nv-viewer-album">
      <header className="nv-reader-bar">
        <ViewerTabs t={t} value="sides" counts={counts} sides={sides.length} onChange={(next) => { controller.setAlbum({ section: next }) }} />
        <span className="nv-spacer" />
        <FullButton t={t} />
        <Button size="sm" variant="ghost" icon="phone" className="nv-only-studio" onClick={() => { setSharing(true) }} title={t('给别人看：在手机上读，或发布成网站——番外也在里面', 'Show it to others: on a phone, or as a site of its own — the side stories go with it')} />
        <Button size="sm" icon="pen" className="nv-only-studio" onClick={() => { controller.navigate({ view: 'stage', tab: 'play' }) }} title={t('去“演出 → 幕间”', 'To Stage → Interludes')}>{t('编辑', 'Edit')}</Button>
      </header>
      <div className="nv-album-page">
        {side !== undefined ? (
          <>
            <nav className="nv-explore-trail nv-sides-trail">
              <button type="button" className="nv-link" onClick={() => { controller.setAlbum({ section: 'sides' }) }}>{t('番外', 'Side stories')}</button>
              <span><Icon name="chevronRight" size={11} /><strong>{one.data?.play?.title ?? sides.find(item => item.id === side)?.title ?? ''}</strong></span>
            </nav>
            {one.data?.play !== undefined ? <PlayTranscript t={t} play={one.data.play} media={path => mediaUrl(path)} />
              : <div className="nv-desk-loading">{one.error !== undefined ? <span className="nv-muted">{one.error}</span> : one.loading ? <Spinner size={13} /> : <span className="nv-muted">{t('这场戏已经不是番外了。', 'This scene is no longer kept as a side story.')}</span>}</div>}
          </>
        ) : <SideList t={t} sides={sides} onOpen={(id) => { controller.setAlbum({ section: 'sides', side: id }) }} />}
      </div>
      {sharing ? <ShareDialog onClose={() => { setSharing(false) }} /> : null}
    </div>
  )
}

/** The album in the Studio: what a reader is given, and beside it the author's ways to the pages where it is made. */
function AlbumPage({ at, back, counts, sides }: { at: AlbumAt; /** The place in the text this was come to from. */ back: ViewerAt['back']; counts: AlbumCounts; sides: number }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const mediaUrl = useMediaUrl()
  // Where the story goes more than one way, the album is of one of them: the main line, or a line that has a chapter written.
  // The line in hand, as on every page — where it has something written to make an album of.
  const [way, setWay] = useBookLine()
  const ways = useMemo(() => [
    { id: MAIN_LINE, title: '' },
    ...(project.outline.lines ?? []).filter(line => project.lines?.find(info => info.id === line.id)?.chapters.some(chapter => chapter.hasText) === true).map(line => ({ id: line.id, title: line.title })),
  ], [project.outline.lines, project.lines])
  const along = ways.some(item => item.id === way) ? way : MAIN_LINE
  const album = useLoad(async signal => await controller.api.call('reader.album', { root, ...(along !== MAIN_LINE ? { line: along } : {}) }, signal), [root, project.revision, along])
  const ties = useDeriveTies()
  const [sharing, setSharing] = useState(false)
  // The other side of the page that is open: where this person, this place, is edited.
  const edit = (): void => {
    if (at.end?.type === 'character') controller.openCharacter(at.end.id)
    else if (at.end?.type === 'world') controller.openWorld(at.end.id)
    else if (at.section === 'people') controller.openCast('cards')
    else controller.setView('bible')
  }
  const worked = (project.ties?.length ?? 0) > 0
  return (
    <div className="nv-reader nv-viewer-album">
      <header className="nv-reader-bar">
        <ViewerTabs t={t} value={at.section} counts={counts} sides={sides} onChange={(next) => { controller.setAlbum({ section: next }) }} />
        <span className="nv-spacer" />
        <FullButton t={t} />
        <Button size="sm" variant="ghost" icon="phone" className="nv-only-studio" onClick={() => { setSharing(true) }} title={t('给别人看：在手机上读，或发布成网站', 'Show it to others: read on a phone, or publish as a site')} />
        <Button size="sm" icon="pen" className="nv-only-studio" onClick={edit} title={at.end !== undefined ? t('去编辑这一页写的是谁、是什么', 'Edit who or what this page is about') : at.section === 'people' ? t('去"人物"页编辑', 'Edit under People') : t('去"设定"页编辑', 'Edit under Bible')}>{t('编辑', 'Edit')}</Button>
      </header>
      <div className="nv-album-page">
        <TiesReport report={ties.report} onDismiss={ties.dismiss} />
        {album.data === undefined ? (
          <div className="nv-desk-loading">{album.error !== undefined ? <span className="nv-muted">{/unknown method/.test(album.error) ? t('这个版本的工坊后台还没有人物和世界的画册——在顶上点"重启"换成新版本就有了。', 'This Studio backend does not have the album of people and world yet — press Restart at the top to change to the new version.') : album.error}</span> : <><Spinner size={13} /><span className="nv-muted nv-small">{t('正在读取人物和世界…', 'Loading the people and the world…')}</span></>}</div>
        ) : (
          <AlbumView
            t={t}
            album={album.data}
            media={path => mediaUrl(path)}
            at={at}
            // Wherever the album is gone on to from here, the way back to the text goes along.
            go={(next) => { controller.setAlbum({ ...next, ...(back !== undefined ? { back } : {}) }) }}
            onRead={(chapter, names) => { if (names !== undefined && names.length > 0) controller.readAbout(chapter, names); else controller.openReader('read', chapter) }}
            back={back !== undefined ? { label: t('回到正文', 'Back to the text'), go: () => { controller.backToText(back) } } : undefined}
            ways={ways}
            onWay={setWay}
            // Arranging a scene is the author's: a mark dropped on a place's picture is pinned there for every reader.
            onPin={(entry, key, spot) => { void controller.guard(async () => { await controller.api.call('world.pin', { root, id: entry, ...(key !== undefined ? { key } : {}), ...(spot !== undefined ? { at: spot } : {}) }); await controller.refreshProject() }) }}
            worldTools={(
              <Button size="sm" variant={worked ? 'ghost' : 'primary'} icon="sparkles" busy={ties.busy} pending={t('策划正在理关系…', 'The planner is working out the ties…')} onClick={ties.derive} title={t(...DERIVE_TIES_HINT)}>{worked ? t('再理一遍关系', 'Work the ties out again') : t('让策划理一遍关系', 'Have the planner work out the ties')}</Button>
            )}
          />
        )}
      </div>
      {sharing ? <ShareDialog onClose={() => { setSharing(false) }} /> : null}
    </div>
  )
}

function ChapterReader({ counts, sides }: { counts: AlbumCounts; sides: number }) {
  const { controller } = useStudio()
  const t = useT()
  const quote = useQuote()
  const { project, root } = useProject()
  const chapterId = useSnapshot(snapshot => snapshot.chapterId)
  const mode = useSnapshot(snapshot => snapshot.readMode)
  const jump = useSnapshot(snapshot => snapshot.jump)
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const mediaUrl = useMediaUrl()
  const [prefs, updatePrefs] = useReaderPrefs()
  const [options, updateOptions] = usePlayerOptions()
  const [picked, setPicked] = useState<{ text: string; offset: number; top: number; left: number } | undefined>()
  const sheets = useSheetsAsk()
  const [flash, setFlash] = useState<number | undefined>()
  // What a review found, shown on the page where it was found — when the author asks to see it. Reading stays clean otherwise.
  // In full screen the viewer is a reader's: no notes of a review, no production desk, nothing to edit — whatever the
  // switches below say, which are kept for when it is left.
  const full = useFull()?.on === true
  const [annotateKept, setAnnotateState] = useState(() => {
    try {
      return localStorage.getItem('novel-studio:annotate') === '1'
    } catch {
      return false
    }
  })
  const setAnnotate = (next: boolean): void => {
    setAnnotateState(next)
    try {
      localStorage.setItem('novel-studio:annotate', next ? '1' : '0')
    } catch {
      // Kept for this visit only.
    }
  }
  const annotate = annotateKept && !full
  const [noted, setNoted] = useState<{ id: string; top: number; left: number } | undefined>()
  const [looseOpen, setLooseOpen] = useState(false)
  const [sharing, setSharing] = useState(false)
  // Listening is for listening: the production desk of the audio version comes when it is asked for, and is remembered.
  const [deskKept, setDeskState] = useState(() => {
    try {
      return localStorage.getItem('novel-studio:listen-desk') === '1'
    } catch {
      return false
    }
  })
  const setDesk = (next: boolean): void => {
    setDeskState(next)
    try {
      localStorage.setItem('novel-studio:listen-desk', next ? '1' : '0')
    } catch {
      // Kept for this visit only.
    }
  }
  const desk = deskKept && !full
  // A chapter that ran out goes on to the next, unless the listener would rather not: a wish kept with the player's.
  const autoNext = options.autoNext ?? (() => {
    try {
      // Where the wish was kept before it moved in with the rest.
      return localStorage.getItem('novel-studio:autonext') !== '0'
    } catch {
      return true
    }
  })()
  const [settings, setSettings] = useState(false)
  // Counted up when a portrait is kept out of the text from the page itself: the list behind the button is read again.
  const [figuresNonce, setFiguresNonce] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  // One line of the plot is read at a time: the main one, or the one a choice at a fork led onto.
  const { lineId, path, pick: pickLine } = useLineView(project, chapterId)
  const written = path.filter(chapter => chapter.hasText)
  const chapter = written.find(candidate => candidate.id === chapterId) ?? written[0]
  const plotLines = project.outline.lines ?? []
  // Who the text may name: everyone the book has a card for — but for those kept to other lines of the plot — the
  // weightiest first (that is the order the cards come in), each with the picture a reader knows them by.
  const people = useMemo<ReaderPerson[]>(() => project.characters.filter(card => ofLine(card, lineId, undefined)).map(card => ({
    id: card.id,
    name: card.name,
    ...(card.aliases !== undefined && card.aliases.length > 0 ? { aliases: card.aliases } : {}),
    ...(card.tagline !== undefined ? { tagline: card.tagline } : {}),
    ...((card.visual?.portrait ?? card.visual?.sheet) !== undefined ? { portrait: card.visual?.portrait ?? card.visual?.sheet } : {}),
  })), [project.characters, lineId])
  // And what of its world: every place, house, thing and idea the book has an entry for, but for those kept to other lines.
  const things = useMemo<ReaderThing[]>(() => project.world.filter(entry => entry.lines === undefined || entry.lines.length === 0 || entry.lines.includes(lineId)).map(entry => ({
    id: entry.id,
    name: entry.name,
    group: groupOf(entry.category),
    ...(entry.aliases !== undefined && entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    ...(entry.visualImage !== undefined ? { image: entry.visualImage } : {}),
  })), [project.world, lineId])
  /** To the page of whoever a name in the text is — with the way back to this place in the text. */
  const toPage = (type: 'character' | 'world', id: string): void => {
    controller.setAlbum({ section: type === 'character' ? 'people' : 'world', end: { type, id }, ...(chapter !== undefined ? { back: { chapter: chapter.id, top: scroller.current?.scrollTop ?? 0 } } : {}) })
  }
  // Where the story parts after this chapter: the lines that leave here and have a first chapter to read.
  const parting: ReturnType<typeof waysOn> = chapter === undefined ? { ways: [] } : waysOn(project, chapter, lineId)
  // A way is offered when its next chapter can be read: the reader is not sent past a gap.
  const forks = parting.ways.map(way => ({ way, first: way.chapters[0] })).filter((fork): fork is { way: typeof fork.way; first: NonNullable<typeof fork.first> } => fork.first?.hasText === true)
  const follow = (line: string, first: string): void => {
    pickLine(line)
    controller.focusChapter(first)
  }
  const position = chapter !== undefined ? written.findIndex(candidate => candidate.id === chapter.id) : -1
  // The faces of the chapter: the prose, the script, the motion comic.
  const scripted = mode === 'listen'
  const watching = mode === 'watch'
  // Work started here for this chapter, or the step of a running batch that is on it right now.
  const job = jobs.find(item => item.status === 'running' && item.kind === 'audio' && item.title !== 'audition' && (item.target === chapter?.id || item.result?.chapterId === chapter?.id)) ?? chapterJob(jobs, chapter?.id, ['synthesize', 'sound', 'audio script'])
  const doc = useLoad(async signal => chapter !== undefined ? await controller.api.call('chapter.read', { root, id: chapter.id }, signal) : undefined, [root, chapter?.id, chapter?.updatedAt])
  // The script is what is listened to under any face, and what the sound notes beside the text come from; a running job keeps it fresh as lines come in.
  const audio = useLoad<ScriptView | undefined>(async signal => chapter !== undefined ? await controller.api.call('audio.script', { root, chapter: chapter.id }, signal) : undefined, [root, chapter?.id, project.revision, job === undefined])
  const text = doc.data?.text
  const review = doc.data?.review
  const notes = useMemo(() => (annotate && text !== undefined ? issueMarks(text, review) : { marks: [], loose: [] }), [annotate, text, review])
  const openIssues = (review?.issues ?? []).filter(issue => issue.resolved !== true).length
  const notedIssue = noted !== undefined ? review?.issues.find(issue => issue.id === noted.id) : undefined
  const reviewing = jobs.some(job => job.status === 'running' && job.kind === 'review' && job.target === chapter?.id)
  // A review of this chapter that has just ended has notes to show: the chapter is read again.
  const reviewsEnded = jobs.filter(job => job.kind === 'review' && job.target === chapter?.id && job.status !== 'running').length
  const reviewsSeen = useRef(reviewsEnded)
  useEffect(() => {
    if (reviewsEnded === reviewsSeen.current) return
    reviewsSeen.current = reviewsEnded
    doc.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewsEnded])
  const script = audio.data?.script
  const lines = useMemo(() => script?.lines ?? [], [script])
  const cues = useMemo(() => script?.cues ?? [], [script])
  // The storyboard: what there is to watch. Read for every chapter, so that the way to watch shows where there is something to.
  const comic = useLoad(async signal => chapter !== undefined ? await controller.api.call('comic.board', { root, chapter: chapter.id }, signal) : undefined, [root, chapter?.id, project.revision])
  const panels = useMemo(() => comic.data?.board?.panels ?? [], [comic.data])
  const drawn = panels.filter(panel => panel.image !== undefined).length
  const placed = useMemo(() => place(panels, lines), [panels, lines])
  // And the chapter's finished video, where post-production cut one: watched here too, made under Stage.
  const cut = useLoad(async signal => chapter !== undefined ? await controller.api.call('video.status', { root, chapter: chapter.id }, signal).then(status => status.video, () => undefined) : undefined, [root, chapter?.id, project.revision])
  const video = cut.data
  const film: ChapterFilm | undefined = useMemo(() => (video !== undefined ? { src: mediaUrl(video.path, video.createdAt), ...(video.subtitles?.path !== undefined ? { subtitles: mediaUrl(video.subtitles.path, video.createdAt) } : {}), ...(video.subtitles?.burned === true ? { burned: true } : {}), language: project.manifest.language.slice(0, 2) } : undefined), [video, mediaUrl, project.manifest.language])
  const filming = film !== undefined && (options.film !== false || placed.length === 0)
  // What plays, and how the page behaves while it does: the same as on other devices.
  const after = written[position + 1]
  const { player, state, current, engaged, pace, figures: pictures } = useChapterPlayback({
    chapter: chapter?.id,
    text,
    lines,
    cues,
    placed,
    scripted: script !== undefined,
    arrived: script !== undefined && script.chapterId === chapter?.id,
    media: mediaUrl,
    options,
    mode,
    follow: prefs.follow !== false,
    toScript: () => { controller.setReadMode('listen') },
    onward: autoNext && after !== undefined ? () => { controller.focusChapter(after.id) } : undefined,
    scroller,
  })

  // A new chapter starts at the top — but one come back to, where it was left.
  useEffect(() => {
    if (jump?.top === undefined || jump.chapterId !== chapter?.id) scroller.current?.scrollTo({ top: 0 })
    setPicked(undefined)
    setNoted(undefined)
    setLooseOpen(false)
  }, [chapter?.id])

  // Arrow keys turn chapters when nothing is being typed; the space bar plays and pauses.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.tagName === 'BUTTON' || target.isContentEditable)) return
      if (scroller.current === null || scroller.current.offsetParent === null) return
      if (event.key === 'ArrowLeft' && position > 0) controller.focusChapter(written[position - 1]!.id)
      if (event.key === 'ArrowRight' && position >= 0 && position < written.length - 1) controller.focusChapter(written[position + 1]!.id)
      if (event.key === ' ' && lines.length > 0) {
        event.preventDefault()
        player.toggle()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  })

  // Show the place asked for: a search hit, where the chapter first names something, or where the page was left.
  // (Shown, the request is forgotten — which runs this again: nothing here may hang on a clean-up.)
  const flashing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(flashing.current) }, [])
  useEffect(() => {
    if (jump === undefined || chapter === undefined || jump.chapterId !== chapter.id || text === undefined) return
    if (jump.top !== undefined) {
      scroller.current?.scrollTo({ top: jump.top })
      controller.consumeJump(jump.nonce)
      return
    }
    const blocks = blocksOf(text)
    if (blocks.length === 0) return
    const found = jump.find !== undefined ? Math.min(...jump.find.map(name => text.indexOf(name)).filter(at => at >= 0)) : jump.offset
    const offset = Number.isFinite(found) ? found : 0
    const target = [...blocks].reverse().find(block => block.offset <= offset) ?? blocks[0]!
    const element = scroller.current?.querySelector<HTMLElement>(`[data-offset="${target.offset}"]`)
    if (element !== null && element !== undefined) {
      element.scrollIntoView({ block: 'center' })
      setFlash(target.offset)
      clearTimeout(flashing.current)
      flashing.current = setTimeout(() => { setFlash(undefined) }, 2400)
      controller.consumeJump(jump.nonce)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce, text])


  if (chapter === undefined) {
    return (
      <div className="nv-reader">
        {/* Nothing written yet does not mean nothing to look at: the people and the world may be there already. */}
        {albumEmpty(counts) && sides === 0 ? null : <header className="nv-reader-bar"><ViewerTabs t={t} value="text" counts={counts} sides={sides} onChange={(next) => { if (next !== 'text') controller.setAlbum({ section: next }) }} /></header>}
        <div className="nv-page">
          <Empty icon="eye" title={t('还没有可读的正文', 'Nothing to read yet')}>
            <Button variant="primary" icon="pen" onClick={() => { controller.setView('write') }}>{t('去写作', 'Open Write')}</Button>
          </Empty>
        </div>
      </div>
    )
  }

  const onSelect = (): void => {
    const selection = window.getSelection()
    const container = scroller.current
    if (selection === null || selection.isCollapsed || container === null || selection.rangeCount === 0 || text === undefined) {
      setPicked(undefined)
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return
    const chosen = selection.toString().trim()
    if (chosen.length === 0) return
    const start = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest<HTMLElement>('[data-offset]')
    const base = start !== null && start !== undefined ? Number(start.dataset.offset) : 0
    const exact = text.indexOf(chosen, base)
    const found = exact >= 0 ? { start: exact, end: exact + chosen.length } : fuzzyFind(text, chosen)
    const rect = range.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    setPicked({ text: chosen, offset: found?.start ?? base, top: rect.top - box.top + container.scrollTop - 44, left: Math.max(8, Math.min(box.width - 260, rect.left - box.left)) })
  }

  const turn = (delta: number): void => {
    const next = written[position + delta]
    if (next !== undefined) controller.focusChapter(next.id)
  }
  const showScript = scripted && script !== undefined
  const setBody = (next: 'text' | 'script'): void => { controller.setReadMode(next === 'script' ? 'listen' : 'read') }

  return (
    <div className={cx('nv-reader', `is-${prefs.theme}`, (scripted || engaged) && !watching && 'is-listen')}>
      <header className="nv-reader-bar">
        <ViewerTabs t={t} value="text" counts={counts} sides={sides} onChange={(next) => { if (next !== 'text') controller.setAlbum({ section: next }) }} />
        <Button size="sm" variant="ghost" icon="chevronLeft" disabled={position <= 0} onClick={() => { turn(-1) }} title={t('上一章', 'Previous chapter')} />
        <Select className="nv-chapter-select" value={chapter.id} options={written.map(item => ({ value: item.id, label: `${item.index}. ${item.title}` }))} onChange={(value) => { controller.focusChapter(value) }} />
        <Button size="sm" variant="ghost" icon="chevronRight" disabled={position >= written.length - 1} onClick={() => { turn(1) }} title={t('下一章', 'Next chapter')} />
        {plotLines.length > 0 ? (
          <Select className="nv-line-select" value={lineId} options={[{ value: MAIN_LINE, label: `★ ${t('主线', 'Main line')}` }, ...plotLines.map(line => ({ value: line.id, label: `${line.shelved === true ? '⏸ ' : ''}${line.title}` }))]} onChange={(value) => {
            pickLine(value)
            const own = value === MAIN_LINE ? project.chapters : project.lines?.find(line => line.id === value)?.chapters ?? []
            const target = own.find(candidate => candidate.hasText)
            if (target !== undefined) controller.focusChapter(target.id)
            else controller.toast('info', t('这条线上还没有写好的章节', 'This line has no written chapter yet'))
          }} />
        ) : null}
        <ModeSwitch
          mode={watching ? undefined : mode}
          onChange={(next) => { controller.setReadMode(next) }}
          t={t}
          pages
          // The way to watch shows where the chapter has pictures — and stays while it is the way in use, so that it can be left.
          watch={drawn > 0 || film !== undefined || watching ? { active: watching, onChoose: () => { controller.setReadMode('watch') } } : undefined}
        />
        <span className="nv-spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon="checkCircle"
          className={cx('nv-only-studio', annotate && 'is-active')}
          onClick={() => { setAnnotate(!annotate); setNoted(undefined) }}
          title={annotate ? t('收起批注：正文恢复干净', 'Hide the notes: the page is clean again') : t('批注：把审校出的问题标在正文里，点开可以就地修', 'Notes: mark what the review found in the text; press one to mend it there')}
        >
          {t('批注', 'Notes')}{openIssues > 0 ? ` ${openIssues}` : ''}
        </Button>
        <span className="nv-only-studio"><ChapterPortraits key={figuresNonce} chapter={chapter.id} label={false} onChanged={() => { doc.reload() }} /></span>
        <Button size="sm" variant="ghost" icon="type" className={cx(settings && 'is-active')} onClick={() => { setSettings(!settings) }} title={t('阅读设置：字号、纸张、字体、语速、播放与声音', 'Reading settings: type, paper, typeface, speed, playback and sound')}>{t('阅读设置', 'Reading')}</Button>
        <FullButton t={t} />
        <Button size="sm" variant="ghost" icon="phone" className="nv-only-studio" onClick={() => { setSharing(true) }} title={t('在手机上读这本书', 'Read this book on another device')} />
        {!watching ? <Button size="sm" variant="ghost" icon="mic" className={cx('nv-only-studio', desk && 'is-active')} onClick={() => { setDesk(!desk) }} title={desk ? t('收起有声版的制作台，只听', 'Fold the production desk away and just listen') : t('有声版的制作台：脚本、选角、配音、声音', 'The production desk of the audio version: script, casting, voices, sound')}>{t('制作', 'Produce')}</Button> : null}
        {watching ? <Button size="sm" variant="ghost" icon="film" className="nv-only-studio" onClick={() => { controller.navigate({ view: 'stage', tab: 'comic', chapter: chapter.id }) }} title={t('有声漫的制作：分镜、画面、成片', 'Making the motion comic: storyboard, pictures, video')}>{t('制作', 'Produce')}</Button> : null}
        <Button size="sm" icon="pen" className="nv-only-studio" onClick={() => { controller.setView('write', chapter.id) }}>{t('编辑', 'Edit')}</Button>
      </header>
      {annotate && mode === 'read' ? (
        <div className="nv-reader-notes" role="status">
          {review === undefined ? (
            <>
              <span>{t('这一章还没有审校过，所以没有批注。', 'This chapter has not been reviewed, so there are no notes.')}</span>
              <Button size="sm" icon="checkCircle" busy={reviewing} pending={t('审校中…', 'Reviewing…')} onClick={() => controller.guard(async () => { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() })}>{t('审校这一章', 'Review this chapter')}</Button>
            </>
          ) : openIssues === 0 ? (
            <span>{t('这一章的审校意见都处理完了。', 'Every note of this chapter\'s review is settled.')} <span className="nv-muted">{review.verdict}</span></span>
          ) : (
            <>
              <span>
                {t(`${openIssues} 条审校意见没处理：${notes.marks.length} 条标在正文里`, `${openIssues} review note(s) open: ${notes.marks.length} marked in the text`)}
                {notes.loose.length > 0 ? t(`，${notes.loose.length} 条没有对应的句子。`, `, ${notes.loose.length} have no sentence of their own.`) : t('。', '.')}
              </span>
              <Button size="sm" variant="ghost" icon={looseOpen ? 'chevronUp' : 'chevronDown'} onClick={() => { setLooseOpen(!looseOpen) }}>{looseOpen ? t('收起', 'Fold') : t('列出来选', 'List them')}</Button>
              <Button size="sm" variant="ghost" icon="checkCircle" busy={reviewing} pending={t('审校中…', 'Reviewing…')} onClick={() => controller.guard(async () => { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() })} title={t('正文改过之后重新审校一遍', 'Review again after the text has changed')}>{t('重新审校', 'Review again')}</Button>
            </>
          )}
          {looseOpen && openIssues > 0 ? (
            <IssueList className="nv-reader-notes-list" chapterId={chapter.id} issues={(review?.issues ?? []).filter(issue => issue.resolved !== true)} onChanged={() => { doc.reload() }} />
          ) : null}
        </div>
      ) : null}
      {!watching && (desk || (scripted && audio.data?.script === undefined)) ? (
        audio.data === undefined
          ? <div className="nv-desk-loading">{audio.error !== undefined ? <span className="nv-muted">{audio.error}</span> : <><Spinner size={13} /><span className="nv-muted nv-small">{t('正在读取有声脚本…', 'Loading the audio script…')}</span></>}</div>
          : <AudioDesk chapter={chapter} view={audio.data} job={job} player={player} onBody={setBody} onChanged={() => { audio.reload() }} />
      ) : null}
      {watching ? (
        <div className="nv-reader-scroll nv-reader-watch" ref={scroller}>
          {filming ? (
            <>
              <Film t={t} film={film} cors onPlay={() => { player.pause() }} />
              <div className="nv-reader-watch-head">
                <h1 className="nv-reader-watch-title">{chapter.title}</h1>
                {placed.length > 0 ? <WatchChoice t={t} film onChange={(value) => { updateOptions({ film: value }) }} /> : null}
              </div>
              <p className="nv-muted nv-small nv-only-studio">
                {t('这是后期剪好的成片。', 'This is the video post-production cut. ')}
                <button type="button" className="nv-link" onClick={() => { controller.navigate({ view: 'stage', tab: 'comic', chapter: chapter.id }) }}>{t('重剪、下载或删除在"演出 → 有声漫"的成片一栏', 'Cutting it again, downloading or deleting it is under Stage → Motion comic, in the video card')}</button>
              </p>
            </>
          ) : placed.length > 0 ? (
            <>
              <Theater t={t} player={player} state={state} lines={lines} cues={cues} current={current} media={path => mediaUrl(path)} options={options} speakerOf={line => project.characters.find(card => card.id === line.speaker)?.name ?? line.speakerName} />
              <div className="nv-reader-watch-head">
                <h1 className="nv-reader-watch-title">{chapter.title}</h1>
                {film !== undefined ? <WatchChoice t={t} film={false} onChange={(value) => { player.pause(); updateOptions({ film: value }) }} /> : null}
              </div>
              {lines.every(line => line.audio === undefined) ? <p className="nv-muted nv-small">{t('这一章还没有配音：画面会按阅读速度配着字幕走。', 'This chapter has no voice yet: the panels pass at reading pace, with subtitles.')}</p> : null}
              {drawn < panels.length ? <p className="nv-muted nv-small">{t(`${panels.length} 格分镜里还有 ${panels.length - drawn} 格没有画面。`, `${panels.length - drawn} of ${panels.length} panels have no picture yet.`)}</p> : null}
            </>
          ) : comic.data === undefined || (script === undefined && audio.data === undefined) ? (
            <div className="nv-desk-loading"><Spinner size={13} /><span className="nv-muted nv-small">{t('正在读取分镜…', 'Loading the storyboard…')}</span></div>
          ) : (
            <Empty icon="film" title={t('这一章还没有有声漫', 'This chapter has no motion comic yet')}>
              <p className="nv-muted">{t('这一章还没有有声漫，在“演出 → 有声漫”里做。', 'This chapter has no motion comic yet: make one under Stage → Motion comic.')}</p>
              <Button variant="primary" icon="film" onClick={() => { controller.navigate({ view: 'stage', tab: 'comic', chapter: chapter.id }) }}>{t('去制作', 'Make it')}</Button>
            </Empty>
          )}
          <div className="nv-reader-watch-turn">
            {position > 0 ? <Button icon="chevronLeft" onClick={() => { turn(-1) }}>{t('上一章', 'Previous')}</Button> : null}
            {position < written.length - 1 ? <Button variant="primary" icon="arrowRight" onClick={() => { turn(1) }}>{t('下一章：', 'Next: ')}{written[position + 1]!.title}</Button> : null}
          </div>
        </div>
      ) : showScript && desk ? (
        // Producing: the table of takes, with the tools on every line.
        <div className="nv-reader-scroll" ref={scroller}>
          <div className="nv-script-wrap">
            <ScriptTable chapter={chapter} lines={lines} cues={cues} state={state} player={player} job={job} sound={audio.data?.sound} onChanged={() => { audio.reload() }} pictures={pictures} pace={pace} />
          </div>
        </div>
      ) : showScript ? (
        // Listening: the script as a reader has it — the same page a phone is given.
        <ScriptPage
          t={t}
          lines={lines}
          cues={cues}
          state={state}
          player={player}
          pace={pace}
          figures={pictures}
          media={path => mediaUrl(path)}
          speakerOf={line => project.characters.find(card => card.id === line.speaker)?.name}
          scroller={scroller}
          prefs={prefs}
          header={<header className="nv-reader-head"><span className="nv-reader-kicker">{project.manifest.title} · {t(`第 ${chapter.index} 章`, `Chapter ${chapter.index}`)}</span><h1>{chapter.title}</h1></header>}
          footer={position < written.length - 1 ? <Button icon="arrowRight" onClick={() => { turn(1) }}>{t('下一章：', 'Next: ')}{written[position + 1]!.title}</Button> : <span className="nv-muted">{t('—— 已读到最新一章 ——', '— you have reached the latest chapter —')}</span>}
        />
      ) : (
        <ReaderPage
          t={t}
          bookTitle={project.manifest.title}
          chapter={chapter}
          text={text}
          prefs={prefs}
          media={path => mediaUrl(path)}
          lines={engaged && script !== undefined ? lines : undefined}
          active={engaged ? state.index : undefined}
          onLine={engaged && script !== undefined ? (index) => { player.play(index) } : undefined}
          sound={script !== undefined ? { lines, cues } : undefined}
          sounding={engaged ? state.sounding : undefined}
          pace={engaged ? pace : undefined}
          flash={flash}
          scroller={scroller}
          onSelect={onSelect}
          people={people}
          onPerson={(id) => { toPage('character', id) }}
          things={things}
          onThing={(id) => { toPage('world', id) }}
          figures={doc.data?.figures}
          onHideFigure={(path) => { void controller.guard(async () => { await controller.api.call('figures.show', { root, path, show: false }); doc.reload(); setFiguresNonce(value => value + 1); controller.toast('success', t('这张立绘不再出现在正文里。要放回来：顶上的“立绘”。', 'This portrait is kept out of the text. To put it back: Portraits, at the top.')) }) }}
          marks={annotate && !engaged ? notes.marks : undefined}
          openMark={noted?.id}
          onMark={(id, at) => {
            const width = scroller.current?.clientWidth ?? 600
            setPicked(undefined)
            setNoted(previous => (previous?.id === id ? undefined : { id, top: at.bottom + 8, left: Math.max(8, Math.min(width - 388, at.left)) }))
          }}
          footer={forks.length > 0 ? (
            // The story goes more than one way from here: the reader chooses, as a player would.
            <div className="nv-reader-forks">
              <span className="nv-muted nv-small">{t('故事在这里分了岔：', 'The story parts here:')}</span>
              {position < written.length - 1 ? <Button icon="arrowRight" onClick={() => { turn(1) }}>{parting.along?.choice ?? t('接着往下读', 'Read on')} · {written[position + 1]!.title}</Button> : null}
              {forks.map(({ way, first }) => <Button key={way.line} icon={way.info !== undefined ? 'branch' : 'star'} onClick={() => { follow(way.line, first.id) }} title={way.left === true ? t('这条线分出去之前的走向', 'The way things went before this line left') : way.info?.premise}>{way.left === true ? way.info?.title ?? t('主线', 'Main line') : way.info?.choice ?? way.info?.title} · {first.title}</Button>)}
            </div>
          ) : position < written.length - 1
            ? <Button icon="arrowRight" onClick={() => { turn(1) }}>{t('下一章：', 'Next: ')}{written[position + 1]!.title}</Button>
            : <span className="nv-muted">{lineId !== MAIN_LINE ? t('—— 这条线读到这里 ——', '— this line has been read to here —') : t('—— 已读到最新一章 ——', '— you have reached the latest chapter —')}</span>}
        >
          {noted !== undefined && notedIssue !== undefined ? (
            <div className="nv-reader-note" style={{ top: noted.top, left: noted.left }} onMouseUp={(event) => { event.stopPropagation() }}>
              <button type="button" className="nv-reader-note-close" onClick={() => { setNoted(undefined) }} title={t('关上', 'Close')} aria-label={t('关上', 'Close')}><Icon name="x" size={12} /></button>
              <IssueCard chapterId={chapter.id} issue={notedIssue} onChanged={() => { setNoted(undefined); doc.reload() }} after={() => { setNoted(undefined) }} />
            </div>
          ) : null}
          {picked !== undefined && !full ? (
            <div className="nv-reader-pick" style={{ top: Math.max(4, picked.top), left: picked.left }} onMouseUp={(event) => { event.stopPropagation() }}>
              <Button size="sm" icon="pen" onClick={() => { controller.jumpTo(chapter.id, picked.offset, picked.text.length, 'write') }}>{t('去修改', 'Edit here')}</Button>
              {quote !== undefined ? (
                <Button size="sm" icon="quote" onClick={() => {
                  quote(t(`关于第 ${chapter.index} 章《${chapter.title}》里的这段：\n「${picked.text}」\n`, `About this passage in chapter ${chapter.index}, "${chapter.title}":\n"${picked.text}"\n`))
                  setPicked(undefined)
                }}>{t('和总编讨论', 'Discuss')}</Button>
              ) : null}
              <Button size="sm" icon="image" pending={t('正在为这段配图…', 'Illustrating…')} onClick={() => {
                if (!controller.need('image')) return undefined
                const chosen = picked.text
                // Whoever of the people in the passage comes back in the book and has no design sheet gets one first: asked, before anything is drawn.
                return sheets.before([{ kind: 'scene', target: chapter.id, quote: chosen }], choice => controller.guard(async () => {
                  const job = await controller.run('image.create', { root, kind: 'scene', target: chapter.id, quote: chosen, insert: true, ...choice })
                  setPicked(undefined)
                  doc.reload()
                  controller.toast('success', `${t('插图已放进正文', 'The illustration is in the chapter')}${sheetsDrawn(job, t)}`)
                }))
              }}>{t('配图', 'Illustrate')}</Button>
            </div>
          ) : null}
        </ReaderPage>
      )}
      {!watching && script !== undefined ? (
        <ListenBar
          t={t}
          player={player}
          state={state}
          lines={lines}
          cues={cues}
          options={options}
          update={updateOptions}
          onSettings={() => { setSettings(!settings) }}
        />
      ) : null}
      {settings ? (
        <ReaderSettings
          prefs={prefs}
          update={updatePrefs}
          options={options}
          updateOptions={updateOptions}
          t={t}
          onClose={() => { setSettings(false) }}
          extra={full ? undefined : (
            <label className="nv-check" title={t('把审校出的问题标在正文里', 'Mark what the review found in the text')}>
              <input type="checkbox" checked={annotate} onChange={(event) => { setAnnotate(event.target.checked); setNoted(undefined) }} />
              <span>{t('在正文里显示审校批注', 'Show review notes in the text')}</span>
            </label>
          )}
        />
      ) : null}
      {sharing ? <ShareDialog onClose={() => { setSharing(false) }} /> : null}
      {sheets.element}
    </div>
  )
}

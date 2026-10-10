// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The plot as a graph: the main line — the book as it is read — and beside it
 * every other way the story goes. A line leaves after a chapter and may arrive
 * at one again; what was rewritten is kept as a line put aside.
 *
 * Read from left to right like a map of a railway: each line its own track
 * and colour, a chapter a station (filled once it is written), a branch where
 * a line leaves and a junction where it arrives. Clicking a station or a line
 * shows what can be done there: write on, derive more, open a line, join one
 * to another, make one the main line.
 */
import { useMemo, useRef, useState } from 'react'
import type { OutlineOpInput } from '../../shared/rpc'
import { MAIN_LINE, type ChapterInfo, type ChapterPlan, type PlotLine, type PlotLineOrigin } from '../../shared/types'
import {
  Button, Chip, cx, Field, Modal, Select, TextArea, TextInput, useAction, useConfirm, useProject, useStudio, useT, type Translate,
} from '../ui'
import { MoveChapters } from '../MoveChapters'
import { Derive } from './Outline'
import { readBase64 } from './Home'
import { LineWorldPanel } from './Worldline'
import { HistoryButton } from '../History'

const STEP_X = 76
const LANE_Y = 86
const PAD_X = 132
const PAD_Y = 46
const RADIUS = 11

/** Colours for the tracks beside the main one; the theme's own accents, so they hold in light and dark. */
const TRACKS = ['var(--nv-violet)', 'var(--nv-success)', 'var(--nv-warn)', '#d6568f', '#2aa3b8', '#b07a3c']

const ORIGIN: Record<PlotLineOrigin, [string, string]> = {
  author: ['作者开的线', 'opened by the author'],
  planner: ['策划推演的线', 'derived by the planner'],
  interlude: ['从幕间演出来的线', 'played out in an interlude'],
  replaced: ['改写前的旧大纲', 'the outline before a rewrite'],
  main: ['原来的主线', 'the former main line'],
}

interface Station {
  plan: ChapterPlan
  info: ChapterInfo | undefined
  /** The line it belongs to; undefined for the main one. */
  line: string | undefined
  column: number
  lane: number
}

interface Track {
  id: string
  line: PlotLine | undefined
  lane: number
  colour: string
  stations: Station[]
}

interface Layout {
  tracks: Track[]
  stations: Map<string, Station>
  columns: number
  lanes: number
}

/** Lay the plot out: every chapter in the column after whatever leads to it, every line on a lane of its own where it runs. */
function layout(volumes: { chapters: ChapterPlan[] }[], lines: readonly PlotLine[], infos: Map<string, ChapterInfo>): Layout {
  const main = volumes.flatMap(volume => volume.chapters)
  const before = new Map<string, string[]>()
  const lead = (from: string | undefined, to: string | undefined): void => {
    if (from === undefined || to === undefined) return
    before.set(to, [...(before.get(to) ?? []), from])
  }
  main.forEach((plan, at) => { lead(main[at - 1]?.id, plan.id) })
  for (const line of lines) {
    line.chapters.forEach((plan, at) => { lead(at === 0 ? line.from : line.chapters[at - 1]!.id, plan.id) })
    lead(line.chapters.at(-1)?.id ?? line.from, line.into)
  }
  const column = new Map<string, number>()
  const walking = new Set<string>()
  const columnOf = (id: string): number => {
    const known = column.get(id)
    if (known !== undefined) return known
    // A circle in the data: stop rather than go round.
    if (walking.has(id)) return 0
    walking.add(id)
    const at = Math.max(-1, ...(before.get(id) ?? []).map(columnOf)) + 1
    walking.delete(id)
    column.set(id, at)
    return at
  }
  const stations = new Map<string, Station>()
  const tracks: Track[] = [{ id: MAIN_LINE, line: undefined, lane: 0, colour: 'var(--nv-brand-text)', stations: [] }]
  for (const plan of main) {
    const station: Station = { plan, info: infos.get(plan.id), line: undefined, column: columnOf(plan.id), lane: 0 }
    stations.set(plan.id, station)
    tracks[0]!.stations.push(station)
  }
  // A lane is free for a line where no other line runs over the same columns.
  const taken: [number, number][][] = []
  const ordered = [...lines].sort((left, right) => (left.from !== undefined ? columnOf(left.from) : -1) - (right.from !== undefined ? columnOf(right.from) : -1) || left.createdAt.localeCompare(right.createdAt))
  ordered.forEach((line, order) => {
    const from = line.from !== undefined ? columnOf(line.from) : -1
    const own = line.chapters.map(plan => columnOf(plan.id))
    const to = Math.max(from + 1, ...own, line.into !== undefined ? columnOf(line.into) : 0)
    let lane = 1
    while ((taken[lane] ?? []).some(([start, end]) => from < end && to > start)) lane += 1
    taken[lane] = [...(taken[lane] ?? []), [from, to]]
    const track: Track = { id: line.id, line, lane, colour: line.shelved === true ? 'var(--nv-text-3)' : TRACKS[order % TRACKS.length]!, stations: [] }
    for (const plan of line.chapters) {
      const station: Station = { plan, info: infos.get(plan.id), line: line.id, column: columnOf(plan.id), lane }
      stations.set(plan.id, station)
      track.stations.push(station)
    }
    tracks.push(track)
  })
  return { tracks, stations, columns: Math.max(0, ...[...stations.values()].map(station => station.column)) + 1, lanes: tracks.reduce((max, track) => Math.max(max, track.lane), 0) + 1 }
}

const x = (column: number): number => PAD_X + column * STEP_X
const y = (lane: number): number => PAD_Y + lane * LANE_Y

/** A point on such a path, so far along it (0 at the station it leaves, 1 at the one it arrives at): where a handle sits. */
function along(fromX: number, fromY: number, toX: number, toY: number, far: number): { x: number; y: number } {
  const mid = (fromX + toX) / 2
  const near = 1 - far
  const at = (a: number, b: number, c: number, d: number): number => near ** 3 * a + 3 * near ** 2 * far * b + 3 * near * far ** 2 * c + far ** 3 * d
  return { x: at(fromX, mid, mid, toX), y: at(fromY, fromY, toY, toY) }
}

/** What is being moved by hand on the graph: a chapter to another place, or the end of a line to another chapter. */
type Held =
  | { kind: 'chapter'; id: string; x: number; y: number }
  | { kind: 'from' | 'into'; line: string; x: number; y: number }

/** A path that leaves one station and arrives at another on a different lane: out level, across in a curve, in level. */
function bend(fromX: number, fromY: number, toX: number, toY: number): string {
  const mid = (fromX + toX) / 2
  return `M ${fromX} ${fromY} C ${mid} ${fromY}, ${mid} ${toY}, ${toX} ${toY}`
}

export function PlotGraph() {
  const [importing, setImporting] = useState(false)
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const lines = project.outline.lines ?? []
  const infos = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(info => [info.id, info])), [project])
  const graph = useMemo(() => layout(project.outline.volumes, lines, infos), [project.outline.volumes, lines, infos])
  const [picked, setPicked] = useState<{ kind: 'chapter' | 'line'; id: string } | undefined>()
  const [deriving, setDeriving] = useState<{ line?: string; after?: string; mode: 'append' | 'replace' | 'branch' } | undefined>()
  const [editing, setEditing] = useState<PlotLine | 'new' | undefined>()
  const [joining, setJoining] = useState<PlotLine | undefined>()
  const apply = async (ops: OutlineOpInput[]): Promise<void> => {
    const { results } = await controller.api.call('outline.apply', { root, ops })
    const failed = results.find(result => !result.ok)
    if (failed !== undefined) throw new Error(failed.message)
    await controller.refreshProject()
  }
  // Chapters being moved to another place in the plot: one, or one with those that follow it on its line.
  const [moving, setMoving] = useState<{ chapters: string[]; fresh?: boolean } | undefined>()
  const runFrom = (from: Station): string[] => {
    const own = from.line !== undefined ? (project.outline.lines ?? []).find(line => line.id === from.line)?.chapters ?? [] : project.outline.volumes.flatMap(volume => volume.chapters)
    const at = own.findIndex(plan => plan.id === from.plan.id)
    return at < 0 ? [from.plan.id] : own.slice(at).map(plan => plan.id)
  }
  // ── moving things by hand: a chapter taken to another place, the end of a line to another chapter ──
  const svg = useRef<SVGSVGElement>(null)
  const grab = useRef<{ what: Held; x: number; y: number; moved: boolean } | undefined>(undefined)
  // The click that ends a move is not a click on the chapter.
  const dropped = useRef(false)
  const [held, setHeld] = useState<Held | undefined>()
  const pointOf = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = svg.current?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }
  /** The chapter nearest a point of the graph, of those that may be let go on; none where the point is far from any. */
  const nearest = (point: { x: number; y: number }, fits: (node: Station) => boolean): Station | undefined => {
    let best: Station | undefined
    let least = 54 ** 2
    for (const node of graph.stations.values()) {
      if (!fits(node)) continue
      const far = (x(node.column) - point.x) ** 2 + ((y(node.lane) - point.y) * 1.4) ** 2
      if (far < least) {
        least = far
        best = node
      }
    }
    return best
  }
  /** Where what is held would land: beside a chapter, or — an end of a line — on one. */
  const landing = (() => {
    if (held === undefined) return undefined
    if (held.kind === 'chapter') {
      const node = nearest(held, candidate => candidate.plan.id !== held.id)
      return node !== undefined ? { node, side: held.x < x(node.column) ? 'before' as const : 'after' as const } : undefined
    }
    // An end of a line lands on a chapter that is not the line's own.
    const node = nearest(held, candidate => candidate.line !== held.line)
    return node !== undefined ? { node, side: 'on' as const } : undefined
  })()
  const take = (what: Held, event: React.PointerEvent): void => {
    if (event.button !== 0) return
    grab.current = { what, x: event.clientX, y: event.clientY, moved: false }
    try {
      svg.current?.setPointerCapture(event.pointerId)
    } catch {
      // A pointer that cannot be held: its moves still arrive while it is over the graph.
    }
  }
  const carry = (event: React.PointerEvent): void => {
    const from = grab.current
    if (from === undefined) return
    // A hand is never quite still: a few pixels are still a click.
    if (!from.moved && Math.hypot(event.clientX - from.x, event.clientY - from.y) < 6) return
    from.moved = true
    setHeld({ ...from.what, ...pointOf(event) })
  }
  const letGo = (): void => {
    const from = grab.current
    const now = held
    const to = landing
    grab.current = undefined
    setHeld(undefined)
    if (from === undefined || !from.moved || now === undefined) return
    dropped.current = true
    setTimeout(() => { dropped.current = false }, 0)
    if (now.kind === 'chapter') {
      if (to === undefined || to.side === 'on') return
      void run(async () => { await apply([{ op: 'move-chapters', chapters: [now.id], [to.side]: to.node.plan.id }]) })
      return
    }
    const line = lines.find(candidate => candidate.id === now.line)
    if (line === undefined) return
    // Let go on a chapter: the line leaves after it, or arrives at it. Let go on nothing: it leaves from the first
    // page — or arrives nowhere — where it did otherwise before.
    if (to !== undefined) void run(async () => { await apply([{ op: 'update-line', line: line.id, [now.kind]: to.node.plan.id }]) })
    else if ((now.kind === 'from' ? line.from : line.into) !== undefined) void run(async () => { await apply([{ op: 'update-line', line: line.id, [now.kind]: null }]) })
  }
  const station = picked?.kind === 'chapter' ? graph.stations.get(picked.id) : undefined
  const track = picked?.kind === 'line' ? graph.tracks.find(candidate => candidate.id === picked.id) : station !== undefined ? graph.tracks.find(candidate => candidate.id === (station.line ?? MAIN_LINE)) : undefined
  const width = PAD_X + graph.columns * STEP_X + 40
  const height = PAD_Y + (graph.lanes - 1) * LANE_Y + 62
  const nameOf = (line: PlotLine | undefined): string => line?.title ?? t('主线', 'Main line')
  const labelOf = (id: string | undefined): string => {
    const found = id !== undefined ? graph.stations.get(id) : undefined
    return found === undefined ? '' : t(`${nameOf(lines.find(line => line.id === found.line))} 第 ${found.info?.index ?? '?'} 章《${found.plan.title}》`, `${nameOf(lines.find(line => line.id === found.line))}, chapter ${found.info?.index ?? '?'} "${found.plan.title}"`)
  }
  const writeNext = (target: Track): void => {
    const next = target.line !== undefined ? project.lines?.find(line => line.id === target.id)?.chapters.find(chapter => !chapter.hasText) : project.chapters.find(chapter => !chapter.hasText)
    if (next !== undefined) controller.setView('write', next.id)
    else controller.toast('info', t('这条线上大纲里的章节都写完了：先推演后续章节。', 'Every outlined chapter of this line is written: derive more first.'))
  }

  return (
    <div className="nv-plot">
      {importing ? <ImportLine onClose={() => { setImporting(false) }} /> : null}
      <section className="nv-card nv-plot-head">
        <div className="nv-audio-summary">
          <strong>{t('剧情图', 'The plot, as a graph')}</strong>
          <span className="nv-muted nv-small">{lines.length === 0
            ? t('故事现在只有一条线。点任意一章，可以从那里另开一条线，或重写这之后的大纲。', 'The story has one line. Click any chapter to open another line from it, or to plot what follows anew.')
            : t(`主线之外有 ${lines.length} 条线。实心的站是写了正文的章节。`, `${lines.length} line(s) beside the main one. A filled stop is a written chapter.`)}{' '}{t('拖一章到别处：换位置或换线；拖一条线两头的小圆点：改它从哪一章分出、汇入哪一章。', 'Drag a chapter elsewhere to move it, also onto another line; drag the small dot at either end of a line to change where it leaves and where it arrives.')}</span>
          <span className="nv-spacer" />
          <Button size="sm" variant="ghost" icon="upload" onClick={() => { setImporting(true) }} title={t('把一份写好的稿子导入成这本书里的另一条线，共用人物和设定', 'Import a finished manuscript as another line of this book, sharing its people and its world')}>{t('导入另一条故事线', 'Import another story line')}</Button>
          <Button size="sm" icon="branch" onClick={() => { setEditing('new') }}>{t('开一条新线', 'Open a line')}</Button>
        </div>
      </section>

      <div className="nv-plot-scroll">
        {/* Drawn in its own units and never stretched: a short story sits at the left edge, a long one scrolls. */}
        <svg ref={svg} className={cx('nv-plot-svg', held !== undefined && 'is-moving')} width={width} height={height} role="img" aria-label={t('剧情图', 'Plot graph')} onPointerMove={carry} onPointerUp={letGo} onPointerCancel={() => { grab.current = undefined; setHeld(undefined) }}>
          {/* tracks first, stations on top */}
          {graph.tracks.map((item) => {
            const first = item.stations[0]
            const last = item.stations.at(-1)
            const shelved = item.line?.shelved === true
            const dash = shelved ? '5 5' : undefined
            const active = track?.id === item.id
            const from = item.line?.from !== undefined ? graph.stations.get(item.line.from) : undefined
            const into = item.line?.into !== undefined ? graph.stations.get(item.line.into) : undefined
            const startX = item.line === undefined ? x(0) - 30 : from !== undefined ? x(from.column) : x(0) - 30
            return (
              <g key={item.id} className={cx('nv-plot-track', active && 'is-active', shelved && 'is-shelved')} style={{ color: item.colour }}>
                {item.line === undefined ? (
                  <path d={`M ${startX} ${y(0)} L ${x(Math.max(0, graph.tracks[0]!.stations.length > 0 ? last!.column : 0)) + 24} ${y(0)}`} className="nv-plot-rail is-main" />
                ) : (
                  <>
                    {/* where it leaves: from the station it parts at, or from the edge when it starts the story another way */}
                    {first !== undefined
                      ? <path d={from !== undefined ? bend(x(from.column), y(from.lane), x(first.column), y(item.lane)) : `M ${x(0) - 30} ${y(item.lane)} L ${x(first.column)} ${y(item.lane)}`} className="nv-plot-rail" strokeDasharray={dash} />
                      : from !== undefined ? <path d={bend(x(from.column), y(from.lane), x(from.column + 1), y(item.lane))} className="nv-plot-rail" strokeDasharray="3 5" /> : null}
                    {first !== undefined && last !== undefined && first !== last ? <path d={`M ${x(first.column)} ${y(item.lane)} L ${x(last.column)} ${y(item.lane)}`} className="nv-plot-rail" strokeDasharray={dash} /> : null}
                    {/* where it arrives */}
                    {into !== undefined && last !== undefined ? <path d={bend(x(last.column), y(item.lane), x(into.column), y(into.lane))} className="nv-plot-rail" strokeDasharray={dash} /> : null}
                    {last !== undefined && into === undefined ? <path d={`M ${x(last.column)} ${y(item.lane)} L ${x(last.column) + 26} ${y(item.lane)}`} className="nv-plot-rail is-open" /> : null}
                  </>
                )}
                {/* Its two ends, to be taken hold of: where it leaves, and where it arrives (or would). */}
                {item.line !== undefined ? (() => {
                  const mine = item.line
                  const leave = from !== undefined
                    ? along(x(from.column), y(from.lane), x(first?.column ?? from.column + 1), y(item.lane), 0.32)
                    : { x: x(0) - 30, y: y(item.lane) }
                  const arrive = into !== undefined && last !== undefined
                    ? along(x(last.column), y(item.lane), x(into.column), y(into.lane), 0.68)
                    : last !== undefined ? { x: x(last.column) + 26, y: y(item.lane) } : undefined
                  return (
                    <>
                      <circle className="nv-plot-end" cx={leave.x} cy={leave.y} r={5.5} onPointerDown={(event) => { take({ kind: 'from', line: mine.id, ...pointOf(event) }, event) }}>
                        <title>{t('拖到另一章上：改成从那一章之后分出。拖到空白处：从故事开头就是另一条路', 'Drag onto another chapter: the line leaves after it. Onto nothing: it goes its own way from the first page')}</title>
                      </circle>
                      {arrive !== undefined ? (
                        <circle className="nv-plot-end" cx={arrive.x} cy={arrive.y} r={5.5} onPointerDown={(event) => { take({ kind: 'into', line: mine.id, ...pointOf(event) }, event) }}>
                          <title>{t('拖到另一条线的一章上：汇入那一章。拖到空白处：不汇入', 'Drag onto a chapter of another line: the line arrives at it. Onto nothing: it arrives nowhere')}</title>
                        </circle>
                      ) : null}
                    </>
                  )
                })() : null}
                {/* The line's name, on its own track and to the left of where it begins: clear of the stations, their titles and the curve it leaves by. */}
                {(() => {
                  const edge = item.line === undefined ? PAD_X - 44 : (from !== undefined ? x(from.column) : PAD_X - 30) - 12
                  const room = Math.max(4, Math.floor((edge - 10) / 13))
                  return (
                    <g className="nv-plot-name" onClick={() => { setPicked({ kind: 'line', id: item.id }) }} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setPicked({ kind: 'line', id: item.id }) }}>
                      <title>{item.line === undefined ? t('主线：这本书被阅读、导出和搬上舞台的样子', 'The main line: the book as it is read, exported and staged') : `${item.line.title}${item.line.choice !== undefined ? ` — ${item.line.choice}` : ''}`}</title>
                      <text x={edge} y={y(item.lane) + (item.line?.choice !== undefined ? -3 : 4)} className="nv-plot-label">
                        {item.line === undefined ? `★ ${t('主线', 'Main line')}` : `${shelved ? '⏸ ' : ''}${clipText(item.line.title, Math.min(18, room))}`}
                      </text>
                      {item.line?.choice !== undefined ? <text x={edge} y={y(item.lane) + 13} className="nv-plot-choice">{clipText(item.line.choice, Math.min(24, Math.floor(room * 1.15)))}</text> : null}
                    </g>
                  )
                })()}
              </g>
            )
          })}
          {graph.tracks.map(item => item.stations.map((node) => {
            const written = node.info?.hasText === true
            const active = picked?.kind === 'chapter' && picked.id === node.plan.id
            return (
              <g
                key={node.plan.id}
                className={cx('nv-plot-station', written && 'is-written', active && 'is-active', node.plan.status === 'idea' && 'is-idea', held?.kind === 'chapter' && held.id === node.plan.id && 'is-held', landing?.side === 'on' && landing.node.plan.id === node.plan.id && 'is-target')}
                style={{ color: item.colour }}
                transform={`translate(${x(node.column)} ${y(node.lane)})`}
                onPointerDown={(event) => { take({ kind: 'chapter', id: node.plan.id, ...pointOf(event) }, event) }}
                onClick={() => {
                  if (dropped.current) return
                  setPicked({ kind: 'chapter', id: node.plan.id })
                  controller.focusChapter(node.plan.id)
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => { if (event.key === 'Enter') setPicked({ kind: 'chapter', id: node.plan.id }) }}
              >
                <title>{`${node.info?.index ?? ''}. ${node.plan.title}${node.plan.synopsis !== undefined ? `\n${node.plan.synopsis}` : ''}`}</title>
                <circle r={RADIUS} />
                <text className="nv-plot-index" y={4}>{node.info?.index ?? ''}</text>
                <text className="nv-plot-title" y={RADIUS + 15}>{clipText(node.plan.title, 6)}</text>
              </g>
            )
          }))}
          {/* What is in the hand, and where it would land. */}
          {held?.kind === 'chapter' ? (
            <g className="nv-plot-held" transform={`translate(${held.x} ${held.y})`}>
              <circle r={RADIUS} />
              <text className="nv-plot-index" y={4}>{graph.stations.get(held.id)?.info?.index ?? ''}</text>
            </g>
          ) : null}
          {held?.kind === 'chapter' && landing !== undefined && landing.side !== 'on' ? (
            <line className="nv-plot-slot" x1={x(landing.node.column) + (landing.side === 'before' ? -STEP_X / 2 : STEP_X / 2)} x2={x(landing.node.column) + (landing.side === 'before' ? -STEP_X / 2 : STEP_X / 2)} y1={y(landing.node.lane) - 20} y2={y(landing.node.lane) + 20} />
          ) : null}
          {held !== undefined && held.kind !== 'chapter' ? (() => {
            // The end of the line in the hand, drawn from where the line itself is to where the hand has it.
            const own = graph.tracks.find(candidate => candidate.id === held.line)
            const anchor = held.kind === 'from' ? own?.stations[0] : own?.stations.at(-1)
            const start = anchor !== undefined ? { x: x(anchor.column), y: y(anchor.lane) } : { x: held.x, y: held.y }
            const end = landing !== undefined ? { x: x(landing.node.column), y: y(landing.node.lane) } : { x: held.x, y: held.y }
            return <path className="nv-plot-pull" style={{ color: own?.colour }} d={held.kind === 'from' ? bend(end.x, end.y, start.x, start.y) : bend(start.x, start.y, end.x, end.y)} />
          })() : null}
        </svg>
      </div>

      {station !== undefined ? (
        <section className="nv-card nv-plot-detail">
          <div className="nv-audio-summary">
            <strong>{labelOf(station.plan.id)}</strong>
            <Chip tone={station.info?.hasText === true ? 'green' : 'neutral'}>{station.info?.hasText === true ? t(`已写 ${station.info.words} 字`, `${station.info.words} words`) : t('未写', 'not written')}</Chip>
          </div>
          {station.plan.synopsis !== undefined ? <p className="nv-small">{station.plan.synopsis}</p> : null}
          <div className="nv-row-wrap">
            <Button size="sm" icon={station.info?.hasText === true ? 'pen' : 'feather'} onClick={() => { controller.setView('write', station.plan.id) }}>{station.info?.hasText === true ? t('打开正文', 'Open the text') : t('写这一章', 'Write it')}</Button>
            <Button size="sm" icon="tree" onClick={() => { controller.setView('outline', station.plan.id) }}>{t('改章纲', 'Edit its outline')}</Button>
            <Button size="sm" variant="outline" icon="branch" onClick={() => { setMoving({ chapters: [station.plan.id] }) }} title={t('把这一章移到另一条线，或这条线里的另一个位置', 'Onto another line, or elsewhere on this one')}>{t('移到…', 'Move to…')}</Button>
            <Button size="sm" variant="outline" icon="branch" onClick={() => { setMoving({ chapters: runFrom(station), fresh: true }) }} title={t('这一章和它后面的章节另成一条线：从哪一章分出，你来定', 'This chapter and those after it become a line of their own, leaving where you say')}>{t('把这一章及之后分成一条线…', 'Part this chapter and what follows into a line…')}</Button>
            <span className="nv-spacer" />
            <Button size="sm" icon="branch" onClick={() => { setDeriving({ ...(station.line !== undefined ? { line: station.line } : {}), after: station.plan.id, mode: 'branch' }) }} title={t('这一章之后原来的走向保留；策划另外推演一条不同的线', 'What follows this chapter stays; the planner derives another way on, as a line of its own')}>{t('从这里另开一条线', 'Open a line from here')}</Button>
            <Button size="sm" icon="refresh" onClick={() => { setDeriving({ ...(station.line !== undefined ? { line: station.line } : {}), after: station.plan.id, mode: 'replace' }) }} title={t('换掉这一章之后的大纲；写了正文的章节留成搁置的线', 'Replace the outline after this chapter; written chapters are kept as a shelved line')}>{t('重写这之后的大纲', 'Rewrite the outline after it')}</Button>
          </div>
        </section>
      ) : null}

      {track !== undefined && picked?.kind === 'line' ? (
        <section className="nv-card nv-plot-detail">
          <div className="nv-audio-summary">
            <strong style={{ color: track.colour }}>{track.line === undefined ? `★ ${t('主线', 'Main line')}` : track.line.title}</strong>
            {track.line !== undefined ? <Chip>{t(...ORIGIN[track.line.origin])}</Chip> : null}
            {track.line?.shelved === true ? <Chip tone="amber">{t('已搁置', 'Put aside')}</Chip> : null}
            <span className="nv-muted nv-small">{t(`${track.stations.length} 章，已写 ${track.stations.filter(node => node.info?.hasText === true).length} 章`, `${track.stations.length} chapters, ${track.stations.filter(node => node.info?.hasText === true).length} written`)}</span>
          </div>
          {track.line === undefined ? <p className="nv-muted nv-small">{t('主线是这本书被阅读、导出和演出的那条线。', 'The main line is the one the book is read, exported and staged by.')}</p> : (
            <p className="nv-small">
              {track.line.from !== undefined ? t(`从${labelOf(track.line.from)}之后分出`, `Leaves after ${labelOf(track.line.from)}`) : t('从故事开头就走另一条路', 'Goes another way from the first page')}
              {track.line.choice !== undefined ? t(`；分叉处的抉择：${track.line.choice}`, `; the choice there: ${track.line.choice}`) : ''}
              {track.line.into !== undefined ? t(`；汇入${labelOf(track.line.into)}`, `; arrives at ${labelOf(track.line.into)}`) : t('；没有汇入别的线', '; arrives nowhere')}
              {track.line.premise !== undefined ? <><br /><span className="nv-muted">{track.line.premise}</span></> : null}
            </p>
          )}
          <div className="nv-row-wrap">
            <Button size="sm" icon="feather" onClick={() => { writeNext(track) }}>{t('写这条线的下一章', 'Write this line\'s next chapter')}</Button>
            <Button size="sm" icon="sparkles" onClick={() => { setDeriving({ ...(track.line !== undefined ? { line: track.line.id } : {}), mode: 'append' }) }}>{t('推演后续章节', 'Derive more chapters')}</Button>
            {track.line !== undefined ? (
              <>
                <span className="nv-spacer" />
                <Button size="sm" icon="star" disabled={busy} pending={t('正在设为主线…', 'Making it the main line…')} onClick={() => { confirm.ask(t(`把「${track.line!.title}」设为主线？原来主线上被替换的那一段会变成一条线。`, `Make "${track.line!.title}" the main line? The stretch of the main line it replaces becomes a line of its own.`), () => { void run(async () => { await apply([{ op: 'promote-line', line: track.line!.id }]); setPicked(undefined); controller.toast('success', t('已设为主线', 'It is the main line now')) }) }) }}>{t('设为主线', 'Make it the main line')}</Button>
                <Button size="sm" icon="merge" onClick={() => { setJoining(track.line) }}>{track.line.into !== undefined ? t('改汇入的地方', 'Change where it arrives') : t('汇入另一条线…', 'Join another line…')}</Button>
                <Button size="sm" icon="pen" onClick={() => { setEditing(track.line) }}>{t('改名和说明', 'Rename')}</Button>
                <HistoryButton kind="line" id={track.line.id} name={track.line.title} />
                <Button size="sm" variant="ghost" icon={track.line.shelved === true ? 'play' : 'pause'} pending={t('正在保存…', 'Saving…')} onClick={() => run(async () => { await apply([{ op: 'update-line', line: track.line!.id, shelved: track.line!.shelved !== true }]) })} title={t('搁置的线保留在图上，只是写下一章时不再列出来', 'A line put aside stays on the graph; it is only no longer offered when the next chapter is chosen')}>{track.line.shelved === true ? t('重新启用', 'Take it up again') : t('搁置', 'Put aside')}</Button>
                <Button size="sm" variant="ghost" icon="trash" onClick={() => { confirm.ask(t(`删除「${track.line!.title}」和它的 ${track.line!.chapters.length} 章？有正文的章节会先各存一份历史版本。`, `Delete "${track.line!.title}" and its ${track.line!.chapters.length} chapter(s)? Written chapters are each kept as a version first.`), () => { void run(async () => { await apply([{ op: 'remove-line', line: track.line!.id }]); setPicked(undefined) }) }) }}>{t('删除这条线', 'Delete the line')}</Button>
              </>
            ) : null}
          </div>
          {/* The line as a world of its own, and held against another: who lives and dies on it, what it leaves open. */}
          <LineWorldPanel key={track.id} line={track.line?.id ?? MAIN_LINE} names={[{ id: MAIN_LINE, title: `★ ${t('主线', 'Main line')}` }, ...lines.map(line => ({ id: line.id, title: line.title }))]} />
        </section>
      ) : null}

      {deriving !== undefined ? (
        <Modal wide title={deriving.mode === 'branch' ? t('另开一条线', 'Open another line') : deriving.mode === 'replace' ? t('重写这之后的大纲', 'Rewrite the outline from here') : t('推演后续章节', 'Derive more chapters')} onClose={() => { setDeriving(undefined) }}>
          <Derive only="chapters" preset={deriving} onApplied={() => { setDeriving(undefined) }} />
        </Modal>
      ) : null}
      {editing !== undefined ? <LineEditor line={editing === 'new' ? undefined : editing} stations={graph.stations} labelOf={labelOf} onClose={() => { setEditing(undefined) }} onSave={async (ops) => { await apply(ops) }} /> : null}
      {moving !== undefined ? <MoveChapters chapters={moving.chapters} preset={{ ...(moving.fresh === true ? { fresh: true } : {}) }} onClose={() => { setMoving(undefined) }} /> : null}
      {joining !== undefined ? <JoinDialog line={joining} graph={graph} labelOf={labelOf} onClose={() => { setJoining(undefined) }} onSave={async (ops) => { await apply(ops) }} /> : null}
      {confirm.element}
    </div>
  )
}

function clipText(text: string, max: number): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

/** Name a line, and say what sets it apart; for a new one, where it leaves. */
function LineEditor({ line, stations, labelOf, onClose, onSave }: { line: PlotLine | undefined; stations: Map<string, Station>; labelOf: (id: string | undefined) => string; onClose: () => void; onSave: (ops: OutlineOpInput[]) => Promise<void> }) {
  const t = useT()
  const { busy, run } = useAction()
  const [title, setTitle] = useState(line?.title ?? '')
  const [choice, setChoice] = useState(line?.choice ?? '')
  const [premise, setPremise] = useState(line?.premise ?? '')
  const [from, setFrom] = useState(line?.from ?? '')
  const options = [...stations.values()].filter(station => line === undefined || station.line !== line.id).map(station => ({ value: station.plan.id, label: labelOf(station.plan.id) }))
  const save = (): Promise<unknown> => run(async () => {
    await onSave([line === undefined
      ? { op: 'add-line', title, ...(from.length > 0 ? { from } : {}), ...(choice.trim().length > 0 ? { choice } : {}), ...(premise.trim().length > 0 ? { premise } : {}) }
      : { op: 'update-line', line: line.id, title, choice, premise, ...(from !== (line.from ?? '') ? { from: from.length > 0 ? from : null } : {}) }])
    onClose()
  })
  return (
    <Modal title={line === undefined ? t('开一条新线', 'Open a line') : t('这条线的名字和说明', 'The line\'s name and what it says of itself')} onClose={onClose} footer={<Button variant="primary" busy={busy} disabled={title.trim().length === 0} pending={t('正在保存…', 'Saving…')} onClick={save}>{t('保存', 'Save')}</Button>}>
      <Field label={t('这条线叫什么', 'What the line is called')}><TextInput autoFocus value={title} placeholder={t('例：她没有烧掉那封信', 'e.g. She keeps the letter')} onChange={(event) => { setTitle(event.target.value) }} /></Field>
      <Field label={t('从哪一章之后分出', 'The chapter it leaves after')} hint={line === undefined ? t('不选：从故事开头就走另一条路。', 'None: another road from the very start.') : t('改这里就是把这条线接到别处；不选：从头就是另一个故事。', 'Changing it joins the line on elsewhere; none: another story from its first page.')}>
        <Select value={from} options={[{ value: '', label: t('（故事开头）', '(the start of the story)') }, ...options]} onChange={setFrom} />
      </Field>
      <Field label={t('分叉处的抉择（可不填）', 'What is decided there (optional)')} hint={t('谁在那里做了什么决定。读者在分叉处看到的就是它。', 'Who decided what there. It is what a reader sees at the fork.')}>
        <TextInput value={choice} onChange={(event) => { setChoice(event.target.value) }} />
      </Field>
      <Field label={t('这条线讲的是什么（可不填）', 'What this line is about (optional)')}><TextArea value={premise} minRows={2} onChange={(event) => { setPremise(event.target.value) }} /></Field>
    </Modal>
  )
}

/** Say where a line arrives: the chapter of another line from which the two are one story again. */
function JoinDialog({ line, graph, labelOf, onClose, onSave }: { line: PlotLine; graph: Layout; labelOf: (id: string | undefined) => string; onClose: () => void; onSave: (ops: OutlineOpInput[]) => Promise<void> }) {
  const t: Translate = useT()
  const { busy, run } = useAction()
  const [into, setInto] = useState(line.into ?? '')
  const from = line.from !== undefined ? graph.stations.get(line.from) : undefined
  // A line arrives after where it left: at a chapter further on, on another line.
  const options = [...graph.stations.values()].filter(station => station.line !== line.id && (from === undefined || station.column > from.column)).sort((left, right) => left.lane - right.lane || left.column - right.column).map(station => ({ value: station.plan.id, label: labelOf(station.plan.id) }))
  const save = (): Promise<unknown> => run(async () => {
    await onSave([{ op: 'update-line', line: line.id, into: into.length > 0 ? into : null }])
    onClose()
  })
  return (
    <Modal title={t(`「${line.title}」汇入哪里`, `Where "${line.title}" arrives`)} onClose={onClose} footer={<Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} onClick={save}>{t('保存', 'Save')}</Button>}>
      <p className="nv-muted nv-small">{t('这条线走完后接到另一条线的某一章：从那一章起是同一个故事。', 'Where this line ends it joins a chapter of another: from there the two are one story.')}</p>
      <Field label={t('汇入的章节', 'The chapter it arrives at')}>
        <Select value={into} options={[{ value: '', label: t('（不汇入：这条线自己走到底）', '(nowhere: the line runs to its own end)') }, ...options]} onChange={setInto} />
      </Field>
      {options.length === 0 ? <p className="nv-note">{t('在它分出的地方之后，别的线上还没有章节可以汇入。', 'No other line has a chapter after the one this line leaves at.')}</p> : null}
    </Modal>
  )
}


/** Import a manuscript as another line of this book: a story different from its first chapter, in the same world. */
function ImportLine({ onClose }: { onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [title, setTitle] = useState('')
  const [premise, setPremise] = useState('')
  const [file, setFile] = useState<{ name: string; data: string } | undefined>()
  const [digest, setDigest] = useState(true)
  const { busy, run } = useAction()
  const start = (): Promise<unknown> => run(async () => {
    await controller.api.call('line.import', { root, ...(title.trim().length > 0 ? { title: title.trim() } : {}), ...(premise.trim().length > 0 ? { premise: premise.trim() } : {}), file: file!, ...(digest ? {} : { digest: false }) })
    await controller.refreshJobs()
    controller.toast('info', t('正在导入这条线，进度在底部的任务条里。', 'Importing the line; progress is in the task bar below.'))
    onClose()
  })
  return (
    <Modal title={t('导入另一条故事线', 'Import another story line')} onClose={onClose} footer={(
      <>
        <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" icon="upload" disabled={file === undefined} busy={busy} onClick={start}>{t('导入', 'Import')}</Button>
      </>
    )}>
      <p className="nv-muted nv-small">{t('从头就不一样的另一个故事，和这本书共用人物、地点和设定。', 'Another story, different from its first chapter, sharing this book\'s people, places and bible.')}</p>
      <Field label={t('书稿', 'Manuscript')} hint={t('.txt / .md / .epub / .docx', '.txt / .md / .epub / .docx')}>
        <input type="file" accept=".txt,.md,.markdown,.epub,.docx" onChange={(event) => {
          const picked = event.target.files?.[0]
          if (picked === undefined) return
          void readBase64(picked).then((data) => { setFile({ name: picked.name, data }) }, () => { controller.toast('error', t('没能读这个文件', 'Could not read the file')) })
        }} />
      </Field>
      <Field label={t('这条线的名字', 'Name of the line')} hint={t('不填就用书稿自己的名字', 'Left empty, the manuscript\'s own')}><TextInput value={title} onChange={(event) => { setTitle(event.target.value) }} /></Field>
      <Field label={t('这条线讲的是什么', 'What the line tells')}><TextInput value={premise} onChange={(event) => { setPremise(event.target.value) }} /></Field>
      <label className="nv-check"><input type="checkbox" checked={digest} onChange={(event) => { setDigest(event.target.checked) }} /><span>{t('导入后逐章收录', 'Digest its chapters once they are in')}</span></label>
    </Modal>
  )
}

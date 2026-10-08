// SPDX-License-Identifier: LGPL-3.0-or-later
/** Reading a book's lines of plot off its state: what is read along a line, and where the story parts. */
import { MAIN_LINE, type ChapterInfo, type PlotLine, type ProjectState } from './types'

/** The chapters read on a line of the plot, in order and counted along it; the main line's when the line is not known. */
export function linePath(project: ProjectState, line: string): ChapterInfo[] {
  if (line === MAIN_LINE) return project.chapters
  const info = project.lines?.find(candidate => candidate.id === line)
  if (info === undefined) return project.chapters
  const known = new Map([...project.chapters, ...(project.lines ?? []).flatMap(candidate => candidate.chapters)].map(chapter => [chapter.id, chapter]))
  return info.path.map(id => known.get(id)).map((chapter, at) => chapter !== undefined ? { ...chapter, index: at + 1 } : undefined).filter((chapter): chapter is ChapterInfo => chapter !== undefined)
}

/** A way the story goes on after a chapter, other than along the line being read. */
export interface WayOn {
  line: string
  /** The line's entry in the outline; absent for the main line. */
  info?: PlotLine
  /** True for the line the one being read left here: it goes on as it went before, and no choice names it. */
  left?: boolean
  /** The chapters this way goes through after the fork, counted along its own line. */
  chapters: ChapterInfo[]
}

/**
 * Where the story parts after a chapter, seen from the line being read: the
 * lines that leave here, and — where the line being read (or one it rides on)
 * leaves here itself — the line it left, going on without it.
 * @returns `along`: the line whose choice it is to go on along the path being read; `ways`: every other way on.
 */
export function waysOn(project: ProjectState, chapter: ChapterInfo, lineId: string): { along?: PlotLine; ways: WayOn[] } {
  const lines = project.outline.lines ?? []
  if (lines.length === 0) return { ways: [] }
  const known = new Map([...project.chapters, ...(project.lines ?? []).flatMap(candidate => candidate.chapters)].map(item => [item.id, item]))
  // The line being read and the lines it reaches its first chapter by.
  const riding = new Set<string>()
  for (let at: string | undefined = lineId; at !== undefined && at !== MAIN_LINE && !riding.has(at);) {
    riding.add(at)
    const from = lines.find(candidate => candidate.id === at)?.from
    at = from !== undefined ? known.get(from)?.line : undefined
  }
  const along = lines.find(candidate => riding.has(candidate.id) && candidate.from === chapter.id)
  const ways: WayOn[] = []
  if (along !== undefined) {
    const home = chapter.line ?? MAIN_LINE
    const own = linePath(project, home)
    const at = own.findIndex(candidate => candidate.id === chapter.id)
    const onward = at >= 0 ? own.slice(at + 1) : []
    const info = lines.find(candidate => candidate.id === home)
    if (onward.length > 0) ways.push({ line: home, ...(info !== undefined ? { info } : {}), left: true, chapters: onward })
  }
  for (const line of lines) {
    if (line.from !== chapter.id || riding.has(line.id) || line.shelved === true) continue
    const own = new Set((project.lines?.find(candidate => candidate.id === line.id)?.chapters ?? []).map(item => item.id))
    ways.push({ line: line.id, info: line, chapters: linePath(project, line.id).filter(item => own.has(item.id)) })
  }
  return { ...(along !== undefined ? { along } : {}), ways }
}

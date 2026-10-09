// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Moving chapters to another place in the plot.
 *
 * A chapter — or a run of them — goes elsewhere on its line, onto another
 * line, or onto a line opened for it: a side story that was imported among the
 * chapters of the main line is parted from it by hand this way. It is the one
 * way to do so, and the plot graph, the outline and the writing page all open
 * it. Everything made from a chapter goes with it; lines that leave after it,
 * or arrive at it, follow it where it goes.
 */
import { useMemo, useState } from 'react'
import { pathOfLine } from '../shared/lines'
import { MAIN_LINE, type ChapterPlan, type PlotLine } from '../shared/types'
import { Button, Field, Modal, Select, TextInput, useAction, useProject, useStudio, useT } from './ui'

/** The choice of a line that is not there yet. */
const NEW_LINE = '+'
/** The choice of the place before every chapter of a line. */
const START = '^'

/**
 * @param chapters - the chapters to move, by id, in the order they are to keep.
 * @param preset - `fresh`: a line of their own is what is offered first.
 */
export function MoveChapters({ chapters, preset, onClose, onMoved }: { chapters: string[]; preset?: { fresh?: boolean } | undefined; onClose: () => void; onMoved?: (() => void) | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const lines = useMemo(() => project.outline.lines ?? [], [project.outline])
  const moving = useMemo(() => new Set(chapters), [chapters])
  const info = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter])), [project.chapters, project.lines])
  const plans = useMemo(() => new Map<string, { plan: ChapterPlan; line: string }>([
    ...project.outline.volumes.flatMap(volume => volume.chapters.map(plan => [plan.id, { plan, line: MAIN_LINE }] as const)),
    ...lines.flatMap(line => line.chapters.map(plan => [plan.id, { plan, line: line.id }] as const)),
  ]), [project.outline, lines])
  const nameOf = (id: string): string => (id === MAIN_LINE ? t('主线', 'Main line') : lines.find(line => line.id === id)?.title ?? id)
  const labelOf = (id: string): string => {
    const found = plans.get(id)
    return found === undefined ? id : `${info.get(id)?.index ?? '?'}. ${found.plan.title}`
  }
  const home = plans.get(chapters[0] ?? '')?.line ?? MAIN_LINE
  // A line that parts — itself, or through the lines it parts from — after one of the chapters moved cannot take
  // them in: it would leave after a chapter of its own.
  const tied = (line: PlotLine, guard: ReadonlySet<string> = new Set()): boolean => {
    if (line.from === undefined || guard.has(line.id)) return false
    if (moving.has(line.from)) return true
    const parent = plans.get(line.from)?.line
    const up = parent !== undefined && parent !== MAIN_LINE ? lines.find(candidate => candidate.id === parent) : undefined
    return up !== undefined && tied(up, new Set(guard).add(line.id))
  }
  const ownOf = (line: string): ChapterPlan[] => (line === MAIN_LINE ? project.outline.volumes.flatMap(volume => volume.chapters) : lines.find(candidate => candidate.id === line)?.chapters ?? []).filter(plan => !moving.has(plan.id))
  const [target, setTarget] = useState<string>(preset?.fresh === true ? NEW_LINE : home)
  // Where among the chapters there: after the last, unless the author says otherwise.
  const [after, setAfter] = useState<string | undefined>()
  const there = target === NEW_LINE ? [] : ownOf(target)
  const place = after !== undefined && (after === START || there.some(plan => plan.id === after)) ? after : there.at(-1)?.id ?? START
  const [title, setTitle] = useState('')
  // Where a line opened for them leaves, unless the author says otherwise: after the chapter read before the first of them.
  const before = useMemo(() => {
    const path = pathOfLine(project, home)
    const at = path.indexOf(chapters[0] ?? '')
    return at > 0 ? [...path.slice(0, at)].reverse().find(id => !moving.has(id)) : undefined
  }, [project, home, chapters, moving])
  const [from, setFrom] = useState<string | undefined>()
  const leaves = from ?? before ?? ''
  const everywhere = [...plans.entries()].filter(([id]) => !moving.has(id))
  const ready = chapters.length > 0 && (target !== NEW_LINE || title.trim().length > 0)
  const move = (): Promise<unknown> => run(async () => {
    const op = target === NEW_LINE
      ? { op: 'move-chapters', chapters, line: 'new', title: title.trim(), ...(leaves.length > 0 ? { from: leaves } : {}) }
      : { op: 'move-chapters', chapters, line: target, ...(place === START ? (there[0] !== undefined ? { before: there[0].id } : {}) : { after: place }) }
    const { results } = await controller.api.call('outline.apply', { root, ops: [op] })
    const failed = results.find(result => !result.ok)
    if (failed !== undefined) throw new Error(failed.message)
    await controller.refreshProject()
    controller.toast('success', target === NEW_LINE
      ? t(`${chapters.length} 章移到了新线「${title.trim()}」`, `${chapters.length} chapter(s) moved onto the new line "${title.trim()}"`)
      : t(`${chapters.length} 章移到了「${nameOf(target)}」`, `${chapters.length} chapter(s) moved to "${nameOf(target)}"`))
    onMoved?.()
    onClose()
  })
  const first = plans.get(chapters[0] ?? '')?.plan
  return (
    <Modal
      title={chapters.length === 1 && first !== undefined ? t(`移动「${first.title}」`, `Move "${first.title}"`) : t(`移动 ${chapters.length} 章`, `Move ${chapters.length} chapters`)}
      onClose={onClose}
      footer={<Button variant="primary" busy={busy} disabled={!ready} pending={t('正在移动…', 'Moving…')} onClick={move}>{t('移动', 'Move')}</Button>}
    >
      {chapters.length > 1 ? <p className="nv-muted nv-small">{chapters.map(labelOf).join(t('、', ', '))}</p> : null}
      <Field label={t('移到哪条线', 'Onto which line')}>
        <Select
          value={target}
          onChange={(next) => { setTarget(next); setAfter(undefined) }}
          options={[
            { value: MAIN_LINE, label: `★ ${t('主线', 'Main line')}` },
            ...lines.map(line => ({ value: line.id, label: tied(line) ? t(`${line.title}（它是从要移的章节分出去的）`, `${line.title} (it parts after a chapter being moved)`) : line.title, disabled: tied(line) })),
            { value: NEW_LINE, label: t('＋ 另开一条线', '+ A line of their own') },
          ]}
        />
      </Field>
      {target === NEW_LINE ? (
        <>
          <Field label={t('这条线叫什么', 'What the line is called')}><TextInput autoFocus value={title} placeholder={t('例：番外 · 城南旧事', 'e.g. Side story: the south of the city')} onChange={(event) => { setTitle(event.target.value) }} /></Field>
          <Field label={t('从哪一章之后分出', 'The chapter it leaves after')} hint={t('不分出：从头就是另一个故事，只共用这个世界。', 'None: another story from its first page, sharing the world only.')}>
            <Select value={leaves} onChange={setFrom} options={[{ value: '', label: t('（不分出）', '(none)') }, ...everywhere.map(([id, found]) => ({ value: id, label: `${found.line === MAIN_LINE ? '' : `${nameOf(found.line)} · `}${labelOf(id)}` }))]} />
          </Field>
        </>
      ) : (
        <Field label={t('放在哪一章之后', 'After which chapter')}>
          <Select value={place} onChange={setAfter} options={[{ value: START, label: t('（最前面）', '(before all of them)') }, ...there.map(plan => ({ value: plan.id, label: labelOf(plan.id) }))]} />
        </Field>
      )}
      <p className="nv-muted nv-small">{t('正文、收录、配音、分镜都跟着章节走。从这些章节分出去的线，仍然从它们分出。', 'The text and whatever was made from a chapter go with it. Lines that part after these chapters still part after them.')}</p>
    </Modal>
  )
}

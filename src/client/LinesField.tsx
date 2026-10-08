// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Which lines of the plot somebody or something belongs to.
 *
 * A world may hold several stories — lines that part somewhere, or that are
 * different from their first chapter — and not everybody is in all of them.
 * A card or an entry that names no line belongs to every one; one that names
 * some is theirs alone: it is kept out of what the writer of another line is
 * told. Shown only in a book that has more than one line.
 *
 *   LinesField   the choice, on a card or an entry
 *   LineTags     the lines beside a name: the ones it is kept to, or the ones it is seen on
 */
import { MAIN_LINE } from '../shared/types'
import { Chip, cx, Field, useProject, useT } from './ui'

/** The lines of this book by id, the main one first; empty where the book has one line only. */
export function useLines(): { id: string; title: string }[] {
  const t = useT()
  const { project } = useProject()
  const others = (project.outline.lines ?? []).map(line => ({ id: line.id, title: line.title }))
  return others.length === 0 ? [] : [{ id: MAIN_LINE, title: t('主线', 'Main line') }, ...others]
}

export function LinesField({ value, onChange }: { value: string[] | undefined; onChange: (lines: string[]) => void }) {
  const t = useT()
  const lines = useLines()
  if (lines.length === 0) return null
  const kept = (value ?? []).filter(id => lines.some(line => line.id === id))
  return (
    <Field label={t('世界线', 'Plot lines')} hint={t('只属于某几条线的，别的线写作时不会带上', 'Kept to some lines, it is left out when another line is written')}>
      <div className="nv-line-pick">
        <button type="button" className={cx('nv-chip', kept.length === 0 && 'is-on')} onClick={() => { onChange([]) }}>{t('全部', 'All')}</button>
        {lines.map(line => (
          <button key={line.id} type="button" className={cx('nv-chip', kept.includes(line.id) && 'is-on')} onClick={() => { onChange(kept.includes(line.id) ? kept.filter(id => id !== line.id) : [...kept, line.id]) }}>{line.title}</button>
        ))}
      </div>
    </Field>
  )
}

/**
 * @param lines - the lines it is kept to, where the author said so.
 * @param seen - the lines it is seen on, read off the digests: shown where nothing is said.
 */
export function LineTags({ lines, seen }: { lines?: string[] | undefined; seen?: string[] | undefined }) {
  const t = useT()
  const all = useLines()
  if (all.length === 0) return null
  const name = (id: string): string => all.find(line => line.id === id)?.title ?? id
  const kept = (lines ?? []).filter(id => all.some(line => line.id === id))
  if (kept.length > 0) return <>{kept.map(id => <Chip key={id} tone="violet">{t(`仅 ${name(id)}`, `${name(id)} only`)}</Chip>)}</>
  const on = (seen ?? []).filter(id => all.some(line => line.id === id))
  if (on.length === 0) return null
  return <span className="nv-muted nv-small">{t(`出现在：${on.map(name).join('、')}`, `Seen on: ${on.map(name).join(', ')}`)}</span>
}

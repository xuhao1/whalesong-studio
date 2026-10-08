// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Which chapter a screen is on — said where the chapter's name stands, and
 * changed there: the title is the switch. Press it for the list of chapters,
 * or step to the one before and the one after with the arrows beside it.
 *
 * A book with more than one line of plot lists each line's chapters under the
 * line's name; a chapter a screen cannot show (nothing written yet, when the
 * screen needs text) is listed and cannot be chosen, with the reason.
 */
import { useMemo } from 'react'
import type { ChapterInfo } from '../shared/types'
import { Icon } from './icons'
import { cx, Popover, useProject, useT } from './ui'

/**
 * @param usable - whether the screen can show a chapter; the others are listed, greyed, with `unusable` as the reason.
 */
export function ChapterSwitch({ chapter, onChange, usable, unusable, className }: {
  chapter: ChapterInfo
  onChange: (id: string) => void
  usable?: (chapter: ChapterInfo) => boolean
  unusable?: string
  className?: string
}) {
  const t = useT()
  const { project } = useProject()
  const groups = useMemo(() => {
    const lines = project.outline.lines ?? []
    return [
      { id: '', title: lines.length > 0 ? t('主线', 'Main line') : undefined, chapters: project.chapters },
      ...(project.lines ?? []).map(line => ({ id: line.id, title: lines.find(candidate => candidate.id === line.id)?.title ?? line.id, chapters: line.chapters })),
    ].filter(group => group.chapters.length > 0)
  }, [project.chapters, project.lines, project.outline.lines, t])
  const can = (candidate: ChapterInfo): boolean => usable?.(candidate) ?? true
  // The one before and the one after, among those of its own line this screen can show.
  const own = (groups.find(group => group.chapters.some(candidate => candidate.id === chapter.id))?.chapters ?? []).filter(can)
  const at = own.findIndex(candidate => candidate.id === chapter.id)
  const before = at > 0 ? own[at - 1] : undefined
  const after = at >= 0 ? own[at + 1] : undefined
  return (
    <span className={cx('nv-chapter-switch', className)}>
      <button type="button" className="nv-chapter-step" disabled={before === undefined} onClick={() => { if (before !== undefined) onChange(before.id) }} title={before !== undefined ? t(`上一章：${before.title}`, `Previous: ${before.title}`) : t('没有上一章', 'No chapter before this')} aria-label={t('上一章', 'Previous chapter')}><Icon name="chevronLeft" size={14} /></button>
      <Popover
        className="nv-chapter-pop"
        trigger={({ open, toggle }) => (
          <button type="button" className="nv-chapter-title" aria-haspopup="listbox" aria-expanded={open} onClick={toggle} title={t('换一章', 'Change chapter')}>
            <strong>{t(`第 ${chapter.index} 章 ${chapter.title}`, `Chapter ${chapter.index} · ${chapter.title}`)}</strong>
            <Icon name="chevronDown" size={13} />
          </button>
        )}
      >
        {close => (
          <div className="nv-chapter-list" role="listbox">
            {groups.map(group => (
              <div key={group.id}>
                {group.title !== undefined ? <div className="nv-chapter-group">{group.title}</div> : null}
                {group.chapters.map((candidate) => {
                  const ok = can(candidate)
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={candidate.id === chapter.id}
                      className={cx('nv-chapter-option', candidate.id === chapter.id && 'is-active')}
                      disabled={!ok}
                      title={ok ? undefined : unusable}
                      onClick={() => { onChange(candidate.id); close() }}
                    >
                      <span className="nv-list-index">{candidate.index}</span>
                      <span className="nv-chapter-name">{candidate.title}</span>
                      {ok ? null : <span className="nv-list-meta">{unusable}</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </Popover>
      <button type="button" className="nv-chapter-step" disabled={after === undefined} onClick={() => { if (after !== undefined) onChange(after.id) }} title={after !== undefined ? t(`下一章：${after.title}`, `Next: ${after.title}`) : t('没有下一章', 'No chapter after this')} aria-label={t('下一章', 'Next chapter')}><Icon name="chevronRight" size={14} /></button>
    </span>
  )
}

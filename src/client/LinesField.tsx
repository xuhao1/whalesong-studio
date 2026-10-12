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
 *   useLinePicks / LinePickBar   a batch picked in a list, and filed under lines at once
 */
import { useCallback, useMemo, useState } from 'react'
import { MAIN_LINE } from '../shared/types'
import { Button, Chip, cx, Field, Modal, useAction, useConfirm, useProject, useStudio, useT } from './ui'

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

/** A batch of cards or entries picked in a list, to be filed under lines of the plot at once. */
export interface LinePicks {
  /** The list is being picked from: a click on a row picks it instead of opening it. */
  on: boolean
  ids: ReadonlySet<string>
  toggle: (id: string) => void
  start: () => void
  stop: () => void
  all: (ids: readonly string[]) => void
  none: () => void
}

export function useLinePicks(): LinePicks {
  const [on, setOn] = useState(false)
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((id: string) => { setIds((before) => { const next = new Set(before); if (!next.delete(id)) next.add(id); return next }) }, [])
  const start = useCallback(() => { setOn(true) }, [])
  const stop = useCallback(() => { setOn(false); setIds(new Set()) }, [])
  const all = useCallback((list: readonly string[]) => { setIds(new Set(list)) }, [])
  const none = useCallback(() => { setIds(new Set()) }, [])
  return useMemo(() => ({ on, ids, toggle, start, stop, all, none }), [on, ids, toggle, start, stop, all, none])
}

/**
 * The bar over a list that picks a batch: *Select*, then tick rows — or all that are listed — and say which lines
 * they belong to (in a book of more lines than one), or delete them together (what is deleted is kept among the
 * ones lately deleted, under the list, to be put back).
 * @param listed - the ids the list shows now, in its order: what *all* means.
 * @param kind - what the list holds: people's cards, or the bible's entries.
 */
export function LinePickBar({ picks, listed, kind }: { picks: LinePicks; listed: readonly string[]; kind: 'characters' | 'world' }) {
  const t = useT()
  const { controller } = useStudio()
  const { root } = useProject()
  const lines = useLines()
  const [asking, setAsking] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const { busy, run } = useAction()
  const confirm = useConfirm()
  // Only what is still listed is filed: a filter changed since leaves nothing behind unseen.
  const batch = listed.filter(id => picks.ids.has(id))
  const drop = (): Promise<unknown> => run(async () => {
    let gone = 0
    let failed = 0
    for (const id of batch) {
      try {
        await controller.api.call(kind === 'characters' ? 'character.delete' : 'world.delete', { root, id })
        gone += 1
      } catch {
        failed += 1
      }
    }
    await controller.refreshProject()
    controller.toast(failed > 0 ? 'error' : 'success', kind === 'characters'
      ? t(`删掉了 ${gone} 张人物卡${failed > 0 ? `，${failed} 张没删成` : ''}：列表最下面“最近删除的人物”里可以恢复`, `${gone} card(s) deleted${failed > 0 ? `, ${failed} could not be` : ''}: they can be put back from "lately deleted" under the list`)
      : t(`删掉了 ${gone} 条设定${failed > 0 ? `，${failed} 条没删成` : ''}：列表最下面“最近删除的设定”里可以恢复`, `${gone} entr${gone === 1 ? 'y' : 'ies'} deleted${failed > 0 ? `, ${failed} could not be` : ''}: they can be put back from "lately deleted" under the list`))
    picks.stop()
  })
  const askDrop = (): void => {
    confirm.ask(kind === 'characters'
      ? t(`删掉选中的 ${batch.length} 张人物卡？他们的图留在图库里；列表最下面“最近删除的人物”里可以恢复。`, `Delete the ${batch.length} card(s) picked? Their pictures stay in the gallery; the cards can be put back from "lately deleted" under the list.`)
      : t(`删掉选中的 ${batch.length} 条设定？它们的图留在图库里；列表最下面“最近删除的设定”里可以恢复。`, `Delete the ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} picked? Their pictures stay in the gallery; the entries can be put back from "lately deleted" under the list.`), () => { void drop() })
  }
  const file = (): Promise<unknown> => run(async () => {
    const done = await controller.api.call('lines.assign', { root, lines: chosen, [kind]: batch })
    const count = done.characters.length + done.world.length
    const names = chosen.map(id => lines.find(line => line.id === id)?.title ?? id).join(t('、', ', '))
    controller.toast('success', chosen.length > 0
      ? t(`${count} 项归到了：${names}`, `${count} filed under: ${names}`)
      : t(`${count} 项不再归线，${kind === 'world' ? '几条线共用' : '出现在哪条线就算哪条线的'}`, `${count} no longer filed: ${kind === 'world' ? 'shared by the lines' : 'each belongs where it is seen'}`))
    setAsking(false)
    picks.stop()
  })
  // Each under the lines it is found on: what the author would otherwise read off the text one by one.
  const byText = (): Promise<unknown> => run(async () => {
    const done = await controller.api.call('lines.assign', { root, byText: true, [kind]: batch })
    const count = done.characters.length + done.world.length
    const left = done.left?.length ?? 0
    controller.toast(count > 0 ? 'success' : 'info', t(`${count} 项照正文归了线${left > 0 ? `；${left} 项每条线都有或都还没有，没动` : ''}`, `${count} filed by the text${left > 0 ? `; ${left} are on every line or on none, and were left` : ''}`))
    setAsking(false)
    picks.stop()
  })
  return (
    <>
      {picks.on ? (
        <div className="nv-pick-bar">
          <span className="nv-small">{t(`已选 ${batch.length}`, `${batch.length} picked`)}</span>
          <button type="button" className="nv-link" onClick={() => { picks.all(listed) }}>{t(`全选（${listed.length}）`, `All (${listed.length})`)}</button>
          {batch.length > 0 ? <button type="button" className="nv-link" onClick={picks.none}>{t('清空', 'None')}</button> : null}
          <span className="nv-spacer" />
          {lines.length > 0 ? <Button size="sm" variant="primary" disabled={batch.length === 0} onClick={() => { setChosen([]); setAsking(true) }}>{t('归到世界线…', 'File under lines…')}</Button> : null}
          <Button size="sm" variant="ghost" icon="trash" busy={busy} disabled={batch.length === 0} onClick={askDrop}>{t(`删除选中的 ${batch.length} 项`, `Delete the ${batch.length} picked`)}</Button>
          <Button size="sm" variant="ghost" onClick={picks.stop}>{t('完成', 'Done')}</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" icon="check" onClick={picks.start} title={lines.length > 0 ? t('选一批：一起归到世界线，或一起删掉', 'Pick a batch: file it under lines of the plot, or delete it') : t('选一批，一起删掉', 'Pick a batch to delete together')}>{t('多选', 'Select')}</Button>
      )}
      {confirm.element}
      {asking ? (
        <Modal title={t(`把这 ${batch.length} 项归到世界线`, `File these ${batch.length} under lines`)} onClose={() => { setAsking(false) }} footer={<>
          <Button variant="ghost" icon="sparkles" busy={busy} onClick={byText} title={t('只在某几条线的正文里出现的，归到那几条线；每条线都有、或都还没写到的，不动', 'What only some lines\' text has is filed under those; what every line has, or none yet, is left')}>{t('照正文出现在哪条线来归', 'File by where the text has them')}</Button>
          <Button variant="primary" busy={busy} onClick={file}>{chosen.length > 0 ? t('只属于选中的线', 'Theirs alone') : t('不归线', 'File under none')}</Button>
        </>}>
          <div className="nv-line-pick">
            <button type="button" className={cx('nv-chip', chosen.length === 0 && 'is-on')} onClick={() => { setChosen([]) }}>{t('不归线', 'None')}</button>
            {lines.map(line => (
              <button key={line.id} type="button" className={cx('nv-chip', chosen.includes(line.id) && 'is-on')} onClick={() => { setChosen(before => (before.includes(line.id) ? before.filter(id => id !== line.id) : [...before, line.id])) }}>{line.title}</button>
            ))}
          </div>
          <p className="nv-muted nv-small">{chosen.length > 0
            ? t('别的线写作时不会带上它们。', 'They are left out when another line is written.')
            : kind === 'world' ? t('不归线的设定是几条线共用的：每条线写作时都能用到。', 'An entry filed under no line is shared: every line may be told of it.')
              : t('不归线的人物，出现在哪条线的章节里就算哪条线的。', 'Somebody filed under no line belongs to the lines whose chapters have them.')}</p>
        </Modal>
      ) : null}
    </>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The chapters of a book as a list to work on: one line of the plot at a
 * time, volume by volume on the main one. A chapter is taken by its row and
 * let go between two others, a new one is put in after any of them, several
 * are ticked and moved or removed together, and what was removed is had back.
 *
 * One control for wherever the chapters are listed to be worked on — the
 * outline, the writing page: what can be done to the order of a book is done
 * the same way in both.
 */
import { useState, type ReactNode } from 'react'
import type { OutlineOpInput } from '../shared/rpc'
import { formatCount } from '../shared/text'
import { MAIN_LINE, type ChapterInfo, type ChapterPlan, type PlotLine, type Volume } from '../shared/types'
import { HistoryButton } from './History'
import { Icon } from './icons'
import { CHAPTER_STATUS, CHAPTER_STATUS_TONE } from './labels'
import { MoveChapters } from './MoveChapters'
import { TranslateDialog } from './Translate'
import { Button, Chip, cx, Field, Menu, Modal, Select, Spinner, TextArea, TextInput, useAction, useBookLine, useConfirm, useProject, useSnapshot, useStudio, useT } from './ui'

/** Apply outline operations; the first failing one becomes the error. */
export function useOutlineOps(): (ops: OutlineOpInput[]) => Promise<{ op: string; ok: boolean; id?: string; message: string }[]> {
  const { controller } = useStudio()
  const { root } = useProject()
  return async (ops) => {
    const { results } = await controller.api.call('outline.apply', { root, ops })
    // Shown at once — a chapter let go in its new place is there when the hand leaves it — and not when the page next
    // hears of the change (which a page that is not in front does not).
    await controller.refreshProject()
    const failed = results.find(result => !result.ok)
    if (failed !== undefined) throw new Error(failed.message)
    return results
  }
}

/**
 * @param active - the chapter that is open beside the list; none while something else is (a derivation).
 * @param onOpen - a chapter's row was pressed, or a chapter was just made.
 * @param onLine - the line shown was changed here (told after it was).
 * @param tools - what the page adds to the row of tools above the chapters.
 * @param note - something the page says above the chapters.
 * @param footer - what the page adds under the chapters.
 * @param compact - rows without a synopsis: how long a chapter is and where it stands, for a narrow list.
 * @param onGraph - the way to the plot graph, where the page has one of its own.
 */
export function ChapterTree({ active, onOpen, onLine, tools, note, footer, compact = false, onGraph }: { active: string | undefined; onOpen: (id: string) => void; onLine?: (line: string) => void; tools?: ReactNode; note?: ReactNode; footer?: ReactNode; compact?: boolean; onGraph?: (() => void) | undefined }) {
  const { controller, locale } = useStudio()
  const t = useT()
  const { project } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const apply = useOutlineOps()
  const { run } = useAction()
  const confirm = useConfirm()
  const [editingVolume, setEditingVolume] = useState<Volume | 'new' | undefined>()
  const others = project.outline.lines ?? []
  const main = project.outline.volumes.flatMap(volume => volume.chapters)
  // Every chapter the book has, on whichever line; a chapter is moved up and down among the chapters of its own.
  const everything = [...main, ...others.flatMap(line => line.chapters)]
  const info = new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter]))
  // One line of the plot at a time: the list is of the line in hand — the main one, or another as it is read (what it
  // shares with the line it parts from, then its own) — and not every line under the other.
  const [wantedLine, setLine] = useBookLine()
  const shownLine = others.find(line => line.id === wantedLine)
  const path = shownLine === undefined ? main.map(plan => plan.id) : project.lines?.find(candidate => candidate.id === shownLine.id)?.path ?? shownLine.chapters.map(plan => plan.id)
  const own = shownLine !== undefined ? shownLine.chapters : main
  const plans = own
  const pickLine = (id: string): void => {
    setLine(id)
    onLine?.(id)
  }
  const made = (results: { id?: string }[]): void => {
    const id = results[0]?.id
    if (id !== undefined) onOpen(id)
  }
  const addToLine = (line: PlotLine): Promise<unknown> => run(async () => { made(await apply([{ op: 'add-chapter', title: t('新章节', 'New chapter'), line: line.id }])) })
  const addChapter = (volume: Volume): Promise<unknown> => run(async () => { made(await apply([{ op: 'add-chapter', title: t('新章节', 'New chapter'), volume: volume.id }])) })
  /** A new chapter between two that are there: right after this one, on its line and in its volume. */
  const addAfter = (plan: ChapterPlan): Promise<unknown> => run(async () => { made(await apply([{ op: 'add-chapter', title: t('新章节', 'New chapter'), after: plan.id }])) })
  // Chapters to translate, while the author says into what: those ticked, or (none named) the line's.
  const [translating, setTranslating] = useState<string[] | undefined>()
  const written = path.filter(id => info.get(id)?.hasText === true).length
  /** Work is being done on a chapter right now: its row says so. */
  const busyOn = (id: string): boolean => jobs.some(job => job.status === 'running' && (job.target === id || job.result?.chapterId === id))

  // ── taking chapters out: one by its row, several by ticking them — and back again ──
  const [choosing, setChoosing] = useState(false)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  // The chapters being moved to another place in the plot, while the author says where.
  const [moving, setMoving] = useState<string[] | undefined>()
  const removed = project.removed ?? []
  const [showRemoved, setShowRemoved] = useState(false)
  const whereToFind = t('可以在这一页最下面恢复。', 'It can be restored at the bottom of this page.')
  const remove = (ids: string[]): void => {
    const gone = ids.map(id => ({ id, plan: everything.find(plan => plan.id === id), chapter: info.get(id) })).filter(item => item.plan !== undefined)
    if (gone.length === 0) return
    const words = gone.reduce((sum, item) => sum + (item.chapter?.words ?? 0), 0)
    const what = gone.length === 1
      ? t(`删除第 ${gone[0]!.chapter?.index ?? '?'} 章「${gone[0]!.plan!.title}」？`, `Delete chapter ${gone[0]!.chapter?.index ?? '?'}, "${gone[0]!.plan!.title}"?`)
      : t(`删除选中的 ${gone.length} 章？`, `Delete the ${gone.length} chosen chapters?`)
    confirm.ask(`${what}${words > 0 ? t(`（共 ${formatCount(words, locale)} 字正文）`, ` (${formatCount(words, locale)} words of text)`) : ''} ${whereToFind}`, () => {
      void run(async () => {
        await apply(gone.map(item => ({ op: 'remove-chapter', chapter: item.id })))
        setTicked(new Set())
        setChoosing(false)
        setShowRemoved(true)
        controller.toast('success', gone.length === 1 ? t(`已删除「${gone[0]!.plan!.title}」。${whereToFind}`, `Removed "${gone[0]!.plan!.title}". ${whereToFind}`) : t(`已删除 ${gone.length} 章。${whereToFind}`, `Removed ${gone.length} chapters. ${whereToFind}`))
      })
    })
  }
  const restore = (id: string): Promise<unknown> => run(async () => {
    const results = await apply([{ op: 'restore-chapter', chapter: id }])
    const back = results[0]?.id
    if (back !== undefined) onOpen(back)
    controller.toast('success', t('已恢复：章纲、正文和由它做出来的东西都回来了。', 'Put back: its plan, its text and what was made from it are all there again.'))
  })
  // ── a chapter dragged to another place on its line: between two others, or to the end of a volume ──
  const [dragged, setDragged] = useState<string[] | undefined>()
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | { end: string; line?: boolean } | undefined>()
  const holders = [...project.outline.volumes, ...others]
  const place = (): void => {
    const ids = dragged
    const to = drop
    setDragged(undefined)
    setDrop(undefined)
    if (ids === undefined || ids.length === 0 || to === undefined) return
    // Let go where it already is: nothing to do.
    const holder = holders.find(candidate => ('id' in to ? candidate.chapters.some(plan => plan.id === to.id) : candidate.id === to.end))
    if (holder !== undefined) {
      const now = holder.chapters.map(plan => plan.id)
      const rest = now.filter(id => !ids.includes(id))
      const at = 'id' in to ? rest.indexOf(to.id) + (to.side === 'after' ? 1 : 0) : rest.length
      const then = [...rest.slice(0, at), ...ids, ...rest.slice(at)]
      if (then.length === now.length && then.every((id, index) => id === now[index])) return
    }
    void run(async () => {
      await apply([{ op: 'move-chapters', chapters: ids, ...('id' in to ? { [to.side]: to.id } : to.line === true ? { line: to.end } : { volume: to.end }) }])
    })
  }
  /** What makes the end of a volume, or of a line, a place to let a dragged chapter go. */
  const endOf = (id: string, line = false): { onDragOver: (event: React.DragEvent) => void; onDragLeave: () => void; onDrop: (event: React.DragEvent) => void } => ({
    onDragOver: (event) => {
      if (dragged === undefined) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (drop === undefined || !('end' in drop) || drop.end !== id) setDrop({ end: id, ...(line ? { line: true } : {}) })
    },
    onDragLeave: () => { setDrop(previous => (previous !== undefined && 'end' in previous && previous.end === id ? undefined : previous)) },
    onDrop: (event) => { event.preventDefault(); place() },
  })
  const tick = (id: string): void => {
    setTicked((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const row = (plan: ChapterPlan, chapter: ChapterInfo | undefined, shared = false): JSX.Element => (
    <li
      key={plan.id}
      className={cx('nv-list-item', choosing && 'is-choosing', shared && 'is-shared', !shared && 'is-movable', dragged?.includes(plan.id) === true && 'is-dragged', drop !== undefined && 'id' in drop && drop.id === plan.id && `is-drop-${drop.side}`)}
      // A chapter of this line is taken by its row and let go between two others (the ticked ones go together). What
      // the line shares with the one it parts from is that line's to order.
      draggable={!shared}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', plan.title)
        setDragged(choosing && ticked.has(plan.id) ? plans.filter(candidate => ticked.has(candidate.id)).map(candidate => candidate.id) : [plan.id])
      }}
      onDragEnd={() => { setDragged(undefined); setDrop(undefined) }}
      onDragOver={(event) => {
        if (dragged === undefined || shared || dragged.includes(plan.id)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const box = event.currentTarget.getBoundingClientRect()
        const side = event.clientY < box.top + box.height / 2 ? 'before' : 'after'
        if (drop === undefined || !('id' in drop) || drop.id !== plan.id || drop.side !== side) setDrop({ id: plan.id, side })
      }}
      onDrop={(event) => { if (dragged === undefined || shared) return; event.preventDefault(); place() }}
    >
      {shared ? null : <span className="nv-list-grip" aria-hidden="true" title={t('拖动来排序', 'Drag to reorder')}><Icon name="grip" size={12} /></span>}
      {choosing ? <input type="checkbox" className="nv-list-tick" checked={ticked.has(plan.id)} onChange={() => { tick(plan.id) }} aria-label={t(`选中「${plan.title}」`, `Choose "${plan.title}"`)} /> : null}
      <button type="button" className={cx('nv-list-row', plan.id === active && 'is-active')} onClick={() => { if (choosing) tick(plan.id); else onOpen(plan.id) }} title={plan.title}>
        <span className="nv-list-index">{chapter?.index ?? ''}</span>
        {compact ? (
          // A narrow list, beside the text being written: how long the chapter is, and where it stands.
          <>
            <span className="nv-person-text">
              <span className="nv-list-title">{plan.title}</span>
              <span className="nv-list-meta">{chapter?.hasText === true ? `${formatCount(chapter.words, locale)}${t(' 字', ' words')}` : t(...CHAPTER_STATUS[plan.status])}{chapter?.hasText === true && !chapter.digested ? t(' · 未收录', ' · undigested') : ''}</span>
            </span>
            {busyOn(plan.id) ? <Spinner size={12} /> : <span className={cx('nv-dot', `is-${plan.status}`)} />}
          </>
        ) : (
          <>
            <span className="nv-person-text">
              <span className="nv-list-title">{plan.title}</span>
              <span className="nv-list-meta">{plan.synopsis ?? t('（尚无梗概）', '(no synopsis yet)')}</span>
            </span>
            <span className="nv-list-side">
              <Chip tone={CHAPTER_STATUS_TONE[plan.status]}>{t(...CHAPTER_STATUS[plan.status])}</Chip>
              {chapter !== undefined && chapter.words > 0 ? <span className="nv-list-meta">{formatCount(chapter.words, locale)}</span> : null}
            </span>
          </>
        )}
      </button>
      {choosing || shared ? null : <button type="button" className="nv-list-insert" onClick={() => { void addAfter(plan) }} title={t('在这一章后面插入一章', 'Insert a chapter after this one')} aria-label={t(`在「${plan.title}」后面插入一章`, `Insert a chapter after "${plan.title}"`)}><Icon name="plus" size={12} /></button>}
      {choosing ? null : <button type="button" className="nv-list-remove" onClick={() => { remove([plan.id]) }} title={t('删除这一章', 'Delete this chapter')} aria-label={t(`删除「${plan.title}」`, `Delete "${plan.title}"`)}><Icon name="trash" size={12} /></button>}
    </li>
  )


  return (
    <>
        <div className="nv-outline-tools">
          {choosing ? (
            <>
              <span className="nv-muted nv-small">{t(`已选 ${ticked.size} 章`, `${ticked.size} chosen`)}</span>
              <span className="nv-spacer" />
              <Button size="sm" variant="ghost" onClick={() => { setTicked(new Set(plans.map(plan => plan.id))) }}>{t('全选这条线', 'All of this line')}</Button>
              <Button size="sm" variant="outline" icon="branch" disabled={ticked.size === 0} onClick={() => { setMoving(plans.filter(plan => ticked.has(plan.id)).map(plan => plan.id)) }} title={t('移到另一条线，或另开成一条线', 'Onto another line, or a line of their own')}>{t('移到…', 'Move to…')}</Button>
              <Button size="sm" variant="outline" icon="globe" disabled={ticked.size === 0} onClick={() => { setTranslating(plans.filter(plan => ticked.has(plan.id)).map(plan => plan.id)) }} title={t('把选中的章节译成另一种语言', 'Translate the chosen chapters into another language')}>{t('翻译…', 'Translate…')}</Button>
              <Button size="sm" variant="danger" icon="trash" disabled={ticked.size === 0} onClick={() => { remove([...ticked]) }}>{t(`删除选中的 ${ticked.size} 章`, `Delete the ${ticked.size} chosen`)}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setChoosing(false); setTicked(new Set()) }}>{t('取消', 'Cancel')}</Button>
            </>
          ) : (
            <>
              {others.length > 0 ? (
                <Select value={shownLine?.id ?? MAIN_LINE} options={[
                  { value: MAIN_LINE, label: `★ ${t('主线', 'Main line')}${t(`（${main.length} 章）`, ` (${main.length})`)}` },
                  ...others.map(line => ({ value: line.id, label: `${line.shelved === true ? '⏸ ' : ''}${line.title}${t(`（${line.chapters.length} 章）`, ` (${line.chapters.length})`)}` })),
                ]} onChange={pickLine} />
              ) : <span className="nv-muted nv-small">{t(`${everything.length} 章`, `${everything.length} chapters`)}</span>}
              <span className="nv-spacer" />
              {tools}
              {written > 0 ? <Button size="sm" variant="ghost" icon="globe" onClick={() => { setTranslating([]) }} title={t('翻译：把这条线上有正文的章节译成另一种语言（原文留在每章的“版本”里）', 'Translate: the written chapters of this line into another language (the original stays among each chapter\'s versions)')}>{compact ? undefined : t('翻译', 'Translate')}</Button> : null}
              {own.length > 1 ? <Button size="sm" variant="ghost" icon="check" onClick={() => { setChoosing(true) }} title={t('勾选几章，一起移到别的线或删除', 'Tick several chapters to move or delete them together')}>{t('多选', 'Choose several')}</Button> : null}
            </>
          )}
        </div>
        {note}
        {shownLine !== undefined ? null : project.outline.volumes.map((volume, volumeIndex) => (
          <section key={volume.id} className="nv-volume">
            <header className="nv-volume-head">
              <div className="nv-volume-title">
                <strong>{volume.title}</strong>
                {volume.synopsis !== undefined ? <span className="nv-list-meta">{volume.synopsis}</span> : null}
              </div>
              <HistoryButton kind="volume" id={volume.id} name={volume.title} />
              <Menu
                icon="more"
                align="end"
                items={[
                  { label: t('编辑分卷', 'Edit volume'), icon: 'pen', onSelect: () => { setEditingVolume(volume) } },
                  { label: t('添加章节', 'Add chapter'), icon: 'plus', onSelect: () => { addChapter(volume) } },
                  { label: t('上移', 'Move up'), icon: 'arrowUp', disabled: volumeIndex === 0, onSelect: () => { void run(async () => { await apply([{ op: 'move-volume', volume: volume.id, before: project.outline.volumes[volumeIndex - 1]!.id }]) }) } },
                  { label: t('下移', 'Move down'), icon: 'arrowDown', disabled: volumeIndex === project.outline.volumes.length - 1, onSelect: () => {
                    const after = project.outline.volumes[volumeIndex + 2]
                    void run(async () => { await apply([{ op: 'move-volume', volume: volume.id, ...(after !== undefined ? { before: after.id } : {}) }]) })
                  } },
                  'separator',
                  { label: t('删除分卷', 'Delete volume'), icon: 'trash', danger: true, disabled: volume.chapters.length > 0 || project.outline.volumes.length === 1, onSelect: () => { confirm.ask(t(`删除分卷「${volume.title}」？`, `Delete the volume "${volume.title}"?`), () => { void run(async () => { await apply([{ op: 'remove-volume', volume: volume.id }]) }) }) } },
                ]}
              />
            </header>
            <ul className="nv-list">
              {volume.chapters.map(plan => row(plan, info.get(plan.id)))}
            </ul>
            <button type="button" className={cx('nv-add-row', drop !== undefined && 'end' in drop && drop.end === volume.id && 'is-drop')} onClick={() => { addChapter(volume) }} {...endOf(volume.id)}>+ {t('添加章节', 'Add chapter')}</button>
          </section>
        ))}
        {shownLine !== undefined ? null : <button type="button" className="nv-add-row" onClick={() => { setEditingVolume('new') }}>+ {t('添加分卷', 'Add volume')}</button>}
        {(shownLine !== undefined ? [shownLine] : []).map(line => (
          <section key={line.id} className={cx('nv-volume nv-line-section', line.shelved === true && 'is-shelved')}>
            <header className="nv-volume-head">
              <div className="nv-volume-title">
                <strong>{line.shelved === true ? '⏸ ' : ''}{line.title}</strong>
                <span className="nv-list-meta">{line.from !== undefined ? t(`从第 ${info.get(line.from)?.index ?? '?'} 章之后分出`, `leaves after chapter ${info.get(line.from)?.index ?? '?'}`) : t('从开头分出', 'from the start')}{line.choice !== undefined ? ` · ${line.choice}` : ''}</span>
              </div>
              <HistoryButton kind="line" id={line.id} name={line.title} />
              <Button size="sm" variant="ghost" icon="branch" onClick={onGraph ?? (() => { controller.setView('outline') })} title={t('在剧情图里看这条线，改名、汇入、设为主线都在那里', 'See this line on the graph; renaming, joining and making it the main line are there')} />
            </header>
            <ul className="nv-list">
              {/* As the line is read: what it shares with the line it parts from, greyed, then its own. */}
              {path.map(id => everything.find(plan => plan.id === id)).filter((plan): plan is ChapterPlan => plan !== undefined).map(plan => row(plan, project.lines?.find(candidate => candidate.id === line.id)?.chapters.find(chapter => chapter.id === plan.id) ?? info.get(plan.id), !line.chapters.some(mine => mine.id === plan.id)))}
            </ul>
            <button type="button" className={cx('nv-add-row', drop !== undefined && 'end' in drop && drop.end === line.id && 'is-drop')} onClick={() => { addToLine(line) }} {...endOf(line.id, true)}>+ {t('给这条线添加章节', 'Add a chapter to this line')}</button>
          </section>
        ))}
        {removed.length > 0 ? (
          <section className="nv-removed">
            <button type="button" className="nv-removed-head" aria-expanded={showRemoved} onClick={() => { setShowRemoved(value => !value) }}>
              <Icon name="trash" size={12} />
              <span>{t(`最近删除的章节 · ${removed.length}`, `Recently removed · ${removed.length}`)}</span>
              <Icon name={showRemoved ? 'chevronDown' : 'chevronRight'} size={12} />
            </button>
            {showRemoved ? (
              <ul className="nv-list">
                {removed.map(item => (
                  <li key={item.plan.id} className="nv-removed-row">
                    <span className="nv-person-text">
                      <span className="nv-list-title">{item.plan.title}</span>
                      <span className="nv-list-meta">{t(`原第 ${item.index} 章`, `was chapter ${item.index}`)}{item.words > 0 ? ` · ${formatCount(item.words, locale)}${t(' 字', ' words')}` : t(' · 没有正文', ' · no text')} · {new Date(item.removedAt).toLocaleString()}</span>
                    </span>
                    <Button size="sm" icon="undo" onClick={() => { void restore(item.plan.id) }} title={t('放回原来的位置', 'Put it back where it was')}>{t('恢复', 'Put back')}</Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        {footer}
      {editingVolume !== undefined ? <VolumeEditor volume={editingVolume === 'new' ? undefined : editingVolume} onClose={() => { setEditingVolume(undefined) }} /> : null}
      {translating !== undefined ? <TranslateDialog chapters={translating} line={shownLine?.id ?? MAIN_LINE} onClose={() => { setTranslating(undefined); setTicked(new Set()); setChoosing(false) }} /> : null}
      {moving !== undefined ? <MoveChapters chapters={moving} onClose={() => { setMoving(undefined) }} onMoved={() => { setTicked(new Set()); setChoosing(false) }} /> : null}
      {confirm.element}
    </>
  )
}

function VolumeEditor({ volume, onClose }: { volume: Volume | undefined; onClose: () => void }) {
  const t = useT()
  const apply = useOutlineOps()
  const { busy, run } = useAction()
  const [title, setTitle] = useState(volume?.title ?? '')
  const [synopsis, setSynopsis] = useState(volume?.synopsis ?? '')
  const [goal, setGoal] = useState(volume?.goal ?? '')
  const save = (): Promise<unknown> => run(async () => {
    await apply([volume === undefined
      ? { op: 'add-volume', title, synopsis, goal }
      : { op: 'update-volume', volume: volume.id, title, synopsis, goal }])
    onClose()
  })
  return (
    <Modal title={volume === undefined ? t('添加分卷', 'Add volume') : t('编辑分卷', 'Edit volume')} onClose={onClose} footer={<Button variant="primary" busy={busy} disabled={title.trim().length === 0} onClick={save}>{t('保存', 'Save')}</Button>}>
      <Field label={t('卷名', 'Title')}><TextInput autoFocus value={title} onChange={(event) => { setTitle(event.target.value) }} /></Field>
      <Field label={t('本卷梗概', 'Synopsis')}><TextArea value={synopsis} minRows={3} onChange={(event) => { setSynopsis(event.target.value) }} /></Field>
      <Field label={t('本卷要把故事带到哪里', 'Where this volume must leave the story')}><TextArea value={goal} minRows={2} onChange={(event) => { setGoal(event.target.value) }} /></Field>
    </Modal>
  )
}

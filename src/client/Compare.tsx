// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Things laid side by side to be compared: drafts of a chapter, versions of
 * it, pictures, plans, clips — whatever a column can hold.
 *
 * One control for it wherever the Studio compares. Which of the things are
 * shown is the author's to say — any number of them, or one alone; the
 * columns grow and shrink — more of them on a screen, or one read closely;
 * and a thing that can be let go of is let go of here.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Chip, cx, Modal, ProjectImage, recall, remember, Spinner, useConfirm, useT } from './ui'

/** One of the things compared: what it is called, how it went, and what it is. */
export interface CompareItem {
  key: string
  title: string
  sub?: string
  /** Prose, laid out as paragraphs. */
  text?: string
  /** A picture of the book, by its path. */
  picture?: string
  /** Anything else a column shows: a plan, a clip to listen to. */
  body?: ReactNode
  /** Not there yet: being made, or being read. */
  loading?: boolean
  error?: string
  /** What is done with it — taking it, putting it back: beside its name. */
  action?: ReactNode
  taken?: boolean
  /** It can be deleted for good; the author is asked first, in these words. */
  drop?: { ask: string; run: () => void }
  /** Opened large (a picture). */
  onOpen?: () => void
}

/** More there is to lay beside what is shown: picked from a list, added by whoever keeps the list. */
export interface CompareMore {
  label: string
  options: { key: string; label: string; group?: string }[]
  onAdd: (key: string) => void
}

const STEPS = [0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5] as const
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const FIGURE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

/** A path as a line of the text writes it, read back. */
const plain = (path: string): string => { try { return decodeURI(path) } catch { return path } }

/**
 * @param name - what kind of things these are (`drafts`, `pictures`, …): how large they were looked at last is kept on
 *   this device under it.
 * @param base - how wide a column is at 100%.
 */
export function Compare({ items, name, base = 340, more, className }: { items: readonly CompareItem[]; name: string; base?: number; more?: CompareMore | undefined; className?: string }) {
  const t = useT()
  const confirm = useConfirm()
  const [zoom, setZoomValue] = useState(() => clamp(Number(recall<number>(`compare:zoom:${name}`) ?? 1) || 1, 0.2, 3))
  /** @param keep - the size is one the author chose for things of this kind (not one worked out for the row there is now): the next row opens at it. */
  const setZoom = useCallback((next: number, keep = true): void => {
    const value = Math.round(clamp(next, 0.2, 3) * 100) / 100
    setZoomValue(value)
    if (keep) remember(`compare:zoom:${name}`, value === 1 ? undefined : value)
  }, [name])
  // Which are left out of the row: everything is laid out until the author says otherwise.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const shown = useMemo(() => items.filter(item => !off.has(item.key)), [items, off])
  const cols = useRef<HTMLDivElement>(null)
  const step = (by: 1 | -1): void => {
    const next = by > 0 ? STEPS.find(level => level > zoom + 0.001) : [...STEPS].reverse().find(level => level < zoom - 0.001)
    if (next !== undefined) setZoom(next)
  }
  // As many as are shown, on one screen: each as wide as the row has room for.
  const fit = (): void => {
    const row = cols.current
    if (row === null || shown.length === 0) return
    const gap = 12
    // (Rounded down: a column a pixel too wide is a row that scrolls.)
    setZoom(Math.floor((row.clientWidth - gap * (shown.length - 1)) / shown.length / base * 100) / 100, false)
  }
  // A pinch on a trackpad (or the wheel with Ctrl / ⌘ held) sizes the columns, not the page.
  const zoomNow = useRef(zoom)
  zoomNow.current = zoom
  useEffect(() => {
    const row = cols.current
    if (row === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom(zoomNow.current * (event.deltaY < 0 ? 1.08 : 1 / 1.08))
    }
    row.addEventListener('wheel', onWheel, { passive: false })
    return () => { row.removeEventListener('wheel', onWheel) }
  }, [setZoom, items.length === 0])
  // A thing that came while the row was scrolled away is not looked for: the row stays where the author left it.
  useLayoutEffect(() => { if (cols.current !== null && shown.length <= 1) cols.current.scrollLeft = 0 }, [shown.length])
  // Nothing laid out and nothing to lay out: there is nothing to say.
  if (items.length === 0 && (more === undefined || more.options.length === 0)) return null
  const toggle = (key: string): void => { setOff((previous) => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next }) }
  const only = (key: string): void => { setOff(new Set(items.filter(item => item.key !== key).map(item => item.key))) }
  const groups = more === undefined ? [] : [...new Set(more.options.map(option => option.group ?? ''))]
  // Two things of one name (two drafts by the same model) are told apart above by the first thing said under the name.
  const twice = new Set(items.map(item => item.title).filter((title, at, all) => all.indexOf(title) !== at))
  const chipOf = (item: CompareItem): string => (twice.has(item.title) && item.sub !== undefined && item.sub.length > 0 ? `${item.title} · ${item.sub.split(' · ')[0]}` : item.title)
  const style = { '--nv-compare-col': `${Math.round(base * zoom)}px`, '--nv-compare-font': `${(14 * clamp(zoom, 0.72, 1.5)).toFixed(1)}px` } as CSSProperties
  return (
    <div className={cx('nv-compare', shown.length === 1 && 'is-one', className)} style={style}>
      <div className="nv-compare-bar">
        <span className="nv-muted nv-small">{t('并排看', 'Side by side')}</span>
        <div className="nv-chips nv-compare-which">
          {items.map(item => (
            <Chip key={item.key} active={!off.has(item.key)} tone={!off.has(item.key) ? 'blue' : 'neutral'} title={!off.has(item.key) ? t('点一下从并排里拿掉（东西还在）', 'Press to take it out of the row (it is kept)') : t('点一下放回并排里', 'Press to put it back in the row')} onClick={() => { toggle(item.key) }}>{chipOf(item)}</Chip>
          ))}
        </div>
        {items.length > 1 && off.size > 0 ? <button type="button" className="nv-link nv-small" onClick={() => { setOff(new Set()) }}>{t(`全部（${items.length}）`, `All ${items.length}`)}</button> : null}
        {more !== undefined && more.options.length > 0 ? (
          <select className="nv-input nv-select nv-compare-more" value="" onChange={(event) => { if (event.target.value.length > 0) more.onAdd(event.target.value) }}>
            <option value="">{more.label}</option>
            {groups.map(group => (group.length > 0
              ? <optgroup key={group} label={group}>{more.options.filter(option => (option.group ?? '') === group).map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</optgroup>
              : more.options.filter(option => (option.group ?? '') === '').map(option => <option key={option.key} value={option.key}>{option.label}</option>)))}
          </select>
        ) : null}
        <span className="nv-spacer" />
        <span className="nv-compare-zoom" hidden={items.length === 0}>
          <Button size="sm" variant="ghost" title={t('缩小：一屏放下更多栏', 'Smaller: more columns on a screen')} aria-label={t('缩小', 'Smaller')} disabled={zoom <= STEPS[0] + 0.001} onClick={() => { step(-1) }}>−</Button>
          <button type="button" className="nv-compare-level" title={t('回到 100%', 'Back to 100%')} onClick={() => { setZoom(1) }}>{Math.round(zoom * 100)}%</button>
          <Button size="sm" variant="ghost" title={t('放大', 'Larger')} aria-label={t('放大', 'Larger')} disabled={zoom >= STEPS[STEPS.length - 1]! - 0.001} onClick={() => { step(1) }}>＋</Button>
          {shown.length > 1 ? <Button size="sm" variant="ghost" title={t('把并排着的这几栏正好放进一屏', 'Fit the columns shown on one screen')} onClick={fit}>{t('一屏放下', 'Fit')}</Button> : null}
        </span>
      </div>
      {shown.length === 0 && items.length > 0 ? <p className="nv-muted nv-small">{t('一栏都没有勾：在上面点一个。', 'Nothing is in the row: press one above.')}</p> : null}
      <div className="nv-compare-cols" ref={cols}>
        {shown.map(item => (
          <section key={item.key} className={cx('nv-compare-col', item.taken === true && 'is-taken', item.picture !== undefined && 'is-picture')}>
            <header>
              <div className="nv-compare-name"><strong>{item.title}</strong>{item.sub !== undefined && item.sub.length > 0 ? <span className="nv-muted nv-small">{item.sub}</span> : null}</div>
              <span className="nv-compare-tools">
                {item.action}
                {items.length > 1 && shown.length > 1 ? <Button size="sm" variant="ghost" icon="maximize" title={t('只看这一栏', 'This one alone')} aria-label={t('只看这一栏', 'This one alone')} onClick={() => { only(item.key) }} /> : null}
                {items.length > 1 ? <Button size="sm" variant="ghost" icon="x" title={t('从并排里拿掉（东西还在，上面点一下放回）', 'Out of the row (it is kept: press it above to put it back)')} aria-label={t('从并排里拿掉', 'Out of the row')} onClick={() => { toggle(item.key) }} /> : null}
                {item.drop !== undefined ? <Button size="sm" variant="ghost" icon="trash" title={t('删掉它', 'Delete it')} aria-label={t('删掉它', 'Delete it')} onClick={() => { const drop = item.drop!; confirm.ask(drop.ask, drop.run) }} /> : null}
              </span>
            </header>
            <div className="nv-compare-body">
              {item.error !== undefined ? <p className="nv-trial-failed">{item.error}</p> : item.loading === true ? <div className="nv-center"><Spinner /></div> : item.picture !== undefined ? (
                item.onOpen !== undefined
                  ? <button type="button" className="nv-compare-picture" title={t('点开看大图', 'Open it large')} onClick={item.onOpen}><ProjectImage path={item.picture} alt={item.title} /></button>
                  : <div className="nv-compare-picture"><ProjectImage path={item.picture} alt={item.title} /></div>
              ) : item.text !== undefined ? <Prose text={item.text} /> : item.body}
              {item.picture !== undefined && item.body !== undefined ? item.body : null}
            </div>
          </section>
        ))}
      </div>
      {confirm.element}
    </div>
  )
}

/** A chapter's text to be read: a paragraph a paragraph, a picture placed in it shown where it stands. */
function Prose({ text }: { text: string }) {
  const paragraphs = useMemo(() => text.split(/\n{2,}/).map(paragraph => paragraph.trim()).filter(paragraph => paragraph.length > 0), [text])
  return (
    <div className="nv-trial-prose nv-compare-prose">
      {paragraphs.map((paragraph, index) => {
        const figure = FIGURE.exec(paragraph)
        if (figure !== null && !/^[a-z]+:/i.test(figure[2]!)) return <figure key={index} className="nv-compare-figure"><ProjectImage path={plain(figure[2]!)} alt={figure[1] ?? ''} />{(figure[1] ?? '').length > 0 ? <figcaption className="nv-muted nv-small">{figure[1]}</figcaption> : null}</figure>
        return <p key={index}>{paragraph}</p>
      })}
    </div>
  )
}

/** Pictures of the book laid side by side: the ones picked, any number of them. */
export function PicturesCompare({ pictures, onOpen, onClose }: { pictures: readonly { key: string; path: string; title: string; sub?: string }[]; /** A picture pressed: opened large, with its record. */ onOpen?: (key: string) => void; onClose: () => void }) {
  const t = useT()
  return (
    <Modal wide roomy="compare" className="nv-modal-trial" title={t(`并排看 ${pictures.length} 张图`, `${pictures.length} pictures side by side`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('上面点名字，把哪张拿出或放回并排；右边缩放。点图看大图和它的来历。', 'Press a name above to take a picture out of the row or put it back; size them on the right. Press a picture to open it large, with its record.')}</span>
        <span className="nv-spacer" />
        <Button variant="ghost" onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    )}>
      <Compare name="pictures" base={260} items={pictures.map((picture): CompareItem => ({ key: picture.key, title: picture.title, ...(picture.sub !== undefined ? { sub: picture.sub } : {}), picture: picture.path, ...(onOpen !== undefined ? { onOpen: () => { onOpen(picture.key) } } : {}) }))} />
    </Modal>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The author's jottings.
 *
 * Loose notes kept with the book — a turn the plot might take, a setting not
 * settled, a line for some day: written here, or from the header of any page.
 * Whoever works on the book finds them when searching, unless the author
 * keeps one of them — or all — from being found.
 */
import { useEffect, useRef, useState } from 'react'
import { JOTTING_KINDS, type Jotting, type JottingKind, type JottingsView } from '../../shared/types'
import { Icon } from '../icons'
import { Button, Chip, cx, Modal, Select, TextArea, TextInput, useConfirm, useLoad, useProject, useSnapshot, useStudio, useT } from '../ui'

const KIND_WORD: Record<JottingKind, [string, string]> = {
  plot: ['剧情 / 大纲', 'Plot'],
  setting: ['设定', 'Setting'],
  other: ['其他', 'Other'],
}

/** When a note was last written, briefly. */
const when = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function Jottings() {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const confirm = useConfirm()
  const view = useLoad<JottingsView>(() => controller.api.call('jottings.list', { root }), [root, project.revision])
  const [text, setText] = useState('')
  const [kind, setKind] = useState<JottingKind>('plot')
  const [only, setOnly] = useState<JottingKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  // Come to from a search hit: that one is shown, and marked for a moment.
  const entity = useSnapshot(snapshot => snapshot.entity)
  const [marked, setMarked] = useState<string>()
  useEffect(() => {
    if (entity?.kind !== 'jotting' || entity.id.length === 0) return
    setOnly('all')
    setQuery('')
    setMarked(entity.id)
    const timer = setTimeout(() => { document.getElementById(`nv-jotting-${entity.id}`)?.scrollIntoView({ block: 'center' }) }, 80)
    return () => { clearTimeout(timer) }
  }, [entity?.kind, entity?.id, entity?.nonce])

  const run = (work: () => Promise<JottingsView | undefined>): Promise<unknown> => {
    setBusy(true)
    return controller.guard(async () => {
      const next = await work()
      if (next !== undefined) view.set(next)
      else view.reload()
    }).finally(() => { setBusy(false) })
  }
  const jot = (): void => {
    const written = text.trim()
    if (written.length === 0) return
    void run(async () => {
      await controller.api.call('jottings.save', { root, text: written, kind })
      setText('')
      return undefined
    })
  }
  const data = view.data
  const items = data?.items ?? []
  const wanted = query.trim().toLowerCase()
  const shown = items.filter(item => (only === 'all' || item.kind === only) && (wanted.length === 0 || `${item.title ?? ''}\n${item.text}`.toLowerCase().includes(wanted)))
  const search = data?.search !== false
  const kept = items.filter(item => item.hidden === true).length
  return (
    <div className="nv-jottings">
      <div className="nv-references-head">
        <div>
          <h2>{t('随笔', 'Jottings')}</h2>
          <p className="nv-muted">{t('没想好的剧情、没定下来的设定、随手的一句话。各角色检索时找得到它们，并且知道这只是想法，不是设定。', 'A turn not thought through, a setting not settled, a line in passing. Whoever works on the book finds them when searching — as ideas, not canon.')}</p>
        </div>
        {data !== undefined ? (
          <label className="nv-check" title={t('不勾：哪一条都不会被任何角色、总编检索或读到', 'Unticked: none of them is searched or read by any role, or by the showrunner')}>
            <input type="checkbox" checked={search} disabled={busy} onChange={(event) => { const on = event.target.checked; void run(async () => await controller.api.call('jottings.search', { root, on })) }} />
            <span>{t('让各角色检索到随笔', 'Let the agents find them')}</span>
          </label>
        ) : null}
      </div>

      <div className="nv-jot-new">
        <TextArea
          value={text}
          minRows={2}
          maxRows={12}
          placeholder={t('记一笔：也许让程砚秋晚一章出场；断肠斋的后院应该有一口井……（Ctrl / ⌘ + 回车记下）', 'Jot it down: maybe he comes in a chapter later; there should be a well behind the shop… (Ctrl / ⌘ + Enter keeps it)')}
          onChange={(event) => { setText(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); jot() } }}
        />
        <div className="nv-jot-new-row">
          <Select<JottingKind> value={kind} options={JOTTING_KINDS.map(value => ({ value, label: t(...KIND_WORD[value]) }))} onChange={setKind} />
          <Button variant="primary" icon="plus" busy={busy} disabled={text.trim().length === 0} onClick={jot}>{t('记下', 'Keep it')}</Button>
        </div>
      </div>

      {items.length > 0 ? (
        <div className="nv-jot-filter">
          <Chip active={only === 'all'} tone={only === 'all' ? 'blue' : 'neutral'} onClick={() => { setOnly('all') }}>{t(`全部 ${items.length}`, `All ${items.length}`)}</Chip>
          {JOTTING_KINDS.filter(value => items.some(item => item.kind === value)).map(value => (
            <Chip key={value} active={only === value} tone={only === value ? 'blue' : 'neutral'} onClick={() => { setOnly(value) }}>{t(...KIND_WORD[value])} {items.filter(item => item.kind === value).length}</Chip>
          ))}
          <TextInput className="nv-jot-find" value={query} placeholder={t('在随笔里找…', 'Find in the jottings…')} onChange={(event) => { setQuery(event.target.value) }} />
          <span className="nv-muted nv-small">
            {!search ? t('现在都不让检索', 'None is found by the agents now') : kept > 0 ? t(`${kept} 条不让检索`, `${kept} kept from the agents`) : ''}
          </span>
        </div>
      ) : null}

      {view.loading && data === undefined ? <p className="nv-muted">{t('读取中…', 'Loading…')}</p> : null}
      {view.error !== undefined ? <p className="nv-muted">{view.error}</p> : null}
      {data !== undefined && items.length === 0 ? <p className="nv-empty">{t('还没有随笔。', 'No jottings yet.')}</p> : null}
      {items.length > 0 && shown.length === 0 ? <p className="nv-muted">{t('没有符合的。', 'Nothing matches.')}</p> : null}

      <div className="nv-jot-list">
        {shown.map(item => (
          <JottingCard
            key={item.id}
            item={item}
            search={search}
            busy={busy}
            marked={marked === item.id}
            onSave={change => run(async () => { await controller.api.call('jottings.save', { root, id: item.id, ...change }); return undefined })}
            onRemove={() => {
              confirm.ask(t('删掉这条随笔？删掉的在本页最下面还能放回。', 'Take this jotting away? It can be put back from the bottom of this page.'), () => { void run(async () => await controller.api.call('jottings.remove', { root, id: item.id })) })
            }}
          />
        ))}
      </div>

      {data !== undefined && data.removed.length > 0 ? (
        <details className="nv-jot-removed">
          <summary>{t(`最近删除的随笔 · ${data.removed.length}`, `Taken away lately · ${data.removed.length}`)}</summary>
          <ul>
            {data.removed.map(item => (
              <li key={item.id}>
                <span className="nv-jot-removed-text">{item.title !== undefined ? `${item.title} — ` : ''}{item.text.replace(/\s+/g, ' ').slice(0, 120)}</span>
                <span className="nv-muted nv-small">{when(item.removedAt)}</span>
                <Button size="sm" variant="ghost" icon="undo" disabled={busy} onClick={() => { void run(async () => await controller.api.call('jottings.restore', { root, id: item.id })) }}>{t('放回', 'Put back')}</Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {confirm.element}
    </div>
  )
}

/** One jotting: its words, what it is about, whether the agents find it. Changed where it stands; kept when the box is left. */
function JottingCard({ item, search, busy, marked, onSave, onRemove }: {
  item: Jotting
  /** Whether jottings are found by the agents at all. */
  search: boolean
  busy: boolean
  marked: boolean
  onSave: (change: { title?: string; text?: string; kind?: JottingKind; hidden?: boolean }) => Promise<unknown>
  onRemove: () => void
}) {
  const t = useT()
  const [text, setText] = useState(item.text)
  const [title, setTitle] = useState(item.title ?? '')
  const held = useRef({ text: item.text, title: item.title ?? '' })
  // Changed from outside (the showrunner, another page): shown as it is now.
  if (held.current.text !== item.text || held.current.title !== (item.title ?? '')) {
    held.current = { text: item.text, title: item.title ?? '' }
    setText(item.text)
    setTitle(item.title ?? '')
  }
  const found = search && item.hidden !== true
  return (
    <section id={`nv-jotting-${item.id}`} className={cx('nv-jot', !found && 'is-kept', marked && 'is-marked')}>
      <header>
        <TextInput
          className="nv-jot-title"
          value={title}
          placeholder={t('标题（可不填）', 'A title (optional)')}
          onChange={(event) => { setTitle(event.target.value) }}
          onBlur={() => { if (title.trim() !== (item.title ?? '')) void onSave({ title: title.trim() }) }}
        />
        <Select<JottingKind> value={item.kind} options={JOTTING_KINDS.map(value => ({ value, label: t(...KIND_WORD[value]) }))} onChange={(value) => { void onSave({ kind: value }) }} />
        <span className="nv-muted nv-small">{when(item.updatedAt)}</span>
        <span className="nv-jot-tools">
          <Button
            size="sm"
            variant="ghost"
            icon={item.hidden === true ? 'eyeOff' : 'eye'}
            disabled={busy}
            className={cx(item.hidden !== true && search && 'is-active')}
            onClick={() => { void onSave({ hidden: item.hidden !== true }) }}
            title={item.hidden === true
              ? t('这一条不让检索：各角色和总编都找不到、读不到它。点一下让它能被检索', 'Kept from the agents: no role, and not the showrunner, finds or reads it. Click to let it be found')
              : search
                ? t('各角色检索时找得到这一条。点一下不让检索', 'The agents find this one when searching. Click to keep it from them')
                : t('这一条本身可以检索，但上面关掉了全部随笔的检索', 'This one may be found, but finding jottings is switched off above')}
          >
            {item.hidden === true ? t('不检索', 'Kept back') : t('可检索', 'Found')}
          </Button>
          <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={onRemove} title={t('删掉这条随笔', 'Take this jotting away')} />
        </span>
      </header>
      <TextArea
        value={text}
        minRows={2}
        maxRows={24}
        onChange={(event) => { setText(event.target.value) }}
        onBlur={() => {
          if (text.trim() === item.text) return
          // (Emptied: the words go back — taking a jotting away is the bin's to do.)
          if (text.trim().length === 0) { setText(item.text); return }
          void onSave({ text: text.trim() })
        }}
      />
    </section>
  )
}

/**
 * The header's way to jot something down from whatever page the author is on: a few words, what they are about, kept.
 * The page of jottings is one press further.
 */
export function JotButton() {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<JottingKind>('plot')
  const [busy, setBusy] = useState(false)
  const keep = (): void => {
    const written = text.trim()
    if (written.length === 0 || busy) return
    setBusy(true)
    void controller.guard(async () => {
      await controller.api.call('jottings.save', { root, text: written, kind })
      setText('')
      setOpen(false)
      controller.toast('success', t('记下了，在“设定 → 随笔”里。', 'Kept, under Bible → Jottings.'))
    }).finally(() => { setBusy(false) })
  }
  return (
    <>
      <Button variant="ghost" size="sm" icon="quote" onClick={() => { setOpen(true) }} title={(project.jottings ?? 0) > 0 ? t(`记一笔随笔（已有 ${project.jottings} 条）`, `Jot something down (${project.jottings} kept)`) : t('记一笔随笔：没想好的剧情、设定', 'Jot something down: a turn of the plot, a setting not settled')} />
      {open ? (
        <Modal
          title={t('记一笔', 'Jot it down')}
          onClose={() => { setOpen(false) }}
          footer={(
            <>
              <Button variant="ghost" icon="arrowRight" onClick={() => { setOpen(false); controller.openJottings() }}>{t('看全部随笔', 'All jottings')}</Button>
              <span className="nv-grow" />
              <Button variant="ghost" onClick={() => { setOpen(false) }}>{t('取消', 'Cancel')}</Button>
              <Button variant="primary" icon="plus" busy={busy} disabled={text.trim().length === 0} onClick={keep}>{t('记下', 'Keep it')}</Button>
            </>
          )}
        >
          <div className="nv-jot-quick">
            <TextArea
              autoFocus
              value={text}
              minRows={4}
              maxRows={16}
              placeholder={t('没想好的剧情、没定下来的设定……（Ctrl / ⌘ + 回车记下）', 'A turn not thought through, a setting not settled… (Ctrl / ⌘ + Enter keeps it)')}
              onChange={(event) => { setText(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); keep() } }}
            />
            <Select<JottingKind> value={kind} options={JOTTING_KINDS.map(value => ({ value, label: t(...KIND_WORD[value]) }))} onChange={setKind} />
          </div>
        </Modal>
      ) : null}
    </>
  )
}

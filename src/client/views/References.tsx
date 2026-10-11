// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The books this book goes by.
 *
 * A list of references — books of the shelf, and manuscripts taken in for
 * this book alone — each with what the author says of how to go by it. A
 * book of the shelf is consulted as it is organised there, as far as the
 * author opens it; a manuscript as plain text. Nothing here is put into a
 * task: whoever works on the book reads in them with tools.
 */
import { useRef, useState } from 'react'
import { REFERENCE_ASPECTS, type ReferenceAspect, type ReferenceInfo, type ReferenceShelf } from '../../shared/types'
import { Icon } from '../icons'
import { Button, Chip, cx, Field, Modal, TextArea, TextInput, useConfirm, useLoad, useProject, useSnapshot, useStudio, useT } from '../ui'
import { readBase64 } from './Home'

const ASPECT_WORD: Record<ReferenceAspect, [string, string]> = {
  world: ['世界观与设定', 'World'],
  characters: ['人物', 'People'],
  style: ['文风', 'Style'],
  plot: ['剧情', 'Plot'],
  text: ['正文', 'Text'],
}

const BOOK_TYPES = '.txt,.md,.markdown,.epub,.docx,.html,.htm,text/plain,application/epub+zip'
const PACKED = /\.(epub|docx)$/i

/** A text file as novels are usually encoded: UTF-8 first, then GB18030. */
async function readText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

export function References() {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const confirm = useConfirm()
  const shelf = useLoad<ReferenceShelf>(() => controller.api.call('references.list', { root }), [root, project.revision])
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const run = (work: () => Promise<ReferenceShelf>): Promise<unknown> => {
    setBusy(true)
    return controller.guard(async () => { shelf.set(await work()) }).finally(() => { setBusy(false) })
  }
  const takeFile = (file: File | undefined): void => {
    if (file === undefined) return
    void run(async () => {
      const taken = PACKED.test(file.name)
        ? await controller.api.call('references.add', { root, file: { name: file.name, data: await readBase64(file) } })
        : await controller.api.call('references.add', { root, text: await readText(file), title: file.name.replace(/\.[^.]+$/, '') })
      controller.toast('success', t('收进参考文献了：按纯文字参考。在下面写一句怎么参考。', 'Taken in as a reference, as plain text. Say below how to go by it.'))
      return taken
    }).finally(() => { if (fileInput.current !== null) fileInput.current.value = '' })
  }
  const references = shelf.data?.references ?? []
  return (
    <div className="nv-references">
      <div className="nv-references-head">
        <div>
          <h2>{t('参考文献', 'References')}</h2>
          <p className="nv-muted">{t('这本书照着哪些书写：世界观、设定、文风、剧情、文字。策划、导演这些角色会自己去里面查，不是整本塞给模型。', 'The books this one goes by: for their world, settings, style, plot, wording. The crew reads in them with tools of its own; none is handed to a model whole.')}</p>
        </div>
        <div className="nv-references-add">
          <Button size="sm" variant="primary" icon="book" disabled={busy} onClick={() => { setPicking(true) }}>{t('从书架选…', 'From the shelf…')}</Button>
          <Button size="sm" icon="upload" busy={busy} pending={t('正在收进来…', 'Taking it in…')} onClick={() => { fileInput.current?.click() }}>{t('导入一份书稿…', 'A manuscript…')}</Button>
          <input ref={fileInput} type="file" accept={BOOK_TYPES} hidden onChange={(event) => { takeFile(event.target.files?.[0]) }} />
        </div>
      </div>
      <p className="nv-references-hint nv-small">
        <Icon name="info" size={13} />
        <span>
          {t('导入的书稿只按文字参考：能读、能搜，没有人物卡和大纲。想先整理（人物、世界观、文风、剧情）再参考，把它导入成书架上的一本书，再“从书架选”：', 'A manuscript taken in here is consulted as plain text: read and searched, with no cards and no outline. To have it organised first — people, world, style, plot — import it as a book of the shelf, then take it from the shelf: ')}
          <button type="button" className="nv-link" onClick={() => { controller.kept.set('onboard.page', 'new'); controller.closeProject() }}>{t('去“新创作”导入', 'import it under New work')}</button>
        </span>
      </p>
      {shelf.data !== undefined && references.length > 0 ? (
        <label className="nv-check">
          <input type="checkbox" checked={shelf.data.beforeWriting} disabled={busy} onChange={(event) => { void run(async () => await controller.api.call('references.settings', { root, beforeWriting: event.target.checked })) }} />
          <span>{t('写每一章之前，让策划先为这一章查参考文献（摘记留在章纲里，可以改）', 'Before a chapter is written, the planner reads the references for it (its notes are kept on the chapter\'s plan, to be changed)')}</span>
        </label>
      ) : null}
      {shelf.loading && shelf.data === undefined ? <p className="nv-muted">{t('读取中…', 'Loading…')}</p> : null}
      {shelf.error !== undefined ? <p className="nv-muted">{shelf.error}</p> : null}
      {shelf.data !== undefined && references.length === 0 ? <p className="nv-empty">{t('还没有参考文献。', 'No references yet.')}</p> : null}
      <div className="nv-reference-list">
        {references.map(reference => (
          <ReferenceCard
            key={reference.id}
            reference={reference}
            busy={busy}
            onUpdate={change => run(async () => await controller.api.call('references.update', { root, id: reference.id, ...change }))}
            onRemove={() => {
              confirm.ask(reference.kind === 'text'
                ? t(`把《${reference.name}》从参考文献里去掉？导入的这份书稿也会删掉。`, `Take "${reference.name}" off the references? The manuscript taken in goes with it.`)
                : t(`把《${reference.name}》从参考文献里去掉？书架上那本书不受影响。`, `Take "${reference.name}" off the references? The book on the shelf is not touched.`), () => { void run(async () => await controller.api.call('references.remove', { root, id: reference.id })) })
            }}
          />
        ))}
      </div>
      {picking ? <ShelfPicker taken={references} onPick={book => { setPicking(false); void run(async () => await controller.api.call('references.add', { root, book })) }} onClose={() => { setPicking(false) }} /> : null}
      {confirm.element}
    </div>
  )
}

/** One reference: what it is, what of it is open, and how the author wants it used. */
function ReferenceCard({ reference, busy, onUpdate, onRemove }: { reference: ReferenceInfo; busy: boolean; onUpdate: (change: { note?: string; scope?: ReferenceAspect[] | null; off?: boolean }) => Promise<unknown>; onRemove: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const [note, setNote] = useState(reference.note ?? '')
  const [held, setHeld] = useState(reference.note ?? '')
  // Changed from outside (the showrunner, another page): shown as it is now.
  if (held !== (reference.note ?? '')) {
    setHeld(reference.note ?? '')
    setNote(reference.note ?? '')
  }
  const open = (aspect: ReferenceAspect): boolean => reference.scope === undefined || reference.scope.includes(aspect)
  const toggle = (aspect: ReferenceAspect): void => {
    const now = REFERENCE_ASPECTS.filter(item => (item === aspect ? !open(item) : open(item)))
    // Nothing open is a reference not consulted: said with the switch for that, not with an empty scope.
    if (now.length === 0) return
    void onUpdate({ scope: now.length === REFERENCE_ASPECTS.length ? null : now })
  }
  const has = reference.has
  return (
    <section className={cx('nv-reference', reference.off === true && 'is-off')}>
      <header>
        <Icon name={reference.kind === 'book' ? 'book' : 'feather'} size={16} />
        <strong>{reference.name}</strong>
        {reference.author !== undefined ? <span className="nv-muted nv-small">{reference.author}</span> : null}
        <Chip tone={reference.kind === 'book' ? 'blue' : 'neutral'}>{reference.kind === 'book' ? t('书架上的书', 'A book of the shelf') : t('导入的书稿 · 纯文字', 'A manuscript · plain text')}</Chip>
        {reference.state === 'locked' ? <Chip tone="amber" title={t('这本书上着锁：解锁之后才读得到', 'This book is locked: it is read once it is unlocked')}>{t('上着锁', 'Locked')}</Chip> : null}
        {reference.state === 'missing' ? <Chip tone="red">{t('找不到了', 'Not found')}</Chip> : null}
        {reference.off === true ? <Chip>{t('暂不参考', 'Not consulted')}</Chip> : null}
        <span className="nv-reference-tools">
          {reference.kind === 'book' && reference.state === 'ready' && reference.root !== undefined ? <Button size="sm" variant="ghost" icon="arrowRight" onClick={() => controller.guard(async () => { await controller.openProject(reference.root!) })} title={t('打开这本书', 'Open this book')}>{t('打开', 'Open')}</Button> : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void onUpdate({ off: reference.off !== true }) }}>{reference.off === true ? t('恢复参考', 'Consult it again') : t('暂不参考', 'Set it aside')}</Button>
          <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={onRemove} title={t('从参考文献里去掉', 'Take it off the references')} />
        </span>
      </header>
      <p className="nv-muted nv-small">
        {reference.kind === 'book'
          ? has !== undefined
            ? t(`${has.chapters} 章 · ${has.words} 字 · ${has.characters} 张人物卡 · ${has.world} 条设定 · ${has.styles} 份文风`, `${has.chapters} chapters · ${has.words} words · ${has.characters} character cards · ${has.world} world entries · ${has.styles} style profile(s)`)
            : t('现在读不到它。', 'It cannot be read right now.')
          : t(`${reference.chars ?? 0} 字 · 读成 ${reference.parts ?? 1} 段`, `${reference.chars ?? 0} characters · read in ${reference.parts ?? 1} part(s)`)}
      </p>
      {reference.kind === 'book' ? (
        <div className="nv-reference-scope">
          <span className="nv-muted nv-small">{t('可以查', 'Open')}</span>
          {REFERENCE_ASPECTS.map(aspect => <Chip key={aspect} tone={open(aspect) ? 'blue' : 'neutral'} active={open(aspect)} onClick={() => { toggle(aspect) }}>{t(...ASPECT_WORD[aspect])}</Chip>)}
        </div>
      ) : null}
      <Field label={t('怎么参考', 'How to go by it')}>
        <TextArea
          value={note}
          minRows={2}
          maxRows={8}
          placeholder={reference.kind === 'book'
            ? t('用自己的话说：只学它的文风和回目的写法；人物和情节不要搬。／ 和它是同一个世界：地名、官制、物价照它的。', 'In your own words: learn its style and its chapter headings only; none of its people or events. / The same world as this one: place names, offices, prices as it has them.')
            : t('用自己的话说：对白的口吻学它；称谓、物件的叫法照它的。', 'In your own words: speech as it has it; forms of address and the names of things as it uses them.')}
          onChange={(event) => { setNote(event.target.value) }}
          onBlur={() => { if (note.trim() !== (reference.note ?? '')) void onUpdate({ note: note.trim() }) }}
        />
      </Field>
    </section>
  )
}

/** The books of the shelf, to take one as a reference: every book but this one and those taken already. */
function ShelfPicker({ taken, onPick, onClose }: { taken: readonly ReferenceInfo[]; onPick: (root: string) => void; onClose: () => void }) {
  const t = useT()
  const { root } = useProject()
  const workspaces = useSnapshot(snapshot => snapshot.workspaces)
  const [query, setQuery] = useState('')
  const had = new Set(taken.filter(item => item.kind === 'book').map(item => item.root))
  const books = workspaces.flatMap(workspace => workspace.projects.map(book => ({ ...book, workspace: workspace.title }))).filter((book, at, all) => book.root !== root && all.findIndex(other => other.root === book.root) === at)
  const shown = books.filter(book => query.trim().length === 0 || book.title.includes(query.trim()))
  return (
    <Modal title={t('从书架选一本作参考', 'A book of the shelf, as a reference')} onClose={onClose}>
      {books.length > 6 ? <TextInput autoFocus value={query} placeholder={t('找书名', 'Find by title')} onChange={(event) => { setQuery(event.target.value) }} /> : null}
      {books.length === 0 ? <p className="nv-empty">{t('书架上还没有别的书。', 'There is no other book on the shelf.')}</p> : null}
      <ul className="nv-reference-pick">
        {shown.map(book => (
          <li key={book.root}>
            <button type="button" disabled={had.has(book.root) || book.locked === true} onClick={() => { onPick(book.root) }}>
              <Icon name={book.locked === true ? 'lock' : 'book'} size={15} />
              <span>{book.title}</span>
              <small className="nv-muted">{had.has(book.root) ? t('已经是参考', 'A reference already') : book.locked === true ? t('上着锁：先解锁', 'Locked: unlock it first') : book.workspace}</small>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

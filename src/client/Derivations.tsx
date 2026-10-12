// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The records of a book's derivations.
 *
 * Every derivation — chapters planned, a chapter's beats laid out, a beat added or changed by a sentence, a what-if,
 * the idea a book began with — leaves a record with the book: what the author gave it to go by, what the planner
 * handed in and said of it, each time. Here they are read, long after the outline they made was edited; and from here
 * the author says which of them go along when their chapters are planned and written, adds to one, or writes one
 * themself for chapters that have none.
 */
import { useState } from 'react'
import { MAIN_LINE, type DerivationKind, type DerivationsView, type DerivationTurn, type DerivationView } from '../shared/types'
import { Icon } from './icons'
import { picturesReadWord, referencesLookedWord } from './Guides'
import { linePath } from '../shared/lines'
import { Button, Chip, cx, Modal, Select, TextArea, useBookLine, useConfirm, useLoad, useProject, useStudio, useT } from './ui'

type T = (zh: string, en: string) => string

const KIND_WORD: Record<DerivationKind, [string, string]> = {
  chapters: ['推演章节', 'Chapters'],
  beats: ['推演节拍', 'Beats'],
  beat: ['加 / 改节拍', 'A beat'],
  whatif: ['假设推演', 'What-if'],
  foundation: ['新书起头', 'Foundation'],
  note: ['自己记的', 'My note'],
}

/** The kinds that are the thinking behind a stretch of chapters. */
const OF_A_STRETCH: readonly DerivationKind[] = ['chapters', 'foundation', 'note']

const when = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "第 6–10 章", "第 6、7、9 章", "第 7 章". */
function span(indexes: readonly number[], t: T): string {
  const sorted = [...indexes].sort((left, right) => left - right)
  if (sorted.length === 0) return ''
  if (sorted.length === 1) return t(`第 ${sorted[0]} 章`, `chapter ${sorted[0]}`)
  const run = sorted.every((index, at) => at === 0 || index === sorted[at - 1]! + 1)
  return run ? t(`第 ${sorted[0]}–${sorted.at(-1)} 章`, `chapters ${sorted[0]}–${sorted.at(-1)}`) : t(`第 ${sorted.join('、')} 章`, `chapters ${sorted.join(', ')}`)
}

/** A record that stands and goes along with its chapters. */
const carried = (record: DerivationView): boolean => record.carry !== false && record.state !== 'waiting' && record.state !== 'discarded'
/** A record that could go along: of chapters that are in the outline. */
const carriable = (record: DerivationView): boolean => record.kind !== 'whatif' && record.state !== 'waiting' && record.state !== 'discarded' && record.covers.length > 0

/** The book's records, read again whenever one changes. */
export function useDerivations() {
  const { controller } = useStudio()
  const { root, project } = useProject()
  return useLoad<DerivationsView>(signal => controller.api.call('derivations.list', { root }, signal), [root, project.derivations?.count, project.derivations?.at])
}

/** The button that opens the records, with how many there are. */
export function DerivationsButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const t = useT()
  const { project } = useProject()
  const [open, setOpen] = useState(false)
  const count = project.derivations?.count ?? 0
  return (
    <>
      <Button size={size} variant="outline" icon="history" onClick={() => { setOpen(true) }} title={t('每次推演的方向、策划的说明、交回的章节', 'What each derivation was given to go by, what the planner said, what it handed in')}>
        {count > 0 ? t(`推演记录 · ${count}`, `Derivations · ${count}`) : t('推演记录', 'Derivations')}
      </Button>
      {open ? <DerivationsDialog onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

/**
 * On a chapter's plan, and where it is written: which thinking goes along when its beats are laid out and it is
 * written — the stretch it was derived in — or that it has none, with the way to write some down.
 */
export function ChapterIntent({ chapter }: { chapter: string }) {
  const t = useT()
  const view = useDerivations()
  const [open, setOpen] = useState(false)
  const mine = (view.data?.items ?? []).filter(record => record.chapters.includes(chapter) && record.kind !== 'whatif')
  const along = mine.filter(record => carried(record) && (OF_A_STRETCH.includes(record.kind) || record.direction !== undefined || record.note !== undefined))
  const stretch = along.find(record => OF_A_STRETCH.includes(record.kind))
  if (view.data === undefined) return null
  const said = stretch !== undefined
    ? t(`写作时带上推演思路${stretch.covers.length > 1 ? `：管${span(stretch.covers.map(cover => cover.index), t)}` : ''}`, `Written with the thinking it was derived with${stretch.covers.length > 1 ? `: ${span(stretch.covers.map(cover => cover.index), t)}` : ''}`)
    : along.length > 0
      ? t('写作时带上排节拍时给的方向', 'Written with the direction its beats were laid out by')
      : mine.some(record => record.carry === false)
        ? t(`${mine.filter(record => record.carry === false).length} 条推演记录设成了不带：写作只照章纲`, `${mine.filter(record => record.carry === false).length} derivation record(s) kept back: written by its outline alone`)
        : mine.length > 0
          ? t(`${mine.length} 条推演记录，都没有给过方向：写作只照章纲`, `${mine.length} derivation record(s), none with a direction: written by its outline alone`)
          : t('没有推演记录：写作只照章纲', 'No derivation record: written by its outline alone')
  return (
    <p className="nv-muted nv-small nv-chapter-intent" title={stretch !== undefined ? t(`${when(stretch.at)} 的那次推演：你给的方向、策划的说明`, `The derivation of ${when(stretch.at)}: the direction you gave, what the planner said`) : undefined}>
      <Icon name="history" size={13} />
      <span>{said}</span>
      <button type="button" className="nv-link" onClick={() => { setOpen(true) }}>{mine.length > 0 ? t('看', 'Read') : t('补记…', 'Write it down…')}</button>
      {open ? <DerivationsDialog chapter={chapter} onClose={() => { setOpen(false) }} /> : null}
    </p>
  )
}

function DerivationsDialog({ onClose, chapter }: { onClose: () => void; /** Opened from a chapter: its records are shown first. */ chapter?: string }) {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const confirm = useConfirm()
  const view = useDerivations()
  const [line] = useBookLine()
  const [kind, setKind] = useState<DerivationKind | 'all'>('all')
  const [only, setOnly] = useState(chapter !== undefined)
  const [noting, setNoting] = useState(false)
  const [busy, setBusy] = useState(false)
  const items = view.data?.items ?? []
  const ofChapter = chapter !== undefined ? items.filter(record => record.chapters.includes(chapter)) : items
  const pool = only ? ofChapter : items
  const shown = pool.filter(record => kind === 'all' || record.kind === kind)
  const kinds = (Object.keys(KIND_WORD) as DerivationKind[]).filter(candidate => pool.some(record => record.kind === candidate))
  const nameOf = (ref: string): string => project.characters.find(card => card.id === ref)?.name ?? ref
  const here = chapter !== undefined ? [...project.chapters, ...(project.lines ?? []).flatMap(candidate => candidate.chapters)].find(info => info.id === chapter) : undefined

  const run = (work: () => Promise<DerivationsView>): void => {
    setBusy(true)
    void controller.guard(async () => { view.set(await work()) }).finally(() => { setBusy(false) })
  }

  return (
    <Modal wide title={t('推演记录', 'Derivation records')} onClose={onClose} className="nv-derivations">
      {confirm.element}
      <p className="nv-muted nv-small">{t('每次推演留一条：你给的方向、策划的说明、交回的内容。排这些章的节拍、写它们时会带上，并写明管哪几章。', 'One a derivation: the direction you gave, what the planner said, what it handed in. They go along when those chapters\' beats are laid out and when they are written — with which chapters each covers.')}</p>
      <div className="nv-derivations-bar">
        {chapter !== undefined ? (
          <>
            <Chip active={only} onClick={() => { setOnly(true); setKind('all') }}>{t(`第 ${here?.index ?? '?'} 章的 · ${ofChapter.length}`, `Chapter ${here?.index ?? '?'} · ${ofChapter.length}`)}</Chip>
            <Chip active={!only} onClick={() => { setOnly(false); setKind('all') }}>{t(`全书 · ${items.length}`, `The book · ${items.length}`)}</Chip>
            <span className="nv-derivations-gap" />
          </>
        ) : null}
        {kinds.length > 1 ? (
          <>
            <Chip active={kind === 'all'} onClick={() => { setKind('all') }}>{t(`全部 · ${pool.length}`, `All · ${pool.length}`)}</Chip>
            {kinds.map(candidate => <Chip key={candidate} active={kind === candidate} onClick={() => { setKind(candidate) }}>{t(...KIND_WORD[candidate])} · {pool.filter(record => record.kind === candidate).length}</Chip>)}
          </>
        ) : null}
        <Button size="sm" variant="outline" icon={noting ? 'x' : 'plus'} className="nv-derivations-add" onClick={() => { setNoting(!noting) }} title={t('给没有记录的章节写下当初的思路：之后排节拍、写作同样带上', 'Write down what chapters with no record were meant to be: it goes along like any other')}>{t('补记一条', 'Write one down')}</Button>
      </div>
      {noting ? (
        <NoteForm line={here?.line ?? line} first={chapter} busy={busy} onSave={(chapters, text, of) => {
          run(async () => {
            const next = await controller.api.call('derivations.note', { root, chapters, text, ...(of !== MAIN_LINE ? { line: of } : {}) })
            setNoting(false)
            return next
          })
        }} />
      ) : null}
      {view.error !== undefined && view.data === undefined ? <p className="nv-note is-warn">{view.error}</p> : null}
      {view.data !== undefined && shown.length === 0 ? (
        <p className="nv-muted">{items.length === 0
          ? t('还没有记录。从这一版起，每次推演都会留一条；以前排的章节没有——可以“补记一条”。', 'None yet. From this release on every derivation leaves one; chapters planned before have none — write one down for them.')
          : t('这里没有。', 'None here.')}</p>
      ) : null}
      <div className="nv-derivations-list">
        {shown.map(record => (
          <RecordCard
            key={record.id}
            record={record}
            current={chapter}
            nameOf={nameOf}
            busy={busy}
            onOpen={(id) => { controller.focusChapter(id); controller.setView('outline', id); onClose() }}
            onUpdate={(patch) => { run(async () => await controller.api.call('derivations.update', { root, id: record.id, ...patch })) }}
            onRemove={() => { confirm.ask(t('删掉这条记录？之后写它的章节就不带这段思路了。可以在下面“最近删除的记录”里放回。', 'Take this record away? Its chapters are then written without this thinking. It can be put back below.'), () => { run(async () => await controller.api.call('derivations.remove', { root, id: record.id })) }) }}
          />
        ))}
      </div>
      {(view.data?.removed ?? []).length > 0 ? (
        <details className="nv-jot-removed">
          <summary>{t(`最近删除的记录 · ${view.data!.removed.length}`, `Taken away lately · ${view.data!.removed.length}`)}</summary>
          <ul>
            {view.data!.removed.map(record => (
              <li key={record.id}>
                <span className="nv-muted nv-small">{t(...KIND_WORD[record.kind])} · {when(record.at)}</span>
                <span className="nv-derivations-gone">{record.direction ?? t('（没有给方向）', '(no direction)')}</span>
                <Button size="sm" variant="ghost" icon="undo" disabled={busy} onClick={() => { run(async () => await controller.api.call('derivations.restore', { root, id: record.id })) }}>{t('放回', 'Put back')}</Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Modal>
  )
}

/** What the author writes down themself: which chapters, and what they were meant to be. */
function NoteForm({ line, first, busy, onSave }: { line: string; first?: string | undefined; busy: boolean; onSave: (chapters: string[], text: string, line: string) => void }) {
  const t = useT()
  const { project } = useProject()
  const path = linePath(project, line)
  const [from, setFrom] = useState(first !== undefined && path.some(info => info.id === first) ? first : path[0]?.id ?? '')
  const [to, setTo] = useState(first !== undefined && path.some(info => info.id === first) ? first : path.at(-1)?.id ?? '')
  const [text, setText] = useState('')
  const start = path.findIndex(info => info.id === from)
  const end = path.findIndex(info => info.id === to)
  const chosen = start >= 0 && end >= 0 ? path.slice(Math.min(start, end), Math.max(start, end) + 1).map(info => info.id) : []
  const options = path.map(info => ({ value: info.id, label: `${info.index}. ${info.title}` }))
  if (path.length === 0) return <p className="nv-muted">{t('这条线还没有章节。', 'This line has no chapters yet.')}</p>
  return (
    <div className="nv-derivation nv-derivations-note">
      <div className="nv-derivations-range">
        <span>{t('从', 'From')}</span>
        <Select value={from} options={options} onChange={setFrom} />
        <span>{t('到', 'to')}</span>
        <Select value={to} options={options} onChange={setTo} />
        <span className="nv-muted nv-small">{t(`共 ${chosen.length} 章`, `${chosen.length} chapter(s)`)}</span>
      </div>
      <TextArea value={text} minRows={3} placeholder={t('这几章当初想写成什么样：往哪走、什么基调（欢乐？阴暗？）、谁的戏', 'What these chapters were meant to be: where they go, in which key (glad? dark?), whose they are')} onChange={(event) => { setText(event.target.value) }} />
      <div className="nv-form-actions">
        <Button variant="primary" icon="check" busy={busy} disabled={text.trim().length === 0 || chosen.length === 0} onClick={() => { onSave(chosen, text.trim(), line) }}>{t('记下', 'Keep it')}</Button>
      </div>
    </div>
  )
}

function RecordCard({ record, current, nameOf, busy, onOpen, onUpdate, onRemove }: {
  record: DerivationView
  current?: string | undefined
  nameOf: (ref: string) => string
  busy: boolean
  onOpen: (chapter: string) => void
  onUpdate: (patch: { note?: string; carry?: boolean; text?: string }) => void
  onRemove: () => void
}) {
  const t = useT()
  const own = record.kind === 'note'
  const [note, setNote] = useState(record.note ?? '')
  const [text, setText] = useState(record.direction ?? '')
  const feedback = record.turns.map(turn => turn.feedback?.trim() ?? '').filter(word => word.length > 0)
  const rationale = [...record.turns].reverse().find(turn => (turn.rationale ?? '').trim().length > 0)?.rationale
  const handedIn = record.turns.filter(turn => (turn.chapters ?? []).length > 0 || (turn.beats ?? []).length > 0 || (turn.branches ?? []).length > 0)
  const asked: [string, string] = own ? ['写的是', 'It says'] : record.kind === 'whatif' ? ['假设', 'The question'] : record.kind === 'beat' ? ['那句话', 'The sentence'] : record.kind === 'foundation' ? ['起头的想法', 'The idea'] : ['方向', 'Direction']
  const pictures = picturesReadWord(record.pictures, t)
  const looked = referencesLookedWord(record.referenced, t)
  return (
    <article className={cx('nv-derivation', record.carry === false && 'is-kept', record.state === 'discarded' && 'is-gone')}>
      <header>
        <Chip tone={record.kind === 'note' ? 'violet' : record.kind === 'whatif' ? 'amber' : 'blue'}>{t(...KIND_WORD[record.kind])}{record.mode === 'replace' ? t(' · 替换后续', ' · replacing') : record.mode === 'branch' ? t(' · 另开一条线', ' · a new line') : record.mode === 'add' ? t(' · 加一个', ' · added') : record.mode === 'change' ? t(' · 改', ' · changed') : ''}</Chip>
        <span className="nv-muted nv-small">{when(record.at)}{record.by === 'showrunner' ? t(' · 总编经手', ' · by the showrunner') : ''}</span>
        {record.covers.length > 0 ? (
          <span className="nv-derivation-covers">
            {record.covers.map(cover => (
              <button key={cover.id} type="button" className={cx('nv-link', cover.id === current && 'is-here')} title={`${cover.title}${cover.written ? t('（已写）', ' (written)') : t('（还没写）', ' (not written)')}`} onClick={() => { onOpen(cover.id) }}>{cover.index}</button>
            ))}
            <span className="nv-muted nv-small">{t(`${span(record.covers.map(cover => cover.index), t)}，${record.covers.filter(cover => cover.written).length} 章已写`, `${span(record.covers.map(cover => cover.index), t)}, ${record.covers.filter(cover => cover.written).length} written`)}</span>
          </span>
        ) : record.state === 'waiting' ? <Chip tone="amber">{t('待看，还没进大纲', 'Waiting, not in the outline')}</Chip>
          : record.state === 'discarded' ? <Chip>{t('放弃了', 'Let go')}</Chip>
            : record.kind === 'whatif' ? null : <Chip>{t('它的章节已不在大纲里', 'Its chapters are no longer in the outline')}</Chip>}
        {record.lost > 0 && record.covers.length > 0 ? <span className="nv-muted nv-small">{t(`另有 ${record.lost} 章已不在大纲里`, `${record.lost} more no longer in the outline`)}</span> : null}
        <span className="nv-derivation-tools">
          <Button size="sm" variant="ghost" icon="trash" disabled={busy} title={t('删掉这条记录（可放回）', 'Take this record away (it can be put back)')} onClick={onRemove} />
        </span>
      </header>
      <div className="nv-derivation-part">
        <h5>{t(...asked)}</h5>
        {own
          ? <TextArea value={text} minRows={2} onChange={(event) => { setText(event.target.value) }} onBlur={() => { if (text.trim().length > 0 && text.trim() !== (record.direction ?? '')) onUpdate({ text: text.trim() }) }} />
          : record.direction !== undefined ? <p className="nv-derivation-said">{record.direction}</p> : <p className="nv-muted">{t('（没有给方向）', '(none given)')}</p>}
      </div>
      {feedback.length > 0 ? (
        <div className="nv-derivation-part">
          <h5>{t('看过之后要改的', 'Then asked to change')}</h5>
          <ol className="nv-derived-beats">{feedback.map((word, at) => <li key={at}>{word}</li>)}</ol>
        </div>
      ) : null}
      {rationale !== undefined ? (
        <div className="nv-derivation-part">
          <h5>{t('策划的说明', 'What the planner said')}</h5>
          <p className="nv-note nv-derivation-said">{rationale}</p>
        </div>
      ) : null}
      {handedIn.length > 0 ? (
        <details className="nv-derivation-turns">
          <summary>{t(`交回的内容（当时的样子）${handedIn.length > 1 ? ` · ${handedIn.length} 版` : ''}`, `What was handed in, as it was then${handedIn.length > 1 ? ` · ${handedIn.length} versions` : ''}`)}</summary>
          {handedIn.map((turn, at) => <TurnBody key={at} turn={turn} label={handedIn.length > 1 ? t(`第 ${at + 1} 版 · ${when(turn.at)}`, `Version ${at + 1} · ${when(turn.at)}`) : undefined} nameOf={nameOf} />)}
        </details>
      ) : null}
      {pictures !== undefined || looked !== undefined ? <p className="nv-muted nv-small">{[pictures, looked].filter(Boolean).join(' ')}</p> : null}
      {carriable(record) ? (
        <footer>
          <label className="nv-check" title={t('不勾：排这些章的节拍、写它们时不带这条', 'Unticked: it does not go along when these chapters are planned or written')}>
            <input type="checkbox" checked={record.carry !== false} disabled={busy} onChange={(event) => { onUpdate({ carry: event.target.checked }) }} />
            <span>{t('排节拍、写作时带上', 'Goes along when planned and written')}</span>
          </label>
          <TextArea value={note} minRows={1} placeholder={t('补充（可不填）：一并交给策划和写手', 'Add to it (optional): handed along with it')} onChange={(event) => { setNote(event.target.value) }} onBlur={() => { if (note.trim() !== (record.note ?? '')) onUpdate({ note: note.trim() }) }} />
        </footer>
      ) : null}
    </article>
  )
}

function TurnBody({ turn, label, nameOf }: { turn: DerivationTurn; label?: string | undefined; nameOf: (ref: string) => string }) {
  const t = useT()
  return (
    <div className="nv-derivation-turn">
      {label !== undefined ? <p className="nv-muted nv-small">{label}{turn.feedback !== undefined ? t(` · 照这句改的：${turn.feedback}`, ` · adjusted by: ${turn.feedback}`) : ''}</p> : null}
      {label !== undefined && turn.rationale !== undefined ? <p className="nv-muted nv-small">{turn.rationale}</p> : null}
      {(turn.chapters ?? []).map((chapter, at) => (
        <div key={at} className="nv-derived-item">
          <header>
            <strong>{at + 1}. {chapter.title}</strong>
            <span className="nv-muted nv-small">{[chapter.pov !== undefined ? nameOf(chapter.pov) : undefined, chapter.location, chapter.time].filter(Boolean).join(' · ')}</span>
          </header>
          {chapter.synopsis !== undefined ? <p>{chapter.synopsis}</p> : null}
          {chapter.purpose !== undefined ? <p className="nv-muted nv-small">{t('作用：', 'Purpose: ')}{chapter.purpose}</p> : null}
          {chapter.beats.length > 0 ? <ol className="nv-derived-beats">{chapter.beats.map(beat => <li key={beat.id}>{beat.summary}</li>)}</ol> : null}
        </div>
      ))}
      {(turn.beats ?? []).length > 0 ? <ol className="nv-derived-beats">{turn.beats!.map(beat => <li key={beat.id}>{beat.summary}{beat.outcome !== undefined ? <span className="nv-muted"> → {beat.outcome}</span> : null}</li>)}</ol> : null}
      {(turn.branches ?? []).map((branch, at) => (
        <div key={at} className="nv-branch">
          <h5>{branch.title}</h5>
          <p>{branch.development}</p>
          {branch.consequences.length > 0 ? <ul>{branch.consequences.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
          {branch.risks !== undefined ? <p className="nv-muted nv-small">{t('风险：', 'Risk: ')}{branch.risks}</p> : null}
          {branch.payoff !== undefined ? <p className="nv-muted nv-small">{t('收获：', 'Payoff: ')}{branch.payoff}</p> : null}
        </div>
      ))}
      {turn.recommendation !== undefined ? <p className="nv-note">{turn.recommendation}</p> : null}
    </div>
  )
}

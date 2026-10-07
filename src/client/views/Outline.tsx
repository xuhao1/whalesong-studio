// SPDX-License-Identifier: LGPL-3.0-or-later
/** Outline: volumes, chapters and beats; long-running threads; AI derivation and what-if branches. */
import { useEffect, useState } from 'react'
import type { OutlineOpInput } from '../../shared/rpc'
import { formatCount } from '../../shared/text'
import type { Beat, ChapterPlan, ChapterStatus, PlotThread, ThreadKind, ThreadStatus, Volume } from '../../shared/types'
import { CHAPTER_STATUS, CHAPTER_STATUS_TONE, THREAD_KIND, THREAD_STATUS, THREAD_STATUS_TONE } from '../labels'
import {
  Button, Chip, cx, Empty, Field, Menu, Modal, SectionTitle, Select, Tabs, TextArea, TextInput, useAction, useConfirm, useProject, useSnapshot,
  useStudio, useT, type Translate,
} from '../ui'

/** Apply outline operations; the first failing one becomes the error. */
function useOutlineOps(): (ops: OutlineOpInput[]) => Promise<{ op: string; ok: boolean; id?: string; message: string }[]> {
  const { controller } = useStudio()
  const { root } = useProject()
  return async (ops) => {
    const { results } = await controller.api.call('outline.apply', { root, ops })
    const failed = results.find(result => !result.ok)
    if (failed !== undefined) throw new Error(failed.message)
    return results
  }
}

const labelOptions = <T extends string>(labels: Record<T, [string, string]>, t: Translate): { value: T; label: string }[] =>
  (Object.keys(labels) as T[]).map(value => ({ value, label: t(labels[value][0], labels[value][1]) }))

export function OutlineView() {
  const t = useT()
  const { project } = useProject()
  const [tab, setTab] = useState<'chapters' | 'threads' | 'derive'>('chapters')
  const open = project.outline.threads.filter(thread => thread.status === 'open').length
  return (
    <div className="nv-page nv-outline">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'chapters', label: t('章节', 'Chapters'), icon: 'tree', badge: project.chapters.length },
          { value: 'threads', label: t('线索与伏笔', 'Threads'), icon: 'thread', badge: open },
          { value: 'derive', label: t('推演', 'Derive'), icon: 'sparkles' },
        ]}
      />
      {tab === 'chapters' ? <Chapters /> : tab === 'threads' ? <Threads /> : <Derive onApplied={() => { setTab('chapters') }} />}
    </div>
  )
}

// ───────────────────────────── chapters ─────────────────────────────

function Chapters() {
  const { controller, locale } = useStudio()
  const t = useT()
  const { project } = useProject()
  const focused = useSnapshot(snapshot => snapshot.chapterId)
  const apply = useOutlineOps()
  const { run } = useAction()
  const confirm = useConfirm()
  const [editingVolume, setEditingVolume] = useState<Volume | 'new' | undefined>()
  const plans = project.outline.volumes.flatMap(volume => volume.chapters)
  const selected = plans.find(plan => plan.id === focused) ?? plans[0]
  const info = new Map(project.chapters.map(chapter => [chapter.id, chapter]))

  const addChapter = (volume: Volume): Promise<unknown> => run(async () => {
    const results = await apply([{ op: 'add-chapter', title: t('新章节', 'New chapter'), volume: volume.id }])
    const id = results[0]?.id
    if (id !== undefined) controller.focusChapter(id)
  })

  return (
    <div className="nv-split">
      <aside className="nv-split-list nv-outline-tree">
        {project.outline.volumes.map((volume, volumeIndex) => (
          <section key={volume.id} className="nv-volume">
            <header className="nv-volume-head">
              <div className="nv-volume-title">
                <strong>{volume.title}</strong>
                {volume.synopsis !== undefined ? <span className="nv-list-meta">{volume.synopsis}</span> : null}
              </div>
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
              {volume.chapters.map((plan) => {
                const chapter = info.get(plan.id)
                return (
                  <li key={plan.id}>
                    <button type="button" className={cx('nv-list-row', plan.id === selected?.id && 'is-active')} onClick={() => { controller.focusChapter(plan.id) }}>
                      <span className="nv-list-index">{chapter?.index ?? ''}</span>
                      <span className="nv-person-text">
                        <span className="nv-list-title">{plan.title}</span>
                        <span className="nv-list-meta">{plan.synopsis ?? t('（尚无梗概）', '(no synopsis yet)')}</span>
                      </span>
                      <span className="nv-list-side">
                        <Chip tone={CHAPTER_STATUS_TONE[plan.status]}>{t(...CHAPTER_STATUS[plan.status])}</Chip>
                        {chapter !== undefined && chapter.words > 0 ? <span className="nv-list-meta">{formatCount(chapter.words, locale)}</span> : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            <button type="button" className="nv-add-row" onClick={() => { addChapter(volume) }}>+ {t('添加章节', 'Add chapter')}</button>
          </section>
        ))}
        <button type="button" className="nv-add-row" onClick={() => { setEditingVolume('new') }}>+ {t('添加分卷', 'Add volume')}</button>
      </aside>
      <section className="nv-split-detail">
        {selected !== undefined
          ? <ChapterPlanEditor key={selected.id} plan={selected} index={info.get(selected.id)?.index ?? 0} plans={plans} />
          : <Empty icon="tree" title={t('还没有章节', 'No chapters yet')}>{t('在左侧添加章节，或到"推演"里让架构模型排出开篇。', 'Add a chapter on the left, or let the architect model outline the opening under Derive.')}</Empty>}
      </section>
      {editingVolume !== undefined ? <VolumeEditor volume={editingVolume === 'new' ? undefined : editingVolume} onClose={() => { setEditingVolume(undefined) }} /> : null}
      {confirm.element}
    </div>
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

function ChapterPlanEditor({ plan, index, plans }: { plan: ChapterPlan; index: number; plans: ChapterPlan[] }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const apply = useOutlineOps()
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<ChapterPlan>(plan)
  const [dirty, setDirty] = useState(false)
  const [direction, setDirection] = useState('')
  const [deriving, setDeriving] = useState(false)
  useEffect(() => { if (!dirty) setDraft(plan) }, [plan, dirty])
  const set = <K extends keyof ChapterPlan>(key: K, value: ChapterPlan[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const toggle = (key: 'characters' | 'threads', id: string): void => {
    const current = draft[key] ?? []
    set(key, current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }
  const beats = draft.beats ?? []
  const setBeat = (at: number, patch: Partial<Beat>): void => { set('beats', beats.map((beat, position) => position === at ? { ...beat, ...patch } : beat)) }
  const position = plans.findIndex(candidate => candidate.id === plan.id)
  const chapter = project.chapters.find(candidate => candidate.id === plan.id)

  const save = (): Promise<unknown> => run(async () => {
    await apply([{
      op: 'update-chapter',
      chapter: plan.id,
      title: draft.title,
      synopsis: draft.synopsis ?? '',
      purpose: draft.purpose ?? '',
      pov: draft.pov ?? '',
      location: draft.location ?? '',
      time: draft.time ?? '',
      notes: draft.notes ?? '',
      characters: draft.characters ?? [],
      threads: draft.threads ?? [],
      beats: beats.filter(beat => beat.summary.trim().length > 0),
      status: draft.status,
      ...(draft.targetWords !== undefined ? { targetWords: draft.targetWords } : {}),
    }])
    setDirty(false)
  })
  const move = (side: 'before' | 'after'): void => {
    const anchor = plans[side === 'before' ? position - 1 : position + 1]
    if (anchor === undefined) return
    void run(async () => { await apply([{ op: 'move-chapter', chapter: plan.id, [side]: anchor.id }]) })
  }
  const deriveBeats = (): void => {
    setDeriving(true)
    void controller.guard(async () => {
      await controller.run('ai.deriveBeats', { root, chapter: plan.id, ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) })
      setDirection('')
    }).finally(() => { setDeriving(false) })
  }

  return (
    <div className="nv-editor-form">
      <header className="nv-detail-head">
        <h2><span className="nv-muted">{t(`第 ${index} 章`, `Chapter ${index}`)}</span> {draft.title}</h2>
        <div className="nv-row">
          <Menu
            icon="more"
            align="end"
            items={[
              { label: t('上移', 'Move up'), icon: 'arrowUp', disabled: position <= 0, onSelect: () => { move('before') } },
              { label: t('下移', 'Move down'), icon: 'arrowDown', disabled: position >= plans.length - 1, onSelect: () => { move('after') } },
              ...(project.outline.volumes.length > 1 ? project.outline.volumes.filter(volume => !volume.chapters.some(candidate => candidate.id === plan.id)).map(volume => ({
                label: t(`移到「${volume.title}」`, `Move to "${volume.title}"`), icon: 'folder' as const, onSelect: () => { void run(async () => { await apply([{ op: 'move-chapter', chapter: plan.id, volume: volume.id }]) }) },
              })) : []),
              'separator',
              { label: t('删除章节', 'Delete chapter'), icon: 'trash', danger: true, onSelect: () => { confirm.ask(t(`删除第 ${index} 章「${plan.title}」？正文会先存一份历史版本。`, `Delete chapter ${index}, "${plan.title}"? Its text is snapshotted first.`), () => { void run(async () => { await apply([{ op: 'remove-chapter', chapter: plan.id }]) }) }) } },
            ]}
          />
          <Button icon={chapter?.hasText === true ? 'pen' : 'feather'} onClick={() => { controller.setView('write', plan.id) }}>{chapter?.hasText === true ? t('打开正文', 'Open text') : t('去写这一章', 'Write it')}</Button>
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
        </div>
      </header>

      <div className="nv-form-grid">
        <Field label={t('标题', 'Title')}><TextInput value={draft.title} onChange={(event) => { set('title', event.target.value) }} /></Field>
        <Field label={t('状态', 'Status')}><Select<ChapterStatus> value={draft.status} options={labelOptions(CHAPTER_STATUS, t)} onChange={(value) => { set('status', value) }} /></Field>
      </div>
      <Field label={t('梗概', 'Synopsis')} hint={t('这一章发生了什么', 'What happens in this chapter')}><TextArea value={draft.synopsis ?? ''} minRows={3} onChange={(event) => { set('synopsis', event.target.value) }} /></Field>
      <Field label={t('这一章的作用', 'Purpose')} hint={t('推进了什么、兑现了什么、埋下了什么', 'What it moves, pays off or sets up')}><TextArea value={draft.purpose ?? ''} onChange={(event) => { set('purpose', event.target.value) }} /></Field>
      <div className="nv-form-grid">
        <Field label={t('视角人物', 'Point of view')}>
          <Select value={draft.pov ?? ''} options={[{ value: '', label: t('（按文风默认）', '(style default)') }, ...project.characters.map(card => ({ value: card.id, label: card.name }))]} onChange={(value) => { set('pov', value) }} />
        </Field>
        <Field label={t('地点', 'Location')}><TextInput value={draft.location ?? ''} onChange={(event) => { set('location', event.target.value) }} /></Field>
        <Field label={t('故事时间', 'Story time')}><TextInput value={draft.time ?? ''} onChange={(event) => { set('time', event.target.value) }} /></Field>
        <Field label={t('目标字数', 'Target length')}><TextInput inputMode="numeric" value={draft.targetWords !== undefined ? String(draft.targetWords) : ''} placeholder={String(project.manifest.chapterWords ?? '')} onChange={(event) => {
          const value = Number(event.target.value)
          setDraft(({ targetWords: _old, ...rest }) => (Number.isFinite(value) && value > 0 ? { ...rest, targetWords: Math.round(value) } : rest))
          setDirty(true)
        }} /></Field>
      </div>

      <SectionTitle>{t('出场人物', 'Cast of this chapter')}</SectionTitle>
      <div className="nv-chips">
        {project.characters.filter(card => card.status !== 'dead' || (draft.characters ?? []).includes(card.id)).map(card => (
          <Chip key={card.id} tone={(draft.characters ?? []).includes(card.id) ? 'blue' : 'neutral'} active={(draft.characters ?? []).includes(card.id)} onClick={() => { toggle('characters', card.id) }}>{card.name}</Chip>
        ))}
        {project.characters.length === 0 ? <span className="nv-muted nv-small">{t('设定里还没有人物。', 'No characters in the bible yet.')}</span> : null}
      </div>

      <SectionTitle>{t('牵动的线索', 'Threads it touches')}</SectionTitle>
      <div className="nv-chips">
        {project.outline.threads.filter(thread => thread.status === 'open' || (draft.threads ?? []).includes(thread.id)).map(thread => (
          <Chip key={thread.id} tone={(draft.threads ?? []).includes(thread.id) ? 'amber' : 'neutral'} active={(draft.threads ?? []).includes(thread.id)} onClick={() => { toggle('threads', thread.id) }}>{thread.title}</Chip>
        ))}
        {project.outline.threads.length === 0 ? <span className="nv-muted nv-small">{t('还没有线索；在"线索与伏笔"里添加，或写完后由收录自动发现。', 'No threads yet — add them under Threads, or let digest find them after writing.')}</span> : null}
      </div>

      <SectionTitle actions={<Button size="sm" icon="plus" variant="ghost" onClick={() => { set('beats', [...beats, { id: `new-${Date.now()}`, summary: '' }]) }}>{t('添加节拍', 'Add beat')}</Button>}>{t('节拍（场景）', 'Beats')}</SectionTitle>
      <div className="nv-assist">
        <TextInput value={direction} placeholder={t('让架构模型排出这一章的节拍（可写方向）', 'Let the architect lay out the beats (optional direction)')} onChange={(event) => { setDirection(event.target.value) }} />
        <Button icon="sparkles" busy={deriving} disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={deriveBeats}>{t('推演节拍', 'Derive beats')}</Button>
      </div>
      <ol className="nv-beats">
        {beats.map((beat, at) => (
          <li key={beat.id} className="nv-beat">
            <span className="nv-beat-no">{at + 1}</span>
            <div className="nv-beat-body">
              <TextArea value={beat.summary} minRows={1} placeholder={t('这一场发生什么', 'What happens in this beat')} onChange={(event) => { setBeat(at, { summary: event.target.value }) }} />
              <div className="nv-beat-extra">
                <TextInput value={beat.conflict ?? ''} placeholder={t('阻碍', 'Conflict')} onChange={(event) => { setBeat(at, { conflict: event.target.value }) }} />
                <TextInput value={beat.outcome ?? ''} placeholder={t('转折 / 结果', 'Turn / outcome')} onChange={(event) => { setBeat(at, { outcome: event.target.value }) }} />
                <TextInput value={beat.emotion ?? ''} placeholder={t('情绪', 'Emotion')} onChange={(event) => { setBeat(at, { emotion: event.target.value }) }} />
              </div>
            </div>
            <div className="nv-beat-tools">
              <Button size="sm" variant="ghost" icon="arrowUp" disabled={at === 0} onClick={() => { const next = [...beats]; [next[at - 1], next[at]] = [next[at]!, next[at - 1]!]; set('beats', next) }} />
              <Button size="sm" variant="ghost" icon="arrowDown" disabled={at === beats.length - 1} onClick={() => { const next = [...beats]; [next[at + 1], next[at]] = [next[at]!, next[at + 1]!]; set('beats', next) }} />
              <Button size="sm" variant="ghost" icon="x" onClick={() => { set('beats', beats.filter((_beat, other) => other !== at)) }} />
            </div>
          </li>
        ))}
      </ol>
      {beats.length === 0 ? <p className="nv-muted nv-small">{t('没有节拍时，写手只按梗概发挥；有节拍时会逐场落实。', 'Without beats the writer improvises from the synopsis; with beats it follows them scene by scene.')}</p> : null}

      <SectionTitle>{t('给写手的备注', 'Notes for the writer')}</SectionTitle>
      <TextArea value={draft.notes ?? ''} minRows={2} onChange={(event) => { set('notes', event.target.value) }} />
      {confirm.element}
    </div>
  )
}

// ───────────────────────────── threads ─────────────────────────────

function Threads() {
  const t = useT()
  const { project } = useProject()
  const apply = useOutlineOps()
  const { run } = useAction()
  const confirm = useConfirm()
  const [filter, setFilter] = useState<ThreadStatus | 'all'>('open')
  const [editing, setEditing] = useState<PlotThread | 'new' | undefined>()
  const indexOf = new Map(project.chapters.map(chapter => [chapter.id, chapter.index]))
  const latest = project.chapters.filter(chapter => chapter.hasText).at(-1)?.index ?? 0
  const threads = project.outline.threads.filter(thread => filter === 'all' || thread.status === filter)
  const where = (ids: string[] | undefined): string => (ids ?? []).map(id => indexOf.get(id)).filter((value): value is number => value !== undefined).sort((left, right) => left - right).join('、')
  return (
    <div className="nv-threads">
      <div className="nv-toolbar">
        <Tabs value={filter} onChange={setFilter} tabs={[
          { value: 'open', label: t('未回收', 'Open'), badge: project.outline.threads.filter(thread => thread.status === 'open').length },
          { value: 'paid', label: t('已回收', 'Paid off') },
          { value: 'dropped', label: t('已放弃', 'Dropped') },
          { value: 'all', label: t('全部', 'All') },
        ]} />
        <Button icon="plus" variant="primary" size="sm" onClick={() => { setEditing('new') }}>{t('添加线索', 'Add thread')}</Button>
      </div>
      {threads.length === 0 ? <Empty icon="thread" title={t('这里没有线索', 'No threads here')}>{t('伏笔、悬念、支线、对读者的承诺——收录章节时会自动发现并提出建议，也可以手动添加。', 'Foreshadowing, mysteries, subplots, promises to the reader — digest proposes them as chapters are written, and you can add your own.')}</Empty> : (
        <ul className="nv-thread-list">
          {threads.map((thread) => {
            const last = Math.max(0, ...[...(thread.planted ?? []), ...(thread.advanced ?? []), ...(thread.paid ?? [])].map(id => indexOf.get(id) ?? 0))
            const stale = thread.status === 'open' && last > 0 && latest - last >= 8
            return (
              <li key={thread.id} className="nv-thread nv-card">
                <div className="nv-thread-head">
                  <strong>{thread.title}</strong>
                  <Chip tone="violet">{t(...THREAD_KIND[thread.kind])}</Chip>
                  <Chip tone={THREAD_STATUS_TONE[thread.status]}>{t(...THREAD_STATUS[thread.status])}</Chip>
                  {thread.auto === true ? <Chip tone="blue" title={t('收录时自动发现，尚未确认', 'Found by digest, not confirmed yet')}>{t('自动', 'auto')}</Chip> : null}
                  {stale ? <Chip tone="red" title={t('很久没有推进了', 'Not advanced for a long time')}>{t(`已 ${latest - last} 章未动`, `idle for ${latest - last} ch.`)}</Chip> : null}
                  <span className="nv-thread-tools">
                    {thread.status === 'open' ? <Button size="sm" variant="ghost" icon="check" onClick={() => run(async () => { await apply([{ op: 'save-thread', thread: thread.id, status: 'paid' }]) })}>{t('标为已回收', 'Mark paid')}</Button> : null}
                    <Button size="sm" variant="ghost" icon="pen" onClick={() => { setEditing(thread) }} />
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => { confirm.ask(t(`删除线索「${thread.title}」？`, `Delete the thread "${thread.title}"?`), () => { void run(async () => { await apply([{ op: 'remove-thread', thread: thread.id }]) }) }) }} />
                  </span>
                </div>
                {thread.description !== undefined ? <p>{thread.description}</p> : null}
                <div className="nv-thread-track nv-muted nv-small">
                  {where(thread.planted).length > 0 ? <span>{t('埋下：第 ', 'Planted: ch. ')}{where(thread.planted)}{t(' 章', '')}</span> : null}
                  {where(thread.advanced).length > 0 ? <span>{t('推进：第 ', 'Advanced: ch. ')}{where(thread.advanced)}{t(' 章', '')}</span> : null}
                  {where(thread.paid).length > 0 ? <span>{t('回收：第 ', 'Paid off: ch. ')}{where(thread.paid)}{t(' 章', '')}</span> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {editing !== undefined ? <ThreadEditor thread={editing === 'new' ? undefined : editing} onClose={() => { setEditing(undefined) }} /> : null}
      {confirm.element}
    </div>
  )
}

function ThreadEditor({ thread, onClose }: { thread: PlotThread | undefined; onClose: () => void }) {
  const t = useT()
  const apply = useOutlineOps()
  const { busy, run } = useAction()
  const [title, setTitle] = useState(thread?.title ?? '')
  const [kind, setKind] = useState<ThreadKind>(thread?.kind ?? 'foreshadow')
  const [status, setStatus] = useState<ThreadStatus>(thread?.status ?? 'open')
  const [description, setDescription] = useState(thread?.description ?? '')
  return (
    <Modal title={thread === undefined ? t('添加线索', 'Add thread') : t('编辑线索', 'Edit thread')} onClose={onClose} footer={(
      <Button variant="primary" busy={busy} disabled={title.trim().length === 0} onClick={() => run(async () => { await apply([{ op: 'save-thread', ...(thread !== undefined ? { thread: thread.id } : {}), title, kind, status, description }]); onClose() })}>{t('保存', 'Save')}</Button>
    )}>
      <Field label={t('标题', 'Title')}><TextInput autoFocus value={title} onChange={(event) => { setTitle(event.target.value) }} /></Field>
      <div className="nv-form-grid">
        <Field label={t('类型', 'Kind')}><Select value={kind} options={labelOptions(THREAD_KIND, t)} onChange={setKind} /></Field>
        <Field label={t('状态', 'Status')}><Select value={status} options={labelOptions(THREAD_STATUS, t)} onChange={setStatus} /></Field>
      </div>
      <Field label={t('说明', 'Description')} hint={t('读者在等什么；打算怎样回收', 'What the reader is waiting for; how you plan to pay it off')}><TextArea value={description} minRows={3} onChange={(event) => { setDescription(event.target.value) }} /></Field>
    </Modal>
  )
}

// ───────────────────────────── derive ─────────────────────────────

interface DerivedChapter {
  title: string
  synopsis?: string
  purpose?: string
  pov?: string
  location?: string
  time?: string
  characters: string[]
  beats: Beat[]
  threads: { title: string; action: string }[]
}

interface Branch {
  title: string
  development: string
  consequences: string[]
  risks?: string
  payoff?: string
}

function Derive({ onApplied }: { onApplied: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const apply = useOutlineOps()
  const { busy, run } = useAction()
  const [count, setCount] = useState('5')
  const [direction, setDirection] = useState('')
  const [volume, setVolume] = useState(project.outline.volumes.at(-1)?.id ?? '')
  const [stream, setStream] = useState('')
  const [working, setWorking] = useState<'chapters' | 'whatif' | undefined>()
  const [derived, setDerived] = useState<{ chapters: DerivedChapter[]; rationale?: string; volume: string } | undefined>()
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [question, setQuestion] = useState('')
  const [branches, setBranches] = useState<{ branches: Branch[]; recommendation?: string } | undefined>()
  const nameOf = (ref: string): string => project.characters.find(card => card.id === ref)?.name ?? ref

  const derive = (override?: string): void => {
    const brief = (override ?? direction).trim()
    setWorking('chapters')
    setStream('')
    setDerived(undefined)
    setSkipped(new Set())
    void controller.guard(async () => {
      const info = await controller.run('ai.deriveChapters', { root, apply: false, count: Math.max(1, Math.min(12, Number(count) || 5)), ...(brief.length > 0 ? { direction: brief } : {}), ...(volume.length > 0 ? { volume } : {}) }, setStream)
      const output = info.result?.output as { chapters?: DerivedChapter[]; rationale?: string } | undefined
      if (output?.chapters !== undefined) setDerived({ chapters: output.chapters, ...(output.rationale !== undefined ? { rationale: output.rationale } : {}), volume })
    }).finally(() => { setWorking(undefined); setStream('') })
  }
  const ask = (): void => {
    setWorking('whatif')
    setStream('')
    setBranches(undefined)
    void controller.guard(async () => {
      const info = await controller.run('ai.whatIf', { root, question: question.trim() }, setStream)
      const output = info.result?.output as { branches?: Branch[]; recommendation?: string } | undefined
      if (output?.branches !== undefined) setBranches({ branches: output.branches, ...(output.recommendation !== undefined ? { recommendation: output.recommendation } : {}) })
    }).finally(() => { setWorking(undefined); setStream('') })
  }
  const accept = (): void => {
    if (derived === undefined) return
    void run(async () => {
      const known = new Set(project.outline.threads.map(thread => thread.title))
      const ops: OutlineOpInput[] = []
      derived.chapters.forEach((chapter, at) => {
        if (skipped.has(at)) return
        const threads: string[] = []
        for (const touch of chapter.threads) {
          if (known.has(touch.title)) threads.push(touch.title)
          else if (touch.action === 'plant') {
            ops.push({ op: 'save-thread', title: touch.title, kind: 'foreshadow', status: 'open' })
            known.add(touch.title)
            threads.push(touch.title)
          }
        }
        ops.push({
          op: 'add-chapter',
          title: chapter.title,
          status: 'outlined',
          ...(derived.volume.length > 0 ? { volume: derived.volume } : {}),
          ...(chapter.synopsis !== undefined ? { synopsis: chapter.synopsis } : {}),
          ...(chapter.purpose !== undefined ? { purpose: chapter.purpose } : {}),
          ...(chapter.pov !== undefined ? { pov: chapter.pov } : {}),
          ...(chapter.location !== undefined ? { location: chapter.location } : {}),
          ...(chapter.time !== undefined ? { time: chapter.time } : {}),
          ...(chapter.characters.length > 0 ? { characters: chapter.characters } : {}),
          ...(chapter.beats.length > 0 ? { beats: chapter.beats.map(({ id: _id, ...beat }) => beat) } : {}),
          ...(threads.length > 0 ? { threads } : {}),
        })
      })
      const results = await apply(ops)
      const first = results.find(result => result.op === 'add-chapter')?.id
      if (first !== undefined) controller.focusChapter(first)
      setDerived(undefined)
      controller.toast('success', t('已加入大纲', 'Added to the outline'))
      onApplied()
    })
  }

  return (
    <div className="nv-derive">
      <section className="nv-card">
        <SectionTitle>{t('推演后续章节', 'Derive the next chapters')}</SectionTitle>
        <p className="nv-muted nv-small">{t('架构模型读过设定、已写章节的记忆与未回收线索后，排出接下来的章纲。先看方案，满意再加入大纲。', 'The architect model reads the bible, the memory of what is written and the open threads, then outlines what comes next. Review the plan before adding it.')}</p>
        <div className="nv-form-grid">
          <Field label={t('章数', 'How many')}><TextInput inputMode="numeric" value={count} onChange={(event) => { setCount(event.target.value) }} /></Field>
          {project.outline.volumes.length > 1 ? <Field label={t('加入分卷', 'Volume')}><Select value={volume} options={project.outline.volumes.map(item => ({ value: item.id, label: item.title }))} onChange={setVolume} /></Field> : null}
        </div>
        <Field label={t('方向（可留空）', 'Direction (optional)')}><TextArea value={direction} minRows={2} placeholder={t('例：让反派先赢一局；这几章把感情线推到误会最深处', 'e.g. let the antagonist win a round; push the romance to its deepest misunderstanding')} onChange={(event) => { setDirection(event.target.value) }} /></Field>
        <div className="nv-form-actions">
          <Button variant="primary" icon="sparkles" busy={working === 'chapters'} disabled={working !== undefined} onClick={() => { derive() }}>{t('推演', 'Derive')}</Button>
        </div>
        {working === 'chapters' && stream.length > 0 ? <pre className="nv-stream">{stream.slice(-900)}</pre> : null}
        {derived !== undefined ? (
          <div className="nv-derived">
            {derived.rationale !== undefined ? <p className="nv-note">{derived.rationale}</p> : null}
            {derived.chapters.map((chapter, at) => (
              <article key={at} className={cx('nv-derived-item', skipped.has(at) && 'is-skipped')}>
                <header>
                  <label className="nv-check">
                    <input type="checkbox" checked={!skipped.has(at)} onChange={() => { setSkipped((previous) => { const next = new Set(previous); if (next.has(at)) next.delete(at); else next.add(at); return next }) }} />
                    <strong>{chapter.title}</strong>
                  </label>
                  <span className="nv-muted nv-small">{[chapter.pov !== undefined ? nameOf(chapter.pov) : undefined, chapter.location, chapter.time].filter(Boolean).join(' · ')}</span>
                </header>
                {chapter.synopsis !== undefined ? <p>{chapter.synopsis}</p> : null}
                {chapter.purpose !== undefined ? <p className="nv-muted nv-small">{t('作用：', 'Purpose: ')}{chapter.purpose}</p> : null}
                {chapter.beats.length > 0 ? <ol className="nv-derived-beats">{chapter.beats.map(beat => <li key={beat.id}>{beat.summary}</li>)}</ol> : null}
                <div className="nv-chips">
                  {chapter.characters.map(ref => <Chip key={ref} tone="blue">{nameOf(ref)}</Chip>)}
                  {chapter.threads.map(touch => <Chip key={touch.title} tone="amber">{touch.action === 'plant' ? t('埋：', 'plant: ') : touch.action === 'payoff' ? t('收：', 'pay off: ') : t('推：', 'advance: ')}{touch.title}</Chip>)}
                </div>
              </article>
            ))}
            <div className="nv-form-actions">
              <Button variant="ghost" onClick={() => { setDerived(undefined) }}>{t('放弃', 'Discard')}</Button>
              <Button icon="refresh" disabled={working !== undefined} onClick={() => { derive() }}>{t('重新推演', 'Derive again')}</Button>
              <Button variant="primary" icon="check" busy={busy} disabled={skipped.size === derived.chapters.length} onClick={accept}>{t(`把选中的 ${derived.chapters.length - skipped.size} 章加入大纲`, `Add ${derived.chapters.length - skipped.size} chapters to the outline`)}</Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="nv-card">
        <SectionTitle>{t('如果……会怎样', 'What if…')}</SectionTitle>
        <p className="nv-muted nv-small">{t('不动大纲，先看几种走向各自的后果，再决定走哪条。', 'Leaves the outline alone: see where a few branches would lead before you commit to one.')}</p>
        <Field label={t('假设', 'The question')}><TextArea value={question} minRows={2} placeholder={t('例：如果女主在第十章就发现了真相？', 'e.g. what if she learns the truth as early as chapter ten?')} onChange={(event) => { setQuestion(event.target.value) }} /></Field>
        <div className="nv-form-actions">
          <Button icon="sparkles" busy={working === 'whatif'} disabled={working !== undefined || question.trim().length === 0} onClick={ask}>{t('推演分支', 'Explore branches')}</Button>
        </div>
        {working === 'whatif' && stream.length > 0 ? <pre className="nv-stream">{stream.slice(-900)}</pre> : null}
        {branches !== undefined ? (
          <div className="nv-branches">
            {branches.branches.map((branch, at) => (
              <article key={at} className="nv-branch">
                <h5>{branch.title}</h5>
                <p>{branch.development}</p>
                {branch.consequences.length > 0 ? <ul>{branch.consequences.map((item, position) => <li key={position}>{item}</li>)}</ul> : null}
                {branch.payoff !== undefined ? <p className="nv-small"><Chip tone="green">{t('收益', 'Payoff')}</Chip> {branch.payoff}</p> : null}
                {branch.risks !== undefined ? <p className="nv-small"><Chip tone="red">{t('风险', 'Risk')}</Chip> {branch.risks}</p> : null}
                <Button size="sm" icon="arrowRight" disabled={working !== undefined} onClick={() => {
                  const brief = `${branch.title}：${branch.development}`
                  setDirection(brief)
                  derive(brief)
                }}>{t('按这个走向推演章节', 'Derive chapters along this branch')}</Button>
              </article>
            ))}
            {branches.recommendation !== undefined ? <p className="nv-note">{branches.recommendation}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/** Outline: volumes, chapters and beats; the lines of the plot and their graph; long-running threads; AI derivation and what-if branches. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { OutlineOpInput } from '../../shared/rpc'
import { formatCount, sameName } from '../../shared/text'
import { chapterBudgetOf, MAIN_LINE, type Beat, type ChapterInfo, type ChapterMemory, type ChapterPlan, type ChapterStatus, type CharacterCard, type PlotLine, type PlotThread, type ThreadKind, type ThreadStatus, type Volume } from '../../shared/types'
import { byWeight, CharacterPicker, useCastFilter } from '../CharacterPicker'
import { Icon } from '../icons'
import { ChapterTree, useOutlineOps } from '../ChapterTree'
import { MoveChapters } from '../MoveChapters'
import { HistoryButton } from '../History'
import { PlotGraph } from './PlotGraph'
import { CHAPTER_STATUS, CHAPTER_STATUS_TONE, THREAD_KIND, THREAD_STATUS, THREAD_STATUS_TONE } from '../labels'
import {
  Button, Chip, cx, Empty, Field, Menu, Modal, SectionTitle, Select, Tabs, TextArea, TextInput, useAction, useBookLine, useConfirm, useLoad, useProject, useSnapshot,
  useStudio, useT, type Translate, ViewButton,
} from '../ui'

const labelOptions = <T extends string>(labels: Record<T, [string, string]>, t: Translate): { value: T; label: string }[] =>
  (Object.keys(labels) as T[]).map(value => ({ value, label: t(labels[value][0], labels[value][1]) }))

export function OutlineView() {
  const t = useT()
  const { project } = useProject()
  const [tab, setTab] = useState<'chapters' | 'graph' | 'threads'>('chapters')
  const open = project.outline.threads.filter(thread => thread.status === 'open').length
  const lines = project.outline.lines?.length ?? 0
  return (
    <div className="nv-page nv-outline">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'chapters', label: t('章节', 'Chapters'), icon: 'tree', badge: project.chapters.length + (project.lines ?? []).reduce((sum, line) => sum + line.chapters.length, 0) },
          { value: 'graph', label: t('剧情图', 'Plot graph'), icon: 'branch', badge: lines > 0 ? lines + 1 : undefined },
          { value: 'threads', label: t('线索与伏笔', 'Threads'), icon: 'thread', badge: open },
        ]}
      />
      {tab === 'chapters' ? <Chapters onGraph={() => { setTab('graph') }} /> : tab === 'graph' ? <PlotGraph /> : <Threads />}
    </div>
  )
}

// ───────────────────────────── chapters ─────────────────────────────

function Chapters({ onGraph }: { onGraph: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const focused = useSnapshot(snapshot => snapshot.chapterId)
  const others = project.outline.lines ?? []
  const main = project.outline.volumes.flatMap(volume => volume.chapters)
  const everything = [...main, ...others.flatMap(line => line.chapters)]
  const info = new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter]))
  // One line of the plot at a time: the page is of the line in hand, as the list beside it is.
  const [wantedLine] = useBookLine()
  const shownLine = others.find(line => line.id === wantedLine)
  const path = shownLine === undefined ? main.map(plan => plan.id) : project.lines?.find(candidate => candidate.id === shownLine.id)?.path ?? shownLine.chapters.map(plan => plan.id)
  // (A chapter opened from elsewhere that this line does not read takes the whole Studio to its own line.)
  const own = shownLine !== undefined ? shownLine.chapters : main
  const selected = everything.find(plan => plan.id === focused && path.includes(plan.id)) ?? own[0] ?? everything.find(plan => path.includes(plan.id))
  const home = selected !== undefined ? others.find(line => line.chapters.some(plan => plan.id === selected.id)) : undefined
  const plans = home !== undefined ? home.chapters : main
  // What comes next is asked of the planner here, for the line shown: the chapters and their deriving are one page.
  const [deriving, setDeriving] = useState(false)

  // ── plans that say nothing of chapters whose digest knows them ──
  const fillable = useLoad(async signal => await controller.api.call('outline.fill', { root, dry: true }, signal), [root, project.revision])
  const filling = useAction()
  const fill = (): Promise<unknown> => filling.run(async () => {
    const done = await controller.api.call('outline.fill', { root })
    await controller.refreshProject()
    controller.toast('success', t(`补全了 ${done.chapters} 章章纲里空着的 ${done.fields} 项`, `Filled ${done.fields} empty item(s) in ${done.chapters} chapter outline(s)`))
  })

  return (
    <div className="nv-split">
      <aside className="nv-split-list nv-outline-tree">
        <ChapterTree
          active={deriving ? undefined : selected?.id}
          onOpen={(id) => { setDeriving(false); controller.focusChapter(id) }}
          onLine={() => { setDeriving(false) }}
          onGraph={onGraph}
          tools={<Button size="sm" variant={deriving ? 'primary' : 'outline'} icon="sparkles" onClick={() => { setDeriving(!deriving) }} title={t('让策划排出这条线接下来的章纲，或问一个"如果"', 'Have the planner plot what comes next on this line, or ask a what-if')}>{t('推演', 'Derive')}</Button>}
          note={fillable.data !== undefined && fillable.data.chapters > 0 ? (
            <div className="nv-note nv-outline-fill">
              <span>{t(`${fillable.data.chapters} 章的章纲还有空项，收录结果里有。`, `${fillable.data.chapters} chapter outline(s) have empty items the digests can fill.`)}</span>
              <Button size="sm" icon="wand" busy={filling.busy} pending={t('正在补全…', 'Filling…')} onClick={fill} title={t('只填空着的项；已经写了内容的项不动', 'Only empty fields are filled; a field with anything in it is left alone')}>{t('按收录结果补全', 'Fill from the digests')}</Button>
            </div>
          ) : undefined}
        />
      </aside>
      <section className="nv-split-detail">
        {deriving ? (
          <>
            <div className="nv-toolbar">
              <button type="button" className="nv-link" onClick={() => { setDeriving(false) }}>‹ {t('回到章纲', 'Back to the chapter')}</button>
              <span className="nv-muted nv-small">{shownLine !== undefined ? t(`剧情线「${shownLine.title}」`, `The line "${shownLine.title}"`) : others.length > 0 ? t('主线', 'Main line') : ''}</span>
            </div>
            <Derive key={shownLine?.id ?? MAIN_LINE} preset={shownLine !== undefined ? { line: shownLine.id, mode: 'append' } : undefined} onApplied={() => { setDeriving(false) }} />
          </>
        ) : selected !== undefined
          ? <ChapterPlanEditor key={selected.id} plan={selected} index={info.get(selected.id)?.index ?? 0} plans={plans} />
          : <Empty icon="tree" title={t('这条线还没有章节', 'No chapters on this line yet')}>{t('在左侧添加章节，或点"推演"让策划排出来。', 'Add a chapter on the left, or have the planner plot them with Derive.')}</Empty>}
      </section>
    </div>
  )
}


/**
 * Who is in a chapter. Only those: a book has hundreds of people, and a page
 * that lays every one of them out to be ticked reads as a chapter with
 * everybody in it. The plan's own cast is shown; whoever the digest found in
 * the chapter beyond that is offered; anyone else is added through the picker.
 */
function PlanCast({ chosen, memory, onChange }: { chosen: string[]; memory: ChapterMemory | undefined; onChange: (next: string[]) => void }) {
  const t = useT()
  const { project } = useProject()
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useCastFilter('plan-cast', project.characters)
  const cards = useMemo(() => new Map(project.characters.map(card => [card.id, card])), [project.characters])
  const mine = chosen.map(id => cards.get(id)).filter((card): card is CharacterCard => card !== undefined).sort(byWeight)
  // Those the digest found in the chapter: by the card it points at, else by a name a card answers to.
  const found = useMemo(() => {
    const seen = new Map<string, CharacterCard>()
    const loose: string[] = []
    for (const moment of memory?.characters ?? []) {
      const card = cards.get(moment.character) ?? project.characters.find(candidate => sameName(candidate.name, moment.name) || candidate.aliases?.some(alias => sameName(alias, moment.name)) === true)
      if (card !== undefined) seen.set(card.id, card)
      else if (!loose.includes(moment.name)) loose.push(moment.name)
    }
    return { cards: [...seen.values()].sort(byWeight), loose }
  }, [memory, cards, project.characters])
  const more = found.cards.filter(card => !chosen.includes(card.id))
  return (
    <>
      <SectionTitle actions={project.characters.length > 0 ? <Button size="sm" icon="plus" variant="ghost" onClick={() => { setPicking(true) }}>{t('添加人物', 'Add people')}</Button> : undefined}>
        {t(`出场人物${mine.length > 0 ? ` · ${mine.length}` : ''}`, `Cast of this chapter${mine.length > 0 ? ` · ${mine.length}` : ''}`)}
      </SectionTitle>
      <div className="nv-chips">
        {mine.map(card => (
          <Chip key={card.id} tone="blue" active onClick={() => { onChange(chosen.filter(id => id !== card.id)) }} title={t('点一下从这一章拿掉', 'Click to take out of this chapter')}>{card.name} ×</Chip>
        ))}
        {mine.length === 0 ? (
          <span className="nv-muted nv-small">
            {project.characters.length === 0
              ? t('设定里还没有人物。', 'No characters in the bible yet.')
              : t('还没有指定谁出场。', 'Nobody is set to appear yet.')}
          </span>
        ) : null}
      </div>
      {more.length > 0 ? (
        <div className="nv-plan-found">
          <span className="nv-muted nv-small">{t(`收录里出场、章纲没列的 ${more.length} 人：`, `${more.length} in the digest and not in the outline: `)}</span>
          <div className="nv-chips">
            {more.map(card => <Chip key={card.id} onClick={() => { onChange([...chosen, card.id]) }} title={t('点一下加进章纲', 'Click to add to the plan')}>+ {card.name}</Chip>)}
            <Button size="sm" variant="ghost" onClick={() => { onChange([...chosen, ...more.map(card => card.id)]) }}>{t('都加进来', 'Add them all')}</Button>
          </div>
        </div>
      ) : null}
      {found.loose.length > 0 ? <p className="nv-muted nv-small">{t(`收录里还提到没有人物卡的：${found.loose.join('、')}`, `Named in the digest, without a card: ${found.loose.join(', ')}`)}</p> : null}
      {picking ? (
        <Modal title={t('这一章有谁出场', 'Who is in this chapter')} onClose={() => { setPicking(false) }} footer={<Button variant="primary" onClick={() => { setPicking(false) }}>{t('好了', 'Done')}</Button>}>
          <CharacterPicker cards={project.characters} selected={new Set(chosen)} onChange={(next) => { onChange([...next]) }} filter={filter} onFilter={setFilter} />
        </Modal>
      ) : null}
    </>
  )
}

/** The threads a chapter touches — the same way: its own, what the digest found, and a list to choose more from. */
function PlanThreads({ chosen, memory, onChange }: { chosen: string[]; memory: ChapterMemory | undefined; onChange: (next: string[]) => void }) {
  const t = useT()
  const { project } = useProject()
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const threads = project.outline.threads
  const mine = chosen.map(id => threads.find(thread => thread.id === id)).filter((thread): thread is PlotThread => thread !== undefined)
  const found = useMemo(() => {
    const seen = new Map<string, PlotThread>()
    for (const touch of memory?.threads ?? []) {
      const thread = threads.find(candidate => candidate.id === touch.threadId) ?? threads.find(candidate => sameName(candidate.title, touch.title) || candidate.title.includes(touch.title) || touch.title.includes(candidate.title))
      if (thread !== undefined) seen.set(thread.id, thread)
    }
    return [...seen.values()]
  }, [memory, threads])
  const more = found.filter(thread => !chosen.includes(thread.id))
  const needle = query.trim().toLowerCase()
  // Open ones first: a thread that is closed is rarely what a chapter still touches.
  const listed = threads
    .filter(thread => needle.length === 0 || thread.title.toLowerCase().includes(needle) || thread.description?.toLowerCase().includes(needle) === true)
    .sort((left, right) => Number(right.status === 'open') - Number(left.status === 'open'))
  const toggle = (id: string): void => { onChange(chosen.includes(id) ? chosen.filter(item => item !== id) : [...chosen, id]) }
  return (
    <>
      <SectionTitle actions={threads.length > 0 ? <Button size="sm" icon="plus" variant="ghost" onClick={() => { setPicking(true) }}>{t('添加线索', 'Add threads')}</Button> : undefined}>
        {t(`牵动的线索${mine.length > 0 ? ` · ${mine.length}` : ''}`, `Threads it touches${mine.length > 0 ? ` · ${mine.length}` : ''}`)}
      </SectionTitle>
      <div className="nv-chips">
        {mine.map(thread => (
          <Chip key={thread.id} tone="amber" active onClick={() => { toggle(thread.id) }} title={t('点一下从这一章拿掉', 'Click to take out of this chapter')}>{thread.title} ×</Chip>
        ))}
        {mine.length === 0 ? (
          <span className="nv-muted nv-small">
            {threads.length === 0
              ? t('还没有线索。', 'No threads yet.')
              : t('章纲里还没有指定这一章牵动哪些线索。', 'The plan names no thread for this chapter yet.')}
          </span>
        ) : null}
      </div>
      {more.length > 0 ? (
        <div className="nv-plan-found">
          <span className="nv-muted nv-small">{t(`收录里牵动、章纲没列的 ${more.length} 条：`, `${more.length} touched in the digest and not in the outline: `)}</span>
          <div className="nv-chips">
            {more.map(thread => <Chip key={thread.id} onClick={() => { toggle(thread.id) }} title={t('点一下加进章纲', 'Click to add to the plan')}>+ {thread.title}</Chip>)}
            <Button size="sm" variant="ghost" onClick={() => { onChange([...chosen, ...more.map(thread => thread.id)]) }}>{t('都加进来', 'Add them all')}</Button>
          </div>
        </div>
      ) : null}
      {picking ? (
        <Modal title={t('这一章牵动哪些线索', 'Which threads this chapter touches')} onClose={() => { setPicking(false) }} footer={<Button variant="primary" onClick={() => { setPicking(false) }}>{t('好了', 'Done')}</Button>}>
          <div className="nv-picker">
            {threads.length > 8 ? <TextInput autoFocus value={query} placeholder={t('按标题找…', 'Find by title…')} onChange={(event) => { setQuery(event.target.value) }} /> : null}
            <div className="nv-picker-bar"><span className="nv-muted nv-small">{t(`列出 ${listed.length} 条，选中 ${chosen.length} 条`, `${listed.length} listed, ${chosen.length} chosen`)}</span></div>
            <ul className="nv-picker-list">
              {listed.map(thread => (
                <li key={thread.id}>
                  <label className="nv-picker-row">
                    <input type="checkbox" checked={chosen.includes(thread.id)} onChange={() => { toggle(thread.id) }} />
                    <span className="nv-person-text">
                      <span className="nv-list-title">{thread.title}</span>
                      <span className="nv-list-meta">{t(...THREAD_STATUS[thread.status])}{thread.description !== undefined && thread.description.length > 0 ? ` · ${thread.description}` : ''}</span>
                    </span>
                  </label>
                </li>
              ))}
              {listed.length === 0 ? <li className="nv-muted nv-small nv-picker-empty">{t('没有符合的线索。', 'No thread matches.')}</li> : null}
            </ul>
          </div>
        </Modal>
      ) : null}
    </>
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
  const beats = draft.beats ?? []
  // What the chapter turned out to be, where it has been digested: who was in it, which threads it touched.
  const written = useLoad(async signal => (await controller.api.call('chapter.read', { root, id: plan.id }, signal)).memory, [root, plan.id, project.revision])
  const memory = written.data
  const setBeat = (at: number, patch: Partial<Beat>): void => { set('beats', beats.map((beat, position) => position === at ? { ...beat, ...patch } : beat)) }
  const position = plans.findIndex(candidate => candidate.id === plan.id)
  const chapter = project.chapters.find(candidate => candidate.id === plan.id) ?? (project.lines ?? []).flatMap(line => line.chapters).find(candidate => candidate.id === plan.id)
  const onLine = (project.outline.lines ?? []).find(line => line.chapters.some(candidate => candidate.id === plan.id))
  const bookBudget = chapterBudgetOf(project.manifest)
  // Moving it to another place in the plot: itself, or with every chapter of its line that follows it.
  const [moving, setMoving] = useState<{ chapters: string[]; fresh?: boolean } | undefined>()
  const fromHere = (): string[] => {
    const own = onLine !== undefined ? onLine.chapters : project.outline.volumes.flatMap(volume => volume.chapters)
    const at = own.findIndex(candidate => candidate.id === plan.id)
    return at < 0 ? [plan.id] : own.slice(at).map(candidate => candidate.id)
  }

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
      // Nothing in the field takes the recommendation away: whoever writes the chapter then judges.
      targetWords: draft.targetWords ?? 0,
    }])
    setDirty(false)
  })
  const move = (side: 'before' | 'after'): void => {
    const anchor = plans[side === 'before' ? position - 1 : position + 1]
    if (anchor === undefined) return
    void run(async () => { await apply([{ op: 'move-chapter', chapter: plan.id, [side]: anchor.id }]) })
  }
  /** A new chapter beside this one — between two that are there. */
  const insert = (side: 'before' | 'after'): void => {
    void run(async () => {
      const results = await apply([{ op: 'add-chapter', title: t('新章节', 'New chapter'), [side]: plan.id }])
      const id = results[0]?.id
      if (id !== undefined) controller.focusChapter(id)
    })
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
        <h2><span className="nv-muted">{onLine !== undefined ? `${onLine.title} · ` : ''}{t(`第 ${index} 章`, `Chapter ${index}`)}</span> {draft.title}</h2>
        <div className="nv-row">
          <HistoryButton kind="plan" id={plan.id} name={t(`第 ${index} 章 ${plan.title} · 章纲`, `Chapter ${index}, ${plan.title} — the plan`)} onRestored={() => { setDirty(false) }} />
          <Menu
            icon="more"
            align="end"
            items={[
              { label: t('上移', 'Move up'), icon: 'arrowUp', disabled: position <= 0, onSelect: () => { move('before') } },
              { label: t('下移', 'Move down'), icon: 'arrowDown', disabled: position >= plans.length - 1, onSelect: () => { move('after') } },
              ...(onLine === undefined && project.outline.volumes.length > 1 ? project.outline.volumes.filter(volume => !volume.chapters.some(candidate => candidate.id === plan.id)).map(volume => ({
                label: t(`移到「${volume.title}」`, `Move to "${volume.title}"`), icon: 'folder' as const, onSelect: () => { void run(async () => { await apply([{ op: 'move-chapter', chapter: plan.id, volume: volume.id }]) }) },
              })) : []),
              { label: t('在前面插入一章', 'Insert a chapter before'), icon: 'plus', onSelect: () => { insert('before') } },
              { label: t('在后面插入一章', 'Insert a chapter after'), icon: 'plus', onSelect: () => { insert('after') } },
              { label: t('移到另一条线…', 'Move to another line…'), icon: 'branch', onSelect: () => { setMoving({ chapters: [plan.id] }) } },
              { label: t('把这一章及之后分成一条线…', 'Part this chapter and what follows into a line…'), icon: 'branch', onSelect: () => { setMoving({ chapters: fromHere(), fresh: true }) } },
              'separator',
              { label: t('删除章节', 'Delete chapter'), icon: 'trash', danger: true, onSelect: () => { confirm.ask(t(`删除第 ${index} 章「${plan.title}」？可以在这一页最下面恢复。`, `Delete chapter ${index}, "${plan.title}"? It can be restored at the bottom of this page.`), () => { void run(async () => { await apply([{ op: 'remove-chapter', chapter: plan.id }]) }) }) } },
            ]}
          />
          {chapter?.hasText === true ? <ViewButton onClick={() => { controller.setView('read', plan.id) }} title={t('观看：这一章在读者那里的样子', 'View: this chapter as a reader has it')} /> : null}
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
        <Field label={t('建议字数', 'Suggested length')} hint={bookBudget !== undefined ? t(`留空：用本书的每章建议字数 ${bookBudget}`, `Empty: the book's recommendation of ${bookBudget}`) : t('留空：由写手按这一章要做的事自己判断', 'Empty: the writer judges from what the chapter has to do')}><TextInput inputMode="numeric" value={draft.targetWords !== undefined && draft.targetWords > 0 ? String(draft.targetWords) : ''} placeholder={bookBudget !== undefined ? String(bookBudget) : t('由写手判断', 'left to the writer')} onChange={(event) => {
          const value = Number(event.target.value)
          setDraft(({ targetWords: _old, ...rest }) => (Number.isFinite(value) && value > 0 ? { ...rest, targetWords: Math.round(value) } : rest))
          setDirty(true)
        }} /></Field>
      </div>

      <PlanCast chosen={draft.characters ?? []} memory={memory} onChange={(next) => { set('characters', next) }} />
      <PlanThreads chosen={draft.threads ?? []} memory={memory} onChange={(next) => { set('threads', next) }} />

      <SectionTitle actions={<Button size="sm" icon="plus" variant="ghost" onClick={() => { set('beats', [...beats, { id: `new-${Date.now()}`, summary: '' }]) }}>{t('添加节拍', 'Add beat')}</Button>}>{t('节拍', 'Beats')}</SectionTitle>
      <div className="nv-assist">
        <TextInput value={direction} placeholder={t('想要的方向', 'A direction, if any')} onChange={(event) => { setDirection(event.target.value) }} />
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
      {moving !== undefined ? <MoveChapters chapters={moving.chapters} preset={{ ...(moving.fresh === true ? { fresh: true } : {}) }} onClose={() => { setMoving(undefined) }} /> : null}
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
      {threads.length === 0 ? <Empty icon="thread" title={t('这里没有线索', 'No threads here')}>{t('还没有线索：收录章节时会自动发现，也可以手动添加。', 'No threads yet: digesting chapters finds them, and they can be added by hand.')}</Empty> : (
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
                    <HistoryButton kind="thread" id={thread.id} name={thread.title} />
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

/**
 * The planner's two questions: what comes next, and what if. The Outline has
 * both; the Write page opens the first in a dialog, already asking — where the
 * author is when the last outlined chapter is written.
 */
export function Derive({ onApplied, only, autoStart, preset }: {
  onApplied: () => void
  /** Show only the derivation of chapters. */
  only?: 'chapters'
  /** Start deriving at once, with what the fields start with. */
  autoStart?: boolean
  /** Where the chapters go and what becomes of what is there, when whoever opened this already knows. */
  preset?: { line?: string; after?: string; mode: 'append' | 'replace' | 'branch' } | undefined
}) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const apply = useOutlineOps()
  const { busy, run } = useAction()
  const [count, setCount] = useState('5')
  const [direction, setDirection] = useState('')
  const [volume, setVolume] = useState(project.outline.volumes.at(-1)?.id ?? '')
  const others = project.outline.lines ?? []
  const [line, setLine] = useState(preset?.line ?? MAIN_LINE)
  const [mode, setMode] = useState<'append' | 'replace' | 'branch'>(preset?.mode ?? 'append')
  const [after, setAfter] = useState(preset?.after ?? '')
  const [lineTitle, setLineTitle] = useState('')
  const [choice, setChoice] = useState('')
  const [applied, setApplied] = useState<{ added: number; line?: { title: string; created: boolean }; replaced?: { chapters: number; kept?: { title: string } } } | undefined>()
  // The chapters of the line chosen, as they are read on it.
  const path = line === MAIN_LINE ? project.chapters : (() => {
    const known = new Map([...project.chapters, ...(project.lines ?? []).flatMap(candidate => candidate.chapters)].map(info => [info.id, info]))
    return (project.lines?.find(candidate => candidate.id === line)?.path ?? []).map(id => known.get(id)).filter((info): info is NonNullable<typeof info> => info !== undefined)
  })()
  const wanted = Math.max(1, Math.min(1000, Number(count) || 5))
  // A plan is looked at before it is added while it is one round and only adds; a rewrite, a new line or a long run is made as it is derived.
  const direct = mode !== 'append' || wanted > 12 || line !== MAIN_LINE || after.length > 0
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
    setApplied(undefined)
    void controller.guard(async () => {
      if (direct) {
        const info = await controller.run('ai.deriveChapters', {
          root,
          count: wanted,
          mode,
          ...(brief.length > 0 ? { direction: brief } : {}),
          ...(line !== MAIN_LINE ? { line } : volume.length > 0 ? { volume } : {}),
          ...(after.length > 0 ? { after } : {}),
          ...(mode === 'branch' && lineTitle.trim().length > 0 ? { title: lineTitle.trim() } : {}),
          ...(mode === 'branch' && choice.trim().length > 0 ? { choice: choice.trim() } : {}),
        }, setStream)
        const output = info.result?.output as { added?: { id: string }[]; line?: { title: string; created: boolean }; replaced?: { chapters: number; kept?: { title: string } }; rationale?: string } | undefined
        await controller.refreshProject()
        const first = output?.added?.[0]?.id
        if (first !== undefined) controller.focusChapter(first)
        setApplied({ added: output?.added?.length ?? 0, ...(output?.line !== undefined ? { line: output.line } : {}), ...(output?.replaced !== undefined ? { replaced: output.replaced } : {}) })
        return
      }
      const info = await controller.run('ai.deriveChapters', { root, apply: false, count: Math.max(1, Math.min(12, wanted)), ...(brief.length > 0 ? { direction: brief } : {}), ...(volume.length > 0 ? { volume } : {}) }, setStream)
      const output = info.result?.output as { chapters?: DerivedChapter[]; rationale?: string } | undefined
      if (output?.chapters !== undefined) setDerived({ chapters: output.chapters, ...(output.rationale !== undefined ? { rationale: output.rationale } : {}), volume })
    }).finally(() => { setWorking(undefined); setStream('') })
  }
  const started = useRef(false)
  useEffect(() => {
    if (autoStart !== true || started.current) return
    started.current = true
    derive()
  // Once, when the dialog opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart])
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
        <p className="nv-muted nv-small">{t('策划排出接下来的章纲：接着写，替换某一章之后的大纲，或另开一条线。', 'The planner plots what comes next: carry on, replace the outline after a chapter, or open another line.')}</p>
        <div className="nv-form-grid">
          <Field label={t('章数', 'How many')} hint={wanted > 12 ? t(`分 ${Math.ceil(wanted / 10)} 轮，直接加入大纲`, `In ${Math.ceil(wanted / 10)} rounds, added straight to the outline`) : t('想要多少章都可以；超过 12 章分轮推演，每轮十章', 'As many as you want; more than 12 are derived in rounds of ten')}><TextInput inputMode="numeric" value={count} onChange={(event) => { setCount(event.target.value.replace(/\D/g, '').slice(0, 3)) }} /></Field>
          <Field label={t('怎么处理原有的后续', 'What becomes of what follows')}>
            <Select value={mode} options={[
              { value: 'append', label: t('接着往后推演', 'Carry on from the end') },
              { value: 'replace', label: t('替换那之后的大纲', 'Replace the outline after it') },
              { value: 'branch', label: t('另开一条线，原来的也留着', 'Open a line of its own, and keep what is there') },
            ]} onChange={setMode} />
          </Field>
          {others.length > 0 ? (
            <Field label={t('哪条线', 'Which line')}>
              <Select value={line} options={[{ value: MAIN_LINE, label: t('主线', 'Main line') }, ...others.map(item => ({ value: item.id, label: item.title }))]} onChange={(value) => { setLine(value); setAfter('') }} />
            </Field>
          ) : null}
          <Field label={t('从哪一章之后', 'After which chapter')} hint={mode === 'append' ? t('默认接在这条线的末尾', 'By default: the end of the line') : t('默认从最后一章已写的章节之后', 'By default: after the last chapter that is written')}>
            <Select value={after} options={[{ value: '', label: mode === 'append' ? t('（这条线的末尾）', '(the end of the line)') : t('（最后一章已写的章节）', '(the last written chapter)') }, ...path.map(item => ({ value: item.id, label: `${item.index}. ${item.title}${item.hasText ? '' : t('（未写）', ' (unwritten)')}` }))]} onChange={setAfter} />
          </Field>
          {line === MAIN_LINE && mode === 'append' && after.length === 0 && project.outline.volumes.length > 1 ? <Field label={t('加入分卷', 'Volume')}><Select value={volume} options={project.outline.volumes.map(item => ({ value: item.id, label: item.title }))} onChange={setVolume} /></Field> : null}
        </div>
        {mode === 'branch' ? (
          <div className="nv-form-grid">
            <Field label={t('新线的名字（可不填）', 'The new line\'s name (optional)')}><TextInput value={lineTitle} placeholder={t('例：她没有烧掉那封信', 'e.g. She keeps the letter')} onChange={(event) => { setLineTitle(event.target.value) }} /></Field>
            <Field label={t('分叉处的抉择（可不填）', 'What is decided where they part (optional)')}><TextInput value={choice} onChange={(event) => { setChoice(event.target.value) }} /></Field>
          </div>
        ) : null}
        {mode === 'replace' ? <p className="nv-note is-warn">{t(`这会把${after.length > 0 ? '所选章节' : '最后一章已写章节'}之后的大纲换掉。没写正文的章节会被删除；写了正文的留成一条“搁置”的线。`, `This replaces the outline after ${after.length > 0 ? 'the chosen chapter' : 'the last written chapter'}. Unwritten chapters are deleted; written ones are kept as a shelved line.`)}</p> : null}
        <Field label={t('方向（可留空）', 'Direction (optional)')}><TextArea value={direction} minRows={2} placeholder={t('例：让反派先赢一局；这几章把感情线推到误会最深处', 'e.g. let the antagonist win a round; push the romance to its deepest misunderstanding')} onChange={(event) => { setDirection(event.target.value) }} /></Field>
        <div className="nv-form-actions">
          <Button variant="primary" icon="sparkles" busy={working === 'chapters'} disabled={working !== undefined} onClick={() => { derive() }}>{t('推演', 'Derive')}</Button>
        </div>
        {working === 'chapters' && stream.length > 0 ? <pre className="nv-stream">{stream.slice(-900)}</pre> : null}
        {applied !== undefined ? (
          <p className="nv-note is-ok">
            {t(`已把 ${applied.added} 章加入${applied.line !== undefined ? `${applied.line.created ? '新开的' : ''}剧情线「${applied.line.title}」` : '大纲'}。`, `${applied.added} chapters were added to ${applied.line !== undefined ? `the ${applied.line.created ? 'new ' : ''}line "${applied.line.title}"` : 'the outline'}.`)}
            {applied.replaced !== undefined && applied.replaced.chapters > 0 ? t(` 被替换的 ${applied.replaced.chapters} 章${applied.replaced.kept !== undefined ? `已经有正文，留成了搁置的线「${applied.replaced.kept.title}」` : '还没有正文，已删除'}。`, ` The ${applied.replaced.chapters} chapters they replace ${applied.replaced.kept !== undefined ? `had text and are kept as the line "${applied.replaced.kept.title}", put aside` : 'had no text and are gone'}.`) : ''}
            {' '}<button type="button" className="nv-link" onClick={onApplied}>{t('去看看', 'Show them')}</button>
          </p>
        ) : null}
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

      {only === 'chapters' ? null : (
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
                <div className="nv-row-wrap">
                  <Button size="sm" icon="arrowRight" disabled={working !== undefined} onClick={() => {
                    const brief = `${branch.title}：${branch.development}`
                    setDirection(brief)
                    derive(brief)
                  }}>{t('按这个走向推演章节', 'Derive chapters along this branch')}</Button>
                  <Button size="sm" variant="ghost" icon="branch" disabled={working !== undefined} onClick={() => {
                    // Kept beside what is there: the fields above are set for a line of its own, for the author to look over and start.
                    setDirection(`${branch.title}：${branch.development}`)
                    setMode('branch')
                    setLineTitle(branch.title)
                    controller.toast('info', t('已填到上面，确认后点“推演”', 'Filled in above: check it, then Plot'))
                  }}>{t('把这个走向开成一条线', 'Open this branch as a line')}</Button>
                </div>
              </article>
            ))}
            {branches.recommendation !== undefined ? <p className="nv-note">{branches.recommendation}</p> : null}
          </div>
        ) : null}
      </section>
      )}
    </div>
  )
}

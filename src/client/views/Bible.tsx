// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The bible of a book: where it happens, the houses and organizations in it,
 * the things that matter in it, the ideas its world runs by — each a page of
 * its own — and how the book is written and how it is drawn. The people of
 * the book have a page of their own (`views/Cast.tsx`).
 */
import { LinePickBar, LinesField, LineTags, useLinePicks, useLines } from '../LinesField'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MAIN_LINE, type NarrativePov, type StyleProfile, type WorldCategory, type WorldEntry, type WorldEvent } from '../../shared/types'
import { pathOfLine } from '../../shared/lines'
import { ArtPage } from '../ArtPage'
import { lines, options, useAssist } from '../forms'
import { GROUP_CATEGORY, groupOf, WORLD_GROUPS, WORLD_WEIGHTS, worldOrder, worldWeight, type WorldGroup, type WorldWeight } from '../../shared/world'
import { Icon, type IconName } from '../icons'
import { WORLD_CATEGORY as CATEGORY_LABELS } from '../labels'
import { MergeDialog, TidyDialog } from '../WorldTidy'
import { HistoryButton, RemovedCards } from '../History'
import { DeletePicture, PictureViewer, type LookOf } from '../PictureRecord'
import { containment, type Nested } from '../../shared/ties'
import { DERIVE_TIES_HINT, TiesBlock, TiesReport, useDeriveTies } from '../Ties'
import {
  Button, Chip, cx, Empty, Field, Modal, ProjectImage, SectionTitle, Select, Tabs, TextArea, TextInput, useAction, useBookLine, useConfirm, useKept, useLoad,
  useProject, useRunningJob, useSnapshot, useStudio, useT, plainEnter,
} from '../ui'

/** The bible's own choices beside the line in hand: every line at once, and what is filed under no line. */
const EVERY_LINE = '*'
const NO_LINE = '-'

const POV_LABELS: Record<NarrativePov, [string, string]> = {
  'first': ['第一人称', 'First person'],
  'third-limited': ['第三人称有限', 'Third limited'],
  'third-omniscient': ['第三人称全知', 'Third omniscient'],
  'second': ['第二人称', 'Second person'],
  'multi': ['多视角轮换', 'Rotating viewpoints'],
}

/** The pages of the bible that hold entries: what each is called, and what it says of itself when it is empty. */
const GROUP_LABELS: Record<WorldGroup, { tab: [string, string]; icon: IconName; create: [string, string]; empty: [string, string] }> = {
  places: { tab: ['地点', 'Places'], icon: 'home', create: ['新建地点', 'New place'], empty: ['还没有地点。', 'No places yet.'] },
  factions: { tab: ['家族与组织', 'Houses'], icon: 'users', create: ['新建家族 / 组织', 'New house or organization'], empty: ['还没有家族或组织。', 'No houses or organizations yet.'] },
  items: { tab: ['物品', 'Things'], icon: 'star', create: ['新建物品', 'New thing'], empty: ['还没有物品。', 'No things yet.'] },
  ideas: { tab: ['世界观', 'World'], icon: 'globe', create: ['新建设定', 'New entry'], empty: ['还没有世界观条目：规则、命题、制度、历史。', 'No world entries yet: rules, themes, institutions, history.'] },
}

const WEIGHT_LABELS: Record<WorldWeight, [string, string]> = {
  core: ['核心', 'Core'],
  major: ['重要', 'Major'],
  minor: ['次要', 'Minor'],
  once: ['只出现一次', 'Passed once'],
}

type BibleTab = WorldGroup | 'style' | 'art'

export function BibleView() {
  const t = useT()
  const { project } = useProject()
  const [tab, setTab] = useKept<BibleTab>('bible.tab', 'places')
  // A link from elsewhere names an entry: its page is the one it is on.
  const entity = useSnapshot(snapshot => snapshot.entity)
  useEffect(() => {
    // …or the look of the book's pictures, from where a picture's art direction is read.
    if (entity?.kind === 'art') setTab('art')
    if (entity?.kind !== 'world') return
    const entry = project.world.find(candidate => candidate.id === entity.id)
    if (entry !== undefined) setTab(groupOf(entry.category))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.nonce])
  const count = (group: WorldGroup): number => project.world.filter(entry => groupOf(entry.category) === group).length
  return (
    <div className="nv-page nv-bible">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ...WORLD_GROUPS.map(group => ({ value: group as BibleTab, label: t(...GROUP_LABELS[group].tab), icon: GROUP_LABELS[group].icon, badge: count(group) })),
          { value: 'style' as BibleTab, label: t('文风', 'Style'), icon: 'feather' as IconName, badge: project.styles.length },
          { value: 'art' as BibleTab, label: t('画风', 'Art'), icon: 'image' as IconName },
        ]}
      />
      {tab === 'style' ? <Styles /> : tab === 'art' ? <ArtPage /> : <World key={tab} group={tab} />}
    </div>
  )
}

// ───────────────────────────── the entries: places, houses, things, ideas ─────────────────────────────

/** An entry's picture small, for a list: its design art, else a mark of what it is. */
function EntryThumb({ entry, icon }: { entry: WorldEntry; icon: IconName }) {
  return entry.visualImage !== undefined
    ? <ProjectImage className="nv-entry-thumb" path={entry.visualImage} alt="" />
    : <span className="nv-entry-thumb is-empty" aria-hidden="true"><Icon name={icon} size={14} /></span>
}

function World({ group }: { group: WorldGroup }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const labels = GROUP_LABELS[group]
  const entity = useSnapshot(snapshot => snapshot.entity)
  const ties = useDeriveTies()
  const [tidying, setTidying] = useState(false)
  // A world may hold several stories. What is listed is the line in hand's: what is filed under it — by the author, or
  // because a digest of that line found it — with what the lines share (filed under none) in a group of its own below.
  // Every line at once, and what is filed under none alone, are this page's own choices beside the line in hand.
  const plotLines = useLines()
  const [bookLine, setBookLine] = useBookLine()
  const [view, setView] = useKept<'line' | typeof EVERY_LINE | typeof NO_LINE>('bible.lineView', 'line')
  const chosen = plotLines.length === 0 ? undefined : view === 'line' ? bookLine : view
  const setLine = (next: string): void => {
    setView(next === EVERY_LINE || next === NO_LINE ? next : 'line')
    if (next !== EVERY_LINE && next !== NO_LINE) setBookLine(next)
  }
  // Where the text names each entry: said beside one that is filed nowhere. (A Host from before knows nothing of it.)
  const where = useLoad(async signal => (plotLines.length > 0 ? await controller.api.call('lines.seen', { root }, signal).catch(() => undefined) : undefined), [root, project.revision, plotLines.length])
  const lastWhere = useRef<Record<string, string[]> | undefined>(undefined)
  if (where.data?.world !== undefined) lastWhere.current = where.data.world
  const namedOn = where.data?.world ?? lastWhere.current
  // The story each line tells: lines that parted from one another tell one, and what one of them names is not "another line's" to the others.
  const lastStories = useRef<Map<string, string> | undefined>(undefined)
  if (where.data?.lines !== undefined) lastStories.current = new Map(where.data.lines.map(line => [line.id, line.story ?? line.id]))
  const storyOf = (id: string): string => lastStories.current?.get(id) ?? id
  // Along a line beside the main one, the chapters that name an entry are that line's: asked for, where the page shows one.
  const along = chosen !== undefined && chosen !== EVERY_LINE && chosen !== MAIN_LINE ? chosen : undefined
  const read = useLoad(async signal => (along !== undefined ? await controller.api.call('world.presence', { root, line: along }, signal).catch(() => undefined) : undefined), [root, along, project.revision])
  const lastRead = useRef<{ line: string; data: NonNullable<typeof read.data> } | undefined>(undefined)
  if (read.data !== undefined && along !== undefined) lastRead.current = { line: along, data: read.data }
  const alongData = along === undefined ? undefined : read.data ?? (lastRead.current?.line === along ? lastRead.current.data : undefined)
  const textOf = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter.hasText])), [project.chapters, project.lines])
  const written = alongData?.written ?? (chosen === EVERY_LINE
    ? project.chapters.filter(chapter => chapter.hasText).length + (project.lines ?? []).reduce((sum, line) => sum + line.chapters.filter(chapter => chapter.hasText).length, 0)
    : pathOfLine(project, MAIN_LINE).filter(id => textOf.get(id) === true).length)
  const presence = alongData?.presence ?? project.worldPresence ?? []
  const seen = useMemo(() => new Map(presence.map(item => [item.entry, item.chapters.length])), [presence])
  const everything = useMemo(() => project.world.filter(entry => groupOf(entry.category) === group), [project.world, group])
  const lineIds = useMemo(() => new Set(plotLines.map(line => line.id)), [plotLines])
  /** The lines an entry is filed under, of those the book still has. */
  const filedOf = (entry: WorldEntry): string[] => (entry.lines ?? []).filter(id => lineIds.has(id))
  const unfiled = useMemo(() => everything.filter(entry => (entry.lines ?? []).filter(id => lineIds.has(id)).length === 0), [everything, lineIds])
  const mine = useMemo(() => (chosen === undefined || chosen === EVERY_LINE ? everything : chosen === NO_LINE ? unfiled : everything.filter(entry => (entry.lines ?? []).includes(chosen))),
    [everything, unfiled, chosen])
  // Beside a line's own: what the lines share, which that line knows as well — what its text names, and what no
  // line's text names yet. What is filed nowhere while only other lines' text names it is theirs in all but the filing:
  // it is kept apart, folded, with the way to file it. (A Host that cannot say where things are named: all are shared.)
  const onLine = chosen !== undefined && chosen !== EVERY_LINE && chosen !== NO_LINE
  const namedHere = (item: WorldEntry): boolean => {
    const on = namedOn?.[item.id] ?? []
    return on.length === 0 || on.some(id => storyOf(id) === storyOf(chosen!))
  }
  const shared = !onLine ? [] : namedOn === undefined ? unfiled : unfiled.filter(namedHere)
  const elsewhere = onLine && namedOn !== undefined ? unfiled.filter(item => !namedHere(item)) : []
  const picks = useLinePicks()
  // Ideas are ordered by how they travel to a model, as they always were; whatever is somewhere or something, by its weight in the story.
  const weighed = group !== 'ideas'
  const ordered = useMemo(() => (weighed ? worldOrder(mine, presence, written) : [...mine].sort((left, right) => left.importance - right.importance)), [mine, presence, written, weighed])
  const [selected, setSelected] = useState<string | undefined>(() => (entity?.kind === 'world' && mine.some(entry => entry.id === entity.id) ? entity.id : undefined) ?? ordered[0]?.id)
  const [category, setCategory] = useState<WorldCategory | 'all'>('all')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const { busy, run } = useAction()
  // Places — and houses — can be listed by what is in what, once the ties say so.
  const nested = useMemo(() => (group === 'places' || group === 'factions' ? containment(ordered.map(item => item.id), project.ties ?? []) : []), [group, ordered, project.ties])
  const hasTree = nested.some(node => node.children.length > 0)
  const [layout, setLayout] = useKept<'weight' | 'tree'>(`bible.layout.${group}`, 'weight')
  const asTree = hasTree && layout === 'tree'
  useEffect(() => {
    if (entity?.kind !== 'world' || !mine.some(entry => entry.id === entity.id)) return
    setSelected(entity.id)
    setCategory('all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.nonce])
  const visible = ordered.filter(entry => category === 'all' || entry.category === category)
  const sharedOrdered = useMemo(() => (weighed ? worldOrder(shared, presence, written) : [...shared].sort((left, right) => left.importance - right.importance)).filter(entry => category === 'all' || entry.category === category),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shared, presence, written, weighed, category])
  const elsewhereOrdered = useMemo(() => [...elsewhere].sort((left, right) => left.name.localeCompare(right.name)).filter(entry => category === 'all' || entry.category === category),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [elsewhere.map(item => item.id).join('\n'), category])
  // Open while the line has nothing of its own: a page with everything folded away says nothing.
  const sharedOpen = !(folded.shared ?? mine.length > 0)
  const elsewhereOpen = folded.elsewhere === false
  // An entry opened from elsewhere stays open though the line in hand is not its own.
  const entry = everything.find(candidate => candidate.id === selected)
  const used = [...new Set([...mine, ...shared, ...elsewhere].map(item => item.category))]
  const lineName = (id: string): string => plotLines.find(line => line.id === id)?.title ?? id
  // What the list shows now, in its order: what "all" picks.
  const listedIds = [...visible, ...(sharedOpen ? sharedOrdered : []), ...(elsewhereOpen ? elsewhereOrdered : [])].map(item => item.id)
  /** File what only other lines' text names under those lines: it then leaves this line's page for good. */
  const fileElsewhere = (): Promise<unknown> => run(async () => {
    const done = await controller.api.call('lines.assign', { root, byText: true, world: elsewhere.map(item => item.id) })
    controller.toast('success', t(`${done.world.length} 项照正文归了线`, `${done.world.length} filed under the lines that name them`))
  })
  const weightOf = (item: WorldEntry): WorldWeight => worldWeight(item, seen.get(item.id) ?? 0, written)
  const create = (): Promise<unknown> => run(async () => {
    const created = await controller.api.call('world.save', { root, entry: { name: name.trim(), category: group === 'ideas' && category !== 'all' ? category : GROUP_CATEGORY[group], importance: 2 } })
    setSelected(created.id)
    setCreating(false)
    setName('')
  })
  // Those the story lives in or comes back to should be seen: the ones still without a picture are said, not nagged about one by one.
  const undrawn = group === 'places' || group === 'items' ? ordered.filter(item => item.visualImage === undefined && (weightOf(item) === 'core' || weightOf(item) === 'major')) : []
  const row = (item: WorldEntry): ReactNode => (
    <li key={item.id}>
      <button type="button" className={cx('nv-list-row nv-entry-row', item.id === selected && !picks.on && 'is-active', picks.on && picks.ids.has(item.id) && 'is-picked')} aria-pressed={picks.on ? picks.ids.has(item.id) : undefined} onClick={() => { if (picks.on) picks.toggle(item.id); else setSelected(item.id) }}>
        {picks.on ? <span className={cx('nv-pick-mark', picks.ids.has(item.id) && 'is-on')} aria-hidden="true"><Icon name="check" size={11} /></span> : null}
        {group === 'places' || group === 'items' || (group === 'factions' && item.visualImage !== undefined) ? <EntryThumb entry={item} icon={labels.icon} /> : null}
        <span className="nv-person-text">
          <span className="nv-list-title">{item.importance === 1 ? '★ ' : ''}{item.name}</span>
          <span className="nv-list-meta">
            {weighed ? ((seen.get(item.id) ?? 0) > 0 ? t(`${seen.get(item.id)} 章`, `${seen.get(item.id)} ch.`) : t('正文里还没写到', 'not in the text yet')) : t(...CATEGORY_LABELS[item.category])}
            {plotLines.length === 0 ? '' : filedOf(item).length > 0
              ? (chosen === EVERY_LINE || filedOf(item).length > 1 ? ` · ${t(`仅 ${filedOf(item).map(lineName).join('、')}`, `${filedOf(item).map(lineName).join(', ')} only`)}` : '')
              : (namedOn?.[item.id] ?? []).length > 0 && (namedOn![item.id]!.length < plotLines.length) ? ` · ${t(`出现在 ${namedOn![item.id]!.map(lineName).join('、')}`, `seen on ${namedOn![item.id]!.map(lineName).join(', ')}`)}` : ''}
            {item.summary !== undefined ? ` · ${item.summary}` : ''}
          </span>
        </span>
      </button>
    </li>
  )
  const byId = new Map(mine.map(item => [item.id, item]))
  const branch = (node: Nested): ReactNode => {
    const item = byId.get(node.id)
    if (item === undefined || (category !== 'all' && item.category !== category)) return null
    return node.children.length === 0 ? row(item) : (
      <li key={node.id} className="nv-entry-branch">
        <ul className="nv-list">{row(item)}</ul>
        <ul className="nv-list nv-entry-children">{node.children.map(child => branch(child))}</ul>
      </li>
    )
  }
  return (
    <div className="nv-split">
      <aside className="nv-split-list">
        <div className="nv-list-tools">
          {group === 'ideas' && used.length > 1
            ? <Select value={category} options={[{ value: 'all', label: t('全部类别', 'All categories') }, ...options(CATEGORY_LABELS, t).filter(option => used.includes(option.value))]} onChange={setCategory} />
            : <span className="nv-spacer" />}
          {project.world.length > 1 ? <Button size="sm" icon="sparkles" variant="ghost" onClick={() => { setTidying(true) }} title={t('让策划找出记重了的条目和放错类别的', 'Have the planner find entries kept twice and ones filed wrongly')}>{t('整理', 'Tidy')}</Button> : null}
          <Button size="sm" icon="plus" variant="primary" onClick={() => { setCreating(true) }}>{t(...labels.create)}</Button>
        </div>
        {chosen !== undefined ? (
          <div className="nv-bible-line">
            <Select value={chosen} options={[
              ...plotLines.map(line => ({ value: line.id, label: `${line.id === MAIN_LINE ? '★ ' : ''}${line.title}（${everything.filter(item => (item.lines ?? []).includes(line.id)).length}）` })),
              { value: NO_LINE, label: t(`没归线的（${unfiled.length}）`, `Filed under none (${unfiled.length})`) },
              { value: EVERY_LINE, label: t(`所有线（${everything.length}）`, `Every line (${everything.length})`) },
            ]} onChange={setLine} />
            {!picks.on ? <LinePickBar picks={picks} listed={listedIds} kind="world" /> : null}
          </div>
        ) : null}
        {chosen !== undefined && picks.on ? <LinePickBar picks={picks} listed={listedIds} kind="world" /> : null}
        {undrawn.length > 0 ? (
          <p className="nv-note nv-small">
            {group === 'places'
              ? t(`${undrawn.length} 个核心 / 重要的地点还没有设定图：${undrawn.slice(0, 3).map(item => item.name).join('、')}${undrawn.length > 3 ? ' 等' : ''}。`, `${undrawn.length} central or major place(s) have no art: ${undrawn.slice(0, 3).map(item => item.name).join(', ')}${undrawn.length > 3 ? ' …' : ''}.`)
              : t(`${undrawn.length} 件核心 / 重要的物品还没有设定图：${undrawn.slice(0, 3).map(item => item.name).join('、')}${undrawn.length > 3 ? ' 等' : ''}。`, `${undrawn.length} central or major thing(s) have no art: ${undrawn.slice(0, 3).map(item => item.name).join(', ')}${undrawn.length > 3 ? ' …' : ''}.`)}
          </p>
        ) : null}
        {hasTree ? (
          <div className="nv-entry-layout-row">
            <div className="nv-seg nv-entry-layout" role="group">
              <button type="button" className={cx(!asTree && 'is-active')} onClick={() => { setLayout('weight') }}>{t('按分量', 'By weight')}</button>
              <button type="button" className={cx(asTree && 'is-active')} onClick={() => { setLayout('tree') }} title={t('按包含关系：大的在上，里面的缩进在下面', 'By what is in what: the larger above, what is in it indented below')}>{t('按包含关系', 'By what is in what')}</button>
            </div>
            <Button size="sm" variant="ghost" icon="sparkles" busy={ties.busy} pending={t('策划正在理关系…', 'The planner is working out the ties…')} onClick={ties.derive} title={t(...DERIVE_TIES_HINT)}>{t('再理一遍关系', 'Work the ties out again')}</Button>
          </div>
        ) : (group === 'places' || group === 'factions') && mine.length > 1 ? (
          <p className="nv-note nv-small">
            {group === 'places' ? t('还没有理过地点之间的包含关系。', 'What lies inside what has not been worked out yet.') : t('还没有理过谁属于哪一家、哪一家坐落在哪。', 'Who belongs to which house, and where each has its seat, has not been worked out yet.')}
            {' '}
            <Button size="sm" icon="sparkles" busy={ties.busy} pending={t('策划正在理关系…', 'The planner is working out the ties…')} onClick={ties.derive} title={t(...DERIVE_TIES_HINT)}>{t('让策划理一遍关系', 'Have the planner work out the ties')}</Button>
          </p>
        ) : null}
        <TiesReport report={ties.report} onDismiss={ties.dismiss} />
        {asTree ? <ul className="nv-list nv-entry-tree">{nested.map(node => branch(node))}</ul> : weighed ? WORLD_WEIGHTS.map((weight) => {
          const here = visible.filter(item => weightOf(item) === weight)
          if (here.length === 0) return null
          // What is passed once is a line each, and many of them: folded until somebody looks.
          const closed = folded[weight] ?? (weight === 'once' && here.length > 6 && !here.some(item => item.id === selected))
          return (
            <div key={weight} className="nv-people-group">
              <button type="button" className="nv-group-head" aria-expanded={!closed} onClick={() => { setFolded(previous => ({ ...previous, [weight]: !closed })) }}>
                <Icon name={closed ? 'chevronRight' : 'chevronDown'} size={12} />
                <span>{t(...WEIGHT_LABELS[weight])}</span>
                <span className="nv-muted">{here.length}</span>
              </button>
              {closed ? null : <ul className="nv-list">{here.map(row)}</ul>}
            </div>
          )
        }) : <ul className="nv-list">{visible.map(row)}</ul>}
        {mine.length === 0 && shared.length === 0 ? <p className="nv-muted nv-pad">{everything.length === 0 ? t(...labels.empty) : chosen === NO_LINE ? t('都归了线。', 'Everything is filed.') : t('这条线上还没有。', 'None on this line yet.')}</p> : null}
        {shared.length > 0 ? (
          <div className="nv-people-group nv-shared-group">
            <button type="button" className="nv-group-head" aria-expanded={sharedOpen} onClick={() => { setFolded(previous => ({ ...previous, shared: sharedOpen })) }} title={t('没归到哪条线的：每条线写作时都能用到', 'Filed under no line: every line may be told of them')}>
              <Icon name={sharedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
              <span>{t('几条线共用的', 'Shared by the lines')}</span>
              <span className="nv-muted">{sharedOrdered.length}</span>
            </button>
            {sharedOpen ? <ul className="nv-list">{sharedOrdered.map(row)}</ul> : null}
          </div>
        ) : null}
        {elsewhere.length > 0 ? (
          <div className="nv-people-group nv-shared-group">
            <button type="button" className="nv-group-head" aria-expanded={elsewhereOpen} onClick={() => { setFolded(previous => ({ ...previous, elsewhere: elsewhereOpen })) }} title={t('没归线，而且只有别的线的正文写到', 'Filed under no line, and named by other lines\' text only')}>
              <Icon name={elsewhereOpen ? 'chevronDown' : 'chevronRight'} size={12} />
              <span>{t('只在别的线出现、没归线的', 'Unfiled, named on other lines only')}</span>
              <span className="nv-muted">{elsewhereOrdered.length}</span>
            </button>
            {elsewhereOpen ? (
              <>
                <p className="nv-pad nv-small"><Button size="sm" variant="outline" icon="sparkles" busy={busy} onClick={fileElsewhere} title={t('各归到正文写到它的那几条线；之后不再出现在这条线的页面上', 'Each under the lines whose text names it; it then leaves this line\'s page')}>{t(`照正文归线（${elsewhere.length}）`, `File by the text (${elsewhere.length})`)}</Button></p>
                <ul className="nv-list">{elsewhereOrdered.map(row)}</ul>
              </>
            ) : null}
          </div>
        ) : null}
        <RemovedCards kinds={['world']}>{count => t(`最近删除的设定 · ${count}`, `Deleted entries · ${count}`)}</RemovedCards>
      </aside>
      <section className="nv-split-detail">
        {entry !== undefined
          ? <WorldEditor key={entry.id} entry={entry} seen={presence.find(item => item.entry === entry.id)?.chapters ?? []} derived={worldWeight({}, seen.get(entry.id) ?? 0, written)} onDeleted={() => { setSelected(undefined) }} />
          : <Empty icon={labels.icon} title={mine.length === 0 ? t(...labels.create) : t('从左边选一条', 'Choose one on the left')} />}
      </section>
      {tidying ? <TidyDialog onClose={() => { setTidying(false) }} /> : null}
      {creating ? (
        <Modal title={t(...labels.create)} onClose={() => { setCreating(false) }} footer={<Button variant="primary" busy={busy} disabled={name.trim().length === 0} onClick={create}>{t('创建', 'Create')}</Button>}>
          <Field label={t('名称', 'Name')}><TextInput autoFocus value={name} onChange={(event) => { setName(event.target.value) }} onKeyDown={(event) => { if (plainEnter(event) && name.trim().length > 0) create() }} /></Field>
        </Modal>
      ) : null}
    </div>
  )
}

const COURSE_KINDS: Record<WorldEvent['kind'], [string, string]> = {
  begin: ['开始：建成 / 成立 / 出现', 'Begins: built, founded, first there'],
  change: ['变动：易主 / 改名 / 改建', 'Changes: owner, name, shape'],
  decline: ['衰败：荒废 / 衰落', 'Declines: left to ruin'],
  end: ['终结：被毁 / 失去 / 解散', 'Ends: destroyed, lost, dissolved'],
}

/**
 * What happens to a place, a house or a thing over the story: built in one
 * chapter, changed hands in another, left to ruin, destroyed. The planner
 * writes these down when it works the ties out; here they are put right by
 * hand. They go with the entry's other fields: nothing is kept until *Save*.
 */
/**
 * @param picture - what stands at the end of a turn's row: its picture, and the way to have one drawn.
 */
function CourseBlock({ events, onChange, picture }: { events: WorldEvent[]; onChange: (events: WorldEvent[]) => void; picture?: (event: WorldEvent, change: (patch: Partial<WorldEvent>) => void) => ReactNode }) {
  const t = useT()
  const { project } = useProject()
  const chapters = useMemo(() => [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)], [project.chapters, project.lines])
  const order = useMemo(() => new Map(chapters.map((chapter, at) => [chapter.id, at])), [chapters])
  const sorted = [...events].sort((left, right) => (order.get(left.chapter) ?? 0) - (order.get(right.chapter) ?? 0))
  const change = (at: number, patch: Partial<WorldEvent>): void => { onChange(sorted.map((event, index) => (index === at ? { ...event, ...patch } : event))) }
  return (
    <section className="nv-course">
      <header className="nv-ties-head">
        <strong>{t('轨迹', 'Its course')}</strong>
        <Button size="sm" variant="ghost" icon="plus" disabled={chapters.length === 0} onClick={() => { onChange([...sorted, { chapter: (chapters.find(chapter => chapter.hasText) ?? chapters[0]!).id, kind: 'begin', what: '' }]) }}>{t('添加一件事', 'Add something that happens')}</Button>
      </header>
      {sorted.length === 0 ? <p className="nv-muted nv-small">{t('哪一章建成、易主、荒废、被毁。', 'The chapter it was built, changed hands, fell into ruin, was destroyed.')}</p> : null}
      {sorted.map((event, at) => (
        <div key={at} className="nv-course-row">
          <Select value={event.chapter} options={chapters.map(chapter => ({ value: chapter.id, label: `${chapter.index}. ${chapter.title}` }))} onChange={(value) => { change(at, { chapter: value }) }} />
          <Select value={event.kind} options={options(COURSE_KINDS, t)} onChange={(value) => { change(at, { kind: value }) }} />
          <TextInput value={event.what} placeholder={t('发生了什么', 'What happened')} onChange={(input) => { change(at, { what: input.target.value }) }} />
          {picture?.(event, (patch) => { change(at, patch) })}
          <Button size="sm" variant="ghost" icon="x" onClick={() => { onChange(sorted.filter((_item, index) => index !== at)) }} title={t('去掉这一件', 'Take this one away')} />
        </div>
      ))}
    </section>
  )
}

/**
 * One entry. A place or a thing has its design picture at the head of its
 * page, and says where in the book it is; an idea is its words.
 * @param seen - the chapters that name it, in reading order.
 * @param derived - the weight those chapters give it, whatever the author set.
 */
function WorldEditor({ entry, seen, derived, onDeleted }: { entry: WorldEntry; seen: string[]; derived: WorldWeight; onDeleted: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [draft, setDraft] = useState<WorldEntry>(entry)
  const [dirty, setDirty] = useState(false)
  const [direction, setDirection] = useState('')
  const [viewing, setViewing] = useState(false)
  // Which picture is open large: its design art, or how it looks at one turn of its course.
  const [shown, setShown] = useState<string | undefined>()
  const [merging, setMerging] = useState(false)
  const { busy, run } = useAction()
  const assist = useAssist()
  const confirm = useConfirm()
  useEffect(() => { if (!dirty) setDraft(entry) }, [entry, dirty])
  const set = <K extends keyof WorldEntry>(key: K, value: WorldEntry[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const save = (): Promise<unknown> => run(async () => {
    await controller.api.call('world.save', { root, entry: { ...draft, summary: draft.summary ?? '', body: draft.body ?? '', visualPrompt: draft.visualPrompt ?? '', aliases: draft.aliases ?? [], tags: draft.tags ?? [], weight: draft.weight ?? ('' as never), ...(draft.events !== undefined ? { events: draft.events.filter(event => event.what.trim().length > 0).map(event => ({ ...event, what: event.what.trim() })) } : {}) } })
    setDirty(false)
    controller.toast('success', t('已保存', 'Saved'))
  })
  const group = groupOf(draft.category)
  // What can be drawn of it: a place as somewhere to stand, a thing as the thing itself, a house or an organisation as
  // the one picture that stands for it (asked for as a place is; drawn as what it is).
  const picture: 'location' | 'item' | undefined = draft.category === 'location' || draft.category === 'setting' ? 'location' : draft.category === 'item' ? 'item' : group === 'factions' ? 'location' : undefined
  const house = group === 'factions'
  const drawingJob = useRunningJob(job => job.kind === 'illustrate' && job.target === entry.id)
  const drawing = drawingJob !== undefined
  // Which turn of its course is being drawn, when it is one: the job says so in its title.
  const turning = drawingJob?.title.includes(' at ') === true ? drawingJob.title.slice(drawingJob.title.indexOf(' at ') + 4) : undefined
  // The director writing down how it looks: said on the button that asked, and while a drawing has it done first.
  const looking = useRunningJob(job => job.kind === 'bible' && job.target === entry.id && job.title.startsWith('look ')) !== undefined
  const draw = (): Promise<unknown> | undefined => (!controller.need('image') ? undefined : controller.guard(async () => {
    await controller.run('image.create', { root, kind: picture ?? 'location', target: entry.id })
    controller.toast('success', house ? t('设定图已生成', 'Design art ready') : picture === 'item' ? t('物品设定图已生成', 'Object art ready') : t('场景设定图已生成', 'Place art ready'))
  }))
  const drawTurn = (event: WorldEvent): Promise<unknown> | undefined => (!controller.need('image') ? undefined : controller.guard(async () => {
    await controller.run('image.create', { root, kind: picture ?? 'location', target: entry.id, event: `${event.chapter}:${event.kind}` })
    controller.toast('success', t('它这时的样子画好了', 'Drawn as it is then'))
  }))
  // From a picture's record to the words it was drawn from: this entry's own are on this page.
  const lookField = `nv-look-${entry.id}`
  const editLook = (of: LookOf): void => {
    if (of.kind === 'world' && of.id === entry.id) {
      const field = document.getElementById(lookField)
      field?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      field?.focus({ preventScroll: true })
    } else if (of.kind === 'world') controller.openWorld(of.id)
    else controller.openCharacter(of.id)
  }
  const index = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter.index])), [project.chapters, project.lines])
  const where = seen.map(id => index.get(id)).filter((value): value is number => value !== undefined)
  return (
    <div className="nv-editor-form">
      {picture !== undefined && draft.visualImage !== undefined ? (
        <button type="button" className={cx('nv-entry-picture', picture === 'item' && 'is-item')} onClick={() => { setShown(undefined); setViewing(true) }} title={t('点开看大图', 'Open it large')}>
          <ProjectImage path={draft.visualImage} alt={draft.name} />
        </button>
      ) : null}
      <header className="nv-detail-head nv-person-head">
        <div className="nv-person-title">
          <h2>{draft.name}<Chip tone="neutral">{t(...CATEGORY_LABELS[draft.category])}</Chip><LineTags lines={draft.lines} />{group !== 'ideas' ? <Chip tone={(draft.weight ?? derived) === 'core' ? 'green' : (draft.weight ?? derived) === 'major' ? 'blue' : 'neutral'}>{t(...WEIGHT_LABELS[draft.weight ?? derived])}</Chip> : null}{draft.importance === 1 ? <Chip tone="amber">{t('★ 随上下文', '★ In context')}</Chip> : null}</h2>
          {draft.summary !== undefined && draft.summary.length > 0 ? <p className="nv-person-tagline">{draft.summary}</p> : null}
          <span className="nv-muted nv-small">
            {where.length > 0
              ? t(`正文里 ${where.length} 章写到它：第 ${where.slice(0, 12).join('、')}${where.length > 12 ? ' …' : ''} 章`, `Named in ${where.length} chapters: ${where.slice(0, 12).join(', ')}${where.length > 12 ? '…' : ''}`)
              : t('正文里还没有写到它', 'Not named in the text yet')}
          </span>
        </div>
        <div className="nv-row">
          <Button variant="ghost" size="sm" icon="eye" onClick={() => { controller.openExplore({ type: 'world', id: entry.id }) }} title={t('在“观看 → 世界”里看它', 'See it under Watch → World')}>{t('观看', 'View')}</Button>
          {project.world.length > 1 ? <Button variant="ghost" size="sm" icon="branch" onClick={() => { setMerging(true) }} title={t('和另一条合并', 'Merge with another entry')}>{t('合并…', 'Merge…')}</Button> : null}
          <HistoryButton kind="world" id={entry.id} name={entry.name} onRestored={() => { setDirty(false) }} />
          <Button variant="ghost" size="sm" icon="trash" onClick={() => { confirm.ask(t(`删除设定「${entry.name}」？`, `Delete the entry "${entry.name}"?`), () => { void run(async () => { await controller.api.call('world.delete', { root, id: entry.id }); onDeleted() }) }) }} />
          <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
        </div>
      </header>
      {group !== 'ideas' ? <TiesBlock of={{ type: 'world', id: entry.id }} /> : null}
      {group !== 'ideas' ? (
        <CourseBlock
          events={draft.events ?? []}
          onChange={(events) => { set('events', events) }}
          {...(picture !== undefined ? { picture: (event: WorldEvent, change: (patch: Partial<WorldEvent>) => void) => (
            <span className="nv-course-picture">
              {event.image !== undefined ? (
                <>
                  <button type="button" className="nv-course-thumb" onClick={() => { setShown(event.image); setViewing(true) }} title={t('这时的样子——点开看大图', 'How it looks then — open it large')}><ProjectImage path={event.image} alt="" /></button>
                  <Button size="sm" variant="ghost" icon="x" onClick={() => { change({ image: undefined } as Partial<WorldEvent>) }} title={t('取下这张图', 'Take this picture off')} />
                </>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                icon="image"
                disabled={dirty || drawing || event.what.trim().length === 0}
                busy={turning === `${event.chapter}:${event.kind}`}
                pending={t('正在画…', 'Drawing…')}
                onClick={() => drawTurn(event)}
                title={dirty ? t('先保存当前修改', 'Save your edits first') : event.what.trim().length === 0 ? t('先写上发生了什么', 'Say what happened first') : t('画它在这件事之后的样子', 'Draw it as it is after this event')}
              >{event.image !== undefined ? t('重画', 'Redraw') : t('画这时的样子', 'Draw it then')}</Button>
            </span>
          ) } : {})}
        />
      ) : null}
      <div className="nv-assist">
        <TextInput value={direction} placeholder={t('想补全的方向', 'What to fill in')} onChange={(event) => { setDirection(event.target.value) }} />
        <Button icon="sparkles" busy={assist.running} pending={t('AI 正在补全…', 'Completing…')} disabled={dirty} onClick={() => { assist.start(async (onText) => { await controller.run('world.expand', { root, id: entry.id, ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, onText) }) }}>{t('AI 补全', 'Expand')}</Button>
      </div>
      {assist.stream.length > 0 ? <pre className="nv-stream">{assist.stream.slice(-800)}</pre> : null}
      <div className="nv-form-grid">
        <Field label={t('名称', 'Name')}><TextInput value={draft.name} onChange={(event) => { set('name', event.target.value) }} /></Field>
        <Field label={t('别名', 'Aliases')} hint={t('正文里对它的别的叫法；按这些名字数它在哪几章出现', 'Other names the text calls it by; chapters are counted by these too')}><TextInput value={(draft.aliases ?? []).join('、')} onChange={(event) => { set('aliases', event.target.value.split(/[、,，]+/).map(item => item.trim()).filter(Boolean)) }} /></Field>
        <Field label={t('类别', 'Category')}><Select value={draft.category} options={options(CATEGORY_LABELS, t)} onChange={(value) => { set('category', value) }} /></Field>
        <LinesField value={draft.lines} onChange={(lines) => { set('lines', lines) }} />
        {group !== 'ideas' ? (
          <Field label={t('在故事里的分量', 'Weight in the story')} hint={t('“自动”按正文里写到它的章数来定', 'Automatic goes by how many chapters write of it')}>
            <Select
              value={draft.weight ?? 'auto'}
              options={[{ value: 'auto' as const, label: t(`自动（现在：${WEIGHT_LABELS[derived][0]}）`, `Automatic (now: ${WEIGHT_LABELS[derived][1]})`) }, ...WORLD_WEIGHTS.map(weight => ({ value: weight, label: t(...WEIGHT_LABELS[weight]) }))]}
              onChange={(value) => {
                setDraft((previous) => {
                  const { weight: _old, ...rest } = previous
                  return value === 'auto' ? rest : { ...rest, weight: value }
                })
                setDirty(true)
              }}
            />
          </Field>
        ) : null}
        <Field label={t('怎么给模型', 'How it reaches a model')} hint={t('它的文字随不随每次请求发给模型。核心的最好不超过 6 条', 'Whether its text goes to the model with every request. Keep the core ones to six or fewer')}>
          <Select value={String(draft.importance) as '1' | '2' | '3'} options={[
            { value: '1', label: t('★ 核心（始终提供给模型）', '★ Core (always in context)') },
            { value: '2', label: t('常规（相关时提供）', 'Normal (when relevant)') },
            { value: '3', label: t('细节（按需检索）', 'Detail (on demand)') },
          ]} onChange={(value) => { set('importance', Number(value) as 1 | 2 | 3) }} />
        </Field>
      </div>
      <Field label={t('一句话概括', 'Summary')}><TextInput value={draft.summary ?? ''} onChange={(event) => { set('summary', event.target.value) }} /></Field>
      <Field label={t('详细设定', 'Details')}><TextArea value={draft.body ?? ''} minRows={8} maxRows={30} onChange={(event) => { set('body', event.target.value) }} /></Field>
      {picture !== undefined ? (
        <Field
          label={house ? t('它的样子', 'What it looks like') : picture === 'item' ? t('这件东西的样子', 'What the thing looks like') : t('场景视觉描述', 'Visual description')}
          hint={house
            ? t('看得见的样子：门庭、徽记旗号、它的人的衣着和排场。设定图照这段画。', 'What can be seen of it: its seat, its emblem and banner, how its people dress and gather. Its design art is drawn from this.')
            : picture === 'item'
              ? t('它实际的样子：形状、大小、材质、颜色、新旧。画到它的图都用这段。', 'How it really looks: shape, size, material, colour, wear. Every picture of it uses this.')
              : t('这个地方实际的样子：结构、材质、新旧、光线。画到这里的图都用这段。', 'How the place really looks: structure, materials, age, light. Every picture of it uses this.')}
        >
          <div className="nv-row">
            <TextArea id={lookField} value={draft.visualPrompt ?? ''} onChange={(event) => { set('visualPrompt', event.target.value) }} />
            <Button
              size="sm"
              icon="sparkles"
              disabled={dirty || looking}
              busy={looking}
              pending={t('导演在照正文写…', 'The director is writing…')}
              onClick={() => { void run(async () => { await controller.run('ai.worldLook', { root, id: entry.id, ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) }) }) }}
              title={dirty ? t('先保存当前修改', 'Save your edits first') : t('让导演照正文写出它的样子', 'Have the director write its look from the text')}
            >
              {(draft.visualPrompt ?? '').trim().length > 0 ? t('让导演重写', 'Have the director rewrite') : t('让导演照正文写', 'Have the director write it')}
            </Button>
            <Button size="sm" icon="image" disabled={dirty || drawing} busy={drawing && turning === undefined} pending={house ? t('正在画设定图…', 'Drawing it…') : picture === 'item' ? t('正在画物品设定图…', 'Drawing the object…') : t('正在画场景设定图…', 'Drawing the place…')} onClick={draw} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined}>
              {draft.visualImage !== undefined ? t('重画设定图', 'Redraw') : house ? t('画设定图', 'Draw its design art') : picture === 'item' ? t('画物品设定图', 'Draw the object') : t('画场景设定图', 'Draw the place')}
            </Button>
            {draft.visualImage !== undefined ? <DeletePicture bare path={draft.visualImage} disabled={dirty || drawing} /> : null}
          </div>
        </Field>
      ) : null}
      {picture !== undefined && draft.visualImage === undefined && (draft.weight ?? derived) === 'once'
        ? <p className="nv-muted nv-small">{picture === 'item' ? t('正文里只出现一次。', 'It appears once in the text.') : t('正文里只路过一次。', 'The text passes through it once.')}</p>
        : null}
      {merging ? <MergeDialog entry={entry} onClose={() => { setMerging(false) }} /> : null}
      {viewing && shown !== undefined ? (
        <PictureViewer
          path={shown}
          title={draft.name}
          note={t('它在这件事之后的样子。', 'How it looks after this event.')}
          onClose={() => { setViewing(false) }}
          onEditLook={editLook}
        />
      ) : viewing && draft.visualImage !== undefined ? (
        <PictureViewer
          path={draft.visualImage}
          title={draft.name}
          note={house ? t('这个家族 / 组织的设定图。', 'The design art of this house or organisation.') : picture === 'item' ? t('物品设定图，画到它的图以此为参考。', 'The thing\'s art: pictures showing it are drawn against this.') : t('场景设定图。发生在这里的画面会把它当参考图。', 'Place art. Pictures set here are drawn with it as a reference image.')}
          onClose={() => { setViewing(false) }}
          onEditLook={editLook}
        />
      ) : null}
      {confirm.element}
    </div>
  )
}

// ───────────────────────────── style ─────────────────────────────

function Styles() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const active = project.manifest.activeStyle
  const [selected, setSelected] = useState<string | undefined>(project.styles.find(style => style.id === active)?.id ?? project.styles[0]?.id)
  const [learning, setLearning] = useState(false)
  const [sample, setSample] = useState('')
  const [sampleName, setSampleName] = useState('')
  const assist = useAssist()
  const { busy, run } = useAction()
  const style = project.styles.find(candidate => candidate.id === selected)
  return (
    <div className="nv-split">
      <aside className="nv-split-list">
        <div className="nv-list-tools">
          <Button size="sm" icon="plus" onClick={() => run(async () => { const created = await controller.api.call('style.save', { root, style: { name: t('新文风', 'New style') } }); setSelected(created.id) })} busy={busy}>{t('新建', 'New')}</Button>
          <Button size="sm" icon="wand" onClick={() => { setLearning(true) }}>{t('从范文提炼', 'Learn from a sample')}</Button>
        </div>
        <ul className="nv-list">
          {project.styles.map(item => (
            <li key={item.id}>
              <button type="button" className={cx('nv-list-row', item.id === selected && 'is-active')} onClick={() => { setSelected(item.id) }}>
                <span className="nv-person-text">
                  <span className="nv-list-title">{item.name}</span>
                  <span className="nv-list-meta">{item.tone ?? ''}</span>
                </span>
                {item.id === active ? <Chip tone="green">{t('当前', 'Active')}</Chip> : null}
              </button>
            </li>
          ))}
        </ul>
        <RemovedCards kinds={['style']}>{count => t(`最近删除的文风 · ${count}`, `Deleted styles · ${count}`)}</RemovedCards>
      </aside>
      <section className="nv-split-detail">
        {style !== undefined ? <StyleEditor key={style.id} style={style} active={style.id === active} onDeleted={() => { setSelected(undefined) }} /> : <Empty icon="feather" title={t('选择或新建一个文风', 'Select or create a style')} />}
      </section>
      {learning ? (
        <Modal title={t('从范文提炼文风', 'Learn a style from a sample')} wide onClose={() => { setLearning(false) }} footer={(
          <Button variant="primary" busy={assist.running} pending={t('正在提炼文风…', 'Extracting the style…')} disabled={sample.trim().length < 80} onClick={() => {
            assist.start(async () => {
              const info = await controller.run('style.extract', { root, sample, ...(sampleName.trim().length > 0 ? { name: sampleName.trim() } : {}) })
              const id = (info.result?.output as { id?: string } | undefined)?.id
              if (id !== undefined) setSelected(id)
              setLearning(false)
              setSample('')
            })
          }}>{t('提炼', 'Learn')}</Button>
        )}>
          <Field label={t('文风名称', 'Style name')}><TextInput value={sampleName} placeholder={t('可留空', 'Optional')} onChange={(event) => { setSampleName(event.target.value) }} /></Field>
          <Field label={t('范文', 'Sample')} hint={t('贴几段想模仿的文字。只学写法，不学内容。', 'Paste passages to imitate. The manner is learnt, not the matter.')}>
            <TextArea value={sample} minRows={10} maxRows={22} onChange={(event) => { setSample(event.target.value) }} />
          </Field>
        </Modal>
      ) : null}
    </div>
  )
}

function StyleEditor({ style, active, onDeleted }: { style: StyleProfile; active: boolean; onDeleted: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const [draft, setDraft] = useState<StyleProfile>(style)
  const [dirty, setDirty] = useState(false)
  const [scene, setScene] = useState('')
  const [preview, setPreview] = useState('')
  const { busy, run } = useAction()
  const assist = useAssist()
  const confirm = useConfirm()
  useEffect(() => { if (!dirty) setDraft(style) }, [style, dirty])
  const set = <K extends keyof StyleProfile>(key: K, value: StyleProfile[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const text = (key: 'tone' | 'diction' | 'rhythm' | 'imagery' | 'dialogue' | 'pacing' | 'body') => ({ value: draft[key] ?? '', onChange: (event: { target: { value: string } }) => { set(key, event.target.value) } })
  const payload = useMemo(() => ({ ...draft, tone: draft.tone ?? '', diction: draft.diction ?? '', rhythm: draft.rhythm ?? '', imagery: draft.imagery ?? '', dialogue: draft.dialogue ?? '', pacing: draft.pacing ?? '', body: draft.body ?? '', rules: draft.rules ?? [], avoid: draft.avoid ?? [], exemplars: draft.exemplars ?? [] }), [draft])
  const save = (activate = false): Promise<unknown> => run(async () => {
    await controller.api.call('style.save', { root, style: payload, activate })
    setDirty(false)
    controller.toast('success', activate ? t('已设为当前文风', 'Now the active style') : t('已保存', 'Saved'))
  })
  return (
    <div className="nv-editor-form">
      <header className="nv-detail-head">
        <h2>{draft.name}{active ? <Chip tone="green">{t('当前文风', 'Active')}</Chip> : null}</h2>
        <div className="nv-row">
          <HistoryButton kind="style" id={style.id} name={style.name} onRestored={() => { setDirty(false) }} />
          {project.styles.length > 1 ? <Button variant="ghost" size="sm" icon="trash" onClick={() => { confirm.ask(t(`删除文风「${style.name}」？`, `Delete the style "${style.name}"?`), () => { void run(async () => { await controller.api.call('style.delete', { root, id: style.id }); onDeleted() }) }) }} /> : null}
          {!active ? <Button busy={busy} onClick={() => { save(true) }}>{t('设为当前文风', 'Make active')}</Button> : null}
          <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={!dirty} onClick={() => { save() }}>{t('保存', 'Save')}</Button>
        </div>
      </header>
      <div className="nv-form-grid">
        <Field label={t('名称', 'Name')}><TextInput value={draft.name} onChange={(event) => { set('name', event.target.value) }} /></Field>
        <Field label={t('叙事视角', 'Point of view')}>
          <Select value={draft.pov ?? 'third-limited'} options={options(POV_LABELS, t)} onChange={(value) => { set('pov', value) }} />
        </Field>
        <Field label={t('时态', 'Tense')}>
          <Select value={draft.tense ?? 'past'} options={[{ value: 'past', label: t('过去时', 'Past') }, { value: 'present', label: t('现在时', 'Present') }]} onChange={(value) => { set('tense', value) }} />
        </Field>
      </div>
      <Field label={t('基调', 'Tone')}><TextArea {...text('tone')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('用词', 'Diction')}><TextArea {...text('diction')} /></Field>
        <Field label={t('节奏', 'Rhythm')}><TextArea {...text('rhythm')} /></Field>
        <Field label={t('意象与修辞', 'Imagery')}><TextArea {...text('imagery')} /></Field>
        <Field label={t('对白', 'Dialogue')}><TextArea {...text('dialogue')} /></Field>
      </div>
      <Field label={t('推进方式', 'Pacing')}><TextArea {...text('pacing')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('必须做到', 'Always')} hint={t('每行一条', 'One per line')}><TextArea value={(draft.rules ?? []).join('\n')} minRows={4} onChange={(event) => { set('rules', lines(event.target.value)) }} /></Field>
        <Field label={t('必须避免', 'Never')} hint={t('禁用词、套路、"AI 味"', 'Banned words, clichés, machine tics')}><TextArea value={(draft.avoid ?? []).join('\n')} minRows={4} onChange={(event) => { set('avoid', lines(event.target.value)) }} /></Field>
      </div>
      <Field label={t('范文', 'Samples')} hint={t('用空行分隔多段；只用来体会笔触', 'Separate passages with a blank line; they show the touch only')}>
        <TextArea value={(draft.exemplars ?? []).map(item => item.text).join('\n\n')} minRows={4} maxRows={18} onChange={(event) => { set('exemplars', event.target.value.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean).map(item => ({ text: item }))) }} />
      </Field>
      <Field label={t('补充说明', 'Further notes')}><TextArea {...text('body')} /></Field>

      <SectionTitle>{t('试写', 'Try it')}</SectionTitle>
      <div className="nv-assist">
        <TextInput value={scene} placeholder={t('试写的场景（可留空）', 'A scene to try (optional)')} onChange={(event) => { setScene(event.target.value) }} />
        <Button icon="feather" busy={assist.running} pending={t('正在试写…', 'Writing a sample…')} onClick={() => {
          setPreview('')
          assist.start(async (onText) => {
            const info = await controller.run('style.sample', { root, draft: payload, ...(scene.trim().length > 0 ? { scene: scene.trim() } : {}) }, (streamed) => { onText(streamed); setPreview(streamed) })
            const final = (info.result?.output as { text?: string } | undefined)?.text
            if (final !== undefined) setPreview(final)
          })
        }}>{t('用这个文风写一段', 'Write a sample')}</Button>
      </div>
      {preview.length > 0 ? <div className="nv-prose nv-sample">{preview.split('\n').filter(line => line.trim().length > 0).map((line, index) => <p key={index}>{line}</p>)}</div> : <p className="nv-muted nv-small">{t('改完文风后试写一段，听听笔触对不对，再保存。', 'After editing, write a sample to hear whether the touch is right before saving.')}</p>}
      {confirm.element}
      <span hidden><Icon name="feather" /></span>
    </div>
  )
}

/** A character's further looks (outfits): each has its own design sheet, derived from the main one. */

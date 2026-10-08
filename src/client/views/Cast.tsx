// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The people of a book, on one page: everyone's card, where each of them is
 * in their life on the page, who has been away too long, who is planned
 * where, how they are tied together — and those the text names who have no
 * card. One filter above says who the page is about.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { layoutAround, layoutGraph, RELATION_KINDS, relationKind, type GraphNode, type RelationKind } from '../../shared/relations'
import type { CharacterCard, CharacterStatus, WalkOn } from '../../shared/types'
import { Icon } from '../icons'
import type { CastTab } from '../store'
import {
  Button, Chip, cx, Empty, Menu, SectionTitle, Select, Spinner, Tabs, useAction, useKept, useLoad, useProject, useQuote, useSnapshot, useStudio, useT, useMediaUrl,
} from '../ui'
import { byWeight, CastFilterBar, MAIN_ROLES, matchesCast, sortCast, useCastFilter } from '../CharacterPicker'
import { CardPhoto, CharacterCards, ROLE_LABELS, STATUS_LABELS, STATUS_TONES, type Lives } from './Characters'
import { statusAt, type Life } from '../../shared/life'
import { MAIN_LINE } from '../../shared/types'

const STATUSES: CharacterStatus[] = ['planned', 'active', 'offstage', 'retired', 'dead']
/** How many notes are shown before the rest fold away: what is said first is what matters most. */
const ADVICE_SHOWN = 6

interface Advice {
  tone: 'red' | 'amber' | 'blue'
  text: string
  character?: string
  /** Something that settles the note at once. */
  action?: { label: string; run: () => void }
}

export function CastView() {
  const { controller, locale } = useStudio()
  const t = useT()
  const quote = useQuote()
  const { project, root } = useProject()
  const tab: CastTab = useSnapshot(snapshot => snapshot.castTab) ?? 'cards'
  const setTab = (next: CastTab): void => { controller.setCastTab(next) }
  const { run } = useAction()
  const cards = useMemo(() => [...project.characters].sort(byWeight), [project.characters])
  // The board, the presence table and the ties are about the people chosen here; the notes above them weigh everybody.
  const [filter, setFilter] = useCastFilter('cast', project.characters)
  const chapterIndex = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter.index])), [project.chapters, project.lines])
  const shown = useMemo(() => sortCast(cards.filter(card => matchesCast(card, filter)), filter.sort, chapterIndex, locale), [cards, filter, chapterIndex, locale])
  const [allAdvice, setAllAdvice] = useState(false)
  const [adviceOpen, setAdviceOpen] = useState(false)
  // A life is read along one line of the plot: the main one, or one that parted from it.
  const plotLines = project.outline.lines ?? []
  const [wantedLine, setLine] = useKept<string>('cast.line', MAIN_LINE)
  const line = plotLines.some(candidate => candidate.id === wantedLine) ? wantedLine : MAIN_LINE
  const read = useLoad(async signal => await controller.api.call('cast.lives', { root, ...(line !== MAIN_LINE ? { line } : {}) }, signal), [root, line, project.revision])
  // Kept while a newer reading is on its way: a page that blinks on every save is no page to write on.
  const lastRead = useRef<{ line: string; data: NonNullable<typeof read.data> } | undefined>(undefined)
  if (read.data !== undefined) lastRead.current = { line, data: read.data }
  const lives: Lives | undefined = useMemo(() => {
    const kept = lastRead.current
    const data = read.data ?? (kept !== undefined && kept.line === line ? kept.data : undefined)
    if (data === undefined) return undefined
    const named = plotLines.find(candidate => candidate.id === line)
    return { ...data, ...(named !== undefined ? { line: { id: named.id, title: named.title } } : {}) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read.data, line])
  // The board as the labels on the cards have it — or as the story stood at a chapter of the line.
  const [moment, setMoment] = useState<number | undefined>()
  // How far the digests reach along the line: nothing is known of the story past the last chapter that was digested.
  const lastIndex = lives?.chapters.filter(chapter => chapter.digested).at(-1)?.index ?? 0
  const undigested = (lives?.chapters.length ?? 0) - (lives?.chapters.filter(chapter => chapter.digested).length ?? 0)
  const NO_LIFE: Life = { events: [], spans: [] }
  const standing = (card: CharacterCard): CharacterStatus => (moment !== undefined && lives !== undefined ? statusAt(lives.lives[card.id] ?? NO_LIFE, moment) : card.status)
  const presence = useMemo(() => new Map(project.presence.map(entry => [entry.character, entry])), [project.presence])
  const plans = useMemo(() => project.outline.volumes.flatMap(volume => volume.chapters), [project.outline])
  const info = useMemo(() => new Map(project.chapters.map(chapter => [chapter.id, chapter])), [project.chapters])

  const rest = (ids: string[]): void => {
    void run(async () => {
      for (const id of ids) await controller.api.call('character.save', { root, card: { id, status: 'offstage' } })
      controller.toast('success', t(`${ids.length} 个人物改成了"暂离"`, `${ids.length} characters are marked offstage`))
    })
  }
  const advice = useMemo((): Advice[] => {
    const urgent: Advice[] = []
    const away: Advice[] = []
    const notes: Advice[] = []
    const quiet: CharacterCard[] = []
    const unwritten = plans.filter(plan => info.get(plan.id)?.hasText !== true)
    for (const card of cards) {
      const seen = presence.get(card.id)
      const planned = unwritten.filter(plan => plan.characters?.includes(card.id) === true)
      const main = MAIN_ROLES.includes(card.role)
      // A plan that puts the dead on stage is wrong whoever they are.
      if ((card.status === 'dead' || card.status === 'retired') && planned.length > 0) {
        urgent.push({ tone: 'red', character: card.id, text: t(`${card.name}已${card.status === 'dead' ? '死亡' : '退场'}，但后面的章纲（第 ${planned.map(plan => info.get(plan.id)?.index).join('、')} 章）还安排了出场。`, `${card.name} is ${card.status}, yet planned chapters (${planned.map(plan => info.get(plan.id)?.index).join(', ')}) still cast them.`) })
      }
      if (card.status === 'active' && seen !== undefined && seen.chapters.length > 0 && seen.absentFor >= 5 && planned.length === 0) {
        // Somebody with a part who has gone missing is a question; a face in the crowd that is not seen again is how books are.
        if (main) away.push({ tone: 'amber', character: card.id, text: t(`${card.name}已 ${seen.absentFor} 章没有出场，后面的章纲里也没有安排。让他回来，或者把状态改为"暂离"。`, `${card.name} has been away for ${seen.absentFor} chapters and no planned chapter brings them back. Bring them back, or mark them offstage.`) })
        else quiet.push(card)
      }
      if (card.status === 'planned' && seen !== undefined && seen.chapters.length > 0 && main) {
        notes.push({ tone: 'blue', character: card.id, text: t(`${card.name}已经在正文中登场，状态还是"未登场"。`, `${card.name} already appears on the page but is still marked planned.`) })
      }
      if ((card.role === 'protagonist' || card.role === 'deuteragonist' || card.role === 'antagonist') && (card.motivation === undefined || card.arc === undefined)) {
        notes.push({ tone: 'blue', character: card.id, text: t(`${card.name}是主要人物，但还缺少${card.motivation === undefined ? '动机' : ''}${card.motivation === undefined && card.arc === undefined ? '和' : ''}${card.arc === undefined ? '弧光' : ''}。`, `${card.name} is a lead but has no ${[card.motivation === undefined ? 'motivation' : '', card.arc === undefined ? 'arc' : ''].filter(Boolean).join(' or ')} yet.`) })
      }
    }
    // A label that the text has overtaken: dead or gone on the page and not on the card, or the other way round.
    const gone = (status: CharacterStatus): boolean => status === 'dead' || status === 'retired'
    const stale = lives === undefined || line !== MAIN_LINE ? [] : cards.flatMap((card) => {
      const life = lives.lives[card.id]
      if (life === undefined || life.events.length === 0) return []
      const now = statusAt(life, lastIndex)
      return gone(now) !== gone(card.status) || (gone(now) && now !== card.status) ? [{ card, now, at: life.death ?? life.exit ?? life.last }] : []
    })
    if (stale.length > 0) {
      const names = stale.slice(0, 4).map(item => `${item.card.name}（${t(`第 ${item.at} 章${item.now === 'dead' ? '死亡' : item.now === 'retired' ? '离开' : '又出场了'}`, `ch. ${item.at}: ${item.now === 'dead' ? 'dies' : item.now === 'retired' ? 'leaves' : 'is back'}`)}）`).join(t('、', ', '))
      urgent.push({
        tone: 'amber',
        text: t(`${stale.length} 个人物卡上的生命周期标签和正文对不上：${names}${stale.length > 4 ? ' 等' : ''}。标签是手填的，履历是从各章收录读出来的。`, `The lifecycle label on ${stale.length} cards does not match the text: ${names}${stale.length > 4 ? '…' : ''}. A label is set by hand; a life is read off the chapter digests.`),
        action: { label: t(`按正文更新这 ${stale.length} 个标签`, `Set these ${stale.length} labels from the text`), run: () => {
          void run(async () => {
            for (const item of stale) await controller.api.call('character.save', { root, card: { id: item.card.id, status: item.now } })
            controller.toast('success', t(`${stale.length} 个标签已按正文更新`, `${stale.length} labels set from the text`))
          })
        } },
      })
    }
    const list = [...urgent, ...away]
    // How many the reader has to hold at once is about those with a part.
    const active = cards.filter(card => card.status === 'active' && MAIN_ROLES.includes(card.role))
    if (active.length > 14) list.push({ tone: 'amber', text: t(`同时活跃的主要人物和配角有 ${active.length} 个。读者很难同时记住这么多人——考虑让一部分暂离，分批登场。`, `${active.length} leads and supporting characters are active at once. Readers struggle to hold that many — rest some and bring them on in shifts.`) })
    list.push(...notes)
    if (quiet.length > 0) {
      const names = quiet.slice(0, 4).map(card => card.name).join(t('、', ', '))
      list.push({
        tone: 'blue',
        text: t(`另有 ${quiet.length} 个次要人物和龙套（${names}${quiet.length > 4 ? ' 等' : ''}）五章以上没有再出场。小人物来了又走是常事，不必逐个处理；想让"活跃"一栏只留真正在场的人，可以把他们一起改为"暂离"。`, `${quiet.length} minor characters and cameos (${names}${quiet.length > 4 ? ' and others' : ''}) have not been seen for five chapters or more. Small parts come and go, and none of them needs seeing to; to keep the "active" column for those who are in fact around, they can all be marked offstage together.`),
        action: { label: t(`${quiet.length} 人改为暂离`, `Mark ${quiet.length} offstage`), run: () => { rest(quiet.map(card => card.id)) } },
      })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, presence, plans, info, t, lives, line, lastIndex])

  // A book with nobody in it yet: the cards, where the first one is made — and the walk-ons, where people the text names wait for one.
  if (cards.length === 0) {
    return (
      <div className="nv-page nv-cast">
        <Tabs value={tab === 'walkons' ? 'walkons' : 'cards'} onChange={setTab} tabs={[
          { value: 'cards', label: t('人物卡', 'Cards'), icon: 'users' },
          { value: 'walkons', label: t('龙套', 'Walk-ons'), icon: 'users' },
        ]} />
        {tab === 'walkons' ? <WalkOns cards={cards} /> : <CharacterCards shown={[]} grouped searching={false} lives={lives} />}
      </div>
    )
  }

  const setStatus = (card: CharacterCard, status: CharacterStatus): void => {
    void run(async () => { await controller.api.call('character.save', { root, card: { id: card.id, status } }) })
  }

  return (
    <div className="nv-page nv-cast">
      {advice.length > 0 && tab === 'cards' && !adviceOpen ? (
        // Beside the cards the notes are one line: they are about the ensemble, and a card is being read or written here.
        <button type="button" className="nv-advice-line" onClick={() => { setAdviceOpen(true) }} title={t('展开调度提醒', 'Unfold the scheduling notes')}>
          <Icon name="alert" size={13} />
          <span>{t(`调度提醒 ${advice.length} 条`, `${advice.length} scheduling notes`)}</span>
          <span className="nv-muted">{advice[0]!.text}</span>
          <Icon name="chevronDown" size={12} />
        </button>
      ) : null}
      {advice.length > 0 && (tab !== 'cards' || adviceOpen) ? (
        <section className="nv-card">
          <SectionTitle actions={quote !== undefined ? (
            <Button size="sm" icon="quote" onClick={() => { quote(t(`请看一下群像调度的这些问题，给出调整方案：\n${advice.slice(0, 20).map(item => `- ${item.text}`).join('\n')}\n`, `Please look at these ensemble problems and propose how to fix them:\n${advice.slice(0, 20).map(item => `- ${item.text}`).join('\n')}\n`)) }}>{t('交给总编', 'Hand to the showrunner')}</Button>
          ) : tab === 'cards' ? <Button size="sm" variant="ghost" icon="chevronUp" onClick={() => { setAdviceOpen(false) }}>{t('收起', 'Fold')}</Button> : undefined}>{t('调度提醒', 'Scheduling notes')}</SectionTitle>
          <ul className="nv-advice">
            {(allAdvice ? advice : advice.slice(0, ADVICE_SHOWN)).map((item, index) => (
              <li key={index} className={`is-${item.tone}`}>
                <span>{item.text}</span>
                {item.action !== undefined ? <Button size="sm" onClick={item.action.run}>{item.action.label}</Button> : null}
              </li>
            ))}
          </ul>
          {advice.length > ADVICE_SHOWN ? (
            <Button size="sm" variant="ghost" icon={allAdvice ? 'chevronUp' : 'chevronDown'} onClick={() => { setAllAdvice(!allAdvice) }}>
              {allAdvice ? t('收起', 'Fold') : t(`还有 ${advice.length - ADVICE_SHOWN} 条`, `${advice.length - ADVICE_SHOWN} more`)}
            </Button>
          ) : null}
        </section>
      ) : null}

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'cards', label: t('人物卡', 'Cards'), icon: 'users', badge: cards.length },
        { value: 'board', label: t('生命周期', 'Lifecycle'), icon: 'layers' },
        { value: 'presence', label: t('出场分布', 'Presence'), icon: 'list' },
        { value: 'relations', label: t('关系', 'Relationships'), icon: 'link' },
        { value: 'walkons', label: t('龙套', 'Walk-ons'), icon: 'users' },
      ]} />

      {tab !== 'walkons' ? <CastFilterBar cards={cards} value={filter} onChange={setFilter} /> : null}

      {(tab === 'cards' || tab === 'board') && plotLines.length > 0 ? (
        <div className="nv-cast-line">
          <span className="nv-muted nv-small">{t('世界线', 'Line of the plot')}</span>
          <Select value={line} options={[{ value: MAIN_LINE, label: `★ ${t('主线', 'Main line')}` }, ...plotLines.map(candidate => ({ value: candidate.id, label: `${candidate.shelved === true ? '⏸ ' : ''}${candidate.title}` }))]} onChange={(value) => { setLine(value); setMoment(undefined) }} />
          <span className="nv-muted nv-small">{t('履历和"第几章时"都沿着这条线算：同一个人在这条线上死了，在另一条线上可以还活着。', 'A life, and where the story stood at a chapter, are read along this line: dead on one, somebody can be alive on another.')}</span>
        </div>
      ) : null}

      {tab === 'cards' ? <CharacterCards shown={shown} grouped={(filter.sort ?? 'weight') === 'weight'} searching={filter.query.trim().length > 0} lives={lives} /> : null}

      {tab === 'board' && lives !== undefined && lastIndex > 0 ? (
        <div className="nv-cast-moment">
          <div className="nv-seg" role="group">
            <button type="button" className={cx(moment === undefined && 'is-active')} onClick={() => { setMoment(undefined) }} title={t('人物卡上手填的生命周期标签', 'The lifecycle label set on each card')}>{t('卡上的标签', 'Labels on the cards')}</button>
            <button type="button" className={cx(moment !== undefined && 'is-active')} onClick={() => { setMoment(moment ?? lastIndex) }} title={t('从各章收录读出来：故事进行到某一章时，谁还没登场、谁在场、谁暂离、谁离开了、谁死了', 'Read off the chapter digests: at a chapter of the story, who is not on yet, who is present, away, gone, dead')}>{t('按故事进度', 'As the story stood')}</button>
          </div>
          {moment !== undefined ? (
            <>
              <input className="nv-range nv-cast-slider" type="range" min={1} max={lastIndex} step={1} value={moment} onChange={(event) => { setMoment(Number(event.target.value)) }} aria-label={t('故事进行到第几章', 'How far the story has come')} />
              <strong>{t(`第 ${moment} 章`, `Chapter ${moment}`)}</strong>
              <span className="nv-muted nv-small">{lives.chapters.find(chapter => chapter.index === moment)?.title ?? ''}</span>
            </>
          ) : null}
          {moment !== undefined && undigested > 0 ? <span className="nv-muted nv-small">{t(`（这条线收录到第 ${lastIndex} 章，还有 ${undigested} 章没有收录：没收录的章节里发生了什么，这里不知道）`, `(this line is digested up to chapter ${lastIndex}; ${undigested} chapters are not: what happens in those is not known here)`)}</span> : null}
        </div>
      ) : null}

      {tab === 'board' ? (
        <div className="nv-board">
          {STATUSES.map(status => (
            <section key={status} className="nv-board-column">
              <header><Chip tone={STATUS_TONES[status]}>{t(...STATUS_LABELS[status])}</Chip><span className="nv-muted nv-small">{shown.filter(card => standing(card) === status).length}</span></header>
              {shown.filter(card => standing(card) === status).map((card) => {
                const seen = presence.get(card.id)
                return (
                  <article key={card.id} className="nv-board-card">
                    <button type="button" className="nv-board-open" onClick={() => { controller.openCharacter(card.id) }} title={t(`打开「${card.name}」的人物卡`, `Open the card of ${card.name}`)}>
                      <CardPhoto card={card} className="nv-avatar" />
                      <span className="nv-person-text">
                        <span className="nv-list-title">{card.name}</span>
                        <span className="nv-list-meta">{t(...ROLE_LABELS[card.role])}{seen !== undefined && seen.chapters.length > 0 ? ` · ${t(`${seen.chapters.length} 章`, `${seen.chapters.length} ch.`)}${seen.absentFor > 0 ? t(`，离场 ${seen.absentFor}`, `, away ${seen.absentFor}`) : ''}` : ''}</span>
                      </span>
                    </button>
                    <Menu icon="more" align="end" items={[
                      { label: t('打开人物卡', 'Open the card'), icon: 'users', onSelect: () => { controller.openCharacter(card.id) } },
                      'separator',
                      ...STATUSES.filter(item => item !== status).map(item => ({ label: `→ ${t(...STATUS_LABELS[item])}`, onSelect: () => { setStatus(card, item) } })),
                    ]} />
                  </article>
                )
              })}
            </section>
          ))}
        </div>
      ) : null}

      {tab === 'presence' ? (
        plans.length === 0 ? <Empty icon="list" title={t('还没有章节', 'No chapters yet')} /> : (
          <div className="nv-presence">
            <table>
              <thead>
                <tr>
                  <th />
                  {plans.map((plan) => {
                    const chapter = info.get(plan.id)
                    return <th key={plan.id} title={plan.title}><button type="button" onClick={() => { controller.setView(chapter?.hasText === true ? 'read' : 'outline', plan.id) }}>{chapter?.index ?? ''}</button></th>
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.map((card) => {
                  const seen = new Set(presence.get(card.id)?.chapters ?? [])
                  return (
                    <tr key={card.id}>
                      <th><button type="button" className="nv-presence-name" onClick={() => { controller.openCharacter(card.id) }} title={t('打开人物卡', 'Open the card')}><span className={cx('nv-dot', `is-status-${card.status}`)} />{card.name}</button></th>
                      {plans.map((plan) => {
                        const written = info.get(plan.id)?.hasText === true
                        const on = seen.has(plan.id)
                        const planned = plan.characters?.includes(card.id) === true
                        return <td key={plan.id} className={cx(on && 'is-on', !on && planned && (written ? 'is-missed' : 'is-planned'), plan.pov === card.id && 'is-pov')} title={`${card.name} · ${plan.title}${on ? '' : planned ? (written ? t('（章纲安排了，正文没有出场）', ' (planned but absent from the text)') : t('（计划出场）', ' (planned)')) : ''}`} />
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="nv-muted nv-small nv-legend">
              <span className="nv-legend-cell is-on" />{t('已出场', 'On the page')}
              <span className="nv-legend-cell is-planned" />{t('计划出场', 'Planned')}
              <span className="nv-legend-cell is-missed" />{t('计划了但没出场', 'Planned but absent')}
              <span className="nv-legend-cell is-on is-pov" />{t('视角人物', 'Point of view')}
            </p>
          </div>
        )
      ) : null}

      {tab === 'relations' ? <Relations cards={shown} /> : null}
      {tab === 'walkons' ? <WalkOns cards={cards} /> : null}
    </div>
  )
}

/** How large somebody's mark is: by the weight of their part — large enough, for those who carry the story, to show a face in. */
const MARK: Record<CharacterCard['role'], number> = { protagonist: 17, deuteragonist: 14, antagonist: 14, supporting: 10.5, minor: 6.5, cameo: 5 }

const KIND_LABELS: Record<RelationKind, [string, string]> = {
  family: ['亲属', 'Family'],
  love: ['情感', 'Love'],
  service: ['主仆 / 上下', 'Service'],
  bond: ['师友 / 同盟', 'Friends and allies'],
  enmity: ['敌对', 'Enmity'],
  other: ['其他', 'Other'],
}

interface Box { x: number; y: number; width: number; height: number }

/**
 * Who is what to whom, as a picture. Laid out by the relations themselves —
 * people bound to one another stand together, a household gathers — with every
 * kind of bond in its own colour; and around one person when one is chosen:
 * them in the middle, theirs in a ring, each kind of bond in its own stretch.
 * The picture can be moved and enlarged; the list beside it says the same in words.
 */
function Relations({ cards }: { cards: CharacterCard[] }) {
  const { controller } = useStudio()
  const t = useT()
  const mediaUrl = useMediaUrl()
  const [focus, setFocus] = useState<string | undefined>()
  const edges = useMemo(() => {
    const byId = new Map(cards.map(card => [card.id, card]))
    const list: { from: string; to: string; word: string; kind: RelationKind; note?: string }[] = []
    for (const card of cards) {
      for (const relation of card.relationships ?? []) {
        if (!byId.has(relation.target) || relation.target === card.id) continue
        list.push({ from: card.id, to: relation.target, word: relation.kind, kind: relationKind(relation.kind), ...(relation.note !== undefined ? { note: relation.note } : {}) })
      }
    }
    return list
  }, [cards])
  const linked = useMemo(() => cards.filter(card => edges.some(edge => edge.from === card.id || edge.to === card.id)).sort(byWeight), [cards, edges])
  const nodes = useMemo((): GraphNode[] => linked.map(card => ({ id: card.id, radius: MARK[card.role], label: card.name.length })), [linked])
  const centred = focus !== undefined && linked.some(card => card.id === focus) ? focus : undefined
  const layout = useMemo(() => (centred !== undefined ? layoutAround(centred, nodes, edges) : { ...layoutGraph(nodes, edges), ring: undefined }), [centred, nodes, edges])

  // ── moving about on the picture: what is shown of it, changed by the wheel, by dragging, by the buttons ──
  const [view, setView] = useState<Box | undefined>()
  const frame = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; view: Box } | undefined>(undefined)
  // Another layout is another picture: it is shown whole.
  useEffect(() => { setView(undefined) }, [layout])
  const shown = view ?? layout.box
  const zoom = (factor: number, about?: { x: number; y: number }): void => {
    const centre = about ?? { x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 }
    const width = Math.min(layout.box.width * 4, Math.max(layout.box.width / 12, shown.width * factor))
    const scale = width / shown.width
    setView({ x: centre.x - (centre.x - shown.x) * scale, y: centre.y - (centre.y - shown.y) * scale, width, height: shown.height * scale })
  }
  const pointOf = (event: { clientX: number; clientY: number }): { x: number; y: number } | undefined => {
    const rect = frame.current?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0 || rect.height === 0) return undefined
    // The picture is fitted into its frame whole: one unit of it is the same number of pixels both ways.
    const unit = Math.max(shown.width / rect.width, shown.height / rect.height)
    return { x: shown.x + shown.width / 2 + (event.clientX - rect.left - rect.width / 2) * unit, y: shown.y + shown.height / 2 + (event.clientY - rect.top - rect.height / 2) * unit }
  }

  if (edges.length === 0) return <Empty icon="link" title={t('还没有人物关系', 'No relationships yet')}>{t('在人物卡的"关系"里添加；从稿件导入或收录章节时也会自动归并。', 'Add them under Relationships on a character card; importing a manuscript or digesting chapters fills them in too.')}</Empty>
  const nameOf = (id: string): string => cards.find(card => card.id === id)?.name ?? id
  const touches = (edge: { from: string; to: string }, id: string): boolean => edge.from === id || edge.to === id
  const listed = centred !== undefined ? edges.filter(edge => touches(edge, centred)) : edges
  const kinds = RELATION_KINDS.filter(kind => edges.some(edge => edge.kind === kind))
  return (
    <div className="nv-relations-view">
      <div className="nv-graph-frame">
        <svg
          ref={frame}
          className={cx('nv-graph', drag.current !== undefined && 'is-dragging')}
          viewBox={`${shown.x} ${shown.y} ${shown.width} ${shown.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={t('人物关系图', 'Relationship graph')}
          onWheel={(event) => { zoom(event.deltaY > 0 ? 1.15 : 1 / 1.15, pointOf(event)) }}
          onPointerDown={(event) => {
            if ((event.target as Element).closest('.nv-graph-node') !== null) return
            drag.current = { x: event.clientX, y: event.clientY, view: shown }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const from = drag.current
            const rect = frame.current?.getBoundingClientRect()
            if (from === undefined || rect === undefined || rect.width === 0) return
            const unit = Math.max(from.view.width / rect.width, from.view.height / rect.height)
            setView({ ...from.view, x: from.view.x - (event.clientX - from.x) * unit, y: from.view.y - (event.clientY - from.y) * unit })
          }}
          onPointerUp={() => { drag.current = undefined }}
          onPointerCancel={() => { drag.current = undefined }}
        >
          {edges.map((edge, index) => {
            const from = layout.at.get(edge.from)
            const to = layout.at.get(edge.to)
            if (from === undefined || to === undefined) return null
            const near = centred === undefined || touches(edge, centred)
            return (
              <g key={index} className={cx('nv-graph-edge', `is-${edge.kind}`, !near && 'is-dim')}>
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}><title>{`${nameOf(edge.from)} → ${nameOf(edge.to)}：${edge.word}`}</title></line>
                {/* Around one person, each bond says what it is — nearer the other end of it, where the lines have room. */}
                {centred !== undefined && near ? <text x={from.x + (to.x - from.x) * (edge.from === centred ? 0.62 : 0.38)} y={from.y + (to.y - from.y) * (edge.from === centred ? 0.62 : 0.38)} textAnchor="middle" dominantBaseline="central">{edge.word}</text> : null}
              </g>
            )
          })}
          {linked.map((card) => {
            const position = layout.at.get(card.id)
            if (position === undefined) return null
            const far = layout.ring?.get(card.id) === 2
            return (
              <g key={card.id} className={cx('nv-graph-node', `is-${card.role}`, far && 'is-far', centred === card.id && 'is-focus')} transform={`translate(${position.x} ${position.y})`} onClick={() => { setFocus(centred === card.id ? undefined : card.id) }}>
                <title>{t(`${card.name}：点一下以这个人为中心`, `${card.name}: click to put them in the middle`)}</title>
                <circle r={MARK[card.role]} />
                {/* Whoever has a face shows it: the mark is their portrait, in a ring of their part's colour. */}
                {card.visual?.portrait !== undefined ? <image className="nv-graph-face" href={mediaUrl(card.visual.portrait)} x={-MARK[card.role]} y={-MARK[card.role]} width={MARK[card.role] * 2} height={MARK[card.role] * 2} preserveAspectRatio="xMidYMin slice" /> : null}
                <text y={MARK[card.role] + 14} textAnchor="middle">{card.name}</text>
              </g>
            )
          })}
        </svg>
        <div className="nv-graph-tools">
          <Button size="sm" variant="ghost" onClick={() => { zoom(1 / 1.3) }} title={t('放大（也可以滚轮）', 'Enlarge (the wheel does it too)')}>＋</Button>
          <Button size="sm" variant="ghost" onClick={() => { zoom(1.3) }} title={t('缩小', 'Reduce')}>－</Button>
          <Button size="sm" variant="ghost" disabled={view === undefined} onClick={() => { setView(undefined) }} title={t('回到整张图', 'Back to the whole picture')}>{t('全图', 'Whole')}</Button>
        </div>
        <p className="nv-muted nv-small nv-graph-legend">
          {kinds.map(kind => <span key={kind} className={cx('nv-graph-key', `is-${kind}`)}><i />{t(...KIND_LABELS[kind])}</span>)}
          <span className="nv-graph-hint">{centred !== undefined
            ? t(`以「${nameOf(centred)}」为中心：内圈是和他直接有关系的人，按关系的种类排在一起；外圈是这些人各自牵出的人。`, `Around ${nameOf(centred)}: the inner ring is who they are bound to, each kind of bond together; beyond are those the ring leads to.`)
            : t('关系近的人站得近。点一个人，以他为中心重排；拖动空白处移动，滚轮缩放。', 'People bound to one another stand close. Click someone to arrange the picture around them; drag the empty part to move, the wheel to enlarge.')}</span>
        </p>
      </div>
      <ul className="nv-relation-list">
        {centred !== undefined ? (
          <li>
            <Button size="sm" icon="users" onClick={() => { controller.openCharacter(centred) }}>{t(`打开「${nameOf(centred)}」的人物卡`, `Open the card of ${nameOf(centred)}`)}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setFocus(undefined) }}>{t('回到全部人物', 'Back to everyone')}</Button>
          </li>
        ) : null}
        {listed.map((edge, index) => (
          <li key={index}>
            <button type="button" className="nv-link" onClick={() => { setFocus(edge.from) }}>{nameOf(edge.from)}</button>
            <span className={cx('nv-relation-kind', `is-${edge.kind}`)}>{edge.word}</span>
            <button type="button" className="nv-link" onClick={() => { setFocus(edge.to) }}>{nameOf(edge.to)}</button>
            {edge.note !== undefined ? <span className="nv-muted nv-small">{edge.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The people the page names who have no card. A long book collects dozens:
 * here they are listed with where they turn up, and settled one by one — a card
 * of their own, an alias of someone who has one, or nothing at all.
 */
function WalkOns({ cards }: { cards: CharacterCard[] }) {
  const { controller } = useStudio()
  const t = useT()
  const quote = useQuote()
  const { project, root } = useProject()
  const loaded = useLoad(signal => controller.api.call('cast.walkons', { root, ignored: true }, signal), [root, project.revision])
  const [showIgnored, setShowIgnored] = useState(false)
  const index = useMemo(() => new Map(project.chapters.map(chapter => [chapter.id, chapter.index])), [project.chapters])
  const light = cards.filter(card => card.role === 'minor' || card.role === 'cameo')
  if (loaded.data === undefined) {
    return <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不会整理龙套——重启一次 DSH 就有了。', 'This Studio service cannot list walk-ons yet — restart the Harness once.')}</p> : <Spinner />}</div>
  }
  const all = loaded.data.walkons
  const listed = all.filter(item => item.ignored !== true)
  const ignored = all.filter(item => item.ignored === true)
  const settle = (item: WalkOn, action: 'card' | 'alias' | 'ignore' | 'restore', extra: { target?: string; role?: 'minor' | 'cameo' } = {}): Promise<unknown> => controller.guard(async () => {
    const result = await controller.api.call('cast.settle', { root, name: item.name, action, ...extra })
    loaded.set({ walkons: result.walkons })
    if (action === 'card' && result.card !== undefined) controller.toast('success', t(`已为「${item.name}」立卡${result.lines > 0 ? `，有声脚本里的 ${result.lines} 句台词归到了这张卡` : ''}`, `Card created for ${item.name}${result.lines > 0 ? `; ${result.lines} script lines now belong to it` : ''}`))
    if (action === 'alias') controller.toast('success', t(`「${item.name}」已并入「${cards.find(card => card.id === extra.target)?.name ?? ''}」的别名`, `"${item.name}" is now an alias of ${cards.find(card => card.id === extra.target)?.name ?? ''}`))
  })
  const where = (item: WalkOn): string => {
    const numbers = item.chapters.map(id => index.get(id)).filter((value): value is number => value !== undefined)
    if (numbers.length === 0) return t('还没有收录到出场章节', 'no chapter on record yet')
    return t(`第 ${numbers.slice(0, 8).join('、')}${numbers.length > 8 ? ' …' : ''} 章`, `ch. ${numbers.slice(0, 8).join(', ')}${numbers.length > 8 ? ' …' : ''}`)
  }
  const row = (item: WalkOn) => {
    const near = item.near !== undefined ? cards.find(card => card.id === item.near) : undefined
    return (
      <li key={item.name} className={cx('nv-walkon', item.ignored === true && 'is-ignored')}>
        <div className="nv-walkon-main">
          <span className="nv-list-title">{item.name}</span>
          <span className="nv-list-meta">
            {where(item)}
            {item.lines > 0 ? t(` · 有声脚本里 ${item.lines} 句台词`, ` · ${item.lines} lines in audio scripts`) : ''}
          </span>
          {item.note !== undefined ? <span className="nv-walkon-note">{item.note}</span> : null}
          <span className="nv-row-wrap">
            {item.voice !== undefined ? <Chip tone="violet" title={t('有声剧里给这个名字定下的声音；立卡后跟着卡走', 'The voice the audio drama gave this name; it follows the card once there is one')}>{t('声音：', 'voice: ')}{item.voice.length > 18 ? `${item.voice.slice(0, 18)}…` : item.voice}</Chip> : null}
            {item.suggestion !== undefined ? <Chip tone="blue" title={t('收录记忆时，场记建议为他立卡', 'When memory was digested, continuity suggested a card for them')}>{t('场记的建议立卡', 'card suggested')}</Chip> : null}
            {near !== undefined ? <Chip tone="amber" onClick={() => { void settle(item, 'alias', { target: near.id }) }} title={t('点一下，把这个名字并入他的别名', 'Click to fold this name into their aliases')}>{t(`是「${near.name}」的另一个叫法？`, `Another name for ${near.name}?`)}</Chip> : null}
          </span>
        </div>
        {item.ignored === true ? (
          <Button size="sm" variant="ghost" icon="undo" pending={t('正在放回…', 'Putting back…')} onClick={() => settle(item, 'restore')}>{t('放回列表', 'Put back')}</Button>
        ) : (
          <div className="nv-row">
            <Menu label={t('立卡', 'Give a card')} icon="plus" variant="outline" align="end" items={[
              { label: t('作为小人物（有名有姓、偶尔出场）', 'As a minor character (named, now and then)'), onSelect: () => { void settle(item, 'card', { role: 'minor' }) } },
              { label: t('作为龙套（露一面就走）', 'As a cameo (seen once)'), onSelect: () => { void settle(item, 'card', { role: 'cameo' }) } },
            ]} />
            {cards.length > 0 ? (
              <Menu label={t('是别名', 'Alias of')} icon="link" align="end" items={[...(near !== undefined ? [near] : []), ...cards.filter(card => card.id !== near?.id)].slice(0, 30).map(card => ({ label: card.name, onSelect: () => { void settle(item, 'alias', { target: card.id }) } }))} />
            ) : null}
            <Button size="sm" variant="ghost" icon="x" pending={t('正在移出…', 'Removing…')} onClick={() => settle(item, 'ignore')} title={t('不是人物，或者不值得管：从列表里拿掉（随时可以放回）', 'Not a person, or not worth tracking: take it off the list (it can be put back)')} />
          </div>
        )}
      </li>
    )
  }
  return (
    <div className="nv-walkons">
      <section className="nv-card">
        <SectionTitle actions={quote !== undefined && listed.length > 0 ? (
          <Button size="sm" icon="quote" onClick={() => { quote(t(`这些名字在正文里出现了但还没有人物卡：${listed.slice(0, 20).map(item => item.name).join('、')}。请判断哪些值得立卡、哪些其实是已有人物的别名、哪些不用管，并替我处理。\n`, `These names are on the page without a character card: ${listed.slice(0, 20).map(item => item.name).join(', ')}. Decide which deserve a card, which are aliases of existing characters and which can be left alone, and settle them for me.\n`)) }}>{t('交给总编', 'Hand to the showrunner')}</Button>
        ) : undefined}>{t(`正文里有名字、还没立卡的人（${listed.length}）`, `Named on the page, no card yet (${listed.length})`)}</SectionTitle>
        <p className="nv-muted nv-small">{t('从章节记忆、场记的建议、有声脚本和声音表里汇总。路人甲不必人人立卡：值得跟踪的给一张卡，其实是某个人物另一个叫法的并成别名，其余放着不管也不影响写作。', 'Gathered from chapter memories, suggestions, audio scripts and the voice sheet. Not every passer-by needs a card: give one to those worth tracking, fold other names of an existing character into their aliases, and leave the rest.')}</p>
        {listed.length === 0 ? <Empty icon="users" title={t('没有漏掉的人', 'Nobody is missing a card')}>{t('写了新章节并收录记忆之后，新冒出来的名字会出现在这里。', 'New names show up here after new chapters are digested.')}</Empty> : <ul className="nv-walkon-list">{listed.map(row)}</ul>}
        {ignored.length > 0 ? (
          <>
            <button type="button" className="nv-group-head" aria-expanded={showIgnored} onClick={() => { setShowIgnored(value => !value) }}>
              <span>{t(`已移出的名字（${ignored.length}）`, `Taken off the list (${ignored.length})`)}</span>
            </button>
            {showIgnored ? <ul className="nv-walkon-list">{ignored.map(row)}</ul> : null}
          </>
        ) : null}
      </section>
      {light.length > 0 ? (
        <section className="nv-card">
          <SectionTitle>{t(`已经立卡的小人物与龙套（${light.length}）`, `Minor parts and cameos with a card (${light.length})`)}</SectionTitle>
          <ul className="nv-walkon-chips">
            {light.map(card => (
              <li key={card.id}>
                <button type="button" className="nv-walkon-chip" onClick={() => { controller.openCharacter(card.id) }} title={card.tagline ?? t('打开人物卡', 'Open the card')}>
                  <CardPhoto card={card} className="nv-avatar" />
                  <span>{card.name}</span>
                  <span className="nv-muted nv-small">{t(...ROLE_LABELS[card.role])}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

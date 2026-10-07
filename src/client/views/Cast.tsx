// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Ensemble view: where every character is in their life on the page, who has
 * been away too long, who is planned where, and how they are tied together.
 */
import { useMemo, useState } from 'react'
import type { CharacterCard, CharacterStatus, WalkOn } from '../../shared/types'
import type { CastTab } from '../store'
import {
  Button, Chip, cx, Empty, Menu, SectionTitle, Spinner, Tabs, useAction, useLoad, useProject, useQuote, useSnapshot, useStudio, useT,
} from '../ui'
import { CardPhoto, ROLE_LABELS, STATUS_LABELS, STATUS_TONES } from './Bible'

const STATUSES: CharacterStatus[] = ['planned', 'active', 'offstage', 'retired', 'dead']
const ROLE_ORDER = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']

interface Advice {
  tone: 'red' | 'amber' | 'blue'
  text: string
  character?: string
}

export function CastView() {
  const { controller } = useStudio()
  const t = useT()
  const quote = useQuote()
  const { project, root } = useProject()
  const tab: CastTab = useSnapshot(snapshot => snapshot.castTab) ?? 'board'
  const setTab = (next: CastTab): void => { controller.setCastTab(next) }
  const { run } = useAction()
  const cards = useMemo(() => [...project.characters].sort((left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role)), [project.characters])
  const presence = useMemo(() => new Map(project.presence.map(entry => [entry.character, entry])), [project.presence])
  const plans = useMemo(() => project.outline.volumes.flatMap(volume => volume.chapters), [project.outline])
  const info = useMemo(() => new Map(project.chapters.map(chapter => [chapter.id, chapter])), [project.chapters])

  const advice = useMemo((): Advice[] => {
    const list: Advice[] = []
    const unwritten = plans.filter(plan => info.get(plan.id)?.hasText !== true)
    for (const card of cards) {
      const seen = presence.get(card.id)
      const planned = unwritten.filter(plan => plan.characters?.includes(card.id) === true)
      if ((card.status === 'dead' || card.status === 'retired') && planned.length > 0) {
        list.push({ tone: 'red', character: card.id, text: t(`${card.name}已${card.status === 'dead' ? '死亡' : '退场'}，但后面的章纲（第 ${planned.map(plan => info.get(plan.id)?.index).join('、')} 章）还安排了出场。`, `${card.name} is ${card.status}, yet planned chapters (${planned.map(plan => info.get(plan.id)?.index).join(', ')}) still cast them.`) })
      }
      if (card.status === 'active' && seen !== undefined && seen.chapters.length > 0 && seen.absentFor >= 5 && planned.length === 0) {
        list.push({ tone: 'amber', character: card.id, text: t(`${card.name}已 ${seen.absentFor} 章没有出场，后面的章纲里也没有安排。让他回来，或者把状态改为"暂离"。`, `${card.name} has been away for ${seen.absentFor} chapters and no planned chapter brings them back. Bring them back, or mark them offstage.`) })
      }
      if (card.status === 'planned' && seen !== undefined && seen.chapters.length > 0) {
        list.push({ tone: 'blue', character: card.id, text: t(`${card.name}已经在正文中登场，状态还是"未登场"。`, `${card.name} already appears on the page but is still marked planned.`) })
      }
      if ((card.role === 'protagonist' || card.role === 'deuteragonist' || card.role === 'antagonist') && (card.motivation === undefined || card.arc === undefined)) {
        list.push({ tone: 'blue', character: card.id, text: t(`${card.name}是主要人物，但还缺少${card.motivation === undefined ? '动机' : ''}${card.motivation === undefined && card.arc === undefined ? '和' : ''}${card.arc === undefined ? '弧光' : ''}。`, `${card.name} is a lead but has no ${[card.motivation === undefined ? 'motivation' : '', card.arc === undefined ? 'arc' : ''].filter(Boolean).join(' or ')} yet.`) })
      }
    }
    const active = cards.filter(card => card.status === 'active')
    if (active.length > 14) list.push({ tone: 'amber', text: t(`同时活跃的人物有 ${active.length} 个。读者很难同时记住这么多人——考虑让一部分暂离，分批登场。`, `${active.length} characters are active at once. Readers struggle to hold that many — rest some and bring them on in shifts.`) })
    return list
  }, [cards, presence, plans, info, t])

  if (cards.length === 0) {
    return (
      <div className="nv-page">
        <Empty icon="layers" title={t('还没有人物', 'No characters yet')}>
          <Button variant="primary" icon="users" onClick={() => { controller.setView('bible') }}>{t('去设定', 'Open Bible')}</Button>
        </Empty>
      </div>
    )
  }

  const setStatus = (card: CharacterCard, status: CharacterStatus): void => {
    void run(async () => { await controller.api.call('character.save', { root, card: { id: card.id, status } }) })
  }

  return (
    <div className="nv-page nv-cast">
      {advice.length > 0 ? (
        <section className="nv-card">
          <SectionTitle actions={quote !== undefined ? (
            <Button size="sm" icon="quote" onClick={() => { quote(t(`请看一下群像调度的这些问题，给出调整方案：\n${advice.map(item => `- ${item.text}`).join('\n')}\n`, `Please look at these ensemble problems and propose how to fix them:\n${advice.map(item => `- ${item.text}`).join('\n')}\n`)) }}>{t('交给总编', 'Hand to the showrunner')}</Button>
          ) : undefined}>{t('调度提醒', 'Scheduling notes')}</SectionTitle>
          <ul className="nv-advice">
            {advice.map((item, index) => (
              <li key={index} className={`is-${item.tone}`}>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'board', label: t('生命周期', 'Lifecycle'), icon: 'layers' },
        { value: 'presence', label: t('出场分布', 'Presence'), icon: 'list' },
        { value: 'relations', label: t('关系', 'Relationships'), icon: 'link' },
        { value: 'walkons', label: t('龙套', 'Walk-ons'), icon: 'users' },
      ]} />

      {tab === 'board' ? (
        <div className="nv-board">
          {STATUSES.map(status => (
            <section key={status} className="nv-board-column">
              <header><Chip tone={STATUS_TONES[status]}>{t(...STATUS_LABELS[status])}</Chip><span className="nv-muted nv-small">{cards.filter(card => card.status === status).length}</span></header>
              {cards.filter(card => card.status === status).map((card) => {
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
                {cards.map((card) => {
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

      {tab === 'relations' ? <Relations cards={cards} /> : null}
      {tab === 'walkons' ? <WalkOns cards={cards} /> : null}
    </div>
  )
}

function Relations({ cards }: { cards: CharacterCard[] }) {
  const { controller } = useStudio()
  const t = useT()
  const [focus, setFocus] = useState<string | undefined>()
  const edges = useMemo(() => {
    const byId = new Map(cards.map(card => [card.id, card]))
    const list: { from: string; to: string; kind: string; note?: string }[] = []
    for (const card of cards) {
      for (const relation of card.relationships ?? []) {
        if (!byId.has(relation.target)) continue
        list.push({ from: card.id, to: relation.target, kind: relation.kind, ...(relation.note !== undefined ? { note: relation.note } : {}) })
      }
    }
    return list
  }, [cards])
  const linked = cards.filter(card => edges.some(edge => edge.from === card.id || edge.to === card.id))
  if (edges.length === 0) return <Empty icon="link" title={t('还没有人物关系', 'No relationships yet')}>{t('在人物卡的"关系"里添加；从稿件导入或收录章节时也会自动归并。', 'Add them under Relationships on a character card; import and digest also merge them in.')}</Empty>
  const size = 420
  const radius = size / 2 - 56
  const point = (index: number): { x: number; y: number } => {
    const angle = (index / linked.length) * Math.PI * 2 - Math.PI / 2
    return { x: size / 2 + radius * Math.cos(angle), y: size / 2 + radius * Math.sin(angle) }
  }
  const at = new Map(linked.map((card, index) => [card.id, point(index)]))
  const shown = focus !== undefined ? edges.filter(edge => edge.from === focus || edge.to === focus) : edges
  const nameOf = (id: string): string => cards.find(card => card.id === id)?.name ?? id
  return (
    <div className="nv-relations-view">
      <svg className="nv-graph" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('人物关系图', 'Relationship graph')}>
        {edges.map((edge, index) => {
          const from = at.get(edge.from)!
          const to = at.get(edge.to)!
          const active = focus === undefined || edge.from === focus || edge.to === focus
          return <line key={index} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={cx('nv-graph-edge', !active && 'is-dim')}><title>{`${nameOf(edge.from)} → ${nameOf(edge.to)}：${edge.kind}`}</title></line>
        })}
        {linked.map((card) => {
          const position = at.get(card.id)!
          const active = focus === undefined || focus === card.id || edges.some(edge => (edge.from === focus && edge.to === card.id) || (edge.to === focus && edge.from === card.id))
          return (
            <g key={card.id} className={cx('nv-graph-node', `is-${card.role}`, !active && 'is-dim', focus === card.id && 'is-focus')} transform={`translate(${position.x} ${position.y})`} onClick={() => { setFocus(focus === card.id ? undefined : card.id) }} onDoubleClick={() => { controller.openCharacter(card.id) }}>
              <circle r={card.role === 'protagonist' ? 11 : card.role === 'minor' || card.role === 'cameo' ? 6 : 8} />
              <text y={position.y < size / 2 ? -14 : 22} textAnchor="middle">{card.name}</text>
            </g>
          )
        })}
      </svg>
      <ul className="nv-relation-list">
        {shown.map((edge, index) => (
          <li key={index}>
            <button type="button" className="nv-link" onClick={() => { setFocus(edge.from) }}>{nameOf(edge.from)}</button>
            <span className="nv-relation-kind">{edge.kind}</span>
            <button type="button" className="nv-link" onClick={() => { setFocus(edge.to) }}>{nameOf(edge.to)}</button>
            {edge.note !== undefined ? <span className="nv-muted nv-small">{edge.note}</span> : null}
          </li>
        ))}
        {focus !== undefined ? (
          <li>
            <Button size="sm" icon="users" onClick={() => { controller.openCharacter(focus) }}>{t(`打开「${nameOf(focus)}」的人物卡`, `Open the card of ${nameOf(focus)}`)}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setFocus(undefined) }}>{t('显示全部', 'Show all')}</Button>
          </li>
        ) : null}
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
    return <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不会整理龙套——重启一次 Harness 就有了。', 'This Studio service cannot list walk-ons yet — restart the Harness once.')}</p> : <Spinner />}</div>
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
            {item.suggestion !== undefined ? <Chip tone="blue" title={t('收录记忆时，分析模型建议为他立卡', 'When memory was digested, the analyst suggested a card for them')}>{t('分析建议立卡', 'card suggested')}</Chip> : null}
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
        <p className="nv-muted nv-small">{t('从章节记忆、分析建议、有声脚本和声音表里汇总。路人甲不必人人立卡：值得跟踪的给一张卡，其实是某个人物另一个叫法的并成别名，其余放着不管也不影响写作。', 'Gathered from chapter memories, suggestions, audio scripts and the voice sheet. Not every passer-by needs a card: give one to those worth tracking, fold other names of an existing character into their aliases, and leave the rest.')}</p>
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

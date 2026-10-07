// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Ensemble view: where every character is in their life on the page, who has
 * been away too long, who is planned where, and how they are tied together.
 */
import { useMemo, useState } from 'react'
import type { CharacterCard, CharacterStatus } from '../../shared/types'
import {
  Button, Chip, cx, Empty, Menu, ProjectImage, SectionTitle, Tabs, useAction, useProject, useQuote, useStudio, useT,
} from '../ui'
import { ROLE_LABELS, STATUS_LABELS, STATUS_TONES } from './Bible'

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
  const [tab, setTab] = useState<'board' | 'presence' | 'relations'>('board')
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
                    {card.visual?.portrait !== undefined ? <ProjectImage className="nv-avatar" path={card.visual.portrait} alt={card.name} /> : <span className="nv-avatar nv-avatar-empty">{card.name.slice(0, 1)}</span>}
                    <div className="nv-person-text">
                      <span className="nv-list-title">{card.name}</span>
                      <span className="nv-list-meta">{t(...ROLE_LABELS[card.role])}{seen !== undefined && seen.chapters.length > 0 ? ` · ${t(`${seen.chapters.length} 章`, `${seen.chapters.length} ch.`)}${seen.absentFor > 0 ? t(`，离场 ${seen.absentFor}`, `, away ${seen.absentFor}`) : ''}` : ''}</span>
                    </div>
                    <Menu icon="more" align="end" items={[
                      ...STATUSES.filter(item => item !== status).map(item => ({ label: `→ ${t(...STATUS_LABELS[item])}`, onSelect: () => { setStatus(card, item) } })),
                      'separator',
                      { label: t('打开人物卡', 'Open the card'), icon: 'users', onSelect: () => { controller.setView('bible') } },
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
                      <th><span className={cx('nv-dot', `is-status-${card.status}`)} />{card.name}</th>
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
    </div>
  )
}

function Relations({ cards }: { cards: CharacterCard[] }) {
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
            <g key={card.id} className={cx('nv-graph-node', `is-${card.role}`, !active && 'is-dim', focus === card.id && 'is-focus')} transform={`translate(${position.x} ${position.y})`} onClick={() => { setFocus(focus === card.id ? undefined : card.id) }}>
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
        {focus !== undefined ? <li><Button size="sm" variant="ghost" onClick={() => { setFocus(undefined) }}>{t('显示全部', 'Show all')}</Button></li> : null}
      </ul>
    </div>
  )
}

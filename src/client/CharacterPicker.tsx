// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Who a screen is about. A long book has hundreds of people, and almost
 * nothing is meant for all of them at once: a batch of design sheets is for
 * the leads, a board of who is on stage is unreadable with every passer-by on
 * it. So wherever characters are listed or chosen, the same control narrows
 * them — by the weight of their part, and by name — and the same rule says who
 * is shown before anybody has touched it: in a large cast, those who carry the
 * story.
 *
 *   CastFilterBar     the control: a chip per kind of part, with how many there are, and a search box
 *   useCastFilter     its state, remembered per screen for as long as the Studio is open
 *   CharacterPicker   the control plus the list it narrows, with a tick per person
 */
import { useMemo } from 'react'
import { ROLE_ORDER, type CharacterCard, type CharacterRole } from '../shared/types'
import { Button, Chip, cx, TextInput, useKept, useProject, useStudio, useT } from './ui'
import { CardPhoto, ROLE_LABELS } from './views/Characters'

export { ROLE_ORDER }
/** Those who carry the story. */
export const MAIN_ROLES: readonly CharacterRole[] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting']
/** From how many people on a cast is "everyone" no longer what a screen should start with. */
const LARGE_CAST = 24

/** How a list of people is ordered: by the weight of the part (the default everywhere), by name, or by who came on the page first. */
export type CastSort = 'weight' | 'name' | 'debut'

export interface CastFilter {
  roles: CharacterRole[]
  query: string
  /** Left out: by weight. */
  sort?: CastSort
}

export const byWeight = (left: CharacterCard, right: CharacterCard): number => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role)

/**
 * A list of people in the order asked for. By weight is the order the cards
 * come in from the book — heaviest part first, the more present first within
 * one weight — so nothing is done to it but keeping the parts together.
 * @param chapterIndex - where each chapter stands in the book, for "who came first".
 */
export function sortCast(cards: readonly CharacterCard[], sort: CastSort | undefined, chapterIndex: ReadonlyMap<string, number>, locale: string): CharacterCard[] {
  if (sort === 'name') {
    const collator = new Intl.Collator(locale.toLowerCase().startsWith('zh') ? 'zh-Hans-u-co-pinyin' : locale)
    return [...cards].sort((left, right) => collator.compare(left.name, right.name))
  }
  if (sort === 'debut') {
    const at = (card: CharacterCard): number => (card.firstAppearance !== undefined ? chapterIndex.get(card.firstAppearance) : undefined) ?? Number.MAX_SAFE_INTEGER
    return [...cards].sort((left, right) => at(left) - at(right) || byWeight(left, right))
  }
  return [...cards].sort(byWeight)
}

/**
 * What a screen shows before anybody has chosen: everyone in a small cast, those who carry the story in a large one.
 * @param everyone - everyone, however large the cast: for the page that is the list of the book's people — it is
 *   ordered by their weight, and nobody is left off it unasked.
 */
export function defaultCastFilter(cards: readonly CharacterCard[], everyone = false): CastFilter {
  const present = ROLE_ORDER.filter(role => cards.some(card => card.role === role))
  const main = present.filter(role => MAIN_ROLES.includes(role))
  return { roles: !everyone && cards.length > LARGE_CAST && main.length > 0 ? main : present, query: '' }
}

export function matchesCast(card: CharacterCard, filter: CastFilter): boolean {
  if (!filter.roles.includes(card.role)) return false
  const query = filter.query.trim().toLowerCase()
  if (query.length === 0) return true
  return card.name.toLowerCase().includes(query) || card.aliases?.some(alias => alias.toLowerCase().includes(query)) === true || card.tagline?.toLowerCase().includes(query) === true
}

/**
 * The filter of one screen, kept while the Studio is open.
 * @param key - names the screen; two screens with the same key share their filter.
 * @param everyone - it starts with everyone listed, however many there are ({@link defaultCastFilter}).
 */
export function useCastFilter(key: string, cards: readonly CharacterCard[], everyone = false): [CastFilter, (next: CastFilter) => void] {
  const initial = useMemo(() => defaultCastFilter(cards, everyone), [cards, everyone])
  const [kept, setKept] = useKept<CastFilter | undefined>(`cast-filter.${key}`, undefined)
  // A part that has nobody in it any more is not something to be filtering by.
  const value = useMemo((): CastFilter => {
    if (kept === undefined) return initial
    const present = new Set(cards.map(card => card.role))
    return { ...kept, roles: kept.roles.filter(role => present.has(role)) }
  }, [kept, initial, cards])
  return [value, setKept]
}

export function CastFilterBar({ cards, value, onChange, className }: { cards: readonly CharacterCard[]; value: CastFilter; onChange: (next: CastFilter) => void; className?: string }) {
  const t = useT()
  const counts = useMemo(() => {
    const map = new Map<CharacterRole, number>()
    for (const card of cards) map.set(card.role, (map.get(card.role) ?? 0) + 1)
    return map
  }, [cards])
  const present = ROLE_ORDER.filter(role => (counts.get(role) ?? 0) > 0)
  // One kind of part, or nobody at all: nothing to narrow by.
  if (present.length <= 1 && cards.length <= 8) return null
  const toggle = (role: CharacterRole): void => {
    const on = value.roles.includes(role)
    onChange({ ...value, roles: on ? value.roles.filter(item => item !== role) : ROLE_ORDER.filter(item => item === role || value.roles.includes(item)) })
  }
  const main = present.filter(role => MAIN_ROLES.includes(role))
  const onlyMain = main.length > 0 && value.roles.length === main.length && main.every(role => value.roles.includes(role))
  const all = value.roles.length === present.length
  return (
    <div className={cx('nv-cast-filter', className)}>
      <div className="nv-cast-filter-roles" role="group" aria-label={t('按人物的分量筛选', 'Narrow by the weight of the part')}>
        {present.map(role => (
          <Chip key={role} tone={MAIN_ROLES.includes(role) ? 'blue' : 'neutral'} active={value.roles.includes(role)} onClick={() => { toggle(role) }} title={value.roles.includes(role) ? t('点一下不看这一类', 'Click to leave these out') : t('点一下把这一类也算上', 'Click to include these')}>
            {t(...ROLE_LABELS[role])} {counts.get(role)}
          </Chip>
        ))}
        {main.length > 0 && main.length < present.length ? (
          <Button size="sm" variant="ghost" className={cx(onlyMain && 'is-active')} onClick={() => { onChange({ ...value, roles: [...main] }) }} title={t('主角、第二主角、反派和配角：撑起故事的人', 'Protagonist, deuteragonist, antagonist and supporting parts: those who carry the story')}>{t('只看主要人物', 'Main parts only')}</Button>
        ) : null}
        {!all ? <Button size="sm" variant="ghost" onClick={() => { onChange({ ...value, roles: [...present] }) }}>{t('全部', 'Everyone')}</Button> : null}
      </div>
      {cards.length > 8 ? (
        <label className="nv-cast-filter-sort" title={t('列出人物的顺序', 'The order people are listed in')}>
          <span className="nv-muted nv-small">{t('排序', 'Order')}</span>
          <select value={value.sort ?? 'weight'} onChange={(event) => { const { sort: _old, ...rest } = value; onChange(event.target.value === 'weight' ? rest : { ...rest, sort: event.target.value as CastSort }) }}>
            <option value="weight">{t('按分量', 'By weight')}</option>
            <option value="debut">{t('按登场先后', 'By first appearance')}</option>
            <option value="name">{t('按名字', 'By name')}</option>
          </select>
        </label>
      ) : null}
      {cards.length > 8 ? <TextInput className="nv-cast-filter-search" value={value.query} placeholder={t('按名字找…', 'Find by name…')} onChange={(event) => { onChange({ ...value, query: event.target.value }) }} /> : null}
    </div>
  )
}

/**
 * Choose people: the filter, and under it the people it leaves, each with a tick.
 * What is ticked and what is shown are two things — narrowing the list unticks nobody.
 * @param note - a few words beside a person: what they have, what they lack.
 * @param unavailable - why a person cannot be chosen here, when they cannot.
 */
export function CharacterPicker({ cards, selected, onChange, filter, onFilter, note, unavailable, className }: {
  cards: readonly CharacterCard[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
  filter: CastFilter
  onFilter: (next: CastFilter) => void
  note?: (card: CharacterCard) => string | undefined
  unavailable?: (card: CharacterCard) => string | undefined
  className?: string
}) {
  const t = useT()
  const { locale } = useStudio()
  const { project } = useProject()
  const chapterIndex = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter.index])), [project.chapters, project.lines])
  const sorted = useMemo(() => sortCast(cards, filter.sort, chapterIndex, locale), [cards, filter.sort, chapterIndex, locale])
  const shown = sorted.filter(card => matchesCast(card, filter))
  const open = shown.filter(card => unavailable?.(card) === undefined)
  const ticked = open.filter(card => selected.has(card.id)).length
  const hidden = [...selected].filter(id => !shown.some(card => card.id === id)).length
  const set = (ids: string[], on: boolean): void => {
    const next = new Set(selected)
    for (const id of ids) {
      if (on) next.add(id)
      else next.delete(id)
    }
    onChange(next)
  }
  return (
    <div className={cx('nv-picker', className)}>
      <CastFilterBar cards={cards} value={filter} onChange={onFilter} />
      <div className="nv-picker-bar">
        <span className="nv-muted nv-small">
          {t(`列出 ${shown.length} 人，选中 ${ticked} 人`, `${shown.length} listed, ${ticked} chosen`)}
          {hidden > 0 ? t(`；另有 ${hidden} 人选中但没列在这里`, `; ${hidden} more are chosen and not listed here`) : ''}
        </span>
        <span className="nv-spacer" />
        <Button size="sm" variant="ghost" disabled={open.length === 0 || ticked === open.length} onClick={() => { set(open.map(card => card.id), true) }}>{t('选中列出的', 'Choose those listed')}</Button>
        <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => { onChange(new Set()) }}>{t('都不选', 'Choose nobody')}</Button>
      </div>
      <ul className="nv-picker-list">
        {shown.map((card) => {
          const why = unavailable?.(card)
          const words = note?.(card)
          return (
            <li key={card.id}>
              <label className={cx('nv-picker-row', why !== undefined && 'is-off')} title={why}>
                <input type="checkbox" checked={why === undefined && selected.has(card.id)} disabled={why !== undefined} onChange={(event) => { set([card.id], event.target.checked) }} />
                <CardPhoto card={card} className="nv-avatar" />
                <span className="nv-person-text">
                  <span className="nv-list-title">{card.name}</span>
                  <span className="nv-list-meta">{t(...ROLE_LABELS[card.role])}{why !== undefined ? ` · ${why}` : words !== undefined ? ` · ${words}` : ''}</span>
                </span>
              </label>
            </li>
          )
        })}
        {shown.length === 0 ? <li className="nv-muted nv-small nv-picker-empty">{t('没有符合的人物。', 'Nobody matches.')}</li> : null}
      </ul>
    </div>
  )
}

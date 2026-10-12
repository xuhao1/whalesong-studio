// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The people of a book, on one page: everyone's card, everyone's life chapter
 * by chapter along a line of the plot, how they are tied together — and those
 * the text names who have no card. One filter above says who the page is
 * about; the notes on the ensemble sit above it all, as large as the author
 * wants them: whole, one line, or out of the way.
 */
import { LinePickBar, useLinePicks } from '../LinesField'
import { useEffect, useMemo, useRef, useState } from 'react'
import { layoutAround, layoutGraph, RELATION_KINDS, relationKind, type GraphNode, type Point, type RelationKind } from '../../shared/relations'
import type { ChapterInfo, ChapterPlan, CharacterCard, WalkOn } from '../../shared/types'
import { Icon } from '../icons'
import type { CastTab } from '../store'
import {
  Button, Chip, cx, Empty, Menu, SectionTitle, Select, Spinner, Tabs, useBookLine, useKept, useLoad, useProject, useQuote, useRunningJob, useSnapshot, useStudio, useT, useMediaUrl,
} from '../ui'
import { byWeight, CastFilterBar, MAIN_ROLES, matchesCast, sortCast, useCastFilter } from '../CharacterPicker'
import { CardPhoto, CharacterCards, LIFE_MARK, ROLE_LABELS, type Lives } from './Characters'
import { lifeLine, LIFE_AWAY, type Life } from '../../shared/life'
import { MAIN_LINE, ofLine } from '../../shared/types'
import { useBookActions } from '../actions'

/** How many notes are shown before the rest fold away: what is said first is what matters most. */
const ADVICE_SHOWN = 6

interface Advice {
  tone: 'red' | 'amber' | 'blue'
  text: string
  character?: string
}

/** How much room the notes on the ensemble take: all of them, one line, or none — a small mark by the tabs brings them back. */
type NotesMode = 'open' | 'line' | 'hidden'
const NOTES_KEY = 'novel-studio:cast-notes'

function storedNotes(): NotesMode {
  try {
    const raw = localStorage.getItem(NOTES_KEY)
    return raw === 'open' || raw === 'hidden' ? raw : 'line'
  } catch {
    return 'line'
  }
}

/** The choice of no line in particular, where the people page asks which line. */
const EVERY_LINE = '*'

export function CastView() {
  const { controller, locale } = useStudio()
  const t = useT()
  const quote = useQuote()
  const { project, root } = useProject()
  const tab: CastTab = useSnapshot(snapshot => snapshot.castTab) ?? 'cards'
  const setTab = (next: CastTab): void => { controller.setCastTab(next) }
  const cards = useMemo(() => [...project.characters].sort(byWeight), [project.characters])
  // The cards, the table of lives and the ties are about the people chosen here; the notes above them weigh everybody.
  // Everyone the book has, in the order of their weight: the page narrows only when the author asks it to.
  const [filter, setFilter] = useCastFilter('cast', project.characters, true)
  const chapterIndex = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter.index])), [project.chapters, project.lines])
  const [allAdvice, setAllAdvice] = useState(false)
  const [notes, setNotesMode] = useState<NotesMode>(storedNotes)
  const setNotes = (next: NotesMode): void => {
    setNotesMode(next)
    try { localStorage.setItem(NOTES_KEY, next) } catch { /* private windows keep it for this visit only */ }
  }
  // A life is read along one line of the plot: the main one, or one that parted from it.
  const plotLines = project.outline.lines ?? []
  // The line in hand, as on every page. Every line at once is this page's own choice beside it: then nobody is left
  // out, and lives are read along the line in hand.
  const [bookLine, setBookLine] = useBookLine()
  const [everyone, setEveryone] = useKept<boolean>('cast.everyone', false)
  const picks = useLinePicks()
  const chosen = everyone && plotLines.length > 0 ? EVERY_LINE : bookLine
  const line = bookLine
  const setLine = (next: string): void => {
    setEveryone(next === EVERY_LINE)
    if (next !== EVERY_LINE) setBookLine(next)
  }
  // A world may hold several stories: the people listed are the chosen line's — said so on their card, or seen in its
  // chapters; somebody no chapter has yet is everybody's. (A Host from before answers with an error: then all are listed.)
  const seen = useLoad(async signal => (plotLines.length > 0 ? await controller.api.call('lines.seen', { root }, signal).catch(() => undefined) : undefined), [root, project.revision])
  const lastSeen = useRef<Record<string, string[]> | undefined>(undefined)
  if (seen.data !== undefined) lastSeen.current = seen.data.people
  const seenOn = seen.data?.people ?? lastSeen.current
  const here = useMemo(() => (plotLines.length === 0 || chosen === EVERY_LINE || seenOn === undefined ? cards : cards.filter(card => ofLine(card, chosen, seenOn[card.id]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cards, chosen, seenOn, plotLines.length])
  // Of those listed on a line: the ones no chapter has yet, who are every line's until one writes them.
  const unplaced = seenOn === undefined ? 0 : here.filter(card => (card.lines ?? []).length === 0 && (seenOn[card.id] ?? []).length === 0).length
  const peopleOf = (id: string): number => (seenOn === undefined ? cards.length : cards.filter(card => ofLine(card, id, seenOn[card.id])).length)
  const shown = useMemo(() => sortCast(here.filter(card => matchesCast(card, filter)), filter.sort, chapterIndex, locale), [here, filter, chapterIndex, locale])
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
  const presence = useMemo(() => new Map(project.presence.map(entry => [entry.character, entry])), [project.presence])
  const plans = useMemo(() => project.outline.volumes.flatMap(volume => volume.chapters), [project.outline])
  const info = useMemo(() => new Map(project.chapters.map(chapter => [chapter.id, chapter])), [project.chapters])

  // What the main line's plan and its digests say that the author may want to see to. Nothing here is about a word on a
  // card: who is dead, gone or away is what the digests tell.
  const advice = useMemo((): Advice[] => {
    const urgent: Advice[] = []
    const away: Advice[] = []
    const lacking: Advice[] = []
    const unwritten = plans.filter(plan => info.get(plan.id)?.hasText !== true)
    for (const card of cards) {
      const seen = presence.get(card.id)
      const gone = seen?.death ?? seen?.exit
      const planned = unwritten.filter(plan => plan.characters?.includes(card.id) === true)
      // A plan that puts the dead on stage is wrong whoever they are.
      const after = gone === undefined ? [] : planned.filter(plan => (info.get(plan.id)?.index ?? 0) > gone)
      if (gone !== undefined && after.length > 0) {
        urgent.push({ tone: 'red', character: card.id, text: t(`${card.name}${gone === 0 ? '在故事开始之前' : `在第 ${gone} 章`}已经${seen?.death !== undefined ? '死亡' : '离开故事'}，但后面的章纲（第 ${after.map(plan => info.get(plan.id)?.index).join('、')} 章）还安排了出场。`, `${card.name} ${gone === 0 ? (seen?.death !== undefined ? 'is dead before the story begins' : 'is gone before the story begins') : `${seen?.death !== undefined ? 'dies' : 'leaves the story'} in chapter ${gone}`}, yet planned chapters (${after.map(plan => info.get(plan.id)?.index).join(', ')}) still cast them.`) })
      }
      // Somebody with a part who has gone missing is a question; a face in the crowd that is not seen again is how books are.
      if (gone === undefined && seen !== undefined && seen.chapters.length > 0 && seen.absentFor >= LIFE_AWAY && planned.length === 0 && MAIN_ROLES.includes(card.role)) {
        away.push({ tone: 'amber', character: card.id, text: t(`${card.name}已 ${seen.absentFor} 章没有出场，后面的章纲里也没有安排。`, `${card.name} has not appeared for ${seen.absentFor} chapters, and no outline ahead brings them back.`) })
      }
      if ((card.role === 'protagonist' || card.role === 'deuteragonist' || card.role === 'antagonist') && (card.motivation === undefined || card.arc === undefined)) {
        lacking.push({ tone: 'blue', character: card.id, text: t(`${card.name}是主要人物，但还缺少${card.motivation === undefined ? '动机' : ''}${card.motivation === undefined && card.arc === undefined ? '和' : ''}${card.arc === undefined ? '弧光' : ''}。`, `${card.name} is a lead but has no ${[card.motivation === undefined ? 'motivation' : '', card.arc === undefined ? 'arc' : ''].filter(Boolean).join(' or ')} yet.`) })
      }
    }
    const list = [...urgent, ...away]
    // How many the reader has to hold at once is about those with a part who are on the page these chapters.
    const around = cards.filter((card) => {
      const seen = presence.get(card.id)
      return MAIN_ROLES.includes(card.role) && seen !== undefined && seen.chapters.length > 0 && seen.death === undefined && seen.exit === undefined && seen.absentFor < LIFE_AWAY
    })
    if (around.length > 14) list.push({ tone: 'amber', text: t(`最近几章里同时在场的主要人物和配角有 ${around.length} 个，读者很难同时记住。`, `${around.length} leading and supporting characters have been on stage together lately — more than a reader keeps in mind.`) })
    list.push(...lacking)
    return list
  }, [cards, presence, plans, info, t])

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

  const hide = (
    <Button size="sm" variant="ghost" icon="x" onClick={() => { setNotes('hidden') }} title={t('隐藏调度提醒：页签那一行的右边留一个小标记，点它再打开', 'Put the notes out of the way: a small mark at the end of the tabs brings them back')}>{t('隐藏', 'Hide')}</Button>
  )

  return (
    <div className="nv-page nv-cast">
      {advice.length > 0 && notes === 'line' ? (
        // One line by default: the notes are about the ensemble, and whatever is below is being read or written.
        <div className="nv-advice-bar">
          <button type="button" className="nv-advice-line" onClick={() => { setNotes('open') }} title={t('展开调度提醒', 'Unfold the scheduling notes')}>
            <Icon name="alert" size={13} />
            <span>{t(`调度提醒 ${advice.length} 条`, `${advice.length} scheduling notes`)}</span>
            <span className="nv-muted">{advice[0]!.text}</span>
            <Icon name="chevronDown" size={12} />
          </button>
          {hide}
        </div>
      ) : null}
      {advice.length > 0 && notes === 'open' ? (
        <section className="nv-card">
          <SectionTitle actions={(
            <>
              {quote !== undefined ? <Button size="sm" icon="quote" onClick={() => { quote(t(`请看一下群像调度的这些问题，给出调整方案：\n${advice.slice(0, 20).map(item => `- ${item.text}`).join('\n')}\n`, `Please look at these ensemble problems and propose how to fix them:\n${advice.slice(0, 20).map(item => `- ${item.text}`).join('\n')}\n`)) }}>{t('交给总编', 'Hand to the showrunner')}</Button> : null}
              <Button size="sm" variant="ghost" icon="chevronUp" onClick={() => { setNotes('line') }} title={t('收成一行', 'Fold to one line')}>{t('收起', 'Fold')}</Button>
              {hide}
            </>
          )}>{t('调度提醒', 'Scheduling notes')}</SectionTitle>
          <ul className="nv-advice">
            {(allAdvice ? advice : advice.slice(0, ADVICE_SHOWN)).map((item, index) => (
              <li key={index} className={`is-${item.tone}`}>
                <span>{item.text}</span>
                {item.character !== undefined ? <Button size="sm" variant="ghost" onClick={() => { controller.openCharacter(item.character!) }}>{t('打开人物卡', 'Open the card')}</Button> : null}
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

      <div className="nv-cast-tabs">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'cards', label: t('人物卡', 'Cards'), icon: 'users', badge: here.length },
          { value: 'lives', label: t('履历表', 'Lives'), icon: 'list' },
          { value: 'relations', label: t('关系', 'Relationships'), icon: 'link' },
          { value: 'walkons', label: t('龙套', 'Walk-ons'), icon: 'users' },
        ]} />
        {advice.length > 0 && notes === 'hidden' ? (
          <button type="button" className="nv-advice-mark" onClick={() => { setNotes('open') }} title={t(`调度提醒 ${advice.length} 条`, `${advice.length} casting note(s)`)}>
            <Icon name="alert" size={12} /><span>{advice.length}</span>
          </button>
        ) : null}
      </div>

      {tab !== 'walkons' ? <CastFilterBar cards={here} value={filter} onChange={setFilter} /> : null}

      {tab !== 'walkons' && plotLines.length > 0 ? (
        <div className="nv-cast-line">
          <span className="nv-muted nv-small">{t('世界线', 'Line of the plot')}</span>
          <Select value={chosen} options={[
            { value: MAIN_LINE, label: `★ ${t('主线', 'Main line')}${t(`（${peopleOf(MAIN_LINE)} 人）`, ` (${peopleOf(MAIN_LINE)})`)}` },
            ...plotLines.map(candidate => ({ value: candidate.id, label: `${candidate.shelved === true ? '⏸ ' : ''}${candidate.title}${t(`（${peopleOf(candidate.id)} 人）`, ` (${peopleOf(candidate.id)})`)}` })),
            { value: EVERY_LINE, label: t(`所有线（${cards.length} 人）`, `Every line (${cards.length})`) },
          ]} onChange={setLine} />
          {chosen !== EVERY_LINE && here.length < cards.length ? <span className="nv-muted nv-small">{t(`另有 ${cards.length - here.length} 人只在别的线上`, `${cards.length - here.length} more are of other lines only`)}</span> : null}
          {chosen !== EVERY_LINE && unplaced > 0 ? <span className="nv-muted nv-small" title={t('卡上没写属于哪条线，哪一章也还没有他：每条线都列着，写到谁就是谁的', 'No line named on the card and no chapter has them yet: listed on every line, and a line\'s once it writes them')}>{t(`其中 ${unplaced} 人还没出场`, `${unplaced} of these are in no chapter yet`)}</span> : null}
          {tab === 'cards' && !picks.on ? <LinePickBar picks={picks} listed={shown.map(card => card.id)} kind="characters" /> : null}
        </div>
      ) : null}
      {tab === 'cards' && plotLines.length === 0 && !picks.on && shown.length > 1 ? <div className="nv-cast-line"><span className="nv-spacer" /><LinePickBar picks={picks} listed={shown.map(card => card.id)} kind="characters" /></div> : null}
      {tab === 'cards' && picks.on ? <LinePickBar picks={picks} listed={shown.map(card => card.id)} kind="characters" /> : null}

      {tab === 'cards' ? <CharacterCards shown={shown} grouped={(filter.sort ?? 'weight') === 'weight'} searching={filter.query.trim().length > 0} lives={lives} picks={picks} /> : null}

      {tab === 'lives' ? (
        lives !== undefined ? <LifeTable shown={shown} lives={lives} />
          : <div className="nv-center">{read.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊后台还读不出履历——点顶上的"重启"就有了。', 'This Studio service cannot read lives yet — restart it from the banner above.')}</p> : <Spinner />}</div>
      ) : null}

      {tab === 'relations' ? <Relations cards={shown} /> : null}
      {tab === 'walkons' ? <WalkOns cards={cards} /> : null}
    </div>
  )
}

/**
 * Everyone's life in one table, along one line of the plot: a row a person, a
 * column a chapter of the line. A filled cell is a chapter they are in — green
 * where they come on or come back, amber where they leave, red where they die
 * —, a pale one a chapter the outline casts them in; under each name their
 * life in a line of words. Nothing in it is a state somebody "is in": it is
 * what happened where, and on another line it reads otherwise.
 */
function LifeTable({ shown, lives }: { shown: CharacterCard[]; lives: Lives }) {
  const { controller } = useStudio()
  const t = useT()
  const { project } = useProject()
  // What the outline plans for each chapter of the line, and whether it is written: the line's own chapters and those it shares.
  const planOf = useMemo(() => new Map<string, ChapterPlan>([...project.outline.volumes.flatMap(volume => volume.chapters), ...(project.outline.lines ?? []).flatMap(line => line.chapters)].map(plan => [plan.id, plan])), [project.outline])
  const infoOf = useMemo(() => new Map<string, ChapterInfo>([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter])), [project.chapters, project.lines])
  const digested = lives.chapters.filter(chapter => chapter.digested).length
  if (lives.chapters.length === 0) return <Empty icon="list" title={t('这条线上还没有章节', 'No chapters on this line yet')} />
  const NOBODY: Life = { events: [], spans: [] }
  return (
    <div className="nv-presence nv-lives">
      {digested < lives.chapters.length ? (
        <p className="nv-muted nv-small nv-lives-note">{digested === 0
          ? t('这条线上还没有收录过的章节。', 'No chapter of this line is digested yet.')
          : t(`这条线已收录 ${digested} / ${lives.chapters.length} 章。`, `${digested} of this line's ${lives.chapters.length} chapters are digested.`)}</p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th />
            {lives.chapters.map(chapter => (
              <th key={chapter.id} title={chapter.title}><button type="button" onClick={() => { controller.setView(infoOf.get(chapter.id)?.hasText === true ? 'read' : 'outline', chapter.id) }}>{chapter.index}</button></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((card) => {
            const life = lives.lives[card.id] ?? NOBODY
            const at = new Map(life.events.map(event => [event.index, event]))
            const told = lifeLine(life, true) !== undefined ? t(lifeLine(life, true)!, lifeLine(life, false)!) : digested > 0 ? t('收录过的章节里没有他', 'in no digested chapter') : ''
            return (
              <tr key={card.id}>
                <th>
                  <button type="button" className="nv-lives-who" onClick={() => { controller.openCharacter(card.id) }} title={[t(`打开「${card.name}」的人物卡`, `Open the card of ${card.name}`), card.life].filter(Boolean).join('\n\n')}>
                    <CardPhoto card={card} className="nv-avatar" />
                    <span className="nv-person-text">
                      <span className="nv-list-title">{card.name}<span className="nv-muted nv-small"> {t(...ROLE_LABELS[card.role])}</span></span>
                      <span className={cx('nv-list-meta', life.death !== undefined && 'is-dead')}>{told}</span>
                    </span>
                  </button>
                </th>
                {lives.chapters.map((chapter) => {
                  const event = at.get(chapter.index)
                  const plan = planOf.get(chapter.id)
                  const written = infoOf.get(chapter.id)?.hasText === true
                  const planned = plan?.characters?.includes(card.id) === true
                  const state = event !== undefined ? cx('is-on', event.kind !== 'seen' && `is-${event.kind}`, event.marked === true && 'is-marked')
                    // Cast by the outline and not in the chapter: still to come while it is unwritten, missing once its digest is there.
                    : planned ? (written && chapter.digested ? 'is-missed' : 'is-planned')
                      : written && !chapter.digested ? 'is-unread' : undefined
                  const mark = event !== undefined && event.kind !== 'seen' ? `${t(...LIFE_MARK[event.kind])}${event.what !== undefined ? t('：', ': ') : ''}` : ''
                  const says = event !== undefined ? ` — ${mark}${event.what ?? (mark.length === 0 ? t('在场', 'present') : '')}${event.marked === true ? t('（作者记的）', ' (the author\'s mark)') : ''}`
                    : planned ? (written && chapter.digested ? t('（章纲安排了，正文没有出场）', ' (planned but absent from the text)') : t('（计划出场）', ' (planned)'))
                      : written && !chapter.digested ? t('（这一章还没有收录）', ' (not digested yet)') : ''
                  return (
                    <td
                      key={chapter.id}
                      className={cx(state, plan?.pov === card.id && 'is-pov')}
                      title={`${card.name} · ${t(`第 ${chapter.index} 章`, `Ch. ${chapter.index}`)} ${chapter.title}${says}`}
                      {...(event !== undefined ? { onClick: () => { controller.setView('read', chapter.id) } } : {})}
                    />
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="nv-muted nv-small nv-legend">
        <span className="nv-legend-cell is-on" />{t('在场', 'On the page')}
        <span className="nv-legend-cell is-on is-enter" />{t('登场 / 回归', 'Comes on / returns')}
        <span className="nv-legend-cell is-on is-exit" />{t('离开', 'Leaves')}
        <span className="nv-legend-cell is-on is-death" />{t('死亡', 'Dies')}
        <span className="nv-legend-cell is-planned" />{t('计划出场', 'Planned')}
        <span className="nv-legend-cell is-missed" />{t('计划了但没出场', 'Planned but absent')}
        <span className="nv-legend-cell is-on is-pov" />{t('视角人物', 'Point of view')}
        <span className="nv-legend-cell is-unread" />{t('还没收录', 'Not digested')}
      </p>
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
  const { project, root } = useProject()
  const mediaUrl = useMediaUrl()
  const [focus, setFocus] = useState<string | undefined>()
  // Where the author moved people to on the whole picture: kept with the book, and on the picture at once — before the book has answered.
  const [places, setPlaces] = useState<Record<string, Point>>(project.graph ?? {})
  useEffect(() => { setPlaces(project.graph ?? {}) }, [project.graph])
  // Somebody being moved: who, and where the pointer has them now.
  const [held, setHeld] = useState<{ id: string; at: Point } | undefined>()
  const grab = useRef<{ id: string; x: number; y: number; dx: number; dy: number; moved: boolean } | undefined>(undefined)
  // The click that ends a move is no click on the person.
  const dropped = useRef(false)
  const place = (id: string | undefined, at: Point | undefined): void => {
    setPlaces((current) => {
      if (id === undefined) return {}
      const { [id]: _was, ...others } = current
      return at !== undefined ? { ...others, [id]: at } : others
    })
    void controller.guard(async () => {
      await controller.api.call('graph.place', { root, ...(id !== undefined ? { id } : {}), ...(at !== undefined ? { at } : {}) })
      await controller.refreshProject()
    })
  }
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
  const layout = useMemo(() => (centred !== undefined ? layoutAround(centred, nodes, edges) : { ...layoutGraph(nodes, edges, places), ring: undefined }), [centred, nodes, edges, places])

  // ── moving about on the picture: what is shown of it, changed by the wheel, by dragging, by the buttons ──
  const [view, setView] = useState<Box | undefined>()
  const frame = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; view: Box } | undefined>(undefined)
  // Another picture — around somebody else, of other people — is shown whole; one person moved on it leaves what is looked at as it is.
  const picture = `${centred ?? ''}|${nodes.map(node => node.id).join(',')}`
  useEffect(() => { setView(undefined) }, [picture])
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

  // Where somebody stands on the picture: in the hand that moves them, else where the layout has them.
  const spot = (id: string): Point | undefined => (held?.id === id ? held.at : layout.at.get(id))

  if (edges.length === 0) return <Empty icon="link" title={t('还没有人物关系', 'No relationships yet')}>{t('在人物卡的“关系”里添加。', 'Add them under Relationships on a character\'s card.')}</Empty>
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
            const from = spot(edge.from)
            const to = spot(edge.to)
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
            const position = spot(card.id)
            if (position === undefined) return null
            const far = layout.ring?.get(card.id) === 2
            const pinned = centred === undefined && places[card.id] !== undefined
            return (
              <g
                key={card.id}
                className={cx('nv-graph-node', `is-${card.role}`, far && 'is-far', centred === card.id && 'is-focus', pinned && 'is-placed', held?.id === card.id && 'is-held')}
                transform={`translate(${position.x} ${position.y})`}
                onClick={() => {
                  if (dropped.current) {
                    dropped.current = false
                    return
                  }
                  setFocus(centred === card.id ? undefined : card.id)
                }}
                // On the whole picture a person can be taken hold of and put elsewhere; around somebody, everyone has their place on a ring.
                onPointerDown={(event) => {
                  const point = centred === undefined && event.button === 0 ? pointOf(event) : undefined
                  if (point === undefined) return
                  grab.current = { id: card.id, x: event.clientX, y: event.clientY, dx: position.x - point.x, dy: position.y - point.y, moved: false }
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId)
                  } catch {
                    // A pointer that cannot be held: its moves still arrive while it is over the mark.
                  }
                }}
                onPointerMove={(event) => {
                  const from = grab.current
                  if (from === undefined || from.id !== card.id) return
                  // A hand is never quite still: a few pixels are still a click.
                  if (!from.moved && Math.hypot(event.clientX - from.x, event.clientY - from.y) < 4) return
                  const point = pointOf(event)
                  if (point === undefined) return
                  from.moved = true
                  setHeld({ id: card.id, at: { x: point.x + from.dx, y: point.y + from.dy } })
                }}
                onPointerUp={() => {
                  const from = grab.current
                  grab.current = undefined
                  if (from === undefined || !from.moved) return
                  // The click that follows the release is this move's end, not a click on the person; and where none follows, the next one is theirs.
                  dropped.current = true
                  setTimeout(() => { dropped.current = false }, 0)
                  if (held?.id === card.id) place(card.id, held.at)
                  setHeld(undefined)
                }}
                onPointerCancel={() => {
                  grab.current = undefined
                  setHeld(undefined)
                }}
              >
                <title>{centred === undefined ? t(`${card.name}：点一下以这个人为中心；拖动把他挪到别处`, `${card.name}: click to put them in the middle; drag to move them elsewhere`) : t(`${card.name}：点一下以这个人为中心`, `${card.name}: click to put them in the middle`)}</title>
                <circle r={MARK[card.role]} />
                {/* Whoever has a face shows it: the mark is their portrait, in a ring of their part's colour. */}
                {card.visual?.portrait !== undefined ? <image className="nv-graph-face" href={mediaUrl(card.visual.portrait)} x={-MARK[card.role]} y={-MARK[card.role]} width={MARK[card.role] * 2} height={MARK[card.role] * 2} preserveAspectRatio="xMidYMin slice" /> : null}
                <text y={MARK[card.role] + 14} textAnchor="middle">{card.name}</text>
                {/* Put there by hand: a small mark says so, and takes them back to where the layout has them. */}
                {pinned && held === undefined ? (
                  <g
                    className="nv-graph-unpin"
                    transform={`translate(${MARK[card.role] * 0.78} ${-MARK[card.role] * 0.78})`}
                    onPointerDown={(event) => { event.stopPropagation() }}
                    onClick={(event) => {
                      event.stopPropagation()
                      place(card.id, undefined)
                    }}
                  >
                    <title>{t('放回自动排布的位置', 'Back to where the layout puts them')}</title>
                    <circle r={5.5} />
                    <path d="M-2.2 -2.2 L2.2 2.2 M2.2 -2.2 L-2.2 2.2" />
                  </g>
                ) : null}
              </g>
            )
          })}
        </svg>
        <div className="nv-graph-tools">
          <Button size="sm" variant="ghost" onClick={() => { zoom(1 / 1.3) }} title={t('放大', 'Zoom in')}>＋</Button>
          <Button size="sm" variant="ghost" onClick={() => { zoom(1.3) }} title={t('缩小', 'Reduce')}>－</Button>
          <Button size="sm" variant="ghost" disabled={view === undefined} onClick={() => { setView(undefined) }} title={t('回到整张图', 'Back to the whole picture')}>{t('全图', 'Whole')}</Button>
          {centred === undefined && Object.keys(places).length > 0 ? <Button size="sm" variant="ghost" onClick={() => { place(undefined, undefined) }} title={t(`把挪动过的 ${Object.keys(places).length} 人放回自动排布`, `Put the ${Object.keys(places).length} you moved back where the layout puts them`)}>{t('自动排布', 'Lay out again')}</Button> : null}
        </div>
        <p className="nv-muted nv-small nv-graph-legend">
          {kinds.map(kind => <span key={kind} className={cx('nv-graph-key', `is-${kind}`)}><i />{t(...KIND_LABELS[kind])}</span>)}
          <span className="nv-graph-hint">{centred !== undefined
            ? t(`以「${nameOf(centred)}」为中心`, `Centred on ${nameOf(centred)}`)
            : t('点一个人以他为中心；拖动挪位置；滚轮缩放。', 'Click someone to centre on them; drag to move; scroll to zoom.')}</span>
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
  const actions = useBookActions()
  const quote = useQuote()
  const { project, root } = useProject()
  const loaded = useLoad(signal => controller.api.call('cast.walkons', { root, ignored: true }, signal), [root, project.revision])
  const [showIgnored, setShowIgnored] = useState(false)
  const sifting = useRunningJob(job => job.kind === 'bible' && job.title === 'sift cast') !== undefined
  const index = useMemo(() => new Map(project.chapters.map(chapter => [chapter.id, chapter.index])), [project.chapters])
  const light = cards.filter(card => card.role === 'minor' || card.role === 'cameo')
  // Several names picked at once, to be given cards together.
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const keyOf = (item: WalkOn): string => `${item.name}\u0000${item.story ?? ''}`
  const carding = useRunningJob(job => job.kind === 'bible' && job.title === 'card walk-ons') !== undefined
  if (loaded.data === undefined) {
    return <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不会整理龙套——重启一次 DSH 就有了。', 'This Studio service cannot list walk-ons yet — restart DSH once.')}</p> : <Spinner />}</div>
  }
  const all = loaded.data.walkons
  const listed = all.filter(item => item.ignored !== true)
  const ignored = all.filter(item => item.ignored === true)
  // Whom the planner has yet to say something of: never looked at, or seen in more chapters since.
  const due = listed.filter(item => item.verdict === undefined || item.chapters.length > item.verdict.seen)
  const sift = (again: boolean): Promise<unknown> => controller.guard(async () => { await actions.siftCast(again) })
  const settle = (item: WalkOn, action: 'alias' | 'ignore' | 'restore', extra: { target?: string } = {}): Promise<unknown> => controller.guard(async () => {
    const result = await controller.api.call('cast.settle', { root, name: item.name, ...(item.story !== undefined ? { story: item.story } : {}), action, ...extra })
    loaded.set({ walkons: result.walkons })
    if (action === 'alias') controller.toast('success', t(`「${item.name}」已并入「${cards.find(card => card.id === extra.target)?.name ?? ''}」的别名`, `"${item.name}" is now an alias of ${cards.find(card => card.id === extra.target)?.name ?? ''}`))
  })
  /** A card for each of these — and the planner writes them whole, from what the digests noted: looks, who they are, what they want. */
  const card = (items: WalkOn[], role: 'minor' | 'cameo'): Promise<unknown> => controller.guard(async () => {
    if (items.length === 0) return
    const job = await controller.run('cast.card', { root, people: items.map(item => ({ name: item.name, ...(item.story !== undefined ? { story: item.story } : {}) })), role })
    setPicked(new Set())
    loaded.reload()
    await controller.refreshProject()
    const output = job.result?.output as { carded?: { name: string }[]; written?: number; lines?: number; failed?: { step: string; error: string }[] } | undefined
    const made = output?.carded?.length ?? 0
    const failed = output?.failed ?? []
    controller.toast(failed.length > 0 ? 'info' : 'success', t(
      `立了 ${made} 张卡，策划照收录的记载写全了 ${output?.written ?? 0} 张${(output?.lines ?? 0) > 0 ? `；有声脚本里的 ${output!.lines} 句台词归到了这些卡` : ''}${failed.length > 0 ? `；没做成：${failed.map(item => item.step).slice(0, 4).join('、')}` : ''}`,
      `${made} card(s) made; ${output?.written ?? 0} written whole by the planner from the digests${(output?.lines ?? 0) > 0 ? `; ${output!.lines} script lines now belong to them` : ''}${failed.length > 0 ? `; not done: ${failed.map(item => item.step).slice(0, 4).join(', ')}` : ''}`,
    ))
  })
  const where = (item: WalkOn): string => {
    const numbers = item.chapters.map(id => index.get(id)).filter((value): value is number => value !== undefined)
    if (numbers.length === 0) return t('还没有收录到出场章节', 'no chapter on record yet')
    return t(`第 ${numbers.slice(0, 8).join('、')}${numbers.length > 8 ? ' …' : ''} 章`, `ch. ${numbers.slice(0, 8).join(', ')}${numbers.length > 8 ? ' …' : ''}`)
  }
  const row = (item: WalkOn) => {
    const near = item.near !== undefined ? cards.find(card => card.id === item.near) : undefined
    return (
      <li key={`${item.name}\u0000${item.story ?? ''}`} className={cx('nv-walkon', item.ignored === true && 'is-ignored', picking && picked.has(keyOf(item)) && 'is-picked')}>
        {picking && item.ignored !== true ? <input type="checkbox" className="nv-walkon-pick" checked={picked.has(keyOf(item))} aria-label={t(`选中「${item.name}」`, `Pick ${item.name}`)} onChange={() => { setPicked((previous) => { const next = new Set(previous); if (!next.delete(keyOf(item))) next.add(keyOf(item)); return next }) }} /> : null}
        <div className="nv-walkon-main">
          <span className="nv-list-title">{item.name}</span>
          {item.story !== undefined ? <span className="nv-muted nv-small">{project.outline.lines?.find(line => line.id === item.story)?.title ?? ''}</span> : null}
          <span className="nv-list-meta">
            {where(item)}
            {item.lines > 0 ? t(` · 有声脚本里 ${item.lines} 句台词`, ` · ${item.lines} lines in audio scripts`) : ''}
          </span>
          {item.note !== undefined ? <span className="nv-walkon-note">{item.note}</span> : null}
          {item.verdict !== undefined ? (
            <span className="nv-walkon-verdict">
              {item.verdict.is === 'card' ? t('策划：值得立卡', 'Planner: worth a card') : item.verdict.is === 'alias' ? t(`策划：是「${item.verdict.same ?? '？'}」的另一个称呼`, `Planner: another name of ${item.verdict.same ?? '?'}`) : t('策划：龙套', 'Planner: a walk-on')}
              {item.verdict.why !== undefined ? `${t('——', ' — ')}${item.verdict.why}` : ''}
              {item.chapters.length > item.verdict.seen ? t('（之后又出场了，还没重看）', ' (seen again since; not looked at again yet)') : ''}
            </span>
          ) : null}
          <span className="nv-row-wrap">
            {item.voice !== undefined ? <Chip tone="violet" title={t('有声剧里给这个名字定下的声音；立卡后跟着卡走', 'The voice the audio drama gave this name; it follows the card once there is one')}>{t('声音：', 'voice: ')}{item.voice.length > 18 ? `${item.voice.slice(0, 18)}…` : item.voice}</Chip> : null}
            {item.suggestion !== undefined ? <Chip tone="blue" onClick={() => { controller.setView('review') }} title={t('在"审校 → 设定建议"里等你采纳', 'Waits under Review → Suggestions')}>{t('已建议立卡', 'card suggested')}</Chip> : null}
            {near !== undefined ? <Chip tone="amber" onClick={() => { void settle(item, 'alias', { target: near.id }) }} title={t('点一下，把这个名字并入他的别名', 'Click to fold this name into their aliases')}>{t(`是「${near.name}」的另一个叫法？`, `Another name for ${near.name}?`)}</Chip> : null}
          </span>
        </div>
        {item.ignored === true ? (
          <Button size="sm" variant="ghost" icon="undo" pending={t('正在放回…', 'Putting back…')} onClick={() => settle(item, 'restore')}>{t('放回列表', 'Put back')}</Button>
        ) : (
          <div className="nv-row">
            <Menu label={t('立卡', 'Give a card')} icon="plus" variant="outline" align="end" items={[
              { label: t('作为小人物（有名有姓、偶尔出场）', 'As a minor character (named, now and then)'), onSelect: () => { void card([item], 'minor') } },
              { label: t('作为龙套（露一面就走）', 'As a cameo (seen once)'), onSelect: () => { void card([item], 'cameo') } },
            ]} />
            {cards.length > 0 ? (
              <Menu label={t('是别名', 'Alias of')} icon="link" align="end" items={[...(near !== undefined ? [near] : []), ...cards.filter(card => card.id !== near?.id)].slice(0, 30).map(card => ({ label: card.name, onSelect: () => { void settle(item, 'alias', { target: card.id }) } }))} />
            ) : null}
            <Button size="sm" variant="ghost" icon="x" pending={t('正在移出…', 'Removing…')} onClick={() => settle(item, 'ignore')} title={t('从列表里拿掉', 'Take off the list')} />
          </div>
        )}
      </li>
    )
  }
  return (
    <div className="nv-walkons">
      <section className="nv-card">
        <SectionTitle actions={listed.length > 0 ? (
          <>
            <Button size="sm" icon="sparkles" busy={sifting} pending={t('策划在筛…', 'The planner is looking…')} onClick={() => sift(due.length === 0)} title={due.length > 0 ? t('策划逐个看：值得立卡的进"设定建议"，是别名的建议并入，其余留在这里', 'The planner looks at each: worth a card goes to the suggestions, another name is proposed to be folded in, the rest stay here') : t('都看过了；再点是全部重看一遍', 'All looked at; this looks at every one again')}>{due.length > 0 ? t(`让策划筛一遍（${due.length}）`, `Have the planner look (${due.length})`) : t('全部重筛', 'Look at all again')}</Button>
            {quote !== undefined ? <Button size="sm" icon="quote" onClick={() => { quote(t(`这些名字在正文里出现了但还没有人物卡：${listed.slice(0, 20).map(item => item.name).join('、')}。请判断哪些值得立卡、哪些其实是已有人物的别名、哪些不用管，并替我处理。\n`, `These names are on the page without a character card: ${listed.slice(0, 20).map(item => item.name).join(', ')}. Decide which deserve a card, which are aliases of existing characters and which can be left alone, and settle them for me.\n`)) }}>{t('交给总编', 'Hand to the showrunner')}</Button> : null}
          </>
        ) : undefined}>{t(`正文里有名字、还没立卡的人（${listed.length}）`, `Named on the page, no card yet (${listed.length})`)}</SectionTitle>
        <p className="nv-muted nv-small">{t('值得跟踪的立卡，是别名的并进去，其余不用管。立卡后策划照收录的记载把外貌、为人这些写全。', 'Give a card to those worth following, fold aliases in, leave the rest. A card made here is written whole by the planner — looks, who they are — from what the digests noted.')}</p>
        {listed.length > 0 ? (
          <div className="nv-pick-bar">
            <Button size="sm" variant={picking ? 'primary' : 'ghost'} icon="check" onClick={() => { setPicking(value => !value); setPicked(new Set()) }}>{picking ? t('完成', 'Done') : t('多选', 'Select')}</Button>
            {picking ? (
              <>
                <span>{t(`已选 ${listed.filter(item => picked.has(keyOf(item))).length} 人`, `${listed.filter(item => picked.has(keyOf(item))).length} picked`)}</span>
                <button type="button" className="nv-link" onClick={() => { setPicked(new Set(listed.map(keyOf))) }}>{t(`全选（${listed.length}）`, `All ${listed.length}`)}</button>
                {listed.some(item => item.verdict?.is === 'card') ? <button type="button" className="nv-link" onClick={() => { setPicked(new Set(listed.filter(item => item.verdict?.is === 'card').map(keyOf))) }}>{t('选策划说值得立卡的', 'Those the planner found worth a card')}</button> : null}
                <button type="button" className="nv-link" onClick={() => { setPicked(new Set()) }}>{t('清空', 'None')}</button>
                <span className="nv-spacer" />
                {carding || listed.filter(item => picked.has(keyOf(item))).length === 0 ? <Button size="sm" variant="primary" icon="plus" disabled busy={carding}>{carding ? t('正在立卡…', 'Making cards…') : t('给选中的人立卡', 'Cards for those picked')}</Button> : <Menu label={t(`给选中的 ${listed.filter(item => picked.has(keyOf(item))).length} 人立卡`, `Cards for the ${listed.filter(item => picked.has(keyOf(item))).length} picked`)} icon="plus" variant="primary" align="end" items={[
                  { label: t('作为小人物（有名有姓、偶尔出场）', 'As minor characters (named, now and then)'), onSelect: () => { void card(listed.filter(item => picked.has(keyOf(item))), 'minor') } },
                  { label: t('作为龙套（露一面就走）', 'As cameos (seen once)'), onSelect: () => { void card(listed.filter(item => picked.has(keyOf(item))), 'cameo') } },
                ]} />}
              </>
            ) : null}
          </div>
        ) : null}
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

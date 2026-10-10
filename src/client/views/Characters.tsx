// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A book's people, card by card: the list of everyone who has a card, and one
 * person's page — their picture large beside who they are, then everything
 * the writer, the director and the voices are told about them.
 *
 *   CharacterCards   the list and the page of whoever is chosen in it
 *   CardPhoto        somebody's face for a list
 *   ROLE_LABELS…     how parts are called, and where somebody stands at a chapter of a line
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VoiceOption } from '../../shared/rpc'
import type { CharacterCard, CharacterLook, CharacterRole, CharacterStage, LifeMark, SignatureScene, SortedNotes } from '../../shared/types'
import { sceneFor, scenesOf } from '../../shared/art'
import { detailsOf, foldDetails } from '../../shared/card'
import { leadOf, withBookImage } from '../../shared/images'
import { lifeEnd, lifeLine, type Life, type LifeEvent, type LifeStanding } from '../../shared/life'
import { lines, options, useAssist } from '../forms'
import { sceneOf, sheetsDrawn, type PortraitScene } from '../labels'
import { DeletePicture, PictureViewer, usePictures } from '../PictureRecord'
import { useSheetsAsk, type SheetsChoice } from '../SheetsAsk'
import { TiesBlock } from '../Ties'
import { AroundGraph, bondsOf } from '../reader/around'
import { HistoryButton, RemovedCards } from '../History'
import { LinesField, LineTags, type LinePicks } from '../LinesField'
import { Icon } from '../icons'
import {
  Button, Chip, cx, Empty, Field, Modal, ProjectImage, SectionTitle, Select, TextArea, TextInput, useAction, useConfirm, useLoad, useMediaUrl,
  useProject, useRunningJob, useSnapshot, useStudio, useT, plainEnter,
  ViewButton,
} from '../ui'

export const ROLE_LABELS: Record<CharacterRole, [string, string]> = {
  protagonist: ['主角', 'Protagonist'],
  deuteragonist: ['第二主角', 'Deuteragonist'],
  antagonist: ['反派', 'Antagonist'],
  supporting: ['配角', 'Supporting'],
  minor: ['次要', 'Minor'],
  cameo: ['龙套', 'Cameo'],
}

/**
 * How it is called where somebody stands at one chapter of one line of the
 * plot — read off their life there, never a word kept on their card.
 */
export const STANDING_LABELS: Record<LifeStanding, [string, string]> = {
  planned: ['未登场', 'Not on yet'],
  active: ['在场', 'On the page'],
  offstage: ['暂离', 'Away'],
  retired: ['已离开', 'Gone'],
  dead: ['已故', 'Dead'],
}

export const STANDING_TONES: Record<LifeStanding, 'neutral' | 'green' | 'amber' | 'blue' | 'red'> = {
  planned: 'blue',
  active: 'green',
  offstage: 'amber',
  retired: 'neutral',
  dead: 'red',
}

/** How the people list looks: with everyone's portrait, or names only. */
type PeopleMode = 'photos' | 'minimal'
const PEOPLE_KEY = 'novel-studio:people'

function storedMode(): PeopleMode | undefined {
  try {
    const raw = localStorage.getItem(PEOPLE_KEY)
    return raw === 'photos' || raw === 'minimal' ? raw : undefined
  } catch {
    return undefined
  }
}

const GROUPS: { key: 'lead' | 'supporting' | 'minor'; roles: CharacterRole[]; label: [string, string] }[] = [
  { key: 'lead', roles: ['protagonist', 'deuteragonist', 'antagonist'], label: ['主要人物', 'Leads'] },
  { key: 'supporting', roles: ['supporting'], label: ['配角', 'Supporting'] },
  { key: 'minor', roles: ['minor', 'cameo'], label: ['小人物与龙套', 'Minor parts and walk-ons'] },
]

/**
 * A character's face for a list: their portrait, else the front view of their
 * design sheet, else their initial.
 */
export function CardPhoto({ card, className }: { card: CharacterCard; className?: string }) {
  const mediaUrl = useMediaUrl()
  if (card.visual?.portrait !== undefined) return <ProjectImage className={cx('nv-photo', className)} path={card.visual.portrait} alt={card.name} />
  // A sheet of the front view alone is their picture as it is.
  if (card.visual?.sheet !== undefined && card.visual.sheetFront === true) return <ProjectImage className={cx('nv-photo', className)} path={card.visual.sheet} alt={card.name} />
  // A sheet shows the same person three times; its left third is the front view.
  if (card.visual?.sheet !== undefined) return <span className={cx('nv-photo is-sheet', className)} role="img" aria-label={card.name} style={{ backgroundImage: `url("${mediaUrl(card.visual.sheet)}")` }} />
  return <span className={cx('nv-photo is-empty', className)} aria-hidden="true">{card.name.slice(0, 1)}</span>
}

/**
 * Everyone with a card, and the page of whoever is chosen.
 * @param shown - the cards the page's filter lets through, in the order asked for.
 * @param grouped - the order is by weight: leads, supporting parts and the long tail each under a head of their own.
 * @param searching - somebody is being looked for: nothing stays folded.
 */
/** Everyone's life along the line of the plot the page looks at, as the Host read it off the digests. */
export interface Lives {
  /** The line it was read along: its id, and its name when it is not the main one. */
  line?: { id: string; title: string }
  chapters: { id: string; index: number; title: string; digested: boolean }[]
  lives: Record<string, Life>
}

export function CharacterCards({ shown, grouped, searching, lives, picks }: { shown: CharacterCard[]; grouped: boolean; searching: boolean; lives?: Lives | undefined; /** A batch being picked from the list: a click on a row picks it instead of opening it. */ picks?: LinePicks | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const entity = useSnapshot(snapshot => snapshot.entity)
  const [selected, setSelected] = useState<string | undefined>(() => (entity?.kind === 'character' ? entity.id : undefined) ?? shown[0]?.id ?? project.characters[0]?.id)
  // A link from elsewhere (the board, a relationship, a tool row) names the card to open.
  useEffect(() => { if (entity?.kind === 'character') setSelected(entity.id) }, [entity?.nonce])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const settings = useSnapshot(snapshot => snapshot.settings)
  useEffect(() => { if (settings === undefined) void controller.loadSettings().catch(() => {}) }, [controller, settings])
  const canDraw = settings?.ready?.image === true
  const faced = project.characters.filter(card => card.visual?.portrait !== undefined || card.visual?.sheet !== undefined)
  const [choice, setChoice] = useState<PeopleMode | undefined>(storedMode)
  // Portraits by default wherever there is something to show or a way to draw it.
  const mode: PeopleMode = choice ?? (faced.length > 0 || canDraw ? 'photos' : 'minimal')
  const pick = (next: PeopleMode): void => {
    setChoice(next)
    try { localStorage.setItem(PEOPLE_KEY, next) } catch { /* private windows keep it for this visit only */ }
  }
  const card = project.characters.find(candidate => candidate.id === selected)
  // Whoever is open stays in the list, whatever the filter lets through: a page with nobody marked beside it reads as lost.
  const listed = useMemo(() => (card !== undefined && !shown.some(item => item.id === card.id) ? [card, ...shown] : shown), [shown, card])
  // Portraits are drawn for the people in view: a filter on the leads draws the leads.
  const faceless = listed.filter(item => item.visual?.portrait === undefined)
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const create = (): Promise<unknown> => run(async () => {
    const created = await controller.api.call('character.save', { root, card: { name: name.trim(), role: 'supporting' } })
    setSelected(created.id)
    setCreating(false)
    setName('')
  })
  const drawingAny = useRunningJob(job => job.kind === 'illustrate' && job.title === 'illustrate portrait')
  const [batch, setBatch] = useState<{ done: number; total: number } | undefined>()
  const drawAll = (): void => {
    if (!controller.need('image')) return
    const todo = faceless.map(item => item.id)
    // The sheet comes first: whoever has none gets one before their portrait — said here, where the calls are counted.
    const lead = settings !== undefined ? leadOf(withBookImage(settings.settings.image, project.manifest.image)) : 'sheet'
    const sheetless = lead === 'none' ? 0 : faceless.filter(item => item.visual?.sheet === undefined).length
    // So does their scene: whoever has none on their card has the director pick one from the book first.
    const sceneless = (settings !== undefined && withBookImage(settings.settings.image, project.manifest.image).portraitScene === false) || !project.chapters.some(chapter => chapter.hasText) ? 0 : faceless.filter(item => scenesOf(item).length === 0).length
    confirm.ask(t(`给 ${todo.length} 个还没有定妆照的人物各画一张？${sheetless > 0 ? (lead === 'portrait' ? `其中 ${sheetless} 人画完会照着立绘补人设图。` : `其中 ${sheetless} 人会先画人设图。`) : ''}${sceneless > 0 ? `${sceneless} 人会先由导演找名场面。` : ''}`, `Draw a portrait for each of the ${todo.length} without one?${sheetless > 0 ? (lead === 'portrait' ? ` ${sheetless} get a design sheet after it, drawn against it.` : ` ${sheetless} get a design sheet first.`) : ''}${sceneless > 0 ? ` For ${sceneless} the director finds their signature scenes first.` : ''}`), () => {
      void controller.guard(async () => {
        setBatch({ done: 0, total: todo.length })
        try {
          for (const [index, id] of todo.entries()) {
            // Stopping one portrait stops the batch: the rejection ends the loop.
            await controller.run('image.create', { root, kind: 'portrait', target: id })
            setBatch({ done: index + 1, total: todo.length })
          }
          controller.toast('success', t('定妆照都画好了', 'All portraits are ready'))
        } finally {
          setBatch(undefined)
        }
      })
    })
  }
  // Whoever of the people listed has no stretches of their life read yet: the planner reads them one after another.
  const ungrown = listed.filter(item => (item.stages?.length ?? 0) === 0 && project.presence.some(entry => entry.character === item.id && entry.chapters.length >= 2))
  const [growing, setGrowing] = useState<{ done: number; total: number } | undefined>()
  const growAll = (): void => {
    const todo = ungrown.map(item => item.id)
    confirm.ask(t(`让策划读这 ${todo.length} 个人物的成长轨迹（年龄、从哪一章起变了）？每人一次策划的调用。`, `Have the planner read how these ${todo.length} people grow (ages, where they turn)? One planner run each.`), () => {
      void controller.guard(async () => {
        setGrowing({ done: 0, total: todo.length })
        try {
          for (const [index, id] of todo.entries()) {
            await controller.run('character.growth', { root, id })
            setGrowing({ done: index + 1, total: todo.length })
          }
          controller.toast('success', t('成长轨迹都读完了', 'Everyone\'s growth is read'))
        } finally {
          setGrowing(undefined)
        }
      })
    })
  }
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const groups = grouped
    ? GROUPS.map(group => ({ ...group, cards: listed.filter(item => group.roles.includes(item.role)) })).filter(group => group.cards.length > 0)
    : [{ key: 'all' as const, roles: [] as CharacterRole[], label: ['', ''] as [string, string], cards: listed }].filter(group => group.cards.length > 0)
  // How the line looked at lets somebody go, where it does: a death or a leaving, with its chapter. Nothing for everyone else —
  // being in the story is no news, and where the book has got to is no property of a person.
  const end = (item: CharacterCard): { dead: boolean; text: string } | undefined => {
    const life = lives?.lives[item.id]
    const said = lifeEnd(life, true)
    return said !== undefined ? { dead: said.dead, text: t(said.text, lifeEnd(life, false)!.text) } : undefined
  }
  const onLine = lives?.line !== undefined ? t(`（${lives.line.title}）`, ` (${lives.line.title})`) : ''
  const row = (item: CharacterCard): ReactNode => (mode === 'photos' ? (
    <li key={item.id}>
      <button type="button" className={cx('nv-photo-card', item.id === selected && picks?.on !== true && 'is-active', picks?.on === true && picks.ids.has(item.id) && 'is-picked')} onClick={() => { if (picks?.on === true) picks.toggle(item.id); else setSelected(item.id) }} title={[item.tagline, end(item) !== undefined ? `${end(item)!.text}${onLine}` : undefined].filter(Boolean).join('\n')}>
        <CardPhoto card={item} />
        {picks?.on === true ? <span className={cx('nv-pick-mark nv-photo-pick', picks.ids.has(item.id) && 'is-on')} aria-hidden="true"><Icon name="check" size={11} /></span> : null}
        {end(item) !== undefined ? <span className={cx('nv-photo-end', end(item)!.dead && 'is-dead')}>{end(item)!.text}</span> : null}
        <span className="nv-photo-name">{item.name}</span>
        <span className="nv-photo-meta">{t(...ROLE_LABELS[item.role])}</span>
      </button>
    </li>
  ) : (
    <li key={item.id}>
      <button type="button" className={cx('nv-list-row nv-person', item.id === selected && picks?.on !== true && 'is-active', picks?.on === true && picks.ids.has(item.id) && 'is-picked')} onClick={() => { if (picks?.on === true) picks.toggle(item.id); else setSelected(item.id) }}>
        {picks?.on === true ? <span className={cx('nv-pick-mark', picks.ids.has(item.id) && 'is-on')} aria-hidden="true"><Icon name="check" size={11} /></span> : null}
        <span className="nv-avatar nv-avatar-empty">{item.name.slice(0, 1)}</span>
        <span className="nv-person-text">
          <span className="nv-list-title">{item.name}</span>
          <span className="nv-list-meta">{t(...ROLE_LABELS[item.role])}{item.tagline !== undefined ? ` · ${item.tagline}` : ''}</span>
        </span>
        {end(item) !== undefined ? <Chip tone={end(item)!.dead ? 'red' : 'neutral'} title={`${end(item)!.text}${onLine}`}>{end(item)!.text}</Chip> : null}
      </button>
    </li>
  ))
  return (
    <div className={cx('nv-split nv-people', mode === 'photos' && 'has-photos')}>
      <aside className="nv-split-list">
        <div className="nv-people-tools">
          <div className="nv-seg" role="group" aria-label={t('人物列表的样子', 'How the list looks')}>
            <button type="button" className={cx(mode === 'photos' && 'is-active')} onClick={() => { pick('photos') }} title={t('显示定妆照', 'Show portraits')}><Icon name="users" size={13} /><span>{t('定妆照', 'Portraits')}</span></button>
            <button type="button" className={cx(mode === 'minimal' && 'is-active')} onClick={() => { pick('minimal') }} title={t('只看名字和定位，不显示图片', 'Names and roles only, no pictures')}><Icon name="list" size={13} /><span>{t('极简', 'Minimal')}</span></button>
          </div>
          <Button size="sm" icon="plus" variant="primary" onClick={() => { setCreating(true) }}>{t('新建人物', 'New character')}</Button>
        </div>
        {mode === 'photos' && faceless.length > 0 ? (
          <Button size="sm" variant="ghost" icon="sparkles" busy={batch !== undefined} disabled={drawingAny !== undefined && batch === undefined} pending={batch !== undefined ? t(`正在画定妆照 ${batch.done}/${batch.total}…`, `Drawing portraits ${batch.done}/${batch.total}…`) : undefined} onClick={drawAll} title={t('给列表里还没有定妆照的人物各画一张立绘', 'Draw a portrait for everyone listed who has none')}>{t(`补齐定妆照（${faceless.length}）`, `Draw missing portraits (${faceless.length})`)}</Button>
        ) : null}
        {ungrown.length > 0 && project.chapters.some(chapter => chapter.hasText) ? (
          <Button size="sm" variant="ghost" icon="clock" busy={growing !== undefined} pending={growing !== undefined ? t(`正在读成长轨迹 ${growing.done}/${growing.total}…`, `Reading growth ${growing.done}/${growing.total}…`) : undefined} onClick={growAll}>{t(`读成长轨迹（${ungrown.length}）`, `Read their growth (${ungrown.length})`)}</Button>
        ) : null}
        {groups.map((group) => {
          // A long tail of walk-ons stays folded until someone looks for one of them.
          const closed = grouped && (folded[group.key] ?? (group.key === 'minor' && group.cards.length > 8 && !searching && !group.cards.some(item => item.id === selected)))
          return (
            <div key={group.key} className="nv-people-group">
              {grouped ? (
                <button type="button" className="nv-group-head" aria-expanded={!closed} onClick={() => { setFolded(previous => ({ ...previous, [group.key]: !closed })) }}>
                  <Icon name={closed ? 'chevronRight' : 'chevronDown'} size={12} />
                  <span>{t(...group.label)}</span>
                  <span className="nv-muted">{group.cards.length}</span>
                </button>
              ) : null}
              {closed ? null : <ul className={mode === 'photos' ? 'nv-people-grid' : 'nv-list'}>{group.cards.map(row)}</ul>}
            </div>
          )
        })}
        {project.characters.length === 0
          ? <p className="nv-muted nv-pad">{t('还没有人物。', 'No characters yet.')}</p>
          : listed.length === 0 ? <p className="nv-muted nv-pad">{t('上面的筛选条件下没有人物。', 'Nobody passes the filter above.')}</p> : null}
        <RemovedCards kinds={['character']}>{count => t(`最近删除的人物 · ${count}`, `Deleted characters · ${count}`)}</RemovedCards>
        <button type="button" className="nv-add-row" onClick={() => { controller.openCast('walkons') }}>{t('没立卡的路人、龙套在"龙套"页签里管 →', 'People without a card are kept under Walk-ons →')}</button>
      </aside>
      <section className="nv-split-detail">
        {card !== undefined ? <CharacterEditor key={card.id} card={card} lives={lives} onDeleted={() => { setSelected(undefined) }} /> : <Empty icon="users" title={t('选择或新建一个人物', 'Select or create a character')} />}
      </section>
      {creating ? (
        <Modal title={t('新建人物', 'New character')} onClose={() => { setCreating(false) }} footer={<Button variant="primary" busy={busy} disabled={name.trim().length === 0} onClick={create}>{t('创建', 'Create')}</Button>}>
          <Field label={t('姓名', 'Name')}><TextInput autoFocus value={name} onChange={(event) => { setName(event.target.value) }} onKeyDown={(event) => { if (plainEnter(event) && name.trim().length > 0) create() }} /></Field>
        </Modal>
      ) : null}
      {confirm.element}
    </div>
  )
}

/** What a chapter is to a life, where it is more than one they are in. */
export const LIFE_MARK: Record<LifeEvent['kind'], [string, string]> = { enter: ['登场', 'comes on'], seen: ['', ''], return: ['回归', 'returns'], exit: ['离开', 'leaves'], death: ['死亡', 'dies'] }

/** What the author can write down of a life at a chapter, in the words of the form. */
const MARK_KINDS: { value: LifeMark['kind']; label: [string, string] }[] = [
  { value: 'enter', label: ['登场', 'comes on'] },
  { value: 'return', label: ['回归', 'comes back'] },
  { value: 'exit', label: ['离开故事', 'leaves the story'] },
  { value: 'death', label: ['死亡', 'dies'] },
]
/** The chapter of a mark that lies before the story begins, as the form names it. */
const BEFORE = ''

/**
 * Somebody's life on the page: a strip of the line's chapters with the ones
 * they are in filled, a line saying where they come on, stay and leave, what
 * the author wrote down of it themselves — over the digests, where a digest
 * missed something or has it wrong —, the paragraph that tells it, and every
 * chapter's note behind a fold.
 */
function LifeBlock({ card, lives, value, dirty, onChange }: { card: CharacterCard; lives: Lives; value: string; dirty: boolean; onChange: (value: string) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [open, setOpen] = useState(false)
  const life = lives.lives[card.id]
  const writing = useRunningJob(job => job.kind === 'bible' && job.title.startsWith('life ') && job.target === card.id) !== undefined
  const titles = useMemo(() => new Map(lives.chapters.map(chapter => [chapter.id, chapter.title])), [lives.chapters])
  const at = useMemo(() => new Map((life?.events ?? []).map(event => [event.index, event])), [life])
  const digested = lives.chapters.filter(chapter => chapter.digested).length
  const write = (): Promise<unknown> => controller.guard(async () => {
    await controller.run('ai.characterLife', { root, id: card.id, ...(lives.line !== undefined ? { line: lives.line.id } : {}) })
    controller.toast('success', t('履历写好了', 'The life is written'))
  })
  // ── what the author writes down themselves ──
  const marks = card.lifeMarks ?? []
  const [marking, setMarking] = useState<{ chapter: string; kind: LifeMark['kind']; what: string } | undefined>()
  const onLine = useMemo(() => new Map(lives.chapters.map(chapter => [chapter.id, chapter])), [lives.chapters])
  // A chapter of another line of the plot, or one taken out of the book since: named as far as it can be.
  const elsewhere = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter.title])), [project.chapters, project.lines])
  const whereOf = (mark: LifeMark): string => {
    if (mark.chapter === undefined) return t('故事开始之前', 'Before the story begins')
    const here = onLine.get(mark.chapter)
    if (here !== undefined) return t(`第 ${here.index} 章 ${here.title}`, `Ch. ${here.index} ${here.title}`)
    const title = elsewhere.get(mark.chapter)
    return title !== undefined ? t(`《${title}》（不在这条线上）`, `"${title}" (not on this line)`) : t('一章已经不在书里的章节', 'a chapter no longer in the book')
  }
  const saveMark = (chapter: string | undefined, kind: LifeMark['kind'] | undefined, what?: string): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('character.mark', { root, id: card.id, ...(chapter !== undefined && chapter !== BEFORE ? { chapter } : {}), ...(kind !== undefined ? { kind } : {}), ...(what !== undefined && what.trim().length > 0 ? { what: what.trim() } : {}) })
    setMarking(undefined)
    controller.toast('success', kind !== undefined ? t('记下了：履历已按它重读', 'Written down: the life is read with it') : t('去掉了这一笔', 'The mark is taken back'))
  })
  const start = (mark?: LifeMark): void => {
    // Where the digests end is where something is most likely to be missing.
    const latest = lives.chapters.filter(chapter => chapter.digested).at(-1) ?? lives.chapters.at(-1)
    setMarking(mark !== undefined ? { chapter: mark.chapter ?? BEFORE, kind: mark.kind, what: mark.what ?? '' } : { chapter: latest?.id ?? BEFORE, kind: 'death', what: '' })
  }
  const told = lifeLine(life, true) !== undefined ? t(lifeLine(life, true)!, lifeLine(life, false)!) : undefined
  const gone = lifeEnd(life, true)
  const eventAt = (event: LifeEvent): string => (event.index < 1 ? t('故事开始之前', 'Before the story begins') : `${t(`第 ${event.index} 章`, `Ch. ${event.index}`)} ${titles.get(event.chapter) ?? ''}`)
  return (
    <section className="nv-life">
      <SectionTitle actions={(
        <>
          <Button size="sm" variant="ghost" icon="pen" onClick={() => { if (marking !== undefined) setMarking(undefined); else start() }} title={t('亲手记一笔：登场、回归、离开或死亡', 'Write one down yourself: an entrance, a return, a leaving, a death')}>{t('记一笔', 'Write a mark')}</Button>
          <Button size="sm" icon="feather" disabled={dirty || life === undefined} busy={writing} pending={t('场记正在写…', 'Continuity is writing…')} onClick={write} title={dirty ? t('先保存当前修改', 'Save your edits first') : life === undefined ? t('还没有哪一章的收录里记到这个人', 'No chapter\'s digest names them yet') : t('让场记把这个人的经历写成一段话', 'Have the scribe write what this person has lived through as a paragraph')}>{value.length > 0 ? t('重写一段', 'Write it again') : t('写成一段话', 'Tell it in a paragraph')}</Button>
        </>
      )}>{t('履历', 'Life on the page')}{lives.line !== undefined ? <span className="nv-muted"> · {lives.line.title}</span> : null}</SectionTitle>
      {lives.chapters.length > 0 ? (
        <div className="nv-life-strip" role="img" aria-label={t('各章是否在场', 'Presence, chapter by chapter')}>
          {lives.chapters.map((chapter) => {
            const event = at.get(chapter.index)
            return (
              <button
                key={chapter.id}
                type="button"
                className={cx('nv-life-tick', event !== undefined && 'is-on', event !== undefined && event.kind !== 'seen' && `is-${event.kind}`, event?.marked === true && 'is-marked', !chapter.digested && event === undefined && 'is-unread')}
                title={`${t(`第 ${chapter.index} 章`, `Ch. ${chapter.index}`)} · ${chapter.title}${event !== undefined ? ` — ${event.kind !== 'seen' ? `${t(...LIFE_MARK[event.kind])}${event.what !== undefined ? '：' : ''}` : ''}${event.what ?? (event.kind === 'seen' ? t('在场', 'present') : '')}${event.marked === true ? t('（你记的）', ' (your mark)') : ''}` : chapter.digested ? '' : t('（这一章还没有收录）', ' (not digested yet)')}`}
                onClick={() => { controller.setView('read', chapter.id) }}
              />
            )
          })}
        </div>
      ) : null}
      {told !== undefined ? (
        <p className="nv-life-line">
          <span className={cx(gone?.dead === true && 'is-dead')}>{told}</span>
          <span className="nv-muted">{t(`共 ${life!.events.filter(event => event.index >= 1).length} 章，这条线已收录 ${digested} / ${lives.chapters.length} 章`, `${life!.events.filter(event => event.index >= 1).length} chapter(s); ${digested} of this line's ${lives.chapters.length} digested`)}</span>
        </p>
      ) : (
        <p className="nv-muted nv-small">{digested === 0 ? t('这条线上还没有收录过的章节。', 'No chapter of this line is digested yet.') : t(`已收录的 ${digested} 章里都没有记到这个人。`, `None of the ${digested} digested chapters names them.`)}</p>
      )}
      {marks.length > 0 || marking !== undefined ? (
        <div className="nv-life-marks">
          {marks.length > 0 ? (
            <ul>
              {marks.map(mark => (
                <li key={mark.chapter ?? BEFORE}>
                  <Chip tone={mark.kind === 'death' ? 'red' : mark.kind === 'exit' ? 'amber' : 'green'}>{t('你记的', 'Your mark')}</Chip>
                  <span>{whereOf(mark)} · {mark.chapter === undefined ? (mark.kind === 'death' ? t('已故', 'dead') : t('已离开', 'gone')) : t(...MARK_KINDS.find(kind => kind.value === mark.kind)!.label)}{mark.what !== undefined ? <span className="nv-muted"> — {mark.what}</span> : null}</span>
                  <Button size="sm" variant="ghost" icon="pen" onClick={() => { start(mark) }} title={t('改这一笔', 'Change this mark')} />
                  <Button size="sm" variant="ghost" icon="x" pending={t('正在去掉…', 'Taking it back…')} onClick={() => saveMark(mark.chapter, undefined)} title={t('去掉这一笔：这一章回到收录里的说法', 'Take this mark back: the chapter goes by its digest again')} />
                </li>
              ))}
            </ul>
          ) : null}
          {marking !== undefined ? (
            <div className="nv-life-mark-form">
              <Select value={marking.chapter} options={[{ value: BEFORE, label: t('故事开始之前', 'Before the story begins') }, ...lives.chapters.map(chapter => ({ value: chapter.id, label: t(`第 ${chapter.index} 章 ${chapter.title}`, `Ch. ${chapter.index} ${chapter.title}`) }))]} onChange={(chapter) => { setMarking({ ...marking, chapter, ...(chapter === BEFORE && marking.kind !== 'death' && marking.kind !== 'exit' ? { kind: 'death' as const } : {}) }) }} />
              <Select value={marking.kind} options={MARK_KINDS.filter(kind => marking.chapter !== BEFORE || kind.value === 'death' || kind.value === 'exit').map(kind => ({ value: kind.value, label: marking.chapter === BEFORE ? (kind.value === 'death' ? t('已故', 'dead') : t('已离开', 'gone')) : t(...kind.label) }))} onChange={(kind) => { setMarking({ ...marking, kind }) }} />
              <TextInput value={marking.what} placeholder={t('发生了什么', 'What happened')} onChange={(event) => { setMarking({ ...marking, what: event.target.value }) }} />
              <Button size="sm" variant="primary" pending={t('正在记下…', 'Writing it down…')} onClick={() => saveMark(marking.chapter, marking.kind, marking.what)}>{t('记下', 'Write it down')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setMarking(undefined) }}>{t('取消', 'Cancel')}</Button>
              <p className="nv-muted nv-small">{t('你记的盖过收录对这一章的说法；一章只记一笔。', 'Your mark overrides what the digest says of the chapter; one mark per chapter.')}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      <Field label={t('履历', 'Their course')} hint={t('这个人在书里实际经历了什么', 'What this person has lived through in the book')}>
        <TextArea value={value} minRows={2} maxRows={10} onChange={(event) => { onChange(event.target.value) }} />
      </Field>
      {life !== undefined && life.events.length > 0 ? (
        <>
          <button type="button" className="nv-link nv-small" onClick={() => { setOpen(!open) }}>{open ? t('收起逐章记录', 'Fold the chapter notes') : t(`逐章记录（${life.events.length}）`, `Chapter by chapter (${life.events.length})`)}</button>
          {open ? (
            <ol className="nv-life-events">
              {life.events.map(event => (
                <li key={`${event.index}:${event.chapter}`} className={cx(event.kind !== 'seen' && `is-${event.kind}`)}>
                  {event.index >= 1 ? <button type="button" className="nv-link" onClick={() => { controller.setView('read', event.chapter) }}>{eventAt(event)}</button> : <span>{eventAt(event)}</span>}
                  {event.kind !== 'seen' ? <Chip tone={event.kind === 'death' ? 'red' : event.kind === 'exit' ? 'amber' : 'green'}>{t(...LIFE_MARK[event.kind])}</Chip> : null}
                  {event.marked === true ? <Chip tone="neutral">{t('你记的', 'Your mark')}</Chip> : null}
                  <span>{event.what ?? ''}{event.state !== undefined ? <span className="nv-muted">{event.what !== undefined ? ' — ' : ''}{t('章末：', 'at its end: ')}{event.state}</span> : null}{event.where !== undefined ? <span className="nv-muted"> @ {event.where}</span> : null}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function CharacterEditor({ card, lives, onDeleted }: { card: CharacterCard; lives?: Lives | undefined; onDeleted: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [draft, setDraft] = useState<CharacterCard>(card)
  const [dirty, setDirty] = useState(false)
  const [direction, setDirection] = useState('')
  const { busy, run } = useAction()
  const assist = useAssist()
  const confirm = useConfirm()
  const mediaUrl = useMediaUrl()
  const settings = useSnapshot(snapshot => snapshot.settings)
  useEffect(() => { if (settings === undefined) void controller.loadSettings().catch(() => {}) }, [controller, settings])
  // Changes from elsewhere (the agent, an AI assist) replace the form unless it has unsaved edits.
  useEffect(() => { if (!dirty) setDraft(card) }, [card, dirty])
  const set = <K extends keyof CharacterCard>(key: K, value: CharacterCard[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const text = (key: 'tagline' | 'gender' | 'age' | 'appearance' | 'personality' | 'background' | 'motivation' | 'flaw' | 'arc' | 'voice' | 'abilities' | 'secrets' | 'notes') => ({
    value: draft[key] ?? '',
    onChange: (event: { target: { value: string } }) => { set(key, event.target.value) },
  })
  const persona = draft.persona ?? {}
  // The finer points older cards keep apart: shown while they hold something, to be folded into the three fields a card keeps.
  const details = detailsOf(draft)
  const zh = /[\u3400-\u9fff]/u.test(`${draft.name}${draft.personality ?? ''}${draft.background ?? ''}`) || project.manifest.language.toLowerCase().startsWith('zh')
  const around = useMemo(() => project.characters.map(other => ({ id: other.id, name: other.name, role: other.role, face: other.visual?.portrait ?? other.visual?.sheet, sheet: other.visual?.portrait === undefined && other.visual?.sheet !== undefined && other.visual.sheetFront !== true })), [project.characters])
  const setPersona = (patch: Partial<NonNullable<CharacterCard['persona']>>): void => { set('persona', { ...persona, ...patch }) }
  const save = (): Promise<unknown> => run(async () => {
    // Empty strings clear fields on the Host; arrays are sent whole.
    const payload: Record<string, unknown> = { ...draft, aliases: draft.aliases ?? [], relationships: draft.relationships ?? [], tags: draft.tags ?? [] }
    for (const key of ['tagline', 'gender', 'age', 'appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice', 'abilities', 'secrets', 'notes', 'life']) {
      if (payload[key] === undefined) payload[key] = ''
    }
    // What the author wrote down of their life has its own way in: a form opened before a mark was made would write an old list back.
    delete payload.lifeMarks
    await controller.api.call('character.save', { root, card: payload as Partial<CharacterCard> })
    setDirty(false)
    controller.toast('success', t('已保存', 'Saved'))
  })
  // On which lines of the plot they are seen: asked only of a book that has more than one. (A Host from before answers with an error: then nothing is shown.)
  const seen = useLoad(async signal => ((project.lines ?? []).length > 0 ? await controller.api.call('lines.seen', { root }, signal).catch(() => undefined) : undefined), [root, project.revision])
  const presence = project.presence.find(entry => entry.character === card.id)
  const told = lives?.lives[card.id]?.first !== undefined ? lives.lives[card.id] : undefined
  const voices: VoiceOption[] = settings?.voices ?? []
  const voiceProfile = draft.voiceProfile ?? {}
  // Work on this card that is still running — also when it was started before this screen was opened.
  const anchoring = useRunningJob(job => job.kind === 'bible' && job.title.startsWith('visual anchor') && job.target === card.id) !== undefined
  const drawing = useRunningJob(job => job.kind === 'illustrate' && job.target === card.id)
  const designing = useRunningJob(job => job.kind === 'audio' && job.title === 'design voice' && job.target === card.id) !== undefined
  const [sample, setSample] = useState<{ path: string; at: number } | undefined>()
  const audition = (): Promise<unknown> | undefined => {
    if (!controller.need('tts')) return undefined
    return controller.guard(async () => {
      // By character, so what is heard is the voice their lines will have — the one on the card, or the one cast for them.
      const started = await controller.api.call('voice.audition', { root, character: card.id, text: t(`我是${card.name}。有些话，我只说一遍。`, `I am ${card.name}. Some things I only say once.`) }) as { jobId?: string; path?: string }
      // Shown as work in progress at once, with its stages, wherever the author looks.
      void controller.refreshJobs()
      // A Host from before auditions became jobs answers with the sample itself.
      const path = started.jobId !== undefined ? ((await controller.follow(started.jobId).done).result?.output as { path?: string } | undefined)?.path : started.path
      if (path === undefined) return
      setSample({ path, at: Date.now() })
      void new Audio(mediaUrl(path, Date.now())).play().catch(() => {})
    })
  }
  // Ideas jotted down beside the buttons, mixed as they come: the director sorts them when a picture is drawn —
  // what is of the person into their look, what is of that one picture into that picture and nowhere else.
  const [notes, setNotes] = useState('')
  const [sorted, setSorted] = useState<{ kind: 'sheet' | 'portrait'; how: SortedNotes } | undefined>()
  // Which moment of the book the portrait just drawn shows: the director's pick, or the one the card had.
  const [pictured, setPictured] = useState<(PortraitScene & { path?: string | undefined }) | undefined>()
  // Which of their moments the next portrait shows: an id, 'plain' for none of them, '' for the one the card marks.
  const [moment, setMoment] = useState('')
  const sheets = useSheetsAsk()
  // What each of the two is drawn against. Left alone, it is as the setting has it (which of the two leads); chosen
  // here, it is the author's word for the pictures drawn from this page — said with each, whatever the setting.
  const [portraitFrom, setPortraitFrom] = useState<'sheet' | 'words' | undefined>()
  const [sheetFrom, setSheetFrom] = useState<'portrait' | 'words' | undefined>()
  useEffect(() => {
    setPortraitFrom(undefined)
    setSheetFrom(undefined)
  }, [card.id])
  const draw = (kind: 'sheet' | 'portrait', done: string, look?: string, scene?: string, stage?: string): Promise<unknown> | undefined => {
    if (!controller.need('image')) return undefined
    // A look (outfit) is described on its own row; the ideas here are for the main sheet and the portrait.
    const jotted = look === undefined && stage === undefined ? notes.trim() : ''
    // The card's own two pictures: a look, and a stretch of their life, go by the setting.
    const from = look !== undefined || stage !== undefined ? undefined : kind === 'portrait' ? portraitFrom : sheetFrom === 'portrait' && card.visual?.portrait === undefined ? undefined : sheetFrom
    const go = (choice: SheetsChoice): Promise<unknown> => controller.guard(async () => {
      const job = await controller.run('image.create', { root, kind, target: card.id, ...(look !== undefined ? { look } : {}), ...(jotted.length > 0 ? { notes: jotted } : {}), ...(stage !== undefined ? { stage } : {}), ...(kind !== 'portrait' || stage !== undefined ? {} : (scene ?? moment) === 'plain' ? { plain: true } : (scene ?? moment).length > 0 ? { scene: scene ?? moment } : {}), ...(from !== undefined ? { from } : {}), ...choice })
      const how = job.result?.sorted as SortedNotes | undefined
      if (how !== undefined) {
        setSorted({ kind, how })
        setNotes('')
      }
      const shown = kind === 'portrait' ? sceneOf(job) : undefined
      // One of the card's own moments shows in its row; what is said here is what the author could not have known: a moment settled for this picture alone, or none.
      if (kind === 'portrait') setPictured(shown?.asked !== undefined || shown?.none !== undefined ? { ...shown, path: (job.result?.output as { path?: string } | undefined)?.path } : undefined)
      controller.toast('success', `${done}${shown?.title !== undefined ? t(`：${shown.title}`, `: ${shown.title}`) : ''}${sheetsDrawn(job, t)}`)
    })
    // A portrait of somebody without a design sheet draws the sheet first: asked, before anything is drawn.
    return kind === 'portrait' ? sheets.before([{ kind: 'portrait', target: card.id, ...(from === 'sheet' || from === 'words' ? { from } : {}) }], go) : go({})
  }

  // What is on record of how each picture was made: shown with the picture when it is opened large — and read here
  // for one thing, a portrait that was not drawn against the sheet in use (the sheet was drawn, or drawn again, after it).
  const records = usePictures()
  // Every portrait kept of them, the face first — and those the gallery still has of them that are on no list yet
  // (drawn before portraits were kept side by side): shown after the others, to be ordered in or removed.
  const listed = draft.visual?.portraits ?? (draft.visual?.portrait !== undefined ? [draft.visual.portrait] : [])
  const ofStages = new Set((draft.stages ?? []).map(stage => stage.visual?.portrait).filter((path): path is string => path !== undefined))
  const earlier = [...records.byPath.values()]
    .filter(image => image.kind === 'portrait' && image.target === card.id && !listed.includes(image.path) && !ofStages.has(image.path))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(image => image.path)
  const portraits = [...listed, ...earlier]
  // The pictures there are of this person: their portraits, the design sheet, and a sheet per look.
  const pictures: { key: string; label: string; path: string; wide: boolean }[] = [
    ...portraits.map((path, index) => ({ key: `portrait:${path}`, label: index === 0 ? t('立绘', 'Portrait') : t(`立绘 ${index + 1}`, `Portrait ${index + 1}`), path, wide: false })),
    ...(draft.visual?.sheet !== undefined ? [{ key: 'sheet', label: t('人设图', 'Design sheet'), path: draft.visual.sheet, wide: true }] : []),
    ...(draft.visual?.looks ?? []).filter(look => look.sheet !== undefined).map(look => ({ key: `look:${look.id}`, label: look.name.length > 0 ? look.name : t('造型', 'Look'), path: look.sheet!, wide: true })),
  ]
  const [picked, setPicked] = useState<string | undefined>()
  // The picture opened large: one of the strip's, or the portrait of one of their moments.
  const [viewing, setViewing] = useState<string | undefined>()
  const picture = pictures.find(item => item.key === picked) ?? pictures[0]
  const sheetBusy = drawing?.title === 'illustrate sheet'
  const portraitBusy = drawing?.title === 'illustrate portrait'
  const portraitOf = draft.visual?.portrait !== undefined ? records.byPath.get(draft.visual.portrait) : undefined
  // Which of the two leads says which may have fallen behind: the portrait, where it is drawn against the sheet; the
  // sheet, where it is drawn against the portrait.
  // The image settings as this book has them: the Studio's, with what the book has its own way with.
  const image = settings !== undefined ? withBookImage(settings.settings.image, project.manifest.image) : undefined
  const lead = image !== undefined ? leadOf(image) : 'sheet'
  const sheetOf = draft.visual?.sheet !== undefined ? records.byPath.get(draft.visual.sheet) : undefined
  const hasSheet = draft.visual?.sheet !== undefined
  const hasPortrait = draft.visual?.portrait !== undefined
  // What each is drawn against as things stand: the author's choice here, else what the setting comes to for this person.
  const portraitAgainst: 'sheet' | 'words' = portraitFrom ?? (lead === 'sheet' || (lead === 'none' && hasSheet) ? 'sheet' : 'words')
  const sheetAgainst: 'portrait' | 'words' = hasPortrait ? sheetFrom ?? (lead === 'portrait' ? 'portrait' : 'words') : 'words'
  const portraitBehind = portraitAgainst === 'sheet' && portraitOf !== undefined && hasSheet && !(portraitOf.parts?.references ?? []).some(reference => reference.path === draft.visual!.sheet)
  const sheetBehind = sheetAgainst === 'portrait' && sheetOf !== undefined && hasPortrait && !(sheetOf.parts?.references ?? []).some(reference => reference.path === draft.visual!.portrait)
  // Where the portrait shown stands among their portraits, and the way to another place: the first is their face.
  const placed = picture !== undefined && picture.key.startsWith('portrait:') ? portraits.indexOf(picture.path) : -1
  const place = (to: number): Promise<unknown> => controller.guard(async () => {
    if (placed < 0 || to < 0 || to >= portraits.length) return
    const next = portraits.filter((_, index) => index !== placed)
    next.splice(to, 0, portraits[placed]!)
    await controller.api.call('character.save', { root, card: { id: card.id, visual: { portraits: next } } })
    // Shown at once: the order is what was just asked for.
    await controller.refreshProject()
  })
  const anchorField = `nv-anchor-${card.id}`
  const sceneField = `nv-scene-${card.id}`
  const scenic = image?.portraitScene !== false
  const moments = scenesOf(draft)
  const marked = sceneFor(draft)

  return (
    <div className={cx('nv-person-page', pictures.length === 0 && 'is-bare')}>
      <aside className="nv-person-figure">
        {picture !== undefined ? (
          <button type="button" className={cx('nv-person-picture', picture.wide && 'is-wide')} onClick={() => { setViewing(picture.path) }} title={t('点开看大图', 'Open it large')}>
            <ProjectImage path={picture.path} alt={`${draft.name} · ${picture.label}`} />
          </button>
        ) : (
          <div className="nv-person-picture is-empty">
            <span aria-hidden="true">{draft.name.slice(0, 1)}</span>
            <em>{t('还没有画像', 'No picture yet')}</em>
          </div>
        )}
        {picture !== undefined ? (
          <div className="nv-person-picture-tools">
            {placed >= 0 && portraits.length > 1 ? (
              <>
                <Button size="sm" variant="ghost" icon="chevronLeft" disabled={dirty || placed === 0} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('往前排', 'Move it forward')} onClick={() => place(placed - 1)} />
                <Button size="sm" variant="ghost" icon="chevronRight" disabled={dirty || placed === portraits.length - 1} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('往后排', 'Move it back')} onClick={() => place(placed + 1)} />
                {placed === 0
                  ? <span className="nv-muted nv-small">{t('第一张：列表和头像用它', 'The first: their face in the lists')}</span>
                  : <Button size="sm" variant="ghost" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => place(0)}>{t('设为第一张', 'Make it the first')}</Button>}
                <span className="nv-spacer" />
              </>
            ) : null}
            <DeletePicture bare path={picture.path} disabled={dirty} onDone={() => { setPicked(undefined) }} />
          </div>
        ) : null}
        {pictures.length > 1 ? (
          <div className="nv-person-thumbs" role="group" aria-label={t('这个人物的图', 'Pictures of this character')}>
            {pictures.map(item => (
              <button key={item.key} type="button" className={cx(item.key === picture?.key && 'is-active', item.wide && 'is-wide')} onClick={() => { setPicked(item.key) }} title={item.label}>
                <ProjectImage path={item.path} alt={item.label} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="nv-person-draw">
          <Button size="sm" variant={draft.visual?.portrait === undefined ? 'primary' : 'outline'} icon="image" disabled={dirty || (drawing !== undefined && !portraitBusy)} busy={portraitBusy} pending={t('正在画立绘…', 'Drawing the portrait…')} onClick={() => draw('portrait', t('立绘已生成', 'Portrait ready'))} title={dirty ? t('先保存当前修改', 'Save your edits first') : portraitAgainst === 'words' ? t('只照文字画', 'Drawn from the words alone') : hasSheet ? t('照着人设图画', 'Drawn against the design sheet') : t('先画人设图，再照着它画立绘', 'The design sheet is drawn first, then the portrait against it')}>{draft.visual?.portrait !== undefined ? t('重画立绘', 'Redraw portrait') : t('画立绘', 'Draw portrait')}</Button>
          <Button size="sm" variant="outline" icon="users" disabled={dirty || (drawing !== undefined && !sheetBusy)} busy={sheetBusy} pending={t('正在画人设图…', 'Drawing the sheet…')} onClick={() => draw('sheet', t('人设图已生成', 'Design sheet ready'))} title={dirty ? t('先保存当前修改', 'Save your edits first') : sheetAgainst === 'portrait' ? t(`${image?.sheet === 'front' ? '正面全身' : '三视图'}，照着立绘画`, `${image?.sheet === 'front' ? 'The front view' : 'Three views'}, drawn against the portrait`) : t(`${image?.sheet === 'front' ? '正面全身' : '三视图'}，只照文字画：视觉锚点、画风和下面写的想法`, `${image?.sheet === 'front' ? 'The front view' : 'Three views'}, drawn from the words alone: the visual anchor, the art direction and the ideas below`)}>{draft.visual?.sheet !== undefined ? t('重画人设图', 'Redraw sheet') : t('生成人设图', 'Design sheet')}</Button>
        </div>
        <label className="nv-person-moment" title={t('这一页画的立绘照着什么画；不选就是 设置 → 图像生成 里定的', 'What a portrait drawn from this page is held against; left alone, as Settings → Images has it')}>
          <span>{t('立绘照着', 'Portrait from')}</span>
          <Select
            value={portraitAgainst}
            onChange={setPortraitFrom}
            options={[
              { value: 'sheet', label: hasSheet ? t('人设图', 'The design sheet') : t('人设图（先补一张）', 'The design sheet (drawn first)') },
              { value: 'words', label: t('只照文字', 'The words alone') },
            ]}
          />
        </label>
        <label className="nv-person-moment" title={t('这一页画的人设图照着什么画；不选就是 设置 → 图像生成 里定的', 'What a design sheet drawn from this page is held against; left alone, as Settings → Images has it')}>
          <span>{t('人设图照着', 'Sheet from')}</span>
          <Select
            value={sheetAgainst}
            onChange={setSheetFrom}
            options={[
              { value: 'portrait', label: hasPortrait ? t('现在的立绘', 'The portrait') : t('立绘（还没有）', 'The portrait (none yet)'), disabled: !hasPortrait },
              { value: 'words', label: t('只照文字', 'The words alone') },
            ]}
          />
        </label>
        {portraitAgainst === 'sheet' && sheetAgainst === 'portrait' && hasSheet ? <p className="nv-muted nv-small">{t('两张互相照着：重画哪张都会像另一张。', 'Each is held against the other: either, drawn again, comes back like the other.')}</p> : null}
        {portraitBehind ? <p className="nv-muted nv-small">{t('立绘不是照现在这张人设图画的。', 'The portrait was not drawn against the sheet in use now.')}</p> : null}
        {sheetBehind ? <p className="nv-muted nv-small">{t('人设图不是照现在这张立绘画的。', 'The sheet was not drawn against the portrait in use now.')}</p> : null}
        {scenic ? (
          <label className="nv-person-moment">
            <span>{t('立绘画', 'Portrait shows')}</span>
            <Select
              value={moment !== '' && (moment === 'plain' || moments.some(scene => scene.id === moment)) ? moment : marked?.id ?? ''}
              onChange={setMoment}
              options={[
                ...(moments.length === 0 ? [{ value: '', label: t('名场面（导演从书里找）', 'A signature scene (the director finds them)') }] : []),
                ...moments.map(scene => ({ value: scene.id, label: scene.title.length > 0 ? scene.title : t('未命名的一幕', 'An unnamed moment') })),
                { value: 'plain', label: t('素底定妆照', 'A plain likeness') },
              ]}
            />
          </label>
        ) : null}
        <div className="nv-person-notes">
          <TextArea value={notes} minRows={2} maxRows={8} placeholder={t('想法，可不填：左眉有道疤；这张要雪夜，回头看', 'Ideas, if any: a scar through the left brow; this one on a snowy night, looking back')} onChange={(event) => { setNotes(event.target.value) }} />
          {pictured !== undefined ? (
            <div className="nv-person-sorted">
              <strong>{pictured.text !== undefined ? pictured.title ?? t('这张立绘画的是', 'This portrait shows') : t('没有照名场面画', 'Drawn without a scene')}</strong>
              <Button size="sm" variant="ghost" icon="x" onClick={() => { setPictured(undefined) }} title={t('知道了', 'Got it')} />
              <p>{pictured.text ?? pictured.none}</p>
              {pictured.why !== undefined ? <p className="nv-muted">{pictured.why}</p> : null}
              {pictured.text !== undefined && pictured.asked !== undefined ? (
                <p>
                  <button type="button" className="nv-link" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => controller.guard(async () => {
                    const kept: SignatureScene = { id: `scene-${Date.now().toString(36)}`, title: pictured.title ?? '', text: pictured.text!, ...(pictured.chapter !== undefined ? { chapter: pictured.chapter } : {}), ...(pictured.why !== undefined ? { why: pictured.why } : {}), ...(pictured.path !== undefined ? { portrait: pictured.path } : {}) }
                    await controller.api.call('character.save', { root, card: { id: card.id, visual: { scenes: [...scenesOf(card), kept], scene: '' } } })
                    setPictured(undefined)
                    controller.toast('success', t('加进名场面了', 'Added to their signature scenes'))
                  })}>{t('加进名场面', 'Add to their signature scenes')}</button>
                </p>
              ) : null}
            </div>
          ) : null}
          {sorted !== undefined ? (
            <div className="nv-person-sorted">
              <strong>{t('想法是这样分的', 'How the ideas were sorted')}</strong>
              <Button size="sm" variant="ghost" icon="x" onClick={() => { setSorted(undefined) }} title={t('知道了', 'Got it')} />
              {sorted.how.unsorted === true ? <p>{t('导演没能整理：全部只用在了这一张。', 'The director could not sort them: all of it went into this one picture.')}</p> : (
                <ul>
                  <li><span>{t('进了这个人的形象', 'Into how they look')}</span>{sorted.how.kept.length > 0 ? sorted.how.kept.join(t('；', '; ')) : t('没有', 'nothing')}</li>
                  <li><span>{t('只用在这一张', 'This picture only')}</span>{sorted.how.once.length > 0 ? sorted.how.once.join(t('；', '; ')) : t('没有', 'nothing')}</li>
                  {sorted.how.unused.length > 0 ? <li><span>{t('这张图用不上', 'No place in this picture')}</span>{sorted.how.unused.join(t('；', '; '))}</li> : null}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </aside>

      <div className="nv-editor-form nv-person-main">
      <header className="nv-detail-head nv-person-head">
        <div className="nv-person-title">
          <h2>{draft.name}<Chip tone="neutral">{t(...ROLE_LABELS[draft.role])}</Chip></h2>
          {draft.tagline !== undefined && draft.tagline.length > 0 ? <p className="nv-person-tagline">{draft.tagline}</p> : null}
          <LineTags lines={draft.lines} seen={seen.data?.people[card.id]} />
          <span className="nv-muted nv-small">
            {/* Where they are in the book is their life, along the line looked at — told in full just below. */}
            {told !== undefined
              ? `${t(lifeLine(told, true) ?? '', lifeLine(told, false) ?? '')}${lives?.line !== undefined ? t(`（${lives.line.title}）`, ` (${lives.line.title})`) : ''}`
              : lives !== undefined ? t('尚未在正文中出场', 'Not on the page yet')
                : presence !== undefined && presence.chapters.length > 0 ? t(`出场 ${presence.chapters.length} 章`, `In ${presence.chapters.length} chapters`) : t('尚未在正文中出场', 'Not on the page yet')}
            {' · '}
            <button type="button" className="nv-link" onClick={() => { controller.openCast('lives') }} title={t('所有人的履历表', 'Everyone\'s course in one table')}>{t('履历表', 'Life table')}</button>
            {' · '}
            <button type="button" className="nv-link" onClick={() => { controller.openCast('relations') }}>{t('关系图', 'Relationships')}</button>
          </span>
        </div>
        <div className="nv-row">
          <HistoryButton kind="character" id={card.id} name={card.name} onRestored={() => { setDirty(false) }} />
          <Button variant="ghost" size="sm" icon="trash" busy={busy} onClick={() => { confirm.ask(t(`删除人物「${card.name}」？`, `Delete the character "${card.name}"?`), () => { void run(async () => { await controller.api.call('character.delete', { root, id: card.id }); onDeleted() }) }) }} title={t('删除这张人物卡', 'Delete this card')} />
          <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
          <ViewButton onClick={() => { controller.openExplore({ type: 'character', id: card.id }) }} title={t('观看：这个人在“观看 → 人物”里的样子', 'View: as they are under Watch → People')} />
        </div>
      </header>

      {lives !== undefined ? <LifeBlock card={card} lives={lives} value={draft.life ?? ''} dirty={dirty} onChange={(value) => { set('life', value) }} /> : null}
      <TiesBlock of={{ type: 'character', id: card.id }} />

      <div className="nv-assist">
        <TextInput value={direction} placeholder={t('想补全的方向，如：给他一个不愿提起的过去', 'What to fill in, e.g. a past he will not speak of')} onChange={(event) => { setDirection(event.target.value) }} />
        <Button icon="sparkles" busy={assist.running} pending={t('AI 正在补全…', 'Completing…')} disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => { assist.start(async (onText) => { await controller.run('character.expand', { root, id: card.id, ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, onText); setDirection('') }) }}>{t('AI 补全', 'Complete')}</Button>
      </div>
      {assist.stream.length > 0 ? <pre className="nv-stream">{assist.stream.slice(-800)}</pre> : null}

      <SectionTitle>{t('基本', 'Basics')}</SectionTitle>
      <div className="nv-form-grid">
        <Field label={t('姓名', 'Name')}><TextInput value={draft.name} onChange={(event) => { set('name', event.target.value) }} /></Field>
        <Field label={t('别名 / 称呼', 'Aliases')} hint={t('用顿号或逗号分隔', 'Comma separated')}><TextInput value={(draft.aliases ?? []).join('、')} onChange={(event) => { set('aliases', event.target.value.split(/[、,，]+/).map(item => item.trim()).filter(Boolean)) }} /></Field>
        <Field label={t('定位', 'Role')}><Select value={draft.role} options={options(ROLE_LABELS, t)} onChange={(value) => { set('role', value) }} /></Field>
        <LinesField value={draft.lines} onChange={(lines) => { set('lines', lines) }} />
        <Field label={t('性别', 'Gender')}><TextInput {...text('gender')} /></Field>
        <Field label={t('年龄', 'Age')}><TextInput {...text('age')} /></Field>
      </div>
      <Field label={t('一句话人设', 'One-line identity')}><TextInput {...text('tagline')} /></Field>

      <SectionTitle>{t('这个人', 'Who they are')}</SectionTitle>
      <Field label={t('性格与为人', 'How they are')} hint={t('性情、看重什么、弱点、绝不会做的事', 'Temper, what they hold dear, their flaw, what they would never do')}><TextArea {...text('personality')} /></Field>
      <Field label={t('来历与处境', 'Where they come from')} hint={t('出身、经历、本事、藏着的事', 'Origins, what they have lived, what they can do, what they hide')}><TextArea {...text('background')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('想要什么', 'What they want')} hint={t('想要的，和真正需要的', 'What they want, and what they need')}><TextArea {...text('motivation')} /></Field>
        <Field label={t('会怎么变', 'How they change')} hint={t('人物弧光', 'Their arc')}><TextArea {...text('arc')} /></Field>
      </div>
      <Field label={t('说话的样子', 'How they speak')} hint={t('口吻、句式、口头禅；写手据此写对白', 'Register, sentence shape, catchphrases: the writer writes their lines by it')}><TextArea {...text('voice')} /></Field>
      {details.length > 0 ? (
        // What cards once kept apart: there while it holds something, and one press folds it into the fields above.
        <details className="nv-fold nv-person-details">
          <summary>{t(`细项 · ${details.length} 栏有内容`, `Finer points · ${details.length} filled`)}<Button size="sm" variant="ghost" icon="minimize" onClick={(event) => { event.preventDefault(); setDraft(foldDetails(draft, zh)); setDirty(true) }} title={t('写进上面三栏里，这几栏清空；点“保存”才生效', 'Written into the three fields above and cleared here; takes effect on Save')}>{t('并入上面的描述', 'Fold into the above')}</Button></summary>
          <div className="nv-form-grid">
            <Field label={t('弱点', 'Flaw')}><TextArea {...text('flaw')} /></Field>
            <Field label={t('能力', 'Abilities')}><TextArea {...text('abilities')} /></Field>
            <Field label={t('秘密', 'Secrets')}><TextArea {...text('secrets')} /></Field>
            <Field label={t('特质', 'Traits')} hint={t('每行一个', 'One per line')}>
              <TextArea value={(persona.traits ?? []).map(trait => `${trait.name}${trait.level !== undefined ? ` ${trait.level}` : ''}`).join('\n')} onChange={(event) => {
                setPersona({ traits: lines(event.target.value).map((line) => {
                  const match = /^(.*?)[\s:：]*([1-5])$/.exec(line)
                  return match !== null && match[1] !== undefined && match[1].trim().length > 0 ? { name: match[1].trim(), level: Number(match[2]) } : { name: line }
                }) })
              }} />
            </Field>
            <Field label={t('看重的东西', 'Values')}><TextArea value={(persona.values ?? []).join('\n')} onChange={(event) => { setPersona({ values: lines(event.target.value) }) }} /></Field>
            <Field label={t('说话习惯', 'Speech habits')}><TextArea value={(persona.speech ?? []).join('\n')} onChange={(event) => { setPersona({ speech: lines(event.target.value) }) }} /></Field>
            <Field label={t('绝不会', 'Would never')}><TextArea value={(persona.taboos ?? []).join('\n')} onChange={(event) => { setPersona({ taboos: lines(event.target.value) }) }} /></Field>
            <Field label={t('压力下的反应', 'Under pressure')}><TextArea value={persona.underPressure ?? ''} onChange={(event) => { setPersona({ underPressure: event.target.value }) }} /></Field>
          </div>
        </details>
      ) : null}

      <SectionTitle actions={<button type="button" className="nv-link nv-small" onClick={() => { controller.openCast('relations') }}>{t('所有人的关系图', 'Everyone\'s graph')}</button>}>{t('关系', 'Relationships')}</SectionTitle>
      {/* Theirs as a picture — what this card says of others and what the others' cards say of them — before the list it is edited in. */}
      <AroundGraph
        t={t}
        person={{ id: card.id, name: draft.name, role: draft.role, face: card.visual?.portrait ?? card.visual?.sheet, sheet: card.visual?.portrait === undefined && card.visual?.sheet !== undefined && card.visual.sheetFront !== true }}
        others={around}
        bonds={bondsOf(card.id, project.characters.map(other => (other.id === card.id ? { id: other.id, relationships: draft.relationships } : other)))}
        media={path => mediaUrl(path)}
        onOpen={(id) => { controller.openCharacter(id) }}
      />
      <RelationshipEditor value={draft.relationships ?? []} onChange={(value) => { set('relationships', value) }} />

      <StagesPanel
        card={card}
        value={draft.stages ?? []}
        dirty={dirty}
        busy={drawing !== undefined}
        onChange={(stages) => { set('stages', stages) }}
        onDraw={(kind, stage) => draw(kind, kind === 'sheet' ? t(`「${stage.title}」的人设图已生成`, `Sheet of "${stage.title}" ready`) : t(`「${stage.title}」的立绘已生成`, `Portrait of "${stage.title}" ready`), undefined, undefined, stage.id)}
        onOpen={setViewing}
      />

      <SectionTitle actions={<Button size="sm" icon="wand" disabled={dirty} busy={anchoring} pending={t('正在提炼…', 'Distilling…')} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('让导演照人物卡和这本书的画风写视觉锚点', 'Have the director write the visual anchor from the card and the book\'s art direction')} onClick={() => controller.guard(async () => {
        await controller.run('character.visual', { root, id: card.id })
        controller.toast('success', t('视觉锚点已更新', 'Visual anchor updated'))
      })}>{(draft.visual?.prompt ?? '').trim().length > 0 ? t('让导演重写', 'Have the director rewrite it') : t('提炼视觉锚点', 'Distill the anchor')}</Button>}>{t('形象', 'Looks')}</SectionTitle>
      <Field label={t('外貌', 'Appearance')} hint={t('写给读者和写手看的', 'Written for readers and for the writer')}><TextArea {...text('appearance')} /></Field>
      <Field label={t('视觉锚点', 'Visual anchor')} hint={t('写给绘图模型看的短语，每张有此人的图都原样带上', 'Phrases for the image model, restated in every picture of them')}>
        <TextArea id={anchorField} value={draft.visual?.prompt ?? ''} placeholder={t('留空时自动从“外貌”提炼', 'Left empty, it is distilled from Appearance')} onChange={(event) => { set('visual', { ...draft.visual, prompt: event.target.value }) }} />
      </Field>
      <Field label={t('这个人物身上不要画出', 'Never drawn on them')} hint={t('逗号分隔', 'Comma-separated')}>
        <TextInput value={draft.visual?.negative ?? ''} placeholder={t('如：cross emblem, shoulder straps', 'e.g. cross emblem, shoulder straps')} onChange={(event) => { set('visual', { ...draft.visual, negative: event.target.value }) }} />
      </Field>
      <ScenesPanel
        id={sceneField}
        card={card}
        value={moments}
        marked={marked?.id}
        dirty={dirty}
        off={!scenic}
        busy={drawing !== undefined}
        onChange={(scenes, first) => { set('visual', { ...draft.visual, scenes, scene: '', sceneAt: first ?? '' }) }}
        onDraw={scene => draw('portrait', t('立绘已生成', 'Portrait ready'), undefined, scene.id)}
        onOpen={setViewing}
      />
      <LooksEditor
        value={draft.visual?.looks ?? []}
        dirty={dirty}
        onChange={(looks) => { set('visual', { ...draft.visual, looks }) }}
        busy={drawing !== undefined}
        onDraw={look => draw('sheet', t(`「${look.name}」的人设图已生成`, `Sheet of "${look.name}" ready`), look.name)}
      />

      <SectionTitle>{t('配音', 'Speaking voice')}</SectionTitle>
      <div className="nv-form-grid">
        <Field label={t('音色', 'Voice')} hint={t('留空则按性别年龄自动选角', 'Leave empty to cast by gender and age')}>
          <TextInput list={`nv-voices-${card.id}`} value={voiceProfile.voice ?? ''} placeholder={t('音色 ID', 'Voice id')} onChange={(event) => { set('voiceProfile', { ...voiceProfile, voice: event.target.value, ...(settings !== undefined ? { provider: settings.settings.tts.provider } : {}) }) }} />
          <datalist id={`nv-voices-${card.id}`}>{voices.map(voice => <option key={voice.id} value={voice.id}>{`${voice.note}${voice.accent !== undefined ? ` · ${voice.accent}` : ''}`}</option>)}</datalist>
        </Field>
        <Field label={t('表演基调', 'Delivery baseline')}><TextInput value={voiceProfile.instructions ?? ''} placeholder={t('如：语速偏慢，声音低沉', 'e.g. slow, low and steady')} onChange={(event) => { set('voiceProfile', { ...voiceProfile, instructions: event.target.value }) }} /></Field>
      </div>
      <Field label={t('声线设计描述', 'Voice design description')} hint={t('用于"设计专属声线"：年龄感、音色、语速、气质', 'Used to design a voice of their own: age, timbre, pace, temperament')}>
        <TextArea value={voiceProfile.designPrompt ?? ''} onChange={(event) => { set('voiceProfile', { ...voiceProfile, designPrompt: event.target.value }) }} />
      </Field>
      <div className="nv-row-wrap">
        <Button size="sm" icon="volume" disabled={dirty} pending={t('正在生成试听语音…', 'Recording the audition…')} title={t('用这个人物的声音念一句', 'Hear a line in this character\'s voice')} onClick={audition}>{t('试听', 'Audition')}</Button>
        <Button size="sm" icon="wand" disabled={dirty} busy={designing} pending={t('正在设计声线…', 'Designing the voice…')} onClick={() => (controller.need('tts') ? controller.guard(async () => { await controller.run('voice.design', { root, character: card.id }); controller.toast('success', t('专属声线已创建', 'Voice designed')) }) : undefined)}>{t('设计专属声线', 'Design a voice')}</Button>
        {sample !== undefined ? <audio key={sample.at} controls preload="auto" src={mediaUrl(sample.path, sample.at)} className="nv-audio-inline" title={t('刚才的试听', 'The audition just recorded')} /> : voiceProfile.sample !== undefined ? <audio controls preload="none" src={mediaUrl(voiceProfile.sample)} className="nv-audio-inline" title={t('专属声线的样音', 'Sample of the designed voice')} /> : null}
      </div>

      <SectionTitle>{t('备注', 'Notes')}</SectionTitle>
      <TextArea {...text('notes')} minRows={3} maxRows={20} />
      </div>
      {viewing !== undefined ? (
        <PictureViewer
          path={viewing}
          title={`${draft.name} · ${pictures.find(item => item.path === viewing)?.label ?? moments.find(scene => scene.portrait === viewing)?.title ?? (draft.stages ?? []).find(stage => stage.visual?.sheet === viewing || stage.visual?.portrait === viewing)?.title ?? t('立绘', 'Portrait')}`}
          onClose={() => { setViewing(undefined) }}
          // Drawn again, it is the new one that is open: named as what it now is among their pictures.
          onChanged={(now) => { if (now !== undefined) setViewing(now) }}
          onEditLook={(of) => {
            // Their own anchor is on this page, under "Looks": the form scrolls to it.
            if (of.kind === 'character' && of.id === card.id) {
              const field = document.getElementById(of.what === 'scene' ? sceneField : anchorField)
              field?.scrollIntoView({ block: 'center', behavior: 'smooth' })
              field?.focus({ preventScroll: true })
            } else if (of.kind === 'character') controller.openCharacter(of.id)
            else controller.openWorld(of.id)
          }}
        />
      ) : null}
      {confirm.element}
      {sheets.element}
    </div>
  )
}


function RelationshipEditor({ value, onChange }: { value: NonNullable<CharacterCard['relationships']>; onChange: (value: NonNullable<CharacterCard['relationships']>) => void }) {
  const t = useT()
  const { project } = useProject()
  const nameOf = (ref: string): string => project.characters.find(card => card.id === ref)?.name ?? ref
  return (
    <div className="nv-relations">
      {value.map((relation, index) => (
        <div className="nv-relation" key={index}>
          <TextInput list="nv-character-names" value={nameOf(relation.target)} placeholder={t('对方', 'Who')} onChange={(event) => {
            const typed = event.target.value
            const card = project.characters.find(candidate => candidate.name === typed)
            onChange(value.map((item, at) => at === index ? { ...item, target: card?.id ?? typed } : item))
          }} />
          <TextInput value={relation.kind} placeholder={t('关系', 'Relationship')} onChange={(event) => { onChange(value.map((item, at) => at === index ? { ...item, kind: event.target.value } : item)) }} />
          <TextInput value={relation.note ?? ''} placeholder={t('说明', 'Note')} onChange={(event) => { onChange(value.map((item, at) => at === index ? { ...item, note: event.target.value } : item)) }} />
          <Button variant="ghost" size="sm" icon="x" onClick={() => { onChange(value.filter((_item, at) => at !== index)) }} />
        </div>
      ))}
      <datalist id="nv-character-names">{project.characters.map(card => <option key={card.id} value={card.name} />)}</datalist>
      <Button size="sm" icon="plus" variant="ghost" onClick={() => { onChange([...value, { target: '', kind: '' }]) }}>{t('添加关系', 'Add relationship')}</Button>
    </div>
  )
}



/** The stretches of a person's life in the book: from which chapter on, how old, who and how they look — and the pictures drawn of each. */
function StagesPanel({ card, value, dirty, busy, onChange, onDraw, onOpen }: {
  card: CharacterCard
  value: CharacterStage[]
  dirty: boolean
  busy: boolean
  onChange: (stages: CharacterStage[]) => void
  onDraw: (kind: 'sheet' | 'portrait', stage: CharacterStage) => unknown
  onOpen: (path: string) => void
}) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [wish, setWish] = useState('')
  const reading = useRunningJob(job => job.kind === 'bible' && job.title.startsWith('growth') && job.target === card.id) !== undefined
  const chapters = useMemo(() => [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)], [project.chapters, project.lines])
  const patch = (id: string, change: Partial<CharacterStage>): void => { onChange(value.map(stage => (stage.id === id ? { ...stage, ...change } : stage))) }
  const text = (stage: CharacterStage, key: 'title' | 'age' | 'what' | 'appearance' | 'persona') => ({ value: stage[key] ?? '', onChange: (event: { target: { value: string } }) => { const { [key]: _was, ...rest } = stage; onChange(value.map(item => (item.id === stage.id ? (event.target.value.length > 0 || key === 'title' ? { ...rest, [key]: event.target.value } as CharacterStage : rest as CharacterStage) : item))) } })
  return (
    <div className="nv-scenes">
      <SectionTitle actions={<Button size="sm" variant="ghost" icon="plus" onClick={() => { onChange([...value, { id: `stage-${Date.now().toString(36)}`, title: '' }]) }}>{t('添加', 'Add')}</Button>}>{t('成长', 'Growth')}{value.length > 0 ? ` · ${value.length}` : ''}</SectionTitle>
      <div className="nv-assist">
        <TextInput value={wish} placeholder={t('想补充的，如：她入园时十二岁', 'Anything to add, e.g. she is twelve when she moves in')} onChange={(event) => { setWish(event.target.value) }} />
        <Button size="sm" icon="wand" disabled={dirty} busy={reading} pending={t('策划在读…', 'The planner is reading…')} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('读出他登场时多大、后来在哪几章变了', 'Reads how old they are as they enter and where they turn')} onClick={() => controller.guard(async () => {
          const job = await controller.run('character.growth', { root, id: card.id, ...(wish.trim().length > 0 ? { direction: wish.trim() } : {}) })
          const found = ((job.result?.output as { stages?: unknown[] } | undefined)?.stages ?? []).length
          if (found > 0) setWish('')
          controller.toast(found > 0 ? 'success' : 'info', found > 0 ? t(`理出 ${found} 个时期`, `${found} stretch(es) found`) : t('策划没有读出变化', 'The planner found no change to speak of'))
        })}>{value.length > 0 ? t('让策划再读一遍', 'Have the planner read again') : t('让策划找关键点', 'Have the planner find the turns')}</Button>
      </div>
      {value.map((stage) => {
        const apart = (stage.appearance ?? '').trim().length > 0 || (stage.visual?.prompt ?? '').trim().length > 0
        return (
          <div key={stage.id} className="nv-scene-row">
            <div className="nv-stage-pictures">
              {stage.visual?.portrait !== undefined
                ? <button type="button" className="nv-scene-thumb" onClick={() => { onOpen(stage.visual!.portrait!) }} title={t('点开看大图', 'Open it large')}><ProjectImage path={stage.visual.portrait} alt={stage.title} /></button>
                : <span className="nv-scene-thumb nv-look-empty">{t('未画', 'none')}</span>}
              {stage.visual?.sheet !== undefined ? <button type="button" className="nv-stage-sheet" onClick={() => { onOpen(stage.visual!.sheet!) }} title={t('点开看大图', 'Open it large')}><ProjectImage path={stage.visual.sheet} alt={stage.title} /></button> : null}
            </div>
            <div className="nv-scene-fields">
              <div className="nv-scene-head">
                <TextInput {...text(stage, 'title')} placeholder={t('这个时期叫什么', 'What this stretch is called')} />
                <Select
                  value={stage.from ?? ''}
                  options={[{ value: '', label: t('故事开始时', 'As the story begins') }, ...chapters.map(chapter => ({ value: chapter.id, label: t(`从第 ${chapter.index} 章起`, `From ch. ${chapter.index}`) }))]}
                  onChange={(from) => { const { from: _was, ...rest } = stage; onChange(value.map(item => (item.id === stage.id ? (from.length > 0 ? { ...rest, from } : rest) : item))) }}
                />
                <TextInput className="nv-stage-age" {...text(stage, 'age')} placeholder={t('年纪', 'Age')} />
                <Button size="sm" variant="ghost" icon="trash" title={t('删除', 'Delete')} onClick={() => { onChange(value.filter(item => item.id !== stage.id)) }} />
              </div>
              <TextInput {...text(stage, 'what')} placeholder={t('这里变了什么', 'What turned here')} />
              <TextArea {...text(stage, 'appearance')} minRows={1} maxRows={6} placeholder={t('这个时期的样子（和之前一样就不写）', 'How they look in it (left empty where nothing changed)')} />
              <TextInput {...text(stage, 'persona')} placeholder={t('这个时期的身份、为人（和人物卡一样就不写）', 'Who they are in it (left empty where the card holds)')} />
              {(stage.visual?.prompt ?? '').length > 0 ? <TextArea value={stage.visual?.prompt ?? ''} minRows={1} maxRows={6} onChange={(event) => { patch(stage.id, { visual: { ...stage.visual, prompt: event.target.value } }) }} /> : null}
              {apart ? (
                <div className="nv-row-wrap">
                  <Button size="sm" variant="outline" icon="users" disabled={dirty || busy} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => onDraw('sheet', stage)}>{stage.visual?.sheet !== undefined ? t('重画这时的人设图', 'Redraw its sheet') : t('画这时的人设图', 'Draw its sheet')}</Button>
                  <Button size="sm" variant="outline" icon="image" disabled={dirty || busy} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => onDraw('portrait', stage)}>{stage.visual?.portrait !== undefined ? t('重画这时的立绘', 'Redraw its portrait') : t('画这时的立绘', 'Draw its portrait')}</Button>
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The moments a person is remembered by: the director finds them in the book, the author rewrites them, and a portrait is drawn of one. */
function ScenesPanel({ id, card, value, marked, dirty, off, busy, onChange, onDraw, onOpen }: {
  id: string
  card: CharacterCard
  value: SignatureScene[]
  marked: string | undefined
  dirty: boolean
  off: boolean
  busy: boolean
  onChange: (scenes: SignatureScene[], marked?: string) => void
  onDraw: (scene: SignatureScene) => unknown
  onOpen: (path: string) => void
}) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [wish, setWish] = useState('')
  const finding = useRunningJob(job => job.kind === 'bible' && job.title.startsWith('signature scenes') && job.target === card.id) !== undefined
  const chapters = useMemo(() => new Map([...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => [chapter.id, chapter])), [project.chapters, project.lines])
  // A list the author changes — a word of a moment, which comes first, one added, one removed — is theirs from then
  // on: it is no longer brought up to date from what the digests note.
  const own = (scenes: SignatureScene[]): SignatureScene[] => scenes.map(({ from: _noted, ...scene }) => scene)
  const patch = (scene: string, change: Partial<SignatureScene>): void => { onChange(own(value.map(item => (item.id === scene ? { ...item, ...change } : item))), marked) }
  return (
    <div className="nv-scenes" id={id} tabIndex={-1}>
      <SectionTitle actions={<Button size="sm" variant="ghost" icon="plus" onClick={() => { onChange(own([...value, { id: `scene-${Date.now().toString(36)}`, title: '', text: '' }]), marked) }}>{t('添加', 'Add')}</Button>}>{t('名场面', 'Signature scenes')}{value.length > 0 ? ` · ${value.length}` : ''}</SectionTitle>
      {off ? <p className="nv-muted nv-small">{t('“立绘照名场面画”已在设置里关掉。', 'Portraits in their scene are turned off in Settings.')}</p> : null}
      <div className="nv-assist">
        <TextInput value={wish} placeholder={t('想要哪一幕、不要哪一类', 'A moment you want, a kind you do not')} onChange={(event) => { setWish(event.target.value) }} />
        <Button size="sm" icon="wand" disabled={dirty} busy={finding} pending={t('导演在书里找…', 'The director is looking in the book…')} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => controller.guard(async () => {
          const job = await controller.run('character.scene', { root, id: card.id, ...(wish.trim().length > 0 ? { direction: wish.trim() } : {}) })
          const output = job.result?.output as { scenes?: unknown[]; why?: string } | undefined
          const found = Array.isArray(output?.scenes) ? output.scenes.length : 0
          if (found > 0) {
            setWish('')
            controller.toast('success', t(`找到 ${found} 个名场面`, `${found} signature scene(s) found`))
          } else controller.toast('info', t(`导演没有找到名场面${output?.why !== undefined ? `：${output.why}` : ''}`, `The director found no scene${output?.why !== undefined ? `: ${output.why}` : ''}`))
        })}>{value.length > 0 ? t('让导演再找一遍', 'Have the director look again') : t('让导演从书里找', 'Have the director find them')}</Button>
      </div>
      {value.map((scene) => {
        const chapter = scene.chapter !== undefined ? chapters.get(scene.chapter) : undefined
        const first = scene.id === marked
        return (
          <div key={scene.id} className={cx('nv-scene-row', first && 'is-first')}>
            {scene.portrait !== undefined
              ? <button type="button" className="nv-scene-thumb" onClick={() => { onOpen(scene.portrait!) }} title={t('点开看大图', 'Open it large')}><ProjectImage path={scene.portrait} alt={scene.title} /></button>
              : <span className="nv-scene-thumb nv-look-empty">{t('未画', 'none')}</span>}
            <div className="nv-scene-fields">
              <div className="nv-scene-head">
                <TextInput value={scene.title} placeholder={t('哪一幕', 'Which moment')} onChange={(event) => { patch(scene.id, { title: event.target.value }) }} />
                {chapter !== undefined ? <button type="button" className="nv-link nv-small" onClick={() => { controller.openReader('read', chapter.id) }}>{t(`第 ${chapter.index} 章`, `Ch. ${chapter.index}`)}</button> : null}
                {first ? <Chip>{t('立绘默认', 'Default')}</Chip> : <button type="button" className="nv-link nv-small" onClick={() => { onChange(own(value), scene.id) }}>{t('设为默认', 'Make default')}</button>}
                <Button size="sm" variant="outline" icon="image" disabled={dirty || busy || scene.text.trim().length === 0} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => onDraw(scene)}>{scene.portrait !== undefined ? t('重画', 'Redraw') : t('画这一幕', 'Draw it')}</Button>
                <Button size="sm" variant="ghost" icon="trash" title={t('删除', 'Delete')} onClick={() => { onChange(own(value.filter(item => item.id !== scene.id)), marked === scene.id ? undefined : marked) }} />
              </div>
              <TextArea value={scene.text} minRows={2} maxRows={8} placeholder={t('写成画面：在哪里、在做什么、手里拿着什么、光线', 'As a picture: where, doing what, holding what, the light')} onChange={(event) => { patch(scene.id, { text: event.target.value }) }} />
              {scene.why !== undefined ? <p className="nv-muted nv-small">{scene.why}</p> : scene.from === 'digest' ? <p className="nv-muted nv-small">{t('收录这一章时场记记下的', 'Noted by the digest of this chapter')}</p> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LooksEditor({ value, dirty, busy, onChange, onDraw }: { value: CharacterLook[]; dirty: boolean; busy: boolean; onChange: (looks: CharacterLook[]) => void; onDraw: (look: CharacterLook) => unknown }) {
  const t = useT()
  const patch = (index: number, change: Partial<CharacterLook>): void => { onChange(value.map((look, at) => (at === index ? { ...look, ...change } : look))) }
  return (
    <div className="nv-looks">
      <SectionTitle actions={<Button size="sm" variant="ghost" icon="plus" onClick={() => { onChange([...value, { id: `look-${Date.now().toString(36)}`, name: '' }]) }}>{t('添加造型', 'Add a look')}</Button>}>{t('造型（服饰）', 'Looks (outfits)')}</SectionTitle>
      {value.length === 0 ? <p className="nv-muted nv-small">{t('不止一身行头时在这里添加：日常、戎装、丧服……', 'Add one for each further outfit: everyday, armour, mourning…')}</p> : null}
      {value.map((look, index) => (
        <div key={look.id} className="nv-look">
          {look.sheet !== undefined ? <ProjectImage className="nv-look-thumb" path={look.sheet} alt={look.name} /> : <span className="nv-look-thumb nv-look-empty">{t('未画', 'none')}</span>}
          <div className="nv-look-fields">
            <div className="nv-form-grid">
              <Field label={t('名称', 'Name')}><TextInput value={look.name} placeholder={t('如：丧服', 'e.g. mourning dress')} onChange={(event) => { patch(index, { name: event.target.value }) }} /></Field>
              <Field label={t('什么时候穿', 'When it is worn')}><TextInput value={look.when ?? ''} placeholder={t('如：葬礼与守灵', 'e.g. funerals and wakes')} onChange={(event) => { patch(index, { when: event.target.value }) }} /></Field>
            </div>
            <Field label={t('这套造型换了什么', 'What this look changes')} hint={t('只写与主造型不同的地方：衣着、装备、头发的梳法', 'Only what differs from the main look: clothing, gear, how the hair is worn')}>
              <TextArea value={look.prompt ?? ''} onChange={(event) => { patch(index, { prompt: event.target.value }) }} />
            </Field>
            <div className="nv-row-wrap">
              <Button size="sm" icon="users" disabled={dirty || busy || look.name.trim().length === 0 || (look.prompt ?? '').trim().length === 0} pending={t('正在画这套造型…', 'Drawing this look…')} title={dirty ? t('先保存人物卡', 'Save the card first') : undefined} onClick={() => onDraw(look)}>{t('画这套造型的人设图', 'Draw this look\'s sheet')}</Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => { onChange(value.filter((_, at) => at !== index)) }}>{t('移除', 'Remove')}</Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

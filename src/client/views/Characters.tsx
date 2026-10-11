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
import { ImageTrialDialog, ManyModels, SpeechTrialDialog, type DrawAsk } from '../Trial'
import { GuidePictures, useGiven } from '../Guides'
import { ImportPicture } from '../ImportPicture'
import { PortraitInText } from '../Figures'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VoiceOption } from '../../shared/rpc'
import type { CharacterCard, CharacterLook, CharacterRole, CharacterStage, LifeMark, SceneShot, SignatureScene, SortedNotes } from '../../shared/types'
import { legacyLook, sceneFor, scenePictures, scenesOf, shotOf } from '../../shared/art'
import { clip as clipText } from '../../shared/text'
import { detailsOf, foldDetails } from '../../shared/card'
import { leadOf, portraitsOf, withBookImage } from '../../shared/images'
import { sheetsOf } from '../../shared/sheets'
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
  useReady,
  useSplit,
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
  // On a phone the list and a person's page are one at a time; led here to one person, their page is what opens.
  const split = useSplit(entity?.kind === 'character')
  useEffect(() => { if (entity?.kind === 'character') { setSelected(entity.id); split.open() } }, [entity?.nonce])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const settings = useSnapshot(snapshot => snapshot.settings)
  useEffect(() => { if (settings === undefined) void controller.loadSettings().catch(() => {}) }, [controller, settings])
  const canDraw = useReady().image
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
  // Cards of an earlier version that still keep phrases for image models beside the appearance: folded in, one after another.
  const anchored = project.characters.filter(item => legacyLook(item) !== undefined)
  const [folding, setFolding] = useState<{ done: number; total: number } | undefined>()
  const foldAll = (): void => {
    const todo = anchored.map(item => item.id)
    confirm.ask(t(`把 ${todo.length} 个人旧的视觉锚点并进外貌？导演逐个写成一段话（说法不一样的地方以锚点为准），然后去掉锚点。`, `Fold the old visual anchors of ${todo.length} people into their appearance? The director writes each as one paragraph (where the two differ, the anchor holds), and the anchor is gone.`), () => {
      void controller.guard(async () => {
        setFolding({ done: 0, total: todo.length })
        try {
          for (const [index, id] of todo.entries()) {
            await controller.run('character.visual', { root, id })
            setFolding({ done: index + 1, total: todo.length })
          }
          controller.toast('success', t('都并进外貌了', 'All folded into the appearance'))
        } finally {
          setFolding(undefined)
        }
      })
    })
  }
  const drawAll = (): void => {
    if (!controller.need('image')) return
    const todo = faceless.map(item => item.id)
    // The sheet comes first: whoever has none gets one before their portrait — said here, where the calls are counted.
    const lead = settings !== undefined ? leadOf(withBookImage(settings.settings.image, project.manifest.image)) : 'sheet'
    const sheetless = lead === 'none' ? 0 : faceless.filter(item => item.visual?.sheet === undefined).length
    // So does their scene: whoever has none on their card has the director pick one from the book first.
    const plan = settings !== undefined ? portraitsOf(withBookImage(settings.settings.image, project.manifest.image)) : 'both'
    const sceneless = plan === 'plain' || !project.chapters.some(chapter => chapter.hasText) ? 0 : faceless.filter(item => scenesOf(item).length === 0).length
    confirm.ask(t(`给 ${todo.length} 个还没有定妆照的人物${plan === 'both' ? '各画两张（素底定妆、名场面）' : '各画一张'}？${sheetless > 0 ? (lead === 'portrait' ? `其中 ${sheetless} 人画完会照着立绘补人设图。` : `其中 ${sheetless} 人会先画人设图。`) : ''}${sceneless > 0 ? `${sceneless} 人会先由导演找名场面。` : ''}`, `Draw ${plan === 'both' ? 'two portraits (a plain likeness, their signature scene)' : 'a portrait'} for each of the ${todo.length} without one?${sheetless > 0 ? (lead === 'portrait' ? ` ${sheetless} get a design sheet after it, drawn against it.` : ` ${sheetless} get a design sheet first.`) : ''}${sceneless > 0 ? ` For ${sceneless} the director finds their signature scenes first.` : ''}`), () => {
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
    <div className={cx('nv-split nv-people', mode === 'photos' && 'has-photos', split.rootClass)}>
      <aside className="nv-split-list" {...split.list}>
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
        {anchored.length > 0 ? (
          <Button size="sm" variant="ghost" icon="wand" busy={folding !== undefined} pending={folding !== undefined ? t(`正在并 ${folding.done}/${folding.total}…`, `Folding ${folding.done}/${folding.total}…`) : undefined} onClick={foldAll} title={t('这些人物卡还带着旧的“视觉锚点”，画图仍照它。并进外貌之后，每个人只有外貌一段话', 'These cards still keep an old "visual anchor", and pictures go by it. Folded in, each person has one text: their appearance')}>{t(`旧视觉锚点并进外貌（${anchored.length}）`, `Fold old anchors in (${anchored.length})`)}</Button>
        ) : null}
        {mode === 'photos' && faceless.length > 0 ? (
          <ManyModels title={t('多模型：给还没有定妆照的人各画几张来比', 'Several models: portraits of everyone who has none, from each image service')} ask={() => (controller.need('image') ? { title: t(`补齐定妆照（${faceless.length} 人）`, `Missing portraits (${faceless.length})`), method: 'image.create', params: {}, many: true, calls: faceless.map(item => ({ kind: 'portrait', target: item.id })) } : undefined)} />
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
      <section className="nv-split-detail" {...split.detail}>
        {split.backBar(t('人物', 'People'))}
        {card !== undefined ? <CharacterEditor key={card.id} card={card} lives={lives} onDeleted={() => { setSelected(undefined); split.back() }} /> : <Empty icon="users" title={t('选择或新建一个人物', 'Select or create a character')} />}
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
  // Phrases an earlier version kept of them for image models: pictures go by them until they are folded into the appearance.
  const legacy = legacyLook(draft)
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
    // A card of an earlier version keeps phrases for image models beside the appearance, and pictures go by them. An
    // appearance the author has now rewritten is their word on how the person looks: the phrases go.
    if (legacy !== undefined && (draft.appearance ?? '').trim() !== (card.appearance ?? '').trim() && (draft.appearance ?? '').trim().length > 0) payload.visual = { ...draft.visual, prompt: '' }
    await controller.api.call('character.save', { root, card: payload as Partial<CharacterCard> })
    setDirty(false)
    controller.toast('success', t('已保存', 'Saved'))
  })
  // On which lines of the plot they are seen: asked only of a book that has more than one. (A Host from before answers with an error: then nothing is shown.)
  const seen = useLoad(async signal => ((project.lines ?? []).length > 0 ? await controller.api.call('lines.seen', { root }, signal).catch(() => undefined) : undefined), [root, project.revision])
  const presence = project.presence.find(entry => entry.character === card.id)
  const told = lives?.lives[card.id]?.first !== undefined ? lives.lives[card.id] : undefined
  // The stock voices of whatever speaks for this book: its own speech setup where it has one.
  const voices: VoiceOption[] = (settings?.book?.root === root ? settings.book.voices : undefined) ?? settings?.voices ?? []
  const voiceProfile = draft.voiceProfile ?? {}
  // Work on this card that is still running — also when it was started before this screen was opened.
  const anchoring = useRunningJob(job => job.kind === 'bible' && (job.title.startsWith('appearance ') || job.title.startsWith('visual anchor')) && job.target === card.id) !== undefined
  const drawing = useRunningJob(job => job.kind === 'illustrate' && job.target === card.id)
  const designing = useRunningJob(job => job.kind === 'audio' && job.title === 'design voice' && job.target === card.id) !== undefined
  const [sample, setSample] = useState<{ path: string; at: number } | undefined>()
  const [voicing, setVoicing] = useState(false)
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
  // What the next portrait is: 'pair' — a plain likeness and their signature scene, one of each; an id — that one of
  // their moments; 'find' — a scene the director is yet to find; 'plain' — the likeness alone. '' while nothing was
  // chosen here: then it is as the setting has it (`image.portraits`).
  const [moment, setMoment] = useState('')
  const sheets = useSheetsAsk()
  // What each of the two is drawn against. Left alone, it is as the setting has it (which of the two leads); chosen
  // here, it is the author's word for the pictures drawn from this page — said with each, whatever the setting.
  const [portraitFrom, setPortraitFrom] = useState<'sheet' | 'words' | undefined>()
  const [sheetFrom, setSheetFrom] = useState<'portrait' | 'words' | undefined>()
  // Pictures the author gives their design sheet to go by — a face, a costume: sent to the image model with every
  // sheet of theirs drawn from this page, until taken off again.
  const [sheetGiven, setSheetGiven] = useGiven(`${root}\nsheet:${card.id}`)
  useEffect(() => {
    setPortraitFrom(undefined)
    setSheetFrom(undefined)
  }, [card.id])
  // A picture of theirs by several image services at once, to be compared: which, as the button beside it would draw it.
  const [many, setMany] = useState<DrawAsk | undefined>()
  /** One of their pictures, as the call that draws it. */
  const asked = (kind: 'sheet' | 'portrait', look?: string, scene?: string, stage?: string): Record<string, unknown> => {
    // A look (outfit) is described on its own row; the ideas here are for the main sheet and the portrait.
    const jotted = look === undefined && stage === undefined ? notes.trim() : ''
    // The card's own two pictures: a look, and a stretch of their life, go by the setting.
    const from = look !== undefined || stage !== undefined ? undefined : kind === 'portrait' ? portraitFrom : sheetFrom === 'portrait' && card.visual?.portrait === undefined ? undefined : sheetFrom
    // The pictures given are for the card's own sheet, like the ideas.
    const given = kind === 'sheet' && look === undefined && stage === undefined ? sheetGiven : []
    return { kind, target: card.id, ...(look !== undefined ? { look } : {}), ...(jotted.length > 0 ? { notes: jotted } : {}), ...(stage !== undefined ? { stage } : {}), ...(kind !== 'portrait' || stage !== undefined ? {} : scene !== undefined ? { scene } : whichPortrait(chosenPortrait)), ...(from !== undefined ? { from } : {}), ...(given.length > 0 ? { references: given } : {}) }
  }
  /** The same picture by several services instead: one from each, to compare. */
  const compare = (what: string, kind: 'sheet' | 'portrait', look?: string, scene?: string, stage?: string): void => {
    if (controller.need('image')) setMany({ title: `${card.name} · ${what}`, method: 'image.create', params: asked(kind, look, scene, stage) })
  }
  const draw = (kind: 'sheet' | 'portrait', done: string, look?: string, scene?: string, stage?: string): Promise<unknown> | undefined => {
    if (!controller.need('image')) return undefined
    const params = asked(kind, look, scene, stage)
    const from = params.from as 'sheet' | 'words' | 'portrait' | undefined
    const go = (choice: SheetsChoice): Promise<unknown> => controller.guard(async () => {
      const job = await controller.run('image.create', { root, ...params, ...choice } as never)
      const how = job.result?.sorted as SortedNotes | undefined
      if (how !== undefined) {
        setSorted({ kind, how })
        setNotes('')
      }
      const shown = kind === 'portrait' ? sceneOf(job) : undefined
      // One of the card's own moments shows in its row; what is said here is what the author could not have known: a moment settled for this picture alone, or none.
      if (kind === 'portrait') setPictured(shown?.asked !== undefined || shown?.none !== undefined || shown?.unframed !== undefined ? { ...shown, path: (job.result?.output as { path?: string } | undefined)?.path } : undefined)
      // A sheet drawn while another is the chosen main one waits beside it: said, with the way to use it.
      const waits = kind === 'sheet' && (job.result?.output as { spare?: boolean } | undefined)?.spare === true
      // A portrait asked for with nothing said of it came to two pictures: the likeness, and the scene.
      const two = kind === 'portrait' && (job.result?.output as { likeness?: unknown } | undefined)?.likeness !== undefined
      controller.toast('success', waits ? t('人设图画好了，先不启用：主人设图是你选定的那张。要用新的，点它再点“设为主人设图”', 'Design sheet ready, not in use yet: the main sheet is the one you chose. To use the new one, open it and make it the main sheet')
        : two ? `${t(`画好了两张：素底定妆、名场面${shown?.title !== undefined ? `「${shown.title}」` : ''}`, `Two portraits ready: a plain likeness, and their signature scene${shown?.title !== undefined ? ` "${shown.title}"` : ''}`)}${sheetsDrawn(job, t)}`
          : `${done}${shown?.title !== undefined ? t(`：${shown.title}`, `: ${shown.title}`) : ''}${sheetsDrawn(job, t)}`)
      const drawn = (job.result?.output as { path?: string } | undefined)?.path
      if (kind === 'sheet' && look === undefined && drawn !== undefined) setPicked(`sheet:${drawn}`)
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
  // The one that stands for them: the author's choice, else the first.
  const face = draft.visual?.portrait
  const chosen = draft.visual?.face !== undefined && draft.visual.face === face
  // Every design sheet kept of them, with what each is used as — the main one, a stretch's, or kept without being in
  // use — and those the gallery still has of them that are on no list (drawn before sheets were kept side by side:
  // a sheet drawn again used to take the one before off the card). A look's sheets are the look's, named after it.
  const kept = sheetsOf(draft)
  const sheetPaths = kept.map(sheet => sheet.path)
  const lookSheets = new Set((draft.visual?.looks ?? []).map(look => look.sheet).filter((path): path is string => path !== undefined))
  const theirOwn = new Set([`sheet-${card.id}`, ...(draft.stages ?? []).map(stage => `sheet-${card.id}-${stage.id}`)])
  const strays = [...records.byPath.values()]
    .filter(image => image.kind === 'sheet' && image.target === card.id && !sheetPaths.includes(image.path) && !lookSheets.has(image.path) && theirOwn.has(image.path.split('/').pop()!.replace(/-[0-9a-f]{8}\.[a-z]+$/i, '')))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(image => ({ path: image.path, as: 'spare' as const, front: false, stray: true }))
  const sheetList: { path: string; as: 'main' | 'stage' | 'spare'; stage?: string; front: boolean; chosen?: boolean; stray?: boolean }[] = [...kept, ...strays]
  const stageName = (id: string | undefined): string => (draft.stages ?? []).find(stage => stage.id === id)?.title ?? t('某个时期', 'a stretch')
  // The pictures there are of this person: their portraits, their design sheets, and a sheet per look.
  const pictures: { key: string; label: string; path: string; wide: boolean; dim?: boolean }[] = [
    ...portraits.map((path, index) => ({ key: `portrait:${path}`, label: `${index === 0 ? t('立绘', 'Portrait') : t(`立绘 ${index + 1}`, `Portrait ${index + 1}`)}${path === face && portraits.length > 1 ? t(' · 代表', ' · theirs') : ''}`, path, wide: false })),
    ...sheetList.map(sheet => ({
      key: `sheet:${sheet.path}`,
      label: sheet.as === 'main' ? (sheetList.length > 1 ? t('人设图 · 主', 'Sheet · main') : t('人设图', 'Design sheet')) : sheet.as === 'stage' ? t(`人设图 · ${stageName(sheet.stage)}`, `Sheet · ${stageName(sheet.stage)}`) : t('人设图 · 未启用', 'Sheet · not in use'),
      path: sheet.path,
      // One figure stands upright; three lie side by side. (Of one out of the gallery nothing says which: shown wide.)
      wide: !sheet.front,
      ...(sheet.as === 'spare' ? { dim: true } : {}),
    })),
    ...(draft.visual?.looks ?? []).filter(look => look.sheet !== undefined).map(look => ({ key: `look:${look.id}`, label: look.name.length > 0 ? look.name : t('造型', 'Look'), path: look.sheet!, wide: true })),
  ]
  const [picked, setPicked] = useState<string | undefined>()
  // The picture opened large: one of the strip's, or the portrait of one of their moments.
  const [viewing, setViewing] = useState<string | undefined>()
  // …and whether it opens ready to be changed in one thing ("change this one…" was pressed under it).
  const [viewStart, setViewStart] = useState<'change' | undefined>()
  // Opened on the portrait that stands for them, not on whichever was drawn last.
  const picture = pictures.find(item => item.key === picked) ?? pictures.find(item => item.path === face && item.key.startsWith('portrait:')) ?? pictures[0]
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
  // Which portrait stands for them — in the lists, as their avatar, on the stage, and in the text where they first come on.
  const setFace = (path: string | undefined): Promise<unknown> => controller.guard(async () => {
    // One the gallery has of them that is on no list yet joins the list with it.
    await controller.api.call('character.save', { root, card: { id: card.id, visual: path === undefined ? { face: '' } : { ...(listed.includes(path) ? {} : { portraits: [...listed, path] }), face: path } } })
    await controller.refreshProject()
    controller.toast('success', path === undefined ? t('不再选定：最新的素底定妆代表这个人（没有素底的，就是最新的一张）', 'No longer chosen: their newest plain likeness stands for them (the newest portrait, where they have none)') : t('这张是代表立绘了：列表、头像和正文里第一次出场处都用它', 'This portrait stands for them now: in the lists, as their avatar, and in the text where they first come on'))
  })
  // Their design sheets: which is the main one, which is a stretch's. (One out of the gallery joins the list with it.)
  const sheetAt = picture !== undefined && picture.key.startsWith('sheet:') ? sheetList.find(sheet => sheet.path === picture.path) : undefined
  const joining = (path: string): { sheets?: string[] } => (sheetPaths.includes(path) ? {} : { sheets: [...sheetPaths, path] })
  // The stretches as they would read with this sheet given to one of them (`to`), or to none: a sheet is one stretch's at most.
  const stagesWith = (path: string, to: string | undefined): CharacterStage[] => (card.stages ?? []).map((stage) => {
    if (stage.id === to) return { ...stage, visual: { ...stage.visual, sheet: path } }
    if (stage.visual?.sheet !== path) return stage
    const { sheet: _sheet, sheetFront: _front, ...rest } = stage.visual
    const { visual: _was, ...bare } = stage
    return Object.keys(rest).length > 0 ? { ...bare, visual: rest } : bare
  })
  const setMainSheet = (path: string | undefined): Promise<unknown> => controller.guard(async () => {
    const staged = path !== undefined && (card.stages ?? []).some(stage => stage.visual?.sheet === path)
    await controller.api.call('character.save', { root, card: { id: card.id, visual: path === undefined ? { mainSheet: '' } : { ...joining(path), mainSheet: path }, ...(staged ? { stages: stagesWith(path!, undefined) } : {}) } })
    await controller.refreshProject()
    controller.toast('success', path === undefined ? t('不再选定：它还是主人设图，但下次新画的会顶替它', 'No longer chosen: it is the main sheet still, but the next one drawn takes its place') : t('这张是主人设图了：之后画这个人都照着它', 'This is the main sheet now: every later picture of them is drawn against it'))
  })
  const useSheetFor = (path: string, stage: string | undefined): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('character.save', { root, card: { id: card.id, ...(sheetPaths.includes(path) ? {} : { visual: joining(path) }), stages: stagesWith(path, stage) } })
    await controller.refreshProject()
    controller.toast('success', stage !== undefined ? t(`这张是「${stageName(stage)}」时期的人设图了`, `This is the sheet of "${stageName(stage)}" now`) : t('不再用于哪个时期：留着，未启用', 'No longer a stretch\'s: kept, not in use'))
  })
  const lookField = `nv-look-${card.id}`
  const sceneField = `nv-scene-${card.id}`
  const plan = image !== undefined ? portraitsOf(image) : 'both'
  const scenic = plan !== 'plain'
  const moments = scenesOf(draft)
  const marked = sceneFor(draft)
  // The pictures drawn of each of their moments — the moment's own first: what its record says it is of, not only
  // what the card has written down beside the moment.
  const picturesOf = (scene: SignatureScene): string[] => scenePictures(scene, moments, portraits, path => records.byPath.get(path))
  // The moment the portrait shown is of, and whether it is the one that stands for it — in the panel, and in the text
  // where the moment is told.
  const momentAt = placed >= 0 && picture !== undefined ? moments.find(scene => picturesOf(scene).includes(picture.path)) : undefined
  const useForScene = (scene: SignatureScene, path: string): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('character.scenePicture', { root, id: card.id, scene: scene.id, path })
    await controller.refreshProject()
    controller.toast('success', t(`「${scene.title}」用这张了：正文里讲到这一幕的地方出它`, `This is the picture of "${scene.title}" now: it stands in the text where the moment is told`))
  })
  // What the next portrait is, as the selector shows it: what was chosen here — else what the setting has.
  const chosenPortrait = moment !== '' && (moment === 'plain' || moment === 'find' || (moment === 'pair' && plan === 'both') || moments.some(scene => scene.id === moment))
    ? moment
    : plan === 'both' ? 'pair' : marked?.id ?? 'find'
  /** What the Host is told of it: nothing for the pair (the setting has it), the scene named, the scene alone, the likeness alone. */
  const whichPortrait = (which: string): { plain?: boolean; scene?: string } => which === 'plain' ? { plain: true } : which === 'pair' ? {} : which === 'find' ? (plan === 'both' ? { plain: false } : {}) : { scene: which }

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
                {picture.path === face
                  ? (
                      <>
                        <Chip tone="blue" title={t('列表、头像、舞台和正文里第一次出场处用这张', 'Their face in the lists, their avatar, on the stage, and in the text where they first come on')}>{t('代表立绘', 'Stands for them')}</Chip>
                        {chosen
                          ? <button type="button" className="nv-link nv-small" disabled={dirty} title={t('不选定：以后用最新的素底定妆（没有素底的，用最新的一张）', 'Unchoose: their newest plain likeness stands for them from then on (the newest portrait, where they have none)')} onClick={() => setFace(undefined)}>{t('取消选定', 'Unchoose')}</button>
                          : <Button size="sm" variant="ghost" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('现在是照规矩来的：最新的素底定妆（没有素底的，就是最新的一张）；选定后，再画新的也不换', 'It stands by the rule so far: their newest plain likeness (the newest portrait, where they have none); chosen, it stays whatever is drawn after')} onClick={() => setFace(picture.path)}>{t('选定', 'Choose it')}</Button>}
                      </>
                    )
                  : <Button size="sm" variant="ghost" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('列表、头像、舞台和正文里第一次出场处改用这张', 'Their face in the lists, their avatar, on the stage, and in the text where they first come on')} onClick={() => setFace(picture.path)}>{t('设为代表立绘', 'Make it stand for them')}</Button>}
                <span className="nv-spacer" />
              </>
            ) : null}
            {momentAt !== undefined ? (
              picturesOf(momentAt)[0] === picture.path
                ? <Chip tone="neutral" title={t('名场面面板里、正文里讲到这一幕的地方，用的是这张', 'The picture of this moment: in the panel, and in the text where it is told')}>{t(`「${momentAt.title}」的图`, `Of "${momentAt.title}"`)}</Chip>
                : <Button size="sm" variant="ghost" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('这一幕改用这张：名场面面板里、正文里讲到它的地方都换成它', 'Have this one stand for the moment: in the panel, and in the text where it is told')} onClick={() => useForScene(momentAt, picture.path)}>{t(`定为「${momentAt.title}」的图`, `Make it the picture of "${momentAt.title}"`)}</Button>
            ) : null}
            {placed >= 0 ? <PortraitInText character={card.id} path={picture.path} /> : null}
            {sheetAt !== undefined ? (
              <>
                {sheetAt.as === 'main'
                  ? (
                      <>
                        <Chip tone="blue" title={t('之后每一张有这个人的图，都照着它画', 'Every later picture of them is drawn against it')}>{t('主人设图', 'Main sheet')}</Chip>
                        {sheetList.length > 1
                          ? sheetAt.chosen === true
                            ? <button type="button" className="nv-link nv-small" disabled={dirty} title={t('不选定：下次新画的人设图会顶替它', 'Unchoose: the next sheet drawn takes its place')} onClick={() => setMainSheet(undefined)}>{t('取消选定', 'Unchoose')}</button>
                            : <Button size="sm" variant="ghost" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('选定后，再画新的人设图也不换', 'Chosen, it stays whatever sheet is drawn after')} onClick={() => setMainSheet(sheetAt.path)}>{t('选定', 'Choose it')}</Button>
                          : null}
                      </>
                    )
                  : (
                      <>
                        {sheetAt.as === 'spare' ? <Chip title={t('留着，没有哪张图照着它画', 'Kept; no picture is drawn against it')}>{t('未启用', 'Not in use')}</Chip> : <Chip tone="violet">{t(`${stageName(sheetAt.stage)}时期`, stageName(sheetAt.stage))}</Chip>}
                        <Button size="sm" variant="ghost" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('之后画这个人都照着这张', 'Every later picture of them is drawn against this one')} onClick={() => setMainSheet(sheetAt.path)}>{t('设为主人设图', 'Make it the main sheet')}</Button>
                      </>
                    )}
                {(card.stages ?? []).length > 0 ? (
                  <label className="nv-sheet-use" title={t('这张是哪个时期的样子：画那个时期的章节时照着它', 'Which stretch of their life it shows: chapters of that stretch are drawn against it')}>
                    <span>{t('用于', 'Used for')}</span>
                    <Select
                      value={sheetAt.as === 'stage' ? sheetAt.stage ?? '' : ''}
                      disabled={dirty}
                      onChange={(to) => { void useSheetFor(sheetAt.path, to.length > 0 ? to : undefined) }}
                      options={[{ value: '', label: sheetAt.as === 'main' ? t('所有时期（主）', 'Every stretch (main)') : t('不用于时期', 'No stretch') }, ...(card.stages ?? []).map(stage => ({ value: stage.id, label: stage.title.length > 0 ? stage.title : t('未命名的时期', 'An unnamed stretch') }))]}
                    />
                  </label>
                ) : null}
                <Button size="sm" variant="ghost" icon="wand" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('把这张人设图和你写的一句话发给绘图模型，只改那一处；画出来的顶替这张，这张留着', 'Send this sheet with a sentence of yours: that one thing is changed. What comes of it takes this one\'s place; this one is kept')} onClick={() => { setViewStart('change'); setViewing(sheetAt.path) }}>{t('照这张改…', 'Change this one…')}</Button>
                <span className="nv-spacer" />
              </>
            ) : null}
            <DeletePicture bare path={picture.path} disabled={dirty} onDone={() => { setPicked(undefined) }} />
          </div>
        ) : null}
        {/* Their portraits in one row, their design sheets (and a sheet per look) in the next: neither is pushed out of sight by the other. */}
        {pictures.length > 1 ? [pictures.filter(item => item.key.startsWith('portrait:')), pictures.filter(item => !item.key.startsWith('portrait:'))].filter(row => row.length > 0).map(row => (
          <div key={row[0]!.key.startsWith('portrait:') ? 'portraits' : 'sheets'} className="nv-person-thumbs" role="group" aria-label={row[0]!.key.startsWith('portrait:') ? t('这个人物的立绘', 'Portraits of this character') : t('这个人物的人设图', 'Design sheets of this character')}>
            {row.map(item => (
              <button key={item.key} type="button" className={cx(item.key === picture?.key && 'is-active', item.wide && 'is-wide', item.dim === true && 'is-spare')} onClick={() => { setPicked(item.key) }} title={item.label}>
                <ProjectImage path={item.path} alt={item.label} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        )) : null}
        <div className="nv-person-draw">
          <Button size="sm" variant={draft.visual?.portrait === undefined ? 'primary' : 'outline'} icon="image" disabled={dirty || (drawing !== undefined && !portraitBusy)} busy={portraitBusy} pending={t('正在画立绘…', 'Drawing the portrait…')} onClick={() => draw('portrait', t('立绘已生成', 'Portrait ready'))} title={dirty ? t('先保存当前修改', 'Save your edits first') : portraitAgainst === 'words' ? t('只照文字画', 'Drawn from the words alone') : hasSheet ? t('照着人设图画', 'Drawn against the design sheet') : t('先画人设图，再照着它画立绘', 'The design sheet is drawn first, then the portrait against it')}>{draft.visual?.portrait !== undefined ? t('重画立绘', 'Redraw portrait') : t('画立绘', 'Draw portrait')}</Button>
          <Button size="sm" variant="ghost" icon="layers" disabled={dirty} onClick={() => { compare(t('立绘', 'portrait'), 'portrait') }} title={t('多模型：用几个绘图服务各画一张立绘来比——同一幕、同一段提示词、同样的参考图', 'Several models: a portrait from each image service, to compare — the same moment, the same words, the same reference pictures')} aria-label={t('多模型画立绘', 'Portrait by several models')} />
          <ImportPicture kind="portrait" of={{ character: card.id }} disabled={dirty} />
          <Button size="sm" variant="outline" icon="users" disabled={dirty || (drawing !== undefined && !sheetBusy)} busy={sheetBusy} pending={t('正在画人设图…', 'Drawing the sheet…')} onClick={() => draw('sheet', draft.visual?.sheet !== undefined ? t('人设图画好了：它是主人设图了，原来那张留着（未启用）', 'Design sheet ready: it is the main sheet now, and the one before is kept, not in use') : t('人设图已生成', 'Design sheet ready'))} title={dirty ? t('先保存当前修改', 'Save your edits first') : sheetAgainst === 'portrait' ? t(`${image?.sheet === 'front' ? '正面全身' : '三视图'}，照着立绘画`, `${image?.sheet === 'front' ? 'The front view' : 'Three views'}, drawn against the portrait`) : sheetGiven.length > 0 ? t(`${image?.sheet === 'front' ? '正面全身' : '三视图'}，照文字和下面这 ${sheetGiven.length} 张参考图画`, `${image?.sheet === 'front' ? 'The front view' : 'Three views'}, drawn from the words and the ${sheetGiven.length} picture(s) given below`) : t(`${image?.sheet === 'front' ? '正面全身' : '三视图'}，只照文字画：外貌、画风和下面写的想法`, `${image?.sheet === 'front' ? 'The front view' : 'Three views'}, drawn from the words alone: the appearance, the art direction and the ideas below`)}>{sheetList.length > 0 ? t('再画一张人设图', 'Another sheet') : t('生成人设图', 'Design sheet')}</Button>
<Button size="sm" variant="ghost" icon="layers" disabled={dirty} onClick={() => { compare(t('人设图', 'design sheet'), 'sheet') }} title={t('多模型：用几个绘图服务各画一张人设图来比', 'Several models: a design sheet from each image service, to compare')} aria-label={t('多模型画人设图', 'Design sheet by several models')} />
          <ImportPicture kind="sheet" of={{ character: card.id }} disabled={dirty} onDone={(path) => { setPicked(`sheet:${path}`) }} />
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
        <GuidePictures label={t('人设图参考图', 'Pictures for the sheet')} ask={t('要它的什么：脸、发型、这身衣服（不填：整个样子照它）', 'What of it is wanted: the face, the hair, these clothes (left empty: the whole look)')} value={sheetGiven} onChange={setSheetGiven} disabled={dirty} />
        {portraitAgainst === 'sheet' && sheetAgainst === 'portrait' && hasSheet ? <p className="nv-muted nv-small">{t('两张互相照着：重画哪张都会像另一张。', 'Each is held against the other: either, drawn again, comes back like the other.')}</p> : null}
        {portraitBehind ? <p className="nv-muted nv-small">{t('立绘不是照现在这张人设图画的。', 'The portrait was not drawn against the sheet in use now.')}</p> : null}
        {sheetBehind ? <p className="nv-muted nv-small">{t('人设图不是照现在这张立绘画的。', 'The sheet was not drawn against the portrait in use now.')}</p> : null}
        {scenic ? (
          <label className="nv-person-moment">
            <span>{t('立绘画', 'Portrait shows')}</span>
            <Select
              value={chosenPortrait}
              onChange={setMoment}
              options={[
                ...(plan === 'both' ? [{ value: 'pair', label: t('素底定妆 + 名场面（各一张）', 'A plain likeness + their scene (one of each)') }] : []),
                ...(moments.length === 0 ? [{ value: 'find', label: t('名场面（导演从书里找）', 'A signature scene (the director finds them)') }] : []),
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
              <p>{pictured.shot !== undefined ? [pictured.shot.action, pictured.shot.outfit, pictured.shot.setting].filter(part => part !== undefined && part.length > 0).join(' · ') : pictured.text ?? pictured.none}</p>
              {pictured.unframed !== undefined ? <p className="nv-muted">{pictured.unframed}</p> : null}
              {pictured.why !== undefined ? <p className="nv-muted">{pictured.why}</p> : null}
              {pictured.text !== undefined && pictured.asked !== undefined ? (
                <p>
                  <button type="button" className="nv-link" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => controller.guard(async () => {
                    const kept: SignatureScene = { id: `scene-${Date.now().toString(36)}`, title: pictured.title ?? '', text: pictured.text!, ...(pictured.chapter !== undefined ? { chapter: pictured.chapter } : {}), ...(pictured.why !== undefined ? { why: pictured.why } : {}), ...(pictured.path !== undefined ? { portrait: pictured.path } : {}), ...(pictured.shot !== undefined ? { shot: pictured.shot } : {}) }
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
        onMany={(kind, stage) => { compare(`${stage.title} · ${kind === 'sheet' ? t('人设图', 'design sheet') : t('立绘', 'portrait')}`, kind, undefined, undefined, stage.id) }}
        onWrite={(stage) => { void controller.guard(async () => { await controller.run('character.visual', { root, id: card.id, stage: stage.id }); controller.toast('success', t(`「${stage.title}」的样子写好了`, `How they look in "${stage.title}" is written`)) }) }}
        onOpen={setViewing}
      />

      <SectionTitle actions={<Button size="sm" icon="wand" disabled={dirty} busy={anchoring} pending={t('导演在写…', 'The director is writing…')} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('让导演照人物卡、正文和这本书的画风写外貌', 'Have the director write the appearance from the card, the text and the book\'s art direction')} onClick={() => controller.guard(async () => {
        await controller.run('character.visual', { root, id: card.id })
        controller.toast('success', t('外貌写好了', 'Appearance written'))
      })}>{(draft.appearance ?? '').trim().length > 0 ? t('让导演照画风重写', 'Have the director rewrite it') : t('让导演写外貌', 'Have the director write it')}</Button>}>{t('形象', 'Looks')}</SectionTitle>
      <Field label={t('外貌', 'Appearance')} hint={t('写手照它写，每张有此人的图也照它画', 'The writer writes them by it, and every picture of them is drawn by it')}><TextArea id={lookField} {...text('appearance')} /></Field>
      {legacy !== undefined ? (
        // A card of an earlier version: there is one text of how somebody looks now, and this one is folded into it.
        <div className="nv-note nv-legacy-look">
          <p><strong>{t('旧的视觉锚点', 'The old visual anchor')}</strong>{t('——画图仍照它，直到并进外貌：', ' — pictures still go by it, until it is folded into the appearance: ')}<span className="nv-muted">{legacy}</span></p>
          <span className="nv-row-wrap">
            <Button size="sm" icon="wand" disabled={dirty} busy={anchoring} pending={t('导演在并…', 'Folding it in…')} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('导演把它并进外貌（写成一段话，说法不一样的地方以它为准），然后去掉它', 'The director folds it into the appearance (one paragraph; where the two differ, it holds), and it is gone')} onClick={() => controller.guard(async () => {
              await controller.run('character.visual', { root, id: card.id })
              controller.toast('success', t('并进外貌了', 'Folded into the appearance'))
            })}>{t('并进外貌', 'Fold into the appearance')}</Button>
            <Button size="sm" variant="ghost" icon="x" title={t('去掉它，画图改照外貌', 'Drop it: pictures go by the appearance')} onClick={() => { set('visual', { ...draft.visual, prompt: '' }) }}>{t('丢掉，照外貌画', 'Drop it')}</Button>
          </span>
        </div>
      ) : null}
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
        onMany={(scene) => { compare(scene.title.length > 0 ? scene.title : t('名场面', 'signature scene'), 'portrait', undefined, scene.id) }}
        onOpen={setViewing}
        picturesOf={picturesOf}
        onUse={useForScene}
      />
      <LooksEditor
        owner={card.id}
        value={draft.visual?.looks ?? []}
        dirty={dirty}
        onChange={(looks) => { set('visual', { ...draft.visual, looks }) }}
        busy={drawing !== undefined}
        onDraw={look => draw('sheet', t(`「${look.name}」的人设图已生成`, `Sheet of "${look.name}" ready`), look.name)}
        onMany={(look) => { compare(`${look.name} · ${t('人设图', 'design sheet')}`, 'sheet', look.name) }}
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
        <Button size="sm" variant="ghost" icon="layers" disabled={dirty} title={t('换几个配音服务念同一句，并排着听', 'The same line by several speech setups, side by side')} onClick={() => { setVoicing(true) }}>{t('对比…', 'Compare…')}</Button>
        {sample !== undefined ? <audio key={sample.at} controls preload="auto" src={mediaUrl(sample.path, sample.at)} className="nv-audio-inline" title={t('刚才的试听', 'The audition just recorded')} /> : voiceProfile.sample !== undefined ? <audio controls preload="none" src={mediaUrl(voiceProfile.sample)} className="nv-audio-inline" title={t('专属声线的样音', 'Sample of the designed voice')} /> : null}
      </div>

      <SectionTitle>{t('备注', 'Notes')}</SectionTitle>
      <TextArea {...text('notes')} minRows={3} maxRows={20} />
      </div>
      {viewing !== undefined ? (
        <PictureViewer
          path={viewing}
          title={`${draft.name} · ${pictures.find(item => item.path === viewing)?.label ?? moments.find(scene => scene.portrait === viewing)?.title ?? (draft.stages ?? []).find(stage => stage.visual?.sheet === viewing || stage.visual?.portrait === viewing)?.title ?? t('立绘', 'Portrait')}`}
          {...(viewStart !== undefined ? { start: viewStart } : {})}
          onClose={() => { setViewing(undefined); setViewStart(undefined) }}
          // Drawn again, it is the new one that is open: named as what it now is among their pictures — and shown under the page's picture too.
          onChanged={(now) => {
            if (now === undefined) return
            setViewing(now)
            setViewStart(undefined)
            if (picked?.startsWith('sheet:') === true) setPicked(`sheet:${now}`)
          }}
          onEditLook={(of) => {
            // How they look is written on this page, under "Looks": the form scrolls to it.
            if (of.kind === 'character' && of.id === card.id) {
              const field = document.getElementById(of.what === 'scene' ? sceneField : lookField)
              field?.scrollIntoView({ block: 'center', behavior: 'smooth' })
              field?.focus({ preventScroll: true })
            } else if (of.kind === 'character') controller.openCharacter(of.id)
            else controller.openWorld(of.id)
          }}
        />
      ) : null}
      {confirm.element}
      {voicing ? <SpeechTrialDialog of={{ character: { id: card.id, name: card.name } }} onClose={() => { setVoicing(false) }} /> : null}
      {many !== undefined ? <ImageTrialDialog of={{ draw: many }} onClose={() => { setMany(undefined) }} /> : null}
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
function StagesPanel({ card, value, dirty, busy, onChange, onDraw, onMany, onWrite, onOpen }: {
  card: CharacterCard
  value: CharacterStage[]
  dirty: boolean
  busy: boolean
  onChange: (stages: CharacterStage[]) => void
  onDraw: (kind: 'sheet' | 'portrait', stage: CharacterStage) => unknown
  /** The same picture by several image services, to compare. */
  onMany: (kind: 'sheet' | 'portrait', stage: CharacterStage) => void
  /** Have the director write how they look in a stretch, whole. */
  onWrite: (stage: CharacterStage) => void
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
              {(stage.visual?.prompt ?? '').trim().length > 0 ? (
                <p className="nv-muted nv-small">
                  {t('旧的视觉锚点（画图仍照它）：', 'The old visual anchor (pictures still go by it): ')}{stage.visual?.prompt}{' '}
                  <button type="button" className="nv-link nv-small" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('导演把它并进这个时期的样子，然后去掉它', 'The director folds it into how they look in this stretch, and it is gone')} onClick={() => { onWrite(stage) }}>{t('并进这个时期的样子', "Fold into this stretch's look")}</button>
                  {' · '}
                  <button type="button" className="nv-link nv-small" onClick={() => { const { prompt: _old, ...rest } = stage.visual ?? {}; patch(stage.id, { visual: rest }) }}>{t('丢掉', 'Drop it')}</button>
                </p>
              ) : apart ? <button type="button" className="nv-link nv-small" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('导演从人物卡的外貌出发，把这个时期的样子写全', "The director writes how they look in this stretch whole, starting from the card's appearance")} onClick={() => { onWrite(stage) }}>{t('让导演写全这个时期的样子', 'Have the director write it whole')}</button> : null}
              {apart ? (
                <div className="nv-row-wrap">
                  <Button size="sm" variant="outline" icon="users" disabled={dirty || busy} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => onDraw('sheet', stage)}>{stage.visual?.sheet !== undefined ? t('重画这时的人设图', 'Redraw its sheet') : t('画这时的人设图', 'Draw its sheet')}</Button>
                  <Button size="sm" variant="ghost" icon="layers" disabled={dirty} title={t('多模型：几个绘图服务各画一张这时的人设图', "Several models: this stretch's sheet from each image service")} aria-label={t('多模型', 'Several models')} onClick={() => { onMany('sheet', stage) }} />
                  <ImportPicture kind="sheet" of={{ character: card.id, stage: stage.id }} disabled={dirty} />
                  <Button size="sm" variant="outline" icon="image" disabled={dirty || busy} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => onDraw('portrait', stage)}>{stage.visual?.portrait !== undefined ? t('重画这时的立绘', 'Redraw its portrait') : t('画这时的立绘', 'Draw its portrait')}</Button>
                  <Button size="sm" variant="ghost" icon="layers" disabled={dirty} title={t('多模型：几个绘图服务各画一张这时的立绘', "Several models: this stretch's portrait from each image service")} aria-label={t('多模型', 'Several models')} onClick={() => { onMany('portrait', stage) }} />
                  <ImportPicture kind="portrait" of={{ character: card.id, stage: stage.id }} disabled={dirty} />
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
function ScenesPanel({ id, card, value, marked, dirty, off, busy, onChange, onDraw, onMany, onOpen, picturesOf, onUse }: {
  id: string
  card: CharacterCard
  value: SignatureScene[]
  marked: string | undefined
  dirty: boolean
  off: boolean
  busy: boolean
  onChange: (scenes: SignatureScene[], marked?: string) => void
  onDraw: (scene: SignatureScene) => unknown
  /** The same picture by several image services, to compare. */
  onMany: (scene: SignatureScene) => void
  onOpen: (path: string) => void
  /** The pictures drawn of a moment, the one that stands for it first. */
  picturesOf: (scene: SignatureScene) => string[]
  /** Have another of them stand for it. */
  onUse: (scene: SignatureScene, path: string) => unknown
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
  // The frame the director made of a moment stands beside it, as its picture does: changing it does not make the list the author's.
  const reframe = (scene: SignatureScene, shot: SceneShot | undefined): void => { onChange(value.map((item) => { if (item.id !== scene.id) return item; const { shot: _was, ...rest } = item; return shot !== undefined ? { ...rest, shot } : rest }), marked) }
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
        // Every picture drawn of it — by what each picture's record says it is of — and the one that stands for it.
        const drawn = picturesOf(scene)
        const lead = drawn[0]
        return (
          <div key={scene.id} className={cx('nv-scene-row', first && 'is-first')}>
            {lead !== undefined
              ? <button type="button" className="nv-scene-thumb" onClick={() => { onOpen(lead) }} title={t('点开看大图', 'Open it large')}><ProjectImage path={lead} alt={scene.title} /></button>
              : <span className="nv-scene-thumb nv-look-empty">{t('未画', 'none')}</span>}
            <div className="nv-scene-fields">
              <div className="nv-scene-head">
                <TextInput value={scene.title} placeholder={t('哪一幕', 'Which moment')} onChange={(event) => { patch(scene.id, { title: event.target.value }) }} />
                {chapter !== undefined ? <button type="button" className="nv-link nv-small" onClick={() => { controller.openReader('read', chapter.id) }}>{t(`第 ${chapter.index} 章`, `Ch. ${chapter.index}`)}</button> : null}
                {first ? <Chip>{t('立绘默认', 'Default')}</Chip> : <button type="button" className="nv-link nv-small" onClick={() => { onChange(own(value), scene.id) }}>{t('设为默认', 'Make default')}</button>}
                <Button size="sm" variant="outline" icon="image" disabled={dirty || busy || scene.text.trim().length === 0} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => onDraw(scene)}>{lead !== undefined ? t('再画一张', 'Draw another') : t('画这一幕', 'Draw it')}</Button>
                <Button size="sm" variant="ghost" icon="layers" disabled={dirty || scene.text.trim().length === 0} title={t('多模型：几个绘图服务各画一张这一幕', "Several models: this moment from each image service")} aria-label={t('多模型', 'Several models')} onClick={() => { onMany(scene) }} />
                <ImportPicture kind="portrait" of={{ character: card.id, scene: scene.id }} disabled={dirty || scene.text.trim().length === 0} />
                <Button size="sm" variant="ghost" icon="trash" title={t('删除', 'Delete')} onClick={() => { onChange(own(value.filter(item => item.id !== scene.id)), marked === scene.id ? undefined : marked) }} />
              </div>
              <TextArea value={scene.text} minRows={2} maxRows={8} placeholder={t('写成画面：在哪里、在做什么、手里拿着什么、光线', 'As a picture: where, doing what, holding what, the light')} onChange={(event) => { patch(scene.id, { text: event.target.value }) }} />
              {scene.why !== undefined ? <p className="nv-muted nv-small">{scene.why}</p> : scene.from === 'digest' ? <p className="nv-muted nv-small">{t('收录这一章时场记记下的', 'Noted by the digest of this chapter')}</p> : null}
              {scene.shot !== undefined ? (() => {
                const shot = scene.shot
                // Made of the moment as it was told then: told otherwise since, it is made again with the next picture.
                const stale = shotOf(scene) === undefined
                const set = (change: Partial<SceneShot>): void => { reframe(scene, { ...shot, ...change }) }
                return (
                  <details className="nv-scene-shot">
                    <summary>{t('画的时候用的一格', 'The frame it is drawn from')}{stale ? <em className="nv-muted nv-small"> · {t('这一幕改过了，下次画时导演重新整理', 'the moment was changed: made again with the next picture')}</em> : <span className="nv-muted nv-small"> · {clipText(shot.action, 28)}</span>}</summary>
                    <label><span>{t('这一刻', 'The instant')}</span><TextArea value={shot.action} minRows={1} maxRows={4} onChange={(event) => { set({ action: event.target.value }) }} /></label>
                    <label><span>{t('穿着', 'Wearing')}</span><TextArea value={shot.outfit ?? ''} minRows={1} maxRows={4} placeholder={shot.look !== undefined ? t(`造型「${shot.look}」`, `The look "${shot.look}"`) : t('空着：照平常的样子', 'Empty: as they usually look')} onChange={(event) => { set({ outfit: event.target.value }) }} /></label>
                    <label><span>{t('环境', 'Around')}</span><TextArea value={shot.setting ?? ''} minRows={1} maxRows={4} onChange={(event) => { set({ setting: event.target.value }) }} /></label>
                    <p className="nv-muted nv-small">
                      {shot.why !== undefined ? `${t('导演：', 'The director: ')}${shot.why} ` : null}
                      <button type="button" className="nv-link nv-small" title={t('清掉这一格：下次画这一幕时导演重新读正文整理', 'Clear the frame: the director reads the text again with the next picture of it')} onClick={() => { reframe(scene, undefined) }}>{t('清掉重新整理', 'Clear, to be made again')}</button>
                    </p>
                  </details>
                )
              })() : null}
              {drawn.length > 1 ? (
                // Drawn more than once — redrawn, its prompt rewritten, tried with another service: which one is the moment's is the author's to say.
                <div className="nv-scene-pictures">
                  <span className="nv-muted nv-small">{t(`画过 ${drawn.length} 张`, `${drawn.length} pictures of it`)}</span>
                  {drawn.map((path, at) => (
                    <span key={path} className={cx('nv-scene-pick', at === 0 && 'is-own')}>
                      <button type="button" className="nv-scene-mini" onClick={() => { onOpen(path) }} title={t('点开看大图', 'Open it large')}><ProjectImage path={path} alt={scene.title} /></button>
                      {at === 0
                        ? <em>{t('用这张', 'In use')}</em>
                        : <button type="button" className="nv-link nv-small" disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('这一幕改用这张：这里和正文里讲到它的地方都换成它', 'Have this one stand for the moment, here and in the text where it is told')} onClick={() => { void onUse(scene, path) }}>{t('改用这张', 'Use this one')}</button>}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LooksEditor({ owner, value, dirty, busy, onChange, onDraw, onMany }: { /** Whose looks they are. */ owner: string; value: CharacterLook[]; dirty: boolean; busy: boolean; onChange: (looks: CharacterLook[]) => void; onDraw: (look: CharacterLook) => unknown; /** The same sheet by several image services, to compare. */ onMany: (look: CharacterLook) => void }) {
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
              <Button size="sm" variant="ghost" icon="layers" disabled={dirty || look.name.trim().length === 0 || (look.prompt ?? '').trim().length === 0} title={t('多模型：几个绘图服务各画一张这套造型的人设图', "Several models: this look's sheet from each image service")} aria-label={t('多模型', 'Several models')} onClick={() => { onMany(look) }} />
              <ImportPicture kind="sheet" of={{ character: owner, look: look.name }} disabled={dirty || look.name.trim().length === 0} />
              <Button size="sm" variant="ghost" icon="trash" onClick={() => { onChange(value.filter((_, at) => at !== index)) }}>{t('移除', 'Remove')}</Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

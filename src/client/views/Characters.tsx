// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A book's people, card by card: the list of everyone who has a card, and one
 * person's page — their picture large beside who they are, then everything
 * the writer, the director and the voices are told about them.
 *
 *   CharacterCards   the list and the page of whoever is chosen in it
 *   CardPhoto        somebody's face for a list
 *   ROLE_LABELS…     how parts and stages of a life are called
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { VoiceOption } from '../../shared/rpc'
import type { CharacterCard, CharacterLook, CharacterRole, CharacterStatus } from '../../shared/types'
import { spanText, type Life, type LifeEvent } from '../../shared/life'
import { lines, options, useAssist } from '../forms'
import { TiesBlock } from '../Ties'
import { Icon } from '../icons'
import {
  Button, Chip, cx, Empty, Field, Modal, ProjectImage, SectionTitle, Select, TextArea, TextInput, useAction, useConfirm, useMediaUrl,
  useProject, useRunningJob, useSnapshot, useStudio, useT,
} from '../ui'

export const ROLE_LABELS: Record<CharacterRole, [string, string]> = {
  protagonist: ['主角', 'Protagonist'],
  deuteragonist: ['第二主角', 'Deuteragonist'],
  antagonist: ['反派', 'Antagonist'],
  supporting: ['配角', 'Supporting'],
  minor: ['次要', 'Minor'],
  cameo: ['龙套', 'Cameo'],
}

export const STATUS_LABELS: Record<CharacterStatus, [string, string]> = {
  planned: ['未登场', 'Planned'],
  active: ['活跃', 'Active'],
  offstage: ['暂离', 'Offstage'],
  retired: ['已退场', 'Retired'],
  dead: ['已死亡', 'Dead'],
}

export const STATUS_TONES: Record<CharacterStatus, 'neutral' | 'green' | 'amber' | 'blue' | 'red'> = {
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

export function CharacterCards({ shown, grouped, searching, lives }: { shown: CharacterCard[]; grouped: boolean; searching: boolean; lives?: Lives | undefined }) {
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
    const created = await controller.api.call('character.save', { root, card: { name: name.trim(), role: 'supporting', status: 'planned' } })
    setSelected(created.id)
    setCreating(false)
    setName('')
  })
  const drawingAny = useRunningJob(job => job.kind === 'illustrate' && job.title === 'illustrate portrait')
  const [batch, setBatch] = useState<{ done: number; total: number } | undefined>()
  const drawAll = (): void => {
    if (!controller.need('image')) return
    const todo = faceless.map(item => item.id)
    confirm.ask(t(`要为列表里还没有定妆照的 ${todo.length} 个人物各画一张吗？每张调用一次绘图模型，一张一张画，随时可以在底部停下。（只画现在筛出来的这些人；想少画就先在上面筛一下。）`, `Draw a portrait for each of the ${todo.length} characters listed here without one? One image-model call each, one after another; stop any time from the bar below. (Only the people the filter shows: narrow it first to draw fewer.)`), () => {
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
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const groups = grouped
    ? GROUPS.map(group => ({ ...group, cards: listed.filter(item => group.roles.includes(item.role)) })).filter(group => group.cards.length > 0)
    : [{ key: 'all' as const, roles: [] as CharacterRole[], label: ['', ''] as [string, string], cards: listed }].filter(group => group.cards.length > 0)
  const row = (item: CharacterCard): ReactNode => (mode === 'photos' ? (
    <li key={item.id}>
      <button type="button" className={cx('nv-photo-card', item.id === selected && 'is-active')} onClick={() => { setSelected(item.id) }} title={item.tagline}>
        <CardPhoto card={item} />
        <span className={cx('nv-dot nv-photo-status', `is-status-${item.status}`)} title={t(...STATUS_LABELS[item.status])} />
        <span className="nv-photo-name">{item.name}</span>
        <span className="nv-photo-meta">{t(...ROLE_LABELS[item.role])}</span>
      </button>
    </li>
  ) : (
    <li key={item.id}>
      <button type="button" className={cx('nv-list-row nv-person', item.id === selected && 'is-active')} onClick={() => { setSelected(item.id) }}>
        <span className="nv-avatar nv-avatar-empty">{item.name.slice(0, 1)}</span>
        <span className="nv-person-text">
          <span className="nv-list-title">{item.name}</span>
          <span className="nv-list-meta">{t(...ROLE_LABELS[item.role])}{item.tagline !== undefined ? ` · ${item.tagline}` : ''}</span>
        </span>
        <Chip tone={STATUS_TONES[item.status]}>{t(...STATUS_LABELS[item.status])}</Chip>
      </button>
    </li>
  ))
  return (
    <div className={cx('nv-split nv-people', mode === 'photos' && 'has-photos')}>
      <aside className="nv-split-list">
        <div className="nv-people-tools">
          <div className="nv-seg" role="group" aria-label={t('人物列表的样子', 'How the list looks')}>
            <button type="button" className={cx(mode === 'photos' && 'is-active')} onClick={() => { pick('photos') }} title={t('每个人显示定妆照（立绘；没有立绘时用人设图的正面）', 'Show everyone\'s portrait (or the front view of their design sheet)')}><Icon name="users" size={13} /><span>{t('定妆照', 'Portraits')}</span></button>
            <button type="button" className={cx(mode === 'minimal' && 'is-active')} onClick={() => { pick('minimal') }} title={t('只看名字和定位，不显示图片', 'Names and roles only, no pictures')}><Icon name="list" size={13} /><span>{t('极简', 'Minimal')}</span></button>
          </div>
          <Button size="sm" icon="plus" variant="primary" onClick={() => { setCreating(true) }}>{t('新建人物', 'New character')}</Button>
        </div>
        {mode === 'photos' && faceless.length > 0 ? (
          <Button size="sm" variant="ghost" icon="sparkles" busy={batch !== undefined} disabled={drawingAny !== undefined && batch === undefined} pending={batch !== undefined ? t(`正在画定妆照 ${batch.done}/${batch.total}…`, `Drawing portraits ${batch.done}/${batch.total}…`) : undefined} onClick={drawAll} title={t('给列表里还没有定妆照的人物各画一张立绘', 'Draw a portrait for everyone listed who has none')}>{t(`补齐定妆照（${faceless.length}）`, `Draw missing portraits (${faceless.length})`)}</Button>
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
          ? <p className="nv-muted nv-pad">{t('还没有人物。新建一个，或让总编 / 策划根据故事核起草。', 'No characters yet. Create one, or let the showrunner draft the cast from the premise.')}</p>
          : listed.length === 0 ? <p className="nv-muted nv-pad">{t('上面的筛选条件下没有人物。', 'Nobody passes the filter above.')}</p> : null}
        <button type="button" className="nv-add-row" onClick={() => { controller.openCast('walkons') }}>{t('没立卡的路人、龙套在"龙套"页签里管 →', 'People without a card are kept under Walk-ons →')}</button>
      </aside>
      <section className="nv-split-detail">
        {card !== undefined ? <CharacterEditor key={card.id} card={card} lives={lives} onDeleted={() => { setSelected(undefined) }} /> : <Empty icon="users" title={t('选择或新建一个人物', 'Select or create a character')} />}
      </section>
      {creating ? (
        <Modal title={t('新建人物', 'New character')} onClose={() => { setCreating(false) }} footer={<Button variant="primary" busy={busy} disabled={name.trim().length === 0} onClick={create}>{t('创建', 'Create')}</Button>}>
          <Field label={t('姓名', 'Name')}><TextInput autoFocus value={name} onChange={(event) => { setName(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && name.trim().length > 0) create() }} /></Field>
        </Modal>
      ) : null}
      {confirm.element}
    </div>
  )
}

const LIFE_MARK: Record<LifeEvent['kind'], [string, string]> = { enter: ['登场', 'comes on'], seen: ['', ''], return: ['回归', 'returns'], exit: ['离开', 'leaves'], death: ['死亡', 'dies'] }

/**
 * Somebody's life on the page: a strip of the line's chapters with the ones
 * they are in filled, a line saying where they come on, stay and leave, the
 * paragraph that tells it — the author's to edit, continuity's to write — and
 * every chapter's note behind a fold.
 */
function LifeBlock({ card, lives, value, dirty, onChange }: { card: CharacterCard; lives: Lives; value: string; dirty: boolean; onChange: (value: string) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
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
  return (
    <section className="nv-life">
      <SectionTitle actions={(
        <Button size="sm" icon="feather" disabled={dirty || life === undefined} busy={writing} pending={t('场记正在写…', 'Continuity is writing…')} onClick={write} title={dirty ? t('先保存当前修改', 'Save your edits first') : life === undefined ? t('还没有哪一章的收录里记到这个人', 'No chapter\'s digest names them yet') : t('让场记根据各章的收录，把这个人在书里的经历写成一段话', 'Have continuity tell their life in the book in a paragraph, from the chapter digests')}>{value.length > 0 ? t('重写一段', 'Write it again') : t('写成一段话', 'Tell it in a paragraph')}</Button>
      )}>{t('履历', 'Life on the page')}{lives.line !== undefined ? <span className="nv-muted"> · {lives.line.title}</span> : null}</SectionTitle>
      {lives.chapters.length > 0 ? (
        <div className="nv-life-strip" role="img" aria-label={t('各章是否在场', 'Presence, chapter by chapter')}>
          {lives.chapters.map((chapter) => {
            const event = at.get(chapter.index)
            return (
              <button
                key={chapter.id}
                type="button"
                className={cx('nv-life-tick', event !== undefined && 'is-on', event !== undefined && event.kind !== 'seen' && `is-${event.kind}`, !chapter.digested && 'is-unread')}
                title={`${t(`第 ${chapter.index} 章`, `Ch. ${chapter.index}`)} · ${chapter.title}${event !== undefined ? ` — ${event.kind !== 'seen' ? `${t(...LIFE_MARK[event.kind])}${event.what !== undefined ? '：' : ''}` : ''}${event.what ?? t('在场', 'present')}` : chapter.digested ? '' : t('（这一章还没有收录）', ' (not digested yet)')}`}
                onClick={() => { controller.setView('read', chapter.id) }}
              />
            )
          })}
        </div>
      ) : null}
      {life !== undefined && life.events.length > 0 ? (
        <p className="nv-life-line">
          {t(`第 ${life.first} 章登场`, `Comes on in chapter ${life.first}`)}
          {t(` · 在场：第 ${spanText(life.spans).join('、')} 章`, ` · present: chapters ${spanText(life.spans).join(', ')}`)}
          {life.death !== undefined ? <strong className="is-dead">{t(` · 第 ${life.death} 章死亡`, ` · dies in chapter ${life.death}`)}</strong> : life.exit !== undefined ? <strong>{t(` · 第 ${life.exit} 章离开`, ` · leaves in chapter ${life.exit}`)}</strong> : t(` · 最后一次在第 ${life.last} 章`, ` · last seen in chapter ${life.last}`)}
          <span className="nv-muted">{t(`（共 ${life.events.length} 章；这条线已收录 ${digested} / ${lives.chapters.length} 章）`, ` (${life.events.length} chapters; ${digested} of this line's ${lives.chapters.length} digested)`)}</span>
        </p>
      ) : (
        <p className="nv-muted nv-small">{digested === 0 ? t('这条线上还没有收录过的章节：履历是从各章的收录里读出来的。', 'No chapter of this line is digested yet: a life is read off the chapter digests.') : t(`已收录的 ${digested} 章里都没有记到这个人。`, `None of the ${digested} digested chapters names them.`)}</p>
      )}
      <Field label={t('履历（一段话）', 'The life, in a paragraph')} hint={t('这个人在书里实际经历了什么——和"人物弧光"（打算怎么写）不同。可以自己写，也可以让场记按收录写。', 'What they actually go through in the book — unlike the arc, which is the plan. Write it yourself, or have continuity write it from the digests.')}>
        <TextArea value={value} minRows={2} maxRows={10} onChange={(event) => { onChange(event.target.value) }} />
      </Field>
      {life !== undefined && life.events.length > 0 ? (
        <>
          <button type="button" className="nv-link nv-small" onClick={() => { setOpen(!open) }}>{open ? t('收起逐章记录', 'Fold the chapter notes') : t(`逐章记录（${life.events.length}）`, `Chapter by chapter (${life.events.length})`)}</button>
          {open ? (
            <ol className="nv-life-events">
              {life.events.map(event => (
                <li key={event.chapter} className={cx(event.kind !== 'seen' && `is-${event.kind}`)}>
                  <button type="button" className="nv-link" onClick={() => { controller.setView('read', event.chapter) }}>{t(`第 ${event.index} 章`, `Ch. ${event.index}`)} {titles.get(event.chapter) ?? ''}</button>
                  {event.kind !== 'seen' ? <Chip tone={event.kind === 'death' ? 'red' : event.kind === 'exit' ? 'amber' : 'green'}>{t(...LIFE_MARK[event.kind])}</Chip> : null}
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
  const setPersona = (patch: Partial<NonNullable<CharacterCard['persona']>>): void => { set('persona', { ...persona, ...patch }) }
  const save = (): Promise<unknown> => run(async () => {
    // Empty strings clear fields on the Host; arrays are sent whole.
    const payload: Record<string, unknown> = { ...draft, aliases: draft.aliases ?? [], relationships: draft.relationships ?? [], tags: draft.tags ?? [] }
    for (const key of ['tagline', 'gender', 'age', 'appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice', 'abilities', 'secrets', 'notes', 'life']) {
      if (payload[key] === undefined) payload[key] = ''
    }
    await controller.api.call('character.save', { root, card: payload as Partial<CharacterCard> })
    setDirty(false)
    controller.toast('success', t('已保存', 'Saved'))
  })
  const presence = project.presence.find(entry => entry.character === card.id)
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
  const draw = (kind: 'sheet' | 'portrait', done: string, look?: string): Promise<unknown> | undefined => {
    if (!controller.need('image')) return undefined
    return controller.guard(async () => {
      await controller.run('image.create', { root, kind, target: card.id, ...(look !== undefined ? { look } : {}) })
      controller.toast('success', done)
    })
  }

  // The pictures there are of this person: the portrait, the design sheet, and a sheet per look.
  const pictures: { key: string; label: string; path: string; wide: boolean }[] = [
    ...(draft.visual?.portrait !== undefined ? [{ key: 'portrait', label: t('立绘', 'Portrait'), path: draft.visual.portrait, wide: false }] : []),
    ...(draft.visual?.sheet !== undefined ? [{ key: 'sheet', label: t('人设图', 'Design sheet'), path: draft.visual.sheet, wide: true }] : []),
    ...(draft.visual?.looks ?? []).filter(look => look.sheet !== undefined).map(look => ({ key: `look:${look.id}`, label: look.name.length > 0 ? look.name : t('造型', 'Look'), path: look.sheet!, wide: true })),
  ]
  const [picked, setPicked] = useState<string | undefined>()
  const [viewing, setViewing] = useState(false)
  const picture = pictures.find(item => item.key === picked) ?? pictures[0]
  const sheetBusy = drawing?.title === 'illustrate sheet'
  const portraitBusy = drawing?.title === 'illustrate portrait'

  return (
    <div className={cx('nv-person-page', pictures.length === 0 && 'is-bare')}>
      <aside className="nv-person-figure">
        {picture !== undefined ? (
          <button type="button" className={cx('nv-person-picture', picture.wide && 'is-wide')} onClick={() => { setViewing(true) }} title={t('点开看大图', 'Open it large')}>
            <ProjectImage path={picture.path} alt={`${draft.name} · ${picture.label}`} />
          </button>
        ) : (
          <div className="nv-person-picture is-empty">
            <span aria-hidden="true">{draft.name.slice(0, 1)}</span>
            <em>{t('还没有画像', 'No picture yet')}</em>
          </div>
        )}
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
          <Button size="sm" variant={draft.visual?.portrait === undefined ? 'primary' : 'outline'} icon="image" disabled={dirty || (drawing !== undefined && !portraitBusy)} busy={portraitBusy} pending={t('正在画立绘…', 'Drawing the portrait…')} onClick={() => draw('portrait', t('立绘已生成', 'Portrait ready'))} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('半身定妆照：列表、群像和这一页用的那张脸', 'A half-length portrait: the face the lists and this page use')}>{draft.visual?.portrait !== undefined ? t('重画立绘', 'Redraw portrait') : t('画立绘', 'Draw portrait')}</Button>
          <Button size="sm" variant="outline" icon="users" disabled={dirty || (drawing !== undefined && !sheetBusy)} busy={sheetBusy} pending={t('正在画人设图（约一两分钟）…', 'Drawing the sheet (a minute or two)…')} onClick={() => draw('sheet', t('人设图已生成', 'Design sheet ready'))} title={dirty ? t('先保存当前修改', 'Save your edits first') : t('正面、侧面、背面三视图：之后每张有此人的图都以它为参考，长相才一致', 'Front, side and back: every later picture of them is drawn with it as reference, which is what keeps the face the same')}>{draft.visual?.sheet !== undefined ? t('重画人设图', 'Redraw sheet') : t('生成人设图', 'Design sheet')}</Button>
        </div>
        {draft.visual?.sheet === undefined ? <p className="nv-muted nv-small">{t('先生成人设图：它是之后所有图里这个人长相一致的依据。', 'Start with the design sheet: it is what keeps this face the same in every later picture.')}</p> : null}
      </aside>

      <div className="nv-editor-form nv-person-main">
      <header className="nv-detail-head nv-person-head">
        <div className="nv-person-title">
          <h2>{draft.name}<Chip tone="neutral">{t(...ROLE_LABELS[draft.role])}</Chip><Chip tone={STATUS_TONES[draft.status]}>{t(...STATUS_LABELS[draft.status])}</Chip></h2>
          {draft.tagline !== undefined && draft.tagline.length > 0 ? <p className="nv-person-tagline">{draft.tagline}</p> : null}
          <span className="nv-muted nv-small">
            {presence !== undefined && presence.chapters.length > 0
              ? presence.absentFor > 0 ? t(`出场 ${presence.chapters.length} 章，最近一次在 ${presence.absentFor} 章前`, `In ${presence.chapters.length} chapters; last seen ${presence.absentFor} chapters ago`) : t(`出场 ${presence.chapters.length} 章，最近一章还在场`, `In ${presence.chapters.length} chapters, the latest among them`)
              : t('尚未在正文中出场', 'Not on the page yet')}
            {' · '}
            <button type="button" className="nv-link" onClick={() => { controller.openCast('presence') }}>{t('出场分布', 'Presence')}</button>
            {' · '}
            <button type="button" className="nv-link" onClick={() => { controller.openCast('relations') }}>{t('关系图', 'Relationships')}</button>
            {' · '}<button type="button" className="nv-link" onClick={() => { controller.openExplore({ type: 'character', id: card.id }) }} title={t('观看：他在"观看 → 人物"里的样子——读者看到的那一页', 'View: their page in the viewer\'s People — what a reader is shown')}>{t('观看', 'View')}</button>
          </span>
        </div>
        <div className="nv-row">
          <Button variant="ghost" size="sm" icon="trash" busy={busy} onClick={() => { confirm.ask(t(`删除人物「${card.name}」？`, `Delete the character "${card.name}"?`), () => { void run(async () => { await controller.api.call('character.delete', { root, id: card.id }); onDeleted() }) }) }} title={t('删除这张人物卡', 'Delete this card')} />
          <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
        </div>
      </header>

      {lives !== undefined ? <LifeBlock card={card} lives={lives} value={draft.life ?? ''} dirty={dirty} onChange={(value) => { set('life', value) }} /> : null}
      <TiesBlock of={{ type: 'character', id: card.id }} />

      <div className="nv-assist">
        <TextInput value={direction} placeholder={t('让 AI 补全这张人物卡（可写要求，如"给他一个不愿提起的过去"）', 'Let AI complete this card (optionally say what you want)')} onChange={(event) => { setDirection(event.target.value) }} />
        <Button icon="sparkles" busy={assist.running} pending={t('AI 正在补全…', 'Completing…')} disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => { assist.start(async (onText) => { await controller.run('character.expand', { root, id: card.id, ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, onText); setDirection('') }) }}>{t('AI 补全', 'Complete')}</Button>
      </div>
      {assist.stream.length > 0 ? <pre className="nv-stream">{assist.stream.slice(-800)}</pre> : null}

      <SectionTitle>{t('基本', 'Basics')}</SectionTitle>
      <div className="nv-form-grid">
        <Field label={t('姓名', 'Name')}><TextInput value={draft.name} onChange={(event) => { set('name', event.target.value) }} /></Field>
        <Field label={t('别名 / 称呼', 'Aliases')} hint={t('用顿号或逗号分隔', 'Comma separated')}><TextInput value={(draft.aliases ?? []).join('、')} onChange={(event) => { set('aliases', event.target.value.split(/[、,，]+/).map(item => item.trim()).filter(Boolean)) }} /></Field>
        <Field label={t('定位', 'Role')}><Select value={draft.role} options={options(ROLE_LABELS, t)} onChange={(value) => { set('role', value) }} /></Field>
        <Field label={t('生命周期', 'Lifecycle')}><Select value={draft.status} options={options(STATUS_LABELS, t)} onChange={(value) => { set('status', value) }} /></Field>
        <Field label={t('性别', 'Gender')}><TextInput {...text('gender')} /></Field>
        <Field label={t('年龄', 'Age')}><TextInput {...text('age')} /></Field>
      </div>
      <Field label={t('一句话人设', 'One-line identity')}><TextInput {...text('tagline')} /></Field>

      <SectionTitle>{t('内在', 'Inner life')}</SectionTitle>
      <Field label={t('性格', 'Personality')}><TextArea {...text('personality')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('动机（想要 / 需要）', 'Motivation (want / need)')}><TextArea {...text('motivation')} /></Field>
        <Field label={t('弱点', 'Flaw')}><TextArea {...text('flaw')} /></Field>
      </div>
      <Field label={t('人物弧光', 'Arc')}><TextArea {...text('arc')} /></Field>
      <Field label={t('背景', 'Background')}><TextArea {...text('background')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('能力', 'Abilities')}><TextArea {...text('abilities')} /></Field>
        <Field label={t('秘密', 'Secrets')} hint={t('作者知道、他人未必知道', 'Known to the author, not to everyone')}><TextArea {...text('secrets')} /></Field>
      </div>

      <SectionTitle>{t('人格', 'Persona')}</SectionTitle>
      <div className="nv-form-grid">
        <Field label={t('特质', 'Traits')} hint={t('每行一个，可写强度：倔强 5', 'One per line, optional intensity: stubborn 5')}>
          <TextArea value={(persona.traits ?? []).map(trait => `${trait.name}${trait.level !== undefined ? ` ${trait.level}` : ''}`).join('\n')} onChange={(event) => {
            setPersona({ traits: lines(event.target.value).map((line) => {
              const match = /^(.*?)[\s:：]*([1-5])$/.exec(line)
              return match !== null && match[1] !== undefined && match[1].trim().length > 0 ? { name: match[1].trim(), level: Number(match[2]) } : { name: line }
            }) })
          }} />
        </Field>
        <Field label={t('看重的东西', 'Values')} hint={t('每行一个，按优先级', 'One per line, by priority')}><TextArea value={(persona.values ?? []).join('\n')} onChange={(event) => { setPersona({ values: lines(event.target.value) }) }} /></Field>
        <Field label={t('说话习惯', 'Speech habits')} hint={t('口头禅、句式、语域', 'Catchphrases, sentence shape, register')}><TextArea value={(persona.speech ?? []).join('\n')} onChange={(event) => { setPersona({ speech: lines(event.target.value) }) }} /></Field>
        <Field label={t('绝不会', 'Would never')}><TextArea value={(persona.taboos ?? []).join('\n')} onChange={(event) => { setPersona({ taboos: lines(event.target.value) }) }} /></Field>
      </div>
      <Field label={t('压力下的反应', 'Under pressure')}><TextInput value={persona.underPressure ?? ''} onChange={(event) => { setPersona({ underPressure: event.target.value }) }} /></Field>
      <Field label={t('对白的声音', 'Voice on the page')} hint={t('写手据此写对白', 'The writer uses this for dialogue')}><TextArea {...text('voice')} /></Field>

      <SectionTitle>{t('关系', 'Relationships')}</SectionTitle>
      <RelationshipEditor value={draft.relationships ?? []} onChange={(value) => { set('relationships', value) }} />

      <SectionTitle actions={<Button size="sm" icon="wand" disabled={dirty} busy={anchoring} pending={t('正在提炼…', 'Distilling…')} title={t('让场记把外貌改写成绘图模型画得稳的短语', 'Have continuity rewrite the appearance as phrases an image model draws consistently')} onClick={() => controller.guard(async () => { await controller.run('character.visual', { root, id: card.id }); controller.toast('success', t('视觉锚点已更新', 'Visual anchor updated')) })}>{t('提炼视觉锚点', 'Distill anchor')}</Button>}>{t('形象', 'Looks')}</SectionTitle>
      <Field label={t('外貌', 'Appearance')} hint={t('写给读者和写手看的', 'Written for readers and for the writer')}><TextArea {...text('appearance')} /></Field>
      <Field label={t('视觉锚点', 'Visual anchor')} hint={t('写给绘图模型看的：具体、看得见、可复用的短语（英文最稳），如发型的实际形状、衣料与颜色、随身标志物。每张有此人的图都会原样带上。不要写机构名、头衔这类词——模型会按现实里最常见的样子去画。', 'Written for the image model: concrete, visible, reusable phrases (English is steadiest) — the actual shape of the hair, fabric and colour, signature items. Restated as is in every picture of them. No names of institutions or titles: a model draws the commonest real-world version.')}>
        <TextArea value={draft.visual?.prompt ?? ''} placeholder={t('留空时，生成人设图或立绘前会自动从"外貌"提炼', 'Left empty, it is distilled from "Appearance" before a sheet or portrait is drawn')} onChange={(event) => { set('visual', { ...draft.visual, prompt: event.target.value }) }} />
      </Field>
      <Field label={t('这个人物身上不要画出', 'Never drawn on them')} hint={t('逗号分隔；会并入每张有此人的图的"不要出现"', 'Comma-separated; joins the avoid list of every picture that shows them')}>
        <TextInput value={draft.visual?.negative ?? ''} placeholder={t('如：cross emblem, shoulder straps', 'e.g. cross emblem, shoulder straps')} onChange={(event) => { set('visual', { ...draft.visual, negative: event.target.value }) }} />
      </Field>
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
        <Button size="sm" icon="volume" disabled={dirty} pending={t('正在生成试听语音…', 'Recording the audition…')} title={t('用这个人物在有声剧里的声音念一句话——人物卡上的音色，或为他定下的那个。新声音第一次要先定音色，会久一些', 'Speak a line in the voice this character has in the audio drama — the one on the card, or the one cast for them. A new voice is set up first, which takes a little longer')} onClick={audition}>{t('试听', 'Audition')}</Button>
        <Button size="sm" icon="wand" disabled={dirty} busy={designing} pending={t('正在设计声线…', 'Designing the voice…')} onClick={() => (controller.need('tts') ? controller.guard(async () => { await controller.run('voice.design', { root, character: card.id }); controller.toast('success', t('专属声线已创建', 'Voice designed')) }) : undefined)}>{t('设计专属声线', 'Design a voice')}</Button>
        {sample !== undefined ? <audio key={sample.at} controls preload="auto" src={mediaUrl(sample.path, sample.at)} className="nv-audio-inline" title={t('刚才的试听', 'The audition just recorded')} /> : voiceProfile.sample !== undefined ? <audio controls preload="none" src={mediaUrl(voiceProfile.sample)} className="nv-audio-inline" title={t('专属声线的样音', 'Sample of the designed voice')} /> : null}
      </div>

      <SectionTitle>{t('备注', 'Notes')}</SectionTitle>
      <TextArea {...text('notes')} minRows={3} maxRows={20} />
      </div>
      {viewing && picture !== undefined ? (
        <Modal wide title={`${draft.name} · ${picture.label}`} onClose={() => { setViewing(false) }}>
          <ProjectImage className="nv-person-large" path={picture.path} alt={`${draft.name} · ${picture.label}`} />
          {picture.key !== 'portrait' ? <p className="nv-muted nv-small">{t('人设图（正面、侧面、背面）。之后每一张有此人的图，都会把它当参考图一起交给绘图模型。', 'Design sheet (front, side, back). Every later picture of them is drawn with it as a reference.')}</p> : null}
        </Modal>
      ) : null}
      {confirm.element}
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



function LooksEditor({ value, dirty, busy, onChange, onDraw }: { value: CharacterLook[]; dirty: boolean; busy: boolean; onChange: (looks: CharacterLook[]) => void; onDraw: (look: CharacterLook) => unknown }) {
  const t = useT()
  const patch = (index: number, change: Partial<CharacterLook>): void => { onChange(value.map((look, at) => (at === index ? { ...look, ...change } : look))) }
  return (
    <div className="nv-looks">
      <SectionTitle actions={<Button size="sm" variant="ghost" icon="plus" onClick={() => { onChange([...value, { id: `look-${Date.now().toString(36)}`, name: '' }]) }}>{t('添加造型', 'Add a look')}</Button>}>{t('造型（服饰）', 'Looks (outfits)')}</SectionTitle>
      {value.length === 0 ? <p className="nv-muted nv-small">{t('人物有不止一身行头时在这里添加：日常、戎装、丧服……每套造型从主人设图衍生出自己的人设图，所以换了衣服还是同一个人。画某一场戏时，会按场合选用。', 'Add a look when a character has more than one outfit: everyday, armour, mourning… Each look gets a sheet derived from the main one, so it is still the same person. A scene picks the look that fits its occasion.')}</p> : null}
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

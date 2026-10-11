// SPDX-License-Identifier: LGPL-3.0-or-later
/** Every picture made for the book, and a place to make more. */
import { useEffect, useMemo, useState } from 'react'
import { mergeAvoid, resolveArtStyle, splitAvoid, type ArtSource } from '../../shared/art'
import type { IllustrationInfo, SheetsAsk, WorldCategory } from '../../shared/types'
import { Icon } from '../icons'
import { PICTURE_KIND as KIND, PictureViewer } from '../PictureRecord'
import {
  Button, Chip, Empty, Field, Modal, ProjectImage, Select, Spinner, TextArea, TextInput, useAction, useConfirm, useLoad, useProject, useSnapshot, useStudio, useT,
} from '../ui'
import { ArtBatchDialog, batchOf } from '../Batch'
import { ManyModels } from '../Trial'
import { sheetsDrawn } from '../labels'
import { useSheetsAsk, type SheetsChoice } from '../SheetsAsk'
import { NeedsSetup } from '../views/Settings'

type CreateKind = 'cover' | 'sheet' | 'portrait' | 'location' | 'custom'

const SOURCE: Record<ArtSource, [string, string]> = {
  book: ['本书设定', 'Set for this book'],
  studio: ['来自工坊设置', 'From the Studio settings'],
  default: ['内置默认', 'Built-in default'],
}

/** The kinds of thing a picture can be of, or show: what the gallery is listed by besides the kind of picture. */
type SubjectGroup = 'people' | 'places' | 'houses' | 'things' | 'chapters'

const GROUPS: { id: SubjectGroup; label: [string, string] }[] = [
  { id: 'people', label: ['人物', 'People'] },
  { id: 'places', label: ['地点', 'Places'] },
  { id: 'houses', label: ['家族与组织', 'Houses'] },
  { id: 'things', label: ['物品', 'Things'] },
  { id: 'chapters', label: ['章节', 'Chapters'] },
]

const groupOfWorld = (category: WorldCategory | string | undefined): SubjectGroup | undefined => (
  category === 'location' || category === 'setting' ? 'places' : category === 'faction' ? 'houses' : category === 'item' ? 'things' : undefined)

export function Gallery() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const images = useLoad(signal => controller.api.call('image.list', { root }, signal), [root, project.revision])
  const [filter, setFilter] = useState<IllustrationInfo['kind'] | 'all'>('all')
  const [open, setOpen] = useState<IllustrationInfo | undefined>()
  const [creating, setCreating] = useState(false)
  const [batching, setBatching] = useState(false)
  const [kind, setKind] = useState<CreateKind>('cover')
  const [target, setTarget] = useState('')
  const [prompt, setPrompt] = useState('')
  const [look, setLook] = useState('')
  const [cast, setCast] = useState<string[]>([])
  const [avoid, setAvoid] = useState('')
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const drawing = jobs.filter(job => job.status === 'running' && job.kind === 'illustrate').length
    + jobs.filter(job => job.status === 'running').reduce((sum, job) => sum + (batchOf(job)?.what === 'art' ? batchOf(job)!.rows.reduce((count, row) => count + Object.values(row.steps).filter(step => step.state === 'running').length, 0) : 0), 0)
  // Who and what each picture is of or shows: whose it is (its target), whose reference pictures went along with it,
  // whom its parts name — and, for pictures kept without such a record, whose name its prompt says.
  const subjects = useMemo(() => {
    const everyone: { id: string; group: SubjectGroup; name: string; names: string[] }[] = [
      ...project.characters.map(card => ({ id: card.id, group: 'people' as const, name: card.name, names: [card.name, ...(card.aliases ?? [])] })),
      ...project.world.flatMap((entry) => { const group = groupOfWorld(entry.category); return group !== undefined ? [{ id: entry.id, group, name: entry.name, names: [entry.name, ...(entry.aliases ?? [])] }] : [] }),
      ...[...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].map(chapter => ({ id: chapter.id, group: 'chapters' as const, name: chapter.title, names: [] })),
    ]
    const byId = new Map(everyone.map(item => [item.id, item]))
    const shown = new Map<string, Set<string>>()
    for (const image of images.data?.images ?? []) {
      const of = new Set<string>()
      if (image.target !== undefined && byId.has(image.target)) of.add(image.target)
      const labels = new Set([...(image.parts?.references ?? []), ...(image.parts?.left ?? [])].map(reference => reference.label).concat((image.parts?.pieces ?? []).flatMap(piece => (piece.label !== undefined ? [piece.label] : []))))
      const told = image.parts?.pieces !== undefined || (image.parts?.references ?? []).length > 0
      for (const item of everyone) {
        if (item.group === 'chapters' || of.has(item.id)) continue
        const names = item.names.filter(name => name.trim().length >= 2)
        // A label may say more than the name ("沈蘅的立绘"); a prompt is searched only where the record names nobody.
        if (names.some(name => [...labels].some(label => label.includes(name))) || (!told && names.some(name => image.prompt.includes(name)))) of.add(item.id)
      }
      shown.set(image.id, of)
    }
    return { everyone, byId, shown }
  }, [images.data, project.characters, project.world, project.chapters, project.lines])
  const [group, setGroup] = useState<SubjectGroup | 'all'>('all')
  const [subject, setSubject] = useState<string | undefined>()
  const ofKind = (images.data?.images ?? []).filter(image => filter === 'all' || image.kind === filter)
  const inGroup = (image: IllustrationInfo, wanted: SubjectGroup): boolean => [...(subjects.shown.get(image.id) ?? [])].some(id => subjects.byId.get(id)?.group === wanted)
  const list = ofKind.filter(image => (group === 'all' || inGroup(image, group)) && (subject === undefined || subjects.shown.get(image.id)?.has(subject) === true))
  const kinds = [...new Set((images.data?.images ?? []).map(image => image.kind))]
  // Whoever has pictures, with how many, most first: what there is to list by.
  const counted = useMemo(() => {
    const counts = new Map<string, number>()
    for (const image of ofKind) for (const id of subjects.shown.get(image.id) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    return counts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjects, filter, images.data])
  const groups = GROUPS.filter(item => subjects.everyone.some(candidate => candidate.group === item.id && counted.has(candidate.id)))
  const members = group === 'all' ? [] : subjects.everyone.filter(item => item.group === group && counted.has(item.id)).sort((a, b) => (group === 'chapters' ? 0 : (counted.get(b.id) ?? 0) - (counted.get(a.id) ?? 0)))
  // Several pictures picked at once, to be deleted together.
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const pick = (id: string): void => { setPicked((previous) => { const next = new Set(previous); if (!next.delete(id)) next.add(id); return next }) }
  const chosen = list.filter(image => picked.has(image.id))
  const removePicked = (): void => {
    confirm.ask(
      t(`删除选中的 ${chosen.length} 张图？图片文件一起删掉，挂着它们的人物卡、设定条目、分镜会取下；正文里插着它们的那一行不动。删了找不回来。`, `Delete the ${chosen.length} pictures picked? The files go too, and whatever card, entry or panel showed them lets go of them; a line of the text that places one stays as it is. This cannot be undone.`),
      () => void run(async () => {
        const done = await controller.api.call('image.delete', { root, paths: chosen.map(image => image.path) })
        setPicked(new Set())
        await controller.refreshProject()
        images.reload()
        controller.toast('success', t(`删掉了 ${done.removed ?? chosen.length} 张${(done.released ?? []).length > 0 ? `；它们原来是这些的图，已取下：${[...new Set(done.released)].slice(0, 8).join('、')}${new Set(done.released).size > 8 ? '…' : ''}` : ''}`, `${done.removed ?? chosen.length} pictures deleted${(done.released ?? []).length > 0 ? `; taken off: ${[...new Set(done.released)].slice(0, 8).join(', ')}${new Set(done.released).size > 8 ? '…' : ''}` : ''}`))
      }),
    )
  }
  // Pictures drawn to be compared that nobody has taken yet: each thing's, side by side — and, of one press that drew
  // many things, all a service drew at once.
  const waiting = useMemo(() => {
    const things = new Map<string, IllustrationInfo[]>()
    for (const image of images.data?.images ?? []) {
      if (image.trial?.hang === undefined) continue
      things.set(image.trial.id, [...(things.get(image.trial.id) ?? []), image])
    }
    const rounds = new Map<string, { labels: Set<string>; things: Set<string> }>()
    for (const [id, pictures] of things) {
      const round = pictures[0]!.trial!.batch
      if (round === undefined) continue
      const of = rounds.get(round) ?? { labels: new Set<string>(), things: new Set<string>() }
      of.things.add(id)
      for (const picture of pictures) of.labels.add(picture.trial!.label)
      rounds.set(round, of)
    }
    return { things: [...things.values()], rounds: [...rounds].filter(([, of]) => of.things.size > 1), count: [...things.values()].reduce((sum, pictures) => sum + pictures.length, 0) }
  }, [images.data])
  const [dropOthers, setDropOthers] = useState(false)
  const takeOne = (image: IllustrationInfo, among: IllustrationInfo[]): Promise<unknown> => run(async () => {
    const others = dropOthers ? among.filter(other => other.path !== image.path).map(other => other.path) : []
    const done = await controller.api.call('trial.adopt', { root, path: image.path, ...(others.length > 0 ? { others } : {}) })
    await controller.refreshProject()
    images.reload()
    controller.toast('success', t(`用了「${image.trial!.label}」画的这张${done.replaced.length > 0 ? `，挂到了 ${done.replaced.join('、')} 上` : ''}${done.removed > 0 ? `；另外 ${done.removed} 张删掉了` : ''}`, `Took the one by ${image.trial!.label}${done.replaced.length > 0 ? `, now on ${done.replaced.join(', ')}` : ''}${done.removed > 0 ? `; the other ${done.removed} deleted` : ''}`))
  })
  const takeRound = (round: string, label: string): Promise<unknown> => run(async () => {
    const done = await controller.api.call('trial.adoptRound', { root, round, label, ...(dropOthers ? { others: true } : {}) })
    await controller.refreshProject()
    images.reload()
    controller.toast('success', t(`这一批用了「${label}」画的 ${done.taken} 张${done.removed > 0 ? `；另外 ${done.removed} 张删掉了` : ''}`, `Took the ${done.taken} by ${label}${done.removed > 0 ? `; the other ${done.removed} deleted` : ''}`))
  })
  const nameOf = (image: IllustrationInfo): string | undefined => {
    if (image.target === undefined) return undefined
    return project.characters.find(card => card.id === image.target)?.name
      ?? project.world.find(entry => entry.id === image.target)?.name
      ?? [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].find(chapter => chapter.id === image.target)?.title
  }
  const ofCharacter = kind === 'portrait' || kind === 'sheet'
  const targets = ofCharacter ? project.characters.map(card => ({ value: card.id, label: card.name })) : kind === 'location' ? project.world.filter(entry => entry.category === 'location' || entry.category === 'setting').map(entry => ({ value: entry.id, label: entry.name })) : []
  const looks = ofCharacter ? project.characters.find(card => card.id === target)?.visual?.looks ?? [] : []
  const sheets = useSheetsAsk()
  const create = (): Promise<unknown> => run(async () => {
    // Whose design sheet this picture would draw first is asked before anything is drawn.
    const asks: SheetsAsk[] = kind === 'portrait' || kind === 'cover' || kind === 'custom'
      ? [{ kind, ...(target.length > 0 ? { target } : {}), ...(kind === 'custom' && cast.length > 0 ? { characters: cast } : {}) }]
      : []
    await sheets.before(asks, draw)
  })
  /** The picture asked for in the form, as the call that draws it. */
  const asked = () => {
    const extra = splitAvoid(avoid)
    return {
      kind,
      ...(target.length > 0 ? { target } : {}),
      ...(prompt.trim().length > 0 ? { prompt: prompt.trim() } : {}),
      ...(ofCharacter && look.length > 0 ? { look } : {}),
      ...(kind === 'custom' && cast.length > 0 ? { characters: cast } : {}),
      ...(extra.length > 0 ? { avoid: extra } : {}),
    }
  }
  const draw = async (choice: SheetsChoice): Promise<void> => {
    setCreating(false)
    controller.toast('info', t('开始绘制…', 'Drawing…'))
    const job = await controller.run('image.create', { root, ...asked(), ...choice })
    if (sheetsDrawn(job, t).length > 0) controller.toast('info', `${t('画好了', 'The picture is ready')}${sheetsDrawn(job, t)}`)
    setPrompt('')
    setAvoid('')
    images.reload()
  }

  return (
    <div className="nv-gallery">
      <div className="nv-toolbar">
        <div className="nv-chips">
          <Chip active={filter === 'all'} tone={filter === 'all' ? 'blue' : 'neutral'} onClick={() => { setFilter('all') }}>{t('全部', 'All')}</Chip>
          {kinds.map(item => <Chip key={item} active={filter === item} tone={filter === item ? 'blue' : 'neutral'} onClick={() => { setFilter(item) }}>{t(...KIND[item])}</Chip>)}
        </div>
        <span className="nv-spacer" />
        {drawing > 0 ? <span className="nv-muted nv-small"><Spinner size={12} /> {t(`${drawing} 张绘制中`, `${drawing} in progress`)}</span> : null}
        {(images.data?.images ?? []).length > 0 ? <Button size="sm" variant={picking ? 'primary' : 'ghost'} icon="check" onClick={() => { setPicking(value => !value); setPicked(new Set()) }}>{picking ? t('完成', 'Done') : t('多选', 'Select')}</Button> : null}
        <Button size="sm" icon="layers" onClick={() => { setBatching(true) }} title={t('补齐还没有的图和声线', 'Make the pictures and voices still missing')}>{t('批量绘制…', 'Draw in a batch…')}</Button>
        <Button variant="primary" size="sm" icon="plus" onClick={() => { if (controller.need('image')) setCreating(true) }}>{t('画一张', 'New picture')}</Button>
      </div>
      {groups.length > 0 ? (
        <div className="nv-gallery-by">
          <div className="nv-chips">
            <span className="nv-muted nv-small">{t('按对象', 'Of')}</span>
            <Chip active={group === 'all'} tone={group === 'all' ? 'blue' : 'neutral'} onClick={() => { setGroup('all'); setSubject(undefined) }}>{t('全部', 'Anything')}</Chip>
            {groups.map(item => <Chip key={item.id} active={group === item.id} tone={group === item.id ? 'blue' : 'neutral'} onClick={() => { setGroup(item.id); setSubject(undefined) }}>{t(...item.label)}</Chip>)}
          </div>
          {members.length > 0 ? (
            <div className="nv-chips nv-gallery-members">
              {members.map(item => <Chip key={item.id} active={subject === item.id} tone={subject === item.id ? 'violet' : 'neutral'} onClick={() => { setSubject(previous => (previous === item.id ? undefined : item.id)) }}>{item.name}<span className="nv-gallery-count">{counted.get(item.id)}</span></Chip>)}
            </div>
          ) : null}
        </div>
      ) : null}
      {picking ? (
        <div className="nv-pick-bar">
          <span>{t(`已选 ${chosen.length} 张`, `${chosen.length} picked`)}</span>
          <button type="button" className="nv-link" onClick={() => { setPicked(new Set(list.map(image => image.id))) }}>{t(`全选（列表里的 ${list.length} 张）`, `All ${list.length} listed`)}</button>
          <button type="button" className="nv-link" onClick={() => { setPicked(new Set()) }}>{t('清空', 'None')}</button>
          <span className="nv-spacer" />
          <Button size="sm" variant="danger" icon="trash" busy={busy} disabled={chosen.length === 0} onClick={removePicked}>{t(`删除选中的 ${chosen.length} 张`, `Delete the ${chosen.length} picked`)}</Button>
        </div>
      ) : null}
      <NeedsSetup what="image" />
      <ArtDirection />
      {waiting.things.length > 0 ? (
        <details className="nv-waiting" open>
          <summary>{t(`待采纳的对比图 · ${waiting.count} 张（${waiting.things.length} 样）`, `To take · ${waiting.count} pictures of ${waiting.things.length}`)}</summary>
          <div className="nv-waiting-bar">
            {waiting.rounds.map(([round, of]) => (
              <span key={round} className="nv-row-wrap">
                <span className="nv-muted nv-small">{t(`这一批（${of.things.size} 样）都用`, `This round of ${of.things.size}, all by`)}</span>
                {[...of.labels].map(label => <Button key={label} size="sm" variant="outline" icon="check" busy={busy} onClick={() => takeRound(round, label)}>{label}</Button>)}
              </span>
            ))}
            <label className="nv-check nv-small">
              <input type="checkbox" checked={dropOthers} onChange={(event) => { setDropOthers(event.target.checked) }} />
              <span>{t('采纳时把别的服务画的删掉', 'When taken, delete what the other services drew')}</span>
            </label>
          </div>
          {waiting.things.map(pictures => (
            <div key={pictures[0]!.trial!.id} className="nv-waiting-row">
              <span className="nv-waiting-of"><Chip>{t(...KIND[pictures[0]!.kind])}</Chip>{nameOf(pictures[0]!) ?? ''}{pictures[0]!.moment?.title !== undefined ? ` · ${pictures[0]!.moment.title}` : ''}</span>
              {pictures.map(image => (
                <figure key={image.id} className="nv-waiting-cell">
                  <button type="button" className="nv-waiting-picture" onClick={() => { setOpen(image) }} title={t('点开看大图', 'Open it large')}><ProjectImage path={image.path} alt={image.trial!.label} /></button>
                  <figcaption>
                    <span className="nv-small">{image.trial!.label}</span>
                    <Button size="sm" variant="outline" icon="check" busy={busy} onClick={() => takeOne(image, pictures)}>{t('用这张', 'Take')}</Button>
                  </figcaption>
                </figure>
              ))}
            </div>
          ))}
        </details>
      ) : null}
      {images.data === undefined ? <div className="nv-center"><Spinner /></div> : list.length === 0 ? (
        <Empty icon="image" title={t('还没有图片', 'No pictures yet')}>{t('还没有图。先给主要人物画人设图、给常去的地点画设定图，之后的图以它们为参考。', 'No pictures yet. Start with design sheets for the main characters and art for the usual places; later pictures are drawn against them.')}</Empty>
      ) : (
        <div className="nv-gallery-grid">
          {list.map(image => (
            <button key={image.id} type="button" className={`nv-gallery-item${picking && picked.has(image.id) ? ' is-picked' : ''}`} aria-pressed={picking ? picked.has(image.id) : undefined} onClick={() => { if (picking) pick(image.id); else setOpen(image) }}>
              <ProjectImage path={image.path} alt={image.prompt} />
              {picking ? <span className={`nv-pick-mark nv-photo-pick${picked.has(image.id) ? ' is-on' : ''}`}><Icon name="check" size={11} /></span> : null}
              <span className="nv-gallery-caption"><Chip>{t(...KIND[image.kind])}</Chip>{nameOf(image) !== undefined ? <span>{nameOf(image)}</span> : null}</span>
            </button>
          ))}
        </div>
      )}

      {open !== undefined ? (
        <PictureViewer
          path={open.path}
          title={`${t(...KIND[open.kind])}${nameOf(open) !== undefined ? ` · ${nameOf(open)}` : ''}`}
          onClose={() => { setOpen(undefined) }}
          onChanged={() => { images.reload() }}
          // Of the picture looked at — which, once it was drawn again in the viewer, is the one that came of it.
          footer={(shown) => {
            const cover = shown?.path ?? open.path
            return (
              <>
                {project.cover === cover
                  ? <Chip tone="green">{t('这是封面', 'This is the cover')}</Chip>
                  : <Button icon="book" pending={t('正在设为封面…', 'Setting the cover…')} onClick={() => controller.guard(async () => { await controller.api.call('project.update', { root, patch: { cover } }); await controller.refreshProject(); controller.toast('success', t('已设为这本书的封面', 'This is the book\'s cover now')) })}>{t('设为封面', 'Make it the cover')}</Button>}
              </>
            )
          }}
        />
      ) : null}

      {creating ? (
        <Modal title={t('画一张', 'New picture')} onClose={() => { setCreating(false) }} footer={(
          <>
            <ManyModels label={t('多模型…', 'Several models…')} disabled={(kind === 'custom' && prompt.trim().length === 0) || ((ofCharacter || kind === 'location') && target.length === 0)} ask={() => ({ title: `${t('画一张', 'New picture')}${targets.find(item => item.value === target) !== undefined ? ` · ${targets.find(item => item.value === target)!.label}` : ''}`, method: 'image.create', params: asked() })} onChanged={() => { images.reload() }} />
            <Button variant="primary" busy={busy} disabled={(kind === 'custom' && prompt.trim().length === 0) || ((ofCharacter || kind === 'location') && target.length === 0)} onClick={create}>{t('绘制', 'Draw')}</Button>
          </>
        )}>
          <Field label={t('画什么', 'What')} hint={kind === 'sheet' ? t('正面、侧面、背面三视图，之后的图以它为参考。', 'Front, side and back on one sheet; later pictures are drawn against it.') : undefined}>
            <Select value={kind} options={[
              { value: 'cover', label: t('封面', 'Cover') },
              { value: 'sheet', label: t('人设图（三视图）', 'Character design sheet (three views)') },
              { value: 'portrait', label: t('人物立绘', 'Character portrait') },
              { value: 'location', label: t('场景设定图', 'Place art') },
              { value: 'custom', label: t('自由创作', 'Free prompt') },
            ]} onChange={(value) => { setKind(value); setTarget(''); setLook('') }} />
          </Field>
          {targets.length > 0 ? <Field label={ofCharacter ? t('人物', 'Character') : t('地点', 'Location')}><Select value={target} options={[{ value: '', label: t('请选择…', 'Choose…') }, ...targets]} onChange={(value) => { setTarget(value); setLook('') }} /></Field> : null}
          {looks.length > 0 ? (
            <Field label={t('造型', 'Look')} hint={t('造型在人物卡的"造型（服饰）"里添加', 'Looks are added on the character card under "Looks (outfits)"')}>
              <Select value={look} options={[{ value: '', label: t('主造型', 'Main look') }, ...looks.map(item => ({ value: item.id, label: item.name }))]} onChange={setLook} />
            </Field>
          ) : null}
          {kind === 'custom' && project.characters.length > 0 ? (
            <Field label={t('画面里有谁', 'Who is in it')} hint={t('他们的样子写进提示词，人设图作参考图', 'How they look goes into the prompt; their design sheets go along')}>
              <div className="nv-chips">
                {project.characters.map(card => (
                  <Chip key={card.id} active={cast.includes(card.id)} tone={cast.includes(card.id) ? 'blue' : 'neutral'} onClick={() => { setCast(previous => (previous.includes(card.id) ? previous.filter(id => id !== card.id) : [...previous, card.id])) }}>{card.name}</Chip>
                ))}
              </div>
            </Field>
          ) : null}
          <Field label={kind === 'custom' ? t('画面描述', 'Prompt') : t('额外要求', 'Anything more')} hint={t('本书的画风和"不要出现"会自动带上，见上方"画风"', 'The book\'s art direction and avoid list are applied automatically — see "Art direction" above')}>
            <TextArea value={prompt} minRows={3} onChange={(event) => { setPrompt(event.target.value) }} />
          </Field>
          <Field label={t('这一张另外不要出现', 'Also keep out of this one')} hint={t('逗号分隔，可留空', 'Comma-separated, optional')}>
            <TextInput value={avoid} onChange={(event) => { setAvoid(event.target.value) }} />
          </Field>
        </Modal>
      ) : null}
      {batching ? <ArtBatchDialog onClose={() => { setBatching(false); images.reload() }} /> : null}
      {confirm.element}
      {sheets.element}
    </div>
  )
}

/**
 * The words every picture of this book carries besides its subject: the art
 * direction and the list of things kept out. Shown where pictures are made, so
 * nothing reaches the image model that the author cannot read and change here.
 */
function ArtDirection() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const studio = useSnapshot(snapshot => snapshot.settings?.settings.image)
  const manifest = project.manifest
  const resolved = resolveArtStyle(manifest, studio?.stylePrompt)
  const bookAvoid = (manifest.artAvoid ?? []).join(t('、', ', '))
  const studioAvoid = splitAvoid(studio?.negativePrompt)
  const [style, setStyle] = useState(resolved.text)
  const [avoid, setAvoid] = useState(bookAvoid)
  const [expanded, setExpanded] = useState(false)
  const { busy, run } = useAction()
  const dirty = style.trim() !== resolved.text || splitAvoid(avoid).join('\n') !== (manifest.artAvoid ?? []).join('\n')
  useEffect(() => { setStyle(resolved.text) }, [resolved.text])
  useEffect(() => { setAvoid(bookAvoid) }, [bookAvoid])
  const save = (): Promise<unknown> => run(async () => {
    await controller.api.call('project.update', { root, patch: { artStyle: style.trim(), artAvoid: splitAvoid(avoid) } })
    await controller.refreshProject()
    controller.toast('success', t('已保存', 'Saved'))
  })
  const all = mergeAvoid(studioAvoid, manifest.artAvoid)
  return (
    <section className={`nv-art${expanded ? ' is-open' : ''}`}>
      <button type="button" className="nv-art-head" aria-expanded={expanded} onClick={() => { setExpanded(previous => !previous) }}>
        <strong>{t('画风', 'Art direction')}</strong>
        <Chip tone={resolved.source === 'book' ? 'green' : 'amber'}>{t(...SOURCE[resolved.source])}</Chip>
        <span className="nv-art-summary">{resolved.text}</span>
        {all.length > 0 ? <span className="nv-art-avoid">{t(`不画：${all.join('、')}`, `Never: ${all.join(', ')}`)}</span> : null}
        <span className="nv-art-toggle">{expanded ? t('收起', 'Close') : t('修改', 'Edit')}</span>
      </button>
      {expanded ? (
        <div className="nv-art-body">
          <Field
            label={t('这本书的画风', 'This book\'s art direction')}
            hint={resolved.source === 'book'
              ? t('接在每张图的提示词后面。', 'Appended to every picture\'s prompt.')
              : resolved.source === 'studio'
                ? t('这是以前工坊设置里的全局画风，保存后归这本书。', 'This is the old global art direction; saved, it becomes this book\'s own.')
                : t('这是内置的起点，保存后归这本书。', 'This is the built-in start; saved, it becomes this book\'s own.')}
          >
            <TextArea value={style} minRows={2} onChange={(event) => { setStyle(event.target.value) }} />
          </Field>
          <Field
            label={t('画面里不要出现', 'Never in the picture')}
            hint={t('逗号分隔，作为负面提示词随每张图发送。', 'Comma-separated; sent with every picture as its negative prompt.')}
          >
            <TextInput value={avoid} placeholder={t('如：十字架、哥特式教堂、现代服饰', 'e.g. crosses, gothic cathedral, modern clothing')} onChange={(event) => { setAvoid(event.target.value) }} />
          </Field>
          {studioAvoid.length > 0 ? <p className="nv-muted nv-small">{t(`工坊设置里对所有书另有：${studioAvoid.join('、')}`, `The Studio settings add for every book: ${studioAvoid.join(', ')}`)}</p> : null}
          <div className="nv-row-wrap">
            <Button variant="primary" size="sm" busy={busy} disabled={!dirty && resolved.source === 'book'} onClick={save}>{resolved.source === 'book' ? t('保存', 'Save') : t('定为本书画风', 'Make it this book\'s')}</Button>
            
          </div>
        </div>
      ) : null}
    </section>
  )
}

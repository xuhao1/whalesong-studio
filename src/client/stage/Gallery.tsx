// SPDX-License-Identifier: LGPL-3.0-or-later
/** Every picture made for the book, and a place to make more. */
import { useEffect, useState } from 'react'
import { mergeAvoid, resolveArtStyle, splitAvoid, type ArtSource } from '../../shared/art'
import type { IllustrationInfo, SheetsAsk } from '../../shared/types'
import { PICTURE_KIND as KIND, PictureViewer } from '../PictureRecord'
import {
  Button, Chip, Empty, Field, Modal, ProjectImage, Select, Spinner, TextArea, TextInput, useAction, useConfirm, useLoad, useProject, useSnapshot, useStudio, useT,
} from '../ui'
import { ArtBatchDialog, batchOf } from '../Batch'
import { sheetsDrawn } from '../labels'
import { useSheetsAsk, type SheetsChoice } from '../SheetsAsk'
import { NeedsSetup } from '../views/Settings'

type CreateKind = 'cover' | 'sheet' | 'portrait' | 'location' | 'custom'

const SOURCE: Record<ArtSource, [string, string]> = {
  book: ['本书设定', 'Set for this book'],
  studio: ['来自工坊设置', 'From the Studio settings'],
  default: ['内置默认', 'Built-in default'],
}

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
  const list = (images.data?.images ?? []).filter(image => filter === 'all' || image.kind === filter)
  const kinds = [...new Set((images.data?.images ?? []).map(image => image.kind))]
  const nameOf = (image: IllustrationInfo): string | undefined => {
    if (image.target === undefined) return undefined
    return project.characters.find(card => card.id === image.target)?.name
      ?? project.world.find(entry => entry.id === image.target)?.name
      ?? project.chapters.find(chapter => chapter.id === image.target)?.title
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
  const draw = async (choice: SheetsChoice): Promise<void> => {
    setCreating(false)
    controller.toast('info', t('开始绘制…', 'Drawing…'))
    const extra = splitAvoid(avoid)
    const job = await controller.run('image.create', {
      root,
      kind,
      ...(target.length > 0 ? { target } : {}),
      ...(prompt.trim().length > 0 ? { prompt: prompt.trim() } : {}),
      ...(ofCharacter && look.length > 0 ? { look } : {}),
      ...(kind === 'custom' && cast.length > 0 ? { characters: cast } : {}),
      ...(extra.length > 0 ? { avoid: extra } : {}),
      ...choice,
    })
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
        <Button size="sm" icon="layers" onClick={() => { setBatching(true) }} title={t('补齐还没有的图和声线', 'Make the pictures and voices still missing')}>{t('批量绘制…', 'Draw in a batch…')}</Button>
        <Button variant="primary" size="sm" icon="plus" onClick={() => { if (controller.need('image')) setCreating(true) }}>{t('画一张', 'New picture')}</Button>
      </div>
      <NeedsSetup what="image" />
      <ArtDirection />
      {images.data === undefined ? <div className="nv-center"><Spinner /></div> : list.length === 0 ? (
        <Empty icon="image" title={t('还没有图片', 'No pictures yet')}>{t('还没有图。先给主要人物画人设图、给常去的地点画设定图，之后的图以它们为参考。', 'No pictures yet. Start with design sheets for the main characters and art for the usual places; later pictures are drawn against them.')}</Empty>
      ) : (
        <div className="nv-gallery-grid">
          {list.map(image => (
            <button key={image.id} type="button" className="nv-gallery-item" onClick={() => { setOpen(image) }}>
              <ProjectImage path={image.path} alt={image.prompt} />
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
        <Modal title={t('画一张', 'New picture')} onClose={() => { setCreating(false) }} footer={<Button variant="primary" busy={busy} disabled={(kind === 'custom' && prompt.trim().length === 0) || ((ofCharacter || kind === 'location') && target.length === 0)} onClick={create}>{t('绘制', 'Draw')}</Button>}>
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

// SPDX-License-Identifier: LGPL-3.0-or-later
/** Every picture made for the book, and a place to make more. */
import { useEffect, useState } from 'react'
import { mergeAvoid, resolveArtStyle, splitAvoid, type ArtSource } from '../../shared/art'
import type { IllustrationInfo } from '../../shared/types'
import {
  Button, Chip, Empty, Field, Modal, ProjectImage, Select, Spinner, TextArea, TextInput, useAction, useConfirm, useLoad, useProject, useSnapshot, useStudio, useT,
} from '../ui'
import { ArtBatchDialog, batchOf } from '../Batch'
import { sheetsDrawn } from '../labels'
import { NeedsSetup } from '../views/Settings'

const KIND: Record<IllustrationInfo['kind'], [string, string]> = {
  portrait: ['立绘', 'Portrait'],
  sheet: ['人设图', 'Design sheet'],
  scene: ['场景插图', 'Scene'],
  location: ['场景设定图', 'Place art'],
  item: ['物品设定图', 'Object art'],
  cover: ['封面', 'Cover'],
  panel: ['分镜', 'Panel'],
  background: ['幕间背景', 'Background'],
  sprite: ['表情差分', 'Sprite'],
}

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
  const create = (): Promise<unknown> => run(async () => {
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
    })
    if (sheetsDrawn(job, t).length > 0) controller.toast('info', `${t('画好了', 'The picture is ready')}${sheetsDrawn(job, t)}`)
    setPrompt('')
    setAvoid('')
    images.reload()
  })

  return (
    <div className="nv-gallery">
      <div className="nv-toolbar">
        <div className="nv-chips">
          <Chip active={filter === 'all'} tone={filter === 'all' ? 'blue' : 'neutral'} onClick={() => { setFilter('all') }}>{t('全部', 'All')}</Chip>
          {kinds.map(item => <Chip key={item} active={filter === item} tone={filter === item ? 'blue' : 'neutral'} onClick={() => { setFilter(item) }}>{t(...KIND[item])}</Chip>)}
        </div>
        <span className="nv-spacer" />
        {drawing > 0 ? <span className="nv-muted nv-small"><Spinner size={12} /> {t(`${drawing} 张绘制中`, `${drawing} in progress`)}</span> : null}
        <Button size="sm" icon="layers" onClick={() => { setBatching(true) }} title={t('一次补齐：人设图、立绘、场景设定图、章节插图、封面、专属声线——只做还没有的', 'Everything that is missing, in one go: design sheets, portraits, place art, chapter illustrations, a cover, voices')}>{t('批量绘制…', 'Draw in a batch…')}</Button>
        <Button variant="primary" size="sm" icon="plus" onClick={() => { if (controller.need('image')) setCreating(true) }}>{t('画一张', 'New picture')}</Button>
      </div>
      <NeedsSetup what="image" />
      <ArtDirection />
      {images.data === undefined ? <div className="nv-center"><Spinner /></div> : list.length === 0 ? (
        <Empty icon="image" title={t('还没有图片', 'No pictures yet')}>{t('建议的顺序：先给主要人物各画一张人设图（三视图），给常去的地点画场景设定图——之后的插图、分镜都会拿它们当参考图，人和地方才不会每张都变样。在写作或阅读视图里选中一段文字点"配图"，图片会插入到正文里。先在设置里配置图像服务。', 'A good order: draw a design sheet (three views) for each main character and place art for the places the story returns to — later pictures and panels use them as reference images, so people and places stop changing from one picture to the next. Select a passage in Write or Read and choose Illustrate to embed a picture in the text. Configure an image provider in Settings first.')}</Empty>
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
        <Modal wide title={`${t(...KIND[open.kind])}${nameOf(open) !== undefined ? ` · ${nameOf(open)}` : ''}`} onClose={() => { setOpen(undefined) }} footer={(
          <>
            <a className="nv-link" href={controller.api.media(project.manifest.id, open.path, { download: true })}>{t('下载', 'Download')}</a>
            <span className="nv-muted nv-small">{open.path}</span>
            <span className="nv-spacer" />
            {project.cover === open.path
              ? <Chip tone="green">{t('这是封面', 'This is the cover')}</Chip>
              : <Button icon="book" pending={t('正在设为封面…', 'Setting the cover…')} onClick={() => controller.guard(async () => { await controller.api.call('project.update', { root, patch: { cover: open.path } }); await controller.refreshProject(); controller.toast('success', t('已设为这本书的封面', 'This is the book\'s cover now')) })}>{t('设为封面', 'Make it the cover')}</Button>}
            <Button variant="ghost" icon="trash" onClick={() => {
              confirm.ask(t('删除这张图片？它是谁的立绘、人设图、设定图或"这时的样子"，会一并从那里取下；正文里插着它的地方不会自动移除。', 'Delete this picture? Where it is somebody\'s portrait or design sheet, a place\'s art or the picture of a turn of its course, it is taken off there too; where the text shows it, the text is not changed.'), () => {
                void run(async () => {
                  const done = await controller.api.call('image.delete', { root, id: open.id })
                  setOpen(undefined)
                  images.reload()
                  const released = done.released ?? []
                  if (released.length > 0) {
                    await controller.refreshProject()
                    controller.toast('info', t(`已删除。它原来是 ${released.join('、')} 的图，已从那里取下。`, `Deleted. It was the picture of ${released.join(', ')}: taken off there.`))
                  }
                })
              })
            }}>{t('删除', 'Delete')}</Button>
          </>
        )}>
          <ProjectImage className="nv-gallery-full" path={open.path} alt={open.prompt} />
          {open.parts !== undefined ? (
            <dl className="nv-parts">
              <dt>{t('画面内容', 'Subject')}</dt>
              <dd>{open.parts.subject}</dd>
              {open.parts.style !== undefined ? (
                <>
                  <dt>{t('画风', 'Art direction')}{open.parts.styleSource !== undefined ? <Chip tone={open.parts.styleSource === 'book' ? 'green' : 'amber'}>{t(...SOURCE[open.parts.styleSource])}</Chip> : null}</dt>
                  <dd>{open.parts.style}</dd>
                </>
              ) : null}
              {open.parts.avoid !== undefined && open.parts.avoid.length > 0 ? (
                <>
                  <dt>{t('不要出现', 'Kept out')}</dt>
                  <dd>{open.parts.avoid.join(t('、', ', '))}</dd>
                </>
              ) : null}
              {open.parts.references !== undefined && open.parts.references.length > 0 ? (
                <>
                  <dt>{t('参考图', 'Reference images')}</dt>
                  <dd className="nv-parts-refs">
                    {open.parts.references.map(reference => (
                      <figure key={reference.path}>
                        <ProjectImage path={reference.path} alt={reference.label} />
                        <figcaption>{reference.label}</figcaption>
                      </figure>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <details className="nv-parts-raw">
            <summary>{t('发给绘图模型的完整提示词', 'The full prompt as sent to the image model')}</summary>
            <p className="nv-muted nv-small">{open.prompt}</p>
          </details>
          <p className="nv-muted nv-small">{open.model} · {new Date(open.createdAt).toLocaleString()}</p>
        </Modal>
      ) : null}

      {creating ? (
        <Modal title={t('画一张', 'New picture')} onClose={() => { setCreating(false) }} footer={<Button variant="primary" busy={busy} disabled={(kind === 'custom' && prompt.trim().length === 0) || ((ofCharacter || kind === 'location') && target.length === 0)} onClick={create}>{t('绘制', 'Draw')}</Button>}>
          <Field label={t('画什么', 'What')} hint={kind === 'sheet' ? t('同一个人的正面、侧面、背面画在一张图上。之后有此人的图都以它为参考，所以先画它。', 'Front, side and back of one person on a single sheet. Later pictures of them are drawn against it, so make it first.') : undefined}>
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
            <Field label={t('画面里有谁', 'Who is in it')} hint={t('选中的人物会带上各自的视觉锚点和人设图', 'The chosen characters bring their visual anchors and design sheets')}>
              <div className="nv-chips">
                {project.characters.map(card => (
                  <Chip key={card.id} active={cast.includes(card.id)} tone={cast.includes(card.id) ? 'blue' : 'neutral'} onClick={() => { setCast(previous => (previous.includes(card.id) ? previous.filter(id => id !== card.id) : [...previous, card.id])) }}>{card.name}</Chip>
                ))}
              </div>
            </Field>
          ) : null}
          <Field label={kind === 'custom' ? t('画面描述', 'Prompt') : t('额外要求（可留空）', 'Extra direction (optional)')} hint={t('本书的画风和"不要出现"会自动带上，见上方"画风"', 'The book\'s art direction and avoid list are applied automatically — see "Art direction" above')}>
            <TextArea value={prompt} minRows={3} onChange={(event) => { setPrompt(event.target.value) }} />
          </Field>
          <Field label={t('这一张另外不要出现', 'Also keep out of this one')} hint={t('逗号分隔，可留空', 'Comma-separated, optional')}>
            <TextInput value={avoid} onChange={(event) => { setAvoid(event.target.value) }} />
          </Field>
        </Modal>
      ) : null}
      {batching ? <ArtBatchDialog onClose={() => { setBatching(false); images.reload() }} /> : null}
      {confirm.element}
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
    controller.toast('success', t('已保存到本书（novel.json）', 'Saved to this book (novel.json)'))
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
              ? t('写在本书的 novel.json 里，原样接在每张图的画面内容后面。', 'Stored in this book\'s novel.json and appended as is to the subject of every picture.')
              : resolved.source === 'studio'
                ? t('现在用的是以前填在工坊设置里的全局画风（画风现在属于每一本书，见“设定 → 画风”）。画第一张图时会把它写进本书的 novel.json，之后这本书就以自己这份为准；也可以现在就改好保存。', 'This is the Studio-wide art direction from Settings. The first picture writes it into this book\'s novel.json, and from then on the book keeps its own; or edit and save it now.')
                : t('你还没有给这本书定画风，现在显示的是内置的起点。画第一张图时会把它写进本书的 novel.json；最好现在就改成你要的样子再保存。', 'This book has no art direction of its own yet; what you see is the built-in starting point. The first picture writes it into novel.json — better to make it yours now and save.')}
          >
            <TextArea value={style} minRows={2} onChange={(event) => { setStyle(event.target.value) }} />
          </Field>
          <Field
            label={t('画面里不要出现', 'Never in the picture')}
            hint={t('逗号分隔。作为负面提示词随本书每一张图发送，并告诉写画面描述的模型绕开它们——比如书里的"教会"并不是现实里的教堂，就写上：十字架、哥特式教堂、彩绘玻璃。', 'Comma-separated. Sent as the negative prompt with every picture of this book, and given to the model that writes picture descriptions — if the "church" of your story is nothing like a real one, list: crosses, gothic cathedral, stained glass.')}
          >
            <TextInput value={avoid} placeholder={t('如：十字架、哥特式教堂、现代服饰', 'e.g. crosses, gothic cathedral, modern clothing')} onChange={(event) => { setAvoid(event.target.value) }} />
          </Field>
          {studioAvoid.length > 0 ? <p className="nv-muted nv-small">{t(`工坊设置里对所有书另有：${studioAvoid.join('、')}`, `The Studio settings add for every book: ${studioAvoid.join(', ')}`)}</p> : null}
          <div className="nv-row-wrap">
            <Button variant="primary" size="sm" busy={busy} disabled={!dirty && resolved.source === 'book'} onClick={save}>{resolved.source === 'book' ? t('保存', 'Save') : t('定为本书画风', 'Make it this book\'s')}</Button>
            <span className="nv-muted nv-small">{t('人物各自的"视觉锚点"和人设图在人物卡上；地点的样子在世界设定上。', 'Each character\'s visual anchor and design sheet live on their card; a place\'s look lives on its world entry.')}</span>
          </div>
        </div>
      ) : null}
    </section>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What a picture of the book is for, said by its author — of any picture.
 *
 * A picture drawn as one thing may be the right picture of another: a scene
 * that is the best likeness there is of somebody, a photograph brought into
 * the gallery that is the design art of a place. Where a picture is opened
 * large, its author says whose it is and as what — somebody's portrait or
 * design sheet, the design art of a place, a house or a thing, a picture of a
 * chapter's, nobody's — and whether it is the book's cover. It is taken down
 * from where it hung and hangs where it is said to belong.
 *
 * This is the author's to do, here: the showrunner has no tool for it.
 */
import { useMemo, useState } from 'react'
import { scenesOf } from '../shared/art'
import { hungAt, type Hung } from '../shared/hung'
import type { IllustrationInfo } from '../shared/types'
import { groupOf } from '../shared/world'
import { PICTURE_KIND } from './PictureRecord'
import { Button, Field, Modal, ProjectImage, Select, useAction, useProject, useStudio, useT } from './ui'

type UseAs = 'portrait' | 'sheet' | 'art' | 'chapter' | 'gallery'

/** Whose a picture is held up as, in a few words. */
export function hungWords(hung: Hung, t: (zh: string, en: string) => string): string {
  if (hung.as === 'portrait') {
    if (hung.stage !== undefined) return t(`${hung.name}「${hung.stage.title}」时期的立绘`, `${hung.name}'s portrait of "${hung.stage.title}"`)
    return hung.scene !== undefined ? t(`${hung.name} 的立绘 ·「${hung.scene.title}」`, `${hung.name}'s portrait · "${hung.scene.title}"`) : t(`${hung.name} 的立绘`, `${hung.name}'s portrait`)
  }
  if (hung.as === 'sheet') {
    if (hung.look !== undefined) return t(`${hung.name} 造型「${hung.look.name}」的人设图`, `${hung.name}'s sheet of the look "${hung.look.name}"`)
    if (hung.stage !== undefined) return t(`${hung.name}「${hung.stage.title}」时期的人设图`, `${hung.name}'s sheet of "${hung.stage.title}"`)
    return hung.use === 'main' ? t(`${hung.name} 的主人设图`, `${hung.name}'s main design sheet`) : t(`${hung.name} 的人设图（未启用）`, `${hung.name}'s design sheet (not in use)`)
  }
  if (hung.turn === true) return t(`${hung.name} 轨迹里一件事的图`, `${hung.name} at a turn of its course`)
  return hung.main ? t(`${hung.name} 的主设定图`, `${hung.name}'s main design picture`) : t(`${hung.name} 的设定图（未启用）`, `${hung.name}'s design picture (not in use)`)
}

/**
 * @param image - the picture's record, where it has one.
 * @param natural - its size in pixels as it loaded: a sheet taller than it is wide is taken for the front view alone.
 * @param onDone - what it is for was changed.
 */
export function PictureUse({ path, image, natural, onClose, onDone }: { path: string; image?: IllustrationInfo | undefined; natural?: { width: number; height: number } | undefined; onClose: () => void; onDone?: (() => void) | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const hung = useMemo(() => hungAt(project.characters, project.world, path, image), [project.characters, project.world, path, image])
  // Every chapter, on whichever line of the plot: another line's own are named with their line.
  const chapters = useMemo(() => [...project.chapters, ...(project.lines ?? []).flatMap((line) => {
    const title = (project.outline.lines ?? []).find(candidate => candidate.id === line.id)?.title
    return line.chapters.filter(candidate => !project.chapters.some(main => main.id === candidate.id)).map(candidate => ({ ...candidate, title: title !== undefined ? `${title} · ${candidate.title}` : candidate.title }))
  })], [project.chapters, project.lines, project.outline.lines])
  // What it is now, as one of the choices here: where it hangs — or, hanging nowhere, what its record files it as.
  // (A stretch's picture, a look's sheet, the picture of a turn are none of these: they are given where those are kept.)
  const now = useMemo((): { as: UseAs | ''; whose: string; scene: string; front?: boolean } => {
    const first = hung[0]
    if (first?.as === 'portrait' && first.stage === undefined) return { as: 'portrait', whose: first.id, scene: first.scene?.id ?? '' }
    if (first?.as === 'sheet' && (first.use === 'main' || first.use === 'spare')) return { as: 'sheet', whose: first.id, scene: '', front: first.front }
    if (first?.as === 'art' && first.turn !== true) return { as: 'art', whose: first.id, scene: '' }
    if (first === undefined && image?.kind === 'scene') return image.target !== undefined && chapters.some(chapter => chapter.id === image.target) ? { as: 'chapter', whose: image.target, scene: '' } : { as: 'gallery', whose: '', scene: '' }
    return { as: '', whose: '', scene: '' }
  }, [hung, image, chapters])
  const [as, setAs] = useState<UseAs | ''>(now.as)
  const [whose, setWhose] = useState(now.whose)
  const [scene, setScene] = useState(now.scene)
  const tall = natural !== undefined ? natural.width <= natural.height * 1.15 : false
  const [front, setFront] = useState(now.front ?? tall)
  const isCover = project.cover === path
  // The cover for want of a chosen one — the latest drawn as a cover — is not one that can be unchosen here.
  const fallen = isCover && project.manifest.cover !== path
  const [cover, setCover] = useState(isCover)
  const { busy, run } = useAction()

  const owners = as === 'portrait' || as === 'sheet' ? project.characters.map(card => ({ value: card.id, label: card.name }))
    : as === 'art' ? project.world.filter(entry => groupOf(entry.category) !== 'ideas').map(entry => ({ value: entry.id, label: entry.name }))
      : as === 'chapter' ? chapters.map(chapter => ({ value: chapter.id, label: `${chapter.index}. ${chapter.title}` })) : []
  const card = as === 'portrait' ? project.characters.find(candidate => candidate.id === whose) : undefined
  const moments = card !== undefined ? scenesOf(card) : []
  // Said the same as it is now, and hanging at that one place: nothing to do.
  const same = as === now.as && whose === now.whose && scene === now.scene && (as !== 'sheet' || front === now.front) && hung.length <= 1
  const wanted: UseAs | undefined = as !== '' && !same && (as === 'gallery' || whose.length > 0) ? as : undefined
  const ready = wanted !== undefined
  const filed = hung.length > 0 ? hung.map(item => hungWords(item, t)).join(t('；', '; '))
    : image === undefined ? t('没有留下记录的一张图', 'a picture without a record')
      : image.kind === 'scene' && now.as === 'chapter' ? t(`「${chapters.find(chapter => chapter.id === image.target)?.title ?? ''}」的图`, `a picture of "${chapters.find(chapter => chapter.id === image.target)?.title ?? ''}"`)
        : image.kind === 'scene' ? t('图库里的图，不挂在谁名下', 'a picture of the gallery, nobody\'s')
          // Drawn as a cover: the cover it is said to be below, where it is; else one that was drawn as one.
          : image.kind === 'cover' ? (isCover ? '' : t('画作封面的一张，现在不是封面', 'drawn as a cover, not the cover now'))
            : t(`${t(...PICTURE_KIND[image.kind])}，没挂在谁名下`, `${t(...PICTURE_KIND[image.kind])}, hanging nowhere`)
  const nowWords = [filed, isCover ? t('这本书的封面', 'the book\'s cover') : ''].filter(words => words.length > 0).join(t('；', '; '))

  const apply = (): Promise<unknown> => run(async () => {
    const said: string[] = []
    if (wanted !== undefined) {
      const done = await controller.api.call('image.use', {
        root,
        picture: path,
        as: wanted,
        ...(as !== 'gallery' ? { target: whose } : {}),
        ...(as === 'portrait' && scene.length > 0 ? { scene } : {}),
        ...(as === 'sheet' ? { front } : {}),
      })
      const name = owners.find(owner => owner.value === whose)?.label ?? ''
      const moment = moments.find(item => item.id === scene)?.title
      said.push(as === 'portrait' ? t(`现在是 ${name} 的立绘${moment !== undefined ? ` ·「${moment}」` : ''}`, `It is ${name}'s portrait now${moment !== undefined ? ` · "${moment}"` : ''}`)
        : as === 'sheet' ? (done.spare === true
            ? t(`现在是 ${name} 的人设图，先不启用：主人设图是你选定的那张`, `It is one of ${name}'s design sheets now, not in use: the main sheet is the one you chose`)
            : t(`现在是 ${name} 的人设图`, `It is ${name}'s design sheet now`))
          : as === 'art' ? (done.spare === true
              ? t(`现在是 ${name} 的设定图，先不启用：主设定图是你选定的那张`, `It is one of ${name}'s design pictures now, not in use: the main one is the one you chose`)
              : t(`现在是 ${name} 的设定图`, `It is ${name}'s design art now`))
            : as === 'chapter' ? t(`归到这一章的图里了：${name}`, `Filed with the pictures of ${name}`)
              : t('只留在图库里，不挂在谁名下', 'It is a picture of the gallery now, nobody\'s'))
      if (done.released.length > 0) said.push(t(`原来挂在 ${[...new Set(done.released)].join('、')} 那里，已取下`, `taken down from ${[...new Set(done.released)].join(', ')}`))
    }
    if (cover !== isCover) {
      await controller.api.call('project.update', { root, patch: { cover: cover ? path : '' } })
      said.push(cover ? t('封面换成了它', 'it is the book\'s cover') : t('不再是封面', 'it is the cover no more'))
    }
    await controller.refreshProject()
    if (said.length > 0) controller.toast('success', said.join(t('；', '; ')))
    onDone?.()
    onClose()
  })

  return (
    <Modal title={t('这张图用作', 'What this picture is for')} onClose={onClose} footer={(
      <>
        <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" icon="check" busy={busy} disabled={!ready && cover === isCover} onClick={apply}>{t('就这么用', 'Use it so')}</Button>
      </>
    )}>
      <div className="nv-place-head">
        <ProjectImage className="nv-place-thumb" path={path} />
        <span className="nv-small"><span className="nv-muted">{t('现在：', 'Now: ')}</span>{nowWords}</span>
      </div>
      <Field label={t('用作', 'Use it as')}>
        <Select<UseAs | ''> value={as} options={[
          ...(as === '' ? [{ value: '' as const, label: t('请选择…', 'Choose…') }] : []),
          { value: 'portrait', label: t('人物的立绘', 'Somebody\'s portrait') },
          { value: 'sheet', label: t('人物的人设图', 'Somebody\'s design sheet') },
          { value: 'art', label: t('地点 / 家族与组织 / 物品的设定图', 'Design art of a place, a house or a thing') },
          { value: 'chapter', label: t('某一章的图', 'A picture of a chapter') },
          { value: 'gallery', label: t('图库里的图（不挂在谁名下）', 'A picture of the gallery (nobody\'s)') },
        ]} onChange={(value) => { setAs(value); setWhose(value === now.as ? now.whose : ''); setScene(value === now.as ? now.scene : '') }} />
      </Field>
      {as !== '' && as !== 'gallery' ? (
        <Field label={as === 'chapter' ? t('哪一章', 'Which chapter') : as === 'art' ? t('谁的', 'Whose') : t('人物', 'Character')}>
          <Select value={whose} options={[{ value: '', label: t('请选择…', 'Choose…') }, ...owners]} onChange={(value) => { setWhose(value); setScene(value === now.whose && as === now.as ? now.scene : '') }} />
        </Field>
      ) : null}
      {as === 'portrait' && moments.length > 0 ? (
        <Field label={t('哪一幕', 'Which moment')}>
          <Select value={scene} options={[{ value: '', label: t('不属于哪一幕', 'None of their moments') }, ...moments.map(item => ({ value: item.id, label: item.title }))]} onChange={setScene} />
        </Field>
      ) : null}
      {as === 'sheet' ? (
        <Field label={t('这张是', 'It shows')}>
          <Select<'views' | 'front'> value={front ? 'front' : 'views'} options={[{ value: 'views', label: t('三视图', 'Three views') }, { value: 'front', label: t('只有正面', 'The front alone') }]} onChange={(value) => { setFront(value === 'front') }} />
        </Field>
      ) : null}
      <label className="nv-check">
        <input type="checkbox" checked={cover} disabled={fallen} onChange={(event) => { setCover(event.target.checked) }} />
        <span>{t('作这本书的封面', 'It is the book\'s cover')}</span>
      </label>
      {fallen ? <p className="nv-muted nv-small">{t('它是最近画的一张封面，所以现在是封面；换封面，在另一张图上勾选。', 'It is the cover for being the latest one drawn as a cover; to change the cover, tick this on another picture.')}</p> : null}
      {ready && hung.length > 0 ? <p className="nv-muted nv-small">{t(`会从原来挂着的地方取下（${hung.map(item => hungWords(item, t)).join('；')}）。正文、分镜里用着它的地方不动。`, `It is taken down from where it hangs (${hung.map(item => hungWords(item, t)).join('; ')}). Where the text or a storyboard shows it, it stays.`)}</p> : null}
    </Modal>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture the book has, put into a chapter's text — from either end.
 *
 * From the picture: any picture shown large can be placed in a chapter, after
 * the paragraph its author points at ({@link PlacePicture}). From the text:
 * where a passage is selected on the writing page, a picture is chosen out of
 * everything the book has drawn — a portrait, a scene, a panel of a motion
 * comic alike — and goes in after that passage ({@link PickPicture}). Neither
 * draws anything: the pictures are there already.
 */
import { useMemo, useState } from 'react'
import type { IllustrationInfo } from '../shared/types'
import { ImportPicture, type BroughtKind, type BroughtOf } from './ImportPicture'
import { PICTURE_KIND } from './PictureRecord'
import { Button, Chip, cx, Modal, ProjectImage, Select, Spinner, useAction, useLoad, useProject, useStudio, useT } from './ui'

/** The paragraphs of a chapter's text as the Host counts them: runs of lines parted by blank ones. */
const paragraphsOf = (text: string): string[] => text.split(/\n{2,}/).filter(part => part.trim().length > 0)

/** A paragraph in a line: its first words, or — for a picture already in the text — that it is one. */
const brief = (paragraph: string): { text: string; picture: boolean } => {
  const picture = /^!\[[^\]]*\]\([^)]+\)\s*$/.test(paragraph.trim())
  const flat = paragraph.replace(/\s+/g, ' ').trim()
  return { picture, text: picture ? '' : flat.length > 64 ? `${[...flat].slice(0, 64).join('')}…` : flat }
}

/**
 * Where in the book a picture is to go: which chapter, after which paragraph.
 * @param chapter - the chapter to start on (the one the picture was drawn for, where it has one).
 */
export function PlacePicture({ image, path, chapter, onClose }: { image?: IllustrationInfo | undefined; path: string; chapter?: string | undefined; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  // Every chapter that has text, on whichever line of the plot: another line's own are named with their line.
  const chapters = useMemo(() => [...project.chapters, ...(project.lines ?? []).flatMap((line) => {
    const title = (project.outline.lines ?? []).find(candidate => candidate.id === line.id)?.title
    return line.chapters.filter(candidate => !project.chapters.some(main => main.id === candidate.id)).map(candidate => ({ ...candidate, title: title !== undefined ? `${title} · ${candidate.title}` : candidate.title }))
  })].filter(candidate => candidate.hasText), [project.chapters, project.lines, project.outline.lines])
  const [chosen, setChosen] = useState(() => (chapters.some(candidate => candidate.id === chapter) ? chapter! : chapters[0]?.id ?? ''))
  const text = useLoad(async signal => (chosen.length > 0 ? (await controller.api.call('chapter.read', { root, id: chosen }, signal)).text : ''), [root, chosen, project.revision])
  const paragraphs = useMemo(() => paragraphsOf(text.data ?? ''), [text.data])
  const [after, setAfter] = useState<number | undefined>()
  const { busy, run } = useAction()
  const already = (text.data ?? '').includes(`](${path})`)
  const place = (): Promise<unknown> => run(async () => {
    if (after === undefined) return
    await controller.api.call('image.place', { root, picture: path, chapter: chosen, after, ...(image !== undefined ? { alt: [...image.prompt.replace(/\s+/g, ' ')].slice(0, 40).join('') } : {}) })
    await controller.refreshProject()
    const title = chapters.find(candidate => candidate.id === chosen)?.title ?? ''
    controller.toast('success', after === 0 ? t(`已插到「${title}」最前面`, `Placed at the top of "${title}"`) : t(`已插到「${title}」第 ${after} 段之后`, `Placed after paragraph ${after} of "${title}"`))
    onClose()
  })
  return (
    <Modal title={t('插入正文', 'Place in the text')} onClose={onClose} footer={(
      <>
        <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" icon="image" busy={busy} disabled={after === undefined} pending={t('正在插入…', 'Placing…')} onClick={place}>{after === undefined ? t('点一段', 'Pick a paragraph') : after === 0 ? t('插在最前面', 'Place at the top') : t(`插在第 ${after} 段之后`, `Place after paragraph ${after}`)}</Button>
      </>
    )}>
      {chapters.length === 0 ? <p className="nv-muted">{t('还没有写了正文的章节。', 'No chapter has text yet.')}</p> : (
        <div className="nv-place">
          <div className="nv-place-head">
            <ProjectImage className="nv-place-thumb" path={path} />
            <Select value={chosen} options={chapters.map(candidate => ({ value: candidate.id, label: `${candidate.index}. ${candidate.title}` }))} onChange={(next) => { setChosen(next); setAfter(undefined) }} />
            {already ? <Chip tone="amber">{t('这一章里已经有它', 'Already in this chapter')}</Chip> : null}
          </div>
          {text.data === undefined ? <div className="nv-center"><Spinner /></div> : (
            <ol className="nv-place-list">
              <li><button type="button" className={cx('nv-place-gap', after === 0 && 'is-chosen')} onClick={() => { setAfter(0) }}>{t('最前面', 'At the top')}</button></li>
              {paragraphs.map((paragraph, index) => {
                const line = brief(paragraph)
                return (
                  <li key={index}>
                    <button type="button" className={cx('nv-place-row', after === index + 1 && 'is-chosen')} onClick={() => { setAfter(index + 1) }} title={t('插在这一段之后', 'Place after this paragraph')}>
                      <span className="nv-place-index">{index + 1}</span>
                      {line.picture ? <Chip>{t('一张图', 'a picture')}</Chip> : <span className="nv-place-text">{line.text}</span>}
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </Modal>
  )
}

/**
 * A picture chosen out of everything the book has drawn — or brought in from the author's computer, right there.
 * @param chapter - pictures of this chapter (its scenes, its panels) are listed first.
 * @param bring - what one brought in from the computer comes in as, and whose: left out, a picture of the chapter's (or
 *   nobody's). Said where the picture is chosen for a place of its own — somebody's sheet, an entry's design art — so
 *   that the one brought in hangs there as it comes in.
 * @param onPick - the picture chosen; `brought` where it was brought in just now (and hangs where `bring` says already).
 */
export function PickPicture({ chapter, bring, title, onPick, onClose }: { chapter?: string | undefined; bring?: { kind: BroughtKind; of?: BroughtOf } | undefined; title?: string | undefined; onPick: (image: IllustrationInfo, brought?: boolean) => unknown; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const images = useLoad(signal => controller.api.call('image.list', { root }, signal), [root, project.revision])
  const [filter, setFilter] = useState<IllustrationInfo['kind'] | 'here' | 'all'>(chapter !== undefined ? 'here' : 'all')
  // Where they came from: drawn here, or brought in — said beside the kind, and with it.
  const [source, setSource] = useState<'all' | 'drawn' | 'imported'>('all')
  const every = images.data?.images ?? []
  const broughtIn = every.filter(image => image.imported === true).length
  const all = every.filter(image => source === 'all' || (image.imported === true) === (source === 'imported'))
  const here = all.filter(image => image.target === chapter)
  const kinds = [...new Set(all.map(image => image.kind))]
  const list = filter === 'all' ? all : filter === 'here' ? (here.length > 0 ? here : all) : all.filter(image => image.kind === filter)
  const nameOf = (image: IllustrationInfo): string | undefined => (image.target === undefined ? undefined
    : project.characters.find(card => card.id === image.target)?.name
      ?? project.world.find(entry => entry.id === image.target)?.name
      ?? [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].find(candidate => candidate.id === image.target)?.title)
  return (
    <Modal wide title={title ?? t('选一张图', 'Choose a picture')} onClose={onClose}>
      <div className="nv-chips">
        {chapter !== undefined && here.length > 0 ? <Chip active={filter === 'here'} tone={filter === 'here' ? 'blue' : 'neutral'} onClick={() => { setFilter('here') }}>{t(`这一章的 ${here.length}`, `Of this chapter · ${here.length}`)}</Chip> : null}
        <Chip active={filter === 'all'} tone={filter === 'all' ? 'blue' : 'neutral'} onClick={() => { setFilter('all') }}>{t(`全部 ${all.length}`, `All · ${all.length}`)}</Chip>
        {kinds.map(kind => <Chip key={kind} active={filter === kind} tone={filter === kind ? 'blue' : 'neutral'} onClick={() => { setFilter(kind) }}>{t(...PICTURE_KIND[kind])}</Chip>)}
        {broughtIn > 0 ? (
          <>
            <span className="nv-chips-rule" aria-hidden="true" />
            <Chip active={source === 'drawn'} tone={source === 'drawn' ? 'violet' : 'neutral'} onClick={() => { setSource(previous => (previous === 'drawn' ? 'all' : 'drawn')) }}>{t(`这里画的 ${every.length - broughtIn}`, `Drawn here · ${every.length - broughtIn}`)}</Chip>
            <Chip active={source === 'imported'} tone={source === 'imported' ? 'violet' : 'neutral'} onClick={() => { setSource(previous => (previous === 'imported' ? 'all' : 'imported')) }}>{t(`导入的 ${broughtIn}`, `Brought in · ${broughtIn}`)}</Chip>
          </>
        ) : null}
        <span className="nv-spacer" />
        {/* One that is not in the book yet: brought in — it is one of the book's pictures from then on — and chosen. */}
        <ImportPicture kind={bring?.kind ?? 'picture'} of={bring !== undefined ? bring.of ?? {} : chapter !== undefined ? { chapter } : {}} variant="outline" label={t('从电脑导入…', 'From this computer…')} quiet={bring === undefined} onDone={(_path, image) => { void onPick(image, true) }} />
      </div>
      {images.data === undefined ? <div className="nv-center"><Spinner /></div> : list.length === 0 ? <p className="nv-muted">{every.length > 0 ? t('没有这样的图。', 'No such picture.') : t('这本书还没有图。', 'The book has no pictures yet.')}</p> : (
        <div className="nv-gallery-grid nv-pick-grid">
          {list.map(image => (
            <button key={image.id} type="button" className="nv-gallery-item" onClick={() => { void onPick(image) }}>
              <ProjectImage path={image.path} alt={image.prompt} />
              <span className="nv-gallery-caption"><Chip>{t(...PICTURE_KIND[image.kind])}</Chip>{nameOf(image) !== undefined ? <span>{nameOf(image)}</span> : null}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}

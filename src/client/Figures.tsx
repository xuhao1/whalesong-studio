// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Which portraits the text carries.
 *
 * A portrait of a moment stands where the chapter tells the moment; one
 * portrait of the person stands where they first come on — unless a moment of
 * theirs is shown in that chapter already. The rest stay out until the author
 * asks one in, and any that stands can be kept out. The same say is had
 * wherever a portrait is met: where the chapter is read, where it is written,
 * and on the person's own page.
 */
import { useState } from 'react'
import type { PortraitPlace } from '../shared/reader'
import { Button, Chip, Modal, ProjectImage, Spinner, useLoad, useProject, useStudio, useT } from './ui'

/** The portraits of one chapter, or of one person, as the Host has them; `toggle` keeps one out of the text or lets it back. */
export function usePortraitPlaces(where: { chapter?: string | undefined; character?: string | undefined }, onChanged?: () => void): { places: PortraitPlace[] | undefined; toggle: (place: PortraitPlace) => Promise<void>; reload: () => void } {
  const { controller } = useStudio()
  const { root, project } = useProject()
  const t = useT()
  const asked = where.chapter !== undefined || where.character !== undefined
  const listed = useLoad(async signal => (asked ? await controller.api.call('figures.list', { root, ...(where.chapter !== undefined ? { chapter: where.chapter } : {}), ...(where.character !== undefined ? { character: where.character } : {}) }, signal) : undefined), [root, where.chapter, where.character, project.revision])
  const toggle = async (place: PortraitPlace): Promise<void> => {
    await controller.guard(async () => {
      await controller.api.call('figures.show', { root, path: place.path, show: place.hidden })
      listed.reload()
      onChanged?.()
      controller.toast('success', place.hidden ? t('这张立绘会出现在正文里', 'This portrait stands in the text again') : t('这张立绘不再出现在正文里', 'This portrait is kept out of the text'))
    })
  }
  return { places: listed.data?.portraits, toggle, reload: listed.reload }
}

/** Why a portrait is not in the text by itself, in a few words. */
export function spareWord(place: PortraitPlace, t: (zh: string, en: string) => string): string {
  return place.spare === 'moment' ? t('这一幕另有一张', 'another picture of this moment stands')
    : place.spare === 'chapter' ? t('这一章已有名场面', 'a moment of theirs stands in this chapter')
      : t('总的立绘另有一张', 'another portrait of them stands')
}

/** Where a portrait stands, in a few words. */
export function placeWord(place: PortraitPlace, t: (zh: string, en: string) => string): string {
  return place.chapter !== undefined ? t(`第 ${place.index} 章`, `chapter ${place.index}`) : t('还没有哪一章写到这个人', 'no chapter has them yet')
}

/**
 * The portraits of a chapter, behind a button that says how many there are: each with its say — in the text, or kept
 * out of it. Nothing is shown for a chapter that has none.
 */
export function ChapterPortraits({ chapter, onChanged, label }: { chapter: string | undefined; onChanged?: () => void; /** Shown with the count; left out, the count stands beside an icon alone. */ label?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const { places, toggle } = usePortraitPlaces({ chapter }, onChanged)
  if (chapter === undefined || places === undefined || places.length === 0) return null
  const shown = places.filter(place => !place.hidden).length
  return (
    <>
      <Button size="sm" variant="ghost" icon="image" onClick={() => { setOpen(true) }} title={t(`这一章的立绘：${shown} 张在正文里，另有 ${places.length - shown} 张没出现`, `Portraits of this chapter: ${shown} in the text, ${places.length - shown} more not in it`)}>
        {label === false ? `${shown}/${places.length}` : t(`立绘 ${shown}/${places.length}`, `Portraits ${shown}/${places.length}`)}
      </Button>
      {open ? (
        <Modal title={t('这一章的立绘', 'Portraits of this chapter')} onClose={() => { setOpen(false) }}>
          <p className="nv-muted nv-small">{t('名场面的立绘在讲到那一幕的段落后；一张总的立绘在这个人第一次出场处（这一章已有他的名场面就不出）。其余默认不出现，可以打开。', 'A portrait of a moment stands after the paragraph that tells it; one portrait of the person where they first come on (not where a moment of theirs is shown in the same chapter). The rest stay out unless you ask them in.')}</p>
          <div className="nv-figure-list">
            {places.map(place => <PortraitRow key={place.path} place={place} toggle={toggle} />)}
          </div>
        </Modal>
      ) : null}
    </>
  )
}

function PortraitRow({ place, toggle }: { place: PortraitPlace; toggle: (place: PortraitPlace) => Promise<void> }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  return (
    <div className={`nv-figure-row${place.hidden ? ' is-hidden' : ''}`}>
      <ProjectImage path={place.path} alt={place.name} className="nv-figure-thumb" />
      <div className="nv-figure-what">
        <strong>{place.title !== undefined ? `${place.title} · ${place.name}` : place.name}</strong>
        <span className="nv-muted nv-small">{place.title !== undefined ? t('名场面', 'A moment of theirs') : t('立绘', 'Portrait')}</span>
      </div>
      <Chip tone={place.hidden ? 'neutral' : 'green'}>{!place.hidden ? t('在正文里', 'In the text') : place.spare !== undefined ? t(`默认不出现 · ${spareWord(place, t)}`, `Not by itself · ${spareWord(place, t)}`) : t('已隐藏', 'Kept out')}</Chip>
      <Button size="sm" variant="ghost" icon={place.hidden ? 'eye' : 'eyeOff'} busy={busy} onClick={() => { setBusy(true); void toggle(place).finally(() => { setBusy(false) }) }}>{place.hidden ? t('显示', 'Show') : t('隐藏', 'Hide')}</Button>
    </div>
  )
}

/** One portrait's say, on the person's own page: where it stands in the book, and the switch that keeps it out. */
export function PortraitInText({ character, path }: { character: string; path: string }) {
  const t = useT()
  const { places, toggle } = usePortraitPlaces({ character })
  const [busy, setBusy] = useState(false)
  if (places === undefined) return <Spinner size={12} />
  const place = places.find(item => item.path === path)
  if (place === undefined) return null
  return (
    <span className="nv-figure-say">
      <span className="nv-muted nv-small">{place.chapter === undefined ? placeWord(place, t)
        : !place.hidden ? t(`出现在正文${placeWord(place, t)}`, `Stands in the text, ${placeWord(place, t)}`)
          : place.spare !== undefined ? t(`默认不进正文（${spareWord(place, t)}）`, `Not in the text by itself (${spareWord(place, t)})`)
            : t(`正文里隐藏了（本来在${placeWord(place, t)}）`, `Kept out of the text (it would stand in ${placeWord(place, t)})`)}</span>
      {place.chapter !== undefined ? <Button size="sm" variant="ghost" icon={place.hidden ? 'eye' : 'eyeOff'} busy={busy} onClick={() => { setBusy(true); void toggle(place).finally(() => { setBusy(false) }) }}>{place.hidden ? t('在正文里显示', 'Show in the text') : t('在正文里隐藏', 'Hide in the text')}</Button> : null}
    </span>
  )
}

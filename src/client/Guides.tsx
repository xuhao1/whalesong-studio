// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures to steer by.
 *
 * A few pictures the author gives to a stretch of plot being planned or a
 * chapter being written: chosen among the pictures the book already has, or
 * brought in from the computer; each may have a word said of it. One control
 * wherever pictures are given — beside the planner's direction, beside the
 * writer's brief.
 */
import { useRef, useState } from 'react'
import type { PictureGuide, PicturesRead, ReferencesLooked } from '../shared/types'
import { PickPicture } from './PlacePicture'
import { Button, cx, plainEnter, ProjectImage, TextInput, useProject, useStudio, useT } from './ui'

/** The most one piece of work is given; the Host holds to the same. */
const MOST = 12
/** A picture brought in is sent no larger than this on its long edge: enough for a model to read, small enough to send. */
const LONG_EDGE = 2048

/** A picture file as it is sent to the Host: scaled down where it is very large, as JPEG (or PNG where it has transparency to keep). */
async function encoded(file: File): Promise<{ mediaType: string; data: string }> {
  const base64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer)
    let text = ''
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
    return btoa(text)
  }
  const plain = async (): Promise<{ mediaType: string; data: string }> => ({ mediaType: file.type, data: base64(await file.arrayBuffer()) })
  // A small picture of a kind the Host takes goes as it is; an animation is never redrawn.
  if (file.type === 'image/gif' || (file.size <= 1_500_000 && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return await plain()
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/jpeg', 0.9) })
    if (blob === null) return await plain()
    return { mediaType: 'image/jpeg', data: base64(await blob.arrayBuffer()) }
  } catch {
    // A browser that cannot read it leaves it to the Host to say what is wrong with it.
    return await plain()
  }
}

/**
 * The pictures given to a piece of work, and the ways to add one.
 * @param chapter - the chapter in hand, whose own pictures the chooser lists first.
 */
export function GuidePictures({ value, onChange, disabled, chapter, hint }: { value: readonly PictureGuide[]; onChange: (next: PictureGuide[]) => void; disabled?: boolean; chapter?: string | undefined; hint?: string }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [picking, setPicking] = useState(false)
  const [bringing, setBringing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const full = value.length >= MOST
  const add = (path: string): void => { if (!value.some(guide => guide.path === path)) onChange([...value, { path }].slice(0, MOST)) }
  const bring = (files: FileList | null): void => {
    const chosen = [...(files ?? [])].filter(file => file.type.startsWith('image/')).slice(0, MOST - value.length)
    if (chosen.length === 0) return
    setBringing(true)
    void controller.guard(async () => {
      let next = [...value]
      for (const file of chosen) {
        const { path } = await controller.api.call('guide.add', { root, ...(await encoded(file)) })
        if (!next.some(guide => guide.path === path)) next = [...next, { path }]
      }
      onChange(next.slice(0, MOST))
    }).finally(() => {
      setBringing(false)
      if (input.current !== null) input.current.value = ''
    })
  }
  return (
    <div className={cx('nv-guides', disabled === true && 'is-off')}>
      <div className="nv-guides-head">
        <span className="nv-guides-label">{t('参考图', 'Pictures to go by')}{value.length > 0 ? ` · ${value.length}` : ''}</span>
        <Button size="sm" variant="ghost" icon="image" disabled={disabled === true || full} onClick={() => { setPicking(true) }}>{t('从本书的图里选…', 'From the book…')}</Button>
        <Button size="sm" variant="ghost" icon="upload" busy={bringing} disabled={disabled === true || full} pending={t('正在带进来…', 'Bringing it in…')} onClick={() => { input.current?.click() }}>{t('从电脑选…', 'From this computer…')}</Button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(event) => { bring(event.target.files) }} />
        {hint !== undefined && value.length > 0 ? <span className="nv-muted nv-small">{hint}</span> : null}
      </div>
      {value.length > 0 ? (
        <div className="nv-guides-list">
          {value.map((guide, at) => (
            <div key={guide.path} className="nv-guide">
              <span className="nv-guide-no">{at + 1}</span>
              <ProjectImage path={guide.path} alt="" className="nv-guide-thumb" />
              <GuideNote note={guide.note ?? ''} disabled={disabled === true} onCommit={(note) => { onChange(value.map((item, index) => (index === at ? (note.length > 0 ? { path: item.path, note } : { path: item.path }) : item))) }} />
              <button type="button" className="nv-guide-drop" disabled={disabled === true} title={t('不用这张', 'Leave this one out')} aria-label={t('不用这张', 'Leave this one out')} onClick={() => { onChange(value.filter((_item, index) => index !== at)) }}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      {picking ? <PickPicture {...(chapter !== undefined ? { chapter } : {})} onPick={(image) => { add(image.path); setPicking(false) }} onClose={() => { setPicking(false) }} /> : null}
    </div>
  )
}

/** What the author says of one picture: typed freely, handed on when the field is left — where the pictures are kept with a chapter, that is when they are saved. */
function GuideNote({ note, disabled, onCommit }: { note: string; disabled: boolean; onCommit: (note: string) => void }) {
  const t = useT()
  const [text, setText] = useState(note)
  const [held, setHeld] = useState(note)
  // Changed from outside (another picture list loaded): shown as it is now.
  if (held !== note) {
    setHeld(note)
    setText(note)
  }
  const commit = (): void => { if (text.trim() !== note) onCommit(text.trim()) }
  return <TextInput className="nv-guide-note" value={text} disabled={disabled} placeholder={t('说一句（可不填）：这是哪一幕、要它的什么', 'A word on it (optional): what it is, what of it matters')} onChange={(event) => { setText(event.target.value) }} onBlur={commit} onKeyDown={(event) => { if (plainEnter(event)) (event.target as HTMLInputElement).blur() }} />
}

/** How the pictures given to a piece of work were read, in a line for whoever gave them. */
export function picturesReadWord(read: PicturesRead | undefined, t: (zh: string, en: string) => string): string | undefined {
  if (read === undefined) return undefined
  if (read.by === 'vision') return t(`${read.count} 张参考图由 ${read.model ?? '看图的模型'} 看成了文字`, `${read.count} picture(s) put into words by ${read.model ?? 'the picture model'}`)
  return read.unsure === true
    ? t(`${read.count} 张参考图发给了模型；它没有声明能不能看图——看不出效果的话，到设置里配一个“看图的模型”`, `${read.count} picture(s) sent to the model, which does not say whether it sees them — if it shows no sign of it, set up a model to look at pictures in the settings`)
    : t(`${read.count} 张参考图，模型自己看的`, `${read.count} picture(s), looked at by the model itself`)
}

/** What a role read in the book's references for work that looks in them first, in a line for the author. */
export function referencesLookedWord(looked: ReferencesLooked | undefined, t: (zh: string, en: string) => string): string | undefined {
  if (looked === undefined) return undefined
  if (looked.cannot !== undefined) return t(`没查参考文献：${looked.cannot}`, `The references were not looked at: ${looked.cannot}`)
  if (looked.calls === 0) return t('该先查参考文献，这次没有去读', 'The references were to be looked at first, and nothing was read in them this time')
  return t(`先查了参考文献：${looked.read.join('；')}`, `Looked in the references first: ${looked.read.join('; ')}`)
}

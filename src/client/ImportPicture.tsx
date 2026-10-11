// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture that was made elsewhere, brought in as one of the book's.
 *
 * Beside the buttons that draw — a portrait, a design sheet, the design art
 * of a place, a house or a thing, the cover — and where a picture is chosen
 * among the book's: the same place taken by a file of the author's own, a
 * photograph, a picture they drew or had drawn, or made with another tool. It
 * is kept among the book's pictures and hangs where one drawn here would.
 */
import { useRef } from 'react'
import type { IllustrationInfo } from '../shared/types'
import type { StudioController } from './store'
import { Button, useAction, useProject, useStudio, useT } from './ui'

/** A picture given to steer by is sent no larger than this on its long edge: enough for a model to read, small enough to send. */
const LONG_EDGE = 2048

/**
 * A picture file as it is sent to the Host: scaled down where it is very large, as JPEG (or PNG where it has transparency to keep).
 * @param asIs - up to how many bytes it goes as it is, and how long its long edge may be otherwise: a picture to steer
 *   by is only read; one that becomes a picture of the book is kept as fine as it came.
 */
export async function encoded(file: File, asIs = 1_500_000, longEdge = LONG_EDGE): Promise<{ mediaType: string; data: string }> {
  const base64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer)
    let text = ''
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
    return btoa(text)
  }
  const plain = async (): Promise<{ mediaType: string; data: string }> => ({ mediaType: file.type, data: base64(await file.arrayBuffer()) })
  // A small picture of a kind the Host takes goes as it is; an animation is never redrawn.
  if (file.type === 'image/gif' || (file.size <= asIs && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return await plain()
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height))
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

/** What a picture is brought in as: `art` — the design art of an entry of the bible; `picture` — one of the gallery's, hanging nowhere. */
export type BroughtKind = 'portrait' | 'sheet' | 'art' | 'cover' | 'picture'

/**
 * Whose it is, and which of theirs: somebody's (a look's sheet, a stretch's picture, the portrait of one of their
 * moments); an entry's (the picture of one turn of its course: `event`); a chapter's, where it is for that chapter's text.
 */
export interface BroughtOf {
  character?: string
  look?: string
  stage?: string
  scene?: string
  entry?: string
  event?: string
  chapter?: string
}

/**
 * Bring one file in as a picture of the book.
 * @returns its record, and whether it waits not in use beside one the author chose (`spare`).
 */
export async function bringIn(controller: StudioController, root: string, file: File, kind: BroughtKind, of: BroughtOf = {}): Promise<{ image: IllustrationInfo; spare: boolean }> {
  // Kept as fine as it came, short of what is too large to send whole.
  const picture = await encoded(file, 12_000_000, 4096)
  const target = kind === 'art' ? of.entry : kind === 'portrait' || kind === 'sheet' ? of.character : undefined
  const done = await controller.api.call('image.import', {
    root,
    kind,
    ...(target !== undefined ? { target } : {}),
    ...picture,
    ...(of.look !== undefined ? { look: of.look } : {}),
    ...(of.stage !== undefined ? { stage: of.stage } : {}),
    ...(of.scene !== undefined ? { scene: of.scene } : {}),
    ...(of.event !== undefined ? { event: of.event } : {}),
    ...(kind === 'picture' && of.chapter !== undefined ? { chapter: of.chapter } : {}),
  })
  // (A Host that does not send the record yet: what is known of it here.)
  const image: IllustrationInfo = done.image ?? { id: done.path, path: done.path, prompt: '', kind: kind === 'art' ? 'location' : kind === 'picture' ? 'scene' : kind, createdAt: new Date().toISOString(), imported: true, ...(target !== undefined ? { target } : {}) }
  return { image, spare: done.spare === true }
}

/**
 * @param kind - what it is brought in as.
 * @param of - whose, and which of theirs.
 * @param multiple - several files may be chosen at once: each is brought in, one after another.
 * @param quiet - nothing is said when it is done: the page that asked says its own.
 * @param onDone - each picture as it is brought in; `onAll` - all of them, once the last is in.
 */
export function ImportPicture({ kind, of, disabled, label, variant = 'ghost', multiple, quiet, onDone, onAll }: { kind: BroughtKind; of?: BroughtOf; disabled?: boolean; /** Said on the button; left out, the button is its icon alone. */ label?: string; variant?: 'ghost' | 'outline' | 'primary'; multiple?: boolean; quiet?: boolean; onDone?: (path: string, image: IllustrationInfo) => void; onAll?: (images: IllustrationInfo[]) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const input = useRef<HTMLInputElement>(null)
  const { busy, run } = useAction()
  const said = kind === 'sheet' ? t('从电脑导入一张人设图', 'Bring in a design sheet from this computer')
    : kind === 'portrait' ? t('从电脑导入一张立绘', 'Bring in a portrait from this computer')
      : kind === 'art' ? (of?.event !== undefined ? t('从电脑导入一张它这时的样子', 'Bring in a picture of it as it is then') : t('从电脑导入一张设定图：照片、自己画的都行', 'Bring in its design art from this computer: a photograph, a drawing of your own'))
        : kind === 'cover' ? t('从电脑导入一张封面', 'Bring in a cover from this computer')
          : multiple === true ? t('从电脑导入图片，可以一次选几张', 'Bring pictures in from this computer, several at once') : t('从电脑导入一张图', 'Bring a picture in from this computer')
  const bring = (files: FileList | null): void => {
    const chosen = [...(files ?? [])]
    if (input.current !== null) input.current.value = ''
    if (chosen.length === 0) return
    void run(async () => {
      const brought: IllustrationInfo[] = []
      const failed: string[] = []
      let spare = false
      for (const file of chosen) {
        try {
          const done = await bringIn(controller, root, file, kind, of)
          brought.push(done.image)
          spare = spare || done.spare
          onDone?.(done.image.path, done.image)
        } catch (reason) {
          // One that cannot be read does not keep the others out; a single one says what is wrong with it.
          if (chosen.length === 1) throw reason
          failed.push(`${file.name}: ${reason instanceof Error ? reason.message : String(reason)}`)
        }
      }
      await controller.refreshProject()
      if (brought.length > 0) onAll?.(brought)
      if (failed.length > 0) controller.toast('error', t(`${failed.length} 张没能导入：${failed.slice(0, 3).join('；')}`, `${failed.length} could not be brought in: ${failed.slice(0, 3).join('; ')}`))
      if (quiet === true || brought.length === 0) return
      controller.toast('success', brought.length > 1 ? t(`导入了 ${brought.length} 张`, `${brought.length} pictures brought in`)
        : kind === 'sheet' ? (spare
            ? t('导入了，先不启用：主人设图是你选定的那张。要用它，点它再点“设为主人设图”', 'Brought in, not in use yet: the main sheet is the one you chose. To use this one, open it and make it the main sheet')
            : t('人设图导入了', 'Design sheet brought in'))
          : kind === 'portrait' ? t('立绘导入了', 'Portrait brought in')
            : kind === 'art' ? (of?.event !== undefined ? t('它这时的样子导入了', 'Brought in as it is then')
                : spare ? t('导入了，先不启用：主设定图是你选定的那张。要用它，点它再点“设为主设定图”', 'Brought in, not in use yet: the main picture is the one you chose. To use this one, pick it and make it the main picture')
                  : t('设定图导入了', 'Design art brought in'))
              : kind === 'cover' ? t('封面换成了导入的这张', 'The cover is the picture brought in')
                : t('导入了，在图库里', 'Brought in: it is in the gallery'))
    }).catch((reason: unknown) => { controller.toast('error', reason instanceof Error ? reason.message : String(reason)) })
  }
  return (
    <>
      <Button size="sm" variant={variant} icon="upload" busy={busy} disabled={disabled === true} title={said} aria-label={said} onClick={() => { input.current?.click() }}>{label}</Button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden {...(multiple === true ? { multiple: true } : {})} onChange={(event) => { bring(event.target.files) }} />
    </>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture set straight by hand: turned by quarters, mirrored, a part of it kept.
 *
 * Where a picture is opened large. What comes of it is a picture of its own
 * that stands where the one worked on stood; that one stays in the book.
 * Worked on again, it starts from the picture it was made of with what was
 * done to it laid out — so a cut can be widened again, and undone altogether.
 *
 * The picture is drawn here, in the page, and what was done is put on record
 * by the Host. This is the author's to do, here: no agent has a tool for it.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { dragCrop, editOf, editState, keptPixels, mirror, quarter, sameEdit, shaped, turnedFrame, untouched, type Crop, type CropHandle, type EditState, type Frame } from '../shared/edit'
import type { IllustrationInfo } from '../shared/types'
import { base64Of } from './ImportPicture'
import { Button, Modal, Select, Spinner, useAction, useMediaUrl, useProject, useStudio, useT } from './ui'

/** The shape a cut is held to: none, the picture's own, or one of the usual ones (width to height). */
type Shape = 'free' | 'same' | '1:1' | '4:3' | '3:4' | '3:2' | '2:3' | '16:9' | '9:16'
/** What a shape is once the picture is turned a quarter: lying where it stood. */
const TURNED: Record<Shape, Shape> = { 'free': 'free', 'same': 'same', '1:1': '1:1', '4:3': '3:4', '3:4': '4:3', '3:2': '2:3', '2:3': '3:2', '16:9': '9:16', '9:16': '16:9' }

function ratioOf(shape: Shape, frame: Frame): number | undefined {
  if (shape === 'free') return undefined
  if (shape === 'same') return frame.width / frame.height
  const [width, height] = shape.split(':').map(Number)
  return width! / height!
}

/** No cut is thinner than this many of the picture's pixels. */
const LEAST = 16
/** What is sent to the Host in one piece is no larger than this; a picture that comes out larger goes as JPEG. */
const SENT_WHOLE = 12_000_000
/** The picture as it is worked on is drawn no larger than this on its long edge; what is kept is drawn at its full size. */
const SHOWN = 1600

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** The picture mirrored and turned, drawn with the turned frame's top left corner at the context's origin. */
function drawTurned(context: CanvasRenderingContext2D, source: CanvasImageSource, size: Frame, state: Pick<EditState, 'flip' | 'turn'>): void {
  const { width, height } = size
  if (state.turn === 1) { context.translate(height, 0); context.rotate(Math.PI / 2) } else if (state.turn === 2) { context.translate(width, height); context.rotate(Math.PI) } else if (state.turn === 3) { context.translate(0, width); context.rotate(-Math.PI / 2) }
  if (state.flip) { context.translate(width, 0); context.scale(-1, 1) }
  context.drawImage(source, 0, 0, width, height)
}

/** What was done, as a picture: the pixels kept, at the size they have in the picture worked on. */
async function rendered(source: HTMLImageElement, size: Frame, state: EditState, like: string): Promise<{ mediaType: string; data: string; asJpeg: boolean }> {
  const kept = keptPixels(size, state)
  const canvas = document.createElement('canvas')
  canvas.width = kept.width
  canvas.height = kept.height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('this browser gave no canvas to draw the picture on')
  const draw = (): void => {
    context.save()
    context.translate(-kept.x, -kept.y)
    drawTurned(context, source, size, state)
    context.restore()
  }
  draw()
  const blobOf = async (type: string, quality?: number): Promise<Blob> => {
    const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, type, quality) })
    if (blob === null) throw new Error('the picture could not be put into a file')
    return blob
  }
  // As the kind of file it was: what was a JPEG stays one (at a quality that shows nothing of having been saved
  // twice), anything else keeps every pixel as it is.
  const wanted = /\.jpe?g$/i.test(like) ? 'image/jpeg' : /\.webp$/i.test(like) ? 'image/webp' : 'image/png'
  let blob = await blobOf(wanted, wanted === 'image/png' ? undefined : 0.95)
  let asJpeg = false
  if (blob.size > SENT_WHOLE && blob.type !== 'image/jpeg') {
    // Too large to send whole: as JPEG, on white where it was see-through.
    context.globalCompositeOperation = 'destination-over'
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.globalCompositeOperation = 'source-over'
    blob = await blobOf('image/jpeg', 0.92)
    asJpeg = true
  }
  // (A browser that cannot write the kind asked for writes PNG: the Host reads what it is off its first bytes.)
  return { mediaType: ['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) ? blob.type : 'image/png', data: base64Of(await blob.arrayBuffer()), asJpeg }
}

/**
 * @param path - the picture opened.
 * @param image - its record, where it has one: a picture made here before is worked on from the one it was made of.
 * @param onDone - what stands in its place now: the picture made, or the original brought back.
 */
export function AdjustPicture({ path, image, onClose, onDone }: { path: string; image?: IllustrationInfo | undefined; onClose: () => void; onDone: (now: IllustrationInfo) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const mediaUrl = useMediaUrl()
  const { busy, run } = useAction()
  // Made of another picture by hand: that one is what is worked on, with what was done to it laid out. (Should it be
  // gone after all, the picture opened is worked on as it is.)
  const [lost, setLost] = useState(false)
  const made = image?.edited !== undefined && image.path === path && !lost ? image.edited : undefined
  const base = made?.of ?? path
  // (By what it says, not by which object says it: the records are read anew whenever the book changes, and a cut
  // half dragged is not thrown away for that.)
  const madeAs = JSON.stringify(made ?? null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const first = useMemo(() => editState(made), [madeAs])
  const [state, setState] = useState<EditState>(first)
  useEffect(() => { setState(first) }, [first])
  const [shape, setShape] = useState<Shape>('free')

  // The picture worked on, as pixels.
  const [source, setSource] = useState<HTMLImageElement | undefined>()
  const [unread, setUnread] = useState(false)
  useEffect(() => {
    let alive = true
    setSource(undefined)
    setUnread(false)
    const picture = new Image()
    picture.onload = () => { if (alive) setSource(picture) }
    picture.onerror = () => {
      if (!alive) return
      if (base !== path) setLost(true)
      else setUnread(true)
    }
    picture.src = mediaUrl(base)
    return () => { alive = false }
  }, [base, path, mediaUrl])
  const size = useMemo((): Frame | undefined => (source !== undefined && source.naturalWidth > 0 && source.naturalHeight > 0 ? { width: source.naturalWidth, height: source.naturalHeight } : undefined), [source])
  const frame = size !== undefined ? turnedFrame(size, state.turn) : undefined

  // As large as the room there is for it.
  const room = useRef<HTMLDivElement | null>(null)
  const [space, setSpace] = useState<Frame>({ width: 0, height: 0 })
  useEffect(() => {
    const element = room.current
    if (element === null) return
    // (Less the margin the room keeps for the handles of a cut that reaches the picture's edge.)
    const measure = (): void => {
      const style = getComputedStyle(element)
      setSpace({ width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), height: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) })
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(element)
    return () => { watch.disconnect() }
  }, [])
  const fit = frame !== undefined && space.width > 0 && space.height > 0 ? Math.min(space.width / frame.width, space.height / frame.height, 4) : 0
  const shown = frame !== undefined ? { width: Math.max(1, Math.floor(frame.width * fit)), height: Math.max(1, Math.floor(frame.height * fit)) } : undefined

  // Drawn anew when it is turned or mirrored; a cut moves a box over it, and draws nothing.
  const canvas = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const element = canvas.current
    if (element === null || source === undefined || size === undefined) return
    const turned = turnedFrame(size, state.turn)
    const scale = Math.min(1, SHOWN / Math.max(turned.width, turned.height))
    element.width = Math.max(1, Math.round(turned.width * scale))
    element.height = Math.max(1, Math.round(turned.height * scale))
    const context = element.getContext('2d')
    if (context === null) return
    context.setTransform(scale, 0, 0, scale, 0, 0)
    drawTurned(context, source, size, state)
  }, [source, size, state.turn, state.flip])

  // The cut, dragged: by a corner, an edge, or as a whole.
  const board = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ handle: CropHandle; x: number; y: number; from: Crop; width: number; height: number } | undefined>(undefined)
  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (frame === undefined || busy || event.button !== 0) return
    const handle = (event.target as HTMLElement).dataset['handle'] as CropHandle | undefined
    const box = board.current?.getBoundingClientRect()
    if (handle === undefined || box === undefined || box.width <= 0 || box.height <= 0) return
    event.preventDefault()
    // (Held, so the drag goes on outside the picture; a pointer that cannot be held is followed while it is over it.)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* followed without */ }
    drag.current = { handle, x: event.clientX, y: event.clientY, from: state.crop, width: box.width, height: box.height }
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    if (held === undefined || frame === undefined) return
    const least = { x: Math.min(1, LEAST / frame.width), y: Math.min(1, LEAST / frame.height) }
    const crop = dragCrop(held.from, held.handle, { x: (event.clientX - held.x) / held.width, y: (event.clientY - held.y) / held.height }, least, ratioOf(shape, frame), frame)
    setState(now => ({ ...now, crop }))
  }
  const up = (): void => { drag.current = undefined }

  const turn = (by: 1 | -1): void => {
    setState(now => quarter(now, by))
    setShape(now => TURNED[now])
  }
  const hold = (next: Shape): void => {
    setShape(next)
    const ratio = frame !== undefined ? ratioOf(next, frame) : undefined
    if (frame !== undefined && ratio !== undefined) setState(now => ({ ...now, crop: shaped(now.crop, ratio, frame) }))
  }

  const kept = size !== undefined ? keptPixels(size, state) : undefined
  const plain = untouched(state)
  // Nothing to keep: as it was when it was opened — or nothing done to a picture nothing was done to.
  const idle = sameEdit(state, first) || (plain && made === undefined)
  const save = (): Promise<unknown> => run(async () => {
    if (source === undefined || size === undefined) return
    const picture = plain ? undefined : await rendered(source, size, state, base)
    const done = await controller.api.call('image.adjust', {
      root,
      picture: path,
      ...(base !== path ? { from: base } : {}),
      edit: editOf(state),
      ...(picture !== undefined ? { mediaType: picture.mediaType, data: picture.data } : {}),
    })
    await controller.refreshProject()
    const said = [done.restored === true
      ? t('恢复成原图了', 'The original is back')
      : t(`存成了一张新图，原图留着${done.held.length > 0 ? `；${[...new Set(done.held)].join('、')} 那里换成了这一张` : ''}`, `Kept as a picture of its own; the original stays${done.held.length > 0 ? ` — ${[...new Set(done.held)].join(', ')} now shows this one` : ''}`)]
    if (picture?.asJpeg === true) said.push(t('太大，存成了 JPEG', 'too large to keep as it was: saved as JPEG'))
    if (done.shown !== undefined && done.shown.length > 0) said.push(t(`上一次改出来的那张还插在《${done.shown.join('》《')}》的正文里，留着没删`, `the one made last time is still in the text of ${done.shown.join(', ')}, and was kept`))
    controller.toast('success', said.join(t('；', '; ')))
    onDone(done.image)
  })

  return (
    <Modal wide className="nv-modal-adjust" title={t('裁切 · 旋转', 'Crop · rotate')} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{made !== undefined ? t('从原图接着改；原图一直留着。', 'Worked on from the original, which stays.') : t('存成一张新图，原图留着。', 'Kept as a picture of its own; the original stays.')}</span>
        <span className="nv-spacer" />
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" icon={plain && made !== undefined ? 'undo' : 'check'} busy={busy} disabled={idle || source === undefined} onClick={() => { void save() }}>{plain && made !== undefined ? t('恢复原图', 'Restore the original') : t('保存', 'Save')}</Button>
      </>
    )}>
      <div className="nv-adjust">
        <div className="nv-adjust-tools">
          <Button size="sm" variant="outline" icon="rotateCcw" disabled={busy || source === undefined} onClick={() => { turn(-1) }} title={t('向左转 90°', 'Turn a quarter to the left')} aria-label={t('向左转 90°', 'Turn a quarter to the left')} />
          <Button size="sm" variant="outline" icon="rotateCw" disabled={busy || source === undefined} onClick={() => { turn(1) }} title={t('向右转 90°', 'Turn a quarter to the right')} aria-label={t('向右转 90°', 'Turn a quarter to the right')} />
          <Button size="sm" variant="outline" icon="flipH" disabled={busy || source === undefined} onClick={() => { setState(now => mirror(now, 'h')) }} title={t('左右镜像', 'Mirror left to right')} aria-label={t('左右镜像', 'Mirror left to right')} />
          <Button size="sm" variant="outline" icon="flipV" disabled={busy || source === undefined} onClick={() => { setState(now => mirror(now, 'v')) }} title={t('上下镜像', 'Mirror top to bottom')} aria-label={t('上下镜像', 'Mirror top to bottom')} />
          <span className="nv-adjust-shape">
            <span className="nv-muted nv-small">{t('裁切', 'Crop')}</span>
            <Select<Shape>
              value={shape}
              disabled={busy || source === undefined}
              onChange={hold}
              options={[
                { value: 'free', label: t('自由', 'Free') },
                { value: 'same', label: t('原比例', 'As the picture') },
                { value: '1:1', label: '1:1' },
                { value: '4:3', label: '4:3' },
                { value: '3:4', label: '3:4' },
                { value: '3:2', label: '3:2' },
                { value: '2:3', label: '2:3' },
                { value: '16:9', label: '16:9' },
                { value: '9:16', label: '9:16' },
              ]}
            />
          </span>
          <span className="nv-spacer" />
          {kept !== undefined ? <span className="nv-muted nv-small nv-adjust-size">{kept.width} × {kept.height}</span> : null}
          <Button size="sm" variant="ghost" icon="undo" disabled={busy || plain} onClick={() => { setState(editState()); setShape('free') }} title={t('回到原图的样子：不裁、不转', 'Back to the picture as it was: whole, unturned')}>{t('复位', 'Reset')}</Button>
        </div>
        <div className="nv-adjust-room" ref={room}>
          {unread
            ? <p className="nv-muted nv-small">{t('这张图读不出来。', 'This picture could not be read.')}</p>
            : source === undefined || shown === undefined
              ? <Spinner />
              : (
                  <div className="nv-adjust-board" ref={board} data-no-swipe style={{ width: shown.width, height: shown.height }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
                    <canvas ref={canvas} />
                    {/* What is left out, dimmed — cut off at the picture's edge, which the box and its handles are not. */}
                    <div className="nv-adjust-shade"><div style={{ left: `${state.crop.x * 100}%`, top: `${state.crop.y * 100}%`, width: `${state.crop.width * 100}%`, height: `${state.crop.height * 100}%` }} /></div>
                    <div className="nv-adjust-box" data-handle="move" style={{ left: `${state.crop.x * 100}%`, top: `${state.crop.y * 100}%`, width: `${state.crop.width * 100}%`, height: `${state.crop.height * 100}%` }}>
                      {/* Held to a shape, a cut is dragged by its corners: an edge alone would move its neighbours. */}
                      {HANDLES.filter(handle => shape === 'free' || handle.length === 2).map(handle => <span key={handle} className={`nv-adjust-handle is-${handle}`} data-handle={handle} />)}
                    </div>
                  </div>
                )}
        </div>
      </div>
    </Modal>
  )
}

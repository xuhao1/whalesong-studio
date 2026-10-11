// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The pictures in the chapter being written, beside its text.
 *
 * The text is edited as plain text, where a picture is one line of markup
 * that shows nothing. Here each one is shown — the picture, and the line of
 * prose it stands after — and moved: a line up, a line down, or to after any
 * line of the chapter; taken out of the text (it stays in the gallery); and
 * another put in out of everything the book has drawn. All of it is done in
 * the text the author has open: it is their edit, saved as any other is.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { embeddedPictures, movedPicture, pictureChanged, proseLines, withoutPicture, withPicture, type EmbeddedPicture, type PictureBlock } from '../shared/embedded'
import { clip } from '../shared/text'
import { ImportPicture } from './ImportPicture'
import { PictureViewer } from './PictureRecord'
import { PickPicture } from './PlacePicture'
import { Button, cx, Modal, plainEnter, ProjectImage, useMediaUrl, useT } from './ui'

/** What a picture chosen out of the gallery is called in the text, where the text has no word for the one it replaces. */
const captionOf = (image: { prompt: string }): string => [...image.prompt.replace(/\s+/g, ' ')].slice(0, 40).join('')

/**
 * A picture in the chapter being written, shown where it stands in the text: looked at large — with the record of
 * its making, and everything that can be done with a picture there —, exchanged for another of the book, moved a
 * line up or down, taken out. Its line of markup is changed in the text the author has open; the picture drawn again
 * from here is the one the text then has.
 */
export function TextFigure({ chapter, text, block, onText }: { chapter: string; text: string; block: PictureBlock; onText: (next: string) => void }) {
  const t = useT()
  const mediaUrl = useMediaUrl()
  const [viewing, setViewing] = useState(false)
  const [picking, setPicking] = useState(false)
  // Its file is not in the book (deleted in the gallery, or the path mistyped): said, with the way to take the line out.
  const [missing, setMissing] = useState(false)
  // Asked for anew after something was done to it where it was opened: taken out of the book there, its file is gone.
  const [asked, setAsked] = useState(0)
  useEffect(() => { setMissing(false); setAsked(0) }, [block.path])
  const url = mediaUrl(block.path)
  const [caption, setCaption] = useState(block.alt)
  const [held, setHeld] = useState(block.alt)
  if (held !== block.alt) {
    setHeld(block.alt)
    setCaption(block.alt)
  }
  const after = useMemo(() => embeddedPictures(text).find(item => item.line === block.line)?.after ?? 0, [text, block.line])
  const most = useMemo(() => proseLines(text).length, [text])
  const named = (): void => { if (caption.trim() !== block.alt) onText(pictureChanged(text, block.line, { alt: caption.trim() })) }
  return (
    <figure className={cx('nv-editor-figure', missing && 'is-missing')}>
      {missing ? (
        <p className="nv-editor-figure-gone nv-small">{t(`这张图已经不在书里了：${block.path}`, `This picture is no longer in the book: ${block.path}`)}</p>
      ) : (
        <button type="button" className="nv-editor-figure-open" onClick={() => { setViewing(true) }} title={t('点开：看大图和来历，重画、照着改、对比', 'Open it: the picture large and how it was made — redraw it, change it, compare')}>
          <img alt={block.alt} loading="lazy" src={asked === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}again=${asked}`} onError={() => { setMissing(true) }} />
        </button>
      )}
      <figcaption>
        <input className="nv-editor-figure-caption" value={caption} placeholder={t('图下的说明（可不填）', 'A caption (optional)')} onChange={(event) => { setCaption(event.target.value) }} onBlur={named} onKeyDown={(event) => { if (plainEnter(event)) (event.target as HTMLInputElement).blur() }} />
        <span className="nv-editor-figure-tools">
          <Button size="sm" variant="ghost" icon="layers" title={t('换成这本书里的另一张图', 'Another of the book\'s pictures in its place')} onClick={() => { setPicking(true) }}>{t('换一张…', 'Another…')}</Button>
          <Button size="sm" variant="ghost" icon="arrowUp" disabled={after === 0} title={t('上移一段', 'Up one line')} onClick={() => { onText(movedPicture(text, block.line, after - 1)) }} />
          <Button size="sm" variant="ghost" icon="arrowDown" disabled={after >= most} title={t('下移一段', 'Down one line')} onClick={() => { onText(movedPicture(text, block.line, after + 1)) }} />
          <Button size="sm" variant="ghost" icon="x" title={missing ? t('从正文里取下这一行', 'Take this line out of the text') : t('从正文里取下（图还在图库里）', 'Take it out of the text (it stays in the gallery)')} onClick={() => { onText(withoutPicture(text, block.line)) }} />
        </span>
      </figcaption>
      {viewing ? (
        <PictureViewer
          path={block.path}
          title={t('正文里的图', 'A picture in the text')}
          onClose={() => { setViewing(false) }}
          // Drawn again from here, the picture that came of it is the one the text has.
          onChanged={(now) => {
            if (now !== undefined && now !== block.path) onText(pictureChanged(text, block.line, { path: now }))
            else if (now === undefined) setAsked(Date.now())
          }}
        />
      ) : null}
      {picking ? (
        <PickPicture
          chapter={chapter}
          onClose={() => { setPicking(false) }}
          onPick={(image) => {
            setPicking(false)
            onText(pictureChanged(text, block.line, { path: image.path, ...(block.alt.length === 0 ? { alt: captionOf(image) } : {}) }))
          }}
        />
      ) : null}
    </figure>
  )
}

/**
 * @param text - the chapter's text as the editor has it.
 * @param onText - the text with a picture moved, taken out or put in.
 * @param caret - how many lines of prose stand before where the author is writing: a picture put in goes after them.
 * @param onReveal - show that place of the text in the editor.
 */
export function TextPictures({ chapter, text, onText, caret, onReveal }: { chapter: string; text: string; onText: (next: string) => void; caret: () => number; onReveal: (offset: number) => void }) {
  const t = useT()
  const pictures = useMemo(() => embeddedPictures(text), [text])
  const prose = useMemo(() => proseLines(text), [text])
  const [viewing, setViewing] = useState<string | undefined>()
  const [picking, setPicking] = useState(false)
  // The text as it stands when a picture brought in arrives: the author may have gone on writing while it was sent.
  const latest = useRef(text)
  latest.current = text
  // The picture being given another place, while the author says which.
  const [placing, setPlacing] = useState<EmbeddedPicture | undefined>()
  const where = (picture: EmbeddedPicture): string => (picture.after === 0 ? t('在最前面', 'At the top') : t(`第 ${picture.after} 段后：${clip(picture.follows ?? '', 22)}`, `After line ${picture.after}: ${clip(picture.follows ?? '', 30)}`))
  return (
    <div className="nv-panel-section nv-text-pictures">
      <div className="nv-row-wrap">
        <Button size="sm" icon="plus" onClick={() => { setPicking(true) }} title={t('从这本书已有的图里选一张，插到光标所在的那一段之后', 'Choose one of the book\'s pictures; it goes after the line the caret is in')}>{t('从图库插入…', 'From the gallery…')}</Button>
        {/* One of the author's own that is not in the book yet: brought in, and put after the line the caret is in. */}
        <ImportPicture kind="picture" of={{ chapter }} variant="outline" label={t('从电脑插入…', 'From this computer…')} quiet onDone={(path) => { onText(withPicture(latest.current, { path, alt: '' }, caret())) }} />
        <span className="nv-muted nv-small">{pictures.length > 0 ? t(`正文里 ${pictures.length} 张`, `${pictures.length} in the text`) : t('正文里还没有图', 'No picture in the text yet')}</span>
      </div>
      {pictures.map(picture => (
        <div key={`${picture.line}:${picture.path}`} className="nv-text-picture">
          <button type="button" className="nv-text-picture-thumb" onClick={() => { setViewing(picture.path) }} title={t('点开看大图', 'Open it large')}><ProjectImage path={picture.path} alt={picture.alt} /></button>
          <div className="nv-text-picture-body">
            <button type="button" className="nv-link nv-small nv-text-picture-where" onClick={() => { onReveal(picture.offset) }} title={t('在正文里找到它', 'Show it in the text')}>{where(picture)}</button>
            {picture.alt.length > 0 ? <span className="nv-muted nv-small">{clip(picture.alt, 30)}</span> : null}
            <span className="nv-row">
              <Button size="sm" variant="ghost" icon="arrowUp" disabled={picture.after === 0} title={t('上移一段', 'Up one line')} onClick={() => { onText(movedPicture(text, picture.line, picture.after - 1)) }} />
              <Button size="sm" variant="ghost" icon="arrowDown" disabled={picture.after >= prose.length} title={t('下移一段', 'Down one line')} onClick={() => { onText(movedPicture(text, picture.line, picture.after + 1)) }} />
              <Button size="sm" variant="ghost" onClick={() => { setPlacing(picture) }}>{t('移到…', 'Move to…')}</Button>
              <Button size="sm" variant="ghost" icon="x" title={t('从正文里取下（图还在图库里）', 'Take it out of the text (it stays in the gallery)')} onClick={() => { onText(withoutPicture(text, picture.line)) }} />
            </span>
          </div>
        </div>
      ))}
      {viewing !== undefined ? <PictureViewer path={viewing} title={t('正文里的图', 'A picture in the text')} onClose={() => { setViewing(undefined) }} /> : null}
      {picking ? (
        <PickPicture
          chapter={chapter}
          onClose={() => { setPicking(false) }}
          onPick={(image) => {
            setPicking(false)
            onText(withPicture(text, { path: image.path, alt: captionOf(image) }, caret()))
          }}
        />
      ) : null}
      {placing !== undefined ? (
        <Modal title={t('移到哪一段之后', 'After which line')} onClose={() => { setPlacing(undefined) }}>
          <ol className="nv-place-list">
            <li><button type="button" className={cx('nv-place-gap', placing.after === 0 && 'is-chosen')} onClick={() => { onText(movedPicture(text, placing.line, 0)); setPlacing(undefined) }}>{t('最前面', 'At the top')}</button></li>
            {prose.map((line, index) => (
              <li key={index}>
                <button type="button" className={cx('nv-place-row', placing.after === index + 1 && 'is-chosen')} onClick={() => { onText(movedPicture(text, placing.line, index + 1)); setPlacing(undefined) }} title={t('移到这一段之后', 'Move to after this line')}>
                  <span className="nv-place-index">{index + 1}</span>
                  <span className="nv-place-text">{clip(line, 64)}</span>
                </button>
              </li>
            ))}
          </ol>
        </Modal>
      ) : null}
    </div>
  )
}

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
import { useMemo, useState } from 'react'
import { embeddedPictures, movedPicture, proseLines, withoutPicture, withPicture, type EmbeddedPicture } from '../shared/embedded'
import { clip } from '../shared/text'
import { PictureViewer } from './PictureRecord'
import { PickPicture } from './PlacePicture'
import { Button, cx, Modal, ProjectImage, useT } from './ui'

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
  // The picture being given another place, while the author says which.
  const [placing, setPlacing] = useState<EmbeddedPicture | undefined>()
  const where = (picture: EmbeddedPicture): string => (picture.after === 0 ? t('在最前面', 'At the top') : t(`第 ${picture.after} 段后：${clip(picture.follows ?? '', 22)}`, `After line ${picture.after}: ${clip(picture.follows ?? '', 30)}`))
  return (
    <div className="nv-panel-section nv-text-pictures">
      <div className="nv-row-wrap">
        <Button size="sm" icon="plus" onClick={() => { setPicking(true) }} title={t('从这本书已有的图里选一张，插到光标所在的那一段之后', 'Choose one of the book\'s pictures; it goes after the line the caret is in')}>{t('从图库插入…', 'From the gallery…')}</Button>
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
            onText(withPicture(text, { path: image.path, alt: [...image.prompt.replace(/\s+/g, ' ')].slice(0, 40).join('') }, caret()))
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

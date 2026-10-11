// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture of a passage.
 *
 * The author marks a passage of a chapter — on the page they write on, or the
 * one they read on — and has it drawn. The director settles the picture
 * first: whom the passage means, where it is set, what they wear there, which
 * things of the bible are in it; then it is drawn against their sheets and
 * the art of the place. Here the author says a word of what they want of it,
 * if they want anything, and whether the picture goes into the text.
 */
import { useState } from 'react'
import { Button, Modal, TextArea, useT } from './ui'

/** What the director settled of a passage's picture, as the job that drew it says it. */
interface Framed { people?: string[]; place?: string; things?: string[]; why?: string }

/** The director's framing in a line, for whoever asked for the picture. */
export function framedWord(framed: Framed | undefined, t: (zh: string, en: string) => string): string {
  if (framed === undefined) return ''
  const people = framed.people ?? []
  const things = framed.things ?? []
  const parts = [
    people.length > 0 ? t(`画里有${people.join('、')}`, `in it: ${people.join(', ')}`) : t('画里没有立了卡的人', 'nobody with a card is in it'),
    ...(framed.place !== undefined ? [t(`在${framed.place}`, `at ${framed.place}`)] : []),
    ...(things.length > 0 ? [t(`有${things.join('、')}`, `with ${things.join(', ')}`)] : []),
  ]
  return `${parts.join(t('，', '; '))}${framed.why !== undefined && framed.why.length > 0 ? t(`。导演：${framed.why}`, `. The director: ${framed.why}`) : ''}`
}

/** What the job that drew a passage's picture says the director settled of it. */
export function framedOf(job: { result?: Record<string, unknown> } | undefined): Framed | undefined {
  return (job?.result?.framed ?? (job?.result?.output as { framed?: Framed } | undefined)?.framed) as Framed | undefined
}

/**
 * Asks what the author wants of the picture of a passage, and whether it goes into the text; the page that shows the
 * passage draws it.
 * @param chapter - the chapter the passage is of.
 * @param quote - the passage, as marked.
 * @param onDraw - draw it: with what the author asked of it (nothing, where they asked nothing), into the text or not.
 */
export function PassagePictureDialog({ chapter, quote, onDraw, onClose }: { chapter: { index: number }; quote: string; onDraw: (asked: { ask?: string; insert: boolean }) => void; onClose: () => void }) {
  const t = useT()
  const [ask, setAsk] = useState('')
  const [insert, setInsert] = useState(true)
  return (
    <Modal
      title={t(`照这一段画一张 · 第 ${chapter.index} 章`, `A picture of this passage · chapter ${chapter.index}`)}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
          <Button variant="primary" icon="image" onClick={() => { onDraw({ ...(ask.trim().length > 0 ? { ask: ask.trim() } : {}), insert }) }}>{t('画这一段', 'Draw it')}</Button>
        </>
      )}
    >
      <blockquote className="nv-passage-quote">{quote.length > 280 ? `${quote.slice(0, 280)}…` : quote}</blockquote>
      <TextArea autoFocus value={ask} minRows={2} maxRows={6} placeholder={t('想要什么，可不填：远景；只画她的手和那封信；黄昏的光', 'What you want of it, if anything: a wide shot; her hands and the letter only; evening light')} onChange={(event) => { setAsk(event.target.value) }} />
      <label className="nv-check">
        <input type="checkbox" checked={insert} onChange={(event) => { setInsert(event.target.checked) }} />
        <span>{t('画好后放在这一段后面', 'Place it after the passage when it is drawn')}</span>
      </label>
      <p className="nv-muted nv-small">{t('导演先认出这一段里的人、地方和物件，再照他们的人设图和设定图画。', 'The director first tells who, where and what the passage shows; then it is drawn against their sheets and the art of the place.')}</p>
    </Modal>
  )
}

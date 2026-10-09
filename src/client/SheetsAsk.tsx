// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The question before a picture: "this will first draw N design sheets".
 *
 * A picture of somebody who comes back in the book and has no design sheet
 * draws that sheet first — one more image call each. That is asked, not just
 * said afterwards: whoever starts a drawing — a portrait, a passage, a
 * chapter's panels, a cover, a batch — goes through `before`, which finds out
 * whose sheets would be drawn and, where there are any, puts the question:
 * draw them first, not this time, or not at all. Where no sheet is needed
 * nothing is asked.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { SheetsAsk } from '../shared/types'
import { Button, Modal, useProject, useStudio, useT } from './ui'

/** What the author answered: as it is given on to whatever draws. */
export interface SheetsChoice {
  /** `false`: this once, draw from what there is. Absent: the sheets come first. */
  sheetFirst?: false
}

interface Pending {
  people: { id: string; name: string }[]
  unknown: number
  /** The image service takes no reference pictures: what is drawn first is not sent with the picture. */
  unheld: boolean
  /** The portrait leads: the sheets are drawn after the portraits asked for, against them. */
  after: boolean
  /** A portrait of one person: the wording is about them, not about "whoever comes back". */
  portrait: boolean
  answer: (choice: 'first' | 'skip' | 'cancel') => void
}

export function useSheetsAsk(): {
  /**
   * Ask if need be, then go on.
   * @param asks - everything about to be drawn.
   * @param go - starts it; told what the author chose. Not called when they cancel.
   * @param covered - people whose sheets what is started draws as steps of its own (a batch that lists them): not asked about.
   */
  before: (asks: SheetsAsk[], go: (choice: SheetsChoice) => unknown, covered?: readonly string[]) => Promise<void>
  element: ReactNode
} {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [pending, setPending] = useState<Pending | undefined>()
  // The question open now: answered once, however the dialog is left.
  const open = useRef<Pending | undefined>(undefined)
  const answer = (choice: 'first' | 'skip' | 'cancel'): void => {
    const asked = open.current
    open.current = undefined
    setPending(undefined)
    asked?.answer(choice)
  }
  const before = useCallback(async (asks: SheetsAsk[], go: (choice: SheetsChoice) => unknown, covered: readonly string[] = []): Promise<void> => {
    let plan: { people: { id: string; name: string }[]; unknown: number; unheld?: boolean; after?: boolean } = { people: [], unknown: 0 }
    try {
      if (asks.length > 0) plan = await controller.api.call('image.sheetsFirst', { root, asks })
    } catch {
      // A Host that cannot say (an older one), or a picture that cannot be drawn at all: the drawing itself says what is wrong.
    }
    const people = plan.people.filter(person => !covered.includes(person.id))
    if (people.length === 0) {
      await go({})
      return
    }
    const choice = await new Promise<'first' | 'skip' | 'cancel'>((resolve) => {
      const asked: Pending = { people, unknown: plan.unknown, unheld: plan.unheld === true, after: plan.after === true, portrait: asks.length === 1 && asks[0]!.kind === 'portrait', answer: resolve }
      open.current = asked
      setPending(asked)
    })
    if (choice === 'cancel') return
    await go(choice === 'skip' ? { sheetFirst: false } : {})
  }, [controller, root])

  const names = pending?.people.map(person => `「${person.name}」`).join(t('、', ', ')) ?? ''
  const count = pending?.people.length ?? 0
  const element = pending !== undefined ? (
    <Modal title={pending.after ? t(`画完会照着立绘补 ${count} 张人设图`, `After it, ${count} design sheet${count === 1 ? '' : 's'} drawn against the portrait`) : t(`这次会先补 ${count} 张人设图`, `This will first draw ${count} design sheet${count === 1 ? '' : 's'}`)} onClose={() => { answer('cancel') }} footer={(
      <>
        <Button variant="ghost" onClick={() => { answer('cancel') }}>{t('取消', 'Cancel')}</Button>
        <Button variant="outline" onClick={() => { answer('skip') }} title={pending.after ? t('这次只画立绘', 'The portrait alone this once') : t('这次不补人设图，长相只照文字画', 'Skip the sheets this once: faces come from the words alone')}>{pending.after ? t('这次不补，只画立绘', 'Not this time') : t('这次不补，直接画', 'Not this time')}</Button>
        <Button variant="primary" onClick={() => { answer('first') }}>{pending.after ? t('画完就补', 'Draw it after') : t(`先补 ${count} 张，再画`, `Draw ${count === 1 ? 'it' : `the ${count}`} first`)}</Button>
      </>
    )}>
      <p className="nv-confirm-text">
        {pending.after
          ? t(`${names}还没有人设图。立绘只照文字画；画完照着它补人设图，多 ${count} 次绘图调用。`, `${names}: no design sheet yet. The portrait is drawn from the words alone; the sheet follows, against it — ${count} more image call(s).`)
          : pending.portrait
          ? t(`${names}还没有人设图，先画它，多 1 次绘图调用。`, `${names} has no design sheet: it is drawn first, one more image call.`)
          : t(`${names}还没有人设图，先各画一张，多 ${count} 次绘图调用。`, `${names}: no design sheet yet. One each is drawn first, ${count} more image call(s).`)}
      </p>
      {pending.unheld ? <p className="nv-picture-warn nv-small">{t('现在的绘图服务不收参考图：补了，这次的图也照不上它。', 'The image service in use takes no reference pictures: this picture would not be drawn against them.')}</p> : null}
      {pending.unknown > 0 ? <p className="nv-muted nv-small">{t(`另有 ${pending.unknown} 章还没编排分镜，要补谁到时才知道。`, `${pending.unknown} more chapter(s) have no storyboard yet; who they need is known then.`)}</p> : null}
      <p className="nv-muted nv-small">{t('谁先谁后、要不要问：设置 → 图像生成。', 'Which comes first, and whether to ask: Settings → Images.')}</p>
    </Modal>
  ) : null
  return { before, element }
}

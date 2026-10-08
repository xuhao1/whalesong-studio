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
    let plan: { people: { id: string; name: string }[]; unknown: number } = { people: [], unknown: 0 }
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
      const asked: Pending = { people, unknown: plan.unknown, portrait: asks.length === 1 && asks[0]!.kind === 'portrait', answer: resolve }
      open.current = asked
      setPending(asked)
    })
    if (choice === 'cancel') return
    await go(choice === 'skip' ? { sheetFirst: false } : {})
  }, [controller, root])

  const names = pending?.people.map(person => `「${person.name}」`).join(t('、', ', ')) ?? ''
  const count = pending?.people.length ?? 0
  const element = pending !== undefined ? (
    <Modal title={t(`这次会先补 ${count} 张人设图`, `This will first draw ${count} design sheet${count === 1 ? '' : 's'}`)} onClose={() => { answer('cancel') }} footer={(
      <>
        <Button variant="ghost" onClick={() => { answer('cancel') }}>{t('取消', 'Cancel')}</Button>
        <Button variant="outline" onClick={() => { answer('skip') }} title={t('这一次有什么照什么画：不补人设图，少几次绘图调用；这些人在这张图里的长相就只靠文字', 'This once, draw from what there is: no sheets, fewer image calls — and these people look the way the words alone make them')}>{t('这次不补，直接画', 'Not this time')}</Button>
        <Button variant="primary" onClick={() => { answer('first') }}>{t(`先补 ${count} 张，再画`, `Draw ${count === 1 ? 'it' : `the ${count}`} first`)}</Button>
      </>
    )}>
      <p className="nv-confirm-text">
        {pending.portrait
          ? t(`${names}还没有人设图。先画人设图，再照着它画立绘——多 1 次绘图调用。`, `${names} has no design sheet yet. The sheet is drawn first and the portrait against it — one more image call.`)
          : t(`${names}多次出场、还没有人设图。先给${count === 1 ? ' TA ' : '他们各'}画一张——多 ${count} 次绘图调用——这张图和以后的图里才是同一张脸。`, `${names} come${count === 1 ? 's' : ''} back in the book and ha${count === 1 ? 's' : 've'} no design sheet. One is drawn for each first — ${count} more image call${count === 1 ? '' : 's'} — so that this picture and every later one show the same face.`)}
      </p>
      {pending.unknown > 0 ? <p className="nv-muted nv-small">{t(`另有 ${pending.unknown} 章的分镜还没编排：编排好之后才知道那几章要不要补，到时任务条上会说。`, `${pending.unknown} more chapter${pending.unknown === 1 ? ' has' : 's have'} no storyboard yet: whether sheets are needed there is known once it is laid out, and the job bar says so then.`)}</p> : null}
      <p className="nv-muted nv-small">{t('想一直不问、也不补：设置 → 图像生成 → 取消"画人之前先补人设图"。', 'Never to be asked, and never to have them drawn: Settings → Images → untick "The design sheet first".')}</p>
    </Modal>
  ) : null
  return { before, element }
}

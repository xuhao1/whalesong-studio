// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The text of a chapter where it is written, with its pictures shown where they stand.
 *
 * The text is plain text, and a picture in it is one line of markup. Typed in one box, that line shows nothing of
 * the picture. So the text is laid out in turn ({@link textBlocks}): a stretch of prose is a text box as tall as its
 * words, and a picture's line is the picture — whatever the page puts there to look at it and to change it. What is
 * typed goes back into the one text, where it stood; the lines of markup are never typed over.
 *
 * To the page it is one text all the same: places in it are offsets into the whole, whichever box they fall in.
 * Behind each box the same words are laid out the same way — that is what makes the box as tall as they are, where a
 * passage that stays marked while the caret is elsewhere is shown (a text box shows its selection only while it has
 * the caret), and what says where on the screen an offset is.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { textBlocks, withProse, type PictureBlock, type ProseBlock } from '../shared/embedded'
import { cx } from './ui'

/** A stretch of the text, or — where both ends are the same — a place in it. */
export interface TextRange {
  start: number
  end: number
}

export interface ChapterTextHandle {
  /** What is selected in the text, or where the caret last was; nothing while it never was in the text. */
  selection: () => TextRange | undefined
  /**
   * Select a stretch and bring it into view — as far as it lies in the stretch of prose it begins in (a selection does
   * not run across a picture). A place in a picture's line shows the picture.
   * @param enter - put the caret there too (a text box shows its selection only then).
   */
  select: (start: number, end: number, enter?: boolean) => void
  /** Bring a place of the text into view: in a picture's line, the picture. */
  reveal: (offset: number) => void
  focus: () => void
}

/** Where on the screen the character at an offset of a laid-out stretch is; the stretch itself, where that cannot be told. */
function rectAt(ghost: HTMLElement, offset: number): DOMRect {
  const walker = document.createTreeWalker(ghost, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text)
  let left = offset
  for (const [index, node] of nodes.entries()) {
    const length = node.data.length
    if (left < length || index === nodes.length - 1) {
      const at = Math.min(left, Math.max(0, length - 1))
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, Math.min(length, at + 1))
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      if (rect.height > 0) return rect
      break
    }
    left -= length
  }
  return ghost.getBoundingClientRect()
}

export const ChapterText = forwardRef<ChapterTextHandle, {
  text: string
  onText: (next: string) => void
  placeholder?: string
  /** A passage to keep marked while the caret is not in the text. */
  marked?: TextRange | undefined
  /** The caret went into the text, or left it for something that is not the text. */
  onFocus?: () => void
  onBlur?: () => void
  /** What is selected now, or where the caret is. */
  onSelect?: (range: TextRange) => void
  /** A key pressed in the text, with what is selected: prevented, it does nothing here. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>, range: TextRange) => void
  /** What stands in the place of a picture's line. */
  picture: (block: PictureBlock) => ReactNode
}>(function ChapterText({ text, onText, placeholder, marked, onFocus, onBlur, onSelect, onKeyDown, picture }, handle) {
  const blocks = useMemo(() => textBlocks(text), [text])
  const scroller = useRef<HTMLDivElement>(null)
  const areas = useRef(new Map<number, HTMLTextAreaElement>())
  const ghosts = useRef(new Map<number, HTMLDivElement>())
  const figures = useRef(new Map<number, HTMLDivElement>())
  const last = useRef<TextRange | undefined>(undefined)

  /** The place in a stretch of prose, in the middle of what is seen. */
  const bring = (index: number, offset: number): void => {
    const box = scroller.current
    const ghost = ghosts.current.get(index)
    if (box === null || ghost === undefined) return
    const rect = rectAt(ghost, offset)
    box.scrollTop += rect.top - box.getBoundingClientRect().top - box.clientHeight / 2 + rect.height / 2
  }
  const show = (index: number): void => {
    const figure = figures.current.get(index)
    if (figure === undefined) return
    figure.scrollIntoView({ block: 'center' })
    figure.classList.add('is-shown')
    window.setTimeout(() => { figure.classList.remove('is-shown') }, 1400)
  }
  const told = (range: TextRange): void => {
    last.current = range
    onSelect?.(range)
  }
  const proseAt = (offset: number): number => blocks.findIndex(block => block.kind === 'prose' && offset >= block.start && offset <= block.end)
  const pictureAt = (offset: number): number => blocks.findIndex(block => block.kind === 'picture' && offset >= block.start && offset <= block.end)

  useImperativeHandle(handle, () => ({
    selection: () => last.current,
    select: (start, end, enter) => {
      const index = proseAt(start)
      if (index < 0) { show(pictureAt(start)); return }
      const block = blocks[index] as ProseBlock
      const area = areas.current.get(index)
      if (area === undefined) return
      const from = start - block.start
      const to = Math.max(from, Math.min(end, block.end) - block.start)
      bring(index, from)
      if (enter === true) area.focus({ preventScroll: true })
      area.setSelectionRange(from, to)
      told({ start, end: block.start + to })
    },
    reveal: (offset) => {
      const at = pictureAt(offset)
      // (Where two pictures stand on lines one after the other, the place between them is the second one's line.)
      if (at >= 0) { show(at); return }
      const index = proseAt(offset)
      if (index >= 0) bring(index, offset - blocks[index]!.start)
    },
    focus: () => {
      const index = last.current !== undefined ? proseAt(last.current.start) : -1
      ;(areas.current.get(index) ?? areas.current.get(0))?.focus()
    },
  }))

  /** The caret into another stretch of prose: its end, or its beginning. */
  const into = (index: number, end: boolean): boolean => {
    const area = areas.current.get(index)
    if (area === undefined) return false
    area.focus()
    const at = end ? area.value.length : 0
    area.setSelectionRange(at, at)
    return true
  }

  return (
    <div
      ref={scroller}
      className="nv-editor-blocks"
      onMouseDown={(event) => {
        // Below the last line: the caret goes to the end of the text.
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        into(blocks.length - 1, true)
      }}
    >
      {blocks.map((block, index) => {
        if (block.kind === 'picture') {
          return <div key={index} className="nv-editor-picture" ref={(element) => { if (element !== null) figures.current.set(index, element); else figures.current.delete(index) }}>{picture(block)}</div>
        }
        const words = text.slice(block.start, block.end)
        const from = marked !== undefined ? Math.min(Math.max(marked.start, block.start), block.end) - block.start : 0
        const to = marked !== undefined ? Math.min(Math.max(marked.end, block.start), block.end) - block.start : 0
        const range = (area: HTMLTextAreaElement): TextRange => ({ start: block.start + area.selectionStart, end: block.start + area.selectionEnd })
        return (
          <div key={index} className={cx('nv-editor-prose', block.gap !== undefined && 'is-gap')}>
            <div className="nv-editor-ghost" aria-hidden="true" ref={(element) => { if (element !== null) ghosts.current.set(index, element); else ghosts.current.delete(index) }}>
              {to > from ? <>{words.slice(0, from)}<mark>{words.slice(from, to)}</mark>{words.slice(to)}</> : words}{'​'}
            </div>
            <textarea
              ref={(element) => { if (element !== null) areas.current.set(index, element); else areas.current.delete(index) }}
              rows={1}
              spellCheck={false}
              value={words}
              {...(index === 0 && text.length === 0 && placeholder !== undefined ? { placeholder } : {})}
              onChange={(event) => { onText(withProse(text, block, event.target.value)) }}
              onFocus={() => { onFocus?.() }}
              onBlur={(event) => {
                // To another stretch of the same text: the caret is still in the text.
                const next = event.relatedTarget
                if (!(next instanceof HTMLTextAreaElement && scroller.current?.contains(next) === true)) onBlur?.()
              }}
              onSelect={(event) => { told(range(event.currentTarget)) }}
              onKeyDown={(event) => {
                const area = event.currentTarget
                onKeyDown?.(event, range(area))
                if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.nativeEvent.isComposing) return
                if (area.selectionStart !== area.selectionEnd) return
                // Past a picture with the arrow keys: from the first place of a stretch up into the one before, from the last down into the next.
                if ((event.key === 'ArrowUp' || event.key === 'ArrowLeft') && area.selectionStart === 0 && into(index - 2, true)) event.preventDefault()
                else if ((event.key === 'ArrowDown' || event.key === 'ArrowRight') && area.selectionStart === area.value.length && into(index + 2, false)) event.preventDefault()
              }}
            />
          </div>
        )
      })}
    </div>
  )
})

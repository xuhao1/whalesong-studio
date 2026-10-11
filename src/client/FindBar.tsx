// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Finding words in the chapter being written.
 *
 * The text is a plain text box; the host the Studio runs in may have no find
 * of its own for it (the desktop app has none). So the page has one: Cmd+F /
 * Ctrl+F opens it, with whatever is selected in it; each match is selected in
 * the text and brought into view; Enter goes on, Shift+Enter back, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, useT } from './ui'

/** Where a word stands in a text, every time: case ignored. */
export function findAll(text: string, needle: string): number[] {
  if (needle.length === 0) return []
  const found: number[] = []
  const hay = text.toLowerCase()
  const wanted = needle.toLowerCase()
  for (let at = hay.indexOf(wanted); at >= 0; at = hay.indexOf(wanted, at + Math.max(1, wanted.length))) found.push(at)
  return found
}

/**
 * @param text - the text searched.
 * @param start - what to look for to begin with: what was selected when it was opened.
 * @param from - where the caret was: the first match shown is the first at or after it.
 * @param onShow - show a match: bring it into view — and, `enter`ed, select it in the text with the caret there (the
 *   text box shows a selection only while it has the caret; while the words are still being typed, it stays here).
 * @param control - set to the way to go on from outside: the page goes to the next match on Cmd+G, and on Enter
 *   while the match it showed is still what is selected in the text.
 */
export function FindBar({ text, start, from, onShow, onClose, control }: { text: string; start: string; from: number; onShow: (at: number, length: number, enter: boolean) => void; onClose: () => void; control: { current: { go: (step: number) => void; focus: () => void } | null } }) {
  const t = useT()
  const [needle, setNeedle] = useState(start)
  const found = useMemo(() => findAll(text, needle), [text, needle])
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  // What is looked for changed: the first match at or after where the author was.
  useEffect(() => {
    if (found.length === 0) return
    const first = Math.max(0, found.findIndex(offset => offset >= from))
    setAt(first)
    onShow(found[first]!, needle.length, false)
    // The matches are of the words looked for: shown anew when those change, not as the text is edited behind them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle])
  // The match shown while the words were typed is the one entered first; after that, each step goes on by one.
  const entered = useRef(false)
  useEffect(() => { entered.current = false }, [needle])
  const go = (step: number): void => {
    if (found.length === 0) return
    const next = entered.current ? (at + step + found.length) % found.length : at
    entered.current = true
    setAt(next)
    onShow(found[next]!, needle.length, true)
  }
  control.current = { go, focus: () => { input.current?.focus(); input.current?.select() } }
  useEffect(() => () => { control.current = null }, [control])
  return (
    <div className="nv-find" role="search">
      <input
        ref={input}
        className="nv-find-input"
        value={needle}
        placeholder={t('在这一章里找', 'Find in this chapter')}
        onChange={(event) => { setNeedle(event.target.value) }}
        onKeyDown={(event) => {
          // (An IME confirming a word with Enter is not asking to go on.)
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            go(event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
      />
      <span className="nv-muted nv-small nv-find-count" title={t('回车：选中这一处；再按回车到下一处，Shift+回车到上一处', 'Enter selects this match; Enter again goes on, Shift+Enter back')}>{needle.length === 0 ? '' : found.length === 0 ? t('没有', 'none') : `${at + 1} / ${found.length}`}</span>
      <Button size="sm" variant="ghost" icon="chevronUp" disabled={found.length === 0} title={t('上一处（Shift+回车）', 'Previous (Shift+Enter)')} onClick={() => { go(-1) }} />
      <Button size="sm" variant="ghost" icon="chevronDown" disabled={found.length === 0} title={t('下一处（回车）', 'Next (Enter)')} onClick={() => { go(1) }} />
      <Button size="sm" variant="ghost" icon="x" title={t('关闭（Esc）', 'Close (Esc)')} onClick={onClose} />
    </div>
  )
}

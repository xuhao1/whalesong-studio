// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Full screen for what is read, listened to and watched.
 *
 * A frame around the viewer goes to the whole screen and takes the viewer with
 * it — the page, the script, the motion comic, the album — as a reader has
 * them: nothing of the workshop around it. The frame is the same element
 * whichever half of the viewer is shown, so changing from the text to the
 * people does not drop out of full screen.
 *
 * The screen is asked for (the Fullscreen API). Where the page may not have it
 * — no such API, or the request is refused — the frame fills the window
 * instead, and Escape leaves it as it leaves the real thing.
 *
 * While the pointer rests, the bar at the top fades and the pointer with it;
 * they are back the moment it moves.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { Translate } from './parts'

const cx = (...parts: (string | false | undefined | null)[]): string => parts.filter(Boolean).join(' ')

export interface Full {
  /** The viewer has the screen (or, failing that, the window). */
  on: boolean
  toggle: () => void
}

const FullContext = createContext<Full | undefined>(undefined)

/** Whether the viewer is in full screen, and the way in and out; undefined outside a {@link FullFrame}. */
export function useFull(): Full | undefined {
  return useContext(FullContext)
}

/** How long the pointer rests before the bar goes. */
const REST_MS = 2600

const typing = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return element !== null && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable)
}

/**
 * The frame that goes full screen.
 * @param provide - wraps the children with whatever has to know where overlays go while full: a dialog rendered
 *   outside the frame is not on a screen the frame has to itself. Called on every render, full or not, with the place
 *   for them inside the frame while full.
 */
export function FullFrame({ children, provide }: { children: ReactNode; provide?: (within: HTMLElement | null, children: ReactNode) => ReactNode }) {
  const frame = useRef<HTMLDivElement>(null)
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  // `screen`: the Fullscreen API has it. `window`: it fills the window, the next best.
  const [mode, setMode] = useState<'screen' | 'window' | undefined>()
  const on = mode !== undefined

  // When the screen was asked for: a host that grants it and takes it back at once (an embedded page may) has not
  // been left by the reader — the window is filled instead.
  const asked = useRef(0)
  const toggle = useCallback((): void => {
    const element = frame.current
    if (element === null) return
    if (mode !== undefined) {
      if (document.fullscreenElement !== null && element.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {})
      setMode(undefined)
      return
    }
    // Decided once: the screen if the page gets it, else the window — also where the request neither comes through
    // nor is refused.
    let settled = false
    const settle = (next: 'screen' | 'window'): void => {
      if (settled) return
      settled = true
      setMode(next)
    }
    asked.current = Date.now()
    if (typeof element.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
      try {
        element.requestFullscreen().then(() => { settle(document.fullscreenElement === element ? 'screen' : 'window') }, () => { settle('window') })
      } catch {
        settle('window')
      }
      setTimeout(() => { settle(document.fullscreenElement === element ? 'screen' : 'window') }, 450)
    } else settle('window')
  }, [mode])

  // Left by the browser's own means — Escape, a gesture: the frame follows. Something inside it taking the screen
  // (the motion comic's stage) is still the frame being full.
  useEffect(() => {
    const changed = (): void => {
      const holder = document.fullscreenElement
      if (holder !== null && frame.current?.contains(holder) === true) return
      // Taken back within a moment of being given: not the reader's doing.
      const bounced = Date.now() - asked.current < 700
      setMode(current => (current === 'screen' ? (bounced ? 'window' : undefined) : current))
    }
    document.addEventListener('fullscreenchange', changed)
    return () => { document.removeEventListener('fullscreenchange', changed) }
  }, [])

  // F goes in and out, as on a film; Escape leaves the window-filling kind (the browser sees to the other).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return
      const element = frame.current
      // Only while the viewer is what is on the page. (Not `offsetParent`: filling the window it is fixed, and has none.)
      if (element === null || element.getClientRects().length === 0) return
      if (event.key === 'f' || event.key === 'F') toggle()
      else if (event.key === 'Escape' && mode === 'window') setMode(undefined)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [mode, toggle])

  // Gone from the page while full: the screen is given back.
  useEffect(() => () => {
    const element = frame.current
    if (document.fullscreenElement !== null && element !== null && (element === document.fullscreenElement || element.contains(document.fullscreenElement))) void document.exitFullscreen().catch(() => {})
  }, [])

  // The pointer at rest.
  const [rested, setRested] = useState(false)
  useEffect(() => {
    if (!on) {
      setRested(false)
      return
    }
    const element = frame.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const stir = (): void => {
      setRested(false)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        // A button pressed a while ago is not being used: it is let go of, so that the bar it is in can fade. (A list
        // that is open, a field being typed in, keep it.)
        const held = document.activeElement
        if (held instanceof HTMLElement && held.tagName === 'BUTTON' && element?.contains(held) === true) held.blur()
        setRested(true)
      }, REST_MS)
    }
    stir()
    for (const name of ['mousemove', 'mousedown', 'touchstart', 'keydown'] as const) element?.addEventListener(name, stir, { passive: true })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      for (const name of ['mousemove', 'mousedown', 'touchstart', 'keydown'] as const) element?.removeEventListener(name, stir)
    }
  }, [on])

  const inner = provide !== undefined ? provide(on ? layer : null, children) : children
  return (
    <FullContext.Provider value={{ on, toggle }}>
      <div ref={frame} className={cx('nv-full', on && 'is-full', mode === 'window' && 'is-window', on && rested && 'is-rested')}>
        {inner}
        <div ref={setLayer} className="nv-full-layer" />
      </div>
    </FullContext.Provider>
  )
}

/** The way into full screen and out of it, for the viewer's bar. Nothing outside a {@link FullFrame}. */
export function FullButton({ t }: { t: Translate }) {
  const full = useFull()
  if (full === undefined) return null
  return (
    <button type="button" className={cx('nv-btn nv-btn-ghost nv-btn-sm nv-btn-icon nv-full-button', full.on && 'is-active')} onClick={full.toggle} title={full.on ? t('退出全屏（Esc）', 'Leave full screen (Esc)') : t('全屏（F）', 'Full screen (F)')} aria-label={full.on ? t('退出全屏', 'Leave full screen') : t('全屏', 'Full screen')}>
      <Icon name={full.on ? 'minimize' : 'maximize'} size={15} />
    </button>
  )
}

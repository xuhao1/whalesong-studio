// SPDX-License-Identifier: LGPL-3.0-or-later
/** Studio context, hooks and the small set of controls every view shares. */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode, type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { linePath } from '../shared/lines'
import { MAIN_LINE, type ChapterInfo, type JobInfo, type ProjectState } from '../shared/types'
import { messageOf, type NovelApi } from './api'
import { Icon, type IconName } from './icons'
import type { StudioController, StudioSnapshot } from './store'

// ───────────────────────────── context ─────────────────────────────

/** Picks the string for the active UI language. */
export type Translate = (zh: string, en: string) => string

export interface StudioHost {
  /** Put text into the conversation composer of this Studio's session. @returns whether it landed. */
  quoteToChat?: (text: string) => boolean
  /** Whether the session's agent is busy. */
  agentBusy?: boolean
  /** The global page, or a tab beside a conversation. */
  where: 'page' | 'tab'
  /** Tab only: whether the sidebar is in its full-screen mode, and the sidebar's own switch for it. */
  maximized?: boolean
  toggleMaximize?: () => void
  /** Page only: open a new conversation (in the given workspace) to work with the showrunner. */
  startChat?: (workspace?: { id?: string | undefined; path: string }) => void
  /** Page only: show a conversation that exists — a book's own — in the main area, the Studio beside it. */
  openChat?: (sessionId: string) => void
  /** Have the Harness read its list of conversations again: locking a sealed book takes its conversations out of that list, unlocking puts them back. */
  refreshSessions?: () => void
  /** Let the author choose a folder with the Harness's own chooser; resolves null when they cancel. */
  pickDirectory?: () => Promise<string | null>
  /** Open the conversation of a role's run: a child agent of the conversation it is listed under. */
  openRun?: (run: { session: string; parent: string }) => void
}

interface StudioContextValue {
  controller: StudioController
  api: NovelApi
  t: Translate
  locale: string
  host: StudioHost
}

const StudioContext = createContext<StudioContextValue | undefined>(undefined)

export function StudioProvider({ value, children }: { value: StudioContextValue; children: ReactNode }) {
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>
}

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext)
  if (value === undefined) throw new Error('Studio context is missing')
  return value
}

export function useT(): Translate {
  return useStudio().t
}

/** Hand text to the conversation beside this Studio; undefined when there is none (the global page). */
export function useQuote(): ((text: string) => void) | undefined {
  const { host, controller, t } = useStudio()
  const send = host.quoteToChat
  return useMemo(() => (send === undefined ? undefined : (text: string) => {
    const landed = send(text)
    controller.toast(landed ? 'success' : 'error', landed ? t('已放进对话输入框', 'Added to the chat composer') : t('没能写入对话输入框（它可能正在发送）', 'Could not write to the chat composer (it may be sending)'))
  }), [send, controller, t])
}

/** Subscribe to a slice of the Studio snapshot. */
export function useSnapshot<T>(select: (snapshot: StudioSnapshot) => T): T {
  const { controller } = useStudio()
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return select(snapshot)
}

/** The open project; views that render only with a project use this. */
export function useProject() {
  const project = useSnapshot(snapshot => snapshot.project)
  const root = useSnapshot(snapshot => snapshot.root)
  if (project === undefined || root === undefined) throw new Error('no project is open')
  return { project, root }
}

/** Fetch something keyed by `deps`, refetching when they change. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void; set: (value: T) => void } {
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined; loading: boolean }>({ data: undefined, error: undefined, loading: true })
  const [nonce, setNonce] = useState(0)
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    const controller = new AbortController()
    setState(previous => ({ ...previous, loading: true, error: undefined }))
    loader.current(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ data, error: undefined, loading: false }) },
      (error: unknown) => { if (!controller.signal.aborted) setState(previous => ({ data: previous.data, error: messageOf(error), loading: false })) },
    )
    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])
  const reload = useCallback(() => { setNonce(value => value + 1) }, [])
  const set = useCallback((value: T) => { setState({ data: value, error: undefined, loading: false }) }, [])
  return { ...state, reload, set }
}

/** Track one async action: `busy` while it runs; failures become toasts. */
export function useAction(): { busy: boolean; run: <T>(action: () => Promise<T>) => Promise<T | undefined> } {
  const { controller } = useStudio()
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    try {
      return await controller.guard(action)
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [controller])
  return { busy, run }
}

/**
 * The running job that matches, if there is one. A button whose work is a job
 * goes by this as well as by its own click, so it still shows the work going
 * on after the author left the screen and came back.
 */
export function useRunningJob(match: (job: JobInfo) => boolean): JobInfo | undefined {
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  return jobs.find(job => job.status === 'running' && match(job))
}

export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ───────────────────────────── controls ─────────────────────────────

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  variant?: 'primary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: IconName
  busy?: boolean
  /** What the button says while its work runs ("正在生成语音…"); its own label stays when left out. */
  pending?: string | undefined
  /**
   * A handler that returns a promise keeps the button busy until it settles:
   * whoever pressed it sees at once that the press was taken, and cannot press
   * it twice.
   */
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => unknown
}

export function Button({ variant = 'outline', size = 'md', icon, busy, pending, children, className, disabled, onClick, title, ...rest }: ButtonProps) {
  const [running, setRunning] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const working = busy === true || running
  const press = onClick === undefined ? undefined : (event: ReactMouseEvent<HTMLButtonElement>): void => {
    const outcome = onClick(event)
    if (outcome === null || typeof outcome !== 'object' || typeof (outcome as PromiseLike<unknown>).then !== 'function') return
    setRunning(true)
    const done = (): void => { if (alive.current) setRunning(false) }
    void (outcome as PromiseLike<unknown>).then(done, done)
  }
  const label = working && pending !== undefined ? pending : children
  return (
    <button
      type="button"
      {...rest}
      title={working && pending !== undefined && children === undefined ? pending : title}
      aria-busy={working || undefined}
      disabled={disabled === true || working}
      onClick={press}
      className={cx('nv-btn', `nv-btn-${variant}`, size === 'sm' && 'nv-btn-sm', children === undefined && 'nv-btn-icon', working && 'is-busy', className)}
    >
      {working ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon !== undefined ? <Icon name={icon} size={size === 'sm' ? 14 : 15} /> : null}
      {label !== undefined ? <span>{label}</span> : null}
    </button>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="nv-spinner" style={{ width: size, height: size }} aria-hidden="true" />
}

export function Field({ label, hint, children, row }: { label: string; hint?: string | undefined; children: ReactNode; row?: boolean }) {
  return (
    <label className={cx('nv-field', row === true && 'nv-field-row')}>
      <span className="nv-field-label">{label}</span>
      <span className="nv-field-control">{children}</span>
      {hint !== undefined ? <span className="nv-field-hint">{hint}</span> : null}
    </label>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx('nv-input', className)} />
}

/** A textarea that grows with its content up to `maxRows`. */
export function TextArea({ className, minRows = 2, maxRows = 14, value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const fit = (): void => {
      // Nothing can be measured while the Studio is hidden (a background sidebar tab).
      if (element.clientWidth === 0) return
      element.style.height = 'auto'
      const line = parseFloat(getComputedStyle(element).lineHeight) || 20
      element.style.height = `${Math.min(maxRows * line + 14, Math.max(minRows * line + 14, element.scrollHeight + 2))}px`
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    // Wrapping changes with the width, and with it the height the text needs.
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      fit()
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [value, minRows, maxRows])
  return <textarea {...rest} ref={ref} value={value} className={cx('nv-input nv-textarea', className)} />
}

export function Select<T extends string>({ value, options, onChange, className, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; className?: string; disabled?: boolean }) {
  return (
    <select className={cx('nv-input nv-select', className)} value={value} disabled={disabled} onChange={(event) => { onChange(event.target.value as T) }}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

export interface ComboOption {
  value: string
  /** Shown instead of the value when the two differ (a model's display name). */
  label?: string
  /** A few words after the value: what kind of thing this is, or why it cannot be chosen. */
  note?: string
  disabled?: boolean
  /** Options of one group sit together under this heading. */
  group?: string
}

/**
 * A text field with a list to choose from. Anything may be typed — the list is
 * a help, not a limit — and opening the list always shows all of it: what is
 * already in the field must not hide the alternatives. Typing narrows it.
 */
export function Combo({ value, options, onChange, onPick, onOpen, placeholder, disabled, className, openSignal, empty }: {
  value: string
  options: ComboOption[]
  onChange: (value: string) => void
  /** An option was chosen from the list (after `onChange`). */
  onPick?: (option: ComboOption) => void
  /** The list is about to show: the moment to fetch what it should hold. */
  onOpen?: () => void
  placeholder?: string | undefined
  disabled?: boolean | undefined
  className?: string | undefined
  /** Changing this number opens the list (a reload that found something to show). */
  openSignal?: number | undefined
  /** Shown in the open list when there is nothing to choose from. */
  empty?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  // What was typed since the list opened; `undefined` shows everything.
  const [query, setQuery] = useState<string | undefined>(undefined)
  const [cursor, setCursor] = useState(-1)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const notifyOpen = useRef(onOpen)
  notifyOpen.current = onOpen
  const show = useCallback((): void => {
    setQuery(undefined)
    setCursor(-1)
    setOpen((was) => {
      if (!was) notifyOpen.current?.()
      return true
    })
  }, [])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (openSignal !== undefined) show()
  }, [openSignal, show])
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])
  const needle = query?.trim().toLowerCase() ?? ''
  const shown = needle.length === 0 ? options : options.filter(option => option.value.toLowerCase().includes(needle) || (option.label ?? '').toLowerCase().includes(needle))
  // The list is as wide as its longest entry, which can be wider than the field: it opens toward whichever side has the room.
  const [toEnd, setToEnd] = useState(false)
  useLayoutEffect(() => {
    if (!open || root.current === null || list.current === null) return
    const field = root.current.getBoundingClientRect()
    const frame = (root.current.closest('[data-novel-studio]') ?? document.documentElement).getBoundingClientRect()
    setToEnd(field.left + list.current.offsetWidth > frame.right - 12 && field.right - list.current.offsetWidth >= frame.left)
    // The chosen option comes into view when the list opens.
    list.current.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' })
  }, [open, shown.length])
  const pick = (option: ComboOption): void => {
    if (option.disabled === true) return
    onChange(option.value)
    onPick?.(option)
    setOpen(false)
  }
  const move = (step: number): void => {
    if (shown.length === 0) return
    let next = cursor
    for (let tries = 0; tries < shown.length; tries += 1) {
      next = (next + step + shown.length) % shown.length
      if (shown[next]?.disabled !== true) break
    }
    setCursor(next)
    list.current?.children[next]?.scrollIntoView({ block: 'nearest' })
  }
  let group: string | undefined
  return (
    <div className={cx('nv-combo', className)} ref={root}>
      <input
        className="nv-input"
        value={value}
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={show}
        onClick={() => { if (!open) show() }}
        onChange={(event) => {
          onChange(event.target.value.trim())
          setQuery(event.target.value)
          setCursor(-1)
          if (!open) {
            notifyOpen.current?.()
            setOpen(true)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) show()
            else move(event.key === 'ArrowDown' ? 1 : -1)
          } else if (event.key === 'Enter' && open && cursor >= 0 && shown[cursor] !== undefined) {
            event.preventDefault()
            pick(shown[cursor])
          } else if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          }
        }}
      />
      <button type="button" className="nv-combo-toggle" tabIndex={-1} disabled={disabled} aria-label="toggle" onMouseDown={(event) => { event.preventDefault() }} onClick={() => { if (open) setOpen(false); else show() }}>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
      </button>
      {open ? (
        <div className={cx('nv-combo-list', toEnd && 'is-end')} role="listbox" ref={list}>
          {shown.length === 0 ? <div className="nv-combo-empty">{empty ?? '—'}</div> : shown.map((option, index) => {
            const heading = option.group !== group ? option.group : undefined
            group = option.group
            return (
              <div key={option.value} className="nv-combo-row">
                {heading !== undefined ? <div className="nv-combo-group">{heading}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  className={cx('nv-combo-item', option.value === value && 'is-current', index === cursor && 'is-cursor')}
                  // Keeps the caret in the field while the list is used.
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { pick(option) }}
                >
                  <span className="nv-combo-check">{option.value === value ? <Icon name="check" size={13} /> : null}</span>
                  <span className="nv-combo-value">{option.value}</span>
                  {option.label !== undefined && option.label !== option.value ? <span className="nv-combo-label">{option.label}</span> : null}
                  {option.note !== undefined ? <span className="nv-combo-note">{option.note}</span> : null}
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function Tabs<T extends string>({ value, tabs, onChange, className }: { value: T; tabs: { value: T; label: string; icon?: IconName; badge?: number | undefined }[]; onChange: (value: T) => void; className?: string }) {
  return (
    <div className={cx('nv-tabs', className)} role="tablist">
      {tabs.map(tab => (
        <button key={tab.value} type="button" role="tab" aria-selected={tab.value === value} className={cx('nv-tab', tab.value === value && 'is-active')} onClick={() => { onChange(tab.value) }}>
          {tab.icon !== undefined ? <Icon name={tab.icon} size={14} /> : null}
          <span>{tab.label}</span>
          {tab.badge !== undefined && tab.badge > 0 ? <span className="nv-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function Chip({ children, tone = 'neutral', title, onClick, active }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'amber' | 'green' | 'red' | 'violet'; title?: string; onClick?: () => void; active?: boolean }) {
  const className = cx('nv-chip', `nv-chip-${tone}`, active === true && 'is-active', onClick !== undefined && 'is-clickable')
  if (onClick !== undefined) return <button type="button" className={className} title={title} onClick={onClick}>{children}</button>
  return <span className={className} title={title}>{children}</span>
}

export function Empty({ icon, title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="nv-empty">
      {icon !== undefined ? <Icon name={icon} size={28} className="nv-empty-icon" /> : null}
      <div className="nv-empty-title">{title}</div>
      {children !== undefined ? <div className="nv-empty-body">{children}</div> : null}
    </div>
  )
}

export function Progress({ done, total, label }: { done: number; total: number; label?: string | undefined }) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0
  return (
    <div className="nv-progress" title={label}>
      <div className="nv-progress-track"><div className={cx('nv-progress-bar', total <= 0 && 'is-indeterminate')} style={{ width: total > 0 ? `${ratio * 100}%` : undefined }} /></div>
      {label !== undefined ? <span className="nv-progress-label">{label}</span> : null}
    </div>
  )
}

/**
 * Where overlays mount: the nearest Studio root, so they inherit its theme
 * variables and stay inside the panel the Studio lives in.
 */
const OverlayRootContext = createContext<HTMLElement | null>(null)
export const OverlayRootProvider = OverlayRootContext.Provider
/** Where dialogs are put now: to hand on, or to stand in for (a frame that has the screen to itself puts them inside it). */
export const useOverlayRoot = (): HTMLElement | null => useContext(OverlayRootContext)

export function Modal({ title, onClose, children, footer, wide, className }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string | undefined }) {
  const root = useContext(OverlayRootContext)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [onClose])
  const node = (
    <div className="nv-modal-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={cx('nv-modal', wide === true && 'nv-modal-wide', className)} role="dialog" aria-modal="true" aria-label={title}>
        <header className="nv-modal-head">
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="close" />
        </header>
        <div className="nv-modal-body">{children}</div>
        {footer !== undefined ? <footer className="nv-modal-foot">{footer}</footer> : null}
      </div>
    </div>
  )
  return root !== null ? createPortal(node, root) : node
}

/** A button that opens a small anchored menu. */
export function Menu({ label, icon, items, variant = 'ghost', size = 'sm', align = 'start' }: {
  label?: string
  icon?: IconName
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  align?: 'start' | 'end'
  items: ({ label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'separator')[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="nv-menu" ref={ref}>
      <Button variant={variant} size={size} icon={icon} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>{label}</Button>
      {open ? (
        <div className={cx('nv-menu-list', align === 'end' && 'is-end')} role="menu">
          {items.map((item, index) => item === 'separator'
            ? <div key={index} className="nv-menu-sep" />
            : (
                <button key={index} type="button" role="menuitem" disabled={item.disabled} className={cx('nv-menu-item', item.danger === true && 'is-danger')} onClick={() => { setOpen(false); item.onSelect() }}>
                  {item.icon !== undefined ? <Icon name={item.icon} size={14} /> : null}
                  <span>{item.label}</span>
                </button>
              ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A small anchored card with free content: what something means, and the few
 * things that can be done about it. For anything a tooltip would hide.
 */
export function Popover({ trigger, children, align = 'start', className }: {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'start' | 'end'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const close = useCallback(() => { setOpen(false) }, [])
  return (
    <div className="nv-menu" ref={ref}>
      {trigger({ open, toggle: () => { setOpen(value => !value) } })}
      {open ? <div className={cx('nv-popover', align === 'end' && 'is-end', className)} role="dialog">{typeof children === 'function' ? children(close) : children}</div> : null}
    </div>
  )
}

export function Toasts() {
  const { controller } = useStudio()
  const toasts = useSnapshot(snapshot => snapshot.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="nv-toasts" role="status">
      {toasts.map(toast => (
        <div key={toast.id} className={cx('nv-toast', `is-${toast.kind}`)}>
          <Icon name={toast.kind === 'error' ? 'alert' : toast.kind === 'success' ? 'checkCircle' : 'info'} size={15} />
          <span>{toast.text}</span>
          <button type="button" className="nv-toast-close" onClick={() => { controller.dismissToast(toast.id) }} aria-label="dismiss"><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  )
}

/** Ask for confirmation of a destructive action. */
export function useConfirm(): { ask: (message: string, onYes: () => void) => void; element: ReactNode } {
  const t = useT()
  const [pending, setPending] = useState<{ message: string; onYes: () => void } | undefined>()
  const ask = useCallback((message: string, onYes: () => void) => { setPending({ message, onYes }) }, [])
  const element = pending !== undefined ? (
    <Modal title={t('确认', 'Confirm')} onClose={() => { setPending(undefined) }} footer={(
      <>
        <Button variant="ghost" onClick={() => { setPending(undefined) }}>{t('取消', 'Cancel')}</Button>
        <Button variant="danger" onClick={() => { const action = pending.onYes; setPending(undefined); action() }}>{t('确定', 'Confirm')}</Button>
      </>
    )}>
      <p className="nv-confirm-text">{pending.message}</p>
    </Modal>
  ) : null
  return { ask, element }
}

/** A project image by its project-relative path. */
export function ProjectImage({ path, alt, className, style, version }: { path: string; alt?: string; className?: string; style?: CSSProperties; version?: string | number }) {
  const { api } = useStudio()
  const projectId = useSnapshot(snapshot => snapshot.project?.manifest.id)
  if (projectId === undefined) return null
  return <img className={className} style={style} alt={alt ?? ''} loading="lazy" src={api.media(projectId, path, version !== undefined ? { version } : {})} />
}

/** URL of a project media file for the open project. */
export function useMediaUrl(): (path: string, version?: string | number) => string {
  const { api } = useStudio()
  const projectId = useSnapshot(snapshot => snapshot.project?.manifest.id) ?? ''
  return useCallback((path: string, version?: string | number) => api.media(projectId, path, version !== undefined ? { version } : {}), [api, projectId])
}

/**
 * State that outlives the screen it is typed on. Like `useState`, but the
 * Studio keeps the value under `key` while it is open, so a form the author
 * left half-filled is still filled when they come back to it.
 */
export function useKept<T>(key: string, initial: T): [T, (value: T | ((previous: T) => T)) => void] {
  const { controller } = useStudio()
  const [value, setValue] = useState<T>(() => (controller.kept.has(key) ? controller.kept.get(key) as T : initial))
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setValue((previous) => {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next
      controller.kept.set(key, resolved)
      return resolved
    })
  }, [controller, key])
  return [value, set]
}

const sharedListeners = new Set<() => void>()

/**
 * A choice kept for as long as the Studio is open and shared by everything on screen that reads it: changed in one
 * place — on one of thirty cards — it is changed on all of them at once.
 */
export function useShared<T>(key: string, initial: T): [T, (value: T) => void] {
  const { controller } = useStudio()
  const value = useSyncExternalStore(
    (listener) => { sharedListeners.add(listener); return () => { sharedListeners.delete(listener) } },
    () => (controller.kept.has(key) ? controller.kept.get(key) as T : initial),
  )
  const set = useCallback((next: T) => {
    controller.kept.set(key, next)
    for (const listener of [...sharedListeners]) listener()
  }, [controller, key])
  return [value, set]
}

/** Debounce a changing value. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value) }, delay)
    return () => { clearTimeout(timer) }
  }, [value, delay])
  return debounced
}

/** Width of an element, tracked; views pick their layout from the room they are given, not from the window. */
export function useWidth<T extends HTMLElement>(): [ref: (node: T | null) => void, width: number] {
  const [node, setNode] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (node === null) return
    setWidth(node.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [node])
  return [setNode, width]
}

/** Tail the streamed text of a job without owning it. */
export function useJobStream(jobId: string | undefined): string {
  const { controller } = useStudio()
  const [text, setText] = useState('')
  useEffect(() => {
    setText('')
    if (jobId === undefined) return
    const follower = controller.follow(jobId, (streamed) => { setText(streamed) })
    return () => { follower.detach() }
  }, [controller, jobId])
  return text
}

/** Tail a job's text together with what its models think along the way. */
export function useJobTail(jobId: string | undefined): { text: string; thought: string } {
  const { controller } = useStudio()
  const [tail, setTail] = useState({ text: '', thought: '' })
  useEffect(() => {
    setTail({ text: '', thought: '' })
    if (jobId === undefined) return
    const follower = controller.follow(
      jobId,
      (text) => { setTail(previous => ({ ...previous, text })) },
      (thought) => { setTail(previous => ({ ...previous, thought })) },
    )
    return () => { follower.detach() }
  }, [controller, jobId])
  return tail
}

/**
 * What the model is thinking, as it thinks it. Open while there is nothing else
 * to read, folded to one line once the words arrive, and always a click away.
 */
export function ThoughtPanel({ thought, thinking, wrote, className }: { thought: string; thinking: boolean; wrote: boolean; className?: string }) {
  const t = useT()
  // Until the author chooses, it is open exactly while thought is all there is.
  const [choice, setChoice] = useState<boolean | undefined>()
  const open = choice ?? !wrote
  const body = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const element = body.current
    if (element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 160) element.scrollTop = element.scrollHeight
  }, [thought, open])
  if (thought.length === 0) return null
  return (
    <div className={cx('nv-thought', open && 'is-open', className)}>
      <button type="button" className="nv-thought-head" aria-expanded={open} onClick={() => { setChoice(!open) }} title={t('模型的思考过程', 'What the model thought')}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        {thinking ? <Spinner size={11} /> : null}
        <span>{thinking ? t('模型正在思考', 'The model is thinking') : t('思考过程', 'Thought')}</span>
        <span className="nv-muted">{t(`${thought.length} 字`, `${thought.length} chars`)}</span>
        {!open ? <span className="nv-thought-peek">{`…${thought.slice(-44).replace(/\s+/g, ' ')}`}</span> : null}
      </button>
      {open ? <pre className="nv-thought-body" ref={body}>{thought}</pre> : null}
    </div>
  )
}

/** The thought of one job, followed for as long as this is on screen. */
export function JobThought({ job }: { job: JobInfo }) {
  const { thought } = useJobTail(job.id)
  const t = useT()
  if (thought.length === 0) return <p className="nv-muted">{job.status === 'running' ? t('还没有思考内容', 'No thinking yet') : t('这个任务没有留下思考内容。', 'This job left no thought behind.')}</p>
  return <ThoughtPanel thought={thought} thinking={job.status === 'running' && job.thinking !== undefined} wrote={false} className="is-plain" />
}

const CREW_NAMES: Record<string, [string, string]> = {
  analyst: ['场记', 'Continuity'],
  architect: ['策划', 'Planner'],
  director: ['导演', 'Director'],
  producer: ['后期', 'Post-production'],
}

export function crewLabel(role: string, t: Translate): string {
  const name = CREW_NAMES[role]
  return name !== undefined ? t(...name) : role
}

/**
 * The roles that worked in a job: who, how — as an agent with so many tool
 * calls, or in one plain call and why — and a way into the run itself.
 */
export function CrewRuns({ job }: { job: JobInfo }) {
  const { host } = useStudio()
  const t = useT()
  const runs = job.crew ?? []
  if (runs.length === 0) return null
  // A job of many chapters lists a run for each: the ones at work, and the last few that ended, say enough here.
  const atWork = runs.filter(run => run.running === true)
  const shown = [...atWork, ...runs.filter(run => run.running !== true).slice(-Math.max(2, 6 - atWork.length))]
  return (
    <ul className="nv-crewruns">
      {runs.length > shown.length ? <li className="nv-muted nv-small">{t(`…之前还有 ${runs.length - shown.length} 次`, `…${runs.length - shown.length} earlier`)}</li> : null}
      {shown.map((run, index) => {
        const open = run.session !== undefined && run.parent !== undefined && host.openRun !== undefined ? host.openRun : undefined
        return (
          <li key={`${run.session ?? run.label}-${index}`} className="nv-crewrun">
            <Chip tone={run.by === 'agent' ? 'blue' : 'amber'}>{crewLabel(run.role, t)}</Chip>
            <span className="nv-crewrun-label">{run.label}</span>
            <span className="nv-muted nv-small">{run.running === true ? t('agent · 正在干活', 'agent · at work') : run.by === 'agent' ? t(`agent · ${run.steps ?? 0} 步`, `agent · ${run.steps ?? 0} steps`) : t('普通调用', 'plain call')}</span>
            {open !== undefined ? <button type="button" className="nv-link nv-small" onClick={() => { open({ session: run.session!, parent: run.parent! }) }} title={t('打开这次运行的记录', 'Open this run\'s record')}>{t('看过程', 'Open run')}</button> : null}
            {run.note !== undefined ? <span className="nv-crewrun-note">{run.note}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

/** A way to read along with a job's thought from wherever the job is listed. */
export function ThoughtButton({ job, label }: { job: JobInfo; label?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if ((job.thoughtLength ?? 0) === 0 && job.thinking === undefined) return null
  return (
    <>
      <button type="button" className="nv-thought-open" onClick={() => { setOpen(true) }} title={t('看模型在想什么', 'See what the model is thinking')}>
        <Icon name="eye" size={12} />
        {label === true ? <span>{t('看思考', 'Thought')}</span> : null}
      </button>
      {open ? <Modal title={t('模型的思考过程', 'What the model is thinking')} wide onClose={() => { setOpen(false) }}><JobThought job={job} /></Modal> : null}
    </>
  )
}

export { linePath, waysOn, type WayOn } from '../shared/lines'

/**
 * The line of the plot in hand: one for the whole Studio. Whatever page changes it changes it for every page — the
 * outline, the people, the writing, the reading, the production — so that somebody at work on a line beside the main
 * one is on that line wherever they go, and never has to choose it again.
 * @returns the line's id (`main` for the main one) and the way to take another in hand.
 */
export function useBookLine(): [string, (line: string) => void] {
  const { controller } = useStudio()
  const project = useSnapshot(snapshot => snapshot.project)
  const wanted = useSnapshot(snapshot => snapshot.line) ?? MAIN_LINE
  const line = wanted !== MAIN_LINE && (project?.outline.lines ?? []).some(candidate => candidate.id === wanted) ? wanted : MAIN_LINE
  const set = useCallback((next: string) => { controller.setLine(next) }, [controller])
  return [line, set]
}

/**
 * Which line of the plot a screen shows: the one in hand, while the chapter in
 * focus is read on it; otherwise that chapter's own.
 */
export function useLineView(project: ProjectState, chapterId: string | undefined): { lineId: string; path: ChapterInfo[]; pick: (line: string) => void } {
  const [picked, setPicked] = useBookLine()
  const lines = project.outline.lines ?? []
  const focused = chapterId !== undefined ? [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].find(candidate => candidate.id === chapterId) : undefined
  const known = lines.some(line => line.id === picked) ? picked : MAIN_LINE
  const lineId = focused === undefined || linePath(project, known).some(candidate => candidate.id === focused.id) ? known : focused.line ?? MAIN_LINE
  return { lineId, path: linePath(project, lineId), pick: setPicked }
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="nv-section-title">
      <h4>{children}</h4>
      {actions !== undefined ? <div className="nv-section-actions">{actions}</div> : null}
    </div>
  )
}

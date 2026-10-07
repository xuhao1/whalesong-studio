// SPDX-License-Identifier: LGPL-3.0-or-later
/** Inline stroke icons (24×24 grid, currentColor). Kept local so the bundle needs no icon package. */
import type { CSSProperties } from 'react'

const PATHS = {
  book: 'M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13M8 7h7M8 11h5',
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  feather: 'M20.2 3.8a5.5 5.5 0 0 0-7.8 0L5 11.2V19h7.8l7.4-7.4a5.5 5.5 0 0 0 0-7.8ZM16 8 3 21M17.5 15H9',
  tree: 'M4 5h7M4 12h7M4 19h7M15 5h5M15 12h5M15 19h5M11 5v14',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  check: 'M20 6 9 17l-5-5',
  checkCircle: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  stage: 'M3 5h18v11H3ZM8 21h8M12 16v5M10 8.5v4l4-2Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6 6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.3-4.3',
  sparkles: 'M12 3l1.8 4.9L19 9.5l-4.4 2.9L15.8 18 12 14.8 8.2 18l1.2-5.6L5 9.5l5.2-1.6ZM19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7Z',
  play: 'M6 4l14 8-14 8Z',
  pause: 'M7 4h3v16H7ZM14 4h3v16h-3Z',
  stop: 'M6 6h12v12H6Z',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronUp: 'M6 15l6-6 6 6',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5',
  image: 'M3 5h18v14H3ZM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  film: 'M3 4h18v16H3ZM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4',
  gamepad: 'M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 15h-4l-1 .6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4ZM7 11v3M5.5 12.5h3M16 11.5h.01M18 13.5h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  upload: 'M12 21V9M7 14l5-5 5 5M4 3h16',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5',
  alert: 'M12 3 2 20h20ZM12 9v5M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  quote: 'M7 7H4v6h3l-1 4h2l2-4V7Zm10 0h-3v6h3l-1 4h2l2-4V7Z',
  volume: 'M11 5 6 9H3v6h3l5 4ZM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  mute: 'M11 5 6 9H3v6h3l5 4ZM22 9l-6 6M16 9l6 6',
  wand: 'M15 4V2M15 10V8M11 6H9M21 6h-2M17.8 8.8 19 10M17.8 3.2 19 2M12.2 3.2 11 2M3 21l9-9M12.5 8.5l3 3',
  layers: 'M12 3 2 8l10 5 10-5ZM2 13l10 5 10-5M2 18l10 5 10-5',
  thread: 'M4 6c4 0 4 4 8 4s4-4 8-4M4 12c4 0 4 4 8 4s4-4 8-4M4 18c4 0 4-2 8-2',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M5 12l7 7 7-7',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z',
  heart: 'M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1Z',
  type: 'M4 7V5h16v2M9 19h6M12 5v14',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  minimize: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4Z',
  copy: 'M9 9h11v11H9ZM5 15H4V4h11v1',
  undo: 'M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7Z',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM11 18h2',
  lock: 'M6 11h12v10H6ZM8 11V7a4 4 0 0 1 8 0v4M12 15v2',
  unlock: 'M6 11h12v10H6ZM8 11V7a4 4 0 0 1 7.5-2M12 15v2',
  fingerprint: 'M5 12a7 7 0 0 1 12-5M19 12c0 4-1 7-2 9M12 12c0 4-.5 7-2 9M8.5 12a3.5 3.5 0 0 1 7 0c0 3-.3 5-1 7M5 15c0 2-.3 3.5-1 5',
  headphones: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1ZM20 14h-3v6h2a1 1 0 0 0 1-1Z',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  )
}

/** Icon for the sidebar entry and the right-sidebar guide; sized by the host. */
export function StudioGlyph({ size }: { size?: number }) {
  return <Icon name="feather" size={size ?? 18} />
}

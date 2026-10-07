// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Browser half of the plugin. Writing a novel here is a conversation with the
 * showrunner, with the book open beside it:
 *
 * - "Novel Studio" is a tab type of the right sidebar, bound to the session it
 *   is opened in. It opens by itself when the showrunner starts working, and
 *   goes full screen and back with the sidebar's own switch;
 * - the rows of the `novel_*` tool calls in the conversation are doors into the
 *   Studio at the place each call was about, and the showrunner can open a
 *   screen for the author by itself;
 * - "Novel Studio" is also a page in the left sidebar: the bookshelf, the
 *   settings, and any book without a conversation.
 *
 * Everything talks to the Host half through one route (see shared/rpc.ts).
 */
import { useMemo, useSyncExternalStore } from 'react'
import { createApi, type ConnectionLike, type NovelApi } from './api'
import { StudioGlyph } from './icons'
import type { StageTab, StudioView } from './store'
import { Studio } from './Studio'
import styles from './styles.css'
import { createToolRow, NOVEL_TOOLS, type StudioTarget } from './ToolRow'
import type { StudioHost } from './ui'

const PACKAGE = __NOVEL_PACKAGE__
const PANEL_ID = 'novel-studio'
const TAB_KIND = 'novel'
const STYLE_ID = 'novel-studio-styles'

export const name = 'novel-writer-client'
export const inject = ['slots', 'layout', 'connection', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** The slices of the Harness client services this plugin uses. */
interface ClientContext {
  connection: ConnectionLike
  effect(setup: () => () => void, label?: string): void
  slots: {
    inject(slot: string, setup: () => unknown): void
    register(entry: Record<string, unknown>, component: unknown): unknown
  }
  layout: { selectPanel(id: string | null): void }
  locale: { getSnapshot(): { active: string }; subscribe(listener: () => void): () => void }
  sidebarRight: {
    openTab(kind: string, options?: { params?: unknown }): void
    /** The sidebar's own full-screen switch, as its keyboard command uses it; absent on a Harness that has none. */
    commandTarget?(): unknown
    toggleFullscreen?(target: unknown): void
  }
  sidebarRightTabs: { register(definition: Record<string, unknown>): () => void }
}

/** The Harness workspace UI service, when the composition has one. Used, never required. */
interface WorkspaceUi {
  startSession?(workspaceId?: string): void
  pickDirectory?(): Promise<string | null>
}

/** What the Harness hands a right-sidebar tab body (only what is read here). */
interface TabProps {
  sessionId?: string
  inputActions?: { captureInsertion(): unknown; insertText(text: string, span: unknown): boolean }
  useTabInfo?: () => { sidebar?: { fullscreen?: boolean }; tab: { navigation: { params?: unknown; revision: number } } }
}

export function apply(ctx: ClientContext): void {
  const api: NovelApi = createApi(ctx.connection)
  const subscribeLocale = (listener: () => void): (() => void) => ctx.locale.subscribe(listener)
  const getLocale = (): string => ctx.locale.getSnapshot().active
  const zh = (): boolean => getLocale().toLowerCase().startsWith('zh')
  const title = (): string => (zh() ? '小说工坊' : 'Novel Studio')
  const workspaceUi = (): WorkspaceUi | undefined => {
    try {
      return (ctx as unknown as { get?(name: string): unknown }).get?.('uiWorkspace') as WorkspaceUi | undefined
    } catch {
      return undefined
    }
  }
  const pickDirectory = async (): Promise<string | null> => {
    // The Desktop app bridges its own chooser; elsewhere the Harness asks the Host to open one.
    const desktop = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
    if (desktop !== undefined) return await desktop.pick()
    const ui = workspaceUi()
    if (ui?.pickDirectory === undefined) throw new Error(zh() ? '这个环境不能弹出文件夹选择框；请直接起名新建，或在左侧栏添加工作区。' : 'No folder chooser is available here; name a new workspace instead, or add one in the left sidebar.')
    try {
      return await ui.pickDirectory()
    } catch {
      throw new Error(zh() ? '这个环境不能弹出系统的文件夹选择框；请直接起名新建，或在左侧栏添加工作区。' : 'The system folder chooser is not available here; name a new workspace instead, or add one in the left sidebar.')
    }
  }

  // One stylesheet for every Studio instance and tool row; removed when the plugin unloads.
  ctx.effect(() => {
    const element = document.createElement('style')
    element.id = STYLE_ID
    element.textContent = styles
    document.head.appendChild(element)
    return () => { element.remove() }
  }, 'novel: styles')

  // ── the global page ──
  const pageHost: StudioHost = {
    where: 'page',
    pickDirectory,
    startChat: (workspace) => {
      try {
        ctx.layout.selectPanel(null)
      } catch {
        // The conversation is reachable from the sidebar either way.
      }
      try {
        workspaceUi()?.startSession?.(workspace?.id)
      } catch {
        // Without the workspace UI the author starts the conversation themselves.
      }
    },
  }
  function StudioPage() {
    const locale = useSyncExternalStore(subscribeLocale, getLocale)
    return <Studio api={api} locale={locale} host={pageHost} />
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, StudioPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: title }, StudioGlyph))

  // ── the per-session tab ──
  // Full screen is the sidebar's own: the Studio only offers its switch where the author is looking.
  const toggleFullscreen = (): void => {
    try {
      const target = ctx.sidebarRight.commandTarget?.()
      if (target !== undefined) ctx.sidebarRight.toggleFullscreen?.(target)
    } catch {
      // The sidebar's own button still works.
    }
  }
  const canFullscreen = typeof ctx.sidebarRight.commandTarget === 'function' && typeof ctx.sidebarRight.toggleFullscreen === 'function'
  function StudioTab(props: TabProps) {
    const locale = useSyncExternalStore(subscribeLocale, getLocale)
    const info = props.useTabInfo?.()
    const navigation = info?.tab.navigation
    const params = navigation?.params as StudioTarget | undefined
    const view = params?.view
    const chapter = params?.chapter
    const tab = params?.tab
    const mode = params?.mode
    const revision = navigation?.revision
    const actions = props.inputActions
    const fullscreen = info?.sidebar?.fullscreen === true
    const host = useMemo<StudioHost>(() => ({
      where: 'tab',
      pickDirectory,
      ...(canFullscreen ? { maximized: fullscreen, toggleMaximize: toggleFullscreen } : {}),
      ...(actions !== undefined ? {
        quoteToChat: (text: string): boolean => {
          try {
            const landed = actions.insertText(text, actions.captureInsertion())
            // What was quoted should be seen landing in the composer.
            if (landed && fullscreen) toggleFullscreen()
            return landed
          } catch {
            return false
          }
        },
      } : {}),
    }), [actions, fullscreen])
    const initial = useMemo(() => (view !== undefined || chapter !== undefined || tab !== undefined ? { ...(view !== undefined ? { view } : {}), ...(chapter !== undefined ? { chapter } : {}), ...(tab !== undefined ? { tab } : {}), ...(mode !== undefined ? { mode } : {}), ...(revision !== undefined ? { nonce: revision } : {}) } : undefined), [view, chapter, tab, mode, revision])
    return <Studio api={api} locale={locale} host={host} {...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {})} {...(initial !== undefined ? { initial } : {})} />
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PACKAGE,
    kind: TAB_KIND,
    keepMounted: true,
    title,
    guide: [{
      id: 'studio',
      order: 30,
      title,
      description: () => (zh() ? '设定、大纲、正文、审校与演出，就在对话旁边，可全屏' : 'Bible, outline, manuscript, review and stage beside the conversation — full screen when you want it'),
      icon: StudioGlyph,
    }],
  }), 'novel: tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PACKAGE }, StudioTab))

  // ── tool rows in the conversation ──
  const open = (target?: StudioTarget): void => {
    try {
      ctx.sidebarRight.openTab(TAB_KIND, target !== undefined ? { params: target } : undefined)
    } catch {
      // No session on screen (a detached trajectory view): the global page still shows the book.
      try {
        ctx.layout.selectPanel(PANEL_ID)
      } catch {
        // Nothing to open into.
      }
    }
  }
  const ToolRow = createToolRow({ open, subscribeLocale, getLocale })
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const tool of NOVEL_TOOLS) yield ctx.slots.register({ name: 'tool.call.toolview', key: tool }, ToolRow)
  })
}

export type { StageTab, StudioView }

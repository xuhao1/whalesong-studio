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
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createApi, type ConnectionLike, type NovelApi } from './api'
import { StudioGlyph } from './icons'
import { noteOlderHost, type StageTab, type StudioView } from './store'
import { Studio } from './Studio'
import styles from './styles.css'
import { createToolRow, NOVEL_TOOLS, type StudioTarget } from './ToolRow'
import type { StudioHost } from './ui'

const PACKAGE = __NOVEL_PACKAGE__
const PANEL_ID = 'novel-studio'
const TAB_KIND = 'novel'
/** Kept for the window: whether the author was on the Studio's own page when the plugin was last put in it. */
const PAGE_OPEN_KEY = 'novel-studio:page-open'
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
    /** The conversation on screen; absent on a Harness from before it was told. */
    mounted?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
    /** Open a page in the column of one conversation, on screen or not. */
    openTabIn?(sessionId: string, kind: string, options?: { params?: unknown }): void
    /** The sidebar's own full-screen switch, as its keyboard command uses it; absent on a Harness that has none. */
    commandTarget?(): unknown
    toggleFullscreen?(target: unknown): void
  }
  sidebarRightTabs: { register(definition: Record<string, unknown>): () => void }
}

/** The Harness workspace UI service, when the composition has one. Used, never required. */
interface WorkspaceUi {
  startSession?(workspaceId?: string): void
  /** Show a conversation in the main area: by its id, or — a subagent's — through its parent. */
  openSession?(target: string | { parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' | 'unknown' }): void
  pickDirectory?(): Promise<string | null>
}

/** What the Harness hands a right-sidebar tab body (only what is read here). */
interface TabProps {
  sessionId?: string
  inputActions?: { captureInsertion(): unknown; insertText(text: string, span: unknown): boolean }
  useTabInfo?: () => { sidebar?: { fullscreen?: boolean }; tab: { navigation: { params?: unknown; revision: number } } }
}

export function apply(ctx: ClientContext): void {
  /** The conversations that have a Studio beside them right now. */
  const beside = new Set<string>()
  /** The conversation that was on screen last: where the author comes from when they open the Studio's own page. */
  let lastOnScreen = ctx.sidebarRight.mounted?.getSnapshot()
  if (ctx.sidebarRight.mounted !== undefined) {
    const onScreen = ctx.sidebarRight.mounted
    ctx.effect(() => onScreen.subscribe(() => {
      const now = onScreen.getSnapshot()
      if (now !== undefined) lastOnScreen = now
    }), 'novel: where the author comes from')
  }
  // A call the Studio knows and its Host does not means the plugin was updated while DSH ran: the Studio says so instead of failing in riddles.
  const api: NovelApi = createApi(ctx.connection, {
    onOlderHost: () => { noteOlderHost() },
    olderHostMessage: () => (getLocale().toLowerCase().startsWith('zh')
      ? '这个功能要等重启 DSH 之后才能用：小说工坊刚更新过，后台还是这次启动时的旧版本。'
      : 'This needs DSH restarted first: Novel Studio was just updated, and what runs behind it is still the version DSH started with.'),
  })
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

  // The Harness keeps its list of conversations to itself; one that the Studio made, took away or put back shows once it is read again.
  const refreshSessions = (): void => {
    try {
      const sessions = (ctx as unknown as { get?(name: string): unknown }).get?.('sessions') as { refresh?(): Promise<void> } | undefined
      void sessions?.refresh?.().catch(() => {})
    } catch {
      // It shows the next time the Harness reads its list by itself.
    }
  }

  // A role's run is a one-shot child of the conversation that asked for it: the Harness shows it as such.
  const openRun = (run: { session: string; parent: string }): void => {
    try {
      workspaceUi()?.openSession?.({ parentSessionId: run.parent, childSessionId: run.session, mode: 'one-shot' })
    } catch {
      // It stays reachable from the conversation's header.
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
    openRun,
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
    refreshSessions,
    openChat: (sessionId) => {
      refreshSessions()
      try {
        ctx.layout.selectPanel(null)
      } catch {
        // The conversation is reachable from the sidebar either way.
      }
      try {
        workspaceUi()?.openSession?.(sessionId)
      } catch {
        // It is in the sidebar, under its workspace, by the book's name.
      }
      // The Studio beside it, on the book the conversation is on — once the conversation is on screen.
      setTimeout(() => {
        try {
          ctx.sidebarRight.openTab(TAB_KIND)
        } catch {
          // The author opens it from the sidebar's own menu.
        }
      }, 600)
    },
  }
  // The Harness swaps this plugin for a new build in an open window, and with the plugin gone for a moment it shows the
  // conversation instead of the Studio's page. Whether the author was on that page is kept, and the page is put back.
  let swappedOut = false
  ctx.effect(() => () => { swappedOut = true }, 'novel: page memory')
  const pageWasOpen = (): boolean => {
    try {
      return globalThis.sessionStorage?.getItem(PAGE_OPEN_KEY) === '1'
    } catch {
      return false
    }
  }
  const notePage = (open: boolean): void => {
    try {
      if (open) globalThis.sessionStorage?.setItem(PAGE_OPEN_KEY, '1')
      else globalThis.sessionStorage?.removeItem(PAGE_OPEN_KEY)
    } catch {
      // Without storage the page is simply not put back.
    }
  }
  // A page the plugin puts back itself — after a swap, after a reload — is where the author was. A page the author
  // opens from the sidebar is an arrival: it shows the book of the conversation they come from, or the shelf.
  let puttingBack = pageWasOpen()
  function StudioPage() {
    const locale = useSyncExternalStore(subscribeLocale, getLocale)
    const arrival = useMemo(() => {
      if (puttingBack) {
        puttingBack = false
        return undefined
      }
      return lastOnScreen !== undefined ? { sessionId: lastOnScreen } : {}
    }, [])
    useEffect(() => {
      notePage(true)
      // Left because the author went elsewhere — forgotten; left because the plugin is being swapped — kept for the new one.
      return () => { setTimeout(() => { if (!swappedOut) notePage(false) }, 300) }
    }, [])
    return <Studio api={api} locale={locale} host={pageHost} {...(arrival !== undefined ? { arrival } : {})} />
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, StudioPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: title }, StudioGlyph))
  if (pageWasOpen()) {
    // Once the page is registered again.
    const timer = setTimeout(() => {
      try {
        ctx.layout.selectPanel(PANEL_ID)
      } catch {
        // The author opens it from the sidebar.
      }
    }, 0)
    ctx.effect(() => () => { clearTimeout(timer) }, 'novel: page memory (reopen)')
  }

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
    // Which conversations have the Studio beside them: what the follower below goes by.
    useEffect(() => {
      const id = props.sessionId
      if (id === undefined) return undefined
      beside.add(id)
      return () => { beside.delete(id) }
    }, [props.sessionId])
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
      openRun,
      refreshSessions,
      // Beside a conversation, the author can still ask for another book's: the left side goes there, and the Studio is opened beside it.
      openChat: (sessionId: string) => {
        refreshSessions()
        try {
          workspaceUi()?.openSession?.(sessionId)
        } catch {
          // It is in the sidebar, under its workspace, by the book's name.
        }
        setTimeout(() => {
          try {
            ctx.sidebarRight.openTab(TAB_KIND)
          } catch {
            // The author opens it from the sidebar's own menu.
          }
        }, 600)
      },
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
  // ── the Studio stays beside the author when they step into one of the conversation's agents ──
  // The column on the right is each conversation's own. Stepping from a conversation into a child of it — a role at
  // work, opened from a progress bar or from DSH's own list of subagents — shows the child's column, which has no
  // Studio in it: to the author the Studio vanished. So where the conversation they came from had the Studio beside
  // it, and the one they arrive in is about the same book, the Studio is opened there too, on the same page. Once
  // per conversation: a Studio the author then closes there stays closed.
  const mounted = ctx.sidebarRight.mounted
  if (mounted !== undefined && typeof ctx.sidebarRight.openTabIn === 'function') {
    let last = mounted.getSnapshot()
    const followed = (id: string): boolean => {
      try {
        return globalThis.sessionStorage?.getItem(`novel-studio:followed:${id}`) === '1'
      } catch {
        return false
      }
    }
    const follow = (from: string, to: string): void => {
      void (async () => {
        const raw = globalThis.sessionStorage?.getItem(`novel-studio:place:${from}`)
        const place = raw !== null && raw !== undefined ? JSON.parse(raw) as { root?: string } : undefined
        if (place?.root === undefined) return
        // The Host knows which book a conversation is about — a role's run is about the book it works on.
        const info = await api.call('workspace.info', { sessionId: to })
        if (info.active !== place.root || mounted.getSnapshot() !== to) return
        globalThis.sessionStorage?.setItem(`novel-studio:place:${to}`, raw!)
        globalThis.sessionStorage?.setItem(`novel-studio:followed:${to}`, '1')
        ctx.sidebarRight.openTabIn!(to, TAB_KIND)
      })().catch(() => {
        // The author opens it from the column's own menu.
      })
    }
    ctx.effect(() => mounted.subscribe(() => {
      const now = mounted.getSnapshot()
      const before = last
      last = now
      if (now === undefined || before === undefined || now === before) return
      if (!beside.has(before) || beside.has(now) || followed(now)) return
      follow(before, now)
    }), 'novel: the Studio follows into a subagent')
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

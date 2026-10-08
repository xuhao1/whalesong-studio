// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Studio shell: one React tree that runs both as the global "Novel Studio"
 * page and as a per-session tab in the right sidebar. It owns a controller,
 * shows the project chrome (title, navigation, mode, jobs, search) and routes
 * to the views.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { formatCount } from '../shared/text'
import { WORK_MODES, type JobInfo, type ProjectRef, type ProjectState, type WorkMode } from '../shared/types'
import type { NovelApi } from './api'
import { JobBar } from './JobBar'
import { RecommendedNotice } from './Recommended'
import { Icon, type IconName } from './icons'
import { BatchMatrix, batchOf, GateNotes } from './Batch'
import { jobTarget, jobTitle, waitingLabel } from './labels'
import { StudioController, type Capability, type ReadMode, type StageTab, type StudioView } from './store'
import {
  Button, CrewRuns, cx, Empty, Menu, Modal, OverlayRootProvider, Popover, Progress, Spinner, StudioProvider, ThoughtButton, Toasts, useAction, useConfirm, useSnapshot, useStudio, useT,
  type StudioHost, type Translate,
} from './ui'
import { BibleView } from './views/Bible'
import { CastView } from './views/Cast'
import { HomeView, Onboarding, useRemoveBook } from './views/Home'
import { LockScreen, SealDialog } from './views/Lock'
import { OutlineView } from './views/Outline'
import { ReadView } from './views/Read'
import { ReviewView } from './views/Review'
import { SearchPanel } from './views/Search'
import { SettingsView } from './views/Settings'
import { SetupView } from './views/Setup'
import { StageView } from './views/Stage'
import { UsageView } from './views/Usage'
import { WriteView } from './views/Write'

export interface StudioProps {
  api: NovelApi
  /** UI language tag from the Harness (`zh`, `en`, …). */
  locale: string
  host: StudioHost
  sessionId?: string
  /** Where to land when opened from a link (a tool card, the guide); the chapter may be an id, a number or a title. */
  initial?: { view?: StudioView; chapter?: string; tab?: StageTab; mode?: ReadMode; nonce?: number }
  /** The Studio's own page, opened by the author just now: the conversation they came from, if any. See `StudioController`. */
  arrival?: { sessionId?: string }
}

export const MODE_LABELS: Record<WorkMode, [string, string]> = {
  ideate: ['构思', 'Ideate'],
  bible: ['设定', 'Bible'],
  outline: ['大纲', 'Outline'],
  draft: ['写作', 'Draft'],
  revise: ['修订', 'Revise'],
  review: ['审校', 'Review'],
  stage: ['演出', 'Stage'],
  play: ['幕间', 'Play'],
}

const MODE_HINTS: Record<WorkMode, [string, string]> = {
  ideate: ['把点子磨成故事核，不写正文', 'Shape the premise; no prose yet'],
  bible: ['打磨人物、世界观与文风', 'Work on characters, world and style'],
  outline: ['推演与调整情节', 'Derive and reshape the plot'],
  draft: ['按大纲逐章写作', 'Write chapter by chapter'],
  revise: ['修改已有正文', 'Change existing prose'],
  review: ['挑问题，不动正文', 'Find problems; hands off the prose'],
  stage: ['插图、有声剧与有声漫', 'Illustrations, audio drama, motion comics'],
  play: ['下场演一段幕间', 'Step into an interlude'],
}

export function Studio({ api, locale, host, sessionId, initial, arrival }: StudioProps) {
  // The arrival is read once, as the Studio is put up: it is where the author came from then.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const controller = useMemo(() => new StudioController(api, sessionId, arrival), [api, sessionId])
  const rootRef = useRef<HTMLDivElement>(null)
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    void controller.start()
    return () => { controller.dispose() }
  }, [controller])
  useEffect(() => {
    controller.refreshSessions = host.refreshSessions
  }, [controller, host.refreshSessions])
  useEffect(() => { setOverlayRoot(rootRef.current) }, [])
  // Only a Studio on screen keeps a live connection to the Host.
  useEffect(() => {
    const element = rootRef.current
    if (element === null || typeof IntersectionObserver === 'undefined') return
    let onScreen = true
    const update = (): void => { controller.setVisible(onScreen && document.visibilityState !== 'hidden') }
    const observer = new IntersectionObserver((entries) => {
      onScreen = entries.some(entry => entry.isIntersecting)
      update()
    })
    observer.observe(element)
    document.addEventListener('visibilitychange', update)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [controller])
  // A link into the Studio (a tool card, the showrunner showing something) names a view, a chapter, a stage tab.
  const status = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().status)
  const loaded = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().project !== undefined)
  useEffect(() => {
    if (initial === undefined || (initial.view === undefined && initial.chapter === undefined && initial.tab === undefined)) return
    // A chapter named by title can only be found once the project is in hand; the view can switch at once.
    if (status !== 'ready') return
    void controller.show({ ...(initial.view !== undefined ? { view: initial.view } : {}), ...(initial.chapter !== undefined ? { chapter: initial.chapter } : {}), ...(initial.tab !== undefined ? { tab: initial.tab } : {}), ...(initial.mode !== undefined ? { mode: initial.mode } : {}) })
  }, [controller, status, loaded, initial?.view, initial?.chapter, initial?.tab, initial?.mode, initial?.nonce])
  const zh = locale.toLowerCase().startsWith('zh')
  const t: Translate = useMemo(() => (zhText, enText) => (zh ? zhText : enText), [zh])
  const value = useMemo(() => ({ controller, api, t, locale, host }), [controller, api, t, locale, host])
  return (
    <div ref={rootRef} className={cx('nv-root', host.where === 'page' && 'nv-root-page')} data-novel-studio="">
      <StudioProvider value={value}>
        <OverlayRootProvider value={overlayRoot}>
          <StaleHostNotice />
          <NoSwarmNotice />
          <RecommendedNotice />
          <Shell />
          <ActivityDock />
          <BookNotice />
          <JobNotice />
          <NeedsDialog />
          <Toasts />
        </OverlayRootProvider>
      </StudioProvider>
    </div>
  )
}

/** Says once, on screen, that the conversation and the Studio moved to another book together. */
function BookNotice() {
  const { controller } = useStudio()
  const t = useT()
  const moved = useSnapshot(snapshot => snapshot.bookMoved)
  useEffect(() => {
    if (moved === undefined) return
    controller.toast('info', moved.by === 'author'
      ? t(`对话已跟到《${moved.title}》：Agent 从下一步起在这本书上工作`, `The conversation followed you to "${moved.title}": the agent works on this book from its next step`)
      : t(`Agent 把对话切到了《${moved.title}》，工坊已跟过去`, `The agent moved the conversation to "${moved.title}"; the Studio followed`))
  }, [controller, moved?.nonce])
  return null
}

/** Says that a long media job nobody was waiting on has finished, and how it went. */
function JobNotice() {
  const { controller } = useStudio()
  const t = useT()
  const ended = useSnapshot(snapshot => snapshot.jobEnded)
  useEffect(() => {
    if (ended === undefined) return
    const output = (ended.job.result?.output ?? {}) as { rendered?: number; failed?: number; cached?: number; panels?: number; lines?: number }
    const batch = batchOf(ended.job)
    if (batch !== undefined) {
      const done = batch.rows.reduce((sum, row) => sum + Object.values(row.steps).filter(step => step.state === 'done').length, 0)
      controller.toast(batch.failed > 0 ? 'info' : 'success', batch.failed > 0
        ? t(`批量任务结束：完成 ${done} 步，${batch.failed} 步没有做成——原因在“任务”里，可以只把没做成的再做一次`, `The batch is over: ${done} steps done, ${batch.failed} did not come about — Jobs says why, and what is missing can be done again`)
        : t(`批量任务完成：${done} 步`, `The batch is done: ${done} steps`))
    } else if (ended.job.kind === 'audio' && typeof output.rendered === 'number') {
      const failed = output.failed ?? 0
      controller.toast(failed > 0 ? 'info' : 'success', failed > 0
        ? t(`语音合成结束：新合成 ${output.rendered} 句，${failed} 句失败（失败的句子上有原因，可单句重试）`, `Speech finished: ${output.rendered} new lines, ${failed} failed (each failed line says why and can be retried)`)
        : t(`语音合成完成：新合成 ${output.rendered} 句${(output.cached ?? 0) > 0 ? `，${output.cached} 句沿用已有的` : ''}`, `Speech done: ${output.rendered} new lines${(output.cached ?? 0) > 0 ? `, ${output.cached} reused` : ''}`))
    } else if (ended.job.kind === 'audio') controller.toast('success', t('有声脚本已编排好', 'The audio script is ready'))
    else controller.toast('success', t('有声漫这一步完成了', 'The motion-comic step is done'))
  }, [controller, ended?.nonce])
  return null
}

const NEEDS: Record<Capability, { title: [string, string]; body: [string, string] }> = {
  tts: {
    title: ['还没有配置语音合成', 'Speech is not set up yet'],
    body: ['配音、有声剧和幕间的人声都要用到一个语音模型。贴一个阿里云百炼或 OpenRouter 的 key 就能一键配好，也可以在设置里填你自己的接口。', 'Voices for audio drama, motion comics and interludes need a speech model. One Aliyun Bailian or OpenRouter key sets it up in one click, or name an endpoint of your own in the settings.'],
  },
  image: {
    title: ['还没有配置图像生成', 'Image generation is not set up yet'],
    body: ['人设图、立绘、插图、封面和分镜都要用到一个绘图模型。可以用 key 一键配好，也可以直接用已经登录的 ChatGPT 订阅（Codex）。', 'Design sheets, portraits, illustrations, covers and panels need an image model. Set it up with a key in one click, or use a ChatGPT subscription that is already signed in (Codex).'],
  },
  text: {
    title: ['有一个模型还缺密钥', 'A model is missing its key'],
    body: ['这一步要用的模型指向了一个还没有保存密钥的接口。去设置里把密钥贴上，或者把这个角色改成"跟随对话模型"。', 'The model for this step points at an endpoint whose key has not been saved. Paste the key in the settings, or let the role follow the chat model.'],
  },
  embedding: {
    title: ['语义检索还缺密钥', 'Retrieval is missing its key'],
    body: ['语义检索（向量）用的接口还没有保存密钥。去设置里贴上，或者把它关掉——没有它，工坊会改用关键词检索。', 'The endpoint for semantic retrieval has no saved key. Paste it in the settings, or switch retrieval off — the Studio then searches by keywords.'],
  },
}

/** Something needs a capability that is not set up: say what, and offer the way there. */
function NeedsDialog() {
  const { controller } = useStudio()
  const t = useT()
  const needs = useSnapshot(snapshot => snapshot.needs)
  if (needs === undefined) return null
  const copy = NEEDS[needs.what]
  const media = needs.what === 'image' || needs.what === 'tts'
  return (
    <Modal title={t(...copy.title)} onClose={() => { controller.dismissNeed() }} footer={(
      <>
        <Button variant="ghost" onClick={() => { controller.dismissNeed() }}>{t('以后再说', 'Not now')}</Button>
        <span className="nv-spacer" />
        {media ? <Button icon="sparkles" onClick={() => { controller.dismissNeed(); controller.setView('setup') }}>{t('一键配置', 'One-click setup')}</Button> : null}
        <Button variant="primary" icon="settings" onClick={() => { controller.openSettings(needs.what) }}>{t('去设置', 'Open settings')}</Button>
      </>
    )}>
      <p>{t(...copy.body)}</p>
      {needs.detail !== undefined ? <p className="nv-muted nv-small">{needs.detail}</p> : null}
    </Modal>
  )
}

const NAV: { view: StudioView; icon: IconName; label: [string, string] }[] = [
  { view: 'home', icon: 'home', label: ['总览', 'Overview'] },
  { view: 'cast', icon: 'users', label: ['人物', 'People'] },
  { view: 'bible', icon: 'globe', label: ['设定', 'Bible'] },
  { view: 'outline', icon: 'tree', label: ['大纲', 'Outline'] },
  { view: 'write', icon: 'pen', label: ['写作', 'Write'] },
  // What the book is to whoever reads it: its text, its people, its world — everything else is where it is made.
  { view: 'read', icon: 'eye', label: ['观看', 'View'] },
  { view: 'review', icon: 'checkCircle', label: ['审校', 'Review'] },
  { view: 'stage', icon: 'stage', label: ['演出', 'Stage'] },
]

function Shell() {
  const { controller } = useStudio()
  const t = useT()
  const status = useSnapshot(snapshot => snapshot.status)
  const error = useSnapshot(snapshot => snapshot.error)
  const project = useSnapshot(snapshot => snapshot.project)
  const view = useSnapshot(snapshot => snapshot.view)
  const lock = useSnapshot(snapshot => snapshot.lock)
  const [searching, setSearching] = useState(false)

  if (status === 'loading') return <div className="nv-center"><Spinner size={20} /></div>
  if (status === 'error') {
    return (
      <Empty icon="alert" title={t('无法连接到小说工坊服务', 'Could not reach the Novel Studio service')}>
        <p>{error}</p>
        <Button onClick={() => { void controller.start() }} icon="refresh">{t('重试', 'Retry')}</Button>
      </Empty>
    )
  }
  // A sealed book that is locked: nothing of it can be shown but the way to open it.
  if (lock !== undefined && view !== 'settings' && view !== 'setup' && view !== 'usage') return <><BareHeader /><div className="nv-body"><LockScreen /></div></>
  if (project === undefined) {
    if (view === 'settings') return <><BareHeader title={t('小说工坊设置', 'Novel Studio settings')} /><div className="nv-body"><SettingsView /></div></>
    if (view === 'setup') return <><BareHeader title={t('开始之前', 'Before you start')} /><div className="nv-body"><SetupView /></div></>
    if (view === 'usage') return <><BareHeader title={t('用量与成本', 'Usage and cost')} /><div className="nv-body"><UsageView /></div></>
    return <><BareHeader /><div className="nv-body"><Onboarding /></div></>
  }
  return (
    <>
      <Header onSearch={() => { setSearching(true) }} />
      <div className="nv-body" data-view={view}>
        {view === 'home' ? <HomeView /> : null}
        {view === 'bible' ? <BibleView /> : null}
        {view === 'outline' ? <OutlineView /> : null}
        {view === 'write' ? <WriteView /> : null}
        {view === 'read' ? <ReadView /> : null}
        {view === 'cast' ? <CastView /> : null}
        {view === 'review' ? <ReviewView /> : null}
        {view === 'stage' ? <StageView /> : null}
        {view === 'settings' ? <SettingsView /> : null}
        {view === 'setup' ? <SetupView /> : null}
        {view === 'usage' ? <UsageView /> : null}
      </div>
      {searching ? <SearchPanel onClose={() => { setSearching(false) }} /> : null}
    </>
  )
}

/**
 * The Studio on screen is newer than the Host it talks to: the plugin was
 * updated while DSH was running. DSH puts the new Studio in the window at
 * once, and keeps running the Host half it loaded when it started.
 */
function StaleHostNotice() {
  const { controller } = useStudio()
  const t = useT()
  const stale = useSnapshot(snapshot => snapshot.hostStale)
  const reloadable = useSnapshot(snapshot => snapshot.hostReloadable)
  const running = useSnapshot(snapshot => snapshot.jobs.filter(job => job.status === 'running').length)
  const [hidden, setHidden] = useState(false)
  const [failed, setFailed] = useState(false)
  const restart = useAction()
  const confirm = useConfirm()
  if (stale !== true || hidden) return null
  // The Host half changes itself: its jobs stop and its sealed books lock, as they would when DSH restarts — DSH and the conversations stay.
  const change = (): Promise<unknown> => restart.run(async () => {
    setFailed(false)
    try {
      const stopped = await controller.reloadHost()
      controller.toast('success', stopped > 0
        ? t(`已换上新版本的后台。有 ${stopped} 个进行中的任务被中断了，可以重新开始。`, `The new backend is up. ${stopped} running jobs were stopped; start them again when you like.`)
        : t('已换上新版本的后台。', 'The new backend is up.'))
    } catch (error) {
      setFailed(true)
      throw error
    }
  })
  const ask = (): void => {
    if (running > 0) confirm.ask(t(`有 ${running} 个任务正在进行，重启后台会中断它们（做完的部分都在，之后可以接着做）。已解锁的加密书需要重新解锁。现在重启？`, `${running} jobs are running, and restarting the backend stops them (what they finished is kept; they can be taken up again). Sealed books that are unlocked will need unlocking again. Restart now?`), () => { void change() })
    else void change()
  }
  const can = reloadable === true && !failed
  return (
    <div className="nv-banner is-warn nv-stale" role="status">
      <span>
        <Icon name="refresh" size={14} />
        <b>{can ? t('小说工坊更新了', 'Novel Studio was updated') : t('请重启 DSH', 'Restart DSH')}</b>
        {can
          ? t('——界面已经是新的，后台还是旧版本。点“重启”把后台也换成新的：只重启工坊自己的后台，DSH 和对话都不动，几秒钟就好。', ' — what you see is the new version, what works behind it is still the old one. "Restart" brings the backend up to date: only the Studio\'s own backend restarts, DSH and its conversations stay as they are, and it takes a few seconds.')
          : failed
            ? t('——后台没能自己换成新版本，这一次请重启 DSH。', ' — the backend could not change to the new version by itself; restart DSH this once.')
            : t('——小说工坊刚刚更新过：界面已经是新的，后台还是 DSH 这次启动时装载的旧版本。这一次要重启 DSH 才能一致（之后的更新可以在这里一键重启）；在那之前，新加的功能可能用不了，或者表现得不对。', ' — Novel Studio was just updated: what you see is the new version, what works behind it is still the one DSH loaded when it started. This once DSH has to be restarted for them to match (later updates restart from here with one press); until then, what is new may not work, or not as it should.')}
      </span>
      {can ? <Button size="sm" variant="primary" icon="refresh" busy={restart.busy} pending={t('正在重启…', 'Restarting…')} onClick={ask}>{t('重启', 'Restart')}</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => { setHidden(true) }}>{t('知道了', 'Got it')}</Button>
      {confirm.element}
    </div>
  )
}

/**
 * Every role of the crew is an agent of DSH, and DSH's subagent service is
 * what makes one: without it a role can only be asked once and answer once —
 * it cannot look anything up, check its own work, or be watched. A DSH that
 * has it switched off is told so, plainly, and how to switch it on.
 */
function NoSwarmNotice() {
  const t = useT()
  const crew = useSnapshot(snapshot => snapshot.settings?.crew)
  const [hidden, setHidden] = useState(false)
  // Unknown on an older Host: nothing is said about what cannot be known.
  if (crew === undefined || hidden || (crew.loop && crew.subagents !== false)) return null
  return (
    <div className="nv-banner is-warn nv-stale" role="status">
      <span>
        <Icon name="users" size={14} />
        <b>{t('子智能体没有开启', 'Subagents are switched off')}</b>
        {crew.loop
          ? t('——小说工坊的场记、策划、导演、后期都是 DSH 的子智能体。现在 DSH 的子智能体功能（@deepseek-ai/dsh-subagent）被关掉了：各个角色只能一问一答地干活，不能查原文、不能自查，运行过程也看不到。请在 DSH 的"设置 → 插件"里把它启用，然后重启 DSH。', ' — the Studio\'s continuity, planner, director and post-production are subagents of DSH. DSH\'s subagent service (@deepseek-ai/dsh-subagent) is switched off here: each role can only answer one request at a time — it cannot look up the text, check its own work, or be watched. Enable it under DSH\'s Settings → Plugins, then restart DSH.')
          : t('——这个 DSH 没有 agent 循环（纯后台模式）：各个角色只能一问一答地干活。', ' — this DSH runs no agent loop (a bare headless core): each role can only answer one request at a time.')}
      </span>
      <Button size="sm" variant="ghost" onClick={() => { setHidden(true) }}>{t('知道了', 'Got it')}</Button>
    </div>
  )
}

/** Switch between docked beside the conversation and covering it. Only a Studio in a session tab has one. */
function MaximizeButton() {
  const { host } = useStudio()
  const t = useT()
  if (host.toggleMaximize === undefined) return null
  const on = host.maximized === true
  return <Button variant="ghost" size="sm" icon={on ? 'minimize' : 'maximize'} className={cx(on && 'is-active')} onClick={host.toggleMaximize} title={on ? t('退出全屏，回到对话旁边', 'Leave full screen, back beside the conversation') : t('全屏', 'Full screen')} />
}

/** Header shown before any project is open: where you are, and the way back. */
function BareHeader({ title }: { title?: string }) {
  const { controller, host } = useStudio()
  const t = useT()
  // Nothing to show on the bookshelf of the global page; in a tab the bar carries the full-screen switch.
  if (title === undefined && host.toggleMaximize === undefined) return null
  return (
    <header className="nv-header">
      {title !== undefined ? <Button variant="ghost" size="sm" icon="chevronLeft" onClick={() => { controller.setView('home') }}>{t('返回', 'Back')}</Button> : null}
      <span className="nv-header-title">{title ?? t('小说工坊', 'Novel Studio')}</span>
      <span className="nv-spacer" />
      {title === undefined ? <Button variant="ghost" size="sm" icon="settings" onClick={() => { controller.setView('settings') }} title={t('设置', 'Settings')} /> : null}
      <MaximizeButton />
    </header>
  )
}

function Header({ onSearch }: { onSearch: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const locale = useStudio().locale
  const project = useSnapshot(snapshot => snapshot.project)!
  const view = useSnapshot(snapshot => snapshot.view)
  const workspaces = useSnapshot(snapshot => snapshot.workspaces)
  const root = useSnapshot(snapshot => snapshot.root)
  const sessionBook = useSnapshot(snapshot => snapshot.sessionBook)
  const others = workspaces.flatMap(workspace => workspace.projects).filter(ref => ref.root !== root)
  const { stats } = project
  const reviewBadge = stats.pendingProposals + stats.pendingSuggestions
  // In a session's Studio the open book is the conversation's book: changing one changes the other.
  const linked = controller.sessionId !== undefined && sessionBook === root
  const removal = useRemoveBook()
  const [sealing, setSealing] = useState(false)
  return (
    <header className="nv-header">
      <Menu
        label={project.manifest.title}
        icon="book"
        items={[
          ...others.map(ref => ({ label: controller.sessionId !== undefined ? t(`${ref.title}（对话一起换过去）`, `${ref.title} (the conversation moves too)`) : ref.title, icon: 'book' as IconName, onSelect: () => { void controller.guard(async () => { await controller.openProject(ref.root) }) } })),
          ...(others.length > 0 ? ['separator' as const] : []),
          // The shelf is the home page; starting something new has a page of its own behind it.
          { label: t('回书架', 'Back to the shelf'), icon: 'home', onSelect: () => { controller.kept.delete('onboard.page'); controller.closeProject() } },
          { label: t('新创作…', 'New work…'), icon: 'sparkles', onSelect: () => { controller.kept.set('onboard.page', 'new'); controller.closeProject() } },
          'separator' as const,
          { label: t('加密与上锁…', 'Seal and lock…'), icon: 'lock', onSelect: () => { setSealing(true) } },
          { label: t('删除这本书…', 'Remove this book…'), icon: 'trash', danger: true, onSelect: () => { if (root !== undefined) removal.ask({ root, title: project.manifest.title }) } },
        ]}
      />
      {removal.element}
      {sealing ? <SealDialog onClose={() => { setSealing(false) }} /> : null}
      {linked ? <LinkedChip title={project.manifest.title} others={others} /> : null}
      <span className="nv-header-stats" title={t(`${stats.chaptersWithText}/${stats.chapters} 章已写`, `${stats.chaptersWithText}/${stats.chapters} chapters written`)}>
        {formatCount(stats.words, locale)}{t(' 字', ' words')}
      </span>
      <nav className="nv-nav" aria-label="Novel Studio">
        {NAV.map(item => (
          <button key={item.view} type="button" className={cx('nv-nav-item', view === item.view && 'is-active')} onClick={() => { controller.setView(item.view) }} title={t(...item.label)}>
            <Icon name={item.icon} size={15} />
            <span>{t(...item.label)}</span>
            {item.view === 'review' && reviewBadge > 0 ? <span className="nv-badge">{reviewBadge}</span> : null}
          </button>
        ))}
      </nav>
      <div className="nv-header-tools">
        <ModeSwitch />
        <JobsButton />
        <Button variant="ghost" size="sm" icon="search" onClick={onSearch} title={t('搜索与查找', 'Search and find')} />
        <Button variant="ghost" size="sm" icon="settings" className={cx((view === 'settings' || view === 'setup' || view === 'usage') && 'is-active')} onClick={() => { controller.setView('settings') }} title={t('设置', 'Settings')} />
        <MaximizeButton />
      </div>
    </header>
  )
}

/**
 * Says that the conversation beside this panel and the panel itself are on the
 * same book — and, when asked, what that means and how to change it.
 */
function LinkedChip({ title, others }: { title: string; others: ProjectRef[] }) {
  const { controller } = useStudio()
  const t = useT()
  return (
    <Popover
      className="nv-linked-card"
      trigger={({ open, toggle }) => (
        <button type="button" className={cx('nv-linked', open && 'is-open')} aria-expanded={open} onClick={toggle} title={t('对话和这块面板在同一本书上——点开看这是什么意思', 'The conversation and this panel are on the same book — click for what that means')}>
          <Icon name="chat" size={12} />
          <span>{t('对话同步', 'In sync')}</span>
        </button>
      )}
    >
      {close => (
        <>
          <strong>{t(`对话正在《${title}》上`, `The conversation is on "${title}"`)}</strong>
          <p>{t('你在左边对总编说的话、它调用的工具，默认都作用在这本书上；这块面板显示的也是这本书。两边始终是同一本。', 'What you say to the showrunner on the left, and the tools it calls, act on this book; this panel shows the same book. The two always stay together.')}</p>
          <ul>
            <li>{t('在这里换书，对话跟着换过去——之后说的话就是在说新那本。', 'Change book here and the conversation moves with you — what you say next is about the new one.')}</li>
            <li>{t('让总编换书（"我们来写另一本"），这块面板也跟着换。', 'Ask the showrunner to change book and this panel follows.')}</li>
            <li>{t('只想让总编碰一下别的书（比如抄一个人物过来），直接说书名，不用换。', 'To have the showrunner touch another book once (copying a character over, say), just name it — no need to move.')}</li>
          </ul>
          {others.length > 0 ? (
            <div className="nv-linked-books">
              <span className="nv-muted nv-small">{t('换到：', 'Move to:')}</span>
              {others.slice(0, 6).map(ref => (
                <Button key={ref.root} size="sm" icon="book" onClick={() => { close(); void controller.guard(async () => { await controller.openProject(ref.root) }) }}>{ref.title}</Button>
              ))}
            </div>
          ) : null}
          <div className="nv-row-wrap">
            <Button size="sm" variant="ghost" icon="plus" onClick={() => { close(); controller.closeProject() }}>{t('书架 / 新建', 'Bookshelf / new')}</Button>
          </div>
        </>
      )}
    </Popover>
  )
}

/** The session's working mode; only a Studio bound to a session has one. */
function ModeSwitch() {
  const { controller } = useStudio()
  const t = useT()
  const mode = useSnapshot(snapshot => snapshot.mode)
  if (controller.sessionId === undefined || mode === undefined) return null
  return (
    <Menu
      label={t(...MODE_LABELS[mode])}
      icon="zap"
      align="end"
      items={WORK_MODES.map(item => ({
        label: `${t(...MODE_LABELS[item])} — ${t(...MODE_HINTS[item])}`,
        ...(item === mode ? { icon: 'check' as IconName } : {}),
        onSelect: () => { void controller.guard(async () => { await controller.setMode(item) }) },
      }))}
    />
  )
}

const JOB_LABELS: Record<JobInfo['kind'], [string, string]> = {
  write: ['写作', 'Writing'],
  revise: ['修订', 'Revising'],
  digest: ['收录记忆', 'Digesting'],
  derive: ['推演', 'Deriving'],
  review: ['审校', 'Reviewing'],
  import: ['导入', 'Importing'],
  bible: ['设定', 'Bible'],
  illustrate: ['绘图', 'Illustrating'],
  audio: ['有声', 'Audio'],
  comic: ['分镜', 'Comic'],
  play: ['幕间', 'Interlude'],
  export: ['导出', 'Exporting'],
  index: ['索引', 'Indexing'],
  seal: ['加密', 'Sealing'],
  video: ['成片', 'Video'],
  crew: ['班底', 'Crew'],
  batch: ['批量', 'Batch'],
  install: ['安装插件', 'Installing a plugin'],
}

/** What a running job is doing right now, when it says so. */
export function jobPulse(job: JobInfo, t: Translate): string | undefined {
  if (job.thinking !== undefined) return t(`模型思考中（${job.thinking} 字）…`, `The model is thinking (${job.thinking} chars)…`)
  return job.progress?.label
}

export function jobKindLabel(kind: JobInfo['kind'], t: Translate): string {
  return t(...JOB_LABELS[kind])
}

/** A job in the author's words: what it does, and to which chapter or card. */
export function jobLabel(job: JobInfo, t: Translate, project?: ProjectState): string {
  const zh = t('zh', 'en') === 'zh'
  const target = jobTarget(job, project, zh)
  return `${t(...jobTitle(job))}${target !== undefined ? ` · ${target}` : ''}`
}

const elapsedOf = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * What the Studio is working on right now, always in the same place: clicks
 * the Host has not answered yet, and jobs running for this book. Whatever was
 * pressed, wherever the author went since — work in progress is on screen, with
 * what it is doing and for how long, and a way to stop it.
 */
function ActivityDock() {
  const { controller } = useStudio()
  const t = useT()
  const activity = useSnapshot(snapshot => snapshot.activity)
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const project = useSnapshot(snapshot => snapshot.project)
  const running = jobs.filter(job => job.status === 'running')
  const busy = activity.length > 0 || running.length > 0
  const [now, setNow] = useState(() => Date.now())
  const [folded, setFolded] = useState(false)
  useEffect(() => {
    if (!busy) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [busy])
  if (!busy) return null
  const rows = running.length + activity.length
  const shown = folded ? 1 : 4
  return (
    <div className="nv-dock" role="status" aria-live="polite">
      <GateNotes />
      {running.slice(0, shown).map(job => <JobBar key={job.id} job={job} now={now} dense />)}
      {activity.slice(0, Math.max(0, shown - running.length)).map(item => (
        <div key={item.id} className="nv-dock-row">
          <Spinner size={12} />
          <span className="nv-dock-title">{t(...waitingLabel(item.method))}</span>
          <span className="nv-dock-pulse" />
          {now - item.since >= 3000 ? <span className="nv-dock-time">{elapsedOf(item.since, now)}</span> : null}
        </div>
      ))}
      {rows > 1 ? (
        <button type="button" className="nv-dock-more" onClick={() => { setFolded(value => !value) }}>
          {folded ? t(`共 ${rows} 项在进行，展开`, `${rows} things in progress — show`) : rows > shown ? t(`还有 ${rows - shown} 项 · 收起`, `${rows - shown} more · fold`) : t('收起', 'Fold')}
        </button>
      ) : null}
    </div>
  )
}

function JobsButton() {
  const { controller } = useStudio()
  const t = useT()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const project = useSnapshot(snapshot => snapshot.project)
  const [open, setOpen] = useState(false)
  const running = jobs.filter(job => job.status === 'running')
  if (jobs.length === 0) return null
  return (
    <>
      <button type="button" className={cx('nv-jobs-button', running.length > 0 && 'is-running')} onClick={() => { setOpen(true) }} title={t('任务', 'Jobs')}>
        {running.length > 0 ? <Spinner size={12} /> : <Icon name="clock" size={14} />}
        {running.length > 0 ? <span>{running.length}</span> : null}
      </button>
      {open ? (
        <Modal title={t('任务', 'Jobs')} onClose={() => { setOpen(false) }}>
          <ul className="nv-joblist">
            {jobs.slice(0, 30).map(job => (
              <li key={job.id} className={cx('nv-job', `is-${job.status}`)}>
                <div className="nv-job-main">
                  <span className="nv-job-title">{jobLabel(job, t, project)}</span>
                  <span className="nv-job-meta">{job.origin === 'agent' ? t('总编发起', 'by the agent') : t('手动', 'manual')} · {new Date(job.startedAt).toLocaleTimeString()}</span>
                  {job.status === 'running' ? <JobBar job={job} /> : null}
                  {job.error !== undefined ? <span className="nv-job-error">{job.error}</span> : null}
                  {batchOf(job) !== undefined ? <details className="nv-job-batch"><summary>{t('逐项进度', 'Step by step')}</summary><BatchMatrix job={job} compact /></details> : null}
                  <CrewRuns job={job} />
                </div>
                <ThoughtButton job={job} label />
                {job.status === 'running'
                  ? <Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(job.id) }}>{t('停止', 'Stop')}</Button>
                  : <span className="nv-job-status">{job.status === 'done' ? t('完成', 'done') : job.status === 'failed' ? t('失败', 'failed') : t('已取消', 'cancelled')}</span>}
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </>
  )
}

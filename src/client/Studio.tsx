// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Studio shell: one React tree that runs both as the global "Novel Studio"
 * page and as a per-session tab in the right sidebar. It owns a controller,
 * shows the project chrome (title, navigation, mode, jobs, search) and routes
 * to the views.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { formatCount } from '../shared/text'
import { WORK_MODES, type JobInfo, type ProjectState, type WorkMode } from '../shared/types'
import type { NovelApi } from './api'
import { Icon, type IconName } from './icons'
import { jobTarget, jobTitle, waitingLabel } from './labels'
import { StudioController, type Capability, type ReadMode, type StageTab, type StudioView } from './store'
import {
  Button, cx, Empty, Menu, Modal, OverlayRootProvider, Progress, Spinner, StudioProvider, Toasts, useSnapshot, useStudio, useT,
  type StudioHost, type Translate,
} from './ui'
import { BibleView } from './views/Bible'
import { CastView } from './views/Cast'
import { HomeView, Onboarding, useRemoveBook } from './views/Home'
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

export function Studio({ api, locale, host, sessionId, initial }: StudioProps) {
  const controller = useMemo(() => new StudioController(api, sessionId), [api, sessionId])
  const rootRef = useRef<HTMLDivElement>(null)
  const [overlayRoot, setOverlayRoot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    void controller.start()
    return () => { controller.dispose() }
  }, [controller])
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
    if (ended.job.kind === 'audio' && typeof output.rendered === 'number') {
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
  { view: 'bible', icon: 'users', label: ['设定', 'Bible'] },
  { view: 'outline', icon: 'tree', label: ['大纲', 'Outline'] },
  { view: 'write', icon: 'pen', label: ['写作', 'Write'] },
  { view: 'read', icon: 'eye', label: ['阅读', 'Read'] },
  { view: 'cast', icon: 'layers', label: ['群像', 'Cast'] },
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
  return (
    <header className="nv-header">
      <Menu
        label={project.manifest.title}
        icon="book"
        items={[
          ...others.map(ref => ({ label: controller.sessionId !== undefined ? t(`${ref.title}（对话一起换过去）`, `${ref.title} (the conversation moves too)`) : ref.title, icon: 'book' as IconName, onSelect: () => { void controller.guard(async () => { await controller.openProject(ref.root) }) } })),
          ...(others.length > 0 ? ['separator' as const] : []),
          { label: t('书架 / 新建项目', 'Bookshelf / new project'), icon: 'plus', onSelect: () => { controller.closeProject() } },
          'separator' as const,
          { label: t('删除这本书…', 'Remove this book…'), icon: 'trash', danger: true, onSelect: () => { if (root !== undefined) removal.ask({ root, title: project.manifest.title }) } },
        ]}
      />
      {removal.element}
      {linked ? (
        <span className="nv-linked" title={t('左边的对话正在这本书上：Agent 的工具调用默认作用于它。在这里换书，对话跟着换；让 Agent 换书，这里也跟着换。', 'The conversation beside this panel is on this book: the agent\'s tool calls act on it. Change book here and the conversation follows; have the agent change book and this panel follows.')}>
          <Icon name="chat" size={12} />
          <span>{t('对话同步', 'In sync')}</span>
        </span>
      ) : null}
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
      {running.slice(0, shown).map((job) => {
        const pulse = jobPulse(job, t)
        const done = job.progress?.done ?? 0
        const total = job.progress?.total ?? 0
        return (
          <div key={job.id} className="nv-dock-row">
            <Spinner size={12} />
            <span className="nv-dock-title">{jobLabel(job, t, project)}</span>
            {total > 1 ? <span className="nv-dock-count">{done}/{total}</span> : null}
            <span className="nv-dock-pulse">{pulse ?? t('进行中…', 'working…')}</span>
            <span className="nv-dock-time">{elapsedOf(Date.parse(job.startedAt), now)}</span>
            {job.origin === 'agent' ? <span className="nv-dock-tag" title={t('这是对话里的总编发起的', 'Started by the showrunner in the conversation')}>{t('总编', 'agent')}</span> : null}
            <button type="button" className="nv-dock-stop" onClick={() => { void controller.cancelJob(job.id) }} title={t('停止', 'Stop')} aria-label={t('停止', 'Stop')}><Icon name="stop" size={11} /></button>
          </div>
        )
      })}
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
                  {job.status === 'running' && (job.progress !== undefined || job.thinking !== undefined) ? <Progress done={job.progress?.done ?? 0} total={job.progress?.total ?? 0} label={jobPulse(job, t)} /> : null}
                  {job.error !== undefined ? <span className="nv-job-error">{job.error}</span> : null}
                </div>
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

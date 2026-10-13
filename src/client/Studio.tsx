// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Studio shell: one React tree that runs both as the global "Novel Studio"
 * page and as a per-session tab in the right sidebar. It owns a controller,
 * shows the project chrome (title, navigation, mode, jobs, search) and routes
 * to the views.
 */
import { Component, Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { clip, formatCount } from '../shared/text'
import { WORK_MODES, type FiguresKept, type JobInfo, type ProjectRef, type ProjectState, type WorkMode } from '../shared/types'
import { figuresKeptWord } from './Guides'
import type { NovelApi } from './api'
import { JobBar } from './JobBar'
import { RecommendedNotice } from './Recommended'
import { Icon, type IconName } from './icons'
import { BatchMatrix, batchOf, GateNotes } from './Batch'
import { jobTarget, jobTitle, leftBehind, waitingLabel } from './labels'
import { StudioController, type Capability, type ReadMode, type StageTab, type StudioView } from './store'
import {
  Button, CrewRuns, cx, Empty, Menu, Modal, OverlayRootProvider, Popover, Progress, Spinner, StudioProvider, ThoughtButton, Toasts, useAction, useConfirm, useSnapshot, useStudio, useT,
  type StudioHost, type Translate,
} from './ui'
import { CoverProvider, CoverSwitch, RemoteButton, useCover, useCovering, useKeptDoor } from './Phone'
import { BibleView } from './views/Bible'
import { CastView } from './views/Cast'
import { HomeView, Onboarding, useRemoveBook } from './views/Home'
import { LockScreen, SealDialog } from './views/Lock'
import { OutlineView, planOfTextWord } from './views/Outline'
import { leadWord } from './Issues'
import { ReadView } from './views/Read'
import { ReviewView } from './views/Review'
import { SearchPanel } from './views/Search'
import { JotButton } from './views/Jottings'
import { SettingsView } from './views/Settings'
import { SetupView } from './views/Setup'
import { StageView } from './views/Stage'
import { UsageView } from './views/Usage'
import { WriteView } from './views/Write'
import { CallsDialog, useJobCalls } from './Calls'

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

/**
 * Puts the Studio's screens up again when a render of them throws.
 *
 * The host swaps the Studio's code in place when a new version is released, and renders the screen that is open with
 * the new code on the old screen's state. A screen whose hooks are not the same in the two versions then throws on
 * that render ("rendered more hooks than during the previous render") — and the host takes the whole Studio off the
 * screen: a blank panel where a book was, on every release that touched the page somebody happened to be on. Put up
 * afresh — the same book, the same page, the place is the controller's and stays — the new code renders.
 *
 * Twice in a few seconds at most: an error that comes straight back is the code's own, and is the host's to show.
 */
class Remount extends Component<{ children: ReactNode }, { round: number; caught?: unknown }> {
  override state: { round: number; caught?: unknown } = { round: 0 }
  private readonly times: number[] = []

  static getDerivedStateFromError(error: unknown): { caught: unknown } {
    return { caught: error }
  }

  override componentDidCatch(): void {
    const now = Date.now()
    while (this.times.length > 0 && now - this.times[0]! > 5000) this.times.shift()
    this.times.push(now)
    if (this.times.length <= 2) this.setState(state => ({ round: state.round + 1, caught: undefined }))
    else this.forceUpdate()
  }

  override render(): ReactNode {
    if (this.state.caught !== undefined) {
      if (this.times.length > 2) throw this.state.caught
      return null
    }
    return <Fragment key={this.state.round}>{this.props.children}</Fragment>
  }
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
  // On a small screen (and through the door for a phone) the page lies over DSH's own frame.
  const cover = useCover(host.where === 'page')
  return (
    <div ref={rootRef} className={cx('nv-root', host.where === 'page' && 'nv-root-page', cover.cover && 'nv-cover')} data-novel-studio="">
      <StudioProvider value={value}>
        <CoverProvider value={cover}>
        <OverlayRootProvider value={overlayRoot}>
          <Remount>
            <StaleHostNotice />
            <NoSwarmNotice />
            <RecommendedNotice />
            <Shell />
            <ActivityDock />
            <BookNotice />
            <JobNotice />
            <NeedsDialog />
            <Toasts />
          </Remount>
        </OverlayRootProvider>
      </CoverProvider>
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
      ? t(`对话已换到《${moved.title}》`, `The conversation is now on "${moved.title}"`)
      : t(`已跟着对话换到《${moved.title}》`, `Followed the conversation to "${moved.title}"`))
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
    if (ended.job.kind === 'revise' && ended.job.title === 'review by lead') {
      // What the author noticed, followed up: where it was found and what was changed for it — or that it was not found, and where the planner looked.
      const output = ended.job.result?.output as Parameters<typeof leadWord>[0]
      controller.toast((output?.found?.length ?? 0) > 0 ? 'success' : 'info', leadWord(output, t), 14000)
    } else if (ended.job.kind === 'revise' && ended.job.title === 'mend review') {
      // What a review found was mended by itself: said, since nobody pressed a button for it — how many changes wait, and where.
      const found = (ended.job.result?.output ?? {}) as { issues?: number; chapters?: number; places?: number; failed?: number; direct?: boolean; note?: string }
      const places = found.places ?? 0
      const failed = (found.failed ?? 0) > 0 ? t(`，${found.failed} 处没改成`, `, ${found.failed} failed`) : ''
      const note = found.note !== undefined && found.note.trim().length > 0 ? t(` 策划：${clip(found.note.trim(), 160)}`, ` The planner: ${clip(found.note.trim(), 160)}`) : ''
      if ((found.issues ?? 0) > 0) {
        controller.toast(places > 0 ? 'success' : 'info', places > 0
          ? t(`审校找到的 ${found.issues} 个问题修订好了：${places} 处修订${found.direct === true ? '（策划直接写的）' : ''}在各条问题下面等你确认${failed}。${note}`, `The ${found.issues} issue(s) the review found are mended: ${places} change(s)${found.direct === true ? ' (written by the planner itself)' : ''} wait beneath them${failed}.${note}`)
          : t(`审校找到的 ${found.issues} 个问题交给策划看过了，没有出修订${failed}。${note}`, `The planner read the ${found.issues} issue(s) the review found and made no change${failed}.${note}`), 12000)
      }
    } else if (ended.job.kind === 'revise' && ended.job.title === 'amend chapter') {
      // A chapter the writer went through: the places that changed wait as proposals; none changed is said with its reason.
      const found = (ended.job.result?.output ?? {}) as { places?: number; applied?: boolean; whole?: boolean; note?: string; refused?: string[]; figures?: FiguresKept; who?: 'writer' | 'planner' }
      // (Whose model did it: the writer's, or the planner's where the author set that.)
      const zhWho = found.who === 'planner' ? '策划' : '写手'
      const enWho = found.who === 'planner' ? 'planner' : 'writer'
      const places = found.places ?? 0
      const note = found.note !== undefined && found.note.length > 0 ? clip(found.note, 160) : undefined
      const kept = figuresKeptWord(found.figures, t, 'revised')
      if (places === 0) {
        controller.toast('info', `${(found.refused?.length ?? 0) > 0 ? t(`${zhWho}列出的 ${found.refused!.length} 处改动都对不上正文，这一章没有动。`, `None of the ${found.refused!.length} change(s) the ${enWho} listed could be found in the text: the chapter is as it was.`) : t('这一章没有改动。', 'Nothing in the chapter was changed.')}${note !== undefined ? t(`${zhWho}：${note}`, ` The ${enWho}: ${note}`) : ''}`, 12000)
      } else {
        controller.toast('success', `${found.applied === true
          ? t(`改了 ${places} 处，已写进正文。`, `${places} place(s) changed and written into the text.`)
          : found.whole === true
            ? t(`改了 ${places} 处：接着还没采纳的修改改的，合成了这一章的一条提案。`, `${places} place(s) changed: made on top of changes still waiting, so they are one proposal for the chapter.`)
            : t(`改了 ${places} 处，每处一条提案。`, `${places} place(s) changed — a proposal each.`)}${note !== undefined ? t(`${zhWho}：${note}`, ` The ${enWho}: ${note}`) : ''}${(found.refused?.length ?? 0) > 0 ? t(`（另有 ${found.refused!.length} 处对不上正文，没有改。）`, ` (${found.refused!.length} more could not be found in the text and were not made.)`) : ''}${kept !== undefined ? ` ${kept}` : ''}`, 9000)
      }
    } else if (ended.job.kind === 'write' || ended.job.kind === 'revise') {
      const said = figuresKeptWord((ended.job.result?.output as { figures?: FiguresKept } | undefined)?.figures, t, ended.job.kind === 'write' ? 'drafted' : 'revised')
      if (said !== undefined) controller.toast('info', ended.job.kind === 'write' ? `${said}${t('——在右栏“图”里可以挪', ' — move them in the Pictures column')}` : said, 9000)
      // A chapter written that is not what was asked in one way or another: the text is saved, and what fell short is said.
      const wrote = ended.job.kind === 'write' ? ended.job.result?.output as { short?: { asked: number; words: number }; parts?: number; partsOff?: boolean; undigested?: string; material?: { instead?: string; by?: string } } | undefined : undefined
      if (wrote?.short !== undefined) {
        controller.toast('info', t(
          `要的是约 ${wrote.short.asked} 字，写出来 ${wrote.short.words} 字。${wrote.parts !== undefined ? `已经按节拍分 ${wrote.parts} 次写了，各段都偏短。` : wrote.material?.by === 'agent' ? '' : wrote.partsOff === true ? '分节拍写关着（设置里“每次写几个节拍”填的是 0），是一次写完的：把那一项改回去，或者' : '这一章的章纲没有节拍，没法分几次写：先排节拍再写，'}可以点“续写”接着写。`,
          `About ${wrote.short.asked} words were asked for; ${wrote.short.words} were written. ${wrote.parts !== undefined ? `It was written in ${wrote.parts} parts by its beats, and each came out short.` : wrote.material?.by === 'agent' ? '' : wrote.partsOff === true ? 'Writing in parts is off (beats to a part is 0 in the settings), so it was written in one go: set that back — or ' : 'The chapter\'s plan has no beats to write it in parts by: lay out its beats first — or '}"Continue" goes on with it.`), 14000)
      }
      if (wrote?.undigested !== undefined) controller.toast('error', t(`正文存好了，但写完之后的收录没成：${wrote.undigested}。在右栏“记忆”里可以再点“收录”。`, `The text is saved, but the digest after it failed: ${wrote.undigested}. "Digest" in the memory panel tries again.`), 14000)
      if (wrote?.material?.instead !== undefined) controller.toast('info', t(`本来要写手作为 agent 自己读、自己写，没成（${wrote.material.instead}）：这一次是照备好的材料一次写完的。`, `The writer was to write this as an agent and it came to nothing (${wrote.material.instead}): it was written in one request from prepared material instead.`), 14000)
    } else if (batch !== undefined) {
      const done = batch.rows.reduce((sum, row) => sum + Object.values(row.steps).filter(step => step.state === 'done').length, 0)
      controller.toast(batch.failed > 0 ? 'info' : 'success', batch.failed > 0
        ? t(`批量任务结束：${done} 步完成，${batch.failed} 步失败，原因见“任务”`, `Batch finished: ${done} done, ${batch.failed} failed — see Tasks`)
        : t(`批量任务完成：${done} 步`, `The batch is done: ${done} steps`))
    } else if (ended.job.kind === 'derive') {
      // Plans were set by their changed texts: said, since the Studio did that by itself and the outline now reads otherwise.
      const found = (ended.job.result ?? {}) as { failed?: number; chapters?: { index: number; changed: string[]; beats: number; was: number; kept: number }[] }
      const chapters = found.chapters ?? []
      const only = chapters.length === 1 ? chapters[0]! : undefined
      if (only !== undefined) {
        const said = planOfTextWord({ what: 'plan', changed: only.changed, beats: Array.from({ length: only.beats }), was: only.was, kept: only.kept }, t)
        controller.toast('info', t(`正文改了，第 ${only.index} 章的${said}`, `Chapter ${only.index}'s text changed. ${said}`), 9000)
      } else if (chapters.length > 1) controller.toast('info', t(`${chapters.length} 章的章纲照正文更新了（第 ${chapters.map(chapter => chapter.index).join('、')} 章）。原来的在各章章纲的历史版本里。`, `The plans of ${chapters.length} chapters go by their texts now (chapters ${chapters.map(chapter => chapter.index).join(', ')}). What was there is in each plan's history.`), 9000)
      if ((found.failed ?? 0) > 0) controller.toast('error', t(`${found.failed} 章的章纲没能照正文更新，原因见“任务”`, `${found.failed} plan(s) could not be set by their text — see Tasks`))
    } else if (ended.job.kind === 'review') {
      // The open issues were looked at again after a revision: said, since it changes what the author still has to do.
      const found = (ended.job.result ?? {}) as { looked?: number; fixed?: number; changed?: number }
      if ((found.looked ?? 0) > 0) controller.toast((found.fixed ?? 0) > 0 ? 'success' : 'info', t(`核对了 ${found.looked} 条审校意见：${found.fixed ?? 0} 条已修好，${found.changed ?? 0} 条按新正文更新`, `Looked again at ${found.looked} issue(s): ${found.fixed ?? 0} mended, ${found.changed ?? 0} brought up to the text`))
    } else if (ended.job.kind === 'bible') {
      // The planner looked through the names without a card: said, since it puts suggestions where the author settles them.
      const found = (ended.job.result ?? {}) as { looked?: number; cards?: number; aliases?: number; walkOns?: number; settled?: { looked: number; entered: number; merged: number; skipped: number } }
      // What the digests proposed was settled: said, since things entered the bible that the author has not seen.
      if (found.settled !== undefined) {
        if (found.settled.looked > 0) controller.toast('success', t(`策划审定了 ${found.settled.looked} 条设定建议：收进 ${found.settled.entered}，并入 ${found.settled.merged}，没收 ${found.settled.skipped}——“审校 → 设定建议”里能改`, `The planner settled ${found.settled.looked} suggestion(s): ${found.settled.entered} entered, ${found.settled.merged} folded in, ${found.settled.skipped} left out — change it under Review → Suggestions`))
      } else if ((found.looked ?? 0) > 0) controller.toast((found.cards ?? 0) + (found.aliases ?? 0) > 0 ? 'success' : 'info', t(`策划看了 ${found.looked} 个没立卡的名字：${found.cards ?? 0} 个建议立卡，${found.aliases ?? 0} 个是别名，${found.walkOns ?? 0} 个留作龙套`, `The planner looked at ${found.looked} name(s) without a card: ${found.cards ?? 0} worth one, ${found.aliases ?? 0} another name of somebody, ${found.walkOns ?? 0} left as walk-ons`))
    } else if (ended.job.kind === 'audio' && typeof output.rendered === 'number') {
      const failed = output.failed ?? 0
      controller.toast(failed > 0 ? 'info' : 'success', failed > 0
        ? t(`语音合成结束：新合成 ${output.rendered} 句，${failed} 句失败`, `Speech finished: ${output.rendered} new, ${failed} failed`)
        : t(`语音合成完成：新合成 ${output.rendered} 句${(output.cached ?? 0) > 0 ? `，${output.cached} 句沿用已有的` : ''}`, `Speech done: ${output.rendered} new lines${(output.cached ?? 0) > 0 ? `, ${output.cached} reused` : ''}`))
    } else if (ended.job.kind === 'audio') controller.toast('success', t('有声脚本已编排好', 'The audio script is ready'))
    else controller.toast('success', `${t('有声漫这一步完成了', 'The motion-comic step is done')}${leftBehind(ended.job, t)}`)
  }, [controller, ended?.nonce])
  return null
}

const NEEDS: Record<Capability, { title: [string, string]; body: [string, string] }> = {
  tts: {
    title: ['还没有配置语音合成', 'Speech is not set up yet'],
    body: ['配音要用语音模型：贴一个百炼或 OpenRouter 的 key 即可。', 'Voices need a speech model: a Bailian or OpenRouter key sets one up.'],
  },
  image: {
    title: ['还没有配置图像生成', 'Image generation is not set up yet'],
    body: ['画图要用绘图模型：贴一个 key，或用已登录的 ChatGPT 订阅。', 'Pictures need an image model: paste a key, or use a signed-in ChatGPT subscription.'],
  },
  text: {
    title: ['有一个模型还缺密钥', 'A model is missing its key'],
    body: ['这一步用的接口还没有密钥：去设置里贴上，或让这个角色跟随对话模型。', 'The endpoint this step uses has no key: add it in Settings, or let the role follow the conversation\'s model.'],
  },
  embedding: {
    title: ['语义检索还缺密钥', 'Retrieval is missing its key'],
    body: ['语义检索的接口还没有密钥：去设置里贴上，或关掉它改用关键词检索。', 'The semantic search endpoint has no key: add it in Settings, or switch it off for keyword search.'],
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
  useKeptDoor(status !== 'loading' && status !== 'error')

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
        ? t(`后台已更新，${stopped} 个任务被中断`, `Backend updated; ${stopped} task(s) were interrupted`)
        : t('已换上新版本的后台。', 'The new backend is up.'))
    } catch (error) {
      setFailed(true)
      throw error
    }
  })
  const ask = (): void => {
    if (running > 0) confirm.ask(t(`有 ${running} 个任务正在进行，重启会中断它们；已解锁的加密书要重新解锁。现在重启？`, `${running} task(s) are running and a restart interrupts them; unlocked sealed books lock again. Restart now?`), () => { void change() })
    else void change()
  }
  const can = reloadable === true && !failed
  return (
    <div className="nv-banner is-warn nv-stale" role="status">
      <span>
        <Icon name="refresh" size={14} />
        <b>{can ? t('小说工坊更新了', 'Novel Studio was updated') : t('请重启 DSH', 'Restart DSH')}</b>
        {can
          ? t('——后台还是旧版本。', ' — the backend is still the old one.')
          : failed
            ? t('——后台没能换成新版本，请重启 DSH。', ' — the backend could not be replaced; restart DSH.')
            : t('——后台还是旧版本，这一次要重启 DSH。', ' — the backend is still the old one; restart DSH this once.')}
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
          ? t('——各个角色现在只能一问一答。请在 DSH“设置 → 插件”里启用 @deepseek-ai/dsh-subagent，再重启 DSH。', ' — every role can only answer one request at a time. Enable @deepseek-ai/dsh-subagent under DSH Settings → Plugins, then restart DSH.')
          : t('——这个 DSH 没有 agent 循环，各个角色只能一问一答。', ' — this DSH runs no agent loop: every role answers one request at a time.')}
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
  const covering = useCovering()
  // Nothing to show on the bookshelf of the global page — but the way back to DSH where the page covers it; in a tab the bar carries the full-screen switch.
  if (title === undefined && host.toggleMaximize === undefined && !covering.offered) return null
  return (
    <header className="nv-header">
      {title !== undefined ? <Button variant="ghost" size="sm" icon="chevronLeft" onClick={() => { controller.setView('home') }}>{t('返回', 'Back')}</Button> : null}
      <span className="nv-header-title">{title ?? t('小说工坊', 'Novel Studio')}</span>
      <span className="nv-spacer" />
      {title === undefined ? <Button variant="ghost" size="sm" icon="settings" onClick={() => { controller.setView('settings') }} title={t('设置', 'Settings')} /> : null}
      <CoverSwitch />
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
          ...others.map(ref => ({ label: ref.title, icon: 'book' as IconName, onSelect: () => { void controller.guard(async () => { await controller.openProject(ref.root) }) } })),
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
      {/* What the book is to whoever reads it — its text, its people, its world — stands apart from the pages where it is made. */}
      <button type="button" className={cx('nv-view-btn nv-header-view', view === 'read' && 'is-active')} aria-pressed={view === 'read'} onClick={() => { controller.setView('read') }} title={t('观看：读者看到的样子——正文、人物、世界', 'View: the book as a reader has it — text, people, world')}>
        <Icon name="eye" size={15} />
        <span>{t('观看', 'View')}</span>
      </button>
      <span className="nv-header-rule" aria-hidden="true" />
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
        {/* Pictures drawn to be compared that nobody has taken yet: kept, and found again from every page. */}
        {(project.waiting ?? 0) > 0 ? (
          <button type="button" className="nv-jobs-button" onClick={() => { controller.navigate({ view: 'stage', tab: 'gallery' }) }} title={t(`待采纳：${project.waiting} 张对比图留着没选，点开去选`, `To take: ${project.waiting} pictures drawn to compare are kept and not chosen yet — open to choose`)}>
            <Icon name="layers" size={14} />
            <span>{project.waiting}</span>
          </button>
        ) : null}
        <JotButton />
        <Button variant="ghost" size="sm" icon="search" onClick={onSearch} title={t('搜索与查找', 'Search and find')} />
        <Button variant="ghost" size="sm" icon="settings" className={cx((view === 'settings' || view === 'setup' || view === 'usage') && 'is-active')} onClick={() => { controller.setView('settings') }} title={t('设置', 'Settings')} />
        <RemoteButton />
        <CoverSwitch />
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
        <button type="button" className={cx('nv-linked', open && 'is-open')} aria-expanded={open} onClick={toggle} title={t('对话和这块面板在同一本书上', 'The conversation and this panel are on the same book')}>
          <Icon name="chat" size={12} />
          <span>{t('对话同步', 'In sync')}</span>
        </button>
      )}
    >
      {close => (
        <>
          <strong>{t(`对话正在《${title}》上`, `The conversation is on "${title}"`)}</strong>
          <p>{t('在这里换书，对话跟着换；让总编换书，这里也跟着换。', 'Change book here and the conversation follows; ask the showrunner to change book and this panel follows.')}</p>
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
  const [calls, setCalls] = useState(false)
  // What one job sent to a model and got back: opened from its row — every kind of job has the button, and says how many requests are on record.
  const [asked, setAsked] = useState<{ id: string; name: string } | undefined>()
  const requests = useJobCalls(open)
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
                  {job.title === 'derive chapters preview' && job.status === 'done' && project?.derived !== undefined && job.project === project.root
                    ? <button type="button" className="nv-link nv-small" onClick={() => { setOpen(false); controller.showDerived() }}>{t(`看推演出的 ${project.derived.chapters} 章（还没加入大纲）`, `See the ${project.derived.chapters} chapter(s) derived (not in the outline yet)`)}</button>
                    : null}
                  <CrewRuns job={job} />
                </div>
                <ThoughtButton job={job} label />
                {project !== undefined && job.project === project.root ? (
                  <Button size="sm" variant="ghost" icon="list" title={t('这件任务发给模型的请求：每一个发了什么、回了什么（角色作为 agent 干活时一步一个）', 'The requests this job sent to a model: what each sent and got back (a role working as an agent makes one a step)')} onClick={() => { setAsked({ id: job.id, name: jobLabel(job, t, project) }) }}>
                    {(requests.get(job.id) ?? 0) > 0 ? t(`请求 ${requests.get(job.id)}`, `Requests ${requests.get(job.id)}`) : t('请求', 'Requests')}
                  </Button>
                ) : null}
                {job.status === 'running'
                  ? <Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(job.id) }}>{t('停止', 'Stop')}</Button>
                  : <span className="nv-job-status">{job.status === 'done' ? t('完成', 'done') : job.status === 'failed' ? t('失败', 'failed') : t('已取消', 'cancelled')}</span>}
              </li>
            ))}
          </ul>
          {/* What each of these sent to a model and got back is on record, where a book is open. */}
          {project !== undefined ? <p className="nv-muted nv-small nv-jobs-calls">{t('每一行的“请求”是那件任务发给模型的；整本书的：', 'Requests on a row are what that job sent to a model; the whole book\'s: ')}<button type="button" className="nv-link" onClick={() => { setCalls(true) }}>{t('调用记录…', 'the record of calls…')}</button></p> : null}
        </Modal>
      ) : null}
      {calls && project !== undefined ? <CallsDialog onClose={() => { setCalls(false) }} /> : null}
      {asked !== undefined && project !== undefined ? <CallsDialog job={asked} onClose={() => { setAsked(undefined) }} /> : null}
    </>
  )
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Motion comic of one chapter: a storyboard whose panels are tied to the audio
 * script, drawn by the image model, and played with slow camera moves under
 * the voices and the ambience. How finely the chapter is cut — a few pictures
 * or many, or however the director sees fit, and never more than a ceiling —
 * is set here, per book.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ChapterSwitch } from '../ChapterSwitch'
import { Icon } from '../icons'
import { PANEL_SECONDS, STORYBOARD_DENSITIES, type AudioLine, type CameraMove, type ChapterInfo, type ComicPanel, type StoryboardDensity } from '../../shared/types'
import { AMBIENCE, CAMERA, DENSITY, DENSITY_HINT } from '../labels'
import {
  Button, Chip, cx, Empty, Field, Modal, Progress, ProjectImage, Select, Spinner, TextArea, TextInput, useAction, useConfirm, useLoad, useMediaUrl, useProject, useSnapshot,
  useStudio, useT,
} from '../ui'
import { NeedsSetup } from '../views/Settings'
import { formatDuration, JobProgress, PlayerControls, usePlayerOptions } from './Audio'
import { place, secondsOf, Theater, useCurrentPanel } from '../reader/theater'
import { useLinePlayer } from './player'
import { chapterJob, inBatch, type ChapterJob } from '../Batch'
import { VideoCard } from './Video'

export function ComicStage({ chapter }: { chapter: ChapterInfo | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const mediaUrl = useMediaUrl()
  const [options, updateOptions] = usePlayerOptions()
  const [editing, setEditing] = useState<ComicPanel | undefined>()
  /** Panels chosen to be acted on together. */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const stage = useRef<HTMLDivElement>(null)
  // Work started here for this chapter, or the step of a running batch that is on it right now.
  const job: ChapterJob | undefined = jobs.find(item => item.status === 'running' && (item.kind === 'comic' || (item.kind === 'audio' && item.title !== 'audition')) && (item.target === chapter?.id || item.result?.chapterId === chapter?.id)) ?? chapterJob(jobs, chapter?.id, ['draw panels', 'storyboard', 'synthesize', 'sound', 'audio script'])
  const batch = inBatch(jobs, chapter?.id)
  // What is set up decides which steps one click can do.
  const ready = useSnapshot(snapshot => snapshot.settings?.ready)
  const board = useLoad(async signal => chapter !== undefined ? await controller.api.call('comic.board', { root, chapter: chapter.id }, signal) : undefined, [root, chapter?.id, project.revision, job === undefined])
  const audio = useLoad(async signal => chapter !== undefined ? await controller.api.call('audio.script', { root, chapter: chapter.id }, signal) : undefined, [root, chapter?.id, project.revision, job === undefined])
  const lines = useMemo(() => audio.data?.script?.lines ?? [], [audio.data])
  const cues = useMemo(() => audio.data?.script?.cues ?? [], [audio.data])
  const panels = useMemo(() => board.data?.board?.panels ?? [], [board.data])
  const placed = useMemo(() => place(panels, lines), [panels, lines])
  const { player, state } = useLinePlayer(lines, cues, mediaUrl, options)
  const current = useCurrentPanel(placed, player, state)

  // What the book asks of its storyboards; the controls below start from it.
  const saved = project.manifest.storyboard
  const [density, setDensity] = useState<StoryboardDensity>(saved?.density ?? 'balanced')
  const [ceiling, setCeiling] = useState(saved?.maxPanels !== undefined ? String(saved.maxPanels) : '')
  useEffect(() => {
    setDensity(saved?.density ?? 'balanced')
    setCeiling(saved?.maxPanels !== undefined ? String(saved.maxPanels) : '')
  }, [saved?.density, saved?.maxPanels])

  if (chapter === undefined) return <Empty icon="film" title={t('还没有可以演出的章节', 'No chapter to perform yet')}>{t('先写出至少一章正文。', 'Write at least one chapter first.')}</Empty>
  if (board.data === undefined || audio.data === undefined) return <div className="nv-center">{board.error ?? audio.error ?? <Spinner />}</div>

  const drawn = panels.filter(panel => panel.image !== undefined).length
  const total = lines.reduce((sum, item) => sum + secondsOf(item), 0)
  const limit = /^\d+$/.test(ceiling) && Number(ceiling) > 0 ? Number(ceiling) : undefined
  // What the chosen cut comes to for this chapter, before anything is asked of a model.
  const estimate = lines.length === 0 ? undefined
    : density === 'auto'
      ? t(`由导演决定，大约 ${Math.max(1, Math.ceil(total / 40))}–${Math.max(1, Math.min(limit ?? Infinity, Math.floor(total / 4)))} 格`, `The director decides: about ${Math.max(1, Math.ceil(total / 40))}-${Math.max(1, Math.min(limit ?? Infinity, Math.floor(total / 4)))} panels`)
      : t(`约 ${Math.max(1, Math.min(limit ?? Infinity, Math.round(total / PANEL_SECONDS[density])))} 格`, `about ${Math.max(1, Math.min(limit ?? Infinity, Math.round(total / PANEL_SECONDS[density])))} panels`)
  const changed = density !== (board.data.board?.density ?? saved?.density ?? 'balanced') || limit !== (board.data.board?.maxPanels ?? saved?.maxPanels)
  const working = busy || job !== undefined || batch !== undefined
  const voicedAll = lines.length > 0 && lines.filter(item => item.skip !== true).every(item => item.audio !== undefined)
  // Something of this chapter's motion comic is still to make.
  const unfinished = lines.length === 0 || panels.length === 0 || board.data.stale || drawn < panels.length || !voicedAll
  /** Everything this chapter's motion comic needs, in one go: script, voices, sound, storyboard, pictures. */
  const makeAll = (): Promise<unknown> => run(async () => {
    player.stop()
    if (density !== (saved?.density ?? 'balanced') || limit !== saved?.maxPanels) {
      await controller.api.call('project.update', { root, patch: { storyboard: { density, ...(limit !== undefined ? { maxPanels: limit } : {}) } } })
    }
    await controller.api.call('batch.stage', {
      root,
      chapters: [chapter.id],
      steps: ['script', ...(ready?.tts === true ? ['voice' as const] : []), ...(ready?.sound === true ? ['sound' as const] : []), 'storyboard', ...(ready?.image === true ? ['panels' as const] : [])],
      density,
      ...(limit !== undefined ? { maxPanels: limit } : {}),
    })
    await controller.refreshJobs()
  })

  /** Cut the chapter anew with what the controls say, and keep that as the book's setting. */
  const cut = (force: boolean): Promise<unknown> => run(async () => {
    player.stop()
    if (density !== (saved?.density ?? 'balanced') || limit !== saved?.maxPanels) {
      await controller.api.call('project.update', { root, patch: { storyboard: { density, ...(limit !== undefined ? { maxPanels: limit } : {}) } } })
    }
    await controller.api.call('comic.build', { root, chapter: chapter.id, force, density, ...(limit !== undefined ? { maxPanels: limit } : {}) })
    await controller.refreshJobs()
  })
  const render = (params: { force?: boolean; panels?: string[] } = {}): Promise<unknown> | undefined => {
    // Drawing needs an image model; the storyboard itself does not.
    if (!controller.need('image')) return undefined
    return run(async () => {
      player.stop()
      await controller.api.call('comic.render', { root, chapter: chapter.id, ...params })
      await controller.refreshJobs()
    })
  }
  // Only the button whose work is running says so; the others wait their turn.
  const storyboarding = job !== undefined && job.kind === 'comic' && job.title === 'storyboard'
  const drawing = job !== undefined && job.kind === 'comic' && job.title !== 'storyboard'
  const voicing = job !== undefined && job.kind === 'audio'

  return (
    <div className="nv-comic">
      <section className="nv-card nv-audio-head">
        <div className="nv-audio-summary">
          <ChapterSwitch chapter={chapter} onChange={(id) => { controller.focusChapter(id) }} usable={candidate => candidate.hasText} unusable={t('还没有正文', 'nothing written yet')} />
          {panels.length > 0 ? <span className="nv-muted nv-small">{t(`${panels.length} 格 · 已绘 ${drawn} · 配音 ${lines.filter(item => item.audio !== undefined).length}/${lines.length} · ${formatDuration(total)}`, `${panels.length} panels · ${drawn} drawn · ${lines.filter(item => item.audio !== undefined).length}/${lines.length} lines voiced · ${formatDuration(total)}`)}</span> : null}
          {board.data.stale ? <Chip tone="amber">{t('分镜已过期', 'Storyboard is stale')}</Chip> : null}
        </div>
        <div className="nv-density">
          <Field label={t('分镜密度', 'How finely to cut')} hint={t(...DENSITY_HINT[density])}>
            <Select value={density} options={STORYBOARD_DENSITIES.map(value => ({ value, label: t(...DENSITY[value]) }))} onChange={setDensity} />
          </Field>
          <Field label={t('最多几格', 'At most')} hint={t('留空不限；每一格都要画一张图', 'Empty for no ceiling; every panel is a picture to draw')}>
            <TextInput inputMode="numeric" value={ceiling} placeholder={t('不限', 'no limit')} onChange={(event) => { setCeiling(event.target.value.replace(/\D/g, '').slice(0, 3)) }} />
          </Field>
          <div className="nv-density-go">
            {estimate !== undefined ? <span className="nv-muted nv-small">{t('这一章：', 'This chapter: ')}{estimate}</span> : <span className="nv-muted nv-small">{t('有了有声脚本才能估算格数', 'The count can be estimated once there is an audio script')}</span>}
            {unfinished ? (
              <Button variant="primary" icon="layers" busy={job?.batch === true} disabled={working} pending={t('正在一键制作…', 'Producing…')} onClick={makeAll} title={t(`一次做完这一章的有声漫：脚本${ready?.tts === true ? '、配音' : ''}${ready?.sound === true ? '、声音' : ''}、分镜${ready?.image === true ? '、画面' : ''}。脚本排好以后几步同时进行；已经做好的不会重做。`, `This chapter's motion comic in one go: script${ready?.tts === true ? ', voices' : ''}${ready?.sound === true ? ', sound' : ''}, storyboard${ready?.image === true ? ', pictures' : ''}. Once the script stands the rest is made side by side; what is there already is not made again.`)}>{t('一键制作这一章', 'Produce this chapter')}</Button>
            ) : null}
            <Button variant={!unfinished && (board.data.stale || changed) ? 'primary' : 'outline'} icon="sparkles" busy={storyboarding} disabled={working} pending={t('正在编排分镜…', 'Storyboarding…')} onClick={() => cut(panels.length > 0)}>
              {panels.length === 0 ? t('生成分镜', 'Storyboard it') : board.data.stale ? t('按新正文重做分镜', 'Redo the storyboard') : changed ? t('按这个密度重做分镜', 'Redo with this cut') : t('重做分镜', 'Redo the storyboard')}
            </Button>
          </div>
        </div>
        {panels.length > 0 ? (
          <div className="nv-row-wrap">
            <Button icon="image" busy={drawing} pending={t('正在绘制…', 'Drawing…')} disabled={working || drawn === panels.length} onClick={() => render()}>{drawn === 0 ? t(`绘制全部 ${panels.length} 格`, `Draw all ${panels.length} panels`) : drawn < panels.length ? t(`绘制剩余 ${panels.length - drawn} 格`, `Draw the other ${panels.length - drawn}`) : t('全部已绘', 'All drawn')}</Button>
            {lines.some(item => item.audio === undefined) ? <Button icon="mic" busy={voicing} disabled={working} pending={t('正在合成配音…', 'Voicing…')} onClick={() => (!controller.need('tts') ? undefined : run(async () => { await controller.api.call('audio.synthesize', { root, chapter: chapter.id }); await controller.refreshJobs() }))}>{t('合成配音', 'Synthesize voices')}</Button> : null}
            <Button variant="ghost" icon="headphones" onClick={() => { controller.openReader('listen', chapter.id) }}>{t('去"听"里制作配音', 'Voices are made under Listen')}</Button>
            <span className="nv-spacer" />
            <Button variant="ghost" icon="trash" disabled={working} onClick={() => { confirm.ask(t('删除这一章的整份分镜？画好的图还留在画廊里（可以在那里逐张删），重新生成分镜后要重新绘制。', 'Delete this chapter\'s whole storyboard? The pictures drawn for it stay in the gallery (where each can be deleted); a storyboard cut again has to be drawn again.'), () => { void run(async () => { player.stop(); await controller.api.call('comic.clear', { root, chapter: chapter.id }); controller.toast('success', t('已删除这一章的分镜', 'The storyboard is deleted')); board.reload() }) }) }} title={t('删除这一章的分镜', 'Delete this chapter\'s storyboard')} />
          </div>
        ) : null}
        {board.data.board?.note !== undefined ? <p className="nv-note">{board.data.board.note}</p> : null}
        <NeedsSetup what="image">{t('分镜可以先做，画面要等它。', 'The storyboard can be made first; the pictures wait for it.')}</NeedsSetup>
        <NeedsSetup what="tts" />
        {job === undefined && batch !== undefined ? <p className="nv-note"><Spinner size={12} /> {t('批量制作正在处理这一章（现在在做别的步骤，或者排在后面）。', 'A batch is at work on this chapter (on another step right now, or it is waiting its turn).')} <button type="button" className="nv-link" onClick={() => { controller.navigate({ view: 'stage', tab: 'production' }) }}>{t('看整体进度', 'See the whole batch')}</button></p> : null}
        {job !== undefined && job.kind === 'audio' ? <JobProgress job={job} synthesizing={job.title === 'synthesize'} onStop={() => { void controller.cancelJob(job.id) }} /> : job !== undefined ? (
          <div className="nv-jobprogress" role="status">
            <div className="nv-jobprogress-head">
              <Spinner size={13} />
              <strong>{storyboarding ? t('正在编排分镜', 'Storyboarding') : t('正在绘制画面', 'Drawing the panels')}{job.progress !== undefined && job.progress.total > 0 ? `：${job.progress.done} / ${job.progress.total}` : '…'}</strong>
              <span className="nv-spacer" />
              <Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(job.id) }}>{t('停止', 'Stop')}</Button>
            </div>
            <Progress done={job.progress?.done ?? 0} total={job.progress?.total ?? 0} />
            {job.thinking !== undefined ? <p className="nv-jobprogress-now">{t(`模型思考中（${job.thinking} 字）…`, `The model is thinking (${job.thinking} chars)…`)}</p> : job.progress?.label !== undefined ? <p className="nv-jobprogress-now">{job.progress.label}</p> : null}
          </div>
        ) : null}
      </section>

      {panels.length === 0 ? (
        <Empty icon="film" title={t('这一章还没有分镜', 'This chapter has no storyboard yet')}>
          {t('分镜把有声脚本编成一格格画面：每格写明画面内容、出场人物与镜头运动，在对应的台词播放时停留在屏幕上；长段旁白也可以中途换画面。人物外貌取自人物卡，所以同一个人在每一格里长得一样。上面可以选要切得多细。', 'A storyboard arranges the audio script into panels: each names what is shown, who is in it and how the camera moves, and stays on screen while its lines play — a long narration can change picture midway. Looks come from each character card, so a person stays the same from panel to panel. Choose above how finely to cut.')}
        </Empty>
      ) : (
        <>
          <Theater t={t} player={player} state={state} lines={lines} cues={cues} current={current} media={path => mediaUrl(path)} options={options} speakerOf={line => project.characters.find(card => card.id === line.speaker)?.name}>
            <PlayerControls options={options} update={updateOptions} t={t} />
          </Theater>

          <PanelDeck
            ids={placed.map(item => item.panel.id)}
            picked={picked}
            onPick={setPicked}
            actions={(
              <>
                <Button size="sm" icon="refresh" disabled={job !== undefined || picked.size === 0} onClick={() => render({ panels: [...picked], force: true })} title={t('把选中的这些格重新画一遍', 'Draw the chosen panels again')}>{t(`重画选中的 ${picked.size} 格`, `Redraw the ${picked.size} chosen`)}</Button>
                <Button size="sm" variant="danger" icon="trash" disabled={working || picked.size === 0} onClick={() => {
                  const ids = [...picked]
                  confirm.ask(t(`删除选中的 ${ids.length} 格分镜？它们的台词并到相邻的格里；画好的图还留在画廊。`, `Delete the ${ids.length} chosen panels? Their lines go to the panels beside them; pictures already drawn stay in the gallery.`), () => {
                    void run(async () => {
                      for (const id of ids) await controller.api.call('comic.removePanel', { root, chapter: chapter.id, panel: id })
                      setPicked(new Set())
                      board.reload()
                    })
                  })
                }}>{t(`删除选中的 ${picked.size} 格`, `Delete the ${picked.size} chosen`)}</Button>
              </>
            )}
          >
            {placed.map(({ panel, from, seconds }, index) => (
              <li key={panel.id} data-panel={panel.id} className={cx('nv-cpanel', panel.id === current?.panel.id && state.status !== 'idle' && 'is-current', picked.has(panel.id) && 'is-picked')}>
                <button type="button" className="nv-cpanel-thumb" onClick={() => { player.play(Math.floor(from)) }} title={t('从这一格播放', 'Play from this panel')}>
                  {panel.image !== undefined ? <ProjectImage path={panel.image} alt={panel.description} /> : <span className="nv-cpanel-empty">{index + 1}</span>}
                </button>
                <div className="nv-cpanel-body">
                  <p>{panel.description}</p>
                  <div className="nv-row-wrap">
                    <Chip>{t(...CAMERA[panel.camera])}</Chip>
                    <span className="nv-muted nv-small">{t(`约 ${Math.max(1, Math.round(seconds))} 秒`, `about ${Math.max(1, Math.round(seconds))}s`)}</span>
                    {panel.error !== undefined ? <Chip tone="red" title={panel.error}>{t('绘制失败', 'failed')}</Chip> : null}
                    <span className="nv-spacer" />
                    <Button size="sm" variant="ghost" icon="pen" onClick={() => { setEditing(panel) }} title={t('修改这一格', 'Edit this panel')} />
                    <Button size="sm" variant="ghost" icon="refresh" disabled={job !== undefined} pending={t('正在开始重画…', 'Starting…')} onClick={() => render({ panels: [panel.id], force: true })} title={t('重画这一格', 'Draw this panel again')} />
                  </div>
                </div>
              </li>
            ))}
          </PanelDeck>
        </>
      )}

      {/* Offered once there is something to cut from: a script at least. */}
      {lines.length > 0 ? <VideoCard chapter={chapter} /> : null}

      {editing !== undefined ? <PanelEditor chapterId={chapter.id} panel={editing} onClose={() => { setEditing(undefined) }} onSaved={() => { board.reload() }} /> : null}
      {confirm.element}
    </div>
  )
}

const DECK_KEY = 'novel-studio:panel-deck'

/**
 * The panels of a chapter, in a place of their own height: a chapter cut
 * finely has dozens, and laid out in full they push everything under them off
 * the page. Here they scroll in their own frame — a grid that scrolls down, or
 * one row that scrolls sideways — whose lower edge can be dragged; and several
 * can be chosen at once to be redrawn or removed together: tick them, click
 * one and Shift-click another for the stretch between, or drag a box over them.
 * @param ids - the panels, in order; each child carries `data-panel` with its id.
 */
function PanelDeck({ ids, picked, onPick, actions, children }: { ids: string[]; picked: Set<string>; onPick: (next: Set<string>) => void; actions: ReactNode; children: ReactNode }) {
  const t = useT()
  const [layout, setLayoutState] = useState<'grid' | 'strip'>(() => {
    try {
      return localStorage.getItem(DECK_KEY) === 'strip' ? 'strip' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const setLayout = (next: 'grid' | 'strip'): void => {
    setLayoutState(next)
    try {
      localStorage.setItem(DECK_KEY, next)
    } catch {
      // Kept for this visit only.
    }
  }
  const [choosing, setChoosing] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  // As tall as its panels up to about two rows of them; taller or shorter once the author has dragged its edge.
  const [height, setHeight] = useState<number | undefined>(() => {
    try {
      const kept = Number(localStorage.getItem(`${DECK_KEY}:height`))
      return Number.isFinite(kept) && kept >= 150 ? kept : undefined
    } catch {
      return undefined
    }
  })
  const sizing = useRef<{ y: number; from: number } | undefined>(undefined)
  const last = useRef<string | undefined>(undefined)
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | undefined>()
  const drag = useRef<{ x: number; y: number; base: Set<string>; moved: boolean } | undefined>(undefined)
  const toggle = (id: string, range: boolean): void => {
    const next = new Set(picked)
    const from = last.current !== undefined ? ids.indexOf(last.current) : -1
    const to = ids.indexOf(id)
    if (range && from >= 0 && to >= 0) for (const between of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(between)
    else if (next.has(id)) next.delete(id)
    else next.add(id)
    last.current = id
    onPick(next)
  }
  // While choosing, a press on a panel picks it instead of doing what the panel's own buttons do.
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!choosing || drag.current?.moved === true) return
    const item = (event.target as Element).closest<HTMLElement>('[data-panel]')
    if (item === null) return
    event.preventDefault()
    event.stopPropagation()
    toggle(item.dataset.panel!, event.shiftKey)
  }
  const under = (area: { left: number; top: number; right: number; bottom: number }): string[] => {
    const found: string[] = []
    for (const item of frame.current?.querySelectorAll<HTMLElement>('[data-panel]') ?? []) {
      const rect = item.getBoundingClientRect()
      if (rect.right >= area.left && rect.left <= area.right && rect.bottom >= area.top && rect.top <= area.bottom) found.push(item.dataset.panel!)
    }
    return found
  }
  const all = ids.length > 0 && ids.every(id => picked.has(id))
  return (
    <section className="nv-deck">
      <div className="nv-deck-bar">
        <span className="nv-muted nv-small">{choosing ? t(`已选 ${picked.size} / ${ids.length} 格`, `${picked.size} of ${ids.length} chosen`) : t(`${ids.length} 格分镜`, `${ids.length} panels`)}</span>
        {choosing ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => { onPick(all ? new Set() : new Set(ids)) }}>{all ? t('都不选', 'None') : t('全选', 'All')}</Button>
            {actions}
            <Button size="sm" variant="ghost" onClick={() => { setChoosing(false); onPick(new Set()) }}>{t('完成', 'Done')}</Button>
          </>
        ) : ids.length > 1 ? <Button size="sm" variant="ghost" icon="check" onClick={() => { setChoosing(true) }} title={t('选几格一起重画或删除：点选、Shift 连选，或在空白处拖出一个框', 'Choose several panels to redraw or delete together: click, Shift-click a stretch, or drag a box from an empty spot')}>{t('多选', 'Choose several')}</Button> : null}
        <span className="nv-spacer" />
        <span className="nv-deck-layout" role="group" aria-label={t('分镜的排法', 'How the panels are laid out')}>
          <button type="button" className={cx(layout === 'grid' && 'is-active')} onClick={() => { setLayout('grid') }} title={t('排成几行，上下滚动', 'In rows, scrolling down')}><Icon name="layers" size={13} />{t('网格', 'Grid')}</button>
          <button type="button" className={cx(layout === 'strip' && 'is-active')} onClick={() => { setLayout('strip') }} title={t('排成一行，左右滑动', 'In one row, scrolling sideways')}><Icon name="film" size={13} />{t('横排', 'Strip')}</button>
        </span>
      </div>
      <div
        ref={frame}
        className={cx('nv-deck-frame', `is-${layout}`, choosing && 'is-choosing')}
        style={layout === 'grid' && height !== undefined ? { height, maxHeight: 'none' } : undefined}
        onClickCapture={onClick}
        onPointerDown={(event) => {
          // A box is drawn from an empty spot: a press on a panel is the panel's.
          if (!choosing || event.button !== 0 || (event.target as Element).closest('[data-panel]') !== null) return
          drag.current = { x: event.clientX, y: event.clientY, base: event.shiftKey ? new Set(picked) : new Set(), moved: false }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const from = drag.current
          const host = frame.current
          if (from === undefined || host === null) return
          const area = { left: Math.min(from.x, event.clientX), top: Math.min(from.y, event.clientY), right: Math.max(from.x, event.clientX), bottom: Math.max(from.y, event.clientY) }
          if (!from.moved && area.right - area.left < 4 && area.bottom - area.top < 4) return
          from.moved = true
          const rect = host.getBoundingClientRect()
          setBox({ left: area.left - rect.left + host.scrollLeft, top: area.top - rect.top + host.scrollTop, width: area.right - area.left, height: area.bottom - area.top })
          onPick(new Set([...from.base, ...under(area)]))
        }}
        onPointerUp={() => {
          setBox(undefined)
          // Let the click that follows the release pass before a press counts as a press again.
          setTimeout(() => { drag.current = undefined }, 0)
        }}
        onPointerCancel={() => { setBox(undefined); drag.current = undefined }}
      >
        <ol className="nv-cpanels">{children}</ol>
        {box !== undefined ? <div className="nv-deck-box" style={box} /> : null}
      </div>
      {layout === 'grid' ? (
        <div
          className="nv-deck-grip"
          role="separator"
          aria-orientation="horizontal"
          title={t('拖动调整这一栏的高度；双击恢复默认', 'Drag to change the height of this frame; double-click for the default')}
          onDoubleClick={() => {
            setHeight(undefined)
            try { localStorage.removeItem(`${DECK_KEY}:height`) } catch { /* nothing kept */ }
          }}
          onPointerDown={(event) => {
            sizing.current = { y: event.clientY, from: frame.current?.getBoundingClientRect().height ?? 300 }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const from = sizing.current
            if (from === undefined) return
            setHeight(Math.round(Math.min(window.innerHeight * 0.9, Math.max(150, from.from + event.clientY - from.y))))
          }}
          onPointerUp={() => {
            sizing.current = undefined
            try { if (height !== undefined) localStorage.setItem(`${DECK_KEY}:height`, String(height)) } catch { /* kept for this visit only */ }
          }}
          onPointerCancel={() => { sizing.current = undefined }}
        ><span /></div>
      ) : null}
    </section>
  )
}

function PanelEditor({ chapterId, panel, onClose, onSaved }: { chapterId: string; panel: ComicPanel; onClose: () => void; onSaved: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const { busy, run } = useAction()
  const [description, setDescription] = useState(panel.description)
  const [prompt, setPrompt] = useState(panel.prompt)
  const [camera, setCamera] = useState<CameraMove>(panel.camera)
  const confirm = useConfirm()
  return (
    <Modal wide title={t('修改这一格', 'Edit panel')} onClose={onClose} footer={(
      <>
        <Button variant="ghost" icon="trash" disabled={busy} onClick={() => { confirm.ask(t('删除这一格？它对着的台词会并给前一格（它是第一格时并给后一格），所以不会有哪句话没有画面；画好的图还留在画廊里。', 'Delete this panel? The lines it stayed on screen for go to the panel before it (after it, when it is the first), so no line is left without a picture; its drawing stays in the gallery.'), () => { void run(async () => { await controller.api.call('comic.removePanel', { root, chapter: chapterId, panel: panel.id }); controller.toast('success', t('已删除这一格', 'Panel deleted')); onSaved(); onClose() }) }) }}>{t('删除这一格', 'Delete this panel')}</Button>
        <span className="nv-spacer" />
        <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} onClick={() => run(async () => { await controller.api.call('comic.updatePanel', { root, chapter: chapterId, panel: panel.id, patch: { description, prompt, camera } }); onSaved(); onClose() })}>{t('保存', 'Save')}</Button>
      </>
    )}>
      {confirm.element}
      <Field label={t('画面内容', 'What it shows')}><TextArea value={description} minRows={2} onChange={(event) => { setDescription(event.target.value) }} /></Field>
      <Field label={t('绘图提示词', 'Image prompt')} hint={t('改动提示词会清除已有画面，需要重画', 'Changing the prompt clears the picture; it has to be drawn again')}><TextArea value={prompt} minRows={5} maxRows={16} onChange={(event) => { setPrompt(event.target.value) }} /></Field>
      <Field label={t('镜头运动', 'Camera move')}><Select value={camera} options={(Object.keys(CAMERA) as CameraMove[]).map(value => ({ value, label: t(...CAMERA[value]) }))} onChange={setCamera} /></Field>
    </Modal>
  )
}

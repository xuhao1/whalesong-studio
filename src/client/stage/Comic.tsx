// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Motion comic of one chapter: a storyboard whose panels are tied to the audio
 * script, drawn by the image model, and played with slow camera moves under
 * the voices and the ambience. How finely the chapter is cut — a few pictures
 * or many, or however the director sees fit, and never more than a ceiling —
 * is set here, per book.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { PANEL_SECONDS, STORYBOARD_DENSITIES, type AudioLine, type CameraMove, type ChapterInfo, type ComicPanel, type StoryboardDensity } from '../../shared/types'
import { AMBIENCE, CAMERA, DENSITY, DENSITY_HINT } from '../labels'
import {
  Button, Chip, cx, Empty, Field, Modal, Progress, ProjectImage, Select, Spinner, TextArea, TextInput, useAction, useLoad, useMediaUrl, useProject, useSnapshot,
  useStudio, useT,
} from '../ui'
import { NeedsSetup } from '../views/Settings'
import { formatDuration, JobProgress, PlayerControls, usePlayerOptions } from './Audio'
import { place, secondsOf, Theater, useCurrentPanel } from '../reader/theater'
import { useLinePlayer } from './player'

export function ComicStage({ chapter }: { chapter: ChapterInfo | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const mediaUrl = useMediaUrl()
  const [options, updateOptions] = usePlayerOptions()
  const [editing, setEditing] = useState<ComicPanel | undefined>()
  const { busy, run } = useAction()
  const stage = useRef<HTMLDivElement>(null)
  const job = jobs.find(item => item.status === 'running' && (item.kind === 'comic' || (item.kind === 'audio' && item.title !== 'audition')) && (item.target === chapter?.id || item.result?.chapterId === chapter?.id))
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
  const working = busy || job !== undefined

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
          <strong>{t(`第 ${chapter.index} 章 ${chapter.title}`, `Chapter ${chapter.index} · ${chapter.title}`)}</strong>
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
            <Button variant={panels.length === 0 || board.data.stale || changed ? 'primary' : 'outline'} icon="sparkles" busy={storyboarding} disabled={working} pending={t('正在编排分镜…', 'Storyboarding…')} onClick={() => cut(panels.length > 0)}>
              {panels.length === 0 ? t('生成分镜', 'Storyboard it') : board.data.stale ? t('按新正文重做分镜', 'Redo the storyboard') : changed ? t('按这个密度重做分镜', 'Redo with this cut') : t('重做分镜', 'Redo the storyboard')}
            </Button>
          </div>
        </div>
        {panels.length > 0 ? (
          <div className="nv-row-wrap">
            <Button variant={drawn < panels.length ? 'primary' : 'outline'} icon="image" busy={drawing} pending={t('正在绘制…', 'Drawing…')} disabled={working || drawn === panels.length} onClick={() => render()}>{drawn === 0 ? t(`绘制全部 ${panels.length} 格`, `Draw all ${panels.length} panels`) : drawn < panels.length ? t(`绘制剩余 ${panels.length - drawn} 格`, `Draw the other ${panels.length - drawn}`) : t('全部已绘', 'All drawn')}</Button>
            {lines.some(item => item.audio === undefined) ? <Button icon="mic" busy={voicing} disabled={working} pending={t('正在合成配音…', 'Voicing…')} onClick={() => (!controller.need('tts') ? undefined : run(async () => { await controller.api.call('audio.synthesize', { root, chapter: chapter.id }); await controller.refreshJobs() }))}>{t('合成配音', 'Synthesize voices')}</Button> : null}
            <Button variant="ghost" icon="headphones" onClick={() => { controller.openReader('listen', chapter.id) }}>{t('去"听"里制作配音', 'Voices are made under Listen')}</Button>
          </div>
        ) : null}
        {board.data.board?.note !== undefined ? <p className="nv-note">{board.data.board.note}</p> : null}
        <NeedsSetup what="image">{t('分镜可以先做，画面要等它。', 'The storyboard can be made first; the pictures wait for it.')}</NeedsSetup>
        <NeedsSetup what="tts" />
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

          <ol className="nv-cpanels">
            {placed.map(({ panel, from, seconds }, index) => (
              <li key={panel.id} className={cx('nv-cpanel', panel.id === current?.panel.id && state.status !== 'idle' && 'is-current')}>
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
          </ol>
        </>
      )}

      {editing !== undefined ? <PanelEditor chapterId={chapter.id} panel={editing} onClose={() => { setEditing(undefined) }} onSaved={() => { board.reload() }} /> : null}
    </div>
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
  return (
    <Modal wide title={t('修改这一格', 'Edit panel')} onClose={onClose} footer={(
      <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} onClick={() => run(async () => { await controller.api.call('comic.updatePanel', { root, chapter: chapterId, panel: panel.id, patch: { description, prompt, camera } }); onSaved(); onClose() })}>{t('保存', 'Save')}</Button>
    )}>
      <Field label={t('画面内容', 'What it shows')}><TextArea value={description} minRows={2} onChange={(event) => { setDescription(event.target.value) }} /></Field>
      <Field label={t('绘图提示词', 'Image prompt')} hint={t('改动提示词会清除已有画面，需要重画', 'Changing the prompt clears the picture; it has to be drawn again')}><TextArea value={prompt} minRows={5} maxRows={16} onChange={(event) => { setPrompt(event.target.value) }} /></Field>
      <Field label={t('镜头运动', 'Camera move')}><Select value={camera} options={(Object.keys(CAMERA) as CameraMove[]).map(value => ({ value, label: t(...CAMERA[value]) }))} onChange={setCamera} /></Field>
    </Modal>
  )
}

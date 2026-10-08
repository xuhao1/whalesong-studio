// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter's video, cut by the crew's post-production agent.
 *
 * The motion comic above is played by the Studio as it goes; this is a file.
 * The chapter's voice, sound and pictures are handed to an agent with a shell,
 * which cuts them however it sees fit and hands in an MP4 — its run is a child
 * agent of the conversation, open to be read step by step.
 */
import { useState } from 'react'
import { FFMPEG_INSTALL } from '../../shared/text'
import { HelpPrompt } from '../OutsideHelp'
import type { ChapterInfo } from '../../shared/types'
import { Button, Chip, CrewRuns, Field, SectionTitle, Spinner, TextArea, useAction, useConfirm, useJobStream, useLoad, useMediaUrl, useProject, useSnapshot, useStudio, useT } from '../ui'
import { chapterJob } from '../Batch'
import { formatDuration } from './Audio'

export function VideoCard({ chapter }: { chapter: ChapterInfo }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const mediaUrl = useMediaUrl()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const { busy, run } = useAction()
  const [direction, setDirection] = useState('')
  const [subtitles, setSubtitles] = useState(true)
  const confirm = useConfirm()
  const mine = jobs.filter(item => item.kind === 'video' && (item.target === chapter.id || item.result?.chapterId === chapter.id))
  // Cut here, or as a step of a running batch.
  const job = mine.find(item => item.status === 'running') ?? chapterJob(jobs, chapter.id, ['video'])
  const last = mine.find(item => item.status !== 'running')
  const status = useLoad(async signal => await controller.api.call('video.status', { root, chapter: chapter.id }, signal), [root, chapter.id, project.revision, job === undefined])
  const log = useJobStream(job?.id)
  const data = status.data
  const ready = data?.ready
  const video = data?.video
  const counts = ready?.counts
  const can = ready !== undefined && ready.blocked === undefined && ready.ffmpeg && ready.agent
  const produce = (): Promise<unknown> => run(async () => {
    await controller.api.call('video.produce', { root, chapter: chapter.id, ...(subtitles ? {} : { subtitles: false }), ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) })
    await controller.refreshJobs()
  })
  const steps = log.split('\n').filter(line => line.trim().length > 0).slice(-6)
  return (
    <section className="nv-card nv-video">
      <SectionTitle>{t('成片 · 交给后期 agent', 'Video · cut by post-production')}</SectionTitle>
      <p className="nv-muted nv-small">{t('后期 agent 把这一章的配音、音效和分镜画面剪成一个 MP4。', 'The post-production agent cuts this chapter\'s voices, sound and panels into one MP4.')}</p>
      {data === undefined ? <div className="nv-center">{status.error ?? <Spinner />}</div> : (
        <>
          <div className="nv-row-wrap">
            {counts !== undefined ? <Chip tone="blue">{t(`素材：${counts.spoken} 句配音 · ${formatDuration(counts.seconds)}`, `Material: ${counts.spoken} voiced lines · ${formatDuration(counts.seconds)}`)}</Chip> : null}
            {counts !== undefined ? <Chip tone={counts.drawn > 0 ? 'blue' : 'amber'}>{t(`${counts.drawn} 格画面${counts.undrawn > 0 ? `（${counts.undrawn} 格未画）` : ''}`, `${counts.drawn} pictures${counts.undrawn > 0 ? ` (${counts.undrawn} not drawn)` : ''}`)}</Chip> : null}
            {counts !== undefined && counts.clips > 0 ? <Chip tone="blue">{t(`${counts.clips} 段音效 / 配乐`, `${counts.clips} sound clips`)}</Chip> : null}
            {counts !== undefined && counts.silent > 0 ? <Chip tone="amber" title={t('这些句子没有配音，成片里会静默停留并显示文字', 'These lines have no voice; the video holds on them in silence and shows their text')}>{t(`${counts.silent} 句没有配音`, `${counts.silent} lines without a voice`)}</Chip> : null}
            {ready !== undefined && ready.model !== undefined ? <Chip tone={ready.agent ? 'green' : 'red'}>{ready.agent ? t(`后期：${ready.model}`, `Post-production: ${ready.model}`) : t('后期当不了 agent', 'Post-production cannot be an agent')}</Chip> : null}
          </div>
          {ready?.blocked !== undefined ? <p className="nv-note is-warn">{t('还不能剪：', 'Cannot be cut yet: ')}{ready.blocked}</p> : null}
          <HelpPrompt />
          {ready !== undefined && !ready.ffmpeg ? <p className="nv-note is-warn">{t(`这台电脑上没有 ffmpeg / ffprobe。${FFMPEG_INSTALL[0]}。`, `No ffmpeg / ffprobe on this computer. ${FFMPEG_INSTALL[1]}.`)}</p> : null}
          {ready !== undefined && !ready.agent ? (
            <p className="nv-note is-warn">
              {t('后期要作为 agent 才能干活，它现在的模型驱动不了 agent。', 'Post-production has to work as an agent, and its present model cannot drive one.')}
              {' '}
              <button type="button" className="nv-link" onClick={() => { controller.openSettings('crew') }}>{t('去“设置 → 班底”给它选一个 DSH 的模型', 'Choose a DSH model for it in Settings → Crew')}</button>
            </p>
          ) : null}

          {video !== undefined ? (
            <div className="nv-video-result">
              <video className="nv-video-player" controls preload="metadata" crossOrigin="anonymous" src={mediaUrl(video.path, video.createdAt)}>
                {/* A web player shows nothing of a subtitle track inside an MP4: the words come from the copy the Studio keeps beside the file. Words that are in the picture already are not shown twice — the track is there to be switched on. */}
                {video.subtitles?.path !== undefined ? <track kind="subtitles" default={!video.subtitles.burned} srcLang={project.manifest.language.slice(0, 2)} label={t('字幕', 'Subtitles')} src={mediaUrl(video.subtitles.path, video.createdAt)} /> : null}
              </video>
              <p className="nv-muted nv-small">
                {video.subtitles === undefined ? t('字幕：正在读取…', 'Subtitles: reading…')
                  : video.subtitles.burned ? t('字幕：后期说已经画进了画面，发到哪里都在。', 'Subtitles: drawn into the picture, post-production says — they go wherever the file goes.')
                    : video.subtitles.path !== undefined ? t('字幕是成片里的一条字幕轨，没有画进画面；想让字在画面里，重新剪一版并在要求里说明。', 'The subtitles are a track in the file, not burnt into the picture; to have them in the picture, cut it again and say so.')
                      : t('字幕：这一版没有字幕。要字幕就勾上“带字幕”再剪一版。', 'Subtitles: this cut has none. For subtitles, tick "With subtitles" and cut it again.')}
              </p>
              <div className="nv-row-wrap">
                <span className="nv-muted nv-small">{t(`${formatDuration(video.duration)} · ${video.width}×${video.height} · ${(video.size / 1_048_576).toFixed(1)} MB · ${new Date(video.createdAt).toLocaleString()}`, `${formatDuration(video.duration)} · ${video.width}×${video.height} · ${(video.size / 1_048_576).toFixed(1)} MB · ${new Date(video.createdAt).toLocaleString()}`)}</span>
                <span className="nv-spacer" />
                <a className="nv-link" href={controller.api.media(project.manifest.id, video.path, { download: true })}>{t('下载 MP4', 'Download the MP4')}</a>
                <Button size="sm" variant="ghost" icon="trash" disabled={job !== undefined} onClick={() => { confirm.ask(t('删除这一章的视频？', 'Delete this chapter\'s video?'), () => { void run(async () => { await controller.api.call('video.remove', { root, chapter: chapter.id }); controller.toast('success', t('已删除这一章的视频', 'The video is deleted')); status.reload() }) }) }} title={t('删除这个视频', 'Delete this video')} />
              </div>
              {video.note !== undefined ? <p className="nv-note">{t('后期的说明：', 'Post-production\'s note: ')}{video.note}</p> : null}
            </div>
          ) : null}

          {job !== undefined ? (
            <div className="nv-jobprogress" role="status">
              <div className="nv-jobprogress-head">
                <Spinner size={13} />
                <strong>{job.progress?.label ?? t('后期在剪', 'Post-production is cutting')}</strong>
                <span className="nv-spacer" />
                <Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(job.id) }}>{t('停止', 'Stop')}</Button>
              </div>
              {job.thinking !== undefined ? <p className="nv-jobprogress-now">{t(`模型思考中（${job.thinking} 字）…`, `The model is thinking (${job.thinking} chars)…`)}</p> : null}
              {steps.length > 0 ? <pre className="nv-runlog">{steps.join('\n')}</pre> : <p className="nv-jobprogress-now">{t('正在整理素材、启动后期…', 'Laying out the material and starting post-production…')}</p>}
              <p className="nv-muted nv-small">{t('它的每一步也在对话标题栏的“子智能体”里实时可见。', 'Each of its steps is also live under the subagents in the conversation\'s header.')}</p>
            </div>
          ) : (
            <>
              <Field label={t('对这一版的要求', 'What to ask of this cut')} hint={t('节奏、字幕、片头、镜头运动……', 'Pace, subtitles, titles, camera moves…')}>
                <TextArea value={direction} minRows={2} maxRows={6} placeholder={t('例如：节奏慢一点，换画面用淡入淡出；片头放书名和章名。', 'For example: slower, with cross-fades between pictures; open on the book and chapter title.')} onChange={(event) => { setDirection(event.target.value) }} />
              </Field>
              <label className="nv-check">
                <input type="checkbox" checked={subtitles} onChange={(event) => { setSubtitles(event.target.checked) }} />
                <span>{t('带字幕', 'With subtitles')}</span>
              </label>
              <div className="nv-form-actions">
                {last?.status === 'failed' && last.error !== undefined ? <span className="nv-job-error">{last.error}</span> : null}
                <span className="nv-spacer" />
                <Button variant={video === undefined ? 'primary' : 'outline'} icon="film" busy={busy} disabled={!can} pending={t('正在交给后期…', 'Handing it to post-production…')} onClick={produce}>{video === undefined ? t('交给后期剪成视频', 'Have post-production cut it') : t('重新剪一版', 'Cut it again')}</Button>
              </div>
            </>
          )}
          {last !== undefined ? <CrewRuns job={last} /> : null}
          {confirm.element}
        </>
      )}
    </section>
  )
}

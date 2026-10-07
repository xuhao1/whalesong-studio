// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Making the audio drama of a chapter: the script (who says what, how, over
 * which ambience), a voice per speaker, the takes. These are the author's
 * tools; they sit in the reader's listening mode, above the same player a
 * listener uses, so what is being made is heard exactly as it will be.
 */
import { useEffect, useState } from 'react'
import type { AmbiencePreset, AudioCue, AudioLine, AudioLineKind, AudioScript, ChapterInfo, JobInfo, SoundKind } from '../../shared/types'
import { Icon } from '../icons'
import { AMBIENCE, TAKE_ISSUE, TAKE_ISSUE_HINT } from '../labels'
import { cueCaption, formatDuration, usePlayerOptions } from '../reader/parts'
import {
  Button, Chip, cx, Field, Modal, Progress, Select, Spinner, TextArea, TextInput, useAction, useMediaUrl, useProject, useSnapshot, useStudio, useT, type Translate,
} from '../ui'
import { NeedsSetup } from '../views/Settings'
import type { LinePlayer, PlayerOptions, PlayerState } from './player'

export { formatDuration, usePlayerOptions }

const KIND: Record<AudioLineKind, [string, string]> = {
  narration: ['旁白', 'Narration'],
  dialogue: ['对白', 'Dialogue'],
  thought: ['心声', 'Thought'],
}

export function PlayerControls({ options, update, t }: { options: PlayerOptions; update: (patch: Partial<PlayerOptions>) => void; t: Translate }) {
  return (
    <div className="nv-player-options">
      <label className="nv-check" title={t('人声之下的一切：环境声、音效、配乐', 'Everything under the voice: ambience, effects, music')}>
        <input type="checkbox" checked={options.ambienceOn} onChange={(event) => { update({ ambienceOn: event.target.checked }) }} />
        <span>{t('环境与音效', 'Sound')}</span>
      </label>
      <input className="nv-range" type="range" min={0} max={1} step={0.05} value={options.ambienceVolume} disabled={!options.ambienceOn} onChange={(event) => { update({ ambienceVolume: Number(event.target.value) }) }} aria-label={t('环境音音量', 'Ambience volume')} />
      <Select value={String(options.rate)} options={['0.8', '1', '1.15', '1.3', '1.5'].map(rate => ({ value: rate, label: `${rate}×` }))} onChange={(value) => { update({ rate: Number(value) }) }} />
    </div>
  )
}

/**
 * What a running audio job is doing, in numbers and in words: how many lines
 * are done, which one is being spoken, how long it has taken and about how
 * long is left. A render of a chapter takes minutes; it must never look idle.
 */
export function JobProgress({ job, synthesizing, sounding, onStop }: { job: JobInfo; synthesizing: boolean; sounding?: boolean; onStop: () => void }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  const done = job.progress?.done ?? 0
  const total = job.progress?.total ?? 0
  const elapsed = Math.max(0, (now - Date.parse(job.startedAt)) / 1000)
  // Lines run in parallel and differ in length: an estimate, said as one.
  const left = done > 0 && total > done ? (elapsed / done) * (total - done) : undefined
  const percent = total > 0 ? Math.round((done / total) * 100) : undefined
  const retaken = typeof job.result?.retaken === 'number' ? job.result.retaken : 0
  return (
    <div className="nv-jobprogress" role="status">
      <div className="nv-jobprogress-head">
        <Spinner size={13} />
        <strong>
          {sounding === true
            ? total > 0 ? t(`正在生成声音：${done} / ${total} 处${percent !== undefined ? `（${percent}%）` : ''}`, `Making sounds: ${done} of ${total}${percent !== undefined ? ` (${percent}%)` : ''}`) : t('正在准备生成声音…', 'Getting ready to make sounds…')
            : synthesizing
            ? total > 0 ? t(`正在合成语音：${done} / ${total} 句${percent !== undefined ? `（${percent}%）` : ''}`, `Voicing: ${done} of ${total} lines${percent !== undefined ? ` (${percent}%)` : ''}`) : t('正在准备合成…', 'Getting ready to voice…')
            : total > 0 ? t(`正在编排有声脚本：${done} / ${total} 段`, `Directing the audio script: ${done} of ${total} passages`) : t('正在编排有声脚本…', 'Directing the audio script…')}
        </strong>
        <span className="nv-muted nv-small">
          {t(`已用 ${formatDuration(elapsed)}`, `${formatDuration(elapsed)} elapsed`)}
          {left !== undefined ? t(` · 大约还要 ${formatDuration(left)}`, ` · about ${formatDuration(left)} left`) : ''}
          {retaken > 0 ? t(` · ${retaken} 句重念过`, ` · ${retaken} retaken`) : ''}
        </span>
        <span className="nv-spacer" />
        <Button size="sm" variant="ghost" icon="stop" onClick={onStop}>{t('停止', 'Stop')}</Button>
      </div>
      <Progress done={done} total={total} />
      {job.thinking !== undefined ? <p className="nv-jobprogress-now">{t(`模型思考中（${job.thinking} 字）…`, `The model is thinking (${job.thinking} chars)…`)}</p> : job.progress?.label !== undefined && job.progress.label.length > 0 ? <p className="nv-jobprogress-now">{job.progress.label}</p> : null}
      {sounding === true ? <p className="nv-muted nv-small">{t('环境声、音效和配乐由声音模型按每一处的描述生成，一处十几秒到一分钟；生成好的会马上垫进播放里。停止后已生成的会保留。', 'Ambience, effects and music are made by the sound model from each cue\'s description, a quarter of a minute to a minute apiece; each comes in under the playback as soon as it is ready. Stopping keeps what is made.')}</p> : null}
      {synthesizing ? <p className="nv-muted nv-small">{t('合成好的句子会陆续出现，不用等全部完成就能先听；每一句都会被"听检"，没念完或不像原来声音的会自动重念。停止后已合成的会保留，下次从剩下的继续。', 'Finished lines appear as they come and can be played before the rest is done; every take is checked, and one that is cut short or not in its voice is spoken again. Stopping keeps what is voiced, and the next run picks up the remainder.')}</p> : null}
    </div>
  )
}

export interface ScriptView {
  script?: AudioScript
  stale: boolean
  cast?: { characters: Record<string, string>; extras: Record<string, string> }
  /** What can make sound for this book; absent when nothing can (or on a Host from before there was sound). */
  sound?: { model: string; shared: boolean; beds: 'generate' | 'browser' }
}

const kindOf = (cue: AudioCue): SoundKind => cue.kind ?? 'bed'

/** Cues the sound model is asked to make: every effect and piece of music, and beds unless the book keeps to synthesized ones. */
function generated(cues: readonly AudioCue[], beds: 'generate' | 'browser'): AudioCue[] {
  return cues.filter(cue => kindOf(cue) !== 'bed' || (beds === 'generate' && (cue.caption ?? cue.prompt ?? cue.note) !== undefined))
}

/**
 * The production desk of a chapter's audio drama: where it stands, what to do
 * next, and what is running. Shown above the page in the reader's listening
 * mode — only to the author.
 */
export function AudioDesk({ chapter, view, job, player, body, onBody, onChanged }: {
  chapter: ChapterInfo
  view: ScriptView
  job: JobInfo | undefined
  player: LinePlayer
  /** What the page under the desk shows: the prose, or the script line by line. */
  body: 'text' | 'script'
  onBody: (body: 'text' | 'script') => void
  /** The script was changed from the desk. */
  onChanged?: () => void
}) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [exported, setExported] = useState<{ path: string; duration: number; missing: number } | undefined>()
  const { busy, run } = useAction()
  const script = view.script
  const all = script?.lines ?? []
  // Lines left unspoken — "he said" between two voices — are not waiting for a voice.
  const lines = all.filter(line => line.skip !== true)
  const unspoken = all.length - lines.length
  const voiced = lines.filter(line => line.audio !== undefined).length
  const failed = lines.filter(line => line.error !== undefined).length
  const flagged = lines.filter(line => line.check !== undefined).length
  const duration = lines.reduce((sum, line) => sum + (line.duration ?? 0), 0)
  const working = busy || job !== undefined
  const soundReady = useSnapshot(snapshot => snapshot.settings?.ready.sound) === true || view.sound !== undefined
  const cues = script?.cues ?? []
  const toMake = generated(cues, view.sound?.beds ?? 'generate')
  const made = toMake.filter(cue => cue.audio !== undefined).length
  const start = (method: 'audio.build' | 'audio.synthesize', params: { force?: boolean; lines?: string[] } = {}): Promise<unknown> | undefined => {
    // Without a speech model there is nothing to start: say so, and show the way to the settings.
    if (method === 'audio.synthesize' && !controller.need('tts')) return undefined
    return run(async () => {
      player.stop()
      await controller.api.call(method, { root, chapter: chapter.id, ...params })
      await controller.refreshJobs()
    })
  }
  const makeSound = (force = false): Promise<unknown> | undefined => {
    if (!soundReady) {
      controller.toast('info', t('还没有能生成声音的模型：语音用百炼的音频生成模型时会自动沿用它，也可以在设置里单独指定。', 'Nothing can make sound yet: it follows the speech setup when that is Bailian audio generation, or can be given its own endpoint in the settings.'))
      controller.openSettings('tts')
      return undefined
    }
    return run(async () => {
      await controller.api.call('audio.sound', { root, chapter: chapter.id, ...(force ? { force: true } : {}) })
      await controller.refreshJobs()
    })
  }
  const reshape = (): Promise<unknown> => controller.guard(async () => {
    player.stop()
    const result = await controller.api.call('audio.reshape', { root, chapter: chapter.id })
    controller.toast('success', t(`已重新整理：${result.before} 行 → ${result.after} 行，${result.kept} 句原有配音保留；合并过的旁白需要重新合成。`, `Reshaped: ${result.before} lines → ${result.after}; ${result.kept} recordings kept. Joined narration needs voicing again.`))
    onChanged?.()
  })
  const speakers = new Map<string, { name: string; count: number; voice?: string; own: boolean }>()
  for (const line of lines) {
    if (line.kind === 'narration' || (line.speaker === undefined && line.speakerName === undefined)) continue
    const key = line.speaker ?? line.speakerName ?? '?'
    const card = project.characters.find(candidate => candidate.id === line.speaker)
    const own = card?.voiceProfile?.voice
    const cast = line.speaker !== undefined ? view.cast?.characters[line.speaker] : line.speakerName !== undefined ? view.cast?.extras[line.speakerName] : undefined
    const voice = own ?? cast
    const entry = speakers.get(key) ?? { name: card?.name ?? line.speakerName ?? '?', count: 0, own: own !== undefined, ...(voice !== undefined ? { voice } : {}) }
    entry.count += 1
    speakers.set(key, entry)
  }
  const spoken = lines.filter(line => line.kind !== 'narration')
  const unnamed = spoken.filter(line => line.speaker === undefined && line.speakerName === undefined).length
  // Only the button whose work is running says so; the others wait their turn.
  const synthesizing = job !== undefined && job.title === 'synthesize'
  const sounding = job !== undefined && job.title === 'sound'
  const directing = job !== undefined && !synthesizing && !sounding
  // A script from before narration was spoken in whole takes: many short narration lines, each its own clip.
  const oldShape = script !== undefined && script.shape === undefined && all.filter(line => line.kind === 'narration').length > 3

  return (
    <section className="nv-card nv-audio-head nv-desk">
      <div className="nv-audio-summary">
        <strong>{t('有声版制作', 'Audio production')}</strong>
        {script !== undefined ? <span className="nv-muted nv-small">{t(`${lines.length} 句 · 已配音 ${voiced}${failed > 0 ? ` · 失败 ${failed}` : ''}${flagged > 0 ? ` · ${flagged} 句待复听` : ''} · ${formatDuration(duration)}${unspoken > 0 ? ` · ${unspoken} 处"他说"不念` : ''}${toMake.length > 0 ? ` · 声音 ${made}/${toMake.length}` : ''}`, `${lines.length} lines · ${voiced} voiced${failed > 0 ? ` · ${failed} failed` : ''}${flagged > 0 ? ` · ${flagged} to re-listen` : ''} · ${formatDuration(duration)}${unspoken > 0 ? ` · ${unspoken} speech tags unspoken` : ''}${toMake.length > 0 ? ` · sounds ${made}/${toMake.length}` : ''}`)}</span> : null}
        {view.stale ? <Chip tone="amber" title={t('正文在脚本生成之后改过', 'The text changed after this script was made')}>{t('脚本已过期', 'Script is stale')}</Chip> : null}
      </div>
      <div className="nv-row-wrap">
        {script === undefined
          ? <Button variant="primary" icon="headphones" busy={synthesizing} disabled={working} pending={t('正在生成有声版…', 'Making the audio version…')} onClick={() => start('audio.synthesize')}>{t('生成有声版', 'Make the audio version')}</Button>
          : null}
        {script === undefined || view.stale
          ? <Button variant={script === undefined ? 'outline' : 'primary'} icon="sparkles" busy={directing} disabled={working} pending={t('正在编排脚本…', 'Directing the script…')} onClick={() => start('audio.build', { force: view.stale })}>{script === undefined ? t('只编排脚本', 'Direct the script only') : t('按新正文重排脚本', 'Redo the script')}</Button>
          : null}
        {script !== undefined ? <Button variant={voiced < lines.length && !view.stale ? 'primary' : 'outline'} icon="mic" busy={synthesizing} disabled={working} pending={t('正在合成…', 'Voicing…')} onClick={() => start('audio.synthesize')}>{voiced === 0 ? t('合成全部语音', 'Synthesize all') : voiced < lines.length ? t(`合成剩余 ${lines.length - voiced} 句`, `Synthesize the other ${lines.length - voiced}`) : t('听检并补合成', 'Check and repair')}</Button> : null}
        {script !== undefined && toMake.length > 0 ? (
          <Button variant={made < toMake.length && voiced >= lines.length && !view.stale ? 'primary' : 'outline'} icon="volume" busy={sounding} disabled={working} pending={t('正在生成声音…', 'Making sounds…')} onClick={() => makeSound(made >= toMake.length)} title={view.sound !== undefined ? t(`用 ${view.sound.model} 生成环境声、音效和配乐${view.sound.shared ? '（沿用语音的设置）' : ''}`, `Make ambience, effects and music with ${view.sound.model}${view.sound.shared ? ' (the speech setup)' : ''}`) : t('还没有能生成声音的模型——点一下去设置', 'Nothing can make sound yet — click to set it up')}>{made === 0 ? t(`生成声音（${toMake.length} 处）`, `Make the sounds (${toMake.length})`) : made < toMake.length ? t(`生成剩余 ${toMake.length - made} 处声音`, `Make the other ${toMake.length - made} sounds`) : t('重新生成声音', 'Make the sounds again')}</Button>
        ) : null}
        {script !== undefined && voiced > 0 ? (
          <Button icon="download" disabled={working} pending={t('正在拼接…', 'Joining…')} onClick={() => controller.guard(async () => { setExported(await controller.api.call('audio.export', { root, chapter: chapter.id })) })}>{t('导出整章音频', 'Export chapter audio')}</Button>
        ) : null}
        {script !== undefined ? <Button variant="ghost" icon="refresh" disabled={working} onClick={() => start('audio.build', { force: true })} title={t('重新编排脚本（已合成的相同台词会复用）', 'Redo the script (unchanged lines keep their audio)')} /> : null}
        <span className="nv-spacer" />
        {script !== undefined ? (
          <div className="nv-modes nv-modes-sm" role="tablist">
            <button type="button" role="tab" aria-selected={body === 'text'} className={cx('nv-mode', body === 'text' && 'is-active')} onClick={() => { onBody('text') }}>{t('正文', 'Prose')}</button>
            <button type="button" role="tab" aria-selected={body === 'script'} className={cx('nv-mode', body === 'script' && 'is-active')} onClick={() => { onBody('script') }}>{t('脚本', 'Script')}</button>
          </div>
        ) : null}
      </div>
      <NeedsSetup what="tts">{t('编排脚本不需要它，合成人声才需要。', 'Directing the script works without it; voicing the lines needs it.')}</NeedsSetup>
      {job !== undefined ? <JobProgress job={job} synthesizing={synthesizing} sounding={sounding} onStop={() => { void controller.cancelJob(job.id) }} /> : null}
      {oldShape && job === undefined ? (
        <p className="nv-note is-warn">
          {t(`这份脚本是旧的切法：旁白被切成了 ${all.filter(line => line.kind === 'narration').length} 小段，每段单独配音，听起来断断续续。重新整理会把相邻的旁白合成一口气念的大段，并把夹在对白之间的"他说"标为不念——不调用模型；对白的配音保留，合并过的旁白要重新合成。`, `This script is cut the old way: its narration is in ${all.filter(line => line.kind === 'narration').length} short pieces, each voiced on its own, which sounds choppy. Reshaping joins neighbouring narration into takes spoken in one breath and marks the "he said" between spoken lines as unspoken — without calling a model; dialogue keeps its recordings, joined narration is voiced again.`)}{' '}
          <Button size="sm" variant="primary" icon="wand" disabled={working} pending={t('正在整理…', 'Reshaping…')} onClick={reshape}>{t('重新整理脚本', 'Reshape the script')}</Button>
        </p>
      ) : null}
      {script?.degraded !== undefined ? (
        <p className="nv-note is-warn">
          {t(`有 ${script.degraded.blocks} / ${script.degraded.of} 段没能由导演模型编排，改用了规则切分：这几段的对白认不出是谁说的，会用旁白的声音念。`, `${script.degraded.blocks} of ${script.degraded.of} passages could not be directed by the model and were cut by rule instead: their dialogue has no speakers and is read in the narrator's voice.`)}
          <span className="nv-muted"> {t('原因：', 'Reason: ')}{script.degraded.reason}</span>{' '}
          <button type="button" className="nv-link" disabled={working} onClick={() => { void start('audio.build', { force: true }) }}>{t('重新编排', 'Direct it again')}</button>
        </p>
      ) : script !== undefined && unnamed > 0 && unnamed >= spoken.length / 2 ? (
        <p className="nv-note is-warn">
          {t(`${unnamed} 句对白没有认出说话人，会用旁白的声音念——这通常是脚本编排时模型输出被截断留下的。`, `${unnamed} spoken lines have no speaker and are read in the narrator's voice — usually what a script cut off in the making leaves behind.`)}{' '}
          <button type="button" className="nv-link" disabled={working} onClick={() => { void start('audio.build', { force: true }) }}>{t('重新编排脚本', 'Direct the script again')}</button>
        </p>
      ) : null}
      {flagged > 0 && job === undefined ? (
        <p className="nv-note">{t(`${flagged} 句重念之后仍然和别的句子不太一样（可能没念完，或声线有偏差），已在"脚本"里标出，可以逐句再念一次。`, `${flagged} lines still stand out after their retakes (cut short, or off their voice); they are marked under "Script" and can be spoken again one by one.`)}{' '}
          <button type="button" className="nv-link" onClick={() => { onBody('script') }}>{t('去看看', 'Show them')}</button>
        </p>
      ) : null}
      {exported !== undefined ? (
        <p className="nv-note">
          <a className="nv-link" href={controller.api.media(project.manifest.id, exported.path, { download: true })}>{t('下载', 'Download')} {exported.path}</a> · {formatDuration(exported.duration)}
          {exported.missing > 0 ? t(`（${exported.missing} 句尚未配音，已跳过）`, ` (${exported.missing} unvoiced lines skipped)`) : ''}
          <span className="nv-muted"> {t('导出的是人声轨；环境声、音效和配乐在播放时才垫进去。', 'The export is the voice track; ambience, effects and music are laid under it at playback.')}</span>
        </p>
      ) : null}
      {speakers.size > 0 ? (
        <div className="nv-cast-voices">
          <span className="nv-muted nv-small">{t('声音表', 'Voices')}</span>
          {[...speakers.entries()].map(([key, speaker]) => (
            <Chip key={key} tone={speaker.own ? 'green' : speaker.voice !== undefined ? 'blue' : 'neutral'} title={speaker.voice !== undefined ? t(`${speaker.own ? '人物卡上指定的音色' : '这位说话人在有声剧里的声音（按人物卡的声音描述或性别年龄选定，全书沿用）'}：${speaker.voice}`, `${speaker.own ? 'Voice set on the card' : 'This speaker\'s voice in the audio drama (from how their card says they speak, or cast by gender and age; kept for the whole book)'}: ${speaker.voice}`) : t('合成时按性别年龄选角，定下后全书沿用；也可以在人物卡上指定音色或设计专属声线', 'Cast by gender and age at synthesis and kept for the whole book; or set a voice or design one on the character card')}>
              {speaker.name} · {speaker.count}{speaker.voice !== undefined ? ` · ${speaker.voice.startsWith('qwen-tts-vd') ? t('专属声线', 'designed') : speaker.voice.length > 14 ? `${speaker.voice.slice(0, 14)}…` : speaker.voice}` : ''}
            </Chip>
          ))}
          <Button size="sm" variant="ghost" icon="users" onClick={() => { controller.setView('bible') }}>{t('调整配音', 'Adjust voices')}</Button>
        </div>
      ) : null}
    </section>
  )
}

const SOUND_KIND: Record<SoundKind, [string, string]> = {
  bed: ['环境声', 'Ambience'],
  effect: ['音效', 'Effect'],
  music: ['配乐', 'Music'],
}
const SOUND_MARK: Record<SoundKind, string> = { bed: '≋', effect: '◦', music: '♪' }

/** The script line by line: each with its speaker, its delivery, its take, the sounds placed on it — and the tools to change any of them. */
export function ScriptTable({ chapter, lines, cues, state, player, job, sound, onChanged }: {
  chapter: ChapterInfo
  lines: AudioLine[]
  cues: AudioCue[]
  state: PlayerState
  player: LinePlayer
  job: JobInfo | undefined
  sound?: ScriptView['sound']
  onChanged: () => void
}) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const mediaUrl = useMediaUrl()
  const [editing, setEditing] = useState<AudioLine | undefined>()
  const [cueEdit, setCueEdit] = useState<{ cue?: AudioCue; at: string } | undefined>()
  const cuesAt = new Map<string, AudioCue[]>()
  for (const cue of cues) cuesAt.set(cue.at, [...(cuesAt.get(cue.at) ?? []), cue])
  const live = new Set(state.sounding ?? [])
  // Lines in the booth right now, as the running job reports them.
  const inBooth = new Set(Array.isArray(job?.result?.active) ? job.result.active as string[] : [])
  const queued = new Set(Array.isArray(job?.result?.waiting) ? job.result.waiting as string[] : [])
  const retake = (line: AudioLine): Promise<unknown> | undefined => {
    if (!controller.need('tts')) return undefined
    return controller.guard(async () => {
      player.stop()
      await controller.api.call('audio.synthesize', { root, chapter: chapter.id, lines: [line.id], force: true })
      await controller.refreshJobs()
    })
  }
  const voice = (line: AudioLine, voiced: boolean): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('audio.updateLine', { root, chapter: chapter.id, line: line.id, patch: { voiced } })
    onChanged()
  })
  const hear = (cue: AudioCue): void => {
    if (cue.audio === undefined) return
    void new Audio(mediaUrl(cue.audio, cue.renderKey)).play().catch(() => {})
  }
  return (
    <>
      <ol className="nv-script">
        {lines.map((line, index) => {
          const here = cuesAt.get(line.id) ?? []
          const card = project.characters.find(candidate => candidate.id === line.speaker)
          const current = index === state.index
          const skipped = line.skip === true
          return (
            <li key={line.id} data-script-line={line.id} className={cx('nv-line', `is-${line.kind}`, current && 'is-current', skipped && 'is-skipped')}>
              {here.map((cue) => {
                const kind = kindOf(cue)
                const caption = cueCaption(cue, t)
                // A bed without a clip is what the browser synthesizes from its preset; say which one that is.
                const synthesized = kind === 'bed' && cue.audio === undefined && cue.ambience !== 'none'
                return (
                  <div key={cue.id ?? `${cue.at}-${kind}`} className={cx('nv-cue', `is-${kind}`, cue.id !== undefined && live.has(cue.id) && 'is-sounding')}>
                    <span className="nv-cue-mark" aria-hidden="true">{SOUND_MARK[kind]}</span>
                    <span className="nv-cue-kind">{t(...SOUND_KIND[kind])}</span>
                    <span className="nv-cue-text">{caption ?? t('（没有描述）', '(no description)')}</span>
                    {cue.audio !== undefined
                      ? <button type="button" className="nv-cue-tool" onClick={() => { hear(cue) }} title={t('听一下这个声音', 'Hear this sound')}><Icon name="play" size={10} /><span>{formatDuration(cue.duration ?? 0)}</span></button>
                      : cue.error !== undefined ? <Chip tone="red" title={cue.error}>{t('生成失败', 'failed')}</Chip>
                        : synthesized ? <span className="nv-muted nv-small" title={t('还没有生成的声音：播放时由浏览器合成', 'No generated clip yet: synthesized by the browser at playback')}>{t(`浏览器合成 · ${AMBIENCE[cue.ambience][0]}`, `synthesized · ${AMBIENCE[cue.ambience][1]}`)}</span>
                          : <span className="nv-muted nv-small">{t('只有注释，还没有声音', 'a note only, no sound yet')}</span>}
                    {cue.id !== undefined ? <button type="button" className="nv-cue-tool" onClick={() => { setCueEdit({ cue, at: cue.at }) }} title={t('修改这处声音', 'Edit this sound')}><Icon name="pen" size={11} /></button> : null}
                  </div>
                )
              })}
              <div className="nv-line-row">
                <button type="button" className="nv-line-play" disabled={skipped} onClick={() => { if (current && state.status === 'playing') player.pause(); else player.play(index) }} title={skipped ? t('这一行不念', 'This line is not spoken') : t('从这一句播放', 'Play from here')}>
                  <Icon name={current && state.status === 'playing' ? 'pause' : 'play'} size={12} />
                </button>
                <div className="nv-line-body">
                  <div className="nv-line-meta">
                    <span className="nv-line-speaker">{line.kind === 'narration' ? t('旁白', 'Narrator') : (card?.name ?? line.speakerName ?? t('未指定', 'unassigned'))}{line.kind === 'thought' ? t('（心声）', ' (thought)') : ''}</span>
                    {line.direction !== undefined ? <span className="nv-line-direction">{line.direction}</span> : null}
                    {skipped
                      ? <Chip title={line.tag === true ? t('夹在两句对白之间、只交代谁在说的提示语：每个人有自己的声音，念出来是多余的，而且两三个字的短句正是语音模型最不稳的地方。', 'A tag between two spoken lines that only says who speaks: with a voice per speaker it is redundant, and a clip of two or three syllables is where a speech model is least steady.') : t('你让这一行不念', 'You left this line unspoken')}>{t('不念', 'unspoken')}</Chip>
                      : inBooth.has(line.id)
                        ? <span className="nv-line-busy"><Spinner size={11} /> {t('合成中', 'voicing')}</span>
                        : line.error !== undefined ? <Chip tone="red" title={line.error}>{t('合成失败', 'failed')}</Chip>
                          : queued.has(line.id) ? <span className="nv-muted nv-small">{t('排队中', 'queued')}</span>
                            : line.audio !== undefined ? <span className="nv-muted nv-small">{formatDuration(line.duration ?? 0)}{line.takes !== undefined ? t(` · 念了 ${line.takes} 次`, ` · ${line.takes} takes`) : ''}</span> : null}
                    {!skipped && !inBooth.has(line.id) && line.check !== undefined ? line.check.map(issue => <Chip key={issue} tone="amber" title={t(TAKE_ISSUE_HINT[issue][0], TAKE_ISSUE_HINT[issue][1])}>{t(...TAKE_ISSUE[issue])}</Chip>) : null}
                  </div>
                  <p>{line.text}</p>
                </div>
                <div className="nv-line-tools">
                  {skipped
                    ? <Button size="sm" variant="ghost" icon="volume" pending={t('正在改…', 'Changing…')} onClick={() => voice(line, true)} title={t('还是念出来', 'Have it spoken after all')} />
                    : line.kind === 'narration' ? <Button size="sm" variant="ghost" icon="mute" pending={t('正在改…', 'Changing…')} onClick={() => voice(line, false)} title={t('这一行不念', 'Leave this line unspoken')} /> : null}
                  <Button size="sm" variant="ghost" icon="plus" onClick={() => { setCueEdit({ at: line.id }) }} title={t('在这一行加一处声音（环境、音效、配乐）', 'Add a sound at this line (ambience, effect, music)')} />
                  <Button size="sm" variant="ghost" icon="pen" onClick={() => { setEditing(line) }} title={t('修改这一句', 'Edit this line')} />
                  {skipped ? null : <Button size="sm" variant="ghost" icon="mic" disabled={job !== undefined} pending={t('正在开始重念…', 'Starting the retake…')} onClick={() => retake(line)} title={t('把这一句再念一次', 'Speak this line again')} />}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {editing !== undefined ? <LineEditor chapterId={chapter.id} line={editing} onClose={() => { setEditing(undefined) }} onSaved={onChanged} /> : null}
      {cueEdit !== undefined ? <CueEditor chapterId={chapter.id} at={cueEdit.at} cue={cueEdit.cue} sound={sound} busy={job !== undefined} onClose={() => { setCueEdit(undefined) }} onSaved={onChanged} /> : null}
    </>
  )
}

/** One sound of the script: what the reader is told, what the sound model is asked for, and the clip made from it. */
function CueEditor({ chapterId, at, cue, sound, busy: working, onClose, onSaved }: { chapterId: string; at: string; cue: AudioCue | undefined; sound: ScriptView['sound']; busy: boolean; onClose: () => void; onSaved: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const { busy, run } = useAction()
  const [kind, setKind] = useState<SoundKind>(cue !== undefined ? kindOf(cue) : 'effect')
  const [caption, setCaption] = useState(cue?.caption ?? cue?.note ?? '')
  const [prompt, setPrompt] = useState(cue?.prompt ?? '')
  const [ambience, setAmbience] = useState<AmbiencePreset>(cue?.ambience ?? 'none')
  const [intensity, setIntensity] = useState(cue?.intensity ?? 0.6)
  const described = caption.trim().length > 0 || prompt.trim().length > 0
  const save = async (): Promise<string | undefined> => {
    if (cue?.id !== undefined) {
      await controller.api.call('audio.updateCue', { root, chapter: chapterId, cue: cue.id, patch: { kind, caption, prompt, ambience: kind === 'bed' ? ambience : 'none', intensity } })
      return cue.id
    }
    const script = await controller.api.call('audio.addCue', { root, chapter: chapterId, at, kind, caption, prompt, ...(kind === 'bed' ? { ambience } : {}), intensity })
    // The new cue is the one that was not there before.
    return script.cues.filter(item => item.at === at && (item.kind ?? 'bed') === kind).at(-1)?.id
  }
  const done = (): void => {
    onSaved()
    onClose()
  }
  return (
    <Modal title={cue !== undefined ? t('修改这处声音', 'Edit this sound') : t('加一处声音', 'Add a sound')} onClose={onClose} footer={(
      <>
        {cue?.id !== undefined ? <Button variant="ghost" icon="trash" disabled={busy} onClick={() => run(async () => { await controller.api.call('audio.updateCue', { root, chapter: chapterId, cue: cue.id!, remove: true }); done() })}>{t('删掉', 'Remove')}</Button> : null}
        <span className="nv-spacer" />
        <Button busy={busy} pending={t('正在保存…', 'Saving…')} disabled={kind !== 'bed' && !described} onClick={() => run(async () => { await save(); done() })}>{t('只保存', 'Save only')}</Button>
        <Button variant="primary" icon="volume" disabled={busy || working || !described} pending={t('正在开始生成…', 'Starting…')} title={sound !== undefined ? t(`用 ${sound.model} 生成`, `Made with ${sound.model}`) : t('还没有能生成声音的模型', 'Nothing can make sound yet')} onClick={() => run(async () => {
          const id = await save()
          if (sound === undefined) {
            controller.toast('info', t('已保存为注释。还没有能生成声音的模型：语音用百炼的音频生成模型时会自动沿用它。', 'Saved as a note. Nothing can make sound yet: it follows the speech setup when that is Bailian audio generation.'))
          } else if (id !== undefined) {
            await controller.api.call('audio.sound', { root, chapter: chapterId, cues: [id], force: true })
            await controller.refreshJobs()
          }
          done()
        })}>{t('保存并生成声音', 'Save and make the sound')}</Button>
      </>
    )}>
      <div className="nv-form-grid">
        <Field label={t('类型', 'Kind')}>
          <Select value={kind} options={(Object.keys(SOUND_KIND) as SoundKind[]).map(value => ({ value, label: t(...SOUND_KIND[value]) }))} onChange={setKind} />
        </Field>
        {kind === 'bed' ? (
          <Field label={t('没有生成的声音时', 'Until a clip is made')} hint={t('浏览器合成的替身', 'The stand-in the browser synthesizes')}>
            <Select value={ambience} options={(Object.keys(AMBIENCE) as AmbiencePreset[]).map(value => ({ value, label: t(...AMBIENCE[value]) }))} onChange={setAmbience} />
          </Field>
        ) : null}
      </div>
      <Field label={t('给读者看的注释', 'The note the reader sees')} hint={t('写得让人"听得见"，例：嗒——银槌轻碰骨木', 'Let the reader hear it, e.g. "tok — the silver gavel touches bone"')}>
        <TextInput value={caption} onChange={(event) => { setCaption(event.target.value) }} />
      </Field>
      <Field label={t('给声音模型的描述', 'What the sound model is asked for')} hint={kind === 'effect' ? t('只说这个声音本身：什么东西、什么材质、怎么响、几秒。留空就用上面的注释。', 'The sound itself: what object, what material, how it sounds, how long. Left empty, the note above is used.') : kind === 'music' ? t('乐器、速度、情绪；纯器乐。留空就用上面的注释。', 'Instruments, tempo, mood; instrumental. Left empty, the note above is used.') : t('这个地方持续不断的底声由什么组成；平稳、可循环。留空就用上面的注释。', 'What the steady bed of this place is made of; even and loopable. Left empty, the note above is used.')}>
        <TextArea value={prompt} minRows={2} onChange={(event) => { setPrompt(event.target.value) }} />
      </Field>
      {kind === 'bed' ? (
        <Field label={t('强度', 'Intensity')} row>
          <input className="nv-range" type="range" min={0} max={1} step={0.05} value={intensity} onChange={(event) => { setIntensity(Number(event.target.value)) }} />
        </Field>
      ) : null}
      <p className="nv-muted nv-small">{kind === 'bed' ? t('环境声从这一行起一直垫到下一处环境声。', 'A bed runs from this line until the next bed.') : kind === 'music' ? t('配乐从这一行起一直垫到下一处配乐。', 'Music runs from this line until the next music cue.') : t('音效在这一行开始时响一次。', 'An effect is heard once, as this line begins.')}{' '}{t('声音不属于正文，只在有声版和正文旁的注释里出现。', 'Sounds are not part of the manuscript: they live in the audio version and in the notes beside the text.')}</p>
    </Modal>
  )
}

function LineEditor({ chapterId, line, onClose, onSaved }: { chapterId: string; line: AudioLine; onClose: () => void; onSaved: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const [text, setText] = useState(line.text)
  const [kind, setKind] = useState<AudioLineKind>(line.kind)
  const [speaker, setSpeaker] = useState(line.speaker ?? '')
  const [direction, setDirection] = useState(line.direction ?? '')
  const save = (): Promise<unknown> => run(async () => {
    await controller.api.call('audio.updateLine', { root, chapter: chapterId, line: line.id, patch: { text, kind, speaker: kind === 'narration' ? '' : speaker, direction } })
    onSaved()
    onClose()
  })
  return (
    <Modal title={t('修改台词', 'Edit line')} onClose={onClose} footer={<Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={text.trim().length === 0} onClick={save}>{t('保存', 'Save')}</Button>}>
      <div className="nv-form-grid">
        <Field label={t('类型', 'Kind')}><Select value={kind} options={(Object.keys(KIND) as AudioLineKind[]).map(value => ({ value, label: t(...KIND[value]) }))} onChange={setKind} /></Field>
        {kind !== 'narration' ? <Field label={t('说话人', 'Speaker')}><Select value={speaker} options={[{ value: '', label: line.speaker === undefined && line.speakerName !== undefined ? line.speakerName : t('（未指定）', '(unassigned)') }, ...project.characters.map(card => ({ value: card.id, label: card.name }))]} onChange={setSpeaker} /></Field> : null}
      </div>
      <Field label={t('台词', 'Text')}><TextArea value={text} minRows={3} onChange={(event) => { setText(event.target.value) }} /></Field>
      <Field label={t('表演提示', 'Delivery')} hint={t('情绪、语速、音量，如：压低声音，带着怒意', 'Emotion, pace, volume — e.g. low and angry')}><TextInput value={direction} onChange={(event) => { setDirection(event.target.value) }} /></Field>
      <p className="nv-muted nv-small">{t('修改后这一句需要重新合成。只改有声脚本，不会改动正文。', 'The line needs synthesizing again after a change. This edits the script only, never the manuscript.')}</p>
    </Modal>
  )
}

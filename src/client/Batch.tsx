// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Batches on screen: the same work for many chapters, characters or places,
 * started with one click and followed step by step.
 *
 *   BatchMatrix      a running or finished batch: every row and step, what is
 *                    under way, what came of each, what did not come about
 *   ProductionBoard  the stage production of the whole book: where every
 *                    chapter stands, and one button to do what is missing
 *   TextBatchDialog  a run of chapters written — or given beats, memory,
 *                    a review — in one go
 *   ArtBatchDialog   design sheets, portraits, voices, place art, an
 *                    illustration per chapter, a cover
 *   GateNotes        says when a service pushes back and the Studio has
 *                    slowed down for it
 *
 * A chapter's own screen sees the part of a batch that concerns it through
 * `chapterJob`, shaped like the job it would have started itself.
 */
import { groupOf, worldWeight } from '../shared/world'
import { useEffect, useMemo, useState } from 'react'
import {
  MAIN_LINE, STAGE_STEPS, STORYBOARD_DENSITIES,
  type BatchKind, type BatchStepView, type BatchView, type ChapterInfo, type GateKind, type JobInfo, type StageStatus, type StageStep, type StoryboardDensity, type TextStep,
} from '../shared/types'
import { Icon } from './icons'
import { BATCH_STEP, DENSITY, STAGE_STEP_HINT } from './labels'
import {
  Button, Chip, crewLabel, cx, Field, Modal, Progress, Select, Spinner, TextArea, TextInput, useAction, useLoad, useProject, useSnapshot, useStudio, useT, type Translate,
  SectionTitle, Menu, useBookLine, useKept,
} from './ui'
import { CharacterPicker, defaultCastFilter, matchesCast, useCastFilter } from './CharacterPicker'
import { useSheetsAsk } from './SheetsAsk'

/** The batch a job carries, when it is one. */
export function batchOf(job: JobInfo | undefined): BatchView | undefined {
  const batch = job?.kind === 'batch' ? job.result?.batch : undefined
  return batch !== undefined && batch !== null && typeof batch === 'object' && Array.isArray((batch as BatchView).rows) ? batch as BatchView : undefined
}

/** A step of a batch as the job a chapter's own screen would have started for it. */
const AS_JOB: Record<string, { kind: JobInfo['kind']; title: string }> = {
  script: { kind: 'audio', title: 'audio script' },
  voice: { kind: 'audio', title: 'synthesize' },
  sound: { kind: 'audio', title: 'sound' },
  storyboard: { kind: 'comic', title: 'storyboard' },
  panels: { kind: 'comic', title: 'draw panels' },
  video: { kind: 'video', title: 'video' },
  beats: { kind: 'derive', title: 'derive beats' },
  write: { kind: 'write', title: 'write' },
  digest: { kind: 'digest', title: 'digest' },
  review: { kind: 'review', title: 'review' },
}

/** A job as one chapter sees it; `batch` is set when it is a part of a batch, which stops as a whole. */
export type ChapterJob = JobInfo & { batch?: true }

/**
 * The work under way on a chapter: a job started for it, or the step of a
 * running batch that is on it right now — the first of `titles` that is.
 * @param titles - job titles the screen cares about, in the order it would rather show them.
 */
export function chapterJob(jobs: readonly JobInfo[], chapterId: string | undefined, titles: readonly string[]): ChapterJob | undefined {
  if (chapterId === undefined) return undefined
  const own = jobs.find(job => job.status === 'running' && job.kind !== 'batch' && titles.includes(job.title) && (job.target === chapterId || job.result?.chapterId === chapterId))
  if (own !== undefined) return own
  for (const job of jobs) {
    if (job.status !== 'running') continue
    const row = batchOf(job)?.rows.find(candidate => candidate.id === chapterId)
    if (row === undefined) continue
    for (const title of titles) {
      const op = Object.keys(AS_JOB).find(candidate => AS_JOB[candidate]!.title === title && row.steps[candidate]?.state === 'running')
      if (op === undefined) continue
      const step = row.steps[op]!
      const { progress: _progress, result: _result, ...rest } = job
      return {
        ...rest,
        kind: AS_JOB[op]!.kind,
        title,
        target: chapterId,
        ...(step.progress !== undefined ? { progress: step.progress } : {}),
        result: { ...step.detail, chapterId },
        batch: true,
      }
    }
  }
  return undefined
}

/** Whether a batch is at work on a chapter at all — a step running, or one still to come. */
export function inBatch(jobs: readonly JobInfo[], chapterId: string | undefined): JobInfo | undefined {
  if (chapterId === undefined) return undefined
  return jobs.find(job => job.status === 'running' && batchOf(job)?.rows.some(row => row.id === chapterId && Object.values(row.steps).some(step => step.state === 'running' || step.state === 'waiting')) === true)
}

const GATE: Record<GateKind, [string, string]> = {
  text: ['文字模型', 'The text models'],
  speech: ['语音服务', 'The speech service'],
  image: ['绘图服务', 'The image service'],
  sound: ['声音服务', 'The sound service'],
}

/**
 * Says when a service answers "too fast" and the Studio has slowed down for
 * it: how many go out at once now, and that it climbs back by itself.
 */
export function GateNotes({ kinds }: { kinds?: GateKind[] }) {
  const t = useT()
  const gates = useSnapshot(snapshot => snapshot.gates) ?? {}
  const notes = (Object.keys(gates) as GateKind[]).filter(kind => kinds === undefined || kinds.includes(kind)).map((kind) => {
    const gate = gates[kind]!
    if (gate.limit >= gate.ceiling && gate.pausedMs <= 0) return undefined
    const pause = gate.pausedMs > 0 ? t(`，暂停 ${Math.ceil(gate.pausedMs / 1000)} 秒`, `, pausing ${Math.ceil(gate.pausedMs / 1000)} s`) : ''
    return (
      <p key={kind} className="nv-note is-warn nv-gate-note">
        {t(`${GATE[kind][0]}在限流：并发从 ${gate.ceiling} 降到了 ${gate.limit}${pause}，会自动重发。`, `${GATE[kind][1]} is being rate-limited: down from ${gate.ceiling} at once to ${gate.limit}${pause}; refused requests are sent again.`)}
        {gate.waiting > 0 ? <span className="nv-muted"> {t(`${gate.waiting} 个在排队。`, `${gate.waiting} waiting.`)}</span> : null}
      </p>
    )
  }).filter(note => note !== undefined)
  return notes.length > 0 ? <>{notes}</> : null
}

function StepCell({ step, t }: { step: BatchStepView | undefined; t: Translate }) {
  const { host } = useStudio()
  if (step === undefined) return <td className="nv-batch-cell is-absent" />
  const progress = step.progress
  const title = step.note ?? progress?.label
  const mark = (
    <>
      {step.state === 'running' ? (
        <span className="nv-batch-running"><Spinner size={11} />{progress !== undefined && progress.total > 0 ? <span>{progress.done}/{progress.total}</span> : null}</span>
      ) : step.state === 'done' ? <Icon name="check" size={13} />
        : step.state === 'failed' ? <Icon name="x" size={13} />
          : step.state === 'skipped' ? <span className="nv-batch-mark">–</span>
            : step.state === 'blocked' ? <span className="nv-batch-mark">⊘</span>
              : <span className="nv-batch-dot" aria-label={t('等待中', 'waiting')} />}
      {step.state === 'done' && step.note !== undefined ? <span className="nv-batch-note">{step.note}</span> : null}
    </>
  )
  // A step an agent works on leads to that agent — this one's, not whichever of the batch's agents started last.
  const run = step.run
  if (run?.session !== undefined && run.parent !== undefined && host.openRun !== undefined) {
    const { session, parent } = run
    const who = crewLabel(run.role, t)
    return (
      <td className={cx('nv-batch-cell', `is-${step.state}`, 'has-run')}>
        <button
          type="button"
          className="nv-batch-open"
          onClick={() => { host.openRun!({ session, parent }) }}
          title={`${run.running === true ? t(`看${who}正在做这一格`, `See the ${who} working on this step`) : t(`打开${who}做这一格的记录`, `Open the record of the ${who}'s run on this step`)}${title !== undefined ? `\n${title}` : ''}`}
        >
          {mark}
        </button>
      </td>
    )
  }
  return <td className={cx('nv-batch-cell', `is-${step.state}`)} title={title}>{mark}</td>
}

/**
 * A batch as it stands: every row and step. Running, it says what is under
 * way and can be stopped; finished, it says what came of it and lists what did
 * not come about, each with its reason.
 * @param onAgain - run the same batch again: only what is missing or failed is done.
 */
export function BatchMatrix({ job, onAgain, compact }: { job: JobInfo; onAgain?: (() => unknown) | undefined; compact?: boolean }) {
  const { controller } = useStudio()
  const t = useT()
  const batch = batchOf(job)
  const [now, setNow] = useState(() => Date.now())
  const running = job.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [running])
  if (batch === undefined) return null
  const seconds = Math.max(0, Math.round(((running ? now : Date.parse(job.endedAt ?? job.startedAt)) - Date.parse(job.startedAt)) / 1000))
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const failures = batch.rows.flatMap(row => Object.entries(row.steps).filter(([, step]) => step.state === 'failed').map(([op, step]) => ({ row, op, step })))
  const blocked = batch.rows.reduce((sum, row) => sum + Object.values(row.steps).filter(step => step.state === 'blocked').length, 0)
  const done = batch.rows.reduce((sum, row) => sum + Object.values(row.steps).filter(step => step.state === 'done').length, 0)
  const skipped = batch.rows.reduce((sum, row) => sum + Object.values(row.steps).filter(step => step.state === 'skipped').length, 0)
  const kinds: GateKind[] = batch.what === 'text' ? ['text'] : ['text', 'speech', 'image', 'sound']
  return (
    <div className={cx('nv-batch', compact === true && 'is-compact')} role="status">
      <div className="nv-batch-head">
        {running ? <Spinner size={13} /> : <Icon name={failures.length > 0 || job.status === 'failed' ? 'alert' : 'check'} size={14} />}
        <strong>
          {running ? t(`进行中：${batch.settled} / ${batch.total} 步`, `In progress: ${batch.settled} of ${batch.total} steps`)
            : job.status === 'cancelled' ? t(`已停止：完成 ${done} 步`, `Stopped: ${done} steps done`)
              : job.status === 'failed' ? t('没有完成', 'Did not finish')
                : failures.length > 0 ? t(`完成 ${done} 步，${failures.length} 步没有做成`, `${done} steps done, ${failures.length} did not come about`)
                  : t(`全部完成：${done} 步`, `All done: ${done} steps`)}
        </strong>
        <span className="nv-muted nv-small">
          {t(`用时 ${elapsed}`, `${elapsed}`)}
          {skipped > 0 ? t(` · ${skipped} 步本来就不用做`, ` · ${skipped} needed nothing`) : ''}
          {blocked > 0 ? t(` · ${blocked} 步因为前一步没成而没有开始`, ` · ${blocked} not started because an earlier step failed`) : ''}
        </span>
        <span className="nv-spacer" />
        {running
          ? <Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(job.id) }}>{t('停止', 'Stop')}</Button>
          : onAgain !== undefined && (failures.length > 0 || blocked > 0 || job.status !== 'done')
            ? <Button size="sm" variant="primary" icon="refresh" pending={t('正在重新开始…', 'Starting again…')} onClick={onAgain}>{t('把没做成的再做一次', 'Do what is missing again')}</Button>
            : null}
      </div>
      <Progress done={batch.settled} total={batch.total} />
      {running && job.thinking !== undefined ? <p className="nv-jobprogress-now">{t(`模型思考中（${job.thinking} 字）…`, `The model is thinking (${job.thinking} chars)…`)}</p> : running && job.progress?.label !== undefined && job.progress.label.length > 0 ? <p className="nv-jobprogress-now">{job.progress.label}</p> : null}
      {job.status === 'failed' && job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      {running ? <GateNotes kinds={kinds} /> : null}
      <div className="nv-batch-scroll">
        <table className="nv-batch-table">
          <thead>
            <tr>
              <th />
              {batch.columns.map(op => <th key={op}>{t(...(BATCH_STEP[op] ?? [op, op]))}</th>)}
            </tr>
          </thead>
          <tbody>
            {batch.rows.map(row => (
              <tr key={row.id} className={cx(Object.values(row.steps).some(step => step.state === 'running') && 'is-active')}>
                <th scope="row" title={row.label}>{row.label}</th>
                {batch.columns.map(op => <StepCell key={op} step={row.steps[op]} t={t} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {failures.length > 0 ? (
        <ul className="nv-batch-failures">
          {failures.slice(0, 20).map(({ row, op, step }) => (
            <li key={`${row.id}:${op}`}><strong>{row.label} · {t(...(BATCH_STEP[op] ?? [op, op]))}</strong><span>{step.note ?? t('失败', 'failed')}</span></li>
          ))}
          {failures.length > 20 ? <li className="nv-muted">{t(`另有 ${failures.length - 20} 项`, `and ${failures.length - 20} more`)}</li> : null}
        </ul>
      ) : null}
    </div>
  )
}

/** The batch of one kind that is running for this book, or the last one that ran. */
export function useBatchJob(what: BatchKind): JobInfo | undefined {
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const mine = jobs.filter(job => batchOf(job)?.what === what)
  return mine.find(job => job.status === 'running') ?? mine[0]
}

// ───────────────────────────── the production board ─────────────────────────────

type CellTone = 'none' | 'part' | 'done' | 'stale'

function cellOf(status: StageStatus, step: StageStep, t: Translate): { tone: CellTone; text: string } {
  const script = status.script
  const board = status.board
  switch (step) {
    case 'script': return script === undefined ? { tone: 'none', text: '—' } : script.stale ? { tone: 'stale', text: t('已过期', 'stale') } : { tone: 'done', text: t(`${script.lines} 句`, `${script.lines}`) }
    case 'voice': return script === undefined ? { tone: 'none', text: '—' } : { tone: script.spoken > 0 && script.voiced >= script.spoken ? 'done' : script.voiced > 0 ? 'part' : 'none', text: `${script.voiced}/${script.spoken}` }
    case 'sound': return status.sound === undefined ? { tone: 'none', text: '—' } : { tone: status.sound.made >= status.sound.wanted ? 'done' : status.sound.made > 0 ? 'part' : 'none', text: `${status.sound.made}/${status.sound.wanted}` }
    case 'storyboard': return board === undefined ? { tone: 'none', text: '—' } : board.stale ? { tone: 'stale', text: t('已过期', 'stale') } : { tone: 'done', text: t(`${board.panels} 格`, `${board.panels}`) }
    case 'panels': return board === undefined ? { tone: 'none', text: '—' } : { tone: board.panels > 0 && board.drawn >= board.panels ? 'done' : board.drawn > 0 ? 'part' : 'none', text: `${board.drawn}/${board.panels}` }
    default: return status.video === undefined ? { tone: 'none', text: '—' } : { tone: 'done', text: `${Math.floor(status.video.duration / 60)}:${String(Math.round(status.video.duration % 60)).padStart(2, '0')}` }
  }
}

/** A chapter still has something to do for a step: nothing there yet, only part of it, or out of date. */
const lacking = (status: StageStatus, step: StageStep, t: Translate): boolean => cellOf(status, step, t).tone !== 'done'

/**
 * The stage production of the whole book on one screen: where every written
 * chapter stands — script, voices, sound, storyboard, pictures, video — which
 * steps to run, for which chapters, and one button that does the rest.
 */
export function ProductionBoard({ onOpen }: { onOpen: (chapterId: string) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const job = useBatchJob('stage')
  const running = job?.status === 'running'
  // Every production under way — a batch started here, a chapter produced from its own page: each is shown, and none
  // of them keeps another from being started for chapters it is not on.
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const under = jobs.filter(candidate => candidate.status === 'running' && batchOf(candidate)?.what === 'stage')
  // One line of the plot at a time: the main one, or another line's own chapters (what it shares with the line it parts from is that line's to produce).
  const plotLines = project.outline.lines ?? []
  const [line, setLine] = useBookLine()
  const overview = useLoad(signal => controller.api.call('batch.overview', { root, ...(line !== MAIN_LINE ? { line } : {}) }, signal), [root, line, project.revision, running])
  const { busy, run } = useAction()
  const saved = project.manifest.storyboard
  const [density, setDensity] = useState<StoryboardDensity>(saved?.density ?? 'balanced')
  const [steps, setSteps] = useState<Set<StageStep> | undefined>()
  const [picked, setPicked] = useState<Set<string> | undefined>()
  const [force, setForce] = useState(false)
  const [direction, setDirection] = useState('')
  const [subtitles, setSubtitles] = useState(true)
  const [last, setLast] = useState<{ chapters: string[]; steps: StageStep[]; force: boolean } | undefined>()
  const ownOf = line !== MAIN_LINE ? new Set((project.lines?.find(candidate => candidate.id === line)?.chapters ?? []).map(chapter => chapter.id)) : undefined
  const chapters = (overview.data?.chapters ?? []).filter(status => ownOf === undefined || ownOf.has(status.id))
  const shared = (overview.data?.chapters.length ?? 0) - chapters.length
  const missing = overview.data?.missing ?? {}
  const pickLine = (next: string): void => {
    setLine(next)
    // What was ticked was ticked among another line's chapters.
    setPicked(undefined)
  }
  const lineSelect = plotLines.length > 0 ? (
    <Select value={line} options={[
      { value: MAIN_LINE, label: `★ ${t('主线', 'Main line')}` },
      ...plotLines.map(candidate => ({ value: candidate.id, label: `${candidate.shelved === true ? '⏸ ' : ''}${candidate.title}` })),
    ]} onChange={pickLine} />
  ) : null
  // Until the author chooses: everything that can run with what is set up, except the video — which is minutes of an agent's work per chapter.
  const chosen = steps ?? new Set(STAGE_STEPS.filter(step => step !== 'video' && missing[step] === undefined))
  const todo = useMemo(() => new Set(chapters.filter(status => STAGE_STEPS.some(step => chosen.has(step) && (force || lacking(status, step, t)))).map(status => status.id)), [chapters, chosen, force, t])
  const selected = picked ?? todo
  // A chapter a production is on right now waits for that one: it is not started a second time beside it.
  const taken = new Set(chapters.filter(status => inBatch(jobs, status.id) !== undefined).map(status => status.id))
  const going = chapters.filter(status => selected.has(status.id) && !taken.has(status.id))
  const count = going.length
  const toggleStep = (step: StageStep): void => {
    const next = new Set(chosen)
    if (next.has(step)) next.delete(step)
    else next.add(step)
    setSteps(next)
  }
  const toggle = (id: string): void => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }
  const sheets = useSheetsAsk()
  const start = (params: { chapters: string[]; steps: StageStep[]; force: boolean }): Promise<unknown> => run(async () => {
    // Where pictures are among the steps: whose design sheets they would draw first is asked before anything is started.
    await sheets.before(params.steps.includes('panels') ? params.chapters.map(chapter => ({ kind: 'panels' as const, chapter, ...(params.force ? { force: true } : {}) })) : [], async (choice) => {
      setLast(params)
      await controller.api.call('batch.stage', {
        root,
        ...(line !== MAIN_LINE ? { line } : {}),
        chapters: params.chapters,
        steps: params.steps,
        ...(params.force ? { force: true } : {}),
        ...(params.steps.includes('storyboard') ? { density, ...(saved?.maxPanels !== undefined ? { maxPanels: saved.maxPanels } : {}) } : {}),
        ...(params.steps.includes('video') && direction.trim().length > 0 ? { direction: direction.trim() } : {}),
        ...(params.steps.includes('video') && !subtitles ? { subtitles: false } : {}),
        ...choice,
      })
      await controller.refreshJobs()
    })
  })
  if (overview.data === undefined) return <div className="nv-center">{overview.error ?? <Spinner />}</div>
  if (chapters.length === 0) return <div className="nv-card">{lineSelect !== null ? <div className="nv-audio-summary"><strong>{t('一键制作', 'Produce in one go')}</strong>{lineSelect}</div> : null}<p className="nv-muted">{plotLines.length > 0 ? t('这条线还没有写出正文的章节。', 'No chapter of this line has text yet.') : t('还没有写出正文的章节。', 'No chapter has text yet.')}{shared > 0 ? t(`（它和分出的那条线共有的 ${shared} 章在那条线上做。）`, ` (The ${shared} chapter(s) it shares with the line it parts from are produced on that line.)`) : ''}</p></div>
  const order = STAGE_STEPS.filter(step => chosen.has(step))
  return (
    <div className="nv-production">
      <section className="nv-card">
        <div className="nv-audio-summary">
          <strong>{t('一键制作', 'Produce in one go')}</strong>
          {lineSelect}
          <span className="nv-muted nv-small">{t('已经做好的不会重做；中途停下，下次接着来。', 'What is done is not done again; stopped midway, it picks up from there.')}{shared > 0 ? t(` 这条线和它分出的那条线共有的 ${shared} 章在那条线上做。`, ` The ${shared} chapter(s) this line shares with the one it parts from are produced on that line.`) : ''}</span>
        </div>
        <div className="nv-steps-pick">
          {STAGE_STEPS.map((step) => {
            const why = missing[step]
            return (
              <label key={step} className={cx('nv-step-pick', chosen.has(step) && 'is-on', why !== undefined && 'is-off')} title={why !== undefined ? why : t(...STAGE_STEP_HINT[step]!)}>
                <input type="checkbox" checked={chosen.has(step)} onChange={() => { toggleStep(step) }} />
                <span className="nv-step-name">{t(...BATCH_STEP[step]!)}</span>
                <span className="nv-step-hint">{why !== undefined ? why : t(...STAGE_STEP_HINT[step]!)}</span>
              </label>
            )
          })}
        </div>
        <div className="nv-row-wrap">
          {chosen.has('storyboard') ? (
            <label className="nv-inline-field">
              <span className="nv-muted nv-small">{t('分镜密度', 'Storyboard cut')}</span>
              <Select value={density} options={STORYBOARD_DENSITIES.map(value => ({ value, label: t(...DENSITY[value]) }))} onChange={setDensity} />
            </label>
          ) : null}
          <label className="nv-check" title={t('已经做好的也重新做一遍', 'Do again what is already done')}>
            <input type="checkbox" checked={force} onChange={(event) => { setForce(event.target.checked) }} />
            <span>{t('已有的也重做', 'Redo what is there')}</span>
          </label>
          <span className="nv-spacer" />
          <span className="nv-muted nv-small">{t(`已选 ${count} 章`, `${count} chapters chosen`)}{under.length > 0 ? t(` · ${under.length} 批在做，新的同时开始`, ` · ${under.length} under way; a new one starts beside them`) : ''}</span>
          <Button variant="primary" icon="sparkles" busy={busy} disabled={count === 0 || order.length === 0} pending={t('正在开始…', 'Starting…')} onClick={() => start({ chapters: going.map(status => status.id), steps: order, force })}>
            {t(`一键制作 ${count} 章`, `Produce ${count} chapters`)}
          </Button>
        </div>
        {chosen.has('video') ? (
          <Field label={t('对成片的要求', 'What to ask of the cut')}>
            <TextArea value={direction} minRows={1} maxRows={4} placeholder={t('例如：节奏慢一点，换画面用淡入淡出', 'For example: slower, with cross-fades between pictures')} onChange={(event) => { setDirection(event.target.value) }} />
            <label className="nv-check">
              <input type="checkbox" checked={subtitles} onChange={(event) => { setSubtitles(event.target.checked) }} />
              <span>{t('成片带字幕', 'Subtitles in the cut')}</span>
            </label>
          </Field>
        ) : null}
        {order.some(step => missing[step] !== undefined) ? <p className="nv-note is-warn">{t('选中的步骤里有现在做不了的：', 'Some of the chosen steps cannot run right now: ')}{order.filter(step => missing[step] !== undefined).map(step => `${t(...BATCH_STEP[step]!)}（${missing[step]}）`).join(t('；', '; '))} <button type="button" className="nv-link" onClick={() => { controller.setView('settings') }}>{t('去设置', 'Open the settings')}</button></p> : null}
      </section>

      {under.length > 0
        ? under.map(candidate => <section key={candidate.id} className="nv-card"><BatchMatrix job={candidate} /></section>)
        : job !== undefined ? <section className="nv-card"><BatchMatrix job={job} onAgain={last !== undefined ? () => start(last) : undefined} /></section> : null}

      <section className="nv-card">
        <div className="nv-row-wrap">
          <strong>{t('各章进度', 'Where each chapter stands')}</strong>
          <span className="nv-spacer" />
          <button type="button" className="nv-link" onClick={() => { setPicked(new Set(chapters.map(status => status.id))) }}>{t('全选', 'All')}</button>
          <button type="button" className="nv-link" onClick={() => { setPicked(undefined) }}>{t('只选还没做完的', 'Only what is unfinished')}</button>
          <button type="button" className="nv-link" onClick={() => { setPicked(new Set()) }}>{t('全不选', 'None')}</button>
        </div>
        <div className="nv-batch-scroll">
          <table className="nv-batch-table nv-production-table">
            <thead>
              <tr>
                <th />
                {STAGE_STEPS.map(step => <th key={step} className={cx(!chosen.has(step) && 'is-dim')}>{t(...BATCH_STEP[step]!)}</th>)}
              </tr>
            </thead>
            <tbody>
              {chapters.map(status => (
                <tr key={status.id}>
                  <th scope="row">
                    <label className="nv-check">
                      <input type="checkbox" checked={selected.has(status.id) && !taken.has(status.id)} disabled={taken.has(status.id)} title={taken.has(status.id) ? t('这一章正在制作', 'This chapter is being produced') : undefined} onChange={() => { toggle(status.id) }} />
                      <button type="button" className="nv-link nv-production-title" onClick={() => { onOpen(status.id) }} title={t('打开这一章的有声漫', 'Open this chapter\'s motion comic')}>{status.index}. {status.title}</button>
                      {taken.has(status.id) ? <Chip tone="blue">{t('在做', 'under way')}</Chip> : null}
                    </label>
                  </th>
                  {STAGE_STEPS.map((step) => {
                    const cell = cellOf(status, step, t)
                    return <td key={step} className={cx('nv-batch-cell', `is-tone-${cell.tone}`, !chosen.has(step) && 'is-dim')}>{cell.text}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {sheets.element}
    </div>
  )
}

// ───────────────────────────── text ─────────────────────────────

const TEXT_HINT: Record<TextStep, [string, string]> = {
  beats: ['没有节拍的章节，先让策划推演节拍', 'The planner derives beats for chapters that have none'],
  write: ['写手一章接一章地写：每一章都读过前面刚写的', 'The writer goes chapter after chapter, each knowing the one just written'],
  digest: ['场记把写好的章节收录进记忆', 'The scribe digests written chapters into memory'],
  review: ['场记审校每一章，问题记在审校页', 'Continuity reviews each chapter; issues go to the Review page'],
}

/**
 * A run of chapters in one go: written one after the other, or given beats,
 * memory or a review side by side.
 * @param preset - which steps are ticked to begin with.
 * @param line - the line of the plot the chapters are on, when it is not the main one.
 */
export function TextBatchDialog({ chapters, preset, line, onClose }: { chapters: ChapterInfo[]; preset: TextStep[]; line?: string | undefined; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const { busy, run } = useAction()
  const job = useBatchJob('text')
  const running = job?.status === 'running'
  const [steps, setSteps] = useState<Set<TextStep>>(new Set(preset))
  const writing = steps.has('write')
  const unwritten = chapters.filter(chapter => !chapter.hasText)
  const [count, setCount] = useState(String(Math.min(10, Math.max(1, unwritten.length))))
  const [scope, setScope] = useState<'next' | 'pick'>('next')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [brief, setBrief] = useState('')
  const [words, setWords] = useState('')
  const [redo, setRedo] = useState(false)
  const [started, setStarted] = useState(false)
  // One after the other unless the author chooses otherwise; what they chose is kept.
  const [order, setOrder] = useKept<'sequence' | 'together' | 'iterate'>('batch.order', 'sequence')
  // Written in rounds: how many at most, and how grave an issue is worth one.
  const [rounds, setRounds] = useKept<number>('batch.rounds', 2)
  const [atLeast, setAtLeast] = useKept<'high' | 'medium' | 'low'>('batch.atLeast', 'medium')
  const [last, setLast] = useState<Parameters<typeof controller.api.call<'batch.text'>>[1] | undefined>()
  const toggleStep = (step: TextStep): void => {
    const next = new Set(steps)
    if (next.has(step)) next.delete(step)
    else next.add(step)
    // A run of chapters is written with memory in between: the next chapter knows what the last one settled.
    if (next.has('write')) next.add('digest')
    setSteps(next)
  }
  // What the steps have something to do for, when the author does not pick chapters one by one.
  const candidates = chapters.filter(chapter => writing ? (!chapter.hasText || redo) : steps.has('beats') ? !chapter.hasText || redo : steps.has('digest') ? chapter.hasText && (!chapter.digested || redo) : steps.has('review') ? chapter.hasText && (chapter.openIssues === undefined || redo) : false)
  const amount = scope === 'pick' ? picked.size : writing ? Math.min(candidates.length, Math.max(1, Number(count) || 1)) : candidates.length
  const start = (): Promise<unknown> => run(async () => {
    const params = {
      root,
      steps: [...steps],
      ...(line !== undefined ? { line } : {}),
      ...(scope === 'pick' ? { chapters: [...picked] } : writing ? { count: Math.max(1, Number(count) || 1) } : {}),
      ...(brief.trim().length > 0 ? { brief: brief.trim() } : {}),
      ...(/^\d+$/.test(words) && Number(words) > 0 ? { words: Number(words) } : {}),
      ...(redo ? { redo: true } : {}),
      ...(writing && order === 'together' ? { order: 'together' as const } : {}),
      ...(writing && order === 'iterate' ? { order: 'iterate' as const, rounds, atLeast } : {}),
    }
    setLast(params)
    await controller.api.call('batch.text', params)
    setStarted(true)
    await controller.refreshJobs()
  })
  const again = last !== undefined ? () => run(async () => { await controller.api.call('batch.text', last); await controller.refreshJobs() }) : undefined
  return (
    <Modal wide title={t('批量：写作与整理', 'Batch: writing and upkeep')} onClose={onClose} footer={started && job !== undefined ? (
      <>
        <span className="nv-muted nv-small">{t('可以关掉这个窗口，任务在后台继续。', 'This window can be closed; the batch carries on.')}</span>
        <span className="nv-spacer" />
        <Button onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    ) : (
      <>
        <span className="nv-muted nv-small">{amount > 0 ? t(`将处理 ${amount} 章`, `${amount} chapters`) : t('没有要处理的章节', 'Nothing to do for any chapter')}{writing && amount > 1 ? (order === 'together' ? t(' · 并发：各章照章纲同时写', ' · side by side, each from its outline') : t(' · 顺序：后一章读得到前一章', ' · in order, each knowing the one before')) : ''}</span>
        <span className="nv-spacer" />
        <div className="nv-split-btn">
          <Button variant="primary" icon="sparkles" busy={busy} disabled={running || steps.size === 0 || amount === 0} pending={t('正在开始…', 'Starting…')} onClick={start}>{writing ? (order === 'together' ? t('并发写', 'Write side by side') : order === 'iterate' ? t(`多轮迭代写（最多 ${rounds} 轮）`, `Write in rounds (${rounds} at most)`) : t('顺序写', 'Write in order')) : t('开始', 'Start')}</Button>
          {writing ? (
            <Menu icon="chevronDown" variant="primary" size="md" align="end" items={[
              { label: t(`${order === 'sequence' ? '✓ ' : ''}顺序：一章接一章，前后更一致`, `${order === 'sequence' ? '✓ ' : ''}In order: chapter after chapter, more of a piece`), onSelect: () => { setOrder('sequence') } },
              { label: t(`${order === 'together' ? '✓ ' : ''}并发：同时写，更快`, `${order === 'together' ? '✓ ' : ''}Side by side: at once, faster`), onSelect: () => { setOrder('together') } },
              { label: t(`${order === 'iterate' ? '✓ ' : ''}多轮迭代：写完再审校、统一修、重审`, `${order === 'iterate' ? '✓ ' : ''}In rounds: written, then reviewed, mended together, reviewed again`), onSelect: () => { setOrder('iterate') } },
            ]} />
          ) : null}
        </div>
      </>
    )}>
      {started && job !== undefined ? <BatchMatrix job={job} onAgain={again} /> : (
        <>
          {running ? <p className="nv-note is-warn">{t('已经有一个批量任务在跑，等它结束或在“任务”里停掉它。', 'A batch is running already: wait for it, or stop it under Jobs.')}</p> : null}
          <div className="nv-steps-pick">
            {(['beats', 'write', 'digest', 'review'] as TextStep[]).map(step => (
              <label key={step} className={cx('nv-step-pick', steps.has(step) && 'is-on')}>
                <input type="checkbox" checked={steps.has(step)} disabled={step === 'digest' && writing} onChange={() => { toggleStep(step) }} />
                <span className="nv-step-name">{t(...BATCH_STEP[step]!)}</span>
                <span className="nv-step-hint">{step === 'write' && order === 'together' ? t('各章同时写：每一章照自己的章纲，和它前面各章的章纲', 'All at once: each from its own outline and the outlines of the chapters before it') : t(...TEXT_HINT[step])}</span>
              </label>
            ))}
          </div>
          {writing && order === 'iterate' ? (
            // What writing in rounds does, and what it costs: said where it is chosen.
            <div className="nv-note nv-rounds">
              <p><strong>{t('多轮迭代', 'Writing in rounds')}</strong>{t('：各章照顺序写完、收录、审校之后，策划把审校出来的问题放在一起看，统一定下怎么改（可以跨章），每章重写一次；改过的章节重新收录、重新审校，再来一轮——直到没有这一级的问题，或轮数用完。', ': once the chapters are written in order, digested and reviewed, the planner reads what the reviews found side by side and settles how to mend it (across chapters where need be); each chapter is rewritten once, digested and reviewed again — and so on, until nothing of this gravity is left or the rounds are used up.')}</p>
              <p className="nv-muted nv-small">{t('每一轮的修改直接写进正文（下一轮要接着它改），被换掉的每一稿都留在这一章的“版本”里。比只写一遍慢得多、花得多：一轮 = 策划一趟 + 每个改到的章节各一次重写、收录、审校。', 'What a round changes goes into the text (the next round goes on from it); every draft it replaces stays among the chapter\'s versions. Much slower and dearer than writing once: a round is one run of the planner, and a rewrite, a digest and a review for each chapter it changes.')}</p>
              <div className="nv-form-grid">
                <Field label={t('最多几轮', 'Rounds at most')}>
                  <Select<string> value={String(rounds)} options={[1, 2, 3, 4, 5].map(count => ({ value: String(count), label: t(`${count} 轮`, `${count}`) }))} onChange={(value) => { setRounds(Number(value)) }} />
                </Field>
                <Field label={t('修哪些问题', 'Which issues are mended')}>
                  <Select<'high' | 'medium' | 'low'> value={atLeast} options={[
                    { value: 'high', label: t('只修严重的', 'The grave ones only') },
                    { value: 'medium', label: t('中等及以上', 'Medium and graver') },
                    { value: 'low', label: t('全部', 'All of them') },
                  ]} onChange={setAtLeast} />
                </Field>
              </div>
            </div>
          ) : null}
          <div className="nv-form-grid">
            <Field label={t('哪些章节', 'Which chapters')}>
              <Select value={scope} options={[
                { value: 'next', label: writing ? t('从第一个没写的章节起，连续写', 'From the first unwritten chapter on') : t('所有还没做这一步的章节', 'Every chapter the steps have something to do for') },
                { value: 'pick', label: t('我来挑', 'Let me pick') },
              ]} onChange={setScope} />
            </Field>
            {scope === 'next' && writing ? (
              <Field label={t('写几章', 'How many')} hint={t(`大纲里还有 ${candidates.length} 章没写`, `${candidates.length} chapters of the outline are not written`)}>
                <TextInput inputMode="numeric" value={count} onChange={(event) => { setCount(event.target.value.replace(/\D/g, '').slice(0, 3)) }} />
              </Field>
            ) : null}
            {writing ? (
              <Field label={t('每章字数', 'Words per chapter')} hint={t('不填：用各章自己的预算，没有预算的由写手判断', 'Empty: each chapter\'s own recommendation; where there is none, the writer judges')}>
                <TextInput inputMode="numeric" value={words} placeholder={t('由写手判断', 'left to the writer')} onChange={(event) => { setWords(event.target.value.replace(/\D/g, '').slice(0, 6)) }} />
              </Field>
            ) : null}
          </div>
          {scope === 'pick' ? (
            <div className="nv-chips nv-batch-pick">
              {chapters.map(chapter => (
                <Chip key={chapter.id} active={picked.has(chapter.id)} tone={picked.has(chapter.id) ? 'blue' : 'neutral'} onClick={() => { setPicked((previous) => { const next = new Set(previous); if (next.has(chapter.id)) next.delete(chapter.id); else next.add(chapter.id); return next }) }}>
                  {chapter.index}. {chapter.title}{chapter.hasText ? '' : t('（未写）', ' (unwritten)')}
                </Chip>
              ))}
            </div>
          ) : null}
          {writing ? (
            <Field label={t('对这一批章节的要求', 'What to ask of these chapters')}>
              <TextArea value={brief} minRows={2} maxRows={6} onChange={(event) => { setBrief(event.target.value) }} />
            </Field>
          ) : null}
          <label className="nv-check">
            <input type="checkbox" checked={redo} onChange={(event) => { setRedo(event.target.checked) }} />
            <span>{writing ? t('已经有正文的章节也重写', 'Rewrite chapters that already have text') : t('已经做过的也重做', 'Redo what was done already')}</span>
          </label>
          
        </>
      )}
    </Modal>
  )
}

// ───────────────────────────── pictures and voices ─────────────────────────────

type ArtPick = 'sheets' | 'portraits' | 'voices' | 'places' | 'items' | 'scenes' | 'cover'

/** What the book still lacks in pictures and voices, and one button to make it. */
export function ArtBatchDialog({ onClose }: { onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const settings = useSnapshot(snapshot => snapshot.settings)
  const images = useLoad(signal => controller.api.call('image.list', { root }, signal), [root, project.revision])
  const { busy, run } = useAction()
  const job = useBatchJob('art')
  const running = job?.status === 'running'
  const [started, setStarted] = useState(false)
  const [insert, setInsert] = useState(true)
  // Who the sheets, portraits and voices are for: in a large cast, those who carry the story, until the author says otherwise.
  const [filter, setFilter] = useCastFilter('art-batch', project.characters)
  const [who, setWho] = useState<Set<string>>(() => {
    const first = defaultCastFilter(project.characters)
    return new Set(project.characters.filter(card => matchesCast(card, first)).map(card => card.id))
  })
  const lists = useMemo(() => {
    const pictures = images.data?.images ?? []
    const seenPlaces = new Map((project.worldPresence ?? []).map(item => [item.entry, item.chapters.length]))
    const writtenChapters = project.chapters.filter(chapter => chapter.hasText).length
    return {
      sheets: project.characters.filter(card => who.has(card.id) && card.visual?.sheet === undefined).map(card => card.id),
      portraits: project.characters.filter(card => who.has(card.id) && card.visual?.portrait === undefined).map(card => card.id),
      voices: project.characters.filter(card => who.has(card.id) && card.voiceProfile?.voice === undefined).map(card => card.id),
      // The places the story lives in or comes back to: an inn passed once needs no design art (it can be drawn from its own page).
      places: project.world.filter(entry => entry.category === 'location' && entry.visualImage === undefined && ['core', 'major'].includes(worldWeight(entry, seenPlaces.get(entry.id) ?? 0, writtenChapters))).map(entry => entry.id),
      // The things the story turns on, by the same measure: a cup lifted once is not drawn for.
      items: project.world.filter(entry => groupOf(entry.category) === 'items' && entry.visualImage === undefined && ['core', 'major'].includes(worldWeight(entry, seenPlaces.get(entry.id) ?? 0, writtenChapters))).map(entry => entry.id),
      scenes: project.chapters.filter(chapter => chapter.hasText && !pictures.some(picture => picture.kind === 'scene' && picture.target === chapter.id)).map(chapter => chapter.id),
    }
  }, [project, images.data, who])
  const noCover = project.cover === undefined
  const [picked, setPicked] = useState<Set<ArtPick>>(new Set(['sheets']))
  const [last, setLast] = useState<Parameters<typeof controller.api.call<'batch.art'>>[1] | undefined>()
  const toggle = (key: ArtPick): void => {
    const next = new Set(picked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setPicked(next)
  }
  const rows: { key: ArtPick; label: [string, string]; hint: [string, string]; count: number; needs: 'image' | 'tts' }[] = [
    { key: 'sheets', label: ['人设图（三视图）', 'Design sheets'], hint: ['先画它：之后有这个人的图都拿它当参考', 'Drawn first: every later picture of the person is drawn against it'], count: lists.sheets.length, needs: 'image' },
    { key: 'portraits', label: ['立绘', 'Portraits'], hint: ['头像和幕间舞台用', 'For avatars and the interlude stage'], count: lists.portraits.length, needs: 'image' },
    { key: 'places', label: ['场景设定图', 'Place art'], hint: ['核心和重要的地点', 'Central and major places'], count: lists.places.length, needs: 'image' },
    { key: 'items', label: ['物品设定图', 'Thing art'], hint: ['核心和重要的物品', 'Central and major things'], count: lists.items.length, needs: 'image' },
    { key: 'scenes', label: ['章节插图', 'Chapter illustrations'], hint: ['每章一张，照这一章的梗概画', 'One per chapter, drawn from its summary'], count: lists.scenes.length, needs: 'image' },
    { key: 'cover', label: ['封面', 'Cover'], hint: ['照故事核和主角的样子画', 'From the premise and the look of the leads'], count: noCover ? 1 : 0, needs: 'image' },
    { key: 'voices', label: ['专属声线', 'Voices of their own'], hint: ['按人物卡的声音描述给每个人设计一个声音', 'A voice designed for each character from what their card says'], count: lists.voices.length, needs: 'tts' },
  ]
  const ready = { image: settings?.ready.image === true, tts: settings?.ready.tts === true }
  const total = rows.filter(row => picked.has(row.key)).reduce((sum, row) => sum + row.count, 0)
  const sheets = useSheetsAsk()
  const start = (): Promise<unknown> => run(async () => {
    const mine = {
      root,
      ...(picked.has('sheets') && lists.sheets.length > 0 ? { sheets: lists.sheets } : {}),
      ...(picked.has('portraits') && lists.portraits.length > 0 ? { portraits: lists.portraits } : {}),
      ...(picked.has('voices') && lists.voices.length > 0 ? { voices: lists.voices } : {}),
      ...(picked.has('places') && lists.places.length > 0 ? { places: lists.places } : {}),
      ...(picked.has('items') && lists.items.length > 0 ? { items: lists.items } : {}),
      ...(picked.has('scenes') && lists.scenes.length > 0 ? { scenes: lists.scenes, ...(insert ? { insert: true } : {}) } : {}),
      ...(picked.has('cover') && noCover ? { cover: true } : {}),
    }
    // Whose design sheets the portraits, the chapters' pictures and the cover would draw first — beyond the sheets this
    // batch lists as steps of its own — is asked before anything is started.
    await sheets.before([
      ...(mine.portraits ?? []).map(target => ({ kind: 'portrait' as const, target })),
      ...(mine.scenes ?? []).map(target => ({ kind: 'scene' as const, target })),
      ...(mine.cover === true ? [{ kind: 'cover' as const }] : []),
    ], async (choice) => {
      const params = { ...mine, ...choice }
      setLast(params)
      await controller.api.call('batch.art', params)
      setStarted(true)
      await controller.refreshJobs()
    }, mine.sheets ?? [])
  })
  const again = last !== undefined ? () => run(async () => { await controller.api.call('batch.art', last); await controller.refreshJobs() }) : undefined
  return (
    <Modal wide title={t('批量绘制', 'Draw in a batch')} onClose={onClose} footer={started && job !== undefined ? (
      <>
        <span className="nv-muted nv-small">{t('可以关掉这个窗口：批量任务在后台继续。', 'This window can be closed: the batch goes on.')}</span>
        <span className="nv-spacer" />
        <Button onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    ) : (
      <>
        <span className="nv-muted nv-small">{total > 0 ? t(`共 ${total} 项`, `${total} in all`) : t('选中的这些都已经有了', 'Everything chosen is there already')}</span>
        <span className="nv-spacer" />
        <Button variant="primary" icon="sparkles" busy={busy} disabled={running || total === 0} pending={t('正在开始…', 'Starting…')} onClick={start}>{t('开始', 'Start')}</Button>
      </>
    )}>
      {started && job !== undefined ? <BatchMatrix job={job} onAgain={again} /> : (
        <>
          <p className="nv-muted nv-small">{t('只做还没有的。人设图和设定图先画，其余照着它们画。', 'Only what is missing. Sheets and art come first; the rest is drawn against them.')}</p>
          <div className="nv-steps-pick">
            {rows.map(row => (
              <label key={row.key} className={cx('nv-step-pick', picked.has(row.key) && row.count > 0 && 'is-on', (row.count === 0 || !ready[row.needs]) && 'is-off')} title={!ready[row.needs] ? (row.needs === 'image' ? t('还没有配置图像模型', 'No image model is set up') : t('还没有配置语音模型', 'No speech model is set up')) : undefined}>
                <input type="checkbox" checked={picked.has(row.key) && row.count > 0} disabled={row.count === 0 || !ready[row.needs]} onChange={() => { toggle(row.key) }} />
                <span className="nv-step-name">{t(...row.label)} <span className="nv-muted">{row.count > 0 ? t(`缺 ${row.count}`, `${row.count} missing`) : t('都有了', 'all there')}</span></span>
                <span className="nv-step-hint">{!ready[row.needs] ? (row.needs === 'image' ? t('还没有配置图像模型', 'No image model is set up') : t('还没有配置语音模型', 'No speech model is set up')) : t(...row.hint)}</span>
              </label>
            ))}
          </div>
          {picked.has('scenes') && lists.scenes.length > 0 ? (
            <label className="nv-check">
              <input type="checkbox" checked={insert} onChange={(event) => { setInsert(event.target.checked) }} />
              <span>{t('把插图放进各章正文的开头', 'Put each illustration at the head of its chapter')}</span>
            </label>
          ) : null}
          {(picked.has('sheets') || picked.has('portraits') || picked.has('voices')) && project.characters.length > 0 ? (
            <section className="nv-batch-who">
              <SectionTitle>{t('给哪些人物做', 'For whom')}</SectionTitle>
              <p className="nv-muted nv-small">{t('人设图、立绘和声线只给选中的人做。', 'Sheets, portraits and voices are made only for those chosen.')}</p>
              <CharacterPicker
                cards={project.characters}
                selected={who}
                onChange={setWho}
                filter={filter}
                onFilter={setFilter}
                note={(card) => {
                  const lacks = [
                    picked.has('sheets') && card.visual?.sheet === undefined ? t('人设图', 'sheet') : undefined,
                    picked.has('portraits') && card.visual?.portrait === undefined ? t('立绘', 'portrait') : undefined,
                    picked.has('voices') && card.voiceProfile?.voice === undefined ? t('声线', 'voice') : undefined,
                  ].filter((item): item is string => item !== undefined)
                  return lacks.length > 0 ? t(`缺${lacks.join('、')}`, `no ${lacks.join(', ')}`) : t('都有了', 'has them all')
                }}
              />
            </section>
          ) : null}
        </>
      )}
      {sheets.element}
    </Modal>
  )
}

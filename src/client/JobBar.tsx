// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A job at work, the same wherever it shows: what it is, how far it has come,
 * what it is doing right now — and a way to the one doing it.
 *
 * Nearly all of the Studio's work is done by agents, and an agent at work is a
 * conversation of its own in DSH: its steps, what it read, what it is about to
 * hand in. So a bar of progress is not something to stare at: press it, and
 * the agent's conversation opens. Work that is one plain request has no
 * conversation; pressing its bar unfolds what it has written so far.
 *
 *   JobBar        the control
 *   agentOf       the agent of a job that can be opened now: the one at work, else the last that worked
 *   JobOutput     what a job has written, read as it is written
 */
import { useEffect, useState } from 'react'
import type { CrewRun, JobInfo } from '../shared/types'
import { isCancelled } from './api'
import { Icon } from './icons'
import { jobLabel, jobPulse } from './Studio'
import { crewLabel, cx, Spinner, ThoughtButton, useSnapshot, useStudio, useT } from './ui'

/** A run that can be shown: recorded in a session, under a conversation the Harness lists it by. */
type Openable = CrewRun & { session: string; parent: string }

const openable = (run: CrewRun): run is Openable => run.session !== undefined && run.parent !== undefined

/** The agent of a job to look at: the one at work now, else the last that worked. */
export function agentOf(job: JobInfo): Openable | undefined {
  const runs = (job.crew ?? []).filter(openable)
  return [...runs].reverse().find(run => run.running === true) ?? runs.at(-1)
}

const elapsed = (since: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The tail of what a job has written, kept up as it writes. */
export function JobOutput({ job }: { job: JobInfo }) {
  const { controller } = useStudio()
  const t = useT()
  const [text, setText] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    let cursor = 0
    let stopped = false
    void (async () => {
      while (!stopped) {
        try {
          const state = await controller.api.call('jobs.read', { id: job.id, cursor, waitMs: 15_000 }, abort.signal)
          if (stopped) return
          if (state.text.length > 0) setText(previous => (previous + state.text).slice(-6000))
          cursor = state.cursor
          if (state.info.status !== 'running') return
        } catch (error) {
          if (isCancelled(error) || stopped) return
          // The Host blinked: what was read stays, and the bar itself keeps telling how far the job is.
          return
        }
      }
    })()
    return () => {
      stopped = true
      abort.abort()
    }
  }, [controller, job.id])
  return <pre className="nv-jobbar-output">{text.length > 0 ? text : t('还没有输出。', 'Nothing written yet.')}</pre>
}

/**
 * @param now - the clock of whoever lists several bars, so they tick together; absent, the bar shows no time.
 * @param dense - one line, for a dock or a table cell.
 */
export function JobBar({ job, now, dense, className }: { job: JobInfo; now?: number; dense?: boolean; className?: string }) {
  const { controller, host } = useStudio()
  const t = useT()
  const project = useSnapshot(snapshot => snapshot.project)
  const [unfolded, setUnfolded] = useState(false)
  const running = job.status === 'running'
  const agent = agentOf(job)
  const canOpen = agent !== undefined && host.openRun !== undefined
  const pulse = jobPulse(job, t)
  const done = job.progress?.done ?? 0
  const total = job.progress?.total ?? 0
  const share = total > 0 ? Math.max(0, Math.min(1, done / total)) : undefined
  const press = (): void => {
    if (canOpen) host.openRun!({ session: agent.session, parent: agent.parent })
    else setUnfolded(value => !value)
  }
  const hint = canOpen
    ? agent.running === true
      ? t(`看${crewLabel(agent.role, t)}正在做什么`, `See what the ${crewLabel(agent.role, t)} is doing`)
      : t(`打开${crewLabel(agent.role, t)}这次运行的记录`, `Open the record of the ${crewLabel(agent.role, t)}'s run`)
    : (job.crew ?? []).some(run => run.running === true && run.session !== undefined && run.parent === undefined)
      ? t('展开看它写出来的东西。这本书还没有对话，agent 那场对话打不开；它每一步发了什么、回了什么，在“任务”里这一行的“请求”里', 'Unfold what it has written. This book has no conversation yet, so the agent\'s own cannot be opened; what each of its steps sent and got back is under Requests on its row in Jobs')
      : t('展开看它写出来的东西', 'Unfold what it has written')
  return (
    <div className={cx('nv-jobbar', dense === true && 'is-dense', !running && `is-${job.status}`, className)}>
      <div className="nv-jobbar-row">
        <button type="button" className="nv-jobbar-main" onClick={press} title={hint} aria-expanded={canOpen ? undefined : unfolded}>
          {running ? <Spinner size={12} /> : <Icon name={job.status === 'done' ? 'check' : 'alert'} size={12} />}
          <span className="nv-jobbar-title">{jobLabel(job, t, project)}</span>
          {total > 1 ? <span className="nv-jobbar-count">{done}/{total}</span> : null}
          <span className="nv-jobbar-pulse">{running ? pulse ?? t('进行中…', 'working…') : job.error ?? ''}</span>
          {canOpen ? (
            <span className="nv-jobbar-agent">
              <Icon name="users" size={11} />
              {agent.running === true ? t(`看${crewLabel(agent.role, t)}`, `Watch the ${crewLabel(agent.role, t)}`) : t('看记录', 'Its record')}
            </span>
          ) : null}
        </button>
        <ThoughtButton job={job} />
        {now !== undefined && running ? <span className="nv-jobbar-time">{elapsed(Date.parse(job.startedAt), now)}</span> : null}
        {job.origin === 'agent' ? <span className="nv-jobbar-tag" title={t('这是对话里的总编发起的', 'Started by the showrunner in the conversation')}>{t('总编', 'agent')}</span> : null}
        {running ? <button type="button" className="nv-jobbar-stop" onClick={() => { void controller.cancelJob(job.id) }} title={t('停止', 'Stop')} aria-label={t('停止', 'Stop')}><Icon name="stop" size={11} /></button> : null}
      </div>
      {share !== undefined && running ? <div className="nv-jobbar-track" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></div> : null}
      {unfolded && !canOpen ? <JobOutput job={job} /> : null}
    </div>
  )
}

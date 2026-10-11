// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Comparing services and models: the same piece of work done by several at
 * once, and what each made of it side by side.
 *
 * One way of asking for all of it — pick who takes part, press, read the
 * results as they come, take one or none — whether what is compared is a
 * picture (image services), a line spoken (speech setups), a chapter (the
 * writer's model) or chapters to come (the planner's). Nothing a comparison
 * makes takes the place of anything until the author takes it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ModelOption } from '../shared/rpc'
import type { IllustrationInfo, ImageTrial, JobInfo, PictureGuide, SpeechTrial, TrialDraft, TrialPicture, TrialTake } from '../shared/types'
import { imageSetupName, speechSetupName } from '../shared/images'
import { RpcError } from './api'
import { ImageModelField, ModelField, speechEndpoint, speechSuggestions, withSpeechModel } from './ModelField'
import { Button, Chip, cx, Field, Modal, ProjectImage, Select, Spinner, TextArea, TextInput, useLoad, useMediaUrl, useProject, useSnapshot, useStudio, useT } from './ui'

/**
 * What a dialog started, by what it draws: found again when the dialog is opened again on the same thing — the jobs
 * (they go on drawing whether or not anybody watches) and, of a press that drew many things, its round.
 */
const begun = new Map<string, { ids: string[]; round?: string }>()
/** How many dialogs are open on a thing right now: what finishes with none open is said where the author is. */
const watched = new Map<string, number>()
/** The jobs whose end was said already (a dialog opened and closed twice has two watchers of the same jobs). */
const told = new Set<string>()

/**
 * A job started here and watched until it is over: what it has said so far, and how it ended.
 * @param key - what the dialog draws. With it, a job started before the dialog was closed is taken up again when it
 *   is opened on the same thing, and `unseen` is called when the job ends with no dialog open on it.
 */
function useTrialJob(key?: string, unseen?: (ended: { infos: JobInfo[]; error?: string }) => void): { start: (begin: () => Promise<{ jobId: string } | { jobId: string }[]>, round?: string) => void; live: JobInfo | undefined; done: JobInfo | undefined; busy: boolean; error: string | undefined; round: string | undefined; stop: () => void } {
  const { controller } = useStudio()
  const known = key !== undefined ? begun.get(key) : undefined
  // Still at it when the dialog is opened again: said at once, off the jobs the Studio knows of. (One that is over
  // is not taken up again: what it drew and nobody took is in the gallery, and is read from there.)
  const still = useSnapshot(snapshot => (known?.ids ?? []).some(id => snapshot.jobs.find(job => job.id === id)?.status === 'running'))
  const [jobId, setJobId] = useState<string | undefined>(still ? known?.ids.at(-1) : undefined)
  const [round, setRound] = useState<string | undefined>(known?.round)
  const [done, setDone] = useState<JobInfo | undefined>()
  const [error, setError] = useState<string | undefined>()
  const live = useSnapshot(snapshot => (jobId !== undefined ? snapshot.jobs.find(job => job.id === jobId) : undefined))
  const [busy, setBusy] = useState(still)
  const say = useRef(unseen)
  say.current = unseen
  const wait = (ids: string[]): void => {
    void (async () => {
      let ended: { infos: JobInfo[]; error?: string } = { infos: [] }
      try {
        // One press may be several jobs (a portrait for each of a list of people): it is over when they all are.
        const infos = await Promise.all(ids.map(async id => await controller.follow(id).done))
        setDone(infos.find(one => one.status === 'done') ?? infos.at(-1))
        ended = { infos }
      } catch (reason) {
        const message = reason instanceof RpcError || reason instanceof Error ? reason.message : String(reason)
        setError(message)
        ended = { infos: [], error: message }
      } finally {
        setBusy(false)
        void controller.refreshJobs()
      }
      // Nobody was looking: said once, where the author is now.
      const name = ids.join(',')
      if (key !== undefined && (watched.get(key) ?? 0) === 0 && !told.has(name)) {
        told.add(name)
        say.current?.(ended)
      }
    })()
  }
  useEffect(() => {
    if (key === undefined) return undefined
    watched.set(key, (watched.get(key) ?? 0) + 1)
    if (still && known !== undefined) wait(known.ids)
    return () => { watched.set(key, Math.max(0, (watched.get(key) ?? 1) - 1)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const start = (begin: () => Promise<{ jobId: string } | { jobId: string }[]>, inRound?: string): void => {
    setBusy(true)
    setDone(undefined)
    setError(undefined)
    setRound(inRound)
    void (async () => {
      try {
        const started = await begin()
        const ids = (Array.isArray(started) ? started : [started]).map(one => one.jobId)
        if (key !== undefined) begun.set(key, { ids, ...(inRound !== undefined ? { round: inRound } : {}) })
        setJobId(ids.at(-1))
        void controller.refreshJobs()
        wait(ids)
      } catch (reason) {
        setError(reason instanceof RpcError || reason instanceof Error ? reason.message : String(reason))
        setBusy(false)
      }
    })()
  }
  return { start, live: done ?? live, done, busy, error, round, stop: () => { for (const id of (key !== undefined ? begun.get(key)?.ids : undefined) ?? (jobId !== undefined ? [jobId] : [])) void controller.api.call('jobs.cancel', { id }).catch(() => {}) } }
}

const took = (seconds: number, t: (zh: string, en: string) => string): string => (seconds > 0 ? t(`${seconds} 秒`, `${seconds}s`) : '')

/** What a job that drew to compare says of one thing: each service's picture of it, or why there is none. (Of a press that drew many things it says the last of them, and how many pictures in all.) */
function triedOf(info: JobInfo | undefined): TrialPicture[] {
  const said = info?.result?.trial ?? (info?.result?.output as { tried?: unknown } | undefined)?.tried
  return Array.isArray(said) ? said as TrialPicture[] : []
}

/** Of a press that drew many things: the pictures a service did not make of something the others drew, and what the first of them answered. */
function missedBy(info: JobInfo | undefined): { count: number; why: string } | undefined {
  const said = (info?.result?.missed ?? (info?.result?.output as { missed?: unknown } | undefined)?.missed) as { count?: unknown; why?: unknown } | undefined
  return said !== undefined && typeof said.count === 'number' && said.count > 0 ? { count: said.count, why: typeof said.why === 'string' ? said.why : '' } : undefined
}

/** How many pictures a job drew to be compared. */
function drawnBy(info: JobInfo): number {
  const all = (info.result?.output as { tried?: unknown } | undefined)?.tried ?? info.result?.tried
  return typeof all === 'number' ? all : triedOf(info).filter(picture => picture.path !== undefined).length
}

// ───────────────────────────── pictures ─────────────────────────────

interface Row { key: string; setup: ImageTrial; ready: boolean; current: boolean; on: boolean; model: string }

/** The calls that draw, and can draw with several services at once. */
export type DrawMethod = 'image.create' | 'image.redraw' | 'comic.render' | 'batch.art' | 'batch.stage'

/**
 * A drawing a button would start, said so that it can be done with several services instead: which call, with what —
 * and what the author reads it as. `many`: it draws more than one thing (every panel of a chapter, a round of
 * portraits) — then what each service made of each is chosen in the gallery, or taken all at once by service.
 * `calls`: one press that is several calls (a likeness for each of a list of people).
 */
export interface DrawAsk {
  title: string
  method: DrawMethod
  params: Record<string, unknown>
  many?: boolean
  calls?: Record<string, unknown>[]
  /** A picture there is, drawn again: the one taken goes in its place. */
  instead?: string
}

/** What a dialog of pictures is opened on: somebody (a portrait of theirs), a picture there is, or any drawing a button starts. */
type TrialOf = { character?: { id: string; name: string }; picture?: { path: string; kind: string }; draw?: DrawAsk }

/**
 * The thing a dialog draws, said so that it can be found again: a name for it (what the dialog started is kept
 * under it), and — of one thing, not of a press that draws many — where its pictures wait to go, which tells the
 * ones drawn before and not taken yet. `stands`: of a picture drawn again, the one that stands in its place now.
 */
function thingOf(of: TrialOf, params: Record<string, unknown> | undefined, stands: string | undefined): { key: string; waits?: (image: IllustrationInfo) => boolean } {
  const draw = of.draw
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const asked = draw?.params ?? params ?? {}
  if (of.picture !== undefined || draw?.method === 'image.redraw') {
    const path = of.picture?.path ?? draw?.instead ?? text(asked.picture)
    const now = stands ?? path
    return { key: `instead:${path}`, waits: image => image.trial?.hang?.as === 'instead' && image.trial.hang.of === now }
  }
  if (draw?.many === true || draw?.calls !== undefined) return { key: `many:${draw.method}:${JSON.stringify(draw.calls ?? draw.params)}` }
  if (draw?.method === 'comic.render') {
    const panels = Array.isArray(asked.panels) ? asked.panels : []
    const chapter = text(asked.chapter)
    if (panels.length !== 1) return { key: `many:comic:${chapter}:${panels.join(',')}` }
    return { key: `panel:${chapter}:${String(panels[0])}`, waits: image => image.trial?.hang?.as === 'panel' && image.trial.hang.chapter === chapter && image.trial.hang.panel === panels[0] }
  }
  if (draw !== undefined && draw.method !== 'image.create') return { key: `many:${draw.method}:${JSON.stringify(draw.params)}` }
  const kind = of.character !== undefined && draw === undefined ? 'portrait' : text(asked.kind)
  const target = of.character !== undefined && draw === undefined ? of.character.id : text(asked.target)
  const stage = text(asked.stage)
  const look = text(asked.look)
  if (kind === 'portrait') return { key: `portrait:${target}:${stage}`, waits: image => image.trial?.hang?.as === 'portrait' && image.trial.hang.character === target && (image.trial.hang.stage ?? '') === stage }
  if (kind === 'sheet') {
    return {
      key: `sheet:${target}:${look}:${stage}`,
      waits: (image) => {
        const hang = image.trial?.hang
        if (hang?.as !== 'sheet' || hang.character !== target) return false
        return look.length > 0 ? hang.look?.id === look || hang.look?.name === look : hang.look === undefined && (hang.stage ?? '') === stage
      },
    }
  }
  if (kind === 'location' || kind === 'item') {
    const event = text(asked.event)
    return { key: `art:${target}:${event}`, waits: image => image.trial?.hang?.as === 'art' && image.trial.hang.entry === target && (image.trial.hang.event ?? '') === event }
  }
  if (kind === 'cover') return { key: 'cover', waits: image => image.trial?.hang?.as === 'cover' }
  if (kind === 'scene') {
    const quote = text(asked.quote)
    return { key: `passage:${target}:${quote}`, waits: image => image.trial?.hang?.as === 'passage' && image.trial.hang.chapter === target && (image.trial.hang.quote ?? '') === quote }
  }
  // (A picture of nothing the book keeps hangs nowhere: there is no telling which of those was this one.)
  return { key: `free:${JSON.stringify(asked)}` }
}

/**
 * A picture drawn once with each of several image services.
 * @param of.picture - a picture there is: it is drawn again as it is, by each service. `of.character`: a portrait
 *   of theirs is drawn by each (`params`: which moment, plain or not, what was asked of it). `of.draw`: any drawing
 *   a button of the Studio starts, by each.
 */
export function ImageTrialDialog({ of, params, onClose, onChanged }: { of: TrialOf; params?: Record<string, unknown>; onClose: () => void; onChanged?: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const setups = useLoad(signal => controller.api.call('trial.setups', { root }, signal), [root])
  const [rows, setRows] = useState<Row[] | undefined>()
  useEffect(() => {
    if (setups.data === undefined || rows !== undefined) return
    // Whatever can draw right now takes part unless the author says otherwise.
    setRows(setups.data.image.map(setup => ({ key: setup.id, setup: { label: setup.label, image: setup.image }, ready: setup.ready, current: setup.current, on: setup.ready, model: setup.image.model ?? '' })))
  }, [setups.data, rows])
  const draw = of.draw
  const many = draw?.many === true
  const instead = of.picture?.path ?? draw?.instead
  // Of a picture drawn again: the one that stands in its place now — the one taken here, once one is.
  const [stands, setStands] = useState<string | undefined>()
  const thing = thingOf(of, params, stands)
  const job = useTrialJob(thing.key, (ended) => {
    // Closed before it was over: the pictures wait all the same, and the author is told where.
    const drawn = ended.infos.reduce((sum, info) => sum + drawnBy(info), 0)
    const missed = ended.infos.map(missedBy).find(one => one !== undefined)
    if (ended.error !== undefined) controller.toast('error', t(`对比图没画成：${ended.error}`, `The pictures to compare were not drawn: ${ended.error}`))
    else controller.toast('success', t(`对比图画好了${drawn > 0 ? ` ${drawn} 张` : ''}：都留着，在页头的“待采纳”里，随时去选${missed !== undefined ? `。另有 ${missed.count} 张没画成（${missed.why}）` : ''}`, `The pictures to compare are drawn${drawn > 0 ? ` (${drawn})` : ''}: all kept, under "To take" in the header, to choose whenever you like${missed !== undefined ? `. ${missed.count} more could not be drawn (${missed.why})` : ''}`))
  })
  const [dropOthers, setDropOthers] = useState(false)
  const [taken, setTaken] = useState<TrialPicture | undefined>()
  // The pictures of the round that were deleted when one was taken: no longer shown.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const fresh = triedOf(job.live)
  // What was drawn of this thing before and has not been taken: a dialog closed loses nothing — it is all here again.
  const kept = useLoad(signal => controller.api.call('image.list', { root }, signal), [root, project.revision])
  const waiting = (kept.data?.images ?? []).filter(image => image.trial?.hang !== undefined)
  const earlier: (TrialPicture & { at?: string })[] = thing.waits === undefined ? [] : waiting
    .filter(image => thing.waits!(image) && !fresh.some(picture => picture.path === image.path))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(image => ({ label: image.trial!.label, path: image.path, ...(image.model !== undefined ? { model: image.model } : {}), seconds: 0, at: image.createdAt }))
  const pictures: (TrialPicture & { at?: string })[] = [...fresh, ...(taken !== undefined && !fresh.some(picture => picture.path === taken.path) ? [taken] : []), ...earlier]
  // Of a press that drew many things: what still waits of its round, and by whom.
  const roundWaits = job.round === undefined ? [] : waiting.filter(image => image.trial?.batch === job.round)
  const roundLabels = [...new Set(roundWaits.map(image => image.trial!.label))]
  const chosen = (rows ?? []).filter(row => row.on)
  const trials: ImageTrial[] = chosen.map((row) => {
    const model = row.model.trim()
    // Another model of the same service is a setup of its own, named by its model.
    if (model.length === 0 || model === (row.setup.image.model ?? '')) return row.setup
    const image = { ...row.setup.image, model }
    return { label: imageSetupName({ provider: image.provider ?? 'none', ...(image.baseURL !== undefined ? { baseURL: image.baseURL } : {}), model }), image }
  })
  const distinct = new Set(trials.map(trial => JSON.stringify(trial.image))).size
  // The pictures of one press that drew many things: taken together by service, or one by one in the gallery.
  const round = job.round
  const [roundTaken, setRoundTaken] = useState<string | undefined>()
  const start = (): void => {
    setTaken(undefined)
    setGone(new Set())
    setRoundTaken(undefined)
    const id = `round-${Date.now().toString(36)}`
    job.start(async (): Promise<{ jobId: string } | { jobId: string }[]> => {
      if (draw !== undefined) {
        const batch = many ? { trialBatch: id } : {}
        // One press that is several calls: each is started, and all of them are waited for.
        const started: { jobId: string }[] = []
        for (const call of draw.calls ?? [draw.params]) started.push(await controller.api.call(draw.method, { root, ...call, trials, ...batch } as never) as { jobId: string })
        return started
      }
      return of.picture !== undefined
        ? await controller.api.call('image.redraw', { root, picture: of.picture.path, trials })
        : await controller.api.call('image.create', { root, kind: 'portrait', target: of.character!.id, ...(params ?? {}), trials } as never)
    }, many ? id : undefined)
  }
  const takeRound = (label: string): Promise<unknown> => controller.guard(async () => {
    if (round === undefined) return
    const done = await controller.api.call('trial.adoptRound', { root, round, label, ...(dropOthers ? { others: true } : {}) })
    setRoundTaken(label)
    await controller.refreshProject()
    onChanged?.()
    controller.toast('success', t(`这一批用了「${label}」画的 ${done.taken} 张${done.removed > 0 ? `；另外 ${done.removed} 张删掉了` : '；其余的还在图库里'}`, `Took the ${done.taken} by ${label}${done.removed > 0 ? `; the other ${done.removed} deleted` : '; the rest stay in the gallery'}`))
  })
  const take = (picture: TrialPicture): Promise<unknown> => controller.guard(async () => {
    const others = dropOthers ? pictures.flatMap(other => (other.path !== undefined && other.path !== picture.path ? [other.path] : [])) : []
    const done = await controller.api.call('trial.adopt', { root, path: picture.path!, ...(instead !== undefined ? { instead: stands ?? instead } : {}), ...(others.length > 0 ? { others } : {}) })
    setTaken(picture)
    // It stands where the picture it was tried against stood: the rest of them wait to take that place from it.
    if (instead !== undefined) setStands(picture.path)
    if (others.length > 0) setGone(previous => new Set([...previous, ...others]))
    await controller.refreshProject()
    onChanged?.()
    controller.toast('success', t(`用了「${picture.label}」画的这张${done.replaced.length > 0 ? `，换到了 ${done.replaced.join('、')} 上` : ''}${done.removed > 0 ? `；另外 ${done.removed} 张删掉了` : '；其余的还在图库里'}`, `Took the one by ${picture.label}${done.replaced.length > 0 ? `, now on ${done.replaced.join(', ')}` : ''}${done.removed > 0 ? `; the other ${done.removed} deleted` : '; the others stay in the gallery'}`))
  })
  const edit = (key: string, patch: Partial<Row>): void => { setRows(previous => previous?.map(row => (row.key === key ? { ...row, ...patch } : row))) }
  const again = (row: Row): void => { setRows(previous => (previous === undefined ? previous : [...previous.slice(0, previous.indexOf(row) + 1), { ...row, key: `${row.key}+${previous.length}`, current: false, on: true, model: '' }, ...previous.slice(previous.indexOf(row) + 1)])) }
  const running = job.busy
  const title = draw !== undefined ? t(`用几个绘图服务画：${draw.title}`, `By several image services: ${draw.title}`) : of.picture !== undefined ? t('换几个绘图服务画同一张', 'The same picture by several image services') : t(`用几个绘图服务画「${of.character?.name ?? ''}」的立绘`, `A portrait of ${of.character?.name ?? ''} by several image services`)
  // Over — now, or while the dialog was closed: what its round still has to be taken says so.
  const finished = many && !running && ((job.done !== undefined && job.done.status === 'done') || roundWaits.length > 0)
  return (
    <Modal wide className="nv-modal-trial" title={title} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{many ? t('每一样各画一张，都留着；采纳了才算。可以关掉，之后再选。', 'One picture each, of every thing, all kept; nothing counts until taken. Close this and choose later.') : t('各画一张，都留着；采纳了才算。可以关掉，之后再选。', 'One picture each, all kept; nothing counts until one is taken. Close this and choose later.')}</span>
        <span className="nv-spacer" />
        {running ? <Button variant="ghost" onClick={job.stop}>{t('停止', 'Stop')}</Button> : null}
        <Button variant="primary" icon="layers" busy={running} disabled={distinct < 1 || chosen.length === 0} pending={t('正在画…', 'Drawing…')} onClick={start}>{many ? t(`每样画 ${trials.length} 张`, `${trials.length} of each`) : pictures.length > 0 ? t(`再画一轮（${trials.length} 张）`, `Another round (${trials.length})`) : t(`画 ${trials.length} 张来比`, `Draw ${trials.length} to compare`)}</Button>
      </>
    )}>
      {rows === undefined ? <div className="nv-center">{setups.error !== undefined ? <p className="nv-muted">{setups.error}</p> : <Spinner />}</div> : rows.length === 0 ? (
        <p className="nv-note">{t('还没有可以比的绘图服务。到“设置 → 图像生成”配一个；换到别的服务时，原来那个会记着，之后就能在这里一起比。', 'There is no image service to compare yet. Set one up under Settings → Image generation; when you move to another, the one before is remembered and can be compared here.')}</p>
      ) : (
        <div className="nv-trial-rows">
          {rows.map(row => (
            <div key={row.key} className={cx('nv-trial-row', !row.ready && 'is-off')}>
              <label className="nv-trial-who">
                <input type="checkbox" checked={row.on} disabled={!row.ready || running} onChange={(event) => { edit(row.key, { on: event.target.checked }) }} />
                <span className="nv-trial-name">{row.setup.label.split(' · ')[0]}{row.current ? <Chip tone="blue">{t('现在用的', 'in use')}</Chip> : null}{!row.ready ? <Chip>{t('还不能用：缺密钥或没连上', 'not ready: no key, or not reachable')}</Chip> : null}</span>
              </label>
              {/* The model is picked the way the settings pick it: from what the service lists, read again on a press. */}
              <div className="nv-trial-model">
                <ImageModelField bare t={t} value={{ ...row.setup.image, provider: row.setup.image.provider ?? 'none', model: row.model }} disabled={!row.ready || running} placeholder={t('模型（留空用它配好的）', 'Model (empty: as set up)')} onChange={(model) => { edit(row.key, { model }) }} />
              </div>
              {row.ready && row.setup.image.provider !== 'codex' ? <button type="button" className="nv-link nv-small" disabled={running} onClick={() => { again(row) }} title={t('同一个服务再加一行，选另一个模型', 'Another row of the same service, for another model')}>{t('＋ 再加一个模型', '+ another model')}</button> : null}
            </div>
          ))}
        </div>
      )}
      {job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      {many && (running || finished) ? (
        // Many things, each by every service: too many to lay out here — taken by service at once, or one by one in the gallery.
        <div className="nv-trial-round">
          {running ? <p className="nv-muted"><Spinner /> {t('正在画。画好的陆续出现在页头的“待采纳”里；这里可以关掉。', 'Drawing. The pictures appear under "To take" in the header as they come; this can be closed.')}</p> : (
            <>
              <p>{t('画好了。这一批用谁画的？', 'Done. Whose pictures does this round take?')}</p>
              {missedBy(job.done) !== undefined ? <p className="nv-note is-warn">{t(`有 ${missedBy(job.done)!.count} 张没画成：${missedBy(job.done)!.why}`, `${missedBy(job.done)!.count} could not be drawn: ${missedBy(job.done)!.why}`)}</p> : null}
              <div className="nv-row-wrap">
                {(roundLabels.length > 0 || roundTaken !== undefined ? [...new Set([...roundLabels, ...(roundTaken !== undefined ? [roundTaken] : [])])] : trials.map(trial => trial.label)).map(label => (roundTaken === label
                  ? <Chip key={label} tone="green">{t(`用了「${label}」的`, `took ${label}'s`)}</Chip>
                  : <Button key={label} size="sm" variant="outline" icon="check" disabled={roundTaken !== undefined} onClick={() => takeRound(label)}>{t(`都用「${label}」的`, `All by ${label}`)}</Button>))}
                <Button size="sm" variant="ghost" icon="image" onClick={() => { controller.navigate({ view: 'stage', tab: 'gallery' }); onClose() }}>{t('逐个挑…', 'Choose one by one…')}</Button>
              </div>
              <label className="nv-check nv-small">
                <input type="checkbox" checked={dropOthers} onChange={(event) => { setDropOthers(event.target.checked) }} />
                <span>{t('采纳时把别的服务画的删掉', 'When taken, delete what the other services drew')}</span>
              </label>
            </>
          )}
        </div>
      ) : null}
      {!many && pictures.length > 0 ? (
        <>
          <div className="nv-trial-grid">
            {pictures.filter(picture => picture.path === undefined || !gone.has(picture.path)).map((picture, at) => (
              <figure key={picture.path ?? `${picture.label}:${at}`} className={cx('nv-trial-cell', picture.path !== undefined && picture.path === taken?.path && 'is-taken')}>
                <div className="nv-trial-picture">
                  {picture.path !== undefined ? <ProjectImage path={picture.path} alt={picture.label} /> : picture.error !== undefined ? <p className="nv-trial-failed">{picture.error}</p> : <Spinner />}
                </div>
                <figcaption>
                  <strong>{picture.label}</strong>
                  <span className="nv-muted nv-small">{picture.path !== undefined ? (picture.at !== undefined ? t(`之前画的 · ${new Date(picture.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`, `drawn before · ${new Date(picture.at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`) : took(picture.seconds, t)) : picture.error !== undefined ? t('没画成', 'failed') : t('正在画…', 'drawing…')}</span>
                  {picture.path !== undefined ? (picture.path === taken?.path ? <Chip tone="green">{t('用了这张', 'taken')}</Chip> : <Button size="sm" variant="outline" icon="check" onClick={() => take(picture)}>{t('用这张', 'Take this one')}</Button>) : null}
                </figcaption>
              </figure>
            ))}
          </div>
          <label className="nv-check nv-small">
            <input type="checkbox" checked={dropOthers} onChange={(event) => { setDropOthers(event.target.checked) }} />
            <span>{t('采纳一张时，把这里其余的删掉（不勾：都留着，之后还能改选）', 'When one is taken, delete the others here (unticked: all kept, to choose again later)')}</span>
          </label>
        </>
      ) : null}
    </Modal>
  )
}

/**
 * Beside a button that draws: the same drawing with several image services instead — one picture from each, to
 * compare. The one control for it, wherever a picture is started.
 * @param ask - the drawing, as the button beside it would start it; a function where it is only known when pressed.
 */
export function ManyModels({ ask, disabled, title, label, onChanged }: { ask: DrawAsk | (() => DrawAsk | undefined); disabled?: boolean; title?: string; /** Said on the button; left out, the button is its icon alone. */ label?: string; onChanged?: () => void }) {
  const t = useT()
  const [open, setOpen] = useState<DrawAsk | undefined>()
  const said = title ?? t('多模型：用几个绘图服务各画一张来比', 'Several models: one picture from each image service, to compare')
  return (
    <>
      <Button size="sm" variant="ghost" icon="layers" disabled={disabled === true} title={said} aria-label={said} onClick={() => { const now = typeof ask === 'function' ? ask() : ask; if (now !== undefined) setOpen(now) }}>{label}</Button>
      {open !== undefined ? <ImageTrialDialog of={{ draw: open }} onClose={() => { setOpen(undefined) }} {...(onChanged !== undefined ? { onChanged } : {})} /> : null}
    </>
  )
}

// ───────────────────────────── speech ─────────────────────────────

interface VoiceRow { key: string; label: string; tts: SpeechTrial['tts']; ready: boolean; current: boolean; on: boolean; voice: string }

/**
 * The same words spoken by each of several speech setups, to be listened to side by side.
 * @param of.character - whose line it is to begin with; the narrator's otherwise. `of.text`: the words to begin with.
 */
export function SpeechTrialDialog({ of, onClose, onChanged }: { of: { character?: { id: string; name: string }; text?: string; direction?: string }; onClose: () => void; onChanged?: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const mediaUrl = useMediaUrl()
  const setups = useLoad(signal => controller.api.call('trial.setups', { root }, signal), [root])
  const [rows, setRows] = useState<VoiceRow[] | undefined>()
  useEffect(() => {
    if (setups.data === undefined || rows !== undefined) return
    setRows((setups.data.speech ?? []).map(setup => ({ key: setup.id, label: setup.label, tts: setup.tts, ready: setup.ready, current: setup.current, on: setup.ready, voice: '' })))
  }, [setups.data, rows])
  const [who, setWho] = useState(of.character?.id ?? '')
  const [text, setText] = useState(of.text ?? (of.character !== undefined ? t(`我是${of.character.name}。有些话，我只说一遍。`, `I am ${of.character.name}. Some things I only say once.`) : t('雨下了一夜。天亮的时候，巷子里只剩下一把撑开的伞。', 'It rained all night. By morning there was only an open umbrella left in the lane.')))
  const job = useTrialJob()
  const takes = ((job.live?.result?.takes ?? (job.done?.result?.output as { takes?: TrialTake[] } | undefined)?.takes) as TrialTake[] | undefined) ?? []
  // What was asked for with this round, by place: a take answers the row it was made for.
  const [asked, setAsked] = useState<VoiceRow[]>([])
  const [taken, setTaken] = useState<string | undefined>()
  const chosen = (rows ?? []).filter(row => row.on)
  const edit = (key: string, patch: Partial<VoiceRow>): void => { setRows(previous => previous?.map(row => (row.key === key ? { ...row, ...patch } : row))) }
  const again = (row: VoiceRow): void => { setRows(previous => (previous === undefined ? previous : [...previous.slice(0, previous.indexOf(row) + 1), { ...row, key: `${row.key}+${previous.length}`, current: false, on: true, voice: '' }, ...previous.slice(previous.indexOf(row) + 1)])) }
  const running = job.busy
  const start = (): void => {
    setTaken(undefined)
    setAsked(chosen)
    const trials: SpeechTrial[] = chosen.map(row => ({ label: speechSetupName({ provider: row.tts.provider ?? 'none', ...(row.tts.baseURL !== undefined ? { baseURL: row.tts.baseURL } : {}), ...(row.tts.model !== undefined ? { model: row.tts.model } : {}) }), tts: row.tts, ...(row.voice.trim().length > 0 ? { voice: row.voice.trim() } : {}) }))
    job.start(async () => await controller.api.call('trial.speak', { root, text, ...(who.length > 0 ? { character: who } : {}), ...(of.direction !== undefined ? { direction: of.direction } : {}), with: trials }))
  }
  const take = (at: number, scope: 'book' | 'studio'): Promise<unknown> => controller.guard(async () => {
    const row = asked[at]
    if (row === undefined) return
    const done = await controller.api.call('trial.takeSpeech', { root, tts: row.tts, for: scope, ...(who.length > 0 && row.voice.trim().length > 0 ? { character: who, voice: row.voice.trim() } : {}) })
    setTaken(`${at}:${scope}`)
    await Promise.all([controller.refreshProject(), controller.loadSettings().catch(() => undefined)])
    onChanged?.()
    controller.toast('success', scope === 'book' ? t(`这本书从现在起用 ${done.label} 配音`, `This book is voiced with ${done.label} from now on`) : t(`所有的书从现在起用 ${done.label} 配音；原来那套记着`, `Every book is voiced with ${done.label} from now on; the setup before is remembered`))
  })
  return (
    <Modal wide className="nv-modal-trial" title={t('换几个配音服务念同一句', 'The same line by several speech setups')} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('同一句话、同一个人，各念一遍。只是试听，采纳了才换。', 'The same words by the same speaker, once each. Samples only: nothing changes until you take one.')}</span>
        <span className="nv-spacer" />
        {running ? <Button variant="ghost" onClick={job.stop}>{t('停止', 'Stop')}</Button> : null}
        <Button variant="primary" icon="layers" busy={running} disabled={chosen.length === 0 || text.trim().length === 0} pending={t('正在念…', 'Speaking…')} onClick={start}>{takes.length > 0 ? t(`再念一轮（${chosen.length} 个）`, `Another round (${chosen.length})`) : t(`${chosen.length} 个各念一遍`, `Once each by ${chosen.length}`)}</Button>
      </>
    )}>
      {rows === undefined ? <div className="nv-center">{setups.error !== undefined ? <p className="nv-muted">{setups.error}</p> : <Spinner />}</div> : setups.data?.speech === undefined ? (
        <p className="nv-note is-warn">{t('后台还是旧版本，不会对比配音：在工坊顶上点“重启”。', 'The Host half is an older build that cannot compare speech: press Restart at the top of the Studio.')}</p>
      ) : rows.length === 0 ? (
        <p className="nv-note">{t('还没有可以比的配音服务。到“设置 → 语音合成”配一个；换到别的服务时，原来那个会记着，之后就能在这里一起比。', 'There is no speech setup to compare yet. Set one up under Settings → Speech; when you move to another, the one before is remembered and can be compared here.')}</p>
      ) : (
        <div className="nv-trial-rows">
          {rows.map(row => (
            <div key={row.key} className={cx('nv-trial-row', !row.ready && 'is-off')}>
              <label className="nv-trial-who">
                <input type="checkbox" checked={row.on} disabled={!row.ready || running} onChange={(event) => { edit(row.key, { on: event.target.checked }) }} />
                <span className="nv-trial-name">{row.label.split(' · ')[0]}{row.current ? <Chip tone="blue">{t('现在用的', 'in use')}</Chip> : null}{!row.ready ? <Chip>{t('还不能用：缺密钥', 'not ready: no key')}</Chip> : null}</span>
              </label>
              <div className="nv-trial-model">
                <ModelField bare t={t} kind="speech" endpoint={speechEndpoint({ provider: row.tts.provider ?? 'none', ...(row.tts.baseURL !== undefined ? { baseURL: row.tts.baseURL } : {}) })} value={row.tts.model ?? ''} suggestions={speechSuggestions(row.tts.provider ?? 'none')} refName={row.tts.apiKeyRef} disabled={!row.ready || running}
                  onChange={(model) => { edit(row.key, { tts: { ...row.tts, model } }) }}
                  onPickModel={(model) => { edit(row.key, { tts: withSpeechModel(row.tts, model) }) }} />
              </div>
              <TextInput className="nv-trial-voice" value={row.voice} disabled={!row.ready || running} placeholder={row.tts.provider === 'qwen-audiogen' ? t('音色（留空：照人物卡的描述）', 'Voice (empty: as the card describes it)') : t('音色（留空：它给这个人选的）', 'Voice (empty: the one it casts)')} onChange={(event) => { edit(row.key, { voice: event.target.value }) }} />
              {row.ready ? <button type="button" className="nv-link nv-small" disabled={running} onClick={() => { again(row) }} title={t('同一个服务再加一行，选另一个模型或音色', 'Another row of the same service, for another model or voice')}>{t('＋ 再加一行', '+ another row')}</button> : null}
            </div>
          ))}
        </div>
      )}
      <div className="nv-form-grid">
        <Field label={t('谁来念', 'Who speaks')}>
          <Select value={who} options={[{ value: '', label: t('旁白', 'The narrator') }, ...project.characters.map(card => ({ value: card.id, label: card.name }))]} onChange={setWho} />
        </Field>
      </div>
      <Field label={t('念什么', 'The words')}>
        <TextArea value={text} minRows={2} disabled={running} onChange={(event) => { setText(event.target.value) }} />
      </Field>
      {job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      {takes.length > 0 ? (
        <div className="nv-trial-columns is-takes">
          {takes.map((clip, at) => (
            <TrialColumn key={`${clip.label}:${at}`} title={clip.label} sub={clip.error !== undefined ? t('没念成', 'failed') : clip.path !== undefined ? `${took(clip.seconds, t)}${clip.duration !== undefined ? ` · ${t(`${clip.duration} 秒长`, `${clip.duration}s long`)}` : ''}` : t('正在念…', 'speaking…')} taken={taken?.startsWith(`${at}:`) === true}
              action={clip.path !== undefined ? (asked[at]?.current === true && asked[at]?.voice.trim().length === 0 && taken === undefined ? <Chip tone="blue">{t('现在用的', 'in use')}</Chip> : (
                <span className="nv-row-wrap">
                  {taken === `${at}:book` ? <Chip tone="green">{t('这本书用它了', 'this book\'s now')}</Chip> : <Button size="sm" variant="outline" icon="check" onClick={() => take(at, 'book')}>{t('这本书用它', 'For this book')}</Button>}
                  {taken === `${at}:studio` ? <Chip tone="green">{t('全局用它了', 'every book\'s now')}</Chip> : <Button size="sm" variant="ghost" onClick={() => take(at, 'studio')}>{t('全局用它', 'For every book')}</Button>}
                </span>
              )) : undefined}>
              {clip.error !== undefined ? <p className="nv-trial-failed">{clip.error}</p> : clip.path !== undefined ? (
                <>
                  <audio controls preload="auto" src={mediaUrl(clip.path, clip.seconds)} className="nv-trial-audio" />
                  {clip.voice !== undefined ? <p className="nv-muted nv-small">{t(`音色：${clip.voice}`, `Voice: ${clip.voice}`)}</p> : null}
                </>
              ) : <div className="nv-center"><Spinner /></div>}
            </TrialColumn>
          ))}
        </div>
      ) : null}
    </Modal>
  )
}

// ───────────────────────────── models ─────────────────────────────

const keyOf = (model: Pick<ModelOption, 'provider' | 'id'>): string => `${model.provider}\u0000${model.id}`

/** Several of DSH's models, picked from all it lists. */
function ModelChecklist({ picked, onChange, disabled, hint }: { picked: ReadonlySet<string>; onChange: (next: Set<string>) => void; disabled: boolean; hint?: string | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const settings = useSnapshot(snapshot => snapshot.settings)
  useEffect(() => { if (settings === undefined) void controller.loadSettings().catch(() => {}) }, [controller, settings])
  const [filter, setFilter] = useState('')
  const [reading, setReading] = useState(false)
  const models = settings?.models ?? []
  const wanted = filter.trim().toLowerCase()
  const groups = useMemo(() => {
    const by = new Map<string, { name: string; models: ModelOption[] }>()
    for (const model of models) {
      if (wanted.length > 0 && !`${model.id} ${model.name} ${model.providerName}`.toLowerCase().includes(wanted) && !picked.has(keyOf(model))) continue
      const group = by.get(model.provider) ?? { name: model.providerName, models: [] }
      group.models.push(model)
      by.set(model.provider, group)
    }
    return [...by.entries()]
  }, [models, wanted, picked])
  if (settings === undefined) return <div className="nv-center"><Spinner /></div>
  if (models.length === 0) return <p className="nv-note">{t('DSH 里还没有可用的文字模型：到 DSH 的“设置 → 模型”里接一个。', 'DSH lists no text model yet: connect one under DSH Settings → Models.')}</p>
  return (
    <div className="nv-trial-models">
      <div className="nv-row-wrap">
        <TextInput className="nv-grow" value={filter} placeholder={t('按名字找模型', 'Find a model by name')} onChange={(event) => { setFilter(event.target.value) }} />
        <Button size="sm" variant="ghost" icon="refresh" busy={reading} title={t('重新读取 DSH 的模型', 'Read DSH\'s models again')} onClick={() => { setReading(true); void controller.loadSettings().catch(() => {}).finally(() => { setReading(false) }) }} />
        <span className="nv-muted nv-small">{t(`选了 ${picked.size} 个`, `${picked.size} picked`)}{hint !== undefined ? ` · ${hint}` : ''}</span>
      </div>
      <div className="nv-trial-model-list">
        {groups.map(([provider, group]) => (
          <div key={provider} className="nv-trial-model-group">
            <span className="nv-muted nv-small">{group.name}</span>
            <div className="nv-chips">
              {group.models.map(model => (
                <Chip key={model.id} active={picked.has(keyOf(model))} tone={picked.has(keyOf(model)) ? 'blue' : 'neutral'} title={model.description} onClick={disabled ? undefined : () => { const next = new Set(picked); if (!next.delete(keyOf(model))) next.add(keyOf(model)); onChange(next) }}>{model.name !== model.id && model.name.length > 0 ? model.name : model.id}</Chip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const routesOf = (picked: ReadonlySet<string>): { provider: string; model: string }[] => [...picked].map((key) => { const [provider, model] = key.split('\u0000'); return { provider: provider!, model: model! } })

/** The model a role runs on for the book in hand, as the settings have it — picked to begin with, so a comparison is against what is in use. */
function useRoleModel(role: 'writer' | 'architect'): string | undefined {
  const root = useSnapshot(snapshot => snapshot.root)
  const settings = useSnapshot(snapshot => snapshot.settings)
  const rows = (settings?.book !== undefined && settings.book.root === root ? settings.book.context : undefined) ?? settings?.context
  return rows?.find(row => row.role === role)?.model
}

function usePicked(inUse: string | undefined): [Set<string>, (next: Set<string>) => void] {
  const models = useSnapshot(snapshot => snapshot.settings?.models)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (seeded || models === undefined || inUse === undefined) return
    const mine = models.find(model => model.id === inUse)
    if (mine !== undefined) setPicked(new Set([keyOf(mine)]))
    setSeeded(true)
  }, [seeded, models, inUse])
  return [picked, setPicked]
}

/** One chapter written by several models, side by side; the one taken becomes the chapter (what it had stays among its versions). */
export function WriteTrialDialog({ chapter, brief: given, onClose, onTaken }: { chapter: { id: string; title: string; hasText: boolean }; brief?: string; onClose: () => void; onTaken?: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const inUse = useRoleModel('writer')
  const [picked, setPicked] = usePicked(inUse)
  const [brief, setBrief] = useState(given ?? '')
  const job = useTrialJob()
  const drafts = ((job.live?.result?.drafts ?? (job.done?.result?.output as { drafts?: TrialDraft[] } | undefined)?.drafts) as TrialDraft[] | undefined) ?? []
  // The drafts themselves are read from where they are kept: among the chapter's versions.
  const [texts, setTexts] = useState<Record<string, string>>({})
  useEffect(() => {
    for (const draft of drafts) {
      if (draft.version === undefined || texts[draft.version] !== undefined) continue
      const version = draft.version
      setTexts(previous => ({ ...previous, [version]: '' }))
      void controller.api.call('trial.draft', { root, chapter: chapter.id, version }).then((got) => { setTexts(previous => ({ ...previous, [version]: got.text })) }, () => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts.map(draft => draft.version ?? '').join('|')])
  const [taken, setTaken] = useState<string | undefined>()
  const start = (): void => {
    setTaken(undefined)
    job.start(async () => await controller.api.call('trial.write', { root, chapter: chapter.id, ...(brief.trim().length > 0 ? { brief: brief.trim() } : {}), with: routesOf(picked) }))
  }
  const take = (draft: TrialDraft): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('chapter.restore', { root, id: chapter.id, version: draft.version! })
    setTaken(draft.version)
    await controller.refreshProject()
    onTaken?.()
    controller.toast('success', t(`「${chapter.title}」用了 ${draft.label} 写的这一稿${chapter.hasText ? '；原来的正文在“版本”里' : ''}。其余几稿也在“版本”里。`, `"${chapter.title}" is now the draft by ${draft.label}${chapter.hasText ? '; what it had is among its versions' : ''}. The other drafts are among its versions too.`))
  })
  return (
    <Modal wide className="nv-modal-trial" title={t(`几个模型各写一遍「${chapter.title}」`, `"${chapter.title}" written by several models`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('同样的上下文和要求，各写一稿。正文不动，采纳了才换；每一稿都留在这一章的“版本”里。', 'The same context and brief, one draft each. The chapter keeps its text until you take one; every draft is kept among its versions.')}</span>
        <span className="nv-spacer" />
        {job.busy ? <Button variant="ghost" onClick={job.stop}>{t('停止', 'Stop')}</Button> : null}
        <Button variant="primary" icon="layers" busy={job.busy} disabled={picked.size === 0} pending={t('正在写…', 'Writing…')} onClick={start}>{t(`${picked.size} 个模型各写一稿`, `One draft each by ${picked.size}`)}</Button>
      </>
    )}>
      <ModelChecklist picked={picked} onChange={setPicked} disabled={job.busy} hint={inUse !== undefined ? t(`写手现在用的是 ${inUse}`, `the writer runs on ${inUse}`) : undefined} />
      <Field label={t('给写手的要求（可不填）', 'Brief for the writer (optional)')}>
        <TextArea value={brief} minRows={2} disabled={job.busy} onChange={(event) => { setBrief(event.target.value) }} />
      </Field>
      {job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      {drafts.length > 0 ? (
        <div className="nv-trial-columns">
          {drafts.map((draft, at) => (
            <TrialColumn key={`${draft.provider}:${draft.model}:${at}`} title={draft.label} sub={draft.error !== undefined ? t('没写成', 'failed') : draft.version !== undefined ? `${t(`${draft.words ?? 0} 字`, `${draft.words ?? 0} words`)} · ${took(draft.seconds, t)}` : t('正在写…', 'writing…')} taken={draft.version !== undefined && draft.version === taken}
              action={draft.version !== undefined ? (draft.version === taken ? <Chip tone="green">{t('采纳了', 'taken')}</Chip> : <Button size="sm" variant="outline" icon="check" onClick={() => take(draft)}>{t('采纳这一稿', 'Take this draft')}</Button>) : undefined}>
              {draft.error !== undefined ? <p className="nv-trial-failed">{draft.error}</p> : draft.version !== undefined ? <div className="nv-trial-prose">{(texts[draft.version] ?? '').split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : <div className="nv-center"><Spinner /></div>}
            </TrialColumn>
          ))}
        </div>
      ) : null}
    </Modal>
  )
}

/** One of the things compared: who made it, how it went, and what it is. */
function TrialColumn({ title, sub, action, taken, children }: { title: string; sub: string; action?: ReactNode; taken?: boolean; children: ReactNode }) {
  return (
    <section className={cx('nv-trial-column', taken === true && 'is-taken')}>
      <header>
        <div><strong>{title}</strong><span className="nv-muted nv-small">{sub}</span></div>
        {action}
      </header>
      <div className="nv-trial-body">{children}</div>
    </section>
  )
}

/** What one model would have the chapters to come be. */
export interface TrialPlanView {
  label: string
  provider: string
  model: string
  chapters?: { title: string; synopsis?: string }[]
  rationale?: string
  seconds: number
  error?: string
}

/**
 * The chapters to come planned by several models, side by side.
 * @param onTake - the plan taken, whole as the planner gave it: the page it came from adds it the way it adds any plan (looked at, a chapter left out here and there).
 */
export function DeriveTrialDialog<Plan extends TrialPlanView>({ count, direction, volume, guides, onClose, onTake }: { count: number; direction?: string; volume?: string; /** Pictures each planner is to go by. */ guides?: readonly PictureGuide[]; onClose: () => void; onTake: (plan: Plan) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const inUse = useRoleModel('architect')
  const [picked, setPicked] = usePicked(inUse)
  const job = useTrialJob()
  const plans = ((job.live?.result?.plans ?? (job.done?.result?.output as { plans?: Plan[] } | undefined)?.plans) as Plan[] | undefined) ?? []
  const start = (): void => {
    job.start(async () => await controller.api.call('trial.derive', { root, count, ...(direction !== undefined && direction.trim().length > 0 ? { direction: direction.trim() } : {}), ...(volume !== undefined && volume.length > 0 ? { volume } : {}), ...(guides !== undefined && guides.length > 0 ? { guides: [...guides] } : {}), with: routesOf(picked) }))
  }
  return (
    <Modal wide className="nv-modal-trial" title={t(`几个模型各推演 ${count} 章`, `${count} chapter(s) planned by several models`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('同样的材料和方向，各出一版。只是预览，采纳了才进大纲。', 'The same material and direction, one plan each. Previews only: nothing enters the outline until you take one.')}</span>
        <span className="nv-spacer" />
        {job.busy ? <Button variant="ghost" onClick={job.stop}>{t('停止', 'Stop')}</Button> : null}
        <Button variant="primary" icon="layers" busy={job.busy} disabled={picked.size === 0} pending={t('正在推演…', 'Planning…')} onClick={start}>{t(`${picked.size} 个模型各推一版`, `One plan each by ${picked.size}`)}</Button>
      </>
    )}>
      <ModelChecklist picked={picked} onChange={setPicked} disabled={job.busy} hint={inUse !== undefined ? t(`策划现在用的是 ${inUse}`, `the planner runs on ${inUse}`) : undefined} />
      {direction !== undefined && direction.trim().length > 0 ? <p className="nv-muted nv-small">{t(`方向：${direction.trim()}`, `Direction: ${direction.trim()}`)}</p> : null}
      {guides !== undefined && guides.length > 0 ? <p className="nv-muted nv-small">{t(`带 ${guides.length} 张参考图：能看图的模型自己看，看不了的由“看图的模型”先看成文字`, `With ${guides.length} picture(s): a model that sees looks itself; for one that does not, the picture model puts them into words`)}</p> : null}
      {job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      {plans.length > 0 ? (
        <div className="nv-trial-columns">
          {plans.map((plan, at) => (
            <TrialColumn key={`${plan.provider}:${plan.model}:${at}`} title={plan.label} sub={plan.error !== undefined ? t('没推成', 'failed') : plan.chapters !== undefined ? `${t(`${plan.chapters.length} 章`, `${plan.chapters.length} chapters`)} · ${took(plan.seconds, t)}` : t('正在推演…', 'planning…')}
              action={plan.chapters !== undefined && plan.chapters.length > 0 ? <Button size="sm" variant="outline" icon="check" onClick={() => { onTake(plan); onClose() }}>{t('用这一版', 'Take this plan')}</Button> : undefined}>
              {plan.error !== undefined ? <p className="nv-trial-failed">{plan.error}</p> : plan.chapters !== undefined ? (
                <>
                  <ol className="nv-trial-plan">
                    {plan.chapters.map((item, index) => <li key={index}><strong>{item.title}</strong>{item.synopsis !== undefined ? <span>{item.synopsis}</span> : null}</li>)}
                  </ol>
                  {/* What it is, first; why the planner has it so, for whoever wants to read that. */}
                  {plan.rationale !== undefined ? <details className="nv-trial-why"><summary>{t('它的说明', 'Its reasons')}</summary><p className="nv-muted nv-small">{plan.rationale}</p></details> : null}
                </>
              ) : <div className="nv-center"><Spinner /></div>}
            </TrialColumn>
          ))}
        </div>
      ) : null}
    </Modal>
  )
}

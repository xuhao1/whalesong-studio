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
import { TRIAL_MOST, type IllustrationInfo, type ImageTrial, type JobInfo, type PictureGuide, type SpeechTrial, type TrialDraft, type TrialPicture, type TrialTake } from '../shared/types'
import { imageSetupName, speechSetupName } from '../shared/images'
import { RpcError } from './api'
import { Compare, type CompareItem } from './Compare'
import { ImageModelField, ModelField, speechEndpoint, speechSuggestions, withSpeechModel } from './ModelField'
import { DraftMaterial, useMaterialBy, wayWord, type MaterialBy } from './Material'
import { Button, Chip, cx, Field, Modal, recall, remember, Select, Spinner, TextArea, TextInput, useLoad, useMediaUrl, useProject, useSnapshot, useStudio, useT } from './ui'
import { useVersionColumns, versionWhen } from './Versions'

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

interface Row { key: string; /** The setup it is a row of, by what the setup is: what was kept of it is found again by this. */ of: string; setup: ImageTrial; ready: boolean; current: boolean; on: boolean; model: string; /** A row the author added beside the setup's own, for another model of it: it can be taken away again. */ added?: boolean }

/** A row as it took part in the comparison before this one, kept on this device. */
interface KeptRow { of: string; on: boolean; model?: string; voice?: string; added?: boolean }

/** Rows the author adds are told apart by a number of their own. */
let addedRows = 0

/**
 * The rows of a dialog as they were when it last compared: what took part then takes part now, with the model (and
 * voice) it had; a setup that was not there then is listed, and left out until it is ticked.
 * @param put - a row with what was kept of it filled in.
 */
function rowsAsBefore<R extends { key: string; of: string; ready: boolean; current: boolean; on: boolean; added?: boolean }>(name: string, base: R[], put: (row: R, kept: KeptRow) => R): R[] {
  const kept = (recall<{ rows?: KeptRow[] }>(`trial:${name}`)?.rows ?? []).filter(row => row !== null && typeof row === 'object' && typeof row.of === 'string')
  if (!kept.some(row => base.some(one => one.of === row.of))) return base
  const out: R[] = []
  for (const one of base) {
    const mine = kept.filter(row => row.of === one.of)
    const own = mine.find(row => row.added !== true)
    out.push(own !== undefined ? put({ ...one, on: own.on === true && one.ready }, own) : { ...one, on: false })
    for (const row of mine.filter(row => row.added === true)) out.push(put({ ...one, key: `${one.key}+${addedRows += 1}`, current: false, added: true, on: row.on === true && one.ready }, row))
  }
  return out
}

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
    // Whatever can draw right now takes part unless the author says otherwise — or said otherwise the last time.
    const base: Row[] = setups.data.image.map(setup => ({ key: setup.id, of: `${setup.image.provider ?? ''}|${setup.image.baseURL ?? ''}|${setup.image.model ?? ''}`, setup: { label: setup.label, image: setup.image }, ready: setup.ready, current: setup.current, on: setup.ready, model: setup.image.model ?? '' }))
    setRows(rowsAsBefore('image', base, (row, kept) => ({ ...row, model: typeof kept.model === 'string' && (kept.model.length > 0 || row.added === true) ? kept.model : row.model })))
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
    // What takes part now is what the dialog opens on the next time.
    remember('trial:image', { rows: (rows ?? []).map((row): KeptRow => ({ of: row.of, on: row.on, model: row.model, ...(row.added === true ? { added: true } : {}) })) })
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
  const again = (row: Row): void => { setRows(previous => (previous === undefined ? previous : [...previous.slice(0, previous.indexOf(row) + 1), { ...row, key: `${row.key}+${addedRows += 1}`, current: false, added: true, on: true, model: '' }, ...previous.slice(previous.indexOf(row) + 1)])) }
  const leave = (key: string): void => { setRows(previous => previous?.filter(row => row.key !== key)) }
  // A picture nobody wants, deleted where it is looked at.
  const drop = (path: string): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('image.delete', { root, paths: [path] })
    setGone(previous => new Set([...previous, path]))
    await controller.refreshProject()
    onChanged?.()
  })
  const running = job.busy
  const title = draw !== undefined ? t(`用几个绘图服务画：${draw.title}`, `By several image services: ${draw.title}`) : of.picture !== undefined ? t('换几个绘图服务画同一张', 'The same picture by several image services') : t(`用几个绘图服务画「${of.character?.name ?? ''}」的立绘`, `A portrait of ${of.character?.name ?? ''} by several image services`)
  // Over — now, or while the dialog was closed: what its round still has to be taken says so.
  const finished = many && !running && ((job.done !== undefined && job.done.status === 'done') || roundWaits.length > 0)
  return (
    <Modal wide roomy="compare" className="nv-modal-trial" title={title} onClose={onClose} footer={(
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
              {row.added === true ? <Button size="sm" variant="ghost" icon="x" disabled={running} title={t('去掉这一行', 'Take this row away')} aria-label={t('去掉这一行', 'Take this row away')} onClick={() => { leave(row.key) }} /> : null}
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
          <Compare name="pictures" base={260} items={pictures.filter(picture => picture.path === undefined || !gone.has(picture.path)).map((picture, at): CompareItem => ({
            key: picture.path ?? `${picture.label}:${at}`,
            title: picture.label,
            sub: picture.path !== undefined ? (picture.at !== undefined ? t(`之前画的 · ${versionWhen({ createdAt: picture.at })}`, `drawn before · ${versionWhen({ createdAt: picture.at })}`) : took(picture.seconds, t)) : picture.error !== undefined ? t('没画成', 'failed') : t('正在画…', 'drawing…'),
            ...(picture.path !== undefined ? { picture: picture.path } : picture.error !== undefined ? { error: picture.error } : { loading: true }),
            taken: picture.path !== undefined && picture.path === taken?.path,
            ...(picture.path !== undefined ? { action: picture.path === taken?.path ? <Chip tone="green">{t('用了这张', 'taken')}</Chip> : <Button size="sm" variant="outline" icon="check" onClick={() => take(picture)}>{t('用这张', 'Take this one')}</Button> } : {}),
            ...(picture.path !== undefined && picture.path !== taken?.path ? { drop: { ask: t(`删掉「${picture.label}」画的这张对比图？图片文件一起删掉，找不回来。`, `Delete this picture by ${picture.label}? The file goes too; it cannot be brought back.`), run: () => { void drop(picture.path!) } } } : {}),
          }))} />
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

interface VoiceRow { key: string; of: string; label: string; tts: SpeechTrial['tts']; ready: boolean; current: boolean; on: boolean; voice: string; added?: boolean }

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
    const base: VoiceRow[] = (setups.data.speech ?? []).map(setup => ({ key: setup.id, of: `${setup.tts.provider ?? ''}|${setup.tts.baseURL ?? ''}|${setup.tts.model ?? ''}`, label: setup.label, tts: setup.tts, ready: setup.ready, current: setup.current, on: setup.ready, voice: '' }))
    // As they were the last time lines were compared: the models and voices tried then.
    setRows(rowsAsBefore('speech', base, (row, kept) => ({ ...row, voice: typeof kept.voice === 'string' ? kept.voice : '', tts: typeof kept.model === 'string' && kept.model.length > 0 && kept.model !== row.tts.model ? withSpeechModel(row.tts, { id: kept.model }) : row.tts })))
  }, [setups.data, rows])
  const [who, setWho] = useState(of.character?.id ?? '')
  const [text, setText] = useState(of.text ?? (of.character !== undefined ? t(`我是${of.character.name}。有些话，我只说一遍。`, `I am ${of.character.name}. Some things I only say once.`) : t('雨下了一夜。天亮的时候，巷子里只剩下一把撑开的伞。', 'It rained all night. By morning there was only an open umbrella left in the lane.')))
  const job = useTrialJob()
  const takes = ((job.live?.result?.takes ?? (job.done?.result?.output as { takes?: TrialTake[] } | undefined)?.takes) as TrialTake[] | undefined) ?? []
  // What was asked for with this round, by place: a take answers the row it was made for.
  const [asked, setAsked] = useState<VoiceRow[]>([])
  const [taken, setTaken] = useState<string | undefined>()
  // A model typed into a row, not picked from its list, is spoken to the way that model is all the same: the protocol follows the model.
  const chosen = (rows ?? []).filter(row => row.on).map(row => (row.tts.model !== undefined && row.tts.model.trim().length > 0 ? { ...row, tts: withSpeechModel(row.tts, { id: row.tts.model.trim() }) } : row))
  const edit = (key: string, patch: Partial<VoiceRow>): void => { setRows(previous => previous?.map(row => (row.key === key ? { ...row, ...patch } : row))) }
  const again = (row: VoiceRow): void => { setRows(previous => (previous === undefined ? previous : [...previous.slice(0, previous.indexOf(row) + 1), { ...row, key: `${row.key}+${addedRows += 1}`, current: false, added: true, on: true, voice: '' }, ...previous.slice(previous.indexOf(row) + 1)])) }
  const leave = (key: string): void => { setRows(previous => previous?.filter(row => row.key !== key)) }
  const running = job.busy
  const start = (): void => {
    setTaken(undefined)
    setAsked(chosen)
    remember('trial:speech', { rows: (rows ?? []).map((row): KeptRow => ({ of: row.of, on: row.on, ...(row.tts.model !== undefined ? { model: row.tts.model } : {}), voice: row.voice, ...(row.added === true ? { added: true } : {}) })) })
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
    <Modal wide roomy="compare" className="nv-modal-trial" title={t('换几个配音服务念同一句', 'The same line by several speech setups')} onClose={onClose} footer={(
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
              {row.added === true ? <Button size="sm" variant="ghost" icon="x" disabled={running} title={t('去掉这一行', 'Take this row away')} aria-label={t('去掉这一行', 'Take this row away')} onClick={() => { leave(row.key) }} /> : null}
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
      <Compare name="clips" base={300} items={takes.map((clip, at): CompareItem => ({
        key: `${clip.label}:${at}`,
        title: clip.label,
        sub: clip.error !== undefined ? t('没念成', 'failed') : clip.path !== undefined ? `${took(clip.seconds, t)}${clip.duration !== undefined ? ` · ${t(`${clip.duration} 秒长`, `${clip.duration}s long`)}` : ''}` : t('正在念…', 'speaking…'),
        taken: taken?.startsWith(`${at}:`) === true,
        ...(clip.error !== undefined ? { error: clip.error } : clip.path === undefined ? { loading: true } : {
          body: (
            <>
              <audio controls preload="auto" src={mediaUrl(clip.path, clip.seconds)} className="nv-trial-audio" />
              {clip.voice !== undefined ? <p className="nv-muted nv-small">{t(`音色：${clip.voice}`, `Voice: ${clip.voice}`)}</p> : null}
            </>
          ),
          action: asked[at]?.current === true && asked[at]?.voice.trim().length === 0 && taken === undefined ? <Chip tone="blue">{t('现在用的', 'in use')}</Chip> : (
            <span className="nv-row-wrap">
              {taken === `${at}:book` ? <Chip tone="green">{t('这本书用它了', 'this book\'s now')}</Chip> : <Button size="sm" variant="outline" icon="check" onClick={() => take(at, 'book')}>{t('这本书用它', 'For this book')}</Button>}
              {taken === `${at}:studio` ? <Chip tone="green">{t('全局用它了', 'every book\'s now')}</Chip> : <Button size="sm" variant="ghost" onClick={() => take(at, 'studio')}>{t('全局用它', 'For every book')}</Button>}
            </span>
          ),
        }),
      }))} />
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

/**
 * How hard each picked model is to think: the reasoning levels it runs at, one run a level. A model nothing is said
 * of runs once, as it does by default (`''`); one given two levels is compared with itself.
 */
type Levels = Readonly<Record<string, readonly string[]>>

const levelsOf = (levels: Levels, key: string): readonly string[] => { const mine = levels[key]; return mine !== undefined && mine.length > 0 ? mine : [''] }

/** One route a run: each picked model at each of its levels. The level is always said — the empty one is "as the model has it by default". */
const routesOf = (picked: ReadonlySet<string>, levels: Levels = {}): { provider: string; model: string; reasoningEffort: string }[] => [...picked].flatMap((key) => {
  const [provider, model] = key.split('\u0000')
  return levelsOf(levels, key).map(level => ({ provider: provider!, model: model!, reasoningEffort: level }))
})

/** The most runs one comparison takes (the Host's own limit). */
const MOST_RUNS = TRIAL_MOST

/** The model a role runs on for the book in hand, and how hard it is set to think, as the settings have it — picked to begin with, so a comparison is against what is in use. */
function useRoleModel(role: 'writer' | 'architect'): { model: string; provider?: string; effort?: string } | undefined {
  const root = useSnapshot(snapshot => snapshot.root)
  const settings = useSnapshot(snapshot => snapshot.settings)
  const rows = (settings?.book !== undefined && settings.book.root === root ? settings.book.context : undefined) ?? settings?.context
  const row = rows?.find(one => one.role === role)
  return row?.model !== undefined ? { model: row.model, ...(row.provider !== undefined ? { provider: row.provider } : {}), ...(row.effort !== undefined ? { effort: row.effort } : {}) } : undefined
}

/**
 * The models picked for a comparison, and the levels each runs at. A dialog opens on what it compared the last time
 * (kept on this device under `name`, as far as DSH still lists those models); where it never compared, on the model in
 * use. `keep`: what is picked now is what it opens on next — called when a comparison is started.
 */
function usePicked(inUse: { model: string; provider?: string; effort?: string } | undefined, name: string): { picked: Set<string>; setPicked: (next: Set<string>) => void; levels: Levels; setLevels: (next: Levels) => void; keep: () => void } {
  const models = useSnapshot(snapshot => snapshot.settings?.models)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [levels, setLevels] = useState<Levels>({})
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (seeded || models === undefined) return
    const kept = recall<{ picked?: string[]; levels?: Record<string, string[]> }>(`trial:${name}`)
    const before = (Array.isArray(kept?.picked) ? kept.picked : []).filter(key => typeof key === 'string' && models.some(model => keyOf(model) === key))
    if (before.length > 0) {
      setPicked(new Set(before))
      setLevels(Object.fromEntries(before.flatMap((key) => {
        const had = kept?.levels?.[key]
        return Array.isArray(had) && had.length > 0 ? [[key, had.filter(level => typeof level === 'string')]] : []
      })))
      setSeeded(true)
      return
    }
    if (inUse === undefined) return
    const mine = models.find(model => model.id === inUse.model && model.provider === inUse.provider) ?? models.find(model => model.id === inUse.model)
    if (mine !== undefined) {
      setPicked(new Set([keyOf(mine)]))
      // The one in use begins at the level it is in use at.
      if (inUse.effort !== undefined) setLevels({ [keyOf(mine)]: [inUse.effort] })
    }
    setSeeded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeded, models, inUse?.model, inUse?.provider, inUse?.effort])
  const keep = (): void => { remember(`trial:${name}`, { picked: [...picked], levels: Object.fromEntries([...picked].flatMap(key => (levels[key] !== undefined && levels[key].length > 0 ? [[key, levels[key]]] : []))) }) }
  return { picked, setPicked, levels, setLevels, keep }
}

/** The picked models, a row a model: how hard each is to think — chosen as the settings choose it, from what the model itself offers — and the way to leave the model out again. */
function EffortRows({ picked, levels, onChange, onLeave, disabled }: { picked: ReadonlySet<string>; levels: Levels; onChange: (next: Levels) => void; onLeave: (key: string) => void; disabled: boolean }) {
  const t = useT()
  const models = useSnapshot(snapshot => snapshot.settings?.models) ?? []
  const rows = [...picked].map(key => models.find(model => keyOf(model) === key)).filter((model): model is ModelOption => model !== undefined)
  if (rows.length === 0) return null
  return (
    <div className="nv-trial-efforts">
      <span className="nv-muted nv-small">{t(`参加对比的 ${rows.length} 个模型 · 思考强度`, `The ${rows.length} model(s) compared · reasoning effort`)}</span>
      {rows.map(model => <EffortRow key={keyOf(model)} model={model} levels={levelsOf(levels, keyOf(model))} disabled={disabled} onChange={(mine) => { onChange({ ...levels, [keyOf(model)]: mine }) }} onLeave={() => { onLeave(keyOf(model)) }} />)}
    </div>
  )
}

function EffortRow({ model, levels, onChange, onLeave, disabled }: { model: ModelOption; levels: readonly string[]; onChange: (next: string[]) => void; onLeave: () => void; disabled: boolean }) {
  const { controller } = useStudio()
  const t = useT()
  const details = useLoad(async signal => await controller.api.call('model.info', { provider: model.provider, model: model.id }, signal), [model.provider, model.id])
  const efforts = details.data?.efforts ?? []
  const byDefault = efforts.find(effort => effort.id === details.data?.defaultEffort)?.name
  const options = [
    { value: '', label: byDefault !== undefined ? t(`模型默认（${byDefault}）`, `Model default (${byDefault})`) : t('模型默认', 'Model default') },
    ...efforts.map(effort => ({ value: effort.id, label: effort.name })),
    // A level the role is set to that the model does not list (any more): shown as it is, not silently dropped.
    ...levels.filter(level => level !== '' && !efforts.some(effort => effort.id === level)).map(level => ({ value: level, label: level })),
  ]
  const free = options.find(option => !levels.includes(option.value))
  return (
    <div className="nv-trial-effort">
      <span className="nv-trial-effort-name" title={model.providerName}>{model.name !== model.id && model.name.length > 0 ? model.name : model.id}</span>
      {details.data === undefined ? <span className="nv-muted nv-small">{details.error !== undefined ? t('没读到它的思考档位：按模型默认', 'Its reasoning levels could not be read: the model\'s default') : t('读取中…', 'reading…')}</span> : efforts.length === 0 && levels.every(level => level === '') ? <span className="nv-muted nv-small">{t('这个模型没有可选的思考档位', 'This model offers no reasoning levels')}</span> : (
        <>
          {levels.map((level, at) => (
            <span key={at} className="nv-trial-effort-pick">
              <Select value={level} disabled={disabled} options={options.map(option => ({ ...option, disabled: option.value !== level && levels.includes(option.value) }))} onChange={(value) => { onChange(levels.map((old, index) => (index === at ? value : old))) }} />
              {levels.length > 1 ? <button type="button" className="nv-link nv-small" disabled={disabled} title={t('不比这一档', 'Leave this level out')} onClick={() => { onChange(levels.filter((_old, index) => index !== at)) }}>×</button> : null}
            </span>
          ))}
          {free !== undefined ? <button type="button" className="nv-link nv-small" disabled={disabled} title={t('同一个模型再跑一遍，用另一档思考强度', 'The same model once more, at another reasoning level')} onClick={() => { onChange([...levels, free.value]) }}>{t('＋ 再比一档', '+ another level')}</button> : null}
        </>
      )}
      <span className="nv-spacer" />
      <Button size="sm" variant="ghost" icon="x" disabled={disabled} title={t('不比这个模型', 'Leave this model out')} aria-label={t('不比这个模型', 'Leave this model out')} onClick={onLeave} />
    </div>
  )
}

/** Who takes part, folded away once there is something to read: the more room for what they made. */
function Setup({ open, onOpen, summary, children }: { open: boolean; onOpen: (open: boolean) => void; summary: string; children: ReactNode }) {
  return (
    <details className="nv-trial-setup" open={open} onToggle={(event) => { const now = (event.currentTarget as HTMLDetailsElement).open; if (now !== open) onOpen(now) }}>
      <summary>{summary}</summary>
      <div className="nv-trial-setup-body">{children}</div>
    </details>
  )
}

const draftsOf = (info: JobInfo | undefined): TrialDraft[] => ((info?.result?.drafts ?? (info?.result?.output as { drafts?: TrialDraft[] } | undefined)?.drafts) as TrialDraft[] | undefined) ?? []

/**
 * One chapter written by several models, side by side; the one taken becomes the chapter (what it had stays among its
 * versions). Every draft is one of the chapter's versions, so anything else among them — the drafts of an earlier
 * comparison, the chapter as it was — and the chapter as it stands can be laid beside the ones just written.
 */
export function WriteTrialDialog({ chapter, brief: given, current, onClose, onTaken }: { chapter: { id: string; title: string; hasText: boolean }; brief?: string; /** The chapter's text as it stands, to be laid beside the drafts where the author wants it there. */ current?: string | undefined; onClose: () => void; onTaken?: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const inUse = useRoleModel('writer')
  const { picked, setPicked, levels, setLevels, keep } = usePicked(inUse, 'write')
  const routes = routesOf(picked, levels)
  // How the writer's material is put together: the way in force to begin with (or the ways of the last comparison); with both, every model writes a draft by each.
  const [inForce] = useMaterialBy()
  const [chosen, setChosen] = useState<MaterialBy[] | undefined>(() => {
    const kept = recall<string[]>('trial:write:ways')
    const had = (Array.isArray(kept) ? kept : []).filter((way): way is MaterialBy => way === 'planner' || way === 'rules' || way === 'agent')
    return had.length > 0 ? [...new Set(had)] : undefined
  })
  const ways: MaterialBy[] = chosen ?? [inForce]
  const toggleWay = (way: MaterialBy): void => {
    const next = ways.includes(way) ? ways.filter(one => one !== way) : (['planner', 'rules', 'agent'] as const).filter(one => one === way || ways.includes(one))
    // (One way at the least: a draft is written by some way.)
    if (next.length > 0) setChosen(next)
  }
  const runsCount = routes.length * ways.length
  const [brief, setBrief] = useState(given ?? '')
  const job = useTrialJob(`write:${chapter.id}`, (ended) => {
    // Closed before it was over: the drafts are among the chapter's versions all the same, and the author is told.
    const written = ended.infos.flatMap(draftsOf).filter(draft => draft.version !== undefined).length
    if (ended.error !== undefined) controller.toast('error', t(`对比稿没写成：${ended.error}`, `The drafts to compare were not written: ${ended.error}`))
    else controller.toast('success', t(`「${chapter.title}」的对比稿写好了${written > 0 ? ` ${written} 份` : ''}：都在这一章的“版本”里；再点“对比…”就能并排看`, `The drafts of "${chapter.title}" are written${written > 0 ? ` (${written})` : ''}: all among its versions; open Compare again to read them side by side`))
  })
  const drafts = draftsOf(job.live)
  const fresh = drafts.flatMap(draft => (draft.version !== undefined ? [draft.version] : []))
  // The chapter's versions: what else there is to lay beside the drafts. (A Host from before it could list them alone lists none.)
  const kept = useLoad(signal => controller.api.call('chapter.versions', { root, id: chapter.id }, signal).catch(() => ({ versions: [] })), [root, chapter.id, fresh.join('|')])
  const versions = kept.data?.versions ?? []
  const [extra, setExtra] = useState<string[]>([])
  const columns = useVersionColumns({ chapter, versions, keys: extra.filter(key => !fresh.includes(key)), current, apart: fresh, onAdd: (key) => { setExtra(previous => (previous.includes(key) ? previous : [...previous, key])) }, onChanged: () => { kept.reload(); onTaken?.() } })
  // Drafts written to be compared before this dialog was opened: the latest round of them is a press away.
  const earlier = versions.filter(version => (version.made?.how === 'trial' || version.reason.startsWith('trial-')) && !fresh.includes(version.id) && !columns.gone.has(version.id))
  const lastRound = earlier.length === 0 ? [] : earlier.filter(version => (earlier[0]!.made?.round !== undefined ? version.made?.round === earlier[0]!.made.round : version.id === earlier[0]!.id))
  const [setup, setSetup] = useState(true)
  const start = (): void => {
    keep()
    remember('trial:write:ways', ways)
    setSetup(false)
    job.start(async () => await controller.api.call('trial.write', { root, chapter: chapter.id, ...(brief.trim().length > 0 ? { brief: brief.trim() } : {}), with: routes, materials: ways }))
  }
  // Two drafts of one model are told apart by what each was written from: said in the name where the ways differ.
  const wayOf = (draft: TrialDraft): MaterialBy | undefined => draft.material?.by ?? draft.by
  const mixed = new Set(drafts.map(wayOf)).size > 1
  const items: CompareItem[] = [
    ...drafts.flatMap((draft, at): CompareItem[] => {
      if (draft.version !== undefined && columns.gone.has(draft.version)) return []
      const version = draft.version
      const read = version !== undefined ? columns.textOf(version) : undefined
      return [{
        key: version ?? `${draft.provider}:${draft.model}:${draft.by ?? ''}:${at}`,
        title: mixed && wayOf(draft) !== undefined ? `${draft.label} · ${wayWord(wayOf(draft)!, t)}` : draft.label,
        sub: draft.error !== undefined ? t('没写成', 'failed') : version !== undefined ? `${t(`${draft.words ?? 0} 字`, `${draft.words ?? 0} words`)} · ${took(draft.seconds, t)}` : draft.by === 'planner' ? t('策划在备料，然后写…', 'the planner prepares, then it is written…') : draft.by === 'agent' ? t('写手在读书、动笔、改…', 'the writer reads, writes and goes over it…') : t('正在写…', 'writing…'),
        ...(draft.material !== undefined ? { note: <DraftMaterial chapter={chapter.id} version={version} material={draft.material} /> } : {}),
        ...(draft.error !== undefined ? { error: draft.error } : version === undefined || read === undefined ? { loading: true } : read.error !== undefined ? { error: read.error } : { text: read.text ?? '' }),
        taken: version !== undefined && version === columns.taken,
        ...(version !== undefined ? {
          action: version === columns.taken ? <Chip tone="green">{t('采纳了', 'taken')}</Chip> : <Button size="sm" variant="outline" icon="check" onClick={() => columns.take(version, t(`${draft.label} 写的这一稿`, `the draft by ${draft.label}`))}>{t('采纳这一稿', 'Take this draft')}</Button>,
          drop: { ask: t(`删掉 ${draft.label} 写的这一稿？它在“版本”里的那一份一起删掉，找不回来。`, `Delete the draft by ${draft.label}? Its copy among the versions goes too; it cannot be brought back.`), run: () => { void columns.drop([version]) } },
        } : {}),
      }]
    }),
    ...columns.items,
  ]
  const runs = runsCount === picked.size ? t(`${picked.size} 个模型各写一稿`, `One draft each by ${picked.size}`) : t(`${picked.size} 个模型写 ${runsCount} 稿`, `${runsCount} drafts by ${picked.size} model(s)`)
  return (
    <Modal wide roomy="compare" className="nv-modal-trial" title={t(`几个模型各写一遍「${chapter.title}」`, `"${chapter.title}" written by several models`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('同样的要求，各写一稿。正文不动，采纳了才换；每一稿都留在这一章的“版本”里，写着是哪个模型写的、拿到的是什么材料。可以关掉，之后再看。', 'The same brief, one draft each. The chapter keeps its text until you take one; every draft is kept among its versions, with the model that wrote it and what it was written from. This can be closed and read later.')}</span>
        <span className="nv-spacer" />
        {job.busy ? <Button variant="ghost" onClick={job.stop}>{t('停止', 'Stop')}</Button> : null}
        <Button variant="primary" icon="layers" busy={job.busy} disabled={runsCount === 0 || runsCount > MOST_RUNS} title={runsCount > MOST_RUNS ? t(`一次最多比 ${MOST_RUNS} 稿`, `At most ${MOST_RUNS} drafts at once`) : undefined} pending={t('正在写…', 'Writing…')} onClick={start}>{runs}</Button>
      </>
    )}>
      <Setup open={setup} onOpen={setSetup} summary={t(`参加对比的模型、材料和要求 · 选了 ${picked.size} 个模型，${runsCount} 稿`, `Who takes part, from what, and the brief · ${picked.size} model(s), ${runsCount} draft(s)`)}>
        <ModelChecklist picked={picked} onChange={setPicked} disabled={job.busy} hint={inUse !== undefined ? t(`写手现在用的是 ${inUse.model}`, `the writer runs on ${inUse.model}`) : undefined} />
        <EffortRows picked={picked} levels={levels} onChange={setLevels} onLeave={(key) => { const next = new Set(picked); next.delete(key); setPicked(next) }} disabled={job.busy} />
        <div className="nv-row-wrap nv-trial-ways">
          <span className="nv-muted nv-small">{t('交给写手的材料', 'The writer\'s material')}</span>
          <Chip active={ways.includes('planner')} tone={ways.includes('planner') ? 'blue' : 'neutral'} title={t('策划先看这一章要什么，读书、挑材料，再交给写手', 'The planner looks at what the chapter needs, reads in the book, chooses — then the writer writes')} onClick={job.busy ? undefined : () => { toggleWay('planner') }}>{t('策划先备料', 'Prepared by the planner')}{inForce === 'planner' ? t('（现在用的）', ' (in force)') : ''}</Chip>
          <Chip active={ways.includes('rules')} tone={ways.includes('rules') ? 'blue' : 'neutral'} title={t('原来的做法：前文原文装到窗口的一半，人物、设定、线索按规则带上', 'As it was: the story so far word for word up to half the window, with cards, the world and threads by rule')} onClick={job.busy ? undefined : () => { toggleWay('rules') }}>{t('工坊按规则拼', 'Packed by the Studio\'s rules')}{inForce === 'rules' ? t('（现在用的）', ' (in force)') : ''}</Chip>
          <Chip active={ways.includes('agent')} tone={ways.includes('agent') ? 'blue' : 'neutral'} title={t('没有人备料：写手作为 agent 自己读书，用工具把正文交上来，再看、再改，改到满意才交稿（要写手的模型能当 agent）', 'Nobody prepares anything: the writer reads in the book as an agent, hands the text in with a tool, reads it over and changes it until it is satisfied (its model has to be one that can run as an agent)')} onClick={job.busy ? undefined : () => { toggleWay('agent') }}>{t('写手自己读、自己写', 'The writer as an agent')}{inForce === 'agent' ? t('（现在用的）', ' (in force)') : ''}</Chip>
          {ways.length > 1 ? <span className="nv-muted nv-small">{t(`勾了 ${ways.length} 种：每个模型各写 ${ways.length} 稿`, `${ways.length} ways: ${ways.length} drafts a model`)}</span> : null}
        </div>
        <Field label={t('给写手的要求（可不填）', 'Brief for the writer (optional)')}>
          <TextArea value={brief} minRows={2} disabled={job.busy} onChange={(event) => { setBrief(event.target.value) }} />
        </Field>
      </Setup>
      {job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      {lastRound.length > 0 && !lastRound.every(version => extra.includes(version.id)) ? (
        <p className="nv-muted nv-small">
          {t(`这一章已有 ${earlier.length} 份对比稿。`, `This chapter has ${earlier.length} draft(s) written to compare. `)}
          <button type="button" className="nv-link" onClick={() => { setExtra(previous => [...previous, ...lastRound.map(version => version.id).filter(id => !previous.includes(id))]) }}>{t(`并排看上一轮的 ${lastRound.length} 份（${versionWhen(lastRound[0]!)}）`, `Lay out the last round's ${lastRound.length} (${versionWhen(lastRound[0]!)})`)}</button>
        </p>
      ) : null}
      <Compare name="drafts" items={items} more={columns.more} />
    </Modal>
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
  const { picked, setPicked, levels, setLevels, keep } = usePicked(inUse, 'derive')
  const routes = routesOf(picked, levels)
  const job = useTrialJob()
  const plans = ((job.live?.result?.plans ?? (job.done?.result?.output as { plans?: Plan[] } | undefined)?.plans) as Plan[] | undefined) ?? []
  const [setup, setSetup] = useState(true)
  const start = (): void => {
    keep()
    setSetup(false)
    job.start(async () => await controller.api.call('trial.derive', { root, count, ...(direction !== undefined && direction.trim().length > 0 ? { direction: direction.trim() } : {}), ...(volume !== undefined && volume.length > 0 ? { volume } : {}), ...(guides !== undefined && guides.length > 0 ? { guides: [...guides] } : {}), with: routes }))
  }
  return (
    <Modal wide roomy="compare" className="nv-modal-trial" title={t(`几个模型各推演 ${count} 章`, `${count} chapter(s) planned by several models`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('同样的材料和方向，各出一版。只是预览，采纳了才进大纲。', 'The same material and direction, one plan each. Previews only: nothing enters the outline until you take one.')}</span>
        <span className="nv-spacer" />
        {job.busy ? <Button variant="ghost" onClick={job.stop}>{t('停止', 'Stop')}</Button> : null}
        <Button variant="primary" icon="layers" busy={job.busy} disabled={routes.length === 0 || routes.length > MOST_RUNS} title={routes.length > MOST_RUNS ? t(`一次最多比 ${MOST_RUNS} 版`, `At most ${MOST_RUNS} plans at once`) : undefined} pending={t('正在推演…', 'Planning…')} onClick={start}>{routes.length === picked.size ? t(`${picked.size} 个模型各推一版`, `One plan each by ${picked.size}`) : t(`${picked.size} 个模型推 ${routes.length} 版`, `${routes.length} plans by ${picked.size} model(s)`)}</Button>
      </>
    )}>
      <Setup open={setup} onOpen={setSetup} summary={t(`参加对比的模型 · 选了 ${picked.size} 个模型，${routes.length} 版`, `Who takes part · ${picked.size} model(s), ${routes.length} plan(s)`)}>
        <ModelChecklist picked={picked} onChange={setPicked} disabled={job.busy} hint={inUse !== undefined ? t(`策划现在用的是 ${inUse.model}`, `the planner runs on ${inUse.model}`) : undefined} />
        <EffortRows picked={picked} levels={levels} onChange={setLevels} onLeave={(key) => { const next = new Set(picked); next.delete(key); setPicked(next) }} disabled={job.busy} />
        {direction !== undefined && direction.trim().length > 0 ? <p className="nv-muted nv-small">{t(`方向：${direction.trim()}`, `Direction: ${direction.trim()}`)}</p> : null}
        {guides !== undefined && guides.length > 0 ? <p className="nv-muted nv-small">{t(`带 ${guides.length} 张参考图：能看图的模型自己看，看不了的由“看图的模型”先看成文字`, `With ${guides.length} picture(s): a model that sees looks itself; for one that does not, the picture model puts them into words`)}</p> : null}
      </Setup>
      {job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      <Compare name="plans" items={plans.map((plan, at): CompareItem => ({
        key: `${plan.provider}:${plan.model}:${at}`,
        title: plan.label,
        sub: plan.error !== undefined ? t('没推成', 'failed') : plan.chapters !== undefined ? `${t(`${plan.chapters.length} 章`, `${plan.chapters.length} chapters`)} · ${took(plan.seconds, t)}` : t('正在推演…', 'planning…'),
        ...(plan.error !== undefined ? { error: plan.error } : plan.chapters === undefined ? { loading: true } : {
          body: (
            <>
              <ol className="nv-trial-plan">
                {plan.chapters.map((item, index) => <li key={index}><strong>{item.title}</strong>{item.synopsis !== undefined ? <span>{item.synopsis}</span> : null}</li>)}
              </ol>
              {/* What it is, first; why the planner has it so, for whoever wants to read that. */}
              {plan.rationale !== undefined ? <details className="nv-trial-why"><summary>{t('它的说明', 'Its reasons')}</summary><p className="nv-muted nv-small">{plan.rationale}</p></details> : null}
            </>
          ),
          ...(plan.chapters.length > 0 ? { action: <Button size="sm" variant="outline" icon="check" onClick={() => { onTake(plan); onClose() }}>{t('用这一版', 'Take this plan')}</Button> } : {}),
        }),
      }))} />
    </Modal>
  )
}

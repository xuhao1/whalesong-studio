// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Comparing services and models: the same piece of work done by several at
 * once, and what each made of it side by side.
 *
 * One way of asking for all of it — pick who takes part, press, read the
 * results as they come, take one or none — whether what is compared is a
 * picture (image services), a chapter (the writer's model) or chapters to come
 * (the planner's). Nothing a comparison makes takes the place of anything
 * until the author takes it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ModelOption } from '../shared/rpc'
import type { ImageTrial, JobInfo, TrialDraft, TrialPicture } from '../shared/types'
import { imageSetupName } from '../shared/images'
import { RpcError } from './api'
import { Button, Chip, cx, Field, Modal, ProjectImage, Spinner, TextArea, TextInput, useLoad, useProject, useSnapshot, useStudio, useT } from './ui'

/** A job started here and watched until it is over: what it has said so far, and how it ended. */
function useTrialJob(): { start: (begin: () => Promise<{ jobId: string }>) => void; live: JobInfo | undefined; done: JobInfo | undefined; busy: boolean; error: string | undefined; stop: () => void } {
  const { controller } = useStudio()
  const [jobId, setJobId] = useState<string | undefined>()
  const [done, setDone] = useState<JobInfo | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const live = useSnapshot(snapshot => (jobId !== undefined ? snapshot.jobs.find(job => job.id === jobId) : undefined))
  const start = (begin: () => Promise<{ jobId: string }>): void => {
    setBusy(true)
    setDone(undefined)
    setError(undefined)
    void (async () => {
      try {
        const started = await begin()
        setJobId(started.jobId)
        void controller.refreshJobs()
        const info = await controller.follow(started.jobId).done
        setDone(info)
        if (info.status === 'failed') setError(info.error ?? 'failed')
      } catch (reason) {
        setError(reason instanceof RpcError || reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
        void controller.refreshJobs()
      }
    })()
  }
  return { start, live: done ?? live, done, busy, error, stop: () => { if (jobId !== undefined) void controller.api.call('jobs.cancel', { id: jobId }).catch(() => {}) } }
}

const took = (seconds: number, t: (zh: string, en: string) => string): string => (seconds > 0 ? t(`${seconds} 秒`, `${seconds}s`) : '')

// ───────────────────────────── pictures ─────────────────────────────

interface Row { key: string; setup: ImageTrial; ready: boolean; current: boolean; on: boolean; model: string }

/**
 * A picture drawn once with each of several image services.
 * @param of.picture - a picture there is: it is drawn again as it is, by each service. Else `of.character`: a portrait
 *   of theirs is drawn by each (`params`: which moment, plain or not, what was asked of it).
 */
export function ImageTrialDialog({ of, params, onClose, onChanged }: { of: { character?: { id: string; name: string }; picture?: { path: string; kind: string } }; params?: Record<string, unknown>; onClose: () => void; onChanged?: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const setups = useLoad(signal => controller.api.call('trial.setups', { root }, signal), [root])
  const [rows, setRows] = useState<Row[] | undefined>()
  useEffect(() => {
    if (setups.data === undefined || rows !== undefined) return
    // Whatever can draw right now takes part unless the author says otherwise.
    setRows(setups.data.image.map(setup => ({ key: setup.id, setup: { label: setup.label, image: setup.image }, ready: setup.ready, current: setup.current, on: setup.ready, model: setup.image.model ?? '' })))
  }, [setups.data, rows])
  const job = useTrialJob()
  const [dropOthers, setDropOthers] = useState(false)
  const [taken, setTaken] = useState<string | undefined>()
  // The pictures of the round that were deleted when one was taken: no longer shown.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const pictures = ((job.live?.result?.trial ?? (job.done?.result?.output as { tried?: TrialPicture[] } | undefined)?.tried) as TrialPicture[] | undefined) ?? []
  const chosen = (rows ?? []).filter(row => row.on)
  const trials: ImageTrial[] = chosen.map((row) => {
    const model = row.model.trim()
    // Another model of the same service is a setup of its own, named by its model.
    if (model.length === 0 || model === (row.setup.image.model ?? '')) return row.setup
    const image = { ...row.setup.image, model }
    return { label: imageSetupName({ provider: image.provider ?? 'none', ...(image.baseURL !== undefined ? { baseURL: image.baseURL } : {}), model }), image }
  })
  const distinct = new Set(trials.map(trial => JSON.stringify(trial.image))).size
  const start = (): void => {
    setTaken(undefined)
    setGone(new Set())
    job.start(async () => (of.picture !== undefined
      ? await controller.api.call('image.redraw', { root, picture: of.picture.path, trials })
      : await controller.api.call('image.create', { root, kind: 'portrait', target: of.character!.id, ...(params ?? {}), trials } as never)))
  }
  const take = (picture: TrialPicture): Promise<unknown> => controller.guard(async () => {
    const others = dropOthers ? pictures.flatMap(other => (other.path !== undefined && other.path !== picture.path ? [other.path] : [])) : []
    const done = await controller.api.call('trial.adopt', { root, path: picture.path!, ...(of.picture !== undefined ? { instead: of.picture.path } : {}), ...(others.length > 0 ? { others } : {}) })
    setTaken(picture.path)
    if (others.length > 0) setGone(previous => new Set([...previous, ...others]))
    await controller.refreshProject()
    onChanged?.()
    controller.toast('success', t(`用了「${picture.label}」画的这张${done.replaced.length > 0 ? `，换到了 ${done.replaced.join('、')} 上` : ''}${done.removed > 0 ? `；另外 ${done.removed} 张删掉了` : '；其余的还在图库里'}`, `Took the one by ${picture.label}${done.replaced.length > 0 ? `, now on ${done.replaced.join(', ')}` : ''}${done.removed > 0 ? `; the other ${done.removed} deleted` : '; the others stay in the gallery'}`))
  })
  const edit = (key: string, patch: Partial<Row>): void => { setRows(previous => previous?.map(row => (row.key === key ? { ...row, ...patch } : row))) }
  const again = (row: Row): void => { setRows(previous => (previous === undefined ? previous : [...previous.slice(0, previous.indexOf(row) + 1), { ...row, key: `${row.key}+${previous.length}`, current: false, on: true, model: '' }, ...previous.slice(previous.indexOf(row) + 1)])) }
  const running = job.busy
  const title = of.picture !== undefined ? t('换几个绘图服务画同一张', 'The same picture by several image services') : t(`用几个绘图服务画「${of.character?.name ?? ''}」的立绘`, `A portrait of ${of.character?.name ?? ''} by several image services`)
  return (
    <Modal wide className="nv-modal-trial" title={title} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('同一段提示词、同样的参考图，各画一张。画出来的不替换任何图，采纳了才算。', 'The same words and the same reference pictures, one picture each. Nothing is replaced until you take one.')}</span>
        <span className="nv-spacer" />
        {running ? <Button variant="ghost" onClick={job.stop}>{t('停止', 'Stop')}</Button> : null}
        <Button variant="primary" icon="layers" busy={running} disabled={distinct < 1 || chosen.length === 0} pending={t('正在画…', 'Drawing…')} onClick={start}>{pictures.length > 0 ? t(`再画一轮（${trials.length} 张）`, `Another round (${trials.length})`) : t(`画 ${trials.length} 张来比`, `Draw ${trials.length} to compare`)}</Button>
      </>
    )}>
      {rows === undefined ? <div className="nv-center">{setups.error !== undefined ? <p className="nv-muted">{setups.error}</p> : <Spinner />}</div> : rows.length === 0 ? (
        <p className="nv-note">{t('还没有可以比的绘图服务。到“设置 → 图像生成”配一个；换到别的服务时，原来那个会记着，之后就能在这里一起比。', 'There is no image service to compare yet. Set one up under Settings → Image generation; when you move to another, the one before is remembered and can be compared here.')}</p>
      ) : (
        <div className="nv-trial-rows">
          {rows.map(row => (
            <label key={row.key} className={cx('nv-trial-row', !row.ready && 'is-off')}>
              <input type="checkbox" checked={row.on} disabled={!row.ready || running} onChange={(event) => { edit(row.key, { on: event.target.checked }) }} />
              <span className="nv-trial-name">{row.setup.label.split(' · ')[0]}{row.current ? <Chip tone="blue">{t('现在用的', 'in use')}</Chip> : null}{!row.ready ? <Chip>{t('还不能用：缺密钥或没连上', 'not ready: no key, or not reachable')}</Chip> : null}</span>
              <TextInput className="nv-trial-model" value={row.model} disabled={!row.ready || running || row.setup.image.provider === 'codex'} placeholder={row.setup.image.provider === 'codex' ? 'gpt-image' : t('模型（留空用它配好的）', 'Model (empty: as set up)')} onChange={(event) => { edit(row.key, { model: event.target.value }) }} onClick={(event) => { event.preventDefault() }} />
              {row.ready && row.setup.image.provider !== 'codex' ? <button type="button" className="nv-link nv-small" disabled={running} onClick={(event) => { event.preventDefault(); again(row) }} title={t('同一个服务再加一行，填另一个模型', 'Another row of the same service, for another model')}>{t('＋ 再加一个模型', '+ another model')}</button> : null}
            </label>
          ))}
        </div>
      )}
      {job.error !== undefined ? <p className="nv-note is-warn">{job.error}</p> : null}
      {pictures.length > 0 ? (
        <>
          <div className="nv-trial-grid">
            {pictures.filter(picture => picture.path === undefined || !gone.has(picture.path)).map((picture, at) => (
              <figure key={`${picture.label}:${at}`} className={cx('nv-trial-cell', picture.path !== undefined && picture.path === taken && 'is-taken')}>
                <div className="nv-trial-picture">
                  {picture.path !== undefined ? <ProjectImage path={picture.path} alt={picture.label} /> : picture.error !== undefined ? <p className="nv-trial-failed">{picture.error}</p> : <Spinner />}
                </div>
                <figcaption>
                  <strong>{picture.label}</strong>
                  <span className="nv-muted nv-small">{picture.path !== undefined ? took(picture.seconds, t) : picture.error !== undefined ? t('没画成', 'failed') : t('正在画…', 'drawing…')}</span>
                  {picture.path !== undefined ? (picture.path === taken ? <Chip tone="green">{t('用了这张', 'taken')}</Chip> : <Button size="sm" variant="outline" icon="check" onClick={() => take(picture)}>{t('用这张', 'Take this one')}</Button>) : null}
                </figcaption>
              </figure>
            ))}
          </div>
          <label className="nv-check nv-small">
            <input type="checkbox" checked={dropOthers} onChange={(event) => { setDropOthers(event.target.checked) }} />
            <span>{t('采纳一张时，把这一轮其余的删掉（不勾：留在图库里，不进正文）', 'When one is taken, delete the rest of this round (unticked: they stay in the gallery, out of the text)')}</span>
          </label>
        </>
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
export function DeriveTrialDialog<Plan extends TrialPlanView>({ count, direction, volume, onClose, onTake }: { count: number; direction?: string; volume?: string; onClose: () => void; onTake: (plan: Plan) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const inUse = useRoleModel('architect')
  const [picked, setPicked] = usePicked(inUse)
  const job = useTrialJob()
  const plans = ((job.live?.result?.plans ?? (job.done?.result?.output as { plans?: Plan[] } | undefined)?.plans) as Plan[] | undefined) ?? []
  const start = (): void => {
    job.start(async () => await controller.api.call('trial.derive', { root, count, ...(direction !== undefined && direction.trim().length > 0 ? { direction: direction.trim() } : {}), ...(volume !== undefined && volume.length > 0 ? { volume } : {}), with: routesOf(picked) }))
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

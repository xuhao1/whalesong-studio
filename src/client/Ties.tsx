// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The ties between the things of a book's world, as the author works on them.
 * (Walking the world they make is the viewer's: `reader/album.tsx`.)
 *
 *   TiesBlock      on a place's, a house's, a thing's or a person's page: what
 *                  stands around it, each a way to step over to it — and the
 *                  tools to add a tie or take one away
 *   useDeriveTies  having the planner work the ties out, and what the pass did
 *   TiesReport     that, said in full
 */
import { useMemo, useState } from 'react'
import { neighbours, STANDINGS, TIE_ENDS, type Tie, type TieEnd, type TieKind } from '../shared/ties'
import type { ProjectState } from '../shared/types'
import { groupOf } from '../shared/world'
import { Icon } from './icons'
import { STANDING_LABELS } from './reader/album'
import { Button, Field, Modal, Select, useAction, useProject, useStudio, useT, type Translate } from './ui'

/** What the two ends of a tie are called, and where the chapters of its time stand. */
function useNames(project: ProjectState): { nameOf: (end: TieEnd) => string; indexOf: (chapter: string) => number | undefined } {
  return useMemo(() => {
    const cards = new Map(project.characters.map(card => [card.id, card]))
    const entries = new Map(project.world.map(entry => [entry.id, entry]))
    const order = new Map(project.chapters.map(chapter => [chapter.id, chapter.index]))
    return {
      nameOf: end => (end.type === 'character' ? cards.get(end.id)?.name : entries.get(end.id)?.name) ?? end.id,
      indexOf: chapter => order.get(chapter),
    }
  }, [project.characters, project.world, project.chapters])
}

/** When a tie holds, in a few characters: `17 起`, `23–77`, nothing when it always does. */
function span(tie: Tie, indexOf: (chapter: string) => number | undefined, t: Translate): string {
  const since = tie.since !== undefined ? indexOf(tie.since) : undefined
  const until = tie.until !== undefined ? indexOf(tie.until) : undefined
  if (since !== undefined && until !== undefined) return t(`第 ${since}–${until} 章`, `ch. ${since}–${until}`)
  if (since !== undefined) return t(`第 ${since} 章起`, `from ch. ${since}`)
  if (until !== undefined) return t(`到第 ${until} 章`, `until ch. ${until}`)
  return ''
}

/**
 * What stands around one thing, on its own page.
 * @param of - the thing: a character or an entry of the bible.
 */
export function TiesBlock({ of }: { of: TieEnd }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { nameOf, indexOf } = useNames(project)
  const { busy, run } = useAction()
  const [adding, setAdding] = useState(false)
  const ties = project.ties
  // A Host from before there were ties says nothing of them.
  if (ties === undefined) return null
  const around = neighbours(ties, of)
  const shown = STANDINGS.filter(standing => (around[standing]?.length ?? 0) > 0)
  const open = (end: TieEnd): void => {
    if (end.type === 'character') controller.openCharacter(end.id)
    else controller.openWorld(end.id)
  }
  return (
    <section className="nv-ties">
      <header className="nv-ties-head">
        <strong>{t('在这个世界里', 'In the world')}</strong>
        <Button size="sm" variant="ghost" icon="plus" onClick={() => { setAdding(true) }}>{t('添加关系', 'Add a tie')}</Button>
      </header>
      {shown.length === 0 ? <p className="nv-muted nv-small">{of.type === 'character' ? t('还没有记下它属于哪一家、住在哪、手里有什么。', 'Nothing is written down yet of the house they belong to, where they live, what they hold.') : t('还没有记下它在哪里面、里面有什么、谁在这里。', 'Nothing is written down yet of what it is in, what is in it, who is here.')}</p> : null}
      {shown.map(standing => (
        <div key={standing} className="nv-ties-row">
          <span className="nv-ties-label">{t(...STANDING_LABELS[standing])}</span>
          <div className="nv-ties-list">
            {around[standing]!.map(({ end, tie }) => (
              <span key={tie.id} className="nv-tie">
                <button type="button" className="nv-tie-open" onClick={() => { open(end) }} title={tie.note ?? t('去看它', 'Go to it')}>
                  <Icon name={end.type === 'character' ? 'users' : 'arrowRight'} size={11} />
                  <span>{nameOf(end)}</span>
                  {span(tie, indexOf, t).length > 0 ? <em>{span(tie, indexOf, t)}</em> : null}
                </button>
                <button type="button" className="nv-tie-remove" disabled={busy} onClick={() => { void run(async () => { await controller.api.call('tie.remove', { root, id: tie.id }); await controller.refreshProject() }) }} title={t('去掉这条关系', 'Take this tie away')} aria-label={t('去掉这条关系', 'Take this tie away')}><Icon name="x" size={10} /></button>
              </span>
            ))}
          </div>
        </div>
      ))}
      {adding ? <TieDialog of={of} onClose={() => { setAdding(false) }} /> : null}
    </section>
  )
}

/** Add a tie from the page of one of its ends. */
function TieDialog({ of, onClose }: { of: TieEnd; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { nameOf } = useNames(project)
  const { busy, run } = useAction()
  const here = of.type === 'world' ? project.world.find(entry => entry.id === of.id) : undefined
  const group = here !== undefined ? groupOf(here.category) : undefined
  // The ties this thing can be an end of, each said from its side.
  const choices = useMemo(() => {
    const list: { key: string; kind: TieKind; side: 'from' | 'to'; label: string; others: { value: string; label: string }[] }[] = []
    const entries = (wanted: ReturnType<typeof groupOf>[]): { value: string; label: string }[] => project.world.filter(entry => wanted.includes(groupOf(entry.category)) && !(of.type === 'world' && entry.id === of.id)).map(entry => ({ value: entry.id, label: entry.name }))
    const people = project.characters.map(card => ({ value: card.id, label: card.name }))
    if (of.type === 'character') {
      list.push({ key: 'member', kind: 'member', side: 'from', label: t('属于（家族 / 组织）', 'belongs to (a house)'), others: entries(['factions']) })
      list.push({ key: 'resides', kind: 'resides', side: 'from', label: t('住在（地点）', 'lives at (a place)'), others: entries(['places']) })
      list.push({ key: 'holds', kind: 'holds', side: 'from', label: t('持有（物品）', 'holds (a thing)'), others: entries(['items']) })
    } else if (group === 'places') {
      list.push({ key: 'within-up', kind: 'within', side: 'from', label: t('在……里面（上一级地点）', 'is in (the place above)'), others: entries(['places']) })
      list.push({ key: 'within-down', kind: 'within', side: 'to', label: t('这里有（下一级地点）', 'has in it (a place)'), others: entries(['places']) })
      list.push({ key: 'resides', kind: 'resides', side: 'to', label: t('住在这里的人', 'somebody lives here'), others: people })
      list.push({ key: 'seat', kind: 'seat', side: 'to', label: t('坐落在这里的家族 / 组织', 'a house has its seat here'), others: entries(['factions']) })
    } else if (group === 'factions') {
      list.push({ key: 'member', kind: 'member', side: 'to', label: t('这里的人（成员）', 'somebody belongs to it'), others: people })
      list.push({ key: 'seat', kind: 'seat', side: 'from', label: t('坐落在（地点）', 'has its seat at (a place)'), others: entries(['places']) })
      list.push({ key: 'within-up', kind: 'within', side: 'from', label: t('属于更大的家族 / 组织', 'is a branch of'), others: entries(['factions']) })
    } else if (group === 'items') {
      list.push({ key: 'holds', kind: 'holds', side: 'to', label: t('在谁手里', 'is held by'), others: people })
    }
    return list.filter(choice => choice.others.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.world, project.characters, of.type, of.id, group])
  const [key, setKey] = useState(choices[0]?.key ?? '')
  const choice = choices.find(item => item.key === key) ?? choices[0]
  const [other, setOther] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const chapters = [{ value: '', label: t('（不限）', '(always)') }, ...project.chapters.map(chapter => ({ value: chapter.id, label: `${chapter.index}. ${chapter.title}` }))]
  const save = (): Promise<unknown> => run(async () => {
    if (choice === undefined || other.length === 0) return
    const otherEnd: TieEnd = { type: TIE_ENDS[choice.kind][choice.side === 'from' ? 'to' : 'from'], id: other }
    await controller.api.call('tie.save', { root, tie: { kind: choice.kind, from: choice.side === 'from' ? of : otherEnd, to: choice.side === 'from' ? otherEnd : of, ...(since.length > 0 ? { since } : {}), ...(until.length > 0 ? { until } : {}) } })
    await controller.refreshProject()
    onClose()
  })
  return (
    <Modal title={t(`「${nameOf(of)}」的关系`, `A tie of ${nameOf(of)}`)} onClose={onClose} footer={<Button variant="primary" busy={busy} disabled={choice === undefined || other.length === 0} onClick={save}>{t('记下', 'Write it down')}</Button>}>
      {choices.length === 0 ? <p className="nv-muted">{t('设定里还没有可以和它连起来的东西：先建地点、家族或物品。', 'The bible has nothing yet to tie it to: make a place, a house or a thing first.')}</p> : (
        <>
          <Field label={t('什么关系', 'How')}><Select value={choice?.key ?? ''} options={choices.map(item => ({ value: item.key, label: item.label }))} onChange={(value) => { setKey(value); setOther('') }} /></Field>
          <Field label={t('和谁 / 和什么', 'With')}><Select value={other} options={[{ value: '', label: t('请选择…', 'Choose…') }, ...(choice?.others ?? [])]} onChange={setOther} /></Field>
          <div className="nv-form-grid">
            <Field label={t('从哪一章起', 'From chapter')} hint={t('一直如此就不选', 'Leave empty when it always holds')}><Select value={since} options={chapters} onChange={setSince} /></Field>
            <Field label={t('到哪一章为止', 'Until chapter')}><Select value={until} options={chapters} onChange={setUntil} /></Field>
          </div>
        </>
      )}
    </Modal>
  )
}

// ───────────────────────────── having the ties worked out ─────────────────────────────

/** What a pass of the planner over the ties did. */
export interface TiesPass {
  added?: number
  changed?: number
  removed?: number
  /** Ties it meant and could not write down: a name nothing in the bible answers to. */
  skipped?: string[]
  /** Entries the ties needed and the bible lacked, made by the pass. */
  created?: string[]
  /** Things that happen to places, houses and things — built, changed, in decline, gone — written down on their entries. */
  events?: number
}

/**
 * Having the planner work out how the things of the world stand to each other
 * — from the bible and the chapter digests; ties already there are kept. What
 * the pass did stays to be read until it is put away.
 */
export function useDeriveTies(): { busy: boolean; derive: () => Promise<unknown>; report: TiesPass | undefined; dismiss: () => void } {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const working = useAction()
  const [report, setReport] = useState<TiesPass | undefined>()
  const derive = (): Promise<unknown> => working.run(async () => {
    const done = await controller.run('ai.ties', { root })
    const output = done.result?.output as TiesPass | undefined
    await controller.refreshProject()
    setReport(output)
    controller.toast('success', t(`关系理好了：新增 ${output?.added ?? 0} 条，改了 ${output?.changed ?? 0} 条`, `Ties worked out: ${output?.added ?? 0} added, ${output?.changed ?? 0} changed`))
  })
  return { busy: working.busy, derive, report, dismiss: () => { setReport(undefined) } }
}

/** What the last pass over the ties did, said in full where it was asked for: entries it made, ties it could not write down. */
export function TiesReport({ report, onDismiss }: { report: TiesPass | undefined; onDismiss: () => void }) {
  const t = useT()
  if (report === undefined) return null
  return (
    <div className="nv-note" role="status">
      {t(`策划这一遍：新增 ${report.added ?? 0} 条关系，改了 ${report.changed ?? 0} 条，去掉 ${report.removed ?? 0} 条。`, `This pass: ${report.added ?? 0} ties added, ${report.changed ?? 0} changed, ${report.removed ?? 0} removed.`)}
      {(report.events ?? 0) > 0 ? t(` 还记下了 ${report.events} 件地点 / 家族 / 物品自己的大事（建成、易主、荒废、被毁），在各自条目的"轨迹"里。`, ` ${report.events} things that happen to places, houses and things (built, changed, in decline, gone) were written down too, under each entry's course.`) : ''}
      {(report.created?.length ?? 0) > 0 ? t(` 关系里要用到、设定里原来没有的，已经建成条目：${report.created!.join('、')}（都在"设定"里，可以改、可以删）。`, ` Entries the ties needed and the bible lacked were made: ${report.created!.join(', ')} (all under Bible, to be changed or removed).`) : ''}
      {(report.skipped?.length ?? 0) > 0 ? t(` 有 ${report.skipped!.length} 条没能记下（名字在设定里对不上）：${report.skipped!.slice(0, 4).join('；')}${report.skipped!.length > 4 ? ' 等' : ''}`, ` ${report.skipped!.length} could not be written down (a name nothing in the bible answers to): ${report.skipped!.slice(0, 4).join('; ')}${report.skipped!.length > 4 ? '…' : ''}`) : ''}
      <button type="button" className="nv-link" onClick={onDismiss}> {t('知道了', 'Got it')}</button>
    </div>
  )
}

/** What the planner's pass over the ties is asked with, and what it does: the words of the button wherever it stands. */
export const DERIVE_TIES_HINT: [string, string] = ['让策划根据设定和各章的收录，理出谁在哪里面、谁属于谁、谁住在哪、谁持有什么；已有的关系会保留', 'Have the planner work out, from the bible and the chapter digests, what is in what, who belongs where, lives where, holds what; ties already there are kept']

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Putting the bible's entries in order.
 *
 *   TidyDialog    the planner looks the entries over for one thing written
 *                 down as several, and for entries filed under the wrong kind;
 *                 what it finds is a list to tick, and only what is ticked is done
 *   MergeDialog   from an entry's own page: it and another are one thing
 *
 * A book read in by import has a place under every name the text calls it by.
 * Nothing here decides for the author: a model's "these are the same" is a
 * line with grounds, and a merge is the author's press.
 */
import { useEffect, useMemo, useState } from 'react'
import type { WorldEntry, WorldTidy } from '../shared/types'
import { groupOf } from '../shared/world'
import { WORLD_CATEGORY } from './labels'
import { Button, Field, Modal, Select, Spinner, useAction, useProject, useRunningJob, useSnapshot, useStudio, useT } from './ui'

const isTidy = (title: string | undefined): boolean => title === 'tidy world'

/** The planner's look over the entries, and what of it the author goes by. */
export function TidyDialog({ onClose }: { onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const running = useRunningJob(job => job.kind === 'bible' && isTidy(job.title))
  // The latest look-over that ended while the Studio was open: gone by until the entries are looked over again.
  const last = useSnapshot(snapshot => snapshot.jobs.find(job => job.kind === 'bible' && isTidy(job.title) && job.status === 'done'))
  const [found, setFound] = useState<WorldTidy | undefined>(() => last?.result?.output as WorldTidy | undefined)
  useEffect(() => {
    const output = last?.result?.output as WorldTidy | undefined
    if (output !== undefined) setFound(output)
  }, [last?.id])
  const looking = useAction()
  const doing = useAction()
  // Which entry of a group stays, where the author would rather keep another name than the planner's.
  const [keeps, setKeeps] = useState<Record<string, string>>({})
  const [off, setOff] = useState<Set<string>>(new Set())
  const [done, setDone] = useState<{ merged: number; moved: number } | undefined>()
  // What was found is gone by as the bible stands now: an entry merged or deleted since is not proposed again.
  const here = useMemo(() => new Map(project.world.map(entry => [entry.id, entry])), [project.world])
  const same = useMemo(() => (found?.same ?? []).map((group) => {
    const members = [group.keep, ...group.others].filter(member => here.has(member.id))
    return { key: `same:${group.keep.id}`, members, keep: group.keep.id, why: group.why }
  }).filter(group => group.members.length > 1), [found, here])
  const kinds = useMemo(() => (found?.kinds ?? []).filter(item => here.get(item.id)?.category === item.from).map(item => ({ ...item, key: `kind:${item.id}` })), [found, here])
  const look = (): Promise<unknown> => looking.run(async () => {
    setDone(undefined)
    const finished = await controller.run('ai.worldTidy', { root })
    const output = finished.result?.output as WorldTidy | undefined
    if (output !== undefined) {
      setFound(output)
      setOff(new Set())
      setKeeps({})
    }
  })
  const toggle = (key: string): void => {
    const next = new Set(off)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setOff(next)
  }
  const chosen = same.filter(group => !off.has(group.key)).length + kinds.filter(item => !off.has(item.key)).length
  const apply = (): Promise<unknown> => doing.run(async () => {
    let merged = 0
    let moved = 0
    const folded = new Set<string>()
    for (const group of same) {
      if (off.has(group.key)) continue
      const keep = group.members.some(member => member.id === keeps[group.key]) ? keeps[group.key]! : group.members.some(member => member.id === group.keep) ? group.keep : group.members[0]!.id
      const fold = group.members.filter(member => member.id !== keep).map(member => member.id)
      await controller.api.call('world.merge', { root, keep, fold })
      for (const id of fold) folded.add(id)
      merged += 1
    }
    for (const item of kinds) {
      // An entry folded into another a moment ago has no kind of its own to change: its name is the other's now.
      if (off.has(item.key) || folded.has(item.id)) continue
      await controller.api.call('world.save', { root, entry: { id: item.id, category: item.to } })
      moved += 1
    }
    await controller.refreshProject()
    setDone({ merged, moved })
    controller.toast('success', t(`整理好了：合并了 ${merged} 组，改了 ${moved} 条的类别`, `Tidied: ${merged} groups merged, ${moved} entries moved to another kind`))
  })
  const busy = looking.busy || running !== undefined
  return (
    <Modal wide title={t('整理设定条目', 'Tidy the bible')} onClose={onClose} footer={(
      <>
        <Button variant="ghost" icon="sparkles" busy={busy} pending={t('策划正在看…', 'The planner is looking…')} onClick={look}>{found === undefined ? t('让策划看一遍', 'Have the planner look') : t('再看一遍', 'Look again')}</Button>
        <span className="nv-spacer" />
        <Button onClick={onClose}>{t('关闭', 'Close')}</Button>
        {same.length + kinds.length > 0 ? <Button variant="primary" busy={doing.busy} pending={t('正在整理…', 'Tidying…')} disabled={chosen === 0 || busy} onClick={apply}>{t(`照勾选的做（${chosen}）`, `Do what is ticked (${chosen})`)}</Button> : null}
      </>
    )}>
      <p className="nv-muted">{t('让策划找出记重了的条目和放错类别的。它只提议，勾选后才会改。', 'The planner looks for entries kept twice and ones filed wrongly. It only proposes; nothing changes until you tick and apply.')}</p>
      {busy ? <p className="nv-row"><Spinner size={13} /><span className="nv-muted">{running?.progress?.label ?? t(`策划正在把 ${project.world.length} 个条目看一遍…`, `The planner is looking over ${project.world.length} entries…`)}</span></p> : null}
      {done !== undefined ? <p className="nv-note is-ok" role="status">{t(`做完了：合并了 ${done.merged} 组，改了 ${done.moved} 条的类别。`, `Done: ${done.merged} group(s) merged, ${done.moved} entr(ies) refiled.`)}</p> : null}
      {found !== undefined && !busy && same.length + kinds.length === 0 && done === undefined ? <p className="nv-note">{t(`策划看了 ${found.entries} 个条目，没有发现记重了的或类别放错的。`, `The planner looked over ${found.entries} entries and found none written down twice or filed wrongly.`)}</p> : null}
      {same.length > 0 ? (
        <section className="nv-tidy">
          <h3>{t('可能是同一样东西', 'May be one thing')}<span className="nv-muted"> {same.length}</span></h3>
          {same.map((group) => {
            const keep = group.members.some(member => member.id === keeps[group.key]) ? keeps[group.key]! : group.keep
            return (
              <label key={group.key} className="nv-tidy-row">
                <input type="checkbox" checked={!off.has(group.key)} onChange={() => { toggle(group.key) }} />
                <span className="nv-tidy-what">
                  <span className="nv-tidy-names">{group.members.map(member => <span key={member.id} className={member.id === keep ? 'nv-chip nv-chip-blue' : 'nv-chip nv-chip-neutral'}>{member.name}</span>)}</span>
                  {group.why !== undefined ? <span className="nv-muted nv-small">{group.why}</span> : null}
                </span>
                <span className="nv-tidy-keep">
                  <span className="nv-muted nv-small">{t('留下', 'Keep')}</span>
                  <Select value={keep} options={group.members.map(member => ({ value: member.id, label: member.name }))} onChange={(value) => { setKeeps({ ...keeps, [group.key]: value }) }} />
                </span>
              </label>
            )
          })}
        </section>
      ) : null}
      {kinds.length > 0 ? (
        <section className="nv-tidy">
          <h3>{t('类别可能放错了', 'May be filed under the wrong kind')}<span className="nv-muted"> {kinds.length}</span></h3>
          {kinds.map(item => (
            <label key={item.key} className="nv-tidy-row">
              <input type="checkbox" checked={!off.has(item.key)} onChange={() => { toggle(item.key) }} />
              <span className="nv-tidy-what">
                <span className="nv-tidy-names"><strong>{item.name}</strong><span className="nv-muted">{t(...WORLD_CATEGORY[item.from])} → </span><span className="nv-chip nv-chip-blue">{t(...WORLD_CATEGORY[item.to])}</span></span>
                {item.why !== undefined ? <span className="nv-muted nv-small">{item.why}</span> : null}
              </span>
            </label>
          ))}
        </section>
      ) : null}
    </Modal>
  )
}

/** From an entry's page: it and another entry are one thing. */
export function MergeDialog({ entry, onClose }: { entry: WorldEntry; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const group = groupOf(entry.category)
  // Those of its own page first: a place is most often another name of a place.
  const others = useMemo(() => {
    const rest = project.world.filter(other => other.id !== entry.id)
    return [...rest.filter(other => groupOf(other.category) === group), ...rest.filter(other => groupOf(other.category) !== group)]
  }, [project.world, entry.id, group])
  const [other, setOther] = useState('')
  const [keep, setKeep] = useState<'this' | 'other'>('this')
  const chosen = others.find(candidate => candidate.id === other)
  const merge = (): Promise<unknown> => run(async () => {
    if (chosen === undefined) return
    const stays = keep === 'this' ? entry : chosen
    const goes = keep === 'this' ? chosen : entry
    const merged = await controller.api.call('world.merge', { root, keep: stays.id, fold: [goes.id] })
    await controller.refreshProject()
    controller.toast('success', t(`「${goes.name}」并入了「${stays.name}」${merged.ties > 0 ? `，${merged.ties} 条关系跟了过去` : ''}`, `"${goes.name}" was folded into "${stays.name}"${merged.ties > 0 ? `; ${merged.ties} ties went along` : ''}`))
    onClose()
    controller.openWorld(merged.entry.id)
  })
  return (
    <Modal title={t(`合并「${entry.name}」`, `Merge "${entry.name}"`)} onClose={onClose} footer={<Button variant="primary" icon="branch" busy={busy} pending={t('正在合并…', 'Merging…')} disabled={chosen === undefined} onClick={merge}>{t('合并成一条', 'Make them one')}</Button>}>
      <p className="nv-muted">{t('并进去的那一条成为留下那一条的别名，正文、图和关系都归它。合并后不能拆回。', 'The one folded in becomes an alias of the one kept, which takes its text, art and ties. A merge cannot be undone.')}</p>
      <Field label={t('和它是同一样东西的', 'The entry it is one thing with')}>
        <Select value={other} options={[{ value: '', label: t('请选择…', 'Choose…') }, ...others.map(candidate => ({ value: candidate.id, label: `${candidate.name}${groupOf(candidate.category) !== group ? ` · ${t(...WORLD_CATEGORY[candidate.category])}` : ''}` }))]} onChange={setOther} />
      </Field>
      {chosen !== undefined ? (
        <Field label={t('留下哪个名字', 'Which name stays')}>
          <div className="nv-seg" role="group">
            <button type="button" className={keep === 'this' ? 'is-active' : ''} onClick={() => { setKeep('this') }}>{entry.name}</button>
            <button type="button" className={keep === 'other' ? 'is-active' : ''} onClick={() => { setKeep('other') }}>{chosen.name}</button>
          </div>
        </Field>
      ) : null}
    </Modal>
  )
}

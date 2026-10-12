// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * One beat by a sentence.
 *
 * Laying a chapter's beats out is all or nothing — the planner writes every one of them anew. Most of the time the
 * author wants one thing of them: a beat more ("she finds the letter before he comes"), or a beat or two different
 * ("in the third he refuses instead"). Here that is said in a sentence, and nothing else of the chapter's beats is
 * touched: with beats ticked, those are changed by it; with none, one is added — where the author says, or where the
 * planner sees it belongs.
 */
import { useState } from 'react'
import type { Beat } from '../shared/types'
import { Button, plainEnter, Select, TextInput, useProject, useStudio, useT } from './ui'

/** What `ai.beat` hands back (`TouchBeatsResult`). */
interface Touched { added?: Beat; at?: number; changed?: Beat[]; removed?: string[]; beats?: number; why?: string }

export function BeatAsk({ chapter, beats, chosen, onDone, disabled, why }: {
  chapter: string
  /** The chapter's beats as they are saved. */
  beats: Beat[]
  /** The ids of the beats the author ticked: those are what the sentence changes. None: a beat is added. */
  chosen: string[]
  /** Told once the work is done (the ticks have had their use). */
  onDone?: () => void
  disabled?: boolean
  /** Why it cannot be used now, where it cannot. */
  why?: string | undefined
}) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [ask, setAsk] = useState('')
  const [where, setWhere] = useState('')
  const [busy, setBusy] = useState(false)
  // (A beat ticked that is no longer there — taken out meanwhile — is not asked for.)
  const picked = chosen.filter(id => beats.some(beat => beat.id === id))
  const changing = picked.length > 0
  const ready = ask.trim().length > 0 && !busy && disabled !== true
  const start = (): void => {
    if (!ready) return
    setBusy(true)
    void controller.guard(async () => {
      const info = await controller.run('ai.beat', { root, chapter, ask: ask.trim(), ...(changing ? { beats: picked } : where.length > 0 ? { after: where } : {}) })
      const done = info.result?.output as Touched | undefined
      const said = done?.why !== undefined ? t(` 策划：${done.why}`, ` The planner: ${done.why}`) : ''
      if (done?.added !== undefined) controller.toast('success', t(`加了一个节拍，现在是第 ${done.at} 个；别的没动。${said}`, `A beat was added — it is beat ${done.at} now; no other was touched.${said}`))
      else controller.toast('success', t(`改了 ${done?.changed?.length ?? 0} 个节拍${(done?.removed?.length ?? 0) > 0 ? `，去掉了 ${done!.removed!.length} 个` : ''}；别的没动。原来的在章纲的历史版本里。${said}`, `${done?.changed?.length ?? 0} beat(s) changed${(done?.removed?.length ?? 0) > 0 ? `, ${done!.removed!.length} taken out` : ''}; the others stand as they stood. What was there is in the plan's history.${said}`))
      setAsk('')
      setWhere('')
      onDone?.()
    }).finally(() => { setBusy(false) })
  }
  return (
    <div className="nv-assist nv-beat-ask">
      <TextInput
        value={ask}
        disabled={busy}
        placeholder={changing
          ? t(`一句话：勾选的 ${picked.length} 个节拍要怎么改`, `A sentence: how the ${picked.length} ticked beat(s) are to change`)
          : t('一句话：加一个节拍；勾了节拍就是改它们', 'A sentence: a beat to add — or, with beats ticked, how they change')}
        onChange={(event) => { setAsk(event.target.value) }}
        onKeyDown={(event) => { if (plainEnter(event)) start() }}
      />
      {!changing && beats.length > 0 ? (
        <Select<string>
          value={where}
          disabled={busy}
          options={[
            { value: '', label: t('位置：策划定', 'Where: as it belongs') },
            { value: 'start', label: t('放在最前', 'First') },
            ...beats.map((beat, at) => ({ value: beat.id, label: t(`第 ${at + 1} 个之后`, `After beat ${at + 1}`) })),
          ]}
          onChange={setWhere}
        />
      ) : null}
      <Button
        icon={changing ? 'wand' : 'sparkles'}
        busy={busy}
        pending={t('策划在写…', 'The planner is writing…')}
        disabled={!ready}
        title={disabled === true ? why : changing ? t('只改勾选的这几个，别的节拍不动', 'Only the ticked ones change; the other beats are not touched') : t('只加这一个，现有的节拍不动', 'This one is added; the beats there are stay untouched')}
        onClick={start}
      >
        {changing ? t(`照这句话改这 ${picked.length} 个`, `Change these ${picked.length} by it`) : t('照这句话加一个', 'Add one by it')}
      </Button>
    </div>
  )
}

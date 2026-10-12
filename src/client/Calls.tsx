// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The record of calls, where it is read: every call the Studio made to a
 * text model for the book — what work it was, which model and how it was
 * set — and, opened, everything that was sent and said.
 *
 * A model answers from what it is sent and from nothing else. Two pieces
 * that came out unlike each other are told apart here: their calls ticked
 * and laid side by side, or — two of them — read as what one was sent that
 * the other was not.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatCount } from '../shared/text'
import { CALLS_MB_DEFAULT, type CallRecord, type CallRow, type ProjectState } from '../shared/types'
import { Compare, type CompareItem } from './Compare'
import { DiffView } from './components/ProposalCard'
import { Icon } from './icons'
import { BATCH_STEP, jobTitle } from './labels'
import { Button, Chip, Field, Modal, Spinner, Tabs, TextInput, useAction, useConfirm, useLoad, useProject, useSnapshot, useStudio, useT, type Translate } from './ui'

const ROLE: Record<string, [string, string]> = {
  writer: ['写手', 'Writer'],
  architect: ['策划', 'Planner'],
  analyst: ['场记', 'Continuity'],
  director: ['导演', 'Director'],
  producer: ['后期', 'Post-production'],
  vision: ['看图的模型', 'The model that looks at pictures'],
}

type Part = 'prompt' | 'stable' | 'system' | 'reply'

/** The parts of a call, in the order they were sent, in the author's words. */
const PARTS: { part: Part; label: [string, string]; hint: [string, string] }[] = [
  { part: 'system', label: ['规则和文风', 'Rules and style'], hint: ['这个角色的守则，写手还带着这本书的文风：每次调用都一样', 'The standing rules of the role — and, for the writer, the book\'s style: the same call after call'] },
  { part: 'stable', label: ['打头的部分', 'What opens the request'], hint: ['排在最前面、一连串调用里不变的那一段：这本书，和到这里为止的前文', 'Sent ahead of the rest and the same over a run of calls: the book, and the story so far'] },
  { part: 'prompt', label: ['这一次的材料和要求', 'This call\'s material and what was asked'], hint: ['只属于这一次的：这一章的章纲、人物、设定、要守的事实，最后是对它的要求', 'This call\'s own: the chapter\'s plan, the people, the world, what must hold — and last, what was asked'] },
  { part: 'reply', label: ['模型的回复', 'What the model said'], hint: ['它交回来的原文，工坊还没有动过', 'What it handed back, before the Studio touched it'] },
]

/** What work a call was for, in the author's words. */
export function callWork(call: Pick<CallRow, 'step' | 'title' | 'kind'>, t: Translate): string {
  // The job it was made in, and — where the job is more than one thing — which of them: a step of a batch, the digest after a chapter written.
  const job = call.kind === 'batch' ? t('批量', 'Batch') : call.title !== undefined ? t(...jobTitle({ title: call.title, kind: call.kind ?? 'write' })) : undefined
  const step = call.step !== undefined && call.kind !== 'digest' ? t(...(BATCH_STEP[call.step] ?? [call.step, call.step])) : undefined
  const named = [job, step].filter((part, at, all): part is string => part !== undefined && all.indexOf(part) === at)
  return named.length > 0 ? named.join(' · ') : t('任务之外的调用', 'A call outside any job')
}

const when = (call: Pick<CallRow, 'at'>): string => {
  const at = new Date(call.at)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const took = (ms: number, t: Translate): string => (ms >= 90_000 ? t(`${(ms / 60_000).toFixed(1)} 分钟`, `${(ms / 60_000).toFixed(1)} min`) : t(`${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`, `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`))

const megabytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/** Which model answered and how it was set. */
function setting(call: Pick<CallRow, 'model' | 'effort' | 'temperature'>, t: Translate): string {
  return [call.model, call.effort, call.temperature !== undefined ? t(`温度 ${call.temperature}`, `temperature ${call.temperature}`) : undefined].filter(part => part !== undefined && part.length > 0).join(' · ')
}

/** How much went and came back: in tokens where the provider counted, in characters otherwise. */
function amounts(call: CallRow, locale: string, t: Translate): string {
  const count = (value: number): string => formatCount(value, locale)
  const sent = call.input !== undefined
    ? t(`发 ${count(call.input)} token${call.cached !== undefined && call.cached > 0 ? `（其中 ${count(call.cached)} 命中缓存）` : ''}`, `${count(call.input)} tokens sent${call.cached !== undefined && call.cached > 0 ? ` (${count(call.cached)} from the cache)` : ''}`)
    : t(`发 ${count(call.sent)} 字`, `${count(call.sent)} characters sent`)
  const got = call.output !== undefined ? t(`回 ${count(call.output)} token`, `${count(call.output)} back`) : t(`回 ${count(call.got)} 字`, `${count(call.got)} back`)
  return `${sent} → ${got}`
}

/** How a call ended, where that is worth a word: it failed, it was stopped, it ran into its limit. */
function ending(call: CallRow, t: Translate): ReactNode {
  if (call.stopped === true) return <Chip tone="amber">{t('被停止', 'stopped')}</Chip>
  if (call.error !== undefined) return <Chip tone="red" title={call.error}>{t('失败', 'failed')}</Chip>
  if (call.finish === 'max-tokens') return <Chip tone="amber" title={t('模型一次输出到了上限，回复在这里被截断', 'The reply ran into the model\'s output limit and ends there')}>{t('写到上限', 'hit its limit')}</Chip>
  return null
}

function chapterName(project: Pick<ProjectState, 'chapters'>, id: string | undefined, t: Translate): string | undefined {
  if (id === undefined) return undefined
  const chapter = project.chapters.find(item => item.id === id)
  return chapter !== undefined ? t(`第 ${chapter.index} 章《${chapter.title}》`, `ch. ${chapter.index} "${chapter.title}"`) : undefined
}

/** Calls read whole, fetched as they are asked for and kept while the record is looked at. */
function useCallTexts(ids: readonly string[]): Record<string, { call?: CallRecord; error?: string }> {
  const { controller } = useStudio()
  const { root } = useProject()
  const [read, setRead] = useState<Record<string, { call?: CallRecord; error?: string }>>({})
  const asked = useRef(new Set<string>())
  useEffect(() => {
    for (const id of ids) {
      if (asked.current.has(id)) continue
      asked.current.add(id)
      void controller.api.call('calls.read', { root, id }).then(
        (got) => { setRead(previous => ({ ...previous, [id]: { call: got.call } })) },
        (reason: unknown) => { setRead(previous => ({ ...previous, [id]: { error: reason instanceof Error ? reason.message : String(reason) } })) },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|'), root])
  return read
}

/** How a call was set and how it went, line by line. */
function CallFacts({ call }: { call: CallRow }) {
  const { locale } = useStudio()
  const t = useT()
  const { project } = useProject()
  const rows: [string, ReactNode][] = [
    [t('什么时候', 'When'), new Date(call.at).toLocaleString()],
    [t('哪件活', 'The work'), [callWork(call, t), chapterName(project, call.chapter, t) ?? call.target].filter(Boolean).join(' · ')],
    [t('谁', 'Who'), t(...(ROLE[call.role] ?? [call.role, call.role]))],
    [t('模型', 'Model'), `${call.provider} / ${call.model}`],
    [t('思考档位', 'Reasoning'), call.effort ?? t('模型默认', 'the model\'s default')],
    [t('温度', 'Temperature'), call.temperature !== undefined ? String(call.temperature) : t('没有指定（模型默认）', 'not set (the model\'s default)')],
    [t('输出上限', 'Output limit'), call.maxTokens !== undefined ? `${formatCount(call.maxTokens, locale)} token` : t('没有指定', 'not set')],
    [t('用量', 'Used'), `${amounts(call, locale, t)}${call.thought !== undefined ? t(` · 思考 ${formatCount(call.thought, locale)} 字`, ` · ${formatCount(call.thought, locale)} characters of reasoning`) : ''}`],
    [t('用时', 'Took'), took(call.ms, t)],
    [t('怎么结束的', 'How it ended'), call.stopped === true ? t('被停止', 'stopped') : call.error !== undefined ? t(`失败：${call.error}`, `failed: ${call.error}`) : call.finish === 'max-tokens' ? t('写到输出上限，被截断（工坊会接着让它续写，那是下一条记录）', 'ran into the output limit (the Studio then has it go on: that is the next call on record)') : call.finish === 'stop' ? t('正常写完', 'finished') : call.finish ?? ''],
    ...(call.images !== undefined && call.images.length > 0 ? [[t('带的图', 'Pictures sent'), call.images.join(t('、', ', '))] as [string, ReactNode]] : []),
  ]
  return (
    <table className="nv-call-facts">
      <tbody>{rows.map(([name, value]) => <tr key={name}><th>{name}</th><td>{value}</td></tr>)}</tbody>
    </table>
  )
}

/** Everything a call was sent and said, part by part in the order it went. */
function CallBody({ call, lean }: { call: CallRecord; lean?: boolean }) {
  const { controller, locale } = useStudio()
  const t = useT()
  const copy = (text: string): void => { void navigator.clipboard?.writeText(text).then(() => { controller.toast('success', t('已复制', 'Copied')) }, () => {}) }
  return (
    <div className="nv-call">
      {lean === true ? null : <CallFacts call={call} />}
      {PARTS.map(({ part, label, hint }) => {
        const text = call[part] ?? ''
        return (
          <details key={part} className="nv-call-part" open={part === 'prompt' || part === 'reply'}>
            <summary title={t(...hint)}>
              <span className="nv-call-part-name">{t(...label)}</span>
              <span className="nv-muted nv-small">{text.length > 0 ? t(`${formatCount(text.length, locale)} 字`, `${formatCount(text.length, locale)} characters`) : t('没有', 'none')}</span>
              {text.length > 0 ? <button type="button" className="nv-link nv-small" onClick={(event) => { event.preventDefault(); copy(text) }}>{t('复制', 'Copy')}</button> : null}
            </summary>
            {text.length > 0 ? <pre className="nv-call-text">{text}</pre> : <p className="nv-muted nv-small">{part === 'reply' ? t('它什么都没说出来。', 'It said nothing.') : t('这一次没有这一部分。', 'This call had none.')}</p>}
          </details>
        )
      })}
    </div>
  )
}

/** One call, read whole. */
export function CallModal({ row, onClose }: { row: CallRow; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const read = useLoad(signal => controller.api.call('calls.read', { root, id: row.id }, signal), [root, row.id])
  const call = read.data?.call
  const whole = call !== undefined ? PARTS.map(({ part, label }) => `# ${t(...label)}\n\n${call[part] ?? ''}`).join('\n\n\n') : ''
  return (
    <Modal wide roomy="call" title={`${callWork(row, t)} · ${when(row)}`} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('模型看到的就是这些，按发送的顺序排；除此之外它什么都不知道。', 'This is all the model saw, in the order it was sent; it knew nothing else.')}</span>
        <span className="nv-spacer" />
        <Button variant="ghost" icon="copy" disabled={call === undefined} onClick={() => { void navigator.clipboard?.writeText(whole).then(() => { controller.toast('success', t('整条已复制', 'The whole call is copied')) }, () => {}) }}>{t('复制整条', 'Copy all of it')}</Button>
        <Button variant="primary" onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    )}>
      {call !== undefined ? <CallBody call={call} /> : read.error !== undefined ? <p className="nv-note is-warn">{read.error}</p> : <div className="nv-center"><Spinner /></div>}
    </Modal>
  )
}

/** Calls laid side by side: as many as were ticked, each with what it was sent and said. */
function CallsCompare({ rows, onClose }: { rows: readonly CallRow[]; onClose: () => void }) {
  const t = useT()
  const read = useCallTexts(rows.map(row => row.id))
  const items: CompareItem[] = rows.map((row) => {
    const got = read[row.id]
    return {
      key: row.id,
      title: `${callWork(row, t)} · ${when(row)}`,
      sub: setting(row, t),
      ...(got?.error !== undefined ? { error: got.error } : got?.call !== undefined ? { body: <CallBody call={got.call} /> } : { loading: true }),
    }
  })
  return (
    <Modal wide roomy="compare" className="nv-modal-trial nv-modal-compare" title={t(`并排看 ${rows.length} 次调用`, `${rows.length} calls, side by side`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('每一栏是一次调用：怎么设的、发了什么、回了什么。只比两次时，“看差在哪”更省眼睛。', 'A column a call: how it was set, what was sent, what came back. For two of them, "What differs" is easier on the eyes.')}</span>
        <span className="nv-spacer" />
        <Button variant="ghost" onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    )}>
      <Compare name="calls" base={420} items={items} />
    </Modal>
  )
}

/** Two calls read against each other: how each was set, and — part by part — what one was sent or said that the other was not. */
function CallsDiff({ rows, onClose }: { rows: readonly [CallRow, CallRow]; onClose: () => void }) {
  const { locale } = useStudio()
  const t = useT()
  // The earlier one first: what is red was there before, what is green came after.
  const [first, second] = [...rows].sort((left, right) => left.at.localeCompare(right.at)) as [CallRow, CallRow]
  const read = useCallTexts([first.id, second.id])
  const [part, setPart] = useState<Part>('prompt')
  const before = read[first.id]?.call
  const after = read[second.id]?.call
  const failed = read[first.id]?.error ?? read[second.id]?.error
  const same = (name: Part): boolean => before !== undefined && after !== undefined && (before[name] ?? '') === (after[name] ?? '')
  // How each was set — marked where the two were set otherwise — and, below those, how each went.
  const facts: [name: string, left: string, right: string, set?: true][] = [
    [t('模型', 'Model'), `${first.provider} / ${first.model}`, `${second.provider} / ${second.model}`, true],
    [t('思考档位', 'Reasoning'), first.effort ?? t('默认', 'default'), second.effort ?? t('默认', 'default'), true],
    [t('温度', 'Temperature'), first.temperature !== undefined ? String(first.temperature) : t('默认', 'default'), second.temperature !== undefined ? String(second.temperature) : t('默认', 'default'), true],
    [t('输出上限', 'Output limit'), first.maxTokens !== undefined ? String(first.maxTokens) : t('没有指定', 'not set'), second.maxTokens !== undefined ? String(second.maxTokens) : t('没有指定', 'not set'), true],
    [t('用量', 'Used'), amounts(first, locale, t), amounts(second, locale, t)],
    [t('用时', 'Took'), took(first.ms, t), took(second.ms, t)],
  ]
  return (
    <Modal wide roomy="call" title={t('两次调用差在哪', 'What differs between the two calls')} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('红色：前一次有、后一次没有的；绿色：后一次多出来的。没变的大段省略成 ⋯。', 'Red: in the earlier call and not in the later; green: only in the later. Long stretches that did not change are left out (⋯).')}</span>
        <span className="nv-spacer" />
        <Button variant="primary" onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    )}>
      <table className="nv-call-facts is-pair">
        <thead><tr><th /><th>{t('前一次', 'The earlier')} · {when(first)}</th><th>{t('后一次', 'The later')} · {when(second)}</th></tr></thead>
        <tbody>{facts.map(([name, left, right, set]) => <tr key={name} className={set === true && left !== right ? 'is-unlike' : undefined}><th>{name}</th><td>{left}</td><td>{right}</td></tr>)}</tbody>
      </table>
      <Tabs<Part> value={part} onChange={setPart} tabs={[PARTS[2]!, PARTS[1]!, PARTS[0]!, PARTS[3]!].map(item => ({ value: item.part, label: `${t(...item.label)}${before !== undefined && after !== undefined ? (same(item.part) ? t(' · 一样', ' · same') : t(' · 不一样', ' · differs')) : ''}` }))} />
      {failed !== undefined ? <p className="nv-note is-warn">{failed}</p>
        : before === undefined || after === undefined ? <div className="nv-center"><Spinner /></div>
          : same(part) ? <p className="nv-note">{(before[part] ?? '').length === 0 ? t('两次都没有这一部分。', 'Neither call had this part.') : t(`这一部分两次一字不差（${formatCount((before[part] ?? '').length, locale)} 字）。`, `This part is the same in both, to the letter (${formatCount((before[part] ?? '').length, locale)} characters).`)}</p>
            : <DiffView before={before[part] ?? ''} after={after[part] ?? ''} />}
    </Modal>
  )
}

/**
 * The calls on record, a row a call: pressed, a call is read whole; ticked, calls are laid side by side, two of them
 * read against each other, or taken off the record.
 * @param chapter - only this chapter's calls; left out, the whole book's.
 * @param onWhole - where the list is one chapter's: the way to the whole book's.
 */
export function CallsBrowser({ chapter, onWhole }: { chapter?: string | undefined; onWhole?: (() => void) | undefined }) {
  const { controller, locale } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const confirm = useConfirm()
  const { busy, run } = useAction()
  // A job that ended has left its calls: the list is read again.
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const ended = jobs.filter(job => job.status !== 'running').length
  const listed = useLoad(signal => controller.api.call('calls.list', { root, ...(chapter !== undefined ? { chapter } : {}) }, signal), [root, chapter, ended, project.revision])
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [viewing, setViewing] = useState<CallRow | undefined>()
  const [comparing, setComparing] = useState<CallRow[] | undefined>()
  const [differing, setDiffering] = useState<[CallRow, CallRow] | undefined>()
  const calls = listed.data?.calls ?? []
  const chosen = calls.filter(call => picked.has(call.id))
  const pick = (id: string): void => { setPicked((previous) => { const next = new Set(previous); if (!next.delete(id)) next.add(id); return next }) }
  const remove = (ids: string[] | undefined, ask: string): void => {
    confirm.ask(ask, () => void run(async () => {
      const done = await controller.api.call('calls.remove', { root, ...(ids !== undefined ? { ids } : {}) })
      setPicked(new Set())
      listed.reload()
      controller.toast('success', t(`删掉了 ${done.removed} 条调用记录`, `${done.removed} call(s) taken off the record`))
    }))
  }
  if (listed.data === undefined) {
    // A Host half older than this page keeps no record yet.
    if (listed.error !== undefined) return <p className="nv-note is-warn">{/unknown method/.test(listed.error) ? t('后台还是旧的，还不会记调用：重启 DSH 之后，从那时起的每次调用都会记在这里。', 'The Host half is older than this page and keeps no calls yet: restart DSH, and every call from then on is kept here.') : listed.error}</p>
    return <div className="nv-center"><Spinner /></div>
  }
  const off = listed.data.megabytes <= 0
  return (
    <div className="nv-calls">
      <div className="nv-versions-bar">
        {chosen.length === 0 ? <span className="nv-muted nv-small">{calls.length > 0 ? t('点一行看那次调用的全文；勾两条看它们差在哪，勾几条并排看。', 'Press a row to read that call whole; tick two to see what differs, or several to lay them side by side.') : ''}</span> : (
          <>
            <span className="nv-small">{t(`已选 ${chosen.length} 条`, `${chosen.length} picked`)}</span>
            <button type="button" className="nv-link nv-small" onClick={() => { setPicked(new Set()) }}>{t('清空', 'None')}</button>
            <span className="nv-spacer" />
            {chosen.length === 2 ? <Button size="sm" variant="primary" icon="search" title={t('两次交给模型的东西、它的回复，各差在哪', 'What the two were sent, and what each said: where they differ')} onClick={() => { setDiffering([chosen[0]!, chosen[1]!]) }}>{t('看差在哪', 'What differs')}</Button> : null}
            <Button size="sm" variant={chosen.length === 2 ? 'outline' : 'primary'} icon="layers" onClick={() => { setComparing(chosen) }}>{chosen.length === 1 ? t('单看这一条', 'Read it alone') : t(`并排看 ${chosen.length} 条`, `${chosen.length} side by side`)}</Button>
            <Button size="sm" variant="ghost" icon="trash" busy={busy} title={t('删除选中的记录', 'Take the calls picked off the record')} aria-label={t('删除选中的记录', 'Take the calls picked off the record')} onClick={() => { remove(chosen.map(call => call.id), t(`删除选中的 ${chosen.length} 条调用记录？删了找不回来。`, `Take the ${chosen.length} calls picked off the record? They cannot be brought back.`)) }} />
          </>
        )}
      </div>
      {off ? <p className="nv-note">{t('调用记录现在关着（设置里“调用记录留多少”是 0）：新的调用不会记下来。', 'The record of calls is off (the settings keep 0 MB of it): new calls are not kept.')}</p> : null}
      {calls.length === 0 ? (
        <p className="nv-muted nv-small">{chapter !== undefined
          ? t('这一章还没有调用记录。工坊每调一次文字模型——写作、续写、改写、收录、审校、推演——都会在这里留一条：交给它的全文、它的回复、用的模型和温度。策划、场记这些角色自己一步步干的活不在这里，在“任务”里点开它那场对话看。', 'No call is on record for this chapter yet. Every call the Studio makes to a text model — writing, continuing, rewriting, memory, reviews, plans — leaves one here: all that was sent, the reply, the model and its temperature. What a role works out step by step as an agent is not here: open its conversation from Jobs.')
          : t('这本书还没有调用记录。工坊每调一次文字模型都会在这里留一条：交给它的全文、它的回复、用的模型和温度。', 'No call is on record for this book yet. Every call the Studio makes to a text model leaves one here: all that was sent, the reply, the model and its temperature.')}</p>
      ) : (
        <ul className="nv-list nv-versions nv-call-list">
          {calls.map(call => (
            <li key={call.id} className="nv-version">
              <label className="nv-version-pick" title={t('勾上：并排看、看差别，或删除', 'Tick: to lay side by side, to see what differs, or to delete')}>
                <input type="checkbox" checked={picked.has(call.id)} onChange={() => { pick(call.id) }} />
              </label>
              <button type="button" className="nv-list-row" onClick={() => { setViewing(call) }}>
                <span className="nv-person-text">
                  <span className="nv-list-title">{callWork(call, t)}{chapter === undefined && (chapterName(project, call.chapter, t) ?? call.target) !== undefined ? ` · ${chapterName(project, call.chapter, t) ?? call.target}` : ''} {ending(call, t)}</span>
                  <span className="nv-list-meta">{when(call)} · {t(...(ROLE[call.role] ?? [call.role, call.role]))} · {setting(call, t)}</span>
                  <span className="nv-list-meta">{amounts(call, locale, t)} · {took(call.ms, t)}</span>
                </span>
                <Icon name="chevronRight" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="nv-calls-foot nv-muted nv-small">
        <span>{t(`全书共 ${listed.data.total} 条 · ${megabytes(listed.data.bytes)}${off ? '' : `（最多留 ${listed.data.megabytes} MB，满了先去掉最早的）`}`, `${listed.data.total} on record for the book · ${megabytes(listed.data.bytes)}${off ? '' : ` (${listed.data.megabytes} MB at most; the oldest go first)`}`)}</span>
        <button type="button" className="nv-link" onClick={() => { listed.reload() }}>{t('刷新', 'Refresh')}</button>
        {onWhole !== undefined ? <button type="button" className="nv-link" onClick={onWhole}>{t('全书的调用记录…', 'The whole book\'s calls…')}</button> : null}
        <button type="button" className="nv-link" onClick={() => { controller.openSettings('auto') }}>{t('留多少…', 'How much is kept…')}</button>
        {listed.data.total > 0 && chapter === undefined ? <button type="button" className="nv-link" onClick={() => { remove(undefined, t(`清空这本书全部 ${listed.data!.total} 条调用记录？删了找不回来。`, `Take all ${listed.data!.total} calls of this book off the record? They cannot be brought back.`)) }}>{t('清空…', 'Clear all…')}</button> : null}
      </div>
      {viewing !== undefined ? <CallModal row={viewing} onClose={() => { setViewing(undefined) }} /> : null}
      {comparing !== undefined ? <CallsCompare rows={comparing} onClose={() => { setComparing(undefined) }} /> : null}
      {differing !== undefined ? <CallsDiff rows={differing} onClose={() => { setDiffering(undefined) }} /> : null}
      {confirm.element}
    </div>
  )
}

/** The whole book's record of calls, in a dialog. */
export function CallsDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  return (
    <Modal wide title={t('调用记录 · 这本书', 'The record of calls · this book')} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('记在书自己的目录里（.novel/calls）；加密的书，记录跟着一起加密。', 'Kept in the book\'s own folder (.novel/calls); a sealed book\'s record is sealed with it.')}</span>
        <span className="nv-spacer" />
        <Button variant="primary" onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    )}>
      <CallsBrowser />
    </Modal>
  )
}

/** The calls made for the chapter in hand, in the panel beside its text. */
export function CallsPanel({ chapter }: { chapter: string }) {
  const [whole, setWhole] = useState(false)
  return (
    <div className="nv-panel-section">
      <CallsBrowser chapter={chapter} onWhole={() => { setWhole(true) }} />
      {whole ? <CallsDialog onClose={() => { setWhole(false) }} /> : null}
    </div>
  )
}

/**
 * How much of the record a book keeps, where the Studio's settings are set: megabytes, the oldest calls going first.
 * @param value - the author's figure; undefined where none is set ({@link CALLS_MB_DEFAULT} then holds).
 */
export function CallsKept({ value, onChange }: { value: number | undefined; onChange: (value: number | undefined) => void }) {
  const t = useT()
  return (
    <Field
      label={t('调用记录留多少（MB，每本书）', 'How much of the record of calls is kept (MB, a book)')}
      hint={t('工坊每调一次文字模型，都把交给它的全文和它的回复记在书自己的目录里：写作页右侧的“调用”、“任务”和“用量”里的“调用记录”可以翻、可以并排比。满了先去掉最早的；填 0 就不记。', 'Every call the Studio makes to a text model is kept in the book\'s own folder with all that was sent and said: read and compared under "Calls" beside a chapter, and from Jobs and Usage. When it is full the oldest go first; 0 keeps none.')}
    >
      <TextInput
        inputMode="numeric"
        value={value !== undefined ? String(value) : ''}
        placeholder={String(CALLS_MB_DEFAULT)}
        onChange={(event) => {
          const text = event.target.value.replace(/\D/g, '').slice(0, 5)
          onChange(text.length > 0 ? Number(text) : undefined)
        }}
      />
    </Field>
  )
}

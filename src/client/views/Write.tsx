// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The manuscript editor: a chapter list, the text, and a side panel with the
 * chapter's plan, memory, review issues, versions and pending proposals.
 * Select text to revise, illustrate or discuss exactly that passage.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChapterDocument } from '../../shared/rpc'
import { countWords, formatCount, fuzzyFind, normalizeProse, proseOnly } from '../../shared/text'
import type { ChapterInfo, JobInfo, ReviewIssue, VersionInfo } from '../../shared/types'
import { DiffView, ProposalCard } from '../components/ProposalCard'
import { Icon } from '../icons'
import { jobKindLabel, jobPulse } from '../Studio'
import { CHAPTER_STATUS, CHAPTER_STATUS_TONE, ISSUE_TYPE, SEVERITY, SEVERITY_TONE } from '../labels'
import {
  Button, Chip, cx, Empty, Menu, Modal, Progress, Select, Spinner, Tabs, TextInput, ThoughtButton, ThoughtPanel, useAction, useConfirm, useJobStream, useJobTail, useLoad, useProject,
  useQuote, useSnapshot, useStudio, useT, useWidth, type Translate,
} from '../ui'

type PanelTab = 'plan' | 'memory' | 'issues' | 'versions' | 'proposals'

const PRESETS: { id: string; label: [string, string]; instruction: [string, string] }[] = [
  { id: 'polish', label: ['润色', 'Polish'], instruction: ['润色这段文字：情节、信息与人物语气都不变，改善用词、节奏与画面感，去掉陈词滥调。', 'Polish this passage: keep the events, information and voices; improve diction, rhythm and imagery; remove clichés.'] },
  { id: 'expand', label: ['扩写', 'Expand'], instruction: ['扩写这段：补足动作、感官细节与人物的内心反应，不引入新的情节事实。', 'Expand this passage with action, sensory detail and inner reaction; introduce no new plot facts.'] },
  { id: 'tighten', label: ['精简', 'Tighten'], instruction: ['精简这段：删去重复与空话，保留全部情节信息，篇幅压到原来的一半到三分之二。', 'Tighten this passage: cut repetition and filler, keep every plot fact, land at half to two thirds of the length.'] },
  { id: 'dialogue', label: ['磨对白', 'Sharpen dialogue'], instruction: ['让对白更贴合每个人物的说话习惯，少一些解释性台词，多一些潜台词。', 'Make the dialogue truer to each speaker; less exposition in speech, more subtext.'] },
  { id: 'show', label: ['少说多演', 'Show, not tell'], instruction: ['把直接陈述的情绪和结论改成可见的动作、细节与反应。', 'Turn stated emotions and conclusions into visible action, detail and reaction.'] },
]

function versionReason(reason: string, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    'edit': ['手动编辑前', 'before an edit'],
    'before-revise': ['修订前', 'before a revision'],
    'before-redraft': ['重新起草前', 'before a redraft'],
    'before-continue': ['续写前', 'before continuing'],
    'before-restore': ['恢复版本前', 'before a restore'],
    'before-import': ['导入前', 'before an import'],
    'before-remove': ['删除章节前', 'before removal'],
    'manual': ['手动存档', 'manual'],
    'agent-edit': ['总编亲手改动前', 'before an edit by the showrunner'],
    'edit-device': ['在其他设备上改动前', 'before an edit from another device'],
  }
  const label = labels[reason]
  return label !== undefined ? t(...label) : reason
}

/**
 * Scroll a textarea so the character at `offset` is in view. A textarea cannot
 * report where a character sits, so the text before it is measured: collapsed
 * to no height of its own, the box's scroll height is exactly that text.
 */
function scrollToOffset(element: HTMLTextAreaElement, offset: number): void {
  const full = element.value
  const { flex, height, paddingBottom } = element.style
  element.style.flex = 'none'
  element.style.height = '0px'
  element.style.paddingBottom = '0px'
  element.value = full.slice(0, offset)
  const top = element.scrollHeight
  element.value = full
  element.style.flex = flex
  element.style.height = height
  element.style.paddingBottom = paddingBottom
  element.scrollTop = Math.max(0, top - element.clientHeight / 2)
}

function jobsOf(jobs: JobInfo[], chapterId: string): JobInfo[] {
  return jobs.filter(job => job.status === 'running' && (job.target === chapterId || job.result?.chapterId === chapterId))
}

export function WriteView() {
  const { controller, locale } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const chapterId = useSnapshot(snapshot => snapshot.chapterId)
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const [setNode, width] = useWidth<HTMLDivElement>()
  const wide = width >= 1080
  const medium = width >= 720
  const [panelOpen, setPanelOpen] = useState(false)
  const [panel, setPanel] = useState<PanelTab>('plan')
  const chapter = project.chapters.find(candidate => candidate.id === chapterId) ?? project.chapters[0]
  const { run } = useAction()

  if (chapter === undefined) {
    return (
      <div className="nv-page">
        <Empty icon="pen" title={t('还没有章节', 'No chapters yet')}>
          <p>{t('先在大纲里排出章节，或者让总编帮你推演开篇。', 'Outline some chapters first, or ask the showrunner to derive the opening.')}</p>
          <Button variant="primary" icon="tree" onClick={() => { controller.setView('outline') }}>{t('去大纲', 'Open Outline')}</Button>
        </Empty>
      </div>
    )
  }

  const addChapter = (): Promise<unknown> => run(async () => {
    const { results } = await controller.api.call('outline.apply', { root, ops: [{ op: 'add-chapter', title: t('新章节', 'New chapter') }] })
    const id = results[0]?.id
    if (id !== undefined) controller.focusChapter(id)
  })

  const list = (
    <aside className="nv-write-list">
      <ul className="nv-list">
        {project.chapters.map((item) => {
          const busy = jobsOf(jobs, item.id).length > 0
          return (
            <li key={item.id}>
              <button type="button" className={cx('nv-list-row', item.id === chapter.id && 'is-active')} onClick={() => { controller.focusChapter(item.id) }} title={item.title}>
                <span className="nv-list-index">{item.index}</span>
                <span className="nv-person-text">
                  <span className="nv-list-title">{item.title}</span>
                  <span className="nv-list-meta">{item.hasText ? `${formatCount(item.words, locale)}${t(' 字', ' words')}` : t(...CHAPTER_STATUS[item.status])}{item.hasText && !item.digested ? t(' · 未收录', ' · undigested') : ''}</span>
                </span>
                {busy ? <Spinner size={12} /> : <span className={cx('nv-dot', `is-${item.status}`)} />}
              </button>
            </li>
          )
        })}
      </ul>
      <button type="button" className="nv-add-row" onClick={addChapter}>+ {t('添加章节', 'Add chapter')}</button>
    </aside>
  )

  return (
    <div ref={setNode} className={cx('nv-write', wide && 'is-wide', medium && 'is-medium')}>
      {wide ? list : null}
      <ChapterEditor
        key={chapter.id}
        chapter={chapter}
        compact={!wide}
        panel={panel}
        setPanel={setPanel}
        panelInline={medium}
        panelOpen={panelOpen}
        setPanelOpen={setPanelOpen}
      />
    </div>
  )
}

interface EditorProps {
  chapter: ChapterInfo
  /** No chapter list beside the editor: offer a chapter picker in the toolbar. */
  compact: boolean
  panel: PanelTab
  setPanel: (tab: PanelTab) => void
  /** The side panel sits beside the editor (otherwise it opens as an overlay). */
  panelInline: boolean
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
}

function ChapterEditor({ chapter, compact, panel, setPanel, panelInline, panelOpen, setPanelOpen }: EditorProps) {
  const { controller, locale } = useStudio()
  const t = useT()
  const quote = useQuote()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const jump = useSnapshot(snapshot => snapshot.jump)
  const revision = project.revision
  const doc = useLoad<ChapterDocument>(signal => controller.api.call('chapter.read', { root, id: chapter.id }, signal), [root, chapter.id, revision])
  const [text, setText] = useState<string | undefined>()
  const baseline = useRef<string | undefined>(undefined)
  const [external, setExternal] = useState<string | undefined>()
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved')
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>()
  const [brief, setBrief] = useState('')
  const [custom, setCustom] = useState<string | undefined>()
  const [viewing, setViewing] = useState<VersionInfo | undefined>()
  const [appending, setAppending] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const live = useRef<HTMLDivElement>(null)
  const confirm = useConfirm()
  const textRef = useRef<string | undefined>(undefined)
  textRef.current = text

  // ── keep the local text in step with the Host ──
  useEffect(() => {
    const loaded = doc.data
    if (loaded === undefined) return
    if (baseline.current === undefined || textRef.current === undefined) {
      baseline.current = loaded.text
      setText(loaded.text)
      return
    }
    // The Host stores normalized prose; our own save coming back is not a change.
    if (loaded.text === baseline.current || loaded.text === normalizeProse(baseline.current)) return
    if (textRef.current === baseline.current) {
      baseline.current = loaded.text
      setText(loaded.text)
      // Offsets of a selection made in the old text mean nothing in the new one.
      setSelection(undefined)
    } else if (normalizeProse(textRef.current) !== loaded.text) {
      // Someone else (the agent, an accepted proposal) changed the chapter while this copy has unsaved edits.
      setExternal(loaded.text)
    }
  }, [doc.data])

  const save = useCallback(async (): Promise<boolean> => {
    const current = textRef.current
    if (current === undefined || current === baseline.current) return true
    setSaveState('saving')
    try {
      await controller.api.call('chapter.save', { root, id: chapter.id, text: current })
      baseline.current = current
      setSaveState(textRef.current === current ? 'saved' : 'dirty')
      return true
    } catch (error) {
      setSaveState('dirty')
      controller.toast('error', error instanceof Error ? error.message : String(error))
      return false
    }
  }, [controller, root, chapter.id])

  // Autosave a little after typing stops, and when leaving the chapter.
  useEffect(() => {
    if (text === undefined || text === baseline.current || external !== undefined) return
    setSaveState('dirty')
    const timer = setTimeout(() => { void save() }, 1500)
    return () => { clearTimeout(timer) }
  }, [text, save, external])
  useEffect(() => () => { void save() }, [save])

  // ── jobs touching this chapter ──
  const running = jobsOf(jobs, chapter.id)
  const writing = running.find(job => job.kind === 'write')
  const revising = running.find(job => job.kind === 'revise')
  const { text: stream, thought } = useJobTail(writing?.id)
  const reviseStream = useJobStream(revising?.id)
  useEffect(() => {
    const element = live.current
    if (element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 240) element.scrollTop = element.scrollHeight
  }, [stream])
  useEffect(() => { if (writing === undefined) setAppending(false) }, [writing])

  // ── jump to a place (search hit, review quote) ──
  useEffect(() => {
    if (jump === undefined || jump.chapterId !== chapter.id || text === undefined) return
    const element = area.current
    if (element === null) return
    const start = Math.min(jump.offset, text.length)
    const end = Math.min(start + jump.length, text.length)
    // Measuring swaps the value for a moment, which drops the selection: scroll first, select after.
    scrollToOffset(element, start)
    element.focus({ preventScroll: true })
    element.setSelectionRange(start, end)
    setSelection(end > start ? { start, end } : undefined)
    controller.consumeJump(jump.nonce)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce, text === undefined])

  const words = useMemo(() => countWords(proseOnly(text ?? '')), [text])
  const selected = selection !== undefined && text !== undefined ? text.slice(selection.start, selection.end) : ''
  const proposals = project.proposals.filter(proposal => proposal.chapterId === chapter.id)
  const openIssues = (doc.data?.review?.issues ?? []).filter(issue => issue.resolved !== true)
  const plan = doc.data?.plan
  const empty = (text ?? '').trim().length === 0

  const showPanel = (tab: PanelTab): void => {
    setPanel(tab)
    setPanelOpen(true)
  }

  /** Make sure the Host has this text before a model works on it. */
  const settle = async (): Promise<boolean> => {
    if (external !== undefined) {
      controller.toast('info', t('正文已在别处更新，请先选择保留哪一份。', 'The chapter changed elsewhere — choose which copy to keep first.'))
      return false
    }
    return await save()
  }

  const write = (mode: 'draft' | 'continue'): Promise<unknown> => controller.guard(async () => {
    if (!(await settle())) return
    setAppending(mode === 'continue')
    await controller.api.call('ai.write', { root, chapter: chapter.id, mode, ...(brief.trim().length > 0 ? { brief: brief.trim() } : {}) })
    await controller.refreshJobs()
    setBrief('')
  })
  const reviseChapter = (): Promise<unknown> | undefined => {
    const instruction = brief.trim()
    if (instruction.length === 0) {
      controller.toast('info', t('先在上面的输入框里写下要怎么改。', 'Say how to change the chapter in the box above first.'))
      return undefined
    }
    return controller.guard(async () => {
      if (!(await settle())) return undefined
      showPanel('proposals')
      await controller.api.call('ai.reviseChapter', { root, chapter: chapter.id, instruction })
      await controller.refreshJobs()
      setBrief('')
    })
  }
  const reviseSelection = (instruction: string): Promise<unknown> | undefined => {
    if (selection === undefined || text === undefined) return undefined
    const raw = text.slice(selection.start, selection.end)
    const quote = raw.trim()
    if (quote.length === 0) return undefined
    return controller.guard(async () => {
      if (!(await settle())) return undefined
      showPanel('proposals')
      setCustom(undefined)
      await controller.api.call('ai.reviseSpan', { root, chapter: chapter.id, start: selection.start + raw.indexOf(quote), end: selection.start + raw.indexOf(quote) + quote.length, quote, instruction })
      await controller.refreshJobs()
    })
  }
  const illustrateSelection = (): Promise<unknown> | undefined => {
    const quote = selected.trim()
    if (quote.length === 0) return undefined
    return controller.guard(async () => {
      if (!(await settle())) return undefined
      controller.toast('info', t('正在为这段文字配图，完成后会插入到这段之后。', 'Illustrating this passage; the picture is inserted after it when ready.'))
      await controller.run('image.create', { root, kind: 'scene', target: chapter.id, quote, insert: true })
    })
  }
  const quoteSelection = (): void => {
    const passage = selected.trim()
    if (passage.length === 0 || quote === undefined) return
    quote(t(`关于第 ${chapter.index} 章《${chapter.title}》里的这段：\n「${passage}」\n`, `About this passage in chapter ${chapter.index}, "${chapter.title}":\n"${passage}"\n`))
  }
  const locate = (quote: string): void => {
    if (text === undefined) return
    const range = fuzzyFind(text, quote.trim())
    if (range === undefined) {
      controller.toast('info', t('这段引文已不在正文里（可能已被修改）。', 'That quote is no longer in the text (it may have been revised).'))
      return
    }
    controller.jumpTo(chapter.id, range.start, range.end - range.start)
  }
  const fixIssue = (issue: ReviewIssue): Promise<unknown> | undefined => {
    if (text === undefined || issue.quote === undefined) return undefined
    const range = fuzzyFind(text, issue.quote.trim())
    if (range === undefined) {
      controller.toast('info', t('这段引文已不在正文里。', 'That quote is no longer in the text.'))
      return undefined
    }
    return controller.guard(async () => {
      if (!(await settle())) return undefined
      showPanel('proposals')
      await controller.api.call('ai.reviseSpan', {
        root, chapter: chapter.id, start: range.start, end: range.end, quote: text.slice(range.start, range.end),
        instruction: t(`修正这个问题：${issue.explanation}${issue.suggestion !== undefined ? `\n建议：${issue.suggestion}` : ''}`, `Fix this problem: ${issue.explanation}${issue.suggestion !== undefined ? `\nSuggestion: ${issue.suggestion}` : ''}`),
      })
      await controller.refreshJobs()
    })
  }

  if (doc.data === undefined || text === undefined) {
    return <div className="nv-write-main"><div className="nv-center">{doc.error !== undefined ? <Empty icon="alert" title={doc.error} /> : <Spinner size={18} />}</div></div>
  }

  const side = (
    <aside className={cx('nv-write-panel', !panelInline && 'is-overlay')}>
      <div className="nv-panel-head">
        <Tabs
          value={panel}
          onChange={setPanel}
          className="nv-tabs-compact"
          tabs={[
            { value: 'plan', label: t('章纲', 'Plan') },
            { value: 'memory', label: t('记忆', 'Memory') },
            { value: 'issues', label: t('问题', 'Issues'), badge: openIssues.length },
            { value: 'proposals', label: t('提案', 'Proposals'), badge: proposals.length },
            { value: 'versions', label: t('版本', 'Versions') },
          ]}
        />
        {!panelInline ? <Button variant="ghost" size="sm" icon="x" onClick={() => { setPanelOpen(false) }} /> : null}
      </div>
      <div className="nv-panel-body">
        {panel === 'plan' && plan !== undefined ? (
          <div className="nv-panel-section">
            {plan.synopsis !== undefined ? <p>{plan.synopsis}</p> : <p className="nv-muted">{t('这一章还没有梗概。', 'No synopsis for this chapter yet.')}</p>}
            {plan.purpose !== undefined ? <p className="nv-muted nv-small">{t('作用：', 'Purpose: ')}{plan.purpose}</p> : null}
            <p className="nv-muted nv-small">{[plan.pov !== undefined ? `${t('视角', 'POV')} ${project.characters.find(card => card.id === plan.pov)?.name ?? plan.pov}` : undefined, plan.location, plan.time].filter(Boolean).join(' · ')}</p>
            {(plan.beats ?? []).length > 0 ? <ol className="nv-derived-beats">{plan.beats!.map(beat => <li key={beat.id}>{beat.summary}{beat.outcome !== undefined ? <span className="nv-muted"> → {beat.outcome}</span> : null}</li>)}</ol> : null}
            <div className="nv-chips">
              {(plan.characters ?? []).map(ref => <Chip key={ref} tone="blue">{project.characters.find(card => card.id === ref)?.name ?? ref}</Chip>)}
              {(plan.threads ?? []).map(ref => <Chip key={ref} tone="amber">{project.outline.threads.find(thread => thread.id === ref)?.title ?? ref}</Chip>)}
            </div>
            {plan.notes !== undefined ? <p className="nv-note">{plan.notes}</p> : null}
            <Button size="sm" icon="tree" onClick={() => { controller.setView('outline', chapter.id) }}>{t('编辑章纲', 'Edit the plan')}</Button>
          </div>
        ) : null}

        {panel === 'memory' ? (
          <div className="nv-panel-section">
            {!chapter.digested && chapter.hasText ? (
              <div className="nv-banner">
                <span>{doc.data.memory !== undefined ? t('正文改过了，记忆已过期。', 'The text changed since this memory was taken.') : t('这一章还没有收录记忆。', 'This chapter has not been digested yet.')}</span>
                <Button size="sm" icon="layers" busy={running.some(job => job.kind === 'digest')} onClick={() => controller.guard(async () => { if (await settle()) { await controller.api.call('ai.digest', { root, chapters: [chapter.id], force: true }); await controller.refreshJobs() } })}>{t('收录', 'Digest')}</Button>
              </div>
            ) : null}
            {doc.data.memory !== undefined ? (
              <>
                <p><strong>{doc.data.memory.brief}</strong></p>
                <p>{doc.data.memory.summary}</p>
                <p className="nv-muted nv-small">{[doc.data.memory.storyTime, ...(doc.data.memory.locations ?? [])].filter(Boolean).join(' · ')}</p>
                {doc.data.memory.characters.length > 0 ? <h5>{t('人物状态', 'Characters')}</h5> : null}
                <ul className="nv-plain-list">
                  {doc.data.memory.characters.map((moment, index) => (
                    <li key={index}><strong>{moment.name}</strong>{moment.lifecycle !== undefined ? <Chip tone="violet">{moment.lifecycle}</Chip> : null} {moment.role}{moment.stateAfter !== undefined ? <span className="nv-muted"> — {moment.stateAfter}</span> : null}</li>
                  ))}
                </ul>
                {doc.data.memory.facts.length > 0 ? <h5>{t('确立的事实', 'Established facts')}</h5> : null}
                <ul className="nv-plain-list">{doc.data.memory.facts.map((fact, index) => <li key={index}><span className="nv-muted">{fact.subject}：</span>{fact.statement}</li>)}</ul>
                {doc.data.memory.threads.length > 0 ? <h5>{t('线索', 'Threads')}</h5> : null}
                <ul className="nv-plain-list">{doc.data.memory.threads.map((touch, index) => <li key={index}><Chip tone="amber">{touch.action === 'plant' ? t('埋', 'plant') : touch.action === 'payoff' ? t('收', 'pay off') : t('推', 'advance')}</Chip> {touch.title}{touch.note !== undefined ? <span className="nv-muted"> — {touch.note}</span> : null}</li>)}</ul>
                {(doc.data.memory.openQuestions ?? []).length > 0 ? <h5>{t('读者的疑问', 'Open questions')}</h5> : null}
                <ul className="nv-plain-list">{(doc.data.memory.openQuestions ?? []).map((question, index) => <li key={index}>{question}</li>)}</ul>
              </>
            ) : <p className="nv-muted">{t('收录后，这里会列出本章的摘要、人物状态、确立的事实与牵动的线索——后续章节靠它们保持连贯。', 'After digesting, this lists the summary, character states, established facts and threads — what later chapters rely on to stay consistent.')}</p>}
          </div>
        ) : null}

        {panel === 'issues' ? (
          <div className="nv-panel-section">
            <div className="nv-row">
              <Button size="sm" icon="checkCircle" busy={running.some(job => job.kind === 'review')} disabled={empty} onClick={() => controller.guard(async () => { if (await settle()) { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() } })}>{doc.data.review !== undefined ? t('重新审校', 'Review again') : t('审校这一章', 'Review this chapter')}</Button>
            </div>
            {doc.data.review !== undefined ? <p className="nv-note">{doc.data.review.verdict}</p> : <p className="nv-muted">{t('审校会对照设定、记忆与文风检查这一章：连贯、人物、时间线、逻辑、节奏与语言。', 'A review checks this chapter against the bible, memory and style: continuity, character, timeline, logic, pacing and language.')}</p>}
            {(doc.data.review?.issues ?? []).map(issue => (
              <article key={issue.id} className={cx('nv-issue', issue.resolved === true && 'is-resolved')}>
                <header>
                  <Chip tone={SEVERITY_TONE[issue.severity]}>{t(...SEVERITY[issue.severity])}</Chip>
                  <Chip>{t(...ISSUE_TYPE[issue.type])}</Chip>
                </header>
                {issue.quote !== undefined ? <button type="button" className="nv-issue-quote" onClick={() => { locate(issue.quote!) }} title={t('在正文中定位', 'Locate in the text')}>{issue.quote}</button> : null}
                <p>{issue.explanation}</p>
                {issue.suggestion !== undefined ? <p className="nv-muted nv-small">{t('建议：', 'Suggestion: ')}{issue.suggestion}</p> : null}
                <footer>
                  {issue.quote !== undefined && issue.resolved !== true ? <Button size="sm" icon="wand" onClick={() => { fixIssue(issue) }}>{t('让 AI 修', 'Fix with AI')}</Button> : null}
                  <Button size="sm" variant="ghost" icon={issue.resolved === true ? 'undo' : 'check'} onClick={() => controller.guard(async () => { await controller.api.call('review.resolve', { root, chapter: chapter.id, issue: issue.id, resolved: issue.resolved !== true }); doc.reload() })}>{issue.resolved === true ? t('重新打开', 'Reopen') : t('已解决', 'Resolved')}</Button>
                </footer>
              </article>
            ))}
          </div>
        ) : null}

        {panel === 'proposals' ? (
          <div className="nv-panel-section">
            {revising !== undefined ? (
              <div className="nv-live-proposal">
                <div className="nv-row"><Spinner size={12} /><span>{jobPulse(revising, t) ?? t('写手正在改写…', 'The writer is revising…')}</span><span className="nv-spacer" /><Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(revising.id) }}>{t('停止', 'Stop')}</Button></div>
                {reviseStream.length > 0 ? <div className="nv-prose nv-prose-small">{reviseStream.split('\n').filter(line => line.trim().length > 0).slice(-12).map((line, index) => <p key={index}>{line}</p>)}</div> : null}
              </div>
            ) : null}
            {proposals.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} />)}
            {proposals.length === 0 && revising === undefined ? <p className="nv-muted">{t('在正文里选中一段文字，就可以让写手润色、扩写、精简或按你的要求改写。改动先作为提案放在这里，由你对比后决定采纳还是放弃。', 'Select a passage in the text to have the writer polish, expand, tighten or rewrite it your way. Changes land here as proposals; compare, then accept or reject.')}</p> : null}
          </div>
        ) : null}

        {panel === 'versions' ? (
          <div className="nv-panel-section">
            {doc.data.versions.length === 0 ? <p className="nv-muted">{t('每次 AI 写作、修订或恢复之前都会自动存一份历史版本。', 'A version is saved automatically before every AI draft, revision or restore.')}</p> : (
              <ul className="nv-list">
                {doc.data.versions.map(version => (
                  <li key={version.id}>
                    <button type="button" className="nv-list-row" onClick={() => { setViewing(version) }}>
                      <span className="nv-person-text">
                        <span className="nv-list-title">{new Date(version.createdAt).toLocaleString()}</span>
                        <span className="nv-list-meta">{versionReason(version.reason, t)} · {formatCount(version.words, locale)}{t(' 字', ' words')}</span>
                      </span>
                      <Icon name="chevronRight" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  )

  return (
    <>
      <section className="nv-write-main">
        <header className="nv-write-toolbar">
          {compact ? (
            <Select className="nv-chapter-select" value={chapter.id} options={project.chapters.map(item => ({ value: item.id, label: `${item.index}. ${item.title}` }))} onChange={(value) => { controller.focusChapter(value) }} />
          ) : <h2 className="nv-write-title"><span className="nv-muted">{chapter.index}</span> {chapter.title}</h2>}
          <Chip tone={CHAPTER_STATUS_TONE[chapter.status]}>{t(...CHAPTER_STATUS[chapter.status])}</Chip>
          <span className="nv-muted nv-small">{formatCount(words, locale)}{t(' 字', ' words')}</span>
          <span className={cx('nv-save-state', `is-${saveState}`)}>{saveState === 'saving' ? t('保存中…', 'Saving…') : saveState === 'dirty' ? t('未保存', 'Unsaved') : t('已保存', 'Saved')}</span>
          <span className="nv-spacer" />
          <Button size="sm" variant="ghost" icon="eye" title={t('阅读模式', 'Read')} onClick={() => { void save(); controller.setView('read', chapter.id) }} />
          {!panelInline ? <Button size="sm" variant="ghost" icon="list" title={t('章纲 / 记忆 / 问题', 'Plan / memory / issues')} onClick={() => { setPanelOpen(true) }}>{proposals.length + openIssues.length > 0 ? String(proposals.length + openIssues.length) : undefined}</Button> : null}
        </header>

        {selection !== undefined && selected.trim().length > 0 && writing === undefined ? (
          <div className="nv-selection-bar">
            <span className="nv-selection-count">{t(`已选 ${countWords(selected)} 字`, `${countWords(selected)} words selected`)}</span>
            {custom === undefined ? (
              <>
                {PRESETS.map(preset => <Button key={preset.id} size="sm" onClick={() => { reviseSelection(t(...preset.instruction)) }}>{t(...preset.label)}</Button>)}
                <Button size="sm" icon="pen" onClick={() => { setCustom('') }}>{t('按要求改…', 'Rewrite as…')}</Button>
                <Button size="sm" icon="image" onClick={illustrateSelection}>{t('配图', 'Illustrate')}</Button>
                {quote !== undefined ? <Button size="sm" icon="quote" onClick={quoteSelection}>{t('和总编讨论', 'Discuss')}</Button> : null}
              </>
            ) : (
              <>
                <TextInput autoFocus className="nv-grow" value={custom} placeholder={t('这段要怎么改？回车发送', 'How should this passage change? Enter to send')} onChange={(event) => { setCustom(event.target.value) }} onKeyDown={(event) => {
                  if (event.key === 'Enter' && custom.trim().length > 0) reviseSelection(custom.trim())
                  if (event.key === 'Escape') setCustom(undefined)
                }} />
                <Button size="sm" variant="primary" disabled={custom.trim().length === 0} onClick={() => { reviseSelection(custom.trim()) }}>{t('改写', 'Rewrite')}</Button>
                <Button size="sm" variant="ghost" icon="x" onClick={() => { setCustom(undefined) }} />
              </>
            )}
          </div>
        ) : (
          <div className="nv-brief-bar">
            <TextInput className="nv-grow" value={brief} placeholder={empty ? t('给写手的要求（可留空，直接按章纲写）', 'A brief for the writer (optional — the plan is used as is)') : t('给写手的要求：续写的方向，或整章要怎么改', 'A brief: where to continue, or how the chapter should change')} onChange={(event) => { setBrief(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && writing === undefined) write(empty ? 'draft' : 'continue') }} />
            {writing !== undefined
              ? <Button variant="danger" icon="stop" onClick={() => { void controller.cancelJob(writing.id) }}>{t('停止', 'Stop')}</Button>
              : <Button variant="primary" icon="feather" onClick={() => { write(empty ? 'draft' : 'continue') }}>{empty ? t('写这一章', 'Write it') : t('续写', 'Continue')}</Button>}
            {!empty && writing === undefined ? (
              <Menu icon="chevronDown" variant="outline" size="md" align="end" items={[
                { label: t('按要求修改整章（生成提案）', 'Revise the whole chapter (as a proposal)'), icon: 'wand', onSelect: reviseChapter },
                { label: t('从头重新起草（旧稿存入版本）', 'Redraft from the top (old text is versioned)'), icon: 'refresh', onSelect: () => { confirm.ask(t('重新起草会用新稿替换这一章现有的正文（旧稿会存入"版本"）。继续？', 'Redrafting replaces the current text of this chapter (the old text goes to Versions). Continue?'), () => { write('draft') }) } },
                'separator',
                { label: t('审校这一章', 'Review this chapter'), icon: 'checkCircle', onSelect: () => { showPanel('issues'); void controller.guard(async () => { if (await settle()) { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() } }) } },
                { label: t('收录记忆', 'Digest'), icon: 'layers', onSelect: () => { showPanel('memory'); void controller.guard(async () => { if (await settle()) { await controller.api.call('ai.digest', { root, chapters: [chapter.id], force: true }); await controller.refreshJobs() } }) } },
              ]} />
            ) : null}
          </div>
        )}

        {running.filter(job => job.kind !== 'write').map(job => (
          <div key={job.id} className="nv-activity">
            <Spinner size={12} />
            <span>{jobKindLabel(job.kind, t)}{t('中…', '…')}</span>
            {job.progress !== undefined && job.progress.total > 1 ? <Progress done={job.progress.done} total={job.progress.total} label={jobPulse(job, t)} /> : job.thinking !== undefined ? <span className="nv-muted">{jobPulse(job, t)}</span> : null}
            <ThoughtButton job={job} label />
            <span className="nv-spacer" />
            <Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(job.id) }} />
          </div>
        ))}

        {external !== undefined ? (
          <div className="nv-banner is-warn">
            <span>{t('这一章在别处被更新了（总编或已采纳的提案），而这里还有未保存的修改。', 'This chapter was changed elsewhere (the agent or an accepted proposal) while this copy has unsaved edits.')}</span>
            <Button size="sm" onClick={() => { baseline.current = external; setText(external); setExternal(undefined); setSaveState('saved') }}>{t('载入最新', 'Load the latest')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { baseline.current = external; setExternal(undefined) }}>{t('保留我的', 'Keep mine')}</Button>
          </div>
        ) : null}
        {doc.data.missingImages.length > 0 ? <div className="nv-banner is-warn"><span>{t('正文引用的图片不存在：', 'Images referenced by the text are missing: ')}{doc.data.missingImages.join(', ')}</span></div> : null}

        {writing !== undefined ? (
          <div className="nv-live nv-prose" ref={live}>
            {stream.length === 0 && thought.length === 0 ? <p className="nv-muted nv-live-wait"><Spinner size={12} /> {jobPulse(writing, t) ?? t('准备中…', 'Getting ready…')}</p> : null}
            <ThoughtPanel thought={thought} thinking={writing.thinking !== undefined} wrote={stream.length > 0} />
            {appending ? text.split('\n').filter(line => line.trim().length > 0).slice(-6).map((line, index) => <p key={`old-${index}`} className="nv-live-old">{line}</p>) : null}
            {stream.split('\n').filter(line => line.trim().length > 0).map((line, index) => <p key={index}>{line}</p>)}
            <span className="nv-caret" />
          </div>
        ) : (
          <textarea
            ref={area}
            className="nv-editor"
            spellCheck={false}
            value={text}
            placeholder={t('在这里写，或者让写手按章纲起草。选中文字可以单独改写、配图或拿去和总编讨论。', 'Write here, or let the writer draft from the plan. Select text to rewrite, illustrate or discuss just that passage.')}
            onChange={(event) => { setText(event.target.value) }}
            onSelect={(event) => {
              const { selectionStart, selectionEnd } = event.currentTarget
              setSelection(selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : undefined)
              if (selectionEnd === selectionStart) setCustom(undefined)
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                void save()
              }
            }}
          />
        )}
      </section>

      {panelInline ? side : panelOpen ? <div className="nv-drawer-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) setPanelOpen(false) }}>{side}</div> : null}

      {viewing !== undefined ? <VersionModal chapterId={chapter.id} version={viewing} current={text} onClose={() => { setViewing(undefined) }} /> : null}
      {confirm.element}
    </>
  )
}

function VersionModal({ chapterId, version, current, onClose }: { chapterId: string; version: VersionInfo; current: string; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const { busy, run } = useAction()
  const old = useLoad(signal => controller.api.call('chapter.version', { root, id: chapterId, version: version.id }, signal), [root, chapterId, version.id])
  return (
    <Modal wide title={`${new Date(version.createdAt).toLocaleString()} · ${versionReason(version.reason, t)}`} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('红色是这个版本有而现在没有的，绿色是现在新增的。', 'Red is what this version had and the current text lost; green is what the current text added.')}</span>
        <span className="nv-spacer" />
        <Button variant="primary" icon="undo" busy={busy} disabled={old.data === undefined} onClick={() => run(async () => { await controller.api.call('chapter.restore', { root, id: chapterId, version: version.id }); onClose() })}>{t('恢复到这个版本', 'Restore this version')}</Button>
      </>
    )}>
      {old.data !== undefined ? <DiffView before={old.data.text} after={current} whole /> : old.error !== undefined ? <p className="nv-muted">{old.error}</p> : <div className="nv-center"><Spinner /></div>}
    </Modal>
  )
}

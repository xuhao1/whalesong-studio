// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The manuscript editor: a chapter list, the text, and a side panel with the
 * chapter's plan, memory, review issues, versions and pending proposals.
 * Select text to revise, illustrate or discuss exactly that passage.
 *
 * The list shows one line of the plot at a time — the main one, or another the
 * author switches to — as it is read. Where the story parts after a chapter,
 * going on to the next asks which way; and a run of chapters can be written,
 * given beats or reviewed in one go.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChapterDocument } from '../../shared/rpc'
import { countWords, formatCount, fuzzyFind, normalizeProse, proseOnly } from '../../shared/text'
import { MAIN_LINE, type ChapterInfo, type JobInfo, type ReviewIssue, type TextStep, type VersionInfo } from '../../shared/types'
import { BatchMatrix, chapterJob, TextBatchDialog, useBatchJob } from '../Batch'
import { DiffView, ProposalCard } from '../components/ProposalCard'
import { Icon } from '../icons'
import { jobKindLabel, jobPulse } from '../Studio'
import { CHAPTER_STATUS, CHAPTER_STATUS_TONE, ISSUE_TYPE, SEVERITY, SEVERITY_TONE, sheetsDrawn } from '../labels'
import { useSheetsAsk } from '../SheetsAsk'
import { Derive } from './Outline'
import {
  Button, Chip, cx, Empty, Menu, Modal, Progress, Select, Spinner, Tabs, TextInput, ThoughtButton, ThoughtPanel, useAction, useConfirm, useJobStream, useJobTail, useLoad, useProject,
  useLineView, useQuote, useSnapshot, useStudio, useT, useWidth, waysOn, type Translate,
} from '../ui'
import { IssueList } from '../Issues'
import { JobBar } from '../JobBar'

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
  // A batch that is writing this chapter right now counts as its write job: its stream is the chapter's.
  const own = jobs.filter(job => job.status === 'running' && job.kind !== 'batch' && (job.target === chapterId || job.result?.chapterId === chapterId))
  const step = chapterJob(jobs, chapterId, ['write', 'derive beats', 'digest', 'review'])
  return step !== undefined && step.batch === true ? [...own, step] : own
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
  const others = project.outline.lines ?? []
  // The line whose chapters are listed: the one picked while the chapter in focus is read on it, else that chapter's own.
  const { lineId, path, pick: setPickedLine } = useLineView(project, chapterId)
  const chapter = path.find(candidate => candidate.id === chapterId) ?? path.find(candidate => !candidate.hasText) ?? path[0]
  const line = others.find(candidate => candidate.id === lineId)
  const { run } = useAction()
  const confirm = useConfirm()
  const [deriving, setDeriving] = useState<{ line?: string; after?: string; mode: 'append' | 'replace' | 'branch' } | boolean>(false)
  const [batching, setBatching] = useState<TextStep[] | undefined>()
  const batch = useBatchJob('text')
  const deriveDialog = deriving !== false ? (
    <Modal wide title={typeof deriving === 'object' && deriving.mode === 'branch' ? t('另开一条线', 'Open another line') : t('推演后续章节', 'Derive the next chapters')} onClose={() => { setDeriving(false) }}>
      {/* On the main line the planner starts at once and shows its plan first; on another line, and for a new one, the author looks the form over. */}
      <Derive only="chapters" autoStart={deriving === true && lineId === MAIN_LINE} preset={typeof deriving === 'object' ? deriving : lineId !== MAIN_LINE ? { line: lineId, mode: 'append' } : undefined} onApplied={() => { setDeriving(false) }} />
    </Modal>
  ) : null
  const batchDialog = batching !== undefined ? <TextBatchDialog chapters={path} preset={batching} line={lineId !== MAIN_LINE ? lineId : undefined} onClose={() => { setBatching(undefined) }} /> : null
  const switchLine = (next: string, to?: string): void => {
    setPickedLine(next)
    const own = next === MAIN_LINE ? project.chapters : project.lines?.find(candidate => candidate.id === next)?.chapters ?? []
    // Onto the chapter that was named; else the line's first chapter still to write, else its first.
    const target = to ?? (own.find(candidate => !candidate.hasText) ?? own[0])?.id
    if (target !== undefined) controller.focusChapter(target)
  }

  if (chapter === undefined) {
    return (
      <div className="nv-page">
        <Empty icon="pen" title={t('还没有章节', 'No chapters yet')}>
          <p>{t('让策划根据设定推演出开篇的章纲，或者去大纲里自己排。', 'Have the planner derive the opening chapters from the bible, or lay them out yourself in the Outline.')}</p>
          <div className="nv-row-wrap">
            <Button variant="primary" icon="sparkles" onClick={() => { setDeriving(true) }}>{t('推演开篇章节', 'Derive the opening chapters')}</Button>
            <Button icon="tree" onClick={() => { controller.setView('outline') }}>{t('去大纲', 'Open Outline')}</Button>
          </div>
        </Empty>
        {deriveDialog}
      </div>
    )
  }

  const addChapter = (): Promise<unknown> => run(async () => {
    const { results } = await controller.api.call('outline.apply', { root, ops: [{ op: 'add-chapter', title: t('新章节', 'New chapter'), ...(lineId !== MAIN_LINE ? { line: lineId } : {}) }] })
    const id = results[0]?.id
    if (id !== undefined) controller.focusChapter(id)
  })

  const removeChapter = (item: ChapterInfo): void => {
    confirm.ask(
      item.hasText
        ? t(`删除第 ${item.index} 章「${item.title}」（${formatCount(item.words, locale)} 字）？可以在大纲页最下面恢复。`, `Delete chapter ${item.index}, "${item.title}" (${formatCount(item.words, locale)} words)? It can be restored at the bottom of the outline page.`)
        : t(`删除第 ${item.index} 章「${item.title}」？可以在大纲页最下面恢复。`, `Delete chapter ${item.index}, "${item.title}"? It can be restored at the bottom of the outline page.`),
      () => {
        void run(async () => {
          // Stay near where the author was: the chapter after the one that goes, else the one before.
          const at = path.findIndex(candidate => candidate.id === item.id)
          const next = path[at + 1] ?? path[at - 1]
          await controller.api.call('outline.apply', { root, ops: [{ op: 'remove-chapter', chapter: item.id }] })
          if (item.id === chapter.id && next !== undefined) controller.focusChapter(next.id)
          controller.toast('success', t(`已删除「${item.title}」，可以在大纲页最下面恢复`, `"${item.title}" deleted; it can be restored at the bottom of the outline page`))
        })
      },
    )
  }
  // Every outlined chapter has its text: what comes next is the planner's to propose.
  const allWritten = path.every(item => item.hasText)
  const unwritten = path.filter(item => !item.hasText).length

  const list = (
    <aside className="nv-write-list">
      {others.length > 0 ? (
        <div className="nv-line-switch">
          <Select value={lineId} options={[{ value: MAIN_LINE, label: `★ ${t('主线', 'Main line')}` }, ...others.map(item => ({ value: item.id, label: `${item.shelved === true ? '⏸ ' : ''}${item.title}` }))]} onChange={switchLine} />
          <Button size="sm" variant="ghost" icon="branch" onClick={() => { controller.setView('outline') }} title={t('在大纲的“剧情图”里看所有的线', 'See every line on the plot graph, under Outline')} />
        </div>
      ) : null}
      {line !== undefined ? <p className="nv-muted nv-small nv-line-about">{line.choice !== undefined ? t(`抉择：${line.choice}`, `The choice: ${line.choice}`) : line.premise ?? t('这条线上的章节；灰色的是它和别的线共有的。', 'The chapters of this line; the dimmed ones it shares with another.')}</p> : null}
      <ul className="nv-list">
        {path.map((item) => {
          const busy = jobsOf(jobs, item.id).length > 0
          return (
            <li key={item.id} className={cx('nv-list-item', line !== undefined && item.line !== line.id && 'is-shared')}>
              <button type="button" className={cx('nv-list-row', item.id === chapter.id && 'is-active')} onClick={() => { controller.focusChapter(item.id) }} title={item.title}>
                <span className="nv-list-index">{item.index}</span>
                <span className="nv-person-text">
                  <span className="nv-list-title">{item.title}</span>
                  <span className="nv-list-meta">{item.hasText ? `${formatCount(item.words, locale)}${t(' 字', ' words')}` : t(...CHAPTER_STATUS[item.status])}{item.hasText && !item.digested ? t(' · 未收录', ' · undigested') : ''}</span>
                </span>
                {busy ? <Spinner size={12} /> : <span className={cx('nv-dot', `is-${item.status}`)} />}
              </button>
              <button type="button" className="nv-list-remove" disabled={busy} onClick={() => { removeChapter(item) }} title={t('删除这一章', 'Delete this chapter')} aria-label={t(`删除第 ${item.index} 章`, `Delete chapter ${item.index}`)}><Icon name="trash" size={12} /></button>
            </li>
          )
        })}
      </ul>
      <button type="button" className="nv-add-row" onClick={addChapter}>+ {t('添加章节', 'Add chapter')}</button>
      <button type="button" className={cx('nv-add-row', allWritten && 'is-suggested')} onClick={() => { setDeriving(true) }} title={t('让策划排出接下来的章纲', 'Have the planner plot the chapters to come')}><Icon name="sparkles" size={12} /> {t('推演后续章节', 'Derive the next chapters')}</button>
      <button type="button" className={cx('nv-add-row', unwritten > 1 && 'is-suggested')} onClick={() => { setBatching(['beats', 'write', 'digest']) }} title={t('一章接一章地写下去', 'Write on, chapter after chapter')}><Icon name="layers" size={12} /> {unwritten > 0 ? t(`批量写作 · ${unwritten} 章`, `Write in batch · ${unwritten}`) : t('批量：节拍、收录、审校', 'Batch: beats, memory, review')}</button>
      {batch?.status === 'running' ? <div className="nv-write-batch"><BatchMatrix job={batch} compact /></div> : null}
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
        onAdd={addChapter}
        onRemove={() => { removeChapter(chapter) }}
        onDerive={() => { setDeriving(true) }}
        path={path}
        lineId={lineId}
        onBranch={() => { setDeriving({ ...(chapter.line !== undefined ? { line: chapter.line } : {}), after: chapter.id, mode: 'branch' }) }}
        onBatch={setBatching}
        onLine={switchLine}
      />
      {deriveDialog}
      {batchDialog}
      {confirm.element}
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
  /** What the chapter list offers, for when there is no room for the list. */
  onAdd: () => void
  onRemove: () => void
  onDerive: () => void
  /** The chapters of the line being shown, as they are read on it. */
  path: ChapterInfo[]
  lineId: string
  /** Open another line of the plot after this chapter. */
  onBranch: () => void
  /** Open the batch dialog with these steps ticked. */
  onBatch: (steps: TextStep[]) => void
  /** Show another line of the plot. */
  onLine: (line: string, to?: string) => void
}

function ChapterEditor({ chapter, compact, panel, setPanel, panelInline, panelOpen, setPanelOpen, onAdd, onRemove, onDerive, path, lineId, onBranch, onBatch, onLine }: EditorProps) {
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
      // Whoever of the people in the passage comes back in the book and has no design sheet gets one first: asked, before anything is drawn.
      await sheets.before([{ kind: 'scene', target: chapter.id, quote }], async (choice) => {
        controller.toast('info', t('正在为这段文字配图，完成后会插入到这段之后。', 'Illustrating this passage; the picture is inserted after it when ready.'))
        const job = await controller.run('image.create', { root, kind: 'scene', target: chapter.id, quote, insert: true, ...choice })
        if (sheetsDrawn(job, t).length > 0) controller.toast('info', `${t('插图已放进正文', 'The illustration is in the chapter')}${sheetsDrawn(job, t)}`)
      })
      return undefined
    })
  }
  const sheets = useSheetsAsk()
  const quoteSelection = (): void => {
    const passage = selected.trim()
    if (passage.length === 0 || quote === undefined) return
    quote(t(`关于第 ${chapter.index} 章《${chapter.title}》里的这段：\n「${passage}」\n`, `About this passage in chapter ${chapter.index}, "${chapter.title}":\n"${passage}"\n`))
  }
  const locate = (quote: string): void => {
    if (text === undefined) return
    const range = fuzzyFind(text, quote.trim())
    if (range === undefined) {
      controller.toast('info', t('这段引文已不在正文里', 'That passage is no longer in the text'))
      return
    }
    controller.jumpTo(chapter.id, range.start, range.end - range.start)
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
            <div className="nv-row-wrap">
              <Button size="sm" variant={(plan.beats ?? []).length === 0 ? 'primary' : 'outline'} icon="sparkles" busy={running.some(job => job.kind === 'derive')} pending={t('策划在推演…', 'The planner is deriving…')} onClick={() => controller.guard(async () => { await controller.api.call('ai.deriveBeats', { root, chapter: chapter.id, ...(brief.trim().length > 0 ? { direction: brief.trim() } : {}) }); await controller.refreshJobs() })} title={t('让策划排出这一章的节拍', 'Have the planner lay out this chapter\'s beats')}>{(plan.beats ?? []).length === 0 ? t('推演本章节拍', 'Derive this chapter\'s beats') : t('重新推演节拍', 'Derive the beats again')}</Button>
              <Button size="sm" icon="tree" onClick={() => { controller.setView('outline', chapter.id) }}>{t('编辑章纲', 'Edit the plan')}</Button>
            </div>
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
            ) : <p className="nv-muted">{t('收录后这里列出本章的摘要、人物状态、事实和线索。', 'Once digested, the chapter\'s summary, where people stand, facts and threads are listed here.')}</p>}
          </div>
        ) : null}

        {panel === 'issues' ? (
          <div className="nv-panel-section">
            <div className="nv-row">
              <Button size="sm" icon="checkCircle" busy={running.some(job => job.kind === 'review')} disabled={empty} onClick={() => controller.guard(async () => { if (await settle()) { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() } })}>{doc.data.review !== undefined ? t('重新审校', 'Review again') : t('审校这一章', 'Review this chapter')}</Button>
              {doc.data.review !== undefined ? <Button size="sm" variant="ghost" icon="trash" onClick={() => { confirm.ask(t('清除这一章的审校意见？', 'Clear this chapter\'s review?'), () => { void controller.guard(async () => { await controller.api.call('review.clear', { root, chapter: chapter.id }); doc.reload() }) }) }} title={t('清除这一章的审校意见', 'Clear this chapter\'s review')} /> : null}
            </div>
            {doc.data.review !== undefined ? <p className="nv-note">{doc.data.review.verdict}</p> : <p className="nv-muted">{t('审校对照设定、记忆与文风检查这一章。', 'A review checks the chapter against the bible, memory and style.')}</p>}
            <IssueList chapterId={chapter.id} issues={doc.data.review?.issues ?? []} onLocate={locate} onChanged={() => { doc.reload() }} before={settle} after={() => { showPanel('proposals') }} />
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
            {proposals.length === 0 && revising === undefined ? <p className="nv-muted">{t('在正文里选中文字让写手改写，改动先作为提案放在这里。', 'Select text in the chapter to have the writer rework it; the change waits here as a proposal.')}</p> : null}
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
            <Select className="nv-chapter-select" value={chapter.id} options={path.map(item => ({ value: item.id, label: `${item.index}. ${item.title}` }))} onChange={(value) => { controller.focusChapter(value) }} />
          ) : <h2 className="nv-write-title"><span className="nv-muted">{chapter.index}</span> {chapter.title}</h2>}
          <Chip tone={CHAPTER_STATUS_TONE[chapter.status]}>{t(...CHAPTER_STATUS[chapter.status])}</Chip>
          <span className="nv-muted nv-small" title={chapter.budget !== undefined ? t(`建议字数 ${chapter.budget}`, `Suggested length ${chapter.budget}`) : t('没有设建议字数，由写手判断', 'No suggested length: the writer judges')}>{formatCount(words, locale)}{chapter.budget !== undefined ? ` / ${formatCount(chapter.budget, locale)}` : ''}{t(' 字', ' words')}</span>
          <span className={cx('nv-save-state', `is-${saveState}`)}>{saveState === 'saving' ? t('保存中…', 'Saving…') : saveState === 'dirty' ? t('未保存', 'Unsaved') : t('已保存', 'Saved')}</span>
          <span className="nv-spacer" />
          <Button size="sm" variant="ghost" icon="eye" title={t('观看：这一章在读者那里的样子', 'View: this chapter as a reader has it')} onClick={() => { void save(); controller.setView('read', chapter.id) }} />
          <Menu icon="more" variant="ghost" size="sm" align="end" label={t('章节', 'Chapter')} items={[
            { label: t('推演后续章节', 'Derive the next chapters'), icon: 'sparkles', onSelect: onDerive },
            { label: t('从这一章另开一条线…', 'Open another line from here…'), icon: 'branch', onSelect: onBranch },
            { label: t('添加章节', 'Add chapter'), icon: 'plus', onSelect: onAdd },
            { label: t('编辑章纲', 'Edit the plan'), icon: 'tree', onSelect: () => { controller.setView('outline', chapter.id) } },
            'separator',
            { label: t('批量写作…', 'Write a run of chapters…'), icon: 'layers', onSelect: () => { onBatch(['beats', 'write', 'digest']) } },
            { label: t('批量推演节拍…', 'Beats for many chapters…'), icon: 'layers', onSelect: () => { onBatch(['beats']) } },
            { label: t('批量收录 / 审校…', 'Memory and reviews for many chapters…'), icon: 'layers', onSelect: () => { onBatch(['digest', 'review']) } },
            'separator',
            { label: t('删除这一章', 'Delete this chapter'), icon: 'trash', danger: true, onSelect: onRemove },
          ]} />
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
            <TextInput className="nv-grow" value={brief} placeholder={empty ? t('给写手的要求', 'What to ask of the writer') : t('给写手的要求：续写的方向，或整章要怎么改', 'A brief: where to continue, or how the chapter should change')} onChange={(event) => { setBrief(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && writing === undefined) write(empty ? 'draft' : 'continue') }} />
            {writing !== undefined
              ? <Button variant="danger" icon="stop" onClick={() => { void controller.cancelJob(writing.id) }}>{t('停止', 'Stop')}</Button>
              : <Button variant="primary" icon="feather" onClick={() => { write(empty ? 'draft' : 'continue') }}>{empty ? t('写这一章', 'Write it') : t('续写', 'Continue')}</Button>}
            {!empty && writing === undefined ? (
              <Menu icon="chevronDown" variant="outline" size="md" align="end" items={[
                { label: t('按要求修改整章（生成提案）', 'Revise the whole chapter (as a proposal)'), icon: 'wand', onSelect: reviseChapter },
                { label: t('从头重新起草（旧稿存入版本）', 'Redraft from the top (old text is versioned)'), icon: 'refresh', onSelect: () => { confirm.ask(t('用新稿替换这一章现有的正文？旧稿会存入“版本”。', 'Replace this chapter\'s text with a new draft? The old one is kept under Versions.'), () => { write('draft') }) } },
                'separator',
                { label: t('审校这一章', 'Review this chapter'), icon: 'checkCircle', onSelect: () => { showPanel('issues'); void controller.guard(async () => { if (await settle()) { await controller.api.call('ai.review', { root, chapter: chapter.id }); await controller.refreshJobs() } }) } },
                { label: t('收录记忆', 'Digest'), icon: 'layers', onSelect: () => { showPanel('memory'); void controller.guard(async () => { if (await settle()) { await controller.api.call('ai.digest', { root, chapters: [chapter.id], force: true }); await controller.refreshJobs() } }) } },
              ]} />
            ) : null}
          </div>
        )}

        {!empty && writing === undefined ? <NextChapter chapter={chapter} path={path} lineId={lineId} onBranch={onBranch} onLine={onLine} onDerive={onDerive} /> : null}

        {running.filter(job => job.kind !== 'write').map(job => <JobBar key={job.id} job={job} />)}

        {external !== undefined ? (
          <div className="nv-banner is-warn">
            <span>{t('这一章在别处被更新了，而这里还有未保存的修改。', 'This chapter was changed elsewhere while edits here are unsaved.')}</span>
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
            placeholder={t('在这里写，或让写手按章纲起草。', 'Write here, or have the writer draft from the outline.')}
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
      {sheets.element}
    </>
  )
}

/**
 * Where the story goes after a chapter that is written: the next chapter of
 * the line being read — and, where other lines leave after this chapter, each
 * of those. More than one way on is a choice the author makes here.
 */
function NextChapter({ chapter, path, lineId, onBranch, onLine, onDerive }: { chapter: ChapterInfo; path: ChapterInfo[]; lineId: string; onBranch: () => void; onLine: (line: string, to?: string) => void; onDerive: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project } = useProject()
  const at = path.findIndex(candidate => candidate.id === chapter.id)
  const next = at >= 0 ? path[at + 1] : undefined
  const lines = project.outline.lines ?? []
  // The other ways on from here: lines that leave after this chapter, and the line the one being read left.
  const { ways } = waysOn(project, chapter, lineId)
  const here = lines.find(line => line.id === lineId)
  if (next === undefined && ways.length === 0) {
    return (
      <div className="nv-next-bar">
        <span className="nv-muted nv-small">{t('这是这条线上大纲里的最后一章。', 'This is the last outlined chapter of this line.')}</span>
        <span className="nv-spacer" />
        <Button size="sm" icon="sparkles" onClick={onDerive}>{t('推演后续章节', 'Derive the next chapters')}</Button>
        <Button size="sm" variant="ghost" icon="branch" onClick={onBranch}>{t('从这里另开一条线', 'Open another line from here')}</Button>
      </div>
    )
  }
  const forked = ways.length > 0
  return (
    <div className={cx('nv-next-bar', forked && 'is-fork')}>
      <span className="nv-muted nv-small">{forked ? t('故事在这一章之后分了岔——接下来写哪条线？', 'The story parts after this chapter — which way next?') : t('下一章：', 'Next: ')}</span>
      {next !== undefined ? (
        <Button size="sm" variant={forked ? 'outline' : 'ghost'} icon="arrowRight" onClick={() => { controller.focusChapter(next.id) }} title={forked ? t('沿着现在这条线往下', 'Go on along this line') : undefined}>
          {forked ? `${here?.title ?? t('主线', 'Main line')} · ` : ''}{next.index}. {next.title}{next.hasText ? '' : t('（未写）', ' (unwritten)')}
        </Button>
      ) : null}
      {ways.map((way) => {
        // Onto its first chapter still to write, else the first one after the fork.
        const first = way.chapters.find(candidate => !candidate.hasText) ?? way.chapters[0]
        const name = way.info?.title ?? t('主线', 'Main line')
        const about = way.left === true ? t('这条线分出去之前的走向', 'The way things went before this line left') : way.info?.choice !== undefined ? t(`抉择：${way.info.choice}`, `The choice: ${way.info.choice}`) : way.info?.premise
        return (
          <Button key={way.line} size="sm" icon={way.info !== undefined ? 'branch' : 'star'} onClick={() => { onLine(way.line, first?.id) }} title={about}>
            {name}{first !== undefined ? ` · ${first.index}. ${first.title}${first.hasText ? '' : t('（未写）', ' (unwritten)')}` : t('（还没有章节）', ' (no chapters yet)')}
          </Button>
        )
      })}
      {forked ? <Button size="sm" variant="ghost" icon="plus" onClick={onBranch}>{t('再开一条线', 'Yet another line')}</Button> : null}
    </div>
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

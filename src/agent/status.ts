// SPDX-License-Identifier: LGPL-3.0-or-later
/** Renders a project for the orchestrator: a one-screen status and a few-line digest. */
import type { ProjectRuntime } from '../core/core'
import type { JobInfo, ProjectState, WorkMode } from '../shared/types'
import { roleLabel, statusLabel, promptLanguage } from '../core/render'

const MODE_LABEL: Record<WorkMode, [string, string]> = {
  ideate: ['构思', 'ideate'],
  bible: ['设定', 'bible'],
  outline: ['大纲', 'outline'],
  draft: ['写作', 'draft'],
  revise: ['修订', 'revise'],
  review: ['审校', 'review'],
  stage: ['演出', 'stage'],
  play: ['幕间', 'play'],
}

export function modeLabel(mode: WorkMode, zh: boolean): string {
  return MODE_LABEL[mode][zh ? 0 : 1]
}

function nextStep(state: ProjectState, zh: boolean): string {
  const { stats } = state
  if (state.characters.length === 0 && state.world.length === 0 && stats.chapters === 0) {
    return zh ? '项目是空的：先和作者确定故事核，再建立人物、世界观与文风（novel_derive kind=foundation 可以从一个点子起步）。' : 'The project is empty: settle the premise with the author, then build characters, world and style (novel_derive kind=foundation starts from an idea).'
  }
  if (stats.chapters === 0) return zh ? '还没有大纲：用 novel_derive 推演开篇章节，或用 novel_outline 手动添加。' : 'No outline yet: derive the opening chapters with novel_derive, or add them with novel_outline.'
  const unwritten = state.chapters.find(chapter => !chapter.hasText)
  if (stats.undigested > 0) return zh ? `有 ${stats.undigested} 章尚未收录记忆：先 novel_digest，再继续写作。` : `${stats.undigested} chapters are not digested yet: run novel_digest before writing on.`
  if (unwritten !== undefined) {
    const planned = state.outline.volumes.flatMap(volume => volume.chapters).find(plan => plan.id === unwritten.id)
    const thin = planned?.beats === undefined || planned.beats.length === 0
    return zh
      ? `下一章待写：第${unwritten.index}章《${unwritten.title}》（${unwritten.id}）${thin ? '，章纲还没有节拍，建议先 novel_derive kind=beats 细化' : ''}。`
      : `Next to write: chapter ${unwritten.index} "${unwritten.title}" (${unwritten.id})${thin ? '; its outline has no beats yet — consider novel_derive kind=beats first' : ''}.`
  }
  return zh ? '已有章纲都写完了：用 novel_derive 推演后续章节，或进入修订/审校。' : 'Every outlined chapter is written: derive what comes next with novel_derive, or move to revision and review.'
}

/** A few lines that keep the orchestrator oriented between tool calls. */
export function renderDigest(state: ProjectState, mode: WorkMode, relativeRoot: string): string {
  const zh = promptLanguage(state.manifest.language) === 'zh'
  const { stats } = state
  const leads = state.characters
    .filter(card => card.status !== 'retired' && card.status !== 'dead')
    .sort((left, right) => ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo'].indexOf(left.role) - ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo'].indexOf(right.role))
    .slice(0, 10)
    .map(card => card.name)
  const lines = zh
    ? [
        `【小说项目】《${state.manifest.title}》（${relativeRoot}）· 当前模式：${modeLabel(mode, true)}`,
        `进度：${stats.chaptersWithText}/${stats.chapters} 章已写，约 ${stats.words} 字；人物 ${stats.characters}，设定 ${stats.worldEntries}，未回收线索 ${stats.openThreads}`,
        leads.length > 0 ? `主要人物：${leads.join('、')}` : '',
        stats.pendingProposals + stats.pendingSuggestions > 0 ? `待处理：修订提案 ${stats.pendingProposals}，设定建议 ${stats.pendingSuggestions}` : '',
        nextStep(state, true),
      ]
    : [
        `[Novel project] "${state.manifest.title}" (${relativeRoot}) · mode: ${modeLabel(mode, false)}`,
        `Progress: ${stats.chaptersWithText}/${stats.chapters} chapters written, about ${stats.words} words; ${stats.characters} characters, ${stats.worldEntries} world entries, ${stats.openThreads} open threads`,
        leads.length > 0 ? `Main cast: ${leads.join(', ')}` : '',
        stats.pendingProposals + stats.pendingSuggestions > 0 ? `Waiting: ${stats.pendingProposals} revision proposals, ${stats.pendingSuggestions} bible suggestions` : '',
        nextStep(state, false),
      ]
  return lines.filter(line => line.length > 0).join('\n')
}

/** The full status the `novel_status` tool returns. */
export async function renderStatus(runtime: ProjectRuntime, mode: WorkMode, relativeRoot: string, jobs: JobInfo[], detail: 'brief' | 'full'): Promise<{ text: string; state: ProjectState }> {
  const state = await runtime.project.state()
  const lang = promptLanguage(state.manifest.language)
  const zh = lang === 'zh'
  const sep = zh ? '：' : ': '
  const lines: string[] = [renderDigest(state, mode, relativeRoot), '']
  const manifest = state.manifest
  if (manifest.logline !== undefined) lines.push(`${zh ? '梗概' : 'Logline'}${sep}${manifest.logline}`)
  if (detail === 'full' && manifest.premise !== undefined) lines.push(`${zh ? '故事核' : 'Premise'}${sep}${manifest.premise}`)
  const style = state.styles.find(candidate => candidate.id === manifest.activeStyle) ?? state.styles[0]
  if (style !== undefined) lines.push(`${zh ? '文风' : 'Style'}${sep}${style.name}${style.tone !== undefined ? ` — ${style.tone}` : ''}`)

  lines.push('', zh ? '## 大纲' : '## Outline')
  const limit = detail === 'full' ? Infinity : 40
  let shown = 0
  for (const volume of state.outline.volumes) {
    const chapters = state.chapters.filter(chapter => chapter.volumeId === volume.id)
    lines.push(`### ${volume.title} (${volume.id}) — ${chapters.length} ${zh ? '章' : 'chapters'}${volume.synopsis !== undefined && detail === 'full' ? `${sep}${volume.synopsis}` : ''}`)
    for (const chapter of chapters) {
      if (shown >= limit) continue
      shown += 1
      const flags = [chapter.status, chapter.hasText ? `${chapter.words}${zh ? '字' : 'w'}` : (zh ? '未写' : 'no text'), chapter.hasText && !chapter.digested ? (zh ? '未收录' : 'undigested') : ''].filter(Boolean).join(', ')
      lines.push(`${chapter.index}. ${chapter.title} [${chapter.id}; ${flags}]`)
    }
  }
  if (state.chapters.length > shown) lines.push(zh ? `…… 其余 ${state.chapters.length - shown} 章未列出（detail=full 查看全部，或 novel_read what=outline）` : `… ${state.chapters.length - shown} more chapters not listed (detail=full shows all, or novel_read what=outline)`)

  lines.push('', zh ? '## 人物' : '## Cast')
  if (state.characters.length === 0) lines.push(zh ? '（暂无）' : '(none)')
  for (const card of state.characters.slice(0, detail === 'full' ? 200 : 30)) {
    const presence = state.presence.find(entry => entry.character === card.id)
    const away = presence !== undefined && presence.chapters.length > 0 && presence.absentFor >= 5 && card.status === 'active'
      ? (zh ? `，已 ${presence.absentFor} 章未出场` : `, absent for ${presence.absentFor} chapters`)
      : ''
    lines.push(`- ${card.name} [${card.id}] ${roleLabel(card.role, lang)}, ${statusLabel(card.status, lang)}${presence !== undefined ? (zh ? `，出场 ${presence.chapters.length} 章` : `, in ${presence.chapters.length} chapters`) : ''}${away}${card.tagline !== undefined ? ` — ${card.tagline}` : ''}`)
  }

  if (state.world.length > 0) {
    lines.push('', zh ? '## 世界观条目' : '## World entries')
    lines.push(state.world.slice(0, detail === 'full' ? 300 : 40).map(entry => `${entry.name}${entry.importance === 1 ? '★' : ''}`).join(zh ? '、' : ', '))
  }

  const open = state.outline.threads.filter(thread => thread.status === 'open')
  if (open.length > 0) {
    lines.push('', zh ? '## 未回收的线索' : '## Open threads')
    for (const thread of open.slice(0, detail === 'full' ? 100 : 15)) lines.push(`- ${thread.title} [${thread.id}; ${thread.kind}${thread.auto === true ? (zh ? '; 待确认' : '; unconfirmed') : ''}]${thread.description !== undefined ? ` — ${thread.description}` : ''}`)
  }

  if (state.proposals.length > 0) {
    lines.push('', zh ? '## 待审的修订提案' : '## Pending revision proposals')
    for (const proposal of state.proposals.slice(0, 20)) lines.push(`- ${proposal.id}: ${proposal.kind} @ ${proposal.chapterId} — ${proposal.instruction.slice(0, 80)}`)
  }
  if (state.suggestions.length > 0) {
    lines.push('', zh ? '## 待确认的设定建议（novel_bible action=accept_suggestion / dismiss_suggestion）' : '## Bible suggestions waiting (novel_bible action=accept_suggestion / dismiss_suggestion)')
    for (const suggestion of state.suggestions.slice(0, 20)) lines.push(`- ${suggestion.id}: ${suggestion.title}${suggestion.detail.length > 0 ? ` — ${suggestion.detail.slice(0, 80)}` : ''}`)
  }
  const running = jobs.filter(job => job.status === 'running')
  if (running.length > 0) {
    lines.push('', zh ? '## 进行中的任务' : '## Running jobs')
    for (const job of running) lines.push(`- ${job.kind} ${job.target ?? ''} ${job.progress !== undefined ? `${job.progress.done}/${job.progress.total}` : ''}`.trim())
  }
  return { text: lines.join('\n'), state }
}

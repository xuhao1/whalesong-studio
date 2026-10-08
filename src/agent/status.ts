// SPDX-License-Identifier: LGPL-3.0-or-later
/** Renders a project for the orchestrator: a one-screen status and a few-line digest. */
import type { ProjectRuntime } from '../core/core'
import type { JobInfo, ProjectState, WorkMode } from '../shared/types'
import { roleLabel, promptLanguage } from '../core/render'
import { lifeEnd } from '../shared/life'

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
  // Those the main line has not let go of: nobody the digests have dead or gone for good.
  const gone = new Set(state.presence.filter(entry => entry.death !== undefined || entry.exit !== undefined).map(entry => entry.character))
  const leads = state.characters
    .filter(card => !gone.has(card.id))
    .sort((left, right) => ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo'].indexOf(left.role) - ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo'].indexOf(right.role))
    .slice(0, 10)
    .map(card => card.name)
  // What was done to the files behind the Studio's back in the last day is news the showrunner must have.
  const outside = (state.activity ?? []).filter(entry => entry.by === 'outside' && Date.now() - Date.parse(entry.at) < 24 * 3600_000).slice(0, 2)
  const lines = zh
    ? [
        `【小说项目】《${state.manifest.title}》（${relativeRoot}）· 当前模式：${modeLabel(mode, true)}`,
        `进度：${stats.chaptersWithText}/${stats.chapters} 章已写，约 ${stats.words} 字；人物 ${stats.characters}，设定 ${stats.worldEntries}，未回收线索 ${stats.openThreads}`,
        leads.length > 0 ? `主要人物：${leads.join('、')}` : '',
        stats.pendingProposals + stats.pendingSuggestions > 0 ? `待处理：修订提案 ${stats.pendingProposals}，设定建议 ${stats.pendingSuggestions}` : '',
        ...outside.map(entry => `【工坊之外的改动 ${entry.at.slice(0, 16).replace('T', ' ')} UTC】${entry.summary}`),
        nextStep(state, true),
      ]
    : [
        `[Novel project] "${state.manifest.title}" (${relativeRoot}) · mode: ${modeLabel(mode, false)}`,
        `Progress: ${stats.chaptersWithText}/${stats.chapters} chapters written, about ${stats.words} words; ${stats.characters} characters, ${stats.worldEntries} world entries, ${stats.openThreads} open threads`,
        leads.length > 0 ? `Main cast: ${leads.join(', ')}` : '',
        stats.pendingProposals + stats.pendingSuggestions > 0 ? `Waiting: ${stats.pendingProposals} revision proposals, ${stats.pendingSuggestions} bible suggestions` : '',
        ...outside.map(entry => `[Changed outside the Studio, ${entry.at.slice(0, 16).replace('T', ' ')} UTC] ${entry.summary}`),
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

  // The other ways the story goes: what was said above is the main line.
  const others = state.outline.lines ?? []
  if (others.length > 0) {
    lines.push('', zh ? '## 剧情线（上面的大纲是主线；下面是故事的其它走法）' : '## Lines of the plot (the outline above is the main line; these are the other ways the story goes)')
    const whereOf = (id: string | undefined): string => {
      if (id === undefined) return zh ? '从开头' : 'from the start'
      const onMain = state.chapters.find(chapter => chapter.id === id)
      if (onMain !== undefined) return zh ? `主线第${onMain.index}章之后` : `after main-line chapter ${onMain.index}`
      const home = others.find(line => line.chapters.some(chapter => chapter.id === id))
      return home !== undefined ? (zh ? `「${home.title}」的 ${id} 之后` : `after ${id} of "${home.title}"`) : id
    }
    for (const line of others) {
      const info = state.lines?.find(candidate => candidate.id === line.id)
      const written = info?.chapters.filter(chapter => chapter.hasText).length ?? 0
      lines.push(`### ${line.title} [${line.id}]${line.shelved === true ? (zh ? '（已搁置）' : ' (put aside)') : ''} — ${whereOf(line.from)}${zh ? '分出' : ''}${line.choice !== undefined ? `${zh ? '，抉择：' : '; the choice: '}${line.choice}` : ''}${line.into !== undefined ? `${zh ? '，汇入 ' : '; arrives at '}${line.into}` : ''}${zh ? `；${line.chapters.length} 章，已写 ${written} 章` : `; ${line.chapters.length} chapters, ${written} written`}${line.premise !== undefined && detail === 'full' ? `\n${line.premise}` : ''}`)
      for (const chapter of (info?.chapters ?? []).slice(0, detail === 'full' ? 200 : 8)) {
        const flags = [chapter.status, chapter.hasText ? `${chapter.words}${zh ? '字' : 'w'}` : (zh ? '未写' : 'no text')].join(', ')
        lines.push(`${chapter.index}. ${chapter.title} [${chapter.id}; ${flags}]`)
      }
    }
  }

  lines.push('', zh ? '## 人物' : '## Cast')
  if (state.characters.length === 0) lines.push(zh ? '（暂无）' : '(none)')
  for (const card of state.characters.slice(0, detail === 'full' ? 200 : 30)) {
    const presence = state.presence.find(entry => entry.character === card.id)
    // Where they are in the book, as the digests of the main line have it — a death or a leaving with its chapter, else how long they have been away.
    const on = presence !== undefined && presence.chapters.length > 0
    const end = lifeEnd(presence, zh)
    const fate = end !== undefined ? `${zh ? '，' : ', '}${end.text}`
        : on && presence.absentFor >= 5 ? (zh ? `，已 ${presence.absentFor} 章未出场` : `, absent for ${presence.absentFor} chapters`) : ''
    lines.push(`- ${card.name} [${card.id}] ${roleLabel(card.role, lang)}${on ? (zh ? `，出场 ${presence.chapters.length} 章` : `, in ${presence.chapters.length} chapters`) : (zh ? '，正文里还没有出场' : ', not on the page yet')}${fate}${card.tagline !== undefined ? ` — ${card.tagline}` : ''}`)
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
    const shown = detail === 'full' ? state.proposals : state.proposals.slice(0, 20)
    for (const proposal of shown) lines.push(`- ${proposal.id}: ${proposal.kind} @ ${proposal.chapterId} — ${proposal.instruction.slice(0, 80)}`)
    if (shown.length < state.proposals.length) lines.push(zh ? `……另有 ${state.proposals.length - shown.length} 条（detail=full 列出全部）` : `… and ${state.proposals.length - shown.length} more (detail=full lists them all)`)
  }
  if (state.suggestions.length > 0) {
    lines.push('', zh ? '## 待确认的设定建议（novel_bible action=accept_suggestion / dismiss_suggestion）' : '## Bible suggestions waiting (novel_bible action=accept_suggestion / dismiss_suggestion)')
    const shown = detail === 'full' ? state.suggestions : state.suggestions.slice(0, 20)
    for (const suggestion of shown) lines.push(`- ${suggestion.id}: ${suggestion.title}${suggestion.detail.length > 0 ? ` — ${suggestion.detail.slice(0, 80)}` : ''}`)
    if (shown.length < state.suggestions.length) lines.push(zh ? `……另有 ${state.suggestions.length - shown.length} 条（detail=full 列出全部）。新人物很多时不必逐条采纳：novel_import action=analyze steps=["cast"] 会按出场多少归并人物表。` : `… and ${state.suggestions.length - shown.length} more (detail=full lists them all). When most are new characters there is no need to accept them one by one: novel_import action=analyze steps=["cast"] makes the cast by how much each is on the page.`)
  }
  const recent = (state.activity ?? []).slice(0, detail === 'full' ? 20 : 6)
  if (recent.length > 0) {
    lines.push('', zh ? '## 最近的改动记录（总编的工具调用，和工坊之外对文件的改动）' : '## Recent changes on the record (the showrunner\'s tool calls, and changes made to the files outside the Studio)')
    for (const entry of recent) lines.push(`- ${entry.at.slice(0, 16).replace('T', ' ')} ${entry.by === 'outside' ? (zh ? '[工坊之外]' : '[outside]') : `[${entry.tool}${entry.action !== undefined ? ` ${entry.action}` : ''}]`} ${entry.summary}`)
  }
  const running = jobs.filter(job => job.status === 'running')
  if (running.length > 0) {
    lines.push('', zh ? '## 进行中的任务' : '## Running jobs')
    for (const job of running) lines.push(`- ${job.kind} ${job.target ?? ''} ${job.progress !== undefined ? `${job.progress.done}/${job.progress.total}` : ''}`.trim())
  }
  return { text: lines.join('\n'), state }
}

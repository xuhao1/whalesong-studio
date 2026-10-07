// SPDX-License-Identifier: LGPL-3.0-or-later
/** Bilingual labels for domain enums, shared by the views. */
import type { RpcMethod } from '../shared/rpc'
import type {
  AmbiencePreset, CameraMove, ChapterStatus, IssueSeverity, IssueType, JobInfo, ProjectState, StoryboardDensity, Suggestion, TakeIssue,
  ThreadKind, ThreadStatus,
} from '../shared/types'

type Label = [zh: string, en: string]
type Tone = 'neutral' | 'blue' | 'amber' | 'green' | 'red' | 'violet'

export const CHAPTER_STATUS: Record<ChapterStatus, Label> = {
  idea: ['构想', 'Idea'],
  outlined: ['有纲', 'Outlined'],
  drafted: ['初稿', 'Drafted'],
  revised: ['已修', 'Revised'],
  final: ['定稿', 'Final'],
}

export const CHAPTER_STATUS_TONE: Record<ChapterStatus, Tone> = {
  idea: 'neutral',
  outlined: 'blue',
  drafted: 'amber',
  revised: 'violet',
  final: 'green',
}

export const THREAD_KIND: Record<ThreadKind, Label> = {
  foreshadow: ['伏笔', 'Foreshadowing'],
  mystery: ['悬念', 'Mystery'],
  subplot: ['支线', 'Subplot'],
  promise: ['承诺', 'Promise'],
  motif: ['母题', 'Motif'],
}

export const THREAD_STATUS: Record<ThreadStatus, Label> = {
  open: ['未回收', 'Open'],
  paid: ['已回收', 'Paid off'],
  dropped: ['已放弃', 'Dropped'],
}

export const THREAD_STATUS_TONE: Record<ThreadStatus, Tone> = { open: 'amber', paid: 'green', dropped: 'neutral' }

export const ISSUE_TYPE: Record<IssueType, Label> = {
  continuity: ['连贯', 'Continuity'],
  character: ['人物', 'Character'],
  world: ['设定', 'World'],
  timeline: ['时间线', 'Timeline'],
  style: ['文风', 'Style'],
  pacing: ['节奏', 'Pacing'],
  logic: ['逻辑', 'Logic'],
  language: ['语言', 'Language'],
}

export const SEVERITY: Record<IssueSeverity, Label> = { high: ['严重', 'High'], medium: ['中等', 'Medium'], low: ['轻微', 'Low'] }
export const SEVERITY_TONE: Record<IssueSeverity, Tone> = { high: 'red', medium: 'amber', low: 'neutral' }

export const SUGGESTION_KIND: Record<Suggestion['kind'], Label> = {
  'new-character': ['新人物', 'New character'],
  'new-world': ['新设定', 'New world entry'],
  'character-status': ['人物状态', 'Character status'],
  'new-thread': ['新线索', 'New thread'],
  'thread-status': ['线索状态', 'Thread status'],
}

export const AMBIENCE: Record<AmbiencePreset, Label> = {
  none: ['安静', 'Silence'],
  rain: ['雨', 'Rain'],
  storm: ['暴风雨', 'Storm'],
  wind: ['风', 'Wind'],
  night: ['夜', 'Night'],
  forest: ['林间', 'Forest'],
  sea: ['海浪', 'Sea'],
  river: ['溪流', 'River'],
  fire: ['炉火', 'Fire'],
  city: ['城市', 'City'],
  crowd: ['人群', 'Crowd'],
  tavern: ['酒馆', 'Tavern'],
  battle: ['战场', 'Battle'],
  cave: ['洞穴', 'Cave'],
  snow: ['雪原', 'Snow'],
  train: ['列车', 'Train'],
  spaceship: ['飞船', 'Spaceship'],
  tension: ['紧张', 'Tension'],
  serene: ['宁静', 'Serene'],
}

export const CAMERA: Record<CameraMove, Label> = {
  'still': ['静止', 'Still'],
  'zoom-in': ['推近', 'Zoom in'],
  'zoom-out': ['拉远', 'Zoom out'],
  'pan-left': ['左移', 'Pan left'],
  'pan-right': ['右移', 'Pan right'],
  'pan-up': ['上移', 'Pan up'],
  'pan-down': ['下移', 'Pan down'],
}

export const DENSITY: Record<StoryboardDensity, Label> = {
  auto: ['自动', 'Auto'],
  sparse: ['精简', 'Sparse'],
  balanced: ['适中', 'Balanced'],
  dense: ['细密', 'Dense'],
}

export const DENSITY_HINT: Record<StoryboardDensity, Label> = {
  auto: ['由分镜导演决定在哪里换画面', 'The director decides where the picture changes'],
  sparse: ['大约每 25 秒一格，画得少', 'A panel every 25 seconds or so; few pictures'],
  balanced: ['大约每 13 秒一格', 'A panel every 13 seconds or so'],
  dense: ['大约每 6～7 秒一格，画得多', 'A panel every 6-7 seconds; many pictures'],
}

export const TAKE_ISSUE: Record<TakeIssue, Label> = {
  silent: ['没有声音', 'Silent'],
  short: ['可能没念完', 'May be cut short'],
  long: ['念得过长', 'Runs long'],
  drift: ['声线有偏差', 'Voice drifts'],
}

export const TAKE_ISSUE_HINT: Record<TakeIssue, Label> = {
  silent: ['这一句几乎没有声音。', 'This line is all but silent.'],
  short: ['音频比这句话该有的长度短得多，多半只念了一部分。', 'The audio is far shorter than the line needs; most likely only part of it was spoken.'],
  long: ['音频比这句话该有的长度长得多，可能念了多余的内容。', 'The audio is far longer than the line needs; something extra may have been spoken.'],
  drift: ['音高和这个声音平时差得远，听起来可能不像同一个人。', 'The pitch sits far from where this voice usually does; it may not sound like the same person.'],
}

/**
 * What the Host is doing while a click waits for its answer. Requests that
 * are not listed still show as work in progress, under the general wording.
 */
const WAITING: Partial<Record<RpcMethod, Label>> = {
  'voice.audition': ['正在准备试听…', 'Getting the audition ready…'],
  'voice.design': ['正在设计声线…', 'Designing the voice…'],
  'audio.export': ['正在拼接整章音频…', 'Joining the chapter audio…'],
  'audio.build': ['正在开始编排脚本…', 'Starting the script…'],
  'audio.synthesize': ['正在开始合成…', 'Starting the synthesis…'],
  'audio.updateLine': ['正在保存这一句…', 'Saving the line…'],
  'comic.build': ['正在开始编排分镜…', 'Starting the storyboard…'],
  'comic.render': ['正在开始绘制…', 'Starting to draw…'],
  'comic.updatePanel': ['正在保存这一格…', 'Saving the panel…'],
  'image.create': ['正在开始绘图…', 'Starting the picture…'],
  'image.delete': ['正在删除图片…', 'Deleting the picture…'],
  'export.book': ['正在导出全书…', 'Exporting the book…'],
  'project.create': ['正在创建作品…', 'Creating the book…'],
  'project.update': ['正在保存作品信息…', 'Saving the book…'],
  'project.delete': ['正在把这本书移到废纸篓…', 'Moving the book to the trash…'],
  'session.bind': ['正在切换…', 'Switching…'],
  'workspace.create': ['正在建立工作区…', 'Creating the workspace…'],
  'character.save': ['正在保存人物…', 'Saving the character…'],
  'character.delete': ['正在删除人物…', 'Deleting the character…'],
  'world.save': ['正在保存设定…', 'Saving the entry…'],
  'world.delete': ['正在删除设定…', 'Deleting the entry…'],
  'style.save': ['正在保存文风…', 'Saving the style…'],
  'style.delete': ['正在删除文风…', 'Deleting the style…'],
  'outline.apply': ['正在更新大纲…', 'Updating the outline…'],
  'chapter.restore': ['正在恢复这个版本…', 'Restoring the version…'],
  'proposal.accept': ['正在采纳修订…', 'Applying the revision…'],
  'proposal.reject': ['正在驳回修订…', 'Rejecting the revision…'],
  'suggestion.accept': ['正在采纳建议…', 'Accepting the suggestion…'],
  'suggestion.dismiss': ['正在忽略建议…', 'Dismissing the suggestion…'],
  'review.resolve': ['正在更新问题状态…', 'Updating the issue…'],
  'play.start': ['导演正在布置开场…', 'The director is setting the scene…'],
  'play.turn': ['角色正在回应…', 'The cast is answering…'],
  'play.voice': ['正在合成这句的语音…', 'Voicing the line…'],
  'play.scene': ['正在绘制场景…', 'Painting the scene…'],
  'play.portrait': ['正在绘制立绘…', 'Painting the portrait…'],
  'play.rewind': ['正在回退一步…', 'Taking the move back…'],
  'play.outcome': ['正在保存…', 'Saving…'],
  'play.delete': ['正在删除幕间…', 'Deleting the interlude…'],
  'settings.update': ['正在保存设置…', 'Saving the settings…'],
  'setup.apply': ['正在验证密钥并配置…', 'Checking the key and setting up…'],
  'setup.dismiss': ['正在保存…', 'Saving…'],
  'endpoint.check': ['正在检查这个接口…', 'Checking the endpoint…'],
  'endpoint.models': ['正在读取模型列表…', 'Listing the models…'],
  'share.update': ['正在更新手机阅读…', 'Updating reading on other devices…'],
  'lock.open': ['正在解锁…', 'Unlocking…'],
  'lock.close': ['正在上锁…', 'Locking…'],
  'lock.change': ['正在更新这本书的开锁方式…', 'Updating how the book opens…'],
  'audio.reshape': ['正在重新整理脚本…', 'Reshaping the script…'],
  'audio.updateCue': ['正在保存这处声音…', 'Saving the sound…'],
  'audio.addCue': ['正在添加声音…', 'Adding the sound…'],
  'cast.settle': ['正在处理这个名字…', 'Settling the name…'],
}

export function waitingLabel(method: RpcMethod): Label {
  return WAITING[method] ?? (method.startsWith('ai.') ? ['正在开始…', 'Starting…'] : ['处理中…', 'Working…'])
}

/** A running job by the technical title its pipeline gave it. */
const JOB_TITLES: [RegExp, Label][] = [
  [/^write$/, ['写作', 'Writing']],
  [/^revise passage$/, ['修订选段', 'Revising a passage']],
  [/^revise chapter$/, ['修订整章', 'Revising the chapter']],
  [/^revise book$/, ['全书修订', 'Revising the book']],
  [/^digest$/, ['收录记忆', 'Digesting']],
  [/^review$/, ['审校', 'Reviewing']],
  [/^derive chapters$/, ['推演后续章节', 'Deriving chapters']],
  [/^derive beats$/, ['推演情节点', 'Deriving beats']],
  [/^what-if$/, ['推演"如果"', 'Exploring a what-if']],
  [/^foundation$/, ['起草设定与开篇大纲', 'Drafting the bible and outline']],
  [/^import$/, ['导入并分析', 'Importing']],
  [/^index$/, ['建立语义索引', 'Indexing']],
  [/^expand /, ['AI 补全设定卡', 'Completing the card']],
  [/^visual anchor /, ['提炼视觉锚点', 'Distilling the visual anchor']],
  [/^extract style$/, ['提炼文风', 'Extracting the style']],
  [/^style sample$/, ['试写文风样段', 'Writing a style sample']],
  [/^illustrate sheet$/, ['绘制人设图', 'Drawing the design sheet']],
  [/^illustrate portrait$/, ['绘制立绘', 'Drawing the portrait']],
  [/^illustrate scene$/, ['绘制插图', 'Drawing the illustration']],
  [/^illustrate location$/, ['绘制场景设定图', 'Drawing the place']],
  [/^illustrate cover$/, ['绘制封面', 'Drawing the cover']],
  [/^illustrate /, ['绘图', 'Drawing']],
  [/^audio script$/, ['编排有声脚本', 'Directing the audio script']],
  [/^synthesize$/, ['合成语音', 'Voicing the lines']],
  [/^audition$/, ['生成试听', 'Recording the audition']],
  [/^design voice$/, ['设计专属声线', 'Designing a voice']],
  [/^storyboard$/, ['编排分镜', 'Storyboarding']],
  [/^draw panels$/, ['绘制分镜画面', 'Drawing the panels']],
  [/^novelize$/, ['把幕间写成章节', 'Novelizing the interlude']],
  [/^sound$/, ['生成环境声、音效与配乐', 'Making the sounds']],
  [/^seal$/, ['加密这本书的全部文件', 'Sealing the book']],
  [/^unseal$/, ['解除这本书的加密', 'Unsealing the book']],
]

/** What a job is, in the author's words. */
export function jobTitle(job: Pick<JobInfo, 'title' | 'kind'>): Label {
  return JOB_TITLES.find(([pattern]) => pattern.test(job.title))?.[1] ?? [job.title, job.title]
}

/** What a job is about: a chapter by its number and title, a character or an entry by name. */
export function jobTarget(job: Pick<JobInfo, 'target'>, project: Pick<ProjectState, 'chapters' | 'characters' | 'world'> | undefined, zh: boolean): string | undefined {
  const ref = job.target
  if (ref === undefined || ref.length === 0) return undefined
  const chapter = project?.chapters.find(item => item.id === ref)
  if (chapter !== undefined) return zh ? `第 ${chapter.index} 章《${chapter.title}》` : `chapter ${chapter.index}, "${chapter.title}"`
  return project?.characters.find(item => item.id === ref)?.name ?? project?.world.find(item => item.id === ref)?.name ?? (/^(play_|job_)/.test(ref) ? undefined : ref)
}

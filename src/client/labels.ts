// SPDX-License-Identifier: LGPL-3.0-or-later
/** Bilingual labels for domain enums, shared by the views. */
import type { RpcMethod } from '../shared/rpc'
import type {
  AmbiencePreset, CameraMove, ChapterStatus, IssueSeverity, IssueType, JobInfo, ProjectState, SceneShot, StoryboardDensity, Suggestion, TakeIssue,
  ThreadKind, ThreadStatus, WorldCategory,
} from '../shared/types'

type Label = [zh: string, en: string]

/** The languages a book is written in, or translated from and into — each by its own name. */
export const LANGUAGES: { value: string; label: string }[] = [
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
]

/** A language by its own name; its tag where it is none the Studio lists. */
export const languageLabel = (tag: string): string => LANGUAGES.find(item => item.value === tag)?.label ?? LANGUAGES.find(item => tag.toLowerCase().startsWith(item.value.toLowerCase()))?.label ?? tag
type Tone = 'neutral' | 'blue' | 'amber' | 'green' | 'red' | 'violet'

/** The kinds an entry of the bible is filed under. */
export const WORLD_CATEGORY: Record<WorldCategory, Label> = {
  setting: ['世界概况', 'Setting'],
  location: ['地点', 'Location'],
  faction: ['势力', 'Faction'],
  system: ['体系', 'System'],
  item: ['物品', 'Item'],
  history: ['历史', 'History'],
  culture: ['文化', 'Culture'],
  rule: ['规则', 'Rule'],
  term: ['名词', 'Term'],
  other: ['其他', 'Other'],
}

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
  'new-thread': ['新线索', 'New thread'],
  'thread-status': ['线索状态', 'Thread status'],
  'bible-edit': ['修改设定', 'Bible change'],
  'alias': ['别名', 'Another name'],
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
  'world.merge': ['正在合并条目…', 'Merging the entries…'],
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
  'batch.stage': ['正在安排批量制作…', 'Laying out the batch…'],
  'batch.text': ['正在安排批量任务…', 'Laying out the batch…'],
  'batch.art': ['正在安排批量绘制…', 'Laying out the batch…'],
  'batch.overview': ['正在读取各章的制作进度…', 'Reading where each chapter stands…'],
}

export function waitingLabel(method: RpcMethod): Label {
  return WAITING[method] ?? (method.startsWith('ai.') ? ['正在开始…', 'Starting…'] : ['处理中…', 'Working…'])
}

/** A running job by the technical title its pipeline gave it. */
const JOB_TITLES: [RegExp, Label][] = [
  [/^write$/, ['写作', 'Writing']],
  [/^translate$/, ['翻译', 'Translating']],
  [/^settle terms$/, ['定译名', 'Settling the names']],
  [/^publish site$/, ['发布成网站', 'Publishing the site']],
  [/^life /, ['写履历', 'Writing a life']],
  [/^ties$/, ['理清关系', 'Working out the ties']],
  [/^tidy world$/, ['整理设定条目', 'Looking the bible over']],
  [/^illustrate item$/, ['绘制物品设定图', 'Drawing the thing']],
  [/^revise passage$/, ['修订选段', 'Revising a passage']],
  [/^revise chapter$/, ['整章重写', 'Writing the chapter over']],
  [/^amend chapter$/, ['按要求改这一章', 'Revising the chapter in place']],
  [/^revise book$/, ['全书修订', 'Revising the book']],
  [/^digest( |$)/, ['收录记忆', 'Digesting']],
  [/^recheck issues$/, ['核对审校意见', 'Checking the review again']],
  [/^sift cast$/, ['筛新名字', 'Sifting the new names']],
  [/^settle suggestions$/, ['审定设定建议', 'Settling the suggestions']],
  [/^reread$/, ['纯净重新收录', 'Reading the book again']],
  [/^art direction$/, ['定画风', 'Setting the art direction']],
  [/^growth /, ['读成长轨迹', 'Reading their growth']],
  [/^signature scenes /, ['找名场面', 'Finding their scenes']],
  [/^look /, ['写它的样子', 'Writing what it looks like']],
  [/^import line$/, ['导入另一条故事线', 'Importing a line of the plot']],
  [/^review$/, ['审校', 'Reviewing']],
  [/^derive chapters( preview)?$/, ['推演后续章节', 'Deriving chapters']],
  [/^derive beats$/, ['推演情节点', 'Deriving beats']],
  [/^beats of text$/, ['照正文更新节拍', 'Reading the beats off the text']],
  [/^plan of text$/, ['照正文更新章纲', 'Setting the plan by the text']],
  [/^review by lead$/, ['照引导审校', 'Reviewing by a lead']],
  [/^plans follow text$/, ['章纲跟上正文', 'Plans catching up with their texts']],
  [/^plans of text$/, ['照正文更新章纲', 'Setting plans by their texts']],
  [/^read the references for a chapter$/, ['查参考文献', 'Reading the references']],
  [/^what-if$/, ['推演"如果"', 'Exploring a what-if']],
  [/^foundation$/, ['起草设定与开篇大纲', 'Drafting the bible and outline']],
  [/^import$/, ['导入并分析', 'Importing']],
  [/^analyze$/, ['分析全书', 'Reading the book']],
  [/^index$/, ['建立语义索引', 'Indexing']],
  [/^expand /, ['AI 补全设定卡', 'Completing the card']],
  [/^appearance /, ['写外貌', 'Writing the appearance']],
  // (What that job was called by an earlier version: versions it left behind are still named by it.)
  [/^visual anchor /, ['写外貌', 'Writing the appearance']],
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
  [/^video$/, ['后期剪视频', 'Post-production is cutting the video']],
  [/^crew analyst$/, ['场记在办一件事', 'Continuity is on a task']],
  [/^crew architect$/, ['策划在办一件事', 'The planner is on a task']],
  [/^crew director$/, ['导演在办一件事', 'The director is on a task']],
  [/^crew producer$/, ['后期在办一件事', 'Post-production is on a task']],
  [/^stage batch$/, ['批量制作', 'Producing in a batch']],
  [/^text batch$/, ['批量写作与整理', 'Working on the text in a batch']],
  [/^art batch$/, ['批量绘制', 'Drawing in a batch']],
  [/^seal$/, ['加密这本书的全部文件', 'Sealing the book']],
  [/^unseal$/, ['解除这本书的加密', 'Unsealing the book']],
]

/** The steps a batch is made of, in the author's words. */
export const BATCH_STEP: Record<string, Label> = {
  script: ['脚本', 'Script'],
  voice: ['配音', 'Voices'],
  sound: ['声音', 'Sound'],
  storyboard: ['分镜', 'Storyboard'],
  panels: ['画面', 'Panels'],
  video: ['成片', 'Video'],
  beats: ['节拍', 'Beats'],
  write: ['写作', 'Writing'],
  digest: ['收录', 'Memory'],
  review: ['审校', 'Review'],
  sheet: ['人设图', 'Design sheet'],
  portrait: ['立绘', 'Portrait'],
  place: ['场景设定图', 'Place art'],
  item: ['物品设定图', 'Thing art'],
  scene: ['插图', 'Illustration'],
  cover: ['封面', 'Cover'],
}

/** What a step of the stage does, for whoever chooses which to run. */
export const STAGE_STEP_HINT: Record<string, Label> = {
  script: ['导演把正文编成逐句的台词、旁白和声音提示', 'The director turns the prose into lines, narration and sound cues'],
  voice: ['给每一句配上人声，同一个人全书一个声音', 'Every line gets its voice; one speaker, one voice for the whole book'],
  sound: ['按脚本里的提示生成环境声、音效和配乐', 'Ambience, effects and music made from the script\'s cues'],
  storyboard: ['导演把脚本排成一格格画面', 'The director arranges the script into panels'],
  panels: ['把每一格画出来', 'Every panel is drawn'],
  video: ['后期 agent 把配音、声音和画面剪成一个视频文件', 'Post-production cuts voice, sound and pictures into a video file'],
}

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

/**
 * What a picture's job says of the design sheets it drew first — for the
 * note that says the picture is done: a sheet drawn for it is never drawn
 * behind the author's back.
 * @returns an empty string where none was drawn.
 */
/**
 * Which moment of the book a portrait shows, as its job says: the director's pick or what the card had — or that the
 * director found none, and the portrait is plain.
 */
export interface PortraitScene {
  text?: string
  title?: string
  /** One of the card's moments, drawn as it stands. */
  id?: string
  /** The director found the person's moments just now — this many — and this is the first. */
  found?: number
  /** The director settled it for this picture alone, guided by this — what the author asked of the picture. */
  asked?: string
  /** The chapter it is from, by id. */
  chapter?: string
  /** Why this moment, in the director's words. */
  why?: string
  /** The one frame the director made of it for the picture. */
  shot?: SceneShot
  /** No frame could be made of it, and why: drawn of the moment as it is told. */
  unframed?: string
  none?: string
}

export function sceneOf(job: { result?: Record<string, unknown> } | undefined): PortraitScene | undefined {
  const scene = job?.result?.scene
  if (typeof scene !== 'object' || scene === null) return undefined
  const { text, title, id, found, asked, chapter, why, none, shot, unframed } = scene as Record<string, unknown>
  const said = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  const framed = typeof shot === 'object' && shot !== null && said((shot as { action?: unknown }).action) && said((shot as { of?: unknown }).of) ? shot as SceneShot : undefined
  if (said(text)) return { text, ...(said(title) ? { title } : {}), ...(said(id) ? { id } : {}), ...(typeof found === 'number' ? { found } : {}), ...(said(asked) ? { asked } : {}), ...(said(chapter) ? { chapter } : {}), ...(said(why) ? { why } : {}), ...(framed !== undefined ? { shot: framed } : {}), ...(said(unframed) ? { unframed } : {}) }
  return typeof none === 'string' ? { none } : undefined
}

/**
 * Said with a picture once it is there: reference pictures the image service did not take with it — none of them, or
 * those over its measure. Said after, never before: what a service takes is shown by drawing. Empty where all went along.
 */
export function leftBehind(job: { result?: Record<string, unknown> } | undefined, t: (zh: string, en: string) => string): string {
  const left = job?.result?.left
  if (typeof left !== 'object' || left === null) return ''
  const { names, taken } = left as { names?: unknown; taken?: unknown }
  const who = Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
  if (who.length === 0) return ''
  return typeof taken === 'number' && taken > 0
    ? t(`（绘图服务一次只收 ${taken} 张参考图：${who.join('、')}的没带上）`, ` (the image service takes ${taken} reference picture${taken === 1 ? '' : 's'} at a time: ${who.join(', ')} stayed behind)`)
    : t('（绘图服务没收参考图：只照文字画的）', ' (the image service took no reference picture: drawn from the words alone)')
}

/** What was drawn for a picture besides itself — a sheet first, or after — and what did not go along with it ({@link leftBehind}). */
export function sheetsDrawn(job: { result?: Record<string, unknown> } | undefined, t: (zh: string, en: string) => string): string {
  const names = Array.isArray(job?.result?.sheets) ? job.result.sheets.filter((name): name is string => typeof name === 'string') : []
  // A portrait that leads has the sheet drawn after it, against it.
  const after = Array.isArray(job?.result?.sheetsAfter) ? job.result.sheetsAfter.filter((name): name is string => typeof name === 'string') : []
  const left = leftBehind(job, t)
  // (Where the service took no picture, the sheet that followed was not drawn against the portrait: it is not said to be.)
  if (after.length > 0) return `${left.length > 0 ? t('（补了人设图）', ' (and the design sheet)') : t('（照着它补了人设图）', ' (and the design sheet, drawn against it)')}${left}`
  return `${names.length > 0 ? t(`（先画了${names.map(name => `「${name}」`).join('、')}的人设图）`, ` (first drew the design sheet of ${names.join(', ')})`) : ''}${left}`
}

/**
 * Why a version of a card, an entry, a plan was kept: what changed the thing after it (`Project.keep`) — the author,
 * the showrunner, a version put back, its deletion, or a job, by the title its pipeline gave it.
 */
export function whyLabel(why: string, t: (zh: string, en: string) => string): string {
  if (why === 'edit') return t('你修改之前', 'Before your edit')
  if (why === 'agent') return t('总编修改之前', 'Before the showrunner changed it')
  if (why === 'restore') return t('恢复旧版本之前', 'Before a version was put back')
  if (why === 'removed') return t('删除之前', 'Before it was deleted')
  if (why === 'job' || why.startsWith('job-')) {
    // A title comes here with everything but its Latin words worn off: "card walk-ons 沈蘅" is "card-walk-ons".
    const raw = why.slice(4)
    const spaced = raw.replace(/-/g, ' ')
    const known = [raw, spaced, `${spaced} `].map(title => JOB_TITLES.find(([pattern]) => pattern.test(title))?.[1]).find(label => label !== undefined)
    const what = known !== undefined ? t(...known) : spaced
    return what.length > 0 ? t(`"${what}"修改之前`, `Before "${what}" changed it`) : t('一项任务修改之前', 'Before a task changed it')
  }
  return why
}

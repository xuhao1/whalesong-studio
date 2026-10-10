// SPDX-License-Identifier: LGPL-3.0-or-later
/** Renders bible entries and plans as compact prompt text, in the manuscript language. */
import type {
  Beat, ChapterMemory, ChapterPlan, CharacterCard, CharacterMoment, PlotThread, ProjectManifest, PromptLanguage, StyleProfile, WorldEntry,
} from '../shared/types'

export function promptLanguage(language: string): PromptLanguage {
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** Pick the string for the prompt language. */
export function L(lang: PromptLanguage, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

/** Human name of the manuscript language for "write in …" instructions. */
export function languageName(language: string): string {
  const tag = language.toLowerCase()
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hant')) return '繁體中文'
  if (tag.startsWith('zh')) return '简体中文'
  if (tag.startsWith('en')) return 'English'
  if (tag.startsWith('ja')) return '日本語'
  if (tag.startsWith('ko')) return '한국어'
  if (tag.startsWith('fr')) return 'Français'
  if (tag.startsWith('de')) return 'Deutsch'
  if (tag.startsWith('es')) return 'Español'
  if (tag.startsWith('ru')) return 'Русский'
  return language
}

const ROLE_LABEL: Record<CharacterCard['role'], [string, string]> = {
  protagonist: ['主角', 'protagonist'],
  deuteragonist: ['第二主角', 'deuteragonist'],
  antagonist: ['反派', 'antagonist'],
  supporting: ['配角', 'supporting'],
  minor: ['次要角色', 'minor'],
  cameo: ['龙套', 'cameo'],
}

export function roleLabel(role: CharacterCard['role'], lang: PromptLanguage): string {
  return ROLE_LABEL[role][lang === 'zh' ? 0 : 1]
}

function line(label: string, value: string | undefined, lang: PromptLanguage): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  return `${label}${lang === 'zh' ? '：' : ': '}${value.trim()}`
}

function join(parts: (string | undefined)[], separator = '\n'): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(separator)
}

/**
 * @param story - a line of the plot that is a story of its own from the first page: the book's logline and premise are
 *   the main line's story, so this line's name and what it is about stand in their place.
 */
export function renderManifest(manifest: ProjectManifest, lang: PromptLanguage, story?: { title: string; premise?: string | undefined }): string {
  return join([
    line(L(lang, '书名', 'Title'), manifest.title, lang),
    line(L(lang, '类型', 'Genre'), manifest.genre, lang),
    ...(story !== undefined
      ? [line(L(lang, '这条故事线', 'This line of the plot'), story.title, lang), line(L(lang, '这条线讲的是', 'What this line tells'), story.premise, lang)]
      : [line(L(lang, '一句话梗概', 'Logline'), manifest.logline, lang), line(L(lang, '故事核', 'Premise'), manifest.premise, lang)]),
    line(L(lang, '主题', 'Themes'), manifest.themes?.join(lang === 'zh' ? '、' : ', '), lang),
    line(L(lang, '作者备注', 'Author notes'), manifest.notes, lang),
  ])
}

/** A character card as the writer should read it. `resolveName` maps relationship targets to names. */
export function renderCharacter(card: CharacterCard, lang: PromptLanguage, options: { brief?: boolean; resolveName?: (ref: string) => string } = {}): string {
  const sep = lang === 'zh' ? ' · ' : ' · '
  const head = `【${card.name}】${lang === 'zh' ? '（' : ' ('}${join([roleLabel(card.role, lang), card.gender, card.age], sep)}${lang === 'zh' ? '）' : ')'}${card.aliases !== undefined && card.aliases.length > 0 ? ` ${L(lang, '又称', 'aka')} ${card.aliases.join('/')}` : ''}`
  if (options.brief === true) return join([head, card.tagline], lang === 'zh' ? ' ' : ' — ')
  const persona = card.persona
  const relationships = card.relationships?.map((relation) => {
    const target = options.resolveName?.(relation.target) ?? relation.target
    return `${target}(${relation.kind}${relation.note !== undefined ? `，${relation.note}` : ''})`
  }).join(lang === 'zh' ? '；' : '; ')
  return join([
    head,
    line(L(lang, '定位', 'Who'), card.tagline, lang),
    line(L(lang, '外貌', 'Appearance'), card.appearance, lang),
    line(L(lang, '性格', 'Personality'), card.personality, lang),
    line(L(lang, '特质', 'Traits'), persona?.traits?.map(trait => trait.level !== undefined ? `${trait.name}(${trait.level}/5)` : trait.name).join(lang === 'zh' ? '、' : ', '), lang),
    line(L(lang, '看重', 'Values'), persona?.values?.join(' > '), lang),
    line(L(lang, '背景', 'Background'), card.background, lang),
    line(L(lang, '动机', 'Motivation'), card.motivation, lang),
    line(L(lang, '弱点', 'Flaw'), card.flaw, lang),
    line(L(lang, '人物弧光', 'Arc'), card.arc, lang),
    line(L(lang, '说话方式', 'Voice'), join([card.voice, persona?.speech?.join(lang === 'zh' ? '；' : '; ')], lang === 'zh' ? '；' : '; '), lang),
    line(L(lang, '压力下', 'Under pressure'), persona?.underPressure, lang),
    line(L(lang, '绝不会', 'Would never'), persona?.taboos?.join(lang === 'zh' ? '；' : '; '), lang),
    line(L(lang, '能力', 'Abilities'), card.abilities, lang),
    line(L(lang, '关系', 'Relationships'), relationships, lang),
    line(L(lang, '秘密（他人未必知晓）', 'Secrets (others may not know)'), card.secrets, lang),
    line(L(lang, '备注', 'Notes'), card.notes, lang),
  ])
}

export function renderMoment(moment: CharacterMoment, chapterLabel: string, lang: PromptLanguage): string {
  return join([
    `${L(lang, '截至', 'As of')} ${chapterLabel}`,
    line(L(lang, '处境', 'State'), moment.stateAfter, lang),
    line(L(lang, '所在', 'Location'), moment.location, lang),
    line(L(lang, '情绪', 'Mood'), moment.emotion, lang),
    line(L(lang, '新得知', 'Just learned'), moment.learned?.join(lang === 'zh' ? '；' : '; '), lang),
  ], lang === 'zh' ? '；' : '; ')
}

export function renderWorld(entry: WorldEntry, lang: PromptLanguage, options: { brief?: boolean } = {}): string {
  const head = `〔${entry.name}〕${entry.aliases !== undefined && entry.aliases.length > 0 ? `(${entry.aliases.join('/')})` : ''}`
  if (options.brief === true || entry.body === undefined || entry.body.length === 0) return join([head, entry.summary ?? entry.body], ' ')
  return join([`${head} ${entry.summary ?? ''}`.trim(), entry.body])
}

const POV_LABEL: Record<NonNullable<StyleProfile['pov']>, [string, string]> = {
  'first': ['第一人称', 'first person'],
  'third-limited': ['第三人称有限视角（紧贴视角人物，只写其所见所感所知）', 'third person limited (stay inside the viewpoint character)'],
  'third-omniscient': ['第三人称全知视角', 'third person omniscient'],
  'second': ['第二人称', 'second person'],
  'multi': ['多视角轮换（每个场景只用一个视角，换视角须换场景）', 'rotating viewpoints (one viewpoint per scene; switch only at scene breaks)'],
}

/** How much of the style block the author's samples may take, in characters: all of them when they are short, the first ones when they are long. */
const EXEMPLAR_CHARS = 9000

/** The items from the front that fit a size together; the first always does. */
function fitting<T>(items: readonly T[], size: (item: T) => number, room: number): T[] {
  const out: T[] = []
  let used = 0
  for (const item of items) {
    if (out.length > 0 && used + size(item) > room) break
    out.push(item)
    used += size(item)
  }
  return out
}

/** A style profile as instructions to the writer. */
export function renderStyle(style: StyleProfile | undefined, lang: PromptLanguage): string {
  if (style === undefined) return L(lang, '（未设定文风：使用克制、具体、有画面感的现代小说笔法。）', '(No style set: write restrained, concrete, sensory modern prose.)')
  const bullets = (items: string[] | undefined): string | undefined => items !== undefined && items.length > 0 ? items.map(item => `- ${item}`).join('\n') : undefined
  const exemplars = fitting(style.exemplars ?? [], exemplar => exemplar.text.length, EXEMPLAR_CHARS).map((exemplar, index) => `${L(lang, '范文', 'Sample')} ${index + 1}${exemplar.label !== undefined ? ` (${exemplar.label})` : ''}:\n"""\n${exemplar.text.trim()}\n"""`).join('\n\n')
  return join([
    line(L(lang, '文风', 'Style'), style.name, lang),
    line(L(lang, '叙事视角', 'Point of view'), style.pov !== undefined ? POV_LABEL[style.pov][lang === 'zh' ? 0 : 1] : undefined, lang),
    line(L(lang, '时态', 'Tense'), style.tense === undefined ? undefined : style.tense === 'past' ? L(lang, '过去时叙述', 'past tense') : L(lang, '现在时叙述', 'present tense'), lang),
    line(L(lang, '语体（全文都用它写）', 'Register (all of the text is written in it)'), style.register, lang),
    line(L(lang, '基调', 'Tone'), style.tone, lang),
    line(L(lang, '用词', 'Diction'), style.diction, lang),
    line(L(lang, '节奏', 'Rhythm'), style.rhythm, lang),
    line(L(lang, '意象与修辞', 'Imagery'), style.imagery, lang),
    line(L(lang, '对白', 'Dialogue'), style.dialogue, lang),
    line(L(lang, '推进', 'Pacing'), style.pacing, lang),
    bullets(style.rules) !== undefined ? `${L(lang, '必须做到', 'Always')}:\n${bullets(style.rules)}` : undefined,
    bullets(style.avoid) !== undefined ? `${L(lang, '必须避免', 'Never')}:\n${bullets(style.avoid)}` : undefined,
    style.body,
    exemplars !== undefined && exemplars.length > 0 ? `${L(lang, '以下范文只用于体会笔触，不要照搬其内容', 'The samples below show the touch only; do not reuse their content')}:\n${exemplars}` : undefined,
  ])
}

function renderBeat(beat: Beat, index: number, lang: PromptLanguage, nameOf: (ref: string) => string): string {
  const details = join([
    beat.characters !== undefined && beat.characters.length > 0 ? `${L(lang, '人物', 'with')}: ${beat.characters.map(nameOf).join(lang === 'zh' ? '、' : ', ')}` : undefined,
    beat.location !== undefined ? `${L(lang, '地点', 'at')}: ${beat.location}` : undefined,
    beat.conflict !== undefined ? `${L(lang, '冲突', 'conflict')}: ${beat.conflict}` : undefined,
    beat.outcome !== undefined ? `${L(lang, '结果', 'outcome')}: ${beat.outcome}` : undefined,
    beat.emotion !== undefined ? `${L(lang, '情绪', 'emotion')}: ${beat.emotion}` : undefined,
  ], lang === 'zh' ? '；' : '; ')
  return `${index + 1}. ${beat.summary}${details.length > 0 ? `\n   (${details})` : ''}`
}

/** A chapter plan as the brief the writer works from. */
export function renderPlan(plan: ChapterPlan, index: number, lang: PromptLanguage, nameOf: (ref: string) => string = ref => ref): string {
  return join([
    `${L(lang, `第 ${index} 章`, `Chapter ${index}`)}${lang === 'zh' ? '：' : ': '}${plan.title}`,
    line(L(lang, '梗概', 'Synopsis'), plan.synopsis, lang),
    line(L(lang, '本章作用', 'Purpose'), plan.purpose, lang),
    line(L(lang, '视角人物', 'Viewpoint'), plan.pov !== undefined ? nameOf(plan.pov) : undefined, lang),
    line(L(lang, '地点', 'Location'), plan.location, lang),
    line(L(lang, '故事时间', 'Story time'), plan.time, lang),
    line(L(lang, '出场人物', 'Cast'), plan.characters?.map(nameOf).join(lang === 'zh' ? '、' : ', '), lang),
    plan.beats !== undefined && plan.beats.length > 0 ? `${L(lang, '节拍', 'Beats')}:\n${plan.beats.map((beat, at) => renderBeat(beat, at, lang, nameOf)).join('\n')}` : undefined,
    line(L(lang, '备注', 'Notes'), plan.notes, lang),
  ])
}

export function renderThread(thread: PlotThread, lang: PromptLanguage, chapterLabel: (id: string) => string): string {
  const where = join([
    thread.planted !== undefined && thread.planted.length > 0 ? `${L(lang, '埋于', 'planted in')} ${thread.planted.map(chapterLabel).join(', ')}` : undefined,
    thread.advanced !== undefined && thread.advanced.length > 0 ? `${L(lang, '推进于', 'advanced in')} ${thread.advanced.map(chapterLabel).join(', ')}` : undefined,
  ], lang === 'zh' ? '；' : '; ')
  return `- [${thread.kind}] ${thread.title}${thread.description !== undefined ? `${lang === 'zh' ? '：' : ': '}${thread.description}` : ''}${where.length > 0 ? ` (${where})` : ''}`
}

export function renderMemorySummary(memory: ChapterMemory, label: string, full: boolean): string {
  return `${label}  ${full ? memory.summary : memory.brief}`
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Every prompt the pipelines send, in one place. Prompts come in Chinese and
 * English; the manuscript language picks the variant (anything that is not
 * Chinese gets the English prompt plus an explicit output-language rule).
 */
import type { PromptLanguage } from '../shared/types'
import { L, languageName } from './render'

interface Base {
  lang: PromptLanguage
  /** Manuscript language tag, for the "write in …" rule. */
  language: string
  title: string
}

/** A title without the marks its author may have typed around it; the prompts put their own. */
const bare = (title: string): string => title.trim().replace(/^[《「『“"]+|[》」』”"]+$/gu, '').trim() || title

const outputRule = (base: Base): string => L(
  base.lang,
  `正文语言：${languageName(base.language)}。`,
  `Write the prose in ${languageName(base.language)}.`,
)

// ───────────────────────────── writing ─────────────────────────────

export function writerSystem(base: Base & { style: string; words: number; continuing: boolean }): string {
  return L(base.lang, `你是一位功力深厚的小说家，正在为长篇小说《${bare(base.title)}》执笔。编辑会给你设定、前情与本章章纲，你写出可以直接付印的正文。

【写作纪律】
1. 只输出小说正文本身。不要标题、章节号、提纲、解释、括号批注，也不要"以下是正文"之类的话。
2. 设定集与前文已发生的事实是铁律。人物的言行必须出自其人格、处境与此刻已知的信息——不知道的事不能说，也不能据此行动。
3. 章纲里的节拍必须全部发生，但要像故事一样自然生长：补上过渡、细节、潜台词与人物之间的张力，不要把章纲逐条翻译成句子。不得擅自改变剧情走向，不得引入章纲之外的重大事件或新的重要角色。
4. 多人同场时，每个出场人物都要有符合身份的动作、立场和不可替代的作用，不要让谁沦为背景板。
5. 写到本章应当结束的地方就停，不要预支后面章节的情节，不要在结尾总结或升华。
6. ${base.continuing ? '你是在续写：从已有正文的最后一个字之后接着写，不要重复已有内容，衔接处不能看出缝。' : '从本章第一句开始写。'}
7. 篇幅：约 ${base.words} 字（上下浮动 15% 以内）。
8. ${outputRule(base)}

【文风】
${base.style}`, `You are an accomplished novelist writing the novel "${bare(base.title)}". Your editor gives you the story bible, the story so far and this chapter's outline; you deliver prose that could go to print as is.

RULES
1. Output the prose only. No title, chapter number, outline, explanation, bracketed notes or lead-in.
2. The story bible and everything already written are law. Characters act and speak from their personality, situation and what they know right now — they cannot say or use what they have not learned.
3. Every beat in the outline must happen, but let it grow like a story: add transitions, texture, subtext and friction between people. Do not translate the outline line by line. Do not change where the plot goes or introduce major events or major characters the outline does not have.
4. When several characters share a scene, each needs a stance, an action and a reason to be there. Nobody is furniture.
5. Stop where this chapter should end. Do not write ahead into later chapters, and do not summarize or moralize at the end.
6. ${base.continuing ? 'You are continuing: pick up right after the last word of the existing text, repeat nothing, and leave no seam.' : 'Start from the first sentence of the chapter.'}
7. Length: about ${base.words} words (within 15%).
8. ${outputRule(base)}

STYLE
${base.style}`)
}

export function writerTask(base: Base & { context: string; brief?: string; continuing: boolean }): string {
  const brief = base.brief !== undefined && base.brief.trim().length > 0
    ? L(base.lang, `\n\n## 编辑对本次写作的要求\n\n${base.brief.trim()}`, `\n\n## The editor's brief for this pass\n\n${base.brief.trim()}`)
    : ''
  return `${base.context}${brief}\n\n---\n${L(
    base.lang,
    base.continuing ? '现在接着"本章已有正文"往下写，直接输出续写的正文。' : '现在写这一章，直接输出正文。',
    base.continuing ? 'Continue from "This chapter so far". Output the continuation only.' : 'Write this chapter now. Output the prose only.',
  )}`
}

export function reviseSpanSystem(base: Base & { style: string }): string {
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的作者，正在按编辑的意见改稿。你会看到设定、上下文、一段需要修改的原文和修改要求。

规则：
1. 只输出修改后的那段文字，用来原样替换原文。不要解释，不要引号包裹，不要输出原文以外的上下文。
2. 改动要服从修改要求；要求之外的内容尽量保留原意与信息量，前后必须与未改动的上下文严丝合缝（人称、时态、语气、衔接）。
3. 不得违背设定与前文事实。
4. ${outputRule(base)}

【文风】
${base.style}`, `You are the author of the novel "${bare(base.title)}", revising to your editor's note. You get the bible, the surrounding text, the passage to change and the instruction.

Rules:
1. Output only the rewritten passage, ready to replace the original as is. No explanation, no surrounding quotes, nothing outside the passage.
2. Follow the instruction; keep everything it does not ask to change, and make the result join the untouched text on both sides seamlessly (person, tense, voice).
3. Never contradict the bible or earlier chapters.
4. ${outputRule(base)}

STYLE
${base.style}`)
}

export function reviseSpanTask(base: Base & { context: string; before: string; passage: string; after: string; instruction: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, '## 待修改段落之前的原文', '## Text before the passage')}\n\n${base.before || L(base.lang, '（本章开头）', '(start of chapter)')}\n\n${L(base.lang, '## 需要修改的段落', '## The passage to rewrite')}\n\n<<<\n${base.passage}\n>>>\n\n${L(base.lang, '## 待修改段落之后的原文', '## Text after the passage')}\n\n${base.after || L(base.lang, '（本章结尾）', '(end of chapter)')}\n\n${L(base.lang, '## 修改要求', '## Instruction')}\n\n${base.instruction}\n\n---\n${L(base.lang, '输出修改后的段落（只输出这一段）。', 'Output the rewritten passage only.')}`
}

export function reviseChapterSystem(base: Base & { style: string }): string {
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的作者，正在按编辑的意见重写一整章。你会看到设定、前情、本章现有正文与修改要求。

规则：
1. 输出修改后的完整一章正文，只输出正文，不要标题和任何说明。
2. 按修改要求改；要求没有涉及的情节、信息和好句子尽量保留，不要无故删减篇幅或改写无关段落。
3. 不得违背设定与前文事实，不得改变本章在全书中的剧情功能（除非修改要求明确如此）。
4. ${outputRule(base)}

【文风】
${base.style}`, `You are the author of the novel "${bare(base.title)}", rewriting a whole chapter to your editor's note. You get the bible, the story so far, the chapter as it stands and the instruction.

Rules:
1. Output the complete revised chapter — prose only, no title, no commentary.
2. Follow the instruction; keep plot points, information and good lines it does not touch. Do not shorten the chapter or rewrite unrelated passages without cause.
3. Never contradict the bible or earlier chapters, and keep the chapter's job in the book unless the instruction says otherwise.
4. ${outputRule(base)}

STYLE
${base.style}`)
}

export function reviseChapterTask(base: Base & { context: string; instruction: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, '## 修改要求', '## Instruction')}\n\n${base.instruction}\n\n---\n${L(base.lang, '输出修改后的完整一章正文。', 'Output the complete revised chapter.')}`
}

/** Decide which chapters a book-wide instruction touches. */
export function triageTask(base: Base & { instruction: string; chapters: string }): string {
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的责任编辑。作者提出了一条针对全书的修改要求，请判断哪些章节需要因此改动。

## 修改要求

${base.instruction}

## 各章摘要

${base.chapters}

只输出 JSON：
{"chapters": [{"index": 章节序号, "reason": "这一章需要怎么改（一句话，具体到位）"}], "note": "给作者的总体说明，可为空"}
只列出确实需要改动的章节；如果要求是全局性的文风调整，可以列出全部有正文的章节。`, `You are the editor of the novel "${bare(base.title)}". The author asks for a book-wide change. Decide which chapters must change because of it.

## The requested change

${base.instruction}

## Chapter summaries

${base.chapters}

Output JSON only:
{"chapters": [{"index": chapter number, "reason": "what must change in this chapter, one concrete sentence"}], "note": "overall note for the author, may be empty"}
List only chapters that really need to change; a global style change may list every written chapter.`)
}

// ───────────────────────────── memory ─────────────────────────────

export function digestSystem(lang: PromptLanguage): string {
  return L(lang, '你是严谨的小说连续性编辑（场记）。只依据给出的章节正文提取事实，不推测、不评价、不续写。严格按要求输出 JSON。', 'You are a meticulous continuity editor. Extract facts only from the chapter text given — no speculation, no critique, no continuation. Output JSON exactly as requested.')
}

export function digestTask(base: Base & { chapterLabel: string; text: string; knownCharacters: string; knownWorld: string; openThreads: string }): string {
  return L(base.lang, `下面是长篇小说《${bare(base.title)}》${base.chapterLabel}的正文。请做场记。

## 已建档人物（姓名 | 别名）
${base.knownCharacters || '（暂无）'}

## 已建档设定条目
${base.knownWorld || '（暂无）'}

## 尚未回收的线索
${base.openThreads || '（暂无）'}

## 正文
"""
${base.text}
"""

输出 JSON（所有字段都要有，没有内容用空数组或空字符串）：
{
  "brief": "一句话概括本章发生了什么（40字内）",
  "summary": "200-350字的章节摘要：按时间顺序写清谁在哪里做了什么、结果如何、留下什么悬念",
  "storyTime": "本章的故事内时间，文中没有则留空",
  "locations": ["出现的地点"],
  "characters": [
    {"name": "人物姓名（用已建档姓名；新人物用文中称呼）", "role": "他/她在本章做了什么", "stateAfter": "章末处境：身体、情绪、资源、决心等", "location": "章末所在", "emotion": "章末主导情绪", "learned": ["本章新得知的关键信息"], "quote": "一句最能体现其说话方式的原文台词，没有则空", "lifecycle": "enter|exit|death|return 之一，本章首次登场用 enter，离开故事舞台用 exit，死亡用 death，久别重返用 return，否则留空"}
  ],
  "facts": [
    {"subject": "主体", "statement": "本章确立、今后必须保持一致的事实", "kind": "state|relationship|knowledge|item|world|event"}
  ],
  "newEntities": [
    {"name": "名称", "kind": "character|location|item|faction|term", "description": "正文中首次出现、值得建档的人物/地点/物品/组织/专有名词，一句话说明"}
  ],
  "threads": [
    {"title": "线索或伏笔的名称（若对应上面已有线索，用原名）", "action": "plant|advance|payoff", "note": "本章如何埋下/推进/回收"}
  ],
  "openQuestions": ["读者此刻会追问的问题"]
}
facts 只收对后文有约束力的硬事实（8-15条），不要把情节复述成事实。只输出 JSON。`, `Below is ${base.chapterLabel} of the novel "${bare(base.title)}". Take continuity notes.

## Characters on file (name | aliases)
${base.knownCharacters || '(none)'}

## World entries on file
${base.knownWorld || '(none)'}

## Open threads
${base.openThreads || '(none)'}

## Text
"""
${base.text}
"""

Output JSON (every field present; use empty arrays or strings when there is nothing):
{
  "brief": "one sentence: what happened in this chapter",
  "summary": "120-220 words in chronological order: who did what where, how it turned out, what is left hanging",
  "storyTime": "in-story time of the chapter, empty if the text gives none",
  "locations": ["places that appear"],
  "characters": [
    {"name": "use the name on file; for new people the name used in the text", "role": "what they did in this chapter", "stateAfter": "condition at chapter end: body, mood, resources, resolve", "location": "where they end up", "emotion": "dominant emotion at chapter end", "learned": ["key things they learned here"], "quote": "one line of theirs that best shows how they talk, or empty", "lifecycle": "one of enter|exit|death|return — enter on first appearance, exit when leaving the story, death, return after a long absence — else empty"}
  ],
  "facts": [
    {"subject": "who or what", "statement": "a fact established here that later chapters must respect", "kind": "state|relationship|knowledge|item|world|event"}
  ],
  "newEntities": [
    {"name": "name", "kind": "character|location|item|faction|term", "description": "a person/place/object/group/term that first appears here and deserves a bible entry, one sentence"}
  ],
  "threads": [
    {"title": "name of the thread or foreshadowing (reuse the exact name when it matches an open thread)", "action": "plant|advance|payoff", "note": "how this chapter plants / advances / pays it off"}
  ],
  "openQuestions": ["questions a reader is asking right now"]
}
Keep facts to the 8-15 hard facts that bind later chapters; do not restate the plot as facts. Output JSON only.`)
}

export function arcTask(base: Base & { range: string; summaries: string }): string {
  return L(base.lang, `把长篇小说《${bare(base.title)}》${base.range}的章节摘要压缩成一段 300-500 字的阶段梗概。保留：主线推进、人物关系与处境的关键变化、埋下而未解的线索、重要的设定揭示。按时间顺序，只输出梗概本身。

${base.summaries}`, `Compress the chapter summaries of ${base.range} of the novel "${bare(base.title)}" into one synopsis of 200-320 words. Keep: main-plot movement, key changes in relationships and situations, threads planted and still open, important world reveals. Chronological order; output the synopsis only.

${base.summaries}`)
}

// ───────────────────────────── plotting ─────────────────────────────

export function architectSystem(lang: PromptLanguage): string {
  return L(lang, '你是经验丰富的小说策划与故事架构师，擅长长篇结构、人物驱动的情节和伏笔布局。你的方案具体、有因果、有取舍，从不写空话。严格按要求输出 JSON。', 'You are a seasoned story architect: long-form structure, character-driven plotting, setup and payoff. Your plans are concrete and causal, never vague. Output JSON exactly as requested.')
}

export function deriveChaptersTask(base: Base & { context: string; count: number; direction?: string; volume: string }): string {
  const direction = base.direction !== undefined && base.direction.trim().length > 0 ? L(base.lang, `\n\n## 作者给的方向\n\n${base.direction.trim()}`, `\n\n## Direction from the author\n\n${base.direction.trim()}`) : ''
  return `${base.context}${direction}\n\n---\n${L(base.lang, `请为《${bare(base.title)}》的「${base.volume}」推演接下来的 ${base.count} 章章纲。要求：
- 从已写内容和人物此刻的处境、欲望出发推演，情节由人物的选择推动，每章都有不可逆的变化；
- 兼顾群像：让久未出场但仍有未了之事的人物合理回归，不要让所有戏都压在主角身上；
- 主动推进或回收"尚未回收的线索"，新埋的伏笔要有后续打算；
- 相邻章节之间有因果链，节奏有张有弛。

只输出 JSON：
{"chapters": [{"title": "章名", "synopsis": "120-200字梗概", "purpose": "这一章对全书的作用", "pov": "视角人物姓名", "location": "主要地点", "time": "故事时间", "characters": ["出场人物姓名"], "beats": [{"summary": "节拍：谁想要什么、遇到什么阻碍、如何转折", "conflict": "冲突", "outcome": "结果"}], "threads": [{"title": "线索名", "action": "plant|advance|payoff"}]}], "rationale": "这样安排的理由与可选的其他走向（给作者看）"}
每章 3-6 个节拍。`, `Derive the outlines of the next ${base.count} chapters of "${bare(base.title)}", volume "${base.volume}". Requirements:
- Start from what is written and from what each character wants right now; choices drive the plot and every chapter changes something for good.
- Serve the ensemble: bring back characters with unfinished business who have been off the page; do not hang every scene on the lead.
- Advance or pay off open threads; any new setup needs a plan.
- Adjacent chapters are causally linked; vary the pace.

Output JSON only:
{"chapters": [{"title": "chapter title", "synopsis": "80-130 word synopsis", "purpose": "what the chapter does for the book", "pov": "viewpoint character name", "location": "main location", "time": "story time", "characters": ["names of characters appearing"], "beats": [{"summary": "beat: who wants what, what blocks them, how it turns", "conflict": "conflict", "outcome": "outcome"}], "threads": [{"title": "thread name", "action": "plant|advance|payoff"}]}], "rationale": "why this arrangement, and alternatives worth considering (for the author)"}
3-6 beats per chapter.`)}`
}

export function deriveBeatsTask(base: Base & { context: string; direction?: string }): string {
  return `${base.context}${base.direction !== undefined && base.direction.trim().length > 0 ? `\n\n${L(base.lang, '## 作者给的方向', '## Direction from the author')}\n\n${base.direction.trim()}` : ''}\n\n---\n${L(base.lang, `请把"本章章纲"细化成可以直接照着写的场景节拍（4-8 个）。每个节拍要有明确的人物意图、阻碍与转折，体现人物性格，并标出情绪走向。

只输出 JSON：
{"synopsis": "细化后的本章梗概（150-250字）", "beats": [{"summary": "节拍内容", "characters": ["人物姓名"], "location": "地点", "conflict": "冲突", "outcome": "结果", "emotion": "情绪"}], "characters": ["本章全部出场人物姓名"], "pov": "视角人物姓名"}`, `Break "This chapter's outline" down into 4-8 scene beats a writer can follow directly. Each beat needs a clear intent, an obstacle and a turn, shows character, and names the emotional movement.

Output JSON only:
{"synopsis": "refined chapter synopsis (100-160 words)", "beats": [{"summary": "what happens", "characters": ["names"], "location": "place", "conflict": "conflict", "outcome": "outcome", "emotion": "emotion"}], "characters": ["every character appearing"], "pov": "viewpoint character name"}`)}`
}

export function whatIfTask(base: Base & { context: string; question: string; branches: number }): string {
  return `${base.context}\n\n---\n${L(base.lang, `作者想做一次剧情推演（what-if）：

${base.question}

请基于现有设定、人物性格与已发生的事实，推演 ${base.branches} 条不同的可行走向。每条走向都要讲清因果：谁会因此做出什么选择、连锁反应是什么、会如何影响尚未回收的线索与各主要人物的弧光，以及它的风险与收益。

只输出 JSON：
{"branches": [{"title": "走向名称", "development": "200-350字的推演", "consequences": ["对人物/线索/世界的关键影响"], "risks": "这样写的风险", "payoff": "这样写的收益"}], "recommendation": "你的建议与理由"}`, `The author wants a what-if run:

${base.question}

Using the bible, the characters' natures and what has already happened, work out ${base.branches} distinct workable directions. For each, spell out the causality: who chooses what because of it, the knock-on effects, how it touches open threads and each main character's arc, and its risks and rewards.

Output JSON only:
{"branches": [{"title": "name of the direction", "development": "130-220 words of development", "consequences": ["key effects on characters / threads / world"], "risks": "risks of writing it this way", "payoff": "what it buys the book"}], "recommendation": "your pick and why"}`)}`
}

export function foundationTask(base: { lang: PromptLanguage; idea: string; language: string }): string {
  return L(base.lang, `作者有一个小说点子：

"""
${base.idea}
"""

请把它发展成一部长篇小说的立项方案。要具体、有个性，避免套路。

只输出 JSON：
{
  "title": "书名",
  "genre": "类型",
  "logline": "一句话梗概（主角 + 目标 + 阻碍 + 代价）",
  "premise": "300字左右的故事核：世界的特别之处、核心冲突、情感内核、读者追读的理由",
  "themes": ["主题"],
  "characters": [{"name": "姓名", "role": "protagonist|deuteragonist|antagonist|supporting", "gender": "性别", "age": "年龄", "tagline": "一句话人设", "personality": "性格", "motivation": "想要什么/真正需要什么", "flaw": "弱点", "arc": "人物弧光", "voice": "说话方式", "appearance": "外貌要点"}],
  "world": [{"name": "设定名", "category": "setting|location|faction|system|item|history|culture|rule|term", "importance": 1, "summary": "一句话", "body": "详细说明"}],
  "volumes": [{"title": "卷名", "synopsis": "本卷梗概", "goal": "本卷结束时故事到达哪里"}],
  "opening": [{"title": "章名", "synopsis": "梗概", "purpose": "作用", "characters": ["出场人物"]}],
  "style": {"name": "文风名", "pov": "first|third-limited|third-omniscient|multi", "tone": "基调", "diction": "用词", "rhythm": "节奏", "rules": ["必须做到"], "avoid": ["必须避免"]}
}
人物 4-7 个，设定 4-8 条（importance 1 表示核心设定），卷 2-4 卷，opening 给出前 5 章。正文语言将是${languageName(base.language)}。`, `The author has an idea for a novel:

"""
${base.idea}
"""

Develop it into a concrete, distinctive plan for a full-length novel. Avoid stock templates.

Output JSON only:
{
  "title": "title",
  "genre": "genre",
  "logline": "one sentence: protagonist + goal + obstacle + stakes",
  "premise": "about 200 words: what is special about this world, the core conflict, the emotional core, why a reader keeps reading",
  "themes": ["theme"],
  "characters": [{"name": "name", "role": "protagonist|deuteragonist|antagonist|supporting", "gender": "gender", "age": "age", "tagline": "one-line identity", "personality": "personality", "motivation": "want / need", "flaw": "flaw", "arc": "arc", "voice": "how they talk", "appearance": "looks"}],
  "world": [{"name": "entry name", "category": "setting|location|faction|system|item|history|culture|rule|term", "importance": 1, "summary": "one sentence", "body": "details"}],
  "volumes": [{"title": "volume title", "synopsis": "volume synopsis", "goal": "where the story stands when it ends"}],
  "opening": [{"title": "chapter title", "synopsis": "synopsis", "purpose": "purpose", "characters": ["names"]}],
  "style": {"name": "style name", "pov": "first|third-limited|third-omniscient|multi", "tone": "tone", "diction": "diction", "rhythm": "rhythm", "rules": ["always"], "avoid": ["never"]}
}
4-7 characters, 4-8 world entries (importance 1 = core canon), 2-4 volumes, and the first 5 chapters in "opening". The manuscript will be written in ${languageName(base.language)}.`)
}

// ───────────────────────────── bible ─────────────────────────────

export function expandCharacterTask(base: Base & { context: string; card: string; direction?: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, `请补全下面这张人物卡。保留已有内容，只填补空缺并让人物更立体、更有内在矛盾；必须与设定和已写正文一致。${base.direction !== undefined && base.direction.trim().length > 0 ? `\n作者的要求：${base.direction.trim()}` : ''}

## 现有人物卡

${base.card}

只输出 JSON（只包含你新增或改进的字段）：
{"tagline": "", "gender": "", "age": "", "appearance": "", "personality": "", "background": "", "motivation": "", "flaw": "", "arc": "", "voice": "", "abilities": "", "secrets": "", "persona": {"traits": [{"name": "特质", "level": 1到5}], "values": ["最看重的事，按优先级"], "speech": ["口头禅、句式、语域等说话习惯"], "taboos": ["绝不会做/说的事"], "underPressure": "压力下的典型反应"}, "relationships": [{"target": "对方姓名", "kind": "关系", "note": "说明"}], "visualPrompt": "用于生成立绘的外貌描述（发型发色、五官、体态、服饰、标志物），客观具体", "voiceDesign": "用于设计配音声线的描述（年龄感、音色、语速、气质）"}`, `Complete the character card below. Keep what is there; fill the gaps and give the character more dimension and inner conflict. It must agree with the bible and the written text.${base.direction !== undefined && base.direction.trim().length > 0 ? `\nThe author asks: ${base.direction.trim()}` : ''}

## Current card

${base.card}

Output JSON only (include only fields you add or improve):
{"tagline": "", "gender": "", "age": "", "appearance": "", "personality": "", "background": "", "motivation": "", "flaw": "", "arc": "", "voice": "", "abilities": "", "secrets": "", "persona": {"traits": [{"name": "trait", "level": 1-5}], "values": ["what they hold dearest, in order"], "speech": ["catchphrases, sentence shapes, register"], "taboos": ["what they would never do or say"], "underPressure": "typical reaction under pressure"}, "relationships": [{"target": "other character's name", "kind": "relationship", "note": "note"}], "visualPrompt": "objective, concrete looks for a portrait (hair, face, build, clothing, signature item)", "voiceDesign": "description for designing their speaking voice (age, timbre, pace, temperament)"}`)}`
}

export function expandWorldTask(base: Base & { context: string; entry: string; direction?: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, `请完善下面这条世界观设定。保留已有内容，补足规则、代价、限制、与其他设定和人物的关联，以及它能在情节中制造的冲突。必须自洽，并与已写正文一致。${base.direction !== undefined && base.direction.trim().length > 0 ? `\n作者的要求：${base.direction.trim()}` : ''}

## 现有条目

${base.entry}

只输出 JSON：
{"summary": "一句话概括", "body": "完善后的详细说明（Markdown，可分小节）", "aliases": ["别名"], "tags": ["标签"], "visualPrompt": "若是地点，给出用于生成场景图的视觉描述，否则留空"}`, `Develop the world entry below. Keep what is there; add rules, costs, limits, links to other entries and characters, and the conflicts it can create in the plot. It must be self-consistent and agree with the written text.${base.direction !== undefined && base.direction.trim().length > 0 ? `\nThe author asks: ${base.direction.trim()}` : ''}

## Current entry

${base.entry}

Output JSON only:
{"summary": "one sentence", "body": "the developed entry (Markdown, sections allowed)", "aliases": ["aliases"], "tags": ["tags"], "visualPrompt": "for a location, a visual description for a scene image; otherwise empty"}`)}`
}

export function styleExtractTask(base: { lang: PromptLanguage; sample: string; name?: string }): string {
  return L(base.lang, `下面是一段作者希望模仿其笔触的文字。请像文体学者一样分析它的写法（不是内容），提炼成可以指导写作的文风档案。

"""
${base.sample}
"""

只输出 JSON：
{"name": "${base.name ?? '给这种文风起个名字'}", "pov": "first|third-limited|third-omniscient|second|multi", "tense": "past|present", "tone": "基调与叙述者态度", "diction": "用词特点（词汇层次、文白、方言、专业词）", "rhythm": "句长、断句与段落节奏", "imagery": "意象与修辞的密度和类型", "dialogue": "对白的写法与提示语习惯", "pacing": "叙事推进与详略", "rules": ["5-8条可执行的写作规则，体现这种笔触"], "avoid": ["这种文风里不会出现的写法"], "exemplars": ["从原文中摘出 1-2 段最能代表笔触的原句（原样摘录，每段不超过150字）"]}`, `Below is a passage whose touch the author wants to emulate. Analyze how it is written (not what it says), as a stylistician would, and distill a style profile that can guide writing.

"""
${base.sample}
"""

Output JSON only:
{"name": "${base.name ?? 'a name for this style'}", "pov": "first|third-limited|third-omniscient|second|multi", "tense": "past|present", "tone": "tone and narrator's attitude", "diction": "word choice (register, vocabulary, dialect, jargon)", "rhythm": "sentence length, breaks, paragraph rhythm", "imagery": "density and kind of imagery and rhetoric", "dialogue": "how dialogue is written and tagged", "pacing": "narrative movement and what gets detail", "rules": ["5-8 actionable rules that produce this touch"], "avoid": ["things this style never does"], "exemplars": ["1-2 verbatim excerpts (under 100 words each) that best show the touch"]}`)
}

export function styleSampleTask(base: Base & { style: string; scene?: string }): string {
  return L(base.lang, `按照下面的文风写一段 250 字左右的小说片段，用来让作者试读笔触。${base.scene !== undefined && base.scene.length > 0 ? `场景：${base.scene}` : '场景自拟：一个人在雨夜回到多年未归的旧居。'}只输出片段正文。

【文风】
${base.style}`, `Write a passage of about 160 words in the style below, so the author can judge the touch. ${base.scene !== undefined && base.scene.length > 0 ? `Scene: ${base.scene}` : 'Scene of your choice: someone returns to a long-abandoned home on a rainy night.'} Output the passage only.

STYLE
${base.style}`)
}

/** Merge per-chapter character sightings into bible cards during import. */
export function castMergeTask(base: Base & { sightings: string }): string {
  return L(base.lang, `下面是从小说《${bare(base.title)}》各章提取到的人物出场记录。请合并同一人物的不同称呼，为每个重要人物整理出人物卡。

${base.sightings}

只输出 JSON：
{"characters": [{"name": "最常用的正式姓名", "aliases": ["其他称呼"], "role": "protagonist|deuteragonist|antagonist|supporting|minor", "gender": "", "age": "", "tagline": "一句话人设", "appearance": "", "personality": "", "background": "", "motivation": "", "flaw": "", "arc": "已发生的转变", "voice": "说话方式", "relationships": [{"target": "对方姓名", "kind": "关系", "note": ""}], "status": "active|offstage|retired|dead"}]}
只收有名有姓、出场两次以上或对情节重要的人物；按重要性排序，最多 40 个。没有依据的字段留空，不要编造。`, `Below are character sightings extracted chapter by chapter from the novel "${bare(base.title)}". Merge different names of the same person and write a card for every important character.

${base.sightings}

Output JSON only:
{"characters": [{"name": "most used proper name", "aliases": ["other names"], "role": "protagonist|deuteragonist|antagonist|supporting|minor", "gender": "", "age": "", "tagline": "one-line identity", "appearance": "", "personality": "", "background": "", "motivation": "", "flaw": "", "arc": "change so far", "voice": "how they talk", "relationships": [{"target": "other name", "kind": "relationship", "note": ""}], "status": "active|offstage|retired|dead"}]}
Keep named characters who appear at least twice or matter to the plot; order by importance, 40 at most. Leave a field empty rather than invent.`)
}

export function worldMergeTask(base: Base & { sightings: string }): string {
  return L(base.lang, `下面是从小说《${bare(base.title)}》各章提取到的地点、组织、物品与专有名词。请合并重复项，整理成世界观设定条目，并补一条总览式的"世界概况"。

${base.sightings}

只输出 JSON：
{"entries": [{"name": "名称", "aliases": ["别名"], "category": "setting|location|faction|system|item|history|culture|rule|term|other", "importance": 1或2或3, "summary": "一句话", "body": "根据原文整理的说明"}]}
importance：1=理解全书必须知道的核心设定（不超过 6 条），2=常规，3=细节。最多 40 条，没有依据的内容不要编造。`, `Below are places, groups, objects and terms extracted chapter by chapter from the novel "${bare(base.title)}". Merge duplicates into world entries, and add one overview entry describing the world at large.

${base.sightings}

Output JSON only:
{"entries": [{"name": "name", "aliases": ["aliases"], "category": "setting|location|faction|system|item|history|culture|rule|term|other", "importance": 1, "summary": "one sentence", "body": "what the text establishes"}]}
importance: 1 = core canon needed to follow the book (6 at most), 2 = normal, 3 = detail. 40 entries at most. Do not invent beyond the text.`)
}

export function volumesTask(base: Base & { summaries: string }): string {
  return L(base.lang, `下面是小说《${bare(base.title)}》按顺序排列的各章一句话摘要。请据此给全书划分卷（大的叙事段落），并写出一句话梗概与故事核。

${base.summaries}

只输出 JSON：
{"logline": "一句话梗概", "premise": "200-300字故事核", "genre": "类型", "themes": ["主题"], "volumes": [{"title": "卷名", "from": 起始章序号, "to": 结束章序号, "synopsis": "本卷梗概", "goal": "本卷结束时故事到达哪里"}]}
卷必须连续覆盖全部章节、互不重叠；章节很少时只分一卷。`, `Below are one-line summaries of every chapter of the novel "${bare(base.title)}", in order. Divide the book into volumes (large narrative movements) and write a logline and premise.

${base.summaries}

Output JSON only:
{"logline": "one sentence", "premise": "130-200 word premise", "genre": "genre", "themes": ["themes"], "volumes": [{"title": "volume title", "from": first chapter number, "to": last chapter number, "synopsis": "volume synopsis", "goal": "where the story stands when it ends"}]}
Volumes must cover every chapter contiguously without overlap; use a single volume for a short book.`)
}

// ───────────────────────────── review ─────────────────────────────

export function reviewTask(base: Base & { context: string; focus?: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, `请以资深责任编辑的眼光审读"本章已有正文"。逐项核对：
- 连续性：与前文事实、时间线、人物位置和已知信息是否矛盾；
- 人物：言行是否符合人物卡的性格、动机、说话方式，有无"作者替人物说话"；
- 设定：是否违反世界观规则；
- 逻辑：动机、因果、信息来源是否成立；
- 文风：是否符合设定的文风，有无陈词滥调、空泛抒情、重复用词等"AI 味"；
- 节奏：详略是否得当，章纲节拍是否都落地，结尾是否有力。${base.focus !== undefined && base.focus.trim().length > 0 ? `\n重点关注：${base.focus.trim()}` : ''}

只输出 JSON：
{"verdict": "两三句总体评价", "issues": [{"severity": "high|medium|low", "type": "continuity|character|world|timeline|style|pacing|logic|language", "quote": "从正文中原样摘出的问题句子（必须是原文的连续片段，30字以内为宜；全局性问题可留空）", "explanation": "问题是什么、为什么是问题", "suggestion": "具体怎么改"}]}
只报真实存在的问题，没有就返回空数组；不要为了凑数而吹毛求疵。`, `Read "This chapter so far" as a senior editor would. Check each of:
- continuity: contradictions with earlier facts, the timeline, where people are and what they know;
- character: do words and actions fit the card — personality, motivation, voice; is the author speaking through anyone;
- world: any rule of the setting broken;
- logic: do motives, causes and sources of information hold;
- style: does it follow the style profile; clichés, vague lyricism, repeated words, anything that reads machine-made;
- pacing: is detail spent well, did every outlined beat land, does the ending hit.${base.focus !== undefined && base.focus.trim().length > 0 ? `\nPay special attention to: ${base.focus.trim()}` : ''}

Output JSON only:
{"verdict": "two or three sentences overall", "issues": [{"severity": "high|medium|low", "type": "continuity|character|world|timeline|style|pacing|logic|language", "quote": "the offending sentence copied verbatim from the text (a contiguous excerpt, ideally under 20 words; empty for chapter-wide issues)", "explanation": "what is wrong and why it matters", "suggestion": "how to fix it, concretely"}]}
Report only real problems; return an empty array when there are none. Do not nitpick to fill the list.`)}`
}

// ───────────────────────────── stage ─────────────────────────────

export function audioScriptTask(base: Base & { text: string; cast: string; ambience: string; effects?: boolean; music?: boolean }): string {
  const effects = base.effects !== false
  const music = base.music === true
  const cueShape = `{"at": 0, "kind": "bed", "ambience": "", "intensity": 0.5, "caption": "", "prompt": ""}${effects ? ', {"at": 3, "kind": "effect", "caption": "", "prompt": ""}' : ''}${music ? ', {"at": 0, "kind": "music", "caption": "", "prompt": ""}' : ''}`
  return L(base.lang, `你是广播剧导演。请把下面这段小说正文改编成有声剧脚本：把文字切分成依次播出的台词行，标注由谁来读、怎么读，并做声音设计。

## 人物表（姓名 | 声音与性格提示）
${base.cast || '（无）'}

## 可用环境声
${base.ambience}

## 正文
"""
${base.text}
"""

规则：
1. 必须完整覆盖正文，不得删改、概括或增添任何文字；把所有行的 text 按顺序拼起来应当等于原文（空白与换行除外）。
2. kind：narration=旁白叙述；dialogue=人物说出口的话（text 里不要带引号）；thought=人物的内心独白。引号里如果不是谁说出口的话——被提到的一个词、书名、拟声词——它不是对白，连同引号留在所在的旁白行里。
3. 旁白以自然段为单位：一个自然段里连续的旁白就是一行，不要把一句话或一小段再拆开。相邻的旁白行之后会合在一起一口气配音，所以不需要你按长度去切。
4. 夹在两句对白之间、只交代"谁在说"的提示语（"他说，""她冷笑道："）单独成一行旁白，不要并进别的行——有声剧里这种提示语可以不念。除此之外，不足十个字的旁白不要单独成行，并入相邻的旁白行。
5. speaker 填说话人物的姓名：人物表里有的用表里的姓名；表里没有的（路人、店员、没有名字的人）用正文里对他的称呼，同一个人在整段里始终用同一个称呼。旁白不填。
6. direction 是写给配音演员的表演提示（情绪、语速、音量、气息），10-25 字，要具体，例如"压低声音，咬字很慢，强忍怒意"。对白和心声要写；同一个人物在同一场戏里的演法要前后连贯，情绪没有变就沿用上一句的提示，不要每句换一种说法。旁白一般留空——叙述的语气确实变了（转入紧张、哀伤、轻快）才写。
7. cues 是声音设计：正文没有逐字写出、但人在那个场景里会听到的声音。它们会被做成声音，也会作为注释显示在正文旁边给读者看，所以 caption 要写得让人"听得见"。at 填声音出现处那一行的序号（从 0 开始）。caption 和 prompt 都用中文写。
   - kind=bed 环境底声：在场景或氛围变化处安排一条，一直持续到下一条 bed。caption 用一句话写这个场景具体听得到什么（例："骨壁大厅里干净的回声，偶尔有纸页翻动"），20 字以内；prompt 是写给声音模型的描述：这个地方持续不断的底声由哪些声音组成、远近和疏密如何，要平稳、可循环，不要写一次性的响声，不要出现人名和剧情；ambience 从"可用环境声"里选最接近的一个（没有声音模型时用它代替）；intensity 0-1。开头必须有一条 at 为 0 的 bed。${effects ? `
   - kind=effect 音效：一个具体而短促的声音事件——门开了一条缝、槌子落下、铁桶撞在舱壁上、靴底踩上钢板。正文写到或明显带出的才放，平均四五行最多一个，对白密集的地方宁缺毋滥。caption 是给读者看的拟声或描述（例："嗒——银槌轻碰骨木"），20 字以内；prompt 是写给音效模型的描述：只说这个声音本身——什么东西、什么材质、怎么响、大约几秒——不要出现人名和剧情。` : ''}${music ? `
   - kind=music 配乐：一场戏最多一条，放在情绪定调的那一行，一直持续到下一条 music。caption 写乐器和情绪（例："低沉的弦乐长音，屏息的不安"）；prompt 是写给音乐模型的描述：乐器、速度、情绪，并写明纯器乐、没有人声。` : ''}

只输出 JSON：
{"lines": [{"kind": "narration|dialogue|thought", "speaker": "", "text": "", "direction": ""}], "cues": [${cueShape}]}`, `You are an audio-drama director. Adapt the prose below into a performance script: cut it into lines played in order, say who reads each and how, and design its sound.

## Cast (name | voice and personality notes)
${base.cast || '(none)'}

## Ambience available
${base.ambience}

## Text
"""
${base.text}
"""

Rules:
1. Cover the text completely. Do not cut, summarize, alter or add words; the "text" of all lines joined in order must equal the original (whitespace aside).
2. kind: narration = narrator; dialogue = words a character says aloud (no quote marks in "text"); thought = a character's inner voice. Quoted words nobody says aloud — a word that is mentioned, a title, a sound — are not dialogue: they stay, quotes included, in the narration line they sit in.
3. Narration goes by paragraph: the narration of one paragraph is one line. Do not cut a sentence or a short paragraph into several lines. Neighbouring narration lines are voiced together in one take afterwards, so there is no need to cut for length.
4. A tag that only says who is speaking, between two spoken lines ("he said,", "she sneered:"), is a narration line of its own — do not fold it into another line; an audio drama may leave it unspoken. Any other narration of fewer than six words joins the narration next to it.
5. speaker is the name of whoever speaks: the cast's name for a character in the cast; for anyone else (a passer-by, a clerk, someone unnamed) what the text calls them, the same every time. Empty for narration.
6. direction tells the actor how to deliver the line (emotion, pace, volume, breath) in 5-14 words — concrete, e.g. "low and slow, anger barely held back". Give one for dialogue and thought; keep a character's delivery consistent within a scene — when the mood has not changed, repeat the previous direction rather than inventing a new one. Leave it empty for narration unless the telling really changes key (tense, mournful, light).
7. cues are the sound design: what someone in the scene would hear that the prose does not spell out. They are made into sound, and shown beside the text as notes for the reader, so a caption must let the reader hear it. "at" is the index (from 0) of the line the sound starts on. Write "caption" and "prompt" in the language of the text.
   - kind=bed, the ambience: one wherever the scene or the mood changes, lasting until the next bed. "caption" says in a few words what is heard here (e.g. "a clean echo under the bone vault, pages turning"), at most 12 words; "prompt" describes it for a sound model: which continuous sounds make up the bed of this place, how near and how dense — steady and loopable, no one-off events, no names and no plot; "ambience" is the closest of the available beds (it stands in when there is no sound model); "intensity" 0-1. There must be a bed with at = 0.${effects ? `
   - kind=effect, a spot effect: one short, concrete sound event — a door opening a crack, a gavel coming down, an iron drum hitting the hull, a boot on steel. Only what the text says or plainly implies; one in four or five lines at most, and rather none than too many where the dialogue is dense. "caption" is what the reader sees (e.g. "tok — the silver gavel touches bone"), at most 12 words; "prompt" describes the sound itself for a sound-effects model — what object, what material, how it sounds, roughly how many seconds — with no names and no plot.` : ''}${music ? `
   - kind=music: at most one per scene, on the line that sets its mood, lasting until the next music cue. "caption" names instruments and mood (e.g. "low sustained strings, breath held"); "prompt" describes it for a music model: instruments, tempo, mood, and that it is instrumental with no voice.` : ''}

Output JSON only:
{"lines": [{"kind": "narration|dialogue|thought", "speaker": "", "text": "", "direction": ""}], "cues": [${cueShape}]}`)
}

export function storyboardTask(base: Base & {
  /** The smallest pieces a panel may cover, one per row: index | speaker | seconds | text. */
  units: string
  cast: string
  locations: string
  artStyle: string
  /** How many panels, in words: a number to aim for, or bounds within which the director decides. */
  count: string
  /** What the panel before this passage showed, when the passage continues a board. */
  previous?: string
  avoid?: string[]
}): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  return L(base.lang, `你是有声漫画（动态漫）的分镜导演。下面是一章有声剧里连续的一段，已经切成最小的镜头单位（序号 | 说话人 | 约几秒 | 内容）。请把它们编成连续的分镜画面：每个画面覆盖若干连续的单位，在这些单位播放期间停留在屏幕上。

## 人物外貌
${base.cast || '（无）'}

## 场景
${base.locations || '（无）'}

## 美术风格
${base.artStyle}
${base.previous !== undefined ? `\n## 上一个画面（这一段接在它后面）\n${base.previous}\n` : ''}
## 镜头单位
${base.units}

规则：
1. 画面必须按顺序、不重叠、不遗漏地覆盖所有单位，一直到最后一个；from/to 是单位序号（含）。
2. ${base.count}
3. 什么时候换画面：动作变了、情绪转了、说话的人换了、视点或地点变了、出现了值得一看的新东西。大段对话用正反打和特写切换；长段叙述也要随内容换画面，不要让一张图从头停到尾。
4. description 用一句话说明画面内容（给作者看）。
5. prompt 是给绘图模型的完整画面描述：景别与构图（特写/中景/远景、机位）、在场人物的外貌与动作表情（外貌必须沿用"人物外貌"，每次都写全，不要用姓名指代）、环境与光线、氛围。不要出现文字、对白气泡、分格。60-120 字。只写眼睛看得见的东西：机构名、头衔、专有名词一律换成它在这个故事里实际的样子（材质、形状、新旧、颜色），否则绘图模型会按现实里最常见的样子去画。相邻画面不要只是同一张图换个说法——景别、机位或主体要有变化。${avoid.length > 0 ? `下列东西不能出现在任何画面里，也不要把这些词写进 prompt：${avoid}。` : ''}
6. camera 从 still|zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down 里选一个缓慢的镜头运动。

只输出 JSON：
{"panels": [{"from": 0, "to": 3, "description": "", "prompt": "", "camera": "zoom-in", "characters": ["在场人物姓名"], "location": "地点"}]}`, `You are the storyboard director of a motion comic. Below is one continuous passage of a chapter's audio drama, already cut into the smallest units a shot may cover (index | speaker | seconds | text). Arrange them into consecutive panels: each panel covers a run of units and stays on screen while they play.

## Character looks
${base.cast || '(none)'}

## Locations
${base.locations || '(none)'}

## Art direction
${base.artStyle}
${base.previous !== undefined ? `\n## The panel before this passage\n${base.previous}\n` : ''}
## Units
${base.units}

Rules:
1. Panels cover every unit in order, without overlap or gaps, through to the last one; from/to are unit indexes (inclusive).
2. ${base.count}
3. When to cut: the action changes, the mood turns, the speaker changes, the point of view or the place changes, something worth seeing appears. Long exchanges alternate shot / reverse shot and close-ups; long narration changes picture with its content too — no single picture should sit through all of it.
4. description: one sentence on what the panel shows (for the author).
5. prompt: the full picture for the image model — shot size and composition (close-up / medium / wide, angle), the looks, action and expression of everyone in frame (reuse "Character looks" in full every time; never refer to anyone by name), setting and light, mood. No text, speech balloons or panel borders. 40-80 words. Only what the eye can see: an institution, a title or a proper noun is written as what it looks like in this story. Neighbouring panels must not be the same picture in other words — change the shot size, the angle or the subject.${avoid.length > 0 ? ` None of the following may appear in any panel, and none of these words belongs in a prompt: ${avoid}.` : ''}
6. camera: one slow move from still|zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down.

Output JSON only:
{"panels": [{"from": 0, "to": 3, "description": "", "prompt": "", "camera": "zoom-in", "characters": ["names of characters in frame"], "location": "place"}]}`)
}

export function illustrationPromptTask(base: Base & { subject: string; cast: string; places?: string; artStyle: string; avoid?: string[]; wardrobe?: string }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  const dressed = base.wardrobe !== undefined && base.wardrobe.length > 0
  return L(base.lang, `请为下面的小说内容写一条给绘图模型的画面描述，用作插图。

## 要画的内容
${base.subject}

## 人物的样子
${base.cast || '（无）'}

## 场所与器物的样子
${base.places !== undefined && base.places.length > 0 ? base.places : '（没有专门的设定，按"要画的内容"里写到的样子来）'}
${dressed ? `\n## 人物可选的造型（按这一段的场合，为有造型可选的人物各选一套；不合适就不选）\n${base.wardrobe}\n` : ''}
## 美术风格（会另行附加，不必复述）
${base.artStyle}

## 画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. 选取最有画面感的一个瞬间；写清构图与景别、人物的动作表情、环境、光线与氛围。
2. 人物的样子沿用上面的写法并写全，不用姓名指代。
3. 只写眼睛看得见的东西。机构名、头衔、教派、专有名词这类词，绘图模型会按现实世界里最常见的样子去画（看到"教会"就画出欧式教堂）——一律换成它在这个故事里实际的样子：材质、形状、新旧、脏净、颜色。
4. "画面里不能出现"的东西不要画，也不要把这些词写进描述。
5. 不要出现文字、水印、分格。80-150 字。${dressed ? '只输出 JSON：{"description": "画面描述", "wearing": {"人物名": "造型名"}}；选了造型的人物，描述里按那套造型来写。' : '只输出这条描述，不要任何其他内容。'}`, `Write one picture description for an image model, to illustrate the fiction below.

## What to illustrate
${base.subject}

## How the people look
${base.cast || '(none)'}

## How the places and things look
${base.places !== undefined && base.places.length > 0 ? base.places : '(nothing specified; go by what "What to illustrate" shows)'}
${dressed ? `\n## Looks to choose from (pick one per character who has any, by the occasion of this passage; pick none when none fits)\n${base.wardrobe}\n` : ''}
## Art direction (added separately; do not repeat it)
${base.artStyle}

## Must not appear in the picture
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. Pick the single most visual moment. State composition and shot size, each person's action and expression, setting, light and mood.
2. Reuse "How the people look" in full; never refer to anyone by name.
3. Write only what the eye can see. Names of institutions, titles, orders and other proper nouns make an image model draw the most common real-world version (it reads "church" and paints a cathedral) — replace each with what it actually looks like in this story: material, shape, age, wear, colour.
4. Nothing from "Must not appear" may be drawn, and none of those words may appear in the description.
5. No text, watermark or panel borders. 50-100 words. ${dressed ? 'Output JSON only: {"description": "the picture", "wearing": {"character name": "look name"}}; describe a character in the look you picked for them.' : 'Output the description only.'}`)
}

/** Distill a character's prose appearance into an anchor an image model can draw the same way every time. */
export function visualAnchorTask(base: Base & { card: string; avoid?: string[]; direction?: string }): string {
  const avoid = (base.avoid ?? []).join(', ')
  return L(base.lang, `请把下面这个人物的外貌，改写成给绘图模型用的"视觉锚点"：以后每一张有此人的图都会原样带上它，所以它必须具体、稳定、画得出来。

## 人物
${base.card}
${base.direction !== undefined && base.direction.length > 0 ? `\n## 作者的要求\n${base.direction}\n` : ''}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. prompt：英文，逗号分隔的短语，40-70 个词。只写看得见的：年龄感与体型、脸、发色与发型（把发型拆成具体的形状，不要用风格名）、肤色、衣着（款式、材质、颜色、新旧）、随身的标志物。
2. 不要写姓名、性格、身份、经历；不要用机构名、教派、头衔之类的词——绘图模型会按现实里最常见的样子去画。比如"教会式的发髻"要写成它实际的形状，"白甲"要写清是什么材质、什么结构、有没有纹饰。
3. 原文没写的细节可以补全，但要与人物相称，并且一旦写下就是定论。
4. 只写这个人"长什么样"，不写"此刻在做什么"：不要动作、姿势、此刻的表情和手里临时拿的东西；不要气味、声音、气质这类看不见的东西；也不要画风、光线、镜头、画质之类的词——那些由全书的画风统一决定。
5. negative：英文，逗号分隔，0-10 项。写这段描述最容易被画错、而这个人物身上不该有的东西（例如不该有的纹章、饰物、发型、年龄感）。

只输出 JSON：{"prompt": "", "negative": ""}`, `Rewrite this character's appearance as a "visual anchor" for an image model: it will be restated as is in every picture that shows them, so it must be concrete, stable and drawable.

## Character
${base.card}
${base.direction !== undefined && base.direction.length > 0 ? `\n## The author asks\n${base.direction}\n` : ''}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. prompt: English, comma-separated phrases, 40-70 words. Only what can be seen: apparent age and build, face, hair colour and style (spell the style out as a shape, not as a style name), skin, clothing (cut, material, colour, wear), signature items.
2. No names, personality, role or history; no names of institutions, orders or titles — an image model draws the most common real-world version of such words. Describe "a church-style bun" as its actual shape; say what "white armour" is made of, how it is built and whether it carries any emblem.
3. Details the source leaves open may be filled in, in keeping with the character; once written they are canon.
4. Say what the person looks like, not what they are doing: no action, pose, passing expression or thing they happen to hold; nothing that cannot be seen (smell, sound, temperament); and no words about art style, lighting, camera or image quality — the book's art direction decides those for every picture.
5. negative: English, comma-separated, 0-10 items: what this description is most likely to be drawn as by mistake and what this character must not have (an emblem, an ornament, a hairstyle, an age).

Output JSON only: {"prompt": "", "negative": ""}`)
}

export function directorSystem(base: Base & { style: string; player?: string }): string {
  const role = base.player !== undefined
    ? L(base.lang, `玩家扮演「${base.player}」。你绝不替「${base.player}」说话、行动或做决定，也不描写其内心；只写其他人物和世界对玩家言行的反应。`, `The player is "${base.player}". Never speak, act, decide or think for "${base.player}"; write only how the other characters and the world respond.`)
    : L(base.lang, '玩家是导演，不扮演任何人物；玩家的输入是对剧情走向的指示，由你让人物把它演出来。', 'The player directs from outside and plays nobody; their input steers the scene and you make the characters play it out.')
  return L(base.lang, `你是互动小说《${bare(base.title)}》的游戏主持人，正在主持一段幕间互动剧情。${role}

主持规则：
1. 所有人物必须严格符合人物卡：性格、动机、说话方式、此刻知道什么。他们有自己的打算，会主动推动场面，而不是等着被问。
2. 遵守世界观设定与正史中已发生的事实。这段幕间从正史的某个节点岔出，除非玩家要求，不要擅自改写正史。
3. 每一回合推进一点剧情，并把选择权交还给玩家；不要一次把一场戏演完。篇幅克制：旁白 60-160 字、只写一段，每个开口的人物 1-3 句。人物说的话一律放进 lines，旁白里不要出现带引号的对白。
4. 旁白沿用下面的文风，写可感知的细节，不写总结。
5. choices 给玩家 3 个差异明显、各有代价的行动选项（玩家也可以不选而自由输入）。
6. 场景变化（换地点、时间跳跃、氛围剧变）时填写 scene。
7. 当这场戏自然收束时把 ended 设为 true。
8. 只输出 JSON，不要任何额外文字。${outputRule(base)}

【文风】
${base.style}

输出格式：
{"narration": "旁白", "lines": [{"speaker": "人物姓名", "text": "台词（不带引号）", "emotion": "neutral|happy|sad|angry|fear|surprise|shy|cold|serious 之一", "action": "伴随的动作神态，可空"}], "choices": ["选项1", "选项2", "选项3"], "scene": {"location": "地点", "time": "时间", "mood": "氛围", "ambience": "环境声预设，可空"}, "state": {"需要跟踪的变量名": "值"}, "ended": false}`, `You are the game master of the interactive fiction "${bare(base.title)}", running an interlude scene. ${role}

How to run it:
1. Every character stays true to their card: personality, motive, voice, and what they know right now. They have plans of their own and push the scene instead of waiting to be asked.
2. Respect the world's rules and what already happened in the canon. The interlude branches off the canon at one point; do not rewrite the canon unless the player asks.
3. Move the story a little each turn and hand the choice back to the player; never play out a whole scene in one go. Stay tight: 40-110 words of narration in a single paragraph, 1-3 sentences per speaking character. Everything a character says goes into "lines"; narration carries no quoted speech.
4. Narrate in the style below: sensory detail, no summaries.
5. "choices" offers 3 clearly different actions, each with a cost (the player may also type freely).
6. Fill "scene" when the scene changes (new place, time jump, sharp change of mood).
7. Set "ended" to true when the scene has naturally closed.
8. Output JSON only, nothing else. ${outputRule(base)}

STYLE
${base.style}

Format:
{"narration": "narration", "lines": [{"speaker": "character name", "text": "what they say (no quote marks)", "emotion": "one of neutral|happy|sad|angry|fear|surprise|shy|cold|serious", "action": "accompanying action or expression, may be empty"}], "choices": ["option 1", "option 2", "option 3"], "scene": {"location": "place", "time": "time", "mood": "mood", "ambience": "ambience preset, may be empty"}, "state": {"variable to track": "value"}, "ended": false}`)
}

export function directorTask(base: Base & { context: string; situation: string; transcript: string; input?: string; ambience: string; state?: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, '## 幕间开场情境', '## Opening situation of the interlude')}\n\n${base.situation}\n\n${L(base.lang, '## 可用环境声预设', '## Ambience presets')}\n\n${base.ambience}${base.state !== undefined && base.state.length > 0 ? `\n\n${L(base.lang, '## 当前状态变量', '## Current state variables')}\n\n${base.state}` : ''}\n\n${L(base.lang, '## 到目前为止的演出记录', '## The scene so far')}\n\n${base.transcript || L(base.lang, '（尚未开始）', '(not started)')}\n\n---\n${base.input !== undefined
    ? `${L(base.lang, '玩家这一回合的输入', 'The player\'s move this turn')}${base.lang === 'zh' ? '：' : ': '}${base.input}\n\n${L(base.lang, '请主持下一回合。', 'Run the next turn.')}`
    : L(base.lang, '请主持开场回合：用旁白交代场景，让在场人物自然地开口，把第一个选择交给玩家。scene 必须填写。', 'Run the opening turn: set the scene in narration, let the characters present start talking, and hand the player their first choice. "scene" is required.')}`
}

export function novelizeSystem(base: Base & { style: string }): string {
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的作者。下面是一段互动演出的记录（旁白、人物对白和玩家的选择）。请把它改写成一章连贯的小说正文。

规则：
1. 保留记录中发生的事件、关键对白和情感走向，但要用小说的方式重新讲述：补足动作、心理、环境与过渡，删去游戏痕迹（选项、回合感、重复的寒暄）。
2. 玩家的输入要写成对应人物自然的言行。
3. 不得违背设定与前文。只输出正文，不要标题和说明。
4. ${outputRule(base)}

【文风】
${base.style}`, `You are the author of the novel "${bare(base.title)}". Below is the log of an interactive scene (narration, character lines and the player's choices). Rewrite it as one coherent chapter of prose.

Rules:
1. Keep the events, the key lines and the emotional movement of the log, but tell it as a novel: add action, interiority, setting and transitions; remove every trace of the game (options, turn-taking, repeated small talk).
2. Turn the player's inputs into the natural words and actions of the character they played.
3. Never contradict the bible or earlier chapters. Output prose only — no title, no commentary.
4. ${outputRule(base)}

STYLE
${base.style}`)
}

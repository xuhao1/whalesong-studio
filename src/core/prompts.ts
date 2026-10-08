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

/**
 * The writer's standing instructions. Nothing in them changes from one chapter
 * to the next — how long this chapter is to be and whether it is being
 * continued are said with the task — so the head of every request for a book
 * is the same and a provider can keep it.
 */
export function writerSystem(base: Base & { style: string }): string {
  return L(base.lang, `你是一位功力深厚的小说家，正在为长篇小说《${bare(base.title)}》执笔。编辑会给你设定、前情与本章章纲，你写出可以直接付印的正文。

【写作纪律】
1. 只输出小说正文本身。不要标题、章节号、提纲、解释、括号批注，也不要"以下是正文"之类的话。
2. 设定集与前文已发生的事实是铁律。人物的言行必须出自其人格、处境与此刻已知的信息——不知道的事不能说，也不能据此行动。
3. 章纲里的节拍必须全部发生，但要像故事一样自然生长：补上过渡、细节、潜台词与人物之间的张力，不要把章纲逐条翻译成句子。不得擅自改变剧情走向，不得引入章纲之外的重大事件或新的重要角色。
4. 多人同场时，每个出场人物都要有符合身份的动作、立场和不可替代的作用，不要让谁沦为背景板。
5. 写到本章应当结束的地方就停，不要预支后面章节的情节，不要在结尾总结或升华。
6. ${outputRule(base)}

【文风】
${base.style}`, `You are an accomplished novelist writing the novel "${bare(base.title)}". Your editor gives you the story bible, the story so far and this chapter's outline; you deliver prose that could go to print as is.

RULES
1. Output the prose only. No title, chapter number, outline, explanation, bracketed notes or lead-in.
2. The story bible and everything already written are law. Characters act and speak from their personality, situation and what they know right now — they cannot say or use what they have not learned.
3. Every beat in the outline must happen, but let it grow like a story: add transitions, texture, subtext and friction between people. Do not translate the outline line by line. Do not change where the plot goes or introduce major events or major characters the outline does not have.
4. When several characters share a scene, each needs a stance, an action and a reason to be there. Nobody is furniture.
5. Stop where this chapter should end. Do not write ahead into later chapters, and do not summarize or moralize at the end.
6. ${outputRule(base)}

STYLE
${base.style}`)
}

/**
 * What the writer is asked for this time, after everything it has read.
 * @param base.words - the length recommended for what this call writes; absent, the writer judges.
 * @param base.usual - how long the book's written chapters run, for a writer left to judge.
 */
export function writerTask(base: Base & { context: string; brief?: string; continuing: boolean; words?: number; usual?: number }): string {
  const brief = base.brief !== undefined && base.brief.trim().length > 0
    ? L(base.lang, `\n\n## 编辑对本次写作的要求\n\n${base.brief.trim()}`, `\n\n## The editor's brief for this pass\n\n${base.brief.trim()}`)
    : ''
  const length = base.words !== undefined
    ? L(base.lang, `篇幅：约 ${base.words} 字（上下浮动 15% 以内）。`, `Length: about ${base.words} words (within 15%).`)
    : L(
        base.lang,
        `篇幅：没有规定字数，由你判断。章纲里的每个节拍都要写足、写透，不注水，也不赶进度；这一章该有多长就写多长。${base.usual !== undefined ? `本书已写的章节平均约 ${base.usual} 字，供你把握节奏，不是规定。` : ''}`,
        `Length: none is set — judge it yourself. Give every beat of the outline the room it needs, neither padded nor rushed; the chapter is as long as it has to be.${base.usual !== undefined ? ` The chapters written so far run to about ${base.usual} words on average: a sense of the book's pace, not a rule.` : ''}`,
      )
  const how = L(
    base.lang,
    base.continuing ? '你是在续写：从"本章已有正文"的最后一个字之后接着写，不要重复已有内容，衔接处不能看出缝。直接输出续写的正文。' : '从本章第一句开始写，直接输出正文。',
    base.continuing ? 'You are continuing: pick up right after the last word of "This chapter so far", repeat nothing, and leave no seam. Output the continuation only.' : 'Start from the first sentence of the chapter. Output the prose only.',
  )
  return `${base.context}${brief}\n\n---\n${length}\n${how}`
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
/**
 * Where a change the author asks for reaches: which chapters, and — when asked — what in the bible.
 * @param base.bible - also name what the bible itself should say otherwise.
 */
export function triageTask(base: Base & { instruction: string; chapters: string; bible?: boolean }): string {
  const zhShape = base.bible === true
    ? '{"chapters": [{"index": 章节序号, "reason": "这一章需要怎么改（一句话，具体到位）"}], "bible": [{"kind": "character|world", "name": "人物卡或设定条目的名字", "field": "要改的字段", "value": "改成什么", "reason": "为什么"}], "note": "给作者的总体说明：问题出在哪、牵涉多大范围、你是怎么判断的"}'
    : '{"chapters": [{"index": 章节序号, "reason": "这一章需要怎么改（一句话，具体到位）"}], "note": "给作者的总体说明，可为空"}'
  const enShape = base.bible === true
    ? '{"chapters": [{"index": 1, "reason": "how this chapter must change, in one specific sentence"}], "bible": [{"kind": "character|world", "name": "the card or entry", "field": "the field to change", "value": "what it should say", "reason": "why"}], "note": "for the author: where the problem lies, how far it reaches, how you judged it"}'
    : '{"chapters": [{"index": 1, "reason": "how this chapter must change, in one specific sentence"}], "note": "overall note for the author, may be empty"}'
  const zhBible = base.bible === true
    ? '\n如果问题的根子在设定集——人物卡或设定条目写的和正文对不上，或者设定本身需要调整——把要改的地方列在 bible 里：人物的 field 用 tagline、appearance、personality、background、motivation、flaw、arc、voice、age、gender 之一，设定条目用 summary 或 body。正文没问题、只是设定写错了的，就只改设定，不要动正文。没有就给空数组。'
    : ''
  const enBible = base.bible === true
    ? '\nWhere the root of the problem is in the bible — a character card or a world entry that says something else than the text, or canon that itself has to change — list it under `bible`: for a character `field` is one of tagline, appearance, personality, background, motivation, flaw, arc, voice, age, gender; for a world entry, summary or body. Where the text is right and the bible is wrong, change the bible and leave the text. An empty array when there is nothing.'
    : ''
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的责任编辑。作者提出了一条针对全书的修改要求，请判断哪些章节需要因此改动。

## 修改要求

${base.instruction}

## 各章摘要

${base.chapters}

只输出 JSON：
${zhShape}
只列出确实需要改动的章节；如果要求是全局性的文风调整，可以列出全部有正文的章节。${zhBible}`, `You are the editor of the novel "${bare(base.title)}". The author asks for a book-wide change. Decide which chapters must change because of it.

## The requested change

${base.instruction}

## Chapter summaries

${base.chapters}

Output JSON only:
${enShape}
List only the chapters that really have to change; for a book-wide change of style, every chapter that has text may be listed.${enBible}`)
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

/**
 * @param base.situation - what is particular about where these chapters go: a new line and what it parts from, a rewrite and what it gives up, a line that has to arrive somewhere.
 * @param base.after - the chapter the new ones follow, when that is not the end of the line.
 */
export function deriveChaptersTask(base: Base & { context: string; count: number; direction?: string; volume: string; situation?: string; after?: string }): string {
  const direction = base.direction !== undefined && base.direction.trim().length > 0 ? L(base.lang, `\n\n## 作者给的方向\n\n${base.direction.trim()}`, `\n\n## Direction from the author\n\n${base.direction.trim()}`) : ''
  const situation = base.situation !== undefined && base.situation.trim().length > 0 ? L(base.lang, `\n\n## 这次推演的处境\n\n${base.situation.trim()}`, `\n\n## Where these chapters go\n\n${base.situation.trim()}`) : ''
  const after = base.after !== undefined ? L(base.lang, `这些章节接在「${base.after}」之后、大纲里它后面那一章之前：要接得上前面，也要引得出后面。\n`, `These chapters go after "${base.after}" and before the chapter the outline has after it: they have to follow from the one and lead into the other.\n`) : ''
  return `${base.context}${situation}${direction}\n\n---\n${after}${L(base.lang, `请为《${bare(base.title)}》的「${base.volume}」推演接下来的 ${base.count} 章章纲。要求：
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

/** How the things of the book's world stand to each other: the planner reads the bible and the digests and writes the ties down. */
/** Finding entries of the bible that are one thing under several names, and ones filed under the wrong kind. */
export function worldTidyTask(base: Base & { entries: string; count: number }): string {
  return L(base.lang, `《${base.title}》的设定里有下面 ${base.count} 个条目。请找出两类问题，只说有把握的：

1. 同一样东西记成了几条——同一个地点、同一个家族 / 组织、同一件物品、同一个概念，用了不同的名字或称呼（例如"宁府""东府""宁国府"是同一处宅子）。上下级不算同一样东西：怡红院在大观园里面，它们是两处；一个家族和它住的宅子是两样；一个人和以他命名的地方也是两样。
2. 类别放错了的——比如一处宅子被记成了"家族与组织"，一件东西被记成了"地点"，一个称号被记成了"物品"。

每一条的格式：名字（别名）｜现在的类别｜正文里写到它的章数｜一句话概括

## 条目

${base.entries}

类别只有这些：location 地点、faction 家族与组织、item 物品、setting 世界概况、system 体系、history 历史、culture 文化、rule 规则、term 名词、other 其他。

名字必须照上面的原样写。"keep" 是留下来的那一条——选写得最全、或书里最常用的名字；"others" 是并进它的那几条。一个条目只出现在一组里。没有问题就给空列表。

只输出 JSON：
{"same": [{"keep": "", "others": [""], "why": "一句话依据"}], "kinds": [{"name": "", "category": "", "why": "一句话依据"}]}`, `The bible of "${base.title}" has the ${base.count} entries below. Find two kinds of fault in it, and name only what you are sure of:

1. One thing written down as several entries — the same place, house or organization, thing or idea under different names or ways of calling it (a mansion called by its formal name, by the side of the city it stands on, and by a short form). What is inside something is not the same thing as it: a courtyard in a garden is two places; a house and the mansion it lives in are two things; so are somebody and a place named after them.
2. An entry filed under the wrong kind — a mansion among the houses and organizations, a thing among the places, a title among the things.

Each line reads: name (other names) | the kind it is filed under | chapters of the text that name it | a line of what it is

## Entries

${base.entries}

The kinds are: location, faction (a house or an organization), item (a thing), setting, system, history, culture, rule, term, other.

Write names exactly as above. "keep" is the entry that stays — the fullest one, or the name the book uses most; "others" are the ones folded into it. An entry belongs to one group only. Where there is no fault, give an empty list.

Output JSON only:
{"same": [{"keep": "", "others": [""], "why": "one line of grounds"}], "kinds": [{"name": "", "category": "", "why": "one line of grounds"}]}`)
}

export function tiesTask(base: Base & { places: string; houses: string; things: string; people: string; record: string; known: string; chapters: number; direction?: string }): string {
  return L(base.lang, `请理清《${base.title}》的世界里这些东西彼此的关系，写成一张关系表。只写书里有依据的；拿不准的不要写。

关系只有五种（方向固定）：
- within：一个地点在另一个地点里面（怡红院 → 大观园 → 贾府 → 金陵），或一个分支在一个家族 / 组织里面。小的在前，大的在后。
- seat：一个家族 / 组织坐落在某个地点。家族在前，地点在后。
- member：一个人属于某个家族 / 组织。人在前。
- resides：一个人住在、或长期待在某个地点。人在前。要写到最具体的那一层（住怡红院就写怡红院，不要写大观园）。
- holds：一个人持有某件物品。人在前，物品在后。

规则：
- 名字必须用下面列表里的原名。关系里要用到、而列表里没有的地点 / 家族 / 物品（比如一座城、一个家族本身），在 "missing" 里补上：名字、类别（location 地点 / faction 家族与组织 / item 物品）、一句话说明——它们会被建成条目，然后你写的关系就能用它们的名字。只补书里确实有、而且关系里确实用到的；人物不在这里补。
- 同一个东西在列表里有几个名字时（宁府 / 东府 / 宁国府），只用其中一个来写关系。
- 关系有时间：从哪一章开始（since）、到哪一章为止（until），写章号（全书这条线共 ${base.chapters} 章）；一直如此就不写。搬家、易主、被逐、物品换了主人，都用 since / until 表示——同一个人先后住两处，就是两条。
- 每个地点最多一个上一级。不要写成环。
- note 一句话说依据（哪一章、什么事），可不写。
- 地点、家族、物品自己的大事记在 "events" 里：哪一章（章号）它建成、成立、被造出来（begin——书里写明它是这时才有的；只是第一次提到它不算），易主、改名、改建、换了用途（change），荒废、衰落（decline），被毁、失去、解散（end），再用十来个字说发生了什么。只记书里写明的；没有就给空列表。
${base.direction !== undefined ? `\n作者的要求：${base.direction}\n` : ''}
## 地点

${base.places}

## 家族与组织

${base.houses}

## 物品

${base.things}

## 人物

${base.people}

## 各章收录里记下的：地点、谁在哪、和物品有关的事

${base.record}

## 已经记下的关系（对的不必重复，错的在 "wrong" 里按原样列出）

${base.known}

只输出 JSON：
{"ties": [{"kind": "within", "from": "怡红院", "to": "大观园", "since": 17, "note": ""}], "wrong": [{"kind": "", "from": "", "to": ""}], "missing": [{"name": "金陵", "category": "location", "summary": ""}], "events": [{"name": "大观园", "chapter": 17, "kind": "begin", "what": ""}]}`, `Work out how the things of the world of "${base.title}" stand to each other, and write it down as a table of ties. Only what the book supports; leave out what you are not sure of.

There are five kinds of tie, each with a fixed direction:
- within: a place inside another place (a courtyard → a garden → a mansion → a city), or a branch inside a house or organization. The smaller first.
- seat: a house or organization has its seat at a place. The house first.
- member: somebody belongs to a house or organization. The person first.
- resides: somebody lives at, or keeps to, a place. The person first. Name the most particular place (the courtyard, not the garden it is in).
- holds: somebody holds a thing. The person first, the thing second.

Rules:
- Use the names exactly as listed below. A place, a house or a thing that a tie needs and the lists lack (a city, a house itself) goes under "missing": its name, its category (location / faction / item) and a line saying what it is — these are made into entries, and the ties you write can then name them. Only what the book has and a tie needs; people are not added here.
- Where one thing is listed under several names, use one of them for the ties.
- A tie has its time: the chapter it begins in (since) and the last chapter it holds in (until), as chapter numbers (this line of the book has ${base.chapters} chapters); leave both out when it always holds. A move, a change of owner, an expulsion, a thing changing hands are said with since / until — somebody who lives in two places one after the other is two ties.
- A place has one place above it at most. No rings.
- note: one sentence on what it rests on (which chapter, what happens); optional.
- What happens to a place, a house or a thing itself goes under "events": the chapter (its number) in which it is built, founded or made (begin — the book says it comes to be then; being mentioned for the first time is not that), changes owner, name, shape or use (change), falls into ruin or decline (decline), is destroyed, lost or dissolved (end), with a few words of what happened. Only what the book says outright; an empty list where there is nothing.
${base.direction !== undefined ? `\nThe author asks: ${base.direction}\n` : ''}
## Places

${base.places}

## Houses and organizations

${base.houses}

## Things

${base.things}

## People

${base.people}

## What the chapter digests noted: places, who was where, what happened to things

${base.record}

## Ties already written down (do not repeat the right ones; list the wrong ones as they are under "wrong")

${base.known}

Output JSON only:
{"ties": [{"kind": "within", "from": "the courtyard", "to": "the garden", "since": 17, "note": ""}], "wrong": [{"kind": "", "from": "", "to": ""}], "missing": [{"name": "the city", "category": "location", "summary": ""}], "events": [{"name": "the garden", "chapter": 17, "kind": "begin", "what": ""}]}`)
}

/** A character's life on the page, told in a paragraph from what the chapter digests noted of them. */
export function characterLifeTask(base: Base & { name: string; card: string; record: string; chapters: number }): string {
  return L(base.lang, `下面是《${base.title}》里「${base.name}」在正文中的记录：每一章的收录里对这个人的记载，按阅读顺序排列（全书这条线上共 ${base.chapters} 章）。请据此写出这个人物在书里的履历：一段话。

要求：
- 只写记录里有的事。从哪一章登场、哪几段时间在场、经历了什么转折、和谁有了什么、在哪里离开或死去（如果有）；记录没有说的不要补。
- 带上章号（"第 5 章""第 51–52 章"），让人能回去找。
- 一段连贯的叙述，不要分条，不要小标题；150–300 字。写事实，不评价，不抒情。

## 人物卡（供参照，不要复述）

${base.card}

## 各章的记载

${base.record}

只输出 JSON：{"life": "这一段话"}`, `Below is what the text of "${base.title}" records of ${base.name}: what each chapter's digest noted of them, in reading order (this line of the book has ${base.chapters} chapters). Write, from this, their life in the book: one paragraph.

Requirements:
- Only what the record says. Where they come on, the stretches they are present, the turns they go through, what comes to be between them and others, where they leave or die (if they do); add nothing the record does not say.
- Name the chapters ("chapter 5", "chapters 51–52"), so that a reader can go back to them.
- One connected paragraph; no list, no headings; 120–220 words. Facts, without judgement or flourish.

## The card (for reference; do not repeat it)

${base.card}

## What the chapters noted

${base.record}

Output JSON only: {"life": "the paragraph"}`)
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
/**
 * One round of making the cast: a batch of people the chapters name, and the cards to write for them.
 * @param base.known - who has a card already, for recognizing another name of theirs.
 * @param base.full - whole cards; otherwise a line each, for those with a small part.
 */
export function castRoundTask(base: Base & { sightings: string; known: string; full: boolean }): string {
  const zhShape = base.full
    ? '{"characters": [{"listed": "名单上的写法，原样照抄", "name": "最常用的正式姓名", "same_as": "", "aliases": ["其他称呼"], "role": "protagonist|deuteragonist|antagonist|supporting|minor|cameo", "gender": "", "age": "", "tagline": "一句话人设", "appearance": "", "personality": "", "background": "", "motivation": "", "flaw": "", "arc": "已发生的转变", "voice": "说话方式", "relationships": [{"target": "对方姓名", "kind": "关系", "note": ""}]}]}'
    : '{"characters": [{"listed": "名单上的写法，原样照抄", "name": "最常用的正式姓名", "same_as": "", "aliases": ["其他称呼"], "role": "supporting|minor|cameo", "gender": "", "tagline": "一句话：是谁、和谁有关"}]}'
  const enShape = base.full
    ? '{"characters": [{"listed": "the name as listed, copied exactly", "name": "most used proper name", "same_as": "", "aliases": ["other names"], "role": "protagonist|deuteragonist|antagonist|supporting|minor|cameo", "gender": "", "age": "", "tagline": "one-line identity", "appearance": "", "personality": "", "background": "", "motivation": "", "flaw": "", "arc": "change so far", "voice": "how they talk", "relationships": [{"target": "other name", "kind": "relationship", "note": ""}]}]}'
    : '{"characters": [{"listed": "the name as listed, copied exactly", "name": "most used proper name", "same_as": "", "aliases": ["other names"], "role": "supporting|minor|cameo", "gender": "", "tagline": "one line: who they are, and to whom"}]}'
  const known = base.known.trim().length > 0 ? base.known : L(base.lang, '（还没有）', '(nobody yet)')
  return L(base.lang, `下面是从小说《${bare(base.title)}》各章的收录里统计出来的一批人物，以及每个人在哪些章节做了什么。请为名单上的每一个人整理${base.full ? '一张人物卡' : '一行简介'}。

【这一批】
${base.sightings}

【已经有人物卡的人】只用来辨认别名，不要为他们写卡
${known}

只输出 JSON：
${zhShape}

- 名单上的每个人都要有一项，一个也不要漏；不要添加名单之外的人。
- 名单上的某个名字如果其实是"已经有人物卡的人"里某人的别的称呼，或者是名单上另一个人的别的称呼，这一项只填 listed 和 same_as（写那个人的名字），其余留空。
- role 按这个人在书里的分量定：protagonist 主角，deuteragonist 第二主角，antagonist 对立面，supporting 重要配角，minor 次要人物，cameo 只是露面。
- 没有依据的字段留空，不要编造。`, `Below is a batch of characters counted from the chapter digests of the novel "${bare(base.title)}", with what each did in which chapters. Write ${base.full ? 'a character card' : 'one line'} for every one of them.

THIS BATCH
${base.sightings}

WHO HAS A CARD ALREADY — for recognizing other names only; write no card for them
${known}

Output JSON only:
${enShape}

- One entry for every name in the batch, none left out; nobody who is not in the batch.
- When a name in the batch is in fact another name of someone who has a card already, or of another person in the batch, fill in only \`listed\` and \`same_as\` (that person's name) and leave the rest empty.
- \`role\` by the weight of the part in the book: protagonist, deuteragonist (second lead), antagonist, supporting (an important secondary part), minor, cameo (seen in passing).
- Leave a field empty rather than invent.`)
}

/** The names on a cast list that stand for one person: asked once the cards are made, when every name can be seen beside every other. */
export function castAliasTask(base: Base & { cast: string }): string {
  return L(base.lang, `下面是小说《${bare(base.title)}》人物表里所有人的名字——括号里是已经知道的别名，破折号后是一句话简介。其中有些其实是同一个人的不同称呼（比如"凤姐"和"王熙凤"、"史大姑娘"和"史湘云"）。请把它们找出来。

${base.cast}

只输出 JSON：
{"same": [{"keep": "这个人最正式、最常用的名字", "others": ["人物表里指同一个人的其他名字"]}]}
只列有把握的。亲属、夫妻、主仆、同名不同人都不是同一个人。一个也没有就输出 {"same": []}。`, `Below is everybody on the cast list of the novel "${bare(base.title)}" — known aliases in brackets, a line about them after the dash. Some of these are different names of one and the same person. Find them.

${base.cast}

Output JSON only:
{"same": [{"keep": "the person's most proper, most used name", "others": ["the other names on the list that mean this person"]}]}
Only where you are sure. Relatives, spouses, master and servant, and namesakes are not the same person. If there are none, output {"same": []}.`)
}

/**
 * One round of collecting the world: a batch of places, groups, objects and terms the chapters name.
 * @param base.first - the batch the text comes back to most: it may name core canon, and gives the overview of the world.
 */
export function worldMergeTask(base: Base & { sightings: string; first?: boolean }): string {
  const first = base.first !== false
  return L(base.lang, `下面是从小说《${bare(base.title)}》各章提取到的一批地点、组织、物品与专有名词。请合并重复项，整理成世界观设定条目${first ? '，并补一条总览式的"世界概况"' : ''}。

${base.sightings}

只输出 JSON：
{"entries": [{"name": "名称", "aliases": ["别名"], "category": "setting|location|faction|system|item|history|culture|rule|term|other", "importance": ${first ? '1或2或3' : '2或3'}, "summary": "一句话", "body": "根据原文整理的说明"}]}
importance：${first ? '1=理解全书必须知道的核心设定（不超过 6 条），' : ''}2=常规，3=细节。名单上的每一项都要有着落：单独成条，或并进别的条目当别名。没有依据的内容不要编造。`, `Below is a batch of places, groups, objects and terms extracted chapter by chapter from the novel "${bare(base.title)}". Merge duplicates into world entries${first ? ', and add one overview entry describing the world at large' : ''}.

${base.sightings}

Output JSON only:
{"entries": [{"name": "name", "aliases": ["aliases"], "category": "setting|location|faction|system|item|history|culture|rule|term|other", "importance": ${first ? '1' : '2'}, "summary": "one sentence", "body": "what the text establishes"}]}
importance: ${first ? '1 = core canon needed to follow the book (6 at most), ' : ''}2 = normal, 3 = detail. Everything in the batch ends up somewhere: an entry of its own, or an alias of another. Do not invent beyond the text.`)
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
5. prompt 是给绘图模型的完整画面描述：景别与构图（特写/中景/远景、机位）、在场人物的外貌与动作表情（外貌必须沿用"人物外貌"，每次都写全，不要用姓名指代）、环境与光线、氛围。不要出现文字、对白气泡、分格。60-120 字。只写眼睛看得见的东西：机构名、头衔、专有名词一律换成它在这个故事里实际的样子（材质、形状、新旧、颜色），否则绘图模型会按现实里最常见的样子去画。美术风格里对年代、形制有规定的（发式、服饰、建筑、器物属于哪个朝代、哪种式样），画面里这些东西照它写；正文的写法与它不一样时以美术风格为准。相邻画面不要只是同一张图换个说法——景别、机位或主体要有变化。${avoid.length > 0 ? `下列东西不能出现在任何画面里，也不要把这些词写进 prompt：${avoid}。` : ''}
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
5. prompt: the full picture for the image model — shot size and composition (close-up / medium / wide, angle), the looks, action and expression of everyone in frame (reuse "Character looks" in full every time; never refer to anyone by name), setting and light, mood. No text, speech balloons or panel borders. 40-80 words. Only what the eye can see: an institution, a title or a proper noun is written as what it looks like in this story. Where the art direction fixes a period or a form (which dynasty or fashion hair, dress, buildings and objects belong to), these are written in that form; where the text says otherwise, the art direction holds. Neighbouring panels must not be the same picture in other words — change the shot size, the angle or the subject.${avoid.length > 0 ? ` None of the following may appear in any panel, and none of these words belongs in a prompt: ${avoid}.` : ''}
6. camera: one slow move from still|zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down.

Output JSON only:
{"panels": [{"from": 0, "to": 3, "description": "", "prompt": "", "camera": "zoom-in", "characters": ["names of characters in frame"], "location": "place"}]}`)
}

/**
 * The picture on a book's cover, composed from what the book is: its story, its tone, its leads.
 * @param base.story - the premise, or — for a book that has none written down — what its chapters tell.
 */
/** The director settles how a book's pictures look: one art direction for all of them, and what none of them may show. */
export function artDirectionTask(base: Base & { genre?: string; themes?: string; logline?: string; story: string; tone?: string; leads: string; places?: string; current?: string; ask?: string }): string {
  return L(base.lang, `请为小说《${bare(base.title)}》定下它所有画面共用的画风：封面、人物立绘、人设图、地点设定图、章节插图、有声漫的分镜，都要看得出是同一本书。

## 这本书
${[base.genre !== undefined ? `类型：${base.genre}` : undefined, base.themes !== undefined ? `主题：${base.themes}` : undefined, base.logline !== undefined ? `一句话：${base.logline}` : undefined].filter(Boolean).join('\n') || '（没有填写类型与主题）'}

## 故事
${base.story || '（还没有写下故事梗概）'}

## 文字的基调与笔触
${base.tone !== undefined && base.tone.length > 0 ? base.tone : '（没有专门的文风设定，从故事里体会）'}

## 主要人物
${base.leads || '（还没有人物设定）'}

## 标志性的地方与器物
${base.places !== undefined && base.places.length > 0 ? base.places : '（没有专门的设定）'}
${base.current !== undefined && base.current.length > 0 ? `\n## 现在的画风\n${base.current}\n` : ''}${base.ask !== undefined ? `\n## 作者的要求（以它为准）\n${base.ask}\n` : ''}
要求：
1. 画风是这本书自己的：从它的时代、地域、题材和文字的气质里来。一本民国悬疑和一本太空歌剧不该是同一种画法。
2. style：一段给绘图模型的风格描述，会原样附在每一张图的提示词后面——画种与媒介（水墨、工笔、厚涂、赛璐璐、版画……）、线条与笔触、用色与调子、光线、质感、整体气氛；需要时写明时代与地域的视觉特征（服饰、建筑、器物的年代感）。只写"怎么画"，不写"画什么"，不出现人名和情节。40-90 字。
3. avoid：这本书的任何一张图里都不该出现的东西——和时代不符的物件、和气质相冲的画法、常见的瑕疵。每项几个字，3-8 项。
4. why：一两句话告诉作者为什么这样定。
用 JSON 回答：{"style": "...", "avoid": ["..."], "why": "..."}`, `Settle the look that every picture of the novel "${bare(base.title)}" shares: cover, portraits, design sheets, places, chapter scenes, the panels of its motion comic — all recognisably of one book.

## The book
${[base.genre !== undefined ? `Genre: ${base.genre}` : undefined, base.themes !== undefined ? `Themes: ${base.themes}` : undefined, base.logline !== undefined ? `In a line: ${base.logline}` : undefined].filter(Boolean).join('\n') || '(no genre or themes given)'}

## The story
${base.story || '(no synopsis written yet)'}

## The tone of its prose
${base.tone !== undefined && base.tone.length > 0 ? base.tone : '(no style profile; take it from the story)'}

## Its leads
${base.leads || '(no characters defined yet)'}

## Its places and things
${base.places !== undefined && base.places.length > 0 ? base.places : '(none defined)'}
${base.current !== undefined && base.current.length > 0 ? `\n## The look it has now\n${base.current}\n` : ''}${base.ask !== undefined ? `\n## The author asks (this decides)\n${base.ask}\n` : ''}
Requirements:
1. The look is this book's own: it comes from its period, its place, its genre and the temper of its prose. A noir of the 1920s and a space opera are not painted alike.
2. style: one description of style for an image model, appended as it is to the prompt of every picture — the medium (ink wash, gouache, thick paint, cel, woodcut…), line and brushwork, palette and key, light, texture, the air of the whole; where it matters, what the period and the place look like (clothes, buildings, objects of their time). Say how to paint, not what: no names, no plot. 30-70 words.
3. avoid: what no picture of this book may show — things out of its period, manners of painting at odds with its temper, the usual flaws. A few words each, 3-8 of them.
4. why: a sentence or two telling the author why.
Answer in JSON: {"style": "...", "avoid": ["..."], "why": "..."}`)
}

export function coverPromptTask(base: Base & { genre?: string; themes?: string; logline?: string; story: string; tone?: string; leads: string; places?: string; artStyle: string; avoid?: string[]; ask?: string }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  return L(base.lang, `请为小说《${bare(base.title)}》构思封面，写一条给绘图模型的画面描述。

## 这本书
${[base.genre !== undefined ? `类型：${base.genre}` : undefined, base.themes !== undefined ? `主题：${base.themes}` : undefined, base.logline !== undefined ? `一句话：${base.logline}` : undefined].filter(Boolean).join('\n') || '（没有填写类型和主题）'}

## 故事
${base.story || '（还没有写下故事梗概）'}

## 基调与笔触
${base.tone !== undefined && base.tone.length > 0 ? base.tone : '（没有专门的文风设定，从故事里体会）'}

## 主要人物的样子
${base.leads || '（还没有人物设定：封面可以不出现人物的脸，用场景、器物和氛围来说这本书）'}

## 标志性的地方与器物
${base.places !== undefined && base.places.length > 0 ? base.places : '（没有专门的设定）'}
${base.ask !== undefined ? `\n## 作者的要求\n${base.ask}\n` : ''}
## 美术风格（会另行附加，不必复述）
${base.artStyle}

## 画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. 封面要让没读过的人一眼看出这是一本什么样的书：选一个最能代表这个故事的画面——人物的关系与处境、标志性的地方、一件有分量的东西，而不是把情节画成连环画。
2. 竖幅构图；画面上方留出一块干净的空间放标题；主体在中下部。写清谁在画面里（用他们的样子，不用姓名）、姿态与神情、所处的环境、光线、色调与气氛。
3. 只写眼睛看得见的东西。机构名、头衔、专有名词换成它在这个故事里实际的样子：材质、形状、新旧、颜色。美术风格里对年代、形制有规定的（发式、服饰、建筑、器物属于哪个朝代、哪种式样），画面里这些东西照它写；正文的写法与它不一样时以美术风格为准。
4. "画面里不能出现"的东西不要画，也不要把这些词写进描述。不要出现任何文字、水印、边框。
5. 120-220 字，只输出这条描述，不要任何其他内容。`, `Design the cover of the novel "${bare(base.title)}": write one picture description for an image model.

## The book
${[base.genre !== undefined ? `Genre: ${base.genre}` : undefined, base.themes !== undefined ? `Themes: ${base.themes}` : undefined, base.logline !== undefined ? `In a line: ${base.logline}` : undefined].filter(Boolean).join('\n') || '(no genre or themes given)'}

## The story
${base.story || '(no premise written down yet)'}

## Tone and touch
${base.tone !== undefined && base.tone.length > 0 ? base.tone : '(no style set: take it from the story)'}

## How the leads look
${base.leads || '(no characters defined yet: the cover may show no face at all, and tell the book by place, object and mood)'}

## Places and things that stand for the book
${base.places !== undefined && base.places.length > 0 ? base.places : '(nothing defined)'}
${base.ask !== undefined ? `\n## The author asks\n${base.ask}\n` : ''}
## Art direction (appended separately; do not restate it)
${base.artStyle}

## Must not appear in the picture
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Requirements:
1. A cover tells somebody who has not read the book what kind of book it is: choose the one picture that stands for this story — who these people are to each other and where they stand, a place that is the book's own, one thing that carries weight — not the plot drawn as a strip.
2. Portrait format; a clean area at the top for the title; the subject in the middle and lower part. Say who is in the picture (by how they look, not by name), their pose and expression, where they are, the light, the palette and the mood.
3. Only what the eye can see. Names of institutions, ranks and proper nouns become what they actually look like in this story: material, shape, age, colour. Where the art direction fixes a period or a form (which dynasty or fashion hair, dress, buildings and objects belong to), these are written in that form; where the text says otherwise, the art direction holds.
4. Nothing from "must not appear" is drawn, and none of those words go into the description. No lettering, no watermark, no frame.
5. 80-150 words. Output the description only.`)
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
3. 只写眼睛看得见的东西。机构名、头衔、教派、专有名词这类词，绘图模型会按现实世界里最常见的样子去画（看到"教会"就画出欧式教堂）——一律换成它在这个故事里实际的样子：材质、形状、新旧、脏净、颜色。美术风格里对年代、形制有规定的（发式、服饰、建筑、器物属于哪个朝代、哪种式样），画面里这些东西照它写；正文的写法与它不一样时以美术风格为准。
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
3. Write only what the eye can see. Names of institutions, titles, orders and other proper nouns make an image model draw the most common real-world version (it reads "church" and paints a cathedral) — replace each with what it actually looks like in this story: material, shape, age, wear, colour. Where the art direction fixes a period or a form (which dynasty or fashion hair, dress, buildings and objects belong to), these are written in that form; where the text says otherwise, the art direction holds.
4. Nothing from "Must not appear" may be drawn, and none of those words may appear in the description.
5. No text, watermark or panel borders. 50-100 words. ${dressed ? 'Output JSON only: {"description": "the picture", "wearing": {"character name": "look name"}}; describe a character in the look you picked for them.' : 'Output the description only.'}`)
}

/** Distill a character's prose appearance into an anchor an image model can draw the same way every time. */
/** What a turn of a course asks a picture to show, by its kind. */
const TURN_ASKS: Record<'begin' | 'change' | 'decline' | 'end', [string, string]> = {
  begin: ['它刚有的时候——正在兴建、刚刚落成，还是刚造出来：照正文写到的那个阶段写', 'when it first comes to be — being built, just finished, newly made: the stage the text has it at'],
  change: ['变动之后——换了主人、名字、用途或形制以后，眼睛看得出的不同', 'after the change — what the eye can tell is different once it has another owner, name, use or shape'],
  decline: ['衰败之后——冷清、失修、荒芜到了什么地步', 'in decline — how empty, unkept and overgrown it has become'],
  end: ['终结之后——毁成了什么样，还剩下什么', 'after its end — what the ruin is like, and what is left'],
}

/**
 * The book's art direction, as it is handed to whoever writes down how somebody
 * or something looks. It travels with every picture anyway — appended after
 * the subject — but there it comes last and can only colour what the subject
 * has already said: a look that says "a queue" is drawn with a queue, whatever
 * period the art direction names. So the period and the forms it fixes have to
 * be in the look itself, and whoever writes the look has to be told.
 */
function artSection(lang: PromptLanguage, artStyle: string | undefined): string {
  const style = artStyle?.trim() ?? ''
  if (style.length === 0) return ''
  return L(lang, `\n## 这本书的画风（作者定的，会另行附在每一张图后面）\n${style}\n`, `\n## The book's art direction (settled by the author; appended to every picture separately)\n${style}\n`)
}

/**
 * How a place or a thing looks from one turn of its course on: the paragraph
 * the picture of that turn is drawn from. The same place as its design art,
 * changed by what happened — and only by that.
 * @param base.usual - how it usually looks: what its design art was drawn from.
 * @param base.turn - what happened, and at which chapter.
 * @param base.passages - where that chapter names it, a few lines each.
 */
export function turnLookTask(base: Base & { kind: 'place' | 'thing'; name: string; usual: string; turn: { index?: number; kind: 'begin' | 'change' | 'decline' | 'end'; what: string }; passages: string; avoid?: string[]; artStyle?: string }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  const place = base.kind === 'place'
  const ask = L(base.lang, ...TURN_ASKS[base.turn.kind])
  return L(base.lang, `《${base.title}》里的「${base.name}」在故事里出了一件事。请写一段"这件事过后它看上去是什么样"：要照这段话给它画一张"这时的样子"，读者把时间拖到这里，看到的就是这张。

## 它平常的样子（它的设定图就是照这段画的）
${base.usual}

## 发生在它身上的事
${base.turn.index !== undefined ? `第 ${base.turn.index} 章：` : ''}${base.turn.what}

## 这一章里写到它的地方
${base.passages.length > 0 ? base.passages : '（这一章里没有找到直接写它的句子——需要的话自己去查原文。）'}
${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. 用这本书的语言写，80–160 字，一段话，不分条。
2. 写的是同一${place ? '个地方' : '件东西'}：${place ? '格局、建筑、材质' : '形状、材质、纹饰'}这些没有变的，照"平常的样子"写；变了的，写成变过之后的样子。要写的是：${ask}。
3. 以正文为准：正文写了的照着写；正文没写的可以补全，但要与这件事、与这本书的时代和地域相称。只有一样例外：画风里对年代、地域和形制有规定的（建筑、陈设、器物属于哪个朝代、哪种式样），是这本书的定论——正文的写法与它冲突时，形制照画风写。
4. 只写这件事过后留在眼前的景象，画面里一个人也没有：不写人物（工匠、仆役、路人也不写），不写谁做了什么、事情的经过；不写气味、声音、寓意这类画不出来的东西；不写画风、镜头、光线效果、画质。
5. 不要用只有读过这本书才懂的名字来代替描述。

只输出 JSON：{"look": ""}`, `Something happens to "${base.name}" in "${base.title}". Write a paragraph of what it looks like once that has happened: a picture of it "as it is then" is drawn from this paragraph, and it is what a reader sees with the story's time moved here.

## How it usually looks (its design art was drawn from this)
${base.usual}

## What happens to it
${base.turn.index !== undefined ? `Chapter ${base.turn.index}: ` : ''}${base.turn.what}

## Where that chapter names it
${base.passages.length > 0 ? base.passages : '(No sentence of the chapter was found that speaks of it — read the text yourself where you need to.)'}
${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. In the language of the book, 50–110 words, one paragraph, no list.
2. It is the same ${place ? 'place' : 'thing'}: what has not changed — ${place ? 'its layout, its buildings, its materials' : 'its shape, its material, its ornament'} — say as "how it usually looks" has it; what has changed, say as it is after the change. What is wanted: ${ask}.
3. The text is law: what it says, say as it says it; what it leaves open may be filled in, in keeping with what happened and with the book's time and region. With one exception: where the art direction fixes a period, a region or a form (which dynasty or fashion buildings, furnishings and objects belong to), that is settled for this book — where the text says otherwise, the form follows the art direction.
4. Only what is there to be seen once it has happened, with nobody in the picture: no people (no workmen, servants or passers-by either), nothing of who did what or how it went; nothing that cannot be drawn (smell, sound, meaning); no words about art style, camera, lighting effects or image quality.
5. Do not put a name only a reader of the book understands in place of a description.

Output JSON only: {"look": ""}`)
}

/**
 * The look of a place or a thing, written down from what the book says of it:
 * what its design art is drawn from, and every picture that shows it after.
 * @param base.kind - `place` or `thing`: a house or an organization is drawn as the place it has its seat at.
 * @param base.passages - where the text names it, a few lines each, with the chapter.
 */
export function lookTask(base: Base & { kind: 'place' | 'thing'; entry: string; passages: string; avoid?: string[]; direction?: string; artStyle?: string }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  const place = base.kind === 'place'
  return L(base.lang, `请把《${base.title}》里的这${place ? '个地方' : '件东西'}写成一段"它长什么样"：它的设定图照这段话画，以后凡是画到它的图也都带着这段话，所以要具体、稳定、画得出来。

## 设定里怎么写它
${base.entry}

## 正文里写到它的地方
${base.passages.length > 0 ? base.passages : '（正文里还没有找到直接写它样子的句子——需要的话自己去查原文。）'}
${base.direction !== undefined && base.direction.length > 0 ? `\n## 作者的要求\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. 用这本书的语言写，80–160 字，一段话，不分条。
2. 只写看得见的、不随情节变的：${place ? '格局与规模（几进院落、有没有水、地势高低）、主要的建筑和它们的样式、材质与颜色、草木与陈设、年代与地域的感觉' : '形状与大小、材质、颜色、纹饰或刻着的字样（照原文）、新旧与磨损、拿在手里或摆着时的样子'}。
3. 以正文为准：正文写了的照着写，不要改；正文没写的可以补全，但要与这本书的时代、地域、身份相称，一旦写下就是定论。只有一样例外：画风里对年代、地域和形制有规定的（${place ? '建筑、陈设、器物' : '器物、纹饰、做工'}属于哪个朝代、哪种式样），是这本书的定论——把它写成那种形制下具体的样子（${place ? '屋顶、梁柱、门窗、院墙怎么样' : '器形、纹样、工艺怎么样'}）。正文的写法与它冲突时以画风为准：它自己的${place ? '格局、规模和特征' : '形状、大小和特征'}留着，形制换成画风规定的。
4. 不写人物、不写事件、不写某一场戏里的情形；不写气味、声音、寓意这类画不出来的东西；画风里说"怎么画"的部分（画种、笔触、用色、光线）、镜头和画质都不写——那些由全书的画风统一附上。
5. 不要用只有读过这本书才懂的名字来代替描述：${place ? '"某某的住处"要写成它实际的样子' : '"那面镜子"要写成它实际的样子'}。

只输出 JSON：{"look": ""}`, `Write down what this ${place ? 'place' : 'thing'} of "${base.title}" looks like: its design art is drawn from this paragraph, and every later picture that shows it carries it along — so it has to be concrete, stable and drawable.

## What the bible says of it
${base.entry}

## Where the text names it
${base.passages.length > 0 ? base.passages : '(No sentence of the text was found that says how it looks — read the text yourself where you need to.)'}
${base.direction !== undefined && base.direction.length > 0 ? `\n## The author asks\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. In the language of the book, 50–110 words, one paragraph, no list.
2. Only what can be seen and does not change with the plot: ${place ? 'its layout and size (courts, water, the lie of the land), its main buildings and how they are built, materials and colours, what grows and what is kept there, the feel of its time and region' : 'its shape and size, material, colour, ornament or what is written on it (as the text has it), its age and wear, how it sits in a hand or on a table'}.
3. The text is law: what it says, say as it says it; what it leaves open may be filled in, in keeping with the book's time, region and the standing of whoever owns it — once written it is canon. With one exception: where the art direction fixes a period, a region or a form (which dynasty or fashion ${place ? 'buildings, furnishings and objects' : 'objects, ornament and workmanship'} belong to), that is settled for this book — write it as it is in that form (${place ? 'roofs, posts and beams, doors and windows, walls' : 'its shape, its patterns, how it is made'}). Where the text says otherwise the art direction holds: keep what is its own (${place ? 'layout, size, what marks it out' : 'shape, size, what marks it out'}) and put it into the form the art direction fixes.
4. No people, no events, nothing of one particular scene; nothing that cannot be drawn (smell, sound, meaning); nothing of how to paint (medium, brushwork, palette, light), of camera or of image quality — the book's art direction adds those to every picture.
5. Do not put a name only a reader of the book understands in place of a description.

Output JSON only: {"look": ""}`)
}

/**
 * A character's visual anchor: how they look, in phrases an image model draws
 * the same way every time.
 * @param base.artStyle - the book's art direction: where it fixes a period or a form of dress, the anchor is written in that form, over what the card and the source text say.
 * @param base.current - the anchor as it stands, when one is written again: what it has that nothing speaks against is kept, so that pictures already drawn still fit.
 */
export function visualAnchorTask(base: Base & { card: string; avoid?: string[]; direction?: string; artStyle?: string; current?: string; currentNegative?: string }): string {
  const avoid = (base.avoid ?? []).join(', ')
  const again = base.current !== undefined && base.current.trim().length > 0
  const styled = (base.artStyle?.trim() ?? '').length > 0
  return L(base.lang, `请把下面这个人物的外貌，${again ? '重新写成' : '改写成'}给绘图模型用的"视觉锚点"：以后每一张有此人的图都会原样带上它，所以它必须具体、稳定、画得出来。

## 人物
${base.card}
${again ? `\n## 现在的视觉锚点（要重写的就是它）\n${base.current!.trim()}${base.currentNegative !== undefined && base.currentNegative.trim().length > 0 ? `\n这个人身上不要画出：${base.currentNegative.trim()}` : ''}\n` : ''}${base.direction !== undefined && base.direction.length > 0 ? `\n## 作者的要求\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. prompt：英文，逗号分隔的短语，40-70 个词。只写看得见的：年龄感与体型、脸、发色与发型（把发型拆成具体的形状，不要用风格名）、肤色、衣着（款式、材质、颜色、新旧）、随身的标志物。
2. 不要写姓名、性格、身份、经历；不要用机构名、教派、头衔之类的词——绘图模型会按现实里最常见的样子去画。比如"教会式的发髻"要写成它实际的形状，"白甲"要写清是什么材质、什么结构、有没有纹饰。
3. 原文没写的细节可以补全，但要与人物相称，并且一旦写下就是定论。${styled ? `
4. 画风里对年代、地域和形制有规定的（哪个朝代、哪种式样），是这本书的定论，这个人的头发和衣着一律写成那种形制。人物卡或原文的写法与它冲突时，以画风为准：
   - 属于形制的：头发怎么梳、束不束、编不编辫、剃不剃，头上戴什么；衣服的款式——上身下身各穿什么、领、襟、袖、下摆、怎么系；鞋帽的样式。
   - 人物卡或原文写的发式、款式若不是那种形制里有的（比如别的朝代才有的发式和衣服），不要照搬，也不要折中成两样都有：换成那种形制下，同样年龄、身份的人会有的发式和款式，写成具体的样子，并且点明朝代。
   - 这个人自己的东西留着，放到新的款式上：颜色、纹样、材质、贵贱、佩戴和随身的东西。
   - 画风里说"怎么画"的部分（画种、笔触、用色、光线）不要写进来。` : ''}
${styled ? 5 : 4}. 只写这个人"长什么样"，不写"此刻在做什么"：不要动作、姿势、此刻的表情和手里临时拿的东西；不要气味、声音、气质这类看不见的东西；也不要画风、光线、镜头、画质之类的词——那些由全书的画风统一附上。
${styled ? 6 : 5}. negative：英文，逗号分隔，0-10 项。写这段描述最容易被画错、而这个人物身上不该有的东西（例如不该有的纹章、饰物、发型、年龄感）${styled ? '；画风规定了形制时，把最容易混进来的别的形制也列进去（比如另一个朝代的发式和服饰）' : ''}。${again ? `
${styled ? 7 : 6}. 这是重写：现在的锚点里，与人物卡、作者的要求${styled ? '和画风' : ''}都不冲突的写法照旧保留（已经画好的图是照它画的）；有冲突的和明显写错的地方要改${styled ? '——锚点和 negative 里不合画风所定形制的发式、款式，一处也不要留' : ''}。` : ''}

只输出 JSON：{"prompt": "", "negative": ""}`, `Rewrite this character's appearance as a "visual anchor" for an image model: it will be restated as is in every picture that shows them, so it must be concrete, stable and drawable.

## Character
${base.card}
${again ? `\n## Their visual anchor as it stands (this is what is written again)\n${base.current!.trim()}${base.currentNegative !== undefined && base.currentNegative.trim().length > 0 ? `\nNever drawn on them: ${base.currentNegative.trim()}` : ''}\n` : ''}${base.direction !== undefined && base.direction.length > 0 ? `\n## The author asks\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. prompt: English, comma-separated phrases, 40-70 words. Only what can be seen: apparent age and build, face, hair colour and style (spell the style out as a shape, not as a style name), skin, clothing (cut, material, colour, wear), signature items.
2. No names, personality, role or history; no names of institutions, orders or titles — an image model draws the most common real-world version of such words. Describe "a church-style bun" as its actual shape; say what "white armour" is made of, how it is built and whether it carries any emblem.
3. Details the source leaves open may be filled in, in keeping with the character; once written they are canon.${styled ? `
4. Where the art direction fixes a period, a region or a form of dress (which dynasty, which fashion), that is settled for this book, and this person's hair and clothing are written in that form throughout. Where the card or the source text says otherwise, the art direction holds:
   - Of the form: how the hair is dressed — bound or loose, braided or not, shaved or not — and what is worn on the head; the cut of the clothes — what is worn above and below, collar, lapels, sleeves, hem, how it is fastened; the make of shoes and hats.
   - A hairstyle or a cut the card or the source text has that does not belong to that form (the hair and the garments of another dynasty, say) is not carried over, and not blended in so that both are there: put in its place what somebody of that age and standing wears in that form, written as what it looks like, with the period named.
   - What is this person's own stays, and goes onto the new cut: colours, patterns, materials, how rich or plain, what they wear and carry.
   - What the art direction says of how to paint (medium, brushwork, palette, light) stays out.` : ''}
${styled ? 5 : 4}. Say what the person looks like, not what they are doing: no action, pose, passing expression or thing they happen to hold; nothing that cannot be seen (smell, sound, temperament); and no words about art style, lighting, camera or image quality — the book's art direction adds those to every picture.
${styled ? 6 : 5}. negative: English, comma-separated, 0-10 items: what this description is most likely to be drawn as by mistake and what this character must not have (an emblem, an ornament, a hairstyle, an age)${styled ? '; where the art direction fixes a form, also the other forms most likely to creep in (the hair and dress of another dynasty, say)' : ''}.${again ? `
${styled ? 7 : 6}. This is a rewrite: what the anchor has that neither the card, nor what the author asks${styled ? ', nor the art direction' : ''} speaks against stays as it is (pictures already drawn were drawn from it); what conflicts and what is plainly wrong is changed${styled ? ' — no hairstyle and no cut that is not of the form the art direction fixes is left in the anchor or in negative' : ''}.` : ''}

Output JSON only: {"prompt": "", "negative": ""}`)
}

/**
 * The moment of the book somebody's portrait shows: the scene a reader
 * remembers them by, picked from the book and written as a picture.
 * @param base.record - what the chapter digests noted of them, chapter by chapter: leads to follow into the text, not the text.
 * @param base.anchor - how they look, as every picture of them restates it: not to be written again.
 * @param base.current - the scene kept so far, when another is asked for.
 */
export function portraitSceneTask(base: Base & { name: string; card: string; anchor?: string; record: string; current?: string; direction?: string; avoid?: string[]; artStyle?: string }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  const styled = (base.artStyle?.trim() ?? '').length > 0
  return L(base.lang, `请为《${bare(base.title)}》里的「${base.name}」挑一个"名场面"：读过这本书的人一想到这个人，就会想起的那一幕。这个人的立绘就照这一幕来画。

## 人物
${base.card}

## 这个人的样子（立绘里会原样带上，不必复述）
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '（还没有写下来）'}

## 各章的收录里对这个人的记载
${base.record.length > 0 ? base.record : '（还没有哪一章的收录记到这个人——到原文里去找。）'}
${base.current !== undefined && base.current.length > 0 ? `\n## 现在定的那一幕（作者要换一个）\n${base.current}\n` : ''}${base.direction !== undefined && base.direction.length > 0 ? `\n## 作者的要求（以它为准）\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. 只从这本书里挑：正文里真写了的一幕。上面的记载是各章收录时记下的，只是线索，而且可能只收录了一部分章节——没收录的章节里也可能有；定下来的那一幕，要照原文那一段来写。书里还没有哪一幕算得上（这个人还没怎么出场），就如实说没有：scene 留空，不要编。
2. 挑最属于这个人的那一幕：换一个人就不成立；一眼认得出——在哪里、在做什么、手里拿着什么。书里公认的名场面优先于只是出场多的地方。
3. 这是立绘，是这个人的门面——挂在人物页和列表里，读者在画册里也看得到：
   - 画面里只有这个人。那一幕里还有别人的，只写这个人自己那一刻的样子，别人一个字不写；离了别人就不成立的一幕（搂抱、厮打、对饮、对谈），换一幕。
   - 不挑亲热、裸露、施暴、受刑、病危和死状这类场面，再有名也换一幕：挑这个人最好认、也拿得出手的样子。
   - 写一个定格的瞬间，不是一段经过：不写对话，不写先后发生的几件事。
4. scene：用这本书的语言写成一段，60–140 字。先用几个字点明是哪一幕、在第几章（如"葬花（第 27 章）："），再写画面：时间与地点、这个人在做什么、姿态与神情、手里和身边的东西、光线与气氛。人物是画面的主体，半身到七分身，脸看得清。
5. 长相和平常的衣着不要重写（会另行带上）；只有这一幕里原文写明换了的穿戴才写。${styled ? '画风里对年代、形制有规定的（发式、服饰、建筑、器物属于哪个朝代、哪种式样），画面里这些东西照它写；原文的写法与它不一样时以画风为准。' : ''}
6. 只写眼睛看得见的；只有读过这本书才懂的名字，写成它实际的样子；"不能出现"的东西不要写。不写画风、镜头、画质。
7. why：一句话告诉作者为什么是这一幕。

只输出 JSON：{"scene": "", "why": ""}`, `Pick the "signature scene" of ${base.name} in "${bare(base.title)}": the moment somebody who has read the book thinks of when they think of this person. Their portrait is drawn from it.

## Character
${base.card}

## How they look (restated as is in the portrait; do not write it again)
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '(not written down yet)'}

## What the chapter digests noted of them
${base.record.length > 0 ? base.record : '(No chapter digest names them yet — look in the text.)'}
${base.current !== undefined && base.current.length > 0 ? `\n## The scene kept so far (the author wants another)\n${base.current}\n` : ''}${base.direction !== undefined && base.direction.length > 0 ? `\n## The author asks (this decides)\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. From this book only: a moment the text really has. The notes above were taken as chapters were digested — leads, and possibly of some chapters only; chapters not digested may have one too. The moment settled on is written as that passage of the text has it. Where the book has no such moment yet (they have hardly been on the page), say so: leave scene empty, invent nothing.
2. The moment that is most this person's own: it would not hold with anybody else in it; it is told at a glance — where, doing what, holding what. A moment the book is known by comes before a place they are merely often in.
3. It is a portrait — how this person is presented: on their page, in every list, and to readers in the book's album:
   - Only this person is in the picture. Where others are in the moment, write this person as they are in that instant and not a word of the others; a moment that does not hold without somebody else (an embrace, a fight, a toast, a talk) gives way to another.
   - No moment of intimacy, nudity, violence done or suffered, torture, the sickbed or death, however well known: another moment is picked — the one they are best known by that can be shown to anyone.
   - One instant held still, not a course of events: no dialogue, no one thing after another.
4. scene: one paragraph in the language of the book, 40–100 words. First, in a few words, which moment it is and in which chapter (as in "Burying the flowers (chapter 27):"), then the picture: time and place, what they are doing, bearing and expression, what is in their hands and around them, light and mood. The person is the subject, waist-up to three-quarter length, the face clearly seen.
5. Their face and usual clothing are not written again (they are added separately); only what the text says they wear differently in this moment.${styled ? ' Where the art direction fixes a period or a form (which dynasty or fashion hair, dress, buildings and objects belong to), these are written in that form; where the text says otherwise, the art direction holds.' : ''}
6. Only what the eye can see; a name only a reader of the book understands is written as what it looks like; nothing from "must not appear". No words about art style, camera or image quality.
7. why: one sentence telling the author why this moment.

Output JSON only: {"scene": "", "why": ""}`)
}

/**
 * Sort an author's loose notes on a character's picture: what is of the person
 * goes into how they look from now on, what is of this one picture directs
 * this picture and nothing else.
 * @param base.picture - the picture about to be drawn: a portrait, or a design sheet (which has no setting to give).
 * @param base.anchor - the visual anchor as it stands; absent when there is none yet, and one is to be written.
 */
export function lookNotesTask(base: Base & { card: string; anchor?: string; negative?: string; notes: string; picture: 'portrait' | 'sheet'; avoid?: string[]; artStyle?: string }): string {
  const avoid = (base.avoid ?? []).join(', ')
  const zhPicture = base.picture === 'sheet'
    ? '人设图（三视图）：同一个人的全身站姿画三次——正面、侧面、背面，素底，表情平静。它没有背景、天气、时间、动作和镜头，这类想法这张图用不上。'
    : '立绘：半身像，面向镜头。它可以有自己的背景、时间、天气、光线、姿势和神态。'
  const enPicture = base.picture === 'sheet'
    ? 'a design sheet (turnaround): the same person standing, full body, three times — front, side, back — on a plain ground, with a neutral expression. It has no setting, weather, time of day, action or camera: ideas of that kind have no place in it.'
    : 'a portrait: waist-up, facing the viewer. It can have a setting, a time of day, weather, light, a pose and an expression of its own.'
  return L(base.lang, `作者在给《${bare(base.title)}》的一个人物画图之前，随手写下了一些想法。它们混在一起：有的说的是这个人本身，有的只是这一张图想要的样子。请把它们分开。

## 人物
${base.card}

## 这个人现在的视觉锚点（每一张有此人的图都会原样带上）
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '（还没有——请根据上面人物卡里的外貌和作者的想法写出来）'}
${base.negative !== undefined && base.negative.length > 0 ? `\n这个人身上不要画出：${base.negative}\n` : ''}
## 现在要画的这一张
${zhPicture}

## 作者随手写的想法
${base.notes}
${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

怎么分：
1. **属于这个人本身的**——以后每一张图里都该是这样：长相、年龄感、体型、肤色、发色与发型、疤痕胎记、平常的衣着（款式、材质、颜色、新旧）、随身的标志物。把它们融进视觉锚点：保留锚点里原有的内容，只改动作者这次说到的地方；和原来的写法冲突时，以作者这次说的为准。
2. **只属于这一张图的**——换一张图就不一定是这样：时间、天气、季节、地点与背景、光线、姿势与动作、此刻的神态、构图与镜头、这一次临时穿戴或拿在手里的东西、气氛。它们不进视觉锚点，写进 picture。
3. 分不清时看作者的说法："这张 / 这次 / 这幅 / 这里"说的是这一张图；"总是 / 平时 / 一直 / 常年"，或者没有限定、说的又是长相和平常衣着的，是这个人本身。
4. 现在要画的这一张用不上的想法（见上面对这一张图的说明），不要硬塞进 picture，列进 unused。
5. 作者没有说到的，不要替他添。${(base.artStyle?.trim() ?? '').length > 0 ? `
6. 新写进锚点的部分，形制要合这本书的画风：画风里对年代、形制有规定的（发式、服饰属于哪个朝代、哪种式样），就写成那种形制下具体的样子。作者这次明说要的样子与画风不一样时，以作者这次说的为准。` : ''}

anchor 的写法：英文，逗号分隔的短语，40-70 个词，只写看得见的；不写姓名、性格、身份、经历，不用机构名、教派、头衔之类的词（绘图模型会按现实里最常见的样子去画，要写成它实际的形状和材质）；不写动作、姿势、此刻的表情，不写画风、光线、镜头、画质。没有任何想法属于这个人本身、而锚点已经有了时，anchor 原样照抄。

只输出 JSON：
{"anchor": "分完之后的整段视觉锚点", "negative": "这个人身上不该画出的东西（英文，逗号分隔）；没有变化就照抄原来的，没有就留空", "appearance": "kept 里那几点当中，人物卡的外貌还没有写到的：用${base.language}写成一句短话，可以直接接在原有外貌后面。只写作者说的那几点——外貌里已经有的不重复，作者没说的材质、新旧、来历之类不要添。都已经有了就留空", "picture": "只属于这一张图的要求，写成给绘图模型的一句话；没有就留空", "kept": ["进了这个人形象的每一点，用作者的话，几个字一条"], "once": ["只用在这一张图上的每一点，几个字一条"], "unused": ["这一张图用不上的每一点，几个字一条"]}`, `Before a picture of a character of "${bare(base.title)}" is drawn, the author jotted down some ideas. They are mixed: some are about the person, some only about what this one picture should be. Sort them.

## Character
${base.card}

## Their visual anchor as it stands (restated as is in every picture that shows them)
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '(none yet — write one from the appearance on the card above and the author\'s ideas)'}
${base.negative !== undefined && base.negative.length > 0 ? `\nNever drawn on them: ${base.negative}\n` : ''}
## The picture about to be drawn
${enPicture}

## The author's ideas, as jotted down
${base.notes}
${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

How to sort:
1. **Of the person** — so in every picture from now on: face, apparent age, build, skin, hair colour and style, scars and marks, what they usually wear (cut, material, colour, wear), signature items. Work these into the visual anchor: keep what the anchor has, change only what the author speaks of now; where the two disagree, what the author says now holds.
2. **Of this one picture** — not necessarily so in the next: time of day, weather, season, place and background, light, pose and action, a passing expression, composition and camera, what they wear or hold this once, mood. None of it goes into the anchor; it goes into picture.
3. Where it is hard to tell, go by how the author put it: "in this one / this time / here" speaks of the picture; "always / usually / all year round", or no such word about looks and usual clothing, speaks of the person.
4. An idea the picture about to be drawn has no place for (see what is said of it above) is not forced into picture: list it under unused.
5. Add nothing the author did not speak of.${(base.artStyle?.trim() ?? '').length > 0 ? `
6. What is newly written into the anchor is in the form the book's art direction fixes: where it names a period or a form of dress (which dynasty or fashion hair and clothing belong to), write it as it is in that form. Where the author's idea now plainly asks for something else, the author's word now holds.` : ''}

The anchor: English, comma-separated phrases, 40-70 words, only what can be seen; no names, personality, role or history, no names of institutions, orders or titles (an image model draws the most common real-world version of such words — say its actual shape and material); no action, pose or passing expression, no art style, light, camera or image quality. Where no idea is of the person and there is an anchor already, copy the anchor as it is.

Output JSON only:
{"anchor": "the whole visual anchor once sorted", "negative": "what must not be drawn on them (English, comma-separated); copy what there is where nothing changes, leave empty where there is none", "appearance": "of the points under kept, those the card's appearance does not have yet: one short sentence in ${base.language} that can follow it directly. Only what the author said — nothing the appearance already says, and no material, wear or history the author did not speak of. Empty where it has them all", "picture": "what is asked of this one picture, as one line for the image model; empty where there is nothing", "kept": ["each point that went into how the person looks, in the author's words, a few words each"], "once": ["each point used for this one picture only, a few words each"], "unused": ["each point this picture has no place for, a few words each"]}`)
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

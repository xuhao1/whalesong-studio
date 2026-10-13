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
 * @param base.keyed - what the chapter was derived with went along (see `renderIntent`): the key it sets is named
 *   here, with what is asked last — said only among what was read, a key loses to the book's usual voice.
 */
export function writerTask(base: Base & { context: string; brief?: string; continuing: boolean; words?: number; usual?: number; keyed?: boolean; /** The pictures the author gave for this chapter, as the task tells of them. */ pictures?: string; /** What the book's references have for this chapter: the notes kept on its plan. */ references?: string; /** What the author asks of the references at large, said with the notes. */ referenceGuide?: string ; /** How the text is to be handed back, where that is not as the reply itself: a writer at work as an agent hands it in with a tool (`composeHow`). */ how?: string }): string {
  const pictures = base.pictures !== undefined && base.pictures.trim().length > 0 ? `\n\n${base.pictures.trim()}` : ''
  const overall = base.referenceGuide !== undefined && base.referenceGuide.trim().length > 0 ? [`作者对参考文献的总要求：${base.referenceGuide.trim()}\n\n`, `What the author asks of the references at large: ${base.referenceGuide.trim()}\n\n`] : ['', '']
  const references = base.references !== undefined && base.references.trim().length > 0
    ? L(base.lang, `\n\n## 参考摘记（策划从这本书的参考文献里为这一章查来的）\n\n${overall[0]}${base.references.trim()}\n\n摘记是用来对照和借鉴的：事实与设定照它，写法可以学；引来的原文不要整段搬进正文。它和章纲、前文冲突时，以章纲和前文为准。`, `\n\n## Notes from the references (what the planner found for this chapter in the books this one goes by)\n\n${overall[1]}${base.references.trim()}\n\nThe notes are to hold the chapter against and to learn from: facts and settings as they have them, ways of writing to borrow; wording quoted there is not carried into the chapter at length. Where they are at odds with the outline or the story so far, those hold.`)
    : ''
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
  const how = base.how ?? L(
    base.lang,
    base.continuing ? '你是在续写：从"本章已有正文"的最后一个字之后接着写，不要重复已有内容，衔接处不能看出缝。直接输出续写的正文。' : '从本章第一句开始写，直接输出正文。',
    base.continuing ? 'You are continuing: pick up right after the last word of "This chapter so far", repeat nothing, and leave no seam. Output the continuation only.' : 'Start from the first sentence of the chapter. Output the prose only.',
  )
  const key = base.keyed === true
    ? L(base.lang, '基调：照上面“这几章当初定下的思路”里定的写——它和这本书平时的气氛不一样时，这一章照它。\n', 'Key: as set above under "The thinking these chapters were planned with" — where that is not the book\'s usual mood, this chapter goes by it.\n')
    : ''
  return `${base.context}${brief}${references}${pictures}\n\n---\n${key}${length}\n${how}`
}

/**
 * Notes for one chapter out of the book's references: the planner reads in them — with its tools, as far as the
 * author opened each — and hands in what whoever writes the chapter can use.
 */
export function referenceNotesTask(base: Base & { chapter: string; before?: string; references: string; direction?: string }): string {
  return L(base.lang, `《${bare(base.title)}》有参考文献。下面这一章就要动笔了：请到参考文献里查这一章用得上的东西，给写手留一份摘记。写手没有工具，它能看到的只有你交回的这份摘记。

## 要写的这一章
${base.chapter}
${base.before !== undefined && base.before.length > 0 ? `\n## 这一章之前\n${base.before}\n` : ''}
## 参考文献（作者对每一本怎么参考的说法在里面）
${base.references}
${base.direction !== undefined ? `\n## 作者这次的要求\n${base.direction}\n` : ''}
摘记写什么：
1. 只写这一章用得上的，照作者的总要求和对每一本“怎么参考”的说法取舍——让学文风的就看它怎么写，让对设定的就核对设定，没让用的部分不碰。
2. 分三样写，没有的那一样不写：要守的——这一章会碰到的事实、设定、称谓、规矩，参考里是怎么说的；可以借的——写法上的东西：句式、节奏、称呼、起承转合的办法，可以引一两段短的原文作样子，每段注明出自哪一本的哪里；要避开的——照参考来看这一章容易写错、写串的地方。
3. 写得具体，写手照着就能用；每条注明出自哪一本。篇幅 200-800 字。
4. 查过之后这一章确实用不上参考：notes 交空字符串，在 why 里说一句为什么。

只输出 JSON：
{"notes": "给写手的摘记", "used": ["《书名》：读了它的什么"], "why": "一句话：查了什么、怎么取舍的"}`, `"${bare(base.title)}" has references. The chapter below is about to be written: look in the references for what it can use, and leave notes for the writer. The writer has no tools; all it sees of the references is the notes you hand in.

## The chapter to be written
${base.chapter}
${base.before !== undefined && base.before.length > 0 ? `\n## Before this chapter\n${base.before}\n` : ''}
## The references (with what the author says of how each is to be used)
${base.references}
${base.direction !== undefined ? `\n## What the author asks this time\n${base.direction}\n` : ''}
What the notes hold:
1. Only what this chapter can use, chosen by what the author asks of the references at large and says of how each is to be used — one given for its style is read for how it writes, one given for its settings is checked for them, and what was not asked for is left alone.
2. Three kinds of thing, each left out where there is none: to keep to — the facts, settings, forms of address and rules this chapter will touch, as the references have them; to borrow — ways of writing: sentence shapes, rhythm, how people are addressed, how a scene turns, with a short passage or two quoted as a sample, each marked with the book and the place it is from; to steer clear of — where this chapter could easily go wrong against the references.
3. Concrete enough to write from; each note says which book it is from. 150-500 words.
4. Where, having looked, nothing of the references is of use to this chapter: hand in notes as an empty string, and say why in a sentence.

Output JSON only:
{"notes": "the notes for the writer", "used": ["<title>: what of it you read"], "why": "one sentence: what you looked at and how you chose"}`)
}

/**
 * The material for one piece of writing, prepared by the planner before the writer is asked: the writer writes in one
 * request, with no tools, and of the book it sees what it is handed. The planner is told the work, shown what the
 * book has — by name and size, to read in with its tools as far as the piece needs — and hands in what goes along:
 * its own words for what is asked, where the story stands, what must hold, the form and the voice; and, by name,
 * whose cards, which of the world, which threads, which chapters whole or in outline, which stretches of text.
 * @param base.work - what the writer is to do, in a sentence.
 * @param base.given - what the Studio hands the writer whatever is chosen (so that it is not chosen again).
 * @param base.budget - about how many tokens what is chosen may come to.
 */
export function materialTask(base: Base & { work: string; instruction?: string; plan: string; intent?: string; passage?: string; text?: string; notes?: string; chapters: string; people: string; world: string; threads: string; given: string; budget: number; /** The line lies before the planner whole: the chapters' text and the author's jottings, beside the cards, the entries and the threads given in full under `people`, `world`, `threads`. */ whole?: { texts: string; jottings?: string } }): string {
  const section = (title: string, body: string | undefined): string => (body !== undefined && body.trim().length > 0 ? `\n## ${title}\n${body.trim()}\n` : '')
  return L(base.lang, `《${bare(base.title)}》的写手就要动笔了。写手一次写完、没有工具：这本书它看到的只有交给它的材料。这份材料由你来备——只备这一次用得上的。

## 这一次写什么
${base.work}
${section('作者的要求（原话）', base.instruction)}
## 这一章的章纲
${base.plan}
${section('这几章当初定下的思路', base.intent)}${section('要改的这一段，和它前后的原文', base.passage)}${section('这一章现在的正文', base.text)}${section('为这一章查好的参考摘记（会原样交给写手）', base.notes)}
## 书里有什么（${base.whole !== undefined ? '这条线不大：正文、人物卡、设定、线索全在下面，没有别的可查' : '名字和大小；内容用 book_read / book_search 去看'}）
### 这条线上的章节
${base.chapters}
${base.whole !== undefined ? `### 各章的正文（全文）\n${base.whole.texts}\n` : ''}### 人物${base.whole !== undefined ? '（每张卡的全文）' : ''}
${base.people}
### 设定${base.whole !== undefined ? '（每条的全文）' : ''}
${base.world}
### 线索
${base.threads}
${base.whole?.jottings !== undefined ? `### 作者的随笔（没想好的想法，不是设定：这一次用得上的，写进 situation 并说明是作者的想法）\n${base.whole.jottings}\n` : ''}
## 不用你备的（工坊原样附给写手）
${base.given}

## 交回什么
只输出 JSON：
{
  "task": "给写手的任务要求：这一次要写出什么、要做到什么——把作者的要求落到这件活上（几句话）",
  "situation": "写手落笔前要知道的：故事此刻到了哪，谁在场，各人知道什么、不知道什么，手上有什么，刚发生了什么。只写这一次用得上的，一段话",
  "keep": ["不能写错的事实、称谓、细节，一条一句，注明出处（第几章 / 谁的卡 / 哪条设定）；只列这一次真会碰到的"],
  "form": "书写格式：人称与视角、时态、从哪里接起、写到哪里停、段落和对白怎么排",
  "voice": "文风上这一次要把握的：语气、节奏、谁怎么说话（全书文风另附，不用抄）",
  "people": ["要把人物卡整张带上的人：名字"],
  "world": ["要带上的设定条目：名字"],
  "threads": ["这一次要推进或要顾及的线索：标题"],
  "chapters": [3],
  "summaries": [1, 2],
  "excerpts": [{"chapter": 5, "from": "这一段开头的十来个字", "to": "这一段结尾的十来个字", "why": "带它来对什么"}],
  "note": "一两句话，给作者看：带了什么、没带什么、为什么"
}

规矩：
1. people / world / threads 里的名字照上面列的写；没有卡片的人、没有条目的东西，写手要知道的话写进 situation。人物卡、设定条目、线索是整条原样带给写手的：带上它不用先把它读一遍。
2. chapters 是整章原文带上的章号，summaries 是只带梗概的章号（都是这条线上的章号）；excerpts 是某一章里的一段原文：from、to 从正文里逐字照抄（各十来个字，能在那一章里对上）。
3. 原文只带写手要对着看的——要接的那一场、要呼应的那几句、要学的那种口吻；别的事用你自己的话写进 situation 和 keep。人物卡、设定、线索也一样：只带这一次出场的人、用到的东西、要动的线索；只是沾得上边的不带。
4. 你挑的原文、卡片和设定加起来不超过约 ${base.budget} 个 token（一个汉字约一个 token；上面每章的字数供你估）。超了会被退回。
5. 用不上的那一项给空数组或空字符串。交上来的会当场核对：名字、章号、照抄的字句对不上的，会告诉你是哪一条。`, `The writer of "${bare(base.title)}" is about to write. It writes in one request and has no tools: of this book it sees what it is handed. You prepare that — what this one piece of writing can use, and no more.

## What is written this time
${base.work}
${section('What the author asks (their words)', base.instruction)}
## This chapter's outline
${base.plan}
${section('The thinking these chapters were planned with', base.intent)}${section('The passage to rewrite, and the text around it', base.passage)}${section('The chapter as it stands', base.text)}${section('Notes from the references, taken for this chapter (they go to the writer as they are)', base.notes)}
## What the book has (${base.whole !== undefined ? 'this line is small: its text, its cards, its world and its threads are all below — there is nothing else to look up' : 'names and sizes; read with book_read / book_search'})
### The chapters of this line
${base.chapters}
${base.whole !== undefined ? `### The chapters' text (whole)\n${base.whole.texts}\n` : ''}### People${base.whole !== undefined ? ' (every card, whole)' : ''}
${base.people}
### The world${base.whole !== undefined ? ' (every entry, whole)' : ''}
${base.world}
### Threads
${base.threads}
${base.whole?.jottings !== undefined ? `### The author's jottings (ideas not settled, not canon: what this piece can use goes into "situation", named as the author's idea)\n${base.whole.jottings}\n` : ''}
## Not yours to prepare (the Studio hands the writer these as they are)
${base.given}

## What to hand in
Output JSON only:
{
  "task": "what is asked of the writer: what this piece has to be and do — the author's word brought to bear on this piece of work (a few sentences)",
  "situation": "what the writer has to know before the first word: where the story stands, who is there, what each knows and does not know, what each has in hand, what has just happened. Only what this piece can use, in a paragraph",
  "keep": ["a fact, a form of address, a detail that must not come out wrong — one a line, with where it is from (which chapter, whose card, which entry); only what this piece will really touch"],
  "form": "the form: person and point of view, tense, where it picks up, where it stops, how paragraphs and speech are set",
  "voice": "what of the voice matters this time: tone, pace, how somebody speaks (the book's style goes along by itself — do not copy it)",
  "people": ["whose card goes along whole: the name"],
  "world": ["an entry of the world that goes along: its name"],
  "threads": ["a thread this piece moves or has to mind: its title"],
  "chapters": [3],
  "summaries": [1, 2],
  "excerpts": [{"chapter": 5, "from": "the first few words of the stretch", "to": "its last few words", "why": "what it is along for"}],
  "note": "a sentence or two for the author: what went along, what did not, and why"
}

Rules:
1. Names under people / world / threads are written as listed above; somebody without a card, something without an entry, goes into \`situation\` where the writer has to know of it. A card, an entry, a thread goes to the writer whole and as it is: taking one along does not take reading it first.
2. \`chapters\` are chapters that go word for word, \`summaries\` chapters told in outline — both by their number on this line; an entry of \`excerpts\` is one stretch of a chapter's text: \`from\` and \`to\` are copied word for word from the text (a few words each, to be found in that chapter).
3. Text goes word for word only where the writer has to have it before its eyes — the scene to pick up from, the lines to answer, a way of speaking to catch; everything else you say in your own words, in \`situation\` and \`keep\`. Cards, entries and threads likewise: whoever appears this time, what is used, the threads that move — not what merely touches on it.
4. The text, cards and entries you choose come to no more than about ${base.budget} tokens together (the chapters' lengths above are there to reckon by). More is sent back.
5. An item that has nothing is an empty list or an empty string. What you hand in is checked on the spot: a name, a chapter number or copied words that do not match are named to you.`)
}

/** What the pictures in a text are to whoever writes the text anew: lines that are handed back as they stand. */
function picturesStay(lang: PromptLanguage, what: [zh: string, en: string]): string {
  return L(lang,
    `${what[0]}里单独成行的 ![说明](路径) 是插在那里的一张图，不是正文：原样交回——每一行都留着，一个字不改，仍是单独一行，仍在原来那一处（它前后的文字改写了，它就跟在改写后的那几句后面）。${what[0]}没有的图不要添。`,
    `A line of ${what[1]} that reads ![caption](path) is a picture placed there, not prose: hand it back as it is — every such line kept, not a character of it changed, still a line of its own, still at the place it stood (where the words around it are rewritten, it follows the rewritten ones). Add no picture ${what[1]} does not have.`)
}

export function reviseSpanSystem(base: Base & { style: string }): string {
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的作者，正在按编辑的意见改稿。你会看到设定、上下文、一段需要修改的原文和修改要求。

规则：
1. 只输出修改后的那段文字，用来原样替换原文。不要解释，不要引号包裹，不要输出原文以外的上下文。
2. 修改要求是这一次改稿要做到的事：照它改到位。它要变的——发生的事、人物的态度、语气、详略、写法——就真的变，该重写的句子重写，不是在原句上添几个词。它没有说到的信息留着；改完与这一段前后没动的文字接得上（人称、时态、语气、衔接）。
3. 修改要求和设定、章纲、前后文不一致的地方，以修改要求为准——那是作者要改的。修改要求没有说到的地方，不违背设定与前文事实。
4. ${picturesStay(base.lang, ['要改的这一段', 'the passage'])}
5. ${outputRule(base)}

【文风】
${base.style}`, `You are the author of the novel "${bare(base.title)}", revising to your editor's note. You get the bible, the surrounding text, the passage to change and the instruction.

Rules:
1. Output only the rewritten passage, ready to replace the original as is. No explanation, no surrounding quotes, nothing outside the passage.
2. The instruction is what this revision is for: carry it through. What it wants different — what happens, how somebody bears themself, the tone, how much is told, the way it is written — is made different, sentences rewritten where they have to be, not a few words added to the ones there. What it does not speak of is kept; and the result joins the untouched text on both sides seamlessly (person, tense, voice).
3. Where the instruction differs from the bible, the outline or the text around the passage, the instruction holds — that is what the author wants changed. Where it says nothing, do not contradict the bible or earlier chapters.
4. ${picturesStay(base.lang, ['要改的这一段', 'the passage'])}
5. ${outputRule(base)}

STYLE
${base.style}`)
}

export function reviseSpanTask(base: Base & { context: string; before: string; passage: string; after: string; instruction: string }): string {
  // What is asked comes before the passage and once more after it: among everything the model has read by then, it is
  // what the reply is for — said once at the far end of a long prompt, it was the part that got lost.
  const ask = base.instruction.trim()
  return `${base.context}\n\n---\n${L(base.lang, '## 修改要求（这次改稿要做到的）', '## The instruction (what this revision is for)')}\n\n${ask}\n\n${L(base.lang, '## 待修改段落之前的原文', '## Text before the passage')}\n\n${base.before || L(base.lang, '（本章开头）', '(start of chapter)')}\n\n${L(base.lang, '## 需要修改的段落', '## The passage to rewrite')}\n\n<<<\n${base.passage}\n>>>\n\n${L(base.lang, '## 待修改段落之后的原文', '## Text after the passage')}\n\n${base.after || L(base.lang, '（本章结尾）', '(end of chapter)')}\n\n---\n${L(base.lang, `照修改要求把 <<< >>> 里的那一段改好，只输出改好的这一段。\n修改要求：${ask}`, `Rewrite the passage between <<< and >>> to the instruction, and output the rewritten passage only.\nThe instruction: ${ask}`)}`
}

export function reviseChapterSystem(base: Base & { style: string }): string {
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的作者，正在按编辑的意见重写一整章。你会看到设定、前情、本章现有正文与修改要求。

规则：
1. 输出修改后的完整一章正文，只输出正文，不要标题和任何说明。
2. 按修改要求改；要求没有涉及的情节、信息和好句子尽量保留，不要无故删减篇幅或改写无关段落。
3. 不得违背设定与前文事实，不得改变本章在全书中的剧情功能（除非修改要求明确如此）。
4. ${picturesStay(base.lang, ['本章现有正文', 'the chapter as it stands'])}
5. ${outputRule(base)}

【文风】
${base.style}`, `You are the author of the novel "${bare(base.title)}", rewriting a whole chapter to your editor's note. You get the bible, the story so far, the chapter as it stands and the instruction.

Rules:
1. Output the complete revised chapter — prose only, no title, no commentary.
2. Follow the instruction; keep plot points, information and good lines it does not touch. Do not shorten the chapter or rewrite unrelated passages without cause.
3. Never contradict the bible or earlier chapters, and keep the chapter's job in the book unless the instruction says otherwise.
4. ${picturesStay(base.lang, ['本章现有正文', 'the chapter as it stands'])}
5. ${outputRule(base)}

STYLE
${base.style}`)
}

export function reviseChapterTask(base: Base & { context: string; instruction: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, '## 修改要求', '## Instruction')}\n\n${base.instruction}\n\n---\n${L(base.lang, '输出修改后的完整一章正文。', 'Output the complete revised chapter.')}`
}

/**
 * A chapter gone through by its writer as an agent: who the agent is. It changes the chapter where it stands — a place
 * at a time, with a tool — and never hands the chapter back.
 */
export function amendPersona(base: Base): string {
  return L(base.lang,
    `你是长篇小说《${bare(base.title)}》的作者，正在按编辑的意见改自己写好的一章——在原稿上改，不是重写。`,
    `You are the author of the novel "${bare(base.title)}", revising a chapter you have written to your editor's note — changing it where it stands, not writing it again.`)
}

/**
 * How the writer goes through a chapter as an agent.
 * @param base.edit - the tool a place is changed with; `base.read` shows the chapter as changed so far; `base.done` hands the work in.
 * @param base.bold - the instruction is carried through wherever the chapter gives it a hold, and a place takes in what
 *   has to move with it; otherwise the least that answers it.
 */
export function amendRules(base: Base & { style: string; edit: string; read: string; done: string; bold?: boolean }): string {
  const bold = base.bold === true
  return L(base.lang, `## 这件活
这是一次委派：作者（或和作者对话的总编）把一章和一条修改要求交给了你，任务就是下面那条消息。这场对话里没有人会回答提问——不要问；${bold ? '拿不准的地方照修改要求的方向做足' : '拿不准的地方按最稳妥的理解做'}，并在交回时写明你是怎么取舍的。

## 怎么改
- 这一章只有一条路可以改：${base.edit}。find 是要改的那几句，从这一章现在的正文里逐字照抄；replace 是它改成的样子。改过的正文留在这一章里——不要把整章写出来交回，也不要用文件工具或命令行去动书里的文件。
- ${bold ? '一处圈够：要一起动才通顺、才站得住的几句，要重写的一整段，整个圈进来——不缩成其中一句；不相干的句子不圈。' : '每一处只圈非改不可的那一两句：圈得越小，作者看到的改动越清楚。'}要动好几处，一处一条——想好了的几处放进 edits 一次交上来，省来回；拿不准的先改一处看看。
- find 在这一章里只能对得上一处；对得上不止一处时，连它前面或后面的半句一起抄。同一个词、同一个称呼要通篇换掉的，用 all=true。
- 要加一句：find 圈它要接在后面（或前面）的那一句，replace 里把那一句原样写上，再接上新写的。要删一句：圈它，replace 留空。
- 改过之后，后面的 find 要照改过的正文抄；${base.read} 随时给你看这一章现在的样子。
- ${bold ? '把修改要求落实到这一章每一处用得上的地方，不只改最显眼的那一两句；一处改了之后因此要跟着变的句子——后面的呼应、别人的反应、衔接——一并改；要求需要新写一段交代、动作或对白时就写——只用设定和前文已经有的事实，原文交代过的信息不丢。要求管不到的句子不动，情节的走向不借机改。' : '修改要求说到哪里改到哪里：没说到的句子不动，不顺手润色，不借机添情节、伏笔或交代。'}改过的地方要和它前后没动的文字接得上——人称、时态、语气、衔接。
- 设定集与前文已发生的事实是铁律。任务给的材料不够、要对照书里别处（前后章、人物卡、设定）时再去查：book_read、book_search。
- 正文里单独成行的 ![说明](路径) 是插在那里的一张图，不是正文：不要圈进 find，replace 里也不要添图。
- ${outputRule(base)}
- 改完了，调用 ${base.done}，用一两句话说改了哪几处、怎么取舍的。看过之后这一章不需要改，也调用它并说明为什么。修改要求是通篇的（整章换一种文风、换视角、重排结构），一处处改办不到时，不要硬改：调用 ${base.done} 说明这一章得整章重写。交回之后就结束。

【文风】
${base.style}`, `## The work
This is a delegation: the author (or the showrunner, who talks with the author) gave you a chapter and one instruction — the message below is the task. Nobody in this conversation answers questions — do not ask; where you are unsure, ${bold ? 'go the whole way in the direction the instruction points' : 'take the safest reading'} and say, when you hand in, how you decided.

## How to revise
- There is one way to change this chapter: ${base.edit}. \`find\` is the sentences to change, copied word for word from the chapter as it reads now; \`replace\` is what they become. What you change stays in the chapter — do not write the chapter out to hand it back, and do not touch the book's files with file tools or the shell.
- ${bold ? 'A place takes in enough: the sentences that have to move together for the change to read well and hold, a paragraph that has to be written again whole — not narrowed to one of its sentences; sentences that have no part in it stay out.' : 'Each place takes in only the sentence or two that have to change: the smaller the place, the clearer the change the author is shown.'} Several places are an entry each — the ones you have settled go in \`edits\` together, to save round trips; where you are unsure, change one and look.
- \`find\` has to stand in one place of the chapter only; where it stands in more, copy the half sentence before or after it too. A word or a name to be changed throughout: all=true.
- To add a sentence: \`find\` the sentence it goes after (or before), and write that sentence back in \`replace\`, with the new one beside it. To take a sentence out: \`find\` it, and leave \`replace\` empty.
- Once something is changed, a later \`find\` is copied from the text as changed; ${base.read} shows the chapter as it reads now.
- ${bold ? 'Carry the instruction through every place of the chapter it has a hold on, not only the plainest sentence or two; where one change leaves others not agreeing with it — an echo later on, how somebody answers, a join — those change too; and where it takes a passage written new — a word of explanation, a gesture, lines of talk — it is written, out of what the bible and the text so far already hold and with nothing the text told lost. Sentences the instruction has nothing to say of stay, and the course of the plot is not changed under cover of it.' : 'Change what the instruction speaks of and nothing else: sentences it does not touch stay, nothing is polished in passing, no event, hint or explanation is added on the side.'} What you change has to join the untouched text on both sides — person, tense, voice.
- The story bible and everything already written are law. Where the task's material is not enough and the work has to be held against another part of the book (earlier and later chapters, a character's card, a rule of the world), look: book_read, book_search.
- A line of the chapter that reads ![caption](path) is a picture placed there, not prose: do not take it into \`find\`, and add no picture in \`replace\`.
- ${outputRule(base)}
- When you are done, call ${base.done} and say in a sentence or two which places you changed and how you decided. Where, having read it, the chapter needs no change, call it all the same and say why. Where the instruction is of the whole chapter (another style throughout, another point of view, another order of scenes) and cannot be met place by place, do not force it: call ${base.done} and say the chapter has to be written over whole. Handing in ends the work.

STYLE
${base.style}`)
}

/** The task of going through one chapter: what it is read against, what is asked, which chapter it is. */
export function amendTask(base: Base & { context: string; instruction: string; index: number; chapter: string; words: number; edit: string; done: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, '## 修改要求', '## Instruction')}\n\n${base.instruction}\n\n---\n${L(base.lang,
    `要改的是第 ${base.index} 章《${bare(base.chapter)}》：上面“本章已有正文”就是它现在的全文（约 ${base.words} 字），不用再读一遍。照修改要求，用 ${base.edit} 改要改的那几处；改完调用 ${base.done}。`,
    `The chapter to revise is chapter ${base.index}, "${bare(base.chapter)}": "This chapter so far" above is its whole text as it stands (about ${base.words} words) — there is no need to read it again. Change the places the instruction reaches with ${base.edit}; when done, call ${base.done}.`)}`
}

/**
 * The same work asked in one request, of a writer whose model cannot run as an agent: the changes come back as a
 * list of places, and are made here.
 */
export function amendCallSystem(base: Base & { style: string; bold?: boolean }): string {
  const bold = base.bold === true
  return L(base.lang, `你是长篇小说《${bare(base.title)}》的作者，正在按编辑的意见改自己写好的一章——在原稿上改，不是重写。你会看到设定、前情、本章现有正文与修改要求；你交回的是一份改动清单，不是改好的整章。

规则：
1. 只输出 JSON：{"edits": [{"find": "要改的那几句，从本章现有正文里逐字照抄", "replace": "它改成的样子", "why": "一句话：为什么改"}], "note": "一两句话：改了哪几处、怎么取舍的"}
2. 一处一条，从前到后排；${bold ? '每条圈够——要一起动才通顺、才站得住的几句，要重写的一整段，整个圈进来；不相干的句子不圈，' : '每条只圈非改不可的那一两句，不整段整段地圈，'}更不要把整章放进一条里。
3. find 在本章里只能对得上一处：对得上不止一处时，连它前面或后面的半句一起抄。清单是照着现有正文一条条依次改的：后一条的 find 不要落在前一条改过的句子里。同一个词、同一个称呼要通篇换掉的，那一条加 "all": true。
4. 要加一句：find 圈它要接在后面的那一句，replace 里把那一句原样写上，再接上新写的。要删一句：圈它，replace 给空字符串。
5. ${bold ? '把修改要求落实到这一章每一处用得上的地方，不只改最显眼的那一两句；一处改了之后因此要跟着变的句子（呼应、反应、衔接）一并改；要求需要新写一段交代、动作或对白时就写——只用设定和前文已经有的事实，原文交代过的信息不丢。要求管不到的句子不动，情节的走向不借机改。' : '修改要求说到哪里改到哪里：没说到的句子不动，不顺手润色，不添要求之外的内容。'}改过的地方要和前后没动的文字接得上。
6. 不得违背设定与前文事实。
7. 正文里单独成行的 ![说明](路径) 是一张图，不是正文：不要圈进 find，replace 里也不要添图。
8. 这一章不需要改：edits 给空数组，在 note 里说明。修改要求是通篇的（整章换文风、换视角、重排结构）、一处处改办不到：edits 给空数组，在 note 里说这一章得整章重写。
9. ${outputRule(base)}

【文风】
${base.style}`, `You are the author of the novel "${bare(base.title)}", revising a chapter you have written to your editor's note — changing it where it stands, not writing it again. You get the bible, the story so far, the chapter as it stands and the instruction; what you hand in is a list of changes, not the chapter revised.

Rules:
1. Output JSON only: {"edits": [{"find": "the sentences to change, copied word for word from the chapter as it stands", "replace": "what they become", "why": "one sentence: why"}], "note": "a sentence or two: which places you changed and how you decided"}
2. One entry a place, in the order they stand; ${bold ? 'each takes in enough — the sentences that have to move together for the change to read well and hold, a paragraph that has to be written again whole; sentences that have no part in it stay out' : 'each takes in only the sentence or two that have to change — not whole paragraphs'}, and never the chapter in one entry.
3. \`find\` has to stand in one place of the chapter only: where it stands in more, copy the half sentence before or after it too. The list is made one entry after another on the text as it stands: no \`find\` falls inside a sentence an earlier entry changed. A word or a name to be changed throughout: add "all": true to that entry.
4. To add a sentence: \`find\` the sentence it goes after, and write that sentence back in \`replace\`, with the new one after it. To take a sentence out: \`find\` it, with \`replace\` an empty string.
5. ${bold ? 'Carry the instruction through every place of the chapter it has a hold on, not only the plainest sentence or two; where one change leaves others not agreeing with it (an echo, an answer, a join), those change too; where it takes a passage written new, it is written — out of what the bible and the text so far already hold, with nothing the text told lost. Sentences the instruction has nothing to say of stay, and the course of the plot is not changed under cover of it.' : 'Change what the instruction speaks of and nothing else: sentences it does not touch stay, nothing is polished in passing, nothing is added beside what was asked.'} What you change has to join the untouched text on both sides.
6. Never contradict the bible or earlier chapters.
7. A line of the chapter that reads ![caption](path) is a picture, not prose: do not take it into \`find\`, and add no picture in \`replace\`.
8. Where the chapter needs no change: \`edits\` is an empty list, and \`note\` says why. Where the instruction is of the whole chapter (another style throughout, another point of view, another order of scenes) and cannot be met place by place: \`edits\` is an empty list, and \`note\` says the chapter has to be written over whole.
9. ${outputRule(base)}

STYLE
${base.style}`)
}

export function amendCallTask(base: Base & { context: string; instruction: string }): string {
  return `${base.context}\n\n---\n${L(base.lang, '## 修改要求', '## Instruction')}\n\n${base.instruction}\n\n---\n${L(base.lang, '输出改动清单（JSON）。', 'Output the list of changes (JSON).')}`
}

/**
 * Where a change is made through the book — a problem mended, something the author asks for, or something the author
 * noticed and wants found: the places, each quoted from the text with what is to change there, and, only where places
 * will not do, the chapters to write over whole. What is handed in is small: the places named change and nothing else,
 * so the change comes back as changes to look at one by one, not as chapters written again.
 * @param base.texts - chapters whole: what `find` is copied from. `base.allGiven`: every chapter concerned is among them — nothing is left to read.
 * @param base.wide - trace what depends on the problem through the book; otherwise the problem itself and no more.
 * @param base.reads - whoever answers can read the book's other chapters with tools.
 * @param base.asked - what is asked is a change the author wants, in their words, not a problem a review found.
 * @param base.only - the chapters listed are the only ones that may change.
 * @param base.lead - what is given is what the author said of the book, in a sentence — and whoever answers tells which
 *   of two things it is. Something they noticed that is wrong: where it shows is said first, each place quoted
 *   (`findings`), and with `fix` the places that mend it are named after. A change they want made: nothing is filed
 *   (`findings` empty) and the places it reaches are named. With `find` nothing changes either way: what is wrong, or
 *   what the change would reach, is listed.
 * @param base.bold - the problem is mended through: every place it shows, what has to change with each, a place taking
 *   in as much as has to move — a paragraph where a sentence will not do. Otherwise the least change that mends it.
 * @param base.direct - whoever answers writes what each place is to read (`replace`), and that is what is proposed:
 *   nobody rewrites after it. `base.style`: how the book is written, for those words.
 */
export function mendTask(base: Base & { instruction: string; chapters: string; texts?: string; allGiven?: boolean; wide: boolean; bible?: boolean; reads: boolean; asked?: boolean; only?: boolean; lead?: 'fix' | 'find'; direct?: boolean; /** Each place is the planner's to write where little changes, the writer's where a passage is to be written. */ mixed?: boolean; style?: string; bold?: boolean }): string {
  const asked = base.asked === true
  const bold = base.bold === true
  const lead = base.lead
  const mends = lead !== 'find'
  const direct = base.direct === true && mends
  const mixed = base.mixed === true && mends && !direct
  const texts = base.texts !== undefined && base.texts.trim().length > 0
  const style = (direct || mixed) && base.style !== undefined && base.style.trim().length > 0 ? base.style.trim() : undefined

  // ── Chinese ──
  const given = base.allGiven === true && base.texts !== undefined && base.texts.trim().length > 0
  const zhElsewhere = given
    ? '这几章的正文都在上面，find 从那里抄。'
    : base.reads ? '别的章节的正文用你的工具读，find 以读到的为准。' : '没有给出正文的章节引不了原文：那里要改，就列进 chapters，在 reason 里说清改什么。'
  // (What is given whole is not read again with a tool: every such call sends the whole of the task once more.)
  const zhLook = given
    ? '这几章的正文都在上面：照它找，不用再用工具把它们读一遍；要对照人物卡、设定条目里的说法时，只查那一条。'
    : base.reads ? '正文已经在上面的章节不用再读；只有摘要的章节，用你的工具去读、去搜，不凭摘要下结论。' : ''
  const zhFind = `先判断作者说的是哪一种。它是他读书时发现的一个毛病（前后对不上、人物走样、时间算不拢、一类写法上的毛病……）：先把它找出来——这个问题在书里的哪几处露出来，每一处记进 findings——chapter：第几章；quote：露出问题的那一两句原文，逐字照抄（作者靠它一眼看到问题在哪）；explanation：这一处是什么问题、和哪里对不上，一两句话；suggestion：可以怎么改，一句话；severity：high（读者会出戏、情节站不住）、medium 或 low；type：continuity、character、world、timeline、style、pacing、logic、language 之一。同一个问题在几处露出来，每一处各记一条；${bold ? '作者说的是一类毛病时，它露出来的地方都记——挨在一起的几句记成一条，不逐句罗列。' : '作者说的是一类毛病时，记最明显的那几处，不逐句罗列。'}只记有毛病的地方：两处对不上时，拿来对照、本身没有写错的那一头不记（在 explanation 里提到它就行）。作者没说到的别的毛病不记。${zhLook}书里其实没有这个问题：findings 给空数组，在 note 里说你查了哪里、为什么认为没有。它是一条要照着改的要求（把甲改成乙、统一一个叫法、让某人的言行照新的设定来、把某一段写得更怎样……）：${mends ? '不把要改的每一处当成问题记——findings 给空数组，直接照下面几条定改哪几处' : '把这条要求要碰到的地方一处处找出来记进 findings：quote 是那一处的原文，explanation 写这一处要怎么变，type 和 severity 照它最接近的填'}。两样都沾（说的是毛病，也说了要怎么改）：当毛病办，照作者说的改法改。`
  const zhAsked = bold
    ? '把这条要求落实到位：它碰到的每一处都改，不只改最显眼的那几句；一处改了之后因此要跟着变的句子——后面的呼应、别人的反应、同一件事的再次提起——也各列一处。同一件事在几处都写到，每一处各列一条；碰不到的章节不列。'
    : '改动越少越好：这条要求碰到哪几句就改哪几句，碰不到的章节不列。同一件事在几处都写到，每一处各列一条。'
  const zhProblem = bold
    ? '把问题改到位，不只在一处打个补丁。它露出来的每一处都改；矛盾的两头，站不住的那一头改，两头都别扭就两头都改；缺的交代补在读者需要它的地方，一句不够就写够。一处改了之后因此接不上、说法要跟着变的句子——后面的呼应、别人的反应、同一件事的再次提起——也各列一处。改在哪里由问题的根子定，可以不在发现它的那一章。'
    : '改动越少越好。一个问题往往不止一处可以下手——矛盾的两头改哪一头都行，缺的一句交代补在哪一段都行：挑改得最少、最不牵动别处的那一处，它可以不在发现问题的那一章。一处能解决的，不改两处。'
  // (Said of a sentence of the author's, both hold: which applies is whichever the sentence turned out to be.)
  const zhLess = lead !== undefined ? `是毛病：${zhProblem}是修改要求：${zhAsked}` : asked ? zhAsked : zhProblem
  // How much a place takes in, and how far what is written there may go from what stood.
  const zhTake = bold
    ? '圈够——为了改得通顺、站得住而要一起动的句子都圈进来，几句、一整段都可以；一段话要重写就圈一整段，不缩成其中一句'
    : '只圈非改不可的那一两句，不整段整段地圈'
  // What the planner writes itself is said the same way whether it writes every place or only the small ones.
  const zhOwn = `replace——这一处改好之后的全文，写成成稿：它原样替换 find，就是给作者看的提案，没有人再替你改写。${style !== undefined ? '照这本书的文风写（见上），' : ''}和前后文接得上；${bold ? '圈进来的句子该重写的重写、该补的补够，不必拘在原句的字面上，用不着动的照原样写回去；和这次要改的事无关的不借机改' : 'find 里用不着动的字句原样写回去，不顺手润色，不添这次要改的之外的内容'}；整句删掉就给空字符串；why——这一处为什么这样改，一句话`
  const zhHow = bold ? '这一处改成什么样，具体到写手照着就能写：补哪些交代、哪几句怎么变、这一段落在哪里，要新写一小段时说清写什么' : '这一处改成什么样，一两句话，具体到写手照着就能改（补哪句交代、数字改成几、哪半句去掉）'
  const zhPlace = mixed
    ? `每一处写明：chapter——第几章；find——这一处能动的全部范围，逐字照抄：${zhTake}；它在这一章里要只对得上一处（重复出现的短句，连它前后的半句一起抄）；要补一句话，就圈它要接在后面的那一句。然后看这一处要落多少笔，两种里给一种：小改动——换一个词、改一个名字或数字、删半句、调一下语序、补一两句交代——你直接写：${zhOwn}。要成段新写或重写的——一段叙述、一场对白、一个场面——交给写手的模型，你不写 replace：how——${zhHow}，理由不写在这里；写手只能改 find 里面的字，出不了这个圈。分界在要新落多少笔：改完之后新写的不过一两句、几十个字，你直接写；要新写一整段、一场对白，上百字的，交给写手。写手的模型是写成段文字用的，每叫它一次都要把这一处的前后文再发一遍：改几个字就能了结的不交给它。一处只给 replace 和 how 当中的一个。同一章的两处不重叠。正文里单独成行的 ![说明](路径) 是一张图，不圈进 find，replace 里也不添图。${zhElsewhere}`
    : direct
    ? `每一处写明：chapter——第几章；find——这一处要被换掉的原文，逐字照抄：${zhTake}；它在这一章里要只对得上一处（重复出现的短句，连它前后的半句一起抄）；要补一句话，就圈它要接在后面的那一句；replace——这一处改好之后的全文，写成成稿：它原样替换 find，就是给作者看的提案，没有人再替你改写。${style !== undefined ? '照这本书的文风写（见上），' : ''}和前后文接得上；${bold ? '圈进来的句子该重写的重写、该补的补够，不必拘在原句的字面上，用不着动的照原样写回去；和这次要改的事无关的不借机改' : 'find 里用不着动的字句原样写回去，不顺手润色，不添这次要改的之外的内容'}；整句删掉就给空字符串；why——这一处为什么这样改，一句话。同一章的两处不重叠。正文里单独成行的 ![说明](路径) 是一张图，不圈进 find，replace 里也不添图。${zhElsewhere}`
    : `每一处写明：chapter——第几章；find——这一处能动的全部范围，写手只能改它里面的字，出不了这个圈：${bold ? `所以${zhTake}` : zhTake}，逐字照抄；它在这一章里要只对得上一处（重复出现的短句，连它前后的半句一起抄）；要补一句话，就圈它要接在后面的那一句；how——${bold ? '这一处改成什么样，具体到写手照着就能写：补哪些交代、哪几句怎么变、这一段落在哪里，要新写一小段时说清写什么' : '这一处改成什么样，一两句话，具体到写手照着就能改（补哪句交代、数字改成几、哪半句去掉）'}，理由不写在这里。同一章的两处不重叠。正文里单独成行的 ![说明](路径) 是一张图，不圈进 find。${zhElsewhere}`
  const zhReach = base.wide
    ? `把牵连查清：别的章节里写到同一件事、要跟着变才能前后一致的地方，各列一处${bold ? '——宁可多查一章，不漏一处' : ''}；无关的不动。`
    : bold
      ? '顺着这个问题改到底：同一章里别处同样站不住的说法、同一个漏掉的交代，一并改；修它要新写一小段交代、一个动作、两三句对白时就写。和它无关的毛病不动，情节的走向不借机改。'
      : '只修这个问题本身：不顺手改别的，不借机添新的情节、伏笔或交代。'
  // (Mended through, a place is rewritten more freely: what may not go with that is said by itself.)
  const zhKeep = '改得再多，两样不变。圈进来的原文交代过的事——谁、做了什么、结果怎样、哪条规矩、哪个数——改完一条都还在：可以换个说法、挪个位置、拆进对话里，不能没了；交回之前拿原文逐条对一遍。新写的句子不另起人物卡、设定和前文里没有的名字、年份、来历、死因——要用到这类事实，就用已经写下的。'
  const zhWhole = asked || lead !== undefined
    ? '只有零碎改做不到——要求本身就是通篇的（文风、语气、视角、节奏），或者一章里要动的句子多到连成片——才把这一章列进 chapters，由写手整章重写；几处改能做到的不列。没有就给空数组。'
    : '只有零碎改解决不了——这一章的节奏、视角、语气要通篇变——才把它列进 chapters，由写手整章重写；几处改能解决的不列。没有就给空数组。'
  const zhBible = '问题的根子在设定集——人物卡或设定条目写的和正文对不上，或者设定本身要调整——把要改的地方列在 bible 里：人物的 field 用 tagline、appearance、personality、background、motivation、flaw、arc、voice、age、gender 之一，设定条目用 summary 或 body。正文没问题、只是设定写错了的，只改设定，不动正文。'
  const zhRules = [
    ...(lead !== undefined ? [zhFind] : []),
    ...(mends ? [zhLess, zhPlace, zhReach, ...(bold ? [zhKeep] : []), zhWhole, ...(base.bible === true ? [zhBible] : [])] : ['这一次只找不改：edits 和 chapters 都给空数组。']),
  ].map((rule, at) => `${at + 1}. ${rule}`).join('\n')
  const zhNote = lead !== undefined
    ? `你把它当作毛病还是修改要求；找到了几处、问题的根子在哪${mends ? '、为什么改这几处' : ''}；没找到就说查了哪里`
    : asked ? '这条要求碰到了哪些地方、为什么是这几处' : '问题出在哪、为什么改这几处'
  const zhEdit = mixed
    ? `{"chapter": 章节序号, "find": "这一处能动的原文，逐字照抄", "replace": "小改动：这一处改好之后的全文", "why": "为什么这样改"}, {"chapter": 章节序号, "find": "这一处能动的原文，逐字照抄", "how": "要成段新写的：这一处改成什么样（具体到位），交给写手"}`
    : direct
    ? `{"chapter": 章节序号, "find": "${bold ? '要换掉的原文' : '要换掉的那一两句原文'}，逐字照抄", "replace": "这一处改好之后的全文", "why": "为什么这样改"}`
    : `{"chapter": 章节序号, "find": "${bold ? '这一处能动的原文' : '这一处能动的那一两句原文'}，逐字照抄", "how": "这一处改成什么样（具体到位）"}`
  const zhShape = `{${lead !== undefined ? '"findings": [{"chapter": 章节序号, "quote": "露出问题的原文，逐字照抄", "type": "continuity|character|world|timeline|style|pacing|logic|language", "severity": "high|medium|low", "explanation": "这一处是什么问题", "suggestion": "可以怎么改"}], ' : ''}"edits": [${mends ? zhEdit : ''}], "chapters": [${mends ? '{"index": 章节序号, "reason": "为什么非整章重写不可、怎么改"}' : ''}], ${base.bible === true && mends ? '"bible": [{"kind": "character|world", "name": "人物卡或设定条目的名字", "field": "要改的字段", "value": "改成什么", "reason": "为什么"}], ' : ''}"note": "给作者，两三句话：${zhNote}"}`
  const zhIntro = lead === 'find'
    ? '作者对这本书说了一句话（见“作者说的”）。它可能是他读书时发现的一个毛病，也可能是一条要照着改的要求——是哪一种由你判断。这一次只找，不改：是毛病，说清它在哪几处露出来；是修改要求，说清它要碰到哪几处。'
    : lead === 'fix'
      ? `作者对这本书说了一句话（见“作者说的”）。它可能是他读书时发现的一个毛病，也可能是一条要照着改的要求——是哪一种由你判断。是毛病：到书里把它找出来、再修掉——先说清它在哪几处露出来，再定下改哪几处；是修改要求：直接定下它碰到的每一处。${mixed ? '小改动由你直接把改好的文字写出来——你写的就是提案；要成段新写的那几处由你定怎么改，交给写手。不重写整章。' : direct ? '每一处改好的文字由你直接写出来——你写的就是提案，不重写整章。' : '各处怎么改由你定——写手只改你点到的那几处，不重写整章。'}`
      : `${asked ? '作者提出了一条针对全书的修改要求。' : '下面的问题要修。'}${mixed ? '请定下改哪几处：小改动你直接把改好的文字写出来（你写的就是提案），要成段新写的说清怎么改、交给写手；不重写整章。' : direct ? '请定下改哪几处，并把每一处改好的文字直接写出来：你写的就是提案，没有人再替你改写；不重写整章。' : '请定下改哪几处、各怎么改：写手只改你点到的那几处，不重写整章。'}`
  const zhHead = lead !== undefined ? '作者说的' : asked ? '修改要求' : '要修的问题'

  // ── English ──
  const enElsewhere = given
    ? ' The text of these chapters is above: copy find from there.'
    : base.reads ? ' Read the other chapters with your tools; find goes by what you read there.' : ' A chapter whose text is not given here cannot be quoted from: where it has to change, list it under chapters and say in reason what changes.'
  const enLook = given
    ? ' The text of these chapters is above: look there, and do not read them again with a tool; where a card or an entry of the bible has to be held against it, look up that one.'
    : base.reads ? ' A chapter whose text is above is not read again; one of which only a summary is given is read and searched with your tools — nothing is concluded from a summary.' : ''
  const enFind = `Tell first which of the two it is. Something the author noticed that is wrong (things that do not agree, somebody out of character, days that do not add up, a kind of fault in the writing…): find it first — where in the book this shows, each place an entry of findings — chapter: its number; quote: the sentence or two where it shows, copied word for word (the author sees by it where the problem is); explanation: what is wrong at this place and what it does not agree with, in a sentence or two; suggestion: how it could be mended, in a sentence; severity: high (a reader is thrown, the plot does not hold), medium or low; type: one of continuity, character, world, timeline, style, pacing, logic, language. Where the same problem shows in several places, each is an entry; ${bold ? 'where the author names a kind of fault, every place it shows — sentences that stand together as one entry, not one a sentence.' : 'where the author names a kind of fault, the plainest instances and not every sentence.'} Only where something is wrong: of two places that do not agree, the one that is held against the other and is itself right is not recorded (name it in explanation). Other faults the author did not speak of are not recorded.${enLook} Where the book does not have the problem after all: an empty findings, and in note where you looked and why you think so. A change the author wants made (one thing called another, a name made the same throughout, somebody speaking and acting by a card that changed, a passage made more of something…): ${mends ? 'the places it reaches are not filed as problems — an empty findings, and the places that change are settled by the rules below' : 'the places it would reach are found and entered in findings: quote the text of the place, explanation what is to change there, type and severity whatever comes nearest'}. Where it is both (a fault, and how the author wants it mended): it is taken as the fault, mended the way they say.`
  const enAsked = bold
    ? 'Carry the request through: every place it reaches changes, not only the plainest sentences; and where one change leaves others not agreeing with it — an echo later on, how somebody answers, the same thing told again — each of those is a place too. Where several places tell of the same thing, each is a place of its own; a chapter the request does not reach is not listed.'
    : 'As little as will do: the sentences the request reaches change, and a chapter it does not reach is not listed. Where several places tell of the same thing, each is a place of its own.'
  const enProblem = bold
    ? 'Mend it through, not with a patch at one spot. Every place it shows changes; of the two ends of a contradiction the one that does not hold changes, and both where both sit ill; a missing word of explanation goes where the reader needs it, and as much of it as it takes. Where one change leaves other sentences not agreeing with it — an echo later on, how somebody answers, the same thing told again — each of those is a place too. Where it changes is settled by where the root lies, which need not be the chapter it was found in.'
    : 'As little as will do. A problem can usually be taken hold of in more than one place — either end of a contradiction, any paragraph a missing word of explanation could go in: choose the place that changes least and pulls least else with it; it need not be in the chapter the problem was found in. What one place mends is not mended in two.'
  const enLess = lead !== undefined ? `Where it is a fault: ${enProblem} Where it is a request: ${enAsked}` : asked ? enAsked : enProblem
  const enTake = bold
    ? 'take in enough — every sentence that has to move with it for the change to read well and hold, several sentences or a whole paragraph; a paragraph that has to be written again is taken in whole, not narrowed to one of its sentences'
    : 'the sentence or two that have to change and no whole stretches'
  const enOwn = `replace — the whole of this place as it is to read, written as finished prose: it takes the place of find as it stands and is what the author is shown — nobody rewrites after you. ${style !== undefined ? 'In the way this book is written (above), joining ' : 'It joins '}what stands on both sides; ${bold ? 'the sentences taken in are rewritten where they need it and added to as far as it takes, not held to the wording there was, and those that need no change go back as they stand; nothing that has no part in this mending is changed under cover of it' : 'the words of find that need not change go back as they stand — no polishing in passing, nothing added beyond what is being changed'}; an empty string where the sentence goes altogether; why — why this place changes so, in a sentence`
  const enHow = bold ? 'what this place is to say instead, specific enough to write from: which explanation comes in, how which sentences change, what the passage comes to rest on, and what is to be written where something new is needed' : 'what this place is to say instead, in a sentence or two, specific enough to write from (which word of explanation to add, what the number becomes, which half-sentence goes)'
  const enPlace = mixed
    ? `For each place: chapter — its number; find — all that may change at this place, copied word for word: ${enTake}; it has to be found once only in its chapter (for a short sentence that stands more than once, copy the half-sentence beside it too); where a sentence is to be added, take in the one it follows. Then, by how much there is to write at it, one of two. A small change — a word put for another, a name or a number put right, half a sentence gone, an order changed, a sentence or two of explanation added — you write yourself: ${enOwn}. A passage to be written new or over — a stretch of telling, an exchange of talk, a scene — goes to the writer's model, and you write no replace: how — ${enHow}; the reasons do not go here; the writer can change the words inside find and none outside. The line between the two is how much is newly written: a sentence or two, a few dozen words, you write; a whole paragraph or an exchange of talk, a hundred words and more, goes to the writer. The writer's model is there for prose by the passage, and every call of it sends what stands around the place once more: what a few words settle is not handed to it. A place has one of replace and how, never both. Two places of one chapter do not overlap. A line of the text that reads ![caption](path) is a picture: keep it out of find, and add none in replace.${enElsewhere}`
    : direct
    ? `For each place: chapter — its number; find — the text that is replaced here, copied word for word: ${enTake}; it has to be found once only in its chapter (for a short sentence that stands more than once, copy the half-sentence beside it too); where a sentence is to be added, take in the one it follows; replace — the whole of this place as it is to read, written as finished prose: it takes the place of find as it stands and is what the author is shown — nobody rewrites after you. ${style !== undefined ? 'In the way this book is written (above), joining ' : 'It joins '}what stands on both sides; ${bold ? 'the sentences taken in are rewritten where they need it and added to as far as it takes, not held to the wording there was, and those that need no change go back as they stand; nothing that has no part in this mending is changed under cover of it' : 'the words of find that need not change go back as they stand — no polishing in passing, nothing added beyond what is being changed'}; an empty string where the sentence goes altogether; why — why this place changes so, in a sentence. Two places of one chapter do not overlap. A line of the text that reads ![caption](path) is a picture: keep it out of find, and add none in replace.${enElsewhere}`
    : `For each place: chapter — its number; find — all that may change at this place: the writer can change the words inside it and none outside${bold ? `, so ${enTake}` : '. Take in the sentence or two that have to change and no whole stretches'}, copied word for word; it has to be found once only in its chapter (for a short sentence that stands more than once, copy the half-sentence beside it too); where a sentence is to be added, take in the one it follows; how — ${bold ? 'what this place is to say instead, specific enough to write from: which explanation comes in, how which sentences change, what the passage comes to rest on, and what is to be written where something new is needed' : 'what this place is to say instead, in a sentence or two, specific enough to write from (which word of explanation to add, what the number becomes, which half-sentence goes)'}; the reasons do not go here. Two places of one chapter do not overlap. A line of the text that reads ![caption](path) is a picture: keep it out of find.${enElsewhere}`
  const enReach = base.wide
    ? `Trace what hangs on it: where other chapters tell of the same thing and have to change with it for the book to agree with itself, name a place in each${bold ? ' — sooner one chapter too many looked at than one place missed' : ''}; leave what has nothing to do with it.`
    : bold
      ? 'Follow the problem to its end: where the same chapter has the same thing wrong elsewhere — the same statement that does not hold, the same explanation missing — those change too; and where mending it takes a short passage written new — a word of explanation, a gesture, two or three lines of talk — it is written. Faults that have nothing to do with it stay, and the course of the plot is not changed under cover of it.'
      : 'Mend this problem and nothing beside it: no other change made in passing, no new turn of the plot, hint or explanation brought in under cover of it.'
  const enKeep = 'However much changes, two things do not. What the text taken in told — who, what was done, how it ended, which rule, which number — is all still told afterwards: in other words, at another spot, broken up into talk, never gone; before handing in, hold it against the original item by item. And what is written new makes up no name, year, origin or cause of death that the cards, the bible and the text so far do not hold — where such a fact is needed, the one already written is used.'
  const enWhole = asked || lead !== undefined
    ? 'Only where places will not do — the request is itself one for the whole of a chapter (its style, voice, point of view, pace), or so many of its sentences change that they run together — list the chapter under chapters, for the writer to write over whole; a chapter a few places will do for is not listed. An empty array when there is none.'
    : "Only where places will not do — the chapter's pace, point of view or voice has to change throughout — list it under chapters, for the writer to write over whole; a chapter a few places mend is not listed. An empty array when there is none."
  const enBible = 'Where the root of the problem is in the bible — a character card or a world entry that says something else than the text, or canon that itself has to change — list it under `bible`: for a character `field` is one of tagline, appearance, personality, background, motivation, flaw, arc, voice, age, gender; for a world entry, summary or body. Where the text is right and the bible is wrong, change the bible and leave the text.'
  const enRules = [
    ...(lead !== undefined ? [enFind] : []),
    ...(mends ? [enLess, enPlace, enReach, ...(bold ? [enKeep] : []), enWhole, ...(base.bible === true ? [enBible] : [])] : ['This time it is found and not changed: edits and chapters are empty arrays.']),
  ].map((rule, at) => `${at + 1}. ${rule}`).join('\n')
  const enNote = lead !== undefined
    ? `whether you took it as a fault or as a request; how many places it was found in and where its root lies${mends ? ', and why these places change' : ''}; where it was not found, where you looked`
    : asked ? 'what the request reaches, and why these places' : 'where the problem lies, and why these places'
  const enEdit = mixed
    ? `{"chapter": 1, "find": "the text that may change here, copied word for word", "replace": "a small change: the whole of this place as it is to read", "why": "why it changes so"}, {"chapter": 1, "find": "the text that may change here, copied word for word", "how": "a passage to be written: what this place is to say instead, specifically — for the writer"}`
    : direct
    ? `{"chapter": 1, "find": "${bold ? 'the text replaced here' : 'the sentence or two replaced here'}, copied word for word", "replace": "the whole of this place as it is to read", "why": "why it changes so"}`
    : `{"chapter": 1, "find": "${bold ? 'the text that may change here' : 'the sentence or two that may change here'}, copied word for word", "how": "what this place is to say instead, specifically"}`
  const enShape = `{${lead !== undefined ? '"findings": [{"chapter": 1, "quote": "the text it shows in, copied word for word", "type": "continuity|character|world|timeline|style|pacing|logic|language", "severity": "high|medium|low", "explanation": "what is wrong at this place", "suggestion": "how it could be mended"}], ' : ''}"edits": [${mends ? enEdit : ''}], "chapters": [${mends ? '{"index": 1, "reason": "why nothing short of writing it over will do, and how"}' : ''}], ${base.bible === true && mends ? '"bible": [{"kind": "character|world", "name": "the card or entry", "field": "the field to change", "value": "what it should say", "reason": "why"}], ' : ''}"note": "for the author, in two or three sentences: ${enNote}"}`
  const enIntro = lead === 'find'
    ? 'The author said something of this book, in a sentence (under "What the author said"). It may be something they noticed that is wrong, or a change they want made — which of the two is yours to tell. This time it is found and not changed: where it is a fault, say where in the book it shows; where it is a request, say which places it would reach.'
    : lead === 'fix'
      ? `The author said something of this book, in a sentence (under "What the author said"). It may be something they noticed that is wrong, or a change they want made — which of the two is yours to tell. A fault is found and mended: say first where in the book it shows, then settle which places change. A request is carried out: settle every place it reaches. ${mixed ? 'A small change you write yourself — what you write is what is proposed; a place where a passage is to be written you settle, and it goes to the writer. No chapter is written over.' : direct ? 'What each place is to read you write yourself — what you write is what is proposed, and no chapter is written over.' : 'How each place changes is yours to settle — the writer rewrites the places you name and nothing else; no chapter is written over.'}`
      : `${asked ? 'The author asks for a change through the book.' : 'The problems below are to be mended.'} ${mixed ? 'Settle which places change: a small change you write yourself (what you write is what is proposed), and of a place where a passage is to be written you say how it changes, for the writer — no chapter is written over.' : direct ? 'Settle which places change and write what each of them is to read: what you write is what is proposed, nobody rewrites after you — and no chapter is written over.' : 'Settle which places change and how each does: the writer rewrites the places you name and nothing else — no chapter is written over.'}`
  const enHead = lead !== undefined ? 'What the author said' : asked ? 'The requested change' : 'What is to be mended'

  return L(base.lang, `你是长篇小说《${bare(base.title)}》的责任编辑。${zhIntro}

## ${zhHead}

${base.instruction}

## 各章摘要${base.only === true ? `（作者只让${mends ? '动' : '查'}这几章，别的章节不在范围里）` : ''}

${base.chapters}
${texts ? `\n## 章节正文（${lead !== undefined ? 'quote 和 find' : 'find'} 从这里逐字照抄）\n\n${base.texts!.trim()}\n` : ''}${style !== undefined ? `\n## 这本书的文风（replace 照它写）\n\n${style}\n` : ''}
怎么定：
${zhRules}

只输出 JSON：
${zhShape}`, `You are the editor of the novel "${bare(base.title)}". ${enIntro}

## ${enHead}

${base.instruction}

## Chapter summaries${base.only === true ? ` (the author lets these chapters ${mends ? 'change' : 'be looked at'} and no other)` : ''}

${base.chapters}
${texts ? `\n## The chapters' text (copy ${lead !== undefined ? '`quote` and `find`' : '`find`'} from here, word for word)\n\n${base.texts!.trim()}\n` : ''}${style !== undefined ? `\n## How this book is written (replace is written so)\n\n${style}\n` : ''}
How to settle it:
${enRules}

Output JSON only:
${enShape}`)
}

// ───────────────────────────── memory ─────────────────────────────

export function digestSystem(lang: PromptLanguage): string {
  return L(lang, '你是严谨的小说连续性编辑（场记）。只依据给出的章节正文提取事实，不推测、不评价、不续写。严格按要求输出 JSON。', 'You are a meticulous continuity editor. Extract facts only from the chapter text given — no speculation, no critique, no continuation. Output JSON exactly as requested.')
}

/**
 * @param base.line - in a book of several lines of the plot, the name of the line this chapter is on: the digest then
 *   says of each new thing whether it is that story's alone or the world's. Left out for a book of one line, whose
 *   task reads as it always did.
 */
export function digestTask(base: Base & { chapterLabel: string; text: string; knownCharacters: string; knownWorld: string; openThreads: string; line?: string; namesakes?: string }): string {
  const zhLine = base.line !== undefined ? `## 故事线
这本书在同一个世界里有不止一条故事线，各讲各的故事。这一章在「${bare(base.line)}」这条线上。

` : ''
  const zhScope = base.line !== undefined ? ', "scope": "line|world —— line：只是这条故事线里的（这个故事自己的铺子、物件、小团体、只在这里有意义的说法）；world：这个世界本身的，别的故事线上的人也会遇到（城市与地域、朝代与制度、世界的规则、通行的名词）"' : ''
  // People on file in other stories of this world whose names this chapter spells: the same person, or a namesake?
  const zhNames = base.namesakes !== undefined ? `## 别的故事线上同名的人
下面这些人物已经建档，但都是别的故事线上的；本章正文里出现了同样的名字。
${base.namesakes}

` : ''
  const zhNamesShape = base.namesakes !== undefined ? `
  "namesakes": [{"name": "上面列出的名字", "same": "true：本章里叫这个名字的就是那个人，从那条线走到了这里；false：是这条线上另一个同名的人", "why": "一句话依据"}],` : ''
  const enNames = base.namesakes !== undefined ? `## People of the same name on other lines
These people are on file, but on other lines of the plot; this chapter's text spells the same names.
${base.namesakes}

` : ''
  const enNamesShape = base.namesakes !== undefined ? `
  "namesakes": [{"name": "a name listed above", "same": "true: whoever bears the name here is that very person, come over from that line; false: somebody else of the same name, of this line", "why": "one sentence"}],` : ''
  const enLine = base.line !== undefined ? `## Lines of the plot
This book tells more than one story in the same world. This chapter is on the line "${bare(base.line)}".

` : ''
  const enScope = base.line !== undefined ? ', "scope": "line|world — line: of this story alone (its own shop, object, small circle, a term that means something only here); world: of the world itself, met on the other lines too (cities and regions, the dynasty and its institutions, the rules of the world, terms in common use)"' : ''
  return L(base.lang, `下面是长篇小说《${bare(base.title)}》${base.chapterLabel}的正文。请做场记。

## 已建档人物（姓名 | 别名）
${base.knownCharacters || '（暂无）'}

## 已建档设定条目
${base.knownWorld || '（暂无）'}

## 尚未回收的线索
${base.openThreads || '（暂无）'}

${zhNames}${zhLine}## 正文
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
    {"name": "人物姓名（用已建档姓名；新人物用文中称呼）", "role": "他/她在本章做了什么", "stateAfter": "章末处境：身体、情绪、资源、决心等", "location": "章末所在", "emotion": "章末主导情绪", "learned": ["本章新得知的关键信息"], "quote": "一句最能体现其说话方式的原文台词，没有则空", "seen": "本章原文写到的这个人的样子：年纪、长相、身量、衣着、佩戴的东西——照原文的说法，原文没写就留空", "manner": "本章里显出来的性情与为人，一句话，原文没有依据就留空", "lifecycle": "enter|exit|death|return 之一，本章首次登场用 enter，离开故事舞台用 exit，死亡用 death，久别重返用 return，否则留空"}
  ],
  "facts": [
    {"subject": "主体", "statement": "本章确立、今后必须保持一致的事实", "kind": "state|relationship|knowledge|item|world|event"}
  ],
  "scenes": [
    {"name": "人物姓名（同上）", "title": "这一幕叫什么，两到四个字", "picture": "写成一幅定格的画面，60-140字：在哪里、在做什么、手里拿着什么、光线与气氛；这个人是画面的主体，别人只作陪衬", "weight": "3、2 或 1：3 是读者一想起这个人就会想起的一幕，2 是值得画下来的一幕，1 是勉强算"}
  ],
${zhNamesShape.replace(/^\n/, '')}${zhNamesShape.length > 0 ? '\n' : ''}  "newEntities": [
    {"name": "名称", "kind": "character|location|item|faction|term", "description": "正文中首次出现、值得建档的人物/地点/物品/组织/专有名词，一句话说明", "looks": "地点、物品：原文写到它看上去什么样，照原文的说法；没写就留空"${zhScope}}
  ],
  "threads": [
    {"title": "线索或伏笔的名称（若对应上面已有线索，用原名）", "action": "plant|advance|payoff", "note": "本章如何埋下/推进/回收"}
  ],
  "openQuestions": ["读者此刻会追问的问题"]
}
facts 只收对后文有约束力的硬事实（8-15条），不要把情节复述成事实。scenes 只收这一章里确有的、读者会靠它记住某个人的一幕——多数章节一幕也没有，那就是空数组；未成年的人物不写亲热和裸露的画面。只输出 JSON。`, `Below is ${base.chapterLabel} of the novel "${bare(base.title)}". Take continuity notes.

## Characters on file (name | aliases)
${base.knownCharacters || '(none)'}

## World entries on file
${base.knownWorld || '(none)'}

## Open threads
${base.openThreads || '(none)'}

${enNames}${enLine}## Text
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
    {"name": "use the name on file; for new people the name used in the text", "role": "what they did in this chapter", "stateAfter": "condition at chapter end: body, mood, resources, resolve", "location": "where they end up", "emotion": "dominant emotion at chapter end", "learned": ["key things they learned here"], "quote": "one line of theirs that best shows how they talk, or empty", "seen": "what this chapter's text says of how they look: age, face, build, dress, what they wear or carry — in the text's own terms; empty where it says nothing", "manner": "how they show themselves to be in this chapter, one sentence; empty where the text gives no ground", "lifecycle": "one of enter|exit|death|return — enter on first appearance, exit when leaving the story, death, return after a long absence — else empty"}
  ],
  "facts": [
    {"subject": "who or what", "statement": "a fact established here that later chapters must respect", "kind": "state|relationship|knowledge|item|world|event"}
  ],
  "scenes": [
    {"name": "the person's name (as above)", "title": "what the moment is called, in a few words", "picture": "the moment as one frozen picture, 40-90 words: where, doing what, holding what, the light and the mood; this person is its subject, others only beside them", "weight": "3, 2 or 1: 3 — a moment a reader thinks of when they think of this person; 2 — worth a picture; 1 — at a stretch"}
  ],
${enNamesShape.replace(/^\n/, '')}${enNamesShape.length > 0 ? '\n' : ''}  "newEntities": [
    {"name": "name", "kind": "character|location|item|faction|term", "description": "a person/place/object/group/term that first appears here and deserves a bible entry, one sentence", "looks": "a place, a thing: what the text says it looks like, in the text's own terms; empty where it says nothing"${enScope}}
  ],
  "threads": [
    {"title": "name of the thread or foreshadowing (reuse the exact name when it matches an open thread)", "action": "plant|advance|payoff", "note": "how this chapter plants / advances / pays it off"}
  ],
  "openQuestions": ["questions a reader is asking right now"]
}
Keep facts to the 8-15 hard facts that bind later chapters; do not restate the plot as facts. scenes holds only a moment this chapter really has that a reader would remember somebody by — most chapters have none, and the list is then empty; for a character who is a minor, no picture of intimacy or nudity. Output JSON only.`)
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
 * @param base.follows - the last chapter the line has, which the new ones follow: said, because one that is planned and
 *   not written yet is otherwise taken for the first of "the next chapters", and planned a second time.
 */
export function deriveChaptersTask(base: Base & { context: string; count: number; direction?: string; volume: string; situation?: string; after?: string; follows?: { label: string; written: boolean }; /** The pictures the author gave to steer these chapters, as the task tells of them. */ pictures?: string; /** The plan derived before, and what the author wants changed in it: it is adjusted, not derived anew. */ revise?: { plan: string; feedback: string } }): string {
  const pictures = base.pictures !== undefined && base.pictures.trim().length > 0 ? `\n\n${base.pictures.trim()}` : ''
  // Said with what is to be handed in, where the shape of a chapter is: which pictures it goes by.
  const pictured = pictures.length > 0 ? L(base.lang, '\n每章另加一项 "pictures"：这一章照着写的参考图的序号（如 [1]）；没有照哪张图的章写 []。', '\nGive every chapter one more field, "pictures": the numbers of the pictures it goes by (e.g. [1]); [] for a chapter that goes by none.') : ''
  const direction = base.direction !== undefined && base.direction.trim().length > 0 ? L(base.lang, `\n\n## 作者给的方向\n\n${base.direction.trim()}`, `\n\n## Direction from the author\n\n${base.direction.trim()}`) : ''
  const situation = base.situation !== undefined && base.situation.trim().length > 0 ? L(base.lang, `\n\n## 这次推演的处境\n\n${base.situation.trim()}`, `\n\n## Where these chapters go\n\n${base.situation.trim()}`) : ''
  const after = base.after !== undefined
    ? L(base.lang, `这些章节接在「${base.after}」之后、大纲里它后面那一章之前：要接得上前面，也要引得出后面。\n`, `These chapters go after "${base.after}" and before the chapter the outline has after it: they have to follow from the one and lead into the other.\n`)
    : base.follows !== undefined && base.revise === undefined
      ? L(base.lang,
          `这些章节接在大纲现有的最后一章「${base.follows.label}」之后${base.follows.written ? '' : '——那一章还没写，但已经排好了'}。大纲里已经有的章节都不重排，它们的事也不再讲一遍：从它之后讲起。\n`,
          `These chapters follow the last chapter the outline has, "${base.follows.label}"${base.follows.written ? '' : ' — not written yet, but planned'}. No chapter the outline already has is planned again, and what is theirs to tell is not told a second time: go on from after it.\n`)
      : ''
  const zhAsk = base.revise !== undefined
    ? `下面是你上一版为《${bare(base.title)}》的「${base.volume}」推演的章纲。作者看过了，提了修改意见：请照意见把这一版调整好，整版交回。

## 上一版

${base.revise.plan}

## 作者的修改意见

${base.revise.feedback}

要求：
- 意见说到的地方照意见改；因此要跟着变的前因后果、人物出场和线索一并理顺；
- 意见没有说到的章节和节拍照上一版原样交回，不重写、不换说法；
- 章数照意见来——要拆、要并、要加、要删的照办；没提就不变；
- "rationale" 里说清这一次照意见改了哪几处。
`
    : `请为《${bare(base.title)}》的「${base.volume}」推演接下来的 ${base.count} 章章纲。要求：
- 从已写内容和人物此刻的处境、欲望出发推演，情节由人物的选择推动，每章都有不可逆的变化；
- 兼顾群像：让久未出场但仍有未了之事的人物合理回归，不要让所有戏都压在主角身上；
- 主动推进或回收"尚未回收的线索"，新埋的伏笔要有后续打算；
- 相邻章节之间有因果链，节奏有张有弛。
`
  const enAsk = base.revise !== undefined
    ? `Below is the plan you derived before for "${bare(base.title)}", volume "${base.volume}". The author has read it and says what should change: adjust this plan by it and hand the whole of it back.

## The plan as it was

${base.revise.plan}

## What the author wants changed

${base.revise.feedback}

Requirements:
- Change what the author speaks of as they say; set right what has to change with it — causes and consequences, who appears, the threads.
- A chapter or a beat the author does not speak of goes back as it was: not rewritten, not reworded.
- As many chapters as the author's word makes it — split, joined, added or dropped as asked; the same number where nothing is said.
- Say in "rationale" what was changed this time.
`
    : `Derive the outlines of the next ${base.count} chapters of "${bare(base.title)}", volume "${base.volume}". Requirements:
- Start from what is written and from what each character wants right now; choices drive the plot and every chapter changes something for good.
- Serve the ensemble: bring back characters with unfinished business who have been off the page; do not hang every scene on the lead.
- Advance or pay off open threads; any new setup needs a plan.
- Adjacent chapters are causally linked; vary the pace.
`
  return `${base.context}${situation}${direction}${pictures}\n\n---\n${after}${L(base.lang, `${zhAsk}
只输出 JSON：
{"chapters": [{"title": "章名", "synopsis": "120-200字梗概", "purpose": "这一章对全书的作用", "pov": "视角人物姓名", "location": "主要地点", "time": "故事时间", "characters": ["出场人物姓名"], "beats": [{"summary": "节拍：谁想要什么、遇到什么阻碍、如何转折", "conflict": "冲突", "outcome": "结果"}], "threads": [{"title": "线索名", "action": "plant|advance|payoff"}]}], "rationale": "这样安排的理由与可选的其他走向（给作者看）"}
每章 3-6 个节拍。`, `${enAsk}
Output JSON only:
{"chapters": [{"title": "chapter title", "synopsis": "80-130 word synopsis", "purpose": "what the chapter does for the book", "pov": "viewpoint character name", "location": "main location", "time": "story time", "characters": ["names of characters appearing"], "beats": [{"summary": "beat: who wants what, what blocks them, how it turns", "conflict": "conflict", "outcome": "outcome"}], "threads": [{"title": "thread name", "action": "plant|advance|payoff"}]}], "rationale": "why this arrangement, and alternatives worth considering (for the author)"}
3-6 beats per chapter.`)}${pictured}`
}

export function deriveBeatsTask(base: Base & { context: string; direction?: string; pictures?: string }): string {
  return `${base.context}${base.direction !== undefined && base.direction.trim().length > 0 ? `\n\n${L(base.lang, '## 作者给的方向', '## Direction from the author')}\n\n${base.direction.trim()}` : ''}${base.pictures !== undefined && base.pictures.trim().length > 0 ? `\n\n${base.pictures.trim()}` : ''}\n\n---\n${L(base.lang, `请把"本章章纲"细化成可以直接照着写的场景节拍（4-8 个）。每个节拍要有明确的人物意图、阻碍与转折，体现人物性格，并标出情绪走向。

只输出 JSON：
{"synopsis": "细化后的本章梗概（150-250字）", "beats": [{"summary": "节拍内容", "characters": ["人物姓名"], "location": "地点", "conflict": "冲突", "outcome": "结果", "emotion": "情绪"}], "characters": ["本章全部出场人物姓名"], "pov": "视角人物姓名", "rationale": "一两句：这样排的考虑（给作者看）"}`, `Break "This chapter's outline" down into 4-8 scene beats a writer can follow directly. Each beat needs a clear intent, an obstacle and a turn, shows character, and names the emotional movement.

Output JSON only:
{"synopsis": "refined chapter synopsis (100-160 words)", "beats": [{"summary": "what happens", "characters": ["names"], "location": "place", "conflict": "conflict", "outcome": "outcome", "emotion": "emotion"}], "characters": ["every character appearing"], "pov": "viewpoint character name", "rationale": "a sentence or two: why laid out this way (for the author)"}`)}`
}

/**
 * One beat made from a sentence of the author's, or some of a chapter's beats changed by one: the rest of the beats
 * are shown to be gone by, and are nobody's to touch.
 * @param base.beats - the chapter's beats as they stand, numbered from 1.
 * @param base.chosen - the numbers of the beats that are to change; left out: a beat is added.
 * @param base.after - where the author wants the new beat: after this number (0: first). Left out: where it belongs.
 */
export function beatTask(base: Base & { context: string; ask: string; beats: string; chosen?: number[]; after?: number }): string {
  const changing = base.chosen !== undefined && base.chosen.length > 0
  const head = `${base.context}\n\n---\n${L(base.lang, '## 这一章现有的节拍', '## The beats of this chapter as they stand')}\n\n${base.beats.trim().length > 0 ? base.beats.trim() : L(base.lang, '（还没有节拍）', '(none yet)')}\n\n${L(base.lang, '## 作者的一句话', '## What the author says')}\n\n${base.ask.trim()}\n\n---\n`
  if (changing) {
    const which = base.chosen!.join(L(base.lang, '、', ', '))
    return `${head}${L(base.lang, `作者要改这一章的第 ${which} 个节拍，别的节拍不动。照这句话把${base.chosen!.length > 1 ? '这几个' : '这一个'}节拍改好：改完仍是可以直接照着写的场景节拍——谁想要什么、遇到什么阻碍、怎么转折——并且和它前后没动的节拍接得上。这句话没有说到的内容（在场的人、地点）照原样留着。没被点到的节拍只是给你对照的：不要改，也不要交回。照这句话，点到的某一个该并进另一个或者去掉时，给它 "remove": true。

只输出 JSON：
{"beats": [{"no": 节拍序号, "summary": "节拍内容", "characters": ["人物姓名"], "location": "地点", "conflict": "阻碍", "outcome": "转折 / 结果", "emotion": "情绪"}], "why": "一句话：改了什么"}`, `The author wants beat${base.chosen!.length > 1 ? 's' : ''} ${which} of this chapter changed, and no other. Change ${base.chosen!.length > 1 ? 'them' : 'it'} as said: each is still a scene beat a writer can follow — who wants what, what stands in the way, how it turns — and joins the beats before and after it that stay. What the sentence does not speak of (who is there, where) stays as it was. The beats that were not named are shown to go by: do not change them and do not hand them back. Where, by what is said, one of the named beats goes into another or goes altogether, give it "remove": true.

Output JSON only:
{"beats": [{"no": the beat's number, "summary": "what happens", "characters": ["names"], "location": "place", "conflict": "what stands in the way", "outcome": "how it turns", "emotion": "emotion"}], "why": "one sentence: what changed"}`)}`
  }
  const where = base.after !== undefined
    ? L(base.lang, base.after <= 0 ? '作者要它放在最前（after 填 0）。' : `作者要它接在第 ${base.after} 个节拍之后（after 填 ${base.after}）。`, base.after <= 0 ? 'The author wants it first (after: 0).' : `The author wants it after beat ${base.after} (after: ${base.after}).`)
    : L(base.lang, '它放在哪由你定：照这一章里事情的先后，after 填它接在第几个节拍之后（0 = 最前）。', 'Where it goes is yours to settle, by the order things happen in this chapter: `after` is the number of the beat it follows (0: first).')
  return `${head}${L(base.lang, `作者要给这一章加一个节拍。照这句话把它写成一个可以直接照着写的场景节拍：谁想要什么、遇到什么阻碍、怎么转折；和章纲、和它前后的节拍接得上。只写这一个——现有的节拍一个都不动，也不要交回。${where}

只输出 JSON：
{"beat": {"summary": "节拍内容（一两句）", "characters": ["人物姓名"], "location": "地点", "conflict": "阻碍", "outcome": "转折 / 结果", "emotion": "情绪"}, "after": 0, "why": "一句话：为什么放在这里"}`, `The author wants one beat added to this chapter. Make of the sentence a scene beat a writer can follow: who wants what, what stands in the way, how it turns — joining the chapter's plan and the beats before and after it. This one only: the beats there are stay untouched, and are not handed back. ${where}

Output JSON only:
{"beat": {"summary": "what happens (a sentence or two)", "characters": ["names"], "location": "place", "conflict": "what stands in the way", "outcome": "how it turns", "emotion": "emotion"}, "after": 0, "why": "one sentence: why here"}`)}`
}

/**
 * What the planner that derived a plan is told when the author has read it and wants it changed: said into the
 * conversation it derived the plan in — what it handed in, what the author says of it, what to hand in now.
 */
export function reviseChaptersFollowUp(lang: PromptLanguage, input: { handedIn: string; feedback: string; tool: string }): string {
  return L(lang, `作者看了你上次交的这一版章纲，提了修改意见。

## 你上次交的

\`\`\`json
${input.handedIn}
\`\`\`

## 作者的修改意见

${input.feedback}

请照意见把这一版调整好，整版再交一次（${input.tool}，和上次一样的格式）：
- 意见说到的地方照意见改；因此要跟着变的前因后果、人物出场和线索一并理顺；
- 意见没有说到的章节和节拍照原样交回，不重写、不换说法；
- 章数照意见来——要拆、要并、要加、要删的照办；没提就不变；
- "rationale" 里说清这一次照意见改了哪几处。`, `The author has read the plan you handed in and says what should change.

## What you handed in

\`\`\`json
${input.handedIn}
\`\`\`

## What the author wants changed

${input.feedback}

Adjust this plan by it and hand the whole of it in again (${input.tool}, in the same shape as before):
- Change what the author speaks of as they say; set right what has to change with it — causes and consequences, who appears, the threads.
- A chapter or a beat the author does not speak of goes back as it was: not rewritten, not reworded.
- As many chapters as the author's word makes it — split, joined, added or dropped as asked; the same number where nothing is said.
- Say in "rationale" what was changed this time.`)
}

/**
 * A chapter's plan read off its text — its beats alone, or its synopsis, purpose, place, time, point of view and cast
 * with them. The plan is written anew from what the chapter says: of the one there was, the items in words are shown
 * beside the text to be held against it, not to be checked off, and the beats are not shown at all — a list of beats
 * laid out before the chapter was written is handed back as it stands by a model that sees it, and a scene the text
 * has beyond it goes without a beat.
 * @param base.around - the chapters on either side, in a line each: what the chapter does for the book is said against them.
 */
export function planOfTextTask(base: Base & { what: 'beats' | 'plan'; chapterLabel: string; text: string; synopsis?: string; purpose?: string; location?: string; time?: string; pov?: string; cast?: string; knownCharacters: string; around?: string }): string {
  const whole = base.what === 'plan'
  const has = (value: string | undefined): value is string => value !== undefined && value.trim().length > 0
  const zhItems = [
    `梗概：${has(base.synopsis) ? base.synopsis.trim() : '（没有）'}`,
    ...(whole ? [`这一章的作用：${has(base.purpose) ? base.purpose.trim() : '（没写）'}`, `地点：${has(base.location) ? base.location.trim() : '（没写）'}`, `故事时间：${has(base.time) ? base.time.trim() : '（没写）'}`, `视角：${has(base.pov) ? base.pov.trim() : '（没写）'}`, `出场人物：${has(base.cast) ? base.cast.trim() : '（没写）'}`] : []),
  ].join('\n')
  const enItems = [
    `Synopsis: ${has(base.synopsis) ? base.synopsis.trim() : '(none)'}`,
    ...(whole ? [`What the chapter is for: ${has(base.purpose) ? base.purpose.trim() : '(not said)'}`, `Place: ${has(base.location) ? base.location.trim() : '(not said)'}`, `Story time: ${has(base.time) ? base.time.trim() : '(not said)'}`, `Point of view: ${has(base.pov) ? base.pov.trim() : '(not said)'}`, `Cast: ${has(base.cast) ? base.cast.trim() : '(not said)'}`] : []),
  ].join('\n')
  const zhBeats = `- beats：把正文从头到尾走一遍，一场一个节拍，按先后排，一场都不漏——开头那一场和结尾那一场都要有（一般 3-8 个，很短的一章可以更少）。只列正文里有的，正文没有写的不列。
- 每个节拍：summary——这一场是什么事，一句话（四十字以内），说事不复述细节；characters——在场的人，有档的用档上的名字；location——在哪；conflict——阻碍；outcome——怎么转、落在什么结果上；emotion——情绪。正文没有交代的项不写。`
  const enBeats = `- beats: go through the text from its first line to its last, a beat a scene, in order, none left out — the opening scene and the closing one too (3-8 as a rule, fewer for a very short chapter). Only what the text has: nothing the text does not tell.
- Each beat: summary — what the scene is, in one sentence (twenty-five words at most): the event, not its details retold; characters — who is there, by the names on file where they have one; location; conflict — what stands in the way; outcome — how it turns and where it lands; emotion. Leave out what the text does not say.`
  const zhAsk = whole
    ? `请把这一章的章纲从正文重新读出来——是照正文写一份，不是把原来那份核对一遍：原来的章纲多半是动笔之前排的，正文会比它多、比它细，也可能没有照它写。之后照这份章纲干活的人——重写这一章的写手、给它排分镜的导演、往下推演的策划——读到的要和正文一致。
- synopsis：这一章写了什么，150-250 字，照正文，从开头说到结尾。
- purpose：这一章在全书里起什么作用——推进了什么、兑现了什么、埋下了什么——一两句话，照正文实际做到的写：原来写的作用里正文没有做到的不留，正文多做到的补上。
- location：这一章主要在哪；time：故事里的什么时候。正文没有交代的不写。
- pov：视角人物；characters：这一章里出场的人——有言行的才算，只被提到的不算——有档的用档上的名字，没有档的照正文里的称呼。
${zhBeats}

只输出 JSON：
{"synopsis": "照正文写的本章梗概", "purpose": "这一章的作用", "location": "地点", "time": "故事时间", "pov": "视角人物姓名", "characters": ["出场人物姓名"], "beats": [{"summary": "节拍内容", "characters": ["人物姓名"], "location": "地点", "conflict": "阻碍", "outcome": "结果", "emotion": "情绪"}]}`
    : `请把这一章的节拍从正文重新读出来——是照正文列一份，不是把原来那份核对一遍。
${zhBeats}

只输出 JSON：
{"beats": [{"summary": "节拍内容", "characters": ["人物姓名"], "location": "地点", "conflict": "阻碍", "outcome": "结果", "emotion": "情绪"}]}`
  const enAsk = whole
    ? `Read this chapter's plan off its text anew — written by the text, not the plan there was ticked off against it: that plan was most likely laid out before the chapter was written, and the text tells more than it, in more detail, and perhaps otherwise. Whoever works from the plan afterwards — a writer rewriting the chapter, the director cutting it into panels, the planner deriving what follows — is to read what was written.
- synopsis: what the chapter tells, in 100-160 words, by the text, from its opening to its end.
- purpose: what the chapter does for the book — what it moves, pays off or sets up — in a sentence or two, by what the text really does: nothing kept of the purpose there was that the text does not do, and what it does beyond that added.
- location: where most of the chapter is; time: when in the story. Leave out what the text does not say.
- pov: whose eyes it is told through; characters: who is in the chapter — acting or speaking, not merely mentioned — by the names on file where they have one, else as the text calls them.
${enBeats}

Output JSON only:
{"synopsis": "the chapter's synopsis by its text", "purpose": "what the chapter is for", "location": "place", "time": "story time", "pov": "viewpoint character name", "characters": ["every character appearing"], "beats": [{"summary": "what happens", "characters": ["names"], "location": "place", "conflict": "conflict", "outcome": "outcome", "emotion": "emotion"}]}`
    : `Read this chapter's beats off its text anew — listed by the text, not the beats there were ticked off against it.
${enBeats}

Output JSON only:
{"beats": [{"summary": "what happens", "characters": ["names"], "location": "place", "conflict": "conflict", "outcome": "outcome", "emotion": "emotion"}]}`
  const zhAround = whole && has(base.around) ? `\n## 前后章（说这一章的作用时参照）\n\n${base.around.trim()}\n` : ''
  const enAround = whole && has(base.around) ? `\n## The chapters on either side (what this one is for is said against them)\n\n${base.around.trim()}\n` : ''
  return L(base.lang, `## ${base.chapterLabel} 正文

${base.text}

## 原来的章纲（只供对照：可能是动笔之前排的，正文也可能在那之后改过）

${zhItems}
${zhAround}
## 已建档的人物

${base.knownCharacters.trim().length > 0 ? base.knownCharacters : '（无）'}

---
${zhAsk}`, `## ${base.chapterLabel} — the text

${base.text}

## The plan there was (for comparison only: it may have been laid out before the chapter was written, and the text may have changed since)

${enItems}
${enAround}
## Characters on file

${base.knownCharacters.trim().length > 0 ? base.knownCharacters : '(none)'}

---
${enAsk}`)
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
  "characters": [{"name": "姓名", "role": "protagonist|deuteragonist|antagonist|supporting", "gender": "性别", "age": "年龄", "tagline": "一句话人设", "personality": "性格与为人：一段话，连同他的弱点、看重什么、绝不会做什么", "background": "来历与处境：一段话，连同他的本事和藏着的事", "motivation": "想要什么/真正需要什么", "arc": "人物弧光", "voice": "说话的样子：语气、句式、口头禅", "appearance": "外貌要点"}],
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
  "characters": [{"name": "name", "role": "protagonist|deuteragonist|antagonist|supporting", "gender": "gender", "age": "age", "tagline": "one-line identity", "personality": "who they are: a paragraph, their flaw, what they hold dear and what they would never do in it", "background": "where they come from and stand: a paragraph, what they can do and what they hide in it", "motivation": "want / need", "arc": "arc", "voice": "how they talk: tone, sentence shapes, pet phrases", "appearance": "looks"}],
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
{"tagline": "", "gender": "", "age": "", "appearance": "外貌：一段话——年龄感、体型、脸、发式、平常的衣着、随身的标志物；只写看得见的，写手照它写、画图也照它画", "personality": "性格与为人：一段话——他的特质、弱点、最看重什么、绝不会做什么、压力下什么反应，都写在这一段里，不另列", "background": "来历与处境：一段话——出身、经历、现在的位置，他的本事和藏着的事也写在这里", "motivation": "", "arc": "", "voice": "说话的样子：语气、句式、口头禅", "relationships": [{"target": "对方姓名", "kind": "关系", "note": "说明"}], "voiceDesign": "用于设计配音声线的描述（年龄感、音色、语速、气质）"}`, `Complete the character card below. Keep what is there; fill the gaps and give the character more dimension and inner conflict. It must agree with the bible and the written text.${base.direction !== undefined && base.direction.trim().length > 0 ? `\nThe author asks: ${base.direction.trim()}` : ''}

## Current card

${base.card}

Output JSON only (include only fields you add or improve):
{"tagline": "", "gender": "", "age": "", "appearance": "how they look: one paragraph — the age they seem, build, face, hair, what they usually wear, what they carry; only what can be seen — the writer writes them by it and every picture of them is drawn by it", "personality": "who they are: one paragraph — traits, flaw, what they hold dearest, what they would never do, how they react under pressure, all in it and not listed apart", "background": "where they come from and stand: one paragraph — origin, what they went through, their place now, what they can do and what they hide", "motivation": "", "arc": "", "voice": "how they talk: tone, sentence shapes, pet phrases", "relationships": [{"target": "other character's name", "kind": "relationship", "note": "note"}], "voiceDesign": "description for designing their speaking voice (age, timbre, pace, temperament)"}`)}`
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
  return L(base.lang, `下面是从一部作品里摘出的原文（"……"隔开的是不同的地方）。请像文体学者一样分析它的写法（不是内容），提炼成可以指导写作的文风档案。

"""
${base.sample}
"""

语体是这份档案里最要紧的一栏：照着它写的人，写出来的得是同一种语言。语体看原文的字面，不看它讲的是哪个年代的事，也不因为读得懂就算作现代白话：
- 文言：单音词为主，之乎者也，省略多；
- 浅近文言 / 半文半白；
- 古白话（宋元话本、明清章回小说的白话）：有"了""的"，但满纸是"道""便""只见""却说""原来""因""遂""方""甚""这般"一类的词，称谓、套语、句式都是旧的；常带章回体的格式（回目、"话说""且说""欲知后事如何"），夹诗词韵文；
- 民国白话（新旧掺杂，欧化句式初现）；
- 现代白话 / 当代书面语；网络小说的口语体；方言写作；译文体……
以原文里实际出现的词和句式为证；几种掺着用的，说清楚叙述用哪种、对白用哪种。

只输出 JSON：
{"name": "${base.name ?? '给这种文风起个名字'}", "register": "语体：是哪一种（上面的叫法不贴切就用更准确的），哪个年代、哪种体裁的写法；再从原文里原样摘出 5-8 个最能标志它的词、称谓或句式", "pov": "first|third-limited|third-omniscient|second|multi", "tense": "past|present", "tone": "基调与叙述者态度", "diction": "用词特点（词汇层次、雅俗、方言、专业词）", "rhythm": "句长、断句与段落节奏", "imagery": "意象与修辞的密度和类型", "dialogue": "对白的写法与提示语习惯（谁说话怎么引出、称呼怎么用）", "pacing": "叙事推进与详略", "rules": ["5-8条可执行的写作规则，体现这种笔触；第一条写明用什么语体写"], "avoid": ["这种文风里不会出现的写法——包括不属于这种语体的词和句式"], "exemplars": ["从原文中摘出 1-2 段最能代表笔触的原句（原样摘录，每段不超过150字）"]}`, `Below are passages from one work (an ellipsis on a line of its own parts different places of it). Analyze how it is written (not what it says), as a stylistician would, and distill a style profile that can guide writing.

"""
${base.sample}
"""

The register is what matters most in this profile: whoever writes by it has to write the same language. Judge it by the words on the page, not by the period the story is set in, and not as contemporary prose merely because it reads easily: archaic or early-modern English, the prose of a given century and genre (Augustan, Victorian, pulp, hard-boiled…), contemporary literary prose, colloquial web fiction, dialect writing, translationese… Say which, on the evidence of words and constructions that are actually there; where narration and dialogue differ, say which is which.

Output JSON only:
{"name": "${base.name ?? 'a name for this style'}", "register": "the register: which kind of language, of what period and genre; then 5-8 words, forms of address or constructions quoted from the passages that mark it", "pov": "first|third-limited|third-omniscient|second|multi", "tense": "past|present", "tone": "tone and narrator's attitude", "diction": "word choice (level, vocabulary, dialect, jargon)", "rhythm": "sentence length, breaks, paragraph rhythm", "imagery": "density and kind of imagery and rhetoric", "dialogue": "how dialogue is written, tagged and addressed", "pacing": "narrative movement and what gets detail", "rules": ["5-8 actionable rules that produce this touch; the first names the register to write in"], "avoid": ["things this style never does — words and constructions that are not of its register among them"], "exemplars": ["1-2 verbatim excerpts (under 100 words each) that best show the touch"]}`)
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
    ? '{"characters": [{"listed": "名单上的写法，原样照抄", "name": "最常用的正式姓名", "same_as": "", "aliases": ["其他称呼"], "role": "protagonist|deuteragonist|antagonist|supporting|minor|cameo", "gender": "", "age": "", "tagline": "一句话人设", "appearance": "年纪、长相、衣着：照名单里“样子”的记载写", "personality": "性情与为人，连同他看重什么、弱点是什么", "background": "出身与来历，连同他的本事、藏着的事", "motivation": "想要什么", "arc": "已发生的转变", "voice": "说话方式", "relationships": [{"target": "对方姓名", "kind": "关系", "note": ""}]}]}'
    : '{"characters": [{"listed": "名单上的写法，原样照抄", "name": "最常用的正式姓名", "same_as": "", "aliases": ["其他称呼"], "role": "supporting|minor|cameo", "gender": "", "tagline": "一句话：是谁、和谁有关"}]}'
  const enShape = base.full
    ? '{"characters": [{"listed": "the name as listed, copied exactly", "name": "most used proper name", "same_as": "", "aliases": ["other names"], "role": "protagonist|deuteragonist|antagonist|supporting|minor|cameo", "gender": "", "age": "", "tagline": "one-line identity", "appearance": "age, face, dress: from what the list says under looks", "personality": "temper and bearing, with what they hold dear and their flaw", "background": "where they come from, with what they can do and what they hide", "motivation": "what they want", "arc": "change so far", "voice": "how they talk", "relationships": [{"target": "other name", "kind": "relationship", "note": ""}]}]}'
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

/**
 * The names the page uses for people who have no card: which of them is worth one. Asked after chapters were digested
 * — a digest names everybody it meets, the doorman as much as the rival, and a card each would bury the cast.
 * @param base.names - a line a name: where they are seen and what the digests say of them.
 * @param base.known - who has a card, for recognizing other names.
 */
export function castSiftTask(base: Base & { names: string; known: string; direction?: string }): string {
  const known = base.known.trim().length > 0 ? base.known : L(base.lang, '（还没有）', '(nobody yet)')
  const direction = base.direction !== undefined && base.direction.trim().length > 0 ? L(base.lang, `\n【作者的要求】\n${base.direction.trim()}\n`, `\nWHAT THE AUTHOR ASKS\n${base.direction.trim()}\n`) : ''
  return L(base.lang, `下面是小说《${bare(base.title)}》的正文里出现过、还没有人物卡的一批名字，以及各章的收录对每个人的记载。请逐个说明：这个名字该不该有一张人物卡。

【这一批】
${base.names}

【已经有人物卡的人】只用来辨认别名
${known}
${direction}
每个名字是下面三种之一：
- card：值得一张人物卡。这个人在故事里有他自己的戏——有自己的言行和选择，推动了什么，或者和主要人物有说得出的关系；读者再遇到他时，得认得他是谁。
- alias：其实是"已经有人物卡的人"里某一位、或者这一批里另一个名字的别的称呼。
- walkon：龙套。场面上的人——门子、小厮、路人、被人提起一句的人。他留在龙套名单里，不建卡。

只露过一面、书里还看不出后面有戏的人，是 walkon：他再出场时会再来问你。

只输出 JSON：
{"people": [{"name": "名单上的写法，原样照抄", "is": "card|alias|walkon", "why": "一句话，写给作者看：他做了什么、凭什么这么定", "role": "is=card 时：supporting 重要配角 | minor 次要人物 | cameo 露面的角色", "tagline": "is=card 时：一句话——是谁、和谁有关", "same_as": "is=alias 时：是谁（那个人的名字）"}]}

- 名单上的每个名字都要有一项，一个也不要漏；不要添加名单之外的人。
- 没有依据的字段留空，不要编造。`, `Below are names the text of the novel "${bare(base.title)}" uses for people who have no character card yet, with what the chapter digests say of each. Say of every one whether the name should have a card.

THIS BATCH
${base.names}

WHO HAS A CARD ALREADY — for recognizing other names only
${known}
${direction}
Every name is one of three:
- card: worth a character card. This person has a part of their own in the story — things they say, do and choose, something they set going, or a tie to a leading character that can be named; a reader who meets them again has to know who they are.
- alias: another name of somebody who has a card already, or of another name in this batch.
- walkon: a walk-on. Somebody of the scene — a doorman, a servant, a passer-by, a person mentioned once. They stay in the list of walk-ons and get no card.

Somebody seen once, of whom the book does not yet show more to come, is a walkon: when they turn up again you are asked again.

Output JSON only:
{"people": [{"name": "the name as listed, copied exactly", "is": "card|alias|walkon", "why": "one line, for the author: what they do, and why this", "role": "for is=card: supporting | minor | cameo", "tagline": "for is=card: one line — who they are, and to whom", "same_as": "for is=alias: who (that person's name)"}]}

- One item for every name listed, none left out; nobody who is not listed.
- Leave a field empty where nothing supports it; invent nothing.`)
}

/**
 * What the digests propose for the bible, looked over side by side: which of it is worth an entry, which is another
 * name of something the bible has, and which is not worth writing down.
 */
export function settleTask(base: Base & { suggestions: string; known: string; threads: string }): string {
  const none = L(base.lang, '（还没有）', '(nothing yet)')
  return L(base.lang, `收录小说《${bare(base.title)}》的章节时，记下了下面这些给设定集的建议。它们不再逐条等作者批准：你来定哪些收进设定集，作者之后看的是你收进去的那些。

【建议】
${base.suggestions}

【设定集里已经有的】
${base.known.trim().length > 0 ? base.known : none}

【已有的线索】
${base.threads.trim().length > 0 ? base.threads : none}

每条建议是下面三种之一：
- enter：收进设定集。新设定——故事要回到它、别处要和它对得上、或者画面里要画它的地点、组织、物件、规矩和名词；新线索——真埋下了、后面要回收的；线索状态——这一章确实回收或放弃了它。
- merge：它其实是"设定集里已经有的"某一条的另一个叫法（into 写那一条的名字）；新线索和已有的某条线索是同一件事时也用它。
- skip：不收。路过一次的地方、场面上的寻常物件、只是字面上的普通词、太笼统说不出是什么的，或者这本书的设定集用不着记的。

只输出 JSON：
{"verdicts": [{"n": 建议的序号, "verdict": "enter|merge|skip", "why": "一句话，写给作者看：凭什么这么定", "into": "verdict=merge 时：已有的那一条的名字", "category": "verdict=enter 且是新设定时：setting|location|faction|system|item|history|culture|rule|term|other 里最贴切的一个", "summary": "verdict=enter 且是新设定时：一句话说它是什么（照建议里写的，不添没有依据的）"}]}

每条建议都要有一项，一条也不要漏。`, `While chapters of the novel "${bare(base.title)}" were digested, the suggestions below were noted for its bible. They no longer wait for the author one by one: you settle which of them enter the bible, and what the author looks at afterwards is what you entered.

THE SUGGESTIONS
${base.suggestions}

WHAT THE BIBLE HAS ALREADY
${base.known.trim().length > 0 ? base.known : none}

THE THREADS THERE ARE
${base.threads.trim().length > 0 ? base.threads : none}

Every suggestion is one of three:
- enter: into the bible. A new entry — a place, group, thing, rule or term the story returns to, that other chapters have to agree with, or that pictures will show; a new thread — one truly planted, to be paid off later; a thread's state — this chapter did pay it off or drop it.
- merge: it is another name of something the bible has already ("into" names that entry); also for a new thread that is the same matter as one there is.
- skip: left out. A place passed once, an ordinary object of a scene, a common word, something too vague to say what it is, or what this book's bible has no use for.

Output JSON only:
{"verdicts": [{"n": the suggestion's number, "verdict": "enter|merge|skip", "why": "one line, for the author: why this", "into": "for verdict=merge: the name of the entry it belongs to", "category": "for verdict=enter of a new entry: the closest of setting|location|faction|system|item|history|culture|rule|term|other", "summary": "for verdict=enter of a new entry: one line saying what it is (as the suggestion has it; nothing unsupported)"}]}

One item for every suggestion, none left out.`)
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
  return L(base.lang, `下面是收录小说《${bare(base.title)}》各章时记下的一批地点、组织、物品与专有名词（方括号里是类别，后面是出现在几章、各章怎么说它）。请定下哪些进设定集：名单上的每一项是下面三种去向之一。

- 成条：故事要回到它、别处得和它对得上、或者画面里要画它的——有名有姓的地方、家族与组织、要紧的物件、这本书自己的规矩和名词。
- 并入：和另一项是同一样东西的不同叫法（"宁府"和"宁国府"）——并成一条，别的叫法进 aliases。
- 不收（skip）：只是说"在哪""用什么"的寻常东西——某间书房、一张床、路边的酒肆茶铺、"某人家""某人处""城外""郭外"这类只标方位的说法、场面上的寻常物件、字面上的普通词。只出现在一章、又没有自己名字的，多半是这一类。
${first ? '\n另补一条总览式的"世界概况"。\n' : ''}
${base.sightings}

只输出 JSON：
{"entries": [{"name": "名称", "aliases": ["别名"], "category": "setting|location|faction|system|item|history|culture|rule|term|other", "importance": ${first ? '1或2或3' : '2或3'}, "summary": "一句话", "body": "根据原文整理的说明", "look": "地点、组织、物件：它看上去什么样（名单里"样子"写了的才填，照那里写的整理成一段；没写就留空）"}], "skip": [{"name": "不收的那一项（名单上的写法）", "why": "一句话"}]}
importance：${first ? '1=理解全书必须知道的核心设定（不超过 6 条），' : ''}2=常规，3=细节。名单上的每一项都要有着落：成条、并入，或列进 skip。没有依据的内容不要编造。`, `Below is a batch of places, groups, objects and terms noted while the chapters of the novel "${bare(base.title)}" were digested (the kind in brackets, then in how many chapters it turns up and what they say of it). Settle which of them enter the bible: everything in the batch goes one of three ways.

- An entry: what the story returns to, what other chapters have to agree with, what pictures will show — places with a name of their own, houses and groups, things that matter, this book's own rules and terms.
- Folded in: another name of the same thing as another item — one entry, the other names its aliases.
- Left out (skip): ordinary things that only say where or with what — a study, a bed, an inn by the road, "so-and-so's house", "outside the city", an ordinary object of a scene, a plain word. What turns up in one chapter and has no name of its own is mostly of this kind.
${first ? '\nAdd one overview entry describing the world at large.\n' : ''}
${base.sightings}

Output JSON only:
{"entries": [{"name": "name", "aliases": ["aliases"], "category": "setting|location|faction|system|item|history|culture|rule|term|other", "importance": ${first ? '1' : '2'}, "summary": "one sentence", "body": "what the text establishes", "look": "for a place, group or thing: what it looks like (only where the batch gives its looks — put together from what is there; otherwise empty)"}], "skip": [{"name": "an item left out (as the batch writes it)", "why": "one line"}]}
importance: ${first ? '1 = core canon needed to follow the book (6 at most), ' : ''}2 = normal, 3 = detail. Everything in the batch ends up somewhere: an entry, an alias, or under skip. Do not invent beyond the text.`)
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

/**
 * @param base.references - the book has references and reviews hold a chapter against them: `look` — the reviewer has
 *   the tools to read in them (it is told to, among its rules); `notes` — what the planner took out of them for
 *   whoever wrote this chapter.
 */
export function reviewTask(base: Base & { context: string; focus?: string; references?: { look: boolean; notes?: string } }): string {
  const notes = base.references?.notes !== undefined && base.references.notes.trim().length > 0
    ? L(base.lang, `\n\n## 写这一章时交给写手的参考摘记（策划从这本书的参考文献里查来的）\n\n${base.references.notes.trim()}`, `\n\n## The notes from the references the writer of this chapter was handed (what the planner found for it in the books this one goes by)\n\n${base.references.notes.trim()}`)
    : ''
  const against = base.references === undefined ? ['', '']
    : base.references.look
      ? ['\n- 参考文献：这本书有参考文献，作者说了每一本怎么参考（见你的规则）。先到里面查这一章碰到的东西，再对照：作者要它守的设定、称谓、规矩，要它学的文风，这一章对不上的地方记成问题（type 用 world 或 style），说明里写清出自哪一本的哪里；作者没让照的不算问题；', '\n- references: this book has references, and the author says how each is to be used (among your rules). Look in them for what this chapter touches, then hold it against them: where it is at odds with settings, forms of address and rules the author has it keep to, or with a style the author has it learn, file an issue (type world or style) that says which book and where; what the author did not ask to be followed is no issue;']
      : notes.length > 0
        ? ['\n- 参考文献：对照上面的参考摘记——这一章和摘记里“要守的”对不上的地方记成问题（type 用 world 或 style），说明里写清出自哪一本；', '\n- references: hold the chapter against the notes above — where it is at odds with what they say to keep to, file an issue (type world or style) that says which book;']
        : ['', '']
  return `${base.context}${notes}\n\n---\n${L(base.lang, `请以资深责任编辑的眼光审读"本章已有正文"。逐项核对：
- 连续性：与前文事实、时间线、人物位置和已知信息是否矛盾；
- 人物：言行是否符合人物卡的性格、动机、说话方式，有无"作者替人物说话"；
- 设定：是否违反世界观规则；
- 逻辑：动机、因果、信息来源是否成立；
- 文风：是否符合设定的文风，有无陈词滥调、空泛抒情、重复用词等"AI 味"；
- 节奏：详略是否得当，章纲节拍是否都落地，结尾是否有力。${against[0]}${base.focus !== undefined && base.focus.trim().length > 0 ? `\n重点关注：${base.focus.trim()}` : ''}

只输出 JSON：
{"verdict": "两三句总体评价", "issues": [{"severity": "high|medium|low", "type": "continuity|character|world|timeline|style|pacing|logic|language", "quote": "从正文中原样摘出的问题句子（必须是原文的连续片段，30字以内为宜；全局性问题可留空）", "explanation": "问题是什么、为什么是问题", "suggestion": "具体怎么改"}]}
只报真实存在的问题，没有就返回空数组；不要为了凑数而吹毛求疵。`, `Read "This chapter so far" as a senior editor would. Check each of:
- continuity: contradictions with earlier facts, the timeline, where people are and what they know;
- character: do words and actions fit the card — personality, motivation, voice; is the author speaking through anyone;
- world: any rule of the setting broken;
- logic: do motives, causes and sources of information hold;
- style: does it follow the style profile; clichés, vague lyricism, repeated words, anything that reads machine-made;
- pacing: is detail spent well, did every outlined beat land, does the ending hit.${against[1]}${base.focus !== undefined && base.focus.trim().length > 0 ? `\nPay special attention to: ${base.focus.trim()}` : ''}

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
  /** Who is in the chapter: who they are, how they look, and what else they have to wear. */
  cast: string
  locations: string
  /** Things and terms of the bible the chapter names: what each is, and what there is of it to see. */
  things?: string
  /** The chapter itself: its title, where and when it is set, what happens in it. */
  chapter?: string
  artStyle: string
  /** How many panels, in words: a number to aim for, or bounds within which the director decides. */
  count: string
  /** What the panel before this passage showed, when the passage continues a board. */
  previous?: string
  avoid?: string[]
}): string {
  return L(base.lang, `你是有声漫画（动态漫）的分镜导演。下面是一章有声剧里连续的一段，已经切成最小的镜头单位（序号 | 说话人 | 约几秒 | 内容）。请把它们编成连续的分镜画面：每个画面覆盖若干连续的单位，在这些单位播放期间停留在屏幕上。
${base.chapter !== undefined && base.chapter.length > 0 ? `\n## 这一章\n${base.chapter}\n` : ''}
## 人物（是谁、长什么样、还有哪几身造型）
${base.cast || '（无）'}

## 场景
${base.locations || '（无）'}
${base.things !== undefined && base.things.length > 0 ? `\n## 物件与名词（它在这个故事里是什么、看上去什么样）\n${base.things}\n` : ''}
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
5. prompt 是给绘图模型的这一格画面：景别与构图（特写 / 中景 / 远景、机位），画面里每个人在哪、在做什么（用上面的名字称呼他们），神情用几个字点到，手里和身边有什么，这一格的环境、时间、光线与气氛。80–160 字，只写眼睛看得见的。**人物的长相和衣着、场景和物件的样子不用在这里重写**：画的时候会把 characters、wearing、location、things 里点到的每一项在设定里的样子原样接在 prompt 后面——所以这四栏要填全、名字照上面的写。人此刻的状态不细写：谁身上和平常不一样（淋湿了、带了伤、沾了血），用几个字点到，不展开；东西和设定里平常的样子不同（撕开了、烧了一角）同样点到为止。机构名、头衔、没列在上面的专有名词，换成它在这个故事里实际看上去的样子。不要出现文字、对白气泡、分格。
6. wearing：这一格里谁穿的不是平常那一身，就写 {"姓名": "造型名"}（造型名取自上面他的造型）；都穿平常的就留空。
7. things：这一格画面里看得见的、列在"物件与名词"里的东西，写它们的名字；没有就留空。
8. camera 从 still|zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down 里选一个缓慢的镜头运动。

只输出 JSON：
{"panels": [{"from": 0, "to": 3, "description": "", "prompt": "", "camera": "zoom-in", "characters": ["在场人物姓名"], "wearing": {}, "location": "地点", "things": []}]}`, `You are the storyboard director of a motion comic. Below is one continuous passage of a chapter's audio drama, already cut into the smallest units a shot may cover (index | speaker | seconds | text). Arrange them into consecutive panels: each panel covers a run of consecutive units and stays on screen while they play.
${base.chapter !== undefined && base.chapter.length > 0 ? `\n## This chapter\n${base.chapter}\n` : ''}
## People (who they are, how they look, what else they have to wear)
${base.cast || '(none)'}

## Locations
${base.locations || '(none)'}
${base.things !== undefined && base.things.length > 0 ? `\n## Things and terms (what each is in this story, and what there is of it to see)\n${base.things}\n` : ''}
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
5. prompt: this panel's picture for the image model — shot size and composition (close-up / medium / wide, angle), where each person in frame is and what they do (call them by the names above), the expression in a word or two, what they hold and what is beside them, the setting, hour, light and mood of this panel. 50-110 words, only what the eye can see. **How people look and dress, and how the place and the things look, is not to be written again here**: when the panel is drawn, the look the bible has for everything named under characters, wearing, location and things is put after the prompt as it stands — so fill those four in fully, with the names as written above. The state somebody is in is not described at length: what is not as usual about them (soaked, wounded, bloodied) is named in a few words and left there; so is a thing that differs from how the bible has it (torn open, a corner burnt). An institution, a title or a proper noun not listed above is written as what it looks like in this story. No text, speech balloons or panel borders.
6. wearing: where somebody wears something other than their usual look in this panel, {"name": "look"} (a look listed for them above); empty when everyone is in their usual.
7. things: the things listed under "Things and terms" that can be seen in this panel, by name; empty when none.
8. camera: one slow move from still|zoom-in|zoom-out|pan-left|pan-right|pan-up|pan-down.

Output JSON only:
{"panels": [{"from": 0, "to": 3, "description": "", "prompt": "", "camera": "zoom-in", "characters": ["names of characters in frame"], "wearing": {}, "location": "place", "things": []}]}`)
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
2. 竖幅构图；画面上方留出一块干净的空间放标题；主体在中下部。写清谁在画面里（用姓名称呼）、各自的姿态，神情用几个字点到；人物的长相、头发和衣着不写——画的时候由他们的人设图给出（没有图的，他的样子会接在这条描述后面）。然后是所处的环境、光线、色调与气氛。
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
2. Portrait format; a clean area at the top for the title; the subject in the middle and lower part. Say who is in the picture (by name) and how each holds themselves, the expression in a word or two; nothing of their features, hair or clothing — their design sheets give that when it is drawn (for somebody without one, their look is added after this description). Then where they are, the light, the palette and the mood.
3. Only what the eye can see. Names of institutions, ranks and proper nouns become what they actually look like in this story: material, shape, age, colour. Where the art direction fixes a period or a form (which dynasty or fashion hair, dress, buildings and objects belong to), these are written in that form; where the text says otherwise, the art direction holds.
4. Nothing from "must not appear" is drawn, and none of those words go into the description. No lettering, no watermark, no frame.
5. 80-150 words. Output the description only.`)
}

/**
 * The picture of one passage of a chapter, settled by the director: what the frame shows, who is in it — whoever the
 * passage means, named or not —, what they wear there, where it is set and which things of the bible it shows. The
 * Studio then says how each of them looks, as the bible has it, and sends their pictures along; so the director
 * writes the moment, and names what is in it.
 */
export function passagePictureTask(base: Base & { chapter: string; passage: string; before?: string; after?: string; ask?: string; cast: string; places?: string; artStyle: string; avoid?: string[]; whole?: boolean }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  return L(base.lang, `要给《${bare(base.title)}》的一段正文画一张插图。请定下这张图：画面是什么，画里有谁、在哪、有什么。

## 这一章
${base.chapter}
${base.before !== undefined && base.before.length > 0 ? `\n## 这一段之前的正文（用来认人、认地方——这一段里的“他”“她”是谁，此刻在哪）\n${base.before}\n` : ''}
## ${base.whole === true ? '要画的内容（这一章的梗概：从里面取最有画面感的一刻）' : '要画的这一段'}
${base.passage}
${base.after !== undefined && base.after.length > 0 ? `\n## 紧接着的正文\n${base.after}\n` : ''}${base.ask !== undefined ? `\n## 作者对这一张的要求\n${base.ask}\n` : ''}
## 人物（这一章里的人：名字｜身份｜平常的样子｜可选的造型）
${base.cast || '（这一章还没有记下人物：用 book_read what=character 看人物表）'}

## 地点与物件（设定里有、这一段前后写到的）
${base.places !== undefined && base.places.length > 0 ? base.places : '（没有对上的条目）'}

## 美术风格（会另行附加，不必复述）
${base.artStyle}

## 画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

交回的内容：
1. picture：画面，80-160 字。${base.whole === true ? '取最有画面感的一个瞬间；' : '画的是这一段写的那一刻；'}写清景别与机位、谁在哪里做什么、手里和身边的东西、光线与气氛。人物用姓名称呼；每个人的样子由带上的人设图给出（没有图的，他的样子会接在后面），这里不写长相、头发和衣着，也不细写人此刻的状态：动作写清楚，神情几个字；此刻和平常不一样的地方（淋湿、带伤、换了哪身衣服）用几个字点到，不展开。只写眼睛看得见的；机构名、头衔、专有名词写成它在这个故事里实际的样子。美术风格里对年代、形制有规定的照它写。“画面里不能出现”的东西不画，也不把这些词写进来。不要文字、水印、分格。
2. people：画面里出现的人，写姓名（照上面的人物表），主体在前，至多 4 个。这一段用代词、称呼指的人，从前文认出是谁；没有人物卡的人不列，只在 picture 里写出他的样子。
3. wearing：{"姓名": "造型名"}——只给此刻穿的不是平常那一身、而且有这个造型可选的人。
4. place：这一幕所在的地方，写设定里的条目名；设定里没有就不写。
5. things：画面里看得见、设定里有条目的物件，写条目名。
6. why：一句话，说给作者听：这一幕里有谁、在哪，你是凭什么认定的。
上面的材料认不出这一段里是谁、此刻穿什么、那件东西长什么样时，书里有：book_read 读前后文、人物卡和设定，book_search 找。

只输出 JSON：
{"picture": "画面", "people": ["姓名"], "wearing": {"姓名": "造型名"}, "place": "条目名", "things": ["条目名"], "why": "一句话"}`, `A passage of "${bare(base.title)}" is to be illustrated. Settle the picture: what it shows, who is in it, where, with what.

## The chapter
${base.chapter}
${base.before !== undefined && base.before.length > 0 ? `\n## The text before the passage (to tell who and where: whom its "he" and "she" mean, where they are)\n${base.before}\n` : ''}
## ${base.whole === true ? 'What to illustrate (the chapter in summary: take its most visual moment)' : 'The passage to illustrate'}
${base.passage}
${base.after !== undefined && base.after.length > 0 ? `\n## The text right after\n${base.after}\n` : ''}${base.ask !== undefined ? `\n## What the author asks of this picture\n${base.ask}\n` : ''}
## People (those of this chapter: name | who they are | how they usually look | looks to choose from)
${base.cast || '(nobody is on record for this chapter yet: book_read what=character lists the cast)'}

## Places and things (of the bible, named around the passage)
${base.places !== undefined && base.places.length > 0 ? base.places : '(no entry matches)'}

## Art direction (added separately; do not repeat it)
${base.artStyle}

## Must not appear in the picture
${avoid.length > 0 ? avoid : '(nothing in particular)'}

What to hand in:
1. picture: the picture, 50-110 words. ${base.whole === true ? 'The single most visual moment; ' : 'The moment the passage tells; '}state shot and viewpoint, who is where doing what, what is in hand and at hand, light and mood. Call people by name; how each looks is given by the design sheet that goes along (for somebody without one, their look is added after it), so nothing of features, hair or clothing here, and the state somebody is in is not described at length: the action plainly, the expression in a word or two; what is not as usual about them just then (soaked, wounded, which other clothes) named in a few words and left there. Only what the eye can see; names of institutions, titles and proper nouns as what they actually look like in this story. Where the art direction fixes a period or a form, write in that form. Nothing from "Must not appear" is drawn, and none of those words is written. No text, watermark or panel borders.
2. people: who is in the frame, by name (as the list above has them), its subject first, four at most. Whoever the passage means by a pronoun or a form of address is told from the text before it; somebody with no card is not listed, only described in the picture.
3. wearing: {"name": "look name"} — only for somebody who wears something other than their usual here, and has that look to choose.
4. place: where the moment is set, by the name of its entry in the bible; nothing where the bible has none.
5. things: the things in the frame that have an entry in the bible, by entry name.
6. why: one sentence for the author: who is in it and where, and what told you so.
Where the material above does not tell who the passage means, what they wear at this point or what a thing looks like, the book does: book_read reads the text around it, the cards and the entries; book_search finds.

Output JSON only:
{"picture": "the picture", "people": ["name"], "wearing": {"name": "look name"}, "place": "entry name", "things": ["entry name"], "why": "one sentence"}`)
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
export function lookTask(base: Base & { kind: 'place' | 'thing' | 'house'; entry: string; passages: string; avoid?: string[]; direction?: string; artStyle?: string }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  /** One wording for a place, one for a thing, one for a house or an organisation. */
  const pick = (place: string, thing: string, house: string): string => (base.kind === 'place' ? place : base.kind === 'thing' ? thing : house)
  return L(base.lang, `请把《${base.title}》里的这${pick('个地方', '件东西', '个家族或组织')}写成一段"它长什么样"：它的设定图照这段话画，以后凡是画到它的图也都带着这段话，所以要具体、稳定、画得出来。

## 设定里怎么写它
${base.entry}

## 正文里写到它的地方
${base.passages.length > 0 ? base.passages : '（正文里还没有找到直接写它样子的句子——需要的话自己去查原文。）'}
${base.direction !== undefined && base.direction.length > 0 ? `\n## 作者的要求\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. 用这本书的语言写，80–160 字，一段话，不分条。
2. 只写看得见的、不随情节变的：${pick('格局与规模（几进院落、有没有水、地势高低）、主要的建筑和它们的样式、材质与颜色、草木与陈设、年代与地域的感觉', '形状与大小、材质、颜色、纹饰或刻着的字样（照原文）、新旧与磨损、拿在手里或摆着时的样子', '它的门庭与所在（宅邸、堂口、山门是什么样）、徽记、旗号或匾额、它的人平常的衣着和聚在一处时的样子、排场的大小、年代与地域的感觉')}。
3. 以正文为准：正文写了的照着写，不要改；正文没写的可以补全，但要与这本书的时代、地域、身份相称，一旦写下就是定论。只有一样例外：画风里对年代、地域和形制有规定的（${pick('建筑、陈设、器物', '器物、纹饰、做工', '建筑、衣冠、徽记')}属于哪个朝代、哪种式样），是这本书的定论——把它写成那种形制下具体的样子（${pick('屋顶、梁柱、门窗、院墙怎么样', '器形、纹样、工艺怎么样', '门庭、衣冠、旗号怎么样')}）。正文的写法与它冲突时以画风为准：它自己的${pick('格局、规模和特征', '形状、大小和特征', '排场、规模和特征')}留着，形制换成画风规定的。
4. ${pick('不写人物', '不写人物', '不写具体的哪一个人（它的人作为一群是什么样可以写）')}、不写事件、不写某一场戏里的情形；不写气味、声音、寓意这类画不出来的东西；画风里说"怎么画"的部分（画种、笔触、用色、光线）、镜头和画质都不写——那些由全书的画风统一附上。
5. 不要用只有读过这本书才懂的名字来代替描述：${pick('"某某的住处"要写成它实际的样子', '"那面镜子"要写成它实际的样子', '"某某一党"要写成看得见的样子')}。

只输出 JSON：{"look": ""}`, `Write down what this ${pick('place', 'thing', 'house or organisation')} of "${base.title}" looks like: its design art is drawn from this paragraph, and every later picture that shows it carries it along — so it has to be concrete, stable and drawable.

## What the bible says of it
${base.entry}

## Where the text names it
${base.passages.length > 0 ? base.passages : '(No sentence of the text was found that says how it looks — read the text yourself where you need to.)'}
${base.direction !== undefined && base.direction.length > 0 ? `\n## The author asks\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. In the language of the book, 50–110 words, one paragraph, no list.
2. Only what can be seen and does not change with the plot: ${pick('its layout and size (courts, water, the lie of the land), its main buildings and how they are built, materials and colours, what grows and what is kept there, the feel of its time and region', 'its shape and size, material, colour, ornament or what is written on it (as the text has it), its age and wear, how it sits in a hand or on a table', 'its seat and where it stands (the house, the hall, the gate), its emblem, banner or name-board, how its people dress and how they look gathered, how grand it is, the feel of its time and region')}.
3. The text is law: what it says, say as it says it; what it leaves open may be filled in, in keeping with the book's time, region and the standing of whoever owns it — once written it is canon. With one exception: where the art direction fixes a period, a region or a form (which dynasty or fashion ${pick('buildings, furnishings and objects', 'objects, ornament and workmanship', 'buildings, dress and emblems')} belong to), that is settled for this book — write it as it is in that form (${pick('roofs, posts and beams, doors and windows, walls', 'its shape, its patterns, how it is made', 'its gate, its dress, its banner')}). Where the text says otherwise the art direction holds: keep what is its own (${pick('layout, size, what marks it out', 'shape, size, what marks it out', 'its state, its size, what marks it out')}) and put it into the form the art direction fixes.
4. ${pick('No people', 'No people', 'No one person in particular (what its people look like as a body may be said)')}, no events, nothing of one particular scene; nothing that cannot be drawn (smell, sound, meaning); nothing of how to paint (medium, brushwork, palette, light), of camera or of image quality — the book's art direction adds those to every picture.
5. Do not put a name only a reader of the book understands in place of a description.

Output JSON only: {"look": ""}`)
}

/**
 * How a character looks, written down once as their appearance: prose in the book's own language, concrete enough
 * that a writer and an image model both go by it. There is one such text of a person — no second description beside
 * it written for image models alone.
 * @param base.artStyle - the book's art direction: where it fixes a period or a form of dress, the appearance is written in that form, over what the card and the source text say.
 * @param base.legacy - the phrases an earlier version kept for image models (a "visual anchor"): folded into the appearance — where the two differ, the phrases hold, as pictures were drawn from them.
 */
export function appearanceTask(base: Base & { card: string; avoid?: string[]; direction?: string; artStyle?: string; legacy?: string; currentNegative?: string }): string {
  const avoid = (base.avoid ?? []).join(', ')
  const legacy = base.legacy !== undefined && base.legacy.trim().length > 0
  const styled = (base.artStyle?.trim() ?? '').length > 0
  return L(base.lang, `请写下这个人物的外貌：一段话，用${base.language}写。写手照它写这个人，每一张有此人的图也照它画——所以它必须具体、稳定、画得出来。人物卡上已经有外貌的，是把它写准、写全，不是另起一段。

## 人物
${base.card}
${legacy ? `\n## 以前另写给绘图模型的短语（"视觉锚点"，现在并进外貌）\n${base.legacy!.trim()}\n已经画好的图是照它画的：它写到的特征都要在外貌里；它和人物卡的外貌说法不一样时，以它为准。\n` : ''}${base.currentNegative !== undefined && base.currentNegative.trim().length > 0 ? `\n这个人身上不要画出：${base.currentNegative.trim()}\n` : ''}${base.direction !== undefined && base.direction.length > 0 ? `\n## 作者的要求\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
1. appearance：一段通顺的话，${legacy ? '以把上面那些短语里的特征写全为先，不必压短' : '80–200 字'}。只写看得见的：年纪与体型、脸、发色与发式（写成具体的形状，不用风格名）、肤色、平常的衣着（款式、材质、颜色、新旧）、随身的标志物。
2. 不写性格、身份、经历；也不写他站在哪里、身后有什么、正在做什么——那是某一张画面的事，写进外貌就会出现在他的每一张图里（人物卡的外貌里有这类话的，不带过来）。机构名、教派、头衔之类的词不能代替描写——"教会式的发髻"要写成它实际的形状，"白甲"要写清是什么材质、什么结构、有没有纹饰。
3. 人物卡的外貌里已有的写法，与作者的要求${styled ? '、画风' : ''}都不冲突的照旧保留；原文没写的细节可以补全，但要与人物相称，并且一旦写下就是定论。${styled ? `
4. 画风里对年代、地域和形制有规定的（哪个朝代、哪种式样），是这本书的定论，这个人的头发和衣着一律写成那种形制。人物卡或原文的写法与它冲突时，以画风为准：
   - 属于形制的：头发怎么梳、束不束、编不编辫、剃不剃，头上戴什么；衣服的款式——上身下身各穿什么、领、襟、袖、下摆、怎么系；鞋帽的样式。
   - 人物卡或原文写的发式、款式若不是那种形制里有的（比如别的朝代才有的发式和衣服），不要照搬，也不要折中成两样都有：换成那种形制下，同样年龄、身份的人会有的发式和款式，写成具体的样子。
   - 这个人自己的东西留着，放到新的款式上：颜色、纹样、材质、贵贱、佩戴和随身的东西。
   - 画风里说"怎么画"的部分（画种、笔触、用色、光线）不要写进来。` : ''}
${styled ? 5 : 4}. 只写这个人"长什么样"，不写"此刻在做什么"：不要动作、姿势、此刻的表情和手里临时拿的东西；不要气味、声音、气质这类看不见的东西；也不要画风、光线、镜头、画质之类的词。
${styled ? 6 : 5}. negative：0–10 项，逗号分隔。写这段外貌最容易被画错、而这个人物身上不该有的东西（例如不该有的纹章、饰物、发式、年龄感）${styled ? '；画风规定了形制时，把最容易混进来的别的形制也列进去（比如另一个朝代的发式和服饰）' : ''}。${base.currentNegative !== undefined && base.currentNegative.trim().length > 0 ? '现在那几项还成立的照旧留着。' : ''}

只输出 JSON：{"appearance": "", "negative": ""}`, `Write down how this character looks: one paragraph, in ${base.language}. The writer writes them by it and every picture of them is drawn by it — so it must be concrete, stable and drawable. Where the card has an appearance already, this is that appearance made exact and whole, not another paragraph beside it.

## Character
${base.card}
${legacy ? `\n## Phrases kept for image models before (a "visual anchor"), now folded into the appearance\n${base.legacy!.trim()}\nPictures already drawn were drawn from these: every feature they name is in the appearance; where they and the card's appearance differ, they hold.\n` : ''}${base.currentNegative !== undefined && base.currentNegative.trim().length > 0 ? `\nNever drawn on them: ${base.currentNegative.trim()}\n` : ''}${base.direction !== undefined && base.direction.length > 0 ? `\n## The author asks\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
1. appearance: one paragraph of plain prose, ${legacy ? 'as long as it takes to have every feature of those phrases in it' : '60–140 words'}. Only what can be seen: age and build, face, hair colour and how it is worn (spelled out as a shape, not as a style name), skin, what they usually wear (cut, material, colour, wear), what they always have about them.
2. No personality, role or history; nor where they stand, what is behind them or what they are doing — that is of one picture, and written into an appearance it turns up in every picture of them (where the card's appearance says such things, they are not carried over). The name of an institution, an order or a title does not stand in for a description — "a church-style bun" is written as its actual shape; "white armour" as what it is made of, how it is built and whether it carries any emblem.
3. What the card's appearance has that nothing here speaks against — the author's wish${styled ? ', the art direction' : ''} — stays as it is; details the source leaves open may be filled in, in keeping with the character, and once written they are canon.${styled ? `
4. Where the art direction fixes a period, a region or a form of dress (which dynasty, which fashion), that is settled for this book, and this person's hair and clothing are written in that form throughout. Where the card or the source text says otherwise, the art direction holds:
   - Of the form: how the hair is dressed — bound or loose, braided or not, shaved or not — and what is worn on the head; the cut of the clothes — what is worn above and below, collar, lapels, sleeves, hem, how it is fastened; the make of shoes and hats.
   - A hairstyle or a cut the card or the source text has that does not belong to that form (the hair and the garments of another dynasty, say) is not carried over, and not blended in so that both are there: put in its place what somebody of that age and standing wears in that form, written as what it looks like.
   - What is this person's own stays, and goes onto the new cut: colours, patterns, materials, how rich or plain, what they wear and carry.
   - What the art direction says of how to draw (the medium, the brushwork, the palette, the light) is not written in.` : ''}
${styled ? 5 : 4}. Only how they look, not what they are doing: no action, pose, passing expression or anything held for the moment; nothing that cannot be seen (scent, voice, air); no words about art style, light, camera or image quality.
${styled ? 6 : 5}. negative: 0–10 items, comma-separated. What this appearance is most easily drawn wrong as and must not be on this person (an emblem, an ornament, a hairstyle, an age they do not have)${styled ? '; where the art direction fixes a form, the other forms most easily mixed in go here too (the hair and dress of another dynasty, say)' : ''}.${base.currentNegative !== undefined && base.currentNegative.trim().length > 0 ? ' Those there are that still hold stay.' : ''}

Output JSON only: {"appearance": "", "negative": ""}`)
}

/**
 * After a chapter was changed to mend something: look again at the issues still open — did the change settle them
 * too, do they stand, or do they read differently now.
 * @param base.changes - what was changed, here and in other chapters, in a few lines each.
 */
export function recheckTask(base: Base & { chapter: string; text: string; issues: string; changes: string }): string {
  return L(base.lang, `《${bare(base.title)}》${base.chapter}的正文刚刚因为修订改过（或者别的章节为了修同一类问题改过）。下面是这一章还没处理的审校意见，请对照**现在的正文**逐条重新看一遍。

## 这次改了什么
${base.changes}

## 还没处理的审校意见
${base.issues}

## 这一章现在的正文
${base.text}

逐条判断：
- fixed：这个问题已经不存在了——这次修改（这一章的，或者它所指的那一章的）把它解决了。
- stands：问题还在，说法也还成立。原来引用的句子如果已经变了，quote 给出现在正文里对应的那一句（必须是现在正文里的原话）。
- changed：问题还在，但因为正文变了，它现在的样子不同了：explanation 重写成对现在正文成立的说法，quote 换成现在正文里的原话。
只判断上面列出的这几条，不要提新的问题。拿不准的算 stands。why 用一句话说明依据。

只输出 JSON：{"issues": [{"id": "", "verdict": "fixed | stands | changed", "quote": "", "explanation": "", "why": ""}]}`, `The text of ${base.chapter} of "${bare(base.title)}" has just been changed by a revision (or other chapters were, to mend the same kind of problem). Below are the review issues of this chapter that are still open. Read each again against **the text as it stands now**.

## What was changed
${base.changes}

## Issues still open
${base.issues}

## The chapter as it reads now
${base.text}

For each:
- fixed: the problem is gone — this change (to this chapter, or to the chapter it points at) settled it.
- stands: the problem is still there and still reads true. Where the sentence it quoted has changed, quote gives the sentence that stands for it now (word for word from the text as it is).
- changed: the problem is still there but reads differently now that the text has changed: rewrite explanation so that it is true of the text as it is, and give quote word for word from it.
Judge only the issues listed; raise no new ones. Where unsure, it stands. why: one sentence on what you went by.

Output JSON only: {"issues": [{"id": "", "verdict": "fixed | stands | changed", "quote": "", "explanation": "", "why": ""}]}`)
}

/**
 * Find the stretches of a character's life in the book: how old they are as they enter, and the points where they
 * turn — in age, in look, in who they are. The planner is an agent with the book to read; the digests' notes say
 * where to look.
 * @param base.stages - the stretches kept so far, when they are looked over again.
 */
export function growthTask(base: Base & { name: string; card: string; record: string; span: string; stages?: { title: string; chapter?: number; age?: string; what?: string; appearance?: string; persona?: string }[]; direction?: string }): string {
  const kept = base.stages !== undefined && base.stages.length > 0
  const asked = base.direction !== undefined && base.direction.length > 0
  const list = (base.stages ?? []).map((stage, at) => L(base.lang,
    `${at + 1}. ${stage.title}${stage.chapter !== undefined ? `（从第 ${stage.chapter} 章起）` : '（故事开始时）'}${stage.age !== undefined ? ` · ${stage.age}` : ''}${stage.what !== undefined ? ` · ${stage.what}` : ''}${stage.appearance !== undefined ? `\n   样子：${stage.appearance}` : ''}${stage.persona !== undefined ? `\n   为人：${stage.persona}` : ''}`,
    `${at + 1}. ${stage.title}${stage.chapter !== undefined ? ` (from chapter ${stage.chapter})` : ' (as the story begins)'}${stage.age !== undefined ? ` · ${stage.age}` : ''}${stage.what !== undefined ? ` · ${stage.what}` : ''}${stage.appearance !== undefined ? `\n   Look: ${stage.appearance}` : ''}${stage.persona !== undefined ? `\n   Who: ${stage.persona}` : ''}`)).join('\n')
  const zh = [
    '先定他登场时的年纪：原文写明的照原文；没写明的，从称呼、辈分、旁人的年纪、他做的事和书里的时间推出来，写成"约十三岁（少年）"这样——一个大约的岁数，加上所在的年龄段（幼年、少年、青年、中年、老年）。实在无从判断就只写年龄段。',
    '再沿着章节往后找这个人"变成了另一个样子"的地方——关键点：年龄段变了（幼年长成少年、少年长成青年；书里时间跳过去、过了几年）、身份变了（成婚、出仕、出家、落难、掌权）、样子变了（长大成人、伤残、久病、换了一生的装束）。每个关键点之后是一个新的时期。',
    '时期不是情节。一件事——初见某人、一场梦、一次丧事、入学、题诗、吵架又和好——不是一个时期，哪怕它很有名；一个时期通常跨很多章。判断的办法：把前后两个时期的他各画一张像、各用一句话说"他是谁"，画出来、说出来要明显不一样；一样，就还是同一个时期。年纪只长了一两岁、样子和身份都没变的，算在同一个时期里，age 写成一个范围（"约七到十岁（幼年）"）。',
    '所以数目很少：大多数人在一本书里只有一到三个时期，很多人自始至终只有登场时那一个。不要凑数，也不要按章节切。',
    '上面的记载是各章收录时记下的，只是线索，而且可能只收录了一部分章节；拿不准的地方到原文里去看。书里没有写到的将来不要编。',
    ...(asked ? ['作者的要求是给你的引导：他点到的转折要有；他说的年纪以他为准。'] : []),
    ...(kept ? ['现在记着的那几个时期，也照上面的标准重新衡量一遍：算得上一个时期的留下（was 写它原来的序号；作者没要求改的，内容照原样）；其实只是一件事的，去掉，或者并进它所在的那个时期；漏掉的补上。'] : []),
    '每个时期：title 几个字（幼年、入园之后、出家之后）；chapter 它从第几章开始（数字；登场时那一个写他登场的那一章）；age 这个时期的年纪，写法同上；what 一句话说他在这里变成了什么样（不是这一章发生了什么；登场时那一个写他登场时的处境）；appearance 这个时期他看上去什么样——只在和上一个时期明显不同时写（年纪长了的体貌、发式、装束），用这本书的语言，只写看得见的；persona 这个时期他是谁、处世如何——只在和人物卡上写的明显不同时写。',
    'age：他登场时的年纪（和第一个时期的一样）。',
  ]
  const en = [
    'First, how old they are as they enter: what the text states is taken as stated; where it states nothing, tell it from what they are called, their generation, the ages of those around them, what they do and the time of the book, and write it as "about thirteen (a youth)" — an approximate age and the stage of life (child, youth, young adult, middle-aged, old). Where nothing can be told, the stage of life alone.',
    'Then follow the chapters for the points where this person becomes somebody else to look at or to describe: their stage of life changes (a child grown into a youth, a youth into an adult; the book skips years), their station changes (married, in office, in orders, ruined, in power), their look changes (grown up, maimed, long ill, a way of dress for good). After each such point a new stretch begins.',
    'A stretch is not an episode. One event — a first meeting, a dream, a funeral, starting school, a poem, a quarrel made up — is no stretch, however famous; a stretch usually runs over many chapters. The test: draw them in the stretch before and in this one, and say in one sentence who they are in each — the two pictures and the two sentences must clearly differ; where they do not, it is still the same stretch. A year or two older with look and station unchanged belongs to the same stretch, its age given as a range ("about seven to ten (a child)").',
    'So there are few: most people have one to three stretches in a book, and many only the one they enter in. None to make up a number, and none cut by chapter.',
    'The notes above were taken as chapters were digested — leads, and possibly of some chapters only; where unsure, read the text. Nothing of a future the book has not written.',
    ...(asked ? ['What the author asks is your guide: a turn they name is there; an age they give holds.'] : []),
    ...(kept ? ['The stretches kept so far are held to the same test: one that is a stretch stays (`was` gives the number it had; where the author asked for no change, as it was); one that is really a single event is dropped, or folded into the stretch it lies in; missing ones are added.'] : []),
    'Each stretch: title in a few words (childhood, after moving into the garden, in orders); chapter the chapter it begins with (a number; for the one they enter in, the chapter they enter); age in this stretch, written as above; what they became here, in a sentence (not what happened in the chapter; for the first, where they stand as they enter); appearance how they look in it — only where it clearly differs from the stretch before (a body grown, hair, dress), in the language of the book, only what is seen; persona who they are in it and how they bear themselves — only where it clearly differs from the card.',
    'age: how old they are as they enter (the same as the first stretch).',
  ]
  return L(base.lang, `请读《${bare(base.title)}》，找出「${base.name}」在书里的各个时期：登场时多大，后来在哪些地方变了——年纪、样子、身份。

## 人物
${base.card}

## 这本书的章节与时间
${base.span}

## 各章的收录里对这个人的记载
${base.record.length > 0 ? base.record : '（还没有哪一章的收录记到这个人——到原文里去找。）'}
${kept ? `\n## 现在记着的时期（作者让你重新看一遍）\n${list}\n` : ''}${asked ? `\n## 作者的要求\n${base.direction}\n` : ''}
要求：
${zh.map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

只输出 JSON：{"age": "", "stages": [{"title": "", "chapter": 0, "age": "", "what": "", "appearance": "", "persona": ""${kept ? ', "was": 0' : ''}}]}`, `Read "${bare(base.title)}" and find the stretches of ${base.name}'s life in it: how old they are as they enter, and where they turn afterwards — in age, in look, in who they are.

## Character
${base.card}

## The book's chapters and its time
${base.span}

## What the chapter digests noted of them
${base.record.length > 0 ? base.record : '(No chapter digest names them yet — look in the text.)'}
${kept ? `\n## The stretches kept so far (the author has you look them over)\n${list}\n` : ''}${asked ? `\n## What the author asks\n${base.direction}\n` : ''}
Rules:
${en.map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

Output JSON only: {"age": "", "stages": [{"title": "", "chapter": 0, "age": "", "what": "", "appearance": "", "persona": ""${kept ? ', "was": 0' : ''}}]}`)
}

/** How a moment is to be written as a portrait: the same wherever the director writes one. */
function scenePictureRules(styled: boolean): { zh: string[]; en: string[] } {
  return {
    zh: [
      '写成一张立绘的画面：这个人是主体，半身到七分身，脸看得清；那一幕里的别人只作陪衬（背影、远处、局部），不抢主体。写一个定格的瞬间，不是一段经过：不写对话，不写先后发生的几件事。未成年的人物不写亲热和裸露的画面。',
      `长相和平常的衣着不要重写（会另行带上）；只有这一幕里原文写明换了的穿戴才写。${styled ? '画风里对年代、形制有规定的（发式、服饰、建筑、器物属于哪个朝代、哪种式样），画面里这些东西照它写；原文的写法与它不一样时以画风为准。' : ''}`,
      '只写眼睛看得见的；只有读过这本书才懂的名字，写成它实际的样子；"不能出现"的东西不要写。不写画风、镜头、画质。',
    ],
    en: [
      'Written as a portrait: this person is the subject, waist-up to three-quarter length, the face clearly seen; whoever else is in the moment is there as company only (a back, a distance, a part), never the subject. One instant held still, not a course of events: no dialogue, no one thing after another. Somebody who is not yet an adult is not written into a moment of intimacy or nudity.',
      `Their face and usual clothing are not written again (they are added separately); only what the text says they wear differently in this moment.${styled ? ' Where the art direction fixes a period or a form (which dynasty or fashion hair, dress, buildings and objects belong to), these are written in that form; where the text says otherwise, the art direction holds.' : ''}`,
      'Only what the eye can see; a name only a reader of the book understands is written as what it looks like; nothing from "must not appear". No words about art style, camera or image quality.',
    ],
  }
}

/**
 * How a moment is made ready for its picture — one frame: the instant in a few words, what the person wears in it,
 * what is around them, who and what else is in it. The same wherever the director does it: for a moment a card
 * keeps ({@link momentShotTask}) and for one it picks by what the author asked ({@link portraitSceneTask}).
 * @param words - the language the frame is written in: the one the image prompts of the book are in.
 */
function shotRules(words: PromptLanguage, styled: boolean): { zh: string[]; en: string[]; keys: string } {
  const inZh = words === 'zh' ? '中文' : '英文（English）'
  const inEn = words === 'zh' ? 'Chinese' : 'English'
  return {
    zh: [
      `action：这一刻的画面，一两句，不超过 50 字——这个人什么姿势、在做什么、手里拿着什么；神情用几个字点到。画面里还有别的人，就各用半句交代他在哪、在做什么。写一个定格的瞬间：不写前因后果，不写对白、心里想的和比喻，不写眼睛看不见的；不写谁的长相、头发和衣着——那些照各人的人设图。用${inZh}写。`,
      `outfit：这个人此刻**和平常不一样**的地方，几个字，不超过 20 字——换了哪身衣服、头上戴了什么、身上有什么不同（淋湿、带伤、戴孝、沾了泥）。只点出不一样的那一样，不逐件描写款式、颜色和纹样，不写长相。照正文写：这一幕或它之前交代过的，照交代的；任务里的正文没有交代，用你的工具到这一章和前面的章节里去查。查过仍然没有另外交代，就是平常那一身：**outfit 留空**——平常的样子画的时候由人设图给出，不要在这里再写一遍。他这时穿的正是下面列出的某一身造型：在 look 里写那身造型的名字（没有列出造型，或者哪一身都不是：look 留空）。用${inZh}写。`,
      `setting：周围的环境，一两句，不超过 60 字——在哪（室内还是室外、什么样的地方）、身边有什么、什么时辰和天气、光从哪里来。照正文写，正文没有的不添。用${inZh}写。`,
      'people：画面里别的人的名字（没有就空）。place：设定里对得上的地点名（没有就空）。things：画面里出现的、设定里有的物件名。只写任务里列出来的名字——它们有设定图的会作为参考图带上；地点和物件长什么样，仍然要在 setting 里写出来，人长什么样不写。',
      ...(styled ? ['画风里对年代、形制有规定的（发式、服饰、建筑、器物属于哪个朝代、哪种式样），穿戴和环境里这些东西照它写；正文的写法与它不一样时以画风为准。'] : []),
      '只有读过这本书才懂的名字，写成它实际的样子；"不能出现"的东西不写。不写画风、镜头、画质。未成年的人物不写亲热和裸露的画面。',
    ],
    en: [
      `action: the instant shown, a sentence or two, 35 words at most — how this person holds themselves, what they are doing, what is in their hands; the expression in a word or two. Anybody else in the frame gets half a sentence: where they are, what they do. One instant held still: nothing of what led to it or follows, no speech, no thoughts, no similes, nothing the eye cannot see; nothing of anybody's features, hair or clothing — those go by each person's design sheet. Written in ${inEn}.`,
      `outfit: what is **not as usual** about this person in it, a few words, 12 at most — which other clothes, what is on their head, what is different about them (soaked, wounded, in mourning, muddied). Name the one thing that differs: no cut, colour or pattern piece by piece, nothing of their features. As the text has it: what the moment or the text before it says, as said; where the text in the task does not say, look it up with your tools in this chapter and the ones before. Where it still says nothing else, they are in what they usually wear: **leave outfit empty** — how they usually look is given by their design sheet when the picture is drawn, and is not written again here. Where what they wear is one of the looks listed below: put that look's name in look (no looks listed, or none of them: look stays empty). Written in ${inEn}.`,
      `setting: what is around them, a sentence or two, 40 words at most — where (indoors or out, what kind of place), what is near, the hour and the weather, where the light comes from. As the text has it; nothing the text does not have. Written in ${inEn}.`,
      'people: the names of anybody else in the frame (none: empty). place: the place of the bible it is set in (none: empty). things: the things of the bible that are in the frame. Only names listed in the task — the design art of those that have any goes along with the picture; what a place or a thing looks like is still to be said in setting, what a person looks like is not written.',
      ...(styled ? ['Where the art direction fixes a period or a form (which dynasty or fashion hair, dress, buildings and objects belong to), clothing and surroundings are written in that form; where the text says otherwise, the art direction holds.'] : []),
      'A name only a reader of the book understands is written as what it looks like; nothing from "must not appear". No words about art style, camera or image quality. Somebody who is not yet an adult is not written into a moment of intimacy or nudity.',
    ],
    keys: '"action": "", "outfit": "", "look": "", "setting": "", "people": [], "place": "", "things": []',
  }
}

/**
 * One of somebody's moments, made ready for its portrait: the director reads the text around it — handed with the
 * task, and the rest of the book with its tools — and says it as one frame. A moment as a card keeps it is told the
 * way the book tells it; a picture needs the instant, what they have on in it, and what is around them.
 * @param base.moment - the moment as kept: what it is called, where it is, how it is told.
 * @param base.passage - the paragraph of the chapter that tells it, with what stands before and after.
 * @param base.person - who the portrait is of: name, standing look, the looks (outfits) they have, how the chapter has them.
 * @param base.words - the language the frame is written in.
 */
export function momentShotTask(base: Base & { name: string; moment: string; chapter?: string; before?: string; passage?: string; after?: string; person: string; cast?: string; places?: string; ask?: string; artStyle?: string; avoid?: string[]; words: PromptLanguage }): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  const rules = shotRules(base.words, (base.artStyle?.trim() ?? '').length > 0)
  const told = base.passage !== undefined && base.passage.trim().length > 0
  return L(base.lang, `要给《${bare(base.title)}》里的「${base.name}」画一张立绘，画的是下面这一幕。请把它整理成一格画面：这一刻在做什么，此刻穿的和平常有什么不一样，周围是什么样。

## 这一幕
${base.moment}
${base.chapter !== undefined ? `\n## 它所在的这一章\n${base.chapter}\n` : ''}${base.before !== undefined && base.before.length > 0 ? `\n## 正文：这一幕之前（穿戴、地方多半在这里交代）\n${base.before}\n` : ''}${told ? `\n## 正文：讲到这一幕的地方\n${base.passage}\n` : '\n（任务里没有这一幕的正文：用 book_search / book_read 到书里找到它再写。）\n'}${base.after !== undefined && base.after.length > 0 ? `\n## 正文：紧接着\n${base.after}\n` : ''}
## 这个人
${base.person}
${base.cast !== undefined && base.cast.length > 0 ? `\n## 这一章里别的人（名字｜身份｜平常的样子）\n${base.cast}\n` : ''}${base.places !== undefined && base.places.length > 0 ? `\n## 设定里的地点与物件（这一幕前后写到的）\n${base.places}\n` : ''}${base.ask !== undefined && base.ask.length > 0 ? `\n## 作者对这一张的要求\n${base.ask}\n` : ''}${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

交回的内容：
${[...rules.zh, 'why：一句话，不超过 50 字——穿戴和环境是照正文哪里定的；正文没有另外交代穿戴、所以 outfit 留空的，也说一声。'].map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

只输出 JSON：{${rules.keys}, "why": ""}`, `A portrait of ${base.name} in "${bare(base.title)}" is to be drawn, of the moment below. Make one frame of it: what is being done in that instant, what they have on that is not as usual, what is around them.

## The moment
${base.moment}
${base.chapter !== undefined ? `\n## The chapter it is in\n${base.chapter}\n` : ''}${base.before !== undefined && base.before.length > 0 ? `\n## The text before the moment (what they wear and where they are is mostly said here)\n${base.before}\n` : ''}${told ? `\n## The text where the moment is told\n${base.passage}\n` : '\n(The text of the moment is not in the task: find it in the book with book_search / book_read, then write.)\n'}${base.after !== undefined && base.after.length > 0 ? `\n## The text right after\n${base.after}\n` : ''}
## The person
${base.person}
${base.cast !== undefined && base.cast.length > 0 ? `\n## Others of the chapter (name | who | how they usually look)\n${base.cast}\n` : ''}${base.places !== undefined && base.places.length > 0 ? `\n## Places and things of the bible (named around the moment)\n${base.places}\n` : ''}${base.ask !== undefined && base.ask.length > 0 ? `\n## What the author asks of this one\n${base.ask}\n` : ''}${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

To hand in:
${[...rules.en, 'why: one sentence, 35 words at most — where in the text the clothing and the surroundings are from; and, where the text says nothing else of what is worn and outfit is left empty, that it is so.'].map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

Output JSON only: {${rules.keys}, "why": ""}`)
}

type SceneBase = Base & { name: string; card: string; anchor?: string; record: string; scenes?: { title: string; chapter?: number; text: string }[]; direction?: string; avoid?: string[]; artStyle?: string; /** {@link portraitSceneTask}: the looks (outfits) they have, by name; and the language the frame is written in. */ looks?: string; words?: PromptLanguage }

function sceneList(lang: PromptLanguage, scenes: NonNullable<SceneBase['scenes']>): string {
  return scenes.map((scene, at) => L(lang, `${at + 1}. ${scene.title}${scene.chapter !== undefined ? `（第 ${scene.chapter} 章）` : ''}：${scene.text}`, `${at + 1}. ${scene.title}${scene.chapter !== undefined ? ` (chapter ${scene.chapter})` : ''}: ${scene.text}`)).join('\n')
}

/**
 * Find the moments a character is remembered by — the scenes a reader thinks of when they think of them — most their
 * own first. The director is an agent with the book to read: what the digests noted is where to look.
 * @param base.scenes - the ones kept so far, when they are being looked over again: those that still hold are kept (`was` says which), others added or dropped.
 * @param base.direction - what the author asks of the list, as guidance.
 */
export function portraitScenesTask(base: SceneBase): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  const styled = (base.artStyle?.trim() ?? '').length > 0
  const kept = base.scenes !== undefined && base.scenes.length > 0
  const asked = base.direction !== undefined && base.direction.length > 0
  const rules = scenePictureRules(styled)
  const zh = [
    '只从这本书里找：正文里真写了的一幕。上面的记载是各章收录时记下的，只是线索，而且可能只收录了一部分章节——没收录的章节里也可能有；定下来的每一幕，都要照原文那一段来写。书里还没有哪一幕算得上（这个人还没怎么出场），就如实说没有：scenes 留空，不要编。',
    '属于这个人的才算：换一个人就不成立；一眼认得出——在哪里、在做什么、手里拿着什么。书里公认的名场面优先于只是出场多的地方。有几幕算几幕：戏重的人可以多几幕，露面不多的人一两幕，不要凑数。',
    '按分量从重到轻排：第一幕最能代表这个人——没有别的要求时，立绘画的就是它。',
    ...(asked ? ['作者的要求是给你的引导：点名要的那一幕要有，并按他说的排；他不要的那一类不列；他说的是气氛、光线这一类，就照它来写。'] : []),
    ...(kept ? ['现在记着的那几幕：仍然成立的留下（was 写它原来的序号；作者没要求改的，scene 照原样），不成立的去掉，漏掉的补上，再一起按分量重排。'] : []),
    ...rules.zh,
    'title：几个字点明是哪一幕（如"葬花"）。chapter：它在第几章（数字）。scene：用这本书的语言写成一段，60–140 字——时间与地点、这个人在做什么、姿态与神情、手里和身边的东西、光线与气氛。why：一句话告诉作者为什么它是这个人的。',
  ]
  const en = [
    'From this book only: moments the text really has. The notes above were taken as chapters were digested — leads, and possibly of some chapters only; chapters not digested may have one too. Each moment settled on is written as that passage of the text has it. Where the book has no such moment yet (they have hardly been on the page), say so: leave scenes empty, invent nothing.',
    'Only what is this person\'s own: it would not hold with anybody else in it; it is told at a glance — where, doing what, holding what. A moment the book is known by comes before a place they are merely often in. As many as there are: several for somebody the book turns on, one or two for somebody seldom seen; none to make up a number.',
    'Ordered by weight, the heaviest first: the first stands for the person — it is what a portrait shows where nothing else is asked.',
    ...(asked ? ['What the author asks is your guide: a moment they name is there, placed as they say; a kind they do not want is left out; where they speak of mood or light, write by it.'] : []),
    ...(kept ? ['The ones kept so far: those that still hold stay (`was` gives the number each had; where the author asked for no change, scene is as it was), those that do not are dropped, missing ones are added, and all are ordered by weight anew.'] : []),
    ...rules.en,
    'title: which moment, in a few words ("Burying the flowers"). chapter: the chapter it is in (a number). scene: one paragraph in the language of the book, 40–100 words — time and place, what they are doing, bearing and expression, what is in their hands and around them, light and mood. why: one sentence telling the author why it is theirs.',
  ]
  return L(base.lang, `请为《${bare(base.title)}》里的「${base.name}」找出"名场面"：读过这本书的人一想到这个人，就会想起的那几幕。这个人的立绘从里面挑一幕来画。

## 人物
${base.card}

## 这个人的样子（立绘里会原样带上，不必复述）
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '（还没有写下来）'}

## 各章的收录里对这个人的记载
${base.record.length > 0 ? base.record : '（还没有哪一章的收录记到这个人——到原文里去找。）'}
${kept ? `\n## 现在记着的名场面（作者让你重新看一遍）\n${sceneList(base.lang, base.scenes!)}\n` : ''}${asked ? `\n## 作者的要求\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
${zh.map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

只输出 JSON：{"scenes": [{"title": "", "chapter": 0, "scene": "", "why": ""${kept ? ', "was": 0' : ''}}], "why": "一幕都没有时，说明为什么"}`, `Find the "signature scenes" of ${base.name} in "${bare(base.title)}": the moments somebody who has read the book thinks of when they think of this person. Their portrait is drawn from one of them.

## Character
${base.card}

## How they look (restated as is in the portrait; do not write it again)
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '(not written down yet)'}

## What the chapter digests noted of them
${base.record.length > 0 ? base.record : '(No chapter digest names them yet — look in the text.)'}
${kept ? `\n## The scenes kept so far (the author has you look them over)\n${sceneList(base.lang, base.scenes!)}\n` : ''}${asked ? `\n## What the author asks\n${base.direction}\n` : ''}${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
${en.map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

Output JSON only: {"scenes": [{"title": "", "chapter": 0, "scene": "", "why": ""${kept ? ', "was": 0' : ''}}], "why": "where there is none, why"}`)
}

/**
 * Write the moment one portrait shows, by what the author asked of that portrait: their words guide the pick — among
 * the moments the card keeps, or another of the book's — and the writing of it. Nothing is kept: it serves one picture.
 * @param base.scenes - the moments the card keeps, the one the author chose for this portrait first.
 * @param base.direction - what the author asked of this portrait.
 */
export function portraitSceneTask(base: SceneBase): string {
  const avoid = (base.avoid ?? []).join(base.lang === 'zh' ? '、' : ', ')
  const styled = (base.artStyle?.trim() ?? '').length > 0
  const kept = base.scenes !== undefined && base.scenes.length > 0
  const rules = scenePictureRules(styled)
  const shot = shotRules(base.words ?? base.lang, styled)
  const looks = base.looks !== undefined && base.looks.length > 0
  const zh = [
    '只从这本书里挑：正文里真写了的一幕，照原文那一段来写。上面的记载只是线索，而且可能只收录了一部分章节。',
    `作者的要求是给你的引导，按它来挑、来写：它点名了哪一幕，就是那一幕；它说的是光线、时间、天气、气氛、神态、姿态这一类，就挑合得上这个要求的那一幕，并照它来写${kept ? '——记着的第一幕合得上，就还用它，按要求调整；合不上，就在记着的别的几幕里、或者书里另挑一幕合得上的' : ''}；它不要某一类画面，就避开。它要的根本不是书里的哪一幕（比如素底、面向镜头的定妆照），就照它说的写成画面，不必硬套一幕。`,
    ...rules.zh,
    'title：几个字点明是哪一幕。chapter：它在第几章（数字；不是书里的一幕就写 0）。scene：用这本书的语言写成一段，60–140 字。why：一句话告诉作者为什么是这一幕，以及他的要求是怎么用上的。',
    '定下这一幕之后，再把它整理成一格画面（画的时候用的是这一格）——读它所在的那段正文和之前的正文来写：',
    ...shot.zh,
  ]
  const en = [
    'From this book only: a moment the text really has, written as that passage has it. The notes above are leads, and possibly of some chapters only.',
    `What the author asks is your guide — pick by it and write by it: a moment it names is the moment; where it speaks of light, time of day, weather, mood, expression or bearing, pick the moment that answers to it and write it so${kept ? ' — the first one kept where that answers, adjusted as asked; another of those kept, or of the book, where it does not' : ''}; a kind of picture it does not want is left aside. Where what it asks for is no moment of the book at all (a plain ground, facing the viewer), write the picture as asked and force no moment onto it.`,
    ...rules.en,
    'title: which moment, in a few words. chapter: the chapter it is in (a number; 0 where it is no moment of the book). scene: one paragraph in the language of the book, 40–100 words. why: one sentence telling the author why this moment, and how what they asked was used.',
    'The moment settled, make one frame of it (the picture is drawn from the frame) — read the passage it is in and the text before it:',
    ...shot.en,
  ]
  return L(base.lang, `要给《${bare(base.title)}》里的「${base.name}」画一张立绘。请按作者对这一张的要求，定下它画哪一幕，并写成画面。

## 人物
${base.card}

## 这个人的样子（立绘里会原样带上，不必复述）
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '（还没有写下来）'}
${looks ? `\n## 这个人的造型（另有人设图的几身穿戴）\n${base.looks}\n` : ''}
## 各章的收录里对这个人的记载
${base.record.length > 0 ? base.record : '（还没有哪一章的收录记到这个人——到原文里去找。）'}
${kept ? `\n## 人物卡上记着的名场面（第一幕是没有别的要求时立绘画的那一幕）\n${sceneList(base.lang, base.scenes!)}\n` : ''}
## 作者对这一张立绘的要求
${base.direction ?? ''}
${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

要求：
${zh.map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

只输出 JSON：{"title": "", "chapter": 0, "scene": "", ${shot.keys}, "why": ""}`, `A portrait of ${base.name} in "${bare(base.title)}" is to be drawn. By what the author asks of this one, settle which moment it shows, and write it as a picture.

## Character
${base.card}

## How they look (restated as is in the portrait; do not write it again)
${base.anchor !== undefined && base.anchor.length > 0 ? base.anchor : '(not written down yet)'}
${looks ? `\n## Their looks (outfits that have a design sheet of their own)\n${base.looks}\n` : ''}
## What the chapter digests noted of them
${base.record.length > 0 ? base.record : '(No chapter digest names them yet — look in the text.)'}
${kept ? `\n## The signature scenes kept on their card (the first is what a portrait shows where nothing else is asked)\n${sceneList(base.lang, base.scenes!)}\n` : ''}
## What the author asks of this one portrait
${base.direction ?? ''}
${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

Rules:
${en.map((rule, at) => `${at + 1}. ${rule}`).join('\n')}

Output JSON only: {"title": "", "chapter": 0, "scene": "", ${shot.keys}, "why": ""}`)
}

/**
 * Sort an author's loose notes on a character's picture: what is of the person
 * goes into how they look from now on, what is of this one picture directs
 * this picture and nothing else.
 * @param base.picture - the picture about to be drawn: a portrait, or a design sheet (which has no setting to give).
 * @param base.anchor - the visual anchor as it stands; absent when there is none yet, and one is to be written.
 */
/**
 * A picture's prompt, put together by the Studio, for a model that reads fewer tokens than it comes to: the director
 * writes the same picture in fewer words. What is handed in is counted against `tokens`.
 */
/**
 * The prompt of a picture, written out from the brief the Studio laid out for it: the same picture under the same
 * headings, in one language, each thing said once — and, where the image model reads only so much, within that.
 * @param base.to - the language the prompt is to be in.
 * @param base.tokens - the most the prompt may come to, where the model has a limit; `estimate` is what the brief comes to.
 * @param base.references - how many reference pictures go along (none: nothing may be said of any).
 * @param base.avoid - what must not appear, where that goes to the model apart from the prompt.
 */
/**
 * @param base.asked - what the author asked of this one picture, in their words: worked into the parts of the prompt it speaks of — what the brief says against it gives way — and not kept as a line of its own.
 */
export function imagePromptTask(base: Base & { brief: string; avoid: string[]; to: PromptLanguage; tokens?: number; estimate: number; model: string; references: number; asked?: string; /** What the author said is wanted of the reference pictures they gave, a line a picture ("图1：…"). */ given?: string }): string {
  const asked = base.asked?.trim() ?? ''
  const given = base.given?.trim() ?? ''
  // Either way the prompt is not the brief said again: something of the author's is worked into it.
  const working = asked.length > 0 || given.length > 0
  const avoid = base.avoid.join(base.lang === 'zh' ? '、' : ', ')
  const zhTo = base.to === 'zh' ? '中文' : '英文（English）'
  const enTo = base.to === 'zh' ? 'Chinese' : 'English'
  const fit = base.tokens !== undefined
  const share = fit ? Math.max(10, Math.floor(base.tokens! * 100 / base.estimate / 5) * 5) : 100
  return L(base.lang, `《${bare(base.title)}》要画一张图。下面是工坊排好的画图说明：一行一段，每段行首是它的名字（用途、画面、环境、构图、人物、某人此刻、地点、物件、这一张的要求、画风、参考图、不要出现——有哪段算哪段）。请把它写成发给绘图模型（${base.model}）的提示词：${working ? '画出来的应当是这张图，照作者对这一张的要求改过' : '画出来的应当是同一张图'}。${fit ? `这个模型一次只读得进大约 ${base.tokens} 个 token，超出的部分它看不到；这份说明现在大约 ${base.estimate} 个。` : ''}

## 画图说明
${base.brief}
${asked.length > 0 ? `\n## 作者对这一张的要求（说明里照原话带着它，在「这一张的要求」或「画面」那一行）\n${asked}\n` : ''}${given.length > 0 ? `\n## 作者给了参考图，并说了要它的什么（说明里在「参考图」那一段的括号里）\n${given}\n` : ''}${avoid.length > 0 ? `\n## 画面里不要出现（另外交给模型，不写进提示词；这里只是让你知道该绕开什么）\n${avoid}\n` : ''}
写成的提示词：${given.length > 0 ? `
${asked.length > 0 ? '0a' : '0'}. 作者对一张参考图说了要它什么的，那一样就由图来定，文字不再说它：
   - 在「人物」「物件」「地点」这些写样子的行里，把说到那一样的话都找出来，间接说到的也算——要图的颜色，就是每一处写颜色、漆色、锈色的话（"上过黑漆""露出铁胎""发乌"也是在说颜色）；要盖上的图案，就是每一处写盖面上刻着、画着什么的话；要发型，就是写头发怎么梳的话——删掉，在原处写"照图N"（"颜色照图1""盖面的图案照图1"）。
   - 原话说的内容不留：不写成"通体绿锈，颜色照图1"这样两头都占的。和那一样连在一起、离了它就说不通的半句一起去掉。
   - 作者没说到的——别的部位、形状、大小、材质——照说明原样。
   你看不到图：不要去写图里有什么。「参考图」那一段照旧留着，括号里作者的话也留着。改掉的原话，在 JSON 的 "replaced" 里逐条列出（说明里本来就没说到那一样时，它是空的）。` : ''}${asked.length > 0 ? `
0. 作者的要求不是另加的一行，是要改进提示词里去的。只动它说到的那几段；别的段——连同行首的段名（「人物「某某」」这样带着名字的照样带着）——照说明原样，不拆、不并、不改写：
   - 姿势、动作、神情、手里拿的东西：改「画面」；说明里没有「画面」这一段时（人设图就没有），改「构图」里说姿势的那半句，不要为它新加一段。
   - 地点、时间、天气、光线：改「环境」；说明里没有这一段时，只有作者的要求说到了这些，才加一段「环境」，放在「画面」后面。「画风」里的话不搬到别的段里去；说明要的是素净的背景而作者没说要别的，背景就还是素净的。
   - 景别、取景：改「构图」。长相、发式：改这个人「人物」那一行。穿戴和此刻的状态：改「此刻」；没有这一段时写在他「人物」那一行里。
   说明里原有的写法和作者的要求对不上的，以作者的要求为准，改掉——两种说法不要都留着（要求手里拿着东西，就不再写两手垂在身侧）。指着参考图的人（"见图1"）被要求改了某一处，在他那一行里写明这一处照文字、不照图。改完之后，提示词里没有「这一张的要求」这一段，也没有哪一行是把作者的话原样抄下来的。` : ''}
1. 分段和次序照原样：一段一行，行首保留那一段的名字；说明里没有的段不添${asked.length > 0 ? '（第 0 条说的除外）' : ''}。模型从头读起，所以这个次序不要动。
2. 全文用${zhTo}写，段名也是。说明里用别的语言写的内容译过来——人物的外貌常是一串英文短语——特征一样不丢：年纪、脸、发式、体型、衣着的款式颜色纹样、随身的东西。人名、地名、物名不译。
3. 同一件事只说一次。「画面」写这一刻：谁在做什么；「环境」写在哪、什么光线和气氛（没有这一段时这些在「画面」里）；「人物」写每个人长什么样；「此刻」写这个人这一刻和平常不一样的地方（换了的衣服、淋湿、带伤）。两处重复的留在该在的那一段；说法不一样时，动作和神情以「画面」为准，穿戴以「此刻」为准（没有这一段时以「画面」为准），长相以「人物」为准。
4. 只写眼睛看得见的。${working ? '除了作者的要求带来的改动，' : ''}不添说明里没有的内容，不改画的是什么；解释、客套和不影响画面的话去掉。
5. ${base.references > 0 ? `这张图带 ${base.references} 张参考图：「参考图」那一段留着——${base.to === 'zh' ? '「图1」「图2」' : '"Image 1", "Image 2"'}这样的编号和它各是谁一个不少；那一段里另说了哪些照图画、哪些照文字的，意思不变，可以写得更紧。` : '这张图不带参考图：提示词里不要出现“参考图”这一段，也不要有任何说到参考图的话。'}
6. ${avoid.length > 0 ? '提示词里不要有「不要出现」这一段，也不要把下面那份清单抄进来：它另有一栏交给模型，写进提示词反而会把那些东西招来。能靠把画面里实际有的东西说清楚来避开的，就在前面那样写（写明是明制的发髻，而不是写“没有辫子”）。' : '「不要出现」那一段，说明里有就留着，放在最后：能靠把画面里实际有的东西说清楚来避开的，就在前面那样写（写明是明制的发髻，而不是写“没有辫子”）；非点名不可的才列，短短一行。'}
7. ${fit ? `篇幅：现在量出来是 ${base.estimate}，要到 ${base.tokens} 以内——大约是现在的 ${share}%。放不下时先并重复的、去掉修饰，再压各段的长短；「画面」、每个人最认得出的特征和「画风」留到最后。不用自己数：交上来时会量，超了会告诉你超出多少。` : '篇幅：和说明差不多，或者更紧；不要为了显得丰富而添话。'}

只输出 JSON：
{"prompt": "写成的整段提示词"${given.length > 0 ? ', "replaced": ["被图代替的原话", "…"]' : ''}}`, `A picture is to be drawn for "${bare(base.title)}". Below is the brief the Studio laid out for it: a line a part, each under its name (purpose, the picture, the surroundings, framing, the people, what one of them wears in this moment, the place, the objects, what was asked of this one, the art direction, the reference pictures, what must not appear — whichever of them it has). Write it out as the prompt for the image model (${base.model}): ${working ? 'the picture it asks for is to be this picture, changed by what the author asked of it' : 'the picture it asks for is to be the same picture'}.${fit ? ` This model reads about ${base.tokens} tokens of a prompt and never sees what lies beyond; the brief comes to about ${base.estimate}.` : ''}

## The brief
${base.brief}
${asked.length > 0 ? `\n## What the author asked of this one (the brief carries it in their words, in the part "Asked of this one" or "The picture")\n${asked}\n` : ''}${given.length > 0 ? `\n## The author gave reference pictures, and said what is wanted of them (the brief carries it in the brackets of its part on the reference pictures)\n${given}\n` : ''}${avoid.length > 0 ? `\n## Must not appear in the picture (given to the model apart from the prompt, and not written into it; here for you to steer around)\n${avoid}\n` : ''}
The prompt you write:${given.length > 0 ? `
${asked.length > 0 ? '0a' : '0'}. Where the author said what is wanted of a reference picture, the picture settles that, and the words say it no more:
   - In the lines that say how something looks (a person's, an object's, a place's), find every phrase that speaks of it, also by the way — asked for the picture's colour: every phrase on colour, paint, rust ("once lacquered black", "the bare iron showing" say a colour too); for what is on the lid: every phrase on what is engraved or painted there; for the hair: how the hair is worn — and take it out, writing "as in Image N" in its place ("the colour as in Image 1", "what is on the lid as in Image 1").
   - What the phrase said does not stay: never "green with rust, the colour as in Image 1". A clause that hangs on it and makes no sense without it goes with it.
   - What the author did not speak of — other parts, the shape, the size, the material — stays as the brief has it.
   You do not see the pictures: do not write what is in them. The part on the reference pictures stays, with the author's words in its brackets. List the phrases you took out, one by one, under "replaced" in the JSON (empty where the brief said nothing of it to begin with).` : ''}${asked.length > 0 ? `
0. Has what the author asked worked into it — not added as a line. Only the parts it speaks of are touched; every other part — with its name as the brief has it (a person's line keeps the person's name) — stays as the brief has it: not split, not merged, not reworded.
   - Pose, action, expression, what is in the hands: in "The picture"; where the brief has no such part (a design sheet has none), in the half of the framing that says how they stand — no part is added for it.
   - Place, time, weather, light: in "Surroundings"; where the brief has no such part, one is added — after the picture — only if the author speaks of these. Nothing of the art direction is moved into another part; where the brief asks for a plain ground and the author asked for nothing else, the ground stays plain.
   - How close and from where: in the framing. Face and hair: in that person's line. What is worn and the state they are in: in "just then"; in the person's line, with no such part.
   Where the brief says otherwise, what the author asked holds and the brief's wording goes — never both (asked to hold something, the hands are no longer "at the sides"). Of somebody who is pointed to by a reference picture ("see Image 1") and asked to differ from it in something, their line says that this goes by the words, not the picture. Once it is worked in, the prompt has no part "Asked of this one", and no line that is the author's sentence copied out.` : ''}
1. Keeps the parts and their order: a line a part, each under its name; no part is added that the brief does not have${asked.length > 0 ? ' (but for what 0 says)' : ''}. The model reads from the top, so the order stays.
2. Is in ${enTo} throughout, the names of the parts too. What the brief has in another language is translated — how a person looks is often a run of English phrases — with no feature lost: age, face, hair, build, the cut, colour and pattern of what they wear, what they carry. Names of people, places and things are not translated.
3. Says each thing once. "The picture" has the moment: who does what; "Surroundings" has where, in what light and mood (with no such part, the picture has these); the people's lines have how each of them looks; "just then" has what is not as usual about that person in it (other clothes, soaked, wounded). What is said in two parts stays in the one it belongs to; where they differ, action and expression go by the picture, what is worn by "just then" (with no such part, by the picture), looks by the person's line.
4. Says only what the eye can see. ${working ? 'But for what the author asked, it adds' : 'Adds'} nothing the brief does not have and does not change what the picture shows; explanations, courtesies and words that change nothing in the picture go.
5. ${base.references > 0 ? `${base.references} reference picture(s) go along with this one: the part on them stays — every number (${base.to === 'zh' ? '图1, 图2' : 'Image 1, Image 2'}) with who or what it shows; where the part also says what is to follow a picture and what the words, that too — tightened if you like, with nothing of its meaning lost.` : 'No reference picture goes along with this one: the prompt has no part on reference pictures, and says nothing of any.'}
6. ${avoid.length > 0 ? 'Has no part on what must not appear, and none of the list below copied into it: that goes to the model in a field of its own, and written into the prompt it would call those things up. Where saying plainly what is there keeps a thing out, say that earlier on (the Ming topknot, not "no queue").' : 'Keeps the part on what must not appear where the brief has one, last: where saying plainly what is there keeps a thing out, say that earlier on (the Ming topknot, not "no queue"); only what has to be named is listed, in one short line.'}
7. ${fit ? `Its length: the brief measures ${base.estimate} and the prompt has to come to ${base.tokens} or less — about ${share}% of that. Where it does not fit, merge what is said twice and drop ornament first, then shorten the parts; the picture, what each person is most known by and the art direction are the last to give way. No need to count: what you hand in is measured, and you are told by how much it is over if it is.` : 'Its length: about that of the brief, or tighter; nothing is added to make it seem richer.'}

Output JSON only:
{"prompt": "the whole prompt, written out"${given.length > 0 ? ', "replaced": ["a phrase the picture stands in for", "…"]' : ''}}`)
}

export function lookNotesTask(base: Base & { card: string; appearance?: string; legacy?: string; negative?: string; notes: string; picture: 'portrait' | 'sheet'; avoid?: string[]; artStyle?: string }): string {
  const avoid = (base.avoid ?? []).join(', ')
  const zhPicture = base.picture === 'sheet'
    ? '人设图（三视图）：同一个人的全身站姿画三次——正面、侧面、背面，素底，表情平静。它没有背景、天气、时间、动作和镜头，这类想法这张图用不上。'
    : '立绘：画的是这个人在书里的一幕，人物是主体。画哪一幕、什么背景、时间、天气、光线、姿势和神态，都可以由作者的想法来引导——只属于这一张的想法会交给导演，由他照着去挑、去写这一幕。'
  const enPicture = base.picture === 'sheet'
    ? 'a design sheet (turnaround): the same person standing, full body, three times — front, side, back — on a plain ground, with a neutral expression. It has no setting, weather, time of day, action or camera: ideas of that kind have no place in it.'
    : 'a portrait: it shows the person in a moment of the book, the person being the subject. Which moment, what setting, time of day, weather, light, pose and expression — the author\'s ideas may guide all of it: what is of this one picture is handed to the director, who picks and writes the moment by it.'
  const has = base.appearance !== undefined && base.appearance.trim().length > 0
  const legacy = base.legacy !== undefined && base.legacy.trim().length > 0
  return L(base.lang, `作者在给《${bare(base.title)}》的一个人物画图之前，随手写下了一些想法。它们混在一起：有的说的是这个人本身，有的只是这一张图想要的样子。请把它们分开。

## 人物
${base.card}

## 这个人现在的外貌（写手照它写，每一张有此人的图也照它画）
${has ? base.appearance!.trim() : '（还没有——请根据上面的人物卡和作者的想法写出来）'}
${legacy ? `\n以前另写给绘图模型的短语（现在并进外貌；它和外貌说法不一样时以它为准）：${base.legacy!.trim()}\n` : ''}${base.negative !== undefined && base.negative.length > 0 ? `\n这个人身上不要画出：${base.negative}\n` : ''}
## 现在要画的这一张
${zhPicture}

## 作者随手写的想法
${base.notes}
${artSection(base.lang, base.artStyle)}
## 这本书的画面里不能出现
${avoid.length > 0 ? avoid : '（无特别限制）'}

怎么分：
1. **属于这个人本身的**——以后每一张图里都该是这样：长相、年龄感、体型、肤色、发色与发式、疤痕胎记、平常的衣着（款式、材质、颜色、新旧）、随身的标志物。把它们写进外貌：原有的内容保留，只改动作者这次说到的地方；和原来的写法冲突时，以作者这次说的为准。
2. **只属于这一张图的**——换一张图就不一定是这样：时间、天气、季节、地点与背景、光线、姿势与动作、此刻的神态、构图与镜头、这一次临时穿戴或拿在手里的东西、气氛。它们不进外貌，写进 picture。
3. 分不清时看作者的说法："这张 / 这次 / 这幅 / 这里"说的是这一张图；"总是 / 平时 / 一直 / 常年"，或者没有限定、说的又是长相和平常衣着的，是这个人本身。
4. 现在要画的这一张用不上的想法（见上面对这一张图的说明），不要硬塞进 picture，列进 unused。
5. 作者没有说到的，不要替他添。${(base.artStyle?.trim() ?? '').length > 0 ? `
6. 新写进外貌的部分，形制要合这本书的画风：画风里对年代、形制有规定的（发式、服饰属于哪个朝代、哪种式样），就写成那种形制下具体的样子。作者这次明说要的样子与画风不一样时，以作者这次说的为准。` : ''}

appearance 的写法：用${base.language}写的一段话，只写看得见的；不写性格、身份、经历，不用机构名、教派、头衔之类的词代替描写（要写成它实际的形状和材质）；不写动作、姿势、此刻的表情，不写画风、光线、镜头、画质。没有任何想法属于这个人本身、而外貌已经有了时，appearance 原样照抄${legacy ? '（旧短语里有、外貌里没有的特征仍然并进来）' : ''}。

只输出 JSON：
{"appearance": "分完之后的整段外貌：原有的写法照旧，作者这次说到的那几点写进去——只写他说的，没说的材质、新旧、来历之类不要添", "negative": "这个人身上不该画出的东西（逗号分隔）；没有变化就照抄原来的，没有就留空", "picture": "只属于这一张图的要求：用${base.language}、尽量用作者自己的话写成一句，只写作者说到的，不要添构图、景别这类他没说的；没有就留空", "kept": ["进了这个人外貌的每一点，用作者的话，几个字一条"], "once": ["只用在这一张图上的每一点，几个字一条"], "unused": ["这一张图用不上的每一点，几个字一条"]}`, `Before drawing a character of "${bare(base.title)}", the author jotted down some ideas. They are mixed: some are of the person, some only of how this one picture should be. Sort them.

## Character
${base.card}

## How they look as it stands (the writer writes them by it, and every picture of them is drawn by it)
${has ? base.appearance!.trim() : '(nothing yet — write it from the card above and the author\'s ideas)'}
${legacy ? `\nPhrases kept for image models before (now folded into the appearance; where they and the appearance differ, they hold): ${base.legacy!.trim()}\n` : ''}${base.negative !== undefined && base.negative.length > 0 ? `\nNever drawn on them: ${base.negative}\n` : ''}
## The picture about to be drawn
${enPicture}

## What the author jotted down
${base.notes}
${artSection(base.lang, base.artStyle)}
## Must not appear in this book's pictures
${avoid.length > 0 ? avoid : '(nothing in particular)'}

How to sort:
1. **Of the person** — true in every picture of them from now on: features, apparent age, build, skin, hair colour and how it is worn, scars and marks, what they usually wear (cut, material, colour, wear), what they always have about them. Write these into the appearance: what it has stays, and only what the author spoke of this time changes; where the two differ, what the author says now holds.
2. **Of this one picture** — not necessarily so in the next: time of day, weather, season, place and setting, light, pose and action, a passing expression, framing and camera, what is worn or held this once, mood. These do not go into the appearance: they go into picture.
3. Where it is hard to tell, go by how the author put it: "this one / this time / here" is of the picture; "always / usually / all year", or features and usual clothing said without any such word, are of the person.
4. Ideas the picture about to be drawn has no place for (see what it is, above) are not forced into picture: list them under unused.
5. Add nothing the author did not speak of.${(base.artStyle?.trim() ?? '').length > 0 ? `
6. What is newly written into the appearance is in the form the book's art direction fixes: where it names a period or a form of dress (which dynasty or fashion hair and clothing belong to), write what that form looks like. Where the author asks outright for something else this time, the author holds.` : ''}

The appearance: one paragraph in ${base.language}, only what can be seen; no personality, role or history, and no name of an institution, an order or a title standing in for a description (write its actual shape and material); no action, pose or passing expression, no words about art style, light, camera or image quality. Where no idea is of the person and there is an appearance already, appearance is that, copied as it stands${legacy ? ' (with what the older phrases have and it lacks folded in all the same)' : ''}.

Output JSON only:
{"appearance": "the whole appearance once sorted: what it had as it was, with the points the author spoke of this time written in — only what the author said, and no material, wear or history they did not speak of", "negative": "what must not be drawn on them (comma-separated); copy what there is where nothing changes, leave empty where there is none", "picture": "what is asked of this one picture: one line in ${base.language}, in the author's own words as far as it goes — only what the author spoke of, no framing or shot size added; empty where there is nothing", "kept": ["each point that went into how the person looks, in the author's words, a few words each"], "once": ["each point used for this one picture only, a few words each"], "unused": ["each point this picture has no place for, a few words each"]}`)
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

// ───────────────────────────── translating ─────────────────────────────

/** A language as a translator is told of it; `undefined`: whatever the text is in. */
const tongue = (lang: PromptLanguage, language: string | undefined): string => (language !== undefined ? languageName(language) : L(lang, '原文的语言（看正文）', 'the language the text is in'))

/**
 * The translator's standing instructions: the same for every chapter of a book being translated one way, so the
 * head of every request is the same and a provider can keep it.
 */
export function translatorSystem(base: { lang: PromptLanguage; title: string; from?: string; to: string; direction?: string }): string {
  const [from, to] = [tongue(base.lang, base.from), languageName(base.to)]
  return L(base.lang, `你是一位文学译者，正在把长篇小说《${bare(base.title)}》从${from}译成${to}。编辑每次给你一章（或一章的一段）、这一章用到的译名和它们是什么，你交回可以直接付印的译文。

【译文的规矩】
1. 只输出译文。给了标题时，第一行是标题的译文，以“# ”开头，空一行后是正文；没给标题就直接是正文。不要译注、解释、括号说明，也不要“以下是译文”之类的话。
2. 原文的每一段都译出来，段落照原文分；不增、不删、不概括，不改动发生了什么、谁说了什么。
3. 译文读起来是用${to}写成的小说：语序、标点、称谓、度量和习语照${to}的习惯；人物各自说话的口吻、叙述的节奏、原文的文风留着。
4. 译名表里的词照表译，每一次都一样。表里注明了这个人是谁、这样东西是什么——代词、敬称、上下文里的说法要和它对得上。
5. 表里没有的专名（人名、地名、家族与组织、器物、这本书自己的说法）：定一个译法，全章一致；译文结束后另起一行写“=====TERMS=====”，下面给一个 JSON 数组列出它们：[{"source":"原文里的写法","target":"译法","kind":"person|place|house|thing|term","note":"是什么，几个字"}]。没有新的就不写这一段。
6. 原文里的 Markdown 原样保留：空行分段、分隔线；图片行（![说明](路径)）留在原处，括号里的路径一个字都不改，方括号里的说明照译。${base.direction !== undefined && base.direction.trim().length > 0 ? `\n\n【作者对译文的要求】\n${base.direction.trim()}` : ''}`, `You are a literary translator, translating the novel "${bare(base.title)}" from ${from} into ${to}. Your editor hands you a chapter at a time (or a stretch of one) with the renderings of the names it uses and what each of them is; you hand back a translation that could go to print as it is.

RULES
1. Output the translation only. Where a title is given, the first line is the title translated, beginning with "# ", then a blank line, then the text; where none is given, the text at once. No translator's notes, no explanations, no bracketed asides, no lead-in.
2. Every paragraph of the original is translated, and paragraphs fall where the original's do. Nothing added, nothing left out, nothing summed up; what happens and who says what is not changed.
3. It reads as a novel written in ${to}: word order, punctuation, forms of address, measures and idiom are ${to}'s; each person's way of speaking, the pace of the telling and the manner of the original are kept.
4. A word in the glossary is rendered as the glossary has it, every time. The glossary says who a person is and what a thing is — pronouns, honorifics and how they are spoken of go by that.
5. A proper name the glossary does not have (a person, a place, a house or an organisation, a thing, a word of this book's own): settle a rendering and keep to it through the chapter; after the translation, on a line of its own, write "=====TERMS=====" and under it a JSON array of them: [{"source":"as the original writes it","target":"the rendering","kind":"person|place|house|thing|term","note":"what it is, in a few words"}]. Leave the section out where there is none.
6. The original's Markdown is kept as it is: blank lines between paragraphs, rules; a picture's line (![caption](path)) stays where it is — the path in the round brackets is not changed by a letter, the caption in the square ones is translated.${base.direction !== undefined && base.direction.trim().length > 0 ? `\n\nWHAT THE AUTHOR ASKS OF THE TRANSLATION\n${base.direction.trim()}` : ''}`)
}

/** One chapter — or one stretch of a long one — to translate. */
export function translateTask(base: {
  lang: PromptLanguage
  /** The chapter's title, where this stretch begins the chapter. */
  title?: string
  text: string
  /** The glossary's terms that occur in this stretch, one a line. */
  terms: string
  /** How the translation ran until here: the end of the chapter before, or of the stretch before. */
  before?: string
  /** `k/n` where the chapter comes in stretches. */
  part?: string
}): string {
  return L(base.lang, `${base.terms.length > 0 ? `## 译名表（这一段用到的）\n${base.terms}\n\n` : ''}${base.before !== undefined && base.before.length > 0 ? `## 译文到这里为止的结尾（接着它的口吻往下译，不要重复它）\n${base.before}\n\n` : ''}## 要译的${base.part !== undefined ? `（这一章的第 ${base.part} 段${base.title === undefined ? '；标题已经译过，不要再写标题' : ''}）` : ''}
${base.title !== undefined ? `标题：${base.title}\n\n` : ''}${base.text}`, `${base.terms.length > 0 ? `## Glossary (the terms this stretch uses)\n${base.terms}\n\n` : ''}${base.before !== undefined && base.before.length > 0 ? `## How the translation ends so far (go on in its voice; do not repeat it)\n${base.before}\n\n` : ''}## To translate${base.part !== undefined ? ` (stretch ${base.part} of this chapter${base.title === undefined ? '; the title is translated already — write none' : ''})` : ''}
${base.title !== undefined ? `Title: ${base.title}\n\n` : ''}${base.text}`)
}

/** Settling how the book's names are to be written in another language, before a line of it is translated. */
export function termsSystem(base: { lang: PromptLanguage; title: string; from?: string; to: string }): string {
  const [from, to] = [tongue(base.lang, base.from), languageName(base.to)]
  return L(base.lang, `你在为长篇小说《${bare(base.title)}》的${to}译本定译名（原文：${from}）。译名一旦定下，全书每一章都照它译，所以要定得住。

【怎么定】
1. 人名照${to}读者读这类小说时习惯的写法：有通行译法的用通行的；没有的，只是名字的就照读音转写（一家人的姓一个写法），有意思的绰号、外号、称谓按意思译。
2. 地名、家族与组织、器物、这本书自己的说法：意思要紧的按意思译，只是个名字的照读音；一样东西一个译法。
3. 别名、称呼各算一条，和本名的译法对得上（本名怎么写，带着它的称呼里就怎么写）。
4. 已经定下的照旧，不要再给；只给还没定的。
5. note 写给译者看：这是谁、是男是女、是什么东西——几个字。

只输出 JSON：{"terms":[{"source":"原文里的写法，一字不差","target":"译法","kind":"person|place|house|thing|term","note":""}]}`, `You are settling the names for the ${to} translation of the novel "${bare(base.title)}" (original: ${from}). A rendering, once settled, is what every chapter of the book is translated by — so it has to hold.

HOW
1. People's names as readers of such novels in ${to} are used to seeing them: the accepted rendering where there is one; otherwise a name that is only a name is written by its sound (one spelling for a family's name), and a nickname, epithet or form of address that means something is rendered by its meaning.
2. Places, houses and organisations, things, the book's own words: by meaning where the meaning matters, by sound where it is only a name; one rendering a thing.
3. Another name or a form of address is a term of its own, and agrees with the rendering of the name it goes with.
4. What is settled already stands and is not given again; only what is not settled yet.
5. The note is for the translator: who this is, a man or a woman, what kind of thing — a few words.

Output JSON only: {"terms":[{"source":"as the original writes it, to the letter","target":"the rendering","kind":"person|place|house|thing|term","note":""}]}`)
}

/** What is to be given a rendering: names off the book's cards, or a stretch of its text to find the names in. */
export function termsTask(base: { lang: PromptLanguage; settled: string; names?: string; text?: string; direction?: string }): string {
  return L(base.lang, `${base.settled.length > 0 ? `## 已经定下的（和它们保持一致，不要再给）\n${base.settled}\n\n` : ''}${base.direction !== undefined && base.direction.trim().length > 0 ? `## 作者的要求\n${base.direction.trim()}\n\n` : ''}${base.names !== undefined ? `## 要定译名的（设定里的人物和条目；“又叫”的每个写法也各给一条）\n${base.names}` : `## 一段正文：找出里面还没定译名的专名（人名和称呼、地名、家族与组织、器物、这本书自己的说法），各定一个\n${base.text ?? ''}`}`, `${base.settled.length > 0 ? `## Settled already (agree with these; do not give them again)\n${base.settled}\n\n` : ''}${base.direction !== undefined && base.direction.trim().length > 0 ? `## The author asks\n${base.direction.trim()}\n\n` : ''}${base.names !== undefined ? `## To settle (people and entries of the bible; each spelling under "also" gets a term of its own)\n${base.names}` : `## A stretch of the text: find the proper names in it that have no rendering yet (people and what they are called, places, houses and organisations, things, the book's own words) and settle one for each\n${base.text ?? ''}`}`)
}

/**
 * What a writer is asked last when a chapter is written in parts (see `writerTask`'s `how`): a chapter whose plan
 * has beats is written beat by beat over several requests — each with the same material and the text so far, each
 * told which beats are its own and where to stop.
 * @param base.at - which part this is, from 0; `of`: how many there are.
 * @param base.from - the first beat of this part, from 0; `beats`: the beats of this part, in a line each; `all`: how many the chapter has.
 * @param base.whole - the length asked for the chapter, where one is: the length said above is then this part's.
 * @param base.usual - with no length asked for: how long the book's written chapters run, for the writer's sense of this part's share.
 */
export function partHow(base: Base & { at: number; of: number; from: number; beats: string[]; all: number; whole?: number; usual?: number }): string {
  const first = base.from + 1
  const last = base.from + base.beats.length
  const which = base.beats.length > 1 ? `${first}–${last}` : String(first)
  const list = base.beats.map((beat, index) => `${base.from + index + 1}. ${beat}`).join('\n')
  const final = base.at === base.of - 1
  const length = base.whole !== undefined
    ? L(base.lang, `整章要求约 ${base.whole} 字；上面的篇幅说的是这一次。`, `The chapter is asked to run to about ${base.whole} words; the length above is this part's.`)
    : L(base.lang,
        `上面说的篇幅是对整章说的：这一次只是其中 ${base.all} 个节拍里的 ${base.beats.length} 个${base.usual !== undefined ? `（本书已写的章节平均约 ${base.usual} 字，是整章的数）` : ''}，把这几个节拍写足就够，不要把别的节拍的篇幅也写进来。`,
        `What is said of length above is said of the whole chapter: this part is ${base.beats.length} of its ${base.all} beats${base.usual !== undefined ? ` (the chapters written so far run to about ${base.usual} words each — the whole of one)` : ''}; give these beats their room, and no more than theirs.`)
  return L(base.lang,
    `这一章按章纲的节拍分 ${base.of} 次写，这是第 ${base.at + 1} 次。${length}\n${base.at > 0 ? '从“本章已有正文”的最后一个字之后接着写，不要重复已有内容，衔接处不能看出缝。' : '从本章第一句开始写。'}这一次只写章纲里的第 ${which} 个节拍：\n${list}\n${final ? '写完这几个节拍，这一章就到了结尾：照常收住。' : `写到第 ${last} 个节拍结束就停——后面的节拍留给下一次：不要提前写它们，也不要给这一章收尾。`}直接输出正文。`,
    `This chapter is written in ${base.of} parts, by the beats of its outline, and this is part ${base.at + 1}. ${length}\n${base.at > 0 ? 'Pick up right after the last word of "This chapter so far", repeat nothing, and leave no seam.' : 'Start from the first sentence of the chapter.'} Write beat${base.beats.length > 1 ? 's' : ''} ${which} of the outline, and no other:\n${list}\n${final ? 'With these beats the chapter comes to its end: close it as it should close.' : `Stop where beat ${last} ends — the beats after it are for the next part: do not write them ahead, and do not bring the chapter to a close.`} Output the prose only.`)
}

// ───────────────────────────── a chapter written by the writer as an agent ─────────────────────────────

/** The tools a writer at work as an agent writes a chapter with, by name. */
export interface ComposeTools { write: string; read: string; edit: string; done: string }

/**
 * How the writer works where it writes a chapter as an agent (`composeChapter`): nobody prepared its material — it
 * reads in the book for itself, hands the text in with a tool, and goes over what it handed in as often as it sees
 * fit before it calls the work done. Its persona is the writer's own (`writerSystem`): the trade and the style hold.
 */
export function composeRules(base: Base & ComposeTools): string {
  return L(base.lang, `这一次你作为 agent 干这件活：材料没有人替你备，你自己读书，自己写，自己改，改到满意再交稿。

1. 任务里已经给了：本章章纲和当初定下的思路、作品信息、标了“核心”的设定、和上一章衔接处的原文。别的都在书里——更早的章节、人物卡、设定条目、线索、各章的记忆——用 book_read、book_search 去读。读到这一章用得上为止：谁出场就读谁的卡，章纲提到的事就去找它当初是怎么写的；不必通读全书。
2. 正文用 ${base.write} 提交：text 里只有正文——没有标题、章节号、说明、括号批注。一次交不下，后面几次带 append=true，接在已交的后面。上面“写作纪律”里说的“只输出正文”，指的就是你提交的这份正文。
3. 交上来之后，正文是你手里的稿子：${base.read} 看它现在的样子；${base.edit} 改其中一处（find 是要改的原句，从现在的正文里逐字照抄，只能对上一处；replace 是改成的样子，留空就是删掉）；整段、整章不满意，就用 ${base.write} 重交。改几次都行，以最后的样子为准。
4. 满意了调用 ${base.done}，用一两句话说你读了什么、怎么取舍的。调用之后这件活就结束了。
5. 正文只通过工具交：写在回复里的不会进这一章。`, `This time you work as an agent: nobody prepared your material — you read in the book yourself, write, go over what you wrote, and hand it in when you are satisfied.

1. The task gives you the chapter's outline and the thinking it was planned with, the book's particulars, the core entries of its world, and the text where this chapter joins the one before. Everything else is in the book — earlier chapters, character cards, entries of the world, threads, what each chapter left in memory: read it with book_read and book_search, as far as this chapter needs. Whoever is in it, read their card; whatever the outline refers to, find how it was written. The whole book need not be read.
2. Hand the text in with ${base.write}: \`text\` holds the prose and nothing else — no title, no chapter number, no explanation, no bracketed notes. Where one call cannot hold it, the later calls say append=true and go on from what is handed in. "Output the prose only", among your rules above, is said of this text.
3. Once handed in, the text is your draft to work on: ${base.read} shows it as it stands; ${base.edit} changes one place (\`find\` is the sentences to change, copied word for word from the text as it stands, and has to stand in one place only; \`replace\` is what they become — empty takes them out); a stretch or the whole of it you are not satisfied with is handed in again with ${base.write}. As many times as you see fit: what stands at the end is the chapter.
4. When you are satisfied, call ${base.done} and say in a sentence or two what you read and how you decided. That ends the work.
5. The text goes in through the tools only: what is written in a reply is no part of the chapter.`)
}

/** What a writer at work as an agent is asked last, in place of "output the prose" (see `writerTask`'s `how`). */
export function composeHow(base: Base & ComposeTools & { continuing: boolean }): string {
  return L(
    base.lang,
    base.continuing
      ? `你是在续写：从“本章已有正文”的最后一个字之后接着写，不要重复已有内容，衔接处不能看出缝。先读你需要的；续写的部分用 ${base.write} 提交（只交新写的），要改就改，满意了调用 ${base.done}。`
      : `从本章第一句开始写。先读你需要的；整章正文用 ${base.write} 提交，要改就改，满意了调用 ${base.done}。`,
    base.continuing
      ? `You are continuing: pick up right after the last word of "This chapter so far", repeat nothing, and leave no seam. Read what you need first; hand the continuation in with ${base.write} (what is new, and that only), change what you would change, and call ${base.done} when you are satisfied.`
      : `Start from the first sentence of the chapter. Read what you need first; hand the whole chapter in with ${base.write}, change what you would change, and call ${base.done} when you are satisfied.`,
  )
}

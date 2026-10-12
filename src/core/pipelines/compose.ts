// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter written by the writer as an agent.
 *
 * The other two ways of writing a chapter end in one request: the writer is
 * handed its material — packed by rule, or prepared by the planner — and
 * answers with the chapter. Here nobody prepares anything. The writer is
 * given the work and what it stands on whoever does it (the chapter's plan
 * and what it was planned with, the book, the core of its world, where the
 * chapter has to join), and the tools to read the book with. It reads what
 * the chapter needs, hands the text in with a tool, and — the text now being
 * its own draft to work on — reads it over, changes a place, changes another,
 * or hands the whole of it in again, as often as it sees fit. What stands
 * when it calls the work done is the chapter.
 *
 * It is the writer's model that does this, under the writer's own rules and
 * the book's style: a way of writing, not another role. A writer whose model
 * cannot run as an agent, or whose run comes to nothing, does not leave the
 * chapter unwritten: whoever asked writes it one of the other ways and says so.
 */
import { MAIN_LINE, type MaterialUsed, type ModelRoute } from '../../shared/types'
import { clip, countWords, fuzzyFind, occurrences, proseOnly } from '../../shared/text'
import type { ContextPack } from '../context'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { bookTools, stepLine } from '../crew'
import type { LlmImage } from '../llm'
import type { LocatedChapter } from '../project'
import { composeHow, composeRules } from '../prompts'
import { L, promptLanguage } from '../render'
import { argInt, argText, type RoleOutcome, type RoleTool } from '../roles'
import { errorMessage, isAbort } from '../util/async'

/** The tools the chapter is handed in and worked on with. */
export const COMPOSE_TOOLS = { write: 'chapter_write', read: 'chapter_read', edit: 'chapter_edit', done: 'chapter_done' } as const

/** Tool calls the writer may make before it is told to hand in: reading in the book, the chapter, and going over it. */
const STEPS = 60

export interface ComposeAsk {
  chapter: LocatedChapter
  mode: 'draft' | 'continue'
  brief?: string
  /** The writer's model. */
  route: ModelRoute
  /** The writer's own rules and the book's style (`writerSystem`). */
  system: string
  /**
   * The task, put together by whoever asks — who knows the length, the pictures, the notes: given what the work
   * stands on, how the text is to be handed in, and whether what the chapter was planned with went along (`keyed`).
   */
  task: (context: string, how: string, keyed: boolean) => string
  images?: LlmImage[]
  /** The length asked for, where one was: what is handed in is held against it, and the writer told where it stands. */
  target?: number
  /** What models add around prose against instructions, taken off (a heading, a fence). */
  clean: (text: string) => string
  /** Written to be compared: nothing is shown of it as it is written. */
  dry: boolean
}

export interface Composed {
  /** The chapter — or, of a chapter gone on with, what was added — as it stood when the writer was done. */
  text: string
  /** What the work stood on: what the writer was given beside its tools. */
  pack: ContextPack
  /** The task as the writer read it. */
  handed: string
  used: Omit<MaterialUsed, 'tokens'>
}

function around(text: string, at: number, length: number, margin = 80): string {
  const from = Math.max(0, at - margin)
  const to = Math.min(text.length, at + length + margin)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/**
 * Have the writer write a chapter as an agent.
 * @throws when the writer's model cannot run as an agent, or its run ended with no text handed in — whoever asked
 *   then writes the chapter another way. An abort is thrown as it is.
 */
export async function composeChapter(core: NovelCore, runtime: ProjectRuntime, ask: ComposeAsk, task: TaskContext): Promise<Composed> {
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const names = COMPOSE_TOOLS
  const roles = core.roles
  if (roles === undefined || !roles.can(ask.route)) {
    throw new Error(L(lang, `写手的模型 ${ask.route.model} 是工坊直连的接口，当不了 agent`, `the writer's model ${ask.route.model} is an endpoint the Studio calls directly and cannot run as an agent`))
  }
  const base = { lang, language: manifest.language, title: manifest.title }
  const continuing = ask.mode === 'continue'
  const chapter = ask.chapter
  // What the work stands on whoever does it — the book, the core of its world, the chapter's plan and what it was
  // planned with, where it has to join, the text gone on from — and nothing chosen beside: the writer reads the rest.
  const pack = await core.pack(runtime, ask.route, {
    purpose: continuing ? 'continue' : 'draft',
    chapter,
    ...(ask.brief !== undefined ? { brief: ask.brief } : {}),
    includeChapterText: continuing,
    chosen: { chapters: [], summaries: [], excerpts: [], people: [], world: [], threads: [], words: {} },
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const prompt = ask.task([pack.stable, pack.rest].filter(part => part.length > 0).join('\n\n'), composeHow({ ...base, ...names, continuing }), pack.included.intent !== undefined)

  // ── the draft in the writer's hands ──
  let working = ''
  let drafts = 0
  let edits = 0
  let handedIn: string | undefined
  /** Told once that the text is well short of the length asked for: said again by calling it done, it stands. */
  let warned = false
  const words = (): number => countWords(proseOnly(working))
  const short = (): boolean => ask.target !== undefined && words() < ask.target * 0.85
  const against = (): string => ask.target === undefined ? ''
    : short() ? L(lang, `要求约 ${ask.target} 字，还差约 ${ask.target - words()} 字：没写完就接着交（${names.write} 带 append=true）。`, ` About ${ask.target} are asked for — some ${ask.target - words()} short: where it is not finished, hand in what follows (${names.write} with append=true).`)
      : L(lang, `（要求约 ${ask.target} 字。）`, ` (About ${ask.target} are asked for.)`)
  const show = (): void => { if (!ask.dry) task.job?.rewrite(working) }
  const none = (): Error => new Error(L(lang, `还没有提交正文：先用 ${names.write} 把正文交上来。`, `No text is handed in yet: hand it in with ${names.write} first.`))
  const tools: RoleTool[] = [
    {
      name: names.write,
      description: L(lang,
        '提交正文：text 是这一章的正文（只有正文）。再调用一次就是整章重交，换掉之前交的；一次交不下的，后面几次带 append=true，接在已交的后面。',
        'Hand the text in: `text` is the chapter\'s prose, and nothing but prose. Called again, it is the whole of it handed in anew, in place of what was; where one call cannot hold it, later calls say append=true and go on from what is handed in.'),
      parameters: {
        text: { type: 'string', required: true, description: L(lang, '正文。段落之间空一行。', 'The prose. A blank line between paragraphs.') },
        append: { type: 'boolean', description: L(lang, '接在已经提交的正文后面，而不是换掉它。', 'Add to the end of what is handed in, instead of replacing it.') },
      },
      run(args) {
        const text = ask.clean(typeof args.text === 'string' ? args.text : '')
        if (text.trim().length === 0) throw new Error(L(lang, 'text 是空的：把正文放进 text。', '`text` is empty: put the prose in it.'))
        const adding = args.append === true && working.length > 0
        working = adding ? `${working}\n\n${text}` : text
        if (!adding) drafts += 1
        show()
        return L(lang,
          `收到，${adding ? '接在后面了，' : ''}现在一共 ${words()} 字。${against()}要改：${names.edit} 改其中一处，${names.read} 先看一遍，或者 ${names.write} 整章重交。满意了调用 ${names.done}。`,
          `Received${adding ? ', added to the end' : ''}: ${words()} words in all now.${against()} To change it: ${names.edit} for one place, ${names.read} to read it over first, or ${names.write} for the whole of it again. When you are satisfied, call ${names.done}.`)
      },
    },
    {
      name: names.read,
      description: L(lang,
        '看你交上来的正文现在的样子——改过的地方是改过之后的。给 around（正文里的一句话）就看它前后那一带；不给就从 offset 起按页看。',
        'Read the text you handed in as it stands — places already changed, as they read now. With `around` (a sentence of it), the stretch on either side; without, a page from `offset`.'),
      parameters: {
        around: { type: 'string', description: L(lang, '正文里的一句话：看它前后各几百字。', 'A sentence of the text: a few hundred characters on either side of it.') },
        offset: { type: 'integer', description: L(lang, '从第几个字符起（默认 0）。', 'Character offset to start from (default 0).') },
        limit: { type: 'integer', description: L(lang, '最多返回多少字符（默认 8000，最多 40000）。', 'Most characters to return (default 8000, at most 40000).') },
      },
      run(args) {
        if (working.length === 0) throw none()
        const near = argText(args.around)
        if (near !== undefined) {
          const range = fuzzyFind(working, near)
          if (range === undefined) throw new Error(L(lang, `正文里找不到“${clip(near, 40)}”。不给 around，从头按页看。`, `"${clip(near, 40)}" is not in the text as it stands. Leave \`around\` out and read it from the top.`))
          return around(working, range.start, range.end - range.start, 600)
        }
        const offset = Math.max(0, argInt(args.offset) ?? 0)
        const limit = Math.min(40_000, Math.max(200, argInt(args.limit) ?? 8000))
        const page = working.slice(offset, offset + limit)
        const rest = working.length - offset - page.length
        return `${page}${rest > 0 ? L(lang, `\n\n（后面还有 ${rest} 个字符：offset=${offset + page.length} 接着看。）`, `\n\n(${rest} more characters follow: go on with offset=${offset + page.length}.)`) : ''}`
      },
    },
    {
      name: names.edit,
      description: L(lang,
        '改你交上来的正文里的一处：find 是要改的那几句（从现在的正文里逐字照抄，只能对上一处），replace 是改成的样子；replace 留空就是删掉。改动当场落在正文上。',
        'Change one place of the text you handed in: `find` is the sentences to change (copied word for word from the text as it stands; it has to stand in one place only), `replace` is what they become; an empty `replace` takes them out. The change is made in the text at once.'),
      parameters: {
        find: { type: 'string', required: true, description: L(lang, '要改的那几句，逐字照抄。', 'The sentences to change, word for word.') },
        replace: { type: 'string', required: true, description: L(lang, '改成的样子。空字符串 = 删掉。', 'What they become. An empty string takes them out.') },
        all: { type: 'boolean', description: L(lang, '同一个词、同一个称呼通篇替换：出现几处换几处。', 'A word or a name changed throughout: every place it stands.') },
      },
      run(args) {
        if (working.length === 0) throw none()
        const find = typeof args.find === 'string' ? args.find : ''
        const replace = ask.clean(typeof args.replace === 'string' ? args.replace : '')
        if (find.length === 0) throw new Error(L(lang, '要给 find（要改的那几句）。', 'Give `find` (the sentences to change).'))
        let count = occurrences(working, find)
        let from = find
        if (count === 0) {
          // Copied all but to the letter (a quote mark, a space): found where it reads so, once.
          const range = fuzzyFind(working, find)
          if (range === undefined) throw new Error(L(lang, `正文里找不到这几句：从现在的正文里逐字照抄（${names.read} 看现在的样子）。`, `These sentences are not in the text: copy them word for word from the text as it stands (${names.read} shows it).`))
          from = working.slice(range.start, range.end)
          count = occurrences(working, from)
        }
        if (count > 1 && args.all !== true) throw new Error(L(lang, `这几句在正文里出现了 ${count} 处：多抄几个字，让它只对上一处；确实要全部替换就带 all=true。`, `These sentences stand in ${count} places: copy a few more words so that they stand in one — or say all=true to change every one.`))
        const at = working.indexOf(from)
        working = args.all === true ? working.split(from).join(replace) : `${working.slice(0, at)}${replace}${working.slice(at + from.length)}`
        edits += args.all === true ? count : 1
        show()
        const shown = around(working, at, replace.length)
        return replace.length === 0
          ? L(lang, `删掉了。这一带现在是：\n${shown}`, `Taken out. The stretch now reads:\n${shown}`)
          : L(lang, `${args.all === true ? `换了 ${count} 处。头一处` : '改好了。这一处'}现在是：\n${shown}`, `${args.all === true ? `Changed in ${count} place(s). The first` : 'Changed. The place'} now reads:\n${shown}`)
      },
    },
    {
      name: names.done,
      description: L(lang,
        '交稿：正文是你要的样子了就调用它。调用之后这件活就结束了，正文以这时候的样子为准。',
        'Hand the work in: call it when the text is as you would have it. That ends the work, and the text stands as it is then.'),
      parameters: {
        note: { type: 'string', required: true, description: L(lang, '一两句话：读了什么、怎么取舍的、改过哪些地方。', 'A sentence or two: what you read, how you decided, what you changed.') },
      },
      closing: true,
      final: true,
      run(args) {
        if (working.trim().length === 0) throw none()
        // Well short of the length asked for: said once. A chapter that is rightly this short is called done again.
        if (short() && !warned) {
          warned = true
          throw new Error(L(lang,
            `现在 ${words()} 字，要求约 ${ask.target} 字，差得多。没写完就接着写（${names.write} 带 append=true 接在后面，或 ${names.edit} 把写得太省的地方写足）；确实该这么短，再调用一次 ${names.done}，在 note 里说为什么。`,
            `The text runs to ${words()} words and about ${ask.target} are asked for: well short. Where it is not finished, go on (${names.write} with append=true, or ${names.edit} to give a thin place its room); where it is rightly this short, call ${names.done} once more and say why in the note.`))
        }
        handedIn = argText(args.note) ?? ''
        return L(lang, '收到。', 'Received.')
      },
    },
  ]

  const label = continuing
    ? L(lang, `续写第 ${chapter.index} 章（自己读、自己写）`, `Going on with chapter ${chapter.index} (reading and writing for itself)`)
    : L(lang, `写第 ${chapter.index} 章（自己读、自己写）`, `Writing chapter ${chapter.index} (reading and writing for itself)`)
  // (A chapter drafted is read as never written: nothing of its last draft is there to be found. Gone on with, it is read as it stands.)
  const texts = continuing ? undefined : new Map([[chapter.plan.id, '']])
  let outcome: RoleOutcome | undefined
  let broke: unknown
  let restore: (() => void) | undefined
  try {
    // One piece of work is one place at the gate, however many steps its agent takes.
    outcome = await core.through('text', async () => await roles.run({
      role: 'writer',
      label: L(lang, `写手 · ${label}`, `Writer · ${label}`),
      persona: ask.system,
      rules: composeRules({ ...base, ...names }),
      prompt,
      ...(ask.images !== undefined && ask.images.length > 0 ? { images: ask.images } : {}),
      tools: [...bookTools(runtime, task.signal, chapter.line ?? MAIN_LINE, texts), ...tools],
      inherit: { mode: 'none' },
      route: ask.route,
      maxSteps: STEPS,
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.caller !== undefined ? { parent: task.caller } : {}),
      cwd: project.root,
      onStart: (ids) => { if (!ask.dry) task.job?.crew({ role: 'writer', label, by: 'agent', running: true, session: ids.session, ...(ids.parent !== undefined ? { parent: ids.parent } : {}) }) },
      // What it is doing right now is said where the job's progress is: the job's text is the chapter, and stays the chapter.
      onStep: (step) => {
        if (ask.dry) return
        restore?.()
        restore = task.job?.note(clip(stepLine(step).replace(/\s+/g, ' ').trim(), 80))
      },
      budgetNote: budget => working.length === 0
        ? L(lang, `还剩 ${budget.left} 次工具调用，正文还没有提交：读到这里就动笔，用 ${names.write} 交上来。`, `${budget.left} tool calls are left and no text is handed in: write now, and hand it in with ${names.write}.`)
        : L(lang, `还剩 ${budget.left} 次工具调用：正文已经在了。把手上这几处改完就调用 ${names.done}。`, `${budget.left} tool calls are left: the text is in. Finish the places in hand and call ${names.done}.`),
      unfinished: () => handedIn !== undefined ? undefined
        : working.length === 0 ? L(lang, `正文还没有提交：写好了用 ${names.write} 交上来（写在回复里的不算）。`, `No text is handed in yet: hand it in with ${names.write} (what is written in a reply does not count).`)
          : L(lang, `正文交上来了，还没有交稿：没有要改的了就调用 ${names.done}。`, `The text is in and the work is not handed in: when there is nothing left to change, call ${names.done}.`),
    }), { ...(task.signal !== undefined ? { signal: task.signal } : {}), retry: false }, runtime)
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    broke = error
    core.log(`the writer agent failed on chapter ${chapter.plan.id}`, error)
  } finally {
    restore?.()
  }
  task.signal?.throwIfAborted()
  const ran = outcome !== undefined ? { steps: outcome.steps, ...(outcome.session !== undefined ? { session: outcome.session } : {}), ...(outcome.parent !== undefined ? { parent: outcome.parent } : {}) } : {}
  if (working.trim().length === 0) {
    const why = broke !== undefined
      ? L(lang, `写手的 agent 中途断了（${clip(errorMessage(broke), 160)}），没有交上正文`, `the writer agent broke off (${clip(errorMessage(broke), 160)}) with no text handed in`)
      : L(lang, `写手的 agent 没有交上正文就停了（${outcome?.stop ?? 'stopped'}，${outcome?.steps ?? 0} 步）`, `the writer agent stopped with no text handed in (${outcome?.stop ?? 'stopped'}, ${outcome?.steps ?? 0} steps)`)
    if (!ask.dry) task.job?.crew({ role: 'writer', label, by: 'agent', ...ran, note: why })
    throw new Error(why)
  }
  // What it handed in stands, done or not: a run that broke off after the text was in has still written the chapter.
  const cutOff = handedIn !== undefined ? undefined
    : broke !== undefined
      ? L(lang, `写手的 agent 中途断了（${clip(errorMessage(broke), 160)}）：用的是它最后交上来的样子，可能没有改完。`, `The writer agent broke off (${clip(errorMessage(broke), 160)}): the text is as it last stood, and may not be finished.`)
      : L(lang, `写手没有交稿就停了（${outcome?.stop ?? 'stopped'}）：用的是它最后交上来的样子。`, `The writer stopped without handing the work in (${outcome?.stop ?? 'stopped'}): the text is as it last stood.`)
  if (!ask.dry) task.job?.crew({ role: 'writer', label, by: 'agent', ...ran, ...(cutOff !== undefined ? { note: cutOff } : {}) })
  const note = handedIn !== undefined && handedIn.length > 0 ? handedIn : cutOff
  return {
    text: working,
    pack,
    handed: prompt,
    used: {
      by: 'agent',
      how: 'agent',
      ...(outcome?.steps !== undefined ? { steps: outcome.steps } : {}),
      drafts,
      edits,
      ...(note !== undefined ? { note } : {}),
    },
  }
}

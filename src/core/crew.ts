// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The crew.
 *
 * A book is worked on by a small company: the showrunner, who talks with the
 * author; the writer, who writes; and four roles that do the rest —
 *
 *   analyst    场记  keeps the record: digests chapters, reviews them, takes in manuscripts
 *   architect  策划  plans: outlines, beats, what-ifs, the bible, research
 *   director   导演  stages: audio scripts, storyboards, interludes
 *   producer   后期  cuts prepared voice, sound and pictures into a video
 *
 * Each of the four is an agent: a persona, standing rules, skills, tools and
 * permissions, on a model of its own. What sets one role apart from another is
 * exactly that list and nothing in the machinery — they all run on the Harness's
 * agent loop, as children of the conversation that asked for the work.
 *
 * This module is where a piece of work is handed to a role. `assign` is for
 * work with a deliverable — the pipelines' every "ask a model for a result"
 * goes through it; `delegate` is for a task given in words. A role that cannot
 * run as an agent (its model is an endpoint the Studio calls directly, or its
 * author set it to plain calls) answers `assign` with one request, as all of
 * them did before there was a crew.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CrewRole, CrewRun, ProjectManifest, PromptLanguage, ReferencesLooked } from '../shared/types'
import { clip } from '../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from './core'
import { completeJson, extractJson, LlmCallError, type LlmImage } from './llm'
import { ProjectError } from './project'
import { READ_KINDS, readBook, searchBook, SEARCH_SOURCES } from './reading'
import { jottingsBrief } from './jottings'
import { looksFirst, referenceBrief, referenceTools } from './references'
import { L, promptLanguage } from './render'
import { argInt, argList, argText, type RoleInherit, type RoleOutcome, type RoleParameter, type RoleSkill, type RoleStep, type RoleTask, type RoleTool } from './roles'
import { errorMessage, isAbort } from './util/async'

// ───────────────────────────── who they are ─────────────────────────────

export interface CrewSpec {
  role: CrewRole
  /** What the role is called, in Chinese and in English. */
  name: [zh: string, en: string]
  /** What it does, in a line. */
  does: [zh: string, en: string]
  persona: [zh: string, en: string]
  /** Rules of this role alone, added to the ones every role works by. */
  craft?: [zh: string, en: string]
  /** The conversation's tools this role's work calls for: what it sees of them unless the author opens them all. */
  tools: readonly string[]
  /** Tool calls a run may make before it is told to wrap up, unless the author sets another number. */
  steps: number
}

export const CREW: Record<CrewRole, CrewSpec> = {
  analyst: {
    role: 'analyst',
    name: ['场记', 'Continuity'],
    does: ['收录记忆、审校、整理导入的书稿', 'Digests chapters, reviews them, takes in manuscripts'],
    persona: [
      '你是长篇小说工坊「剧组」里的场记：这本书的连续性和记录由你负责。你读得细、记得准——谁在哪里、知道了什么、身上起了什么变化、哪条线索埋下了还没有收。你只依据书里实际写了什么来记录和判断：不推测，不续写，不替作者改稿。',
      'You are the continuity keeper of a fiction studio\'s crew: the record of this book is yours. You read closely and remember exactly — who is where, who knows what, what changed in them, which thread was planted and is still open. You record and judge only by what the book actually says: no speculation, no continuation, no rewriting on the author\'s behalf.',
    ],
    tools: [],
    steps: 30,
  },
  architect: {
    role: 'architect',
    name: ['策划', 'Planner'],
    does: ['推演大纲与节拍、起草设定、假设分支、查资料', 'Derives outlines and beats, drafts the bible, explores what-ifs, researches'],
    persona: [
      '你是长篇小说工坊「剧组」里的策划：故事的架构师。长篇结构、由人物推动的情节、伏笔的埋设与回收是你的本行。你的方案具体、有因果、有取舍，从不写空话；你提出的每一个设想，都要接得上这本书已经写下的东西。',
      'You are the story planner of a fiction studio\'s crew: its architect. Long-form structure, plots that characters drive, setups and their payoffs are your trade. Your plans are concrete and causal and make choices; none of them is vague, and every idea you put forward connects to what this book has already written.',
    ],
    craft: [
      '- 查资料是你分内的事。工具里有 web_search / web_fetch 时，可以用它们找时下的话题、流行的梗、真实的行业细节和史料来丰富设计（开始前可以用 skill 工具读 novel-trend-research）。找来的东西要化进这本书的世界和语气里——不合这个世界的梗宁可不用；用了外面的信息，在结果里说明它来自哪里。没有这些工具，或者它们连着两三次都失败（这里连不上网、没有配置搜索），就不要再试：只凭这本书和你自己的积累做，并在结果里说明没有联网核实。',
      '- Research is part of your work. When web_search / web_fetch are among your tools, use them for what is current, for memes in circulation, for real trade detail and history that enrich a design (load the skill novel-trend-research first, with the skill tool). What you find has to be worked into this book\'s world and voice — a meme that does not belong there is better left out; say in your result where outside material came from. Without those tools, or when they fail two or three times running (no network here, no search set up), stop trying: work from the book and what you know, and say in your result that nothing was checked online.',
    ],
    tools: ['web_search', 'web_fetch', 'skill'],
    steps: 40,
  },
  director: {
    role: 'director',
    name: ['导演', 'Director'],
    does: ['有声脚本、分镜、幕间', 'Audio scripts, storyboards, interludes'],
    persona: [
      '你是长篇小说工坊「剧组」里的导演：把写好的章节搬上舞台。有声剧的脚本——谁在说、怎么说、哪里该有声音；分镜——画面在哪里换、每一格画什么；还有和作者即兴对戏的幕间。你忠于原文：不改台词的意思，不添书里没有的情节。',
      'You are the director of a fiction studio\'s crew: you put finished chapters on stage. The script of an audio drama — who speaks, how, where a sound belongs; the storyboard — where the picture changes and what each panel shows; and the interludes played with the author. You are faithful to the text: a line keeps its meaning, and nothing happens that the book does not have.',
    ],
    tools: [],
    steps: 30,
  },
  producer: {
    role: 'producer',
    name: ['后期', 'Post-production'],
    does: ['把配音、音效和分镜画面剪成视频', 'Cuts voice, sound and storyboard pictures into a video'],
    persona: [
      '你是长篇小说工坊「剧组」里的后期：把已经备好的素材——配音、音效、配乐、分镜画面——剪成一段能直接播放的视频。你自己动手：在命令行里用 ffmpeg / ffprobe 写脚本、运行、看结果、再改。成片要自己验过才交。',
      'You are post-production in a fiction studio\'s crew: you cut material that is already made — voice, effects, music, storyboard pictures — into a video that plays as it is. You do it with your own hands: ffmpeg and ffprobe in a shell, a script you write, run, look at and correct. Nothing is handed in that you have not checked yourself.',
    ],
    craft: [
      '- 开工前先用 skill 工具读 novel-video-editing：里面是把静态画面和分段配音剪成视频的做法、一份可以直接运行的基础脚本、常见的坑和验收办法。\n- 你只在任务给你的工作目录里写文件；素材只读，不要改动、移动或删除它们。\n- 先做出一版能过检查的，再讲究；不要在第一版上追求完美。\n- 做不好、或者明显超出你手头工具的能力时，不要硬撑：工具里有 subagent_claude_code 或 subagent_codex（外援：另一个会写代码的 agent，由作者在 DSH 里装上才会出现）就把活交给它——在 prompt 里写清素材清单的绝对路径、工作目录、要的效果、成片放在哪里、怎么算合格；它看不到这场对话，只看得到你写给它的话。它做完，你来检查（video_check）和提交。',
      '- Before you start, load the skill novel-video-editing with the skill tool: how stills and voice clips are cut into a video, a base script that runs as it is, what goes wrong, how to check the result.\n- Write only inside the working directory the task gives you; the material is read-only — never change, move or delete it.\n- Get a version that passes the checks first, then refine; do not chase perfection on the first cut.\n- When the work is beyond you or beyond the tools at hand, do not push on: if subagent_claude_code or subagent_codex is among your tools (outside help: another agent that writes code, there only when the author installed it in DSH), hand the work to it — put in the prompt the absolute path of the material list, the working directory, the effect wanted, where the result goes and how it will be judged; it sees nothing of this conversation, only what you write to it. When it is done, you check the result (video_check) and hand it in.',
    ],
    tools: ['bash', 'pwsh', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'skill', 'job_output', 'job_list', 'job_kill', 'todo_write', 'subagent_claude_code', 'subagent_codex'],
    // A cut is long work: a first version, a look at it, corrections, and the words into the picture by whatever this computer has. Eighty calls ran out on a run that had not yet cut anything.
    steps: 200,
  },
}

/** Tools of the conversation that are the showrunner's own, or need a person in the room: never a role's. */
const NOT_FOR_ROLES = new Set([
  'ask_user_question', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'present',
  'subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'interrupt_agent', 'list_agents', 'wait_agent', 'spawn_teammate',
  'workflow', 'ralph', 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list', 'plugin_manager',
])

/** Whether a role may be shown a tool of the conversation's when the author opens them all. */
export function openToRoles(name: string): boolean {
  return !name.startsWith('novel_') && !name.startsWith('team_task_') && !NOT_FOR_ROLES.has(name)
}

export function crewName(role: CrewRole, lang: PromptLanguage): string {
  return CREW[role].name[lang === 'zh' ? 0 : 1]
}

/** The rules every role works by, then the role's own. */
export function crewRules(role: CrewRole, lang: PromptLanguage, book: { title: string }): string {
  const spec = CREW[role]
  const zh = lang === 'zh'
  const common = zh
    ? `## 你在剧组里的位置
这是一次委派：总编（和作者对话的那一位）或作者本人把一件具体的活交给了你，任务就是下面那条消息。你在为《${book.title.replace(/^[《「『“"]+|[》」』”"]+$/gu, '')}》这本书工作。这场对话里没有人会回答提问——不要问，拿不准的地方按最稳妥的理解做，并在交回的结果里写明你是怎么取舍的。

## 怎么干
- 先看任务给的材料够不够。够，就直接做完交回——不要为了“核对”把给过的东西再读一遍。不够，或者这件活本来就要对照书里别处（前后章、人物卡、设定），再去查：book_read 读一章正文、一张人物卡、一条设定、大纲、某一章的记忆；book_search 按关键词或意思在全书里找。书里的事不要凭印象补。
- 你改动这本书只有一条路：任务指定的交回工具，和你自己的那几样工具。不要用文件工具或命令行去改 manuscript/、bible/、outline.json、novel.json、.novel/ 里的文件——工坊靠自己的工具让版本、记忆和索引保持一致，绕过去的改动会被拒绝。
- 工具列表里其余的工具是给确有需要的时候准备的：每一次调用都留在记录里，也都要花时间和钱。
- 交回之后就结束：不要复述结果，不要再调用别的工具。`
    : `## Where you stand in the crew
This is a delegation: the showrunner (who talks with the author) or the author gave you one piece of work — the message below is the task. You are working on the book "${book.title}". Nobody in this conversation answers questions — do not ask; where you are unsure, take the safest reading and say in your result how you decided.

## How to work
- See first whether the material the task gives you is enough. If it is, do the work and hand it in — do not read again what you were given, for the sake of checking. If it is not, or the work is by its nature a matter of holding one part of the book against another (earlier and later chapters, a character's card, a rule of the world), look: book_read reads a chapter's text, a character card, a world entry, the outline, a chapter's memory; book_search finds by keyword or by meaning across the book. Never fill in from impression what the book says.
- There is one way for you to change this book: the tool the task names for handing in, and the few tools that are yours. Do not use file tools or the shell on anything under manuscript/, bible/, outline.json, novel.json or .novel/ — the Studio keeps versions, memory and search in step through its own tools, and a change made around them is refused.
- The other tools in your list are for when the work really needs them: every call stays on record, and every call costs time and money.
- Handing in ends the work: do not repeat the result, and call nothing after it.`
  const craft = spec.craft?.[zh ? 0 : 1]
  return craft !== undefined ? `${common}\n${craft}` : common
}

// ───────────────────────────── their skills ─────────────────────────────

let packageRoot: Promise<string | undefined> | undefined

/** The directory of this package, found from wherever this code was built to. */
export function findPackageRoot(): Promise<string | undefined> {
  packageRoot ??= (async () => {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let up = 0; up < 6; up++) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: string }
        if (manifest.name === __NOVEL_PACKAGE__) return dir
      } catch {
        // not here: one directory up
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  })()
  return packageRoot
}

const skillCache = new Map<CrewRole, Promise<RoleSkill[]>>()

/** What was read from the package is read again when next asked for: the package may have been replaced. */
export function forgetPackageFiles(): void {
  packageRoot = undefined
  skillCache.clear()
}

/** Where a role's skill keeps its guide and whatever comes with it. */
export async function crewSkillDir(role: CrewRole, name: string): Promise<string | undefined> {
  const root = await findPackageRoot()
  return root !== undefined ? join(root, 'crew', role, 'skills', name) : undefined
}

/**
 * The skills of a role: `crew/<role>/skills/<name>/SKILL.md` in this package,
 * each a guide with a `name` and a `description` in its front matter. They are
 * the role's alone — no other agent's catalog lists them.
 */
export function crewSkills(role: CrewRole): Promise<RoleSkill[]> {
  let pending = skillCache.get(role)
  if (pending === undefined) {
    pending = (async () => {
      const root = await findPackageRoot()
      if (root === undefined) return []
      const base = join(root, 'crew', role, 'skills')
      let names: string[]
      try {
        names = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
      } catch {
        return []
      }
      const skills: RoleSkill[] = []
      for (const name of names) {
        try {
          const raw = await readFile(join(base, name, 'SKILL.md'), 'utf8')
          const matter = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
          const field = (key: string): string | undefined => matter === null ? undefined : new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(matter[1]!)?.[1]?.trim().replace(/^["']|["']$/g, '')
          const content = (matter !== null ? raw.slice(matter[0].length) : raw).trim()
          if (content.length > 0) skills.push({ name: field('name') ?? name, description: field('description') ?? name, content, base: join(base, name) })
        } catch {
          // a skill folder without its guide is no skill
        }
      }
      return skills
    })()
    skillCache.set(role, pending)
  }
  return pending
}

// ───────────────────────────── their tools ─────────────────────────────

/**
 * The tools every role reads the book with.
 * @param line - the line of the plot the work is on (`main` for the main one): the tools read that line and nothing of
 *   the others — its chapters, numbered along it, its people, its threads — and the world. Left out for work that is
 *   about the whole book: then every line is there to read, each numbered along itself.
 * @param texts - chapters this work reads otherwise than the book has them (see `readBook`).
 */
export function bookTools(runtime: ProjectRuntime, signal?: AbortSignal, line?: string, texts?: ReadonlyMap<string, string>): RoleTool[] {
  const names = { read: 'book_read' }
  const kept = line !== undefined ? { line } : undefined
  const whole = kept === undefined
  return [
    {
      name: 'book_read',
      description: `Read one thing from the book in full: a chapter's text (paged), the outline (whole, or one chapter's plan), a character card, a world entry, a style profile, a chapter's memory (summary, facts, character states), the open threads, a chapter's review, a chapter's version list, the author's jottings (loose notes: ideas not settled, never canon — listed, or one whole by \`ref\`), or the records of how the outline was derived (what=derivations: what the author gave each derivation to go by and what the planner said of it — listed, one whole by its id, or the ones a chapter came of by that chapter). \`ref\` takes ids, names and chapter numbers ("3", "第3章", "latest"). Without \`ref\`, character and world list what is on file.${whole ? '' : ' This work is on one line of the plot: chapter numbers count along that line, and what is read is that line\'s — the book\'s other lines are no part of this work.'}`,
      parameters: {
        what: { type: 'string', required: true, enum: READ_KINDS },
        ref: { type: 'string', description: 'Which one. Not needed for threads; optional for style (the active one), outline (the whole outline), character and world (the list).' },
        offset: { type: 'integer', description: 'For chapter text: character offset to start from (default 0).' },
        limit: { type: 'integer', description: 'For chapter text: most characters to return (default 6000, at most 40000).' },
        ...(whole ? { line: { type: 'string' as const, description: 'A line of the plot, by id or name, in a book that has more than one: chapter numbers count along it, and lists are that line\'s. Left out: numbers count along the main line, and the outline lists every line.' } } : {}),
      },
      async run(args) {
        const what = argText(args.what) as typeof READ_KINDS[number] | undefined
        if (what === undefined || !READ_KINDS.includes(what)) throw new Error(`\`what\` is one of ${READ_KINDS.join(', ')}`)
        try {
          return (await readBook(runtime, { what, ref: argText(args.ref), offset: argInt(args.offset), limit: argInt(args.limit), ...(whole ? { line: argText(args.line) } : {}) }, names, kept, texts)).text
        } catch (error) {
          if (error instanceof ProjectError) throw new Error(error.message)
          throw error
        }
      },
    },
    {
      name: 'book_search',
      description: `Search everything the book knows — manuscript passages, character cards, world entries, chapter memories and outlines, and the author's jottings (source \`jotting\`: ideas, not canon) — by keywords or by meaning. The way to check what the book has already said before you decide anything.${whole ? '' : ' What is found is of the line this work is on, and of the world.'}`,
      parameters: {
        query: { type: 'string', required: true },
        sources: { type: 'array', items: { type: 'string', enum: SEARCH_SOURCES }, description: 'Restrict to some sources. Default: all.' },
        limit: { type: 'integer', description: 'Most hits (default 8).' },
        ...(whole ? { line: { type: 'string' as const, description: 'Search one line of the plot only, by id or name. Left out: the whole book.' } } : {}),
      },
      async run(args) {
        const query = argText(args.query)
        if (query === undefined) throw new Error('`query` is required')
        const sources = argList(typeof args.sources === 'string' ? args.sources.split(/[,，\s]+/) : args.sources).filter((item): item is string => typeof item === 'string')
        try {
          return (await searchBook(runtime, { query, ...(sources.length > 0 ? { sources } : {}), limit: argInt(args.limit), ...(whole ? { line: argText(args.line) } : {}) }, signal, kept)).text
        } catch (error) {
          if (error instanceof ProjectError) throw new Error(error.message)
          throw error
        }
      },
    },
  ]
}

/**
 * The book's references, for a role at work on it as an agent: the tools it reads in them with, and what it is told
 * of them — which there are, what the author wants of each. Nothing for a book that has none, and nothing for
 * post-production, whose work is cutting what is already made.
 */
async function referencesFor(core: NovelCore, runtime: ProjectRuntime, role: CrewRole, lang: PromptLanguage, signal: AbortSignal | undefined, how: { first?: boolean; onLook?: (what: string) => void } = {}): Promise<{ tools: RoleTool[]; brief: string }> {
  if (role === 'producer') return { tools: [], brief: '' }
  try {
    const tools = await referenceTools(core, runtime, signal, undefined, how.onLook)
    const brief = tools.length > 0 ? await referenceBrief(core, runtime, lang, { ...(how.first === true ? { first: true } : {}) }) : undefined
    return { tools, brief: brief !== undefined ? `\n\n${brief}` : '' }
  } catch (error) {
    // A list of references that cannot be read keeps nobody from working: the work goes on without them.
    core.log('could not read the book\'s references', error)
    return { tools: [], brief: '' }
  }
}

/**
 * What a role at work on the book as an agent is told of the author's jottings: that there are some, what they are,
 * how they are read. Nothing where there is none it may find, and nothing for post-production.
 */
async function jottingsFor(core: NovelCore, runtime: ProjectRuntime, role: CrewRole, lang: PromptLanguage): Promise<string> {
  if (role === 'producer') return ''
  try {
    const brief = await jottingsBrief(runtime.project, lang)
    return brief.length > 0 ? `\n\n${brief}` : ''
  } catch (error) {
    core.log('could not read the book\'s jottings', error)
    return ''
  }
}

/**
 * Whether a piece of work is to look in the book's references before anything else: it is of a kind that does, the
 * book has references that are consulted, and the author did not turn that off for the kind.
 */
async function looksUp(core: NovelCore, runtime: ProjectRuntime, work: Pick<Assignment<unknown>, 'lookUp' | 'role' | 'plain'>): Promise<boolean> {
  if (work.lookUp === undefined || work.role === 'producer' || work.plain === true) return false
  try {
    return await looksFirst(runtime, work.lookUp)
  } catch (error) {
    core.log('could not read how the book\'s references are used', error)
    return false
  }
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A compact account of one tool call for whoever watches the job. */
export function stepLine(step: RoleStep): string {
  const args = step.args
  const main = argText(args.pattern) ?? argText(args.query) ?? argText(args.command) ?? argText(args.url) ?? argText(args.file_path) ?? argText(args.path) ?? argText(args.find)
    ?? (argText(args.what) !== undefined ? `${argText(args.what)}${argText(args.ref) !== undefined ? ` ${argText(args.ref)}` : ''}` : undefined)
    ?? (args.at !== undefined ? `@${String(args.at)}` : undefined) ?? argText(args.name) ?? argText(args.note)
  const first = oneLine(step.result.split('\n').find(line => line.trim().length > 0) ?? '')
  return `› ${step.tool}${main !== undefined ? ` ${clip(oneLine(main), 70)}` : ''} — ${step.ok ? '' : '✗ '}${clip(first, 120)}\n`
}

// ───────────────────────────── handing work to a role ─────────────────────────────

/**
 * How a role is set to work, the author's settings applied: the book's own
 * where it has any for this role, else the Studio-wide ones.
 */
export function crewPlan(core: NovelCore, role: CrewRole, book?: Pick<ProjectManifest, 'crew'>): { mode: 'agent' | 'call'; inherit: RoleInherit; steps: number; open: boolean } {
  const spec = CREW[role]
  const set = book?.crew?.[role] ?? core.currentSettings().crew?.[role]
  const open = set?.tools === 'all'
  return {
    mode: set?.mode === 'call' ? 'call' : 'agent',
    inherit: open ? { mode: 'all', except: name => !openToRoles(name) } : { mode: 'named', names: spec.tools },
    steps: set?.steps !== undefined && set.steps >= 4 ? Math.round(set.steps) : spec.steps,
    open,
  }
}

export interface Assignment<T> {
  role: CrewRole
  /** What this piece of work is, in a few words, as the author reads it in a list. */
  label: string
  /** The single call's system prompt, for a role that works by plain calls; an agent has its persona instead. */
  system?: string
  /** The task and its material. It may say "output JSON": for an agent that means "hand this JSON in". */
  prompt: string
  /** Pictures that go with the task, for a role whose model sees them (see `guidePictures`). */
  images?: LlmImage[]
  temperature?: number
  /** The tool the result is handed in with. */
  tool: string
  /** What is to be handed in, for the tool's description. */
  what: string
  /** Declared where the result's shape is simple; otherwise the tool takes one `result` of any JSON, shaped as the task says. */
  parameters?: Record<string, RoleParameter>
  /** Return the value when it has the expected shape, or throw with what is wrong: the role reads that and hands in again. */
  validate?: (value: unknown) => T
  /** Tools of this piece of work alone, beside the ones every role reads the book with. */
  tools?: RoleTool[]
  /**
   * Chapters the role reads otherwise than the book has them, by id: what its reading tool shows is then the text
   * the work goes by — and is checked against — and not the saved one.
   */
  texts?: ReadonlyMap<string, string>
  maxSteps?: number
  /**
   * Everything this piece of work goes by is in its task — a chapter to cut into lines, a prompt to shorten, notes to
   * sort — and there is nothing in the book to look up for it: it is asked in one request, whatever the role is set
   * to. An agent's loop would add its tools and its steps to every such request, and room to wander, for nothing.
   */
  plain?: boolean
  /**
   * Keep the agent that did the work, under this key, for what the author may say of what it handed in (`resume`).
   * Only an agent is kept: work done in a plain call has nobody to keep.
   */
  keep?: string
  /**
   * Go on with the agent kept under `key` where it is still there: `prompt` is said to it — what it handed in, what
   * the author says of it, what to hand in now — in place of the assignment's own prompt, which is the whole task for
   * somebody who starts from nothing (and is what is used where the agent is gone, or the role works by plain calls).
   */
  resume?: { key: string; prompt: string }
  /**
   * The line of the plot the work is on, by id (`main` for the main one): what the role reads with its own tools is
   * that line's, and nothing of the book's other lines. Left out only for work that is about the whole book.
   */
  line?: string
  /**
   * A derivation or a review: work that looks in the book's references before anything else, where the book has any
   * and the author has it so. The role is told to, what it hands in is not taken until it has read or searched in
   * them, and what it read comes back with the result (`Assigned.referenced`).
   */
  lookUp?: 'derive' | 'review'
}

export interface Assigned<T> {
  value: T
  run: CrewRun
  /** Where the work was to look in the book's references first (`Assignment.lookUp`): what it read there. */
  referenced?: ReferencesLooked
  /** The work was done by the agent kept from an earlier piece of work, going on from all it had read (`Assignment.resume`). */
  resumed?: true
}

/** What an agent is told about handing in, after a task that was written for a plain reply. */
function handIn(lang: PromptLanguage, tool: string, declared: boolean): string {
  return declared
    ? L(lang, `\n\n---\n交回方式：调用 ${tool}，把结果按它的参数填好——不要写在回答里。它会检查，有问题会告诉你哪里要改。`, `\n\n---\nHanding in: call ${tool} with the result in its parameters — do not write it in your reply. It checks what you send and tells you what to correct.`)
    : L(lang, `\n\n---\n交回方式：上面说的“输出 JSON”在这里是指——调用 ${tool}，把那个 JSON 整个作为 result 参数交上去，不要写在回答里。它会检查，有问题会告诉你哪里要改。`, `\n\n---\nHanding in: "output JSON" above means here — call ${tool} with that whole JSON as its \`result\` parameter; do not write it in your reply. It checks what you send and tells you what to correct.`)
}

/**
 * Give a role a piece of work that has a deliverable, and wait for it.
 *
 * As an agent the role gets the task, the tools to read the book, whatever of
 * the conversation's tools it may use, and one tool to hand the result in
 * with; what it hands in is validated on the spot. Otherwise — and when the
 * agent's run falls through — the same task is asked in one request.
 * @throws LlmCallError when neither way produced a usable result.
 */
export async function assign<T = Record<string, unknown>>(core: NovelCore, runtime: ProjectRuntime, task: TaskContext, work: Assignment<T>): Promise<Assigned<T>> {
  // One piece of work is one place at the gate, however many steps its agent takes. The models' own retries stand; the gate only keeps count.
  return await core.through('text', async () => await assignNow(core, runtime, task, work), { ...(task.signal !== undefined ? { signal: task.signal } : {}), retry: false }, runtime)
}

async function assignNow<T>(core: NovelCore, runtime: ProjectRuntime, task: TaskContext, work: Assignment<T>): Promise<Assigned<T>> {
  const manifest = await runtime.project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route(work.role, runtime, task)
  const plan = crewPlan(core, work.role, manifest)
  const name = crewName(work.role, lang)
  // Work that looks in the book's references first: what it reads there is counted off its calls.
  const first = await looksUp(core, runtime, work)
  const looks: string[] = []
  let calls = 0
  // (A result that came of a plain call saw nothing of them, whatever an agent read before it fell through.)
  const looked = (cannot?: string): { referenced?: ReferencesLooked } => (first ? { referenced: cannot !== undefined ? { calls: 0, read: [], cannot } : { calls, read: [...new Set(looks)].slice(0, 16) } } : {})
  const validate = (raw: unknown): T => {
    const value = typeof raw === 'string' ? extractJson(raw) : raw
    return work.validate !== undefined ? work.validate(value) : value as T
  }
  const record = (run: CrewRun): CrewRun => {
    task.job?.crew(run)
    return run
  }

  const byCall = async (note?: string): Promise<Assigned<T>> => {
    const { value } = await completeJson(core.llm, {
      route,
      ...(work.system !== undefined ? { system: work.system } : {}),
      prompt: work.prompt,
      ...(work.images !== undefined && work.images.length > 0 ? { images: work.images } : {}),
      ...(work.temperature !== undefined ? { temperature: work.temperature } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      onText: (_delta, total) => { task.job?.rewrite(total) },
      validate,
    })
    // Asked in one request, with no tools: nothing of the references could be read, and that is said.
    return { value, run: record({ role: work.role, label: work.label, by: 'call', ...(note !== undefined ? { note } : {}) }), ...looked(L(lang, `${name}这次是一问一答、没有工具，查不了参考文献。`, `${name} worked in one plain call this time, with no tools: the references could not be read.`)) }
  }

  const roles = core.roles
  if (plan.mode === 'call' || work.plain === true) return await byCall()
  if (roles === undefined || !roles.can(route)) {
    return await byCall(L(lang, `${name}的模型 ${route.model} 是工坊直连的接口，进不了 Harness 的 agent 循环，所以这次是一次普通调用：没有工具，也不会出现在对话的 agent 列表里。想让${name}作为 agent 工作，在“设置 → 班底”里给它选一个 Harness「设置 → 模型」里的模型。`, `${name}'s model ${route.model} is an endpoint the Studio calls directly and cannot run on the Harness's agent loop, so this was one plain call: no tools, and not in the conversation's list of agents. To have ${name} work as an agent, give it a model from the Harness's Settings → Models in Settings → Crew.`))
  }

  let delivered: { value: T } | undefined
  const declared = work.parameters !== undefined
  const deliver: RoleTool = {
    name: work.tool,
    description: `${L(lang, '交回这件活的结果', 'Hand in the result of this piece of work')}: ${work.what}. ${L(lang, '交上来的东西会当场检查；通过之后这件活就结束了。', 'What you hand in is checked on the spot; once it passes, the work is done.')}`,
    parameters: work.parameters ?? { result: { type: 'json', required: true, description: L(lang, '任务要求的那个 JSON，整个交上来。', 'The JSON the task asks for, whole.') } },
    closing: true,
    final: true,
    run(args) {
      // The author has this kind of work look in the references first: it is sent back to them — twice at most, so
      // that a role that will not look still hands its work in, and is told on.
      if (first && references.tools.length > 0 && calls === 0 && sentBack < 2) {
        sentBack += 1
        throw new Error(L(lang, `还没有查参考文献：作者要这件活先查再做。先用 reference_read（读某一本的大纲、设定、人物、文风、正文）或 reference_search（搜）查这件活用得上的，照查到的把结果改好，再交回。`, `The references have not been looked at: the author has this piece of work look in them first. Read with reference_read (a reference's outline, world, people, style, text) or find with reference_search what the work can use, mend the result by what you find, then hand it in.`))
      }
      const value = validate(declared ? args : args.result)
      delivered = { value }
      return L(lang, '收到，已通过检查。', 'Received and checked.')
    },
  }
  // An agent kept from the work this goes on from: it is spoken to again, where it is still there.
  const going = work.resume !== undefined && roles.has?.(work.resume.key) === true ? work.resume : undefined
  // (It looked in the references when it began: it is not sent back to them for a word about its own work.)
  let sentBack = going !== undefined ? 2 : 0
  const skills = await crewSkills(work.role)
  const references = await referencesFor(core, runtime, work.role, lang, task.signal, first ? { first: true, onLook: (what) => { calls += 1; looks.push(what) } } : {})
  const jotted = await jottingsFor(core, runtime, work.role, lang)
  // Said in the task as well as among the rules: it is the first thing to do.
  const lookFirst = first && references.tools.length > 0
    ? L(lang, '\n\n---\n动手之前：这本书有参考文献（清单和作者的要求在你的规则里）。先用 reference_read / reference_search 查这件活用得上的，再做。', '\n\n---\nBefore you begin: this book has references (the list, and what the author asks of them, is among your rules). Look in them with reference_read / reference_search for what this work can use, then do it.')
    : ''
  let outcome: RoleOutcome
  const asked = (resume: Assignment<T>['resume']): RoleTask => ({
      role: work.role,
      label: `${name} · ${work.label}`,
      persona: CREW[work.role].persona[lang === 'zh' ? 0 : 1],
      rules: `${crewRules(work.role, lang, manifest)}${references.brief}${jotted}`,
      prompt: resume !== undefined ? `${resume.prompt}${handIn(lang, work.tool, declared)}` : `${work.prompt}${lookFirst}${handIn(lang, work.tool, declared)}`,
      ...(resume !== undefined ? { resume: resume.key } : {}),
      ...(work.keep !== undefined ? { keep: work.keep } : {}),
      ...(work.images !== undefined && work.images.length > 0 ? { images: work.images } : {}),
      tools: [...bookTools(runtime, task.signal, work.line, work.texts), ...references.tools, ...(work.tools ?? []), deliver],
      ...(skills.length > 0 ? { skills } : {}),
      inherit: plan.inherit,
      route,
      maxSteps: work.maxSteps ?? plan.steps,
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.caller !== undefined ? { parent: task.caller } : {}),
      cwd: runtime.project.root,
      // On the job's list from its first step, with a way in: an agent at work can be watched, not only read about afterwards.
      onStart: (ids) => { task.job?.crew({ role: work.role, label: work.label, by: 'agent', running: true, session: ids.session, ...(ids.parent !== undefined ? { parent: ids.parent } : {}) }) },
      onStep: (step) => { task.job?.write(stepLine(step)) },
      unfinished: () => delivered === undefined ? L(lang, `这件活还没有交回：请调用 ${work.tool} 提交结果。`, `The work has not been handed in yet: call ${work.tool} with the result.`) : undefined,
  })
  try {
    try {
      outcome = await roles.run(asked(going))
    } catch (error) {
      // The agent that was to go on is gone, or broke: somebody new takes the whole task.
      if (going === undefined || isAbort(error) || task.signal?.aborted === true || delivered !== undefined) throw error
      core.log(`the ${work.role} agent kept for "${work.label}" could not go on`, error)
      sentBack = 0
      outcome = await roles.run(asked(undefined))
    }
  } catch (error) {
    if (isAbort(error) || task.signal?.aborted === true) throw error
    // What was handed in before the run broke is still the result.
    const kept = delivered as { value: T } | undefined
    if (kept !== undefined) return { value: kept.value, run: record({ role: work.role, label: work.label, by: 'agent' }), ...looked() }
    core.log(`the ${work.role} agent failed on "${work.label}"`, error)
    const why = clip(errorMessage(error), 200)
    task.job?.write(L(lang, `\n${name}的 agent 没能运行（${why}）；改用一次普通调用。\n`, `\nThe ${name} agent could not run (${why}); asking in one plain call instead.\n`))
    return await byCall(L(lang, `${name}的 agent 没能运行（${why}）。这个结果来自一次普通调用。`, `The ${name} agent could not run (${why}). This result is from one plain call.`))
  }
  task.signal?.throwIfAborted()
  const ran = { role: work.role, label: work.label, by: 'agent' as const, steps: outcome.steps, ...(outcome.session !== undefined ? { session: outcome.session } : {}), ...(outcome.parent !== undefined ? { parent: outcome.parent } : {}) }
  const handed = delivered as { value: T } | undefined
  if (handed !== undefined) return { value: handed.value, run: record(ran), ...looked(), ...(outcome.resumed === true ? { resumed: true as const } : {}) }
  // A model that answered in its reply what it was to hand in through the tool has still done the work.
  if (outcome.text.length > 0) {
    try {
      return { value: validate(outcome.text), run: record({ ...ran, note: L(lang, '结果是写在回答里的，没有通过交回工具。', 'The result came in the reply, not through the hand-in tool.') }), ...looked() }
    } catch {
      // not a result: the plain call below
    }
  }
  core.log(`the ${work.role} agent stopped (${outcome.stop}) after ${outcome.steps} steps without handing in "${work.label}"`)
  task.job?.write(L(lang, `\n${name}的 agent 没有交回结果（${outcome.stop}，${outcome.steps} 步）；改用一次普通调用。\n`, `\nThe ${name} agent handed nothing in (${outcome.stop}, ${outcome.steps} steps); asking in one plain call instead.\n`))
  return await byCall(L(lang, `${name}的 agent 没有交回结果（${outcome.stop}，${outcome.steps} 步）${outcome.text.length > 0 ? `，它最后说：“${clip(oneLine(outcome.text), 160)}”` : ''}。这个结果来自随后的一次普通调用。`, `The ${name} agent handed nothing in (${outcome.stop}, ${outcome.steps} steps)${outcome.text.length > 0 ? `; its last words: "${clip(oneLine(outcome.text), 160)}"` : ''}. This result is from the plain call made after it.`))
}

export interface Delegation {
  role: CrewRole
  /** The task, in words. */
  task: string
  /** What this is, for the list of the conversation's agents; the head of the task by default. */
  label?: string
  /** Tools for this task beside the ones every role reads the book with. */
  tools?: RoleTool[]
  /** The tool among them the work is handed in with, when it has one; otherwise the role reports in its last reply. */
  handIn?: string
  maxSteps?: number
  /** The line of the plot the task is on; see `Assignment.line`. */
  line?: string
  /** See `RoleTask.budgetNote`. */
  budgetNote?: (budget: { used: number; limit: number; left: number }) => string | undefined
  /** Asked when the agent stops; see `RoleTask.unfinished`. */
  unfinished?: () => string | undefined
}

export interface Delegated {
  /** What the role reported. */
  report: string
  run: CrewRun
  stop: 'completed' | 'max-tokens' | 'aborted' | 'refusal' | 'error'
}

/**
 * Give a role a task in words and wait for its report. There is no lesser way
 * to do this: a role that cannot run as an agent cannot take such a task.
 * @throws LlmCallError `NO_AGENT_LOOP` naming what the author can change.
 */
export async function delegate(core: NovelCore, runtime: ProjectRuntime, task: TaskContext, work: Delegation): Promise<Delegated> {
  const manifest = await runtime.project.manifest()
  const lang = promptLanguage(manifest.language)
  const route = await core.route(work.role, runtime, task)
  const plan = crewPlan(core, work.role, manifest)
  const name = crewName(work.role, lang)
  const roles = core.roles
  if (roles === undefined || !roles.can(route)) {
    throw new LlmCallError(L(lang, `${name}现在不能作为 agent 工作：它的模型 ${route.model} 是工坊直连的接口，进不了 Harness 的 agent 循环。在“设置 → 班底”里给${name}选一个 Harness「设置 → 模型」里的模型（或者让它跟随对话模型）。`, `${name} cannot work as an agent right now: its model ${route.model} is an endpoint the Studio calls directly and cannot run on the Harness's agent loop. Give ${name} a model from the Harness's Settings → Models in Settings → Crew (or let it follow the conversation's model).`), 'NO_AGENT_LOOP')
  }
  const label = work.label ?? clip(oneLine(work.task), 40)
  const skills = await crewSkills(work.role)
  const references = await referencesFor(core, runtime, work.role, lang, task.signal)
  const jotted = await jottingsFor(core, runtime, work.role, lang)
  const outcome = await core.through('text', async () => await roles.run({
    role: work.role,
    label: `${name} · ${label}`,
    persona: CREW[work.role].persona[lang === 'zh' ? 0 : 1],
    rules: `${work.handIn !== undefined
      ? `${crewRules(work.role, lang, manifest)}${jotted}`
      : `${crewRules(work.role, lang, manifest)}${jotted}\n${L(lang, '- 这件活没有专门的交回工具：做完之后，把结果写成你的最后一段回答——结论在前，依据在后，用到的出处列在最后。', '- This task has no tool to hand in with: when you are done, write the result as your last reply — conclusions first, what they rest on after, sources at the end.')}`}${references.brief}`,
    prompt: work.task,
    tools: [...bookTools(runtime, task.signal, work.line), ...references.tools, ...(work.tools ?? [])],
    ...(skills.length > 0 ? { skills } : {}),
    inherit: plan.inherit,
    route,
    maxSteps: work.maxSteps ?? plan.steps,
    ...(work.budgetNote !== undefined ? { budgetNote: work.budgetNote } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    ...(task.caller !== undefined ? { parent: task.caller } : {}),
    cwd: runtime.project.root,
    onStart: (ids) => { task.job?.crew({ role: work.role, label, by: 'agent', running: true, session: ids.session, ...(ids.parent !== undefined ? { parent: ids.parent } : {}) }) },
    onStep: (step) => { task.job?.write(stepLine(step)) },
    ...(work.unfinished !== undefined ? { unfinished: work.unfinished } : {}),
  }), { ...(task.signal !== undefined ? { signal: task.signal } : {}), retry: false }, runtime)
  task.signal?.throwIfAborted()
  const run: CrewRun = { role: work.role, label, by: 'agent', steps: outcome.steps, ...(outcome.session !== undefined ? { session: outcome.session } : {}), ...(outcome.parent !== undefined ? { parent: outcome.parent } : {}) }
  task.job?.crew(run)
  return { report: outcome.text, run, stop: outcome.stop }
}

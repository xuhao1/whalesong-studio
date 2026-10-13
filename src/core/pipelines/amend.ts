// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter gone through to one instruction — changed where it stands, never written again.
 *
 * The writer works on the chapter as an agent works on a file: it reads it, finds the sentences the instruction
 * touches, and changes them one place at a time with a tool (`find` → `replace`); what it does not touch is not
 * output, and so cannot drift. A writer whose model cannot run as an agent is asked once for the same thing as a list
 * of places, and the list is carried out here.
 *
 * What comes of it is not "the chapter revised" but the places that changed: each a proposal of its own, small enough
 * to read at a glance, taken or turned down one by one — or all of them at once.
 */
import { isPictureLine, keptPictures } from '../../shared/embedded'
import { MAIN_LINE, type MendReach, type FiguresKept, type PictureGuide, type PicturesRead, type PromptLanguage, type Proposal } from '../../shared/types'
import { changedParts, clip, countWords, fuzzyFind, newId, occurrences } from '../../shared/text'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { asArray, asRecord, asText, completeJson } from '../llm'
import { bookTools, stepLine } from '../crew'
import { amendCallSystem, amendCallTask, amendPersona, amendRules, amendTask } from '../prompts'
import { L, promptLanguage, renderStyle, withStyleExtra } from '../render'
import { argInt, argText, type RoleOutcome, type RoleTool } from '../roles'
import { errorMessage, isAbort } from '../util/async'
import { scheduleDigest } from './digest'
import { schedulePlanFollow } from './follow'
import { guidePictures, picturesRead } from './guides'
import { chapterContext, figuresOf, mendsBold, mendsBy, onPending, partedAs, requireChapter, settleTakenIn, shouldApply, takenIn } from './revise'

export interface AmendParams {
  chapter: string
  /** What is to change, in the author's words. */
  instruction: string
  /** Write the changes into the text at once instead of proposing them. */
  apply?: boolean
  /** The round of changes these places are of; one is made where none is given. */
  batchId?: string
  /** Pictures to go by, for this revision; the chapter's own where none are given. */
  guides?: PictureGuide[]
  /** The review issues this mends: every proposal says so. */
  issues?: string[]
  /** Go on from the changes that still wait for this chapter (see `ReviseChapterParams.onto`). */
  onto?: boolean
  /** Whose model goes through the chapter: the writer's, or the planner's. Left out: as the settings say (`mendBy`). */
  by?: 'writer' | 'planner'
  /**
   * How far the instruction is carried: through every place of the chapter it has a hold on, a place taking in what
   * has to move with it — or the least that answers it. Left out: as the settings say (`mendReach`).
   */
  reach?: MendReach
}

export interface AmendResult {
  chapterId: string
  title: string
  index: number
  applied: boolean
  /** The places that changed. */
  places: number
  /** One proposal a place — or one for the chapter, where what waited for it had to be taken in (`whole`). */
  proposalIds: string[]
  batchId?: string
  whole?: true
  wordsBefore: number
  wordsAfter: number
  /** What the writer said of its work: which places, and how it decided. */
  note: string
  /** `agent`: the writer went through the chapter with tools. `call`: one request for a list of places. */
  by: 'agent' | 'call'
  /** Whose model did it: the writer's, or — where the settings (or the caller) say so — the planner's. */
  who: 'writer' | 'planner'
  /** Tool calls the agent made. */
  steps?: number
  /** Why it was done in one request, when it was. */
  fellBack?: string
  /** Changes the writer asked for that could not be made, each as it was answered. */
  refused?: string[]
  pictures?: PicturesRead
  figures?: FiguresKept
}

/** One change asked for: the sentences as they stand, and what they become. */
interface Edit { find: string; replace: string; all?: boolean; why?: string }

/** One change made. */
interface Made { before: string; after: string; why?: string }

/** Past this share of a chapter, a "place" is the chapter: that is the other kind of revision. */
const PLACE_MOST = 0.6
/** Tool calls a writer may spend on one chapter before it is told to wrap up. */
const AMEND_STEPS = 80

/**
 * A text with one change made in it.
 * @throws an Error that says, to the model that asked, why the change cannot be made and what to do instead.
 */
function amended(text: string, edit: Edit, lang: PromptLanguage): { text: string; made: Made; times: number; at: number; length: number; back: number; own: number } {
  const find = edit.find
  if (find.trim().length === 0) throw new Error(L(lang, 'find 是空的：把要改的那几句从这一章里逐字抄进来。', '`find` is empty: copy into it, word for word, the sentences of the chapter to change.'))
  if (edit.all === true) {
    // A word changed throughout: as written, within a line, and never inside a picture's line (its path may hold the same name).
    const needle = text.includes(find) ? find : find.trim()
    if (needle.includes('\n') || edit.replace.includes('\n')) throw new Error(L(lang, 'all=true 是给一个词、一个称呼通篇替换用的：find 和 replace 都不能跨行。', 'all=true is for a word or a name changed throughout: neither `find` nor `replace` may run over a line break.'))
    if (isPictureLine(edit.replace)) throw new Error(L(lang, 'replace 里不要添图。', 'Add no picture in `replace`.'))
    let times = 0
    let at = -1
    let seen = 0
    const out = text.split('\n').map((line) => {
      const start = seen
      seen += line.length + 1
      if (isPictureLine(line)) return line
      const pieces = line.split(needle)
      if (pieces.length > 1 && at < 0) at = start + pieces[0]!.length
      times += pieces.length - 1
      return pieces.join(edit.replace)
    }).join('\n')
    if (times === 0) throw new Error(L(lang, `这一章里没有“${clip(needle, 40)}”：all=true 只照字面找。`, `"${clip(needle, 40)}" is nowhere in the chapter: all=true finds it as written only.`))
    if (out === text) throw new Error(L(lang, 'replace 和 find 一样：没有可改的。', '`replace` is the same as `find`: there is nothing to change.'))
    return { text: out, made: { before: needle, after: edit.replace, ...(edit.why !== undefined ? { why: edit.why } : {}) }, times, at, length: edit.replace.length, back: 0, own: 0 }
  }
  const range = fuzzyFind(text, find)
  if (range === undefined) {
    throw new Error(L(lang,
      `这一章现在的正文里找不到这一段：“${clip(find.trim(), 60)}”。find 要从正文里逐字照抄（改过的地方照改过的样子抄）；拿不准就先用 chapter_read 看那一带现在怎么写的。`,
      `This passage is not in the chapter as it reads now: "${clip(find.trim(), 60)}". \`find\` is copied word for word from the text (a place already changed, as it reads after the change); when unsure, look at that stretch with chapter_read first.`))
  }
  const matched = text.slice(range.start, range.end)
  const times = occurrences(text, matched)
  if (times > 1) {
    throw new Error(L(lang,
      `这一段在这一章里出现了 ${times} 次，定不了是哪一处：连它前面或后面的半句一起抄进 find。（同一个词要通篇换，用 all=true。）`,
      `This passage stands ${times} times in the chapter, so the place cannot be told: copy the half sentence before or after it into \`find\` too. (A word to change throughout: all=true.)`))
  }
  const whole = countWords(text)
  if (whole > 400 && countWords(matched) > whole * PLACE_MOST) {
    throw new Error(L(lang,
      '这一条圈了大半章：分成几处，一处一条地改。要求真的要整章重写时，不要硬改——交回时说明这一章得整章重写。',
      'This takes in most of the chapter: make it several places, an entry each. Where the instruction really needs the chapter written over, do not force it — say so when you hand in.'))
  }
  // The pictures that stood in the passage stay in it; one of the writer's own making comes out.
  // (Paragraphs parted as the chapter parts them, whatever way the model broke its lines.)
  const held = keptPictures(matched, partedAs(text, edit.replace))
  const lead = /^\s*/.exec(matched)![0]
  const trail = /\s*$/.exec(matched.slice(lead.length))![0]
  const body = held.text.trim()
  let head = text.slice(0, range.start)
  let tail = text.slice(range.end)
  let put = body.length > 0 ? `${lead}${body}${trail}` : ''
  if (body.length === 0) {
    // Taken out. Where the whole line went, the break it stood between goes with it — once.
    const lineStart = head.lastIndexOf('\n') + 1
    const next = tail.indexOf('\n')
    const lineEnd = next < 0 ? tail.length : next
    if (head.slice(lineStart).trim().length === 0 && tail.slice(0, lineEnd).trim().length === 0) {
      const left = head.slice(0, lineStart).replace(/\n+$/, '')
      const right = tail.slice(lineEnd).replace(/^\n+/, '')
      const breaks = Math.max(lineStart - left.length, tail.length - lineEnd - right.length)
      head = left
      tail = right
      put = left.length === 0 || right.length === 0 ? '' : '\n'.repeat(Math.max(1, breaks))
    }
  }
  const out = `${head}${put}${tail}`
  if (out === text) {
    throw new Error(held.made > 0
      ? L(lang, 'replace 里不要添图：正文里的图由作者来放。除了那张图，这一处和原文一样，没有改。', 'Add no picture in `replace`: the pictures of the text are the author\'s to place. But for that picture the place reads as it did, and nothing was changed.')
      : L(lang, 'replace 和原文一样：没有可改的。', '`replace` reads as the text does: there is nothing to change.'))
  }
  return { text: out, made: { before: matched, after: body, ...(edit.why !== undefined ? { why: edit.why } : {}) }, times: 1, at: head.length, length: put.length, back: held.back, own: held.made }
}

/** A place of a text, with a little of what stands on either side — plain, so that it can be copied from. */
function around(text: string, at: number, length: number, margin = 60): string {
  const from = Math.max(0, at - margin)
  const to = Math.min(text.length, at + length + margin)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/** What a model sent as one change. */
function readEdit(raw: unknown): Edit | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const find = typeof record.find === 'string' ? record.find : undefined
  if (find === undefined) return undefined
  const why = asText(record.why)
  // (An empty `replace` is a sentence taken out: it is read as given, not as missing.)
  return { find, replace: typeof record.replace === 'string' ? record.replace : '', ...(record.all === true || record.all === 'true' ? { all: true } : {}), ...(why !== undefined ? { why } : {}) }
}

/** Several changes handed in at once, as models send a list: a list, or the same written out as JSON. */
function severalOf(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The reasons given for the changes that made a place what it is. */
function whyOf(part: { before: string; after: string }, made: readonly Made[], lang: PromptLanguage): string | undefined {
  const within = (whole: string, piece: string): boolean => piece.trim().length >= 2 && whole.includes(piece.trim())
  const said = made.filter(change => change.why !== undefined && (within(part.after, change.after) || within(change.after, part.after) || within(part.before, change.before) || within(change.before, part.before))).map(change => change.why!)
  const all = [...new Set(said)]
  return all.length > 0 ? all.join(lang === 'zh' ? '；' : '; ') : undefined
}

export async function amendChapter(core: NovelCore, runtime: ProjectRuntime, params: AmendParams, task: TaskContext): Promise<AmendResult> {
  const { project } = runtime
  const found = await requireChapter(runtime, params.chapter)
  const { chapter } = found
  const apply = shouldApply(core, task, params.apply, false)
  // (Applied outright, the changes are to the text as it stands: nothing that waits is accepted on the author's behalf.)
  const based = params.onto === true && !apply ? await onPending(runtime, chapter.plan.id, found.text) : { text: found.text, used: [] as Proposal[] }
  task.job?.result({ chapterId: chapter.plan.id })
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // Who goes through the chapter: the writer — or the crew's model, where the author has the planner make such changes.
  // (Where the planner tells place by place who writes, a chapter gone through is its own work: it makes each change itself.)
  const who: 'writer' | 'planner' = params.by ?? (mendsBy(core, undefined, manifest) === 'writer' ? 'writer' : 'planner')
  const bold = mendsBold(core, params.reach, manifest)
  const role = who === 'planner' ? 'architect' as const : 'writer' as const
  const zhWho = who === 'planner' ? '策划' : '写手'
  const enWho = who === 'planner' ? 'planner' : 'writer'
  const route = await core.route(role, runtime, task)
  const guided = await guidePictures(core, runtime, route, params.guides ?? chapter.plan.guides, 'revise', task)
  const pack = await core.pack(runtime, route, {
    purpose: 'revise',
    chapter,
    brief: params.instruction,
    includeChapterText: true,
    // (Sent again with every step the agent takes: the chapters next to this one, not the book — which it can read.)
    limit: await chapterContext(core, runtime),
    ...(based.used.length > 0 ? { chapterText: based.text } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  })
  const base = { lang, language: manifest.language, title: manifest.title }
  const active = await project.activeStyle()
  const style = renderStyle(active, lang)
  const context = `${pack.text}${guided !== undefined ? `\n\n${guided.text}` : ''}`
  const words = countWords(based.text)
  const label = L(lang, `改第 ${chapter.index} 章`, `revising chapter ${chapter.index}`)

  // ── the chapter being worked on ──
  let working = based.text
  const made: Made[] = []
  let back = 0
  let own = 0
  const change = (edit: Edit): ReturnType<typeof amended> => {
    const done = amended(working, edit, lang)
    working = done.text
    made.push(done.made)
    back += done.back
    own += done.own
    return done
  }

  // ── asked once, for a list ──
  const refused: string[] = []
  const byCall = async (): Promise<string> => {
    const ask = async (more: string): Promise<{ edits: Edit[]; note: string }> => (await completeJson(core.llm, {
      route,
      system: withStyleExtra(amendCallSystem({ ...base, style, ...(bold ? { bold: true } : {}) }), active, lang, true),
      prompt: `${amendCallTask({ ...base, context, instruction: params.instruction })}${more}`,
      ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      onText: (_delta, total) => { task.job?.rewrite(total) },
      validate: (raw) => {
        const record = asRecord(raw)
        if (record === undefined || !Array.isArray(record.edits)) throw new Error('expected {"edits": [...], "note": "..."}')
        const edits = asArray(record.edits).map(readEdit)
        if (edits.some(edit => edit === undefined)) throw new Error('every entry of "edits" needs "find" (copied from the chapter) and "replace"')
        return { edits: edits as Edit[], note: asText(record.note) ?? '' }
      },
    })).value
    /** A list carried out on the chapter as it stood: what could not be made is said, entry by entry. */
    const carry = (edits: readonly Edit[]): { text: string; made: Made[]; back: number; own: number; wrong: string[] } => {
      let text = based.text
      const out = { made: [] as Made[], back: 0, own: 0, wrong: [] as string[] }
      edits.forEach((edit, at) => {
        try {
          const done = amended(text, edit, lang)
          text = done.text
          out.made.push(done.made)
          out.back += done.back
          out.own += done.own
        } catch (error) {
          out.wrong.push(L(lang, `第 ${at + 1} 条（“${clip(edit.find.trim(), 30)}”）：${errorMessage(error)}`, `Entry ${at + 1} ("${clip(edit.find.trim(), 30)}"): ${errorMessage(error)}`))
        }
      })
      return { text, ...out }
    }
    let answer = await ask('')
    let tried = carry(answer.edits)
    if (tried.wrong.length > 0) {
      // Said back once: the list is handed in again, whole. What still cannot be made then is left out, and named.
      task.signal?.throwIfAborted()
      const again = await ask(`\n\n---\n${L(lang,
        `你上一次交回的清单里，有 ${tried.wrong.length} 条照做不了：\n${tried.wrong.join('\n')}\n\n把整份清单改好，重新交一次——仍然照本章现有正文，从头依次改。`,
        `Of the list you handed in last, ${tried.wrong.length} entr${tried.wrong.length === 1 ? 'y' : 'ies'} could not be carried out:\n${tried.wrong.join('\n')}\n\nMend the whole list and hand it in again — still made on the chapter as it stands, one entry after another from the top.`)}`)
      const second = carry(again.edits)
      if (second.made.length >= tried.made.length) {
        answer = again
        tried = second
      }
    }
    working = tried.text
    made.splice(0, made.length, ...tried.made)
    back = tried.back
    own = tried.own
    refused.splice(0, refused.length, ...tried.wrong)
    return answer.note
  }

  // ── as an agent, a place at a time ──
  const names = { edit: 'chapter_edit', read: 'chapter_read', done: 'submit_revision' }
  let handed: string | undefined
  const tools: RoleTool[] = [
    {
      name: names.read,
      description: L(lang,
        '看这一章现在的正文——改过的地方是改过之后的样子。给 around（正文里的一句话）就看它前后那一带；不给就从 offset 起按页看。',
        'Read the chapter as it reads now — places already changed, as they read after the change. With `around` (a sentence of the text), the stretch on either side of it; without, a page from `offset`.'),
      parameters: {
        around: { type: 'string', description: L(lang, '正文里的一句话：看它前后各几百字。', 'A sentence of the text: a few hundred characters on either side of it.') },
        offset: { type: 'integer', description: L(lang, '从第几个字符起（默认 0）。', 'Character offset to start from (default 0).') },
        limit: { type: 'integer', description: L(lang, '最多返回多少字符（默认 6000，最多 40000）。', 'Most characters to return (default 6000, at most 40000).') },
      },
      run(args) {
        const near = argText(args.around)
        if (near !== undefined) {
          const range = fuzzyFind(working, near)
          if (range === undefined) throw new Error(L(lang, `这一章现在的正文里找不到“${clip(near, 40)}”。不给 around，从头按页看。`, `"${clip(near, 40)}" is not in the chapter as it reads now. Leave \`around\` out and read it by the page.`))
          return around(working, range.start, range.end - range.start, 600)
        }
        const offset = Math.max(0, argInt(args.offset) ?? 0)
        const limit = Math.min(40_000, Math.max(200, argInt(args.limit) ?? 6000))
        const page = working.slice(offset, offset + limit)
        const rest = working.length - offset - page.length
        return `${page}${rest > 0 ? L(lang, `\n\n（后面还有 ${rest} 个字符：offset=${offset + page.length} 接着看。）`, `\n\n(${rest} more characters follow: go on with offset=${offset + page.length}.)`) : ''}`
      },
    },
    {
      name: names.edit,
      description: L(lang,
        '改这一章：find 是要改的那几句（从这一章现在的正文里逐字照抄，只能对得上一处），replace 是它改成的样子。replace 留空就是删掉这几句。改动当场落在这一章上。几处都想好了，就放进 edits 一次交上来（一处一条，照先后依次改）——比一处一次来回省得多；回答里逐条说改成了没有。',
        'Change the chapter: `find` is the sentences to change (copied word for word from the chapter as it reads now; it has to stand in one place only), `replace` is what they become. An empty `replace` takes the sentences out. The change is made in the chapter at once. Where several places are settled, hand them in together in `edits` (an entry a place, made in the order given) — far fewer round trips than a call a place; the answer says of each whether it was made.'),
      parameters: {
        find: { type: 'string', description: L(lang, '要改的那几句，逐字照抄。越短越好，但要在这一章里只出现一次。（只改一处时用；几处用 edits。）', 'The sentences to change, word for word. As short as will do — and found once only in the chapter. (For one place; several go in `edits`.)') },
        replace: { type: 'string', description: L(lang, '它改成的样子。空字符串 = 删掉。', 'What they become. An empty string takes them out.') },
        all: { type: 'boolean', description: L(lang, '同一个词、同一个称呼通篇替换：find 照字面找，出现几处换几处。', 'A word or a name changed throughout: `find` is found as written, and every place it stands is changed.') },
        why: { type: 'string', description: L(lang, '一句话：为什么改这一处（作者在这条改动上看到的就是它）。', 'One sentence: why this place is changed (what the author reads beside the change).') },
        edits: {
          type: 'array',
          description: L(lang, '几处一起改：每条和单独改一处时一样（find、replace，可带 all、why）。', 'Several places at once: each entry as one place alone would be (`find`, `replace`, and `all` / `why` where wanted).'),
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              find: { type: 'string', required: true },
              replace: { type: 'string', required: true },
              all: { type: 'boolean' },
              why: { type: 'string' },
            },
          },
        },
      },
      run(args) {
        const several = severalOf(args.edits)
        if (several !== undefined && several.length > 0) {
          // Each as it would be alone, in the order given: what was made stands, what was not is said with why.
          let wrong = 0
          const lines = several.map((raw, at) => {
            const entry = readEdit(raw)
            try {
              if (entry === undefined) throw new Error(L(lang, '要给 find 和 replace。', 'Give `find` and `replace`.'))
              const done = change(entry)
              return `${at + 1}. ${entry.all === true ? L(lang, `换了 ${done.times} 处`, `changed in ${done.times} place(s)`) : done.made.after.length === 0 ? L(lang, '删掉了', 'taken out') : L(lang, '改好了', 'changed')}`
            } catch (error) {
              wrong += 1
              return `${at + 1}. ✗ ${errorMessage(error)}`
            }
          })
          if (wrong === several.length) throw new Error(`${L(lang, '这几条都没改成：', 'None of these was made:')}\n${lines.join('\n')}`)
          return `${lines.join('\n')}\n${wrong === 0
            ? L(lang, `${several.length} 处都改好了。`, `All ${several.length} made.`)
            : L(lang, `${several.length - wrong} 处改好了，${wrong} 处没改成：照上面说的把这 ${wrong} 条改好再交（改好的不用重交）。`, `${several.length - wrong} made, ${wrong} not: mend those ${wrong} as said above and hand them in again (what was made stands).`)}`
        }
        const edit = readEdit(args)
        if (edit === undefined) throw new Error(L(lang, '要给 find（要改的那几句）和 replace（改成的样子）。', 'Give `find` (the sentences to change) and `replace` (what they become).'))
        const done = change(edit)
        if (edit.all === true) {
          return L(lang, `换了 ${done.times} 处。头一处现在是：\n${around(working, done.at, done.length)}`, `Changed in ${done.times} place(s). The first now reads:\n${around(working, done.at, done.length)}`)
        }
        const kept = done.back > 0 ? L(lang, `（这几句里的 ${done.back} 张图留在原处。）`, ` (The ${done.back} picture(s) among these sentences stay where they stood.)`) : ''
        return done.made.after.length === 0
          ? L(lang, `删掉了。${kept}这一带现在是：\n${around(working, done.at, done.length)}`, `Taken out.${kept} The stretch now reads:\n${around(working, done.at, done.length)}`)
          : L(lang, `改好了。${kept}这一处现在是：\n${around(working, done.at, done.length)}`, `Changed.${kept} The place now reads:\n${around(working, done.at, done.length)}`)
      },
    },
    {
      name: names.done,
      description: L(lang,
        '交回这件活：改完了（或者看过之后不需要改、或者这一章得整章重写）就调用它。交回之后这件活就结束了。',
        'Hand the work in: call it when the changes are made (or when, having read it, the chapter needs none, or has to be written over whole). Handing in ends the work.'),
      parameters: {
        note: { type: 'string', required: true, description: L(lang, '一两句话：改了哪几处、怎么取舍的；没改的话为什么。', 'A sentence or two: which places were changed and how you decided; where nothing was, why.') },
      },
      closing: true,
      final: true,
      run(args) {
        handed = argText(args.note) ?? ''
        return L(lang, '收到。', 'Received.')
      },
    },
  ]

  let by: 'agent' | 'call' = 'call'
  let steps: number | undefined
  let fellBack: string | undefined
  let note = ''
  const roles = core.roles
  if (roles === undefined || !roles.can(route)) {
    fellBack = L(lang,
      `${zhWho}的模型 ${route.model} 是工坊直连的接口，当不了 agent：这次是一次请求，${zhWho}交回一份改动清单，由工坊照着改。`,
      `The ${enWho}'s model ${route.model} is an endpoint the Studio calls directly and cannot run as an agent: this was one request — the ${enWho} handed in a list of changes, and the Studio made them.`)
    note = await byCall()
    task.job?.crew({ role, label, by: 'call', note: fellBack })
  } else {
    // One piece of work is one place at the gate, however many steps its agent takes.
    let outcome: RoleOutcome | undefined
    let broke: unknown
    try {
      outcome = await core.through('text', async () => await roles.run({
        role,
        label: L(lang, `${zhWho} · ${label}`, `${who === 'planner' ? 'Planner' : 'Writer'} · ${label}`),
        persona: amendPersona(base),
        rules: withStyleExtra(amendRules({ ...base, style, ...names, ...(bold ? { bold: true } : {}) }), active, lang, true),
        prompt: amendTask({ ...base, context, instruction: params.instruction, index: chapter.index, chapter: chapter.plan.title, words, edit: names.edit, done: names.done }),
        ...(guided !== undefined && guided.images.length > 0 ? { images: guided.images } : {}),
        tools: [...bookTools(runtime, task.signal, chapter.line ?? MAIN_LINE), ...tools],
        inherit: { mode: 'none' },
        route,
        maxSteps: AMEND_STEPS,
        ...(task.signal !== undefined ? { signal: task.signal } : {}),
        ...(task.caller !== undefined ? { parent: task.caller } : {}),
        cwd: project.root,
        onStart: (ids) => { task.job?.crew({ role, label, by: 'agent', running: true, session: ids.session, ...(ids.parent !== undefined ? { parent: ids.parent } : {}) }) },
        onStep: (step) => { task.job?.write(stepLine(step)) },
        budgetNote: budget => L(lang,
          `还剩 ${budget.left} 次工具调用：已经改的都算数。把手上这几处改完就调用 ${names.done}。`,
          `${budget.left} tool calls are left: what is changed already stands. Finish the places in hand and call ${names.done}.`),
        unfinished: () => handed === undefined ? L(lang, `这件活还没有交回：改完了就调用 ${names.done}，用一两句话说改了哪几处。`, `The work has not been handed in: when the changes are made, call ${names.done} and say in a sentence or two which places you changed.`) : undefined,
      }), { ...(task.signal !== undefined ? { signal: task.signal } : {}), retry: false }, runtime)
    } catch (error) {
      if (isAbort(error) || task.signal?.aborted === true) throw error
      broke = error
      core.log(`the ${enWho} agent failed on "${label}"`, error)
    }
    task.signal?.throwIfAborted()
    const ran = outcome !== undefined ? { steps: outcome.steps, ...(outcome.session !== undefined ? { session: outcome.session } : {}), ...(outcome.parent !== undefined ? { parent: outcome.parent } : {}) } : {}
    if (handed !== undefined || made.length > 0) {
      // What it changed stands, handed in or not: a run that broke off after ten places has still changed ten places.
      by = 'agent'
      steps = outcome?.steps
      const cutOff = handed === undefined
        ? broke !== undefined
          ? L(lang, `${zhWho}的 agent 中途断了（${clip(errorMessage(broke), 160)}）：已经改的 ${made.length} 处留着，可能没有改完。`, `The ${enWho} agent broke off (${clip(errorMessage(broke), 160)}): the ${made.length} change(s) it had made stand, and it may not have finished.`)
          : L(lang, `${zhWho}没有交回就停了（${outcome?.stop ?? 'stopped'}）：已经改的 ${made.length} 处留着，可能没有改完。`, `The ${enWho} stopped without handing in (${outcome?.stop ?? 'stopped'}): the ${made.length} change(s) it had made stand, and it may not have finished.`)
        : undefined
      note = handed !== undefined && handed.length > 0 ? handed : cutOff ?? ''
      task.job?.crew({ role, label, by: 'agent', ...ran, ...(cutOff !== undefined ? { note: cutOff } : {}) })
    } else {
      // Nothing changed and nothing said: asked once, the plain way.
      const why = broke !== undefined ? clip(errorMessage(broke), 200) : `${outcome?.stop ?? 'stopped'}, ${outcome?.steps ?? 0}`
      fellBack = L(lang, `${zhWho}的 agent 没能把这件活做下来（${why}）：改成一次请求，${zhWho}交回改动清单，由工坊照着改。`, `The ${enWho} agent did not get the work done (${why}): asked in one request instead — the ${enWho} handed in a list of changes, and the Studio made them.`)
      task.job?.write(`\n${fellBack}\n`)
      note = await byCall()
      task.job?.crew({ role, label, by: 'call', ...ran, note: fellBack })
    }
  }
  task.signal?.throwIfAborted()

  // ── what came of it ──
  // (Held against the chapter once more, whole: no picture is lost to a change, however it was made.)
  const held = keptPictures(based.text, working)
  const after = held.text
  const figures = figuresOf({ back: back + held.back, made: own + held.made })
  const read = guided !== undefined ? { pictures: picturesRead(guided)! } : {}
  const result: AmendResult = {
    chapterId: chapter.plan.id,
    title: chapter.plan.title,
    index: chapter.index,
    applied: false,
    places: 0,
    proposalIds: [],
    wordsBefore: words,
    wordsAfter: countWords(after),
    note,
    by,
    who,
    ...(steps !== undefined ? { steps } : {}),
    ...(fellBack !== undefined ? { fellBack } : {}),
    ...(refused.length > 0 ? { refused: [...refused] } : {}),
    ...read,
    ...figures,
  }
  if (after === based.text) {
    task.job?.result({ chapterId: chapter.plan.id, places: 0, proposalIds: [], note, who })
    return result
  }
  const parts = changedParts(based.text, after, stretch => occurrences(based.text, stretch) === 1)
  result.places = parts.length
  if (apply) {
    await project.saveChapterText(chapter.plan.id, after, { reason: 'before-revise', status: chapter.plan.status === 'final' ? 'final' : 'revised' })
    scheduleDigest(core, runtime, chapter.plan.id, task)
    // (Written in at once, it is a change accepted: the chapter's plan follows it as it follows an accepted proposal.)
    schedulePlanFollow(core, runtime, chapter.plan.id, task)
    result.applied = true
  } else {
    const batchId = params.batchId ?? newId('batch')
    const common = { chapterId: chapter.plan.id, instruction: params.instruction, createdBy: task.origin, wroteBy: who, batchId, ...read, ...figures }
    // A place stands by itself where it is a place of the book's own text — not of something a waiting change wrote.
    const places = parts.map((part) => {
      const at = based.used.length === 0 ? part.start : found.text.indexOf(part.before)
      return { part, at }
    })
    const alone = parts.length > 0 && (based.used.length === 0 || (based.used.every(proposal => proposal.kind === 'span') && places.every(place => place.at >= 0 && occurrences(found.text, place.part.before) === 1)))
    if (alone) {
      for (const { part, at } of places) {
        const why = whyOf(part, made, lang)
        const proposal = await project.addProposal({ ...common, kind: 'span', before: part.before, after: part.after, at, ...(why !== undefined ? { rationale: why } : {}), ...(params.issues !== undefined && params.issues.length > 0 ? { issues: params.issues } : {}) })
        result.proposalIds.push(proposal.id)
      }
    } else {
      // On top of what waited: one proposal for the chapter, with those changes and these in it.
      const taken = await takenIn(runtime, based.used, params.issues, lang)
      const proposal = await project.addProposal({ ...common, kind: 'chapter', before: found.text, after, ...(note.length > 0 ? { rationale: note } : {}), ...taken.carried })
      await settleTakenIn(runtime, taken.settle, proposal.id)
      result.proposalIds.push(proposal.id)
      result.whole = true
    }
    result.batchId = batchId
  }
  task.job?.result({ chapterId: chapter.plan.id, places: result.places, proposalIds: result.proposalIds, ...(result.batchId !== undefined ? { batchId: result.batchId } : {}), ...(result.proposalIds.length === 1 ? { proposalId: result.proposalIds[0] } : {}), note, who, ...(result.applied ? { applied: true } : {}) })
  return result
}

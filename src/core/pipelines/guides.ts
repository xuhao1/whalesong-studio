// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures that steer the story.
 *
 * The author gives a few pictures to a stretch of plot being planned or a
 * chapter being written — a moment they see, a face, a place, a mood — and
 * whoever does the work goes by them. Best is that the model doing the work
 * looks at them itself: where it takes pictures, they go to it with the task.
 * Where it does not, a model set up to look at pictures says in words what
 * each shows, once, and those words go into the task instead. Either way the
 * task says which pictures there are, what the book knows of each, and what
 * the author said of it.
 *
 * Pictures reach a model the way DSH sends them (its attachment service, its
 * providers' adapters); the Studio only says which model is to look.
 */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { clip } from '../../shared/text'
import type { IllustrationInfo, ModelRoute, PictureGuide, PicturesRead, PromptLanguage } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import type { LlmImage } from '../llm'
import { ProjectError } from '../project'
import { L, promptLanguage } from '../render'
import { isAbort } from '../util/async'

/** The most pictures one piece of work is given: a figure to stop a slip of the hand; a model's own limit is its provider's to say. */
export const GUIDES_MOST = 12

const MEDIA: Record<string, LlmImage['mediaType']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** Pictures being looked at right now, by what is asked of whom: several pieces of work given the same picture at once (a comparison) have it looked at once. */
const looking = new Map<string, Promise<string>>()

/** What the pictures given to a piece of work come to: what goes into its task, and — for a model that sees — the pictures themselves. */
export interface GuidedPictures {
  guides: PictureGuide[]
  /** The pictures, in the order the words speak of them; empty where the working model was told of them in words instead. */
  images: LlmImage[]
  /** The section of the task that tells of them. */
  text: string
  /**
   * Who looked at them: the model that does the work (`self`), or the one set up to look at pictures (`vision`) —
   * or nobody (`titles`): the working model takes none, no model is set up to look, and the work goes by what each
   * picture is called.
   */
  by: 'self' | 'vision' | 'titles'
  /** The model that looked, where it was not the working one. */
  model?: string
  /** `titles`: how many of them have nothing to be called by — no record in the book, no word of the author's. */
  untitled?: number
  /** What the author should know of how they were read: the working model does not say whether it sees, and was sent them all the same. */
  unsure?: true
}

/** How the pictures were read, in the few words a result carries. */
export function picturesRead(guided: GuidedPictures | undefined): PicturesRead | undefined {
  return guided !== undefined ? { count: guided.guides.length, by: guided.by, ...(guided.model !== undefined ? { model: guided.model } : {}), ...(guided.unsure === true ? { unsure: true as const } : {}), ...(guided.untitled !== undefined && guided.untitled > 0 ? { untitled: guided.untitled } : {}) } : undefined
}

/** The same, said beside the name of the step that goes by them — so that whoever watches the work reads who is looking. */
export function picturesLabel(guided: GuidedPictures | undefined, lang: PromptLanguage): string {
  if (guided === undefined) return ''
  const count = guided.guides.length
  if (guided.by === 'titles') return L(lang, `（${count} 张参考图：模型看不了图，只照图的标题）`, ` (${count} picture(s): the model takes none, and goes by what they are called)`)
  if (guided.by === 'vision') return L(lang, `（${count} 张参考图，由 ${guided.model ?? '看图的模型'} 看成了文字）`, ` (${count} picture(s), put into words by ${guided.model ?? 'the picture model'})`)
  return guided.unsure === true
    ? L(lang, `（${count} 张参考图发给了模型——它没有声明能不能看图）`, ` (${count} picture(s) sent to the model — it does not say whether it sees them)`)
    : L(lang, `（${count} 张参考图，模型自己看）`, ` (${count} picture(s), looked at by the model itself)`)
}

/** Guides as they may be used: paths inside the book's own assets, each once, with what was said of it. */
export function cleanGuides(guides: readonly unknown[] | undefined): PictureGuide[] {
  const out: PictureGuide[] = []
  for (const raw of guides ?? []) {
    const item = typeof raw === 'string' ? { path: raw } : (raw ?? {}) as { path?: unknown; note?: unknown }
    const path = typeof item.path === 'string' ? item.path.trim().replace(/\\/g, '/') : ''
    if (path.length === 0 || !path.startsWith('assets/') || path.split('/').includes('..') || MEDIA[extname(path).toLowerCase()] === undefined) continue
    if (out.some(guide => guide.path === path)) continue
    const note = typeof item.note === 'string' ? item.note.trim() : ''
    out.push({ path, ...(note.length > 0 ? { note } : {}) })
  }
  return out.slice(0, GUIDES_MOST)
}

const KIND: Record<IllustrationInfo['kind'], [string, string]> = {
  portrait: ['立绘', 'portrait'],
  sheet: ['人设图', 'design sheet'],
  scene: ['章节插图', 'chapter illustration'],
  location: ['地点设定图', 'art of a place'],
  item: ['物品设定图', 'art of a thing'],
  cover: ['封面', 'cover'],
  panel: ['分镜画面', 'storyboard panel'],
  background: ['背景', 'backdrop'],
  sprite: ['人像', 'figure'],
}

/** What a piece of work the author gives pictures to is; see {@link guidePictures}. */
/**
 * What pictures are handed over for. `look` is the showrunner looking at pictures of the book the author pointed at:
 * nothing is written from them, they are only to be seen.
 */
export type GuidePurpose = 'plot' | 'chapter' | 'whatif' | 'revise' | 'passage' | 'look'

/** What a model that looks for another is asked: what is to be seen, for whoever writes from it. */
function lookTask(lang: PromptLanguage, input: { title: string; known?: string; note?: string; cast: string }): string {
  return L(lang, `这张图是作者给小说《${input.title}》的一段剧情选的参考图。把图里看得见的写下来，交给照着它写这段剧情的人。
${input.known !== undefined ? `\n它在书里的记录：${input.known}` : ''}${input.note !== undefined ? `\n作者说：${input.note}` : ''}${input.cast.length > 0 ? `\n\n书里的人物（认得出图里是谁就写名字）：\n${input.cast}` : ''}

写：画面里有谁、在哪里、在做什么、神态和姿势、衣着、光线和气氛，以及值得写进故事的细节；图里有字的，把字原样抄下来。只写看得见的，图里没有的不必说没有；200 字以内，直接写，不要开场白。`, `The author chose this picture to steer a stretch of the novel "${input.title}". Write down what is to be seen in it, for whoever writes that stretch from it.
${input.known !== undefined ? `\nWhat the book records of it: ${input.known}` : ''}${input.note !== undefined ? `\nThe author says: ${input.note}` : ''}${input.cast.length > 0 ? `\n\nThe people of the book (name whoever you recognise):\n${input.cast}` : ''}

Write who is in it, where, doing what, how they hold themselves and look, what they wear, the light and the mood, and any detail worth a place in the story; where the picture has writing in it, copy the writing as it stands. Only what can be seen, and nothing about what is not there; 120 words at most, straight to it.`)
}

/**
 * Make ready the pictures the author gave to a piece of work.
 * @param route - the model that does the work: it looks itself where it takes pictures.
 * @param purpose - what the work is: `plot` — chapters to come are planned by them; `chapter` — one chapter is written by
 *   them; `whatif` — ways the story could go are weighed with them; `revise` — text there is is rewritten by them (a
 *   chapter, or the scope of a revision of the book); `passage` — one passage is.
 * @returns undefined where there are none.
 * @throws ProjectError `novel/invalid` for a picture that is not there; `novel/no-vision` where the model set up to
 *   look at pictures takes none itself, or fails at one. (A working model that takes none, with nobody set up to look,
 *   is no error: the work goes by what the pictures are called — `by: 'titles'`.)
 */
export async function guidePictures(core: NovelCore, runtime: ProjectRuntime, route: ModelRoute | undefined, given: readonly unknown[] | undefined, purpose: GuidePurpose, task: TaskContext): Promise<GuidedPictures | undefined> {
  const guides = cleanGuides(given)
  if (guides.length === 0) return undefined
  const { project } = runtime
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  const zh = lang === 'zh'
  const [records, characters] = await Promise.all([project.pictures().catch(() => [] as IllustrationInfo[]), project.characters()])
  const nameOf = (id: string | undefined): string | undefined => (id !== undefined ? characters.find(card => card.id === id)?.name ?? id : undefined)
  const pictures: { guide: PictureGuide; image: LlmImage; known?: string }[] = []
  for (const guide of guides) {
    let data: Buffer
    try {
      data = await project.readFile(guide.path)
    } catch {
      throw new ProjectError('novel/invalid', L(lang, `参考图不在书里了：${guide.path}`, `a picture given as a guide is no longer in the book: ${guide.path}`))
    }
    const record = records.find(item => item.path === guide.path)
    // What the book itself knows of one of its own pictures: its kind, whose it is, the moment it shows.
    const known = record !== undefined ? [L(lang, ...KIND[record.kind]), nameOf(record.target), record.moment?.title].filter((part): part is string => part !== undefined && part.length > 0).join(' · ') : undefined
    pictures.push({ guide, image: { data: new Uint8Array(data), mediaType: MEDIA[extname(guide.path).toLowerCase()]!, name: guide.path.split('/').at(-1)! }, ...(known !== undefined && known.length > 0 ? { known } : {}) })
  }

  // (A model nobody could name — a conversation's own, not told to the tool — is one that does not say whether it sees.)
  const working = route === undefined ? undefined : route.baseURL !== undefined ? false : await core.llm.sees?.(route).catch(() => undefined)
  const count = pictures.length
  // What the pictures are for, said once at the head of what tells of them; where they and the book disagree, the book holds.
  const use: Record<GuidePurpose, [string, string]> = {
    plot: [`作者挑了 ${count} 张图来引导接下来的剧情：每张图是故事里要出现的一幕、一个人、一个地方或一种气氛。把它们安排进这几章。`, `The author chose ${count} picture(s) to steer what comes next: each is a moment, a person, a place or a mood the story is to have. Work them into these chapters.`],
    chapter: [`作者给这一章挑了 ${count} 张参考图：把图里的画面——人、地方、动作、光线和气氛——写进正文里它该在的地方。`, `The author chose ${count} picture(s) for this chapter: write what they show — people, place, action, light and mood — into the text where it belongs.`],
    whatif: [`作者给这次假设推演配了 ${count} 张图：每条走向都把图里的人、地方和画面算进去——它们是作者想看到的东西。`, `The author gave ${count} picture(s) to this what-if: every way the story could go takes the people, places and moments they show into account — they are what the author wants to see.`],
    revise: [`作者给这次修订配了 ${count} 张图：改的地方照着图里的画面来——人、地方、动作、光线和气氛。`, `The author gave ${count} picture(s) to this revision: what is changed goes by what they show — people, place, action, light and mood.`],
    passage: [`作者给这一段的改写配了 ${count} 张图：把这一段改成图里的样子——人、地方、动作、光线和气氛；这一段之外的不动。`, `The author gave ${count} picture(s) to the rewriting of this passage: make the passage what they show — people, place, action, light and mood; nothing outside the passage changes.`],
    look: [`这本书里的 ${count} 张图，作者要你看。`, `${count} picture(s) of this book, which the author wants you to look at.`],
  }
  const head = purpose === 'look' ? L(lang, ...use[purpose]) : `${L(lang, ...use[purpose])}${L(lang, '图里和设定、前文对不上的地方，以设定和前文为准。', ' Where a picture and the bible or the story so far disagree, the bible and the story hold.')}`
  const line = (at: number, extra?: string): string => {
    const { guide, known } = pictures[at]!
    // Only looked at: each is named by where it is in the book, which is how it is asked for again.
    if (purpose === 'look') return `${at + 1}. ${guide.path}${known !== undefined ? ` 〔${known}〕` : ''}${extra !== undefined ? `\n   ${extra}` : ''}`
    return `${at + 1}. ${known !== undefined ? `〔${known}〕` : ''}${guide.note !== undefined ? L(lang, `作者说：${guide.note}`, `The author says: ${guide.note}`) : known === undefined && extra === undefined ? L(lang, '（作者没有另外说明）', '(nothing said of it)') : ''}${extra !== undefined ? `\n   ${extra}` : ''}`
  }
  const title = purpose === 'look' ? L(lang, '## 这本书里的图', '## Pictures of the book') : L(lang, '## 作者给的参考图', '## Pictures from the author')

  const vision = working === true ? undefined : await core.visionRoute(runtime)
  if (working === true || vision === undefined) {
    // A model that says it takes no pictures, and nobody set up to look for it: the work is not refused for that —
    // it goes by what each picture is called (what the book records of it, what the author said of it), and is told
    // that this is all it has. (A model set up to look is the author's way to have them read; it is not required.)
    if (working === false) {
      const untitled = pictures.filter(item => item.known === undefined && item.guide.note === undefined).length
      return {
        guides,
        images: [],
        text: `${title}\n\n${head}\n${L(lang, '你看不到图本身，也没有人替你看：下面只有每张图的标题——它在书里是什么、作者对它说了什么。照这些来，图里别的细节不要编。', 'You are not shown the pictures, and nobody looked at them for you: below is only what each is called — what the book records of it, what the author said of it. Go by that, and make up nothing of what they might show.')}\n\n${pictures.map((_item, at) => line(at)).join('\n')}`,
        by: 'titles',
        ...(untitled > 0 ? { untitled } : {}),
      }
    }
    return {
      guides,
      images: pictures.map(item => item.image),
      text: `${title}\n\n${head}\n${L(lang, '图按下面的次序附在这条消息里。', 'The pictures are attached to this message in this order.')}\n\n${pictures.map((_item, at) => line(at)).join('\n')}`,
      by: 'self',
      ...(working === undefined ? { unsure: true as const } : {}),
    }
  }

  // The working model cannot look (or does not say that it can): the one set up for it does, a picture at a time.
  if (await core.llm.sees?.(vision).catch(() => undefined) === false) {
    throw new ProjectError('novel/no-vision', L(lang, `配来看图的模型（${vision.model}）自己看不了图：到“设置 → 模型”里换一个。`, `the model set up to look at pictures (${vision.model}) takes none itself: choose another under Settings → Models.`))
  }
  const cast = characters.filter(card => card.role !== 'cameo').slice(0, 30).map(card => `- ${card.name}${card.gender !== undefined ? `，${card.gender}` : ''}${card.appearance !== undefined && card.appearance.trim().length > 0 ? `${zh ? '：' : ': '}${clip(card.appearance.trim(), 80)}` : ''}`).join('\n')
  const seen: Record<string, { text: string; model: string }> = (await project.readState<Record<string, { text: string; model: string }>>('guide-notes.json')) ?? {}
  const told: string[] = []
  let learned = false
  for (const [at, item] of pictures.entries()) {
    task.signal?.throwIfAborted()
    // Seen once by this model with this said of it, it is not looked at again.
    const key = createHash('sha1').update(item.image.data).update(`\n${vision.provider}/${vision.model}\n${item.guide.note ?? ''}\n${item.known ?? ''}`).digest('hex').slice(0, 20)
    let text = seen[key]?.text
    if (text === undefined) {
      task.job?.progress(at, pictures.length, L(lang, `看图的模型在看第 ${at + 1} / ${pictures.length} 张参考图…`, `the picture model is looking at picture ${at + 1} of ${pictures.length}…`))
      try {
        const shared = `${project.root}|${key}`
        let underway = looking.get(shared)
        if (underway === undefined) {
          underway = core.llm.complete({
            route: vision,
            system: L(lang, '你替一位小说作者看图：把一张参考图里看得见的东西写成文字，交给写作的人。', 'You look at pictures for a novelist: you put what can be seen in a reference picture into words, for whoever writes from it.'),
            prompt: lookTask(lang, { title: manifest.title, ...(item.known !== undefined ? { known: item.known } : {}), ...(item.guide.note !== undefined ? { note: item.guide.note } : {}), cast }),
            images: [item.image],
            ...(task.signal !== undefined ? { signal: task.signal } : {}),
          }).then(response => response.text.trim())
          looking.set(shared, underway)
          const mine = underway
          void underway.catch(() => undefined).then(() => { if (looking.get(shared) === mine) looking.delete(shared) })
        }
        text = await underway
      } catch (error) {
        if (isAbort(error) || task.signal?.aborted === true) throw error
        throw new ProjectError('novel/no-vision', L(lang, `看图的模型（${vision.model}）没能看第 ${at + 1} 张参考图：${error instanceof Error ? error.message : String(error)}`, `the picture model (${vision.model}) could not look at picture ${at + 1}: ${error instanceof Error ? error.message : String(error)}`))
      }
      seen[key] = { text, model: `${vision.provider}/${vision.model}` }
      learned = true
    }
    told.push(text)
  }
  // Added to what the file holds now: another piece of work may have looked at other pictures meanwhile.
  if (learned) await project.updateState<Record<string, { text: string; model: string }>>(['guide-notes.json'], {}, current => ({ ...current, ...seen })).catch(() => {})
  return {
    guides,
    images: [],
    text: `${title}\n\n${head}\n${L(lang, '你看不到图本身：下面每张图后面，是看图的模型看到的。', 'You are not shown the pictures themselves: after each is what a model that looked at it saw.')}\n\n${pictures.map((_item, at) => line(at, L(lang, `图里：${told[at]}`, `In the picture: ${told[at]}`))).join('\n')}`,
    by: 'vision',
    model: vision.model,
  }
}

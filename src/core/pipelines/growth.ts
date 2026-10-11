// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Growth: a character along the time of the book.
 *
 * A card that says one age and one face says it of no chapter in particular.
 * The planner — an agent with the book to read — finds how old somebody is as
 * they enter and the points where they turn afterwards (years older, another
 * station, another look), and each point opens a stretch of their life
 * (`CharacterStage`) that the card keeps: the writer is told which one holds
 * at the chapter being written, and a picture of a chapter shows them as that
 * stretch has them.
 */
import { stageAt } from '../../shared/stages'
import { clip, newId } from '../../shared/text'
import { MAIN_LINE, type CharacterCard, type CharacterStage } from '../../shared/types'
import type { NovelCore, ProjectRuntime, TaskContext } from '../core'
import { assign } from '../crew'
import { asArray, asRecord, asText } from '../llm'
import { ProjectError } from '../project'
import { architectSystem, growthTask } from '../prompts'
import { L, promptLanguage, renderCharacter } from '../render'

/**
 * Have the planner find the stretches of a character's life in the book and
 * keep them on the card. Looked over again, a stretch that still holds keeps
 * its id, its look as written for pictures, and the pictures drawn of it.
 * @param params.direction - what the author asks: it guides the planner.
 * @returns the stretches; none where the planner found nothing to say — the card is then left as it was.
 */
export async function deriveGrowth(core: NovelCore, runtime: ProjectRuntime, params: { character: string; direction?: string; plain?: boolean }, task: TaskContext): Promise<{ card: CharacterCard; stages: CharacterStage[] }> {
  const { project } = runtime
  const card = await project.findCharacter(params.character)
  if (card === undefined) throw new ProjectError('novel/not-found', `no character matches "${params.character}"`)
  const manifest = await project.manifest()
  const lang = promptLanguage(manifest.language)
  // Along the line this person is of: in a world of several stories, theirs is read, counted in its own chapters.
  const home = await project.lineOfCharacter(card)
  const along = home !== MAIN_LINE ? home : undefined
  const lineTitle = along !== undefined ? (await project.findLine(along))?.title : undefined
  const { chapters, lives } = await project.lives(along)
  const plans = new Map((await project.chapters(along)).map(chapter => [chapter.plan.id, chapter.plan]))
  // How the text showed them in a chapter — age, face, dress — as the digests wrote it down: where somebody turns, it is here.
  const looked = new Map<number, string>()
  const { whose } = await project.castResolver()
  const located = await project.chapters(along)
  for (const { chapter, memory } of await project.memories(located)) {
    const seen = memory.characters.filter(moment => whose(moment, chapter.plan.id) === card.id).map(moment => moment.seen).filter((text): text is string => text !== undefined && text.trim().length > 0)
    if (seen.length > 0) looked.set(chapter.index, clip(seen.join('；'), 200))
  }
  const record = (lives[card.id]?.events ?? []).filter(event => event.index >= 1).map(event => [
    L(lang, `第 ${event.index} 章`, `Chapter ${event.index}`),
    event.what !== undefined ? L(lang, `：${event.what}`, `: ${event.what}`) : '',
    event.state !== undefined ? L(lang, `（章末：${event.state}）`, ` (at its end: ${event.state})`) : '',
    looked.has(event.index) ? L(lang, `〔这一章里的样子：${looked.get(event.index)}〕`, ` [as shown here: ${looked.get(event.index)}]`) : '',
  ].join('')).join('\n')
  // The book's own clock, where its outline keeps one: years that pass between chapters are where somebody grows.
  const timed = chapters.flatMap((chapter) => {
    const time = plans.get(chapter.id)?.time
    return time !== undefined && time.trim().length > 0 ? [L(lang, `第 ${chapter.index} 章：${time}`, `Chapter ${chapter.index}: ${time}`)] : []
  })
  const undigested = chapters.filter(chapter => !chapter.digested).length
  const span = [
    L(lang, `${lineTitle !== undefined ? `剧情线「${lineTitle}」` : '主线'}共 ${chapters.length} 章${undigested > 0 ? `，其中 ${undigested} 章有正文但没有收录` : ''}。`, `${lineTitle !== undefined ? `The line "${lineTitle}"` : 'The main line'} has ${chapters.length} chapters${undigested > 0 ? `, ${undigested} of them not digested` : ''}.`),
    timed.length > 0 ? `${L(lang, '章纲里记的故事时间：', 'Story time as the outline has it:')}\n${timed.join('\n')}` : L(lang, '章纲里没有记故事时间：过了多久，从正文里看。', 'The outline keeps no story time: how much passes is read from the text.'),
  ].join('\n')
  const indexOf = new Map(chapters.map(chapter => [chapter.id, chapter.index]))
  const kept = card.stages ?? []
  const restore = task.job?.note(L(lang, `策划在读「${card.name}」的成长轨迹…`, `The planner is reading how ${card.name} grows…`))
  try {
    const { value } = await assign(core, runtime, task, {
      role: 'architect',
      label: L(lang, `成长 · ${card.name}`, `Growth · ${card.name}`),
      line: home,
      tool: 'set_growth',
      maxSteps: 24,
      // Asked while a book is taken in: from what the digests wrote of this person chapter by chapter, in one request.
      ...(params.plain === true ? { plain: true } : {}),
      what: L(lang, '这个人物在书里的各个时期：年纪、样子、身份从哪一章起变了', 'the stretches of this character\'s life in the book: where age, look and station turn'),
      system: architectSystem(lang),
      prompt: growthTask({
        lang,
        language: manifest.language,
        title: manifest.title,
        name: card.name,
        card: renderCharacter({ ...card, secrets: undefined, notes: undefined, stages: undefined } as CharacterCard, lang),
        record,
        span,
        ...(kept.length > 0 ? { stages: kept.map(stage => ({ title: stage.title, ...(stage.from !== undefined && indexOf.has(stage.from) ? { chapter: indexOf.get(stage.from)! } : {}), ...(stage.age !== undefined ? { age: stage.age } : {}), ...(stage.what !== undefined ? { what: stage.what } : {}), ...(stage.appearance !== undefined ? { appearance: stage.appearance } : {}), ...(stage.persona !== undefined ? { persona: stage.persona } : {}) })) } : {}),
        ...(params.direction !== undefined && params.direction.trim().length > 0 ? { direction: params.direction.trim() } : {}),
      }),
      temperature: 0.3,
      validate: raw => asRecord(raw),
    })
    const taken = new Set<string>()
    const stages: CharacterStage[] = []
    for (const raw of asArray(value.stages)) {
      const item = asRecord(raw)
      const title = asText(item.title)
      if (title === undefined) continue
      const index = Number(item.chapter)
      const from = Number.isFinite(index) && index >= 1 ? chapters.find(chapter => chapter.index === index)?.id : undefined
      const was = Number(item.was)
      const before = (Number.isInteger(was) && was >= 1 ? kept[was - 1] : undefined) ?? kept.find(stage => stage.title === title)
      const same = before !== undefined && !taken.has(before.id) ? before : undefined
      if (same !== undefined) taken.add(same.id)
      const age = asText(item.age)
      const what = asText(item.what)
      // How they look in a stretch that still holds is what its own words say — the author's, or the director's who
      // wrote them out whole: pictures were drawn from them, and a second reading of the book does not rewrite them.
      // What the planner says of it fills a stretch that says nothing yet.
      const appearance = (same?.appearance ?? '').trim().length > 0 ? same!.appearance : asText(item.appearance)
      const persona = asText(item.persona)
      stages.push({
        id: same?.id ?? newId('stage'),
        title,
        ...(from !== undefined ? { from } : {}),
        ...(age !== undefined ? { age } : {}),
        ...(what !== undefined ? { what } : {}),
        ...(appearance !== undefined ? { appearance } : {}),
        ...(persona !== undefined ? { persona } : {}),
        // What was written and drawn of a stretch stays with it while it looks the same; a look written anew is drawn anew.
        ...(same?.visual !== undefined && (same.appearance ?? '') === (appearance ?? '') ? { visual: same.visual } : {}),
      })
    }
    if (stages.length === 0) return { card, stages: [] }
    // In the order they come along the main line; the one they enter in — or one from before the story — first.
    stages.sort((left, right) => (left.from !== undefined ? indexOf.get(left.from) ?? 0 : 0) - (right.from !== undefined ? indexOf.get(right.from) ?? 0 : 0))
    // The first stretch begins where they do: what the card says of them in general is said of it.
    const first = stages[0]!
    const entered = lives[card.id]?.first
    if (first.from !== undefined && entered !== undefined && (indexOf.get(first.from) ?? 0) <= entered) delete first.from
    const age = asText(value.age) ?? first.age
    const saved = await project.saveCharacter({ id: card.id, stages, ...((card.age ?? '').trim().length === 0 && age !== undefined ? { age } : {}) })
    await project.addActivity({ by: 'crew', role: 'architect', tool: 'bible', summary: L(lang, `理出「${card.name}」的 ${stages.length} 个时期：${stages.map(stage => `${stage.title}${stage.age !== undefined ? `（${clip(stage.age, 12)}）` : ''}`).join(' → ')}`, `Found ${stages.length} stretch(es) of ${card.name}'s life: ${stages.map(stage => `${stage.title}${stage.age !== undefined ? ` (${clip(stage.age, 20)})` : ''}`).join(' → ')}`) })
    return { card: saved, stages }
  } finally {
    restore?.()
  }
}

/** For one chapter: the card of each character as the stretch of their life that holds there has them. */
export async function castAt<T extends CharacterCard>(runtime: ProjectRuntime, chapterId: string | undefined, cards: readonly T[]): Promise<T[]> {
  if (!cards.some(card => (card.stages?.length ?? 0) > 0)) return [...cards]
  const { inStage } = await import('../../shared/stages')
  const path = (chapterId !== undefined ? await runtime.project.pathOf(chapterId) : await runtime.project.chapters()).map(chapter => chapter.plan.id)
  return cards.map(card => inStage(card, stageAt(card, chapterId, path)))
}

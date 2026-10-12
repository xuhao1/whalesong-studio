// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A chapter's plan, and what of it was read off the chapter.
 *
 * A plan is what was meant for a chapter. Where it leaves a field blank, the
 * chapter's digest fills it with what the chapter turned out to be, so the
 * outline's page says something of a chapter that arrived written. Such a
 * field is marked (`fromText`): it describes a text, it did not steer it.
 *
 * Whoever drafts a chapter — for the first time, or over what it has — is
 * shown the plan as it was meant, and the threads as they stand without the
 * marks that chapter's last draft left on them: a chapter is not written
 * again by what its last draft happened to be.
 */
import { sameName } from '../shared/text'
import type { ChapterMemory, ChapterPlan, CharacterCard, CharacterMoment, Outline, PlanBlank, PlotThread, ThreadTouch } from '../shared/types'
import type { LocatedChapter, Project, WhoseMoment } from './project'
import { promptLanguage } from './render'

/** The fields of a plan a digest fills where they are blank. */
export const PLAN_BLANKS: readonly PlanBlank[] = ['synopsis', 'location', 'time', 'characters', 'threads']

const blank = (value: string | undefined): boolean => value === undefined || value.trim().length === 0

/**
 * What a chapter's plan leaves empty, as its digest knows it: a line of what
 * happens, where and when, who is in it, which threads it touches.
 *
 * A plan is what was meant for a chapter. A chapter that arrived written — an
 * imported one above all — has no plan beyond its title, and its page in the
 * outline said nothing of it and named nobody. What it turned out to be is in
 * its digest; the blanks are filled from there. Nothing that the author or
 * the planner wrote is replaced: a field with anything in it is left alone.
 * @returns the fields to set; empty when the plan has no blank the digest can fill.
 */
export function planBlanks(plan: ChapterPlan, memory: ChapterMemory, characters: readonly CharacterCard[], outline: Pick<Outline, 'threads'>, zh: boolean, whose?: WhoseMoment): Partial<ChapterPlan> {
  const patch: Partial<ChapterPlan> = {}
  if (blank(plan.synopsis) && !blank(memory.brief)) patch.synopsis = memory.brief
  if (blank(plan.location) && (memory.locations ?? []).length > 0) patch.location = memory.locations!.join(zh ? '、' : ', ')
  if (blank(plan.time) && !blank(memory.storyTime)) patch.time = memory.storyTime!
  if ((plan.characters ?? []).length === 0) {
    // Those of the chapter who have a card: a name with none is a walk-on, or waits among the suggestions.
    // (Whose a note is goes by the chapter's story, where the book is there to say: a namesake of another story is not cast here.)
    const card = (moment: CharacterMoment): CharacterCard | undefined => (whose !== undefined
      ? characters.find(candidate => candidate.id === whose(moment, plan.id))
      : characters.find(candidate => candidate.id === moment.character)
        ?? characters.find(candidate => sameName(candidate.name, moment.name) || candidate.aliases?.some(alias => sameName(alias, moment.name)) === true))
    const ids = [...new Set(memory.characters.map(moment => card(moment)?.id).filter((id): id is string => id !== undefined))]
    if (ids.length > 0) patch.characters = ids
  }
  if ((plan.threads ?? []).length === 0) {
    // A thread that was put down after the chapter was digested is found by its title, as at digesting.
    const thread = (touch: ThreadTouch): string | undefined => outline.threads.find(candidate => candidate.id === touch.threadId)?.id
      ?? outline.threads.find(candidate => sameName(candidate.title, touch.title) || candidate.title.includes(touch.title) || touch.title.includes(candidate.title))?.id
    const ids = [...new Set(memory.threads.map(thread).filter((id): id is string => id !== undefined))]
    if (ids.length > 0) patch.threads = ids
  }
  return patch
}

/**
 * Which fields of a plan are its chapter read back, not what was meant for it: the ones marked so when a digest
 * filled them — and, in a plan filled before that was marked, a line of what happens, a place or a time that holds
 * to the letter what the chapter's digest gives (nobody types those as a digest wrote them). Who is in the chapter
 * and which threads it touches are taken for the digest's only where they are marked: a plan may well have named
 * them just as the chapter then turned out.
 * @param memory - the chapter's digest, where it has one: what an unmarked field is held against.
 */
export function planFromText(plan: ChapterPlan, memory: ChapterMemory | undefined, characters: readonly CharacterCard[], outline: Pick<Outline, 'threads'>, zh: boolean, whose?: WhoseMoment): PlanBlank[] {
  const marked = new Set<PlanBlank>((plan.fromText ?? []).filter(field => PLAN_BLANKS.includes(field)))
  if (memory !== undefined) {
    // What the digest gives for every field it can fill, whatever the plan holds.
    const given = planBlanks({ id: plan.id, title: plan.title, status: plan.status }, memory, characters, outline, zh, whose)
    for (const field of ['synopsis', 'location', 'time'] as const) {
      if (given[field] !== undefined && plan[field] !== undefined && plan[field]!.trim() === given[field]!.trim()) marked.add(field)
    }
  }
  return PLAN_BLANKS.filter(field => marked.has(field) && plan[field] !== undefined)
}

/** A plan as it was meant: without the fields that were read off its chapter. */
export function planAsMeant(plan: ChapterPlan, fromText: readonly PlanBlank[]): ChapterPlan {
  const { fromText: _marks, ...meant } = plan
  for (const field of fromText) delete meant[field]
  return meant
}

/** A chapter as whoever drafts it is to see it: its plan as it was meant (see {@link planAsMeant}). */
export async function chapterAsMeant(project: Project, chapter: LocatedChapter): Promise<LocatedChapter> {
  const memory = await project.memory(chapter.plan.id)
  if (memory === undefined && (chapter.plan.fromText ?? []).length === 0) return chapter
  const [characters, outline, manifest] = await Promise.all([project.characters(), project.outline(), project.manifest()])
  const { whose } = await project.castResolver()
  const fromText = planFromText(chapter.plan, memory, characters, outline, promptLanguage(manifest.language) === 'zh', whose)
  return { ...chapter, plan: planAsMeant(chapter.plan, fromText) }
}

const MARKS = ['planted', 'advanced', 'paid'] as const

/**
 * A thread as it stands without one chapter: that chapter's marks taken off.
 * @returns undefined for a thread a digest of that chapter proposed, nobody confirmed and no other chapter speaks of —
 *   without the chapter there is no such thread.
 */
export function threadWithout(thread: PlotThread, chapterId: string): PlotThread | undefined {
  if (!MARKS.some(mark => thread[mark]?.includes(chapterId))) return thread
  const out: PlotThread = { ...thread }
  for (const mark of MARKS) {
    const left = (thread[mark] ?? []).filter(id => id !== chapterId)
    if (left.length > 0) out[mark] = left
    else delete out[mark]
  }
  return thread.auto === true && !MARKS.some(mark => out[mark] !== undefined) ? undefined : out
}

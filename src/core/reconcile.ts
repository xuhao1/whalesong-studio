// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Keeping the book whole when its files are changed behind the Studio's back.
 *
 * A book is plain files so that anything can read it — and, with that, change
 * it: an editor, a script, an agent's file tool. A chapter changed that way
 * has no version of what it was, and the book's memory still describes the
 * old text. The Studio cannot stop the change, but it sees it: it puts it on
 * the book's record, where the author reads what happened, and digests the
 * chapter again, so the next chapter is written from what the page now says.
 */
import type { NovelCore, ProjectRuntime } from './core'
import { scheduleDigest } from './pipelines/digest'
import { promptLanguage } from './render'
import { errorMessage } from './util/async'

/** Which of the book's own files a path is, or undefined for anything else. */
export function managedKind(relative: string): 'chapter' | 'bible' | 'outline' | 'manifest' | 'state' | undefined {
  const path = relative.replace(/\\/g, '/').replace(/^\.\//, '')
  if (/^manuscript\/[^/]+\.md$/.test(path)) return 'chapter'
  if (path.startsWith('bible/')) return 'bible'
  if (path === 'outline.json') return 'outline'
  if (path === 'novel.json') return 'manifest'
  if (path.startsWith('.novel/')) return 'state'
  return undefined
}

async function reconcile(core: NovelCore, runtime: ProjectRuntime, paths: string[]): Promise<void> {
  const { project } = runtime
  const chapters = [...new Set(paths.flatMap((path) => {
    const id = /^manuscript\/([^/]+)\.md$/.exec(path)?.[1]
    return id !== undefined ? [id] : []
  }))]
  const others = paths.filter((path) => { const kind = managedKind(path); return kind === 'bible' || kind === 'outline' })
  if (chapters.length === 0 && others.length === 0) return
  const zh = promptLanguage((await project.manifest()).language) === 'zh'
  const infos = await project.chapterInfos()
  const digesting = core.currentSettings().autoDigest
  for (const id of chapters) {
    const info = infos.find(candidate => candidate.id === id)
    // Not a chapter of the outline, or its memory still matches: nothing the book needs to catch up on.
    if (info === undefined || !info.hasText || info.digested) continue
    await project.addActivity({
      by: 'outside',
      tool: 'files',
      chapter: id,
      summary: zh
        ? `第 ${info.index} 章《${info.title}》的文件被工坊之外的程序直接改动（现在 ${info.words} 字）——没有留下改动前的版本；${digesting ? '记忆正在重新收录' : '记忆已过期，需要重新收录'}`
        : `The file of chapter ${info.index} "${info.title}" was changed outside Novel Studio (now ${info.words} words) — no version of the earlier text was kept; ${digesting ? 'its memory is being digested again' : 'its memory is stale and needs digesting'}`,
    })
    scheduleDigest(core, runtime, id, { origin: 'user' })
  }
  if (others.length > 0) {
    const names = others.slice(0, 4).join(', ')
    await project.addActivity({
      by: 'outside',
      tool: 'files',
      summary: zh
        ? `设定或大纲的文件被工坊之外的程序直接改动：${names}${others.length > 4 ? ' 等' : ''}——已写的正文可能与之不符，值得让总编核对一遍`
        : `Bible or outline files were changed outside Novel Studio: ${names}${others.length > 4 ? ', …' : ''} — written chapters may now disagree with them; worth having the showrunner check`,
    })
  }
}

/** From now on, every book this engine opens is watched for changes from outside. */
export function attachReconciler(core: NovelCore): void {
  core.onRuntime((runtime) => {
    runtime.project.onOutside((paths) => {
      void reconcile(core, runtime, paths).catch((error: unknown) => { core.log(`could not reconcile outside changes in ${runtime.project.root}: ${errorMessage(error)}`) })
    })
  })
}

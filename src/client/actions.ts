// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What more than one page starts, started one way.
 *
 * A chapter's memory is cleared from where the chapter is written and from
 * its page in the outline: one operation — the same request, the same thing
 * said of what went — whichever button it is under. Kept here, so that it is
 * changed in one place.
 */
import { useProject, useStudio, useT } from './ui'

export interface BookActions {
  /**
   * Clear a chapter's memory: its digest, and what the digest left in the book. What went is said. (The author is
   * asked first by whoever shows the button: `forgetAsk` is the question.)
   */
  forget: (chapter: string) => Promise<void>
  forgetAsk: string
}

export function useBookActions(): BookActions {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  return {
    forgetAsk: t('清除这一章的记忆？收录出来的摘要、事实、人物状态会删掉；它在线索上留的“埋于 / 推进于这一章”、章纲里由收录填上的空栏、它提的还没处理的建议也一起去掉。正文不动；要记忆时再点“收录”。', 'Clear this chapter\'s memory? Its summary, facts and where its people stand are deleted — with the marks it left on the threads, the blanks of the plan the digest filled, and what it suggested that still waits. The text is not touched; a digest brings the memory back.'),
    forget: async (chapter) => {
      const done = await controller.api.call('chapter.forget', { root, id: chapter })
      await controller.refreshProject()
      if (!done.forgot) {
        controller.toast('info', t('这一章本来就没有记忆。', 'This chapter had no memory.'))
        return
      }
      const names: Record<string, [string, string]> = { synopsis: ['梗概', 'synopsis'], location: ['地点', 'place'], time: ['故事时间', 'story time'], characters: ['出场人物', 'cast'], threads: ['线索', 'threads'] }
      const fields = done.fields.map(field => t(...(names[field] ?? [field, field]))).join(t('、', ', '))
      controller.toast('success', [
        t('这一章的记忆清掉了', 'The chapter\'s memory is cleared'),
        ...(fields.length > 0 ? [t(`章纲里由收录填上的${fields}清空了`, `the plan's ${fields}, filled by the digest, emptied`)] : []),
        ...(done.threads > 0 ? [t(`从 ${done.threads} 条线索上去掉了这一章的记号${done.gone > 0 ? `（其中 ${done.gone} 条只有这一章提过，没人确认，已删）` : ''}`, `its marks taken off ${done.threads} thread(s)${done.gone > 0 ? ` (${done.gone} that only it had proposed are gone)` : ''}`)] : []),
        ...(done.suggestions > 0 ? [t(`它提的 ${done.suggestions} 条建议撤了`, `${done.suggestions} suggestion(s) of its dropped`)] : []),
      ].join(t('；', '; ')) + t('。', '.'))
    },
  }
}

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the showrunner reads of a review names every issue the way the tools that act on one take it —
 * `<chapter>:<issue id>` — with the proposals that wait beneath it; it is not left to find the ids on the Studio's
 * pages (#419). And an issue that is not there is not "marked as dealt with".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveIssue } from '../src/core/pipelines/review'
import { ISSUE_TOOLS, readBook } from '../src/core/reading'
import type { ReviewIssue } from '../src/shared/types'
import { createTestBed, type TestBed } from './support/harness'

const ISSUES: ReviewIssue[] = [
  { id: 'is_aaaaaa', severity: 'high', type: 'continuity', quote: '柳先生推了推眼镜。', explanation: '前面刚说没戴眼镜。', suggestion: '改成揉了揉眼睛。', against: { kind: 'chapter', ref: '1', quote: '柳先生摘下眼镜，放在柜台上。' } },
  { id: 'is_bbbbbb', severity: 'low', type: 'style', explanation: '这一段节奏太平。', resolved: true },
  { id: 'is_cccccc', severity: 'medium', type: 'logic', quote: '窗外有雨。', explanation: '上一句是晴天。', fix: { find: '窗外有雨。', replace: '窗外起了风。' } },
]

describe('review issues by name (#419)', () => {
  let bed: TestBed
  let one: string
  let two: string
  beforeEach(async () => {
    bed = await createTestBed({ language: 'zh', title: '七日未寄' })
    const { project } = bed.runtime
    one = (await project.addChapter({ title: '铺子' })).id
    two = (await project.addChapter({ title: '旧账' })).id
    await project.saveChapterText(one, '柳先生摘下眼镜，放在柜台上。')
    await project.saveChapterText(two, '柳先生推了推眼镜。\n\n窗外有雨。')
    await project.saveReview({ chapterId: two, textHash: 'x', createdAt: '', verdict: '有两处对不上。', issues: ISSUES })
  })
  afterEach(async () => { await bed.cleanup() })

  it('a chapter\'s review names each issue <chapter>:<id>, says where it stands, and what may be done with it', async () => {
    const { project } = bed.runtime
    const waiting = await project.addProposal({ chapterId: two, kind: 'span', instruction: '改眼镜', before: '柳先生推了推眼镜。', after: '柳先生揉了揉眼睛。', createdBy: 'agent', issues: ['is_aaaaaa'] })
    const { text } = await readBook(bed.runtime, { what: 'review', ref: '2' })
    const lines = text.split('\n')
    expect(lines[0]).toBe(`Chapter 2 "旧账" (${two}): 有两处对不上。`)
    expect(lines.find(line => line.startsWith(`- ${two}:is_aaaaaa `))).toBe(`- ${two}:is_aaaaaa [high/continuity; open; waiting beneath it: proposal ${waiting.id}] "柳先生推了推眼镜。" — 前面刚说没戴眼镜。`)
    expect(text).toContain('  at odds with chapter 1: "柳先生摘下眼镜，放在柜台上。"\n  fix: 改成揉了揉眼睛。')
    expect(text).toContain(`- ${two}:is_bbbbbb [low/style; dealt with] 这一段节奏太平。`)
    expect(text).toContain(`- ${two}:is_cccccc [medium/logic; open; the reviewer wrote the change out] "窗外有雨。" — 上一句是晴天。`)
    expect(text.endsWith(ISSUE_TOOLS)).toBe(true)
    // The crew reads reviews too: the names, without the showrunner's tools.
    const crew = (await readBook(bed.runtime, { what: 'review', ref: two }, { read: 'book_read' })).text
    expect(crew).toContain(`- ${two}:is_aaaaaa [high/continuity; open;`)
    expect(crew).not.toContain('novel_revise')
  })

  it('without a chapter: every open issue of the book, chapter by chapter, a page at a time', async () => {
    const { project } = bed.runtime
    const three = (await project.addChapter({ title: '渡口' })).id
    await project.saveReview({ chapterId: three, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'is_dddddd', severity: 'high', type: 'timeline', explanation: '日子算不拢。', mending: 'bt_1' }] })
    await project.saveReview({ chapterId: one, textHash: 'x', createdAt: '', verdict: '', issues: [{ id: 'is_eeeeee', severity: 'low', type: 'style', explanation: '早就改好了。', resolved: true }] })
    const { text } = await readBook(bed.runtime, { what: 'review' })
    expect(text.split('\n\n')[0]).toBe('3 open issue(s) in 2 chapter(s) (3 of 3 reviewed). novel_read what=review ref=<chapter> reads one chapter\'s review whole.')
    expect(text).toContain(`## Chapter 2 "旧账" (${two}): 2 open\n- ${two}:is_aaaaaa [high/continuity; open] "柳先生推了推眼镜。" — 前面刚说没戴眼镜。\n- ${two}:is_cccccc [medium/logic; open; the reviewer wrote the change out]`)
    expect(text).toContain(`## Chapter 3 "渡口" (${three}): 1 open\n- ${three}:is_dddddd [high/timeline; open; handed over to be mended] 日子算不拢。`)
    expect(text).not.toContain('is_bbbbbb')
    expect(text).not.toContain('is_eeeeee')
    expect(text).not.toContain('fix:')
    expect(text.endsWith(ISSUE_TOOLS)).toBe(true)

    const page = (await readBook(bed.runtime, { what: 'review', offset: 1, limit: 1 })).text
    expect(page.split('\n\n')[0]).toContain('; issues 2–2 listed — 1 more: offset=2 for the next.')
    expect(page).toContain(`- ${two}:is_cccccc `)
    expect(page).not.toContain('is_aaaaaa')
    expect(page).not.toContain('## Chapter 3')

    for (const issue of [...ISSUES.map(item => item.id), 'is_dddddd']) await resolveIssue(bed.runtime, issue === 'is_dddddd' ? three : two, issue, true)
    expect((await readBook(bed.runtime, { what: 'review' })).text).toBe('No open issue: 3 of 3 chapter(s) reviewed, every issue they found dealt with.')
  })

  it('an issue the review does not have is not marked as dealt with', async () => {
    expect(await resolveIssue(bed.runtime, two, 'is_zzzzzz', true)).toBeUndefined()
    expect(await resolveIssue(bed.runtime, one, 'is_aaaaaa', true)).toBeUndefined()
    const done = await resolveIssue(bed.runtime, two, 'is_aaaaaa', true)
    expect(done?.issues.find(issue => issue.id === 'is_aaaaaa')?.resolved).toBe(true)
  })
})

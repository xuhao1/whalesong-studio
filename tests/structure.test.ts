// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importManuscript } from '../src/core/pipelines/import'
import { Manuscript, readNumber, splitChapters, titleNumber } from '../src/core/pipelines/structure'
import { createTestBed, type TestBed } from './support/harness'

const NAV = '后一页前一页回目录回首页'
const TITLES = [
  '第一回　甄士隐梦幻识通灵　贾雨村风尘怀闺秀',
  '第二回　　贾夫人仙逝扬州城　冷子兴演说荣国府',
  // As the source has it: the number is lost, only the couplet is left, pushed to the right.
  '　　　　　　　　　　 贾雨村夤缘复旧职　林黛玉抛父进京都',
  '第四回　薄命女偏逢薄命郎　葫芦僧乱判葫芦案',
  '第五回　游幻境指迷十二钗　饮仙醪曲演红楼梦',
  '第六回　贾宝玉初试云雨情　刘姥姥一进荣国府',
]
const body = (n: number): string => Array.from({ length: 6 }, (_, i) => `　　这是第${n}回的第${i + 1}段，写的是这一回里发生的事，一共有若干句话，足够当作一段正文来看待。`).join('\n\n')

/**
 * A manuscript the way a scraped page leaves it: every heading but the first
 * follows the site's navigation on the same line as the end of the chapter
 * before, and one heading has lost its number.
 */
function scraped(): string {
  let text = `${TITLES[0]}\n\n${body(1)}`
  for (let i = 1; i < TITLES.length; i++) {
    text += i === 2 ? `${NAV}${NAV}\n${TITLES[i]}\n\n${body(i + 1)}` : `${NAV}${NAV}${TITLES[i]}\n\n${body(i + 1)}`
  }
  return text
}

const HEADING = '第[一二三四五六七八九十百]+回[ 　]+\\S+[ 　]+\\S+'

describe('finding the chapters of a manuscript', () => {
  it('reads numbers the way titles write them', () => {
    expect(readNumber('一百二十')).toBe(120)
    expect(readNumber('十')).toBe(10)
    expect(readNumber('十五')).toBe(15)
    expect(readNumber('二十一')).toBe(21)
    expect(readNumber('一百零八')).toBe(108)
    expect(readNumber('一二〇')).toBe(120)
    expect(readNumber('两千零一')).toBe(2001)
    expect(readNumber('１２')).toBe(12)
    expect(readNumber('XIV')).toBe(14)
    expect(readNumber('回')).toBeUndefined()
    expect(titleNumber('第八十回 美香菱屈受贪夫棒')).toBe(80)
    expect(titleNumber('Chapter IV. The Rabbit Sends in a Little Bill')).toBe(4)
    expect(titleNumber('12. 雨夜')).toBe(12)
    expect(titleNumber('楔子')).toBeUndefined()
  })

  it('rules alone cut a scraped book into numbered pieces', () => {
    // What the import used to do with such a file: one heading stands on a line of its own, so it falls back to size.
    const pieces = splitChapters(scraped(), { zh: true, chunkChars: 200 })
    expect(pieces.length).toBeGreaterThan(6)
    expect(pieces[0]!.title).toBe('第1节')
  })

  it('lets an editor look, clean, split, see what is off, and put it right', () => {
    const draft = new Manuscript(scraped(), true)
    // Looking and searching show where the headings really are: mid-line, behind navigation text.
    expect(draft.look({ chars: 300 })).toContain('第一回　甄士隐梦幻识通灵')
    const found = draft.search({ pattern: '第[一二三四五六七八九十百]+回' })
    expect(found).toContain('共 5 处')
    expect(found).toContain('回目录回首页⟦第二回⟧')
    expect(() => draft.search({ pattern: '(' })).toThrow(/not a valid regular expression/)

    expect(draft.clean({ pattern: '(?:后一页|前一页|回目录|回首页)+' })).toMatch(/删掉了 5 处/)
    expect(draft.text).not.toContain('回目录')
    // A pattern that would eat the book is refused.
    expect(() => draft.clean({ pattern: '[^\\n]+' })).toThrow(/杂质不会有这么多/)

    const report = draft.split({ pattern: HEADING })
    expect(report).toContain('共 5 章')
    // The lost number shows as a gap, and the report says where to look.
    expect(report).toMatch(/编号缺口：第 2 章是 2，下一章（第 3 章）直接是 4，中间缺 1 章/)
    expect(draft.look({ find: '贾雨村夤缘复旧职' })).toContain('林黛玉抛父进京都')

    const fixed = draft.amend({ add: [{ quote: '贾雨村夤缘复旧职　林黛玉抛父进京都', title: '第三回 贾雨村夤缘复旧职 林黛玉抛父进京都' }] })
    expect(fixed).toContain('共 6 章')
    expect(fixed).toContain('没有发现编号或篇幅上的异常')
    expect(draft.list({ from: 3, count: 1 })).toContain('《第三回 贾雨村夤缘复旧职 林黛玉抛父进京都》')

    expect(() => draft.amend({ add: [{ quote: '原文里没有的一句话' }] })).toThrow(/原文里找不到/)
    expect(draft.finish({ note: '六回，回目粘在导航文字后面，已清理。' })).toContain('已提交：6 章')

    const chapters = draft.chapters()
    expect(chapters.map(chapter => chapter.title)).toEqual([
      '第一回 甄士隐梦幻识通灵 贾雨村风尘怀闺秀',
      '第二回 贾夫人仙逝扬州城 冷子兴演说荣国府',
      '第三回 贾雨村夤缘复旧职 林黛玉抛父进京都',
      '第四回 薄命女偏逢薄命郎 葫芦僧乱判葫芦案',
      '第五回 游幻境指迷十二钗 饮仙醪曲演红楼梦',
      '第六回 贾宝玉初试云雨情 刘姥姥一进荣国府',
    ])
    for (const [i, chapter] of chapters.entries()) {
      // Every chapter holds its own prose and nothing of a heading or of the site.
      expect(chapter.text.startsWith(`这是第${i + 1}回的第1段`)).toBe(true)
      expect(chapter.text).toContain(`这是第${i + 1}回的第6段`)
      expect(chapter.text).not.toMatch(/回目录|第[一二三四五六]回|夤缘/)
    }
  })

  it('tells a table of contents from the book, and marks volumes', () => {
    const toc = ['第一章 雨夜', '第二章 断剑', '第三章 下山'].join('\n')
    const text = `目录\n${toc}\n\n上卷 青冥\n\n第一章 雨夜\n\n${body(1)}\n\n第二章 断剑\n\n${body(2)}\n\n下卷 江湖\n\n第三章 下山\n\n${body(3)}\n`
    const draft = new Manuscript(text, true)
    const report = draft.split({ pattern: '^第[一二三]章 .+$' })
    // Each heading occurs twice: the report says so, and says which ones are empty.
    expect(report).toMatch(/编号回退：第 4 章是 1，它前面是 3/)
    expect(report).toMatch(/过短：第 1 章《第一章 雨夜》/)
    const amended = draft.amend({ drop: [1, 2, 3], front: 'drop', volumes: [{ chapter: 4, title: '上卷 青冥' }, { chapter: 6, title: '下卷 江湖' }] })
    expect(amended).toContain('共 3 章')
    const chapters = draft.chapters()
    expect(chapters.map(chapter => `${chapter.volume ?? '-'}|${chapter.title}`)).toEqual(['上卷 青冥|第一章 雨夜', '-|第二章 断剑', '下卷 江湖|第三章 下山'])
    // A book with no marks at all is cut by length, knowingly.
    const plain = new Manuscript(Array.from({ length: 40 }, (_, i) => `　　第${i}段没有任何标题的文字，一直写下去，写下去，写下去。`).join('\n'), true)
    expect(plain.sections({ chars: 300 })).toContain('全书没有章节标记')
    expect(plain.bySize).toBe(true)
    expect(plain.chapters()[0]!.title).toBe('第1节')
  })

  it('tells a mention of a chapter from a heading with prose stuck to it', () => {
    // Clean headings, but: chapter two's prose mentions chapter one, and chapter three's heading shares its line with its first sentence.
    const text = [
      `第一回　甄士隐梦幻识通灵　贾雨村风尘怀闺秀\n\n${body(1)}`,
      `第二回　贾夫人仙逝扬州城　冷子兴演说荣国府\n\n　　第一回中既将甄家的事略已表明，此回则暂不再写了。\n\n${body(2)}`,
      `第三回　贾雨村夤缘复旧职　林黛玉抛父进京都　话说雨村忙回头看时，不是别人，正是旧日同僚。\n\n${body(3)}`,
      `第四回　薄命女偏逢薄命郎　葫芦僧乱判葫芦案\n\n${body(4)}`,
      `第五回　游幻境指迷十二钗　饮仙醪曲演红楼梦\n\n${body(5)}`,
    ].join('\n\n')
    const draft = new Manuscript(text, true)
    // The loose pattern an editor starts with: everything from the number to the end of the line.
    const report = draft.split({ pattern: '第[一二三四五六七八九十]+回[^\\n]{0,60}' })
    expect(report).toContain('共 6 章')
    expect(report).toMatch(/疑似误切[\s\S]*第 3 章《第一回中既将甄家的事略已表明/)
    expect(report).toMatch(/标题后面粘着正文[\s\S]*第 4 章[\s\S]*→ 《第三回 贾雨村夤缘复旧职 林黛玉抛父进京都》/)
    expect(report).toContain('amend drop:[3] rename:[{chapter:4,title:"第三回 贾雨村夤缘复旧职 林黛玉抛父进京都"}]')
    // Committing over it is refused once, with the same advice.
    expect(() => draft.finish({ note: '好了' })).toThrow(/amend drop:\[3\] rename:/)
    const amended = draft.amend({ drop: [3], rename: [{ chapter: 4, title: '第三回 贾雨村夤缘复旧职 林黛玉抛父进京都' }] })
    expect(amended).toContain('共 5 章')
    expect(amended).toContain('没有发现编号或篇幅上的异常')
    draft.finish({ note: '五回。' })
    const chapters = draft.chapters()
    expect(chapters.map(chapter => chapter.title.slice(0, 3))).toEqual(['第一回', '第二回', '第三回', '第四回', '第五回'])
    // The mention is prose of chapter two again, and the sentence that shared the heading's line opens chapter three.
    expect(chapters[1]!.text).toContain('第一回中既将甄家的事略已表明，此回则暂不再写了。')
    expect(chapters[2]!.text.startsWith('话说雨村忙回头看时，不是别人，正是旧日同僚。')).toBe(true)

    // A later change that makes things worse is not committed over the sounder split without a word.
    const worse = new Manuscript(text, true)
    worse.split({ pattern: '第[一二三四五六七八九十]+回[^\\n]{0,60}' })
    worse.amend({ drop: [3], rename: [{ chapter: 4, title: '第三回 贾雨村夤缘复旧职 林黛玉抛父进京都' }] })
    expect(worse.amend({ drop: [3] })).toMatch(/编号缺口：第 2 章是 2，下一章（第 3 章）直接是 4/)
    expect(() => worse.finish({ note: '好了' })).toThrow(/之前有过更稳妥的一版（5 章，0 处异常）.*restore:true/)
    expect(worse.amend({ restore: true })).toMatch(/已回到最稳妥的那一版。\n共 5 章/)
    expect(worse.finish({ note: '五回。' })).toContain('已提交：5 章')

    // An editor that never commits still leaves its soundest split, put right the same way.
    const unattended = new Manuscript(text, true)
    unattended.split({ pattern: '第[一二三四五六七八九十]+回[^\\n]{0,60}' })
    unattended.split({ pattern: '第[一二]回' })
    expect(unattended.settle()).toEqual({ chapters: 5, dropped: 1, retitled: 1 })
    expect(unattended.chapters()[2]!.title).toBe('第三回 贾雨村夤缘复旧职 林黛玉抛父进京都')
  })

  it('refuses a pattern that backtracks without end instead of hanging on it', () => {
    const draft = new Manuscript(`${'a'.repeat(40)}!\n`.repeat(3), false)
    const started = Date.now()
    expect(() => draft.search({ pattern: '(a+)+$' })).toThrow(/takes too long/)
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 20_000)
})

describe('importing through the editor', () => {
  let bed: TestBed
  beforeEach(async () => { bed = await createTestBed({ title: '红楼梦' }) })
  afterEach(async () => { await bed.cleanup() })

  it('has the editor agent find the chapters, and says how it went', async () => {
    bed.roles.enabled = true
    bed.roles.script = async (task, call) => {
      // Taking a manuscript in is the continuity keeper's work: its persona, and this craft among its rules.
      expect(task.role).toBe('analyst')
      expect(task.label).toBe('场记 · 整理《红楼梦》的章节')
      expect(task.persona).toContain('场记')
      expect(task.rules).toContain('## 收录一份书稿')
      expect(task.prompt).toContain('能找到 1 处标题')
      expect(task.tools.map(tool => tool.name)).toEqual(['look', 'search', 'clean', 'split', 'amend', 'list', 'sections', 'finish'])
      await call('look', { chars: 400 })
      await call('search', { pattern: '第.{1,3}回' })
      await call('clean', { pattern: '(?:后一页|前一页|回目录|回首页)+' })
      // A slip a model makes: it is told, and goes on.
      expect(await call('split', { pattern: '第零回' })).toMatch(/^ERROR: .*只匹配到 0 处/)
      await call('split', { pattern: HEADING })
      await call('amend', { add: [{ quote: '贾雨村夤缘复旧职　林黛玉抛父进京都', title: '第三回 贾雨村夤缘复旧职 林黛玉抛父进京都' }] })
      await call('finish', { note: '六回；回目粘在网页导航后面，已清理；第三回丢了回数，已补上。', author: '曹雪芹' })
      return '整理好了。'
    }
    const { done } = bed.core.jobs.start({ kind: 'import', title: 'import', project: bed.runtime.project.root, origin: 'user' }, async job => await importManuscript(bed.core, bed.runtime, { text: scraped(), analyze: false }, { origin: 'user', job, signal: job.signal }))
    const result = await done
    expect(result.chapters).toBe(6)
    expect(result.structure).toEqual({ by: 'agent', bySize: false, note: '六回；回目粘在网页导航后面，已清理；第三回丢了回数，已补上。', steps: 7 })
    const infos = await bed.runtime.project.chapterInfos()
    expect(infos.map(info => info.title)).toContain('第三回 贾雨村夤缘复旧职 林黛玉抛父进京都')
    expect(await bed.runtime.project.chapterText(infos[1]!.id)).not.toContain('回首页')
    expect((await bed.runtime.project.manifest()).author).toBe('曹雪芹')
    // Whoever watches the job reads what the editor did, step by step.
    const log = bed.core.jobs.read(bed.core.jobs.list()[0]!.id)!.text
    expect(log).toContain('› search 第.{1,3}回 — 共 41 处')
    expect(log).toContain('› split 第零回 — ✗ ')
    expect(log).toContain('第三回丢了回数，已补上')
  })

  it('uses the best split of an editor that ran out of steps', async () => {
    bed.roles.enabled = true
    bed.roles.script = async (_task, call) => {
      await call('clean', { pattern: '(?:后一页|前一页|回目录|回首页)+' })
      await call('split', { pattern: HEADING })
      await call('search', { pattern: '第三回' })
      return ''
    }
    const result = await importManuscript(bed.core, bed.runtime, { text: scraped(), analyze: false }, { origin: 'user' })
    expect(result.structure.by).toBe('agent')
    expect(result.chapters).toBe(5)
    expect(result.structure.note).toMatch(/没有在限定的步数内提交（3 步）.*5 章/)
  })

  it('falls back on the rules where no agent can run, and says so', async () => {
    const text = `第一章 雨夜\n\n${body(1)}\n\n第二章 断剑\n\n${body(2)}\n`
    const plain = await importManuscript(bed.core, bed.runtime, { text, analyze: false }, { origin: 'user' })
    expect(plain.chapters).toBe(2)
    expect(plain.structure.by).toBe('rules')
    expect(plain.structure.note).toContain('按规则切分')

    // An editor that gives up without committing leaves the import to the rules too.
    const other = await createTestBed({ title: '另一本' })
    try {
      other.roles.enabled = true
      other.roles.script = async (_task, call) => {
        await call('look')
        return '我看不出结构。'
      }
      const result = await importManuscript(other.core, other.runtime, { text, analyze: false }, { origin: 'user' })
      expect(result.chapters).toBe(2)
      expect(result.structure.by).toBe('rules')
      expect(result.structure.note).toContain('我看不出结构')
    } finally {
      await other.cleanup()
    }
  })
})

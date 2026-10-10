// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The history of a card, an entry, a style, a chapter's plan, a thread, the
 * book: every version kept of it, what each differs in from the thing as it
 * is now, and the way back — the whole of a version, or one field of it.
 * Pictures are no part of it (`shared/history.ts`). One control, wherever a
 * thing with a history is edited.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { changedFields, sayValue, type HistoryField } from '../shared/history'
import type { HistoryKind, HistoryVersion, ProjectState } from '../shared/types'
import { DiffView } from './components/ProposalCard'
import { THREAD_KIND, THREAD_STATUS, whyLabel, WORLD_CATEGORY } from './labels'
import { Button, Chip, Modal, Spinner, cx, useAction, useConfirm, useLoad, useProject, useStudio, useT, type Translate } from './ui'

type Label = [zh: string, en: string]

/** What the fields are called where they are edited — and the order they are shown in. */
const FIELDS: Record<HistoryKind, Record<string, Label>> = {
  character: {
    'name': ['姓名', 'Name'],
    'aliases': ['别名 / 称呼', 'Other names'],
    'role': ['定位', 'Role'],
    'tagline': ['一句话人设', 'Who they are'],
    'gender': ['性别', 'Gender'],
    'age': ['年龄', 'Age'],
    'lines': ['世界线', 'Lines of the plot'],
    'appearance': ['外貌', 'Appearance'],
    'personality': ['性格', 'Personality'],
    'background': ['背景', 'Background'],
    'motivation': ['动机（想要 / 需要）', 'Want and need'],
    'flaw': ['弱点', 'Flaw'],
    'arc': ['人物弧光', 'Arc'],
    'voice': ['对白的声音', 'How they sound'],
    'abilities': ['能力', 'Abilities'],
    'secrets': ['秘密', 'Secrets'],
    'persona.traits': ['特质', 'Traits'],
    'persona.values': ['看重的东西', 'What they value'],
    'persona.speech': ['说话习惯', 'Habits of speech'],
    'persona.taboos': ['绝不会', 'Never would'],
    'persona.underPressure': ['压力下的反应', 'Under pressure'],
    'relationships': ['关系', 'Relationships'],
    'tags': ['标签', 'Tags'],
    'life': ['履历', 'Their life'],
    'lifeMarks': ['手记的履历', 'Marks of their life'],
    'stages': ['成长', 'Stretches of their life'],
    'visual.prompt': ['视觉锚点', 'Visual anchor'],
    'visual.negative': ['这个人物身上不要画出', 'Not to be drawn on them'],
    'visual.looks': ['造型', 'Looks'],
    'visual.scenes': ['名场面', 'Signature scenes'],
    'voiceProfile.provider': ['配音服务', 'Voice service'],
    'voiceProfile.voice': ['音色', 'Voice'],
    'voiceProfile.instructions': ['表演基调', 'Delivery'],
    'voiceProfile.designPrompt': ['声线设计描述', 'Voice design'],
    'notes': ['备注', 'Notes'],
  },
  world: {
    name: ['名称', 'Name'],
    aliases: ['别名', 'Other names'],
    category: ['类别', 'Kind'],
    lines: ['世界线', 'Lines of the plot'],
    importance: ['怎么给模型', 'How it travels'],
    weight: ['在故事里的分量', 'Weight in the story'],
    summary: ['一句话概括', 'In a sentence'],
    body: ['详细设定', 'The entry'],
    visualPrompt: ['样子', 'What it looks like'],
    events: ['轨迹', 'Its course'],
    related: ['相关', 'Related'],
    tags: ['标签', 'Tags'],
  },
  style: {
    name: ['文风名称', 'Name'],
    pov: ['叙事视角', 'Point of view'],
    tense: ['时态', 'Tense'],
    register: ['语体', 'Register'],
    tone: ['基调', 'Tone'],
    diction: ['用词', 'Diction'],
    rhythm: ['节奏', 'Rhythm'],
    imagery: ['意象与修辞', 'Imagery'],
    dialogue: ['对白', 'Dialogue'],
    pacing: ['推进方式', 'Pacing'],
    rules: ['必须做到', 'Rules'],
    avoid: ['必须避免', 'To avoid'],
    exemplars: ['范文', 'Exemplars'],
    body: ['补充说明', 'Notes'],
  },
  plan: {
    title: ['标题', 'Title'],
    synopsis: ['梗概', 'Synopsis'],
    purpose: ['这一章的作用', 'What it does'],
    pov: ['视角人物', 'Point of view'],
    location: ['地点', 'Place'],
    time: ['故事时间', 'Story time'],
    characters: ['出场人物', 'Cast'],
    threads: ['牵动的线索', 'Threads'],
    beats: ['节拍', 'Beats'],
    targetWords: ['建议字数', 'Suggested length'],
    notes: ['备注', 'Notes'],
  },
  thread: {
    title: ['标题', 'Title'],
    kind: ['类型', 'Kind'],
    status: ['状态', 'Status'],
    description: ['说明', 'Description'],
    planted: ['埋于', 'Planted in'],
    advanced: ['推进于', 'Advanced in'],
    paid: ['回收于', 'Paid off in'],
    auto: ['收录提出、还没确认', 'Proposed by a digest'],
  },
  book: {
    title: ['书名', 'Title'],
    author: ['作者', 'Author'],
    language: ['正文语言', 'Language'],
    genre: ['类型', 'Genre'],
    logline: ['一句话梗概', 'Logline'],
    premise: ['故事核', 'Premise'],
    themes: ['主题', 'Themes'],
    targetWords: ['目标总字数', 'Planned length'],
    chapterBudget: ['每章建议字数', 'Length of a chapter'],
    activeStyle: ['默认文风', 'Style in use'],
    artStyle: ['画风', 'Art direction'],
    artAvoid: ['任何一张图里都不要出现', 'Never in a picture'],
    notes: ['作者备注', 'Notes'],
  },
  volume: {
    title: ['卷名', 'Title'],
    synopsis: ['梗概', 'Synopsis'],
    goal: ['这一卷要把故事带到哪', 'Where it leaves the story'],
    chapters: ['章节与次序', 'Chapters, in order'],
  },
  line: {
    title: ['线名', 'Title'],
    premise: ['这条线讲的是什么', 'What sets it apart'],
    choice: ['分出去时的抉择', 'The choice it leaves by'],
    from: ['从哪一章之后分出', 'Leaves after'],
    into: ['汇入哪一章', 'Arrives at'],
    shelved: ['搁置', 'Put aside'],
    chapters: ['章节与次序', 'Chapters, in order'],
  },
  ties: {
    relations: ['关系', 'Ties'],
  },
  script: {
    lines: ['台词与旁白', 'Lines'],
    cues: ['声音提示', 'Sound cues'],
    shape: ['切分方式', 'How it was cut'],
    degraded: ['没能编排的部分', 'Passages cut by rule'],
  },
  board: {
    style: ['画风', 'Art direction'],
    panels: ['分镜', 'Panels'],
    density: ['密度', 'Density'],
    maxPanels: ['最多几格', 'Most panels'],
    note: ['说明', 'Note'],
  },
}

/** What the keys inside a field's records are called. */
const KEYS: Record<string, Label> = {
  name: ['名称', 'name'], title: ['标题', 'title'], summary: ['梗概', 'summary'], characters: ['人物', 'cast'], location: ['地点', 'place'],
  conflict: ['阻碍', 'conflict'], outcome: ['转折', 'outcome'], emotion: ['情绪', 'emotion'], target: ['对方', 'with'], kind: ['类型', 'kind'],
  note: ['说明', 'note'], level: ['强度', 'level'], chapter: ['章节', 'chapter'], what: ['发生了什么', 'what'], from: ['从', 'from'],
  traits: ['特质', 'traits'], values: ['看重', 'values'], speech: ['说话习惯', 'speech'], taboos: ['绝不会', 'never'], underPressure: ['压力下', 'under pressure'],
  age: ['年龄', 'age'], appearance: ['样子', 'appearance'], persona: ['为人', 'persona'], prompt: ['描述', 'description'], negative: ['不要画出', 'not drawn'],
  when: ['什么时候穿', 'when worn'], text: ['内容', 'text'], why: ['理由', 'why'], label: ['标签', 'label'], visual: ['形象', 'look'],
}

/** What the values under a key are called, where they are the Studio's words and not the author's. */
const VALUES: Record<string, Record<string, Label>> = {
  role: { protagonist: ['主角', 'Protagonist'], deuteragonist: ['第二主角', 'Deuteragonist'], antagonist: ['反派', 'Antagonist'], supporting: ['配角', 'Supporting'], minor: ['次要', 'Minor'], cameo: ['龙套', 'Cameo'] },
  weight: { core: ['核心', 'Core'], major: ['重要', 'Major'], minor: ['次要', 'Minor'], once: ['只出现一次', 'Passed once'] },
  importance: { 1: ['★ 核心（始终提供给模型）', '★ Core (always in context)'], 2: ['常规（相关时提供）', 'Normal (when relevant)'], 3: ['细节（按需检索）', 'Detail (on demand)'] },
  pov: { 'first': ['第一人称', 'First person'], 'third-limited': ['第三人称有限', 'Third limited'], 'third-omniscient': ['第三人称全知', 'Third omniscient'], 'second': ['第二人称', 'Second person'], 'multi': ['多视角轮换', 'Rotating viewpoints'] },
  tense: { past: ['过去时', 'Past'], present: ['现在时', 'Present'] },
  category: WORLD_CATEGORY,
  status: THREAD_STATUS,
  kind: {
    ...THREAD_KIND,
    begin: ['开始', 'begins'], change: ['变动', 'changes'], decline: ['衰败', 'declines'], end: ['终结', 'ends'],
    enter: ['登场', 'comes on'], return: ['回归', 'comes back'], exit: ['离开', 'leaves'], death: ['死亡', 'dies'],
  },
}

/** How one thing stands to another, in a word between their names. */
const TIE_WORD: Record<string, Label> = {
  within: ['位于', 'lies in'], seat: ['坐落在', 'has its seat in'], member: ['属于', 'belongs to'], resides: ['住在', 'lives in'], holds: ['持有', 'holds'],
}

/** The ids a version names, as the names the author knows them by. */
function useNames(project: ProjectState, t: Translate): (path: string, value: unknown) => unknown {
  return useMemo(() => {
    const people = new Map(project.characters.map(card => [card.id, card.name]))
    const entries = new Map(project.world.map(entry => [entry.id, entry.name]))
    const chapters = new Map([...(project.lines ?? []).flatMap(line => line.chapters), ...project.chapters].map(chapter => [chapter.id, `${chapter.index}. ${chapter.title}`]))
    const threads = new Map(project.outline.threads.map(thread => [thread.id, thread.title]))
    const lines = new Map<string, string>([['main', '★'], ...(project.outline.lines ?? []).map(line => [line.id, line.title] as [string, string])])
    const styles = new Map(project.styles.map(style => [style.id, style.name]))
    /** Which names the ids under a key are. */
    const book = (key: string): Map<string, string> | undefined => {
      if (['characters', 'pov', 'target'].includes(key)) return people
      if (['chapter', 'chapters', 'from', 'into', 'planted', 'advanced', 'paid'].includes(key)) return chapters
      if (key === 'threads') return threads
      if (key === 'lines') return lines
      if (key === 'related') return entries
      if (key === 'activeStyle') return styles
      return undefined
    }
    const worded = (key: string, value: string | number): string | undefined => { const label = VALUES[key]?.[String(value)]; return label !== undefined ? t(...label) : undefined }
    const named = (key: string, value: unknown): unknown => {
      if (typeof value === 'string') return book(key)?.get(value) ?? worded(key, value) ?? value
      if (typeof value === 'number') return worded(key, value) ?? value
      if (Array.isArray(value)) return value.map(item => named(key, item))
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([inner, item]) => [inner, named(inner, item)]))
      return value
    }
    return (path, value) => named(path.split('.').at(-1)!, value)
  }, [project, t])
}

/** A field's value as the text it is shown and compared as. */
function useSay(kind: HistoryKind, project: ProjectState, t: Translate): (field: string, value: unknown) => string {
  const names = useNames(project, t)
  return (field, value) => {
    // A plan's point of view is a person; a style's is a way of telling.
    if (kind === 'style' && field === 'pov' && typeof value === 'string' && VALUES.pov![value] !== undefined) return t(...VALUES.pov![value]!)
    if (typeof value === 'boolean') return value ? t('是', 'yes') : t('否', 'no')
    // A table of ties, a script, a storyboard: a line each, as they are read — not a record's keys one under the other.
    if (kind === 'ties' && field === 'relations' && Array.isArray(value)) {
      const called = (end: { type?: string; id?: string } | undefined): string => (end?.type === 'character' ? project.characters.find(card => card.id === end.id)?.name : project.world.find(entry => entry.id === end?.id)?.name) ?? end?.id ?? '?'
      return (value as { kind: string; from?: { type: string; id: string }; to?: { type: string; id: string }; since?: string; until?: string; note?: string }[])
        .map(tie => `${called(tie.from)} ${TIE_WORD[tie.kind] !== undefined ? t(...TIE_WORD[tie.kind]!) : tie.kind} ${called(tie.to)}${tie.since !== undefined || tie.until !== undefined ? t(`（${tie.since !== undefined ? `${names('chapter', tie.since) as string} 起` : ''}${tie.until !== undefined ? ` 到 ${names('chapter', tie.until) as string}` : ''}）`, ` (${tie.since !== undefined ? `from ${names('chapter', tie.since) as string}` : ''}${tie.until !== undefined ? ` until ${names('chapter', tie.until) as string}` : ''})`) : ''}${tie.note !== undefined ? ` — ${tie.note}` : ''}`)
        .sort().join('\n')
    }
    if (kind === 'script' && field === 'lines' && Array.isArray(value)) {
      return (value as { speakerName?: string; speaker?: string; kind?: string; text?: string; direction?: string; skip?: boolean }[])
        .map(line => `${line.speakerName ?? (line.speaker !== undefined ? project.characters.find(card => card.id === line.speaker)?.name ?? line.speaker : t('旁白', 'Narration'))}${t('：', ': ')}${line.text ?? ''}${line.direction !== undefined && line.direction.length > 0 ? t(`（${line.direction}）`, ` (${line.direction})`) : ''}${line.skip === true ? t('〔不念〕', ' [unspoken]') : ''}`).join('\n')
    }
    if (kind === 'script' && field === 'cues' && Array.isArray(value)) {
      return (value as { kind?: string; caption?: string; note?: string; prompt?: string; ambience?: string }[]).map(cue => `${cue.kind ?? 'bed'}${t('：', ': ')}${cue.caption ?? cue.note ?? cue.prompt ?? cue.ambience ?? ''}`).join('\n')
    }
    if (kind === 'board' && field === 'panels' && Array.isArray(value)) {
      return (value as { description?: string; prompt?: string; characters?: string[]; location?: string }[])
        .map((panel, index) => `${index + 1}. ${panel.description ?? ''}${panel.prompt !== undefined && panel.prompt !== panel.description ? `\n   ${panel.prompt}` : ''}`).join('\n')
    }
    return sayValue(names(field, value), key => (KEYS[key] !== undefined ? t(...KEYS[key]) : key))
  }
}

/**
 * The versions of one thing, and what the one chosen differs in from now.
 * @param name - what the thing is called, for the head of the dialog.
 * @param onRestored - after a version, or a field of one, was put back.
 */
export function HistoryDialog({ kind, id, name, onClose, onRestored }: { kind: HistoryKind; id: string; name: string; onClose: () => void; onRestored?: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const list = useLoad(signal => controller.api.call('history.list', { root, kind, id }, signal), [root, kind, id])
  const versions = list.data?.versions ?? []
  const [chosen, setChosen] = useState<string | undefined>()
  const version = versions.find(item => item.id === chosen) ?? versions[0]
  const read = useLoad(async signal => (version === undefined ? undefined : await controller.api.call('history.read', { root, kind, id, version: version.id }, signal)), [root, kind, id, version?.id])
  const say = useSay(kind, project, t)
  const order = Object.keys(FIELDS[kind])
  const fields = useMemo(() => {
    if (read.data === undefined) return undefined
    const place = (field: HistoryField): number => { const at = order.indexOf(field.path); return at < 0 ? order.length : at }
    return changedFields(kind, read.data.was, read.data.now).sort((left, right) => place(left) - place(right))
  }, [read.data, kind])
  const gone = read.data !== undefined && read.data.now === undefined
  const restore = (which?: string[]): Promise<unknown> => run(async () => {
    if (version === undefined) return
    // What the thing was until now becomes the latest version: the one looked at stays the one looked at.
    setChosen(version.id)
    await controller.api.call('history.restore', { root, kind, id, version: version.id, ...(which !== undefined ? { fields: which } : {}) })
    await controller.refreshProject()
    controller.toast('info', which !== undefined ? t('这一栏已恢复', 'The field was put back') : t('已恢复到这个版本', 'The version was put back'))
    onRestored?.()
    list.reload()
    read.reload()
  })
  const label = (path: string): string => { const known = FIELDS[kind][path]; return known !== undefined ? t(...known) : path }
  return (
    <Modal wide className="nv-history" title={t(`历史版本 · ${name}`, `History · ${name}`)} onClose={onClose} footer={version !== undefined ? (
      <>
        <span className="nv-muted nv-small">{t('红色是这个版本有而现在没有的，绿色是现在新增的。图片不在版本里。', 'Red is what the version had and the thing lost; green is what it gained. Pictures are no part of a version.')}</span>
        <span className="nv-spacer" />
        <Button variant="primary" icon="undo" busy={busy} disabled={fields === undefined || (fields.length === 0 && !gone)} onClick={() => restore()}>{gone ? t('把它放回书里', 'Put it back in the book') : t('整份恢复到这个版本', 'Put the whole version back')}</Button>
      </>
    ) : undefined}>
      {list.data === undefined ? (list.error !== undefined ? <p className="nv-muted">{list.error}</p> : <div className="nv-center"><Spinner /></div>) : versions.length === 0 ? (
        <p className="nv-muted">{t('还没有历史版本。内容每次被改动之前会自动存一份。', 'No versions yet. One is kept each time what it says is about to change.')}</p>
      ) : (
        <div className="nv-history-cols">
          <ul className="nv-list nv-history-list">
            {versions.map(item => (
              <li key={item.id}>
                <button type="button" className={cx('nv-list-row', item.id === version?.id && 'is-active')} onClick={() => { setChosen(item.id) }}>
                  <span className="nv-person-text">
                    <span className="nv-list-title">{new Date(item.at).toLocaleString()}</span>
                    <span className="nv-list-meta">{whyLabel(item.why, t)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="nv-history-fields">
            {fields === undefined ? (read.error !== undefined ? <p className="nv-muted">{read.error}</p> : <div className="nv-center"><Spinner /></div>) : fields.length === 0 ? (
              <p className="nv-muted">{t('这个版本和现在的内容一样。', 'This version says what the thing says now.')}</p>
            ) : fields.map(field => (
              <section key={field.path} className="nv-history-field">
                <header>
                  <strong>{label(field.path)}</strong>
                  {field.was === undefined ? <Chip>{t('那时没有', 'Not there then')}</Chip> : field.now === undefined && !gone ? <Chip>{t('现在没有', 'Not there now')}</Chip> : null}
                  <span className="nv-spacer" />
                  {gone ? null : <Button size="sm" variant="ghost" icon="undo" disabled={busy} onClick={() => restore([field.path])}>{t('只恢复这一栏', 'Put this field back')}</Button>}
                </header>
                <DiffView before={say(field.path, field.was)} after={gone ? say(field.path, field.was) : say(field.path, field.now)} whole />
              </section>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * The way into a thing's history, beside the thing: one button, the same everywhere.
 * @param label - with words beside the icon, where there is room for them.
 */
export function HistoryButton({ kind, id, name, onRestored, label, size = 'sm' }: { kind: HistoryKind; id: string; name: string; onRestored?: () => void; label?: boolean; size?: 'sm' | 'md' }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Another thing in the same place: its history is another's.
  useEffect(() => { setOpen(false) }, [kind, id])
  return (
    <>
      <Button size={size} variant="ghost" icon="history" title={t('历史版本', 'History')} onClick={() => { setOpen(true) }}>{label === true ? t('历史版本', 'History') : undefined}</Button>
      {open ? <HistoryDialog kind={kind} id={id} name={name} onClose={() => { setOpen(false) }} {...(onRestored !== undefined ? { onRestored } : {})} /> : null}
    </>
  )
}

/**
 * The cards and entries taken out of the book, each to be had back as it last was. Nothing where there are none.
 * @param kinds - which of them are listed here.
 */
export function RemovedCards({ kinds, children }: { kinds: readonly HistoryKind[]; children?: (count: number) => ReactNode }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  // What is in the book decides what is out of it: read again when a card comes or goes.
  const removed = useLoad(signal => controller.api.call('history.removed', { root }, signal), [root, project.characters.length, project.world.length, project.styles.length])
  const mine = (removed.data?.removed ?? []).filter(item => kinds.includes(item.kind))
  if (mine.length === 0) return null
  return (
    <div className="nv-removed">
      <button type="button" className="nv-removed-head" onClick={() => { setOpen(!open) }}>
        {children?.(mine.length) ?? t(`最近删除的 · ${mine.length}`, `Deleted · ${mine.length}`)}
      </button>
      {open ? (
        <ul className="nv-list">
          {mine.map(item => (
            <li key={`${item.kind}:${item.id}`} className="nv-removed-row">
              <span className="nv-person-text">
                <span className="nv-list-title">{item.name}</span>
                <span className="nv-list-meta">{new Date(item.at).toLocaleString()}</span>
              </span>
              <Button size="sm" variant="ghost" icon="undo" disabled={busy} onClick={() => run(async () => {
                await controller.api.call('history.restore', { root, kind: item.kind, id: item.id, version: item.version })
                await controller.refreshProject()
                controller.toast('info', t(`「${item.name}」放回来了，和删除前一样`, `"${item.name}" is back as it was`))
                removed.reload()
              })}>{t('恢复', 'Restore')}</Button>
              <Button size="sm" variant="ghost" icon="trash" disabled={busy} title={t('彻底删除：之后找不回来', 'Delete for good: it cannot be had back after')} onClick={() => {
                confirm.ask(t(`彻底删除「${item.name}」？它的历史版本一起删掉，之后找不回来。它的图片不受影响。`, `Delete "${item.name}" for good? Its versions go with it, and it cannot be had back. Its pictures are not touched.`), () => {
                  void run(async () => {
                    await controller.api.call('history.forget', { root, kind: item.kind, id: item.id })
                    removed.reload()
                  })
                })
              }} />
            </li>
          ))}
        </ul>
      ) : null}
      {confirm.element}
    </div>
  )
}

export type { HistoryVersion }

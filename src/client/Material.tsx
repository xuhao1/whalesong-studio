// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What the writer is handed — said where a chapter is written, switched
 * there, and shown.
 *
 * A writer writes from what it is given and from nothing else, so what it was
 * given is the first thing to look at when a piece comes out wrong. Under the
 * brief box of the writing page: who prepares the material (the planner, who
 * looks at the piece first — or the Studio by its rules), the way to have it
 * the other way from right there, what the latest piece of writing on this
 * chapter was handed, and all of it to read. Beside a draft written to be
 * compared: what that draft was written from.
 */
import { useState } from 'react'
import type { MaterialKept, MaterialUsed } from '../shared/types'
import { Icon } from './icons'
import { Button, Menu, Modal, Spinner, useLoad, useProject, useShared, useSnapshot, useStudio, useT } from './ui'

type T = (zh: string, en: string) => string

/** Who puts the writer's material together. */
export type MaterialBy = 'planner' | 'rules' | 'agent'

/** A way of preparing, as it is said in a word beside a draft or on a button. */
export const wayWord = (by: MaterialBy, t: T): string => (by === 'planner' ? t('策划备料', 'planner\'s material') : by === 'agent' ? t('写手自己读、自己写', 'the writer as an agent') : t('按规则拼', 'packed by rule'))

/**
 * The way a chapter is written where nothing else is said: the book's own where it has one, else the Studio's setting
 * (`materialBy`) — packed by rule unless the author has it otherwise.
 * @returns the way, and whether it is the book's own.
 */
export function useMaterialSet(): { way: MaterialBy; ofBook: boolean } {
  const studio = useSnapshot(snapshot => snapshot.settings?.settings.materialBy)
  const book = useSnapshot(snapshot => snapshot.project?.manifest.materialBy)
  const set = book ?? studio
  return { way: set === 'planner' || set === 'agent' ? set : 'rules', ofBook: book !== undefined }
}

export function useMaterialDefault(): MaterialBy {
  return useMaterialSet().way
}

/**
 * The way in force where writing is asked for: the settings' default, unless the author picked another here. What is
 * picked here is for the writing done from this page — kept while the page is open, said beside the menu it was
 * picked from — and changes nothing in the settings.
 * @returns the way in force; the way to pick one (`undefined`: as the settings have it again); and which of the two it is.
 */
export function useMaterialBy(): [MaterialBy, (by: MaterialBy | undefined) => void, { byDefault: MaterialBy; own: MaterialBy | undefined }] {
  const byDefault = useMaterialDefault()
  const [own, setOwn] = useShared<MaterialBy | undefined>('write.material', undefined)
  return [own ?? byDefault, setOwn, { byDefault, own }]
}

/** The entries a menu beside a button that writes has for it: as the settings have it, or one of the three ways for here. */
export function useMaterialItems(): { label: string; onSelect: () => void }[] {
  const t = useT()
  const [, choose, { byDefault, own }] = useMaterialBy()
  const { ofBook } = useMaterialSet()
  const mark = (way: MaterialBy | undefined): string => (own === way ? '✓ ' : '')
  return [
    { label: ofBook
      ? t(`${mark(undefined)}照这本书的设置（现在是：${wayWord(byDefault, t)}）`, `${mark(undefined)}As this book has it (now: ${wayWord(byDefault, t)})`)
      : t(`${mark(undefined)}照设置里的默认（现在是：${wayWord(byDefault, t)}）`, `${mark(undefined)}As the settings have it (now: ${wayWord(byDefault, t)})`), onSelect: () => { choose(undefined) } },
    { label: t(`${mark('rules')}这里用 · 工坊按规则拼`, `${mark('rules')}Here · packed by the Studio's rules`), onSelect: () => { choose('rules') } },
    { label: t(`${mark('planner')}这里用 · 策划先看这一次要什么，再备料`, `${mark('planner')}Here · the planner looks at the piece first, then prepares it`), onSelect: () => { choose('planner') } },
    { label: t(`${mark('agent')}这里用 · 不备料，写手作为 agent：自己读书、用工具交稿、可以反复改（写一章、续写）`, `${mark('agent')}Here · no material, the writer as an agent: reads for itself, hands the text in with a tool, goes over it (a chapter written or gone on with)`), onSelect: () => { choose('agent') } },
  ]
}

/**
 * What went along: who prepared it, how, and what of the book it holds.
 * @param brief - in a line: how much of each kind went, not which by name (the names are in what is opened to be read).
 */
export function materialWord(material: MaterialUsed, t: T, brief = false): string {
  const size = t(`约 ${material.tokens.toLocaleString()} token`, `about ${material.tokens.toLocaleString()} tokens`)
  // Meant for the writer as an agent, and written this way when that came to nothing: said first.
  const instead = material.instead !== undefined ? t(`本来要写手作为 agent 自己写，没成（${material.instead}），改成：`, `The writer was to write as an agent and it came to nothing (${material.instead}); instead: `) : ''
  if (material.by === 'agent') {
    // Nobody prepared anything: what it was given to start from, how far it read, and how it went over its text.
    const went = [
      material.steps !== undefined ? t(`${material.steps} 步`, `${material.steps} steps`) : undefined,
      material.drafts !== undefined && material.drafts > 1 ? t(`整章交了 ${material.drafts} 次`, `the whole text handed in ${material.drafts} times`) : undefined,
      material.edits !== undefined && material.edits > 0 ? t(`交稿前改了 ${material.edits} 处`, `${material.edits} place(s) changed before it was done`) : undefined,
    ].filter((part): part is string => part !== undefined)
    return `${t('写手作为 agent 自己读、自己写的', 'written by the writer as an agent, reading for itself')}${went.length > 0 ? `（${went.join(t('，', ', '))}）` : ''} · ${t(`开头交给它的${size}`, `${size} given to start from`)}${!brief && material.note !== undefined ? ` · ${material.note}` : ''}`
  }
  if (material.by === 'rules') {
    return `${instead}${material.why !== undefined
      ? t(`工坊按规则拼的（${size}）——策划没能备料：${material.why}`, `packed by the Studio's rules (${size}) — the planner could not prepare it: ${material.why}`)
      : t(`工坊按规则拼的（${size}）`, `packed by the Studio's rules (${size})`)}`
  }
  const named = (names: string[] | undefined, zh: [string, string], en: [string, string]): string | undefined => (names === undefined || names.length === 0 ? undefined
    : brief ? t(`${names.length} ${zh[0]}`, `${names.length} ${en[0]}`) : t(`${zh[1]}：${names.join('、')}`, `${en[1]}: ${names.join(', ')}`))
  const went = [
    material.chapters !== undefined && material.chapters.length > 0 ? t(`第 ${material.chapters.join('、')} 章原文`, `chapter(s) ${material.chapters.join(', ')} word for word`) : undefined,
    material.summaries !== undefined ? t(`${material.summaries} 章梗概`, `${material.summaries} in outline`) : undefined,
    material.excerpts !== undefined ? t(`${material.excerpts} 段原文片段`, `${material.excerpts} passage(s)`) : undefined,
    named(material.people, ['张人物卡', '人物卡'], ['card(s)', 'cards']),
    named(material.world, ['条设定', '设定'], ['entries of the world', 'world']),
    named(material.threads, ['条线索', '线索'], ['thread(s)', 'threads']),
  ].filter((part): part is string => part !== undefined)
  const how = material.how === 'agent'
    ? t(`策划备的${material.steps !== undefined ? `（${material.steps} 步）` : ''}`, `prepared by the planner${material.steps !== undefined ? ` (${material.steps} steps)` : ''}`)
    : material.whole === true
      ? t('策划备的（书不大，整条线摆在它面前，一次备完）', 'prepared by the planner (a small line: all of it before the planner, in one request)')
      : t('策划备的（一问一答：只照清单挑，没有读书）', 'prepared by the planner (in one request: chosen from the lists, nothing read)')
  return `${instead}${how} · ${size}${went.length > 0 ? ` · ${went.join(brief ? t('、', ', ') : t('；', '; '))}` : ''}`
}

const WORK: Record<MaterialKept['work'], [string, string]> = {
  draft: ['写这一章', 'the chapter written'],
  continue: ['续写', 'the chapter gone on with'],
  passage: ['改写一段', 'a passage rewritten'],
  chapter: ['整章重写', 'the chapter written over'],
}

/**
 * Under the brief box: who prepares what the writer is handed — switched here — and what the latest piece of writing
 * on this chapter got.
 * @param fresh - changes when a piece of writing on the chapter ends: what was kept is read again.
 * @param onCompare - have the chapter written both ways, to be read side by side.
 */
export function ChapterMaterial({ chapter, fresh, onCompare }: { chapter: string; fresh?: unknown; onCompare?: (() => void) | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [by, , { byDefault, own }] = useMaterialBy()
  const { ofBook } = useMaterialSet()
  const items = useMaterialItems()
  // (A Host half older than this page keeps none: nothing is shown of it.)
  const kept = useLoad(async signal => (await controller.api.call('material.read', { root, chapter }, signal).catch(() => undefined))?.material, [root, chapter, fresh])
  const [open, setOpen] = useState(false)
  const last = kept.data
  const way = by === 'planner' ? t('策划先备料', 'the planner prepares') : by === 'agent' ? t('写手自己读、自己写', 'the writer as an agent') : t('按规则拼', 'packed by rule')
  // What went last time, in a few words: who put it together and how large it was. All of it is a press away.
  const lastWord = last === undefined ? ''
    : `${last.by === 'agent' ? t('写手自己读写', 'the writer as an agent') : last.by === 'rules' ? t('按规则拼的', 'packed by rule') : t('策划备的', 'the planner\'s')} · ${t(`约 ${last.tokens.toLocaleString()} token`, `about ${last.tokens.toLocaleString()} tokens`)}`
  return (
    <>
      <span className="nv-basis-item" title={t('这一章怎么写：默认在设置里定，这里可以为这一页选别的。写手只看得到交给它的材料：写得不对，先看它拿到了什么', 'How this chapter is written: the default is the settings\', and another can be picked here for this page. A writer sees what it is handed and nothing else: when a piece comes out wrong, look at what it got first')}>
        <Icon name="layers" size={13} />
        <span className="nv-basis-name">{t('写法', 'Written')}</span>
        <Menu icon="chevronDown" variant="ghost" size="sm" label={`${way}${own !== undefined ? t(' · 这里选的', ' · picked here') : ''}`} items={[
          ...items,
          ...(onCompare !== undefined ? ['separator' as const, { label: t('几种各写一稿，并排看…', 'A draft each way, side by side…'), onSelect: onCompare }] : []),
          'separator',
          { label: ofBook ? t(`在设置里改这本书的写法（现在是：${wayWord(byDefault, t)}）…`, `Change this book's own way in the settings (now: ${wayWord(byDefault, t)})…`) : t(`在设置里改默认（现在是：${wayWord(byDefault, t)}）…`, `Change the default in the settings (now: ${wayWord(byDefault, t)})…`), onSelect: () => { controller.openSettings('material') } },
        ]} />
      </span>
      {last !== undefined ? (
        <span className="nv-basis-item" title={`${t(`上一次（${t(...WORK[last.work])}）交给写手的：`, `Handed to the writer last time (${t(...WORK[last.work])}): `)}${materialWord(last, t)}`}>
          <span className="nv-basis-name">{t('上次的材料', 'Last material')}</span>
          <span>{lastWord}</span>
          <button type="button" className="nv-link" onClick={() => { setOpen(true) }}>{t('看', 'Read')}</button>
        </span>
      ) : null}
      {open && last !== undefined ? <MaterialDialog material={last} onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

/**
 * Beside a draft written to be compared: what it was written from, in a line, and all of it to read.
 * @param version - the version the draft is kept as: what its writer read is kept with it.
 */
export function DraftMaterial({ chapter, version, material }: { chapter: string; version?: string | undefined; material: MaterialUsed }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <>
      <span title={materialWord(material, t)}>{materialWord(material, t, true)}</span>
      {version !== undefined ? <button type="button" className="nv-link" title={t('写手读到的全部材料', 'All the writer read')} onClick={() => { setOpen(true) }}>{t('看材料', 'Read it')}</button> : null}
      {open && version !== undefined ? <VersionMaterialDialog chapter={chapter} version={version} material={material} onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

/** What the writer of one draft read, fetched when it is asked for. */
function VersionMaterialDialog({ chapter, version, material, onClose }: { chapter: string; version: string; material: MaterialUsed; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const kept = useLoad(async signal => (await controller.api.call('material.read', { root, chapter, version }, signal)).material ?? null, [root, chapter, version])
  if (kept.data !== undefined && kept.data !== null) return <MaterialDialog material={kept.data} onClose={onClose} />
  return (
    <Modal title={t('这一稿的材料', 'What this draft was written from')} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t('关闭', 'Close')}</Button>}>
      <p className="nv-small">{materialWord(material, t)}</p>
      {kept.data === null ? <p className="nv-note">{t('这一稿没有留下全文材料（它是这一版之前写的）。', 'The whole of it was not kept with this draft (it was written before that was done).')}</p> : kept.error !== undefined ? <p className="nv-note is-warn">{kept.error}</p> : <div className="nv-center"><Spinner /></div>}
    </Modal>
  )
}

function MaterialDialog({ material, onClose }: { material: MaterialKept; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  return (
    <Modal wide title={t(`交给写手的材料 · ${t(...WORK[material.work])} · ${new Date(material.at).toLocaleString()}`, `What the writer was handed · ${t(...WORK[material.work])} · ${new Date(material.at).toLocaleString()}`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('写手读到的就是下面这些（它那一行的写作纪律和全书文风另在规则里）。', 'This is what the writer read (the rules of its trade and the book\'s style stand apart, among its rules).')}</span>
        <span className="nv-spacer" />
        <Button variant="ghost" icon="copy" onClick={() => { void navigator.clipboard?.writeText(material.text).then(() => { controller.toast('success', t('已复制', 'Copied')) }, () => {}) }}>{t('复制', 'Copy')}</Button>
        <Button variant="primary" onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    )}>
      <p className="nv-small">{materialWord(material, t)}</p>
      {material.instruction !== undefined ? <p className="nv-small"><span className="nv-muted">{t('当时的要求：', 'What was asked: ')}</span>{material.instruction}</p> : null}
      {material.note !== undefined ? <p className="nv-note">{t('策划：', 'The planner: ')}{material.note}</p> : null}
      <pre className="nv-material-text">{material.text}</pre>
    </Modal>
  )
}

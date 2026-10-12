// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The versions kept of a chapter: listed with what each is, read against the
 * text as it stands, laid side by side — any number of them, or one — put
 * back, and let go of.
 *
 * A draft written to be compared with others is a version too, and says who
 * wrote it; so the dialog that has several models write a chapter lays its
 * drafts out with what is here, and anything among the versions can be laid
 * beside them.
 */
import { useEffect, useRef, useState } from 'react'
import type { VersionInfo } from '../shared/types'
import { countWords, formatCount, proseOnly } from '../shared/text'
import { Compare, type CompareItem, type CompareMore } from './Compare'
import { DiffView } from './components/ProposalCard'
import { Icon } from './icons'
import { DraftMaterial, wayWord } from './Material'
import { Button, Chip, Modal, Spinner, useAction, useConfirm, useLoad, useProject, useStudio, useT, type Translate } from './ui'

/** The chapter as it stands, among the things laid side by side. */
export const NOW = 'now'

/** The version that is a chapter as it was before it was translated: the only copy of the original, never deleted here. */
const ORIGINAL = 'before-translate'

/** What a version is: why it was kept — and, of a draft written to be compared, by which model. */
export function versionLabel(version: Pick<VersionInfo, 'reason' | 'made'>, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    'edit': ['手动编辑前', 'before an edit'],
    'before-revise': ['修订前', 'before a revision'],
    'before-redraft': ['重新起草前', 'before a redraft'],
    'before-continue': ['续写前', 'before continuing'],
    'before-restore': ['恢复版本前', 'before a restore'],
    'before-translate': ['翻译之前（原文）', 'before it was translated (the original)'],
    'before-import': ['导入前', 'before an import'],
    'before-remove': ['删除章节前', 'before removal'],
    'before-delete': ['删除章节前', 'before removal'],
    'before-illustration': ['插图前', 'before a picture was placed'],
    'manual': ['手动存档', 'manual'],
    'agent-edit': ['总编亲手改动前', 'before an edit by the showrunner'],
    'edit-device': ['在其他设备上改动前', 'before an edit from another device'],
  }
  // A draft written to be compared with others: named by the model that wrote it, as the model is called.
  if (version.made?.how === 'trial') return t(`对比稿 · ${version.made.label}${version.made.material !== undefined ? ` · ${wayWord(version.made.material.by, t)}` : ''}`, `Draft to compare · ${version.made.label}${version.made.material !== undefined ? ` · ${wayWord(version.made.material.by, t)}` : ''}`)
  const label = labels[version.reason]
  // (One kept before who wrote it was kept with it: its model as the file's name has it.)
  if (label === undefined && version.reason.startsWith('trial-')) return t(`对比稿 · ${version.reason.slice(6)}`, `Draft to compare · ${version.reason.slice(6)}`)
  return label !== undefined ? t(...label) : version.reason
}

const isDraft = (version: Pick<VersionInfo, 'reason' | 'made'>): boolean => version.made?.how === 'trial' || version.reason.startsWith('trial-')

/** When a version was kept, briefly. */
export const versionWhen = (version: Pick<VersionInfo, 'createdAt'>): string => {
  const at = new Date(version.createdAt)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The texts of versions, read as they are asked for and kept while the chapter is looked at. */
function useVersionTexts(chapterId: string, wanted: readonly string[]): Record<string, { text?: string; error?: string }> {
  const { controller } = useStudio()
  const { root } = useProject()
  const [texts, setTexts] = useState<Record<string, { text?: string; error?: string }>>({})
  const asked = useRef(new Set<string>())
  useEffect(() => {
    for (const version of wanted) {
      const name = `${chapterId}/${version}`
      if (asked.current.has(name)) continue
      asked.current.add(name)
      void controller.api.call('chapter.version', { root, id: chapterId, version }).then(
        (got) => { setTexts(previous => ({ ...previous, [version]: { text: got.text } })) },
        (reason: unknown) => { setTexts(previous => ({ ...previous, [version]: { error: reason instanceof Error ? reason.message : String(reason) } })) },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted.join('|'), chapterId, root])
  return texts
}

/**
 * Versions of a chapter as things to lay side by side: each with its text, the way to make it the chapter, and the
 * way to delete it — and the list of what else there is to lay beside them.
 * @param keys - what is laid out, in order: version ids, and {@link NOW} for the chapter as it stands.
 * @param apart - versions somebody else lays out already (the drafts a comparison just wrote): not offered again.
 */
export function useVersionColumns({ chapter, versions, keys, current, apart, onAdd, onChanged }: { chapter: { id: string; title: string }; versions: readonly VersionInfo[]; keys: readonly string[]; current?: string | undefined; apart?: readonly string[]; onAdd: (key: string) => void; onChanged?: (() => void) | undefined }): { items: CompareItem[]; more: CompareMore; taken: string | undefined; gone: ReadonlySet<string>; take: (version: string, label: string) => Promise<unknown>; drop: (versions: string[]) => Promise<unknown>; textOf: (version: string) => { text?: string; error?: string } | undefined } {
  const { controller, locale } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [taken, setTaken] = useState<string | undefined>()
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const texts = useVersionTexts(chapter.id, [...keys.filter(key => key !== NOW), ...(apart ?? [])])
  const words = (count: number): string => `${formatCount(count, locale)}${t(' 字', ' words')}`
  const take = (version: string, label: string): Promise<unknown> => controller.guard(async () => {
    await controller.api.call('chapter.restore', { root, id: chapter.id, version })
    setTaken(version)
    await controller.refreshProject()
    onChanged?.()
    // (A chapter that had no text had nothing to keep.)
    const had = current === undefined || current.trim().length > 0
    controller.toast('success', t(`「${chapter.title}」的正文换成了：${label}。${had ? '换下来的那一份在“版本”里。' : ''}`, `"${chapter.title}" is now: ${label}.${had ? ' What it had is among its versions.' : ''}`))
  })
  const drop = (ids: string[]): Promise<unknown> => controller.guard(async () => {
    const done = await controller.api.call('chapter.dropVersions', { root, id: chapter.id, versions: ids })
    setGone(previous => new Set([...previous, ...ids.filter(id => !done.kept.includes(id))]))
    onChanged?.()
    controller.toast('success', t(`删掉了 ${done.removed} 个版本${done.kept.length > 0 ? `；翻译之前的原文留着（它是原文唯一的一份）` : ''}`, `${done.removed} version(s) deleted${done.kept.length > 0 ? '; the original from before the translation stays (it is the only copy)' : ''}`))
  })
  const byId = new Map(versions.map(version => [version.id, version]))
  const items: CompareItem[] = []
  for (const key of keys) {
    if (key === NOW) {
      if (current !== undefined) items.push({ key: NOW, title: t('现在的正文', 'The text as it stands'), sub: words(countWords(proseOnly(current))), text: current })
      continue
    }
    const version = byId.get(key)
    if (version === undefined || gone.has(key)) continue
    const label = versionLabel(version, t)
    const read = texts[key]
    items.push({
      key,
      title: label,
      sub: `${versionWhen(version)} · ${words(version.words)}`,
      ...(version.made?.material !== undefined ? { note: <DraftMaterial chapter={chapter.id} version={key} material={version.made.material} /> } : {}),
      ...(read?.error !== undefined ? { error: read.error } : read?.text !== undefined ? { text: read.text } : { loading: true }),
      taken: taken === key,
      action: taken === key ? <Chip tone="green">{t('现在的正文是它', 'the text now')}</Chip> : <Button size="sm" variant="outline" icon="undo" title={t('把正文换成这一版；现在的正文先存成一个版本', 'Make this the chapter; the text as it stands is kept as a version first')} onClick={() => take(key, label)}>{t('用这一版', 'Use this one')}</Button>,
      ...(version.reason !== ORIGINAL ? { drop: { ask: t(`删掉「${label}」（${versionWhen(version)}）这个版本？删了找不回来。`, `Delete the version "${label}" (${versionWhen(version)})? It cannot be brought back.`), run: () => { void drop([key]) } } } : {}),
    })
  }
  const laid = new Set([...keys, ...(apart ?? [])])
  const more: CompareMore = {
    label: t('＋ 加一栏…', '+ another column…'),
    options: [
      ...(current !== undefined && current.trim().length > 0 && !laid.has(NOW) ? [{ key: NOW, label: t('现在的正文', 'The text as it stands') }] : []),
      ...versions.filter(version => !laid.has(version.id) && !gone.has(version.id)).map(version => ({ key: version.id, label: `${versionLabel(version, t)} · ${versionWhen(version)} · ${words(version.words)}`, group: isDraft(version) ? t('对比稿', 'Drafts to compare') : t('别的版本', 'Other versions') })),
    ],
    onAdd,
  }
  return { items, more, taken, gone, take, drop, textOf: version => texts[version] }
}

/** Versions of a chapter laid side by side: the ones picked, and whatever else is added to the row. */
export function VersionsCompare({ chapter, versions, start, current, onClose, onChanged }: { chapter: { id: string; title: string }; versions: readonly VersionInfo[]; start: readonly string[]; current?: string | undefined; onClose: () => void; onChanged?: (() => void) | undefined }) {
  const t = useT()
  const [keys, setKeys] = useState<string[]>([...start])
  const columns = useVersionColumns({ chapter, versions, keys, current, onAdd: (key) => { setKeys(previous => (previous.includes(key) ? previous : [...previous, key])) }, onChanged })
  return (
    <Modal wide roomy="compare" className="nv-modal-trial nv-modal-compare" title={t(`并排看「${chapter.title}」的版本`, `Versions of "${chapter.title}", side by side`)} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('勾几个就并排几个，只留一个就是单看这一版。“用这一版”把正文换成它，换下来的先存成一个版本。', 'As many side by side as are ticked — one alone is that version read by itself. "Use this one" makes it the chapter; what the chapter had is kept as a version first.')}</span>
        <span className="nv-spacer" />
        <Button variant="ghost" onClick={onClose}>{t('关闭', 'Close')}</Button>
      </>
    )}>
      <Compare name="drafts" items={columns.items} more={columns.more} />
    </Modal>
  )
}

/** One version against the chapter as it stands: what it had that is gone, what has been added since. */
export function VersionModal({ chapterId, version, current, onClose }: { chapterId: string; version: VersionInfo; current: string; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const { busy, run } = useAction()
  const old = useLoad(signal => controller.api.call('chapter.version', { root, id: chapterId, version: version.id }, signal), [root, chapterId, version.id])
  return (
    <Modal wide title={`${versionLabel(version, t)} · ${new Date(version.createdAt).toLocaleString()}`} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('红色是这个版本有而现在没有的，绿色是现在新增的。', 'Red is what this version had and the current text lost; green is what the current text added.')}</span>
        <span className="nv-spacer" />
        <Button variant="primary" icon="undo" busy={busy} disabled={old.data === undefined} onClick={() => run(async () => { await controller.api.call('chapter.restore', { root, id: chapterId, version: version.id }); onClose() })}>{t('恢复到这个版本', 'Restore this version')}</Button>
      </>
    )}>
      {old.data !== undefined ? <DiffView before={old.data.text} after={current} whole /> : old.error !== undefined ? <p className="nv-muted">{old.error}</p> : <div className="nv-center"><Spinner /></div>}
    </Modal>
  )
}

/**
 * The versions of the chapter in hand, in the panel beside its text: a row a version — what it is first, then when —
 * a press on one reads it against the text as it stands; ticked, any number of them are laid side by side, or deleted.
 */
export function VersionsPanel({ chapter, versions, current, onChanged }: { chapter: { id: string; title: string }; versions: readonly VersionInfo[]; current: string; onChanged: () => void }) {
  const { controller, locale } = useStudio()
  const t = useT()
  const { root } = useProject()
  const confirm = useConfirm()
  const { busy, run } = useAction()
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [viewing, setViewing] = useState<VersionInfo | undefined>()
  const [comparing, setComparing] = useState<string[] | undefined>()
  const chosen = versions.filter(version => picked.has(version.id))
  const pick = (id: string): void => { setPicked((previous) => { const next = new Set(previous); if (!next.delete(id)) next.add(id); return next }) }
  const remove = (): void => {
    const original = chosen.some(version => version.reason === ORIGINAL)
    confirm.ask(
      t(`删除选中的 ${chosen.length} 个版本？删了找不回来。${original ? '其中翻译之前的原文不会被删。' : ''}`, `Delete the ${chosen.length} versions picked? They cannot be brought back.${original ? ' The original from before the translation stays.' : ''}`),
      () => void run(async () => {
        const done = await controller.api.call('chapter.dropVersions', { root, id: chapter.id, versions: chosen.map(version => version.id) })
        setPicked(new Set())
        onChanged()
        controller.toast('success', t(`删掉了 ${done.removed} 个版本${done.kept.length > 0 ? '；翻译之前的原文留着' : ''}`, `${done.removed} version(s) deleted${done.kept.length > 0 ? '; the original from before the translation stays' : ''}`))
      }),
    )
  }
  if (versions.length === 0) return <div className="nv-panel-section"><p className="nv-muted">{t('每次 AI 写作、修订或恢复之前都会自动存一份历史版本。', 'A version is saved automatically before every AI draft, revision or restore.')}</p></div>
  return (
    <div className="nv-panel-section">
      <div className="nv-versions-bar">
        {chosen.length === 0 ? <span className="nv-muted nv-small">{t('勾几个并排看；点一行看它和现在的差别。', 'Tick some to lay them side by side; press a row to read it against the text now.')}</span> : (
          <>
            <span className="nv-small">{t(`已选 ${chosen.length} 个`, `${chosen.length} picked`)}</span>
            <button type="button" className="nv-link nv-small" onClick={() => { setPicked(new Set()) }}>{t('清空', 'None')}</button>
            <span className="nv-spacer" />
            <Button size="sm" variant="primary" icon="layers" onClick={() => { setComparing(chosen.map(version => version.id)) }}>{chosen.length === 1 ? t('单看这一版', 'Read it alone') : t(`并排看 ${chosen.length} 个`, `${chosen.length} side by side`)}</Button>
            <Button size="sm" variant="ghost" icon="trash" busy={busy} title={t('删除选中的版本', 'Delete the versions picked')} aria-label={t('删除选中的版本', 'Delete the versions picked')} onClick={remove} />
          </>
        )}
      </div>
      <ul className="nv-list nv-versions">
        {versions.map(version => (
          <li key={version.id} className="nv-version">
            <label className="nv-version-pick" title={t('勾上：并排看，或删除', 'Tick: to lay side by side, or to delete')}>
              <input type="checkbox" checked={picked.has(version.id)} onChange={() => { pick(version.id) }} />
            </label>
            <button type="button" className="nv-list-row" onClick={() => { setViewing(version) }}>
              <span className="nv-person-text">
                <span className="nv-list-title">{versionLabel(version, t)}</span>
                <span className="nv-list-meta">{new Date(version.createdAt).toLocaleString()} · {formatCount(version.words, locale)}{t(' 字', ' words')}</span>
              </span>
              <Icon name="chevronRight" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {viewing !== undefined ? <VersionModal chapterId={chapter.id} version={viewing} current={current} onClose={() => { setViewing(undefined) }} /> : null}
      {comparing !== undefined ? <VersionsCompare chapter={chapter} versions={versions} start={comparing} current={current} onClose={() => { setComparing(undefined) }} onChanged={onChanged} /> : null}
      {confirm.element}
    </div>
  )
}

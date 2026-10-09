// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Translating chapters, from wherever a chapter is at hand: into which
 * language, which chapters, what is asked of the translation — and the
 * glossary it goes by, there to be read, settled and corrected before a line
 * is translated (`core/pipelines/translate.ts`).
 */
import { useEffect, useMemo, useState } from 'react'
import type { GlossaryTerm, JobInfo } from '../shared/types'
import { GLOSSARY_KINDS } from '../shared/types'
import { languageLabel, LANGUAGES } from './labels'
import { Button, Field, Modal, Select, Spinner, TextInput, useAction, useLoad, useProject, useRunningJob, useStudio, useT } from './ui'

type Label = [zh: string, en: string]

const KIND: Record<NonNullable<GlossaryTerm['kind']>, Label> = {
  person: ['人物', 'Person'],
  place: ['地点', 'Place'],
  house: ['家族 / 组织', 'House'],
  thing: ['物品', 'Thing'],
  term: ['名词', 'Term'],
}

/** What the text is in: each chapter's own language as the book has it, the translator's to tell, or one said. */
const AS_IS = ''
const TELL = 'auto'

const translating = (job: JobInfo): boolean => job.title === 'translate' || job.title === 'settle terms'

/** The glossary of one language: every term to be read and changed, added to and taken out of. */
function GlossaryTable({ terms, onChange }: { terms: GlossaryTerm[]; onChange: (terms: GlossaryTerm[]) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return terms.map((term, index) => ({ term, index })).filter(({ term }) => wanted.length === 0 || term.source.toLowerCase().includes(wanted) || term.target.toLowerCase().includes(wanted))
  }, [terms, query])
  const set = (index: number, patch: Partial<GlossaryTerm>): void => { onChange(terms.map((term, at) => (at === index ? { ...term, ...patch } : term))) }
  return (
    <div className="nv-glossary">
      {terms.length > 8 ? <TextInput value={query} placeholder={t('找一个词', 'Find a term')} onChange={(event) => { setQuery(event.target.value) }} /> : null}
      <div className="nv-glossary-rows">
        {shown.map(({ term, index }) => (
          <div key={index} className="nv-glossary-row">
            <TextInput value={term.source} placeholder={t('原文', 'Original')} onChange={(event) => { set(index, { source: event.target.value }) }} />
            <span className="nv-muted">→</span>
            <TextInput value={term.target} placeholder={t('译法', 'Rendering')} onChange={(event) => { set(index, { target: event.target.value }) }} />
            <Select value={term.kind ?? ''} options={[{ value: '', label: '—' }, ...GLOSSARY_KINDS.map(kind => ({ value: kind as string, label: t(...KIND[kind]) }))]} onChange={(value) => { const { kind: _kind, ...rest } = term; onChange(terms.map((other, at) => (at === index ? { ...rest, ...(value !== '' ? { kind: value as NonNullable<GlossaryTerm['kind']> } : {}) } : other))) }} />
            <TextInput className="nv-glossary-note" value={term.note ?? ''} placeholder={t('是什么（给译者看）', 'What it is (for the translator)')} onChange={(event) => { set(index, { note: event.target.value }) }} />
            <Button size="sm" variant="ghost" icon="trash" title={t('删除', 'Delete')} onClick={() => { onChange(terms.filter((_, at) => at !== index)) }} />
          </div>
        ))}
      </div>
      <Button size="sm" variant="ghost" icon="plus" onClick={() => { setQuery(''); onChange([...terms, { source: '', target: '' }]) }}>{t('添加一条', 'Add a term')}</Button>
    </div>
  )
}

/**
 * @param chapters - the chapters at hand (one, from its page; several, ticked): what "these" means.
 * @param line - the line of the plot "all of them" is.
 */
export function TranslateDialog({ chapters, line, onClose }: { chapters: string[]; line: string; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const book = project.manifest.language
  const [to, setTo] = useState(() => (project.manifest.translatedFrom !== undefined && project.manifest.translatedFrom !== book ? project.manifest.translatedFrom : book.toLowerCase().startsWith('zh') ? 'en' : 'zh'))
  const [from, setFrom] = useState(AS_IS)
  const [scope, setScope] = useState<'these' | 'line'>(chapters.length > 0 ? 'these' : 'line')
  const [direction, setDirection] = useState('')
  const [open, setOpen] = useState(false)
  const settling = useRunningJob(job => job.title === 'settle terms') !== undefined
  const running = useRunningJob(translating)
  const kept = useLoad(signal => controller.api.call('glossary.read', { root }, signal), [root, project.revision, settling])
  const [terms, setTerms] = useState<GlossaryTerm[] | undefined>()
  const [dirty, setDirty] = useState(false)
  // What is kept is what is shown, until the author changes something here.
  useEffect(() => { if (!dirty && kept.data !== undefined) setTerms(kept.data.glossaries[to] ?? []) }, [kept.data, to, dirty])
  useEffect(() => { setDirty(false) }, [to])
  const own = (project.lines ?? []).find(item => item.id === line)?.path ?? project.chapters.map(chapter => chapter.id)
  const all = [...project.chapters, ...(project.lines ?? []).flatMap(item => item.chapters)]
  const written = own.map(id => all.find(chapter => chapter.id === id)).filter((chapter): chapter is NonNullable<typeof chapter> => chapter?.hasText === true)
  const these = chapters.map(id => all.find(chapter => chapter.id === id)).filter((chapter): chapter is NonNullable<typeof chapter> => chapter !== undefined)
  const picked = scope === 'these' ? these : written
  /** The language a chapter is in now. */
  const inNow = (id: string): string => project.translations?.[id]?.to ?? book
  const todo = picked.filter(chapter => chapter.hasText && (from !== AS_IS || inNow(chapter.id) !== to))
  const save = (): Promise<unknown> => run(async () => {
    const saved = await controller.api.call('glossary.save', { root, to, terms: (terms ?? []).filter(term => term.source.trim().length > 0 && term.target.trim().length > 0) })
    setTerms(saved.terms)
    setDirty(false)
  })
  const settle = (): Promise<unknown> => run(async () => {
    if (dirty) await save()
    await controller.api.call('ai.settleTerms', { root, to, ...(from !== AS_IS && from !== TELL ? { from } : {}), ...(project.characters.length + project.world.length === 0 ? { scan: true } : {}) })
    await controller.refreshJobs()
    setOpen(true)
  })
  const start = (): Promise<unknown> => run(async () => {
    if (dirty) await save()
    await controller.api.call('ai.translate', { root, to, chapters: todo.map(chapter => chapter.id), ...(from !== AS_IS ? { from } : {}), ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) })
    await controller.refreshJobs()
    controller.toast('info', t(`开始翻译 ${todo.length} 章`, `Translating ${todo.length} chapter(s)`))
    onClose()
  })
  const count = terms?.length ?? 0
  return (
    <Modal wide title={t('翻译', 'Translate')} onClose={onClose} footer={(
      <>
        <span className="nv-muted nv-small">{t('译文替换正文，原文留在这一章的“版本”里。', 'The translation takes the text\'s place; the original stays among the chapter\'s versions.')}</span>
        <span className="nv-spacer" />
        <Button variant="primary" icon="globe" busy={busy} disabled={todo.length === 0 || running !== undefined} onClick={start}>{running !== undefined ? t('正在翻译…', 'Translating…') : t(`翻译 ${todo.length} 章`, `Translate ${todo.length} chapter(s)`)}</Button>
      </>
    )}>
      <div className="nv-form-grid">
        <Field label={t('译成', 'Into')}>
          <Select value={to} options={LANGUAGES.some(item => item.value === to) ? LANGUAGES : [...LANGUAGES, { value: to, label: to }]} onChange={setTo} />
        </Field>
        <Field label={t('原文是', 'From')}>
          <Select value={from} options={[{ value: AS_IS, label: t(`各章现在的语言（${languageLabel(book)}）`, `What each chapter is in (${languageLabel(book)})`) }, { value: TELL, label: t('让译者自己判断', 'Let the translator tell') }, ...LANGUAGES.filter(item => item.value !== to)]} onChange={setFrom} />
        </Field>
        <Field label={t('哪些章', 'Which chapters')}>
          <Select value={scope} options={[
            ...(these.length > 0 ? [{ value: 'these' as const, label: these.length === 1 ? t(`这一章：${these[0]!.index}. ${these[0]!.title}`, `This one: ${these[0]!.index}. ${these[0]!.title}`) : t(`选中的 ${these.length} 章`, `The ${these.length} chosen`) }] : []),
            { value: 'line' as const, label: t(`这条线上有正文的 ${written.length} 章`, `The ${written.length} written chapters of this line`) },
          ]} onChange={setScope} />
        </Field>
        <Field label={t('对译文的要求', 'Asked of the translation')}>
          <TextInput value={direction} placeholder={t('可不填：英式拼写；对白口语一些', 'Optional: British spelling; looser dialogue')} onChange={(event) => { setDirection(event.target.value) }} />
        </Field>
      </div>
      {picked.length > todo.length ? <p className="nv-muted nv-small">{t(`${picked.length - todo.length} 章已经是${languageLabel(to)}或还没有正文，不翻。`, `${picked.length - todo.length} chapter(s) are in ${languageLabel(to)} already, or have no text: left as they are.`)}</p> : null}

      <div className="nv-glossary-head">
        <button type="button" className="nv-link" onClick={() => { setOpen(!open) }}>{t(`译名表（${languageLabel(to)}）· ${count} 条`, `Glossary (${languageLabel(to)}) · ${count}`)}</button>
        <span className="nv-spacer" />
        {settling ? <span className="nv-muted nv-small"><Spinner size={12} /> {t('场记在定译名…', 'Continuity is settling the names…')}</span> : null}
        <Button size="sm" icon="sparkles" busy={busy} disabled={settling || running !== undefined} onClick={settle} title={t('人物和设定里还没有译名的，各定一个；已经定下的不动', 'A rendering for every person and entry that has none; what is settled stands')}>{count === 0 ? t('先定译名', 'Settle the names first') : t('补齐译名', 'Settle the rest')}</Button>
        {dirty ? <Button size="sm" variant="primary" busy={busy} onClick={save}>{t('保存译名', 'Save')}</Button> : null}
      </div>
      {count === 0 && !open ? <p className="nv-muted nv-small">{t('还没有译名：开始翻译时会先定一遍。想先看、先改，点“先定译名”。', 'No names settled yet: they are settled as the translation begins. To read and correct them first, settle them now.')}</p> : null}
      {open && terms !== undefined ? <GlossaryTable terms={terms} onChange={(next) => { setTerms(next); setDirty(true) }} /> : null}
    </Modal>
  )
}

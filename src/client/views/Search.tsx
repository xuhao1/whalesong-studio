// SPDX-License-Identifier: LGPL-3.0-or-later
/** Find (exact, across the manuscript) and search (by meaning, across everything the project knows). */
import { useState } from 'react'
import type { SearchSource } from '../../shared/types'
import { Icon, type IconName } from '../icons'
import {
  Button, Chip, cx, Modal, Spinner, Tabs, TextInput, useDebounced, useLoad, useProject, useSnapshot, useStudio, useT,
} from '../ui'

const SOURCE: Record<SearchSource, { icon: IconName; label: [string, string] }> = {
  manuscript: { icon: 'pen', label: ['正文', 'Manuscript'] },
  character: { icon: 'users', label: ['人物', 'Character'] },
  world: { icon: 'globe', label: ['世界观', 'World'] },
  memory: { icon: 'layers', label: ['章节记忆', 'Memory'] },
  outline: { icon: 'tree', label: ['大纲', 'Outline'] },
}

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const view = useSnapshot(snapshot => snapshot.view)
  const [mode, setMode] = useState<'find' | 'search'>('find')
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 280)
  const target = view === 'read' ? 'read' : 'write'
  const found = useLoad(async signal => mode === 'find' && debounced.length > 0 ? await controller.api.call('find', { root, query: debounced, limit: 120 }, signal) : undefined, [root, mode, debounced])
  const searched = useLoad(async signal => mode === 'search' && debounced.length > 0 ? await controller.api.call('search', { root, query: debounced, limit: 20 }, signal) : undefined, [root, mode, debounced])
  const chapters = new Map(project.chapters.map(chapter => [chapter.id, chapter]))
  const loading = mode === 'find' ? found.loading : searched.loading
  const error = mode === 'find' ? found.error : searched.error

  const open = (source: SearchSource, ref: string, offset?: number, length?: number): void => {
    if (source === 'manuscript' && chapters.has(ref)) controller.jumpTo(ref, offset ?? 0, length ?? 0, target)
    else if (source === 'memory' && chapters.has(ref)) controller.setView('write', ref)
    else if (source === 'outline') controller.setView('outline', chapters.has(ref) ? ref : undefined)
    else controller.setView('bible')
    onClose()
  }

  return (
    <Modal title={t('搜索与查找', 'Search and find')} wide onClose={onClose}>
      <div className="nv-search">
        <div className="nv-search-bar">
          <Icon name="search" size={16} />
          <TextInput autoFocus className="nv-grow" value={query} placeholder={mode === 'find' ? t('在全书正文里查找词句…', 'Find words across the manuscript…') : t('按意思搜索：正文、人物、世界观、记忆、大纲…', 'Search by meaning: prose, characters, world, memory, outline…')} onChange={(event) => { setQuery(event.target.value) }} />
          {loading && debounced.length > 0 ? <Spinner size={14} /> : null}
        </div>
        <Tabs value={mode} onChange={setMode} className="nv-tabs-compact" tabs={[{ value: 'find', label: t('精确查找', 'Exact find') }, { value: 'search', label: t('语义检索', 'By meaning') }]} />
        {error !== undefined ? <p className="nv-muted">{error}</p> : null}

        {mode === 'find' && found.data !== undefined ? (
          <>
            <p className="nv-muted nv-small">{found.data.total === 0 ? t('没有找到。', 'No matches.') : t(`共 ${found.data.total} 处${found.data.total > found.data.matches.length ? `，显示前 ${found.data.matches.length} 处` : ''}`, `${found.data.total} matches${found.data.total > found.data.matches.length ? `, first ${found.data.matches.length} shown` : ''}`)}</p>
            <ul className="nv-search-results">
              {found.data.matches.map((match, index) => (
                <li key={index}>
                  <button type="button" className="nv-search-hit" onClick={() => { open('manuscript', match.chapterId, match.offset, match.length) }}>
                    <span className="nv-search-where">{match.index}. {match.title}</span>
                    <span className="nv-search-text">{match.snippet.slice(0, match.at)}<mark>{match.snippet.slice(match.at, match.at + match.length)}</mark>{match.snippet.slice(match.at + match.length)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {mode === 'search' && searched.data !== undefined ? (
          <>
            <p className="nv-muted nv-small">
              {searched.data.embeddingError !== undefined
                ? t(`向量检索不可用（${searched.data.embeddingError}），当前只按关键词排序。`, `Vector search is unavailable (${searched.data.embeddingError}); ranking by keywords only.`)
                : searched.data.embedded > 0
                  ? t(`关键词 + 向量混合检索（已向量化 ${searched.data.embedded}/${searched.data.indexed} 段）`, `Hybrid keyword + vector search (${searched.data.embedded}/${searched.data.indexed} chunks embedded)`)
                  : t('当前按关键词检索；在设置里配置嵌入模型后可按语义检索。', 'Keyword search for now; configure an embedding model in Settings to search by meaning.')}
              {searched.data.embedded < searched.data.indexed && searched.data.embeddingError === undefined && searched.data.embedded > 0 ? <Button size="sm" variant="ghost" onClick={() => controller.guard(async () => { await controller.run('ai.index', { root }); searched.reload() })}>{t('补全索引', 'Finish indexing')}</Button> : null}
            </p>
            <ul className="nv-search-results">
              {searched.data.hits.map((hit, index) => {
                const chapter = chapters.get(hit.ref)
                return (
                  <li key={index}>
                    <button type="button" className={cx('nv-search-hit')} onClick={() => { open(hit.source, hit.ref, hit.offset, 0) }}>
                      <span className="nv-search-where"><Icon name={SOURCE[hit.source].icon} size={13} /> <Chip>{t(...SOURCE[hit.source].label)}</Chip> {chapter !== undefined ? `${chapter.index}. ` : ''}{hit.title}</span>
                      <span className="nv-search-text">{hit.text.length > 220 ? `${hit.text.slice(0, 220)}…` : hit.text}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {searched.data.hits.length === 0 ? <p className="nv-muted">{t('没有找到相关内容。', 'Nothing relevant found.')}</p> : null}
          </>
        ) : null}

        {debounced.length === 0 ? <p className="nv-muted">{t('"精确查找"逐字匹配全书正文；"语义检索"按意思找——比如搜"她第一次说谎"。点击结果直接跳到那一处。', '"Exact find" matches the manuscript literally; "By meaning" finds what you describe — try "the first time she lies". Click a result to jump there.')}</p> : null}
      </div>
    </Modal>
  )
}

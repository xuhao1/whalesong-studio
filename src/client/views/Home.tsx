// SPDX-License-Identifier: LGPL-3.0-or-later
/** Bookshelf / onboarding (no project open) and the project overview. */
import { useRef, useState, type ReactNode } from 'react'
import { formatCount } from '../../shared/text'
import { resolveArtStyle, splitAvoid } from '../../shared/art'
import type { ProjectManifest } from '../../shared/types'
import { Icon } from '../icons'
import { jobLabel, jobPulse } from '../Studio'
import {
  Button, Chip, cx, Field, Modal, Progress, ProjectImage, SectionTitle, Select, TextArea, TextInput, useAction, useConfirm, useProject, useRunningJob,
  useSnapshot, useStudio, useT, type Translate,
} from '../ui'
import type { StudioController } from '../store'

/**
 * Take a book off the shelf, after asking. Its files go to the trash; the
 * author is told where they are, and what in the folder was left alone.
 */
export function useRemoveBook(): { ask: (book: { root: string; title: string }, after?: () => void) => void; element: ReactNode } {
  const { controller } = useStudio()
  const t = useT()
  const confirm = useConfirm()
  const ask = (book: { root: string; title: string }, after?: () => void): void => {
    confirm.ask(
      t(`删除《${book.title}》？这本书的文件——正文、设定、大纲、插图、配音——会移到废纸篓，可以从那里找回。文件夹里不属于这本书的东西不会动。`, `Remove "${book.title}"? Its files — manuscript, bible, outline, pictures, audio — go to the trash, from where they can be put back. Anything else in its folder is left alone.`),
      () => { void removeBook(controller, t, book).then(after) },
    )
  }
  return { ask, element: confirm.element }
}

async function removeBook(controller: StudioController, t: Translate, book: { root: string; title: string }): Promise<void> {
  await controller.guard(async () => {
    const removed = await controller.api.call('project.delete', { root: book.root })
    if (controller.getSnapshot().root === book.root) controller.closeProject()
    await controller.loadWorkspaces().catch(() => {})
    const where = removed.where === 'trash'
      ? t('已移到废纸篓', 'Moved to the trash')
      : removed.where === 'holding' ? t(`系统废纸篓放不进去，已移到 ${removed.path}`, `The system trash could not take it; moved to ${removed.path}`) : t(`没能移走，文件收在 ${removed.path}`, `It could not be moved away; its files are gathered in ${removed.path}`)
    controller.toast(removed.where === 'trash' ? 'success' : 'info', t(`《${removed.title}》已从书架移除：${where}${removed.left.length > 0 ? `；文件夹里另有 ${removed.left.length} 项不属于这本书，原样保留` : ''}`, `"${removed.title}" is off the shelf: ${where}${removed.left.length > 0 ? `; ${removed.left.length} other item(s) in its folder were left as they were` : ''}`))
  })
}

const LANGUAGES = [
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

/** Read a text file the way novels are usually encoded: UTF-8 first, then GB18030. */
async function readTextFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}

/** A file's bytes as base64, for formats the Host unpacks (EPUB, Word). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error('could not read the file')) }
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

const BOOK_TYPES = '.txt,.md,.markdown,.epub,.docx,.html,.htm,text/plain,application/epub+zip'
const PACKED = /\.(epub|docx)$/i
const NEW_WORKSPACE = '\u0000new'

/** Where the book goes: one of the Harness workspaces, or a new one made on the spot. */
function WorkspaceField({ suggestion }: { suggestion: string }) {
  const { controller, host } = useStudio()
  const t = useT()
  const workspaces = useSnapshot(snapshot => snapshot.workspaces)
  const workspace = useSnapshot(snapshot => snapshot.workspace)
  const home = useSnapshot(snapshot => snapshot.workspaceHome)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const { busy, run } = useAction()
  const open = creating || workspaces.length === 0
  const folder = name.trim() || suggestion.trim() || t('我的小说', 'My novels')
  const create = (path?: string): Promise<unknown> => run(async () => {
    const created = await controller.createWorkspace(path !== undefined ? { path } : { name: folder })
    setCreating(false)
    setName('')
    controller.toast('success', t(`工作区"${created.title}"已建立`, `Workspace "${created.title}" is ready`))
  })
  const current = workspaces.find(candidate => candidate.path === workspace)
  return (
    <div className="nv-workspace-field">
      <Field label={t('保存到工作区', 'Workspace')} hint={open ? undefined : current?.path}>
        <Select
          value={open ? NEW_WORKSPACE : workspace ?? workspaces[0]?.path ?? NEW_WORKSPACE}
          options={[...workspaces.map(item => ({ value: item.path, label: item.title })), { value: NEW_WORKSPACE, label: t('＋ 新建工作区…', '＋ New workspace…') }]}
          onChange={(value) => {
            if (value === NEW_WORKSPACE) setCreating(true)
            else {
              setCreating(false)
              controller.setWorkspace(value)
            }
          }}
        />
      </Field>
      {open ? (
        <div className="nv-workspace-new">
          <Field label={t('新工作区的名字', 'Name of the new workspace')} hint={home !== undefined ? t(`会建立文件夹：${home}/${folder}`, `Creates the folder ${home}/${folder}`) : undefined}>
            <TextInput autoFocus value={name} placeholder={folder} onChange={(event) => { setName(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') create() }} />
          </Field>
          <div className="nv-row-wrap">
            <Button variant="primary" size="sm" busy={busy} pending={t('正在建立…', 'Creating…')} onClick={() => { create() }}>{t('建立', 'Create')}</Button>
            {host.pickDirectory !== undefined ? (
              <Button size="sm" icon="folder" disabled={busy} onClick={() => {
                void controller.guard(async () => {
                  const picked = await host.pickDirectory!()
                  if (picked !== null && picked.length > 0) create(picked)
                })
              }}>{t('选用已有文件夹…', 'Use an existing folder…')}</Button>
            ) : null}
            {workspaces.length > 0 ? <Button variant="ghost" size="sm" onClick={() => { setCreating(false) }}>{t('取消', 'Cancel')}</Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function Onboarding() {
  const { controller, locale, host } = useStudio()
  const t = useT()
  const sessionBook = useSnapshot(snapshot => snapshot.sessionBook)
  const workspaces = useSnapshot(snapshot => snapshot.workspaces)
  const workspace = useSnapshot(snapshot => snapshot.workspace)
  const settings = useSnapshot(snapshot => snapshot.settings)
  const [mode, setMode] = useState<'new' | 'import'>('new')
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState(locale.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  const [genre, setGenre] = useState('')
  const [idea, setIdea] = useState('')
  const [draftFoundation, setDraftFoundation] = useState(true)
  const [importText, setImportText] = useState('')
  const [importFile, setImportFile] = useState<{ name: string; size: number; data: string } | undefined>()
  const [importName, setImportName] = useState('')
  const [analyze, setAnalyze] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<{ label: string; done: number; total: number; text: string } | undefined>()
  const { busy, run } = useAction()
  const fileInput = useRef<HTMLInputElement>(null)
  const shelf = workspaces.flatMap(item => item.projects.map(project => ({ ...project, workspace: item.title })))
  const hasBook = importFile !== undefined || importText.trim().length > 0
  const removal = useRemoveBook()
  const [opening, setOpening] = useState<string | undefined>()

  const takeFile = (file: File | undefined): void => {
    if (file === undefined) return
    void run(async () => {
      const stem = file.name.replace(/\.[^.]+$/, '')
      if (PACKED.test(file.name)) {
        setImportFile({ name: file.name, size: file.size, data: await readBase64(file) })
        setImportText('')
      } else {
        setImportText(await readTextFile(file))
        setImportFile(undefined)
      }
      setImportName(stem)
      setMode('import')
    })
  }

  const create = (): Promise<unknown> => run(async () => {
    if (workspace === undefined) return
    const name = title.trim() || importName || t('未命名作品', 'Untitled')
    const withIdea = mode === 'new' && draftFoundation && idea.trim().length > 0
    const created = await controller.api.call('project.create', {
      workspace,
      title: name,
      language,
      ...(genre.trim().length > 0 ? { genre: genre.trim() } : {}),
      ...(mode === 'new' && !withIdea && idea.trim().length > 0 ? { premise: idea.trim() } : {}),
      ...(withIdea ? { idea: idea.trim(), untitled: title.trim().length === 0 } : {}),
      ...(controller.sessionId !== undefined ? { sessionId: controller.sessionId } : {}),
    })
    const follow = async (jobId: string, label: string): Promise<void> => {
      setProgress({ label, done: 0, total: 0, text: '' })
      await controller.follow(jobId, (text, info) => {
        setProgress({ label: jobPulse(info, t) ?? label, done: info.progress?.done ?? 0, total: info.progress?.total ?? 0, text })
      }).done
    }
    try {
      if (created.jobId !== undefined) await follow(created.jobId, t('正在起草设定与开篇大纲…', 'Drafting the bible and the opening outline…'))
      if (mode === 'import' && hasBook) {
        const started = await controller.api.call('ai.import', {
          root: created.root,
          analyze,
          ...(importFile !== undefined ? { file: { name: importFile.name, data: importFile.data } } : { text: importText }),
        })
        await follow(started.jobId, analyze ? t('正在导入并分析整本书…', 'Importing and analyzing the book…') : t('正在导入并拆分章节…', 'Importing and splitting chapters…'))
      }
    } finally {
      setProgress(undefined)
      // Whatever the drafting pass managed to write, the project exists and should open.
      await controller.loadWorkspaces().catch(() => {})
      await controller.openProject(created.root)
    }
  })

  return (
    <div className="nv-onboard">
      <div className="nv-onboard-hero">
        <Icon name="feather" size={30} />
        <h1>{t('小说工坊', 'Novel Studio')}</h1>
        <p>{t('长篇小说的设定、大纲、写作、修订与演出，都在这里。总编在对话里统筹，写手模型执笔，你来定夺。', 'Bible, outline, drafting, revision and staging for long-form fiction. The showrunner coordinates in the chat, the writer model writes, you decide.')}</p>
      </div>

      {settings !== undefined && !settings.ready.text ? (
        <p className="nv-note is-warn nv-onboard-note">
          {t('还没有可用的写作模型，起草和导入分析都需要它。', 'No writing model is available yet; drafting and import analysis need one.')}{' '}
          <button type="button" className="nv-link" onClick={() => { controller.setView('setup') }}>{t('一分钟配好', 'Set it up in a minute')}</button>
        </p>
      ) : null}

      {shelf.length > 0 ? (
        <section className="nv-card">
          <SectionTitle>{t('书架', 'Bookshelf')}</SectionTitle>
          {controller.sessionId !== undefined && shelf.length > 1 ? <p className="nv-muted nv-small">{t('打开哪一本，左边的对话就跟到哪一本——Agent 始终知道你正在看的是哪本书。', 'Open a book and the conversation beside this panel follows — the agent always knows which book you are on.')}</p> : null}
          <div className="nv-shelf">
            {shelf.map(project => (
              <div key={project.root} className={cx('nv-shelf-item', opening === project.root && 'is-opening')}>
                <button type="button" className="nv-shelf-open" disabled={opening !== undefined} onClick={() => { setOpening(project.root); void run(async () => { await controller.openProject(project.root) }).finally(() => { setOpening(undefined) }) }} title={t(`打开《${project.title}》`, `Open "${project.title}"`)}>
                  <span className="nv-shelf-cover">
                    {project.cover !== undefined && project.id !== undefined
                      ? <img alt="" loading="lazy" src={controller.api.media(project.id, project.cover)} />
                      : <span className="nv-shelf-blank"><Icon name="book" size={22} /><em>{project.title.slice(0, 8)}</em></span>}
                    {opening === project.root ? <span className="nv-shelf-busy"><span className="nv-spinner" style={{ width: 18, height: 18 }} aria-hidden="true" /></span> : null}
                  </span>
                  <span className="nv-shelf-title">{project.title}</span>
                  <span className="nv-shelf-meta">{project.workspace}{project.relative !== '.' ? ` / ${project.relative}` : ''}</span>
                  {controller.sessionId !== undefined && project.root === sessionBook ? <Chip tone="blue">{t('对话在这本', 'Conversation is here')}</Chip> : null}
                </button>
                <button type="button" className="nv-shelf-remove" title={t('删除这本书（移到废纸篓）', 'Remove this book (to the trash)')} aria-label={t('删除这本书', 'Remove this book')} onClick={() => { removal.ask(project) }}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
          </div>
          {removal.element}
        </section>
      ) : null}

      <div className="nv-start-choices">
        <button type="button" className={cx('nv-start-choice', mode === 'new' && 'is-active')} onClick={() => { setMode('new') }}>
          <Icon name="sparkles" size={22} />
          <strong>{t('开一本新书', 'Start a new book')}</strong>
          <span>{t('从一个点子开始，AI 起草设定和开篇大纲', 'From an idea — the bible and the opening outline are drafted for you')}</span>
        </button>
        <button
          type="button"
          className={cx('nv-start-choice', mode === 'import' && 'is-active', dragging && 'is-dragging')}
          onClick={() => { setMode('import') }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
          onDragLeave={() => { setDragging(false) }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); takeFile(event.dataTransfer.files[0]) }}
        >
          <Icon name="upload" size={22} />
          <strong>{t('导入一本已有的小说', 'Bring in an existing novel')}</strong>
          <span>{t('整本读进来：拆章、理出人物/设定/大纲/文风，然后续写、修订或做成有声剧。可以直接把文件拖到这里', 'Read the whole book in: chapters, cast, world, outline and style — then continue it, revise it or stage it. Drop a file here')}</span>
        </button>
      </div>

      <section className="nv-card">
        <input ref={fileInput} type="file" accept={BOOK_TYPES} hidden onChange={(event) => { takeFile(event.target.files?.[0]); event.target.value = '' }} />
        <div className="nv-form-grid">
          <WorkspaceField suggestion={title.trim() || importName} />
          <Field label={t('书名', 'Title')} hint={mode === 'new' && draftFoundation ? t('可留空，由 AI 拟定后再改', 'Optional — the draft will propose one') : mode === 'import' ? t('可留空，用文件自带的书名', 'Optional — the file\'s own title is used') : undefined}>
            <TextInput value={title} placeholder={mode === 'import' && importName.length > 0 ? importName : t('暂定名', 'Working title')} onChange={(event) => { setTitle(event.target.value) }} />
          </Field>
          <Field label={t('正文语言', 'Language')}>
            <Select value={language} options={LANGUAGES} onChange={setLanguage} />
          </Field>
          {mode === 'new' ? (
            <Field label={t('类型', 'Genre')}>
              <TextInput value={genre} placeholder={t('如：悬疑、科幻、武侠、言情…', 'e.g. mystery, sci-fi, romance…')} onChange={(event) => { setGenre(event.target.value) }} />
            </Field>
          ) : null}
        </div>

        {mode === 'new' ? (
          <>
            <Field label={t('你想写一个什么样的故事？', 'What story do you want to tell?')}>
              <TextArea value={idea} minRows={4} maxRows={12} placeholder={t('一句话或一段话都可以：谁、想要什么、遇到什么、你最想写的那种感觉……', 'A sentence or a paragraph: who, what they want, what stands in the way, the feeling you are after…')} onChange={(event) => { setIdea(event.target.value) }} />
            </Field>
            <label className="nv-check">
              <input type="checkbox" checked={draftFoundation} onChange={(event) => { setDraftFoundation(event.target.checked) }} />
              <span>{t('让 AI 据此起草故事核、主要人物、世界观、分卷与开篇章纲（之后都可以改）', 'Draft the premise, main cast, world, volumes and opening chapters from it (all editable afterwards)')}</span>
            </label>
          </>
        ) : (
          <>
            <div
              className={cx('nv-import-drop', dragging && 'is-dragging', hasBook && 'has-file')}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => { setDragging(false) }}
              onDrop={(event) => { event.preventDefault(); setDragging(false); takeFile(event.dataTransfer.files[0]) }}
            >
              <Button icon="upload" onClick={() => { fileInput.current?.click() }}>{t('选择文件', 'Choose a file')}</Button>
              <span className="nv-muted">
                {importFile !== undefined
                  ? t(`已选 ${importFile.name}（${formatCount(Math.round(importFile.size / 1024), locale)} KB）`, `${importFile.name} selected (${formatCount(Math.round(importFile.size / 1024), locale)} KB)`)
                  : importText.length > 0
                    ? t(`已读取 ${formatCount(importText.length, locale)} 字符`, `${formatCount(importText.length, locale)} characters loaded`)
                    : t('支持 .txt / .md / .epub / .docx，也可以把文件拖到这里。自动识别 UTF-8 / GBK 与章节标题', '.txt, .md, .epub and .docx; or drop the file here. UTF-8 / GBK and chapter headings are detected')}
              </span>
            </div>
            {importFile === undefined ? (
              <Field label={t('或直接粘贴正文', 'Or paste the text')}>
                <TextArea value={importText.length > 20_000 ? `${importText.slice(0, 20_000)}\n…` : importText} minRows={3} maxRows={8} readOnly={importText.length > 20_000} onChange={(event) => { setImportText(event.target.value) }} />
              </Field>
            ) : null}
            <label className="nv-check">
              <input type="checkbox" checked={analyze} onChange={(event) => { setAnalyze(event.target.checked) }} />
              <span>{t('导入后通读全书：逐章提取摘要与事实，归并人物卡与世界观，生成大纲并提炼文风（长篇需要几分钟；不勾选则只拆分章节，之后随时可以补做）', 'Read the whole book after importing: digest every chapter, merge character cards and world entries, build the outline and learn the style (minutes for a long book; untick to only split chapters and analyze later)')}</span>
            </label>
          </>
        )}

        {progress !== undefined ? (
          <div className="nv-onboard-progress">
            <Progress done={progress.done} total={progress.total} label={progress.label} />
            {progress.text.length > 0 ? <pre className="nv-stream">{progress.text.slice(-600)}</pre> : null}
          </div>
        ) : null}

        <div className="nv-form-actions">
          <Button variant="ghost" icon="settings" onClick={() => { controller.setView('settings') }}>{t('模型设置', 'Model settings')}</Button>
          <Button variant="primary" busy={busy} pending={progress?.label ?? t('正在创建…', 'Creating…')} disabled={workspace === undefined || (mode === 'import' ? !hasBook : (title.trim().length === 0 && idea.trim().length === 0))} onClick={create}>
            {mode === 'import' ? t('创建并导入', 'Create and import') : t('创建作品', 'Create')}
          </Button>
        </div>
      </section>

      {host.startChat !== undefined ? (
        <section className="nv-card nv-chat-cta">
          <Icon name="chat" size={20} />
          <div>
            <strong>{t('更直接的方式：和总编说', 'More direct: just tell the showrunner')}</strong>
            <p className="nv-muted">{t('新建一个对话，预设选"小说家 Novelist"，直接说"帮我把这本小说导进来续写"或"开一本悬疑新书"。工坊会停在对话右侧，随时可以全屏。', 'Start a conversation with the "小说家 Novelist" preset and say what you want — "bring this novel in and continue it", "start a mystery". The Studio docks beside the chat and can go full screen.')}</p>
          </div>
          <Button icon="chat" onClick={() => { const current = workspaces.find(candidate => candidate.path === workspace); host.startChat!(current !== undefined ? { id: current.id, path: current.path } : undefined) }}>{t('开始对话', 'Start a conversation')}</Button>
        </section>
      ) : null}
    </div>
  )
}

export function HomeView() {
  const { controller, locale } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const settings = useSnapshot(snapshot => snapshot.settings)
  const [editing, setEditing] = useState(false)
  const [exported, setExported] = useState<{ path: string; absolute: string } | undefined>()
  const { busy, run } = useAction()
  const { manifest, stats, chapters } = project
  const painting = useRunningJob(job => job.kind === 'illustrate' && job.title === 'illustrate cover') !== undefined
  const paintCover = (): Promise<unknown> | undefined => {
    if (!controller.need('image')) return undefined
    return controller.guard(async () => {
      await controller.run('image.create', { root, kind: 'cover' })
      await controller.refreshProject()
      controller.toast('success', t('封面画好了', 'The cover is ready'))
    })
  }
  const next = chapters.find(chapter => !chapter.hasText)
  const nextPlan = project.outline.volumes.flatMap(volume => volume.chapters).find(plan => plan.id === next?.id)
  const recent = [...chapters].filter(chapter => chapter.hasText && chapter.updatedAt !== undefined).sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')).slice(0, 6)
  const running = jobs.filter(job => job.status === 'running')
  const neglected = project.presence
    .map(entry => ({ entry, card: project.characters.find(card => card.id === entry.character) }))
    .filter(item => item.card !== undefined && item.card.status === 'active' && item.entry.chapters.length > 0 && item.entry.absentFor >= 5)
    .slice(0, 5)

  const writeNext = (): void => {
    if (next === undefined) return
    controller.setView('write', next.id)
    void controller.guard(async () => { await controller.api.call('ai.write', { root, chapter: next.id }) })
  }
  const doExport = (format: 'markdown' | 'text' | 'html' | 'epub'): Promise<unknown> => run(async () => {
    const result = await controller.api.call('export.book', { root, format })
    setExported({ path: result.path, absolute: result.absolute })
    controller.toast('success', t(`已导出到 ${result.path}`, `Exported to ${result.path}`))
  })

  return (
    <div className="nv-page nv-home">
      <section className="nv-hero">
        <div className={cx('nv-hero-cover', project.cover === undefined && 'is-empty')}>
          {project.cover !== undefined
            ? <ProjectImage path={project.cover} alt={t(`《${manifest.title}》的封面`, `Cover of "${manifest.title}"`)} version={project.revision} />
            : <span className="nv-hero-blank"><Icon name="book" size={26} /><em>{manifest.title}</em></span>}
          <Button size="sm" variant={project.cover === undefined ? 'primary' : 'outline'} icon="image" busy={painting} pending={t('绘制中…', 'Painting…')} onClick={paintCover} title={t('按这本书的故事核和美术风格画一张封面；任何一张插图也可以在"演出 → 插图"里设为封面', 'Paint a cover from the book\'s premise and art direction; any illustration can also be made the cover under Stage → Illustrations')}>
            {project.cover === undefined ? t('生成封面', 'Paint a cover') : t('重画', 'Repaint')}
          </Button>
        </div>
        <div className="nv-hero-text">
          <h1>{manifest.title}</h1>
          <div className="nv-hero-meta">
            {manifest.author !== undefined ? <span>{manifest.author}</span> : null}
            {manifest.genre !== undefined ? <Chip>{manifest.genre}</Chip> : null}
            {manifest.themes?.slice(0, 4).map(theme => <Chip key={theme} tone="violet">{theme}</Chip>)}
          </div>
          {manifest.logline !== undefined ? <p className="nv-hero-logline">{manifest.logline}</p> : <p className="nv-muted">{t('还没有一句话梗概。', 'No logline yet.')}</p>}
          {manifest.premise !== undefined ? <p className="nv-hero-premise">{manifest.premise}</p> : null}
        </div>
        <Button variant="ghost" size="sm" icon="pen" onClick={() => { setEditing(true) }}>{t('作品信息', 'Book info')}</Button>
        <Button variant="ghost" size="sm" icon="clock" onClick={() => { controller.setView('usage') }} title={t('这本书用了多少 token、图片和语音，花了多少钱', 'Tokens, pictures and speech this book has used, and what they cost')}>{t('用量', 'Usage')}</Button>
      </section>

      <section className="nv-stats">
        <Stat label={t('字数', 'Words')} value={formatCount(stats.words, locale)} sub={manifest.targetWords !== undefined && manifest.targetWords > 0 ? `${Math.round(stats.words / manifest.targetWords * 100)}%` : undefined} />
        <Stat label={t('章节', 'Chapters')} value={`${stats.chaptersWithText}/${stats.chapters}`} onClick={() => { controller.setView('outline') }} />
        <Stat label={t('人物', 'Characters')} value={String(stats.characters)} onClick={() => { controller.setView('bible') }} />
        <Stat label={t('设定', 'World')} value={String(stats.worldEntries)} onClick={() => { controller.setView('bible') }} />
        <Stat label={t('未回收线索', 'Open threads')} value={String(stats.openThreads)} onClick={() => { controller.setView('outline') }} />
        <Stat label={t('待处理', 'To review')} value={String(stats.pendingProposals + stats.pendingSuggestions)} tone={stats.pendingProposals + stats.pendingSuggestions > 0 ? 'amber' : undefined} onClick={() => { controller.setView('review') }} />
      </section>

      <div className="nv-home-grid">
        <section className="nv-card">
          <SectionTitle>{t('下一步', 'Next steps')}</SectionTitle>
          <ul className="nv-steps">
            {stats.characters === 0 && stats.worldEntries === 0 ? (
              <Step icon="users" title={t('建立人物与世界观', 'Build characters and world')} body={t('先让故事里的人和规则立起来。', 'Give the story its people and its rules first.')} action={t('去设定', 'Open Bible')} onClick={() => { controller.setView('bible') }} />
            ) : null}
            {stats.chapters === 0 ? (
              <Step icon="tree" title={t('推演开篇大纲', 'Derive the opening outline')} body={t('让架构模型根据设定推演前几章。', 'Let the architect model outline the first chapters.')} action={t('去大纲', 'Open Outline')} onClick={() => { controller.setView('outline') }} />
            ) : null}
            {stats.undigested > 0 ? (
              <Step icon="layers" title={t(`${stats.undigested} 章尚未收录记忆`, `${stats.undigested} chapters not digested`)} body={t('收录后，后续写作才能记住这些章节发生了什么。', 'Later chapters only remember what has been digested.')} action={t('收录', 'Digest')} busy={running.some(job => job.kind === 'digest')} onClick={() => controller.guard(async () => { await controller.api.call('ai.digest', { root }) })} />
            ) : null}
            {next !== undefined ? (
              <Step
                icon="pen"
                title={t(`写第 ${next.index} 章《${next.title}》`, `Write chapter ${next.index}, "${next.title}"`)}
                body={nextPlan?.synopsis ?? t('这一章还没有梗概，建议先在大纲里补上。', 'This chapter has no synopsis yet — add one in the outline first.')}
                action={nextPlan?.synopsis !== undefined ? t('开始写', 'Write it') : t('去大纲', 'Open Outline')}
                busy={running.some(job => job.kind === 'write' && job.target === next.id)}
                onClick={nextPlan?.synopsis !== undefined ? writeNext : () => { controller.setView('outline') }}
              />
            ) : stats.chapters > 0 ? (
              <Step icon="tree" title={t('续写：大纲里的章节都有正文了', 'Continue: every outlined chapter has its text')} body={t('让架构模型接着已有的情节推演后续章节，再逐章写下去；也可以先修订与审校。', 'Let the architect derive what comes next from the story so far, then write on chapter by chapter — or revise and review first.')} action={t('推演后续', 'Derive more')} onClick={() => { controller.setView('outline') }} />
            ) : null}
            {stats.chaptersWithText > 0 ? (
              <Step icon="stage" title={t('把写好的章节搬上舞台', 'Put finished chapters on stage')} body={settings?.ready.tts === true ? t('有声剧、有声漫、插图和可以亲自下场的幕间。', 'Audio drama, motion comics, illustrations and playable interludes.') : t('有声剧、有声漫、插图与幕间。配音和插图还没有配置，可以先去接上。', 'Audio drama, motion comics, illustrations and interludes. Speech and images are not set up yet.')} action={settings !== undefined && !settings.ready.tts && !settings.ready.image ? t('去配置', 'Set up') : t('去演出', 'Open Stage')} onClick={() => { controller.setView(settings !== undefined && !settings.ready.tts && !settings.ready.image ? 'setup' : 'stage') }} />
            ) : null}
            {stats.pendingProposals + stats.pendingSuggestions > 0 ? (
              <Step icon="checkCircle" title={t('有待你定夺的提案与建议', 'Proposals and suggestions are waiting')} body={t(`修订提案 ${stats.pendingProposals} 条，设定建议 ${stats.pendingSuggestions} 条。`, `${stats.pendingProposals} revision proposals, ${stats.pendingSuggestions} bible suggestions.`)} action={t('去审校', 'Open Review')} onClick={() => { controller.setView('review') }} />
            ) : null}
            {neglected.length > 0 ? (
              <Step icon="users" title={t('有人物久未出场', 'Some characters have been away')} body={neglected.map(item => `${item.card!.name}（${t(`${item.entry.absentFor} 章`, `${item.entry.absentFor} ch.`)}）`).join(t('、', ', '))} action={t('看群像', 'Open Cast')} onClick={() => { controller.setView('cast') }} />
            ) : null}
          </ul>
        </section>

        <section className="nv-card">
          <SectionTitle>{t('最近的章节', 'Recent chapters')}</SectionTitle>
          {recent.length === 0 ? <p className="nv-muted">{t('还没有正文。', 'No prose yet.')}</p> : (
            <ul className="nv-list">
              {recent.map(chapter => (
                <li key={chapter.id}>
                  <button type="button" className="nv-list-row" onClick={() => { controller.setView('write', chapter.id) }}>
                    <span className="nv-list-index">{chapter.index}</span>
                    <span className="nv-list-title">{chapter.title}</span>
                    <span className="nv-list-meta">{formatCount(chapter.words, locale)}{t(' 字', '')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {running.length > 0 ? (
            <>
              <SectionTitle>{t('进行中的任务', 'Running jobs')}</SectionTitle>
              <ul className="nv-list">
                {running.map(job => (
                  <li key={job.id} className="nv-running">
                    <span>{jobLabel(job, t, project)}</span>
                    <Progress done={job.progress?.done ?? 0} total={job.progress?.total ?? 0} label={jobPulse(job, t)} />
                    <Button size="sm" variant="ghost" icon="stop" onClick={() => { void controller.cancelJob(job.id) }} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>

      <section className="nv-card">
        <SectionTitle>{t('导出', 'Export')}</SectionTitle>
        <div className="nv-row-wrap">
          {(['markdown', 'text', 'html', 'epub'] as const).map(format => <Button key={format} size="sm" icon="download" disabled={busy} pending={t('正在导出…', 'Exporting…')} onClick={() => doExport(format)}>{format === 'markdown' ? 'Markdown' : format === 'text' ? 'TXT' : format.toUpperCase()}</Button>)}
          {exported !== undefined ? <a className="nv-link" href={controller.api.media(manifest.id, exported.path, { download: true })}>{t('下载', 'Download')} {exported.path}</a> : null}
        </div>
        {exported !== undefined ? <p className="nv-muted nv-small">{exported.absolute}</p> : null}
      </section>

      {editing ? <ManifestEditor manifest={manifest} root={root} onClose={() => { setEditing(false) }} /> : null}
    </div>
  )
}

function Stat({ label, value, sub, tone, onClick }: { label: string; value: string; sub?: string | undefined; tone?: 'amber' | undefined; onClick?: () => void }) {
  const body = (
    <>
      <span className="nv-stat-value">{value}{sub !== undefined ? <small>{sub}</small> : null}</span>
      <span className="nv-stat-label">{label}</span>
    </>
  )
  return onClick !== undefined
    ? <button type="button" className={cx('nv-stat', tone === 'amber' && 'is-amber')} onClick={onClick}>{body}</button>
    : <div className={cx('nv-stat', tone === 'amber' && 'is-amber')}>{body}</div>
}

function Step({ icon, title, body, action, onClick, busy }: { icon: Parameters<typeof Icon>[0]['name']; title: string; body: string; action: string; onClick: () => void; busy?: boolean }) {
  return (
    <li className="nv-step">
      <Icon name={icon} size={18} />
      <div className="nv-step-text">
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
      <Button size="sm" variant="primary" busy={busy} onClick={onClick}>{action}</Button>
    </li>
  )
}

function ManifestEditor({ manifest, root, onClose }: { manifest: ProjectManifest; root: string; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const studioStyle = useSnapshot(snapshot => snapshot.settings?.settings.image.stylePrompt)
  // The field shows the direction actually in force, so saving the form pins it to the book.
  const art = resolveArtStyle(manifest, studioStyle)
  const [draft, setDraft] = useState({
    title: manifest.title,
    author: manifest.author ?? '',
    language: manifest.language,
    genre: manifest.genre ?? '',
    logline: manifest.logline ?? '',
    premise: manifest.premise ?? '',
    themes: (manifest.themes ?? []).join('、'),
    targetWords: manifest.targetWords !== undefined ? String(manifest.targetWords) : '',
    chapterWords: manifest.chapterWords !== undefined ? String(manifest.chapterWords) : '',
    artStyle: art.text,
    artAvoid: (manifest.artAvoid ?? []).join(t('、', ', ')),
    notes: manifest.notes ?? '',
  })
  const { busy, run } = useAction()
  const set = (key: keyof typeof draft) => (event: { target: { value: string } }): void => { setDraft(previous => ({ ...previous, [key]: event.target.value })) }
  const save = (): Promise<unknown> => run(async () => {
    const number = (text: string): number | undefined => {
      const value = Number(text)
      return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
    }
    const themes = draft.themes.split(/[、,，;；\n]+/).map(item => item.trim()).filter(item => item.length > 0)
    await controller.api.call('project.update', {
      root,
      patch: {
        title: draft.title.trim() || manifest.title,
        author: draft.author.trim(),
        language: draft.language,
        genre: draft.genre.trim(),
        logline: draft.logline.trim(),
        premise: draft.premise.trim(),
        themes,
        artStyle: draft.artStyle.trim(),
        artAvoid: splitAvoid(draft.artAvoid),
        notes: draft.notes.trim(),
        ...(number(draft.targetWords) !== undefined ? { targetWords: number(draft.targetWords)! } : {}),
        ...(number(draft.chapterWords) !== undefined ? { chapterWords: number(draft.chapterWords)! } : {}),
      },
    })
    onClose()
  })
  return (
    <Modal title={t('作品信息', 'Book info')} onClose={onClose} wide footer={(
      <>
        <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} onClick={save}>{t('保存', 'Save')}</Button>
      </>
    )}>
      <div className="nv-form-grid">
        <Field label={t('书名', 'Title')}><TextInput value={draft.title} onChange={set('title')} /></Field>
        <Field label={t('作者', 'Author')}><TextInput value={draft.author} onChange={set('author')} /></Field>
        <Field label={t('正文语言', 'Language')}><Select value={draft.language} options={LANGUAGES.some(item => item.value === draft.language) ? LANGUAGES : [...LANGUAGES, { value: draft.language, label: draft.language }]} onChange={(value) => { setDraft(previous => ({ ...previous, language: value })) }} /></Field>
        <Field label={t('类型', 'Genre')}><TextInput value={draft.genre} onChange={set('genre')} /></Field>
        <Field label={t('目标总字数', 'Target length')}><TextInput inputMode="numeric" value={draft.targetWords} onChange={set('targetWords')} /></Field>
        <Field label={t('每章字数', 'Words per chapter')}><TextInput inputMode="numeric" value={draft.chapterWords} onChange={set('chapterWords')} /></Field>
      </div>
      <Field label={t('一句话梗概', 'Logline')}><TextArea value={draft.logline} minRows={2} onChange={set('logline')} /></Field>
      <Field label={t('故事核', 'Premise')}><TextArea value={draft.premise} minRows={4} onChange={set('premise')} /></Field>
      <Field label={t('主题', 'Themes')} hint={t('用顿号或逗号分隔', 'Separate with commas')}><TextInput value={draft.themes} onChange={set('themes')} /></Field>
      <Field label={t('美术风格', 'Art direction')} hint={art.source === 'book' ? t('原样接在本书每一张图的画面内容后面', 'Appended as is to the subject of every picture of this book') : art.source === 'studio' ? t('现在显示的是工坊设置里的统一画风；保存后就成为这本书自己的', 'Showing the Studio-wide direction from Settings; saving makes it this book\'s own') : t('现在显示的是内置默认；改成你要的样子，保存后就成为这本书自己的', 'Showing the built-in default; make it yours — saving stores it with this book')}><TextArea value={draft.artStyle} minRows={2} onChange={set('artStyle')} /></Field>
      <Field label={t('画面里不要出现', 'Never in the picture')} hint={t('逗号分隔，作为负面提示词随本书每张图发送', 'Comma-separated; sent as the negative prompt with every picture of this book')}><TextInput value={draft.artAvoid} placeholder={t('如：十字架、哥特式教堂、现代服饰', 'e.g. crosses, gothic cathedral, modern clothing')} onChange={set('artAvoid')} /></Field>
      <Field label={t('作者备注', 'Author notes')} hint={t('总会随上下文提供给模型', 'Always sent to the models with the context')}><TextArea value={draft.notes} minRows={2} onChange={set('notes')} /></Field>
    </Modal>
  )
}

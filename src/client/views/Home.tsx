// SPDX-License-Identifier: LGPL-3.0-or-later
/** Bookshelf / onboarding (no project open) and the project overview. */
import studioIcon from '../../../icon.png'
import createArt from '../art/home-create.webp'
import emptyArt from '../art/home-empty.webp'
import heroArt from '../art/home-hero.webp'
import { useRef, useState, type ReactNode } from 'react'
import { formatCount } from '../../shared/text'
import { resolveArtStyle, splitAvoid } from '../../shared/art'
import { PROJECT_AUTHOR, PROJECT_AUTHOR_HOME, PROJECT_HOMEPAGE } from '../../shared/services'
import { chapterBudgetOf, type AnalyzeStep, type ProjectManifest, type ProjectRef } from '../../shared/types'
import { Icon } from '../icons'
import { jobLabel, jobPulse } from '../Studio'
import {
  Button, Chip, crewLabel, cx, Field, Modal, Progress, ProjectImage, SectionTitle, Select, TextArea, TextInput, useAction, useConfirm, useKept, useProject, useRunningJob,
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

/**
 * The Studio with no book open. The shelf is the page: every book with the
 * ways into it — read, listen, watch, work on it — and above it the two things
 * an author comes to do otherwise, talking to the showrunner and starting
 * something new. Starting something new has a page of its own.
 */
export function Onboarding() {
  // Kept while the Studio is open: going to the settings and back returns to the page that was left.
  const [page, setPage] = useKept<'shelf' | 'new'>('onboard.page', 'shelf')
  return page === 'new' ? <NewBook onBack={() => { setPage('shelf') }} /> : <Shelf onNew={() => { setPage('new') }} />
}

/** Who made this, under what terms, and where it lives. */
function Credits() {
  const t = useT()
  return (
    <footer className="nv-credits">
      <span>© {new Date().getFullYear()} {PROJECT_AUTHOR}</span>
      <span>{__NOVEL_LICENSE__}</span>
      <a className="nv-link" href={PROJECT_HOMEPAGE} target="_blank" rel="noreferrer">{t('官网', 'Website')}</a>
      <a className="nv-link" href={PROJECT_AUTHOR_HOME} target="_blank" rel="noreferrer">{t('作者主页', 'Author')}</a>
      <span className="nv-credits-art" title={t('形象参考了 DeepSeek 社区的鲸鱼女仆娘（DeepSeek 娘）：溟月（上善无形）与 ZipZipPipe 的女仆设计；这里的图是照着重新画的。', 'The figure follows the DeepSeek community\'s whale maid (DeepSeek-chan): Mingyue by 上善无形 and the maid design by ZipZipPipe; the pictures here are drawn anew after them.')}>{t('配图：鲸鱼女仆娘，致敬 DeepSeek 社区', 'Art: the whale maid, with thanks to the DeepSeek community')}</span>
    </footer>
  )
}

type ShelfBook = ProjectRef & { workspace: string }

/**
 * Whom to talk about: a conversation with the showrunner is about a book. One
 * of those on the shelf opens — or gets — its own conversation; a new novel
 * starts on the page where books are made, and gets its conversation there.
 */
function TalkDialog({ shelf, onClose, onNew }: { shelf: ShelfBook[]; onClose: () => void; onNew: () => void }) {
  const { controller, host } = useStudio()
  const t = useT()
  const { run } = useAction()
  const [opening, setOpening] = useState<string | undefined>()
  const talk = (book: ShelfBook): void => {
    setOpening(book.root)
    void run(async () => {
      // A locked book is unlocked first: its conversations are under the same seal.
      if (book.locked === true) {
        await controller.openProject(book.root)
        onClose()
        return
      }
      const conversation = await controller.conversationFor(book.root, true)
      if (conversation !== undefined && host.openChat !== undefined) host.openChat(conversation.sessionId)
      else {
        // A Harness that cannot be told to open a conversation: the book opens, and its overview says where to talk.
        await controller.openProject(book.root)
        if (conversation === undefined) controller.toast('info', t('这个 DSH 不能替你打开对话：请在左侧栏为这本书开一场。', 'This DSH cannot open a conversation for you: start one for this book in the left sidebar.'))
      }
      onClose()
    }).finally(() => { setOpening(undefined) })
  }
  return (
    <Modal title={t('和总编聊哪一本？', 'Which book is this about?')} onClose={onClose}>
      <p className="nv-muted nv-small">{t('一场对话说的是一本书：总编读得到这本书的一切，工坊会停在对话旁边。', 'A conversation is about one book: the showrunner can read everything of it, and the Studio stays beside the conversation.')}</p>
      <ul className="nv-talk-list">
        {shelf.map(book => (
          <li key={book.root}>
            <button type="button" disabled={opening !== undefined} onClick={() => { talk(book) }}>
              <span className="nv-talk-cover">
                {book.locked === true ? <Icon name="lock" size={16} /> : book.cover !== undefined && book.id !== undefined ? <img alt="" loading="lazy" src={controller.api.media(book.id, book.cover)} /> : <Icon name="book" size={16} />}
              </span>
              <span className="nv-talk-text">
                <strong>{book.title}</strong>
                <span className="nv-muted">{book.locked === true ? t('已上锁：先解锁', 'Locked: unlock it first') : `${book.workspace}${book.relative !== '.' ? ` / ${book.relative}` : ''}`}</span>
              </span>
              {opening === book.root ? <span className="nv-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> : <Icon name="chat" size={14} />}
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="is-new" disabled={opening !== undefined} onClick={() => { onClose(); onNew() }}>
            <span className="nv-talk-cover is-new"><Icon name="sparkles" size={16} /></span>
            <span className="nv-talk-text">
              <strong>{t('新小说', 'A new novel')}</strong>
              <span className="nv-muted">{t('去"新创作"页开一本或导入一本；建好后它会有自己的对话', 'Start or bring one in on the New work page; it gets a conversation of its own')}</span>
            </span>
            <Icon name="arrowRight" size={14} />
          </button>
        </li>
      </ul>
    </Modal>
  )
}

/** The shelf: the home page of the Studio. */
function Shelf({ onNew }: { onNew: () => void }) {
  const { controller, host } = useStudio()
  const t = useT()
  const sessionBook = useSnapshot(snapshot => snapshot.sessionBook)
  const workspaces = useSnapshot(snapshot => snapshot.workspaces)
  const settings = useSnapshot(snapshot => snapshot.settings)
  const { run } = useAction()
  const shelf: ShelfBook[] = workspaces.flatMap(item => item.projects.map(project => ({ ...project, workspace: item.title })))
  const removal = useRemoveBook()
  const [opening, setOpening] = useState<string | undefined>()
  const [talking, setTalking] = useState(false)
  const canTalk = host.openChat !== undefined || host.startChat !== undefined
  const go = (root: string, how: 'read' | 'listen' | 'watch', at?: string): void => {
    setOpening(root)
    void run(async () => { await controller.readBook(root, how, at) }).finally(() => { setOpening(undefined) })
  }
  return (
    <div className="nv-onboard nv-home-page">
      <section className="nv-home-hero">
        <div className="nv-home-hero-text">
          <div className="nv-home-brand">
            <img src={studioIcon} alt="" width={44} height={44} />
            <h1>{t('小说工坊', 'Novel Studio')}</h1>
          </div>
          <p>{t('长篇小说的设定、大纲、写作、修订与演出，都在这里。总编在对话里统筹，写手模型执笔，你来定夺。', 'Bible, outline, drafting, revision and staging for long-form fiction. The showrunner runs the room in the conversation, the writer model drafts, and you decide.')}</p>
          <div className="nv-home-actions">
            {canTalk ? (
              <button type="button" className="nv-home-cta is-primary" onClick={() => { if (shelf.length === 0) onNew(); else setTalking(true) }}>
                <Icon name="chat" size={18} />
                <span><strong>{t('和总编对话', 'Talk to the showrunner')}</strong><small>{shelf.length === 0 ? t('先开一本书，对话跟着它', 'Start a book first; its conversation comes with it') : t('挑一本书，或开一本新的', 'Pick a book, or start a new one')}</small></span>
              </button>
            ) : null}
            <button type="button" className="nv-home-cta" onClick={onNew}>
              <Icon name="sparkles" size={18} />
              <span><strong>{t('新创作', 'New work')}</strong><small>{t('开一本新书，或把写好的搬进来', 'Start a new book, or bring one in')}</small></span>
            </button>
          </div>
        </div>
        <img className="nv-home-hero-art" src={heroArt} alt="" />
      </section>

      {settings !== undefined && !settings.ready.text ? (
        <p className="nv-note is-warn nv-onboard-note">
          {t('还没有可用的文字模型，起草和导入分析都需要它。文字模型在 DSH 的"设置 → 模型"里接入；', 'No text model is available yet; drafting and import analysis need one. Text models are connected in DSH under Settings → Models; ')}
          <button type="button" className="nv-link" onClick={() => { controller.setView('setup') }}>{t('看看还要配什么', 'see what else to set up')}</button>
        </p>
      ) : null}

      <section className="nv-home-shelf">
        <header className="nv-home-shelf-head">
          <h2>{t('书架', 'Bookshelf')}<span className="nv-muted">{shelf.length > 0 ? shelf.length : ''}</span></h2>
          <Button size="sm" variant="ghost" icon="settings" onClick={() => { controller.setView('settings') }}>{t('设置', 'Settings')}</Button>
        </header>
        {controller.sessionId !== undefined && shelf.length > 1 ? <p className="nv-muted nv-small">{t('打开哪一本，左边的对话就跟到哪一本——Agent 始终知道你正在看的是哪本书。', 'Open a book and the conversation beside this panel follows it — the agent always knows which book you are looking at.')}</p> : null}
        {shelf.length > 0 ? (
          <div className="nv-shelf">
            {shelf.map(project => (
              <div key={project.root} className={cx('nv-shelf-item', opening === project.root && 'is-opening')}>
                <button type="button" className="nv-shelf-open" disabled={opening !== undefined} onClick={() => { setOpening(project.root); void run(async () => { await controller.readBook(project.root) }).finally(() => { setOpening(undefined) }) }} title={project.locked === true ? t(`打开《${project.title}》`, `Open "${project.title}"`) : t(`读《${project.title}》：回到上次读到的地方`, `Read "${project.title}": back where you left off`)}>
                  <span className="nv-shelf-cover">
                    {project.locked === true
                      ? <span className="nv-shelf-blank is-locked"><Icon name="lock" size={22} /><em>{t('已上锁', 'Locked')}</em></span>
                      : project.cover !== undefined && project.id !== undefined
                        ? <img alt="" loading="lazy" src={controller.api.media(project.id, project.cover)} />
                        : <span className="nv-shelf-blank"><Icon name="book" size={22} /><em>{project.title.slice(0, 8)}</em></span>}
                    {project.sealed === true && project.locked !== true ? <span className="nv-shelf-seal" title={t('这本书加了密，现在是解锁状态', 'This book is sealed, and unlocked right now')}><Icon name="unlock" size={11} /></span> : null}
                    {opening === project.root ? <span className="nv-shelf-busy"><span className="nv-spinner" style={{ width: 18, height: 18 }} aria-hidden="true" /></span> : null}
                  </span>
                  <span className="nv-shelf-title">{project.title}</span>
                  <span className="nv-shelf-meta">{project.workspace}{project.relative !== '.' ? ` / ${project.relative}` : ''}</span>
                  {controller.sessionId !== undefined && project.root === sessionBook ? <Chip tone="blue">{t('对话在这本', 'Conversation is here')}</Chip> : null}
                </button>
                {project.locked === true ? null : (
                  <div className="nv-shelf-over">
                    <button type="button" className="nv-shelf-edit" disabled={opening !== undefined} onClick={() => { setOpening(project.root); void run(async () => { await controller.openProject(project.root) }).finally(() => { setOpening(undefined) }) }} title={t('进这本书的工作台：总览、人物、设定、大纲、写作、演出', 'Open this book\'s workbench: overview, people, bible, outline, writing, stage')}><Icon name="pen" size={12} />{t('编辑', 'Work on it')}</button>
                  </div>
                )}
                {project.locked === true ? null : (
                  <div className="nv-shelf-ways">
                    {project.shows?.read !== undefined ? <button type="button" disabled={opening !== undefined} onClick={() => { go(project.root, 'read') }} title={t(`读：${project.shows.read.chapters} 章有正文，回到上次读到的地方`, `Read: ${project.shows.read.chapters} chapters written; back where you left off`)}><Icon name="book" size={12} />{t('读', 'Read')}</button> : null}
                    {project.shows?.listen !== undefined ? <button type="button" disabled={opening !== undefined} onClick={() => { go(project.root, 'listen', project.shows!.listen!.first) }} title={t(`听：${project.shows.listen.chapters} 章有配音`, `Listen: ${project.shows.listen.chapters} chapters voiced`)}><Icon name="headphones" size={12} />{t('听', 'Listen')}</button> : null}
                    {project.shows?.watch !== undefined ? <button type="button" disabled={opening !== undefined} onClick={() => { go(project.root, 'watch', project.shows!.watch!.first) }} title={t(`看：${project.shows.watch.chapters} 章有画面（有声漫 / 成片）`, `Watch: ${project.shows.watch.chapters} chapters drawn (motion comic / video)`)}><Icon name="film" size={12} />{t('看', 'Watch')}</button> : null}
                    {project.shows !== undefined && project.shows.read === undefined ? <span className="nv-muted">{t('还没有正文', 'Nothing written yet')}</span> : null}
                  </div>
                )}
                <button type="button" className="nv-shelf-remove" title={t('删除这本书（移到废纸篓）', 'Remove this book (to the trash)')} aria-label={t('删除这本书', 'Remove this book')} onClick={() => { removal.ask(project) }}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
            <button type="button" className="nv-shelf-new" onClick={onNew} title={t('开一本新书，或导入一本已有的', 'Start a new book, or bring in an existing one')}>
              <Icon name="plus" size={22} />
              <span>{t('新创作', 'New work')}</span>
            </button>
          </div>
        ) : (
          <div className="nv-home-empty">
            <img src={emptyArt} alt="" width={176} height={176} />
            <div>
              <strong>{t('书架还空着', 'The shelf is empty')}</strong>
              <p className="nv-muted">{t('从一个点子开一本新书，或者把已经写好的小说整本搬进来——人物、设定、大纲会替你理出来。', 'Start a new book from an idea, or bring a finished novel in whole — its people, world and outline are worked out for you.')}</p>
              <Button variant="primary" icon="sparkles" onClick={onNew}>{t('新创作', 'New work')}</Button>
            </div>
          </div>
        )}
        {removal.element}
      </section>

      <Credits />
      {talking ? <TalkDialog shelf={shelf} onClose={() => { setTalking(false) }} onNew={onNew} /> : null}
    </div>
  )
}

/** Starting something new: a book from an idea, or one that exists brought in whole. */
function NewBook({ onBack }: { onBack: () => void }) {
  const { controller, locale } = useStudio()
  const t = useT()
  const workspaces = useSnapshot(snapshot => snapshot.workspaces)
  const workspace = useSnapshot(snapshot => snapshot.workspace)
  const settings = useSnapshot(snapshot => snapshot.settings)
  // The form is kept while the Studio is open: going to the settings and back does not empty it.
  const [mode, setMode] = useKept<'new' | 'import'>('onboard.mode', 'new')
  const [title, setTitle] = useKept('onboard.title', '')
  const [language, setLanguage] = useKept('onboard.language', locale.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  const [genre, setGenre] = useKept('onboard.genre', '')
  const [idea, setIdea] = useKept('onboard.idea', '')
  const [draftFoundation, setDraftFoundation] = useKept('onboard.foundation', true)
  const [importText, setImportText] = useKept('onboard.importText', '')
  const [importFile, setImportFile] = useKept<{ name: string; size: number; data: string } | undefined>('onboard.importFile', undefined)
  const [importName, setImportName] = useKept('onboard.importName', '')
  const [analyze, setAnalyze] = useKept('onboard.analyze', true)
  // Sealing from the first file on: the password is typed here and nowhere else.
  const [seal, setSeal] = useKept('onboard.seal', false)
  const [password, setPassword] = useKept('onboard.password', '')
  const [again, setAgain] = useKept('onboard.again', '')
  const [shelfName, setShelfName] = useKept('onboard.shelfName', '')
  const sealReady = !seal || (password.length >= 4 && password === again)
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState<{ label: string; done: number; total: number; text: string } | undefined>()
  const { busy, run } = useAction()
  const fileInput = useRef<HTMLInputElement>(null)
  const hasBook = importFile !== undefined || importText.trim().length > 0

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
      ...(seal ? { seal: { password, ...(shelfName.trim().length > 0 ? { label: shelfName.trim() } : {}) } } : {}),
    })
    // The book exists: what was typed for it has been used, the password first of all.
    for (const key of [...controller.kept.keys()]) if (key.startsWith('onboard.')) controller.kept.delete(key)
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
      // A book is talked over with the showrunner: it gets a conversation of its own — or, made beside one, that one is its own.
      if (controller.sessionId !== undefined) controller.noteOwnConversation(created.root)
      else await controller.conversationFor(created.root, true).catch(() => undefined)
    }
  })

  return (
    <div className="nv-onboard nv-new-page">
      <header className="nv-new-head">
        <Button variant="ghost" size="sm" icon="chevronLeft" onClick={onBack}>{t('书架', 'Bookshelf')}</Button>
        <div className="nv-new-title">
          <h1>{t('新创作', 'New work')}</h1>
          <p className="nv-muted">{t('从一个点子开一本新书，或者把写好的小说整本搬进来。建好之后，这本书会有一场自己的对话。', 'A new book from an idea, or a finished novel brought in whole. Once it exists, the book has a conversation of its own.')}</p>
        </div>
        <img className="nv-new-art" src={createArt} alt="" width={120} height={120} />
      </header>

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

        <div className="nv-onboard-seal">
          <label className="nv-check">
            <input type="checkbox" checked={seal} onChange={(event) => { setSeal(event.target.checked) }} />
            <span><Icon name="lock" size={12} /> {t('加密这本书：从第一个文件起就加密保存', 'Seal this book: encrypted from its first file on')}</span>
          </label>
          {seal ? (
            <>
              <p className="nv-muted nv-small">{t('正文、设定、大纲、记忆、插图、配音——这本书的每一个文件都只以密文存在磁盘上，起草和导入的内容也直接写成密文。打开它要输入密码；创建之后可以在“加密”里再加上这台电脑的指纹 / 系统密码解锁。密码是最后的钥匙：忘了它，这本书就打不开，没有后门。', 'Text, bible, outline, memory, pictures, voices — every file of this book exists on disk only as ciphertext, and what is drafted or imported now is written that way from the start. It opens with its password; this computer\'s fingerprint or system password can be added afterwards under "Seal". The password is the last key: lose it and the book cannot be opened — there is no back door.')}</p>
              <div className="nv-form-grid">
                <Field label={t('密码', 'Password')} hint={t('至少 4 个字符；越长越好，可以是一句话', 'At least 4 characters; longer is better — a phrase works')}>
                  <TextInput type="password" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value) }} />
                </Field>
                <Field label={t('再输一遍', 'Once more')} hint={again.length > 0 && password !== again ? t('两次输入的不一样', 'The two do not match') : undefined}>
                  <TextInput type="password" autoComplete="new-password" value={again} onChange={(event) => { setAgain(event.target.value) }} />
                </Field>
                <Field label={t('书架上显示的名字（可不填）', 'Name shown on the shelf (optional)')} hint={t('上锁时，书架和用量记录里只显示这个名字；不填就显示书名', 'While locked, the shelf and the usage ledger show only this name; the title when left empty')}>
                  <TextInput value={shelfName} placeholder={title.trim() || t('如：我的草稿', 'e.g. My draft')} onChange={(event) => { setShelfName(event.target.value) }} />
                </Field>
              </div>
            </>
          ) : null}
        </div>

        {progress !== undefined ? (
          <div className="nv-onboard-progress">
            <Progress done={progress.done} total={progress.total} label={progress.label} />
            {progress.text.length > 0 ? <pre className="nv-stream">{progress.text.slice(-600)}</pre> : null}
          </div>
        ) : null}

        <div className="nv-form-actions">
          <Button variant="ghost" icon="settings" onClick={() => { controller.setView('settings') }}>{t('模型设置', 'Model settings')}</Button>
          <Button variant="primary" busy={busy} pending={progress?.label ?? t('正在创建…', 'Creating…')} disabled={workspace === undefined || !sealReady || (mode === 'import' ? !hasBook : (title.trim().length === 0 && idea.trim().length === 0))} title={!sealReady ? t('先把加密的密码填好：至少 4 个字符，两次一致', 'Fill in the seal\'s password first: at least 4 characters, typed the same twice') : undefined} onClick={create}>
            {mode === 'import' ? t('创建并导入', 'Create and import') : t('创建作品', 'Create')}
          </Button>
        </div>
      </section>

    </div>
  )
}

/**
 * Said once when a book has just been given its conversation: where the
 * author goes to talk the book over. A book made beside a conversation has
 * that one; a book made on the shelf gets one of its own.
 */
function BookConversation() {
  const { controller, host } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const note = useSnapshot(snapshot => snapshot.conversation)
  if (note === undefined || note.root !== root) return null
  const title = project.manifest.title
  return (
    <section className="nv-card nv-chat-cta" role="status">
      <Icon name="chat" size={20} />
      <div>
        <strong>{note.created ? t(`《${title}》有自己的对话了`, `"${title}" has a conversation of its own`) : t('这本书就在旁边这场对话里', 'This book is in the conversation beside it')}</strong>
        <p className="nv-muted">
          {note.created
            ? t(`已经在左侧栏为它开了一场对话${note.title !== undefined ? `（${note.title}）` : ''}。设定怎么调、接下来写什么、哪里不满意，都可以去那里直接跟总编说——它读得到这本书的一切，工坊会停在对话右边。之后从总览页的"和总编讨论"随时回到它。`, `A conversation was opened for it in the left sidebar${note.title !== undefined ? ` (${note.title})` : ''}. What to change in the bible, what to write next, what you do not like: say it there to the showrunner — it can read all of this book, and the Studio docks beside the conversation. "Talk it over" on the overview takes you back to it any time.`)
            : t('想讨论设定、让总编动笔、说哪里不满意，直接在旁边的对话里说——总编现在就在这本书上，你在工坊里看到的它都读得到。', 'To talk the bible over, have the showrunner write, or say what is wrong: say it in the conversation beside this — the showrunner is on this book now and can read everything you see here.')}
        </p>
      </div>
      {note.created && host.openChat !== undefined ? <Button variant="primary" icon="chat" onClick={() => { host.openChat!(note.sessionId) }}>{t('去对话', 'Open it')}</Button> : null}
      <Button variant="ghost" onClick={() => { controller.dismissConversation() }}>{t('知道了', 'Got it')}</Button>
    </section>
  )
}

export function HomeView() {
  const { controller, locale } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const settings = useSnapshot(snapshot => snapshot.settings)
  const [editing, setEditing] = useState(false)
  const [redigesting, setRedigesting] = useState(false)
  const [exported, setExported] = useState<{ path: string; absolute: string } | undefined>()
  const { busy, run } = useAction()
  const { host } = useStudio()
  const talking = useAction()
  const workspaces = useSnapshot(snapshot => snapshot.workspaces)
  const talk = (): Promise<unknown> => talking.run(async () => {
    const found = await controller.conversationFor(root, true)
    if (found !== undefined) host.openChat?.(found.sessionId)
    else {
      // A Harness that cannot make one: an empty conversation in the book's folder, for the author to set up.
      const workspace = workspaces.find(candidate => candidate.projects.some(ref => ref.root === root))
      host.startChat?.(workspace !== undefined ? { id: workspace.id, path: workspace.path } : undefined)
    }
  })
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
          <button type="button" className="nv-hero-read" disabled={stats.chaptersWithText === 0} onClick={() => { void controller.readBook(root) }} title={stats.chaptersWithText > 0 ? t('读这本书：回到上次读到的地方', 'Read this book: back where you left off') : t('还没有正文可读', 'Nothing written to read yet')}>
            {project.cover !== undefined
              ? <ProjectImage path={project.cover} alt={t(`《${manifest.title}》的封面`, `Cover of "${manifest.title}"`)} version={project.revision} />
              : <span className="nv-hero-blank"><Icon name="book" size={26} /><em>{manifest.title}</em></span>}
          </button>
          <Button size="sm" variant={project.cover === undefined ? 'primary' : 'outline'} icon="image" busy={painting} pending={t('绘制中…', 'Painting…')} onClick={paintCover} title={t('按这本书的故事核和美术风格画一张封面；任何一张插图也可以在"演出 → 插图"里设为封面', 'Paint a cover from the book\'s premise and art direction; any illustration can also be made the cover under Stage → Illustrations')}>
            {project.cover === undefined ? t('生成封面', 'Paint a cover') : t('重画', 'Repaint')}
          </Button>
        </div>
        <div className="nv-hero-text">
          <h1>{stats.chaptersWithText > 0
            ? <button type="button" className="nv-hero-title" onClick={() => { void controller.readBook(root) }} title={t('读这本书：回到上次读到的地方', 'Read this book: back where you left off')}>{manifest.title}</button>
            : manifest.title}</h1>
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
        {host.openChat !== undefined ? <Button variant="ghost" size="sm" icon="chat" busy={talking.busy} pending={t('正在打开…', 'Opening…')} onClick={talk} title={t('打开这本书的对话：和总编讨论设定、让它动笔、说哪里不满意。还没有就开一场。', 'Open this book\'s conversation: talk the bible over with the showrunner, have it write, say what is wrong. One is made when there is none.')}>{t('和总编讨论', 'Talk it over')}</Button> : null}
      </section>

      <BookConversation />

      <section className="nv-stats">
        <Stat label={t('字数', 'Words')} value={formatCount(stats.words, locale)} sub={manifest.targetWords !== undefined && manifest.targetWords > 0 ? `${Math.round(stats.words / manifest.targetWords * 100)}%` : undefined} />
        <Stat label={t('章节', 'Chapters')} value={`${stats.chaptersWithText}/${stats.chapters}`} onClick={() => { controller.setView('outline') }} />
        <Stat label={t('人物', 'Characters')} value={String(stats.characters)} onClick={() => { controller.openCast('cards') }} />
        <Stat label={t('设定', 'World')} value={String(stats.worldEntries)} onClick={() => { controller.setView('bible') }} />
        <Stat label={t('未回收线索', 'Open threads')} value={String(stats.openThreads)} onClick={() => { controller.setView('outline') }} />
        <Stat label={t('待处理', 'To review')} value={String(stats.pendingProposals + stats.pendingSuggestions)} tone={stats.pendingProposals + stats.pendingSuggestions > 0 ? 'amber' : undefined} onClick={() => { controller.setView('review') }} />
      </section>

      <div className="nv-home-grid">
        <section className="nv-card">
          <SectionTitle>{t('下一步', 'Next steps')}</SectionTitle>
          <ul className="nv-steps">
            {stats.characters === 0 && stats.worldEntries === 0 ? (
              <Step icon="users" title={t('建立人物与世界观', 'Build characters and world')} body={t('先让故事里的人和规则立起来：人在"人物"页，世界观在"设定"页。', 'Give the story its people and its rules first: people under People, the world under Bible.')} action={t('去人物', 'Open People')} onClick={() => { controller.openCast('cards') }} />
            ) : null}
            {stats.chapters === 0 ? (
              <Step icon="tree" title={t('推演开篇大纲', 'Derive the opening outline')} body={t('让策划根据设定推演前几章。', 'Let the planner model outline the first chapters.')} action={t('去大纲', 'Open Outline')} onClick={() => { controller.setView('outline') }} />
            ) : null}
            {project.analysis !== undefined ? (
              <Step
                icon="layers"
                title={t('这本书的分析没有做完', 'The analysis of this book was left unfinished')}
                body={t(`导入之后要把书读一遍、把读到的记下来；上一次做到一半就停了（DSH 退出、网络中断或被停止）。还差：${project.analysis.pending.map(step => analyzeStepLabel(step, stats.undigested, t)).join('、')}。从停下的地方接着做，做过的不会重来。`, `After an import the book is read through and what it says is written down; last time that stopped half way (DSH quit, the network dropped, or it was stopped). Still to do: ${project.analysis.pending.map(step => analyzeStepLabel(step, stats.undigested, t)).join(', ')}. It goes on where it stopped; nothing done is done again.`)}
                action={t('继续分析', 'Go on')}
                busy={running.some(job => job.kind === 'import')}
                onClick={() => controller.guard(async () => { await controller.api.call('ai.analyze', { root }) })}
              />
            ) : project.uncarded !== undefined ? (
              <Step
                icon="users"
                title={t(`${project.uncarded.count} 个多次出场的人物还没有人物卡`, `${project.uncarded.count} people who keep coming back have no character card`)}
                body={t(`${project.uncarded.names.join('、')}${project.uncarded.count > project.uncarded.names.length ? ' 等' : ''}在好几章里出场，设定集里却没有。让策划按出场多少归并人物表：多次出场的给完整的人物卡，同一个人的不同称呼并到一处，只露一面的仍留作龙套。`, `${project.uncarded.names.join(', ')}${project.uncarded.count > project.uncarded.names.length ? ' and others' : ''} act in several chapters and are not in the bible. The planner makes the cast by how much each is on the page: whole cards for those who keep coming back, one card for one person under several names, and whoever passes once stays a walk-on.`)}
                action={t('归并人物表', 'Make the cast')}
                busy={running.some(job => job.kind === 'import')}
                onClick={() => controller.guard(async () => { await controller.api.call('ai.analyze', { root, steps: ['cast'] }) })}
              />
            ) : null}
            {stats.undigested > 0 && project.analysis?.pending.includes('digest') !== true ? (
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
              <Step icon="tree" title={t('续写：大纲里的章节都有正文了', 'Continue: every outlined chapter has its text')} body={t('让策划接着已有的情节推演后续章节，再逐章写下去；也可以先修订与审校。', 'Let the planner derive what comes next from the story so far, then write on chapter by chapter — or revise and review first.')} action={t('推演后续', 'Derive more')} onClick={() => { controller.setView('outline') }} />
            ) : null}
            {stats.chaptersWithText > 0 ? (
              <Step icon="stage" title={t('把写好的章节搬上舞台', 'Put finished chapters on stage')} body={settings?.ready.tts === true ? t('有声剧、有声漫、插图和可以亲自下场的幕间。', 'Audio drama, motion comics, illustrations and playable interludes.') : t('有声剧、有声漫、插图与幕间。配音和插图还没有配置，可以先去接上。', 'Audio drama, motion comics, illustrations and interludes. Speech and images are not set up yet.')} action={settings !== undefined && !settings.ready.tts && !settings.ready.image ? t('去配置', 'Set up') : t('去演出', 'Open Stage')} onClick={() => { controller.setView(settings !== undefined && !settings.ready.tts && !settings.ready.image ? 'setup' : 'stage') }} />
            ) : null}
            {stats.pendingProposals + stats.pendingSuggestions > 0 ? (
              <Step icon="checkCircle" title={t('有待你定夺的提案与建议', 'Proposals and suggestions are waiting')} body={t(`修订提案 ${stats.pendingProposals} 条，设定建议 ${stats.pendingSuggestions} 条。`, `${stats.pendingProposals} revision proposals, ${stats.pendingSuggestions} bible suggestions.`)} action={t('去审校', 'Open Review')} onClick={() => { controller.setView('review') }} />
            ) : null}
            {neglected.length > 0 ? (
              <Step icon="users" title={t('有人物久未出场', 'Some characters have been away')} body={neglected.map(item => `${item.card!.name}（${t(`${item.entry.absentFor} 章`, `${item.entry.absentFor} ch.`)}）`).join(t('、', ', '))} action={t('看生命周期', 'Open the lifecycle')} onClick={() => { controller.openCast('board') }} />
            ) : null}
            {chapters.some(chapter => chapter.hasText && chapter.digested) ? (
              <Step
                icon="refresh"
                title={t(`已收录 ${chapters.filter(chapter => chapter.hasText && chapter.digested).length} / ${stats.chaptersWithText} 章`, `${chapters.filter(chapter => chapter.hasText && chapter.digested).length} of ${stats.chaptersWithText} chapters digested`)}
                body={t('人物表或设定变了、或者觉得哪几章收录得不准，可以让场记把正文重新读一遍，重写那些章的收录结果。', 'When the cast or the bible has changed, or some chapters were digested poorly, continuity can read the text again and write their digests anew.')}
                action={t('重新收录…', 'Digest again…')}
                quiet
                busy={running.some(job => job.kind === 'digest')}
                onClick={() => { setRedigesting(true) }}
              />
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

      <ChangeRecord />

      <section className="nv-card">
        <SectionTitle>{t('导出', 'Export')}</SectionTitle>
        <div className="nv-row-wrap">
          {(['markdown', 'text', 'html', 'epub'] as const).map(format => <Button key={format} size="sm" icon="download" disabled={busy} pending={t('正在导出…', 'Exporting…')} onClick={() => doExport(format)}>{format === 'markdown' ? 'Markdown' : format === 'text' ? 'TXT' : format.toUpperCase()}</Button>)}
          {exported !== undefined ? <a className="nv-link" href={controller.api.media(manifest.id, exported.path, { download: true })}>{t('下载', 'Download')} {exported.path}</a> : null}
        </div>
        {exported !== undefined ? <p className="nv-muted nv-small">{exported.absolute}</p> : null}
      </section>

      {editing ? <ManifestEditor manifest={manifest} root={root} onClose={() => { setEditing(false) }} /> : null}
      {redigesting ? <RedigestDialog onClose={() => { setRedigesting(false) }} /> : null}
    </div>
  )
}

/**
 * What changed the book lately that the author did not do by hand: the
 * showrunner's tool calls, and changes made to the files outside the Studio.
 * Nothing changes the book unseen; a manuscript edit can be undone from here.
 */
function ChangeRecord() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [all, setAll] = useState(false)
  const confirm = useConfirm()
  const entries = project.activity ?? []
  if (entries.length === 0) return null
  const shown = all ? entries : entries.slice(0, 5)
  const title = (id: string | undefined): string | undefined => {
    const chapter = id !== undefined ? project.chapters.find(candidate => candidate.id === id) : undefined
    return chapter !== undefined ? t(`第 ${chapter.index} 章`, `ch. ${chapter.index}`) : undefined
  }
  const when = (at: string): string => {
    const date = new Date(at)
    return `${date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  }
  const undo = (chapter: string, version: string): void => {
    confirm.ask(t('把这一章恢复到这次改动之前的样子？现在的正文会先存成一个版本，随时可以再换回来。', 'Put this chapter back to how it was before this change? The text in place is kept as a version first, so this can be reversed too.'), () => {
      void controller.guard(async () => {
        await controller.api.call('chapter.restore', { root, id: chapter, version })
        controller.toast('success', t('已恢复到改动之前', 'Restored to before the change'))
      })
    })
  }
  return (
    <section className="nv-card">
      <SectionTitle actions={entries.length > 5 ? <Button size="sm" variant="ghost" onClick={() => { setAll(value => !value) }}>{all ? t('收起', 'Fold') : t(`全部 ${entries.length} 条`, `All ${entries.length}`)}</Button> : undefined}>{t('改动记录', 'What changed the book')}</SectionTitle>
      <p className="nv-muted nv-small">{t('不是你在这块面板上亲手做的改动都记在这里：总编通过工具做的、在手机等其他设备上做的，和工坊之外对文件的直接改动。改过正文的可以一键撤销。', 'Every change not made by your own hand on this panel is listed here: what the showrunner did with its tools, what was done from a phone or another device, and changes made to the files outside the Studio. A change to the manuscript can be undone with one press.')}</p>
      <ul className="nv-record">
        {shown.map(entry => (
          <li key={entry.id} className={cx('nv-record-row', entry.by === 'outside' && 'is-outside')}>
            <span className="nv-record-when">{when(entry.at)}</span>
            <Chip tone={entry.by === 'outside' ? 'amber' : entry.by === 'device' ? 'violet' : entry.by === 'editor' || entry.by === 'crew' ? 'green' : 'blue'}>{entry.by === 'outside' ? t('工坊之外', 'outside') : entry.by === 'device' ? t('其他设备', 'another device') : entry.by === 'crew' ? crewLabel(entry.role ?? 'analyst', t) : entry.by === 'editor' ? t('场记', 'continuity') : t('总编', 'showrunner')}</Chip>
            <span className="nv-record-text">{entry.summary}</span>
            {entry.chapter !== undefined ? <Button size="sm" variant="ghost" icon="eye" onClick={() => { controller.setView('write', entry.chapter) }} title={t('看这一章', 'Open the chapter')}>{title(entry.chapter)}</Button> : null}
            {entry.chapter !== undefined && entry.version !== undefined ? <Button size="sm" variant="ghost" icon="undo" onClick={() => { undo(entry.chapter!, entry.version!) }}>{t('撤销', 'Undo')}</Button> : null}
          </li>
        ))}
      </ul>
      {confirm.element}
    </section>
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

/** A pass of the analysis, in the author's words. */
export function analyzeStepLabel(step: AnalyzeStep, undigested: number, t: Translate): string {
  switch (step) {
    case 'digest': return undigested > 0 ? t(`收录 ${undigested} 章`, `digesting ${undigested} chapters`) : t('逐章收录', 'digesting the chapters')
    case 'cast': return t('归并人物表', 'the cast')
    case 'world': return t('整理世界观', 'the world')
    case 'outline': return t('梗概与分卷', 'synopses and volumes')
    case 'style': return t('提炼文风', 'the style')
    case 'art': return t('定画风', 'the look of its pictures')
  }
}

/** @param quiet - something that can be done, not something that is waiting to be done: its button does not call for attention. */
function Step({ icon, title, body, action, onClick, busy, quiet }: { icon: Parameters<typeof Icon>[0]['name']; title: string; body: string; action: string; onClick: () => void; busy?: boolean; quiet?: boolean }) {
  return (
    <li className="nv-step">
      <Icon name={icon} size={18} />
      <div className="nv-step-text">
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
      <Button size="sm" variant={quiet === true ? 'outline' : 'primary'} busy={busy} onClick={onClick}>{action}</Button>
    </li>
  )
}

/**
 * Digest chapters again: every chapter with text, or a stretch of them. What
 * it replaces and what it leaves alone is said before anything starts.
 */
function RedigestDialog({ onClose }: { onClose: () => void }) {
  const { controller, locale } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const { busy, run } = useAction()
  const written = project.chapters.filter(chapter => chapter.hasText)
  const [scope, setScope] = useState<'all' | 'range'>('all')
  const [from, setFrom] = useState(String(written[0]?.index ?? 1))
  const [to, setTo] = useState(String(written.at(-1)?.index ?? 1))
  const first = Math.max(1, Math.round(Number(from)) || 1)
  const last = Math.max(first, Math.round(Number(to)) || first)
  const picked = scope === 'all' ? written : written.filter(chapter => chapter.index >= first && chapter.index <= last)
  const words = picked.reduce((sum, chapter) => sum + chapter.words, 0)
  const start = (): Promise<unknown> => run(async () => {
    await controller.api.call('ai.digest', { root, chapters: picked.map(chapter => chapter.id), force: true })
    await controller.refreshJobs()
    controller.toast('info', t(`场记开始重新收录 ${picked.length} 章；进度在底部的任务条里，随时可以停——停下时已经做完的章不会白做。`, `Continuity is digesting ${picked.length} chapters again; progress is in the bar at the bottom and can be stopped at any time — chapters already done stay done.`))
    onClose()
  })
  return (
    <Modal
      title={t('重新收录', 'Digest again')}
      onClose={onClose}
      footer={<Button variant="primary" icon="refresh" busy={busy} disabled={picked.length === 0} pending={t('正在开始…', 'Starting…')} onClick={start}>{t(`重新收录 ${picked.length} 章`, `Digest ${picked.length} chapters again`)}</Button>}
    >
      <p>{t('场记把这些章的正文重新读一遍，按现在的人物表和设定，重写每一章的收录结果。', 'Continuity reads the text of these chapters again and, with the cast and the bible as they are now, writes each chapter\'s digest anew.')}</p>
      <ul className="nv-plain-list nv-small">
        <li><strong>{t('会被重写：', 'Written anew: ')}</strong>{t('这些章的摘要、人物在这一章的状态、确立的事实、线索的动向、新出现的名字。', 'the summary of each chapter, where its people stand at its end, the facts it settles, what it does to the threads, the new names in it.')}</li>
        <li><strong>{t('不会动：', 'Left alone: ')}</strong>{t('正文；人物卡和设定里已有的内容（只更新首末出场，状态变化仍作为建议等你确认）；章纲里已经填了的项（空着的项按新的收录补上）；审校结果。', 'the text; what the character cards and the bible already say (first and last appearance are kept up, changes of status still wait for your yes); what the plans already hold (blanks are filled from the new digest); reviews.')}</li>
        <li><strong>{t('新发现：', 'What it finds: ')}</strong>{t('新的人物、设定、线索照旧进“待确认”。', 'new people, entries and threads go to the suggestions as before.')}</li>
      </ul>
      <div className="nv-radio-list">
        <label className="nv-check">
          <input type="radio" name="redigest-scope" checked={scope === 'all'} onChange={() => { setScope('all') }} />
          <span>{t(`全部有正文的章节（${written.length} 章）`, `Every chapter with text (${written.length})`)}</span>
        </label>
        <label className="nv-check">
          <input type="radio" name="redigest-scope" checked={scope === 'range'} onChange={() => { setScope('range') }} />
          <span className="nv-row-wrap">
            {t('从第', 'From chapter')}
            <TextInput className="nv-input-narrow" inputMode="numeric" value={from} onFocus={() => { setScope('range') }} onChange={(event) => { setFrom(event.target.value.replace(/[^0-9]/g, '')) }} />
            {t('章到第', 'to chapter')}
            <TextInput className="nv-input-narrow" inputMode="numeric" value={to} onFocus={() => { setScope('range') }} onChange={(event) => { setTo(event.target.value.replace(/[^0-9]/g, '')) }} />
            {t('章', '')}
          </span>
        </label>
      </div>
      <p className="nv-muted nv-small">{picked.length > 0
        ? t(`共 ${picked.length} 章、约 ${formatCount(words, locale)} 字要读。每一章是一次场记的运行，会用到文字模型的额度。`, `${picked.length} chapters, about ${formatCount(words, locale)} words to read. Each chapter is one run of continuity and spends the text model's tokens.`)
        : t('这个范围里没有带正文的章节。', 'No chapter with text lies in this stretch.')}</p>
    </Modal>
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
    // A figure the author set; the 3000 every book used to be stamped with is not one.
    chapterBudget: chapterBudgetOf(manifest) !== undefined ? String(chapterBudgetOf(manifest)) : '',
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
        // Nothing in the field takes the recommendation away: whoever writes a chapter then judges its length.
        chapterBudget: number(draft.chapterBudget) ?? 0,
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
        <Field label={t('每章建议字数', 'Recommended words per chapter')} hint={t('留空：由写手按每一章要做的事自己判断篇幅；某一章要另外的字数，在它的章纲里填', 'Empty: the writer judges each chapter\'s length from what it has to do; a chapter that wants its own figure gets it in its plan')}><TextInput inputMode="numeric" value={draft.chapterBudget} placeholder={t('由写手判断', 'left to the writer')} onChange={set('chapterBudget')} /></Field>
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

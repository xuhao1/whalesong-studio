// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * How the showrunner's `novel_*` tool calls read in the conversation: one line
 * saying what was asked of which model, the result on demand, and a way into
 * the Studio at the place the call was about.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Icon, type IconName } from './icons'
import type { ReadMode, StageTab, StudioView } from './store'

/** The slice of the Harness tool-view contract this row reads. */
interface ToolBlock {
  callId?: string
  kind?: string
  argsRaw?: string
  call?: { name: string; argsRaw: string } | null
  content?: readonly { type: string; text?: string }[]
  isError?: boolean
  error?: { name: string; code: string; reason?: string }
}

export interface ToolViewProps {
  phase: 'preparing' | 'start' | 'result'
  block: ToolBlock
  toolName: string
  useDisclosure: () => { expanded: boolean; toggle: () => void }
  inspect?: (() => void) | undefined
}

/** A place in the Studio. The chapter may be an id, a number or a title: the Studio resolves it. */
export interface StudioTarget {
  view: StudioView
  chapter?: string
  tab?: StageTab
  /** The reader: to read the chapter or to listen to it. */
  mode?: ReadMode
}

interface Described {
  icon: IconName
  title: [string, string]
  summary?: string
  target: StudioTarget
}

export const NOVEL_TOOLS = [
  'novel_status', 'novel_init', 'novel_read', 'novel_search', 'novel_mode', 'novel_export', 'novel_bible', 'novel_outline', 'novel_derive',
  'novel_write', 'novel_revise', 'novel_digest', 'novel_review', 'novel_import', 'novel_illustrate', 'novel_audio', 'novel_comic', 'novel_play',
  'novel_settings', 'novel_show', 'novel_look', 'novel_manage', 'novel_share', 'novel_edit', 'novel_memory', 'novel_crew', 'novel_video',
] as const

const VIEWS: readonly string[] = ['home', 'bible', 'outline', 'write', 'read', 'cast', 'review', 'stage', 'settings', 'setup', 'usage']
const STAGE_TABS: readonly string[] = ['production', 'comic', 'play', 'gallery']

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
const chapterId = (value: unknown): string | undefined => (typeof value === 'string' && /^ch\d+$/.test(value) ? value : undefined)
const short = (value: string | undefined, max = 60): string | undefined => (value === undefined ? undefined : value.length > max ? `${value.slice(0, max)}…` : value)

function describe(tool: string, args: Record<string, unknown>): Described {
  const where = text(args.chapter) ?? text(args.target)
  // A chapter id is certain; anything else the author or the model wrote is still worth trying.
  const chapter = chapterId(args.chapter) ?? chapterId(args.target) ?? text(args.chapter)
  const withChapter = (view: StudioView): StudioTarget => ({ view, ...(chapter !== undefined ? { chapter } : {}) })
  const join = (...parts: (string | undefined)[]): string => parts.filter((part): part is string => part !== undefined).join(' · ')
  switch (tool) {
    case 'novel_status': return { icon: 'book', title: ['查看作品状态', 'Project status'], target: { view: 'home' } }
    case 'novel_init': return { icon: 'book', title: ['创建小说项目', 'Create project'], summary: join(text(args.title)), target: { view: 'home' } }
    case 'novel_read': {
      const what = text(args.what) ?? ''
      const view: StudioView = what === 'chapter' ? 'read' : what === 'outline' || what === 'threads' ? 'outline' : what === 'character' ? 'cast' : what === 'world' || what === 'style' ? 'bible' : 'write'
      return { icon: 'eye', title: ['查阅', 'Read'], summary: join(what, text(args.ref) ?? where), target: withChapter(view) }
    }
    case 'novel_search': return { icon: 'search', title: ['检索', 'Search'], summary: join(short(text(args.query))), target: { view: 'home' } }
    case 'novel_mode': return { icon: 'zap', title: ['切换工作模式', 'Switch mode'], summary: join(text(args.mode)), target: { view: 'home' } }
    case 'novel_export': return { icon: 'download', title: ['导出', 'Export'], summary: join(text(args.format)), target: { view: 'home' } }
    case 'novel_bible': return { icon: 'users', title: ['设定', 'Bible'], summary: join(text(args.action), text(args.kind), text(args.ref) ?? text((args.fields as { name?: unknown } | undefined)?.name)), target: { view: text(args.kind) === 'character' ? 'cast' : 'bible' } }
    case 'novel_outline': return { icon: 'tree', title: ['调整大纲', 'Outline'], summary: Array.isArray(args.ops) ? args.ops.map(op => text((op as { op?: unknown }).op)).filter(Boolean).slice(0, 4).join(', ') : '', target: { view: 'outline' } }
    case 'novel_derive': return { icon: 'sparkles', title: ['策划 · 推演', 'Planner · derive'], summary: join(text(args.kind), where, short(text(args.direction))), target: withChapter('outline') }
    case 'novel_write': return { icon: 'feather', title: ['写手 · 写作', 'Writer · draft'], summary: join(where ?? 'next', text(args.mode), short(text(args.brief))), target: withChapter('write') }
    case 'novel_revise': return { icon: 'pen', title: ['写手 · 修订', 'Writer · revise'], summary: join(text(args.scope), where, short(text(args.instruction))), target: text(args.scope) === 'book' ? { view: 'review' } : withChapter('write') }
    case 'novel_edit': return { icon: 'pen', title: ['总编 · 亲手改稿', 'Showrunner · exact edit'], summary: join(text(args.action), where, short(text(args.reason) ?? text(args.find), 40)), target: withChapter('write') }
    case 'novel_memory': return { icon: 'layers', title: ['总编 · 修正记忆', 'Showrunner · correct memory'], summary: join(where, Object.keys((args.fields as Record<string, unknown> | undefined) ?? {}).slice(0, 4).join(', ')), target: withChapter('write') }
    case 'novel_digest': return { icon: 'layers', title: ['场记 · 收录记忆', 'Continuity · digest'], summary: join(Array.isArray(args.chapters) ? args.chapters.join(', ') : where), target: { view: 'home' } }
    case 'novel_review': return { icon: 'checkCircle', title: ['场记 · 审校', 'Continuity · review'], summary: join(where, short(text(args.focus))), target: withChapter('write') }
    case 'novel_import': return { icon: 'upload', title: ['场记 · 导入稿件', 'Continuity · import'], summary: join(text(args.path)), target: { view: 'home' } }
    case 'novel_illustrate': return { icon: 'image', title: ['配图', 'Illustrate'], summary: join(text(args.kind), where), target: { view: 'stage', tab: 'gallery' } }
    case 'novel_audio': {
      const action = text(args.action)
      // Voices are set on the character's card; everything else about the audio drama lives in the reader, listening.
      const target: StudioTarget = action === 'design_voice' || action === 'set_voice' || action === 'voices' ? { view: 'cast' } : { ...withChapter('read'), mode: 'listen' }
      return { icon: 'headphones', title: ['有声剧', 'Audio drama'], summary: join(action, where ?? text(args.character)), target }
    }
    case 'novel_share': return { icon: 'phone', title: ['手机阅读', 'Read on another device'], summary: join(text(args.action)), target: { view: 'read' } }
    case 'novel_comic': return { icon: 'film', title: ['导演 · 有声漫', 'Director · motion comic'], summary: join(text(args.action), where), target: { ...withChapter('stage'), tab: 'comic' } }
    case 'novel_video': return { icon: 'film', title: ['后期 · 成片', 'Post-production · video'], summary: join(text(args.action), where, short(text(args.direction))), target: { ...withChapter('stage'), tab: 'comic' } }
    case 'novel_batch': {
      const what = text(args.what)
      const steps = Array.isArray(args.steps) ? args.steps.join('、') : text(args.steps)
      const title: [string, string] = what === 'stage' ? ['批量 · 制作', 'Batch · stage'] : what === 'text' ? ['批量 · 写作与整理', 'Batch · text'] : ['批量 · 绘制', 'Batch · pictures']
      // Where the batch can be followed step by step.
      const target: StudioTarget = what === 'stage' ? { view: 'stage', tab: 'production' } : what === 'text' ? { view: 'write' } : { view: 'stage', tab: 'gallery' }
      return { icon: 'layers', title, summary: join(text(args.action) === 'status' ? 'status' : undefined, steps, Array.isArray(args.chapters) ? args.chapters.join(', ') : text(args.chapters), typeof args.count === 'number' ? String(args.count) : undefined), target }
    }
    case 'novel_crew': {
      const role = text(args.role)
      const names: Record<string, [string, string]> = { analyst: ['场记', 'Continuity'], architect: ['策划', 'Planner'], director: ['导演', 'Director'], producer: ['后期', 'Post-production'], writer: ['写手', 'Writer'] }
      const name = role !== undefined ? names[role] : undefined
      return { icon: 'users', title: name !== undefined ? [`班底 · 交给${name[0]}`, `Crew · ${name[1]}`] : ['班底', 'Crew'], summary: join(text(args.action) === 'list' ? 'list' : undefined, short(text(args.task), 80)), target: { view: 'home' } }
    }
    case 'novel_play': return { icon: 'gamepad', title: ['导演 · 幕间', 'Director · interlude'], summary: join(text(args.action), short(text(args.situation) ?? text(args.text))), target: { view: 'stage', tab: 'play' } }
    case 'novel_settings': {
      const action = text(args.action)
      return { icon: action === 'usage' ? 'clock' : 'settings', title: action === 'book' ? ['作品信息', 'Book info'] : action === 'usage' ? ['用量与成本', 'Usage and cost'] : ['工坊设置', 'Studio settings'], summary: join(action === 'usage' ? text(args.range) : action, text(args.service), Array.isArray(args.parts) ? args.parts.join(', ') : undefined), target: { view: action === 'book' ? 'home' : action === 'usage' ? 'usage' : 'settings' } }
    }
    case 'novel_look': {
      // The pictures the showrunner looked at are the gallery's: that is where the author finds them.
      const named = Array.isArray(args.pictures) ? args.pictures.filter((item): item is string => typeof item === 'string').map(item => item.split('/').at(-1) ?? item).join(', ') : text(args.pictures)
      return { icon: 'image', title: ['看了这本书的图', 'Looked at pictures of the book'], summary: join(text(args.of), short(named)), target: { view: 'stage', tab: 'gallery' } }
    }
    case 'novel_show': {
      const view = text(args.view)
      const tab = text(args.tab)
      // The audio drama is the reader's listening mode, whichever way it was asked for.
      const listening = view === 'listen' || (view === 'stage' && tab === 'audio')
      return {
        icon: listening ? 'headphones' : 'eye',
        title: ['在工坊里打开', 'Show in the Studio'],
        summary: join(view, listening ? undefined : tab, where),
        target: listening
          ? { view: 'read', mode: 'listen', ...(chapter !== undefined ? { chapter } : {}) }
          : { view: view !== undefined && VIEWS.includes(view) ? view as StudioView : 'home', ...(chapter !== undefined ? { chapter } : {}), ...(tab !== undefined && STAGE_TABS.includes(tab) ? { tab: tab as StageTab } : {}), ...(view === 'read' ? { mode: 'read' as const } : {}) },
      }
    }
    case 'novel_manage': {
      const action = text(args.action) ?? ''
      const target: StudioTarget = action === 'edit_line' ? { ...withChapter('read'), mode: 'listen' }
        : action === 'audition' ? { view: 'cast' }
        : action === 'edit_panel' ? { ...withChapter('stage'), tab: 'comic' }
          : action.endsWith('_image') || action === 'list_images' ? { view: 'stage', tab: 'gallery' }
            : action.endsWith('_interlude') ? { view: 'stage', tab: 'play' }
              : action === 'resolve_issue' ? { view: 'review' }
                : action === 'restore_version' ? withChapter('write') : { view: 'home' }
      return { icon: 'pen', title: ['手动调整', 'Hand edit'], summary: join(action, where ?? text(args.session) ?? text(args.id) ?? short(text(args.query))), target }
    }
    default: return { icon: 'book', title: [tool, tool], target: { view: 'home' } }
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function resultText(block: ToolBlock): string {
  const parts = (block.content ?? []).map(item => (item.type === 'text' && item.text !== undefined ? item.text : JSON.stringify(item)))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.reason ?? block.error.code}`)
  return parts.join('\n')
}

export function createToolRow(deps: { open: (target?: StudioTarget) => void; subscribeLocale: (listener: () => void) => () => void; getLocale: () => string }) {
  // The Studio opens by itself the first time the showrunner goes to work; after that the author decides.
  let revealed = false
  return function NovelToolRow(props: ToolViewProps) {
    const locale = useSyncExternalStore(deps.subscribeLocale, deps.getLocale)
    const zh = locale.toLowerCase().startsWith('zh')
    const t = (zhText: string, enText: string): string => (zh ? zhText : enText)
    const disclosure = props.useDisclosure()
    const settled = props.phase === 'result'
    const args = parseArgs(settled ? props.block.call?.argsRaw : props.block.argsRaw)
    const info = describe(props.toolName, args)
    // A call that names a book is about that one, not the book in play: say so on the row.
    const book = text(args.book) ?? (props.toolName === 'novel_status' ? text(args.project) : undefined)
    const interrupted = settled && props.block.error?.code === 'interrupted'
    const failed = settled && props.block.isError === true && !interrupted
    const output = settled ? resultText(props.block) : ''
    const state = !settled ? 'running' : interrupted ? 'stopped' : failed ? 'error' : 'ok'
    // Only calls watched live act on the window; rows of an old conversation being read back never do.
    const live = useRef(false)
    const target = useRef(info.target)
    target.current = info.target
    useEffect(() => {
      if (state === 'running') {
        live.current = true
        if (!revealed && props.toolName !== 'novel_show') {
          revealed = true
          deps.open()
        }
        return
      }
      if (!live.current) return
      live.current = false
      // The showrunner showing something is an instruction to the window, carried out when the call lands.
      if (state === 'ok' && props.toolName === 'novel_show') {
        revealed = true
        deps.open(target.current)
      }
    }, [state, props.toolName])
    return (
      <div className="nv-tool" data-state={state} data-novel-studio="">
        <div className="nv-tool-row" role={output.length > 0 ? 'button' : undefined} tabIndex={output.length > 0 ? 0 : undefined} aria-expanded={output.length > 0 ? disclosure.expanded : undefined} onClick={output.length > 0 ? disclosure.toggle : undefined} onKeyDown={(event) => { if (output.length > 0 && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); disclosure.toggle() } }}>
          <span className="nv-tool-icon"><Icon name={disclosure.expanded ? 'chevronDown' : info.icon} size={14} /></span>
          <span className="nv-tool-title">{t(...info.title)}</span>
          {book !== undefined ? <span className="nv-tool-book" title={props.toolName === 'novel_status' || props.toolName === 'novel_show' ? t('把对话切到这本书', 'Moves the conversation onto this book') : t('只这一次作用于另一本书', 'Acts on another book for this call only')}>{short(book.replace(/^《|》$/g, ''), 24)}</span> : null}
          {info.summary !== undefined && info.summary.length > 0 ? <><span className="nv-tool-sep" aria-hidden="true" /><span className="nv-tool-summary">{failed ? output.split('\n')[0] : info.summary}</span></> : failed ? <><span className="nv-tool-sep" aria-hidden="true" /><span className="nv-tool-summary">{output.split('\n')[0]}</span></> : <span className="nv-tool-summary" />}
          {state === 'stopped' ? <span className="nv-tool-note">{t('已停止', 'stopped')}</span> : null}
          <button type="button" className="nv-tool-open" title={t('在小说工坊中打开', 'Open in Novel Studio')} onClick={(event) => { event.stopPropagation(); deps.open(info.target) }}>
            <Icon name="arrowRight" size={13} />
          </button>
        </div>
        {disclosure.expanded && output.length > 0 ? <pre className="nv-tool-output">{output}</pre> : null}
      </div>
    )
  }
}

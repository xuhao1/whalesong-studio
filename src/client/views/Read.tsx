// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The reader: a chapter as a reader meets it, in two modes on one page — to be
 * read, and to be listened to as an audio drama with the line being spoken
 * lit in the prose. The author additionally gets the production desk of the
 * audio version above the page, and the tools for a selected passage.
 *
 * The same page (without the author's tools) is what other devices are served.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyFind } from '../../shared/text'
import { blocksOf } from '../../shared/reader'
import { ListenBar, ModeSwitch, PrefsControls, ReaderPage, usePlayerOptions, useReaderPrefs } from '../reader/parts'
import { AudioDesk, ScriptTable, type ScriptView } from '../stage/Audio'
import { useLinePlayer } from '../stage/player'
import {
  Button, cx, Empty, Select, Spinner, useLoad, useMediaUrl, useProject, useQuote, useSnapshot, useStudio, useT,
} from '../ui'
import { ShareDialog } from './Share'

export function ReadView() {
  const { controller } = useStudio()
  const t = useT()
  const quote = useQuote()
  const { project, root } = useProject()
  const chapterId = useSnapshot(snapshot => snapshot.chapterId)
  const mode = useSnapshot(snapshot => snapshot.readMode)
  const jump = useSnapshot(snapshot => snapshot.jump)
  const jobs = useSnapshot(snapshot => snapshot.jobs)
  const mediaUrl = useMediaUrl()
  const [prefs, updatePrefs] = useReaderPrefs()
  const [options, updateOptions] = usePlayerOptions()
  const [picked, setPicked] = useState<{ text: string; offset: number; top: number; left: number } | undefined>()
  const [flash, setFlash] = useState<number | undefined>()
  const [body, setBody] = useState<'text' | 'script'>('text')
  const [sharing, setSharing] = useState(false)
  const [autoNext, setAutoNext] = useState(() => {
    try {
      return localStorage.getItem('novel-studio:autonext') !== '0'
    } catch {
      return true
    }
  })
  const scroller = useRef<HTMLDivElement>(null)
  // The next chapter starts playing by itself when the one before it ran out.
  const carryOn = useRef(false)
  const written = project.chapters.filter(chapter => chapter.hasText)
  const chapter = written.find(candidate => candidate.id === chapterId) ?? written[0]
  const position = chapter !== undefined ? written.findIndex(candidate => candidate.id === chapter.id) : -1
  const listening = mode === 'listen'
  const job = jobs.find(item => item.status === 'running' && item.kind === 'audio' && item.title !== 'audition' && (item.target === chapter?.id || item.result?.chapterId === chapter?.id))
  const doc = useLoad(async signal => chapter !== undefined ? await controller.api.call('chapter.read', { root, id: chapter.id }, signal) : undefined, [root, chapter?.id, chapter?.updatedAt])
  // The script is fetched once the author listens; a running job keeps it fresh as lines come in.
  const audio = useLoad<ScriptView | undefined>(async signal => chapter !== undefined && listening ? await controller.api.call('audio.script', { root, chapter: chapter.id }, signal) : undefined, [root, chapter?.id, listening, project.revision, job === undefined])
  const text = doc.data?.text
  const script = audio.data?.script
  const lines = useMemo(() => script?.lines ?? [], [script])
  const cues = useMemo(() => script?.cues ?? [], [script])
  const { player, state } = useLinePlayer(lines, cues, mediaUrl, options, () => {
    const next = written[position + 1]
    if (!autoNext || next === undefined) return
    carryOn.current = true
    controller.focusChapter(next.id)
  })

  // A new chapter starts at the top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    setPicked(undefined)
  }, [chapter?.id])

  // Leaving the listening mode stops the voice; a script that arrives after a chapter ran out starts the next one.
  useEffect(() => {
    if (!listening) {
      carryOn.current = false
      player.stop()
    }
  }, [listening, player])
  useEffect(() => {
    if (!carryOn.current || !listening || script === undefined || script.chapterId !== chapter?.id) return
    carryOn.current = false
    if (script.lines.some(line => line.audio !== undefined)) player.play(0)
  }, [script, listening, chapter?.id, player])

  // Arrow keys turn chapters when nothing is being typed; the space bar plays and pauses while listening.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.tagName === 'BUTTON' || target.isContentEditable)) return
      if (scroller.current === null || scroller.current.offsetParent === null) return
      if (event.key === 'ArrowLeft' && position > 0) controller.focusChapter(written[position - 1]!.id)
      if (event.key === 'ArrowRight' && position >= 0 && position < written.length - 1) controller.focusChapter(written[position + 1]!.id)
      if (event.key === ' ' && listening && lines.length > 0) {
        event.preventDefault()
        player.toggle()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  })

  // Show the place a search hit points at.
  useEffect(() => {
    if (jump === undefined || chapter === undefined || jump.chapterId !== chapter.id || text === undefined) return
    const blocks = blocksOf(text)
    if (blocks.length === 0) return
    const target = [...blocks].reverse().find(block => block.offset <= jump.offset) ?? blocks[0]!
    const element = scroller.current?.querySelector<HTMLElement>(`[data-offset="${target.offset}"]`)
    if (element !== null && element !== undefined) {
      element.scrollIntoView({ block: 'center' })
      setFlash(target.offset)
      const timer = setTimeout(() => { setFlash(undefined) }, 2400)
      controller.consumeJump(jump.nonce)
      return () => { clearTimeout(timer) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce, text])

  // In the script view the line being spoken stays in sight.
  useEffect(() => {
    if (body !== 'script' || state.index < 0) return
    scroller.current?.querySelector(`[data-script-line="${lines[state.index]?.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [state.index, body, lines])

  if (chapter === undefined) {
    return (
      <div className="nv-page">
        <Empty icon="eye" title={t('还没有可读的正文', 'Nothing to read yet')}>
          <Button variant="primary" icon="pen" onClick={() => { controller.setView('write') }}>{t('去写作', 'Open Write')}</Button>
        </Empty>
      </div>
    )
  }

  const onSelect = (): void => {
    const selection = window.getSelection()
    const container = scroller.current
    if (selection === null || selection.isCollapsed || container === null || selection.rangeCount === 0 || text === undefined) {
      setPicked(undefined)
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return
    const chosen = selection.toString().trim()
    if (chosen.length === 0) return
    const start = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest<HTMLElement>('[data-offset]')
    const base = start !== null && start !== undefined ? Number(start.dataset.offset) : 0
    const exact = text.indexOf(chosen, base)
    const found = exact >= 0 ? { start: exact, end: exact + chosen.length } : fuzzyFind(text, chosen)
    const rect = range.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    setPicked({ text: chosen, offset: found?.start ?? base, top: rect.top - box.top + container.scrollTop - 44, left: Math.max(8, Math.min(box.width - 260, rect.left - box.left)) })
  }

  const turn = (delta: number): void => {
    const next = written[position + delta]
    if (next !== undefined) controller.focusChapter(next.id)
  }
  const keepAutoNext = (value: boolean): void => {
    setAutoNext(value)
    try {
      localStorage.setItem('novel-studio:autonext', value ? '1' : '0')
    } catch {
      // Kept for this visit only.
    }
  }
  const showScript = listening && body === 'script' && script !== undefined

  return (
    <div className={cx('nv-reader', `is-${prefs.theme}`, listening && 'is-listen')}>
      <header className="nv-reader-bar">
        <Button size="sm" variant="ghost" icon="chevronLeft" disabled={position <= 0} onClick={() => { turn(-1) }} title={t('上一章', 'Previous chapter')} />
        <Select className="nv-chapter-select" value={chapter.id} options={written.map(item => ({ value: item.id, label: `${item.index}. ${item.title}` }))} onChange={(value) => { controller.focusChapter(value) }} />
        <Button size="sm" variant="ghost" icon="chevronRight" disabled={position >= written.length - 1} onClick={() => { turn(1) }} title={t('下一章', 'Next chapter')} />
        <ModeSwitch mode={mode} onChange={(next) => { controller.setReadMode(next) }} t={t} />
        <span className="nv-spacer" />
        <PrefsControls prefs={prefs} update={updatePrefs} t={t} />
        <Button size="sm" variant="ghost" icon="phone" onClick={() => { setSharing(true) }} title={t('在手机上读这本书', 'Read this book on another device')} />
        <Button size="sm" variant="ghost" icon="film" onClick={() => { controller.navigate({ view: 'stage', tab: 'comic', chapter: chapter.id }) }} title={t('有声漫', 'Motion comic')} />
        <Button size="sm" icon="pen" onClick={() => { controller.setView('write', chapter.id) }}>{t('编辑', 'Edit')}</Button>
      </header>
      {listening ? (
        audio.data === undefined
          ? <div className="nv-desk-loading">{audio.error !== undefined ? <span className="nv-muted">{audio.error}</span> : <><Spinner size={13} /><span className="nv-muted nv-small">{t('正在读取有声脚本…', 'Loading the audio script…')}</span></>}</div>
          : <AudioDesk chapter={chapter} view={audio.data} job={job} player={player} body={script === undefined ? 'text' : body} onBody={setBody} />
      ) : null}
      {showScript ? (
        <div className="nv-reader-scroll" ref={scroller}>
          <div className="nv-script-wrap">
            <ScriptTable chapter={chapter} lines={lines} cues={cues} state={state} player={player} job={job} onChanged={() => { audio.reload() }} />
          </div>
        </div>
      ) : (
        <ReaderPage
          t={t}
          bookTitle={project.manifest.title}
          chapter={chapter}
          text={text}
          prefs={prefs}
          media={path => mediaUrl(path)}
          lines={listening && script !== undefined ? lines : undefined}
          active={listening ? state.index : undefined}
          onLine={listening && script !== undefined ? (index) => { player.play(index) } : undefined}
          flash={flash}
          scroller={scroller}
          onSelect={onSelect}
          footer={position < written.length - 1
            ? <Button icon="arrowRight" onClick={() => { turn(1) }}>{t('下一章：', 'Next: ')}{written[position + 1]!.title}</Button>
            : <span className="nv-muted">{t('—— 已读到最新一章 ——', '— you have reached the latest chapter —')}</span>}
        >
          {picked !== undefined ? (
            <div className="nv-reader-pick" style={{ top: Math.max(4, picked.top), left: picked.left }} onMouseUp={(event) => { event.stopPropagation() }}>
              <Button size="sm" icon="pen" onClick={() => { controller.jumpTo(chapter.id, picked.offset, picked.text.length, 'write') }}>{t('去修改', 'Edit here')}</Button>
              {quote !== undefined ? (
                <Button size="sm" icon="quote" onClick={() => {
                  quote(t(`关于第 ${chapter.index} 章《${chapter.title}》里的这段：\n「${picked.text}」\n`, `About this passage in chapter ${chapter.index}, "${chapter.title}":\n"${picked.text}"\n`))
                  setPicked(undefined)
                }}>{t('和总编讨论', 'Discuss')}</Button>
              ) : null}
              <Button size="sm" icon="image" pending={t('正在为这段配图…', 'Illustrating…')} onClick={() => {
                if (!controller.need('image')) return undefined
                const chosen = picked.text
                return controller.guard(async () => {
                  await controller.run('image.create', { root, kind: 'scene', target: chapter.id, quote: chosen, insert: true })
                  setPicked(undefined)
                  doc.reload()
                  controller.toast('success', t('插图已放进正文', 'The illustration is in the chapter'))
                })
              }}>{t('配图', 'Illustrate')}</Button>
            </div>
          ) : null}
        </ReaderPage>
      )}
      {listening && script !== undefined ? <ListenBar t={t} player={player} state={state} lines={lines} options={options} update={updateOptions} autoNext={autoNext} onAutoNext={keepAutoNext} /> : null}
      {sharing ? <ShareDialog onClose={() => { setSharing(false) }} /> : null}
    </div>
  )
}

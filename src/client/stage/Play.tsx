// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Interludes: step into a scene of the book and play it as a visual novel —
 * the director model runs the other characters in real time, with backgrounds,
 * portraits, voices and ambience. An interlude never touches the canon unless
 * you turn it into a chapter.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AmbiencePreset, PlayLine, PlaySession, PlayTurn } from '../../shared/types'
import { AMBIENCE } from '../labels'
import {
  Button, Chip, cx, Empty, Field, Menu, Modal, ProjectImage, SectionTitle, Select, Spinner, TextArea, TextInput, useAction, useConfirm, useLoad,
  useMediaUrl, useProject, useStudio, useT,
} from '../ui'
import { Ambience } from './ambience'

type Summary = Pick<PlaySession, 'id' | 'title' | 'updatedAt' | 'outcome' | 'player' | 'cast' | 'anchorChapter'>

const OUTCOME: Record<NonNullable<PlaySession['outcome']>, [string, string]> = {
  'open': ['进行中', 'Open'],
  'discarded': ['已作废', 'Discarded'],
  'side-story': ['番外', 'Side story'],
  'novelized': ['已写成正文', 'Novelized'],
}

export function PlayStage() {
  const [open, setOpen] = useState<{ id: string; fresh: boolean } | undefined>()
  if (open !== undefined) return <PlayRoom key={open.id} id={open.id} fresh={open.fresh} onExit={() => { setOpen(undefined) }} />
  return <Lobby onOpen={(id, fresh = false) => { setOpen({ id, fresh }) }} />
}

// ───────────────────────────── lobby ─────────────────────────────

function Lobby({ onOpen }: { onOpen: (id: string, fresh?: boolean) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const sessions = useLoad(signal => controller.api.call('play.list', { root }, signal), [root])
  const written = project.chapters.filter(chapter => chapter.hasText)
  const [anchor, setAnchor] = useState(written.at(-1)?.id ?? '')
  const [player, setPlayer] = useState('')
  const [cast, setCast] = useState<string[]>([])
  const [location, setLocation] = useState('')
  const [situation, setSituation] = useState('')
  const [tone, setTone] = useState('')
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const nameOf = (id: string): string => project.characters.find(card => card.id === id)?.name ?? id
  // Who can be in it depends on where it sits: somebody who dies in chapter 12 is alive in an interlude set after chapter 5.
  const anchorIndex = anchor.length > 0 ? project.chapters.find(chapter => chapter.id === anchor)?.index ?? 0 : 0
  const died = new Map(project.presence.flatMap(entry => (entry.death !== undefined ? [[entry.character, entry.death] as const] : [])))
  const alive = project.characters.filter(card => (died.get(card.id) ?? Infinity) > anchorIndex)
  const start = (): Promise<unknown> => run(async () => {
    const session = await controller.api.call('play.start', {
      root,
      cast: [...new Set([...cast, ...(player.length > 0 ? [player] : [])])],
      situation: situation.trim(),
      ...(anchor.length > 0 ? { anchor } : {}),
      ...(player.length > 0 ? { player } : {}),
      ...(location.trim().length > 0 ? { location: location.trim() } : {}),
      ...(tone.trim().length > 0 ? { tone: tone.trim() } : {}),
    })
    onOpen(session.id, true)
  })
  const list: Summary[] = sessions.data?.sessions ?? []
  return (
    <div className="nv-play-lobby">
      <section className="nv-card">
        <SectionTitle>{t('开一段幕间', 'Start an interlude')}</SectionTitle>
        <p className="nv-muted nv-small">{t('幕间是从正文某一处岔出去的一场即兴戏：你可以扮演其中一个人物，也可以只当导演。其他人物由导演模型按人设、记忆和当时的处境来演。它不会改动正文——演完后可以作废、留作番外，或者让写手把它写成一章。', 'An interlude is an improvised scene branching off the book: play one of the characters, or just direct. The director model plays everyone else from their cards, their memory and the situation. It never changes the manuscript — afterwards discard it, keep it as a side story, or have the writer turn it into a chapter.')}</p>
        {project.characters.length === 0 ? <p className="nv-note is-warn">{t('幕间需要人物卡。先在"设定"里建立人物。', 'Interludes need character cards. Create characters in the Bible first.')}</p> : (
          <>
            <div className="nv-form-grid">
              <Field label={t('从哪里岔出去', 'Branch from')} hint={t('这一章及之前发生的事，人物都记得', 'The characters remember everything up to this chapter')}>
                <Select value={anchor} options={[{ value: '', label: t('故事开始之前', 'Before the story begins') }, ...written.map(chapter => ({ value: chapter.id, label: t(`第 ${chapter.index} 章 ${chapter.title} 之后`, `After ch. ${chapter.index} ${chapter.title}`) }))]} onChange={setAnchor} />
              </Field>
              <Field label={t('你扮演', 'You play')}>
                <Select value={player} options={[{ value: '', label: t('不下场，只当导演', 'Nobody — I direct') }, ...alive.map(card => ({ value: card.id, label: card.name }))]} onChange={setPlayer} />
              </Field>
              <Field label={t('地点', 'Location')}>
                <TextInput list="nv-play-locations" value={location} onChange={(event) => { setLocation(event.target.value) }} />
                <datalist id="nv-play-locations">{project.world.filter(entry => entry.category === 'location').map(entry => <option key={entry.id} value={entry.name} />)}</datalist>
              </Field>
              <Field label={t('基调', 'Tone')}><TextInput value={tone} placeholder={t('如：暧昧、对峙、轻松日常', 'e.g. charged, a standoff, light and everyday')} onChange={(event) => { setTone(event.target.value) }} /></Field>
            </div>
            <Field label={t('在场人物', 'Who is there')}>
              <div className="nv-chips">
                {alive.filter(card => card.id !== player).map(card => <Chip key={card.id} tone={cast.includes(card.id) ? 'blue' : 'neutral'} active={cast.includes(card.id)} onClick={() => { setCast(previous => previous.includes(card.id) ? previous.filter(id => id !== card.id) : [...previous, card.id]) }}>{card.name}</Chip>)}
              </div>
            </Field>
            <Field label={t('开场情境', 'The situation')}>
              <TextArea value={situation} minRows={3} placeholder={t('例：深夜，她独自回到书铺，发现他正坐在柜台后面翻她的账本。', 'e.g. Late at night she returns to the shop alone and finds him behind the counter, going through her ledger.')} onChange={(event) => { setSituation(event.target.value) }} />
            </Field>
            <div className="nv-form-actions">
              <Button variant="primary" icon="gamepad" busy={busy} disabled={situation.trim().length === 0 || (cast.length === 0 && player.length === 0)} onClick={start}>{busy ? t('导演正在布景…', 'The director is setting the scene…') : t('开演', 'Begin')}</Button>
            </div>
          </>
        )}
      </section>

      <section className="nv-card">
        <SectionTitle>{t('已有的幕间', 'Your interludes')}</SectionTitle>
        {sessions.data === undefined ? <div className="nv-center"><Spinner /></div> : list.length === 0 ? <p className="nv-muted">{t('还没有幕间。', 'No interludes yet.')}</p> : (
          <ul className="nv-list">
            {list.map(session => (
              <li key={session.id}>
                <div className="nv-list-row is-static">
                  <button type="button" className="nv-person-text nv-play-open" onClick={() => { onOpen(session.id) }}>
                    <span className="nv-list-title">{session.title}</span>
                    <span className="nv-list-meta">{session.cast.map(nameOf).join('、')}{session.player !== undefined ? t(` · 你演${nameOf(session.player)}`, ` · you play ${nameOf(session.player)}`) : ''} · {new Date(session.updatedAt).toLocaleString()}</span>
                  </button>
                  <span className="nv-list-side">
                    <Chip tone={session.outcome === 'novelized' ? 'green' : session.outcome === 'side-story' ? 'violet' : session.outcome === 'discarded' ? 'neutral' : 'blue'}>{t(...OUTCOME[session.outcome ?? 'open'])}</Chip>
                    <Button size="sm" icon="play" onClick={() => { onOpen(session.id) }}>{t('进入', 'Open')}</Button>
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => { confirm.ask(t(`删除幕间「${session.title}」？`, `Delete the interlude "${session.title}"?`), () => { void run(async () => { await controller.api.call('play.delete', { root, id: session.id }); sessions.reload() }) }) }} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {confirm.element}
    </div>
  )
}

// ───────────────────────────── the room ─────────────────────────────

type Step = { kind: 'narration'; text: string } | { kind: 'line'; index: number; line: PlayLine }

function stepsOf(turn: PlayTurn | undefined): Step[] {
  if (turn === undefined) return []
  const steps: Step[] = []
  if (turn.narration !== undefined && turn.narration.trim().length > 0) steps.push({ kind: 'narration', text: turn.narration })
  turn.lines.forEach((line, index) => { steps.push({ kind: 'line', index, line }) })
  return steps
}

interface RoomPrefs {
  voice: boolean
  ambience: boolean
  paint: boolean
}

function loadRoomPrefs(): RoomPrefs {
  try {
    const raw = localStorage.getItem('novel-studio:play')
    if (raw !== null) return { voice: false, ambience: true, paint: false, ...(JSON.parse(raw) as Partial<RoomPrefs>) }
  } catch {
    // defaults
  }
  return { voice: false, ambience: true, paint: false }
}

function PlayRoom({ id, fresh, onExit }: { id: string; fresh: boolean; onExit: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const mediaUrl = useMediaUrl()
  const [session, setSession] = useState<PlaySession | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [turnAt, setTurnAt] = useState(0)
  const [stepAt, setStepAt] = useState(0)
  const [typed, setTyped] = useState(0)
  const [thinking, setThinking] = useState(false)
  const [mode, setMode] = useState<'say' | 'do' | 'direct'>('say')
  const [input, setInput] = useState('')
  const [log, setLog] = useState(false)
  const [prefs, setPrefsState] = useState<RoomPrefs>(loadRoomPrefs)
  const [painting, setPainting] = useState(false)
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const ambience = useMemo(() => new Ambience(), [])
  const voice = useRef<HTMLAudioElement | null>(null)
  const requested = useRef(new Set<string>())
  const room = useRef<HTMLDivElement>(null)

  const setPrefs = (patch: Partial<RoomPrefs>): void => {
    setPrefsState((previous) => {
      const next = { ...previous, ...patch }
      try {
        localStorage.setItem('novel-studio:play', JSON.stringify(next))
      } catch {
        // this visit only
      }
      return next
    })
  }

  useEffect(() => {
    let cancelled = false
    controller.api.call('play.get', { root, id }).then((loaded) => {
      if (cancelled) return
      setSession(loaded)
      // A scene that was just set up plays from its first line; returning to one lands on its last, ready for the next move.
      const last = Math.max(0, loaded.turns.length - 1)
      setTurnAt(last)
      setStepAt(fresh ? 0 : Math.max(0, stepsOf(loaded.turns[last]).length - 1))
      setTyped(fresh ? 0 : Number.MAX_SAFE_INTEGER)
      setMode(loaded.player !== undefined ? 'say' : 'direct')
    }, (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, root, id])
  useEffect(() => () => {
    ambience.dispose()
    voice.current?.pause()
  }, [ambience])

  const turn = session?.turns[turnAt]
  const steps = useMemo(() => stepsOf(turn), [turn])
  const step = steps[stepAt]
  const text = step === undefined ? '' : step.kind === 'narration' ? step.text : step.line.text
  const atEnd = session !== undefined && turnAt === session.turns.length - 1 && stepAt >= steps.length - 1 && typed >= text.length
  const scene = useMemo(() => {
    const merged: NonNullable<PlayTurn['scene']> = {}
    for (const item of session?.turns.slice(0, turnAt + 1) ?? []) {
      if (item.scene === undefined) continue
      // A new location starts a new picture; mood and time carry over until restated.
      if (item.scene.location !== undefined && item.scene.location !== merged.location) delete merged.background
      Object.assign(merged, item.scene)
    }
    return merged
  }, [session, turnAt])
  const speaker = step?.kind === 'line' ? project.characters.find(card => card.id === step.line.character) : undefined
  const ended = turn?.ended === true || (session?.outcome !== undefined && session.outcome !== 'open')

  // Typewriter.
  useEffect(() => {
    if (typed >= text.length) return
    const timer = setInterval(() => { setTyped(value => value + 2) }, 34)
    return () => { clearInterval(timer) }
  }, [typed, text.length])

  // Ambience follows the scene.
  useEffect(() => {
    const preset: AmbiencePreset = prefs.ambience ? (scene.ambience ?? 'none') : 'none'
    // Web Audio only starts after a gesture; the first click on the stage unlocks it.
    if (session !== undefined) ambience.set(preset, 0.55)
  }, [ambience, prefs.ambience, scene.ambience, session])

  // Speak the line on screen.
  useEffect(() => {
    voice.current?.pause()
    if (!prefs.voice || session === undefined || turn === undefined || step === undefined) return
    let cancelled = false
    const play = (path: string): void => {
      if (cancelled) return
      const audio = voice.current ?? new Audio()
      voice.current = audio
      audio.src = mediaUrl(path)
      void audio.play().catch(() => {})
    }
    if (step.kind === 'line' && step.line.audio !== undefined) play(step.line.audio)
    else {
      controller.api.call('play.voice', { root, id: session.id, turn: turn.id, line: step.kind === 'line' ? step.index : -1 }).then(result => { play(result.path) }, (reason: unknown) => {
        if (cancelled) return
        setPrefs({ voice: false })
        controller.toast('error', reason instanceof Error ? reason.message : String(reason))
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.voice, session?.id, turn?.id, stepAt])

  // Paint the scene and the speaker when asked to.
  const paintScene = useCallback((force: boolean): void => {
    if (session === undefined || turn === undefined) return
    const key = `scene:${scene.location ?? ''}`
    if (!force && (requested.current.has(key) || scene.background !== undefined)) return
    requested.current.add(key)
    setPainting(true)
    controller.api.call('play.scene', { root, id: session.id, turn: turn.id })
      .then(async () => { setSession(await controller.api.call('play.get', { root, id: session.id })) })
      .catch((reason: unknown) => {
        setPrefs({ paint: false })
        controller.toast('error', reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { setPainting(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, root, session, turn, scene.location, scene.background])
  useEffect(() => { if (prefs.paint) paintScene(false) }, [prefs.paint, paintScene])
  useEffect(() => {
    if (!prefs.paint || speaker === undefined || speaker.visual?.portrait !== undefined) return
    const key = `portrait:${speaker.id}`
    if (requested.current.has(key)) return
    requested.current.add(key)
    controller.api.call('play.portrait', { root, character: speaker.id }).catch(() => {})
  }, [controller, root, prefs.paint, speaker])

  const advance = useCallback((): void => {
    if (session === undefined) return
    if (typed < text.length) {
      setTyped(Number.MAX_SAFE_INTEGER)
      return
    }
    if (stepAt < steps.length - 1) {
      setStepAt(stepAt + 1)
      setTyped(0)
    } else if (turnAt < session.turns.length - 1) {
      setTurnAt(turnAt + 1)
      setStepAt(0)
      setTyped(0)
    }
  }, [session, typed, text.length, stepAt, steps.length, turnAt])

  const send = (kind: 'say' | 'do' | 'choice' | 'direct', value: string): void => {
    if (session === undefined || value.trim().length === 0 || thinking) return
    setThinking(true)
    setInput('')
    void controller.guard(async () => {
      const result = await controller.api.call('play.turn', { root, id: session.id, kind, text: value.trim() })
      setSession(result.session)
      setTurnAt(result.session.turns.length - 1)
      setStepAt(0)
      setTyped(0)
    }).finally(() => { setThinking(false) })
  }

  if (error !== undefined) return <Empty icon="alert" title={error}><Button onClick={onExit}>{t('返回', 'Back')}</Button></Empty>
  if (session === undefined) return <div className="nv-center"><Spinner size={18} /></div>

  const nameOf = (ref: string): string => project.characters.find(card => card.id === ref)?.name ?? ref
  const playerName = session.player !== undefined ? nameOf(session.player) : undefined
  /** @param as - `line`: what was played becomes another way the story goes — a line of the plot of its own, leaving where the scene branched off. */
  const novelize = (as: 'chapter' | 'line' = 'chapter'): Promise<unknown> => run(async () => {
    controller.toast('info', as === 'line' ? t('写手正在把这段幕间写成一条新剧情线的第一章…', 'The writer is turning this interlude into the first chapter of a new line of the plot…') : t('写手正在把这段幕间写成正文…', 'The writer is turning this interlude into prose…'))
    const info = await controller.run('play.novelize', { root, id: session.id, ...(as === 'line' ? { as: 'line' as const } : {}) })
    const chapterId = (info.result?.output as { chapterId?: string } | undefined)?.chapterId
    setSession(await controller.api.call('play.get', { root, id: session.id }))
    await controller.refreshProject()
    if (chapterId !== undefined) controller.setView('write', chapterId)
  })
  const settle = (outcome: 'open' | 'discarded' | 'side-story'): void => {
    void run(async () => { setSession(await controller.api.call('play.outcome', { root, id: session.id, outcome })) })
  }

  return (
    <div className="nv-play" ref={room}>
      <header className="nv-play-bar">
        <Button size="sm" variant="ghost" icon="chevronLeft" onClick={onExit}>{t('幕间列表', 'Interludes')}</Button>
        <strong className="nv-play-title">{session.title}</strong>
        <span className="nv-muted nv-small">{[scene.location, scene.time, scene.mood].filter(Boolean).join(' · ')}</span>
        {Object.entries(session.state ?? {}).slice(0, 3).map(([key, value]) => <Chip key={key} tone="violet" title={`${key}: ${String(value)}`}>{`${key} ${String(value)}`.length > 16 ? `${`${key} ${String(value)}`.slice(0, 15)}…` : `${key} ${String(value)}`}</Chip>)}
        {Object.keys(session.state ?? {}).length > 3 ? <Chip tone="violet" title={Object.entries(session.state ?? {}).slice(3).map(([key, value]) => `${key}: ${String(value)}`).join('\n')}>+{Object.keys(session.state ?? {}).length - 3}</Chip> : null}
        <span className="nv-spacer" />
        <Chip tone={prefs.voice ? 'green' : 'neutral'} active={prefs.voice} onClick={() => { setPrefs({ voice: !prefs.voice }) }} title={t('逐句配音（调用语音服务）', 'Voice each line (uses the speech provider)')}>{t('配音', 'Voices')}</Chip>
        <Chip tone={prefs.ambience ? 'green' : 'neutral'} active={prefs.ambience} onClick={() => { setPrefs({ ambience: !prefs.ambience }) }}>{prefs.ambience && scene.ambience !== undefined && scene.ambience !== 'none' ? `♪ ${t(...AMBIENCE[scene.ambience])}` : t('环境音', 'Ambience')}</Chip>
        <Chip tone={prefs.paint ? 'green' : 'neutral'} active={prefs.paint} onClick={() => { setPrefs({ paint: !prefs.paint }) }} title={t('自动绘制场景与立绘（调用图像服务）', 'Paint scenes and portraits automatically (uses the image provider)')}>{painting ? t('绘制中…', 'Painting…') : t('自动配图', 'Auto paint')}</Chip>
        <Button size="sm" variant="ghost" icon="history" onClick={() => { setLog(true) }} title={t('回看', 'Backlog')} />
        <Menu icon="more" align="end" items={[
          { label: t('画出当前场景', 'Paint this scene'), icon: 'image', onSelect: () => { paintScene(true) } },
          { label: t('回退一步', 'Take back the last move'), icon: 'undo', disabled: session.turns.length <= 1 || thinking, onSelect: () => { void run(async () => { const next = await controller.api.call('play.rewind', { root, id: session.id }); setSession(next); const last = Math.max(0, next.turns.length - 1); setTurnAt(last); setStepAt(Math.max(0, stepsOf(next.turns[last]).length - 1)); setTyped(Number.MAX_SAFE_INTEGER) }) } },
          'separator',
          { label: t('写成正文的一章', 'Turn into a chapter'), icon: 'feather', disabled: session.outcome === 'novelized', onSelect: () => { void novelize() } },
          { label: t('开成一条剧情线', 'Open it as a line of the plot'), icon: 'branch', disabled: session.outcome === 'novelized', onSelect: () => { void novelize('line') } },
          { label: t('留作番外', 'Keep as a side story'), icon: 'heart', onSelect: () => { settle('side-story') } },
          { label: t('作废（不算数）', 'Discard (never happened)'), icon: 'x', onSelect: () => { settle('discarded') } },
        ]} />
      </header>

      <div className="nv-play-stage" tabIndex={0} onClick={advance} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); advance() } }}>
        {scene.background !== undefined ? <ProjectImage className="nv-play-bg" path={scene.background} alt={scene.location ?? ''} /> : <div className={cx('nv-play-bg nv-play-bg-empty', `is-${scene.ambience ?? 'none'}`)}><span>{scene.location ?? session.location ?? ''}</span></div>}
        {speaker?.visual?.portrait !== undefined ? <ProjectImage key={speaker.id} className="nv-play-sprite" path={speaker.visual.portrait} alt={speaker.name} /> : null}
        {step !== undefined ? (
          <div className={cx('nv-play-box', step.kind === 'narration' && 'is-narration')}>
            {step.kind === 'line' ? <span className="nv-play-name">{step.line.speaker}{step.line.emotion !== undefined ? <small>{step.line.emotion}</small> : null}</span> : null}
            {step.kind === 'line' && step.line.action !== undefined ? <p className="nv-play-action">{step.line.action}</p> : null}
            <p className="nv-play-text">{text.slice(0, typed)}{typed < text.length ? <span className="nv-caret" /> : null}</p>
            {!atEnd && typed >= text.length ? <span className="nv-play-next">▼</span> : null}
          </div>
        ) : null}
        {thinking ? <div className="nv-play-thinking"><Spinner size={14} /> {t('对方正在回应…', 'They are responding…')}</div> : null}
      </div>

      {atEnd && !thinking ? (
        ended ? (
          <div className="nv-play-end nv-card">
            <strong>{session.outcome === 'novelized' ? t('这段幕间已经写成正文。', 'This interlude has been turned into a chapter.') : t('这一场落幕了。', 'The scene has come to its end.')}</strong>
            <div className="nv-row-wrap">
              {session.outcome !== 'novelized' ? <Button variant="primary" icon="feather" busy={busy} onClick={() => novelize()} title={t('写成一章，接在它分出的那一章后面，成为主线的一部分', 'Written as a chapter after the one it branched off, as part of the main line')}>{t('让写手写成一章', 'Turn it into a chapter')}</Button> : session.novelizedChapter !== undefined ? <Button icon="pen" onClick={() => { controller.setView('write', session.novelizedChapter) }}>{t('打开那一章', 'Open the chapter')}</Button> : null}
              {session.outcome !== 'novelized' ? <Button icon="branch" busy={busy} onClick={() => novelize('line')} title={t('不动主线：把演出来的走向开成一条新的剧情线，这一场是它的第一章。之后可以接着推演、并回主线，或者设为主线。', 'The main line stays as it is: what was played becomes a new line of the plot, with this scene as its first chapter. It can be gone on with, joined to the main line, or made the main line.')}>{t('开成一条剧情线', 'Open it as a line of the plot')}</Button> : null}
              {session.outcome !== 'novelized' ? <Button icon="heart" busy={busy} onClick={() => { settle('side-story') }}>{t('留作番外', 'Keep as a side story')}</Button> : null}
              {session.outcome !== 'novelized' ? <Button variant="ghost" busy={busy} onClick={() => { settle('discarded') }}>{t('作废', 'Discard')}</Button> : null}
              {turn?.ended !== true && session.outcome !== 'novelized' && session.outcome !== 'open' ? <Button variant="ghost" busy={busy} onClick={() => { settle('open') }}>{t('接着演', 'Keep playing')}</Button> : null}
            </div>
          </div>
        ) : (
          <div className="nv-play-input">
            {(turn?.choices ?? []).length > 0 ? (
              <div className="nv-play-choices">
                {turn!.choices.map((choice, index) => <button key={index} type="button" className="nv-play-choice" onClick={() => { send('choice', choice) }}>{choice}</button>)}
              </div>
            ) : null}
            <div className="nv-play-compose">
              <Select value={mode} options={[
                ...(playerName !== undefined ? [{ value: 'say' as const, label: t(`${playerName}说`, `${playerName} says`) }, { value: 'do' as const, label: t(`${playerName}做`, `${playerName} does`) }] : []),
                { value: 'direct' as const, label: t('导演指令', 'Direct the scene') },
              ]} onChange={setMode} />
              <TextInput className="nv-grow" value={input} placeholder={mode === 'say' ? t('说点什么…', 'Say something…') : mode === 'do' ? t('做点什么…', 'Do something…') : t('让场面怎么发展？例：门外突然有人敲门', 'How should the scene move? e.g. someone knocks at the door')} onChange={(event) => { setInput(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) send(mode, input) }} />
              <Button variant="primary" icon="send" disabled={input.trim().length === 0} onClick={() => { send(mode, input) }} />
            </div>
          </div>
        )
      ) : null}

      {log ? (
        <Modal wide title={t('回看', 'Backlog')} onClose={() => { setLog(false) }}>
          <div className="nv-play-log">
            <p className="nv-muted">{session.situation}</p>
            {session.turns.map(item => (
              <div key={item.id} className="nv-play-log-turn">
                {item.input !== undefined ? <p className="nv-play-log-input">{item.input.kind === 'direct' ? t('〔导演〕', '[director] ') : playerName !== undefined ? `${playerName}${item.input.kind === 'do' ? t('（动作）', ' (does)') : ''}：` : '→ '}{item.input.text}</p> : null}
                {item.narration !== undefined ? <p className="nv-play-log-narration">{item.narration}</p> : null}
                {item.lines.map((line, index) => <p key={index}><strong>{line.speaker}</strong>{line.action !== undefined ? <span className="nv-muted">（{line.action}）</span> : null}：{line.text}</p>)}
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
      {confirm.element}
    </div>
  )
}

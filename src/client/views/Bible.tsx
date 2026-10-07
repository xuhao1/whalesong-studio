// SPDX-License-Identifier: LGPL-3.0-or-later
/** Story bible: characters, world entries and style profiles. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { VoiceOption } from '../../shared/rpc'
import type {
  CharacterLook,
  CharacterCard, CharacterRole, CharacterStatus, NarrativePov, StyleProfile, WorldCategory, WorldEntry,
} from '../../shared/types'
import { Icon } from '../icons'
import {
  Button, Chip, cx, Empty, Field, Modal, ProjectImage, SectionTitle, Select, Tabs, TextArea, TextInput, useAction, useConfirm, useMediaUrl,
  useProject, useRunningJob, useSnapshot, useStudio, useT, type Translate,
} from '../ui'

export const ROLE_LABELS: Record<CharacterRole, [string, string]> = {
  protagonist: ['主角', 'Protagonist'],
  deuteragonist: ['第二主角', 'Deuteragonist'],
  antagonist: ['反派', 'Antagonist'],
  supporting: ['配角', 'Supporting'],
  minor: ['次要', 'Minor'],
  cameo: ['龙套', 'Cameo'],
}

export const STATUS_LABELS: Record<CharacterStatus, [string, string]> = {
  planned: ['未登场', 'Planned'],
  active: ['活跃', 'Active'],
  offstage: ['暂离', 'Offstage'],
  retired: ['已退场', 'Retired'],
  dead: ['已死亡', 'Dead'],
}

export const STATUS_TONES: Record<CharacterStatus, 'neutral' | 'green' | 'amber' | 'blue' | 'red'> = {
  planned: 'blue',
  active: 'green',
  offstage: 'amber',
  retired: 'neutral',
  dead: 'red',
}

const CATEGORY_LABELS: Record<WorldCategory, [string, string]> = {
  setting: ['世界概况', 'Setting'],
  location: ['地点', 'Location'],
  faction: ['势力', 'Faction'],
  system: ['体系', 'System'],
  item: ['物品', 'Item'],
  history: ['历史', 'History'],
  culture: ['文化', 'Culture'],
  rule: ['规则', 'Rule'],
  term: ['名词', 'Term'],
  other: ['其他', 'Other'],
}

const POV_LABELS: Record<NarrativePov, [string, string]> = {
  'first': ['第一人称', 'First person'],
  'third-limited': ['第三人称有限', 'Third limited'],
  'third-omniscient': ['第三人称全知', 'Third omniscient'],
  'second': ['第二人称', 'Second person'],
  'multi': ['多视角轮换', 'Rotating viewpoints'],
}

const lines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
const options = <T extends string>(labels: Record<T, [string, string]>, t: Translate): { value: T; label: string }[] =>
  (Object.keys(labels) as T[]).map(value => ({ value, label: t(labels[value][0], labels[value][1]) }))

export function BibleView() {
  const t = useT()
  const { project } = useProject()
  const [tab, setTab] = useState<'characters' | 'world' | 'style'>('characters')
  return (
    <div className="nv-page nv-bible">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'characters', label: t('人物', 'Characters'), icon: 'users', badge: project.characters.length },
          { value: 'world', label: t('世界观', 'World'), icon: 'globe', badge: project.world.length },
          { value: 'style', label: t('文风', 'Style'), icon: 'feather', badge: project.styles.length },
        ]}
      />
      {tab === 'characters' ? <Characters /> : tab === 'world' ? <World /> : <Styles />}
    </div>
  )
}

/** Follow an AI-assist job and show its stream while it runs. */
function useAssist(): { running: boolean; stream: string; start: (run: (onText: (text: string) => void) => Promise<unknown>) => void } {
  const { controller } = useStudio()
  const [running, setRunning] = useState(false)
  const [stream, setStream] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const start = (run: (onText: (text: string) => void) => Promise<unknown>): void => {
    setRunning(true)
    setStream('')
    void controller.guard(async () => { await run((text) => { if (alive.current) setStream(text) }) }).finally(() => {
      if (alive.current) {
        setRunning(false)
        setStream('')
      }
    })
  }
  return { running, stream, start }
}

// ───────────────────────────── characters ─────────────────────────────

function Characters() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const order: CharacterRole[] = ['protagonist', 'deuteragonist', 'antagonist', 'supporting', 'minor', 'cameo']
  const [selected, setSelected] = useState<string | undefined>(() => [...project.characters].sort((left, right) => order.indexOf(left.role) - order.indexOf(right.role))[0]?.id)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const visible = project.characters
    .filter(card => query.trim().length === 0 || `${card.name} ${card.aliases?.join(' ') ?? ''} ${card.tagline ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => order.indexOf(left.role) - order.indexOf(right.role))
  const card = project.characters.find(candidate => candidate.id === selected)
  const { busy, run } = useAction()
  const create = (): Promise<unknown> => run(async () => {
    const created = await controller.api.call('character.save', { root, card: { name: name.trim(), role: 'supporting', status: 'planned' } })
    setSelected(created.id)
    setCreating(false)
    setName('')
  })
  return (
    <div className="nv-split">
      <aside className="nv-split-list">
        <div className="nv-list-tools">
          <TextInput value={query} placeholder={t('搜索人物', 'Search characters')} onChange={(event) => { setQuery(event.target.value) }} />
          <Button size="sm" icon="plus" variant="primary" onClick={() => { setCreating(true) }} title={t('新建人物', 'New character')} />
        </div>
        <ul className="nv-list">
          {visible.map(item => (
            <li key={item.id}>
              <button type="button" className={cx('nv-list-row nv-person', item.id === selected && 'is-active')} onClick={() => { setSelected(item.id) }}>
                {item.visual?.portrait !== undefined ? <ProjectImage className="nv-avatar" path={item.visual.portrait} alt={item.name} /> : <span className="nv-avatar nv-avatar-empty">{item.name.slice(0, 1)}</span>}
                <span className="nv-person-text">
                  <span className="nv-list-title">{item.name}</span>
                  <span className="nv-list-meta">{t(...ROLE_LABELS[item.role])}{item.tagline !== undefined ? ` · ${item.tagline}` : ''}</span>
                </span>
                <Chip tone={STATUS_TONES[item.status]}>{t(...STATUS_LABELS[item.status])}</Chip>
              </button>
            </li>
          ))}
        </ul>
        {project.characters.length === 0 ? <p className="nv-muted nv-pad">{t('还没有人物。新建一个，或让总编/架构模型根据故事核起草。', 'No characters yet. Create one, or let the showrunner draft the cast from the premise.')}</p> : null}
      </aside>
      <section className="nv-split-detail">
        {card !== undefined ? <CharacterEditor key={card.id} card={card} onDeleted={() => { setSelected(undefined) }} /> : <Empty icon="users" title={t('选择或新建一个人物', 'Select or create a character')} />}
      </section>
      {creating ? (
        <Modal title={t('新建人物', 'New character')} onClose={() => { setCreating(false) }} footer={<Button variant="primary" busy={busy} disabled={name.trim().length === 0} onClick={create}>{t('创建', 'Create')}</Button>}>
          <Field label={t('姓名', 'Name')}><TextInput autoFocus value={name} onChange={(event) => { setName(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && name.trim().length > 0) create() }} /></Field>
        </Modal>
      ) : null}
    </div>
  )
}

function CharacterEditor({ card, onDeleted }: { card: CharacterCard; onDeleted: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [draft, setDraft] = useState<CharacterCard>(card)
  const [dirty, setDirty] = useState(false)
  const [direction, setDirection] = useState('')
  const { busy, run } = useAction()
  const assist = useAssist()
  const confirm = useConfirm()
  const mediaUrl = useMediaUrl()
  const settings = useSnapshot(snapshot => snapshot.settings)
  useEffect(() => { if (settings === undefined) void controller.loadSettings().catch(() => {}) }, [controller, settings])
  // Changes from elsewhere (the agent, an AI assist) replace the form unless it has unsaved edits.
  useEffect(() => { if (!dirty) setDraft(card) }, [card, dirty])
  const set = <K extends keyof CharacterCard>(key: K, value: CharacterCard[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const text = (key: 'tagline' | 'gender' | 'age' | 'appearance' | 'personality' | 'background' | 'motivation' | 'flaw' | 'arc' | 'voice' | 'abilities' | 'secrets' | 'notes') => ({
    value: draft[key] ?? '',
    onChange: (event: { target: { value: string } }) => { set(key, event.target.value) },
  })
  const persona = draft.persona ?? {}
  const setPersona = (patch: Partial<NonNullable<CharacterCard['persona']>>): void => { set('persona', { ...persona, ...patch }) }
  const save = (): Promise<unknown> => run(async () => {
    // Empty strings clear fields on the Host; arrays are sent whole.
    const payload: Record<string, unknown> = { ...draft, aliases: draft.aliases ?? [], relationships: draft.relationships ?? [], tags: draft.tags ?? [] }
    for (const key of ['tagline', 'gender', 'age', 'appearance', 'personality', 'background', 'motivation', 'flaw', 'arc', 'voice', 'abilities', 'secrets', 'notes']) {
      if (payload[key] === undefined) payload[key] = ''
    }
    await controller.api.call('character.save', { root, card: payload as Partial<CharacterCard> })
    setDirty(false)
    controller.toast('success', t('已保存', 'Saved'))
  })
  const presence = project.presence.find(entry => entry.character === card.id)
  const voices: VoiceOption[] = settings?.voices ?? []
  const voiceProfile = draft.voiceProfile ?? {}
  // Work on this card that is still running — also when it was started before this screen was opened.
  const anchoring = useRunningJob(job => job.kind === 'bible' && job.title.startsWith('visual anchor') && job.target === card.id) !== undefined
  const drawing = useRunningJob(job => job.kind === 'illustrate' && job.target === card.id)
  const designing = useRunningJob(job => job.kind === 'audio' && job.title === 'design voice' && job.target === card.id) !== undefined
  const [sample, setSample] = useState<{ path: string; at: number } | undefined>()
  const audition = (): Promise<unknown> | undefined => {
    if (!controller.need('tts')) return undefined
    return controller.guard(async () => {
      // By character, so what is heard is the voice their lines will have — the one on the card, or the one cast for them.
      const started = await controller.api.call('voice.audition', { root, character: card.id, text: t(`我是${card.name}。有些话，我只说一遍。`, `I am ${card.name}. Some things I only say once.`) }) as { jobId?: string; path?: string }
      // Shown as work in progress at once, with its stages, wherever the author looks.
      void controller.refreshJobs()
      // A Host from before auditions became jobs answers with the sample itself.
      const path = started.jobId !== undefined ? ((await controller.follow(started.jobId).done).result?.output as { path?: string } | undefined)?.path : started.path
      if (path === undefined) return
      setSample({ path, at: Date.now() })
      void new Audio(mediaUrl(path, Date.now())).play().catch(() => {})
    })
  }
  const draw = (kind: 'sheet' | 'portrait', done: string, look?: string): Promise<unknown> | undefined => {
    if (!controller.need('image')) return undefined
    return controller.guard(async () => {
      await controller.run('image.create', { root, kind, target: card.id, ...(look !== undefined ? { look } : {}) })
      controller.toast('success', done)
    })
  }

  return (
    <div className="nv-editor-form">
      <header className="nv-detail-head">
        <div className="nv-detail-title">
          {draft.visual?.portrait !== undefined ? <ProjectImage className="nv-portrait" path={draft.visual.portrait} alt={draft.name} /> : null}
          <div>
            <h2>{draft.name}</h2>
            <span className="nv-muted">{presence !== undefined && presence.chapters.length > 0 ? t(`出场 ${presence.chapters.length} 章，最近一次在 ${presence.absentFor} 章前`, `In ${presence.chapters.length} chapters; last seen ${presence.absentFor} chapters ago`) : t('尚未在正文中出场', 'Not yet on the page')}</span>
          </div>
        </div>
        <div className="nv-row">
          <Button variant="ghost" size="sm" icon="trash" busy={busy} onClick={() => { confirm.ask(t(`删除人物「${card.name}」？`, `Delete the character "${card.name}"?`), () => { void run(async () => { await controller.api.call('character.delete', { root, id: card.id }); onDeleted() }) }) }} />
          <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
        </div>
      </header>

      <div className="nv-assist">
        <TextInput value={direction} placeholder={t('让 AI 补全这张人物卡（可写要求，如"给他一个不愿提起的过去"）', 'Let AI complete this card (optionally say what you want)')} onChange={(event) => { setDirection(event.target.value) }} />
        <Button icon="sparkles" busy={assist.running} pending={t('AI 正在补全…', 'Completing…')} disabled={dirty} title={dirty ? t('先保存当前修改', 'Save your edits first') : undefined} onClick={() => { assist.start(async (onText) => { await controller.run('character.expand', { root, id: card.id, ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, onText); setDirection('') }) }}>{t('AI 补全', 'Complete')}</Button>
      </div>
      {assist.stream.length > 0 ? <pre className="nv-stream">{assist.stream.slice(-800)}</pre> : null}

      <SectionTitle>{t('基本', 'Basics')}</SectionTitle>
      <div className="nv-form-grid">
        <Field label={t('姓名', 'Name')}><TextInput value={draft.name} onChange={(event) => { set('name', event.target.value) }} /></Field>
        <Field label={t('别名 / 称呼', 'Aliases')} hint={t('用顿号或逗号分隔', 'Comma separated')}><TextInput value={(draft.aliases ?? []).join('、')} onChange={(event) => { set('aliases', event.target.value.split(/[、,，]+/).map(item => item.trim()).filter(Boolean)) }} /></Field>
        <Field label={t('定位', 'Role')}><Select value={draft.role} options={options(ROLE_LABELS, t)} onChange={(value) => { set('role', value) }} /></Field>
        <Field label={t('生命周期', 'Lifecycle')}><Select value={draft.status} options={options(STATUS_LABELS, t)} onChange={(value) => { set('status', value) }} /></Field>
        <Field label={t('性别', 'Gender')}><TextInput {...text('gender')} /></Field>
        <Field label={t('年龄', 'Age')}><TextInput {...text('age')} /></Field>
      </div>
      <Field label={t('一句话人设', 'One-line identity')}><TextInput {...text('tagline')} /></Field>

      <SectionTitle>{t('内在', 'Inner life')}</SectionTitle>
      <Field label={t('性格', 'Personality')}><TextArea {...text('personality')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('动机（想要 / 需要）', 'Motivation (want / need)')}><TextArea {...text('motivation')} /></Field>
        <Field label={t('弱点', 'Flaw')}><TextArea {...text('flaw')} /></Field>
      </div>
      <Field label={t('人物弧光', 'Arc')}><TextArea {...text('arc')} /></Field>
      <Field label={t('背景', 'Background')}><TextArea {...text('background')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('能力', 'Abilities')}><TextArea {...text('abilities')} /></Field>
        <Field label={t('秘密', 'Secrets')} hint={t('作者知道、他人未必知道', 'Known to the author, not to everyone')}><TextArea {...text('secrets')} /></Field>
      </div>

      <SectionTitle>{t('人格', 'Persona')}</SectionTitle>
      <div className="nv-form-grid">
        <Field label={t('特质', 'Traits')} hint={t('每行一个，可写强度：倔强 5', 'One per line, optional intensity: stubborn 5')}>
          <TextArea value={(persona.traits ?? []).map(trait => `${trait.name}${trait.level !== undefined ? ` ${trait.level}` : ''}`).join('\n')} onChange={(event) => {
            setPersona({ traits: lines(event.target.value).map((line) => {
              const match = /^(.*?)[\s:：]*([1-5])$/.exec(line)
              return match !== null && match[1] !== undefined && match[1].trim().length > 0 ? { name: match[1].trim(), level: Number(match[2]) } : { name: line }
            }) })
          }} />
        </Field>
        <Field label={t('看重的东西', 'Values')} hint={t('每行一个，按优先级', 'One per line, by priority')}><TextArea value={(persona.values ?? []).join('\n')} onChange={(event) => { setPersona({ values: lines(event.target.value) }) }} /></Field>
        <Field label={t('说话习惯', 'Speech habits')} hint={t('口头禅、句式、语域', 'Catchphrases, sentence shape, register')}><TextArea value={(persona.speech ?? []).join('\n')} onChange={(event) => { setPersona({ speech: lines(event.target.value) }) }} /></Field>
        <Field label={t('绝不会', 'Would never')}><TextArea value={(persona.taboos ?? []).join('\n')} onChange={(event) => { setPersona({ taboos: lines(event.target.value) }) }} /></Field>
      </div>
      <Field label={t('压力下的反应', 'Under pressure')}><TextInput value={persona.underPressure ?? ''} onChange={(event) => { setPersona({ underPressure: event.target.value }) }} /></Field>
      <Field label={t('对白的声音', 'Voice on the page')} hint={t('写手据此写对白', 'The writer uses this for dialogue')}><TextArea {...text('voice')} /></Field>

      <SectionTitle>{t('关系', 'Relationships')}</SectionTitle>
      <RelationshipEditor value={draft.relationships ?? []} onChange={(value) => { set('relationships', value) }} />

      <SectionTitle actions={(
        <>
          <Button size="sm" icon="wand" disabled={dirty} busy={anchoring} pending={t('正在提炼…', 'Distilling…')} title={t('让分析模型把外貌改写成绘图模型画得稳的短语', 'Have the analyst rewrite the appearance as phrases an image model draws consistently')} onClick={() => controller.guard(async () => { await controller.run('character.visual', { root, id: card.id }); controller.toast('success', t('视觉锚点已更新', 'Visual anchor updated')) })}>{t('提炼视觉锚点', 'Distill anchor')}</Button>
          <Button size="sm" icon="users" disabled={dirty || (drawing !== undefined && drawing.title !== 'illustrate sheet')} busy={drawing?.title === 'illustrate sheet'} pending={t('正在画人设图（约一两分钟）…', 'Drawing the sheet (a minute or two)…')} onClick={() => draw('sheet', t('人设图已生成', 'Design sheet ready'))}>{t('生成人设图', 'Design sheet')}</Button>
          <Button size="sm" icon="image" disabled={dirty || (drawing !== undefined && drawing.title !== 'illustrate portrait')} busy={drawing?.title === 'illustrate portrait'} pending={t('正在画立绘…', 'Drawing the portrait…')} onClick={() => draw('portrait', t('立绘已生成', 'Portrait ready'))}>{t('生成立绘', 'Portrait')}</Button>
        </>
      )}>{t('形象', 'Looks')}</SectionTitle>
      <Field label={t('外貌', 'Appearance')} hint={t('写给读者和写手看的', 'Written for readers and for the writer')}><TextArea {...text('appearance')} /></Field>
      <Field label={t('视觉锚点', 'Visual anchor')} hint={t('写给绘图模型看的：具体、看得见、可复用的短语（英文最稳），如发型的实际形状、衣料与颜色、随身标志物。每张有此人的图都会原样带上。不要写机构名、头衔这类词——模型会按现实里最常见的样子去画。', 'Written for the image model: concrete, visible, reusable phrases (English is steadiest) — the actual shape of the hair, fabric and colour, signature items. Restated as is in every picture of them. No names of institutions or titles: a model draws the commonest real-world version.')}>
        <TextArea value={draft.visual?.prompt ?? ''} placeholder={t('留空时，生成人设图或立绘前会自动从"外貌"提炼', 'Left empty, it is distilled from "Appearance" before a sheet or portrait is drawn')} onChange={(event) => { set('visual', { ...draft.visual, prompt: event.target.value }) }} />
      </Field>
      <Field label={t('这个人物身上不要画出', 'Never drawn on them')} hint={t('逗号分隔；会并入每张有此人的图的"不要出现"', 'Comma-separated; joins the avoid list of every picture that shows them')}>
        <TextInput value={draft.visual?.negative ?? ''} placeholder={t('如：cross emblem, shoulder straps', 'e.g. cross emblem, shoulder straps')} onChange={(event) => { set('visual', { ...draft.visual, negative: event.target.value }) }} />
      </Field>
      {draft.visual?.sheet !== undefined ? (
        <figure className="nv-sheet">
          <ProjectImage path={draft.visual.sheet} alt={t(`${draft.name}的人设图`, `Design sheet of ${draft.name}`)} />
          <figcaption className="nv-muted nv-small">{t('人设图（正面、侧面、背面）。之后每一张有此人的图，都会把它当参考图一起交给绘图模型。', 'Design sheet (front, side, back). Every later picture of them is drawn with it as a reference image.')}</figcaption>
        </figure>
      ) : <p className="nv-note">{t('还没有人设图。先看一眼视觉锚点对不对，再点"生成人设图"——它是之后所有图里这个人长相一致的依据。', 'No design sheet yet. Check the visual anchor, then choose "Design sheet" — it is what keeps this person the same in every later picture.')}</p>}
      <LooksEditor
        value={draft.visual?.looks ?? []}
        dirty={dirty}
        onChange={(looks) => { set('visual', { ...draft.visual, looks }) }}
        busy={drawing !== undefined}
        onDraw={look => draw('sheet', t(`「${look.name}」的人设图已生成`, `Sheet of "${look.name}" ready`), look.name)}
      />

      <SectionTitle>{t('配音', 'Speaking voice')}</SectionTitle>
      <div className="nv-form-grid">
        <Field label={t('音色', 'Voice')} hint={t('留空则按性别年龄自动选角', 'Leave empty to cast by gender and age')}>
          <TextInput list={`nv-voices-${card.id}`} value={voiceProfile.voice ?? ''} placeholder={t('音色 ID', 'Voice id')} onChange={(event) => { set('voiceProfile', { ...voiceProfile, voice: event.target.value, ...(settings !== undefined ? { provider: settings.settings.tts.provider } : {}) }) }} />
          <datalist id={`nv-voices-${card.id}`}>{voices.map(voice => <option key={voice.id} value={voice.id}>{`${voice.note}${voice.accent !== undefined ? ` · ${voice.accent}` : ''}`}</option>)}</datalist>
        </Field>
        <Field label={t('表演基调', 'Delivery baseline')}><TextInput value={voiceProfile.instructions ?? ''} placeholder={t('如：语速偏慢，声音低沉', 'e.g. slow, low and steady')} onChange={(event) => { set('voiceProfile', { ...voiceProfile, instructions: event.target.value }) }} /></Field>
      </div>
      <Field label={t('声线设计描述', 'Voice design description')} hint={t('用于"设计专属声线"：年龄感、音色、语速、气质', 'Used to design a voice of their own: age, timbre, pace, temperament')}>
        <TextArea value={voiceProfile.designPrompt ?? ''} onChange={(event) => { set('voiceProfile', { ...voiceProfile, designPrompt: event.target.value }) }} />
      </Field>
      <div className="nv-row-wrap">
        <Button size="sm" icon="volume" disabled={dirty} pending={t('正在生成试听语音…', 'Recording the audition…')} title={t('用这个人物在有声剧里的声音念一句话——人物卡上的音色，或为他定下的那个。新声音第一次要先定音色，会久一些', 'Speak a line in the voice this character has in the audio drama — the one on the card, or the one cast for them. A new voice is set up first, which takes a little longer')} onClick={audition}>{t('试听', 'Audition')}</Button>
        <Button size="sm" icon="wand" disabled={dirty} busy={designing} pending={t('正在设计声线…', 'Designing the voice…')} onClick={() => (controller.need('tts') ? controller.guard(async () => { await controller.run('voice.design', { root, character: card.id }); controller.toast('success', t('专属声线已创建', 'Voice designed')) }) : undefined)}>{t('设计专属声线', 'Design a voice')}</Button>
        {sample !== undefined ? <audio key={sample.at} controls preload="auto" src={mediaUrl(sample.path, sample.at)} className="nv-audio-inline" title={t('刚才的试听', 'The audition just recorded')} /> : voiceProfile.sample !== undefined ? <audio controls preload="none" src={mediaUrl(voiceProfile.sample)} className="nv-audio-inline" title={t('专属声线的样音', 'Sample of the designed voice')} /> : null}
      </div>

      <SectionTitle>{t('备注', 'Notes')}</SectionTitle>
      <TextArea {...text('notes')} minRows={3} maxRows={20} />
      {confirm.element}
    </div>
  )
}

function RelationshipEditor({ value, onChange }: { value: NonNullable<CharacterCard['relationships']>; onChange: (value: NonNullable<CharacterCard['relationships']>) => void }) {
  const t = useT()
  const { project } = useProject()
  const nameOf = (ref: string): string => project.characters.find(card => card.id === ref)?.name ?? ref
  return (
    <div className="nv-relations">
      {value.map((relation, index) => (
        <div className="nv-relation" key={index}>
          <TextInput list="nv-character-names" value={nameOf(relation.target)} placeholder={t('对方', 'Who')} onChange={(event) => {
            const typed = event.target.value
            const card = project.characters.find(candidate => candidate.name === typed)
            onChange(value.map((item, at) => at === index ? { ...item, target: card?.id ?? typed } : item))
          }} />
          <TextInput value={relation.kind} placeholder={t('关系', 'Relationship')} onChange={(event) => { onChange(value.map((item, at) => at === index ? { ...item, kind: event.target.value } : item)) }} />
          <TextInput value={relation.note ?? ''} placeholder={t('说明', 'Note')} onChange={(event) => { onChange(value.map((item, at) => at === index ? { ...item, note: event.target.value } : item)) }} />
          <Button variant="ghost" size="sm" icon="x" onClick={() => { onChange(value.filter((_item, at) => at !== index)) }} />
        </div>
      ))}
      <datalist id="nv-character-names">{project.characters.map(card => <option key={card.id} value={card.name} />)}</datalist>
      <Button size="sm" icon="plus" variant="ghost" onClick={() => { onChange([...value, { target: '', kind: '' }]) }}>{t('添加关系', 'Add relationship')}</Button>
    </div>
  )
}

// ───────────────────────────── world ─────────────────────────────

function World() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [selected, setSelected] = useState<string | undefined>(project.world[0]?.id)
  const [category, setCategory] = useState<WorldCategory | 'all'>('all')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const { busy, run } = useAction()
  const visible = project.world.filter(entry => category === 'all' || entry.category === category).sort((left, right) => left.importance - right.importance)
  const entry = project.world.find(candidate => candidate.id === selected)
  const used = [...new Set(project.world.map(item => item.category))]
  const create = (): Promise<unknown> => run(async () => {
    const created = await controller.api.call('world.save', { root, entry: { name: name.trim(), category: category === 'all' ? 'other' : category, importance: 2 } })
    setSelected(created.id)
    setCreating(false)
    setName('')
  })
  return (
    <div className="nv-split">
      <aside className="nv-split-list">
        <div className="nv-list-tools">
          <Select value={category} options={[{ value: 'all', label: t('全部类别', 'All categories') }, ...options(CATEGORY_LABELS, t).filter(option => used.includes(option.value))]} onChange={setCategory} />
          <Button size="sm" icon="plus" variant="primary" onClick={() => { setCreating(true) }} title={t('新建条目', 'New entry')} />
        </div>
        <ul className="nv-list">
          {visible.map(item => (
            <li key={item.id}>
              <button type="button" className={cx('nv-list-row', item.id === selected && 'is-active')} onClick={() => { setSelected(item.id) }}>
                <span className="nv-person-text">
                  <span className="nv-list-title">{item.importance === 1 ? '★ ' : ''}{item.name}</span>
                  <span className="nv-list-meta">{t(...CATEGORY_LABELS[item.category])}{item.summary !== undefined ? ` · ${item.summary}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {project.world.length === 0 ? <p className="nv-muted nv-pad">{t('还没有设定条目。★ 核心设定会始终随上下文提供给模型，其余按相关性取用。', 'No entries yet. ★ core canon always travels with the context; the rest is fetched by relevance.')}</p> : null}
      </aside>
      <section className="nv-split-detail">
        {entry !== undefined ? <WorldEditor key={entry.id} entry={entry} onDeleted={() => { setSelected(undefined) }} /> : <Empty icon="globe" title={t('选择或新建一个设定条目', 'Select or create a world entry')} />}
      </section>
      {creating ? (
        <Modal title={t('新建设定条目', 'New world entry')} onClose={() => { setCreating(false) }} footer={<Button variant="primary" busy={busy} disabled={name.trim().length === 0} onClick={create}>{t('创建', 'Create')}</Button>}>
          <Field label={t('名称', 'Name')}><TextInput autoFocus value={name} onChange={(event) => { setName(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && name.trim().length > 0) create() }} /></Field>
        </Modal>
      ) : null}
    </div>
  )
}

function WorldEditor({ entry, onDeleted }: { entry: WorldEntry; onDeleted: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [draft, setDraft] = useState<WorldEntry>(entry)
  const [dirty, setDirty] = useState(false)
  const [direction, setDirection] = useState('')
  const { busy, run } = useAction()
  const assist = useAssist()
  const confirm = useConfirm()
  useEffect(() => { if (!dirty) setDraft(entry) }, [entry, dirty])
  const set = <K extends keyof WorldEntry>(key: K, value: WorldEntry[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const save = (): Promise<unknown> => run(async () => {
    await controller.api.call('world.save', { root, entry: { ...draft, summary: draft.summary ?? '', body: draft.body ?? '', visualPrompt: draft.visualPrompt ?? '', aliases: draft.aliases ?? [], tags: draft.tags ?? [] } })
    setDirty(false)
    controller.toast('success', t('已保存', 'Saved'))
  })
  return (
    <div className="nv-editor-form">
      <header className="nv-detail-head">
        <h2>{draft.name}</h2>
        <div className="nv-row">
          <Button variant="ghost" size="sm" icon="trash" onClick={() => { confirm.ask(t(`删除设定「${entry.name}」？`, `Delete the entry "${entry.name}"?`), () => { void run(async () => { await controller.api.call('world.delete', { root, id: entry.id }); onDeleted() }) }) }} />
          <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
        </div>
      </header>
      <div className="nv-assist">
        <TextInput value={direction} placeholder={t('让 AI 完善这条设定（规则、代价、限制、与情节的关联）', 'Let AI develop this entry (rules, costs, limits, ties to the plot)')} onChange={(event) => { setDirection(event.target.value) }} />
        <Button icon="sparkles" busy={assist.running} pending={t('AI 正在补全…', 'Completing…')} disabled={dirty} onClick={() => { assist.start(async (onText) => { await controller.run('world.expand', { root, id: entry.id, ...(direction.trim().length > 0 ? { direction: direction.trim() } : {}) }, onText); setDirection('') }) }}>{t('AI 完善', 'Develop')}</Button>
      </div>
      {assist.stream.length > 0 ? <pre className="nv-stream">{assist.stream.slice(-800)}</pre> : null}
      <div className="nv-form-grid">
        <Field label={t('名称', 'Name')}><TextInput value={draft.name} onChange={(event) => { set('name', event.target.value) }} /></Field>
        <Field label={t('别名', 'Aliases')}><TextInput value={(draft.aliases ?? []).join('、')} onChange={(event) => { set('aliases', event.target.value.split(/[、,，]+/).map(item => item.trim()).filter(Boolean)) }} /></Field>
        <Field label={t('类别', 'Category')}><Select value={draft.category} options={options(CATEGORY_LABELS, t)} onChange={(value) => { set('category', value) }} /></Field>
        <Field label={t('重要程度', 'Importance')}>
          <Select value={String(draft.importance) as '1' | '2' | '3'} options={[
            { value: '1', label: t('★ 核心（始终提供给模型）', '★ Core (always in context)') },
            { value: '2', label: t('常规（相关时提供）', 'Normal (when relevant)') },
            { value: '3', label: t('细节（按需检索）', 'Detail (on demand)') },
          ]} onChange={(value) => { set('importance', Number(value) as 1 | 2 | 3) }} />
        </Field>
      </div>
      <Field label={t('一句话概括', 'Summary')}><TextInput value={draft.summary ?? ''} onChange={(event) => { set('summary', event.target.value) }} /></Field>
      <Field label={t('详细设定', 'Details')}><TextArea value={draft.body ?? ''} minRows={8} maxRows={30} onChange={(event) => { set('body', event.target.value) }} /></Field>
      {draft.category === 'location' || draft.category === 'setting' ? (
        <>
          <Field label={t('场景视觉描述', 'Visual description')} hint={t('这个地方实际的样子：结构、材质、新旧、光线。画到这里的图都会用它；别只写名字——绘图模型会按现实里同名的东西去画。', 'What the place actually looks like: layout, materials, wear, light. Every picture set here uses it; a bare name makes the model draw its real-world namesake.')}>
            <div className="nv-row">
              <TextArea value={draft.visualPrompt ?? ''} onChange={(event) => { set('visualPrompt', event.target.value) }} />
              <Button size="sm" icon="image" disabled={dirty} pending={t('正在画场景设定图…', 'Drawing the place…')} onClick={() => !controller.need('image') ? undefined : controller.guard(async () => { await controller.run('image.create', { root, kind: 'location', target: entry.id }); controller.toast('success', t('场景设定图已生成', 'Place art ready')) })}>{t('场景设定图', 'Place art')}</Button>
            </div>
          </Field>
          {draft.visualImage !== undefined ? (
            <figure className="nv-sheet">
              <ProjectImage path={draft.visualImage} alt={draft.name} />
              <figcaption className="nv-muted nv-small">{t('场景设定图。发生在这里的画面会把它当参考图。', 'Place art. Pictures set here are drawn with it as a reference image.')}</figcaption>
            </figure>
          ) : null}
        </>
      ) : null}
      {confirm.element}
    </div>
  )
}

// ───────────────────────────── style ─────────────────────────────

function Styles() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const active = project.manifest.activeStyle
  const [selected, setSelected] = useState<string | undefined>(project.styles.find(style => style.id === active)?.id ?? project.styles[0]?.id)
  const [learning, setLearning] = useState(false)
  const [sample, setSample] = useState('')
  const [sampleName, setSampleName] = useState('')
  const assist = useAssist()
  const { busy, run } = useAction()
  const style = project.styles.find(candidate => candidate.id === selected)
  return (
    <div className="nv-split">
      <aside className="nv-split-list">
        <div className="nv-list-tools">
          <Button size="sm" icon="plus" onClick={() => run(async () => { const created = await controller.api.call('style.save', { root, style: { name: t('新文风', 'New style') } }); setSelected(created.id) })} busy={busy}>{t('新建', 'New')}</Button>
          <Button size="sm" icon="wand" onClick={() => { setLearning(true) }}>{t('从范文提炼', 'Learn from a sample')}</Button>
        </div>
        <ul className="nv-list">
          {project.styles.map(item => (
            <li key={item.id}>
              <button type="button" className={cx('nv-list-row', item.id === selected && 'is-active')} onClick={() => { setSelected(item.id) }}>
                <span className="nv-person-text">
                  <span className="nv-list-title">{item.name}</span>
                  <span className="nv-list-meta">{item.tone ?? ''}</span>
                </span>
                {item.id === active ? <Chip tone="green">{t('当前', 'Active')}</Chip> : null}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="nv-split-detail">
        {style !== undefined ? <StyleEditor key={style.id} style={style} active={style.id === active} onDeleted={() => { setSelected(undefined) }} /> : <Empty icon="feather" title={t('选择或新建一个文风', 'Select or create a style')} />}
      </section>
      {learning ? (
        <Modal title={t('从范文提炼文风', 'Learn a style from a sample')} wide onClose={() => { setLearning(false) }} footer={(
          <Button variant="primary" busy={assist.running} pending={t('正在提炼文风…', 'Extracting the style…')} disabled={sample.trim().length < 80} onClick={() => {
            assist.start(async () => {
              const info = await controller.run('style.extract', { root, sample, ...(sampleName.trim().length > 0 ? { name: sampleName.trim() } : {}) })
              const id = (info.result?.output as { id?: string } | undefined)?.id
              if (id !== undefined) setSelected(id)
              setLearning(false)
              setSample('')
            })
          }}>{t('提炼', 'Learn')}</Button>
        )}>
          <Field label={t('文风名称', 'Style name')}><TextInput value={sampleName} placeholder={t('可留空', 'Optional')} onChange={(event) => { setSampleName(event.target.value) }} /></Field>
          <Field label={t('范文', 'Sample')} hint={t('贴几段你想模仿其笔触的文字（至少几百字）。只学写法，不学内容。', 'Paste a few paragraphs whose touch you want. Only the manner is learned, not the content.')}>
            <TextArea value={sample} minRows={10} maxRows={22} onChange={(event) => { setSample(event.target.value) }} />
          </Field>
        </Modal>
      ) : null}
    </div>
  )
}

function StyleEditor({ style, active, onDeleted }: { style: StyleProfile; active: boolean; onDeleted: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root, project } = useProject()
  const [draft, setDraft] = useState<StyleProfile>(style)
  const [dirty, setDirty] = useState(false)
  const [scene, setScene] = useState('')
  const [preview, setPreview] = useState('')
  const { busy, run } = useAction()
  const assist = useAssist()
  const confirm = useConfirm()
  useEffect(() => { if (!dirty) setDraft(style) }, [style, dirty])
  const set = <K extends keyof StyleProfile>(key: K, value: StyleProfile[K]): void => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const text = (key: 'tone' | 'diction' | 'rhythm' | 'imagery' | 'dialogue' | 'pacing' | 'body') => ({ value: draft[key] ?? '', onChange: (event: { target: { value: string } }) => { set(key, event.target.value) } })
  const payload = useMemo(() => ({ ...draft, tone: draft.tone ?? '', diction: draft.diction ?? '', rhythm: draft.rhythm ?? '', imagery: draft.imagery ?? '', dialogue: draft.dialogue ?? '', pacing: draft.pacing ?? '', body: draft.body ?? '', rules: draft.rules ?? [], avoid: draft.avoid ?? [], exemplars: draft.exemplars ?? [] }), [draft])
  const save = (activate = false): Promise<unknown> => run(async () => {
    await controller.api.call('style.save', { root, style: payload, activate })
    setDirty(false)
    controller.toast('success', activate ? t('已设为当前文风', 'Now the active style') : t('已保存', 'Saved'))
  })
  return (
    <div className="nv-editor-form">
      <header className="nv-detail-head">
        <h2>{draft.name}{active ? <Chip tone="green">{t('当前文风', 'Active')}</Chip> : null}</h2>
        <div className="nv-row">
          {project.styles.length > 1 ? <Button variant="ghost" size="sm" icon="trash" onClick={() => { confirm.ask(t(`删除文风「${style.name}」？`, `Delete the style "${style.name}"?`), () => { void run(async () => { await controller.api.call('style.delete', { root, id: style.id }); onDeleted() }) }) }} /> : null}
          {!active ? <Button busy={busy} onClick={() => { save(true) }}>{t('设为当前文风', 'Make active')}</Button> : null}
          <Button variant="primary" busy={busy} pending={t('正在保存…', 'Saving…')} disabled={!dirty} onClick={() => { save() }}>{t('保存', 'Save')}</Button>
        </div>
      </header>
      <div className="nv-form-grid">
        <Field label={t('名称', 'Name')}><TextInput value={draft.name} onChange={(event) => { set('name', event.target.value) }} /></Field>
        <Field label={t('叙事视角', 'Point of view')}>
          <Select value={draft.pov ?? 'third-limited'} options={options(POV_LABELS, t)} onChange={(value) => { set('pov', value) }} />
        </Field>
        <Field label={t('时态', 'Tense')}>
          <Select value={draft.tense ?? 'past'} options={[{ value: 'past', label: t('过去时', 'Past') }, { value: 'present', label: t('现在时', 'Present') }]} onChange={(value) => { set('tense', value) }} />
        </Field>
      </div>
      <Field label={t('基调', 'Tone')}><TextArea {...text('tone')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('用词', 'Diction')}><TextArea {...text('diction')} /></Field>
        <Field label={t('节奏', 'Rhythm')}><TextArea {...text('rhythm')} /></Field>
        <Field label={t('意象与修辞', 'Imagery')}><TextArea {...text('imagery')} /></Field>
        <Field label={t('对白', 'Dialogue')}><TextArea {...text('dialogue')} /></Field>
      </div>
      <Field label={t('推进方式', 'Pacing')}><TextArea {...text('pacing')} /></Field>
      <div className="nv-form-grid">
        <Field label={t('必须做到', 'Always')} hint={t('每行一条', 'One per line')}><TextArea value={(draft.rules ?? []).join('\n')} minRows={4} onChange={(event) => { set('rules', lines(event.target.value)) }} /></Field>
        <Field label={t('必须避免', 'Never')} hint={t('禁用词、套路、"AI 味"', 'Banned words, clichés, machine tics')}><TextArea value={(draft.avoid ?? []).join('\n')} minRows={4} onChange={(event) => { set('avoid', lines(event.target.value)) }} /></Field>
      </div>
      <Field label={t('范文', 'Samples')} hint={t('用空行分隔多段；只用来体会笔触', 'Separate passages with a blank line; they show the touch only')}>
        <TextArea value={(draft.exemplars ?? []).map(item => item.text).join('\n\n')} minRows={4} maxRows={18} onChange={(event) => { set('exemplars', event.target.value.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean).map(item => ({ text: item }))) }} />
      </Field>
      <Field label={t('补充说明', 'Further notes')}><TextArea {...text('body')} /></Field>

      <SectionTitle>{t('试写', 'Try it')}</SectionTitle>
      <div className="nv-assist">
        <TextInput value={scene} placeholder={t('试写的场景（可留空）', 'A scene to try (optional)')} onChange={(event) => { setScene(event.target.value) }} />
        <Button icon="feather" busy={assist.running} pending={t('正在试写…', 'Writing a sample…')} onClick={() => {
          setPreview('')
          assist.start(async (onText) => {
            const info = await controller.run('style.sample', { root, draft: payload, ...(scene.trim().length > 0 ? { scene: scene.trim() } : {}) }, (streamed) => { onText(streamed); setPreview(streamed) })
            const final = (info.result?.output as { text?: string } | undefined)?.text
            if (final !== undefined) setPreview(final)
          })
        }}>{t('用这个文风写一段', 'Write a sample')}</Button>
      </div>
      {preview.length > 0 ? <div className="nv-prose nv-sample">{preview.split('\n').filter(line => line.trim().length > 0).map((line, index) => <p key={index}>{line}</p>)}</div> : <p className="nv-muted nv-small">{t('改完文风后试写一段，听听笔触对不对，再保存。', 'After editing, write a sample to hear whether the touch is right before saving.')}</p>}
      {confirm.element}
      <span hidden><Icon name="feather" /></span>
    </div>
  )
}

/** A character's further looks (outfits): each has its own design sheet, derived from the main one. */
function LooksEditor({ value, dirty, busy, onChange, onDraw }: { value: CharacterLook[]; dirty: boolean; busy: boolean; onChange: (looks: CharacterLook[]) => void; onDraw: (look: CharacterLook) => unknown }) {
  const t = useT()
  const patch = (index: number, change: Partial<CharacterLook>): void => { onChange(value.map((look, at) => (at === index ? { ...look, ...change } : look))) }
  return (
    <div className="nv-looks">
      <SectionTitle actions={<Button size="sm" variant="ghost" icon="plus" onClick={() => { onChange([...value, { id: `look-${Date.now().toString(36)}`, name: '' }]) }}>{t('添加造型', 'Add a look')}</Button>}>{t('造型（服饰）', 'Looks (outfits)')}</SectionTitle>
      {value.length === 0 ? <p className="nv-muted nv-small">{t('人物有不止一身行头时在这里添加：日常、戎装、丧服……每套造型从主人设图衍生出自己的人设图，所以换了衣服还是同一个人。画某一场戏时，会按场合选用。', 'Add a look when a character has more than one outfit: everyday, armour, mourning… Each look gets a sheet derived from the main one, so it is still the same person. A scene picks the look that fits its occasion.')}</p> : null}
      {value.map((look, index) => (
        <div key={look.id} className="nv-look">
          {look.sheet !== undefined ? <ProjectImage className="nv-look-thumb" path={look.sheet} alt={look.name} /> : <span className="nv-look-thumb nv-look-empty">{t('未画', 'none')}</span>}
          <div className="nv-look-fields">
            <div className="nv-form-grid">
              <Field label={t('名称', 'Name')}><TextInput value={look.name} placeholder={t('如：丧服', 'e.g. mourning dress')} onChange={(event) => { patch(index, { name: event.target.value }) }} /></Field>
              <Field label={t('什么时候穿', 'When it is worn')}><TextInput value={look.when ?? ''} placeholder={t('如：葬礼与守灵', 'e.g. funerals and wakes')} onChange={(event) => { patch(index, { when: event.target.value }) }} /></Field>
            </div>
            <Field label={t('这套造型换了什么', 'What this look changes')} hint={t('只写与主造型不同的地方：衣着、装备、头发的梳法', 'Only what differs from the main look: clothing, gear, how the hair is worn')}>
              <TextArea value={look.prompt ?? ''} onChange={(event) => { patch(index, { prompt: event.target.value }) }} />
            </Field>
            <div className="nv-row-wrap">
              <Button size="sm" icon="users" disabled={dirty || busy || look.name.trim().length === 0 || (look.prompt ?? '').trim().length === 0} pending={t('正在画这套造型…', 'Drawing this look…')} title={dirty ? t('先保存人物卡', 'Save the card first') : undefined} onClick={() => onDraw(look)}>{t('画这套造型的人设图', 'Draw this look\'s sheet')}</Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => { onChange(value.filter((_, at) => at !== index)) }}>{t('移除', 'Remove')}</Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

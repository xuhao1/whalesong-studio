// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Settings shared by every book.
 *
 * Two ways in, on one page: the one-click cards at the top set a whole service
 * up from a single key, and below them every slot. The text roles choose among
 * DSH's models; the crew section says which of them work as agents and with
 * what tools; retrieval, images and speech — the models that are the Studio's
 * own to configure — each name their service, endpoint, key and model. Keys are
 * typed here and saved with everything else; they go to the Harness credential
 * store, never into the settings file.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { EndpointCheck, EndpointModel, KeyState, ModelKind, ModelOption, ProviderOption, SettingsView as SettingsData } from '../../shared/rpc'
import { ASPECTS, DEFAULT_ART_STYLE, KIND_ASPECT, PICTURE_KINDS, PICTURE_TIERS, pictureSize, pixelSize, type PictureKind, type PictureTier } from '../../shared/art'
import { FFMPEG_INSTALL } from '../../shared/text'
import { OutsideHelp } from '../OutsideHelp'
import { RecommendedCard } from '../Recommended'
import { ReaderSettings, usePlayerOptions, useReaderPrefs } from '../reader/parts'
import { providerDefault } from '../../shared/recommended'
import {
  bailianRealtime, compatibleBase, DIRECT_EFFORTS, hostOf, originOf, recommendedSetup, SERVICES, serviceOf, speechProtocol, type ServiceId,
} from '../../shared/services'
import {
  CREW_ROLES,
  type CodexBridgeKind, type CrewRole, type CrewRoleSettings, type CrewSettings, type EmbeddingSettings, type ImageSettings, type ModelRoute, type NovelSettings, type SoundProviderKind, type SoundSettings, type TextModelRouting, type TextRole, type TtsProviderKind, type TtsSettings,
} from '../../shared/types'
import { PARALLEL_DEFAULT, PARALLEL_MAX, PLAY_CONTEXT_DEFAULT, REFERENCES_DEFAULT, REFERENCES_MAX, type SoundSettings as SoundDraft } from '../../shared/types'
import { messageOf } from '../api'
import { Icon } from '../icons'
import {
  Button, Chip, Combo, cx, Field, SectionTitle, Select, Spinner, TextArea, TextInput, useAction, useKept, useLoad, useSnapshot, useStudio, useT, type ComboOption, type Translate,
} from '../ui'
import { QuickSetup, Readiness, Signature } from './Setup'

const ROLES: { role: TextRole; label: [string, string]; hint: [string, string] }[] = [
  { role: 'writer', label: ['写手', 'Writer'], hint: ['写正文、续写、改写。选文笔最好的模型——不必是最"聪明"的那个。写手只写，不调用工具。', 'Drafts, continues and rewrites prose. Pick the best stylist, not necessarily the smartest model. The writer only writes; it calls no tools.'] },
  { role: 'analyst', label: ['场记', 'Continuity'], hint: ['收录记忆、审校、整理导入的书稿。选快而稳、读得细的模型。', 'Digests chapters, reviews them, takes in manuscripts. Pick something fast, literal and attentive.'] },
  { role: 'architect', label: ['策划', 'Planner'], hint: ['推演大纲与节拍、起草设定、假设分支、查资料。选推理强的模型。', 'Derives outlines and beats, drafts the bible, explores what-ifs, researches. Pick a strong reasoner.'] },
  { role: 'director', label: ['导演', 'Director'], hint: ['有声脚本、分镜、幕间演绎的实时回合。选响应快、守得住格式的模型。', 'Audio scripts, storyboards, the real-time turns of an interlude. Pick a responsive model that keeps to a format.'] },
  { role: 'producer', label: ['后期', 'Post-production'], hint: ['把配音、音效和分镜画面剪成视频：自己写脚本、跑命令、看结果。选写代码最稳的模型。', 'Cuts voice, sound and storyboard pictures into a video: writes its own script, runs it, checks the result. Pick the model that codes most reliably.'] },
]

const SEPARATOR = ' :: '
const keyOf = (route: Pick<ModelRoute, 'provider' | 'model'>): string => `${route.provider}${SEPARATOR}${route.model}`

function number(text: string): number | undefined {
  const value = Number(text)
  return text.trim().length > 0 && Number.isFinite(value) ? value : undefined
}

/** A patch that also clears what the draft no longer has. */
function sectionPatch<T extends object>(before: T, after: T): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = (after as Record<string, unknown>)[key]
    patch[key] = value === undefined || value === '' ? null : value
  }
  return patch
}

/**
 * How a role of the crew works, as one choice: as an agent with the tools its
 * work calls for, as an agent with everything the conversation has, or by
 * plain calls. (Kept as two settings — `mode` and `tools` — because the second
 * means nothing without the first.)
 */
type CrewWay = 'own' | 'all' | 'call'

const CREW_WAYS: { value: CrewWay; label: [string, string] }[] = [
  { value: 'own', label: ['agent 模式（默认，内部工具）', 'Agent, with its own tools (default)'] },
  { value: 'all', label: ['agent 模式（所有工具）', 'Agent, with all tools'] },
  { value: 'call', label: ['非 agent 模式', 'Not an agent: plain calls'] },
]

const CREW_WAY_HINT: [string, string] = [
  '内部工具：工坊给这个角色的工具，外加它的活用得上的少数几样（策划联网搜索、后期用命令行）。所有工具：对话里装了的它都有——命令行、读写文件、联网、MCP……按当前对话的权限模式运行。非 agent：一问一答，快而省，但看不到书里别处，也没有工具。无论哪一种，书稿本身只能通过工坊的工具改动。',
  'Its own tools: what the Studio gives the role, and the few of the conversation\'s that its work calls for (the planner searches the web, post-production has a shell). All tools: whatever the conversation has — the shell, files, the web, MCP… — under the conversation\'s permission mode. Not an agent: one question, one answer; faster and cheaper, but blind to the rest of the book and without tools. Whichever it is, the book itself changes only through the Studio\'s own tools.',
]

/** What a role's settings come to; what they leave unsaid is taken from `under` (the settings for every book), then from the built-in default. */
function crewWay(set: CrewRoleSettings | undefined, under?: CrewRoleSettings): CrewWay {
  const mode = set?.mode ?? under?.mode ?? 'agent'
  const tools = set?.tools ?? under?.tools ?? 'own'
  return mode === 'call' ? 'call' : tools === 'all' ? 'all' : 'own'
}

/**
 * A role's settings with a way of working put in; `''` takes the choice out.
 * @param spelled - say the default too: in a book's own settings, unsaid means "as for every book".
 */
function withCrewWay(set: CrewRoleSettings | undefined, way: CrewWay | '', spelled: boolean): CrewRoleSettings {
  const { mode: _mode, tools: _tools, ...kept } = set ?? {}
  if (way === '') return kept
  if (way === 'call') return { ...kept, mode: 'call' }
  if (spelled) return { ...kept, mode: 'agent', tools: way }
  return way === 'all' ? { ...kept, tools: 'all' } : kept
}

/** A number of parallel requests as typed: within range, or nothing for an empty field (the default then applies). */
function parallel(text: string): number | undefined {
  const value = number(text)
  return value !== undefined && value >= 1 ? Math.min(PARALLEL_MAX, Math.round(value)) : undefined
}

/** A count of tokens in a few characters: 500K, 1M. */
function compact(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens)
}

const ROLE_NAME: Record<string, [string, string]> = {
  writer: ['写手', 'Writer'],
  architect: ['策划', 'Planner'],
  analyst: ['场记', 'Continuity'],
  director: ['导演', 'Director'],
  producer: ['后期', 'Post-production'],
}

function without<T extends object, K extends keyof T>(value: T, key: K, next: T[K] | undefined): T {
  const { [key]: _old, ...rest } = value
  return (next === undefined || next === '' ? rest : { ...rest, [key]: next }) as T
}

/** Keys typed on this page and not saved yet, by the host they are for. */
type TypedKeys = Record<string, { url: string; value: string }>

interface KeyBag {
  typed: TypedKeys
  set(url: string, value: string): void
  view: SettingsData
}

export function SettingsView() {
  const { controller } = useStudio()
  const t = useT()
  const view = useSnapshot(snapshot => snapshot.settings)
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    controller.loadSettings().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [controller])
  if (view === undefined) return <div className="nv-center">{error !== undefined ? <p className="nv-muted">{error}</p> : <Spinner size={18} />}</div>
  // The form is made anew when the settings under it change — not when only what is noted about the recommendations does: a switch there must not cost a half-filled form.
  return <SettingsForm key={JSON.stringify({ ...view.settings, recommended: undefined })} view={view} t={t} />
}

/** The reader's own settings, where the Studio's other settings are: the same panel, the same store. */
function ReadingPanel({ t }: { t: Translate }) {
  const [prefs, update] = useReaderPrefs()
  const [options, updateOptions] = usePlayerOptions()
  return <ReaderSettings prefs={prefs} update={update} options={options} updateOptions={updateOptions} t={t} />
}

function SettingsForm({ view, t }: { view: SettingsData; t: Translate }) {
  const { controller } = useStudio()
  const [draft, setDraft] = useState<NovelSettings>(view.settings)
  const [typed, setTyped] = useState<TypedKeys>({})
  const [dirty, setDirty] = useState(false)
  const [quick, setQuick] = useState(false)
  // The page starts short: what most authors set. Everything else is one switch away, and stays out once it is on.
  const [advanced, setAdvanced] = useKept<boolean>('settings.advanced', false)
  const [unfolded, setUnfolded] = useKept<Record<string, boolean>>('settings.unfolded', {})
  const fold = (id: string): { open: boolean; toggle: () => void } => ({ open: unfolded[id] === true, toggle: () => { setUnfolded(previous => ({ ...previous, [id]: previous[id] !== true })) } })
  // Where the text models and the crew's ways are saved: for every book, or with the book that is open.
  const book = useSnapshot(snapshot => snapshot.project?.manifest)
  const bookRoot = useSnapshot(snapshot => snapshot.root)
  const [wanted, setScope] = useKept<'global' | 'book'>('settings.scope', 'global')
  const scope: 'global' | 'book' = wanted === 'book' && book !== undefined && bookRoot !== undefined ? 'book' : 'global'
  const [own, setOwn] = useState<{ models: Partial<TextModelRouting>; crew: CrewSettings }>(() => ({ models: book?.models ?? {}, crew: book?.crew ?? {} }))
  const [ownDirty, setOwnDirty] = useState(false)
  const bookHasOwn = book !== undefined && (Object.keys(book.models ?? {}).length > 0 || Object.values(book.crew ?? {}).some(value => value !== undefined && Object.keys(value).length > 0))
  const updateOwn = (patch: Partial<{ models: Partial<TextModelRouting>; crew: CrewSettings }>): void => {
    setOwn(previous => ({ ...previous, ...patch }))
    setOwnDirty(true)
  }
  const bookTitle = book?.title.replace(/^[《「『“"]+|[》」』”"]+$/gu, '') ?? ''
  const { busy, run } = useAction()
  // A link here can ask for one part of the page ("speech is not set up" leads to the speech section).
  const focus = useSnapshot(snapshot => snapshot.settingsFocus)
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus === undefined) return
    // What a link points at may be folded away or among the advanced options: opened first, found after.
    const part: string = focus
    if (part === 'crew' || part === 'parallel' || part === 'context') setAdvanced(true)
    if (part === 'image' || part === 'tts' || part === 'sound' || part === 'embedding') setUnfolded(previous => ({ ...previous, [part]: true }))
    const timer = setTimeout(() => {
      const target = page.current?.querySelector(`[data-section="${focus}"]`)
      if (target !== null && target !== undefined) {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' })
        target.classList.add('is-focus')
        setTimeout(() => { target.classList.remove('is-focus') }, 2400)
      }
    }, 60)
    controller.consumeSettingsFocus()
    return () => { clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, focus])
  const update = (patch: Partial<NovelSettings>): void => {
    setDraft(previous => ({ ...previous, ...patch }))
    setDirty(true)
  }
  const keys: KeyBag = {
    typed,
    view,
    set: (url, value) => {
      const host = hostOf(url)
      if (host === undefined) return
      setTyped((previous) => {
        const { [host]: _old, ...rest } = previous
        return value.length > 0 ? { ...rest, [host]: { url, value } } : rest
      })
      setDirty(true)
    },
  }
  const save = (): Promise<unknown> => run(async () => {
    // What was set for the book goes into the book: its novel.json travels with it.
    if (ownDirty && bookRoot !== undefined) {
      const crew = Object.fromEntries(Object.entries(own.crew).filter(([, value]) => value !== undefined && Object.keys(value).length > 0))
      await controller.api.call('project.update', { root: bookRoot, patch: { models: own.models, crew } })
      setOwnDirty(false)
      if (!dirty) {
        controller.toast('success', t(`已保存到《${bookTitle}》`, `Saved with "${bookTitle}"`))
        return
      }
    }
    await controller.saveSettings({
      models: sectionPatch(view.settings.models, draft.models),
      context: sectionPatch(view.settings.context, draft.context),
      image: sectionPatch(view.settings.image, draft.image),
      tts: sectionPatch(view.settings.tts, draft.tts),
      sound: sectionPatch(view.settings.sound ?? { provider: 'auto' }, draft.sound ?? { provider: 'auto' }),
      embedding: sectionPatch(view.settings.embedding, draft.embedding),
      crew: sectionPatch(view.settings.crew ?? {}, draft.crew ?? {}),
      textConcurrency: draft.textConcurrency ?? null,
      autoDigest: draft.autoDigest,
      reviewAgentRevisions: draft.reviewAgentRevisions,
      agentFiles: draft.agentFiles ?? 'guide',
    }, Object.fromEntries(Object.values(typed).map(entry => [entry.url, entry.value.trim()])))
    controller.toast('success', t('设置已保存', 'Settings saved'))
  })

  /** The model of a role as the page holds it: the book's own, or the one for every book. */
  const routeOf = (role: TextRole): ModelRoute | undefined => (scope === 'book' ? own.models[role] : draft.models[role])
  // One model for the whole crew is the usual case; a crew whose roles differ is shown as such.
  const crewSame = CREW_ROLES.every(role => JSON.stringify(routeOf(role) ?? null) === JSON.stringify(routeOf(CREW_ROLES[0]!) ?? null))
  // The same for how they work: one choice for all four, said as "differs" when they do.
  const inBook = scope === 'book'
  const said = (role: CrewRole): boolean => own.crew[role]?.mode !== undefined || own.crew[role]?.tools !== undefined
  const wayOf = (role: CrewRole): CrewWay | '' => (inBook ? (said(role) ? crewWay(own.crew[role], draft.crew?.[role]) : '') : crewWay(draft.crew?.[role]))
  const crewWays = CREW_ROLES.map(wayOf)
  const crewWayNow: CrewWay | '' | 'mixed' = crewWays.every(way => way === crewWays[0]) ? crewWays[0]! : 'mixed'
  const everywhereWays = CREW_ROLES.map(role => crewWay(draft.crew?.[role]))
  const everywhereWay = everywhereWays.every(way => way === everywhereWays[0]) ? t(...CREW_WAYS.find(item => item.value === everywhereWays[0])!.label) : t('各角色不同', 'differs by role')
  const setCrewWay = (way: CrewWay | ''): void => {
    const table: CrewSettings = (inBook ? own.crew : draft.crew) ?? {}
    const next: CrewSettings = {}
    for (const role of CREW_ROLES) {
      const set = withCrewWay(table[role], way, inBook)
      if (Object.keys(set).length > 0) next[role] = set
    }
    if (inBook) updateOwn({ crew: next })
    else update({ crew: next })
  }
  // A role whose model cannot drive an agent works by plain calls whatever is chosen here: said, not found out later.
  const unable = view.crew !== undefined ? view.crew.roles.filter(item => (CREW_ROLES as readonly string[]).includes(item.role) && !(item.agent && view.crew!.loop)) : []
  const roleRow = (role: TextRole, label: string, hint: string): ReactNode => {
    const global = draft.models[role]
    return (
      <RoleRow
        key={`${scope}:${role}`}
        role={role}
        label={label}
        hint={hint}
        route={routeOf(role)}
        models={view.models}
        // A Host that has not restarted since an update does not send the provider list yet.
        providers={view.providers ?? []}
        fallback={view.defaultRoute}
        keys={keys}
        t={t}
        {...(scope === 'book' ? { unset: t(`沿用全局设置（${global !== undefined ? global.model : '跟随对话模型'}）`, `As set for every book (${global !== undefined ? global.model : 'follows the chat model'})`) } : {})}
        onChange={(route) => {
          if (scope === 'book') {
            const { [role]: _old, ...rest } = own.models
            updateOwn({ models: route !== undefined ? { ...rest, [role]: route } : rest })
            return
          }
          const { [role]: _old, ...rest } = draft.models
          update({ models: route !== undefined ? { ...rest, [role]: route } : rest })
        }}
      />
    )
  }

  return (
    <div className="nv-page nv-settings" ref={page}>
      <header className="nv-settings-head">
        <div>
          <h2>{t('小说工坊设置', 'Novel Studio settings')}</h2>
          <p className="nv-muted nv-small">{t('默认对所有作品生效；模型可以改成只跟着当前这本书。常用的就这几项——其余的在右上角的“高级选项”里。', 'Applies to every book; the models can be set for the open book alone. This is what is usually set — the rest is under Advanced, top right.')}</p>
        </div>
        <div className="nv-row-wrap">
          <Button variant="ghost" icon="clock" onClick={() => { controller.setView('usage') }}>{t('用量与成本', 'Usage and cost')}</Button>
          <label className="nv-check nv-advanced-switch" title={t('逐个角色的模型、工作方式与工具，并发，上下文预算，各类图片的比例……', 'A model, a way of working and tools per role; how much at once; context budgets; the shape of each kind of picture…')}>
            <input type="checkbox" checked={advanced} onChange={(event) => { setAdvanced(event.target.checked) }} />
            <span>{t('高级选项', 'Advanced')}</span>
          </label>
          <Button variant="primary" busy={busy} disabled={!dirty && !ownDirty} onClick={save}>{t('保存', 'Save')}</Button>
        </div>
      </header>

      <Readiness view={view} t={t} />

      <section className="nv-card">
        <SectionTitle actions={(
          <>
            <Button size="sm" variant="ghost" icon="sparkles" onClick={() => { controller.setView('setup') }}>{t('引导页', 'Guide')}</Button>
            <Button size="sm" variant="ghost" icon={quick ? 'chevronUp' : 'chevronDown'} onClick={() => { setQuick(value => !value) }}>{quick ? t('收起', 'Hide') : t('展开', 'Show')}</Button>
          </>
        )}>{t('一键配置', 'One-click setup')}</SectionTitle>
        <p className="nv-muted nv-small">{t('贴一个 key，按推荐把插图、配音、检索一次配好（文字模型不在这里配：它们来自 DSH）。之后仍可在下面逐项修改。', 'Paste one key and get images, speech and retrieval set up as recommended (text models are not set up here: they come from DSH). Everything stays editable below.')}</p>
        {quick || view.setupNeeded ? <QuickSetup view={view} services={['bailian', 'openrouter', 'openai']} /> : (
          <div className="nv-row-wrap">
            {(['bailian', 'openrouter', 'openai'] as const).map(service => <Button key={service} size="sm" onClick={() => { setQuick(true) }}>{t(...SERVICES[service].name)}</Button>)}
            <Button size="sm" onClick={() => { setQuick(true) }}>{t('ChatGPT 订阅（Codex）', 'ChatGPT subscription (Codex)')}</Button>
          </div>
        )}
        <RecommendedCard view={view.recommended} />
      </section>

      <section className="nv-card" data-section="reading">
        <SectionTitle>{t('阅读体验', 'Reading')}</SectionTitle>
        <p className="nv-muted nv-small">{t('读和听的时候怎么显示、怎么播放。这就是阅读页上"阅读设置"的那个面板——在哪里调都是同一份；手机上、发布出去的网站上也是它，各自记在各自的设备上。', 'How a chapter is shown and played. This is the panel behind Reading in the reader\'s bar — one and the same wherever it is opened; a phone and a published site have it too, each kept on its own device.')}</p>
        <ReadingPanel t={t} />
      </section>

      <section className="nv-card" data-section="text">
        <SectionTitle>{t('模型', 'Models')}</SectionTitle>
        {book !== undefined ? (
          <div className="nv-scope">
            <span className="nv-scope-label">{t('模型的设置保存到', 'The models are saved')}</span>
            <div className="nv-segmented" role="radiogroup">
              <button type="button" role="radio" aria-checked={scope === 'global'} className={cx('nv-segment', scope === 'global' && 'is-active')} onClick={() => { setScope('global') }}>{t('全局：所有的书', 'for every book')}</button>
              <button type="button" role="radio" aria-checked={scope === 'book'} className={cx('nv-segment', scope === 'book' && 'is-active')} onClick={() => { setScope('book') }}>{t(`只跟这本书：《${bookTitle}》`, `with this book: "${bookTitle}"`)}</button>
            </div>
            <p className="nv-muted nv-small">{scope === 'book'
              ? t('这里设的写进这本书自己的 novel.json，书到哪里跟到哪里；没有单独设的角色沿用全局设置。插图、配音、检索的接口和密钥始终是全局的。', 'What is set here is written into this book\'s own novel.json and travels with it; a role not set here follows the Studio-wide settings. The endpoints and keys of pictures, speech and search are always Studio-wide.')
              : bookHasOwn
                ? t(`《${bookTitle}》有自己的设置，会盖过这里的全局设置——切到“只跟这本书”查看和修改。`, `"${bookTitle}" has settings of its own, which override the Studio-wide ones here — switch to "with this book" to see and change them.`)
                : t('这里设的对所有的书生效。想让当前这本书用不一样的模型或班底，切到“只跟这本书”。', 'What is set here applies to every book. To give the open book models or a crew of its own, switch to "with this book".')}</p>
          </div>
        ) : null}
        <p className="nv-muted nv-small">{t('文字模型都来自 DSH（在 DSH 的“设置 → 模型”里接入的都能选）。对话里的总编用的是会话自己选的模型；这里定的是替它干活的人用什么。', 'Text models all come from DSH (whatever is connected under DSH\'s Settings → Models can be chosen). The showrunner in the conversation runs on the conversation\'s own model; here you choose what those who work for it run on.')}</p>
        {advanced ? null : (
          <>
            {(() => {
              const item = ROLES.find(candidate => candidate.role === 'writer')!
              return roleRow(item.role, t('写手模型', 'The writer\'s model'), t(...item.hint))
            })()}
            <RoleRow
              key={`${scope}:crew`}
              role="architect"
              label={t('编排模型', 'The crew\'s model')}
              hint={crewSame
                ? t('场记、策划、导演、后期共用这一个：读得细、推理强、守得住格式、会用工具。想让它们各用各的，打开“高级选项”。', 'Continuity, the planner, the director and post-production share this one: a careful reader that reasons, keeps to a format and uses tools. To give each its own, switch on Advanced.')
                : t('现在四个角色用的不是同一个模型（在“高级选项”里逐个看）。在这里选一个，就把它们统一成这一个。', 'The four roles are not on one model now (see each under Advanced). Choose one here and all four are set to it.')}
              route={crewSame ? routeOf(CREW_ROLES[0]!) : undefined}
              models={view.models}
              providers={view.providers ?? []}
              fallback={view.defaultRoute}
              keys={keys}
              t={t}
              {...(!crewSame ? { unset: t('各角色不同——见高级选项', 'Differs by role — see Advanced') } : scope === 'book' ? { unset: t('沿用全局设置', 'As set for every book') } : {})}
              extra={view.crew !== undefined ? (
                <Field
                  label={t('agent 能力范围', 'What the crew may do')}
                  hint={`${t(...CREW_WAY_HINT)}${crewWayNow !== 'call' && unable.length > 0 ? t(` 现在有 ${unable.length} 个角色的模型当不了 agent（${unable.map(item => t(...(ROLE_NAME[item.role] ?? [item.role, item.role]))).join('、')}），它们会按普通调用干活——在“高级选项”里看原因。`, ` ${unable.length} of the roles have a model that cannot drive an agent now (${unable.map(item => t(...(ROLE_NAME[item.role] ?? [item.role, item.role]))).join(', ')}); they work by plain calls — Advanced says why.`) : ''}`}
                >
                  <Select<CrewWay | '' | 'mixed'>
                    value={crewWayNow}
                    options={[
                      ...(crewWayNow === 'mixed' ? [{ value: 'mixed' as const, label: t('各角色不同——见高级选项', 'Differs by role — see Advanced') }] : []),
                      ...(inBook ? [{ value: '' as const, label: t(`沿用全局设置：${everywhereWay}`, `As set for every book: ${everywhereWay}`) }] : []),
                      ...CREW_WAYS.map(item => ({ value: item.value, label: t(...item.label) })),
                    ]}
                    onChange={(way) => { if (way !== 'mixed') setCrewWay(way) }}
                  />
                </Field>
              ) : undefined}
              onChange={(route) => {
                const table = scope === 'book' ? own.models : draft.models
                const rest = Object.fromEntries(Object.entries(table).filter(([role]) => !(CREW_ROLES as readonly string[]).includes(role))) as Partial<TextModelRouting>
                const next = route !== undefined ? { ...rest, ...Object.fromEntries(CREW_ROLES.map(role => [role, route])) } : rest
                if (scope === 'book') updateOwn({ models: next })
                else update({ models: next as TextModelRouting })
              }}
            />
          </>
        )}
        {advanced ? ROLES.map((item) => {
          const role = item.role
          const crewRole = (CREW_ROLES as readonly string[]).includes(role) && view.crew !== undefined ? role as CrewRole : undefined
          if (crewRole === undefined) return <div key={role} className="nv-role-block">{roleRow(role, t(...item.label), t(...item.hint))}</div>
          return ((role: CrewRole) => {
            const info = view.crew!.roles.find(item => item.role === role)
            const everywhere = draft.crew?.[role] ?? {}
            const set = (scope === 'book' ? own.crew[role] : draft.crew?.[role]) ?? {}
            const change = (patch: Partial<CrewRoleSettings>): void => {
              const next: CrewRoleSettings = { ...set, ...patch }
              for (const key of Object.keys(next) as (keyof CrewRoleSettings)[]) if (next[key] === undefined) delete next[key]
              if (scope === 'book') updateOwn({ crew: { ...own.crew, [role]: next } })
              else update({ crew: { ...draft.crew, [role]: next } })
            }
            // In a book's own settings, "not set" means "as for every book"; Studio-wide it means the built-in default.
            const spoken = set.mode !== undefined || set.tools !== undefined
            const wayNow = crewWay(set, inBook ? everywhere : undefined)
            const able = info?.agent === true && view.crew!.loop
            return (
              <div key={role} className="nv-role-block" data-section={role === 'analyst' ? 'crew' : undefined}>
                {roleRow(role, t(...item.label), t(...item.hint))}
                <div className="nv-crew-head">
                  {wayNow === 'call'
                    ? <Chip tone="amber">{t('普通调用', 'Plain calls')}</Chip>
                    : able
                      ? <Chip tone="green">{t(`agent · ${info?.model ?? ''}`, `agent · ${info?.model ?? ''}`)}</Chip>
                      : <Chip tone="red" title={info?.direct === true ? t('它的模型是旧的直连接口，进不了 DSH 的 agent 循环', 'Its model is a directly called endpoint of the old kind and cannot run on DSH\'s agent loop') : t('这里没有可以驱动 agent 的模型', 'No model here can drive an agent')}>{info?.direct === true ? t('当不了 agent：旧的直连接口', 'Not an agent: direct endpoint') : t('当不了 agent：没有可用的 DSH 模型', 'Not an agent: no DSH model')}</Chip>}
                </div>
                <div className="nv-form-grid">
                  <Field
                    label={t('agent 能力范围', 'What it may do')}
                    hint={`${t(...CREW_WAY_HINT)}${info !== undefined && info.own.length > 0 ? t(` 这个角色的“内部工具”里，来自对话的是这几样（装了才有）：${info.own.join('、')}。`, ` Of the conversation's tools, this role's own are these (where present): ${info.own.join(', ')}.`) : ''}`}
                  >
                    <Select<CrewWay | ''>
                      value={inBook && !spoken ? '' : wayNow}
                      options={[
                        ...(inBook ? [{ value: '' as const, label: t(`沿用全局设置：${t(...CREW_WAYS.find(candidate => candidate.value === crewWay(everywhere))!.label)}`, `As set for every book: ${t(...CREW_WAYS.find(candidate => candidate.value === crewWay(everywhere))!.label)}`) }] : []),
                        ...CREW_WAYS.map(candidate => ({ value: candidate.value, label: t(...candidate.label) })),
                      ]}
                      onChange={(way) => {
                        const next = withCrewWay(set, way, inBook)
                        if (inBook) updateOwn({ crew: { ...own.crew, [role]: next } })
                        else update({ crew: { ...draft.crew, [role]: next } })
                      }}
                    />
                  </Field>
                  <Field label={t('最多几步', 'Step limit')} hint={t(`一次运行最多调用多少次工具；到了就让它收尾。留空用默认的 ${info?.steps ?? 40} 步。`, `How many tool calls one run may make before it is told to wrap up. Empty uses the default of ${info?.steps ?? 40}.`)}>
                    <TextInput inputMode="numeric" value={set.steps !== undefined ? String(set.steps) : ''} placeholder={String((inBook ? everywhere.steps : undefined) ?? info?.steps ?? 40)} onChange={(event) => { const value = number(event.target.value); change({ steps: value !== undefined && value >= 4 ? Math.round(value) : undefined }) }} />
                  </Field>
                </div>
              </div>
            )
          })(crewRole)
        }) : null}
        {advanced && view.crew !== undefined ? <p className="nv-muted nv-small">{t('四个角色都是 DSH 的 agent：总编或你把活交给它们时，每一次运行都是当前对话的一个子 agent，过程全程可查。“全部工具”包括命令行、读写文件、联网、MCP 等对话里装了的一切，按当前对话的权限模式运行（需要你批准的操作，子 agent 会被直接拒绝）。无论给多少工具，书稿本身都只能通过工坊的工具改动。', 'The four roles are agents of DSH: handed a piece of work by the showrunner or by you, each run is a child of the conversation, open to be watched. "All tools" covers the shell, files, the web, MCP and whatever else the conversation has, under the conversation\'s permission mode (what would need your approval is refused to a child agent outright). However many tools a role has, the book itself changes only through the Studio\'s own.')}</p> : null}
        {view.crew !== undefined ? (
          <div className="nv-crew-row">
            <div className="nv-crew-head">
              <strong>{t('外援', 'Outside help')}</strong>
              {view.crew.helpers === undefined ? (
                <>
                  <Chip tone={view.crew.help.claudeCode ? 'green' : 'neutral'}>{view.crew.help.claudeCode ? t('Claude Code 已接入', 'Claude Code connected') : t('Claude Code 未安装', 'Claude Code not installed')}</Chip>
                  <Chip tone={view.crew.help.codex ? 'green' : 'neutral'}>{view.crew.help.codex ? t('Codex 已接入', 'Codex connected') : t('Codex 未安装', 'Codex not installed')}</Chip>
                </>
              ) : null}
              <Chip tone={view.crew.ffmpeg ? 'green' : 'red'}>{view.crew.ffmpeg ? t('ffmpeg 可用', 'ffmpeg found') : t('没有 ffmpeg', 'no ffmpeg')}</Chip>
            </div>
            {view.crew.helpers !== undefined ? <OutsideHelp view={view.crew.helpers} /> : null}
            {view.crew.helpers === undefined ? <p className="nv-muted nv-small">{t('后期做不了的活可以转交给你自己的 Claude Code 或 Codex：在 DSH 的“设置 → 插件”里添加 @deepseek-ai/dsh-subagent-claude-code 或 @deepseek-ai/dsh-subagent-codex。（重启 DSH 后，这里会有一键安装。）', 'What post-production cannot do it can hand to your own Claude Code or Codex: add @deepseek-ai/dsh-subagent-claude-code or @deepseek-ai/dsh-subagent-codex under DSH\'s Settings → Plugins. (After DSH restarts, they install from here with one press.)')}</p> : null}
            {!view.crew.ffmpeg ? <p className="nv-note is-warn">{t(`剪视频和验收都要用 ffmpeg / ffprobe，这台电脑上没有找到。${FFMPEG_INSTALL[0]}。`, `Cutting and checking a video needs ffmpeg / ffprobe, and they were not found on this computer. ${FFMPEG_INSTALL[1]}.`)}</p> : null}
          </div>
        ) : null}
      </section>

      {advanced ? (
      <section className="nv-card" data-section="parallel">
        <SectionTitle>{t('并发：同时发出多少个请求', 'How much at once')}</SectionTitle>
        <p className="nv-muted nv-small">{t(`每一类请求同时最多发出多少个——不管是哪一章、哪个任务在用，都算在一起。默认 ${PARALLEL_DEFAULT}，最多 ${PARALLEL_MAX}。服务回答“太快了”（限流）时，工坊会自己降速、等一等、把被拒的请求重发，通顺后再升回来，所以数字可以放心往大了填；真正的上限是你的账号在那个服务上的限额。`, `How many requests of each kind go out at once — over every chapter and every job together. ${PARALLEL_DEFAULT} by default, ${PARALLEL_MAX} at most. When a service answers "too fast", the Studio slows down by itself, waits, sends what was refused again, and climbs back once requests go through — so a high number is safe to set; the real limit is what your account is allowed on that service.`)}</p>
        <div className="nv-form-grid">
          <Field label={t('语音：同时合成几句', 'Speech: lines at once')}>
            <TextInput inputMode="numeric" value={draft.tts.concurrency !== undefined ? String(draft.tts.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { update({ tts: without(draft.tts, 'concurrency', parallel(event.target.value)) }) }} />
          </Field>
          <Field label={t('图片：同时画几张', 'Images: pictures at once')}>
            <TextInput inputMode="numeric" value={draft.image.concurrency !== undefined ? String(draft.image.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { update({ image: without(draft.image, 'concurrency', parallel(event.target.value)) }) }} />
          </Field>
          <Field label={t('声音：同时生成几处', 'Sound: clips at once')} hint={(draft.sound?.provider ?? 'auto') === 'auto' ? t('声音沿用语音的模型时，和语音共用上面那个数', 'While sound rides on the speech model, it shares the speech number') : undefined}>
            <TextInput inputMode="numeric" value={draft.sound?.concurrency !== undefined ? String(draft.sound.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} disabled={(draft.sound?.provider ?? 'auto') === 'auto'} onChange={(event) => { update({ sound: without<SoundDraft, 'concurrency'>(draft.sound ?? { provider: 'auto' }, 'concurrency', parallel(event.target.value)) }) }} />
          </Field>
          <Field label={t('文字：同时进行几件活', 'Text: pieces of work at once')} hint={t('一件活 = 某个角色做的一段脚本、一章收录、一章审校、一章节拍……', 'A piece of work = a role\'s run on a script passage, a digest, a review, a chapter\'s beats…')}>
            <TextInput inputMode="numeric" value={draft.textConcurrency !== undefined ? String(draft.textConcurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { const value = parallel(event.target.value); setDraft(({ textConcurrency: _old, ...rest }) => (value !== undefined ? { ...rest, textConcurrency: value } : rest)); setDirty(true) }} />
          </Field>
        </div>
      </section>
      ) : null}

      {advanced ? (
      <section className="nv-card" data-section="context">
        <SectionTitle>{t('上下文与记忆', 'Context and memory')}</SectionTitle>
        <p className="nv-muted nv-small">{t('写一章时，模型读到的“前文”分两层：离这一章最近的若干整章原文，和更早章节的梗概。原文按整章取，默认占模型窗口的一半；重写中间的章节时，后面已经写好的章节也会一起给它。原文的排列不随章节变化、只在末尾追加，所以连续写作时模型服务端的缓存能命中绝大部分输入。', 'When a chapter is written, the model reads the story so far in two layers: the nearest chapters word for word, and the ones before them as an outline. The text is taken in whole chapters and gets half of the model\'s window by default; a chapter in the middle that is written again is given the chapters after it too. The text is laid out the same from chapter to chapter and only grows at its end, so a provider\'s cache covers most of the input while chapters are written one after the other.')}</p>
        <div className="nv-form-grid">
          <Field label={t('前文怎么给', 'How the story so far travels')}>
            <Select value={draft.context.strategy} options={[
              { value: 'auto', label: t('梗概 + 尽量多的整章原文（推荐）', 'Outline + as many whole chapters as fit (recommended)') },
              { value: 'full', label: t('原文能塞多少塞多少（用满窗口）', 'As much text as the window holds at all') },
              { value: 'retrieval', label: t('不带整章：梗概 + 检索片段（最省）', 'No whole chapter: outline + looked-up passages (cheapest)') },
            ]} onChange={(value) => { update({ context: { ...draft.context, strategy: value } }) }} />
          </Field>
          <Field label={t('前文原文的预算（tokens）', 'Budget for the text itself (tokens)')} hint={t('留空：模型窗口的一半。填了就按这个数（不会超过窗口放得下的量），按整章取。', 'Empty: half of the model\'s window. A figure is used as given (never more than the window can hold), in whole chapters.')}>
            <TextInput inputMode="numeric" value={draft.context.budgetTokens !== undefined ? String(draft.context.budgetTokens) : ''} placeholder={t('窗口的一半', 'half the window')} disabled={draft.context.strategy !== 'auto'} onChange={(event) => { const value = number(event.target.value); update({ context: without(draft.context, 'budgetTokens', value !== undefined && value > 0 ? Math.max(2000, Math.round(value)) : undefined) }) }} />
          </Field>
          <Field label={t('没有整章时带上的上文（字符）', 'Preceding text when no chapter is whole (characters)')} hint={t('只在不带整章原文时用：上一章结尾原样带上的长度', 'Only when no whole chapter travels: how much of the end of the chapter before is carried word for word')}>
            <TextInput inputMode="numeric" value={String(draft.context.tailChars)} onChange={(event) => { const value = number(event.target.value); if (value !== undefined) update({ context: { ...draft.context, tailChars: Math.max(0, Math.round(value)) } }) }} />
          </Field>
          <Field label={t('设定、线索、检索片段一共占多少（tokens）', 'Bible, threads and looked-up passages together (tokens)')} hint={t('留空：模型窗口的 22%，最多 12 万。人物卡、世界观、未回收线索、检索到的旧段落都从这里分；不够时先裁龙套和远的线索。', 'Empty: 22% of the model\'s window, 120k at most. Character cards, the world, open threads and looked-up passages share it; when it runs short, walk-ons and distant threads go first.')}>
            <TextInput inputMode="numeric" value={draft.context.sideTokens !== undefined ? String(draft.context.sideTokens) : ''} placeholder={t('窗口的 22%', '22% of the window')} onChange={(event) => { const value = number(event.target.value); const { sideTokens: _old, ...rest } = draft.context; update({ context: value !== undefined && value > 0 ? { ...rest, sideTokens: Math.round(value) } : rest }) }} />
          </Field>
          <Field label={t('幕间每一回合带多少上下文（tokens）', 'Context of each turn of an interlude (tokens)')} hint={t(`留空：${PLAY_CONTEXT_DEFAULT.toLocaleString()}。幕间要回得快，所以比写正文带得少；觉得导演记不住前面的事就调大。`, `Empty: ${PLAY_CONTEXT_DEFAULT.toLocaleString()}. An interlude has to answer fast, so it carries less than drafting does; raise it when the director forgets what came before.`)}>
            <TextInput inputMode="numeric" value={draft.context.playTokens !== undefined ? String(draft.context.playTokens) : ''} placeholder={String(PLAY_CONTEXT_DEFAULT)} onChange={(event) => { const value = number(event.target.value); const { playTokens: _old, ...rest } = draft.context; update({ context: value !== undefined && value > 0 ? { ...rest, playTokens: Math.round(value) } : rest }) }} />
          </Field>
        </div>
        {view.context !== undefined && view.context.length > 0 ? (
          <div className="nv-context-rows">
            <span className="nv-muted nv-small">{t('按已保存的设置，各角色现在是：', 'With the settings as saved, each role gets:')}</span>
            {view.context.map(row => (
              <Chip key={row.role} tone={row.window !== undefined ? 'blue' : 'amber'} title={row.window === undefined ? t('没有识别出这个模型的窗口，按 20 万算', 'This model\'s window is not known; 200k is assumed') : undefined}>
                {t(...(ROLE_NAME[row.role] ?? [row.role, row.role]))}{row.model !== undefined ? ` · ${row.model}` : ''} · {t(`窗口 ${compact(row.window ?? 200_000)} → 原文 ${compact(row.textBudget)}`, `window ${compact(row.window ?? 200_000)} → text ${compact(row.textBudget)}`)}
              </Chip>
            ))}
          </div>
        ) : null}
        <label className="nv-check">
          <input type="checkbox" checked={draft.autoDigest} onChange={(event) => { update({ autoDigest: event.target.checked }) }} />
          <span>{t('写完或改完一章后自动收录记忆（摘要、事实、人物状态、线索）', 'Digest a chapter automatically after it is written or revised (summary, facts, character states, threads)')}</span>
        </label>
        <label className="nv-check">
          <input type="checkbox" checked={draft.reviewAgentRevisions} onChange={(event) => { update({ reviewAgentRevisions: event.target.checked }) }} />
          <span>{t('总编发起的正文修订先作为提案，等我确认后才生效', 'Revisions requested by the showrunner wait as proposals until I accept them')}</span>
        </label>
        <Field label={t('总编想绕过工坊、直接用文件工具改书的文件时', 'When the showrunner reaches for a book\'s files with raw file tools')} hint={t('总编改书有专门的工具（改稿、改设定、改大纲、修正记忆），每一次改动都会留版本、重新收录记忆、记进"改动记录"。绕过它们直接写文件，这些就都对不上了。无论选哪一项，工坊之外的改动事后都会被发现并记录。', 'The showrunner has a tool for every kind of change — text, bible, outline, memory — and each keeps a version, digests memory again and puts the change on the record. A file written around them leaves all of that out of step. Whatever is chosen here, a change from outside is noticed and recorded afterwards.')}>
          <Select<'guide' | 'ask' | 'allow'> value={draft.agentFiles ?? 'guide'} options={[
            { value: 'guide', label: t('拦下，并告诉它该用哪个工具（推荐）', 'Refuse, and name the tool to use (recommended)') },
            { value: 'ask', label: t('每次问我', 'Ask me each time') },
            { value: 'allow', label: t('放行，事后对账', 'Let it through, reconcile afterwards') },
          ]} onChange={(agentFiles) => { update({ agentFiles }) }} />
        </Field>
      </section>
      ) : null}

      <Fold id="image" title={t('图像生成', 'Image generation')} summary={draft.image.provider === 'none' ? t('未使用', 'off') : `${draft.image.provider === 'codex' ? t('ChatGPT 订阅', 'ChatGPT subscription') : draft.image.model ?? draft.image.provider}${view.ready.image ? '' : t(' · 还不能用', ' · not ready')}`} ready={view.ready.image} {...fold('image')}>
        <p className="nv-muted nv-small">{t('人物立绘、场景、封面、有声漫的画面和幕间背景都用它。推荐最新的 GPT Image：经 OpenRouter 或 OpenAI 用 key 调用，或者直接用 ChatGPT 订阅。', 'Portraits, scenes, covers, comic panels and interlude backdrops. The latest GPT Image is recommended — with a key through OpenRouter or OpenAI, or straight from a ChatGPT subscription.')}</p>
        <ImageSection value={draft.image} keys={keys} t={t} advanced={advanced} onChange={(image) => { update({ image }) }} />
      </Fold>

      <Fold id="tts" title={t('语音合成', 'Speech')} summary={draft.tts.provider === 'none' ? t('未使用', 'off') : `${draft.tts.model ?? draft.tts.provider}${view.ready.tts ? '' : t(' · 还不能用', ' · not ready')}`} ready={view.ready.tts} {...fold('tts')}>
        <p className="nv-muted nv-small">{t('有声剧按人物卡选音色：人物指定的音色优先，其次是为他设计的专属声线，再按性别年龄自动选角，同一人物全书保持同一个声音。', 'The audio drama casts by character card: a voice set on the card wins, then a voice designed for them, then automatic casting by gender and age — one voice per character for the whole book.')}</p>
        <TtsSection value={draft.tts} keys={keys} voices={view.voices.map(voice => ({ id: voice.id, note: `${voice.note}${voice.accent !== undefined ? ` · ${voice.accent}` : ''}` }))} savedProvider={view.settings.tts.provider} t={t} onChange={(tts) => { update({ tts }) }} />
      </Fold>

      <Fold id="sound" title={t('声音设计：环境声、音效、配乐', 'Sound design: ambience, effects, music')} summary={(draft.sound?.provider ?? 'auto') === 'none' ? t('未使用', 'off') : (draft.sound?.provider ?? 'auto') === 'auto' ? t('沿用语音的模型', 'rides on the speech model') : draft.sound?.model ?? String(draft.sound?.provider)} ready={view.ready.sound === true} {...fold('sound')}>
        <p className="nv-muted nv-small">{t('有声脚本除了台词，还会安排每个场景听得到什么——环境底声、音效、配乐。它们会作为注释显示在正文旁边给读者气氛，也可以由声音模型生成出来垫在人声下面。', 'Besides its lines an audio script says what each scene sounds like — the bed of the place, effects, music. These show as notes beside the text for atmosphere, and a sound model can make them audible under the voices.')}</p>
        <SoundSection value={draft.sound ?? { provider: 'auto' }} tts={draft.tts} ready={view.ready.sound === true} keys={keys} t={t} onChange={(sound) => { update({ sound }) }} />
      </Fold>

      <Fold id="embedding" title={t('语义检索（向量）', 'Semantic retrieval (embeddings)')} summary={draft.embedding.provider === 'none' ? t('未使用：按关键词检索', 'off: keyword retrieval') : draft.embedding.model ?? draft.embedding.provider} ready={view.ready.embedding} {...fold('embedding')}>
        <p className="nv-muted nv-small">{t('不配置时按关键词检索（对中文按二元切分）；配置后与关键词混合排序，长篇里找"意思相近"的旧情节更准。', 'Without it retrieval is keyword-based; with it both are fused, which finds earlier passages by meaning far better in a long book.')}</p>
        <EmbeddingSection value={draft.embedding} keys={keys} t={t} onChange={(embedding) => { update({ embedding }) }} />
      </Fold>

      <div className="nv-form-actions">
        <span className="nv-spacer" />
        <Button variant="primary" busy={busy} disabled={!dirty && !ownDirty} onClick={save}>{t('保存', 'Save')}</Button>
      </div>
      <Signature version={view.version} />
    </div>
  )
}

/**
 * A part of the settings that most visits do not need opened: its name, in a
 * line what it is set to and whether it works, and the rest on a press.
 */
function Fold({ id, title, summary, ready, open, toggle, children }: { id: string; title: string; summary: string; ready: boolean; open: boolean; toggle: () => void; children: ReactNode }) {
  const t = useT()
  return (
    <section className={cx('nv-card nv-fold', open && 'is-open')} data-section={id}>
      <button type="button" className="nv-fold-head" aria-expanded={open} onClick={toggle}>
        <strong>{title}</strong>
        <Chip tone={ready ? 'green' : 'neutral'}>{ready ? t('可用', 'ready') : t('可选', 'optional')}</Chip>
        <span className="nv-fold-summary">{summary}</span>
        <span className="nv-fold-toggle">{open ? t('收起', 'Close') : t('设置', 'Set up')}</span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
      </button>
      {open ? <div className="nv-fold-body">{children}</div> : null}
    </section>
  )
}

// ───────────────────────────── shared fields ─────────────────────────────

/** Whatever the page knows about the key of an endpoint, asking the Host for hosts it has not seen. */
function useKeyState(keys: KeyBag, endpoint: string | undefined, ref: string | undefined): KeyState | undefined {
  const { controller } = useStudio()
  const host = hostOf(endpoint)
  const known = host !== undefined ? keys.view.keys[ref !== undefined && ref.length > 0 ? `${host}#${ref}` : host] : undefined
  const asked = useLoad(async (signal) => {
    if (host === undefined || endpoint === undefined || known !== undefined) return undefined
    const { states } = await controller.api.call('key.state', { endpoints: [{ url: endpoint, ...(ref !== undefined && ref.length > 0 ? { ref } : {}) }] }, signal)
    return states[0]
  }, [host, ref, known !== undefined])
  return known ?? asked.data
}

function describeCheck(check: EndpointCheck, t: Translate): string {
  if (check.ok) return t(`密钥可用${check.models !== undefined ? `（${check.models} 个模型）` : ''}`, `The key works${check.models !== undefined ? ` (${check.models} models)` : ''}`)
  const message = check.message ?? ''
  if (/refused/i.test(message)) return t('密钥被拒绝', 'The key was refused')
  if (/no key/i.test(message)) return t('还没有密钥', 'No key yet')
  return message.length > 0 ? message : t('没有连上', 'Could not connect')
}

/**
 * The key of one slot. It is typed here and saved with the page; a key already
 * saved for the same service (or found in its usual environment variable) is
 * used without typing anything.
 */
function KeyField({ endpoint, refName, keys, onRef, t }: { endpoint: string | undefined; refName: string | undefined; keys: KeyBag; onRef: (name: string | undefined) => void; t: Translate }) {
  const { controller } = useStudio()
  const host = hostOf(endpoint)
  const state = useKeyState(keys, endpoint, refName)
  const typed = host !== undefined ? keys.typed[host]?.value ?? '' : ''
  const [byName, setByName] = useState(refName !== undefined && refName.length > 0)
  const [check, setCheck] = useState<EndpointCheck | undefined>()
  const { busy, run } = useAction()
  // A check says something about one key at one endpoint; it does not outlive either.
  useEffect(() => { setCheck(undefined) }, [host, typed, refName])
  if (host === undefined || endpoint === undefined) {
    return <Field label="API key" hint={t('先填接口地址', 'Enter the endpoint address first')}><TextInput disabled value="" placeholder="—" /></Field>
  }
  const test = (): Promise<unknown> => run(async () => {
    setCheck(await controller.api.call('endpoint.check', { url: endpoint, ...(typed.trim().length > 0 ? { key: typed.trim() } : {}), ...(byName && refName !== undefined ? { ref: refName } : {}) }))
  })
  const status = check !== undefined
    ? <Chip tone={check.ok ? 'green' : 'red'}>{describeCheck(check, t)}</Chip>
    : typed.length > 0
      ? <Chip tone="amber">{t('保存后生效', 'Applies on save')}</Chip>
      : state?.configured === true
        ? <Chip tone="green">{state.source === 'saved' ? t('已保存', 'Saved') : state.source === 'env' ? t(`环境变量 ${state.name ?? ''}`, `Env ${state.name ?? ''}`) : t('可用', 'Found')}</Chip>
        : <Chip tone="red">{byName ? t('没有找到这个变量', 'Not found') : t('未填写', 'Missing')}</Chip>
  const hint = byName
    ? t('从启动 DSH 的环境里按这个名字读取密钥。', 'The key is read by this name from the environment that starts the Harness.')
    : state?.configured === true && typed.length === 0
      ? t(`${host} 的密钥已就绪，同一服务的其他选项共用它。留空沿用，填写则更换。`, `The key for ${host} is in place and shared by every slot on that service. Leave empty to keep it; type to replace it.`)
      : t(`只对 ${host} 生效，保存在本机的 DSH 凭据库里。`, `Used for ${host} only; stored in the Harness credential store on this machine.`)
  return (
    <Field label={byName ? t('密钥所在的环境变量', 'Environment variable with the key') : 'API key'} hint={hint}>
      <span className="nv-keyrow">
        {byName
          ? <TextInput className="nv-grow" value={refName ?? ''} spellCheck={false} placeholder="MY_API_KEY" onChange={(event) => { onRef(event.target.value.trim().length > 0 ? event.target.value.trim() : undefined) }} />
          : <TextInput className="nv-grow" type="password" autoComplete="off" spellCheck={false} value={typed} placeholder={state?.configured === true ? '••••••••••••' : t('粘贴 API key', 'Paste the API key')} onChange={(event) => { keys.set(endpoint, event.target.value) }} />}
        {status}
        <Button size="sm" variant="ghost" busy={busy} disabled={typed.trim().length === 0 && state?.configured !== true} onClick={test}>{t('检查', 'Check')}</Button>
        {!byName && state?.source === 'saved' && typed.length === 0 ? (
          <Button size="sm" variant="ghost" onClick={() => controller.guard(async () => { await controller.saveSettings({}, { [endpoint]: '' }); controller.toast('success', t(`已清除 ${host} 的密钥`, `Key for ${host} removed`)) })}>{t('清除', 'Forget')}</Button>
        ) : null}
        <Button size="sm" variant="ghost" title={t('高级：改为按名字从环境变量读取', 'Advanced: read the key from an environment variable by name')} onClick={() => {
          if (byName) onRef(undefined)
          else keys.set(endpoint, '')
          setByName(value => !value)
        }}>{byName ? t('直接填写', 'Type it') : t('用环境变量', 'Use env')}</Button>
      </span>
    </Field>
  )
}

/** Model lists already fetched on this page, so sibling fields on one endpoint ask once. */
const discovered = new Map<string, EndpointModel[]>()

/**
 * A model id: anything may be typed, and the list offers the recommended ones
 * plus everything the endpoint itself says it serves — all of it, whatever is
 * already in the field.
 */
function ModelField({ label, hint, endpoint, kind, value, onChange, suggestions, refName, keys, placeholder, onModels, onPickModel, describe, t }: {
  label: string
  hint?: string | undefined
  endpoint: string | undefined
  kind: ModelKind
  value: string
  onChange: (model: string) => void
  suggestions: string[]
  refName?: string | undefined
  keys: KeyBag
  placeholder?: string
  onModels?: (models: EndpointModel[]) => void
  /** A model was chosen from the list; the endpoint's own record of it comes along when there is one. */
  onPickModel?: (model: EndpointModel) => void
  /** A few words about a listed model, shown beside it. */
  describe?: (model: EndpointModel) => string | undefined
  t: Translate
}) {
  const { controller } = useStudio()
  const host = hostOf(endpoint)
  const cacheKey = `${host ?? ''}|${kind}`
  const [found, setFound] = useState<EndpointModel[]>(() => discovered.get(cacheKey) ?? [])
  const [busy, setBusy] = useState(false)
  const [signal, setSignal] = useState(0)
  const typed = host !== undefined ? keys.typed[host]?.value : undefined
  const asked = useRef<string | undefined>(undefined)
  const notify = useRef(onModels)
  notify.current = onModels
  useEffect(() => {
    const cached = discovered.get(cacheKey) ?? []
    setFound(cached)
    if (cached.length > 0) notify.current?.(cached)
  }, [cacheKey])
  const load = async (quiet: boolean): Promise<void> => {
    if (endpoint === undefined || host === undefined) return
    setBusy(true)
    try {
      const { models } = await controller.api.call('endpoint.models', { url: endpoint, kind, ...(typed !== undefined && typed.trim().length > 0 ? { key: typed.trim() } : {}), ...(refName !== undefined && refName.length > 0 ? { ref: refName } : {}) })
      discovered.set(cacheKey, models)
      setFound(models)
      notify.current?.(models)
      if (quiet) return
      const usable = models.filter(model => model.unsupported !== true).length
      if (models.length === 0) controller.toast('info', t('这个接口没有列出这类模型，直接填写模型名即可', 'The endpoint lists no such models; type the model id'))
      else {
        controller.toast('success', usable === models.length
          ? t(`这个接口列出了 ${models.length} 个模型，已全部列在下面`, `The endpoint lists ${models.length} models, all shown below`)
          : t(`这个接口有 ${models.length} 个这类模型，其中 ${usable} 个工坊可以直接用，已全部列在下面`, `The endpoint has ${models.length} such models; the Studio can drive ${usable} of them. All are listed below`))
        // Show them: a count nobody can act on is no answer.
        setSignal(count => count + 1)
      }
    } catch (error) {
      if (!quiet) controller.toast('error', messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const known = new Map(found.map(model => [model.id, model]))
  const recommended = t('推荐', 'Recommended')
  const options: ComboOption[] = [
    ...suggestions.map((id): ComboOption => {
      const model = known.get(id)
      const note = model !== undefined ? describe?.(model) : describe?.({ id })
      return { value: id, group: recommended, ...(model?.name !== undefined ? { label: model.name } : {}), ...(note !== undefined ? { note } : {}) }
    }),
    ...found.filter(model => !suggestions.includes(model.id)).map((model): ComboOption => {
      const note = model.unsupported === true ? t('工坊暂不支持它的协议', 'protocol not supported yet') : describe?.(model)
      return {
        value: model.id,
        group: model.unsupported === true ? t('这个接口还有这些（暂时用不了）', 'Also served here (not usable yet)') : t('这个接口列出的模型', 'Listed by this endpoint'),
        ...(model.name !== undefined ? { label: model.name } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(model.unsupported === true ? { disabled: true } : {}),
      }
    }),
  ]
  return (
    <Field label={label} hint={hint}>
      <span className="nv-keyrow">
        <Combo
          value={value}
          options={options}
          placeholder={placeholder ?? suggestions[0] ?? ''}
          openSignal={signal}
          empty={host === undefined ? t('先填接口地址', 'Enter the endpoint first') : busy ? t('正在读取…', 'Loading…') : t('没有可选的模型，直接填写模型名', 'Nothing to choose from; type the model id')}
          onChange={onChange}
          onPick={(option) => { onPickModel?.(known.get(option.value) ?? { id: option.value }) }}
          onOpen={() => {
            // The first look at the list fetches the endpoint's own quietly; a failure just leaves the recommendations.
            if (asked.current === cacheKey || found.length > 0) return
            asked.current = cacheKey
            void load(true)
          }}
        />
        <Button size="sm" variant="ghost" icon="refresh" busy={busy} disabled={host === undefined} title={t('读取这个接口提供的全部模型', 'List every model this endpoint serves')} onClick={() => { void load(false) }} />
      </span>
    </Field>
  )
}

function EndpointField({ value, placeholder, hint, onChange, t }: { value: string; placeholder: string; hint?: string | undefined; onChange: (value: string | undefined) => void; t: Translate }) {
  return (
    <Field label={t('接口地址', 'Endpoint')} hint={hint}>
      <TextInput value={value} spellCheck={false} placeholder={placeholder} onChange={(event) => { onChange(event.target.value.trim().length > 0 ? event.target.value.trim() : undefined) }} />
    </Field>
  )
}

// ───────────────────────────── text roles ─────────────────────────────

/** Where a role's model comes from: the chat model, one of the providers the Harness reaches (`harness:<id>`), or an endpoint named here. */
type RoleSource = '' | `harness:${string}` | ServiceId

function RoleRow({ role, label, hint, route, models, providers, fallback, keys, onChange, t, unset, extra }: {
  role: TextRole
  label: string
  hint: string
  /** Something chosen together with the model, shown beside it: how the roles that share this model work. */
  extra?: ReactNode
  /** What "nothing chosen" means here, when it is not "follow the chat model": a book's row falls back on the Studio-wide setting. */
  unset?: string
  route: ModelRoute | undefined
  models: ModelOption[]
  /** Every provider the Harness reaches: keys in its settings and sign-ins (a ChatGPT subscription through Codex Connect, …) alike. */
  providers: ProviderOption[]
  fallback: ModelRoute | undefined
  keys: KeyBag
  onChange: (route: ModelRoute | undefined) => void
  t: Translate
}) {
  const { controller } = useStudio()
  const direct = route?.baseURL !== undefined
  const source: RoleSource = route === undefined ? '' : direct ? serviceOf(route.baseURL) : `harness:${route.provider}`
  const [advanced, setAdvanced] = useState(route?.temperature !== undefined || route?.maxTokens !== undefined || route?.contextWindow !== undefined)
  // Reasoning levels of a Harness model are its own vocabulary, and how much a model can read decides how much of the book it is given: ask.
  const details = useLoad(async signal => (route !== undefined && route.model.length > 0 ? await controller.api.call('model.info', { provider: route.provider, model: route.model, ...(route.baseURL !== undefined && route.baseURL.length > 0 ? { baseURL: route.baseURL } : {}) }, signal) : undefined), [direct, route?.provider, route?.model, route?.baseURL])
  const detected = details.data?.contextWindow
  const kilo = (tokens: number): string => `${Math.round(tokens / 1000)}K`
  const follows = details.data?.outputCap !== undefined
    ? t(`留空时跟随模型：单次回复最多 ${kilo(details.data.outputCap)}`, `Empty follows the model: up to ${kilo(details.data.outputCap)} per reply`)
    : t('留空时不设上限，由模型和接口自己决定', 'Empty sets no limit; the model and the endpoint decide')
  const outputHint = `${follows}${details.data?.maxOutput !== undefined ? t(`（这个模型最大 ${kilo(details.data.maxOutput)}）`, ` (this model writes at most ${kilo(details.data.maxOutput)})`) : ''}${t('。会思考的模型，思考也算在这个数里——填小了，正文、脚本和分镜会被截断。', '. A model that reasons spends its reasoning out of this figure — set it low and prose, scripts and storyboards get cut off.')}`
  const fallbackName = fallback !== undefined ? (models.find(model => model.provider === fallback.provider && model.id === fallback.model)?.name ?? fallback.model) : undefined
  const pick = (next: RoleSource): void => {
    if (next === '') onChange(undefined)
    else if (next.startsWith('harness:')) {
      const provider = next.slice('harness:'.length)
      // The chat model when it is this provider's, else the first model it lists; a provider that lists none takes a typed id.
      const model = fallback?.provider === provider ? fallback.model : models.find(candidate => candidate.provider === provider)?.id ?? ''
      onChange({ provider, model })
    }
  }
  const set = <K extends keyof ModelRoute>(key: K, value: ModelRoute[K] | undefined): void => {
    if (route === undefined) return
    onChange(without(route, key, value))
  }
  // A role that names a provider the Harness no longer lists still shows what it is set to.
  const reached: ProviderOption[] = route !== undefined && !direct && !providers.some(provider => provider.id === route.provider)
    ? [...providers, { id: route.provider, name: route.provider, models: 0 }]
    : providers
  const provider = route !== undefined && !direct ? reached.find(candidate => candidate.id === route.provider) : undefined
  const providerModels: ComboOption[] = route !== undefined && !direct
    ? models.filter(model => model.provider === route.provider).map(model => ({ value: model.id, ...(model.name !== model.id ? { label: model.name } : {}) }))
    : []
  const harnessEfforts = direct ? [] : details.data?.efforts ?? []
  const effortOptions = direct
    ? [{ value: '', label: t('模型默认', 'Model default') }, ...DIRECT_EFFORTS.map(effort => ({ value: effort.id, label: t(...effort.name) }))]
    : [
        { value: '', label: t('模型默认', 'Model default') },
        ...harnessEfforts.map(effort => ({ value: effort.id, label: effort.name })),
        ...(route?.reasoningEffort !== undefined && !harnessEfforts.some(effort => effort.id === route.reasoningEffort) ? [{ value: route.reasoningEffort, label: route.reasoningEffort }] : []),
      ]
  const service = direct ? serviceOf(route.baseURL) : undefined
  const suggestions: string[] = []
  return (
    <div className="nv-role">
      <div className={cx('nv-role-main', extra !== undefined && extra !== null && 'has-extra')}>
        <Field label={label} hint={hint}>
          <Select<RoleSource>
            value={source}
            options={[
              { value: '', label: unset ?? (fallbackName !== undefined ? t(`跟随对话模型（当前：${fallbackName}）`, `Follow the chat model (now: ${fallbackName})`) : t('跟随对话模型', 'Follow the chat model')) },
              // What the Harness already reaches comes first: nothing more to set up, sign-ins included.
              ...reached.map(candidate => ({
                value: `harness:${candidate.id}` as RoleSource,
                label: candidate.error !== undefined
                  ? t(`${candidate.name}（暂时列不出模型）`, `${candidate.name} (cannot list models right now)`)
                  : t(`${candidate.name}（${candidate.models} 个模型）`, `${candidate.name} (${candidate.models} models)`),
              })),
              // A role saved with an endpoint of its own before text models became DSH's keeps working, and says what it is.
              ...(direct ? [{ value: source, label: t(`旧的直连接口（${service !== undefined ? t(...SERVICES[service].name) : route?.baseURL ?? ''}）`, `Directly called endpoint of the old kind (${service !== undefined ? t(...SERVICES[service].name) : route?.baseURL ?? ''})`) }] : []),
            ]}
            onChange={pick}
          />
        </Field>
        {extra}
        {route !== undefined ? <Button size="sm" variant="ghost" icon={advanced ? 'chevronUp' : 'chevronDown'} onClick={() => { setAdvanced(value => !value) }}>{t('参数', 'Parameters')}</Button> : null}
      </div>
      {route !== undefined ? (
        <div className="nv-form-grid nv-role-advanced">
          {direct ? (
            <>
              <p className="nv-note is-warn nv-role-legacy">
                {t('这个角色还在用旧的直连接口。它照常能用，但只能以普通调用的方式工作：当不了 agent——没有工具，也不会出现在对话的子 agent 列表里。文字模型现在统一来自 DSH：把这家的模型接进 DSH 的“设置 → 模型”，再回来选它。', 'This role still uses a directly called endpoint of the old kind. It works as before, but only by plain calls: it cannot be an agent — no tools, and no place in the conversation\'s list of child agents. Text models now all come from DSH: connect this vendor under DSH\'s Settings → Models, then choose it here.')}
                {' '}
                <button type="button" className="nv-link" onClick={() => { onChange(undefined) }}>{t('改为跟随对话模型', 'Follow the chat model instead')}</button>
              </p>
              <EndpointField value={route.baseURL ?? ''} placeholder="https://…/v1" hint={t('OpenAI 兼容的接口根地址，以 /v1 结尾', 'Root of an OpenAI-compatible API, ending in /v1')} t={t} onChange={(value) => { onChange({ ...route, baseURL: value ?? '' }) }} />
              <KeyField endpoint={route.baseURL} refName={route.apiKeyRef} keys={keys} t={t} onRef={(name) => { set('apiKeyRef', name) }} />
              <ModelField label={t('模型', 'Model')} endpoint={route.baseURL} kind="text" value={route.model} suggestions={suggestions} refName={route.apiKeyRef} keys={keys} t={t} onChange={(model) => { onChange({ ...route, model }) }} />
            </>
          ) : (
            <Field
              label={t('模型', 'Model')}
              hint={provider?.error !== undefined
                ? t(`${provider.name} 现在列不出模型（${provider.error.slice(0, 80)}）。在 DSH 里登录或配好之后再来选，或者直接填模型名。`, `${provider.name} cannot list its models right now (${provider.error.slice(0, 80)}). Sign in or finish its setup in the Harness, or type a model id.`)
                : providerModels.length === 0
                  ? t('这个提供方没有列出模型，直接填模型名即可', 'This provider lists no models; type a model id')
                  : detected !== undefined ? t(`上下文窗口 ${Math.round(detected / 1000)}k`, `Context window ${Math.round(detected / 1000)}k`) : undefined}
            >
              <Combo
                value={route.model}
                options={providerModels}
                placeholder={t('选择或填写模型名', 'Choose or type a model id')}
                empty={t('没有可选的模型，直接填写模型名', 'Nothing to choose from; type the model id')}
                onChange={(model) => {
                  // Reasoning levels are a model's own vocabulary: a level chosen for one model means nothing to the next.
                  const { reasoningEffort: _effort, ...kept } = route
                  onChange({ ...kept, model })
                }}
              />
            </Field>
          )}
          <Field label={t('思考强度', 'Reasoning effort')} hint={direct ? t('各家写法不同，由工坊换算；模型不支持时会自动忽略', 'Each service spells it differently; the Studio translates, and drops it when a model refuses') : details.data !== undefined && harnessEfforts.length === 0 ? t('这个模型没有可选的思考档位', 'This model offers no reasoning levels') : undefined}>
            <Select value={route.reasoningEffort ?? ''} disabled={effortOptions.length === 1} options={effortOptions} onChange={(value) => { set('reasoningEffort', value !== '' ? value : undefined) }} />
          </Field>
          {advanced ? (
            <>
              <Field label={t('温度', 'Temperature')}>
                <TextInput inputMode="decimal" value={route.temperature !== undefined ? String(route.temperature) : ''} placeholder={t('按角色默认', 'role default')} onChange={(event) => { const value = number(event.target.value); set('temperature', value !== undefined ? Math.max(0, Math.min(2, value)) : undefined) }} />
              </Field>
              <Field label={t('最大输出 tokens', 'Max output tokens')} hint={outputHint}>
                <TextInput inputMode="numeric" value={route.maxTokens !== undefined ? String(route.maxTokens) : ''} placeholder={t('不限（跟随模型）', 'none (the model\'s own)')} onChange={(event) => { const value = number(event.target.value); set('maxTokens', value !== undefined && value > 0 ? Math.round(value) : undefined) }} />
              </Field>
              <Field label={t('上下文窗口（tokens）', 'Context window (tokens)')} hint={route.contextWindow !== undefined ? t('按你填的算', 'Using your figure') : detected !== undefined ? t(`已识别为 ${Math.round(detected / 1000)}k，一般不用填`, `Detected as ${Math.round(detected / 1000)}k; usually no need to fill in`) : t('没能识别这个模型的窗口，先按 200k 算；它其实更大就填上（如 1000000），整本书才装得进去', 'Could not tell this model\'s window, so 200k is assumed; if it is larger, say so (e.g. 1000000) and the whole book fits')}>
                <TextInput inputMode="numeric" value={route.contextWindow !== undefined ? String(route.contextWindow) : ''} placeholder={detected !== undefined ? String(detected) : '200000'} onChange={(event) => { const value = number(event.target.value); set('contextWindow', value !== undefined && value >= 4000 ? Math.round(value) : undefined) }} />
              </Field>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ───────────────────────────── embeddings ─────────────────────────────

type EmbeddingSource = 'none' | ServiceId

function EmbeddingSection({ value, keys, onChange, t }: { value: EmbeddingSettings; keys: KeyBag; onChange: (value: EmbeddingSettings) => void; t: Translate }) {
  const source: EmbeddingSource = value.provider === 'none' ? 'none' : serviceOf(value.baseURL)
  const pick = (next: EmbeddingSource): void => {
    if (next === 'none') onChange({ provider: 'none' })
    else if (next === 'custom') onChange({ provider: 'openai', baseURL: '', model: '' })
    else onChange(recommendedSetup(next)!.embedding)
  }
  const suggestions = source !== 'none' ? recommendedSetup(source)?.suggestions.embedding ?? [] : []
  return (
    <div className="nv-form-grid">
      <Field label={t('服务', 'Service')}>
        <Select<EmbeddingSource> value={source} options={[
          { value: 'none', label: t('不使用（只按关键词）', 'Off (keywords only)') },
          { value: 'bailian', label: t('阿里云百炼', 'Aliyun Bailian') },
          { value: 'openrouter', label: 'OpenRouter' },
          { value: 'openai', label: 'OpenAI' },
          { value: 'custom', label: t('自定义接口（OpenAI 兼容 /embeddings）', 'Custom endpoint (OpenAI-compatible /embeddings)') },
        ]} onChange={pick} />
      </Field>
      {value.provider !== 'none' ? (
        <>
          <EndpointField value={value.baseURL ?? ''} placeholder="https://…/v1" t={t} onChange={(baseURL) => { onChange(without(value, 'baseURL', baseURL)) }} />
          <KeyField endpoint={value.baseURL} refName={value.apiKeyRef} keys={keys} t={t} onRef={(name) => { onChange(without(value, 'apiKeyRef', name)) }} />
          <ModelField label={t('模型', 'Model')} endpoint={value.baseURL} kind="embedding" value={value.model ?? ''} suggestions={suggestions} refName={value.apiKeyRef} keys={keys} t={t} onChange={(model) => { onChange(without(value, 'model', model)) }} />
          <Field label={t('维度（可选）', 'Dimensions (optional)')} hint={t('换模型或维度后，索引会在下次检索时重建', 'Changing the model or the dimensions rebuilds the index on the next search')}>
            <TextInput inputMode="numeric" value={value.dimensions !== undefined ? String(value.dimensions) : ''} placeholder={t('模型默认', 'model default')} onChange={(event) => { onChange(without(value, 'dimensions', number(event.target.value))) }} />
          </Field>
        </>
      ) : null}
    </div>
  )
}

// ───────────────────────────── images ─────────────────────────────

type ImageSource = 'none' | 'codex' | ServiceId

function imageSourceOf(value: ImageSettings): ImageSource {
  if (value.provider === 'none' || value.provider === 'codex') return value.provider
  if (value.provider === 'dashscope') return 'bailian'
  if (value.provider === 'openrouter') return 'openrouter'
  return serviceOf(value.baseURL) === 'openai' || value.baseURL === undefined ? 'openai' : 'custom'
}

const TIER_LABELS: Record<PictureTier, [string, string]> = {
  '720p': ['720p（标清，快而省）', '720p (quick and cheap)'],
  '1080p': ['1080p（高清）', '1080p (full HD)'],
  '2k': ['2K', '2K'],
  '4k': ['4K（最细，最慢最贵）', '4K (finest, slowest, dearest)'],
}

const ASPECT_LABELS: Record<string, [string, string]> = {
  '1:1': ['1:1 方图', '1:1 square'],
  '3:4': ['3:4 竖幅', '3:4 upright'],
  '4:3': ['4:3 横幅', '4:3 level'],
  '16:9': ['16:9 宽屏', '16:9 wide'],
  '9:16': ['9:16 竖屏', '9:16 tall'],
  '3:2': ['3:2 横幅', '3:2 level'],
  '2:3': ['2:3 竖幅', '2:3 upright'],
}

const KIND_LABELS: Record<PictureKind, [string, string]> = {
  cover: ['封面', 'Cover'],
  portrait: ['定妆照 / 立绘', 'Portraits'],
  sheet: ['人设图', 'Design sheets'],
  location: ['地点设定图', 'Places'],
  item: ['物品设定图', 'Objects'],
  scene: ['章节插图', 'Chapter scenes'],
  panel: ['分镜画面 / 幕间背景', 'Storyboard panels, backdrops'],
}

/**
 * How large pictures are drawn, and in what shape: one fineness for all of
 * them, and for each kind of picture a shape of its own — a cover stands, a
 * stage lies. Each shape says the pixels it comes to; exact pixels can be
 * typed instead.
 */
function PictureSizeFields({ value, onChange, t, advanced }: { value: ImageSettings; onChange: (next: ImageSettings) => void; t: Translate; advanced: boolean }) {
  // No fineness chosen: every kind of picture at the size it has always had.
  const tier = (PICTURE_TIERS as readonly string[]).includes(value.resolution ?? '') ? value.resolution as PictureTier : undefined
  const aspects = value.aspects ?? {}
  const setAspect = (kind: PictureKind, next: string | undefined): void => {
    const { [kind]: _old, ...rest } = aspects
    const merged = next !== undefined && next.length > 0 ? { ...rest, [kind]: next } : rest
    const { aspects: _all, ...others } = value
    onChange(Object.keys(merged).length > 0 ? { ...others, aspects: merged } : others)
  }
  return (
    <>
      <Field label={t('清晰度', 'Fineness')} hint={tier === undefined
        ? t('默认：每类图片用它一直以来的尺寸（见下面各项）。选一个档位，所有图片就按“和这个名字的屏幕一样多的像素”来画。', 'Default: each kind of picture at the size it has always had (shown below). Choose a tier and every picture is drawn with as many pixels as a screen of that name.')
        : t(`所有图片共用：和这个名字的屏幕一样多的像素，按各自的比例分配（16:9 就是 ${pixelSize('16:9', tier).replace('x', '×')}）。越高越慢、越贵；模型不支持时会报错，换低一档即可。`, `For every picture: as many pixels as a screen of that name, in the picture's own shape (16:9 is ${pixelSize('16:9', tier).replace('x', '×')}). Higher is slower and dearer; a model that refuses it says so — choose a lower one.`)}>
        <Select value={tier ?? ''} options={[{ value: '', label: t('默认（各类图片的常用尺寸）', 'Default (each kind\'s usual size)') }, ...PICTURE_TIERS.map(item => ({ value: item as string, label: t(...TIER_LABELS[item]) }))]} onChange={(next) => { onChange(without(value, 'resolution', next)) }} />
      </Field>
      {/* The shape of each kind of picture: for whoever wants other than a standing cover and a lying stage. */}
      {!advanced ? null : (
      <div className="nv-size-grid">
        {PICTURE_KINDS.map((kind) => {
          const chosen = aspects[kind]
          const custom = chosen !== undefined && !(ASPECTS as readonly string[]).includes(chosen)
          return (
            <Field key={kind} label={t(...KIND_LABELS[kind])} hint={custom ? t('宽x高，如 1600x900', 'WIDTHxHEIGHT, e.g. 1600x900') : pictureSize(value, kind).replace('x', ' × ')}>
              <Select value={custom ? 'custom' : chosen ?? ''} options={[{ value: '', label: t(`默认（${ASPECT_LABELS[KIND_ASPECT[kind]]![0]}）`, `Default (${ASPECT_LABELS[KIND_ASPECT[kind]]![1]})`) }, ...ASPECTS.map(item => ({ value: item as string, label: t(...ASPECT_LABELS[item]!) })), { value: 'custom', label: t('自己填像素…', 'Exact pixels…') }]} onChange={(next) => { setAspect(kind, next === 'custom' ? pictureSize(value, kind) : next === '' ? undefined : next) }} />
              {custom ? <TextInput value={chosen} placeholder="1600x900" onChange={(event) => { setAspect(kind, event.target.value.trim().length > 0 ? event.target.value : undefined) }} /> : null}
            </Field>
          )
        })}
      </div>
      )}
    </>
  )
}

function ImageSection({ value, keys, onChange, t, advanced }: { value: ImageSettings; keys: KeyBag; onChange: (value: ImageSettings) => void; t: Translate; advanced: boolean }) {
  const source = imageSourceOf(value)
  const { codex } = keys.view
  // The look of the book outlives a change of service.
  const look = { ...(value.stylePrompt !== undefined ? { stylePrompt: value.stylePrompt } : {}), ...(value.negativePrompt !== undefined ? { negativePrompt: value.negativePrompt } : {}) }
  const pick = (next: ImageSource): void => {
    if (next === 'none') onChange({ provider: 'none', ...look })
    else if (next === 'codex') onChange({ provider: 'codex', size: '1536x1024', ...look })
    else if (next === 'custom') onChange({ provider: 'openai', baseURL: '', model: '', size: value.size ?? '1024x1024', ...look })
    else onChange({ ...recommendedSetup(next)!.image, ...look })
  }
  const endpoint = value.provider === 'dashscope' ? value.baseURL ?? SERVICES.bailian.origin : value.provider === 'openrouter' ? value.baseURL ?? compatibleBase('openrouter') : value.baseURL ?? compatibleBase('openai')
  const suggestions = source !== 'none' && source !== 'codex' ? recommendedSetup(source)?.suggestions.image ?? [] : []
  const viaConnect = codex.connect && codex.connectSignedIn
  const viaCli = codex.cli && codex.cliSignedIn
  const ready = value.bridge === 'connect' ? viaConnect : value.bridge === 'cli' ? viaCli : viaConnect || viaCli
  return (
    <>
      <div className="nv-form-grid">
        <Field label={t('服务', 'Service')}>
          <Select<ImageSource> value={source} options={[
            { value: 'none', label: t('不使用', 'Off') },
            { value: 'openrouter', label: t('OpenRouter（GPT Image 2.5 等，推荐）', 'OpenRouter (GPT Image 2.5 and more, recommended)') },
            { value: 'codex', label: t('ChatGPT 订阅（Codex，无需 key）', 'ChatGPT subscription (Codex, no key)') },
            { value: 'openai', label: t('OpenAI（GPT Image）', 'OpenAI (GPT Image)') },
            { value: 'bailian', label: t('阿里云百炼（Qwen-Image、万相、Z-Image）', 'Aliyun Bailian (Qwen-Image, Wan, Z-Image)') },
            { value: 'custom', label: t('自定义接口（OpenAI 兼容 /images/generations）', 'Custom endpoint (OpenAI-compatible /images/generations)') },
          ]} onChange={pick} />
        </Field>
        {value.provider === 'codex' ? (
          <Field label={t('通道', 'Bridge')} hint={ready ? t('这条通道已登录，可以出图', 'This bridge is signed in and can draw') : value.bridge === 'cli' ? t('还没有登录：在终端运行 codex login，选择用 ChatGPT 登录', 'Not signed in yet: run codex login in a terminal and sign in with ChatGPT') : value.bridge === 'connect' ? t('还没有登录：在 DSH 设置 → 模型 → Openai-Codex 里授权', 'Not signed in yet: authorize under Harness Settings → Models → Openai-Codex') : t('还没有登录：在 DSH 设置 → 模型 → Openai-Codex 授权，或运行 codex login', 'Not signed in yet: authorize under Harness Settings → Models → Openai-Codex, or run codex login')}>
            <Select<CodexBridgeKind> value={value.bridge ?? 'auto'} options={[
              { value: 'auto', label: t('自动（优先 Codex Connect）', 'Automatic (Codex Connect first)') },
              { value: 'connect', label: `Codex Connect${codex.connect ? (codex.connectSignedIn ? t(' · 已登录', ' · signed in') : t(' · 未登录', ' · not signed in')) : t(' · 未安装', ' · not installed')}` },
              { value: 'cli', label: `Codex CLI${codex.cli ? (codex.cliSignedIn ? t(' · 已登录', ' · signed in') : t(' · 未登录', ' · not signed in')) : t(' · 未安装', ' · not installed')}` },
            ]} onChange={(bridge) => { onChange(without(value, 'bridge', bridge === 'auto' ? undefined : bridge)) }} />
          </Field>
        ) : null}
        {value.provider !== 'none' && value.provider !== 'codex' ? (
          <>
            <EndpointField value={value.baseURL ?? ''} placeholder={endpoint} hint={value.provider === 'dashscope' ? t('百炼的域名；专属域名也可以', 'The Bailian domain; a workspace domain works too') : undefined} t={t} onChange={(baseURL) => { onChange(without(value, 'baseURL', baseURL)) }} />
            <KeyField endpoint={endpoint} refName={value.apiKeyRef} keys={keys} t={t} onRef={(name) => { onChange(without(value, 'apiKeyRef', name)) }} />
            <ModelField label={t('模型', 'Model')} endpoint={endpoint} kind="image" value={value.model ?? ''} suggestions={suggestions} refName={value.apiKeyRef} keys={keys} t={t} onChange={(model) => { onChange(without(value, 'model', model)) }} />
          </>
        ) : null}
        {value.provider !== 'none' ? <PictureSizeFields value={value} onChange={onChange} t={t} advanced={advanced} /> : null}
        {value.provider !== 'none' && advanced ? (
          <Field label={t('一张图带几张参考图', 'Reference pictures per image')} hint={t(`画面里人物的人设图、地点的设定图会作为参考图一起发给绘图模型。留空：${REFERENCES_DEFAULT} 张（收参考图的模型都收得下）；最多 ${REFERENCES_MAX} 张，能收更多的模型人物更稳。`, `The design sheets of the people in a picture and the art of its place go along as references. Empty: ${REFERENCES_DEFAULT} (every model that takes references takes that many); ${REFERENCES_MAX} at most — a model that takes more holds faces steadier.`)}>
            <TextInput inputMode="numeric" value={value.references !== undefined ? String(value.references) : ''} placeholder={String(REFERENCES_DEFAULT)} onChange={(event) => { const count = number(event.target.value); const { references: _old, ...rest } = value; onChange(count !== undefined && count >= 0 ? { ...rest, references: Math.min(REFERENCES_MAX, Math.round(count)) } : rest) }} />
          </Field>
        ) : null}
        {value.provider === 'openai' || value.provider === 'openrouter' ? (
          <Field label={t('质量', 'Quality')}>
            <Select value={value.quality ?? ''} options={[{ value: '', label: t('模型默认', 'Model default') }, { value: 'low', label: t('低（快、省）', 'Low (fast, cheap)') }, { value: 'medium', label: t('中', 'Medium') }, { value: 'high', label: t('高', 'High') }]} onChange={(quality) => { onChange(without(value, 'quality', quality !== '' ? quality : undefined)) }} />
          </Field>
        ) : null}
      </div>
      {value.provider !== 'none' ? (
        <div className="nv-note">
          <p>{t('画风不在这里：它属于每一本书，在那本书的“设定 → 画风”里看和改。导入书稿、起草设定时，导演会按那本书自动定一份。', 'The look of the pictures is not set here: it belongs to each book, on the Art page of that book\'s bible. When a manuscript is imported or a bible drafted, the director settles one for that book.')}</p>
          {/* What was once entered here is still in force for books without a look of their own: shown, and removable, not silently kept. */}
          {(value.stylePrompt ?? '').trim().length > 0 ? (
            <p className="nv-small">
              {t('以前填在这里的全局画风，仍是还没有自己画风的书的起点：', 'The Studio-wide look once entered here is still what a book without its own starts from: ')}<em>{value.stylePrompt}</em>{' '}
              <button type="button" className="nv-link" onClick={() => { onChange(without(value, 'stylePrompt', '')) }}>{t('清除（保存后生效）', 'Clear (takes effect on save)')}</button>
            </p>
          ) : null}
          {(value.negativePrompt ?? '').trim().length > 0 ? (
            <p className="nv-small">
              {t('以前填在这里的“不要出现”，仍对所有书生效：', 'The "never in the picture" list once entered here still applies to every book: ')}<em>{value.negativePrompt}</em>{' '}
              <button type="button" className="nv-link" onClick={() => { onChange(without(value, 'negativePrompt', '')) }}>{t('清除（保存后生效）', 'Clear (takes effect on save)')}</button>
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

// ───────────────────────────── speech ─────────────────────────────

const TTS_OPTIONS: { value: TtsProviderKind; label: [string, string] }[] = [
  { value: 'none', label: ['不使用', 'Off'] },
  { value: 'qwen-audiogen', label: ['阿里云百炼 · 音频生成（推荐）', 'Aliyun Bailian · audio generation (recommended)'] },
  { value: 'qwen-realtime', label: ['阿里云百炼 · Qwen Omni 实时', 'Aliyun Bailian · Qwen Omni realtime'] },
  { value: 'dashscope', label: ['阿里云百炼 · Qwen TTS（可设计声线）', 'Aliyun Bailian · Qwen TTS (voice design)'] },
  { value: 'openrouter', label: ['OpenRouter（Gemini TTS 等）', 'OpenRouter (Gemini TTS and more)'] },
  { value: 'openai', label: ['OpenAI 兼容接口（/audio/speech）', 'OpenAI-compatible (/audio/speech)'] },
]

/** How a speech protocol takes its voices, in a few words beside a model. */
const SPEECH_NOTE: Record<Exclude<TtsProviderKind, 'none'>, [string, string]> = {
  'qwen-audiogen': ['用文字描述音色', 'voices in words'],
  'qwen-realtime': ['实时朗读 · 固定音色', 'realtime · stock voices'],
  dashscope: ['固定音色表 · 可设计声线', 'stock voices · voice design'],
  openrouter: ['/audio/speech', '/audio/speech'],
  openai: ['/audio/speech', '/audio/speech'],
}

function speechNote(service: ServiceId, model: string, t: Translate): string | undefined {
  const via = speechProtocol(service, model)
  if (via === undefined || via === 'none') return undefined
  // Two Qwen-TTS families only speak in a voice made for them beforehand.
  if (via === 'dashscope' && /-vc-/i.test(model)) return t('只念克隆出来的音色', 'cloned voices only')
  if (via === 'dashscope' && /-vd-/i.test(model)) return t('只念设计出来的专属声线', 'designed voices only')
  return t(...SPEECH_NOTE[via])
}

/** What a kind of speech endpoint starts out with, by the recommendations in force. */
function starting(provider: TtsProviderKind): Pick<TtsSettings, 'model' | 'designedVoiceModel' | 'narratorVoice'> {
  const { model, designedVoiceModel, narratorVoice } = providerDefault('tts', provider)
  return { model, ...(designedVoiceModel !== undefined ? { designedVoiceModel } : {}), ...(narratorVoice !== undefined ? { narratorVoice } : {}) }
}

function ttsDefaults(provider: TtsProviderKind, previous: TtsSettings): TtsSettings {
  // How the narrator is told to read, and how many lines go out at once, outlive a change of service.
  const keep = { ...(previous.narratorInstructions !== undefined ? { narratorInstructions: previous.narratorInstructions } : {}), ...(previous.concurrency !== undefined ? { concurrency: previous.concurrency } : {}) }
  switch (provider) {
    case 'qwen-audiogen': return { ...recommendedSetup('bailian')!.tts, ...keep }
    case 'qwen-realtime': return { provider, baseURL: bailianRealtime(), ...starting(provider), ...keep }
    case 'dashscope': return { provider, baseURL: SERVICES.bailian.origin, ...starting(provider), ...keep }
    case 'openrouter': return { ...recommendedSetup('openrouter')!.tts, ...keep }
    case 'openai': return { ...recommendedSetup('openai')!.tts, ...keep }
    default: return { provider: 'none', ...keep }
  }
}

function TtsSection({ value, keys, voices, savedProvider, onChange, t }: { value: TtsSettings; keys: KeyBag; voices: { id: string; note: string }[]; savedProvider: TtsProviderKind; onChange: (value: TtsSettings) => void; t: Translate }) {
  const id = useId()
  const [listed, setListed] = useState<EndpointModel[]>([])
  const inWords = value.provider === 'qwen-audiogen'
  const endpoint = value.baseURL ?? (value.provider === 'openrouter' ? compatibleBase('openrouter') : value.provider === 'openai' ? compatibleBase('openai') : value.provider === 'qwen-realtime' ? bailianRealtime() : SERVICES.bailian.origin)
  const fallback = value.defaultVoices ?? {}
  const setFallback = (key: 'female' | 'male' | 'neutral', voice: string): void => {
    const { [key]: _old, ...rest } = fallback
    const next = voice.trim().length > 0 ? { ...rest, [key]: voice.trim() } : rest
    onChange(without(value, 'defaultVoices', Object.keys(next).length > 0 ? next : undefined))
  }
  // What is worth offering beside the field: what the recommendations list for this kind of endpoint, else for the service it is.
  const offered = value.provider === 'none' ? undefined : providerDefault('tts', value.provider)
  const suggestions = value.provider === 'none' ? []
    : offered?.suggestions ?? (value.provider === 'openrouter' ? recommendedSetup('openrouter')?.suggestions.tts : undefined) ?? (offered !== undefined && offered.model.length > 0 ? [offered.model] : [])
  // Voices the endpoint lists for the chosen model win over the stock catalog of the saved provider.
  const fromEndpoint = listed.find(model => model.id === value.model)?.voices ?? []
  const voiceOptions = fromEndpoint.length > 0 ? fromEndpoint.map(voice => ({ id: voice, note: '' })) : value.provider === savedProvider ? voices : []
  return (
    <>
      <div className="nv-form-grid">
        <Field label={t('服务', 'Service')}>
          <Select<TtsProviderKind> value={value.provider} options={TTS_OPTIONS.map(option => ({ value: option.value, label: t(...option.label) }))} onChange={(provider) => { onChange(ttsDefaults(provider, value)) }} />
        </Field>
        {value.provider !== 'none' ? (
          <>
            <EndpointField value={value.baseURL ?? ''} placeholder={endpoint} hint={value.provider === 'qwen-realtime' ? 'wss://…/api-ws/v1/realtime' : value.provider === 'qwen-audiogen' || value.provider === 'dashscope' ? t('百炼的域名；专属域名也可以', 'The Bailian domain; a workspace domain works too') : undefined} t={t} onChange={(baseURL) => { onChange(without(value, 'baseURL', baseURL)) }} />
            <KeyField endpoint={endpoint} refName={value.apiKeyRef} keys={keys} t={t} onRef={(name) => { onChange(without(value, 'apiKeyRef', name)) }} />
            <ModelField
              label={t('模型', 'Model')}
              hint={serviceOf(endpoint) === 'bailian' ? t('点开可以看到百炼上所有能合成语音的模型；选了别的协议的模型，"服务"会跟着切换', 'Open the list for every Bailian model that can speak; choosing one of another protocol switches the service with it') : undefined}
              endpoint={endpoint}
              kind="speech"
              value={value.model ?? ''}
              suggestions={suggestions}
              refName={value.apiKeyRef}
              keys={keys}
              t={t}
              onModels={setListed}
              describe={model => speechNote(serviceOf(endpoint), model.id, t)}
              onChange={(model) => { onChange(without(value, 'model', model)) }}
              onPickModel={(model) => {
                const via = model.via ?? speechProtocol(serviceOf(endpoint), model.id)
                if (via === undefined || via === value.provider) return
                // The model decides the protocol; the account (domain and key) stays the one already entered.
                const origin = value.baseURL !== undefined && serviceOf(value.baseURL) === 'bailian' && originOf(value.baseURL) !== SERVICES.bailian.origin ? originOf(value.baseURL) : undefined
                const next = ttsDefaults(via, value)
                onChange({
                  ...next,
                  model: model.id,
                  ...(origin !== undefined ? { baseURL: via === 'qwen-realtime' ? bailianRealtime(origin) : origin } : {}),
                  ...(value.apiKeyRef !== undefined ? { apiKeyRef: value.apiKeyRef } : {}),
                })
              }}
            />
            {value.provider === 'dashscope' ? <Field label={t('专属声线所用模型', 'Model for designed voices')}><TextInput value={value.designedVoiceModel ?? ''} placeholder={providerDefault('tts', 'dashscope').designedVoiceModel ?? ''} onChange={(event) => { onChange(without(value, 'designedVoiceModel', event.target.value)) }} /></Field> : null}
            <Field label={t('旁白音色', 'Narrator voice')} hint={inWords ? t('这个模型用文字描述音色，如"沉稳、有故事感的中年男声"', 'This model takes voices in words, e.g. "a calm middle-aged man with a storyteller\'s warmth"') : undefined}>
              <TextInput list={id} value={value.narratorVoice ?? ''} placeholder={inWords ? t('留空用默认旁白', 'empty for the default narrator') : ''} onChange={(event) => { onChange(without(value, 'narratorVoice', inWords ? event.target.value : event.target.value.trim())) }} />
            </Field>
            <Field label={t('并发数', 'Parallel requests')} hint={t(`同时合成几句，默认 ${PARALLEL_DEFAULT}，最多 ${PARALLEL_MAX}；被限流时会自动降速重试`, `Lines at once: ${PARALLEL_DEFAULT} by default, ${PARALLEL_MAX} at most; slowed down and retried by itself when the service pushes back`)}><TextInput inputMode="numeric" value={value.concurrency !== undefined ? String(value.concurrency) : ''} placeholder={String(PARALLEL_DEFAULT)} onChange={(event) => { onChange(without(value, 'concurrency', parallel(event.target.value))) }} /></Field>
            <Field label={t('不合格时最多重念', 'Retakes when a line fails the check')} hint={t('每一句合成后都会"听检"：没念完、没声音，或明显不像这个角色的声音，就再念一次，留下最好的那次；音量也会统一。重念会多花一点合成用量，填 0 关闭重念（仍会标出有问题的句子）。', 'Every line is checked once voiced: cut short, silent, or plainly not in the speaker\'s voice, and it is spoken again — the best take is kept, and all lines are brought to one level. Retakes cost a little more synthesis; 0 switches them off (lines are still marked).')}>
              <TextInput inputMode="numeric" value={value.retakes !== undefined ? String(value.retakes) : ''} placeholder="2" onChange={(event) => { const count = number(event.target.value); onChange(without(value, 'retakes', count !== undefined ? Math.max(0, Math.min(4, Math.round(count))) : undefined)) }} />
            </Field>
            <Field label={t('对白之间的"他说"', 'The "he said" between spoken lines')} hint={t('每个人物有自己的声音时，夹在两句对白之间、只交代谁在说的提示语是多余的，而且两三个字的短句正是语音模型最不稳的地方。"不念"更像广播剧；"照念"一字不落，更像有声书。脚本里可以逐行改。', 'With a voice per speaker, a tag that only says who speaks is redundant between two spoken lines, and a clip of two or three syllables is where a speech model is least steady. "Unspoken" is how an audio drama does it; "read" keeps every word, as an audiobook would. Any line can be changed in the script.')}>
              <Select<'drop' | 'read'> value={value.speechTags ?? 'drop'} options={[{ value: 'drop', label: t('不念（广播剧）', 'Unspoken (audio drama)') }, { value: 'read', label: t('照念（有声书）', 'Read (audiobook)') }]} onChange={(speechTags) => { onChange(without(value, 'speechTags', speechTags === 'drop' ? undefined : speechTags)) }} />
            </Field>
            {value.provider === 'openrouter' || value.provider === 'openai' ? (
              <Field label={t('PCM 采样率', 'PCM sample rate')} hint={t('接口返回裸 PCM 且没有说明采样率时使用，默认 24000', 'Used when the endpoint answers raw PCM without saying its rate; 24000 by default')}><TextInput inputMode="numeric" value={value.sampleRate !== undefined ? String(value.sampleRate) : ''} placeholder="24000" onChange={(event) => { const rate = number(event.target.value); onChange(without(value, 'sampleRate', rate !== undefined && rate >= 8000 ? Math.round(rate) : undefined)) }} /></Field>
            ) : null}
          </>
        ) : null}
      </div>
      {value.provider !== 'none' ? (
        <>
          {inWords ? <p className="nv-note">{t('这个模型没有固定音色表：每个人物的声音由人物卡上的"声音"描述决定，工坊会为每个声音生成一段参考音并一直沿用，所以同一个人全书是同一个嗓子。每句大约需要十几秒。', 'This model has no fixed voice list: a character\'s voice comes from the "voice" line on their card. The Studio makes one reference clip per voice and keeps using it, so a character sounds the same throughout. Each line takes about fifteen seconds.')}</p> : null}
          <Field label={t('旁白的讲述方式', 'How the narrator reads')}><TextInput value={value.narratorInstructions ?? ''} placeholder={t('如：沉稳、克制，像深夜电台', 'e.g. calm and restrained, like late-night radio')} onChange={(event) => { onChange(without(value, 'narratorInstructions', event.target.value)) }} /></Field>
          <div className="nv-form-grid">
            <Field label={t('默认女声', 'Default female voice')}><TextInput list={id} value={fallback.female ?? ''} onChange={(event) => { setFallback('female', event.target.value) }} /></Field>
            <Field label={t('默认男声', 'Default male voice')}><TextInput list={id} value={fallback.male ?? ''} onChange={(event) => { setFallback('male', event.target.value) }} /></Field>
            <Field label={t('默认中性声', 'Default neutral voice')}><TextInput list={id} value={fallback.neutral ?? ''} onChange={(event) => { setFallback('neutral', event.target.value) }} /></Field>
          </div>
          <datalist id={id}>{voiceOptions.map(voice => <option key={voice.id} value={voice.id}>{voice.note}</option>)}</datalist>
        </>
      ) : null}
    </>
  )
}

const SOUND_OPTIONS: { value: SoundProviderKind; label: [string, string] }[] = [
  { value: 'auto', label: ['跟随语音设置（推荐）', 'Follow the speech setup (recommended)'] },
  { value: 'qwen-audiogen', label: ['百炼音频生成（单独指定接口）', 'Bailian audio generation (its own endpoint)'] },
  { value: 'none', label: ['不生成，只用浏览器合成的环境声', 'Do not generate: browser-synthesized ambience only'] },
]

/** Where effects, music and generated ambience come from, and which of them the director places. */
function SoundSection({ value, tts, ready, keys, onChange, t }: { value: SoundSettings; tts: TtsSettings; ready: boolean; keys: KeyBag; onChange: (value: SoundSettings) => void; t: Translate }) {
  const own = value.provider === 'qwen-audiogen'
  const follows = value.provider === 'auto'
  const canFollow = tts.provider === 'qwen-audiogen'
  const endpoint = value.baseURL ?? SERVICES.bailian.origin
  return (
    <>
      <div className="nv-form-grid">
        <Field label={t('声音从哪里来', 'Where sound comes from')}>
          <Select<SoundProviderKind> value={value.provider} options={SOUND_OPTIONS.map(option => ({ value: option.value, label: t(...option.label) }))} onChange={(provider) => { onChange({ ...value, provider }) }} />
        </Field>
        {own ? (
          <>
            <EndpointField value={value.baseURL ?? ''} placeholder={endpoint} hint={t('百炼的域名；专属域名也可以', 'The Bailian domain; a workspace domain works too')} t={t} onChange={(baseURL) => { onChange(without(value, 'baseURL', baseURL)) }} />
            <KeyField endpoint={endpoint} refName={value.apiKeyRef} keys={keys} t={t} onRef={(name) => { onChange(without(value, 'apiKeyRef', name)) }} />
          </>
        ) : null}
        {value.provider !== 'none' ? (
          <Field label={t('声音模型', 'Sound model')} hint={follows ? t('留空就用语音那一栏的模型', 'Left empty, the model of the speech section is used') : undefined}>
            <TextInput value={value.model ?? ''} placeholder={follows ? tts.model ?? providerDefault('sound', 'qwen-audiogen').model : providerDefault('sound', 'qwen-audiogen').model} onChange={(event) => { onChange(without(value, 'model', event.target.value.trim())) }} />
          </Field>
        ) : null}
        <Field label={t('环境底声', 'Ambience beds')} hint={t('"模型生成"按每个场景的描述做一段可循环的底声；没生成之前、以及没有声音模型时，播放时先用浏览器合成的顶上。', '"Generated" has the model make a loopable bed from each scene\'s description; until one is made, and without a sound model, the browser-synthesized bed stands in.')}>
          <Select<'generate' | 'browser'> value={value.beds ?? 'generate'} options={[{ value: 'generate', label: t('模型生成（推荐）', 'Generated by the model (recommended)') }, { value: 'browser', label: t('只用浏览器合成', 'Browser-synthesized only') }]} onChange={(beds) => { onChange(without(value, 'beds', beds === 'generate' ? undefined : beds)) }} />
        </Field>
      </div>
      <div className="nv-row-wrap">
        <label className="nv-check"><input type="checkbox" checked={value.effects !== false} onChange={(event) => { onChange(without(value, 'effects', event.target.checked ? undefined : false)) }} /><span>{t('让导演安排音效（门、脚步、槌声……）', 'Have the director place effects (a door, steps, a gavel…)')}</span></label>
        <label className="nv-check"><input type="checkbox" checked={value.music !== false} onChange={(event) => { onChange(without(value, 'music', event.target.checked ? undefined : false)) }} /><span>{t('让导演安排配乐', 'Have the director place music')}</span></label>
      </div>
      {value.provider === 'none'
        ? <p className="nv-note">{t('不生成声音：脚本里的声音只作为正文旁的注释出现，环境底声由浏览器合成。', 'No generated sound: the script\'s sounds appear as notes beside the text only, and beds are synthesized by the browser.')}</p>
        : follows && !canFollow
          ? <p className="nv-note is-warn">{t('现在的语音服务不能生成声音（只有百炼的音频生成模型既能说话也能做声音）。声音仍会作为注释显示，环境底声由浏览器合成；想听到音效和配乐，把上面改成"百炼音频生成"并填密钥，或把语音换成百炼的 qwen-audio-3.1-tts-next。', 'The current speech service cannot make sound (only Bailian audio generation both speaks and makes sound). Sounds still show as notes and beds are synthesized by the browser; to hear effects and music, choose "Bailian audio generation" above and give it a key, or move speech to Bailian\'s qwen-audio-3.1-tts-next.')}</p>
          : <p className="nv-note">{ready ? t('已就绪：在朗读页的"听"里点"生成声音"，环境声、音效和配乐会按脚本逐处生成。现在的声音模型还不够稳，哪一处不满意可以改描述后单独重做。', 'Ready: under Listen in the reader choose "Make the sounds" and ambience, effects and music are made cue by cue. Sound models are still uneven; any cue can be reworded and made again on its own.') : t('还缺密钥：保存语音那一栏的密钥后这里就能用。', 'A key is still missing: once the speech section has its key this is ready.')}</p>}
    </>
  )
}

/** Shown where a view needs a capability that is not set up. */
export function NeedsSetup({ what, children }: { what: 'image' | 'tts'; children?: ReactNode }) {
  const { controller } = useStudio()
  const t = useT()
  const ready = useSnapshot(snapshot => snapshot.settings?.ready)
  // Shown only once it is known to be missing.
  if (ready === undefined || ready[what]) return null
  return (
    <p className={cx('nv-note', 'is-warn')}>
      {what === 'image' ? t('还没有配置图像生成。', 'Image generation is not set up yet.') : t('还没有配置语音合成。', 'Speech is not set up yet.')}
      {children}
      {' '}
      <button type="button" className="nv-link" onClick={() => { controller.openSettings(what) }}>{t('去设置', 'Open settings')}</button>
      {' · '}
      <button type="button" className="nv-link" onClick={() => { controller.setView('setup') }}>{t('一键配置', 'One-click setup')}</button>
    </p>
  )
}

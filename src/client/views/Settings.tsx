// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Settings shared by every book.
 *
 * Two ways in, on one page: the one-click cards at the top set a whole service
 * up from a single key, and below them every slot — the four text roles,
 * retrieval, images, speech — names its own service, endpoint, key, model and
 * reasoning level. Keys are typed here and saved with everything else; they go
 * to the Harness credential store, never into the settings file.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { EndpointCheck, EndpointModel, KeyState, ModelKind, ModelOption, ProviderOption, SettingsView as SettingsData } from '../../shared/rpc'
import { DEFAULT_ART_STYLE } from '../../shared/art'
import {
  bailianRealtime, compatibleBase, DIRECT_EFFORTS, hostOf, originOf, recommendedSetup, SERVICES, serviceOf, speechProtocol, type ServiceId,
} from '../../shared/services'
import type {
  CodexBridgeKind, EmbeddingSettings, ImageSettings, ModelRoute, NovelSettings, SoundProviderKind, SoundSettings, TextRole, TtsProviderKind, TtsSettings,
} from '../../shared/types'
import { messageOf } from '../api'
import {
  Button, Chip, Combo, cx, Field, SectionTitle, Select, Spinner, TextArea, TextInput, useAction, useLoad, useSnapshot, useStudio, useT, type ComboOption, type Translate,
} from '../ui'
import { QuickSetup, Readiness, Signature } from './Setup'

const ROLES: { role: TextRole; label: [string, string]; hint: [string, string] }[] = [
  { role: 'writer', label: ['写手', 'Writer'], hint: ['写正文、续写、改写。选文笔最好的模型——不必是最"聪明"的那个。', 'Drafts, continues and rewrites prose. Pick the best stylist, not necessarily the smartest model.'] },
  { role: 'analyst', label: ['分析', 'Analyst'], hint: ['收录记忆、审校、有声脚本与分镜。选快而稳、擅长结构化输出的模型。', 'Digests, reviews, audio scripts and storyboards. Pick something fast and literal that is good at structured output.'] },
  { role: 'architect', label: ['架构', 'Architect'], hint: ['推演大纲、起草设定、假设分支。选推理强的模型。', 'Derives outlines, drafts the bible, explores what-ifs. Pick a strong reasoner.'] },
  { role: 'director', label: ['导演', 'Director'], hint: ['幕间演绎的实时回合。选响应快的模型。', 'Real-time turns of an interlude. Pick a responsive model.'] },
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
  return <SettingsForm key={JSON.stringify(view.settings)} view={view} t={t} />
}

function SettingsForm({ view, t }: { view: SettingsData; t: Translate }) {
  const { controller } = useStudio()
  const [draft, setDraft] = useState<NovelSettings>(view.settings)
  const [typed, setTyped] = useState<TypedKeys>({})
  const [dirty, setDirty] = useState(false)
  const [quick, setQuick] = useState(false)
  const { busy, run } = useAction()
  // A link here can ask for one part of the page ("speech is not set up" leads to the speech section).
  const focus = useSnapshot(snapshot => snapshot.settingsFocus)
  const page = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus === undefined) return
    const target = page.current?.querySelector(`[data-section="${focus}"]`)
    if (target !== null && target !== undefined) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
      target.classList.add('is-focus')
      setTimeout(() => { target.classList.remove('is-focus') }, 2400)
    }
    controller.consumeSettingsFocus()
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
    await controller.saveSettings({
      models: sectionPatch(view.settings.models, draft.models),
      context: sectionPatch(view.settings.context, draft.context),
      image: sectionPatch(view.settings.image, draft.image),
      tts: sectionPatch(view.settings.tts, draft.tts),
      sound: sectionPatch(view.settings.sound ?? { provider: 'auto' }, draft.sound ?? { provider: 'auto' }),
      embedding: sectionPatch(view.settings.embedding, draft.embedding),
      autoDigest: draft.autoDigest,
      reviewAgentRevisions: draft.reviewAgentRevisions,
      agentFiles: draft.agentFiles ?? 'guide',
    }, Object.fromEntries(Object.values(typed).map(entry => [entry.url, entry.value.trim()])))
    controller.toast('success', t('设置已保存', 'Settings saved'))
  })

  return (
    <div className="nv-page nv-settings" ref={page}>
      <header className="nv-settings-head">
        <div>
          <h2>{t('小说工坊设置', 'Novel Studio settings')}</h2>
          <p className="nv-muted nv-small">{t('对所有作品生效。上面是一键配置，下面每一项都能单独指定服务、接口、密钥、模型和思考强度。', 'Applies to every book. One-click setup at the top; below, every slot names its own service, endpoint, key, model and reasoning level.')}</p>
        </div>
        <div className="nv-row-wrap">
          <Button variant="ghost" icon="clock" onClick={() => { controller.setView('usage') }}>{t('用量与成本', 'Usage and cost')}</Button>
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
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
        <p className="nv-muted nv-small">{t('贴一个 key，按推荐把写作、插图、配音、检索一次配好。之后仍可在下面逐项修改。', 'Paste one key and get writing, images, speech and retrieval set up as recommended. Everything stays editable below.')}</p>
        {quick || view.setupNeeded ? <QuickSetup view={view} services={['bailian', 'openrouter', 'openai']} /> : (
          <div className="nv-row-wrap">
            {(['bailian', 'openrouter', 'openai'] as const).map(service => <Button key={service} size="sm" onClick={() => { setQuick(true) }}>{t(...SERVICES[service].name)}</Button>)}
            <Button size="sm" onClick={() => { setQuick(true) }}>{t('ChatGPT 订阅（Codex）', 'ChatGPT subscription (Codex)')}</Button>
          </div>
        )}
      </section>

      <section className="nv-card" data-section="text">
        <SectionTitle>{t('模型分工', 'Model roles')}</SectionTitle>
        <p className="nv-muted nv-small">{t('对话里的总编用的是会话自己选的模型；下面四个角色由总编或你在工坊里调用。每个角色可以跟随对话模型，可以选 Harness 已经接入的任何提供方（在 Harness 里填过 key 的，以及用登录接入的，比如经 Codex Connect 登录的 ChatGPT 订阅），也可以在这里直接指定一个接口。', 'The showrunner in the chat uses the model the session selected; the four roles below are called by the showrunner or by you in the Studio. A role can follow the chat model, use any provider the Harness already reaches (those with a key in its settings and those signed in, such as a ChatGPT subscription through Codex Connect), or name an endpoint of its own here.')}</p>
        {ROLES.map(item => (
          <RoleRow
            key={item.role}
            role={item.role}
            label={t(...item.label)}
            hint={t(...item.hint)}
            route={draft.models[item.role]}
            models={view.models}
            // A Host that has not restarted since an update does not send the provider list yet.
            providers={view.providers ?? []}
            fallback={view.defaultRoute}
            keys={keys}
            t={t}
            onChange={(route) => {
              const { [item.role]: _old, ...rest } = draft.models
              update({ models: route !== undefined ? { ...rest, [item.role]: route } : rest })
            }}
          />
        ))}
      </section>

      <section className="nv-card">
        <SectionTitle>{t('上下文与记忆', 'Context and memory')}</SectionTitle>
        <div className="nv-form-grid">
          <Field label={t('上下文策略', 'Context strategy')} hint={t('自动：稿子装得下就给全文，装不下按相关性取用', 'Auto: the whole manuscript while it fits, relevance-packed once it does not')}>
            <Select value={draft.context.strategy} options={[
              { value: 'auto', label: t('自动（推荐）', 'Auto (recommended)') },
              { value: 'retrieval', label: t('始终检索：摘要 + 相关片段', 'Always retrieve: summaries + relevant passages') },
              { value: 'full', label: t('尽量全文：长上下文模型', 'Full text when possible: long-context models') },
            ]} onChange={(value) => { update({ context: { ...draft.context, strategy: value } }) }} />
          </Field>
          <Field label={t('上下文预算（tokens）', 'Context budget (tokens)')} hint={t('每次调用最多给模型多少背景，默认 50 万。实际用量不会超过所用模型窗口的七成；窗口没识别出来时按 20 万算，可在上面各角色的"参数"里填。', 'The most background one call may carry; 500k by default. A call never uses more than 70% of its model\'s window; an unrecognised window counts as 200k and can be filled in under each role\'s Parameters above.')}>
            <TextInput inputMode="numeric" value={String(draft.context.budgetTokens)} onChange={(event) => { const value = number(event.target.value); if (value !== undefined) update({ context: { ...draft.context, budgetTokens: Math.max(2000, Math.round(value)) } }) }} />
          </Field>
          <Field label={t('紧接上文（字符）', 'Preceding text (characters)')} hint={t('续写时原样带上的前文长度', 'How much of the text just before is carried verbatim')}>
            <TextInput inputMode="numeric" value={String(draft.context.tailChars)} onChange={(event) => { const value = number(event.target.value); if (value !== undefined) update({ context: { ...draft.context, tailChars: Math.max(0, Math.round(value)) } }) }} />
          </Field>
        </div>
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

      <section className="nv-card" data-section="image">
        <SectionTitle>{t('图像生成', 'Image generation')}<Chip>{t('可选', 'optional')}</Chip></SectionTitle>
        <p className="nv-muted nv-small">{t('人物立绘、场景、封面、有声漫的画面和幕间背景都用它。推荐最新的 GPT Image：经 OpenRouter 或 OpenAI 用 key 调用，或者直接用 ChatGPT 订阅。', 'Portraits, scenes, covers, comic panels and interlude backdrops. The latest GPT Image is recommended — with a key through OpenRouter or OpenAI, or straight from a ChatGPT subscription.')}</p>
        <ImageSection value={draft.image} keys={keys} t={t} onChange={(image) => { update({ image }) }} />
      </section>

      <section className="nv-card" data-section="tts">
        <SectionTitle>{t('语音合成', 'Speech')}<Chip>{t('可选', 'optional')}</Chip></SectionTitle>
        <p className="nv-muted nv-small">{t('有声剧按人物卡选音色：人物指定的音色优先，其次是为他设计的专属声线，再按性别年龄自动选角，同一人物全书保持同一个声音。', 'The audio drama casts by character card: a voice set on the card wins, then a voice designed for them, then automatic casting by gender and age — one voice per character for the whole book.')}</p>
        <TtsSection value={draft.tts} keys={keys} voices={view.voices.map(voice => ({ id: voice.id, note: `${voice.note}${voice.accent !== undefined ? ` · ${voice.accent}` : ''}` }))} savedProvider={view.settings.tts.provider} t={t} onChange={(tts) => { update({ tts }) }} />
      </section>

      <section className="nv-card" data-section="sound">
        <SectionTitle>{t('声音设计：环境声、音效、配乐', 'Sound design: ambience, effects, music')}<Chip>{t('可选', 'optional')}</Chip></SectionTitle>
        <p className="nv-muted nv-small">{t('有声脚本除了台词，还会安排每个场景听得到什么——环境底声、音效、配乐。它们会作为注释显示在正文旁边给读者气氛，也可以由声音模型生成出来垫在人声下面。', 'Besides its lines an audio script says what each scene sounds like — the bed of the place, effects, music. These show as notes beside the text for atmosphere, and a sound model can make them audible under the voices.')}</p>
        <SoundSection value={draft.sound ?? { provider: 'auto' }} tts={draft.tts} ready={view.ready.sound === true} keys={keys} t={t} onChange={(sound) => { update({ sound }) }} />
      </section>

      <section className="nv-card" data-section="embedding">
        <SectionTitle>{t('语义检索（向量）', 'Semantic retrieval (embeddings)')}<Chip>{t('可选', 'optional')}</Chip></SectionTitle>
        <p className="nv-muted nv-small">{t('不配置时按关键词检索（对中文按二元切分）；配置后与关键词混合排序，长篇里找"意思相近"的旧情节更准。', 'Without it retrieval is keyword-based; with it both are fused, which finds earlier passages by meaning far better in a long book.')}</p>
        <EmbeddingSection value={draft.embedding} keys={keys} t={t} onChange={(embedding) => { update({ embedding }) }} />
      </section>

      <div className="nv-form-actions">
        <span className="nv-spacer" />
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={save}>{t('保存', 'Save')}</Button>
      </div>
      <Signature version={view.version} />
    </div>
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
    ? t('从启动 Harness 的环境里按这个名字读取密钥。', 'The key is read by this name from the environment that starts the Harness.')
    : state?.configured === true && typed.length === 0
      ? t(`${host} 的密钥已就绪，同一服务的其他选项共用它。留空沿用，填写则更换。`, `The key for ${host} is in place and shared by every slot on that service. Leave empty to keep it; type to replace it.`)
      : t(`只对 ${host} 生效，保存在本机的 Harness 凭据库里。`, `Used for ${host} only; stored in the Harness credential store on this machine.`)
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

function RoleRow({ role, label, hint, route, models, providers, fallback, keys, onChange, t }: {
  role: TextRole
  label: string
  hint: string
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
    } else if (next === 'custom') onChange({ provider: 'custom', model: '', baseURL: '' })
    else onChange(recommendedSetup(next as ServiceId)!.text[role])
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
  const suggestions = service !== undefined ? recommendedSetup(service)?.suggestions.text ?? [] : []
  return (
    <div className="nv-role">
      <div className="nv-role-main">
        <Field label={label} hint={hint}>
          <Select<RoleSource>
            value={source}
            options={[
              { value: '', label: fallbackName !== undefined ? t(`跟随对话模型（当前：${fallbackName}）`, `Follow the chat model (now: ${fallbackName})`) : t('跟随对话模型', 'Follow the chat model') },
              // What the Harness already reaches comes first: nothing more to set up, sign-ins included.
              ...reached.map(candidate => ({
                value: `harness:${candidate.id}` as RoleSource,
                label: candidate.error !== undefined
                  ? t(`${candidate.name}（Harness 已接入，暂时列不出模型）`, `${candidate.name} (in the Harness; cannot list models right now)`)
                  : t(`${candidate.name}（Harness 已接入 · ${candidate.models} 个模型）`, `${candidate.name} (in the Harness · ${candidate.models} models)`),
              })),
              { value: 'bailian', label: t('阿里云百炼（在这里填 key 直连）', 'Aliyun Bailian (direct, with a key entered here)') },
              { value: 'openrouter', label: t('OpenRouter（在这里填 key 直连）', 'OpenRouter (direct, with a key entered here)') },
              { value: 'openai', label: t('OpenAI（在这里填 key 直连）', 'OpenAI (direct, with a key entered here)') },
              { value: 'custom', label: t('自定义接口（OpenAI 兼容）', 'Custom endpoint (OpenAI-compatible)') },
            ]}
            onChange={pick}
          />
        </Field>
        {route !== undefined ? <Button size="sm" variant="ghost" icon={advanced ? 'chevronUp' : 'chevronDown'} onClick={() => { setAdvanced(value => !value) }}>{t('参数', 'Parameters')}</Button> : null}
      </div>
      {route !== undefined ? (
        <div className="nv-form-grid nv-role-advanced">
          {direct ? (
            <>
              <EndpointField value={route.baseURL ?? ''} placeholder="https://…/v1" hint={t('OpenAI 兼容的接口根地址，以 /v1 结尾', 'Root of an OpenAI-compatible API, ending in /v1')} t={t} onChange={(value) => { onChange({ ...route, baseURL: value ?? '' }) }} />
              <KeyField endpoint={route.baseURL} refName={route.apiKeyRef} keys={keys} t={t} onRef={(name) => { set('apiKeyRef', name) }} />
              <ModelField label={t('模型', 'Model')} endpoint={route.baseURL} kind="text" value={route.model} suggestions={suggestions} refName={route.apiKeyRef} keys={keys} t={t} onChange={(model) => { onChange({ ...route, model }) }} />
            </>
          ) : (
            <Field
              label={t('模型', 'Model')}
              hint={provider?.error !== undefined
                ? t(`${provider.name} 现在列不出模型（${provider.error.slice(0, 80)}）。在 Harness 里登录或配好之后再来选，或者直接填模型名。`, `${provider.name} cannot list its models right now (${provider.error.slice(0, 80)}). Sign in or finish its setup in the Harness, or type a model id.`)
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

function ImageSection({ value, keys, onChange, t }: { value: ImageSettings; keys: KeyBag; onChange: (value: ImageSettings) => void; t: Translate }) {
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
          <Field label={t('通道', 'Bridge')} hint={ready ? t('这条通道已登录，可以出图', 'This bridge is signed in and can draw') : value.bridge === 'cli' ? t('还没有登录：在终端运行 codex login，选择用 ChatGPT 登录', 'Not signed in yet: run codex login in a terminal and sign in with ChatGPT') : value.bridge === 'connect' ? t('还没有登录：在 Harness 设置 → 模型 → Openai-Codex 里授权', 'Not signed in yet: authorize under Harness Settings → Models → Openai-Codex') : t('还没有登录：在 Harness 设置 → 模型 → Openai-Codex 授权，或运行 codex login', 'Not signed in yet: authorize under Harness Settings → Models → Openai-Codex, or run codex login')}>
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
        {value.provider !== 'none' ? (
          <Field label={t('默认尺寸', 'Default size')} hint={value.provider === 'codex' ? t('订阅接口只收提示词，尺寸会换成横图/竖图/方图的说法', 'The subscription takes a prompt only; the size becomes "landscape", "portrait" or "square" in words') : t('横图适合有声漫与场景，如 1280x720', 'Landscape suits comics and scenes, e.g. 1280x720')}>
            <TextInput value={value.size ?? ''} placeholder="1024x1024" onChange={(event) => { onChange(without(value, 'size', event.target.value)) }} />
          </Field>
        ) : null}
        {value.provider === 'openai' || value.provider === 'openrouter' ? (
          <Field label={t('质量', 'Quality')}>
            <Select value={value.quality ?? ''} options={[{ value: '', label: t('模型默认', 'Model default') }, { value: 'low', label: t('低（快、省）', 'Low (fast, cheap)') }, { value: 'medium', label: t('中', 'Medium') }, { value: 'high', label: t('高', 'High') }]} onChange={(quality) => { onChange(without(value, 'quality', quality !== '' ? quality : undefined)) }} />
          </Field>
        ) : null}
      </div>
      {value.provider !== 'none' ? (
        <>
          <Field label={t('统一画风', 'House art direction')} hint={t('新书起步用的画风。留空时用灰字显示的内置默认。每本书画第一张图时会把当时生效的画风写进它自己的 novel.json，之后以书里那份为准——在"演出 → 插图"顶部或"作品信息"里看得到、改得了。', 'The art direction new books start from. Left empty, the built-in default shown in grey applies. A book\'s first picture writes the direction then in force into its own novel.json, and the book keeps that copy from then on — visible and editable at the top of Stage → Illustrations and in Book info.')}><TextArea value={value.stylePrompt ?? ''} placeholder={t(DEFAULT_ART_STYLE.zh, DEFAULT_ART_STYLE.en)} onChange={(event) => { onChange(without(value, 'stylePrompt', event.target.value)) }} /></Field>
          <Field label={t('不要出现', 'Negative prompt')} hint={t('对所有书都生效；每本书还能在"演出 → 插图"里加自己的', 'Applies to every book; each book adds its own under Stage → Illustrations')}><TextInput value={value.negativePrompt ?? ''} placeholder={t('文字、水印、畸形的手…', 'text, watermark, malformed hands…')} onChange={(event) => { onChange(without(value, 'negativePrompt', event.target.value)) }} /></Field>
        </>
      ) : null}
    </>
  )
}

// ───────────────────────────── speech ─────────────────────────────

const TTS_OPTIONS: { value: TtsProviderKind; label: [string, string] }[] = [
  { value: 'none', label: ['不使用', 'Off'] },
  { value: 'qwen-audiogen', label: ['阿里云百炼 · 音频生成 qwen-audio-3.1-tts-next（推荐）', 'Aliyun Bailian · audio generation qwen-audio-3.1-tts-next (recommended)'] },
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

function ttsDefaults(provider: TtsProviderKind, previous: TtsSettings): TtsSettings {
  const keep = { ...(previous.narratorInstructions !== undefined ? { narratorInstructions: previous.narratorInstructions } : {}) }
  switch (provider) {
    case 'qwen-audiogen': return { ...recommendedSetup('bailian')!.tts, ...keep }
    case 'qwen-realtime': return { provider, baseURL: bailianRealtime(), model: 'qwen3.8-omni-flash-realtime', narratorVoice: 'Serena', concurrency: 3, ...keep }
    case 'dashscope': return { provider, baseURL: SERVICES.bailian.origin, model: 'qwen3-tts-instruct-flash', designedVoiceModel: 'qwen3-tts-vd-2026-01-26', narratorVoice: 'Serena', concurrency: 3, ...keep }
    case 'openrouter': return { ...recommendedSetup('openrouter')!.tts, ...keep }
    case 'openai': return { ...recommendedSetup('openai')!.tts, ...keep }
    default: return { provider: 'none', concurrency: 3, ...keep }
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
  const suggestions = value.provider === 'qwen-audiogen' ? ['qwen-audio-3.1-tts-next']
    : value.provider === 'qwen-realtime' ? ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime']
      : value.provider === 'dashscope' ? ['qwen3-tts-instruct-flash', 'qwen3-tts-flash']
        : value.provider === 'openrouter' ? recommendedSetup('openrouter')!.suggestions.tts
          : value.provider === 'openai' ? ['gpt-4o-mini-tts'] : []
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
            {value.provider === 'dashscope' ? <Field label={t('专属声线所用模型', 'Model for designed voices')}><TextInput value={value.designedVoiceModel ?? ''} placeholder="qwen3-tts-vd-2026-01-26" onChange={(event) => { onChange(without(value, 'designedVoiceModel', event.target.value)) }} /></Field> : null}
            <Field label={t('旁白音色', 'Narrator voice')} hint={inWords ? t('这个模型用文字描述音色，如"沉稳、有故事感的中年男声"', 'This model takes voices in words, e.g. "a calm middle-aged man with a storyteller\'s warmth"') : undefined}>
              <TextInput list={id} value={value.narratorVoice ?? ''} placeholder={inWords ? t('留空用默认旁白', 'empty for the default narrator') : ''} onChange={(event) => { onChange(without(value, 'narratorVoice', inWords ? event.target.value : event.target.value.trim())) }} />
            </Field>
            <Field label={t('并发数', 'Parallel requests')}><TextInput inputMode="numeric" value={value.concurrency !== undefined ? String(value.concurrency) : ''} placeholder="3" onChange={(event) => { const count = number(event.target.value); onChange(without(value, 'concurrency', count !== undefined ? Math.max(1, Math.min(8, Math.round(count))) : undefined)) }} /></Field>
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
            <TextInput value={value.model ?? ''} placeholder={follows ? tts.model ?? 'qwen-audio-3.1-tts-next' : 'qwen-audio-3.1-tts-next'} onChange={(event) => { onChange(without(value, 'model', event.target.value.trim())) }} />
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

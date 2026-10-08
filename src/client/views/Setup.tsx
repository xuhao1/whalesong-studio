// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Getting the Studio ready in one step: paste one key, pick what it should
 * power, done. The same cards open the first-run guide and sit at the top of
 * the settings, where every slot can then be tuned by hand. What a key sets up
 * here is what is the Studio's own to configure — pictures, speech, search.
 * Text models are DSH's: every role runs on one of them.
 */
import { useState, type ReactNode } from 'react'
import type { EndpointCheck, SettingsView as SettingsData } from '../../shared/rpc'
import { recommended } from '../../shared/recommended'
import { hostOf, originOf, PROJECT_AUTHOR, PROJECT_HOMEPAGE, recommendedSetup, SERVICES, type ServiceId, type SetupPart } from '../../shared/services'
import { Icon, type IconName } from '../icons'
import { Button, Chip, cx, Field, Spinner, TextInput, useAction, useSnapshot, useStudio, useT, type Translate } from '../ui'

const PARTS: { part: SetupPart; label: [string, string] }[] = [
  { part: 'embedding', label: ['语义检索', 'Semantic retrieval'] },
  { part: 'image', label: ['插图', 'Images'] },
  { part: 'tts', label: ['配音', 'Speech'] },
]

/** What a service is, in a line. Which models it is used with is not said here: that is the recommendations' (`recommended.json`). */
const PITCH: Record<'bailian' | 'openrouter' | 'openai', { blurb: [string, string] }> = {
  bailian: { blurb: ['国内直连，一个 key 配齐插图、配音和检索。', 'Reachable from mainland China; one key covers pictures, speech and search.'] },
  openrouter: { blurb: ['一个 key 配齐插图、配音和检索，各家的模型都在。', 'One key for pictures, speech and search, with every maker\'s models behind it.'] },
  openai: { blurb: ['直接使用 OpenAI 官方接口。', 'OpenAI\'s own API.'] },
}

/** A recommended model as people say it: its name where the recommendations give one, else its id. */
const modelName = (service: 'bailian' | 'openrouter' | 'openai', part: 'image' | 'tts'): string => {
  const slot = recommended().services[service]?.[part]
  return slot?.label ?? slot?.model ?? ''
}

/** What a failed check means, in the reader's language. */
function checkMessage(check: EndpointCheck, t: Translate): string {
  const message = check.message ?? ''
  if (/refused/i.test(message)) return t('密钥被拒绝，请检查是否粘贴完整、是否属于这个服务。', 'The key was refused. Check that it was pasted whole and belongs to this service.')
  if (/no key/i.test(message)) return t('还没有密钥。', 'There is no key yet.')
  if (/not signed in/i.test(message)) return t('已安装，但还没有登录 ChatGPT。', 'Installed, but not signed in to ChatGPT yet.')
  if (/neither/i.test(message)) return t('没有找到 Codex Connect 插件，也没有找到 Codex CLI。', 'Neither the Codex Connect plugin nor the Codex CLI was found.')
  return message.length > 0 ? message : t('没有连上这个服务。', 'Could not reach the service.')
}

function ServiceCard({ service, view, t, onDone }: { service: 'bailian' | 'openrouter' | 'openai'; view: SettingsData; t: Translate; onDone?: (() => void) | undefined }) {
  const { controller } = useStudio()
  const info = SERVICES[service]
  const pitch = PITCH[service]
  const hasChatModel = view.models.length > 0 || view.defaultRoute !== undefined
  const [key, setKey] = useState('')
  const [origin, setOrigin] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [parts, setParts] = useState<SetupPart[]>(['embedding', 'image', 'tts'])
  const [check, setCheck] = useState<EndpointCheck | undefined>()
  const { busy, run } = useAction()
  const address = originOf(origin) ?? info.origin
  const state = view.keys[hostOf(address) ?? '']
  const setup = recommendedSetup(service, address)
  const canApply = parts.length > 0 && (key.trim().length > 0 || state?.configured === true)
  const toggle = (part: SetupPart): void => { setParts(previous => (previous.includes(part) ? previous.filter(item => item !== part) : [...previous, part])) }
  const apply = (): Promise<unknown> => run(async () => {
    setCheck(undefined)
    const result = await controller.applySetup({ service, parts, ...(key.trim().length > 0 ? { key: key.trim() } : {}), ...(origin.trim().length > 0 ? { origin: origin.trim() } : {}) })
    setCheck(result)
    if (result.ok) {
      setKey('')
      controller.toast('success', t(`${info.name[0]}已配置`, `${info.name[1]} is set up`))
      onDone?.()
    }
  })
  return (
    <section className="nv-card nv-setup-card">
      <header className="nv-setup-card-head">
        <h3>{t(...info.name)}</h3>
        {state?.configured === true ? <Chip tone="green">{state.source === 'env' ? t(`已检测到 ${state.name ?? ''}`, `Found ${state.name ?? ''}`) : t('密钥已保存', 'Key saved')}</Chip> : null}
      </header>
      <p className="nv-muted">{t(...pitch.blurb)}</p>
      <ul className="nv-setup-what">
        {setup !== undefined ? (
          <>
            <li><Icon name="image" size={13} />{t('插图', 'Images')}：{modelName(service, 'image')}</li>
            <li><Icon name="mic" size={13} />{t('配音', 'Speech')}：{modelName(service, 'tts')}</li>
            <li><Icon name="search" size={13} />{t('检索', 'Retrieval')}：{setup.embedding.model}</li>
          </>
        ) : null}
      </ul>
      <Field label="API key" hint={state?.configured === true ? t('留空就沿用现有的密钥；填写则更换。', 'Leave empty to keep the key in use; type one to replace it.') : t('只保存在本机的 DSH 凭据库里，不会写进设置文件，也不会回传到页面。', 'Stored only in the Harness credential store on this machine — never in the settings file, never sent back to the page.')}>
        <TextInput type="password" autoComplete="off" spellCheck={false} value={key} placeholder={state?.configured === true ? '••••••••••••' : t('粘贴 API key', 'Paste the API key')} onChange={(event) => { setKey(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && canApply) apply() }} />
      </Field>
      <div className="nv-setup-parts">
        {PARTS.map(item => (
          <label key={item.part} className="nv-check nv-check-inline">
            <input type="checkbox" checked={parts.includes(item.part)} onChange={() => { toggle(item.part) }} />
            <span>{t(...item.label)}</span>
          </label>
        ))}
      </div>
      {!hasChatModel ? <p className="nv-muted nv-small">{t('写作用的文字模型不在这里配：先在 DSH 的“设置 → 模型”里接入一个模型，总编和班底都用它。', 'The text models that write are not set up here: connect a model under DSH\'s Settings → Models first — the showrunner and the crew all run on it.')}</p> : null}
      {advanced ? (
        <Field label={t('接口地址', 'Service address')} hint={service === 'bailian' ? t('默认公共域名即可；有专属域名（如 https://ws-xxxx.cn-beijing.maas.aliyuncs.com）也可以填，粘贴任何一个接口地址都行。', 'The public domain works; a workspace domain (https://ws-xxxx.cn-beijing.maas.aliyuncs.com) may be given instead — any endpoint URL of it will do.') : t('经代理或镜像访问时填写。', 'Only when going through a proxy or a mirror.')}>
          <TextInput value={origin} placeholder={info.origin} spellCheck={false} onChange={(event) => { setOrigin(event.target.value) }} />
        </Field>
      ) : null}
      {check !== undefined ? (
        <p className={cx('nv-note', check.ok ? 'is-ok' : 'is-warn')}>
          {check.ok ? t(`密钥可用${check.models !== undefined ? `，可选模型 ${check.models} 个` : ''}。已按推荐配置，下面每一项都可以再改。`, `The key works${check.models !== undefined ? `; ${check.models} models available` : ''}. Recommended models are in place, and every slot can still be changed.`) : checkMessage(check, t)}
        </p>
      ) : null}
      <div className="nv-form-actions">
        {info.keyUrl !== undefined ? <a className="nv-link" href={info.keyUrl} target="_blank" rel="noreferrer">{t('去获取 key', 'Get a key')}</a> : null}
        <Button variant="ghost" size="sm" onClick={() => { setAdvanced(value => !value) }}>{advanced ? t('收起', 'Less') : t('接口地址', 'Address')}</Button>
        <span className="nv-spacer" />
        <Button variant="primary" busy={busy} disabled={!canApply} onClick={apply}>{t('一键配置', 'Set up')}</Button>
      </div>
    </section>
  )
}

function CodexCard({ view, t, onDone }: { view: SettingsData; t: Translate; onDone?: (() => void) | undefined }) {
  const { controller } = useStudio()
  const { codex } = view
  const [check, setCheck] = useState<EndpointCheck | undefined>()
  const { busy, run } = useAction()
  const ready = (codex.connect && codex.connectSignedIn) || (codex.cli && codex.cliSignedIn)
  const active = view.settings.image.provider === 'codex'
  const line = (installed: boolean, signedIn: boolean, name: string, how: ReactNode): ReactNode => (
    <li>
      <Icon name={installed && signedIn ? 'checkCircle' : 'info'} size={13} />
      {name}：{!installed ? t('未安装', 'not installed') : signedIn ? t('已登录', 'signed in') : <>{t('已安装，未登录', 'installed, not signed in')} — {how}</>}
    </li>
  )
  return (
    <section className="nv-card nv-setup-card">
      <header className="nv-setup-card-head">
        <h3>{t('ChatGPT 订阅（Codex）', 'ChatGPT subscription (Codex)')}</h3>
        {active ? <Chip tone="green">{t('正在用于插图', 'Drawing images')}</Chip> : null}
      </header>
      <p className="nv-muted">{t('用订阅自带的 GPT Image 画插图，不需要 API key，也不用另外登录——沿用 Codex Connect 插件或本机 Codex CLI 已有的登录。', 'Draw with the GPT Image that comes with the subscription: no API key and no extra sign-in — it rides on the Codex Connect plugin or the Codex CLI already signed in on this machine.')}</p>
      <ul className="nv-setup-what">
        {line(codex.connect, codex.connectSignedIn, 'Codex Connect', t('在 DSH 设置 → 模型 → Openai-Codex 里授权', 'authorize under Harness Settings → Models → Openai-Codex'))}
        {line(codex.cli, codex.cliSignedIn, 'Codex CLI', <code>codex login</code>)}
      </ul>
      <p className="nv-muted nv-small">{t('订阅只提供插图：没有向量接口，也没有语音合成接口，这两项请用上面的服务。授权后，Openai-Codex 的文本模型也会出现在"模型分工"的 DSH 模型里。', 'A subscription draws images only: it has no embedding and no speech endpoint — use a service above for those. Once authorized, the Openai-Codex text models also appear among the Harness models under "Model roles".')}</p>
      {check !== undefined && !check.ok ? <p className="nv-note is-warn">{t('已选用，但现在还画不了：', 'Selected, but it cannot draw yet: ')}{checkMessage(check, t)}</p> : null}
      <div className="nv-form-actions">
        <span className="nv-spacer" />
        <Button variant={ready ? 'primary' : 'outline'} busy={busy} disabled={!codex.connect && !codex.cli} onClick={() => {
          void run(async () => {
            const result = await controller.applySetup({ service: 'codex', parts: ['image'] })
            setCheck(result)
            if (result.ok) {
              controller.toast('success', t('插图将使用 ChatGPT 订阅', 'Images will use the ChatGPT subscription'))
              onDone?.()
            }
          })
        }}>{t('用它画插图', 'Use it for images')}</Button>
      </div>
    </section>
  )
}

/** The one-click cards. `services` narrows them; by default the two recommended services and the subscription. */
export function QuickSetup({ view, onDone, services = ['bailian', 'openrouter'] }: { view: SettingsData; onDone?: () => void; services?: ('bailian' | 'openrouter' | 'openai')[] }) {
  const t = useT()
  return (
    <div className="nv-setup-grid">
      {services.map(service => <ServiceCard key={service} service={service} view={view} t={t} onDone={onDone} />)}
      <CodexCard view={view} t={t} onDone={onDone} />
    </div>
  )
}

/** What is ready and what is not, at a glance. */
export function Readiness({ view, t }: { view: SettingsData; t: Translate }) {
  const rows: { ok: boolean; icon: IconName; label: string; optional: boolean }[] = [
    { ok: view.ready.text, icon: 'feather', label: t('文字模型（来自 DSH）', 'Text models (from DSH)'), optional: false },
    { ok: view.ready.image, icon: 'image', label: t('插图', 'Images'), optional: true },
    { ok: view.ready.tts, icon: 'mic', label: t('配音', 'Speech'), optional: true },
    { ok: view.ready.embedding, icon: 'search', label: t('语义检索', 'Semantic retrieval'), optional: true },
  ]
  return (
    <div className="nv-readiness">
      {rows.map(row => (
        <span key={row.label} className={cx('nv-ready', row.ok ? 'is-ok' : row.optional ? 'is-off' : 'is-missing')}>
          <Icon name={row.ok ? 'checkCircle' : row.icon} size={14} />
          <span>{row.label}</span>
          <small>{row.ok ? t('可用', 'ready') : row.optional ? t('未启用（可选）', 'off (optional)') : t('需要配置', 'needed')}</small>
        </span>
      ))}
    </div>
  )
}

export function Signature({ version }: { version?: string | undefined }) {
  const t = useT()
  return (
    <p className="nv-muted nv-small nv-signature">
      Novel Studio{version !== undefined ? ` · v${version}` : ''} · {t('作者', 'by')} {PROJECT_AUTHOR} · <a className="nv-link" href={PROJECT_HOMEPAGE} target="_blank" rel="noreferrer">{PROJECT_HOMEPAGE.replace(/^https?:\/\//, '')}</a> · LGPL-3.0-or-later
    </p>
  )
}

/** The first-run guide. It opens by itself once, while nothing is set up; afterwards it is a page like any other. */
export function SetupView() {
  const { controller } = useStudio()
  const t = useT()
  const view = useSnapshot(snapshot => snapshot.settings)
  const { busy, run } = useAction()
  if (view === undefined) return <div className="nv-center"><Spinner size={18} /></div>
  const leave = (): Promise<unknown> => run(async () => {
    if (view.settings.setup?.done !== true) await controller.dismissSetup()
    controller.setView('home')
  })
  const chat = view.defaultRoute !== undefined ? (view.models.find(model => model.provider === view.defaultRoute!.provider && model.id === view.defaultRoute!.model)?.name ?? view.defaultRoute.model) : undefined
  return (
    <div className="nv-page nv-setup">
      <header className="nv-setup-hero">
        <Icon name="feather" size={28} />
        <h1>{t('先把模型接上', 'Connect the models first')}</h1>
        <p>{t('小说工坊是一个剧组：总编和你对话，写手执笔，场记、策划、导演、后期各管一摊——他们用的文字模型都来自 DSH（设置 → 模型），可以给每个角色单独选。工坊自己要配的是画插图的、配音的和做检索的模型：贴一个 key 就能全部配好，之后每一项都可以单独换。', 'Novel Studio is a crew: the showrunner talks with you, the writer writes, and continuity, the planner, the director and post-production each have their part. The text models they run on are all DSH\'s (Settings → Models), and each role can be given its own. What the Studio sets up itself are the models that draw, speak and search: one key sets all of them up, and every slot can be changed afterwards.')}</p>
      </header>
      <Readiness view={view} t={t} />
      {view.ready.text && chat !== undefined ? (
        <p className="nv-note is-ok">{t(`对话里的总编和未单独设置的角色，现在都用 DSH 的对话模型「${chat}」，可以直接开始。下面是可选的增强：插图、配音、检索。`, `The showrunner in the chat and every role without a model of its own currently use DSH's chat model "${chat}", so you can start right away. What follows is optional: pictures, speech, search.`)}</p>
      ) : !view.ready.text ? (
        <p className="nv-note is-warn">{t('还没有可用的文字模型。总编、写手和班底都用 DSH 的模型：请先在 DSH 的“设置 → 模型”里接入一个。下面配的是插图、配音和检索。', 'No text model yet. The showrunner, the writer and the crew all run on DSH\'s models: connect one under DSH\'s Settings → Models first. What is set up below is pictures, speech and search.')}</p>
      ) : null}
      <QuickSetup view={view} />
      <div className="nv-form-actions nv-setup-foot">
        <Button variant="ghost" icon="settings" onClick={() => { controller.setView('settings') }}>{t('逐项手动设置', 'Set each slot by hand')}</Button>
        <span className="nv-spacer" />
        <Button variant={view.ready.text ? 'primary' : 'outline'} busy={busy} onClick={leave}>{view.setupNeeded ? t('稍后再说', 'Later') : t('好了，开始', 'Done, let\'s start')}</Button>
      </div>
      <Signature version={view.version} />
    </div>
  )
}

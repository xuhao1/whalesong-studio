// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Getting the Studio ready in one step: paste one key, pick what it should
 * power, done. The same cards open the first-run guide and sit at the top of
 * the settings, where every slot can then be tuned by hand. What a key sets up
 * here is what is the Studio's own to configure — pictures, speech, search.
 * Text models are DSH's: every role runs on one of them.
 *
 * A ChatGPT subscription is the exception that sets up text too: DSH can sign
 * in to ChatGPT itself, but none of its pages starts that sign-in. Its card
 * does — DSH's own sign-in, which the Studio only shows — then adds the route
 * to DSH and gives the roles its models (see host/chatgpt.ts).
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ChatGPTApplied, ChatGPTAttempt, EndpointCheck, SettingsView as SettingsData } from '../../shared/rpc'
import { recommended } from '../../shared/recommended'
import { hostOf, originOf, PROJECT_AUTHOR, PROJECT_HOMEPAGE, recommendedSetup, SERVICES, type ServiceId, type SetupPart } from '../../shared/services'
import { Icon, type IconName } from '../icons'
import { Button, Chip, cx, Field, Select, Spinner, TextInput, useAction, useConfirm, useSnapshot, useStudio, useT, type Translate, plainEnter } from '../ui'

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
            <li><Icon name="image" size={13} />{t('插图：', 'Images: ')}{modelName(service, 'image')}</li>
            <li><Icon name="mic" size={13} />{t('配音：', 'Speech: ')}{modelName(service, 'tts')}</li>
            <li><Icon name="search" size={13} />{t('检索：', 'Retrieval: ')}{setup.embedding.model}</li>
          </>
        ) : null}
      </ul>
      <Field label="API key" hint={state?.configured === true ? t('留空就沿用现有的密钥；填写则更换。', 'Leave empty to keep the key in use; type one to replace it.') : t('只存在本机的 DSH 凭据库里。', 'Kept only in DSH\'s credential store on this machine.')}>
        <TextInput type="password" autoComplete="off" spellCheck={false} value={key} placeholder={state?.configured === true ? '••••••••••••' : t('粘贴 API key', 'Paste the API key')} onChange={(event) => { setKey(event.target.value) }} onKeyDown={(event) => { if (plainEnter(event) && canApply) apply() }} />
      </Field>
      <div className="nv-setup-parts">
        {PARTS.map(item => (
          <label key={item.part} className="nv-check nv-check-inline">
            <input type="checkbox" checked={parts.includes(item.part)} onChange={() => { toggle(item.part) }} />
            <span>{t(...item.label)}</span>
          </label>
        ))}
      </div>
      {!hasChatModel ? <p className="nv-muted nv-small">{t('文字模型在 DSH 的“设置 → 模型”里接入。', 'The text model is connected under DSH Settings → Models.')}</p> : null}
      {advanced ? (
        <Field label={t('接口地址', 'Service address')} hint={service === 'bailian' ? t('默认即可；有专属域名可以填。', 'The default will do; a dedicated domain can be entered.') : t('经代理或镜像访问时填写。', 'Only when going through a proxy or a mirror.')}>
          <TextInput value={origin} placeholder={info.origin} spellCheck={false} onChange={(event) => { setOrigin(event.target.value) }} />
        </Field>
      ) : null}
      {check !== undefined ? (
        <p className={cx('nv-note', check.ok ? 'is-ok' : 'is-warn')}>
          {check.ok ? t(`密钥可用${check.models !== undefined ? `，可选模型 ${check.models} 个` : ''}，已按推荐配置。`, `The key works${check.models !== undefined ? `, ${check.models} models on offer` : ''}; set up as recommended.`) : checkMessage(check, t)}
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
      {name}{t('：', ': ')}{!installed ? t('未安装', 'not installed') : signedIn ? t('已登录', 'signed in') : <>{t('已安装，未登录', 'installed, not signed in')} — {how}</>}
    </li>
  )
  return (
    <section className="nv-card nv-setup-card">
      <header className="nv-setup-card-head">
        <h3>{t('ChatGPT 订阅（Codex）', 'ChatGPT subscription (Codex)')}</h3>
        {active ? <Chip tone="green">{t('正在用于插图', 'Drawing images')}</Chip> : null}
      </header>
      <p className="nv-muted">{t('用订阅自带的 GPT Image 画图，沿用 Codex 已有的登录。', 'Pictures by the subscription\'s GPT Image, on the sign-in Codex already has.')}</p>
      <ul className="nv-setup-what">
        {line(codex.connect, codex.connectSignedIn, 'Codex Connect', t('在 DSH 设置 → 模型 → Openai-Codex 里授权', 'authorize under DSH Settings → Models → Openai-Codex'))}
        {line(codex.cli, codex.cliSignedIn, 'Codex CLI', <code>codex login</code>)}
      </ul>
      <p className="nv-muted nv-small">{t('订阅只能画图；配音和检索用上面的服务。', 'The subscription only draws; voices and search use the services above.')}</p>
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

/** What the one-click did, said in a line; `name` gives a model as the route names it. */
function appliedLine(applied: ChatGPTApplied, t: Translate, name: (id: string) => string): string {
  const parts = [
    applied.writer !== undefined ? t(`写手 ${name(applied.writer)}`, `the writer on ${name(applied.writer)}`) : undefined,
    applied.crew !== undefined ? t(`班底 ${name(applied.crew)}`, `the crew on ${name(applied.crew)}`) : undefined,
    applied.conversation ? t('DSH 的新对话也用写手的模型', 'new DSH conversations on the writer\'s model') : undefined,
    applied.images ? t('插图用订阅的 GPT Image', 'pictures by the subscription\'s GPT Image') : undefined,
  ].filter((part): part is string => part !== undefined)
  return t(`已配置：${parts.join('，')}。`, `Set up: ${parts.join(', ')}.`)
}

/** A reason the Host gave, in the reader's language where it is one of the known ones. */
function chatgptMessage(message: string | undefined, t: Translate): string {
  const text = message ?? ''
  if (/not signed in/i.test(text) && /Codex Connect/i.test(text)) return t('Codex Connect 插件管着 ChatGPT，但还没有授权：请在 DSH 的“设置 → 模型 → Openai-Codex”里授权，再回来点一键配置。', 'Codex Connect serves ChatGPT here, but has not been authorized: authorize under DSH Settings → Models → Openai-Codex, then come back to set up.')
  if (/not signed in/i.test(text)) return t('还没有登录 ChatGPT。', 'Not signed in to ChatGPT yet.')
  if (/no way to the subscription/i.test(text)) return t('插图没有改：现在没有能画图的 ChatGPT 通道。', 'Pictures were left as they were: no way to the subscription\'s GPT Image is signed in.')
  if (/conversations could not be moved/i.test(text)) return t(`DSH 的对话模型没有改：${text.replace(/^.*?: /, '')}`, text)
  return text.length > 0 ? text : t('没有成功。', 'It did not work.')
}

/**
 * The one-click for a ChatGPT Plus or Pro plan: sign in once, through DSH's own
 * sign-in, and the writer, the crew, DSH's conversations and the pictures run
 * on it. Each part can be chosen before the click.
 */
function ChatGPTCard({ view, t, onDone }: { view: SettingsData; t: Translate; onDone?: (() => void) | undefined }) {
  const { controller } = useStudio()
  const chat = view.chatgpt!
  const { codex } = view
  const [writer, setWriter] = useState<string | undefined>()
  const [crew, setCrew] = useState<string | undefined>()
  // DSH's conversations move by default on a first setup — a fresh DSH names DeepSeek as its default with no key behind
  // it — or where they have no model at all; someone who has set things up keeps theirs unless they tick the box.
  const usableDefault = view.defaultRoute !== undefined && view.providers.some(provider => provider.id === view.defaultRoute!.provider)
  const [conversation, setConversation] = useState(view.setupNeeded || !usableDefault || chat.using.conversation)
  const [images, setImages] = useState(true)
  const [attempt, setAttempt] = useState<ChatGPTAttempt | undefined>(chat.attempt?.state === 'running' ? chat.attempt : undefined)
  const [code, setCode] = useState('')
  // What happened, kept as what the Host said: a model's name is looked up when it is shown, once the route lists it.
  const [outcome, setOutcome] = useState<{ ok: boolean; text?: string; applied?: ChatGPTApplied } | undefined>()
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const models = chat.models.length > 0 ? chat.models : [chat.picks.writer, chat.picks.crew].filter((id, index, all): id is string => id !== undefined && all.indexOf(id) === index).map(id => ({ id, name: id }))
  const writerModel = writer ?? chat.picks.writer
  const crewModel = crew ?? chat.picks.crew
  const choice = { ...(writerModel !== undefined ? { writer: writerModel } : {}), ...(crewModel !== undefined ? { crew: crewModel } : {}), conversation, images }
  // Pictures come from the same sign-in once it is there, or from a way that is signed in already.
  const imagesPossible = chat.canSignIn || codex.dshSignedIn === true || (codex.connect && codex.connectSignedIn) || (codex.cli && codex.cliSignedIn)
  const done = (applied: ChatGPTApplied): void => {
    if (!applied.check.ok) {
      setOutcome({ ok: false, text: chatgptMessage(applied.check.message, t) })
      return
    }
    setOutcome({ ok: true, applied })
    controller.toast('success', t('ChatGPT 已接上', 'ChatGPT is connected'))
    onDone?.()
  }
  const running = attempt?.state === 'running' || (attempt?.state === 'authorized' && attempt.applied === undefined)

  // Follow the sign-in until it is over and the one-click has run: the Host answers each change, or after a while of none.
  const following = running ? attempt!.id : undefined
  useEffect(() => {
    if (following === undefined) return
    let live = true
    void (async () => {
      let seen: ChatGPTAttempt | undefined = attempt
      while (live && seen !== undefined && (seen.state === 'running' || (seen.state === 'authorized' && seen.applied === undefined))) {
        let next: ChatGPTAttempt | null
        try {
          next = await controller.chatgptAttempt(seen.id, seen.revision)
        } catch {
          // An older Host, or one being replaced: try again in a moment.
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        }
        if (!live) return
        if (next === null || next.id !== seen.id) {
          setAttempt(undefined)
          return
        }
        seen = next
        setAttempt(next)
      }
      if (!live || seen === undefined) return
      if (seen.state === 'failed') setOutcome({ ok: false, text: t(`登录没有完成：${seen.error ?? ''}`, `The sign-in did not finish: ${seen.error ?? ''}`) })
      if (seen.state === 'authorized') {
        await controller.loadSettings().catch(() => {})
        if (seen.applied !== undefined) done(seen.applied)
      }
    })()
    return () => { live = false }
  }, [following])

  const signIn = (device = false): Promise<unknown> => run(async () => {
    setOutcome(undefined)
    setAttempt(await controller.chatgptSignIn(choice, device))
  })
  const apply = (): Promise<unknown> => run(async () => {
    setOutcome(undefined)
    done(await controller.chatgptApply(choice))
  })
  const answer = (): Promise<unknown> => run(async () => {
    if (attempt === undefined || code.trim().length === 0) return
    setAttempt(await controller.chatgptAnswer(attempt.id, code.trim()))
    setCode('')
  })
  const cancel = (): Promise<unknown> => run(async () => {
    if (attempt === undefined) return
    const next = await controller.chatgptCancel(attempt.id)
    setAttempt(next ?? undefined)
  })
  const copy = (url: string): void => {
    void navigator.clipboard.writeText(url).then(() => { controller.toast('success', t('链接已复制', 'Link copied')) }, () => { controller.toast('error', t('复制不了，请手动选中链接', 'Could not copy; select the link by hand')) })
  }

  const status = chat.route === 'connect'
    ? (chat.signedIn ? t('Codex Connect · 已登录', 'Codex Connect · signed in') : t('Codex Connect · 未授权', 'Codex Connect · not authorized'))
    : chat.signedIn ? t('已登录', 'Signed in') : undefined
  const inUse = chat.using.writer || chat.using.crew
  return (
    <section className="nv-card nv-setup-card nv-setup-chatgpt">
      <header className="nv-setup-card-head">
        <h3>{t('ChatGPT 订阅（Plus / Pro）', 'ChatGPT subscription (Plus / Pro)')}</h3>
        {inUse ? <Chip tone="green">{t('正在用', 'In use')}</Chip> : status !== undefined ? <Chip tone={chat.signedIn ? 'green' : 'neutral'}>{status}</Chip> : null}
      </header>
      <p className="nv-muted">{t('用 ChatGPT 账号登录一次，不用 key：写作用 GPT 模型，插图用订阅自带的 GPT Image。', 'Sign in with your ChatGPT account once, no key: GPT models write, and the subscription\'s GPT Image draws.')}</p>
      <div className="nv-form-grid">
        <Field label={t('写手', 'Writer')}>
          <Select<string> value={writerModel ?? ''} options={models.map(model => ({ value: model.id, label: model.name }))} onChange={setWriter} disabled={running} />
        </Field>
        <Field label={t('班底（场记、策划、导演、后期）', 'Crew (continuity, planner, director, post)')}>
          <Select<string> value={crewModel ?? ''} options={models.map(model => ({ value: model.id, label: model.name }))} onChange={setCrew} disabled={running} />
        </Field>
      </div>
      <div className="nv-setup-parts">
        <label className="nv-check nv-check-inline">
          <input type="checkbox" checked={conversation} disabled={running} onChange={(event) => { setConversation(event.target.checked) }} />
          <span>{t('DSH 的对话（总编）也用写手的模型', 'DSH conversations (the showrunner) on the writer\'s model too')}</span>
        </label>
        <label className="nv-check nv-check-inline">
          <input type="checkbox" checked={images && imagesPossible} disabled={running || !imagesPossible} onChange={(event) => { setImages(event.target.checked) }} />
          <span>{t('插图用 GPT Image', 'Pictures by GPT Image')}</span>
        </label>
      </div>
      <p className="nv-muted nv-small">{t('订阅里没有配音和检索：这两项用旁边的服务配。', 'The subscription has no voices and no search: set those up with a service beside it.')}</p>
      {attempt !== undefined && running ? (
        <div className="nv-chatgpt-signin">
          {attempt.state === 'authorized' ? (
            <p className="nv-note is-ok"><Spinner size={12} /> {t('已登录，正在配置……', 'Signed in; setting up…')}</p>
          ) : (
            <>
              <ol className="nv-chatgpt-steps">
                <li>
                  {attempt.code !== undefined ? t('打开下面的页面，输入这个码，登录并同意：', 'Open the page below, enter this code, sign in and approve: ') : t('打开 ChatGPT 的登录页，登录并点同意。', 'Open ChatGPT\'s sign-in page, sign in and approve.')}
                  {attempt.code !== undefined ? <code className="nv-chatgpt-code">{attempt.code}</code> : null}
                  <div className="nv-keyrow">
                    {attempt.url !== undefined ? (
                      <>
                        <a className="nv-btn nv-btn-primary" href={attempt.url} target="_blank" rel="noreferrer"><Icon name="link" size={13} />{t('打开登录页', 'Open the sign-in page')}</a>
                        <Button variant="ghost" size="sm" icon="copy" onClick={() => { copy(attempt.url!) }}>{t('复制链接', 'Copy link')}</Button>
                      </>
                    ) : <span className="nv-muted nv-small"><Spinner size={12} /> {t('正在准备登录页……', 'Getting the sign-in page ready…')}</span>}
                  </div>
                </li>
                <li>{attempt.code !== undefined ? t('登录好了，这里会自动接上。', 'Once you are signed in, this goes on by itself.') : t('登录好了浏览器会跳回本机，这里自动接上，不用再点。', 'Once you are signed in, the browser comes back to this computer and this goes on by itself.')}</li>
              </ol>
              {attempt.ask !== undefined ? (
                <Field label={t('浏览器没有跳回来？', 'The browser did not come back?')} hint={t('比如 DSH 不在你正用的这台电脑上：浏览器会停在一个打不开的 localhost 页面，把地址栏里的整串网址贴到这里。', 'For instance when DSH runs on another computer: the browser stops on a localhost page that does not open. Paste the whole address from its address bar here.')}>
                  <div className="nv-keyrow">
                    <TextInput value={code} spellCheck={false} placeholder={attempt.ask.placeholder ?? 'http://localhost:1455/auth/callback?code=…'} onChange={(event) => { setCode(event.target.value) }} onKeyDown={(event) => { if (plainEnter(event)) void answer() }} />
                    <Button size="sm" disabled={code.trim().length === 0} onClick={answer}>{t('提交', 'Submit')}</Button>
                  </div>
                </Field>
              ) : null}
            </>
          )}
          <div className="nv-form-actions">
            {attempt.state === 'running' && attempt.code === undefined ? <Button variant="ghost" size="sm" onClick={() => { void cancel().then(() => signIn(true)) }}>{t('改用设备码登录', 'Use a device code instead')}</Button> : null}
            <span className="nv-spacer" />
            {attempt.state === 'running' ? <Button variant="ghost" onClick={cancel}>{t('取消', 'Cancel')}</Button> : null}
          </div>
        </div>
      ) : null}
      {outcome !== undefined ? (
        <p className={cx('nv-note', outcome.ok ? 'is-ok' : 'is-warn')}>
          {outcome.applied !== undefined
            ? [appliedLine(outcome.applied, t, id => chat.models.find(model => model.id === id)?.name ?? id), ...(outcome.applied.notes ?? []).map(note => chatgptMessage(note, t))].join(' ')
            : outcome.text}
        </p>
      ) : null}
      {!running ? (
        <div className="nv-form-actions">
          {chat.signedIn && chat.canSignIn ? (
            <>
              <Button variant="ghost" size="sm" busy={busy} onClick={() => signIn()}>{t('换个账号登录', 'Sign in again')}</Button>
              <Button variant="ghost" size="sm" busy={busy} onClick={() => {
                confirm.ask(t('退出 DSH 里的这个 ChatGPT 登录？写手、班底和插图的设置不动，但用到它们时会要求重新登录。', 'Sign DSH out of this ChatGPT account? The writer, the crew and the pictures stay set to it, and ask for a sign-in again when used.'), () => {
                  void run(async () => {
                    await controller.chatgptSignOut()
                    setOutcome({ ok: true, text: t('已退出登录。', 'Signed out.') })
                  })
                })
              }}>{t('退出登录', 'Sign out')}</Button>
            </>
          ) : null}
          <span className="nv-spacer" />
          {chat.signedIn ? (
            <Button variant="primary" busy={busy} disabled={writerModel === undefined || crewModel === undefined} onClick={apply}>{t('一键配置', 'Set up')}</Button>
          ) : chat.canSignIn ? (
            <Button variant="primary" busy={busy} icon="unlock" onClick={() => signIn()}>{t('用 ChatGPT 登录并配置', 'Sign in with ChatGPT and set up')}</Button>
          ) : chat.route === 'connect' ? (
            <span className="nv-muted nv-small">{t('Codex Connect 插件管着 ChatGPT：先在 DSH 的“设置 → 模型 → Openai-Codex”里授权。', 'Codex Connect serves ChatGPT here: authorize under DSH Settings → Models → Openai-Codex first.')}</span>
          ) : (codex.cli && codex.cliSignedIn) ? (
            // No sign-in for the text here, but the Codex CLI on this machine can still draw.
            <Button variant="outline" busy={busy} onClick={() => run(async () => {
              const result = await controller.applySetup({ service: 'codex', parts: ['image'] })
              setOutcome(result.ok ? { ok: true, text: t('插图将使用 ChatGPT 订阅（经 Codex CLI）。这个 DSH 不能自己登录 ChatGPT，写作的模型请在 DSH 的“设置 → 模型”里接。', 'Pictures will use the ChatGPT subscription (through the Codex CLI). This DSH cannot sign in to ChatGPT itself: connect the writing models under DSH Settings → Models.') } : { ok: false, text: checkMessage(result, t) })
              if (result.ok) onDone?.()
            })}>{t('只用它画插图', 'Use it for pictures only')}</Button>
          ) : (
            <span className="nv-muted nv-small">{t('这个 DSH 不能自己登录 ChatGPT：请升级 DSH，或装 Codex Connect 插件。', 'This DSH cannot sign in to ChatGPT by itself: update DSH, or install the Codex Connect plugin.')}</span>
          )}
        </div>
      ) : null}
      {confirm.element}
    </section>
  )
}

/** The one-click cards. `services` narrows them; by default the two recommended services and the subscription. */
export function QuickSetup({ view, onDone, services = ['bailian', 'openrouter'] }: { view: SettingsData; onDone?: () => void; services?: ('bailian' | 'openrouter' | 'openai')[] }) {
  const t = useT()
  return (
    <div className="nv-setup-grid">
      {/* A Host from before the one-click for ChatGPT knows only its pictures. */}
      {view.chatgpt !== undefined ? <ChatGPTCard view={view} t={t} onDone={onDone} /> : null}
      {services.map(service => <ServiceCard key={service} service={service} view={view} t={t} onDone={onDone} />)}
      {view.chatgpt === undefined ? <CodexCard view={view} t={t} onDone={onDone} /> : null}
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
      {t('鲸歌工坊', 'Whalesong Studio')}{version !== undefined ? ` · v${version}` : ''} · {t('作者', 'by')} {PROJECT_AUTHOR} · <a className="nv-link" href={PROJECT_HOMEPAGE} target="_blank" rel="noreferrer">{PROJECT_HOMEPAGE.replace(/^https?:\/\//, '')}</a> · LGPL-3.0-or-later
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
        <p>{view.chatgpt?.canSignIn === true || view.chatgpt?.signedIn === true
          ? t('有 ChatGPT Plus / Pro 的话，第一张卡片登录一次，写作和插图就都接上了。别的文字模型来自 DSH（设置 → 模型）；画图、配音和检索在这里配：贴一个 key 就能全部配好。', 'With ChatGPT Plus or Pro, sign in once on the first card and writing and pictures are both connected. Other text models come from DSH (Settings → Models); pictures, voices and search are set up here: one key covers all three.')
          : t('文字模型来自 DSH（设置 → 模型）。这里配画图、配音和检索：贴一个 key 就能全部配好。', 'Text models come from DSH (Settings → Models). Pictures, voices and search are set up here: one key covers all three.')}</p>
      </header>
      <Readiness view={view} t={t} />
      {view.ready.text && chat !== undefined ? (
        <p className="nv-note is-ok">{t(`文字模型用的是 DSH 的「${chat}」，可以直接开始。`, `The text model is DSH's "${chat}": you can start right away.`)}</p>
      ) : !view.ready.text ? (
        <p className="nv-note is-warn">{view.chatgpt?.canSignIn === true
          ? t('还没有文字模型：用下面的 ChatGPT 一键登录，或在 DSH 的“设置 → 模型”里接入一个。', 'No text model yet: sign in with ChatGPT below, or connect one under DSH Settings → Models.')
          : t('还没有文字模型：请先在 DSH 的“设置 → 模型”里接入一个。', 'No text model yet: connect one under DSH Settings → Models first.')}</p>
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

// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The model of a service, chosen from what the service itself lists.
 *
 * One control wherever a model of an endpoint is picked — in the settings, and
 * where services are picked to be compared: anything may be typed, the list
 * offers the recommended ones and everything the endpoint says it serves, and
 * a button reads that list again.
 */
import { useEffect, useRef, useState } from 'react'
import type { EndpointModel, KeyState, ModelKind, SettingsView as SettingsData } from '../shared/rpc'
import type { ComfyCatalog, ImageSettings, TtsProviderKind, TtsSettings } from '../shared/types'
import { imageSourceOf, localImages } from '../shared/images'
import { providerDefault } from '../shared/recommended'
import { bailianRealtime, compatibleBase, hostOf, originOf, recommendedSetup, serviceOf, SERVICES, speechProtocol } from '../shared/services'
import { messageOf } from './api'
import { Button, Combo, Field, TextInput, useLoad, useStudio, type ComboOption, type Translate } from './ui'

/** Keys typed on a page and not saved yet, by host. */
export type TypedKeys = Record<string, { url: string; value: string }>

/** The keys a settings page holds: what is saved (`view`) and what was typed since. */
export interface KeyBag {
  typed: TypedKeys
  set(url: string, value: string): void
  view: SettingsData
}

/** Whatever the page knows about the key of an endpoint, asking the Host for hosts it has not seen. */
export function useKeyState(keys: KeyBag | undefined, endpoint: string | undefined, ref: string | undefined): KeyState | undefined {
  const { controller } = useStudio()
  const host = hostOf(endpoint)
  const known = host !== undefined ? keys?.view.keys[ref !== undefined && ref.length > 0 ? `${host}#${ref}` : host] : undefined
  const asked = useLoad(async (signal) => {
    if (host === undefined || endpoint === undefined || known !== undefined) return undefined
    const { states } = await controller.api.call('key.state', { endpoints: [{ url: endpoint, ...(ref !== undefined && ref.length > 0 ? { ref } : {}) }] }, signal)
    return states[0]
  }, [host, ref, known !== undefined])
  return known ?? asked.data
}


/** Model lists already fetched on this page, so sibling fields on one endpoint ask once. */
const discovered = new Map<string, EndpointModel[]>()

/**
 * A model id: anything may be typed, and the list offers the recommended ones
 * plus everything the endpoint itself says it serves — all of it, whatever is
 * already in the field.
 */
export function ModelField({ label, hint, endpoint, kind, value, onChange, suggestions, refName, keys, placeholder, onModels, onPickModel, describe, eager, bare, disabled, t }: {
  /** What the field is called; not shown where it is `bare`. */
  label?: string
  hint?: string | undefined
  endpoint: string | undefined
  kind: ModelKind
  value: string
  onChange: (model: string) => void
  suggestions: string[]
  refName?: string | undefined
  /** The keys typed on the page and not saved yet, where the field stands on such a page; without it the key saved for the endpoint is the one asked with. */
  keys?: KeyBag | undefined
  placeholder?: string | undefined
  onModels?: (models: EndpointModel[]) => void
  /** A model was chosen from the list; the endpoint's own record of it comes along when there is one. */
  onPickModel?: (model: EndpointModel) => void
  /** A few words about a listed model, shown beside it. */
  describe?: (model: EndpointModel) => string | undefined
  /** Ask the endpoint for its list without waiting for the list to be opened: what it says of a model is needed on the page. */
  eager?: boolean | undefined
  /** Without a label around it: for a row that says what it is by itself. */
  bare?: boolean
  disabled?: boolean
  t: Translate
}) {
  const { controller } = useStudio()
  const host = hostOf(endpoint)
  const cacheKey = `${host ?? ''}|${kind}`
  const [found, setFound] = useState<EndpointModel[]>(() => discovered.get(cacheKey) ?? [])
  const [busy, setBusy] = useState(false)
  const [signal, setSignal] = useState(0)
  const typed = host !== undefined ? keys?.typed[host]?.value : undefined
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
          ? t(`这个接口列出了 ${models.length} 个模型`, `The endpoint lists ${models.length} model(s)`)
          : t(`这个接口有 ${models.length} 个这类模型，${usable} 个可以直接用`, `The endpoint has ${models.length} such model(s), ${usable} usable as they are`))
        // Show them: a count nobody can act on is no answer.
        setSignal(count => count + 1)
      }
    } catch (error) {
      if (!quiet) controller.toast('error', messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  // Asked at once only where a key is at hand already — a list refused for want of one says nothing — and without
  // spending the list's own first look, which still asks when it is opened.
  const keyed = useKeyState(keys, endpoint, refName)?.configured === true
  const eagerly = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (eager !== true || !keyed || host === undefined || eagerly.current === cacheKey || (discovered.get(cacheKey) ?? []).length > 0) return
    eagerly.current = cacheKey
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eager, keyed, cacheKey, host])
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
        group: model.unsupported === true ? t('这个接口还有这些（暂时用不了）', 'Also served here (not usable yet)') : model.unsure === true ? t('这个接口还列了这些（没说是哪一类）', 'Also listed here (it does not say of what kind)') : t('这个接口列出的模型', 'Listed by this endpoint'),
        ...(model.name !== undefined ? { label: model.name } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(model.unsupported === true ? { disabled: true } : {}),
      }
    }),
  ]
  const field = (
      <span className="nv-keyrow">
        <Combo
          value={value}
          options={options}
          disabled={disabled}
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
        <Button size="sm" variant="ghost" icon="refresh" busy={busy} disabled={host === undefined || disabled === true} title={t('读取这个接口提供的全部模型', 'List every model this endpoint serves')} onClick={() => { void load(false) }} />
      </span>
  )
  return bare === true ? field : <Field label={label ?? ''} hint={hint}>{field}</Field>
}


/** Where an image service is reached: the address its models are listed at. */
export function imageEndpoint(value: Pick<ImageSettings, 'provider' | 'baseURL'>): string {
  return value.provider === 'dashscope' ? value.baseURL ?? SERVICES.bailian.origin : value.provider === 'openrouter' ? value.baseURL ?? compatibleBase('openrouter') : value.baseURL ?? compatibleBase('openai')
}

/** A few words about an image model, from what its endpoint says of it: how large it draws, in how many steps, what it reads and takes. */
export function imageModelNote(model: EndpointModel, t: Translate): string | undefined {
  if (model.image === undefined) return undefined
  const { maxWidth, maxHeight, steps, promptTokens, references } = model.image
  return t(
    `最大 ${maxWidth}×${maxHeight}${steps !== undefined ? ` · ${steps} 步` : ''}${promptTokens !== undefined ? ` · 读 ${promptTokens} 个 token` : ''}${references === undefined ? '' : references > 0 ? ` · 参考图 ${references} 张` : ' · 不收参考图'}`,
    `up to ${maxWidth}×${maxHeight}${steps !== undefined ? ` · ${steps} steps` : ''}${promptTokens !== undefined ? ` · reads ${promptTokens} tokens` : ''}${references === undefined ? '' : references > 0 ? ` · ${references} reference picture${references === 1 ? '' : 's'}` : ' · no reference pictures'}`,
  )
}

/**
 * The model of an image service: from the endpoint's own list where the service has one (with what the endpoint says
 * of each), from the server's catalog for ComfyUI, typed for a pipeline on this machine. The same in the settings and
 * in a comparison.
 */
export function ImageModelField({ value, onChange, keys, label, hint, bare, disabled, placeholder, onModels, t }: {
  value: Pick<ImageSettings, 'provider' | 'baseURL' | 'model' | 'apiKeyRef' | 'local'>
  onChange: (model: string) => void
  keys?: KeyBag | undefined
  label?: string
  hint?: string | undefined
  bare?: boolean
  disabled?: boolean
  placeholder?: string | undefined
  onModels?: (models: EndpointModel[]) => void
  t: Translate
}) {
  const { controller } = useStudio()
  const source = imageSourceOf(value)
  const comfy = value.provider === 'comfyui'
  // A ComfyUI server says what it has through its own catalog, asked when the list is first wanted.
  const [wanted, setWanted] = useState(0)
  const catalog = useLoad<ComfyCatalog | undefined>(async signal => (comfy && wanted > 0 ? await controller.api.call('image.comfy', value.baseURL !== undefined && value.baseURL.trim().length > 0 ? { baseURL: value.baseURL.trim() } : {}, signal) : undefined), [comfy, value.baseURL, wanted])
  if (value.provider === 'codex') return bare === true ? <TextInput disabled value="" placeholder="gpt-image" /> : <Field label={label ?? t('模型', 'Model')} hint={hint}><TextInput disabled value="" placeholder="gpt-image" /></Field>
  if (comfy || value.provider === 'diffusers') {
    const options: ComboOption[] = comfy ? [
      ...(catalog.data?.checkpoints ?? []).map(name => ({ value: name, group: 'checkpoint' })),
      ...(catalog.data?.diffusion ?? []).map(name => ({ value: name, group: t('扩散模型', 'diffusion model') })),
    ] : []
    const field = (
      <span className="nv-keyrow">
        <Combo value={value.model ?? ''} options={options} disabled={disabled} placeholder={placeholder ?? (comfy ? t('工作流里写的那个', 'the one the workflow names') : 'stabilityai/stable-diffusion-xl-base-1.0')} empty={comfy ? (catalog.loading ? t('正在读取…', 'Loading…') : catalog.error ?? t('服务器没有列出模型，直接填写', 'The server lists no model; type one')) : t('直接填写模型名或路径', 'Type the model id or path')} onChange={onChange} onOpen={() => { if (comfy && wanted === 0) setWanted(1) }} />
        {comfy ? <Button size="sm" variant="ghost" icon="refresh" busy={catalog.loading} disabled={disabled === true} title={t('读取这台服务器上的模型', 'List the models on this server')} onClick={() => { setWanted(count => count + 1) }} /> : null}
      </span>
    )
    return bare === true ? field : <Field label={label ?? t('模型', 'Model')} hint={hint}>{field}</Field>
  }
  const suggestions = source !== 'none' && source !== 'codex' && source !== 'comfyui' && source !== 'diffusers' ? recommendedSetup(source)?.suggestions.image ?? [] : []
  return (
    <ModelField label={label ?? t('模型', 'Model')} hint={hint} endpoint={imageEndpoint(value)} kind="image" value={value.model ?? ''} suggestions={suggestions} refName={value.apiKeyRef} keys={keys} t={t}
      // A server of the author's own is asked at once: what it says of a model is wanted before the list is opened.
      eager={localImages(value as ImageSettings)} bare={bare === true} disabled={disabled === true} placeholder={placeholder}
      {...(onModels !== undefined ? { onModels } : {})}
      describe={model => imageModelNote(model, t)}
      onChange={onChange} />
  )
}

/** Where a speech setup is reached: the address its models are listed at. */
export function speechEndpoint(value: Pick<TtsSettings, 'provider' | 'baseURL'>): string {
  return value.baseURL ?? (value.provider === 'openrouter' ? compatibleBase('openrouter') : value.provider === 'openai' ? compatibleBase('openai') : value.provider === 'qwen-realtime' ? bailianRealtime() : SERVICES.bailian.origin)
}

/** The models worth offering beside a speech setup's field: what the recommendations list for its kind of endpoint. */
export function speechSuggestions(provider: TtsProviderKind): string[] {
  if (provider === 'none') return []
  const offered = providerDefault('tts', provider)
  return offered.suggestions ?? (provider === 'openrouter' ? recommendedSetup('openrouter')?.suggestions.tts : undefined) ?? (offered.model.length > 0 ? [offered.model] : [])
}

/**
 * A speech setup turned to another model of the same account. The model decides the protocol it is spoken to in
 * (one Bailian key reaches audio generation, Qwen TTS and the realtime models alike); the account — its domain and
 * its key — stays. Voices named for the protocol left are not voices of the one come to: they are dropped.
 */
export function withSpeechModel<T extends Partial<TtsSettings>>(value: T, model: { id: string; via?: TtsProviderKind | undefined }): T {
  const endpoint = speechEndpoint({ provider: value.provider ?? 'none', ...(value.baseURL !== undefined ? { baseURL: value.baseURL } : {}) })
  const via = model.via ?? speechProtocol(serviceOf(endpoint), model.id)
  if (via === undefined || via === 'none' || via === value.provider) return { ...value, model: model.id }
  const origin = value.baseURL !== undefined && serviceOf(value.baseURL) === 'bailian' && originOf(value.baseURL) !== SERVICES.bailian.origin ? originOf(value.baseURL) : undefined
  const { narratorVoice: _narrator, defaultVoices: _voices, designedVoiceModel: _designed, baseURL: _base, ...rest } = value
  const bailian = via === 'qwen-audiogen' || via === 'qwen-realtime' || via === 'dashscope'
  return { ...rest, provider: via, model: model.id, ...(bailian ? { baseURL: via === 'qwen-realtime' ? bailianRealtime(origin) : origin ?? SERVICES.bailian.origin } : value.baseURL !== undefined ? { baseURL: value.baseURL } : {}) } as T
}
